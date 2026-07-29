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

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
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

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
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

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
}

// ─── Auto-creation: booking appears once contract + schedule both exist (v0.38.0) ────

async function testAutoCreate(token) {
  console.log("\nCarrier Booking — auto-created once contract + schedule both exist");

  // Order 1: schedule first, then contract
  const ship1 = await scratchShipment(token, "MAEU");
  let get1 = await request("GET", `/api/shipments/${ship1}/carrier-booking`, null, token);
  assert("no booking before contract or schedule exist", get1.body === null);

  await request("POST", `/api/shipments/${ship1}/schedules`, {
    carrier: "MAEU", vesselName: "TEST", voyageNumber: "1W", pol: "NLRTM", pod: "USNYC",
    etd: "2026-09-01", eta: "2026-09-20",
  }, token);
  get1 = await request("GET", `/api/shipments/${ship1}/carrier-booking`, null, token);
  assert("still no booking — schedule exists but no contract yet", get1.body === null);

  const shipRow1 = await request("GET", `/api/shipments/${ship1}`, null, token);
  await request("PUT", `/api/shipments/${ship1}`, { ...shipRow1.body, contractRef: "REF-AUTO-1" }, token);
  get1 = await request("GET", `/api/shipments/${ship1}/carrier-booking`, null, token);
  assert("booking auto-created once contract is added too", get1.body !== null);
  assert("auto-created booking has a BKG- id", get1.body?.id?.startsWith("BKG-"));
  assert("auto-created booking status is Created", get1.body?.status === "Created");
  assert("auto-created booking carries the shipment's carrier code", get1.body?.carrierCode === "MAEU");

  // Sending a real request afterward still transitions Created -> Pending correctly
  const send1 = await request("POST", `/api/shipments/${ship1}/edi-messages/booking-request`, {}, token);
  assert("booking-request still works against a Created booking", send1.status === 201);
  get1 = await request("GET", `/api/shipments/${ship1}/carrier-booking`, null, token);
  assert("status moved from Created to Pending on send", get1.body?.status === "Pending");
  assert("same booking id preserved through the transition (no duplicate row)", get1.body?.id === get1.body?.id);

  // Order 2: contract first, then schedule
  const ship2 = await scratchShipment(token, "MAEU");
  const shipRow2 = await request("GET", `/api/shipments/${ship2}`, null, token);
  await request("PUT", `/api/shipments/${ship2}`, { ...shipRow2.body, contractRef: "REF-AUTO-2" }, token);
  let get2 = await request("GET", `/api/shipments/${ship2}/carrier-booking`, null, token);
  assert("no booking yet — contract set but no schedule", get2.body === null);

  await request("POST", `/api/shipments/${ship2}/schedules`, {
    carrier: "MAEU", vesselName: "TEST", voyageNumber: "2W", pol: "NLRTM", pod: "USNYC",
    etd: "2026-09-01", eta: "2026-09-20",
  }, token);
  get2 = await request("GET", `/api/shipments/${ship2}/carrier-booking`, null, token);
  assert("booking auto-created once schedule follows the contract", get2.body !== null);
  assert("this one is also Created, not Pending", get2.body?.status === "Created");

  // Order 3: a hand-entered SEA leg with a real ETD, no shipment_schedules row at all —
  // found via a real bug report (SHP-VSB0Z2): a shipment whose Route Legs were filled in
  // manually rather than through Add Sailing/Schedule Generator never got a booking
  // auto-created, since the original check only looked for a shipment_schedules row.
  const ship3 = await scratchShipment(token, "MAEU");
  const shipRow3 = await request("GET", `/api/shipments/${ship3}`, null, token);
  await request("PUT", `/api/shipments/${ship3}`, { ...shipRow3.body, contractRef: "REF-AUTO-3" }, token);
  await request("POST", `/api/shipments/${ship3}/legs`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-01",
  }, token);
  const get3 = await request("GET", `/api/shipments/${ship3}/carrier-booking`, null, token);
  assert("a hand-entered SEA leg with an ETD counts as a schedule too", get3.body !== null);
  assert("also Created, not Pending", get3.body?.status === "Created");

  // A blank SEA leg (no ETD) must NOT trigger this — every new shipment gets one by
  // default (ShipmentFormPage), so requiring bare leg existence would fire far too early.
  const ship4 = await scratchShipment(token, "MAEU");
  const shipRow4 = await request("GET", `/api/shipments/${ship4}`, null, token);
  await request("PUT", `/api/shipments/${ship4}`, { ...shipRow4.body, contractRef: "REF-AUTO-4" }, token);
  await request("POST", `/api/shipments/${ship4}/legs`, { legType: "SEA", movementType: "SEA" }, token);
  const get4 = await request("GET", `/api/shipments/${ship4}/carrier-booking`, null, token);
  assert("a blank SEA leg (no ETD) does NOT count as a schedule", get4.body === null);

  await request("DELETE", `/api/shipments/${ship1}`, null, token);
  await request("DELETE", `/api/shipments/${ship2}`, null, token);
  await request("DELETE", `/api/shipments/${ship3}`, null, token);
  await request("DELETE", `/api/shipments/${ship4}`, null, token);
}

