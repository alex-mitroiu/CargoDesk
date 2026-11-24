"use strict";
// A party's identifiers in DCSA terms, one rule for every message that names a party (2026-11-23, TKT-JV1SF2 point 1: the
// booking now sends them too; moved out of lib/house-bl.js, where the House B/L's transport document already used it).
// CargoDesk keeps a customer's identifiers in customer_identifiers (Master Data → Customers → Identifiers): legal-entity
// codes become identifyingCodes (LEI under GLEIF, DUNS under DNB, an FMC licence, a DID under W3C), an eBL platform's id
// an identifyingCode under that platform, tax numbers (VAT, EORI, …) taxLegalReferences with their country. Pure.

const IDENTIFYING = Object.freeze({ LEI: ["GLEIF", "LEI"], DUNS: ["DNB", "DUNS"], FMC: ["FMC", null], DID: ["W3C", "DID"] });
const PLATFORMS = Object.freeze(["WAVE", "CARX", "IDT", "BOLE", "EDOX", "IQAX", "SECR", "TRGO", "ETEU", "TRAC", "BRIT", "COVA", "ETIT", "KTNE", "CRED", "BLOC", "DOCU", "AEOT", "SGTD", "GSBN", "WISE", "DCSA"]);
const TAX_TYPES = Object.freeze(["VAT", "EORI", "TIN", "EIN", "GST", "CNPJ", "USCI"]);
const clip = (s, n) => String(s ?? "").trim().slice(0, n);

// identifiers: [{ idType, idCode, countryIso2 }]; countryIso2 = the customer's own country, for a tax number without one.
// → { identifyingCodes, taxLegalReferences } (both arrays, maybe empty). A tax number with no country at all is left out:
// DCSA requires its country.
function dcsaPartyCodes(identifiers, countryIso2 = "") {
  const identifyingCodes = [], taxLegalReferences = [];
  for (const i of identifiers || []) {
    const t = String(i?.idType || "").trim().toUpperCase(), code = clip(i?.idCode, 150);
    if (!code) continue;
    if (IDENTIFYING[t]) identifyingCodes.push({ codeListProvider: IDENTIFYING[t][0], partyCode: code, ...(IDENTIFYING[t][1] && { codeListName: IDENTIFYING[t][1] }) });
    else if (PLATFORMS.includes(t)) identifyingCodes.push({ codeListProvider: t, partyCode: code });
    else if (TAX_TYPES.includes(t) || t === "TAX ID") {
      const country = String(i.countryIso2 || countryIso2 || "").trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(country)) taxLegalReferences.push({ type: t === "TAX ID" ? "TIN" : t, countryCode: country, value: clip(code, 35) });
    }
  }
  return { identifyingCodes, taxLegalReferences };
}

module.exports = { dcsaPartyCodes, IDENTIFYING, PLATFORMS, TAX_TYPES };
