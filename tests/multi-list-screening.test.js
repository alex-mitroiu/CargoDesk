/**
 * Multi-list denied-party screening — extends sanctions screening beyond OFAC's own SDN list to
 * the free, public US Consolidated Screening List (BIS Denied Persons/Entity/Unverified/Military
 * End User Lists, State Dept ITAR Debarred + Nonproliferation Sanctions, and 5 more OFAC-family
 * lists beyond SDN). Deliberately reuses a real, already-synced sanctioned entity name rather than
 * importing new fixture data — same precedent tests/customer-compliance-screening.test.js already
 * established (importing sanctions data would destructively replace the live dataset).
 *
 * Usage:
 *   node tests/multi-list-screening.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - A Consolidated Screening List sync must have already run at least once (Application
 *     Settings -> API Controls -> External APIs -> Consolidated Screening List -> Sync from
 *     source) — this test does NOT trigger a sync itself (a real ~34MB government download,
 *     too slow/heavy to run on every test invocation), it only verifies screening behavior
 *     against whatever is already synced. Skips its CSL-dependent assertions with a clear
 *     message if nothing has been synced yet.
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

let passed = 0;
let failed = 0;
let skipped = 0;

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

function skip(label, reason) {
  console.log(`  ⊘ ${label} — skipped: ${reason}`);
  skipped++;
}

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost", password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  const cleanup = { shipments: [] };
  try {
    const token = await login();

    console.log("GET /api/sanctions/status exposes per-source entry counts");
    const status = await request("GET", "/api/sanctions/status", null, token);
    assert("status returns 200", status.status === 200, JSON.stringify(status.body));
    assert("response has ofacEntryCount and cslEntryCount fields", "ofacEntryCount" in status.body && "cslEntryCount" in status.body, JSON.stringify(status.body));
    const cslSynced = (status.body.cslEntryCount || 0) > 0;
    const ofacSynced = (status.body.ofacEntryCount || 0) > 0;

    // 2026-09-05 audit regression — none of the 3 mutating sanctions routes (sync/sync-csl/
    // import-csv) had ANY role gate, only a per-user rate limit; any authenticated viewer could
    // trigger a full destructive replace of the compliance screening dataset. Confirmed live
    // during the audit itself, expensively: a "safe-looking" test payload sent as a scratch
    // viewer account turned out to parse as 2 real entries, silently wiping the real OFAC-SDN
    // table down to those 2 rows. These 3 assertions are safe to run unconditionally — a 403
    // from the role gate fires before the route handler body (and any real data touch) at all.
    const rand = Math.random().toString(36).slice(2, 8);
    const roleTestEmail = `sanctions-role-${rand}@example.com`;
    await request("POST", "/api/users", { email: roleTestEmail, name: "Sanctions Role Test", roles: ["occ_bk"], password: "RoleFixture!2026Zq" }, token);
    const roleTestToken = (await request("POST", "/api/auth/login", { email: roleTestEmail, password: "RoleFixture!2026Zq" })).body.token;
    const syncAsNonAdmin = await request("POST", "/api/sanctions/sync", {}, roleTestToken);
    assert("non-admin cannot trigger /sync", syncAsNonAdmin.status === 403, JSON.stringify(syncAsNonAdmin.body));
    const syncCslAsNonAdmin = await request("POST", "/api/sanctions/sync-csl", {}, roleTestToken);
    assert("non-admin cannot trigger /sync-csl", syncCslAsNonAdmin.status === 403, JSON.stringify(syncCslAsNonAdmin.body));
    const importAsNonAdmin = await request("POST", "/api/sanctions/import-csv", { csv: "x,y" }, roleTestToken);
    assert("non-admin cannot trigger /import-csv", importAsNonAdmin.status === 403, JSON.stringify(importAsNonAdmin.body));
    const roleTestUserId = (await request("GET", "/api/users", null, token)).body.find(u => u.email === roleTestEmail)?.id;
    if (roleTestUserId) await request("DELETE", `/api/users/${roleTestUserId}`, null, token);

    if (!cslSynced) {
      skip("CSL-dependent screening assertions", "no Consolidated Screening List sync has run yet in this environment — trigger one via Application Settings first to exercise this test fully");
    } else {
      console.log("\nCSL sync has real data — find a known non-SDN entity to test against");
      const entries = await request("GET", "/api/sanctions/entries?search=BANK+OF+KUNLUN&limit=5", null, token);
      assert("search finds sanctions entries", entries.status === 200, JSON.stringify(entries.body));
      const cslHit = entries.body.results.find(e => e.id.startsWith("CSL-"));

      if (!cslHit) {
        skip("shipment screening against a real CSL entity", "the 'Bank of Kunlun' fixture entity wasn't found in this sync — the government list may have changed; not a test failure");
      } else {
        assert("the matched entry's source is NOT OFAC-SDN (proves multi-list screening, not just OFAC)", cslHit.source !== "OFAC-SDN", JSON.stringify(cslHit));

        console.log(`\nScratch shipment with Shipper name matching a real CSL entry (source: ${cslHit.source})`);
        const ship = await request("POST", "/api/shipments", {
          pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active",
          shipperName: cslHit.entity_name,
        }, token);
        assert("shipment created", ship.status === 201, JSON.stringify(ship.body));
        const shipmentId = ship.body.id;
        cleanup.shipments.push(shipmentId);

        const screen = await request("POST", `/api/shipments/${shipmentId}/screen`, {}, token);
        assert("screening returns 200", screen.status === 200, JSON.stringify(screen.body));
        assert("result is HIT", screen.body.result === "HIT", JSON.stringify(screen.body));
        const shipperHit = screen.body.hits.find(h => h.field === "Shipper");
        assert("Shipper hit present", !!shipperHit, JSON.stringify(screen.body.hits));
        assert("hit carries the real list's source (not hardcoded OFAC-SDN)", shipperHit.source === cslHit.source, JSON.stringify(shipperHit));
        assert("hit source is not OFAC-SDN — this shipment would have been invisible to OFAC-only screening", shipperHit.source !== "OFAC-SDN", JSON.stringify(shipperHit));
      }
    }

    if (!ofacSynced) {
      skip("OFAC-SDN regression assertion", "no OFAC-SDN sync has run yet in this environment (fresh install/CI — nothing to regress against)");
    } else {
      console.log("\nOFAC-SDN screening still works unchanged (regression — the additive sync didn't disturb it)");
      const ofacEntries = await request("GET", "/api/sanctions/entries?source=OFAC-SDN&limit=1", null, token);
      assert("OFAC-SDN entries still queryable by source filter", ofacEntries.status === 200 && ofacEntries.body.results.length <= 1 && ofacEntries.body.total > 0, JSON.stringify(ofacEntries.body));
    }

    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const cleanupToken = await login().catch(() => null);
    if (cleanupToken) {
      for (const id of cleanup.shipments) { try { await request("DELETE", `/api/shipments/${id}`, null, cleanupToken); } catch {} }
    }
  }
})();
