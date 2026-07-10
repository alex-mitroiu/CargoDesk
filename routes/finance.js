"use strict";

module.exports = function financeRoutes(app, ctx) {
  const { db, ok, err, auth } = ctx;

  app.get("/api/margin/summary", auth(), (req, res) => {
    const u = req.user;
    const roles = Array.isArray(u.roles) ? u.roles : [u.role || 'viewer'];
    if (!roles.includes('admin') && !u.canViewFinance)
      return err(res, "Finance access not enabled for your account", 403);
    const lines = db.prepare(`
      SELECT cl.*, s.carrier_code, s.pol, s.pod, s.etd, s.created_at AS shp_created_at
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
      return { totalBuyUsd: Math.round(buy * 100) / 100, totalSellUsd: Math.round(sell * 100) / 100, grossProfitUsd: Math.round(gp * 100) / 100, grossMarginPct: pct };
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

    ok(res, { ...overall, byCarrier, byLane });
  });
};
