"use strict";
// ─── Haulage stops on a Pickup or Delivery service (2026-11-20, ARCHITECTURE.md §8.56) ────────────────────────────────
// The routes; the rules are lib/haulage-stops.js (ctx.haulage). Everything is nested under the owning shipment's :shipmentId,
// so shipmentScopeParamCheck and the Completed/Cancelled lock apply (CLAUDE.md). Writes are the service side's
// (blockIfWrongSide), as every other service route. Each write answers with the whole plan, so the page's checks are fresh.

module.exports = function haulageStopsRoutes(app, ctx) {
  const { query, ok, err, auth, requireRole, blockIfWrongSide, logEvent } = ctx;
  const shipmentWrite = requireRole(["admin", "operator", "occ_bk"]);
  const actor = req => req.user?.name || req.user?.email || "";
  const base = "/api/shipments/:shipmentId/services/:serviceId";

  // The service, the shipment and the side check. → service row, or null (answered).
  async function serviceFor(req, res, write = false) {
    const [service] = await query("SELECT * FROM shipment_services WHERE id=$1 AND shipment_id=$2", [req.params.serviceId, req.params.shipmentId]);
    if (!service) { err(res, "Service not found", 404); return null; }
    // A service left behind by a shipment deleted before 2026-11-21 (audit A4) isn't anyone's to read or change.
    const [owner] = await query("SELECT 1 FROM shipments WHERE id=$1", [req.params.shipmentId]);
    if (!owner) { err(res, "Shipment not found", 404); return null; }
    if (!["Pickup", "Delivery"].includes(service.service_type)) { err(res, "Stops belong to a Pickup or Delivery service", 400); return null; }
    if (write) {
      const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.shipmentId]);
      if (await blockIfWrongSide(req, res, shipment, service.side.toLowerCase())) return null;
    }
    return service;
  }
  const answer = async (req, res, r, status = 200) => {
    if (r?.error) return err(res, r.error, r.status || 400);
    ok(res, await ctx.haulage.planFor(req.params.shipmentId, req.params.serviceId), status);
  };
  const purposeLabel = key => ctx.haulage.PURPOSES.find(p => p.key === String(key || "").toUpperCase())?.label || String(key || "");
  const history = (req, service, what, detail) =>
    logEvent(req.params.shipmentId, "HAULAGE_PLAN_UPDATED", what, null, detail, JSON.stringify({ serviceId: service.id, serviceType: service.service_type }), actor(req));

  app.get(`${base}/haulage-plan`, auth(), async (req, res) => {
    const service = await serviceFor(req, res);
    if (!service) return;
    ok(res, await ctx.haulage.planFor(req.params.shipmentId, req.params.serviceId));
  });

  // Literal paths before /haulage-stops/:stopId (CLAUDE.md).
  app.post(`${base}/haulage-stops/usual`, shipmentWrite, async (req, res) => {
    const service = await serviceFor(req, res, true);
    if (!service) return;
    const r = await ctx.haulage.addUsualStops(service);
    if (!r.error) await history(req, service, "stops", "the usual stops");
    await answer(req, res, r, 201);
  });

  app.post(`${base}/haulage-stops/order`, shipmentWrite, async (req, res) => {
    const service = await serviceFor(req, res, true);
    if (!service) return;
    await answer(req, res, await ctx.haulage.reorder(service, req.body?.containerId || null, Array.isArray(req.body?.ids) ? req.body.ids : []));
  });

  app.post(`${base}/haulage-stops`, shipmentWrite, async (req, res) => {
    const service = await serviceFor(req, res, true);
    if (!service) return;
    const r = await ctx.haulage.addStop(service, req.body || {});
    if (!r.error) await history(req, service, "stop added", purposeLabel(req.body?.purpose || "OTHER"));
    await answer(req, res, r, 201);
  });

  app.put(`${base}/haulage-stops/:stopId`, shipmentWrite, async (req, res) => {
    const service = await serviceFor(req, res, true);
    if (!service) return;
    const r = await ctx.haulage.updateStop(service, req.params.stopId, req.body || {});
    if (!r.error) await history(req, service, "stop changed", purposeLabel(req.body?.purpose));
    await answer(req, res, r);
  });

  app.delete(`${base}/haulage-stops/:stopId`, shipmentWrite, async (req, res) => {
    const service = await serviceFor(req, res, true);
    if (!service) return;
    const r = await ctx.haulage.removeStop(service, req.params.stopId);
    if (!r.error) await history(req, service, "stop removed", [purposeLabel(r.purpose), r.placeName].filter(Boolean).join(" · "));
    await answer(req, res, r);
  });

  app.put(`${base}/haulage-times/:containerId/:stopId`, shipmentWrite, async (req, res) => {
    const service = await serviceFor(req, res, true);
    if (!service) return;
    await answer(req, res, await ctx.haulage.setTimes(service, req.params.containerId, req.params.stopId, req.body || {}));
  });

  app.post(`${base}/haulage/:containerId/own-stops`, shipmentWrite, async (req, res) => {
    const service = await serviceFor(req, res, true);
    if (!service) return;
    const own = req.body?.own !== false;
    const r = await ctx.haulage.setOwnStops(service, req.params.containerId, own);
    if (!r.error) await history(req, service, own ? "own stops" : "shared stops", req.params.containerId);
    await answer(req, res, r);
  });
};
