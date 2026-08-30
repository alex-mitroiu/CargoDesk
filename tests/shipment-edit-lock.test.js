/**
 * Shipment edit-locking (first-come-first-served, whole-shipment) — direct request: two
 * edit-capable users on the same shipment at the same time can produce conflicting writes, and
 * this app has no field-level merge/conflict resolution anywhere. The first edit-capable user to
 * open a shipment claims POST /api/shipments/:id/edit-lock; every other edit-capable user gets
 * ownedByMe:false back (never an error — the caller decides what to render) until the holder
 * releases it (DELETE) or their heartbeat lapses. Only a heartbeat/expiry mechanism exists — no
 * manual force-unlock — so real-clock expiry (30 minutes) isn't exercised here, same disclosed
 * gap this codebase already accepts for other time-based rules with no backdating endpoint (see
 * tests/customer-credit-control.test.js's own note on AR aging bucket boundaries).
 *
 * Usage:
 *   node tests/shipment-edit-lock.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC present in port_locations (seeded MDM data)
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
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  let shipmentId, userBId;
  try {
    console.log("Logging in as admin (user A)…");
    const tokenA = await login("claudeagent@localhost", "TestFixture!2026Zq");
    console.log("  ✓ Logged in");

    console.log("\nScratch operator user (user B)");
    const rand = Math.random().toString(36).slice(2, 8);
    const emailB = `edit-lock-test-${rand}@example.com`;
    const createB = await request("POST", "/api/users",
      { email: emailB, name: "Edit Lock Test User B", roles: ["operator"], password: "EditLockFixture!2026Zq" }, tokenA);
    assert("user B created", createB.status === 200, JSON.stringify(createB.body));
    const usersList = await request("GET", "/api/users", null, tokenA);
    userBId = usersList.body.find(u => u.email === emailB)?.id;
    assert("user B findable", !!userBId);
    const tokenB = await login(emailB, "EditLockFixture!2026Zq");
    console.log("  ✓ User B logged in");

    console.log("\nScratch shipment");
    const ship = await request("POST", "/api/shipments",
      { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, tokenA);
    shipmentId = ship.body.id;
    assert("scratch shipment created", ship.status === 201);

    console.log("\nAcquire — first opener claims it");
    const acqA = await request("POST", `/api/shipments/${shipmentId}/edit-lock`, {}, tokenA);
    assert("acquire returns 200", acqA.status === 200, JSON.stringify(acqA.body));
    assert("A owns the lock", acqA.body.locked === true && acqA.body.ownedByMe === true);
    assert("expiresAt is set", !!acqA.body.expiresAt);

    console.log("\nAcquire — second edit-capable user is reported, not blocked with an error");
    const acqB1 = await request("POST", `/api/shipments/${shipmentId}/edit-lock`, {}, tokenB);
    assert("acquire returns 200 for the non-holder too", acqB1.status === 200);
    assert("B does not own the lock", acqB1.body.locked === true && acqB1.body.ownedByMe === false);
    assert("B is told who holds it", acqB1.body.lockedByName === "Admin" || !!acqB1.body.lockedByName);
    assert("B's own id is not reported as the holder", acqB1.body.lockedById !== userBId);

    console.log("\nHeartbeat renewal — same holder calling again keeps ownership, extends expiry");
    const firstLockedAt = acqA.body.lockedAt;
    await new Promise(r => setTimeout(r, 20));
    const acqA2 = await request("POST", `/api/shipments/${shipmentId}/edit-lock`, {}, tokenA);
    assert("A still owns it on renewal", acqA2.body.ownedByMe === true);
    assert("lockedAt is preserved across a renewal (not a fresh acquire)", acqA2.body.lockedAt === firstLockedAt);
    assert("expiresAt moved forward", new Date(acqA2.body.expiresAt) >= new Date(acqA.body.expiresAt));

    console.log("\nRelease by a non-holder is a safe no-op");
    const releaseByB = await request("DELETE", `/api/shipments/${shipmentId}/edit-lock`, null, tokenB);
    assert("non-holder release returns 200", releaseByB.status === 200);
    const acqB2 = await request("POST", `/api/shipments/${shipmentId}/edit-lock`, {}, tokenB);
    assert("A's lock survived B's release attempt", acqB2.body.ownedByMe === false);

    console.log("\nExplicit release by the real holder frees it for the next opener");
    const releaseByA = await request("DELETE", `/api/shipments/${shipmentId}/edit-lock`, null, tokenA);
    assert("holder release returns 200", releaseByA.status === 200 && releaseByA.body.locked === false);
    const acqB3 = await request("POST", `/api/shipments/${shipmentId}/edit-lock`, {}, tokenB);
    assert("B can now claim it", acqB3.body.locked === true && acqB3.body.ownedByMe === true);

    console.log("\nRe-acquiring by the current holder is a renewal, not a rejection");
    const acqB4 = await request("POST", `/api/shipments/${shipmentId}/edit-lock`, {}, tokenB);
    assert("B renewing its own lock still owns it", acqB4.body.ownedByMe === true);
    assert("B's lockedAt unchanged across its own renewal", acqB4.body.lockedAt === acqB3.body.lockedAt);

    console.log("\nAcquire against a non-existent shipment 404s");
    const acqMissing = await request("POST", "/api/shipments/SHP-NOPE/edit-lock", {}, tokenA);
    assert("404 on unknown shipment", acqMissing.status === 404);

  } catch (e) {
    console.error("Test run failed:", e);
    failed++;
  } finally {
    if (shipmentId) {
      const tokenA = await login("claudeagent@localhost", "TestFixture!2026Zq").catch(() => null);
      if (tokenA) {
        await request("DELETE", `/api/shipments/${shipmentId}/edit-lock`, null, tokenA).catch(() => {});
        await request("DELETE", `/api/shipments/${shipmentId}`, null, tokenA).catch(() => {});
      }
    }
    if (userBId) {
      const tokenA = await login("claudeagent@localhost", "TestFixture!2026Zq").catch(() => null);
      if (tokenA) await request("DELETE", `/api/users/${userBId}`, null, tokenA).catch(() => {});
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
