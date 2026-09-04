/**
 * User Management Hardening (TKT-LSIFS0) — the small/self-contained batch:
 *   TKT-9RSZ3U  Email format validation on POST /api/users
 *   TKT-3DSIDN  Audit-log scope-item and access-config changes
 *   TKT-6MLBG2  Release a deactivated user's shipment edit lock
 *   TKT-67EDF3  Restrict credential settings writes to admin-only
 *   TKT-7J92C4  password_changed_at exposed + actually stamped on an admin password reset
 *   TKT-60HO4D  Legacy user_access_configs mechanism retired as dead code
 *
 * Usage:
 *   node tests/user-management-hardening.test.js
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

async function login(email, password) {
  const { status, body } = await request("POST", "/api/auth/login", { email, password });
  if (status !== 200 || !body.token) throw new Error(`Login failed for ${email} (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  const adminToken = await login("claudeagent@localhost", "TestFixture!2026Zq");
  const cleanup = [];

  try {
    console.log("── TKT-9RSZ3U — email format validation ──");
    const badEmail = await request("POST", "/api/users", {
      email: "not-an-email", name: "Bad Email Fixture", roles: ["viewer"], password: "GoodPolicyPassword!2026",
    }, adminToken);
    assert("malformed email rejected on create", badEmail.status >= 400, JSON.stringify(badEmail.body));
    const usersAfterBad = (await request("GET", "/api/users", null, adminToken)).body;
    assert("no user was created for the rejected malformed-email request", !usersAfterBad.some(u => u.name === "Bad Email Fixture"));

    // operator, not viewer — this same fixture is reused below by TKT-6MLBG2's edit-lock test,
    // which needs shipmentWrite access to acquire a lock in the first place.
    const goodEmail = `umh-${Date.now()}@test.local`;
    const created = await request("POST", "/api/users", {
      email: goodEmail, name: "Good Email Fixture", roles: ["operator"], password: "GoodPolicyPassword!2026",
    }, adminToken);
    assert("well-formed email still accepted", created.status === 200 || created.status === 201, JSON.stringify(created.body));
    const userId = (await request("GET", "/api/users", null, adminToken)).body.find(u => u.email === goodEmail)?.id;
    cleanup.push(() => request("DELETE", `/api/users/${userId}`, null, adminToken));

    console.log("\n── TKT-3DSIDN — scope-item audit logging ──");
    // The access-config half of this ticket's original scope was retired outright in the same
    // batch (TKT-60HO4D — user_access_configs had 0 live rows, 0 frontend call sites, and was
    // OR'd into applyShipmentAccessFilter but never contributed anything) rather than kept
    // logging events for a route that no longer exists.
    const scopeAdd = await request("POST", `/api/users/${userId}/scope`, { role: "operator", itemType: "carrier", value: "MAEU", label: "Test" }, adminToken);
    assert("scope item created", scopeAdd.status === 200 || scopeAdd.status === 201, JSON.stringify(scopeAdd.body));
    const scopeItemId = scopeAdd.body.id;
    const eventsAfterScopeAdd = await request("GET", "/api/admin/events?limit=5&action=SCOPE_ITEM_CREATED", null, adminToken);
    assert("SCOPE_ITEM_CREATED event logged", eventsAfterScopeAdd.body.results.some(e => e.target_id === userId), JSON.stringify(eventsAfterScopeAdd.body.results?.[0]));

    const scopeDel = await request("DELETE", `/api/scope-items/${scopeItemId}`, null, adminToken);
    assert("scope item deleted", scopeDel.status === 200, JSON.stringify(scopeDel.body));
    const eventsAfterScopeDel = await request("GET", "/api/admin/events?limit=5&action=SCOPE_ITEM_DELETED", null, adminToken);
    assert("SCOPE_ITEM_DELETED event logged with correct user as target", eventsAfterScopeDel.body.results.some(e => e.target_id === userId), JSON.stringify(eventsAfterScopeDel.body.results?.[0]));

    console.log("\n── TKT-60HO4D — legacy user_access_configs routes are gone ──");
    const legacyList = await request("GET", `/api/users/${userId}/access-configs`, null, adminToken);
    assert("GET .../access-configs no longer exists (404)", legacyList.status === 404, JSON.stringify(legacyList.body));
    const legacyCreate = await request("POST", `/api/users/${userId}/access-configs`, { label: "x" }, adminToken);
    assert("POST .../access-configs no longer exists (404)", legacyCreate.status === 404, JSON.stringify(legacyCreate.body));

    console.log("\n── TKT-6MLBG2 — deactivation releases a held shipment edit lock ──");
    const scratchShipment = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, adminToken);
    const shipmentId = scratchShipment.body.id;
    cleanup.push(() => request("DELETE", `/api/shipments/${shipmentId}`, null, adminToken));

    const lockToken = await login(goodEmail, "GoodPolicyPassword!2026");
    const lockAcquire = await request("POST", `/api/shipments/${shipmentId}/edit-lock`, {}, lockToken);
    assert("scratch user acquired the edit lock", lockAcquire.status === 200 && lockAcquire.body.ownedByMe === true, JSON.stringify(lockAcquire.body));

    const lockCheckBeforeDeactivate = await request("POST", `/api/shipments/${shipmentId}/edit-lock`, {}, adminToken);
    assert("a different user is correctly blocked while the lock is held", lockCheckBeforeDeactivate.body.ownedByMe === false, JSON.stringify(lockCheckBeforeDeactivate.body));

    const deactivate = await request("PATCH", `/api/users/${userId}`, { isActive: false }, adminToken);
    assert("deactivation returns 200", deactivate.status === 200, JSON.stringify(deactivate.body));

    const lockCheckAfterDeactivate = await request("POST", `/api/shipments/${shipmentId}/edit-lock`, {}, adminToken);
    assert("lock released immediately — another user can now acquire it, no 30-min wait", lockCheckAfterDeactivate.body.ownedByMe === true, JSON.stringify(lockCheckAfterDeactivate.body));
    await request("DELETE", `/api/shipments/${shipmentId}/edit-lock`, null, adminToken);

    console.log("\n── TKT-67EDF3 — credential settings are admin-only on PUT /api/settings ──");
    const opEmail = `umh-operator-${Date.now()}@test.local`;
    const opCreate = await request("POST", "/api/users", { email: opEmail, name: "Operator Fixture", roles: ["operator"], password: "GoodPolicyPassword!2026" }, adminToken);
    const opUserId = (await request("GET", "/api/users", null, adminToken)).body.find(u => u.email === opEmail)?.id;
    cleanup.push(() => request("DELETE", `/api/users/${opUserId}`, null, adminToken));
    const opToken = await login(opEmail, "GoodPolicyPassword!2026");

    const opTriesSecret = await request("PUT", "/api/settings", { ai_api_key: "sk-should-not-be-allowed" }, opToken);
    assert("operator is rejected when writing a credential field (403)", opTriesSecret.status === 403, JSON.stringify(opTriesSecret.body));

    const opTriesNormal = await request("PUT", "/api/settings", { demo_schedules_enabled: "1" }, opToken);
    assert("operator can still write an ordinary (non-credential) setting", opTriesNormal.status === 200, JSON.stringify(opTriesNormal.body));

    const adminSetsSecret = await request("PUT", "/api/settings", { ai_api_key: "" }, adminToken);
    assert("admin can still write credential fields (sent blank here to avoid touching a real configured key)", adminSetsSecret.status === 200, JSON.stringify(adminSetsSecret.body));

    console.log("\n── TKT-7J92C4 — password_changed_at exposed and stamped on reset ──");
    const beforeReset = (await request("GET", "/api/users", null, adminToken)).body.find(u => u.id === userId);
    assert("passwordChangedAt is present on the user list response", !!beforeReset.passwordChangedAt, JSON.stringify(beforeReset));

    await new Promise(r => setTimeout(r, 20)); // ensure a real timestamp delta
    const resetResp = await request("PATCH", `/api/users/${userId}`, { password: "FreshResetPassword!2026" }, adminToken);
    assert("admin password reset returns 200", resetResp.status === 200, JSON.stringify(resetResp.body));
    const afterReset = (await request("GET", "/api/users", null, adminToken)).body.find(u => u.id === userId);
    assert("passwordChangedAt advances on an admin-initiated reset",
      new Date(afterReset.passwordChangedAt).getTime() > new Date(beforeReset.passwordChangedAt).getTime(),
      `before=${beforeReset.passwordChangedAt} after=${afterReset.passwordChangedAt}`);
    // This fixture was deactivated earlier in the TKT-6MLBG2 block above — reactivate first so
    // this assertion tests the password reset itself, not the (correct, unrelated) is_active gate.
    await request("PATCH", `/api/users/${userId}`, { isActive: true }, adminToken);
    const loginWithReset = await request("POST", "/api/auth/login", { email: goodEmail, password: "FreshResetPassword!2026" });
    assert("the reset password actually works for login", loginWithReset.status === 200 && !!loginWithReset.body.token, JSON.stringify(loginWithReset.body));

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
