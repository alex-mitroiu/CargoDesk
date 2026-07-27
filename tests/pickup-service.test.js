/**
 * v0.40.0 Smoke tests — Pickup Service (Export) for Merchant's Haulage
 *
 * Usage:
 *   node tests/pickup-service.test.js
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

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch shipment + Merchant's Haulage Pick-up leg + containers");
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    }, token);
    const shipmentId = ship.body.id;
    assert("scratch shipment created", !!shipmentId);

    const leg = await request("POST", `/api/shipments/${shipmentId}/legs`, {
      legType: "Pick-up", movementType: "Merchant's Haulage", pol: "NLAMS", pod: "NLRTM",
      etd: "2026-09-01",
    }, token);
    assert("Pick-up leg created", leg.status === 201);
    // Every new shipment already gets a default SEA leg via the form flow in the real app,
    // but this scratch shipment was created via the raw API — add one so the Pick-up leg
    // above isn't the ONLY leg (matches a realistic multi-leg shipment).
    await request("POST", `/api/shipments/${shipmentId}/legs`, {
      legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-09-03",
    }, token);

    const c1 = await request("POST", "/api/containers", { shipmentId, size: "40", type: "HC" }, token);
    const c2 = await request("POST", "/api/containers", { shipmentId, size: "20", type: "GP" }, token);
    assert("2 containers created", c1.status === 201 && c2.status === 201);

    console.log("\nOrder an Export Pickup service");
    const svc = await request("POST", `/api/shipments/${shipmentId}/services`, {
      side: "Export", serviceType: "Pickup", vendorName: "Test Trucking Co",
    }, token);
    assert("service created", svc.status === 201);
    assert("serviceType is Pickup", svc.body.serviceType === "Pickup");
    const serviceId = svc.body.id;

    console.log("\nPer-container plan (reusing the generic loading-plan table/routes)");
    const plan = await request("GET", `/api/shipments/${shipmentId}/services/${serviceId}/loading-plan`, null, token);
    assert("loading-plan returns 200", plan.status === 200);
    assert("one row per container", Array.isArray(plan.body) && plan.body.length === 2);

    const line = plan.body.find(l => l.containerId === c1.body.id);
    const update = await request("PUT",
      `/api/shipments/${shipmentId}/services/${serviceId}/loading-plan/${line.containerId}`,
      { plannedDate: "2026-08-28T09:00", sequenceOrder: 1, notes: "First pickup" }, token);
    assert("plan line update returns 200", update.status === 200);
    assert("plannedDate round-trips", update.body.plannedDate === "2026-08-28T09:00");

    console.log("\nSequence has no 0th/negative position — 1 is the floor, regardless of what's sent");
    const line2 = plan.body.find(l => l.containerId === c2.body.id);
    const zeroSeq = await request("PUT",
      `/api/shipments/${shipmentId}/services/${serviceId}/loading-plan/${line2.containerId}`,
      { sequenceOrder: 0 }, token);
    assert("sequenceOrder 0 is clamped to 1", zeroSeq.body.sequenceOrder === 1);
    const negativeSeq = await request("PUT",
      `/api/shipments/${shipmentId}/services/${serviceId}/loading-plan/${line2.containerId}`,
      { sequenceOrder: -3 }, token);
    assert("a negative sequenceOrder is also clamped to 1", negativeSeq.body.sequenceOrder === 1);
    const validSeq = await request("PUT",
      `/api/shipments/${shipmentId}/services/${serviceId}/loading-plan/${line2.containerId}`,
      { sequenceOrder: 4 }, token);
    assert("a valid sequenceOrder (4) is left untouched", validSeq.body.sequenceOrder === 4);

    console.log("\nPU01 document accepted (docType is not validated against a fixed list)");
    const doc = await request("POST", `/api/shipments/${shipmentId}/documents`, {
      filename: "pickup-plan-test.html", mimeType: "text/html", docType: "PU01",
      data: Buffer.from("<html>test</html>").toString("base64"),
    }, token);
    assert("PU01 document upload returns 201", doc.status === 201);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
