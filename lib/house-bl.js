"use strict";

// House Bill of Lading as a DCSA transport document (Epic TKT-C7EBU3; plan and gap analysis
// https://claude.ai/artifact/FF9eMZXXMLHdJkCk5abaoU; ARCHITECTURE.md §8.40). The BL01 PDF stays the
// printed copy; this module keeps the record behind it (transport_documents) in DCSA eBL 3.0 terms:
//   - DRAFT when a BL01 draft is generated, ISSUED when it is confirmed, VOIDED with a reason,
//     SURRENDERED_FOR_DELIVERY when the originals come back (or the eBL is surrendered), and released
//     as CargoDesk's own fact after that;
//   - readiness: what a House B/L needs before it can be issued (gap G4);
//   - shipped on board or received for shipment, from the loading facts (gap G8, decision D2);
//   - the release checks: collect charges paid, consignee not on credit hold, originals surrendered,
//     with a finance override (gap G19, decision D3);
//   - the DCSA TransportDocument as issued, checked against the vendored eBL 3.0 spec (gap G23),
//     which the eBL issuance (lib/ebl.js, gap G24) sends.

const { validateOutboundSchema, errorsText } = require("./dcsa/validate");
const { containerIso, dcsaSeals } = require("./dcsa/codes");
const { mainLegIndex } = require("./mainLeg");
const { timezoneFor } = require("./timezones");

const HOUSE_BL = "BL01";
// Issued or in a surrender: the one House B/L a shipment can hold at a time.
const LIVE = ["ISSUED", "PENDING_SURRENDER_FOR_DELIVERY", "SURRENDERED_FOR_DELIVERY", "PENDING_SURRENDER_FOR_AMENDMENT"];
const TYPE_CODE_OF_RELEASE = { "Original": "BOL", "Telex Release": "BOL", "Surrendered": "BOL", "Seaway Bill": "SWB" };
// UN/ECE Recommendation 21 package codes CargoDesk offers (DCSA OuterPackaging.packageCode).
const PACKAGE_CODES = Object.freeze({
  CT: "Carton", BX: "Box", CS: "Case", PK: "Package", PX: "Pallet", BG: "Bag", SA: "Sack", DR: "Drum",
  BL: "Bale, compressed", BE: "Bundle", CR: "Crate", RO: "Roll", CY: "Cylinder", PL: "Pail", JR: "Jar",
  NE: "Unpacked or unpackaged",
});
// What the House B/L says on its face, and DCSA's termsAndConditions / carrierClauses for it.
const TERMS = "Received by the carrier from the shipper in apparent good order and condition unless otherwise noted, "
  + "the total number of containers or packages stated above, weight, measure, marks, numbers, quality, contents and "
  + "value unknown, for carriage subject to all the terms and conditions of the carrier's House Bill of Lading. "
  + "In accepting this Bill of Lading the shipper, consignee and holder agree to be bound by all its stipulations, "
  + "exceptions and conditions.";
const FCL_CLAUSES = ["SHIPPER'S LOAD, STOW AND COUNT", "SAID TO CONTAIN"];
// Consignee on the B/L (gap G11): '' straight, CONSIGNEE "to order of" the consignee, SHIPPER "to order".
const TO_ORDER_MODES = ["", "CONSIGNEE", "SHIPPER"];
// Originals and copies (gap G12) when the panel sends none: a paper B/L in a set of three, a Sea
// Waybill has no originals, an eBL is one.
const DEFAULT_ORIGINALS = { BOL: 3, SWB: 0 };
// A series prefix an admin sets (gap G5): letters and digits, so the number stays one token.
const PREFIX_RE = /^[A-Z0-9]{2,10}$/;
// Leg "Movement by" → DCSA preCarriageBy / onCarriageBy.
const CARRIAGE_BY = { Truck: "TRUCK", Rail: "RAIL", Barge: "BARGE", Vessel: "VESSEL" };
// What the issued DCSA document says that the House B/L shows, compared with today's shipment data
// (gap G6: a change after issue leaves a trace and asks for an amendment).
const ISSUED_FIELDS = [
  ["documentParties.shipper", "Shipper"], ["documentParties.consignee", "Consignee"],
  ["documentParties.notifyParties", "Notify party"], ["isToOrder", "To order"],
  ["transportDocumentTypeCode", "Release type (B/L or Sea Waybill)"], ["freightPaymentTermCode", "Freight terms"],
  ["transports.portOfLoading", "Port of loading"], ["transports.portOfDischarge", "Port of discharge"],
  ["transports.placeOfReceipt", "Place of receipt"], ["transports.placeOfDelivery", "Place of delivery"],
  ["transports.vesselVoyages", "Vessels and voyages"], ["transports.preCarriageBy", "Pre-carriage"],
  ["transports.onCarriageBy", "On-carriage"], ["consignmentItems", "Cargo: description, HS codes, marks, packages, weights"],
  ["utilizedTransportEquipments", "Containers, seals, reefer settings"], ["declaredValue", "Declared value"],
];

const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);
const dateOnly = v => (v ? String(v).slice(0, 10) : null);
const actorOf = user => user?.name || user?.email || "";
const fmtDay = d => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
// A date as the place itself counts it (audit L2, 2026-10-29): the issuing office's day for the issue date,
// the port of loading's for the loading. UTC when the place has no known zone.
const localDay = (unlocode, at = new Date()) => {
  const tz = unlocode ? timezoneFor({ unlocode }) : null;
  try { return tz ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at) : at.toISOString().slice(0, 10); }
  catch { return at.toISOString().slice(0, 10); }
};
const parseJson = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
// Clauses added to a House B/L (audit L4): up to 10, each one line.
const MAX_EXTRA_CLAUSES = 10;
const extraClausesOf = v => (Array.isArray(v) ? v : String(v || "").split(/\r?\n/)).map(x => clip(x, 300)).filter(Boolean);
// "BL01-<number>-<date>.html|pdf" (GenerateDocumentModal) → the number printed when the shipment had none.
const refFromFilename = filename => {
  const m = String(filename || "").match(/^BL01-(.+)-\d{4}-\d{2}-\d{2}\.(?:html|pdf)$/i);
  return m ? m[1] : String(filename || "").replace(/\.(html|pdf)$/i, "");
};
// DCSA string fields: trimmed, no leading/trailing space, at most `max` characters.
const clip = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max).trim();
// Split text into DCSA's 35-character lines (descriptionOfGoods, shippingMarks).
const lines35 = text => {
  const out = [];
  for (const para of String(text || "").split(/\r?\n/)) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      for (let w = word; w.length; ) {
        if (!cur) { cur = w.slice(0, 35); w = w.slice(35); }
        else if (cur.length + 1 + w.length <= 35) { cur += ` ${w}`; w = ""; }
        else { out.push(cur); cur = ""; }
      }
    }
    if (cur) out.push(cur);
  }
  return out;
};
// Same rule as the booking adapter (dcsa-bkg-v2): "Door-to-Port" → SD at origin, CY at destination.
const receiptDeliveryTypes = serviceType => {
  const [from, to] = String(serviceType || "Port-to-Port").split(/-to-/i);
  const t = s => (/door/i.test(s || "") ? "SD" : "CY");
  return { receiptTypeAtOrigin: t(from), deliveryTypeAtDestination: t(to) };
};
// CargoDesk customer identifiers → DCSA: legal-entity codes become identifyingCodes, tax numbers
// taxLegalReferences. Platform ids (WAVE, CARX, …) are identifyingCodes under their own provider.
const IDENTIFYING = { LEI: ["GLEIF", "LEI"], DUNS: ["DNB", "DUNS"], FMC: ["FMC", null], DID: ["W3C", "DID"] };
const PLATFORMS = ["WAVE", "CARX", "IDT", "BOLE", "EDOX", "IQAX", "SECR", "TRGO", "ETEU", "TRAC", "BRIT", "COVA", "ETIT", "KTNE", "CRED", "BLOC", "DOCU", "AEOT", "SGTD", "GSBN", "WISE", "DCSA"];
const TAX_TYPES = ["VAT", "EORI", "TIN", "EIN", "GST", "CNPJ", "USCI"];

