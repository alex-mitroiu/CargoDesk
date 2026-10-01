"use strict";

module.exports = function allocationsRoutes(app, ctx) {
  const { query, transaction, ok, err, uid, requireRole, mapAllocation, logEntityEvent, linkedPortCodes, findMatchingContractLegs,
          getSettings, callContractService, TEU_EXPR, FAK_COMMODITY, parseCommodityList } = ctx;
  const isRemoteContractSource = async () => ((await getSettings()).contract_source || "local") === "remote";

  // findMatchingContractLegs (server.js) expects raw contract_legs DB rows (snake_case) — the
  // Contract Management Service returns legs through its own mapLeg (camelCase, same field names
  // as lib/mappers.js's copy). Converts one back to the other so this route's matching logic
  // doesn't need two implementations.
  const legToRow = l => ({
    pol: l.pol, pod: l.pod, leg_order: l.legOrder, routing_id: l.routingId || "",
    pol_linked_allowed: !!l.polLinkedAllowed, pod_linked_allowed: !!l.podLinkedAllowed,
    pol_carrier_haulage: !!l.polCarrierHaulage, pod_carrier_haulage: !!l.podCarrierHaulage,
    pol_haulage_locations: l.polHaulageLocations || "", pod_haulage_locations: l.podHaulageLocations || "",
    vessel_service: l.vesselService || "",
  });

  // The contract fields /match hands the picker. A flat ocean-freight rate (no container type) is
  // the price for every type unless a type-specific rate overrides it.
  const OCEAN_FREIGHT_CODES = new Set(["OF", "OCF"]);
  const contractInfo = (c, rates) => {
    const oceanRates = {};
    for (const r of rates) {
      if (!OCEAN_FREIGHT_CODES.has(String(r.serviceCode || "").toUpperCase())) continue;
      for (const t of r.containerType ? [r.containerType] : ["20DC", "40DC", "40HC"])
        if (r.containerType || !oceanRates[t]) oceanRates[t] = { amount: Number(r.amount) || 0, currency: r.currency || "USD" };
    }
    return {
      contractNumber: c.contractNumber || "", contractRef: c.contractRef || "",
      namedAccountId: c.namedAccountId || "", namedAccount: c.namedAccount || "",
      containerTypes: Array.isArray(c.containerTypes) ? c.containerTypes : [],
      commodityTypes: c.commodityTypes || "", dgAllowed: !!c.dgAllowed, oceanRates,
    };
  };

  // A contract with its routing lines, as space configurations need it: each line's legs (DB-row
  // shape for findMatchingContractLegs), its loops (the service codes on its legs), its POL/POD
  // and a short label. null = no such contract; { unreachable: true } = the remote Contract
  // Management Service couldn't be asked (callers decide whether that blocks or passes through).
  async function loadContract(contractId) {
    if (!contractId) return null;
    let c, legs, rates, routings, types;
    if (await isRemoteContractSource()) {
      try { c = await callContractService("GET", `/internal/contracts/${contractId}`); }
      catch (e) { return e.status === 404 ? null : { unreachable: true }; }
      legs = (c.legs || []).map(legToRow); rates = c.rates || []; routings = c.routings || []; types = c.containerTypes || [];
    } else {
      const [row] = await query("SELECT * FROM contracts WHERE id=$1", [contractId]);
      if (!row) return null;
      c = { id: row.id, carrierCode: row.carrier_code, contractNumber: row.contract_number, contractRef: row.contract_ref,
            namedAccountId: row.named_account_id, namedAccount: row.named_account, commodityTypes: row.commodity_types,
            dgAllowed: row.dg_allowed, validFrom: row.valid_from, validTo: row.valid_to };
      types = (await query("SELECT container_type FROM contract_container_types WHERE contract_id=$1", [contractId])).map(r => r.container_type);
      rates = (await query("SELECT service_code, amount, currency, container_type FROM contract_rates WHERE contract_id=$1", [contractId]))
        .map(r => ({ serviceCode: r.service_code, amount: r.amount, currency: r.currency, containerType: r.container_type }));
      legs = await query("SELECT * FROM contract_legs WHERE contract_id=$1 ORDER BY leg_order", [contractId]);
      routings = (await query("SELECT id, name FROM contract_routings WHERE contract_id=$1 ORDER BY sort_order", [contractId]));
    }
    const lines = routings.map(r => {
      const own = legs.filter(l => (l.routing_id || "") === r.id).sort((a, b) => (a.leg_order ?? 0) - (b.leg_order ?? 0));
      const ports = own.length ? [own[0].pol, ...own.map(l => l.pod)].map(p => String(p || "").toUpperCase()) : [];
      return {
        id: r.id, name: r.name || "", legs: own,
        loops: new Set(own.map(l => String(l.vessel_service || "").trim().toUpperCase()).filter(Boolean)),
        pol: ports[0] || "", pod: ports[ports.length - 1] || "",
        label: [...new Set(ports)].join(" → ") || r.name || r.id,
      };
    });
    const codes = parseCommodityList(c.commodityTypes);
    return {
      id: c.id || contractId, carrierCode: c.carrierCode || "", contractNumber: c.contractNumber || "",
      namedAccountId: c.namedAccountId || "", namedAccount: c.namedAccount || "",
      validFrom: c.validFrom || "", validTo: c.validTo || "",
      commodityCodes: codes.length ? codes : [FAK_COMMODITY],
      lines, legs,
      info: contractInfo({ ...c, containerTypes: types }, rates),
    };
  }

  async function routingIdsByAllocation(ids) {
    const map = new Map();
    if (!ids.length) return map;
    const rows = await query(`SELECT allocation_id, routing_id FROM allocation_routings WHERE allocation_id IN (${ids.map((_, i) => `$${i + 1}`).join(",")})`, ids);
    for (const r of rows) { if (!map.has(r.allocation_id)) map.set(r.allocation_id, []); map.get(r.allocation_id).push(r.routing_id); }
    return map;
  }

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
  async function loadTeuBuckets() {
    const rows = await query(`
      SELECT s.allocation_id AS allocation_id, cb.status AS booking_status,
             COALESCE(SUM(${TEU_EXPR("c")}), 0) AS teu
      FROM containers c
      JOIN shipments s ON s.id = c.shipment_id
      LEFT JOIN carrier_bookings cb ON cb.shipment_id = s.id
      WHERE s.allocation_id IS NOT NULL AND s.allocation_id != ''
      GROUP BY s.allocation_id, cb.status
    `);
    const map = new Map();
    for (const r of rows) {
      const teu = Number(r.teu);
      const bucket = map.get(r.allocation_id) || { confirmedTEU: 0, pendingTEU: 0, rejectedTEU: 0 };
      if (r.booking_status === "Confirmed") bucket.confirmedTEU += teu;
      else if (r.booking_status === "Rejected") bucket.rejectedTEU += teu;
      else if (r.booking_status === "Cancelled") { /* excluded — no live demand left */ }
      else bucket.pendingTEU += teu; // Created, Pending, or no carrier_bookings row yet
      map.set(r.allocation_id, bucket);
    }
    return map;
  }
  const emptyBuckets = { confirmedTEU: 0, pendingTEU: 0, rejectedTEU: 0 };
  const withBuckets = (base, b = emptyBuckets) => ({ ...base, confirmedTEU: b.confirmedTEU, pendingTEU: b.pendingTEU, rejectedTEU: b.rejectedTEU,
    remainingTEU: Math.max(0, base.allocatedTEU - b.confirmedTEU) });

  app.get("/api/allocations", async (req, res) => {
    const rows = await query("SELECT * FROM allocations ORDER BY effective_date DESC");
    const buckets = await loadTeuBuckets();
    const routingIds = await routingIdsByAllocation(rows.map(r => r.id));
    ok(res, rows.map(r => ({ ...withBuckets(mapAllocation(r), buckets.get(r.id)), routingIds: routingIds.get(r.id) || [] })));
  });

  // ─── The rules a space configuration must meet (2026-09-30, approved form mockup:
  // https://claude.ai/artifact/MDkX8f7EEG3TNVquYeor3h) ─────────────────────────────────────────
  // It belongs to one contract record (number + reference + account) and ticks one or more of
  // that contract's routing lines, which share its TEU. Its period sits inside the contract's
  // validity. When the ticked lines carry loop codes it names exactly one loop, and every ticked
  // line with loops must sail on it (a line with no loop code goes with any loop). A reference
  // reserved for a named account passes that account on as the customer; otherwise the customer
  // is optional (empty = everyone). The commodity is one of the contract's commodity codes (FAK
  // 9999 covers all). Two configurations clash only when they share a routing LINE with the same
  // loop, customer and commodity in overlapping periods — the rule the user set on 2026-09-30.
  // Older callers that send pol/pod instead of routingIds get the one line covering that lane.
  // Returns { value } or { error, status }.
  async function resolveConfig(body, excludeId = null) {
    const b = body || {};
    if (!b.contractId) return { error: "contractId required" };
    if (b.allocatedTEU == null || !(Number(b.allocatedTEU) > 0)) return { error: "allocatedTEU must be a positive number" };
    const eff = b.effectiveDate, end = b.endDate;
    if (!eff || !end) return { error: "effectiveDate and endDate are required" };
    if (end < eff) return { error: "end date must be on or after effective date" };
    if (b.minimumTEU != null && String(b.minimumTEU).trim() !== "" && Number(b.minimumTEU) > Number(b.allocatedTEU))
      return { error: "Minimum commitment can't exceed the allocated TEU" };
    const c = await loadContract(b.contractId);
    if (!c) return { error: "contractId does not match any existing contract" };
    if (c.unreachable) return { error: "The Contract Management Service can't be reached, so the contract can't be checked — try again", status: 502 };
    if ((c.validFrom && eff < c.validFrom) || (c.validTo && end > c.validTo))
      return { error: `The period must sit inside the contract's validity (${c.validFrom || "…"} – ${c.validTo || "…"})` };

    let routingIds = Array.isArray(b.routingIds) ? [...new Set(b.routingIds.filter(Boolean))] : [];
    if (!routingIds.length && b.pol && b.pod) {
      const covering = [];
      for (const line of c.lines) {
        if ((await findMatchingContractLegs(line.legs, { pol: b.pol, pod: b.pod, needsPolHaulage: false, needsPodHaulage: false })).length) covering.push(line.id);
      }
      if (covering.length > 1) return { error: `${String(b.pol).toUpperCase()} → ${String(b.pod).toUpperCase()} is on ${covering.length} routing lines of this contract — tick the lines (routingIds)` };
      if (!covering.length) return { error: `${String(b.pol).toUpperCase()} → ${String(b.pod).toUpperCase()} isn't on this contract's routing lines` };
      routingIds = covering;
    }
    if (!routingIds.length) return { error: "Tick at least one routing line (routingIds)" };
    const lines = routingIds.map(id => c.lines.find(l => l.id === id));
    const unknown = routingIds.filter((id, i) => !lines[i]);
    if (unknown.length) return { error: `Routing ${unknown.join(", ")} isn't on this contract` };

    const loops = [...new Set(lines.flatMap(l => [...l.loops]))];
    let loopCode = String(b.loopCode || "").trim().toUpperCase();
    if (loops.length === 1 && !loopCode) loopCode = loops[0];
    if (loops.length) {
      if (!loopCode) return { error: `Pick the loop (${loops.join(", ")})` };
      if (!loops.includes(loopCode)) return { error: `Loop ${loopCode} isn't on the ticked routing lines (${loops.join(", ")})` };
      const off = lines.filter(l => l.loops.size && !l.loops.has(loopCode));
      if (off.length) return { error: `${off.map(l => l.label).join(", ")} doesn't sail on loop ${loopCode}` };
    } else loopCode = "";

    let customerId = String(b.customerId || "").trim(), customerName = String(b.customerName || "").trim();
    if (c.namedAccountId) { customerId = c.namedAccountId; customerName = c.namedAccount; }
    else if (!customerId) customerName = "";

    let commodityCode = String(b.commodityCode || "").trim();
    if (!commodityCode && c.commodityCodes.length === 1) commodityCode = c.commodityCodes[0];
    if (!commodityCode) return { error: `Pick the commodity (${c.commodityCodes.join(", ")})` };
    if (!c.commodityCodes.includes(commodityCode))
      return { error: `Commodity ${commodityCode} isn't one of this contract's commodity types (${c.commodityCodes.join(", ")})` };

    const params = [c.id, loopCode, customerId, commodityCode, end, eff, ...routingIds, ...(excludeId ? [excludeId] : [])];
    const [clash] = await query(`
      SELECT a.id, a.effective_date, a.end_date, ar.routing_id FROM allocations a
      JOIN allocation_routings ar ON ar.allocation_id = a.id
      WHERE a.contract_id=$1 AND COALESCE(a.loop_code,'')=$2 AND COALESCE(a.customer_id,'')=$3 AND COALESCE(a.commodity_code,'')=$4
        AND a.effective_date <= $5 AND a.end_date >= $6
        AND ar.routing_id IN (${routingIds.map((_, i) => `$${i + 7}`).join(",")})
        ${excludeId ? `AND a.id <> $${routingIds.length + 7}` : ""}
      LIMIT 1`, params);
    if (clash) {
      const line = c.lines.find(l => l.id === clash.routing_id);
      return { error: `${line?.label || "This routing line"} already has a space configuration (${clash.id}, ${clash.effective_date} – ${clash.end_date}) for the same loop, customer and commodity` };
    }
    return { value: { contract: c, routingIds, loopCode, customerId, customerName, commodityCode,
      carrierCode: c.carrierCode, contractNumber: c.contractNumber, pol: lines[0].pol, pod: lines[0].pod } };
  }

  async function saveRoutingLinks(tx, allocationId, routingIds) {
    await tx.query("DELETE FROM allocation_routings WHERE allocation_id=$1", [allocationId]);
    for (const rid of routingIds) await tx.query("INSERT INTO allocation_routings (allocation_id, routing_id) VALUES ($1,$2)", [allocationId, rid]);
  }

  app.post("/api/allocations", write, async (req, res) => {
    const r = await resolveConfig(req.body);
    if (r.error) return err(res, r.error, r.status || 400);
    const v = r.value;
    const { allocatedTEU, effectiveDate, endDate, tradeLane = '', notes = '', alertThreshold = 80,
            originLane = '', destLane = '', minimumTEU = null } = req.body;
    const id = `ALC-${uid()}`;
    const minTeuVal = minimumTEU != null && String(minimumTEU).trim() !== '' ? Number(minimumTEU) : null;
    await transaction(async tx => {
      await tx.query(`INSERT INTO allocations (id,carrier_code,allocated_teu,effective_date,end_date,trade_lane,notes,alert_threshold,pol,pod,origin_lane,dest_lane,contract_id,contract_number,minimum_teu,loop_code,customer_id,customer_name,commodity_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [id, v.carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane, notes, alertThreshold, v.pol, v.pod, originLane, destLane,
         v.contract.id, v.contractNumber, minTeuVal, v.loopCode, v.customerId, v.customerName, v.commodityCode]);
      await saveRoutingLinks(tx, id, v.routingIds);
    });
    await logEntityEvent('allocation', id, 'CREATED', null, null, null,
      JSON.stringify({ carrierCode: v.carrierCode, routingIds: v.routingIds, pol: v.pol, pod: v.pod, allocatedTEU, effectiveDate, endDate,
        contractNumber: v.contractNumber, loopCode: v.loopCode, customerId: v.customerId, commodityCode: v.commodityCode, minimumTEU: minTeuVal }));
    const [row] = await query("SELECT * FROM allocations WHERE id=$1", [id]);
    // A brand-new allocation always starts at 0 in every bucket (no shipment could reference
    // this id yet) — included explicitly so the response shape matches GET's, not left undefined.
    ok(res, { ...withBuckets(mapAllocation(row)), routingIds: v.routingIds }, 201);
  });

  app.put("/api/allocations/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM allocations WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    // Unticking a routing line that a linked shipment travels on would leave that shipment on
    // space that no longer covers its route — refuse, the same way a contract routing a shipment
    // uses can't be removed. Checked before the other rules: it's the more basic problem, and a
    // duplicate or validity message would only hide it.
    const before = (await routingIdsByAllocation([req.params.id])).get(req.params.id) || [];
    const checkDropped = async (nextIds, contract) => {
      const dropped = before.filter(x => !nextIds.includes(x));
      if (!dropped.length) return null;
      const users = await query(`SELECT id FROM shipments WHERE allocation_id=$1 AND status <> 'Cancelled'
        AND contract_routing_id IN (${dropped.map((_, i) => `$${i + 2}`).join(",")}) LIMIT 5`, [req.params.id, ...dropped]);
      if (!users.length) return null;
      const labels = dropped.map(x => contract?.lines.find(l => l.id === x)?.label || x).join(", ");
      return `${labels} is used by shipment${users.length === 1 ? "" : "s"} ${users.map(u => u.id).join(", ")} on this space configuration — move ${users.length === 1 ? "it" : "them"} first`;
    };
    if (Array.isArray(req.body?.routingIds) && req.body.routingIds.length) {
      const early = await checkDropped(req.body.routingIds, await loadContract(existing.contract_id));
      if (early) return err(res, early, 409);
    }
    const r = await resolveConfig(req.body, req.params.id);
    if (r.error) return err(res, r.error, r.status || 400);
    const v = r.value;
    const late = await checkDropped(v.routingIds, v.contract);
    if (late) return err(res, late, 409);
    const { allocatedTEU, effectiveDate, endDate, tradeLane = '', notes = '', alertThreshold = 80,
            originLane = '', destLane = '', minimumTEU = null } = req.body;
    const minTeuVal = minimumTEU != null && String(minimumTEU).trim() !== '' ? Number(minimumTEU) : null;
    await transaction(async tx => {
      await tx.query(`UPDATE allocations SET carrier_code=$1, allocated_teu=$2, effective_date=$3, end_date=$4, trade_lane=$5, notes=$6, alert_threshold=$7,
        pol=$8, pod=$9, origin_lane=$10, dest_lane=$11, contract_id=$12, contract_number=$13, minimum_teu=$14,
        loop_code=$15, customer_id=$16, customer_name=$17, commodity_code=$18 WHERE id=$19`,
        [v.carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane, notes, alertThreshold, v.pol, v.pod, originLane, destLane,
         v.contract.id, v.contractNumber, minTeuVal, v.loopCode, v.customerId, v.customerName, v.commodityCode, req.params.id]);
      await saveRoutingLinks(tx, req.params.id, v.routingIds);
    });
    await logEntityEvent('allocation', req.params.id, 'UPDATED', null, null, null,
      JSON.stringify({ carrierCode: v.carrierCode, routingIds: v.routingIds, pol: v.pol, pod: v.pod, allocatedTEU, effectiveDate, endDate,
        contractNumber: v.contractNumber, loopCode: v.loopCode, customerId: v.customerId, commodityCode: v.commodityCode, minimumTEU: minTeuVal }));
    // Editing an allocation's own fields never changes which shipments reference it — carry the
    // real current buckets through so the response shape matches GET's.
    const [row] = await query("SELECT * FROM allocations WHERE id=$1", [req.params.id]);
    ok(res, { ...withBuckets(mapAllocation(row), (await loadTeuBuckets()).get(req.params.id)), routingIds: v.routingIds });
  });

  app.delete("/api/allocations/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM allocations WHERE id=$1", [req.params.id]);
    // 2026-09-06 audit: shipments.allocation_id has no FK at all — verified live, this delete
    // previously succeeded silently (200) even while a real shipment was actively linked,
    // leaving that shipment's allocationId permanently dangling. Same guard idiom as offices.js.
    const [shipmentInUse] = await query("SELECT id FROM shipments WHERE allocation_id=$1 LIMIT 1", [req.params.id]);
    if (shipmentInUse) return err(res, "Allocation is referenced by a shipment — reassign or unlink it first");
    const deleted = await query("DELETE FROM allocations WHERE id=$1 RETURNING id", [req.params.id]);
    if (deleted.length === 0) return err(res, "Not found", 404);
    if (existing) await logEntityEvent('allocation', req.params.id, 'DELETED', null, null, null,
      JSON.stringify({ carrierCode: existing.carrier_code, pol: existing.pol, pod: existing.pod }));
    ok(res, { deleted: req.params.id });
  });

  // Space configurations that fit a shipment (placed before /conflicts so the static segment wins).
  // A configuration fits when one of its ticked routing lines covers the shipment's POL → POD
  // (linked ports and carrier haulage included, via the shared findMatchingContractLegs), the ETD
  // falls in its period, and — when set — its loop matches the shipment's sailing (checked only
  // once the shipment has one: loopCode), its customer is the shipment's principal, and its
  // commodity is FAK or the shipment's own commodity. Customer-specific space comes first, then
  // the general space that also fits. A configuration whose contract can't be checked (remote
  // service down, or an old configuration with no routing lines) falls back to its stored lane.
  app.get("/api/allocations/match", async (req, res) => {
    const { pol = "", pod = "", etd = "", needsPolHaulage = "", needsPodHaulage = "",
            pkuLocation = "", delLocation = "", principalId = "", commodityCode = "", loopCode = "" } = req.query;
    // No etd means "don't filter by validity window", not "return nothing" — during shipment
    // creation the sea leg's ETD is often still blank when Central is picked (real bug, fixed).
    if (!pol || !pod) return ok(res, []);
    const polU = pol.toUpperCase(), podU = pod.toUpperCase(), loopU = String(loopCode).trim().toUpperCase();
    const needsPol = needsPolHaulage === "1" || needsPolHaulage === "true";
    const needsPod = needsPodHaulage === "1" || needsPodHaulage === "true";
    const allocs = etd
      ? await query("SELECT * FROM allocations WHERE effective_date <= $1 AND end_date >= $2 ORDER BY effective_date DESC", [etd, etd])
      : await query("SELECT * FROM allocations ORDER BY effective_date DESC");
    const routingMap = await routingIdsByAllocation(allocs.map(a => a.id));
    const buckets = await loadTeuBuckets();
    const cache = new Map();
    const contractFor = id => { if (!cache.has(id)) cache.set(id, loadContract(id)); return cache.get(id); };
    const polAll = [polU, ...(await linkedPortCodes(polU))], podAll = [podU, ...(await linkedPortCodes(podU))];

    const results = [];
    for (const a of allocs) {
      if (a.loop_code && loopU && a.loop_code !== loopU) continue;
      if (a.customer_id && a.customer_id !== principalId) continue;
      if (a.commodity_code && a.commodity_code !== FAK_COMMODITY && a.commodity_code !== commodityCode) continue;
      const ids = routingMap.get(a.id) || [];
      const c = a.contract_id ? await contractFor(a.contract_id) : null;
      let matched = null, routings = [];
      if (c && !c.unreachable && ids.length) {
        const lines = ids.map(id => c.lines.find(l => l.id === id)).filter(Boolean);
        routings = lines.map(l => ({ id: l.id, label: l.label, pol: l.pol, pod: l.pod, loops: [...l.loops] }));
        for (const l of lines) {
          const m = await findMatchingContractLegs(l.legs, { pol: polU, pod: podU, needsPolHaulage: needsPol, needsPodHaulage: needsPod, pkuLocation, delLocation });
          if (m.length) { matched = { routingId: l.id, kind: m[0].matchKind, pol: m[0].firstLeg.pol, pod: m[0].lastLeg.pod }; break; }
        }
        if (!matched) continue;
      } else {
        if (!polAll.includes(a.pol) || !podAll.includes(a.pod)) continue;
        matched = { routingId: "", kind: (a.pol === polU && a.pod === podU) ? "exact" : "linked", pol: a.pol, pod: a.pod };
      }
      const base = mapAllocation(a);
      // The contract's own details, for the picker's "another reference under the same contract
      // number has space" suggestion. contractNumber is read live from the contract: the
      // allocation's stored copy isn't kept in sync when a contract is renumbered.
      const contract = c && !c.unreachable ? c.info : null;
      results.push({ ...withBuckets(base, buckets.get(a.id)), contractNumber: contract?.contractNumber || base.contractNumber, contract,
        routingIds: ids, routings, matchedRoutingId: matched.routingId,
        matchKind: matched.kind, linkedPolVia: matched.pol !== polU ? matched.pol : null, linkedPodVia: matched.pod !== podU ? matched.pod : null });
    }
    // Customer-specific space first; Array.prototype.sort is stable, so each group keeps the
    // newest-period-first order from the query.
    results.sort((x, y) => (y.customerId ? 1 : 0) - (x.customerId ? 1 : 0));
    ok(res, results);
  });

  // Conflict detection (lane-based, kept for older callers; the space configuration form now
  // checks duplicates per routing line itself — see resolveConfig).
  app.get("/api/allocations/conflicts", async (req, res) => {
    const { carrierCode, pol, pod, effectiveDate, endDate, excludeId = '' } = req.query;
    if (!carrierCode || !pol || !pod || !effectiveDate || !endDate) return ok(res, { exact: [], linked: [] });
    const polU = pol.toUpperCase(), podU = pod.toUpperCase();
    const isLinked = async (a, b) => (await linkedPortCodes(a)).includes(b);
    const exactRows = await query("SELECT * FROM allocations WHERE carrier_code=$1 AND pol=$2 AND pod=$3 AND effective_date<=$4 AND end_date>=$5 AND id!=$6",
      [carrierCode, polU, podU, endDate, effectiveDate, excludeId]);
    const exact = await Promise.all(exactRows.map(async r => {
      const [carrier] = await query("SELECT name FROM carriers WHERE code=$1", [r.carrier_code]);
      return { ...mapAllocation(r), carrierName: carrier?.name || '', conflictKind: 'exact', links: [] };
    }));
    const exactIds = exact.map(e => e.id);
    const linkedCodes = [...new Set([...(await linkedPortCodes(polU)), ...(await linkedPortCodes(podU))])]
      .filter(c => c !== polU && c !== podU);
    let linked = [];
    if (linkedCodes.length > 0) {
      const params = [carrierCode, ...linkedCodes, ...linkedCodes, endDate, effectiveDate, excludeId, ...exactIds];
      const polPh = linkedCodes.map((_, i) => `$${i + 2}`).join(',');
      const podPh = linkedCodes.map((_, i) => `$${linkedCodes.length + i + 2}`).join(',');
      const baseIdx = 1 + linkedCodes.length * 2;
      const excl = exactIds.length ? `AND id NOT IN (${exactIds.map((_, i) => `$${baseIdx + 4 + i}`).join(',')})` : '';
      const linkedRows = await query(`SELECT * FROM allocations WHERE carrier_code=$1 AND (pol IN (${polPh}) OR pod IN (${podPh})) AND effective_date<=$${baseIdx + 1} AND end_date>=$${baseIdx + 2} AND id!=$${baseIdx + 3} ${excl}`,
        params);
      linked = await Promise.all(linkedRows.map(async r => {
        const a = mapAllocation(r);
        const [carrier] = await query("SELECT name FROM carriers WHERE code=$1", [r.carrier_code]);
        const links = [];
        for (const [np, nl] of [[polU,'POL'],[podU,'POD']]) for (const [tp, tl] of [[a.pol,'POL'],[a.pod,'POD']]) if (tp && await isLinked(np, tp)) links.push({ newPort: np, newLabel: nl, theirPort: tp, theirLabel: tl });
        return { ...a, carrierName: carrier?.name || '', conflictKind: 'linked', links };
      }));
    }
    ok(res, { exact, linked });
  });
};
