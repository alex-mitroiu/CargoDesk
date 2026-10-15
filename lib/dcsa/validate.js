"use strict";

// DCSA payload validation (DCSA-everywhere program, phase 0; ~/.claude/plans/wiggly-kindling-castle.md).
// Every message CargoDesk sends to or receives from a carrier, eBL platform or port is checked against
// the published OpenAPI spec it claims to follow, vendored in ./specs (see ./specs/README.md for where
// each file came from). This is what makes "never add a field from memory" enforceable: a payload that
// drifts from the spec fails here, in tests and in production, instead of at the carrier.
//
//   validateSchema("bkg", "CreateBooking", payload)            → { ok, errors }
//   validateRequest("ebl", "post", "/v3/shipping-instructions", body)
//   validateResponse("tnt", "get", "/events", 200, body)
//   errorsText(errors)                                          → one readable line
//
// Callers decide what a failure means: an outbound send is refused (the carrier would answer 400
// anyway), an inbound message is rejected to its sender. Specs are parsed lazily, once per process.

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

// key → vendored file. Keys are what adapters and the simulator use.
const SPECS = {
  bkg:         "BKG_v2.0.0.yaml",               // Booking 2.0.4
  ebl:         "EBL_v3.0.0.yaml",               // Shipping Instructions + Transport Document 3.0.3
  eblIssuance: "EBL_ISS_v3.0.0.yaml",           // eBL Issuance 3.0.3
  eblSurrender:"EBL_SUR_v3.0.0.yaml",           // eBL Surrender 3.0.3
  pint:        "EBL_PINT_v3.0.0.yaml",          // eBL Platform Interoperability 3.0.0-beta
  vgm:         "VGM_v1.0.0.yaml",               // Verified Gross Mass 1.0.1
  tnt:         "TNT_v3.0.0.yaml",               // Track & Trace 3.0.0
  cs:          "CS_v1.0.0.yaml",                // Commercial Schedules 1.0.3
  ovs:         "OVS_v3.0.0.yaml",               // Operational Vessel Schedules 3.0.2
  an:          "an-v1.0.0-openapi.yaml",        // Arrival Notice 1.0.1
  portCall:    "port-call-v2.0.0-openapi.yaml", // Port Call 2.0.0
};

const loaded = new Map(); // key → { doc, ajv, id, cache: Map }

function load(key) {
  if (loaded.has(key)) return loaded.get(key);
  const file = SPECS[key];
  if (!file) throw new Error(`Unknown DCSA spec "${key}"`);
  const doc = normalize(yaml.load(fs.readFileSync(path.join(__dirname, "specs", file), "utf8")));
  // OpenAPI 3.0 schemas are JSON Schema plus a few keywords (example, discriminator, readOnly…);
  // strict:false lets ajv ignore those instead of refusing the spec.
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  // An absolute URI: refs are resolved as URIs, so a bare "dcsa-bkg" would be read as a scheme.
  const id = `https://cargodesk.invalid/dcsa/${key}`;
  // Registered whole, so every "#/components/schemas/X" $ref resolves against this document.
  ajv.addSchema({ $id: id, components: doc.components || {} });
  const entry = { doc, ajv, id, version: doc.info?.version || "", cache: new Map() };
  loaded.set(key, entry);
  return entry;
}

function run(entry, cacheKey, schemaOrRef, value) {
  let validate = entry.cache.get(cacheKey);
  if (!validate) {
    validate = typeof schemaOrRef === "string"
      ? entry.ajv.getSchema(schemaOrRef)
      : entry.ajv.compile(rewriteRefs(schemaOrRef, entry.id)); // no $id of its own: nothing to collide with
    if (!validate) throw new Error(`DCSA ${entry.id}: no schema for ${cacheKey}`);
    entry.cache.set(cacheKey, validate);
  }
  const ok = validate(value);
  return { ok, errors: ok ? [] : validate.errors.map(e => ({ path: e.instancePath || "/", message: e.message, params: e.params })) };
}

// OpenAPI 3.0 writes exclusive bounds the draft-04 way (`minimum: 0, exclusiveMinimum: true`);
// ajv speaks the later drafts (`exclusiveMinimum: 0`). Converted once, in place, as a spec loads.
function normalize(node) {
  if (Array.isArray(node)) { node.forEach(normalize); return node; }
  if (!node || typeof node !== "object") return node;
  for (const [flag, bound] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]]) {
    if (typeof node[flag] !== "boolean") continue;
    if (node[flag] && typeof node[bound] === "number") { node[flag] = node[bound]; delete node[bound]; }
    else delete node[flag];
  }
  for (const v of Object.values(node)) normalize(v);
  return node;
}

// An operation's inline body schema refers to "#/components/schemas/X" of the spec it sits in;
// compiled on its own it needs those refs pointed at the registered document.
function rewriteRefs(node, id) {
  if (Array.isArray(node)) return node.map(n => rewriteRefs(n, id));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = k === "$ref" && typeof v === "string" && v.startsWith("#/") ? `${id}${v}` : rewriteRefs(v, id);
  return out;
}

function validateSchema(key, schemaName, value) {
  const entry = load(key);
  if (!entry.doc.components?.schemas?.[schemaName]) throw new Error(`DCSA ${key} ${entry.version}: no schema "${schemaName}"`);
  return run(entry, `schema:${schemaName}`, `${entry.id}#/components/schemas/${schemaName}`, value);
}

function bodySchema(entry, method, apiPath, status) {
  const op = entry.doc.paths?.[apiPath]?.[method.toLowerCase()];
  if (!op) throw new Error(`DCSA ${entry.id} ${entry.version}: no operation ${method.toUpperCase()} ${apiPath}`);
  const holder = status === undefined ? op.requestBody : (op.responses?.[String(status)] || op.responses?.default);
  const content = holder?.content || {};
  const media = content["application/json"] || Object.values(content)[0];
  if (!media?.schema) throw new Error(`DCSA ${entry.id}: ${method.toUpperCase()} ${apiPath} has no ${status === undefined ? "request" : `${status} response`} body`);
  return media.schema;
}

function validateRequest(key, method, apiPath, body) {
  const entry = load(key);
  return run(entry, `req:${method}:${apiPath}`, bodySchema(entry, method, apiPath), body);
}

function validateResponse(key, method, apiPath, status, body) {
  const entry = load(key);
  return run(entry, `res:${method}:${apiPath}:${status}`, bodySchema(entry, method, apiPath, status), body);
}

function errorsText(errors, max = 6) {
  const list = errors.slice(0, max).map(e => `${e.path} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(", ")})` : ""}`);
  return list.join("; ") + (errors.length > max ? `; and ${errors.length - max} more` : "");
}

const specVersion = key => load(key).version;

module.exports = { SPECS, validateSchema, validateRequest, validateResponse, errorsText, specVersion };
