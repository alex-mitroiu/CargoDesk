/**
 * sso_enforce_exclusive (TKT-8P35S0) — when on alongside sso_enabled, local password login is
 * refused for every account except the break-glass set (BREAK_GLASS_EMAILS env, defaulting to
 * this project's two already-documented standing recovery accounts, both of which the fixture
 * password below matches — see CLAUDE.md's "Fallback / test admin accounts" note). Whatever
 * access control the org enforces on the Entra side (MFA, group assignment, offboarding) becomes
 * the only real door in for everyone else.
 *
 * Usage:
 *   node tests/sso-enforce-exclusive.test.js
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
  return request("POST", "/api/auth/login", { email, password });
}

(async () => {
  const adminLogin = await login("claudeagent@localhost", "TestFixture!2026Zq");
  if (adminLogin.status !== 200) throw new Error(`Admin login failed: ${JSON.stringify(adminLogin.body)}`);
  const adminToken = adminLogin.body.token;
  const cleanup = [];
  let scratchEmail, scratchPassword;

  try {
    console.log("Baseline — read current sso_enabled/sso_enforce_exclusive so we can restore them");
    const before = (await request("GET", "/api/settings", null, adminToken)).body;
    const restore = async () => {
      await request("PUT", "/api/settings", { sso_enabled: before.sso_enabled ?? "0" }, adminToken);
      await request("PUT", "/api/settings/sso-enforce-exclusive", { value: before.sso_enforce_exclusive === '1' }, adminToken);
    };
    cleanup.push(restore);

    console.log("\nNon-admin cannot flip sso_enforce_exclusive via either route");
    scratchEmail = `sso-exclusive-${Date.now()}@test.local`;
    scratchPassword = "SsoExclusiveFixture!2026Zq";
    const createRes = await request("POST", "/api/users", { name: "SSO Exclusive Fixture", email: scratchEmail, roles: ["operator"], password: scratchPassword }, adminToken);
    assert("scratch operator user created", createRes.status === 200 || createRes.status === 201);
    const usersList = (await request("GET", "/api/users", null, adminToken)).body;
    const scratchUserId = usersList.find(u => u.email === scratchEmail)?.id;
    cleanup.push(() => request("DELETE", `/api/users/${scratchUserId}`, null, adminToken));
    const scratchToken = (await login(scratchEmail, scratchPassword)).body.token;

    const dedicatedAsOperator = await request("PUT", "/api/settings/sso-enforce-exclusive", { value: true }, scratchToken);
    assert("dedicated route rejects a non-admin (403)", dedicatedAsOperator.status === 403);
    const genericAsOperator = await request("PUT", "/api/settings", { sso_enforce_exclusive: '1' }, scratchToken);
    assert("generic /api/settings route also rejects a non-admin setting this key (403)", genericAsOperator.status === 403);
    // An admin using the generic route for this key is fine — the guard above only exists to
    // close the operator/occ_bk bypass; it doesn't force admins through the dedicated route,
    // matching how contract_source/mdm_source's own dedicated routes already work.
    const genericAsAdmin = await request("PUT", "/api/settings", { sso_enforce_exclusive: '0' }, adminToken);
    assert("generic /api/settings route still allows an admin to set this key", genericAsAdmin.status === 200);

    console.log("\nTurn on sso_enabled + sso_enforce_exclusive as admin");
    await request("PUT", "/api/settings", { sso_enabled: "1" }, adminToken);
    const setExclusive = await request("PUT", "/api/settings/sso-enforce-exclusive", { value: true }, adminToken);
    assert("dedicated route accepts an admin (200)", setExclusive.status === 200);

    console.log("\nA normal password-holding account can no longer log in locally");
    const blockedLogin = await login(scratchEmail, scratchPassword);
    assert("non-break-glass login rejected (403)", blockedLogin.status === 403, JSON.stringify(blockedLogin.body));
    assert("rejection message points at SSO", /Microsoft/i.test(blockedLogin.body.error || ""));

    console.log("\nA break-glass account still logs in locally");
    const breakGlassLogin = await login("claudeagent@localhost", "TestFixture!2026Zq");
    assert("break-glass login still succeeds (200)", breakGlassLogin.status === 200);

    console.log("\nGET /api/auth/sso/config reflects the policy publicly");
    const cfg = await request("GET", "/api/auth/sso/config", null, null);
    assert("sso/config returns 200", cfg.status === 200);
    assert("localLoginDisabled is true", cfg.body.localLoginDisabled === true);

    console.log("\nTurning sso_enforce_exclusive back off restores normal login for everyone");
    await request("PUT", "/api/settings/sso-enforce-exclusive", { value: false }, adminToken);
    const restoredLogin = await login(scratchEmail, scratchPassword);
    assert("non-break-glass login works again once the policy is off", restoredLogin.status === 200);
    const cfgAfter = await request("GET", "/api/auth/sso/config", null, null);
    assert("localLoginDisabled is false again", cfgAfter.body.localLoginDisabled === false);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  } finally {
    for (const fn of cleanup.reverse()) { try { await fn(); } catch {} }
  }
})();
