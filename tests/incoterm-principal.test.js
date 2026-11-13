/**
 * The principal an incoterm implies, on the server (2026-11-13, lib/incoterm-principal.js; the gaps found in
 * documentation/incoterms-principal-and-charges.html):
 *   - a shipment created without a principal gets the one its incoterm implies (C/D terms the shipper, E/F terms the
 *     consignee); one sent is kept;
 *   - a full-record update (the Conditions and Parties pages send the old principal back) moves a principal that
 *     follows the rule when the incoterm, the shipper or the consignee changes; a principal someone chose stays; one
 *     changed in the same request is the caller's;
 *   - a quote converted without a principal gets the one its incoterm implies.
 *
 * Usage:
 *   node tests/incoterm-principal.test.js
 *
 * Prerequisites:
 *   - Express server on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "./helpers/offices.mjs";

const BASE = "http://localhost:3001";
let passed = 0, failed = 0;

async function request(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body !== undefined && body !== null && { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: parsed };
}
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const customer = async (companyName, address1, postalCode, city, countryIso2) =>
      (await request("POST", "/api/customers", { companyName, address1, postalCode, city, countryIso2 }, token)).body;
    const shipper = await customer(`Van Leeuwen Meubelen ${rand} BV`, "Waalhaven Oostzijde 81", "3087 BM", "Rotterdam", "NL");
    const consignee = await customer(`Hudson Home Imports ${rand} Inc`, "250 Port Jersey Blvd", "07305", "Jersey City", "US");
    const consignee2 = await customer(`Atlantic Living ${rand} LLC`, "1 Harborside Pl", "07311", "Jersey City", "US");
    const parent = await customer(`Van Leeuwen Holding ${rand} NV`, "Coolsingel 40", "3011 AD", "Rotterdam", "NL");
    // A complete NLRTM → USNYC MAEU shipment: parties, incoterm, dates, commodity, offices.
    const create = (incoterm, extra = {}) => request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central", contractRef: "MAEU-SC-2026-0418",
      etd: inDays(10), eta: inDays(22), incoterm, commodityCode: "9999", cargoReadyDate: inDays(8), freightTerms: "Prepaid",
      shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      notifyId: consignee.id, notifyName: consignee.companyName, emoOfficeId, imoOfficeId, ...extra }, token);
    const get = async id => (await request("GET", `/api/shipments/${id}`, null, token)).body;
    // What the Conditions and Parties pages send: the whole record, changed fields on top.
    const saveFullRecord = async (id, changes) => request("PUT", `/api/shipments/${id}`, { ...(await get(id)), ...changes }, token);

    console.log("\nCreated without a principal");
    const fob = await create("FOB");
    assert("FOB: the consignee is the principal", fob.status === 201 && fob.body.principalId === consignee.id && fob.body.principalName === consignee.companyName,
      JSON.stringify({ s: fob.status, p: fob.body?.principalId }));
    const cif = await create("CIF");
    assert("CIF: the shipper is the principal", cif.body?.principalId === shipper.id && cif.body.principalName === shipper.companyName, cif.body?.principalId);
    const chosen = await create("CIF", { principalId: parent.id, principalName: parent.companyName });
    assert("a principal sent is kept (the parent company under CIF)", chosen.body?.principalId === parent.id, chosen.body?.principalId);

    console.log("\nA full-record save (Conditions, Parties)");
    let r = await saveFullRecord(fob.body.id, { incoterm: "CIF" });
    assert("FOB → CIF on Conditions: the principal moves from the consignee to the shipper", r.status === 200 && (await get(fob.body.id)).principalId === shipper.id,
      `${r.status} ${(await get(fob.body.id)).principalId}`);
    r = await saveFullRecord(fob.body.id, { incoterm: "FOB" });
    r = await saveFullRecord(fob.body.id, { consigneeId: consignee2.id, consigneeName: consignee2.companyName });
    let s = await get(fob.body.id);
    assert("a new consignee under FOB on Parties: it becomes the principal", r.status === 200 && s.principalId === consignee2.id && s.principalName === consignee2.companyName,
      JSON.stringify({ p: s.principalId, n: s.principalName }));
    r = await saveFullRecord(chosen.body.id, { incoterm: "FOB" });
    assert("a parent company chosen as principal stays when the incoterm changes", r.status === 200 && (await get(chosen.body.id)).principalId === parent.id);
    r = await saveFullRecord(cif.body.id, { incoterm: "FOB", principalId: parent.id, principalName: parent.companyName });
    assert("a principal changed in the same save is the caller's", (await get(cif.body.id)).principalId === parent.id);
    // What the History page reads (GET /api/shipments/:id/events).
    const hist = (await request("GET", `/api/shipments/${fob.body.id}/events?limit=200`, null, token)).body?.results || [];
    const moves = hist.filter(e => e.eventType === "FIELD_UPDATED" && e.field === "principal_name");
    assert("the move is on the shipment's History, with the incoterm as its reason",
      moves.some(e => e.oldValue === consignee.companyName && e.newValue === shipper.companyName && /incoterm CIF/i.test(e.meta?.reason || "")),
      JSON.stringify(hist.slice(0, 6).map(e => [e.eventType, e.field, e.oldValue, e.newValue, e.meta])));
    assert("the new consignee is on the History too",
      hist.some(e => e.field === "consignee_name" && e.newValue === consignee2.companyName));
    const chosenHist = (await request("GET", `/api/shipments/${chosen.body.id}/events?limit=200`, null, token)).body?.results || [];
    assert("a principal that stayed has no principal entry", !chosenHist.some(e => e.field === "principal_name"),
      JSON.stringify(chosenHist.filter(e => e.field === "principal_name")));

    console.log("\nA quote converted without a principal");
    const quote = (await request("POST", "/api/quotes", {
      customerId: shipper.id, customerName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", incoterm: "FOB", commodityCode: "9999", movementType: "FCL", cargoReadyDate: inDays(8),
      validUntil: inDays(14), lines: [{ serviceCode: "OF", description: "Ocean Freight", quantity: "1", rate: "2450", currency: "USD" }],
    }, token)).body;
    await request("POST", `/api/quotes/${quote.id}/send`, {}, token);
    await request("POST", `/api/quotes/${quote.id}/accept`, {}, token);
    const conv = await request("POST", `/api/quotes/${quote.id}/convert`, {}, token);
    const convId = conv.body?.shipment?.id || conv.body?.shipmentId || conv.body?.id;
    const converted = convId ? await get(convId) : null;
    assert("FOB quote: the shipment's principal is the consignee", !!converted && converted.principalId === consignee.id && converted.principalName === consignee.companyName,
      JSON.stringify({ status: conv.status, body: conv.body && Object.keys(conv.body), p: converted?.principalId }));
  } catch (e) {
    console.error("\nFatal:", e.stack || e.message);
    failed++;
  } finally {
    // The shipments, the quote and the customers stay as verification data.
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
