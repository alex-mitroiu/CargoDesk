/**
 * GP-by-Geo report (routes/reports.js) — smoke tests
 *
 * Covers GET /api/reports/gp-by-geo across its groupBy (country/region/carrier) and format
 * (json/csv) axes, the value= drill-down, the date-range period-over-period comparison, the
 * gp_target_pct worst-margin-first sort, and the finance-access gate. Previously zero dedicated
 * coverage — this report is otherwise only exercised live through ReportsPage.jsx.
 *
 * Usage:
 *   node tests/reports.test.js
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

async function login(email = "claudeagent@localhost", password = "TestFixture!2026Zq") {
  return request("POST", "/api/auth/login", { email, password });
}

(async () => {
  try {
    console.log("Logging in…");
    const loginRes = await login();
    if (loginRes.status !== 200) throw new Error(`Login failed: ${JSON.stringify(loginRes.body)}`);
    const token = loginRes.body.token;
    console.log("  ✓ Logged in");

    console.log("\nScratch shipment with a BUY + SELL cost line (POL NLRTM -> country NL, carrier MAEU)");
    const today = new Date().toISOString().slice(0, 10);
    const shp = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", etd: today,
    }, token);
    assert("scratch shipment created", shp.status === 201);
    const shipmentId = shp.body.id;
    await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "BUY", chargeCode: "OFR", currency: "USD", amount: 1000 }, token);
    await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "SELL", chargeCode: "OFR", currency: "USD", amount: 1600 }, token);

    console.log("\nDefault call — groupBy=country (default), json, no date range");
    const byCountry = await request("GET", "/api/reports/gp-by-geo", null, token);
    assert("returns 200", byCountry.status === 200);
    assert("has results/targetPct/comparisonAvailable shape", ["results", "targetPct", "comparisonAvailable"].every(k => k in byCountry.body));
    assert("comparison unavailable with no date range", byCountry.body.comparisonAvailable === false);
    const nlRow = byCountry.body.results.find(r => r.code === "NL");
    assert("NL row present with our shipment's margin folded in", !!nlRow && nlRow.totalSellUsd >= 1600);
    assert("row shape has sell/buy/gp/marginPct", nlRow && ["totalSellUsd", "totalBuyUsd", "grossProfitUsd", "grossMarginPct"].every(k => k in nlRow));

    console.log("\ngroupBy=region and groupBy=carrier");
    const byRegion = await request("GET", "/api/reports/gp-by-geo?groupBy=region", null, token);
    assert("groupBy=region returns 200", byRegion.status === 200);
    assert("region results have a name resolved (not just a bare code)", byRegion.body.results.length === 0 || byRegion.body.results.every(r => "name" in r));
    const byCarrier = await request("GET", "/api/reports/gp-by-geo?groupBy=carrier", null, token);
    assert("groupBy=carrier returns 200", byCarrier.status === 200);
    const maeuRow = byCarrier.body.results.find(r => r.code === "MAEU");
    assert("MAEU carrier row present", !!maeuRow);
    const byBogusGroup = await request("GET", "/api/reports/gp-by-geo?groupBy=nonsense", null, token);
    assert("an invalid groupBy silently falls back to country, not an error", byBogusGroup.status === 200);

    console.log("\nvalue= drill-down — the individual cost lines behind one group's key");
    const drill = await request("GET", "/api/reports/gp-by-geo?groupBy=country&value=NL", null, token);
    assert("drill-down returns 200", drill.status === 200);
    assert("drill-down returns a bare array of cost lines", Array.isArray(drill.body));
    assert("our SELL line appears in the drill-down", drill.body.some(l => l.shipmentId === shipmentId && l.type === "SELL"));

    console.log("\nDate range — bounded from+to enables period-over-period comparison");
    const ranged = await request("GET", `/api/reports/gp-by-geo?from=${today}&to=${today}`, null, token);
    assert("date-ranged call returns 200", ranged.status === 200);
    assert("comparisonAvailable true with both from and to set", ranged.body.comparisonAvailable === true);
    const oneSided = await request("GET", `/api/reports/gp-by-geo?from=${today}`, null, token);
    assert("comparisonAvailable false with only one bound set", oneSided.body.comparisonAvailable === false);
    const outOfRange = await request("GET", `/api/reports/gp-by-geo?from=2020-01-01&to=2020-01-02`, null, token);
    assert("a date range excluding our shipment returns 200 with it absent", outOfRange.status === 200 && !outOfRange.body.results.some(r => r.code === "NL" && r.totalSellUsd >= 1600));

    console.log("\nformat=csv — grouped list and drill-down");
    const csvGrouped = await request("GET", "/api/reports/gp-by-geo?format=csv", null, token);
    assert("grouped csv returns 200", csvGrouped.status === 200);
    assert("grouped csv has a Country header", String(csvGrouped.body).split("\n")[0].includes("Country"));
    const csvDrill = await request("GET", "/api/reports/gp-by-geo?value=NL&format=csv", null, token);
    assert("drill-down csv returns 200", csvDrill.status === 200);
    assert("drill-down csv has a Charge Code header", String(csvDrill.body).split("\n")[0].includes("Charge Code"));
    const csvWithComparison = await request("GET", `/api/reports/gp-by-geo?from=${today}&to=${today}&format=csv`, null, token);
    assert("grouped csv with comparison adds the delta column", String(csvWithComparison.body).split("\n")[0].includes("Margin"));

    console.log("\ngp_target_pct setting — flips the sort to worst-margin-first when set");
    const settingsBefore = (await request("GET", "/api/settings", null, token)).body;
    await request("PUT", "/api/settings", { gp_target_pct: "50" }, token);
    try {
      const targeted = await request("GET", "/api/reports/gp-by-geo?groupBy=country", null, token);
      assert("targetPct reflected in the response", targeted.body.targetPct === 50);
      const pcts = targeted.body.results.map(r => r.grossMarginPct ?? Infinity);
      const sorted = [...pcts].sort((a, b) => a - b);
      assert("results sorted worst-margin-first once a target is set", JSON.stringify(pcts) === JSON.stringify(sorted));
    } finally {
      await request("PUT", "/api/settings", { gp_target_pct: settingsBefore.gp_target_pct ?? "" }, token);
    }
    const untargeted = await request("GET", "/api/reports/gp-by-geo", null, token);
    assert("targetPct is null again once cleared", untargeted.body.targetPct === null);

    console.log("\nFinance gate — a non-admin, non-finance-flagged user is rejected");
    const rand = Math.random().toString(36).slice(2, 8);
    const scratchEmail = `reports-test-${rand}@example.com`;
    await request("POST", "/api/users", { email: scratchEmail, name: "Reports Test User", roles: ["operator"], password: "ReportsTestFixture!2026Zq" }, token);
    const scratchLogin = await login(scratchEmail, "ReportsTestFixture!2026Zq");
    assert("scratch operator user can log in", scratchLogin.status === 200);
    const gated = await request("GET", "/api/reports/gp-by-geo", null, scratchLogin.body.token);
    assert("non-finance operator rejected with 403", gated.status === 403);

    const usersList = await request("GET", "/api/users", null, token);
    const scratchUserId = usersList.body.find(u => u.email === scratchEmail)?.id;
    await request("PATCH", `/api/users/${scratchUserId}`, { canViewFinance: true }, token);
    const scratchRelogin = await login(scratchEmail, "ReportsTestFixture!2026Zq");
    const ungated = await request("GET", "/api/reports/gp-by-geo", null, scratchRelogin.body.token);
    assert("the same user succeeds once canViewFinance is granted", ungated.status === 200);

    console.log("\nUnauthenticated request is rejected");
    const noAuth = await request("GET", "/api/reports/gp-by-geo", null, null);
    assert("no token rejected (401)", noAuth.status === 401);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/users/${scratchUserId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
