// Container-type registry (Equipment section) — admin-maintained reference list (20ft Dry,
// 40ft High Cube, ...), seeded with defaults via migration. Same relationship
// pack_type_definitions has to the cargo manifest pack-type dropdown: purely additive
// reference data, nothing else in the app reads from this table yet.
module.exports = function containerTypeRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, mapContainerTypeDefinition } = ctx;
  const genId = () => `CTD-${uid()}`;
  const write = requireRole(["admin", "operator", "trade_manager"]);

  app.get("/api/container-type-definitions", async (req, res) => {
    const rows = await query("SELECT * FROM container_type_definitions ORDER BY sort_order, label");
    ok(res, rows.map(mapContainerTypeDefinition));
  });

  app.post("/api/container-type-definitions", write, async (req, res) => {
    const { code, size, type, teu = 1, label, description = "", sortOrder = 0, isActive = true } = req.body || {};
    if (!code || !size || !type || !label) return err(res, "Code, size, type and label are required");
    const id = genId();
    const now = new Date().toISOString();
    await query(`INSERT INTO container_type_definitions (id, code, size, type, teu, label, description, sort_order, is_active, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, code.trim(), size.trim(), type.trim(), Number(teu) || 1, label.trim(), description.trim(), Number(sortOrder) || 0, !!isActive, now]);
    ok(res, mapContainerTypeDefinition({ id, code: code.trim(), size: size.trim(), type: type.trim(), teu: Number(teu) || 1, label: label.trim(), description: description.trim(), sort_order: Number(sortOrder) || 0, is_active: !!isActive, created_at: now }));
  });

  app.put("/api/container-type-definitions/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM container_type_definitions WHERE id = $1", [req.params.id]);
    if (!existing) return err(res, "Container type definition not found", 404);
    const { code, size, type, teu = 1, label, description = "", sortOrder = 0, isActive = true } = req.body || {};
    if (!code || !size || !type || !label) return err(res, "Code, size, type and label are required");
    await query(`UPDATE container_type_definitions SET code=$1, size=$2, type=$3, teu=$4, label=$5, description=$6, sort_order=$7, is_active=$8 WHERE id=$9`,
      [code.trim(), size.trim(), type.trim(), Number(teu) || 1, label.trim(), description.trim(), Number(sortOrder) || 0, !!isActive, req.params.id]);
    ok(res, mapContainerTypeDefinition({ ...existing, code: code.trim(), size: size.trim(), type: type.trim(), teu: Number(teu) || 1, label: label.trim(), description: description.trim(), sort_order: Number(sortOrder) || 0, is_active: !!isActive }));
  });

  app.delete("/api/container-type-definitions/:id", write, async (req, res) => {
    await query("DELETE FROM container_type_definitions WHERE id = $1", [req.params.id]);
    ok(res, { ok: true });
  });
};