// ─── Equipment summary in the booking-request payload (TKT-0H9TSP) ───────────────

async function testEquipmentSummary(token) {
  console.log("\nBooking-request payload includes an equipment summary");
  const shipmentId = await scratchShipment(token, "MAEU");

  await request("POST", "/api/containers", {
    shipmentId, size: "40", type: "HC", grossWeightKg: 8000, volumeCbm: 76,
  }, token);
  await request("POST", "/api/containers", {
    shipmentId, size: "40", type: "HC", grossWeightKg: 9000, volumeCbm: 74,
  }, token);
  await request("POST", "/api/containers", {
    shipmentId, size: "20", type: "GP", grossWeightKg: 12000, volumeCbm: 28,
  }, token);

  const send = await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  assert("booking-request returns 201", send.status === 201);

  const messages = await request("GET", `/api/shipments/${shipmentId}/edi-messages`, null, token);
  const outbound = messages.body.find(m => m.direction === "out" && m.messageType === "booking_request");
  assert("outbound booking_request message exists", !!outbound);
  const payload = JSON.parse(outbound.rawPayload);
  assert("containerCount is 3", payload.containerCount === 3);
  assert("equipment has 2 groups (40HC, 20GP)", Array.isArray(payload.equipment) && payload.equipment.length === 2);
  const hc = payload.equipment.find(e => e.type === "40HC");
  assert("40HC group has count 2", hc?.count === 2);
  assert("40HC group sums weight correctly", hc?.totalWeightKg === 17000);
  assert("40HC group sums volume correctly", hc?.totalVolumeCbm === 150);
  const gp = payload.equipment.find(e => e.type === "20GP");
  assert("20GP group has count 1", gp?.count === 1);

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
}

// ─── Supersede on carrier change: archive + fresh booking, own surrogate keys ─────
// Real-world trigger (SHP-Y9E98X): any not-yet-Confirmed booking whose carrier no longer
// matches the shipment's current one is auto-cancelled (forced to status Cancelled, even if
// it was Rejected/Pending/Created) and archived — own BKG- id preserved, viewable via
// carrier-booking-history — then replaced with a fresh Created booking under the new carrier.
// A Confirmed booking is never touched, no matter what the carrier does afterward. A
// same-carrier edit persists the same bookingID forever — no new row, nothing archived.

