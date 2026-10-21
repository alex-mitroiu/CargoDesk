"use strict";

// GET /api/where-to-book (Epic TKT-KFGL81, Story 2 TKT-BI1QS7): the steering answer — the line, each
// option's status and space, and the pick (lib/where-to-book.js) — for a shipment (?shipmentId=), or
// for typed-in values (?customerId, pol, pod, etd, cargoReadyDate, commodityCode, loopCode, teu and the
// haulage flags the space match takes), which is Lane Steering's Check box. Read-only, open to every
// signed-in user; a shipment only to those who can see it.

module.exports = function whereToBookRoutes(app, ctx) {
  const { query, ok, err, auth, mapShipment, applyShipmentAccessFilter } = ctx;
  const flag = v => v === "1" || v === "true";

  app.get("/api/where-to-book", auth(), async (req, res) => {
    const q = req.query;
    if (q.shipmentId) {
      const [row] = await query("SELECT * FROM shipments WHERE id=$1", [q.shipmentId]);
      const [seen] = row ? await applyShipmentAccessFilter([mapShipment(row)], req.user, req) : [];
      if (!seen) return err(res, "Shipment not found", 404);
      return ok(res, await ctx.whereToBook.forShipment(row));
    }
    if (!q.pol || !q.pod) return err(res, "pol and pod are required");
    ok(res, await ctx.whereToBook.whereToBook({
      customerId: q.customerId, pol: q.pol, pod: q.pod, etd: q.etd, cargoReadyDate: q.cargoReadyDate,
      commodityCode: q.commodityCode, loopCode: q.loopCode, teu: q.teu,
      needsPolHaulage: flag(q.needsPolHaulage), needsPodHaulage: flag(q.needsPodHaulage), pkuLocation: q.pkuLocation, delLocation: q.delLocation,
    }));
  });

  // GET /api/reports/steering (Story 4 TKT-Q2E7WN): the shipments with an ETD (else a cargo-ready date)
  // in the dates, sorted by the verdict saved when their contract was (lib/where-to-book.js
  // recordVerdict), with the steering rate — followed ÷ everything in the rate — by trade lane and by
  // carrier, and the ones that didn't follow. Customer Own and not-yet-contracted shipments are left
  // out; Not covered and Not recorded (assigned before this was recorded) are counted outside the rate.
  // Optional carrier (comma list), lane ("EU-N → NAM") and office (either side's). Scoped like the
  // Shipments list.
  const FOLLOWED = ["steered", "rebooked"];
  const NOT_FOLLOWED = ["out_of_order", "other_contract", "other_carrier", "spot", "other_loop"];
  const VERDICTS = [...FOLLOWED, ...NOT_FOLLOWED, "not_covered", "not_recorded"];
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const rateOf = (followed, inRate) => (inRate ? Math.round((followed / inRate) * 1000) / 10 : null);
  app.get("/api/reports/steering", auth(), async (req, res) => {
    const q = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const from = DAY.test(q.from || "") ? q.from : `${today.slice(0, 7)}-01`, to = DAY.test(q.to || "") ? q.to : today;
    if (to < from) return err(res, "to must be on or after from");
    const carriers = String(q.carrier || "").split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
    const rows = await query(`SELECT * FROM shipments
      WHERE COALESCE(status, '') <> 'Cancelled'
        AND COALESCE(contract_type, '') NOT IN ('Customer Own', 'Pending', '')
        AND COALESCE(steering_verdict, '') NOT IN ('customer_own', 'no_contract')
        AND LEFT(COALESCE(NULLIF(etd, ''), cargo_ready_date, ''), 10) BETWEEN $1 AND $2`, [from, to]);
    let list = await applyShipmentAccessFilter(rows.map(mapShipment), req.user, req);
    if (carriers.length) list = list.filter(s => carriers.includes(s.carrierCode));
    if (q.lane) list = list.filter(s => s.tradeLane === q.lane);
    if (q.office) list = list.filter(s => s.emoOfficeId === q.office || s.imoOfficeId === q.office);

    const verdictOf = s => s.steeringVerdict || "not_recorded";
    const counts = Object.fromEntries(VERDICTS.map(v => [v, 0]));
    const lanes = new Map(), byCarrier = new Map();
    for (const s of list) {
      const v = verdictOf(s);
      counts[v] = (counts[v] || 0) + 1;
      const lane = lanes.get(s.tradeLane) || { lane: s.tradeLane, followed: 0, notFollowed: 0, notCovered: 0, notRecorded: 0 };
      const car = byCarrier.get(s.carrierCode) || { carrierCode: s.carrierCode, shipments: 0, followed: 0, notFollowed: 0 };
      car.shipments++;
      if (FOLLOWED.includes(v)) { lane.followed++; car.followed++; }
      else if (NOT_FOLLOWED.includes(v)) { lane.notFollowed++; car.notFollowed++; }
      else if (v === "not_covered") lane.notCovered++;
      else lane.notRecorded++;
      lanes.set(s.tradeLane, lane);
      byCarrier.set(s.carrierCode, car);
    }
    const followed = FOLLOWED.reduce((n, v) => n + counts[v], 0), notFollowed = NOT_FOLLOWED.reduce((n, v) => n + counts[v], 0);
    ok(res, {
      from, to, total: list.length, counts, followed, notFollowed, inRate: followed + notFollowed, rate: rateOf(followed, followed + notFollowed),
      byLane: [...lanes.values()].map(l => ({ ...l, inRate: l.followed + l.notFollowed, rate: rateOf(l.followed, l.followed + l.notFollowed) }))
        .sort((a, b) => (b.inRate - a.inRate) || a.lane.localeCompare(b.lane)),
      byCarrier: [...byCarrier.values()].sort((a, b) => (b.shipments - a.shipments) || a.carrierCode.localeCompare(b.carrierCode)),
      notFollowedShipments: list.filter(s => NOT_FOLLOWED.includes(verdictOf(s)))
        .map(s => ({ id: s.id, etd: (s.etd || s.cargoReadyDate || "").slice(0, 10), lane: s.tradeLane, carrierCode: s.carrierCode,
          contractType: s.contractType, contractRef: s.contractRef, verdict: s.steeringVerdict, rank: s.steeringRank, pick: s.steeringPick, reason: s.steeringReason }))
        .sort((a, b) => b.etd.localeCompare(a.etd)),
    });
  });
};
