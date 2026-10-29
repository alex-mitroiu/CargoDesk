"use strict";
// DCSA Verified Gross Mass 1.0 (vendored VGM_v1.0.0.yaml, API 1.0.1), part of the generic DCSA adapter
// (registered with dcsa-bkg-v2 in server.js). Added 2026-10-27: until then a container's VGM was only
// marked Submitted, with a home-made note in the message log and nothing sent.
//
// CargoDesk is the VGM Producer (it declares for the shipper); the carrier is the VGM Consumer and
// implements POST /vgm-declarations { VGMDeclarations: [...] } → 200 { feedbackElements? }. One
// declaration per container, its declarationReference stable per container, so a correction replaces
// the earlier one and taking VGM back retracts it (isRetracted).

const { dcsaCall: call } = require("./dcsa-http");
const { containerIso, dcsaSeals } = require("../dcsa/codes");

const clip = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max).trim();
// CargoDesk's container form says "Method 1" / "Method 2"; SOLAS / DCSA say SM1 / SM2.
const VGM_METHOD = { "Method 1": "SM1", "Method 2": "SM2", SM1: "SM1", SM2: "SM2" };

// DCSA PartyDetails from { name, address: { street, postCode, city, countryCode }, contact: { name, email, phone } }.
const partyDetails = p => (p && clip(p.name, 70) ? {
  partyName: clip(p.name, 70),
  ...(p.address && clip(p.address.street, 70) && clip(p.address.city, 35) ? { address: {
    street: clip(p.address.street, 70), ...(clip(p.address.postCode, 10) ? { postCode: clip(p.address.postCode, 10) } : {}),
    city: clip(p.address.city, 35), ...(/^[A-Z]{2}$/.test(p.address.countryCode || "") ? { countryCode: p.address.countryCode } : {}),
  } } : {}),
  ...(p.contact && (p.contact.email || p.contact.phone) ? { contactDetails: {
    name: clip(p.contact.name || p.name, 35), ...(p.contact.email ? { email: clip(p.contact.email, 100) } : {}), ...(p.contact.phone ? { phone: clip(p.contact.phone, 30) } : {}),
  } } : {}),
} : null);

const declarationReferenceOf = container => `CD-VGM-${container.id}`;

/**
 * One container's VGM declaration.
 *   shipment  — the shipments row; container — the containers row (vgm_weight_kg, vgm_method)
 *   responsible — the shipper (PartyDetails source), submitting — CargoDesk's legal entity
 *   signatory — the person authorised to sign (SOLAS: the name in capitals)
 */
function buildVgmDeclaration({ shipment: s, container: c, responsible = null, submitting = null, signatory = "", at = new Date().toISOString() }) {
  const iso = containerIso(c);
  const seals = dcsaSeals(c);
  const responsibleParty = partyDetails(responsible), submittingParty = partyDetails(submitting);
  return {
    declarationReference: declarationReferenceOf(c),
    declarationDateTime: at,
    equipmentDetails: {
      equipmentReference: clip(c.container_number, 11), ...(iso ? { ISOEquipmentCode: iso } : {}), isShipperOwned: false,
      ...(seals.length ? { seals } : {}),
    },
    ...(s.booking_ref ? { shipmentDetails: { carrierBookingReference: clip(s.booking_ref, 35) } } : {}),
    vesselVoyageDetails: {
      ...(s.carrier_code ? { carrierCode: clip(s.carrier_code, 4), carrierCodeListProvider: "NMFTA" } : {}),
      ...(s.vessel ? { vesselName: clip(s.vessel, 50) } : {}),
      ...(s.voyage ? { exportVoyageNumberOrReference: { carrierVoyageNumber: clip(s.voyage, 50) } } : {}),
      ...(s.pol ? { portOfLoading: { UNLocationCode: String(s.pol).toUpperCase() } } : {}),
      ...(s.pod ? { portOfDischarge: { UNLocationCode: String(s.pod).toUpperCase() } } : {}),
    },
    VGM: { weight: { value: Number(c.vgm_weight_kg), unit: "KGM" }, method: VGM_METHOD[c.vgm_method] || c.vgm_method, dateTime: at },
    ...(responsibleParty ? { responsibleParty } : {}),
    ...(clip(signatory, 255) ? { authorizedPersonSignatory: clip(signatory, 255).toUpperCase() } : {}),
    ...(submittingParty ? { submittingParty } : {}),
  };
}
const retraction = container => ({ declarationReference: declarationReferenceOf(container), isRetracted: true });

// What a declaration still needs before it can go (the schema itself requires almost nothing).
function vgmProblems(c) {
  return [
    !(Number(c.vgm_weight_kg) > 0) && "the verified gross mass (kg)",
    !VGM_METHOD[c.vgm_method] && "the VGM method (Method 1 or Method 2)",
    !(c.container_number && !/^TBC$/i.test(c.container_number)) && "the container number",
  ].filter(Boolean);
}

// POST /vgm-declarations. A 200 may still carry ERROR feedback on a declaration: that is a refusal.
async function sendVgmDeclarations(config, declarations) {
  const r = await call(config, "POST", "/vgm-declarations", { body: { VGMDeclarations: declarations }, expect: [200, 204], spec: ["vgm", "/vgm-declarations"], checkResponse: true });
  if (!r.ok) return r;
  const feedback = Array.isArray(r.raw?.feedbackElements) ? r.raw.feedbackElements : [];
  const errors = feedback.filter(f => f.severity === "ERROR");
  if (errors.length) return { ok: false, refused: true, error: `The carrier refused the VGM declaration: ${errors.map(f => f.message).join("; ")}`, raw: r.raw };
  return { ok: true, feedback, raw: r.raw };
}

module.exports = { buildVgmDeclaration, retraction, vgmProblems, sendVgmDeclarations, declarationReferenceOf, VGM_METHOD };
