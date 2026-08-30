/**
 * NVOCC Support — dual carrier identity (TKT-9O2B3T, Epic TKT-Q52B38)
 *
 * Scoping conclusion (this pass): shipments.carrier_code always means "the real
 * vessel-operating carrier we bought capacity from" — unchanged everywhere internal
 * (booking, schedule, EDI, Master B/L). The actual gap was narrower than the ticket's own
 * "new field pair" framing suggested: the shipment_parties NVOCC role (already built,
 * v0.71.0) already carries the customer-facing carrier-of-record identity — it just wasn't
 * surfaced on the one customer-facing surface that needed it: the public tracking page. No
 * schema change; GET /api/share/:token now also returns nvoccName (blank when unassigned).
 *
 * Also covers TKT-IB5IEX (destination deconsolidation / two-stage release): a genuinely
 * separate masterBlReleaseType column — the vessel operator releasing to the NVOCC's own
 * destination agent — independent from the pre-existing blReleaseType (the NVOCC's later
 * release to the actual consignee, on the House B/L / Delivery Order).
 *
 * Also covers TKT-UR1X17 (NVOCC co-loading / cross-tariff reference): when this shipment's own
 * NVOCC has no direct contract with the vessel operator for a lane, it tenders cargo through
 * ANOTHER NVOCC's own tariff instead. New "Co-Loading NVOCC" party role (resolves via the same
 * extensible shipment_parties mechanism the primary NVOCC role already uses) plus a free-text
 * coloadTariffReference column on shipments. The Master B/L builder (client-side, not covered by
 * this HTTP-level suite) resolves the co-loading NVOCC as the real Shipper once assigned, since
 * it's the one who actually holds the direct Master B/L relationship with the vessel operator.
 *
 * Usage:
 *   node tests/nvocc-carrier-identity.test.js
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

    console.log("\nPublic tracking page — no NVOCC assigned, nvoccName is blank, carrierCode unchanged");
    const shipPlain = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    }, token);
    const tokenPlain = await request("POST", `/api/shipments/${shipPlain.body.id}/share-token`, null, token);
    const viewPlain = await request("GET", `/api/share/${tokenPlain.body.token}`, null, null);
    assert("returns 200", viewPlain.status === 200, JSON.stringify(viewPlain.body));
    assert("nvoccName is blank with no NVOCC party assigned", viewPlain.body?.nvoccName === "", JSON.stringify(viewPlain.body));
    assert("carrierCode is the real vessel operator, unchanged", viewPlain.body?.carrierCode === "MAEU");

    console.log("\nPublic tracking page — an assigned NVOCC party surfaces as nvoccName, carrierCode still the real operator");
    const nvoccCust = await request("POST", "/api/customers", { companyName: "Test NVOCC Carrier Co", isNvocc: true, fmcNumber: "FMC-999999" }, token);
    const shipNvocc = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    }, token);
    const partyRes = await request("POST", `/api/shipments/${shipNvocc.body.id}/parties`, { role: "NVOCC", customerId: nvoccCust.body.id, customerName: nvoccCust.body.companyName }, token);
    assert("NVOCC party assigned", partyRes.status === 201, JSON.stringify(partyRes.body));

    const tokenNvocc = await request("POST", `/api/shipments/${shipNvocc.body.id}/share-token`, null, token);
    const viewNvocc = await request("GET", `/api/share/${tokenNvocc.body.token}`, null, null);
    assert("nvoccName reflects the assigned NVOCC's company name", viewNvocc.body?.nvoccName === "Test NVOCC Carrier Co", JSON.stringify(viewNvocc.body));
    assert("carrierCode is still the real vessel operator (dual identity, not a replacement)", viewNvocc.body?.carrierCode === "MAEU", JSON.stringify(viewNvocc.body));

    console.log("\nMaster B/L Release Type — a genuinely separate release event from B/L Release Type (TKT-IB5IEX)");
    const badRelease = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      masterBlReleaseType: "Not A Real Type",
    }, token);
    assert("invalid masterBlReleaseType rejected on create", badRelease.status >= 400, JSON.stringify(badRelease.body));

    const shipRelease = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      masterBlNumber: "MAEU987654321", masterBlReleaseType: "Telex Release", blReleaseType: "",
    }, token);
    assert("create returns 201", shipRelease.status === 201, JSON.stringify(shipRelease.body));
    assert("masterBlReleaseType round-trips on create", shipRelease.body?.masterBlReleaseType === "Telex Release", JSON.stringify(shipRelease.body));
    assert("blReleaseType (the separate, House-side release) is untouched/blank", shipRelease.body?.blReleaseType === "", JSON.stringify(shipRelease.body));

    const updateRelease = await request("PUT", `/api/shipments/${shipRelease.body.id}`, {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT",
      masterBlNumber: "MAEU987654321", masterBlReleaseType: "Surrendered", blReleaseType: "Original",
    }, token);
    assert("update returns 200", updateRelease.status === 200, JSON.stringify(updateRelease.body));
    assert("masterBlReleaseType updates independently", updateRelease.body?.masterBlReleaseType === "Surrendered", JSON.stringify(updateRelease.body));
    assert("blReleaseType (House-side) can independently be set to a DIFFERENT value — two real release events, not one", updateRelease.body?.blReleaseType === "Original", JSON.stringify(updateRelease.body));

    console.log("\nCo-Loading NVOCC party role — resolves via the existing shipment_parties mechanism, zero new party infrastructure");
    const coloadCust = await request("POST", "/api/customers", { companyName: "Test Co-Load NVOCC Partner", isNvocc: true, fmcNumber: "FMC-888888" }, token);
    const shipCoload = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    }, token);
    const coloadPartyRes = await request("POST", `/api/shipments/${shipCoload.body.id}/parties`,
      { role: "Co-Loading NVOCC", customerId: coloadCust.body.id, customerName: coloadCust.body.companyName }, token);
    assert("Co-Loading NVOCC party accepted (valid role)", coloadPartyRes.status === 201, JSON.stringify(coloadPartyRes.body));
    const invalidRoleRes = await request("POST", `/api/shipments/${shipCoload.body.id}/parties`,
      { role: "Not A Real Role", customerId: coloadCust.body.id, customerName: coloadCust.body.companyName }, token);
    assert("a bogus role is still rejected (not accidentally opened up)", invalidRoleRes.status >= 400, JSON.stringify(invalidRoleRes.body));
    // Both an NVOCC and a Co-Loading NVOCC party can coexist on one shipment — the whole point
    // is representing the underlying NVOCC (House B/L side) and the co-loading NVOCC (the one
    // that actually holds the Master B/L relationship) at once, as two distinct role slots.
    const primaryNvoccOnCoload = await request("POST", `/api/shipments/${shipCoload.body.id}/parties`,
      { role: "NVOCC", customerId: coloadCust.body.id, customerName: "Underlying NVOCC Co" }, token);
    assert("primary NVOCC role can coexist alongside Co-Loading NVOCC on the same shipment", primaryNvoccOnCoload.status === 201, JSON.stringify(primaryNvoccOnCoload.body));

    console.log("\nCo-Load Tariff Reference — free-text field, round-trips independently of the primary contract");
    const shipTariff = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      coloadTariffReference: "COLOAD-TARIFF-00123",
    }, token);
    assert("create returns 201", shipTariff.status === 201, JSON.stringify(shipTariff.body));
    assert("coloadTariffReference round-trips on create", shipTariff.body?.coloadTariffReference === "COLOAD-TARIFF-00123", JSON.stringify(shipTariff.body));

    const shipTariffBlank = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    }, token);
    assert("blank by default — the direct NVOCC-to-vessel-operator case needs no tariff reference", shipTariffBlank.body?.coloadTariffReference === "", JSON.stringify(shipTariffBlank.body));

    const updateTariff = await request("PUT", `/api/shipments/${shipTariff.body.id}`, {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT",
      coloadTariffReference: "COLOAD-TARIFF-REVISED",
    }, token);
    assert("update returns 200", updateTariff.status === 200, JSON.stringify(updateTariff.body));
    assert("coloadTariffReference updates independently of contractRef/contractId", updateTariff.body?.coloadTariffReference === "COLOAD-TARIFF-REVISED", JSON.stringify(updateTariff.body));

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipPlain.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipNvocc.body.id}`, null, token);
    await request("DELETE", `/api/customers/${nvoccCust.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipRelease.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipCoload.body.id}`, null, token);
    await request("DELETE", `/api/customers/${coloadCust.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipTariff.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipTariffBlank.body.id}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("\nFATAL:", e.message);
    process.exit(1);
  }
})();
