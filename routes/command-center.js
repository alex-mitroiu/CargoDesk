"use strict";

// Command Center — Quality & Exception Management (Cargo iQ-Inspired), Epic TKT-IBHB0K.
// Four bulk-scoped, applyShipmentAccessFilter-scoped endpoints backing the Command Center's new
// timeliness/quality layer — mirrors the shape GET /api/invoice-deadlines/overdue already
// established (routes/customers.js): plain auth(), no reportsGate (Command Center itself has no
// role gate at all — every authenticated role sees it on the Home page), scoped per-caller.
module.exports = function commandCenterRoutes(app, ctx) {
  const { query, ok, auth, applyShipmentAccessFilter, mapShipment, getSettings, callMdmService } = ctx;
  const isRemote = async () => ((await getSettings()).mdm_source || "local") === "remote";

  // Shared by all four routes below — every not-Cancelled shipment this caller can see (mirrors
  // CommandCenterView's own overdueShipments definition, which excludes Completed/Cancelled; the
  // scorecard/trend routes intentionally do NOT reuse this — past performance on Completed
  // shipments is exactly the signal a scorecard/trend needs, so they scope from the full set).
  async function scopedActiveShipments(req) {
    const rows = await query("SELECT * FROM shipments WHERE status NOT IN ('Completed','Cancelled')");
    return await applyShipmentAccessFilter(rows.map(mapShipment), req.user, req);
  }
  async function scopedAllShipments(req) {
    const rows = await query("SELECT * FROM shipments");
    return await applyShipmentAccessFilter(rows.map(mapShipment), req.user, req);
  }
  // Builds a "$N,$N+1,..." placeholder list for `ids`, continuing from after however many
  // params already precede it (e.g. a leading `today` value) — callers pass the full params
  // array (already containing those leading values) and get both the clause and updated array.
  const idsClause = (ids, leadingParams = []) => ({
    sql: ids.map((_, i) => `$${leadingParams.length + i + 1}`).join(","),
    params: [...leadingParams, ...ids],
  });

  // TKT-550J25 — fleet-wide milestone on-time KPI + per-milestone-key breakdown. Reuses
  // milestoneState()'s own "overdue" definition (ShipmentDetailPage.jsx's MilestonePanel):
  // !completedAt && estimatedDate && estimatedDate < today — just aggregated across the whole
  // scoped book instead of one shipment at a time. Also backs TKT-Q09G0T's bell/alert feed.
  app.get("/api/milestones/overdue-summary", auth(), async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const shipments = await scopedActiveShipments(req);
    const idSet = new Set(shipments.map(s => s.id));
    if (idSet.size === 0) {
      return ok(res, { totalActiveShipments: 0, shipmentsWithBreach: 0, onTimePct: 100, byMilestoneKey: [], items: [] });
    }
    const ids = [...idSet];
    const { sql: ph, params } = idsClause(ids, [today]);
    const rows = await query(`
      SELECT shipment_id, milestone_key, label, estimated_date
      FROM shipment_milestones
      WHERE completed_at = '' AND estimated_date != '' AND estimated_date < $1
        AND shipment_id IN (${ph})
    `, params);

    const byKey = {};
    const breached = new Set();
    const items = [];
    for (const m of rows) {
      breached.add(m.shipment_id);
      byKey[m.milestone_key] ??= { milestoneKey: m.milestone_key, label: m.label, count: 0 };
      byKey[m.milestone_key].count++;
      const daysOverdue = Math.floor((Date.now() - new Date(m.estimated_date).getTime()) / 86400000);
      items.push({ shipmentId: m.shipment_id, milestoneKey: m.milestone_key, label: m.label, estimatedDate: m.estimated_date, daysOverdue });
    }
    items.sort((a, b) => b.daysOverdue - a.daysOverdue);
    const total = idSet.size;
    ok(res, {
      totalActiveShipments: total,
      shipmentsWithBreach: breached.size,
      onTimePct: total > 0 ? Math.round((1 - breached.size / total) * 100) : 100,
      byMilestoneKey: Object.values(byKey).sort((a, b) => b.count - a.count),
      items: items.slice(0, 50),
    });
  });

  // TKT-FKJPBO — exception queue, classified by root cause rather than one blunt "Overdue"
  // bucket. Three independent classifications (a shipment can appear in more than one):
  //   scheduleSlip        — an AIS-reconfirmed SEA leg date landed later than the shipment's own
  //                          committed milestone estimate (the carrier actually moved the date)
  //   unconfirmedBooking  — ETD has passed but the carrier_bookings row never left Pending/Created
  //   stalledMilestone    — the shipment's current (first-incomplete) milestone's own
  //                          estimatedDate has passed, independent of ETD
  app.get("/api/exceptions/queue", auth(), async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const shipments = await scopedActiveShipments(req);
    const idSet = new Set(shipments.map(s => s.id));
    if (idSet.size === 0) return ok(res, { scheduleSlip: [], unconfirmedBooking: [], stalledMilestone: [] });
    const ids = [...idSet];
    const { sql: ph, params: idsParams } = idsClause(ids);
    const shipmentById = new Map(shipments.map(s => [s.id, s]));

    // scheduleSlip
    const legs = await query(`
      SELECT shipment_id, id AS leg_id, pol, pod, etd, eta, etd_source, eta_source
      FROM shipment_legs
      WHERE (mot='SEA' OR leg_type='SEA') AND (etd_source='ais' OR eta_source='ais')
        AND shipment_id IN (${ph})
    `, idsParams);
    const msByShipment = {};
    if (legs.length) {
      (await query(`
        SELECT shipment_id, milestone_key, estimated_date FROM shipment_milestones
        WHERE milestone_key IN ('vessel_departed','vessel_arrived') AND shipment_id IN (${ph})
      `, idsParams)).forEach(m => { (msByShipment[m.shipment_id] ??= {})[m.milestone_key] = m.estimated_date; });
    }
    const scheduleSlip = [];
    for (const l of legs) {
      const ms = msByShipment[l.shipment_id] || {};
      if (l.etd_source === 'ais' && l.etd && ms.vessel_departed && l.etd > ms.vessel_departed) {
        scheduleSlip.push({ shipmentId: l.shipment_id, legId: l.leg_id, pol: l.pol, pod: l.pod,
          milestoneKey: 'vessel_departed', estimatedDate: ms.vessel_departed, confirmedDate: l.etd,
          daysSlipped: Math.round((new Date(l.etd) - new Date(ms.vessel_departed)) / 86400000) });
      }
      if (l.eta_source === 'ais' && l.eta && ms.vessel_arrived && l.eta > ms.vessel_arrived) {
        scheduleSlip.push({ shipmentId: l.shipment_id, legId: l.leg_id, pol: l.pol, pod: l.pod,
          milestoneKey: 'vessel_arrived', estimatedDate: ms.vessel_arrived, confirmedDate: l.eta,
          daysSlipped: Math.round((new Date(l.eta) - new Date(ms.vessel_arrived)) / 86400000) });
      }
    }
    scheduleSlip.sort((a, b) => b.daysSlipped - a.daysSlipped);

    // unconfirmedBooking
    const bookings = await query(`
      SELECT shipment_id, carrier_code, status, requested_at
      FROM carrier_bookings WHERE status IN ('Pending','Created') AND shipment_id IN (${ph})
    `, idsParams);
    const unconfirmedBooking = [];
    for (const b of bookings) {
      const s = shipmentById.get(b.shipment_id);
      if (!s || !s.etd || s.etd >= today) continue;
      unconfirmedBooking.push({ shipmentId: b.shipment_id, carrierCode: b.carrier_code || s.carrierCode,
        bookingStatus: b.status, etd: s.etd,
        daysPastEtd: Math.floor((Date.now() - new Date(s.etd).getTime()) / 86400000) });
    }
    unconfirmedBooking.sort((a, b) => b.daysPastEtd - a.daysPastEtd);

    // stalledMilestone
    const { sql: phWithToday, params: stalledParams } = idsClause(ids, [today]);
    const stalledRows = await query(`
      SELECT shipment_id, milestone_key, label, estimated_date
      FROM shipment_milestones m
      WHERE completed_at = '' AND estimated_date != '' AND estimated_date < $1
        AND sequence_order = (
          SELECT MIN(sequence_order) FROM shipment_milestones m2
          WHERE m2.shipment_id = m.shipment_id AND m2.completed_at = ''
        )
        AND shipment_id IN (${phWithToday})
    `, stalledParams);
    const stalledMilestone = stalledRows.map(m => ({
      shipmentId: m.shipment_id, milestoneKey: m.milestone_key, label: m.label,
      estimatedDate: m.estimated_date,
      daysStalled: Math.floor((Date.now() - new Date(m.estimated_date).getTime()) / 86400000),
    })).sort((a, b) => b.daysStalled - a.daysStalled);

    ok(res, { scheduleSlip, unconfirmedBooking, stalledMilestone });
  });

  // TKT-LI5KYW — carrier on-time-performance scorecard. Only AIS-confirmed actuals count (a
  // manual-only date isn't a reliable "actual" signal, per the ticket's own explicit scope
  // note) — a shipment with no AIS confirmation yet simply contributes no sample, it is never
  // counted as late. Scoped from the FULL shipment set (not just active) — past performance on
  // already-Completed shipments is exactly the signal a scorecard needs.
  // Namespaced under /api/command-center/* rather than /api/carriers/* — routes/mdm.js already
  // registers GET /api/carriers/:code ahead of this file in server.js's require order, so
  // /api/carriers/on-time-scorecard would be swallowed by that :code route (Express first-match)
  // and 404 as an unknown carrier code. Confirmed live before settling on this path.
  app.get("/api/command-center/carrier-scorecard", auth(), async (req, res) => {
    const tolerance = Math.max(0, parseInt(req.query.toleranceDays, 10) || 1);
    const shipments = await scopedAllShipments(req);
    const shipmentById = new Map(shipments.map(s => [s.id, s]));
    const ids = shipments.map(s => s.id);
    if (!ids.length) return ok(res, []);
    const { sql: ph, params: idsParams } = idsClause(ids);
    const legs = await query(`
      SELECT shipment_id, carrier_code, etd, eta, etd_source, eta_source
      FROM shipment_legs
      WHERE (mot='SEA' OR leg_type='SEA') AND (etd_source='ais' OR eta_source='ais')
        AND shipment_id IN (${ph})
    `, idsParams);
    if (!legs.length) return ok(res, []);
    const msByShipment = {};
    (await query(`
      SELECT shipment_id, milestone_key, estimated_date FROM shipment_milestones
      WHERE milestone_key IN ('vessel_departed','vessel_arrived') AND shipment_id IN (${ph})
    `, idsParams)).forEach(m => { (msByShipment[m.shipment_id] ??= {})[m.milestone_key] = m.estimated_date; });

    const dayDiff = (a, b) => Math.abs(Math.round((new Date(a) - new Date(b)) / 86400000));
    const stats = {};
    for (const l of legs) {
      const s = shipmentById.get(l.shipment_id);
      if (!s) continue;
      const code = l.carrier_code || s.carrierCode;
      if (!code) continue;
      const ms = msByShipment[l.shipment_id] || {};
      const samples = [];
      if (l.etd_source === 'ais' && l.etd && ms.vessel_departed) samples.push(dayDiff(l.etd, ms.vessel_departed) <= tolerance);
      if (l.eta_source === 'ais' && l.eta && ms.vessel_arrived) samples.push(dayDiff(l.eta, ms.vessel_arrived) <= tolerance);
      if (!samples.length) continue;
      stats[code] ??= { carrierCode: code, onTime: 0, total: 0 };
      for (const onTime of samples) { stats[code].total++; if (onTime) stats[code].onTime++; }
    }
    // mdm_source branch added per the loop-integration audit's own recurring finding class
    // (routes/loop-codes.js, resolveSeaPorts, linkedPortCodes, resolveInvoiceThresholds) — this
    // read carriers straight from the local table with no remote-mode awareness at all.
    let carrierNames = {};
    if (await isRemote()) {
      try {
        const rows = await callMdmService("GET", "/internal/carriers");
        carrierNames = Object.fromEntries((rows || []).map(c => [c.code, c.name]));
      } catch { /* leave carrierNames empty — clean-degrade to showing the bare carrier code, same as every other remote MDM lookup here on failure */ }
    } else {
      carrierNames = Object.fromEntries((await query("SELECT code, name FROM carriers")).map(c => [c.code, c.name]));
    }
    const results = Object.values(stats).map(c => ({
      carrierCode: c.carrierCode, carrierName: carrierNames[c.carrierCode] || c.carrierCode,
      sampleSize: c.total, onTimeCount: c.onTime,
      onTimePct: c.total > 0 ? Math.round(c.onTime / c.total * 100) : null,
    })).sort((a, b) => (a.onTimePct ?? 999) - (b.onTimePct ?? 999));
    ok(res, results);
  });

  // TKT-PZ3JS2 — transit-time variance / cycle-time trend, per trade lane over time. Planned =
  // shipment_schedules.transit_days (most recently saved per shipment); actual = the ETD->ETA
  // span reconstructed from AIS-confirmed SEA leg dates only (min confirmed ETD across the
  // shipment's SEA legs to max confirmed ETA, so a TSP's transshipment dwell time is correctly
  // folded into the whole-journey span rather than summed leg-by-leg). Bucketed by the
  // shipment's own tradeLane (mapShipment) x the month its journey departed.
  app.get("/api/command-center/transit-time-trend", auth(), async (req, res) => {
    const shipments = await scopedAllShipments(req);
    const shipmentById = new Map(shipments.map(s => [s.id, s]));
    const ids = shipments.map(s => s.id);
    if (!ids.length) return ok(res, []);
    const { sql: ph, params: idsParams } = idsClause(ids);

    const legs = await query(`
      SELECT shipment_id, etd, eta FROM shipment_legs
      WHERE (mot='SEA' OR leg_type='SEA') AND etd_source='ais' AND eta_source='ais'
        AND shipment_id IN (${ph})
    `, idsParams);
    const actualByShipment = {};
    for (const l of legs) {
      if (!l.etd || !l.eta || l.eta < l.etd) continue;
      const cur = actualByShipment[l.shipment_id];
      if (!cur) actualByShipment[l.shipment_id] = { minEtd: l.etd, maxEta: l.eta };
      else {
        if (l.etd < cur.minEtd) cur.minEtd = l.etd;
        if (l.eta > cur.maxEta) cur.maxEta = l.eta;
      }
    }
    if (!Object.keys(actualByShipment).length) return ok(res, []);

    const schedules = await query(`
      SELECT shipment_id, transit_days, saved_at FROM shipment_schedules
      WHERE shipment_id IN (${ph}) AND transit_days > 0
    `, idsParams);
    const plannedByShipment = {};
    for (const sc of schedules) {
      const cur = plannedByShipment[sc.shipment_id];
      if (!cur || sc.saved_at > cur.savedAt) plannedByShipment[sc.shipment_id] = { transitDays: sc.transit_days, savedAt: sc.saved_at };
    }

    const buckets = {};
    for (const [shipmentId, actual] of Object.entries(actualByShipment)) {
      const s = shipmentById.get(shipmentId);
      if (!s || !s.tradeLane || !s.etd) continue;
      const actualDays = Math.round((new Date(actual.maxEta) - new Date(actual.minEtd)) / 86400000);
      const planned = plannedByShipment[shipmentId];
      const month = s.etd.slice(0, 7);
      const key = `${s.tradeLane}|${month}`;
      buckets[key] ??= { tradeLane: s.tradeLane, month, plannedSum: 0, plannedN: 0, actualSum: 0, actualN: 0 };
      buckets[key].actualSum += actualDays; buckets[key].actualN++;
      if (planned) { buckets[key].plannedSum += planned.transitDays; buckets[key].plannedN++; }
    }
    const results = Object.values(buckets).map(b => ({
      tradeLane: b.tradeLane, month: b.month,
      actualAvgDays: b.actualN ? Math.round(b.actualSum / b.actualN * 10) / 10 : null,
      plannedAvgDays: b.plannedN ? Math.round(b.plannedSum / b.plannedN * 10) / 10 : null,
      varianceDays: (b.actualN && b.plannedN) ? Math.round((b.actualSum / b.actualN - b.plannedSum / b.plannedN) * 10) / 10 : null,
      sampleSize: b.actualN,
    })).sort((a, b) => a.tradeLane.localeCompare(b.tradeLane) || a.month.localeCompare(b.month));
    ok(res, results);
  });
};
