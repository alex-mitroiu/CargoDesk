"use strict";

// What a carrier confirmed, beside what we asked for (agreed with the user 2026-10-21, mockup
// https://claude.ai/artifact/P3xrSaDFwDHWeWiSEWVccv): column A is our booking request, column B the
// carrier's DCSA confirmation (a Booking 2.0 GET, kept in carrier_bookings.carrier_confirmation), every
// detail, so users compare and decide. Pure functions; routes/edi.js serves them.

const { mainLegIndex, legDays } = require("./mainLeg");
const { ISO_EQUIPMENT, CUT_OFF_TIME, isoEquipmentCode, labelOf } = require("./dcsa/codes");

const day = v => String(v || "").slice(0, 10);
const fmtDay = v => (day(v) ? new Date(`${day(v)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const fmtTime = v => {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v)
    : `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })}, ${d.toISOString().slice(11, 16)}`;
};
const locCode = l => String(l?.UNLocationCode || l?.locationName || "").trim().toUpperCase();

// The carrier's transport plan as sea legs in order, each with its role (MAIN = the longest transit,
// lib/mainLeg.js): [{ pol, pod, vesselName, voyageNumber, vesselImo, etd, eta, days, role }].
function planLegs(dcsa) {
  const plan = (Array.isArray(dcsa?.transportPlan) ? [...dcsa.transportPlan] : [])
    .sort((a, b) => (a.transportPlanStageSequenceNumber || 0) - (b.transportPlanStageSequenceNumber || 0))
    .filter(l => !l.modeOfTransport || l.modeOfTransport === "VESSEL");
  const legs = plan.map(l => ({
    pol: locCode(l.loadLocation), pod: locCode(l.dischargeLocation), vesselName: l.vesselName || "", voyageNumber: l.carrierExportVoyageNumber || "",
    vesselImo: l.vesselIMONumber || "", etd: day(l.plannedDepartureDate), eta: day(l.plannedArrivalDate),
  }));
  const main = mainLegIndex(legs);
  return legs.map((l, i) => ({ ...l, days: legDays(l), role: legs.length > 1 ? (i === main ? "MAIN" : "FEEDER") : "MAIN" }));
}

const equipmentText = list => {
  const n = {};
  for (const e of list || []) n[e.code] = (n[e.code] || 0) + (Number(e.units) || 0);
  return Object.entries(n).sort(([a], [b]) => a.localeCompare(b))
    .map(([code, units]) => `${units} × ${code}${labelOf(ISO_EQUIPMENT, code) !== code ? ` (${labelOf(ISO_EQUIPMENT, code)})` : ""}`).join(", ");
};

// → rows [{ group } | { label, a, b, kind, delta? }], kind: "same" | "changed" | "new" (only the
// carrier says it) | "missing" (the carrier's confirmation doesn't carry it — DCSA has no field).
// request: the outbound booking-request payload (routes/edi.js bookingRequestPayload); dcsa: the
// carrier's confirmed booking; requestedEta: the shipment's ETA when the request was sent.
function comparisonRows(request = {}, dcsa = {}, { requestedEta = "", carrierCode = "", bookingRef = "", offerLines = null } = {}) {
  const rows = [];
  const group = name => rows.push({ group: name });
  const norm = v => String(v ?? "").trim().toUpperCase();
  const row = (label, a, b, { kind = null, delta = "" } = {}) => {
    const A = a == null || a === "" ? "—" : String(a), B = b == null || b === "" ? null : String(b);
    const k = kind || (B === null ? "missing" : A === "—" ? "new" : norm(A) === norm(B) ? "same" : "changed");
    rows.push({ label, a: A, b: B === null ? "Not stated" : B, kind: k, ...(delta ? { delta } : {}) });
  };
  const dayDelta = (a, b) => {
    if (!day(a) || !day(b) || day(a) === day(b)) return "";
    const d = Math.round((Date.parse(`${day(b)}T00:00:00Z`) - Date.parse(`${day(a)}T00:00:00Z`)) / 864e5);
    return `${d > 0 ? "+" : ""}${d} day${Math.abs(d) === 1 ? "" : "s"}`;
  };
  const legs = planLegs(dcsa);
  const mainLeg = legs.find(l => l.role === "MAIN") || legs[0] || {};
  const first = legs[0] || {}, last = legs[legs.length - 1] || {};

  group("BOOKING");
  row("Carrier", request.carrierCode || carrierCode, dcsa.carrierCode || carrierCode);
  row("Booking number", "", dcsa.carrierBookingReference || bookingRef, { kind: "new" });
  // A SPOT booking priced on a spot offer carries its quotation reference instead of a contract number.
  if (request.quotationReference || dcsa.contractQuotationReference) row("Quotation", request.quotationReference, dcsa.contractQuotationReference);
  else row("Contract", request.contractNumber || request.contractRef, dcsa.serviceContractReference);

  group("ROUTE");
  row("Port of loading", request.pol, first.pol);
  row("Port of discharge", request.pod, last.pod);
  // Receipt and delivery types are derived from the shipment's service type when the request is built
  // (dcsa-bkg-v2 buildBookingRequest), so the carrier's booking holds what we sent.
  const rd = [dcsa.receiptTypeAtOrigin, dcsa.deliveryTypeAtDestination].filter(Boolean).join(" / ");
  row("Receipt / delivery", rd, rd || null);

  group("SAILING");
  row("Vessel", request.vessel, mainLeg.vesselName);
  row("Voyage", request.voyage, mainLeg.voyageNumber);
  row("Vessel IMO", request.vesselImo, mainLeg.vesselImo);
  row("ETD", fmtDay(request.etd), fmtDay(first.etd), { delta: dayDelta(request.etd, first.etd) });
  row("ETA", fmtDay(requestedEta), fmtDay(last.eta), { delta: dayDelta(requestedEta, last.eta) });
  const reqTransit = day(request.etd) && day(requestedEta) ? legDays({ etd: request.etd, eta: requestedEta }) : null;
  const confTransit = day(first.etd) && day(last.eta) ? legDays({ etd: first.etd, eta: last.eta }) : null;
  row("Transit", reqTransit != null ? `${reqTransit} days` : "", confTransit != null ? `${confTransit} days` : null);
  if (legs.length > 1) legs.forEach((l, i) => row(`Leg ${i + 1} · ${l.role}`, "",
    `${l.pol} → ${l.pod} · ${[l.vesselName, l.voyageNumber].filter(Boolean).join(" ")} · ${fmtDay(l.etd)} → ${fmtDay(l.eta)}`, { kind: "new" }));

  group("EQUIPMENT & CARGO");
  const asked = (request.equipment || []).map(e => ({ code: isoEquipmentCode(e.type) || e.type, units: e.count }));
  const got = (dcsa.confirmedEquipments || []).map(e => ({ code: e.ISOEquipmentCode, units: e.units }));
  row("Equipment", equipmentText(asked), got.length ? equipmentText(got) : null);
  const weight = (request.equipment || []).reduce((t, e) => t + (Number(e.totalWeightKg) || 0), 0);
  row("Gross weight", weight ? `${Math.round(weight).toLocaleString("en-US")} kg` : "", null);
  row("Commodity", request.commodityCode, null);

  const cutOffs = Array.isArray(dcsa.shipmentCutOffTimes) ? dcsa.shipmentCutOffTimes : [];
  if (cutOffs.length) {
    group("CUT-OFFS (UTC)");
    for (const c of cutOffs) row(labelOf(CUT_OFF_TIME, c.cutOffDateTimeCode), "", fmtTime(c.cutOffDateTime), { kind: "new" });
  }

  // What the carrier charges (DCSA Charge) against the spot offer the shipment was bought on (SPOT
  // rates, 2026-10-21) — only when the carrier stated its charges: a confirmation without them claims
  // nothing about the price. Matched by charge code or name, the carrier's free text.
  const charges = Array.isArray(dcsa.charges) ? dcsa.charges : [];
  if (charges.length && Array.isArray(offerLines) && offerLines.length) {
    group("CHARGES");
    const key = v => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
    const nameOf = c => String(c.extendedChargeName || c.chargeName || "").trim();
    const money = (cur, n) => `${cur || "USD"} ${Number(n || 0).toFixed(2)}`;
    const used = new Set();
    for (const l of offerLines) {
      const code = key(l.serviceCode), desc = key(l.description);
      const i = charges.findIndex((c, j) => {
        if (used.has(j)) return false;
        const n = key(nameOf(c));
        return (desc && n === desc) || n === code || n.startsWith(`${code} `);
      });
      if (i >= 0) used.add(i);
      const c = i >= 0 ? charges[i] : null;
      row([l.serviceCode, l.description].filter(Boolean).join(" · "), money(l.currency, l.amount), c ? money(c.currencyCode, c.currencyAmount) : null);
    }
    charges.forEach((c, j) => { if (!used.has(j)) row(nameOf(c) || "Charge", null, money(c.currencyCode, c.currencyAmount)); });
  }

  group("PARTIES");
  const party = k => dcsa.documentParties?.[k]?.partyName;
  row("Shipper", request.shipperName, party("shipper"));
  row("Consignee", request.consigneeName, party("consignee"));
  if (request.notifyName) row("Notify party", request.notifyName, null);
  return rows;
}

// The confirmed sailing as an instruction-shaped sailing for replacing the shipment's sea legs.
function confirmedSailing(dcsa) {
  const legs = planLegs(dcsa);
  if (!legs.length) return null;
  const main = legs.find(l => l.role === "MAIN") || legs[0];
  return { vesselName: main.vesselName, voyageNumber: main.voyageNumber, vesselImo: main.vesselImo, etd: legs[0].etd, eta: legs[legs.length - 1].eta,
    pol: legs[0].pol, pod: legs[legs.length - 1].pod, ...(legs.length > 1 ? { legs } : {}) };
}

module.exports = { planLegs, comparisonRows, confirmedSailing };