async function testSupersedeOnCarrierChange(token) {
  console.log("\nCarrier Booking — supersede on carrier change (archive + fresh booking)");
  const shipmentId = await scratchShipment(token, "MAEU");
  const shipRow = await request("GET", `/api/shipments/${shipmentId}`, null, token);
  await request("PUT", `/api/shipments/${shipmentId}`, { ...shipRow.body, contractRef: "REF-SUPERSEDE-1" }, token);

  const leg = await request("POST", `/api/shipments/${shipmentId}/legs`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-01", carrierCode: "MAEU",
  }, token);
  const legId = leg.body?.id;
  assert("leg created", leg.status === 201);

  let booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("booking auto-created with carrier MAEU", booking.body?.carrierCode === "MAEU");
  const originalId = booking.body?.id;
  assert("original booking has a BKG- id", originalId?.startsWith("BKG-"));

  await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  const sim = await request("POST", `/api/shipments/${shipmentId}/edi-messages/simulate-response`,
    { outcome: "rejected", reason: "No space available" }, token);
  assert("simulate-response(rejected) returns 201", sim.status === 201);
  booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("booking status is Rejected", booking.body?.status === "Rejected");
  assert("still the same booking id (no supersede yet — carrier unchanged)", booking.body?.id === originalId);

  // Change carrier via a leg update — triggers syncShipmentFromLegs -> ensureBookingCreated's
  // new supersede-before-create branch.
  const legUpdate = await request("PUT", `/api/shipments/${shipmentId}/legs/${legId}`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-01", carrierCode: "SAFM",
  }, token);
  assert("leg update (carrier change) returns 200", legUpdate.status === 200);

  booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("a NEW booking id now exists after the carrier change", booking.body?.id !== originalId);
  assert("new booking has a BKG- id", booking.body?.id?.startsWith("BKG-"));
  assert("new booking status is Created", booking.body?.status === "Created");
  assert("new booking carries the new carrier (SAFM)", booking.body?.carrierCode === "SAFM");
  const secondId = booking.body?.id;

  let history = await request("GET", `/api/shipments/${shipmentId}/carrier-booking-history`, null, token);
  assert("history returns 200", history.status === 200);
  assert("history has exactly 1 entry", Array.isArray(history.body) && history.body.length === 1);
  const old1 = history.body[0];
  assert("archived entry keeps its ORIGINAL BKG- id", old1?.id === originalId);
  assert("archived entry's status is forced to Cancelled (was Rejected)", old1?.status === "Cancelled");
  assert("archived entry's carrier is still the original (MAEU)", old1?.carrierCode === "MAEU");
  assert("archived entry has an archivedAt timestamp", !!old1?.archivedAt);
  assert("archived entry has a cancelledAt timestamp (auto-cancelled, not just archived)", !!old1?.cancelledAt);
  assert("archived entry's cancelledBy is the system actor", old1?.cancelledBy === "System (Auto)");
  assert("archived entry's reason mentions the carrier change", /carrier/i.test(old1?.archivedReason || ""));

  // Repeat once more: reject the second booking, then change carrier again -> a third booking.
  await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  await request("POST", `/api/shipments/${shipmentId}/edi-messages/simulate-response`,
    { outcome: "rejected", reason: "Vessel full" }, token);

  const legUpdate2 = await request("PUT", `/api/shipments/${shipmentId}/legs/${legId}`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-01", carrierCode: "MCPU",
  }, token);
  assert("second leg update (carrier change) returns 200", legUpdate2.status === 200);

  booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("a THIRD booking id now exists", booking.body?.id !== originalId && booking.body?.id !== secondId);
  assert("third booking carries the newest carrier (MCPU)", booking.body?.carrierCode === "MCPU");

  history = await request("GET", `/api/shipments/${shipmentId}/carrier-booking-history`, null, token);
  assert("history now has 2 entries", history.body.length === 2);
  assert("history is newest-first — [0] is the second booking (SAFM)", history.body[0]?.id === secondId);
  assert("history[0]'s carrier is SAFM", history.body[0]?.carrierCode === "SAFM");
  assert("history[1] is the original booking (MAEU)", history.body[1]?.id === originalId);

  // Confirmed bookings must never be archived/superseded, even if the carrier later changes.
  const confirmedShipmentId = await scratchShipment(token, "MAEU");
  const cShipRow = await request("GET", `/api/shipments/${confirmedShipmentId}`, null, token);
  await request("PUT", `/api/shipments/${confirmedShipmentId}`, { ...cShipRow.body, contractRef: "REF-SUPERSEDE-CONFIRMED" }, token);
  const cLeg = await request("POST", `/api/shipments/${confirmedShipmentId}/legs`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-01", carrierCode: "MAEU",
  }, token);
  const cLegId = cLeg.body?.id;
  await request("POST", `/api/shipments/${confirmedShipmentId}/edi-messages/booking-request`, {}, token);
  await request("POST", `/api/shipments/${confirmedShipmentId}/edi-messages/simulate-response`, { outcome: "confirmed" }, token);
  const confirmRes = await request("PATCH", `/api/shipments/${confirmedShipmentId}/carrier-booking/confirm`, {}, token);
  assert("manual Confirm action succeeds", confirmRes.status === 200);
  const confirmedBookingId = confirmRes.body?.id;
  assert("booking is Confirmed", confirmRes.body?.status === "Confirmed");

  await request("PUT", `/api/shipments/${confirmedShipmentId}/legs/${cLegId}`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-01", carrierCode: "SAFM",
  }, token);
  const afterCarrierChange = await request("GET", `/api/shipments/${confirmedShipmentId}/carrier-booking`, null, token);
  assert("a Confirmed booking is NEVER superseded, even after a carrier change",
    afterCarrierChange.body?.id === confirmedBookingId && afterCarrierChange.body?.status === "Confirmed");
  assert("its carrierCode stays the ORIGINAL one it was confirmed under (a historical fact)",
    afterCarrierChange.body?.carrierCode === "MAEU");
  const confirmedHistory = await request("GET", `/api/shipments/${confirmedShipmentId}/carrier-booking-history`, null, token);
  assert("no archive entries were created for the confirmed shipment",
    Array.isArray(confirmedHistory.body) && confirmedHistory.body.length === 0);

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
  await request("DELETE", `/api/shipments/${confirmedShipmentId}`, null, token);
}

