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
module.exports = function quotesRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, isUniqueViolation, mapQuote, mapQuoteLine, mapShipment,
          logEvent, logEntityEvent, toUsd, SERVICE_CODE_MAP, importContractRates,
          resolveCarrierAgentCandidates, screenShipmentById } = ctx;

  const quoteWrite = requireRole(["admin", "operator", "occ_bk"]);

  // ─── Auto-expire ────────────────────────────────────────────────────────────
  // Mirrors routes/contracts.js's own expireStaleContracts exactly — a Sent quote whose
  // valid_until has passed without an Accept/Decline is stale and should stop looking actionable.
  // Runs once at startup (covers a quote that expired while the server was down) and then hourly.
  function expireStaleQuotes() {
    const today = new Date().toISOString().slice(0, 10);
    const stale = db.prepare("SELECT id, customer_name FROM quotes WHERE status='Sent' AND valid_until != '' AND valid_until < ?").all(today);
    if (stale.length === 0) return;
    const now = new Date().toISOString();
    const update = db.prepare("UPDATE quotes SET status='Expired', expired_at=? WHERE id=?");
    for (const q of stale) {
      update.run(now, q.id);
      logEntityEvent('quote', q.id, 'UPDATED', 'status', 'Sent', 'Expired',
        JSON.stringify({ customerName: q.customer_name, reason: 'valid_until passed' }));
    }
  }
  expireStaleQuotes();
  const expireSweep = setInterval(expireStaleQuotes, 60 * 60 * 1000);
  expireSweep.unref?.();

  // Carrier Line Agents — duplicated from routes/shipments.js's own maybeAssignLineAgents (small,
  // pure, self-contained) so a quote-converted shipment gets the exact same auto-assignment a
  // directly-created one would, without new cross-file ctx plumbing for a 10-line helper. A side
  // with 2+ candidates (only possible via the linked-ports fallback) is left unassigned rather
  // than guessing — same rule as the shipments.js copy, see its own comment for the full rationale.
  async function maybeAssignLineAgents(shipmentId, carrierCode, pol, pod) {
    for (const [port, role] of [[pol, "Line Agent (Export)"], [pod, "Line Agent (Import)"]]) {
      const candidates = await resolveCarrierAgentCandidates(carrierCode, port);
      if (candidates.length !== 1) continue;
      const match = candidates[0];
      try {
        db.prepare(`INSERT INTO shipment_parties (id, shipment_id, role, customer_id, customer_name, created_at)
          VALUES (?,?,?,?,?,?)`)
          .run(`PTY-${uid()}`, shipmentId, role, match.agent_customer_id, match.agent_customer_name, new Date().toISOString());
      } catch (e) { if (!isUniqueViolation(e)) throw e; }
    }
  }

  function recomputeQuoteTotal(quoteId) {
    const total = db.prepare("SELECT COALESCE(SUM(amount_usd),0) AS n FROM quote_lines WHERE quote_id=?").get(quoteId).n;
    db.prepare("UPDATE quotes SET total_amount_usd=? WHERE id=?").run(total, quoteId);
    return total;
  }

  async function insertLines(quoteId, lines) {
    const stmt = db.prepare(`INSERT INTO quote_lines
      (id, quote_id, service_code, description, container_type, quantity, unit, rate, currency, amount_usd, sort_order, set_temperature_c)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    let i = 0;
    for (const l of lines) {
      const quantity = Number(l.quantity) || 1;
      const rate = Number(l.rate) || 0;
      const currency = (l.currency || "USD").toUpperCase();
      const amountUsd = await toUsd(rate * quantity, currency);
      // Only meaningful on a reefer line, but not container-type-gated here — mirrors
      // ContainerForm's own POST/PUT, which likewise trusts whatever the frontend already
      // gated rather than re-deriving "is this a reefer line" server-side.
      const setTemperatureC = l.setTemperatureC !== undefined && l.setTemperatureC !== null && l.setTemperatureC !== ""
        ? Number(l.setTemperatureC) : null;
      stmt.run(`QTL-${uid()}`, quoteId, (l.serviceCode || "").toUpperCase(), l.description || "",
        l.containerType || "", quantity, l.unit || "per_container", rate, currency, amountUsd, i++, setTemperatureC);
    }
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  app.get("/api/quotes", (req, res) => {
    const { status = "", customerId = "", limit = "50", offset = "0" } = req.query;
    const clauses = [], params = [];
    if (status.trim()) { clauses.push("status=?"); params.push(status.trim()); }
    if (customerId.trim()) { clauses.push("customer_id=?"); params.push(customerId.trim()); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM quotes ${where}`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM quotes ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapQuote), total, limit: lim, offset: off });
  });

  app.get("/api/quotes/:id", (req, res) => {
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id);
    if (!q) return err(res, "Not found", 404);
    const lines = db.prepare("SELECT * FROM quote_lines WHERE quote_id=? ORDER BY sort_order").all(req.params.id);
    ok(res, { ...mapQuote(q), lines: lines.map(mapQuoteLine) });
  });

  app.post("/api/quotes", quoteWrite, async (req, res) => {
    const { customerId = "", customerName = "", pol = "", pod = "", carrierCode = "",
            contractId = "", contractRef = "", commodityCode = "",
            movementType = "FCL", serviceType = "Port-to-Port", incoterm = "",
            cargoReadyDate = "", validUntil = "", notes = "", currency = "USD",
            lines = [] } = req.body || {};
    if (!pol || !pod) return err(res, "pol and pod are required");
    const id = `QT-${uid()}`;
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    db.prepare(`INSERT INTO quotes
      (id, status, customer_id, customer_name, pol, pod, carrier_code, contract_id, contract_ref,
       commodity_code, movement_type, service_type, incoterm, cargo_ready_date, valid_until, notes,
       currency, created_at, created_by)
      VALUES (?,'Draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, customerId, customerName, pol.toUpperCase(), pod.toUpperCase(), carrierCode.toUpperCase(),
           contractId, contractRef, commodityCode, movementType, serviceType, incoterm, cargoReadyDate,
           validUntil, notes, currency.toUpperCase(), now, actor);
    await insertLines(id, lines);
    recomputeQuoteTotal(id);
    logEntityEvent("quote", id, "CREATED", null, null, null,
      JSON.stringify({ customerName, pol: pol.toUpperCase(), pod: pod.toUpperCase(), carrierCode, lineCount: lines.length }));
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(id);
    const savedLines = db.prepare("SELECT * FROM quote_lines WHERE quote_id=? ORDER BY sort_order").all(id);
    ok(res, { ...mapQuote(q), lines: savedLines.map(mapQuoteLine) }, 201);
  });

  app.put("/api/quotes/:id", quoteWrite, async (req, res) => {
    const existing = db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    if (existing.status !== "Draft") return err(res, `Only a Draft quote can be edited (current status: ${existing.status})`, 409);
    const { customerId = "", customerName = "", pol = "", pod = "", carrierCode = "",
            contractId = "", contractRef = "", commodityCode = "",
            movementType = "FCL", serviceType = "Port-to-Port", incoterm = "",
            cargoReadyDate = "", validUntil = "", notes = "", currency = "USD",
            lines = [] } = req.body || {};
    if (!pol || !pod) return err(res, "pol and pod are required");
    db.prepare(`UPDATE quotes SET customer_id=?, customer_name=?, pol=?, pod=?, carrier_code=?,
      contract_id=?, contract_ref=?, commodity_code=?, movement_type=?, service_type=?, incoterm=?,
      cargo_ready_date=?, valid_until=?, notes=?, currency=? WHERE id=?`)
      .run(customerId, customerName, pol.toUpperCase(), pod.toUpperCase(), carrierCode.toUpperCase(),
           contractId, contractRef, commodityCode, movementType, serviceType, incoterm, cargoReadyDate,
           validUntil, notes, currency.toUpperCase(), req.params.id);
    db.prepare("DELETE FROM quote_lines WHERE quote_id=?").run(req.params.id);
    await insertLines(req.params.id, lines);
    recomputeQuoteTotal(req.params.id);
    logEntityEvent("quote", req.params.id, "UPDATED", null, null, null,
      JSON.stringify({ customerName, pol: pol.toUpperCase(), pod: pod.toUpperCase(), lineCount: lines.length }));
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id);
    const savedLines = db.prepare("SELECT * FROM quote_lines WHERE quote_id=? ORDER BY sort_order").all(req.params.id);
    ok(res, { ...mapQuote(q), lines: savedLines.map(mapQuoteLine) });
  });

  app.delete("/api/quotes/:id", quoteWrite, (req, res) => {
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id);
    if (!q) return err(res, "Not found", 404);
    if (q.status === "Converted") return err(res, "This quote has already converted to a shipment — it stays as a historical record instead of being deleted");
    db.prepare("DELETE FROM quotes WHERE id=?").run(req.params.id);
    logEntityEvent("quote", req.params.id, "DELETED", null, null, null,
      JSON.stringify({ customerName: q.customer_name, status: q.status }));
    ok(res, { deleted: req.params.id });
  });

  // ─── Lifecycle transitions ──────────────────────────────────────────────────

  app.post("/api/quotes/:id/send", quoteWrite, (req, res) => {
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id);
    if (!q) return err(res, "Not found", 404);
    if (q.status !== "Draft") return err(res, `Only a Draft quote can be sent (current status: ${q.status})`, 409);
    const lineCount = db.prepare("SELECT COUNT(*) AS n FROM quote_lines WHERE quote_id=?").get(req.params.id).n;
    if (lineCount === 0) return err(res, "Add at least one line before sending this quote");
    if (!q.valid_until) return err(res, "Set a valid-until date before sending this quote");
    const today = new Date().toISOString().slice(0, 10);
    if (q.valid_until < today) return err(res, "valid_until is already in the past — update it before sending");
    const now = new Date().toISOString();
    db.prepare("UPDATE quotes SET status='Sent', sent_at=? WHERE id=?").run(now, req.params.id);
    logEntityEvent("quote", req.params.id, "UPDATED", "status", "Draft", "Sent", JSON.stringify({ customerName: q.customer_name }));
    ok(res, mapQuote(db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id)));
  });

  app.post("/api/quotes/:id/accept", quoteWrite, (req, res) => {
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id);
    if (!q) return err(res, "Not found", 404);
    if (q.status !== "Sent") return err(res, `Only a Sent quote can be accepted (current status: ${q.status})`, 409);
    const today = new Date().toISOString().slice(0, 10);
    if (q.valid_until && q.valid_until < today) return err(res, "This quote has expired — update and re-send it instead of accepting the stale version", 409);
    const now = new Date().toISOString();
    db.prepare("UPDATE quotes SET status='Accepted', accepted_at=? WHERE id=?").run(now, req.params.id);
    logEntityEvent("quote", req.params.id, "UPDATED", "status", "Sent", "Accepted", JSON.stringify({ customerName: q.customer_name }));
    ok(res, mapQuote(db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id)));
  });

  app.post("/api/quotes/:id/decline", quoteWrite, (req, res) => {
    const { reason = "" } = req.body || {};
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id);
    if (!q) return err(res, "Not found", 404);
    if (q.status !== "Sent") return err(res, `Only a Sent quote can be declined (current status: ${q.status})`, 409);
    const now = new Date().toISOString();
    db.prepare("UPDATE quotes SET status='Declined', declined_at=?, decline_reason=? WHERE id=?").run(now, reason, req.params.id);
    logEntityEvent("quote", req.params.id, "UPDATED", "status", "Sent", "Declined", JSON.stringify({ customerName: q.customer_name, reason }));
    ok(res, mapQuote(db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id)));
  });

  // Converts an Accepted quote into a real shipment. BUY-side cost lines come from the matched
  // contract via the existing importContractRates path (unchanged); SELL-side cost lines come
  // directly from the quote's own agreed line items — what was actually offered to the customer,
  // which can differ from the live contract rate once margin is added.
  app.post("/api/quotes/:id/convert", quoteWrite, async (req, res) => {
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id);
    if (!q) return err(res, "Not found", 404);
    if (q.status !== "Accepted") return err(res, `Only an Accepted quote can be converted (current status: ${q.status})`, 409);
    const lines = db.prepare("SELECT * FROM quote_lines WHERE quote_id=? ORDER BY sort_order").all(req.params.id);

    const id = `SHP-${uid()}`;
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    const contractType = q.contract_id ? "Central" : "SPOT";

    // Only the columns a quote actually has a value for are listed — every other shipments
    // column (etd, vessel, bookingRef, ...) is genuinely unknown at this point and correctly
    // falls back to its own table-level DEFAULT, exactly like an omitted field on the real
    // POST /api/shipments already does.
    db.prepare(`INSERT INTO shipments
      (id, pol, pod, carrier_code, contract_type, status, created_at,
       contract_id, contract_ref, commodity_code, shipper_id, shipper_name,
       movement_type, service_type, incoterm, cargo_ready_date)
      VALUES (?,?,?,?,?,'Active',?,?,?,?,?,?,?,?,?,?)`)
      .run(id, q.pol, q.pod, q.carrier_code, contractType, now,
           q.contract_id, q.contract_ref, q.commodity_code, q.customer_id, q.customer_name,
           q.movement_type, q.service_type, q.incoterm, q.cargo_ready_date);
    logEvent(id, 'SHIPMENT_CREATED', null, null, null,
      JSON.stringify({ pol: q.pol, pod: q.pod, carrier: q.carrier_code, status: 'Active', contractType, source: 'quote', quoteId: req.params.id }));
    await maybeAssignLineAgents(id, q.carrier_code, q.pol, q.pod);
    if (contractType === 'Central' && q.contract_id) await importContractRates(id);

    for (const l of lines) {
      const chargeCode = SERVICE_CODE_MAP[(l.service_code || "").toUpperCase()] || "Other";
      const amount = (l.rate || 0) * (l.quantity || 1);
      const exchangeRate = (amount > 0 && l.amount_usd > 0) ? Math.round((l.amount_usd / amount) * 100000) / 100000 : 1;
      const lineId = `CL-${uid()}`;
      db.prepare(`INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,notes,created_at,source) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(lineId, id, 'SELL', chargeCode, l.currency || 'USD', amount, exchangeRate, l.description || '', now, 'quote');
      logEntityEvent('cost_line', lineId, 'IMPORTED', null, null, null,
        JSON.stringify({ shipmentId: id, chargeCode, source: 'quote', quoteId: req.params.id }));
    }

    const silentScreening = await screenShipmentById(id);
    db.prepare("UPDATE quotes SET status='Converted', converted_shipment_id=?, converted_at=? WHERE id=?").run(id, now, req.params.id);
    logEntityEvent("quote", req.params.id, "UPDATED", "status", "Accepted", "Converted",
      JSON.stringify({ customerName: q.customer_name, shipmentId: id }));

    // The full mapped shipment (not just its id) so the frontend can drop it straight into its
    // own local shipments list before navigating — the same thing a direct POST /api/shipments
    // create already returns, needed here for the exact same reason: the SPA's shipment detail
    // page only renders for a shipment it already has in local state.
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(id);
    ok(res, {
      quote: mapQuote(db.prepare("SELECT * FROM quotes WHERE id=?").get(req.params.id)),
      shipmentId: id,
      shipment: mapShipment(shipment),
      screening: silentScreening || null,
    });
  });
};
