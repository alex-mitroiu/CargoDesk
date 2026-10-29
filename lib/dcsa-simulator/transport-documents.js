"use strict";
// The demo carrier's Master transport documents: the Transport Document half of DCSA eBL 3.0
// (DCSA-everywhere phase 4, 2026-10-28). State in dcsa_sim_transport_documents.
//
// The carrier drafts the transport document from the Shipping Instructions it received, and the
// booking it confirmed (vessels, dates, contract). The shipper (CargoDesk) reads it with
// GET /v3/transport-documents/{ref} and approves it with PATCH { transportDocumentStatus: APPROVED }.
// The carrier then issues it, and in the end the B/L is surrendered for delivery, which completes the
// Shipping Instructions (the spec's COMPLETED). Every change is a signed transport-document
// notification (a CloudEvent) to CargoDesk's carrier webhook, carrying the state only: CargoDesk reads
// the document itself with a GET, as a subscriber without full state transfer would.
//
// The carrier's decisions come from Test Tools (act): draft, issue, surrender, void.
//
// Amendments of an issued document (eBL 3.0.3 Direct Transport Document amendment): the shipper PUTs the
// amended document to …/amendment (AMENDMENT_RECEIVED), can DELETE it while it's still RECEIVED
// (AMENDMENT_CANCELLED), and GETs it. The carrier confirms it (the originals are then due back:
// PENDING_SURRENDER_FOR_AMENDMENT), they're surrendered (SURRENDERED_FOR_AMENDMENT) and it issues the amended
// document; or it declines it. Test Tools: confirmAmendment, declineAmendment, surrenderForAmendment, issue.

const { validateRequest, validateOutbound, validateOutboundSchema, errorsText } = require("../dcsa/validate");

const TERMS = "Carried subject to the demo carrier's standard terms and conditions of carriage (CargoDesk built-in DCSA carrier). "
  + "Received in apparent good order and condition, weight, measure, marks, numbers, quality, contents and value unknown.";

