// Automated charge-code registry (TKT-OK5H34) — admin-maintained definitions that get
// auto-injected as SELL cost lines when their trigger fires (see generateInvoices() in
// src/utils/invoiceGenerator.js for the only consumer today, trigger='per_container_split').
module.exports = function chargeCodeRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, mapChargeCodeDefinition, isUniqueViolation } = ctx;
  const genId = () => `CCD-${uid()}`;
  const write = requireRole(["admin", "operator", "trade_manager"]);

  app.get("/api/charge-code-definitions", async (req, res) => {
    const rows = await query("SELECT * FROM charge_code_definitions ORDER BY code");
    ok(res, rows.map(mapChargeCodeDefinition));
  });

  app.post("/api/charge-code-definitions", write, async (req, res) => {
    const { code, label, trigger = "per_container_split", amount, currency = "USD", unit = "per_container", isActive = true } = req.body || {};
    if (!code || !label || amount == null || Number(amount) <= 0) return err(res, "Code, label, and a positive amount are required");
    const id = genId();
    const now = new Date().toISOString();
    try {
      await query(`INSERT INTO charge_code_definitions (id, code, label, trigger, amount, currency, unit, is_active, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, code.trim(), label.trim(), trigger, Number(amount), currency.toUpperCase(), unit, !!isActive, now]);
      ok(res, mapChargeCodeDefinition({ id, code: code.trim(), label: label.trim(), trigger, amount: Number(amount), currency: currency.toUpperCase(), unit, is_active: !!isActive, created_at: now }));
    } catch (e) {
      err(res, isUniqueViolation(e) ? `Charge code ${code} already exists` : e.message);
    }
  });

  app.put("/api/charge-code-definitions/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM charge_code_definitions WHERE id = $1", [req.params.id]);
    if (!existing) return err(res, "Charge code definition not found", 404);
    const { code, label, trigger = "per_container_split", amount, currency = "USD", unit = "per_container", isActive = true } = req.body || {};
    if (!code || !label || amount == null || Number(amount) <= 0) return err(res, "Code, label, and a positive amount are required");
    try {
      await query(`UPDATE charge_code_definitions SET code=$1, label=$2, trigger=$3, amount=$4, currency=$5, unit=$6, is_active=$7 WHERE id=$8`,
        [code.trim(), label.trim(), trigger, Number(amount), currency.toUpperCase(), unit, !!isActive, req.params.id]);
      ok(res, mapChargeCodeDefinition({ ...existing, code: code.trim(), label: label.trim(), trigger, amount: Number(amount), currency: currency.toUpperCase(), unit, is_active: !!isActive }));
    } catch (e) {
      err(res, isUniqueViolation(e) ? `Charge code ${code} already exists` : e.message);
    }
  });

  app.delete("/api/charge-code-definitions/:id", write, async (req, res) => {
    await query("DELETE FROM charge_code_definitions WHERE id = $1", [req.params.id]);
    ok(res, { ok: true });
  });

  // ─── Charge Code Sides (Office-Side Permissions Epic TKT-Z0LB0W, Phase 1 TKT-AYX4N0) ─────────
  // Classifies a charge_code as Export- or Import-owned for Phase 2's line-level Accounting
  // visibility split — see charge_code_sides' own table comment (lib/schema.js) for why this is
  // its own table keyed by the charge_code STRING, not a column here or an id-based route. That
  // string is exactly why chargeCode is never a URL path segment below (real values like
  // "IMO/DG Surcharge" contain "/", which a path param can't carry) — it travels in the request
  // body or as a query param instead, both properly percent-decoded either way.
  app.get("/api/charge-code-sides", async (req, res) => {
    const rows = await query("SELECT charge_code, side FROM charge_code_sides ORDER BY charge_code");
    ok(res, rows.map(r => ({ chargeCode: r.charge_code, side: r.side })));
  });

  app.post("/api/charge-code-sides", write, async (req, res) => {
    const { chargeCode, side } = req.body || {};
    if (!chargeCode) return err(res, "chargeCode required");
    if (!["Export", "Import"].includes(side)) return err(res, "side must be 'Export' or 'Import'");
    await query(
      `INSERT INTO charge_code_sides (charge_code, side, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (charge_code) DO UPDATE SET side = $2`,
      [chargeCode, side, new Date().toISOString()]);
    ok(res, { chargeCode, side });
  });

  app.delete("/api/charge-code-sides", write, async (req, res) => {
    const chargeCode = req.query.chargeCode;
    if (!chargeCode) return err(res, "chargeCode query param required");
    const deleted = await query("DELETE FROM charge_code_sides WHERE charge_code=$1 RETURNING charge_code", [chargeCode]);
    if (deleted.length === 0) return err(res, "Not found", 404);
    ok(res, { deleted: chargeCode });
  });
};
