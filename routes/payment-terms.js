"use strict";

// The office split on a shipment (2026-11-14, lib/office-split.js, ARCHITECTURE.md §8.52).
//   GET /api/shipments/:id/payment-terms   the payment terms (CPI) per charge category, each with its responsible office
//                                          and billed party, and the shipment's offices to choose from
//   PUT /api/shipments/:id/payment-terms   { reset } | { categories: { <id>: { term PRE|COL, office <key> } } } and/or
//                                          { lines: { <costLineId>: { chargeSide?, responsibleOffice? } } } — the OCC/BK
//                                          of the export side, admins, operators. Saving splits the shipment from then on.
// Locked on a Completed or Cancelled shipment (server.js shipmentStatusLock), like every shipment section.

module.exports = function paymentTermsRoutes(app, ctx) {
  const { ok, err, auth } = ctx;
  const split = () => ctx.officeSplit;

  // payableAt: where the freight is payable for each term, as the booking request names it (invoicePayableAt): the
  // carrier's billing office of that side, else the port of loading (PRE) or discharge (COL) — lib/carrier-offices.js.
  app.get("/api/shipments/:id/payment-terms", auth(), async (req, res) => {
    const v = await split().view(req.params.id);
    if (!v) return err(res, "Shipment not found", 404);
    const { row } = await split().loadShipment(req.params.id);
    const co = ctx.carrierOffices;
    const payableAt = co ? { PRE: await co.payableAt(row, "PRE").catch(() => ""), COL: await co.payableAt(row, "COL").catch(() => "") } : { PRE: "", COL: "" };
    ok(res, { ...v, payableAt, canEdit: !!(await split().mayEdit(req.user, req, row)) });
  });

  app.put("/api/shipments/:id/payment-terms", auth(), async (req, res) => {
    const r = await split().save(req.params.id, req.body || {}, req.user, req);
    if (r.error) return err(res, r.error, r.status || 400);
    ok(res, r.view);
  });
};
