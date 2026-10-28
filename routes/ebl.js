"use strict";

// The House B/L as an eBL (Epic TKT-C7EBU3, gap G24; rules in lib/ebl.js, the platform in
// lib/ebl-platform-simulator.js):
//   POST /api/shipments/:id/house-bl/issue-ebl          send the issued House B/L to an eBL platform
//                                                       { platform = "WAVE", partyName?, partyCode? }
//   POST /api/ebl/v3/ebl-issuance-responses             the platform's ISSU / BREQ / REFU (no JWT:
//   POST /api/ebl/v3/ebl-surrender-requests             the platform's SREQ / AREQ   the platform credential)
//   GET  /api/test-tools/ebl-sim/documents              Test Tools: what the built-in platform holds
//   POST /api/test-tools/ebl-sim/documents/:ref/:action Test Tools: ISSU|BREQ|REFU, endorse, SREQ|AREQ

module.exports = function eblRoutes(app, ctx) {
  const { query, ok, err, requireRole, blockIfWrongSide, dcsaSimulator, eblPlatform } = ctx;
  const write = requireRole(["operator", "admin", "occ_bk"]);

  ctx.ebl.registerRoutes(app);
  eblPlatform.registerRoutes(app);

  app.post("/api/shipments/:id/house-bl/issue-ebl", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    // The House B/L is issued by the export side (DOC_TYPE_SIDE: BL01 → export).
    if (await blockIfWrongSide(req, res, shipment, "export")) return;
    const { platform = "WAVE", partyName = "", partyCode = "" } = req.body || {};
    const r = await ctx.ebl.issue(req.params.id, req.user, { platform, partyName, partyCode });
    if (r.error) return err(res, r.error, r.status || 409);
    ok(res, ctx.houseBl.mapTransportDocument(r.td));
  });

  const simOn = async res => {
    if (await dcsaSimulator.allowed()) return true;
    err(res, "The built-in eBL platform is off (App Settings → Demo carrier)", 409);
    return false;
  };
  app.get("/api/test-tools/ebl-sim/documents", write, async (req, res) => {
    if (!(await simOn(res))) return;
    // Each with the CargoDesk shipment its House B/L belongs to (null once that is gone).
    const docs = await eblPlatform.list();
    const refs = [...new Set(docs.map(d => d.transportDocumentReference))];
    const rows = refs.length ? await query(`SELECT reference, shipment_id FROM transport_documents WHERE role='HOUSE'
      AND reference IN (${refs.map((_, i) => `$${i + 1}`).join(",")})`, refs) : [];
    const shipmentOf = new Map(rows.map(r => [r.reference, r.shipment_id]));
    ok(res, docs.map(d => ({ ...d, shipmentId: shipmentOf.get(d.transportDocumentReference) || null })));
  });
  app.post("/api/test-tools/ebl-sim/documents/:ref/:action", write, async (req, res) => {
    if (!(await simOn(res))) return;
    const r = await eblPlatform.act(req.params.ref, req.params.action, req.body || {});
    if (!r.ok) return err(res, r.error, r.status || 400);
    if (r.delivery && !r.delivery.delivered)
      return err(res, `The platform acted, but CargoDesk didn't accept its message (${r.delivery.status}: ${r.delivery.body?.error || r.delivery.error || "no answer"})`, 502);
    ok(res, r);
  });
};
