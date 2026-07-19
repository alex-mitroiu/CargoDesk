"use strict";

module.exports = function ediRoutes(app, ctx) {
  const { db, ok, err, uid, auth, requireRole, getSettings, shipmentSubs, mapEdiMessage, autoCompleteMilestone } = ctx;

  const write = requireRole(["operator", "admin"]);

  // Carriers we can send a booking request to. Mirrors MAERSK_CODES in routes/system.js.
  const BOOKABLE_CARRIERS = new Set(["MAEU", "SAFM", "MCPU"]);

  function broadcastEdiMessage(shipmentId, message) {
    const subs = shipmentSubs.get(shipmentId);
    if (!subs) return;
    const frame = JSON.stringify({ type: "new_edi_message", message });
    for (const ws of subs) { if (ws.readyState === ws.OPEN) ws.send(frame); }
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

  // Demo fallback when no API key is configured — mirrors mockSailings()'s role for
  // schedules, so the feature is fully testable without live carrier credentials.
  function mockBookingResponse(shipment) {
    const ref = `MAEU${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    return {
      status:     "confirmed",
      bookingRef: ref,
      raw: {
        bookingStatus: "CONFIRMED",
        carrierBookingReference: ref,
        pol: shipment.pol, pod: shipment.pod,
        vessel: shipment.vessel || null, voyage: shipment.voyage || null,
        note: "Demo response — no Maersk API key configured.",
      },
    };
  }

  app.get("/api/shipments/:id/edi-messages", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM edi_messages WHERE shipment_id=? ORDER BY created_at DESC").all(req.params.id);
    ok(res, rows.map(mapEdiMessage));
  });

  app.post("/api/shipments/:id/edi-messages/booking-request", write, async (req, res) => {
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (!BOOKABLE_CARRIERS.has(shipment.carrier_code))
      return err(res, `Booking requests are not supported for carrier ${shipment.carrier_code}`, 400);

    const now = new Date().toISOString();
    const correlationId = `EDI-${uid()}`;
    const requestPayload = {
      pol: shipment.pol, pod: shipment.pod,
      carrierCode: shipment.carrier_code,
      etd: shipment.etd || null,
      vessel: shipment.vessel || null, voyage: shipment.voyage || null,
      contractType: shipment.contract_type || null,
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
    broadcastEdiMessage(shipment.id, mapEdiMessage(db.prepare("SELECT * FROM edi_messages WHERE id=?").get(outId)));

    // Carrier response — real API first, demo fallback on any failure/missing key.
    let response = await maerskBookingRequest(shipment, requestPayload);
    let isMock = false;
    if (!response) { response = mockBookingResponse(shipment); isMock = true; }

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
           response.status, correlationId, isMock ? 1 : 0, processedAt, processedAt);
    db.prepare("UPDATE edi_messages SET status=?, processed_at=? WHERE id=?").run(response.status, processedAt, outId);

    if (response.status === "confirmed" && response.bookingRef) {
      db.prepare("UPDATE shipments SET booking_ref=? WHERE id=?").run(response.bookingRef, shipment.id);
      // TKT-OZD4V8: a carrier booking confirmation is exactly what the booking_confirmed
      // milestone step represents — complete it automatically instead of requiring the
      // user to also go mark it by hand.
      autoCompleteMilestone(shipment.id, 'booking_confirmed',
        `Auto-completed on carrier booking confirmation (ref ${response.bookingRef})`);
    }

    const inMsg = mapEdiMessage(db.prepare("SELECT * FROM edi_messages WHERE id=?").get(inId));
    broadcastEdiMessage(shipment.id, inMsg);

    ok(res, {
      sent:     mapEdiMessage(db.prepare("SELECT * FROM edi_messages WHERE id=?").get(outId)),
      received: inMsg,
      isMock,
    }, 201);
  });
};