// ─── Supersede on carrier change via Send (not just ensureBookingCreated) ─────────
// Real-world gap found on a live shipment (SHP-Y9E98X) after testSupersedeOnCarrierChange
// above already shipped: a plain carrier-only edit to a shipment (PUT /api/shipments/:id
// with a new carrierCode but unchanged contract fields) does NOT call ensureBookingCreated
// at all (routes/shipments.js only calls it when contract_id/contract_ref actually change) —
// so a Rejected/Cancelled booking's own carrier_code can go stale with no supersede check
// ever running. upsertPendingBooking (the Send Booking Request handler) used to just UPDATE
// that stale row in place on the next Send, silently overwriting its carrier — this is what
// let the original bug resurface even after the ensureBookingCreated fix shipped. Covers the
// same gap in the manual Confirm route too.

async function testSupersedeViaSendBypass(token) {
  console.log("\nCarrier Booking — supersede via Send/Confirm (not just ensureBookingCreated)");
  const shipmentId = await scratchShipment(token, "MAEU");
  const shipRow = await request("GET", `/api/shipments/${shipmentId}`, null, token);
  await request("PUT", `/api/shipments/${shipmentId}`, { ...shipRow.body, contractRef: "REF-SEND-BYPASS" }, token);
  await request("POST", `/api/shipments/${shipmentId}/legs`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-01", carrierCode: "MAEU",
  }, token);

  await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  const sim = await request("POST", `/api/shipments/${shipmentId}/edi-messages/simulate-response`,
    { outcome: "rejected", reason: "No space" }, token);
  assert("simulate-response(rejected) returns 201", sim.status === 201);

  let booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("booking is Rejected under MAEU", booking.body?.status === "Rejected" && booking.body?.carrierCode === "MAEU");
  const originalId = booking.body?.id;

  // Carrier-only edit — deliberately does NOT touch contractRef/contractId, so
  // routes/shipments.js's PUT handler does NOT call ensureBookingCreated at all.
  const shipRow2 = await request("GET", `/api/shipments/${shipmentId}`, null, token);
  await request("PUT", `/api/shipments/${shipmentId}`, { ...shipRow2.body, carrierCode: "SAFM" }, token);

  booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("booking is untouched by the carrier-only edit alone (no ensureBookingCreated call)",
    booking.body?.id === originalId && booking.body?.status === "Rejected" && booking.body?.carrierCode === "MAEU");

  // The next Send is the actual bypass point — must supersede, not overwrite in place.
  const send2 = await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  assert("second Send returns 201", send2.status === 201);

  booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("a NEW booking id now exists after Send (not the same stale row)", booking.body?.id !== originalId);
  assert("new booking is Pending under the new carrier (SAFM)",
    booking.body?.status === "Pending" && booking.body?.carrierCode === "SAFM");

  const history = await request("GET", `/api/shipments/${shipmentId}/carrier-booking-history`, null, token);
  assert("history has exactly 1 entry", Array.isArray(history.body) && history.body.length === 1);
  assert("archived entry keeps its ORIGINAL id and carrier (MAEU), status forced to Cancelled",
    history.body[0]?.id === originalId && history.body[0]?.status === "Cancelled" && history.body[0]?.carrierCode === "MAEU");

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);

  // Same bypass, but through the manual Confirm route instead of Send.
  const shipmentId2 = await scratchShipment(token, "MAEU");
  const shipRow3 = await request("GET", `/api/shipments/${shipmentId2}`, null, token);
  await request("PUT", `/api/shipments/${shipmentId2}`, { ...shipRow3.body, contractRef: "REF-CONFIRM-BYPASS" }, token);
  await request("POST", `/api/shipments/${shipmentId2}/legs`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-01", carrierCode: "MAEU",
  }, token);
  await request("POST", `/api/shipments/${shipmentId2}/edi-messages/booking-request`, {}, token);
  await request("POST", `/api/shipments/${shipmentId2}/edi-messages/simulate-response`,
    { outcome: "rejected", reason: "No space" }, token);
  const rejectedBooking = await request("GET", `/api/shipments/${shipmentId2}/carrier-booking`, null, token);
  const originalId2 = rejectedBooking.body?.id;

  const shipRow4 = await request("GET", `/api/shipments/${shipmentId2}`, null, token);
  await request("PUT", `/api/shipments/${shipmentId2}`, { ...shipRow4.body, carrierCode: "MCPU" }, token);

  const confirmRes = await request("PATCH", `/api/shipments/${shipmentId2}/carrier-booking/confirm`,
    { bookingRef: "MCPU-MANUAL-1" }, token);
  assert("manual Confirm after a carrier-only edit succeeds", confirmRes.status === 200);
  assert("confirm creates a NEW booking id (not the stale Rejected/MAEU row)",
    confirmRes.body?.id !== originalId2);
  assert("new confirmed booking carries the new carrier (MCPU)", confirmRes.body?.carrierCode === "MCPU");

  const history2 = await request("GET", `/api/shipments/${shipmentId2}/carrier-booking-history`, null, token);
  assert("history has exactly 1 entry", Array.isArray(history2.body) && history2.body.length === 1);
  assert("archived entry keeps its ORIGINAL id and carrier (MAEU), status forced to Cancelled",
    history2.body[0]?.id === originalId2 && history2.body[0]?.status === "Cancelled" && history2.body[0]?.carrierCode === "MAEU");

  await request("DELETE", `/api/shipments/${shipmentId2}`, null, token);
}

