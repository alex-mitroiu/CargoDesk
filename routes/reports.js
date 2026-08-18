"use strict";

// GP-by-trade-area report — aggregates every shipment's own BUY/SELL cost lines by the
// shipment's origin (POL) region, country, or carrier, reusing the exact same
// GpBreakdownPanel/ShipmentGpSankey the single-shipment GP Overview page already renders (see
// src/pages/ReportsPage.jsx) — only the underlying `lines` array is scoped differently, to a
// whole group instead of one shipment. ("gp-by-geo" is the route's original, narrower name from
// before carrier grouping existed — kept as-is rather than renamed, since nothing outside this
// file and ReportsPage.jsx depends on it and a rename buys nothing.)
//
// Origin (POL), not destination or the full lane, is deliberately the attribution side for
// region/country grouping — the simplest, most defensible v1 given there's no existing "which
// end owns this P&L" convention in this codebase to defer to; matches how `tradeLane` itself
// already leads with the POL-derived lane. Also uses the shipment's raw `pol` (door-to-door
// bookend), the same simplification GET /api/margin/summary's own byLane breakdown already
// makes, rather than resolving the real SEA leg via resolveSeaPorts() — worth revisiting
// together if this ever needs to be precise for a Door-pickup-heavy trade lane.
//
// "Region" here means trade lane (`trade_lanes`/`country_trade_lanes`) — the SAME geography
// already surfaced everywhere else in the app as the shipment "Trade Lane" field (e.g.
// "EU-N → NAM"), not the separate `regions`/`countries.region_code` MDM table. Confirmed live
// that the latter is scaffolded but never actually populated (every country's region_code is
// blank in this data) while country_trade_lanes has real, complete coverage — using the dormant
// one would make "By Region" permanently empty.
module.exports = function reportsRoutes(app, ctx) {
  const { db, ok, err, auth, mapCostLine, roundCents, portCountryMap, getSettings } = ctx;

  const financeGate = (req, res) => {
    const u = req.user;
    const roles = Array.isArray(u.roles) ? u.roles : [u.role || 'viewer'];
    if (!roles.includes('admin') && !u.canViewFinance) { err(res, "Finance access not enabled for your account", 403); return false; }
    return true;
  };

  function escCSV(v) {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // Plain-date arithmetic (YYYY-MM-DD in, YYYY-MM-DD out) for the period-over-period comparison
  // below — no timezone library needed since every date this app deals with here is already a
  // bare date string (ETD or created_at, sliced to 10 chars).
  function shiftDate(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  const GROUP_LABEL = { region: "Region", country: "Country", carrier: "Carrier" };

  app.get("/api/reports/gp-by-geo", auth(), (req, res) => {
    if (!financeGate(req, res)) return;
    const groupBy = ['region', 'country', 'carrier'].includes(req.query.groupBy) ? req.query.groupBy : 'country';
    const value = (req.query.value || '').trim();
    const dateFrom = (req.query.from || '').trim();
    const dateTo   = (req.query.to || '').trim();
    const format = req.query.format === 'csv' ? 'csv' : 'json';

    const allRows = db.prepare(`
      SELECT cl.*, s.pol, s.carrier_code, s.etd, s.created_at AS shp_created_at
      FROM shipment_cost_lines cl
      JOIN shipments s ON s.id = cl.shipment_id
    `).all();
    let rows = allRows;

    // Same reference-date convention GET /api/margin/summary's own weeklyBreakdown already
    // uses — a shipment's ETD when it has one, its own created_at otherwise — so a shipment
    // still in planning (no ETD yet) doesn't just silently vanish from every date-ranged report.
    if (dateFrom || dateTo) {
      rows = allRows.filter(r => {
        const ref = (r.etd || r.shp_created_at || '').slice(0, 10);
        if (dateFrom && ref < dateFrom) return false;
        if (dateTo && ref > dateTo) return false;
        return true;
      });
    }

    const countryNames = {};
    db.prepare("SELECT iso2, name FROM countries").all().forEach(c => { countryNames[c.iso2] = c.name; });
    const countryLane = {};
    db.prepare("SELECT iso2, lane_code FROM country_trade_lanes").all()
      .forEach(r => { if (!(r.iso2 in countryLane)) countryLane[r.iso2] = r.lane_code; });
    const laneNames = {};
    db.prepare("SELECT code, name FROM trade_lanes").all().forEach(l => { laneNames[l.code] = l.name; });
    const carrierNames = {};
    db.prepare("SELECT code, name FROM carriers").all().forEach(c => { carrierNames[c.code] = c.name; });

    const keyOf = row => {
      if (groupBy === 'carrier') return row.carrier_code || '';
      const iso2 = portCountryMap[row.pol] || '';
      if (!iso2) return '';
      return groupBy === 'region' ? (countryLane[iso2] || '') : iso2;
    };
    const nameOf = key => groupBy === 'carrier' ? (carrierNames[key] || key)
      : groupBy === 'region' ? (laneNames[key] || key) : (countryNames[key] || key);

    // Period-over-period comparison — only meaningful when the caller has picked a genuine,
    // bounded window on both ends; an open-ended range ("any" From or To) has no defensible
    // "prior period" of the same length to diff against, so comparison is simply omitted
    // rather than guessed at (surfaced to the frontend as comparisonAvailable:false).
    let prevMarginByKey = null;
    if (dateFrom && dateTo) {
      const spanDays = Math.round((new Date(`${dateTo}T00:00:00Z`) - new Date(`${dateFrom}T00:00:00Z`)) / 86400000) + 1;
      const prevTo = shiftDate(dateFrom, -1);
      const prevFrom = shiftDate(dateFrom, -spanDays);
      const prevRows = allRows.filter(r => {
        const ref = (r.etd || r.shp_created_at || '').slice(0, 10);
        return ref >= prevFrom && ref <= prevTo;
      });
      const byKeyPrev = new Map();
      for (const row of prevRows) {
        const key = keyOf(row);
        if (!key) continue;
        if (!byKeyPrev.has(key)) byKeyPrev.set(key, []);
        byKeyPrev.get(key).push(row);
      }
      prevMarginByKey = new Map();
      for (const [key, rowsForKey] of byKeyPrev) {
        const mapped = rowsForKey.map(mapCostLine);
        const sell = mapped.filter(l => l.type === 'SELL').reduce((s, l) => s + l.amountUsd, 0);
        const buy  = mapped.filter(l => l.type === 'BUY').reduce((s, l) => s + l.amountUsd, 0);
        const sellRounded = roundCents(sell), gpRounded = roundCents(sell - buy);
        prevMarginByKey.set(key, sellRounded > 0 ? Math.round((gpRounded / sellRounded) * 1000) / 10 : null);
      }
    }

    if (!value) {
      const byKey = new Map();
      for (const row of rows) {
        const key = keyOf(row);
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, { lines: [], shipmentIds: new Set() });
        const bucket = byKey.get(key);
        bucket.lines.push(row);
        bucket.shipmentIds.add(row.shipment_id);
      }
      let results = [...byKey.entries()].map(([key, bucket]) => {
        const mapped = bucket.lines.map(mapCostLine);
        const sell = mapped.filter(l => l.type === 'SELL').reduce((s, l) => s + l.amountUsd, 0);
        const buy  = mapped.filter(l => l.type === 'BUY').reduce((s, l) => s + l.amountUsd, 0);
        const totalSellUsd = roundCents(sell), totalBuyUsd = roundCents(buy), grossProfitUsd = roundCents(sell - buy);
        const grossMarginPct = totalSellUsd > 0 ? Math.round((grossProfitUsd / totalSellUsd) * 1000) / 10 : null;
        const prevMarginPct = prevMarginByKey ? (prevMarginByKey.has(key) ? prevMarginByKey.get(key) : null) : null;
        const marginDeltaPts = (grossMarginPct != null && prevMarginPct != null)
          ? Math.round((grossMarginPct - prevMarginPct) * 10) / 10 : null;
        return { code: key, name: nameOf(key), shipmentCount: bucket.shipmentIds.size,
          totalSellUsd, totalBuyUsd, grossProfitUsd, grossMarginPct, marginDeltaPts };
      });
      // Worst-margin-first once a target's configured (see Application Settings -> Finance ->
      // "Reports - GP Target") — that's the whole point of the setting, surfacing the problem
      // rows without a manual scan. No target set -> falls back to the original sell-volume-
      // desc ordering, since there's nothing to rank against.
      const targetPct = parseFloat((getSettings() || {}).gp_target_pct);
      const hasTarget = !isNaN(targetPct);
      results.sort(hasTarget
        ? (a, b) => (a.grossMarginPct ?? Infinity) - (b.grossMarginPct ?? Infinity)
        : (a, b) => b.totalSellUsd - a.totalSellUsd);

      if (format === 'csv') {
        const cols = [
          [GROUP_LABEL[groupBy], r => r.name], ["Code", r => r.code], ["Shipments", r => r.shipmentCount],
          ["Sell (USD)", r => r.totalSellUsd], ["Buy (USD)", r => r.totalBuyUsd],
          ["Gross Profit (USD)", r => r.grossProfitUsd], ["Margin %", r => r.grossMarginPct ?? ""],
          ...(prevMarginByKey ? [["Margin Δ vs Prior Period (pts)", r => r.marginDeltaPts ?? ""]] : []),
        ];
        const header = cols.map(([label]) => escCSV(label)).join(",");
        const body = results.map(r => cols.map(([, fn]) => escCSV(fn(r))).join(",")).join("\n");
        const date = new Date().toISOString().slice(0, 10);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="reports-by-${groupBy}-${date}.csv"`);
        return res.send(`${header}\n${body}`);
      }
      return ok(res, { results, targetPct: hasTarget ? targetPct : null, comparisonAvailable: !!prevMarginByKey });
    }

    const lines = rows.filter(r => keyOf(r) === value).map(mapCostLine);
    if (format === 'csv') {
      const cols = [
        ["Type", r => r.type], ["Charge Code", r => r.chargeCode], ["Currency", r => r.currency],
        ["Amount", r => r.amount], ["Amount (USD)", r => r.amountUsd],
        ["Actual (USD)", r => r.actualAmountUsd ?? ""], ["Status", r => r.status],
        ["Payment Indicator", r => r.paymentIndicator], ["Shipment ID", r => r.shipmentId],
      ];
      const header = cols.map(([label]) => escCSV(label)).join(",");
      const body = lines.map(r => cols.map(([, fn]) => escCSV(fn(r))).join(",")).join("\n");
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="reports-${groupBy}-${value}-${date}.csv"`);
      return res.send(`${header}\n${body}`);
    }
    ok(res, lines);
  });
};
