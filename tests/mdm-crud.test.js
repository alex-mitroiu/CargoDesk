/**
 * MDM reference-data CRUD (routes/mdm.js) — smoke tests
 *
 * Covers Carriers, Vessels (+search), Port Locations (+links/lanes), Linked Ports, Trade
 * Lanes (+country assignment, +transit-suggestion), Country Trade Lanes, Regions, Countries
 * (+locations), UN Locodes, and Commodities (+search) — the CRUD surface behind every Master
 * Data page. Carrier Agents already has its own dedicated suite (tests/carrier-agents.test.js)
 * and is not duplicated here. Previously only incidentally exercised (a test elsewhere reading
 * seeded MDM rows), never a direct CRUD pass of its own.
 *
 * Usage:
 *   node tests/mdm-crud.test.js
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

    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();

    console.log("\nCarriers — create, get, list, update, duplicate rejection, delete");
    const carCode = `Z${rand}`;
    const carCreate = await request("POST", "/api/carriers", { code: carCode, name: "Zed Test Line", shortName: "ZTL" }, token);
    assert("carrier created", carCreate.status === 201, JSON.stringify(carCreate.body));
    assert("carrier code uppercased", carCreate.body.code === carCode);
    const carMissing = await request("POST", "/api/carriers", { code: "" }, token);
    assert("carrier missing fields rejected", carMissing.status >= 400);
    const carDup = await request("POST", "/api/carriers", { code: carCode, name: "Dup" }, token);
    assert("duplicate carrier code rejected", carDup.status >= 400 && /already exists/i.test(carDup.body.error || ""));
    const carGet = await request("GET", `/api/carriers/${carCode}`, null, token);
    assert("carrier get returns 200", carGet.status === 200);
    const carGet404 = await request("GET", "/api/carriers/ZZZNOPE", null, token);
    assert("carrier get 404 for unknown code", carGet404.status === 404);
    const carList = await request("GET", "/api/carriers", null, token);
    assert("carrier list includes ours", carList.body.some(c => c.code === carCode));
    const carUpdate = await request("PUT", `/api/carriers/${carCode}`, { name: "Zed Renamed Line", shortName: "ZRL" }, token);
    assert("carrier update returns 200", carUpdate.status === 200 && carUpdate.body.name === "Zed Renamed Line");
    const carUpdate404 = await request("PUT", "/api/carriers/ZZZNOPE", { name: "X" }, token);
    assert("carrier update 404 for unknown code", carUpdate404.status === 404);
    const carNoAuth = await request("POST", "/api/carriers", { code: "X", name: "X" }, null);
    assert("carrier create without a token rejected", carNoAuth.status === 401);

    console.log("\nVessels — create, get, search, list w/ pagination, update, delete");
    const vesselImo = `9${rand}1`;
    const vCreate = await request("POST", "/api/vessels", { imo: vesselImo, name: "MV Test Voyager", assetType: "Container Ship", flagIso2: "NL", buildYear: 2020, grossTonnage: 50000 }, token);
    assert("vessel created", vCreate.status === 201, JSON.stringify(vCreate.body));
    const vMissing = await request("POST", "/api/vessels", { imo: "" }, token);
    assert("vessel missing fields rejected", vMissing.status >= 400);
    const vDup = await request("POST", "/api/vessels", { imo: vesselImo, name: "Dup" }, token);
    assert("duplicate vessel IMO rejected", vDup.status >= 400);
    const vGet = await request("GET", `/api/vessels/${vesselImo}`, null, token);
    assert("vessel get returns 200", vGet.status === 200 && vGet.body.name === "MV Test Voyager");
    const vGet404 = await request("GET", "/api/vessels/0000000", null, token);
    assert("vessel get 404 for unknown IMO", vGet404.status === 404);
    const vSearch = await request("GET", `/api/vessels/search?q=Test%20Voyager`, null, token);
    assert("vessel search finds it", vSearch.body.some(v => v.imo === vesselImo));
    const vSearchEmpty = await request("GET", "/api/vessels/search?q=", null, token);
    assert("vessel search with no query returns empty array", Array.isArray(vSearchEmpty.body) && vSearchEmpty.body.length === 0);
    const vList = await request("GET", "/api/vessels?search=Test%20Voyager&limit=5&offset=0", null, token);
    assert("vessel list returns results/total/limit/offset shape", "results" in vList.body && "total" in vList.body);
    assert("vessel list finds ours via search", vList.body.results.some(v => v.imo === vesselImo));
    const vUpdate = await request("PUT", `/api/vessels/${vesselImo}`, { name: "MV Renamed Voyager", assetType: "Container Ship" }, token);
    assert("vessel update returns 200", vUpdate.status === 200 && vUpdate.body.name === "MV Renamed Voyager");
    const vUpdate404 = await request("PUT", "/api/vessels/0000000", { name: "X" }, token);
    assert("vessel update 404 for unknown IMO", vUpdate404.status === 404);
    const vDelete = await request("DELETE", `/api/vessels/${vesselImo}`, null, token);
    assert("vessel delete returns 200", vDelete.status === 200);
    const vDelete404 = await request("DELETE", `/api/vessels/${vesselImo}`, null, token);
    assert("vessel delete 404 on second attempt", vDelete404.status === 404);

    console.log("\nPort Locations — create, get, links, lanes, list w/ country filter, update, delete");
    const portCode = `Z${rand.slice(0,3)}A`;
    const pCreate = await request("POST", "/api/port-locations", { unlocode: portCode, name: "Zedport Test", latitude: 51.9, longitude: 4.5, countryCode: "NL" }, token);
    assert("port location created", pCreate.status === 201, JSON.stringify(pCreate.body));
    const pMissing = await request("POST", "/api/port-locations", { unlocode: "" }, token);
    assert("port location missing fields rejected", pMissing.status >= 400);
    const pDup = await request("POST", "/api/port-locations", { unlocode: portCode, name: "Dup" }, token);
    assert("duplicate port location rejected", pDup.status >= 400);
    const pGet = await request("GET", `/api/port-locations/${portCode}`, null, token);
    assert("port location get returns 200", pGet.status === 200);
    const pGet404 = await request("GET", "/api/port-locations/ZZNOPE", null, token);
    assert("port location get 404 for unknown code", pGet404.status === 404);
    const pLinks = await request("GET", `/api/port-locations/${portCode}/links`, null, token);
    assert("port location links returns an empty array (no links yet)", Array.isArray(pLinks.body) && pLinks.body.length === 0);
    const pLanes = await request("GET", `/api/port-locations/${portCode}/lanes`, null, token);
    assert("port location lanes returns lanes/primary shape", "lanes" in pLanes.body && "primary" in pLanes.body);
    const pLanesUnknown = await request("GET", "/api/port-locations/ZZNOPE/lanes", null, token);
    assert("port location lanes for an unknown port returns empty, not an error", pLanesUnknown.status === 200 && pLanesUnknown.body.lanes.length === 0);
    const pList = await request("GET", `/api/port-locations?search=Zedport&country=NL&limit=5`, null, token);
    assert("port location list finds ours via search+country filter", pList.body.results.some(p => p.unlocode === portCode));
    const pUpdate = await request("PUT", `/api/port-locations/${portCode}`, { name: "Zedport Renamed", latitude: 52, longitude: 4.6, countryCode: "NL" }, token);
    assert("port location update returns 200", pUpdate.status === 200 && pUpdate.body.name === "Zedport Renamed");
    const pUpdate404 = await request("PUT", "/api/port-locations/ZZNOPE", { name: "X" }, token);
    assert("port location update 404 for unknown code", pUpdate404.status === 404);

    console.log("\nLinked Ports — create, self-link rejection, update note, delete, list reflects the link on /links");
    const portCode2 = `Z${rand.slice(0,3)}B`;
    await request("POST", "/api/port-locations", { unlocode: portCode2, name: "Zedport Two", countryCode: "NL" }, token);
    const selfLink = await request("POST", "/api/linked-ports", { primaryUnlocode: portCode, linkedUnlocode: portCode }, token);
    assert("self-link rejected", selfLink.status >= 400 && /itself/i.test(selfLink.body.error || ""));
    const lpCreate = await request("POST", "/api/linked-ports", { primaryUnlocode: portCode, linkedUnlocode: portCode2, note: "Same estuary" }, token);
    assert("linked port created", lpCreate.status === 201, JSON.stringify(lpCreate.body));
    const lpDup = await request("POST", "/api/linked-ports", { primaryUnlocode: portCode, linkedUnlocode: portCode2 }, token);
    assert("duplicate linked-port pair rejected", lpDup.status >= 400);
    const lpList = await request("GET", "/api/linked-ports", null, token);
    assert("linked ports list includes ours", lpList.body.some(l => l.id === lpCreate.body.id));
    const pLinksAfter = await request("GET", `/api/port-locations/${portCode}/links`, null, token);
    assert("port links now shows the linked port", pLinksAfter.body.some(l => l.unlocode === portCode2));
    const lpUpdate = await request("PUT", `/api/linked-ports/${lpCreate.body.id}`, { note: "Updated note" }, token);
    assert("linked port note update returns 200", lpUpdate.status === 200 && lpUpdate.body.note === "Updated note");
    const lpUpdate404 = await request("PUT", "/api/linked-ports/LNK-NOPE", { note: "X" }, token);
    assert("linked port update 404 for unknown id", lpUpdate404.status === 404);
    const lpDelete = await request("DELETE", `/api/linked-ports/${lpCreate.body.id}`, null, token);
    assert("linked port delete returns 200", lpDelete.status === 200);
    const lpDelete404 = await request("DELETE", `/api/linked-ports/${lpCreate.body.id}`, null, token);
    assert("linked port delete 404 on second attempt", lpDelete404.status === 404);

    console.log("\nTrade Lanes — create, countries assignment, transit-suggestion, update, delete");
    const laneCode = `Z${rand}`;
    // GET .../trade-lanes/:code/countries INNER JOINs against the countries MDM table (unlike
    // the PUT that writes the assignment, which doesn't validate against it at all) — a real
    // country code like NL/DE only exists there in a long-lived local dev DB from incidental
    // prior activity, not in a genuinely fresh one (npm run seed only ever seeds CN/SA — see
    // scripts/import-mdm-data.js's own comment). Own two scratch MDM countries instead of
    // assuming NL/DE are seeded, same fix already applied to organization.test.js for the
    // identical gap.
    const laneCountryA = `Z${rand[1]}`, laneCountryB = `Z${rand[2]}`;
    await request("POST", "/api/countries", { iso2: laneCountryA, name: "Zedland Lane A" }, token);
    await request("POST", "/api/countries", { iso2: laneCountryB, name: "Zedland Lane B" }, token);

    const laneCreate = await request("POST", "/api/trade-lanes", { code: laneCode, name: "Zed Test Lane", transitDays: 21 }, token);
    assert("trade lane created", laneCreate.status === 201, JSON.stringify(laneCreate.body));
    const laneMissing = await request("POST", "/api/trade-lanes", { code: "" }, token);
    assert("trade lane missing fields rejected", laneMissing.status >= 400);
    const laneDup = await request("POST", "/api/trade-lanes", { code: laneCode, name: "Dup" }, token);
    assert("duplicate trade lane rejected", laneDup.status >= 400);
    const laneList = await request("GET", "/api/trade-lanes", null, token);
    assert("trade lane list includes ours with countryCount", laneList.body.some(l => l.code === laneCode && "countryCount" in l));

    const laneCountriesSet = await request("PUT", `/api/trade-lanes/${laneCode}/countries`, { iso2s: [laneCountryA, laneCountryB] }, token);
    assert("trade lane countries set returns 200", laneCountriesSet.status === 200);
    const laneCountriesGet = await request("GET", `/api/trade-lanes/${laneCode}/countries`, null, token);
    assert("trade lane countries reflects the assignment", laneCountriesGet.body.map(c => c.iso2).sort().join(",") === [laneCountryA, laneCountryB].sort().join(","));

    const transitKnown = await request("GET", `/api/trade-lanes/transit-suggestion?pol=${portCode}&pod=${portCode}`, null, token);
    assert("transit-suggestion returns a days/lane shape", "days" in transitKnown.body && "lane" in transitKnown.body);
    const transitNoParams = await request("GET", "/api/trade-lanes/transit-suggestion", null, token);
    assert("transit-suggestion with no pol/pod returns nulls, not an error", transitNoParams.status === 200 && transitNoParams.body.days === null);

    const laneUpdate = await request("PUT", `/api/trade-lanes/${laneCode}`, { name: "Zed Renamed Lane", transitDays: 25 }, token);
    assert("trade lane update returns 200", laneUpdate.status === 200 && laneUpdate.body.transitDays === 25);
    const laneUpdate404 = await request("PUT", "/api/trade-lanes/ZZNOPE", { name: "X" }, token);
    assert("trade lane update 404 for unknown code", laneUpdate404.status === 404);

    console.log("\nCountry Trade Lanes — direct create/delete on the join table, and the per-country bulk-replace route");
    await request("DELETE", `/api/country-trade-lanes/${laneCountryA}/${laneCode}`, null, token); // pre-clean from the bulk-set above
    const ctlCreate = await request("POST", "/api/country-trade-lanes", { iso2: laneCountryA, laneCode }, token);
    assert("country-trade-lane created", ctlCreate.status === 201, JSON.stringify(ctlCreate.body));
    const ctlDup = await request("POST", "/api/country-trade-lanes", { iso2: laneCountryA, laneCode }, token);
    assert("duplicate country-trade-lane rejected", ctlDup.status >= 400);
    const ctlList = await request("GET", "/api/country-trade-lanes", null, token);
    assert("country-trade-lanes list includes ours", ctlList.body.some(r => r.iso2 === laneCountryA && r.lane_code === laneCode));
    const ctlBulkSet = await request("PUT", `/api/countries/${laneCountryB}/trade-lanes`, { lanes: [laneCode] }, token);
    assert("bulk per-country lane replace returns 200", ctlBulkSet.status === 200);
    const ctlDelete = await request("DELETE", `/api/country-trade-lanes/${laneCountryA}/${laneCode}`, null, token);
    assert("country-trade-lane delete returns 200 (idempotent even if absent)", ctlDelete.status === 200);
    await request("PUT", `/api/countries/${laneCountryB}/trade-lanes`, { lanes: [] }, token); // clean up the bulk-set above

    const laneDelete = await request("DELETE", `/api/trade-lanes/${laneCode}`, null, token);
    assert("trade lane delete returns 200", laneDelete.status === 200);
    const laneDelete404 = await request("DELETE", `/api/trade-lanes/${laneCode}`, null, token);
    assert("trade lane delete 404 on second attempt", laneDelete404.status === 404);

    await request("DELETE", `/api/countries/${laneCountryA}`, null, token);
    await request("DELETE", `/api/countries/${laneCountryB}`, null, token);

    console.log("\nRegions — create, list, update, duplicate rejection, delete");
    const regionCode = `Z${rand}`;
    const regCreate = await request("POST", "/api/regions", { code: regionCode, name: "Zed Test Region", description: "A test region" }, token);
    assert("region created", regCreate.status === 201, JSON.stringify(regCreate.body));
    const regMissing = await request("POST", "/api/regions", { code: "" }, token);
    assert("region missing fields rejected", regMissing.status >= 400);
    const regDup = await request("POST", "/api/regions", { code: regionCode, name: "Dup" }, token);
    assert("duplicate region code rejected", regDup.status >= 400);
    const regList = await request("GET", "/api/regions", null, token);
    assert("region list includes ours", regList.body.some(r => r.code === regionCode));
    const regUpdate = await request("PUT", `/api/regions/${regionCode}`, { name: "Zed Renamed Region", description: "Updated" }, token);
    assert("region update returns 200", regUpdate.status === 200 && regUpdate.body.name === "Zed Renamed Region");
    const regUpdate404 = await request("PUT", "/api/regions/ZZNOPE", { name: "X" }, token);
    assert("region update 404 for unknown code", regUpdate404.status === 404);
    const regDelete = await request("DELETE", `/api/regions/${regionCode}`, null, token);
    assert("region delete returns 200", regDelete.status === 200);
    const regDelete404 = await request("DELETE", `/api/regions/${regionCode}`, null, token);
    assert("region delete 404 on second attempt", regDelete404.status === 404);

    console.log("\nCountries — create, list w/ search+pagination, locations sub-route, update, delete");
    const countryCode = `Z${rand[0]}`;
    const cCreate = await request("POST", "/api/countries", { iso2: countryCode, name: "Zedland", unMember: 1, regionCode: "" }, token);
    assert("country created", cCreate.status === 201, JSON.stringify(cCreate.body));
    const cMissing = await request("POST", "/api/countries", { iso2: "" }, token);
    assert("country missing fields rejected", cMissing.status >= 400);
    const cDup = await request("POST", "/api/countries", { iso2: countryCode, name: "Dup" }, token);
    assert("duplicate country code rejected", cDup.status >= 400);
    const cList = await request("GET", `/api/countries?search=Zedland&limit=5&offset=0`, null, token);
    assert("country list finds ours via search, with portCount", cList.body.results.some(c => c.iso2 === countryCode && "portCount" in c));
    const cLocations = await request("GET", `/api/countries/${countryCode}/locations`, null, token);
    assert("country locations returns results/total shape", "results" in cLocations.body && "total" in cLocations.body);
    const cUpdate = await request("PUT", `/api/countries/${countryCode}`, { name: "Zedland Renamed", unMember: 0, regionCode: "" }, token);
    assert("country update returns 200", cUpdate.status === 200 && cUpdate.body.name === "Zedland Renamed");
    // "XX", not "ZZ" — every scratch code in this file is Z-prefixed (countryCode itself is
    // `Z${rand[0]}`), so a sentinel meant to guarantee non-existence must never share that
    // prefix; rand[0] landing on "Z" would otherwise make countryCode literally "ZZ" and this
    // "unknown code" check would silently find our own still-live scratch row instead — a real,
    // if rare (1/36), CI failure this exact way already confirmed it live.
    const cUpdate404 = await request("PUT", "/api/countries/XX", { name: "X" }, token);
    assert("country update 404 for unknown code", cUpdate404.status === 404);
    const cDelete = await request("DELETE", `/api/countries/${countryCode}`, null, token);
    assert("country delete returns 200", cDelete.status === 200);
    const cDelete404 = await request("DELETE", `/api/countries/${countryCode}`, null, token);
    assert("country delete 404 on second attempt", cDelete404.status === 404);

    console.log("\nUN Location Codes — search/pagination view over port_locations");
    const unlocodesRes = await request("GET", `/api/unlocodes?search=NLRTM&limit=5`, null, token);
    assert("unlocodes search returns results/total shape", "results" in unlocodesRes.body && "total" in unlocodesRes.body);
    assert("unlocodes search finds NLRTM", unlocodesRes.body.results.some(p => p.unlocode === "NLRTM"));

    console.log("\nCommodities — create, get, search, list w/ grade filter, update, delete");
    const commCode = `ZTEST${rand}`;
    const commCreate = await request("POST", "/api/commodities", { code: commCode, description: "Test Widget Cargo", gradeCode: "M", gradeName: "Manufactured" }, token);
    assert("commodity created", commCreate.status === 201, JSON.stringify(commCreate.body));
    const commMissing = await request("POST", "/api/commodities", { code: "" }, token);
    assert("commodity missing fields rejected", commMissing.status >= 400);
    const commDup = await request("POST", "/api/commodities", { code: commCode, description: "Dup" }, token);
    assert("duplicate commodity code rejected", commDup.status >= 400);
    const commGet = await request("GET", `/api/commodities/${commCode}`, null, token);
    assert("commodity get returns 200", commGet.status === 200);
    const commGet404 = await request("GET", "/api/commodities/ZZNOPE", null, token);
    assert("commodity get 404 for unknown code", commGet404.status === 404);
    const commSearch = await request("GET", `/api/commodities/search?q=Test%20Widget`, null, token);
    assert("commodity search finds it", commSearch.body.some(c => c.code === commCode));
    const commSearchEmpty = await request("GET", "/api/commodities/search?q=", null, token);
    assert("commodity search with no query returns empty array", Array.isArray(commSearchEmpty.body) && commSearchEmpty.body.length === 0);
    const commList = await request("GET", `/api/commodities?search=Test%20Widget&grade=M&limit=5`, null, token);
    assert("commodity list finds ours via search+grade filter", commList.body.results.some(c => c.code === commCode));
    const commUpdate = await request("PUT", `/api/commodities/${commCode}`, { description: "Renamed Widget Cargo", gradeCode: "M", gradeName: "Manufactured" }, token);
    assert("commodity update returns 200", commUpdate.status === 200 && commUpdate.body.description === "Renamed Widget Cargo");
    const commUpdate404 = await request("PUT", "/api/commodities/ZZNOPE", { description: "X" }, token);
    assert("commodity update 404 for unknown code", commUpdate404.status === 404);
    const commDelete = await request("DELETE", `/api/commodities/${commCode}`, null, token);
    assert("commodity delete returns 200", commDelete.status === 200);
    const commDelete404 = await request("DELETE", `/api/commodities/${commCode}`, null, token);
    assert("commodity delete 404 on second attempt", commDelete404.status === 404);

    console.log("\nCleanup");
    await request("DELETE", `/api/carriers/${carCode}`, null, token);
    await request("DELETE", `/api/port-locations/${portCode}`, null, token);
    await request("DELETE", `/api/port-locations/${portCode2}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
