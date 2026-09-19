"use strict";

// Quoting / RFQ pre-booking stage — every competitor platform researched (CargoWise, Magaya,
// Descartes, Flexport, Freightos) treats a quote as a distinct object that precedes and converts
// into a booking; CargoDesk previously had none (POST /api/shipments created a live numbered
// shipment directly, no prior quote entity).
//
// Lifecycle: Draft (freely editable) -> Sent (locked, awaiting the customer) -> Accepted |
// Declined | Expired -> Converted (Accepted only — creates the real shipment).
//
// Pricing reuses the existing contract-match/rate infrastructure (GET /api/contracts/match,
// unchanged) as a reference for what to quote — quote_lines then carry the actual SELL-side price
// being offered to the customer, independent of whatever the matched contract said, since a
// quoted price commonly includes a margin the contract rate alone doesn't show. On conversion,
// those lines become the new shipment's SELL cost lines (source 'quote'); the BUY side still
// comes from the real matched contract via the existing importContractRates path, unchanged.
const { applyColumnFilters, filterOptions, applySearch, applySort, paginate, blanksLast } = require("../lib/tableQuery");

module.exports = function quotesRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, isUniqueViolation, mapQuote, mapQuoteLine, mapShipment,
          logEvent, logEntityEvent, toUsd, SERVICE_CODE_MAP, importContractRates,
          resolveCarrierAgentCandidates, screenShipmentById, schemaReady, getCustomerRow,
          recomputeSpaceBadge, applyOfficeScopedAccessFilter } = ctx;

  // sales (User Management redesign, 2026-09-12) owns the quoting pipeline — deliberately not
  // added to shipments.js/shipment-ops.js/edi.js/etc.'s write guards, which stay booking-authority
  // only.
  const quoteWrite = requireRole(["admin", "operator", "occ_bk", "sales"]);

  // ─── Auto-expire ────────────────────────────────────────────────────────────
  // Mirrors routes/contracts.js's own expireStaleContracts exactly — a Sent quote whose
  // valid_until has passed without an Accept/Decline is stale and should stop looking actionable.
  // Runs once at startup (covers a quote that expired while the server was down) and then hourly.
  async function expireStaleQuotes() {
    const today = new Date().toISOString().slice(0, 10);
    const stale = await query("SELECT id, customer_name FROM quotes WHERE status='Sent' AND valid_until != '' AND valid_until < $1", [today]);
    if (stale.length === 0) return;
    const now = new Date().toISOString();
    for (const q of stale) {
      await query("UPDATE quotes SET status='Expired', expired_at=$1 WHERE id=$2", [now, q.id]);
      await logEntityEvent('quote', q.id, 'UPDATED', 'status', 'Sent', 'Expired',
        JSON.stringify({ customerName: q.customer_name, reason: 'valid_until passed' }));
    }
  }
  // This route file is required (and this call fires) synchronously at server startup, before
  // httpServer.listen()'s own schemaReadyPromise gate — the initial sweep must wait on schema
  // readiness itself, or it hits a real "relation quotes does not exist" on every fresh boot
  // (same ordering bug the AIS listener's initial tracked-legs load hit). The hourly interval is
  // left unguarded — 60 minutes comfortably outlasts schema creation either way.
  schemaReady.then(() => expireStaleQuotes()).catch(e => console.error("expireStaleQuotes failed:", e.message));
  const expireSweep = setInterval(() => expireStaleQuotes().catch(e => console.error("expireStaleQuotes failed:", e.message)), 60 * 60 * 1000);
  expireSweep.unref?.();

  // Carrier Line Agents — duplicated from routes/shipments.js's own maybeAssignLineAgents (small,
  // pure, self-contained) so a quote-converted shipment gets the exact same auto-assignment a
  // directly-created one would, without new cross-file ctx plumbing for a 10-line helper. A side
  // with 2+ candidates (only possible via the linked-ports fallback) is left unassigned rather
  // than guessing — same rule as the shipments.js copy, see its own comment for the full rationale.
  async function maybeAssignLineAgents(shipmentId, carrierCode, pol, pod, actorId = null) {
    for (const [port, role] of [[pol, "Line Agent (Export)"], [pod, "Line Agent (Import)"]]) {
      const candidates = await resolveCarrierAgentCandidates(carrierCode, port);
      if (candidates.length !== 1) continue;
      const match = candidates[0];
      try {
        await query(`INSERT INTO shipment_parties (id, shipment_id, role, customer_id, customer_name, created_at)
          VALUES ($1,$2,$3,$4,$5,$6)`,
          [`PTY-${uid()}`, shipmentId, role, match.agent_customer_id, match.agent_customer_name, new Date().toISOString()]);
        await logEvent(shipmentId, 'LINE_AGENT_AUTO_ASSIGNED', role, null, match.agent_customer_name,
          JSON.stringify({ carrierCode, port, matchedVia: match.matched_via || null }), actorId);
      } catch (e) { if (!isUniqueViolation(e)) throw e; }
    }
  }

  async function recomputeQuoteTotal(quoteId) {
    const [{ n: total }] = await query("SELECT COALESCE(SUM(amount_usd),0) AS n FROM quote_lines WHERE quote_id=$1", [quoteId]);
    await query("UPDATE quotes SET total_amount_usd=$1 WHERE id=$2", [total, quoteId]);
    return total;
  }

  // 2026-09-12 QA finding: quantity had no validation at all — `0` was silently coerced to `1`
  // via `|| 1` (the quote author's stated "0" was never actually saved, with no error), and a
  // negative value passed straight through unchanged (only `0`/NaN are falsy, `-3` is not) into
  // real negative SELL cost-line revenue once converted. Confirmed live: a line with
  // quantity:-3 produced a genuine -$3000 cost line on the converted shipment, while the
  // container-count derivation elsewhere still floored to exactly 1 physical container — money
  // and container count silently disagreeing with each other and with what was entered.
  function findInvalidLine(lines) {
    for (const l of lines) {
      const n = Number(l.quantity);
      if (!Number.isFinite(n) || n <= 0) return l;
    }
    return null;
  }

  async function insertLines(quoteId, lines) {
    let i = 0;
    for (const l of lines) {
      const quantity = Number(l.quantity);
      const rate = Number(l.rate) || 0;
      const currency = (l.currency || "USD").toUpperCase();
      const amountUsd = await toUsd(rate * quantity, currency);
      // Only meaningful on a reefer line, but not container-type-gated here — mirrors
      // ContainerForm's own POST/PUT, which likewise trusts whatever the frontend already
      // gated rather than re-deriving "is this a reefer line" server-side.
      const setTemperatureC = l.setTemperatureC !== undefined && l.setTemperatureC !== null && l.setTemperatureC !== ""
        ? Number(l.setTemperatureC) : null;
      await query(`INSERT INTO quote_lines
        (id, quote_id, service_code, description, container_type, quantity, unit, rate, currency, amount_usd, sort_order, set_temperature_c)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [`QTL-${uid()}`, quoteId, (l.serviceCode || "").toUpperCase(), l.description || "",
        l.containerType || "", quantity, l.unit || "per_container", rate, currency, amountUsd, i++, setTemperatureC]);
    }
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  // Paginated in JS, after the office/scope access filter, not in SQL — matching
  // routes/shipments.js's own GET /api/shipments precedent exactly, for the same reason: the
  // filter is header/JS-driven and can't safely run after a SQL LIMIT/OFFSET without risking a
  // wrong or short page (User Management redesign, 2026-09-12 — quotes had no scoping before this).
  // Column → the value the Quotes table shows and filters on. ONE definition feeds both the list
  // route's column filters and /filter-options, so a header checklist can never offer a value the
  // filter doesn't understand. `route` is the same "POL→POD" string the Route column renders.
  const QUOTE_COLUMNS = {
    id:         q => q.id,
    customer:   q => q.customerName,
    route:      q => (q.pol && q.pod ? `${q.pol}→${q.pod}` : ""),
    carrier:    q => q.carrierCode,
    validUntil: q => q.validUntil,
    status:     q => q.status,
  };
  const quoteSearchText = q =>
    [q.id, q.customerName, q.consigneeName, q.pol, q.pod, q.carrierCode, q.contractRef, q.notes].join(" ");
  // (blanksLast: a quote with no valid-until date or customer yet sorts last, not first — see lib/tableQuery.js)
  // The SQL already returns newest-first (ORDER BY created_at DESC), which is the default and
  // needs no entry here.
  const QUOTE_SORTERS = {
    oldest:     (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)),
    validUntil: blanksLast(q => q.validUntil),
    customer:   blanksLast(q => q.customerName),
    total:      (a, b) => (b.totalAmountUsd || 0) - (a.totalAmountUsd || 0),
  };

  const loadVisibleQuotes = async (req, where = "", params = []) => {
    const rows = await query(`SELECT * FROM quotes ${where} ORDER BY created_at DESC`, params);
    return applyOfficeScopedAccessFilter(rows.map(mapQuote), req.user, req);
  };

  // `status` used to be a single SQL equality and now goes through the shared column filter with
  // every other column (so ?status=Sent, still used by tests/quoting-rfq.test.js, behaves exactly
  // as before, and ?status=Draft&status=Sent works too). customerId stays in SQL — it isn't a
  // table column, it's the "quotes for this customer" scope other pages pass in.
  app.get("/api/quotes", async (req, res) => {
    const { customerId = "", search = "", sort = "" } = req.query;
    const clauses = [], params = [];
    if (String(customerId).trim()) { params.push(String(customerId).trim()); clauses.push(`customer_id=$${params.length}`); }
    const visible = await loadVisibleQuotes(req, clauses.length ? "WHERE " + clauses.join(" AND ") : "", params);
    let rows = applyColumnFilters(visible, req.query, QUOTE_COLUMNS);
    rows = applySearch(rows, search, quoteSearchText);
    rows = applySort(rows, sort, QUOTE_SORTERS);
    ok(res, paginate(rows, req.query));
  });

  // Checklist source for each column header's filter — MUST be registered before /api/quotes/:id
  // (Express matches in registration order; :id would swallow "filter-options" as an id). Built
  // from the caller's whole visible set, deliberately ignoring the list's own filters/paging.
  app.get("/api/quotes/filter-options", async (req, res) => {
    ok(res, filterOptions(await loadVisibleQuotes(req), QUOTE_COLUMNS));
  });

  // Upcoming/just-passed expiries for the Header notification bell — MUST be registered before
  // /api/quotes/:id (Express matches route registration order; :id would otherwise swallow the
  // literal "expiring" as an id). Copied from routes/contracts.js's own GET /api/contracts/expiring
  // almost verbatim — only Sent quotes are actionable/warnable (Draft/Accepted/Declined/Expired/
  // Converted have nothing pending), unlike contracts which check every Active/Expired row.
  app.get("/api/quotes/expiring", async (req, res) => {
    const days = Math.max(1, parseInt(req.query.days, 10) || 14);
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const rows = await query(`
      SELECT id, customer_name, valid_until FROM quotes
      WHERE status='Sent' AND valid_until != '' AND valid_until <= $1
      ORDER BY valid_until ASC LIMIT 20
    `, [horizon]);
    ok(res, rows.map(r => ({
      id: r.id, customerName: r.customer_name || '',
      validUntil: r.valid_until, expired: r.valid_until < today,
    })));
  });

  app.get("/api/quotes/:id", async (req, res) => {
    const [q] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    if (!q) return err(res, "Not found", 404);
    // 404, not 403 — info-hiding, matching every other office-scoped single-record route.
    if (!(await applyOfficeScopedAccessFilter([mapQuote(q)], req.user, req)).length) return err(res, "Not found", 404);
    const lines = await query("SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY sort_order", [req.params.id]);
    ok(res, { ...mapQuote(q), lines: lines.map(mapQuoteLine) });
  });

  app.post("/api/quotes", quoteWrite, async (req, res) => {
    const { customerId = "", customerName = "",
            consigneeId = "", consigneeName = "", principalId = "", principalName = "",
            notifyId = "", notifyName = "", pol = "", pod = "", carrierCode = "",
            contractId = "", contractRef = "", commodityCode = "",
            movementType = "FCL", serviceType = "Port-to-Port", incoterm = "",
            cargoReadyDate = "", validUntil = "", notes = "", currency = "USD",
            declaredValue = null, declaredValueCurrency = "USD", freightTerms = "Prepaid",
            officeId = "", lines = [] } = req.body || {};
    if (!pol || !pod) return err(res, "pol and pod are required");
    const invalidLine = findInvalidLine(lines);
    if (invalidLine) return err(res, `Each line's quantity must be a positive number (got "${invalidLine.quantity}")`);
    const id = `QT-${uid()}`;
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    await query(`INSERT INTO quotes
      (id, status, customer_id, customer_name, consignee_id, consignee_name, principal_id, principal_name,
       notify_id, notify_name, pol, pod, carrier_code, contract_id, contract_ref,
       commodity_code, movement_type, service_type, incoterm, cargo_ready_date, valid_until, notes,
       currency, declared_value, declared_value_currency, freight_terms, office_id, created_at, created_by)
      VALUES ($1,'Draft',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
      [id, customerId, customerName, consigneeId, consigneeName, principalId, principalName,
           notifyId, notifyName, pol.toUpperCase(), pod.toUpperCase(), carrierCode.toUpperCase(),
           contractId, contractRef, commodityCode, movementType, serviceType, incoterm, cargoReadyDate,
           validUntil, notes, currency.toUpperCase(),
           declaredValue !== null && declaredValue !== "" ? Number(declaredValue) : null,
           declaredValueCurrency.toUpperCase(), freightTerms, officeId || null, now, actor]);
    await insertLines(id, lines);
    await recomputeQuoteTotal(id);
    await logEntityEvent("quote", id, "CREATED", null, null, null,
      JSON.stringify({ customerName, pol: pol.toUpperCase(), pod: pod.toUpperCase(), carrierCode, lineCount: lines.length }));
    const [q] = await query("SELECT * FROM quotes WHERE id=$1", [id]);
    const savedLines = await query("SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY sort_order", [id]);
    ok(res, { ...mapQuote(q), lines: savedLines.map(mapQuoteLine) }, 201);
  });

  app.put("/api/quotes/:id", quoteWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    if (existing.status !== "Draft") return err(res, `Only a Draft quote can be edited (current status: ${existing.status})`, 409);
    const { customerId = "", customerName = "",
            consigneeId = "", consigneeName = "", principalId = "", principalName = "",
            notifyId = "", notifyName = "", pol = "", pod = "", carrierCode = "",
            contractId = "", contractRef = "", commodityCode = "",
            movementType = "FCL", serviceType = "Port-to-Port", incoterm = "",
            cargoReadyDate = "", validUntil = "", notes = "", currency = "USD",
            declaredValue = null, declaredValueCurrency = "USD", freightTerms = "Prepaid",
            officeId = "", lines = [] } = req.body || {};
    if (!pol || !pod) return err(res, "pol and pod are required");
    const invalidLine = findInvalidLine(lines);
    if (invalidLine) return err(res, `Each line's quantity must be a positive number (got "${invalidLine.quantity}")`);
    await query(`UPDATE quotes SET customer_id=$1, customer_name=$2, consignee_id=$3, consignee_name=$4,
      principal_id=$5, principal_name=$6, notify_id=$7, notify_name=$8, pol=$9, pod=$10, carrier_code=$11,
      contract_id=$12, contract_ref=$13, commodity_code=$14, movement_type=$15, service_type=$16, incoterm=$17,
      cargo_ready_date=$18, valid_until=$19, notes=$20, currency=$21, declared_value=$22,
      declared_value_currency=$23, freight_terms=$24, office_id=$25 WHERE id=$26`,
      [customerId, customerName, consigneeId, consigneeName, principalId, principalName,
           notifyId, notifyName, pol.toUpperCase(), pod.toUpperCase(), carrierCode.toUpperCase(),
           contractId, contractRef, commodityCode, movementType, serviceType, incoterm, cargoReadyDate,
           validUntil, notes, currency.toUpperCase(),
           declaredValue !== null && declaredValue !== "" ? Number(declaredValue) : null,
           declaredValueCurrency.toUpperCase(), freightTerms, officeId || null, req.params.id]);
    await query("DELETE FROM quote_lines WHERE quote_id=$1", [req.params.id]);
    await insertLines(req.params.id, lines);
    await recomputeQuoteTotal(req.params.id);
    await logEntityEvent("quote", req.params.id, "UPDATED", null, null, null,
      JSON.stringify({ customerName, pol: pol.toUpperCase(), pod: pod.toUpperCase(), lineCount: lines.length }));
    const [q] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    const savedLines = await query("SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY sort_order", [req.params.id]);
    ok(res, { ...mapQuote(q), lines: savedLines.map(mapQuoteLine) });
  });

  app.delete("/api/quotes/:id", quoteWrite, async (req, res) => {
    const [q] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    if (!q) return err(res, "Not found", 404);
    if (q.status === "Converted") return err(res, "This quote has already converted to a shipment — it stays as a historical record instead of being deleted");
    await query("DELETE FROM quotes WHERE id=$1", [req.params.id]);
    await logEntityEvent("quote", req.params.id, "DELETED", null, null, null,
      JSON.stringify({ customerName: q.customer_name, status: q.status }));
    ok(res, { deleted: req.params.id });
  });

  // ─── Lifecycle transitions ──────────────────────────────────────────────────

  app.post("/api/quotes/:id/send", quoteWrite, async (req, res) => {
    const [q] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    if (!q) return err(res, "Not found", 404);
    if (q.status !== "Draft") return err(res, `Only a Draft quote can be sent (current status: ${q.status})`, 409);
    const [{ n: lineCount }] = await query("SELECT COUNT(*) AS n FROM quote_lines WHERE quote_id=$1", [req.params.id]);
    if (Number(lineCount) === 0) return err(res, "Add at least one line before sending this quote");
    if (!q.valid_until) return err(res, "Set a valid-until date before sending this quote");
    const today = new Date().toISOString().slice(0, 10);
    if (q.valid_until < today) return err(res, "valid_until is already in the past — update it before sending");
    const now = new Date().toISOString();
    await query("UPDATE quotes SET status='Sent', sent_at=$1 WHERE id=$2", [now, req.params.id]);
    await logEntityEvent("quote", req.params.id, "UPDATED", "status", "Draft", "Sent", JSON.stringify({ customerName: q.customer_name }));
    const [fresh] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    ok(res, mapQuote(fresh));
  });

  app.post("/api/quotes/:id/accept", quoteWrite, async (req, res) => {
    const [q] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    if (!q) return err(res, "Not found", 404);
    if (q.status !== "Sent") return err(res, `Only a Sent quote can be accepted (current status: ${q.status})`, 409);
    const today = new Date().toISOString().slice(0, 10);
    if (q.valid_until && q.valid_until < today) return err(res, "This quote has expired — update and re-send it instead of accepting the stale version", 409);
    const now = new Date().toISOString();
    await query("UPDATE quotes SET status='Accepted', accepted_at=$1 WHERE id=$2", [now, req.params.id]);
    await logEntityEvent("quote", req.params.id, "UPDATED", "status", "Sent", "Accepted", JSON.stringify({ customerName: q.customer_name }));
    const [fresh] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    ok(res, mapQuote(fresh));
  });

  app.post("/api/quotes/:id/decline", quoteWrite, async (req, res) => {
    const { reason = "" } = req.body || {};
    const [q] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    if (!q) return err(res, "Not found", 404);
    if (q.status !== "Sent") return err(res, `Only a Sent quote can be declined (current status: ${q.status})`, 409);
    const now = new Date().toISOString();
    await query("UPDATE quotes SET status='Declined', declined_at=$1, decline_reason=$2 WHERE id=$3", [now, reason, req.params.id]);
    await logEntityEvent("quote", req.params.id, "UPDATED", "status", "Sent", "Declined", JSON.stringify({ customerName: q.customer_name, reason }));
    const [fresh] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    ok(res, mapQuote(fresh));
  });

  // Converts an Accepted quote into a real shipment. BUY-side cost lines come from the matched
  // contract via the existing importContractRates path (unchanged); SELL-side cost lines come
  // directly from the quote's own agreed line items — what was actually offered to the customer,
  // which can differ from the live contract rate once margin is added.
  app.post("/api/quotes/:id/convert", quoteWrite, async (req, res) => {
    const [q] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    if (!q) return err(res, "Not found", 404);
    if (q.status !== "Accepted") return err(res, `Only an Accepted quote can be converted (current status: ${q.status})`, 409);
    const lines = await query("SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY sort_order", [req.params.id]);

    const id = `SHP-${uid()}`;
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    const contractType = q.contract_id ? "Central" : "SPOT";

    // Carry the quote's own office forward (User Management redesign, 2026-09-12) — a
    // quote-converted shipment previously set none of emo/imo/controlling_office_id at all,
    // leaving it invisible to office-scoped visibility until someone edited it by hand. A quote
    // has one office (no Export/Import split, unlike a shipment), so it lands on whichever side
    // matches that office's own department.
    let quoteEmoOfficeId = null, quoteImoOfficeId = null;
    if (q.office_id) {
      const [qOffice] = await query("SELECT department FROM offices WHERE id=$1", [q.office_id]);
      if (qOffice?.department === "SE") quoteEmoOfficeId = q.office_id;
      else if (qOffice?.department === "SI") quoteImoOfficeId = q.office_id;
    }

    // Only the columns a quote actually has a value for are listed — every other shipments
    // column (etd, vessel, bookingRef, ...) is genuinely unknown at this point and correctly
    // falls back to its own table-level DEFAULT, exactly like an omitted field on the real
    // POST /api/shipments already does. Consignee/Principal/Notify/declared value/freight terms
    // (2026-09 gap-closing pass) now carry over too — a quote captures these directly since this
    // change, closing what used to be a real "re-enter everything by hand" gap on every
    // conversion. source_quote_id is the reverse pointer completing the chain alongside
    // quotes.converted_shipment_id (and, when this quote itself came from an Opportunity,
    // source_opportunity_id on the quote — see routes/opportunities.js).
    await query(`INSERT INTO shipments
      (id, pol, pod, carrier_code, contract_type, status, created_at,
       contract_id, contract_ref, commodity_code, shipper_id, shipper_name,
       consignee_id, consignee_name, principal_id, principal_name, notify_id, notify_name,
       movement_type, service_type, incoterm, cargo_ready_date,
       declared_value, declared_value_currency, freight_terms, source_quote_id,
       emo_office_id, imo_office_id)
      VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
      [id, q.pol, q.pod, q.carrier_code, contractType, now,
           q.contract_id, q.contract_ref, q.commodity_code, q.customer_id, q.customer_name,
           q.consignee_id, q.consignee_name, q.principal_id, q.principal_name, q.notify_id, q.notify_name,
           q.movement_type, q.service_type, q.incoterm, q.cargo_ready_date,
           q.declared_value, q.declared_value_currency, q.freight_terms, req.params.id,
           quoteEmoOfficeId, quoteImoOfficeId]);
    await logEvent(id, 'SHIPMENT_CREATED', null, null, null,
      JSON.stringify({ pol: q.pol, pod: q.pod, carrier: q.carrier_code, status: 'Active', contractType, source: 'quote', quoteId: req.params.id }), req.user?.name || req.user?.email || "");
    await maybeAssignLineAgents(id, q.carrier_code, q.pol, q.pod, req.user?.name || req.user?.email || "");
    if (contractType === 'Central' && q.contract_id) await importContractRates(id);

    for (const l of lines) {
      const chargeCode = SERVICE_CODE_MAP[(l.service_code || "").toUpperCase()] || "Other";
      const amount = (l.rate || 0) * (l.quantity || 1);
      const exchangeRate = (amount > 0 && l.amount_usd > 0) ? Math.round((l.amount_usd / amount) * 100000) / 100000 : 1;
      const lineId = `CL-${uid()}`;
      await query(`INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,notes,created_at,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [lineId, id, 'SELL', chargeCode, l.currency || 'USD', amount, exchangeRate, l.description || '', now, 'quote']);
      await logEntityEvent('cost_line', lineId, 'IMPORTED', null, null, null,
        JSON.stringify({ shipmentId: id, chargeCode, source: 'quote', quoteId: req.params.id }));
    }

    // Real containers from the quote's own per-container line items (2026-09 gap-closing pass) —
    // previously nothing here ever created a `containers` row, even though a quote line already
    // carries a free-text container type + quantity. Grouped by type rather than one-row-per-line
    // since several cost lines (Ocean Freight, THC, ...) routinely describe the SAME physical
    // containers — summing their quantities would over-create; the max across the group is the
    // real container count. QUOTE_CONTAINER_SIZES mirrors routes/shipments.js's own
    // CONTAINER_SIZES check (not threaded through ctx for one small local constant, same call
    // maybeAssignLineAgents's own duplication comment above already made).
    const byType = new Map();
    for (const l of lines) {
      const t = (l.container_type || "").trim().toUpperCase();
      if (!t || l.unit !== "per_container") continue;
      byType.set(t, Math.max(byType.get(t) || 0, Number(l.quantity) || 1));
    }
    let containersCreated = 0;
    for (const [containerType, qty] of byType) {
      const sizeMatch = containerType.match(/^(20|40)/);
      if (!sizeMatch) continue; // doesn't parse to a real container size — skip rather than block conversion
      const size = sizeMatch[1];
      const type = containerType.slice(size.length) || "GP";
      const count = Math.max(1, Math.round(qty));
      for (let i = 0; i < count; i++) {
        // container_number has no DB default (NOT NULL, no DEFAULT) — every other creation path
        // (ContainerForm, bulk import) always has a real typed number by the time it inserts;
        // here there genuinely isn't one yet, so this is the one path that inserts blank on
        // purpose, same as an operator would if adding a container before the number is known.
        await query(`INSERT INTO containers (id, shipment_id, container_number, size, type) VALUES ($1,$2,'',$3,$4)`,
          [`CTR-${uid()}`, id, size, type]);
        containersCreated++;
      }
      // Same audit-trail idiom POST /api/containers already uses — a converted quote's
      // containers previously left no CONTAINER_ADDED trace in shipment history (audit gap
      // found in a post-implementation review pass, 2026-09-10).
      await logEvent(id, 'CONTAINER_ADDED', null, null, null,
        JSON.stringify({ size, type, source: 'quote', quoteId: req.params.id, count }), req.user?.name || req.user?.email || "");
    }
    // Same gap: nothing here ever recomputed the space/TEU consumption badge after adding
    // containers, unlike POST /api/containers (which does this on every single create) — a
    // Central-contract quote converting with an allocation already linked would show a stale
    // (usually blank) space badge until some unrelated later container edit happened to
    // trigger a recompute. One call after the whole batch, not per-container — recomputeSpaceBadge
    // reads the full current container set fresh each time, so it's correct either way.
    if (containersCreated > 0) await recomputeSpaceBadge(id);

    const silentScreening = await screenShipmentById(id);

    // Same earlier credit-check trigger point routes/shipments.js's own direct POST /api/shipments
    // already added (v0.73.1) — soft/informational only, never blocking. Now checks all three
    // parties a converted quote can actually carry (2026-09 gap-closing pass extended this beyond
    // just the Shipper, once Consignee/Principal became real fields on a quote).
    const heldParties = [];
    for (const [custId, role] of [[q.customer_id, 'Shipper'], [q.consignee_id, 'Consignee'], [q.principal_id, 'Principal']]) {
      if (!custId) continue;
      const cust = await getCustomerRow(custId);
      if (cust?.creditHold) heldParties.push({ customerId: custId, companyName: cust.companyName, role, reason: cust.creditHoldReason || '' });
    }

    await query("UPDATE quotes SET status='Converted', converted_shipment_id=$1, converted_at=$2 WHERE id=$3", [id, now, req.params.id]);
    await logEntityEvent("quote", req.params.id, "UPDATED", "status", "Accepted", "Converted",
      JSON.stringify({ customerName: q.customer_name, shipmentId: id }));

    // The full mapped shipment (not just its id) so the frontend can drop it straight into its
    // own local shipments list before navigating — the same thing a direct POST /api/shipments
    // create already returns, needed here for the exact same reason: the SPA's shipment detail
    // page only renders for a shipment it already has in local state.
    // Enriched (2026-09-12 QA finding) — this used to be a bare SELECT *, the identical gap
    // POST /api/shipments' own create response had: teu/margin/bookingStatus/office names all
    // came back blank here despite a real converted shipment already having containers and cost
    // lines by this point. Confirmed live: a converted quote with 4 TEU of containers and $3,400
    // of SELL cost lines still reported teu:0/marginSellUsd:null in this exact response.
    const [shipmentRow] = await query(`
      SELECT s.*, p1.name AS pol_name, p2.name AS pod_name,
             emo.code AS emo_office_code, emo.name AS emo_office_name,
             imo.code AS imo_office_code, imo.name AS imo_office_name,
             ctrl.code AS controlling_office_code, ctrl.name AS controlling_office_name,
             ${ctx.SHIPMENT_ENRICHMENT_SELECT}
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      LEFT JOIN offices emo  ON emo.id  = s.emo_office_id
      LEFT JOIN offices imo  ON imo.id  = s.imo_office_id
      LEFT JOIN offices ctrl ON ctrl.id = s.controlling_office_id
      ${ctx.SHIPMENT_ENRICHMENT_JOINS}
      WHERE s.id = $1
    `, [id]);
    const [freshQuote] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    ok(res, {
      quote: mapQuote(freshQuote),
      shipmentId: id,
      shipment: mapShipment(shipmentRow),
      screening: silentScreening || null,
      creditWarning: heldParties.length ? { onHold: heldParties } : null,
    });
  });
};
