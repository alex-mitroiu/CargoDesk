"use strict";

// House B/L as a DCSA transport document (Epic TKT-C7EBU3, ARCHITECTURE.md §8.40; rules in lib/house-bl.js).
//   GET /api/shipments/:id/house-bl                  the House transport documents, newest first, with
//                                                    what blocks issue (readiness) and release (release
//                                                    checks), the loading facts and the package codes
//   GET /api/shipments/:id/house-bl/:tdId/events     a House B/L's history
//   GET /api/shipments/:id/house-bl/:tdId/dcsa       its DCSA TransportDocument: as issued, or built now
//                                                    for a draft, with the eBL 3.0 spec check
//   POST /api/shipments/:id/house-bl/number          the number it is issued under: the shipment's, or
//                                                    the next from the export office's series (G5)
//   POST /api/shipments/:id/house-bl/surrender-for-amendment   { reason } the originals come back to
//                                                    correct it; the next issue is version + 1 (G6)
//   POST /api/shipments/:id/house-bl/originals-handover        { to, method, trackingRef?, count?,
//                                                    handedOverOn?, note? } the originals log (G18)
// Issue, void, surrender for delivery and release stay on the document routes (routes/shipment-ops.js),
// which call lib/house-bl.js. /api/shipments/:id/* is scope-checked app-wide; the writes here are the
// export side's, as BL01 is (DOC_TYPE_SIDE).

module.exports = function houseBlRoutes(app, ctx) {
  const { query, ok, err, auth, requireRole, blockIfWrongSide } = ctx;
  const write = requireRole(["operator", "admin", "occ_bk"]);
  const exportSide = async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) { err(res, "Shipment not found", 404); return null; }
    if (await blockIfWrongSide(req, res, shipment, "export")) return null;
    return shipment;
  };

  const shipmentExists = async id => !!(await query("SELECT 1 FROM shipments WHERE id=$1", [id]))[0];
  const tdOf = async (shipmentId, tdId) =>
    (await query("SELECT * FROM transport_documents WHERE id=$1 AND shipment_id=$2 AND role='HOUSE'", [tdId, shipmentId]))[0] || null;

  // The issuing office and its legal entity, as the print and the panel name them.
  const issuerOf = d => ({
    officeName: d.office?.name || "", unlocode: d.office?.unlocode || "", placeName: d.branch?.city || d.office?.name || "",
    entityName: d.branch?.name || "", scac: d.branch?.scac || "",
  });
  // What issuing it as an eBL needs that's missing, the platforms, and the shipper's ids on them.
  const eblOf = async d => {
    const b = d.branch;
    const entityGaps = !b ? ["a legal entity on the export office"] : [
      !b.scac && "a SCAC", !(b.address && b.city && b.country_code) && "a street address and city", !(b.phone || b.email) && "a phone or email",
    ].filter(Boolean);
    const ids = await ctx.houseBl.identifiersOf(d.s.shipper_id);
    return {
      available: await ctx.dcsaSimulator.allowed(), platforms: ctx.ebl.PLATFORMS, entityName: b?.name || "", entityGaps,
      shipperPlatformIds: ids.filter(i => ctx.ebl.PLATFORMS.includes(String(i.idType || "").toUpperCase()))
        .map(i => ({ platform: String(i.idType).toUpperCase(), code: i.idCode })),
    };
  };

  app.get("/api/shipments/:id/house-bl", auth(), async (req, res) => {
    if (!(await shipmentExists(req.params.id))) return err(res, "Shipment not found", 404);
    const hb = ctx.houseBl;
    const d = await hb.shipmentData(req.params.id);
    const rows = await hb.houseDocs(req.params.id);
    const live = rows.find(r => hb.LIVE.includes(r.status)) || null;
    const draft = rows.find(r => r.status === "DRAFT") || null;
    const amends = live ? null : (draft?.supersedes_id ? rows.find(r => r.id === draft.supersedes_id) : await hb.amendmentOf(req.params.id));
    ok(res, {
      documents: rows.map(hb.mapTransportDocument),
      live: hb.mapTransportDocument(live),
      draft: hb.mapTransportDocument(draft),
      // The version an amendment replaces (G6): the next issue is its version + 1, same number.
      amends: hb.mapTransportDocument(amends || null),
      readiness: live ? null : await hb.readiness(req.params.id, { td: draft || (amends && { reference: amends.reference }) }),
      release: live ? await hb.releaseChecks(req.params.id).then(r => ({ blocks: r.blocks })) : null,
      changedSinceIssue: live ? await hb.changedSinceIssue(live, d) : null,
      onBoard: await hb.onBoardFacts(req.params.id),
      packageCodes: Object.entries(hb.PACKAGE_CODES).map(([code, label]) => ({ code, label })),
      issuer: issuerOf(d),
      ebl: await eblOf(d),
      // What the print needs beyond the shipment (G14, G16): the carriage and the selling charges.
      routing: d.routing,
      charges: d.charges,
      handoverMethods: hb.HANDOVER_METHODS,
    });
  });

  app.get("/api/shipments/:id/house-bl/:tdId/events", auth(), async (req, res) => {
    const td = await tdOf(req.params.id, req.params.tdId);
    if (!td) return err(res, "House B/L not found", 404);
    ok(res, await ctx.houseBl.events(td.id));
  });

  app.post("/api/shipments/:id/house-bl/number", write, async (req, res) => {
    if (!(await exportSide(req, res))) return;
    const r = await ctx.houseBl.assignNumber(req.params.id, req.user);
    if (r.error) return err(res, r.error, r.status || 409);
    ok(res, { number: r.number, source: r.source, assigned: !!r.assigned });
  });

  app.post("/api/shipments/:id/house-bl/surrender-for-amendment", write, async (req, res) => {
    if (!(await exportSide(req, res))) return;
    const r = await ctx.houseBl.surrenderForAmendment(req.params.id, req.user, { reason: req.body?.reason || "" });
    if (r.error) return err(res, r.error, r.status || 409);
    ok(res, ctx.houseBl.mapTransportDocument(r.td));
  });

  app.post("/api/shipments/:id/house-bl/originals-handover", write, async (req, res) => {
    if (!(await exportSide(req, res))) return;
    const r = await ctx.houseBl.recordOriginalsHandover(req.params.id, req.user, req.body || {});
    if (r.error) return err(res, r.error, r.status || 409);
    ok(res, { handover: r.detail }, 201);
  });

  app.get("/api/shipments/:id/house-bl/:tdId/dcsa", auth(), async (req, res) => {
    const td = await tdOf(req.params.id, req.params.tdId);
    if (!td) return err(res, "House B/L not found", 404);
    if (td.payload) return ok(res, { document: JSON.parse(td.payload), errors: td.payload_errors || "", asIssued: true });
    const d = await ctx.houseBl.shipmentData(req.params.id);
    const { doc, errors } = await ctx.houseBl.buildDcsaDocument(td, d);
    ok(res, { document: doc, errors, asIssued: false });
  });
};
