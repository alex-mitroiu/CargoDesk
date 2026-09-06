"use strict";

// Freight Audit & Payment — reconciles a carrier's own submitted invoice against what was
// actually CONTRACTED (contract_rates) and/or already accrued (shipment_cost_lines), instead of
// trusting the carrier's number at face value. Distinct from the existing accrued->actualized->
// posted state machine on shipment_cost_lines: that tracks CargoDesk's OWN cost estimate maturing
// into a real figure over time; this validates an EXTERNAL document against what was agreed.
//
// Line lifecycle: pending (no contract rate/cost line found to compare against) -> matched
// (compared, within tolerance) | variance (compared, outside tolerance) -> approved | disputed.
// Approving a line posts it into the existing cost-line lifecycle exactly like the manual
// "Actualize" action would (routes/shipment-ops.js's PATCH .../cost-lines/:id/actualize), or
// creates a new accrued+actualized cost line in one step if nothing existing matched.
module.exports = function carrierInvoicesRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, mapCarrierInvoice, mapCarrierInvoiceLine, mapCostLine,
          logEntityEvent, toUsd, SERVICE_CODE_MAP, getSettings, callContractService,
          applyShipmentAccessFilter, mapShipment } = ctx;

  const invoiceWrite = requireRole(["admin", "operator", "occ_bk"]);
  // Same tier as routes/shipment-ops.js's postGate — approving a line writes/actualizes a real
  // cost line, the same class of action as posting one.
  const approveGate = requireRole(["admin", "operator"]);

  // 2026-09-06 audit — CRITICAL: every route in this file operates on a shipment by its own
  // CINV-/CINL- id (or a shipmentId in the request body/query), never through a URL
  // :shipmentId param — the systemic 2026-09-03 shipmentScopeParamCheck fix (server.js's
  // app.param guard) only fires on a literal :id/:shipmentId route param, so it never covered
  // this file at all. Verified live before fixing: a scoped occ_bk user (restricted to one POL)
  // could read every carrier invoice company-wide via the list/exceptions/detail routes below,
  // dispute a line, and create a brand-new invoice, all on a shipment entirely outside their
  // scope. This helper is the single choke point every route below now goes through.
  async function loadScopedShipment(shipmentId, req) {
    const [row] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
    if (!row) return null;
    const [allowed] = await applyShipmentAccessFilter([mapShipment(row)], req.user, req);
    return allowed ? row : null;
  }

  const INVOICE_STATUSES = ["Pending", "Reconciled", "Approved", "Disputed"];
  const LINE_STATUSES = ["pending", "matched", "variance", "approved", "disputed"];

  // ─── Matching engine ────────────────────────────────────────────────────────

  // Resolves the contract's current rates, respecting the contract_source toggle exactly like
  // createRateSnapshot (server.js) does — 'remote' mode fetches from the standalone Contract
  // Management Service instead of the local contract_rates table.
  async function loadContractRates(contractId) {
    if (((await getSettings()).contract_source || "local") === "remote") {
      try { return (await callContractService("GET", `/internal/contracts/${contractId}`)).rates.map(r => ({
        service_code: r.serviceCode || "", amount: r.amount, currency: r.currency || "USD",
        amount_usd: r.amountUsd, unit: r.unit || "per_container", container_type: r.containerType || "",
        routing_id: r.routingId || "",
      })); }
      catch { return []; }
    }
    return await query("SELECT service_code, amount, currency, amount_usd, unit, container_type, routing_id FROM contract_rates WHERE contract_id=$1", [contractId]);
  }

  function pickRate(rates, serviceCode, containerType, routingId, unit) {
    const candidates = rates.filter(r =>
      (r.service_code || "").toUpperCase() === serviceCode.toUpperCase() &&
      (r.routing_id === routingId || !r.routing_id) &&
      (unit ? (r.unit || "per_container") === unit : (r.unit || "per_container") !== "per_day"));
    if (!candidates.length) return null;
    return candidates.find(r => r.container_type && r.container_type.toUpperCase() === containerType.toUpperCase())
      || candidates.find(r => !r.container_type) || candidates[0];
  }

  // freeTimeWindow is duplicated (not imported) from routes/shipments.js — a small, stable, pure
  // date-math function, same "two independent copies" convention already used throughout this
  // codebase for helpers that would otherwise need new ctx plumbing across an encapsulation
  // boundary. Keep in sync manually if the free-time model ever changes.
  function freeTimeWindow(freeDays, startAt, closeAt) {
    if (freeDays == null) return { state: "no-window", daysLate: 0 };
    const startParsed = startAt ? new Date(startAt) : null;
    if (!startParsed || isNaN(startParsed)) return { state: "not-started", daysLate: 0 };
    const expiresAt = new Date(startParsed.getTime() + freeDays * 86400000);
    const closeParsed = closeAt ? new Date(closeAt) : null;
    const endPoint = (closeParsed && !isNaN(closeParsed)) ? closeParsed : new Date();
    const daysLate = Math.round((endPoint - expiresAt) / 86400000);
    return { state: daysLate > 0 ? "late" : "on-time", daysLate: Math.max(0, daysLate) };
  }

  // Returns { expectedAmount, expectedCurrency, expectedAmountUsd, expectedSource, matchedCostLineId }
  // — expectedSource '' means no comparison was possible at all (flows into line status 'pending').
  async function matchLine(shipment, line) {
    const noMatch = { expectedAmount: null, expectedCurrency: "USD", expectedAmountUsd: null, expectedSource: "", matchedCostLineId: "" };
    const serviceCode = (line.serviceCode || "").toUpperCase();

    // Detention/Demurrage pre-audit: independently compute the expected charge from the
    // container's own free-time window instead of trusting the carrier's D&D line at face value.
    // DET (Detention, carrier equipment held outside the terminal) and DEM (Demurrage, terminal
    // dwell time) are two distinct charge types with their own free-time allowance and their own
    // container_events anchor pair — a DET line must be checked against the detention window,
    // never the demurrage one (previously both service codes were silently compared against the
    // same demurrage-only window, since that was the only one this app tracked).
    if (line.containerId && line.freeTimeSide && (serviceCode === "DET" || serviceCode === "DEM")) {
      const [container] = await query("SELECT * FROM containers WHERE id=$1 AND shipment_id=$2", [line.containerId, shipment.id]);
      if (!container) return noMatch;
      const events = await query("SELECT event_type, occurred_at FROM container_events WHERE container_id=$1 ORDER BY occurred_at ASC", [line.containerId]);
      const byType = {};
      for (const e of events) byType[e.event_type] = e.occurred_at;
      const isOrigin = line.freeTimeSide === "origin";
      const isDetention = serviceCode === "DET";
      const freeDays = isDetention
        ? (isOrigin ? container.origin_detention_free_days : container.dest_detention_free_days)
        : (isOrigin ? container.origin_free_time_days : container.dest_free_time_days);
      const startAt = isDetention
        ? (isOrigin ? byType["Empty Pickup"] : byType["Gate Out"])
        : (isOrigin ? byType["Gate In"] : byType["Discharged"]);
      const closeAt = isDetention
        ? (isOrigin ? byType["Gate In"] : byType["Empty Return"])
        : (isOrigin ? byType["Sailed"] : byType["Gate Out"]);
      const w = freeTimeWindow(freeDays, startAt, closeAt);
      if (w.daysLate <= 0) return { ...noMatch, expectedSource: "dnd_calc" }; // computed: nothing owed
      if (!shipment.contract_id) return { ...noMatch, expectedSource: "dnd_calc" };
      const rates = await loadContractRates(shipment.contract_id);
      const containerType = `${container.size || ""}${container.type || ""}`;
      const rate = pickRate(rates, serviceCode, containerType, shipment.contract_routing_id || "", "per_day");
      if (!rate) return { ...noMatch, expectedSource: "dnd_calc" }; // late, but no per-day rate on file to check against
      const expectedAmount = rate.amount * w.daysLate;
      const expectedAmountUsd = (rate.amount_usd || 0) * w.daysLate;
      return { expectedAmount, expectedCurrency: rate.currency || "USD", expectedAmountUsd, expectedSource: "dnd_calc", matchedCostLineId: "" };
    }

    // Regular path — prefer an existing, still-accrued cost line (the shipment's own estimate for
    // this exact charge) over the contract's live rate, since the accrual is what was actually
    // quoted/booked at the time, which can differ from what the current live contract rate says.
    const chargeCode = SERVICE_CODE_MAP[serviceCode] || "Other";
    const [costLine] = await query(`
      SELECT * FROM shipment_cost_lines
      WHERE shipment_id=$1 AND type='BUY' AND status='accrued' AND charge_code=$2 AND (container_id=$3 OR container_id='')
      ORDER BY (container_id=$3) DESC, created_at ASC LIMIT 1
    `, [shipment.id, chargeCode, line.containerId || ""]);
    if (costLine) {
      return {
        expectedAmount: costLine.amount, expectedCurrency: costLine.currency,
        expectedAmountUsd: costLine.amount * costLine.exchange_rate, expectedSource: "cost_line",
        matchedCostLineId: costLine.id,
      };
    }

    if (!shipment.contract_id) return noMatch;
    const rates = await loadContractRates(shipment.contract_id);
    const container = line.containerId ? (await query("SELECT size, type FROM containers WHERE id=$1", [line.containerId]))[0] : null;
    const containerType = container ? `${container.size || ""}${container.type || ""}` : "";
    const rate = pickRate(rates, serviceCode, containerType, shipment.contract_routing_id || "");
    if (!rate) return noMatch;
    return {
      expectedAmount: rate.amount, expectedCurrency: rate.currency || "USD",
      expectedAmountUsd: rate.amount_usd || 0, expectedSource: "contract_rate", matchedCostLineId: "",
    };
  }

  async function computeLine(shipment, line) {
    const amountUsd = await toUsd(line.amount || 0, line.currency || "USD");
    const match = await matchLine(shipment, line);
    let varianceUsd = null, variancePct = null, status = "pending";
    if (match.expectedSource === "dnd_calc" && match.expectedAmount == null) {
      // Independently computed as "nothing owed" or "no per-day rate to check against" — either
      // way there's a real carrier-submitted amount with nothing to compare it to; treat as a
      // variance (not silently 'matched') since a D&D charge with no computed basis is exactly
      // the kind of line a human should look at, not the kind that should auto-clear.
      status = "variance";
    } else if (match.expectedAmountUsd != null) {
      varianceUsd = amountUsd - match.expectedAmountUsd;
      variancePct = match.expectedAmountUsd !== 0 ? (varianceUsd / match.expectedAmountUsd) * 100 : (varianceUsd === 0 ? 0 : null);
      const tolerancePct = Math.abs(Number((await getSettings()).fap_variance_tolerance_pct) || 2);
      status = (variancePct != null && Math.abs(variancePct) <= tolerancePct) ? "matched" : "variance";
    }
    return { ...match, amountUsd, varianceUsd, variancePct, status };
  }

  async function recomputeInvoiceStatus(invoiceId) {
    const lines = await query("SELECT status FROM carrier_invoice_lines WHERE invoice_id=$1", [invoiceId]);
    let status = "Reconciled";
    if (lines.some(l => l.status === "disputed")) status = "Disputed";
    else if (lines.some(l => l.status === "pending" || l.status === "variance")) status = "Pending";
    else if (lines.length > 0 && lines.every(l => l.status === "approved")) status = "Approved";
    await query("UPDATE carrier_invoices SET status=$1 WHERE id=$2", [status, invoiceId]);
    return status;
  }

  async function insertLine(invoiceId, sortIndex, line, computed) {
    const id = `CINL-${uid()}`;
    await query(`INSERT INTO carrier_invoice_lines
      (id, invoice_id, sort_order, service_code, description, container_id, free_time_side, amount, currency, amount_usd,
       expected_amount, expected_currency, expected_amount_usd, expected_source, matched_cost_line_id,
       variance_usd, variance_pct, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, invoiceId, sortIndex, line.serviceCode || "", line.description || "", line.containerId || "", line.freeTimeSide || "",
           line.amount || 0, line.currency || "USD", computed.amountUsd,
           computed.expectedAmount, computed.expectedCurrency, computed.expectedAmountUsd, computed.expectedSource,
           computed.matchedCostLineId, computed.varianceUsd, computed.variancePct, computed.status]);
    return id;
  }

  // ─── Exception queue — MUST be before /:id ─────────────────────────────────
  app.get("/api/carrier-invoices/exceptions", async (req, res) => {
    // Worst-variance-first, capped rather than fully paginated — this is a queue meant to be
    // worked down to zero (Approve/Dispute each line), not browsed page by page, so a plain
    // LIMIT here (previously absent entirely) is a reasonable safety cap without adding full
    // pagination UI to what should rarely have more than a couple hundred open lines at once.
    const rows = await query(`
      SELECT l.*, i.shipment_id, i.carrier_code, i.invoice_number, i.invoice_date, i.currency AS invoice_currency
      FROM carrier_invoice_lines l JOIN carrier_invoices i ON i.id = l.invoice_id
      WHERE l.status IN ('pending','variance')
      ORDER BY ABS(COALESCE(l.variance_usd, 0)) DESC
      LIMIT 200
    `);
    if (rows.length === 0) return ok(res, []);
    const shipmentIds = [...new Set(rows.map(r => r.shipment_id))];
    const ph = shipmentIds.map((_, i) => `$${i + 1}`).join(",");
    const shipmentRows = await query(`SELECT * FROM shipments WHERE id IN (${ph})`, shipmentIds);
    const allowedIds = new Set((await applyShipmentAccessFilter(shipmentRows.map(mapShipment), req.user, req)).map(s => s.id));
    ok(res, rows.filter(r => allowedIds.has(r.shipment_id)).map(r => ({
      ...mapCarrierInvoiceLine(r),
      shipmentId: r.shipment_id, carrierCode: r.carrier_code || "",
      invoiceNumber: r.invoice_number || "", invoiceDate: r.invoice_date || "",
    })));
  });

  app.get("/api/carrier-invoices", async (req, res) => {
    const { shipmentId = "", carrierCode = "", status = "", limit = "50", offset = "0" } = req.query;
    const clauses = [], params = [];
    const p = v => { params.push(v); return `$${params.length}`; };
    if (shipmentId.trim()) clauses.push(`shipment_id=${p(shipmentId.trim())}`);
    if (carrierCode.trim()) clauses.push(`carrier_code=${p(carrierCode.trim().toUpperCase())}`);
    if (status.trim()) clauses.push(`status=${p(status.trim())}`);
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
    // Scope-filter BEFORE paginating (2026-09-06 audit — same finding as /exceptions above) so
    // both `total` and the returned page are correct for a scoped caller, not just safe — filters
    // the full matching set in JS rather than in SQL since applyShipmentAccessFilter's scope
    // rules (pol/trade_lane/country) aren't expressible as a WHERE clause against this table.
    const allRows = await query(`SELECT * FROM carrier_invoices ${where} ORDER BY created_at DESC`, params);
    let scopedRows = allRows;
    if (allRows.length > 0) {
      const shipmentIds = [...new Set(allRows.map(r => r.shipment_id))];
      const ph = shipmentIds.map((_, i) => `$${i + 1}`).join(",");
      const shipmentRows = await query(`SELECT * FROM shipments WHERE id IN (${ph})`, shipmentIds);
      const allowedIds = new Set((await applyShipmentAccessFilter(shipmentRows.map(mapShipment), req.user, req)).map(s => s.id));
      scopedRows = allRows.filter(r => allowedIds.has(r.shipment_id));
    }
    const rows = scopedRows.slice(off, off + lim);
    ok(res, { results: rows.map(mapCarrierInvoice), total: scopedRows.length, limit: lim, offset: off });
  });

  app.get("/api/carrier-invoices/:id", async (req, res) => {
    const [inv] = await query("SELECT * FROM carrier_invoices WHERE id=$1", [req.params.id]);
    if (!inv) return err(res, "Not found", 404);
    if (!(await loadScopedShipment(inv.shipment_id, req))) return err(res, "Not found", 404);
    const lines = await query("SELECT * FROM carrier_invoice_lines WHERE invoice_id=$1 ORDER BY sort_order", [req.params.id]);
    ok(res, { ...mapCarrierInvoice(inv), lines: lines.map(mapCarrierInvoiceLine) });
  });

  app.post("/api/carrier-invoices", invoiceWrite, async (req, res) => {
    const { shipmentId, carrierCode = "", invoiceNumber = "", invoiceDate = "", currency = "USD", notes = "", lines = [] } = req.body;
    if (!shipmentId) return err(res, "shipmentId required");
    const shipment = await loadScopedShipment(shipmentId, req);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (!lines.length) return err(res, "At least one invoice line is required");
    const id = `CINV-${uid()}`;
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    await query(`INSERT INTO carrier_invoices (id, shipment_id, carrier_code, invoice_number, invoice_date, currency, status, notes, created_at, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,'Pending',$7,$8,$9)`,
      [id, shipmentId, carrierCode.toUpperCase(), invoiceNumber, invoiceDate, currency.toUpperCase(), notes, now, actor]);
    for (let i = 0; i < lines.length; i++) {
      const computed = await computeLine(shipment, lines[i]);
      await insertLine(id, i, lines[i], computed);
    }
    const status = await recomputeInvoiceStatus(id);
    await logEntityEvent("carrier_invoice", id, "CREATED", null, null, null,
      JSON.stringify({ shipmentId, carrierCode, invoiceNumber, lineCount: lines.length }));
    const [inv] = await query("SELECT * FROM carrier_invoices WHERE id=$1", [id]);
    const savedLines = await query("SELECT * FROM carrier_invoice_lines WHERE invoice_id=$1 ORDER BY sort_order", [id]);
    ok(res, { ...mapCarrierInvoice({ ...inv, status }), lines: savedLines.map(mapCarrierInvoiceLine) }, 201);
  });

  app.delete("/api/carrier-invoices/:id", invoiceWrite, async (req, res) => {
    const [inv] = await query("SELECT * FROM carrier_invoices WHERE id=$1", [req.params.id]);
    if (!inv) return err(res, "Not found", 404);
    if (!(await loadScopedShipment(inv.shipment_id, req))) return err(res, "Not found", 404);
    const [{ n: approvedCount }] = await query("SELECT COUNT(*) AS n FROM carrier_invoice_lines WHERE invoice_id=$1 AND status='approved'", [req.params.id]);
    if (Number(approvedCount) > 0) return err(res, "This invoice has approved line(s) already posted to cost lines — dispute or leave it as a record instead of deleting");
    await query("DELETE FROM carrier_invoices WHERE id=$1", [req.params.id]);
    await logEntityEvent("carrier_invoice", req.params.id, "DELETED", null, null, null,
      JSON.stringify({ shipmentId: inv.shipment_id, carrierCode: inv.carrier_code, invoiceNumber: inv.invoice_number }));
    ok(res, { deleted: req.params.id });
  });

  // Re-runs the matching engine on every line without changing what the carrier actually billed —
  // useful after fixing a line's container link, or after a contract rate/cost line changed.
  app.post("/api/carrier-invoices/:id/rematch", invoiceWrite, async (req, res) => {
    const [inv] = await query("SELECT * FROM carrier_invoices WHERE id=$1", [req.params.id]);
    if (!inv) return err(res, "Not found", 404);
    const shipment = await loadScopedShipment(inv.shipment_id, req);
    if (!shipment) return err(res, "Not found", 404);
    const lines = await query("SELECT * FROM carrier_invoice_lines WHERE invoice_id=$1", [req.params.id]);
    for (const l of lines) {
      if (l.status === "approved" || l.status === "disputed") continue; // already resolved — don't silently reopen
      const computed = await computeLine(shipment, {
        serviceCode: l.service_code, containerId: l.container_id, freeTimeSide: l.free_time_side,
        amount: l.amount, currency: l.currency,
      });
      await query(`UPDATE carrier_invoice_lines SET
        expected_amount=$1, expected_currency=$2, expected_amount_usd=$3, expected_source=$4, matched_cost_line_id=$5,
        variance_usd=$6, variance_pct=$7, status=$8 WHERE id=$9`,
        [computed.expectedAmount, computed.expectedCurrency, computed.expectedAmountUsd, computed.expectedSource,
             computed.matchedCostLineId, computed.varianceUsd, computed.variancePct, computed.status, l.id]);
    }
    const status = await recomputeInvoiceStatus(req.params.id);
    const [inv2] = await query("SELECT * FROM carrier_invoices WHERE id=$1", [req.params.id]);
    const savedLines = await query("SELECT * FROM carrier_invoice_lines WHERE invoice_id=$1 ORDER BY sort_order", [req.params.id]);
    ok(res, { ...mapCarrierInvoice({ ...inv2, status }), lines: savedLines.map(mapCarrierInvoiceLine) });
  });

  // ─── Line resolution ────────────────────────────────────────────────────────

  app.post("/api/carrier-invoice-lines/:id/approve", approveGate, async (req, res) => {
    const [line] = await query("SELECT * FROM carrier_invoice_lines WHERE id=$1", [req.params.id]);
    if (!line) return err(res, "Not found", 404);
    const [inv] = await query("SELECT * FROM carrier_invoices WHERE id=$1", [line.invoice_id]);
    if (!inv || !(await loadScopedShipment(inv.shipment_id, req))) return err(res, "Not found", 404);
    if (line.status === "approved" || line.status === "disputed") return err(res, `Line already ${line.status}`, 409);
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    const exchangeRate = line.amount !== 0 ? line.amount_usd / line.amount : 1;

    if (line.matched_cost_line_id) {
      const [costLine] = await query("SELECT * FROM shipment_cost_lines WHERE id=$1", [line.matched_cost_line_id]);
      // The cost line matchLine() found was accrued at match time, but nothing stops it from being
      // independently actualized+posted before this invoice line gets approved — a realistic
      // ordering (the carrier's own invoice routinely arrives after a shipment's costs are already
      // closed out). Silently marking the invoice line "approved" here would drop the carrier's
      // real amount on the floor with no trace, since the posted cost line is correctly never
      // touched. Reject instead, matching this codebase's standing "posted lines are locked — add
      // an adjusting line" convention: the operator adds a new accrued BUY cost line for the
      // difference, hits Rematch (matchLine() only ever matches 'accrued' lines, so it picks up the
      // new one), then approves against that.
      if (costLine && costLine.status === "posted") {
        // Deliberately doesn't prescribe "add a line for the difference" — approving always writes
        // this invoice line's FULL amount as whatever cost line it ends up matched to, not an
        // incremental delta, so a naively-sized adjusting line here would double-count against the
        // already-posted actual. Left as a manual judgment call for whoever reconciles this.
        return err(res, "The matched cost line has already been posted and locked. Resolve this manually — add a new adjusting BUY cost line reflecting the real total owed, use Rematch to point this invoice line at it, then approve — rather than through this action.", 409);
      }
      if (costLine) {
        await query(`UPDATE shipment_cost_lines SET status='actualized', actual_amount=$1, actual_exchange_rate=$2, actualized_at=$3, actualized_by=$4 WHERE id=$5`,
          [line.amount, exchangeRate, now, actor, costLine.id]);
        await logEntityEvent("cost_line", costLine.id, "ACTUALIZED", "status", costLine.status, "actualized",
          JSON.stringify({ shipmentId: costLine.shipment_id, chargeCode: costLine.charge_code, source: "carrier_invoice", carrierInvoiceLineId: line.id }));
      }
    } else {
      const chargeCode = SERVICE_CODE_MAP[(line.service_code || "").toUpperCase()] || "Other";
      const costLineId = `CL-${uid()}`;
      const accrualAmount = line.expected_amount != null ? line.expected_amount : line.amount;
      await query(`INSERT INTO shipment_cost_lines
        (id, shipment_id, type, charge_code, currency, amount, exchange_rate, notes, created_at, container_id, source, status, actual_amount, actual_exchange_rate, actualized_at, actualized_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [costLineId, inv.shipment_id, "BUY", chargeCode, line.currency, accrualAmount, exchangeRate,
             line.description || "", now, line.container_id || "", "carrier_invoice", "actualized",
             line.amount, exchangeRate, now, actor]);
      await logEntityEvent("cost_line", costLineId, "IMPORTED", null, null, null,
        JSON.stringify({ shipmentId: inv.shipment_id, chargeCode, source: "carrier_invoice", carrierInvoiceLineId: line.id }));
      await query("UPDATE carrier_invoice_lines SET matched_cost_line_id=$1 WHERE id=$2", [costLineId, line.id]);
    }

    await query("UPDATE carrier_invoice_lines SET status='approved', resolved_at=$1, resolved_by=$2 WHERE id=$3", [now, actor, line.id]);
    await logEntityEvent("carrier_invoice_line", line.id, "APPROVED", "status", line.status, "approved",
      JSON.stringify({ invoiceId: line.invoice_id, serviceCode: line.service_code, amount: line.amount, expectedAmount: line.expected_amount }));
    await recomputeInvoiceStatus(line.invoice_id);
    const [fresh] = await query("SELECT * FROM carrier_invoice_lines WHERE id=$1", [line.id]);
    ok(res, mapCarrierInvoiceLine(fresh));
  });

  app.post("/api/carrier-invoice-lines/:id/dispute", invoiceWrite, async (req, res) => {
    const { reason = "" } = req.body || {};
    const [line] = await query("SELECT * FROM carrier_invoice_lines WHERE id=$1", [req.params.id]);
    if (!line) return err(res, "Not found", 404);
    const [inv] = await query("SELECT shipment_id FROM carrier_invoices WHERE id=$1", [line.invoice_id]);
    if (!inv || !(await loadScopedShipment(inv.shipment_id, req))) return err(res, "Not found", 404);
    if (line.status === "approved" || line.status === "disputed") return err(res, `Line already ${line.status}`, 409);
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    await query("UPDATE carrier_invoice_lines SET status='disputed', resolved_at=$1, resolved_by=$2, resolution_notes=$3 WHERE id=$4",
      [now, actor, reason, req.params.id]);
    await logEntityEvent("carrier_invoice_line", req.params.id, "DISPUTED", "status", line.status, "disputed",
      JSON.stringify({ invoiceId: line.invoice_id, serviceCode: line.service_code, reason }));
    await recomputeInvoiceStatus(line.invoice_id);
    const [fresh] = await query("SELECT * FROM carrier_invoice_lines WHERE id=$1", [req.params.id]);
    ok(res, mapCarrierInvoiceLine(fresh));
  });
};
