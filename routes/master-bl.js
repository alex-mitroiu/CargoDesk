"use strict";

// ─── The carrier's Master B/L as a DCSA transport document (DCSA-everywhere phase 4, 2026-10-28) ───
// The carrier drafts its transport document from the Shipping Instructions (routes/shipping-instructions.js)
// and tells CargoDesk with a transport-document notification (routes/carrier-webhooks.js → applyTransportDocumentState).
// CargoDesk reads the document itself (GET /v3/transport-documents/{ref}, lib/carrier-integrations/dcsa-ebl-v3.js),
// keeps it on a transport_documents row with role 'MASTER' (the House B/L, lib/house-bl.js, is role 'HOUSE'),
// and the export side reviews it against what the instructions said, then approves it (PATCH … APPROVED).
// The carrier issues it: the shipment takes the Master B/L number and the "B/L Issued" milestone completes.
//
// DCSA states kept as they are on the row's status: DRAFT, APPROVED, ISSUED, PENDING_SURRENDER_FOR_* ,
// SURRENDERED_FOR_*, VOIDED. A draft opens a "Review the carrier's draft Master B/L" task for the export
// side; approving (or the carrier issuing it anyway) closes it.
//
// Once issued, the B/L is corrected by an amendment (eBL 3.0.3 Direct Transport Document amendment, optional
// for carriers): the issued document with the shipment's current instructions worked in, sent only when
// something differs. The carrier accepts it (the originals go back: PENDING_SURRENDER_FOR_AMENDMENT, a task
// for the export side) and issues the amended B/L, or declines it (a task too). amended_status keeps the
// carrier's AMENDMENT_* answer; a notification or GET that doesn't mention the amendment leaves it as it was.

const { normalizeTransportDocumentState, TD_STATUS_SPELLING, amendedTransportDocument } = require("../lib/carrier-integrations/dcsa-ebl-v3");

const REVIEW_TASK = "master_bl_draft";
const ORIGINALS_TASK = "master_bl_amendment_originals";
const DECLINED_TASK = "master_bl_amendment_declined";
const AMENDABLE = ["ISSUED", "PENDING_SURRENDER_FOR_AMENDMENT"];
const nowIso = () => new Date().toISOString();
const parse = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

// What the instructions said against what the carrier drafted, one row per thing a reviewer checks; the
// ports and the vessel against the shipment (Shipping Instructions don't carry them).
// → [{ key, label, sent, carrier, changed }]. A value left out shows as "—".
function compareDraft(sent, doc, shipment = {}) {
  if (!doc) return [];
  const s = sent || {};
  const rows = [];
  const add = (key, label, a, b) => {
    const norm = v => (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) ? "—" : Array.isArray(v) ? v.join(" ") : String(v));
    const sa = norm(a), sb = norm(b);
    rows.push({ key, label, sent: sa, carrier: sb, changed: sa !== sb });
  };
  const party = p => p?.partyName || "";
  const sp = s.documentParties || {}, dp = doc.documentParties || {};
  add("documentType", "Document", s.transportDocumentTypeCode, doc.transportDocumentTypeCode);
  add("freight", "Freight", s.freightPaymentTermCode, doc.freightPaymentTermCode);
  add("originals", "Originals", s.numberOfOriginalsWithoutCharges ?? s.numberOfOriginalsWithCharges, doc.numberOfOriginalsWithoutCharges ?? doc.numberOfOriginalsWithCharges);
  add("shipper", "Shipper", party(sp.shipper), party(dp.shipper));
  add("consignee", "Consignee", party(sp.consignee), party(dp.consignee));
  add("notify", "Notify party", party(sp.notifyParties?.[0]), party(dp.notifyParties?.[0]));
  add("portOfLoading", "Port of loading", shipment.pol, doc.transports?.portOfLoading?.UNLocationCode);
  add("portOfDischarge", "Port of discharge", shipment.pod, doc.transports?.portOfDischarge?.UNLocationCode);
  add("vessel", "Vessel / voyage", shipment.vessel ? `${shipment.vessel} ${shipment.voyage || ""}`.trim() : undefined,
    (doc.transports?.vesselVoyages || [])[0] ? `${doc.transports.vesselVoyages[0].vesselName} ${doc.transports.vesselVoyages[0].carrierExportVoyageNumber}` : undefined);
  const sentEq = new Map((s.utilizedTransportEquipments || []).map(u => [u.equipmentReference || u.equipment?.equipmentReference, u]));
  const docEq = new Map((doc.utilizedTransportEquipments || []).map(u => [u.equipment?.equipmentReference || u.equipmentReference, u]));
  const cargoOf = (items, ref) => {
    for (const ci of items || []) for (const c of ci.cargoItems || []) if (c.equipmentReference === ref) return { ci, c };
    return null;
  };
  for (const ref of new Set([...sentEq.keys(), ...docEq.keys()])) {
    const a = sentEq.get(ref), b = docEq.get(ref);
    add(`container:${ref}`, `Container ${ref}`, a ? ref : undefined, b ? ref : undefined);
    add(`seal:${ref}`, `  Seal`, (a?.seals || []).map(x => x.number), (b?.seals || []).map(x => x.number));
    const ca = cargoOf(s.consignmentItems, ref), cb = cargoOf(doc.consignmentItems, ref);
    add(`weight:${ref}`, `  Gross weight (kg)`, ca?.c.cargoGrossWeight?.value, cb?.c.cargoGrossWeight?.value);
    add(`goods:${ref}`, `  Description of goods`, ca?.ci.descriptionOfGoods, cb?.ci.descriptionOfGoods);
    add(`hs:${ref}`, `  HS code`, ca?.ci.HSCodes, cb?.ci.HSCodes);
    add(`packages:${ref}`, `  Packages`, ca?.c.outerPackaging?.numberOfPackages, cb?.c.outerPackaging?.numberOfPackages);
  }
  return rows;
}

