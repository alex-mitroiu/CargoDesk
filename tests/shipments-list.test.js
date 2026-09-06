/**
 * GET /api/shipments (list) + GET /api/shipments/compliance-hits — smoke tests
 *
 * Every other test file creates/reads/updates/deletes individual shipments by id, but none of
 * them ever call the bare list endpoint itself — previously zero direct coverage of the join-
 * heavy list query (margin totals, overdue-milestone count, booking status, resolved sea ports)
 * or its pagination opt-in, and none of the compliance-hits view either.
 *
 * Usage:
 *   node tests/shipments-list.test.js
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

    console.log("\nScratch shipment with a SEA leg, cost lines (BUY+SELL), and an overdue milestone");
    const shp = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", etd: "2026-01-01",
    }, token);
    assert("scratch shipment created", shp.status === 201);
    const shipmentId = shp.body.id;
    await request("POST", `/api/shipments/${shipmentId}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-01-01" }, token);
    await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "BUY", chargeCode: "OFR", currency: "USD", amount: 800 }, token);
    await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "SELL", chargeCode: "OFR", currency: "USD", amount: 1200 }, token);
    let milestones = await request("GET", `/api/shipments/${shipmentId}/milestones`, null, token);
    if (milestones.body.length === 0) {
      await request("POST", `/api/shipments/${shipmentId}/milestones/init`, {}, token);
      milestones = await request("GET", `/api/shipments/${shipmentId}/milestones`, null, token);
    }
    const firstMilestone = milestones.body[0];
    if (firstMilestone) {
      await request("PUT", `/api/shipments/${shipmentId}/milestones/${firstMilestone.id}`, { estimatedDate: "2020-01-01" }, token);
    }

    console.log("\nGET /api/shipments — bare list (no pagination params)");
    const listAll = await request("GET", "/api/shipments", null, token);
    assert("returns 200", listAll.status === 200);
    assert("returns a bare array by default (no ?limit=/?offset=)", Array.isArray(listAll.body));
    const ours = listAll.body.find(s => s.id === shipmentId);
    assert("our scratch shipment appears in the list", !!ours);
    assert("resolved sea port fields present (seaPol/seaPod)", ours && ours.seaPol === "NLRTM" && ours.seaPod === "USNYC");
    assert("margin fields present (buy/sell totals from the cost-line joins)", ours && "marginBuyUsd" in ours && "marginSellUsd" in ours);
    assert("booking status field present (LEFT JOIN carrier_bookings, null-safe when none exists)", ours && "bookingStatus" in ours);
    if (firstMilestone) assert("overdueCount reflects our backdated milestone", ours && ours.overdueCount >= 1);

    console.log("\nGET /api/shipments?limit=&offset= — pagination opt-in");
    const listPaged = await request("GET", "/api/shipments?limit=1&offset=0", null, token);
    assert("paginated call returns results/total/limit/offset shape", ["results", "total", "limit", "offset"].every(k => k in listPaged.body));
    assert("results respects the limit", listPaged.body.results.length <= 1);
    assert("total reflects the full filtered count, not just this page", listPaged.body.total >= 1);
    const listPagedOffset = await request("GET", "/api/shipments?limit=500&offset=0", null, token);
    assert("a large-enough page still includes our shipment", listPagedOffset.body.results.some(s => s.id === shipmentId));

    console.log("\nGET /api/shipments without a token is rejected");
    const noAuth = await request("GET", "/api/shipments", null, null);
    assert("rejected (401)", noAuth.status === 401);

    console.log("\nGET /api/shipments/compliance-hits — shipments with an active sanctions HIT");
    const hits = await request("GET", "/api/shipments/compliance-hits", null, token);
    assert("returns 200", hits.status === 200);
    assert("returns an array", Array.isArray(hits.body));
    assert("our clean scratch shipment is NOT in the hits list", !hits.body.some(s => s.id === shipmentId));
    if (hits.body.length > 0) {
      assert("a real hit row carries a screening sub-object", "screening" in hits.body[0]);
      assert("screening.result is HIT for every row (query is WHERE result='HIT')", hits.body.every(s => s.screening.result === "HIT"));
      assert("screening.hits is a parsed array, not a raw JSON string", Array.isArray(hits.body[0].screening.hits));
    }

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
