/**
 * Forgot / Reset Password + System Email Settings — smoke tests
 *
 * Usage:
 *   node tests/password-reset.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001, NODE_ENV != "production" (so the forgot-password
 *     response includes devToken — see routes/auth.js's own comment on why this only exists
 *     outside production)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *
 * Runs the actual reset flow (including a real password change) against a disposable scratch
 * user created for this run, NOT the shared claudeagent fixture every other test file logs in
 * as — a crash partway through this file must never leave the shared admin account's password
 * in an unknown state and break the rest of the suite.
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
  let adminToken, scratchUserId, scratchEmail;
  try {
    console.log("Logging in...");
    adminToken = await login();
    console.log("  ✓ Logged in");

    // system_email_settings is a true singleton (one row, id='system') — unlike every other
    // "scratch X" fixture in this suite, there's no way to re-run this against pristine state
    // without a reset path this route intentionally doesn't expose (there's nothing to delete
    // back to — a real deployment configures this once and leaves it configured). So this
    // checks the response SHAPE (still true regardless of prior runs), not the one-time-only
    // "nothing saved yet" values that a second run of this same file would no longer see.
    console.log("\nSystem Email Settings — current shape (whatever a prior run may have left)");
    let r = await request("GET", "/api/settings/system-email", null, adminToken);
    assert("returns 200", r.status === 200);
    assert("hasPassword is a boolean", typeof r.body.hasPassword === "boolean");
    assert("response never includes a password-shaped field", !("smtpPassword" in r.body) && !("smtp_password" in r.body));

    console.log("\nSystem Email Settings — validation");
    r = await request("PUT", "/api/settings/system-email", { smtpHost: "", fromAddress: "x@x.com" }, adminToken);
    assert("blank host rejected", r.status === 400);
    r = await request("PUT", "/api/settings/system-email", { smtpHost: "h", secureMode: "bogus", fromAddress: "x@x.com" }, adminToken);
    assert("invalid secureMode rejected", r.status === 400);
    r = await request("PUT", "/api/settings/system-email", { smtpHost: "h", fromAddress: "" }, adminToken);
    assert("blank fromAddress rejected", r.status === 400);

    console.log("\nSystem Email Settings — save, then confirm the password never round-trips");
    r = await request("PUT", "/api/settings/system-email", {
      smtpHost: "smtp.example.com", smtpPort: 587, secureMode: "starttls",
      smtpUsername: "reset@cargodesk.local", smtpPassword: "s3cr3t-pw",
      fromAddress: "no-reply@cargodesk.local", fromName: "CargoDesk", isActive: true,
    }, adminToken);
    assert("save returns 200", r.status === 200);
    assert("hasPassword is now true", r.body.hasPassword === true);
    assert("response never includes the actual password value", JSON.stringify(r.body).includes("s3cr3t-pw") === false);

    console.log("\nBlank password on update keeps the existing one");
    r = await request("PUT", "/api/settings/system-email", {
      smtpHost: "smtp.example.com", smtpPort: 587, secureMode: "starttls",
      smtpUsername: "reset@cargodesk.local", smtpPassword: "",
      fromAddress: "no-reply@cargodesk.local", fromName: "CargoDesk Updated", isActive: true,
    }, adminToken);
    assert("update returns 200", r.status === 200);
    assert("hasPassword is still true (kept)", r.body.hasPassword === true);
    assert("fromName was updated", r.body.fromName === "CargoDesk Updated");

    console.log("\nTest-send route against a closed local port — fast, clean failure (not a hang, not a 500 stack trace)");
    r = await request("POST", "/api/settings/system-email/test", {
      to: "someone@example.com", smtpHost: "127.0.0.1", smtpPort: 1, secureMode: "none",
    }, adminToken);
    assert("test-send returns a clean error status", r.status === 502);
    assert("test-send error message present", typeof r.body.error === "string" && r.body.error.length > 0);

    console.log("\nScratch user for the reset-flow tests below");
    scratchEmail = `pwreset-scratch-${Date.now()}@test.local`;
    r = await request("POST", "/api/users", {
      email: scratchEmail, name: "Password Reset Scratch User", roles: ["viewer"], password: "Original-Strong-Pw-2026!",
    }, adminToken);
    assert("scratch user created", r.status === 200 || r.status === 201);
    const usersList = await request("GET", "/api/users", null, adminToken);
    const scratchUser = (usersList.body.users || usersList.body).find(u => u.email === scratchEmail);
    assert("scratch user is findable via GET /api/users", !!scratchUser);
    scratchUserId = scratchUser?.id;

    console.log("\nForgot-password — unknown email gets the same generic response as a real one (no user enumeration)");
    r = await request("POST", "/api/auth/forgot-password", { email: "definitely-not-a-real-user@nowhere.test" });
    assert("unknown email still returns 200", r.status === 200);
    const genericMsg = r.body.message;
    assert("unknown email has no devToken (nothing was generated)", r.body.devToken === undefined);

    console.log("\nForgot-password — real email generates a token, same generic message");
    r = await request("POST", "/api/auth/forgot-password", { email: scratchEmail });
    assert("real email returns 200", r.status === 200);
    assert("message is identical to the unknown-email response", r.body.message === genericMsg);
    assert("devToken present (dev-only convenience — see routes/auth.js)", typeof r.body.devToken === "string" && r.body.devToken.length > 30);
    const rawToken = r.body.devToken;

    console.log("\nReset-password — validation");
    r = await request("POST", "/api/auth/reset-password", { token: "", newPassword: "Whatever12345!" });
    assert("missing token rejected", r.status === 400);
    r = await request("POST", "/api/auth/reset-password", { token: "bogus-token-that-does-not-exist", newPassword: "Whatever12345!" });
    assert("invalid token rejected", r.status === 400);
    r = await request("POST", "/api/auth/reset-password", { token: rawToken, newPassword: "short" });
    assert("weak new password rejected by the same policy change-password uses", r.status === 400);

    console.log("\nReset-password — happy path actually changes the password and logs in with it");
    const newPassword = "Reset-Flow-Test-Pw-2026!";
    r = await request("POST", "/api/auth/reset-password", { token: rawToken, newPassword });
    assert("valid token + strong password returns 200", r.status === 200);
    assert("does not auto-issue a login token (unlike change-password)", r.body.token === undefined);

    const loginWithNew = await request("POST", "/api/auth/login", { email: scratchEmail, password: newPassword });
    assert("can log in with the new password", loginWithNew.status === 200 && !!loginWithNew.body.token);
    const loginWithOld = await request("POST", "/api/auth/login", { email: scratchEmail, password: "Original-Strong-Pw-2026!" });
    assert("can no longer log in with the original password", loginWithOld.status !== 200);

    console.log("\nReset-password — token is single-use (a second attempt with the same token fails)");
    r = await request("POST", "/api/auth/reset-password", { token: rawToken, newPassword: "Another-Strong-Pw-999!" });
    assert("reusing the same token is rejected", r.status === 400);

    // Rate-limit THRESHOLD itself is deliberately NOT asserted here — this file runs with
    // FORGOT_PW_MAX raised (same reasoning as LOGIN_RATE_MAX elsewhere in this suite: many
    // requests in one continuous run from one IP would otherwise trip the real-world default
    // partway through). Verified separately, once, against the unset default: 5 requests
    // succeed, a 6th from the same IP within the hour returns 429 — see routes/auth.js's own
    // forgotPasswordRateLimit for the implementation this proves.

    console.log("\nCleanup");
    if (scratchUserId) {
      const del = await request("DELETE", `/api/users/${scratchUserId}`, null, adminToken);
      assert("scratch user deleted", del.status === 200);
    }

    console.log("\n──────────────────────────────────────────────────");
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    // Best-effort cleanup even on an unexpected failure, so a re-run doesn't accumulate
    // scratch users — never touches the shared claudeagent fixture, only ever this run's own
    // disposable one.
    if (adminToken && scratchUserId) {
      await request("DELETE", `/api/users/${scratchUserId}`, null, adminToken).catch(() => {});
    }
    process.exit(1);
  }
})();
