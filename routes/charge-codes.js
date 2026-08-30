// Automated charge-code registry (TKT-OK5H34) — admin-maintained definitions that get
// auto-injected as SELL cost lines when their trigger fires (see generateInvoices() in
// src/utils/invoiceGenerator.js for the only consumer today, trigger='per_container_split').
module.exports = function chargeCodeRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, mapChargeCodeDefinition } = ctx;
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
    await query(`INSERT INTO charge_code_definitions (id, code, label, trigger, amount, currency, unit, is_active, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, code.trim(), label.trim(), trigger, Number(amount), currency.toUpperCase(), unit, !!isActive, now]);
    ok(res, mapChargeCodeDefinition({ id, code: code.trim(), label: label.trim(), trigger, amount: Number(amount), currency: currency.toUpperCase(), unit, is_active: !!isActive, created_at: now }));
  });

  app.put("/api/charge-code-definitions/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM charge_code_definitions WHERE id = $1", [req.params.id]);
    if (!existing) return err(res, "Charge code definition not found", 404);
    const { code, label, trigger = "per_container_split", amount, currency = "USD", unit = "per_container", isActive = true } = req.body || {};
    if (!code || !label || amount == null || Number(amount) <= 0) return err(res, "Code, label, and a positive amount are required");
    await query(`UPDATE charge_code_definitions SET code=$1, label=$2, trigger=$3, amount=$4, currency=$5, unit=$6, is_active=$7 WHERE id=$8`,
      [code.trim(), label.trim(), trigger, Number(amount), currency.toUpperCase(), unit, !!isActive, req.params.id]);
    ok(res, mapChargeCodeDefinition({ ...existing, code: code.trim(), label: label.trim(), trigger, amount: Number(amount), currency: currency.toUpperCase(), unit, is_active: !!isActive }));
  });

  app.delete("/api/charge-code-definitions/:id", write, async (req, res) => {
    await query("DELETE FROM charge_code_definitions WHERE id = $1", [req.params.id]);
    ok(res, { ok: true });
  });
};
