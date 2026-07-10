"use strict";

module.exports = function organizationRoutes(app, ctx) {
  const { db, ok, err, uid, auth, requireRole, mapOffice, mapCountry } = ctx;

  const mapBranch = r => ({
    id:          r.id,
    code:        r.code,
    name:        r.name,
    countryCode: r.country_code,
    locode:      r.locode      || null,
    city:        r.city        || null,
    address:     r.address     || null,
    timezone:    r.timezone    || null,
    phone:       r.phone       || null,
    email:       r.email       || null,
    isActive:    !!r.is_active,
    createdAt:   r.created_at,
  });

  const mapOrgCountry = r => ({
    countryCode:      r.country_code,
    countryName:      r.country_name  || null,
    defaultCurrency:  r.default_currency || null,
    timezone:         r.timezone      || null,
    branchId:         r.branch_id     || null,
    branchCode:       r.branch_code   || null,
    branchName:       r.branch_name   || null,
    complianceNotes:  r.compliance_notes || null,
    isActive:         !!r.is_active,
    addedAt:          r.added_at,
  });

  // ─── Branches ──────────────────────────────────────────────────────────────

  app.get("/api/branches", auth(), (req, res) => {
    const rows = db.prepare(
      `SELECT b.*,
         COUNT(DISTINCT o.id)  AS office_count,
         COUNT(DISTINCT uo.user_id) AS user_count
       FROM branches b
       LEFT JOIN offices o ON o.branch_id = b.id AND o.is_active = 1
       LEFT JOIN user_offices uo ON uo.office_id = o.id
       GROUP BY b.id
       ORDER BY b.code`
    ).all();
    ok(res, rows.map(r => ({ ...mapBranch(r), officeCount: r.office_count, userCount: r.user_count })));
  });

  app.get("/api/branches/:id", auth(), (req, res) => {
    const r = db.prepare("SELECT * FROM branches WHERE id=?").get(req.params.id);
    if (!r) return err(res, "Not found", 404);
    ok(res, mapBranch(r));
  });

  app.get("/api/branches/:id/offices", auth(), (req, res) => {
    const rows = db.prepare(
      `SELECT o.*,
         COUNT(DISTINCT uo.user_id) AS user_count,
         (SELECT COUNT(*) FROM shipments s WHERE s.emo_office_id = o.id AND s.status NOT IN ('Completed','Cancelled')) AS emo_count,
         (SELECT COUNT(*) FROM shipments s WHERE s.imo_office_id = o.id AND s.status NOT IN ('Completed','Cancelled')) AS imo_count
       FROM offices o
       LEFT JOIN user_offices uo ON uo.office_id = o.id
       WHERE o.branch_id = ?
       GROUP BY o.id
       ORDER BY o.code`
    ).all(req.params.id);
    ok(res, rows.map(r => ({ ...mapOffice(r), userCount: r.user_count, emoCount: r.emo_count, imoCount: r.imo_count })));
  });

  app.post("/api/branches", requireRole(["admin"]), (req, res) => {
    const { code, name, countryCode, locode, city, address, timezone, phone, email } = req.body || {};
    if (!code || !name || !countryCode) return err(res, "code, name, countryCode required");
    const id = `BRN-${uid()}`;
    const loc = locode ? locode.toUpperCase().trim() : null;
    try {
      db.prepare(
        `INSERT INTO branches (id, code, name, country_code, locode, city, address, timezone, phone, email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, code.toUpperCase().trim(), name.trim(), countryCode.toUpperCase().trim(),
             loc, city || null, address || null, timezone || null, phone || null, email || null);
      ok(res, mapBranch(db.prepare("SELECT * FROM branches WHERE id=?").get(id)));
    } catch (e) {
      err(res, e.message?.includes("UNIQUE") ? `Branch code ${code.toUpperCase()} already exists` : e.message);
    }
  });

  app.put("/api/branches/:id", requireRole(["admin"]), (req, res) => {
    const existing = db.prepare("SELECT * FROM branches WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const { name, locode, city, address, timezone, phone, email, isActive } = req.body || {};
    const loc = locode !== undefined ? (locode ? locode.toUpperCase().trim() : null) : existing.locode;
    db.prepare(
      `UPDATE branches SET name=?, locode=?, city=?, address=?, timezone=?, phone=?, email=?, is_active=? WHERE id=?`
    ).run(
      name    ?? existing.name,    loc,             city    ?? existing.city,
      address ?? existing.address, timezone ?? existing.timezone,
      phone   ?? existing.phone,   email   ?? existing.email,
      isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active,
      req.params.id
    );
    ok(res, mapBranch(db.prepare("SELECT * FROM branches WHERE id=?").get(req.params.id)));
  });

  app.delete("/api/branches/:id", requireRole(["admin"]), (req, res) => {
    const existing = db.prepare("SELECT * FROM branches WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const officeCount = db.prepare("SELECT COUNT(*) AS n FROM offices WHERE branch_id=?").get(req.params.id).n;
    if (officeCount > 0) return err(res, `Cannot delete — ${officeCount} office(s) are assigned to this branch. Reassign or delete them first.`);
    db.prepare("DELETE FROM branches WHERE id=?").run(req.params.id);
    ok(res, { deleted: req.params.id });
  });

  // ─── Org Countries ─────────────────────────────────────────────────────────

  app.get("/api/org-countries", auth(), (req, res) => {
    const rows = db.prepare(
      `SELECT oc.*, c.name AS country_name,
         b.code AS branch_code, b.name AS branch_name
       FROM org_countries oc
       LEFT JOIN countries c ON c.iso2 = oc.country_code
       LEFT JOIN branches  b ON b.id  = oc.branch_id
       ORDER BY oc.country_code`
    ).all();
    ok(res, rows.map(mapOrgCountry));
  });

  app.post("/api/org-countries", requireRole(["admin"]), (req, res) => {
    const { countryCode, defaultCurrency, timezone, branchId, complianceNotes } = req.body || {};
    if (!countryCode) return err(res, "countryCode required");
    const code = countryCode.toUpperCase().trim();
    // Validate country exists
    const country = db.prepare("SELECT iso2 FROM countries WHERE iso2=?").get(code);
    if (!country) return err(res, `Country ${code} not found in master data`);
    try {
      db.prepare(
        `INSERT INTO org_countries (country_code, default_currency, timezone, branch_id, compliance_notes)
         VALUES (?, ?, ?, ?, ?)`
      ).run(code, defaultCurrency || null, timezone || null, branchId || null, complianceNotes || null);
      const row = db.prepare(
        `SELECT oc.*, c.name AS country_name, b.code AS branch_code, b.name AS branch_name
         FROM org_countries oc
         LEFT JOIN countries c ON c.iso2 = oc.country_code
         LEFT JOIN branches  b ON b.id  = oc.branch_id
         WHERE oc.country_code=?`
      ).get(code);
      ok(res, mapOrgCountry(row));
    } catch (e) {
      err(res, e.message?.includes("UNIQUE") ? `${code} is already in your operating countries` : e.message);
    }
  });

  app.put("/api/org-countries/:code", requireRole(["admin"]), (req, res) => {
    const code = req.params.code.toUpperCase();
    const existing = db.prepare("SELECT * FROM org_countries WHERE country_code=?").get(code);
    if (!existing) return err(res, "Not found", 404);
    const { defaultCurrency, timezone, branchId, complianceNotes, isActive } = req.body || {};
    db.prepare(
      `UPDATE org_countries SET default_currency=?, timezone=?, branch_id=?, compliance_notes=?, is_active=? WHERE country_code=?`
    ).run(
      defaultCurrency ?? existing.default_currency,
      timezone        ?? existing.timezone,
      branchId        !== undefined ? (branchId || null) : existing.branch_id,
      complianceNotes ?? existing.compliance_notes,
      isActive        !== undefined ? (isActive ? 1 : 0) : existing.is_active,
      code
    );
    const row = db.prepare(
      `SELECT oc.*, c.name AS country_name, b.code AS branch_code, b.name AS branch_name
       FROM org_countries oc
       LEFT JOIN countries c ON c.iso2 = oc.country_code
       LEFT JOIN branches  b ON b.id  = oc.branch_id
       WHERE oc.country_code=?`
    ).get(code);
    ok(res, mapOrgCountry(row));
  });

  app.delete("/api/org-countries/:code", requireRole(["admin"]), (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!db.prepare("SELECT country_code FROM org_countries WHERE country_code=?").get(code))
      return err(res, "Not found", 404);
    db.prepare("DELETE FROM org_countries WHERE country_code=?").run(code);
    ok(res, { deleted: code });
  });

  // ─── Office stats endpoint (for OfficePage) ────────────────────────────────

  app.get("/api/offices/:id/stats", auth(), (req, res) => {
    const id = req.params.id;
    const office = db.prepare("SELECT * FROM offices WHERE id=?").get(id);
    if (!office) return err(res, "Not found", 404);

    const users = db.prepare(
      `SELECT u.id, u.name, u.email, u.role, uo.is_default
       FROM users u JOIN user_offices uo ON uo.user_id = u.id
       WHERE uo.office_id = ? AND u.is_active = 1 ORDER BY u.name`
    ).all(id);

    const shipmentStats = db.prepare(
      `SELECT
         SUM(CASE WHEN emo_office_id = ? THEN 1 ELSE 0 END) AS emo_total,
         SUM(CASE WHEN imo_office_id = ? THEN 1 ELSE 0 END) AS imo_total,
         SUM(CASE WHEN controlling_office_id = ? THEN 1 ELSE 0 END) AS ctrl_total,
         SUM(CASE WHEN emo_office_id = ? AND status NOT IN ('Completed','Cancelled') THEN 1 ELSE 0 END) AS emo_active,
         SUM(CASE WHEN imo_office_id = ? AND status NOT IN ('Completed','Cancelled') THEN 1 ELSE 0 END) AS imo_active
       FROM shipments`
    ).get(id, id, id, id, id);

    ok(res, {
      office:       mapOffice(office),
      users:        users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, isDefault: !!u.is_default })),
      shipmentStats: {
        emoTotal:  shipmentStats.emo_total  || 0,
        imoTotal:  shipmentStats.imo_total  || 0,
        ctrlTotal: shipmentStats.ctrl_total || 0,
        emoActive: shipmentStats.emo_active || 0,
        imoActive: shipmentStats.imo_active || 0,
      },
    });
  });
};
