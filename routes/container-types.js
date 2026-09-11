// Container-type registry (Equipment section) — admin-maintained reference list (20ft Dry,
// 40ft High Cube, ...), seeded with defaults via migration. Its own `teu` column is the real
// source of truth for every TEU calculation in the app (server.js's TEU_EXPR, joined on
// size+type) — falls back to the standard 20ft=1/40ft=2 rule for any type with no matching,
// active row here (2026-09 Space Configuration spec, gap #8 — this used to be pure display data
// with zero effect on anything).
module.exports = function containerTypeRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, mapContainerTypeDefinition } = ctx;
  const genId = () => `CTD-${uid()}`;
  const write = requireRole(["admin", "operator", "trade_manager"]);

  // Bug fix (found live via exploratory QA, 2026-09): the `teu` column is INTEGER (schema.js) but
  // neither write route validated that — `Number(teu) || 1` happily passed a fractional value
  // (e.g. 1.5, or 2.25 for a real-world 45ft container) straight to Postgres, which then rejected
  // the INSERT/UPDATE with a raw, unhandled error (a 500, not a clean validation message).
  // Fractional TEU support itself (45ft containers are conventionally 2.25 TEU) would be a real
  // schema/display change of its own — out of scope here; this only turns the crash into a clean
  // 400 matching the column's actual (whole-number) constraint.
  const parseTeu = teu => {
    const n = Number(teu);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  app.get("/api/container-type-definitions", async (req, res) => {
    const rows = await query("SELECT * FROM container_type_definitions ORDER BY sort_order, label");
    ok(res, rows.map(mapContainerTypeDefinition));
  });

  app.post("/api/container-type-definitions", write, async (req, res) => {
    const { code, size, type, teu = 1, label, description = "", sortOrder = 0, isActive = true } = req.body || {};
    if (!code || !size || !type || !label) return err(res, "Code, size, type and label are required");
    const teuVal = parseTeu(teu);
    if (teuVal === null) return err(res, "teu must be a positive whole number");
    const id = genId();
    const now = new Date().toISOString();
    await query(`INSERT INTO container_type_definitions (id, code, size, type, teu, label, description, sort_order, is_active, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, code.trim(), size.trim(), type.trim(), teuVal, label.trim(), description.trim(), Number(sortOrder) || 0, !!isActive, now]);
    ok(res, mapContainerTypeDefinition({ id, code: code.trim(), size: size.trim(), type: type.trim(), teu: teuVal, label: label.trim(), description: description.trim(), sort_order: Number(sortOrder) || 0, is_active: !!isActive, created_at: now }));
  });

  app.put("/api/container-type-definitions/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM container_type_definitions WHERE id = $1", [req.params.id]);
    if (!existing) return err(res, "Container type definition not found", 404);
    const { code, size, type, teu = 1, label, description = "", sortOrder = 0, isActive = true } = req.body || {};
    if (!code || !size || !type || !label) return err(res, "Code, size, type and label are required");
    const teuVal = parseTeu(teu);
    if (teuVal === null) return err(res, "teu must be a positive whole number");
    await query(`UPDATE container_type_definitions SET code=$1, size=$2, type=$3, teu=$4, label=$5, description=$6, sort_order=$7, is_active=$8 WHERE id=$9`,
      [code.trim(), size.trim(), type.trim(), teuVal, label.trim(), description.trim(), Number(sortOrder) || 0, !!isActive, req.params.id]);
    ok(res, mapContainerTypeDefinition({ ...existing, code: code.trim(), size: size.trim(), type: type.trim(), teu: teuVal, label: label.trim(), description: description.trim(), sort_order: Number(sortOrder) || 0, is_active: !!isActive }));
  });

  app.delete("/api/container-type-definitions/:id", write, async (req, res) => {
    await query("DELETE FROM container_type_definitions WHERE id = $1", [req.params.id]);
    ok(res, { ok: true });
  });
};
