/**
 * Typed contract legs (the user's pick 2026-11-07, mockup https://claude.ai/code/artifact/ff9c67cb-1556-48b4-a4f8-420c4084e91e
 * option D): every contract leg is a Pick-up, SEA or Delivery leg, as on a shipment's route table. A Pick-up leg
 * collects from its places (several, blank = anywhere), from a kind of place, by a mode (blank = any), and ends
 * where the line's first SEA leg loads; a Delivery leg is the same at the other end. The search judges each end
 * on place, kind and mode (lib/routingLines.js, server.js findMatchingContractLegs).
 *
 * Covers: saving typed lines (the barge example: Pick-up VNSGN Door by Barge → VNVUT, SEA VNVUT → USSAV); the
 * refusals (a line out of order, two Pick-up legs); GET /api/contracts/match by place, kind and mode, with the
 * matched Pick-up / Delivery legs; GET /api/contracts' POL filter (sea ports only) and Schedule Search's routing
 * terms (DR / CY); "CY" stored on a contract reads as the shipment's "Container Yard".
 *
 * Usage:
 *   node tests/contract-typed-legs.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001 (contract_source local)
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

const qs = o => new URLSearchParams(o).toString();
// Well clear of real data, like the other contract tests: validity and every date in 2028.
const VALID = { validFrom: "2028-01-01", validTo: "2028-12-31" }, DATE = "2028-11-15";
const leg = (legType, pol, pod, extra = {}) => ({ legType, pol, pod, polLocType: "Terminal", podLocType: "Terminal", ...extra });

(async () => {
  const contracts = [];
  let token;
  try {
    console.log("Logging in…");
    token = await login();
    console.log("  ✓ Logged in");
    const stamp = Date.now();

    console.log("\nSaving typed lines");
    const create = await request("POST", "/api/contracts", { contractNumber: `TYPED-${stamp}`, carrierCode: "HLCU", status: "Active", ...VALID,
      routings: [{ name: "Door to door" }, { name: "Barge pre-carriage" }],
      legs: [
        { ...leg("Pick-up", "NLAMS", "NLRTM", { polLocType: "Door", polHaulageLocations: "NLAMS DEBER", movementBy: "Truck" }), routingIndex: 0 },
        { ...leg("SEA", "NLRTM", "USNYC"), routingIndex: 0 },
        { ...leg("Delivery", "USNYC", "USCHI", { podLocType: "Door" }), routingIndex: 0 },
        { ...leg("Pick-up", "VNSGN", "VNVUT", { polLocType: "Door", movementBy: "Barge" }), routingIndex: 1 },
        { ...leg("SEA", "VNVUT", "USSAV"), routingIndex: 1 },
      ],
      rates: [{ serviceCode: "OF", amount: 1200, currency: "USD", unit: "per_container" }] }, token);
    assert("created (201)", create.status === 201, JSON.stringify(create.body));
    const c = create.body;
    if (c.id) contracts.push(c.id);
    const legs = c.legs || [];
    assert("two lines", (c.routings || []).length === 2);
    assert("the types are stored", JSON.stringify(legs.map(l => l.legType)) === JSON.stringify(["Pick-up", "SEA", "Delivery", "Pick-up", "SEA"]), JSON.stringify(legs.map(l => l.legType)));
    assert("the Pick-up leg keeps both places, its kind and mode", legs[0]?.polHaulageLocations === "NLAMS DEBER" && legs[0]?.polLocType === "Door" && legs[0]?.movementBy === "Truck", JSON.stringify(legs[0]));
    assert("the Delivery leg's place comes from its To port", legs[2]?.podHaulageLocations === "USCHI" && legs[2]?.podCarrierHaulage === true);
    assert("the barge Pick-up leg runs between two ports", legs[3]?.pol === "VNSGN" && legs[3]?.pod === "VNVUT" && legs[3]?.movementBy === "Barge");
    assert("a SEA leg carries no haulage and no mode", legs[1]?.polCarrierHaulage === false && legs[1]?.movementBy === "");

    console.log("\nRefused: a line out of order, two Pick-up legs");
    let r = await request("POST", "/api/contracts", { contractNumber: `TYPED-BAD1-${stamp}`, carrierCode: "HLCU", status: "Draft", ...VALID,
      routings: [{ name: "" }], legs: [{ ...leg("SEA", "NLRTM", "USNYC"), routingIndex: 0 }, { ...leg("Pick-up", "NLAMS", "NLRTM"), routingIndex: 0 }] }, token);
    assert("Pick-up after the SEA leg: 400", r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
    assert("…naming the line, the problem and the order", /Line 1: The Pick-up leg comes first, before the SEA legs\. The order on a contract line:/.test(r.body?.error || ""), r.body?.error);
    if (r.body?.id) contracts.push(r.body.id);
    r = await request("POST", "/api/contracts", { contractNumber: `TYPED-BAD2-${stamp}`, carrierCode: "HLCU", status: "Draft", ...VALID,
      routings: [{ name: "" }], legs: [{ ...leg("Pick-up", "NLAMS", "NLRTM"), routingIndex: 0 }, { ...leg("Pick-up", "DEBER", "NLRTM"), routingIndex: 0 },
        { ...leg("SEA", "NLRTM", "USNYC"), routingIndex: 0 }] }, token);
    assert("two Pick-up legs: 400, at most one", r.status === 400 && /at most one Pick-up leg/.test(r.body?.error || ""), `${r.status} ${JSON.stringify(r.body)}`);
    if (r.body?.id) contracts.push(r.body.id);
    r = await request("POST", "/api/contracts", { contractNumber: `TYPED-BAD3-${stamp}`, carrierCode: "HLCU", status: "Draft", ...VALID,
      routings: [{ name: "" }], legs: [{ ...leg("Pick-up", "NLAMS", ""), routingIndex: 0 }, { ...leg("SEA", "NLRTM", "USNYC"), routingIndex: 0 }] }, token);
    assert("a Pick-up leg with no To: 400, not a line of its own (audit A3)", r.status === 400 && /The Pick-up leg needs its To/.test(r.body?.error || ""), `${r.status} ${JSON.stringify(r.body)}`);
    if (r.body?.id) contracts.push(r.body.id);

    const match = async (pol, pod, extra) => {
      const res = await request("GET", `/api/contracts/match?${qs({ pol, pod, crd: DATE, ...extra })}`, null, token);
      return (Array.isArray(res.body) ? res.body : []).filter(m => m.id === c.id);
    };
    const pku = (location, type, mode) => ({ needsPolHaulage: "1", pkuLocation: location, pkuLocType: type, ...(mode && { pkuMode: mode }) });
    const del = (location, type, mode) => ({ needsPodHaulage: "1", delLocation: location, delLocType: type, ...(mode && { delMode: mode }) });

    console.log("\nMatching a Pick-up leg on place, kind and mode");
    let m = await match("NLRTM", "USNYC", pku("NLAMS", "Door"));
    assert("NLAMS Door: matches, the Pick-up leg returned, the matched legs are the SEA legs", m.length === 1 && m[0].pickupLeg?.legType === "Pick-up"
      && (m[0].matchedLegs || []).map(l => l.legType).join() === "SEA", JSON.stringify(m.map(x => [x.pickupLeg?.legType, (x.matchedLegs || []).map(l => l.legType)])));
    assert("DEBER (its second place) matches", (await match("NLRTM", "USNYC", pku("DEBER", "Door"))).length === 1);
    assert("DEHAM (not among its places) doesn't", (await match("NLRTM", "USNYC", pku("DEHAM", "Door"))).length === 0);
    assert("a Container Yard pick-up doesn't (the leg collects from a Door)", (await match("NLRTM", "USNYC", pku("NLAMS", "Container Yard"))).length === 0);
    assert("by Truck matches the leg's Truck", (await match("NLRTM", "USNYC", pku("NLAMS", "Door", "Truck"))).length === 1);
    assert("by Barge doesn't (the leg names Truck)", (await match("NLRTM", "USNYC", pku("NLAMS", "Door", "Barge"))).length === 0);
    assert("the Delivery leg: USCHI Door matches, USLAX doesn't", (await match("NLRTM", "USNYC", del("USCHI", "Door"))).length === 1
      && (await match("NLRTM", "USNYC", del("USLAX", "Door"))).length === 0);

    console.log("\nThe barge example");
    m = await match("VNVUT", "USSAV", pku("VNSGN", "Door", "Barge"));
    assert("VNSGN Door by Barge → VNVUT, SEA VNVUT → USSAV: matches", m.length === 1 && m[0].pickupLeg?.pol === "VNSGN", JSON.stringify(m.map(x => x.pickupLeg)));
    assert("by Truck doesn't", (await match("VNVUT", "USSAV", pku("VNSGN", "Door", "Truck"))).length === 0);
    assert("a shipment that names no mode isn't judged on it", (await match("VNVUT", "USSAV", pku("VNSGN", "Door"))).length === 1);
    assert("no carrier haulage on the shipment: POL and POD alone", (await match("VNVUT", "USSAV", {})).length === 1);
    assert("the pick-up place isn't a port of loading: VNSGN → USSAV finds nothing", (await match("VNSGN", "USSAV", {})).length === 0);

    console.log("\nThe contract list: POL is a sea port, routing terms read the typed legs");
    const list = async q => ((await request("GET", `/api/contracts?${qs({ status: "Active", limit: "200", ...q })}`, null, token)).body.results || []).some(x => x.id === c.id);
    assert("POL NLRTM finds it", await list({ pol: "NLRTM" }));
    assert("POL NLAMS (a pick-up place) doesn't", !(await list({ pol: "NLAMS" })));
    assert("DR–DR from NLAMS finds it", await list({ routingTerm: "D2D", polOrigin: "NLAMS" }));
    assert("CY–PT doesn't (its pick-ups are from a Door)", !(await list({ routingTerm: "CY2P" })));
    assert("PT–PT doesn't (it has a Pick-up leg)", !(await list({ routingTerm: "P2P" })));

    console.log("\n\"CY\" on a contract is the shipment's \"Container Yard\"");
    const cy = await request("POST", "/api/contracts", { contractNumber: `TYPED-CY-${stamp}`, carrierCode: "HLCU", status: "Active", ...VALID,
      routings: [{ name: "" }], legs: [{ ...leg("Pick-up", "NLRTM", "NLRTM", { polLocType: "CY" }), routingIndex: 0 }, { ...leg("SEA", "NLRTM", "USNYC"), routingIndex: 0 }] }, token);
    if (cy.body?.id) contracts.push(cy.body.id);
    assert("saved as Container Yard", cy.status === 201 && cy.body.legs?.[0]?.polLocType === "Container Yard", JSON.stringify(cy.body.legs?.[0]));
    const cyMatch = (await request("GET", `/api/contracts/match?${qs({ pol: "NLRTM", pod: "USNYC", crd: DATE, ...pku("NLRTM", "Container Yard") })}`, null, token)).body;
    assert("the user's example (CH NLRTM CY → NLRTM Terminal) finds it", (Array.isArray(cyMatch) ? cyMatch : []).some(x => x.id === cy.body.id));
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    failed++;
  } finally {
    for (const id of contracts) await request("DELETE", `/api/contracts/${id}`, null, token).catch(() => {});
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
