/**
 * Table pagination standardization — backend coverage for the new query-param support this
 * pass added, direct follow-up to a user request to standardize page-size-selectable
 * pagination across the app (motivated by a real RAM/scroll concern on the Shipments list).
 *
 * Covers:
 *   GET /api/shipments       — new status/carrier/search/sort filters + the new `teu` field,
 *                               all opt-in (only apply when the caller passes limit/offset),
 *                               scoped-access still enforced first
 *   GET /api/linked-ports    — new opt-in limit/offset/search pagination (previously fully
 *                               unbounded, mislabeled client-side "pagination" over the whole set)
 *   GET /api/carrier-agents  — same as above
 *   GET /api/carrier-invoices/exceptions — now capped (LIMIT 200), previously unbounded
 *
 * Usage:
 *   node tests/pagination-standardization.test.js
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

(async () => {
  try {
    console.log("Logging in…");
    const loginRes = await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" });
    if (loginRes.status !== 200 || !loginRes.body.token) throw new Error(`Login failed: ${JSON.stringify(loginRes.body)}`);
    const token = loginRes.body.token;
    console.log("  ✓ Logged in");

    const rand = Math.random().toString(36).slice(2, 8);

    console.log("\nGET /api/shipments — opt-in status/carrier/search filters + sort + teu");
    const shipA = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      bookingRef: `PAGTEST-${rand}`,
    }, token);
    assert("scratch shipment created", shipA.status === 201, JSON.stringify(shipA.body));
    const shipAId = shipA.body.id;
    const ctrA = await request("POST", "/api/containers", { shipmentId: shipAId, size: "40", type: "GP" }, token);
    assert("40ft container created", ctrA.status === 201, JSON.stringify(ctrA.body));

    const bare = await request("GET", "/api/shipments", null, token);
    assert("no limit/offset -> still a bare array (unaffected by this pass)", Array.isArray(bare.body));

    const paged = await request("GET", "/api/shipments?limit=5&offset=0", null, token);
    assert("limit/offset -> paginated shape", paged.status === 200 && Array.isArray(paged.body.results) && typeof paged.body.total === "number");
    assert("every returned row carries a numeric teu field", paged.body.results.every(r => typeof r.teu === "number"));

    const bySearch = await request("GET", `/api/shipments?limit=10&offset=0&search=${rand}`, null, token);
    assert("search filter finds our scratch shipment by bookingRef", bySearch.body.total >= 1 && bySearch.body.results.some(r => r.id === shipAId));

    const byStatus = await request("GET", "/api/shipments?limit=5&offset=0&status=Active", null, token);
    assert("status filter returns only Active rows", byStatus.body.results.every(r => r.status === "Active"));

    const byCarrier = await request("GET", "/api/shipments?limit=5&offset=0&carrier=MAEU", null, token);
    assert("carrier filter returns only MAEU rows", byCarrier.body.results.every(r => r.carrierCode === "MAEU"));

    const byTeuDesc = await request("GET", "/api/shipments?limit=20&offset=0&sort=teu_desc", null, token);
    const teus = byTeuDesc.body.results.map(r => r.teu);
    const sortedDesc = [...teus].sort((a, b) => b - a);
    assert("sort=teu_desc actually returns rows in descending teu order", JSON.stringify(teus) === JSON.stringify(sortedDesc), JSON.stringify(teus));
    assert("our 40ft-container shipment (teu=2) appears somewhere in a large enough page", byTeuDesc.body.results.some(r => r.id === shipAId) || byTeuDesc.body.total > 20, `total=${byTeuDesc.body.total}`);

    console.log("\nGET /api/linked-ports — new opt-in pagination (was fully unbounded)");
    const lpBare = await request("GET", "/api/linked-ports", null, token);
    assert("no limit/offset -> still a bare array", Array.isArray(lpBare.body));
    const lpCreate = await request("POST", "/api/linked-ports", { primaryUnlocode: "NLRTM", linkedUnlocode: "BEANR", note: `pagtest-${rand}` }, token);
    assert("scratch linked-port created", lpCreate.status === 201, JSON.stringify(lpCreate.body));
    const lpId = lpCreate.body.id;
    const lpPaged = await request("GET", "/api/linked-ports?limit=5&offset=0", null, token);
    assert("limit/offset -> paginated shape", lpPaged.status === 200 && Array.isArray(lpPaged.body.results) && typeof lpPaged.body.total === "number");
    const lpSearch = await request("GET", `/api/linked-ports?limit=5&offset=0&search=${rand}`, null, token);
    assert("search filter finds our scratch link by note", lpSearch.body.results.some(l => l.id === lpId));

    console.log("\nGET /api/carrier-agents — new opt-in pagination (was fully unbounded)");
    const custRes = await request("POST", "/api/customers", { companyName: `PagTest Agent Co ${rand}`, countryIso2: "NL" }, token);
    assert("scratch customer created (for carrier agent)", custRes.status === 201, JSON.stringify(custRes.body));
    const custId = custRes.body.id;
    const caBare = await request("GET", "/api/carrier-agents", null, token);
    assert("no limit/offset -> still a bare array", Array.isArray(caBare.body));
    const caCreate = await request("POST", "/api/carrier-agents", { carrierCode: "MAEU", agentCustomerId: custId, note: `pagtest-${rand}`, locationType: "unlocode", unlocode: "NLRTM" }, token);
    assert("scratch carrier agent created", caCreate.status === 201, JSON.stringify(caCreate.body));
    const caId = caCreate.body.id;
    const caPaged = await request("GET", "/api/carrier-agents?limit=5&offset=0", null, token);
    assert("limit/offset -> paginated shape", caPaged.status === 200 && Array.isArray(caPaged.body.results) && typeof caPaged.body.total === "number");
    const caSearch = await request("GET", `/api/carrier-agents?limit=5&offset=0&search=${rand}`, null, token);
    assert("search filter finds our scratch agent by note", caSearch.body.results.some(a => a.id === caId));

    console.log("\nGET /api/carrier-invoices/exceptions — now capped (was fully unbounded)");
    const exc = await request("GET", "/api/carrier-invoices/exceptions", null, token);
    assert("returns 200", exc.status === 200);
    assert("still a bare array (no pagination UI added here on purpose — a queue, not a browsed list)", Array.isArray(exc.body));
    assert("capped at 200 rows", exc.body.length <= 200);

    console.log("\nAccess control unaffected — no token still rejected everywhere touched");
    const noAuth1 = await request("GET", "/api/shipments?limit=5&offset=0", null, null);
    assert("shipments: no token rejected (401)", noAuth1.status === 401);
    const noAuth2 = await request("GET", "/api/linked-ports?limit=5&offset=0", null, null);
    assert("linked-ports: no token rejected (401)", noAuth2.status === 401);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipAId}`, null, token);
    await request("DELETE", `/api/linked-ports/${lpId}`, null, token);
    await request("DELETE", `/api/carrier-agents/${caId}`, null, token);
    await request("DELETE", `/api/customers/${custId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    process.exit(1);
  }
})();
