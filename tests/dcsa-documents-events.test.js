/**
 * DCSA everywhere, phases 4–6 (2026-10-28), end to end through the built-in DCSA carrier.
 *
 *  - Master B/L (eBL 3.0 transport document): the carrier drafts it from the Shipping Instructions (the
 *    instructions show Confirmed), CargoDesk reads it, compares it with what it sent and opens a review
 *    task; approving sends PATCH APPROVED and closes the task; the carrier issues it (the shipment takes the
 *    Master B/L number, B/L Issued completes); updates and cancellation are refused from then on; the
 *    surrender for delivery makes the instructions COMPLETED (the spec's last state);
 *  - Shipping Instructions: an update the carrier hasn't worked in can be cancelled (the instructions stand),
 *    the instructions themselves can be cancelled, and reset starts new ones under a new reference;
 *  - House B/Ls in the Master's instructions (G25): an issued House B/L goes as houseBillOfLadings;
 *  - VGM declarations: each one sent is on record (declaration, re-declaration, retraction);
 *  - Track & Trace 3.0, pushed by the carrier: kept with their classification and what CargoDesk did with
 *    them; gate-ins complete Cargo Gated In once every container has one; an estimated departure moves the
 *    leg's ETD (carrier estimate), the actual one confirms it, sails every container and completes Vessel
 *    Departed, and a later estimate doesn't undo it; an actual arrival completes Vessel Arrived; customs
 *    release completes Customs Cleared; a retraction removes the container event made from it; pulling the
 *    same events (Sync carrier events) duplicates nothing;
 *  - Operational Vessel Schedules 3.0: the carrier's planned/estimated/actual times move the legs ("Check
 *    vessel times"); an actual departure completes Vessel Departed;
 *  - milestone templates carry the DCSA events that complete them, checked against the code lists, and a
 *    template's own DCSA events complete its milestone;
 *  - review fixes (2026-10-28): the carrier's transport-document notifications carry only the document's
 *    reference (as the spec's examples) and the notification spelling VOID; a corrected event corrects the
 *    container event, an older copy is ignored, a retraction carrying only its eventID is routed and undoes
 *    the leg time (back to the carrier's estimate); a vessel event naming only vessel and voyage reaches every
 *    shipment on that voyage and no other; the demo carrier declines instructions for a booking it doesn't
 *    hold; AIS never overwrites a carrier-confirmed time; the poll sweeps run; Test Tools refuses nonsense.
 *
 * Usage:
 *   node tests/dcsa-documents-events.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001, not in production (the built-in DCSA carrier is always on there)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { createRequire } from "node:module";
import { ensureOffices, retireOffice, retireBranch } from "./helpers/offices.mjs";
import { bookThroughCarrier } from "./helpers/dcsa-sim.mjs";
import { readyHouseBlShipment, generateHouseBl } from "./helpers/house-bl.mjs";

const require = createRequire(import.meta.url);
const { validateOutbound, validateOutboundSchema, errorsText } = require("../lib/dcsa/validate.js");

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
const parse = v => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const cleanup = { shipments: [], customers: [], templates: [], office: null, branch: null };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { imoOfficeId } = await ensureOffices(token);
    const branch = (await request("POST", "/api/branches", { code: `DDE${rand}`, name: `CargoDesk Logistics Rotterdam ${rand} BV`, countryCode: "NL",
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

    // A complete, booked NLRTM → USNYC shipment on MAEU: two sealed 40' HCs, the vessel on its sea leg, milestones.
    const bookedShipment = async (tag, { containers = 2, voyage = `444W${rand}` } = {}) => {
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
    const plainShipment = async (tag, { voyage = `451W${rand}`, imo = "9333022", vessel = "MAERSK KENSINGTON" } = {}) => {
      const s = (await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central",
        contractRef: "MAEU-SC-2026-0418", etd: inDays(5), eta: inDays(17), incoterm: "FOB", commodityCode: "9999", freightTerms: "Prepaid",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId: office.id, imoOfficeId }, token)).body;
      cleanup.shipments.push(s.id);
      await request("POST", `/api/shipments/${s.id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
        etd: inDays(5), eta: inDays(17), carrierCode: "MAEU", vessel, vesselImo: imo, voyage }, token);
      const c = (await request("POST", "/api/containers", { shipmentId: s.id, containerNumber: `MSKU${String(Date.now()).slice(-6)}9`,
        sealNumber: `ML-${String(Date.now()).slice(-5)}9`, size: "40", type: "HC", hsCode: "940360", cargoDescription: "Wooden dining furniture, flat-packed",
        marksAndNumbers: `VLF ${tag}`, grossWeightKg: 11850, volumeCbm: 64, numberOfPackages: 120, packageCode: "CT" }, token)).body;
      return { id: s.id, container: c };
    };
    const si = async id => (await request("GET", `/api/shipments/${id}/shipping-instructions`, null, token)).body;
    const waitFor = async (fn, pred, ms = 5000) => { const until = Date.now() + ms; let v; while (Date.now() < until) { v = await fn(); if (pred(v)) return v; await sleep(150); } return v; };
    const submitSi = async id => {
      await request("PUT", `/api/shipments/${id}/shipping-instructions`, { siCutoff: `${inDays(2)}T12:00`, specialInstructions: "Shipper's load, stow and count" }, token);
      const r = await request("POST", `/api/shipments/${id}/shipping-instructions/submit`, {}, token);
      await waitFor(() => si(id), s => s?.carrierState === "RECEIVED");
      return r;
    };
    const carrierSi = (ref, action, message) => request("POST", `/api/test-tools/dcsa-sim/shipping-instructions/${ref}/${action}`, message ? { message } : {}, token);
    const masterBl = async id => (await request("GET", `/api/shipments/${id}/master-bl`, null, token)).body;
    const milestones = async id => list((await request("GET", `/api/shipments/${id}/milestones`, null, token)).body);
    const done = async (id, key) => !!(await milestones(id)).find(m => m.milestoneKey === key)?.completedAt;
    const legs = async id => list((await request("GET", `/api/shipments/${id}/legs`, null, token)).body);
    const seaLeg = async id => (await legs(id)).find(l => (l.legType || l.mot) === "SEA");
    const ctrEvents = async (id, cid) => list((await request("GET", `/api/shipments/${id}/containers/${cid}/events`, null, token)).body);
    const carrierEvents = async id => list((await request("GET", `/api/shipments/${id}/carrier-events`, null, token)).body);
    const tasks = async id => list((await request("GET", `/api/tickets?shipmentId=${id}`, null, token)).body).filter(t => t.sourceType === "master_bl_draft");
    const report = (id, kind, extra = {}) => request("POST", "/api/test-tools/dcsa-sim/events", { shipmentId: id, kind, ...extra }, token);

    // ─── Phase 4: the Master B/L ─────────────────────────────────────────────
    console.log("\nMaster B/L (transport document 3.0)");
    const A = await bookedShipment("A");
    const subA = await submitSi(A.id);
    const siRef = subA.body?.shippingInstructions?.siReference;
    assert("(setup) Shipping Instructions submitted", subA.status === 201 && !!siRef, JSON.stringify(subA.body).slice(0, 200));
    assert("before the carrier drafts, nothing to review", (await masterBl(A.id)) === null, "");
    const drafted = await carrierSi(siRef, "draft");
    assert("the carrier drafts its Master B/L from them", drafted.status === 200 && drafted.body?.masterBl?.status === "DRAFT", JSON.stringify(drafted.body).slice(0, 300));
    let m = await masterBl(A.id);
    assert("CargoDesk read the draft: reference, status, the carrier's document", m?.status === "DRAFT" && !!m.reference && m.document?.transportDocumentStatus === "DRAFT"
      && m.shippingInstructionsReference === siRef && m.isMock === true, JSON.stringify(m).slice(0, 300));
    const tdCheck = m?.document ? validateOutboundSchema("ebl", "TransportDocument", m.document) : { ok: false, errors: [] };
    assert("…a valid DCSA TransportDocument", tdCheck.ok, tdCheck.ok ? "" : errorsText(tdCheck.errors, 4));
    assert("the instructions now show Confirmed (the carrier accepted them by drafting)", (await si(A.id))?.status === "Confirmed", JSON.stringify(await si(A.id)));
    const row = key => m.comparison.find(r => r.key === key);
    assert("the review compares what was sent with the draft: shipper, consignee, each container and seal, ports",
      row("shipper")?.sent === shipper.companyName && row("shipper")?.changed === false && row("consignee")?.changed === false
      && A.containers.every(c => row(`container:${c.containerNumber}`)?.changed === false && row(`seal:${c.containerNumber}`)?.changed === false)
      && row("portOfLoading")?.carrier === "NLRTM" && row("portOfDischarge")?.carrier === "USNYC", JSON.stringify(m.comparison).slice(0, 500));
    let t = await tasks(A.id);
    assert("a review task is opened for the export side", t.length === 1 && t[0].status === "Ready" && t[0].title.includes(m.reference), JSON.stringify(t));
    const approved = await request("POST", `/api/shipments/${A.id}/master-bl/approve`, {}, token);
    assert("approving it sends PATCH APPROVED; the carrier's APPROVED moves it", approved.status === 200 && approved.body?.status === "APPROVED" && !!approved.body.approvedBy,
      JSON.stringify(approved.body).slice(0, 300));
    t = await tasks(A.id);
    assert("…and the review task is closed", t.length === 1 && t[0].status === "Done", JSON.stringify(t.map(x => x.status)));
    assert("an approved draft can't be approved again (409)", (await request("POST", `/api/shipments/${A.id}/master-bl/approve`, {}, token)).status === 409);
    const issued = await carrierSi(siRef, "issue");
    m = await masterBl(A.id);
    const shipA = (await request("GET", `/api/shipments/${A.id}`, null, token)).body;
    assert("the carrier issues it: ISSUED with its issue date, the shipment takes the Master B/L number", issued.status === 200 && m?.status === "ISSUED"
      && !!m.issueDate && shipA.masterBlNumber === m.reference, JSON.stringify({ st: m?.status, d: m?.issueDate, n: shipA.masterBlNumber, ref: m?.reference }));
    assert("…and B/L Issued completes", await done(A.id, "bl_issued"), JSON.stringify((await milestones(A.id)).map(x => `${x.milestoneKey}:${!!x.completedAt}`)));
    const lateUpdate = await request("POST", `/api/shipments/${A.id}/shipping-instructions/send-update`, {}, token);
    const lateCancel = await request("POST", `/api/shipments/${A.id}/shipping-instructions/cancel`, {}, token);
    assert("once issued, the instructions can't be updated or cancelled (409)", lateUpdate.status === 409 && lateCancel.status === 409,
      JSON.stringify([lateUpdate.body, lateCancel.body]));
    await carrierSi(siRef, "surrender");
    const siA = await waitFor(() => si(A.id), s => s?.carrierState === "COMPLETED");
    m = await masterBl(A.id);
    assert("surrendered for delivery: the instructions become COMPLETED (Confirmed)", m?.status === "SURRENDERED_FOR_DELIVERY" && siA?.carrierState === "COMPLETED" && siA.status === "Confirmed",
      JSON.stringify({ td: m?.status, si: siA?.carrierState, st: siA?.status }));
    const tdLog = list((await request("GET", `/api/shipments/${A.id}/edi-messages`, null, token)).body).filter(x => x.messageType === "transport_document_notification");
    assert("the carrier's transport document notifications are in the message log", tdLog.length >= 4, `${tdLog.length}`);
    assert("the record's history has each state", ["MASTER_DRAFT", "MASTER_APPROVAL_SENT", "MASTER_APPROVED", "MASTER_ISSUED", "MASTER_SURRENDERED_FOR_DELIVERY"]
      .every(e => m.events.some(x => x.eventType === e)), JSON.stringify(m.events.map(x => x.eventType)));

    // ─── Phase 4: cancelling ─────────────────────────────────────────────────
    console.log("\nCancelling Shipping Instructions");
    const B = await bookedShipment("B", { containers: 1, voyage: `445W${rand}` });
    const subB = await submitSi(B.id);
    const refB = subB.body?.shippingInstructions?.siReference;
    const upd = await request("POST", `/api/shipments/${B.id}/shipping-instructions/send-update`, {}, token);
    const updState = await waitFor(() => si(B.id), s => s?.carrierUpdatedState === "UPDATE_RECEIVED");
    const updBody = parse(upd.body?.sent?.rawPayload);
    const updCheck = updBody ? validateOutbound("ebl", "put", "/v3/shipping-instructions/{documentReference}", updBody) : { ok: false, errors: [] };
    assert("Send update: the shipment's data as it is now, under the same reference (valid, no undefined fields)", upd.status === 201 && updCheck.ok
      && updBody.shippingInstructionsReference === refB && updState?.carrierUpdatedState === "UPDATE_RECEIVED", updCheck.ok ? JSON.stringify(upd.body).slice(0, 200) : errorsText(updCheck.errors, 4));
    const cancelUpd = await request("POST", `/api/shipments/${B.id}/shipping-instructions/cancel`, { update: true }, token);
    assert("the update can be cancelled before the carrier works it in: the instructions stand", cancelUpd.status === 200 && cancelUpd.body?.carrierUpdatedState === "UPDATE_CANCELLED"
      && cancelUpd.body.status === "Submitted" && cancelUpd.body.carrierState === "RECEIVED", JSON.stringify(cancelUpd.body));
    assert("no update waiting: cancelling one is refused (409)", (await request("POST", `/api/shipments/${B.id}/shipping-instructions/cancel`, { update: true }, token)).status === 409);
    const cancelSi = await request("POST", `/api/shipments/${B.id}/shipping-instructions/cancel`, {}, token);
    assert("the instructions themselves can be cancelled: Cancelled", cancelSi.status === 200 && cancelSi.body?.status === "Cancelled" && cancelSi.body.carrierState === "CANCELLED", JSON.stringify(cancelSi.body));
    const resetB = await request("PATCH", `/api/shipments/${B.id}/shipping-instructions/reset`, {}, token);
    assert("reset after a cancellation starts afresh (no reference)", resetB.status === 200 && resetB.body?.status === "Draft" && !resetB.body.siReference, JSON.stringify(resetB.body));
    const again = await request("POST", `/api/shipments/${B.id}/shipping-instructions/submit`, {}, token);
    assert("…and submitting sends new instructions under a new reference", again.status === 201 && again.body?.sent?.messageType === "shipping_instructions_submission"
      && again.body.shippingInstructions.siReference && again.body.shippingInstructions.siReference !== refB, JSON.stringify(again.body).slice(0, 200));

    // ─── Phase 4: House B/Ls in the Master's instructions (G25) ──────────────
    console.log("\nHouse B/L in the Master's Shipping Instructions (G25)");
    const H = await readyHouseBlShipment(request, token, { tag: "G25", emoOfficeId: office.id });
    cleanup.shipments.push(H.shipment.id); cleanup.customers.push(H.shipper.id, H.consignee.id);
    const draftH = await generateHouseBl(request, token, H.shipment.id, { houseBl: { shippedOnBoard: true } });
    const issueH = draftH.status === 201 ? await request("PATCH", `/api/shipments/${H.shipment.id}/documents/${draftH.body.id}`, { status: "confirmed" }, token) : draftH;
    assert("(setup) the House B/L is issued", issueH.status === 200, JSON.stringify(issueH.body).slice(0, 200));
    const subH = await submitSi(H.shipment.id);
    const siH = parse(subH.body?.sent?.rawPayload);
    const siHCheck = siH ? validateOutbound("ebl", "post", "/v3/shipping-instructions", siH) : { ok: false, errors: [] };
    const hbl = siH?.houseBillOfLadings?.[0];
    assert("the Master's instructions carry the House B/L: valid, no undefined fields", subH.status === 201 && siHCheck.ok && siH.isHouseBillOfLadingsIssued === true,
      siHCheck.ok ? JSON.stringify(subH.body).slice(0, 200) : errorsText(siHCheck.errors, 4));
    assert("…under its number, with its parties, route and container", hbl?.houseBillOfLadingReference === H.shipment.blNumber
      && hbl.documentParties?.shipper?.partyName === H.shipper.companyName && hbl.documentParties?.consignee?.identifyingCodes?.length === 1
      && JSON.stringify(hbl.routingOfConsignmentCountries) === JSON.stringify(["NL", "US"]) && hbl.utilizedTransportEquipments?.[0]?.equipmentReference === H.container.containerNumber,
      JSON.stringify(hbl).slice(0, 400));

    // ─── Phase 5: VGM declarations on record ─────────────────────────────────
    console.log("\nVGM declarations");
    const c0 = B.containers[0];
    const vgmBody = (v) => ({ containerNumber: c0.containerNumber, sealNumber: c0.sealNumber, size: c0.size, type: c0.type, hsCode: c0.hsCode,
      cargoDescription: c0.cargoDescription, marksAndNumbers: c0.marksAndNumbers, grossWeightKg: c0.grossWeightKg, volumeCbm: c0.volumeCbm,
      numberOfPackages: c0.numberOfPackages, packageCode: c0.packageCode, ...v });
    const decls = async () => list((await request("GET", `/api/shipments/${B.id}/vgm-declarations?containerId=${c0.id}`, null, token)).body);
    await request("PUT", `/api/shipments/${B.id}/containers/${c0.id}`, vgmBody({ vgmStatus: "Submitted", vgmMethod: "Method 2", vgmWeightKg: 12350 }), token);
    let d = await decls();
    assert("a declaration is on record: 12,350 kg, SM2, signatory, responsible and submitting parties", d.length === 1 && d[0].kind === "DECLARATION" && d[0].weightKg === 12350
      && d[0].method === "SM2" && !!d[0].signatory && d[0].responsibleParty === shipper.companyName && d[0].submittingParty === branch.name
      && d[0].declarationReference === `CD-VGM-${c0.id}` && d[0].isMock === true && d[0].isLegacy === false, JSON.stringify(d));
    assert("the current declaration is flagged until its evidence is attached", d[0].current === true && d[0].evidenceMissing === true && d[0].documents.length === 0, JSON.stringify(d[0]));
    // Evidence (VG02) and the VG01 document, filed against the declaration (the user's decision 2026-10-28).
    const pdf = Buffer.from("%PDF-1.4 weighbridge ticket WB-RTM-2026-10871").toString("base64");
    const ev = await request("POST", `/api/shipments/${B.id}/documents`, { filename: "WB-RTM-2026-10871.pdf", mimeType: "application/pdf", docType: "VG02", data: pdf,
      containerId: c0.id, vgmDeclarationId: d[0].id }, token);
    const vg = await request("POST", `/api/shipments/${B.id}/documents/generate`, { html: "<!doctype html><html><body><h1>VGM Declaration</h1></body></html>",
      filename: `VG01-${B.id}-${c0.containerNumber}.html`, docType: "VG01", containerId: c0.id, vgmDeclarationId: d[0].id }, token);
    d = await decls();
    assert("the weighbridge ticket and the VG01 are filed against the declaration, and the flag clears", ev.status === 201 && vg.status === 201
      && ev.body.vgmDeclarationId === d[0].id && d[0].documents.map(x => x.docType).sort().join() === "VG01,VG02" && d[0].evidenceMissing === false,
      JSON.stringify({ ev: ev.status, vg: vg.status, docs: d[0].documents, flag: d[0].evidenceMissing }));
    const wrongDecl = await request("POST", `/api/shipments/${A.id}/documents`, { filename: "x.pdf", mimeType: "application/pdf", docType: "VG02", data: pdf, vgmDeclarationId: d[0].id }, token);
    const wrongType = await request("POST", `/api/shipments/${B.id}/documents`, { filename: "x.pdf", mimeType: "application/pdf", docType: "CI01", data: pdf, vgmDeclarationId: d[0].id }, token);
    assert("a document can't be filed against another shipment's declaration, nor be other than VG01/VG02 (400)", wrongDecl.status === 400 && wrongType.status === 400,
      JSON.stringify([wrongDecl.body, wrongType.body]));
    const delCtr = await request("DELETE", `/api/shipments/${B.id}/containers/${c0.id}`, null, token);
    assert("a container whose VGM the carrier holds can't be removed until it is withdrawn (409)", delCtr.status === 409 && /set it back to Pending/.test(delCtr.body?.error), JSON.stringify(delCtr.body));
    await request("PUT", `/api/shipments/${B.id}/containers/${c0.id}`, vgmBody({ vgmStatus: "Submitted", vgmMethod: "Method 2", vgmWeightKg: 12410 }), token);
    d = await decls();
    assert("a re-declaration needs its own evidence: flagged again, the earlier one keeps its files", d[0].weightKg === 12410 && d[0].evidenceMissing === true
      && d[1].documents.length === 2 && d[1].current === false, JSON.stringify(d.slice(0, 2).map(x => ({ w: x.weightKg, flag: x.evidenceMissing, docs: x.documents.length }))));
    await request("PUT", `/api/shipments/${B.id}/containers/${c0.id}`, vgmBody({ vgmStatus: "Pending", vgmMethod: "Method 2", vgmWeightKg: 12410 }), token);
    d = await decls();
    assert("the re-declaration and the retraction are on record too, newest first", d.length === 3 && d[0].kind === "RETRACTION" && d[1].weightKg === 12410 && d[2].weightKg === 12350,
      JSON.stringify(d.map(x => `${x.kind}:${x.weightKg}`)));

    // ─── Phase 6: Track & Trace 3.0 pushed by the carrier ────────────────────
    console.log("\nTrack & Trace 3.0 (pushed)");
    const C = await bookedShipment("C", { containers: 2, voyage: `446W${rand}` });
    const gi = await report(C.id, "gateIn");
    let ce = await carrierEvents(C.id);
    assert("the carrier's gate-ins are kept with their classification", gi.status === 200 && ce.filter(e => e.eventType === "EQUIPMENT" && e.eventCode === "GATED_IN"
      && e.eventClassifier === "ACTUAL" && e.receivedVia === "push").length === 2, JSON.stringify(gi.body).slice(0, 300));
    let ev0 = await ctrEvents(C.id, C.containers[0].id);
    assert("…each became the container's Gate In, DCSA-classified", ev0.some(e => e.eventType === "Gate In" && e.dcsaEventCode === "GATED_IN" && e.emptyIndicator === "LADEN"
      && e.unLocationCode === "NLRTM"), JSON.stringify(ev0));
    assert("…and Cargo Gated In completes once every container has one", await done(C.id, "cargo_gated_in"), "");
    const gate0 = async () => (await ctrEvents(C.id, C.containers[0].id)).find(e => e.eventType === "Gate In");
    await report(C.id, "gateIn", { dateTime: `${inDays(-1)}T10:30:00Z` });
    let g0 = await gate0();
    assert("a corrected gate-in (the same event, updated later) corrects the container event's time", String(g0?.occurredAt).startsWith(`${inDays(-1)}T10:30`), JSON.stringify(g0));
    await report(C.id, "gateIn", { dateTime: `${inDays(-1)}T06:00:00Z`, updatedAt: "2026-01-01T00:00:00Z" });
    g0 = await gate0();
    assert("an older copy of it (an earlier eventUpdatedDateTime) is ignored", String(g0?.occurredAt).startsWith(`${inDays(-1)}T10:30`), JSON.stringify(g0));
    const estDep = inDays(6);
    await report(C.id, "departed", { classifier: "ESTIMATED", dateTime: `${estDep}T18:00:00Z` });
    let leg = await seaLeg(C.id);
    assert("an estimated departure moves the leg's ETD as the carrier's estimate", String(leg?.etd).startsWith(estDep) && leg.etdSource === "dcsa", JSON.stringify({ etd: leg?.etd, src: leg?.etdSource }));
    assert("…without sailing anything or completing Vessel Departed", !(await done(C.id, "vessel_departed")) && !(await ctrEvents(C.id, C.containers[0].id)).some(e => e.eventType === "Sailed"), "");
    const actDep = inDays(7);
    await report(C.id, "departed", { dateTime: `${actDep}T23:40:00Z` });
    leg = await seaLeg(C.id);
    assert("the actual departure confirms the ETD (carrier actual)", String(leg?.etd).startsWith(actDep) && leg.etdSource === "dcsa_actual", JSON.stringify({ etd: leg?.etd, src: leg?.etdSource }));
    assert("…sails every container and completes Vessel Departed", await done(C.id, "vessel_departed")
      && (await Promise.all(C.containers.map(c => ctrEvents(C.id, c.id)))).every(es => es.some(e => e.eventType === "Sailed" && e.dcsaEventCode === "DEPARTED")), "");
    await report(C.id, "departed", { classifier: "ESTIMATED", dateTime: `${inDays(9)}T08:00:00Z` });
    leg = await seaLeg(C.id);
    assert("a later estimate doesn't undo the confirmed departure", String(leg?.etd).startsWith(actDep) && leg.etdSource === "dcsa_actual", JSON.stringify({ etd: leg?.etd, src: leg?.etdSource }));
    const estArr = inDays(18);
    await report(C.id, "arrived", { classifier: "ESTIMATED", dateTime: `${estArr}T06:00:00Z` });
    leg = await seaLeg(C.id);
    assert("an estimated arrival moves the ETA", String(leg?.eta).startsWith(estArr) && leg.etaSource === "dcsa", JSON.stringify({ eta: leg?.eta, src: leg?.etaSource }));
    await report(C.id, "arrived", { dateTime: `${estArr}T09:15:00Z` });
    assert("the actual arrival completes Vessel Arrived", await done(C.id, "vessel_arrived"), "");
    await report(C.id, "customsReleased");
    ce = await carrierEvents(C.id);
    assert("customs release (no container lifecycle event of its own) completes Customs Cleared, and says so", await done(C.id, "customs_cleared")
      && ce.some(e => e.eventCode === "CUSTOMS_RELEASED" && /Customs Cleared completed/.test(e.applied)), JSON.stringify(ce.filter(e => e.eventCode === "CUSTOMS_RELEASED").map(e => e.applied)));
    await report(C.id, "gateOut");
    const go = (await carrierEvents(C.id)).find(e => e.eventCode === "GATED_OUT" && e.equipmentReference === C.containers[0].containerNumber);
    const retracted = go ? await request("POST", `/api/test-tools/dcsa-sim/events/${encodeURIComponent(go.carrierEventId)}/retract`, {}, token) : { status: 0 };
    ev0 = await ctrEvents(C.id, C.containers[0].id);
    const goAfter = (await carrierEvents(C.id)).find(e => e.carrierEventId === go?.carrierEventId);
    assert("a retracted event is discarded: its container event goes, the record says why", retracted.status === 200 && !ev0.some(e => e.eventType === "Gate Out")
      && goAfter?.isRetracted === true && /Retracted/.test(goAfter.applied), JSON.stringify({ st: retracted.status, r: goAfter?.applied }));
    const depEv = (await carrierEvents(C.id)).find(e => e.eventCode === "DEPARTED" && e.eventClassifier === "ACTUAL");
    const depRetracted = depEv ? await request("POST", `/api/test-tools/dcsa-sim/events/${encodeURIComponent(depEv.carrierEventId)}/retract`, {}, token) : { status: 0 };
    leg = await seaLeg(C.id);
    assert("retracting the actual departure (the retraction names only the event) takes the ETD back to the carrier's latest estimate",
      depRetracted.status === 200 && String(leg?.etd).startsWith(inDays(9)) && leg.etdSource === "dcsa", JSON.stringify({ st: depRetracted.status, etd: leg?.etd, src: leg?.etdSource }));
    assert("…and the Sailed events made from it go", !(await ctrEvents(C.id, C.containers[0].id)).some(e => e.eventType === "Sailed"), "");
    const pulled = await request("POST", `/api/shipments/${C.id}/carrier-events/sync`, {}, token);
    assert("pulling the same events (Sync carrier events) adds and retracts nothing again", pulled.status === 200 && pulled.body.received > 0
      && pulled.body.added.length === 0 && pulled.body.retracted === 0,
      JSON.stringify({ received: pulled.body?.received, added: pulled.body?.added?.length, retracted: pulled.body?.retracted, already: pulled.body?.alreadyRecorded }));
    const errs = await Promise.all([report(C.id, "beamedUp"), report(C.id, "loaded", { classifier: "ESTIMATED" }), report(C.id, "gateIn", { routeBy: "vessel" }),
      request("POST", "/api/test-tools/dcsa-sim/vessel-calls", { vesselImo: "9333022", voyage: `446W${rand}`, unLocationCode: "NLRTM", eventTypeCode: "SAIL", eventClassifierCode: "ACT", eventDateTime: inDays(1) }, token)]);
    assert("Test Tools refuses nonsense (unknown event, an estimated load, a vessel-only gate-in, a bad vessel time): 400 each", errs.every(r => r.status === 400),
      JSON.stringify(errs.map(r => r.status)));

    console.log("\nVessel events named by vessel and voyage only");
    const V1 = await bookedShipment("V1", { containers: 1, voyage: `449W${rand}` });
    const V2 = await bookedShipment("V2", { containers: 1, voyage: `449W${rand}` });
    const V3 = await bookedShipment("V3", { containers: 1, voyage: `450W${rand}` });
    const vr = await report(V1.id, "departed", { routeBy: "vessel", dateTime: `${inDays(5)}T22:00:00Z` });
    assert("a departure naming only the vessel and voyage reaches every shipment on that voyage, and not the next voyage",
      vr.status === 200 && (await done(V1.id, "vessel_departed")) && (await done(V2.id, "vessel_departed")) && !(await done(V3.id, "vessel_departed")),
      JSON.stringify(vr.body?.carrierEvents?.map(e => e.applied)).slice(0, 300));
    await submitSi(V3.id);
    const ref3 = (await si(V3.id))?.siReference;
    await carrierSi(ref3, "draft");
    const voided = await carrierSi(ref3, "void");
    const m3 = await masterBl(V3.id);
    assert("a voided Master B/L (the carrier's notification says VOID) is VOIDED", voided.status === 200 && m3?.status === "VOIDED", JSON.stringify(m3?.status));

    // ─── Phase 6: vessel times from Operational Vessel Schedules 3.0 ─────────
    console.log("\nVessel times (OVS 3.0)");
    const D = await bookedShipment("D", { containers: 1, voyage: `447W${rand}` });
    const call = body => request("POST", "/api/test-tools/dcsa-sim/vessel-calls", { carrierCode: "MAEU", vesselImo: "9333022", vesselName: "MAERSK KENSINGTON", voyage: `447W${rand}`, serviceCode: "AE7", ...body }, token);
    await call({ unLocationCode: "NLRTM", eventTypeCode: "DEPA", eventClassifierCode: "EST", eventDateTime: `${inDays(7)}T10:00:00Z` });
    await call({ unLocationCode: "USNYC", eventTypeCode: "ARRI", eventClassifierCode: "EST", eventDateTime: `${inDays(19)}T07:00:00Z` });
    const sync1 = await request("POST", `/api/shipments/${D.id}/vessel-times/sync`, {}, token);
    leg = await seaLeg(D.id);
    assert("Check vessel times: the carrier's estimates move the leg (ETD and ETA, carrier estimates)", sync1.status === 200 && sync1.body.changes.length === 2
      && String(leg.etd).startsWith(inDays(7)) && leg.etdSource === "dcsa" && String(leg.eta).startsWith(inDays(19)) && leg.etaSource === "dcsa", JSON.stringify({ b: sync1.body, etd: leg?.etd, eta: leg?.eta }));
    await call({ unLocationCode: "NLRTM", eventTypeCode: "DEPA", eventClassifierCode: "ACT", eventDateTime: `${inDays(7)}T21:05:00Z` });
    const sync2 = await request("POST", `/api/shipments/${D.id}/vessel-times/sync`, {}, token);
    leg = await seaLeg(D.id);
    assert("an actual departure confirms the ETD and completes Vessel Departed", sync2.status === 200 && leg.etdSource === "dcsa_actual" && (await done(D.id, "vessel_departed")),
      JSON.stringify({ b: sync2.body, src: leg?.etdSource }));
    const sync3 = await request("POST", `/api/shipments/${D.id}/vessel-times/sync`, {}, token);
    assert("asking again changes nothing", sync3.status === 200 && sync3.body.changes.length === 0, JSON.stringify(sync3.body));

    console.log("\nAIS is the fallback");
    const testImo = `99${String(Date.now()).slice(-5)}`;
    cleanup.vessels = [testImo];
    const F = await plainShipment("F", { voyage: `451W${rand}`, imo: testImo, vessel: "DCSA AIS FALLBACK" });
    await call({ vesselImo: testImo, vesselName: "DCSA AIS FALLBACK", voyage: `451W${rand}`, unLocationCode: "NLRTM", eventTypeCode: "DEPA", eventClassifierCode: "ACT", eventDateTime: `${inDays(4)}T20:00:00Z` });
    await request("POST", `/api/shipments/${F.id}/vessel-times/sync`, {}, token);
    let legF = await seaLeg(F.id);
    await request("POST", "/api/test-tools/ais/simulate-static", { imo: testImo, mmsi: `24${String(Date.now()).slice(-7)}`, name: "DCSA AIS FALLBACK" }, token);
    const ais = await request("POST", "/api/test-tools/ais/simulate-position", { legId: legF?.id, event: "departure" }, token);
    const legF2 = await seaLeg(F.id);
    assert("AIS never overwrites a departure the carrier confirmed", legF?.etdSource === "dcsa_actual" && String(legF.etd).startsWith(inDays(4))
      && legF2.etdSource === "dcsa_actual" && legF2.etd === legF.etd, JSON.stringify({ before: [legF?.etd, legF?.etdSource], ais: ais.status, after: [legF2?.etd, legF2?.etdSource] }));

    const sweeps = await Promise.all(["/api/shipping-instructions/poll-sweep", "/api/master-bl/poll-sweep", "/api/vessel-times/sync-sweep"].map(p => request("POST", p, {}, token)));
    assert("the Shipping Instructions, Master B/L and vessel-times sweeps run on demand (admin)", sweeps.every(r => r.status === 200), JSON.stringify(sweeps.map(r => [r.status, r.body])));

    console.log("\nThe demo carrier's decline");
    const G = await plainShipment("G");
    await request("PUT", `/api/shipments/${G.id}`, { bookingRef: "MAEU-TYPED-0001" }, token);
    await submitSi(G.id);
    const refG = (await si(G.id))?.siReference;
    const declined = await carrierSi(refG, "draft");
    const siG = await waitFor(() => si(G.id), s => s?.carrierState === "DECLINED");
    assert("instructions for a booking the carrier doesn't hold (typed by hand) are declined, saying so", declined.status === 200 && !!declined.body?.refused
      && siG?.status === "Rejected" && /holds no confirmed booking MAEU-TYPED-0001/.test(siG.carrierFeedback || ""), JSON.stringify({ r: declined.body?.refused, s: siG }));

    // ─── Phase 6: milestones carry their DCSA events ─────────────────────────
    console.log("\nMilestones and their DCSA events");
    const ms = await milestones(C.id);
    const vd = ms.find(x => x.milestoneKey === "vessel_departed");
    assert("each milestone says which DCSA events complete it", vd?.dcsaEvents?.[0]?.label === "Transport · Departed at POL"
      && ms.find(x => x.milestoneKey === "vessel_arrived")?.dcsaEvents?.length === 2, JSON.stringify(vd?.dcsaEvents));
    const bad = await request("POST", "/api/milestone-templates", { templateKey: "FCL", carrierCode: "ZZDE", milestoneKey: "empty_returned", label: "Empty Returned",
      sequenceOrder: 10, dcsaEvents: [{ eventType: "EQUIPMENT", code: "RETURNED" }] }, token);
    assert("a template's DCSA events are checked against the code lists (400)", bad.status === 400 && /RETURNED is not a DCSA equipment event/.test(bad.body?.error), JSON.stringify(bad.body));
    const good = await request("POST", "/api/milestone-templates", { templateKey: "FCL", carrierCode: "ZZDE", milestoneKey: "empty_returned", label: "Empty Returned",
      sequenceOrder: 10, dcsaEvents: [{ eventType: "EQUIPMENT", code: "GATED_IN", emptyIndicator: "EMPTY", place: "POD" }] }, token);
    if (good.body?.id) cleanup.templates.push(good.body.id);
    assert("…and a valid one is kept, with how it reads", good.status === 201 && good.body.dcsaEvents?.[0]?.label === "Equipment · Gated in empty at POD", JSON.stringify(good.body));
    const T = await plainShipment("T");
    await request("POST", `/api/shipments/${T.id}/milestones/init`, { carrierCode: "ZZDE" }, token);
    await request("POST", `/api/shipments/${T.id}/containers/${T.container.id}/events`, { eventType: "Empty Return", occurredAt: `${inDays(20)}T09:00:00Z`, location: "USNYC" }, token);
    assert("…and that template's milestone completes from its own DCSA event (an empty return at the POD)", await done(T.id, "empty_returned"),
      JSON.stringify((await milestones(T.id)).map(x => `${x.milestoneKey}:${!!x.completedAt}`)));
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    console.log("\nCleanup");
    for (const id of cleanup.templates) await request("DELETE", `/api/milestone-templates/${id}`, null, token);
    for (const imo of cleanup.vessels || []) await request("DELETE", `/api/vessels/${imo}`, null, token);
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token);
    if (cleanup.office) console.log(`  office: ${await retireOffice(token, cleanup.office)}`);
    if (cleanup.branch) console.log(`  branch: ${await retireBranch(token, cleanup.branch)}`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
