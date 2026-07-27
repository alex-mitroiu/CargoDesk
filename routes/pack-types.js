// Pack-type registry for the container cargo manifest tree (container_packages.pack_type_id) —
// admin-maintained reference list (Pallet, Carton, Box, ...), seeded with defaults via migration.
// Nothing else in the app enforces this list; it's read-only reference data for the pack-type
// dropdown, same relationship SERVICE_TYPE_ICON has to service types.
module.exports = function packTypeRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, mapPackTypeDefinition } = ctx;
  const genId = () => `PTD-${uid()}`;
  const write = requireRole(["admin", "operator", "trade_manager"]);

  app.get("/api/pack-type-definitions", (req, res) => {
    const rows = db.prepare("SELECT * FROM pack_type_definitions ORDER BY sort_order, label").all();
    ok(res, rows.map(mapPackTypeDefinition));
  });

  app.post("/api/pack-type-definitions", write, (req, res) => {
    const { code, label, icon = "📦", sortOrder = 0, isActive = true } = req.body || {};
    if (!code || !label) return err(res, "Code and label are required");
    const id = genId();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO pack_type_definitions (id, code, label, icon, sort_order, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, code.trim(), label.trim(), icon, Number(sortOrder) || 0, isActive ? 1 : 0, now);
    ok(res, mapPackTypeDefinition({ id, code: code.trim(), label: label.trim(), icon, sort_order: Number(sortOrder) || 0, is_active: isActive ? 1 : 0, created_at: now }));
  });

  app.put("/api/pack-type-definitions/:id", write, (req, res) => {
    const existing = db.prepare("SELECT * FROM pack_type_definitions WHERE id = ?").get(req.params.id);
    if (!existing) return err(res, "Pack type definition not found", 404);
    const { code, label, icon = "📦", sortOrder = 0, isActive = true } = req.body || {};
    if (!code || !label) return err(res, "Code and label are required");
    db.prepare(`UPDATE pack_type_definitions SET code=?, label=?, icon=?, sort_order=?, is_active=? WHERE id=?`)
      .run(code.trim(), label.trim(), icon, Number(sortOrder) || 0, isActive ? 1 : 0, req.params.id);
    ok(res, mapPackTypeDefinition({ ...existing, code: code.trim(), label: label.trim(), icon, sort_order: Number(sortOrder) || 0, is_active: isActive ? 1 : 0 }));
  });

  app.delete("/api/pack-type-definitions/:id", write, (req, res) => {
    db.prepare("DELETE FROM pack_type_definitions WHERE id = ?").run(req.params.id);
    ok(res, { ok: true });
  });
};
