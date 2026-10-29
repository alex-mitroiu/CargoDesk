"use strict";
// Generic DCSA adapter (Epic TKT-KG4E49): Booking 2.0, Track & Trace 3.0 and Commercial Schedules
// 1.0 here, Shipping Instructions 3.0 (dcsa-ebl-v3.js) and VGM 1.0 (dcsa-vgm-v1.js) beside it — reusable
// across any DCSA-compliant carrier (Hapag-Lloyd, CMA CGM, MSC and ONE are DCSA members), registered
// under the adapter key 'dcsa-bkg-v2' in server.js. A second carrier on the standard is a new
// carrier_integrations row, not a new adapter file.
//
// Built against the published specs, not guessed: DCSA's own conformance suite
// (github.com/dcsaorg/Conformance-Gateway) — booking/.../BKG_v2.0.0.yaml (API 2.0.3),
// tnt/.../TNT_v2.2.0-resolved.yaml, commercial-schedules/.../CS_v1.0.0.yaml (API 1.0.1), read on
// 2026-10-09; checked again against the vendored specs (lib/dcsa/specs) on 2026-10-27, when Track &
// Trace moved to 3.0 and the Booking 2.0 "Condition" rules the schema can't express were added. The v0.91.0 version of this file missed six of CreateBooking's eight required
// fields, sent CargoDesk's "40HC" where an ISO 6346 code is required, read notifications as a flat
// body although they are CloudEvents (the booking state sits under `data`), and called a guessed
// schedules path. Paths and field names below are the spec's.
//
// Every network-touching function returns { ok, ... } / { ok:false, error } and never throws past
// its own boundary — the rule lib/ais-listener.js states for code that talks to an external system.
// buildBookingRequest / normalizeBookingState / parseCallback / verifyCallback / mapPointToPoint
// are pure, so tests/carrier-integrations.test.js covers them without a network.

const crypto = require("crypto");
const { dcsaCall: call } = require("./dcsa-http");

const ADAPTER_KEY = "dcsa-bkg-v2";

// CargoDesk "size+type" (e.g. "40HC") → ISO 6346 size-type code, which DCSA's ISOEquipmentCode is.
const ISO_EQUIPMENT = {
  "20GP": "22G1", "20DC": "22G1", "20DV": "22G1", "40GP": "42G1", "40DC": "42G1", "40DV": "42G1",
  "40HC": "45G1", "40HQ": "45G1", "45HC": "L5G1",
  "20RF": "22R1", "40RF": "42R1", "40RH": "45R1", "40HR": "45R1",
  "20OT": "22U1", "40OT": "42U1", "20FR": "22P1", "40FR": "42P1", "20TK": "22T1",
};
const isoEquipmentCode = type => {
  const t = String(type || "").toUpperCase();
  return ISO_EQUIPMENT[t] || (/^[0-9L][0-9A-Z][A-Z][0-9A-Z]$/.test(t) ? t : t.slice(0, 4));
};

// "Door-to-Port" → receipt SD (store door) at origin, CY at destination; anything at a port is CY.
const receiptDeliveryTypes = serviceType => {
  const [from, to] = String(serviceType || "Port-to-Port").split(/-to-/i);
  const t = s => (/door/i.test(s || "") ? "SD" : "CY");
  return { receiptTypeAtOrigin: t(from), deliveryTypeAtDestination: t(to) };
};

const UNLOCODE = /^[A-Z]{2}[A-Z2-9]{3}$/;
const locationOf = place => {
  const s = String(place || "").trim();
  if (!s) return null;
  return UNLOCODE.test(s.toUpperCase()) ? { UNLocationCode: s.toUpperCase() } : { locationName: s.slice(0, 100) };
};
const clip = (s, n) => String(s || "").trim().slice(0, n);

