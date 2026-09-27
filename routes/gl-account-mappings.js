"use strict";

// GL Export's Charge Code + Type -> GL Account mapping — Master Data -> Finance. The 3 standing
// control accounts (AR/AP/Unmapped) are NOT here — they're 3 fixed keys on the generic
// GET/PUT /api/settings (see server.js's gl_control_account_* SETTING_DEFAULTS), not worth a
// whole extra table for.

// Same fixed vocabulary charge-default-setups.js's own CHARGE_CODES duplicates from CostLineForm
// — same page-scoped-duplication precedent, so a GL mapping change never risks the unrelated
// Cost Entry modal.
const CHARGE_CODES = ["Ocean Freight", "Origin THC", "Destination THC", "B/L Fee", "Customs", "Inland", "Haulage", "Other"];
const TYPES = ["BUY", "SELL"];

module.exports = function glAccountMappingsRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, mapGlAccountMapping, isUniqueViolation } = ctx;
  const write = requireRole(["admin", "operator", "trade_manager"]);

  app.get("/api/gl-account-mappings", async (req, res) => {
    const rows = await query("SELECT * FROM gl_account_mappings ORDER BY type, charge_code");
    ok(res, rows.map(mapGlAccountMapping));
  });

  app.post("/api/gl-account-mappings", write, async (req, res) => {
    const { chargeCode, type, glAccountCode = "", glAccountName = "" } = req.body || {};
    if (!CHARGE_CODES.includes(chargeCode)) return err(res, `chargeCode must be one of: ${CHARGE_CODES.join(", ")}`);
    if (!TYPES.includes(type)) return err(res, "type must be BUY or SELL");
    if (!glAccountCode.trim()) return err(res, "glAccountCode is required");
    const id = `GAM-${uid()}`;
    const now = new Date().toISOString();
    try {
      await query(
        `INSERT INTO gl_account_mappings (id, charge_code, type, gl_account_code, gl_account_name, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, chargeCode, type, glAccountCode.trim(), glAccountName.trim(), now]);
      const [row] = await query("SELECT * FROM gl_account_mappings WHERE id=$1", [id]);
      ok(res, mapGlAccountMapping(row), 201);
    } catch (e) {
      err(res, isUniqueViolation(e) ? `${chargeCode} (${type}) is already mapped` : e.message);
    }
  });

  app.put("/api/gl-account-mappings/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM gl_account_mappings WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const { glAccountCode, glAccountName } = req.body || {};
    if (glAccountCode != null && !glAccountCode.trim()) return err(res, "glAccountCode is required");
    await query(
      "UPDATE gl_account_mappings SET gl_account_code=$1, gl_account_name=$2, updated_at=$3 WHERE id=$4",
      [glAccountCode != null ? glAccountCode.trim() : existing.gl_account_code,
       glAccountName != null ? glAccountName.trim() : existing.gl_account_name,
       new Date().toISOString(), req.params.id]);
    const [row] = await query("SELECT * FROM gl_account_mappings WHERE id=$1", [req.params.id]);
    ok(res, mapGlAccountMapping(row));
  });

  app.delete("/api/gl-account-mappings/:id", write, async (req, res) => {
    const deleted = await query("DELETE FROM gl_account_mappings WHERE id=$1 RETURNING id", [req.params.id]);
    if (!deleted.length) return err(res, "Not found", 404);
    ok(res, { ok: true });
  });
};