function createHouseBl(ctx) {
  const { query, transaction, uid, logEvent, autoCompleteMilestone, getCustomerRow, getSettings, callCustomerService, billingHolds } = ctx;

  // ─── The record ────────────────────────────────────────────────────────────
  const mapTransportDocument = r => r && ({
    id: r.id, shipmentId: r.shipment_id, role: r.role, reference: r.reference, version: r.version,
    supersedesId: r.supersedes_id || null, status: r.status, typeCode: r.type_code, releaseType: r.release_type || "",
    isElectronic: !!r.is_electronic, isToOrder: !!r.is_to_order,
    isShippedOnBoardType: !!r.is_shipped_on_board_type, shippedOnBoardDate: r.shipped_on_board_date || null,
    onBoardSource: r.on_board_source || "", receivedForShipmentDate: r.received_for_shipment_date || null,
    issueDate: r.issue_date || null, placeOfIssue: r.place_of_issue || "", issuingOfficeId: r.issuing_office_id || null,
    documentId: r.document_id || null, hasPayload: !!r.payload, payloadErrors: r.payload_errors || "",
    issuedAt: r.issued_at || null, issuedBy: r.issued_by || "",
    surrenderedAt: r.surrendered_at || null, surrenderedBy: r.surrendered_by || "", surrenderKind: r.surrender_kind || "",
    releasedAt: r.released_at || null, releasedBy: r.released_by || "", releaseOverrideReason: r.release_override_reason || "",
    voidedAt: r.voided_at || null, voidedBy: r.voided_by || "", voidReason: r.void_reason || "",
    eblPlatform: r.ebl_platform || "", eblIssueTo: r.ebl_issue_to ? JSON.parse(r.ebl_issue_to) : null,
    eblIssuanceStatus: r.ebl_issuance_status || "", eblIssuanceReason: r.ebl_issuance_reason || "",
    eblRequestedAt: r.ebl_requested_at || null, eblRespondedAt: r.ebl_responded_at || null,
    migratedFromDocumentId: r.migrated_from_document_id || null,
    numberSource: r.number_source || "", toOrderMode: r.to_order_mode || "",
    originals: r.originals_count ?? null, copies: r.copies_count ?? null, withCharges: !!r.with_charges,
    amendmentReason: r.amendment_reason || "", telexNoticeTicketId: r.telex_notice_ticket_id || null,
    // The on-board notation on a received-for-shipment B/L (audit M4), the clauses added (L4), the shipper's
    // approval of the draft (L3) — for the draft it was sent with; a later draft makes it STALE.
    onBoardNotationDate: r.on_board_notation_date || null, onBoardNotationAt: r.on_board_notation_at || null, onBoardNotationBy: r.on_board_notation_by || "",
    extraClauses: parseJson(r.extra_clauses) || [],
    approval: r.approval_status ? {
      status: r.approval_document_id && r.approval_document_id !== r.document_id ? "STALE" : r.approval_status,
      sentTo: r.approval_sent_to || "", sentAt: r.approval_sent_at || null, sentBy: r.approval_sent_by || "", emailed: !!r.approval_emailed,
      answeredAt: r.approval_answered_at || null, answeredBy: r.approval_answered_by || "", comment: r.approval_comment || "",
    } : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });

  async function event(q, td, type, from, to, detail = {}, actor = "") {
    await q.query(`INSERT INTO transport_document_events (id, transport_document_id, shipment_id, event_type, from_status, to_status, detail, actor, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [`TDE-${uid()}${uid()}`, td.id, td.shipment_id, type, from || "", to || "", JSON.stringify(detail), actor, nowIso()]);
  }
  const Q = { query };

  const houseDocs = shipmentId => query(
    "SELECT * FROM transport_documents WHERE shipment_id=$1 AND role='HOUSE' ORDER BY created_at DESC, version DESC", [shipmentId]);
  async function liveHouse(shipmentId, q = Q) {
    const [r] = await q.query(`SELECT * FROM transport_documents WHERE shipment_id=$1 AND role='HOUSE' AND status IN (${LIVE.map(s => `'${s}'`).join(",")})`, [shipmentId]);
    return r || null;
  }
  async function draftHouse(shipmentId, q = Q) {
    const [r] = await q.query("SELECT * FROM transport_documents WHERE shipment_id=$1 AND role='HOUSE' AND status='DRAFT'", [shipmentId]);
    return r || null;
  }
  // The version waiting for its amended successor (G6): surrendered for amendment, and no later
  // version (draft or issued) points at it yet. The next draft or issue becomes its version + 1.
  async function amendmentOf(shipmentId, q = Q) {
    const [r] = await q.query(`SELECT * FROM transport_documents t WHERE t.shipment_id=$1 AND t.role='HOUSE' AND t.status='SURRENDERED_FOR_AMENDMENT'
      AND NOT EXISTS (SELECT 1 FROM transport_documents n WHERE n.supersedes_id=t.id) ORDER BY t.version DESC LIMIT 1`, [shipmentId]);
    return r || null;
  }

  // ─── B/L number series per issuing office (G5, D1) ─────────────────────────
  // prefix + 2-digit year + 5-digit sequence (RTMHBL2600123), unique across CargoDesk: a number used
  // anywhere, voided ones included, is skipped and never handed out again.
  const seriesPrefix = office => (office?.hbl_prefix
    || `${String(office?.unlocode || "").slice(2) || String(office?.code || "CD").replace(/[^A-Z0-9]/gi, "").slice(0, 5)}HBL`).toUpperCase();
  const seriesYear = () => Number(today().slice(2, 4));
  const formatSeries = (prefix, year, seq) => `${prefix}${String(year).padStart(2, "0")}${String(seq).padStart(5, "0")}`;
  const numberTaken = async (ref, q = Q) =>
    !!(await q.query("SELECT 1 FROM transport_documents WHERE reference=$1 LIMIT 1", [ref]))[0]
    || !!(await q.query("SELECT 1 FROM shipments WHERE bl_number=$1 LIMIT 1", [ref]))[0];
  // The number the office's next issue would take, without taking it (the office page, the panel).
  async function nextSeriesNumber(office) {
    if (!office) return null;
    const year = seriesYear(), prefix = seriesPrefix(office);
    let seq = Number(office.hbl_seq_year) === year ? Number(office.hbl_next_seq) || 1 : 1;
    for (let i = 0; i < 1000 && (await numberTaken(formatSeries(prefix, year, seq))); i++) seq++;
    return formatSeries(prefix, year, seq);
  }
  async function takeSeriesNumber(officeId, q) {
    const year = seriesYear();
    for (let i = 0; i < 1000; i++) {
      const [o] = await q.query(`UPDATE offices SET hbl_next_seq = CASE WHEN hbl_seq_year IS DISTINCT FROM $2 THEN 2 ELSE hbl_next_seq + 1 END,
        hbl_seq_year=$2 WHERE id=$1 RETURNING *`, [officeId, year]);
      if (!o) return null;
      const ref = formatSeries(seriesPrefix(o), year, o.hbl_next_seq - 1);
      if (!(await numberTaken(ref, q))) return ref;
    }
    throw new Error("No free number left in the office's House B/L series this year");
  }
  // The number the House B/L is issued under: the shipment's own (typed, or kept from the version an
  // amendment replaces), else the next from the export office's series, taken now and kept on the
  // shipment (bl_number_source SERIES) so an issue that fails part-way reuses it.
  async function assignNumber(shipmentId, user) {
    if (await liveHouse(shipmentId)) return { error: "This shipment already has an issued House B/L", status: 409 };
    const r = await transaction(async tx => {
      const [s] = await tx.query("SELECT * FROM shipments WHERE id=$1 FOR UPDATE", [shipmentId]);
      if (!s) return { error: "Shipment not found", status: 404 };
      if (s.bl_number) return { number: s.bl_number, source: s.bl_number_source === "SERIES" ? "SERIES" : "TYPED" };
      if (!s.emo_office_id) return { error: "The shipment has no export office to take a B/L number from: set one (Parties & Offices), or type the number on Conditions", status: 409 };
      const number = await takeSeriesNumber(s.emo_office_id, tx);
      if (!number) return { error: "The shipment's export office wasn't found", status: 409 };
      await tx.query("UPDATE shipments SET bl_number=$1, bl_number_source='SERIES' WHERE id=$2", [number, shipmentId]);
      return { number, source: "SERIES", assigned: true };
    });
    if (r.assigned) await logEvent(shipmentId, "FIELD_UPDATED", "bl_number", null, r.number, JSON.stringify({ source: "House B/L number series" }), actorOf(user));
    return r;
  }
  // Where a number came from, as the record keeps it.
  const sourceOf = (s, reference) => (reference && reference === s?.bl_number && s?.bl_number_source === "SERIES" ? "SERIES" : "TYPED");

  // Originals and copies (G12), and whether the charges print on them (G14). → the columns, or { error }.
  function countsOf(claim, typeCode) {
    const int = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
    const originals = int(claim?.originals, DEFAULT_ORIGINALS[typeCode] ?? 0), copies = int(claim?.copies, 0);
    if (!Number.isInteger(originals) || !Number.isInteger(copies)) return { error: "Originals and copies are whole numbers" };
    if (typeCode === "SWB" && originals !== 0) return { error: "A Sea Waybill has no originals" };
    if (typeCode !== "SWB" && (originals < 1 || originals > 9)) return { error: "A B/L is issued in 1 to 9 originals" };
    if (copies < 0 || copies > 20) return { error: "Copies: 0 to 20" };
    return { originals_count: originals, copies_count: copies, with_charges: !!claim?.withCharges };
  }

  // The shipment's selling charges, as a B/L "with charges" prints them (G14): SELL lines not reversed.
  async function chargesOf(shipmentId) {
    const rows = await query(`SELECT l.*, d.label FROM shipment_cost_lines l LEFT JOIN charge_code_definitions d ON d.code = l.charge_code
      WHERE l.shipment_id=$1 AND l.type='SELL' AND l.amount > 0 AND l.adjusts_cost_line_id IS NULL
        AND l.id NOT IN (SELECT adjusts_cost_line_id FROM shipment_cost_lines WHERE adjusts_cost_line_id IS NOT NULL)
      ORDER BY l.created_at, l.id`, [shipmentId]);
    return rows.map(l => ({ code: l.charge_code, name: l.label || l.charge_code, currency: l.currency || "USD",
      amount: Math.round(Number(l.amount) * 100) / 100, paymentTerm: l.payment_indicator === "Collect" ? "COL" : "PRE" }));
  }

  // The carriage the House B/L covers (G16): every sea leg with its vessel, the first one the first
  // sea-going vessel and the main one (lib/mainLeg.js) the mother vessel, and the pre-/on-carriage
  // when the leg is carrier's haulage. Shipments with no legs fall back to the shipment's own vessel.
  async function routingOf(s) {
    const legs = await query("SELECT * FROM shipment_legs WHERE shipment_id=$1 ORDER BY leg_order, created_at", [s.id]);
    const sea = legs.filter(l => (l.leg_type ? l.leg_type === "SEA" : l.mot === "SEA") && l.vessel && l.voyage);
    const main = mainLegIndex(sea);
    const vessels = sea.length
      ? sea.map((l, i) => ({ vessel: l.vessel, voyage: l.voyage, pol: l.pol, pod: l.pod, etd: dateOnly(l.etd), eta: dateOnly(l.eta),
        role: i === 0 ? "FIRST_SEA_GOING" : i === main ? "MOTHER" : "" }))
      : (s.vessel && s.voyage ? [{ vessel: s.vessel, voyage: s.voyage, pol: s.pol, pod: s.pod, etd: dateOnly(s.etd), eta: dateOnly(s.eta), role: "FIRST_SEA_GOING" }] : []);
    const carrierLeg = (l, type) => l && l.leg_type === type && l.movement_type === "Carrier's Haulage";
    const by = l => CARRIAGE_BY[l.movement_by] || "TRUCK";
    const first = legs[0], last = legs[legs.length - 1];
    return {
      vessels,
      preCarriageBy: carrierLeg(first, "Pick-up") ? by(first) : "",
      onCarriageBy: carrierLeg(last, "Delivery") && legs.length > 1 ? by(last) : "",
      transshipmentPorts: sea.slice(1).map(l => l.pol).filter(Boolean),
    };
  }

  // ─── Shipped on board or received for shipment (G8, D2) ────────────────────
  // On board once EVERY container is (audit M1, 2026-10-29 — it used to take the first container loaded, so a
  // rolled container still read as shipped): each container's first Loaded (else Sailed) event, the B/L dated
  // by the last of them; with no loading recorded for any container, the completed Vessel Departed milestone.
  // Dates are the port of loading's own (L2).
  async function onBoardFacts(shipmentId) {
    const [s] = await query("SELECT pol FROM shipments WHERE id=$1", [shipmentId]);
    const ctrs = await query("SELECT id, container_number FROM containers WHERE shipment_id=$1 ORDER BY container_number, id", [shipmentId]);
    const evs = await query(`SELECT container_id, event_type, occurred_at FROM container_events WHERE shipment_id=$1 AND event_type IN ('Loaded','Sailed','Gate In')
      ORDER BY occurred_at`, [shipmentId]);
    const aboard = new Map();
    for (const e of evs) if (e.event_type === "Loaded" && !aboard.has(e.container_id)) aboard.set(e.container_id, e);
    for (const e of evs) if (e.event_type === "Sailed" && !aboard.has(e.container_id)) aboard.set(e.container_id, e);
    const loaded = ctrs.filter(c => aboard.has(c.id));
    const notLoaded = ctrs.filter(c => !aboard.has(c.id)).map(c => c.container_number || c.id);
    const last = ctrs.length && !notLoaded.length ? loaded.map(c => aboard.get(c.id)).sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))[0] : null;
    const gateIn = evs.find(e => e.event_type === "Gate In");
    const [departed] = loaded.length ? [] : await query("SELECT completed_at FROM shipment_milestones WHERE shipment_id=$1 AND milestone_key='vessel_departed' AND completed_at<>''", [shipmentId]);
    const hit = last ? [last.event_type === "Loaded" ? "Loaded event" : "Sailed event", last.occurred_at] : departed ? ["Vessel Departed milestone", departed.completed_at] : null;
    return {
      shippedOnBoard: !!hit, onBoardDate: hit ? localDay(s?.pol, new Date(hit[1])) : null, onBoardSource: hit ? hit[0] : null,
      receivedDate: gateIn ? localDay(s?.pol, new Date(gateIn.occurred_at)) : null,
      containers: ctrs.length, loaded: loaded.length, notLoaded,
    };
  }

  // What a BL01 draft prints about loading. `claim` comes from the client that built the PDF
  // ({ shippedOnBoard, onBoardDate, onBoardDateTyped }); a client that sends none prints the
  // pre-2026-10-21 text, which always said SHIPPED ON BOARD. A shipped-on-board draft with no loading
  // recorded can be generated (a draft to approve) but not issued.
  async function draftStatement(shipmentId, claim) {
    const facts = await onBoardFacts(shipmentId);
    const [s] = await query("SELECT bl_release_type FROM shipments WHERE id=$1", [shipmentId]);
    const counts0 = countsOf(claim, TYPE_CODE_OF_RELEASE[s?.bl_release_type] || "BOL");
    if (counts0.error) return counts0;
    // Clauses the shipper or a letter of credit asks for (audit L4); a client that sends none keeps none.
    const extra = extraClausesOf(claim?.clauses);
    if (extra.length > MAX_EXTRA_CLAUSES) return { error: `At most ${MAX_EXTRA_CLAUSES} added clauses` };
    const counts = { ...counts0, extra_clauses: extra.length ? JSON.stringify(extra) : "" };
    const onBoard = claim?.shippedOnBoard ?? true;
    if (!onBoard) return { is_shipped_on_board_type: false, shipped_on_board_date: null, on_board_source: "", ...counts };
    if (claim?.onBoardDateTyped && /^\d{4}-\d{2}-\d{2}$/.test(claim.onBoardDate || "")) {
      if (claim.onBoardDate > today()) return { error: "The on-board date can't be in the future" };
      return { is_shipped_on_board_type: true, shipped_on_board_date: claim.onBoardDate, on_board_source: "Typed", ...counts };
    }
    return { is_shipped_on_board_type: true, shipped_on_board_date: facts.onBoardDate, on_board_source: facts.onBoardSource || "", ...counts };
  }

  // A BL01 draft was generated (routes/shipment-ops.js, inside its insert transaction): the shipment's
  // House draft now points at it, created if there is none. Its number is the shipment's (blank = the
  // draft printed "assigned at issue"); after a surrender for amendment it is the next version.
  async function onDraftGenerated(tx, { shipmentId, docId, statement, actor }) {
    const [s] = await tx.query("SELECT bl_number, bl_number_source, bl_release_type, bl_to_order FROM shipments WHERE id=$1", [shipmentId]);
    const prev = await amendmentOf(shipmentId, tx);
    const draft = await draftHouse(shipmentId, tx);
    // An amending version keeps the number of the version it replaces.
    const kept = prev || (draft?.supersedes_id ? (await tx.query("SELECT * FROM transport_documents WHERE id=$1", [draft.supersedes_id]))[0] : null);
    const reference = clip(kept?.reference || s?.bl_number || "", 20);
    const now = nowIso();
    const facts = [statement.is_shipped_on_board_type, statement.shipped_on_board_date, statement.on_board_source,
      reference ? (kept?.number_source || sourceOf(s, reference)) : "", s?.bl_to_order || "", !!s?.bl_to_order,
      statement.originals_count, statement.copies_count, !!statement.with_charges];
    if (draft) {
      await tx.query(`UPDATE transport_documents SET document_id=$1, reference=$2, release_type=$3, type_code=$4, is_shipped_on_board_type=$5,
        shipped_on_board_date=$6, on_board_source=$7, number_source=$8, to_order_mode=$9, is_to_order=$10, originals_count=$11, copies_count=$12,
        with_charges=$13, updated_at=$14, extra_clauses=$16 WHERE id=$15`,
        [docId, reference, s?.bl_release_type || "", TYPE_CODE_OF_RELEASE[s?.bl_release_type] || "BOL", ...facts, now, draft.id, statement.extra_clauses || ""]);
      // A draft made before the surrender for amendment becomes the amending version.
      if (prev && !draft.supersedes_id)
        await tx.query("UPDATE transport_documents SET version=$1, supersedes_id=$2 WHERE id=$3", [prev.version + 1, prev.id, draft.id]);
      await event(tx, draft, "REDRAFTED", "DRAFT", "DRAFT", { documentId: docId, reference }, actor);
      return draft.id;
    }
    const id = `TD-${uid()}${uid()}`;
    await tx.query(`INSERT INTO transport_documents (id, shipment_id, role, reference, status, type_code, release_type, is_shipped_on_board_type,
      shipped_on_board_date, on_board_source, number_source, to_order_mode, is_to_order, originals_count, copies_count, with_charges,
      document_id, version, supersedes_id, created_at, updated_at, extra_clauses)
      VALUES ($1,$2,'HOUSE',$3,'DRAFT',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19)`,
      [id, shipmentId, reference, TYPE_CODE_OF_RELEASE[s?.bl_release_type] || "BOL", s?.bl_release_type || "", ...facts, docId,
        prev ? prev.version + 1 : 1, prev?.id || null, now, statement.extra_clauses || ""]);
    await event(tx, { id, shipment_id: shipmentId }, "DRAFTED", "", "DRAFT",
      { documentId: docId, reference, ...(prev && { version: prev.version + 1, amends: prev.id }) }, actor);
    return id;
  }

  // A draft BL01 was deleted, or replaced by a newer one: a House draft left pointing at nothing goes.
  async function onDraftDocumentGone(docId, q = Q) {
    const rows = await q.query("SELECT * FROM transport_documents WHERE document_id=$1 AND status='DRAFT'", [docId]);
    for (const r of rows) {
      await q.query("DELETE FROM transport_document_events WHERE transport_document_id=$1", [r.id]);
      await q.query("DELETE FROM transport_documents WHERE id=$1", [r.id]);
    }
  }

  // ─── Parties ───────────────────────────────────────────────────────────────
  async function identifiersOf(customerId) {
    if (!customerId) return [];
    try {
      if (((await getSettings()).customer_source || "local") === "remote")
        return (await callCustomerService("GET", `/internal/customers/${customerId}/identifiers`)) || [];
    } catch { return []; }
    const rows = await query("SELECT * FROM customer_identifiers WHERE customer_id=$1 ORDER BY is_primary DESC, created_at", [customerId]);
    return rows.map(r => ({ idType: r.id_type, idCode: r.id_code, countryIso2: r.country_iso2 || "" }));
  }
  const hasAddress = c => !!(c && String(c.address1 || "").trim() && String(c.city || "").trim() && /^[A-Z]{2}$/.test(c.countryIso2 || ""));
  async function dcsaParty(customer, fallbackName) {
    const ids = await identifiersOf(customer?.id);
    const identifyingCodes = [], taxLegalReferences = [];
    for (const i of ids) {
      const t = String(i.idType || "").toUpperCase(), code = clip(i.idCode, 150);
      if (!code) continue;
      if (IDENTIFYING[t]) identifyingCodes.push({ codeListProvider: IDENTIFYING[t][0], partyCode: code, ...(IDENTIFYING[t][1] && { codeListName: IDENTIFYING[t][1] }) });
      else if (PLATFORMS.includes(t)) identifyingCodes.push({ codeListProvider: t, partyCode: code });
      else if ((TAX_TYPES.includes(t) || t === "TAX ID") && /^[A-Z]{2}$/.test(i.countryIso2 || customer?.countryIso2 || ""))
        taxLegalReferences.push({ type: t === "TAX ID" ? "TIN" : t, countryCode: i.countryIso2 || customer.countryIso2, value: clip(code, 35) });
    }
    return {
      partyName: clip(customer?.companyName || fallbackName, 70),
      ...(hasAddress(customer) && { address: {
        street: clip(customer.address1, 70), ...(customer.postalCode && { postCode: clip(customer.postalCode, 10) }),
        city: clip(customer.city, 35), ...(customer.state && { stateRegion: clip(customer.state, 65) }), countryCode: customer.countryIso2,
      } }),
      ...(identifyingCodes.length && { identifyingCodes }),
      ...(taxLegalReferences.length && { taxLegalReferences }),
    };
  }

  // The issuing party: the legal entity (branch) of the shipment's export office.
  async function issuingEntity(s) {
    if (!s.emo_office_id) return { office: null, branch: null };
    const [office] = await query("SELECT * FROM offices WHERE id=$1", [s.emo_office_id]);
    const [branch] = office?.branch_id ? await query("SELECT * FROM branches WHERE id=$1", [office.branch_id]) : [];
    return { office: office || null, branch: branch || null };
  }

  async function shipmentData(shipmentId) {
    const [s] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
    if (!s) return null;
    const containers = await query("SELECT * FROM containers WHERE shipment_id=$1 ORDER BY container_number, id", [shipmentId]);
    const [booking] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipmentId]);
    const [aes] = await query("SELECT * FROM customs_filings WHERE shipment_id=$1 AND filing_type='AES_EEI'", [shipmentId]);
    const shipper = await getCustomerRow(s.shipper_id), consignee = await getCustomerRow(s.consignee_id), notify = await getCustomerRow(s.notify_id);
    const { office, branch } = await issuingEntity(s);
    return { s, containers, booking: booking || null, aes: aes || null, shipper, consignee, notify, office, branch,
      routing: await routingOf(s), charges: await chargesOf(shipmentId) };
  }

  // ─── Readiness: what blocks issue (G4) ─────────────────────────────────────
  // Plain words, one entry per thing to fix. The server refuses issue with this list; the House B/L
  // panel will show it.
  async function readiness(shipmentId, { td = null } = {}) {
    const d = await shipmentData(shipmentId);
    if (!d) return { ready: false, missing: ["The shipment"], facts: null };
    const { s, containers, booking, aes, shipper, consignee } = d;
    const missing = [];
    const partyLine = (label, id, name, c) => {
      if (!id && !name) missing.push(label);
      else if (!hasAddress(c)) missing.push(`${label}'s address: street, city and country on ${c?.companyName || name} (Customers)`);
    };
    partyLine("Shipper", s.shipper_id, s.shipper_name, shipper);
    // "To order" (of the shipper) names no consignee on the B/L (G11); straight and "to order of" do.
    if (s.bl_to_order !== "SHIPPER") partyLine("Consignee", s.consignee_id, s.consignee_name, consignee);
    if (s.bl_to_order && TYPE_CODE_OF_RELEASE[s.bl_release_type] === "SWB")
      missing.push("A Sea Waybill can't be issued to order: choose a named consignee, or another release type (Conditions)");
    if (!s.notify_id && !s.notify_name) missing.push("Notify party (Parties & Offices)");
    if (!s.pol || !s.pod) missing.push("Port of loading and port of discharge");
    if (!s.vessel || !s.voyage) missing.push("Vessel and voyage");
    if (!booking || booking.status !== "Confirmed" || !s.booking_ref) missing.push("A carrier booking confirmed by the carrier, with its booking number");
    if (!s.bl_release_type) missing.push("Release type (Conditions page)");
    if (aes && aes.status !== "Accepted") missing.push("The AES/EEI export filing accepted, with its ITN (Customs Filing)");
    if (!containers.length) missing.push("At least one container");
    for (const c of containers) {
      const gaps = [];
      if (!c.container_number || /^TBC$/i.test(c.container_number)) gaps.push("container number");
      if (!String(c.seal_number || "").trim()) gaps.push("seal number");
      if (!(Number(c.number_of_packages) > 0)) gaps.push("number of packages");
      if (!c.package_code && !String(c.package_description || "").trim()) gaps.push("kind of packages");
      if (!(Number(c.gross_weight_kg) > 0)) gaps.push("gross weight");
      if (!String(c.cargo_description || "").trim()) gaps.push("cargo description");
      if (!/^\d{6,10}$/.test(String(c.hs_code || "").replace(/\D/g, ""))) gaps.push("HS code (6–10 digits)");
      // Dangerous goods (G17): the B/L states the UN number, the proper shipping name and the class.
      if (c.is_dg) {
        if (!/^\d{4}$/.test(String(c.dg_un_number || "").trim())) gaps.push("UN number (dangerous goods)");
        if (!String(c.dg_proper_shipping_name || "").trim()) gaps.push("proper shipping name (dangerous goods)");
        if (!String(c.dg_class || "").trim()) gaps.push("IMO class (dangerous goods)");
      }
      if (gaps.length) missing.push(`Container ${c.container_number || `${c.size}' ${c.type}`}: ${gaps.join(", ")}`);
    }
    const facts = await onBoardFacts(shipmentId);
    if (td?.is_shipped_on_board_type && !td.shipped_on_board_date && !facts.shippedOnBoard)
      missing.push(facts.loaded
        ? `Loading: ${facts.loaded} of ${facts.containers} containers loaded (${facts.notLoaded.join(", ")} ${facts.notLoaded.length === 1 ? "isn't" : "aren't"}): issue it Received for shipment, or wait`
        : "Loading: the draft says Shipped on board, but no Loaded or Sailed event is recorded. Record it, or issue a Received for shipment draft");
    // The issuer, as the DCSA document names it (audit M2): the export office's legal entity, by its SCAC,
    // with an address. Without them the document doesn't validate and an eBL or the Master's instructions fail later.
    if (d.office && !d.branch) missing.push(`A legal entity on the export office ${d.office.name} (Organisation → Offices): the B/L names its issuer`);
    else if (d.branch) {
      const gaps = [!String(d.branch.scac || "").trim() && "a SCAC", !(d.branch.address && d.branch.city && d.branch.country_code) && "a street address and city"].filter(Boolean);
      if (gaps.length) missing.push(`The export office's legal entity ${d.branch.name} needs ${gaps.join(" and ")} (Organisation → Branches): the B/L names its issuer by them`);
    }
    const reference = td?.reference || s.bl_number || "";
    if (reference) {
      if (reference.length > 20) missing.push(`B/L number ${reference}: at most 20 characters`);
      // Unique across CargoDesk (D1): a number another shipment holds, issued or voided, isn't reused.
      const [taken] = await query(`SELECT shipment_id FROM transport_documents WHERE role='HOUSE' AND reference=$1 AND shipment_id<>$2
        UNION SELECT id AS shipment_id FROM shipments WHERE bl_number=$1 AND id<>$2 LIMIT 1`, [reference, shipmentId]);
      if (taken) missing.push(`B/L number ${reference} is already used by ${taken.shipment_id}`);
    } else if (!d.office) missing.push("B/L number: type it on Conditions, or set the export office so it is taken from that office's series");
    // Where the number comes from, for the panel: the shipment's own, or the office series at issue.
    const number = reference
      ? { value: reference, source: td?.number_source || sourceOf(s, reference) }
      : { value: null, source: "SERIES", next: await nextSeriesNumber(d.office), officeName: d.office?.name || "" };
    return { ready: missing.length === 0, missing, facts, number };
  }

  // ─── The DCSA TransportDocument (G23) ──────────────────────────────────────
  // Dangerous goods on a container (G17), as DCSA DangerousGoods: UN number, proper shipping name, class.
  const dgOf = c => (c.is_dg && /^\d{4}$/.test(String(c.dg_un_number || "").trim()) && String(c.dg_proper_shipping_name || "").trim() && c.dg_class
    ? { UNNumber: String(c.dg_un_number).trim(), properShippingName: clip(c.dg_proper_shipping_name, 250), imoClass: clip(c.dg_class, 4) } : null);
  async function buildDcsaDocument(td, d) {
    const { s, containers, shipper, consignee, notify, office, branch, routing, charges } = d;
    const rd = receiptDeliveryTypes(s.service_type);
    const typeCode = td.type_code || "BOL";
    const onBoard = !!td.is_shipped_on_board_type;
    // To order (G11): DCSA isToOrder; "to order" of the shipper names no consignee (consignee and
    // endorsee are mutually exclusive, and a blank-endorsed B/L has neither). Never on a Sea Waybill.
    const toOrder = typeCode !== "SWB" && !!td.is_to_order;
    const namesConsignee = !(toOrder && td.to_order_mode === "SHIPPER");
    // Originals and copies (G12), with or without the charges (G14). An eBL is one original, no copies.
    const originals = td.originals_count ?? DEFAULT_ORIGINALS[typeCode] ?? 0, copies = td.copies_count ?? 0, wc = !!td.with_charges;
    const counts = typeCode === "SWB"
      ? { numberOfCopiesWithCharges: wc ? copies : 0, numberOfCopiesWithoutCharges: wc ? 0 : copies }
      : td.is_electronic
        ? { [wc ? "numberOfOriginalsWithCharges" : "numberOfOriginalsWithoutCharges"]: 1 }
        : { numberOfOriginalsWithCharges: wc ? originals : 0, numberOfOriginalsWithoutCharges: wc ? 0 : originals,
          numberOfCopiesWithCharges: wc ? copies : 0, numberOfCopiesWithoutCharges: wc ? 0 : copies };
    const vessels = routing?.vessels?.length ? routing.vessels : [{ vessel: s.vessel, voyage: s.voyage, role: "FIRST_SEA_GOING" }];
    const statementDate = onBoard ? td.shipped_on_board_date : td.received_for_shipment_date;
    // A received-for-shipment B/L with its on-board notation (audit M4) states both.
    const notation = !onBoard && td.on_board_notation_date ? td.on_board_notation_date : null;
    const extra = parseJson(td.extra_clauses) || [];
    const clauses = [...(s.movement_type !== "LCL" ? FCL_CLAUSES : []), ...extra];
    const issuingParty = {
      partyName: clip(branch?.name || office?.name || "CargoDesk", 70),
      ...(branch?.address && branch?.city && branch?.country_code && { address: {
        street: clip(branch.address, 70), city: clip(branch.city, 35), countryCode: String(branch.country_code).toUpperCase(),
      } }),
      ...(branch?.tax_registration_number && /^[A-Z]{2}$/.test(branch.country_code || "") && {
        taxLegalReferences: [{ type: "VAT", countryCode: branch.country_code.toUpperCase(), value: clip(branch.tax_registration_number, 35) }] }),
    };
    const doc = {
      transportDocumentReference: clip(td.reference, 20),
      transportDocumentStatus: td.status,
      transportDocumentTypeCode: typeCode,
      isShippedOnBoardType: onBoard,
      freightPaymentTermCode: s.freight_terms === "Collect" ? "COL" : "PRE",
      isElectronic: !!td.is_electronic,
      isToOrder: toOrder,
      ...counts,
      ...(onBoard && td.shipped_on_board_date && { shippedOnBoardDate: td.shipped_on_board_date }),
      ...(!onBoard && td.received_for_shipment_date && { receivedForShipmentDate: td.received_for_shipment_date }),
      ...(notation && { shippedOnBoardDate: notation }),
      ...(statementDate && { displayedShippedOnBoardReceivedForShipment: clip(`${onBoard ? "Shipped on board" : "Received for shipment"} ${fmtDay(statementDate)}${notation ? `; shipped on board ${fmtDay(notation)}` : ""}`, 250) }),
      termsAndConditions: TERMS,
      receiptTypeAtOrigin: rd.receiptTypeAtOrigin,
      deliveryTypeAtDestination: rd.deliveryTypeAtDestination,
      cargoMovementTypeAtOrigin: s.movement_type === "LCL" ? "LCL" : "FCL",
      cargoMovementTypeAtDestination: s.movement_type === "LCL" ? "LCL" : "FCL",
      ...(td.issue_date && { issueDate: td.issue_date }),
      ...(s.contract_ref && { serviceContractReference: clip(s.contract_ref, 30) }),
      ...(s.declared_value != null && /^[A-Z]{3}$/.test(s.declared_value_currency || "") && { declaredValue: Number(s.declared_value), declaredValueCurrency: s.declared_value_currency }),
      carrierCode: clip(branch?.scac || "", 4),
      carrierCodeListProvider: "NMFTA",
      ...(clauses.length && { carrierClauses: clauses }),
      transports: {
        plannedDepartureDate: dateOnly(s.etd), plannedArrivalDate: dateOnly(s.eta),
        portOfLoading: { UNLocationCode: s.pol }, portOfDischarge: { UNLocationCode: s.pod },
        ...(s.place_of_receipt && { placeOfReceipt: { locationName: clip(s.place_of_receipt, 100) } }),
        ...(s.place_of_delivery && { placeOfDelivery: { locationName: clip(s.place_of_delivery, 100) } }),
        ...(routing?.preCarriageBy && { preCarriageBy: routing.preCarriageBy }),
        ...(routing?.onCarriageBy && { onCarriageBy: routing.onCarriageBy }),
        vesselVoyages: vessels.map(v => ({ vesselName: clip(v.vessel, 50), carrierExportVoyageNumber: clip(v.voyage, 50), ...(v.role && { role: v.role }) })),
      },
      ...(wc && charges?.length && { charges: charges.map(c => ({ chargeName: clip(c.name, 50), currencyAmount: c.amount, currencyCode: c.currency,
        paymentTermCode: c.paymentTerm, calculationBasis: "Per shipment", unitPrice: c.amount, quantity: 1 })) }),
      ...(office?.unlocode ? { placeOfIssue: { UNLocationCode: office.unlocode } } : office?.country_code ? { placeOfIssue: { countryCode: office.country_code } } : {}),
      invoicePayableAt: { UNLocationCode: s.freight_terms === "Collect" ? s.pod : s.pol },
      partyContactDetails: [{ name: clip(office?.name || branch?.name || "CargoDesk", 35),
        ...(branch?.email && { email: clip(branch.email, 100) }), ...(branch?.phone && { phone: clip(branch.phone, 30) }) }],
      documentParties: {
        shipper: await dcsaParty(shipper, s.shipper_name),
        ...(namesConsignee && (s.consignee_id || s.consignee_name) && { consignee: await dcsaParty(consignee, s.consignee_name) }),
        issuingParty,
        ...((s.notify_id || s.notify_name) && { notifyParties: [await dcsaParty(notify, s.notify_name)] }),
      },
      consignmentItems: containers.map(c => ({
        carrierBookingReference: clip(s.booking_ref, 35),
        descriptionOfGoods: lines35(c.cargo_description),
        HSCodes: [String(c.hs_code || "").replace(/\D/g, "")],
        ...(c.marks_and_numbers && { shippingMarks: lines35(c.marks_and_numbers) }),
        cargoItems: [{
          equipmentReference: clip(c.container_number, 11),
          cargoGrossWeight: { value: Number(c.gross_weight_kg) || 0, unit: "KGM" },
          ...(Number(c.volume_cbm) > 0 && { cargoGrossVolume: { value: Number(c.volume_cbm), unit: "MTQ" } }),
          outerPackaging: {
            ...(c.package_code && { packageCode: c.package_code }),
            numberOfPackages: Number(c.number_of_packages) || 0,
            description: clip(c.package_description || PACKAGE_CODES[c.package_code] || "", 100),
            ...(dgOf(c) && { dangerousGoods: [dgOf(c)] }),
          },
        }],
      })),
      utilizedTransportEquipments: containers.map(c => {
        const iso = containerIso(c);
        // A reefer with its set temperature (G17): an operating reefer, DCSA activeReeferSettings in °C.
        const reefer = iso?.[2] === "R" && c.set_temperature_c !== null && c.set_temperature_c !== undefined && c.set_temperature_c !== "";
        return {
          equipment: { equipmentReference: clip(c.container_number, 11), ...(iso && { ISOEquipmentCode: iso }) },
          isShipperOwned: false,
          ...(reefer && { isNonOperatingReefer: false, activeReeferSettings: { temperatureSetpoint: Number(c.set_temperature_c), temperatureUnit: "CEL" } }),
          seals: dcsaSeals(c),
        };
      }),
    };
    const v = validateOutboundSchema("ebl", "TransportDocument", doc);
    return { doc, errors: v.ok ? "" : errorsText(v.errors, 10) };
  }

  // ─── Issue (confirming a BL01) ─────────────────────────────────────────────
  // Checks first, writes nothing: { error } or { apply(tx) } for the confirm transaction.
  async function prepareIssue(doc, user) {
    const shipmentId = doc.shipment_id;
    let td = (await query("SELECT * FROM transport_documents WHERE document_id=$1 AND status='DRAFT'", [doc.id]))[0] || null;
    const [s0] = await query("SELECT bl_number, bl_number_source, bl_release_type FROM shipments WHERE id=$1", [shipmentId]);
    // The printed copy must carry the number it is issued under (G5): a draft printed "assigned at
    // issue" is issued from the House B/L panel, which takes the number and prints the final copy.
    if (td && !td.reference)
      return { error: "This draft was printed before its B/L number was assigned: issue it from the House B/L panel, which takes the number and prints the final copy" };
    if (td && s0?.bl_number && td.reference !== s0.bl_number && !td.supersedes_id)
      return { error: `This draft prints B/L number ${td.reference}, but the shipment's is now ${s0.bl_number}: generate the draft again` };
    // A BL01 that was uploaded rather than generated has no draft record: it prints whatever the file
    // says, so it is judged as the old print (shipped on board, a set of three originals).
    const prev = td?.supersedes_id ? (await query("SELECT * FROM transport_documents WHERE id=$1", [td.supersedes_id]))[0] : await amendmentOf(shipmentId);
    const stand = td || { reference: prev?.reference || "", is_shipped_on_board_type: true, shipped_on_board_date: null };
    const r = await readiness(shipmentId, { td: stand });
    if (!r.ready) return { error: `This House B/L can't be issued yet. Missing: ${r.missing.join("; ")}` };
    const d = await shipmentData(shipmentId);
    const { s } = d;
    const facts = r.facts;
    const reference = clip(stand.reference || s.bl_number || refFromFilename(doc.filename), 20);
    const onBoard = !!stand.is_shipped_on_board_type;
    const typeCode = TYPE_CODE_OF_RELEASE[s.bl_release_type] || "BOL";
    const counts = td ? { originals_count: td.originals_count, copies_count: td.copies_count, with_charges: !!td.with_charges } : countsOf({}, typeCode);
    const issued = {
      reference, status: "ISSUED", type_code: typeCode, release_type: s.bl_release_type || "",
      is_shipped_on_board_type: onBoard,
      shipped_on_board_date: onBoard ? (stand.shipped_on_board_date || facts.onBoardDate) : null,
      on_board_source: onBoard ? (stand.on_board_source || facts.onBoardSource || "") : "",
      received_for_shipment_date: onBoard ? null : (facts.receivedDate || today()),
      issue_date: localDay(d.office?.unlocode), place_of_issue: d.office?.unlocode || d.office?.country_code || "",
      issuing_office_id: s.emo_office_id || null, is_electronic: false,
      number_source: prev?.number_source || sourceOf(s, reference),
      to_order_mode: typeCode === "SWB" ? "" : (s.bl_to_order || ""), is_to_order: typeCode !== "SWB" && !!s.bl_to_order,
      originals_count: counts.originals_count ?? DEFAULT_ORIGINALS[typeCode] ?? 0, copies_count: counts.copies_count ?? 0, with_charges: !!counts.with_charges,
      version: prev ? prev.version + 1 : (td?.version || 1), supersedes_id: prev?.id || td?.supersedes_id || null,
    };
    const { doc: payload, errors } = await buildDcsaDocument({ ...stand, ...issued }, d);
    // A House B/L is a DCSA transport document: it isn't issued until it is a valid one (audit M2).
    if (errors) return { error: `This House B/L isn't a valid DCSA transport document yet: ${errors}` };
    const actor = actorOf(user);
    return {
      reference,
      async apply(tx) {
        const now = nowIso();
        let id = td?.id;
        if (!id) {
          id = `TD-${uid()}${uid()}`;
          // Straight in as ISSUED: the shipment may hold a House draft for another BL01 (one draft each).
          await tx.query("INSERT INTO transport_documents (id, shipment_id, role, status, document_id, created_at, updated_at) VALUES ($1,$2,'HOUSE','ISSUED',$3,$4,$4)",
            [id, shipmentId, doc.id, now]);
        }
        await tx.query(`UPDATE transport_documents SET reference=$1, status='ISSUED', type_code=$2, release_type=$3, is_shipped_on_board_type=$4,
          shipped_on_board_date=$5, on_board_source=$6, received_for_shipment_date=$7, issue_date=$8, place_of_issue=$9, issuing_office_id=$10,
          is_electronic=FALSE, document_id=$11, payload=$12, payload_errors=$13, issued_at=$14, issued_by=$15, updated_at=$14,
          number_source=$17, to_order_mode=$18, is_to_order=$19, originals_count=$20, copies_count=$21, with_charges=$22, version=$23, supersedes_id=$24
          WHERE id=$16`,
          [issued.reference, issued.type_code, issued.release_type, issued.is_shipped_on_board_type, issued.shipped_on_board_date,
            issued.on_board_source, issued.received_for_shipment_date, issued.issue_date, issued.place_of_issue, issued.issuing_office_id,
            doc.id, JSON.stringify(payload), errors, now, actor, id,
            issued.number_source, issued.to_order_mode, issued.is_to_order, issued.originals_count, issued.copies_count, issued.with_charges,
            issued.version, issued.supersedes_id]);
        // The rest of CargoDesk (lists, search, exports, the Master B/L's cross-reference) reads the number here.
        await tx.query("UPDATE shipments SET bl_number=$1, bl_number_source=$2 WHERE id=$3 AND COALESCE(bl_number,'')=''",
          [issued.reference, issued.number_source, shipmentId]);
        await event(tx, { id, shipment_id: shipmentId }, "ISSUED", "DRAFT", "ISSUED",
          { documentId: doc.id, reference: issued.reference, shippedOnBoard: onBoard, date: issued.shipped_on_board_date || issued.received_for_shipment_date,
            dcsaValid: !errors, originals: issued.originals_count, copies: issued.copies_count, withCharges: issued.with_charges,
            ...(issued.version > 1 && { version: issued.version, amends: issued.supersedes_id }) }, actor);
        return id;
      },
    };
  }

  async function onVoided(doc, reason, user) {
    const [td] = await query("SELECT * FROM transport_documents WHERE document_id=$1 AND status<>'VOIDED'", [doc.id]);
    if (!td) return;
    const now = nowIso();
    await query("UPDATE transport_documents SET status='VOIDED', voided_at=$1, voided_by=$2, void_reason=$3, updated_at=$1 WHERE id=$4",
      [now, actorOf(user), String(reason || "").trim(), td.id]);
    await event(Q, td, "VOIDED", td.status, "VOIDED", { reason: String(reason || "").trim() }, actorOf(user));
    // A voided series number is never reused (D1): the shipment lets go of it, and its next House
    // B/L takes a new number. A typed number stays: it is the user's to change.
    if (td.number_source === "SERIES" && td.reference) {
      const cleared = await query("UPDATE shipments SET bl_number='', bl_number_source='' WHERE id=$1 AND bl_number=$2 AND bl_number_source='SERIES' RETURNING id",
        [td.shipment_id, td.reference]);
      if (cleared.length) await logEvent(td.shipment_id, "FIELD_UPDATED", "bl_number", td.reference, null,
        JSON.stringify({ source: "House B/L voided: its series number isn't reused" }), actorOf(user));
    }
  }

  // Originals handed back (at origin for a telex release, at destination for an Original B/L), or the
  // eBL surrendered on its platform: surrendered for delivery.
  async function onSurrendered(shipmentId, { kind, user, detail = {} }, q = Q) {
    const td = await liveHouse(shipmentId, q);
    if (!td || td.status === "SURRENDERED_FOR_DELIVERY") return td;
    const now = nowIso();
    await q.query("UPDATE transport_documents SET status='SURRENDERED_FOR_DELIVERY', surrendered_at=$1, surrendered_by=$2, surrender_kind=$3, updated_at=$1 WHERE id=$4",
      [now, actorOf(user), kind, td.id]);
    await event(q, td, "SURRENDERED_FOR_DELIVERY", td.status, "SURRENDERED_FOR_DELIVERY", { kind, ...detail }, actorOf(user));
    return { ...td, status: "SURRENDERED_FOR_DELIVERY" };
  }

  // ─── Corrections after issue (G6) ──────────────────────────────────────────
  // Surrendered for amendment: the originals come back (or the eBL platform's AREQ is accepted). The
  // version stays on record as SURRENDERED_FOR_AMENDMENT, its printed copy is superseded (voided as a
  // document, not as a B/L), and the next issue is version + 1 under the same number.
  async function onSurrenderedForAmendment(shipmentId, { kind, reason = "", user, detail = {} }, q = Q) {
    const td = await liveHouse(shipmentId, q);
    if (!td) return null;
    const now = nowIso();
    await q.query(`UPDATE transport_documents SET status='SURRENDERED_FOR_AMENDMENT', surrendered_at=$1, surrendered_by=$2, surrender_kind=$3,
      amendment_reason=$4, updated_at=$1 WHERE id=$5`, [now, actorOf(user), kind, String(reason || "").trim().slice(0, 500), td.id]);
    if (td.document_id) await q.query("UPDATE shipment_documents SET status='voided' WHERE id=$1 AND status='confirmed'", [td.document_id]);
    await event(q, td, "SURRENDERED_FOR_AMENDMENT", td.status, "SURRENDERED_FOR_AMENDMENT", { kind, reason: String(reason || "").trim(), ...detail }, actorOf(user));
    await logEvent(shipmentId, "HOUSE_BL_SURRENDERED_FOR_AMENDMENT", null, td.reference, null,
      JSON.stringify({ version: td.version, reason: String(reason || "").trim() }), actorOf(user));
    return (await q.query("SELECT * FROM transport_documents WHERE id=$1", [td.id]))[0];
  }
  // The paper path: the shipper returns the originals to correct the B/L. An eBL is corrected by the
  // platform's AREQ instead (lib/ebl.js).
  async function surrenderForAmendment(shipmentId, user, { reason = "" } = {}) {
    const td = await liveHouse(shipmentId);
    if (!td) return { error: "This shipment has no issued House B/L", status: 409 };
    if (td.status !== "ISSUED") return { error: `This House B/L is ${td.status.toLowerCase().replace(/_/g, " ")}`, status: 409 };
    if (td.released_at) return { error: "The cargo has been released against this House B/L: it can't be amended", status: 409 };
    if (td.is_electronic && ["PENDING", "ISSU"].includes(td.ebl_issuance_status))
      return { error: "This House B/L is an eBL: the holder asks for the amendment on its platform (AREQ)", status: 409 };
    if (!String(reason).trim()) return { error: "Give the reason for the amendment", status: 400 };
    return { td: await onSurrenderedForAmendment(shipmentId, { kind: td.type_code === "SWB" ? "waybill" : "originals", reason, user }) };
  }

  // What changed since issue (G6): the issued DCSA document against one built from today's data.
  // Labels the fields that differ; null for a record issued before the payload was kept.
  async function changedSinceIssue(td, d) {
    if (!td?.payload) return null;
    let issued;
    try { issued = JSON.parse(td.payload); } catch { return null; }
    const typeCode = TYPE_CODE_OF_RELEASE[d.s.bl_release_type] || td.type_code;
    const { doc: now } = await buildDcsaDocument({ ...td, type_code: typeCode, is_to_order: typeCode !== "SWB" && !!d.s.bl_to_order,
      to_order_mode: d.s.bl_to_order || "" }, d);
    // A vessel's role follows from the order of the legs, which is compared; B/Ls issued before
    // 2026-10-22 carry no role, and that alone isn't a change.
    const at = (o, path) => {
      const v = path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
      return path === "transports.vesselVoyages" && Array.isArray(v) ? v.map(({ role, ...rest }) => rest) : v;
    };
    const sorted = (k, x) => (x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
    const stable = v => JSON.stringify(v, sorted);
    return ISSUED_FIELDS.filter(([path]) => stable(at(issued, path) ?? null) !== stable(at(now, path) ?? null)).map(([, label]) => label);
  }

  // ─── After issue on paper (G18) ────────────────────────────────────────────
  // The originals log, both ways (audit 2026-10-29): what went out and what came back. While any original is
  // out, the House B/L isn't voided (H1), no eBL is issued from it (H2) and no telex release is given (M5).
  // → { out, back, outstanding, holder }
  async function originalsOut(td) {
    const rows = await query(`SELECT event_type, detail FROM transport_document_events WHERE transport_document_id=$1
      AND event_type IN ('ORIGINALS_HANDED_OVER','ORIGINALS_RETURNED') ORDER BY created_at`, [td.id]);
    let out = 0, back = 0, holder = "";
    for (const r of rows) {
      const det = parseJson(r.detail) || {};
      if (r.event_type === "ORIGINALS_HANDED_OVER") { out += Number(det.count) || 0; holder = det.to || holder; } else back += Number(det.count) || 0;
    }
    return { out, back, outstanding: Math.max(0, out - back), holder };
  }
  const originalsWords = (n, holder) => `${n} original${n === 1 ? " is" : "s are"} still with ${holder || "the holder"}`;
  const HANDOVER_METHODS = ["In person", "Courier", "Mail"];
  async function recordOriginalsHandover(shipmentId, user, { to = "", method = "", trackingRef = "", count, handedOverOn = "", note = "" } = {}) {
    const td = await liveHouse(shipmentId);
    if (!td) return { error: "This shipment has no issued House B/L", status: 409 };
    if (td.type_code === "SWB") return { error: "A Sea Waybill has no originals", status: 409 };
    if (td.is_electronic && ["PENDING", "ISSU"].includes(td.ebl_issuance_status)) return { error: "An eBL has no paper originals", status: 409 };
    if (td.status !== "ISSUED") return { error: "The originals have already come back", status: 409 };
    const who = String(to).trim();
    if (!who) return { error: "Say who received the originals", status: 400 };
    if (!HANDOVER_METHODS.includes(method)) return { error: `method must be one of: ${HANDOVER_METHODS.join(", ")}`, status: 400 };
    const total = td.originals_count ?? DEFAULT_ORIGINALS.BOL;
    // Never more out than were issued (audit L1): what is already out counts.
    const { outstanding } = await originalsOut(td);
    const available = total - outstanding;
    if (available < 1) return { error: `All ${total} originals are already out: record some returned first`, status: 409 };
    const n = count === undefined || count === null || count === "" ? available : Number(count);
    if (!Number.isInteger(n) || n < 1 || n > available) return { error: `count: 1 to ${available} (the originals issued and not out)`, status: 400 };
    const on = String(handedOverOn || today()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || on > today()) return { error: "The handover date can't be in the future", status: 400 };
    if (method === "Courier" && !String(trackingRef).trim()) return { error: "Give the courier's tracking number", status: 400 };
    const detail = { to: who.slice(0, 120), method, count: n, total, on,
      ...(String(trackingRef).trim() && { trackingRef: String(trackingRef).trim().slice(0, 60) }),
      ...(String(note).trim() && { note: String(note).trim().slice(0, 300) }) };
    await event(Q, td, "ORIGINALS_HANDED_OVER", td.status, td.status, detail, actorOf(user));
    return { td, detail };
  }
  // Originals coming back (to amend, to void, or for a telex release at origin).
  async function recordOriginalsReturned(shipmentId, user, { count, from = "", method = "In person", returnedOn = "", note = "" } = {}) {
    const td = await liveHouse(shipmentId);
    if (!td) return { error: "This shipment has no issued House B/L", status: 409 };
    if (td.status !== "ISSUED") return { error: `This House B/L is ${td.status.toLowerCase().replace(/_/g, " ")}`, status: 409 };
    const { outstanding, holder } = await originalsOut(td);
    if (!outstanding) return { error: "No originals are out", status: 409 };
    const n = count === undefined || count === null || count === "" ? outstanding : Number(count);
    if (!Number.isInteger(n) || n < 1 || n > outstanding) return { error: `count: 1 to ${outstanding} (the originals out)`, status: 400 };
    if (!HANDOVER_METHODS.includes(method)) return { error: `method must be one of: ${HANDOVER_METHODS.join(", ")}`, status: 400 };
    const on = String(returnedOn || today()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || on > today()) return { error: "The return date can't be in the future", status: 400 };
    const detail = { from: (String(from).trim() || holder).slice(0, 120), method, count: n, on, ...(String(note).trim() && { note: String(note).trim().slice(0, 300) }) };
    await event(Q, td, "ORIGINALS_RETURNED", td.status, td.status, detail, actorOf(user));
    return { td, detail, outstanding: outstanding - n };
  }

  // Why an issued House B/L can't be voided now, or null (audit H1, M6). A draft voids freely.
  async function voidBlock(doc, user) {
    const [td] = await query("SELECT * FROM transport_documents WHERE document_id=$1 AND status<>'VOIDED'", [doc.id]);
    if (!td || td.status === "DRAFT") return null;
    if (!(user?.roles || [user?.role]).includes("admin")) return { error: "Only an admin can void an issued House B/L", status: 403 };
    if (td.released_at) return { error: "The cargo was released against this House B/L: it stays on record and can't be voided", status: 409 };
    if (td.status !== "ISSUED") return { error: `This House B/L is ${td.status.toLowerCase().replace(/_/g, " ")}: it can't be voided`, status: 409 };
    if (td.is_electronic && ["PENDING", "ISSU"].includes(td.ebl_issuance_status))
      return { error: `This House B/L is an eBL on ${td.ebl_platform || "its platform"}: it comes back through the platform (surrender for amendment) before it can be voided`, status: 409 };
    const { outstanding, holder } = await originalsOut(td);
    if (outstanding) return { error: `${originalsWords(outstanding, holder)}: record them returned before voiding`, status: 409 };
    return null;
  }

  // ─── The on-board notation (audit M4) ──────────────────────────────────────
  // A received-for-shipment House B/L, once every container is aboard: the dated notation on the same B/L
  // (UCP 600 art. 20), not a new version.
  async function addOnBoardNotation(shipmentId, user) {
    const td = await liveHouse(shipmentId);
    if (!td || td.status !== "ISSUED") return { error: "This shipment has no issued House B/L", status: 409 };
    if (td.is_shipped_on_board_type) return { error: "This House B/L already says shipped on board", status: 409 };
    if (td.on_board_notation_date) return { error: `The on-board notation is already on it (${td.on_board_notation_date})`, status: 409 };
    if (td.is_electronic && ["PENDING", "ISSU"].includes(td.ebl_issuance_status)) return { error: "This House B/L is an eBL: the notation is made on its platform", status: 409 };
    const facts = await onBoardFacts(shipmentId);
    if (!facts.shippedOnBoard) return { error: facts.loaded
      ? `${facts.loaded} of ${facts.containers} containers loaded (${facts.notLoaded.join(", ")} ${facts.notLoaded.length === 1 ? "isn't" : "aren't"}): the notation waits for every container`
      : "No loading is recorded yet: the notation waits for every container to be loaded", status: 409 };
    const now = nowIso(), date = facts.onBoardDate;
    const d = await shipmentData(shipmentId);
    const { doc: payload, errors } = await buildDcsaDocument({ ...td, on_board_notation_date: date }, d);
    await query(`UPDATE transport_documents SET on_board_notation_date=$1, on_board_notation_at=$2, on_board_notation_by=$3, payload=$4, payload_errors=$5, updated_at=$2
      WHERE id=$6`, [date, now, actorOf(user), JSON.stringify(payload), errors, td.id]);
    await event(Q, td, "ON_BOARD_NOTATION", td.status, td.status, { date, source: facts.onBoardSource }, actorOf(user));
    await logEvent(shipmentId, "HOUSE_BL_ON_BOARD_NOTATION", null, null, date, JSON.stringify({ reference: td.reference, source: facts.onBoardSource }), actorOf(user));
    return { td: (await query("SELECT * FROM transport_documents WHERE id=$1", [td.id]))[0] };
  }

  // ─── House against Master (audit M3) ───────────────────────────────────────
  // The carrier's Master B/L (routes/master-bl.js) against the House — as issued, else as the draft would
  // issue now: containers, seals, gross weights, packages. A difference is a classic ICS2/AMS hold; it warns.
  // → null (no Master, or no House) | { masterReference, masterStatus, houseReference, houseIssued, differences }
  async function houseVsMaster(shipmentId) {
    const [m] = await query("SELECT * FROM transport_documents WHERE shipment_id=$1 AND role='MASTER' AND status<>'VOIDED' ORDER BY created_at DESC LIMIT 1", [shipmentId]);
    const mDoc = parseJson(m?.payload);
    if (!mDoc) return null;
    const live = await liveHouse(shipmentId);
    let hDoc = parseJson(live?.payload), houseReference = live?.reference || "";
    if (!hDoc) {
      const draft = await draftHouse(shipmentId);
      if (!draft) return null;
      const d = await shipmentData(shipmentId);
      hDoc = (await buildDcsaDocument({ ...draft, reference: draft.reference || d.s.bl_number || "DRAFT" }, d)).doc;
      houseReference = draft.reference || d.s.bl_number || "";
    }
    const byContainer = doc => {
      const out = new Map();
      const at = ref => out.get(ref) || (out.set(ref, { seals: "", weight: 0, packages: 0 }), out.get(ref));
      for (const u of doc.utilizedTransportEquipments || []) {
        const ref = u.equipment?.equipmentReference || u.equipmentReference;
        if (ref) at(ref).seals = (u.seals || []).map(x => x.number).sort().join(", ");
      }
      for (const ci of doc.consignmentItems || []) for (const c of ci.cargoItems || []) {
        if (!c.equipmentReference) continue;
        at(c.equipmentReference).weight += Number(c.cargoGrossWeight?.value) || 0;
        at(c.equipmentReference).packages += Number(c.outerPackaging?.numberOfPackages) || 0;
      }
      return out;
    };
    const h = byContainer(hDoc), ms = byContainer(mDoc), differences = [];
    const kg = n => `${Math.round(n).toLocaleString("en-US")} kg`;
    for (const ref of [...new Set([...h.keys(), ...ms.keys()])].sort()) {
      const a = h.get(ref), b = ms.get(ref);
      if (!a || !b) { differences.push({ key: `container:${ref}`, label: `Container ${ref}`, house: a ? "on the House" : "—", master: b ? "on the Master" : "—" }); continue; }
      if (a.seals !== b.seals) differences.push({ key: `seal:${ref}`, label: `Container ${ref} · Seal`, house: a.seals || "—", master: b.seals || "—" });
      if (Math.abs(a.weight - b.weight) > 0.5) differences.push({ key: `weight:${ref}`, label: `Container ${ref} · Gross weight`, house: kg(a.weight), master: kg(b.weight) });
      if (a.packages && b.packages && a.packages !== b.packages) differences.push({ key: `packages:${ref}`, label: `Container ${ref} · Packages`, house: String(a.packages), master: String(b.packages) });
    }
    return { masterReference: m.reference, masterStatus: m.status, houseReference, houseIssued: !!live, containers: h.size, differences };
  }

  // ─── The shipper's approval of the draft (audit L3) ────────────────────────
  // The draft PDF goes to the shipper by email (the export office's SMTP, when it has one; otherwise it is
  // recorded as sent and the user sends it); their answer is recorded. Issuing without it asks to confirm (UI).
  async function sendForApproval(shipmentId, user, { to = "", message = "" } = {}) {
    const draft = await draftHouse(shipmentId);
    if (!draft?.document_id) return { error: "Generate the House B/L draft first", status: 409 };
    const email = String(to).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Give the shipper's email address", status: 400 };
    const [s] = await query("SELECT id, emo_office_id FROM shipments WHERE id=$1", [shipmentId]);
    const [docRow] = await query("SELECT * FROM shipment_documents WHERE id=$1", [draft.document_id]);
    const [mail] = s?.emo_office_id ? await query("SELECT * FROM office_mail_settings WHERE office_id=$1 AND is_active=TRUE", [s.emo_office_id]) : [];
    let emailed = false, emailError = "";
    if (mail && docRow && ctx.sendViaOffice && ctx.buildMailOptions) {
      try {
        await ctx.sendViaOffice(query, s.emo_office_id, ctx.buildMailOptions({ from: mail.from_address, fromName: mail.from_name, to: email,
          subject: `House B/L draft ${draft.reference || ""} for your approval (${shipmentId})`.replace("  ", " "),
          message: String(message || "").trim() || "Please check the attached House Bill of Lading draft and confirm it, or tell us what to change.",
          attachmentPath: ctx.path.join(ctx.UPLOADS_DIR, docRow.stored_name), attachmentFilename: docRow.filename }));
        emailed = true;
      } catch (e) { emailError = e.message; }
    }
    const now = nowIso();
    await query(`UPDATE transport_documents SET approval_status='SENT', approval_document_id=$1, approval_sent_to=$2, approval_sent_at=$3, approval_sent_by=$4,
      approval_emailed=$5, approval_answered_at=NULL, approval_answered_by='', approval_comment='', updated_at=$3 WHERE id=$6`,
      [draft.document_id, email, now, actorOf(user), emailed, draft.id]);
    await event(Q, draft, "APPROVAL_REQUESTED", "DRAFT", "DRAFT", { to: email, emailed, ...(emailError && { emailError }) }, actorOf(user));
    return { td: (await query("SELECT * FROM transport_documents WHERE id=$1", [draft.id]))[0], emailed,
      note: emailed ? "" : mail ? `The email failed (${emailError}): send the draft yourself` : "The export office has no email settings: send the draft yourself; it is recorded as sent" };
  }
  async function recordApproval(shipmentId, user, { approved, comment = "" } = {}) {
    const draft = await draftHouse(shipmentId);
    if (!draft) return { error: "There is no House B/L draft", status: 409 };
    if (!["SENT", "CHANGES_REQUESTED"].includes(draft.approval_status || "")) return { error: "Send the draft to the shipper first", status: 409 };
    if (draft.approval_document_id !== draft.document_id) return { error: "The draft changed since it was sent: send this one", status: 409 };
    if (typeof approved !== "boolean") return { error: "approved: true or false", status: 400 };
    const why = String(comment || "").trim();
    if (!approved && !why) return { error: "Say what the shipper asked to change", status: 400 };
    const now = nowIso(), status = approved ? "APPROVED" : "CHANGES_REQUESTED";
    await query(`UPDATE transport_documents SET approval_status=$1, approval_answered_at=$2, approval_answered_by=$3, approval_comment=$4, updated_at=$2 WHERE id=$5`,
      [status, now, actorOf(user), why.slice(0, 500), draft.id]);
    await event(Q, draft, approved ? "APPROVED_BY_SHIPPER" : "CHANGES_REQUESTED_BY_SHIPPER", "DRAFT", "DRAFT", { ...(why && { comment: why }) }, actorOf(user));
    return { td: (await query("SELECT * FROM transport_documents WHERE id=$1", [draft.id]))[0] };
  }

  // The telex release notice (G18): once the shipper surrenders the originals at origin, the import
  // office is told it may release without them, as a Kanban task for its manager (the established
  // "notify + a real ticket" pattern, server.js vessel_arrived_import_handoff).
  async function sendTelexReleaseNotice(shipmentId, user) {
    const td = await liveHouse(shipmentId);
    if (!td || td.status !== "SURRENDERED_FOR_DELIVERY" || td.surrender_kind !== "origin" || td.telex_notice_ticket_id
      || !["Telex Release", "Surrendered"].includes(td.release_type)) return null;
    const [s] = await query(`SELECT s.id, s.imo_office_id, o.name AS imo_name, o.manager_user_id FROM shipments s
      LEFT JOIN offices o ON o.id = s.imo_office_id WHERE s.id=$1`, [shipmentId]);
    if (!s?.imo_office_id) {
      await event(Q, td, "TELEX_RELEASE_NOTICE", td.status, td.status, { office: null, sent: false }, actorOf(user));
      return { sent: false };
    }
    const ticketId = await ctx.ensureOpsTicket("telex_release_notice", td.id, {
      shipmentId, priority: "High", assigneeId: s.manager_user_id || null,
      title: `Telex release — House B/L ${td.reference} surrendered at origin (${shipmentId})`,
      description: `The shipper surrendered the originals of House B/L ${td.reference} at origin. ${s.imo_name} can release the cargo `
        + "to the consignee without originals once the release checks pass (Documents → House B/L → Release cargo).",
    });
    if (ticketId) await query("UPDATE transport_documents SET telex_notice_ticket_id=$1, updated_at=$2 WHERE id=$3", [ticketId, nowIso(), td.id]);
    await event(Q, td, "TELEX_RELEASE_NOTICE", td.status, td.status, { office: s.imo_name, ticketId: ticketId || null, sent: true }, actorOf(user));
    await logEvent(shipmentId, "TELEX_RELEASE_NOTICE", null, null, td.reference, JSON.stringify({ office: s.imo_name, ticketId }), actorOf(user));
    return { sent: true, ticketId, office: s.imo_name };
  }

  // ─── Release at destination (G19, D3) ──────────────────────────────────────
  // What stands in the way of releasing the cargo against the House B/L. Each block has a key, so an
  // override names exactly what it overrode.
  async function releaseChecks(shipmentId) {
    const td = await liveHouse(shipmentId);
    const blocks = [];
    if (!td) return { td: null, blocks: [{ key: "no_house_bl", message: "This shipment has no issued House B/L" }] };
    const [s] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
    // Originals: a Seaway Bill has none; every other House B/L must be surrendered first.
    if (td.type_code !== "SWB" && td.status !== "SURRENDERED_FOR_DELIVERY")
      blocks.push({ key: "originals", message: td.is_electronic
        ? "The eBL hasn't been surrendered for delivery on its platform"
        : td.release_type === "Original"
          ? "The original bills haven't been surrendered: record them as presented at destination"
          : ["Telex Release", "Surrendered"].includes(td.release_type)
            ? "The bill hasn't been surrendered at origin (telex release)"
            : "The bill hasn't been surrendered" });
    // Collect charges: every collect SELL line must sit on a paid invoice or statement.
    const collect = await query(`SELECT * FROM shipment_cost_lines WHERE shipment_id=$1 AND type='SELL' AND payment_indicator='Collect'
      AND amount > 0 AND id NOT IN (SELECT adjusts_cost_line_id FROM shipment_cost_lines WHERE adjusts_cost_line_id IS NOT NULL)`, [shipmentId]);
    if (collect.length) {
      const holds = await billingHolds(collect.map(l => l.id));
      const unpaid = [];
      for (const l of collect) {
        const h = holds.get(l.id);
        let paid = false;
        if (h?.kind === "invoice" && h.status === "confirmed") paid = !!(await query("SELECT paid_at FROM shipment_documents WHERE id=$1", [h.id]))[0]?.paid_at;
        else if (h?.kind === "statement" && h.status !== "draft") paid = !!(await query("SELECT paid_at FROM customer_statements WHERE id=$1", [h.id]))[0]?.paid_at;
        if (!paid) unpaid.push(`${l.charge_code}${h ? ` (${h.kind === "invoice" ? h.label || h.id : h.id} unpaid)` : " (not invoiced)"}`);
      }
      if (unpaid.length) blocks.push({ key: "collect_charges", message: `Collect charges aren't paid: ${unpaid.join(", ")}` });
    }
    // Credit hold: the consignee takes delivery (and pays any collect freight).
    const consignee = await getCustomerRow(s?.consignee_id);
    if (consignee?.creditHold) blocks.push({ key: "credit_hold", message: `${consignee.companyName} is on credit hold${consignee.creditHoldReason ? ` (${consignee.creditHoldReason})` : ""}` });
    return { td, blocks };
  }

  // Release: refused while anything blocks, unless an admin or a finance user overrides with a reason.
  async function release(shipmentId, user, { override = false, overrideReason = "" } = {}) {
    const { td, blocks } = await releaseChecks(shipmentId);
    if (!td) return { error: blocks[0].message, status: 409 };
    if (td.released_at) return { td };
    const reason = String(overrideReason || "").trim();
    if (blocks.length) {
      if (!override) return { error: `The cargo can't be released yet: ${blocks.map(b => b.message).join("; ")}`, status: 409, blocks };
      const canOverride = (user?.roles || [user?.role]).includes("admin") || !!user?.canViewFinance;
      if (!canOverride) return { error: "Only an admin or a user with finance access can override the release checks", status: 403, blocks };
      if (!reason) return { error: "Give a reason to override the release checks", status: 400, blocks };
    }
    const now = nowIso();
    await query("UPDATE transport_documents SET released_at=$1, released_by=$2, release_override_reason=$3, updated_at=$1 WHERE id=$4",
      [now, actorOf(user), blocks.length ? reason : "", td.id]);
    await event(Q, td, blocks.length ? "RELEASED_WITH_OVERRIDE" : "RELEASED", td.status, td.status,
      blocks.length ? { overridden: blocks.map(b => b.key), reason } : {}, actorOf(user));
    await autoCompleteMilestone(shipmentId, "cargo_released", `Cargo released against House B/L ${td.reference}`);
    return { td: { ...td, released_at: now }, overridden: blocks.map(b => b.key) };
  }

  // ─── Startup migration: BL01 documents → House transport documents ─────────
  // Idempotent (keyed by migrated_from_document_id). Keeps what was true: the old print always said
  // SHIPPED ON BOARD with no date, so that is what the record says; the document's own status is kept
  // in legacy_document_status. Only the newest draft per shipment becomes the House draft.
  async function migrateLegacyHouseBls() {
    const docs = await query(`SELECT d.*, s.bl_number, s.bl_release_type, s.emo_office_id FROM shipment_documents d
      JOIN shipments s ON s.id = d.shipment_id
      WHERE d.doc_type='BL01'
        AND d.id NOT IN (SELECT migrated_from_document_id FROM transport_documents WHERE migrated_from_document_id IS NOT NULL)
        AND d.id NOT IN (SELECT document_id FROM transport_documents WHERE document_id IS NOT NULL)
      ORDER BY d.created_at DESC`);
    let made = 0;
    const draftTaken = new Set((await query("SELECT shipment_id FROM transport_documents WHERE role='HOUSE' AND status='DRAFT'")).map(r => r.shipment_id));
    for (const d of docs) {
      const status = d.status === "confirmed" ? (d.bl_surrendered_at ? "SURRENDERED_FOR_DELIVERY" : "ISSUED") : d.status === "voided" ? "VOIDED" : "DRAFT";
      if (status === "DRAFT") { if (draftTaken.has(d.shipment_id)) continue; draftTaken.add(d.shipment_id); }
      const id = `TD-${uid()}${uid()}`, now = nowIso();
      const reference = clip(d.bl_number || refFromFilename(d.filename), 20);
      await query(`INSERT INTO transport_documents (id, shipment_id, role, reference, status, type_code, release_type, is_shipped_on_board_type,
        issue_date, issuing_office_id, document_id, issued_at, issued_by, surrendered_at, surrendered_by, surrender_kind, released_at, released_by,
        migrated_from_document_id, legacy_document_status, created_at, updated_at)
        VALUES ($1,$2,'HOUSE',$3,$4,$5,$6,TRUE,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$9,$17,$18,$19)`,
        [id, d.shipment_id, reference, status, TYPE_CODE_OF_RELEASE[d.bl_release_type] || "BOL", d.bl_release_type || "",
          status !== "DRAFT" ? dateOnly(d.confirmed_at) : null, d.emo_office_id || null, d.id,
          d.status === "confirmed" ? d.confirmed_at : null, d.confirmed_by || "",
          d.bl_surrendered_at || null, d.bl_surrendered_by || "", d.bl_surrendered_at ? "origin" : "",
          d.bl_released_at || null, d.bl_released_by || "", d.status, d.created_at || now, now]);
      await event(Q, { id, shipment_id: d.shipment_id }, "MIGRATED", "", status, { documentId: d.id, documentStatus: d.status }, "system");
      made++;
    }
    if (made) console.log(`  ✔ ${made} House B/L document(s) now have a House transport document`);
    return made;
  }

  async function events(tdId) {
    const rows = await query("SELECT * FROM transport_document_events WHERE transport_document_id=$1 ORDER BY created_at", [tdId]);
    return rows.map(r => ({ id: r.id, eventType: r.event_type, fromStatus: r.from_status, toStatus: r.to_status,
      detail: (() => { try { return JSON.parse(r.detail); } catch { return {}; } })(), actor: r.actor, createdAt: r.created_at }));
  }

  return {
    HOUSE_BL, LIVE, PACKAGE_CODES, TO_ORDER_MODES, HANDOVER_METHODS, PREFIX_RE,
    mapTransportDocument, houseDocs, liveHouse, draftHouse, amendmentOf, events,
    onBoardFacts, draftStatement, onDraftGenerated, onDraftDocumentGone,
    readiness, shipmentData, identifiersOf, dcsaParty, buildDcsaDocument, prepareIssue, onVoided, onSurrendered,
    seriesPrefix, nextSeriesNumber, assignNumber,
    onSurrenderedForAmendment, surrenderForAmendment, changedSinceIssue, recordOriginalsHandover, sendTelexReleaseNotice,
    originalsOut, recordOriginalsReturned, voidBlock, addOnBoardNotation, houseVsMaster, sendForApproval, recordApproval,
    releaseChecks, release, migrateLegacyHouseBls, refFromFilename,
  };
}

module.exports = createHouseBl;
module.exports.PACKAGE_CODES = PACKAGE_CODES;
module.exports.HOUSE_BL = HOUSE_BL;
module.exports.TO_ORDER_MODES = TO_ORDER_MODES;
module.exports.PREFIX_RE = PREFIX_RE;
