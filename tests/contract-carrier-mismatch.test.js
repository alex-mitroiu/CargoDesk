/**
 * Contract/Schedule Carrier Mismatch — auto-drop the Central contract, cancel the stale booking
 *
 * Real bug reported and reproduced live on SHP-PZ9IJI: a Central contract locks the shipment's
 * own carrier_code, but nothing stopped Add Sailing/a manual leg edit from applying a genuinely
 * different carrier's sailing on top of an already-locked contract — the contract and the actual
 * schedule/legs just silently disagreed forever, with no warning and no cascade. This covers the
 * fix in syncShipmentFromLegs (server.js): once a SEA leg's own carrier diverges from a locked
 * Central contract, the contract is dropped (same field-reset shape the CRD-vs-ETD guard already
 * uses), the correct carrier rolls up, a CONTRACT_DROPPED event is logged, and any pending
 * carrier booking under the old carrier is cancelled + archived.
 *
 * Also covers a second, unrelated real bug found live on SHP-S0Z326: the CRD-vs-ETD guard itself
 * (routes/shipments.js) used to re-fire on ANY save to a shipment already sitting in a stale
 * cargoReadyDate > etd state, silently wiping a freshly-picked contract on every attempt — see
 * the "CRD-vs-ETD guard" section below.
 *
 * Usage:
 *   node tests/contract-carrier-mismatch.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

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

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    const { emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId } = await ensureOffices(token);

    console.log("\nScratch Central contract for HLCU, NLRTM → USNYC");
    const num = `TC-MISMATCH-${Date.now()}`;
    const contract = await request("POST", "/api/contracts", {
      contractNumber: num, carrierCode: "HLCU", status: "Active",
      validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC" }],
      rates: [{ serviceCode: "OF", amount: 500, currency: "USD", unit: "per_container" }],
    }, token);
    assert("scratch contract created", contract.status === 201, JSON.stringify(contract.body));
    const contractId = contract.body.id;

    console.log("\nScratch shipment, then attach the HLCU Central contract");
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId,
    }, token);
    assert("scratch shipment created", ship.status === 201, JSON.stringify(ship.body));
    const shipmentId = ship.body.id;

    const attach = await request("PUT", `/api/shipments/${shipmentId}`, {
      pol: "NLRTM", pod: "USNYC", carrierCode: "HLCU", contractType: "Central",
      contractId, contractRef: num,
    }, token);
    assert("contract attached", attach.status === 200 && attach.body.contractId === contractId);
    assert("carrierCode locked to the contract's own carrier (HLCU)", attach.body.carrierCode === "HLCU");

    console.log("\nAdding a SEA leg under the SAME carrier (HLCU) changes nothing — no mismatch yet");
    const leg = await request("POST", `/api/shipments/${shipmentId}/legs`, {
      legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
      etd: "2026-09-01", eta: "2026-09-15", carrierCode: "HLCU", vessel: "TEST VESSEL", voyage: "V1",
    }, token);
    assert("SEA leg created", leg.status === 201, JSON.stringify(leg.body));
    const legId = leg.body.id;
    const shipAfterLeg = await request("GET", `/api/shipments/${shipmentId}`, null, token);
    assert("carrierCode still HLCU (matches the contract)", shipAfterLeg.body.carrierCode === "HLCU");
    assert("contract still attached", shipAfterLeg.body.contractId === contractId);

    console.log("\nA carrier booking auto-creates now that a Central contract + a SEA leg with an etd both exist");
    const bookingBefore = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
    assert("booking auto-created", !!bookingBefore.body?.id, JSON.stringify(bookingBefore.body));
    assert("booking carrier is HLCU (the contract's carrier)", bookingBefore.body?.carrierCode === "HLCU");
    assert("booking status is Created", bookingBefore.body?.status === "Created");
    const bookingId = bookingBefore.body?.id;

    console.log("\nBUG REPRO (SHP-PZ9IJI): editing that SEA leg to a DIFFERENT carrier (CMDU) — the schedule now disagrees with the locked HLCU contract");
    const mismatch = await request("PUT", `/api/shipments/${shipmentId}/legs/${legId}`, {
      legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
      etd: "2026-09-01", eta: "2026-09-15", carrierCode: "CMDU", vessel: "TEST VESSEL", voyage: "V1",
    }, token);
    assert("leg update returns 200", mismatch.status === 200, JSON.stringify(mismatch.body));

    const shipAfterMismatch = await request("GET", `/api/shipments/${shipmentId}`, null, token);
    assert("carrierCode rolled up to the leg's real carrier (CMDU)", shipAfterMismatch.body.carrierCode === "CMDU",
      JSON.stringify(shipAfterMismatch.body.carrierCode));
    assert("stale contract auto-dropped (contractId cleared)", shipAfterMismatch.body.contractId === "");
    assert("stale contract auto-dropped (contractRef cleared)", shipAfterMismatch.body.contractRef === "");
    assert("contractType left as-is (Central, no contract picked yet — same empty state a fresh shipment lands on)",
      shipAfterMismatch.body.contractType === "Central");
    assert("status forced to Requires Review", shipAfterMismatch.body.status === "Requires Review");

    console.log("\nA CONTRACT_DROPPED audit event explains why");
    const events = await request("GET", `/api/shipments/${shipmentId}/events?types=CONTRACT_DROPPED`, null, token);
    const dropEvent = (events.body.results || []).find(e => e.eventType === "CONTRACT_DROPPED");
    assert("CONTRACT_DROPPED event logged", !!dropEvent, JSON.stringify(events.body));
    assert("event names the dropped contract id as the old value", dropEvent?.oldValue === contractId);

    console.log("\nThe stale HLCU booking is cancelled and archived, not left dangling under the old carrier");
    const bookingAfter = await request("GET", `/api/shipments/${shipmentId}/carrier-booking`, null, token);
    assert("no current booking right after the drop (contract gone, nothing to re-create one yet)", !bookingAfter.body?.id || bookingAfter.body.id !== bookingId);
    const history = await request("GET", `/api/shipments/${shipmentId}/carrier-booking-history`, null, token);
    const archived = (history.body || []).find(b => b.id === bookingId);
    assert("original HLCU booking is in the archive", !!archived, JSON.stringify(history.body));
    assert("archived booking shows Cancelled", archived?.status === "Cancelled");
    assert("archived booking's carrier is still HLCU (a fact about what it was)", archived?.carrierCode === "HLCU");
    assert("cancelledBy is the automatic system actor", archived?.cancelledBy === "System (Auto)");
    assert("archivedAt is set", !!archived?.archivedAt);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/contracts/${contractId}`, null, token);

    // ── CRD-vs-ETD guard: must not re-fire on every unrelated save ──────────────
    // Real bug found live on SHP-S0Z326: the guard (routes/shipments.js) reads cargoReadyDate/
    // etd via field(), which falls back to the already-stored value whenever a request doesn't
    // send one. A shipment that was ever left with cargoReadyDate > etd re-evaluated that same
    // stale mismatch on every LATER, unrelated PUT (e.g. picking a new Central contract, which
    // never touches either date) and wiped contractId again each time — permanently blocking
    // that shipment from ever having a contract set again. Fixed by gating the guard on the
    // request actually sending cargoReadyDate or etd.
    console.log("\nCRD-vs-ETD guard must not misfire on a PUT that never touches either date");
    const crdContract = await request("POST", "/api/contracts", {
      contractNumber: `TC-CRDGUARD-${Date.now()}`, carrierCode: "HLCU", status: "Active",
      validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC" }],
      rates: [{ serviceCode: "OF", amount: 500, currency: "USD", unit: "per_container" }],
    }, token);
    assert("CRD-guard scratch contract created", crdContract.status === 201, JSON.stringify(crdContract.body));
    const crdContractId = crdContract.body.id;

    // Created already in the "bad" state (cargoReadyDate after etd) — mirrors a shipment that
    // drifted into this state from some earlier, unrelated edit, not something this test itself
    // is trying to change right now.
    const crdShip = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "HLCU", status: "Active", contractType: "Central",
      etd: "2026-06-22", cargoReadyDate: "2026-09-16",
      emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId,
    }, token);
    assert("CRD-guard scratch shipment created", crdShip.status === 201, JSON.stringify(crdShip.body));
    const crdShipmentId = crdShip.body.id;

    const contractOnlyPut = await request("PUT", `/api/shipments/${crdShipmentId}`, {
      contractType: "Central", contractId: crdContractId, contractRef: crdContract.body.contractNumber,
    }, token);
    assert("contract-only PUT returns 200", contractOnlyPut.status === 200, JSON.stringify(contractOnlyPut.body));
    assert("contractId survives a PUT that never mentions cargoReadyDate/etd",
      contractOnlyPut.body?.contractId === crdContractId, JSON.stringify(contractOnlyPut.body));
    assert("status stays Active, not force-flipped to Requires Review", contractOnlyPut.body?.status === "Active");
    assert("scheduleDropped not set on an unrelated save", !contractOnlyPut.body?.scheduleDropped);

    console.log("\nCRD-vs-ETD guard must still fire on a genuine CRD edit that creates a new mismatch");
    const realCrdEdit = await request("PUT", `/api/shipments/${crdShipmentId}`, {
      cargoReadyDate: "2026-06-25", // now after this shipment's own etd (2026-06-22)
    }, token);
    assert("contractId cleared by a genuine CRD-past-ETD edit", realCrdEdit.body?.contractId === "", JSON.stringify(realCrdEdit.body));
    assert("status forced to Requires Review", realCrdEdit.body?.status === "Requires Review");
    assert("scheduleDropped:true carried for the frontend warning toast", realCrdEdit.body?.scheduleDropped === true);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${crdShipmentId}`, null, token);
    await request("DELETE", `/api/contracts/${crdContractId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
