/**
 * Multiple routing options per contract — smoke tests
 *
 * Usage:
 *   node tests/contract-routings.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *
 * Covers the worked example the feature was built for: a single HLCU/Kuehne+Nagel contract for
 * CNCKG -> SEGOT with three independently-priced routings (via CNSHA/NLRTM, via CNSHA/DEHAM, via
 * CNSHA/Wilhelmshaven) — plus backward compatibility for contracts with no named routings at all.
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
  let token;
  const cleanupContracts = [];
  const cleanupShipments = [];
  try {
    console.log("Logging in...");
    token = await login();
    console.log("  ✓ Logged in");

    // ─── Legacy single-routing contract — must be completely unaffected ───────────────────────
    console.log("\nLegacy contract with no named routings — unaffected by the routing feature");
    let legacyContractId;
    {
      const num = `RTGTEST-LEGACY-${Date.now()}`;
      const r = await request("POST", "/api/contracts", {
        contractNumber: num, carrierCode: "MAEU", status: "Active",
        validFrom: "2026-01-01", validTo: "2027-01-01",
        legs: [{ pol: "NLRTM", pod: "USNYC" }],
        rates: [{ serviceCode: "OF", amount: 500, currency: "USD", unit: "per_container" }],
      }, token);
      assert("legacy contract created", r.status === 201, JSON.stringify(r.body));
      legacyContractId = r.body.id;
      cleanupContracts.push(legacyContractId);
      assert("routings array present but empty", Array.isArray(r.body.routings) && r.body.routings.length === 0);
      assert("leg has routingId ''", r.body.legs[0].routingId === "");
      assert("rate has routingId ''", r.body.rates[0].routingId === "");

      const match = await request("GET", "/api/contracts/match?pol=NLRTM&pod=USNYC", null, token);
      const mine = match.body.filter(m => m.id === legacyContractId);
      assert("exactly one match for a legacy contract (not one per routing)", mine.length === 1, `got ${mine.length}`);
      assert("match routingId is ''", mine[0].routingId === "");
      assert("match carries all rates (contract-wide behavior preserved)", mine[0].rates.length === 1);
    }

    // ─── Worked example: HLCU/Kuehne+Nagel, 3 routings, same POL/POD, independent pricing ─────
    console.log("\nHLCU/Kuehne+Nagel worked example — CNCKG->SEGOT via 3 different transshipment hubs");
    let contractId;
    {
      const num = `RTGTEST-HLCU-${Date.now()}`;
      const r = await request("POST", "/api/contracts", {
        contractNumber: num, carrierCode: "HLCU", namedAccount: "Kuehne+Nagel", status: "Active",
        validFrom: "2026-01-01", validTo: "2027-01-01",
        routings: [
          { name: "Via Shanghai/Rotterdam",     transitDays: 38 },
          { name: "Via Shanghai/Hamburg",       transitDays: 36 },
          { name: "Via Shanghai/Wilhelmshaven", transitDays: 34 },
        ],
        legs: [
          { pol: "CNCKG", pod: "CNSHA", routingIndex: 0 },
          { pol: "CNSHA", pod: "NLRTM", routingIndex: 0 },
          { pol: "NLRTM", pod: "SEGOT", routingIndex: 0 },
          { pol: "CNCKG", pod: "CNSHA", routingIndex: 1 },
          { pol: "CNSHA", pod: "DEHAM", routingIndex: 1 },
          { pol: "DEHAM", pod: "SEGOT", routingIndex: 1 },
          { pol: "CNCKG", pod: "CNSHA", routingIndex: 2 },
          { pol: "CNSHA", pod: "DEWVN", routingIndex: 2 },
          { pol: "DEWVN", pod: "SEGOT", routingIndex: 2 },
        ],
        rates: [
          { serviceCode: "OF", amount: 2450, currency: "USD", unit: "per_container", routingIndex: 0 },
          { serviceCode: "OF", amount: 2600, currency: "USD", unit: "per_container", routingIndex: 1 },
          { serviceCode: "OF", amount: 2300, currency: "USD", unit: "per_container", routingIndex: 2 },
          { serviceCode: "DOC", amount: 45, currency: "USD", unit: "per_bl" }, // no routingIndex — applies to all
        ],
      }, token);
      assert("3-routing contract created", r.status === 201, JSON.stringify(r.body));
      contractId = r.body.id;
      cleanupContracts.push(contractId);
      assert("3 routings round-trip", r.body.routings.length === 3, JSON.stringify(r.body.routings));
      assert("9 legs round-trip", r.body.legs.length === 9);
      assert("4 rates round-trip", r.body.rates.length === 4);
      assert("every leg has a non-empty routingId", r.body.legs.every(l => l.routingId));
      const docRate = r.body.rates.find(rt => rt.serviceCode === "DOC");
      assert("the DOC rate has routingId '' (contract-wide)", docRate && docRate.routingId === "");

      console.log("\nGET /api/contracts/match returns 3 distinct results, one per routing, correctly priced");
      const match = await request("GET", "/api/contracts/match?pol=CNCKG&pod=SEGOT", null, token);
      const mine = match.body.filter(m => m.id === contractId);
      assert("3 match results for the same contract", mine.length === 3, `got ${mine.length}: ${JSON.stringify(mine.map(m => m.routingId))}`);
      const byName = Object.fromEntries(mine.map(m => [m.routing?.name, m]));
      assert("Via Shanghai/Rotterdam present", !!byName["Via Shanghai/Rotterdam"]);
      assert("Via Shanghai/Hamburg present", !!byName["Via Shanghai/Hamburg"]);
      assert("Via Shanghai/Wilhelmshaven present", !!byName["Via Shanghai/Wilhelmshaven"]);
      for (const [name, expectedTotal] of [
        ["Via Shanghai/Rotterdam", 2450 + 45],
        ["Via Shanghai/Hamburg", 2600 + 45],
        ["Via Shanghai/Wilhelmshaven", 2300 + 45],
      ]) {
        const m = byName[name];
        const total = (m.rates || []).reduce((s, rt) => s + rt.amountUsd, 0);
        assert(`${name} carries its own OFR rate + the contract-wide DOC rate (not the other routings' rates)`,
          m.rates.length === 2 && Math.round(total) === expectedTotal, `got ${m.rates.length} rates, total ${total}`);
        assert(`${name} transit days round-trip`, m.routing.transitDays > 0);
        assert(`${name} matchedLegs is a 3-leg chain CNCKG->...->SEGOT`,
          m.matchedLegs.length === 3 && m.matchedLegs[0].pol === "CNCKG" && m.matchedLegs[2].pod === "SEGOT");
      }

      console.log("\nGET /api/allocations/match shares the same matching rule and doesn't error on a multi-routing contract");
      const allocMatch = await request("GET", `/api/allocations/match?pol=CNCKG&pod=SEGOT&etd=2026-06-01`, null, token);
      assert("allocations/match still returns 200", allocMatch.status === 200);

      console.log("\nShipment assignment: importContractRates pulls only the assigned routing's rates");
      const rtgIdA = byName["Via Shanghai/Rotterdam"].routingId;
      const shipRes = await request("POST", "/api/shipments", {
        pol: "CNCKG", pod: "SEGOT", carrierCode: "HLCU", contractType: "Central",
        contractId, contractRoutingId: rtgIdA,
      }, token);
      assert("shipment created with a specific routing assigned", shipRes.status === 200 || shipRes.status === 201, JSON.stringify(shipRes.body));
      const shipmentId = shipRes.body.id;
      cleanupShipments.push(shipmentId);
      assert("shipment round-trips contractRoutingId", shipRes.body.contractRoutingId === rtgIdA);
      const lines = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
      const lineRows = lines.body.results || lines.body;
      assert("cost lines generated", lineRows.length === 2, `got ${lineRows.length}`);
      const total = lineRows.reduce((s, l) => s + l.amount, 0);
      assert("cost lines total matches Routing A's own price (2450+45), not Routing B/C's",
        Math.round(total) === 2450 + 45, `got ${total}`);

      console.log("\nPublish guard: an orphan leg (no routing) is rejected once the contract has named routings");
      const draftNum = `RTGTEST-DRAFT-${Date.now()}`;
      const draft = await request("POST", "/api/contracts", {
        contractNumber: draftNum, carrierCode: "HLCU", status: "Draft",
        validFrom: "2026-01-01", validTo: "2027-01-01",
        routings: [{ name: "Via Rotterdam", transitDays: 30 }],
        legs: [
          { pol: "CNCKG", pod: "SEGOT", routingIndex: 0 },
          { pol: "CNCKG", pod: "SEGOT" }, // deliberately orphaned — no routingIndex
        ],
        rates: [{ serviceCode: "OF", amount: 100, currency: "USD", unit: "per_container", routingIndex: 0 }],
      }, token);
      assert("draft contract with an orphan leg created", draft.status === 201, JSON.stringify(draft.body));
      cleanupContracts.push(draft.body.id);
      const pub = await request("POST", `/api/contracts/${draft.body.id}/publish`, {}, token);
      assert("publish rejected due to the orphan leg", pub.status === 400);
      assert("error names the reason", /routing/i.test(pub.body.error || ""));
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    for (const id of cleanupShipments) { try { await request("DELETE", `/api/shipments/${id}`, null, token); } catch {} }
    for (const id of cleanupContracts) { try { await request("DELETE", `/api/contracts/${id}`, null, token); } catch {} }
  }
})();
