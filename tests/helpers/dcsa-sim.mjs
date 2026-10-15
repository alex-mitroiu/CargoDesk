// Shared by every suite that needs a carrier to answer a booking (DCSA-everywhere phase 1, 2026-10-11).
// Manual booking confirmation and the home-made Message Simulator are gone: a booking is confirmed,
// rejected, declined or cancelled only by its carrier — in tests, the built-in DCSA carrier simulator
// (lib/dcsa-simulator), played through its Test Tools API. Each suite passes its own request function:
//   request(method, path, body, token) → Promise<{ status, body }>

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The shipment's booking once the carrier has issued its request reference (the 202 is back and the
// simulator's RECEIVED notification has been applied), or null after `timeoutMs`.
export async function waitForCarrierReference(request, token, shipmentId, { timeoutMs = 5000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const b = (await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token)).body;
    if (b?.carrierBookingRequestReference && b.lastResponseStatus && b.lastResponseStatus !== "send_failed") return b;
    if (b?.lastResponseStatus === "send_failed") return b;
    await sleep(150);
  }
  return null;
}

// Plays one carrier decision on the shipment's booking: confirm, reject, requestUpdate,
// requestAmendment, decline, confirmAmendment, declineAmendment, confirmCancellation,
// declineCancellation. → the API response ({ status, body: { simulator, booking } }).
export async function carrierActs(request, token, shipmentId, action, message = "") {
  const b = await waitForCarrierReference(request, token, shipmentId);
  if (!b?.carrierBookingRequestReference) return { status: 0, body: { error: `No carrier reference on ${shipmentId}'s booking (${b?.lastResponseStatus || "none"})` } };
  return request("POST", `/api/test-tools/dcsa-sim/bookings/${b.carrierBookingRequestReference}/${action}`, message ? { message } : {}, token);
}

// Send Booking Request (unless one is already pending) and have the carrier answer `action` (default
// confirm). → { send, act, booking }. The shipment needs what a DCSA booking needs: a container.
export async function bookThroughCarrier(request, token, shipmentId, action = "confirm", message = "") {
  const current = (await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token)).body;
  const send = current?.status === "Pending" ? null : await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  const act = await carrierActs(request, token, shipmentId, action, message);
  const booking = (await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token)).body;
  return { send, act, booking };
}

// One realistic container, so a scratch shipment can be booked (DCSA requires requested equipment).
export async function addContainer(request, token, shipmentId, { size = "40", type = "HC" } = {}) {
  return request("POST", "/api/containers", {
    shipmentId, containerNumber: `DCSA${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 10)}`, size, type,
    hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60,
  }, token);
}
