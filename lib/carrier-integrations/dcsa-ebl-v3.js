"use strict";
// DCSA Shipping Instructions and Transport Document 3.0 (the eBL 3.0 standard; vendored EBL_v3.0.0.yaml,
// API 3.0.3), part of the generic DCSA adapter (registered with dcsa-bkg-v2 in server.js). Added
// 2026-10-27: until then CargoDesk "submitted" Shipping Instructions as a home-made summary that went
// nowhere. The carrier's Master transport document (draft, approve, issue) since 2026-10-28.
//
//   POST  /v3/shipping-instructions            CreateShippingInstructions → 202 { shippingInstructionsReference }
//   PUT   /v3/shipping-instructions/{ref}      UpdateShippingInstructions → 202
//   PATCH /v3/shipping-instructions/{ref}      cancel the instructions, or a pending update → 202
//   GET   /v3/shipping-instructions/{ref}      ShippingInstructions (the polling path)
//   GET   /v3/transport-documents/{ref}        the carrier's TransportDocument (draft, approved, issued…)
//   PATCH /v3/transport-documents/{ref}        approve the draft { transportDocumentStatus: APPROVED } → 202
//   notifications (CloudEvents, types org.dcsa.shipping-instructions.v3 and org.dcsa.transport-document.v3)
//   arrive at the carrier webhook
//
// SI states (the spec's own words): RECEIVED, then the carrier drafts the transport document from them;
// PENDING_UPDATE when it needs changes; COMPLETED only once the transport document has been surrendered
// for delivery; DECLINED / CANCELLED. A carrier accepting the instructions shows as its draft TD.
//
// These Shipping Instructions are for the carrier's Master B/L. buildShippingInstructions is pure: its
// caller (routes/shipping-instructions.js) gathers the parties as DCSA parties and the containers.

const { dcsaCall: call } = require("./dcsa-http");
const { isoEquipmentCode } = require("../dcsa/codes");

// The countries of ICS2, the EU's advance cargo information system (the 27 EU member states, Norway
// and Switzerland): DCSA asks whether the cargo is delivered in that zone.
const ICS2_COUNTRIES = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "NO", "CH"]);
// Northern Ireland is in the zone too (the spec: "EU, Norway, Switzerland or Northern Ireland"): its ports.
const NORTHERN_IRELAND = new Set(["GBBEL", "GBLAR", "GBWPT", "GBLDY", "GBKLR", "GBNRY"]);
const inIcs2Zone = loc => { const l = String(loc || "").toUpperCase(); return NORTHERN_IRELAND.has(l) || ICS2_COUNTRIES.has(l.slice(0, 2)); };
const isCargoDeliveredInICS2Zone = (pod, placeOfDeliveryCountry = "") => inIcs2Zone(placeOfDeliveryCountry || pod);

const clip = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max).trim();
// DCSA's 35-character text lines (descriptionOfGoods, shippingMarks).
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
const PACKAGE_DESCRIPTION = { CT: "Carton", BX: "Box", CS: "Case", PK: "Package", PX: "Pallet", BG: "Bag", SA: "Sack", DR: "Drum",
  BL: "Bale, compressed", BE: "Bundle", CR: "Crate", RO: "Roll", CY: "Cylinder", PL: "Pail", JR: "Jar", NE: "Unpacked or unpackaged" };

/**
 * @param {object} d
 *   shipment   — the shipments row (pod, pol, freight_terms, master_bl_release_type, booking_ref, carrier_code)
 *   containers — containers rows
 *   parties    — { shipper, consignee, notify } as DCSA parties (consignee/notify may be null)
 *   contact    — { name, email, phone }: who the carrier asks about these instructions
 *   reference  — the carrier's shippingInstructionsReference, for an update
 *   houseBillsOfLading — DCSA HouseBillOfLading entries (houseBillOfLadingFrom) for the House B/Ls
 *                CargoDesk issued under this Master (gap G25); none → the field is left out
 * @returns {object} CreateShippingInstructions (UpdateShippingInstructions when `reference` is given)
 */
