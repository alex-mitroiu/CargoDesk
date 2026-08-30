"use strict";

module.exports = function organizationRoutes(app, ctx) {
  const { query, ok, err, uid, auth, requireRole, mapOffice, mapCountry, isUniqueViolation } = ctx;

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
    // Multi-Entity Accounting (TKT-EEV4I9) — a branch's own reporting/functional currency, since
    // it doubles as CargoDesk's legal-entity boundary for GP-by-entity reporting (routes/finance.js).
    // Defaults from org_countries.default_currency at creation time (below) but stays independently
    // editable — a branch reporting in a currency other than its own country's default is a real case.
    currency:    r.currency    || null,
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

  app.get("/api/branches", auth(), async (req, res) => {
    const rows = await query(
      `SELECT b.*,
         COUNT(DISTINCT o.id)  AS office_count,
         COUNT(DISTINCT uo.user_id) AS user_count
       FROM branches b
       LEFT JOIN offices o ON o.branch_id = b.id AND o.is_active = TRUE
       LEFT JOIN user_offices uo ON uo.office_id = o.id
       GROUP BY b.id
       ORDER BY b.code`
    );
    ok(res, rows.map(r => ({ ...mapBranch(r), officeCount: Number(r.office_count), userCount: Number(r.user_count) })));
  });

  app.get("/api/branches/:id", auth(), async (req, res) => {
    const [r] = await query("SELECT * FROM branches WHERE id=$1", [req.params.id]);
    if (!r) return err(res, "Not found", 404);
    ok(res, mapBranch(r));
  });

  app.get("/api/branches/:id/offices", auth(), async (req, res) => {
    const rows = await query(
      `SELECT o.*,
         COUNT(DISTINCT uo.user_id) AS user_count,
         (SELECT COUNT(*) FROM shipments s WHERE s.emo_office_id = o.id AND s.status NOT IN ('Completed','Cancelled')) AS emo_count,
         (SELECT COUNT(*) FROM shipments s WHERE s.imo_office_id = o.id AND s.status NOT IN ('Completed','Cancelled')) AS imo_count
       FROM offices o
       LEFT JOIN user_offices uo ON uo.office_id = o.id
       WHERE o.branch_id = $1
       GROUP BY o.id
       ORDER BY o.code`, [req.params.id]
    );
    ok(res, rows.map(r => ({ ...mapOffice(r), userCount: Number(r.user_count), emoCount: Number(r.emo_count), imoCount: Number(r.imo_count) })));
  });

  app.post("/api/branches", requireRole(["admin"]), async (req, res) => {
    const { code, name, countryCode, locode, city, address, timezone, phone, email, currency } = req.body || {};
    if (!code || !name || !countryCode) return err(res, "code, name, countryCode required");
    const id = `BRN-${uid()}`;
    const loc = locode ? locode.toUpperCase().trim() : null;
    const cc = countryCode.toUpperCase().trim();
    // Multi-Entity Accounting (TKT-EEV4I9) — default a new branch's reporting currency from its
    // operating country's own default (same "sensible default, still overridable" idiom this
    // route's own frontend already uses for timezone-from-LOCODE) rather than leaving it blank —
    // the common case (one branch, one country, one currency) needs zero manual entry.
    const [orgCountry] = await query("SELECT default_currency FROM org_countries WHERE country_code=$1", [cc]);
    const resolvedCurrency = currency || orgCountry?.default_currency || null;
    try {
      await query(
        `INSERT INTO branches (id, code, name, country_code, locode, city, address, timezone, phone, email, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, code.toUpperCase().trim(), name.trim(), cc,
             loc, city || null, address || null, timezone || null, phone || null, email || null, resolvedCurrency]);
      const [row] = await query("SELECT * FROM branches WHERE id=$1", [id]);
      ok(res, mapBranch(row));
    } catch (e) {
      err(res, isUniqueViolation(e) ? `Branch code ${code.toUpperCase()} already exists` : e.message);
    }
  });

  app.put("/api/branches/:id", requireRole(["admin"]), async (req, res) => {
    const [existing] = await query("SELECT * FROM branches WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const { name, locode, city, address, timezone, phone, email, currency, isActive } = req.body || {};
    const loc = locode !== undefined ? (locode ? locode.toUpperCase().trim() : null) : existing.locode;
    await query(
      `UPDATE branches SET name=$1, locode=$2, city=$3, address=$4, timezone=$5, phone=$6, email=$7, currency=$8, is_active=$9 WHERE id=$10`,
      [
      name    ?? existing.name,    loc,             city    ?? existing.city,
      address ?? existing.address, timezone ?? existing.timezone,
      phone   ?? existing.phone,   email   ?? existing.email,
      currency !== undefined ? (currency || null) : existing.currency,
      isActive !== undefined ? !!isActive : existing.is_active,
      req.params.id
      ]);
    const [row] = await query("SELECT * FROM branches WHERE id=$1", [req.params.id]);
    ok(res, mapBranch(row));
  });

  app.delete("/api/branches/:id", requireRole(["admin"]), async (req, res) => {
    const [existing] = await query("SELECT * FROM branches WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const [{ n: officeCount }] = await query("SELECT COUNT(*) AS n FROM offices WHERE branch_id=$1", [req.params.id]);
    if (Number(officeCount) > 0) return err(res, `Cannot delete — ${officeCount} office(s) are assigned to this branch. Reassign or delete them first.`);
    await query("DELETE FROM branches WHERE id=$1", [req.params.id]);
    ok(res, { deleted: req.params.id });
  });

  // ─── Org Countries ─────────────────────────────────────────────────────────

  app.get("/api/org-countries", auth(), async (req, res) => {
    const rows = await query(
      `SELECT oc.*, c.name AS country_name,
         b.code AS branch_code, b.name AS branch_name
       FROM org_countries oc
       LEFT JOIN countries c ON c.iso2 = oc.country_code
       LEFT JOIN branches  b ON b.id  = oc.branch_id
       ORDER BY oc.country_code`
    );
    ok(res, rows.map(mapOrgCountry));
  });

  app.post("/api/org-countries", requireRole(["admin"]), async (req, res) => {
    const { countryCode, defaultCurrency, timezone, branchId, complianceNotes } = req.body || {};
    if (!countryCode) return err(res, "countryCode required");
    const code = countryCode.toUpperCase().trim();
    // Validate country exists
    const [country] = await query("SELECT iso2 FROM countries WHERE iso2=$1", [code]);
    if (!country) return err(res, `Country ${code} not found in master data`);
    try {
      await query(
        `INSERT INTO org_countries (country_code, default_currency, timezone, branch_id, compliance_notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [code, defaultCurrency || null, timezone || null, branchId || null, complianceNotes || null]);
      const [row] = await query(
        `SELECT oc.*, c.name AS country_name, b.code AS branch_code, b.name AS branch_name
         FROM org_countries oc
         LEFT JOIN countries c ON c.iso2 = oc.country_code
         LEFT JOIN branches  b ON b.id  = oc.branch_id
         WHERE oc.country_code=$1`, [code]
      );
      ok(res, mapOrgCountry(row));
    } catch (e) {
      err(res, isUniqueViolation(e) ? `${code} is already in your operating countries` : e.message);
    }
  });

  app.put("/api/org-countries/:code", requireRole(["admin"]), async (req, res) => {
    const code = req.params.code.toUpperCase();
    const [existing] = await query("SELECT * FROM org_countries WHERE country_code=$1", [code]);
    if (!existing) return err(res, "Not found", 404);
    const { defaultCurrency, timezone, branchId, complianceNotes, isActive } = req.body || {};
    await query(
      `UPDATE org_countries SET default_currency=$1, timezone=$2, branch_id=$3, compliance_notes=$4, is_active=$5 WHERE country_code=$6`,
      [
      defaultCurrency ?? existing.default_currency,
      timezone        ?? existing.timezone,
      branchId        !== undefined ? (branchId || null) : existing.branch_id,
      complianceNotes ?? existing.compliance_notes,
      isActive        !== undefined ? !!isActive : existing.is_active,
      code
      ]);
    const [row] = await query(
      `SELECT oc.*, c.name AS country_name, b.code AS branch_code, b.name AS branch_name
       FROM org_countries oc
       LEFT JOIN countries c ON c.iso2 = oc.country_code
       LEFT JOIN branches  b ON b.id  = oc.branch_id
       WHERE oc.country_code=$1`, [code]
    );
    ok(res, mapOrgCountry(row));
  });

  app.delete("/api/org-countries/:code", requireRole(["admin"]), async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!(await query("SELECT country_code FROM org_countries WHERE country_code=$1", [code]))[0])
      return err(res, "Not found", 404);
    await query("DELETE FROM org_countries WHERE country_code=$1", [code]);
    ok(res, { deleted: code });
  });

  // ─── Office stats endpoint (for OfficePage) ────────────────────────────────

  app.get("/api/offices/:id/stats", auth(), async (req, res) => {
    const id = req.params.id;
    const [office] = await query("SELECT * FROM offices WHERE id=$1", [id]);
    if (!office) return err(res, "Not found", 404);

    const users = await query(
      `SELECT u.id, u.name, u.email, u.role, uo.is_default
       FROM users u JOIN user_offices uo ON uo.user_id = u.id
       WHERE uo.office_id = $1 AND u.is_active = TRUE ORDER BY u.name`, [id]
    );

    const [shipmentStats] = await query(
      `SELECT
         SUM(CASE WHEN emo_office_id = $1 THEN 1 ELSE 0 END) AS emo_total,
         SUM(CASE WHEN imo_office_id = $1 THEN 1 ELSE 0 END) AS imo_total,
         SUM(CASE WHEN controlling_office_id = $1 THEN 1 ELSE 0 END) AS ctrl_total,
         SUM(CASE WHEN emo_office_id = $1 AND status NOT IN ('Completed','Cancelled') THEN 1 ELSE 0 END) AS emo_active,
         SUM(CASE WHEN imo_office_id = $1 AND status NOT IN ('Completed','Cancelled') THEN 1 ELSE 0 END) AS imo_active
       FROM shipments`, [id]
    );

    ok(res, {
      office:       mapOffice(office),
      users:        users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, isDefault: !!u.is_default })),
      shipmentStats: {
        emoTotal:  Number(shipmentStats.emo_total)  || 0,
        imoTotal:  Number(shipmentStats.imo_total)  || 0,
        ctrlTotal: Number(shipmentStats.ctrl_total) || 0,
        emoActive: Number(shipmentStats.emo_active) || 0,
        imoActive: Number(shipmentStats.imo_active) || 0,
      },
    });
  });
};