// CreateBooking / UpdateBooking (the same required set). requestPayload is what routes/edi.js
// assembles for every booking request (pol/pod/etd/vessel/voyage/equipment/…), plus the booking
// fields only this adapter needs (serviceType, movementType, freightTerms, incoterm,
// bookingAgentName, commodityDescription, hsCodes, declaredValue). Required fields are always
// sent; an optional field with no source data is left out, never invented.
function buildBookingRequest(shipment, p = {}) {
  const { receiptTypeAtOrigin, deliveryTypeAtDestination } = receiptDeliveryTypes(p.serviceType);
  const movement = /LCL/i.test(p.movementType || "") ? "LCL" : "FCL";
  const reeferByType = {};
  for (const r of p.reeferCargo || []) if (reeferByType[r.type] == null) reeferByType[r.type] = r.setTemperatureC;
  const commodityType = clip(p.commodityDescription || p.commodityName, 550);
  const hsCodes = (p.hsCodes || []).map(h => String(h).replace(/\D/g, "").slice(0, 10)).filter(h => h.length >= 6);

  // Dangerous goods on each equipment line (2026-10-29): one commodity per UN number, proper shipping name
  // and class, its weight and packages summed, with DCSA's DangerousGoods. CargoDesk records the UN number,
  // name, class and weight; the yes/no facts it doesn't record (marine pollutant, limited quantity, …) go as
  // false, and the carrier's DG desk confirms them. The emergency contact is the company's (App Settings).
  const dgCommodities = type => {
    const byKey = new Map();
    for (const d of (p.dangerousGoods || []).filter(x => x.type === type)) {
      const k = `${d.UNNumber}|${d.properShippingName}|${d.imoClass}`;
      const e = byKey.get(k) || byKey.set(k, { ...d, grossWeightKg: 0, packages: 0, hs: new Set() }).get(k);
      e.grossWeightKg += d.grossWeightKg; e.packages += d.packages;
      if (d.hsCode.length >= 6) e.hs.add(d.hsCode.slice(0, 10));
    }
    return [...byKey.values()].map(d => ({
      commodityType: clip(d.properShippingName, 550),
      ...(d.hs.size ? { HSCodes: [...d.hs] } : {}),
      cargoGrossWeight: { value: d.grossWeightKg, unit: "KGM" },
      outerPackaging: {
        ...(d.packageCode ? { packageCode: d.packageCode } : {}),
        ...(d.packages > 0 ? { numberOfPackages: d.packages } : {}),
        description: clip(d.packageDescription || "Dangerous goods", 100),
        dangerousGoods: [{
          UNNumber: d.UNNumber, properShippingName: clip(d.properShippingName, 250), imoClass: clip(d.imoClass, 4),
          isMarinePollutant: false, isLimitedQuantity: false, isExceptedQuantity: false, isSalvagePackings: false, isEmptyUncleanedResidue: false,
          isWaste: false, isHot: false, isCompetentAuthorityApprovalRequired: false, isReportableQuantity: false,
          emergencyContactDetails: { contact: clip(p.dgEmergencyContact?.contact, 255), phone: clip(p.dgEmergencyContact?.phone, 30),
            ...(p.dgEmergencyContact?.provider ? { provider: clip(p.dgEmergencyContact.provider, 255) } : {}),
            ...(p.dgEmergencyContact?.referenceNumber ? { referenceNumber: clip(p.dgEmergencyContact.referenceNumber, 255) } : {}) },
          grossWeight: { value: d.grossWeightKg, unit: "KGM" },
        }],
      },
    }));
  };
  const requestedEquipments = (Array.isArray(p.equipment) ? p.equipment : []).filter(eq => (eq.count || 0) > 0).map(eq => {
    const commodities = [...(commodityType ? [{ commodityType, ...(hsCodes.length ? { HSCodes: hsCodes } : {}) }] : []), ...dgCommodities(eq.type)];
    return {
      ISOEquipmentCode: isoEquipmentCode(eq.type),
      units: eq.count,
      isShipperOwned: false,
      ...(eq.totalWeightKg > 0 ? { cargoGrossWeight: { value: eq.totalWeightKg, unit: "KGM" } } : {}),
      ...(reeferByType[eq.type] != null ? { activeReeferSettings: { temperatureSetpoint: Number(reeferByType[eq.type]), temperatureUnit: "CEL" } } : {}),
      ...(commodities.length ? { commodities } : {}),
    };
  });

  const shipmentLocations = [];
  const add = (code, place) => { const location = locationOf(place); if (location) shipmentLocations.push({ locationTypeCode: code, location }); };
  if (receiptTypeAtOrigin === "SD") add("PRE", p.placeOfReceipt);
  add("POL", p.pol);
  add("POD", p.pod);
  if (deliveryTypeAtDestination === "SD") add("PDE", p.placeOfDelivery);

  const party = name => (clip(name, 70) ? { partyName: clip(name, 70) } : null);
  const contacts = c => (c && clip(c.name, 35) && (c.email || c.phone)
    ? [{ name: clip(c.name, 35), ...(c.email ? { email: clip(c.email, 100) } : {}), ...(c.phone ? { phone: clip(c.phone, 30) } : {}) }] : null);
  const address = a => (a && clip(a.street, 70) && clip(a.city, 35) && /^[A-Z]{2}$/.test(a.countryCode || "")
    ? { street: clip(a.street, 70), ...(clip(a.postCode, 10) ? { postCode: clip(a.postCode, 10) } : {}), city: clip(a.city, 35), countryCode: a.countryCode } : null);
  // The booking agent is CargoDesk's legal entity (left out when unknown: DCSA doesn't require one,
  // and a made-up name would be worse). The carrier's booking office is the Line Agent (Export): the
  // carrier's local representative at the port of loading, so the booking reaches the local office
  // the forwarder works with, not the carrier's head office (the user, 2026-10-27).
  const agent = p.bookingAgent || (p.bookingAgentName ? { name: p.bookingAgentName } : null);
  const office = p.carrierBookingOffice;
  const documentParties = {
    ...(party(agent?.name) ? { bookingAgent: { ...party(agent.name), ...(contacts(agent.contact) ? { partyContactDetails: contacts(agent.contact) } : {}) } } : {}),
    ...(party(p.shipperName) ? { shipper: party(p.shipperName) } : {}),
    ...(party(p.consigneeName) ? { consignee: party(p.consigneeName) } : {}),
    ...(party(office?.name) && UNLOCODE.test(office.UNLocationCode || "") ? { carrierBookingOffice: {
      ...party(office.name), UNLocationCode: office.UNLocationCode,
      ...(address(office.address) ? { address: address(office.address) } : {}),
      ...(contacts(office.contact) ? { partyContactDetails: contacts(office.contact) } : {}),
    } } : {}),
  };
  // Exactly one of the contract's number or a quotation reference (a Condition of Booking 2.0). A spot
  // offer gives the quotation reference; otherwise a shipment carries the number typed on it
  // (contractRef): on a SPOT shipment that is the carrier's quote, on any other (Customer Own, Pending,
  // a Central contract CargoDesk doesn't hold) the service contract.
  const typedIsQuote = p.contractType === "SPOT";
  const serviceContractReference = clip(p.contractNumber || (p.quotationReference || typedIsQuote ? "" : p.contractRef), 30);
  const quotationReference = !serviceContractReference ? clip(p.quotationReference || (typedIsQuote ? p.contractRef : ""), 35) : "";
  // A voyage number goes with the vessel or the service it belongs to (Booking 2.0: the service is
  // mandatory for a voyage without vessel details).
  const voyage = p.voyage && (p.vessel || p.service) ? clip(p.voyage, 50) : "";

  return {
    // CargoDesk's carrier codes are SCACs (MAEU, HLCU, EGLV…), NMFTA's code list.
    ...((p.carrierCode || shipment?.carrier_code) ? { carrierCode: clip(p.carrierCode || shipment.carrier_code, 4), carrierCodeListProvider: "NMFTA" } : {}),
    receiptTypeAtOrigin, deliveryTypeAtDestination,
    cargoMovementTypeAtOrigin: movement, cargoMovementTypeAtDestination: movement,
    isEquipmentSubstitutionAllowed: false,
    ...(p.vessel ? { vessel: { name: clip(p.vessel, 50), ...(p.vesselImo ? { vesselIMONumber: clip(p.vesselImo, 8) } : {}) } } : {}),
    ...(p.service ? { carrierServiceCode: clip(p.service, 11) } : {}),
    ...(voyage ? { carrierExportVoyageNumber: voyage } : {}),
    ...(p.etd ? { expectedDepartureDate: String(p.etd).slice(0, 10) } : {}),
    ...(serviceContractReference ? { serviceContractReference } : quotationReference ? { contractQuotationReference: quotationReference } : {}),
    ...(p.freightTerms ? { freightPaymentTermCode: /collect/i.test(p.freightTerms) ? "COL" : "PRE" } : {}),
    ...((p.incoTerms || p.incoterm) ? { incoTerms: clip(p.incoTerms || p.incoterm, 3) } : {}),
    ...(p.declaredValue != null && p.declaredValue !== "" && Number(p.declaredValue) > 0
      ? { declaredValue: Number(p.declaredValue), declaredValueCurrency: clip(p.declaredValueCurrency || "USD", 3) } : {}),
    ...(p.exportFilingItn ? { isExportDeclarationRequired: true, exportDeclarationReference: clip(p.exportFilingItn, 35) } : {}),
    documentParties,
    shipmentLocations,
    requestedEquipments,
  };
}

