/**
 * Merchant's Haulage Details (Pickup/Delivery, Merchant's Haulage only) — direct request:
 * gate in/out, an ordered waypoints list (location type + GPS coordinates), driver name/ID,
 * free-text instructions, and a cost field that automatically creates/keeps in sync a BUY
 * shipment_cost_lines row (source: 'merchant_haulage', chargeCode: 'Haulage').
 *
 * Reuses tests/pickup-service.test.js's exact scratch-shipment-with-a-Merchant's-Haulage-
 * Pick-up-leg scaffolding rather than building a new fixture from scratch.
 *
 * Usage:
 *   node tests/merchant-haulage.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: 3001, path,
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
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost", password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch shipment + Merchant's Haulage Pick-up leg + container + Pickup service");
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    }, token);
    const shipmentId = ship.body.id;
    await request("POST", `/api/shipments/${shipmentId}/legs`, {
      legType: "Pick-up", movementType: "Merchant's Haulage", pol: "NLAMS", pod: "NLRTM", etd: "2026-09-01",
    }, token);
    const ctr = await request("POST", "/api/containers", { shipmentId, size: "40", type: "HC" }, token);
    const containerId = ctr.body.id;
    const svc = await request("POST", `/api/shipments/${shipmentId}/services`, {
      side: "Export", serviceType: "Pickup", vendorName: "Test Trucking Co",
    }, token);
    const serviceId = svc.body.id;
    assert("scratch fixture created", !!shipmentId && !!containerId && !!serviceId);

    console.log("\nGET haulage list — default LEFT-JOIN row shape, no record created yet");
    const listBefore = await request("GET", `/api/shipments/${shipmentId}/services/${serviceId}/haulage`, null, token);
    assert("returns 200", listBefore.status === 200);
    assert("one row per current container", Array.isArray(listBefore.body) && listBefore.body.length === 1);
    assert("blank record fields before anything is entered", listBefore.body[0].gateInAt === "" && listBefore.body[0].costAmount === null);

    console.log("\nPUT plain fields — gate in/out, driver name/ID, instructions");
    const putRes = await request("PUT", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}`, {
      gateInAt: "2026-09-01T08:00", gateOutAt: "2026-09-01T14:30",
      driverName: "Jan de Vries", driverIdNumber: "NL-DL-99887766", instructions: "Call ahead 30 min before arrival",
    }, token);
    assert("PUT returns 200", putRes.status === 200);
    assert("gateInAt round-trips", putRes.body.gateInAt === "2026-09-01T08:00");
    assert("driverName round-trips", putRes.body.driverName === "Jan de Vries");
    assert("instructions round-trips", putRes.body.instructions === "Call ahead 30 min before arrival");

    console.log("\nPATCH cost — creates a real BUY cost line, source: merchant_haulage, chargeCode: Haulage");
    const costCreate = await request("PATCH", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/cost`, {
      amount: 450, currency: "USD", exchangeRate: 1,
    }, token);
    assert("PATCH cost returns 200", costCreate.status === 200);
    assert("costLineId set", !!costCreate.body.costLineId);
    const firstCostLineId = costCreate.body.costLineId;

    const costLinesAfterCreate = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
    const createdLine = costLinesAfterCreate.body.find(l => l.id === firstCostLineId);
    assert("a real BUY cost line exists", !!createdLine && createdLine.type === "BUY");
    assert("source is merchant_haulage", createdLine?.source === "merchant_haulage");
    assert("chargeCode is Haulage", createdLine?.chargeCode === "Haulage");
    assert("amount is 450", createdLine?.amount === 450);
    assert("containerId tagged to the right container", createdLine?.containerId === containerId);

    console.log("\nRe-saving a DIFFERENT amount reuses the SAME cost_line_id — no duplicate line");
    const costUpdate = await request("PATCH", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/cost`, {
      amount: 500, currency: "USD", exchangeRate: 1,
    }, token);
    assert("PATCH cost (update) returns 200", costUpdate.status === 200);
    assert("SAME costLineId reused, not a new one", costUpdate.body.costLineId === firstCostLineId);

    const costLinesAfterUpdate = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
    const haulageLines = costLinesAfterUpdate.body.filter(l => l.source === "merchant_haulage");
    assert("still exactly ONE merchant_haulage cost line (no duplicate)", haulageLines.length === 1);
    assert("its amount reflects the update", haulageLines[0]?.amount === 500);

    console.log("\nClearing the cost value deletes the linked cost line");
    const costClear = await request("PATCH", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/cost`, {
      amount: null, currency: "USD",
    }, token);
    assert("PATCH cost (clear) returns 200", costClear.status === 200);
    assert("costLineId cleared", costClear.body.costLineId === "");
    const costLinesAfterClear = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
    assert("the cost line is actually gone", !costLinesAfterClear.body.some(l => l.id === firstCostLineId));

    console.log("\nA posted line blocks further cost edits (409)");
    const costRecreate = await request("PATCH", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/cost`, {
      amount: 300, currency: "USD",
    }, token);
    const newCostLineId = costRecreate.body.costLineId;
    const postRes = await request("PATCH", `/api/shipments/${shipmentId}/cost-lines/${newCostLineId}/post`, {}, token);
    assert("cost line posted", postRes.status === 200);
    const blockedEdit = await request("PATCH", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/cost`, {
      amount: 999, currency: "USD",
    }, token);
    assert("editing a posted line's cost is blocked with 409", blockedEdit.status === 409);
    const blockedClear = await request("PATCH", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/cost`, {
      amount: null,
    }, token);
    assert("clearing a posted line's cost is also blocked with 409", blockedClear.status === 409);

    console.log("\nWaypoints — add, edit, remove, ordering");
    const wp1 = await request("POST", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/waypoints`, {
      locType: "Door", location: "Shipper warehouse, Amsterdam", notes: "First stop",
    }, token);
    assert("waypoint 1 created (201)", wp1.status === 201);
    assert("sequenceOrder defaults to 1", wp1.body.sequenceOrder === 1);

    const wp2 = await request("POST", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/waypoints`, {
      locType: "Container Yard", location: "APM Terminal Rotterdam",
    }, token);
    assert("waypoint 2 created, auto-incremented sequence", wp2.status === 201 && wp2.body.sequenceOrder === 2);

    const wpList = await request("GET", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/waypoints`, null, token);
    assert("waypoints list returns both, in order", wpList.body.length === 2 && wpList.body[0].id === wp1.body.id);

    const wpUpdate = await request("PUT", `/api/shipments/${shipmentId}/haulage-waypoints/${wp1.body.id}`, {
      locType: "Door", location: "Shipper warehouse, Amsterdam (updated)", sequenceOrder: 1,
    }, token);
    assert("waypoint update returns 200", wpUpdate.status === 200);
    assert("location updated", wpUpdate.body.location === "Shipper warehouse, Amsterdam (updated)");

    console.log("\nGPS-mode waypoint — lat/lng round-trip and range validation");
    const wpGps = await request("POST", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/waypoints`, {
      locType: "GPS Coordinates", latitude: 52.3676, longitude: 4.9041,
    }, token);
    assert("GPS waypoint created", wpGps.status === 201);
    assert("latitude round-trips", wpGps.body.latitude === 52.3676);
    assert("longitude round-trips", wpGps.body.longitude === 4.9041);
    assert("location is blanked in GPS mode", wpGps.body.location === "");

    const wpBadLat = await request("POST", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/waypoints`, {
      locType: "GPS Coordinates", latitude: 200, longitude: 4.9041,
    }, token);
    assert("out-of-range latitude rejected", wpBadLat.status >= 400);
    const wpBadLng = await request("POST", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/waypoints`, {
      locType: "GPS Coordinates", latitude: 52.3676, longitude: -200,
    }, token);
    assert("out-of-range longitude rejected", wpBadLng.status >= 400);

    console.log("\nRemoving a waypoint");
    const wpRemove = await request("DELETE", `/api/shipments/${shipmentId}/haulage-waypoints/${wp2.body.id}`, null, token);
    assert("waypoint removed", wpRemove.status === 200);
    const wpListAfterRemove = await request("GET", `/api/shipments/${shipmentId}/services/${serviceId}/haulage/${containerId}/waypoints`, null, token);
    assert("waypoint list reflects the removal", wpListAfterRemove.body.length === 2); // wp1 (updated) + the GPS one remain

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
