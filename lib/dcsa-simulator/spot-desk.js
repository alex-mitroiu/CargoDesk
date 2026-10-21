"use strict";

// The demo carrier's spot desk (SPOT rates, phase 2; agreed 2026-10-21). For a carrier with no spot
// connection of its own, the built-in carrier answers "Get offers" the way a carrier's instant-quote
// API does (Maersk Offers API, Hapag-Lloyd Quick Quotes Spot): one priced offer per departure, all-in,
// short-lived, with its penalty terms — and the booking that quotes one gets its charges back in the
// confirmation. There's no DCSA standard for rates, so the shape is CargoDesk's own spot offer
// (lib/spot-offers.js validate), carried by the demo-spot-v1 adapter.
//
// Prices are generated: a base per container from the transit time, a steady ±6% per departure, the
// bunker and origin terminal charges, a documentation fee. Validity and penalty terms per carrier follow
// what the carriers publish where known (Hapag-Lloyd: 3 hours, at most 20 containers; CMA CGM SpotOn:
// 24 hours); the amounts are the demo carrier's own.

const EUR_ORIGINS = new Set(["NL", "BE", "DE", "FR", "ES", "IT", "PT", "PL", "SE", "DK", "FI", "IE", "GR", "AT", "SI", "HR", "LT", "LV", "EE", "RO", "BG", "MT", "CY"]);
const PROFILES = {
  MAEU: { validMinutes: 60, penalties: { cancellationFee: 150, cancellationNoticeDays: 7, noShowFee: 300, amendmentFee: 75, rollCompensation: 100 } },
  HLCU: { validMinutes: 180, maxContainers: 20, penalties: { cancellationFee: 100, cancellationNoticeDays: 7, noShowFee: 200, amendmentFee: 50, rollCompensation: null } },
  CMDU: { validMinutes: 1440, penalties: { cancellationFee: 150, cancellationNoticeDays: 7, noShowFee: 300, amendmentFee: 75, rollCompensation: null } },
};
const DEFAULT_PROFILE = { validMinutes: 1440, penalties: { cancellationFee: 150, cancellationNoticeDays: 7, noShowFee: 300, amendmentFee: 75, rollCompensation: null } };
const EQUIPMENT = /^\d{2}[A-Z0-9]{2}$/;

const hash = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const round5 = n => Math.round(n / 5) * 5;

// equipment "40HC:2,20GP:1" → [{ containerType, quantity }]
function parseEquipment(text) {
  return String(text || "").split(",").map(p => p.trim()).filter(Boolean).map(p => {
    const [t, q] = p.split(":");
    return { containerType: String(t || "").toUpperCase(), quantity: Math.round(Number(q) || 0) };
  }).filter(e => EQUIPMENT.test(e.containerType) && e.quantity > 0);
}

function chargesFor(sailing, equipment, carrierCode, pol) {
  const transit = Math.max(1, Number(sailing.transitDays) || 14);
  const wobble = 0.94 + (hash(`${carrierCode}|${sailing.vesselName}|${sailing.etd}`) % 120) / 1000;
  const eurOrigin = EUR_ORIGINS.has(String(pol).slice(0, 2));
  const lines = [];
  for (const e of equipment) {
    const size = e.containerType.slice(0, 2), reefer = /^R/.test(e.containerType.slice(2)) ? 1.8 : 1;
    const feu = 900 + 80 * transit;
    const base = (size === "20" ? feu * 0.6 : size === "45" ? feu * 1.15 : feu) * reefer * wobble;
    const line = (serviceCode, description, unitPrice, currency = "USD") =>
      ({ serviceCode, description, basis: "per_container", containerType: e.containerType, quantity: e.quantity, unitPrice, currency, paymentTerm: "PRE", included: true });
    lines.push(line("OF", "Ocean freight", round5(base)));
    lines.push(line("BAF", "Bunker adjustment", size === "20" ? 150 : 250));
    lines.push(eurOrigin ? line("THC-O", "Origin terminal handling", size === "20" ? 140 : 190, "EUR")
      : line("THC-O", "Origin terminal handling", size === "20" ? 160 : 210));
  }
  lines.push({ serviceCode: "DOC", description: "Documentation fee", basis: "per_bl", containerType: "", quantity: 1, unitPrice: 75, currency: "USD", paymentTerm: "PRE", included: true });
  return lines;
}

// DCSA Booking 2.0 Charge objects for a confirmation, from an offer's charges.
function dcsaCharges(offer) {
  return (offer.lines || []).map(l => ({
    chargeName: `${l.serviceCode} ${l.description}`.slice(0, 50),
    currencyAmount: Math.round(l.unitPrice * l.quantity * 100) / 100,
    currencyCode: l.currency,
    paymentTermCode: l.paymentTerm || "PRE",
    calculationBasis: l.basis === "per_bl" ? "Per B/L" : `Per container (${l.containerType})`,
    unitPrice: l.unitPrice,
    quantity: l.quantity,
  }));
}

