/**
 * Loop Codes MDM registry — CRUD + rotation + the /resolve lookup — smoke tests
 *
 * Usage:
 *   node tests/loop-codes.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - Real UN/LOCODEs NLRTM, DEHAM, USNYC present in port_locations (seeded MDM data)
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
  let loopId = null;
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");

    const code = `TST${Date.now() % 100000}`;

    console.log("\nResolve an unregistered code returns null, not an error");
    const missResolve = await request("GET", `/api/loop-codes/resolve?code=${code}`, null, token);
    assert("unregistered resolve is 200 with null body", missResolve.status === 200 && missResolve.body === null, JSON.stringify(missResolve.body));

    console.log("\nCreate a loop code");
    const created = await request("POST", "/api/loop-codes", {
      code, name: "Test Atlantic Loop", carrierCode: "HLCU", frequencyDays: 7, roundTripDays: 35,
    }, token);
    assert("created", created.status === 201 && !!created.body.id, JSON.stringify(created.body));
    assert("code uppercased", created.body.code === code.toUpperCase());
    assert("starts with zero ports", created.body.portCount === 0);
    loopId = created.body.id;

    console.log("\nDuplicate code is rejected");
    const dup = await request("POST", "/api/loop-codes", { code, name: "Duplicate" }, token);
    assert("duplicate code rejected", dup.status === 400, JSON.stringify(dup.body));

    console.log("\nRotation needs at least 2 ports");
    const tooShort = await request("PUT", `/api/loop-codes/${loopId}/rotation`, { ports: [{ portUnlocode: "NLRTM" }] }, token);
    assert("single-port rotation rejected", tooShort.status === 400, JSON.stringify(tooShort.body));

    console.log("\nRotation with an unknown port is rejected");
    const badPort = await request("PUT", `/api/loop-codes/${loopId}/rotation`, {
      ports: [{ portUnlocode: "NLRTM" }, { portUnlocode: "ZZZZZ" }],
    }, token);
    assert("unknown port rejected", badPort.status === 400, JSON.stringify(badPort.body));

    console.log("\nSave a real 3-port rotation");
    const saved = await request("PUT", `/api/loop-codes/${loopId}/rotation`, {
      ports: [
        { portUnlocode: "NLRTM", transitDayOffset: 0 },
        { portUnlocode: "DEHAM", transitDayOffset: 2 },
        { portUnlocode: "USNYC", transitDayOffset: 14 },
      ],
    }, token);
    assert("rotation saved", saved.status === 200 && saved.body.length === 3, JSON.stringify(saved.body));
    assert("sequence order preserved", saved.body[0].portUnlocode === "NLRTM" && saved.body[2].portUnlocode === "USNYC");
    assert("day offsets round-trip", saved.body[1].transitDayOffset === 2);
    assert("port name resolved via join", !!saved.body[0].portName);

    console.log("\nGet returns the loop with its rotation");
    const got = await request("GET", `/api/loop-codes/${loopId}`, null, token);
    assert("get includes ports", got.body.ports?.length === 3);
    assert("get portCount matches", got.body.portCount === 3);

    console.log("\nResolve now finds it, active only");
    const resolved = await request("GET", `/api/loop-codes/resolve?code=${code}`, null, token);
    assert("resolve finds the loop", resolved.body?.id === loopId, JSON.stringify(resolved.body));
    assert("resolve carries the ordered rotation", resolved.body?.ports?.length === 3);

    console.log("\nReplacing the rotation drops the old rows (not additive)");
    const replaced = await request("PUT", `/api/loop-codes/${loopId}/rotation`, {
      ports: [{ portUnlocode: "USNYC" }, { portUnlocode: "NLRTM" }],
    }, token);
    assert("replacement rotation has exactly 2 rows", replaced.status === 200 && replaced.body.length === 2, JSON.stringify(replaced.body));

    console.log("\nUpdate the loop's own fields");
    const updated = await request("PUT", `/api/loop-codes/${loopId}`, {
      name: "Renamed Loop", carrierCode: "MAEU", frequencyDays: 14, roundTripDays: 40, isActive: true,
    }, token);
    assert("update persisted", updated.status === 200 && updated.body.name === "Renamed Loop" && updated.body.carrierCode === "MAEU");

    console.log("\nDeactivating hides it from /resolve");
    await request("PUT", `/api/loop-codes/${loopId}`, { name: "Renamed Loop", isActive: false }, token);
    const resolveInactive = await request("GET", `/api/loop-codes/resolve?code=${code}`, null, token);
    assert("inactive loop is not resolved", resolveInactive.body === null, JSON.stringify(resolveInactive.body));

    console.log("\nList includes the loop");
    const list = await request("GET", "/api/loop-codes", null, token);
    assert("list includes created loop", list.body.some(l => l.id === loopId));

    console.log("\nCleanup");
    const del = await request("DELETE", `/api/loop-codes/${loopId}`, null, token);
    assert("delete ok", del.status === 200);
    const getAfterDelete = await request("GET", `/api/loop-codes/${loopId}`, null, token);
    assert("get 404s after delete", getAfterDelete.status === 404);
    loopId = null;

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    if (loopId) await request("DELETE", `/api/loop-codes/${loopId}`, null, null).catch(() => {});
    process.exit(1);
  }
})();
