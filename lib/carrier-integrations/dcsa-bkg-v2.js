"use strict";
// Generic DCSA adapter (Epic TKT-KG4E49): Booking 2.0, Track & Trace 2.2 and Commercial Schedules
// 1.0 — reusable across any DCSA-compliant carrier (Hapag-Lloyd, CMA CGM, MSC and ONE are DCSA
// members), registered under the adapter key 'dcsa-bkg-v2' in server.js. A second carrier on the
// standard is a new carrier_integrations row, not a new adapter file.
//
// Built against the published specs, not guessed: DCSA's own conformance suite
// (github.com/dcsaorg/Conformance-Gateway) — booking/.../BKG_v2.0.0.yaml (API 2.0.3),
// tnt/.../TNT_v2.2.0-resolved.yaml, commercial-schedules/.../CS_v1.0.0.yaml (API 1.0.1), read on
// 2026-10-09. The v0.91.0 version of this file missed six of CreateBooking's eight required
// fields, sent CargoDesk's "40HC" where an ISO 6346 code is required, read notifications as a flat
// body although they are CloudEvents (the booking state sits under `data`), and called a guessed
// schedules path. Paths and field names below are the spec's.
//
// Every network-touching function returns { ok, ... } / { ok:false, error } and never throws past
// its own boundary — the rule lib/ais-listener.js states for code that talks to an external system.
// buildBookingRequest / normalizeBookingState / parseCallback / verifyCallback / mapPointToPoint
// are pure, so tests/carrier-integrations.test.js covers them without a network.

const crypto = require("crypto");
const { validateRequest, validateResponse, errorsText, specVersion } = require("../dcsa/validate");

