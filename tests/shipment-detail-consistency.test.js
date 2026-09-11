/**
 * TKT-shipment-detail-consistency — regression test for a real bug found via live QA:
 * GET/PUT /api/shipments/:id used to omit the enrichment JOINs (carrier_bookings,
 * shipment_cost_lines, shipment_milestones, containers TEU) that GET /api/shipments (the list)
 * always had, so bookingStatus/teu/overdueCount/marginBuyUsd/marginSellUsd silently came back
 * null/0 from the single-shipment routes even when the list correctly showed real values.
 * src/App.jsx merges those narrower responses straight into shared app state
 * ({...s, ...fresh}), so confirming a carrier booking (which refreshes via GET/:id) would flip
 * that shipment's in-memory bookingStatus to null — misclassifying it as Pending everywhere the
 * Dashboard reads from shared state, until a full page reload.
 *
 * This test creates a shipment with all of those enrichable fields genuinely non-default
 * (a container, a Confirmed booking, a BUY and a SELL cost line) and asserts the list, the
 * single-item GET, and the PUT response all agree — plus exercises POST
 * /api/shipments/:id/reassign-office, which had the identical gap.
 *
 * Usage:
 *   node tests/shipment-detail-consistency.test.js
 *
 * Prerequisites:
 *   - npm run server  (Express on :3001)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      method, hostname: "localhost", port: 3001, path,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
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

async function main() {
  let shipmentId = null;
  let officeId = null;
  let exitCode = 0;

  try {
    const token = await login();

    console.log("\nSetup — scratch shipment with a container, a Confirmed booking, BUY+SELL cost lines");
    const ship = await request("POST", "/api/shipments", {
      pol: "CNSHA", pod: "USLAX", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    }, token);
    assert("scratch shipment created", ship.status === 201, JSON.stringify(ship.body));
    shipmentId = ship.body.id;

    const ctr = await request("POST", "/api/containers", { shipmentId, size: "40", type: "GP" }, token); // 2 TEU
    assert("scratch container created", ctr.status === 201, JSON.stringify(ctr.body));

    const confirm = await request("PATCH", `/api/shipments/${shipmentId}/carrier-booking/confirm`, { bookingRef: "CONSISTENCY-TEST-1" }, token);
    assert("carrier booking confirmed", confirm.status === 200 && confirm.body?.status === "Confirmed", JSON.stringify(confirm.body));

    const buyLine = await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "BUY", chargeCode: "Ocean Freight", amount: 500 }, token);
    assert("BUY cost line created", buyLine.status === 201, JSON.stringify(buyLine.body));
    const sellLine = await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "SELL", chargeCode: "Ocean Freight", amount: 750 }, token);
    assert("SELL cost line created", sellLine.status === 201, JSON.stringify(sellLine.body));

    console.log("\nGET /api/shipments (list) — the known-correct baseline");
    const list = await request("GET", "/api/shipments", null, token);
    const fromList = (list.body.results || list.body).find(s => s.id === shipmentId);
    assert("shipment present in list", !!fromList, "not found in list response");
    assert("list: bookingStatus is Confirmed", fromList?.bookingStatus === "Confirmed", JSON.stringify(fromList?.bookingStatus));
    assert("list: teu is 2 (one 40ft container)", fromList?.teu === 2, JSON.stringify(fromList?.teu));
    assert("list: marginBuyUsd is 500", fromList?.marginBuyUsd === 500, JSON.stringify(fromList?.marginBuyUsd));
    assert("list: marginSellUsd is 750", fromList?.marginSellUsd === 750, JSON.stringify(fromList?.marginSellUsd));

    console.log("\nGET /api/shipments/:id — must agree with the list, not silently zero/null these fields");
    const single = await request("GET", `/api/shipments/${shipmentId}`, null, token);
    assert("single: bookingStatus matches list (Confirmed, not null)", single.body?.bookingStatus === fromList.bookingStatus, JSON.stringify(single.body?.bookingStatus));
    assert("single: teu matches list (2, not 0)", single.body?.teu === fromList.teu, JSON.stringify(single.body?.teu));
    assert("single: marginBuyUsd matches list (500, not null)", single.body?.marginBuyUsd === fromList.marginBuyUsd, JSON.stringify(single.body?.marginBuyUsd));
    assert("single: marginSellUsd matches list (750, not null)", single.body?.marginSellUsd === fromList.marginSellUsd, JSON.stringify(single.body?.marginSellUsd));
    assert("single: overdueCount matches list", single.body?.overdueCount === fromList.overdueCount, JSON.stringify([single.body?.overdueCount, fromList.overdueCount]));

    console.log("\nPUT /api/shipments/:id — its own re-select response must agree too");
    const put = await request("PUT", `/api/shipments/${shipmentId}`, {
      pol: "CNSHA", pod: "USLAX", carrierCode: "MAEU", contractType: "SPOT", status: "Active", notes: "consistency check",
    }, token);
    assert("PUT returns 200", put.status === 200, JSON.stringify(put.body));
    assert("PUT response: bookingStatus matches list (Confirmed, not null)", put.body?.bookingStatus === fromList.bookingStatus, JSON.stringify(put.body?.bookingStatus));
    assert("PUT response: teu matches list (2, not 0)", put.body?.teu === fromList.teu, JSON.stringify(put.body?.teu));
    assert("PUT response: marginBuyUsd matches list (500, not null)", put.body?.marginBuyUsd === fromList.marginBuyUsd, JSON.stringify(put.body?.marginBuyUsd));
    assert("PUT response: marginSellUsd matches list (750, not null)", put.body?.marginSellUsd === fromList.marginSellUsd, JSON.stringify(put.body?.marginSellUsd));

    console.log("\nPOST /api/shipments/:id/reassign-office — same enrichment gap, different route");
    const officeRes = await request("POST", "/api/offices", { unlocode: "ZM" + Math.random().toString(36).slice(2, 5).toUpperCase(), countryCode: "ZM", department: "SE", name: `Consistency Test Office ${Date.now()}` }, token);
    officeId = officeRes.body?.id;
    assert("scratch office created", officeRes.status === 201, JSON.stringify(officeRes.body));
    const reassign = await request("POST", `/api/shipments/${shipmentId}/reassign-office`, { field: "emoOfficeId", officeId, reason: "consistency test" }, token);
    assert("reassign-office returns 200", reassign.status === 200, JSON.stringify(reassign.body));
    assert("reassign-office response: bookingStatus matches list (Confirmed, not null)", reassign.body?.bookingStatus === fromList.bookingStatus, JSON.stringify(reassign.body?.bookingStatus));
    assert("reassign-office response: teu matches list (2, not 0)", reassign.body?.teu === fromList.teu, JSON.stringify(reassign.body?.teu));
    assert("reassign-office response: marginBuyUsd matches list (500, not null)", reassign.body?.marginBuyUsd === fromList.marginBuyUsd, JSON.stringify(reassign.body?.marginBuyUsd));

    console.log(`\n${passed} passed, ${failed} failed`);
    exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e.stack || e.message);
    exitCode = 1;
  } finally {
    try {
      const token = await login();
      if (shipmentId) await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
      if (officeId) await request("DELETE", `/api/offices/${officeId}`, null, token);
    } catch (e) { console.error("Cleanup error (non-fatal):", e.message); }
  }
  process.exit(exitCode);
}

main();
