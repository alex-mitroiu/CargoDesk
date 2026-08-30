// Pack-type registry for the container cargo manifest tree (container_packages.pack_type_id) —
// admin-maintained reference list (Pallet, Carton, Box, ...), seeded with defaults via migration.
// Nothing else in the app enforces this list; it's read-only reference data for the pack-type
// dropdown, same relationship SERVICE_TYPE_ICON has to service types.
module.exports = function packTypeRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, mapPackTypeDefinition } = ctx;
  const genId = () => `PTD-${uid()}`;
  const write = requireRole(["admin", "operator", "trade_manager"]);

  app.get("/api/pack-type-definitions", async (req, res) => {
    const rows = await query("SELECT * FROM pack_type_definitions ORDER BY sort_order, label");
    ok(res, rows.map(mapPackTypeDefinition));
  });

  app.post("/api/pack-type-definitions", write, async (req, res) => {
    const { code, label, icon = "📦", sortOrder = 0, isActive = true } = req.body || {};
    if (!code || !label) return err(res, "Code and label are required");
    const id = genId();
    const now = new Date().toISOString();
    await query(`INSERT INTO pack_type_definitions (id, code, label, icon, sort_order, is_active, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, code.trim(), label.trim(), icon, Number(sortOrder) || 0, !!isActive, now]);
    ok(res, mapPackTypeDefinition({ id, code: code.trim(), label: label.trim(), icon, sort_order: Number(sortOrder) || 0, is_active: !!isActive, created_at: now }));
  });

  app.put("/api/pack-type-definitions/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM pack_type_definitions WHERE id = $1", [req.params.id]);
    if (!existing) return err(res, "Pack type definition not found", 404);
    const { code, label, icon = "📦", sortOrder = 0, isActive = true } = req.body || {};
    if (!code || !label) return err(res, "Code and label are required");
    await query(`UPDATE pack_type_definitions SET code=$1, label=$2, icon=$3, sort_order=$4, is_active=$5 WHERE id=$6`,
      [code.trim(), label.trim(), icon, Number(sortOrder) || 0, !!isActive, req.params.id]);
    ok(res, mapPackTypeDefinition({ ...existing, code: code.trim(), label: label.trim(), icon, sort_order: Number(sortOrder) || 0, is_active: !!isActive }));
  });

  app.delete("/api/pack-type-definitions/:id", write, async (req, res) => {
    await query("DELETE FROM pack_type_definitions WHERE id = $1", [req.params.id]);
    ok(res, { ok: true });
  });
};
