/**
 * Shipment data integrity — regression tests for three ISTQB QA findings (2026-09-15), fixed in
 * v0.91.3 "Horizon" and pinned here so they can't quietly come back:
 *   - TKT-HZOAE0  duplicate container numbers on one shipment are refused (POST and PUT, 409)
 *   - TKT-FH5Q94  the Export / Import Managing Offices are required on create and can't be cleared
 *   - TKT-LXQNQG  Declared Value can't be negative — on create AND on update (the update path was
 *                 still open until 2026-10-09)
 *
 * Usage:
 *   node tests/shipment-integrity.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC present in port_locations (seeded MDM data)
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

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
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  const shipmentIds = [], customerIds = [];
  let token;
  try {
    console.log("Logging in…");
    token = await login("claudeagent@localhost", "TestFixture!2026Zq");
    console.log("  ✓ Logged in");
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);

    const shipper = await request("POST", "/api/customers", { companyName: "Integrity Test Shipper BV" }, token);
    const consignee = await request("POST", "/api/customers", { companyName: "Integrity Test Consignee Inc" }, token);
    customerIds.push(shipper.body.id, consignee.body.id);
    assert("shipper and consignee customers created", !!shipper.body.id && !!consignee.body.id);

    // A complete shipment: parties, incoterm, POL/POD, ETD/ETA, commodity, both managing offices.
    const payload = {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      etd: "2026-11-02", eta: "2026-11-14", incoterm: "FOB", commodityCode: "9999",
      shipperId: shipper.body.id, shipperName: shipper.body.companyName,
      consigneeId: consignee.body.id, consigneeName: consignee.body.companyName,
      emoOfficeId, imoOfficeId,
    };
    const create = async extra => {
      const res = await request("POST", "/api/shipments", { ...payload, ...extra }, token);
      if (res.body?.id) shipmentIds.push(res.body.id);
      return res;
    };

    console.log("\nTKT-FH5Q94 — Export / Import Managing Office are required");
    const noEmo = await create({ emoOfficeId: null });
    assert("create without an Export Managing Office is refused (400)", noEmo.status === 400, JSON.stringify(noEmo.body));
    const noImo = await create({ imoOfficeId: "" });
    assert("create without an Import Managing Office is refused (400)", noImo.status === 400, JSON.stringify(noImo.body));
    const good = await create({});
    assert("create with both offices succeeds (201)", good.status === 201, JSON.stringify(good.body));
    const shipmentId = good.body.id;
    const clearEmo = await request("PUT", `/api/shipments/${shipmentId}`, { emoOfficeId: null }, token);
    assert("clearing the Export Managing Office on update is refused (400)",
      clearEmo.status === 400 && /cannot be cleared/.test(clearEmo.body.error || ""), JSON.stringify(clearEmo.body));
    const clearImo = await request("PUT", `/api/shipments/${shipmentId}`, { imoOfficeId: "" }, token);
    assert("clearing the Import Managing Office on update is refused (400)",
      clearImo.status === 400 && /cannot be cleared/.test(clearImo.body.error || ""), JSON.stringify(clearImo.body));
    const afterClear = await request("GET", `/api/shipments/${shipmentId}`, null, token);
    assert("both offices are still set afterwards",
      afterClear.body.emoOfficeId === emoOfficeId && afterClear.body.imoOfficeId === imoOfficeId, JSON.stringify(afterClear.body));

    console.log("\nTKT-LXQNQG — Declared Value can't be negative");
    const negCreate = await create({ declaredValue: -500 });
    assert("create with a negative Declared Value is refused (400)", negCreate.status === 400, JSON.stringify(negCreate.body));
    const zeroCreate = await create({ declaredValue: 0 });
    assert("create with a Declared Value of 0 is allowed (boundary)", zeroCreate.status === 201, JSON.stringify(zeroCreate.body));
    const setValue = await request("PUT", `/api/shipments/${shipmentId}`, { declaredValue: 1250, declaredValueCurrency: "USD" }, token);
    assert("update to a positive Declared Value succeeds", setValue.status === 200 && Number(setValue.body.declaredValue) === 1250, JSON.stringify(setValue.body));
    const negUpdate = await request("PUT", `/api/shipments/${shipmentId}`, { declaredValue: -500 }, token);
    assert("update to a negative Declared Value is refused (400)", negUpdate.status === 400, JSON.stringify(negUpdate.body));
    const negString = await request("PUT", `/api/shipments/${shipmentId}`, { declaredValue: "-0.01" }, token);
    assert("…also when it arrives as a string", negString.status === 400, JSON.stringify(negString.body));
    const afterNeg = await request("GET", `/api/shipments/${shipmentId}`, null, token);
    assert("the stored Declared Value is unchanged", Number(afterNeg.body.declaredValue) === 1250, JSON.stringify(afterNeg.body.declaredValue));
    const clearValue = await request("PUT", `/api/shipments/${shipmentId}`, { declaredValue: null }, token);
    assert("clearing the Declared Value (null) is still allowed", clearValue.status === 200, JSON.stringify(clearValue.body));

    console.log("\nTKT-HZOAE0 — container numbers are unique within a shipment");
    const ctr = extra => request("POST", "/api/containers", {
      shipmentId, size: "40", type: "HC", hsCode: "847130", cargoDescription: "Laptop computers",
      grossWeightKg: 12000, volumeCbm: 58, ...extra,
    }, token);
    const first = await ctr({ containerNumber: "MSKU1234565" });
    assert("first container MSKU1234565 is added (201)", first.status === 201, JSON.stringify(first.body));
    const dup = await ctr({ containerNumber: "MSKU1234565", size: "20", type: "GP" });
    assert("a second container with the same number is refused (409)", dup.status === 409, JSON.stringify(dup.body));
    const dupLower = await ctr({ containerNumber: "msku1234565" });
    assert("…case doesn't get around it (numbers are stored upper-case)", dupLower.status === 409, JSON.stringify(dupLower.body));
    const blankA = await ctr({ containerNumber: "" });
    const blankB = await ctr({ containerNumber: "" });
    assert("two blank-numbered containers are fine (filled in later)", blankA.status === 201 && blankB.status === 201);
    const putDup = await request("PUT", `/api/shipments/${shipmentId}/containers/${blankA.body.id}`,
      { containerNumber: "MSKU1234565", size: "40", type: "HC" }, token);
    assert("updating another container to the taken number is refused (409)", putDup.status === 409, JSON.stringify(putDup.body));
    const putSelf = await request("PUT", `/api/shipments/${shipmentId}/containers/${first.body.id}`,
      { containerNumber: "MSKU1234565", size: "40", type: "HC", hsCode: "847130", cargoDescription: "Laptop computers, re-saved" }, token);
    assert("re-saving a container with its own number is fine (200)", putSelf.status === 200, JSON.stringify(putSelf.body));
    const other = await create({});
    const otherCtr = await request("POST", "/api/containers", { shipmentId: other.body.id, containerNumber: "MSKU1234565", size: "40", type: "HC" }, token);
    assert("another shipment can use the same number (201)", otherCtr.status === 201, JSON.stringify(otherCtr.body));
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    if (token) {
      console.log("\nCleanup");
      for (const id of shipmentIds) await request("DELETE", `/api/shipments/${id}`, null, token);
      for (const id of customerIds) await request("DELETE", `/api/customers/${id}`, null, token);
    }
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
