/**
 * DCSA foundation (DCSA-everywhere program, phase 0): the vendored specs, the validator and the code lists.
 *
 *  - every vendored spec (lib/dcsa/specs) loads, and every request/response body in it compiles;
 *  - every example payload the specs themselves publish validates against its own schema — proves
 *    lib/dcsa/validate.js accepts real DCSA messages, not just ones CargoDesk builds;
 *  - a payload missing a required field is refused, with a readable reason;
 *  - lib/dcsa/codes.js matches the code lists written in the specs' descriptions exactly, so a spec
 *    upgrade that adds or drops a state fails here instead of silently drifting.
 *
 * Usage:
 *   node tests/dcsa-standards.test.js
 *
 * No server needed.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const v = require("../lib/dcsa/validate");
const codes = require("../lib/dcsa/codes");

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const SPEC_DIR = path.join(__dirname, "..", "lib", "dcsa", "specs");
const docs = Object.fromEntries(Object.entries(v.SPECS).map(([k, f]) => [k, yaml.load(fs.readFileSync(path.join(SPEC_DIR, f), "utf8"))]));

console.log("Specs load and every body compiles");
for (const [key, doc] of Object.entries(docs)) {
  let bodies = 0; const errors = [];
  for (const [p, ops] of Object.entries(doc.paths || {})) for (const m of ["get", "post", "put", "patch", "delete"]) {
    const op = ops[m]; if (!op) continue;
    try {
      if (op.requestBody?.content) { v.validateRequest(key, m, p, {}); bodies++; }
      for (const [st, r] of Object.entries(op.responses || {})) {
        const media = r.content && (r.content["application/json"] || Object.values(r.content)[0]);
        if (media?.schema) { v.validateResponse(key, m, p, st, {}); bodies++; }
      }
    } catch (e) { errors.push(`${m.toUpperCase()} ${p}: ${e.message}`); }
  }
  assert(`${key} ${v.specVersion(key)}: ${bodies} bodies compile`, errors.length === 0 && bodies > 0, errors.slice(0, 2).join("; "));
}

console.log("\nThe specs' own example payloads validate");
for (const [key, doc] of Object.entries(docs)) {
  let checked = 0; const bad = [];
  for (const [p, ops] of Object.entries(doc.paths || {})) for (const m of ["get", "post", "put", "patch", "delete"]) {
    const op = ops[m]; if (!op) continue;
    const media = op.requestBody?.content?.["application/json"];
    for (const [name, ex] of Object.entries(media?.examples || {})) {
      if (ex?.value === undefined) continue;
      const r = v.validateRequest(key, m, p, ex.value); checked++;
      if (!r.ok) bad.push(`${m.toUpperCase()} ${p} "${name}": ${v.errorsText(r.errors, 2)}`);
    }
  }
  if (checked) assert(`${key}: ${checked} request examples valid`, bad.length === 0, bad.slice(0, 2).join(" | "));
}

console.log("\nA broken payload is refused with a reason");
{
  const broken = { cargoMovementTypeAtOrigin: "FCL" };
  const r = v.validateRequest("bkg", "post", "/v2/bookings", broken);
  assert("a booking without its required fields is invalid", !r.ok);
  assert("the reason names a missing field", /required property/.test(v.errorsText(r.errors)), v.errorsText(r.errors));
  let threw = false; try { v.validateSchema("bkg", "NoSuchSchema", {}); } catch { threw = true; }
  assert("asking for a schema the spec doesn't have throws", threw);
}

console.log("\ncodes.js matches the specs");
// Codes written in a property's description ("- `CODE` …") or enum, wherever that property appears.
function specCodes(key, propName, schemaName) {
  const doc = docs[key]; const found = new Set();
  const take = node => {
    for (const m of (node?.description || "").matchAll(/^\s*-\s*`([A-Z0-9_]{2,})`/gm)) found.add(m[1]);
    for (const e of node?.enum || []) found.add(String(e));
  };
  const walk = (node, name) => {
    if (!node || typeof node !== "object") return;
    if (name === propName) take(node);
    if (node.properties) for (const [k, c] of Object.entries(node.properties)) walk(c, k);
    for (const k of ["items", "allOf", "oneOf", "anyOf"]) if (node[k]) (Array.isArray(node[k]) ? node[k] : [node[k]]).forEach(x => walk(x, name));
  };
  const schemas = doc.components?.schemas || {};
  if (schemaName) take(schemas[schemaName]?.properties?.[propName]);
  else for (const s of Object.values(schemas)) walk(s, null);
  return found;
}
const same = (list, specSet, ignore = []) => {
  const mine = new Set(codes.codesOf(list)); const theirs = new Set([...specSet].filter(c => !ignore.includes(c)));
  const missing = [...theirs].filter(c => !mine.has(c)), extra = [...mine].filter(c => !theirs.has(c));
  return { ok: missing.length === 0 && extra.length === 0 && theirs.size > 0, detail: `missing ${missing.join(",") || "-"}; extra ${extra.join(",") || "-"}` };
};
const CHECKS = [
  ["BOOKING_STATUS", "bkg", "bookingStatus"], ["AMENDED_BOOKING_STATUS", "bkg", "amendedBookingStatus"],
  ["BOOKING_CANCELLATION_STATUS", "bkg", "bookingCancellationStatus"],
  ["SHIPPING_INSTRUCTIONS_STATUS", "ebl", "shippingInstructionsStatus"],
  ["UPDATED_SHIPPING_INSTRUCTIONS_STATUS", "ebl", "updatedShippingInstructionsStatus"],
  // The description still lists three superseded spellings; only the current ones are kept.
  ["TRANSPORT_DOCUMENT_STATUS", "ebl", "transportDocumentStatus", null, ["VOID", "SURRENDER_FOR_AMENDMENT", "SURRENDER_FOR_DELIVERY"]],
  ["AMENDED_TRANSPORT_DOCUMENT_STATUS", "ebl", "amendedTransportDocumentStatus"],
  ["TRANSPORT_DOCUMENT_TYPE", "ebl", "transportDocumentTypeCode"],
  ["ISSUANCE_RESPONSE", "eblIssuance", "issuanceResponseCode"], ["SURRENDER_REQUEST", "eblSurrender", "surrenderRequestCode"],
  ["SURRENDER_RESPONSE", "eblSurrender", "action"], ["PINT_RESPONSE", "pint", "responseCode"],
  ["RECEIPT_DELIVERY_TYPE", "bkg", "receiptTypeAtOrigin"], ["CARGO_MOVEMENT_TYPE", "bkg", "cargoMovementTypeAtOrigin"],
  ["PAYMENT_TERM", "bkg", "freightPaymentTermCode"], ["TEMPERATURE_UNIT", "bkg", "temperatureUnit"],
  ["VGM_METHOD", "vgm", "method"], ["BOOKING_LOCATION_TYPE", "bkg", "locationTypeCode"],
  ["EVENT_TYPE", "tnt", "eventType"], ["EVENT_CLASSIFIER", "tnt", "eventClassifier"],
  ["EQUIPMENT_EVENT_TYPE", "tnt", "equipmentEventType"], ["TRANSPORT_EVENT_TYPE", "tnt", "transportEventType"],
  ["SHIPMENT_EVENT_TYPE", "tnt", "shipmentEventType"], ["EMPTY_INDICATOR", "tnt", "emptyIndicator"],
  ["TRANSPORT_PHASE", "tnt", "transportPhase"],
  ["DOCUMENT_REFERENCE_TYPE", "tnt", "type", "DocumentReference"], ["SHIPMENT_REFERENCE_TYPE", "tnt", "type", "ShipmentReference"],
];
for (const [name, key, prop, schemaName, ignore] of CHECKS) {
  const r = same(codes[name], specCodes(key, prop, schemaName), ignore);
  assert(`${name} = ${key}.${schemaName ? schemaName + "." : ""}${prop}`, r.ok, r.detail);
}
{
  // Each standard uses a subset (eBL names shipper/consignee/notify as fields; Arrival Notice codes
  // them as OS/CN/N1; Booking adds NAC/CSR) — the internal model needs their union.
  const union = new Set(["bkg", "ebl", "eblIssuance", "pint", "an"].flatMap(k => [...specCodes(k, "partyFunction")]));
  const r = same(codes.PARTY_FUNCTION, union);
  assert("PARTY_FUNCTION = union of partyFunction across Booking, eBL, Issuance, PINT, Arrival Notice", r.ok, r.detail);
}
{
  const units = specCodes("bkg", "unit");
  assert("WEIGHT_UNIT and VOLUME_UNIT are all spec units", [...codes.codesOf(codes.WEIGHT_UNIT), ...codes.codesOf(codes.VOLUME_UNIT)].every(u => units.has(u) || specCodes("ebl", "unit").has(u)));
  const short = specCodes("ovs", "eventClassifierCode");
  assert("every OVS/CS classifier has an internal spelling", [...short].every(c => codes.CLASSIFIER_FROM_SHORT[c]), [...short].join(","));
  const shortEv = specCodes("ovs", "eventTypeCode");
  assert("every OVS/CS transport event has an internal spelling", [...shortEv].every(c => codes.TRANSPORT_EVENT_FROM_SHORT[c] && codes.has(codes.TRANSPORT_EVENT_TYPE, codes.TRANSPORT_EVENT_FROM_SHORT[c])));
}

console.log("\nISO 6346 equipment codes");
assert("every offered code is well-formed", codes.ISO_EQUIPMENT.every(e => codes.ISO_CODE_PATTERN.test(e.code)));
assert("every legacy code maps to an offered one", Object.values(codes.ISO_EQUIPMENT_FROM_LEGACY).every(c => codes.has(codes.ISO_EQUIPMENT, c)));
assert("40HC → 45G1, 45HC → L5G1, an ISO code passes through, junk is null",
  codes.isoEquipmentCode("40hc") === "45G1" && codes.isoEquipmentCode("45HC") === "L5G1" && codes.isoEquipmentCode("22G1") === "22G1" && codes.isoEquipmentCode("nonsense") === null);
assert("lengths: 22G1 20', 45G1 40', L5G1 45'", codes.isoLengthFt("22G1") === 20 && codes.isoLengthFt("45G1") === 40 && codes.isoLengthFt("L5G1") === 45);

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
