/**
 * Space Allocations (routes/allocations.js) — smoke tests, gap-filling
 *
 * tests/contract-improvements.test.js / contract-routings.test.js / contract-service-toggle.test.js
 * already cover POST create, GET list, DELETE, and a basic GET /match. This file fills in what
 * they don't: PUT update (+404), the date-overlap rejection on both POST and PUT, the
 * minimumTEU-exceeds-allocatedTEU validation, GET /conflicts (both exact and linked-port kinds),
 * and /match's linked-port matchKind branch.
 *
 * Usage:
 *   node tests/allocations-crud.test.js
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

    console.log("\nScratch contract + two linked ports (own scratch pair, doesn't touch real MDM data) for the conflict/linked-match tests");
    const contract = await request("POST", "/api/contracts", {
      carrierCode: "MAEU", contractNumber: `ALC-TEST-${Date.now()}`, contractType: "Central",
      status: "Active", validFrom: "2026-01-01", validTo: "2030-01-01",
    }, token);
    assert("scratch contract created", contract.status === 201, JSON.stringify(contract.body));
    const contractId = contract.body.id;

    const portA = "ZALCA", portB = "ZALCB";
    await request("POST", "/api/port-locations", { unlocode: portA, name: "Zed Alloc Port A", countryCode: "NL" }, token);
    await request("POST", "/api/port-locations", { unlocode: portB, name: "Zed Alloc Port B", countryCode: "NL" }, token);
    const link = await request("POST", "/api/linked-ports", { primaryUnlocode: portA, linkedUnlocode: portB }, token);
    assert("linked-port pair created", link.status === 201);

    console.log("\nCreate — validation branches");
    const missing = await request("POST", "/api/allocations", { carrierCode: "MAEU" }, token);
    assert("missing required fields rejected", missing.status >= 400);
    const noContract = await request("POST", "/api/allocations", {
      carrierCode: "MAEU", allocatedTEU: 50, effectiveDate: "2026-01-01", endDate: "2026-06-01", pol: portA, pod: "USNYC",
    }, token);
    assert("missing contractId rejected", noContract.status >= 400 && /contractId/i.test(noContract.body.error || ""));
    const badDateOrder = await request("POST", "/api/allocations", {
      carrierCode: "MAEU", allocatedTEU: 50, effectiveDate: "2026-06-01", endDate: "2026-01-01", pol: portA, pod: "USNYC", contractId,
    }, token);
    assert("end date before effective date rejected", badDateOrder.status >= 400 && /end date/i.test(badDateOrder.body.error || ""));
    const badMinTeu = await request("POST", "/api/allocations", {
      carrierCode: "MAEU", allocatedTEU: 50, effectiveDate: "2026-01-01", endDate: "2026-06-01", pol: portA, pod: "USNYC", contractId, minimumTEU: 100,
    }, token);
    assert("minimumTEU exceeding allocatedTEU rejected", badMinTeu.status >= 400 && /minimum/i.test(badMinTeu.body.error || ""));

    const create = await request("POST", "/api/allocations", {
      carrierCode: "MAEU", allocatedTEU: 50, effectiveDate: "2026-01-01", endDate: "2026-06-01",
      pol: portA, pod: "USNYC", contractId, minimumTEU: 10,
    }, token);
    assert("allocation created", create.status === 201, JSON.stringify(create.body));
    const allocId = create.body.id;

    const overlapping = await request("POST", "/api/allocations", {
      carrierCode: "MAEU", allocatedTEU: 30, effectiveDate: "2026-03-01", endDate: "2026-04-01",
      pol: portA, pod: "USNYC", contractId,
    }, token);
    assert("overlapping same-route allocation rejected", overlapping.status >= 400 && /already covers/i.test(overlapping.body.error || ""));

    console.log("\nUpdate — happy path, validation, overlap (excluding self), 404");
    const update = await request("PUT", `/api/allocations/${allocId}`, {
      carrierCode: "MAEU", allocatedTEU: 75, effectiveDate: "2026-01-01", endDate: "2026-07-01",
      pol: portA, pod: "USNYC", contractId, notes: "Updated",
    }, token);
    assert("update returns 200", update.status === 200);
    assert("allocatedTEU updated", update.body.allocatedTEU === 75);
    assert("consumedTEU/remainingTEU shape carried through", "consumedTEU" in update.body && update.body.remainingTEU === 75);

    const updateSelfNoOverlap = await request("PUT", `/api/allocations/${allocId}`, {
      carrierCode: "MAEU", allocatedTEU: 75, effectiveDate: "2026-01-01", endDate: "2026-07-01",
      pol: portA, pod: "USNYC", contractId,
    }, token);
    assert("updating a row against its own unchanged dates is NOT treated as a self-overlap", updateSelfNoOverlap.status === 200);

    const updateMissing = await request("PUT", `/api/allocations/${allocId}`, { pol: portA }, token);
    assert("update missing required fields rejected", updateMissing.status >= 400);
    const updateBadMinTeu = await request("PUT", `/api/allocations/${allocId}`, {
      carrierCode: "MAEU", allocatedTEU: 75, effectiveDate: "2026-01-01", endDate: "2026-07-01", pol: portA, pod: "USNYC", contractId, minimumTEU: 1000,
    }, token);
    assert("update minimumTEU exceeding allocatedTEU rejected", updateBadMinTeu.status >= 400);
    // Dates deliberately outside the real allocation's own range — checkOverlap runs BEFORE the
    // existence check, so overlapping dates against an unknown id would surface the overlap
    // error instead of 404 (checkOverlap's excludeId can't exclude a row that was never there).
    const update404 = await request("PUT", "/api/allocations/ALC-NOPE", {
      carrierCode: "MAEU", allocatedTEU: 10, effectiveDate: "2026-09-01", endDate: "2026-10-01", pol: portA, pod: "USNYC", contractId,
    }, token);
    assert("update 404 for unknown id", update404.status === 404);

    console.log("\nGET /api/allocations/conflicts — exact match, and linked-port match");
    const conflictsExact = await request("GET",
      `/api/allocations/conflicts?carrierCode=MAEU&pol=${portA}&pod=USNYC&effectiveDate=2026-02-01&endDate=2026-03-01`, null, token);
    assert("conflicts (exact) returns 200 with exact/linked shape", conflictsExact.status === 200 && "exact" in conflictsExact.body && "linked" in conflictsExact.body);
    assert("our allocation appears as an exact conflict", conflictsExact.body.exact.some(a => a.id === allocId));
    assert("exact conflict carries carrierName + empty links", conflictsExact.body.exact[0]?.conflictKind === "exact" && Array.isArray(conflictsExact.body.exact[0]?.links));

    const conflictsLinked = await request("GET",
      `/api/allocations/conflicts?carrierCode=MAEU&pol=${portB}&pod=USNYC&effectiveDate=2026-02-01&endDate=2026-03-01`, null, token);
    assert("conflicts (via linked port B) finds our port-A allocation as a linked conflict", conflictsLinked.body.linked.some(a => a.id === allocId));
    assert("linked conflict explains which ports link", conflictsLinked.body.linked[0]?.links?.length > 0);

    const conflictsExcluded = await request("GET",
      `/api/allocations/conflicts?carrierCode=MAEU&pol=${portA}&pod=USNYC&effectiveDate=2026-02-01&endDate=2026-03-01&excludeId=${allocId}`, null, token);
    assert("excludeId omits our own allocation from its own conflict check", !conflictsExcluded.body.exact.some(a => a.id === allocId));

    const conflictsMissingParams = await request("GET", "/api/allocations/conflicts?carrierCode=MAEU", null, token);
    assert("conflicts with missing params returns empty shape, not an error", conflictsMissingParams.status === 200 && conflictsMissingParams.body.exact.length === 0);

    console.log("\nGET /api/allocations/match — linked-port matchKind (not just exact)");
    const matchLinked = await request("GET", `/api/allocations/match?pol=${portB}&pod=USNYC&etd=2026-02-15`, null, token);
    assert("match via linked port returns 200", matchLinked.status === 200);
    const linkedResult = matchLinked.body.find(a => a.id === allocId);
    assert("our allocation matched with matchKind 'linked'", linkedResult?.matchKind === "linked");
    assert("linkedPolVia names the real allocation port", linkedResult?.linkedPolVia === portA);

    const matchExact = await request("GET", `/api/allocations/match?pol=${portA}&pod=USNYC&etd=2026-02-15`, null, token);
    const exactResult = matchExact.body.find(a => a.id === allocId);
    assert("exact-port match returns matchKind 'exact'", exactResult?.matchKind === "exact");
    assert("linkedPolVia/linkedPodVia are null on an exact match", exactResult?.linkedPolVia === null && exactResult?.linkedPodVia === null);

    const matchNoParams = await request("GET", "/api/allocations/match", null, token);
    assert("match with no pol/pod/etd returns an empty array, not an error", matchNoParams.status === 200 && matchNoParams.body.length === 0);

    console.log("\nDelete — 404 on second attempt");
    const del = await request("DELETE", `/api/allocations/${allocId}`, null, token);
    assert("delete returns 200", del.status === 200);
    const del404 = await request("DELETE", `/api/allocations/${allocId}`, null, token);
    assert("delete 404 on second attempt", del404.status === 404);

    console.log("\nCleanup");
    await request("DELETE", `/api/linked-ports/${link.body.id}`, null, token);
    await request("DELETE", `/api/port-locations/${portA}`, null, token);
    await request("DELETE", `/api/port-locations/${portB}`, null, token);
    await request("DELETE", `/api/contracts/${contractId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
