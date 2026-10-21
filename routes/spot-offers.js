"use strict";

// SPOT rates, phase 1 (plan https://claude.ai/artifact/Y61PAmXZfgFxTLtpt7GiAZ; decisions 2026-10-21):
// a carrier's spot offer typed in by hand, attached to a quote (sales) or straight to a shipment (the
// booking desk). The rules live in lib/spot-offers.js (ctx.spotOffers); quote conversion and the DCSA
// booking request use them too.
//
//   /api/spot-offers             list (?carrierCode&pol&pod&status&unattached=1), create
//   /api/spot-offers/:id         read, change (while nobody books on it), delete (unattached only)
//   /api/quotes/:id/spot-offer   the quote's offer: read, attach { offerId }, remove (Draft quotes)
//   /api/shipments/:id/spot-offer the shipment's offer: read, attach { offerId }, remove (before booking)

module.exports = function spotOffersRoutes(app, ctx) {
  const { query, ok, err, requireRole, mapQuote, mapShipment, applyShipmentAccessFilter, applyOfficeScopedAccessFilter, blockIfWrongSide, carrierIntegrationFor } = ctx;
  const so = ctx.spotOffers;
  // Pricing a quote is sales' work as much as the booking desk's (routes/quotes.js quoteWrite)...
  const offerWrite = requireRole(["admin", "operator", "occ_bk", "sales"]);
  // ...putting an offer on a shipment is a booking decision (routes/edi.js write).
  const shipmentWrite = requireRole(["admin", "operator", "occ_bk"]);

  async function visibleShipment(id, req) {
    const [row] = await query("SELECT * FROM shipments WHERE id=$1", [id]);
    if (!row) return null;
    const [allowed] = await applyShipmentAccessFilter([mapShipment(row)], req.user, req);
    return allowed ? row : null;
  }
  async function visibleQuote(id, req) {
    const [row] = await query("SELECT * FROM quotes WHERE id=$1", [id]);
    if (!row) return null;
    return (await applyOfficeScopedAccessFilter([mapQuote(row)], req.user, req)).length ? row : null;
  }
  // An attached offer is seen by whoever sees its shipment or quote; an unattached one by everyone.
  async function canSee(row, req) {
    if (row.shipment_id) return !!(await visibleShipment(row.shipment_id, req));
    if (row.quote_id) return !!(await visibleQuote(row.quote_id, req));
    return true;
  }
  const send = (res, r, okStatus = 200) => (r.ok === false ? err(res, r.error, r.status) : ok(res, r, okStatus));

  // ─── Offers ───────────────────────────────────────────────────────────────────────────────────
  app.get("/api/spot-offers", async (req, res) => {
    const { carrierCode = "", pol = "", pod = "", status = "", unattached = "" } = req.query;
    const clauses = [], params = [];
    const add = (sql, v) => { params.push(v); clauses.push(sql.replace("?", `$${params.length}`)); };
    if (carrierCode) add("carrier_code=?", String(carrierCode).toUpperCase());
    if (pol) add("pol=?", String(pol).toUpperCase());
    if (pod) add("pod=?", String(pod).toUpperCase());
    if (status) add("status=?", String(status));
    if (unattached === "1" || unattached === "true") clauses.push("shipment_id='' AND quote_id=''");
    const rows = await query(`SELECT * FROM spot_offers ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 200`, params);
    const visible = [];
    for (const r of rows) if (await canSee(r, req)) visible.push(r);
    ok(res, await so.mapRows(visible));
  });

  // ─── From the carrier (phase 2) ───────────────────────────────────────────────────────────────
  // Before /api/spot-offers/:id, which would take "from-carrier" for an id. The carrier's own spot
  // connection (capability "spot-rates", an adapter with getSpotOffers), else the demo carrier's spot
  // desk where allowed (lib/dcsa-simulator/spot-desk.js). Offers listed are the carrier's, not saved:
  // a spot price lives hours (Maersk asks for its offers to be kept for the session only); taking one
  // reads it back from the carrier and saves it.
  const parseEquipment = text => String(text || "").split(",").map(p => p.trim()).filter(Boolean).map(p => {
    const [t, q] = p.split(":");
    return { containerType: String(t || "").toUpperCase(), quantity: Math.round(Number(q) || 0) };
  }).filter(e => /^\d{2}[A-Z0-9]{2}$/.test(e.containerType) && e.quantity > 0);

  app.get("/api/spot-offers/from-carrier", async (req, res) => {
    const carrierCode = String(req.query.carrierCode || "").toUpperCase(), pol = String(req.query.pol || "").toUpperCase(), pod = String(req.query.pod || "").toUpperCase();
    if (!carrierCode || !pol || !pod) return err(res, "carrierCode, pol and pod are required");
    const equipment = parseEquipment(req.query.equipment);
    if (!equipment.length) return err(res, "Give the containers, e.g. equipment=40HC:2");
    const integ = await carrierIntegrationFor(carrierCode, "spot-rates");
    if (!integ?.adapter?.getSpotOffers) return ok(res, { available: false, carrierCode, offers: [], message: `No spot connection for ${carrierCode}: type its quote in` });
    const r = await integ.adapter.getSpotOffers(integ.config, { carrierCode, pol, pod, equipment, from: String(req.query.from || ""), weeks: Number(req.query.weeks) || 4 });
    if (!r.ok) return err(res, `${carrierCode} didn't answer: ${r.error}`, 502);
    const refs = r.offers.map(o => o.offerRef).filter(Boolean);
    const taken = refs.length ? await query(`SELECT id, offer_ref FROM spot_offers WHERE carrier_code=$1 AND offer_ref IN (${refs.map((_, i) => `$${i + 2}`).join(",")})`, [carrierCode, ...refs]) : [];
    const offers = [];
    for (const o of r.offers) {
      // Priced the way a saved offer is (charges in USD, the price = what's included), so the list and
      // the offer taken show the same totals; anything that wouldn't save isn't offered.
      const v = await so.validate(o);
      if (v.error) continue;
      offers.push({ ...o, lines: v.value.lines, totalUsd: v.value.totalUsd, subjectToUsd: v.value.subjectToUsd,
        takenId: taken.find(t => t.offer_ref === o.offerRef)?.id || null });
    }
    ok(res, { available: true, demo: !!integ.row.is_simulator, carrierCode, offers, message: r.message || "" });
  });

  app.post("/api/spot-offers/from-carrier", offerWrite, async (req, res) => {
    const carrierCode = String(req.body?.carrierCode || "").toUpperCase(), offerRef = String(req.body?.offerRef || "").trim();
    if (!carrierCode || !offerRef) return err(res, "carrierCode and offerRef required");
    const [existing] = await query("SELECT id FROM spot_offers WHERE carrier_code=$1 AND offer_ref=$2", [carrierCode, offerRef]);
    if (existing) return ok(res, await so.get(existing.id));
    const integ = await carrierIntegrationFor(carrierCode, "spot-rates");
    if (!integ?.adapter?.getSpotOffer) return err(res, `No spot connection for ${carrierCode}`, 409);
    const r = await integ.adapter.getSpotOffer(integ.config, offerRef);
    if (!r.ok) return err(res, `${carrierCode} has no offer ${offerRef}${r.error ? ` (${r.error})` : ""}`, r.status === 404 ? 404 : 502);
    if (r.offer?.carrierCode !== carrierCode) return err(res, `Offer ${offerRef} isn't ${carrierCode}'s`, 409);
    const c = await so.create(r.offer, req.user, { source: integ.row.is_simulator ? "demo" : "api" });
    if (c.ok === false) return err(res, `${carrierCode}'s offer can't be saved: ${c.error}`, 502);
    ok(res, c.offer, 201);
  });

  app.get("/api/spot-offers/:id", async (req, res) => {
    const o = await so.load(req.params.id);
    if (!o || !(await canSee(o.row, req))) return err(res, "Spot offer not found", 404);
    ok(res, so.mapOffer(o.row, o.lines));
  });

  app.post("/api/spot-offers", offerWrite, async (req, res) => {
    const r = await so.create(req.body, req.user);
    if (r.ok === false) return err(res, r.error, r.status);
    ok(res, r.offer, 201);
  });

  app.put("/api/spot-offers/:id", offerWrite, async (req, res) => {
    const o = await so.load(req.params.id);
    if (!o || !(await canSee(o.row, req))) return err(res, "Spot offer not found", 404);
    const r = await so.update(req.params.id, req.body, req.user);
    if (r.ok === false) return err(res, r.error, r.status);
    ok(res, r.offer);
  });

  app.delete("/api/spot-offers/:id", offerWrite, async (req, res) => {
    const o = await so.load(req.params.id);
    if (!o || !(await canSee(o.row, req))) return err(res, "Spot offer not found", 404);
    send(res, await so.remove(req.params.id, req.user));
  });

  // ─── On a quote ───────────────────────────────────────────────────────────────────────────────
  app.get("/api/quotes/:id/spot-offer", async (req, res) => {
    const quote = await visibleQuote(req.params.id, req);
    if (!quote) return err(res, "Not found", 404);
    ok(res, quote.spot_offer_id ? await so.get(quote.spot_offer_id) : null);
  });

  app.post("/api/quotes/:id/spot-offer", offerWrite, async (req, res) => {
    const quote = await visibleQuote(req.params.id, req);
    if (!quote) return err(res, "Not found", 404);
    if (!req.body?.offerId) return err(res, "offerId required");
    send(res, await so.attachToQuote(String(req.body.offerId), quote, req.user));
  });

  app.delete("/api/quotes/:id/spot-offer", offerWrite, async (req, res) => {
    const quote = await visibleQuote(req.params.id, req);
    if (!quote) return err(res, "Not found", 404);
    send(res, await so.detachFromQuote(quote, req.user));
  });

  // ─── On a shipment ────────────────────────────────────────────────────────────────────────────
  app.get("/api/shipments/:id/spot-offer", async (req, res) => {
    const shipment = await visibleShipment(req.params.id, req);
    if (!shipment) return err(res, "Shipment not found", 404);
    ok(res, shipment.spot_offer_id ? await so.get(shipment.spot_offer_id) : null);
  });

  // What cancelling the booking now would cost under the offer's penalty terms (null: nothing), for the
  // warning before Cancel; the fee itself is accrued when the carrier confirms the cancellation.
  app.get("/api/shipments/:id/spot-offer/cancellation-fee", async (req, res) => {
    const shipment = await visibleShipment(req.params.id, req);
    if (!shipment) return err(res, "Shipment not found", 404);
    ok(res, await so.cancellationFee(shipment.id));
  });

  app.post("/api/shipments/:id/spot-offer", shipmentWrite, async (req, res) => {
    const shipment = await visibleShipment(req.params.id, req);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, "export")) return;
    if (!req.body?.offerId) return err(res, "offerId required");
    send(res, await so.attachToShipment(String(req.body.offerId), shipment, req.user));
  });

  app.delete("/api/shipments/:id/spot-offer", shipmentWrite, async (req, res) => {
    const shipment = await visibleShipment(req.params.id, req);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, "export")) return;
    send(res, await so.detachFromShipment(shipment, req.user));
  });
};
