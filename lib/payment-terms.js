"use strict";

// ─── Payment terms (CPI) and the responsible office of each charge (2026-11-14, ARCHITECTURE.md §8.52) ──────────────
// The office split (the user's decisions, mockup 1cb7bdf6 v2): on the Carrier Booking the OCC/BK sets the carrier
// payment terms per charge category — the seven DCSA Booking 2.0 groups — each Prepaid or Collect and with a
// responsible office from the shipment's offices; the Incoterm sets the defaults. Every cost and charge line belongs to
// its category's office unless it is changed for that line. A charge is billed to the party its term names (Prepaid →
// the seller's side, Collect → the buyer's; the side that pays the main carriage is billed through the principal). The
// shipment's billing office, when it has one, issues every invoice; otherwise each responsible office invoices its own
// lines, one invoice per issuing legal entity and billed party.
//
// One rule for the server and the screens: the browser's copy (src/utils/paymentTerms.js) must stay identical,
// paymentTerms.parity.test.js checks it. Pure: shipments and lines come in camelCase (the server maps its rows first).

// The seven categories, in the order the booking screen lists them, with where each goes in a DCSA booking.
const CATEGORIES = [
  { id: "originHaulage", side: "Origin", label: "Origin haulage", dcsa: ["originChargesPaymentTerm", "haulageChargesPaymentTermCode"] },
  { id: "originPort", side: "Origin", label: "Origin port charges", dcsa: ["originChargesPaymentTerm", "portChargesPaymentTermCode"] },
  { id: "originOther", side: "Origin", label: "Other origin charges", dcsa: ["originChargesPaymentTerm", "otherChargesPaymentTermCode"] },
  { id: "freight", side: "Main carriage", label: "Ocean freight", dcsa: ["freightPaymentTermCode"] },
  { id: "destinationPort", side: "Destination", label: "Destination port charges", dcsa: ["destinationChargesPaymentTerm", "portChargesPaymentTermCode"] },
  { id: "destinationHaulage", side: "Destination", label: "Destination haulage", dcsa: ["destinationChargesPaymentTerm", "haulageChargesPaymentTermCode"] },
  { id: "destinationOther", side: "Destination", label: "Other destination charges", dcsa: ["destinationChargesPaymentTerm", "otherChargesPaymentTermCode"] },
];
const CATEGORY_IDS = CATEGORIES.map(c => c.id);
// Who pays each category under each Incoterm, in CATEGORIES order: P = the seller (Prepaid), C = the buyer (Collect).
// From the Incoterms 2020 matrix; where it depends on the named place (FCA/FAS origin port charges, CPT/CIP destination
// port charges and haulage) the default is the usual case and the OCC/BK switches it (decision I).
const DEFAULTS = {
  EXW: "CCCCCCC", FCA: "PCPCCCC", FAS: "PCPCCCC", FOB: "PPPCCCC",
  CFR: "PPPPCCC", CIF: "PPPPCCC", CPT: "PPPPCCC", CIP: "PPPPCCC",
  DAP: "PPPPPPC", DPU: "PPPPPPC", DDP: "PPPPPPP",
};
const NO_INCOTERM = "PPPPPPP";
const SELLER_PAYS_MAIN = ["CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];
const BUYER_PAYS_MAIN = ["EXW", "FCA", "FAS", "FOB"];
// A shipment's offices a category or line can name: its export, import, billing and controlling offices, or one of its
// additional offices as "office:<id>".
const OFFICE_ROLES = ["export", "import", "billing", "controlling"];
const OFFICE_ROLE_LABEL = { export: "Export office", import: "Import office", billing: "Billing office", controlling: "Controlling office" };
const TERMS = ["PRE", "COL"];
const SIDES = ["Origin", "Destination"];

const up = v => String(v || "").trim().toUpperCase();
const code = v => String(v || "").trim().toLowerCase();

// The side a charge code names (null for the codes that name none: B/L Fee, Customs, Inland, Haulage, Other…).
function sideOfCode(chargeCode) {
  const c = code(chargeCode);
  if (["ocean freight", "of", "ofr", "freight"].includes(c)) return "Main carriage";
  if (["origin thc", "othc"].includes(c)) return "Origin";
  if (["destination thc", "dthc"].includes(c)) return "Destination";
  return null;
}
const isHaulageCode = chargeCode => ["haulage", "inland", "trucking", "pre-carriage", "on-carriage"].includes(code(chargeCode));

// A line's side: what its code names, else the side set on it, else from where it came (an Arrival Notice's charges
// are destination charges), else Origin.
function sideOfLine(line = {}) {
  const fixed = sideOfCode(line.chargeCode);
  if (fixed) return fixed;
  if (SIDES.includes(line.chargeSide)) return line.chargeSide;
  return line.source === "arrival_notice" ? "Destination" : "Origin";
}

// The category a line belongs to.
function categoryOf(line = {}) {
  const side = sideOfLine(line);
  if (side === "Main carriage") return "freight";
  const c = code(line.chargeCode);
  if (c === "origin thc" || c === "othc") return "originPort";
  if (c === "destination thc" || c === "dthc") return "destinationPort";
  const prefix = side === "Destination" ? "destination" : "origin";
  return isHaulageCode(line.chargeCode) ? `${prefix}Haulage` : `${prefix}Other`;
}

// The Incoterm's defaults: { categories: { id: { term, office } } } (Prepaid → the export office, Collect → import).
function defaultCategories(incoterm) {
  const pattern = DEFAULTS[up(incoterm)] || NO_INCOTERM;
  return Object.fromEntries(CATEGORY_IDS.map((id, i) => [id, { term: pattern[i] === "C" ? "COL" : "PRE", office: pattern[i] === "C" ? "import" : "export" }]));
}

const parse = v => { if (!v) return null; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } };

