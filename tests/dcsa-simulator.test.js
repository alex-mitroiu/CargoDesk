/**
 * Built-in DCSA carrier simulator and DCSA-only booking (DCSA-everywhere phase 1, TKT-IVI7FM, 2026-10-11).
 *
 *  - a carrier with no DCSA integration is reached through the simulator (outside production);
 *  - the simulator is a DCSA Booking 2.0 carrier: it refuses invalid requests with DCSA's ErrorResponse,
 *    and its GET answer validates against the published spec;
 *  - its decisions (Test Tools) reach CargoDesk as signed, spec-valid notifications: RECEIVED, CONFIRMED
 *    (which confirms the booking — manual confirmation is gone), amendment, cancellation, rejection with
 *    feedback; a decision that doesn't apply to the current state is refused;
 *  - a booking request that isn't valid DCSA (no container) is refused before anything is recorded;
 *  - the Demo carrier switch is admin-only; the status and connection endpoints report the simulator.
 *
 * Usage:
 *   node tests/dcsa-simulator.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001, not in production (the simulator is always on there)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { createRequire } from "node:module";
import { ensureOffices } from "./helpers/offices.mjs";
import { carrierActs, waitForCarrierReference, addContainer } from "./helpers/dcsa-sim.mjs";

const require = createRequire(import.meta.url);
const { validateResponse } = require("../lib/dcsa/validate.js");

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ method, hostname: "localhost", port: 3001, path, headers: {
      "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }),
      ...(payload && { "Content-Length": Buffer.byteLength(payload) }) } }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = Math.random().toString(36).slice(2, 7).toUpperCase();

(async () => {
  const cleanup = { shipments: [], customers: [], users: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const shipper = (await request("POST", "/api/customers", { companyName: `DCSA Sim Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `DCSA Sim Consignee ${rand} Inc` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id);
    const newShipment = async ({ carrierCode = "MAEU", container = true } = {}) => {
      const s = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode, status: "Active", contractType: "SPOT",
        contractRef: `SPOT-SIM-${rand}`, etd: "2026-11-02", eta: "2026-11-14", incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId }, token);
      cleanup.shipments.push(s.body.id);
      if (container) await addContainer(request, token, s.body.id);
      await request("POST", `/api/shipments/${s.body.id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
        etd: "2026-11-02", eta: "2026-11-14", carrierCode, vessel: "MAERSK SIM", vesselImo: "9999995", voyage: "045W" }, token);
      await request("POST", `/api/shipments/${s.body.id}/milestones/init`, {}, token);
      return s.body.id;
    };
    const booking = async id => (await request("GET", `/api/shipments/${id}/carrier-booking`, null, token)).body;

    console.log("Status and connection");
    const status = await request("GET", "/api/dcsa-simulator/status", null, token);
    assert("simulator available outside production", status.status === 200 && status.body.available === true && status.body.production === false, JSON.stringify(status.body));
    const conn = (await request("GET", "/api/carrier-connections/MAEU", null, token)).body;
    assert("MAEU (no integration) books through the simulator, flagged demo", conn?.capabilities?.booking?.via === "simulator" && conn.capabilities.booking.demo === true, JSON.stringify(conn));

    console.log("\nThe simulator is a DCSA Booking 2.0 carrier");
    const bad = await request("POST", "/dcsa-sim/v2/bookings", { receiptTypeAtOrigin: "CY" });
    assert("an invalid booking is refused 400 with DCSA's ErrorResponse", bad.status === 400 && bad.body?.statusCode === 400
      && Array.isArray(bad.body.errors) && bad.body.errors.length > 0 && !!bad.body.httpMethod && !!bad.body.errorDateTime, JSON.stringify(bad.body).slice(0, 300));
    const unknown = await request("GET", "/dcsa-sim/v2/bookings/SIM-NOPE");
    assert("an unknown booking is 404", unknown.status === 404);

    console.log("\nBooking request → RECEIVED → carrier confirms");
    const noEq = await newShipment({ container: false });
    const refused = await request("POST", `/api/shipments/${noEq}/edi-messages/booking-request`, {}, token);
    assert("a booking request with no container is refused (400), nothing recorded", refused.status === 400
      && (await request("GET", `/api/shipments/${noEq}/edi-messages`, null, token)).body.length === 0, JSON.stringify(refused.body));

    const A = await newShipment();
    const send = await request("POST", `/api/shipments/${A}/edi-messages/booking-request`, {}, token);
    assert("booking request accepted (201, pending)", send.status === 201 && send.body.pending && !send.body.carrierError, JSON.stringify(send.body).slice(0, 200));
    let b = await waitForCarrierReference(request, token, A);
    const ref = b?.carrierBookingRequestReference;
    assert("the simulator issued a SIM- reference and said RECEIVED; booking flagged demo", /^SIM-/.test(ref || "") && b.lastResponseStatus === "received" && b.isMock === true, JSON.stringify(b).slice(0, 200));
    const got = await request("GET", `/dcsa-sim/v2/bookings/${ref}`);
    const shape = validateResponse("bkg", "get", "/v2/bookings/{bookingReference}", 200, got.body);
    assert("the simulator's GET answer is a valid DCSA Booking", got.status === 200 && shape.ok, JSON.stringify(shape.errors).slice(0, 300));
    assert("it kept the request as CargoDesk sent it (carrierCode MAEU, ISO 45G1)", got.body.carrierCode === "MAEU" && got.body.requestedEquipments?.[0]?.ISOEquipmentCode === "45G1");
    const list = (await request("GET", "/api/test-tools/dcsa-sim/bookings", null, token)).body;
    const row = list.find(x => x.carrierBookingRequestReference === ref);
    assert("Test Tools lists it with its shipment and the decisions open to the carrier", row?.shipmentId === A && row.actions.includes("confirm") && row.actions.includes("reject") && !row.actions.includes("confirmCancellation"),
      JSON.stringify(row?.actions));

    const conf = await carrierActs(request, token, A, "confirm");
    b = await booking(A);
    assert("the carrier's CONFIRMED confirms the booking (no manual step)", conf.status === 200 && b.status === "Confirmed" && b.bookingRef === conf.body?.simulator?.carrierBookingReference, JSON.stringify({ s: b.status, r: b.bookingRef }));
    const ms = (await request("GET", `/api/shipments/${A}/milestones`, null, token)).body;
    assert("'Booking Confirmed' milestone completed, noting the demo carrier", /demo carrier/.test(JSON.stringify(ms.find(m => m.milestoneKey === "booking_confirmed") || {})));
    assert("a decision that doesn't apply now is refused (409)", (await carrierActs(request, token, A, "confirm")).status === 409);
    assert("an unknown decision is refused (400)", (await carrierActs(request, token, A, "teleport")).status === 400);
    assert("the manual confirm route is gone (404)", (await request("PATCH", `/api/shipments/${A}/carrier-booking/confirm`, { bookingRef: "X" }, token)).status === 404);

    console.log("\nAmendment and cancellation");
    const upd = await request("POST", `/api/shipments/${A}/carrier-booking/send-update`, {}, token);
    assert("send update → amendment requested", upd.status === 200 && upd.body?.booking?.lastResponseStatus === "amendment_requested", JSON.stringify(upd.body).slice(0, 200));
    await sleep(600);
    assert("carrier confirms the amendment", (await carrierActs(request, token, A, "confirmAmendment")).status === 200 && (await booking(A)).lastResponseStatus === "amendment_confirmed");
    const cancel = await request("PATCH", `/api/shipments/${A}/carrier-booking/cancel`, { reason: "Customer cancelled" }, token);
    assert("cancelling a confirmed booking only requests it", cancel.status === 200 && cancel.body.status === "Confirmed" && cancel.body.lastResponseStatus === "cancellation_requested");
    await sleep(600);
    const dc = await carrierActs(request, token, A, "declineCancellation", "Too late, already loaded");
    b = await booking(A);
    assert("carrier declines → stays Confirmed, cancellation_declined", dc.status === 200 && b.status === "Confirmed" && b.lastResponseStatus === "cancellation_declined", JSON.stringify({ s: b.status, l: b.lastResponseStatus }));

    console.log("\nRejection with feedback");
    const C = await newShipment();
    await request("POST", `/api/shipments/${C}/edi-messages/booking-request`, {}, token);
    const rj = await carrierActs(request, token, C, "reject", "No space on 045W");
    assert("carrier rejects → Rejected", rj.status === 200 && (await booking(C)).status === "Rejected");
    const inbound = (await request("GET", `/api/shipments/${C}/edi-messages`, null, token)).body.filter(m => m.direction === "in");
    assert("its feedback is on the notification CargoDesk received", inbound.some(m => JSON.stringify(m.parsedPayload || "").includes("No space on 045W")));

    console.log("\nThe Demo carrier switch is admin-only");
    const opEmail = `op-sim-${rand.toLowerCase()}@example.com`;
    await request("POST", "/api/users", { email: opEmail, name: "Operator Sim Test", roles: ["operator"], password: "OpFixture!2026Zq" }, token);
    cleanup.users.push(opEmail);
    const opToken = (await request("POST", "/api/auth/login", { email: opEmail, password: "OpFixture!2026Zq" })).body.token;
    const opTry = await request("PUT", "/api/settings", { dcsa_demo_carrier_enabled: "true" }, opToken);
    assert("an operator can't flip it (403)", opTry.status === 403, JSON.stringify(opTry.body));
    const adminTry = await request("PUT", "/api/settings", { dcsa_demo_carrier_enabled: "false" }, token);
    assert("an admin can", adminTry.status === 200, JSON.stringify(adminTry.body));
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token).catch(() => {});
    if (cleanup.users.length) {
      const users = (await request("GET", "/api/users", null, token)).body || [];
      for (const email of cleanup.users) { const u = users.find(x => x.email === email); if (u) await request("DELETE", `/api/users/${u.id}`, null, token).catch(() => {}); }
    }
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  }
})();
