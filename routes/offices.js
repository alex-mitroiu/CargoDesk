"use strict";

module.exports = function officesRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, mapOffice, isUniqueViolation } = ctx;
  const adminOnly = requireRole(["admin"]);

  // ── Offices CRUD ────────────────────────────────────────────────────────────

  app.get("/api/offices", async (req, res) => {
    const rows = await query(`
      SELECT o.*, u.name AS manager_name, u.email AS manager_email
      FROM offices o LEFT JOIN users u ON u.id = o.manager_user_id
      ORDER BY o.code
    `);
    ok(res, rows.map(r => mapOffice({ ...r, manager_name: r.manager_name || r.manager_email || null })));
  });

  app.post("/api/offices", adminOnly, async (req, res) => {
    const { unlocode = '', department = 'SE', name = '', countryCode = '', branchId = null } = req.body || {};
    if (!unlocode || !department || !name) return err(res, "unlocode, department, and name are required");
    const country = (countryCode || unlocode.slice(0, 2)).toUpperCase();
    const un = unlocode.toUpperCase();
    const dept = department.toUpperCase();
    if (!['SE', 'SI'].includes(dept)) return err(res, "department must be SE or SI");
    const code = `${country}-${un}-${dept}`;
    const id = `OFF-${uid()}`;
    const now = new Date().toISOString();
    const bid = branchId || null;
    try {
      await query(
        "INSERT INTO offices (id,code,country_code,unlocode,department,name,is_active,branch_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8)",
        [id, code, country, un, dept, name, bid, now]);
      ok(res, mapOffice({ id, code, country_code: country, unlocode: un, department: dept, name, is_active: true, branch_id: bid, created_at: now }), 201);
    } catch (e) {
      if (isUniqueViolation(e)) return err(res, `Office code ${code} already exists`);
      err(res, e.message, 500);
    }
  });

  app.put("/api/offices/:id", adminOnly, async (req, res) => {
    const [existing] = await query("SELECT * FROM offices WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const { name = existing.name, isActive, branchId,
            managerUserId, invoiceAlertBusinessDays, invoiceEscalationBusinessDays } = req.body || {};
    const active = isActive !== undefined ? !!isActive : existing.is_active;
    const bid = branchId !== undefined ? (branchId || null) : existing.branch_id;
    // Invoice Collections thresholds (Epic TKT-G11AHW) — an office's own manager_user_id is also
    // the authority allowed to edit these fields (adminOnly already gates the whole route; a
    // future pass could relax this to "admin OR that office's own manager" if that authority
    // split turns out to matter in practice).
    const mgr = managerUserId !== undefined ? (managerUserId || '') : existing.manager_user_id;
    const alertDays = invoiceAlertBusinessDays !== undefined
      ? (invoiceAlertBusinessDays === null || invoiceAlertBusinessDays === '' ? null : parseInt(invoiceAlertBusinessDays, 10))
      : existing.invoice_alert_business_days;
    const escalationDays = invoiceEscalationBusinessDays !== undefined
      ? (invoiceEscalationBusinessDays === null || invoiceEscalationBusinessDays === '' ? null : parseInt(invoiceEscalationBusinessDays, 10))
      : existing.invoice_escalation_business_days;
    if (alertDays != null && alertDays < 1) return err(res, "invoiceAlertBusinessDays must be at least 1");
    if (escalationDays != null && escalationDays < 1) return err(res, "invoiceEscalationBusinessDays must be at least 1");
    if (alertDays != null && escalationDays != null && escalationDays <= alertDays)
      return err(res, "invoiceEscalationBusinessDays must be greater than invoiceAlertBusinessDays");
    await query(`UPDATE offices SET name=$1, is_active=$2, branch_id=$3, manager_user_id=$4,
      invoice_alert_business_days=$5, invoice_escalation_business_days=$6 WHERE id=$7`,
      [name, active, bid, mgr, alertDays, escalationDays, req.params.id]);
    const [managerName] = mgr ? await query("SELECT name, email FROM users WHERE id=$1", [mgr]) : [null];
    ok(res, mapOffice({ ...existing, name, is_active: active, branch_id: bid, manager_user_id: mgr,
      manager_name: managerName ? (managerName.name || managerName.email) : null,
      invoice_alert_business_days: alertDays, invoice_escalation_business_days: escalationDays }));
  });

  app.delete("/api/offices/:id", adminOnly, async (req, res) => {
    const [existing] = await query("SELECT * FROM offices WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const [inUse] = await query(
      "SELECT id FROM shipments WHERE emo_office_id=$1 OR imo_office_id=$1 OR controlling_office_id=$1 LIMIT 1", [req.params.id]
    );
    if (inUse) return err(res, "Office is referenced by shipments — deactivate it instead of deleting");
    const [eadapterInUse] = await query("SELECT id FROM carrier_eadapter_configs WHERE office_id=$1 LIMIT 1", [req.params.id]);
    if (eadapterInUse) return err(res, "Office is referenced by an eAdapter carrier config — remove that config first, or deactivate the office instead of deleting");
    await query("DELETE FROM offices WHERE id=$1", [req.params.id]);
    ok(res, { deleted: req.params.id });
  });

  // ── User-office assignments (admin only) ────────────────────────────────────

  app.get("/api/users/:id/offices", adminOnly, async (req, res) => {
    const rows = await query(`
      SELECT o.*, uo.is_default
      FROM user_offices uo JOIN offices o ON o.id = uo.office_id
      WHERE uo.user_id = $1 ORDER BY uo.is_default DESC, o.code
    `, [req.params.id]);
    ok(res, rows.map(r => ({ ...mapOffice(r), isDefault: !!r.is_default })));
  });

  app.post("/api/users/:id/offices", adminOnly, async (req, res) => {
    const { officeId, isDefault = false } = req.body || {};
    if (!officeId) return err(res, "officeId required");
    if (!(await query("SELECT id FROM offices WHERE id=$1", [officeId]))[0]) return err(res, "Office not found", 404);
    const id = `UO-${uid()}`;
    const now = new Date().toISOString();
    try {
      if (isDefault) await query("UPDATE user_offices SET is_default=FALSE WHERE user_id=$1", [req.params.id]);
      await query(
        "INSERT INTO user_offices (id,user_id,office_id,is_default,created_at) VALUES ($1,$2,$3,$4,$5)",
        [id, req.params.id, officeId, !!isDefault, now]);
      ok(res, { id, userId: req.params.id, officeId, isDefault: !!isDefault }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) return err(res, "Office already assigned to this user");
      err(res, e.message, 500);
    }
  });

  app.patch("/api/users/:id/offices/:officeId/set-default", adminOnly, async (req, res) => {
    await query("UPDATE user_offices SET is_default=FALSE WHERE user_id=$1", [req.params.id]);
    const updated = await query(
      "UPDATE user_offices SET is_default=TRUE WHERE user_id=$1 AND office_id=$2 RETURNING id",
      [req.params.id, req.params.officeId]);
    if (!updated.length) return err(res, "Assignment not found", 404);
    ok(res, { ok: true });
  });

  app.delete("/api/users/:id/offices/:officeId", adminOnly, async (req, res) => {
    await query("DELETE FROM user_offices WHERE user_id=$1 AND office_id=$2",
      [req.params.id, req.params.officeId]);
    ok(res, { deleted: req.params.officeId });
  });
};
