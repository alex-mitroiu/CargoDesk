/**
 * Every message CargoDesk sends a carrier is valid DCSA, and nothing goes that isn't (2026-10-27 review).
 *
 *  - Booking 2.0: the body logged as sent validates against the spec and names no field the spec doesn't
 *    define; it carries the contract number as serviceContractReference and the shipment's Line Agent
 *    (Export) — the carrier's local office — as the carrier booking office; a booking with no contract
 *    or quote, or with neither an ETD nor a vessel and voyage, is refused before anything is recorded;
 *  - Shipping Instructions 3.0 through the built-in carrier: submit (202 + reference, RECEIVED), the
 *    carrier asks for an update (PENDING_UPDATE with its feedback), reopen, send the update under the
 *    same reference (UpdateShippingInstructions, UPDATE_RECEIVED), the carrier accepts it by drafting
 *    its Master B/L (Confirmed; the spec's COMPLETED comes only with the B/L's surrender, see
 *    tests/dcsa-documents-events.test.js); missing data refuses the submit with what's missing;
 *  - VGM 1.0: marking a container's VGM Submitted declares it to the carrier, a change re-declares it
 *    under the same reference, going back to Pending retracts it; no weight → refused, nothing sent.
 *
 * Usage:
 *   node tests/dcsa-messages.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001, not in production (the built-in DCSA carrier is always on there)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { createRequire } from "node:module";
import { ensureOffices, retireOffice, retireBranch } from "./helpers/offices.mjs";
import { carrierActs } from "./helpers/dcsa-sim.mjs";

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
const parse = v => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
const checkOutbound = (method, apiPath, key, body) => { const v = validateOutbound(key, method, apiPath, body); return v.ok ? "" : errorsText(v.errors, 6); };

(async () => {
  const cleanup = { shipments: [], customers: [], office: null, branch: null };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { imoOfficeId } = await ensureOffices(token);

    // The export office's legal entity, with the email and phone the carrier is given as the contact.
    const branch = (await request("POST", "/api/branches", { code: `DMS${rand}`, name: `CargoDesk Logistics Rotterdam ${rand} BV`, countryCode: "NL",
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
    const shipper = await customer(`Van Leeuwen Furniture ${rand} BV`, "Waalhaven Oostzijde 81", "3087 BM", "Rotterdam", "NL",
      { email: "logistics@vanleeuwen.example", phone: "+31 10 428 1100" });
    const consignee = await customer(`Hudson Home Imports ${rand} Inc`, "250 Port Jersey Blvd", "07305", "Jersey City", "US");
    // The carrier's Master B/L names the consignee by an identifying code (DCSA eBL 3.0.3).
    await request("POST", `/api/customers/${consignee.id}/identifiers`, { idType: "LEI", idCode: `5493001KJTIIGC8Y1R${String(Date.now()).slice(-2)}`, countryIso2: "US" }, token);
    const lineAgent = await customer(`Maersk Nederland ${rand} BV`, "Boompjes 40", "3011 XB", "Rotterdam", "NL",
      { email: "nl.export@maersk.example", phone: "+31 10 712 3400" });

    const newShipment = async ({ contractType = "Central", contractRef = "MAEU-SC-2026-0418", etd = "2026-11-02", leg = true } = {}) => {
      const s = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType, contractRef,
        ...(etd ? { etd, eta: "2026-11-14" } : {}), incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId: office.id, imoOfficeId }, token);
      if (!s.body?.id) throw new Error(`scratch shipment not created: ${JSON.stringify(s.body)}`);
      cleanup.shipments.push(s.body.id);
      if (leg) await request("POST", `/api/shipments/${s.body.id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
        etd: "2026-11-02", eta: "2026-11-14", carrierCode: "MAEU", vessel: "MAERSK KENSINGTON", vesselImo: "9333022", voyage: "444W" }, token);
      return s.body.id;
    };
    const addContainer = async (shipmentId, n) => (await request("POST", "/api/containers", {
      shipmentId, containerNumber: `MSKU${String(Date.now()).slice(-6)}${n}`, sealNumber: `ML-${String(Date.now()).slice(-6)}`, size: "40", type: "HC",
      hsCode: "940360", cargoDescription: "Wooden dining furniture, flat-packed", marksAndNumbers: "VLF ROTTERDAM 1-120",
      grossWeightKg: 11850, volumeCbm: 64, numberOfPackages: 120, packageCode: "CT" }, token)).body;
    const messages = async id => (await request("GET", `/api/shipments/${id}/edi-messages`, null, token)).body || [];
    const booking = async id => (await request("GET", `/api/shipments/${id}/carrier-booking`, null, token)).body;
    const sendBooking = id => request("POST", `/api/shipments/${id}/edi-messages/booking-request`, {}, token);

    // ─── Booking 2.0 ──────────────────────────────────────────────────────────
    console.log("\nBooking 2.0");
    const A = await newShipment();
    const ctr = await addContainer(A, 1);
    assert("(setup) a container with its seal", !!ctr?.id && !!ctr.sealNumber, JSON.stringify(ctr).slice(0, 200));
    const agent = await request("POST", `/api/shipments/${A}/parties`, { role: "Line Agent (Export)", customerId: lineAgent.id, customerName: lineAgent.companyName }, token);
    assert("(setup) the carrier's local office is the shipment's Line Agent (Export)", agent.status === 201 || agent.status === 200, JSON.stringify(agent.body));

    const sent = await sendBooking(A);
    assert("the booking request is sent (201)", sent.status === 201, JSON.stringify(sent.body));
    const out = (await messages(A)).find(m => m.direction === "out" && /booking/.test(m.messageType));
    const body = parse(out?.rawPayload);
    assert("the message log holds the DCSA body as sent", !!body?.shipmentLocations, String(out?.rawPayload).slice(0, 200));
    const bodyProblems = body ? checkOutbound("post", "/v2/bookings", "bkg", body) : "no body";
    assert("…valid DCSA Booking 2.0, with no field the spec doesn't define", bodyProblems === "", bodyProblems);
    assert("…CargoDesk's own summary kept beside it", !!parse(out?.parsedPayload), String(out?.parsedPayload).slice(0, 120));
    assert("the contract number goes as serviceContractReference, no quotation reference",
      body?.serviceContractReference === "MAEU-SC-2026-0418" && body?.contractQuotationReference === undefined, JSON.stringify({ sc: body?.serviceContractReference, q: body?.contractQuotationReference }));
    const cbo = body?.documentParties?.carrierBookingOffice;
    assert("the carrier booking office is the Line Agent (Export), at the port of loading",
      cbo?.partyName === lineAgent.companyName && cbo?.UNLocationCode === "NLRTM", JSON.stringify(cbo));
    assert("…with its address and contact", cbo?.address?.city === "Rotterdam" && cbo?.address?.street && cbo?.partyContactDetails?.[0]?.email === "nl.export@maersk.example",
      JSON.stringify(cbo));
    assert("the booking agent is CargoDesk's legal entity, with its contact", body?.documentParties?.bookingAgent?.partyName === branch.name
      && body.documentParties.bookingAgent.partyContactDetails?.[0]?.email === "export.rotterdam@cargodesk.example", JSON.stringify(body?.documentParties?.bookingAgent));
    assert("the voyage goes with its vessel", body?.carrierExportVoyageNumber === "444W" && body?.vessel?.name === "MAERSK KENSINGTON", JSON.stringify({ v: body?.carrierExportVoyageNumber, vessel: body?.vessel }));
    const confirmed = await carrierActs(request, token, A, "confirm");
    assert("the carrier confirms it", confirmed.status === 200 && confirmed.body?.booking?.status === "Confirmed", JSON.stringify(confirmed.body).slice(0, 300));
    const bookingNumber = confirmed.body?.booking?.bookingRef;

    const B = await newShipment({ contractType: "SPOT", contractRef: "" });
    await addContainer(B, 2);
    const noContract = await sendBooking(B);
    assert("no contract number and no quote: refused (400), saying so", noContract.status === 400 && /service contract number/.test(noContract.body?.error), JSON.stringify(noContract.body));
    assert("…nothing recorded as sent", !(await messages(B)).some(m => m.direction === "out") && (await booking(B))?.status !== "Pending", "");
    await request("PUT", `/api/shipments/${B}`, { contractRef: "SPOT-Q-2026-0611" }, token);
    const spotSent = await sendBooking(B);
    const spotBody = parse((await messages(B)).find(m => m.direction === "out" && /booking/.test(m.messageType))?.rawPayload);
    assert("a spot booking's quote goes as contractQuotationReference, alone", spotSent.status === 201 && spotBody?.contractQuotationReference === "SPOT-Q-2026-0611"
      && spotBody?.serviceContractReference === undefined, JSON.stringify({ st: spotSent.status, e: spotSent.body?.error, q: spotBody?.contractQuotationReference, sc: spotBody?.serviceContractReference }));

    const C = await newShipment({ etd: "", leg: false });
    const ctrC = await addContainer(C, 3);
    const noSailing = await sendBooking(C);
    assert("no ETD and no vessel and voyage: refused (400), saying so", noSailing.status === 400 && /ETD, or the vessel and voyage/.test(noSailing.body?.error), JSON.stringify(noSailing.body));

    // ─── VGM 1.0 ──────────────────────────────────────────────────────────────
    console.log("\nVGM 1.0");
    const container = c => ({ containerNumber: c.containerNumber, sealNumber: c.sealNumber, size: c.size, type: c.type, hsCode: c.hsCode,
      cargoDescription: c.cargoDescription, marksAndNumbers: c.marksAndNumbers, grossWeightKg: c.grossWeightKg, volumeCbm: c.volumeCbm,
      numberOfPackages: c.numberOfPackages, packageCode: c.packageCode });
    const putVgm = (shipmentId, c, vgm) => request("PUT", `/api/shipments/${shipmentId}/containers/${c.id}`, { ...container(c), ...vgm }, token);
    const declared = async number => (await request("GET", `/api/test-tools/dcsa-sim/vgm-declarations?equipmentReference=${number}`, null, token)).body || [];
    const vgmMessages = async id => (await messages(id)).filter(m => m.direction === "out" && /^vgm_/.test(m.messageType));

    const v1 = await putVgm(A, ctr, { vgmStatus: "Submitted", vgmMethod: "Method 2", vgmWeightKg: 12350 });
    assert("marking the VGM Submitted is saved (200)", v1.status === 200 && v1.body?.vgmStatus === "Submitted", JSON.stringify(v1.body).slice(0, 200));
    let d = await declared(ctr.containerNumber);
    const decl = d[0]?.declaration;
    assert("the carrier holds one declaration for the container: 12,350 KGM, SM2", d.length === 1 && decl?.VGM?.weight?.value === 12350
      && decl.VGM.weight.unit === "KGM" && decl.VGM.method === "SM2" && !d[0].isRetracted, JSON.stringify(d).slice(0, 300));
    assert("…for the confirmed booking, with the shipper responsible and the office submitting", decl?.shipmentDetails?.carrierBookingReference === bookingNumber
      && decl?.responsibleParty?.partyName === shipper.companyName && decl?.submittingParty?.partyName === branch.name, JSON.stringify(decl).slice(0, 400));
    let vm = await vgmMessages(A);
    const vgmProblems = vm[0] ? checkOutbound("post", "/vgm-declarations", "vgm", parse(vm[0].rawPayload)) : "no message";
    assert("the declaration as sent is in the message log: valid DCSA VGM 1.0, no undefined fields", vm.length === 1 && vm[0].messageType === "vgm_declaration" && vgmProblems === "", vgmProblems);

    const v2 = await putVgm(A, ctr, { vgmStatus: "Submitted", vgmMethod: "Method 2", vgmWeightKg: 12410 });
    d = await declared(ctr.containerNumber);
    assert("a corrected weight is declared again, replacing the first", v2.status === 200 && d.length === 1 && d[0].declaration?.VGM?.weight?.value === 12410, JSON.stringify(d).slice(0, 200));
    const v3 = await putVgm(A, ctr, { vgmStatus: "Submitted", vgmMethod: "Method 2", vgmWeightKg: 12410, cargoDescription: "Wooden dining furniture, flat-packed (120 cartons)" });
    assert("an unrelated change sends nothing", v3.status === 200 && (await vgmMessages(A)).length === 2, `${(await vgmMessages(A)).length}`);
    const v4 = await putVgm(A, ctr, { vgmStatus: "Pending", vgmMethod: "Method 2", vgmWeightKg: 12410 });
    d = await declared(ctr.containerNumber);
    vm = await vgmMessages(A);
    assert("back to Pending retracts the declaration", v4.status === 200 && d[0]?.isRetracted === true && vm.some(m => m.messageType === "vgm_retraction"),
      JSON.stringify({ st: v4.status, d: d[0]?.isRetracted, types: vm.map(m => m.messageType) }));
    const v5 = await putVgm(A, ctr, { vgmStatus: "Submitted", vgmMethod: "Method 1", vgmWeightKg: 12410 });
    d = await declared(ctr.containerNumber);
    assert("declaring it again un-retracts it (SM1 now)", v5.status === 200 && d[0]?.isRetracted === false && d[0].declaration?.VGM?.method === "SM1", JSON.stringify(d).slice(0, 200));

    const noWeight = ctrC?.id ? await putVgm(C, ctrC, { vgmStatus: "Submitted", vgmMethod: "Method 1", vgmWeightKg: null }) : { status: 0, body: "no container" };
    assert("no verified gross mass: refused (400), nothing declared", noWeight.status === 400 && /verified gross mass/.test(noWeight.body?.error)
      && (await declared(ctrC?.containerNumber || "-")).length === 0, JSON.stringify(noWeight.body));

    // ─── Shipping Instructions 3.0 ────────────────────────────────────────────
    console.log("\nShipping Instructions 3.0");
    const si = async id => (await request("GET", `/api/shipments/${id}/shipping-instructions`, null, token)).body;
    const waitSi = async (id, pred, ms = 5000) => { const until = Date.now() + ms; let s; while (Date.now() < until) { s = await si(id); if (pred(s)) return s; await sleep(150); } return s; };
    const draft = { siCutoff: "2026-10-30T12:00", specialInstructions: "Shipper's load, stow and count" };

    await request("PUT", `/api/shipments/${C}/shipping-instructions`, draft, token);
    const early = await request("POST", `/api/shipments/${C}/shipping-instructions/submit`, {}, token);
    assert("no confirmed booking: the submit is refused (400) with what's missing", early.status === 400 && /booking number/.test(early.body?.error), JSON.stringify(early.body));

    const saved = await request("PUT", `/api/shipments/${A}/shipping-instructions`, draft, token);
    assert("(setup) the draft is saved", saved.status === 201 || saved.status === 200, JSON.stringify(saved.body));
    const sub = await request("POST", `/api/shipments/${A}/shipping-instructions/submit`, {}, token);
    const siBody = parse(sub.body?.sent?.rawPayload);
    const siRef = sub.body?.shippingInstructions?.siReference;
    assert("submitted (201): the carrier's reference comes back", sub.status === 201 && /^SISIM-/.test(siRef || "") && sub.body.shippingInstructions.status === "Submitted",
      JSON.stringify(sub.body).slice(0, 300));
    const siProblems = siBody ? checkOutbound("post", "/v3/shipping-instructions", "ebl", siBody) : "no body";
    assert("…the body as sent is valid DCSA Shipping Instructions 3.0, no undefined fields", siProblems === "", siProblems);
    assert("…for the confirmed booking, the NVOCC-less shipper and consignee, and the container with its seal",
      JSON.stringify(siBody).includes(bookingNumber) && siBody?.documentParties?.shipper?.partyName === shipper.companyName
      && siBody?.documentParties?.consignee?.partyName === consignee.companyName
      && JSON.stringify(siBody?.utilizedTransportEquipments || []).includes(ctr.containerNumber), JSON.stringify(siBody).slice(0, 400));
    let s1 = await waitSi(A, s => s?.carrierState === "RECEIVED");
    assert("the carrier's RECEIVED notification arrives", s1?.carrierState === "RECEIVED" && s1.status === "Submitted" && s1.isMock === true, JSON.stringify(s1));

    const reason = "Consignee tax ID missing for US customs";
    const rej = await request("POST", `/api/shipments/${A}/shipping-instructions/simulate-response`, { outcome: "rejected", reason }, token);
    assert("the carrier asks for an update: Rejected, PENDING_UPDATE, with its feedback", rej.status === 201 && rej.body?.status === "Rejected"
      && rej.body.carrierState === "PENDING_UPDATE" && rej.body.carrierFeedback.includes(reason), JSON.stringify(rej.body));
    const reset = await request("PATCH", `/api/shipments/${A}/shipping-instructions/reset`, {}, token);
    assert("reopened to correct, keeping the carrier's reference", reset.status === 200 && reset.body?.status === "Draft" && reset.body.siReference === siRef, JSON.stringify(reset.body));
    const upd = await request("POST", `/api/shipments/${A}/shipping-instructions/submit`, {}, token);
    const updBody = parse(upd.body?.sent?.rawPayload);
    const updProblems = updBody ? checkOutbound("put", "/v3/shipping-instructions/{documentReference}", "ebl", updBody) : "no body";
    assert("the correction goes as a DCSA update under the same reference", upd.status === 201 && upd.body.sent.messageType === "shipping_instructions_update"
      && updBody?.shippingInstructionsReference === siRef && upd.body.shippingInstructions.siReference === siRef, JSON.stringify(upd.body).slice(0, 300));
    assert("…valid UpdateShippingInstructions, no undefined fields", updProblems === "", updProblems);
    const s2 = await waitSi(A, s => s?.carrierUpdatedState === "UPDATE_RECEIVED");
    assert("the carrier's UPDATE_RECEIVED arrives: Submitted again", s2?.carrierUpdatedState === "UPDATE_RECEIVED" && s2.status === "Submitted", JSON.stringify(s2));
    const done = await request("POST", `/api/shipments/${A}/shipping-instructions/simulate-response`, { outcome: "confirmed" }, token);
    assert("the carrier accepts them by drafting its Master B/L: Confirmed, still RECEIVED (COMPLETED waits for the B/L's surrender)",
      done.status === 201 && done.body?.status === "Confirmed" && done.body.carrierState === "RECEIVED" && done.body.carrierUpdatedState === "UPDATE_CONFIRMED", JSON.stringify(done.body));
    const siLog = (await messages(A)).filter(m => /^shipping_instructions/.test(m.messageType));
    assert("the message log has both sends and the carrier's notifications", siLog.filter(m => m.direction === "out").length === 2
      && siLog.filter(m => m.direction === "in" && m.messageType === "shipping_instructions_notification").length >= 3, JSON.stringify(siLog.map(m => `${m.direction}:${m.messageType}:${m.status}`)));
    const again = await request("POST", `/api/shipments/${A}/shipping-instructions/submit`, {}, token);
    assert("completed Shipping Instructions can't be submitted again (409)", again.status === 409, JSON.stringify(again.body));
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
