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
import { ensureOffices } from "./helpers/offices.mjs";

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

    const { emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId } = await ensureOffices(token);

    // ─── Plain contract (no routings sent) — becomes one routing line, pricing unchanged ───────
    // Every leg belongs to a routing line now (lib/routingLines.js): a contract saved with bare
    // legs gets one routing per connected run, named after its ports. Rates sent without a
    // routing stay contract-wide, so the price is exactly what it was.
    console.log("\nPlain contract with no routings sent — becomes one routing line, same price");
    let legacyContractId;
    {
      const num = `RTGTEST-LEGACY-${Date.now()}`;
      const r = await request("POST", "/api/contracts", {
        contractNumber: num, carrierCode: "MAEU", status: "Active",
        validFrom: "2026-01-01", validTo: "2027-01-01",
        legs: [{ pol: "NLRTM", pod: "USNYC" }],
        rates: [{ serviceCode: "OF", amount: 500, currency: "USD", unit: "per_container" }],
      }, token);
      assert("plain contract created", r.status === 201, JSON.stringify(r.body));
      legacyContractId = r.body.id;
      cleanupContracts.push(legacyContractId);
      assert("one routing line, named after its ports", r.body.routings.length === 1 && r.body.routings[0].name === "NLRTM → USNYC", JSON.stringify(r.body.routings));
      assert("the leg belongs to it", r.body.legs[0].routingId === r.body.routings[0].id);
      assert("the rate stays contract-wide (routingId '')", r.body.rates[0].routingId === "");

      const match = await request("GET", "/api/contracts/match?pol=NLRTM&pod=USNYC", null, token);
      const mine = match.body.filter(m => m.id === legacyContractId);
      assert("exactly one match", mine.length === 1, `got ${mine.length}`);
      assert("the match names the routing line", mine[0].routingId === r.body.routings[0].id);
      assert("match carries the contract-wide rate", mine[0].rates.length === 1);

      const resaved = await request("PUT", `/api/contracts/${legacyContractId}`, {
        contractNumber: num, carrierCode: "MAEU", status: "Active", validFrom: "2026-01-01", validTo: "2027-01-01",
        legs: [{ pol: "NLRTM", pod: "USNYC" }],
        rates: [{ serviceCode: "OF", amount: 500, currency: "USD", unit: "per_container" }],
      }, token);
      assert("re-saving the same bare legs keeps the routing's id (matched by its chain)",
        resaved.status === 200 && resaved.body.routings.length === 1 && resaved.body.routings[0].id === r.body.routings[0].id, JSON.stringify(resaved.body.routings));
    }

    console.log("\nSide-by-side lanes and multi-location pick-ups become separate lines; duplicates are refused");
    {
      const lanes = await request("POST", "/api/contracts", {
        contractNumber: `RTGTEST-LANES-${Date.now()}`, carrierCode: "HLCU", status: "Active", validFrom: "2026-01-01", validTo: "2027-01-01",
        legs: [
          { pol: "NLRTM", pod: "USLAX" }, { pol: "DEBRE", pod: "USLAX" },
          { pol: "NLRTM", pod: "USNYC", polLocType: "Door", podLocType: "Door", polCarrierHaulage: true, podCarrierHaulage: true,
            polHaulageLocations: "DEBER NLAMS", podHaulageLocations: "USCHI" },
        ],
        rates: [{ serviceCode: "OF", amount: 900, currency: "USD", unit: "per_container" }],
      }, token);
      assert("contract created", lanes.status === 201, JSON.stringify(lanes.body));
      if (lanes.body.id) cleanupContracts.push(lanes.body.id);
      assert("four lines: two lanes + one per pick-up", lanes.body.routings?.length === 4, JSON.stringify(lanes.body.routings?.map(x => x.name)));
      assert("each door leg now has a single pick-up", (lanes.body.legs || []).filter(l => l.polCarrierHaulage).map(l => l.polHaulageLocations).sort().join(",") === "DEBER,NLAMS");

      const dup = await request("POST", "/api/contracts", {
        contractNumber: `RTGTEST-DUP-${Date.now()}`, carrierCode: "HLCU", status: "Draft", validFrom: "2026-01-01", validTo: "2027-01-01",
        routings: [{ name: "Direct" }, { name: "Direct again" }],
        legs: [{ pol: "NLRTM", pod: "USNYC", routingIndex: 0 }, { pol: "NLRTM", pod: "USNYC", routingIndex: 1 }],
      }, token);
      assert("two lines with the same routing are refused (400)", dup.status === 400 && /same routing/i.test(dup.body.error || ""), JSON.stringify(dup.body));
      if (dup.body.id) cleanupContracts.push(dup.body.id);
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
        emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId,
      }, token);
      assert("shipment created with a specific routing assigned", shipRes.status === 200 || shipRes.status === 201, JSON.stringify(shipRes.body));
      const shipmentId = shipRes.body.id;
      cleanupShipments.push(shipmentId);
      assert("shipment round-trips contractRoutingId", shipRes.body.contractRoutingId === rtgIdA);
      const lines = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
      // Contract lines only: a live DB's own global CCD setups also land lines here.
      const lineRows = (lines.body.results || lines.body).filter(l => l.source === "contract");
      assert("cost lines generated", lineRows.length === 2, `got ${lineRows.length}`);
      const total = lineRows.reduce((s, l) => s + l.amount, 0);
      assert("cost lines total matches Routing A's own price (2450+45), not Routing B/C's",
        Math.round(total) === 2450 + 45, `got ${total}`);

      // Routing ids used to be regenerated on every contract save, leaving the shipment's
      // contract_routing_id pointing at nothing — its routing's own rates then vanished from
      // Update Carrier Costs / Reconcile. The id now survives; removing a routing in use is refused.
      console.log("\nRouting ids survive a contract save; a routing a shipment uses can't be removed");
      const before = (await request("GET", `/api/contracts/${contractId}`, null, token)).body;
      const idsBefore = before.routings.map(rt => rt.id);
      const resave = await request("PUT", `/api/contracts/${contractId}`, before, token);
      assert("re-saving the contract unchanged succeeds", resave.status === 200, JSON.stringify(resave.body));
      assert("every routing keeps its id", JSON.stringify(resave.body.routings.map(rt => rt.id)) === JSON.stringify(idsBefore),
        `${JSON.stringify(idsBefore)} -> ${JSON.stringify(resave.body.routings.map(rt => rt.id))}`);
      assert("every leg still points at the same routing",
        JSON.stringify(resave.body.legs.map(l => l.routingId)) === JSON.stringify(before.legs.map(l => l.routingId)));
      assert("the shipment's routing still exists on the contract", resave.body.routings.some(rt => rt.id === rtgIdA));
      const preview = await request("GET", `/api/shipments/${shipmentId}/cost-lines/reconcile-preview?mode=update`, null, token);
      const ofRow = (preview.body.rows || []).find(row => row.contractAmount === 2450);
      assert("after the save, Update Carrier Costs still sees Routing A's own 2450 ocean freight", !!ofRow,
        JSON.stringify(preview.body.rows?.map(row => [row.chargeCode, row.contractAmount])));

      const renamed = await request("PUT", `/api/contracts/${contractId}`, {
        ...resave.body,
        routings: resave.body.routings.map(rt => rt.id === rtgIdA ? { ...rt, name: "Via Shanghai/Rotterdam (renamed)" } : rt),
      }, token);
      const renamedA = renamed.body.routings?.find(rt => rt.id === rtgIdA);
      assert("renaming a routing keeps its id", renamed.status === 200 && renamedA?.name === "Via Shanghai/Rotterdam (renamed)", JSON.stringify(renamed.body));

      const added = await request("PUT", `/api/contracts/${contractId}`, {
        ...renamed.body,
        routings: [...renamed.body.routings, { name: "Via Shanghai/Antwerp", transitDays: 37 }],
        legs: [...renamed.body.legs,
          { pol: "CNCKG", pod: "CNSHA", routingIndex: 3 }, { pol: "CNSHA", pod: "BEANR", routingIndex: 3 }, { pol: "BEANR", pod: "SEGOT", routingIndex: 3 }],
      }, token);
      assert("adding a routing succeeds", added.status === 200, JSON.stringify(added.body));
      assert("the three existing routings keep their ids", idsBefore.every(id => added.body.routings.some(rt => rt.id === id)));
      const antwerp = added.body.routings?.find(rt => rt.name === "Via Shanghai/Antwerp");
      assert("the new routing gets its own new id", !!antwerp && !idsBefore.includes(antwerp.id));
      assert("the new routing's legs point at it", added.body.legs.filter(l => l.routingId === antwerp?.id).length === 3);

      const removeUsed = await request("PUT", `/api/contracts/${contractId}`, {
        ...added.body,
        routings: added.body.routings.filter(rt => rt.id !== rtgIdA),
        legs: added.body.legs.filter(l => l.routingId !== rtgIdA),
        rates: added.body.rates.filter(rt => rt.routingId !== rtgIdA),
      }, token);
      assert("removing the routing the shipment uses is refused (409)", removeUsed.status === 409, JSON.stringify(removeUsed.body));
      assert("the error names the shipment", (removeUsed.body.error || "").includes(shipmentId), removeUsed.body.error);
      const afterRefused = (await request("GET", `/api/contracts/${contractId}`, null, token)).body;
      assert("nothing was changed by the refused save", afterRefused.routings.length === 4 && afterRefused.routings.some(rt => rt.id === rtgIdA));

      const wvnId = afterRefused.routings.find(rt => rt.name === "Via Shanghai/Wilhelmshaven").id;
      const removeUnused = await request("PUT", `/api/contracts/${contractId}`, {
        ...afterRefused,
        routings: afterRefused.routings.filter(rt => rt.id !== wvnId),
        legs: afterRefused.legs.filter(l => l.routingId !== wvnId),
        rates: afterRefused.rates.filter(rt => rt.routingId !== wvnId),
      }, token);
      assert("removing an unused routing succeeds", removeUnused.status === 200, JSON.stringify(removeUnused.body));
      assert("it is gone and the others keep their ids",
        removeUnused.body.routings.length === 3 && !removeUnused.body.routings.some(rt => rt.id === wvnId)
          && removeUnused.body.routings.some(rt => rt.id === rtgIdA) && removeUnused.body.routings.some(rt => rt.id === antwerp?.id));
      assert("no leg is left pointing at the removed routing", !removeUnused.body.legs.some(l => l.routingId === wvnId));

      // A leg sent without a routing can no longer be left orphaned: it becomes its own routing
      // line (so the publish guard's orphan check can't trip any more), unless it describes the
      // same routing as an existing line — then the save is refused as a duplicate.
      console.log("\nA leg sent without a routing: its own line, or refused when it duplicates one");
      const looseDup = await request("POST", "/api/contracts", {
        contractNumber: `RTGTEST-DRAFT-${Date.now()}`, carrierCode: "HLCU", status: "Draft",
        validFrom: "2026-01-01", validTo: "2027-01-01",
        routings: [{ name: "Via Rotterdam", transitDays: 30 }],
        legs: [
          { pol: "CNCKG", pod: "SEGOT", routingIndex: 0 },
          { pol: "CNCKG", pod: "SEGOT" }, // no routingIndex — same line as "Via Rotterdam"
        ],
        rates: [{ serviceCode: "OF", amount: 100, currency: "USD", unit: "per_container", routingIndex: 0 }],
      }, token);
      assert("a loose leg duplicating a routing is refused (400)", looseDup.status === 400, JSON.stringify(looseDup.body));
      if (looseDup.body.id) cleanupContracts.push(looseDup.body.id);
      const looseOwn = await request("POST", "/api/contracts", {
        contractNumber: `RTGTEST-DRAFT2-${Date.now()}`, carrierCode: "HLCU", status: "Draft",
        validFrom: "2026-01-01", validTo: "2027-01-01",
        routings: [{ name: "Via Rotterdam", transitDays: 30 }],
        legs: [
          { pol: "CNCKG", pod: "SEGOT", routingIndex: 0 },
          { pol: "CNSHA", pod: "SEGOT" }, // no routingIndex — a different line
        ],
        rates: [{ serviceCode: "OF", amount: 100, currency: "USD", unit: "per_container", routingIndex: 0 }],
      }, token);
      assert("a loose leg on a different lane becomes its own line", looseOwn.status === 201 && looseOwn.body.routings.length === 2 && looseOwn.body.legs.every(l => l.routingId), JSON.stringify(looseOwn.body));
      if (looseOwn.body.id) cleanupContracts.push(looseOwn.body.id);
      const pub = await request("POST", `/api/contracts/${looseOwn.body.id}/publish`, {}, token);
      assert("and the contract publishes (no orphan legs are possible)", pub.status === 200, JSON.stringify(pub.body));
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
