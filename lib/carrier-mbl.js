"use strict";

// ─── The carrier's Master B/L, as sent to the forwarder (2026-11-10, mockup ceca35b0, ARCHITECTURE.md §8.49) ────────
// The carrier issues its Master B/L to the forwarder in one of four forms, and the forwarder keeps it until the carrier
// releases the cargo:
//   - from the carrier's data: the issued DCSA transport document (routes/master-bl.js, transport_documents
//     role 'MASTER') printed word for word as a copy, marked COPY · NOT NEGOTIABLE, with the carrier's own terms;
//   - the carrier's PDF, uploaded and read (pdf.js) for the B/L number, the containers and the vessel; a scan with no
//     text is checked by eye;
//   - paper originals: received from the carrier → sent to destination → surrendered to the carrier → released; or
//     received → surrendered at origin (telex release) → released;
//   - an eBL on a platform (WAVE BL, CargoX, …), tracked, not connected: issued to you → transferred to destination →
//     surrendered to the carrier → released, each step marked by hand.
// A sea waybill has nothing to surrender: only the carrier's release is recorded. Both MB01 copies are documents of
// type MB01; CargoDesk no longer builds a Master B/L of its own from the shipment (POST …/documents/generate refuses
// MB01). The House B/L's release at destination warns, without blocking, while the carrier hasn't released.

const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

const FORMS = ["PAPER", "EBL", "SWB"];
const PLATFORMS = ["WAVE BL", "CargoX", "essDOCS", "Bolero", "edoxOnline", "IQAX eBL", "Other"];
const STEP_LABEL = {
  RECEIVED: "Received from the carrier", SENT: "Sent to destination", ISSUED: "Issued to you", TRANSFERRED: "Transferred to destination",
  SURRENDERED: "Surrendered to the carrier", RELEASED: "Released by the carrier",
};
// What may follow what, per form ('' = nothing recorded yet). Skipping SENT (paper) or TRANSFERRED (eBL) means the
// forwarder surrendered it at origin itself (a telex release on paper).
const NEXT = {
  PAPER: { "": ["RECEIVED"], RECEIVED: ["SENT", "SURRENDERED"], SENT: ["SURRENDERED"], SURRENDERED: ["RELEASED"], RELEASED: [] },
  EBL: { "": ["ISSUED"], ISSUED: ["TRANSFERRED", "SURRENDERED"], TRANSFERRED: ["SURRENDERED"], SURRENDERED: ["RELEASED"], RELEASED: [] },
  SWB: { "": ["RELEASED"], RELEASED: [] },
};
// Which steps happen at origin, and so are the export side's to record or undo (the pre-release audit, C1,
// 2026-11-12): receiving, sending on, the eBL issued to you and transferred, and a surrender at origin. The
// surrender at destination and the carrier's release are either side's. `kind` is a recorded surrender's,
// `stage` the stage a new step follows.
const ORIGIN_STEPS = ["RECEIVED", "SENT", "ISSUED", "TRANSFERRED"];
const isOriginStep = (step, { kind = "", stage = "" } = {}) =>
  ORIGIN_STEPS.includes(step) || (step === "SURRENDERED" && (kind ? kind === "origin" : ["RECEIVED", "ISSUED"].includes(stage)));
// The carrier's transport document is issued (or past it) in these states.
const ISSUED_STATES = ["ISSUED", "PENDING_SURRENDER_FOR_AMENDMENT", "SURRENDERED_FOR_AMENDMENT", "PENDING_SURRENDER_FOR_DELIVERY", "SURRENDERED_FOR_DELIVERY"];
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const CONTAINER_RE = /\b([A-Z]{3}[UJZ])\s?(\d{6})\s?-?\s?(\d)\b/g;

const parse = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const compact = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// The latest date a step may carry: the request doesn't say the user's time zone, so a day ahead of UTC lets a user
// east of Greenwich record "today" before UTC midnight (the pre-release audit, C8).
const latestDay = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10);
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const fmtDay = d => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "");

// The PDF's text, every page, with pdf.js (ESM, loaded once).
let pdfjsP = null;
async function pdfText(buf) {
  pdfjsP ||= import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = await pdfjsP;
  const standardFontDataUrl = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, standardFontDataUrl, verbosity: 0 }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) text += `${(await (await doc.getPage(i)).getTextContent()).items.map(t => t.str).join(" ")}\n`;
  await doc.destroy();
  return { text, pages: doc.numPages };
}

