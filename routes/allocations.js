"use strict";

module.exports = function allocationsRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, mapAllocation, checkOverlap, logEntityEvent, linkedPortCodes, findMatchingContractLeg } = ctx;

  // Space configurations are full-CRUD for trade_manager alongside admin/operator —
  // previously these write routes had no role gate at all.
  const write = requireRole(["admin", "operator", "trade_manager"]);

  app.get("/api/allocations", (req, res) => {
    ok(res, db.prepare("SELECT * FROM allocations ORDER BY effective_date DESC").all().map(mapAllocation));
  });

  app.post("/api/allocations", write, (req, res) => {
    const { carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane = '', notes = '',
            alertThreshold = 80, pol = '', pod = '', originLane = '', destLane = '', coverageScope = 'STRICT',
            contractId = '', contractNumber = '' } = req.body;
    if (!carrierCode || allocatedTEU == null || !effectiveDate || !endDate || !pol || !pod)
      return err(res, "carrierCode, allocatedTEU, effectiveDate, endDate, pol, pod all required");
    if (!contractId) return err(res, "contractId required");
    if (endDate < effectiveDate) return err(res, "end date must be on or after effective date");
    if (checkOverlap(carrierCode, effectiveDate, endDate, pol, pod))
      return err(res, `An allocation for ${carrierCode} on route ${pol.toUpperCase()} → ${pod.toUpperCase()} already covers that date range`);
    const id = `ALC-${uid()}`;
    db.prepare("INSERT INTO allocations (id,carrier_code,allocated_teu,effective_date,end_date,trade_lane,notes,alert_threshold,pol,pod,origin_lane,dest_lane,coverage_scope,contract_id,contract_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane, notes, alertThreshold, pol.toUpperCase(), pod.toUpperCase(), originLane, destLane, coverageScope, contractId, contractNumber);
    logEntityEvent('allocation', id, 'CREATED', null, null, null,
      JSON.stringify({ carrierCode, pol: pol.toUpperCase(), pod: pod.toUpperCase(), allocatedTEU, effectiveDate, endDate, contractNumber }));
    ok(res, mapAllocation({ id, carrier_code: carrierCode, allocated_teu: allocatedTEU, effective_date: effectiveDate, end_date: endDate, trade_lane: tradeLane, notes, alert_threshold: alertThreshold, pol: pol.toUpperCase(), pod: pod.toUpperCase(), origin_lane: originLane, dest_lane: destLane, coverage_scope: coverageScope, contract_id: contractId, contract_number: contractNumber }), 201);
  });

  app.put("/api/allocations/:id", write, (req, res) => {
    const { carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane = '', notes = '',
            alertThreshold = 80, pol = '', pod = '', originLane = '', destLane = '',
            contractId = '', contractNumber = '' } = req.body;
    if (!effectiveDate || !endDate || !pol || !pod) return err(res, "effectiveDate, endDate, pol, pod required");
    if (!contractId) return err(res, "contractId required");
    if (endDate < effectiveDate) return err(res, "end date must be on or after effective date");
    if (checkOverlap(carrierCode, effectiveDate, endDate, pol, pod, req.params.id))
      return err(res, `Another allocation for ${carrierCode} on route ${pol.toUpperCase()} → ${pod.toUpperCase()} already covers that date range`);
    const info = db.prepare("UPDATE allocations SET carrier_code=?, allocated_teu=?, effective_date=?, end_date=?, trade_lane=?, notes=?, alert_threshold=?, pol=?, pod=?, origin_lane=?, dest_lane=?, contract_id=?, contract_number=? WHERE id=?")
      .run(carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane, notes, alertThreshold, pol.toUpperCase(), pod.toUpperCase(), originLane, destLane, contractId, contractNumber, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    logEntityEvent('allocation', req.params.id, 'UPDATED', null, null, null,
      JSON.stringify({ carrierCode, pol: pol.toUpperCase(), pod: pod.toUpperCase(), allocatedTEU, effectiveDate, endDate, contractNumber }));
    ok(res, mapAllocation({ id: req.params.id, carrier_code: carrierCode, allocated_teu: allocatedTEU, effective_date: effectiveDate, end_date: endDate, trade_lane: tradeLane, notes, alert_threshold: alertThreshold, pol: pol.toUpperCase(), pod: pod.toUpperCase(), origin_lane: originLane, dest_lane: destLane, contract_id: contractId, contract_number: contractNumber }));
  });

  app.delete("/api/allocations/:id", write, (req, res) => {
    const existing = db.prepare("SELECT * FROM allocations WHERE id=?").get(req.params.id);
    const info = db.prepare("DELETE FROM allocations WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    if (existing) logEntityEvent('allocation', req.params.id, 'DELETED', null, null, null,
      JSON.stringify({ carrierCode: existing.carrier_code, pol: existing.pol, pod: existing.pod }));
    ok(res, { deleted: req.params.id });
  });

  // Match allocations for a shipment (placed before /conflicts so static segment wins)
  // needsPolHaulage/needsPodHaulage mirror /api/contracts/match's params exactly — an
  // allocation is only as good as the contract behind it, so when the shipment needs carrier
  // haulage this checks the allocation's OWN linked contract's leg for that same coverage
  // (via the shared findMatchingContractLeg), instead of treating a pol/pod match alone as
  // sufficient. An allocation with no linked contract_id can't be verified either way, so it's
  // passed through rather than penalized — same "don't disprove it" default as an unscreened party.
  app.get("/api/allocations/match", (req, res) => {
    const { pol = "", pod = "", etd = "", needsPolHaulage = "", needsPodHaulage = "",
            pkuLocation = "", delLocation = "" } = req.query;
    if (!pol || !pod || !etd) return ok(res, []);
    const polU = pol.toUpperCase(), podU = pod.toUpperCase();
    const needsPol = needsPolHaulage === "1" || needsPolHaulage === "true";
    const needsPod = needsPodHaulage === "1" || needsPodHaulage === "true";
    const polAll = [polU, ...linkedPortCodes(polU)];
    const podAll = [podU, ...linkedPortCodes(podU)];
    const ph = arr => arr.map(() => "?").join(",");
    const allocs = db.prepare(`
      SELECT * FROM allocations
      WHERE pol IN (${ph(polAll)}) AND pod IN (${ph(podAll)})
      AND effective_date <= ? AND end_date >= ?
      ORDER BY effective_date DESC
    `).all(...polAll, ...podAll, etd, etd);
    const results = allocs
      .filter(a => {
        if (!needsPol && !needsPod) return true;
        if (!a.contract_id) return true;
        const legs = db.prepare("SELECT * FROM contract_legs WHERE contract_id=?").all(a.contract_id);
        return !!findMatchingContractLeg(legs, { pol: a.pol, pod: a.pod, needsPolHaulage: needsPol, needsPodHaulage: needsPod, pkuLocation, delLocation });
      })
      .map(a => {
        const { consumed_teu } = db.prepare(`
          SELECT COALESCE(SUM(CASE WHEN c.size=20 THEN 1 WHEN c.size IN (40,45) THEN 2 ELSE 0 END), 0) AS consumed_teu
          FROM containers c
          JOIN shipments s ON s.id = c.shipment_id
          WHERE s.allocation_id = ?
        `).get(a.id);
        const base      = mapAllocation(a);
        const matchKind = (a.pol === polU && a.pod === podU) ? "exact" : "linked";
        return { ...base, consumedTEU: consumed_teu, remainingTEU: Math.max(0, base.allocatedTEU - consumed_teu),
                 matchKind, linkedPolVia: a.pol !== polU ? a.pol : null, linkedPodVia: a.pod !== podU ? a.pod : null };
      });
    ok(res, results);
  });

  // Conflict detection
  app.get("/api/allocations/conflicts", (req, res) => {
    const { carrierCode, pol, pod, effectiveDate, endDate, excludeId = '' } = req.query;
    if (!carrierCode || !pol || !pod || !effectiveDate || !endDate) return ok(res, { exact: [], linked: [] });
    const polU = pol.toUpperCase(), podU = pod.toUpperCase();
    const isLinked = (a, b) => !!db.prepare("SELECT 1 FROM linked_ports WHERE (primary_unlocode=? AND linked_unlocode=?) OR (linked_unlocode=? AND primary_unlocode=?)").get(a, b, a, b);
    const exact = db.prepare("SELECT * FROM allocations WHERE carrier_code=? AND pol=? AND pod=? AND effective_date<=? AND end_date>=? AND id!=?")
      .all(carrierCode, polU, podU, endDate, effectiveDate, excludeId).map(r => {
        const carrier = db.prepare("SELECT name FROM carriers WHERE code=?").get(r.carrier_code);
        return { ...mapAllocation(r), carrierName: carrier?.name || '', conflictKind: 'exact', links: [] };
      });
    const exactIds = exact.map(e => e.id);
    const linkedCodes = db.prepare("SELECT primary_unlocode AS code FROM linked_ports WHERE linked_unlocode IN (?,?) UNION SELECT linked_unlocode AS code FROM linked_ports WHERE primary_unlocode IN (?,?)")
      .all(polU, podU, polU, podU).map(r => r.code).filter(c => c !== polU && c !== podU);
    let linked = [];
    if (linkedCodes.length > 0) {
      const ph = linkedCodes.map(() => '?').join(',');
      const excl = exactIds.length ? `AND id NOT IN (${exactIds.map(() => '?').join(',')})` : '';
      linked = db.prepare(`SELECT * FROM allocations WHERE carrier_code=? AND (pol IN (${ph}) OR pod IN (${ph})) AND effective_date<=? AND end_date>=? AND id!=? ${excl}`)
        .all(carrierCode, ...linkedCodes, ...linkedCodes, endDate, effectiveDate, excludeId, ...exactIds).map(r => {
          const a = mapAllocation(r);
          const carrier = db.prepare("SELECT name FROM carriers WHERE code=?").get(r.carrier_code);
          const links = [];
          for (const [np, nl] of [[polU,'POL'],[podU,'POD']]) for (const [tp, tl] of [[a.pol,'POL'],[a.pod,'POD']]) if (tp && isLinked(np, tp)) links.push({ newPort: np, newLabel: nl, theirPort: tp, theirLabel: tl });
          return { ...a, carrierName: carrier?.name || '', conflictKind: 'linked', links };
        });
    }
    ok(res, { exact, linked });
  });
};
