"use strict";

module.exports = function ediRoutes(app, ctx) {
  const { db, ok, err, uid, auth, requireRole, getSettings, shipmentSubs,
          mapEdiMessage, mapCarrierBooking, mapShipment, applyShipmentAccessFilter,
          autoCompleteMilestone, logEntityEvent, BOOKABLE_CARRIERS, supersedeIfCarrierChanged } = ctx;

  // occ_bk has canEditShipments:true on the frontend and already sees an enabled Send
  // button — this used to exclude occ_bk (a pre-existing 403-on-click gap), fixed here.
  const write = requireRole(["operator", "admin", "occ_bk"]);

  function broadcast(shipmentId, frame) {
    const subs = shipmentSubs.get(shipmentId);
    if (!subs) return;
    const json = JSON.stringify(frame);
    for (const ws of subs) { if (ws.readyState === ws.OPEN) ws.send(json); }
  }

  // Real Maersk Booking API call — same shape as maerskSchedules() in routes/system.js
  // (Consumer-Key header, 10s timeout, null on any failure so the caller falls back to
  // the mock response). NOTE: the exact request/response contract below is a best-effort
  // placeholder — Maersk's real Booking API may use different field names or auth (OAuth2
  // client-credentials rather than a bare Consumer-Key); verify against their docs before
  // relying on this against a live account.
  async function maerskBookingRequest(shipment, payload) {
    const key = getSettings().maersk_api_key;
    if (!key) return null;
    try {
      const r = await fetch("https://api.maersk.com/booking/v1/bookings", {
        method: "POST",
        headers: { "Consumer-Key": key, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      const data = await r.json();
      return {
        status:     data.bookingStatus === "CONFIRMED" ? "confirmed" : "rejected",
        bookingRef: data.carrierBookingReference || null,
        raw:        data,
      };
    } catch { return null; }
  }

  // Synthetic responses used ONLY by the Test Tools Message Simulator (routes below) —
  // booking-request itself no longer auto-fabricates a response when no live key is
  // configured (that was the whole gap motivating the simulator: the old fallback could
  // only ever produce "confirmed", so a rejection could never be tested).
  function simulatedConfirmedResponse(shipment, bookingRefOverride) {
    const ref = bookingRefOverride || `MAEU${uid()}`;
    return {
      status: "confirmed",
      bookingRef: ref,
      raw: {
        bookingStatus: "CONFIRMED",
        carrierBookingReference: ref,
        pol: shipment.pol, pod: shipment.pod,
        vessel: shipment.vessel || null, voyage: shipment.voyage || null,
        note: "Simulated via Test Tools → Message Simulator.",
      },
    };
  }
  function simulatedRejectedResponse(shipment, reason) {
    return {
      status: "rejected",
      bookingRef: null,
      raw: {
        bookingStatus: "REJECTED",
        pol: shipment.pol, pod: shipment.pod,
        reason: reason || "No space available on requested sailing.",
        note: "Simulated via Test Tools → Message Simulator.",
      },
    };
  }

  // Shared by the real-API-success path and the simulator — records the inbound message
  // and updates the carrier_bookings projection identically either way (only `is_mock`
  // differs). A confirmed response deliberately does NOT finalize the booking — see the
  // status vs last_response_status split in the carrier_bookings migration comment
  // (server.js) for why. A rejected response has nothing to lock in, so it does.
  function applyBookingResponse(shipment, booking, response, isMock) {
    const inId = `EDI-${uid()}`;
    const inType = response.status === "confirmed" ? "booking_confirmation" : "booking_reject";
    const processedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO edi_messages
        (id, shipment_id, carrier_code, direction, message_type, format, raw_payload, parsed_payload,
         status, correlation_id, is_mock, created_at, processed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(inId, shipment.id, shipment.carrier_code, "in", inType, "JSON",
           JSON.stringify(response.raw), JSON.stringify({ bookingRef: response.bookingRef, status: response.status }),
           response.status, booking.correlation_id, isMock ? 1 : 0, processedAt, processedAt);

    const newStatus = response.status === "rejected" ? "Rejected" : booking.status;
    db.prepare(`
      UPDATE carrier_bookings SET last_response_status=?, booking_ref=?, status=?,
        responded_at=?, is_mock=?, updated_at=? WHERE id=?
    `).run(response.status, response.bookingRef || booking.booking_ref, newStatus,
           processedAt, isMock ? 1 : 0, processedAt, booking.id);

    const message = mapEdiMessage(db.prepare("SELECT * FROM edi_messages WHERE id=?").get(inId));
    broadcast(shipment.id, { type: "new_edi_message", message });
    const updatedBooking = mapCarrierBooking(db.prepare("SELECT * FROM carrier_bookings WHERE id=?").get(booking.id));
    broadcast(shipment.id, { type: "booking_status_changed", booking: updatedBooking });
    return { message, booking: updatedBooking };
  }

  function upsertPendingBooking(shipment, correlationId, requestedBy) {
    const now = new Date().toISOString();
    let existing = db.prepare("SELECT * FROM carrier_bookings WHERE shipment_id=?").get(shipment.id);
    // Any not-yet-Confirmed booking under a since-changed carrier — including one still
    // Pending — gets auto-cancelled and archived (own BKG- id preserved) rather than silently
    // reused here. This used to be the actual still-visible shape of the SHP-Y9E98X bug:
    // clicking Send again just overwrote the same row's carrier in place, discarding what
    // carrier the earlier attempt was really for.
    existing = supersedeIfCarrierChanged(shipment, existing);
    if (existing) {
      db.prepare(`
        UPDATE carrier_bookings SET status='Pending', last_response_status='', correlation_id=?,
          carrier_code=?, requested_at=?, requested_by=?, responded_at=NULL,
          cancelled_at=NULL, cancelled_by='', cancel_reason='', updated_at=? WHERE id=?
      `).run(correlationId, shipment.carrier_code, now, requestedBy, now, existing.id);
      return db.prepare("SELECT * FROM carrier_bookings WHERE id=?").get(existing.id);
    }
    const bookingId = `BKG-${uid()}`;
    db.prepare(`
      INSERT INTO carrier_bookings (id, shipment_id, carrier_code, status, correlation_id, requested_at, requested_by, created_at, updated_at)
      VALUES (?,?,?,'Pending',?,?,?,?,?)
    `).run(bookingId, shipment.id, shipment.carrier_code, correlationId, now, requestedBy, now, now);
    return db.prepare("SELECT * FROM carrier_bookings WHERE id=?").get(bookingId);
  }

  app.get("/api/shipments/:id/edi-messages", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM edi_messages WHERE shipment_id=? ORDER BY created_at DESC").all(req.params.id);
    ok(res, rows.map(mapEdiMessage));
  });

  app.get("/api/shipments/:id/carrier-booking", auth(), (req, res) => {
    const row = db.prepare("SELECT * FROM carrier_bookings WHERE shipment_id=?").get(req.params.id);
    ok(res, row ? mapCarrierBooking(row) : null);
  });

  // Superseded booking attempts — see ensureBookingCreated (server.js) for what actually
  // archives one. Newest-first; each entry keeps its own original BKG- id from when it was
  // the live booking, so "which schedule/carrier this attempt was actually for" stays exact.
  app.get("/api/shipments/:id/carrier-booking-history", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM carrier_booking_archive WHERE shipment_id=? ORDER BY archived_at DESC")
      .all(req.params.id);
    ok(res, rows.map(mapCarrierBooking));
  });

  // Cross-shipment list for Test Tools' Message Simulator picker — the one route in this
  // file that needs office-access scoping, since it lets a user browse shipments they
  // haven't specifically navigated to (the single-shipment routes above don't bother,
  // matching this file's existing precedent).
  app.get("/api/carrier-bookings", auth(), (req, res) => {
    const { status } = req.query;
    const rows = status
      ? db.prepare("SELECT * FROM carrier_bookings WHERE status=? ORDER BY updated_at DESC").all(status)
      : db.prepare("SELECT * FROM carrier_bookings ORDER BY updated_at DESC").all();
    if (rows.length === 0) return ok(res, []);

    const shipmentIds = [...new Set(rows.map(r => r.shipment_id))];
    const ph = shipmentIds.map(() => "?").join(",");
    const shipmentRows = db.prepare(`SELECT * FROM shipments WHERE id IN (${ph})`).all(...shipmentIds);
    const allowedShipments = applyShipmentAccessFilter(shipmentRows.map(mapShipment), req.user, req);
    const shipmentById = new Map(allowedShipments.map(s => [s.id, s]));

    ok(res, rows
      .filter(r => shipmentById.has(r.shipment_id))
      .map(r => ({ ...mapCarrierBooking(r), shipment: shipmentById.get(r.shipment_id) })));
  });

  app.post("/api/shipments/:id/edi-messages/booking-request", write, async (req, res) => {
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (!BOOKABLE_CARRIERS.has(shipment.carrier_code))
      return err(res, `Booking requests are not supported for carrier ${shipment.carrier_code}`, 400);

    const existingBooking = db.prepare("SELECT * FROM carrier_bookings WHERE shipment_id=?").get(shipment.id);
    if (existingBooking && existingBooking.status === "Pending")
      return err(res, "A booking request is already pending for this shipment", 409);

    const now = new Date().toISOString();
    const correlationId = `EDI-${uid()}`;

    // Equipment summary — TKT-0H9TSP: a real carrier can't allocate space against a
    // booking that says nothing about what's being shipped. Grouped by size+type (the
    // same "40HC"/"20GP" convention used everywhere else in this app) rather than listed
    // per-container — a carrier booking request states quantities per equipment type, not
    // individual container numbers (those aren't assigned until the carrier responds).
    const containerRows = db.prepare(
      "SELECT id, size, type, gross_weight_kg, volume_cbm, is_dg, dg_class, set_temperature_c FROM containers WHERE shipment_id=?"
    ).all(shipment.id);
    const equipmentByType = {};
    for (const c of containerRows) {
      const key = `${c.size}${c.type}`;
      const entry = equipmentByType[key] || (equipmentByType[key] = { type: key, count: 0, totalWeightKg: 0, totalVolumeCbm: 0 });
      entry.count += 1;
      entry.totalWeightKg += c.gross_weight_kg || 0;
      entry.totalVolumeCbm += c.volume_cbm || 0;
    }

    // DG declaration — TKT-O57N94: IFTMBF's DGS segment carries hazmat declarations at
    // booking time, not after the carrier has already allocated space. Same size+type
    // grouping as equipment above, plus the IMDG class. Also reaches into container_packages'
    // own is_dg/dg_class (v0.47.0) — a container can be clean at its own level but carry a
    // single DG-flagged pallet/carton inside it; declaring only container-level flags meant
    // that cargo sailed with zero DG declaration to the carrier. A container counts as DG if
    // either its own row OR any of its pack items (any depth) is flagged.
    const dgPackRows = db.prepare(`
      SELECT cp.container_id, cp.dg_class FROM container_packages cp
      JOIN containers c ON c.id = cp.container_id
      WHERE c.shipment_id=? AND cp.is_dg=1
    `).all(shipment.id);
    const packDgClassesByContainer = {};
    for (const p of dgPackRows) {
      (packDgClassesByContainer[p.container_id] ||= new Set()).add(p.dg_class || '');
    }
    const dgByType = {};
    for (const c of containerRows) {
      const packClasses = packDgClassesByContainer[c.id] || new Set();
      if (!c.is_dg && packClasses.size === 0) continue;
      const classes = new Set(packClasses);
      if (c.dg_class) classes.add(c.dg_class);
      classes.delete('');
      const key = `${c.size}${c.type}`;
      const entry = dgByType[key] || (dgByType[key] = { type: key, dgClass: [...classes].join('/'), count: 0 });
      entry.count += 1;
    }

    // Reefer set-point declaration — a carrier can't hold a 20RF/40RF booking without knowing
    // the required temperature, and different reefer containers on the same shipment can carry
    // different cargo (and so different set points), so this groups by type+temperature rather
    // than collapsing every reefer container into one line the way equipment/DG do.
    const reeferByKey = {};
    for (const c of containerRows) {
      if (c.type !== 'RF' || c.set_temperature_c == null) continue;
      const key = `${c.size}${c.type}_${c.set_temperature_c}`;
      const entry = reeferByKey[key] || (reeferByKey[key] = { type: `${c.size}${c.type}`, setTemperatureC: c.set_temperature_c, count: 0 });
      entry.count += 1;
    }

    // Same lookup importContractRates already uses to find the rate set that priced this
    // shipment (server.js) — reused rather than reinvented. null for SPOT/manual-contract
    // shipments, which never get a snapshot (they were never Central-contract-priced).
    const rateSnapshot = db.prepare(
      "SELECT id FROM shipment_rate_snapshots WHERE shipment_id=? ORDER BY generated_at DESC LIMIT 1"
    ).get(shipment.id);

    // NVOCC support (Epic TKT-Q52B38) — when this shipment is being handled through an NVOCC,
    // THAT party (not the underlying cargo owner) is the real shipper of record on the vessel
    // operator's own booking/Master B/L; shipment.shipper_name is the House B/L shipper, a
    // different, legally distinct party. Falls back to today's exact behavior when no NVOCC
    // party is assigned — byte-identical payload for every shipment booked direct with a carrier.
    const nvoccParty = db.prepare(
      "SELECT customer_name FROM shipment_parties WHERE shipment_id=? AND role='NVOCC'"
    ).get(shipment.id);

    const requestPayload = {
      pol: shipment.pol, pod: shipment.pod,
      carrierCode: shipment.carrier_code,
      etd: shipment.etd || null,
      vessel: shipment.vessel || null, voyage: shipment.voyage || null,
      vesselImo: shipment.vessel_imo || null,
      contractType: shipment.contract_type || null,
      contractRef: shipment.contract_ref || null,
      rateSnapshotId: rateSnapshot?.id || null,
      cargoReadyDate: shipment.cargo_ready_date || null,
      placeOfReceipt: shipment.place_of_receipt || null,
      placeOfDelivery: shipment.place_of_delivery || null,
      shipperName: nvoccParty?.customer_name || shipment.shipper_name || null,
      consigneeName: shipment.consignee_name || null,
      notifyName: shipment.notify_name || null,
      commodityCode: shipment.commodity_code || null,
      containerCount: containerRows.length,
      equipment: Object.values(equipmentByType),
      dgCargo: Object.values(dgByType),
      reeferCargo: Object.values(reeferByKey),
      ...(req.body || {}),
    };

    // Outbound message, recorded and broadcast immediately.
    const outId = `EDI-${uid()}`;
    db.prepare(`
      INSERT INTO edi_messages
        (id, shipment_id, carrier_code, direction, message_type, format, raw_payload,
         status, correlation_id, is_mock, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(outId, shipment.id, shipment.carrier_code, "out", "booking_request", "JSON",
           JSON.stringify(requestPayload), "sent", correlationId, 0, now);
    const sentMsg = mapEdiMessage(db.prepare("SELECT * FROM edi_messages WHERE id=?").get(outId));
    broadcast(shipment.id, { type: "new_edi_message", message: sentMsg });

    const requestedBy = req.user?.name || req.user?.email || "";
    const booking = upsertPendingBooking(shipment, correlationId, requestedBy);
    broadcast(shipment.id, { type: "booking_status_changed", booking: mapCarrierBooking(booking) });

    // Real API attempt only — no synthetic fallback here anymore (see simulatedXResponse
    // above for why). Unchanged external behavior for the case a live key IS configured.
    const response = await maerskBookingRequest(shipment, requestPayload);
    if (response) {
      const { message, booking: updatedBooking } = applyBookingResponse(shipment, booking, response, false);
      return ok(res, { sent: sentMsg, received: message, booking: updatedBooking, isMock: false }, 201);
    }

    ok(res, { sent: sentMsg, booking: mapCarrierBooking(booking), pending: true }, 201);
  });

  // Test Tools → Message Simulator: emulate a carrier's response to a pending booking
  // request without a live carrier account. Ties every simulated response to a real
  // outstanding request (409 if none) so the data model can't end up with a response that
  // was never actually requested.
  app.post("/api/shipments/:id/edi-messages/simulate-response", write, (req, res) => {
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    const { outcome, bookingRef, reason } = req.body || {};
    if (outcome !== "confirmed" && outcome !== "rejected")
      return err(res, 'outcome must be "confirmed" or "rejected"');

    const booking = db.prepare("SELECT * FROM carrier_bookings WHERE shipment_id=?").get(shipment.id);
    if (!booking || booking.status !== "Pending")
      return err(res, "This shipment has no pending booking request to respond to", 409);

    const response = outcome === "confirmed"
      ? simulatedConfirmedResponse(shipment, bookingRef)
      : simulatedRejectedResponse(shipment, reason);

    const { message, booking: updatedBooking } = applyBookingResponse(shipment, booking, response, true);
    ok(res, { received: message, booking: updatedBooking }, 201);
  });

  app.patch("/api/shipments/:id/carrier-booking/confirm", write, (req, res) => {
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    const { bookingRef, note } = req.body || {};

    let existing = db.prepare("SELECT * FROM carrier_bookings WHERE shipment_id=?").get(shipment.id);
    // Same supersede rule as Send (upsertPendingBooking above) — any not-yet-Confirmed booking
    // under a since-changed carrier is auto-cancelled and archived rather than resurrected as
    // "Confirmed" under a carrier it was never actually requested/rejected/cancelled for.
    existing = supersedeIfCarrierChanged(shipment, existing);
    if (existing && (existing.status === "Confirmed" || existing.status === "Cancelled"))
      return err(res, `Booking is already ${existing.status.toLowerCase()}`, 409);

    const ref = bookingRef || existing?.booking_ref || "";
    if (!ref) return err(res, "A booking reference is required to confirm");

    const now = new Date().toISOString();
    const confirmedBy = req.user?.name || req.user?.email || "";
    let booking;
    if (existing) {
      db.prepare(`
        UPDATE carrier_bookings SET status='Confirmed', booking_ref=?, confirmed_at=?,
          confirmed_by=?, carrier_code=?, updated_at=? WHERE id=?
      `).run(ref, now, confirmedBy, shipment.carrier_code, now, existing.id);
      booking = db.prepare("SELECT * FROM carrier_bookings WHERE id=?").get(existing.id);
    } else {
      // Manual confirmation with no prior request at all — gives non-EDI-bookable carriers
      // (everything outside MAEU/SAFM/MCPU) a full booking lifecycle too.
      const bookingId = `BKG-${uid()}`;
      db.prepare(`
        INSERT INTO carrier_bookings (id, shipment_id, carrier_code, status, booking_ref, confirmed_at, confirmed_by, created_at, updated_at)
        VALUES (?,?,?,'Confirmed',?,?,?,?,?)
      `).run(bookingId, shipment.id, shipment.carrier_code, ref, now, confirmedBy, now, now);
      booking = db.prepare("SELECT * FROM carrier_bookings WHERE id=?").get(bookingId);
    }

    // This is now the trigger point for booking_ref/milestone completion — moved from
    // firing automatically on any confirmed carrier response (the old behavior) to firing
    // only on this explicit operator action.
    db.prepare("UPDATE shipments SET booking_ref=? WHERE id=?").run(ref, shipment.id);
    autoCompleteMilestone(shipment.id, 'booking_confirmed',
      note || `Confirmed by ${confirmedBy || 'operator'} (ref ${ref})`);
    logEntityEvent('carrier_booking', booking.id, 'CONFIRMED', null, null, null,
      JSON.stringify({ bookingRef: ref, confirmedBy }));

    const mapped = mapCarrierBooking(booking);
    broadcast(shipment.id, { type: "booking_status_changed", booking: mapped });
    ok(res, mapped);
  });

  app.patch("/api/shipments/:id/carrier-booking/cancel", write, (req, res) => {
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    const { reason } = req.body || {};

    const existing = db.prepare("SELECT * FROM carrier_bookings WHERE shipment_id=?").get(shipment.id);
    if (existing && existing.status === "Cancelled") return err(res, "Booking is already cancelled", 409);

    const now = new Date().toISOString();
    const cancelledBy = req.user?.name || req.user?.email || "";

    // Notify the carrier only if something was actually transmitted for this booking.
    if (existing?.correlation_id && BOOKABLE_CARRIERS.has(shipment.carrier_code)) {
      const cancelId = `EDI-${uid()}`;
      db.prepare(`
        INSERT INTO edi_messages (id, shipment_id, carrier_code, direction, message_type, format, raw_payload, status, correlation_id, is_mock, created_at)
        VALUES (?,?,?,'out','booking_cancellation','JSON',?,'sent',?,0,?)
      `).run(cancelId, shipment.id, shipment.carrier_code, JSON.stringify({ reason: reason || "" }), existing.correlation_id, now);
      broadcast(shipment.id, {
        type: "new_edi_message",
        message: mapEdiMessage(db.prepare("SELECT * FROM edi_messages WHERE id=?").get(cancelId)),
      });
    }

    let booking;
    if (existing) {
      db.prepare(`
        UPDATE carrier_bookings SET status='Cancelled', cancelled_at=?, cancelled_by=?, cancel_reason=?, updated_at=? WHERE id=?
      `).run(now, cancelledBy, reason || "", now, existing.id);
      booking = db.prepare("SELECT * FROM carrier_bookings WHERE id=?").get(existing.id);
    } else {
      // A pure "we're not booking this" record with no prior request.
      const bookingId = `BKG-${uid()}`;
      db.prepare(`
        INSERT INTO carrier_bookings (id, shipment_id, carrier_code, status, cancelled_at, cancelled_by, cancel_reason, created_at, updated_at)
        VALUES (?,?,?,'Cancelled',?,?,?,?,?)
      `).run(bookingId, shipment.id, shipment.carrier_code, now, cancelledBy, reason || "", now, now);
      booking = db.prepare("SELECT * FROM carrier_bookings WHERE id=?").get(bookingId);
    }

    // Deliberately does not clear shipments.booking_ref or un-complete the milestone —
    // matches autoCompleteMilestone's own "never silently overwritten" philosophy.
    logEntityEvent('carrier_booking', booking.id, 'CANCELLED', null, null, null,
      JSON.stringify({ reason: reason || "", cancelledBy }));

    const mapped = mapCarrierBooking(booking);
    broadcast(shipment.id, { type: "booking_status_changed", booking: mapped });
    ok(res, mapped);
  });

  // TKT-LAK8P4 — booking-to-B/L traceability. Only ever touches the current live
  // carrier_bookings row (shipment_id is UNIQUE on that table) — an archived/superseded
  // row is read-only history, same convention CarrierBookingsTable.jsx already enforces
  // in its own UI. documentId: null clears the link.
  app.patch("/api/shipments/:id/carrier-booking/link-bl-document", write, (req, res) => {
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    const { documentId = null } = req.body || {};

    const booking = db.prepare("SELECT * FROM carrier_bookings WHERE shipment_id=?").get(shipment.id);
    if (!booking) return err(res, "This shipment has no booking to link a B/L to", 404);

    if (documentId) {
      const doc = db.prepare("SELECT * FROM shipment_documents WHERE id=?").get(documentId);
      if (!doc || doc.shipment_id !== shipment.id) return err(res, "Document not found on this shipment", 404);
      if (doc.doc_type !== "BL01") return err(res, "Only a Bill of Lading (BL01) document can be linked", 400);
    }

    const now = new Date().toISOString();
    db.prepare("UPDATE carrier_bookings SET bl_document_id=?, updated_at=? WHERE id=?")
      .run(documentId, now, booking.id);
    const updated = db.prepare("SELECT * FROM carrier_bookings WHERE id=?").get(booking.id);
    logEntityEvent('carrier_booking', booking.id, documentId ? 'BL_LINKED' : 'BL_UNLINKED', null, null, null,
      JSON.stringify({ documentId }));

    const mapped = mapCarrierBooking(updated);
    broadcast(shipment.id, { type: "booking_status_changed", booking: mapped });
    ok(res, mapped);
  });
};
