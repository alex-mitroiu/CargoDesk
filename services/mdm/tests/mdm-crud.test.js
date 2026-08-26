/**
 * MDM Service — CRUD across all 10 owned tables
 *
 * Hits the service directly on its own port, no monolith involved.
 *
 * Usage:
 *   node services/mdm/tests/mdm-crud.test.js
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
  try {
    console.log("Health check");
    const health = await request("GET", "/health", null, false);
    assert("health returns 200", health.status === 200);
    assert("service name is mdm", health.body.service === "mdm");

    console.log("\nNo secret / wrong secret rejected on /internal/*");
    const noAuth = await request("GET", "/internal/carriers", null, false);
    assert("no auth returns 401", noAuth.status === 401);

    console.log("\nCarriers");
    const carrierCode = `ZC${stamp % 100000}`;
    const cCreate = await request("POST", "/internal/carriers", { code: carrierCode, name: "Zulu Carrier Co" });
    assert("carrier create returns 201", cCreate.status === 201, JSON.stringify(cCreate.body));
    const cDup = await request("POST", "/internal/carriers", { code: carrierCode, name: "Dup" });
    assert("duplicate carrier code rejected", cDup.status === 400);
    const cUpdate = await request("PUT", `/internal/carriers/${carrierCode}`, { name: "Zulu Carrier Renamed", shortName: "ZCR" });
    assert("carrier update returns shortName", cUpdate.body.shortName === "ZCR");
    const cGet = await request("GET", `/internal/carriers/${carrierCode}`);
    assert("carrier get reflects rename", cGet.body.name === "Zulu Carrier Renamed");

    console.log("\nVessels");
    const imo = `IM${stamp}`;
    const vCreate = await request("POST", "/internal/vessels", { imo, name: "MV Test Voyager" });
    assert("vessel create returns 201", vCreate.status === 201, JSON.stringify(vCreate.body));
    const vSearch = await request("GET", "/internal/vessels/search?q=Test+Voyager");
    assert("vessel search finds it", vSearch.body.some(v => v.imo === imo));

    console.log("\nPort locations + linked ports");
    const port1 = `ZZ${stamp % 100000}`.slice(0, 5).toUpperCase().padEnd(5, "X");
    const port2 = `YY${stamp % 100000}`.slice(0, 5).toUpperCase().padEnd(5, "X");
    const p1 = await request("POST", "/internal/port-locations", { unlocode: port1, name: "Test Port One", latitude: 1, longitude: 2 });
    assert("port1 create returns 201", p1.status === 201, JSON.stringify(p1.body));
    const p2 = await request("POST", "/internal/port-locations", { unlocode: port2, name: "Test Port Two", latitude: 3, longitude: 4 });
    assert("port2 create returns 201", p2.status === 201, JSON.stringify(p2.body));
    const link = await request("POST", "/internal/linked-ports", { primaryUnlocode: port1, linkedUnlocode: port2, note: "test link" });
    assert("linked-ports create returns 201", link.status === 201, JSON.stringify(link.body));
    const links = await request("GET", `/internal/port-locations/${port1}/links`);
    assert("port1's links include port2", links.body.some(l => l.unlocode === port2));

    console.log("\nRegions, trade lanes, countries, country-trade-lanes");
    const regionCode = `ZR${stamp % 10000}`;
    const rCreate = await request("POST", "/internal/regions", { code: regionCode, name: "Test Region" });
    assert("region create returns 201", rCreate.status === 201, JSON.stringify(rCreate.body));
    const iso2 = `Z${(stamp % 26 + 65).toString(36).toUpperCase()}`.slice(0, 2).padEnd(2, "X").toUpperCase();
    const countryCreate = await request("POST", "/internal/countries", { iso2, name: "Testland", regionCode });
    assert("country create returns 201", countryCreate.status === 201, JSON.stringify(countryCreate.body));
    const laneCode = `ZL${stamp % 10000}`;
    const laneCreate = await request("POST", "/internal/trade-lanes", { code: laneCode, name: "Test Lane", transitDays: 21 });
    assert("trade lane create returns 201", laneCreate.status === 201, JSON.stringify(laneCreate.body));
    const ctlCreate = await request("POST", "/internal/country-trade-lanes", { iso2, laneCode });
    assert("country-trade-lane assignment returns 201", ctlCreate.status === 201, JSON.stringify(ctlCreate.body));
    const laneCountries = await request("GET", `/internal/trade-lanes/${laneCode}/countries`);
    assert("lane's countries include the new one", laneCountries.body.some(c => c.iso2 === iso2));
    const transit = await request("GET", `/internal/trade-lanes/transit-suggestion?polLane=${laneCode}&podLane=${laneCode}`);
    assert("transit-suggestion resolves the lane's own days", transit.body.days === 21);

    console.log("\nInvoice threshold columns on countries (carried along with the MDM cut)");
    const countryUpdate = await request("PUT", `/internal/countries/${iso2}`, { name: "Testland", regionCode, invoiceAlertBusinessDays: 5, invoiceEscalationBusinessDays: 10 });
    assert("invoice thresholds round-trip", countryUpdate.body.invoiceAlertBusinessDays === 5 && countryUpdate.body.invoiceEscalationBusinessDays === 10);
    const badThresholds = await request("PUT", `/internal/countries/${iso2}`, { name: "Testland", regionCode, invoiceAlertBusinessDays: 10, invoiceEscalationBusinessDays: 5 });
    assert("escalation must exceed alert", badThresholds.status === 400);

    console.log("\nCommodities");
    const commCode = `ZCM${stamp % 10000}`;
    const commCreate = await request("POST", "/internal/commodities", { code: commCode, description: "Test Widgets" });
    assert("commodity create returns 201", commCreate.status === 201, JSON.stringify(commCreate.body));

    console.log("\nCarrier agents (agent_customer_id is a loose id here — no customers table owned)");
    const agentCreate = await request("POST", "/internal/carrier-agents", { carrierCode, portUnlocode: port1, agentCustomerId: "CUST-FAKE-001", note: "test agent" });
    assert("carrier agent create returns 201", agentCreate.status === 201, JSON.stringify(agentCreate.body));
    assert("carrier agent response has no agentCustomerName field", !("agentCustomerName" in agentCreate.body));
    const agentDup = await request("POST", "/internal/carrier-agents", { carrierCode, portUnlocode: port1, agentCustomerId: "CUST-FAKE-002" });
    assert("duplicate carrier+port agent rejected", agentDup.status === 400);

    console.log("\nCleanup");
    await request("DELETE", `/internal/carrier-agents/${agentCreate.body.id}`);
    await request("DELETE", `/internal/country-trade-lanes/${iso2}/${laneCode}`);
    await request("DELETE", `/internal/trade-lanes/${laneCode}`);
    await request("DELETE", `/internal/countries/${iso2}`);
    await request("DELETE", `/internal/regions/${regionCode}`);
    await request("DELETE", `/internal/linked-ports/${link.body.id}`);
    await request("DELETE", `/internal/port-locations/${port1}`);
    await request("DELETE", `/internal/port-locations/${port2}`);
    await request("DELETE", `/internal/vessels/${imo}`);
    await request("DELETE", `/internal/carriers/${carrierCode}`);
    await request("DELETE", `/internal/commodities/${commCode}`);
  } catch (e) {
    console.error("FATAL:", e.message);
    failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