module.exports = function createTransportDocuments({ query, uid, baseUrl, deliver, loadSi, saveSi, notifySi, loadBookingByCarrierRef }) {
  const load = async ref => (await query("SELECT * FROM dcsa_sim_transport_documents WHERE td_ref=$1", [ref]))[0] || null;
  const forSi = async siRef => (await query("SELECT * FROM dcsa_sim_transport_documents WHERE si_ref=$1 ORDER BY created_at DESC LIMIT 1", [siRef]))[0] || null;
  const docOf = td => { try { return JSON.parse(td.document_json || "{}"); } catch { return {}; } };

  // The document as the carrier drafts it: the instructions' parties, cargo and equipment, with the
  // carrier's own reference, terms, issuing party and the sailing it confirmed on the booking.
  function draftDocument({ tdRef, siRef, carrierCode, request: r, booking = {} }) {
    const plan = Array.isArray(booking.transportPlan) ? booking.transportPlan : [];
    const sea = plan.filter(l => l.modeOfTransport === "VESSEL" || l.vesselName);
    const first = sea[0] || {}, last = sea[sea.length - 1] || first;
    const where = code => (booking.shipmentLocations || []).find(l => l.locationTypeCode === code)?.location?.UNLocationCode;
    const pol = first.loadLocation?.UNLocationCode || where("POL") || r.invoicePayableAt?.UNLocationCode || "";
    const pod = last.dischargeLocation?.UNLocationCode || where("POD") || "";
    const isoFor = new Map((booking.requestedEquipments || []).map(e => [e.ISOEquipmentCode, e.ISOEquipmentCode]));
    const anyIso = [...isoFor.keys()][0];
    const counts = {};
    for (const k of ["numberOfOriginalsWithCharges", "numberOfOriginalsWithoutCharges", "numberOfCopiesWithCharges", "numberOfCopiesWithoutCharges"])
      if (r[k] !== undefined) counts[k] = r[k];
    const consignee = r.documentParties?.consignee;
    return {
      transportDocumentReference: tdRef,
      shippingInstructionsReference: siRef,
      transportDocumentStatus: "DRAFT",
      transportDocumentTypeCode: r.transportDocumentTypeCode || "BOL",
      isShippedOnBoardType: r.isShippedOnBoardType !== false,
      ...(r.freightPaymentTermCode ? { freightPaymentTermCode: r.freightPaymentTermCode } : {}),
      isElectronic: !!r.isElectronic,
      isToOrder: !!r.isToOrder,
      ...counts,
      termsAndConditions: TERMS,
      receiptTypeAtOrigin: booking.receiptTypeAtOrigin || "CY",
      deliveryTypeAtDestination: booking.deliveryTypeAtDestination || "CY",
      cargoMovementTypeAtOrigin: booking.cargoMovementTypeAtOrigin || "FCL",
      cargoMovementTypeAtDestination: booking.cargoMovementTypeAtDestination || "FCL",
      ...(booking.serviceContractReference ? { serviceContractReference: booking.serviceContractReference }
        : booking.contractQuotationReference ? { contractQuotationReference: booking.contractQuotationReference } : {}),
      carrierCode: String(carrierCode || r.carrierCode || "DEMO").slice(0, 4),
      carrierCodeListProvider: "NMFTA",
      transports: {
        plannedDepartureDate: first.plannedDepartureDate || booking.expectedDepartureDate || new Date().toISOString().slice(0, 10),
        plannedArrivalDate: last.plannedArrivalDate || first.plannedDepartureDate || new Date().toISOString().slice(0, 10),
        portOfLoading: { UNLocationCode: pol },
        portOfDischarge: { UNLocationCode: pod },
        vesselVoyages: (sea.length ? sea : [{ vesselName: booking.vessel?.name || "DEMO VESSEL", carrierExportVoyageNumber: booking.carrierExportVoyageNumber || "DM001W" }])
          .map(l => ({ vesselName: l.vesselName || "DEMO VESSEL", carrierExportVoyageNumber: l.carrierExportVoyageNumber || l.carrierImportVoyageNumber || "DM001W" })),
      },
      invoicePayableAt: r.invoicePayableAt || { UNLocationCode: pol },
      partyContactDetails: [{ name: "Documentation desk", email: "documentation@demo-carrier.example" }],
      documentParties: {
        shipper: r.documentParties?.shipper,
        // A Master B/L consignee carries its identifying codes (the spec requires the list); the carrier
        // passes on what the instructions gave.
        ...(consignee ? { consignee: { ...consignee, identifyingCodes: consignee.identifyingCodes || [] } } : {}),
        ...(r.documentParties?.notifyParties?.length ? { notifyParties: r.documentParties.notifyParties } : {}),
        issuingParty: { partyName: `${String(carrierCode || "Demo").slice(0, 4)} demo carrier`, address: { street: "Demo Quay 1", city: "Rotterdam", countryCode: "NL" } },
      },
      consignmentItems: (r.consignmentItems || []).map(ci => ({
        carrierBookingReference: ci.carrierBookingReference,
        descriptionOfGoods: ci.descriptionOfGoods || [],
        HSCodes: ci.HSCodes || [],
        ...(ci.shippingMarks?.length ? { shippingMarks: ci.shippingMarks } : {}),
        cargoItems: (ci.cargoItems || []).map(c => ({
          equipmentReference: c.equipmentReference,
          cargoGrossWeight: c.cargoGrossWeight,
          ...(c.cargoGrossVolume ? { cargoGrossVolume: c.cargoGrossVolume } : {}),
          // Shipper's load and count: without a package count from the shipper, one container said to contain.
          outerPackaging: c.outerPackaging || { numberOfPackages: 1, description: "Container said to contain" },
        })),
      })),
      utilizedTransportEquipments: (r.utilizedTransportEquipments || []).map(u => {
        const iso = u.equipment?.ISOEquipmentCode || anyIso;
        // Reefer settings come from the booking (Shipping Instructions don't carry them).
        const reefer = (booking.requestedEquipments || []).find(e => e.ISOEquipmentCode === iso)?.activeReeferSettings;
        return {
          equipment: { equipmentReference: u.equipmentReference || u.equipment?.equipmentReference, ...(iso ? { ISOEquipmentCode: iso } : {}) },
          isShipperOwned: !!u.isShipperOwned,
          ...(reefer ? { isNonOperatingReefer: false, activeReeferSettings: reefer } : {}),
          seals: u.seals || [],
        };
      }),
      ...(r.references?.length ? { references: r.references } : {}),
    };
  }

  async function save(td, changes, feedback) {
    const next = { ...td, ...changes, updated_at: new Date().toISOString() };
    if (feedback !== undefined) next.feedbacks_json = JSON.stringify(feedback ? [feedback] : []);
    await query(`UPDATE dcsa_sim_transport_documents SET status=$1, document_json=$2, feedbacks_json=$3, updated_at=$4,
      amended_status=$5, amendment_json=$6 WHERE td_ref=$7`,
      [next.status, next.document_json, next.feedbacks_json || "[]", next.updated_at, next.amended_status || "", next.amendment_json || "", td.td_ref]);
    return next;
  }
  const withStatus = (td, status, extra = {}) => JSON.stringify({ ...docOf(td), transportDocumentStatus: status, ...extra });

  async function notify(td) {
    let feedbacks = [];
    try { feedbacks = JSON.parse(td.feedbacks_json || "[]"); } catch { feedbacks = []; }
    // Lightweight, as the spec's own examples: the status and the document's reference only — the subscriber
    // reads the document (and from it the instructions it came from). The status in the notification's own
    // spellings (TransportDocumentData documents VOID and SURRENDER_FOR_*; the document says VOIDED…).
    const NOTIFICATION_SPELLING = { VOIDED: "VOID", SURRENDERED_FOR_DELIVERY: "SURRENDER_FOR_DELIVERY", SURRENDERED_FOR_AMENDMENT: "SURRENDER_FOR_AMENDMENT" };
    const event = { specversion: "1.0", id: require("crypto").randomUUID(), source: baseUrl(), type: "org.dcsa.transport-document.v3",
      time: new Date().toISOString(), datacontenttype: "application/json", subscriptionReference: "cargodesk-dcsa-simulator",
      data: { transportDocumentStatus: NOTIFICATION_SPELLING[td.status] || td.status,
        ...(td.amended_status ? { amendedTransportDocumentStatus: td.amended_status } : {}),
        transportDocumentReference: td.td_ref, ...(feedbacks.length ? { feedbacks } : {}) } };
    const v = validateOutbound("ebl", "post", "/v3/transport-document-notifications", event);
    if (!v.ok) throw new Error(`DCSA simulator built an invalid transport document notification: ${errorsText(v.errors)}`);
    return deliver(event, { retries: [250, 1000] });
  }

  // ─── The carrier's decisions (Test Tools) ──────────────────────────────────
  const today = () => new Date().toISOString().slice(0, 10);
  const ACTIONS = {
    // Draft (or redraft after the shipper updated the instructions) from the Shipping Instructions.
    draft: async (si, td) => {
      // RECEIVED, or the correction to an update the carrier asked for (PENDING_UPDATE + UPDATE_RECEIVED).
      const answersUpdate = si.status === "PENDING_UPDATE" && si.updated_status === "UPDATE_RECEIVED";
      if (si.status !== "RECEIVED" && !answersUpdate) return { error: `Shipping Instructions that are ${si.status} can't be drafted into a transport document`, status: 409 };
      if (td && !["DRAFT", "APPROVED"].includes(td.status)) return { error: `The transport document is already ${td.status}`, status: 409 };
      let request = {};
      try { request = JSON.parse(si.request_json || "{}"); } catch { request = {}; }
      const bookingRef = request.consignmentItems?.[0]?.carrierBookingReference || "";
      const booking = bookingRef ? await loadBookingByCarrierRef(bookingRef) : null;
      // No booking of its own behind the instructions: the carrier declines them, saying why (the shipper
      // can't fix that with an update: it needs a booking with this carrier).
      if (!booking) {
        const message = `${String(si.carrier_code || "The carrier").slice(0, 4)} holds no confirmed booking ${bookingRef || "(none named)"}: these Shipping Instructions can't be drafted into a transport document`;
        const nextSi = await saveSi(si, { status: "DECLINED", updated_status: "" }, { severity: "ERROR", code: "PROPERTY_VALUE_MUST_CHANGE", message });
        return { siDelivery: await notifySi(nextSi, { retries: [250, 1000] }), refused: message };
      }
      const tdRef = td?.td_ref || `${String(si.carrier_code || "DEMO").slice(0, 4)}${String(Date.now()).slice(-8)}${uid().slice(0, 3)}`.slice(0, 20);
      const doc = draftDocument({ tdRef, siRef: si.si_ref, carrierCode: si.carrier_code, request, booking });
      const check = validateOutboundSchema("ebl", "TransportDocument", doc);
      // Instructions a valid transport document can't be drafted from: the carrier asks for an update,
      // saying what's missing, as a real carrier would.
      if (!check.ok) {
        const message = `The transport document can't be drafted from these Shipping Instructions: ${errorsText(check.errors, 4)}`;
        const nextSi = await saveSi(si, { status: "PENDING_UPDATE", updated_status: "" }, { severity: "ERROR", code: "PROPERTY_VALUE_MUST_CHANGE", message });
        return { siDelivery: await notifySi(nextSi, { retries: [250, 1000] }), refused: message };
      }
      const now = new Date().toISOString();
      if (td) td = await save(td, { status: "DRAFT", document_json: JSON.stringify(doc) }, null);
      else {
        await query(`INSERT INTO dcsa_sim_transport_documents (td_ref, si_ref, carrier_code, status, document_json, feedbacks_json, created_at, updated_at)
          VALUES ($1,$2,$3,'DRAFT',$4,'[]',$5,$5)`, [tdRef, si.si_ref, si.carrier_code || "", JSON.stringify(doc), now]);
        td = await load(tdRef);
      }
      // An update the carrier has now worked into the draft is confirmed (and a requested one settles the request).
      if (si.updated_status === "UPDATE_RECEIVED") {
        const nextSi = await saveSi(si, { status: "RECEIVED", updated_status: "UPDATE_CONFIRMED" }, null);
        await notifySi(nextSi, { retries: [250, 1000] });
      }
      return { td };
    },
    issue: async (si, td) => {
      // The amended document, once the originals of the one it replaces are back.
      if (td?.status === "SURRENDERED_FOR_AMENDMENT" && td.amended_status === "AMENDMENT_CONFIRMED" && td.amendment_json) {
        let amended = {};
        try { amended = JSON.parse(td.amendment_json); } catch { amended = {}; }
        return { td: await save(td, { status: "ISSUED", amendment_json: "", document_json: JSON.stringify({ ...amended, transportDocumentStatus: "ISSUED", issueDate: today() }) }, null) };
      }
      if (!td || !["DRAFT", "APPROVED"].includes(td.status)) return { error: `Only a draft or approved transport document can be issued (it is ${td?.status || "not drafted"})`, status: 409 };
      const doc = docOf(td);
      const onBoard = doc.transports?.plannedDepartureDate || today();
      return { td: await save(td, { status: "ISSUED", document_json: withStatus(td, "ISSUED", {
        issueDate: today(), placeOfIssue: { UNLocationCode: doc.transports?.portOfLoading?.UNLocationCode || "NLRTM" },
        ...(doc.isShippedOnBoardType ? { shippedOnBoardDate: onBoard, displayedShippedOnBoardReceivedForShipment: `Shipped on board ${onBoard}` }
          : { receivedForShipmentDate: today(), displayedShippedOnBoardReceivedForShipment: `Received for shipment ${today()}` }),
      }) }, null) };
    },
    // The B/L handed in at destination: the transport document is surrendered for delivery, which is
    // what COMPLETED means for the Shipping Instructions.
    surrender: async (si, td) => {
      if (!td || td.status !== "ISSUED") return { error: `Only an issued transport document can be surrendered (it is ${td?.status || "not drafted"})`, status: 409 };
      const next = await save(td, { status: "SURRENDERED_FOR_DELIVERY", document_json: withStatus(td, "SURRENDERED_FOR_DELIVERY") }, null);
      if (si && si.status !== "COMPLETED") {
        const nextSi = await saveSi(si, { status: "COMPLETED", updated_status: "" }, null);
        await notifySi(nextSi, { retries: [250, 1000] });
      }
      return { td: next };
    },
    // The shipper's amendment: accepted (an issued paper or electronic B/L must come back first), or declined.
    confirmAmendment: async (si, td) => {
      if (td?.amended_status !== "AMENDMENT_RECEIVED") return { error: `There is no amendment waiting (it is ${td?.amended_status || "none"})`, status: 409 };
      return { td: await save(td, { amended_status: "AMENDMENT_CONFIRMED",
        status: td.status === "ISSUED" ? "PENDING_SURRENDER_FOR_AMENDMENT" : td.status,
        document_json: withStatus(td, td.status === "ISSUED" ? "PENDING_SURRENDER_FOR_AMENDMENT" : td.status) },
        { severity: "INFO", code: "INFORMATIONAL_MESSAGE", message: "Amendment accepted. Surrender the originals for amendment; the amended transport document is issued next." }) };
    },
    declineAmendment: async (si, td, { message }) => {
      if (td?.amended_status !== "AMENDMENT_RECEIVED") return { error: `There is no amendment waiting (it is ${td?.amended_status || "none"})`, status: 409 };
      return { td: await save(td, { amended_status: "AMENDMENT_DECLINED" },
        { severity: "ERROR", code: "PROPERTY_VALUE_MUST_CHANGE", message: String(message || "The amendment can't be made at this stage").slice(0, 5000) }) };
    },
    surrenderForAmendment: async (si, td) => {
      if (td?.status !== "PENDING_SURRENDER_FOR_AMENDMENT") return { error: `The transport document isn't waiting for a surrender for amendment (it is ${td?.status || "not drafted"})`, status: 409 };
      return { td: await save(td, { status: "SURRENDERED_FOR_AMENDMENT", document_json: withStatus(td, "SURRENDERED_FOR_AMENDMENT") }, null) };
    },
    void: async (si, td, { message }) => {
      if (!td || ["VOIDED", "SURRENDERED_FOR_DELIVERY"].includes(td.status)) return { error: `The transport document can't be voided (it is ${td?.status || "not drafted"})`, status: 409 };
      return { td: await save(td, { status: "VOIDED", document_json: withStatus(td, "VOIDED") },
        message ? { severity: "WARN", code: "INFORMATIONAL_MESSAGE", message: String(message).slice(0, 5000) } : null) };
    },
  };

  // → { ok, transportDocument, delivery } | { ok:false, status, error }
  async function act(siRef, action, { message = "" } = {}) {
    const fn = ACTIONS[action];
    if (!fn) return { ok: false, status: 400, error: `Unknown transport document action "${action}" (${Object.keys(ACTIONS).join(", ")})` };
    const si = await loadSi(siRef);
    if (!si) return { ok: false, status: 404, error: `The simulator has no Shipping Instructions ${siRef}` };
    const r = await fn(si, await forSi(siRef), { message });
    if (r.error) return { ok: false, status: r.status || 409, error: r.error };
    if (r.refused) return { ok: true, refused: r.refused, delivery: r.siDelivery };
    const delivery = await notify(r.td);
    return { ok: true, transportDocument: { ...docOf(r.td), transportDocumentStatus: r.td.status }, delivery };
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────
  function registerRoutes(app, { fail }) {
    app.get("/dcsa-sim/v3/transport-documents/:ref", async (req, res) => {
      const td = await load(req.params.ref);
      if (!td) return fail(req, res, 404, "Not Found", `No transport document ${req.params.ref}`);
      let feedbacks = [];
      try { feedbacks = JSON.parse(td.feedbacks_json || "[]"); } catch { feedbacks = []; }
      res.json({ ...docOf(td), transportDocumentStatus: td.status, ...(feedbacks.length ? { feedbacks } : {}) });
    });
    // The shipper approves the draft (ApproveTransportDocument: the only value is APPROVED).
    app.patch("/dcsa-sim/v3/transport-documents/:ref", async (req, res) => {
      const td = await load(req.params.ref);
      if (!td) return fail(req, res, 404, "Not Found", `No transport document ${req.params.ref}`);
      if (req.body?.transportDocumentStatus !== "APPROVED")
        return fail(req, res, 400, "Bad Request", "transportDocumentStatus can only be set to APPROVED");
      if (td.status !== "DRAFT") return fail(req, res, 409, "Conflict", `A ${td.status} transport document can't be approved`);
      const next = await save(td, { status: "APPROVED", document_json: withStatus(td, "APPROVED") }, null);
      res.status(202).end();
      setTimeout(() => notify(next).catch(e => console.error("DCSA simulator:", e.message)), 50);
    });

    // ─── Direct Transport Document amendments (optional in eBL 3.0.3; this carrier takes them) ───
    app.put("/dcsa-sim/v3/transport-documents/:ref/amendment", async (req, res) => {
      const td = await load(req.params.ref);
      if (!td) return fail(req, res, 404, "Not Found", `No transport document ${req.params.ref}`);
      const v = validateRequest("ebl", "put", "/v3/transport-documents/{transportDocumentReference}/amendment", req.body);
      if (!v.ok) return fail(req, res, 400, "Bad Request", "The amended transport document does not match DCSA eBL 3.0",
        v.errors.slice(0, 20).map(e => ({ errorCodeText: "invalidInput", errorCodeMessage: `${e.path} ${e.message}`, jsonPath: "$" + e.path.replace(/\//g, ".") })));
      if (!["DRAFT", "ISSUED", "PENDING_SURRENDER_FOR_AMENDMENT"].includes(td.status))
        return fail(req, res, 409, "Conflict", `A ${td.status} transport document can't be amended`);
      if (req.body.transportDocumentReference && req.body.transportDocumentReference !== td.td_ref)
        return fail(req, res, 400, "Bad Request", `The amended document names ${req.body.transportDocumentReference}, not ${td.td_ref}`);
      // A new amendment replaces any earlier one.
      const next = await save(td, { amended_status: "AMENDMENT_RECEIVED", amendment_json: JSON.stringify(req.body) }, null);
      res.status(202).end();
      setTimeout(() => notify(next).catch(e => console.error("DCSA simulator:", e.message)), 50);
    });
    app.get("/dcsa-sim/v3/transport-documents/:ref/amendment", async (req, res) => {
      const td = await load(req.params.ref);
      if (!td || !td.amended_status) return fail(req, res, 404, "Not Found", `No amendment of transport document ${req.params.ref}`);
      let amended = docOf(td);
      try { if (td.amendment_json) amended = JSON.parse(td.amendment_json); } catch { /* the document as it stands */ }
      res.json({ amendedTransportDocumentStatus: td.amended_status, amendedTransportDocument: { ...amended, transportDocumentStatus: td.status } });
    });
    app.delete("/dcsa-sim/v3/transport-documents/:ref/amendment", async (req, res) => {
      const td = await load(req.params.ref);
      if (!td || !td.amended_status) return fail(req, res, 404, "Not Found", `No amendment of transport document ${req.params.ref}`);
      if (td.amended_status !== "AMENDMENT_RECEIVED")
        return fail(req, res, 400, "Bad Request", `An amendment that is ${td.amended_status} can't be cancelled`);
      const next = await save(td, { amended_status: "AMENDMENT_CANCELLED", amendment_json: "" }, null);
      res.status(202).end();
      setTimeout(() => notify(next).catch(e => console.error("DCSA simulator:", e.message)), 50);
    });
  }

  async function list() {
    const rows = await query("SELECT * FROM dcsa_sim_transport_documents ORDER BY updated_at DESC LIMIT 200");
    return rows.map(r => ({ transportDocumentReference: r.td_ref, shippingInstructionsReference: r.si_ref, carrierCode: r.carrier_code,
      transportDocumentStatus: r.status, amendedTransportDocumentStatus: r.amended_status || "", updatedAt: r.updated_at }));
  }

  return { act, registerRoutes, list, forSi, draftDocument, ACTIONS: Object.keys(ACTIONS) };
};
