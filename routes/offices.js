"use strict";

module.exports = function officesRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, mapOffice } = ctx;
  const adminOnly = requireRole(["admin"]);

  // ── Offices CRUD ────────────────────────────────────────────────────────────

  app.get("/api/offices", (req, res) => {
    const rows = db.prepare(`
      SELECT o.*, u.name AS manager_name, u.email AS manager_email
      FROM offices o LEFT JOIN users u ON u.id = o.manager_user_id
      ORDER BY o.code
    `).all();
    ok(res, rows.map(r => mapOffice({ ...r, manager_name: r.manager_name || r.manager_email || null })));
  });

  app.post("/api/offices", adminOnly, (req, res) => {
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
      db.prepare(
        "INSERT INTO offices (id,code,country_code,unlocode,department,name,is_active,branch_id,created_at) VALUES (?,?,?,?,?,?,1,?,?)"
      ).run(id, code, country, un, dept, name, bid, now);
      ok(res, mapOffice({ id, code, country_code: country, unlocode: un, department: dept, name, is_active: 1, branch_id: bid, created_at: now }), 201);
    } catch (e) {
      if (e.message?.includes('UNIQUE')) return err(res, `Office code ${code} already exists`);
      err(res, e.message, 500);
    }
  });

  app.put("/api/offices/:id", adminOnly, (req, res) => {
    const existing = db.prepare("SELECT * FROM offices WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const { name = existing.name, isActive, branchId,
            managerUserId, invoiceAlertBusinessDays, invoiceEscalationBusinessDays } = req.body || {};
    const active = isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active;
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
    db.prepare(`UPDATE offices SET name=?, is_active=?, branch_id=?, manager_user_id=?,
      invoice_alert_business_days=?, invoice_escalation_business_days=? WHERE id=?`)
      .run(name, active, bid, mgr, alertDays, escalationDays, req.params.id);
    const managerName = mgr ? db.prepare("SELECT name, email FROM users WHERE id=?").get(mgr) : null;
    ok(res, mapOffice({ ...existing, name, is_active: active, branch_id: bid, manager_user_id: mgr,
      manager_name: managerName ? (managerName.name || managerName.email) : null,
      invoice_alert_business_days: alertDays, invoice_escalation_business_days: escalationDays }));
  });

  app.delete("/api/offices/:id", adminOnly, (req, res) => {
    const existing = db.prepare("SELECT * FROM offices WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const inUse = db.prepare(
      "SELECT id FROM shipments WHERE emo_office_id=? OR imo_office_id=? OR controlling_office_id=? LIMIT 1"
    ).get(req.params.id, req.params.id, req.params.id);
    if (inUse) return err(res, "Office is referenced by shipments — deactivate it instead of deleting");
    db.prepare("DELETE FROM offices WHERE id=?").run(req.params.id);
    ok(res, { deleted: req.params.id });
  });

  // ── User-office assignments (admin only) ────────────────────────────────────

  app.get("/api/users/:id/offices", adminOnly, (req, res) => {
    const rows = db.prepare(`
      SELECT o.*, uo.is_default
      FROM user_offices uo JOIN offices o ON o.id = uo.office_id
      WHERE uo.user_id = ? ORDER BY uo.is_default DESC, o.code
    `).all(req.params.id);
    ok(res, rows.map(r => ({ ...mapOffice(r), isDefault: !!r.is_default })));
  });

  app.post("/api/users/:id/offices", adminOnly, (req, res) => {
    const { officeId, isDefault = false } = req.body || {};
    if (!officeId) return err(res, "officeId required");
    if (!db.prepare("SELECT id FROM offices WHERE id=?").get(officeId)) return err(res, "Office not found", 404);
    const id = `UO-${uid()}`;
    const now = new Date().toISOString();
    try {
      if (isDefault) db.prepare("UPDATE user_offices SET is_default=0 WHERE user_id=?").run(req.params.id);
      db.prepare(
        "INSERT INTO user_offices (id,user_id,office_id,is_default,created_at) VALUES (?,?,?,?,?)"
      ).run(id, req.params.id, officeId, isDefault ? 1 : 0, now);
      ok(res, { id, userId: req.params.id, officeId, isDefault: !!isDefault }, 201);
    } catch (e) {
      if (e.message?.includes('UNIQUE')) return err(res, "Office already assigned to this user");
      err(res, e.message, 500);
    }
  });

  app.patch("/api/users/:id/offices/:officeId/set-default", adminOnly, (req, res) => {
    db.prepare("UPDATE user_offices SET is_default=0 WHERE user_id=?").run(req.params.id);
    const info = db.prepare(
      "UPDATE user_offices SET is_default=1 WHERE user_id=? AND office_id=?"
    ).run(req.params.id, req.params.officeId);
    if (!info.changes) return err(res, "Assignment not found", 404);
    ok(res, { ok: true });
  });

  app.delete("/api/users/:id/offices/:officeId", adminOnly, (req, res) => {
    db.prepare("DELETE FROM user_offices WHERE user_id=? AND office_id=?")
      .run(req.params.id, req.params.officeId);
    ok(res, { deleted: req.params.officeId });
  });
};
