/**
 * The carrier's Master B/L as sent to the forwarder (2026-11-10, lib/carrier-mbl.js, ARCHITECTURE.md §8.49):
 *   - MB01 is the carrier's: POST …/documents/generate refuses it; it is printed from the carrier's issued DCSA
 *     transport document (a copy, COPY · NOT NEGOTIABLE, with the carrier's terms) or its PDF uploaded;
 *   - the carrier's PDF is read: the B/L number, every container and the vessel found or not, a container it names
 *     that isn't on the shipment; a scan (no text) is checked by eye;
 *   - where it is until the carrier releases: paper (received → sent → surrendered → released, or surrendered at
 *     origin), eBL (issued → transferred → surrendered → released, tracked), sea waybill (released only); each step in
 *     order, dated forward, undoable with a reason; the form fixed once a step is recorded; the shipment's History;
 *   - the House B/L's release at destination notes, without blocking, a Master the carrier hasn't released.
 *
 * Usage:
 *   node tests/carrier-mbl.test.js
 *
 * Prerequisites:
 *   - Express server on :3001 (+ pdf-render on :3003), not in production (the built-in DCSA carrier answers)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { createRequire } from "node:module";
import { ensureOffices, retireOffice, retireBranch } from "./helpers/offices.mjs";
import { bookThroughCarrier } from "./helpers/dcsa-sim.mjs";
import { readyHouseBlShipment, generateHouseBl, assignHouseBlNumber } from "./helpers/house-bl.mjs";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const BASE = "http://localhost:3001";
let passed = 0, failed = 0;

async function request(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }), ...headers },
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const list = b => (Array.isArray(b) ? b : (b?.results ?? []));
// A PDF the way a carrier's system writes one (text), or a scan (an image of a page: no text at all).
async function textPdf(lines) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([595.28, 841.89]);
  lines.forEach((l, i) => p.drawText(l, { x: 40, y: 790 - i * 18, size: 10, font: f }));
  return Buffer.from(await d.save()).toString("base64");
}
async function scanPdf() {
  const d = await PDFDocument.create();
  const p = d.addPage([595.28, 841.89]);
  for (let i = 0; i < 30; i++) p.drawRectangle({ x: 40, y: 780 - i * 22, width: 300 + (i % 5) * 40, height: 8, color: rgb(0.2, 0.2, 0.2) });
  return Buffer.from(await d.save()).toString("base64");
}

(async () => {
  const cleanup = { office: null, branch: null, user: null };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { imoOfficeId } = await ensureOffices(token);
    // A scratch export office with its own legal entity (the Shipping Instructions need its contact), retired at the end.
    const branch = (await request("POST", "/api/branches", { code: `CMB${rand}`, name: `CargoDesk Logistics Rotterdam MBL ${rand} BV`, countryCode: "NL",
      city: "Rotterdam", address: "Wilhelminakade 909", locode: "NLRTM", taxRegistrationNumber: "NL004495445B01", currency: "EUR",
      email: "export.rotterdam@cargodesk.example", phone: "+31 10 555 0142", scac: "CDLR" }, token)).body;
    cleanup.branch = branch.id;
    const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
    const office = (await request("POST", "/api/offices", { unlocode: `NL${letters}`, countryCode: "NL", department: "SE", name: `Rotterdam Export MBL ${rand}`, branchId: branch.id }, token)).body;
    if (!office?.id) throw new Error(`scratch office not created: ${JSON.stringify(office)}`);
    cleanup.office = office.id;

    const customer = async (companyName, address1, postalCode, city, countryIso2, extra = {}) =>
      (await request("POST", "/api/customers", { companyName, address1, postalCode, city, countryIso2, ...extra }, token)).body;
    const shipper = await customer(`Van Leeuwen Meubelen ${rand} BV`, "Waalhaven Oostzijde 81", "3087 BM", "Rotterdam", "NL", { email: "logistics@vanleeuwen.example", phone: "+31 10 428 1100" });
    const consignee = await customer(`Hudson Home Imports ${rand} Inc`, "250 Port Jersey Blvd", "07305", "Jersey City", "US");
    await request("POST", `/api/customers/${consignee.id}/identifiers`, { idType: "LEI", idCode: `5493001KJTIIGC8Y1R${String(Date.now()).slice(-2)}`, countryIso2: "US" }, token);

    // A complete NLRTM → USNYC shipment on MAEU: real parties, FOB, dates, commodity, sealed 40' HCs on the vessel's sea leg.
    let n = 0;
    const shipment = async (tag, { book = false, containers = 2, masterBlReleaseType = "Original" } = {}) => {
      const s = (await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central",
        contractRef: "MAEU-SC-2026-0418", etd: inDays(5), eta: inDays(17), incoterm: "FOB", commodityCode: "9999", freightTerms: "Prepaid", masterBlReleaseType,
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId: office.id, imoOfficeId }, token)).body;
      if (!s?.id) throw new Error(`shipment ${tag}: ${JSON.stringify(s)}`);
      await request("POST", `/api/shipments/${s.id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
        etd: inDays(5), eta: inDays(17), carrierCode: "MAEU", vessel: "MAERSK KENSINGTON", vesselImo: "9333022", voyage: `448W${rand}${tag}` }, token);
      const ctrs = [];
      for (let i = 0; i < containers; i++) {
        n++;
        ctrs.push((await request("POST", "/api/containers", { shipmentId: s.id, containerNumber: `MSKU${String(Date.now()).slice(-5)}${n % 10}${i}`,
          sealNumber: `ML-${String(Date.now()).slice(-5)}${i}`, size: "40", type: "HC", hsCode: "940360", cargoDescription: "Wooden dining furniture, flat-packed",
          marksAndNumbers: `VLF ${tag} 1-120`, grossWeightKg: 11850 + i * 1090, volumeCbm: 64, numberOfPackages: 120, packageCode: "CT" }, token)).body);
      }
      if (book) {
        await request("POST", `/api/shipments/${s.id}/milestones/init`, {}, token);
        const b = await bookThroughCarrier(request, token, s.id);
        if (b.booking?.status !== "Confirmed") throw new Error(`shipment ${tag} not booked: ${JSON.stringify(b.booking).slice(0, 200)}`);
      }
      return { id: s.id, containers: ctrs.map(c => c.containerNumber) };
    };
    const view = async id => (await request("GET", `/api/shipments/${id}/master-bl/custody`, null, token)).body;
    const step = (id, body) => request("POST", `/api/shipments/${id}/master-bl/custody/steps`, body, token);
    const yesterday = inDays(-1), today = inDays(0);

    console.log("\nMB01 is the carrier's");
    const A = await shipment("A");
    const gen = await request("POST", `/api/shipments/${A.id}/documents/generate`, { html: "<html><body>MBL</body></html>", filename: "MB01-x.html", docType: "MB01" }, token);
    assert("CargoDesk no longer builds a Master B/L itself (409)", gen.status === 409 && /carrier's document/.test(gen.body?.error), JSON.stringify(gen.body));
    const noPrint = await request("POST", `/api/shipments/${A.id}/master-bl/print`, {}, token);
    assert("nothing from the carrier's data to print yet (409)", noPrint.status === 409 && /upload its PDF/.test(noPrint.body?.error), JSON.stringify(noPrint.body));

    console.log("\nPaper originals: received → sent → surrendered → released");
    let v = await view(A.id);
    assert("paper, 3 originals, nothing recorded; first comes Received", v.form === "PAPER" && v.originalsTotal === 3 && v.stage === "" && v.next.map(x => x.step).join() === "RECEIVED",
      JSON.stringify({ form: v.form, o: v.originalsTotal, next: v.next }));
    let r = await step(A.id, { step: "SENT", on: yesterday, to: "New York Harbor" });
    assert("a step out of order is refused, saying what comes next (409)", r.status === 409 && /next is "Received from the carrier"/.test(r.body?.error), JSON.stringify(r.body));
    r = await step(A.id, { step: "RECEIVED", on: yesterday, count: 4 });
    assert("more originals than the set is refused (400)", r.status === 400 && /1 to 3/.test(r.body?.error), JSON.stringify(r.body));
    r = await step(A.id, { step: "RECEIVED", on: inDays(2), count: 3 });
    assert("a future date is refused (400)", r.status === 400 && /future/.test(r.body?.error), JSON.stringify(r.body));
    r = await step(A.id, { step: "RECEIVED", on: yesterday, count: 3, from: "Maersk Rotterdam", courier: "DHL 4012 8833 21" });
    assert("3 of 3 originals received", r.status === 201 && r.body.stage === "RECEIVED" && r.body.next.map(x => x.step).join() === "SENT,SURRENDERED", JSON.stringify(r.body?.next));
    r = await request("PUT", `/api/shipments/${A.id}/master-bl/custody`, { form: "EBL" }, token);
    assert("the form is fixed once a step is recorded (409)", r.status === 409, JSON.stringify(r.body));
    r = await step(A.id, { step: "SENT", on: yesterday });
    assert("Sent needs where to (400)", r.status === 400 && /to is required/.test(r.body?.error), JSON.stringify(r.body));
    r = await step(A.id, { step: "SENT", on: today, to: "US-USNYC-SI New York Harbor", courier: "DHL 7720 1149 06" });
    assert("sent to destination", r.status === 201 && r.body.stage === "SENT", JSON.stringify(r.body?.stage));
    r = await step(A.id, { step: "SURRENDERED", on: yesterday, to: "Maersk New York", count: 3 });
    assert("a step dated before the one before it is refused (400)", r.status === 400 && /not before the previous step/.test(r.body?.error), JSON.stringify(r.body));
    r = await step(A.id, { step: "SURRENDERED", on: today, to: "Maersk New York", count: 3 });
    assert("surrendered to the carrier at destination", r.status === 201 && r.body.events.slice(-1)[0].detail.kind === "destination", JSON.stringify(r.body?.events?.slice(-1)));
    r = await step(A.id, { step: "RELEASED", on: today, ref: "MNY-RL-55120" });
    assert("released by the carrier", r.status === 201 && r.body.released && r.body.path.every(p => p.done), JSON.stringify(r.body?.path));
    r = await step(A.id, { step: "RELEASED", on: today });
    assert("nothing comes after the release (409)", r.status === 409 && /already released/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", `/api/shipments/${A.id}/master-bl/custody/undo`, {}, token);
    assert("undoing needs a reason (400)", r.status === 400, JSON.stringify(r.body));
    r = await request("POST", `/api/shipments/${A.id}/master-bl/custody/undo`, { reason: "Recorded before the carrier confirmed" }, token);
    assert("undo: back to Surrendered, the release kept on record as undone", r.status === 200 && r.body.stage === "SURRENDERED" && !r.body.released
      && r.body.events.some(e => e.step === "RELEASED" && e.undone && e.undoReason === "Recorded before the carrier confirmed"), JSON.stringify(r.body?.events?.map(e => [e.step, e.undone])));
    r = await step(A.id, { step: "RELEASED", on: today, ref: "MNY-RL-55120" });
    assert("…and the release recorded again", r.status === 201 && r.body.released);
    const hist = list((await request("GET", `/api/shipments/${A.id}/events?limit=50`, null, token)).body).map(e => e.eventType || e.event_type);
    assert("each step is on the shipment's History", ["MASTER_BL_RECEIVED", "MASTER_BL_SENT", "MASTER_BL_SURRENDERED", "MASTER_BL_RELEASED", "MASTER_BL_STEP_UNDONE"].every(t => hist.includes(t)),
      JSON.stringify(hist.filter(t => /MASTER_BL/.test(t))));

    console.log("\nSurrendered at origin (telex release); eBL; sea waybill");
    const B = await shipment("B", { containers: 1 });
    await step(B.id, { step: "RECEIVED", on: yesterday, count: 3, from: "Maersk Rotterdam" });
    r = await step(B.id, { step: "SURRENDERED", on: yesterday, to: "Maersk Rotterdam" });
    assert("surrendered at origin, straight after receiving", r.status === 201 && r.body.events.slice(-1)[0].detail.kind === "origin"
      && r.body.path.map(p => p.step).join() === "RECEIVED,SURRENDERED,RELEASED", JSON.stringify(r.body?.path?.map(p => p.step)));
    const E = await shipment("E", { containers: 1 });
    r = await request("PUT", `/api/shipments/${E.id}/master-bl/custody`, { form: "EBL", eblPlatform: "WAVE BL" }, token);
    assert("an eBL", r.status === 200 && r.body.form === "EBL" && r.body.next.map(x => x.step).join() === "ISSUED", JSON.stringify(r.body?.next));
    r = await step(E.id, { step: "ISSUED", on: yesterday, platform: "WAVE BL" });
    assert("Issued needs the eBL's reference (400)", r.status === 400 && /reference/.test(r.body?.error), JSON.stringify(r.body));
    r = await step(E.id, { step: "ISSUED", on: yesterday, platform: "Not a platform", reference: "X" });
    assert("…and a known platform (400)", r.status === 400 && /platform/.test(r.body?.error), JSON.stringify(r.body));
    r = await step(E.id, { step: "ISSUED", on: yesterday, platform: "WAVE BL", reference: `WAVE-BL-${rand}`, issuedTo: "CargoDesk Logistics Rotterdam" });
    assert("issued on WAVE BL, its reference kept", r.status === 201 && r.body.ebl.reference === `WAVE-BL-${rand}`, JSON.stringify(r.body?.ebl));
    await step(E.id, { step: "TRANSFERRED", on: today, to: "New York Harbor (WAVE account)" });
    await step(E.id, { step: "SURRENDERED", on: today, to: "Maersk on WAVE BL" });
    r = await step(E.id, { step: "RELEASED", on: today });
    assert("…transferred, surrendered, released", r.status === 201 && r.body.released && r.body.path.map(p => p.step).join() === "ISSUED,TRANSFERRED,SURRENDERED,RELEASED");
    const W = await shipment("W", { containers: 1, masterBlReleaseType: "Seaway Bill" });
    v = await view(W.id);
    assert("a sea waybill (the shipment's Master release type): only the release", v.form === "SWB" && v.formSource === "release type" && v.next.map(x => x.step).join() === "RELEASED", JSON.stringify(v.next));
    r = await step(W.id, { step: "RECEIVED", on: today, count: 1 });
    assert("…nothing to receive (409)", r.status === 409, JSON.stringify(r.body));

    console.log("\nThe carrier's PDF, read");
    const P = await shipment("P");
    const mbl = `MAEU${String(Date.now()).slice(-9)}`;
    await request("PUT", `/api/shipments/${P.id}`, { masterBlNumber: mbl }, token);
    r = await request("POST", `/api/shipments/${P.id}/master-bl/pdf`, { data: Buffer.from("not a pdf").toString("base64"), filename: "x.pdf" }, token);
    assert("a file that isn't a PDF is refused (400)", r.status === 400, JSON.stringify(r.body));
    const spaced = c => `${c.slice(0, 4)} ${c.slice(4, 10)} ${c.slice(10)}`;
    r = await request("POST", `/api/shipments/${P.id}/master-bl/pdf`, { filename: `${mbl}_copy.pdf`,
      data: await textPdf(["BILL OF LADING", `B/L No. ${mbl}`, "Vessel MAERSK KENSINGTON", ...P.containers.map(c => `Container ${spaced(c)} 40HC`)]) }, token);
    const chk = r.body?.pdf?.check;
    assert("a PDF naming the number, both containers (written with spaces) and the vessel: all found", r.status === 201 && chk?.readable && chk.ok
      && chk.blNumber.found && chk.containers.every(c => c.found) && chk.vessel.found, JSON.stringify(chk));
    const docs = list((await request("GET", `/api/shipments/${P.id}/documents`, null, token)).body);
    assert("…saved to Documents as MB01", docs.some(d => d.docType === "MB01" && d.id === r.body.pdf.documentId), JSON.stringify(docs.map(d => [d.docType, d.filename])));
    r = await request("POST", `/api/shipments/${P.id}/master-bl/pdf`, { filename: "wrong.pdf",
      data: await textPdf([`B/L No. ${mbl}`, "Vessel MAERSK KENSINGTON", `Container ${P.containers[0]}`, "Container MSKU7743299"]) }, token);
    const bad = r.body?.pdf?.check;
    assert("a PDF missing a container and naming another: not ok, both said", r.status === 201 && bad && !bad.ok && bad.others.includes("MSKU7743299")
      && bad.containers.find(c => c.number === P.containers[1])?.found === false, JSON.stringify(bad));
    r = await request("POST", `/api/shipments/${P.id}/master-bl/pdf`, { filename: "scan.pdf", data: await scanPdf() }, token);
    const scan = r.body?.pdf?.check;
    assert("a scan has no text: unreadable, to check by eye", r.status === 201 && scan && !scan.readable && !scan.ok, JSON.stringify(scan));
    const items = [`blNumber:${mbl}`, ...P.containers.map(c => `container:${c}`), "vessel:MAERSK KENSINGTON"];
    r = await request("POST", `/api/shipments/${P.id}/master-bl/pdf/check`, { byEye: Object.fromEntries(items.map(k => [k, true])) }, token);
    assert("…every item ticked by eye: checked", r.status === 200 && r.body.pdf.check.byEye.complete && r.body.pdf.check.ok, JSON.stringify(r.body?.pdf?.check?.byEye));

    console.log("\nPrinted from the carrier's data");
    const D = await shipment("D", { book: true });
    await request("PUT", `/api/shipments/${D.id}/shipping-instructions`, { siCutoff: `${inDays(2)}T12:00`, specialInstructions: "Shipper's load, stow and count" }, token);
    const sub = await request("POST", `/api/shipments/${D.id}/shipping-instructions/submit`, {}, token);
    const siRef = sub.body?.shippingInstructions?.siReference;
    for (let i = 0; i < 30 && (await request("GET", `/api/shipments/${D.id}/shipping-instructions`, null, token)).body?.carrierState !== "RECEIVED"; i++) await sleep(200);
    const carrierSi = action => request("POST", `/api/test-tools/dcsa-sim/shipping-instructions/${siRef}/${action}`, {}, token);
    await carrierSi("draft");
    for (let i = 0; i < 30 && !(await request("GET", `/api/shipments/${D.id}/master-bl`, null, token)).body?.status; i++) await sleep(200);
    v = await view(D.id);
    assert("a draft at the carrier: shown as pending, not printable yet", !!v.pending && !v.master && !v.canPrint, JSON.stringify({ pending: v.pending, canPrint: v.canPrint }));
    await request("POST", `/api/shipments/${D.id}/master-bl/approve`, {}, token);
    await carrierSi("issue");
    for (let i = 0; i < 30 && (await request("GET", `/api/shipments/${D.id}/master-bl`, null, token)).body?.status !== "ISSUED"; i++) await sleep(200);
    v = await view(D.id);
    assert("issued: the carrier's document, its parties and containers, printable", !!v.master && v.canPrint && v.master.containers.length === 2
      && v.number === v.master.reference && v.form === "PAPER", JSON.stringify({ m: v.master && { ref: v.master.reference, ctrs: v.master.containers.length }, number: v.number, form: v.form }));
    r = await request("POST", `/api/shipments/${D.id}/master-bl/print`, {}, token);
    assert("printed: an MB01 copy on Documents", r.status === 201 && !!r.body.print?.documentId, JSON.stringify(r.body?.print || r.body));
    if (r.body?.print?.documentId) {
      const pdf = Buffer.from(await (await fetch(`${BASE}/api/shipments/${D.id}/documents/${r.body.print.documentId}/download`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer());
      const { pdfText } = require("../lib/carrier-mbl.js");
      const { text, pages } = await pdfText(pdf);
      assert("…marked COPY · NOT NEGOTIABLE, with its number, its containers and the carrier's terms on the next page",
        /COPY · NOT NEGOTIABLE/.test(text) && text.includes(v.master.reference) && D.containers.every(c => text.includes(c)) && pages >= 2 && /terms and conditions/i.test(text),
        JSON.stringify({ pages, sample: text.slice(0, 160) }));
    }

    // ── The pre-release audit's fixes (TKT-GC05AS, 2026-11-12) ──
    console.log("\nThe import side: the destination steps, never the export side's (C1)");
    // A temporary import-office OCC/BK account (removed at the end).
    const impEmail = `mbl.import.${rand.toLowerCase()}@cargodesk.example`;
    const impUser = await request("POST", "/api/users", { email: impEmail, name: "MBL import desk", roles: ["occ_bk"], password: "AuditFixture!2026Zq" }, token);
    cleanup.user = impUser.body?.id || null;
    await request("POST", `/api/users/${impUser.body?.id}/offices`, { officeId: imoOfficeId }, token);
    const imp = (await request("POST", "/api/auth/login", { email: impEmail, password: "AuditFixture!2026Zq" })).body?.token;
    const IH = { "X-Office-Id": imoOfficeId };
    const I = await shipment("I");
    assert("(setup) the import desk sees the shipment from the import side", (await request("GET", `/api/shipments/${I.id}`, null, imp, IH)).body?.myOfficeSide === "import");
    await step(I.id, { step: "RECEIVED", on: today, count: 3, from: "Maersk Rotterdam", courier: "DHL 4471 0921 55" });
    r = await request("POST", `/api/shipments/${I.id}/master-bl/custody/undo`, { reason: "Not ours to undo" }, imp, IH);
    assert("it can't undo the export desk's 'Received from the carrier' (403)", r.status === 403 && /export-side/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", `/api/shipments/${I.id}/master-bl/pdf/check`, { byEye: {} }, imp, IH);
    assert("…nor check the carrier's PDF (403)", r.status === 403, JSON.stringify(r.body));
    r = await request("POST", `/api/shipments/${I.id}/master-bl/custody/steps`, { step: "SENT", on: today, to: "New York Harbor" }, imp, IH);
    assert("…nor send it on (403)", r.status === 403, JSON.stringify(r.body));
    await step(I.id, { step: "SENT", on: today, to: "New York Harbor", courier: "DHL 4471 0921 77" });
    v = await view(I.id);
    assert("the steps say which side they belong to", v.events.find(e => e.step === "SENT")?.atOrigin === true && v.next.find(n => n.step === "SURRENDERED")?.atOrigin === false,
      JSON.stringify({ events: v.events.map(e => [e.step, e.atOrigin]), next: v.next }));
    r = await request("POST", `/api/shipments/${I.id}/master-bl/custody/steps`, { step: "SURRENDERED", on: today, count: 3, to: "Maersk New York" }, imp, IH);
    assert("the import desk surrenders the originals at destination (201)", r.status === 201 && r.body.stage === "SURRENDERED", JSON.stringify(r.body?.error || r.body?.stage));
    r = await request("POST", `/api/shipments/${I.id}/master-bl/custody/undo`, { reason: "Surrendered to the wrong desk" }, imp, IH);
    assert("…and may undo its own step (200)", r.status === 200 && r.body.stage === "SENT", JSON.stringify(r.body?.error || r.body?.stage));
    await request("POST", `/api/shipments/${I.id}/master-bl/custody/steps`, { step: "SURRENDERED", on: today, count: 3, to: "Maersk New York" }, imp, IH);
    r = await request("POST", `/api/shipments/${I.id}/master-bl/custody/steps`, { step: "RELEASED", on: today, ref: "MNY-REL-55102" }, imp, IH);
    assert("…and records the carrier's release (201)", r.status === 201 && r.body.released, JSON.stringify(r.body?.error || r.body?.stage));

    console.log("\nA replaced or removed PDF (C5, C6)");
    const R = await shipment("R");
    const docsOf = async id => list((await request("GET", `/api/shipments/${id}/documents`, null, token)).body).filter(d => d.docType === "MB01");
    const first = (await request("POST", `/api/shipments/${R.id}/master-bl/pdf`, { filename: "MAEU-scan-1.pdf", data: await scanPdf() }, token)).body?.pdf?.documentId;
    const second = (await request("POST", `/api/shipments/${R.id}/master-bl/pdf`, { filename: "MAEU-scan-2.pdf", data: await scanPdf() }, token)).body?.pdf?.documentId;
    let mb = await docsOf(R.id);
    assert("replacing the carrier's PDF voids the earlier one", mb.find(d => d.id === first)?.status === "voided" && mb.find(d => d.id === second)?.status === "confirmed",
      JSON.stringify(mb.map(d => [d.filename, d.status])));
    const docHist = (await request("GET", `/api/entity-events/document/${first}`, null, token)).body;
    assert("…saying by what, in the document's history", list(docHist).some(e => e.eventType === "VOIDED" && /Replaced by MAEU-scan-2\.pdf/.test(JSON.stringify(e)))
      && list(docHist).some(e => e.eventType === "GENERATED"), JSON.stringify(docHist).slice(0, 300));
    r = await request("DELETE", `/api/shipments/${R.id}/documents/${second}`, null, token);
    v = await view(R.id);
    assert("deleting the panel's PDF from Documents: the panel lets go of it and its check", r.status === 200 && v.pdf === null, JSON.stringify(v.pdf));
    const third = (await request("POST", `/api/shipments/${R.id}/master-bl/pdf`, { filename: "MAEU-scan-3.pdf", data: await scanPdf() }, token)).body?.pdf?.documentId;
    await request("PATCH", `/api/shipments/${R.id}/documents/${third}`, { status: "voided", voidReason: "The carrier sent the wrong B/L" }, token);
    v = await view(R.id);
    assert("…and of one voided there", v.pdf === null, JSON.stringify(v.pdf));

    console.log("\nOpen on a Completed shipment, for the record (C4)");
    const printedBefore = (await view(D.id)).print?.documentId;
    const done = await request("PUT", `/api/shipments/${D.id}`, { status: "Completed" }, token);
    assert("(setup) the shipment is Completed", done.status === 200, JSON.stringify(done.body).slice(0, 200));
    r = await request("POST", `/api/shipments/${D.id}/master-bl/print`, {}, token);
    assert("the carrier's B/L can still be printed (201)…", r.status === 201 && !!r.body.print?.documentId && r.body.print.documentId !== printedBefore, JSON.stringify(r.body?.error || r.body?.print));
    mb = await docsOf(D.id);
    assert("…and the earlier copy is voided", mb.find(d => d.id === printedBefore)?.status === "voided", JSON.stringify(mb.map(d => [d.filename, d.status])));
    r = await request("POST", `/api/shipments/${D.id}/master-bl/pdf`, { filename: "MAEU-original-scan.pdf", data: await scanPdf() }, token);
    assert("its PDF uploaded (201)", r.status === 201, JSON.stringify(r.body?.error));
    r = await step(D.id, { step: "RECEIVED", on: today, count: 3, from: "Maersk Rotterdam" });
    assert("a step recorded (201)", r.status === 201, JSON.stringify(r.body?.error));
    r = await request("POST", `/api/shipments/${D.id}/master-bl/custody/undo`, { reason: "Recorded twice" }, token);
    assert("…and undone (200)", r.status === 200, JSON.stringify(r.body?.error));
    r = await request("PUT", `/api/shipments/${D.id}/master-bl/custody`, { form: "SWB" }, token);
    assert("the form stays locked (409 SHIPMENT_LOCKED)", r.status === 409 && r.body?.code === "SHIPMENT_LOCKED", JSON.stringify(r.body));

    console.log("\nStep dates in the user's day (C8)");
    const T = await shipment("T");
    const utcTomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    r = await step(T.id, { step: "RECEIVED", on: utcTomorrow, count: 3 });
    assert("a day ahead of UTC is someone's today east of Greenwich (201)", r.status === 201, JSON.stringify(r.body));

    console.log("\nThe House B/L's release notes a Master the carrier hasn't released");
    const H = await readyHouseBlShipment(request, token, { tag: "MB", emoOfficeId: office.id });
    await assignHouseBlNumber(request, token, H.shipment.id);
    const hbl = await generateHouseBl(request, token, H.shipment.id, { name: "MBL" });
    const issued = await request("PATCH", `/api/shipments/${H.shipment.id}/documents/${hbl.body?.id}`, { status: "confirmed" }, token);
    assert("(setup) a House B/L issued", issued.status === 200, JSON.stringify(issued.body).slice(0, 200));
    await request("PUT", `/api/shipments/${H.shipment.id}`, { masterBlNumber: `MAEU${String(Date.now()).slice(-9)}` }, token);
    let hb = (await request("GET", `/api/shipments/${H.shipment.id}/house-bl`, null, token)).body;
    assert("its release notes the carrier hasn't released the Master (not a block)", hb.release?.warnings?.some(w => w.key === "master_bl" && /hasn't released/.test(w.message))
      && !hb.release.blocks.some(b => b.key === "master_bl"), JSON.stringify(hb.release));
    await step(H.shipment.id, { step: "RECEIVED", on: today, count: 3, from: "Maersk Rotterdam" });
    await step(H.shipment.id, { step: "SURRENDERED", on: today, to: "Maersk Rotterdam" });
    await step(H.shipment.id, { step: "RELEASED", on: today, ref: "MRT-TLX-88231" });
    hb = (await request("GET", `/api/shipments/${H.shipment.id}/house-bl`, null, token)).body;
    assert("…and no longer once the carrier released it", (hb.release?.warnings || []).length === 0, JSON.stringify(hb.release));
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    // The office and its legal entity decide other shipments' offices (resolver rows): retired. The shipments, their
    // documents and custody stay as verification data.
    console.log("\nCleanup");
    // The temporary import-desk account (a known password) goes.
    if (cleanup.user) console.log(`  user: ${(await request("DELETE", `/api/users/${cleanup.user}`, null, token)).status}`);
    if (cleanup.office) console.log(`  office: ${await retireOffice(token, cleanup.office)}`);
    if (cleanup.branch) console.log(`  branch: ${await retireBranch(token, cleanup.branch)}`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