function buildShippingInstructions({ shipment: s, containers = [], parties = {}, contact = {}, reference = "", houseBillsOfLading = [] }) {
  const typeCode = s.master_bl_release_type === "Seaway Bill" ? "SWB" : "BOL";
  const collect = s.freight_terms === "Collect";
  const contacts = clip(contact.name, 35) && (contact.email || contact.phone)
    ? [{ name: clip(contact.name, 35), ...(contact.email ? { email: clip(contact.email, 100) } : {}), ...(contact.phone ? { phone: clip(contact.phone, 30) } : {}) }]
    : [];
  return {
    ...(reference ? { shippingInstructionsReference: reference } : {}),
    transportDocumentTypeCode: typeCode,
    isShippedOnBoardType: true,
    freightPaymentTermCode: collect ? "COL" : "PRE",
    isElectronic: false,
    isToOrder: false,
    // The Master B/L: an Original release is a set of three originals; a Sea Waybill has none.
    ...(typeCode === "BOL" && s.master_bl_release_type === "Original" ? { numberOfOriginalsWithoutCharges: 3 } : {}),
    ...(s.carrier_code ? { carrierCode: clip(s.carrier_code, 4), carrierCodeListProvider: "NMFTA" } : {}),
    invoicePayableAt: { UNLocationCode: String(collect ? s.pod : s.pol || "").toUpperCase() },
    partyContactDetails: contacts,
    documentParties: {
      shipper: parties.shipper,
      ...(parties.consignee ? { consignee: parties.consignee } : {}),
      ...(parties.notify ? { notifyParties: [parties.notify] } : {}),
    },
    isCargoDeliveredInICS2Zone: isCargoDeliveredInICS2Zone(s.pod),
    consignmentItems: containers.map(c => ({
      carrierBookingReference: clip(s.booking_ref, 35),
      descriptionOfGoods: lines35(c.cargo_description),
      HSCodes: [String(c.hs_code || "").replace(/\D/g, "")].filter(Boolean),
      ...(String(c.marks_and_numbers || "").trim() ? { shippingMarks: lines35(c.marks_and_numbers) } : {}),
      cargoItems: [{
        equipmentReference: clip(c.container_number, 11),
        cargoGrossWeight: { value: Number(c.gross_weight_kg) || 0, unit: "KGM" },
        ...(Number(c.volume_cbm) > 0 ? { cargoGrossVolume: { value: Number(c.volume_cbm), unit: "MTQ" } } : {}),
        ...(Number(c.number_of_packages) > 0 ? { outerPackaging: {
          ...(c.package_code ? { packageCode: c.package_code } : {}),
          numberOfPackages: Number(c.number_of_packages),
          description: clip(c.package_description || PACKAGE_DESCRIPTION[c.package_code] || "", 100),
          ...(c.is_dg && /^\d{4}$/.test(String(c.dg_un_number || "").trim()) && String(c.dg_proper_shipping_name || "").trim() && c.dg_class
            ? { dangerousGoods: [{ UNNumber: String(c.dg_un_number).trim(), properShippingName: clip(c.dg_proper_shipping_name, 250), imoClass: clip(c.dg_class, 4) }] } : {}),
        } } : {}),
      }],
    })),
    utilizedTransportEquipments: containers.map(c => {
      const iso = isoEquipmentCode(`${c.size}${c.type}`);
      const reefer = iso?.[2] === "R" && c.set_temperature_c !== null && c.set_temperature_c !== undefined && c.set_temperature_c !== "";
      // The carrier's own container is named by its reference; the full `equipment` object (with tare
      // weight) is for shipper-owned ones.
      return {
        equipmentReference: clip(c.container_number, 11),
        isShipperOwned: false,
        ...(reefer ? { isNonOperatingReefer: false, activeReeferSettings: { temperatureSetpoint: Number(c.set_temperature_c), temperatureUnit: "CEL" } } : {}),
        seals: String(c.seal_number || "").trim() ? [{ number: clip(c.seal_number, 15) }] : [],
      };
    }),
    // CargoDesk's own reference for the shipment, which the carrier quotes back.
    references: [{ type: "FF", value: clip(s.id, 100) }],
    ...(houseBillsOfLading.length ? { isHouseBillOfLadingsIssued: true, houseBillOfLadings: houseBillsOfLading } : {}),
  };
}

