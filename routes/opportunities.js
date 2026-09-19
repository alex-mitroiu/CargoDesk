"use strict";

const { applyColumnFilters, filterOptions, applySearch, applySort, paginate, blanksLast } = require("../lib/tableQuery");

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
  const { query, ok, err, uid, requireRole, mapOpportunity, mapQuote, logEntityEvent, toUsd,
          resolveAssigneeNames, applyOfficeScopedAccessFilter } = ctx;

  // sales (User Management redesign, 2026-09-12) owns the pipeline this file manages.
  const opportunityWrite = requireRole(["admin", "operator", "occ_bk", "sales"]);

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  // Filtered, searched, sorted and paginated in JS, after the office/scope access filter — see
  // routes/quotes.js's own GET /api/quotes for the full rationale (matches routes/shipments.js's
  // precedent), and lib/tableQuery.js for the shared semantics (repeated params, empty = show nothing).
  //
  // Column → the value the Opportunities table shows and filters on. ONE definition feeds both the
  // list's column filters and /filter-options, so a header checklist can never offer a value the
  // filter doesn't understand.
  const OPP_COLUMNS = {
    id:        o => o.id,
    title:     o => o.title,
    customer:  o => o.customerName,
    closeDate: o => o.estimatedCloseDate,
    assignee:  o => o.assigneeName,
    status:    o => o.status,
  };
  const oppSearchText = o =>
    [o.id, o.title, o.customerName, o.assigneeName, o.pol, o.pod, o.carrierCode, o.commodityCode, o.leadSource, o.notes].join(" ");
  // The SQL already returns newest-first (ORDER BY created_at DESC), which is the default and needs
  // no entry here.
  const OPP_SORTERS = {
    oldest:    (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)),
    closeDate: blanksLast(o => o.estimatedCloseDate),
    customer:  blanksLast(o => o.customerName),
    value:     (a, b) => (b.estimatedValueUsd || 0) - (a.estimatedValueUsd || 0),
  };

  const loadVisibleOpportunities = async (req, where = "", params = []) => {
    const rows = await query(`SELECT * FROM opportunities ${where} ORDER BY created_at DESC`, params);
    return applyOfficeScopedAccessFilter(await resolveAssigneeNames(rows.map(mapOpportunity)), req.user, req);
  };

  // `status` used to be a single SQL equality and now goes through the shared column filter with
  // every other column (so ?status=Converted, still used by tests/opportunities.test.js, behaves
  // exactly as before, and ?status=New&status=Qualified works too). customerId and assigneeId stay
  // in SQL — they aren't table columns, they're the "opportunities for this customer / person"
  // scopes other pages pass in. The Dashboard's pipeline card passes only `limit`, so it is unaffected.
  app.get("/api/opportunities", async (req, res) => {
    const { customerId = "", assigneeId = "", search = "", sort = "" } = req.query;
    const clauses = [], params = [];
    const p = v => { params.push(v); return `$${params.length}`; };
    if (String(customerId).trim()) clauses.push(`customer_id=${p(String(customerId).trim())}`);
    if (String(assigneeId).trim()) clauses.push(`assignee_id=${p(String(assigneeId).trim())}`);
    const visible = await loadVisibleOpportunities(req, clauses.length ? "WHERE " + clauses.join(" AND ") : "", params);
    let rows = applyColumnFilters(visible, req.query, OPP_COLUMNS);
    rows = applySearch(rows, search, oppSearchText);
    rows = applySort(rows, sort, OPP_SORTERS);
    ok(res, paginate(rows, req.query));
  });

  // Checklist source for each column header's filter — MUST be registered before
  // /api/opportunities/:id (Express matches in registration order; :id would swallow
  // "filter-options" as an id). Built from the caller's whole visible set, deliberately ignoring the
  // list's own filters/paging, so a value just unchecked stays selectable.
  app.get("/api/opportunities/filter-options", async (req, res) => {
    ok(res, filterOptions(await loadVisibleOpportunities(req), OPP_COLUMNS));
  });

  app.get("/api/opportunities/:id", async (req, res) => {
    const [o] = await query("SELECT * FROM opportunities WHERE id=$1", [req.params.id]);
    if (!o) return err(res, "Not found", 404);
    if (!(await applyOfficeScopedAccessFilter([mapOpportunity(o)], req.user, req)).length) return err(res, "Not found", 404);
    ok(res, (await resolveAssigneeNames([mapOpportunity(o)]))[0]);
  });

  app.post("/api/opportunities", opportunityWrite, async (req, res) => {
    const { title = "", customerId = "", customerName = "", pol = "", pod = "", carrierCode = "",
            commodityCode = "", movementType = "FCL", estimatedValue = 0, currency = "USD",
            estimatedCloseDate = "", leadSource = "", assigneeId = "", officeId = "", notes = "" } = req.body || {};
    if (!title.trim()) return err(res, "title is required");
    const id = `OPP-${uid()}`;
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    const cur = (currency || "USD").toUpperCase();
    const estimatedValueUsd = await toUsd(Number(estimatedValue) || 0, cur);
    await query(`INSERT INTO opportunities
      (id, status, title, customer_id, customer_name, pol, pod, carrier_code, commodity_code,
       movement_type, estimated_value, currency, estimated_value_usd, estimated_close_date,
       lead_source, assignee_id, office_id, notes, created_at, created_by)
      VALUES ($1,'New',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, title.trim(), customerId, customerName, (pol || "").toUpperCase(), (pod || "").toUpperCase(),
           (carrierCode || "").toUpperCase(), commodityCode, movementType, Number(estimatedValue) || 0,
           cur, estimatedValueUsd, estimatedCloseDate, leadSource, assigneeId || "", officeId || null, notes, now, actor]);
    await logEntityEvent("opportunity", id, "CREATED", null, null, null,
      JSON.stringify({ title: title.trim(), customerName, estimatedValue: Number(estimatedValue) || 0, currency: cur }));
    const [o] = await query("SELECT * FROM opportunities WHERE id=$1", [id]);
    ok(res, (await resolveAssigneeNames([mapOpportunity(o)]))[0], 201);
  });

  app.put("/api/opportunities/:id", opportunityWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM opportunities WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    if (!["New", "Qualified"].includes(existing.status))
      return err(res, `Only a New or Qualified opportunity can be edited (current status: ${existing.status})`, 409);
    const { title = "", customerId = "", customerName = "", pol = "", pod = "", carrierCode = "",
            commodityCode = "", movementType = "FCL", estimatedValue = 0, currency = "USD",
            estimatedCloseDate = "", leadSource = "", assigneeId = "", officeId = "", notes = "" } = req.body || {};
    if (!title.trim()) return err(res, "title is required");
    const cur = (currency || "USD").toUpperCase();
    const estimatedValueUsd = await toUsd(Number(estimatedValue) || 0, cur);
    await query(`UPDATE opportunities SET title=$1, customer_id=$2, customer_name=$3, pol=$4, pod=$5,
      carrier_code=$6, commodity_code=$7, movement_type=$8, estimated_value=$9, currency=$10,
      estimated_value_usd=$11, estimated_close_date=$12, lead_source=$13, assignee_id=$14, office_id=$15, notes=$16 WHERE id=$17`,
      [title.trim(), customerId, customerName, (pol || "").toUpperCase(), (pod || "").toUpperCase(),
           (carrierCode || "").toUpperCase(), commodityCode, movementType, Number(estimatedValue) || 0,
           cur, estimatedValueUsd, estimatedCloseDate, leadSource, assigneeId || "", officeId || null, notes, req.params.id]);
    await logEntityEvent("opportunity", req.params.id, "UPDATED", null, null, null,
      JSON.stringify({ title: title.trim(), customerName, estimatedValue: Number(estimatedValue) || 0, currency: cur }));
    const [o] = await query("SELECT * FROM opportunities WHERE id=$1", [req.params.id]);
    ok(res, (await resolveAssigneeNames([mapOpportunity(o)]))[0]);
  });

  app.delete("/api/opportunities/:id", opportunityWrite, async (req, res) => {
    const [o] = await query("SELECT * FROM opportunities WHERE id=$1", [req.params.id]);
    if (!o) return err(res, "Not found", 404);
    if (o.status === "Converted") return err(res, "This opportunity has already converted to a quote — it stays as a historical record instead of being deleted");
    await query("DELETE FROM opportunities WHERE id=$1", [req.params.id]);
    await logEntityEvent("opportunity", req.params.id, "DELETED", null, null, null,
      JSON.stringify({ title: o.title, status: o.status }));
    ok(res, { deleted: req.params.id });
  });

  // ─── Lifecycle transitions ──────────────────────────────────────────────────

  app.post("/api/opportunities/:id/qualify", opportunityWrite, async (req, res) => {
    const [o] = await query("SELECT * FROM opportunities WHERE id=$1", [req.params.id]);
    if (!o) return err(res, "Not found", 404);
    if (o.status !== "New") return err(res, `Only a New opportunity can be qualified (current status: ${o.status})`, 409);
    const now = new Date().toISOString();
    await query("UPDATE opportunities SET status='Qualified', qualified_at=$1 WHERE id=$2", [now, req.params.id]);
    await logEntityEvent("opportunity", req.params.id, "UPDATED", "status", "New", "Qualified", JSON.stringify({ title: o.title }));
    const [fresh] = await query("SELECT * FROM opportunities WHERE id=$1", [req.params.id]);
    ok(res, (await resolveAssigneeNames([mapOpportunity(fresh)]))[0]);
  });

  app.post("/api/opportunities/:id/lose", opportunityWrite, async (req, res) => {
    const { reason = "" } = req.body || {};
    const [o] = await query("SELECT * FROM opportunities WHERE id=$1", [req.params.id]);
    if (!o) return err(res, "Not found", 404);
    if (!["New", "Qualified"].includes(o.status))
      return err(res, `Only a New or Qualified opportunity can be marked Lost (current status: ${o.status})`, 409);
    const now = new Date().toISOString();
    await query("UPDATE opportunities SET status='Lost', lost_at=$1, lost_reason=$2 WHERE id=$3", [now, reason, req.params.id]);
    await logEntityEvent("opportunity", req.params.id, "UPDATED", "status", o.status, "Lost", JSON.stringify({ title: o.title, reason }));
    const [fresh] = await query("SELECT * FROM opportunities WHERE id=$1", [req.params.id]);
    ok(res, (await resolveAssigneeNames([mapOpportunity(fresh)]))[0]);
  });

  // Converts a Qualified opportunity into a real (Draft) quote — mirrors routes/quotes.js's own
  // POST /api/quotes/:id/convert exactly: only fields the source actually has are copied, every
  // other quotes column falls back to its own table-level DEFAULT. contractId/contractRef have no
  // opportunity equivalent and are deliberately left unset; incoterm/serviceType/cargoReadyDate
  // are likewise left at the quote's own defaults. estimatedCloseDate is deliberately NOT written
  // into quotes.cargo_ready_date -- "when we expect to close this deal" and "when cargo is ready
  // to ship" are unrelated concepts that happen to both be dates near a quote's creation.
  // source_opportunity_id and a pre-populated quote_lines row from estimated_value (2026-09
  // gap-closing pass) — previously the opportunity's own value estimate was silently dropped and
  // nothing on the quote pointed back to where it came from.
  app.post("/api/opportunities/:id/convert", opportunityWrite, async (req, res) => {
    const [o] = await query("SELECT * FROM opportunities WHERE id=$1", [req.params.id]);
    if (!o) return err(res, "Not found", 404);
    if (o.status !== "Qualified") return err(res, `Only a Qualified opportunity can be converted (current status: ${o.status})`, 409);

    const quoteId = `QT-${uid()}`;
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    await query(`INSERT INTO quotes
      (id, status, customer_id, customer_name, pol, pod, carrier_code, commodity_code,
       movement_type, notes, currency, source_opportunity_id, office_id, created_at, created_by)
      VALUES ($1,'Draft',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [quoteId, o.customer_id, o.customer_name, o.pol, o.pod, o.carrier_code, o.commodity_code,
           o.movement_type, o.notes, o.currency, req.params.id, o.office_id || null, now, actor]);
    if (Number(o.estimated_value) > 0) {
      await query(`INSERT INTO quote_lines
        (id, quote_id, service_code, description, quantity, unit, rate, currency, amount_usd, sort_order)
        VALUES ($1,$2,'FRT',$3,1,'lump_sum',$4,$5,$6,0)`,
        [`QTL-${uid()}`, quoteId, `Estimated value carried over from Opportunity ${req.params.id}`,
             o.estimated_value, o.currency || 'USD', o.estimated_value_usd || 0]);
      await query("UPDATE quotes SET total_amount_usd=$1 WHERE id=$2", [o.estimated_value_usd || 0, quoteId]);
    }
    await logEntityEvent("quote", quoteId, "CREATED", null, null, null,
      JSON.stringify({ customerName: o.customer_name, pol: o.pol, pod: o.pod, source: "opportunity", opportunityId: req.params.id }));

    await query("UPDATE opportunities SET status='Converted', converted_quote_id=$1, converted_at=$2 WHERE id=$3",
      [quoteId, now, req.params.id]);
    await logEntityEvent("opportunity", req.params.id, "UPDATED", "status", "Qualified", "Converted",
      JSON.stringify({ title: o.title, quoteId }));

    const [quote] = await query("SELECT * FROM quotes WHERE id=$1", [quoteId]);
    const [freshOpp] = await query("SELECT * FROM opportunities WHERE id=$1", [req.params.id]);
    ok(res, {
      opportunity: (await resolveAssigneeNames([mapOpportunity(freshOpp)]))[0],
      quoteId,
      quote: mapQuote(quote),
    });
  });
};
