"use strict";

// CRM / pre-sales pipeline (TKT-WW8THL, Epic TKT-GTGM6R "Competitive Gap Analysis") — every
// competitor platform researched for that epic (CargoWise Opportunity Manager, Magaya CRM,
// Descartes' forwarder-purpose-built CRM) bundles a lead/opportunity-tracking layer ahead of the
// shipment lifecycle; CargoDesk's customers table is a trading-partner record, not a pipeline.
//
// Lifecycle: New -> Qualified -> Converted (to Quote, Qualified only) | Lost (from New or
// Qualified). Deliberately no separate "Won" status — Converted IS the win condition (the lead
// successfully produced a quote); whether that quote then actually closes is the Quote's own job
// from there, exactly the same "don't re-derive state a downstream entity already tracks" split
// this codebase already uses between Quotes (Draft..Converted) and the Shipment it produces.
//
// No line-item child table — an opportunity is pre-pricing; real line-item detail belongs on the
// Quote it converts into, same reasoning quote_lines exists but opportunities never gets its own
// equivalent.
module.exports = function opportunitiesRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, mapOpportunity, mapQuote, logEntityEvent, toUsd,
          resolveAssigneeNames } = ctx;

  const opportunityWrite = requireRole(["admin", "operator", "occ_bk"]);

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  app.get("/api/opportunities", (req, res) => {
    const { status = "", customerId = "", assigneeId = "", limit = "50", offset = "0" } = req.query;
    const clauses = [], params = [];
    if (status.trim()) { clauses.push("status=?"); params.push(status.trim()); }
    if (customerId.trim()) { clauses.push("customer_id=?"); params.push(customerId.trim()); }
    if (assigneeId.trim()) { clauses.push("assignee_id=?"); params.push(assigneeId.trim()); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM opportunities ${where}`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM opportunities ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: resolveAssigneeNames(rows.map(mapOpportunity)), total, limit: lim, offset: off });
  });

  app.get("/api/opportunities/:id", (req, res) => {
    const o = db.prepare("SELECT * FROM opportunities WHERE id=?").get(req.params.id);
    if (!o) return err(res, "Not found", 404);
    ok(res, resolveAssigneeNames([mapOpportunity(o)])[0]);
  });

  app.post("/api/opportunities", opportunityWrite, async (req, res) => {
    const { title = "", customerId = "", customerName = "", pol = "", pod = "", carrierCode = "",
            commodityCode = "", movementType = "FCL", estimatedValue = 0, currency = "USD",
            estimatedCloseDate = "", leadSource = "", assigneeId = "", notes = "" } = req.body || {};
    if (!title.trim()) return err(res, "title is required");
    const id = `OPP-${uid()}`;
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    const cur = (currency || "USD").toUpperCase();
    const estimatedValueUsd = await toUsd(Number(estimatedValue) || 0, cur);
    db.prepare(`INSERT INTO opportunities
      (id, status, title, customer_id, customer_name, pol, pod, carrier_code, commodity_code,
       movement_type, estimated_value, currency, estimated_value_usd, estimated_close_date,
       lead_source, assignee_id, notes, created_at, created_by)
      VALUES (?,'New',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, title.trim(), customerId, customerName, (pol || "").toUpperCase(), (pod || "").toUpperCase(),
           (carrierCode || "").toUpperCase(), commodityCode, movementType, Number(estimatedValue) || 0,
           cur, estimatedValueUsd, estimatedCloseDate, leadSource, assigneeId || "", notes, now, actor);
    await logEntityEvent("opportunity", id, "CREATED", null, null, null,
      JSON.stringify({ title: title.trim(), customerName, estimatedValue: Number(estimatedValue) || 0, currency: cur }));
    const o = db.prepare("SELECT * FROM opportunities WHERE id=?").get(id);
    ok(res, resolveAssigneeNames([mapOpportunity(o)])[0], 201);
  });

  app.put("/api/opportunities/:id", opportunityWrite, async (req, res) => {
    const existing = db.prepare("SELECT * FROM opportunities WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    if (!["New", "Qualified"].includes(existing.status))
      return err(res, `Only a New or Qualified opportunity can be edited (current status: ${existing.status})`, 409);
    const { title = "", customerId = "", customerName = "", pol = "", pod = "", carrierCode = "",
            commodityCode = "", movementType = "FCL", estimatedValue = 0, currency = "USD",
            estimatedCloseDate = "", leadSource = "", assigneeId = "", notes = "" } = req.body || {};
    if (!title.trim()) return err(res, "title is required");
    const cur = (currency || "USD").toUpperCase();
    const estimatedValueUsd = await toUsd(Number(estimatedValue) || 0, cur);
    db.prepare(`UPDATE opportunities SET title=?, customer_id=?, customer_name=?, pol=?, pod=?,
      carrier_code=?, commodity_code=?, movement_type=?, estimated_value=?, currency=?,
      estimated_value_usd=?, estimated_close_date=?, lead_source=?, assignee_id=?, notes=? WHERE id=?`)
      .run(title.trim(), customerId, customerName, (pol || "").toUpperCase(), (pod || "").toUpperCase(),
           (carrierCode || "").toUpperCase(), commodityCode, movementType, Number(estimatedValue) || 0,
           cur, estimatedValueUsd, estimatedCloseDate, leadSource, assigneeId || "", notes, req.params.id);
    await logEntityEvent("opportunity", req.params.id, "UPDATED", null, null, null,
      JSON.stringify({ title: title.trim(), customerName, estimatedValue: Number(estimatedValue) || 0, currency: cur }));
    const o = db.prepare("SELECT * FROM opportunities WHERE id=?").get(req.params.id);
    ok(res, resolveAssigneeNames([mapOpportunity(o)])[0]);
  });

  app.delete("/api/opportunities/:id", opportunityWrite, async (req, res) => {
    const o = db.prepare("SELECT * FROM opportunities WHERE id=?").get(req.params.id);
    if (!o) return err(res, "Not found", 404);
    if (o.status === "Converted") return err(res, "This opportunity has already converted to a quote — it stays as a historical record instead of being deleted");
    db.prepare("DELETE FROM opportunities WHERE id=?").run(req.params.id);
    await logEntityEvent("opportunity", req.params.id, "DELETED", null, null, null,
      JSON.stringify({ title: o.title, status: o.status }));
    ok(res, { deleted: req.params.id });
  });

  // ─── Lifecycle transitions ──────────────────────────────────────────────────

  app.post("/api/opportunities/:id/qualify", opportunityWrite, async (req, res) => {
    const o = db.prepare("SELECT * FROM opportunities WHERE id=?").get(req.params.id);
    if (!o) return err(res, "Not found", 404);
    if (o.status !== "New") return err(res, `Only a New opportunity can be qualified (current status: ${o.status})`, 409);
    const now = new Date().toISOString();
    db.prepare("UPDATE opportunities SET status='Qualified', qualified_at=? WHERE id=?").run(now, req.params.id);
    await logEntityEvent("opportunity", req.params.id, "UPDATED", "status", "New", "Qualified", JSON.stringify({ title: o.title }));
    ok(res, resolveAssigneeNames([mapOpportunity(db.prepare("SELECT * FROM opportunities WHERE id=?").get(req.params.id))])[0]);
  });

  app.post("/api/opportunities/:id/lose", opportunityWrite, async (req, res) => {
    const { reason = "" } = req.body || {};
    const o = db.prepare("SELECT * FROM opportunities WHERE id=?").get(req.params.id);
    if (!o) return err(res, "Not found", 404);
    if (!["New", "Qualified"].includes(o.status))
      return err(res, `Only a New or Qualified opportunity can be marked Lost (current status: ${o.status})`, 409);
    const now = new Date().toISOString();
    db.prepare("UPDATE opportunities SET status='Lost', lost_at=?, lost_reason=? WHERE id=?").run(now, reason, req.params.id);
    await logEntityEvent("opportunity", req.params.id, "UPDATED", "status", o.status, "Lost", JSON.stringify({ title: o.title, reason }));
    ok(res, resolveAssigneeNames([mapOpportunity(db.prepare("SELECT * FROM opportunities WHERE id=?").get(req.params.id))])[0]);
  });

  // Converts a Qualified opportunity into a real (Draft) quote — mirrors routes/quotes.js's own
  // POST /api/quotes/:id/convert exactly: only fields the source actually has are copied, every
  // other quotes column falls back to its own table-level DEFAULT. contractId/contractRef have no
  // opportunity equivalent and are deliberately left unset; incoterm/serviceType/cargoReadyDate
  // are likewise left at the quote's own defaults. estimatedCloseDate is deliberately NOT written
  // into quotes.cargo_ready_date -- "when we expect to close this deal" and "when cargo is ready
  // to ship" are unrelated concepts that happen to both be dates near a quote's creation.
  app.post("/api/opportunities/:id/convert", opportunityWrite, async (req, res) => {
    const o = db.prepare("SELECT * FROM opportunities WHERE id=?").get(req.params.id);
    if (!o) return err(res, "Not found", 404);
    if (o.status !== "Qualified") return err(res, `Only a Qualified opportunity can be converted (current status: ${o.status})`, 409);

    const quoteId = `QT-${uid()}`;
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    db.prepare(`INSERT INTO quotes
      (id, status, customer_id, customer_name, pol, pod, carrier_code, commodity_code,
       movement_type, notes, currency, created_at, created_by)
      VALUES (?,'Draft',?,?,?,?,?,?,?,?,?,?,?)`)
      .run(quoteId, o.customer_id, o.customer_name, o.pol, o.pod, o.carrier_code, o.commodity_code,
           o.movement_type, o.notes, o.currency, now, actor);
    await logEntityEvent("quote", quoteId, "CREATED", null, null, null,
      JSON.stringify({ customerName: o.customer_name, pol: o.pol, pod: o.pod, source: "opportunity", opportunityId: req.params.id }));

    db.prepare("UPDATE opportunities SET status='Converted', converted_quote_id=?, converted_at=? WHERE id=?")
      .run(quoteId, now, req.params.id);
    await logEntityEvent("opportunity", req.params.id, "UPDATED", "status", "Qualified", "Converted",
      JSON.stringify({ title: o.title, quoteId }));

    const quote = db.prepare("SELECT * FROM quotes WHERE id=?").get(quoteId);
    ok(res, {
      opportunity: resolveAssigneeNames([mapOpportunity(db.prepare("SELECT * FROM opportunities WHERE id=?").get(req.params.id))])[0],
      quoteId,
      quote: mapQuote(quote),
    });
  });
};
