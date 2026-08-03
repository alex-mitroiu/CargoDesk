/**
 * Schedule Catalog (Test Tools > Schedule Generator) — decoupled from shipments
 *
 * A generated schedule is now a pure, ownerless "template" (shipment_id nullable) — creation
 * no longer requires linking any shipment. Assignment happens exclusively via the everyday
 * Add-Sailing search/commit flow copying a template into a shipment-owned row (templateId
 * provenance), not manual linking — the old link/unlink routes are gone.
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

    console.log("\nPOST /api/schedules — create with NO shipments (ownerless template)");
    const create = await request("POST", "/api/schedules", {
      carrier: "MAEU", vesselImo, vesselName: "TEST VESSEL", voyageNumber: "245W", service: "TEST SVC",
      pol: "NLRTM", pod: "USNYC", etd: "2026-09-01", atd: "2026-09-02", eta: "2026-09-20", ata: "",
    }, token);
    assert("create returns 201 with no shipments", create.status === 201, JSON.stringify(create.body));
    assert("shipmentId is null", create.body.shipmentId === null);
    assert("vesselImo round-trips", create.body.vesselImo === vesselImo);
    assert("atd round-trips", create.body.atd === "2026-09-02");
    assert("source is 'generated'", create.body.source === "generated");
    assert("legs is null (direct sailing)", create.body.legs === null);
    const scheduleId = create.body.id;
    assert("schedule id has SCHED- prefix", scheduleId.startsWith("SCHED-"));

    console.log("\nPOST /api/schedules — create a real TSP (multi-leg) template");
    const legs = [
      { pol: "NLRTM", pod: "SGSIN", etd: "2026-09-01", eta: "2026-09-18", vesselName: "LEG1 VESSEL", vesselImo: "9123456", voyageNumber: "V1W", service: "LOOPX", carrier: "MSCU" },
      { pol: "SGSIN", pod: "AUMEL", etd: "2026-09-19", eta: "2026-10-02", vesselName: "LEG2 VESSEL", voyageNumber: "V2E", service: "LOOPX", carrier: "CMDU" },
    ];
    const tspCreate = await request("POST", "/api/schedules", {
      carrier: "MAEU", pol: "NLRTM", pod: "AUMEL", legs,
    }, token);
    assert("TSP create returns 201", tspCreate.status === 201, JSON.stringify(tspCreate.body));
    assert("2 legs round-trip", tspCreate.body.legs?.length === 2, JSON.stringify(tspCreate.body.legs));
    assert("summary pol derived from leg 1", tspCreate.body.pol === "NLRTM");
    assert("summary pod derived from leg 2", tspCreate.body.pod === "AUMEL");
    assert("summary vessel derived from leg 1", tspCreate.body.vesselName === "LEG1 VESSEL");
    assert("summary etd derived from leg 1", tspCreate.body.etd === "2026-09-01");
    assert("summary eta derived from leg 2", tspCreate.body.eta === "2026-10-02");
    assert("summary carrier derived from leg 1 (overrides the top-level 'MAEU')", tspCreate.body.carrier === "MSCU", tspCreate.body.carrier);
    assert("leg 1 carrier round-trips", tspCreate.body.legs[0].carrier === "MSCU");
    assert("leg 2 carrier round-trips independently", tspCreate.body.legs[1].carrier === "CMDU");
    assert("leg 1 vesselImo round-trips", tspCreate.body.legs[0].vesselImo === "9123456");
    const tspScheduleId = tspCreate.body.id;

    console.log("\nA single-entry legs array behaves as a direct sailing (no schedule_legs rows)");
    const singleLegCreate = await request("POST", "/api/schedules", {
      carrier: "MAEU", vesselName: "SOLO VESSEL", pol: "NLRTM", pod: "USNYC", etd: "2026-09-05",
      legs: [{ pol: "NLRTM", pod: "USNYC", etd: "2026-09-05", eta: "2026-09-20", vesselName: "SOLO VESSEL" }],
    }, token);
    assert("single-leg create returns 201", singleLegCreate.status === 201);
    assert("legs is null for a single-entry array", singleLegCreate.body.legs === null);

    console.log("\nGET /api/schedules — catalog list shows usedByCount (0 so far)");
    const catalog = await request("GET", "/api/schedules?source=generated", null, token);
    assert("catalog list returns 200", catalog.status === 200);
    const found = catalog.body.find(s => s.id === scheduleId);
    assert("catalog includes the template", !!found);
    assert("usedByCount is 0 (nothing has copied it yet)", found?.usedByCount === 0);

    console.log("\nGET /api/schedules/:id/usage — empty before any shipment picks it up");
    const usageEmpty = await request("GET", `/api/schedules/${scheduleId}/usage`, null, token);
    assert("usage returns 200", usageEmpty.status === 200);
    assert("usedBy is empty", Array.isArray(usageEmpty.body.usedBy) && usageEmpty.body.usedBy.length === 0);

    console.log("\nOld link/unlink routes are gone");
    const oldLink = await request("POST", `/api/schedules/${scheduleId}/link`, { shipmentId: "SHP-X" }, token);
    assert("POST .../link no longer registered (404)", oldLink.status === 404, JSON.stringify(oldLink.body));
    const oldUnlink = await request("DELETE", `/api/schedules/${scheduleId}/link/SHP-X`, null, token);
    assert("DELETE .../link/:shipmentId no longer registered (404)", oldUnlink.status === 404);
    const oldLinkedShipments = await request("GET", `/api/schedules/${scheduleId}/linked-shipments`, null, token);
    assert("GET .../linked-shipments no longer registered (404)", oldLinkedShipments.status === 404);

    console.log("\nA shipment picking the template via the everyday save route records templateId");
    const shipA = await scratchShipment(token);
    const saved = await request("POST", `/api/shipments/${shipA}/schedules`, {
      carrier: "MAEU", vesselName: "TEST VESSEL", voyageNumber: "245W", pol: "NLRTM", pod: "USNYC",
      etd: "2026-09-01", eta: "2026-09-20", templateId: scheduleId,
    }, token);
    assert("save returns 201", saved.status === 201, JSON.stringify(saved.body));
    assert("templateId round-trips on the shipment-owned row", saved.body.templateId === scheduleId);
    assert("this row still has its own shipmentId (unchanged everyday-save behavior)", saved.body.shipmentId === shipA);

    console.log("\nUsage view now reflects the copy");
    const usageAfter = await request("GET", `/api/schedules/${scheduleId}/usage`, null, token);
    assert("usedBy now has 1 entry", usageAfter.body.usedBy.length === 1, JSON.stringify(usageAfter.body));
    assert("usedBy entry is shipA", usageAfter.body.usedBy[0]?.id === shipA);
    const catalogAfter = await request("GET", "/api/schedules?source=generated", null, token);
    const foundAfter = catalogAfter.body.find(s => s.id === scheduleId);
    assert("usedByCount is now 1", foundAfter?.usedByCount === 1);

    console.log("\nValidation — unresolvable references (no shipment requirement anymore)");
    const badVessel = await request("POST", "/api/schedules", {
      carrier: "MAEU", vesselImo: "0000000", pol: "NLRTM", pod: "USNYC",
    }, token);
    assert("unknown vessel IMO returns 400", badVessel.status === 400);
    const badCarrier = await request("POST", "/api/schedules", {
      carrier: "ZZZZ", pol: "NLRTM", pod: "USNYC",
    }, token);
    assert("unknown carrier code returns 400", badCarrier.status === 400);
    const badPort = await request("POST", "/api/schedules", {
      carrier: "MAEU", pol: "ZZZZZ", pod: "USNYC",
    }, token);
    assert("unknown POL returns 400", badPort.status === 400);
    const noFields = await request("POST", "/api/schedules", {}, token);
    assert("a fully empty body is still accepted (everything optional now)", noFields.status === 201, JSON.stringify(noFields.body));

    console.log("\nGET /api/schedules/search — catalog match takes priority over demo data");
    const searchPol = "AEDXB", searchPod = "BRSSZ"; // an unusual pair, unlikely to collide with other data
    const searchEtd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // +3 days
    const searchTemplate = await request("POST", "/api/schedules", {
      carrier: "MAEU", vesselName: "SEARCH TEST VESSEL", voyageNumber: "SRCH1",
      pol: searchPol, pod: searchPod, etd: searchEtd, eta: "",
    }, token);
    assert("search-fixture template created", searchTemplate.status === 201);

    const searchHit = await request("GET", `/api/schedules/search?pol=${searchPol}&pod=${searchPod}&weeks=4`, null, token);
    assert("search returns 200", searchHit.status === 200);
    assert("catalogCount is at least 1", (searchHit.body.catalogCount || 0) >= 1, JSON.stringify(searchHit.body));
    const catalogHit = searchHit.body.sailings.find(s => s.scheduleId === searchTemplate.body.id);
    assert("the fixture template is in the results, tagged source:catalog", catalogHit?.source === "catalog", JSON.stringify(searchHit.body.sailings));
    assert("isMock is false when a catalog match exists", searchHit.body.isMock === false);

    console.log("\nRegression: a stale mock-derived shipment_schedules row must NOT surface as a catalog match");
    // Before catalog search existed, picking ANY sailing (including a synthetic demo one) via
    // Add Sailing always inserted a shipment_schedules row (POST /api/shipments/:id/schedules).
    // Confirmed live on a real shipment (SHP-W942AJ): old is_mock=1 rows were resurfacing here,
    // mislabeled source:catalog — this is the direct regression test for that fix.
    const staleShip = await scratchShipment(token);
    const stalePol = "AEDXB", stalePod = "NZWLG";
    const staleEtd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const staleRow = await request("POST", `/api/shipments/${staleShip}/schedules`, {
      carrier: "MAEU", vesselName: "DEMO STALE", voyageNumber: "DM999W",
      pol: stalePol, pod: stalePod, etd: staleEtd, eta: "", isMock: true,
    }, token);
    assert("stale mock row created", staleRow.status === 201);
    const staleSearch = await request("GET", `/api/schedules/search?pol=${stalePol}&pod=${stalePod}&weeks=4`, null, token);
    assert("catalogCount is 0 — the mock row is excluded", staleSearch.body.catalogCount === 0, JSON.stringify(staleSearch.body));
    assert("no result references the stale row's schedule id", !staleSearch.body.sailings.some(s => s.scheduleId === staleRow.body.id));
    await request("DELETE", `/api/shipments/${staleShip}`, null, token);

    console.log("\nToggle off demo schedules — a route/window with no real match returns empty");
    await request("PUT", "/api/settings", { demo_schedules_enabled: "false" }, token);
    const noMatchPol = "AEDXB", noMatchPod = "NZAKL"; // a pair with no fixture and (almost certainly) no live Maersk coverage
    const emptySearch = await request("GET", `/api/schedules/search?pol=${noMatchPol}&pod=${noMatchPod}&weeks=2`, null, token);
    assert("search returns 200 even with zero results", emptySearch.status === 200);
    assert("sailings is empty with demo disabled and no real match", emptySearch.body.sailings.length === 0, JSON.stringify(emptySearch.body));
    assert("isMock is false (nothing was synthesized)", emptySearch.body.isMock === false);

    console.log("\nToggle demo schedules back on — the same search now falls back to demo data");
    await request("PUT", "/api/settings", { demo_schedules_enabled: "true" }, token);
    const demoSearch = await request("GET", `/api/schedules/search?pol=${noMatchPol}&pod=${noMatchPod}&weeks=2`, null, token);
    assert("sailings is non-empty with demo enabled", demoSearch.body.sailings.length > 0);
    assert("isMock is true (demo fallback used)", demoSearch.body.isMock === true);
    assert("every result is tagged source:mock", demoSearch.body.sailings.every(s => s.source === "mock"));

    await request("DELETE", `/api/schedules/${searchTemplate.body.id}`, null, token);

    console.log("\nDELETE /api/schedules/:id — removing a template");
    const delTemplate = await request("DELETE", `/api/schedules/${scheduleId}`, null, token);
    assert("delete returns 200", delTemplate.status === 200);
    const afterDelete = await request("GET", "/api/schedules?source=generated", null, token);
    assert("deleted template no longer in catalog list", !afterDelete.body.find(s => s.id === scheduleId));
    const shipAAfterDelete = await request("GET", `/api/shipments/${shipA}/schedules`, null, token);
    const savedRowAfterDelete = shipAAfterDelete.body.find(x => x.id === saved.body.id);
    assert("shipment's own copied row survives template deletion", !!savedRowAfterDelete);
    assert("its templateId is cleared (ON DELETE SET NULL)", savedRowAfterDelete?.templateId === null);

    // Cleanup
    await request("DELETE", `/api/shipments/${shipA}`, null, token);
    await request("DELETE", `/api/schedules/${tspScheduleId}`, null, token);
    await request("DELETE", `/api/schedules/${singleLegCreate.body.id}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
