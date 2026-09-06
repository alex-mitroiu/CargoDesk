/**
 * Generic PUT /api/settings — admin-only-key enforcement (routes/system.js).
 *
 * Six keys (mdm_source, contract_source, screening_source, kanban_source, customer_source,
 * shipment_sidebar_order) each have their own dedicated, admin-only route specifically because
 * they're a bigger blast radius than the ordinary operational toggles this generic route
 * otherwise handles for operator/occ_bk too. Found via the shipment-domain audit (TKT-E25769,
 * 2026-09-05): only sso_enforce_exclusive was ever actually excluded from the generic route —
 * an operator, correctly blocked by the dedicated PUT /api/settings/mdm-source route, could
 * flip mdm_source anyway by sending it through this route instead. Same live-confirmed bypass
 * for the other 4 source toggles and shipment_sidebar_order (which overwrites the shared nav
 * order for every user in the app). This file is the permanent regression coverage the existing
 * per-service toggle test files never had — each of them only ever exercised the dedicated
 * route's own gate, never this one.
 *
 * Usage:
 *   node tests/settings-security.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
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

const ADMIN_ONLY_KEYS = ["mdm_source", "contract_source", "screening_source", "kanban_source", "customer_source", "shipment_sidebar_order"];

(async () => {
  const stamp = Date.now();
  const opEmail = `settings-sec-op-${stamp}@test.local`;
  let opUserId = null;
  try {
    const admin = await login("claudeagent@localhost", "TestFixture!2026Zq");

    console.log("Setup — a scratch operator (non-admin) account");
    const before = await request("GET", "/api/settings", null, admin);
    const origOrder = before.body.shipment_sidebar_order;
    const createOp = await request("POST", "/api/users",
      { email: opEmail, name: "Settings Security Test Operator", roles: ["operator"], password: "SettingsSecFixture!2026Zq" }, admin);
    assert("scratch operator created", createOp.status === 200, JSON.stringify(createOp.body));
    const usersList = await request("GET", "/api/users", null, admin);
    opUserId = usersList.body.find(u => u.email === opEmail)?.id;
    assert("scratch operator findable", !!opUserId);
    const opToken = await login(opEmail, "SettingsSecFixture!2026Zq");

    console.log("\nEach admin-only key is blocked via the generic route for a non-admin");
    for (const key of ADMIN_ONLY_KEYS) {
      const attempt = await request("PUT", "/api/settings", { [key]: key === "shipment_sidebar_order" ? JSON.stringify(["shp-overview"]) : "remote" }, opToken);
      assert(`${key} rejected (403) via the generic route`, attempt.status === 403, JSON.stringify(attempt.body));
    }

    console.log("\nNone of the blocked attempts actually changed anything");
    const after = await request("GET", "/api/settings", null, admin);
    for (const key of ["mdm_source", "contract_source", "screening_source", "kanban_source", "customer_source"]) {
      assert(`${key} still 'local'`, (after.body[key] || "local") === "local", after.body[key]);
    }
    assert("shipment_sidebar_order untouched", after.body.shipment_sidebar_order === origOrder);

    console.log("\nAn ordinary, legitimate setting is unaffected — operator can still use this route");
    const ordinary = await request("PUT", "/api/settings", { gp_target_pct: "7" }, opToken);
    assert("ordinary key accepted (200)", ordinary.status === 200 && ordinary.body.gp_target_pct === "7", JSON.stringify(ordinary.body));
    await request("PUT", "/api/settings", { gp_target_pct: "" }, admin); // restore

    console.log("\nAn admin can still use the generic route for these keys (no false block)");
    const adminTry = await request("PUT", "/api/settings", { mdm_source: "local" }, admin);
    assert("admin accepted (200)", adminTry.status === 200 && adminTry.body.mdm_source === "local", JSON.stringify(adminTry.body));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const adminToken = await login("claudeagent@localhost", "TestFixture!2026Zq").catch(() => null);
    if (adminToken && opUserId) await request("DELETE", `/api/users/${opUserId}`, null, adminToken).catch(() => {});
  }
})();
