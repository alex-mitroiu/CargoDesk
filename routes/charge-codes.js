// Automated charge-code registry (TKT-OK5H34) — admin-maintained definitions that get
// auto-injected as SELL cost lines when their trigger fires (see generateInvoices() in
// src/utils/invoiceGenerator.js for the only consumer today, trigger='per_container_split').
module.exports = function chargeCodeRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, mapChargeCodeDefinition } = ctx;
  const genId = () => `CCD-${uid()}`;
  const write = requireRole(["admin", "operator", "trade_manager"]);

  app.get("/api/charge-code-definitions", (req, res) => {
    const rows = db.prepare("SELECT * FROM charge_code_definitions ORDER BY code").all();
    ok(res, rows.map(mapChargeCodeDefinition));
  });

  app.post("/api/charge-code-definitions", write, (req, res) => {
    const { code, label, trigger = "per_container_split", amount, currency = "USD", unit = "per_container", isActive = true } = req.body || {};
    if (!code || !label || amount == null || Number(amount) <= 0) return err(res, "Code, label, and a positive amount are required");
    const id = genId();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO charge_code_definitions (id, code, label, trigger, amount, currency, unit, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, code.trim(), label.trim(), trigger, Number(amount), currency.toUpperCase(), unit, isActive ? 1 : 0, now);
    ok(res, mapChargeCodeDefinition({ id, code: code.trim(), label: label.trim(), trigger, amount: Number(amount), currency: currency.toUpperCase(), unit, is_active: isActive ? 1 : 0, created_at: now }));
  });

  app.put("/api/charge-code-definitions/:id", write, (req, res) => {
    const existing = db.prepare("SELECT * FROM charge_code_definitions WHERE id = ?").get(req.params.id);
    if (!existing) return err(res, "Charge code definition not found", 404);
    const { code, label, trigger = "per_container_split", amount, currency = "USD", unit = "per_container", isActive = true } = req.body || {};
    if (!code || !label || amount == null || Number(amount) <= 0) return err(res, "Code, label, and a positive amount are required");
    db.prepare(`UPDATE charge_code_definitions SET code=?, label=?, trigger=?, amount=?, currency=?, unit=?, is_active=? WHERE id=?`)
      .run(code.trim(), label.trim(), trigger, Number(amount), currency.toUpperCase(), unit, isActive ? 1 : 0, req.params.id);
    ok(res, mapChargeCodeDefinition({ ...existing, code: code.trim(), label: label.trim(), trigger, amount: Number(amount), currency: currency.toUpperCase(), unit, is_active: isActive ? 1 : 0 }));
  });

  app.delete("/api/charge-code-definitions/:id", write, (req, res) => {
    db.prepare("DELETE FROM charge_code_definitions WHERE id = ?").run(req.params.id);
    ok(res, { ok: true });
  });
};
