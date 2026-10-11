/**
 * Space Exceeded badge (shipments.space_badge, server.js recomputeSpaceBadge) — decided 2026-10-09,
 * TKT-4JU8C8: pending bookings count against space, as in the contract picker and the dashboard
 * (allocated − confirmed − pending). A shipment not yet confirmed is measured against everything else
 * in its configuration's pool, confirmed or pending; one the carrier has confirmed only against the
 * other confirmed bookings, so a pending booking added later flags itself, not the shipment already
 * holding confirmed space. Container, booking and status changes refresh the whole pool.
 * Also pins that a configuration has no length limit (TKT-3WX973): this one runs a whole year.
 *
 * Usage:
 *   node tests/space-badge.test.js
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
  let token, contractId, allocId;
  try {
    console.log("Logging in…");
    token = await login("claudeagent@localhost", "TestFixture!2026Zq");
    console.log("  ✓ Logged in");
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);

    console.log("\nScratch contract and a 4 TEU space configuration covering a whole year");
    const contract = await request("POST", "/api/contracts", {
      carrierCode: "MAEU", contractNumber: `BADGE-TEST-${Date.now()}`, status: "Active",
      validFrom: "2026-01-01", validTo: "2030-01-01", legs: [{ pol: "NLRTM", pod: "USNYC" }],
    }, token);
    contractId = contract.body.id;
    assert("contract created", contract.status === 201, JSON.stringify(contract.body));
    const routingId = contract.body.routings?.[0]?.id;
    const alloc = await request("POST", "/api/allocations", {
      contractId, routingIds: [routingId], allocatedTEU: 4, effectiveDate: "2026-01-01", endDate: "2026-12-31",
    }, token);
    allocId = alloc.body.id;
    assert("a 365-day configuration is accepted — no length limit (TKT-3WX973)", alloc.status === 201, JSON.stringify(alloc.body));

    const shipper = await request("POST", "/api/customers", { companyName: "Badge Test Shipper BV" }, token);
    const consignee = await request("POST", "/api/customers", { companyName: "Badge Test Consignee Inc" }, token);
    customerIds.push(shipper.body.id, consignee.body.id);
    // One 40HC (2 TEU) each.
    const newShipment = async label => {
      const s = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central", contractId,
        allocationId: allocId, etd: "2026-06-10", eta: "2026-06-22", incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.body.id, shipperName: shipper.body.companyName,
        consigneeId: consignee.body.id, consigneeName: consignee.body.companyName,
        principalId: shipper.body.id, principalName: shipper.body.companyName,
        emoOfficeId, imoOfficeId,
      }, token);
      if (s.status !== 201) throw new Error(`${label}: ${s.status} ${JSON.stringify(s.body)}`);
      shipmentIds.push(s.body.id);
      await request("POST", "/api/containers", { shipmentId: s.body.id, containerNumber: `MSKU${String(Date.now()).slice(-7)}`,
        size: "40", type: "HC", hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 }, token);
      return s.body.id;
    };
    const badge = async id => (await request("GET", `/api/shipments/${id}`, null, token)).body.spaceBadge || "";
    const confirm = (id, ref) => request("PATCH", `/api/shipments/${id}/carrier-booking/confirm`, { bookingRef: ref }, token);

    console.log("\nA confirmed, B pending: 4 TEU used, no badge");
    const A = await newShipment("A");
    await confirm(A, "MAEU-BADGE-A");
    const B = await newShipment("B");
    assert("A (confirmed) has no badge", await badge(A) === "");
    assert("B (pending) fits: 4 − 2 confirmed = 2 left", await badge(B) === "");

    console.log("\nC pending on a full configuration");
    const C = await newShipment("C");
    assert("C is Space Exceeded: 4 − 2 confirmed − 2 pending = 0 left", await badge(C) === "exceeded");
    assert("B, also pending, is flagged too: the pool's pending demand doesn't fit", await badge(B) === "exceeded");
    assert("A keeps no badge: confirmed space isn't taken by later pending bookings", await badge(A) === "");

    console.log("\nCancelling C frees its space for the pool");
    const cancelC = await request("PUT", `/api/shipments/${C}`, { status: "Cancelled" }, token);
    assert("C cancelled (never booked)", cancelC.status === 200, JSON.stringify(cancelC.body));
    assert("C, Cancelled, has no badge", await badge(C) === "");
    assert("B is back under: the pool was recomputed", await badge(B) === "");

    console.log("\nD pending, then B's booking is confirmed");
    const D = await newShipment("D");
    assert("D is over (A confirmed + B pending fill it)", await badge(D) === "exceeded");
    await confirm(B, "MAEU-BADGE-B");
    assert("B, now confirmed, is measured against confirmed space only: fits", await badge(B) === "");
    assert("D is still over", await badge(D) === "exceeded");

    console.log("\nRemoving B's container refreshes the pool");
    const ctrs = await request("GET", `/api/containers?shipmentId=${B}`, null, token);
    const bCtr = (Array.isArray(ctrs.body) ? ctrs.body : ctrs.body.results || [])[0];
    const del = await request("DELETE", `/api/shipments/${B}/containers/${bCtr?.id}`, null, token);
    assert("B's container removed", del.status === 200, JSON.stringify(del.body));
    assert("D now fits (A 2 confirmed, B 0)", await badge(D) === "");
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    if (token) {
      console.log("\nCleanup");
      for (const id of shipmentIds) await request("DELETE", `/api/shipments/${id}`, null, token);
      if (allocId) await request("DELETE", `/api/allocations/${allocId}`, null, token);
      if (contractId) await request("DELETE", `/api/contracts/${contractId}`, null, token);
      for (const id of customerIds) await request("DELETE", `/api/customers/${id}`, null, token);
    }
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
