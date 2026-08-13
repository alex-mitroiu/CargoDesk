/**
 * Contract Management Service — CRUD, validation, publish/withdraw, bulk-import
 *
 * Hits the service directly on its own port, no monolith involved.
 *
 * Usage:
 *   node services/contract-management/tests/contracts-crud.test.js
 *
 * Prerequisites:
 *   - Contract Management Service running on :3004 (npm run contract-service)
 */

import http from "node:http";

const PORT = 3004;
const SECRET = process.env.CONTRACT_SERVICE_SECRET || "cargoDesk-dev-contract-service-secret-do-not-use-in-prod";
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
  const cleanupIds = [];
  try {
    console.log("Health check");
    const health = await request("GET", "/health", null, false);
    assert("health returns 200", health.status === 200);
    assert("service name is contract-management", health.body.service === "contract-management");

    console.log("\nNo secret / wrong secret is rejected on /internal/*");
    const noAuth = await request("GET", "/internal/contracts", null, false);
    assert("no auth returns 401", noAuth.status === 401);
    const badAuth = await request("GET", "/internal/contracts", null, true);
    // (badAuth reuses the correct SECRET above; verify a WRONG one is rejected explicitly)
    const wrongAuthReq = await new Promise(resolve => {
      const r = http.request({ method: "GET", hostname: "localhost", port: PORT, path: "/internal/contracts",
        headers: { Authorization: "Bearer wrong-secret" } }, res => resolve({ status: res.statusCode }));
      r.end();
    });
    assert("wrong secret returns 401", wrongAuthReq.status === 401);

    console.log("\nCreate a plain contract (no named routings) — basic CRUD");
    const num = `SVC-CRUD-${Date.now()}`;
    const create = await request("POST", "/internal/contracts", {
      contractNumber: num, carrierCode: "MAEU", status: "Active",
      validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC" }],
      rates: [{ serviceCode: "OF", amount: 500, currency: "USD", unit: "per_container" }],
    });
    assert("create returns 201", create.status === 201, JSON.stringify(create.body));
    const contractId = create.body.id;
    cleanupIds.push(contractId);
    assert("contractNumber round-trips", create.body.contractNumber === num);
    assert("routings array empty", create.body.routings.length === 0);

    console.log("\nDuplicate contractNumber+ref+account is rejected");
    const dup = await request("POST", "/internal/contracts", {
      contractNumber: num, carrierCode: "MAEU", status: "Active", validFrom: "2026-01-01", validTo: "2027-01-01",
    });
    assert("duplicate rejected", dup.status === 400);

    console.log("\nInvalid status is rejected");
    const badStatus = await request("POST", "/internal/contracts", {
      contractNumber: `SVC-BAD-${Date.now()}`, carrierCode: "MAEU", status: "NotARealStatus",
      validFrom: "2026-01-01", validTo: "2027-01-01",
    });
    assert("invalid status rejected", badStatus.status === 400);

    console.log("\nGET single contract");
    const get = await request("GET", `/internal/contracts/${contractId}`);
    assert("get returns 200", get.status === 200);
    assert("legs present", get.body.legs.length === 1);

    console.log("\nGET list with search filter");
    const list = await request("GET", `/internal/contracts?search=${num}`);
    assert("list returns 200", list.status === 200);
    assert("list finds the contract", list.body.results.some(c => c.id === contractId));

    console.log("\nUPDATE — amend notes");
    const put = await request("PUT", `/internal/contracts/${contractId}`, {
      contractNumber: num, carrierCode: "MAEU", status: "Active", notes: "amended",
      validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: get.body.legs, rates: get.body.rates,
    });
    assert("update returns 200", put.status === 200, JSON.stringify(put.body));
    assert("notes updated", put.body.notes === "amended");

    console.log("\nPublish/withdraw guards");
    const draftNum = `SVC-DRAFT-${Date.now()}`;
    const draft = await request("POST", "/internal/contracts", {
      contractNumber: draftNum, carrierCode: "MAEU", status: "Draft",
      validFrom: "2026-01-01", validTo: "2027-01-01",
    });
    cleanupIds.push(draft.body.id);
    const pubNoLegs = await request("POST", `/internal/contracts/${draft.body.id}/publish`, {});
    assert("publish rejected with no legs/rates", pubNoLegs.status === 400);

    const withLegs = await request("PUT", `/internal/contracts/${draft.body.id}`, {
      contractNumber: draftNum, carrierCode: "MAEU", status: "Draft",
      validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC" }],
      rates: [{ serviceCode: "OF", amount: 100, currency: "USD", unit: "per_container" }],
    });
    assert("legs/rates added", withLegs.status === 200);
    const pub = await request("POST", `/internal/contracts/${draft.body.id}/publish`, {});
    assert("publish succeeds once legs+rates exist", pub.status === 200 && pub.body.status === "Active");
    const pubAgain = await request("POST", `/internal/contracts/${draft.body.id}/publish`, {});
    assert("publishing an already-Active contract is rejected", pubAgain.status === 400);
    const withdraw = await request("POST", `/internal/contracts/${draft.body.id}/withdraw`, {});
    assert("withdraw succeeds", withdraw.status === 200 && withdraw.body.status === "Draft");

    console.log("\nBulk import");
    const bulk = await request("POST", "/internal/contracts/bulk-import", {
      contracts: [
        { id: "OLD-1", contractNumber: `SVC-BULK-A-${Date.now()}`, carrierCode: "CMDU", status: "Active", validFrom: "2026-01-01", validTo: "2027-01-01" },
        { id: "OLD-2", contractNumber: `SVC-BULK-B-${Date.now()}`, carrierCode: "CMDU", status: "Active", validFrom: "2026-01-01", validTo: "2027-01-01",
          legs: [{ pol: "CNSHA", pod: "USLAX" }], rates: [{ serviceCode: "OF", amount: 300, currency: "USD" }] },
      ],
    });
    assert("bulk import returns 201", bulk.status === 201, JSON.stringify(bulk.body));
    assert("2 imported, 0 failed", bulk.body.imported === 2 && bulk.body.failed === 0);
    for (const r of bulk.body.results) if (r.ok) cleanupIds.push(r.newId);

    console.log("\nDELETE");
    const del = await request("DELETE", `/internal/contracts/${contractId}`);
    assert("delete returns 200", del.status === 200);
    const afterDel = await request("GET", `/internal/contracts/${contractId}`);
    assert("get after delete is 404", afterDel.status === 404);
    cleanupIds.splice(cleanupIds.indexOf(contractId), 1);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    for (const id of cleanupIds) { try { await request("DELETE", `/internal/contracts/${id}`); } catch {} }
  }
})();
