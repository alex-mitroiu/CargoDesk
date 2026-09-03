"use strict";

module.exports = function ediRoutes(app, ctx) {
  const { query, ok, err, uid, auth, requireRole, shipmentSubs,
          mapEdiMessage, mapCarrierBooking, mapShipment, applyShipmentAccessFilter,
          autoCompleteMilestone, logEntityEvent, isEdiBookable, supersedeIfCarrierChanged,
          getCustomerRow, checkLineAgentCapabilityGaps } = ctx;

  // occ_bk has canEditShipments:true on the frontend and already sees an enabled Send
  // button — this used to exclude occ_bk (a pre-existing 403-on-click gap), fixed here.
  const write = requireRole(["operator", "admin", "occ_bk"]);

  function broadcast(shipmentId, frame) {
    const subs = shipmentSubs.get(shipmentId);
    if (!subs) return;
    const json = JSON.stringify(frame);
    for (const ws of subs) { if (ws.readyState === ws.OPEN) ws.send(json); }
  }

  // The full outbound booking-request payload — same source the Review tab's Sent-vs-Received
  // comparison table diffs against on the "received" side, so every simulated response below
  // starts from it rather than synthesizing its own thin subset of fields.
  async function getLastOutboundPayload(shipmentId) {
    const [row] = await query(
      "SELECT raw_payload FROM edi_messages WHERE shipment_id=$1 AND direction='out' ORDER BY created_at DESC LIMIT 1", [shipmentId]
    );
    if (!row) return {};
    try { return JSON.parse(row.raw_payload) || {}; } catch { return {}; }
  }

  // Synthetic responses used ONLY by the Test Tools Message Simulator (routes below) —
  // booking-request itself never auto-fabricates a response (this was always simulated;
  // the live Maersk Booking API integration this used to attempt first has been removed,
  // v0.72.0 — Maersk's developer-tools portal it depended on is obsolete). Deliberately three
  // separate outcomes here, not one: the old always-"confirmed" fallback this replaced meant a
  // rejection could never be tested at all, and a real carrier routinely confirms with a
  // different vessel/voyage/ETD than what was actually requested — a third genuine outcome,
  // not something to fold into a plain confirmation or into Pending.
  async function simulatedConfirmedResponse(shipment, bookingRefOverride) {
    const ref = bookingRefOverride || `MAEU${uid()}`;
    return {
      status: "confirmed",
      bookingRef: ref,
      raw: {
        ...(await getLastOutboundPayload(shipment.id)),
        bookingStatus: "CONFIRMED",
        carrierBookingReference: ref,
        note: "Simulated via Test Tools → Message Simulator.",
      },
    };
  }
  // Carries whatever the carrier actually changed — falls back to the originally requested
  // value for anything not explicitly overridden, so the Review tab's comparison table only
  // highlights fields that genuinely differ.
  async function simulatedConfirmedWithChangesResponse(shipment, bookingRefOverride, overrides = {}) {
    const ref = bookingRefOverride || `MAEU${uid()}`;
    const sent = await getLastOutboundPayload(shipment.id);
    const changed = {};
    for (const key of ["vessel", "voyage", "etd", "vesselImo"]) {
      const v = overrides[key];
      if (v != null && String(v).trim() !== "") changed[key] = v;
    }
    return {
      status: "confirmed_with_changes",
      bookingRef: ref,
      raw: {
        ...sent,
        ...changed,
        bookingStatus: "CONFIRMED_WITH_CHANGES",
        carrierBookingReference: ref,
        note: "Simulated via Test Tools → Message Simulator — carrier confirmed with different details.",
      },
    };
  }
  async function simulatedRejectedResponse(shipment, reason) {
    return {
      status: "rejected",
      bookingRef: null,
      raw: {
        ...(await getLastOutboundPayload(shipment.id)),
        bookingStatus: "REJECTED",
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
  async function applyBookingResponse(shipment, booking, response, isMock) {
    const inId = `EDI-${uid()}`;
    const inType = response.status === "rejected" ? "booking_reject" : "booking_confirmation";
    const processedAt = new Date().toISOString();
    await query(`
      INSERT INTO edi_messages
        (id, shipment_id, carrier_code, direction, message_type, format, raw_payload, parsed_payload,
         status, correlation_id, is_mock, created_at, processed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [inId, shipment.id, shipment.carrier_code, "in", inType, "JSON",
           JSON.stringify(response.raw), JSON.stringify({ bookingRef: response.bookingRef, status: response.status }),
           response.status, booking.correlation_id, !!isMock, processedAt, processedAt]);

    const newStatus = response.status === "rejected" ? "Rejected" : booking.status;
    await query(`
      UPDATE carrier_bookings SET last_response_status=$1, booking_ref=$2, status=$3,
        responded_at=$4, is_mock=$5, updated_at=$6 WHERE id=$7
    `, [response.status, response.bookingRef || booking.booking_ref, newStatus,
           processedAt, !!isMock, processedAt, booking.id]);

    const [msgRow] = await query("SELECT * FROM edi_messages WHERE id=$1", [inId]);
    const message = mapEdiMessage(msgRow);
    broadcast(shipment.id, { type: "new_edi_message", message });
    const [bookingRow] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [booking.id]);
    const updatedBooking = mapCarrierBooking(bookingRow);
    broadcast(shipment.id, { type: "booking_status_changed", booking: updatedBooking });
    return { message, booking: updatedBooking };
  }

  async function upsertPendingBooking(shipment, correlationId, requestedBy) {
    const now = new Date().toISOString();
    let [existing] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    // Any not-yet-Confirmed booking under a since-changed carrier — including one still
    // Pending — gets auto-cancelled and archived (own BKG- id preserved) rather than silently
    // reused here. This used to be the actual still-visible shape of the SHP-Y9E98X bug:
    // clicking Send again just overwrote the same row's carrier in place, discarding what
    // carrier the earlier attempt was really for.
    existing = await supersedeIfCarrierChanged(shipment, existing);
    if (existing) {
      await query(`
        UPDATE carrier_bookings SET status='Pending', last_response_status='', correlation_id=$1,
          carrier_code=$2, requested_at=$3, requested_by=$4, responded_at=NULL,
          cancelled_at=NULL, cancelled_by='', cancel_reason='', updated_at=$5 WHERE id=$6
      `, [correlationId, shipment.carrier_code, now, requestedBy, now, existing.id]);
      const [fresh] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [existing.id]);
      return fresh;
    }
    const bookingId = `BKG-${uid()}`;
    await query(`
      INSERT INTO carrier_bookings (id, shipment_id, carrier_code, status, correlation_id, requested_at, requested_by, created_at, updated_at)
      VALUES ($1,$2,$3,'Pending',$4,$5,$6,$7,$8)
    `, [bookingId, shipment.id, shipment.carrier_code, correlationId, now, requestedBy, now, now]);
    const [fresh] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [bookingId]);
    return fresh;
  }

  app.get("/api/shipments/:id/edi-messages", auth(), async (req, res) => {
    const rows = await query("SELECT * FROM edi_messages WHERE shipment_id=$1 ORDER BY created_at DESC", [req.params.id]);
    ok(res, rows.map(mapEdiMessage));
  });

  app.get("/api/shipments/:id/carrier-booking", auth(), async (req, res) => {
    const [row] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [req.params.id]);
    ok(res, row ? mapCarrierBooking(row) : null);
  });

  // Superseded booking attempts — see ensureBookingCreated (server.js) for what actually
  // archives one. Newest-first; each entry keeps its own original BKG- id from when it was
  // the live booking, so "which schedule/carrier this attempt was actually for" stays exact.
  app.get("/api/shipments/:id/carrier-booking-history", auth(), async (req, res) => {
    const rows = await query("SELECT * FROM carrier_booking_archive WHERE shipment_id=$1 ORDER BY archived_at DESC", [req.params.id]);
    ok(res, rows.map(mapCarrierBooking));
  });

  // Cross-shipment list for Test Tools' Message Simulator picker — the one route in this
  // file that needs office-access scoping, since it lets a user browse shipments they
  // haven't specifically navigated to (the single-shipment routes above don't bother,
  // matching this file's existing precedent).
  app.get("/api/carrier-bookings", auth(), async (req, res) => {
    const { status } = req.query;
    const rows = status
      ? await query("SELECT * FROM carrier_bookings WHERE status=$1 ORDER BY updated_at DESC", [status])
      : await query("SELECT * FROM carrier_bookings ORDER BY updated_at DESC");
    if (rows.length === 0) return ok(res, []);

    const shipmentIds = [...new Set(rows.map(r => r.shipment_id))];
    const ph = shipmentIds.map((_, i) => `$${i + 1}`).join(",");
    const shipmentRows = await query(`SELECT * FROM shipments WHERE id IN (${ph})`, shipmentIds);
    const allowedShipments = await applyShipmentAccessFilter(shipmentRows.map(mapShipment), req.user, req);
    const shipmentById = new Map(allowedShipments.map(s => [s.id, s]));

    ok(res, rows
      .filter(r => shipmentById.has(r.shipment_id))
      .map(r => ({ ...mapCarrierBooking(r), shipment: shipmentById.get(r.shipment_id) })));
  });

  app.post("/api/shipments/:id/edi-messages/booking-request", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (!(await isEdiBookable(shipment.carrier_code, shipment.emo_office_id)))
      return err(res, `Booking requests are not supported for carrier ${shipment.carrier_code} at this shipment's office`, 400);

    const [existingBooking] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (existingBooking && existingBooking.status === "Pending")
      return err(res, "A booking request is already pending for this shipment", 409);

    // Earlier credit-check trigger point (TKT-Q00WHF, Credit Control Depth) — server-side
    // enforcement of the same hold-block the frontend already checks before ever calling this
    // route (ShipmentCarrierBookingDetailsPage.jsx's handleSend), so it can't be bypassed by
    // calling the API directly. Real commitment (a request actually sent to a carrier) is the
    // right moment for this to be a hard block, same as it already is at invoice-generation
    // time — only credit_hold blocks here, not the softer over-limit warning, since nothing's
    // being invoiced yet.
    const heldParties = [];
    for (const [pid, role] of [[shipment.shipper_id, 'Shipper'], [shipment.consignee_id, 'Consignee'], [shipment.principal_id, 'Principal']]) {
      if (!pid) continue;
      const cust = await getCustomerRow(pid);
      if (cust?.creditHold) heldParties.push({ companyName: cust.companyName, role, reason: cust.creditHoldReason || '' });
    }
    if (heldParties.length) {
      const names = heldParties.map(h => `${h.companyName} (${h.role})`).join(", ");
      return err(res, `On credit hold: ${names} — clear the hold on their customer profile before sending a booking request`, 409);
    }

    const now = new Date().toISOString();
    const correlationId = `EDI-${uid()}`;

    // Equipment summary — TKT-0H9TSP: a real carrier can't allocate space against a
    // booking that says nothing about what's being shipped. Grouped by size+type (the
    // same "40HC"/"20GP" convention used everywhere else in this app) rather than listed
    // per-container — a carrier booking request states quantities per equipment type, not
    // individual container numbers (those aren't assigned until the carrier responds).
    const containerRows = await query(
      "SELECT id, size, type, gross_weight_kg, volume_cbm, is_dg, dg_class, set_temperature_c FROM containers WHERE shipment_id=$1", [shipment.id]
    );
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
    const dgPackRows = await query(`
      SELECT cp.container_id, cp.dg_class FROM container_packages cp
      JOIN containers c ON c.id = cp.container_id
      WHERE c.shipment_id=$1 AND cp.is_dg=TRUE
    `, [shipment.id]);
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
    const [rateSnapshot] = await query(
      "SELECT id FROM shipment_rate_snapshots WHERE shipment_id=$1 ORDER BY generated_at DESC LIMIT 1", [shipment.id]
    );

    // NVOCC support (Epic TKT-Q52B38) — when this shipment is being handled through an NVOCC,
    // THAT party (not the underlying cargo owner) is the real shipper of record on the vessel
    // operator's own booking/Master B/L; shipment.shipper_name is the House B/L shipper, a
    // different, legally distinct party. Falls back to today's exact behavior when no NVOCC
    // party is assigned — byte-identical payload for every shipment booked direct with a carrier.
    const [nvoccParty] = await query(
      "SELECT customer_name FROM shipment_parties WHERE shipment_id=$1 AND role='NVOCC'", [shipment.id]
    );

    // ITN (Internal Transaction Number, TKT-6A7J45 story 1) — an Accepted AES/EEI filing's
    // confirmation_number IS the ITN. A carrier is legally required to have a valid one on
    // the export manifest before loading cargo, so it belongs in the booking-request payload
    // exactly like every other conveyance/compliance field above — previously generated and
    // then never referenced anywhere else in the app. null when no filing exists yet or it
    // hasn't been Accepted, same "nothing to show" convention as rateSnapshotId above.
    const [aesFiling] = await query(
      "SELECT confirmation_number FROM customs_filings WHERE shipment_id=$1 AND filing_type='AES_EEI' AND status='Accepted'", [shipment.id]
    );

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
      exportFilingItn: aesFiling?.confirmation_number || null,
      ...(req.body || {}),
    };

    // Outbound message, recorded and broadcast immediately.
    const outId = `EDI-${uid()}`;
    await query(`
      INSERT INTO edi_messages
        (id, shipment_id, carrier_code, direction, message_type, format, raw_payload,
         status, correlation_id, is_mock, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [outId, shipment.id, shipment.carrier_code, "out", "booking_request", "JSON",
           JSON.stringify(requestPayload), "sent", correlationId, false, now]);
    const [sentMsgRow] = await query("SELECT * FROM edi_messages WHERE id=$1", [outId]);
    const sentMsg = mapEdiMessage(sentMsgRow);
    broadcast(shipment.id, { type: "new_edi_message", message: sentMsg });

    const requestedBy = req.user?.name || req.user?.email || "";
    const booking = await upsertPendingBooking(shipment, correlationId, requestedBy);
    broadcast(shipment.id, { type: "booking_status_changed", booking: mapCarrierBooking(booking) });

    // Capabilities cross-check (TKT-FQFE33) — surfaced here too, not just the pre-send GET
    // endpoint (routes/shipments.js's line-agent-capability-gaps), matching the credit-hold
    // check's own dual client+server visibility: the frontend already shows this before Send is
    // even clicked, but the request itself carries it too so nothing is lost if this route is
    // ever called directly. Non-blocking either way.
    const capabilityGaps = await checkLineAgentCapabilityGaps(shipment.id);

    // Always pending — the real carrier response is simulated only, via Test Tools →
    // Message Simulator (see simulatedConfirmedResponse/simulatedRejectedResponse above).
    ok(res, { sent: sentMsg, booking: mapCarrierBooking(booking), pending: true, capabilityGaps }, 201);
  });

  // Test Tools → Message Simulator: emulate a carrier's response to a pending booking
  // request without a live carrier account. Ties every simulated response to a real
  // outstanding request (409 if none) so the data model can't end up with a response that
  // was never actually requested.
  app.post("/api/shipments/:id/edi-messages/simulate-response", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const { outcome, bookingRef, reason, vessel, voyage, etd, vesselImo } = req.body || {};
    if (!["confirmed", "rejected", "confirmed_with_changes"].includes(outcome))
      return err(res, 'outcome must be "confirmed", "rejected", or "confirmed_with_changes"');

    const [booking] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (!booking || booking.status !== "Pending")
      return err(res, "This shipment has no pending booking request to respond to", 409);

    const response = outcome === "confirmed"
      ? await simulatedConfirmedResponse(shipment, bookingRef)
      : outcome === "confirmed_with_changes"
      ? await simulatedConfirmedWithChangesResponse(shipment, bookingRef, { vessel, voyage, etd, vesselImo })
      : await simulatedRejectedResponse(shipment, reason);

    const { message, booking: updatedBooking } = await applyBookingResponse(shipment, booking, response, true);
    ok(res, { received: message, booking: updatedBooking }, 201);
  });

  app.patch("/api/shipments/:id/carrier-booking/confirm", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const { bookingRef, note } = req.body || {};

    let [existing] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    // Same supersede rule as Send (upsertPendingBooking above) — any not-yet-Confirmed booking
    // under a since-changed carrier is auto-cancelled and archived rather than resurrected as
    // "Confirmed" under a carrier it was never actually requested/rejected/cancelled for.
    existing = await supersedeIfCarrierChanged(shipment, existing);
    if (existing && (existing.status === "Confirmed" || existing.status === "Cancelled"))
      return err(res, `Booking is already ${existing.status.toLowerCase()}`, 409);

    const ref = bookingRef || existing?.booking_ref || "";
    if (!ref) return err(res, "A booking reference is required to confirm");

    const now = new Date().toISOString();
    const confirmedBy = req.user?.name || req.user?.email || "";
    let booking;
    if (existing) {
      await query(`
        UPDATE carrier_bookings SET status='Confirmed', booking_ref=$1, confirmed_at=$2,
          confirmed_by=$3, carrier_code=$4, updated_at=$5 WHERE id=$6
      `, [ref, now, confirmedBy, shipment.carrier_code, now, existing.id]);
      [booking] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [existing.id]);
    } else {
      // Manual confirmation with no prior request at all — gives non-EDI-bookable carriers
      // (everything outside MAEU/SAFM/MCPU) a full booking lifecycle too.
      const bookingId = `BKG-${uid()}`;
      await query(`
        INSERT INTO carrier_bookings (id, shipment_id, carrier_code, status, booking_ref, confirmed_at, confirmed_by, created_at, updated_at)
        VALUES ($1,$2,$3,'Confirmed',$4,$5,$6,$7,$8)
      `, [bookingId, shipment.id, shipment.carrier_code, ref, now, confirmedBy, now, now]);
      [booking] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [bookingId]);
    }

    // This is now the trigger point for booking_ref/milestone completion — moved from
    // firing automatically on any confirmed carrier response (the old behavior) to firing
    // only on this explicit operator action.
    await query("UPDATE shipments SET booking_ref=$1 WHERE id=$2", [ref, shipment.id]);
    await autoCompleteMilestone(shipment.id, 'booking_confirmed',
      note || `Confirmed by ${confirmedBy || 'operator'} (ref ${ref})`);
    await logEntityEvent('carrier_booking', booking.id, 'CONFIRMED', null, null, null,
      JSON.stringify({ bookingRef: ref, confirmedBy }));

    const mapped = mapCarrierBooking(booking);
    broadcast(shipment.id, { type: "booking_status_changed", booking: mapped });
    ok(res, mapped);
  });

  app.patch("/api/shipments/:id/carrier-booking/cancel", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const { reason } = req.body || {};

    const [existing] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (existing && existing.status === "Cancelled") return err(res, "Booking is already cancelled", 409);

    const now = new Date().toISOString();
    const cancelledBy = req.user?.name || req.user?.email || "";

    // Notify the carrier only if something was actually transmitted for this booking.
    if (existing?.correlation_id && await isEdiBookable(shipment.carrier_code, shipment.emo_office_id)) {
      const cancelId = `EDI-${uid()}`;
      await query(`
        INSERT INTO edi_messages (id, shipment_id, carrier_code, direction, message_type, format, raw_payload, status, correlation_id, is_mock, created_at)
        VALUES ($1,$2,$3,'out','booking_cancellation','JSON',$4,'sent',$5,FALSE,$6)
      `, [cancelId, shipment.id, shipment.carrier_code, JSON.stringify({ reason: reason || "" }), existing.correlation_id, now]);
      const [cancelRow] = await query("SELECT * FROM edi_messages WHERE id=$1", [cancelId]);
      broadcast(shipment.id, {
        type: "new_edi_message",
        message: mapEdiMessage(cancelRow),
      });
    }

    let booking;
    if (existing) {
      await query(`
        UPDATE carrier_bookings SET status='Cancelled', cancelled_at=$1, cancelled_by=$2, cancel_reason=$3, updated_at=$4 WHERE id=$5
      `, [now, cancelledBy, reason || "", now, existing.id]);
      [booking] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [existing.id]);
    } else {
      // A pure "we're not booking this" record with no prior request.
      const bookingId = `BKG-${uid()}`;
      await query(`
        INSERT INTO carrier_bookings (id, shipment_id, carrier_code, status, cancelled_at, cancelled_by, cancel_reason, created_at, updated_at)
        VALUES ($1,$2,$3,'Cancelled',$4,$5,$6,$7,$8)
      `, [bookingId, shipment.id, shipment.carrier_code, now, cancelledBy, reason || "", now, now]);
      [booking] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [bookingId]);
    }

    // Deliberately does not clear shipments.booking_ref or un-complete the milestone —
    // matches autoCompleteMilestone's own "never silently overwritten" philosophy.
    await logEntityEvent('carrier_booking', booking.id, 'CANCELLED', null, null, null,
      JSON.stringify({ reason: reason || "", cancelledBy }));

    const mapped = mapCarrierBooking(booking);
    broadcast(shipment.id, { type: "booking_status_changed", booking: mapped });
    ok(res, mapped);
  });

  // TKT-LAK8P4 — booking-to-B/L traceability. Only ever touches the current live
  // carrier_bookings row (shipment_id is UNIQUE on that table) — an archived/superseded
  // row is read-only history, same convention CarrierBookingsTable.jsx already enforces
  // in its own UI. documentId: null clears the link.
  app.patch("/api/shipments/:id/carrier-booking/link-bl-document", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const { documentId = null } = req.body || {};

    const [booking] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (!booking) return err(res, "This shipment has no booking to link a B/L to", 404);

    if (documentId) {
      const [doc] = await query("SELECT * FROM shipment_documents WHERE id=$1", [documentId]);
      if (!doc || doc.shipment_id !== shipment.id) return err(res, "Document not found on this shipment", 404);
      if (doc.doc_type !== "BL01") return err(res, "Only a Bill of Lading (BL01) document can be linked", 400);
    }

    const now = new Date().toISOString();
    await query("UPDATE carrier_bookings SET bl_document_id=$1, updated_at=$2 WHERE id=$3",
      [documentId, now, booking.id]);
    const [updated] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [booking.id]);
    await logEntityEvent('carrier_booking', booking.id, documentId ? 'BL_LINKED' : 'BL_UNLINKED', null, null, null,
      JSON.stringify({ documentId }));

    const mapped = mapCarrierBooking(updated);
    broadcast(shipment.id, { type: "booking_status_changed", booking: mapped });
    ok(res, mapped);
  });
};
