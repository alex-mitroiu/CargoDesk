"use strict";

module.exports = function financeRoutes(app, ctx) {
  const { query, ok, err, auth, resolveCustomerGroup, roundCents, getFxRates } = ctx;

  // Multi-Entity Accounting (TKT-EEV4I9) — mirrors canEditOfficeSide's (server.js) admin/
  // operator/allOffices bypass exactly, applied to READ visibility of the byEntity breakdown
  // instead of write permission: a branch-scoped user should see their own entity's P&L, not the
  // whole company's, unless they're global. Returns null for "unrestricted" or a Set of branch
  // ids the caller may see (possibly empty, if they have no active office set).
  const callerEntityScope = async req => {
    const user = req.user;
    const jwtRoles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : ['viewer']);
    if (jwtRoles.includes('admin') || jwtRoles.includes('operator')) return null;
    if (user.allOffices) return null;
    const activeOfficeId = req.headers?.['x-office-id'];
    if (!activeOfficeId) return new Set();
    const [office] = await query("SELECT branch_id FROM offices WHERE id=$1", [activeOfficeId]);
    return new Set(office?.branch_id ? [office.branch_id] : []);
  };

  // Converts a USD figure into `currency` using the same FX table toUsd() already uses, just
  // inverted — no new FX infrastructure, this is the one direction that table didn't need yet.
  const fromUsd = async (amountUsd, currency) => {
    if (!currency || currency === "USD") return roundCents(amountUsd);
    const rates = await getFxRates();
    const rate = rates[currency];
    return rate ? roundCents(amountUsd * rate) : roundCents(amountUsd);
  };

  app.get("/api/margin/summary", auth(), async (req, res) => {
    const u = req.user;
    const roles = Array.isArray(u.roles) ? u.roles : [u.role || 'viewer'];
    if (!roles.includes('admin') && !u.canViewFinance)
      return err(res, "Finance access not enabled for your account", 403);
    // entity/entityName/entityCurrency resolve a shipment's owning legal entity (Multi-Entity
    // Accounting, TKT-EEV4I9) as its EMO office's branch, falling back to the IMO office's branch
    // when EMO is unset — no new column on shipments/shipment_cost_lines, a branch already IS
    // CargoDesk's legal-entity boundary (see the branches.currency migration in server.js).
    const lines = await query(`
      SELECT cl.*, s.carrier_code, s.pol, s.pod, s.etd, s.created_at AS shp_created_at,
             s.principal_id, s.principal_name, s.consignee_id, s.consignee_name,
             COALESCE(emo_branch.id, imo_branch.id) AS entity_id,
             COALESCE(emo_branch.name, imo_branch.name) AS entity_name,
             COALESCE(emo_branch.currency, imo_branch.currency) AS entity_currency
      FROM shipment_cost_lines cl
      JOIN shipments s ON s.id = cl.shipment_id
      LEFT JOIN offices  emo_office ON emo_office.id = s.emo_office_id
      LEFT JOIN branches emo_branch ON emo_branch.id = emo_office.branch_id
      LEFT JOIN offices  imo_office ON imo_office.id = s.imo_office_id
      LEFT JOIN branches imo_branch ON imo_branch.id = imo_office.branch_id
    `);

    const todayStr = new Date().toISOString().slice(0, 10);
    const weekBuckets = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(todayStr);
      d.setDate(d.getDate() - (5 - i) * 7);
      const end   = d.toISOString().slice(0, 10);
      const start = new Date(d.setDate(d.getDate() - 6)).toISOString().slice(0, 10);
      const label = new Date(end).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      return { start, end, label };
    });

    const aggregate = (rows) => {
      const buy  = rows.filter(r => r.type === 'BUY').reduce((s, r) => s + r.amount * r.exchange_rate, 0);
      const sell = rows.filter(r => r.type === 'SELL').reduce((s, r) => s + r.amount * r.exchange_rate, 0);
      const gp   = sell - buy;
      const pct  = sell > 0 ? Math.round((gp / sell) * 1000) / 10 : null;
      return { totalBuyUsd: roundCents(buy), totalSellUsd: roundCents(sell), grossProfitUsd: roundCents(gp), grossMarginPct: pct };
    };

    const weeklyBreakdown = (rows) => weekBuckets.map(b => {
      const inBucket = rows.filter(r => {
        const ref = (r.etd || r.shp_created_at || '').slice(0, 10);
        return ref >= b.start && ref <= b.end;
      });
      return { week: b.label, ...aggregate(inBucket) };
    });

    const overall      = aggregate(lines);
    const carrierCodes = [...new Set(lines.map(r => r.carrier_code))];
    const byCarrier    = carrierCodes.map(code => {
      const rows = lines.filter(r => r.carrier_code === code);
      return { carrierCode: code, ...aggregate(rows), weeks: weeklyBreakdown(rows) };
    }).sort((a, b) => (b.totalSellUsd || 0) - (a.totalSellUsd || 0));

    const lanes  = [...new Set(lines.map(r => `${r.pol} → ${r.pod}`))];
    const byLane = lanes.map(lane => {
      const [pol, pod] = lane.split(' → ');
      const rows = lines.filter(r => r.pol === pol && r.pod === pod);
      return { lane, ...aggregate(rows), weeks: weeklyBreakdown(rows) };
    }).sort((a, b) => (b.totalSellUsd || 0) - (a.totalSellUsd || 0));

    // Organization Model Enhancement Epic 4 — "the responsible party" precedence
    // (Principal, falling back to Consignee) mirrors invoiceGenerator.js's own responsibleParty
    // field, since that's the same customer relationship a generated invoice is actually billed
    // against. groupByParent=true (query param) remaps each line's customer to its hierarchy's
    // ROOT customer via resolveCustomerGroup before aggregating, so a multinational shipper's
    // shipments booked under several regional customer records show as one consolidated row —
    // without touching how any of those individual records are stored or displayed elsewhere.
    const groupByParent = req.query.groupByParent === 'true';
    const custKey = r => r.principal_id || r.consignee_id || '';
    const custName = r => r.principal_id ? r.principal_name : r.consignee_id ? r.consignee_name : '';
    const custRows = lines.filter(r => custKey(r));
    // resolveCustomerGroup is async (customer_source can be 'remote'), but rootOf is called
    // synchronously inside the .map()s below — pre-warm the cache for every distinct id up front,
    // then read it back synchronously, rather than making rootOf itself async in place.
    const rootCache = new Map();
    if (groupByParent) {
      const distinctIds = [...new Set(custRows.map(r => custKey(r)))];
      await Promise.all(distinctIds.map(async id => { rootCache.set(id, (await resolveCustomerGroup(id))[0]); }));
    }
    const rootOf = id => (!groupByParent || !id) ? id : (rootCache.get(id) ?? id);
    const customerIds = [...new Set(custRows.map(r => rootOf(custKey(r))))];
    const byCustomer = customerIds.map(rootId => {
      const rows = custRows.filter(r => rootOf(custKey(r)) === rootId);
      // Display name: prefer the root customer's own name if it's a member of this group,
      // otherwise fall back to whichever member's name we actually have on a cost line row —
      // a rolled-up group reads by its parent's name, a standalone customer reads by its own.
      const nameRow = rows.find(r => custKey(r) === rootId) || rows[0];
      return { customerId: rootId, customerName: custName(nameRow), ...aggregate(rows), weeks: weeklyBreakdown(rows) };
    }).sort((a, b) => (b.totalSellUsd || 0) - (a.totalSellUsd || 0));

    // Multi-Entity Accounting (TKT-EEV4I9) — same aggregate()/weeklyBreakdown() reuse as
    // byCarrier/byLane/byCustomer above, just grouped by resolved entity (branch) instead.
    // Scoped to the caller's own branch unless global (callerEntityScope) — deliberately NOT
    // applied to byCarrier/byLane/byCustomer, which stay company-wide exactly as today; entity
    // is the one dimension that maps onto a real legal/branch boundary worth restricting.
    const entityScope = await callerEntityScope(req);
    const entityRows  = lines.filter(r => r.entity_id);
    const entityIds   = [...new Set(entityRows.map(r => r.entity_id))]
      .filter(id => entityScope === null || entityScope.has(id));
    const byEntity = await Promise.all(entityIds.map(async entityId => {
      const rows = entityRows.filter(r => r.entity_id === entityId);
      const nameRow = rows[0];
      const currency = nameRow.entity_currency || 'USD';
      const agg = aggregate(rows);
      const localBuy  = await fromUsd(agg.totalBuyUsd,  currency);
      const localSell = await fromUsd(agg.totalSellUsd, currency);
      return {
        entityId, entityName: nameRow.entity_name || entityId, currency,
        localBuy, localSell, localGp: roundCents(localSell - localBuy),
        ...agg, weeks: weeklyBreakdown(rows),
      };
    }));
    byEntity.sort((a, b) => (b.totalSellUsd || 0) - (a.totalSellUsd || 0));

    ok(res, { ...overall, byCarrier, byLane, byCustomer, byEntity });
  });
};
