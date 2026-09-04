/**
 * Auth / user administration (routes/auth.js) — smoke tests
 *
 * Covers the parts of routes/auth.js NOT already exercised by tests/password-reset.test.js
 * (forgot/reset-password, system-email settings) or tests/rate-limiting.test.js (login,
 * sso/init throttling): /api/auth/me, /api/auth/logout, /api/auth/change-password, SSO
 * config/callback guard branches, user PATCH/DELETE/revoke-sessions, admin events, access
 * configs, and scope items.
 *
 * Usage:
 *   node tests/auth-admin.test.js
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

// Follows a redirect once without an Authorization header — used for the SSO endpoints,
// which are public and respond with a 302 (init) or redirect-with-query-params (callback).
function requestNoRedirect(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, hostname: "localhost", port: 3001, path }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function login(email = "claudeagent@localhost", password = "TestFixture!2026Zq") {
  return request("POST", "/api/auth/login", { email, password });
}

(async () => {
  try {
    console.log("Logging in…");
    const loginRes = await login();
    if (loginRes.status !== 200 || !loginRes.body.token) throw new Error(`Login failed: ${JSON.stringify(loginRes.body)}`);
    const token = loginRes.body.token;
    console.log("  ✓ Logged in");

    console.log("\nGET /api/auth/me");
    const me = await request("GET", "/api/auth/me", null, token);
    assert("me returns 200", me.status === 200);
    assert("me includes passwordExpired flag", "passwordExpired" in me.body);
    assert("me email matches", me.body.email === "claudeagent@localhost");
    // Real bug fix: this used to return the raw JSON-text DB column for roles (a literal
    // string like '["admin"]'), never parsed — App.jsx's Array.isArray(user.roles) check then
    // silently fell back to the single legacy `role` field on every silent session restore
    // (a page reload with an already-valid token — the common case, not fresh login).
    assert("me returns roles as a real array, not a JSON-text string", Array.isArray(me.body.roles), JSON.stringify(me.body.roles));
    assert("me's roles array actually contains this account's roles", me.body.roles.includes("admin"), JSON.stringify(me.body.roles));
    const meNoAuth = await request("GET", "/api/auth/me", null, null);
    assert("me without a token is rejected (401)", meNoAuth.status === 401);

    console.log("\nPOST /api/auth/logout — always ok, no auth required");
    const logout = await request("POST", "/api/auth/logout", {}, null);
    assert("logout returns 200 ok:true", logout.status === 200 && logout.body.ok === true);

    console.log("\nGET /api/auth/sso/config — public, reflects current settings (disabled in this dev env)");
    const ssoConfig = await request("GET", "/api/auth/sso/config", null, null);
    assert("sso config returns 200", ssoConfig.status === 200);
    assert("sso config has enabled/tenantId/clientId shape", ["enabled", "tenantId", "clientId"].every(k => k in ssoConfig.body));

    console.log("\nGET /api/auth/sso/callback — guard branches (no live Microsoft account needed)");
    const cbDisabled = await requestNoRedirect("GET", "/api/auth/sso/callback?code=abc&state=xyz");
    assert("callback rejected outright while SSO is disabled (this dev env's default)", cbDisabled.status === 404);

    // Flip sso_enabled on just long enough to reach the deeper code/state/nonce guards below —
    // restored to its original value in the finally block, regardless of outcome.
    const settingsBefore = (await request("GET", "/api/settings", null, token)).body;
    await request("PUT", "/api/settings", { sso_enabled: "1" }, token);
    try {
      const cbOauthError = await requestNoRedirect("GET", "/api/auth/sso/callback?error=access_denied");
      assert("callback with an oauth error param rejected (400)", cbOauthError.status === 400);
      const cbNoCode = await requestNoRedirect("GET", "/api/auth/sso/callback");
      assert("callback with no code/state rejected (400)", cbNoCode.status === 400);
      const cbBadState = await requestNoRedirect("GET", "/api/auth/sso/callback?code=abc&state=not-a-real-nonce");
      assert("callback with an unrecognized state rejected (400)", cbBadState.status === 400);
    } finally {
      await request("PUT", "/api/settings", { sso_enabled: settingsBefore.sso_enabled ?? "" }, token);
    }

    console.log("\nScratch user — full lifecycle: create, list, patch (roles/name/finance flag), unlock, revoke-sessions, delete");
    const rand = Math.random().toString(36).slice(2, 8);
    const email = `auth-test-${rand}@example.com`;
    const create = await request("POST", "/api/users", { email, name: "Auth Test User", roles: ["viewer"], password: "AuthTestFixture!2026Zq" }, token);
    assert("user created", create.status === 200, JSON.stringify(create.body));

    const createDup = await request("POST", "/api/users", { email, name: "Dup", roles: ["viewer"], password: "AuthTestFixture!2026Zq" }, token);
    assert("duplicate email rejected", createDup.status >= 400 && /already exists/i.test(createDup.body.error || ""));

    const createBadRole = await request("POST", "/api/users", { email: `bad-${rand}@example.com`, name: "X", roles: ["not-a-role"], password: "AuthTestFixture!2026Zq" }, token);
    assert("invalid role rejected", createBadRole.status >= 400);

    const createMissing = await request("POST", "/api/users", { email: "" }, token);
    assert("missing required fields rejected", createMissing.status >= 400);

    // TKT-JJMD2A — admin-set passwords now go through the same policy self-service
    // change-password/reset-password already enforce; previously bypassed entirely.
    const createWeak = await request("POST", "/api/users", { email: `weak-${rand}@example.com`, name: "Weak Pw", roles: ["viewer"], password: "short" }, token);
    assert("weak password rejected on create", createWeak.status >= 400);
    const weakList = await request("GET", "/api/users", null, token);
    assert("no user was created for the rejected weak-password request", !weakList.body.some(u => u.email === `weak-${rand}@example.com`));

    const list = await request("GET", "/api/users", null, token);
    assert("user list returns 200", list.status === 200);
    const created = list.body.find(u => u.email === email);
    assert("new user present in list", !!created);
    assert("mapUser shape includes roles/tokenVersion/failedAttempts", created && "roles" in created && "tokenVersion" in created && "failedAttempts" in created);
    const userId = created.id;

    const patchName = await request("PATCH", `/api/users/${userId}`, { name: "Renamed Auth User" }, token);
    assert("patch name returns 200", patchName.status === 200);
    const afterName = (await request("GET", "/api/users", null, token)).body.find(u => u.id === userId);
    assert("name actually updated", afterName.name === "Renamed Auth User");
    assert("token_version unchanged by a name-only patch", afterName.tokenVersion === 0);

    const patchRoles = await request("PATCH", `/api/users/${userId}`, { roles: ["operator"] }, token);
    assert("patch roles returns 200", patchRoles.status === 200);
    const afterRoles = (await request("GET", "/api/users", null, token)).body.find(u => u.id === userId);
    assert("roles actually changed", afterRoles.roles.includes("operator"));
    assert("token_version bumped by a roles change", afterRoles.tokenVersion === 1);

    const patchBadRole = await request("PATCH", `/api/users/${userId}`, { roles: ["nonsense"] }, token);
    assert("patch with an invalid role rejected", patchBadRole.status >= 400);

    const patchFinance = await request("PATCH", `/api/users/${userId}`, { canViewFinance: true, allOffices: false }, token);
    assert("patch finance/allOffices flags returns 200", patchFinance.status === 200);
    const afterFinance = (await request("GET", "/api/users", null, token)).body.find(u => u.id === userId);
    assert("canViewFinance flag set", afterFinance.canViewFinance === true);
    assert("allOffices flag cleared", afterFinance.allOffices === false);

    // TKT-JJMD2A — same policy check on PATCH, but only when a password is actually
    // submitted; blank stays "keep existing" and must remain completely unaffected.
    const patchWeak = await request("PATCH", `/api/users/${userId}`, { password: "short" }, token);
    assert("weak password rejected on patch", patchWeak.status >= 400);
    const afterWeak = (await request("GET", "/api/users", null, token)).body.find(u => u.id === userId);
    assert("token_version NOT bumped by a rejected weak-password patch", afterWeak.tokenVersion === afterFinance.tokenVersion);
    const stillOldPassword = await login(email, "AuthTestFixture!2026Zq");
    assert("original password still works after the rejected weak-password patch", stillOldPassword.status === 200);
    const patchBlankPassword = await request("PATCH", `/api/users/${userId}`, { name: "Blank Password Patch" }, token);
    assert("omitting password entirely still succeeds (blank = keep)", patchBlankPassword.status === 200);

    const patchDeactivate = await request("PATCH", `/api/users/${userId}`, { isActive: false }, token);
    assert("patch deactivate returns 200", patchDeactivate.status === 200);
    const afterDeactivate = (await request("GET", "/api/users", null, token)).body.find(u => u.id === userId);
    assert("user now inactive", afterDeactivate.isActive === false);
    assert("token_version bumped again by deactivation", afterDeactivate.tokenVersion === 2);

    const patch404 = await request("PATCH", "/api/users/USR-NOPE", { name: "X" }, token);
    assert("patch 404 for unknown user", patch404.status === 404);

    const revoke = await request("POST", `/api/users/${userId}/revoke-sessions`, {}, token);
    assert("revoke-sessions returns 200", revoke.status === 200);
    const afterRevoke = (await request("GET", "/api/users", null, token)).body.find(u => u.id === userId);
    assert("token_version bumped by explicit revoke", afterRevoke.tokenVersion === 3);
    const revoke404 = await request("POST", "/api/users/USR-NOPE/revoke-sessions", {}, token);
    assert("revoke-sessions 404 for unknown user", revoke404.status === 404);

    const unlock = await request("PATCH", `/api/users/${userId}`, { unlock: true, isActive: true }, token);
    assert("unlock+reactivate returns 200", unlock.status === 200);
    const afterUnlock = (await request("GET", "/api/users", null, token)).body.find(u => u.id === userId);
    assert("user active again", afterUnlock.isActive === true);
    assert("lockedUntil cleared", afterUnlock.lockedUntil === "");

    console.log("\nAccess Configs — create, list, delete");
    const acCreate = await request("POST", `/api/users/${userId}/access-configs`, {
      label: "EU lane", originLane: "FE", destLane: "NAM", polCodes: ["NLRTM"], podCodes: ["USNYC"], carrierCodes: ["MAEU"],
    }, token);
    assert("access config created", acCreate.status === 201, JSON.stringify(acCreate.body));
    assert("access config label round-trips", acCreate.body.label === "EU lane");
    const acList = await request("GET", `/api/users/${userId}/access-configs`, null, token);
    assert("access config list returns 200", acList.status === 200);
    assert("created config present", acList.body.some(c => c.id === acCreate.body.id));
    const acDelete = await request("DELETE", `/api/access-configs/${acCreate.body.id}`, null, token);
    assert("access config delete returns 200", acDelete.status === 200);
    const acDelete404 = await request("DELETE", `/api/access-configs/${acCreate.body.id}`, null, token);
    assert("access config delete 404 on second attempt", acDelete404.status === 404);

    console.log("\nScope Items — create, list, delete");
    const siCreate = await request("POST", `/api/users/${userId}/scope`, {
      role: "operator", itemType: "carrier", value: "MAEU", label: "Maersk only",
    }, token);
    assert("scope item created", siCreate.status === 201, JSON.stringify(siCreate.body));
    const siMissing = await request("POST", `/api/users/${userId}/scope`, { itemType: "carrier" }, token);
    assert("scope item missing value rejected", siMissing.status >= 400);
    const siList = await request("GET", `/api/users/${userId}/scope`, null, token);
    assert("scope item list returns 200", siList.status === 200);
    assert("created scope item present", siList.body.some(s => s.id === siCreate.body.id));
    const siDelete = await request("DELETE", `/api/scope-items/${siCreate.body.id}`, null, token);
    assert("scope item delete returns 200", siDelete.status === 200);
    const siDelete404 = await request("DELETE", `/api/scope-items/${siCreate.body.id}`, null, token);
    assert("scope item delete 404 on second attempt", siDelete404.status === 404);

    console.log("\nAdmin Events — list + filters (our own USER_CREATED/USER_UPDATED events are in there)");
    const events = await request("GET", "/api/admin/events", null, token);
    assert("admin events returns 200", events.status === 200);
    assert("admin events has results/total shape", "results" in events.body && "total" in events.body);
    const eventsFiltered = await request("GET", `/api/admin/events?action=USER_CREATED&limit=5`, null, token);
    assert("admin events filtered by action returns 200", eventsFiltered.status === 200);
    assert("filtered results are all USER_CREATED", eventsFiltered.body.results.every(e => e.action === "USER_CREATED"));
    const eventsByTarget = await request("GET", `/api/admin/events?targetType=user&offset=0&limit=1`, null, token);
    assert("admin events filtered by targetType + paginated returns 200", eventsByTarget.status === 200 && eventsByTarget.body.results.length <= 1);

    console.log("\nchange-password — wrong current password, weak new password, same-as-old, happy path");
    const scratchLogin = await login(email, "AuthTestFixture!2026Zq");
    assert("scratch user can log in with its real password", scratchLogin.status === 200);
    const scratchToken = scratchLogin.body.token;

    const wrongCurrent = await request("POST", "/api/auth/change-password", { currentPassword: "WrongPassword!123", newPassword: "BrandNewFixture!2026Zq" }, scratchToken);
    assert("wrong current password rejected (400, not 401)", wrongCurrent.status === 400);

    const weakNew = await request("POST", "/api/auth/change-password", { currentPassword: "AuthTestFixture!2026Zq", newPassword: "short" }, scratchToken);
    assert("weak new password rejected", weakNew.status >= 400);

    const sameAsOld = await request("POST", "/api/auth/change-password", { currentPassword: "AuthTestFixture!2026Zq", newPassword: "AuthTestFixture!2026Zq" }, scratchToken);
    assert("new password same as current rejected", sameAsOld.status >= 400);

    const changeOk = await request("POST", "/api/auth/change-password", { currentPassword: "AuthTestFixture!2026Zq", newPassword: "BrandNewFixture!2026Zq" }, scratchToken);
    assert("change-password succeeds", changeOk.status === 200 && !!changeOk.body.token);
    const reloginOld = await login(email, "AuthTestFixture!2026Zq");
    assert("old password no longer works", reloginOld.status !== 200);
    const reloginNew = await login(email, "BrandNewFixture!2026Zq");
    assert("new password works", reloginNew.status === 200);

    console.log("\nCleanup");
    await request("DELETE", `/api/users/${userId}`, null, token);
    const delete404 = await request("DELETE", `/api/users/${userId}`, null, token);
    assert("user delete 404 on second attempt", delete404.status === 404);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
