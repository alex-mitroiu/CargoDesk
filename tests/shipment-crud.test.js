/**
 * TKT-AW3Y7E — Core shipment CRUD smoke test (zero dependencies)
 *
 * Exercises create → container → status-change → audit-log via the live server.
 *
 * Usage:
 *   node tests/shipment-crud.test.js
 *
 * Prerequisites:
 *   - npm run server  (Express on :3001)
 *   - Admin account: claudeagent@localhost / admin
 */

import http from "node:http";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

// ─── Minimal HTTP helpers ─────────────────────────────────────────────────────

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

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost",
    password: "admin",
  });
  if (status !== 200 || !body.token)
    throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

// ─── Test suites ──────────────────────────────────────────────────────────────

async function testCreateShipment(token) {
  console.log("\nPOST /api/shipments");

  const res = await request("POST", "/api/shipments", {
    pol: "CNSHA", pod: "USNYC",
    carrierCode: "CMDU",
    status: "Active",
    contractType: "SPOT",
    etd: "2026-09-01",
  }, token);

  assert("returns 201",              res.status === 201);
  assert("has id",                   !!res.body?.id);
  assert("pol matches",              res.body?.pol === "CNSHA");
  assert("pod matches",              res.body?.pod === "USNYC");
  assert("carrierCode matches",      res.body?.carrierCode === "CMDU");
  assert("status matches",           res.body?.status === "Active");
  assert("contractType matches",     res.body?.contractType === "SPOT");

  const missing = await request("POST", "/api/shipments", { status: "Active" }, token);
  assert("400 for missing required fields", missing.status === 400);

  return res.body.id;
}

async function testGetShipment(token, shipmentId) {
  console.log("\nGET /api/shipments/:id");

  const res = await request("GET", `/api/shipments/${shipmentId}`, null, token);
  assert("returns 200",              res.status === 200);
  assert("id matches",               res.body?.id === shipmentId);
  assert("pol matches",              res.body?.pol === "CNSHA");

  const notFound = await request("GET", "/api/shipments/DOESNOTEXIST-999", null, token);
  assert("404 for non-existent id",  notFound.status === 404);
}

async function testAddContainer(token, shipmentId) {
  console.log("\nPOST /api/containers");

  const res = await request("POST", "/api/containers", {
    shipmentId,
    size: "20",
    type: "GP",
    containerNumber: "CMDU1234567",
    cargoDescription: "Test cargo",
  }, token);

  assert("returns 201",              res.status === 201);
  assert("has id",                   !!res.body?.id);
  assert("shipmentId matches",       res.body?.shipmentId === shipmentId);
  assert("size matches",             res.body?.size === "20");
  assert("type matches",             res.body?.type === "GP");

  const missing = await request("POST", "/api/containers", { shipmentId }, token);
  assert("400 for missing size/type", missing.status === 400);

  return res.body.id;
}

async function testStatusChange(token, shipmentId) {
  console.log("\nPUT /api/shipments/:id — status change");

  const get = await request("GET", `/api/shipments/${shipmentId}`, null, token);
  const updated = await request("PUT", `/api/shipments/${shipmentId}`, {
    ...get.body,
    status: "In Transit",
  }, token);

  assert("returns 200",              updated.status === 200);
  assert("status is In Transit",     updated.body?.status === "In Transit");

  // Verify persisted
  const verify = await request("GET", `/api/shipments/${shipmentId}`, null, token);
  assert("persisted after GET",      verify.body?.status === "In Transit");

  // Update bookingRef
  const br = await request("PUT", `/api/shipments/${shipmentId}`, {
    ...verify.body,
    bookingRef: "BKG-SMOKE-001",
  }, token);
  assert("bookingRef updated",       br.body?.bookingRef === "BKG-SMOKE-001");

  const notFound = await request("PUT", "/api/shipments/DOESNOTEXIST-999", {
    pol: "CNSHA", pod: "USNYC", carrierCode: "CMDU",
    status: "Active", contractType: "SPOT",
  }, token);
  assert("404 for non-existent id",  notFound.status === 404);
}

async function testAuditLog(token, shipmentId) {
  console.log("\nGET /api/shipments/:id/events — audit log");

  const res = await request("GET", `/api/shipments/${shipmentId}/events`, null, token);
  assert("returns 200",              res.status === 200);
  assert("returns array",            Array.isArray(res.body));
  assert("has at least one event",   res.body.length >= 1);

  const statusEvent = res.body.find(e => e.eventType === "STATUS_CHANGED");
  assert("STATUS_CHANGED event exists",    !!statusEvent);
  assert("newValue is In Transit",         statusEvent?.newValue === "In Transit");
  assert("oldValue is Active",             statusEvent?.oldValue === "Active");
  assert("shipmentId on event matches",    statusEvent?.shipmentId === shipmentId);

  const ev = res.body[0];
  const hasShape = ["id", "shipmentId", "eventType", "field", "oldValue", "newValue", "actor", "occurredAt", "meta"]
    .every(k => Object.prototype.hasOwnProperty.call(ev, k));
  assert("event has correct shape",        hasShape);

  // Events ordered ascending
  const dates = res.body.map(e => e.occurredAt);
  const sorted = [...dates].sort();
  assert("events ordered by occurredAt",   JSON.stringify(dates) === JSON.stringify(sorted));
}

async function testDeleteShipment(token, shipmentId) {
  console.log("\nDELETE /api/shipments/:id");

  const del = await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
  assert("returns 200",              del.status === 200);

  const gone = await request("GET", `/api/shipments/${shipmentId}`, null, token);
  assert("GET after DELETE is 404",  gone.status === 404);

  const notFound = await request("DELETE", "/api/shipments/DOESNOTEXIST-999", null, token);
  assert("404 for non-existent id",  notFound.status === 404);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  console.log("Shipment CRUD — smoke tests");
  console.log(`Server: ${BASE}\n`);

  let shipmentId;

  try {
    const token = await login();
    console.log("  ✓ Login OK");

    shipmentId = await testCreateShipment(token);
    await testGetShipment(token, shipmentId);
    await testAddContainer(token, shipmentId);
    await testStatusChange(token, shipmentId);
    await testAuditLog(token, shipmentId);
    await testDeleteShipment(token, shipmentId);
    shipmentId = null; // already deleted
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  } finally {
    if (shipmentId) {
      const t = await login().catch(() => null);
      if (t) await request("DELETE", `/api/shipments/${shipmentId}`, null, t);
    }
  }

  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
