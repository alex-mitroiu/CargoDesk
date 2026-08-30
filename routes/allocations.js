"use strict";

module.exports = function allocationsRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, mapAllocation, checkOverlap, logEntityEvent, linkedPortCodes, findMatchingContractLegs,
          getSettings, callContractService } = ctx;
  const isRemoteContractSource = async () => ((await getSettings()).contract_source || "local") === "remote";

  // findMatchingContractLegs (server.js) expects raw contract_legs DB rows (snake_case) — the
  // Contract Management Service returns legs through its own mapLeg (camelCase, same field names
  // as lib/mappers.js's copy). Converts one back to the other so this route's matching logic
  // doesn't need two implementations.
  const legToRow = l => ({
    pol: l.pol, pod: l.pod, leg_order: l.legOrder, routing_id: l.routingId || "",
    pol_linked_allowed: l.polLinkedAllowed ? 1 : 0, pod_linked_allowed: l.podLinkedAllowed ? 1 : 0,
    pol_carrier_haulage: l.polCarrierHaulage ? 1 : 0, pod_carrier_haulage: l.podCarrierHaulage ? 1 : 0,
    pol_haulage_locations: l.polHaulageLocations || "", pod_haulage_locations: l.podHaulageLocations || "",
  });

  // Space configurations are full-CRUD for trade_manager alongside admin/operator —
  // previously these write routes had no role gate at all.
  const write = requireRole(["admin", "operator", "trade_manager"]);

  // Space consumption is split three ways, driven entirely by carrier_bookings.status — the
  // OPERATOR's own action, not the carrier's raw EDI reply (last_response_status). Only a
  // Confirmed booking (the operator's explicit Confirm click) actively deducts from available
  // space; Pending (Created/Pending/no booking row yet) and Rejected are informational buckets,
  // shown but never subtracted. Cancelled is excluded outright — no live demand left. Same
  // authoritative, allocationId-scoped definition everywhere it's shown (this list, /match
  // below, SpaceConfigurationsPage's consumption bar/Linked Shipments modal, ShipmentSchedulesPage's
  // Space Configuration panel, ShipmentFormPage's Contract Picker card). One batched query
  // rather than one subquery per allocation.
  function loadTeuBuckets() {
    const rows = db.prepare(`
      SELECT s.allocation_id AS allocation_id, cb.status AS booking_status,
             COALESCE(SUM(CASE WHEN c.size=20 THEN 1 WHEN c.size IN (40,45) THEN 2 ELSE 0 END), 0) AS teu
      FROM containers c
      JOIN shipments s ON s.id = c.shipment_id
      LEFT JOIN carrier_bookings cb ON cb.shipment_id = s.id
      WHERE s.allocation_id IS NOT NULL AND s.allocation_id != ''
      GROUP BY s.allocation_id, cb.status
    `).all();
    const map = new Map();
    for (const r of rows) {
      const bucket = map.get(r.allocation_id) || { confirmedTEU: 0, pendingTEU: 0, rejectedTEU: 0 };
      if (r.booking_status === "Confirmed") bucket.confirmedTEU += r.teu;
      else if (r.booking_status === "Rejected") bucket.rejectedTEU += r.teu;
      else if (r.booking_status === "Cancelled") { /* excluded — no live demand left */ }
      else bucket.pendingTEU += r.teu; // Created, Pending, or no carrier_bookings row yet
      map.set(r.allocation_id, bucket);
    }
    return map;
  }
  const emptyBuckets = { confirmedTEU: 0, pendingTEU: 0, rejectedTEU: 0 };

  app.get("/api/allocations", (req, res) => {
    const rows = db.prepare("SELECT * FROM allocations ORDER BY effective_date DESC").all();
    const buckets = loadTeuBuckets();
    ok(res, rows.map(r => {
      const base = mapAllocation(r);
      const b = buckets.get(r.id) || emptyBuckets;
      return { ...base, confirmedTEU: b.confirmedTEU, pendingTEU: b.pendingTEU, rejectedTEU: b.rejectedTEU,
               remainingTEU: Math.max(0, base.allocatedTEU - b.confirmedTEU) };
    }));
  });

  app.post("/api/allocations", write, async (req, res) => {
    const { carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane = '', notes = '',
            alertThreshold = 80, pol = '', pod = '', originLane = '', destLane = '', coverageScope = 'STRICT',
            contractId = '', contractNumber = '', minimumTEU = null } = req.body;
    if (!carrierCode || allocatedTEU == null || !effectiveDate || !endDate || !pol || !pod)
      return err(res, "carrierCode, allocatedTEU, effectiveDate, endDate, pol, pod all required");
    if (!contractId) return err(res, "contractId required");
    if (endDate < effectiveDate) return err(res, "end date must be on or after effective date");
    if (minimumTEU != null && Number(minimumTEU) > Number(allocatedTEU))
      return err(res, "Minimum commitment can't exceed the allocated TEU");
    if (checkOverlap(carrierCode, effectiveDate, endDate, pol, pod))
      return err(res, `An allocation for ${carrierCode} on route ${pol.toUpperCase()} → ${pod.toUpperCase()} already covers that date range`);
    const id = `ALC-${uid()}`;
    const minTeuVal = minimumTEU != null && String(minimumTEU).trim() !== '' ? Number(minimumTEU) : null;
    db.prepare("INSERT INTO allocations (id,carrier_code,allocated_teu,effective_date,end_date,trade_lane,notes,alert_threshold,pol,pod,origin_lane,dest_lane,coverage_scope,contract_id,contract_number,minimum_teu) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane, notes, alertThreshold, pol.toUpperCase(), pod.toUpperCase(), originLane, destLane, coverageScope, contractId, contractNumber, minTeuVal);
    await logEntityEvent('allocation', id, 'CREATED', null, null, null,
      JSON.stringify({ carrierCode, pol: pol.toUpperCase(), pod: pod.toUpperCase(), allocatedTEU, effectiveDate, endDate, contractNumber, minimumTEU: minTeuVal }));
    // A brand-new allocation always starts at 0 in every bucket (no shipment could reference
    // this id yet) — included explicitly so the response shape matches GET's, not left undefined.
    ok(res, { ...mapAllocation({ id, carrier_code: carrierCode, allocated_teu: allocatedTEU, effective_date: effectiveDate, end_date: endDate, trade_lane: tradeLane, notes, alert_threshold: alertThreshold, pol: pol.toUpperCase(), pod: pod.toUpperCase(), origin_lane: originLane, dest_lane: destLane, coverage_scope: coverageScope, contract_id: contractId, contract_number: contractNumber, minimum_teu: minTeuVal }), confirmedTEU: 0, pendingTEU: 0, rejectedTEU: 0, remainingTEU: allocatedTEU }, 201);
  });

  app.put("/api/allocations/:id", write, async (req, res) => {
    const { carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane = '', notes = '',
            alertThreshold = 80, pol = '', pod = '', originLane = '', destLane = '',
            contractId = '', contractNumber = '', minimumTEU = null } = req.body;
    if (!effectiveDate || !endDate || !pol || !pod) return err(res, "effectiveDate, endDate, pol, pod required");
    if (!carrierCode || allocatedTEU === undefined) return err(res, "carrierCode, allocatedTEU required");
    if (!contractId) return err(res, "contractId required");
    if (endDate < effectiveDate) return err(res, "end date must be on or after effective date");
    if (minimumTEU != null && Number(minimumTEU) > Number(allocatedTEU))
      return err(res, "Minimum commitment can't exceed the allocated TEU");
    if (checkOverlap(carrierCode, effectiveDate, endDate, pol, pod, req.params.id))
      return err(res, `Another allocation for ${carrierCode} on route ${pol.toUpperCase()} → ${pod.toUpperCase()} already covers that date range`);
    const minTeuVal = minimumTEU != null && String(minimumTEU).trim() !== '' ? Number(minimumTEU) : null;
    const info = db.prepare("UPDATE allocations SET carrier_code=?, allocated_teu=?, effective_date=?, end_date=?, trade_lane=?, notes=?, alert_threshold=?, pol=?, pod=?, origin_lane=?, dest_lane=?, contract_id=?, contract_number=?, minimum_teu=? WHERE id=?")
      .run(carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane, notes, alertThreshold, pol.toUpperCase(), pod.toUpperCase(), originLane, destLane, contractId, contractNumber, minTeuVal, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    await logEntityEvent('allocation', req.params.id, 'UPDATED', null, null, null,
      JSON.stringify({ carrierCode, pol: pol.toUpperCase(), pod: pod.toUpperCase(), allocatedTEU, effectiveDate, endDate, contractNumber, minimumTEU: minTeuVal }));
    // Editing an allocation's own fields never changes which shipments reference it — carry the
    // real current buckets through so the response shape matches GET's (an edit no longer makes
    // the header row briefly show 0 consumed until the next full reload).
    const b = loadTeuBuckets().get(req.params.id) || emptyBuckets;
    ok(res, { ...mapAllocation({ id: req.params.id, carrier_code: carrierCode, allocated_teu: allocatedTEU, effective_date: effectiveDate, end_date: endDate, trade_lane: tradeLane, notes, alert_threshold: alertThreshold, pol: pol.toUpperCase(), pod: pod.toUpperCase(), origin_lane: originLane, dest_lane: destLane, contract_id: contractId, contract_number: contractNumber, minimum_teu: minTeuVal }), confirmedTEU: b.confirmedTEU, pendingTEU: b.pendingTEU, rejectedTEU: b.rejectedTEU, remainingTEU: Math.max(0, allocatedTEU - b.confirmedTEU) });
  });

  app.delete("/api/allocations/:id", write, async (req, res) => {
    const existing = db.prepare("SELECT * FROM allocations WHERE id=?").get(req.params.id);
    const info = db.prepare("DELETE FROM allocations WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    if (existing) await logEntityEvent('allocation', req.params.id, 'DELETED', null, null, null,
      JSON.stringify({ carrierCode: existing.carrier_code, pol: existing.pol, pod: existing.pod }));
    ok(res, { deleted: req.params.id });
  });

  // Match allocations for a shipment (placed before /conflicts so static segment wins)
  // needsPolHaulage/needsPodHaulage mirror /api/contracts/match's params exactly — an
  // allocation is only as good as the contract behind it, so when the shipment needs carrier
  // haulage this checks the allocation's OWN linked contract's leg for that same coverage
  // (via the shared findMatchingContractLegs), instead of treating a pol/pod match alone as
  // sufficient. An allocation with no linked contract_id can't be verified either way, so it's
  // passed through rather than penalized — same "don't disprove it" default as an unscreened party.
  app.get("/api/allocations/match", async (req, res) => {
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
    const buckets = loadTeuBuckets();
    const remote = await isRemoteContractSource();
    const legsCache = new Map(); // contractId -> legs (row-shaped), fetched at most once per request
    async function contractLegsFor(contractId) {
      if (legsCache.has(contractId)) return legsCache.get(contractId);
      let legs;
      if (remote) {
        try { legs = (await callContractService("GET", `/internal/contracts/${contractId}`)).legs.map(legToRow); }
        catch { legs = []; } // an unreachable/vanished remote contract can't be verified either way
      } else {
        legs = db.prepare("SELECT * FROM contract_legs WHERE contract_id=?").all(contractId);
      }
      legsCache.set(contractId, legs);
      return legs;
    }
    const passed = [];
    for (const a of allocs) {
      if (!needsPol && !needsPod) { passed.push(a); continue; }
      if (!a.contract_id) { passed.push(a); continue; }
      const legs = await contractLegsFor(a.contract_id);
      if (findMatchingContractLegs(legs, { pol: a.pol, pod: a.pod, needsPolHaulage: needsPol, needsPodHaulage: needsPod, pkuLocation, delLocation }).length > 0) passed.push(a);
    }
    const results = passed
      .map(a => {
        const b = buckets.get(a.id) || emptyBuckets;
        const base      = mapAllocation(a);
        const matchKind = (a.pol === polU && a.pod === podU) ? "exact" : "linked";
        return { ...base, confirmedTEU: b.confirmedTEU, pendingTEU: b.pendingTEU, rejectedTEU: b.rejectedTEU,
                 remainingTEU: Math.max(0, base.allocatedTEU - b.confirmedTEU),
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
