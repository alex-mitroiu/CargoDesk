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

const { normalizeTransportDocumentState, TD_STATUS_SPELLING } = require("../lib/carrier-integrations/dcsa-ebl-v3");

const REVIEW_TASK = "master_bl_draft";
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
    carrierStateAt: r.carrier_state_at || null, createdAt: r.created_at, updatedAt: r.updated_at,
  });

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
    if (existing && existing.status === status && (existing.payload || null) === payload && (existing.amended_status || "") === (state.amendedTransportDocumentStatus || ""))
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
          facts.received_for_shipment_date, facts.issue_date, facts.place_of_issue, state.amendedTransportDocumentStatus || "", feedback, now,
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
          si.carrier_code || "", si.si_reference || state.shippingInstructionsReference || "", state.amendedTransportDocumentStatus || "", feedback,
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
    if (status === "ISSUED" && existing?.status !== "ISSUED") {
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
    return { ...mapMaster(td), document: doc, comparison: compareDraft(await sentInstructions(shipmentId), doc, shipment || {}),
      events: events.map(e => ({ id: e.id, eventType: e.event_type, fromStatus: e.from_status, toStatus: e.to_status, detail: parse(e.detail) || {}, actor: e.actor, createdAt: e.created_at })) };
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
    await applyTransportDocumentState(si || { shipment_id: shipment.id, carrier_code: td.carrier_code, si_reference: td.shipping_instructions_reference, status: "" },
      r.state, { document: r.document, source: "poll", raw: r.raw, simulated: !!integ.row.is_simulator });
    ok(res, await view(shipment.id));
  });

  // ─── Polling: drafts and approvals the carrier hasn't been heard from about ─
  const TD_POLL_MINUTES = 15;
  async function pollTransportDocumentsSweep({ olderThanMinutes = TD_POLL_MINUTES } = {}) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60000).toISOString();
    const rows = await query(`SELECT t.*, si.id AS si_id FROM transport_documents t JOIN shipping_instructions si ON si.shipment_id = t.shipment_id
      WHERE t.role='MASTER' AND t.status IN ('DRAFT','APPROVED','ISSUED','PENDING_SURRENDER_FOR_DELIVERY','PENDING_SURRENDER_FOR_AMENDMENT')
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
