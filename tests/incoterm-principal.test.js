/**
 * The principal an incoterm implies, on the server (2026-11-13, lib/incoterm-principal.js; the gaps found in
 * documentation/incoterms-principal-and-charges.html):
 *   - a shipment created without a principal gets the one its incoterm implies (C/D terms the shipper, E/F terms the
 *     consignee); one sent is kept;
 *   - a full-record update (the Conditions and Parties pages send the old principal back) moves a principal that
 *     follows the rule when the incoterm, the shipper or the consignee changes; a principal someone chose stays; one
 *     changed in the same request is the caller's;
 *   - a quote converted without a principal gets the one its incoterm implies;
 *   - the pre-release audit (epic TKT-E1GOI6): the History says why when a screen sends the rule's principal itself (D3); a
 *     principal given by name only stays (D5); a principal that moves off the contract's named account or its space
 *     configuration's customer re-judges the steering verdict and the save says so (D1).
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
  const cleanup = { steerings: [], allocations: [], contracts: [], shipments: [] };
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

    console.log("\nAudit D3: a screen that sends the rule's principal itself");
    const viaScreen = await create("FOB");
    await saveFullRecord(viaScreen.body.id, { incoterm: "CIF", principalId: shipper.id, principalName: shipper.companyName });
    const screenHist = (await request("GET", `/api/shipments/${viaScreen.body.id}/events?limit=200`, null, token)).body?.results || [];
    assert("the History still says the incoterm moved it", screenHist.some(e => e.field === "principal_name" && e.newValue === shipper.companyName
      && /incoterm CIF/i.test(e.meta?.reason || "")), JSON.stringify(screenHist.filter(e => e.field === "principal_name")));
    const partyHist = (await request("GET", `/api/shipments/${cif.body.id}/events?limit=200`, null, token)).body?.results || [];
    assert("a parent company picked by hand has no reason", partyHist.some(e => e.field === "principal_name" && e.newValue === parent.companyName && !e.meta?.reason),
      JSON.stringify(partyHist.filter(e => e.field === "principal_name")));

    console.log("\nAudit D5: a principal given by name only");
    const typedName = `Van Leeuwen Holding ${rand} NV (typed)`;
    const typed = await create("CIF", { principalId: "", principalName: typedName });
    assert("created with it, not with the shipper", typed.status === 201 && typed.body.principalName === typedName && !typed.body.principalId,
      JSON.stringify({ id: typed.body?.principalId, n: typed.body?.principalName }));
    await saveFullRecord(typed.body.id, { incoterm: "FOB" });
    assert("it stays when the incoterm changes", (await get(typed.body.id)).principalName === typedName);

    console.log("\nAudit D1: the principal moves off the consignee's own contract, space and steering line");
    const named = (await request("POST", "/api/contracts", { contractNumber: `TC-IP-NAMED-${rand}`, carrierCode: "MAEU", status: "Active",
      validFrom: "2029-01-01", validTo: "2029-12-31", legs: [{ pol: "NLRTM", pod: "USNYC" }], namedAccountId: consignee.id, namedAccount: consignee.companyName,
      rates: [{ serviceCode: "OF", amount: 1900, currency: "USD", unit: "per_container" }] }, token)).body;
    cleanup.contracts.push(named.id);
    const space = await request("POST", "/api/allocations", { contractId: named.id, routingIds: [named.routings[0].id], effectiveDate: "2029-01-01",
      endDate: "2029-12-31", allocatedTEU: 20 }, token);
    if (space.status !== 201) throw new Error(`space: ${space.status} ${JSON.stringify(space.body)}`);
    cleanup.allocations.push(space.body.id);
    const ownLine = await request("POST", "/api/lane-steerings", { originLane: "EU-N", destLane: "NAM", customerId: consignee.id, customerName: consignee.companyName,
      validFrom: "2029-01-01", validTo: "2029-12-31", options: [{ carrierCode: "MAEU", contractId: named.id }] }, token);
    if (ownLine.status !== 201) throw new Error(`steering: ${ownLine.status} ${JSON.stringify(ownLine.body)}`);
    cleanup.steerings.push(ownLine.body.id);
    const onNamed = await create("FOB", { etd: "2029-03-07", eta: "2029-03-19", cargoReadyDate: "2029-03-02", contractId: named.id,
      contractRef: named.contractNumber, allocationId: space.body.id });
    if (onNamed.status !== 201) throw new Error(`shipment on the named contract: ${onNamed.status} ${JSON.stringify(onNamed.body)}`);
    cleanup.shipments.push(onNamed.body.id);
    await request("POST", "/api/containers", { shipmentId: onNamed.body.id, containerNumber: `MSKU${String(Date.now()).slice(-7)}`, size: "40", type: "HC",
      hsCode: "940360", cargoDescription: "Upholstered sofas", grossWeightKg: 8200, volumeCbm: 62 }, token);
    let ns = await get(onNamed.body.id);
    assert("FOB: the consignee is the principal, steered on its own line", ns.principalId === consignee.id && ns.steeringLineId === ownLine.body.id,
      JSON.stringify({ p: ns.principalId, line: ns.steeringLineId, v: ns.steeringVerdict }));
    const moved = await saveFullRecord(onNamed.body.id, { incoterm: "CIF" });
    ns = await get(onNamed.body.id);
    assert("CIF: the principal still follows the incoterm (the shipper)", moved.status === 200 && ns.principalId === shipper.id, `${moved.status} ${ns.principalId}`);
    assert("the save names the contract and the space that are the consignee's", moved.body?.principalNotice?.named?.length === 2
      && moved.body.principalNotice.message.includes(named.contractNumber) && moved.body.principalNotice.message.includes(consignee.companyName),
      JSON.stringify(moved.body?.principalNotice));
    assert("the steering verdict is judged again, no longer on the consignee's own line", ns.steeringLineId !== ownLine.body.id,
      JSON.stringify({ line: ns.steeringLineId, v: ns.steeringVerdict }));
    const quiet = await saveFullRecord(fob.body.id, { incoterm: "CIF" });
    assert("no notice when the new principal has no one else's contract or space", quiet.status === 200 && !quiet.body?.principalNotice,
      JSON.stringify(quiet.body?.principalNotice));

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
    // The shipments, the quote and the customers stay as verification data. Steering lines and space change what other
    // shipments on the lane are offered: the shipment leaves the contract, then they go.
    for (const id of cleanup.shipments) await request("PUT", `/api/shipments/${id}`, { contractType: "Pending", contractId: "", contractRef: "", allocationId: "" }, token).catch(() => {});
    for (const id of cleanup.steerings) await request("DELETE", `/api/lane-steerings/${id}`, null, token).catch(() => {});
    for (const id of cleanup.allocations) await request("DELETE", `/api/allocations/${id}`, null, token).catch(() => {});
    for (const id of cleanup.contracts) await request("DELETE", `/api/contracts/${id}`, null, token).catch(() => {});
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