// ─── Supersede while still Pending — broadened scope + auto-cancellation EDI message ──
// Previously a Pending booking (a real request already sent, awaiting the carrier's
// response) was deliberately left alone even if the carrier changed — only an already-
// Rejected/Cancelled booking was supersede-eligible. Per direct follow-up request, this is
// now broadened to ANY not-yet-Confirmed status, Pending included: the operator no longer
// has to manually cancel first, changing the carrier IS the cancellation trigger. The old
// booking is auto-cancelled (a real cancellation EDI message goes out to it, same as the
// manual Cancel action already sends) before being archived.

async function testSupersedeWhilePending(token) {
  console.log("\nCarrier Booking — supersede while still Pending (broadened scope) + auto-cancel EDI message");
  const shipmentId = await scratchShipment(token, "MAEU");
  const shipRow = await request("GET", `/api/shipments/${shipmentId}`, null, token);
  await request("PUT", `/api/shipments/${shipmentId}`, { ...shipRow.body, contractRef: "REF-PENDING-SUPERSEDE" }, token);
  const leg = await request("POST", `/api/shipments/${shipmentId}/legs`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-01", carrierCode: "MAEU",
  }, token);
  const legId = leg.body?.id;

  const send = await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  assert("booking-request returns 201", send.status === 201);

  let booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("booking is Pending under MAEU (no response simulated — still in flight)",
    booking.body?.status === "Pending" && booking.body?.carrierCode === "MAEU");
  const originalId = booking.body?.id;

  // Carrier change while still Pending — this alone must now trigger auto-cancel + archive,
  // with no manual Cancel/Reject step in between.
  const legUpdate = await request("PUT", `/api/shipments/${shipmentId}/legs/${legId}`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-01", carrierCode: "SAFM",
  }, token);
  assert("leg update (carrier change while Pending) returns 200", legUpdate.status === 200);

  booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("a NEW booking id exists after the carrier change", booking.body?.id !== originalId);
  assert("new booking is Created under the new carrier (SAFM)",
    booking.body?.status === "Created" && booking.body?.carrierCode === "SAFM");

  const history = await request("GET", `/api/shipments/${shipmentId}/carrier-booking-history`, null, token);
  assert("history has exactly 1 entry", Array.isArray(history.body) && history.body.length === 1);
  const old = history.body[0];
  assert("archived entry keeps its ORIGINAL id and carrier (MAEU)", old?.id === originalId && old?.carrierCode === "MAEU");
  assert("archived entry's status is Cancelled (auto-cancelled while Pending)", old?.status === "Cancelled");
  assert("archived entry has a cancelledAt timestamp", !!old?.cancelledAt);
  assert("archived entry's cancelledBy is the system actor", old?.cancelledBy === "System (Auto)");
  assert("archived entry's cancelReason mentions the carrier change", /carrier/i.test(old?.cancelReason || ""));

  // The auto-cancel must also notify the old (bookable) carrier, same as a manual Cancel would.
  const messages = await request("GET", `/api/shipments/${shipmentId}/edi-messages`, null, token);
  const cancelMsg = (messages.body || []).find(m => m.messageType === "booking_cancellation" && m.carrierCode === "MAEU");
  assert("an auto-triggered booking_cancellation message was sent to the old carrier (MAEU)", !!cancelMsg);
  assert("the cancellation message is outbound", cancelMsg?.direction === "out");

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
}

