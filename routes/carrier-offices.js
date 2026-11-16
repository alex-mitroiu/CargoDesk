"use strict";

// Carrier offices (2026-11-16, ARCHITECTURE.md §8.53): the carrier's profile on Master Data → Carriers, and a
// shipment's carrier offices. Routes only: the rules are lib/carrier-offices.js (ctx.carrierOffices).
//
// The profile is written by admins and operators, as the Carrier Agents were. A shipment's offices are picked by its
// export side for the booking office and origin billing, and by its import side for the import office and destination
// billing (canEditOfficeSide, as the Line Agent parties were gated).
module.exports = function carrierOfficeRoutes(app, ctx) {
  const { ok, err, auth, requireRole, canEditOfficeSide, carrierOffices: co, query, sanctionsMap, screenShipmentById } = ctx;
  const write = requireRole(["admin", "operator"]);
  const shipmentWrite = requireRole(["admin", "operator", "occ_bk"]);
  const actorOf = req => req.user?.name || req.user?.email || "";
  const send = (res, r, created = false) => (r?.error ? err(res, r.error, r.status || 400) : ok(res, r, created ? 201 : 200));

  // ─── The profile ──────────────────────────────────────────────────────────
  app.get("/api/carriers/:code/profile", auth(), async (req, res) => ok(res, await co.profile(req.params.code)));
  // The four offices the coverage gives for a port of loading and discharge (the profile's live check).
  app.get("/api/carriers/:code/coverage-check", auth(), async (req, res) => {
    const pol = String(req.query.pol || "").toUpperCase(), pod = String(req.query.pod || "").toUpperCase();
    ok(res, await co.check(req.params.code, { pol, pod }));
  });
  // An office list for pickers (Freight Audit, the shipment's tiles). ?carrierCode= (required), ?active=1.
  app.get("/api/carrier-offices", auth(), async (req, res) => {
    if (!req.query.carrierCode) return err(res, "carrierCode required");
    ok(res, await co.officesOf(req.query.carrierCode, { activeOnly: req.query.active === "1" }));
  });
  app.post("/api/carriers/:code/offices", write, async (req, res) => {
    const r = await co.createOffice(req.params.code, req.body || {}, actorOf(req));
    return r.error ? err(res, r.error, r.status || 400) : ok(res, r.office, 201);
  });
  app.put("/api/carrier-offices/:id", write, async (req, res) => {
    const r = await co.updateOffice(req.params.id, req.body || {}, actorOf(req));
    return r.error ? err(res, r.error, r.status || 400) : ok(res, r.office);
  });
  app.delete("/api/carrier-offices/:id", write, async (req, res) => send(res, await co.removeOffice(req.params.id, actorOf(req))));
  app.post("/api/carriers/:code/coverage", write, async (req, res) => {
    const r = await co.addCoverage(req.params.code, req.body || {}, actorOf(req));
    return r.error ? err(res, r.error, r.status || 400) : ok(res, r.coverage, 201);
  });
  app.put("/api/carrier-coverage/:id", write, async (req, res) => {
    const r = await co.updateCoverage(req.params.id, req.body || {}, actorOf(req));
    return r.error ? err(res, r.error, r.status || 400) : ok(res, r.coverage);
  });
  app.delete("/api/carrier-coverage/:id", write, async (req, res) => send(res, await co.removeCoverage(req.params.id, actorOf(req))));
  app.put("/api/carriers/:code/account-numbers", write, async (req, res) => send(res, await co.saveAccountNumbers(req.params.code, req.body || {}, actorOf(req))));

  // ─── A shipment's carrier offices ───────────────────────────────────────────
  // Its carrier offices are screened by name (as the Line Agent parties were), so a change re-screens it, keeping a
  // compliance officer's override (routes/shipments.js maybeRescreen).
  const rescreen = async shipmentId => {
    if (!sanctionsMap || sanctionsMap.size === 0) return;
    const [prev] = await query("SELECT result, overridden_at FROM shipment_screenings WHERE shipment_id=$1", [shipmentId]);
    if (!(prev?.result === "CLEAR" && prev?.overridden_at)) await screenShipmentById(shipmentId).catch(() => {});
  };
  app.get("/api/shipments/:id/carrier-offices", auth(), async (req, res) => {
    const v = await co.view(req.params.id);
    return v ? ok(res, v) : err(res, "Not found", 404);
  });
  // { officeId } picks another office of the shipment's carrier (null = none); { fromCoverage: true } picks it again
  // from the coverage.
  app.put("/api/shipments/:id/carrier-offices/:role", shipmentWrite, async (req, res) => {
    const spec = co.SHIPMENT_ROLES[req.params.role];
    if (!spec) return err(res, "Unknown carrier office role");
    if (!(await canEditOfficeSide(req, spec.side)))
      return err(res, `Only ${spec.side.toLowerCase()}-side users can change the ${spec.label.toLowerCase()}`, 403);
    const r = await co.pick(req.params.id, req.params.role, req.body || {}, actorOf(req));
    if (r.error) return err(res, r.error, r.status || 400);
    await rescreen(req.params.id);
    ok(res, r.view);
  });
};
