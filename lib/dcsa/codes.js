"use strict";

// DCSA code lists: the one place CargoDesk's internal model takes its states and codes from
// (DCSA-everywhere program, ~/.claude/plans/wiggly-kindling-castle.md). Copied from the vendored
// specs in ./specs, where most lists are written in property descriptions rather than as `enum`s,
// so ./validate.js can't check them: when a spec is upgraded, re-extract and compare.
// Labels are for screens; the code is what gets stored and sent.
//
// Where the standards disagree on spelling, the internal model uses the newest one and the adapter
// translates at the boundary: Track & Trace 3.0 writes ACTUAL/ESTIMATED/PLANNED and ARRIVED/DEPARTED,
// Commercial Schedules 1.0 and OVS 3.0 still write ACT/EST/PLN and ARRI/DEPA (CLASSIFIER_FROM_SHORT,
// TRANSPORT_EVENT_FROM_SHORT below).

const list = pairs => Object.freeze(pairs.map(([code, label]) => Object.freeze({ code, label })));

// ─── Booking 2.0.4 ───────────────────────────────────────────────────────────
const BOOKING_STATUS = list([
  ["RECEIVED", "Received"], ["PENDING_UPDATE", "Update required"], ["UPDATE_RECEIVED", "Update received"],
  ["CONFIRMED", "Confirmed"], ["PENDING_AMENDMENT", "Amendment required"], ["REJECTED", "Rejected"],
  ["DECLINED", "Declined"], ["CANCELLED", "Cancelled"], ["COMPLETED", "Completed"],
]);
const AMENDED_BOOKING_STATUS = list([
  ["AMENDMENT_RECEIVED", "Amendment received"], ["AMENDMENT_CONFIRMED", "Amendment confirmed"],
  ["AMENDMENT_DECLINED", "Amendment declined"], ["AMENDMENT_CANCELLED", "Amendment cancelled"],
]);
const BOOKING_CANCELLATION_STATUS = list([
  ["CANCELLATION_RECEIVED", "Cancellation requested"], ["CANCELLATION_DECLINED", "Cancellation declined"],
  ["CANCELLATION_CONFIRMED", "Cancellation confirmed"],
]);

// ─── Shipping Instructions and Transport Document 3.0.3 ─────────────────────
const SHIPPING_INSTRUCTIONS_STATUS = list([
  ["RECEIVED", "Received"], ["PENDING_UPDATE", "Update required"], ["COMPLETED", "Completed"],
  ["CANCELLED", "Cancelled"], ["DECLINED", "Declined"],
]);
const UPDATED_SHIPPING_INSTRUCTIONS_STATUS = list([
  ["UPDATE_RECEIVED", "Update received"], ["UPDATE_CONFIRMED", "Update confirmed"],
  ["UPDATE_CANCELLED", "Update cancelled"], ["UPDATE_DECLINED", "Update declined"],
]);
// The spec's description also lists older spellings (VOID, SURRENDER_FOR_…); only these are current.
const TRANSPORT_DOCUMENT_STATUS = list([
  ["DRAFT", "Draft"], ["APPROVED", "Approved"], ["ISSUED", "Issued"],
  ["PENDING_SURRENDER_FOR_AMENDMENT", "Surrender for amendment pending"], ["SURRENDERED_FOR_AMENDMENT", "Surrendered for amendment"],
  ["PENDING_SURRENDER_FOR_DELIVERY", "Surrender for delivery pending"], ["SURRENDERED_FOR_DELIVERY", "Surrendered for delivery"],
  ["VOIDED", "Voided"],
]);
const AMENDED_TRANSPORT_DOCUMENT_STATUS = list([
  ["AMENDMENT_RECEIVED", "Amendment received"], ["AMENDMENT_CONFIRMED", "Amendment confirmed"],
  ["AMENDMENT_CANCELLED", "Amendment cancelled"], ["AMENDMENT_DECLINED", "Amendment declined"],
]);
const TRANSPORT_DOCUMENT_TYPE = list([["BOL", "Bill of Lading"], ["SWB", "Sea Waybill"]]);

// ─── eBL Issuance / Surrender 3.0.3, PINT 3.0.0-beta ────────────────────────
const ISSUANCE_RESPONSE = list([["ISSU", "Issued"], ["BREQ", "Blocked: content error"], ["REFU", "Refused"]]);
const SURRENDER_REQUEST = list([["SREQ", "Surrender for delivery"], ["AREQ", "Surrender for amendment"]]);
const SURRENDER_RESPONSE = list([["SURR", "Surrendered"], ["SREJ", "Surrender rejected"]]);
const PINT_RESPONSE = list([
  ["RECE", "Received"], ["DUPE", "Duplicate envelope"], ["BSIG", "Bad signature"], ["BENV", "Bad envelope"],
  ["INCD", "Inconclusive document"], ["MDOC", "Missing document"], ["DISE", "Disputed envelope"],
]);