// ─── House B/Ls in the Master's Shipping Instructions (gap G25) ───────────────
// The House B/L as issued (its DCSA TransportDocument, kept on the record at issue) → the SI's
// HouseBillOfLading. What the House level needs that a transport document doesn't carry:
//   typeOfPerson     — every CargoDesk party is a company: LEGAL_PERSON
//   methodOfPayment  — the House freight terms: prepaid → D (other, e.g. direct debit), collect → Z (not prepaid)
//   nationalCommodityCode — the commodity under the destination's tariff (houseCommodityCode): CN (8 digits)
//                      into the EU and Northern Ireland, HTS into the US (6 digits and up, as ISF takes it),
//                      NCM (8) into Mercosur. The House level exists for those advance filings (ICS2, AMS);
//                      elsewhere the House B/L isn't sent (houseBillOfLadingFor says why not).
//   routingOfConsignmentCountries — the countries the legs pass through, place of acceptance first
const EU_COUNTRIES = new Set([...ICS2_COUNTRIES].filter(c => !["NO", "CH"].includes(c)));
const MERCOSUR = new Set(["BR", "AR", "UY", "PY"]);
// The tariff the destination's advance filing codes the commodity in, and how many digits it takes.
function houseTariff(finalDelivery) {
  const loc = String(finalDelivery || "").toUpperCase(), cc = loc.slice(0, 2);
  if (EU_COUNTRIES.has(cc) || NORTHERN_IRELAND.has(loc)) return { type: "CN", digits: 8 };
  if (cc === "US") return { type: "HTS", digits: 6 };
  if (MERCOSUR.has(cc)) return { type: "NCM", digits: 8 };
  return null;
}
const houseCommodityCode = (hs, finalDelivery) => {
  const t = houseTariff(finalDelivery), digits = String(hs || "").replace(/\D/g, "");
  if (!t || digits.length < t.digits) return null;
  return { type: t.type, values: [t.type === "HTS" ? digits : digits.slice(0, t.digits)] };
};
// Can this House B/L go in the Master's instructions? → { ok } | { ok:false, missing: [plain words] } | { ok:false, notNeeded }
function houseBillOfLadingFor(doc) {
  const t = doc.transports || {};
  const delivery = t.placeOfDelivery?.UNLocationCode || t.portOfDischarge?.UNLocationCode || "";
  if (!houseTariff(delivery)) return { ok: false, notNeeded: `no House-level advance filing into ${delivery || "the destination"}` };
  const missing = [];
  for (const ci of doc.consignmentItems || []) {
    for (const c of ci.cargoItems || []) {
      if (!c.outerPackaging?.packageCode) missing.push(`the package code (Kind) on container ${c.equipmentReference}'s packages, for House B/L ${doc.transportDocumentReference}`);
    }
    if (!houseCommodityCode((ci.HSCodes || [])[0], delivery))
      missing.push(`${houseTariff(delivery).digits === 8 ? "an" : "a"} ${houseTariff(delivery).digits}-digit ${houseTariff(delivery).type} commodity code in the HS code of House B/L ${doc.transportDocumentReference}'s cargo (${(ci.HSCodes || [])[0] || "none"})`);
  }
  return missing.length ? { ok: false, missing } : { ok: true };
}
const countryOf = loc => String(loc?.UNLocationCode || loc?.countryCode || "").slice(0, 2).toUpperCase();
const hblAddress = a => (a && a.street && a.city && a.countryCode ? {
  street: clip(a.street, 70), ...(a.postCode ? { postCode: clip(a.postCode, 10) } : {}), city: clip(a.city, 35),
  ...(a.stateRegion ? { stateRegion: clip(a.stateRegion, 65) } : {}), countryCode: a.countryCode,
} : null);
const hblParty = (p, contact = null) => (p ? {
  partyName: clip(p.partyName, 70), typeOfPerson: "LEGAL_PERSON",
  ...(hblAddress(p.address) ? { address: hblAddress(p.address) } : {}),
  ...(p.identifyingCodes?.length ? { identifyingCodes: p.identifyingCodes } : {}),
  ...(p.taxLegalReferences?.length ? { taxLegalReferences: p.taxLegalReferences } : {}),
  ...(contact && clip(contact.name, 35) && (contact.email || contact.phone) ? { partyContactDetails: [{ name: clip(contact.name, 35),
    ...(contact.email ? { email: clip(contact.email, 100) } : {}), ...(contact.phone ? { phone: clip(contact.phone, 30) } : {}) }] } : {}),
} : null);

/**
 * @param {object} doc  the House B/L's DCSA TransportDocument
 * @param {object} o    { routingCountries: ["NL", …, "US"], notifyContact: { name, email, phone } | null }
 */