// ─── Booking 2.0 "Condition" rules ───────────────────────────────────────────
// The spec writes these in descriptions, where schema validation can't see them; a carrier enforces
// them. → what the booking still needs, in plain words ([] when it may be sent).
function bookingConditionProblems(b = {}) {
  const problems = [];
  if (!b.serviceContractReference && !b.contractQuotationReference)
    problems.push("the service contract number (or the carrier's quotation reference for a spot booking)");
  if (b.serviceContractReference && b.contractQuotationReference)
    problems.push("only one of the service contract number and the quotation reference");
  const sailing = b.carrierExportVoyageNumber && (b.vessel?.name || b.carrierServiceCode || b.carrierServiceName);
  if (!b.expectedDepartureDate && !sailing && !(b.expectedArrivalAtPlaceOfDeliveryStartDate && b.expectedArrivalAtPlaceOfDeliveryEndDate))
    problems.push("the ETD, or the vessel and voyage");
  if (b.carrierExportVoyageNumber && !b.vessel?.name && !b.carrierServiceCode && !b.carrierServiceName)
    problems.push("the vessel or the service of the voyage");
  if (b.declaredValue !== undefined && !b.declaredValueCurrency) problems.push("the currency of the declared value");
  return problems;
}
const conditionsRefusal = b => {
  const problems = bookingConditionProblems(b);
  return problems.length ? { ok: false, invalid: true, problems, error: `Not sent: a DCSA booking needs ${problems.join(", ")}` } : null;
};

