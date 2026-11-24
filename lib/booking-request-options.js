"use strict";
// The booking request's transport-document and loading fields (2026-11-23, TKT-JV1SF2 point 5, mockup dffb8ab2 approved
// "as drawn"; ARCHITECTURE.md §8.58): five DCSA Booking 2.0 fields the request never sent, kept per shipment in
// shipments.booking_request_options (JSON) and set on Carrier Booking → Details → Transport document and loading.
// The user's decision: each is optional and an empty one isn't sent ("Nothing"), so no booking changes until someone
// fills one in. Pure: normalize (what a save accepts) and dcsaFields (what the request carries).
//
//   transportDocumentType  "BOL" | "SWB" | ""      → transportDocumentTypeCode (the carrier's document to us, the Master B/L)
//   numberOfDocuments      1..99 | null            → requestedNumberOfTransportDocuments (how many B/Ls the booking is split
//                                                     into; not the number of originals)
//   placeOfIssue           UN/LOCODE | ISO country | ""  → placeOfBLIssue { UNLocationCode } or { countryCode } (one, not both)
//   partialLoad            true | false | null     → isPartialLoadAllowed (left out, carriers read it their own way)
//   customsReferences      [{ type, countryCode, values: [..] }]  → customsReferences (≤ 10; type ≤ 50, value ≤ 35)

const DOCUMENT_TYPES = Object.freeze(["BOL", "SWB"]);
const UNLOCODE = /^[A-Z]{2}[A-Z2-9]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const MAX_REFERENCES = 10;
const EMPTY = Object.freeze({ transportDocumentType: "", numberOfDocuments: null, placeOfIssue: "", partialLoad: null, customsReferences: [] });

const parse = v => { if (!v) return null; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } };
const str = v => String(v ?? "").trim();

// A stored value (or anything) → the full options, every field present (an unreadable value → the empty options).
function optionsOf(stored) {
  const o = parse(stored) || {};
  return {
    transportDocumentType: DOCUMENT_TYPES.includes(o.transportDocumentType) ? o.transportDocumentType : "",
    numberOfDocuments: Number.isInteger(o.numberOfDocuments) && o.numberOfDocuments >= 1 && o.numberOfDocuments <= 99 ? o.numberOfDocuments : null,
    placeOfIssue: UNLOCODE.test(str(o.placeOfIssue)) || COUNTRY.test(str(o.placeOfIssue)) ? str(o.placeOfIssue) : "",
    partialLoad: typeof o.partialLoad === "boolean" ? o.partialLoad : null,
    customsReferences: Array.isArray(o.customsReferences) ? o.customsReferences.filter(r => r && str(r.type) && COUNTRY.test(str(r.countryCode)) && Array.isArray(r.values) && r.values.length)
      .map(r => ({ type: str(r.type), countryCode: str(r.countryCode), values: r.values.map(str).filter(Boolean) })) : [],
  };
}

// A save's body → { options } or { error } (in words, naming the field). Missing fields keep `current`.
function normalize(body = {}, current = EMPTY) {
  const out = { ...optionsOf(current) };
  if ("transportDocumentType" in body) {
    const t = str(body.transportDocumentType).toUpperCase();
    if (t && !DOCUMENT_TYPES.includes(t)) return { error: "The transport document is a bill of lading (BOL) or a sea waybill (SWB)" };
    out.transportDocumentType = t;
  }
  if ("numberOfDocuments" in body) {
    const raw = body.numberOfDocuments;
    if (raw === null || raw === "" || raw === undefined) out.numberOfDocuments = null;
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 99) return { error: "How many B/Ls is a whole number from 1 to 99" };
      out.numberOfDocuments = n;
    }
  }
  if ("placeOfIssue" in body) {
    const p = str(body.placeOfIssue).toUpperCase();
    if (p && !UNLOCODE.test(p) && !COUNTRY.test(p)) return { error: "The place of B/L issue is a UN/LOCODE (e.g. NLRTM) or a two-letter country code (e.g. NL)" };
    out.placeOfIssue = p;
  }
  if ("partialLoad" in body) {
    const v = body.partialLoad;
    if (v !== null && typeof v !== "boolean") return { error: "Partial loading is allowed (true), not allowed (false) or not stated (null)" };
    out.partialLoad = v;
  }
  if ("customsReferences" in body) {
    const list = body.customsReferences;
    if (!Array.isArray(list)) return { error: "customsReferences must be a list" };
    if (list.length > MAX_REFERENCES) return { error: `At most ${MAX_REFERENCES} customs references` };
    const refs = [];
    for (const [i, r] of list.entries()) {
      const type = str(r?.type), countryCode = str(r?.countryCode).toUpperCase();
      const values = (Array.isArray(r?.values) ? r.values : [r?.value]).map(str).filter(Boolean);
      if (!type && !countryCode && !values.length) continue; // a row left empty is dropped
      const n = i + 1;
      if (!type || type.length > 50) return { error: `Customs reference ${n}: its type, as that customs calls it (up to 50 characters)` };
      if (!COUNTRY.test(countryCode)) return { error: `Customs reference ${n}: its country, a two-letter code (e.g. EG)` };
      if (!values.length || values.some(v => v.length > 35)) return { error: `Customs reference ${n}: its value (up to 35 characters)` };
      refs.push({ type, countryCode, values });
    }
    out.customsReferences = refs;
  }
  return { options: out };
}

// True when nothing is stated (then nothing is stored: NULL, as before the field existed).
const isEmpty = o => !o.transportDocumentType && o.numberOfDocuments == null && !o.placeOfIssue && o.partialLoad == null && !o.customsReferences.length;

// The options → the DCSA Booking 2.0 fields (only what's stated).
function dcsaFields(stored) {
  const o = optionsOf(stored);
  return {
    ...(o.transportDocumentType ? { transportDocumentTypeCode: o.transportDocumentType } : {}),
    ...(o.numberOfDocuments != null ? { requestedNumberOfTransportDocuments: o.numberOfDocuments } : {}),
    ...(UNLOCODE.test(o.placeOfIssue) ? { placeOfBLIssue: { UNLocationCode: o.placeOfIssue } } : COUNTRY.test(o.placeOfIssue) ? { placeOfBLIssue: { countryCode: o.placeOfIssue } } : {}),
    ...(o.partialLoad != null ? { isPartialLoadAllowed: o.partialLoad } : {}),
    ...(o.customsReferences.length ? { customsReferences: o.customsReferences.map(r => ({ type: r.type, countryCode: r.countryCode, values: r.values })) } : {}),
  };
}

module.exports = { optionsOf, normalize, isEmpty, dcsaFields, DOCUMENT_TYPES, EMPTY, MAX_REFERENCES };
