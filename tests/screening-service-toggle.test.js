/**
 * Screening Service — the app_settings.screening_source toggle and the monolith-side proxy
 * layer (routes/sanctions.js, server.js's syncOfacSdn/syncConsolidatedScreeningList/
 * loadSanctionsIndex) that switches on it. Also regression-tests a real pre-existing bug found
 * while building this: loadSanctionsIndex() used to REASSIGN the module-level sanctionsMap
 * variable instead of mutating it in place, so any consumer that had already captured a
 * reference (routes/customers.js's screenCustomer, destructured from ctx at module-load time)
 * silently never saw a reload after the first one. Fixed to sanctionsMap.clear() + refill.
 *
 * Requires TWO processes running — this is the monolith-level test file that does.
 *
 * Usage:
 *   node tests/screening-service-toggle.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Screening Service running on :3006 (npm run screening-service)
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

async function login(email, password) {
  const { status, body } = await request("POST", "/api/auth/login", { email, password });
  if (status !== 200 || !body.token) throw new Error(`Login failed for ${email} (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

async function setSource(token, value) {
  return request("PUT", "/api/settings/screening-source", { value }, token);
}

(async () => {
  const stamp = Date.now();
  let scratchUserId = null, scratchCustomerId = null;
  try {
    const token = await login("claudeagent@localhost", "TestFixture!2026Zq");

    console.log("Baseline");
    const settings0 = await request("GET", "/api/settings", null, token);
    assert("screening_source defaults to 'local'", (settings0.body.screening_source || "local") === "local");

    console.log("\nToggle route is admin-only and validates its value");
    const scratchEmail = `screening-toggle-test-${stamp}@localhost`;
    const createUser = await request("POST", "/api/users",
      { email: scratchEmail, name: "Screening Toggle Test Viewer", roles: ["viewer"], password: "TestFixture!2026Zq" }, token);
    assert("scratch viewer created", createUser.status === 200, JSON.stringify(createUser.body));
    const usersList = await request("GET", "/api/users", null, token);
    scratchUserId = usersList.body.find(u => u.email === scratchEmail)?.id;
    const viewerToken = await login(scratchEmail, "TestFixture!2026Zq");
    const viewerTry = await setSource(viewerToken, "remote");
    assert("non-admin rejected (403)", viewerTry.status === 403, JSON.stringify(viewerTry.body));
    const badVal = await setSource(token, "somewhere-else");
    assert("invalid value rejected (400)", badVal.status === 400, JSON.stringify(badVal.body));

    console.log("\nREGRESSION — sanctionsMap reassignment bug (local mode, pre-existing, now fixed)");
    // A real sanctioned entity already synced into this dev DB's live OFAC data — matches
    // customer-compliance-screening.test.js's own precedent of reusing real synced data rather
    // than importing new sanctions data, which would destructively replace the live dataset.
    // Raw snake_case rows, no mapper — matches the route's exact (unchanged) response shape.
    const knownHitName = (await request("GET", "/api/sanctions/entries?limit=1", null, token)).body.results[0]?.entity_name;
    assert("a real sanctions entry exists to test against", !!knownHitName, "sync OFAC/CSL at least once before running this test");
    if (knownHitName) {
      const createCust = await request("POST", "/api/customers", { companyName: `Regression Test Co ${stamp}` }, token);
      scratchCustomerId = createCust.body.id;
      // Sync now (harmless — OFAC-SDN sync is idempotent against the same live list) to force a
      // loadSanctionsIndex() reload AFTER routes/customers.js's screenCustomer already captured
      // its own sanctionsMap reference at server boot. Before the fix, this reload would silently
      // never reach screenCustomer's captured reference.
      await request("POST", "/api/sanctions/sync", {}, token);
      const rename = await request("PUT", `/api/customers/${scratchCustomerId}`, { companyName: knownHitName }, token);
      assert("customer renamed to match a known sanctioned entity", rename.status === 200, JSON.stringify(rename.body));
      const screening = await request("GET", `/api/customers/${scratchCustomerId}`, null, token);
      assert("screenCustomer sees the CURRENT (post-reload) sanctionsMap, not a stale captured one",
        screening.body.screeningResult === "HIT", JSON.stringify(screening.body));
    }

    console.log("\nFlip to 'remote'");
    const flipRemote = await setSource(token, "remote");
    assert("flip to remote succeeds", flipRemote.status === 200 && flipRemote.body.screeningSource === "remote", JSON.stringify(flipRemote.body));

    console.log("\n'remote' mode — entries/status/import-csv proxy correctly, cache stays fresh");
    const testName = `Toggle Test Sanctioned Entity ${stamp}`;
    const csv = `${stamp},"${testName}",Individual,TEST-PROGRAM`;
    const importRes = await request("POST", "/api/sanctions/import-csv", { csv }, token);
    assert("import-csv (remote) returns the sync summary", importRes.status === 200 && importRes.body.entries === 1, JSON.stringify(importRes.body));
    const entries = await request("GET", `/api/sanctions/entries?search=${encodeURIComponent(testName)}`, null, token);
    assert("remote entries search finds the imported entry", entries.body.results.some(e => e.entity_name === testName), JSON.stringify(entries.body));
    const status = await request("GET", "/api/sanctions/status", null, token);
    assert("status carries the monolith's own local `indexed` cache size alongside remote data", typeof status.body.indexed === "number" && status.body.indexed > 0, JSON.stringify(status.body));

    console.log("\nA shipment screened right now sees the remote-imported entity (proves the local cache actually reloaded)");
    const custRemote = await request("POST", "/api/customers", { companyName: testName }, token);
    const custRemoteId = custRemote.body.id;
    const screeningRemote = await request("GET", `/api/customers/${custRemoteId}`, null, token);
    assert("customer screening sees the remote-synced entity via the refreshed cache", screeningRemote.body.screeningResult === "HIT", JSON.stringify(screeningRemote.body));
    await request("DELETE", `/api/customers/${custRemoteId}`, null, token).catch(() => {});

    console.log("\nProves two independent datastores, not a live sync");
    const flipLocal = await setSource(token, "local");
    assert("flip back to local succeeds", flipLocal.status === 200 && flipLocal.body.screeningSource === "local", JSON.stringify(flipLocal.body));
    const entriesFromLocal = await request("GET", `/api/sanctions/entries?search=${encodeURIComponent(testName)}`, null, token);
    assert("the remote-only entity is invisible once back on local", !entriesFromLocal.body.results.some(e => e.entity_name === testName), JSON.stringify(entriesFromLocal.body));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const adminToken = await login("claudeagent@localhost", "TestFixture!2026Zq").catch(() => null);
    if (adminToken) {
      if (scratchCustomerId) await request("DELETE", `/api/customers/${scratchCustomerId}`, null, adminToken).catch(() => {});
      await setSource(adminToken, "local").catch(() => {}); // always leave the toggle back at the safe default
      if (scratchUserId) await request("DELETE", `/api/users/${scratchUserId}`, null, adminToken).catch(() => {});
    }
  }
})();
