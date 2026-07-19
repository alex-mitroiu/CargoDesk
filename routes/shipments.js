"use strict";

module.exports = function shipmentsRoutes(app, ctx) {
  const { db, ok, err, uid, auth, requireRole,
          mapShipment, mapShipmentLeg, mapContainer, mapContainerEvent, mapContainerPackage, mapAllocation,
          applyShipmentAccessFilter, syncShipmentFromLegs, importContractRates,
          broadcastMessage, recomputeSpaceBadge, screenShipmentById,
          logEvent, logEntityEvent, TRACKED_FIELDS, TRACKED_CTR_FIELDS, FREE_TIME_WARNING_DAYS,
          sanctionsMap, autoCompleteMilestone } = ctx;

  // trade_manager and viewer are read-only on all shipment write operations
  const shipmentWrite = requireRole(["admin", "operator", "occ_bk"]);

  const LEG_TO_MOT = { 'SEA': 'SEA', 'AIR': 'AIR', 'RAIL': 'RAIL', 'Pick-up': 'ROAD', 'Delivery': 'ROAD', 'Feeder': 'SEA' };

  const checkDgPolicy = (shipmentId, isDg, dgClass) => {
    if (!isDg || !dgClass) return null;
    const shipment = db.prepare("SELECT contract_id, contract_ref FROM shipments WHERE id=?").get(shipmentId);
    if (!shipment?.contract_id) return null;
    const contract = db.prepare("SELECT dg_allowed, imdg_classes, contract_number FROM contracts WHERE id=?").get(shipment.contract_id);
    if (!contract) return null;
    if (!contract.dg_allowed)
      return `Contract ${contract.contract_number} does not permit DG cargo`;
    const allowed = JSON.parse(contract.imdg_classes || "[]");
    if (allowed.length > 0 && !allowed.includes(dgClass))
      return `IMO class ${dgClass} is not permitted under contract ${contract.contract_number} (allowed: ${allowed.join(", ")})`;
    return null;
  };

  // Demurrage/detention free-time window: a countdown from a container-events
  // anchor (Gate In for origin, Discharged for destination) to a configured
  // free_time_days deadline, closed out once the matching "moved on" event
  // fires (Sailed for origin, Gate Out for destination). ASSUMPTION: this
  // origin/destination split follows the ticket's literal wording ("counted
  // from gate-in/discharge events") rather than the more classical trade
  // definition (origin free time = Empty Pickup -> Gate In) — flagged for
  // review, cheap to swap the anchor event names below if wrong.
  const freeTimeWindow = (freeDays, startAt, closeAt, warnDays) => {
    if (freeDays == null) return { state: 'no-window', expiresAt: null, daysRemaining: null };
    const startParsed = startAt ? new Date(startAt) : null;
    if (!startParsed || isNaN(startParsed)) return { state: 'not-started', expiresAt: null, daysRemaining: null };
    const expiresAt = new Date(startParsed.getTime() + freeDays * 86400000);
    const closeParsed = closeAt ? new Date(closeAt) : null;
    if (closeParsed && !isNaN(closeParsed)) {
      const daysRemaining = Math.round((expiresAt - closeParsed) / 86400000);
      return { state: daysRemaining >= 0 ? 'closed-ok' : 'closed-late', expiresAt: expiresAt.toISOString().slice(0, 10), daysRemaining };
    }
    const today = new Date(new Date().toISOString().slice(0, 10));
    const daysRemaining = Math.round((expiresAt - today) / 86400000);
    const state = daysRemaining < 0 ? 'red' : daysRemaining <= warnDays ? 'amber' : 'ok';
    return { state, expiresAt: expiresAt.toISOString().slice(0, 10), daysRemaining };
  };

  // eventsByType: { [eventType]: occurredAt } for ONE container's events (latest
  // occurrence per type, since a type could in principle be logged more than once).
  const deriveFreeTime = (ctr, eventsByType, latest) => ({
    ...(() => { const w = freeTimeWindow(ctr.origin_free_time_days, eventsByType['Gate In'], eventsByType['Sailed'], FREE_TIME_WARNING_DAYS);
      return { originFreeTimeState: w.state, originFreeTimeExpiresAt: w.expiresAt, originFreeTimeDaysRemaining: w.daysRemaining }; })(),
    ...(() => { const w = freeTimeWindow(ctr.dest_free_time_days, eventsByType['Discharged'], eventsByType['Gate Out'], FREE_TIME_WARNING_DAYS);
      return { destFreeTimeState: w.state, destFreeTimeExpiresAt: w.expiresAt, destFreeTimeDaysRemaining: w.daysRemaining }; })(),
    latestEventType: latest?.type || '', latestEventLocation: latest?.location || '', latestEventAt: latest?.at || '',
  });

  // Groups a flat container_events result set (batched across many containers)
  // into per-container { byType, latest } — one query total instead of N+1.
  const groupContainerEvents = rows => {
    const byContainer = {};
    for (const r of rows) {
      const g = (byContainer[r.container_id] ??= { byType: {}, latest: null });
      g.byType[r.event_type] = r.occurred_at;
      if (!g.latest || r.occurred_at >= g.latest.at) g.latest = { type: r.event_type, location: r.location || '', at: r.occurred_at };
    }
    return byContainer;
  };

  // ─── Shipments ─────────────────────────────────────────────────────────────

  // shipment.pol/pod are the journey's overall DOOR-TO-DOOR bookends — for a shipment
  // with a Door pickup and/or a trucked final Delivery leg, that's not the same as the
  // real SEA leg's pol/pod (e.g. a Delivery leg to an inland city like Chicago shows up
  // as shipment.pod, even though the actual sea Port of Discharge is New York). Several
  // single-shipment views (RouteSummaryBar, ShipmentHeaderBar, the sailing search on
  // ShipmentSchedulesPage) already resolve this themselves by self-fetching legs — this
  // does the same resolution in bulk for the shipments LIST, one batched query across
  // all shipments instead of N+1 (same pattern as the container-events join above).
  const resolveSeaPorts = shipmentIds => {
    if (!shipmentIds.length) return {};
    const legs = db.prepare(`
      SELECT shipment_id, pol, pod FROM shipment_legs
      WHERE leg_type='SEA' AND shipment_id IN (${shipmentIds.map(() => '?').join(',')})
      ORDER BY leg_order ASC
    `).all(...shipmentIds);
    const bySeaShipment = {};
    for (const l of legs) {
      const g = (bySeaShipment[l.shipment_id] ??= { seaPol: l.pol, seaPod: l.pod });
      g.seaPod = l.pod; // last SEA leg in leg_order wins
    }
    const codes = [...new Set(Object.values(bySeaShipment).flatMap(g => [g.seaPol, g.seaPod]).filter(Boolean))];
    const names = {};
    if (codes.length) {
      db.prepare(`SELECT unlocode, name FROM port_locations WHERE unlocode IN (${codes.map(() => '?').join(',')})`)
        .all(...codes).forEach(r => { names[r.unlocode] = r.name; });
    }
    for (const g of Object.values(bySeaShipment)) {
      g.seaPolName = names[g.seaPol] || '';
      g.seaPodName = names[g.seaPod] || '';
    }
    return bySeaShipment;
  };

  app.get("/api/shipments", (req, res) => {
    const rows = db.prepare(`
      SELECT s.*,
             p1.name AS pol_name,
             p2.name AS pod_name,
             emo.code AS emo_office_code, emo.name AS emo_office_name,
             imo.code AS imo_office_code, imo.name AS imo_office_name,
             ctrl.code AS controlling_office_code, ctrl.name AS controlling_office_name,
             COALESCE(buy.total, 0)  AS margin_buy_usd,
             COALESCE(sell.total, 0) AS margin_sell_usd,
             COALESCE(ms.overdue_count, 0) AS overdue_count
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      LEFT JOIN offices emo  ON emo.id  = s.emo_office_id
      LEFT JOIN offices imo  ON imo.id  = s.imo_office_id
      LEFT JOIN offices ctrl ON ctrl.id = s.controlling_office_id
      LEFT JOIN (SELECT shipment_id, SUM(amount * exchange_rate) AS total
                 FROM shipment_cost_lines WHERE type='BUY' GROUP BY shipment_id) buy
             ON buy.shipment_id = s.id
      LEFT JOIN (SELECT shipment_id, SUM(amount * exchange_rate) AS total
                 FROM shipment_cost_lines WHERE type='SELL' GROUP BY shipment_id) sell
             ON sell.shipment_id = s.id
      LEFT JOIN (SELECT shipment_id, COUNT(*) AS overdue_count
                 FROM shipment_milestones
                 WHERE estimated_date != '' AND estimated_date < date('now') AND completed_at = ''
                 GROUP BY shipment_id) ms
             ON ms.shipment_id = s.id
      ORDER BY s.created_at DESC
    `).all();
    const seaPorts = resolveSeaPorts(rows.map(r => r.id));
    const mapped = rows.map(r => ({ ...mapShipment(r), ...(seaPorts[r.id] || { seaPol: r.pol, seaPod: r.pod, seaPolName: r.pol_name || '', seaPodName: r.pod_name || '' }) }));
    ok(res, applyShipmentAccessFilter(mapped, req.user, req));
  });

  app.get("/api/shipments/compliance-hits", (req, res) => {
    const rows = db.prepare(`
      SELECT s.*, p1.name AS pol_name, p2.name AS pod_name,
             ss.result AS scr_result, ss.hits AS scr_hits, ss.screened_at, ss.overridden_at
      FROM shipments s
      JOIN shipment_screenings ss ON ss.shipment_id = s.id
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      WHERE ss.result = 'HIT'
      ORDER BY ss.screened_at DESC
    `).all();
    ok(res, rows.map(r => ({
      ...mapShipment(r),
      screening: {
        result: r.scr_result,
        hits: JSON.parse(r.scr_hits || '[]'),
        screenedAt: r.screened_at,
        overriddenAt: r.overridden_at || null,
      },
    })));
  });

  app.get("/api/shipments/:id", (req, res) => {
    const row = db.prepare(`
      SELECT s.*, p1.name AS pol_name, p2.name AS pod_name,
             emo.code AS emo_office_code, emo.name AS emo_office_name,
             imo.code AS imo_office_code, imo.name AS imo_office_name,
             ctrl.code AS controlling_office_code, ctrl.name AS controlling_office_name
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      LEFT JOIN offices emo  ON emo.id  = s.emo_office_id
      LEFT JOIN offices imo  ON imo.id  = s.imo_office_id
      LEFT JOIN offices ctrl ON ctrl.id = s.controlling_office_id
      WHERE s.id = ?
    `).get(req.params.id);
    if (!row) return err(res, "Not found", 404);
    const s = mapShipment(row);
    if (!applyShipmentAccessFilter([s], req.user, req).length) return err(res, "Not found", 404);
    ok(res, s);
  });

  // Global-pagination shape ({results, total, limit, offset}) — same contract as every other
  // paginated list endpoint (GET /api/contracts, /api/port-locations, etc). types/search/dateRange
  // filter server-side so `total` always reflects what's actually being paged through, not just
  // the unfiltered row count.
  app.get("/api/shipments/:id/events", (req, res) => {
    const { limit = "50", offset = "0", types = "", search = "", dateRange = "", sort = "desc" } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
    const clauses = ["shipment_id=?"];
    const params = [req.params.id];
    if (types.trim()) {
      const typeList = types.split(",").map(t => t.trim()).filter(Boolean);
      if (typeList.length) { clauses.push(`event_type IN (${typeList.map(() => "?").join(",")})`); params.push(...typeList); }
    }
    if (dateRange === "today") {
      clauses.push("occurred_at >= ?"); params.push(new Date().toISOString().slice(0, 10));
    } else if (dateRange === "7d") {
      clauses.push("occurred_at >= ?"); params.push(new Date(Date.now() - 7 * 86400000).toISOString());
    }
    if (search.trim()) {
      clauses.push("(field LIKE ? OR old_value LIKE ? OR new_value LIKE ? OR meta LIKE ? OR event_type LIKE ?)");
      const s = `%${search.trim()}%`; params.push(s, s, s, s, s);
    }
    const where = "WHERE " + clauses.join(" AND ");
    const total = db.prepare(`SELECT COUNT(*) AS n FROM shipment_events ${where}`).get(...params).n;
    const dir = sort === "asc" ? "ASC" : "DESC";
    const rows = db.prepare(`SELECT * FROM shipment_events ${where} ORDER BY occurred_at ${dir} LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, {
      results: rows.map(r => ({
        id: r.id, shipmentId: r.shipment_id,
        eventType: r.event_type, field: r.field,
        oldValue: r.old_value, newValue: r.new_value,
        actor: r.actor, occurredAt: r.occurred_at,
        meta: r.meta ? JSON.parse(r.meta) : {},
      })),
      total, limit: lim, offset: off,
    });
  });

  app.get("/api/shipments/:id/status-log", (req, res) => {
    const rows = db.prepare(
      "SELECT * FROM status_log WHERE shipment_id=? ORDER BY changed_at ASC"
    ).all(req.params.id);
    ok(res, rows.map(r => ({
      id: r.id, shipmentId: r.shipment_id,
      fromStatus: r.from_status, toStatus: r.to_status,
      changedAt: r.changed_at, changedBy: r.changed_by,
    })));
  });

  app.post("/api/shipments", shipmentWrite, (req, res) => {
    const { pol, pod, carrierCode, contractType, contractNotes = "", status = "Active",
            etd = "", eta = "", bookingRef = "", blNumber = "", vessel = "", voyage = "",
            incoterm = "", vesselImo = "", contractId = "", contractRef = "", commodityCode = "",
            shipperId = "", shipperName = "", consigneeId = "", consigneeName = "",
            principalId = "", principalName = "",
            allocationId = "", spaceSkipReason = "", spaceOverageReason = "",
            freightTerms = "Prepaid", movementType = "FCL", serviceType = "Port-to-Port",
            placeOfReceipt = "", placeOfDelivery = "", cargoReadyDate = null,
            notifyId = "", notifyName = "",
            declaredValue = null, declaredValueCurrency = "USD",
            emoOfficeId = null, imoOfficeId = null, controllingOfficeId = null } = req.body;
    if (!pol || !pod || !carrierCode || !contractType) return err(res, "pol, pod, carrierCode, contractType required");
    const id = `SHP-${uid()}`;
    const polU = pol.toUpperCase(), podU = pod.toUpperCase();
    const createdAt = new Date().toISOString();
    db.prepare("INSERT INTO shipments (id,pol,pod,carrier_code,contract_type,contract_notes,status,created_at,etd,eta,booking_ref,bl_number,vessel,voyage,incoterm,vessel_imo,contract_id,contract_ref,commodity_code,shipper_id,shipper_name,consignee_id,consignee_name,principal_id,principal_name,allocation_id,space_skip_reason,space_overage_reason,freight_terms,movement_type,service_type,place_of_receipt,place_of_delivery,cargo_ready_date,notify_id,notify_name,declared_value,declared_value_currency,emo_office_id,imo_office_id,controlling_office_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, polU, podU, carrierCode, contractType, contractNotes, status, createdAt, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, contractId, contractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName, allocationId, spaceSkipReason, spaceOverageReason, freightTerms, movementType, serviceType, placeOfReceipt, placeOfDelivery, cargoReadyDate || null, notifyId, notifyName, (declaredValue !== null && declaredValue !== undefined && String(declaredValue).trim() !== '') ? Number(declaredValue) : null, declaredValueCurrency || "USD", emoOfficeId || null, imoOfficeId || null, controllingOfficeId || null);
    logEvent(id, 'SHIPMENT_CREATED', null, null, null,
      JSON.stringify({ pol: polU, pod: podU, carrier: carrierCode, status, etd, contractType }));
    if (contractType === 'Central' && contractId) importContractRates(id);
    const silentScreening = sanctionsMap.size > 0 ? screenShipmentById(id) : null;
    const base = mapShipment(db.prepare("SELECT * FROM shipments WHERE id=?").get(id));
    ok(res, silentScreening ? { ...base, screening: silentScreening } : base, 201);
  });

  app.put("/api/shipments/:id", shipmentWrite, (req, res) => {
    const { pol, pod, carrierCode, contractType, contractNotes = "", status,
            etd = "", eta = "", bookingRef = "", blNumber = "", vessel = "", voyage = "",
            incoterm = "", vesselImo = "", contractId = "", contractRef = "", commodityCode = "",
            shipperId = "", shipperName = "", consigneeId = "", consigneeName = "",
            principalId = "", principalName = "",
            allocationId = "", spaceSkipReason = "", spaceOverageReason = "",
            freightTerms = "Prepaid", movementType = "FCL", serviceType = "Port-to-Port",
            placeOfReceipt = "", placeOfDelivery = "", cargoReadyDate = null,
            notifyId = "", notifyName = "",
            declaredValue = null, declaredValueCurrency = "USD",
            emoOfficeId = null, imoOfficeId = null, controllingOfficeId = null,
            contractValidFrom = "", contractValidTo = "" } = req.body;
    const polU = pol.toUpperCase(), podU = pod.toUpperCase();
    const existing = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);

    // CRD-vs-ETD guard: cargo can't be ready after the vessel has already sailed, so a Cargo
    // Ready Date edit that now falls after ETD invalidates whatever schedule/contract was
    // already booked against the old CRD. Only acts when there's actually something booked —
    // a plain CRD/ETD mismatch on a shipment with no contract/schedule yet isn't this rule's
    // concern. contractType is deliberately left as-is (see CLAUDE.md-adjacent plan notes) —
    // this lands on the same "contract type set, no ref yet" empty state already handled by
    // ShipmentSchedulesPage.jsx for a fresh shipment.
    let effContractId = contractId, effContractRef = contractRef, effAllocationId = allocationId;
    let effStatus = status;
    let scheduleDropped = false;
    const existingSchedules = db.prepare("SELECT * FROM shipment_schedules WHERE shipment_id=?").all(req.params.id);
    if (cargoReadyDate && etd && cargoReadyDate > etd && (contractId || existingSchedules.length > 0)) {
      effContractId = ""; effContractRef = ""; effAllocationId = "";
      effStatus = "Requires Review";
      scheduleDropped = true;
      const actor = req.user?.name || req.user?.email || "";
      for (const s of existingSchedules) {
        db.prepare("DELETE FROM shipment_schedules WHERE id=?").run(s.id);
        logEntityEvent('schedule', s.id, 'REMOVED', null, null, null,
          JSON.stringify({ shipmentId: req.params.id, carrier: s.carrier, vesselName: s.vessel_name,
            voyageNumber: s.voyage_number, service: s.service, pol: s.pol, pod: s.pod,
            actor, reason: 'CRD updated past ETD' }));
      }
    }

    const info = db.prepare(`
      UPDATE shipments SET pol=?, pod=?, carrier_code=?, contract_type=?, contract_notes=?, status=?,
      etd=?, eta=?, booking_ref=?, bl_number=?, vessel=?, voyage=?, incoterm=?, vessel_imo=?, contract_id=?, contract_ref=?, commodity_code=?,
      shipper_id=?, shipper_name=?, consignee_id=?, consignee_name=?, principal_id=?, principal_name=?,
      allocation_id=?, space_skip_reason=?, space_overage_reason=?,
      freight_terms=?, movement_type=?, service_type=?, place_of_receipt=?, place_of_delivery=?,
      cargo_ready_date=?, notify_id=?, notify_name=?,
      declared_value=?, declared_value_currency=?,
      emo_office_id=?, imo_office_id=?, controlling_office_id=?,
      contract_valid_from=?, contract_valid_to=? WHERE id=?
    `).run(polU, podU, carrierCode, contractType, contractNotes, effStatus, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, effContractId, effContractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName, effAllocationId, spaceSkipReason, spaceOverageReason, freightTerms, movementType, serviceType, placeOfReceipt, placeOfDelivery, cargoReadyDate || null, notifyId, notifyName, (declaredValue !== null && declaredValue !== undefined && String(declaredValue).trim() !== '') ? Number(declaredValue) : null, declaredValueCurrency || "USD", emoOfficeId || null, imoOfficeId || null, controllingOfficeId || null, contractValidFrom || null, contractValidTo || null, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    const newVals = { pol: polU, pod: podU, status: effStatus, etd, eta, carrier_code: carrierCode,
      vessel, vessel_imo: vesselImo, voyage, incoterm, commodity_code: commodityCode,
      booking_ref: bookingRef, bl_number: blNumber, contract_type: contractType,
      contract_id: effContractId, contract_ref: effContractRef, allocation_id: effAllocationId };
    for (const [col] of Object.entries(TRACKED_FIELDS)) {
      const o = String(existing[col] || ''), n = String(newVals[col] || '');
      if (o !== n) {
        const type = col === 'status' ? 'STATUS_CHANGED' : 'FIELD_UPDATED';
        logEvent(req.params.id, type, col, o || null, n || null);
      }
    }
    if (!existing.space_skip_reason && spaceSkipReason) {
      logEvent(req.params.id, 'SPACE_SKIPPED', 'space_skip_reason', null, spaceSkipReason,
        JSON.stringify({ contractId, contractNumber: contractRef }));
    }
    if (!existing.space_overage_reason && spaceOverageReason) {
      logEvent(req.params.id, 'SPACE_OVERAGE', 'space_overage_reason', null, spaceOverageReason,
        JSON.stringify({ allocationId }));
    }
    if (existing.status !== effStatus) {
      db.prepare("INSERT INTO status_log (id,shipment_id,from_status,to_status,changed_at,changed_by) VALUES (?,?,?,?,?,?)")
        .run(`SL-${uid()}`, req.params.id, existing.status, effStatus, new Date().toISOString(), "user");
    }
    const updated = db.prepare(`
      SELECT s.*, p1.name AS pol_name, p2.name AS pod_name,
             emo.code AS emo_office_code, emo.name AS emo_office_name,
             imo.code AS imo_office_code, imo.name AS imo_office_name,
             ctrl.code AS controlling_office_code, ctrl.name AS controlling_office_name
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      LEFT JOIN offices emo  ON emo.id  = s.emo_office_id
      LEFT JOIN offices imo  ON imo.id  = s.imo_office_id
      LEFT JOIN offices ctrl ON ctrl.id = s.controlling_office_id
      WHERE s.id = ?
    `).get(req.params.id);
    let silentScreening = null;
    if (sanctionsMap.size > 0) {
      const prev = db.prepare("SELECT result, overridden_at FROM shipment_screenings WHERE shipment_id=?").get(req.params.id);
      const isOverridden = prev?.result === 'CLEAR' && prev?.overridden_at;
      const partyOrRouteChanged = !prev
        || existing.shipper_name  !== shipperName
        || existing.consignee_name !== consigneeName
        || existing.principal_name !== principalName
        || existing.pol            !== polU
        || existing.pod            !== podU;
      if (!isOverridden && partyOrRouteChanged) silentScreening = screenShipmentById(req.params.id);
    }
    const body = mapShipment(updated);
    ok(res, { ...body, ...(silentScreening ? { screening: silentScreening } : {}), ...(scheduleDropped ? { scheduleDropped: true } : {}) });
  });

  app.delete("/api/shipments/:id", shipmentWrite, (req, res) => {
    const info = db.prepare("DELETE FROM shipments WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // ─── Containers ────────────────────────────────────────────────────────────

  app.get("/api/containers", (req, res) => {
    const rows = req.query.shipmentId
      ? db.prepare("SELECT * FROM containers WHERE shipment_id=?").all(req.query.shipmentId)
      : db.prepare("SELECT * FROM containers").all();
    const ids = rows.map(r => r.id);
    const evRows = ids.length
      ? db.prepare(`SELECT container_id, event_type, location, occurred_at FROM container_events
                    WHERE container_id IN (${ids.map(() => '?').join(',')}) ORDER BY occurred_at ASC`).all(...ids)
      : [];
    const byContainer = groupContainerEvents(evRows);
    ok(res, rows.map(r => {
      const g = byContainer[r.id] || { byType: {}, latest: null };
      return { ...mapContainer(r), ...deriveFreeTime(r, g.byType, g.latest) };
    }));
  });

  app.post("/api/containers", shipmentWrite, (req, res) => {
    const { shipmentId, containerNumber = "", sealNumber = "", size, type,
            hsCode = "", cargoDescription = "", grossWeightKg = null, volumeCbm = null, isDg = false, dgClass = "",
            vgmWeightKg = null, vgmStatus = "Pending", vgmCutoff = "", cyCutoff = "",
            originFreeTimeDays = null, destFreeTimeDays = null } = req.body;
    if (!shipmentId || !size || !type) return err(res, "shipmentId, size, type required");
    const dgErr = checkDgPolicy(shipmentId, isDg, dgClass);
    if (dgErr) return err(res, dgErr, 422);
    const id  = `CTR-${uid()}`;
    const cnU = containerNumber.toUpperCase();
    db.prepare(`INSERT INTO containers (id,shipment_id,container_number,seal_number,size,type,hs_code,cargo_description,gross_weight_kg,volume_cbm,is_dg,dg_class,
                vgm_weight_kg,vgm_status,vgm_cutoff,cy_cutoff,origin_free_time_days,dest_free_time_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, shipmentId, cnU, sealNumber, size, type, hsCode, cargoDescription, grossWeightKg, volumeCbm, isDg ? 1 : 0, dgClass,
           vgmWeightKg, vgmStatus, vgmCutoff || null, cyCutoff || null, originFreeTimeDays, destFreeTimeDays);
    const ctrRow = { id, shipment_id: shipmentId, container_number: cnU, seal_number: sealNumber, size, type, hs_code: hsCode, cargo_description: cargoDescription, gross_weight_kg: grossWeightKg, volume_cbm: volumeCbm, is_dg: isDg ? 1 : 0, dg_class: dgClass,
      vgm_weight_kg: vgmWeightKg, vgm_status: vgmStatus, vgm_cutoff: vgmCutoff || null, cy_cutoff: cyCutoff || null,
      origin_free_time_days: originFreeTimeDays, dest_free_time_days: destFreeTimeDays };
    // Brand-new container has no events yet — skip the query, free-time windows start 'not-started'.
    const addedCtr = { ...mapContainer(ctrRow), ...deriveFreeTime(ctrRow, {}, null) };
    logEvent(shipmentId, 'CONTAINER_ADDED', null, null, cnU,
      JSON.stringify({ size, type, hsCode, cargoDescription }));
    recomputeSpaceBadge(shipmentId);
    ok(res, addedCtr, 201);
  });

  app.put("/api/containers/:id", shipmentWrite, (req, res) => {
    const { containerNumber = "", sealNumber = "", size, type,
            hsCode = "", cargoDescription = "", grossWeightKg = null, volumeCbm = null, isDg = false, dgClass = "",
            vgmWeightKg = null, vgmStatus = "Pending", vgmCutoff = "", cyCutoff = "",
            originFreeTimeDays = null, destFreeTimeDays = null } = req.body;
    const cnU    = containerNumber.toUpperCase();
    const oldCtr = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
    if (!oldCtr) return err(res, "Not found", 404);
    const dgErr = checkDgPolicy(oldCtr.shipment_id, isDg, dgClass);
    if (dgErr) return err(res, dgErr, 422);
    const info = db.prepare(`UPDATE containers SET container_number=?, seal_number=?, size=?, type=?, hs_code=?, cargo_description=?, gross_weight_kg=?, volume_cbm=?, is_dg=?, dg_class=?,
                vgm_weight_kg=?, vgm_status=?, vgm_cutoff=?, cy_cutoff=?, origin_free_time_days=?, dest_free_time_days=? WHERE id=?`)
      .run(cnU, sealNumber, size, type, hsCode, cargoDescription, grossWeightKg, volumeCbm, isDg ? 1 : 0, dgClass,
           vgmWeightKg, vgmStatus, vgmCutoff || null, cyCutoff || null, originFreeTimeDays, destFreeTimeDays, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    const newVals = { container_number: cnU, size, type, hs_code: hsCode,
      cargo_description: cargoDescription, gross_weight_kg: grossWeightKg,
      volume_cbm: volumeCbm, is_dg: isDg ? 1 : 0, dg_class: dgClass,
      vgm_weight_kg: vgmWeightKg, vgm_status: vgmStatus, vgm_cutoff: vgmCutoff || null, cy_cutoff: cyCutoff || null,
      origin_free_time_days: originFreeTimeDays, dest_free_time_days: destFreeTimeDays };
    const meta = JSON.stringify({ containerNumber: cnU });
    for (const [col] of Object.entries(TRACKED_CTR_FIELDS)) {
      const o = String(oldCtr[col] ?? ''), n = String(newVals[col] ?? '');
      if (o !== n && !(o === '' && n === '')) {
        logEvent(oldCtr.shipment_id, 'CONTAINER_UPDATED', col, o, n, meta);
      }
    }
    const row = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
    const evRows = db.prepare("SELECT container_id, event_type, location, occurred_at FROM container_events WHERE container_id=? ORDER BY occurred_at ASC").all(req.params.id);
    const g = groupContainerEvents(evRows)[req.params.id] || { byType: {}, latest: null };
    recomputeSpaceBadge(oldCtr.shipment_id);

    // TKT-OZD4V8: VGM is declared alongside Shipping Instructions in real booking
    // workflows — once every container on the shipment has VGM Submitted, treat that
    // as the si_submitted milestone step firing, rather than a separate untracked step.
    if (oldCtr.vgm_status !== 'Submitted' && vgmStatus === 'Submitted') {
      const allCtrs = db.prepare("SELECT vgm_status FROM containers WHERE shipment_id=?").all(oldCtr.shipment_id);
      if (allCtrs.length > 0 && allCtrs.every(c => c.vgm_status === 'Submitted')) {
        autoCompleteMilestone(oldCtr.shipment_id, 'si_submitted',
          `Auto-completed — VGM submitted for all ${allCtrs.length} container(s)`);
      }
    }
    ok(res, { ...mapContainer(row), ...deriveFreeTime(row, g.byType, g.latest) });
  });

  app.delete("/api/containers/:id", shipmentWrite, (req, res) => {
    const ctr = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
    if (!ctr) return err(res, "Not found", 404);
    db.prepare("DELETE FROM containers WHERE id=?").run(req.params.id);
    logEvent(ctr.shipment_id, 'CONTAINER_REMOVED', null, ctr.container_number, null,
      JSON.stringify({ size: ctr.size, type: ctr.type }));
    recomputeSpaceBadge(ctr.shipment_id);
    ok(res, { deleted: req.params.id });
  });

  // ─── Container Events (FCL lifecycle: Empty Pickup → Gate In → Loaded → Sailed →
  //     Discharged → Gate Out → Empty Return) ────────────────────────────────

  const CONTAINER_EVENT_TYPES = ["Empty Pickup", "Gate In", "Loaded", "Sailed", "Discharged", "Gate Out", "Empty Return"];

  app.get("/api/containers/:id/events", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM container_events WHERE container_id=? ORDER BY occurred_at ASC, created_at ASC").all(req.params.id);
    ok(res, rows.map(mapContainerEvent));
  });

  app.post("/api/containers/:id/events", shipmentWrite, (req, res) => {
    const { eventType, occurredAt, location = "", notes = "" } = req.body || {};
    if (!eventType || !CONTAINER_EVENT_TYPES.includes(eventType))
      return err(res, `eventType must be one of: ${CONTAINER_EVENT_TYPES.join(", ")}`);
    if (!occurredAt) return err(res, "occurredAt required");
    const ctr = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
    if (!ctr) return err(res, "Container not found", 404);
    const id = `CEV-${uid()}`;
    const now = new Date().toISOString();
    const recordedBy = req.user?.name || req.user?.email || "";
    db.prepare(`INSERT INTO container_events
      (id, container_id, shipment_id, event_type, location, occurred_at, recorded_by, notes, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, req.params.id, ctr.shipment_id, eventType, location, occurredAt, recordedBy, notes, now);
    const event = mapContainerEvent(db.prepare("SELECT * FROM container_events WHERE id=?").get(id));
    logEvent(ctr.shipment_id, 'CONTAINER_EVENT_ADDED', null, null, `${eventType} — ${ctr.container_number}`,
      JSON.stringify({ containerId: req.params.id, eventType, occurredAt }));

    // TKT-OZD4V8: once every container on the shipment has logged the same lifecycle
    // event, that's the real-world signal the corresponding milestone step represents —
    // Gate In (origin) -> cargo_gated_in, Gate Out (destination) -> cargo_released.
    const MILESTONE_BY_EVENT = { 'Gate In': 'cargo_gated_in', 'Gate Out': 'cargo_released' };
    const milestoneKey = MILESTONE_BY_EVENT[eventType];
    if (milestoneKey) {
      const allCtrs = db.prepare("SELECT id FROM containers WHERE shipment_id=?").all(ctr.shipment_id);
      const withEvent = db.prepare("SELECT DISTINCT container_id FROM container_events WHERE shipment_id=? AND event_type=?").all(ctr.shipment_id, eventType);
      if (allCtrs.length > 0 && withEvent.length >= allCtrs.length) {
        autoCompleteMilestone(ctr.shipment_id, milestoneKey,
          `Auto-completed — all ${allCtrs.length} container(s) logged "${eventType}"`);
      }
    }
    ok(res, event, 201);
  });

  app.delete("/api/container-events/:id", shipmentWrite, (req, res) => {
    const ev = db.prepare("SELECT * FROM container_events WHERE id=?").get(req.params.id);
    if (!ev) return err(res, "Not found", 404);
    db.prepare("DELETE FROM container_events WHERE id=?").run(req.params.id);
    ok(res, { deleted: req.params.id });
  });

  // ─── Container cargo manifest: pallet/box sub-level breakdown (TKT-EMFIBR) ─
  // Self-referencing tree, arbitrary depth. Returned as a flat list ordered by
  // position — the client builds the tree from parentId itself (same idiom as
  // Kanban's parent_id ticket nesting).

  app.get("/api/containers/:id/packages", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM container_packages WHERE container_id=? ORDER BY position ASC, created_at ASC").all(req.params.id);
    ok(res, rows.map(mapContainerPackage));
  });

  app.post("/api/containers/:id/packages", shipmentWrite, (req, res) => {
    const { parentId = null, description, quantity = 1 } = req.body || {};
    if (!description || !description.trim()) return err(res, "description required");
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty < 1) return err(res, "quantity must be a positive integer");
    const ctr = db.prepare("SELECT id FROM containers WHERE id=?").get(req.params.id);
    if (!ctr) return err(res, "Container not found", 404);
    if (parentId) {
      const parent = db.prepare("SELECT id FROM container_packages WHERE id=? AND container_id=?").get(parentId, req.params.id);
      if (!parent) return err(res, "Parent package not found on this container", 404);
    }
    const siblingCount = db.prepare("SELECT COUNT(*) AS n FROM container_packages WHERE container_id=? AND parent_id IS ?").get(req.params.id, parentId).n;
    const id = `PKG-${uid()}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO container_packages (id, container_id, parent_id, description, quantity, position, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.params.id, parentId, description.trim(), qty, siblingCount, now);
    ok(res, mapContainerPackage(db.prepare("SELECT * FROM container_packages WHERE id=?").get(id)), 201);
  });

  app.put("/api/container-packages/:id", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM container_packages WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const { description, quantity } = req.body || {};
    if (!description || !description.trim()) return err(res, "description required");
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty < 1) return err(res, "quantity must be a positive integer");
    db.prepare("UPDATE container_packages SET description=?, quantity=? WHERE id=?")
      .run(description.trim(), qty, req.params.id);
    ok(res, mapContainerPackage({ ...existing, description: description.trim(), quantity: qty }));
  });

  // Deletes the package and its entire sub-tree (a package with children removed on
  // its own would otherwise orphan them with a dangling parent_id).
  app.delete("/api/container-packages/:id", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM container_packages WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const toDelete = [req.params.id];
    for (let i = 0; i < toDelete.length; i++) {
      const children = db.prepare("SELECT id FROM container_packages WHERE parent_id=?").all(toDelete[i]);
      toDelete.push(...children.map(c => c.id));
    }
    const placeholders = toDelete.map(() => '?').join(',');
    db.prepare(`DELETE FROM container_packages WHERE id IN (${placeholders})`).run(...toDelete);
    ok(res, { deleted: toDelete });
  });

  // ─── Shipment Messages ────────────────────────────────────────────────────

  app.get("/api/shipments/:id/messages", (req, res) => {
    const rows = db.prepare(
      "SELECT * FROM shipment_messages WHERE shipment_id=? ORDER BY created_at ASC"
    ).all(req.params.id);
    ok(res, rows.map(r => ({ id: r.id, shipmentId: r.shipment_id, body: r.body,
      author: r.author, role: r.role, createdAt: r.created_at })));
  });

  app.post("/api/shipments/:id/messages", (req, res) => {
    const { body, author = "User", role = "" } = req.body;
    if (!body || body.trim().length < 15) return err(res, "Message must be at least 15 characters", 400);
    if (body.trim().length > 500) return err(res, "Message must be at most 500 characters", 400);
    const id = `MSG-${uid()}`;
    const createdAt = new Date().toISOString();
    db.prepare("INSERT INTO shipment_messages (id,shipment_id,body,author,role,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, req.params.id, body.trim(), author.trim(), role.trim(), createdAt);
    const newMsg = { id, shipmentId: req.params.id, body: body.trim(), author, role, createdAt };
    broadcastMessage(req.params.id, newMsg);
    ok(res, newMsg, 201);
  });

  // ─── Shipment Legs ────────────────────────────────────────────────────────

  app.get("/api/shipments/:id/legs", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM shipment_legs WHERE shipment_id=? ORDER BY leg_order ASC").all(req.params.id);
    ok(res, rows.map(ctx.mapShipmentLeg));
  });

  app.post("/api/shipments/:id/legs", shipmentWrite, (req, res) => {
    const { legType='SEA', movementType='SEA', movementBy='',
            mot: rawMot, pol='', pod='', etd=null, eta=null, carrierCode='',
            polLocType='Terminal', podLocType='Terminal',
            vessel='', vesselImo='', voyage='', contractType='', contractRef='' } = req.body;
    const mot = rawMot || LEG_TO_MOT[legType] || 'SEA';
    const id = `LEG-${uid()}`;
    const maxOrder = db.prepare("SELECT MAX(leg_order) as m FROM shipment_legs WHERE shipment_id=?").get(req.params.id);
    const legOrder = (maxOrder?.m ?? -1) + 1;
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO shipment_legs (id,shipment_id,leg_order,mot,leg_type,movement_type,pol,pod,pol_loc_type,pod_loc_type,etd,eta,carrier_code,vessel,vessel_imo,voyage,movement_by,contract_type,contract_ref,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.params.id, legOrder, mot, legType, movementType,
           pol.toUpperCase(), pod.toUpperCase(), polLocType, podLocType,
           etd||null, eta||null, carrierCode, vessel, vesselImo, voyage, movementBy,
           contractType, contractRef, createdAt);
    syncShipmentFromLegs(req.params.id);
    ok(res, ctx.mapShipmentLeg(db.prepare("SELECT * FROM shipment_legs WHERE id=?").get(id)), 201);
  });

  app.put("/api/shipments/:id/legs/:legId", shipmentWrite, (req, res) => {
    const { legType='SEA', movementType='SEA', movementBy='',
            mot: rawMot, pol='', pod='', etd=null, eta=null, carrierCode='',
            polLocType='Terminal', podLocType='Terminal',
            vessel='', vesselImo='', voyage='', contractType='', contractRef='', legOrder } = req.body;
    const mot = rawMot || LEG_TO_MOT[legType] || 'SEA';
    const existing = db.prepare("SELECT * FROM shipment_legs WHERE id=? AND shipment_id=?").get(req.params.legId, req.params.id);
    if (!existing) return err(res, "Not found", 404);
    db.prepare(`UPDATE shipment_legs SET mot=?,leg_type=?,movement_type=?,pol=?,pod=?,pol_loc_type=?,pod_loc_type=?,etd=?,eta=?,carrier_code=?,vessel=?,vessel_imo=?,voyage=?,movement_by=?,contract_type=?,contract_ref=?,leg_order=? WHERE id=?`)
      .run(mot, legType, movementType, pol.toUpperCase(), pod.toUpperCase(),
           polLocType, podLocType, etd||null, eta||null,
           carrierCode, vessel, vesselImo, voyage, movementBy,
           contractType, contractRef, legOrder ?? existing.leg_order, req.params.legId);
    syncShipmentFromLegs(req.params.id);
    ok(res, ctx.mapShipmentLeg(db.prepare("SELECT * FROM shipment_legs WHERE id=?").get(req.params.legId)));
  });

  app.delete("/api/shipments/:id/legs/:legId", shipmentWrite, (req, res) => {
    const info = db.prepare("DELETE FROM shipment_legs WHERE id=? AND shipment_id=?").run(req.params.legId, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    syncShipmentFromLegs(req.params.id);
    ok(res, { deleted: req.params.legId });
  });
};