// A shipment's terms as they apply now → { saved, followsIncoterm, categories }. Not saved (null on the shipment):
// the Incoterm's defaults, shown but not applied — the shipment is billed as before the split (one legal entity, one
// invoice to the principal). Saved and following the Incoterm: the defaults of its current Incoterm.
function termsOf(shipment = {}) {
  const stored = parse(shipment.paymentTerms);
  const defaults = defaultCategories(shipment.incoterm);
  if (!stored) return { saved: false, followsIncoterm: true, categories: defaults };
  if (stored.followsIncoterm !== false) return { saved: true, followsIncoterm: true, categories: defaults };
  const categories = {};
  for (const id of CATEGORY_IDS) {
    const c = stored.categories?.[id] || {};
    categories[id] = { term: TERMS.includes(c.term) ? c.term : defaults[id].term, office: c.office || defaults[id].office };
  }
  return { saved: true, followsIncoterm: false, categories };
}

// An office key → the office id on this shipment (an office the shipment no longer has falls back to the export office).
function officeIdOf(shipment = {}, key) {
  const k = String(key || "");
  if (k.startsWith("office:")) {
    const id = k.slice(7);
    return (shipment.sideOfficeIds || []).includes(id) ? id : (shipment.emoOfficeId || null);
  }
  const id = { export: shipment.emoOfficeId, import: shipment.imoOfficeId, billing: shipment.billingOfficeId, controlling: shipment.controllingOfficeId }[k];
  return id || shipment.emoOfficeId || shipment.imoOfficeId || null;
}

