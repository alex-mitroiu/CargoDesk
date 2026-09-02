// Document Template Editor (free-form canvas, scoped by office/carrier) — BL01 pilot only.
// Read-only, opaque-to-the-server: this route just stores/looks up a saved field layout
// (JSON) — the actual HTML rendering happens client-side (src/utils/templateRenderer.js),
// exactly like every hardcoded document builder already does. No PDF/rendering/signing
// changes anywhere — GenerateDocumentModal.jsx is the only existing file that calls this.
module.exports = function documentTemplateRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, mapDocumentTemplate } = ctx;
  const genId = () => `DTPL-${uid()}`;
  const write = requireRole(["admin", "operator", "trade_manager"]);

  const TEMPLATE_JOIN = `
    SELECT t.*, o.code AS office_code, o.name AS office_name
    FROM   document_templates t
    LEFT   JOIN offices o ON o.id = t.office_id
  `;

  app.get("/api/document-templates", write, async (req, res) => {
    const rows = await query(`${TEMPLATE_JOIN} ORDER BY t.doc_type, t.created_at DESC`);
    ok(res, rows.map(mapDocumentTemplate));
  });

  // The actual lookup GenerateDocumentModal.jsx calls before falling back to the hardcoded
  // builder — mirrors milestone_templates' own 3-tier cascading fallback (routes/shipment-ops.js,
  // POST /api/shipments/:id/milestones/init): exact office+carrier -> office-only ->
  // generic (no office, no carrier) -> none found. Public (auth() only, no write gate) since
  // every document-generating user needs this, not just admins. Registered BEFORE /:id —
  // Express matches route registration order, and /:id would otherwise greedily capture
  // "resolve" as a literal id (a real bug caught by this file's own test).
  app.get("/api/document-templates/resolve", async (req, res) => {
    const { docType, officeId, carrierCode } = req.query;
    if (!docType) return err(res, "docType is required");
    let row = null;
    if (officeId && carrierCode) {
      [row] = await query(`${TEMPLATE_JOIN} WHERE t.doc_type=$1 AND t.office_id=$2 AND t.carrier_code=$3 AND t.is_active=TRUE`, [docType, officeId, carrierCode]);
    }
    if (!row && officeId) {
      [row] = await query(`${TEMPLATE_JOIN} WHERE t.doc_type=$1 AND t.office_id=$2 AND t.carrier_code IS NULL AND t.is_active=TRUE`, [docType, officeId]);
    }
    if (!row) {
      [row] = await query(`${TEMPLATE_JOIN} WHERE t.doc_type=$1 AND t.office_id IS NULL AND t.carrier_code IS NULL AND t.is_active=TRUE`, [docType]);
    }
    ok(res, row ? mapDocumentTemplate(row) : null);
  });

  app.get("/api/document-templates/:id", write, async (req, res) => {
    const [row] = await query(`${TEMPLATE_JOIN} WHERE t.id = $1`, [req.params.id]);
    if (!row) return err(res, "Template not found", 404);
    ok(res, mapDocumentTemplate(row));
  });

  app.post("/api/document-templates", write, async (req, res) => {
    const { docType, officeId = null, carrierCode = null, name, pageSize = "A4", fields = [] } = req.body || {};
    if (!docType) return err(res, "docType is required");
    if (!name || !name.trim()) return err(res, "name is required");
    const [dup] = await query(
      `SELECT id FROM document_templates WHERE doc_type=$1
       AND office_id IS NOT DISTINCT FROM $2 AND carrier_code IS NOT DISTINCT FROM $3`,
      [docType, officeId, carrierCode]
    );
    if (dup) return err(res, "A template already exists for this document type, office, and carrier combination — edit it instead of creating a duplicate");

    const id = genId();
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    await query(
      `INSERT INTO document_templates (id, doc_type, office_id, carrier_code, name, page_size, fields, is_active, created_at, updated_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$8,$9)`,
      [id, docType, officeId, carrierCode, name.trim(), pageSize, JSON.stringify(fields), now, actor]
    );
    const [row] = await query(`${TEMPLATE_JOIN} WHERE t.id=$1`, [id]);
    ok(res, mapDocumentTemplate(row));
  });

  app.put("/api/document-templates/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM document_templates WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Template not found", 404);
    const {
      name = existing.name, pageSize = existing.page_size, fields = JSON.parse(existing.fields),
      isActive = existing.is_active,
    } = req.body || {};
    if (!name || !name.trim()) return err(res, "name is required");
    const now = new Date().toISOString();
    await query(
      `UPDATE document_templates SET name=$1, page_size=$2, fields=$3, is_active=$4, updated_at=$5 WHERE id=$6`,
      [name.trim(), pageSize, JSON.stringify(fields), !!isActive, now, req.params.id]
    );
    const [row] = await query(`${TEMPLATE_JOIN} WHERE t.id=$1`, [req.params.id]);
    ok(res, mapDocumentTemplate(row));
  });

  app.delete("/api/document-templates/:id", write, async (req, res) => {
    await query("DELETE FROM document_templates WHERE id=$1", [req.params.id]);
    ok(res, { ok: true });
  });
};
