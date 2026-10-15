"use strict";

// Inbound carrier webhook receiver (Epic TKT-KG4E49, story 4) — DCSA's Booking API is
// asynchronous by design (a 202 Accepted response, then a later callback to a notification
// endpoint, or a poll). This is the single shared entry point regardless of how many carrier
// integrations end up configured — a second or third carrier never needs a second or third
// webhook route, only a new carrier_integrations row.
//
// The built-in DCSA carrier simulator (lib/dcsa-simulator, DCSA-everywhere phase 1) notifies through
// here too, under its reserved integration id "dcsa-simulator", signed with its own secret — so a
// simulated booking takes exactly the path a real carrier's does.
//
// Every notification must be a valid DCSA Booking 2.0 BookingNotification (lib/dcsa/validate.js);
// anything else is refused with 400 before it can touch a booking.
//
// Requires the exact raw request bytes for signature verification — server.js registers
// express.raw({type:"*/*"}) scoped to this path ahead of the global express.json() parser, so
// req.body here is a Buffer, not an already-parsed object.

const { validateRequest, errorsText, specVersion } = require("../lib/dcsa/validate");

module.exports = function carrierWebhooksRoutes(app, ctx) {
  const { query, ok, err, getCarrierAdapter, getSettings, dcsaSimulator } = ctx;

  app.post("/api/carrier-webhooks/:integrationId", async (req, res) => {
    const simulated = req.params.integrationId === dcsaSimulator.INTEGRATION_ID;

    let integration, config;
    if (simulated) {
      if (!(await dcsaSimulator.allowed())) return err(res, "Integration not found or inactive", 404);
      ({ row: integration, config } = dcsaSimulator.integration("", "booking"));
    } else {
      // Master safety-net toggle (api_carrier_integrations_enabled) — a real kill switch means an
      // already-in-flight carrier callback stops being processed too, not just new outbound
      // requests; a carrier that retries its callback will resend it once the feature is re-enabled.
      if ((await getSettings()).api_carrier_integrations_enabled === 'false')
        return err(res, "Carrier integrations are currently disabled", 503);
      [integration] = await query("SELECT * FROM carrier_integrations WHERE id=$1 AND is_active=TRUE", [req.params.integrationId]);
      if (!integration) return err(res, "Integration not found or inactive", 404);
      config = { baseUrl: integration.base_url, authHeaderName: integration.auth_header_name,
        credential: integration.credential, webhookSecret: integration.webhook_secret };
    }

    const adapter = getCarrierAdapter(integration.adapter_key);
    if (!adapter) return err(res, "No adapter registered for this integration", 500);

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    if (!adapter.verifyCallback(rawBody, req.headers, config))
      return err(res, "Invalid or missing webhook signature", 401);

    let parsedBody;
    try { parsedBody = JSON.parse(rawBody.toString("utf8")); }
    catch { return err(res, "Malformed webhook body — expected valid JSON", 400); }

    const valid = validateRequest("bkg", "post", "/v2/booking-notifications", parsedBody);
    if (!valid.ok) return err(res, `Not a valid DCSA Booking ${specVersion("bkg")} notification: ${errorsText(valid.errors, 4)}`, 400);

    // The state is under `data` (parseCallback). It names the booking by its request reference
    // and/or the carrier's booking number — after confirmation a carrier may send only the latter —
    // so either matches: within this integration's carrier, or for the simulator among the bookings
    // it issued (its request references start with SIM-, whatever the carrier).
    const response = adapter.parseCallback(parsedBody);
    const { carrierBookingRequestReference: reqRef, carrierBookingReference: carrierRef } = response.state;
    if (!reqRef && !carrierRef)
      return err(res, "Callback carries neither a carrierBookingRequestReference nor a carrierBookingReference to correlate against", 400);

    const [booking] = simulated
      ? await query(
          `SELECT * FROM carrier_bookings WHERE COALESCE(carrier_booking_request_reference, '') LIKE 'SIM-%'
             AND (carrier_booking_request_reference=$1 OR ($2 <> '' AND booking_ref=$2))
           ORDER BY updated_at DESC LIMIT 1`, [reqRef || "", carrierRef || ""])
      : await query(
          `SELECT * FROM carrier_bookings WHERE carrier_code=$1 AND COALESCE(carrier_booking_request_reference, '') <> ''
             AND (carrier_booking_request_reference=$2 OR ($3 <> '' AND booking_ref=$3))
           ORDER BY updated_at DESC LIMIT 1`, [integration.carrier_code, reqRef || "", carrierRef || ""]);
    if (!booking) return err(res, "No booking sent through this integration matches this reference", 404);

    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [booking.shipment_id]);
    if (!shipment) return err(res, "Shipment not found for this booking", 404);

    // routes/edi.js applyCarrierState — the same handling a poll gets; a repeated notification
    // records nothing new (changed: false).
    const { message, booking: updatedBooking, changed } = await ctx.applyCarrierState(shipment, booking, response.state,
      { source: "callback", raw: parsedBody, simulated });
    ok(res, { received: message, booking: updatedBooking, changed }, 201);
  });
};
