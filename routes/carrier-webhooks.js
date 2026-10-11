"use strict";

// Inbound carrier webhook receiver (Epic TKT-KG4E49, story 4) — DCSA's Booking API is
// asynchronous by design (a 202 Accepted response, then a later callback to a notification
// endpoint, or a poll) — a real structural difference from this app's own booking-request route,
// which historically only ever got answered by Test Tools' manual simulator. This is the single
// shared entry point regardless of how many carrier integrations end up configured — a second or
// third carrier never needs a second or third webhook route, only a new carrier_integrations row.
//
// Requires the exact raw request bytes for signature verification — server.js registers
// express.raw({type:"*/*"}) scoped to this path ahead of the global express.json() parser, so
// req.body here is a Buffer, not an already-parsed object.

module.exports = function carrierWebhooksRoutes(app, ctx) {
  const { query, ok, err, getCarrierAdapter, getSettings } = ctx;

  app.post("/api/carrier-webhooks/:integrationId", async (req, res) => {
    // Master safety-net toggle (api_carrier_integrations_enabled) — a real kill switch means an
    // already-in-flight carrier callback stops being processed too, not just new outbound
    // requests (routes/edi.js, routes/system.js); a carrier that retries its callback will
    // resend it once the feature is re-enabled.
    if ((await getSettings()).api_carrier_integrations_enabled === 'false')
      return err(res, "Carrier integrations are currently disabled", 503);

    const [integration] = await query(
      "SELECT * FROM carrier_integrations WHERE id=$1 AND is_active=TRUE", [req.params.integrationId]
    );
    if (!integration) return err(res, "Integration not found or inactive", 404);

    const adapter = getCarrierAdapter(integration.adapter_key);
    if (!adapter) return err(res, "No adapter registered for this integration", 500);

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const config = {
      baseUrl: integration.base_url, authHeaderName: integration.auth_header_name,
      credential: integration.credential, webhookSecret: integration.webhook_secret,
    };
    if (!adapter.verifyCallback(rawBody, req.headers, config))
      return err(res, "Invalid or missing webhook signature", 401);

    let parsedBody;
    try { parsedBody = JSON.parse(rawBody.toString("utf8")); }
    catch { return err(res, "Malformed webhook body — expected valid JSON", 400); }

    // A DCSA notification is a CloudEvent with the booking state under `data` (parseCallback reads
    // that, or a flat body). It names the booking by its request reference and/or the carrier's
    // booking number — after confirmation a carrier may send only the latter — so either matches,
    // within this integration's carrier.
    const response = adapter.parseCallback(parsedBody);
    const { carrierBookingRequestReference: reqRef, carrierBookingReference: carrierRef } = response.state;
    if (!reqRef && !carrierRef)
      return err(res, "Callback carries neither a carrierBookingRequestReference nor a carrierBookingReference to correlate against", 400);

    const [booking] = await query(
      `SELECT * FROM carrier_bookings WHERE carrier_code=$1 AND COALESCE(carrier_booking_request_reference, '') <> ''
         AND (carrier_booking_request_reference=$2 OR ($3 <> '' AND booking_ref=$3))
       ORDER BY updated_at DESC LIMIT 1`,
      [integration.carrier_code, reqRef || "", carrierRef || ""]
    );
    if (!booking) return err(res, "No booking sent through this integration matches this reference", 404);

    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [booking.shipment_id]);
    if (!shipment) return err(res, "Shipment not found for this booking", 404);

    // routes/edi.js applyCarrierState — the same handling a poll gets; a repeated notification
    // records nothing new (changed: false).
    const { message, booking: updatedBooking, changed } = await ctx.applyCarrierState(shipment, booking, response.state, { source: "callback", raw: parsedBody });
    ok(res, { received: message, booking: updatedBooking, changed }, 201);
  });
};
