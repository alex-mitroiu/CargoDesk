/**
 * SEA legs run terminal to terminal (agreed 2026-11-03)
 *
 * The leg screen used to offer Door / Container Yard / CFS on a SEA leg, and the leg routes stored
 * whatever came in — screenshot 06 showed a SEA leg leaving the CNSHA "Container Yard", which made
 * the routing term CY-PT. Both ends of a SEA leg are now stored as Terminal whatever is sent
 * (routes/shipments.js seaLegLocType); Pick-up and Delivery legs keep their own types; GPS
 * Coordinates on a SEA leg is still refused. Covers create, update, the leg type switching to SEA,
 * and the routing term that follows from it.
 *
 * Usage:
 *   node tests/sea-leg-terminal.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

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

const pickUp = extra => ({ legType: "Pick-up", mot: "ROAD", movementType: "Carrier's Haulage", movementBy: "Truck",
  pol: "CNTAG", pod: "CNSHA", polLocType: "Door", podLocType: "Terminal", ...extra });
const seaLeg = extra => ({ legType: "SEA", mot: "SEA", movementType: "SEA", pol: "CNSHA", pod: "USLAX",
  carrierCode: "HLCU", etd: "2026-11-01", eta: "2026-11-17", ...extra });

(async () => {
  const shipments = [];
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const scratch = async () => {
      const r = await request("POST", "/api/shipments", { pol: "CNSHA", pod: "USLAX", carrierCode: "HLCU",
        status: "Active", contractType: "SPOT", emoOfficeId, imoOfficeId }, token);
      if (r.status !== 201) throw new Error(`Shipment create failed (${r.status}): ${JSON.stringify(r.body)}`);
      shipments.push(r.body.id);
      return r.body.id;
    };
    const shipment = async id => (await request("GET", `/api/shipments/${id}`, null, token)).body;

    console.log("\nCreate: a SEA leg sent with a container yard and a door is stored Terminal to Terminal");
    const s1 = await scratch();
    const pku = await request("POST", `/api/shipments/${s1}/legs`, pickUp(), token);
    assert("pick-up leg created", pku.status === 201, JSON.stringify(pku.body));
    const sea = await request("POST", `/api/shipments/${s1}/legs`, seaLeg({ polLocType: "Container Yard", podLocType: "Door" }), token);
    assert("SEA leg created", sea.status === 201, JSON.stringify(sea.body));
    assert("SEA leg starts at Terminal", sea.body.polLocType === "Terminal", sea.body.polLocType);
    assert("SEA leg ends at Terminal", sea.body.podLocType === "Terminal", sea.body.podLocType);
    assert("pick-up leg keeps its Door", pku.body.polLocType === "Door", pku.body.polLocType);
    assert("routing term runs from the door to the terminal (DR-PT)", (await shipment(s1)).routingTerm === "DR-PT",
      (await shipment(s1)).routingTerm);

    console.log("\nUpdate: changing a SEA leg's end to a CFS stays Terminal");
    const upd = await request("PUT", `/api/shipments/${s1}/legs/${sea.body.id}`, { ...sea.body, podLocType: "CFS" }, token);
    assert("update accepted", upd.status === 200, JSON.stringify(upd.body));
    assert("SEA leg still ends at Terminal", upd.body.podLocType === "Terminal", upd.body.podLocType);

    console.log("\nUpdate: a Pick-up leg turned into a SEA leg loses its door");
    const turned = await request("PUT", `/api/shipments/${s1}/legs/${pku.body.id}`,
      { ...pku.body, legType: "SEA", movementType: "SEA" }, token);
    assert("type change accepted", turned.status === 200, JSON.stringify(turned.body));
    assert("former pick-up now starts at Terminal", turned.body.polLocType === "Terminal", turned.body.polLocType);

    console.log("\nPick-up and Delivery legs keep a container yard");
    const s2 = await scratch();
    const yard = await request("POST", `/api/shipments/${s2}/legs`,
      pickUp({ movementType: "Merchant's Haulage", podLocType: "Container Yard" }), token);
    assert("pick-up to a container yard keeps it", yard.body.podLocType === "Container Yard", yard.body.podLocType);
    await request("POST", `/api/shipments/${s2}/legs`, seaLeg({ polLocType: "Container Yard" }), token);
    const del = await request("POST", `/api/shipments/${s2}/legs`, { legType: "Delivery", mot: "ROAD",
      movementType: "Carrier's Haulage", movementBy: "Truck", pol: "USLAX", pod: "USLGB", polLocType: "Terminal", podLocType: "Container Yard" }, token);
    assert("delivery to a container yard keeps it", del.body.podLocType === "Container Yard", del.body.podLocType);
    // Merchant's haulage pick-up is the customer's, so the carrier's part starts at the SEA leg's terminal.
    assert("routing term PT-CY (merchant's pick-up, carrier delivery to a yard)", (await shipment(s2)).routingTerm === "PT-CY",
      (await shipment(s2)).routingTerm);

    console.log("\nGPS Coordinates on a SEA leg is still refused");
    const gps = await request("POST", `/api/shipments/${s2}/legs`,
      seaLeg({ polLocType: "GPS Coordinates", polLatitude: "31.2", polLongitude: "121.5" }), token);
    assert("refused with 400", gps.status === 400, `${gps.status} ${JSON.stringify(gps.body)}`);

    for (const id of shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
  } catch (e) {
    console.error(e);
    failed++;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
