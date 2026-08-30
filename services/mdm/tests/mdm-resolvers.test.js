/**
 * MDM Service — the 7 new resolver-support routes that don't exist on the monolith's own
 * routes/mdm.js (port-lanes-index, port-country-map, linked-ports/all, carrier-agents/resolve,
 * vessels/upsert, port-coords, mdm/bulk-import). These back the monolith's in-memory caches and
 * the AIS listener's write path in remote mode — see the plan's own cross-cutting decisions.
 *
 * Usage:
 *   node services/mdm/tests/mdm-resolvers.test.js
 *
 * Prerequisites:
 *   - MDM Service running on :3005 (npm run mdm-service)
 */

import http from "node:http";

const PORT = 3005;
const SECRET = process.env.MDM_SERVICE_SECRET || "cargoDesk-dev-mdm-service-secret-do-not-use-in-prod";
let passed = 0;
let failed = 0;

function request(method, path, body, auth = true) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: PORT, path,
      headers: {
        "Content-Type": "application/json",
        ...(auth && { Authorization: `Bearer ${SECRET}` }),
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

(async () => {
  const stamp = Date.now();
  const port1 = `RX${stamp % 100000}`.slice(0, 5).toUpperCase().padEnd(5, "A");
  const port2 = `RY${stamp % 100000}`.slice(0, 5).toUpperCase().padEnd(5, "A");
  const iso2 = "RX";
  const laneCode = `RL${stamp % 10000}`;
  const carrierCode = `RC${stamp % 10000}`;
  let linkId, agentId;
  try {
    console.log("Setup: a linked port pair, a lane-mapped country, and a carrier agent");
    await request("POST", "/internal/port-locations", { unlocode: port1, name: "Resolver Port One", countryCode: iso2 });
    await request("POST", "/internal/port-locations", { unlocode: port2, name: "Resolver Port Two", countryCode: iso2 });
    const link = await request("POST", "/internal/linked-ports", { primaryUnlocode: port1, linkedUnlocode: port2 });
    linkId = link.body.id;
    await request("POST", "/internal/regions", { code: "RXR", name: "Resolver Region" }).catch(() => {});
    await request("POST", "/internal/countries", { iso2, name: "Resolveria", regionCode: "RXR" });
    await request("POST", "/internal/trade-lanes", { code: laneCode, name: "Resolver Lane" });
    await request("POST", "/internal/country-trade-lanes", { iso2, laneCode });
    await request("POST", "/internal/carriers", { code: carrierCode, name: "Resolver Carrier" });
    const agent = await request("POST", "/internal/carrier-agents", { carrierCode, agentCustomerId: "CUST-RESOLVER-1", locationType: "unlocode", unlocode: port1 });
    agentId = agent.body.id;

    console.log("\nGET /internal/port-lanes-index");
    const laneIndex = await request("GET", "/internal/port-lanes-index");
    assert("port-lanes-index returns 200", laneIndex.status === 200);
    assert("index includes port1 -> laneCode", laneIndex.body.some(r => r.unlocode === port1 && r.lane_code === laneCode));

    console.log("\nGET /internal/port-country-map");
    const countryMap = await request("GET", "/internal/port-country-map");
    assert("port-country-map includes port1 -> iso2", countryMap.body.some(r => r.unlocode === port1 && r.country_code === iso2));

    console.log("\nGET /internal/linked-ports/all");
    const allLinks = await request("GET", "/internal/linked-ports/all");
    assert("linked-ports/all includes [port1, port2]", allLinks.body.some(([a, b]) => a === port1 && b === port2));

    console.log("\nGET /internal/carrier-agents/resolve — direct match and linked-port fallback");
    const direct = await request("GET", `/internal/carrier-agents/resolve?carrierCode=${carrierCode}&port=${port1}`);
    assert("direct resolve finds the agent", direct.body?.agentCustomerId === "CUST-RESOLVER-1");
    const viaLink = await request("GET", `/internal/carrier-agents/resolve?carrierCode=${carrierCode}&port=${port2}`);
    assert("linked-port fallback finds the same agent from port2", viaLink.body?.agentCustomerId === "CUST-RESOLVER-1");
    const noMatch = await request("GET", `/internal/carrier-agents/resolve?carrierCode=NOPE&port=${port1}`);
    assert("no match returns null", noMatch.body === null);

    console.log("\nPOST /internal/vessels/upsert — insert, quiet refresh, and logged rename");
    const imo = `RIMO${stamp}`;
    const insertRes = await request("POST", "/internal/vessels/upsert", { imo, name: "Resolver Vessel", mmsi: "111111111" });
    assert("first upsert is not a rename", insertRes.body.renamed === false);
    const refreshRes = await request("POST", "/internal/vessels/upsert", { imo, name: "Resolver Vessel", mmsi: "222222222" });
    assert("same-name upsert is a quiet refresh, not a rename", refreshRes.body.renamed === false);
    const vAfterRefresh = await request("GET", `/internal/vessels/${imo}`);
    assert("mmsi actually updated on refresh", vAfterRefresh.body.mmsi === "222222222");
    const renameRes = await request("POST", "/internal/vessels/upsert", { imo, name: "Resolver Vessel Renamed", mmsi: "222222222" });
    assert("different-name upsert reports a rename", renameRes.body.renamed === true && renameRes.body.previousName === "Resolver Vessel");

    console.log("\nGET /internal/port-coords");
    const coords = await request("GET", "/internal/port-coords");
    assert("port-coords includes port1", coords.body.some(r => r.unlocode === port1));

    console.log("\nPOST /internal/mdm/bulk-import — idempotent via INSERT OR IGNORE");
    const bulkCode = `RB${stamp % 10000}`;
    const bulk1 = await request("POST", "/internal/mdm/bulk-import", { carriers: [{ code: bulkCode, name: "Bulk Carrier", short_name: "" }] });
    assert("bulk-import returns 201", bulk1.status === 201, JSON.stringify(bulk1.body));
    assert("first bulk-import inserts 1 carrier", bulk1.body.carriers === 1);
    const bulk2 = await request("POST", "/internal/mdm/bulk-import", { carriers: [{ code: bulkCode, name: "Bulk Carrier", short_name: "" }] });
    assert("re-running bulk-import is idempotent (0 new inserts)", bulk2.body.carriers === 0);

    console.log("\nCleanup");
    await request("DELETE", `/internal/carriers/${bulkCode}`);
    await request("DELETE", `/internal/vessels/${imo}`);
    await request("DELETE", `/internal/carrier-agents/${agentId}`);
    await request("DELETE", `/internal/carriers/${carrierCode}`);
    await request("DELETE", `/internal/country-trade-lanes/${iso2}/${laneCode}`);
    await request("DELETE", `/internal/trade-lanes/${laneCode}`);
    await request("DELETE", `/internal/countries/${iso2}`);
    await request("DELETE", "/internal/regions/RXR");
    await request("DELETE", `/internal/linked-ports/${linkId}`);
    await request("DELETE", `/internal/port-locations/${port1}`);
    await request("DELETE", `/internal/port-locations/${port2}`);
  } catch (e) {
    console.error("FATAL:", e.message);
    failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
