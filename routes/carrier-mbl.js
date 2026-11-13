"use strict";

// The carrier's Master B/L as sent to the forwarder (2026-11-10, lib/carrier-mbl.js, ARCHITECTURE.md §8.49): the panel on
// a shipment's Documents page. The carrier's draft review and approval stay on routes/master-bl.js (Shipping Instructions).
//   GET  /api/shipments/:id/master-bl/custody           the panel's view: number, the carrier's issued document, the
//                                                       form, the print and the PDF with its check, the steps
//   PUT  /api/shipments/:id/master-bl/custody           { form?, originalsTotal?, eblPlatform?, eblReference?,
//                                                       eblIssuedTo? } before any step is recorded
//   POST /api/shipments/:id/master-bl/custody/steps     { step, on, count?, from?, to?, courier?, platform?, reference?,
//                                                       issuedTo?, ref?, note? } the next step of the chain
//   POST /api/shipments/:id/master-bl/custody/undo      { reason } the last step, recorded by mistake
//   POST /api/shipments/:id/master-bl/pdf               { data (base64), filename } the carrier's PDF → MB01, read
//   POST /api/shipments/:id/master-bl/pdf/check         { byEye? } read it again / a scan checked by eye
//   POST /api/shipments/:id/master-bl/print             the carrier's issued B/L printed from its data → MB01 (a copy)
// /api/shipments/:id/* is scope-checked app-wide. The steps at origin (received, sent, issued, transferred, surrendered
// at origin) are the export side's, to record and to undo, and so are the PDF, its by-eye check and the print;
// surrendering at destination and the release either side's (the pre-release audit, C1, 2026-11-12).
// On a Completed or Cancelled shipment the PDF, the print, the steps and undo stay open (server.js
// isOpenOnLockedShipment: the carrier's documents are kept for the record, e.g. US retention); the form doesn't.

module.exports = function carrierMblRoutes(app, ctx) {
  const { query, ok, err, auth, requireRole, blockIfWrongSide, renderHtmlToPdf, getActiveSigningCert, signPdfBuffer } = ctx;
  const write = requireRole(["operator", "admin", "occ_bk"]);
  const m = () => ctx.carrierMbl;
  const shipmentOf = async (req, res) => {
    const [s] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!s) { err(res, "Shipment not found", 404); return null; }
    return s;
  };
  const exportSide = async (req, res) => {
    const s = await shipmentOf(req, res);
    if (!s) return null;
    if (await blockIfWrongSide(req, res, s, "export")) return null;
    return s;
  };
  const send = (res, r, status = 200) => (r.error ? err(res, r.error, r.status || 400) : ok(res, r.view, status));

  app.get("/api/shipments/:id/master-bl/custody", auth(), async (req, res) => {
    if (!(await shipmentOf(req, res))) return;
    ok(res, await m().view(req.params.id));
  });

  app.put("/api/shipments/:id/master-bl/custody", write, async (req, res) => {
    if (!(await exportSide(req, res))) return;
    send(res, await m().setup(req.params.id, req.body || {}, req.user));
  });

  app.post("/api/shipments/:id/master-bl/custody/steps", write, async (req, res) => {
    const s = await shipmentOf(req, res);
    if (!s) return;
    const step = String(req.body?.step || "").toUpperCase();
    // At origin it is the export side's; at destination (and the release) either side's.
    const v = await m().view(req.params.id);
    if (m().isOriginStep(step, { stage: v.stage }) && (await blockIfWrongSide(req, res, s, "export"))) return;
    send(res, await m().recordStep(req.params.id, req.body || {}, req.user), 201);
  });

  // Undoing a step follows the side of the step it undoes.
  app.post("/api/shipments/:id/master-bl/custody/undo", write, async (req, res) => {
    const s = await shipmentOf(req, res);
    if (!s) return;
    const last = (await m().view(req.params.id)).events.filter(e => !e.undone).slice(-1)[0];
    if (last?.atOrigin && (await blockIfWrongSide(req, res, s, "export"))) return;
    send(res, await m().undoLast(req.params.id, req.body?.reason, req.user));
  });

  app.post("/api/shipments/:id/master-bl/pdf", write, async (req, res) => {
    if (!(await exportSide(req, res))) return;
    send(res, await m().uploadPdf(req.params.id, req.body || {}, req.user), 201);
  });

  app.post("/api/shipments/:id/master-bl/pdf/check", write, async (req, res) => {
    if (!(await exportSide(req, res))) return;
    send(res, await m().recheckPdf(req.params.id, req.body || {}, req.user));
  });

  app.post("/api/shipments/:id/master-bl/print", write, async (req, res) => {
    if (!(await exportSide(req, res))) return;
    try {
      const r = await m().printCopy(req.params.id, req.user, { renderHtmlToPdf, getActiveSigningCert, signPdfBuffer });
      if (r.error) return err(res, r.error, r.status || 400);
      ok(res, r.view, 201);
    } catch (e) { err(res, `The copy couldn't be printed: ${e.message}`, 502); }
  });
};
