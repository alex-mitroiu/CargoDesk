"use strict";
// Generic DCSA Booking API v2.0.5 / Track & Trace adapter (Epic TKT-KG4E49, story 3) — built
// against the real, current public spec (dcsaorg/DCSA-OpenAPI on GitHub, bkg/v2), not a guessed
// schema, per this project's own lesson from the old Maersk integration (removed v0.72.1 for
// exactly that mistake). Reusable across any DCSA-compliant carrier (Hapag-Lloyd, CMA CGM, MSC,
// and ONE are all DCSA members on this same schema) — registered under the adapter key
// 'dcsa-bkg-v2' in server.js; a second carrier on this same standard is a new
// carrier_integrations config row, not a new adapter file.
//
// Every network-touching function returns { ok, ... } / { ok:false, error } and never throws
// past its own boundary — the same governing rule lib/ais-listener.js states for any code in
// this app that talks to an external system. buildBookingRequest/verifyCallback/parseCallback
// are pure (no I/O), so they're unit-testable without network access — see
// tests/carrier-integrations.test.js.

const crypto = require("crypto");

const ADAPTER_KEY = "dcsa-bkg-v2";

// Booking Request v2.0.5 field names below (carrierServiceCode, carrierExportVoyageNumber,
// vessel.vesselIMONumber, shipmentLocations[].locationTypeCode/location.UNLocationCode,
// requestedEquipments[].ISOEquipmentCode/units/commodities) are the real, confirmed spec names.
// Only fields this app actually has source data for (routes/edi.js's existing requestPayload)
// are populated — DCSA fields with no source data (serviceContractReference,
// isPartialLoadAllowed, etc.) are intentionally omitted rather than guessed at.
function buildBookingRequest(shipment, requestPayload) {
  const equipmentGroups = Array.isArray(requestPayload.equipment) ? requestPayload.equipment : [];
  const requestedEquipments = equipmentGroups.map(eq => ({
    ISOEquipmentCode: eq.type || "",
    units: eq.count || 0,
    commodities: requestPayload.commodityCode ? [{ commodityType: requestPayload.commodityCode }] : [],
  }));

  const shipmentLocations = [];
  if (requestPayload.pol) shipmentLocations.push({ locationTypeCode: "POL", location: { UNLocationCode: requestPayload.pol } });
  if (requestPayload.pod) shipmentLocations.push({ locationTypeCode: "POD", location: { UNLocationCode: requestPayload.pod } });

  return {
    carrierServiceCode: requestPayload.service || "",
    carrierExportVoyageNumber: requestPayload.voyage || "",
    ...(requestPayload.vesselImo ? { vessel: { vesselIMONumber: requestPayload.vesselImo } } : {}),
    ...(requestPayload.etd ? { expectedDepartureDate: requestPayload.etd } : {}),
    shipmentLocations,
    requestedEquipments,
    ...(requestPayload.incoTerms ? { incoTerms: requestPayload.incoTerms } : {}),
  };
}

async function createBooking(config, dcsaPayload) {
  try {
    const headerName = config.authHeaderName || "Authorization";
    const res = await fetch(`${(config.baseUrl || "").replace(/\/$/, "")}/v2/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [headerName]: config.credential || "" },
      body: JSON.stringify(dcsaPayload),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await res.json().catch(() => ({}));
    if (res.status !== 202) return { ok: false, error: `Unexpected status ${res.status} from carrier`, raw };
    if (!raw.carrierBookingRequestReference) return { ok: false, error: "Carrier accepted but returned no carrierBookingRequestReference", raw };
    return { ok: true, carrierBookingRequestReference: raw.carrierBookingRequestReference, raw };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Polling fallback alongside the webhook callback (DCSA's own spec allows either) — not wired to
// a route in this pass; exists so Story 6 can validate a "no webhook ever arrived" recovery path
// against a real sandbox with no code change.
async function getBookingStatus(config, ref) {
  try {
    const headerName = config.authHeaderName || "Authorization";
    const res = await fetch(`${(config.baseUrl || "").replace(/\/$/, "")}/v2/bookings/${encodeURIComponent(ref)}`, {
      headers: { [headerName]: config.credential || "" },
      signal: AbortSignal.timeout(15000),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `Unexpected status ${res.status} from carrier`, raw };
    return { ok: true, raw };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// DCSA's Operational Vessel Schedules (OVS) API is a separate spec from Booking/Track & Trace.
// This maps onto its commonly-published request/response shape (UNLocationCode origin/
// destination, vessel/voyage/departure/arrival) but — unlike buildBookingRequest's Booking
// v2.0.5 fields, confirmed against the published spec — this is a disclosed best-effort pending
// confirmation against a real sandbox (Story 6), not a verified contract. Normalized into the
// same shape routes/system.js's existing catalogSailings/mockSailings already produce, so the
// frontend picker needs zero changes regardless of which source filled it.
async function searchSchedules(config, params) {
  try {
    const headerName = config.authHeaderName || "Authorization";
    const qs = new URLSearchParams({
      UNLocationCodeOrigin: params.pol || "",
      UNLocationCodeDestination: params.pod || "",
    }).toString();
    const res = await fetch(`${(config.baseUrl || "").replace(/\/$/, "")}/v1/vessel-schedules?${qs}`, {
      headers: { [headerName]: config.credential || "" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: `Unexpected status ${res.status} from carrier` };
    const raw = await res.json().catch(() => []);
    const sailings = (Array.isArray(raw) ? raw : []).map(s => ({
      carrier: params.carrierCode || "", vesselName: s.vesselName || s.vessel?.name || "—",
      vesselImo: s.vesselIMONumber || "", voyageNumber: s.carrierVoyageNumber || "",
      service: s.carrierServiceCode || "—", pol: params.pol, pod: params.pod,
      etd: (s.departureDateTime || "").slice(0, 10), eta: (s.arrivalDateTime || "").slice(0, 10),
      transitDays: 0, legs: null, isMock: false, source: "live",
    }));
    return { ok: true, sailings };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Generic default pending confirmation against Hapag-Lloyd's actual callback signing scheme
// (Story 6 — their API is BETA-labeled per their own docs). A disclosed placeholder, not an
// assumed-correct contract — same HMAC-SHA256 + timingSafeEqual technique lib/shareToken.js
// already uses to verify its own tokens.
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

const REJECTED_STATES = new Set(["REJECTED", "CANCELLED"]);
const CONFIRMED_STATES = new Set(["CONFIRMED"]);

// Maps DCSA's real booking-status enum onto the three outcomes applyBookingResponse (routes/
// edi.js) already understands. Anything neither confirmed nor rejected (PENDING_UPDATE/
// UPDATE_RECEIVED/PENDING_AMENDMENT/AMENDMENT_RECEIVED, or a status this adapter doesn't
// recognize yet) surfaces as confirmed_with_changes so a human reviews it on the Review tab,
// rather than either silently treating an unrecognized state as a plain confirmation or
// dropping the callback.
function parseCallback(body) {
  const bookingStatus = body.bookingStatus || "";
  const status = REJECTED_STATES.has(bookingStatus) ? "rejected"
    : CONFIRMED_STATES.has(bookingStatus) ? "confirmed"
    : "confirmed_with_changes";
  return {
    status,
    bookingRef: body.carrierBookingReference || body.carrierBookingRequestReference || null,
    carrierBookingRequestReference: body.carrierBookingRequestReference || null,
    raw: body,
  };
}

module.exports = {
  adapterKey: ADAPTER_KEY,
  buildBookingRequest, createBooking, getBookingStatus, searchSchedules, verifyCallback, parseCallback,
};