module.exports = function createSpotDesk({ query, uid, sailingsFor }) {
  const nowIso = () => new Date().toISOString();

  // → { ok, offers, message? }
  async function search({ carrierCode, pol, pod, equipment, from = "", weeks = 4 }) {
    carrierCode = String(carrierCode || "").toUpperCase(); pol = String(pol || "").toUpperCase(); pod = String(pod || "").toUpperCase();
    const eq = Array.isArray(equipment) ? equipment : parseEquipment(equipment);
    if (!carrierCode || !pol || !pod) return { ok: false, status: 400, error: "carrierCode, pol and pod are required" };
    if (!eq.length) return { ok: false, status: 400, error: "Give the containers, e.g. equipment=40HC:2" };
    const profile = PROFILES[carrierCode] || DEFAULT_PROFILE;
    const count = eq.reduce((s, e) => s + e.quantity, 0);
    if (profile.maxContainers && count > profile.maxContainers)
      return { ok: true, offers: [], message: `${carrierCode} prices at most ${profile.maxContainers} containers per spot request` };
    const day = /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : nowIso().slice(0, 10);
    const sailings = ((await sailingsFor({ pol, pod, carrierCode, weeks: Math.min(Math.max(Number(weeks) || 4, 1), 8) })) || [])
      .filter(s => s.etd && String(s.etd).slice(0, 10) >= day).slice(0, 6);
    // Old offers go: a spot price lives hours, not days.
    await query("DELETE FROM dcsa_sim_spot_offers WHERE created_at < $1", [new Date(Date.now() - 2 * 864e5).toISOString()]);
    const validUntil = new Date(Date.now() + profile.validMinutes * 6e4).toISOString().replace(/\.\d{3}Z$/, "Z");
    const offers = [];
    for (const s of sailings) {
      const offer = {
        offerRef: `${carrierCode}SPOT${String(hash(`${uid()}${s.vesselName}${s.etd}`) % 1e7).padStart(7, "0")}`,
        carrierCode, kind: "digital", pol, pod, equipment: eq,
        vessel: s.vesselName || "", voyage: s.voyageNumber || "", etd: String(s.etd).slice(0, 10),
        sailing: { vesselName: s.vesselName || "", voyageNumber: s.voyageNumber || "", service: s.service || "", etd: String(s.etd).slice(0, 10),
          eta: String(s.eta || "").slice(0, 10), transitDays: s.transitDays || null, legs: s.legs || null, mainLegIndex: s.mainLegIndex ?? null },
        validUntil, priceLock: "booking",
        lines: chargesFor(s, eq, carrierCode, pol),
        penalties: { ...profile.penalties, currency: "USD", basis: "per_container" },
        notes: "Demo carrier spot offer: generated prices",
      };
      await query("INSERT INTO dcsa_sim_spot_offers (id, carrier_code, offer_json, valid_until, created_at) VALUES ($1,$2,$3,$4,$5)",
        [offer.offerRef, carrierCode, JSON.stringify(offer), validUntil, nowIso()]);
      offers.push(offer);
    }
    return { ok: true, offers, ...(offers.length ? {} : { message: `${carrierCode} has no departures to price from ${day}` }) };
  }

  async function get(ref) {
    const [row] = await query("SELECT * FROM dcsa_sim_spot_offers WHERE id=$1", [ref]);
    if (!row) return null;
    try { return JSON.parse(row.offer_json); } catch { return null; }
  }

  function registerRoutes(app) {
    app.get("/dcsa-sim/spot/offers", async (req, res) => {
      const r = await search(req.query || {});
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      res.json({ offers: r.offers, ...(r.message ? { message: r.message } : {}) });
    });
    app.get("/dcsa-sim/spot/offers/:ref", async (req, res) => {
      const offer = await get(req.params.ref);
      if (!offer) return res.status(404).json({ error: `No spot offer ${req.params.ref}` });
      res.json(offer);
    });
  }

  // The charges a booking quoting one of these offers is confirmed with ([] for any other booking).
  async function chargesForRequest(requestJson) {
    let request = {};
    try { request = JSON.parse(requestJson || "{}"); } catch { request = {}; }
    const ref = request.contractQuotationReference;
    if (!ref) return [];
    const offer = await get(ref);
    return offer && offer.carrierCode === request.carrierCode ? dcsaCharges(offer) : [];
  }

  return { search, get, registerRoutes, chargesForRequest, parseEquipment };
};
module.exports.parseEquipment = parseEquipment;
