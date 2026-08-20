/**
 * Organization structure (routes/organization.js + routes/offices.js) — smoke tests
 *
 * Covers Branches CRUD, Org Countries CRUD, Office CRUD + delete-guard, office stats, and
 * user<->office assignments. Previously zero dedicated coverage — these routes are exercised
 * live through OrgPage/BranchPage/CountryPage/OfficePage but had no automated backend test.
 *
 * Usage:
 *   node tests/organization.test.js
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

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost", password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nBranches — create, list, get, update, duplicate-code rejection");
    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    const brnCode = `TB${rand}`;
    const brn = await request("POST", "/api/branches", {
      code: brnCode, name: "Test Branch Rotterdam", countryCode: "NL", locode: "NLRTM", city: "Rotterdam",
    }, token);
    assert("branch created (201-ish 200)", brn.status === 200, JSON.stringify(brn.body));
    const branchId = brn.body.id;
    assert("branch code uppercased", brn.body.code === brnCode);
    assert("branch isActive defaults true", brn.body.isActive === true);

    const dupBrn = await request("POST", "/api/branches", { code: brnCode, name: "Dup", countryCode: "NL" }, token);
    assert("duplicate branch code rejected", dupBrn.status >= 400 && /already exists/i.test(dupBrn.body.error || ""));

    const brnMissing = await request("POST", "/api/branches", { code: "X" }, token);
    assert("branch missing required fields rejected", brnMissing.status >= 400);

    const brnList = await request("GET", "/api/branches", null, token);
    assert("branch list returns 200", brnList.status === 200);
    assert("branch list includes ours with officeCount/userCount", brnList.body.some(b => b.id === branchId && "officeCount" in b));

    const brnGet = await request("GET", `/api/branches/${branchId}`, null, token);
    assert("branch get returns 200", brnGet.status === 200);
    assert("branch get id matches", brnGet.body.id === branchId);

    const brnGet404 = await request("GET", "/api/branches/BRN-NOPE", null, token);
    assert("branch get 404 for unknown id", brnGet404.status === 404);

    const brnUpdate = await request("PUT", `/api/branches/${branchId}`, { name: "Renamed Branch", city: "Amsterdam" }, token);
    assert("branch update returns 200", brnUpdate.status === 200);
    assert("branch name updated", brnUpdate.body.name === "Renamed Branch");
    assert("branch city updated", brnUpdate.body.city === "Amsterdam");

    const brnUpdate404 = await request("PUT", "/api/branches/BRN-NOPE", { name: "X" }, token);
    assert("branch update 404 for unknown id", brnUpdate404.status === 404);

    console.log("\nBranches — offices-in-branch listing (empty before any office is attached)");
    const brnOffices = await request("GET", `/api/branches/${branchId}/offices`, null, token);
    assert("branch offices list returns 200", brnOffices.status === 200);
    assert("no offices assigned yet", brnOffices.body.length === 0);

    console.log("\nOffices — create attached to the branch, update, stats, delete-guard, delete");
    const offCode = `T${rand}`;
    const off = await request("POST", "/api/offices", {
      unlocode: `NL${rand.slice(0, 3)}`, department: "SE", name: "Test Export Office", countryCode: "NL", branchId,
    }, token);
    assert("office created", off.status === 201, JSON.stringify(off.body));
    const officeId = off.body.id;
    assert("office linked to branch", off.body.branchId === branchId);

    const offBadDept = await request("POST", "/api/offices", { unlocode: "NLXXX", department: "ZZ", name: "Bad" }, token);
    assert("invalid department rejected", offBadDept.status >= 400);

    const offMissing = await request("POST", "/api/offices", { unlocode: "", department: "SE", name: "" }, token);
    assert("missing required office fields rejected", offMissing.status >= 400);

    const offDup = await request("POST", "/api/offices", { unlocode: `NL${rand.slice(0, 3)}`, department: "SE", name: "Dup Office" }, token);
    assert("duplicate office code rejected", offDup.status >= 400 && /already exists/i.test(offDup.body.error || ""));

    const brnOfficesAfter = await request("GET", `/api/branches/${branchId}/offices`, null, token);
    assert("branch now shows the new office", brnOfficesAfter.body.some(o => o.id === officeId));

    // No per-route auth() call in routes/offices.js — still gated by server.js's global
    // "require a valid token on all /api/* except /auth|/health|/share" middleware.
    const offListNoAuth = await request("GET", "/api/offices", null, null);
    assert("offices list rejected without a token (global /api gate)", offListNoAuth.status === 401);
    const offList = await request("GET", "/api/offices", null, token);
    assert("offices list returns 200 with a token", offList.status === 200 && offList.body.some(o => o.id === officeId));

    const offUpdate = await request("PUT", `/api/offices/${officeId}`, { name: "Renamed Office", isActive: true }, token);
    assert("office update returns 200", offUpdate.status === 200);
    assert("office name updated", offUpdate.body.name === "Renamed Office");

    const offUpdate404 = await request("PUT", "/api/offices/OFF-NOPE", { name: "X" }, token);
    assert("office update 404 for unknown id", offUpdate404.status === 404);

    const offStats = await request("GET", `/api/offices/${officeId}/stats`, null, token);
    assert("office stats returns 200", offStats.status === 200);
    assert("office stats has office/users/shipmentStats", "office" in offStats.body && "users" in offStats.body && "shipmentStats" in offStats.body);
    assert("office stats emoTotal starts at 0", offStats.body.shipmentStats.emoTotal === 0);

    const offStats404 = await request("GET", "/api/offices/OFF-NOPE/stats", null, token);
    assert("office stats 404 for unknown id", offStats404.status === 404);

    console.log("\nBranch delete is blocked while an office is still assigned");
    const brnDeleteBlocked = await request("DELETE", `/api/branches/${branchId}`, null, token);
    assert("branch delete blocked (office assigned)", brnDeleteBlocked.status >= 400 && /office/i.test(brnDeleteBlocked.body.error || ""));

    console.log("\nUser<->office assignment — assign, set-default, list, unassign (scratch user, never the real fixture account)");
    const scratchUser = await request("POST", "/api/users", {
      email: `org-test-${rand.toLowerCase()}@example.com`, name: "Org Test User",
      roles: ["viewer"], password: "OrgTestFixture!2026Zq",
    }, token);
    assert("scratch user created", scratchUser.status === 200, JSON.stringify(scratchUser.body));
    const scratchUsers = await request("GET", "/api/users", null, token);
    const userId = scratchUsers.body.find(u => u.email === `org-test-${rand.toLowerCase()}@example.com`)?.id;
    assert("scratch user resolvable by email", !!userId);

    const assignOff = await request("POST", `/api/users/${userId}/offices`, { officeId, isDefault: true }, token);
    assert("office assigned to user", assignOff.status === 201, JSON.stringify(assignOff.body));
    assert("assignment marked default", assignOff.body.isDefault === true);

    const assignDupOff = await request("POST", `/api/users/${userId}/offices`, { officeId }, token);
    assert("duplicate assignment rejected", assignDupOff.status >= 400);

    const assignMissingOff = await request("POST", `/api/users/${userId}/offices`, { officeId: "OFF-NOPE" }, token);
    assert("assigning a nonexistent office rejected (404)", assignMissingOff.status === 404);

    const userOffices = await request("GET", `/api/users/${userId}/offices`, null, token);
    assert("user offices list returns 200", userOffices.status === 200);
    assert("assigned office appears, marked default", userOffices.body.some(o => o.id === officeId && o.isDefault));

    const setDefault404 = await request("PATCH", `/api/users/${userId}/offices/OFF-NOPE/set-default`, {}, token);
    assert("set-default 404 for an unassigned office", setDefault404.status === 404);

    const unassign = await request("DELETE", `/api/users/${userId}/offices/${officeId}`, null, token);
    assert("office unassigned from user", unassign.status === 200);
    const userOfficesAfter = await request("GET", `/api/users/${userId}/offices`, null, token);
    assert("office no longer listed for user", !userOfficesAfter.body.some(o => o.id === officeId));

    const scratchUserDelete = await request("DELETE", `/api/users/${userId}`, null, token);
    assert("scratch user deleted", scratchUserDelete.status === 200);

    console.log("\nOffice delete — now unblocked (no shipment/branch references), succeeds");
    const offDelete = await request("DELETE", `/api/offices/${officeId}`, null, token);
    assert("office delete returns 200", offDelete.status === 200);
    const offDelete404 = await request("DELETE", `/api/offices/${officeId}`, null, token);
    assert("office delete 404 on second attempt", offDelete404.status === 404);

    console.log("\nBranch delete now succeeds (its only office is gone)");
    const brnDeleteOk = await request("DELETE", `/api/branches/${branchId}`, null, token);
    assert("branch delete returns 200", brnDeleteOk.status === 200);
    const brnDelete404 = await request("DELETE", `/api/branches/${branchId}`, null, token);
    assert("branch delete 404 on second attempt", brnDelete404.status === 404);

    console.log("\nOrg Countries — create (validated against countries MDM), list, update, duplicate rejection, delete");
    // npm run seed only ever seeds CN/SA into the countries MDM table (see
    // scripts/import-mdm-data.js's own comment on this — no bundled country-name dataset
    // exists to seed a full registry from) — a real country code like "NL" only exists in a
    // long-lived local dev DB from incidental prior activity, not in a genuinely fresh one
    // (confirmed live: this exact assumption failed all 9 of this section's assertions in CI).
    // Own the fixture instead of depending on ambient seed data: create a scratch MDM country
    // first, same as mdm-crud.test.js already does for the plain Countries CRUD.
    const orgCountryCode = `Z${rand[0]}`;
    const scratchCountry = await request("POST", "/api/countries", { iso2: orgCountryCode, name: "Zedland Org Test" }, token);
    assert("scratch MDM country created for this section", scratchCountry.status === 201, JSON.stringify(scratchCountry.body));

    const orgCountryBad = await request("POST", "/api/org-countries", { countryCode: "ZZ" }, token);
    assert("unknown country code rejected", orgCountryBad.status >= 400 && /not found/i.test(orgCountryBad.body.error || ""));

    const orgCountry = await request("POST", "/api/org-countries", {
      countryCode: orgCountryCode.toLowerCase(), defaultCurrency: "EUR", timezone: "Europe/Amsterdam", complianceNotes: "Test note",
    }, token);
    assert("org country created", orgCountry.status === 200, JSON.stringify(orgCountry.body));
    assert("country code uppercased", orgCountry.body.countryCode === orgCountryCode);
    assert("country name resolved from MDM", orgCountry.body.countryName === "Zedland Org Test");

    const orgCountryDup = await request("POST", "/api/org-countries", { countryCode: orgCountryCode }, token);
    assert("duplicate org country rejected", orgCountryDup.status >= 400 && /already/i.test(orgCountryDup.body.error || ""));

    const orgCountryList = await request("GET", "/api/org-countries", null, token);
    assert("org countries list returns 200", orgCountryList.status === 200);
    assert("scratch country present in the list", orgCountryList.body.some(c => c.countryCode === orgCountryCode));

    const orgCountryUpdate = await request("PUT", `/api/org-countries/${orgCountryCode.toLowerCase()}`, { complianceNotes: "Updated note", isActive: false }, token);
    assert("org country update returns 200", orgCountryUpdate.status === 200);
    assert("compliance notes updated", orgCountryUpdate.body.complianceNotes === "Updated note");
    assert("isActive updated", orgCountryUpdate.body.isActive === false);

    const orgCountryUpdate404 = await request("PUT", "/api/org-countries/ZZ", { timezone: "X" }, token);
    assert("org country update 404 for unassigned country", orgCountryUpdate404.status === 404);

    const orgCountryDelete = await request("DELETE", `/api/org-countries/${orgCountryCode.toLowerCase()}`, null, token);
    assert("org country delete returns 200", orgCountryDelete.status === 200);
    const orgCountryDelete404 = await request("DELETE", `/api/org-countries/${orgCountryCode.toLowerCase()}`, null, token);
    assert("org country delete 404 on second attempt", orgCountryDelete404.status === 404);

    await request("DELETE", `/api/countries/${orgCountryCode}`, null, token);

    console.log("\nUnauthenticated / non-admin write attempts are rejected");
    const noAuthBranches = await request("GET", "/api/branches", null, null);
    assert("branches list without a token is rejected", noAuthBranches.status === 401);
    const noAuthCreate = await request("POST", "/api/branches", { code: "X", name: "X", countryCode: "NL" }, null);
    assert("branch create without a token is rejected", noAuthCreate.status === 401);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