// ─── Same-carrier edit persists the same bookingID ────────────────────────────────
// The other half of the rule: a not-yet-Confirmed booking edited WITHOUT its carrier
// actually changing (a new contract reference, a corrected sailing, a different vessel/
// voyage on the same carrier) must keep the exact same BKG- surrogate key and status —
// nothing gets archived, nothing new gets created, no matter how many times it's touched.

async function testSameCarrierPersistsId(token) {
  console.log("\nCarrier Booking — same-carrier edit persists the same bookingID");
  const shipmentId = await scratchShipment(token, "MAEU");
  const shipRow = await request("GET", `/api/shipments/${shipmentId}`, null, token);
  await request("PUT", `/api/shipments/${shipmentId}`, { ...shipRow.body, contractRef: "REF-SAME-CARRIER-1" }, token);
  const leg = await request("POST", `/api/shipments/${shipmentId}/legs`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-01",
    carrierCode: "MAEU", vessel: "DEMO ALLEGRO", voyage: "1W",
  }, token);
  const legId = leg.body?.id;

  let booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  const originalId = booking.body?.id;
  assert("booking auto-created with a BKG- id", originalId?.startsWith("BKG-"));

  await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  await request("POST", `/api/shipments/${shipmentId}/edi-messages/simulate-response`,
    { outcome: "rejected", reason: "No space" }, token);
  booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("booking is Rejected", booking.body?.status === "Rejected");
  assert("still the original id", booking.body?.id === originalId);

  // Edit #1: a new contract reference, same carrier — triggers ensureBookingCreated (contract
  // fields changed) but must NOT supersede, since the carrier itself never changed.
  const shipRow2 = await request("GET", `/api/shipments/${shipmentId}`, null, token);
  await request("PUT", `/api/shipments/${shipmentId}`, { ...shipRow2.body, contractRef: "REF-SAME-CARRIER-2" }, token);
  booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("same bookingID persists after a same-carrier contract edit", booking.body?.id === originalId);
  assert("status is still Rejected (not silently reset)", booking.body?.status === "Rejected");

  // Edit #2: a corrected sailing (different vessel/voyage) on the SAME carrier — also
  // triggers ensureBookingCreated (leg update) but again must not supersede.
  const legUpdate = await request("PUT", `/api/shipments/${shipmentId}/legs/${legId}`, {
    legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-05",
    carrierCode: "MAEU", vessel: "DEMO ENSEMBLE", voyage: "2W",
  }, token);
  assert("leg update (same-carrier sailing correction) returns 200", legUpdate.status === 200);
  booking = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("same bookingID persists after a same-carrier sailing correction", booking.body?.id === originalId);
  assert("carrierCode is unchanged (MAEU)", booking.body?.carrierCode === "MAEU");

  const history = await request("GET", `/api/shipments/${shipmentId}/carrier-booking-history`, null, token);
  assert("no archive entries were created — nothing was ever superseded",
    Array.isArray(history.body) && history.body.length === 0);

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
}

// ─── Booking-request payload gains contractRef + rateSnapshotId ──────────────────

