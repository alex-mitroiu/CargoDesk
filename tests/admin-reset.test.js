/**
 * Admin "Reset Demo Data" — routes/admin-reset.js. The natural sibling of Zero-Script
 * Onboarding (db/cargodesk.sample.db, v0.79.0): that one seeds a clean database on first boot
 * when none exists yet; this resets an already-running one in place, on demand — wiping every
 * demo/business table while preserving MDM reference data, sanctions data, and app config.
 *
 * DELIBERATE SCOPE, same class of decision this codebase already made for
 * POST /api/sanctions/sync|sync-csl|import-csv (v0.72.2's own changelog: "destructively replaces
 * the live synced [...] dataset other tests depend on"): the actual successful wipe-and-reseed
 * path is NOT exercised here, since it would destroy this dev database's own real history —
 * every demo shipment, customer, and verification artifact accumulated across this project's
 * whole session history, deliberately kept (see the standing "don't clean up verification data"
 * convention). This file only covers the route's guardrails, all fully safe/non-destructive:
 * the confirmation-string requirement, the admin-only role gate, and the preview endpoint's
 * shape. The real end-to-end wipe+reseed behavior was verified manually against a full
 * backup/restore cycle of the real dev database (see the actual verification pass, not an
 * automated test) — a real gap, disclosed, not faked into a false-confidence test.
 *
 * Usage:
 *   node tests/admin-reset.test.js
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
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login("claudeagent@localhost", "TestFixture!2026Zq");
    console.log("  ✓ Logged in");

    console.log("\nGET /api/admin/reset-demo-data/preview — shape and content");
    const preview = await request("GET", "/api/admin/reset-demo-data/preview", null, token);
    assert("preview returns 200", preview.status === 200, JSON.stringify(preview.body));
    assert("preview has preserve[] and reset[] arrays",
      Array.isArray(preview.body?.preserve) && Array.isArray(preview.body?.reset));
    assert("MDM tables appear in preserve, not reset",
      preview.body.preserve.includes("carriers") && preview.body.preserve.includes("vessels") &&
      !preview.body.reset.includes("carriers") && !preview.body.reset.includes("vessels"));
    assert("sanctions tables are preserved",
      preview.body.preserve.includes("sanctions_entries") && preview.body.preserve.includes("sanctions_syncs"));
    assert("app_settings is preserved", preview.body.preserve.includes("app_settings"));
    assert("business tables appear in reset, not preserve",
      preview.body.reset.includes("shipments") && preview.body.reset.includes("customers") &&
      preview.body.reset.includes("users") &&
      !preview.body.preserve.includes("shipments") && !preview.body.preserve.includes("customers"));

    console.log("\nPOST /api/admin/reset-demo-data — confirmation-string guard (safe, never actually resets)");
    const noConfirm = await request("POST", "/api/admin/reset-demo-data", {}, token);
    assert("missing confirm string rejected", noConfirm.status >= 400);
    const wrongConfirm = await request("POST", "/api/admin/reset-demo-data", { confirm: "yes please" }, token);
    assert("wrong confirm string rejected", wrongConfirm.status >= 400);
    const lowercaseConfirm = await request("POST", "/api/admin/reset-demo-data", { confirm: "reset" }, token);
    assert("lowercase confirm string rejected (case-sensitive)", lowercaseConfirm.status >= 400);

    console.log("\nRole gate — admin-only");
    const stamp = Date.now();
    const scratchEmail = `admin-reset-test-${stamp}@localhost`;
    const createUser = await request("POST", "/api/users",
      { email: scratchEmail, name: "Admin Reset Test Viewer", roles: ["viewer"], password: "TestFixture!2026Zq" }, token);
    assert("scratch viewer created", createUser.status === 200, JSON.stringify(createUser.body));
    const usersList = await request("GET", "/api/users", null, token);
    const scratchUserId = usersList.body.find(u => u.email === scratchEmail)?.id;
    assert("scratch viewer findable", !!scratchUserId);

    const viewerToken = await login(scratchEmail, "TestFixture!2026Zq");
    const viewerPreview = await request("GET", "/api/admin/reset-demo-data/preview", null, viewerToken);
    assert("non-admin blocked from the preview endpoint", viewerPreview.status === 403);
    const viewerReset = await request("POST", "/api/admin/reset-demo-data", { confirm: "RESET" }, viewerToken);
    assert("non-admin blocked from resetting (even with the correct confirm string)", viewerReset.status === 403);

    console.log("\nCleanup");
    if (scratchUserId) await request("DELETE", `/api/users/${scratchUserId}`, null, token).catch(() => {});

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