// Is this a key the shipment's offices offer? (the dropdowns list exactly these)
function officeKeysOf(shipment = {}) {
  const keys = ["export"];
  if (shipment.imoOfficeId) keys.push("import");
  if (shipment.billingOfficeId) keys.push("billing");
  if (shipment.controllingOfficeId && ![shipment.emoOfficeId, shipment.imoOfficeId, shipment.billingOfficeId].includes(shipment.controllingOfficeId)) keys.push("controlling");
  for (const id of shipment.sideOfficeIds || []) if (![shipment.emoOfficeId, shipment.imoOfficeId, shipment.billingOfficeId].includes(id)) keys.push(`office:${id}`);
  return keys;
}
const isOfficeKey = (shipment, key) => officeKeysOf(shipment).includes(String(key || ""));

// The party a category's charges are billed to: Prepaid → the seller's side, Collect → the buyer's; the side that pays
// the main carriage is billed through the principal (a principal someone picked takes that side's charges). With no
// Incoterm, or a party missing, the principal, else the consignee (as before the split).
// → { customerId, name, role } ("Principal" | "Shipper" | "Consignee").
function billedPartyOf(shipment = {}, term) {
  const s = shipment;
  const principal = s.principalId || s.principalName ? { customerId: s.principalId || "", name: s.principalName || "", role: "Principal" } : null;
  const consignee = { customerId: s.consigneeId || "", name: s.consigneeName || "", role: "Consignee" };
  const shipper = { customerId: s.shipperId || "", name: s.shipperName || "", role: "Shipper" };
  const t = up(s.incoterm);
  const sellerMain = SELLER_PAYS_MAIN.includes(t), buyerMain = BUYER_PAYS_MAIN.includes(t);
  const fallback = principal || consignee;
  if (!sellerMain && !buyerMain) return fallback;
  const sellerSide = term === "PRE";
  if (sellerSide === sellerMain) return principal || (sellerSide ? shipper : consignee);
  const party = sellerSide ? shipper : consignee;
  return party.customerId || party.name ? party : fallback;
}

// Everything the split decides for one line → { category, side, term, officeKey, officeId, followsCategory,
// issuerOfficeId, billTo }. billTo is for charges (SELL); a cost (BUY) is paid by its office.
function lineSplit(shipment = {}, line = {}, terms = termsOf(shipment)) {
  const category = categoryOf(line);
  const c = terms.categories[category];
  const followsCategory = !line.responsibleOffice || !isOfficeKey(shipment, line.responsibleOffice);
  const officeKey = followsCategory ? c.office : line.responsibleOffice;
  const officeId = officeIdOf(shipment, officeKey);
  return {
    category, side: sideOfLine(line), term: c.term, officeKey, officeId, followsCategory,
    issuerOfficeId: shipment.billingOfficeId || officeId,
    billTo: billedPartyOf(shipment, c.term),
  };
}

// The DCSA Booking 2.0 payment fields for these terms (+ where the freight is payable, from its office's location).
function dcsaPaymentTerms(terms, { freightPayableAt = "" } = {}) {
  const out = {};
  for (const c of CATEGORIES) {
    const v = terms.categories[c.id]?.term;
    if (!v) continue;
    if (c.dcsa.length === 1) out[c.dcsa[0]] = v;
    else (out[c.dcsa[0]] = out[c.dcsa[0]] || {})[c.dcsa[1]] = v;
  }
  if (/^[A-Z]{2}[A-Z2-9]{3}$/.test(up(freightPayableAt))) out.invoicePayableAt = { UNLocationCode: up(freightPayableAt) };
  return out;
}

// The shipment's Freight Terms for a freight term (keeping "Payable at Destination" for a Collect one).
const freightTermsFor = (term, current = "") => (term === "COL" ? (/payable at destination/i.test(current) ? current : "Collect") : "Prepaid");

module.exports = {
  CATEGORIES, CATEGORY_IDS, DEFAULTS, OFFICE_ROLES, OFFICE_ROLE_LABEL, TERMS, SIDES,
  sideOfCode, sideOfLine, categoryOf, defaultCategories, termsOf, officeIdOf, officeKeysOf, isOfficeKey,
  billedPartyOf, lineSplit, dcsaPaymentTerms, freightTermsFor,
};
