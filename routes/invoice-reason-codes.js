// Invoice status override reason codes (Epic TKT-G11AHW) — admin-maintained registry a Trade
// Manager picks from when overriding an Invoice Collections status. Same dual precedent this
// codebase already uses twice (Pack Types, Duty Rate Chapters): sensible defaults seeded via
// migration, fully editable via Master Data on top. Mirrors routes/pack-types.js's CRUD shape.
module.exports = function invoiceReasonCodeRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, mapInvoiceReasonCode } = ctx;
  const genId = () => `IRC-${uid()}`;
  const write = requireRole(["admin"]);

  app.get("/api/invoice-status-reason-codes", (req, res) => {
    const rows = db.prepare("SELECT * FROM invoice_status_reason_codes ORDER BY label").all();
    ok(res, rows.map(mapInvoiceReasonCode));
  });

  app.post("/api/invoice-status-reason-codes", write, (req, res) => {
    const { code, label, isActive = true } = req.body || {};
    if (!code || !label) return err(res, "Code and label are required");
    const id = genId();
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT INTO invoice_status_reason_codes (id, code, label, is_active, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(id, code.trim().toUpperCase(), label.trim(), isActive ? 1 : 0, now);
      ok(res, mapInvoiceReasonCode({ id, code: code.trim().toUpperCase(), label: label.trim(), is_active: isActive ? 1 : 0, created_at: now }), 201);
    } catch (e) {
      if (e.message?.includes("UNIQUE")) return err(res, `Code ${code} already exists`);
      err(res, e.message, 500);
    }
  });

  app.put("/api/invoice-status-reason-codes/:id", write, (req, res) => {
    const existing = db.prepare("SELECT * FROM invoice_status_reason_codes WHERE id = ?").get(req.params.id);
    if (!existing) return err(res, "Reason code not found", 404);
    const { code, label, isActive = true } = req.body || {};
    if (!code || !label) return err(res, "Code and label are required");
    db.prepare(`UPDATE invoice_status_reason_codes SET code=?, label=?, is_active=? WHERE id=?`)
      .run(code.trim().toUpperCase(), label.trim(), isActive ? 1 : 0, req.params.id);
    ok(res, mapInvoiceReasonCode({ ...existing, code: code.trim().toUpperCase(), label: label.trim(), is_active: isActive ? 1 : 0 }));
  });

  app.delete("/api/invoice-status-reason-codes/:id", write, (req, res) => {
    db.prepare("DELETE FROM invoice_status_reason_codes WHERE id = ?").run(req.params.id);
    ok(res, { ok: true });
  });
};
