"use strict";

// A shipment as one JSON file for QA, and imported into a test system (2026-11-13, lib/shipment-transfer.js,
// ARCHITECTURE.md §8.50). Admins only, both ways.
//   GET  /api/shipments/:id/qa-export          what the file will hold: parts with counts, files, the records it
//                                              points at, an estimated size (the export dialog)
//   POST /api/shipments/:id/qa-export          { whatWentWrong?, steps? (text, one per line, or a list) } → the file
//                                              (attachment); recorded in the admin log
//   GET  /api/shipment-import/status           { production, allowed } (Test Tools → Shipment Import)
//   POST /api/shipment-import/preview          { file, officeMap? } → { problems, plan } without saving anything
//   POST /api/shipment-import                  { file, officeMap? { export, import } } → 201 { shipmentId, from,
//                                              createdCustomers, dropped, warnings } | 409 { error, problems, plan }
// /api/shipment-import has its own body limit (server.js): a file carries its documents.

module.exports = function shipmentTransferRoutes(app, ctx) {
  const { ok, err, requireRole } = ctx;
  const adminOnly = requireRole(["admin"]);
  const t = () => ctx.shipmentTransfer;

  app.get("/api/shipments/:id/qa-export", adminOnly, async (req, res) => {
    const c = await t().contents(req.params.id);
    if (!c) return err(res, "Shipment not found", 404);
    ok(res, c);
  });

  app.post("/api/shipments/:id/qa-export", adminOnly, async (req, res) => {
    const r = await t().exportShipment(req.params.id, req.user, {
      whatWentWrong: req.body?.whatWentWrong, steps: req.body?.steps, host: req.get("host") || "" });
    if (r.error) return err(res, r.error, r.status || 400);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${r.filename}"`);
    res.status(200).send(JSON.stringify(r.file, null, 1));
  });

  const gate = async (req, res) => {
    if (await t().importAllowed()) return true;
    err(res, "This server runs in production mode, where shipment imports are off: an admin turns them on under App Settings → Shipment imports", 403);
    return false;
  };

  app.get("/api/shipment-import/status", adminOnly, async (req, res) =>
    ok(res, { production: process.env.NODE_ENV === "production", allowed: await t().importAllowed() }));

  app.post("/api/shipment-import/preview", adminOnly, async (req, res) => {
    if (!(await gate(req, res))) return;
    ok(res, await t().plan(req.body?.file, { officeMap: req.body?.officeMap || {} }));
  });

  app.post("/api/shipment-import", adminOnly, async (req, res) => {
    if (!(await gate(req, res))) return;
    const r = await t().importShipment(req.body?.file, { officeMap: req.body?.officeMap || {} }, req.user);
    if (r.error) return res.status(r.status || 400).json({ error: r.error, ...(r.problems && { problems: r.problems }), ...(r.plan && { plan: r.plan }) });
    ok(res, r, 201);
  });
};
