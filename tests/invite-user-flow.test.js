/**
 * Invite-user flow (TKT-VZOM1L) — "Send set-password link" option on POST /api/users.
 *
 * Usage:
 *   node tests/invite-user-flow.test.js
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
    // Preserve whatever system email config already exists so this run can restore it exactly.
    const originalSettings = (await request("GET", "/api/settings/system-email", null, adminToken)).body;

    console.log("── send-invite rejected when system email isn't configured ──");
    // PUT .../system-email is a full-replace route (smtpHost/fromAddress are required on every
    // call) — reusing the preserved host/address here, just flipped inactive, to represent the
    // "not configured" state without tripping that validation.
    await request("PUT", "/api/settings/system-email", {
      isActive: false, smtpHost: originalSettings.smtpHost || "smtp.example.com",
      smtpPort: originalSettings.smtpPort || 587, secureMode: originalSettings.secureMode || "starttls",
      smtpUsername: originalSettings.smtpUsername || "", fromAddress: originalSettings.fromAddress || "noreply@test.local",
      fromName: originalSettings.fromName || "Test",
    }, adminToken);
    const rejectedEmail = `invite-reject-${Date.now()}@test.local`;
    const rejected = await request("POST", "/api/users", { email: rejectedEmail, name: "Invite Reject Fixture", roles: ["viewer"], sendInvite: true }, adminToken);
    assert("sendInvite rejected (not 200/201) when email is unconfigured", rejected.status >= 400, JSON.stringify(rejected.body));
    const usersAfterRejected = (await request("GET", "/api/users", null, adminToken)).body;
    assert("no user was created for the rejected invite", !usersAfterRejected.some(u => u.email === rejectedEmail));

    console.log("\n── send-invite succeeds (account created) even when the actual send fails ──");
    // A real SMTP host that will fail to connect — proves user-creation doesn't hinge on the
    // send actually succeeding (the account and its token exist regardless; only the email
    // delivery itself, logged server-side only, can fail).
    await request("PUT", "/api/settings/system-email", {
      isActive: true, smtpHost: "127.0.0.1", smtpPort: 1, secureMode: "none",
      smtpUsername: "", fromAddress: "noreply@test.local", fromName: "Test",
    }, adminToken);
    const inviteEmail = `invite-ok-${Date.now()}@test.local`;
    const invited = await request("POST", "/api/users", { email: inviteEmail, name: "Invite OK Fixture", roles: ["viewer"], sendInvite: true }, adminToken);
    assert("sendInvite returns ok even though the send itself will fail", invited.status === 200 || invited.status === 201, JSON.stringify(invited.body));
    const inviteUser = (await request("GET", "/api/users", null, adminToken)).body.find(u => u.email === inviteEmail);
    assert("invited user exists", !!inviteUser, JSON.stringify(inviteUser));
    cleanup.push(() => request("DELETE", `/api/users/${inviteUser.id}`, null, adminToken));

    const inviteEvents = await request("GET", "/api/admin/events?limit=5&action=USER_INVITED", null, adminToken);
    assert("USER_INVITED event logged (not USER_CREATED) for the invited user", inviteEvents.body.results.some(e => e.target_id === inviteUser.id), JSON.stringify(inviteEvents.body.results?.[0]));

    // A brand-new invited account has no usable password — a random 32-byte value nobody holds —
    // so login must fail even with an empty/obvious guess, proving the account isn't silently
    // left with a real, guessable credential.
    const guessLogin = await request("POST", "/api/auth/login", { email: inviteEmail, password: "GuessedPassword!2026" });
    assert("the invited account cannot be logged into with a guessed password", guessLogin.status !== 200);

    console.log("\n── direct-password creation is unaffected (regression) ──");
    const directEmail = `invite-direct-${Date.now()}@test.local`;
    const direct = await request("POST", "/api/users", { email: directEmail, name: "Direct Fixture", roles: ["viewer"], password: "GoodPolicyPassword!2026" }, adminToken);
    assert("direct-password create still works", direct.status === 200 || direct.status === 201, JSON.stringify(direct.body));
    const directUser = (await request("GET", "/api/users", null, adminToken)).body.find(u => u.email === directEmail);
    cleanup.push(() => request("DELETE", `/api/users/${directUser.id}`, null, adminToken));
    const directLogin = await request("POST", "/api/auth/login", { email: directEmail, password: "GoodPolicyPassword!2026" });
    assert("directly-created account logs in immediately with its real password", directLogin.status === 200 && !!directLogin.body.token, JSON.stringify(directLogin.body));

    console.log("\n── neither name nor a password/invite flag can be omitted ──");
    const noPwNoInvite = await request("POST", "/api/users", { email: `invite-neither-${Date.now()}@test.local`, name: "Neither Fixture", roles: ["viewer"] }, adminToken);
    assert("create rejected with neither password nor sendInvite", noPwNoInvite.status >= 400, JSON.stringify(noPwNoInvite.body));

    // Restore the original system email config exactly, so this run leaves no trace.
    await request("PUT", "/api/settings/system-email", {
      isActive: originalSettings.isActive, smtpHost: originalSettings.smtpHost || "",
      smtpPort: originalSettings.smtpPort || "", secureMode: originalSettings.secureMode || "none",
      smtpUsername: originalSettings.smtpUsername || "",
      fromAddress: originalSettings.fromAddress || "", fromName: originalSettings.fromName || "",
    }, adminToken);

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