const bookingPath = ref => `/v2/bookings/${encodeURIComponent(ref)}`;

// ─── Booking 2.0 ─────────────────────────────────────────────────────────────
// POST /v2/bookings → 202 + { carrierBookingRequestReference }.
async function createBooking(config, dcsaPayload) {
  const refused = conditionsRefusal(dcsaPayload);
  if (refused) return refused;
  const r = await call(config, "POST", "/v2/bookings", { body: dcsaPayload, expect: [202], spec: ["bkg", "/v2/bookings"] });
  if (!r.ok) return r;
  if (!r.raw?.carrierBookingRequestReference) return { ok: false, error: "Carrier accepted but returned no carrierBookingRequestReference", raw: r.raw };
  return { ok: true, carrierBookingRequestReference: r.raw.carrierBookingRequestReference, raw: r.raw };
}

// PUT /v2/bookings/{ref} → 202, empty body. An update while the request is open (RECEIVED,
// PENDING_UPDATE, UPDATE_RECEIVED) or an amendment to a CONFIRMED booking — same call, the carrier
// tells them apart by the booking's state. ref = carrierBookingReference once known, else the
// carrierBookingRequestReference.
async function updateBooking(config, ref, dcsaPayload) {
  const refused = conditionsRefusal(dcsaPayload);
  if (refused) return refused;
  return call(config, "PUT", bookingPath(ref), { body: dcsaPayload, expect: [202], spec: ["bkg", "/v2/bookings/{bookingReference}"] });
}

