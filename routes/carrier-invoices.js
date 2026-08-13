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
  const { db, ok, err, uid, requireRole, mapCarrierInvoice, mapCarrierInvoiceLine, mapCostLine,
          logEntityEvent, toUsd, SERVICE_CODE_MAP, getSettings, callContractService } = ctx;

  const invoiceWrite = requireRole(["admin", "operator", "occ_bk"]);
  // Same tier as routes/shipment-ops.js's postGate — approving a line writes/actualizes a real
  // cost line, the same class of action as posting one.
  const approveGate = requireRole(["admin", "operator"]);

  const INVOICE_STATUSES = ["Pending", "Reconciled", "Approved", "Disputed"];
  const LINE_STATUSES = ["pending", "matched", "variance", "approved", "disputed"];

  // ─── Matching engine ────────────────────────────────────────────────────────

  // Resolves the contract's current rates, respecting the contract_source toggle exactly like
  // createRateSnapshot (server.js) does — 'remote' mode fetches from the standalone Contract
  // Management Service instead of the local contract_rates table.
  async function loadContractRates(contractId) {
    if ((getSettings().contract_source || "local") === "remote") {
      try { return (await callContractService("GET", `/internal/contracts/${contractId}`)).rates.map(r => ({
        service_code: r.serviceCode || "", amount: r.amount, currency: r.currency || "USD",
        amount_usd: r.amountUsd, unit: r.unit || "per_container", container_type: r.containerType || "",
        routing_id: r.routingId || "",
      })); }
      catch { return []; }
    }
    return db.prepare("SELECT service_code, amount, currency, amount_usd, unit, container_type, routing_id FROM contract_rates WHERE contract_id=?").all(contractId);
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
    if (line.containerId && line.freeTimeSide && (serviceCode === "DET" || serviceCode === "DEM")) {
      const container = db.prepare("SELECT * FROM containers WHERE id=? AND shipment_id=?").get(line.containerId, shipment.id);
      if (!container) return noMatch;
      const events = db.prepare("SELECT event_type, occurred_at FROM container_events WHERE container_id=? ORDER BY occurred_at ASC").all(line.containerId);
      const byType = {};
      for (const e of events) byType[e.event_type] = e.occurred_at;
      const isOrigin = line.freeTimeSide === "origin";
      const freeDays = isOrigin ? container.origin_free_time_days : container.dest_free_time_days;
      const startAt = isOrigin ? byType["Gate In"] : byType["Discharged"];
      const closeAt = isOrigin ? byType["Sailed"] : byType["Gate Out"];
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
    const costLine = db.prepare(`
      SELECT * FROM shipment_cost_lines
      WHERE shipment_id=? AND type='BUY' AND status='accrued' AND charge_code=? AND (container_id=? OR container_id='')
      ORDER BY (container_id=?) DESC, created_at ASC LIMIT 1
    `).get(shipment.id, chargeCode, line.containerId || "", line.containerId || "");
    if (costLine) {
      return {
        expectedAmount: costLine.amount, expectedCurrency: costLine.currency,
        expectedAmountUsd: costLine.amount * costLine.exchange_rate, expectedSource: "cost_line",
        matchedCostLineId: costLine.id,
      };
    }

    if (!shipment.contract_id) return noMatch;
    const rates = await loadContractRates(shipment.contract_id);
    const container = line.containerId ? db.prepare("SELECT size, type FROM containers WHERE id=?").get(line.containerId) : null;
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
      const tolerancePct = Math.abs(Number(getSettings().fap_variance_tolerance_pct) || 2);
      status = (variancePct != null && Math.abs(variancePct) <= tolerancePct) ? "matched" : "variance";
    }
    return { ...match, amountUsd, varianceUsd, variancePct, status };
  }

  function recomputeInvoiceStatus(invoiceId) {
    const lines = db.prepare("SELECT status FROM carrier_invoice_lines WHERE invoice_id=?").all(invoiceId);
    let status = "Reconciled";
    if (lines.some(l => l.status === "disputed")) status = "Disputed";
    else if (lines.some(l => l.status === "pending" || l.status === "variance")) status = "Pending";
    else if (lines.length > 0 && lines.every(l => l.status === "approved")) status = "Approved";
    db.prepare("UPDATE carrier_invoices SET status=? WHERE id=?").run(status, invoiceId);
    return status;
  }

  function insertLine(invoiceId, sortIndex, line, computed) {
    const id = `CINL-${uid()}`;
    db.prepare(`INSERT INTO carrier_invoice_lines
      (id, invoice_id, service_code, description, container_id, free_time_side, amount, currency, amount_usd,
       expected_amount, expected_currency, expected_amount_usd, expected_source, matched_cost_line_id,
       variance_usd, variance_pct, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, invoiceId, line.serviceCode || "", line.description || "", line.containerId || "", line.freeTimeSide || "",
           line.amount || 0, line.currency || "USD", computed.amountUsd,
           computed.expectedAmount, computed.expectedCurrency, computed.expectedAmountUsd, computed.expectedSource,
           computed.matchedCostLineId, computed.varianceUsd, computed.variancePct, computed.status);
    return id;
  }

  // ─── Exception queue — MUST be before /:id ─────────────────────────────────
  app.get("/api/carrier-invoices/exceptions", (req, res) => {
    const rows = db.prepare(`
      SELECT l.*, i.shipment_id, i.carrier_code, i.invoice_number, i.invoice_date, i.currency AS invoice_currency
      FROM carrier_invoice_lines l JOIN carrier_invoices i ON i.id = l.invoice_id
      WHERE l.status IN ('pending','variance')
      ORDER BY ABS(COALESCE(l.variance_usd, 0)) DESC
    `).all();
    ok(res, rows.map(r => ({
      ...mapCarrierInvoiceLine(r),
      shipmentId: r.shipment_id, carrierCode: r.carrier_code || "",
      invoiceNumber: r.invoice_number || "", invoiceDate: r.invoice_date || "",
    })));
  });

  app.get("/api/carrier-invoices", (req, res) => {
    const { shipmentId = "", carrierCode = "", status = "", limit = "50", offset = "0" } = req.query;
    const clauses = [], params = [];
    if (shipmentId.trim()) { clauses.push("shipment_id=?"); params.push(shipmentId.trim()); }
    if (carrierCode.trim()) { clauses.push("carrier_code=?"); params.push(carrierCode.trim().toUpperCase()); }
    if (status.trim()) { clauses.push("status=?"); params.push(status.trim()); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM carrier_invoices ${where}`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM carrier_invoices ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapCarrierInvoice), total, limit: lim, offset: off });
  });

  app.get("/api/carrier-invoices/:id", (req, res) => {
    const inv = db.prepare("SELECT * FROM carrier_invoices WHERE id=?").get(req.params.id);
    if (!inv) return err(res, "Not found", 404);
    const lines = db.prepare("SELECT * FROM carrier_invoice_lines WHERE invoice_id=? ORDER BY rowid").all(req.params.id);
    ok(res, { ...mapCarrierInvoice(inv), lines: lines.map(mapCarrierInvoiceLine) });
  });

  app.post("/api/carrier-invoices", invoiceWrite, async (req, res) => {
    const { shipmentId, carrierCode = "", invoiceNumber = "", invoiceDate = "", currency = "USD", notes = "", lines = [] } = req.body;
    if (!shipmentId) return err(res, "shipmentId required");
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(shipmentId);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (!lines.length) return err(res, "At least one invoice line is required");
    const id = `CINV-${uid()}`;
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    db.prepare(`INSERT INTO carrier_invoices (id, shipment_id, carrier_code, invoice_number, invoice_date, currency, status, notes, created_at, created_by)
      VALUES (?,?,?,?,?,?,'Pending',?,?,?)`)
      .run(id, shipmentId, carrierCode.toUpperCase(), invoiceNumber, invoiceDate, currency.toUpperCase(), notes, now, actor);
    for (let i = 0; i < lines.length; i++) {
      const computed = await computeLine(shipment, lines[i]);
      insertLine(id, i, lines[i], computed);
    }
    const status = recomputeInvoiceStatus(id);
    logEntityEvent("carrier_invoice", id, "CREATED", null, null, null,
      JSON.stringify({ shipmentId, carrierCode, invoiceNumber, lineCount: lines.length }));
    const inv = db.prepare("SELECT * FROM carrier_invoices WHERE id=?").get(id);
    const savedLines = db.prepare("SELECT * FROM carrier_invoice_lines WHERE invoice_id=? ORDER BY rowid").all(id);
    ok(res, { ...mapCarrierInvoice({ ...inv, status }), lines: savedLines.map(mapCarrierInvoiceLine) }, 201);
  });

  app.delete("/api/carrier-invoices/:id", invoiceWrite, (req, res) => {
    const inv = db.prepare("SELECT * FROM carrier_invoices WHERE id=?").get(req.params.id);
    if (!inv) return err(res, "Not found", 404);
    const approvedCount = db.prepare("SELECT COUNT(*) AS n FROM carrier_invoice_lines WHERE invoice_id=? AND status='approved'").get(req.params.id).n;
    if (approvedCount > 0) return err(res, "This invoice has approved line(s) already posted to cost lines — dispute or leave it as a record instead of deleting");
    db.prepare("DELETE FROM carrier_invoices WHERE id=?").run(req.params.id);
    logEntityEvent("carrier_invoice", req.params.id, "DELETED", null, null, null,
      JSON.stringify({ shipmentId: inv.shipment_id, carrierCode: inv.carrier_code, invoiceNumber: inv.invoice_number }));
    ok(res, { deleted: req.params.id });
  });

  // Re-runs the matching engine on every line without changing what the carrier actually billed —
  // useful after fixing a line's container link, or after a contract rate/cost line changed.
  app.post("/api/carrier-invoices/:id/rematch", invoiceWrite, async (req, res) => {
    const inv = db.prepare("SELECT * FROM carrier_invoices WHERE id=?").get(req.params.id);
    if (!inv) return err(res, "Not found", 404);
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(inv.shipment_id);
    const lines = db.prepare("SELECT * FROM carrier_invoice_lines WHERE invoice_id=?").all(req.params.id);
    for (const l of lines) {
      if (l.status === "approved" || l.status === "disputed") continue; // already resolved — don't silently reopen
      const computed = await computeLine(shipment, {
        serviceCode: l.service_code, containerId: l.container_id, freeTimeSide: l.free_time_side,
        amount: l.amount, currency: l.currency,
      });
      db.prepare(`UPDATE carrier_invoice_lines SET
        expected_amount=?, expected_currency=?, expected_amount_usd=?, expected_source=?, matched_cost_line_id=?,
        variance_usd=?, variance_pct=?, status=? WHERE id=?`)
        .run(computed.expectedAmount, computed.expectedCurrency, computed.expectedAmountUsd, computed.expectedSource,
             computed.matchedCostLineId, computed.varianceUsd, computed.variancePct, computed.status, l.id);
    }
    const status = recomputeInvoiceStatus(req.params.id);
    const inv2 = db.prepare("SELECT * FROM carrier_invoices WHERE id=?").get(req.params.id);
    const savedLines = db.prepare("SELECT * FROM carrier_invoice_lines WHERE invoice_id=? ORDER BY rowid").all(req.params.id);
    ok(res, { ...mapCarrierInvoice({ ...inv2, status }), lines: savedLines.map(mapCarrierInvoiceLine) });
  });

  // ─── Line resolution ────────────────────────────────────────────────────────

  app.post("/api/carrier-invoice-lines/:id/approve", approveGate, (req, res) => {
    const line = db.prepare("SELECT * FROM carrier_invoice_lines WHERE id=?").get(req.params.id);
    if (!line) return err(res, "Not found", 404);
    if (line.status === "approved" || line.status === "disputed") return err(res, `Line already ${line.status}`, 409);
    const inv = db.prepare("SELECT * FROM carrier_invoices WHERE id=?").get(line.invoice_id);
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    const exchangeRate = line.amount !== 0 ? line.amount_usd / line.amount : 1;

    if (line.matched_cost_line_id) {
      const costLine = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=?").get(line.matched_cost_line_id);
      if (costLine && costLine.status !== "posted") {
        db.prepare(`UPDATE shipment_cost_lines SET status='actualized', actual_amount=?, actual_exchange_rate=?, actualized_at=?, actualized_by=? WHERE id=?`)
          .run(line.amount, exchangeRate, now, actor, costLine.id);
        logEntityEvent("cost_line", costLine.id, "ACTUALIZED", "status", costLine.status, "actualized",
          JSON.stringify({ shipmentId: costLine.shipment_id, chargeCode: costLine.charge_code, source: "carrier_invoice", carrierInvoiceLineId: line.id }));
      }
    } else {
      const chargeCode = SERVICE_CODE_MAP[(line.service_code || "").toUpperCase()] || "Other";
      const costLineId = `CL-${uid()}`;
      const accrualAmount = line.expected_amount != null ? line.expected_amount : line.amount;
      db.prepare(`INSERT INTO shipment_cost_lines
        (id, shipment_id, type, charge_code, currency, amount, exchange_rate, notes, created_at, container_id, source, status, actual_amount, actual_exchange_rate, actualized_at, actualized_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(costLineId, inv.shipment_id, "BUY", chargeCode, line.currency, accrualAmount, exchangeRate,
             line.description || "", now, line.container_id || "", "carrier_invoice", "actualized",
             line.amount, exchangeRate, now, actor);
      logEntityEvent("cost_line", costLineId, "IMPORTED", null, null, null,
        JSON.stringify({ shipmentId: inv.shipment_id, chargeCode, source: "carrier_invoice", carrierInvoiceLineId: line.id }));
      db.prepare("UPDATE carrier_invoice_lines SET matched_cost_line_id=? WHERE id=?").run(costLineId, line.id);
    }

    db.prepare("UPDATE carrier_invoice_lines SET status='approved', resolved_at=?, resolved_by=? WHERE id=?").run(now, actor, line.id);
    logEntityEvent("carrier_invoice_line", line.id, "APPROVED", "status", line.status, "approved",
      JSON.stringify({ invoiceId: line.invoice_id, serviceCode: line.service_code, amount: line.amount, expectedAmount: line.expected_amount }));
    recomputeInvoiceStatus(line.invoice_id);
    ok(res, mapCarrierInvoiceLine(db.prepare("SELECT * FROM carrier_invoice_lines WHERE id=?").get(line.id)));
  });

  app.post("/api/carrier-invoice-lines/:id/dispute", invoiceWrite, (req, res) => {
    const { reason = "" } = req.body || {};
    const line = db.prepare("SELECT * FROM carrier_invoice_lines WHERE id=?").get(req.params.id);
    if (!line) return err(res, "Not found", 404);
    if (line.status === "approved" || line.status === "disputed") return err(res, `Line already ${line.status}`, 409);
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    db.prepare("UPDATE carrier_invoice_lines SET status='disputed', resolved_at=?, resolved_by=?, resolution_notes=? WHERE id=?")
      .run(now, actor, reason, req.params.id);
    logEntityEvent("carrier_invoice_line", req.params.id, "DISPUTED", "status", line.status, "disputed",
      JSON.stringify({ invoiceId: line.invoice_id, serviceCode: line.service_code, reason }));
    recomputeInvoiceStatus(line.invoice_id);
    ok(res, mapCarrierInvoiceLine(db.prepare("SELECT * FROM carrier_invoice_lines WHERE id=?").get(req.params.id)));
  });
};
