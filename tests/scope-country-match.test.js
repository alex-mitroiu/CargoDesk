/**
 * User scope — 'country' item type now matches on either POL or POD (TKT-M7XHLA).
 *
 * matchesScopeItem's 'country' branch (server.js) previously checked only
 * portCountryMap[shipment.pol] — a user scoped to a country could not see a shipment whose
 * destination (POD) was in that country but whose origin (POL) was somewhere else, a real gap
 * confirmed during the 2026-09-03 user-management audit. Fixed to match on either end, the same
 * way 'trade_lane' already treats both ends of a lane.
 *
 * Usage:
 *   node tests/scope-country-match.test.js
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

(async () => {
  const adminToken = await login("claudeagent@localhost", "TestFixture!2026Zq");
  const cleanup = [];

  try {
    console.log("Create three scratch shipments to probe every side of the fix");
    // podOnly: POD is in the scoped country, POL is not — the exact gap this fix closes.
    // polOnly: POL is in the scoped country, POD is not — already worked before the fix.
    // neither: neither end is in the scoped country — proves the fix isn't over-broad.
    const podOnlyRes = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, adminToken);
    const polOnlyRes  = await request("POST", "/api/shipments", { pol: "USLAX", pod: "DEHAM", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, adminToken);
    const neitherRes  = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "DEHAM", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, adminToken);
    assert("POD-only scratch shipment created", podOnlyRes.status === 200 || podOnlyRes.status === 201);
    assert("POL-only scratch shipment created", polOnlyRes.status === 200 || polOnlyRes.status === 201);
    assert("neither-end scratch shipment created", neitherRes.status === 200 || neitherRes.status === 201);
    const podOnly = podOnlyRes.body, polOnly = polOnlyRes.body, neither = neitherRes.body;
    cleanup.push(() => request("DELETE", `/api/shipments/${podOnly.id}`, null, adminToken));
    cleanup.push(() => request("DELETE", `/api/shipments/${polOnly.id}`, null, adminToken));
    cleanup.push(() => request("DELETE", `/api/shipments/${neither.id}`, null, adminToken));

    console.log("\nCreate a scratch user scoped to country US");
    const email = `scope-country-${Date.now()}@test.local`;
    const createUserRes = await request("POST", "/api/users", {
      name: "Scope Country Fixture", email, password: "ScopeCountryFixture!2026Zq", roles: ["viewer"],
    }, adminToken);
    assert("scoped test user created", createUserRes.status === 200 || createUserRes.status === 201);
    const usersListRes = await request("GET", "/api/users", null, adminToken);
    const newUser = (Array.isArray(usersListRes.body) ? usersListRes.body : usersListRes.body.results).find(u => u.email === email);
    const scopedUserId = newUser.id;
    cleanup.push(() => request("DELETE", `/api/users/${scopedUserId}`, null, adminToken));

    const scopeRes = await request("POST", `/api/users/${scopedUserId}/scope`, { role: "viewer", itemType: "country", value: "US", label: "US-scoped fixture" }, adminToken);
    assert("country scope item created", scopeRes.status === 200 || scopeRes.status === 201, JSON.stringify(scopeRes.body));
    const scopeItemId = scopeRes.body.id;
    cleanup.push(() => request("DELETE", `/api/scope-items/${scopeItemId}`, null, adminToken));

    const scopedToken = await login(email, "ScopeCountryFixture!2026Zq");
    const listRes = await request("GET", "/api/shipments", null, scopedToken);
    const ids = (Array.isArray(listRes.body) ? listRes.body : listRes.body.results).map(s => s.id);

    assert("POD-in-country shipment IS visible (the fixed gap — POL alone used to miss this)", ids.includes(podOnly.id));
    assert("POL-in-country shipment is still visible (unchanged prior behavior)", ids.includes(polOnly.id));
    assert("neither-end shipment stays excluded (fix isn't over-broad)", !ids.includes(neither.id));

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
