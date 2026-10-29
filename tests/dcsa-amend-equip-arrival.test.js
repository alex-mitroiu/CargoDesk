/**
 * DCSA everywhere, the remaining phases (2026-10-28), end to end through the built-in DCSA carrier.
 *
 *  - Master B/L amendment (eBL 3.0.3 Direct Transport Document amendment): once the carrier has issued the
 *    Master B/L, a correction to the shipment goes to it as an amendment of the issued document. Nothing is
 *    sent when the shipment already says what the B/L says, and a draft is corrected with Send update instead.
 *    The carrier answers AMENDMENT_RECEIVED; CargoDesk can cancel it then; the carrier declines it (a task) or
 *    accepts it (the originals go back: a task until they're surrendered for amendment) and issues the amended
 *    B/L, whose changes are on record.
 *
 * Usage:
 *   node tests/dcsa-amend-equip-arrival.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001, not in production (the built-in DCSA carrier is always on there)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { createRequire } from "node:module";
import { ensureOffices, retireOffice, retireBranch } from "./helpers/offices.mjs";
import { bookThroughCarrier } from "./helpers/dcsa-sim.mjs";

const require = createRequire(import.meta.url);
const { validateOutbound, errorsText } = require("../lib/dcsa/validate.js");

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ method, hostname: "localhost", port: 3001, path, headers: {
      "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }),
      ...(payload && { "Content-Length": Buffer.byteLength(payload) }) } }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
const list = b => (Array.isArray(b) ? b : (b?.results ?? []));
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const cleanup = { shipments: [], customers: [], office: null, branch: null };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { imoOfficeId } = await ensureOffices(token);
    const branch = (await request("POST", "/api/branches", { code: `DAE${rand}`, name: `CargoDesk Logistics Rotterdam ${rand} BV`, countryCode: "NL",
      city: "Rotterdam", address: "Wilhelminakade 909", locode: "NLRTM", taxRegistrationNumber: "NL004495445B01", currency: "EUR",
      email: "export.rotterdam@cargodesk.example", phone: "+31 10 555 0142", scac: "CDLR" }, token)).body;
    cleanup.branch = branch.id;
    const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
    const office = (await request("POST", "/api/offices", { unlocode: `NL${letters}`, countryCode: "NL", department: "SE", name: `Rotterdam Export DCSA ${rand}`, branchId: branch.id }, token)).body;
    if (!office?.id) throw new Error(`scratch office not created: ${JSON.stringify(office)}`);
    cleanup.office = office.id;

    const customer = async (companyName, address1, postalCode, city, countryIso2, extra = {}) => {
      const c = (await request("POST", "/api/customers", { companyName, address1, postalCode, city, countryIso2, ...extra }, token)).body;
      cleanup.customers.push(c.id);
      return c;
    };
    const shipper = await customer(`Van Leeuwen Furniture ${rand} BV`, "Waalhaven Oostzijde 81", "3087 BM", "Rotterdam", "NL", { email: "logistics@vanleeuwen.example", phone: "+31 10 428 1100" });
    const consignee = await customer(`Hudson Home Imports ${rand} Inc`, "250 Port Jersey Blvd", "07305", "Jersey City", "US");
    await request("POST", `/api/customers/${consignee.id}/identifiers`, { idType: "LEI", idCode: `5493001KJTIIGC8Y1R${String(Date.now()).slice(-2)}`, countryIso2: "US" }, token);

    // A complete, booked NLRTM → USNYC shipment on MAEU: sealed 40' HCs, the vessel on its sea leg, milestones.
    const bookedShipment = async (tag, { containers = 2, voyage = `461W${rand}` } = {}) => {
      const s = (await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central",
        contractRef: "MAEU-SC-2026-0418", etd: inDays(5), eta: inDays(17), incoterm: "FOB", commodityCode: "9999", freightTerms: "Prepaid",
        masterBlReleaseType: "Original", shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId: office.id, imoOfficeId }, token)).body;
      if (!s?.id) throw new Error(`shipment ${tag} not created: ${JSON.stringify(s)}`);
      cleanup.shipments.push(s.id);
      await request("POST", `/api/shipments/${s.id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
        etd: inDays(5), eta: inDays(17), carrierCode: "MAEU", vessel: "MAERSK KENSINGTON", vesselImo: "9333022", voyage }, token);
      const ctrs = [];
      for (let i = 0; i < containers; i++) ctrs.push((await request("POST", "/api/containers", { shipmentId: s.id,
        containerNumber: `MSKU${String(Date.now()).slice(-6)}${i}`, sealNumber: `ML-${String(Date.now()).slice(-5)}${i}`, size: "40", type: "HC",
        hsCode: "940360", cargoDescription: "Wooden dining furniture, flat-packed", marksAndNumbers: `VLF ${tag} 1-120`,
        grossWeightKg: 11850 + i * 100, volumeCbm: 64, numberOfPackages: 120, packageCode: "CT" }, token)).body);
      await request("POST", `/api/shipments/${s.id}/milestones/init`, {}, token);
      const b = await bookThroughCarrier(request, token, s.id);
      if (b.booking?.status !== "Confirmed") throw new Error(`shipment ${tag} not booked: ${JSON.stringify(b.booking).slice(0, 200)}`);
      return { id: s.id, containers: ctrs, bookingRef: b.booking.bookingRef };
    };
    const si = async id => (await request("GET", `/api/shipments/${id}/shipping-instructions`, null, token)).body;
    const waitFor = async (fn, pred, ms = 5000) => { const until = Date.now() + ms; let v; while (Date.now() < until) { v = await fn(); if (pred(v)) return v; await sleep(150); } return v; };
    const submitSi = async id => {
      await request("PUT", `/api/shipments/${id}/shipping-instructions`, { siCutoff: `${inDays(2)}T12:00`, specialInstructions: "Shipper's load, stow and count" }, token);
      const r = await request("POST", `/api/shipments/${id}/shipping-instructions/submit`, {}, token);
      if (r.status !== 201) console.error(`  (submit ${id}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)})`);
      await waitFor(() => si(id), s => s?.carrierState === "RECEIVED");
      return r.body?.shippingInstructions?.siReference;
    };
    const carrierSi = (ref, action, message) => request("POST", `/api/test-tools/dcsa-sim/shipping-instructions/${ref}/${action}`, message ? { message } : {}, token);
    const masterBl = async id => (await request("GET", `/api/shipments/${id}/master-bl`, null, token)).body;
    const tasks = async (id, sourceType) => list((await request("GET", `/api/tickets?shipmentId=${id}`, null, token)).body).filter(t => t.sourceType === sourceType);
    const history = async id => list((await request("GET", `/api/shipments/${id}/events?limit=200`, null, token)).body);

    // ─── The Master B/L amendment ────────────────────────────────────────────
    console.log("\nAmending the issued Master B/L");
    const A = await bookedShipment("A");
    const refA = await submitSi(A.id);
    await carrierSi(refA, "draft");
    // A draft is corrected with Send update, not an amendment.
    const early = await request("POST", `/api/shipments/${A.id}/master-bl/amend`, {}, token);
    assert("a draft can't be amended: Send update corrects it (409)", early.status === 409 && /Send update/.test(early.body?.error), JSON.stringify(early.body));
    await request("POST", `/api/shipments/${A.id}/master-bl/approve`, {}, token);
    await carrierSi(refA, "issue");
    let m = await waitFor(() => masterBl(A.id), x => x?.status === "ISSUED");
    const ref = m?.reference;
    assert("(setup) the carrier issued the Master B/L", m?.status === "ISSUED" && !!ref, JSON.stringify(m).slice(0, 200));

    let preview = await request("GET", `/api/shipments/${A.id}/master-bl/amendment-preview`, null, token);
    assert("nothing differs yet: the preview lists no changes", preview.status === 200 && preview.body.changes.length === 0 && !preview.body.missing.length, JSON.stringify(preview.body));
    const nothing = await request("POST", `/api/shipments/${A.id}/master-bl/amend`, {}, token);
    assert("…and an amendment isn't sent (409, nothing to amend)", nothing.status === 409 && /Nothing to amend/.test(nothing.body?.error), JSON.stringify(nothing.body));

    // A customs inspection replaced the second container's seal.
    const c2 = A.containers[1];
    const newSeal = `CBP-${String(Date.now()).slice(-7)}`;
    const upd = await request("PUT", `/api/shipments/${A.id}/containers/${c2.id}`, { ...c2, sealNumber: newSeal }, token);
    assert("(setup) the shipment's seal changed", upd.status === 200 && upd.body?.sealNumber === newSeal, JSON.stringify(upd.body).slice(0, 200));
    preview = await request("GET", `/api/shipments/${A.id}/master-bl/amendment-preview`, null, token);
    const sealRow = preview.body?.changes?.find(r => r.key === `seal:${c2.containerNumber}`);
    assert("the preview shows the one change: the seal, issued value against the shipment's", preview.body?.changes?.length === 1
      && sealRow?.carrier === c2.sealNumber && sealRow?.sent === newSeal, JSON.stringify(preview.body));

    let r = await request("POST", `/api/shipments/${A.id}/master-bl/amend`, {}, token);
    assert("Request amendment sends it; the carrier has it (AMENDMENT_RECEIVED)", r.status === 201 && r.body?.amendment?.status === "AMENDMENT_RECEIVED"
      && r.body.amendment.changes.length === 1 && !!r.body.amendmentRequestedBy && r.body.status === "ISSUED", JSON.stringify(r.body?.amendment));
    const out = list((await request("GET", `/api/shipments/${A.id}/edi-messages`, null, token)).body).find(x => x.messageType === "transport_document_amendment");
    const sentDoc = out ? (typeof out.rawPayload === "string" ? JSON.parse(out.rawPayload) : out.rawPayload) : null;
    const v = sentDoc ? validateOutbound("ebl", "put", "/v3/transport-documents/{transportDocumentReference}/amendment", sentDoc) : { ok: false, errors: [] };
    assert("the amended document went out (message log) and is a valid DCSA TransportDocument", !!out && v.ok, v.ok ? "" : errorsText(v.errors, 4));
    assert("…the issued B/L with the new seal, everything the carrier decides as issued",
      sentDoc?.transportDocumentReference === ref && sentDoc.utilizedTransportEquipments.find(u => u.equipment.equipmentReference === c2.containerNumber)?.seals?.[0]?.number === newSeal
      && sentDoc.termsAndConditions === m.document.termsAndConditions && sentDoc.issueDate === m.document.issueDate, JSON.stringify(sentDoc?.utilizedTransportEquipments));

    const cancelled = await request("POST", `/api/shipments/${A.id}/master-bl/amendment/cancel`, {}, token);
    assert("an amendment the carrier hasn't worked on can be cancelled (AMENDMENT_CANCELLED, nothing pending)",
      cancelled.status === 200 && cancelled.body?.amendedStatus === "AMENDMENT_CANCELLED" && cancelled.body.amendment === null, JSON.stringify(cancelled.body).slice(0, 300));
    assert("…and cancelling again is refused (409)", (await request("POST", `/api/shipments/${A.id}/master-bl/amendment/cancel`, {}, token)).status === 409);

    r = await request("POST", `/api/shipments/${A.id}/master-bl/amend`, {}, token);
    const declined = await carrierSi(refA, "declineAmendment", "Seal changes after loading are made on the delivery order, not the B/L");
    m = await waitFor(() => masterBl(A.id), x => x?.amendedStatus === "AMENDMENT_DECLINED");
    assert("the carrier declines it: the B/L stands, the carrier's reason is shown", declined.status === 200 && m?.amendment?.status === "AMENDMENT_DECLINED"
      && m.status === "ISSUED" && /delivery order/.test(m.carrierFeedback), JSON.stringify({ st: m?.status, a: m?.amendment?.status, f: m?.carrierFeedback }));
    let t = await tasks(A.id, "master_bl_amendment_declined");
    assert("…and a task tells the export side", t.length === 1 && t[0].status === "Ready" && t[0].title.includes(ref), JSON.stringify(t));

    r = await request("POST", `/api/shipments/${A.id}/master-bl/amend`, {}, token);
    assert("a new amendment can be requested after a decline", r.status === 201 && r.body?.amendment?.status === "AMENDMENT_RECEIVED", JSON.stringify(r.body?.amendment));
    t = await tasks(A.id, "master_bl_amendment_declined");
    assert("…which closes the decline task", t.length === 1 && t[0].status === "Done", JSON.stringify(t.map(x => x.status)));
    await carrierSi(refA, "confirmAmendment");
    m = await waitFor(() => masterBl(A.id), x => x?.status === "PENDING_SURRENDER_FOR_AMENDMENT");
    assert("the carrier accepts it: the originals are due back (pending surrender for amendment)", m?.status === "PENDING_SURRENDER_FOR_AMENDMENT"
      && m.amendment?.status === "AMENDMENT_CONFIRMED", JSON.stringify({ st: m?.status, a: m?.amendment?.status }));
    t = await tasks(A.id, "master_bl_amendment_originals");
    assert("…a task to return the original B/Ls", t.length === 1 && t[0].status === "Ready" && /original B\/Ls/.test(t[0].description), JSON.stringify(t));
    assert("…and an accepted amendment can't be cancelled (409)", (await request("POST", `/api/shipments/${A.id}/master-bl/amendment/cancel`, {}, token)).status === 409);
    await carrierSi(refA, "surrenderForAmendment");
    m = await waitFor(() => masterBl(A.id), x => x?.status === "SURRENDERED_FOR_AMENDMENT");
    t = await tasks(A.id, "master_bl_amendment_originals");
    assert("the originals are surrendered for amendment: the task closes", m?.status === "SURRENDERED_FOR_AMENDMENT" && t[0]?.status === "Done", JSON.stringify({ st: m?.status, t: t.map(x => x.status) }));
    await carrierSi(refA, "issue");
    m = await waitFor(() => masterBl(A.id), x => x?.status === "ISSUED");
    const amended = m?.events?.find(e => e.eventType === "MASTER_AMENDED");
    assert("the carrier issues the amended B/L: same number, the new seal on it, nothing pending", m?.status === "ISSUED" && m.reference === ref && m.amendment === null
      && m.document.utilizedTransportEquipments.find(u => u.equipment.equipmentReference === c2.containerNumber)?.seals?.[0]?.number === newSeal,
      JSON.stringify({ st: m?.status, a: m?.amendment }));
    assert("…its changes are on the record (was → now)", amended?.detail?.changes?.length === 1 && amended.detail.changes[0].was === c2.sealNumber
      && amended.detail.changes[0].now === newSeal, JSON.stringify(amended));
    const ship = (await request("GET", `/api/shipments/${A.id}`, null, token)).body;
    const h = await history(A.id);
    assert("the shipment keeps its Master B/L number; History has the request, the decline and the amended B/L",
      ship.masterBlNumber === ref && ["MASTER_BL_AMENDMENT_REQUESTED", "MASTER_BL_AMENDMENT_DECLINED", "MASTER_BL_AMENDED"].every(k => h.some(e => e.eventType === k)),
      JSON.stringify(h.map(e => e.eventType).filter(x => /MASTER/.test(x))));
    assert("and with the shipment matching the amended B/L, there's nothing left to amend", (await request("POST", `/api/shipments/${A.id}/master-bl/amend`, {}, token)).status === 409);

    // ─── Equipment: ISO 6346 codes, 45' units, seals ─────────────────────────
    console.log("\nEquipment and seals (DCSA phase 3)");
    const types = list((await request("GET", "/api/container-type-definitions", null, token)).body);
    const typeIso = code => types.find(t => t.code === code)?.isoCode;
    assert("every container type has its ISO code, 45' High Cube included (L5G1, 2 TEU)", typeIso("40HC") === "45G1" && typeIso("20DC") === "22G1"
      && typeIso("40TK") === "42T1" && types.find(t => t.code === "45HC")?.isoCode === "L5G1" && types.find(t => t.code === "45HC")?.teu === 2,
      JSON.stringify(types.map(t => `${t.code}:${t.isoCode}`)));
    const E = (await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central",
      contractRef: "MAEU-SC-2026-0418", etd: inDays(6), eta: inDays(18), incoterm: "FOB", commodityCode: "9999", freightTerms: "Prepaid",
      masterBlReleaseType: "Original", shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      principalId: shipper.id, principalName: shipper.companyName, emoOfficeId: office.id, imoOfficeId }, token)).body;
    cleanup.shipments.push(E.id);
    await request("POST", `/api/shipments/${E.id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
      etd: inDays(6), eta: inDays(18), carrierCode: "MAEU", vessel: "MAERSK KENSINGTON", vesselImo: "9333022", voyage: `462W${rand}` }, token);
    const cargo = { hsCode: "940360", cargoDescription: "Upholstered sofas, flat-packed", grossWeightKg: 9800, volumeCbm: 80, numberOfPackages: 64, packageCode: "CT" };
    const ctr = (n, extra) => request("POST", "/api/containers", { shipmentId: E.id, containerNumber: `MSKU${String(Date.now()).slice(-6)}${n}`, ...cargo, ...extra }, token);
    const c45 = await ctr(1, { isoEquipmentCode: "L5G1", seals: [{ number: "ML-5510021", source: "CAR" }, { number: "CBP-0091877", source: "CUS" }] });
    assert("a container given only its ISO code: 45' High Cube (size 45, type HC), both seals with who applied them",
      c45.status === 201 && c45.body.size === "45" && c45.body.type === "HC" && c45.body.isoEquipmentCode === "L5G1"
      && c45.body.seals.length === 2 && c45.body.seals[1].source === "CUS" && c45.body.sealNumber === "ML-5510021", JSON.stringify(c45.body).slice(0, 300));
    const c40 = await ctr(2, { size: "40", type: "HC", sealNumber: "ML-5510022" });
    assert("one given size and type takes the registry's ISO code (40HC → 45G1); its single seal is the first seal",
      c40.status === 201 && c40.body.isoEquipmentCode === "45G1" && c40.body.seals.length === 1 && c40.body.seals[0].number === "ML-5510022", JSON.stringify(c40.body).slice(0, 300));
    const cRh = await ctr(3, { size: "40", type: "RF", isoEquipmentCode: "45R1", setTemperatureC: -18, sealNumber: "ML-5510023" });
    assert("a 40' high-cube reefer keeps its own code (45R1), not the plain 40' reefer's", cRh.status === 201 && cRh.body.isoEquipmentCode === "45R1", JSON.stringify(cRh.body).slice(0, 200));
    const badLen = await ctr(4, { size: "40", type: "HC", isoEquipmentCode: "L5G1" });
    const badIso = await ctr(5, { isoEquipmentCode: "40HCX" });
    const badSrc = await ctr(6, { size: "20", type: "DC", seals: [{ number: "S1", source: "PHY" }] });
    const badLong = await ctr(7, { size: "20", type: "DC", seals: [{ number: "SEAL-1234567890123" }] });
    assert("refused: an ISO code of another length (400), not an ISO code (400), a source DCSA doesn't have (400), a seal over 15 characters (400)",
      badLen.status === 400 && badIso.status === 400 && badSrc.status === 400 && /CAR \(Carrier\)/.test(badSrc.body?.error) && badLong.status === 400,
      JSON.stringify([badLen.body, badIso.body, badSrc.body, badLong.body]));
    // An older client saving only sealNumber replaces the first seal and keeps the others.
    const upd45 = await request("PUT", `/api/shipments/${E.id}/containers/${c45.body.id}`, { ...c45.body, seals: undefined, sealNumber: "ML-5510099" }, token);
    assert("a save sending only sealNumber replaces the first seal and keeps the customs seal", upd45.status === 200
      && upd45.body.seals.map(s => s.number).join(",") === "ML-5510099,CBP-0091877" && upd45.body.seals[1].source === "CUS", JSON.stringify(upd45.body.seals));
    const ev = (await history(E.id)).filter(e => e.eventType === "CONTAINER_UPDATED" && e.field === "seals");
    assert("…and History records the seals as they were and are", ev.length === 1 && /ML-5510021 \(CAR\)/.test(ev[0].oldValue) && /ML-5510099/.test(ev[0].newValue), JSON.stringify(ev));
    await request("POST", `/api/shipments/${E.id}/milestones/init`, {}, token);
    const bE = await bookThroughCarrier(request, token, E.id);
    const sentBooking = list((await request("GET", `/api/shipments/${E.id}/edi-messages`, null, token)).body)
      .map(x => (typeof x.rawPayload === "string" ? (() => { try { return JSON.parse(x.rawPayload); } catch { return null; } })() : x.rawPayload))
      .find(p => p?.requestedEquipments);
    const isoLines = (sentBooking?.requestedEquipments || []).map(q => `${q.ISOEquipmentCode}x${q.units}`).sort().join(",");
    assert("the booking asks for one line per ISO code: 45G1, 45R1 and L5G1", bE.booking?.status === "Confirmed" && isoLines === "45G1x1,45R1x1,L5G1x1", isoLines);
    const rfLine = (sentBooking?.requestedEquipments || []).find(q => q.ISOEquipmentCode === "45R1");
    assert("…the reefer's set point on its own line (−18 °C)", rfLine?.activeReeferSettings?.temperatureSetpoint === -18, JSON.stringify(rfLine));
    const refE = await submitSi(E.id);
    const sentSi = list((await request("GET", `/api/shipments/${E.id}/edi-messages`, null, token)).body).find(x => x.messageType === "shipping_instructions_submission");
    const siBody = sentSi ? JSON.parse(sentSi.rawPayload) : null;
    const ute = siBody?.utilizedTransportEquipments?.find(u => u.equipmentReference === c45.body.containerNumber);
    const rfUte = siBody?.utilizedTransportEquipments?.find(u => u.equipmentReference === cRh.body.containerNumber);
    assert("the Shipping Instructions carry no reefer settings (the spec keeps them on the booking), so a reefer can be submitted",
      !!refE && rfUte && !("activeReeferSettings" in rfUte), JSON.stringify(rfUte));
    assert("the Shipping Instructions name every seal with its source", !!refE && ute?.seals?.length === 2 && ute.seals[1].source === "CUS" && ute.seals[0].number === "ML-5510099",
      JSON.stringify(ute || (await si(E.id))));
    const vgm = await request("PUT", `/api/shipments/${E.id}/containers/${c45.body.id}`, { ...upd45.body, vgmWeightKg: 13600, vgmMethod: "SM1", vgmStatus: "Submitted" }, token);
    const vgmMsg = list((await request("GET", `/api/shipments/${E.id}/edi-messages`, null, token)).body).find(x => x.messageType === "vgm_declaration");
    const vgmBody = vgmMsg ? JSON.parse(vgmMsg.rawPayload) : null;
    const vd = (vgmBody?.VGMDeclarations || vgmBody?.declarations || [vgmBody])[0];
    assert("the VGM declaration names the 45' unit (L5G1) and both seals", vgm.status === 200 && vd?.equipmentDetails?.ISOEquipmentCode === "L5G1"
      && vd.equipmentDetails.seals?.length === 2, JSON.stringify(vd?.equipmentDetails || vgmBody).slice(0, 300));

    // ─── Arrival Notice 1.0 ──────────────────────────────────────────────────
    console.log("\nThe carrier's Arrival Notice (DCSA Arrival Notice 1.0)");
    const voyageN = `463W${rand}`;
    const N = await bookedShipment("N", { voyage: voyageN });
    const refN = await submitSi(N.id);
    await carrierSi(refN, "draft");
    await request("POST", `/api/shipments/${N.id}/master-bl/approve`, {}, token);
    await carrierSi(refN, "issue");
    const mN = await waitFor(() => masterBl(N.id), x => x?.status === "ISSUED");
    // The second container already has its own detention days; a THC accrual is already on the shipment.
    const [n1, n2] = N.containers;
    await request("PUT", `/api/shipments/${N.id}/containers/${n2.id}`, { ...n2, seals: undefined, destDetentionFreeDays: 10 }, token);
    await request("POST", `/api/shipments/${N.id}/cost-lines`, { type: "BUY", chargeCode: "Destination THC", currency: "USD", amount: 990, notes: "THC destination" }, token);
    assert("before the carrier publishes, there's no Arrival Notice", (await request("GET", `/api/shipments/${N.id}/arrival-notice`, null, token)).body === null);
    const etaN = inDays(16);
    const pub = await request("POST", "/api/test-tools/dcsa-sim/arrival-notices", { shipmentId: N.id, eta: etaN, freeDays: 4, detentionDays: 7 }, token);
    let an = pub.body?.arrivalNotice;
    assert("the carrier publishes its Arrival Notice for the Master B/L; it lands on the shipment (version 1)", pub.status === 201 && an?.version === "1"
      && an.transportDocumentReference === mN.reference && an.isMock === true, JSON.stringify(pub.body).slice(0, 300));
    const legN = (await (async () => list((await request("GET", `/api/shipments/${N.id}/legs`, null, token)).body).find(l => (l.legType || l.mot) === "SEA"))());
    assert("its arrival date moves the sea leg's ETA (the carrier's estimate)", String(legN?.eta).startsWith(etaN) && legN.etaSource === "dcsa"
      && an.facts.arrival?.date === etaN && an.etaChange?.to === etaN, JSON.stringify({ eta: legN?.eta, src: legN?.etaSource, ch: an.etaChange }));
    const ft = (cid, kind) => an.freeTime.find(f => f.containerId === cid && f.kind === kind);
    assert("free time fills a container's empty days (demurrage 4, detention 7)", ft(n1.id, "DEM")?.state === "filled" && ft(n1.id, "DET")?.state === "filled"
      && ft(n2.id, "DEM")?.state === "filled" && ft(n2.id, "DEM").days === 4, JSON.stringify(an.freeTime));
    assert("…and a container that says otherwise is shown, not overwritten (10 days against the carrier's 7)", ft(n2.id, "DET")?.state === "differs"
      && ft(n2.id, "DET").onContainer === 10 && ft(n2.id, "DET").days === 7, JSON.stringify(ft(n2.id, "DET")));
    const ctrN2 = list((await request("GET", `/api/containers?shipmentId=${N.id}`, null, token)).body).find(c => c.id === n2.id);
    assert("(the container still has its 10 days, and the 4 demurrage days filled)", ctrN2?.destDetentionFreeDays === 10 && ctrN2.destFreeTimeDays === 4, JSON.stringify(ctrN2).slice(0, 200));
    assert("the charges are shown; the THC that looks already entered is flagged", an.charges.length === 3 && /already in Cost Entry/.test(an.charges[0].looksEntered || "")
      && an.charges[0].chargeCode === "Destination THC" && !an.charges[1].looksEntered && an.charges.every(c => !c.addedCostLineId), JSON.stringify(an.charges));
    const acc = await request("POST", `/api/shipments/${N.id}/arrival-notice/accruals`, { indices: [1, 2] }, token);
    const lines = list((await request("GET", `/api/shipments/${N.id}/cost-lines`, null, token)).body).filter(l => l.source === "arrival_notice");
    assert("Add as accruals makes the chosen charges BUY lines from the carrier (collect)", acc.status === 201 && acc.body.created.length === 2 && lines.length === 2
      && lines.every(l => l.type === "BUY" && l.paymentIndicator === "Collect") && lines.some(l => l.chargeCode === "Documentation Fee" && l.amount === 85),
      JSON.stringify(lines.map(l => [l.chargeCode, l.amount, l.paymentIndicator])));
    const again = await request("POST", `/api/shipments/${N.id}/arrival-notice/accruals`, { indices: [1, 2] }, token);
    assert("…each once (asking again adds nothing)", again.status === 201 && again.body.created.length === 0, JSON.stringify(again.body?.created));
    const settled = await request("POST", `/api/shipments/${N.id}/arrival-notice/free-time`, { containerId: n2.id, kind: "DET", use: true }, token);
    assert("a free-time difference settled with the carrier's days: the container takes 7", settled.status === 200
      && settled.body.freeTime.find(f => f.containerId === n2.id && f.kind === "DET")?.state === "filled", JSON.stringify(settled.body?.freeTime));
    // Version 2, announced by a lightweight notification: CargoDesk reads it from the carrier.
    const eta2 = inDays(15);
    const pub2 = await request("POST", "/api/test-tools/dcsa-sim/arrival-notices", { shipmentId: N.id, eta: eta2, lightweight: true }, token);
    an = pub2.body?.arrivalNotice;
    assert("a new version announced by a lightweight notification is fetched and becomes current; both versions are kept",
      pub2.status === 201 && an?.version === "2" && an.versions.length === 2 && an.versions.filter(v => v.isCurrent).length === 1 && an.facts.arrival?.date === eta2,
      JSON.stringify({ s: pub2.status, v: an?.version, vs: an?.versions }));
    assert("…version 2's charges already accrued are flagged as entered", an.charges[1].looksEntered && an.charges[2].looksEntered, JSON.stringify(an.charges.map(c => c.looksEntered)));
    const refreshed = await request("POST", `/api/shipments/${N.id}/arrival-notice/refresh`, {}, token);
    assert("Ask the carrier again finds nothing new (still version 2)", refreshed.status === 200 && refreshed.body.version === "2" && refreshed.body.versions.length === 2,
      JSON.stringify(refreshed.body).slice(0, 200));
    const hN = await history(N.id);
    assert("History has each notice and the accruals", hN.filter(e => e.eventType === "ARRIVAL_NOTICE_RECEIVED").length === 2 && hN.some(e => e.eventType === "ARRIVAL_NOTICE_ACCRUED"),
      JSON.stringify(hN.map(e => e.eventType).filter(x => /ARRIVAL/.test(x))));

    // ─── Port Call 2.0 ───────────────────────────────────────────────────────
    console.log("\nPort Call timestamps (DCSA Port Call 2.0)");
    const pc = (kind, classifier, unLocationCode, dateTime, extra = {}) => request("POST", "/api/test-tools/dcsa-sim/port-calls",
      { vesselImo: "9333022", vesselName: "MAERSK KENSINGTON", voyage: voyageN, unLocationCode, kind, classifier, dateTime, ...extra }, token);
    const seaN = async () => list((await request("GET", `/api/shipments/${N.id}/legs`, null, token)).body).find(l => (l.legType || l.mot) === "SEA");
    const dep = await pc("DEPA", "ACTUAL", "NLRTM", `${inDays(5)}T21:30:00Z`);
    let leg = await seaN();
    assert("the vessel's actual berth departure confirms the leg's ETD", dep.status === 201 && String(leg.etd).startsWith(inDays(5)) && leg.etdSource === "dcsa_actual",
      JSON.stringify({ b: dep.body, etd: leg?.etd, src: leg?.etdSource }));
    await pc("ARRI", "ESTIMATED", "USNYC", `${inDays(14)}T06:00:00Z`);
    leg = await seaN();
    assert("an estimated berth arrival moves the ETA", String(leg.eta).startsWith(inDays(14)) && leg.etaSource === "dcsa", JSON.stringify({ eta: leg?.eta, src: leg?.etaSource }));
    await pc("ARRI", "ACTUAL", "USNYC", `${inDays(14)}T09:15:00Z`);
    await request("POST", "/api/test-tools/dcsa-sim/arrival-notices", { shipmentId: N.id, eta: inDays(18) }, token);
    leg = await seaN();
    assert("the actual arrival is confirmed, and a later Arrival Notice estimate doesn't undo it", String(leg.eta).startsWith(inDays(14)) && leg.etaSource === "dcsa_actual",
      JSON.stringify({ eta: leg?.eta, src: leg?.etaSource }));
    const stray = await pc("ARRI", "ESTIMATED", "USNYC", `${inDays(14)}T06:00:00Z`, { voyage: "999X" });
    assert("a call for a voyage no shipment has is acknowledged with a warning", stray.status === 201 && /No shipment has vessel 9333022 voyage 999X/.test(stray.body?.feedback?.[0]?.message || ""),
      JSON.stringify(stray.body));

    // ─── Release audit R3, R4 (2026-10-29) ───────────────────────────────────
    console.log("\nOnly the carrier's shipments, only open ones (release audit R3, R4)");
    // R3: a shipment booked elsewhere that names the same Master B/L gets nothing from the demo carrier's notice.
    const X = (await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central",
      contractRef: "MAEU-SC-2026-0418", etd: inDays(5), eta: inDays(17), incoterm: "FOB", commodityCode: "9999", freightTerms: "Prepaid",
      masterBlNumber: mN.reference, shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      principalId: shipper.id, principalName: shipper.companyName, emoOfficeId: office.id, imoOfficeId }, token)).body;
    if (X?.id) cleanup.shipments.push(X.id);
    const pub3 = await request("POST", "/api/test-tools/dcsa-sim/arrival-notices", { shipmentId: N.id, eta: inDays(19) }, token);
    const versionsN = pub3.body?.arrivalNotice?.versions?.length || 0;
    assert("R3: the demo carrier's notice reaches its own booking only; a shipment booked elsewhere naming the same Master B/L gets nothing",
      !!X?.id && pub3.status === 201 && versionsN >= 4 && (await request("GET", `/api/shipments/${X.id}/arrival-notice`, null, token)).body === null,
      JSON.stringify({ x: X?.id, s: pub3.status, v: versionsN }));
    // R4: a Completed shipment is locked: the next notice and a berth call leave it alone, and the carrier is told.
    const done = await request("PUT", `/api/shipments/${N.id}`, { status: "Completed" }, token);
    const pub4 = await request("POST", "/api/test-tools/dcsa-sim/arrival-notices", { shipmentId: N.id, eta: inDays(21) }, token);
    const anDone = (await request("GET", `/api/shipments/${N.id}/arrival-notice`, null, token)).body;
    assert("R4: a Completed shipment takes no new Arrival Notice, and the carrier is told why", done.status === 200 && pub4.status === 201
      && anDone?.versions?.length === versionsN && /is Completed: not changed/.test(JSON.stringify(pub4.body?.feedback || [])),
      JSON.stringify({ done: done.status, s: pub4.status, v: anDone?.versions?.length, f: pub4.body?.feedback }));
    const pcDone = await pc("ARRI", "ACTUAL", "USNYC", `${inDays(15)}T08:00:00Z`);
    leg = await seaN();
    assert("R4: nor does a berth arrival move its leg (still the arrival of day 14)", pcDone.status === 201 && String(leg.eta).startsWith(inDays(14)),
      JSON.stringify({ s: pcDone.status, eta: leg?.eta, f: pcDone.body?.feedback }));
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    console.log("\nCleanup");
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token);
    if (cleanup.office) console.log(`  office: ${await retireOffice(token, cleanup.office)}`);
    if (cleanup.branch) console.log(`  branch: ${await retireBranch(token, cleanup.branch)}`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
