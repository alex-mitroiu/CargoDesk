/**
 * Screening Service — entries/status/import-csv/bulk-import routes.
 *
 * Hits the service directly on its own port, no monolith involved. Deliberately does NOT
 * exercise the real syncOfacSdn()/syncConsolidatedScreeningList() live external calls (real
 * treasury.gov/trade.gov fetches — slow, flaky, and destructively replaces this service's own
 * live-synced dataset) — same standing exclusion the monolith's own test suite already applies
 * to POST /api/sanctions/sync|sync-csl. import-csv and bulk-import cover the write/read paths
 * without any external network dependency.
 *
 * Usage:
 *   node services/screening/tests/sanctions-sync.test.js
 *
 * Prerequisites:
 *   - Screening Service running on :3006 (npm run screening-service)
 */

import http from "node:http";

const PORT = 3006;
const SECRET = process.env.SCREENING_SERVICE_SECRET || "cargoDesk-dev-screening-service-secret-do-not-use-in-prod";
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
    assert("service name is screening", health.body.service === "screening");

    console.log("\nNo secret / wrong secret rejected on /internal/*");
    const noAuth = await request("GET", "/internal/sanctions/entries", null, false);
    assert("no auth returns 401", noAuth.status === 401);

    console.log("\nimport-csv — pre-parsed entries, replaces OFAC-SDN, updates sanctions_syncs");
    const testName = `Test Screening Entity ${stamp}`;
    const importRes = await request("POST", "/internal/sanctions/import-csv", {
      entries: [{ refId: String(stamp), name: testName, sdnType: "Individual", program: "TEST-PROGRAM" }],
    });
    assert("import-csv returns the sync summary", importRes.status === 200 && importRes.body.entries === 1, JSON.stringify(importRes.body));

    console.log("\nGET /internal/sanctions/entries finds the imported entry");
    const entries = await request("GET", `/internal/sanctions/entries?search=${encodeURIComponent(testName)}`);
    // Raw snake_case rows, no mapper — matches the original monolith route's exact behavior.
    assert("entries search finds it", entries.body.results.some(e => e.entity_name === testName), JSON.stringify(entries.body));

    console.log("\nGET /internal/sanctions/status reflects the OFAC-SDN sync");
    const status = await request("GET", "/internal/sanctions/status");
    assert("status shows a recent OFAC-SDN sync", status.body.syncs.some(s => s.source === "OFAC-SDN"), JSON.stringify(status.body));
    assert("ofacEntryCount is exactly 1 (import-csv replaces the whole OFAC-SDN set)", status.body.ofacEntryCount === 1, JSON.stringify(status.body));

    console.log("\nGET /internal/sanctions/entries/export — bulk, unpaginated (powers the monolith's cache)");
    const exportRes = await request("GET", "/internal/sanctions/entries/export");
    assert("export includes the imported entry", exportRes.body.some(e => e.entity_name === testName), JSON.stringify(exportRes.body).slice(0, 300));

    console.log("\nPOST /internal/sanctions/bulk-import — idempotent via INSERT OR IGNORE");
    const bulkId = `CSL-TESTBULK${stamp}`;
    const bulk1 = await request("POST", "/internal/sanctions/bulk-import", {
      entries: [{ id: bulkId, source: "Test Bulk List", refId: "1", entityName: "Bulk Test Entity", entityType: "Entity", program: "", aliasesNorm: "[]" }],
    });
    assert("bulk-import returns 201", bulk1.status === 201, JSON.stringify(bulk1.body));
    assert("first bulk-import inserts 1", bulk1.body.inserted === 1);
    const bulk2 = await request("POST", "/internal/sanctions/bulk-import", {
      entries: [{ id: bulkId, source: "Test Bulk List", refId: "1", entityName: "Bulk Test Entity", entityType: "Entity", program: "", aliasesNorm: "[]" }],
    });
    assert("re-running bulk-import is idempotent (0 new inserts)", bulk2.body.inserted === 0, JSON.stringify(bulk2.body));

    console.log("\nCleanup");
    // No DELETE route exists on this service (denylist data — deleting individual rows isn't a
    // real operator action, only a full resync is) — leave the test rows; the next real sync
    // (OFAC-SDN) or a fresh dev DB will clear them naturally.
  } catch (e) {
    console.error("FATAL:", e.message);
    failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
