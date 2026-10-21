"use strict";

// Spot offers from the demo carrier's spot desk (lib/dcsa-simulator/spot-desk.js; SPOT rates phase 2,
// 2026-10-21), over HTTP like a carrier's instant-quote API. No DCSA standard covers rates, so each real
// carrier gets its own adapter with these two calls (Hapag-Lloyd Quick Quotes, Maersk Offers: phase 5):
//   getSpotOffers(config, { pol, pod, carrierCode, equipment:[{containerType, quantity}], from, weeks })
//     → { ok, offers:[spot offer bodies, lib/spot-offers.js validate's shape], message? } | { ok:false, error }
//   getSpotOffer(config, offerRef) → { ok, offer } | { ok:false, error }

const ADAPTER_KEY = "demo-spot-v1";

async function call(config, path, query) {
  try {
    const base = String(config.baseUrl || "").replace(/\/$/, "");
    const res = await fetch(`${base}${path}${query ? `?${new URLSearchParams(query)}` : ""}`, {
      headers: { [config.authHeaderName || "Authorization"]: config.credential || "" },
      signal: AbortSignal.timeout(15000),
    });
    const raw = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, error: raw?.error || `The carrier answered ${res.status}` };
    return { ok: true, raw };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getSpotOffers(config, { pol, pod, carrierCode, equipment = [], from = "", weeks = 4 } = {}) {
  const r = await call(config, "/spot/offers", {
    carrierCode, pol, pod, from, weeks: String(weeks),
    equipment: equipment.map(e => `${e.containerType}:${e.quantity}`).join(","),
  });
  if (!r.ok) return r;
  return { ok: true, offers: Array.isArray(r.raw?.offers) ? r.raw.offers : [], ...(r.raw?.message ? { message: r.raw.message } : {}) };
}

async function getSpotOffer(config, offerRef) {
  const r = await call(config, `/spot/offers/${encodeURIComponent(offerRef)}`);
  return r.ok ? { ok: true, offer: r.raw } : r;
}

module.exports = { adapterKey: ADAPTER_KEY, getSpotOffers, getSpotOffer };