// ─── Shared shipment terms (Booking, SI/TD, Arrival Notice) ─────────────────
const RECEIPT_DELIVERY_TYPE = list([["CY", "Container yard"], ["SD", "Store door"], ["CFS", "Container freight station"]]);
const CARGO_MOVEMENT_TYPE = list([["FCL", "Full container load"], ["LCL", "Less than container load"]]);
const PAYMENT_TERM = list([["PRE", "Prepaid"], ["COL", "Collect"]]);
const WEIGHT_UNIT = list([["KGM", "kg"], ["LBR", "lb"], ["GRM", "g"], ["ONZ", "oz"]]);
const VOLUME_UNIT = list([["MTQ", "m³"], ["FTQ", "ft³"], ["LTR", "l"]]);
const TEMPERATURE_UNIT = list([["CEL", "°C"], ["FAH", "°F"]]);
const VGM_METHOD = list([["SM1", "Method 1: weighed"], ["SM2", "Method 2: calculated"]]);

const PARTY_FUNCTION = list([
  ["OS", "Shipper"], ["CN", "Consignee"], ["N1", "First notify party"], ["N2", "Second notify party"],
  ["NI", "Other notify party"], ["SCO", "Service contract owner"], ["DDR", "Consignor's freight forwarder"],
  ["DDS", "Consignee's freight forwarder"], ["COW", "Invoice payer for the shipper"], ["COX", "Invoice payer for the consignee"],
  ["CS", "Consolidator"], ["MF", "Manufacturer"], ["WH", "Warehouse keeper"], ["END", "Endorsee"],
  ["RW", "Issuing party"], ["CG", "Carrier's agent at destination"], ["NAC", "Named account customer"],
  ["CSR", "Carrier customer service"],
]);

const BOOKING_LOCATION_TYPE = list([
  ["PRE", "Place of receipt"], ["POL", "Port of loading"], ["POD", "Port of discharge"], ["PDE", "Place of delivery"],
  ["PCF", "Pre-carriage from"], ["OIR", "Onward inland routing"], ["ORI", "Origin of goods"],
  ["IEL", "Intermediate export stop-off"], ["PTP", "Prohibited transshipment port"], ["RTP", "Requested transshipment port"],
  ["FCD", "Full container drop-off"], ["ROU", "Routing reference"],
]);

