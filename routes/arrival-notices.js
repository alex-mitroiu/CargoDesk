"use strict";

// ─── The carrier's Arrival Notice on the shipment (DCSA Arrival Notice 1.0, phase 8, 2026-10-28) ───
// The import side's page (Booking & Routing → Arrival Notice): the current notice, what it did to the ETA
// and free time, its charges. lib/arrival-notices.js holds the rules; the carrier's push and notifications
// come in through routes/carrier-webhooks.js.

module.exports = function arrivalNoticeRoutes(app, ctx) {
  const { query, ok, err, auth, requireRole, carrierIntegrationFor, blockIfWrongSide } = ctx;
  const write = requireRole(["admin", "operator", "occ_bk"]); // as Cost Entry's
  const who = req => req.user?.name || req.user?.email || "";

  const shipmentFor = async (req, res, { forWrite = false } = {}) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) { err(res, "Shipment not found", 404); return null; }
    if (forWrite && (await blockIfWrongSide(req, res, shipment, "import"))) return null;
    return shipment;
  };

  app.get("/api/shipments/:id/arrival-notice", auth(), async (req, res) => {
    if (!(await shipmentFor(req, res))) return;
    ok(res, await ctx.arrivalNotices.view(req.params.id));
  });

  // Ask the carrier for its arrival notices by the shipment's B/L numbers (a lost push, or to check).
  app.post("/api/shipments/:id/arrival-notice/refresh", write, async (req, res) => {
    const shipment = await shipmentFor(req, res, { forWrite: true });
    if (!shipment) return;
    const refs = await ctx.arrivalNotices.referencesOf(shipment.id);
    if (!refs.length) return err(res, "The shipment has no Master or House B/L number for the carrier to find its arrival notice by", 409);
    const integ = await carrierIntegrationFor(shipment.carrier_code, "arrival-notice");
    if (!integ?.adapter.getArrivalNotices) return err(res, `No DCSA Arrival Notice connection for ${shipment.carrier_code || "this carrier"}`, 400);
    const r = await integ.adapter.getArrivalNotices(integ.config, { transportDocumentReferences: refs });
    if (!r.ok) return err(res, `${shipment.carrier_code} could not be asked for its arrival notice (${r.error})`, 502);
    // Only the ones for this shipment's B/Ls (a publisher may answer more).
    const mine = r.arrivalNotices.filter(an => refs.includes(an.transportDocumentReference) || (an.houseBillOfLadingReferences || []).some(h => refs.includes(h)));
    for (const an of mine) await ctx.arrivalNotices.apply(shipment.id, an, { carrierCode: shipment.carrier_code, simulated: !!integ.row.is_simulator, source: "poll" });
    ok(res, await ctx.arrivalNotices.view(shipment.id));
  });

  // A free-time difference settled: { containerId, kind: DEM | DET, use: true (the carrier's days) | false (keep) }.
  app.post("/api/shipments/:id/arrival-notice/free-time", write, async (req, res) => {
    const shipment = await shipmentFor(req, res, { forWrite: true });
    if (!shipment) return;
    const { containerId = "", kind = "", use } = req.body || {};
    if (!["DEM", "DET"].includes(kind) || typeof use !== "boolean") return err(res, "Give containerId, kind (DEM or DET) and use (true or false)");
    const r = await ctx.arrivalNotices.settleFreeTime(shipment.id, { containerId, kind, use }, who(req));
    if (r.error) return err(res, r.error, r.status || 400);
    ok(res, r.arrivalNotice);
  });

  // The chosen charges as BUY accruals: { indices: [n, …] } (each once).
  app.post("/api/shipments/:id/arrival-notice/accruals", write, async (req, res) => {
    const shipment = await shipmentFor(req, res, { forWrite: true });
    if (!shipment) return;
    const indices = Array.isArray(req.body?.indices) ? req.body.indices : [];
    if (!indices.length) return err(res, "Choose the charges to add (indices)");
    const r = await ctx.arrivalNotices.addAccruals(shipment.id, indices, who(req));
    if (r.error) return err(res, r.error, r.status || 400);
    ok(res, { created: r.created, arrivalNotice: r.arrivalNotice }, 201);
  });
};