// PATCH /v2/bookings/{ref} → 202. Before confirmation the shipper simply cancels
// (bookingStatus CANCELLED); a CONFIRMED booking can only be asked to cancel
// (bookingCancellationStatus CANCELLATION_RECEIVED) — the carrier answers later with
// CANCELLATION_CONFIRMED or CANCELLATION_DECLINED.
async function cancelBooking(config, ref, { confirmed = false, reason = "" } = {}) {
  const body = confirmed
    ? { bookingCancellationStatus: "CANCELLATION_RECEIVED", ...(reason ? { reason: clip(reason, 5000) } : {}) }
    : { bookingStatus: "CANCELLED", ...(reason ? { reason: clip(reason, 5000) } : {}) };
  return call(config, "PATCH", bookingPath(ref), { body, expect: [202], spec: ["bkg", "/v2/bookings/{bookingReference}"] });
}

// GET /v2/bookings/{ref} → 200 Booking. The polling path when no notification arrives.
async function getBookingStatus(config, ref) {
  const r = await call(config, "GET", bookingPath(ref), { expect: [200], spec: ["bkg", "/v2/bookings/{bookingReference}"] });
  if (!r.ok) return r;
  return { ok: true, state: normalizeBookingState(r.raw || {}), raw: r.raw };
}

// The three status fields DCSA tracks, from a notification's `data` or a GET Booking alike.
function normalizeBookingState(obj = {}) {
  return {
    bookingStatus: obj.bookingStatus || "",
    amendedBookingStatus: obj.amendedBookingStatus || "",
    bookingCancellationStatus: obj.bookingCancellationStatus || "",
    carrierBookingRequestReference: obj.carrierBookingRequestReference || null,
    carrierBookingReference: obj.carrierBookingReference || null,
    feedbacks: Array.isArray(obj.feedbacks) ? obj.feedbacks : [],
  };
}

// A short label for a state, used as carrier_bookings.last_response_status.
const STATUS_LABEL = {
  RECEIVED: "received", UPDATE_RECEIVED: "received", PENDING_UPDATE: "update_requested", PENDING_AMENDMENT: "update_requested",
  CONFIRMED: "confirmed", REJECTED: "rejected", DECLINED: "rejected", CANCELLED: "cancelled", COMPLETED: "completed",
};

// A notification (POST /v2/booking-notifications) is a CloudEvent: { specversion, id, source,
// type: "org.dcsa.booking.v2", time, …, data: { bookingStatus, carrierBookingRequestReference, … } }.
// A flat body (the v0.91.0 shape, still sent by the Test Tools simulator) is read the same way.
function parseCallback(body = {}) {
  const data = body && typeof body.data === "object" && body.data ? body.data : body;
  const state = normalizeBookingState(data);
  return {
    status: STATUS_LABEL[state.bookingStatus] || "update_requested",
    state,
    eventId: body.id || null,
    bookingRef: state.carrierBookingReference,
    carrierBookingRequestReference: state.carrierBookingRequestReference,
    raw: body,
  };
}

// DCSA leaves notification authentication to the integration (the spec's notification endpoint
// has no security scheme). This HMAC-SHA256 header check is a disclosed default pending a real
// carrier's scheme (TKT-HWCWCI) — the same HMAC + timingSafeEqual technique lib/shareToken.js uses.
function verifyCallback(rawBody, headers, config) {
  if (!config.webhookSecret) return false;
  const signatureHeader = headers["x-dcsa-signature"] || headers["X-DCSA-Signature"];
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha256", config.webhookSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const gotBuf = Buffer.from(String(signatureHeader).replace(/^sha256=/, ""), "utf8");
  if (expectedBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}

// ─── Track & Trace 3.0 ───────────────────────────────────────────────────────
// GET /events?carrierBookingReference=…&eventTypes=EQUIPMENT,TRANSPORT (API-Version 3.0.0) →
// { events: [...] }, each answer checked against the spec. Pages with the Next-Page-Cursor header
// (up to 10 pages). Was T&T 2.2's /v2/events until 2026-10-27, against a vendored 3.0 spec.
async function getEvents(config, { carrierBookingReference, eventTypes = ["SHIPMENT", "TRANSPORT", "EQUIPMENT"] } = {}) {
  if (!carrierBookingReference) return { ok: false, error: "A carrierBookingReference is needed to ask for events" };
  const events = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const r = await call(config, "GET", "/events", {
      query: { carrierBookingReference, eventTypes: eventTypes.join(","), limit: "100", ...(cursor ? { cursor } : {}) },
      expect: [200], spec: ["tnt", "/events"],
    });
    if (!r.ok) return r;
    events.push(...(Array.isArray(r.raw?.events) ? r.raw.events : []));
    cursor = r.headers?.get?.("Next-Page-Cursor");
    if (!cursor) break;
  }
  return { ok: true, events };
}