// ─── Track & Trace 3.0.0 ─────────────────────────────────────────────────────
const EVENT_TYPE = list([["SHIPMENT", "Shipment"], ["TRANSPORT", "Transport"], ["EQUIPMENT", "Equipment"], ["IOT", "IoT"], ["REEFER", "Reefer"]]);
const EVENT_CLASSIFIER = list([["ACTUAL", "Actual"], ["ESTIMATED", "Estimated"], ["PLANNED", "Planned"]]);
const EQUIPMENT_EVENT_TYPE = list([
  ["PICKED_UP", "Picked up"], ["GATED_IN", "Gated in"], ["STUFFED", "Stuffed"], ["LOADED", "Loaded"],
  ["DISCHARGED", "Discharged"], ["GATED_OUT", "Gated out"], ["STRIPPED", "Stripped"], ["DROPPED_OFF", "Dropped off"],
  ["AVAILABLE_FOR_PICKUP", "Available for pickup"], ["AVAILABLE_FOR_DROP_OFF", "Available for drop-off"],
  ["CUSTOMS_SELECTED_FOR_SCAN", "Selected for customs scan"], ["CUSTOMS_SELECTED_FOR_INSPECTION", "Selected for customs inspection"],
  ["CUSTOMS_RELEASED", "Released by customs"], ["INSPECTED", "Inspected"], ["RESEALED", "Resealed"],
  ["REMOVED", "Removed"], ["CROSSED", "Crossed"],
]);
const TRANSPORT_EVENT_TYPE = list([["APPROACHING", "Approaching"], ["ARRIVED", "Arrived"], ["DEPARTED", "Departed"]]);
const SHIPMENT_EVENT_TYPE = list([
  ["RECEIVED", "Received"], ["REQUESTED", "Requested"], ["SUBMITTED", "Submitted"], ["CONFIRMED", "Confirmed"],
  ["PENDING_UPDATE", "Update required"], ["UPDATE_RECEIVED", "Update received"], ["UPDATE_IN_PROGRESS", "Update in progress"],
  ["UPDATE_CONFIRMED", "Update confirmed"], ["UPDATE_DECLINED", "Update declined"], ["UPDATE_CANCELLED", "Update cancelled"],
  ["PENDING_AMENDMENT", "Amendment required"], ["AMENDMENT_RECEIVED", "Amendment received"], ["AMENDMENT_IN_PROGRESS", "Amendment in progress"],
  ["AMENDMENT_CONFIRMED", "Amendment confirmed"], ["AMENDMENT_DECLINED", "Amendment declined"], ["AMENDMENT_CANCELLED", "Amendment cancelled"],
  ["DRAFTED", "Drafted"], ["PENDING_APPROVAL", "Approval pending"], ["APPROVED", "Approved"], ["ISSUED", "Issued"],
  ["PENDING_SURRENDER_FOR_AMENDMENT", "Surrender for amendment pending"], ["SURRENDERED_FOR_AMENDMENT", "Surrendered for amendment"],
  ["PENDING_SURRENDER_FOR_DELIVERY", "Surrender for delivery pending"], ["SURRENDERED_FOR_DELIVERY", "Surrendered for delivery"],
  ["SURRENDERED", "Surrendered"], ["RELEASED", "Released"], ["ON_HOLD", "On hold"], ["COMPLETED", "Completed"],
  ["REJECTED", "Rejected"], ["DECLINED", "Declined"], ["CANCELLATION_RECEIVED", "Cancellation requested"],
  ["CANCELLATION_CONFIRMED", "Cancellation confirmed"], ["CANCELLATION_DECLINED", "Cancellation declined"],
  ["CANCELLED", "Cancelled"], ["VOIDED", "Voided"],
]);
const EMPTY_INDICATOR = list([["LADEN", "Laden"], ["EMPTY", "Empty"]]);
const TRANSPORT_PHASE = list([["EXPORT", "Export"], ["IMPORT", "Import"], ["TRANSSHIPMENT", "Transshipment"]]);
const DOCUMENT_REFERENCE_TYPE = list([
  ["CARRIER_BOOKING_REQUEST", "Booking request"], ["BOOKING", "Booking"], ["SHIPPING_INSTRUCTIONS", "Shipping instructions"],
  ["VERIFIED_GROSS_MASS", "VGM declaration"], ["TRANSPORT_DOCUMENT", "Transport document"], ["ARRIVAL_NOTICE", "Arrival notice"],
  ["CUSTOMS_CLEARANCE", "Customs clearance"], ["ADVANCE_MANIFEST_FILING", "Advance manifest filing"],
  ["DANGEROUS_GOODS_DECLARATION", "Dangerous goods declaration"], ["OUT_OF_GAUGE_DECLARATION", "Out of gauge declaration"],
  ["DELIVERY_ORDER", "Delivery order"], ["DELIVERY_INSTRUCTIONS", "Delivery instructions"], ["CONTAINER_RELEASE_ORDER", "Container release order"],
  ["TRANSPORT_ORDER", "Transport order"], ["PROOF_OF_DELIVERY", "Proof of delivery"], ["INVOICE", "Invoice"],
  ["CONTRACT_QUOTATION", "Contract quotation"], ["CARGO_SURVEY", "Cargo survey"], ["CERTIFICATE_OF_ORIGIN", "Certificate of origin"],
  ["CERTIFICATE_OF_ANALYSIS", "Certificate of analysis"], ["FUMIGATION_CERTIFICATE", "Fumigation certificate"],
  ["HEALTH_CERTIFICATE", "Health certificate"], ["INSPECTION_CERTIFICATE", "Inspection certificate"],
  ["PHYTOSANITARY_CERTIFICATE", "Phytosanitary certificate"], ["VETERINARY_CERTIFICATE", "Veterinary certificate"],
]);
const SHIPMENT_REFERENCE_TYPE = list([
  ["BOOKING_REQUEST_ID", "Booking request id"], ["CUSTOMERS_REFERENCE", "Customer's reference"], ["SHIPPERS_REFERENCE", "Shipper's reference"],
  ["CONSIGNEES_REFERENCE", "Consignee's reference"], ["FREIGHT_FORWARDERS_REFERENCE", "Freight forwarder's reference"],
  ["PURCHASE_ORDER_REFERENCE", "Purchase order"], ["CUSTOMER_SHIPMENT_ID", "Customer shipment id"],
  ["BOOKING_PARTY_REFERENCE_NUMBER", "Booking party reference"], ["EQUIPMENT_REFERENCE", "Equipment reference"],
  ["EMPTY_CONTAINER_RELEASE_REFERENCE", "Empty container release"], ["AUTOMATED_EXPORT_SYSTEM", "AES (ITN)"],
  ["CANADIAN_EXPORT_REPORTING_NUMBER", "Canadian export reporting number"], ["DECLARACAO_UNICA_DE_EXPORTACAO", "DU-E (Brazil)"],
  ["REGISTRO_UNICO_DEL_CONTRIBUYENTE", "RUC (Peru)"],
]);

