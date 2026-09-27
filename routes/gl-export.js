"use strict";

// GL Export — runs lib/gl-export.js's engine over a date range and hands back a downloadable
// CSV plus a batch record for the run-history list. Financials -> GL Export.

module.exports = function glExportRoutes(app, ctx) {
  const { ok, err, requireRole, runGlExport, query, mapGlExportBatch } = ctx;
  // GL posting is a controller/finance-level action, not an everyday ops one — matches the
  // Reports tab's own finance-gated tabs rather than Freight Audit's "every role" openness.
  const write = requireRole(["admin", "operator"]);

  app.get("/api/gl-export/batches", async (req, res) => {
    const rows = await query("SELECT * FROM gl_export_batches ORDER BY created_at DESC LIMIT 50");
    ok(res, rows.map(mapGlExportBatch));
  });

  app.post("/api/gl-export/run", write, async (req, res) => {
    const { dateFrom, dateTo } = req.body || {};
    if (!dateFrom || !dateTo) return err(res, "dateFrom and dateTo are required (YYYY-MM-DD)");
    if (dateFrom > dateTo) return err(res, "dateFrom must be on or before dateTo");
    const result = await runGlExport({ dateFrom, dateTo, user: req.user?.name || req.user?.email || "" });
    ok(res, result, 201);
  });
};
