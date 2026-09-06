/**
 * Landed-cost / duty estimate (TKT-U6IZCL, FCL Coverage Audit epic TKT-6PO7SV)
 *
 * An explicit ballpark tool — flat rates by HS chapter, not a live tariff feed. Covers the
 * duty_rate_chapters admin registry CRUD, then GET /api/shipments/:id/landed-cost-estimate
 * across its three cargo-value sources: real priced pack items (preferred, chapter-accurate),
 * the shipment-level declaredValue fallback (only when nothing is priced at all), and the
 * genuinely-nothing-to-estimate-from case.
 *
 * Usage:
 *   node tests/landed-cost.test.js
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

    console.log("\nDuty Rate Chapters registry — seeded defaults present");
    const seeded = await request("GET", "/api/duty-rate-chapters", null, token);
    assert("returns 200", seeded.status === 200);
    assert("chapter 84 (Machinery) is seeded at 2.5%", seeded.body.some(c => c.hsChapter === "84" && c.ratePct === 2.5), JSON.stringify(seeded.body.find(c => c.hsChapter === "84")));
    assert("chapter 61 (Apparel, knit) is seeded at 16%", seeded.body.some(c => c.hsChapter === "61" && c.ratePct === 16), JSON.stringify(seeded.body.find(c => c.hsChapter === "61")));
    assert("chapter 39 (Plastics) is seeded at 5%", seeded.body.some(c => c.hsChapter === "39" && c.ratePct === 5), JSON.stringify(seeded.body.find(c => c.hsChapter === "39")));

    console.log("\nDuty Rate Chapters registry — CRUD + validation");
    const badChapter = await request("POST", "/api/duty-rate-chapters", { hsChapter: "8", label: "Bad", ratePct: 1 }, token);
    assert("non-2-digit chapter code rejected", badChapter.status >= 400, JSON.stringify(badChapter.body));
    const dupe = await request("POST", "/api/duty-rate-chapters", { hsChapter: "84", label: "Duplicate Machinery", ratePct: 1 }, token);
    assert("duplicate chapter rejected", dupe.status >= 400, JSON.stringify(dupe.body));

    const created = await request("POST", "/api/duty-rate-chapters", { hsChapter: "50", label: "Test Silk Chapter", ratePct: 12.5 }, token);
    assert("create returns 201", created.status === 201, JSON.stringify(created.body));
    assert("hsChapter round-trips", created.body.hsChapter === "50");
    assert("ratePct round-trips", created.body.ratePct === 12.5);

    const updated = await request("PUT", "/api/duty-rate-chapters/50", { label: "Test Silk Chapter Updated", ratePct: 9 }, token);
    assert("update returns 200", updated.status === 200);
    assert("label updated", updated.body.label === "Test Silk Chapter Updated");
    assert("ratePct updated", updated.body.ratePct === 9);

    const removed = await request("DELETE", "/api/duty-rate-chapters/50", null, token);
    assert("delete returns 200", removed.status === 200);
    const missingDelete = await request("DELETE", "/api/duty-rate-chapters/50", null, token);
    assert("deleting again 404s", missingDelete.status === 404);

    console.log("\nLanded-cost estimate — real priced pack items, mixed HS chapters, freight from SELL cost lines");
    const cust = await request("POST", "/api/customers", { companyName: "Test Landed Cost Co" }, token);
    const ship1 = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: cust.body.id, principalName: "Test Landed Cost Co",
    }, token);
    const ship1Id = ship1.body.id;
    const ctr1 = await request("POST", "/api/containers", { shipmentId: ship1Id, size: "40", type: "DC", hsCode: "8471.30" }, token);
    const pkg1 = await request("POST", `/api/shipments/${ship1Id}/containers/${ctr1.body.id}/packages`, {
      description: "Laptops", quantity: 2, unitValue: 500, currency: "USD",
    }, token);
    assert("pack item 1 created (inherits container HS -> chapter 84)", pkg1.status === 201, JSON.stringify(pkg1.body));
    const pkg2 = await request("POST", `/api/shipments/${ship1Id}/containers/${ctr1.body.id}/packages`, {
      description: "Knit sweaters", quantity: 1, unitValue: 2000, currency: "USD", hsCode: "611020",
    }, token);
    assert("pack item 2 created (own HS override -> chapter 61)", pkg2.status === 201, JSON.stringify(pkg2.body));
    await request("POST", `/api/shipments/${ship1Id}/cost-lines`, { type: "SELL", chargeCode: "OFR", currency: "USD", amount: 800, exchangeRate: 1 }, token);

    const est1 = await request("GET", `/api/shipments/${ship1Id}/landed-cost-estimate`, null, token);
    assert("returns 200", est1.status === 200, JSON.stringify(est1.body));
    assert("cargoValueSource is pack-items", est1.body?.cargoValueSource === "pack-items", JSON.stringify(est1.body));
    assert("freightUsd sums the SELL cost line", est1.body?.freightUsd === 800, JSON.stringify(est1.body));
    const chapter84 = est1.body?.byChapter.find(c => c.chapter === "84");
    const chapter61 = est1.body?.byChapter.find(c => c.chapter === "61");
    assert("chapter 84 bucket: 2×500=1000 value, 2.5% rate, 25 duty", chapter84?.valueUsd === 1000 && chapter84?.ratePct === 2.5 && chapter84?.dutyUsd === 25, JSON.stringify(chapter84));
    assert("chapter 61 bucket: 1×2000=2000 value, 16% rate, 320 duty", chapter61?.valueUsd === 2000 && chapter61?.ratePct === 16 && chapter61?.dutyUsd === 320, JSON.stringify(chapter61));
    assert("dutyEstimateUsd is the sum across chapters (25+320=345)", est1.body?.dutyEstimateUsd === 345, JSON.stringify(est1.body));
    assert("landedCostUsd is freight+duty (800+345=1145)", est1.body?.landedCostUsd === 1145, JSON.stringify(est1.body));
    assert("a disclaimer is always present", typeof est1.body?.disclaimer === "string" && est1.body.disclaimer.length > 0);

    console.log("\nLanded-cost estimate — an HS chapter with no seeded rate falls back to the default");
    const ctrUnseeded = await request("POST", "/api/containers", { shipmentId: ship1Id, size: "20", type: "DC", hsCode: "990000" }, token);
    await request("POST", `/api/shipments/${ship1Id}/containers/${ctrUnseeded.body.id}/packages`, { description: "Unclassifiable widget", quantity: 1, unitValue: 1000, currency: "USD" }, token);
    const est1b = await request("GET", `/api/shipments/${ship1Id}/landed-cost-estimate`, null, token);
    const chapter99 = est1b.body?.byChapter.find(c => c.chapter === "99");
    assert("unseeded chapter 99 uses the default rate (5%)", chapter99?.ratePct === 5, JSON.stringify(chapter99));
    assert("unseeded chapter's label says so", chapter99?.label.includes("default"), JSON.stringify(chapter99));

    console.log("\nLanded-cost estimate — no pack items priced, falls back to the shipment's own declaredValue");
    const cust2 = await request("POST", "/api/customers", { companyName: "Test Landed Cost Fallback Co" }, token);
    const ship2 = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: cust2.body.id, principalName: "Test Landed Cost Fallback Co", declaredValue: 3000, declaredValueCurrency: "USD",
    }, token);
    const ship2Id = ship2.body.id;
    const ctr2 = await request("POST", "/api/containers", { shipmentId: ship2Id, size: "40", type: "DC", hsCode: "390110" }, token);
    const est2 = await request("GET", `/api/shipments/${ship2Id}/landed-cost-estimate`, null, token);
    assert("cargoValueSource is shipment-declared-value", est2.body?.cargoValueSource === "shipment-declared-value", JSON.stringify(est2.body));
    const chapter39 = est2.body?.byChapter.find(c => c.chapter === "39");
    assert("the single container's own HS chapter (39) is used for the whole declared value", chapter39?.valueUsd === 3000 && chapter39?.ratePct === 5 && chapter39?.dutyUsd === 150, JSON.stringify(chapter39));

    console.log("\nLanded-cost estimate — nothing priced at all and no declaredValue set");
    const cust3 = await request("POST", "/api/customers", { companyName: "Test Landed Cost None Co" }, token);
    const ship3 = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: cust3.body.id, principalName: "Test Landed Cost None Co",
    }, token);
    const ship3Id = ship3.body.id;
    await request("POST", "/api/containers", { shipmentId: ship3Id, size: "40", type: "DC" }, token);
    const est3 = await request("GET", `/api/shipments/${ship3Id}/landed-cost-estimate`, null, token);
    assert("cargoValueSource is none", est3.body?.cargoValueSource === "none", JSON.stringify(est3.body));
    assert("byChapter is empty", Array.isArray(est3.body?.byChapter) && est3.body.byChapter.length === 0, JSON.stringify(est3.body));
    assert("dutyEstimateUsd is 0", est3.body?.dutyEstimateUsd === 0);
    assert("landedCostUsd equals freight alone (0, nothing accrued)", est3.body?.landedCostUsd === 0);

    console.log("\nLanded-cost estimate — 404 for a non-existent shipment");
    const notFound = await request("GET", "/api/shipments/DOESNOTEXIST-999/landed-cost-estimate", null, token);
    assert("404 for non-existent shipment", notFound.status === 404);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${ship1Id}`, null, token);
    await request("DELETE", `/api/customers/${cust.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${ship2Id}`, null, token);
    await request("DELETE", `/api/customers/${cust2.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${ship3Id}`, null, token);
    await request("DELETE", `/api/customers/${cust3.body.id}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("\nFATAL:", e.message);
    process.exit(1);
  }
})();