function houseBillOfLadingFrom(doc, { routingCountries = [], notifyContact = null } = {}) {
  const t = doc.transports || {};
  const acceptance = t.placeOfReceipt?.UNLocationCode ? { UNLocationCode: t.placeOfReceipt.UNLocationCode } : { UNLocationCode: t.portOfLoading?.UNLocationCode };
  const delivery = t.placeOfDelivery?.UNLocationCode ? { UNLocationCode: t.placeOfDelivery.UNLocationCode } : { UNLocationCode: t.portOfDischarge?.UNLocationCode };
  const finalCountry = countryOf(delivery);
  const route = [countryOf(acceptance), ...routingCountries, finalCountry].filter(c => /^[A-Z]{2}$/.test(c))
    .filter((c, i, a) => i === 0 || a[i - 1] !== c);
  const parties = doc.documentParties || {};
  const equipment = new Map((doc.utilizedTransportEquipments || []).map(u => [u.equipment?.equipmentReference, u]));
  return {
    houseBillOfLadingReference: clip(doc.transportDocumentReference, 20),
    isToOrder: !!doc.isToOrder,
    placeOfAcceptance: acceptance,
    placeOfFinalDelivery: delivery,
    methodOfPayment: doc.freightPaymentTermCode === "COL" ? "Z" : "D",
    documentParties: {
      shipper: hblParty(parties.shipper),
      ...(parties.consignee ? { consignee: hblParty(parties.consignee) } : {}),
      // A House-level notify party is named with a contact (DCSA requires partyContactDetails there); it is
      // only mandatory on a House B/L to order, which the caller checks.
      ...(parties.notifyParties?.[0] && notifyContact ? { notifyParty: hblParty(parties.notifyParties[0], notifyContact) } : {}),
    },
    isCargoDeliveredInICS2Zone: inIcs2Zone(delivery.UNLocationCode || finalCountry),
    routingOfConsignmentCountries: route.length ? route : [finalCountry],
    consignmentItems: (doc.consignmentItems || []).map(ci => ({
      descriptionOfGoods: clip((ci.descriptionOfGoods || []).join(" "), 512),
      nationalCommodityCode: { ...houseCommodityCode((ci.HSCodes || [])[0], delivery.UNLocationCode), ...(finalCountry ? { countryCode: finalCountry } : {}) },
      cargoItems: (ci.cargoItems || []).map(c => ({
        equipmentReference: c.equipmentReference,
        cargoGrossWeight: c.cargoGrossWeight,
        outerPackaging: {
          packageCode: c.outerPackaging?.packageCode,
          ...(Number(c.outerPackaging?.numberOfPackages) > 0 ? { numberOfPackages: Number(c.outerPackaging.numberOfPackages) } : {}),
          ...(ci.shippingMarks?.length ? { shippingMarks: clip(ci.shippingMarks.join(" "), 512) } : {}),
          ...(c.outerPackaging?.dangerousGoods?.[0]?.UNNumber ? { UNNumber: c.outerPackaging.dangerousGoods[0].UNNumber } : {}),
        },
      })),
    })),
    utilizedTransportEquipments: [...equipment.values()].map(u => ({
      equipmentReference: u.equipment.equipmentReference,
      ISOEquipmentCode: u.equipment.ISOEquipmentCode || "",
      isShipperOwned: !!u.isShipperOwned,
      emptyIndicatorCode: "LADEN",
      ...(u.seals?.length ? { seals: u.seals.map(x => ({ number: x.number })) } : {}),
    })),
  };
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
const siPath = ref => `/v3/shipping-instructions/${encodeURIComponent(ref)}`;

async function submitShippingInstructions(config, body) {
  const r = await call(config, "POST", "/v3/shipping-instructions", { body, expect: [202], spec: ["ebl", "/v3/shipping-instructions"] });
  if (!r.ok) return r;
  if (!r.raw?.shippingInstructionsReference) return { ok: false, error: "Carrier accepted but returned no shippingInstructionsReference", raw: r.raw };
  return { ok: true, shippingInstructionsReference: r.raw.shippingInstructionsReference, raw: r.raw };
}

async function updateShippingInstructions(config, ref, body) {
  return call(config, "PUT", siPath(ref), { body, expect: [202], spec: ["ebl", "/v3/shipping-instructions/{documentReference}"] });
}

async function getShippingInstructions(config, ref) {
  const r = await call(config, "GET", siPath(ref), { expect: [200], spec: ["ebl", "/v3/shipping-instructions/{documentReference}"] });
  if (!r.ok) return r;
  return { ok: true, state: normalizeShippingInstructionsState(r.raw || {}), raw: r.raw };
}

// Cancels the Shipping Instructions, or only the update still waiting for the carrier (`update`).
// The carrier answers 202 and then notifies CANCELLED / UPDATE_CANCELLED.
async function cancelShippingInstructions(config, ref, { update = false } = {}) {
  const body = update ? { updatedShippingInstructionsStatus: "UPDATE_CANCELLED" } : { shippingInstructionsStatus: "CANCELLED" };
  return call(config, "PATCH", siPath(ref), { body, expect: [202], spec: ["ebl", "/v3/shipping-instructions/{documentReference}"] });
}

// The SI state DCSA tracks, from a notification's `data` or a GET alike.
function normalizeShippingInstructionsState(obj = {}) {
  return {
    shippingInstructionsStatus: obj.shippingInstructionsStatus || "",
    updatedShippingInstructionsStatus: obj.updatedShippingInstructionsStatus || "",
    shippingInstructionsReference: obj.shippingInstructionsReference || null,
    transportDocumentReference: obj.transportDocumentReference || null,
    feedbacks: Array.isArray(obj.feedbacks) ? obj.feedbacks : [],
  };
}
const SI_NOTIFICATION_TYPE = "org.dcsa.shipping-instructions.v3";
const parseShippingInstructionsNotification = (body = {}) => normalizeShippingInstructionsState(body?.data || {});

// ─── The carrier's transport document (the Master B/L) ───────────────────────
const tdPath = ref => `/v3/transport-documents/${encodeURIComponent(ref)}`;

async function getTransportDocument(config, ref) {
  const r = await call(config, "GET", tdPath(ref), { expect: [200], spec: ["ebl", "/v3/transport-documents/{transportDocumentReference}"] });
  if (!r.ok) return r;
  return { ok: true, document: r.raw, state: normalizeTransportDocumentState(r.raw || {}), raw: r.raw };
}

// The shipper approves the carrier's draft; the carrier then notifies APPROVED (and later ISSUED).
async function approveTransportDocument(config, ref) {
  return call(config, "PATCH", tdPath(ref), { body: { transportDocumentStatus: "APPROVED" }, expect: [202],
    spec: ["ebl", "/v3/transport-documents/{transportDocumentReference}"] });
}

// The notification payload (TransportDocumentData) documents the older spellings VOID and SURRENDER_FOR_*;
// the TransportDocument itself VOIDED and SURRENDERED_FOR_*. CargoDesk keeps the latter (lib/dcsa/codes.js).
const TD_STATUS_SPELLING = { VOID: "VOIDED", SURRENDER_FOR_DELIVERY: "SURRENDERED_FOR_DELIVERY", SURRENDER_FOR_AMENDMENT: "SURRENDERED_FOR_AMENDMENT" };
const tdStatus = s => TD_STATUS_SPELLING[s] || s || "";

// From a notification's `data` (which may carry the whole document) or a GET.
function normalizeTransportDocumentState(obj = {}) {
  return {
    transportDocumentStatus: tdStatus(obj.transportDocumentStatus),
    amendedTransportDocumentStatus: obj.amendedTransportDocumentStatus || "",
    transportDocumentReference: obj.transportDocumentReference || null,
    shippingInstructionsReference: obj.shippingInstructionsReference || obj.transportDocument?.shippingInstructionsReference || null,
    feedbacks: Array.isArray(obj.feedbacks) ? obj.feedbacks : [],
  };
}
const TD_NOTIFICATION_TYPE = "org.dcsa.transport-document.v3";
// A notification may carry only the status and the document's reference (the spec's own examples do):
// the instructions it was drafted from are then found by that reference, or read from the document.
function parseTransportDocumentNotification(body = {}) {
  const data = body?.data || {};
  return { ...normalizeTransportDocumentState(data), document: data.transportDocument || null };
}

module.exports = {
  buildShippingInstructions, submitShippingInstructions, updateShippingInstructions, getShippingInstructions,
  cancelShippingInstructions, normalizeShippingInstructionsState, parseShippingInstructionsNotification, SI_NOTIFICATION_TYPE,
  getTransportDocument, approveTransportDocument, normalizeTransportDocumentState, parseTransportDocumentNotification,
  TD_NOTIFICATION_TYPE, TD_STATUS_SPELLING, houseBillOfLadingFrom, houseBillOfLadingFor, isCargoDeliveredInICS2Zone, ICS2_COUNTRIES,
};
