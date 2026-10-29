/**
 * Container cargo manifest — typed pack hierarchy (Pallet/Carton/Box/...) smoke tests
 *
 * Usage:
 *   node tests/container-packages.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: "localhost",
      port: 3001,
      path,
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
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost",
    password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token)
    throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    const { emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId } = await ensureOffices(token);

    console.log("\nPack-type-definitions registry (seeded defaults)");
    const list = await request("GET", "/api/pack-type-definitions", null, token);
    assert("list returns 200", list.status === 200);
    assert("seeded defaults present (Pallet, Carton, Box, ...)",
      Array.isArray(list.body) && list.body.some(t => t.code === "PALLET") && list.body.some(t => t.code === "CARTON"));
    const palletType = list.body.find(t => t.code === "PALLET");
    const cartonType  = list.body.find(t => t.code === "CARTON");

    console.log("\nCRUD a custom pack type");
    const created = await request("POST", "/api/pack-type-definitions",
      { code: "TESTBUNDLE", label: "Test Bundle", icon: "🧪", sortOrder: 999 }, token);
    assert("create returns 201/200 with an id", !!created.body.id);
    const updated = await request("PUT", `/api/pack-type-definitions/${created.body.id}`,
      { code: "TESTBUNDLE", label: "Test Bundle Updated", icon: "🧪", sortOrder: 999, isActive: false }, token);
    assert("update round-trips new label", updated.body.label === "Test Bundle Updated");
    assert("update round-trips isActive=false", updated.body.isActive === false);
    const removed = await request("DELETE", `/api/pack-type-definitions/${created.body.id}`, null, token);
    assert("delete returns ok", removed.body.ok === true);

    console.log("\nScratch shipment + container");
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId,
    }, token);
    const shipmentId = ship.body.id;
    assert("scratch shipment created", !!shipmentId);
    const ctr = await request("POST", "/api/containers", { shipmentId, size: "40", type: "HC",
      marksAndNumbers: "IN DIAMOND / MADE IN NL / NO. 1-50" }, token);
    const containerId = ctr.body.id;
    assert("container created", !!containerId);
    assert("marksAndNumbers round-trips on create", ctr.body.marksAndNumbers === "IN DIAMOND / MADE IN NL / NO. 1-50");

    console.log("\nMarks & Nos. round-trips on update too");
    const ctrUpdated = await request("PUT", `/api/shipments/${shipmentId}/containers/${containerId}`,
      { containerNumber: ctr.body.containerNumber, size: "40", type: "HC", hsCode: "8471.30",
        cargoDescription: "Test cargo", marksAndNumbers: "UPDATED MARKS" }, token);
    assert("update returns 200", ctrUpdated.status === 200);
    assert("marksAndNumbers round-trips on update", ctrUpdated.body.marksAndNumbers === "UPDATED MARKS");

    console.log("\nTyped tree: root Pallet with a Carton child, Pallet flagged DG");
    const pallet = await request("POST", `/api/shipments/${shipmentId}/containers/${containerId}/packages`,
      { description: "Bottles of olive oil", quantity: 2, packTypeId: palletType.id, isDg: true, dgClass: "3" }, token);
    assert("pallet created (201)", pallet.status === 201);
    assert("pallet has packTypeId intact", pallet.body.packTypeId === palletType.id);
    assert("pallet has no parentId (root)", pallet.body.parentId === null);
    assert("pallet isDg/dgClass round-trip on create", pallet.body.isDg === true && pallet.body.dgClass === "3");

    const carton = await request("POST", `/api/shipments/${shipmentId}/containers/${containerId}/packages`,
      { parentId: pallet.body.id, description: "Boxes on top", quantity: 5, packTypeId: cartonType.id }, token);
    assert("carton child created (201)", carton.status === 201);
    assert("carton has packTypeId intact", carton.body.packTypeId === cartonType.id);
    assert("carton parentId points at the pallet", carton.body.parentId === pallet.body.id);
    assert("carton defaults isDg to false", carton.body.isDg === false);

    const tree = await request("GET", `/api/shipments/${shipmentId}/containers/${containerId}/packages`, null, token);
    assert("tree returns 200", tree.status === 200);
    assert("tree has both nodes", Array.isArray(tree.body) && tree.body.length === 2);
    const tPallet = tree.body.find(p => p.id === pallet.body.id);
    const tCarton = tree.body.find(p => p.id === carton.body.id);
    assert("tree pallet keeps packTypeId", tPallet?.packTypeId === palletType.id);
    assert("tree pallet keeps isDg/dgClass", tPallet?.isDg === true && tPallet?.dgClass === "3");
    assert("tree carton keeps packTypeId + parentId nesting", tCarton?.packTypeId === cartonType.id && tCarton?.parentId === pallet.body.id);

    console.log("\nUpdating a node preserves/round-trips packTypeId and isDg/dgClass (including turning DG off)");
    const updatedPallet = await request("PUT", `/api/shipments/${shipmentId}/container-packages/${pallet.body.id}`,
      { description: "Bottles of olive oil (relabeled)", quantity: 3, packTypeId: palletType.id, isDg: false, dgClass: "" }, token);
    assert("update returns 200", updatedPallet.status === 200);
    assert("update round-trips packTypeId", updatedPallet.body.packTypeId === palletType.id);
    assert("update round-trips isDg turned off", updatedPallet.body.isDg === false && updatedPallet.body.dgClass === "");

    console.log("\nStructured value/currency/HS override (TKT-PV5P5L)");
    const priced = await request("POST", `/api/shipments/${shipmentId}/containers/${containerId}/packages`,
      { description: "Priced carton", quantity: 4, unitValue: 25.5, currency: "EUR", hsCode: "6203.42" }, token);
    assert("priced item created (201)", priced.status === 201);
    assert("unitValue round-trips", priced.body.unitValue === 25.5);
    assert("currency round-trips", priced.body.currency === "EUR");
    assert("hsCode round-trips", priced.body.hsCode === "6203.42");
    assert("unitValueUsd computed (non-null)", priced.body.unitValueUsd != null);

    const unpriced = await request("POST", `/api/shipments/${shipmentId}/containers/${containerId}/packages`,
      { description: "Unpriced carton", quantity: 1 }, token);
    assert("unpriced item defaults unitValue to null (not 0)", unpriced.body.unitValue === null);
    assert("unpriced item defaults currency to ''", unpriced.body.currency === "");
    assert("unpriced item defaults unitValueUsd to null", unpriced.body.unitValueUsd === null);

    const clearedBack = await request("PUT", `/api/shipments/${shipmentId}/container-packages/${priced.body.id}`,
      { description: "Priced carton", quantity: 4 }, token); // omit unitValue/currency entirely
    assert("clearing value back to blank nulls unitValue", clearedBack.body.unitValue === null);
    assert("clearing value back to blank nulls unitValueUsd", clearedBack.body.unitValueUsd === null);

    const negRejected = await request("POST", `/api/shipments/${shipmentId}/containers/${containerId}/packages`,
      { description: "Bad value", quantity: 1, unitValue: -5 }, token);
    assert("negative unitValue rejected", negRejected.status !== 201);

    await request("DELETE", `/api/shipments/${shipmentId}/container-packages/${priced.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipmentId}/container-packages/${unpriced.body.id}`, null, token);

    console.log("\nDeleting the parent cascade-deletes the child");
    const del = await request("DELETE", `/api/shipments/${shipmentId}/container-packages/${pallet.body.id}`, null, token);
    assert("delete returns 200", del.status === 200);
    assert("delete response lists both ids", del.body.deleted.includes(pallet.body.id) && del.body.deleted.includes(carton.body.id));
    const afterDelete = await request("GET", `/api/shipments/${shipmentId}/containers/${containerId}/packages`, null, token);
    assert("tree is empty after cascade delete", Array.isArray(afterDelete.body) && afterDelete.body.length === 0);

    // The DG emergency contact is the shipper's own, on its customer profile (2026-10-29, the user's call); the
    // org-wide App Settings one (TKT-DPLQTV) is gone.
    console.log("\nThe shipper's DG emergency contact, on its customer profile");
    const dgShipperBase = { companyName: `Hamburg Chemie Export GmbH ${Date.now()}`, address1: "Reiherstieg 18", city: "Hamburg",
      postalCode: "21107", countryIso2: "DE", email: "versand@hamburgchemie.example" };
    const dgShipper = await request("POST", "/api/customers", { ...dgShipperBase,
      dgEmergencyContact: { contact: "Hamburg Chemie Notfall", phone: "+49 40 7533 9100", provider: "NRC Germany", referenceNumber: "HC-DG-0091" } }, token);
    assert("created with its DG emergency contact (201)", dgShipper.status === 201
      && dgShipper.body.dgEmergencyContact?.contact === "Hamburg Chemie Notfall" && dgShipper.body.dgEmergencyContact?.provider === "NRC Germany", JSON.stringify(dgShipper.body));
    const dgKept = await request("PUT", `/api/customers/${dgShipper.body.id}`, { ...dgShipperBase, phone: "+49 40 7533 0" }, token);
    assert("a profile save that doesn't mention it keeps it", dgKept.status === 200
      && dgKept.body.dgEmergencyContact?.phone === "+49 40 7533 9100" && dgKept.body.dgEmergencyContact?.referenceNumber === "HC-DG-0091", JSON.stringify(dgKept.body?.dgEmergencyContact));
    const dgBadPhone = await request("PUT", `/api/customers/${dgShipper.body.id}`, { ...dgShipperBase, dgEmergencyContact: { contact: "Notfall", phone: "call the office" } }, token);
    assert("a phone that isn't a phone number is refused (400)", dgBadPhone.status === 400 && /phone number/.test(dgBadPhone.body?.error), JSON.stringify(dgBadPhone.body));
    const dgNoName = await request("PUT", `/api/customers/${dgShipper.body.id}`, { ...dgShipperBase, dgEmergencyContact: { phone: "+49 40 7533 9100", provider: "NRC Germany" } }, token);
    assert("a contact with no name is refused (400)", dgNoName.status === 400, JSON.stringify(dgNoName.body));
    const dgCleared = await request("PUT", `/api/customers/${dgShipper.body.id}`, { ...dgShipperBase, dgEmergencyContact: null }, token);
    assert("null clears it", dgCleared.status === 200 && dgCleared.body.dgEmergencyContact === null, JSON.stringify(dgCleared.body?.dgEmergencyContact));
    await request("DELETE", `/api/customers/${dgShipper.body.id}`, null, token);

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
