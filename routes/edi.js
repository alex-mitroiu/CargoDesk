"use strict";

const { validateRequest, errorsText, specVersion } = require("../lib/dcsa/validate");
const { comparisonRows, planLegs } = require("../lib/carrier-confirmation");

module.exports = function ediRoutes(app, ctx) {
  const { query, ok, err, uid, auth, requireRole, shipmentSubs,
          mapEdiMessage, mapCarrierBooking, mapShipment, applyShipmentAccessFilter,
          autoCompleteMilestone, logEntityEvent, isEdiBookable, supersedeIfCarrierChanged,
          getCustomerRow, checkLineAgentCapabilityGaps, getCarrierAdapter, getSettings,
          officeSideOf, blockIfWrongSide, recomputeSpacePool, carrierIntegrationFor, shipmentLoopCode, logEvent } = ctx;

  // occ_bk has canEditShipments:true on the frontend and already sees an enabled Send
  // button — this used to exclude occ_bk (a pre-existing 403-on-click gap), fixed here.
  const write = requireRole(["operator", "admin", "occ_bk"]);

  function broadcast(shipmentId, frame) {
    const subs = shipmentSubs.get(shipmentId);
    if (!subs) return;
    const json = JSON.stringify(frame);
    for (const ws of subs) { if (ws.readyState === ws.OPEN) ws.send(json); }
  }

  // ─── A real carrier's booking state (DCSA, TKT-KG4E49, 2026-10-09) ─────────────────────────
  // What a carrier reports — by notification (routes/carrier-webhooks.js) or when polled — is the
  // DCSA state triple { bookingStatus, amendedBookingStatus, bookingCancellationStatus }. Only a
  // CHANGE is recorded (an inbound message + the booking updated); a repeated callback or an
  // unchanged poll just stamps carrier_state_at. Of several fields changing at once the most
  // specific one leads: cancellation, then amendment, then the booking status.
  //   booking CONFIRMED            → Confirmed, with the carrier's booking number: the shipment's
  //                                  booking ref is set and "Booking Confirmed" completes. Since
  //                                  2026-10-11 (DCSA-everywhere, decided by the user) this is the
  //                                  only way a booking is confirmed — the operator's Confirm click
  //                                  is gone — so it is also what deducts space.
  //   booking REJECTED / DECLINED  → Rejected
  //   booking CANCELLED, or CANCELLATION_CONFIRMED → Cancelled (frees its space)
  //   CANCELLATION_DECLINED        → stays Confirmed, last response "cancellation_declined"
  //   everything else              → recorded as the last response (received, update_requested,
  //                                  amendment_requested/confirmed/declined, completed, …)
  const STATE_KEYS = ["bookingStatus", "amendedBookingStatus", "bookingCancellationStatus"];
  const AMENDMENT_LABEL = { AMENDMENT_RECEIVED: "amendment_requested", AMENDMENT_CONFIRMED: "amendment_confirmed",
    AMENDMENT_DECLINED: "amendment_declined", AMENDMENT_CANCELLED: "amendment_cancelled" };
  const CANCELLATION_LABEL = { CANCELLATION_RECEIVED: "cancellation_requested", CANCELLATION_CONFIRMED: "cancelled",
    CANCELLATION_DECLINED: "cancellation_declined" };
  const BOOKING_LABEL = { RECEIVED: "received", UPDATE_RECEIVED: "received", PENDING_UPDATE: "update_requested",
    PENDING_AMENDMENT: "update_requested", CONFIRMED: "confirmed", REJECTED: "rejected", DECLINED: "rejected",
    CANCELLED: "cancelled", COMPLETED: "completed" };
  const DECISION_STATES = ["CONFIRMED", "REJECTED", "DECLINED", "PENDING_UPDATE"];

  async function applyCarrierState(shipment, booking, state, { source = "callback", raw = null, simulated = false } = {}) {
    const now = new Date().toISOString();
    let prev = {};
    try { prev = booking.carrier_state ? JSON.parse(booking.carrier_state) : {}; } catch { prev = {}; }
    const next = Object.fromEntries(STATE_KEYS.map(k => [k, state[k] || ""]));
    const changed = STATE_KEYS.filter(k => next[k] !== (prev[k] || ""));
    if (!changed.length) {
      await query("UPDATE carrier_bookings SET carrier_state_at=$1 WHERE id=$2", [now, booking.id]);
      const [row] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [booking.id]);
      return { changed: false, booking: mapCarrierBooking(row), message: null };
    }
    let label, status = booking.status;
    if (changed.includes("bookingCancellationStatus") && next.bookingCancellationStatus) {
      label = CANCELLATION_LABEL[next.bookingCancellationStatus] || next.bookingCancellationStatus.toLowerCase();
      if (next.bookingCancellationStatus === "CANCELLATION_CONFIRMED") status = "Cancelled";
    } else if (changed.includes("amendedBookingStatus") && next.amendedBookingStatus) {
      label = AMENDMENT_LABEL[next.amendedBookingStatus] || next.amendedBookingStatus.toLowerCase();
    } else {
      label = BOOKING_LABEL[next.bookingStatus] || (next.bookingStatus || "update").toLowerCase();
      if (next.bookingStatus === "REJECTED" || next.bookingStatus === "DECLINED") status = "Rejected";
      if (next.bookingStatus === "CANCELLED") status = "Cancelled";
      if (next.bookingStatus === "CONFIRMED" && ["Created", "Pending"].includes(booking.status)) status = "Confirmed";
    }
    const bookingRef = state.carrierBookingReference || booking.booking_ref || "";
    const inId = `EDI-${uid()}`;
    await query(`
      INSERT INTO edi_messages
        (id, shipment_id, carrier_code, direction, message_type, format, raw_payload, parsed_payload,
         status, correlation_id, is_mock, created_at, processed_at)
      VALUES ($1,$2,$3,'in',$4,'JSON',$5,$6,$7,$8,FALSE,$9,$9)
    `, [inId, shipment.id, booking.carrier_code || shipment.carrier_code, source === "poll" ? "booking_status" : "booking_notification",
        JSON.stringify(raw ?? state), JSON.stringify({ ...next, carrierBookingReference: state.carrierBookingReference || null, feedbacks: state.feedbacks || [] }),
        label, booking.correlation_id, now]);
    const cancelledNow = status === "Cancelled" && booking.status !== "Cancelled";
    const confirmedNow = status === "Confirmed" && booking.status !== "Confirmed";
    // The carrier's first DECISION on this request (booking escalations, TKT-ASIYFL): RECEIVED is
    // automatic and doesn't count, so "no answer" means no decision within the no-answer time.
    const decidedNow = changed.includes("bookingStatus") && DECISION_STATES.includes(next.bookingStatus);
    await query(`
      UPDATE carrier_bookings SET last_response_status=$1, booking_ref=$2, status=$3, responded_at=$4, is_mock=$8,
        confirmed_at=CASE WHEN $9 THEN $4 ELSE confirmed_at END,
        confirmed_by=CASE WHEN $9 THEN $10 ELSE confirmed_by END,
        carrier_state=$5, carrier_state_at=$4, updated_at=$4,
        decided_at=CASE WHEN $11 AND decided_at IS NULL THEN $4 ELSE decided_at END,
        cancelled_at=CASE WHEN $6 THEN $4 ELSE cancelled_at END,
        cancelled_by=CASE WHEN $6 THEN 'Carrier' ELSE cancelled_by END,
        cancel_reason=CASE WHEN $6 AND COALESCE(cancel_reason,'')='' THEN 'Cancelled by the carrier' ELSE cancel_reason END
      WHERE id=$7`,
      [label, bookingRef, status, now, JSON.stringify(next), cancelledNow, booking.id, !!(simulated || booking.is_mock), confirmedNow, booking.carrier_code || "Carrier", decidedNow]);
    // We asked to cancel a confirmed booking and the carrier let it go: its spot offer's cancellation
    // or no-show fee is now owed (lib/spot-offers.js; a carrier cancelling on its own charges nothing).
    if (cancelledNow && next.bookingCancellationStatus === "CANCELLATION_CONFIRMED" && booking.status === "Confirmed")
      await ctx.spotOffers.accrueCancellationFee(shipment.id).catch(e => console.error("Spot offer penalty:", e.message));
    // Accepted with changes (Epic TKT-ASIYFL, Story 6): a fresh confirmation is compared with what was
    // asked for before the escalation hook below sees it. A notification carries only the status, so the
    // booking is fetched (GET); a poll already has it in hand.
    if (next.bookingStatus === "CONFIRMED" && (confirmedNow || changed.includes("amendedBookingStatus"))) {
      const { dcsa, changes } = await confirmationChanges(booking, raw);
      await query("UPDATE carrier_bookings SET changed_fields=$1, carrier_confirmation=$2, changes_accepted_at=NULL, changes_accepted_by='' WHERE id=$3",
        [changes.length ? JSON.stringify(changes) : "", dcsa ? JSON.stringify(dcsa) : "", booking.id]);
      // The thread and Reports → Carrier Responses count it per request.
      if (changes.length) await query("UPDATE edi_messages SET status='confirmed_with_changes' WHERE id=$1", [inId]);
    }
    if (confirmedNow && bookingRef) {
      await query("UPDATE shipments SET booking_ref=$1 WHERE id=$2", [bookingRef, shipment.id]);
      await autoCompleteMilestone(shipment.id, "booking_confirmed",
        `Confirmed by ${booking.carrier_code || "the carrier"}${simulated ? " (demo carrier)" : ""} (ref ${bookingRef})`);
    }
    await logEntityEvent('carrier_booking', booking.id, 'CARRIER_STATE', null, booking.status, status,
      JSON.stringify({ ...next, source, label }));
    const [msgRow] = await query("SELECT * FROM edi_messages WHERE id=$1", [inId]);
    const message = mapEdiMessage(msgRow);
    broadcast(shipment.id, { type: "new_edi_message", message });
    const [row] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [booking.id]);
    const updated = mapCarrierBooking(row);
    broadcast(shipment.id, { type: "booking_status_changed", booking: updated });
    if (status !== booking.status) await recomputeSpacePool(shipment.id);
    // An open escalation follows the carrier (lib/booking-escalations.js): a booked-as-instructed
    // confirmation resolves it, so does the original carrier confirming after all.
    await ctx.bookingEscalations?.onCarrierState(shipment.id, row).catch(e => console.error("Booking escalation hook:", e.message));
    return { changed: true, booking: updated, message };
  }
  ctx.applyCarrierState = applyCarrierState;

  // The carrier's confirmed booking (the DCSA GET; a poll already has it) and what it changed: no
  // changes when it confirmed as asked, or when the confirmed booking can't be read (nothing is claimed
  // that wasn't seen). → { dcsa, changes }.
  async function confirmationChanges(booking, raw) {
    const be = ctx.bookingEscalations;
    if (!be) return { dcsa: null, changes: [] };
    let dcsa = raw && typeof raw === "object" && Array.isArray(raw.transportPlan) ? raw : null;
    if (!dcsa && booking.carrier_booking_request_reference) {
      const integ = await carrierIntegrationFor(booking.carrier_code, "booking");
      if (integ?.adapter.getBookingStatus) {
        const r = await integ.adapter.getBookingStatus(integ.config, booking.carrier_booking_request_reference);
        if (r.ok) dcsa = r.raw;
        else console.error(`Booking ${booking.id}: reading ${booking.carrier_code}'s confirmation failed:`, r.error);
      }
    }
    return { dcsa, changes: dcsa ? be.confirmationChanges(dcsa, (await be.settings()).changeRules, { requestedEta: booking.requested_eta || "" }) : [] };
  }

  // An outbound message to a real carrier (update, amendment, cancellation) on the shipment's thread.
  async function recordOutbound(shipment, booking, messageType, payload) {
    const id = `EDI-${uid()}`;
    await query(`
      INSERT INTO edi_messages (id, shipment_id, carrier_code, direction, message_type, format, raw_payload, status, correlation_id, is_mock, created_at)
      VALUES ($1,$2,$3,'out',$4,'JSON',$5,'sent',$6,FALSE,$7)
    `, [id, shipment.id, booking.carrier_code || shipment.carrier_code, messageType, JSON.stringify(payload), booking.correlation_id, new Date().toISOString()]);
    const [row] = await query("SELECT * FROM edi_messages WHERE id=$1", [id]);
    const message = mapEdiMessage(row);
    broadcast(shipment.id, { type: "new_edi_message", message });
    return message;
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
          cancelled_at=NULL, cancelled_by='', cancel_reason='',
          carrier_booking_request_reference='', carrier_state='', carrier_state_at=NULL, events_synced_at=NULL,
          decided_at=NULL, changed_fields='', requested_eta=$7, carrier_confirmation='', changes_accepted_at=NULL, changes_accepted_by='',
          updated_at=$5 WHERE id=$6
      `, [correlationId, shipment.carrier_code, now, requestedBy, now, existing.id, String(shipment.eta || "").slice(0, 10)]);
      const [fresh] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [existing.id]);
      return fresh;
    }
    const bookingId = `BKG-${uid()}`;
    await query(`
      INSERT INTO carrier_bookings (id, shipment_id, carrier_code, status, correlation_id, requested_at, requested_by, created_at, updated_at, requested_eta)
      VALUES ($1,$2,$3,'Pending',$4,$5,$6,$7,$8,$9)
    `, [bookingId, shipment.id, shipment.carrier_code, correlationId, now, requestedBy, now, now, String(shipment.eta || "").slice(0, 10)]);
    const [fresh] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [bookingId]);
    return fresh;
  }

  // The booking-request payload — the conveyance, equipment, DG, reefer, contract, parties and
  // compliance data every booking request carries, simulated or real. Shared by Send Booking
  // Request and Send Update to Carrier (TKT-KG4E49, 2026-10-09), so an update can never describe
  // the booking differently from the request. `body` = the caller's own overrides.
  async function bookingRequestPayload(shipment, body) {
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

    // Real contract number + reference as two distinct fields (direct request, 2026-09-25):
    // some carriers (this app's own comment: "only searches by the contract number") match a
    // booking request against nothing but the bare contract number; a carrier equipped to use
    // both (Hapag was named as the example) wants the number AND its own separate reference.
    // shipment.contract_ref is NOT that reference — it's set to the contract's contractNumber at
    // assignment time (ShipmentSchedulesPage.jsx), so re-sending it here would just duplicate the
    // number under a different key. The contract's real, independent reference (confirmed live:
    // e.g. contract "EC-HLCU-NLAMS-USNYC" carries its own ref "REF00404", never surfaced past the
    // Contracts MDM record before this) only exists on the contracts row itself.
    let contractNumber = null, contractRefForCarrier = shipment.contract_ref || null;
    if (shipment.contract_type === "Central" && shipment.contract_id) {
      const [linkedContract] = await query("SELECT contract_number, contract_ref FROM contracts WHERE id=$1", [shipment.contract_id]);
      if (linkedContract) {
        contractNumber = linkedContract.contract_number || null;
        contractRefForCarrier = linkedContract.contract_ref || null;
      }
    }

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

    // SPOT rates (2026-10-21): a SPOT shipment priced on a carrier's spot offer books with the offer's
    // reference — DCSA's contractQuotationReference, the counterpart of a contract's serviceContractReference.
    const quotationReference = await ctx.spotOffers.quotationReferenceFor(shipment);

    const requestPayload = {
      pol: shipment.pol, pod: shipment.pod,
      carrierCode: shipment.carrier_code,
      etd: shipment.etd || null,
      vessel: shipment.vessel || null, voyage: shipment.voyage || null,
      vesselImo: shipment.vessel_imo || null,
      contractType: shipment.contract_type || null,
      contractNumber, contractRef: contractRefForCarrier,
      ...(quotationReference ? { quotationReference } : {}),
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
      ...(body || {}),
    };
    return requestPayload;
  }

  // What a DCSA booking needs beyond the shared payload (required by the spec, or carried when
  // CargoDesk has it): service/movement/freight terms, the booking agent (the legal entity behind
  // the shipment's export office), the commodity description and HS codes, the loop as service code.
  async function dcsaBookingExtras(shipment) {
    const [agent] = shipment.emo_office_id ? await query(
      "SELECT o.name AS office_name, b.name AS branch_name FROM offices o LEFT JOIN branches b ON b.id = o.branch_id WHERE o.id=$1",
      [shipment.emo_office_id]) : [];
    const [commodity] = shipment.commodity_code ? await query("SELECT description FROM commodities WHERE code=$1", [shipment.commodity_code]) : [];
    const ctrs = await query("SELECT hs_code, cargo_description FROM containers WHERE shipment_id=$1", [shipment.id]);
    const loop = await shipmentLoopCode(shipment.id).catch(() => "");
    return {
      serviceType: shipment.service_type || "Port-to-Port", movementType: shipment.movement_type || "FCL",
      freightTerms: shipment.freight_terms || "", incoterm: shipment.incoterm || "",
      declaredValue: shipment.declared_value, declaredValueCurrency: shipment.declared_value_currency || "USD",
      bookingAgentName: agent?.branch_name || agent?.office_name || "",
      commodityDescription: commodity?.description || ctrs.map(c => c.cargo_description).find(Boolean) || "",
      hsCodes: [...new Set(ctrs.map(c => c.hs_code).filter(Boolean))],
      ...(loop ? { service: loop } : {}),
    };
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

  // Cross-shipment list of carrier bookings — the one route in this
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

  // Sends the shipment's booking request to its carrier — the route below, and Book As Instructed
  // (booking escalations, Epic TKT-ASIYFL). A refusal comes back as { status, body: { error } }, never
  // thrown; the caller checks the office side first (blockIfWrongSide).
  async function sendBookingRequest(shipmentId, { user = null, body = {} } = {}) {
    const fail = (status, error) => ({ status, body: { error } });
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
    if (!shipment) return fail(404, "Shipment not found");
    // DCSA only (2026-10-11): the carrier's own integration, or the built-in simulator where allowed.
    const integ = await carrierIntegrationFor(shipment.carrier_code, "booking");
    if (!integ)
      return fail(400, `No DCSA connection for ${shipment.carrier_code}: set one up under Carrier Integrations (or, for a demo, turn on App Settings → Demo carrier)`);

    const [existingBooking] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (existingBooking && existingBooking.status === "Pending")
      return fail(409, "A booking request is already pending for this shipment");

    // SPOT rates (the user, 2026-10-21): an expired digital spot offer can't be booked on; an expired
    // classic quote goes, with a warning (its terms may still hold).
    const spotCheck = await ctx.spotOffers.bookingCheck(shipment);
    if (spotCheck.block) return fail(409, spotCheck.block);

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
      return fail(409, `On credit hold: ${names} — clear the hold on their customer profile before sending a booking request`);
    }

    const now = new Date().toISOString();
    const correlationId = `EDI-${uid()}`;

    const requestPayload = await bookingRequestPayload(shipment, body);
    // Built and checked against DCSA Booking 2.0 before anything is recorded: a request the carrier
    // would answer 400 is refused here, with the reasons, instead of becoming a "sent" message and a
    // Pending booking that was never sent.
    const dcsaPayload = integ.adapter.buildBookingRequest(shipment, { ...requestPayload, ...(await dcsaBookingExtras(shipment)) });
    const check = validateRequest("bkg", "post", "/v2/bookings", dcsaPayload);
    if (!check.ok) {
      // The two gaps people actually hit, said plainly; anything else names the spec's own reasons.
      const missing = [check.errors.some(e => e.path.startsWith("/requestedEquipments")) && "at least one container",
        check.errors.some(e => e.path.startsWith("/shipmentLocations")) && "the port of loading and port of discharge"].filter(Boolean);
      return fail(400, missing.length ? `Can't send the booking request: add ${missing.join(" and ")} first (a DCSA booking needs them)`
        : `Can't send the booking request: it doesn't meet DCSA Booking ${specVersion("bkg")} (${errorsText(check.errors, 3)})`);
    }

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

    const requestedBy = user?.name || user?.email || "";
    let booking = await upsertPendingBooking(shipment, correlationId, requestedBy);

    // Sent to the carrier (TKT-KG4E49) — or the simulator. Never a 500 on failure: the carrier
    // answers asynchronously anyway, and a failed send is marked on the booking and returned.
    let carrierError = null;
    {
      const result = await integ.adapter.createBooking(integ.config, dcsaPayload);
      if (result.ok) {
        await query("UPDATE carrier_bookings SET carrier_booking_request_reference=$1, carrier_state_at=$2, is_mock=$3 WHERE id=$4",
          [result.carrierBookingRequestReference, new Date().toISOString(), !!integ.row.is_simulator, booking.id]);
        await ctx.spotOffers.markBooked(shipment);
      } else {
        // The carrier never got it: say so on the booking and to the caller, instead of leaving a
        // Pending booking that will never be answered (2026-10-09).
        carrierError = result.error;
        await query("UPDATE carrier_bookings SET last_response_status='send_failed', updated_at=$1 WHERE id=$2", [new Date().toISOString(), booking.id]);
        console.error(`Carrier integration ${shipment.carrier_code}/${integ.row.adapter_key}: createBooking failed:`, result.error);
      }
      [booking] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [booking.id]);
    }

    broadcast(shipment.id, { type: "booking_status_changed", booking: mapCarrierBooking(booking) });

    // Capabilities cross-check (TKT-FQFE33) — surfaced here too, not just the pre-send GET
    // endpoint (routes/shipments.js's line-agent-capability-gaps), matching the credit-hold
    // check's own dual client+server visibility: the frontend already shows this before Send is
    // even clicked, but the request itself carries it too so nothing is lost if this route is
    // ever called directly. Non-blocking either way.
    const capabilityGaps = await checkLineAgentCapabilityGaps(shipment.id);

    // Always pending — the carrier (a real one, or the built-in DCSA simulator) confirms
    // asynchronously, by notification (routes/carrier-webhooks.js) or when polled.
    return { status: 201, body: { sent: sentMsg, booking: mapCarrierBooking(booking), pending: true, capabilityGaps,
      ...(carrierError ? { carrierError } : {}), ...(spotCheck.warning ? { warning: spotCheck.warning } : {}) } };
  }
  ctx.sendBookingRequest = sendBookingRequest;

  app.post("/api/shipments/:id/edi-messages/booking-request", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const r = await sendBookingRequest(shipment.id, { user: req.user, body: req.body });
    if (r.body.error) return err(res, r.body.error, r.status);
    ok(res, r.body, r.status);
  });

  // Shared by the explicit PATCH route below and, since 2026-09 (Space Configuration spec, gap
  // #4), by routes/shipments.js's own PUT handler when a shipment's status transitions to
  // Cancelled — cancelling a shipment should cancel its live carrier booking too, not leave it
  // silently still consuming allocation space. Returns the mapped booking, or null if there was
  // nothing to cancel (no existing row — the PATCH route below still creates a pure "we're not
  // booking this" record in that case, since that's a deliberate explicit user action; the
  // auto-cancel-on-shipment-cancel call site checks for an existing row itself and skips this
  // function entirely when there's nothing to cancel, rather than fabricating one).
  async function cancelCarrierBooking(shipment, reason, cancelledBy) {
    const [existing] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (existing && existing.status === "Cancelled") return mapCarrierBooking(existing);
    const now = new Date().toISOString();

    // Sent through a carrier integration (TKT-KG4E49, decided by the user 2026-10-09): the carrier
    // is told first. If it doesn't accept the call, nothing changes here — CargoDesk never shows a
    // booking cancelled while the carrier still holds it. A booking not yet confirmed is simply
    // withdrawn (DCSA bookingStatus CANCELLED) and cancelled here. A CONFIRMED booking can only be
    // asked to cancel: it stays Confirmed, marked "cancellation_requested", until the carrier
    // answers (applyCarrierState: confirmed → Cancelled, declined → stays Confirmed) — so its
    // shipment can't be cancelled before the carrier has let the space go.
    if (existing && ["Pending", "Confirmed"].includes(existing.status) && existing.carrier_booking_request_reference) {
      const integ = await carrierIntegrationFor(existing.carrier_code, "booking");
      if (integ?.adapter.cancelBooking) {
        const confirmed = existing.status === "Confirmed";
        const result = await integ.adapter.cancelBooking(integ.config, existing.carrier_booking_request_reference, { confirmed, reason });
        if (!result.ok) throw Object.assign(new Error(`${existing.carrier_code} did not accept the cancellation (${result.error}). Nothing was changed — try again.`), { status: 502 });
        await recordOutbound(shipment, existing, confirmed ? "booking_cancellation_request" : "booking_cancellation",
          confirmed ? { bookingCancellationStatus: "CANCELLATION_RECEIVED", reason: reason || "" } : { bookingStatus: "CANCELLED", reason: reason || "" });
        if (confirmed) {
          await query("UPDATE carrier_bookings SET last_response_status='cancellation_requested', cancel_reason=$1, updated_at=$2 WHERE id=$3",
            [reason || "", now, existing.id]);
          await logEntityEvent('carrier_booking', existing.id, 'CANCELLATION_REQUESTED', null, null, null, JSON.stringify({ reason: reason || "", cancelledBy }));
          const [row] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [existing.id]);
          const mapped = mapCarrierBooking(row);
          broadcast(shipment.id, { type: "booking_status_changed", booking: mapped });
          return mapped;
        }
      }
    }

    // A booking that never went through DCSA (made before 2026-10-11) is cancelled here only.
    let booking;
    if (existing?.status === "Confirmed")
      await ctx.spotOffers.accrueCancellationFee(shipment.id, { actor: cancelledBy || "CargoDesk" }).catch(e => console.error("Spot offer penalty:", e.message));
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
    await recomputeSpacePool(shipment.id); // a cancelled booking frees its space (TKT-4JU8C8)
    return mapped;
  }
  // Exposed onto ctx (not defined in server.js, since this closure needs isEdiBookable/uid/query/
  // broadcast, all local to this file) so routes/shipments.js — required before this file in
  // server.js — can call it. Read via ctx.cancelCarrierBooking at request time there, never
  // destructured at module-load time, since this assignment hasn't happened yet when
  // routes/shipments.js's own module function first runs.
  ctx.cancelCarrierBooking = cancelCarrierBooking;

  app.patch("/api/shipments/:id/carrier-booking/cancel", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const { reason } = req.body || {};

    const [existing] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (existing && existing.status === "Cancelled") return err(res, "Booking is already cancelled", 409);
    if (existing?.last_response_status === "cancellation_requested")
      return err(res, `Cancellation already requested — waiting for ${existing.carrier_code} to answer`, 409);

    const cancelledBy = req.user?.name || req.user?.email || "";
    try {
      const mapped = await cancelCarrierBooking(shipment, reason, cancelledBy);
      ok(res, mapped);
    } catch (e) {
      if (e.status) return err(res, e.message, e.status);
      throw e;
    }
  });

  // ─── Booking update / amendment at the carrier (TKT-KG4E49, 2026-10-09) ─────────────────────
  // "Send update to carrier" on the Carrier Booking page: rebuilds the booking from the shipment as
  // it is now (the same payload Send Booking Request builds) and sends it to the carrier — a DCSA
  // update while the request is open, an amendment once the carrier has confirmed. The carrier
  // answers asynchronously, like a new request.
  app.post("/api/shipments/:id/carrier-booking/send-update", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const [booking] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (!booking || !booking.carrier_booking_request_reference)
      return err(res, "This booking wasn't sent through a carrier integration, so there's nothing to update at the carrier", 409);
    if (!["Pending", "Confirmed"].includes(booking.status))
      return err(res, `A ${booking.status.toLowerCase()} booking can't be updated — send a new booking request instead`, 409);
    if (booking.carrier_code !== shipment.carrier_code)
      return err(res, `The shipment's carrier is now ${shipment.carrier_code}, not ${booking.carrier_code} — send a new booking request instead`, 409);
    const integ = await carrierIntegrationFor(booking.carrier_code, "booking");
    if (!integ?.adapter.updateBooking) return err(res, `No active booking integration for ${booking.carrier_code}`, 409);

    const requestPayload = await bookingRequestPayload(shipment, req.body);
    const dcsaPayload = integ.adapter.buildBookingRequest(shipment, { ...requestPayload, ...(await dcsaBookingExtras(shipment)) });
    const result = await integ.adapter.updateBooking(integ.config, booking.carrier_booking_request_reference, dcsaPayload);
    if (!result.ok) return err(res, `${booking.carrier_code} did not accept the update (${result.error}). Nothing was changed — try again.`, 502);
    const amendment = booking.status === "Confirmed";
    const sent = await recordOutbound(shipment, booking, amendment ? "booking_amendment" : "booking_update", requestPayload);
    const now = new Date().toISOString();
    await query("UPDATE carrier_bookings SET last_response_status=$1, updated_at=$2 WHERE id=$3",
      [amendment ? "amendment_requested" : "update_sent", now, booking.id]);
    // A note goes to the History only: a DCSA booking has no free-text field to carry it to the carrier.
    const note = String(req.body?.note || "").trim().slice(0, 1000);
    await logEntityEvent('carrier_booking', booking.id, amendment ? 'AMENDMENT_SENT' : 'UPDATE_SENT', null, null, null,
      JSON.stringify({ by: req.user?.name || req.user?.email || "", ...(note ? { note } : {}) }));
    if (amendment) await logEvent(shipment.id, "CARRIER_AMENDMENT_REQUESTED", "carrier_booking", null, booking.carrier_code,
      JSON.stringify({ bookingRef: booking.booking_ref || "", ...(note ? { note } : {}) }), req.user?.name || req.user?.email || "");
    const [row] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [booking.id]);
    const mapped = mapCarrierBooking(row);
    broadcast(shipment.id, { type: "booking_status_changed", booking: mapped });
    ok(res, { sent, booking: mapped });
  });

  // ─── Requested (A) vs Carrier (B) (agreed 2026-10-21) ─────────────────────────────────────────
  // Column A is the request the carrier answered (the latest outbound request, update or amendment on
  // this booking), column B the carrier's DCSA confirmation; lib/carrier-confirmation.js builds the rows.
  app.get("/api/shipments/:id/carrier-booking/comparison", auth(), async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const [booking] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    let dcsa = null;
    try { dcsa = booking?.carrier_confirmation ? JSON.parse(booking.carrier_confirmation) : null; } catch { dcsa = null; }
    // Confirmed before the confirmation was kept (2026-10-21): ask the carrier once and keep it.
    if (!dcsa && booking?.status === "Confirmed" && booking.carrier_booking_request_reference) {
      const fetched = (await confirmationChanges(booking, null)).dcsa;
      if (fetched && Array.isArray(fetched.transportPlan)) {
        dcsa = fetched;
        await query("UPDATE carrier_bookings SET carrier_confirmation=$1 WHERE id=$2", [JSON.stringify(dcsa), booking.id]);
      }
    }
    if (!dcsa) return ok(res, { available: false });
    const [out] = await query(`SELECT raw_payload, created_at FROM edi_messages WHERE shipment_id=$1 AND direction='out'
      AND message_type IN ('booking_request','booking_update','booking_amendment') AND correlation_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [shipment.id, booking.correlation_id]);
    let request = {};
    try { request = JSON.parse(out?.raw_payload || "{}"); } catch { request = {}; }
    // The spot offer the shipment is priced on, for the carrier's charges (SPOT rates, 2026-10-21).
    const spot = shipment.spot_offer_id ? await ctx.spotOffers.get(shipment.spot_offer_id) : null;
    const rows = comparisonRows(request, dcsa, { requestedEta: booking.requested_eta || "", carrierCode: booking.carrier_code, bookingRef: booking.booking_ref,
      offerLines: spot?.carrierCode === booking.carrier_code ? spot.lines : null });
    ok(res, {
      available: true, status: booking.status, carrierCode: booking.carrier_code, bookingRef: dcsa.carrierBookingReference || booking.booking_ref || "",
      requestedAt: out?.created_at || booking.requested_at, confirmedAt: booking.confirmed_at || booking.decided_at,
      feedback: (dcsa.feedbacks || []).map(f => f.message).filter(Boolean),
      changeCount: rows.filter(r => r.kind === "changed").length, withChanges: !!(booking.changed_fields && booking.changed_fields !== "[]"),
      accepted: booking.changes_accepted_at ? { at: booking.changes_accepted_at, by: booking.changes_accepted_by || "" } : null,
      legs: planLegs(dcsa), rows,
    });
  });

  // Accept the carrier's version: its confirmed sailing (every leg), vessel, dates and cut-offs go on
  // the shipment (lib/booking-escalations.js acceptCarrierChanges). OCC/BK of the export side, admin, operator.
  app.post("/api/shipments/:id/carrier-booking/accept-changes", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const [booking] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (!booking) return err(res, "There's no carrier booking to accept", 409);
    const r = await ctx.bookingEscalations.acceptCarrierChanges(shipment, booking, req.user);
    if (r.error) return err(res, r.error, r.status || 400);
    const [row] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [booking.id]);
    const mapped = mapCarrierBooking(row);
    broadcast(shipment.id, { type: "booking_status_changed", booking: mapped });
    ok(res, { ...r, booking: mapped });
  });

  // ─── Polling the carrier (TKT-KG4E49, 2026-10-09) ────────────────────────────────────────────
  // DCSA answers by notification or by poll; a lost notification used to leave a booking Pending
  // for good. pollCarrierBooking asks the carrier (GET /v2/bookings/{ref}) and applies the answer
  // exactly as a notification would — "Check status now" on the Carrier Booking page, and a sweep
  // every CARRIER_POLL_MINUTES for bookings sent through an integration that haven't been heard
  // from for that long.
  async function pollCarrierBooking(shipment, booking) {
    const integ = await carrierIntegrationFor(booking.carrier_code, "booking");
    if (!integ?.adapter.getBookingStatus) return { ok: false, status: 409, error: `No active booking integration for ${booking.carrier_code}` };
    const result = await integ.adapter.getBookingStatus(integ.config, booking.carrier_booking_request_reference);
    if (!result.ok) return { ok: false, status: 502, error: `${booking.carrier_code} could not be asked (${result.error})` };
    return { ok: true, ...(await applyCarrierState(shipment, booking, result.state, { source: "poll", raw: result.raw, simulated: !!integ.row.is_simulator })) };
  }

  app.post("/api/shipments/:id/carrier-booking/check-status", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const [booking] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (!booking || !booking.carrier_booking_request_reference)
      return err(res, "This booking wasn't sent through a carrier integration, so there's nothing to ask the carrier", 409);
    const r = await pollCarrierBooking(shipment, booking);
    if (!r.ok) return err(res, r.error, r.status);
    ok(res, { changed: r.changed, booking: r.booking, message: r.message });
  });

  const CARRIER_POLL_MINUTES = 15;
  async function runCarrierBookingPollSweep({ olderThanMinutes = CARRIER_POLL_MINUTES } = {}) {
    if ((await getSettings()).api_carrier_integrations_enabled === 'false') return { polled: 0, changed: 0, failed: 0 };
    const cutoff = new Date(Date.now() - olderThanMinutes * 60000).toISOString();
    const rows = await query(`
      SELECT cb.* FROM carrier_bookings cb
      JOIN carrier_integrations ci ON ci.carrier_code = cb.carrier_code AND ci.is_active = TRUE
      WHERE cb.status IN ('Pending','Confirmed') AND COALESCE(cb.carrier_booking_request_reference, '') <> ''
        AND (cb.carrier_state_at IS NULL OR cb.carrier_state_at <= $1)`, [cutoff]);
    const summary = { polled: 0, changed: 0, failed: 0 };
    for (const booking of rows) {
      const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [booking.shipment_id]);
      if (!shipment) continue;
      const r = await pollCarrierBooking(shipment, booking).catch(e => ({ ok: false, error: e.message }));
      if (!r.ok) { summary.failed++; if (r.status !== 409) console.warn(`Carrier booking poll ${booking.id}:`, r.error); continue; }
      summary.polled++;
      if (r.changed) summary.changed++;
    }
    return summary;
  }
  ctx.runCarrierBookingPollSweep = runCarrierBookingPollSweep;
  const pollTimer = setInterval(() => { runCarrierBookingPollSweep().catch(e => console.error("Carrier booking poll sweep failed:", e.message)); },
    CARRIER_POLL_MINUTES * 60000);
  pollTimer.unref?.();

  // Admin trigger for the same sweep (Test Tools / tests), every waiting booking regardless of age.
  app.post("/api/carrier-bookings/poll-sweep", requireRole(["admin"]), async (req, res) => {
    ok(res, await runCarrierBookingPollSweep({ olderThanMinutes: 0 }));
  });

  // TKT-LAK8P4 — booking-to-B/L traceability. Only ever touches the current live
  // carrier_bookings row (shipment_id is UNIQUE on that table) — an archived/superseded
  // row is read-only history, same convention CarrierBookingsTable.jsx already enforces
  // in its own UI. documentId: null clears the link.
  app.patch("/api/shipments/:id/carrier-booking/link-bl-document", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
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