// Which vendored spec a call is checked against (lib/dcsa/validate.js): [key, the spec's own path template].
const SPEC_NAME = { bkg: "Booking", cs: "Commercial Schedules", tnt: "Track & Trace" };

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

  const requestedEquipments = (Array.isArray(p.equipment) ? p.equipment : []).filter(eq => (eq.count || 0) > 0).map(eq => ({
    ISOEquipmentCode: isoEquipmentCode(eq.type),
    units: eq.count,
    isShipperOwned: false,
    ...(eq.totalWeightKg > 0 ? { cargoGrossWeight: { value: eq.totalWeightKg, unit: "KGM" } } : {}),
    ...(reeferByType[eq.type] != null ? { activeReeferSettings: { temperatureSetpoint: Number(reeferByType[eq.type]), temperatureUnit: "CEL" } } : {}),
    ...(commodityType ? { commodities: [{ commodityType, ...(hsCodes.length ? { HSCodes: hsCodes } : {}) }] } : {}),
  }));

  const shipmentLocations = [];
  const add = (code, place) => { const location = locationOf(place); if (location) shipmentLocations.push({ locationTypeCode: code, location }); };
  if (receiptTypeAtOrigin === "SD") add("PRE", p.placeOfReceipt);
  add("POL", p.pol);
  add("POD", p.pod);
  if (deliveryTypeAtDestination === "SD") add("PDE", p.placeOfDelivery);

  const party = name => (clip(name, 70) ? { partyName: clip(name, 70) } : null);
  const documentParties = {
    bookingAgent: party(p.bookingAgentName) || { partyName: "Booking agent" },
    ...(party(p.shipperName) ? { shipper: party(p.shipperName) } : {}),
    ...(party(p.consigneeName) ? { consignee: party(p.consigneeName) } : {}),
  };

  return {
    // CargoDesk's carrier codes are SCACs (MAEU, HLCU, EGLV…), NMFTA's code list.
    ...((p.carrierCode || shipment?.carrier_code) ? { carrierCode: clip(p.carrierCode || shipment.carrier_code, 4), carrierCodeListProvider: "NMFTA" } : {}),
    receiptTypeAtOrigin, deliveryTypeAtDestination,
    cargoMovementTypeAtOrigin: movement, cargoMovementTypeAtDestination: movement,
    isEquipmentSubstitutionAllowed: false,
    ...(p.vessel ? { vessel: { name: clip(p.vessel, 50), ...(p.vesselImo ? { vesselIMONumber: clip(p.vesselImo, 8) } : {}) } } : {}),
    ...(p.service ? { carrierServiceCode: clip(p.service, 11) } : {}),
    ...(p.voyage ? { carrierExportVoyageNumber: clip(p.voyage, 50) } : {}),
    ...(p.etd ? { expectedDepartureDate: String(p.etd).slice(0, 10) } : {}),
    ...(p.contractNumber ? { serviceContractReference: clip(p.contractNumber, 30) } : {}),
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

// ─── HTTP ────────────────────────────────────────────────────────────────────
const errorText = (status, raw) => {
  const detail = raw && typeof raw === "object"
    ? (raw.errors || []).map(e => e.errorCodeMessage || e.errorCodeText).filter(Boolean).join("; ") || raw.statusCodeMessage || raw.statusCodeText || ""
    : "";
  return `Carrier answered ${status}${detail ? `: ${detail}` : ""}`;
};

async function call(config, method, pathOrUrl, { body, query, expect = [200], spec } = {}) {
  // Nothing leaves CargoDesk that doesn't match the published spec — a real carrier would answer 400.
  if (spec && body !== undefined) {
    const v = validateRequest(spec[0], method, spec[1], body);
    if (!v.ok) return { ok: false, invalid: true, error: `Not sent: the message doesn't match DCSA ${SPEC_NAME[spec[0]]} ${specVersion(spec[0])} (${errorsText(v.errors, 3)})` };
  }
  try {
    const base = String(config.baseUrl || "").replace(/\/$/, "");
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl
      : `${base}${pathOrUrl}${query ? `?${new URLSearchParams(query)}` : ""}`;
    const major = (url.match(/\/v(\d+)\//) || [])[1];
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(major ? { "API-Version": major } : {}),
        [config.authHeaderName || "Authorization"]: config.credential || "",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let raw = null;
    try { raw = text ? JSON.parse(text) : null; } catch { raw = text; }
    if (!expect.includes(res.status)) return { ok: false, status: res.status, error: errorText(res.status, raw), raw };
    // …and nothing the carrier answers is used unless it matches the spec too.
    if (spec && method === "GET" && raw && typeof raw === "object") {
      const v = validateResponse(spec[0], method, spec[1], res.status, raw);
      if (!v.ok) return { ok: false, status: res.status, invalid: true, error: `The carrier's answer doesn't match DCSA ${SPEC_NAME[spec[0]]} ${specVersion(spec[0])} (${errorsText(v.errors, 3)})`, raw };
    }
    return { ok: true, status: res.status, raw, headers: res.headers };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
const bookingPath = ref => `/v2/bookings/${encodeURIComponent(ref)}`;

// ─── Booking 2.0 ─────────────────────────────────────────────────────────────
// POST /v2/bookings → 202 + { carrierBookingRequestReference }.
async function createBooking(config, dcsaPayload) {
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

// ─── Track & Trace 2.2 ───────────────────────────────────────────────────────
// GET /v2/events?carrierBookingReference=…&eventType=EQUIPMENT,TRANSPORT — comma-separated, per
// the spec. Pages through the Next-Page link header (up to 10 pages).
async function getEvents(config, { carrierBookingReference, eventTypes = ["EQUIPMENT", "TRANSPORT"] } = {}) {
  if (!carrierBookingReference) return { ok: false, error: "A carrierBookingReference is needed to ask for events" };
  let r = await call(config, "GET", "/v2/events", {
    query: { carrierBookingReference, eventType: eventTypes.join(","), limit: "100" }, expect: [200],
  });
  const events = [];
  for (let page = 0; r.ok && page < 10; page++) {
    if (Array.isArray(r.raw)) events.push(...r.raw);
    const next = r.headers?.get?.("Next-Page");
    if (!next) break;
    r = await call(config, "GET", /^https?:\/\//.test(next) ? next : `${String(config.baseUrl || "").replace(/\/$/, "")}${next}`, { expect: [200] });
  }
  if (!r.ok) return r;
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
  buildBookingRequest, createBooking, updateBooking, cancelBooking, getBookingStatus,
  normalizeBookingState, parseCallback, verifyCallback,
  getEvents, searchSchedules, mapPointToPoint, isoEquipmentCode,
};
