"use strict";
// One HTTP call to a carrier's DCSA API, shared by every standard the generic DCSA adapter speaks
// (Booking 2.0, Shipping Instructions 3.0, VGM 1.0, Track & Trace 3.0, Commercial Schedules 1.0).
// Nothing leaves CargoDesk that doesn't match the published spec (a real carrier would answer 400),
// and nothing the carrier answers is used unless it matches too (lib/dcsa/validate.js).
//
// Returns { ok, status, raw, headers } / { ok:false, error, invalid? } and never throws past its own
// boundary — the rule lib/ais-listener.js states for code that talks to an external system.

const { validateOutbound, validateResponse, errorsText, specVersion } = require("../dcsa/validate");

const SPEC_NAME = {
  bkg: "Booking", ebl: "Shipping Instructions and Transport Document", vgm: "Verified Gross Mass",
  tnt: "Track & Trace", cs: "Commercial Schedules", ovs: "Operational Vessel Schedules",
};
// The API-Version header (sent on every request): the standards from Booking 2.0 / eBL 3.0 put the
// major version in their paths (/v2/…, /v3/…); the newer ones (T&T 3.0, VGM 1.0) have unversioned
// paths and ask for "the full version of the implemented DCSA standard".
// OVS too, from 3.0.1 on (a blank or "3" there means a 3.0.0 client).
const FULL_VERSION_HEADER = new Set(["tnt", "vgm", "ovs"]);

const errorText = (status, raw) => {
  const detail = raw && typeof raw === "object"
    ? (raw.errors || []).map(e => e.errorCodeMessage || e.errorCodeText).filter(Boolean).join("; ")
      || (raw.feedbackElements || []).map(f => f.message).filter(Boolean).join("; ")
      || raw.statusCodeMessage || raw.statusCodeText || ""
    : "";
  return `Carrier answered ${status}${detail ? `: ${detail}` : ""}`;
};

// spec = [key, the spec's own path template]. Response bodies are checked for GETs and, with
// `checkResponse`, for the other methods whose success answer has a body (VGM's POST).
async function dcsaCall(config, method, pathOrUrl, { body, query, expect = [200], spec, checkResponse = false } = {}) {
  if (spec && body !== undefined) {
    const v = validateOutbound(spec[0], method, spec[1], body);
    if (!v.ok) return { ok: false, invalid: true, error: `Not sent: the message doesn't match DCSA ${SPEC_NAME[spec[0]]} ${specVersion(spec[0])} (${errorsText(v.errors, 3)})` };
  }
  try {
    const base = String(config.baseUrl || "").replace(/\/$/, "");
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl
      : `${base}${pathOrUrl}${query ? `?${new URLSearchParams(query)}` : ""}`;
    const apiVersion = spec && FULL_VERSION_HEADER.has(spec[0]) ? specVersion(spec[0]) : (url.match(/\/v(\d+)\//) || [])[1];
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(apiVersion ? { "API-Version": apiVersion } : {}),
        [config.authHeaderName || "Authorization"]: config.credential || "",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let raw = null;
    try { raw = text ? JSON.parse(text) : null; } catch { raw = text; }
    if (!expect.includes(res.status)) return { ok: false, status: res.status, error: errorText(res.status, raw), raw };
    if (spec && (method === "GET" || checkResponse) && raw && typeof raw === "object") {
      const v = validateResponse(spec[0], method, spec[1], res.status, raw);
      if (!v.ok) return { ok: false, status: res.status, invalid: true, error: `The carrier's answer doesn't match DCSA ${SPEC_NAME[spec[0]]} ${specVersion(spec[0])} (${errorsText(v.errors, 3)})`, raw };
    }
    return { ok: true, status: res.status, raw, headers: res.headers };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { dcsaCall, errorText };
