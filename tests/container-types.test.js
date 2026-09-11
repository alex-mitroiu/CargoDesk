/**
 * TKT-container-types-teu-validation — regression test for a real bug found via live exploratory
 * QA: container_type_definitions.teu is an INTEGER column (lib/schema.js), but neither
 * POST/PUT /api/container-type-definitions validated that before this fix — a fractional value
 * (e.g. 1.5, or 2.25 for a real-world 45ft container) was passed straight through to Postgres,
 * which rejected the INSERT/UPDATE with a raw, unhandled error (a 500), not a clean validation
 * message. This only asserts the crash is now a clean 400 — actually supporting fractional TEU
 * (a real feature, since 45ft containers are conventionally 2.25 TEU) is out of scope here.
 *
 * Usage:
 *   node tests/container-types.test.js
 *
 * Prerequisites:
 *   - npm run server  (Express on :3001)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      method, hostname: "localhost", port: 3001, path,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
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

async function main() {
  let createdId = null;
  let existingId = null;
  let exitCode = 0;

  try {
    const token = await login();

    console.log("\nPOST /api/container-type-definitions — fractional teu");
    const badCreate = await request("POST", "/api/container-type-definitions", {
      code: "TST45", size: "45", type: "GP", teu: 2.25, label: "Test 45ft (scratch)",
    }, token);
    assert("fractional teu rejected with a clean 4xx, not a raw 500", badCreate.status >= 400 && badCreate.status < 500, `status=${badCreate.status} body=${JSON.stringify(badCreate.body)}`);
    assert("error response has a real message, not an internal-error passthrough", typeof badCreate.body?.error === "string" && !/internal server error/i.test(badCreate.body.error), JSON.stringify(badCreate.body));

    console.log("\nPOST /api/container-type-definitions — zero and negative teu also rejected");
    const zeroCreate = await request("POST", "/api/container-type-definitions", { code: "TST0", size: "20", type: "GP", teu: 0, label: "Test zero (scratch)" }, token);
    assert("teu=0 rejected", zeroCreate.status >= 400 && zeroCreate.status < 500, JSON.stringify(zeroCreate.body));
    const negCreate = await request("POST", "/api/container-type-definitions", { code: "TSTNEG", size: "20", type: "GP", teu: -1, label: "Test negative (scratch)" }, token);
    assert("teu=-1 rejected", negCreate.status >= 400 && negCreate.status < 500, JSON.stringify(negCreate.body));

    console.log("\nPOST /api/container-type-definitions — a real whole-number teu still works");
    const goodCreate = await request("POST", "/api/container-type-definitions", {
      code: "TSTOK", size: "20", type: "GP", teu: 3, label: "Test valid (scratch)",
    }, token);
    // Note: this route returns 200 on create, not the more conventional 201 — pre-existing
    // behavior on this specific route, unrelated to this fix; not changed here.
    assert("valid integer teu accepted (200)", goodCreate.status === 200, JSON.stringify(goodCreate.body));
    assert("teu round-trips as 3", goodCreate.body?.teu === 3, JSON.stringify(goodCreate.body?.teu));
    createdId = goodCreate.body?.id;

    console.log("\nPUT /api/container-type-definitions/:id — same validation on update");
    const badUpdate = await request("PUT", `/api/container-type-definitions/${createdId}`, {
      code: "TSTOK", size: "20", type: "GP", teu: 1.75, label: "Test valid (scratch)",
    }, token);
    assert("fractional teu rejected on update too, not a raw 500", badUpdate.status >= 400 && badUpdate.status < 500, `status=${badUpdate.status} body=${JSON.stringify(badUpdate.body)}`);

    // Confirm the row was left untouched by the rejected update (still teu=3).
    const list = await request("GET", "/api/container-type-definitions", null, token);
    const stillThere = list.body.find(d => d.id === createdId);
    assert("rejected update did not silently corrupt the existing row", stillThere?.teu === 3, JSON.stringify(stillThere));

    console.log(`\n${passed} passed, ${failed} failed`);
    exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e.stack || e.message);
    exitCode = 1;
  } finally {
    try {
      const token = await login();
      if (createdId) await request("DELETE", `/api/container-type-definitions/${createdId}`, null, token);
    } catch (e) { console.error("Cleanup error (non-fatal):", e.message); }
  }
  process.exit(exitCode);
}

main();
