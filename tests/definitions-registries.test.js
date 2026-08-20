/**
 * Charge Code + Container Type definition registries — smoke tests
 *
 * Covers routes/charge-codes.js and routes/container-types.js, two small admin-maintained
 * reference registries with near-identical CRUD shapes. Previously zero dedicated coverage.
 *
 * Usage:
 *   node tests/definitions-registries.test.js
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

    console.log("\nCharge Code Definitions — create, list, update, validation, delete");
    const ccCreate = await request("POST", "/api/charge-code-definitions", {
      code: "ZTEST", label: "Test Handling Fee", trigger: "per_container_split", amount: 15, currency: "usd",
    }, token);
    assert("charge code created", ccCreate.status === 200, JSON.stringify(ccCreate.body));
    assert("currency uppercased", ccCreate.body.currency === "USD");
    const ccId = ccCreate.body.id;

    const ccBadAmount = await request("POST", "/api/charge-code-definitions", { code: "X", label: "X", amount: 0 }, token);
    assert("zero amount rejected", ccBadAmount.status >= 400);
    const ccBadAmountNeg = await request("POST", "/api/charge-code-definitions", { code: "X", label: "X", amount: -5 }, token);
    assert("negative amount rejected", ccBadAmountNeg.status >= 400);
    const ccMissing = await request("POST", "/api/charge-code-definitions", { code: "" }, token);
    assert("missing fields rejected", ccMissing.status >= 400);

    const ccList = await request("GET", "/api/charge-code-definitions", null, token);
    assert("charge code list returns 200", ccList.status === 200);
    assert("our definition appears", ccList.body.some(c => c.id === ccId));

    const ccUpdate = await request("PUT", `/api/charge-code-definitions/${ccId}`, {
      code: "ZTEST", label: "Renamed Handling Fee", amount: 20, currency: "eur", isActive: false,
    }, token);
    assert("charge code update returns 200", ccUpdate.status === 200 && ccUpdate.body.label === "Renamed Handling Fee");
    assert("isActive false round-trips", ccUpdate.body.isActive === false);
    const ccUpdate404 = await request("PUT", "/api/charge-code-definitions/CCD-NOPE", { code: "X", label: "X", amount: 1 }, token);
    assert("update 404 for unknown id", ccUpdate404.status === 404);
    const ccUpdateBadAmount = await request("PUT", `/api/charge-code-definitions/${ccId}`, { code: "X", label: "X", amount: 0 }, token);
    assert("update with invalid amount rejected", ccUpdateBadAmount.status >= 400);

    const ccDelete = await request("DELETE", `/api/charge-code-definitions/${ccId}`, null, token);
    assert("charge code delete returns 200", ccDelete.status === 200);
    const ccListAfter = await request("GET", "/api/charge-code-definitions", null, token);
    assert("deleted definition no longer listed", !ccListAfter.body.some(c => c.id === ccId));

    console.log("\nContainer Type Definitions — create, list, update, validation, delete");
    const ctCreate = await request("POST", "/api/container-type-definitions", {
      code: "20ZT", size: "20", type: "ZT", teu: 1, label: "20ft Zed Test", description: "A fixture type", sortOrder: 99,
    }, token);
    assert("container type created", ctCreate.status === 200, JSON.stringify(ctCreate.body));
    const ctId = ctCreate.body.id;

    const ctMissing = await request("POST", "/api/container-type-definitions", { code: "" }, token);
    assert("missing fields rejected", ctMissing.status >= 400);
    const ctMissingLabel = await request("POST", "/api/container-type-definitions", { code: "X", size: "20", type: "GP" }, token);
    assert("missing label rejected", ctMissingLabel.status >= 400);

    const ctList = await request("GET", "/api/container-type-definitions", null, token);
    assert("container type list returns 200", ctList.status === 200);
    assert("our definition appears", ctList.body.some(c => c.id === ctId));

    const ctUpdate = await request("PUT", `/api/container-type-definitions/${ctId}`, {
      code: "20ZT", size: "20", type: "ZT", teu: 2, label: "20ft Zed Renamed", isActive: false,
    }, token);
    assert("container type update returns 200", ctUpdate.status === 200 && ctUpdate.body.label === "20ft Zed Renamed");
    assert("teu updated", ctUpdate.body.teu === 2);
    const ctUpdate404 = await request("PUT", "/api/container-type-definitions/CTD-NOPE", { code: "X", size: "20", type: "GP", label: "X" }, token);
    assert("update 404 for unknown id", ctUpdate404.status === 404);

    const ctDelete = await request("DELETE", `/api/container-type-definitions/${ctId}`, null, token);
    assert("container type delete returns 200", ctDelete.status === 200);
    const ctListAfter = await request("GET", "/api/container-type-definitions", null, token);
    assert("deleted definition no longer listed", !ctListAfter.body.some(c => c.id === ctId));

    console.log("\nWrite operations rejected without a token");
    const noAuthCC = await request("POST", "/api/charge-code-definitions", { code: "X", label: "X", amount: 1 }, null);
    assert("charge code create without a token rejected", noAuthCC.status === 401);
    const noAuthCT = await request("POST", "/api/container-type-definitions", { code: "X", size: "20", type: "GP", label: "X" }, null);
    assert("container type create without a token rejected", noAuthCT.status === 401);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
