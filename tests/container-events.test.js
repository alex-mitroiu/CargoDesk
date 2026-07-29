/**
 * Container lifecycle events + seal_number smoke test (zero dependencies)
 *
 * Exercises create → add container (with seal_number) → log/list/delete
 * container_events → audit-log cross-check, via the live server.
 *
 * Usage:
 *   node tests/container-events.test.js
 *
 * Prerequisites:
 *   - npm run server  (Express on :3001)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
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
    password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token)
    throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

// ─── Test suites ──────────────────────────────────────────────────────────────

async function testCreateShipment(token) {
  console.log("\nPOST /api/shipments (scratch shipment)");

  const res = await request("POST", "/api/shipments", {
    pol: "CNSHA", pod: "USNYC",
    carrierCode: "CMDU",
    status: "Active",
    contractType: "SPOT",
    etd: "2026-09-01",
  }, token);

  assert("returns 201", res.status === 201);
  assert("has id",      !!res.body?.id);
  return res.body.id;
}

async function testAddContainerWithSeal(token, shipmentId) {
  console.log("\nPOST /api/containers — seal_number field");

  const res = await request("POST", "/api/containers", {
    shipmentId, size: "40", type: "DC",
    containerNumber: "CMDU7654321",
    sealNumber: "SL1122334",
    cargoDescription: "Test cargo",
  }, token);

  assert("returns 201",               res.status === 201);
  assert("has id",                    !!res.body?.id);
  assert("sealNumber persisted",      res.body?.sealNumber === "SL1122334");

  return res.body.id;
}

async function testEventValidation(token, containerId) {
  console.log("\nPOST /api/containers/:id/events — validation");

  const badType = await request("POST", `/api/containers/${containerId}/events`, {
    eventType: "Not A Real Type", occurredAt: "2026-09-05",
  }, token);
  assert("400 for invalid eventType", badType.status === 400);

  const noDate = await request("POST", `/api/containers/${containerId}/events`, {
    eventType: "Gate In",
  }, token);
  assert("400 for missing occurredAt", noDate.status === 400);

  const badContainer = await request("POST", "/api/containers/DOESNOTEXIST-999/events", {
    eventType: "Gate In", occurredAt: "2026-09-05",
  }, token);
  assert("404 for non-existent container", badContainer.status === 404);
}

async function testEventCrud(token, containerId, shipmentId) {
  console.log("\nGET/POST/DELETE /api/containers/:id/events — lifecycle");

  const empty = await request("GET", `/api/containers/${containerId}/events`, null, token);
  assert("initial list is empty", Array.isArray(empty.body) && empty.body.length === 0);

  const ev1 = await request("POST", `/api/containers/${containerId}/events`, {
    eventType: "Empty Pickup", occurredAt: "2026-09-01", location: "Shanghai Depot",
  }, token);
  assert("Empty Pickup returns 201",  ev1.status === 201);
  assert("eventType matches",         ev1.body?.eventType === "Empty Pickup");
  assert("containerId matches",       ev1.body?.containerId === containerId);
  assert("shipmentId matches",        ev1.body?.shipmentId === shipmentId);
  assert("recordedBy present",        !!ev1.body?.recordedBy);

  const ev2 = await request("POST", `/api/containers/${containerId}/events`, {
    eventType: "Gate In", occurredAt: "2026-09-03", location: "CNSHA Terminal",
  }, token);
  assert("Gate In returns 201", ev2.status === 201);

  const list = await request("GET", `/api/containers/${containerId}/events`, null, token);
  assert("list returns 200",    list.status === 200);
  assert("has 2 events",        list.body?.length === 2);
  assert("ordered by occurredAt (Empty Pickup first)", list.body[0]?.eventType === "Empty Pickup");
  assert("ordered by occurredAt (Gate In second)",     list.body[1]?.eventType === "Gate In");

  const del = await request("DELETE", `/api/container-events/${ev2.body.id}`, null, token);
  assert("DELETE returns 200", del.status === 200);

  const afterDel = await request("GET", `/api/containers/${containerId}/events`, null, token);
  assert("1 event remains after delete", afterDel.body?.length === 1);
  assert("remaining event is Empty Pickup", afterDel.body?.[0]?.eventType === "Empty Pickup");

  const notFound = await request("DELETE", "/api/container-events/DOESNOTEXIST-999", null, token);
  assert("404 for non-existent event", notFound.status === 404);

  return ev1.body.id;
}

async function testAuditLogCrossCheck(token, shipmentId) {
  console.log("\nGET /api/shipments/:id/events — CONTAINER_EVENT_ADDED cross-check");

  const res = await request("GET", `/api/shipments/${shipmentId}/events`, null, token);
  assert("returns 200", res.status === 200);

  const found = (res.body?.results || []).find(e => e.eventType === "CONTAINER_EVENT_ADDED");
  assert("CONTAINER_EVENT_ADDED logged to shipment_events", !!found);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  console.log("Container events + seal_number — smoke tests");
  console.log(`Server: ${BASE}\n`);

  let shipmentId;
  let containerId;
  let remainingEventId;

  try {
    const token = await login();
    console.log("  ✓ Login OK");

    shipmentId  = await testCreateShipment(token);
    containerId = await testAddContainerWithSeal(token, shipmentId);
    await testEventValidation(token, containerId);
    remainingEventId = await testEventCrud(token, containerId, shipmentId);
    await testAuditLogCrossCheck(token, shipmentId);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  } finally {
    const t = await login().catch(() => null);
    if (t) {
      if (remainingEventId) await request("DELETE", `/api/container-events/${remainingEventId}`, null, t);
      if (containerId)      await request("DELETE", `/api/containers/${containerId}`, null, t);
      if (shipmentId)       await request("DELETE", `/api/shipments/${shipmentId}`, null, t);
    }
  }

  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
