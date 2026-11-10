/**
 * The House B/L's terms and conditions (2026-11-10, lib/bl-terms.js, ARCHITECTURE.md §8.48):
 *   - Organisation → B/L Terms: the organisation's English starter text (never issued, never removed); per legal entity
 *     and language a new version per save, the text required (≤ 50,000 characters), a PDF optional and kept unless
 *     replaced or removed; a language that stops being offered keeps its versions;
 *   - an office's default terms (BRANCH:/ORG: + language), checked against what its entity has;
 *   - the House B/L: the choices and the default on GET …/house-bl; the face then the terms from a new page (page
 *     count); the starter text drafted but never issued; the issued B/L keeping its version; the eBL's
 *     termsAndConditions = the text; an amendment keeping the original's terms.
 *
 * Usage:
 *   node tests/bl-terms.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001 (+ pdf-render on :3003), not in production (the built-in DCSA carrier confirms)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { createRequire } from "node:module";
import { readyHouseBlShipment, generateHouseBl, assignHouseBlNumber } from "./helpers/house-bl.mjs";
import { retireOffice } from "./helpers/offices.mjs";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require("pdf-lib");
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
// A PDF of `pages` A4 pages, as a lawyer's terms file would be.
async function pdfBase64(pages, heading) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) d.addPage([595.28, 841.89]).drawText(`${heading} ${i + 1}/${pages}`, { x: 50, y: 780, size: 12, font: f });
  return Buffer.from(await d.save()).toString("base64");
}
const NL_TEXT = "1. Definities\n“Vervoerder” is de vennootschap die op de voorzijde van dit cognossement als vervoerder is vermeld.\n\n"
  + "2. Recht en forum\nOp dit cognossement is Nederlands recht van toepassing; geschillen worden voorgelegd aan de rechtbank Rotterdam.";

(async () => {
  const cleanup = { offices: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const house = async id => (await request("GET", `/api/shipments/${id}/house-bl`, null, token)).body;
    const pdfOf = async (shipmentId, docId) => {
      const res = await fetch(`${BASE}/api/shipments/${shipmentId}/documents/${docId}/download`, { headers: { Authorization: `Bearer ${token}` } });
      return PDFDocument.load(new Uint8Array(await res.arrayBuffer()), { ignoreEncryption: true });
    };
    const pagesOf = async (shipmentId, docId) => (await pdfOf(shipmentId, docId)).getPageCount();
    // Every page the same paper size: the terms follow the face's (an A4 PDF is scaled into a Letter face).
    const sizesOf = async (shipmentId, docId) => [...new Set((await pdfOf(shipmentId, docId)).getPages()
      .map(p => p.getSize()).map(s => `${Math.round(s.width)}x${Math.round(s.height)}`))];

    // A scratch export office: the House B/L helper gives it its own legal entity (SCAC, address) and English terms.
    const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
    const office = await request("POST", "/api/offices", { unlocode: `NL${letters}`, countryCode: "NL", department: "SE", name: `Export Terms ${letters}` }, token);
    assert("(setup) a scratch export office", office.status === 201, JSON.stringify(office.body));
    cleanup.offices.push(office.body.id);
    const a = await readyHouseBlShipment(request, token, { tag: "TA", emoOfficeId: office.body.id });
    const branchId = (await request("GET", "/api/offices", null, token)).body.find(o => o.id === office.body.id)?.branchId;
    assert("(setup) the office has its legal entity", !!branchId, String(branchId));

    console.log("\nThe organisation default");
    let list = (await request("GET", "/api/bl-terms", null, token)).body;
    const org = list.sets.find(s => s.branchId === null);
    const orgEn = org?.docs.find(d => d.language === "en");
    assert("the organisation's English terms exist, as CargoDesk's starter text", !!orgEn && orgEn.isStarter && orgEn.chars > 500, JSON.stringify(orgEn && { v: orgEn.version, starter: orgEn.isStarter }));
    const noRemove = await request("DELETE", "/api/bl-terms/org/en", null, token);
    assert("…and can't be removed: they are the last fallback (409)", noRemove.status === 409, JSON.stringify(noRemove.body));
    const notAdmin = await fetch(`${BASE}/api/bl-terms`);
    assert("the terms list needs a login", notAdmin.status === 401, String(notAdmin.status));

    console.log("\nSaving terms: validation and versions");
    const post = body => request("POST", "/api/bl-terms", { branchId, ...body }, token);
    let r = await post({ language: "dutch", text: NL_TEXT });
    assert("a language that isn't an ISO code is refused (400)", r.status === 400 && /ISO 639/.test(r.body?.error), JSON.stringify(r.body));
    r = await post({ language: "nl", text: "   " });
    assert("terms without text are refused: the eBL carries the text (400)", r.status === 400 && /text is required/.test(r.body?.error), JSON.stringify(r.body));
    r = await post({ language: "nl", text: "x".repeat(50001) });
    assert("text over 50,000 characters is refused (400)", r.status === 400 && /50,000/.test(r.body?.error), JSON.stringify(r.body));
    r = await post({ language: "nl", text: NL_TEXT, pdfBase64: Buffer.from("not a pdf at all").toString("base64"), pdfFilename: "x.pdf" });
    assert("a file that isn't a PDF is refused (400)", r.status === 400 && /isn't a PDF/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", "/api/bl-terms", { branchId: "BRN-NOSUCH", language: "nl", text: NL_TEXT }, token);
    assert("an unknown legal entity is refused (404)", r.status === 404, JSON.stringify(r.body));
    const v1 = await post({ language: "nl", title: "Algemene voorwaarden van het house-cognossement", text: NL_TEXT,
      pdfBase64: await pdfBase64(2, "Algemene voorwaarden"), pdfFilename: "cognossementsvoorwaarden.pdf" });
    assert("Dutch terms with a 2-page PDF: version 1", v1.status === 201 && v1.body.doc.version === 1 && v1.body.doc.hasPdf && v1.body.doc.pdfPages === 2
      && v1.body.doc.key === "BRANCH:nl", JSON.stringify(v1.body));
    const v2 = await post({ language: "nl", text: `${NL_TEXT}\n\n3. Retentierecht\nDe vervoerder heeft een retentierecht.` });
    assert("a new text keeps the PDF: version 2", v2.status === 201 && v2.body.doc.version === 2 && v2.body.doc.hasPdf && v2.body.doc.pdfPages === 2, JSON.stringify(v2.body));
    const v3 = await post({ language: "nl", text: NL_TEXT, keepPdf: false });
    assert("…removing the PDF: version 3 is text only", v3.status === 201 && v3.body.doc.version === 3 && !v3.body.doc.hasPdf, JSON.stringify(v3.body));
    const v4 = await post({ language: "nl", title: "Algemene voorwaarden van het house-cognossement", text: NL_TEXT,
      pdfBase64: await pdfBase64(2, "Algemene voorwaarden"), pdfFilename: "cognossementsvoorwaarden-2026.pdf" });
    assert("…and a PDF again: version 4", v4.status === 201 && v4.body.doc.version === 4 && v4.body.doc.pdfPages === 2, JSON.stringify(v4.body));
    list = (await request("GET", "/api/bl-terms", null, token)).body;
    const mine = list.sets.find(s => s.branchId === branchId);
    assert("the entity lists English and Dutch, the four Dutch versions kept", mine?.docs.map(d => d.language).sort().join() === "en,nl"
      && mine.versions.filter(v => v.language === "nl").length === 4 && mine.docs.find(d => d.language === "nl")?.text === NL_TEXT,
      JSON.stringify(mine && { docs: mine.docs.map(d => [d.language, d.version]), versions: mine.versions.length }));
    const pdfRes = await fetch(`${BASE}/api/bl-terms/${v4.body.doc.id}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
    assert("a version's PDF can be opened", pdfRes.status === 200 && (pdfRes.headers.get("content-type") || "").includes("pdf"), String(pdfRes.status));

    console.log("\nThe office's default terms");
    r = await request("PUT", `/api/offices/${office.body.id}`, { blTermsDefault: "BRANCH:de" }, token);
    assert("a language its entity has no terms in is refused (400)", r.status === 400 && /no German terms/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("PUT", `/api/offices/${office.body.id}`, { blTermsDefault: "Dutch please" }, token);
    assert("…so is a value that isn't BRANCH:/ORG: + a language (400)", r.status === 400, JSON.stringify(r.body));
    r = await request("PUT", `/api/offices/${office.body.id}`, { blTermsDefault: "BRANCH:nl" }, token);
    assert("Dutch, its entity's, becomes the office's default", r.status === 200 && r.body.blTermsDefault === "BRANCH:nl", JSON.stringify(r.body?.blTermsDefault ?? r.body));
    const opts = (await request("GET", `/api/bl-terms/options?officeId=${office.body.id}`, null, token)).body;
    assert("the office can carry its entity's English and Dutch and the organisation's English; Dutch is the default",
      ["BRANCH:en", "BRANCH:nl", "ORG:en"].every(k => opts.options.some(o => o.key === k)) && opts.defaultKey === "BRANCH:nl",
      JSON.stringify({ keys: opts.options?.map(o => o.key), def: opts.defaultKey }));

    console.log("\nThe House B/L: choices, starter text, the print");
    let h = await house(a.shipment.id);
    assert("GET house-bl offers the terms and starts with the office's default", h.terms?.defaultKey === "BRANCH:nl" && h.terms.options.length >= 3
      && !h.readiness.missing.some(m => /^Terms and conditions/.test(m)), JSON.stringify({ def: h.terms?.defaultKey, missing: h.readiness?.missing }));
    const unknown = await generateHouseBl(request, token, a.shipment.id, { name: "FR", houseBl: { termsKey: "BRANCH:fr" } });
    assert("terms not on file can't be printed (400)", unknown.status === 400 && /aren't on file/.test(unknown.body?.error), JSON.stringify(unknown.body));
    const starter = await generateHouseBl(request, token, a.shipment.id, { name: "ST", houseBl: { termsKey: "ORG:en" } });
    assert("a draft on the organisation's starter text can be made (to show the shipper)", starter.status === 201, JSON.stringify(starter.body));
    h = await house(a.shipment.id);
    assert("…its readiness says the starter text can't be issued", h.draft?.termsId === orgEn.id && h.readiness.missing.some(m => /starter text/.test(m)),
      JSON.stringify(h.readiness?.missing));
    const refused = await request("PATCH", `/api/shipments/${a.shipment.id}/documents/${starter.body.id}`, { status: "confirmed" }, token);
    assert("…and issuing it is refused (409)", refused.status === 409 && /starter text/.test(refused.body?.error), JSON.stringify(refused.body));
    const nlDraft = await generateHouseBl(request, token, a.shipment.id, { name: "NL", houseBl: { termsKey: "BRANCH:nl" } });
    assert("a draft with the Dutch terms", nlDraft.status === 201, JSON.stringify(nlDraft.body));
    assert("…prints the face, then the 2-page terms PDF: 3 pages", await pagesOf(a.shipment.id, nlDraft.body.id) === 3, String(await pagesOf(a.shipment.id, nlDraft.body.id)));
    const nlSizes = await sizesOf(a.shipment.id, nlDraft.body.id);
    assert("…all one paper size: the A4 terms PDF scaled into the face's", nlSizes.length === 1, JSON.stringify(nlSizes));
    h = await house(a.shipment.id);
    const dcsa = (await request("GET", `/api/shipments/${a.shipment.id}/house-bl/${h.draft.id}/dcsa`, null, token)).body;
    assert("…and its DCSA document carries the Dutch text as termsAndConditions", dcsa.document?.termsAndConditions === NL_TEXT && !dcsa.errors,
      JSON.stringify({ t: String(dcsa.document?.termsAndConditions).slice(0, 40), errors: dcsa.errors }));

    console.log("\nIssued: the version stays");
    await assignHouseBlNumber(request, token, a.shipment.id);
    const final = await generateHouseBl(request, token, a.shipment.id, { name: "FINAL", houseBl: { termsKey: "BRANCH:nl" } });
    const issued = await request("PATCH", `/api/shipments/${a.shipment.id}/documents/${final.body.id}`, { status: "confirmed" }, token);
    assert("the House B/L issues with the Dutch terms", issued.status === 200, JSON.stringify(issued.body));
    h = await house(a.shipment.id);
    assert("…the issued B/L records version 4", h.live?.termsId === v4.body.doc.id && h.terms.issued?.version === 4, JSON.stringify({ t: h.live?.termsId, issued: h.terms?.issued }));
    const v5 = await post({ language: "nl", text: `${NL_TEXT}\n\n3. Toevoeging\nNieuwe bepaling.` });
    h = await house(a.shipment.id);
    assert("a newer Dutch version (5) leaves the issued B/L on version 4", v5.body?.doc?.version === 5 && h.terms.issued?.version === 4, JSON.stringify(h.terms?.issued));
    list = (await request("GET", "/api/bl-terms", null, token)).body;
    assert("…and version 4 counts the House B/L issued on it", list.sets.find(s => s.branchId === branchId)?.versions.find(v => v.id === v4.body.doc.id)?.issuedCount === 1);

    console.log("\nAn amendment keeps the original's terms");
    const amend = await request("POST", `/api/shipments/${a.shipment.id}/house-bl/surrender-for-amendment`, { reason: "Notify party changed" }, token);
    assert("surrendered for amendment", amend.status === 200, JSON.stringify(amend.body));
    h = await house(a.shipment.id);
    assert("…the panel shows the terms as kept from version 1 (Dutch v4)", h.terms?.locked?.id === v4.body.doc.id, JSON.stringify(h.terms?.locked));
    await generateHouseBl(request, token, a.shipment.id, { name: "V2", houseBl: { termsKey: "BRANCH:en" } });
    h = await house(a.shipment.id);
    assert("…and the version 2 draft prints them, whatever was asked", h.draft?.version === 2 && h.draft.termsId === v4.body.doc.id, JSON.stringify({ v: h.draft?.version, t: h.draft?.termsId }));

    console.log("\nText-only terms print as pages; a language stops being offered");
    r = await request("PUT", `/api/offices/${office.body.id}`, { blTermsDefault: "" }, token);
    assert("with no default set, the office starts with English: its entity's", r.status === 200
      && (await request("GET", `/api/bl-terms/options?officeId=${office.body.id}`, null, token)).body.defaultKey === "BRANCH:en", JSON.stringify(r.body?.blTermsDefault));
    const b = await readyHouseBlShipment(request, token, { tag: "TB", emoOfficeId: office.body.id });
    const enDraft = await generateHouseBl(request, token, b.shipment.id, { name: "EN" });
    const enPages = enDraft.status === 201 ? await pagesOf(b.shipment.id, enDraft.body.id) : 0;
    assert("a draft with the English text-only terms: the face and at least one page of terms", enDraft.status === 201 && enPages >= 2, `${enDraft.status} ${enPages}`);
    const enSizes = enDraft.status === 201 ? await sizesOf(b.shipment.id, enDraft.body.id) : [];
    assert("…the text set in the face's paper size", enSizes.length === 1, JSON.stringify(enSizes));
    await request("PUT", `/api/offices/${office.body.id}`, { blTermsDefault: "BRANCH:nl" }, token);
    const gone = await request("DELETE", `/api/bl-terms/${branchId}/nl`, null, token);
    const after = (await request("GET", `/api/bl-terms/options?officeId=${office.body.id}`, null, token)).body;
    assert("Dutch no longer offered: gone from the choices, the office falls back to English", gone.status === 200 && !after.options.some(o => o.key === "BRANCH:nl")
      && after.defaultKey === "BRANCH:en" && after.officeDefaultValid === false, JSON.stringify({ gone: gone.body, def: after.defaultKey }));
    h = await house(a.shipment.id);
    assert("…while the issued B/L still shows its Dutch version 4", h.terms?.locked?.version === 4 || h.terms?.issued?.version === 4, JSON.stringify(h.terms?.locked));
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    console.log("\nCleanup");
    // The office decides other records' managing offices (a resolver row): its default is cleared and it is retired.
    // Its shipments, entity and terms stay as verification data.
    for (const id of cleanup.offices) {
      await request("PUT", `/api/offices/${id}`, { blTermsDefault: "" }, token).catch(() => {});
      console.log(`  office ${id}: ${await retireOffice(token, id)}`);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