module.exports = function masterBlRoutes(app, ctx) {
  const { query, uid, ok, err, auth, requireRole, carrierIntegrationFor, logEvent, autoCompleteMilestone,
          ensureOpsTicket, resolveOpsTickets, blockIfWrongSide } = ctx;
  const write = requireRole(["operator", "admin", "occ_bk"]); // same set as routes/edi.js / shipping-instructions.js

  const masterOf = async shipmentId => (await query(
    "SELECT * FROM transport_documents WHERE shipment_id=$1 AND role='MASTER' ORDER BY created_at DESC LIMIT 1", [shipmentId]))[0] || null;

  const mapMaster = r => r && ({
    id: r.id, shipmentId: r.shipment_id, reference: r.reference, status: r.status, typeCode: r.type_code,
    isElectronic: !!r.is_electronic, isToOrder: !!r.is_to_order, isShippedOnBoardType: !!r.is_shipped_on_board_type,
    shippedOnBoardDate: r.shipped_on_board_date || null, receivedForShipmentDate: r.received_for_shipment_date || null,
    issueDate: r.issue_date || null, placeOfIssue: r.place_of_issue || "",
    carrierCode: r.carrier_code || "", shippingInstructionsReference: r.shipping_instructions_reference || "",
    amendedStatus: r.amended_status || "", carrierFeedback: r.carrier_feedback || "", isMock: !!r.is_mock,
    draftCount: r.draft_count || 0, approvedAt: r.approved_at || null, approvedBy: r.approved_by || "",
    amendmentRequestedAt: r.amendment_requested_at || null, amendmentRequestedBy: r.amendment_requested_by || "",
    carrierStateAt: r.carrier_state_at || null, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  // The parts of a transport document the carrier decides (ports, vessel), compared with themselves.
  const placesOf = doc => {
    const vv = (doc?.transports?.vesselVoyages || [])[0];
    return { pol: doc?.transports?.portOfLoading?.UNLocationCode, pod: doc?.transports?.portOfDischarge?.UNLocationCode,
      vessel: vv?.vesselName, voyage: vv?.carrierExportVoyageNumber };
  };
  const amendmentSource = td => `${td.reference}@${td.amendment_requested_at || ""}`;

  async function tdEvent(td, type, from, to, detail = {}, actor = "") {
    await query(`INSERT INTO transport_document_events (id, transport_document_id, shipment_id, event_type, from_status, to_status, detail, actor, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [`TDE-${uid()}${uid()}`, td.id, td.shipment_id, type, from || "", to || "", JSON.stringify(detail), actor, nowIso()]);
  }
  const reviewSource = td => `${td.reference}#${td.draft_count || 1}`;

  // The Shipping Instructions the carrier holds, as sent: the last submission, with an update counted once
  // the carrier confirmed it — one it cancelled or declined (or still has pending) isn't what it drafted from.
  async function sentInstructions(shipmentId) {
    const msgs = await query(`SELECT direction, message_type, status, raw_payload FROM edi_messages WHERE shipment_id=$1
      AND message_type IN ('shipping_instructions_submission','shipping_instructions_update','shipping_instructions_notification','shipping_instructions_status')
      ORDER BY created_at, id`, [shipmentId]);
    let held = null, pending = null;
    for (const m of msgs) {
      if (m.direction === "out" && m.message_type === "shipping_instructions_submission") { held = m.raw_payload; pending = null; }
      else if (m.direction === "out" && m.message_type === "shipping_instructions_update") pending = m.raw_payload;
      else if (m.direction === "in" && pending && m.status === "update_confirmed") { held = pending; pending = null; }
      else if (m.direction === "in" && pending && ["update_cancelled", "update_declined"].includes(m.status)) pending = null;
    }
    // A carrier that drafts from an update without saying UPDATE_CONFIRMED first: the update it drafted from.
    return parse(held || pending);
  }

  // Applies a transport document state from a notification or a GET. `document` is the TransportDocument
  // when the carrier sent it (or it was read); otherwise it is read from the carrier first, through the
  // integration that holds the Shipping Instructions. A repeat (same status, same document) records nothing.
  // → { changed, masterBl } | { error }
  async function applyTransportDocumentState(si, state, { document = null, source = "callback", raw = null, simulated = false } = {}) {
    const ref = state.transportDocumentReference;
    if (!ref) return { error: "No transportDocumentReference" };
    let doc = document;
    if (!doc) {
      const integ = await carrierIntegrationFor(si.carrier_code, "shipping-instructions").catch(() => null);
      const got = integ?.adapter.getTransportDocument ? await integ.adapter.getTransportDocument(integ.config, ref) : null;
      if (got?.ok) doc = got.document;
    }
    const status = state.transportDocumentStatus || TD_STATUS_SPELLING[doc?.transportDocumentStatus] || doc?.transportDocumentStatus || "";
    if (!status) return { error: `The carrier's transport document ${ref} could not be read` };
    const [existing] = await query("SELECT * FROM transport_documents WHERE shipment_id=$1 AND role='MASTER' AND reference=$2", [si.shipment_id, ref]);
    const payload = doc ? JSON.stringify(doc) : existing?.payload || null;
    const feedback = (state.feedbacks || []).map(f => f.message).filter(Boolean).join("; ");
    // The document itself (a GET) doesn't say how an amendment stands: only a stated value changes it.
    const amendedStatus = state.amendedTransportDocumentStatus || existing?.amended_status || "";
    if (existing && existing.status === status && (existing.payload || null) === payload && (existing.amended_status || "") === amendedStatus)
      return { changed: false, masterBl: mapMaster(existing) };
    const now = nowIso();
    const facts = {
      type_code: doc?.transportDocumentTypeCode || existing?.type_code || "BOL",
      is_electronic: !!(doc?.isElectronic ?? existing?.is_electronic), is_to_order: !!(doc?.isToOrder ?? existing?.is_to_order),
      is_shipped_on_board_type: doc ? doc.isShippedOnBoardType !== false : existing ? !!existing.is_shipped_on_board_type : true,
      shipped_on_board_date: doc?.shippedOnBoardDate || existing?.shipped_on_board_date || null,
      received_for_shipment_date: doc?.receivedForShipmentDate || existing?.received_for_shipment_date || null,
      issue_date: doc?.issueDate || existing?.issue_date || null,
      place_of_issue: doc?.placeOfIssue?.UNLocationCode || doc?.placeOfIssue?.countryCode || existing?.place_of_issue || "",
    };
    // A new draft of an existing document (the carrier redrafted it after an update) counts again.
    const redraft = status === "DRAFT" && (!existing || existing.status !== "DRAFT" || (existing.payload || null) !== payload);
    let td;
    if (existing) {
      await query(`UPDATE transport_documents SET status=$1, payload=$2, type_code=$3, is_electronic=$4, is_to_order=$5, is_shipped_on_board_type=$6,
        shipped_on_board_date=$7, received_for_shipment_date=$8, issue_date=$9, place_of_issue=$10, amended_status=$11, carrier_feedback=$12,
        carrier_state_at=$13, updated_at=$13, draft_count=$14, issued_at=$15,
        approved_at=CASE WHEN $17 THEN NULL ELSE approved_at END, approved_by=CASE WHEN $17 THEN '' ELSE approved_by END WHERE id=$16`,
        [status, payload, facts.type_code, facts.is_electronic, facts.is_to_order, facts.is_shipped_on_board_type, facts.shipped_on_board_date,
          facts.received_for_shipment_date, facts.issue_date, facts.place_of_issue, amendedStatus, feedback, now,
          (existing.draft_count || 0) + (redraft ? 1 : 0),
          status === "ISSUED" ? existing.issued_at || now : existing.issued_at, existing.id, redraft]);
      td = (await query("SELECT * FROM transport_documents WHERE id=$1", [existing.id]))[0];
    } else {
      const id = `TD-${uid()}${uid()}`;
      await query(`INSERT INTO transport_documents (id, shipment_id, role, reference, status, type_code, is_electronic, is_to_order, is_shipped_on_board_type,
        shipped_on_board_date, received_for_shipment_date, issue_date, place_of_issue, payload, carrier_code, shipping_instructions_reference,
        amended_status, carrier_feedback, is_mock, carrier_state_at, draft_count, issued_at, created_at, updated_at)
        VALUES ($1,$2,'MASTER',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$19,$19)`,
        [id, si.shipment_id, ref, status, facts.type_code, facts.is_electronic, facts.is_to_order, facts.is_shipped_on_board_type,
          facts.shipped_on_board_date, facts.received_for_shipment_date, facts.issue_date, facts.place_of_issue, payload,
          si.carrier_code || "", si.si_reference || state.shippingInstructionsReference || "", amendedStatus, feedback,
          !!simulated, now, status === "DRAFT" ? 1 : 0, status === "ISSUED" ? now : null]);
      td = (await query("SELECT * FROM transport_documents WHERE id=$1", [id]))[0];
    }
    const carrier = si.carrier_code || "the carrier";
    await query(`INSERT INTO edi_messages (id, shipment_id, carrier_code, direction, message_type, format, raw_payload, parsed_payload, status,
      correlation_id, is_mock, created_at, processed_at) VALUES ($1,$2,$3,'in',$4,'JSON',$5,$6,$7,$8,$9,$10,$10)`,
      [`EDI-${uid()}`, si.shipment_id, si.carrier_code || "", source === "poll" ? "transport_document_status" : "transport_document_notification",
        JSON.stringify(raw || state), JSON.stringify({ transportDocumentReference: ref, transportDocumentStatus: status, ...(feedback ? { feedback } : {}) }),
        status.toLowerCase(), td.id, !!simulated, now]);
    if (!existing || existing.status !== status) await tdEvent(td, `MASTER_${status}`, existing?.status || "", status, { carrier: si.carrier_code, ...(feedback ? { feedback } : {}) }, carrier);

    // What each state means for the shipment.
    if (redraft) {
      if (existing?.status === "DRAFT")
        await resolveOpsTickets(REVIEW_TASK, [{ sourceId: reviewSource(existing), shipmentId: si.shipment_id, note: "the carrier redrafted it" }]);
      await logEvent(si.shipment_id, "MASTER_BL_DRAFT_RECEIVED", "master_bl", existing?.status || "", "DRAFT",
        JSON.stringify({ reference: ref, version: td.draft_count }), carrier);
      await ensureOpsTicket(REVIEW_TASK, reviewSource(td), { shipmentId: si.shipment_id, priority: "High",
        title: `Review the carrier's draft Master B/L ${ref}`,
        description: `${carrier} drafted Master B/L ${ref} from the Shipping Instructions. Compare it with what was sent (Shipping Instructions → Master B/L) and approve it, or send corrected instructions.` });
    }
    // The carrier accepted the instructions by drafting from them (or CargoDesk first hears of the document
    // once approved or issued): they are Confirmed, unless an update of them is still with the carrier.
    if (status && status !== "VOIDED" && si.status === "Submitted" && si.carrier_updated_state !== "UPDATE_RECEIVED" && si.id)
      await query("UPDATE shipping_instructions SET status='Confirmed', responded_at=$1, updated_at=$1 WHERE id=$2", [now, si.id]);
    if (si.id && ref !== (si.transport_document_reference || ""))
      await query("UPDATE shipping_instructions SET transport_document_reference=$1 WHERE id=$2", [ref, si.id]);
    if (status !== "DRAFT" && existing?.status === "DRAFT")
      await resolveOpsTickets(REVIEW_TASK, [{ sourceId: reviewSource(existing), shipmentId: si.shipment_id, note: `the draft is ${status.toLowerCase()}` }]);
    // ─── An amendment of the issued B/L ───
    const amendmentChanged = existing && amendedStatus !== (existing.amended_status || "");
    // The carrier issued the amended B/L (after the originals came back, or straight away).
    const reissued = status === "ISSUED" && !!existing?.amendment_payload && amendedStatus === "AMENDMENT_CONFIRMED"
      && (existing.status !== "ISSUED" || (existing.payload || null) !== payload);
    if (amendmentChanged) {
      await tdEvent(td, `MASTER_${amendedStatus}`, existing.amended_status || "", amendedStatus, { carrier: si.carrier_code, ...(feedback ? { feedback } : {}) }, carrier);
      await logEvent(si.shipment_id, `MASTER_BL_${amendedStatus}`, "master_bl_amendment", existing.amended_status || "", amendedStatus,
        JSON.stringify({ reference: ref, ...(feedback ? { feedback } : {}) }), carrier);
      if (amendedStatus === "AMENDMENT_DECLINED")
        await ensureOpsTicket(DECLINED_TASK, amendmentSource(td), { shipmentId: si.shipment_id, priority: "High",
          title: `${carrier} declined the Master B/L ${ref} amendment`,
          description: `${carrier} declined the amendment of Master B/L ${ref}${feedback ? `: ${feedback}` : ""}. The issued B/L stands as it was. Correct the shipment and request a new amendment (Shipping Instructions → Master B/L), or settle it with ${carrier} directly.` });
      // Withdrawn by CargoDesk: nothing is pending any more.
      if (amendedStatus === "AMENDMENT_CANCELLED") await query("UPDATE transport_documents SET amendment_payload=NULL WHERE id=$1", [td.id]);
    }
    if (status === "PENDING_SURRENDER_FOR_AMENDMENT" && existing?.status !== status)
      await ensureOpsTicket(ORIGINALS_TASK, amendmentSource(td), { shipmentId: si.shipment_id, priority: "High",
        title: `Return the Master B/L ${ref} originals to ${carrier}`,
        description: td.is_electronic
          ? `${carrier} accepted the amendment of Master B/L ${ref}. Surrender the electronic B/L for amendment on its eBL platform so ${carrier} can issue the amended one.`
          : `${carrier} accepted the amendment of Master B/L ${ref}. Return the full set of original B/Ls to ${carrier} (surrender for amendment) so it can issue the amended one.` });
    if (existing?.status === "PENDING_SURRENDER_FOR_AMENDMENT" && status !== existing.status)
      await resolveOpsTickets(ORIGINALS_TASK, [{ sourceId: amendmentSource(existing), shipmentId: si.shipment_id, note: `the B/L is ${status.toLowerCase().replace(/_/g, " ")}` }]);
    if (reissued) {
      // What the amended B/L changed against the one issued before (new value "sent", old "carrier").
      const changes = compareDraft(doc, parse(existing.payload), placesOf(doc)).filter(r => r.changed);
      await query("UPDATE transport_documents SET amendment_payload=NULL, issued_at=$1 WHERE id=$2", [now, td.id]);
      await tdEvent(td, "MASTER_AMENDED", existing.status, "ISSUED", { carrier: si.carrier_code, issueDate: facts.issue_date,
        changes: changes.map(r => ({ key: r.key, label: r.label, was: r.carrier, now: r.sent })) }, carrier);
      await logEvent(si.shipment_id, "MASTER_BL_AMENDED", "master_bl", existing.status, "ISSUED",
        JSON.stringify({ reference: ref, changes: changes.map(r => r.label.trim()) }), carrier);
      td = (await query("SELECT * FROM transport_documents WHERE id=$1", [td.id]))[0];
    } else if (status === "ISSUED" && existing?.status !== "ISSUED") {
      const [had] = await query("SELECT master_bl_number FROM shipments WHERE id=$1", [si.shipment_id]);
      await query("UPDATE shipments SET master_bl_number=$1 WHERE id=$2", [ref, si.shipment_id]);
      await logEvent(si.shipment_id, "MASTER_BL_ISSUED", "master_bl_number", had?.master_bl_number || "", ref, JSON.stringify({ issueDate: facts.issue_date }), carrier);
      await ctx.milestoneEvents.onEvent(si.shipment_id, { eventType: "SHIPMENT", code: "ISSUED", documentType: "TRANSPORT_DOCUMENT" },
        `${carrier} issued Master B/L ${ref}`);
    }
    return { changed: true, masterBl: mapMaster(td) };
  }
  ctx.applyTransportDocumentState = applyTransportDocumentState;

  const shipmentFor = async (req, res, { forWrite = false } = {}) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) { err(res, "Shipment not found", 404); return null; }
    if (forWrite && (await blockIfWrongSide(req, res, shipment, "export"))) return null;
    return shipment;
  };
  async function view(shipmentId) {
    const td = await masterOf(shipmentId);
    if (!td) return null;
    const doc = parse(td.payload);
    const events = await query("SELECT * FROM transport_document_events WHERE transport_document_id=$1 ORDER BY created_at", [td.id]);
    const [shipment] = await query("SELECT pol, pod, vessel, voyage FROM shipments WHERE id=$1", [shipmentId]);
    const amended = parse(td.amendment_payload);
    return { ...mapMaster(td), document: doc, comparison: compareDraft(await sentInstructions(shipmentId), doc, shipment || {}),
      // The amendment asked for and not yet issued (or declined): what it changes, "sent" = requested, "carrier" = issued.
      amendment: amended ? { status: td.amended_status || "", requestedAt: td.amendment_requested_at, requestedBy: td.amendment_requested_by || "",
        changes: compareDraft(amended, doc, placesOf(amended)).filter(r => r.changed) } : null,
      // The House B/L against this Master (the House B/L audit's M3): containers, seals, weights, packages.
      houseCheck: ctx.houseBl ? await ctx.houseBl.houseVsMaster(shipmentId) : null,
      events: events.map(e => ({ id: e.id, eventType: e.event_type, fromStatus: e.from_status, toStatus: e.to_status, detail: parse(e.detail) || {}, actor: e.actor, createdAt: e.created_at })) };
  }

  // The amendment the shipment calls for now: the issued B/L with the current instructions worked in.
  // → { document, changes, missing } (changes: compareDraft rows that differ; "sent" = the shipment now).
  async function amendmentFor(shipment, td) {
    const doc = parse(td.payload);
    if (!doc) return { missing: [`the issued Master B/L itself (Ask ${td.carrier_code || "the carrier"} again)`] };
    const [si] = await query("SELECT si_reference FROM shipping_instructions WHERE shipment_id=$1", [shipment.id]);
    const { body, missing } = await ctx.shippingInstructionsFor(shipment, { reference: si?.si_reference || "" });
    if (missing.length) return { missing };
    const document = amendedTransportDocument(doc, body);
    return { document, changes: compareDraft(document, doc, placesOf(document)).filter(r => r.changed), missing: [] };
  }

  // The carrier's own account of the amendment (GET …/amendment) worked into the record, for a refresh or
  // the poll: the transport document's GET doesn't carry it.
  async function readAmendment(integ, td, si) {
    if (!integ?.adapter.getTransportDocumentAmendment || !(td.amendment_payload || td.amended_status === "AMENDMENT_RECEIVED")) return;
    const a = await integ.adapter.getTransportDocumentAmendment(integ.config, td.reference);
    if (!a.ok || !a.amendment?.status || a.amendment.status === td.amended_status) return;
    await applyTransportDocumentState(si, { transportDocumentReference: td.reference, transportDocumentStatus: td.status, amendedTransportDocumentStatus: a.amendment.status },
      { source: "poll", raw: a.raw, simulated: !!integ.row.is_simulator });
  }

  app.get("/api/shipments/:id/master-bl", auth(), async (req, res) => {
    if (!(await shipmentFor(req, res))) return;
    ok(res, await view(req.params.id));
  });

  // Approve the carrier's draft. Nothing changes here until the carrier accepts the PATCH (202); its
  // APPROVED notification then moves the record.
  app.post("/api/shipments/:id/master-bl/approve", write, async (req, res) => {
    const shipment = await shipmentFor(req, res, { forWrite: true });
    if (!shipment) return;
    const td = await masterOf(shipment.id);
    if (!td) return err(res, "The carrier hasn't drafted the Master B/L yet", 404);
    if (td.status !== "DRAFT") return err(res, `Only a draft can be approved (this Master B/L is ${td.status.toLowerCase().replace(/_/g, " ")})`, 409);
    const integ = await carrierIntegrationFor(td.carrier_code || shipment.carrier_code, "shipping-instructions");
    if (!integ?.adapter.approveTransportDocument) return err(res, `No DCSA connection for ${td.carrier_code || shipment.carrier_code} to approve the Master B/L with`, 400);
    const r = await integ.adapter.approveTransportDocument(integ.config, td.reference);
    if (!r.ok) return err(res, `${td.carrier_code} did not accept the approval (${r.error}). Nothing was changed — try again.`, r.invalid ? 400 : 502);
    const now = nowIso(), who = req.user?.name || req.user?.email || "";
    await query("UPDATE transport_documents SET approved_at=$1, approved_by=$2, updated_at=$1 WHERE id=$3", [now, who, td.id]);
    await tdEvent(td, "MASTER_APPROVAL_SENT", "DRAFT", "DRAFT", { reference: td.reference }, who);
    await logEvent(shipment.id, "MASTER_BL_APPROVED", "master_bl", "DRAFT", "APPROVED", JSON.stringify({ reference: td.reference }), who);
    await resolveOpsTickets(REVIEW_TASK, [{ sourceId: reviewSource(td), shipmentId: shipment.id, note: `approved by ${who || "the export side"}` }]);
    // The carrier's notification usually lands while this request is still answering; wait briefly for it.
    for (let i = 0; i < 20; i++) {
      const fresh = await masterOf(shipment.id);
      if (fresh.status !== "DRAFT") break;
      await new Promise(r2 => setTimeout(r2, 100));
    }
    ok(res, await view(shipment.id));
  });

  // Ask the carrier for the document's current state (a lost notification, or to check).
  app.post("/api/shipments/:id/master-bl/refresh", write, async (req, res) => {
    const shipment = await shipmentFor(req, res, { forWrite: true });
    if (!shipment) return;
    const td = await masterOf(shipment.id);
    if (!td) return err(res, "There is no Master B/L from the carrier yet", 404);
    const [si] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [shipment.id]);
    const integ = await carrierIntegrationFor(td.carrier_code || shipment.carrier_code, "shipping-instructions");
    if (!integ?.adapter.getTransportDocument) return err(res, `No DCSA connection for ${td.carrier_code || shipment.carrier_code}`, 400);
    const r = await integ.adapter.getTransportDocument(integ.config, td.reference);
    if (!r.ok) return err(res, `${td.carrier_code} could not be asked for the Master B/L (${r.error})`, 502);
    const siRow = si || { shipment_id: shipment.id, carrier_code: td.carrier_code, si_reference: td.shipping_instructions_reference, status: "" };
    await applyTransportDocumentState(siRow, r.state, { document: r.document, source: "poll", raw: r.raw, simulated: !!integ.row.is_simulator });
    await readAmendment(integ, await masterOf(shipment.id), siRow);
    ok(res, await view(shipment.id));
  });

  // ─── Amending the issued B/L ───────────────────────────────────────────────
  const amendableOr409 = (res, td, carrier) => {
    if (!td) { err(res, `${carrier} hasn't drafted the Master B/L yet`, 404); return false; }
    if (["DRAFT", "APPROVED"].includes(td.status)) { err(res, `Master B/L ${td.reference} isn't issued yet: correct it with Send update on the Shipping Instructions`, 409); return false; }
    if (!AMENDABLE.includes(td.status)) { err(res, `Master B/L ${td.reference} is ${td.status.toLowerCase().replace(/_/g, " ")}: it can't be amended`, 409); return false; }
    return true;
  };

  // What an amendment would send now, without sending it.
  app.get("/api/shipments/:id/master-bl/amendment-preview", auth(), async (req, res) => {
    const shipment = await shipmentFor(req, res);
    if (!shipment) return;
    const td = await masterOf(shipment.id);
    if (!amendableOr409(res, td, td?.carrier_code || shipment.carrier_code || "The carrier")) return;
    const a = await amendmentFor(shipment, td);
    ok(res, { changes: a.changes || [], missing: a.missing });
  });

  // Ask the carrier to amend the issued B/L. Sent only when the shipment differs from it; a new request
  // replaces one still pending (the spec's own rule). Nothing is recorded unless the carrier accepts it (202).
  app.post("/api/shipments/:id/master-bl/amend", write, async (req, res) => {
    const shipment = await shipmentFor(req, res, { forWrite: true });
    if (!shipment) return;
    const td = await masterOf(shipment.id);
    const carrier = td?.carrier_code || shipment.carrier_code || "The carrier";
    if (!amendableOr409(res, td, carrier)) return;
    const a = await amendmentFor(shipment, td);
    if (a.missing.length) return err(res, `Can't amend the Master B/L yet: add ${a.missing.join("; ")}`, 400);
    if (!a.changes.length) return err(res, `Nothing to amend: the shipment says what Master B/L ${td.reference} says. Correct the shipment first.`, 409);
    const integ = await carrierIntegrationFor(carrier, "shipping-instructions");
    if (!integ?.adapter.amendTransportDocument) return err(res, `No DCSA connection for ${carrier} to amend the Master B/L with`, 400);
    const now = nowIso(), who = req.user?.name || req.user?.email || "";
    // Recorded before sending (the carrier's AMENDMENT_RECEIVED can arrive before this request returns), put
    // back if the carrier doesn't take it.
    await query("UPDATE transport_documents SET amendment_payload=$1, amendment_requested_at=$2, amendment_requested_by=$3, amended_status='', updated_at=$2 WHERE id=$4",
      [JSON.stringify(a.document), now, who, td.id]);
    const r = await integ.adapter.amendTransportDocument(integ.config, td.reference, a.document);
    if (!r.ok) {
      await query("UPDATE transport_documents SET amendment_payload=$1, amendment_requested_at=$2, amendment_requested_by=$3, amended_status=$4 WHERE id=$5",
        [td.amendment_payload, td.amendment_requested_at, td.amendment_requested_by || "", td.amended_status || "", td.id]);
      if ([404, 405, 501].includes(r.status))
        return err(res, `${carrier} doesn't take Master B/L amendments through DCSA (it answered ${r.status}). Nothing was sent: ask ${carrier} directly.`, 409);
      return err(res, r.invalid ? `Can't send the amendment: ${String(r.error).replace(/^Not sent: /, "")}`
        : `${carrier} did not accept the amendment (${r.error}). Nothing was changed — try again.`, r.invalid ? 400 : 502);
    }
    await query(`INSERT INTO edi_messages (id, shipment_id, carrier_code, direction, message_type, format, raw_payload, parsed_payload, status,
      correlation_id, is_mock, created_at, processed_at) VALUES ($1,$2,$3,'out','transport_document_amendment','JSON',$4,$5,'sent',$6,$7,$8,$8)`,
      [`EDI-${uid()}`, shipment.id, carrier, JSON.stringify(a.document),
        JSON.stringify({ transportDocumentReference: td.reference, changes: a.changes.map(c => c.label.trim()) }), td.id, !!integ.row.is_simulator, now]);
    const fresh = await masterOf(shipment.id);
    await tdEvent(fresh, "MASTER_AMENDMENT_SENT", td.status, td.status,
      { changes: a.changes.map(c => ({ key: c.key, label: c.label, was: c.carrier, now: c.sent })) }, who);
    await logEvent(shipment.id, "MASTER_BL_AMENDMENT_REQUESTED", "master_bl_amendment", td.amended_status || "", "requested",
      JSON.stringify({ reference: td.reference, changes: a.changes.map(c => c.label.trim()) }), who);
    if (td.amended_status === "AMENDMENT_DECLINED")
      await resolveOpsTickets(DECLINED_TASK, [{ sourceId: amendmentSource(td), shipmentId: shipment.id, note: `a new amendment was sent by ${who || "the export side"}` }]);
    for (let i = 0; i < 20; i++) {
      if ((await masterOf(shipment.id)).amended_status) break;
      await new Promise(r2 => setTimeout(r2, 100));
    }
    ok(res, await view(shipment.id), 201);
  });

  // Withdraw an amendment the carrier hasn't worked on yet (AMENDMENT_RECEIVED).
  app.post("/api/shipments/:id/master-bl/amendment/cancel", write, async (req, res) => {
    const shipment = await shipmentFor(req, res, { forWrite: true });
    if (!shipment) return;
    const td = await masterOf(shipment.id);
    const carrier = td?.carrier_code || shipment.carrier_code || "The carrier";
    if (!td?.amendment_payload || td.amended_status !== "AMENDMENT_RECEIVED")
      return err(res, td?.amended_status ? `The amendment is ${td.amended_status.replace(/^AMENDMENT_/, "").toLowerCase()}: only one ${carrier} hasn't worked on yet can be cancelled` : "There is no amendment waiting at the carrier", 409);
    const integ = await carrierIntegrationFor(carrier, "shipping-instructions");
    if (!integ?.adapter.cancelTransportDocumentAmendment) return err(res, `No DCSA connection for ${carrier}`, 400);
    const r = await integ.adapter.cancelTransportDocumentAmendment(integ.config, td.reference);
    if (!r.ok) return err(res, `${carrier} did not accept the cancellation (${r.error}). Nothing was changed.`, r.status === 400 ? 409 : 502);
    const who = req.user?.name || req.user?.email || "";
    await tdEvent(td, "MASTER_AMENDMENT_CANCELLATION_SENT", td.status, td.status, { reference: td.reference }, who);
    await logEvent(shipment.id, "MASTER_BL_AMENDMENT_CANCELLATION_SENT", "master_bl_amendment", td.amended_status, "cancel requested", JSON.stringify({ reference: td.reference }), who);
    for (let i = 0; i < 20; i++) {
      if ((await masterOf(shipment.id)).amended_status !== "AMENDMENT_RECEIVED") break;
      await new Promise(r2 => setTimeout(r2, 100));
    }
    ok(res, await view(shipment.id));
  });

  // ─── Polling: drafts and approvals the carrier hasn't been heard from about ─
  const TD_POLL_MINUTES = 15;
  async function pollTransportDocumentsSweep({ olderThanMinutes = TD_POLL_MINUTES } = {}) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60000).toISOString();
    const rows = await query(`SELECT t.*, si.id AS si_id FROM transport_documents t JOIN shipping_instructions si ON si.shipment_id = t.shipment_id
      WHERE t.role='MASTER' AND t.status IN ('DRAFT','APPROVED','ISSUED','PENDING_SURRENDER_FOR_DELIVERY','PENDING_SURRENDER_FOR_AMENDMENT','SURRENDERED_FOR_AMENDMENT')
        AND (t.carrier_state_at IS NULL OR t.carrier_state_at <= $1)`, [cutoff]);
    const summary = { polled: 0, changed: 0, failed: 0 };
    for (const td of rows) {
      const integ = await carrierIntegrationFor(td.carrier_code, "shipping-instructions").catch(() => null);
      if (!integ?.adapter.getTransportDocument) continue;
      const r = await integ.adapter.getTransportDocument(integ.config, td.reference);
      if (!r.ok) { summary.failed++; continue; }
      summary.polled++;
      const [si] = await query("SELECT * FROM shipping_instructions WHERE id=$1", [td.si_id]);
      if ((await applyTransportDocumentState(si, r.state, { document: r.document, source: "poll", raw: r.raw, simulated: !!integ.row.is_simulator })).changed) summary.changed++;
      else await query("UPDATE transport_documents SET carrier_state_at=$1 WHERE id=$2", [new Date().toISOString(), td.id]);
      await readAmendment(integ, (await query("SELECT * FROM transport_documents WHERE id=$1", [td.id]))[0], si);
    }
    return summary;
  }
  ctx.pollTransportDocumentsSweep = pollTransportDocumentsSweep;
  app.post("/api/master-bl/poll-sweep", requireRole(["admin"]), async (req, res) => ok(res, await pollTransportDocumentsSweep({ olderThanMinutes: 0 })));
  const timer = setInterval(() => { pollTransportDocumentsSweep().catch(e => console.error("Master B/L poll sweep failed:", e.message)); }, TD_POLL_MINUTES * 60000);
  timer.unref?.();
};

module.exports.compareDraft = compareDraft;
module.exports.normalizeTransportDocumentState = normalizeTransportDocumentState;
