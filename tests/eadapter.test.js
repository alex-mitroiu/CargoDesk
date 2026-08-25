/**
 * eAdapter — per-carrier EDI connectivity configuration (carrier-EDI epic, story 1)
 *
 * Usage:
 *   node tests/eadapter.test.js
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

// ─── Config CRUD ───────────────────────────────────────────────────────────

async function testConfigCrud(token) {
  console.log("\neAdapter — config CRUD");
  const code = "EATX";

  const create = await request("POST", "/api/eadapter/configs", {
    carrierCode: code, transportType: "rest_api", endpointUrl: "https://api.example.com/booking",
    authHeaderName: "Consumer-Key", credential: "sk_test_12345", isActive: true, notes: "Scratch test carrier",
  }, token);
  assert("create returns 201", create.status === 201);
  assert("id has EAC- prefix", typeof create.body?.id === "string" && create.body.id.startsWith("EAC-"));
  assert("carrierCode is uppercased", create.body?.carrierCode === code);
  assert("hasCredential is true", create.body?.hasCredential === true);
  assert("raw credential is never returned", !("credential" in create.body));
  const configId = create.body.id;

  const dupe = await request("POST", "/api/eadapter/configs", { carrierCode: code }, token);
  assert("duplicate carrierCode returns 409", dupe.status === 409);

  const list1 = await request("GET", "/api/eadapter/configs", null, token);
  assert("list returns 200", list1.status === 200);
  const row1 = (list1.body || []).find(r => r.id === configId);
  assert("created config appears in the list", !!row1);
  assert("list row also never carries a raw credential", row1 && !("credential" in row1));

  const update = await request("PUT", `/api/eadapter/configs/${configId}`, {
    transportType: "sftp", endpointUrl: "sftp://example.com/inbound", isActive: false,
    notes: "Updated notes", credential: "",
  }, token);
  assert("update returns 200", update.status === 200);
  assert("transportType updated", update.body?.transportType === "sftp");
  assert("isActive updated to false", update.body?.isActive === false);
  assert("blank credential on update keeps hasCredential true (existing one preserved)", update.body?.hasCredential === true);

  const badTransport = await request("PUT", `/api/eadapter/configs/${configId}`, { transportType: "carrier-pigeon" }, token);
  assert("invalid transportType rejected (400)", badTransport.status === 400);

  const del = await request("DELETE", `/api/eadapter/configs/${configId}`, null, token);
  assert("delete returns 200", del.status === 200);
  const list2 = await request("GET", "/api/eadapter/configs", null, token);
  assert("deleted config no longer in the list", !(list2.body || []).some(r => r.id === configId));
}

// ─── bookable-carriers reflects active/inactive/deleted configs ────────────

async function testBookableCarriersReflection(token) {
  console.log("\neAdapter — bookable-carriers reflects config lifecycle");
  const code = "EATY";

  const baseline = await request("GET", "/api/eadapter/bookable-carriers", null, token);
  assert("baseline includes the 3 built-in carriers", ["MAEU", "SAFM", "MCPU"].every(c => baseline.body?.carriers?.includes(c)));
  assert("baseline does not yet include the scratch carrier", !baseline.body?.carriers?.includes(code));

  const create = await request("POST", "/api/eadapter/configs", { carrierCode: code, isActive: true }, token);
  const configId = create.body.id;

  const afterActive = await request("GET", "/api/eadapter/bookable-carriers", null, token);
  assert("active config's carrier is now bookable", afterActive.body?.carriers?.includes(code));

  await request("PUT", `/api/eadapter/configs/${configId}`, { isActive: false }, token);
  const afterInactive = await request("GET", "/api/eadapter/bookable-carriers", null, token);
  assert("deactivated config's carrier is no longer bookable", !afterInactive.body?.carriers?.includes(code));

  await request("PUT", `/api/eadapter/configs/${configId}`, { isActive: true }, token);
  const afterReactive = await request("GET", "/api/eadapter/bookable-carriers", null, token);
  assert("re-activated config's carrier is bookable again", afterReactive.body?.carriers?.includes(code));

  await request("DELETE", `/api/eadapter/configs/${configId}`, null, token);
  const afterDelete = await request("GET", "/api/eadapter/bookable-carriers", null, token);
  assert("deleted config's carrier is no longer bookable", !afterDelete.body?.carriers?.includes(code));
}

// ─── Master toggle gates ALL carriers, including the built-in 3 ────────────

async function testMasterToggleGatesEverything(token) {
  console.log("\neAdapter — master toggle off blocks even the built-in 3 (no gaps, one switch)");
  const shipmentId = await scratchShipment(token, "MAEU");
  assert("scratch MAEU shipment created", !!shipmentId);

  const sendWhileOn = await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  assert("MAEU booking-request succeeds while eAdapter is on", sendWhileOn.status === 201);

  await request("PUT", "/api/settings", { api_eadapter_enabled: "false" }, token);
  try {
    const bc = await request("GET", "/api/eadapter/bookable-carriers", null, token);
    assert("bookable-carriers reports enabled:false", bc.body?.enabled === false);
    assert("bookable-carriers is empty while disabled", Array.isArray(bc.body?.carriers) && bc.body.carriers.length === 0);

    const shipment2 = await scratchShipment(token, "MAEU");
    const sendWhileOff = await request("POST", `/api/shipments/${shipment2}/edi-messages/booking-request`, {}, token);
    assert("MAEU booking-request is blocked (400) while master toggle is off", sendWhileOff.status === 400);
    await request("DELETE", `/api/shipments/${shipment2}`, null, token);
  } finally {
    await request("PUT", "/api/settings", { api_eadapter_enabled: "true" }, token);
  }

  const bc2 = await request("GET", "/api/eadapter/bookable-carriers", null, token);
  assert("bookable-carriers reports enabled:true after restoring the toggle", bc2.body?.enabled === true);
  assert("MAEU is bookable again after restoring the toggle", bc2.body?.carriers?.includes("MAEU"));

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
}

(async () => {
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");

    await testConfigCrud(token);
    await testBookableCarriersReflection(token);
    await testMasterToggleGatesEverything(token);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal error:", e.message);
    process.exit(1);
  }
})();
