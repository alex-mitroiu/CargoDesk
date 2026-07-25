/**
 * v0.35.0 Smoke tests — Carrier Booking (send / simulate / confirm / cancel)
 *
 * Usage:
 *   node tests/carrier-booking.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: "localhost",
      port: 3001,
      path,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
      },
    };
    const req = http.request(opts, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost",
    password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token)
    throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

async function scratchShipment(token, carrierCode) {
  const res = await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode,
    status: "Active", contractType: "SPOT", etd: "2026-09-01",
  }, token);
  return res.body.id;
}

// ─── Confirmed path: Send → simulate confirmed → Confirm ─────────────────────

async function testConfirmedPath(token) {
  console.log("\nCarrier Booking — confirmed path (Send → simulate confirmed → Confirm)");
  const shipmentId = await scratchShipment(token, "MAEU");
  if (!shipmentId) { assert("scratch shipment created", false, "aborting"); return; }
  assert("scratch shipment created", true);
  await request("POST", `/api/shipments/${shipmentId}/milestones/init`, {}, token);

  const initial = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("GET carrier-booking returns 200 before any request", initial.status === 200);
  assert("carrier-booking is null before any request", initial.body === null);

  const send1 = await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  assert("booking-request returns 201", send1.status === 201);
  assert("booking-request response is pending (no fabricated response)", send1.body.pending === true);

  const afterSend = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("status is Pending after send", afterSend.body?.status === "Pending");

  const send2 = await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  assert("second booking-request while pending returns 409", send2.status === 409);

  const sim = await request("POST", `/api/shipments/${shipmentId}/edi-messages/simulate-response`,
    { outcome: "confirmed" }, token);
  assert("simulate-response(confirmed) returns 201", sim.status === 201);
  assert("simulated response is flagged isMock", sim.body?.received?.isMock === true);

  const afterSim = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("status is STILL Pending after a confirmed response (not auto-finalized)",
    afterSim.body?.status === "Pending", `got ${afterSim.body?.status}`);
  assert("lastResponseStatus is confirmed", afterSim.body?.lastResponseStatus === "confirmed");

  const confirm1 = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/confirm`, {}, token);
  assert("PATCH confirm returns 200", confirm1.status === 200);
  assert("status is Confirmed after manual confirm", confirm1.body?.status === "Confirmed");
  assert("bookingRef was carried over from the simulated response", !!confirm1.body?.bookingRef);

  const shipAfterConfirm = await request("GET", `/api/shipments/${shipmentId}`, null, token);
  assert("shipments.bookingRef set after confirm", !!shipAfterConfirm.body?.bookingRef);

  const milestones = await request("GET", `/api/shipments/${shipmentId}/milestones`, null, token);
  const bookingMilestone = (milestones.body || []).find(m => m.milestoneKey === "booking_confirmed");
  assert("booking_confirmed milestone completed", !!bookingMilestone?.completedAt);

  const confirm2 = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/confirm`, {}, token);
  assert("confirming an already-confirmed booking returns 409", confirm2.status === 409);
}

// ─── Rejected path: Send → simulate rejected (auto) → Cancel ──────────────────

async function testRejectedPath(token) {
  console.log("\nCarrier Booking — rejected path (Send → simulate rejected → Cancel)");
  const shipmentId = await scratchShipment(token, "SAFM");
  if (!shipmentId) { assert("scratch shipment created", false, "aborting"); return; }
  assert("scratch shipment created", true);

  await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  const sim = await request("POST", `/api/shipments/${shipmentId}/edi-messages/simulate-response`,
    { outcome: "rejected", reason: "No space available" }, token);
  assert("simulate-response(rejected) returns 201", sim.status === 201);

  const afterSim = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("status auto-advances to Rejected (no gate needed)", afterSim.body?.status === "Rejected",
    `got ${afterSim.body?.status}`);

  const cancel = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/cancel`,
    { reason: "Trying a different carrier" }, token);
  assert("PATCH cancel returns 200", cancel.status === 200);
  assert("status is Cancelled", cancel.body?.status === "Cancelled");

  const messages = await request("GET", `/api/shipments/${shipmentId}/edi-messages`, null, token);
  const cancelMsg = (messages.body || []).find(m => m.messageType === "booking_cancellation");
  assert("a booking_cancellation message was sent to the carrier", !!cancelMsg);

  const cancel2 = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/cancel`, {}, token);
  assert("cancelling an already-cancelled booking returns 409", cancel2.status === 409);
}

// ─── Manual path: non-bookable carrier, no EDI involved at all ────────────────

async function testManualPath(token) {
  console.log("\nCarrier Booking — manual path (non-bookable carrier, no EDI)");
  const shipmentId = await scratchShipment(token, "ZZZZ");
  if (!shipmentId) { assert("scratch shipment created", false, "aborting"); return; }
  assert("scratch shipment created", true);

  const send = await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  assert("booking-request for a non-bookable carrier returns 400", send.status === 400);

  const confirm = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/confirm`,
    { bookingRef: "MANUAL123" }, token);
  assert("manual confirm with no prior request returns 200", confirm.status === 200);
  assert("status is Confirmed via the manual path", confirm.body?.status === "Confirmed");
  assert("bookingRef is the manually-entered value", confirm.body?.bookingRef === "MANUAL123");
}

// ─── Cross-shipment list ───────────────────────────────────────────────────────

async function testBookingsList(token) {
  console.log("\nGET /api/carrier-bookings");
  const res = await request("GET", "/api/carrier-bookings?status=Pending", null, token);
  assert("list returns 200", res.status === 200);
  assert("list returns an array", Array.isArray(res.body));
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    await testConfirmedPath(token);
    await testRejectedPath(token);
    await testManualPath(token);
    await testBookingsList(token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
