/**
 * v0.25.0 Smoke tests — Shipment Schedules + Related Tickets filter
 *
 * Usage:
 *   node tests/schedules.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / admin
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
    password: "admin",
  });
  if (status !== 200 || !body.token)
    throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

// ─── Shipment Schedules ───────────────────────────────────────────────────────

async function testShipmentSchedules(token) {
  console.log("\nGET|POST|DELETE /api/shipments/:id/schedules");

  // Create a scratch shipment
  const sRes = await request("POST", "/api/shipments", {
    pol: "CNSHA", pod: "USLAX", carrierCode: "MAEU",
    status: "Active", contractType: "SPOT", etd: "2026-09-01",
  }, token);
  assert("scratch shipment created (201)", sRes.status === 201);
  const shipmentId = sRes.body.id;
  if (!shipmentId) { assert("have shipmentId", false, "aborting schedule tests"); return; }

  // GET — initially empty
  const listEmpty = await request("GET", `/api/shipments/${shipmentId}/schedules`, null, token);
  assert("GET schedules returns 200",      listEmpty.status === 200);
  assert("initial schedule list is empty", Array.isArray(listEmpty.body) && listEmpty.body.length === 0);

  // POST — save a sailing
  const sailing = {
    carrier: "MAEU", vesselName: "MAERSK ELGIN", voyageNumber: "439E",
    service: "AE-1/Shogun", pol: "CNSHA", pod: "USLAX",
    etd: "2026-09-05", eta: "2026-09-26", transitDays: 21, isMock: true,
  };
  const saveRes = await request("POST", `/api/shipments/${shipmentId}/schedules`, sailing, token);
  assert("POST schedule returns 201",     saveRes.status === 201);
  assert("saved schedule has id",         !!saveRes.body?.id);
  assert("vesselName matches",            saveRes.body?.vesselName === "MAERSK ELGIN");
  assert("voyageNumber matches",          saveRes.body?.voyageNumber === "439E");
  assert("transitDays matches",          saveRes.body?.transitDays === 21);
  assert("isMock is truthy",              saveRes.body?.isMock === true);
  assert("savedBy is present",            !!saveRes.body?.savedBy);
  const scheduleId = saveRes.body?.id;

  // GET — now has one entry
  const listOne = await request("GET", `/api/shipments/${shipmentId}/schedules`, null, token);
  assert("GET schedules returns one row", listOne.body?.length === 1);
  assert("listed entry matches saved",    listOne.body?.[0]?.id === scheduleId);

  // POST — second sailing
  const sailing2 = { ...sailing, vesselName: "EVER GIVEN", voyageNumber: "001W", transitDays: 22, isMock: false };
  const save2 = await request("POST", `/api/shipments/${shipmentId}/schedules`, sailing2, token);
  assert("second POST returns 201",       save2.status === 201);

  const listTwo = await request("GET", `/api/shipments/${shipmentId}/schedules`, null, token);
  assert("GET schedules returns two rows", listTwo.body?.length === 2);

  // DELETE — remove first
  const delRes = await request("DELETE", `/api/shipments/${shipmentId}/schedules/${scheduleId}`, null, token);
  assert("DELETE schedule returns 200",   delRes.status === 200);

  const listAfterDel = await request("GET", `/api/shipments/${shipmentId}/schedules`, null, token);
  assert("one schedule remains after delete", listAfterDel.body?.length === 1);
  assert("remaining schedule is correct",     listAfterDel.body?.[0]?.vesselName === "EVER GIVEN");

  // DELETE — cascade check: deleting shipment removes schedules
  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
  const listAfterShipDel = await request("GET", `/api/shipments/${shipmentId}/schedules`, null, token);
  // Should be 404 (shipment gone) or empty — either is acceptable
  assert("schedules gone after shipment delete",
    listAfterShipDel.status === 404 || listAfterShipDel.body?.length === 0);
}

// ─── Schedules search (mock) ──────────────────────────────────────────────────

async function testScheduleSearch(token) {
  console.log("\nGET /api/schedules/search");

  const res = await request(
    "GET",
    "/api/schedules/search?pol=CNSHA&pod=DEHAM&carrierCode=MAEU&weeks=2",
    null,
    token
  );
  assert("search returns 200",              res.status === 200);
  assert("response has sailings array",     Array.isArray(res.body?.sailings));
  assert("sailings is non-empty",           res.body?.sailings?.length > 0);
  assert("first sailing has vesselName",    !!res.body?.sailings?.[0]?.vesselName);
  assert("first sailing has etd",          !!res.body?.sailings?.[0]?.etd);
  assert("first sailing has transitDays",  typeof res.body?.sailings?.[0]?.transitDays === "number");
  assert("isMock flag present",            typeof res.body?.isMock === "boolean");
}

// ─── GET /api/tickets?shipmentId= ─────────────────────────────────────────────

async function testTicketsShipmentFilter(token) {
  console.log("\nGET /api/tickets?shipmentId=");

  // Create a shipment and a ticket linked to it
  const sRes = await request("POST", "/api/shipments", {
    pol: "DEHAM", pod: "SGSIN", carrierCode: "CMDU",
    status: "Active", contractType: "SPOT", etd: "2026-10-01",
  }, token);
  const shipmentId = sRes.body?.id;
  assert("shipment created for ticket test", !!shipmentId);
  if (!shipmentId) return;

  const tRes = await request("POST", "/api/tickets", {
    title: "Test ticket linked to shipment",
    type: "Task", priority: "Medium", status: "Ready",
    shipmentId,
  }, token);
  assert("linked ticket created (201)",     tRes.status === 201);
  const ticketId = tRes.body?.id;

  // Filter by shipmentId
  const filtered = await request("GET", `/api/tickets?shipmentId=${shipmentId}`, null, token);
  assert("filtered GET returns 200",        filtered.status === 200);
  assert("returns array",                   Array.isArray(filtered.body));
  assert("only linked ticket returned",     filtered.body?.length === 1, `got ${filtered.body?.length}`);
  assert("ticket id matches",               filtered.body?.[0]?.id === ticketId);
  assert("shipmentId matches on ticket",    filtered.body?.[0]?.shipmentId === shipmentId);

  // Unlinked shipment returns empty
  const unlinked = await request("GET", "/api/tickets?shipmentId=SHP-DOESNOTEXIST", null, token);
  assert("unknown shipmentId returns []",   Array.isArray(unlinked.body) && unlinked.body.length === 0);

  // Cleanup
  await request("DELETE", `/api/tickets/${ticketId}`, null, token);
  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
}

// ─── Transit days seeded ──────────────────────────────────────────────────────

async function testTransitDaysSeeded(token) {
  console.log("\nGET /api/trade-lanes — transit days seeded");

  const res = await request("GET", "/api/trade-lanes", null, token);
  assert("trade-lanes returns 200", res.status === 200);
  const lanes = res.body;
  const byCode = Object.fromEntries((lanes || []).map(l => [l.code, l]));

  const EXPECTED = { FE: 28, ME: 18, NAM: 21, OCE: 35, FE: 28, SAM: 25 };
  for (const [code, days] of Object.entries(EXPECTED)) {
    assert(`${code} transit_days = ${days}`, byCode[code]?.transitDays === days,
      `got ${byCode[code]?.transitDays}`);
  }

  const zeroes = lanes?.filter(l => !l.transitDays) || [];
  assert("no lanes still at 0", zeroes.length === 0,
    `${zeroes.map(l => l.code).join(", ")} still at 0`);
}

// ─── Health version ───────────────────────────────────────────────────────────

async function testHealthVersion(token) {
  console.log("\nGET /api/health — version");

  const res = await request("GET", "/api/health", null, token);
  assert("health returns 200",                res.status === 200);
  assert("version is not hardcoded 0.22.0",   res.body?.version !== "0.22.0",
    `got ${res.body?.version}`);
  assert("version is a semver string",        /^\d+\.\d+\.\d+$/.test(res.body?.version || ""),
    `got ${res.body?.version}`);
  assert("status is ok",                      res.body?.status === "ok");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    await testShipmentSchedules(token);
    await testScheduleSearch(token);
    await testTicketsShipmentFilter(token);
    await testTransitDaysSeeded(token);
    await testHealthVersion(token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
