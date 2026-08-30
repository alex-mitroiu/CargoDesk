"use strict";

module.exports = function customersRoutes(app, ctx) {
  const { db, ok, err, uid, auth, requireRole,
          mapCustomer, mapCustomerIdentifier, mapCustomerScreening, mapCustomerDoc, mapCustomerContact,
          screenShipmentById,
          sanctionsMap, normSanctionName,
          getFxRates, fxCache, getSettings, callCustomerService, getCustomerRow,
          validCoord, roundCents, toUsd, resolveCustomerGroup,
          computeArExposure, matchesScopeItem, userOwnsLaneForShipment, userOwnsLaneForCustomer,
          OVERRIDE_GRACE_MS, logEntityEvent,
          UPLOADS_DIR, fs, path } = ctx;

  // 'local' (default) = every route below runs against this monolith's own tables, exactly as
  // before this cut. 'remote' = the standalone Customer Service (services/customers/), reached
  // through callCustomerService — same one-way-toggle shape routes/contracts.js/mdm.js/
  // sanctions.js/kanban.js already established. customer_documents and customer_roles are
  // deliberately NOT part of this toggle (see ARCHITECTURE.md §8.1) — their routes stay local
  // unconditionally, regardless of customer_source.
  const isRemote = async () => ((await getSettings()).customer_source || "local") === "remote";

  // Country -> currency default (TKT-O5I4NK) — deliberately scoped to only the currencies this
  // app's own credit/billing currency picker already offers (CURRENCIES, MdmCustomersPage.jsx),
  // not a full ISO 4217/world map: suggesting a currency the picker can't even render would be
  // worse than no suggestion. A country with no entry here just keeps today's plain 'USD'
  // fallback — never a broken/blank dropdown value.
  const COUNTRY_TO_CURRENCY = {
    US: "USD",
    GB: "GBP",
    CN: "CNY", HK: "CNY",
    SG: "SGD",
    JP: "JPY",
    AE: "AED",
    CH: "CHF", LI: "CHF",
    // Eurozone
    DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", BE: "EUR", PT: "EUR",
    AT: "EUR", IE: "EUR", FI: "EUR", GR: "EUR", LU: "EUR", SI: "EUR", SK: "EUR",
    EE: "EUR", LV: "EUR", LT: "EUR", MT: "EUR", CY: "EUR", HR: "EUR",
  };

  // Mirrors MdmContractsPage/MdmCustomersPage's own "full CRUD for trade_manager alongside
  // admin/operator" MDM-write tier (routes/contracts.js, routes/allocations.js) — customer
  // master-data management, which this compliance override is part of, sits at that tier, not
  // shipment operational writes. This file had NO role-gated route at all before this pass
  // (grepped — zero requireRole usage anywhere in customers.js); scoped here to just the
  // screening-override route since that's the specific gap flagged, not a full-file audit.
  const customerWrite = requireRole(["admin", "operator", "trade_manager"]);

  // Organization Model Enhancement Epic 3 — customer-level and shipment-level screening
  // previously never cross-referenced: a customer flagged HIT here stayed invisible on any
  // shipment referencing it until that shipment was independently edited (which re-derives by
  // name-match anyway, just lazily). Now screenCustomer() immediately re-screens every shipment
  // that references this customer via any of its 13 possible party slots — the 4 fixed FK
  // columns plus shipment_parties — so a HIT propagates the moment it's discovered, not later.
  // shipments/shipment_parties are permanently monolith-owned regardless of customer_source, so
  // this lookup never needs a toggle branch of its own — only the screenShipmentById it drives.
  async function rescreenShipmentsForCustomer(customerId) {
    const ids = new Set([
      ...db.prepare("SELECT id FROM shipments WHERE shipper_id=? OR consignee_id=? OR principal_id=? OR notify_id=?")
        .all(customerId, customerId, customerId, customerId).map(r => r.id),
      ...db.prepare("SELECT DISTINCT shipment_id AS id FROM shipment_parties WHERE customer_id=?")
        .all(customerId).map(r => r.id),
    ]);
    for (const shipmentId of ids) {
      const prev = db.prepare("SELECT result, overridden_at FROM shipment_screenings WHERE shipment_id=?").get(shipmentId);
      const isOverridden = prev?.result === 'CLEAR' && prev?.overridden_at;
      if (!isOverridden) await screenShipmentById(shipmentId);
    }
  }

  // Screen a customer against the loaded sanctions map and persist the result. The MATCH decision
  // itself can never move into the Customer Service (it depends on sanctionsMap, monolith-owned)
  // — but the customer row being matched against must come through getCustomerRow, same as every
  // other customer read in this cut, or a customer created after a remote cutover would never be
  // found here at all. Only the already-decided result's WRITE branches on customer_source.
  async function screenCustomer(customerId) {
    const c = await getCustomerRow(customerId);
    if (!c) return null;
    const match  = sanctionsMap.get(normSanctionName(c.companyName || ''));
    const result = match ? "HIT" : "CLEAR";
    const hits   = match ? [{ entityName: match.entityName, program: match.program, source: match.source }] : [];
    const now    = new Date().toISOString();
    let screening;
    if (await isRemote()) {
      screening = await callCustomerService("PUT", `/internal/customers/${customerId}/screening`, { result, hits, screenedAt: now });
    } else {
      const id = `CSC-${uid()}`;
      db.prepare(`INSERT INTO customer_screenings (id,customer_id,screened_at,result,hits)
        VALUES (?,?,?,?,?)
        ON CONFLICT(customer_id) DO UPDATE SET
          screened_at=excluded.screened_at, result=excluded.result,
          hits=excluded.hits, overridden_at=NULL, override_reason=NULL`)
        .run(id, customerId, now, result, JSON.stringify(hits));
      const row = db.prepare("SELECT * FROM customer_screenings WHERE customer_id=?").get(customerId);
      screening = mapCustomerScreening(row);
    }
    await rescreenShipmentsForCustomer(customerId);
    return screening;
  }

  const CUST_JOIN = `SELECT c.*, cs.result AS screening_result, pc.company_name AS parent_customer_name
    FROM customers c
    LEFT JOIN customer_screenings cs ON cs.customer_id = c.id
    LEFT JOIN customers pc ON pc.id = c.parent_customer_id`;

  // Customer role-eligibility, derived (role-derivation rework) — rather than a hand-maintained
  // customer_roles flag table, this reads the same 13 role slots screenShipmentById (server.js)
  // already screens: the 4 fixed shipment FK columns plus shipment_parties. A customer that's
  // never actually been assigned a role simply doesn't appear here yet — no backfill, no
  // separate table to keep in sync, self-corrects the moment a real assignment happens.
  const CUSTOMER_ROLE_USAGE_SQL = `
    SELECT shipper_id AS customer_id, 'Shipper' AS role FROM shipments WHERE shipper_id != ''
    UNION SELECT consignee_id, 'Consignee' FROM shipments WHERE consignee_id != ''
    UNION SELECT principal_id, 'Principal' FROM shipments WHERE principal_id != ''
    UNION SELECT notify_id, 'Notify Party' FROM shipments WHERE notify_id != ''
    UNION SELECT customer_id, role FROM shipment_parties
  `;

  // ─── Customers ────────────────────────────────────────────────────────────

  app.get("/api/customers", async (req, res) => {
    const { search='', city='', country='', customerId='', role='', limit='50', offset='0' } = req.query;
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    // roleFilter (CustomerCombobox) / category segment (MdmCustomersPage list) — narrows to
    // customers actually used in any of one-or-more comma-separated roles; deliberately a soft
    // filter (a not-yet-used customer is still reachable by clearing it client-side), never a
    // hard block enforced server-side beyond the query itself.
    const roleList = role.split(',').map(r => r.trim()).filter(Boolean);

    if (await isRemote()) {
      // Role-eligibility resolution never needs a toggle branch of its own — it's a UNION over
      // shipments/shipment_parties, both permanently monolith-owned regardless of customer_source
      // — resolved locally, then passed to the service as a plain ids= filter.
      let roleEligibleIds = null;
      if (roleList.length) {
        roleEligibleIds = db.prepare(
          `SELECT DISTINCT customer_id FROM (${CUSTOMER_ROLE_USAGE_SQL}) WHERE role IN (${roleList.map(() => '?').join(',')})`
        ).all(...roleList).map(r => r.customer_id);
        if (roleEligibleIds.length === 0) return ok(res, { results: [], total: 0, limit: lim, offset: off });
      }
      try {
        const qs = new URLSearchParams({ search, city, country, customerId, limit: String(lim), offset: String(off) });
        if (roleEligibleIds) qs.set("ids", roleEligibleIds.join(","));
        const data = await callCustomerService("GET", `/internal/customers?${qs}`);
        // Same live derived-roles batch-attach as local mode, against the returned page only.
        let rolesByCustomer = {};
        if (data.results.length) {
          const ids = data.results.map(r => r.id);
          const roleRows = db.prepare(
            `SELECT customer_id, role FROM (${CUSTOMER_ROLE_USAGE_SQL}) WHERE customer_id IN (${ids.map(() => '?').join(',')})`
          ).all(...ids);
          for (const r of roleRows) (rolesByCustomer[r.customer_id] ??= []).push(r.role);
        }
        return ok(res, { ...data, results: data.results.map(r => ({ ...r, roles: rolesByCustomer[r.id] || [] })) });
      } catch (e) { return err(res, e.message, e.status || 502); }
    }

    const conditions = [], params = [];
    const s = search.trim();
    if (s) { conditions.push("(c.company_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.id LIKE ?)"); params.push(`%${s}%`, `%${s}%`, `%${s}%`, `%${s}%`); }
    const ci = city.trim();
    if (ci) { conditions.push("c.city LIKE ?"); params.push(`%${ci}%`); }
    const co = country.trim().toUpperCase();
    if (co) { conditions.push("c.country_iso2 = ?"); params.push(co); }
    const cid = customerId.trim();
    if (cid) { conditions.push("c.id LIKE ?"); params.push(`%${cid}%`); }
    if (roleList.length) {
      conditions.push(`c.id IN (SELECT customer_id FROM (${CUSTOMER_ROLE_USAGE_SQL}) WHERE role IN (${roleList.map(() => '?').join(',')}))`);
      params.push(...roleList);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS n FROM customers c ${where}`).get(...params).n;
    const rows  = db.prepare(`${CUST_JOIN} ${where} ORDER BY c.company_name LIMIT ? OFFSET ?`).all(...params, lim, off);

    let rolesByCustomer = {};
    if (rows.length) {
      const ids = rows.map(r => r.id);
      const roleRows = db.prepare(
        `SELECT customer_id, role FROM (${CUSTOMER_ROLE_USAGE_SQL}) WHERE customer_id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids);
      for (const r of roleRows) (rolesByCustomer[r.customer_id] ??= []).push(r.role);
    }
    ok(res, {
      results: rows.map(r => ({ ...mapCustomer(r), roles: rolesByCustomer[r.id] || [] })),
      total, limit: lim, offset: off,
    });
  });

  app.get("/api/customers/sanctions-check", async (req, res) => {
    const s = await getSettings();
    if (s.api_customers_enabled !== 'true' || s.api_ofac_enabled !== 'true')
      return ok(res, { enabled: false, hits: [] });
    if (sanctionsMap.size === 0) return ok(res, { enabled: true, hits: [] });
    const customers = db.prepare("SELECT * FROM customers ORDER BY company_name").all();
    const hits = [];
    for (const c of customers) {
      const match = sanctionsMap.get(normSanctionName(c.company_name || ''));
      if (match) hits.push({ customer: mapCustomer(c), matchedEntry: match.entityName, program: match.program, source: match.source });
    }
    ok(res, { enabled: true, hits });
  });

  app.get("/api/customers/:id", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callCustomerService("GET", `/internal/customers/${req.params.id}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const r = db.prepare(`${CUST_JOIN} WHERE c.id=?`).get(req.params.id);
    if (!r) return err(res, "Not found", 404);
    ok(res, mapCustomer(r));
  });

  // ─── Credit Status (Organization Model Enhancement Epic 2, deepened per Epic
  // TKT-6XFJQM: AR aging, accrued-but-uninvoiced exposure, parent/group rollup, currency) ──
  // outstandingAr sums every CONFIRMED (not voided/draft) FR01/FR02 invoice on a shipment
  // where the given customer is Principal or Consignee — the same "responsible party"
  // resolution invoiceGenerator.js's own responsibleParty field already uses. Each invoice's
  // real dollar total is resolved via source_cost_line_ids when present (the same field the
  // invoice reversal feature, TKT-DUADU3, introduced for exactly this "what was this invoice
  app.get("/api/customers/:id/credit-status", auth(), async (req, res) => {
    const c = db.prepare("SELECT * FROM customers WHERE id=?").get(req.params.id);
    if (!c) return err(res, "Not found", 404);

    const { outstandingAr, committedExposure, aging } = computeArExposure(c.id, c.credit_terms_days);

    const currency = c.currency || 'USD';
    const creditLimit = c.credit_limit ?? null;
    const creditLimitUsd = creditLimit != null ? await toUsd(creditLimit, currency) : null;

    // Parent/group rollup (v0.59.0's own resolveCustomerGroup, already used for margin
    // reporting — reused here rather than a second lane-hierarchy concept) — additive: the
    // individual customer's own outstandingAr above is never replaced by this, only
    // supplemented, same non-breaking pattern the margin rollup toggle already established.
    const groupIds = (await resolveCustomerGroup(c.id)).filter(gid => gid !== c.id);
    let groupOutstandingAr = outstandingAr;
    for (const gid of groupIds) {
      groupOutstandingAr += computeArExposure(gid, c.credit_terms_days).outstandingAr;
    }
    groupOutstandingAr = roundCents(groupOutstandingAr);

    const currentExposure = roundCents(outstandingAr + committedExposure);
    ok(res, {
      customerId: c.id, companyName: c.company_name,
      creditLimit, creditLimitCurrency: currency, creditLimitUsd,
      creditTermsDays: c.credit_terms_days ?? null,
      creditHold: !!c.credit_hold, creditHoldReason: c.credit_hold_reason || '',
      outstandingAr, committedExposure, aging,
      overLimit: creditLimitUsd != null && currentExposure > creditLimitUsd,
      groupOutstandingAr, hasGroup: groupIds.length > 0,
    });
  });

  // Credit Control Depth, third pass (TKT-GLWMFP) — releasing an active credit_hold is
  // EXCLUSIVELY the authority of the trade_manager who owns the shipment's own trade lane, a
  // direct explicit business rule: never admin, operator, or an out-of-lane trade_manager, no
  // fallback. Deliberately a NEW dedicated action rather than folding into the generic
  // PUT /api/customers/:id (which stays open to admin/operator/trade_manager for every other
  // profile field, credit_hold included when SETTING it — only the release direction is this
  // exclusive) — mirrors this file's own screening/override precedent (a dedicated,
  // reason-required action, not a side effect of a generic edit).
  app.post("/api/customers/:id/credit-hold/release", auth(), async (req, res) => {
    const { shipmentId = '', reason = '' } = req.body;
    if (!reason.trim()) return err(res, "A reason is required to release a credit hold");
    const c = await getCustomerRow(req.params.id);
    if (!c) return err(res, "Customer not found", 404);
    if (!c.creditHold) return err(res, "This customer is not currently on credit hold");
    const shipment = shipmentId ? db.prepare("SELECT * FROM shipments WHERE id=?").get(shipmentId) : null;
    if (!shipment) return err(res, "shipmentId must reference a real shipment involving this customer");
    if (shipment.shipper_id !== c.id && shipment.consignee_id !== c.id && shipment.principal_id !== c.id)
      return err(res, "That shipment doesn't involve this customer");
    if (!userOwnsLaneForShipment(req.user, shipment))
      return err(res, "Only the trade manager responsible for this shipment's own trade lane may release a credit hold", 403);
    if (await isRemote()) {
      try { await callCustomerService("PUT", `/internal/customers/${c.id}`, { ...c, creditHold: false, creditHoldReason: '' }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    } else {
      db.prepare("UPDATE customers SET credit_hold=0, credit_hold_reason='' WHERE id=?").run(c.id);
    }
    await logEntityEvent('customer', c.id, 'CREDIT_HOLD_RELEASED', 'creditHold', 'true', 'false',
      JSON.stringify({ reason: reason.trim(), shipmentId, releasedBy: req.user.email || req.user.id }));
    const row = await getCustomerRow(c.id);
    ok(res, row);
  });

  // Same exclusivity, for the OTHER credit block: over-limit is a soft warning everywhere else
  // in this app (Epic 2's own deliberate v0.57.0 scope decision — a hard block needed a real
  // AR-aging view, which v0.73.0 finally shipped) — this is the one place it becomes a real,
  // consumable gate. Approving here does not itself generate anything; it hands operator/admin
  // a one-time permission slip that POST .../documents/generate consumes on the very next
  // FR01/FR02 it produces for this shipment while still over limit.
  app.post("/api/shipments/:id/credit-override/approve", auth(), async (req, res) => {
    try {
      const { reason = '' } = req.body;
      if (!reason.trim()) return err(res, "A reason is required to approve an over-limit override");
      const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
      if (!shipment) return err(res, "Shipment not found", 404);
      if (!userOwnsLaneForShipment(req.user, shipment))
        return err(res, "Only the trade manager responsible for this shipment's own trade lane may approve an over-limit override", 403);
      const respId = shipment.principal_id || shipment.consignee_id || null;
      if (!respId) return err(res, "This shipment has no Principal or Consignee to bill");
      const c = await getCustomerRow(respId);
      if (!c || c.creditLimit == null) return err(res, "The responsible party has no credit limit set");
      const { outstandingAr, committedExposure } = computeArExposure(c.id, c.creditTermsDays);
      const limitUsd = await toUsd(c.creditLimit, c.currency || 'USD');
      if (roundCents(outstandingAr + committedExposure) <= limitUsd)
        return err(res, "This shipment's responsible party is not currently over their credit limit");
      // credit_overrides itself stays monolith-owned regardless of customer_source — it's a
      // real hard FK to customers.id today, but that FK is only ever meaningfully enforced in
      // local mode; a remote-mode row still records the right customerId, just without the DB
      // itself validating that id exists.
      const id = `COV-${uid()}`;
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO credit_overrides (id,customer_id,shipment_id,override_type,reason,approved_by,approved_by_name,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, c.id, shipment.id, 'over_limit', reason.trim(), req.user.id, req.user.email || '', now);
      ok(res, { id, customerId: c.id, shipmentId: shipment.id, reason: reason.trim(), approvedBy: req.user.email || '', createdAt: now }, 201);
    } catch (e) { err(res, e.message || "Failed to approve override", 500); }
  });

  app.get("/api/shipments/:id/credit-override", auth(), (req, res) => {
    const row = db.prepare(
      "SELECT * FROM credit_overrides WHERE shipment_id=? AND override_type='over_limit' ORDER BY created_at DESC LIMIT 1"
    ).get(req.params.id);
    const stillValid = row && (Date.now() - new Date(row.created_at).getTime()) <= OVERRIDE_GRACE_MS;
    ok(res, stillValid ? {
      id: row.id, customerId: row.customer_id, shipmentId: row.shipment_id,
      reason: row.reason, approvedBy: row.approved_by_name, createdAt: row.created_at,
    } : null);
  });

  // The dedicated, non-Accounting surface the ticket calls for — every currently-blocked
  // shipment (hard credit_hold or a real over-limit situation), one row per (shipment, block).
  // admin/operator see the FULL queue for visibility/escalation but can never act on it
  // (canAct always false for them — the whole point of this story); a trade_manager only ever
  // sees rows their OWN trade_lane scope actually covers, so for them canAct is always true —
  // there's nothing in their own result set they couldn't act on. Bounded computation: only
  // customers that are actually held or actually carry a credit_limit are ever checked.
  app.get("/api/credit-overrides/queue", auth(), requireRole(["admin", "operator", "trade_manager"]), async (req, res) => {
    const isTradeManager = req.user.roles?.includes('trade_manager');
    const rows = [];

    // Both bulk scans normalize to the same camelCase shape either way — local rows go through
    // mapCustomer, remote rows already arrive mapped — so the loop bodies below never branch.
    let heldCustomers, limitedCustomers;
    if (await isRemote()) {
      try {
        heldCustomers = await callCustomerService("GET", "/internal/customers?creditHold=1");
        limitedCustomers = await callCustomerService("GET", "/internal/customers?creditHold=0&hasCreditLimit=1");
      } catch (e) { return err(res, e.message, e.status || 502); }
    } else {
      heldCustomers = db.prepare("SELECT * FROM customers WHERE credit_hold=1").all().map(mapCustomer);
      limitedCustomers = db.prepare("SELECT * FROM customers WHERE credit_hold=0 AND credit_limit IS NOT NULL").all().map(mapCustomer);
    }

    for (const c of heldCustomers) {
      const shipments = db.prepare(
        `SELECT * FROM shipments WHERE (shipper_id=? OR consignee_id=? OR principal_id=?) AND status NOT IN ('Completed','Cancelled')`
      ).all(c.id, c.id, c.id);
      for (const s of shipments) {
        const canAct = userOwnsLaneForShipment(req.user, s);
        if (isTradeManager && !canAct) continue;
        const role = s.shipper_id === c.id ? 'Shipper' : s.consignee_id === c.id ? 'Consignee' : 'Principal';
        rows.push({
          shipmentId: s.id, customerId: c.id, companyName: c.companyName, role,
          blockType: 'hold', detail: c.creditHoldReason || '', canAct,
        });
      }
    }

    for (const c of limitedCustomers) {
      const { outstandingAr, committedExposure } = computeArExposure(c.id, c.creditTermsDays);
      const limitUsd = await toUsd(c.creditLimit, c.currency || 'USD');
      if (roundCents(outstandingAr + committedExposure) <= limitUsd) continue;
      const shipments = db.prepare(
        `SELECT * FROM shipments WHERE (principal_id=? OR consignee_id=?) AND status NOT IN ('Completed','Cancelled')`
      ).all(c.id, c.id);
      for (const s of shipments) {
        const canAct = userOwnsLaneForShipment(req.user, s);
        if (isTradeManager && !canAct) continue;
        const role = s.principal_id === c.id ? 'Principal' : 'Consignee';
        rows.push({
          shipmentId: s.id, customerId: c.id, companyName: c.companyName, role,
          blockType: 'over_limit', detail: `Exposure ${roundCents(outstandingAr + committedExposure)} > limit ${limitUsd} (USD)`, canAct,
        });
      }
    }

    ok(res, rows);
  });

  // Invoicing Discipline & Billing Performance (Epic TKT-KR6ZBT), Story TKT-YC7PZP — a shipment
  // that's actually delivered but has gone past its own responsible party's configured
  // invoice-generation window with no confirmed invoice yet. Purely informational (mirrors the
  // existing expiring-contracts notification-bell pattern, GET /api/contracts/expiring) — never
  // a block, per this Epic's own explicit scope decision (holding up shipment progress over a
  // billing-process lag would block the wrong side of the business). Bounded by construction:
  // only shipments with a genuinely completed "delivered" milestone are ever considered.
  app.get("/api/invoice-deadlines/overdue", auth(), async (req, res) => {
    const rows = db.prepare(`
      SELECT s.id AS shipment_id, s.principal_id, s.principal_name, s.consignee_id, s.consignee_name,
             m.completed_at AS delivered_at
      FROM shipments s
      JOIN shipment_milestones m ON m.shipment_id = s.id AND m.milestone_key = 'delivered' AND m.completed_at != ''
      WHERE s.status != 'Cancelled'
    `).all();

    // In remote mode, one bulk fetch keyed by every distinct responsible-party id, rather than a
    // remote round trip per shipment — same batching shape reports.js's own two customer-heavy
    // reports use. Local mode is untouched: still one cheap per-row SQLite lookup, exactly as
    // before this cut.
    let deadlineDaysById = null;
    if (await isRemote()) {
      const respIds = [...new Set(rows.map(r => r.principal_id || r.consignee_id).filter(Boolean))];
      deadlineDaysById = {};
      if (respIds.length) {
        try {
          const custRows = await callCustomerService("GET", `/internal/customers?ids=${respIds.map(encodeURIComponent).join(",")}`);
          custRows.forEach(c => { deadlineDaysById[c.id] = c.invoiceDeadlineDays; });
        } catch (e) { return err(res, e.message, e.status || 502); }
      }
    }

    const todayMs = Date.now();
    const results = [];
    for (const r of rows) {
      const respId   = r.principal_id || r.consignee_id || null;
      const respName = r.principal_id ? r.principal_name : r.consignee_name;
      if (!respId) continue;
      const invoiceDeadlineDays = deadlineDaysById
        ? deadlineDaysById[respId]
        : db.prepare("SELECT invoice_deadline_days FROM customers WHERE id=?").get(respId)?.invoice_deadline_days;
      if (invoiceDeadlineDays == null) continue;
      const daysSinceDelivery = Math.floor((todayMs - new Date(r.delivered_at).getTime()) / 86400000);
      const daysOverdue = daysSinceDelivery - invoiceDeadlineDays;
      if (daysOverdue <= 0) continue;
      const hasInvoice = db.prepare(
        "SELECT 1 FROM shipment_documents WHERE shipment_id=? AND doc_type IN ('FR01','FR02') AND status='confirmed' LIMIT 1"
      ).get(r.shipment_id);
      if (hasInvoice) continue;
      results.push({
        shipmentId: r.shipment_id, customerId: respId, companyName: respName || '',
        deliveredAt: r.delivered_at, deadlineDays: invoiceDeadlineDays, daysOverdue,
      });
    }
    results.sort((a, b) => b.daysOverdue - a.daysOverdue);
    ok(res, results.slice(0, 20));
  });

  // Organization Model Enhancement Epic 4 — walks the parent chain to make sure setting
  // newParentId as customerId's parent could never loop back on itself (A -> B -> A), since a
  // rollup read (resolveCustomerGroup below) that walked a cycle would never terminate.
  function wouldCreateCycle(customerId, newParentId) {
    let current = newParentId;
    const seen = new Set();
    while (current) {
      if (current === customerId || seen.has(current)) return true;
      seen.add(current);
      current = db.prepare("SELECT parent_customer_id FROM customers WHERE id=?").get(current)?.parent_customer_id || null;
    }
    return false;
  }

  app.post("/api/customers", auth(), async (req, res) => {
    if (await isRemote()) {
      try {
        const created = await callCustomerService("POST", "/internal/customers", req.body);
        if (sanctionsMap.size > 0) {
          await screenCustomer(created.id);
          return ok(res, await getCustomerRow(created.id), 201);
        }
        return ok(res, created, 201);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { companyName, address1='', address2='', city='', state='', postalCode='',
            countryIso2='', phone='', fax='', email='', website='', notes='', currency='',
            creditLimit=null, creditTermsDays=null, invoiceDeadlineDays=null, creditHold=false, creditHoldReason='',
            reminderEnabled=false, reminderIntervalDays=null,
            parentCustomerId=null,
            classifiedLocation=false, latitude=null, longitude=null,
            isNvocc=false, fmcNumber='',
            billingByDay=null, paymentSettlementDay=null, holidayUnlocode='' } = req.body;
    if (!companyName?.trim()) return err(res, "companyName required");
    if (parentCustomerId && !db.prepare("SELECT id FROM customers WHERE id=?").get(parentCustomerId))
      return err(res, "Parent customer not found");
    if (!validCoord(latitude, -90, 90)) return err(res, "Latitude must be between -90 and 90");
    if (!validCoord(longitude, -180, 180)) return err(res, "Longitude must be between -180 and 180");
    const id = `CUS-${uid()}`;
    const createdAt = new Date().toISOString();
    const ccU = countryIso2.toUpperCase().trim();
    // Only fall back to the country's own default when the caller omitted currency entirely —
    // an explicit choice (including an explicit "USD") is never overridden.
    const resolvedCurrency = (currency.trim() || COUNTRY_TO_CURRENCY[ccU] || 'USD').toUpperCase().trim();
    const cl = creditLimit === null || creditLimit === '' ? null : Number(creditLimit);
    const ctd = creditTermsDays === null || creditTermsDays === '' ? null : parseInt(creditTermsDays, 10);
    const idd = invoiceDeadlineDays === null || invoiceDeadlineDays === '' ? null : parseInt(invoiceDeadlineDays, 10);
    const rid = reminderIntervalDays === null || reminderIntervalDays === '' ? null : parseInt(reminderIntervalDays, 10);
    const lat = classifiedLocation && latitude !== '' && latitude != null ? Number(latitude) : null;
    const lng = classifiedLocation && longitude !== '' && longitude != null ? Number(longitude) : null;
    // Customer Billing Cycle (Epic TKT-G11AHW) — day-of-month, recurring (not literal dates, per
    // direct clarification), both genuinely optional.
    const bbd = billingByDay === null || billingByDay === '' ? null : parseInt(billingByDay, 10);
    const psd = paymentSettlementDay === null || paymentSettlementDay === '' ? null : parseInt(paymentSettlementDay, 10);
    if (bbd != null && (bbd < 1 || bbd > 31)) return err(res, "billingByDay must be between 1 and 31");
    if (psd != null && (psd < 1 || psd > 31)) return err(res, "paymentSettlementDay must be between 1 and 31");
    db.prepare(`INSERT INTO customers (id,company_name,address1,address2,city,state,postal_code,country_iso2,phone,fax,email,website,notes,created_at,currency,credit_limit,credit_terms_days,invoice_deadline_days,credit_hold,credit_hold_reason,reminder_enabled,reminder_interval_days,parent_customer_id,classified_location,latitude,longitude,is_nvocc,fmc_number,billing_by_day,payment_settlement_day,holiday_unlocode)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, companyName.trim(), address1, address2, city, state, postalCode, ccU, phone, fax, email, website, notes, createdAt, resolvedCurrency,
           cl, ctd, idd, creditHold ? 1 : 0, creditHold ? creditHoldReason.trim() : '', reminderEnabled ? 1 : 0, rid, parentCustomerId || null,
           classifiedLocation ? 1 : 0, lat, lng, isNvocc ? 1 : 0, isNvocc ? fmcNumber.trim() : '', bbd, psd, holidayUnlocode.trim().toUpperCase());
    if (sanctionsMap.size > 0) await screenCustomer(id);
    const row = db.prepare(`${CUST_JOIN} WHERE c.id=?`).get(id);
    ok(res, mapCustomer(row), 201);
  });

  app.put("/api/customers/:id", auth(), async (req, res) => {
    if (await isRemote()) {
      const { creditHold = false } = req.body;
      try {
        // Same exclusivity check as local mode, just fetched remotely first — releasing an
        // active credit_hold is exclusively the shipment's own lane trade_manager's call.
        const existing = await callCustomerService("GET", `/internal/customers/${req.params.id}`).catch(() => null);
        if (existing?.creditHold && !creditHold && !userOwnsLaneForCustomer(req.user, req.params.id))
          return err(res, "Only the trade manager responsible for this customer's trade lane may release a credit hold — use the Credit Overrides queue", 403);
        const updated = await callCustomerService("PUT", `/internal/customers/${req.params.id}`, req.body);
        if (sanctionsMap.size > 0) {
          await screenCustomer(req.params.id);
          return ok(res, await getCustomerRow(req.params.id));
        }
        return ok(res, updated);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { companyName, address1='', address2='', city='', state='', postalCode='',
            countryIso2='', phone='', fax='', email='', website='', notes='', currency='USD',
            creditLimit=null, creditTermsDays=null, invoiceDeadlineDays=null, creditHold=false, creditHoldReason='',
            reminderEnabled=false, reminderIntervalDays=null,
            parentCustomerId=null,
            classifiedLocation=false, latitude=null, longitude=null,
            isNvocc=false, fmcNumber='',
            billingByDay=null, paymentSettlementDay=null, holidayUnlocode='' } = req.body;
    if (!companyName?.trim()) return err(res, "companyName required");
    if (parentCustomerId) {
      if (!db.prepare("SELECT id FROM customers WHERE id=?").get(parentCustomerId))
        return err(res, "Parent customer not found");
      if (wouldCreateCycle(req.params.id, parentCustomerId))
        return err(res, "This would create a circular parent chain — pick a different parent");
    }
    if (!validCoord(latitude, -90, 90)) return err(res, "Latitude must be between -90 and 90");
    if (!validCoord(longitude, -180, 180)) return err(res, "Longitude must be between -180 and 180");
    // Credit Control Depth, third pass (TKT-GLWMFP) — releasing a credit_hold is exclusively
    // the shipment's own lane trade_manager's call, never admin/operator, no exception. The
    // generic PUT is otherwise the normal, unrestricted profile-edit path (SETTING a hold, or
    // editing anything else about this customer, is untouched) — this only closes the one
    // direct-API bypass of the dedicated POST .../credit-hold/release endpoint's own check.
    const existing = db.prepare("SELECT credit_hold FROM customers WHERE id=?").get(req.params.id);
    if (existing?.credit_hold && !creditHold && !userOwnsLaneForCustomer(req.user, req.params.id))
      return err(res, "Only the trade manager responsible for this customer's trade lane may release a credit hold — use the Credit Overrides queue", 403);
    const ccU = countryIso2.toUpperCase().trim();
    const cl = creditLimit === null || creditLimit === '' ? null : Number(creditLimit);
    const ctd = creditTermsDays === null || creditTermsDays === '' ? null : parseInt(creditTermsDays, 10);
    const idd = invoiceDeadlineDays === null || invoiceDeadlineDays === '' ? null : parseInt(invoiceDeadlineDays, 10);
    const rid = reminderIntervalDays === null || reminderIntervalDays === '' ? null : parseInt(reminderIntervalDays, 10);
    // classifiedLocation off force-clears any stored coordinates server-side, regardless of what
    // the request body still carries — same hygiene idiom as credit_hold_reason on the line above.
    const lat = classifiedLocation && latitude !== '' && latitude != null ? Number(latitude) : null;
    const lng = classifiedLocation && longitude !== '' && longitude != null ? Number(longitude) : null;
    const bbd = billingByDay === null || billingByDay === '' ? null : parseInt(billingByDay, 10);
    const psd = paymentSettlementDay === null || paymentSettlementDay === '' ? null : parseInt(paymentSettlementDay, 10);
    if (bbd != null && (bbd < 1 || bbd > 31)) return err(res, "billingByDay must be between 1 and 31");
    if (psd != null && (psd < 1 || psd > 31)) return err(res, "paymentSettlementDay must be between 1 and 31");
    const info = db.prepare(`UPDATE customers SET company_name=?,address1=?,address2=?,city=?,state=?,
      postal_code=?,country_iso2=?,phone=?,fax=?,email=?,website=?,notes=?,currency=?,
      credit_limit=?,credit_terms_days=?,invoice_deadline_days=?,credit_hold=?,credit_hold_reason=?,reminder_enabled=?,reminder_interval_days=?,parent_customer_id=?,
      classified_location=?,latitude=?,longitude=?,is_nvocc=?,fmc_number=?,
      billing_by_day=?,payment_settlement_day=?,holiday_unlocode=? WHERE id=?`)
      .run(companyName.trim(), address1, address2, city, state, postalCode, ccU, phone, fax, email, website, notes, (currency || 'USD').toUpperCase().trim(),
           cl, ctd, idd, creditHold ? 1 : 0, creditHold ? creditHoldReason.trim() : '', reminderEnabled ? 1 : 0, rid, parentCustomerId || null,
           classifiedLocation ? 1 : 0, lat, lng, isNvocc ? 1 : 0, isNvocc ? fmcNumber.trim() : '',
           bbd, psd, holidayUnlocode.trim().toUpperCase(), req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    if (sanctionsMap.size > 0) await screenCustomer(req.params.id);
    const row = db.prepare(`${CUST_JOIN} WHERE c.id=?`).get(req.params.id);
    ok(res, mapCustomer(row));
  });

  app.delete("/api/customers/:id", auth(), async (req, res) => {
    // Carrier Line Agents — agent_customer_id has no ON DELETE clause (deliberately: neither
    // CASCADE nor SET NULL fits a NOT NULL master-data pointer that IS the row's reason for
    // existing), so this app-level guard is the actual enforcement, mirroring offices.js's own
    // "referenced by shipments — deactivate it instead" pattern for the same class of problem.
    // Kept unconditional, regardless of customer_source — carrier_agents itself moved to the MDM
    // Service at v0.80.0, so this guard already only reflects reality when mdm_source='local';
    // a named, pre-existing gap (ARCHITECTURE.md §8.1), not this cut's job to widen or fix.
    const inUse = db.prepare("SELECT id FROM carrier_agents WHERE agent_customer_id=? LIMIT 1").get(req.params.id);
    if (inUse) return err(res, "Customer is assigned as a carrier line agent — remove that assignment first");

    if (await isRemote()) {
      try { await callCustomerService("DELETE", `/internal/customers/${req.params.id}`); }
      catch (e) { return err(res, e.message, e.status || 502); }
    } else {
      const info = db.prepare("DELETE FROM customers WHERE id=?").run(req.params.id);
      if (info.changes === 0) return err(res, "Not found", 404);
      db.prepare("DELETE FROM customer_identifiers WHERE customer_id=?").run(req.params.id);
      db.prepare("DELETE FROM customer_screenings  WHERE customer_id=?").run(req.params.id);
      db.prepare("DELETE FROM customer_contacts    WHERE customer_id=?").run(req.params.id);
    }
    // customer_documents stays local-only regardless of customer_source (see ARCHITECTURE.md
    // §8.1) — its own cleanup always runs, even when the customer row itself just got deleted
    // remotely.
    const docs = db.prepare("SELECT stored_name FROM customer_documents WHERE customer_id=?").all(req.params.id);
    for (const d of docs) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, d.stored_name)); } catch {}
    }
    db.prepare("DELETE FROM customer_documents WHERE customer_id=?").run(req.params.id);
    ok(res, { deleted: req.params.id });
  });

  // ─── Customer Identifiers ─────────────────────────────────────────────────

  app.get("/api/customers/:id/identifiers", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callCustomerService("GET", `/internal/customers/${req.params.id}/identifiers`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const rows = db.prepare("SELECT * FROM customer_identifiers WHERE customer_id=? ORDER BY is_primary DESC, created_at ASC").all(req.params.id);
    ok(res, rows.map(mapCustomerIdentifier));
  });

  app.post("/api/customers/:id/identifiers", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callCustomerService("POST", `/internal/customers/${req.params.id}/identifiers`, req.body), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    if (!db.prepare("SELECT id FROM customers WHERE id=?").get(req.params.id))
      return err(res, "Customer not found", 404);
    const { idType='VAT', idCode='', countryIso2='', label='', isPrimary=false } = req.body;
    if (!idCode.trim()) return err(res, "idCode required");
    const id  = `CID-${uid()}`;
    const now = new Date().toISOString();
    if (isPrimary)
      db.prepare("UPDATE customer_identifiers SET is_primary=0 WHERE customer_id=? AND id_type=?").run(req.params.id, idType);
    db.prepare("INSERT INTO customer_identifiers (id,customer_id,id_type,id_code,country_iso2,label,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, req.params.id, idType, idCode.trim(), countryIso2.toUpperCase().slice(0,2), label.trim(), isPrimary ? 1 : 0, now);
    const row = db.prepare("SELECT * FROM customer_identifiers WHERE id=?").get(id);
    ok(res, mapCustomerIdentifier(row), 201);
  });

  app.put("/api/customers/:id/identifiers/:iid", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callCustomerService("PUT", `/internal/customers/${req.params.id}/identifiers/${req.params.iid}`, req.body)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const existing = db.prepare("SELECT * FROM customer_identifiers WHERE id=? AND customer_id=?").get(req.params.iid, req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const { idType=existing.id_type, idCode=existing.id_code, countryIso2=existing.country_iso2,
            label=existing.label, isPrimary=!!existing.is_primary } = req.body;
    if (!idCode.trim()) return err(res, "idCode required");
    if (isPrimary)
      db.prepare("UPDATE customer_identifiers SET is_primary=0 WHERE customer_id=? AND id_type=? AND id!=?").run(req.params.id, idType, req.params.iid);
    db.prepare("UPDATE customer_identifiers SET id_type=?,id_code=?,country_iso2=?,label=?,is_primary=? WHERE id=?")
      .run(idType, idCode.trim(), countryIso2.toUpperCase().slice(0,2), label.trim(), isPrimary ? 1 : 0, req.params.iid);
    const row = db.prepare("SELECT * FROM customer_identifiers WHERE id=?").get(req.params.iid);
    ok(res, mapCustomerIdentifier(row));
  });

  app.delete("/api/customers/:id/identifiers/:iid", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callCustomerService("DELETE", `/internal/customers/${req.params.id}/identifiers/${req.params.iid}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("DELETE FROM customer_identifiers WHERE id=? AND customer_id=?").run(req.params.iid, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.iid });
  });

  // ─── Customer Contacts ────────────────────────────────────────────────────
  // Named people at this customer (Sales/Operations/Accounts/Other) — replaces the old
  // "cram it into the notes field" workaround. Mirrors the identifiers CRUD shape exactly.

  app.get("/api/customers/:id/contacts", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callCustomerService("GET", `/internal/customers/${req.params.id}/contacts`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const rows = db.prepare("SELECT * FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC, created_at ASC").all(req.params.id);
    ok(res, rows.map(mapCustomerContact));
  });

  app.post("/api/customers/:id/contacts", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callCustomerService("POST", `/internal/customers/${req.params.id}/contacts`, req.body), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    if (!db.prepare("SELECT id FROM customers WHERE id=?").get(req.params.id))
      return err(res, "Customer not found", 404);
    const { name='', title='', email='', phone='', department='Other', isPrimary=false } = req.body;
    if (!name.trim()) return err(res, "name required");
    const id  = `CCT-${uid()}`;
    const now = new Date().toISOString();
    if (isPrimary)
      db.prepare("UPDATE customer_contacts SET is_primary=0 WHERE customer_id=?").run(req.params.id);
    db.prepare("INSERT INTO customer_contacts (id,customer_id,name,title,email,phone,department,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, req.params.id, name.trim(), title.trim(), email.trim(), phone.trim(), department, isPrimary ? 1 : 0, now);
    const row = db.prepare("SELECT * FROM customer_contacts WHERE id=?").get(id);
    ok(res, mapCustomerContact(row), 201);
  });

  app.put("/api/customers/:id/contacts/:cid", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callCustomerService("PUT", `/internal/customers/${req.params.id}/contacts/${req.params.cid}`, req.body)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const existing = db.prepare("SELECT * FROM customer_contacts WHERE id=? AND customer_id=?").get(req.params.cid, req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const { name=existing.name, title=existing.title, email=existing.email, phone=existing.phone,
            department=existing.department, isPrimary=!!existing.is_primary } = req.body;
    if (!name.trim()) return err(res, "name required");
    if (isPrimary)
      db.prepare("UPDATE customer_contacts SET is_primary=0 WHERE customer_id=? AND id!=?").run(req.params.id, req.params.cid);
    db.prepare("UPDATE customer_contacts SET name=?,title=?,email=?,phone=?,department=?,is_primary=? WHERE id=?")
      .run(name.trim(), title.trim(), email.trim(), phone.trim(), department, isPrimary ? 1 : 0, req.params.cid);
    const row = db.prepare("SELECT * FROM customer_contacts WHERE id=?").get(req.params.cid);
    ok(res, mapCustomerContact(row));
  });

  app.delete("/api/customers/:id/contacts/:cid", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callCustomerService("DELETE", `/internal/customers/${req.params.id}/contacts/${req.params.cid}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("DELETE FROM customer_contacts WHERE id=? AND customer_id=?").run(req.params.cid, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.cid });
  });

  // ─── Customer Roles ───────────────────────────────────────────────────────
  // Derived, read-only (role-derivation rework) — which roles this customer has actually been
  // assigned on real shipments. No setter: nothing to save, it self-corrects the moment a new
  // assignment is made elsewhere in the app. See CUSTOMER_ROLE_USAGE_SQL above.

  app.get("/api/customers/:id/roles", auth(), (req, res) => {
    const rows = db.prepare(`SELECT DISTINCT role FROM (${CUSTOMER_ROLE_USAGE_SQL}) WHERE customer_id=?`).all(req.params.id);
    ok(res, rows.map(r => r.role));
  });

  // ─── Customer Screening ───────────────────────────────────────────────────

  app.get("/api/customers/:id/screening", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callCustomerService("GET", `/internal/customers/${req.params.id}/screening`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const row = db.prepare("SELECT * FROM customer_screenings WHERE customer_id=?").get(req.params.id);
    if (!row) return ok(res, null);
    ok(res, mapCustomerScreening(row));
  });

  app.post("/api/customers/:id/screen", auth(), async (req, res) => {
    if (!(await getCustomerRow(req.params.id)))
      return err(res, "Not found", 404);
    if (sanctionsMap.size === 0)
      return err(res, "Sanctions list not yet synced — use POST /api/sanctions/sync first.", 400);
    ok(res, await screenCustomer(req.params.id));
  });

  // Previously gated only by auth() (any authenticated user, viewer included) — the frontend's
  // own override button IS canEdit-gated (MdmCustomersPage.jsx), so this was a direct-API-only
  // gap, unlike the shipment-level equivalent which was reachable through the real UI too.
  app.post("/api/customers/:id/screening/override", auth(), customerWrite, async (req, res) => {
    const { reason = "" } = req.body;
    if (!reason.trim()) return err(res, "Override reason is required");
    if (await isRemote()) {
      try { return ok(res, await callCustomerService("POST", `/internal/customers/${req.params.id}/screening/override`, { reason })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const row = db.prepare("SELECT id FROM customer_screenings WHERE customer_id=?").get(req.params.id);
    if (!row) return err(res, "No screening record found for this customer", 404);
    const now = new Date().toISOString();
    db.prepare("UPDATE customer_screenings SET result='CLEAR', overridden_at=?, override_reason=? WHERE customer_id=?")
      .run(now, reason.trim(), req.params.id);
    const updated = db.prepare("SELECT * FROM customer_screenings WHERE customer_id=?").get(req.params.id);
    ok(res, mapCustomerScreening(updated));
  });

  // ─── Customer Documents ───────────────────────────────────────────────────

  app.get("/api/customers/:id/documents", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM customer_documents WHERE customer_id=? ORDER BY created_at DESC").all(req.params.id);
    ok(res, rows.map(mapCustomerDoc));
  });

  app.post("/api/customers/:id/documents", auth(), async (req, res) => {
    // customer_documents itself stays local-only regardless of customer_source (see the delete
    // guard's own note below and ARCHITECTURE.md §8.1) — only this existence check needs to be
    // remote-aware, or a customer created after a remote cutover would wrongly 404 an upload.
    if (!(await getCustomerRow(req.params.id)))
      return err(res, "Customer not found", 404);
    const { filename, mimeType, docType, data } = req.body;
    if (!filename || !data) return err(res, "filename and data are required");
    try {
      const buf        = Buffer.from(data, "base64");
      const ext        = path.extname(filename) || "";
      const storedName = `${Date.now()}_${uid()}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buf);
      const id       = `CDO-${uid()}`;
      const now      = new Date().toISOString();
      const uploader = req.user?.name || req.user?.email || "";
      db.prepare("INSERT INTO customer_documents (id,customer_id,filename,stored_name,mime_type,size_bytes,doc_type,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, req.params.id, filename, storedName, mimeType || "", buf.length, docType || "Other", uploader, now);
      const row = db.prepare("SELECT * FROM customer_documents WHERE id=?").get(id);
      ok(res, mapCustomerDoc(row), 201);
    } catch (e) { err(res, e.message, 500); }
  });

  app.delete("/api/customers/:id/documents/:did", auth(), (req, res) => {
    const doc = db.prepare("SELECT * FROM customer_documents WHERE id=? AND customer_id=?").get(req.params.did, req.params.id);
    if (!doc) return err(res, "Not found", 404);
    try { fs.unlinkSync(path.join(UPLOADS_DIR, doc.stored_name)); } catch {}
    db.prepare("DELETE FROM customer_documents WHERE id=?").run(req.params.did);
    ok(res, { deleted: req.params.did });
  });

  app.get("/api/customers/:id/documents/:did/download", auth(), (req, res) => {
    const doc = db.prepare("SELECT * FROM customer_documents WHERE id=? AND customer_id=?").get(req.params.did, req.params.id);
    if (!doc) return err(res, "Not found", 404);
    const filePath = path.join(UPLOADS_DIR, doc.stored_name);
    if (!fs.existsSync(filePath)) return err(res, "File not found on disk", 404);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.filename}"`);
    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    res.sendFile(filePath);
  });

  // The 5 /api/sanctions/* routes that used to live here moved to routes/sanctions.js as the
  // first step of the Screening Service extraction — see that file for the full write-up.

  // ─── FX Rates ─────────────────────────────────────────────────────────────

  app.get("/api/fx/rates", async (req, res) => {
    const rates = await getFxRates();
    ok(res, { base: "USD", rates, ts: fxCache.ts });
  });
};
