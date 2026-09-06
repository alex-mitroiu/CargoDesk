/**
 * Customs & Regulatory Filing (Epic TKT-XW6TQK) — smoke tests
 *
 * Usage:
 *   node tests/customs-filing.test.js
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

async function scratchShipment(token) {
  const res = await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU",
    status: "Active", contractType: "SPOT", etd: "2026-09-01",
    // Shipper (USPPI) / Consignee (Ultimate Consignee) — TKT-6A7J45 story 7 added these to the
    // filing-creation gate, so every test in this file needs both set from the start.
    shipperName: "Test Fixture Shipper Co", consigneeName: "Test Fixture Consignee Co",
  }, token);
  return res.body.id;
}

async function addBrokerParty(token, shipmentId, role, customerId, customerName) {
  return request("POST", `/api/shipments/${shipmentId}/parties`, { role, customerId, customerName }, token);
}

async function addPricedPackage(token, shipmentId, containerId, unitValue = 1000, currency = "USD") {
  return request("POST", `/api/shipments/${shipmentId}/containers/${containerId}/packages`,
    { description: "Test cargo", quantity: 1, unitValue, currency }, token);
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch shipment + customer + container + priced cargo line + Export broker");
    const shipmentId = await scratchShipment(token);
    assert("scratch shipment created", !!shipmentId);
    const cust = await request("POST", "/api/customers", { companyName: "Test Customs Broker Co" }, token);
    assert("scratch customer created", !!cust.body.id);
    const ctr = await request("POST", "/api/containers", { shipmentId, size: "40", type: "HC" }, token);
    const containerId = ctr.body.id;
    assert("container created", !!containerId);
    const pkg = await addPricedPackage(token, shipmentId, containerId);
    assert("priced cargo line created", pkg.status === 201 && pkg.body.unitValueUsd != null);
    const broker = await addBrokerParty(token, shipmentId, "Customs Broker (Export)", cust.body.id, cust.body.companyName);
    assert("Export broker party assigned", broker.status === 201);

    console.log("\nCreate a Draft AES/EEI filing");
    const empty = await request("GET", `/api/shipments/${shipmentId}/customs-filings`, null, token);
    assert("GET returns 200, empty before creation", empty.status === 200 && empty.body.length === 0);
    const draft = await request("POST", `/api/shipments/${shipmentId}/customs-filings`, { filingType: "AES_EEI" }, token);
    assert("create returns 201", draft.status === 201);
    assert("status is Draft", draft.body.status === "Draft");
    assert("filingType round-trips", draft.body.filingType === "AES_EEI");
    const filingId = draft.body.id;

    console.log("\nDuplicate filingType on the same shipment is rejected");
    const dup = await request("POST", `/api/shipments/${shipmentId}/customs-filings`, { filingType: "AES_EEI" }, token);
    assert("duplicate filingType rejected (409)", dup.status === 409);

    console.log("\nInvalid filingType is rejected");
    const bad = await request("POST", `/api/shipments/${shipmentId}/customs-filings`, { filingType: "BOGUS" }, token);
    assert("invalid filingType rejected", bad.status >= 400);

    console.log("\nSubmit the Draft (Draft → Filed)");
    const submitted = await request("POST", `/api/shipments/${shipmentId}/customs-filings/${filingId}/submit`, {}, token);
    assert("submit returns 201", submitted.status === 201);
    assert("status is Filed", submitted.body.filing.status === "Filed");
    assert("filingReference starts with AES", submitted.body.filing.filingReference.startsWith("AES"));
    const firstRef = submitted.body.filing.filingReference;

    console.log("\nSubmitting an already-Filed filing is rejected");
    const resubmit = await request("POST", `/api/shipments/${shipmentId}/customs-filings/${filingId}/submit`, {}, token);
    assert("re-submit rejected (409)", resubmit.status === 409);

    console.log("\nSimulate an Accepted response");
    const accepted = await request("POST", `/api/shipments/${shipmentId}/customs-filings/${filingId}/simulate-response`,
      { outcome: "accepted", confirmationNumber: "CBP-TEST-123" }, token);
    assert("simulate returns 201", accepted.status === 201);
    assert("status is Accepted", accepted.body.filing.status === "Accepted");
    assert("confirmationNumber round-trips", accepted.body.filing.confirmationNumber === "CBP-TEST-123");

    const acceptedMessages = await request("GET", `/api/shipments/${shipmentId}/edi-messages`, null, token);
    const inboundForFiling = acceptedMessages.body.filter(m => m.correlationId === filingId && m.direction === "in");
    assert("inbound acceptance message recorded with matching correlationId", inboundForFiling.length === 1);

    console.log("\nSimulating a response on a non-Filed filing (now Accepted) is rejected");
    const notFiled = await request("POST", `/api/shipments/${shipmentId}/customs-filings/${filingId}/simulate-response`,
      { outcome: "accepted" }, token);
    assert("simulate on Accepted filing rejected (409)", notFiled.status === 409);

    console.log("\nSecond filing type (ISF/AMS) on the same shipment, ending Rejected");
    const importBroker = await addBrokerParty(token, shipmentId, "Customs Broker (Import)", cust.body.id, cust.body.companyName);
    assert("Import broker party assigned", importBroker.status === 201);
    const draft2 = await request("POST", `/api/shipments/${shipmentId}/customs-filings`, { filingType: "ISF_AMS" }, token);
    assert("second filing (different type) created (201)", draft2.status === 201);
    const filingId2 = draft2.body.id;
    const submitted2 = await request("POST", `/api/shipments/${shipmentId}/customs-filings/${filingId2}/submit`, {}, token);
    assert("second filing submitted, ref starts with ISF", submitted2.body.filing.filingReference.startsWith("ISF"));
    const rejected = await request("POST", `/api/shipments/${shipmentId}/customs-filings/${filingId2}/simulate-response`,
      { outcome: "rejected", reason: "Custom test rejection reason" }, token);
    assert("simulate rejected returns 201", rejected.status === 201);
    assert("status is Rejected", rejected.body.filing.status === "Rejected");
    assert("rejectionReason round-trips", rejected.body.filing.rejectionReason === "Custom test rejection reason");

    console.log("\nBoth filings coexist independently on the shipment");
    const both = await request("GET", `/api/shipments/${shipmentId}/customs-filings`, null, token);
    assert("both filings present", both.body.length === 2);
    assert("AES/EEI still Accepted", both.body.find(f => f.filingType === "AES_EEI").status === "Accepted");
    assert("ISF/AMS is Rejected", both.body.find(f => f.filingType === "ISF_AMS").status === "Rejected");

    console.log("\nReset the Rejected filing back to Draft");
    const reset = await request("PATCH", `/api/shipments/${shipmentId}/customs-filings/${filingId2}/reset`, {}, token);
    assert("reset returns 200", reset.status === 200);
    assert("status is Draft again", reset.body.status === "Draft");
    assert("filingReference cleared", reset.body.filingReference === "");
    assert("rejectionReason cleared", reset.body.rejectionReason === "");

    console.log("\nResetting a non-Rejected filing is rejected");
    const badReset = await request("PATCH", `/api/shipments/${shipmentId}/customs-filings/${filingId}/reset`, {}, token);
    assert("reset on Accepted filing rejected (409)", badReset.status === 409);

    console.log("\nResubmitting after reset generates a genuinely new reference");
    const resubmitted2 = await request("POST", `/api/shipments/${shipmentId}/customs-filings/${filingId2}/submit`, {}, token);
    assert("resubmit returns 201", resubmitted2.status === 201);
    assert("new filingReference differs from the original AES ref", resubmitted2.body.filing.filingReference !== firstRef);
    assert("new filingReference starts with ISF", resubmitted2.body.filing.filingReference.startsWith("ISF"));

    console.log("\nCross-shipment list (Test Tools Filing Simulator picker)");
    const crossList = await request("GET", "/api/customs-filings?status=Filed", null, token);
    assert("cross-shipment list returns 200", crossList.status === 200);
    assert("includes our resubmitted ISF/AMS filing", crossList.body.some(f => f.id === filingId2 && f.shipment?.id === shipmentId));

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/customers/${cust.body.id}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
