/**
 * Contracts (routes/contracts.js) — gap-filling smoke tests
 *
 * tests/contract-improvements.test.js and tests/contract-routings.test.js already cover core
 * CRUD, publish's empty-contract/already-active guards, a clean withdraw, and /match. This file
 * fills in: GET /search (typeahead), GET /revalidate, and publish/withdraw's remaining guard
 * branches (missing validity dates, validTo already in the past, an orphaned leg once a named
 * routing exists, withdraw's 404/not-Active/referenced-by-shipment/referenced-by-allocation).
 *
 * Usage:
 *   node tests/contracts-gaps.test.js
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

    const rand = `GAP${Date.now()}`;

    console.log("\nGET /api/contracts/search — typeahead by number/carrier/asOf");
    const active = await request("POST", "/api/contracts", {
      contractNumber: rand, carrierCode: "MAEU", status: "Active", validFrom: "2026-01-01", validTo: "2030-01-01",
    }, token);
    assert("scratch Active contract created", active.status === 201, JSON.stringify(active.body));
    const activeId = active.body.id;

    const searchByNumber = await request("GET", `/api/contracts/search?q=${rand}`, null, token);
    assert("search by number finds it", searchByNumber.status === 200 && searchByNumber.body.some(c => c.id === activeId));
    const searchByCarrier = await request("GET", "/api/contracts/search?carrier=MAEU", null, token);
    assert("search by carrier includes it", searchByCarrier.body.some(c => c.id === activeId));
    const searchAsOf = await request("GET", "/api/contracts/search?asOf=2027-01-01", null, token);
    assert("search asOf within validity window includes it", searchAsOf.body.some(c => c.id === activeId));
    const searchAsOfOutside = await request("GET", "/api/contracts/search?asOf=2020-01-01", null, token);
    assert("search asOf outside validity window excludes it", !searchAsOfOutside.body.some(c => c.id === activeId));
    const searchNoMatch = await request("GET", "/api/contracts/search?q=NoSuchContractXYZ", null, token);
    assert("search with no matches returns an empty array", searchNoMatch.status === 200 && searchNoMatch.body.length === 0);

    console.log("\nGET /api/contracts/revalidate — re-checks a free-text contractRef against real Active contracts");
    const revalidateHit = await request("GET", `/api/contracts/revalidate?ref=${rand}`, null, token);
    assert("revalidate finds the matching Active contract (case-insensitive)", revalidateHit.status === 200 && revalidateHit.body.some(c => c.id === activeId));
    const revalidateCaseInsensitive = await request("GET", `/api/contracts/revalidate?ref=${rand.toLowerCase()}`, null, token);
    assert("revalidate matches regardless of case", revalidateCaseInsensitive.body.some(c => c.id === activeId));
    const revalidateNoRef = await request("GET", "/api/contracts/revalidate", null, token);
    assert("revalidate with no ref returns an empty array, not an error", revalidateNoRef.status === 200 && revalidateNoRef.body.length === 0);
    const revalidateNoMatch = await request("GET", "/api/contracts/revalidate?ref=NoSuchRefXYZ", null, token);
    assert("revalidate with no matching contract returns an empty array", revalidateNoMatch.body.length === 0);

    console.log("\npublish — missing validity dates, and validTo already in the past");
    const draftNoDates = await request("POST", "/api/contracts", { contractNumber: `${rand}-A`, carrierCode: "MAEU", status: "Draft" }, token);
    const draftNoDatesId = draftNoDates.body.id;
    // Legs/rates are saved via the contract's own PUT (legs/rates arrays), not a separate route —
    // mirror how MdmContractsPage actually persists them.
    await request("PUT", `/api/contracts/${draftNoDatesId}`, {
      contractNumber: `${rand}-A`, carrierCode: "MAEU", status: "Draft",
      legs: [{ pol: "NLRTM", pod: "USNYC", legOrder: 0 }],
      rates: [{ chargeCode: "OFR", amount: 100, currency: "USD" }],
    }, token);
    const publishNoDates = await request("POST", `/api/contracts/${draftNoDatesId}/publish`, {}, token);
    assert("publish rejected with no valid_from/valid_to set", publishNoDates.status >= 400 && /valid from and valid to/i.test(publishNoDates.body.error || ""));

    const draftPastDate = await request("POST", "/api/contracts", {
      contractNumber: `${rand}-B`, carrierCode: "MAEU", status: "Draft", validFrom: "2020-01-01", validTo: "2020-06-01",
      legs: [{ pol: "NLRTM", pod: "USNYC", legOrder: 0 }],
      rates: [{ chargeCode: "OFR", amount: 100, currency: "USD" }],
    }, token);
    const publishPastDate = await request("POST", `/api/contracts/${draftPastDate.body.id}/publish`, {}, token);
    assert("publish rejected when validTo is already in the past", publishPastDate.status >= 400 && /already in the past/i.test(publishPastDate.body.error || ""));

    const publish404 = await request("POST", "/api/contracts/CNTR-NOPE/publish", {}, token);
    assert("publish 404 for unknown id", publish404.status === 404);

    console.log("\npublish — an orphaned (routing-less) leg once the contract has a named routing");
    const draftOrphan = await request("POST", "/api/contracts", {
      contractNumber: `${rand}-C`, carrierCode: "MAEU", status: "Draft", validFrom: "2026-01-01", validTo: "2030-01-01",
      legs: [
        { pol: "NLRTM", pod: "USNYC", legOrder: 0, routingIndex: 0 },
        { pol: "NLRTM", pod: "USNYC", legOrder: 1 }, // no routingIndex -> orphaned once a routing exists
      ],
      rates: [{ chargeCode: "OFR", amount: 100, currency: "USD" }],
      routings: [{ name: "Direct" }],
    }, token);
    assert("scratch contract with one routed + one orphan leg created", draftOrphan.status === 201, JSON.stringify(draftOrphan.body));
    const publishOrphan = await request("POST", `/api/contracts/${draftOrphan.body.id}/publish`, {}, token);
    assert("publish rejected — an orphan leg exists alongside a named routing", publishOrphan.status >= 400 && /named routing/i.test(publishOrphan.body.error || ""));

    console.log("\nwithdraw — 404, not-Active, referenced-by-shipment, referenced-by-allocation");
    const withdraw404 = await request("POST", "/api/contracts/CNTR-NOPE/withdraw", {}, token);
    assert("withdraw 404 for unknown id", withdraw404.status === 404);
    const withdrawDraft = await request("POST", `/api/contracts/${draftPastDate.body.id}/withdraw`, {}, token);
    assert("withdraw rejected on a non-Active (Draft) contract", withdrawDraft.status >= 400 && /Active contract can be withdrawn/i.test(withdrawDraft.body.error || ""));

    const shp = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central", contractId: activeId,
    }, token);
    const withdrawRefByShipment = await request("POST", `/api/contracts/${activeId}/withdraw`, {}, token);
    assert("withdraw rejected — referenced by a shipment", withdrawRefByShipment.status >= 400 && /referenced by at least one shipment/i.test(withdrawRefByShipment.body.error || ""));
    await request("DELETE", `/api/shipments/${shp.body.id}`, null, token);

    const alloc = await request("POST", "/api/allocations", {
      carrierCode: "MAEU", allocatedTEU: 20, effectiveDate: "2026-01-01", endDate: "2026-06-01", pol: "NLRTM", pod: "USNYC", contractId: activeId,
    }, token);
    const withdrawRefByAlloc = await request("POST", `/api/contracts/${activeId}/withdraw`, {}, token);
    assert("withdraw rejected — referenced by an allocation", withdrawRefByAlloc.status >= 400 && /linked space configuration/i.test(withdrawRefByAlloc.body.error || ""));
    await request("DELETE", `/api/allocations/${alloc.body.id}`, null, token);

    const withdrawOk = await request("POST", `/api/contracts/${activeId}/withdraw`, {}, token);
    assert("withdraw succeeds once nothing references it", withdrawOk.status === 200 && withdrawOk.body.status === "Draft");

    console.log("\nGET /api/entity-events/shipment/:id — the shipment-specific branch of the shared entity-events route");
    // Distinct from /entity-events/shipment_leg/:id (already covered by ais-integration.test.js)
    // and the generic entity_events branch (covered by contract-improvements.test.js) — this one
    // specifically reads shipment_events, keyed by shipment_id.
    const evShp = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, token);
    await request("PUT", `/api/shipments/${evShp.body.id}`, { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active", bookingRef: "TESTBOOKREF" }, token);
    const shipmentEvents = await request("GET", `/api/entity-events/shipment/${evShp.body.id}`, null, token);
    assert("shipment entity-events returns 200", shipmentEvents.status === 200);
    assert("returns an array shaped like the generic branch (entityType/eventType/field)", Array.isArray(shipmentEvents.body) && shipmentEvents.body.every(e => "entityType" in e && "eventType" in e));
    assert("entityType is 'shipment' on every row", shipmentEvents.body.every(e => e.entityType === "shipment"));
    await request("DELETE", `/api/shipments/${evShp.body.id}`, null, token);

    // Remote contract_source's PUT/DELETE proxy branches are covered separately, in
    // tests/contracts-remote-put-delete.test.js — that needs the standalone Contract
    // Management Service running, which this file deliberately doesn't require.

    console.log("\nCleanup");
    for (const id of [activeId, draftNoDatesId, draftPastDate.body.id, draftOrphan.body.id]) {
      await request("DELETE", `/api/contracts/${id}`, null, token);
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
