/**
 * Multi-Entity / Multi-Branch Accounting (TKT-EEV4I9)
 *
 * Covers branches.currency, GET /api/margin/summary's byEntity breakdown (entity resolved as
 * the shipment's EMO office's branch, falling back to IMO's branch), local-currency conversion
 * via the existing FX table, and byEntity's branch-scoped visibility for a non-global user.
 *
 * Usage:
 *   node tests/multi-entity-accounting.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

function request(method, path, body, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: 3001, path,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
        ...extraHeaders,
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

async function addLine(shipmentId, token, type, amount, chargeCode = "OFR") {
  return request("POST", `/api/shipments/${shipmentId}/cost-lines`, {
    type, chargeCode, currency: "USD", amount, exchangeRate: 1,
  }, token);
}

(async () => {
  // Declared outside the try so the finally block can always clean up whatever got created,
  // even if a later step throws — same "don't leave orphans on a mid-run crash" concern this
  // project has hit before with other test suites.
  let admin, branchA, branchB, officeA, officeB, shipA, shipB, scopedUserId;
  try {
    console.log("Logging in as admin…");
    admin = await login("claudeagent@localhost", "TestFixture!2026Zq");
    console.log("  ✓ Logged in");

    // Randomized suffix (same convention tests/organization.test.js already uses) rather than a
    // fixed code — makes a leftover row from a prior crashed run a non-issue instead of a
    // collision the next run has to be manually cleaned up for.
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();

    console.log("\nTwo scratch branches, two currencies");
    branchA = await request("POST", "/api/branches",
      { code: `T1${rand}A`, name: "Test Entity Branch A", countryCode: "NL", currency: "EUR" }, admin);
    assert("branch A created", !!branchA.body.id, JSON.stringify(branchA.body));
    assert("branch A currency is EUR", branchA.body.currency === "EUR");
    branchB = await request("POST", "/api/branches",
      { code: `T1${rand}B`, name: "Test Entity Branch B", countryCode: "US", currency: "USD" }, admin);
    assert("branch B created", !!branchB.body.id, JSON.stringify(branchB.body));
    assert("branch B currency is USD", branchB.body.currency === "USD");

    console.log("\nUpdating a branch's currency");
    const updated = await request("PUT", `/api/branches/${branchA.body.id}`, { currency: "GBP" }, admin);
    assert("currency updates", updated.body.currency === "GBP");
    await request("PUT", `/api/branches/${branchA.body.id}`, { currency: "EUR" }, admin); // restore for the rest of the test

    console.log("\nOne office per branch (Export/SE for A, Import/SI for B)");
    officeA = await request("POST", "/api/offices",
      { unlocode: `NL${rand}`, department: "SE", name: "Test Entity Office A", branchId: branchA.body.id }, admin);
    assert("office A created", !!officeA.body.id, JSON.stringify(officeA.body));
    officeB = await request("POST", "/api/offices",
      { unlocode: `US${rand}`, department: "SI", name: "Test Entity Office B", branchId: branchB.body.id }, admin);
    assert("office B created", !!officeB.body.id, JSON.stringify(officeB.body));

    console.log("\nOne shipment per entity, via EMO/IMO");
    shipA = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      emoOfficeId: officeA.body.id,
    }, admin);
    assert("shipment A created", !!shipA.body.id, JSON.stringify(shipA.body));
    assert("shipment A resolves EMO office", shipA.body.emoOfficeId === officeA.body.id);
    shipB = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      imoOfficeId: officeB.body.id, // deliberately IMO-only, no EMO — exercises the fallback
    }, admin);
    assert("shipment B created (IMO only)", !!shipB.body.id, JSON.stringify(shipB.body));

    await addLine(shipA.body.id, admin, "SELL", 1000);
    await addLine(shipA.body.id, admin, "BUY", 400);
    await addLine(shipB.body.id, admin, "SELL", 2000);
    await addLine(shipB.body.id, admin, "BUY", 900);

    console.log("\nbyEntity — admin (global) sees both entities");
    const asAdmin = await request("GET", "/api/margin/summary", null, admin);
    assert("summary returns 200", asAdmin.status === 200);
    const rowA = asAdmin.body.byEntity.find(e => e.entityId === branchA.body.id);
    const rowB = asAdmin.body.byEntity.find(e => e.entityId === branchB.body.id);
    assert("entity A present (via EMO)", !!rowA, JSON.stringify(asAdmin.body.byEntity));
    assert("entity B present (via IMO fallback, no EMO set)", !!rowB, JSON.stringify(asAdmin.body.byEntity));
    assert("entity A name correct", rowA?.entityName === "Test Entity Branch A");
    assert("entity A currency is EUR", rowA?.currency === "EUR");
    assert("entity A totalSellUsd is exactly 1000", rowA?.totalSellUsd === 1000, JSON.stringify(rowA));
    assert("entity A totalBuyUsd is exactly 400", rowA?.totalBuyUsd === 400, JSON.stringify(rowA));
    assert("entity A grossProfitUsd is exactly 600", rowA?.grossProfitUsd === 600, JSON.stringify(rowA));
    assert("entity A localSell is a positive number (live FX)", typeof rowA?.localSell === "number" && rowA.localSell > 0, JSON.stringify(rowA));
    assert("entity B currency is USD", rowB?.currency === "USD");
    assert("entity B totalSellUsd is exactly 2000", rowB?.totalSellUsd === 2000, JSON.stringify(rowB));
    // USD entity: local figures equal the USD figures exactly (no FX conversion needed)
    assert("entity B localSell equals totalSellUsd (USD entity, no conversion)", rowB?.localSell === rowB?.totalSellUsd, JSON.stringify(rowB));
    assert("byCarrier is untouched/still present (existing breakdowns unaffected)", Array.isArray(asAdmin.body.byCarrier));

    console.log("\nbyEntity — branch-scoped user sees only their own entity");
    const scopedEmail = `entity-test-scoped-${rand.toLowerCase()}@localhost`;
    const scopedUser = await request("POST", "/api/users", {
      name: "Test Entity Scoped User", email: scopedEmail,
      password: "TestFixture!2026Zq", roles: ["occ_bk"], allOffices: false,
    }, admin);
    assert("scoped user created", scopedUser.body.ok === true, JSON.stringify(scopedUser.body));
    const usersList = await request("GET", "/api/users", null, admin);
    scopedUserId = usersList.body.find(u => u.email === scopedEmail)?.id;
    assert("scoped user found in list", !!scopedUserId);
    // POST /api/users hardcodes allOffices=0 and has no canViewFinance param at all — both are
    // PATCH-only fields (routes/auth.js), so finance access has to be granted as a follow-up.
    await request("PATCH", `/api/users/${scopedUserId}`, { canViewFinance: true, allOffices: false }, admin);
    await request("POST", `/api/users/${scopedUserId}/offices`, { officeId: officeA.body.id }, admin);

    const scopedToken = await login(scopedEmail, "TestFixture!2026Zq");
    const asScopedNoOffice = await request("GET", "/api/margin/summary", null, scopedToken);
    assert("no active office set — byEntity is empty, not the whole company", asScopedNoOffice.body.byEntity.length === 0, JSON.stringify(asScopedNoOffice.body.byEntity));

    const asScoped = await request("GET", "/api/margin/summary", null, scopedToken, { "X-Office-Id": officeA.body.id });
    assert("scoped summary returns 200", asScoped.status === 200);
    assert("scoped user sees exactly one entity (their own)", asScoped.body.byEntity.length === 1, JSON.stringify(asScoped.body.byEntity));
    assert("scoped user's entity is branch A, not B", asScoped.body.byEntity[0]?.entityId === branchA.body.id);

  } catch (e) {
    console.error("Fatal:", e.message);
    failed++;
  } finally {
    // Always attempt cleanup, even on a mid-run throw — a scratch branch/office code collides
    // on the next run otherwise (hit exactly this while writing this test), and each delete is
    // independently guarded (admin may be unset if login itself failed).
    if (admin) {
      console.log("\nCleanup");
      if (scopedUserId)     await request("DELETE", `/api/users/${scopedUserId}`, null, admin).catch(() => {});
      if (shipA?.body?.id)  await request("DELETE", `/api/shipments/${shipA.body.id}`, null, admin).catch(() => {});
      if (shipB?.body?.id)  await request("DELETE", `/api/shipments/${shipB.body.id}`, null, admin).catch(() => {});
      if (officeA?.body?.id) await request("DELETE", `/api/offices/${officeA.body.id}`, null, admin).catch(() => {});
      if (officeB?.body?.id) await request("DELETE", `/api/offices/${officeB.body.id}`, null, admin).catch(() => {});
      if (branchA?.body?.id) await request("DELETE", `/api/branches/${branchA.body.id}`, null, admin).catch(() => {});
      if (branchB?.body?.id) await request("DELETE", `/api/branches/${branchB.body.id}`, null, admin).catch(() => {});
    }
  }

  console.log("\n" + "─".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
