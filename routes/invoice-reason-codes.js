// Invoice status override reason codes (Epic TKT-G11AHW) — admin-maintained registry a Trade
// Manager picks from when overriding an Invoice Collections status. Same dual precedent this
// codebase already uses twice (Pack Types, Duty Rate Chapters): sensible defaults seeded via
// migration, fully editable via Master Data on top. Mirrors routes/pack-types.js's CRUD shape.
module.exports = function invoiceReasonCodeRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, mapInvoiceReasonCode, isUniqueViolation } = ctx;
  const genId = () => `IRC-${uid()}`;
  const write = requireRole(["admin"]);

  app.get("/api/invoice-status-reason-codes", async (req, res) => {
    const rows = await query("SELECT * FROM invoice_status_reason_codes ORDER BY label");
    ok(res, rows.map(mapInvoiceReasonCode));
  });

  app.post("/api/invoice-status-reason-codes", write, async (req, res) => {
    const { code, label, isActive = true } = req.body || {};
    if (!code || !label) return err(res, "Code and label are required");
    const id = genId();
    const now = new Date().toISOString();
    try {
      await query(`INSERT INTO invoice_status_reason_codes (id, code, label, is_active, created_at)
        VALUES ($1, $2, $3, $4, $5)`,
        [id, code.trim().toUpperCase(), label.trim(), !!isActive, now]);
      ok(res, mapInvoiceReasonCode({ id, code: code.trim().toUpperCase(), label: label.trim(), is_active: !!isActive, created_at: now }), 201);
    } catch (e) {
      if (isUniqueViolation(e)) return err(res, `Code ${code} already exists`);
      err(res, e.message, 500);
    }
  });

  app.put("/api/invoice-status-reason-codes/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM invoice_status_reason_codes WHERE id = $1", [req.params.id]);
    if (!existing) return err(res, "Reason code not found", 404);
    const { code, label, isActive = true } = req.body || {};
    if (!code || !label) return err(res, "Code and label are required");
    try {
      await query(`UPDATE invoice_status_reason_codes SET code=$1, label=$2, is_active=$3 WHERE id=$4`,
        [code.trim().toUpperCase(), label.trim(), !!isActive, req.params.id]);
      ok(res, mapInvoiceReasonCode({ ...existing, code: code.trim().toUpperCase(), label: label.trim(), is_active: !!isActive }));
    } catch (e) {
      if (isUniqueViolation(e)) return err(res, `Code ${code} already exists`);
      err(res, e.message, 500);
    }
  });

  app.delete("/api/invoice-status-reason-codes/:id", write, async (req, res) => {
    await query("DELETE FROM invoice_status_reason_codes WHERE id = $1", [req.params.id]);
    ok(res, { ok: true });
  });
};