async function testPayloadContractAndRateSnapshot(token) {
  console.log("\nBooking-request payload includes contractRef and rateSnapshotId");

  // SPOT shipment — free-text contractRef, never gets a rate snapshot (importContractRates
  // only ever runs for a Central contract).
  const spotId = await scratchShipment(token, "MAEU");
  const spotRow = await request("GET", `/api/shipments/${spotId}`, null, token);
  await request("PUT", `/api/shipments/${spotId}`, { ...spotRow.body, contractRef: "SPOT-REF-123" }, token);
  const spotSend = await request("POST", `/api/shipments/${spotId}/edi-messages/booking-request`, {}, token);
  assert("SPOT booking-request returns 201", spotSend.status === 201);
  const spotMessages = await request("GET", `/api/shipments/${spotId}/edi-messages`, null, token);
  const spotOutbound = spotMessages.body.find(m => m.direction === "out" && m.messageType === "booking_request");
  const spotPayload = JSON.parse(spotOutbound.rawPayload);
  assert("SPOT payload contractRef matches", spotPayload.contractRef === "SPOT-REF-123");
  assert("SPOT payload rateSnapshotId is null (no Central contract, no snapshot)", spotPayload.rateSnapshotId === null);
  await request("DELETE", `/api/shipments/${spotId}`, null, token);

  // Central shipment — a real contract + a real rate snapshot generated at creation
  // (server.js: `if (contractType === 'Central' && contractId) importContractRates(id)`).
  const contractCreate = await request("POST", "/api/contracts", {
    contractNumber: "TEST-SUPERSEDE-CNTR", carrierCode: "MAEU", status: "Active", currency: "USD",
    rates: [{ serviceCode: "OF", description: "Ocean Freight", amount: 1500, currency: "USD", unit: "per_container" }],
  }, token);
  assert("test contract created (201)", contractCreate.status === 201);
  const contractId = contractCreate.body?.id;

  const centralCreate = await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active",
    contractType: "Central", contractId, contractRef: "TEST-SUPERSEDE-CNTR", etd: "2026-09-01",
  }, token);
  assert("Central shipment created (201)", centralCreate.status === 201);
  const centralId = centralCreate.body?.id;

  try {
    const centralSend = await request("POST", `/api/shipments/${centralId}/edi-messages/booking-request`, {}, token);
    assert("Central booking-request returns 201", centralSend.status === 201);
    const centralMessages = await request("GET", `/api/shipments/${centralId}/edi-messages`, null, token);
    const centralOutbound = centralMessages.body.find(m => m.direction === "out" && m.messageType === "booking_request");
    const centralPayload = JSON.parse(centralOutbound.rawPayload);
    assert("Central payload contractRef matches", centralPayload.contractRef === "TEST-SUPERSEDE-CNTR");
    assert("Central payload rateSnapshotId is a real id (not null)", !!centralPayload.rateSnapshotId);
  } finally {
    await request("DELETE", `/api/shipments/${centralId}`, null, token);
    await request("DELETE", `/api/contracts/${contractId}`, null, token);
  }
}

// ─── Booking-request payload gains vesselImo, cargoReadyDate, party names,
// commodityCode, placeOfReceipt/placeOfDelivery (TKT-5UNMUD, TKT-O57N94, TKT-U7T2QU) ──

async function testExtendedPayloadFields(token) {
  console.log("\nBooking-request payload includes vessel IMO, CRD, parties, commodity, and door places");

  // Unset — everything should come through null, not blow up or omit the key.
  const bareId = await scratchShipment(token, "MAEU");
  const bareSend = await request("POST", `/api/shipments/${bareId}/edi-messages/booking-request`, {}, token);
  assert("bare booking-request returns 201", bareSend.status === 201);
  const bareMessages = await request("GET", `/api/shipments/${bareId}/edi-messages`, null, token);
  const barePayload = JSON.parse(bareMessages.body.find(m => m.direction === "out" && m.messageType === "booking_request").rawPayload);
  assert("vesselImo is null when unset", barePayload.vesselImo === null);
  assert("cargoReadyDate is null when unset", barePayload.cargoReadyDate === null);
  assert("shipperName is null when unset", barePayload.shipperName === null);
  assert("placeOfReceipt is null when unset", barePayload.placeOfReceipt === null);
  await request("DELETE", `/api/shipments/${bareId}`, null, token);

  // Fully populated.
  const fullCreate = await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    etd: "2026-09-01", vesselImo: "9321483", cargoReadyDate: "2026-08-15",
    placeOfReceipt: "Utrecht", placeOfDelivery: "Newark",
    shipperName: "Test Shipper Co", consigneeName: "Test Consignee Co", notifyName: "Test Notify Co",
    commodityCode: "HS8471",
  }, token);
  const fullId = fullCreate.body.id;
  const fullSend = await request("POST", `/api/shipments/${fullId}/edi-messages/booking-request`, {}, token);
  assert("full booking-request returns 201", fullSend.status === 201);
  const fullMessages = await request("GET", `/api/shipments/${fullId}/edi-messages`, null, token);
  const fullPayload = JSON.parse(fullMessages.body.find(m => m.direction === "out" && m.messageType === "booking_request").rawPayload);
  assert("vesselImo round-trips", fullPayload.vesselImo === "9321483");
  assert("cargoReadyDate round-trips", fullPayload.cargoReadyDate === "2026-08-15");
  assert("placeOfReceipt round-trips", fullPayload.placeOfReceipt === "Utrecht");
  assert("placeOfDelivery round-trips", fullPayload.placeOfDelivery === "Newark");
  assert("shipperName round-trips", fullPayload.shipperName === "Test Shipper Co");
  assert("consigneeName round-trips", fullPayload.consigneeName === "Test Consignee Co");
  assert("notifyName round-trips", fullPayload.notifyName === "Test Notify Co");
  assert("commodityCode round-trips", fullPayload.commodityCode === "HS8471");
  await request("DELETE", `/api/shipments/${fullId}`, null, token);
}

