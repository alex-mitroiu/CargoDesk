// Container-type registry (Equipment section) — admin-maintained reference list (20ft Dry,
// 40ft High Cube, ...), seeded with defaults via migration. Same relationship
// pack_type_definitions has to the cargo manifest pack-type dropdown: purely additive
// reference data, nothing else in the app reads from this table yet.
module.exports = function containerTypeRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, mapContainerTypeDefinition } = ctx;
  const genId = () => `CTD-${uid()}`;
  const write = requireRole(["admin", "operator", "trade_manager"]);

  app.get("/api/container-type-definitions", (req, res) => {
    const rows = db.prepare("SELECT * FROM container_type_definitions ORDER BY sort_order, label").all();
    ok(res, rows.map(mapContainerTypeDefinition));
  });

  app.post("/api/container-type-definitions", write, (req, res) => {
    const { code, size, type, teu = 1, label, description = "", sortOrder = 0, isActive = true } = req.body || {};
    if (!code || !size || !type || !label) return err(res, "Code, size, type and label are required");
    const id = genId();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO container_type_definitions (id, code, size, type, teu, label, description, sort_order, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, code.trim(), size.trim(), type.trim(), Number(teu) || 1, label.trim(), description.trim(), Number(sortOrder) || 0, isActive ? 1 : 0, now);
    ok(res, mapContainerTypeDefinition({ id, code: code.trim(), size: size.trim(), type: type.trim(), teu: Number(teu) || 1, label: label.trim(), description: description.trim(), sort_order: Number(sortOrder) || 0, is_active: isActive ? 1 : 0, created_at: now }));
  });

  app.put("/api/container-type-definitions/:id", write, (req, res) => {
    const existing = db.prepare("SELECT * FROM container_type_definitions WHERE id = ?").get(req.params.id);
    if (!existing) return err(res, "Container type definition not found", 404);
    const { code, size, type, teu = 1, label, description = "", sortOrder = 0, isActive = true } = req.body || {};
    if (!code || !size || !type || !label) return err(res, "Code, size, type and label are required");
    db.prepare(`UPDATE container_type_definitions SET code=?, size=?, type=?, teu=?, label=?, description=?, sort_order=?, is_active=? WHERE id=?`)
      .run(code.trim(), size.trim(), type.trim(), Number(teu) || 1, label.trim(), description.trim(), Number(sortOrder) || 0, isActive ? 1 : 0, req.params.id);
    ok(res, mapContainerTypeDefinition({ ...existing, code: code.trim(), size: size.trim(), type: type.trim(), teu: Number(teu) || 1, label: label.trim(), description: description.trim(), sort_order: Number(sortOrder) || 0, is_active: isActive ? 1 : 0 }));
  });

  app.delete("/api/container-type-definitions/:id", write, (req, res) => {
    db.prepare("DELETE FROM container_type_definitions WHERE id = ?").run(req.params.id);
    ok(res, { ok: true });
  });
};