// Commercial Schedules 1.0 and OVS 3.0 spellings → the Track & Trace 3.0 ones used internally.
const CLASSIFIER_FROM_SHORT = Object.freeze({ ACT: "ACTUAL", EST: "ESTIMATED", PLN: "PLANNED" });
const TRANSPORT_EVENT_FROM_SHORT = Object.freeze({ ARRI: "ARRIVED", DEPA: "DEPARTED" });

// ─── Equipment: ISO 6346 size/type codes ─────────────────────────────────────
// Not part of any DCSA spec; DCSA's ISOEquipmentCode fields require ISO 6346 codes. The set CargoDesk
// offers; `legacy` lists the codes CargoDesk stored before the switch (container_type_definitions.code
// and the old size+type pair), kept for the startup migration.
const ISO_EQUIPMENT = list([
  ["22G1", "20' Dry"], ["42G1", "40' Dry"], ["45G1", "40' High Cube"], ["L5G1", "45' High Cube"],
  ["22R1", "20' Reefer"], ["42R1", "40' Reefer"], ["45R1", "40' High Cube Reefer"],
  ["22U1", "20' Open Top"], ["42U1", "40' Open Top"], ["22P1", "20' Flat Rack"], ["42P1", "40' Flat Rack"],
  ["22T1", "20' Tank"],
]);
const ISO_EQUIPMENT_FROM_LEGACY = Object.freeze({
  "20GP": "22G1", "20DC": "22G1", "20DV": "22G1", "40GP": "42G1", "40DC": "42G1", "40DV": "42G1",
  "40HC": "45G1", "40HQ": "45G1", "45HC": "L5G1", "45HQ": "L5G1",
  "20RF": "22R1", "40RF": "42R1", "40RH": "45R1", "40HR": "45R1",
  "20OT": "22U1", "40OT": "42U1", "20FR": "22P1", "40FR": "42P1", "20TK": "22T1",
});
const ISO_CODE_PATTERN = /^[0-9L][0-9A-Z][A-Z][0-9A-Z]$/;
// Length in feet from the first character (ISO 6346: 2 = 20', 4 = 40', L = 45').
const isoLengthFt = code => ({ 2: 20, 4: 40, L: 45 })[String(code || "")[0]] || null;
const isoEquipmentCode = value => {
  const v = String(value || "").toUpperCase().replace(/\s+/g, "");
  return ISO_EQUIPMENT_FROM_LEGACY[v] || (ISO_CODE_PATTERN.test(v) ? v : null);
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const codesOf = l => l.map(x => x.code);
const has = (l, code) => l.some(x => x.code === code);
const labelOf = (l, code) => l.find(x => x.code === code)?.label || code || "";

module.exports = {
  BOOKING_STATUS, AMENDED_BOOKING_STATUS, BOOKING_CANCELLATION_STATUS,
  SHIPPING_INSTRUCTIONS_STATUS, UPDATED_SHIPPING_INSTRUCTIONS_STATUS,
  TRANSPORT_DOCUMENT_STATUS, AMENDED_TRANSPORT_DOCUMENT_STATUS, TRANSPORT_DOCUMENT_TYPE,
  ISSUANCE_RESPONSE, SURRENDER_REQUEST, SURRENDER_RESPONSE, PINT_RESPONSE,
  RECEIPT_DELIVERY_TYPE, CARGO_MOVEMENT_TYPE, PAYMENT_TERM, WEIGHT_UNIT, VOLUME_UNIT, TEMPERATURE_UNIT, VGM_METHOD,
  PARTY_FUNCTION, BOOKING_LOCATION_TYPE,
  EVENT_TYPE, EVENT_CLASSIFIER, EQUIPMENT_EVENT_TYPE, TRANSPORT_EVENT_TYPE, SHIPMENT_EVENT_TYPE,
  EMPTY_INDICATOR, TRANSPORT_PHASE, DOCUMENT_REFERENCE_TYPE, SHIPMENT_REFERENCE_TYPE,
  CLASSIFIER_FROM_SHORT, TRANSPORT_EVENT_FROM_SHORT,
  ISO_EQUIPMENT, ISO_EQUIPMENT_FROM_LEGACY, ISO_CODE_PATTERN, isoLengthFt, isoEquipmentCode,
  codesOf, has, labelOf,
};
