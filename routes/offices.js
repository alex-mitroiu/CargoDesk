"use strict";

module.exports = function officesRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, mapOffice } = ctx;
  const adminOnly = requireRole(["admin"]);

  // ── Offices CRUD ────────────────────────────────────────────────────────────

  app.get("/api/offices", (req, res) => {
    const rows = db.prepare("SELECT * FROM offices ORDER BY code").all();
    ok(res, rows.map(mapOffice));
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
    const { name = existing.name, isActive, branchId } = req.body || {};
    const active = isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active;
    const bid = branchId !== undefined ? (branchId || null) : existing.branch_id;
    db.prepare("UPDATE offices SET name=?, is_active=?, branch_id=? WHERE id=?").run(name, active, bid, req.params.id);
    ok(res, mapOffice({ ...existing, name, is_active: active, branch_id: bid }));
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
