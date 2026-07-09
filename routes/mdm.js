"use strict";

module.exports = function mdmRoutes(app, ctx) {
  const { db, ok, err, uid, isUniqueViolation,
          mapCarrier, mapVessel, mapPortLocation, mapLinkedPort, mapTradeLane,
          mapCountry, mapRegion, mapCommodity,
          logEntityEvent, rebuildPortLanesMap, longestLane } = ctx;

  // ─── Carriers ─────────────────────────────────────────────────────────────

  app.get("/api/carriers", (req, res) => ok(res, db.prepare("SELECT * FROM carriers ORDER BY name").all().map(mapCarrier)));
  app.get("/api/carriers/:code", (req, res) => { const r = db.prepare("SELECT * FROM carriers WHERE code=?").get(req.params.code); if (!r) return err(res,"Not found",404); ok(res,mapCarrier(r)); });
  app.post("/api/carriers", (req, res) => {
    const { code, name, shortName = '' } = req.body;
    if (!code || !name) return err(res, "code and name required");
    try {
      const codeU = code.toUpperCase().trim();
      db.prepare("INSERT INTO carriers (code,name,short_name) VALUES (?,?,?)").run(codeU, name.trim(), shortName.trim());
      logEntityEvent('carrier', codeU, 'CREATED', null, null, null, JSON.stringify({ name: name.trim() }));
      ok(res, mapCarrier({ code: codeU, name: name.trim(), short_name: shortName.trim() }), 201);
    } catch(e) { err(res, isUniqueViolation(e) ? `Carrier ${code} already exists` : e.message); }
  });
  app.put("/api/carriers/:code", (req, res) => {
    const { name, shortName = '' } = req.body;
    const existing = db.prepare("SELECT * FROM carriers WHERE code=?").get(req.params.code);
    const info = db.prepare("UPDATE carriers SET name=?, short_name=? WHERE code=?").run(name, shortName, req.params.code);
    if (info.changes === 0) return err(res, "Not found", 404);
    if (existing && existing.name !== name) logEntityEvent('carrier', req.params.code, 'UPDATED', 'name', existing.name, name);
    ok(res, mapCarrier({ code: req.params.code, name, short_name: shortName }));
  });
  app.delete("/api/carriers/:code", (req, res) => {
    const existing = db.prepare("SELECT * FROM carriers WHERE code=?").get(req.params.code);
    const info = db.prepare("DELETE FROM carriers WHERE code=?").run(req.params.code);
    if (info.changes===0) return err(res,"Not found",404);
    if (existing) logEntityEvent('carrier', req.params.code, 'DELETED', null, null, null, JSON.stringify({ name: existing.name }));
    ok(res,{deleted:req.params.code});
  });

  // ─── Vessels ──────────────────────────────────────────────────────────────

  app.get("/api/vessels", (req, res) => {
    const { search = '', limit = '50', offset = '0' } = req.query;
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const where = search.trim() ? "WHERE name LIKE ? OR imo LIKE ? OR asset_type LIKE ?" : "";
    const params = search.trim() ? [`%${search.trim()}%`,`%${search.trim()}%`,`%${search.trim()}%`] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM vessels ${where}`).get(...params).n;
    const rows  = db.prepare(`SELECT * FROM vessels ${where} ORDER BY name LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapVessel), total, limit: lim, offset: off });
  });
  app.get("/api/vessels/search", (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return ok(res, []);
    ok(res, db.prepare("SELECT * FROM vessels WHERE name LIKE ? OR imo LIKE ? LIMIT 12").all(`%${q}%`, `%${q}%`).map(mapVessel));
  });
  app.get("/api/vessels/:imo", (req, res) => { const r = db.prepare("SELECT * FROM vessels WHERE imo=?").get(req.params.imo); if (!r) return err(res,"Not found",404); ok(res,mapVessel(r)); });
  app.post("/api/vessels", (req, res) => {
    const { imo, name, assetType='', flagIso2='', flagName='', buildYear=null, grossTonnage=null } = req.body;
    if (!imo || !name) return err(res, "imo and name required");
    try { db.prepare("INSERT INTO vessels (imo,name,asset_type,flag_iso2,flag_name,build_year,gross_tonnage) VALUES (?,?,?,?,?,?,?)").run(imo.trim(), name.trim(), assetType, flagIso2, flagName, buildYear, grossTonnage); ok(res, mapVessel({ imo: imo.trim(), name: name.trim(), asset_type: assetType, flag_iso2: flagIso2, flag_name: flagName, build_year: buildYear, gross_tonnage: grossTonnage }), 201); }
    catch(e) { err(res, isUniqueViolation(e) ? `Vessel ${imo} already exists` : e.message); }
  });
  app.put("/api/vessels/:imo", (req, res) => {
    const { name, assetType='', flagIso2='', flagName='', buildYear=null, grossTonnage=null } = req.body;
    const info = db.prepare("UPDATE vessels SET name=?, asset_type=?, flag_iso2=?, flag_name=?, build_year=?, gross_tonnage=? WHERE imo=?").run(name, assetType, flagIso2, flagName, buildYear, grossTonnage, req.params.imo);
    if (info.changes===0) return err(res,"Not found",404);
    ok(res, mapVessel({ imo: req.params.imo, name, asset_type: assetType, flag_iso2: flagIso2, flag_name: flagName, build_year: buildYear, gross_tonnage: grossTonnage }));
  });
  app.delete("/api/vessels/:imo", (req, res) => { const info = db.prepare("DELETE FROM vessels WHERE imo=?").run(req.params.imo); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.imo}); });

  // ─── Port Locations ───────────────────────────────────────────────────────

  app.get("/api/port-locations", (req, res) => {
    const { search='', country='', limit='50', offset='0' } = req.query;
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const clauses = [], params = [];
    if (search.trim()) { clauses.push("(unlocode LIKE ? OR name LIKE ?)"); const s=`%${search.trim().toUpperCase()}%`; params.push(s, `%${search.trim()}%`); }
    if (country.trim()) { clauses.push("country_code=?"); params.push(country.trim().toUpperCase()); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS n FROM port_locations ${where}`).get(...params).n;
    const rows  = db.prepare(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
  });
  app.get("/api/port-locations/:code/links", (req, res) => {
    const code = req.params.code.toUpperCase();
    const rows = db.prepare(`SELECT CASE WHEN lp.primary_unlocode=? THEN lp.linked_unlocode ELSE lp.primary_unlocode END AS unlocode, pl.name, lp.note FROM linked_ports lp LEFT JOIN port_locations pl ON pl.unlocode=(CASE WHEN lp.primary_unlocode=? THEN lp.linked_unlocode ELSE lp.primary_unlocode END) WHERE lp.primary_unlocode=? OR lp.linked_unlocode=? ORDER BY unlocode`).all(code,code,code,code);
    ok(res, rows);
  });
  app.get("/api/port-locations/:code/lanes", (req, res) => {
    const code = req.params.code.toUpperCase();
    const port = db.prepare("SELECT country_code FROM port_locations WHERE unlocode=?").get(code);
    if (!port) return ok(res, { lanes: [], primary: null });
    const lanes = db.prepare("SELECT ctl.lane_code AS code, tl.name FROM country_trade_lanes ctl JOIN trade_lanes tl ON tl.code=ctl.lane_code WHERE ctl.iso2=? ORDER BY ctl.lane_code").all(port.country_code);
    ok(res, { lanes, primary: lanes[0]?.code || null });
  });
  app.get("/api/port-locations/:unlocode", (req, res) => { const r = db.prepare("SELECT * FROM port_locations WHERE unlocode=?").get(req.params.unlocode.toUpperCase()); if (!r) return err(res,"Not found",404); ok(res,mapPortLocation(r)); });
  app.post("/api/port-locations", (req, res) => {
    const { unlocode, name, latitude=0, longitude=0, countryCode='', zoneCode='' } = req.body;
    if (!unlocode || !name) return err(res, "unlocode and name required");
    const code = unlocode.toUpperCase().trim();
    const derivedCC = code.length >= 2 ? code.slice(0, 2) : countryCode.trim().toUpperCase();
    const finalCC = countryCode.trim().toUpperCase() || derivedCC;
    const now = new Date().toISOString();
    try { db.prepare("INSERT INTO port_locations (unlocode,name,latitude,longitude,country_code,zone_code,last_synced_at) VALUES (?,?,?,?,?,?,?)").run(code, name.trim(), latitude, longitude, finalCC, zoneCode.trim(), now); ok(res, mapPortLocation({ unlocode: code, name: name.trim(), latitude, longitude, country_code: finalCC, zone_code: zoneCode.trim(), last_synced_at: now }), 201); }
    catch(e) { err(res, isUniqueViolation(e) ? `Port ${unlocode} already exists` : e.message); }
  });
  app.put("/api/port-locations/:unlocode", (req, res) => {
    const { name, latitude=0, longitude=0, countryCode='', zoneCode='' } = req.body;
    const cc = countryCode.toUpperCase() || req.params.unlocode.slice(0, 2).toUpperCase();
    const info = db.prepare("UPDATE port_locations SET name=?, latitude=?, longitude=?, country_code=?, zone_code=?, last_synced_at=? WHERE unlocode=?").run(name, latitude, longitude, cc, zoneCode, new Date().toISOString(), req.params.unlocode.toUpperCase());
    if (info.changes===0) return err(res,"Not found",404);
    ok(res, mapPortLocation({ unlocode: req.params.unlocode.toUpperCase(), name, latitude, longitude, country_code: countryCode.toUpperCase(), zone_code: zoneCode }));
  });
  app.delete("/api/port-locations/:unlocode", (req, res) => { const info = db.prepare("DELETE FROM port_locations WHERE unlocode=?").run(req.params.unlocode.toUpperCase()); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.unlocode}); });

  // ─── Linked Ports ─────────────────────────────────────────────────────────

  app.get("/api/linked-ports", (req, res) => {
    const rows = db.prepare(`SELECT lp.*, p1.name AS primary_name, p2.name AS linked_name FROM linked_ports lp LEFT JOIN port_locations p1 ON p1.unlocode=lp.primary_unlocode LEFT JOIN port_locations p2 ON p2.unlocode=lp.linked_unlocode ORDER BY lp.primary_unlocode`).all();
    ok(res, rows.map(mapLinkedPort));
  });
  app.post("/api/linked-ports", (req, res) => {
    const { primaryUnlocode, linkedUnlocode, note='' } = req.body;
    if (!primaryUnlocode || !linkedUnlocode) return err(res, "primaryUnlocode and linkedUnlocode required");
    if (primaryUnlocode.toUpperCase() === linkedUnlocode.toUpperCase()) return err(res, "A port cannot be linked to itself");
    const id = `LNK-${uid()}`;
    try { db.prepare("INSERT INTO linked_ports (id,primary_unlocode,linked_unlocode,note) VALUES (?,?,?,?)").run(id, primaryUnlocode.toUpperCase(), linkedUnlocode.toUpperCase(), note); ok(res, { id, primaryUnlocode: primaryUnlocode.toUpperCase(), linkedUnlocode: linkedUnlocode.toUpperCase(), note }, 201); }
    catch(e) { err(res, isUniqueViolation(e) ? "This port link already exists" : e.message); }
  });
  app.put("/api/linked-ports/:id", (req, res) => {
    const { note='' } = req.body;
    const info = db.prepare("UPDATE linked_ports SET note=? WHERE id=?").run(note, req.params.id);
    if (info.changes===0) return err(res,"Not found",404);
    const r = db.prepare("SELECT lp.*, p1.name AS primary_name, p2.name AS linked_name FROM linked_ports lp LEFT JOIN port_locations p1 ON p1.unlocode=lp.primary_unlocode LEFT JOIN port_locations p2 ON p2.unlocode=lp.linked_unlocode WHERE lp.id=?").get(req.params.id);
    ok(res, mapLinkedPort(r));
  });
  app.delete("/api/linked-ports/:id", (req, res) => { const info = db.prepare("DELETE FROM linked_ports WHERE id=?").run(req.params.id); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.id}); });

  // ─── Trade Lanes ──────────────────────────────────────────────────────────

  app.get("/api/trade-lanes", (req, res) => ok(res, db.prepare(`
    SELECT tl.*, COUNT(ctl.iso2) AS country_count
    FROM trade_lanes tl
    LEFT JOIN country_trade_lanes ctl ON ctl.lane_code = tl.code
    GROUP BY tl.code
    ORDER BY tl.code
  `).all().map(mapTradeLane)));

  app.get("/api/trade-lanes/:code/countries", (req, res) => {
    const rows = db.prepare(`
      SELECT c.iso2, c.name, c.un_member, c.region_code
      FROM country_trade_lanes ctl
      JOIN countries c ON c.iso2 = ctl.iso2
      WHERE ctl.lane_code = ?
      ORDER BY c.name
    `).all(req.params.code.toUpperCase());
    ok(res, rows.map(mapCountry));
  });

  app.put("/api/trade-lanes/:code/countries", (req, res) => {
    const code  = req.params.code.toUpperCase();
    const iso2s = Array.isArray(req.body.iso2s) ? req.body.iso2s : [];
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM country_trade_lanes WHERE lane_code = ?").run(code);
      const ins = db.prepare("INSERT OR IGNORE INTO country_trade_lanes (iso2, lane_code) VALUES (?, ?)");
      for (const iso2 of iso2s) ins.run(iso2.toUpperCase(), code);
      db.exec("COMMIT");
      rebuildPortLanesMap();
      ok(res, { code, iso2s });
    } catch(e) { db.exec("ROLLBACK"); err(res, e.message); }
  });

  app.post("/api/trade-lanes", (req, res) => {
    const { code, name, description='', transitDays=0 } = req.body;
    if (!code || !name) return err(res, "code and name required");
    try {
      const c = code.toUpperCase().trim();
      db.prepare("INSERT INTO trade_lanes (code,name,description,transit_days) VALUES (?,?,?,?)").run(c, name.trim(), description.trim(), Number(transitDays) || 0);
      ok(res, { code: c, name: name.trim(), description: description.trim(), transitDays: Number(transitDays) || 0, countryCount: 0 }, 201);
    } catch(e) { err(res, isUniqueViolation(e) ? `Lane ${code} already exists` : e.message); }
  });
  app.put("/api/trade-lanes/:code", (req, res) => {
    const { name, description='', transitDays=0 } = req.body;
    const info = db.prepare("UPDATE trade_lanes SET name=?, description=?, transit_days=? WHERE code=?").run(name, description, Number(transitDays) || 0, req.params.code);
    if (info.changes===0) return err(res,"Not found",404);
    ok(res, { code: req.params.code, name, description, transitDays: Number(transitDays) || 0 });
  });
  app.get("/api/trade-lanes/transit-suggestion", (req, res) => {
    const { pol, pod } = req.query;
    if (!pol || !pod) return ok(res, { days: null, lane: null });
    const polLane = longestLane(pol.toUpperCase());
    const podLane = longestLane(pod.toUpperCase());
    if (!polLane || !podLane || polLane !== podLane) return ok(res, { days: null, lane: polLane && podLane ? `${polLane} → ${podLane}` : null });
    const row = db.prepare("SELECT transit_days FROM trade_lanes WHERE code=?").get(polLane);
    ok(res, { days: row?.transit_days || null, lane: polLane });
  });
  app.delete("/api/trade-lanes/:code", (req, res) => { const info = db.prepare("DELETE FROM trade_lanes WHERE code=?").run(req.params.code); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.code}); });

  app.get("/api/country-trade-lanes", (req, res) => ok(res, db.prepare("SELECT * FROM country_trade_lanes").all()));
  app.post("/api/country-trade-lanes", (req, res) => {
    const { iso2, laneCode } = req.body;
    if (!iso2 || !laneCode) return err(res, "iso2 and laneCode required");
    try { db.prepare("INSERT INTO country_trade_lanes (iso2,lane_code) VALUES (?,?)").run(iso2.toUpperCase(), laneCode.toUpperCase()); rebuildPortLanesMap(); ok(res, { iso2: iso2.toUpperCase(), laneCode: laneCode.toUpperCase() }, 201); }
    catch(e) { err(res, isUniqueViolation(e) ? "Assignment already exists" : e.message); }
  });
  app.put("/api/countries/:iso2/trade-lanes", (req, res) => {
    const iso2  = req.params.iso2.toUpperCase();
    const lanes = Array.isArray(req.body.lanes) ? req.body.lanes : [];
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM country_trade_lanes WHERE iso2 = ?").run(iso2);
      const ins = db.prepare("INSERT OR IGNORE INTO country_trade_lanes (iso2, lane_code) VALUES (?, ?)");
      for (const lane of lanes) ins.run(iso2, lane.toUpperCase());
      db.exec("COMMIT");
      rebuildPortLanesMap();
      ok(res, { iso2, lanes });
    } catch(e) { db.exec("ROLLBACK"); err(res, e.message); }
  });
  app.delete("/api/country-trade-lanes/:iso2/:laneCode", (req, res) => { db.prepare("DELETE FROM country_trade_lanes WHERE iso2=? AND lane_code=?").run(req.params.iso2, req.params.laneCode); rebuildPortLanesMap(); ok(res, { deleted: true }); });

  // ─── Regions ──────────────────────────────────────────────────────────────

  app.get("/api/regions", (req, res) => ok(res, db.prepare("SELECT * FROM regions ORDER BY code").all().map(mapRegion)));
  app.post("/api/regions", (req, res) => {
    const { code, name, description='' } = req.body;
    if (!code || !name) return err(res, "code and name required");
    try { db.prepare("INSERT INTO regions (code,name,description) VALUES (?,?,?)").run(code.toUpperCase().trim(), name.trim(), description.trim()); ok(res, { code: code.toUpperCase().trim(), name: name.trim(), description: description.trim() }, 201); }
    catch(e) { err(res, isUniqueViolation(e) ? `Region ${code} already exists` : e.message); }
  });
  app.put("/api/regions/:code", (req, res) => {
    const { name, description='' } = req.body;
    const info = db.prepare("UPDATE regions SET name=?, description=? WHERE code=?").run(name, description, req.params.code);
    if (info.changes===0) return err(res,"Not found",404);
    ok(res, { code: req.params.code, name, description });
  });
  app.delete("/api/regions/:code", (req, res) => { const info = db.prepare("DELETE FROM regions WHERE code=?").run(req.params.code); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.code}); });

  // ─── Countries ────────────────────────────────────────────────────────────

  app.get("/api/countries", (req, res) => {
    const { search='', limit='50', offset='0' } = req.query;
    const lim = Math.min(parseInt(limit)||50, 300), off = parseInt(offset)||0;
    const where = search.trim() ? "WHERE c.iso2 LIKE ? OR c.name LIKE ?" : "";
    const params = search.trim() ? [`%${search.trim().toUpperCase()}%`, `%${search.trim()}%`] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM countries c ${where}`).get(...params).n;
    const rows  = db.prepare(`
      SELECT c.*, COUNT(pl.unlocode) AS port_count
      FROM countries c
      LEFT JOIN port_locations pl ON pl.country_code = c.iso2
      ${where}
      GROUP BY c.iso2
      ORDER BY c.name
      LIMIT ? OFFSET ?
    `).all(...params, lim, off);
    ok(res, { results: rows.map(mapCountry), total, limit: lim, offset: off });
  });
  app.post("/api/countries", (req, res) => {
    const { iso2, name, unMember=1, regionCode='' } = req.body;
    if (!iso2 || !name) return err(res, "iso2 and name required");
    try { db.prepare("INSERT INTO countries (iso2,name,un_member,region_code) VALUES (?,?,?,?)").run(iso2.toUpperCase().trim(), name.trim(), unMember ? 1 : 0, regionCode.trim()); ok(res, mapCountry({ iso2: iso2.toUpperCase().trim(), name: name.trim(), un_member: unMember ? 1 : 0, region_code: regionCode.trim() }), 201); }
    catch(e) { err(res, isUniqueViolation(e) ? `Country ${iso2} already exists` : e.message); }
  });
  app.put("/api/countries/:iso2", (req, res) => {
    const { name, unMember=1, regionCode='' } = req.body;
    const info = db.prepare("UPDATE countries SET name=?, un_member=?, region_code=? WHERE iso2=?").run(name, unMember ? 1 : 0, regionCode, req.params.iso2.toUpperCase());
    if (info.changes===0) return err(res,"Not found",404);
    ok(res, mapCountry({ iso2: req.params.iso2.toUpperCase(), name, un_member: unMember ? 1 : 0, region_code: regionCode }));
  });
  app.delete("/api/countries/:iso2", (req, res) => { const info = db.prepare("DELETE FROM countries WHERE iso2=?").run(req.params.iso2.toUpperCase()); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.iso2}); });
  app.get("/api/countries/:iso2/locations", (req, res) => {
    const iso2   = req.params.iso2.toUpperCase();
    const search = (req.query.search || "").trim();
    const lim    = Math.min(parseInt(req.query.limit  || "50",  10), 200);
    const off    = parseInt(req.query.offset || "0", 10);
    const where  = search ? "WHERE country_code=? AND (unlocode LIKE ? OR name LIKE ?)" : "WHERE country_code=?";
    const params = search ? [iso2, `%${search}%`, `%${search}%`] : [iso2];
    const total  = db.prepare(`SELECT COUNT(*) AS n FROM port_locations ${where}`).get(...params).n;
    const rows   = db.prepare(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
  });

  // ─── UN Location Codes ────────────────────────────────────────────────────

  app.get("/api/unlocodes", (req, res) => {
    const { search='', limit='50', offset='0' } = req.query;
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const where = search.trim() ? "WHERE unlocode LIKE ? OR name LIKE ?" : "";
    const params = search.trim() ? [`%${search.trim().toUpperCase()}%`, `%${search.trim()}%`] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM port_locations ${where}`).get(...params).n;
    const rows  = db.prepare(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
  });

  // ─── Commodities ──────────────────────────────────────────────────────────

  app.get("/api/commodities", (req, res) => {
    const { search='', grade='', limit='50', offset='0' } = req.query;
    const lim = Math.min(parseInt(limit)||50, 300), off = parseInt(offset)||0;
    const s = search.trim(), g = grade.trim().toUpperCase();
    const clauses = [], params = [];
    if (s) { clauses.push("(code LIKE ? OR description LIKE ? OR grade_name LIKE ?)"); params.push(`%${s}%`, `%${s}%`, `%${s}%`); }
    if (g) { clauses.push("grade_code=?"); params.push(g); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const total  = db.prepare(`SELECT COUNT(*) AS n FROM commodities ${where}`).get(...params).n;
    const rows   = db.prepare(`SELECT * FROM commodities ${where} ORDER BY code LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapCommodity), total, limit: lim, offset: off });
  });
  app.get("/api/commodities/search", (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return ok(res, []);
    ok(res, db.prepare("SELECT * FROM commodities WHERE code LIKE ? OR description LIKE ? ORDER BY code LIMIT 12").all(`%${q}%`, `%${q}%`).map(mapCommodity));
  });
  app.get("/api/commodities/:code", (req, res) => { const r = db.prepare("SELECT * FROM commodities WHERE code=?").get(req.params.code); if (!r) return err(res,"Not found",404); ok(res,mapCommodity(r)); });
  app.post("/api/commodities", (req, res) => {
    const { code, description, gradeCode='E', gradeName='General Cargo' } = req.body;
    if (!code || !description) return err(res, "code and description required");
    try { db.prepare("INSERT INTO commodities (code,description,grade_code,grade_name) VALUES (?,?,?,?)").run(code.trim(), description.trim(), gradeCode, gradeName); ok(res, mapCommodity({ code: code.trim(), description: description.trim(), grade_code: gradeCode, grade_name: gradeName }), 201); }
    catch(e) { err(res, isUniqueViolation(e) ? `Commodity ${code} already exists` : e.message); }
  });
  app.put("/api/commodities/:code", (req, res) => {
    const { description, gradeCode='E', gradeName='General Cargo' } = req.body;
    const info = db.prepare("UPDATE commodities SET description=?, grade_code=?, grade_name=? WHERE code=?").run(description, gradeCode, gradeName, req.params.code);
    if (info.changes===0) return err(res,"Not found",404);
    ok(res, mapCommodity({ code: req.params.code, description, grade_code: gradeCode, grade_name: gradeName }));
  });
  app.delete("/api/commodities/:code", (req, res) => { const info = db.prepare("DELETE FROM commodities WHERE code=?").run(req.params.code); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.code}); });
};