function createCarrierMbl(ctx) {
  const { query, uid, UPLOADS_DIR, logEvent, logEntityEvent } = ctx;
  const nowIso = () => new Date().toISOString();
  const actorOf = user => user?.name || user?.email || "";

  const rowOf = async shipmentId => (await query("SELECT * FROM master_bl_custody WHERE shipment_id=$1", [shipmentId]))[0] || null;
  async function ensureRow(shipmentId) {
    await query("INSERT INTO master_bl_custody (shipment_id, updated_at) VALUES ($1,$2) ON CONFLICT (shipment_id) DO NOTHING", [shipmentId, nowIso()]);
    return rowOf(shipmentId);
  }
  const masterOf = async shipmentId => (await query(
    "SELECT * FROM transport_documents WHERE shipment_id=$1 AND role='MASTER' ORDER BY created_at DESC LIMIT 1", [shipmentId]))[0] || null;
  const eventsOf = async shipmentId => query("SELECT * FROM master_bl_custody_events WHERE shipment_id=$1 ORDER BY created_at, id", [shipmentId]);
  const live = evs => evs.filter(e => !e.undone_at);
  const stageOf = evs => live(evs).slice(-1)[0]?.step || "";

  // The form: what the record says, else what the carrier's issued document says, else the shipment's Master B/L
  // release type (a Seaway Bill has nothing to surrender), else paper.
  const issuedTd = td => (td && ISSUED_STATES.includes(td.status) ? td : null);
  function formOf(row, td, s) {
    if (row?.form) return { form: row.form, source: "set" };
    const t = issuedTd(td);
    if (t) return { form: t.is_electronic ? "EBL" : t.type_code === "SWB" ? "SWB" : "PAPER", source: "carrier" };
    return { form: s?.master_bl_release_type === "Seaway Bill" ? "SWB" : "PAPER", source: s?.master_bl_release_type ? "release type" : "default" };
  }
  function originalsOf(row, td) {
    if (Number.isInteger(row?.originals_total) && row.originals_total > 0) return row.originals_total;
    const doc = parse(td?.payload);
    const n = (Number(doc?.numberOfOriginalsWithCharges) || 0) + (Number(doc?.numberOfOriginalsWithoutCharges) || 0);
    return n > 0 ? n : 3;
  }
  // The Master B/L number: the shipment's (Conditions), else the carrier's document's reference.
  const numberOf = (s, td) => s?.master_bl_number || issuedTd(td)?.reference || "";

  // Does this shipment have a carrier's Master B/L to keep track of? (an issued transport document, a number, a record)
  async function applies(shipmentId) {
    const [s] = await query("SELECT master_bl_number FROM shipments WHERE id=$1", [shipmentId]);
    return !!(s?.master_bl_number || issuedTd(await masterOf(shipmentId)) || (await eventsOf(shipmentId)).length
      || await docInfo((await rowOf(shipmentId))?.pdf_document_id));
  }

  const docInfo = async id => {
    if (!id) return null;
    const [d] = await query("SELECT id, filename, created_at, uploaded_by, size_bytes FROM shipment_documents WHERE id=$1", [id]);
    return d ? { documentId: d.id, filename: d.filename, createdAt: d.created_at, by: d.uploaded_by || "", sizeBytes: d.size_bytes } : null;
  };

  // The panel's view.
  async function view(shipmentId) {
    const [s] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
    if (!s) return null;
    const td = await masterOf(shipmentId), t = issuedTd(td), row = await rowOf(shipmentId), evs = await eventsOf(shipmentId);
    const doc = parse(t?.payload);
    const dp = doc?.documentParties || {};
    const { form, source } = formOf(row, td, s);
    const stage = stageOf(evs);
    const done = live(evs);
    const lastOf = step => done.filter(e => e.step === step).slice(-1)[0] || null;
    // The steps this form goes through, as the panel draws them (the path actually taken once a step decides it).
    const path0 = form === "SWB" ? ["RELEASED"]
      : form === "EBL" ? (lastOf("SURRENDERED") && !lastOf("TRANSFERRED") ? ["ISSUED", "SURRENDERED", "RELEASED"] : ["ISSUED", "TRANSFERRED", "SURRENDERED", "RELEASED"])
        : (lastOf("SURRENDERED") && !lastOf("SENT") ? ["RECEIVED", "SURRENDERED", "RELEASED"] : ["RECEIVED", "SENT", "SURRENDERED", "RELEASED"]);
    // A link to a document that is gone (removed before onDocumentGone existed) reads as no PDF (C5).
    const pdfDoc = row?.pdf_document_id ? await docInfo(row.pdf_document_id) : null;
    const pdf = pdfDoc ? { ...pdfDoc, check: parse(row.pdf_check) } : null;
    return {
      number: numberOf(s, td), carrierCode: s.carrier_code || "",
      master: t ? {
        reference: t.reference, status: t.status, typeCode: t.type_code, isElectronic: !!t.is_electronic, issueDate: t.issue_date || null,
        shippedOnBoardDate: t.shipped_on_board_date || doc?.shippedOnBoardDate || null, isToOrder: !!t.is_to_order,
        originals: originalsOf(null, t), issuer: dp.issuingParty?.partyName || "",
        shipper: dp.shipper?.partyName || "", consignee: dp.consignee?.partyName || (doc?.isToOrder ? "To order" : ""),
        notify: (dp.notifyParties || []).map(n => n.partyName).filter(Boolean),
        containers: (doc?.utilizedTransportEquipments || []).map(e => ({ number: e.equipment?.equipmentReference || "", iso: e.equipment?.ISOEquipmentCode || "",
          seals: (e.seals || []).map(x => x.number).filter(Boolean) })),
      } : null,
      // The carrier's draft that isn't issued yet (approve it on Shipping Instructions).
      pending: td && !t ? { reference: td.reference, status: td.status } : null,
      form, formSource: source, originalsTotal: originalsOf(row, td),
      ebl: { platform: row?.ebl_platform || "", reference: row?.ebl_reference || "", issuedTo: row?.ebl_issued_to || "" },
      print: row?.print_document_id ? await docInfo(row.print_document_id) : null, canPrint: !!(t && t.payload),
      pdf,
      stage, path: path0.map(step => ({ step, label: STEP_LABEL[step], done: !!lastOf(step), at: lastOf(step)?.created_at || null,
        detail: parse(lastOf(step)?.detail) || null })),
      // atOrigin: the export side's to record (and to undo, on the events below).
      next: (NEXT[form][stage] || []).map(step => ({ step, label: step === "SURRENDERED" && stage === "RECEIVED" ? "Surrendered at origin" : STEP_LABEL[step],
        atOrigin: isOriginStep(step, { stage }) })),
      released: stage === "RELEASED",
      locked: done.length > 0,   // the form can't change once a step is recorded
      events: evs.map(e => ({ id: e.id, step: e.step, label: STEP_LABEL[e.step] || e.step, detail: parse(e.detail) || {}, actor: e.actor || "",
        atOrigin: isOriginStep(e.step, { kind: parse(e.detail)?.kind || "origin" }),
        createdAt: e.created_at, undone: !!e.undone_at, undoneAt: e.undone_at || null, undoneBy: e.undone_by || "", undoReason: e.undo_reason || "" })),
      platforms: PLATFORMS,
    };
  }

  // Before any step: the form, the number of originals, the eBL's platform and reference.
  async function setup(shipmentId, input = {}, user) {
    const evs = live(await eventsOf(shipmentId));
    if (evs.length) return { error: "The form is fixed once a step is recorded: undo the steps first", status: 409 };
    const row = await ensureRow(shipmentId);
    const form = input.form !== undefined ? String(input.form || "").toUpperCase() : row.form;
    if (form && !FORMS.includes(form)) return { error: `form: one of ${FORMS.join(", ")}` };
    let originals = input.originalsTotal !== undefined ? (input.originalsTotal === null || input.originalsTotal === "" ? null : Number(input.originalsTotal)) : row.originals_total;
    if (originals !== null && originals !== undefined && !(Number.isInteger(originals) && originals >= 1 && originals <= 9)) return { error: "originalsTotal: 1 to 9" };
    const platform = input.eblPlatform !== undefined ? clip(input.eblPlatform, 40) : row.ebl_platform;
    if (platform && !PLATFORMS.includes(platform)) return { error: `eblPlatform: one of ${PLATFORMS.join(", ")}` };
    await query(`UPDATE master_bl_custody SET form=$1, originals_total=$2, ebl_platform=$3, ebl_reference=$4, ebl_issued_to=$5, updated_at=$6 WHERE shipment_id=$7`,
      [form || "", originals ?? null, platform || "", input.eblReference !== undefined ? clip(input.eblReference, 80) : row.ebl_reference,
        input.eblIssuedTo !== undefined ? clip(input.eblIssuedTo, 120) : row.ebl_issued_to, nowIso(), shipmentId]);
    await logEvent(shipmentId, "MASTER_BL_CUSTODY_SET", "master_bl_form", null, form || "", JSON.stringify({ originals, platform }), actorOf(user));
    return { view: await view(shipmentId) };
  }

  // One step of the custody chain, in its order, with what it needs.
  async function recordStep(shipmentId, input = {}, user) {
    const v = await view(shipmentId);
    if (!v) return { error: "Shipment not found", status: 404 };
    const step = String(input.step || "").toUpperCase();
    if (!STEP_LABEL[step]) return { error: `step: one of ${Object.keys(STEP_LABEL).join(", ")}` };
    const allowed = NEXT[v.form][v.stage] || [];
    if (!allowed.includes(step)) {
      return { error: v.stage === "RELEASED" ? "The carrier has already released the cargo"
        : `${STEP_LABEL[step]} can't come ${v.stage ? `after "${STEP_LABEL[v.stage]}"` : "first"}${allowed.length ? `: next is ${allowed.map(a => `"${STEP_LABEL[a]}"`).join(" or ")}` : ""}`, status: 409 };
    }
    const on = String(input.on || "");
    if (!isDay(on)) return { error: "on: the date it happened (YYYY-MM-DD)" };
    if (on > latestDay()) return { error: "on: a date that has happened, not a future one" };
    const prev = live(await eventsOf(shipmentId)).slice(-1)[0];
    const prevOn = parse(prev?.detail)?.on;
    if (prevOn && on < prevOn) return { error: `on: not before the previous step (${fmtDay(prevOn)})` };
    const detail = { on };
    const text = (k, n, required = false) => {
      const val = clip(input[k], n);
      if (required && !val) throw Object.assign(new Error(`${k} is required`), { status: 400 });
      if (val) detail[k] = val;
    };
    try {
      if (step === "RECEIVED") {
        const count = Number(input.count);
        if (!(Number.isInteger(count) && count >= 1 && count <= v.originalsTotal)) return { error: `count: 1 to ${v.originalsTotal} originals` };
        detail.count = count; detail.of = v.originalsTotal; text("from", 120); text("courier", 120);
      } else if (step === "SENT" || step === "TRANSFERRED") {
        text("to", 120, true); if (step === "SENT") text("courier", 120);
      } else if (step === "ISSUED") {
        const platform = clip(input.platform || v.ebl.platform, 40);
        if (!PLATFORMS.includes(platform)) return { error: `platform: one of ${PLATFORMS.join(", ")}` };
        const reference = clip(input.reference || v.ebl.reference, 80);
        if (!reference) return { error: "reference: the eBL's reference on the platform" };
        detail.platform = platform; detail.reference = reference; text("issuedTo", 120);
        await query("UPDATE master_bl_custody SET ebl_platform=$1, ebl_reference=$2, ebl_issued_to=COALESCE(NULLIF($3,''), ebl_issued_to) WHERE shipment_id=$4",
          [platform, reference, detail.issuedTo || "", shipmentId]);
      } else if (step === "SURRENDERED") {
        detail.kind = v.stage === "RECEIVED" || v.stage === "ISSUED" ? "origin" : "destination";
        if (v.form === "PAPER") {
          const received = parse(live(await eventsOf(shipmentId)).find(e => e.step === "RECEIVED")?.detail)?.count || v.originalsTotal;
          const count = Number(input.count ?? received);
          if (!(Number.isInteger(count) && count >= 1 && count <= received)) return { error: `count: 1 to ${received} originals (as many as were received)` };
          detail.count = count;
        }
        text("to", 120, true);
      } else if (step === "RELEASED") {
        text("ref", 80);
      }
      if (input.note) detail.note = clip(input.note, 300);
    } catch (e) { return { error: e.message, status: e.status || 400 }; }
    await ensureRow(shipmentId);
    const id = `MBC-${uid()}`;
    await query("INSERT INTO master_bl_custody_events (id, shipment_id, step, detail, actor, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, shipmentId, step, JSON.stringify(detail), actorOf(user), nowIso()]);
    await query("UPDATE master_bl_custody SET stage=$1, released_at=$2, release_ref=$3, updated_at=$4 WHERE shipment_id=$5",
      [step, step === "RELEASED" ? on : null, step === "RELEASED" ? (detail.ref || "") : "", nowIso(), shipmentId]);
    await logEvent(shipmentId, `MASTER_BL_${step}`, "master_bl_custody", v.stage || null, step, JSON.stringify({ number: v.number, form: v.form, ...detail }), actorOf(user));
    return { view: await view(shipmentId) };
  }

  // The last step was recorded by mistake: it stays on record, marked undone, with the reason.
  async function undoLast(shipmentId, reason, user) {
    const r = clip(reason, 300);
    if (!r) return { error: "A reason is required" };
    const last = live(await eventsOf(shipmentId)).slice(-1)[0];
    if (!last) return { error: "Nothing to undo", status: 409 };
    await query("UPDATE master_bl_custody_events SET undone_at=$1, undone_by=$2, undo_reason=$3 WHERE id=$4", [nowIso(), actorOf(user), r, last.id]);
    const stage = stageOf(await eventsOf(shipmentId));
    await query("UPDATE master_bl_custody SET stage=$1, released_at=NULL, release_ref='', updated_at=$2 WHERE shipment_id=$3", [stage, nowIso(), shipmentId]);
    if (stage === "RELEASED") {
      const rel = live(await eventsOf(shipmentId)).filter(e => e.step === "RELEASED").slice(-1)[0];
      await query("UPDATE master_bl_custody SET released_at=$1, release_ref=$2 WHERE shipment_id=$3", [parse(rel?.detail)?.on || null, parse(rel?.detail)?.ref || "", shipmentId]);
    }
    await logEvent(shipmentId, "MASTER_BL_STEP_UNDONE", "master_bl_custody", last.step, stage || null, JSON.stringify({ reason: r }), actorOf(user));
    return { view: await view(shipmentId) };
  }

  // ─── The carrier's PDF ────────────────────────────────────────────────────────────────────────────────────────────
  // What it should say: the Master B/L number, the shipment's containers, its vessel.
  async function expectedOf(shipmentId) {
    const [s] = await query("SELECT master_bl_number, vessel FROM shipments WHERE id=$1", [shipmentId]);
    const td = await masterOf(shipmentId);
    const containers = (await query("SELECT container_number FROM containers WHERE shipment_id=$1 ORDER BY container_number", [shipmentId]))
      .map(c => String(c.container_number || "").toUpperCase()).filter(n => n && !/^TBC$/.test(n));
    return { blNumber: numberOf(s, td), containers, vessel: s?.vessel || "" };
  }
  // → { readable, blNumber {value, found}, containers [{number, found}], others [...], vessel {value, found}, ok }
  async function checkPdf(buf, expected) {
    let text = "";
    try { text = (await pdfText(buf)).text; } catch { text = ""; }
    const flat = compact(text);
    const readable = flat.length >= 30;
    const found = v => !!v && flat.includes(compact(v));
    const mentioned = [...new Set([...String(text).toUpperCase().matchAll(CONTAINER_RE)].map(m => `${m[1]}${m[2]}${m[3]}`))];
    const result = {
      checkedAt: nowIso(), readable,
      blNumber: { value: expected.blNumber, found: readable && found(expected.blNumber) },
      containers: expected.containers.map(n => ({ number: n, found: readable && found(n) })),
      others: readable ? mentioned.filter(n => !expected.containers.includes(n)) : [],
      vessel: { value: expected.vessel, found: readable && found(expected.vessel) },
    };
    result.ok = readable && !!expected.blNumber && result.blNumber.found && result.containers.every(c => c.found) && !result.others.length
      && (!expected.vessel || result.vessel.found);
    return result;
  }

  // The carrier's MB01 is the carrier's issued document, so it goes in confirmed; its history starts like any
  // upload's (the pre-release audit, C6).
  async function storeDoc(shipmentId, { buf, filename, docType = "MB01", user, status = "confirmed" }) {
    const storedName = `${Date.now()}_${uid()}.pdf`;
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buf);
    const id = `DOC-${uid()}`;
    await query(`INSERT INTO shipment_documents (id, shipment_id, filename, stored_name, mime_type, size_bytes, doc_type, uploaded_by, created_at, status)
      VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,$7,$8,$9)`, [id, shipmentId, filename, storedName, buf.length, docType, actorOf(user), nowIso(), status]);
    await logEntityEvent("document", id, "GENERATED", null, null, null, JSON.stringify({ shipmentId, docType, filename, by: actorOf(user) }));
    return id;
  }

  // A new carrier's PDF or printed copy replaces the last one (C6): the earlier MB01 is voided, saying by what, and a
  // carrier booking linked to it follows to the new one.
  async function voidReplaced(oldId, newId, newFilename, user) {
    if (!oldId || oldId === newId) return;
    const [d] = await query("UPDATE shipment_documents SET status='voided' WHERE id=$1 AND status<>'voided' RETURNING shipment_id, doc_type, filename", [oldId]);
    if (!d) return;
    await query("UPDATE carrier_bookings SET bl_document_id=$1 WHERE bl_document_id=$2", [newId, oldId]);
    await logEntityEvent("document", oldId, "VOIDED", null, null, null,
      JSON.stringify({ shipmentId: d.shipment_id, docType: d.doc_type, filename: d.filename, reason: `Replaced by ${newFilename}`, by: actorOf(user) }));
  }

  // The panel's PDF or printed copy left the Documents list (deleted, or voided there): the panel lets go of it and
  // its check (the pre-release audit, C5), so it never points at a file that is gone.
  async function onDocumentGone(docId, user, why = "deleted") {
    if (!docId) return;
    const rows = await query("SELECT shipment_id, pdf_document_id, print_document_id FROM master_bl_custody WHERE pdf_document_id=$1 OR print_document_id=$1", [docId]);
    for (const r of rows) {
      const isPdf = r.pdf_document_id === docId;
      await query(isPdf ? "UPDATE master_bl_custody SET pdf_document_id=NULL, pdf_check=NULL, updated_at=$2 WHERE shipment_id=$1"
        : "UPDATE master_bl_custody SET print_document_id=NULL, updated_at=$2 WHERE shipment_id=$1", [r.shipment_id, nowIso()]);
      await logEvent(r.shipment_id, "MASTER_BL_DOCUMENT_REMOVED", isPdf ? "master_bl_pdf" : "master_bl_print", docId, null,
        JSON.stringify({ documentId: docId, why }), actorOf(user));
    }
  }

  // The carrier's PDF, uploaded: stored as MB01 and read.
  async function uploadPdf(shipmentId, { data, filename = "" } = {}, user) {
    const buf = Buffer.from(String(data || "").replace(/^data:[^,]*,/, ""), "base64");
    if (!buf.length) return { error: "The PDF is empty" };
    if (buf.length > MAX_PDF_BYTES) return { error: "The PDF is over 15 MB" };
    try { await PDFDocument.load(buf, { ignoreEncryption: true }); } catch { return { error: "That file isn't a PDF CargoDesk can read" }; }
    const name = clip(filename || "carrier-master-bl.pdf", 200).replace(/[\\/:*?"<>|]/g, "_");
    const stored = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
    const before = await rowOf(shipmentId);
    const docId = await storeDoc(shipmentId, { buf, filename: stored, user });
    const check = await checkPdf(buf, await expectedOf(shipmentId));
    await ensureRow(shipmentId);
    await query("UPDATE master_bl_custody SET pdf_document_id=$1, pdf_check=$2, updated_at=$3 WHERE shipment_id=$4", [docId, JSON.stringify(check), nowIso(), shipmentId]);
    await voidReplaced(before?.pdf_document_id, docId, stored, user);
    await logEvent(shipmentId, "MASTER_BL_PDF", "master_bl_pdf", null, docId,
      JSON.stringify({ filename, readable: check.readable, ok: check.ok, others: check.others }), actorOf(user));
    return { view: await view(shipmentId) };
  }

  // Read again (after the shipment's containers or number changed), or — for a scan — record what was checked by eye.
  async function recheckPdf(shipmentId, { byEye = null } = {}, user) {
    const row = await rowOf(shipmentId);
    if (!row?.pdf_document_id) return { error: "No carrier's PDF to check", status: 404 };
    const [d] = await query("SELECT stored_name FROM shipment_documents WHERE id=$1", [row.pdf_document_id]);
    const file = d ? path.join(UPLOADS_DIR, d.stored_name) : "";
    if (!file || !fs.existsSync(file)) return { error: "The PDF file is missing", status: 404 };
    const check = await checkPdf(fs.readFileSync(file), await expectedOf(shipmentId));
    if (byEye && typeof byEye === "object") {
      // A scan: what the user ticked, item by item; it counts as checked once every item is ticked.
      const items = [`blNumber:${check.blNumber.value}`, ...check.containers.map(c => `container:${c.number}`), ...(check.vessel.value ? [`vessel:${check.vessel.value}`] : [])];
      const ticked = items.filter(k => byEye[k] === true);
      check.byEye = { items, ticked, by: actorOf(user), at: nowIso(), complete: ticked.length === items.length };
      if (!check.readable) check.ok = check.byEye.complete && !!check.blNumber.value;
    }
    await query("UPDATE master_bl_custody SET pdf_check=$1, updated_at=$2 WHERE shipment_id=$3", [JSON.stringify(check), nowIso(), shipmentId]);
    return { view: await view(shipmentId) };
  }

  // ─── The carrier's B/L printed from its data ──────────────────────────────────────────────────────────────────────
  // The issued DCSA transport document as the carrier wrote it: parties, transport, cargo, equipment, clauses, the
  // on-board statement and the carrier's own terms on the following page(s). Marked COPY · NOT NEGOTIABLE.
  function printHtml(doc, td, carrierCode) {
    const dp = doc.documentParties || {};
    const party = (label, p, toOrder = false) => `<div class="party"><div class="lbl">${label}</div>
      <div class="name">${toOrder && !p ? "TO ORDER" : esc(p?.partyName || "—")}</div>
      ${p?.address ? `<div class="addr">${esc([p.address.street, p.address.streetNumber].filter(Boolean).join(" "))}<br>${esc([p.address.postCode, p.address.city].filter(Boolean).join(" "))} ${esc(p.address.countryCode || "")}</div>` : ""}</div>`;
    const tr = doc.transports || {};
    const vv = tr.vesselVoyages || [];
    const loc = l => esc(l?.UNLocationCode || l?.locationName || "—");
    const originals = (Number(doc.numberOfOriginalsWithCharges) || 0) + (Number(doc.numberOfOriginalsWithoutCharges) || 0);
    const copies = (Number(doc.numberOfCopiesWithCharges) || 0) + (Number(doc.numberOfCopiesWithoutCharges) || 0);
    const items = (doc.consignmentItems || []).flatMap(ci => (ci.cargoItems || []).map(c => ({ ci, c })));
    const equipment = doc.utilizedTransportEquipments || [];
    const terms = String(doc.termsAndConditions || "").trim();
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      @page{margin:14mm 14mm 16mm}
      body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#1b1d24;font-size:9.5pt;line-height:1.38}
      .mark{position:fixed;top:42%;left:6%;right:6%;transform:rotate(-18deg);text-align:center;font-size:40pt;font-weight:800;color:rgba(0,105,112,.13);
        border:4px solid rgba(0,105,112,.13);border-radius:10px;padding:6pt;letter-spacing:.06em;z-index:0}
      h1{font-size:17pt;margin:0;letter-spacing:.04em} .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1b1d24;padding-bottom:6pt;margin-bottom:8pt}
      .src{font-size:8pt;color:#555;margin-top:2pt} .no{font-size:13pt;font-weight:800;text-align:right} .copy{font-size:9pt;font-weight:800;color:#006970;text-align:right;letter-spacing:.06em}
      .grid{display:grid;gap:6pt;margin-bottom:8pt} .g3{grid-template-columns:1fr 1fr 1fr} .g2{grid-template-columns:1fr 1fr}
      .party,.box{border:1px solid #c9cdd6;border-radius:4px;padding:5pt 6pt} .lbl{font-size:7pt;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.06em}
      .name{font-weight:700} .addr{font-size:8.5pt;color:#333}
      table{width:100%;border-collapse:collapse;margin-bottom:8pt;font-size:8.8pt} th{text-align:left;font-size:7pt;text-transform:uppercase;letter-spacing:.05em;color:#555;border-bottom:1px solid #1b1d24;padding:3pt}
      td{border-bottom:1px solid #e1e4ea;padding:3pt;vertical-align:top} .num{text-align:right}
      .clauses{font-weight:700;font-size:8.5pt;margin-bottom:8pt} .terms{page-break-before:always}
      .terms h2{font-size:11pt;text-transform:uppercase;letter-spacing:.04em;margin:0 0 2pt} .terms .src{margin-bottom:8pt}
      .cols{column-count:2;column-gap:7mm;text-align:justify;font-family:Georgia,'Times New Roman',serif;font-size:7.6pt;line-height:1.4;white-space:pre-wrap}
    </style></head><body><div class="mark">COPY · NOT NEGOTIABLE</div>
      <div class="top"><div><h1>${doc.transportDocumentTypeCode === "SWB" ? "SEA WAYBILL" : "BILL OF LADING"}</h1>
        <div class="src">Issued by ${esc(dp.issuingParty?.partyName || carrierCode || "the carrier")}${carrierCode ? ` (${esc(carrierCode)})` : ""} · printed by CargoDesk from the carrier's DCSA transport document${td.issue_date ? ` of ${esc(fmtDay(td.issue_date))}` : ""}</div></div>
        <div><div class="no">${esc(doc.transportDocumentReference || td.reference)}</div><div class="copy">COPY · NOT NEGOTIABLE</div></div></div>
      <div class="grid g3">${party("Shipper", dp.shipper)}${party("Consignee", dp.consignee, doc.isToOrder)}${party("Notify party", (dp.notifyParties || [])[0])}</div>
      <div class="grid g3">
        <div class="box"><div class="lbl">Vessel / voyage</div>${vv.map(v => esc(`${v.vesselName || ""} / ${v.carrierExportVoyageNumber || ""}`)).join("<br>") || "—"}</div>
        <div class="box"><div class="lbl">Port of loading → discharge</div>${loc(tr.portOfLoading)} → ${loc(tr.portOfDischarge)}</div>
        <div class="box"><div class="lbl">Place of receipt / delivery</div>${loc(tr.placeOfReceipt)} / ${loc(tr.placeOfDelivery)}</div>
      </div>
      <table><thead><tr><th>Container</th><th>Seals</th><th>Description of goods</th><th>HS code</th><th class="num">Packages</th><th class="num">Gross weight</th></tr></thead><tbody>
        ${items.map(({ ci, c }) => {
          const eq = equipment.find(e => e.equipment?.equipmentReference === c.equipmentReference);
          return `<tr><td>${esc(c.equipmentReference || "—")}${eq?.equipment?.ISOEquipmentCode ? ` · ${esc(eq.equipment.ISOEquipmentCode)}` : ""}</td>
            <td>${esc((eq?.seals || []).map(x => x.number).join(", ") || "—")}</td><td>${esc((ci.descriptionOfGoods || []).join(" "))}</td>
            <td>${esc((ci.HSCodes || []).join(", ") || "—")}</td><td class="num">${esc(c.outerPackaging?.numberOfPackages ?? "—")} ${esc(c.outerPackaging?.packageCode || "")}</td>
            <td class="num">${c.cargoGrossWeight ? `${Number(c.cargoGrossWeight.value).toLocaleString("en-US")} ${esc(c.cargoGrossWeight.unit || "")}` : "—"}</td></tr>`;
        }).join("") || `<tr><td colspan="6">—</td></tr>`}
      </tbody></table>
      ${(doc.carrierClauses || []).length ? `<div class="clauses">${doc.carrierClauses.map(esc).join(" · ")}</div>` : ""}
      <div class="grid g2">
        <div class="box"><div class="lbl">${doc.isShippedOnBoardType ? "Shipped on board" : "Received for shipment"}</div>${esc(doc.displayedShippedOnBoardReceivedForShipment || fmtDay(doc.shippedOnBoardDate || doc.receivedForShipmentDate) || "—")}</div>
        <div class="box"><div class="lbl">Originals / copies · freight</div>${originals ? `${originals} original${originals === 1 ? "" : "s"}` : "No originals"}${copies ? `, ${copies} cop${copies === 1 ? "y" : "ies"}` : ""} · freight ${doc.freightPaymentTermCode === "COL" ? "collect" : "prepaid"}${doc.isElectronic ? " · electronic (eBL)" : ""}</div>
      </div>
      <div class="grid g2">
        <div class="box"><div class="lbl">Place and date of issue</div>${loc(doc.placeOfIssue)} / ${esc(fmtDay(doc.issueDate || td.issue_date) || "—")}</div>
        <div class="box"><div class="lbl">Carrier's booking</div>${esc([...new Set((doc.consignmentItems || []).map(ci => ci.carrierBookingReference).filter(Boolean))].join(", ") || "—")}</div>
      </div>
      ${terms ? `<div class="terms"><h2>The carrier's terms and conditions</h2><div class="src">As stated in the carrier's transport document ${esc(doc.transportDocumentReference || td.reference)}</div><div class="cols">${esc(terms)}</div></div>` : ""}
    </body></html>`;
  }

  async function printCopy(shipmentId, user, { renderHtmlToPdf, getActiveSigningCert, signPdfBuffer }) {
    const td = await masterOf(shipmentId);
    const t = issuedTd(td);
    if (!t) return { error: td ? `The carrier's Master B/L isn't issued yet (${td.status}): it can be printed once it is` : "No Master B/L from the carrier's data: upload its PDF instead", status: 409 };
    const doc = parse(t.payload);
    if (!doc) return { error: "The carrier's transport document isn't on file: ask the carrier again (Shipping Instructions)", status: 409 };
    const [s] = await query("SELECT carrier_code FROM shipments WHERE id=$1", [shipmentId]);
    const raw = await renderHtmlToPdf(printHtml(doc, t, s?.carrier_code || t.carrier_code || ""));
    const signed = await signPdfBuffer(Buffer.from(raw), await getActiveSigningCert(query));
    const before = await rowOf(shipmentId);
    const filename = `MB01-${t.reference}-copy.pdf`;
    const docId = await storeDoc(shipmentId, { buf: signed, filename, user });
    await ensureRow(shipmentId);
    await query("UPDATE master_bl_custody SET print_document_id=$1, updated_at=$2 WHERE shipment_id=$3", [docId, nowIso(), shipmentId]);
    await voidReplaced(before?.print_document_id, docId, filename, user);
    await logEvent(shipmentId, "MASTER_BL_PRINTED", "master_bl_print", null, docId, JSON.stringify({ reference: t.reference }), actorOf(user));
    return { view: await view(shipmentId), documentId: docId };
  }

  // For the House B/L's release at destination: a warning (never a block) while the carrier hasn't released.
  async function releaseWarning(shipmentId) {
    if (!(await applies(shipmentId))) return null;
    const v = await view(shipmentId);
    if (v.released) return null;
    const where = v.stage ? `"${STEP_LABEL[v.stage]}" is the last step recorded` : "no step is recorded yet";
    return `The carrier hasn't released the cargo to you yet: on Master B/L ${v.number || "(no number)"}, ${where} (Documents → Carrier's Master B/L)`;
  }

  return { view, setup, recordStep, undoLast, uploadPdf, recheckPdf, printCopy, printHtml, checkPdf, releaseWarning, applies, pdfText,
    onDocumentGone, isOriginStep, FORMS, PLATFORMS, STEP_LABEL };
}

module.exports = createCarrierMbl;
module.exports.isOriginStep = isOriginStep;
module.exports.PLATFORMS = PLATFORMS;
module.exports.STEP_LABEL = STEP_LABEL;
module.exports.pdfText = pdfText;