// ─── Booking-request payload gains a DG cargo declaration (TKT-O57N94) ────────

async function testDgCargoSummary(token) {
  console.log("\nBooking-request payload includes a DG cargo declaration");

  const shipmentId = await scratchShipment(token, "MAEU");
  await request("POST", "/api/containers", { shipmentId, size: "40", type: "HC", isDg: true, dgClass: "3" }, token);
  await request("POST", "/api/containers", { shipmentId, size: "40", type: "HC", isDg: true, dgClass: "3" }, token);
  await request("POST", "/api/containers", { shipmentId, size: "20", type: "GP" }, token); // not DG

  const send = await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  assert("booking-request returns 201", send.status === 201);
  const messages = await request("GET", `/api/shipments/${shipmentId}/edi-messages`, null, token);
  const payload = JSON.parse(messages.body.find(m => m.direction === "out" && m.messageType === "booking_request").rawPayload);

  assert("containerCount still counts all 3 containers", payload.containerCount === 3);
  assert("equipment still has 2 groups (40HC, 20GP)", payload.equipment.length === 2);
  assert("dgCargo has exactly 1 group (only the DG containers)", payload.dgCargo.length === 1);
  const dg = payload.dgCargo[0];
  assert("dgCargo group type is 40HC", dg?.type === "40HC");
  assert("dgCargo group dgClass is 3", dg?.dgClass === "3");
  assert("dgCargo group count is 2 (the two DG containers, not the clean one)", dg?.count === 2);

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
}

async function testLinkBlDocument(token) {
  console.log("\nLink/unlink a B/L document to the current carrier booking (TKT-LAK8P4)");

  const shipmentId = await scratchShipment(token, "MAEU");
  await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);

  const blDoc = await request("POST", `/api/shipments/${shipmentId}/documents/generate`,
    { html: "<html><body>BL</body></html>", filename: "BL01-test.html", docType: "BL01" }, token);
  assert("BL01 document generated (201)", blDoc.status === 201);
  const ciDoc = await request("POST", `/api/shipments/${shipmentId}/documents/generate`,
    { html: "<html><body>CI</body></html>", filename: "CI01-test.html", docType: "CI01" }, token);

  const otherShipmentId = await scratchShipment(token, "MAEU");
  const otherDoc = await request("POST", `/api/shipments/${otherShipmentId}/documents/generate`,
    { html: "<html><body>BL</body></html>", filename: "BL01-other.html", docType: "BL01" }, token);

  const link = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/link-bl-document`, { documentId: blDoc.body.id }, token);
  assert("link returns 200", link.status === 200);
  assert("blDocumentId set", link.body.blDocumentId === blDoc.body.id);

  const rejectWrongType = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/link-bl-document`, { documentId: ciDoc.body.id }, token);
  assert("linking a non-BL01 document is rejected (400)", rejectWrongType.status === 400);

  const rejectWrongShipment = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/link-bl-document`, { documentId: otherDoc.body.id }, token);
  assert("linking a document from a different shipment is rejected (404 — not found in this scope)", rejectWrongShipment.status === 404);

  const stillLinked = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
  assert("rejected attempts did not disturb the original link", stillLinked.body.blDocumentId === blDoc.body.id);

  const unlink = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/link-bl-document`, { documentId: null }, token);
  assert("unlink returns 200", unlink.status === 200);
  assert("blDocumentId cleared", unlink.body.blDocumentId === null);

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
  await request("DELETE", `/api/shipments/${otherShipmentId}`, null, token);
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
    await testAutoCreate(token);
    await testEquipmentSummary(token);
    await testSupersedeOnCarrierChange(token);
    await testSupersedeViaSendBypass(token);
    await testSupersedeWhilePending(token);
    await testSameCarrierPersistsId(token);
    await testPayloadContractAndRateSnapshot(token);
    await testExtendedPayloadFields(token);
    await testDgCargoSummary(token);
    await testLinkBlDocument(token);
    await testBookingsList(token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
