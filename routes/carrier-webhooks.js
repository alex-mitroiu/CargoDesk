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

  // ─── Track & Trace 3.0 pushed events (2026-10-28) ────────────────────────────
  // The carrier POSTs { events } here, signed like its notifications. Each event goes to the shipments it
  // is about (lib/track-trace.js shipmentsFor) and is applied as a pulled one would be. DCSA answers 200
  // with feedbackElements: one WARN per event that matched no shipment.
  app.post("/api/carrier-webhooks/:integrationId/events", async (req, res) => {
    res.setHeader("API-Version", specVersion("tnt"));
    // PostEventsError: { feedbackElements } (with `error` kept for CargoDesk's own tools).
    const err = (r, message, status) => r.status(status).json({ error: message, feedbackElements: [{ severity: "ERROR", message }] });
    const simulated = req.params.integrationId === dcsaSimulator.INTEGRATION_ID;
    let integration, config;
    if (simulated) {
      if (!(await dcsaSimulator.allowed())) return err(res, "Integration not found or inactive", 404);
      ({ row: integration, config } = dcsaSimulator.integration("", "tracking"));
    } else {
      if ((await getSettings()).api_carrier_integrations_enabled === 'false') return err(res, "Carrier integrations are currently disabled", 503);
      [integration] = await query("SELECT * FROM carrier_integrations WHERE id=$1 AND is_active=TRUE", [req.params.integrationId]);
      if (!integration) return err(res, "Integration not found or inactive", 404);
      config = { baseUrl: integration.base_url, authHeaderName: integration.auth_header_name, credential: integration.credential, webhookSecret: integration.webhook_secret };
    }
    const adapter = getCarrierAdapter(integration.adapter_key);
    if (!adapter) return err(res, "No adapter registered for this integration", 500);
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    if (!adapter.verifyCallback(rawBody, req.headers, config)) return err(res, "Invalid or missing webhook signature", 401);
    let body;
    try { body = JSON.parse(rawBody.toString("utf8")); } catch { return err(res, "Malformed body — expected valid JSON", 400); }
    const valid = validateRequest("tnt", "post", "/events", body);
    if (!valid.ok || !Array.isArray(body?.events)) return err(res, `Not a valid DCSA Track & Trace ${specVersion("tnt")} event list: ${valid.ok ? "no events" : errorsText(valid.errors, 4)}`, 400);
    const r = await ctx.trackTrace.receive(body.events, { carrierCode: simulated ? "" : integration.carrier_code, simulated });
    res.status(200).json({ feedbackElements: r.feedbackElements });
  });

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

    // Shipping Instructions 3.0 notifications (2026-10-27) arrive at the same address; the CloudEvent
    // type tells them apart. DCSA answers them 204.
    if (parsedBody?.type === "org.dcsa.shipping-instructions.v3") {
      const validSi = validateRequest("ebl", "post", "/v3/shipping-instructions-notifications", parsedBody);
      if (!validSi.ok) return err(res, `Not a valid DCSA Shipping Instructions ${specVersion("ebl")} notification: ${errorsText(validSi.errors, 4)}`, 400);
      const state = adapter.parseShippingInstructionsNotification(parsedBody);
      // shippingInstructionsReference and/or transportDocumentReference (the spec requires one of them).
      const scope = simulated ? "is_mock=TRUE" : "carrier_code=$2", p = v => (simulated ? [v] : [v, integration.carrier_code]);
      let [si] = state.shippingInstructionsReference ? await query(`SELECT * FROM shipping_instructions WHERE si_reference=$1 AND ${scope}`, p(state.shippingInstructionsReference)) : [];
      if (!si && state.transportDocumentReference) [si] = await query(`SELECT * FROM shipping_instructions WHERE transport_document_reference=$1 AND ${scope}`, p(state.transportDocumentReference));
      if (!si && state.transportDocumentReference) [si] = await query(`SELECT si.* FROM shipping_instructions si JOIN transport_documents t ON t.shipment_id = si.shipment_id
        AND t.role='MASTER' AND t.reference=$1 WHERE si.${scope}`, p(state.transportDocumentReference));
      if (!si) return err(res, "No Shipping Instructions sent through this integration match this reference", 404);
      await ctx.applyShippingInstructionsState(si, state, { source: "callback", raw: parsedBody, simulated });
      return res.status(204).end();
    }
    // The carrier's transport document (the Master B/L, 2026-10-28): matched by the Shipping Instructions
    // it was drafted from, or by its own reference once CargoDesk holds it.
    if (parsedBody?.type === "org.dcsa.transport-document.v3") {
      const validTd = validateRequest("ebl", "post", "/v3/transport-document-notifications", parsedBody);
      if (!validTd.ok) return err(res, `Not a valid DCSA Transport Document ${specVersion("ebl")} notification: ${errorsText(validTd.errors, 4)}`, 400);
      const state = adapter.parseTransportDocumentNotification(parsedBody);
      const scope = simulated ? "si.is_mock=TRUE" : "si.carrier_code=$2";
      const params = ref => simulated ? [ref] : [ref, integration.carrier_code];
      const bySi = async ref => ref ? (await query(`SELECT si.* FROM shipping_instructions si WHERE si.si_reference=$1 AND ${scope}`, params(ref)))[0] : null;
      let document = state.document;
      // By the instructions it names; by the reference the carrier gave them for it; by the record CargoDesk
      // already holds; and, for a first notification that names only the document (as the spec's own examples
      // do), by reading the document from the carrier: it says which instructions it was drafted from.
      let si = await bySi(state.shippingInstructionsReference);
      if (!si && state.transportDocumentReference) [si] = await query(`SELECT si.* FROM shipping_instructions si WHERE si.transport_document_reference=$1 AND ${scope}`,
        params(state.transportDocumentReference));
      if (!si && state.transportDocumentReference) [si] = await query(`SELECT si.* FROM shipping_instructions si JOIN transport_documents t ON t.shipment_id = si.shipment_id
        AND t.role='MASTER' AND t.reference=$1 WHERE ${scope}`, params(state.transportDocumentReference));
      if (!si && state.transportDocumentReference && adapter.getTransportDocument) {
        const got = await adapter.getTransportDocument(config, state.transportDocumentReference);
        if (got.ok) { document = got.document; si = await bySi(got.state.shippingInstructionsReference); }
      }
      if (!si) return err(res, "No Shipping Instructions sent through this integration match this transport document", 404);
      const r = await ctx.applyTransportDocumentState(si, state, { document, source: "callback", raw: parsedBody, simulated });
      if (r.error) return err(res, r.error, 400);
      return res.status(204).end();
    }

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
