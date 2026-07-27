/**
 * v0.37.0 Smoke tests — Schedule Catalog (Test Tools > Schedule Generator)
 *
 * Usage:
 *   node tests/schedule-catalog.test.js
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
    status: "Active", contractType: "SPOT",
  }, token);
  return res.body.id;
}

async function realVesselImo(token) {
  const res = await request("GET", "/api/vessels/search?q=a", null, token);
  return Array.isArray(res.body) && res.body[0] ? res.body[0].imo : null;
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    const vesselImo = await realVesselImo(token);
    assert("found a real vessel IMO to test with", !!vesselImo, "no vessels in registry?");

    const shipA = await scratchShipment(token);
    const shipB = await scratchShipment(token);
    const shipC = await scratchShipment(token);
    assert("3 scratch shipments created", !!shipA && !!shipB && !!shipC);

    console.log("\nPOST /api/schedules — create + initial link to 2 shipments");
    const create = await request("POST", "/api/schedules", {
      carrier: "MAEU", vesselImo, vesselName: "TEST VESSEL", voyageNumber: "245W", service: "TEST SVC",
      pol: "NLRTM", pod: "USNYC", etd: "2026-09-01", atd: "2026-09-02", eta: "2026-09-20", ata: "",
      initialShipmentIds: [shipA, shipB],
    }, token);
    assert("create returns 201", create.status === 201, JSON.stringify(create.body));
    assert("vesselImo round-trips", create.body.vesselImo === vesselImo);
    assert("atd round-trips", create.body.atd === "2026-09-02");
    assert("ata round-trips (empty)", create.body.ata === "");
    assert("source is 'generated'", create.body.source === "generated");
    assert("linkedShipmentCount is 2", create.body.linkedShipmentCount === 2);
    const scheduleId = create.body.id;
    assert("schedule id has SCHED- prefix", scheduleId.startsWith("SCHED-"));

    console.log("\nGET /api/schedules/:id/linked-shipments");
    const linked1 = await request("GET", `/api/schedules/${scheduleId}/linked-shipments`, null, token);
    assert("linked-shipments returns 200", linked1.status === 200);
    assert("owner is shipA", linked1.body.owner?.id === shipA);
    assert("1 additional linked shipment", linked1.body.linked.length === 1);
    assert("linked shipment is shipB", linked1.body.linked[0]?.id === shipB);

    console.log("\nPOST /api/schedules/:id/link — add a 3rd shipment");
    const link3 = await request("POST", `/api/schedules/${scheduleId}/link`, { shipmentId: shipC }, token);
    assert("link returns 201", link3.status === 201);
    const linked2 = await request("GET", `/api/schedules/${scheduleId}/linked-shipments`, null, token);
    assert("now 2 additional linked shipments", linked2.body.linked.length === 2);

    console.log("\nDuplicate link / owner edge cases");
    const linkDup = await request("POST", `/api/schedules/${scheduleId}/link`, { shipmentId: shipC }, token);
    assert("re-linking the same shipment returns 409", linkDup.status === 409);
    const linkOwner = await request("POST", `/api/schedules/${scheduleId}/link`, { shipmentId: shipA }, token);
    assert("linking the owner again returns 409", linkOwner.status === 409);

    console.log("\nDELETE /api/schedules/:id/link/:shipmentId");
    const unlinkC = await request("DELETE", `/api/schedules/${scheduleId}/link/${shipC}`, null, token);
    assert("unlink returns 200", unlinkC.status === 200);
    const linked3 = await request("GET", `/api/schedules/${scheduleId}/linked-shipments`, null, token);
    assert("back to 1 additional linked shipment", linked3.body.linked.length === 1);
    const unlinkOwner = await request("DELETE", `/api/schedules/${scheduleId}/link/${shipA}`, null, token);
    assert("unlinking the owner returns 400", unlinkOwner.status === 400);

    console.log("\nGET /api/schedules — catalog list");
    const catalog = await request("GET", "/api/schedules?source=generated", null, token);
    assert("catalog list returns 200", catalog.status === 200);
    const found = catalog.body.find(s => s.id === scheduleId);
    assert("catalog includes the generated schedule", !!found);
    assert("catalog row shows linkedShipmentCount 2", found?.linkedShipmentCount === 2);

    console.log("\nSEA leg sync — owner and linked shipment both picked up the sailing");
    const legsA = await request("GET", `/api/shipments/${shipA}/legs`, null, token);
    const legsB = await request("GET", `/api/shipments/${shipB}/legs`, null, token);
    const seaLegA = legsA.body.find(l => l.legType === "SEA");
    const seaLegB = legsB.body.find(l => l.legType === "SEA");
    assert("owner shipment got a SEA leg created", !!seaLegA);
    assert("owner's SEA leg has the right vessel IMO", seaLegA?.vesselImo === vesselImo);
    assert("owner's SEA leg has the right voyage", seaLegA?.voyage === "245W");
    assert("linked shipment got a SEA leg created too", !!seaLegB);
    assert("linked shipment's SEA leg has the right vessel IMO", seaLegB?.vesselImo === vesselImo);

    console.log("\nValidation — unresolvable references");
    const badVessel = await request("POST", "/api/schedules", {
      carrier: "MAEU", vesselImo: "0000000", pol: "NLRTM", pod: "USNYC", initialShipmentIds: [shipA],
    }, token);
    assert("unknown vessel IMO returns 400", badVessel.status === 400);
    const badCarrier = await request("POST", "/api/schedules", {
      carrier: "ZZZZ", pol: "NLRTM", pod: "USNYC", initialShipmentIds: [shipA],
    }, token);
    assert("unknown carrier code returns 400", badCarrier.status === 400);
    const badPort = await request("POST", "/api/schedules", {
      carrier: "MAEU", pol: "ZZZZZ", pod: "USNYC", initialShipmentIds: [shipA],
    }, token);
    assert("unknown POL returns 400", badPort.status === 400);
    const noShipments = await request("POST", "/api/schedules", {
      carrier: "MAEU", pol: "NLRTM", pod: "USNYC", initialShipmentIds: [],
    }, token);
    assert("empty initialShipmentIds returns 400", noShipments.status === 400);

    // Cleanup — cascades to the schedule (ON DELETE CASCADE) and its links
    await request("DELETE", `/api/shipments/${shipA}`, null, token);
    await request("DELETE", `/api/shipments/${shipB}`, null, token);
    await request("DELETE", `/api/shipments/${shipC}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
