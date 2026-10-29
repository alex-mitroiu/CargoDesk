"use strict";
// DCSA Arrival Notice 1.0 (vendored an-v1.0.0-openapi.yaml, API 1.0.1), part of the generic DCSA adapter
// (merged with dcsa-bkg-v2 in server.js) since 2026-10-28 (DCSA-everywhere phase 8). CargoDesk subscribes:
// the carrier pushes POST /arrival-notices (or a lightweight POST /arrival-notice-notifications) to
// routes/carrier-webhooks.js; CargoDesk asks for them itself with GET /arrival-notices by the B/L numbers
// (a lightweight notification, or "Ask the carrier again"). lib/arrival-notices.js works them in.

const { dcsaCall: call } = require("./dcsa-http");

// → { ok, arrivalNotices } (the latest version of each). transportDocumentReferences is a comma-separated
// list (explode: false); every publisher must support it.
async function getArrivalNotices(config, { transportDocumentReferences = [], removeCharges = false } = {}) {
  const refs = transportDocumentReferences.map(r => String(r || "").trim()).filter(Boolean);
  if (!refs.length) return { ok: true, arrivalNotices: [] };
  const query = { transportDocumentReferences: refs.join(","), limit: "100", ...(removeCharges ? { removeCharges: "true" } : {}) };
  const r = await call(config, "GET", "/arrival-notices", { query, expect: [200], spec: ["an", "/arrival-notices"] });
  if (!r.ok) return r;
  return { ok: true, arrivalNotices: Array.isArray(r.raw?.arrivalNotices) ? r.raw.arrivalNotices : [], raw: r.raw };
}

module.exports = { getArrivalNotices };
