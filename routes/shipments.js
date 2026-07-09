"use strict";

module.exports = function shipmentsRoutes(app, ctx) {
  const { db, ok, err, uid, auth,
          mapShipment, mapShipmentLeg, mapContainer, mapAllocation,
          applyShipmentAccessFilter, syncShipmentFromLegs, importContractRates,
          broadcastMessage, recomputeSpaceBadge, screenShipmentById,
          logEvent, TRACKED_FIELDS, TRACKED_CTR_FIELDS,
          sanctionsMap } = ctx;

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

  // ─── Shipments ─────────────────────────────────────────────────────────────

  app.get("/api/shipments", (req, res) => {
    const rows = db.prepare(`
      SELECT s.*,
             p1.name AS pol_name,
             p2.name AS pod_name,
             COALESCE(buy.total, 0)  AS margin_buy_usd,
             COALESCE(sell.total, 0) AS margin_sell_usd,
             COALESCE(ms.overdue_count, 0) AS overdue_count
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
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
    ok(res, applyShipmentAccessFilter(rows.map(mapShipment), req.user, req));
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
      SELECT s.*, p1.name AS pol_name, p2.name AS pod_name
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      WHERE s.id = ?
    `).get(req.params.id);
    if (!row) return err(res, "Not found", 404);
    const s = mapShipment(row);
    if (!applyShipmentAccessFilter([s], req.user, req).length) return err(res, "Not found", 404);
    ok(res, s);
  });

  app.get("/api/shipments/:id/events", (req, res) => {
    const rows = db.prepare(
      "SELECT * FROM shipment_events WHERE shipment_id=? ORDER BY occurred_at ASC"
    ).all(req.params.id);
    ok(res, rows.map(r => ({
      id: r.id, shipmentId: r.shipment_id,
      eventType: r.event_type, field: r.field,
      oldValue: r.old_value, newValue: r.new_value,
      actor: r.actor, occurredAt: r.occurred_at,
      meta: r.meta ? JSON.parse(r.meta) : {},
    })));
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

  app.post("/api/shipments", (req, res) => {
    const { pol, pod, carrierCode, contractType, contractNotes = "", status = "Active",
            etd = "", eta = "", bookingRef = "", blNumber = "", vessel = "", voyage = "",
            incoterm = "", vesselImo = "", contractId = "", contractRef = "", commodityCode = "",
            shipperId = "", shipperName = "", consigneeId = "", consigneeName = "",
            principalId = "", principalName = "",
            allocationId = "", spaceSkipReason = "", spaceOverageReason = "",
            freightTerms = "Prepaid", movementType = "FCL", serviceType = "Port-to-Port",
            placeOfReceipt = "", placeOfDelivery = "", cargoReadyDate = null,
            notifyId = "", notifyName = "",
            declaredValue = null, declaredValueCurrency = "USD" } = req.body;
    if (!pol || !pod || !carrierCode || !contractType) return err(res, "pol, pod, carrierCode, contractType required");
    const id = `SHP-${uid()}`;
    const polU = pol.toUpperCase(), podU = pod.toUpperCase();
    const createdAt = new Date().toISOString();
    db.prepare("INSERT INTO shipments (id,pol,pod,carrier_code,contract_type,contract_notes,status,created_at,etd,eta,booking_ref,bl_number,vessel,voyage,incoterm,vessel_imo,contract_id,contract_ref,commodity_code,shipper_id,shipper_name,consignee_id,consignee_name,principal_id,principal_name,allocation_id,space_skip_reason,space_overage_reason,freight_terms,movement_type,service_type,place_of_receipt,place_of_delivery,cargo_ready_date,notify_id,notify_name,declared_value,declared_value_currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, polU, podU, carrierCode, contractType, contractNotes, status, createdAt, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, contractId, contractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName, allocationId, spaceSkipReason, spaceOverageReason, freightTerms, movementType, serviceType, placeOfReceipt, placeOfDelivery, cargoReadyDate || null, notifyId, notifyName, (declaredValue !== null && declaredValue !== undefined && String(declaredValue).trim() !== '') ? Number(declaredValue) : null, declaredValueCurrency || "USD");
    logEvent(id, 'SHIPMENT_CREATED', null, null, null,
      JSON.stringify({ pol: polU, pod: podU, carrier: carrierCode, status, etd, contractType }));
    if (contractType === 'Central' && contractId) importContractRates(id);
    const silentScreening = sanctionsMap.size > 0 ? screenShipmentById(id) : null;
    const base = mapShipment(db.prepare("SELECT * FROM shipments WHERE id=?").get(id));
    ok(res, silentScreening ? { ...base, screening: silentScreening } : base, 201);
  });

  app.put("/api/shipments/:id", (req, res) => {
    const { pol, pod, carrierCode, contractType, contractNotes = "", status,
            etd = "", eta = "", bookingRef = "", blNumber = "", vessel = "", voyage = "",
            incoterm = "", vesselImo = "", contractId = "", contractRef = "", commodityCode = "",
            shipperId = "", shipperName = "", consigneeId = "", consigneeName = "",
            principalId = "", principalName = "",
            allocationId = "", spaceSkipReason = "", spaceOverageReason = "",
            freightTerms = "Prepaid", movementType = "FCL", serviceType = "Port-to-Port",
            placeOfReceipt = "", placeOfDelivery = "", cargoReadyDate = null,
            notifyId = "", notifyName = "",
            declaredValue = null, declaredValueCurrency = "USD" } = req.body;
    const polU = pol.toUpperCase(), podU = pod.toUpperCase();
    const existing = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const info = db.prepare(`
      UPDATE shipments SET pol=?, pod=?, carrier_code=?, contract_type=?, contract_notes=?, status=?,
      etd=?, eta=?, booking_ref=?, bl_number=?, vessel=?, voyage=?, incoterm=?, vessel_imo=?, contract_id=?, contract_ref=?, commodity_code=?,
      shipper_id=?, shipper_name=?, consignee_id=?, consignee_name=?, principal_id=?, principal_name=?,
      allocation_id=?, space_skip_reason=?, space_overage_reason=?,
      freight_terms=?, movement_type=?, service_type=?, place_of_receipt=?, place_of_delivery=?,
      cargo_ready_date=?, notify_id=?, notify_name=?,
      declared_value=?, declared_value_currency=? WHERE id=?
    `).run(polU, podU, carrierCode, contractType, contractNotes, status, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, contractId, contractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName, allocationId, spaceSkipReason, spaceOverageReason, freightTerms, movementType, serviceType, placeOfReceipt, placeOfDelivery, cargoReadyDate || null, notifyId, notifyName, (declaredValue !== null && declaredValue !== undefined && String(declaredValue).trim() !== '') ? Number(declaredValue) : null, declaredValueCurrency || "USD", req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    const newVals = { pol: polU, pod: podU, status, etd, eta, carrier_code: carrierCode,
      vessel, vessel_imo: vesselImo, voyage, incoterm, commodity_code: commodityCode,
      booking_ref: bookingRef, bl_number: blNumber, contract_type: contractType,
      contract_id: contractId, contract_ref: contractRef, allocation_id: allocationId };
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
    if (existing.status !== status) {
      db.prepare("INSERT INTO status_log (id,shipment_id,from_status,to_status,changed_at,changed_by) VALUES (?,?,?,?,?,?)")
        .run(`SL-${uid()}`, req.params.id, existing.status, status, new Date().toISOString(), "user");
    }
    const updated = db.prepare(`
      SELECT s.*, p1.name AS pol_name, p2.name AS pod_name
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
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
    ok(res, silentScreening ? { ...mapShipment(updated), screening: silentScreening } : mapShipment(updated));
  });

  app.delete("/api/shipments/:id", (req, res) => {
    const info = db.prepare("DELETE FROM shipments WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // ─── Containers ────────────────────────────────────────────────────────────

  app.get("/api/containers", (req, res) => {
    const rows = req.query.shipmentId
      ? db.prepare("SELECT * FROM containers WHERE shipment_id=?").all(req.query.shipmentId)
      : db.prepare("SELECT * FROM containers").all();
    ok(res, rows.map(mapContainer));
  });

  app.post("/api/containers", (req, res) => {
    const { shipmentId, containerNumber = "", sealNumber = "", size, type,
            hsCode = "", cargoDescription = "", grossWeightKg = null, volumeCbm = null, isDg = false, dgClass = "" } = req.body;
    if (!shipmentId || !size || !type) return err(res, "shipmentId, size, type required");
    const dgErr = checkDgPolicy(shipmentId, isDg, dgClass);
    if (dgErr) return err(res, dgErr, 422);
    const id  = `CTR-${uid()}`;
    const cnU = containerNumber.toUpperCase();
    db.prepare("INSERT INTO containers (id,shipment_id,container_number,seal_number,size,type,hs_code,cargo_description,gross_weight_kg,volume_cbm,is_dg,dg_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, shipmentId, cnU, sealNumber, size, type, hsCode, cargoDescription, grossWeightKg, volumeCbm, isDg ? 1 : 0, dgClass);
    const addedCtr = mapContainer({ id, shipment_id: shipmentId, container_number: cnU, seal_number: sealNumber, size, type, hs_code: hsCode, cargo_description: cargoDescription, gross_weight_kg: grossWeightKg, volume_cbm: volumeCbm, is_dg: isDg ? 1 : 0, dg_class: dgClass });
    logEvent(shipmentId, 'CONTAINER_ADDED', null, null, cnU,
      JSON.stringify({ size, type, hsCode, cargoDescription }));
    recomputeSpaceBadge(shipmentId);
    ok(res, addedCtr, 201);
  });

  app.put("/api/containers/:id", (req, res) => {
    const { containerNumber = "", sealNumber = "", size, type,
            hsCode = "", cargoDescription = "", grossWeightKg = null, volumeCbm = null, isDg = false, dgClass = "" } = req.body;
    const cnU    = containerNumber.toUpperCase();
    const oldCtr = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
    if (!oldCtr) return err(res, "Not found", 404);
    const dgErr = checkDgPolicy(oldCtr.shipment_id, isDg, dgClass);
    if (dgErr) return err(res, dgErr, 422);
    const info = db.prepare("UPDATE containers SET container_number=?, seal_number=?, size=?, type=?, hs_code=?, cargo_description=?, gross_weight_kg=?, volume_cbm=?, is_dg=?, dg_class=? WHERE id=?")
      .run(cnU, sealNumber, size, type, hsCode, cargoDescription, grossWeightKg, volumeCbm, isDg ? 1 : 0, dgClass, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    const newVals = { container_number: cnU, size, type, hs_code: hsCode,
      cargo_description: cargoDescription, gross_weight_kg: grossWeightKg,
      volume_cbm: volumeCbm, is_dg: isDg ? 1 : 0, dg_class: dgClass };
    const meta = JSON.stringify({ containerNumber: cnU });
    for (const [col] of Object.entries(TRACKED_CTR_FIELDS)) {
      const o = String(oldCtr[col] ?? ''), n = String(newVals[col] ?? '');
      if (o !== n && !(o === '' && n === '')) {
        logEvent(oldCtr.shipment_id, 'CONTAINER_UPDATED', col, o, n, meta);
      }
    }
    const row = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
    recomputeSpaceBadge(oldCtr.shipment_id);
    ok(res, mapContainer(row));
  });

  app.delete("/api/containers/:id", (req, res) => {
    const ctr = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
    if (!ctr) return err(res, "Not found", 404);
    db.prepare("DELETE FROM containers WHERE id=?").run(req.params.id);
    logEvent(ctr.shipment_id, 'CONTAINER_REMOVED', null, ctr.container_number, null,
      JSON.stringify({ size: ctr.size, type: ctr.type }));
    recomputeSpaceBadge(ctr.shipment_id);
    ok(res, { deleted: req.params.id });
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

  app.post("/api/shipments/:id/legs", auth(), (req, res) => {
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

  app.put("/api/shipments/:id/legs/:legId", auth(), (req, res) => {
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

  app.delete("/api/shipments/:id/legs/:legId", auth(), (req, res) => {
    const info = db.prepare("DELETE FROM shipment_legs WHERE id=? AND shipment_id=?").run(req.params.legId, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    syncShipmentFromLegs(req.params.id);
    ok(res, { deleted: req.params.legId });
  });
};