// ─── Commercial Schedules 1.0 ────────────────────────────────────────────────
// One PointToPoint routing → the sailing shape routes/system.js already returns (catalogSailings /
// mockSailings), so the sailing picker needs no change. The first vessel leg gives the vessel,
// service and voyage; a multi-leg routing carries its legs like a catalog sailing does.
function mapPointToPoint(route, { pol, pod, carrierCode } = {}) {
  const legs = Array.isArray(route.legs) ? [...route.legs].sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0)) : [];
  const legOf = l => {
    const sp = (l.transport?.servicePartners || [])[0] || {};
    return {
      pol: l.departure?.location?.UNLocationCode || "", pod: l.arrival?.location?.UNLocationCode || "",
      etd: String(l.departure?.dateTime || "").slice(0, 10), eta: String(l.arrival?.dateTime || "").slice(0, 10),
      vesselName: l.transport?.vessel?.name || "", vesselImo: l.transport?.vessel?.vesselIMONumber || "",
      voyageNumber: sp.carrierExportVoyageNumber || sp.carrierImportVoyageNumber || "", service: sp.carrierServiceCode || "",
      carrier: sp.carrierCode || carrierCode || "", mode: l.transport?.modeOfTransport || "",
    };
  };
  const mapped = legs.map(legOf);
  const vesselLegs = mapped.filter(l => l.mode === "VESSEL");
  const main = vesselLegs[0] || mapped[0] || {};
  const first = mapped[0] || {}, last = mapped[mapped.length - 1] || {};
  return {
    carrier: carrierCode || main.carrier || "", vesselName: main.vesselName || "—", vesselImo: main.vesselImo || "",
    voyageNumber: main.voyageNumber || "", service: main.service || "—",
    pol: pol || first.pol, pod: pod || last.pod,
    etd: String(route.placeOfReceipt?.dateTime || "").slice(0, 10) || first.etd,
    eta: String(route.placeOfDelivery?.dateTime || "").slice(0, 10) || last.eta,
    transitDays: route.transitTime || 0,
    legs: mapped.length >= 2 ? mapped.map(({ mode, ...l }) => l) : null,
    isMock: false, source: "live",
    ...(route.routingReference ? { routingReference: route.routingReference } : {}),
  };
}

// GET /v1/point-to-point-routes?placeOfReceipt=…&placeOfDelivery=… (both required) → PointToPoint[].
async function searchSchedules(config, { pol, pod, carrierCode, weeks = 4 } = {}) {
  const start = new Date();
  const end = new Date(start.getTime() + Math.max(1, weeks) * 7 * 86400000);
  const r = await call(config, "GET", "/v1/point-to-point-routes", {
    query: { placeOfReceipt: pol || "", placeOfDelivery: pod || "", departureStartDate: start.toISOString().slice(0, 10),
      departureEndDate: end.toISOString().slice(0, 10), limit: "50" },
    expect: [200], spec: ["cs", "/v1/point-to-point-routes"],
  });
  if (!r.ok) return r;
  const routes = Array.isArray(r.raw) ? r.raw : [];
  return { ok: true, sailings: routes.map(route => mapPointToPoint(route, { pol, pod, carrierCode })) };
}

module.exports = {
  adapterKey: ADAPTER_KEY,
  buildBookingRequest, bookingConditionProblems, createBooking, updateBooking, cancelBooking, getBookingStatus,
  normalizeBookingState, parseCallback, verifyCallback,
  getEvents, searchSchedules, mapPointToPoint, isoEquipmentCode,
};
