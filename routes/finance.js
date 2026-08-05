"use strict";

module.exports = function financeRoutes(app, ctx) {
  const { db, ok, err, auth, resolveCustomerGroup, roundCents } = ctx;

  app.get("/api/margin/summary", auth(), (req, res) => {
    const u = req.user;
    const roles = Array.isArray(u.roles) ? u.roles : [u.role || 'viewer'];
    if (!roles.includes('admin') && !u.canViewFinance)
      return err(res, "Finance access not enabled for your account", 403);
    const lines = db.prepare(`
      SELECT cl.*, s.carrier_code, s.pol, s.pod, s.etd, s.created_at AS shp_created_at,
             s.principal_id, s.principal_name, s.consignee_id, s.consignee_name
      FROM shipment_cost_lines cl
      JOIN shipments s ON s.id = cl.shipment_id
    `).all();

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
    const rootCache = new Map();
    const rootOf = id => {
      if (!groupByParent || !id) return id;
      if (!rootCache.has(id)) rootCache.set(id, resolveCustomerGroup(id)[0]);
      return rootCache.get(id);
    };
    const custRows = lines.filter(r => custKey(r));
    const customerIds = [...new Set(custRows.map(r => rootOf(custKey(r))))];
    const byCustomer = customerIds.map(rootId => {
      const rows = custRows.filter(r => rootOf(custKey(r)) === rootId);
      // Display name: prefer the root customer's own name if it's a member of this group,
      // otherwise fall back to whichever member's name we actually have on a cost line row —
      // a rolled-up group reads by its parent's name, a standalone customer reads by its own.
      const nameRow = rows.find(r => custKey(r) === rootId) || rows[0];
      return { customerId: rootId, customerName: custName(nameRow), ...aggregate(rows), weeks: weeklyBreakdown(rows) };
    }).sort((a, b) => (b.totalSellUsd || 0) - (a.totalSellUsd || 0));

    ok(res, { ...overall, byCarrier, byLane, byCustomer });
  });
};
