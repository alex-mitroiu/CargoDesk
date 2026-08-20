/**
 * Contracts — remote contract_source PUT/DELETE proxy branches (routes/contracts.js)
 *
 * tests/contract-service-toggle.test.js already exercises create/get/publish/withdraw/match in
 * 'remote' mode; this fills in the two it doesn't — PUT (update) and DELETE — against the real
 * standalone Contract Management Service. Split out from tests/contracts-gaps.test.js (whose
 * other assertions are monolith-only) specifically so plain `npm test` still runs without a
 * second process — this file follows the same opt-in precondition as
 * contract-service-toggle.test.js instead.
 *
 * Usage:
 *   node tests/contracts-remote-put-delete.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Contract Management Service running on :3004 (npm run contract-service)
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

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    const rand = `RPD${Date.now()}`;

    console.log("\nRemote contract_source — PUT (update) and DELETE proxy branches");
    const settingsBefore = (await request("GET", "/api/settings", null, token)).body;
    await request("PUT", "/api/settings/contract-source", { value: "remote" }, token);
    try {
      const remoteCreate = await request("POST", "/api/contracts", {
        contractNumber: `${rand}-REMOTE`, carrierCode: "MAEU", status: "Draft", validFrom: "2026-01-01", validTo: "2030-01-01",
      }, token);
      assert("remote create succeeds (proxied)", remoteCreate.status === 201, JSON.stringify(remoteCreate.body));
      const remoteId = remoteCreate.body.id;

      const remoteUpdate = await request("PUT", `/api/contracts/${remoteId}`, {
        contractNumber: `${rand}-REMOTE`, carrierCode: "MAEU", status: "Draft", validFrom: "2026-01-01", validTo: "2031-01-01", notes: "Updated via remote proxy",
      }, token);
      assert("remote update (PUT) succeeds (proxied)", remoteUpdate.status === 200 && remoteUpdate.body.notes === "Updated via remote proxy", JSON.stringify(remoteUpdate.body));

      const remoteDelete = await request("DELETE", `/api/contracts/${remoteId}`, null, token);
      assert("remote delete succeeds (proxied)", remoteDelete.status === 200, JSON.stringify(remoteDelete.body));
      const remoteGetAfterDelete = await request("GET", `/api/contracts/${remoteId}`, null, token);
      assert("deleted remote contract is genuinely gone", remoteGetAfterDelete.status === 404);
    } finally {
      await request("PUT", "/api/settings/contract-source", { value: settingsBefore.contract_source === "remote" ? "remote" : "local" }, token);
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
