"use strict";

const { timezoneFor } = require("../lib/timezones");

module.exports = function mdmRoutes(app, ctx) {
  const { query, transaction, ok, err, uid, isUniqueViolation, requireRole, getSettings, callMdmService, callCustomerService,
          mapCarrier, mapVessel, mapPortLocation, mapLinkedPort, mapTradeLane,
          mapCountry, mapRegion, mapCommodity,
          logEntityEvent, rebuildPortLanesMap, longestLane } = ctx;

  // MDM reference data (carriers/vessels/ports/lanes/countries/regions/commodities) is
  // read-only for trade_manager — they own Contracts/Allocations, not the underlying
  // reference data those entities point to.
  const write = requireRole(["admin", "operator"]);

  // 'local' (default) = every route below runs against this monolith's own tables, exactly as
  // before this cut. 'remote' = the standalone MDM Service (services/mdm/), reached through
  // callMdmService — same one-way-toggle shape routes/contracts.js already established for
  // contract_source. Local schema/data is never removed by flipping this: a remote-mode write
  // still logs the same local entity_events row the local path would (this service has no audit
  // log of its own, matching Contract Management's own precedent), so History stays intact
  // either way.
  const isRemote = async () => ((await getSettings()).mdm_source || "local") === "remote";

  // ─── Reference data loaded by the server itself (2026-11-22, lib/reference-data.js) ────────────────────────────────
  // Admins: each dataset's last load (file version, rows in the file, rows added, when) and the rows its table holds now.
  // Local tables only: the MDM Service seeds its own copy (services/mdm seedIfEmpty).
  app.get("/api/reference-data", requireRole(["admin"]), async (req, res) => {
    try { ok(res, await ctx.referenceData.status()); }
    catch (e) { err(res, e.message, 500); }
  });

  // ─── Carriers ─────────────────────────────────────────────────────────────

  app.get("/api/carriers", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", "/internal/carriers")); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, (await query("SELECT * FROM carriers ORDER BY name")).map(mapCarrier));
  });
  app.get("/api/carriers/:code", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/carriers/${req.params.code}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [r] = await query("SELECT * FROM carriers WHERE code=$1", [req.params.code]); if (!r) return err(res,"Not found",404); ok(res,mapCarrier(r));
  });
  app.post("/api/carriers", write, async (req, res) => {
    const { code, name, shortName = '' } = req.body;
    if (!code || !name) return err(res, "code and name required");
    if (await isRemote()) {
      try {
        const created = await callMdmService("POST", "/internal/carriers", { code, name, shortName });
        await logEntityEvent('carrier', created.code, 'CREATED', null, null, null, JSON.stringify({ name: name.trim() }));
        return ok(res, created, 201);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      const codeU = code.toUpperCase().trim();
      await query("INSERT INTO carriers (code,name,short_name) VALUES ($1,$2,$3)", [codeU, name.trim(), shortName.trim()]);
      await logEntityEvent('carrier', codeU, 'CREATED', null, null, null, JSON.stringify({ name: name.trim() }));
      ok(res, mapCarrier({ code: codeU, name: name.trim(), short_name: shortName.trim() }), 201);
    } catch(e) { err(res, isUniqueViolation(e) ? `Carrier ${code} already exists` : e.message); }
  });
  app.put("/api/carriers/:code", write, async (req, res) => {
    const { name, shortName = '' } = req.body;
    if (!name) return err(res, "name required");
    if (await isRemote()) {
      try {
        const before = await callMdmService("GET", `/internal/carriers/${req.params.code}`).catch(() => null);
        const updated = await callMdmService("PUT", `/internal/carriers/${req.params.code}`, { name, shortName });
        if (before && before.name !== name) await logEntityEvent('carrier', req.params.code, 'UPDATED', 'name', before.name, name);
        return ok(res, updated);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [existing] = await query("SELECT * FROM carriers WHERE code=$1", [req.params.code]);
    const updated = await query("UPDATE carriers SET name=$1, short_name=$2 WHERE code=$3 RETURNING code", [name, shortName, req.params.code]);
    if (updated.length === 0) return err(res, "Not found", 404);
    if (existing && existing.name !== name) await logEntityEvent('carrier', req.params.code, 'UPDATED', 'name', existing.name, name);
    ok(res, mapCarrier({ code: req.params.code, name, short_name: shortName }));
  });
  app.delete("/api/carriers/:code", write, async (req, res) => {
    if (await isRemote()) {
      try {
        const existing = await callMdmService("GET", `/internal/carriers/${req.params.code}`).catch(() => null);
        await callMdmService("DELETE", `/internal/carriers/${req.params.code}`);
        if (existing) await logEntityEvent('carrier', req.params.code, 'DELETED', null, null, null, JSON.stringify({ name: existing.name }));
        return ok(res, { deleted: req.params.code });
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [existing] = await query("SELECT * FROM carriers WHERE code=$1", [req.params.code]);
    const deleted = await query("DELETE FROM carriers WHERE code=$1 RETURNING code", [req.params.code]);
    if (deleted.length===0) return err(res,"Not found",404);
    if (existing) await logEntityEvent('carrier', req.params.code, 'DELETED', null, null, null, JSON.stringify({ name: existing.name }));
    ok(res,{deleted:req.params.code});
  });

  // ─── Vessels ──────────────────────────────────────────────────────────────

  app.get("/api/vessels", async (req, res) => {
    const { search = '', limit = '50', offset = '0' } = req.query;
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/vessels?search=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const where = search.trim() ? "WHERE name ILIKE $1 OR imo ILIKE $1 OR asset_type ILIKE $1" : "";
    const params = search.trim() ? [`%${search.trim()}%`] : [];
    const limOffIdx = params.length;
    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM vessels ${where}`, params);
    const rows  = await query(`SELECT * FROM vessels ${where} ORDER BY name LIMIT $${limOffIdx+1} OFFSET $${limOffIdx+2}`, [...params, lim, off]);
    ok(res, { results: rows.map(mapVessel), total: Number(total), limit: lim, offset: off });
  });
  app.get("/api/vessels/search", async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return ok(res, []);
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/vessels/search?q=${encodeURIComponent(q)}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, (await query("SELECT * FROM vessels WHERE name ILIKE $1 OR imo ILIKE $1 LIMIT 12", [`%${q}%`])).map(mapVessel));
  });
  app.get("/api/vessels/:imo", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/vessels/${req.params.imo}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [r] = await query("SELECT * FROM vessels WHERE imo=$1", [req.params.imo]); if (!r) return err(res,"Not found",404); ok(res,mapVessel(r));
  });
  app.post("/api/vessels", write, async (req, res) => {
    const { imo, name, assetType='', flagIso2='', flagName='', buildYear=null, grossTonnage=null } = req.body;
    if (!imo || !name) return err(res, "imo and name required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/vessels", { imo, name, assetType, flagIso2, flagName, buildYear, grossTonnage }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      await query("INSERT INTO vessels (imo,name,asset_type,flag_iso2,flag_name,build_year,gross_tonnage) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [imo.trim(), name.trim(), assetType, flagIso2, flagName, buildYear, grossTonnage]);
      ok(res, mapVessel({ imo: imo.trim(), name: name.trim(), asset_type: assetType, flag_iso2: flagIso2, flag_name: flagName, build_year: buildYear, gross_tonnage: grossTonnage }), 201);
    }
    catch(e) { err(res, isUniqueViolation(e) ? `Vessel ${imo} already exists` : e.message); }
  });
  app.put("/api/vessels/:imo", write, async (req, res) => {
    const { name, assetType='', flagIso2='', flagName='', buildYear=null, grossTonnage=null } = req.body;
    if (!name) return err(res, "name required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/vessels/${req.params.imo}`, { name, assetType, flagIso2, flagName, buildYear, grossTonnage })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const updated = await query("UPDATE vessels SET name=$1, asset_type=$2, flag_iso2=$3, flag_name=$4, build_year=$5, gross_tonnage=$6 WHERE imo=$7 RETURNING imo",
      [name, assetType, flagIso2, flagName, buildYear, grossTonnage, req.params.imo]);
    if (updated.length===0) return err(res,"Not found",404);
    ok(res, mapVessel({ imo: req.params.imo, name, asset_type: assetType, flag_iso2: flagIso2, flag_name: flagName, build_year: buildYear, gross_tonnage: grossTonnage }));
  });
  app.delete("/api/vessels/:imo", write, async (req, res) => {
    if (await isRemote()) {
      try { await callMdmService("DELETE", `/internal/vessels/${req.params.imo}`); return ok(res, { deleted: req.params.imo }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const deleted = await query("DELETE FROM vessels WHERE imo=$1 RETURNING imo", [req.params.imo]); if (deleted.length===0) return err(res,"Not found",404); ok(res,{deleted:req.params.imo});
  });

  // ─── Port Locations ───────────────────────────────────────────────────────

  app.get("/api/port-locations", async (req, res) => {
    const { search='', country='', limit='50', offset='0' } = req.query;
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/port-locations?search=${encodeURIComponent(search)}&country=${encodeURIComponent(country)}&limit=${limit}&offset=${offset}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const clauses = [], params = [];
    const p = v => { params.push(v); return `$${params.length}`; };
    if (search.trim()) clauses.push(`(unlocode ILIKE ${p(`%${search.trim().toUpperCase()}%`)} OR name ILIKE ${p(`%${search.trim()}%`)})`);
    if (country.trim()) clauses.push(`country_code=${p(country.trim().toUpperCase())}`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM port_locations ${where}`, params);
    const rows  = await query(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ${p(lim)} OFFSET ${p(off)}`, params);
    ok(res, { results: rows.map(mapPortLocation), total: Number(total), limit: lim, offset: off });
  });
  app.get("/api/port-locations/:code/links", async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/port-locations/${code}/links`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const rows = await query(`SELECT CASE WHEN lp.primary_unlocode=$1 THEN lp.linked_unlocode ELSE lp.primary_unlocode END AS unlocode, pl.name, lp.note FROM linked_ports lp LEFT JOIN port_locations pl ON pl.unlocode=(CASE WHEN lp.primary_unlocode=$1 THEN lp.linked_unlocode ELSE lp.primary_unlocode END) WHERE lp.primary_unlocode=$1 OR lp.linked_unlocode=$1 ORDER BY unlocode`, [code]);
    ok(res, rows);
  });
  app.get("/api/port-locations/:code/lanes", async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/port-locations/${code}/lanes`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [port] = await query("SELECT country_code FROM port_locations WHERE unlocode=$1", [code]);
    if (!port) return ok(res, { lanes: [], primary: null });
    const lanes = await query("SELECT ctl.lane_code AS code, tl.name FROM country_trade_lanes ctl JOIN trade_lanes tl ON tl.code=ctl.lane_code WHERE ctl.iso2=$1 ORDER BY ctl.lane_code", [port.country_code]);
    ok(res, { lanes, primary: lanes[0]?.code || null });
  });
  app.get("/api/port-locations/:unlocode", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/port-locations/${req.params.unlocode.toUpperCase()}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [r] = await query("SELECT * FROM port_locations WHERE unlocode=$1", [req.params.unlocode.toUpperCase()]); if (!r) return err(res,"Not found",404); ok(res,mapPortLocation(r));
  });
  app.post("/api/port-locations", write, async (req, res) => {
    const { unlocode, name, latitude=0, longitude=0, countryCode='', zoneCode='' } = req.body;
    if (!unlocode || !name) return err(res, "unlocode and name required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/port-locations", { unlocode, name, latitude, longitude, countryCode, zoneCode }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const code = unlocode.toUpperCase().trim();
    const derivedCC = code.length >= 2 ? code.slice(0, 2) : countryCode.trim().toUpperCase();
    const finalCC = countryCode.trim().toUpperCase() || derivedCC;
    const now = new Date().toISOString();
    try {
      const timezone = timezoneFor({ unlocode: code, countryCode: finalCC, latitude, longitude });
      await query("INSERT INTO port_locations (unlocode,name,latitude,longitude,country_code,zone_code,timezone,last_synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [code, name.trim(), latitude, longitude, finalCC, zoneCode.trim(), timezone, now]);
      ok(res, mapPortLocation({ unlocode: code, name: name.trim(), latitude, longitude, country_code: finalCC, zone_code: zoneCode.trim(), timezone, last_synced_at: now }), 201);
    }
    catch(e) { err(res, isUniqueViolation(e) ? `Port ${unlocode} already exists` : e.message); }
  });
  app.put("/api/port-locations/:unlocode", write, async (req, res) => {
    const { name, latitude=0, longitude=0, countryCode='', zoneCode='' } = req.body;
    if (!name) return err(res, "name required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/port-locations/${req.params.unlocode.toUpperCase()}`, { name, latitude, longitude, countryCode, zoneCode })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const cc = countryCode.trim().toUpperCase() || req.params.unlocode.slice(0, 2).toUpperCase();
    // A UN/LOCODE in data/port-timezones.json keeps that zone; any other location's zone follows
    // its (possibly edited) coordinates and country.
    const timezone = timezoneFor({ unlocode: req.params.unlocode, countryCode: cc, latitude, longitude });
    const updated = await query("UPDATE port_locations SET name=$1, latitude=$2, longitude=$3, country_code=$4, zone_code=$5, timezone=$6, last_synced_at=$7 WHERE unlocode=$8 RETURNING unlocode",
      [name, latitude, longitude, cc, zoneCode, timezone, new Date().toISOString(), req.params.unlocode.toUpperCase()]);
    if (updated.length===0) return err(res,"Not found",404);
    // country_code: cc, not the raw countryCode.toUpperCase() — cc carries the same
    // derive-from-unlocode-prefix fallback the UPDATE above actually persisted (2026-09-05
    // audit: a blank/omitted countryCode had the response showing '' while the DB row was
    // correctly saved with the derived 2-letter code, confirmed live).
    ok(res, mapPortLocation({ unlocode: req.params.unlocode.toUpperCase(), name, latitude, longitude, country_code: cc, zone_code: zoneCode, timezone }));
  });
  app.delete("/api/port-locations/:unlocode", write, async (req, res) => {
    if (await isRemote()) {
      try { await callMdmService("DELETE", `/internal/port-locations/${req.params.unlocode.toUpperCase()}`); return ok(res, { deleted: req.params.unlocode }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const code = req.params.unlocode.toUpperCase();
    // linked_ports references this table too but is ON DELETE CASCADE (a pair losing one of its
    // ports has nothing left to conflict-detect) — only these two RESTRICT-by-default FKs can
    // actually block the delete, so only they need an app-level guard for a clean 409 instead of
    // a raw FK-violation 500.
    const [coverageInUse] = await query("SELECT id FROM carrier_office_coverage WHERE unlocode=$1 LIMIT 1", [code]);
    if (coverageInUse) return err(res, "Port is used by a carrier office's coverage (Master Data → Carriers) — remove that row first");
    const [loopInUse] = await query("SELECT id FROM loop_code_ports WHERE port_unlocode=$1 LIMIT 1", [code]);
    if (loopInUse) return err(res, "Port is referenced by a loop code's rotation — remove it from that rotation first");
    const deleted = await query("DELETE FROM port_locations WHERE unlocode=$1 RETURNING unlocode", [code]); if (deleted.length===0) return err(res,"Not found",404); ok(res,{deleted:code});
  });

  // ─── Linked Ports ─────────────────────────────────────────────────────────

  app.get("/api/linked-ports", async (req, res) => {
    if (await isRemote()) {
      const qs = new URLSearchParams(req.query).toString();
      try { return ok(res, await callMdmService("GET", `/internal/linked-ports${qs ? `?${qs}` : ""}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const rows = await query(`SELECT lp.*, p1.name AS primary_name, p2.name AS linked_name FROM linked_ports lp LEFT JOIN port_locations p1 ON p1.unlocode=lp.primary_unlocode LEFT JOIN port_locations p2 ON p2.unlocode=lp.linked_unlocode ORDER BY lp.primary_unlocode`);
    let mapped = rows.map(mapLinkedPort);
    // Pagination is opt-in (same shape as GET /api/shipments) — every existing caller that
    // omits limit/offset keeps getting today's exact bare-array response.
    if (req.query.limit === undefined && req.query.offset === undefined) return ok(res, mapped);
    if (req.query.search) {
      const q = req.query.search.toLowerCase();
      mapped = mapped.filter(l =>
        l.primaryUnlocode.toLowerCase().includes(q) || l.linkedUnlocode.toLowerCase().includes(q)
        || (l.primaryName || '').toLowerCase().includes(q) || (l.linkedName || '').toLowerCase().includes(q)
        || (l.note || '').toLowerCase().includes(q));
    }
    const lim = Math.min(parseInt(req.query.limit) || 50, 500), off = parseInt(req.query.offset) || 0;
    ok(res, { results: mapped.slice(off, off + lim), total: mapped.length, limit: lim, offset: off });
  });
  app.post("/api/linked-ports", write, async (req, res) => {
    const { primaryUnlocode, linkedUnlocode, note='' } = req.body;
    if (!primaryUnlocode || !linkedUnlocode) return err(res, "primaryUnlocode and linkedUnlocode required");
    if (primaryUnlocode.toUpperCase() === linkedUnlocode.toUpperCase()) return err(res, "A port cannot be linked to itself");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/linked-ports", { primaryUnlocode, linkedUnlocode, note }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const id = `LNK-${uid()}`;
    try {
      await query("INSERT INTO linked_ports (id,primary_unlocode,linked_unlocode,note) VALUES ($1,$2,$3,$4)",
        [id, primaryUnlocode.toUpperCase(), linkedUnlocode.toUpperCase(), note]);
      ok(res, { id, primaryUnlocode: primaryUnlocode.toUpperCase(), linkedUnlocode: linkedUnlocode.toUpperCase(), note }, 201);
    }
    catch(e) { err(res, isUniqueViolation(e) ? "This port link already exists" : e.message); }
  });
  app.put("/api/linked-ports/:id", write, async (req, res) => {
    const { note='' } = req.body;
    if (await isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/linked-ports/${req.params.id}`, { note })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const updated = await query("UPDATE linked_ports SET note=$1 WHERE id=$2 RETURNING id", [note, req.params.id]);
    if (updated.length===0) return err(res,"Not found",404);
    const [r] = await query("SELECT lp.*, p1.name AS primary_name, p2.name AS linked_name FROM linked_ports lp LEFT JOIN port_locations p1 ON p1.unlocode=lp.primary_unlocode LEFT JOIN port_locations p2 ON p2.unlocode=lp.linked_unlocode WHERE lp.id=$1", [req.params.id]);
    ok(res, mapLinkedPort(r));
  });
  app.delete("/api/linked-ports/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { await callMdmService("DELETE", `/internal/linked-ports/${req.params.id}`); return ok(res, { deleted: req.params.id }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const deleted = await query("DELETE FROM linked_ports WHERE id=$1 RETURNING id", [req.params.id]); if (deleted.length===0) return err(res,"Not found",404); ok(res,{deleted:req.params.id});
  });

  // ─── Carrier Agents ───────────────────────────────────────────────────────
  // Gone since 2026-11-16: a carrier's local offices are carrier offices on its profile (routes/carrier-offices.js,
  // lib/carrier-offices.js, ARCHITECTURE.md §8.53), kept by this server whatever the Master Data source.

  // ─── Trade Lanes ──────────────────────────────────────────────────────────

  app.get("/api/trade-lanes", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", "/internal/trade-lanes")); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, (await query(`
      SELECT tl.*, COUNT(ctl.iso2) AS country_count
      FROM trade_lanes tl
      LEFT JOIN country_trade_lanes ctl ON ctl.lane_code = tl.code
      GROUP BY tl.code
      ORDER BY tl.code
    `)).map(mapTradeLane));
  });

  app.get("/api/trade-lanes/:code/countries", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/trade-lanes/${req.params.code.toUpperCase()}/countries`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const rows = await query(`
      SELECT c.iso2, c.name, c.un_member, c.region_code
      FROM country_trade_lanes ctl
      JOIN countries c ON c.iso2 = ctl.iso2
      WHERE ctl.lane_code = $1
      ORDER BY c.name
    `, [req.params.code.toUpperCase()]);
    ok(res, rows.map(mapCountry));
  });

  app.put("/api/trade-lanes/:code/countries", write, async (req, res) => {
    const code  = req.params.code.toUpperCase();
    const iso2s = Array.isArray(req.body.iso2s) ? req.body.iso2s : [];
    if (await isRemote()) {
      try {
        const result = await callMdmService("PUT", `/internal/trade-lanes/${code}/countries`, { iso2s });
        await rebuildPortLanesMap();
        return ok(res, result);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      await transaction(async (tx) => {
        await tx.query("DELETE FROM country_trade_lanes WHERE lane_code = $1", [code]);
        for (const iso2 of iso2s) {
          await tx.query("INSERT INTO country_trade_lanes (iso2, lane_code) VALUES ($1, $2) ON CONFLICT (iso2, lane_code) DO NOTHING", [iso2.toUpperCase(), code]);
        }
      });
      await rebuildPortLanesMap();
      ok(res, { code, iso2s });
    } catch(e) { err(res, e.message); }
  });

  app.post("/api/trade-lanes", write, async (req, res) => {
    const { code, name, description='', transitDays=0 } = req.body;
    if (!code || !name) return err(res, "code and name required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/trade-lanes", { code, name, description, transitDays }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      const c = code.toUpperCase().trim();
      await query("INSERT INTO trade_lanes (code,name,description,transit_days) VALUES ($1,$2,$3,$4)", [c, name.trim(), description.trim(), Number(transitDays) || 0]);
      ok(res, { code: c, name: name.trim(), description: description.trim(), transitDays: Number(transitDays) || 0, countryCount: 0 }, 201);
    } catch(e) { err(res, isUniqueViolation(e) ? `Lane ${code} already exists` : e.message); }
  });
  app.put("/api/trade-lanes/:code", write, async (req, res) => {
    const { name, description='', transitDays=0 } = req.body;
    if (!name) return err(res, "name required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/trade-lanes/${req.params.code}`, { name, description, transitDays })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const updated = await query("UPDATE trade_lanes SET name=$1, description=$2, transit_days=$3 WHERE code=$4 RETURNING code", [name, description, Number(transitDays) || 0, req.params.code]);
    if (updated.length===0) return err(res,"Not found",404);
    ok(res, { code: req.params.code, name, description, transitDays: Number(transitDays) || 0 });
  });
  app.get("/api/trade-lanes/transit-suggestion", async (req, res) => {
    const { pol, pod } = req.query;
    if (!pol || !pod) return ok(res, { days: null, lane: null });
    // longestLane is a pure in-memory lookup against portLanesMap (the monolith's own cache,
    // kept fresh in either mdm_source mode by rebuildPortLanesMap — see server.js) — resolved
    // here regardless of mode, then only the actual transit-days lookup branches remote.
    const polLane = longestLane(pol.toUpperCase());
    const podLane = longestLane(pod.toUpperCase());
    if (!polLane || !podLane || polLane !== podLane) return ok(res, { days: null, lane: polLane && podLane ? `${polLane} → ${podLane}` : null });
    if (await isRemote()) {
      try {
        const { days } = await callMdmService("GET", `/internal/trade-lanes/transit-suggestion?polLane=${polLane}&podLane=${podLane}`);
        return ok(res, { days, lane: polLane });
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [row] = await query("SELECT transit_days FROM trade_lanes WHERE code=$1", [polLane]);
    ok(res, { days: row?.transit_days || null, lane: polLane });
  });
  app.delete("/api/trade-lanes/:code", write, async (req, res) => {
    if (await isRemote()) {
      try { await callMdmService("DELETE", `/internal/trade-lanes/${req.params.code}`); return ok(res, { deleted: req.params.code }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const deleted = await query("DELETE FROM trade_lanes WHERE code=$1 RETURNING code", [req.params.code]); if (deleted.length===0) return err(res,"Not found",404); ok(res,{deleted:req.params.code});
  });

  app.get("/api/country-trade-lanes", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", "/internal/country-trade-lanes")); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, await query("SELECT * FROM country_trade_lanes"));
  });
  app.post("/api/country-trade-lanes", write, async (req, res) => {
    const { iso2, laneCode } = req.body;
    if (!iso2 || !laneCode) return err(res, "iso2 and laneCode required");
    if (await isRemote()) {
      try {
        const result = await callMdmService("POST", "/internal/country-trade-lanes", { iso2, laneCode });
        await rebuildPortLanesMap();
        return ok(res, result, 201);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      await query("INSERT INTO country_trade_lanes (iso2,lane_code) VALUES ($1,$2)", [iso2.toUpperCase(), laneCode.toUpperCase()]);
      await rebuildPortLanesMap();
      ok(res, { iso2: iso2.toUpperCase(), laneCode: laneCode.toUpperCase() }, 201);
    }
    catch(e) { err(res, isUniqueViolation(e) ? "Assignment already exists" : e.message); }
  });
  app.put("/api/countries/:iso2/trade-lanes", write, async (req, res) => {
    const iso2  = req.params.iso2.toUpperCase();
    const lanes = Array.isArray(req.body.lanes) ? req.body.lanes : [];
    if (await isRemote()) {
      try {
        const result = await callMdmService("PUT", `/internal/countries/${iso2}/trade-lanes`, { lanes });
        await rebuildPortLanesMap();
        return ok(res, result);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      await transaction(async (tx) => {
        await tx.query("DELETE FROM country_trade_lanes WHERE iso2 = $1", [iso2]);
        for (const lane of lanes) {
          await tx.query("INSERT INTO country_trade_lanes (iso2, lane_code) VALUES ($1, $2) ON CONFLICT (iso2, lane_code) DO NOTHING", [iso2, lane.toUpperCase()]);
        }
      });
      await rebuildPortLanesMap();
      ok(res, { iso2, lanes });
    } catch(e) { err(res, e.message); }
  });
  app.delete("/api/country-trade-lanes/:iso2/:laneCode", write, async (req, res) => {
    if (await isRemote()) {
      try {
        await callMdmService("DELETE", `/internal/country-trade-lanes/${req.params.iso2}/${req.params.laneCode}`);
        await rebuildPortLanesMap();
        return ok(res, { deleted: true });
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    await query("DELETE FROM country_trade_lanes WHERE iso2=$1 AND lane_code=$2", [req.params.iso2, req.params.laneCode]); await rebuildPortLanesMap(); ok(res, { deleted: true });
  });

  // ─── Regions ──────────────────────────────────────────────────────────────

  app.get("/api/regions", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", "/internal/regions")); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, (await query("SELECT * FROM regions ORDER BY code")).map(mapRegion));
  });
  app.post("/api/regions", write, async (req, res) => {
    const { code, name, description='' } = req.body;
    if (!code || !name) return err(res, "code and name required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/regions", { code, name, description }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      await query("INSERT INTO regions (code,name,description) VALUES ($1,$2,$3)", [code.toUpperCase().trim(), name.trim(), description.trim()]);
      ok(res, { code: code.toUpperCase().trim(), name: name.trim(), description: description.trim() }, 201);
    } catch(e) { err(res, isUniqueViolation(e) ? `Region ${code} already exists` : e.message); }
  });
  app.put("/api/regions/:code", write, async (req, res) => {
    const { name, description='' } = req.body;
    if (!name) return err(res, "name required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/regions/${req.params.code}`, { name, description })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const updated = await query("UPDATE regions SET name=$1, description=$2 WHERE code=$3 RETURNING code", [name, description, req.params.code]);
    if (updated.length===0) return err(res,"Not found",404);
    ok(res, { code: req.params.code, name, description });
  });
  app.delete("/api/regions/:code", write, async (req, res) => {
    if (await isRemote()) {
      try { await callMdmService("DELETE", `/internal/regions/${req.params.code}`); return ok(res, { deleted: req.params.code }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const deleted = await query("DELETE FROM regions WHERE code=$1 RETURNING code", [req.params.code]); if (deleted.length===0) return err(res,"Not found",404); ok(res,{deleted:req.params.code});
  });

  // ─── Countries ────────────────────────────────────────────────────────────

  app.get("/api/countries", async (req, res) => {
    const { search='', limit='50', offset='0' } = req.query;
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/countries?search=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const lim = Math.min(parseInt(limit)||50, 300), off = parseInt(offset)||0;
    const where = search.trim() ? "WHERE c.iso2 ILIKE $1 OR c.name ILIKE $2" : "";
    const params = search.trim() ? [`%${search.trim().toUpperCase()}%`, `%${search.trim()}%`] : [];
    const limOffIdx = params.length;
    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM countries c ${where}`, params);
    const rows  = await query(`
      SELECT c.*, COUNT(pl.unlocode) AS port_count
      FROM countries c
      LEFT JOIN port_locations pl ON pl.country_code = c.iso2
      ${where}
      GROUP BY c.iso2
      ORDER BY c.name
      LIMIT $${limOffIdx+1} OFFSET $${limOffIdx+2}
    `, [...params, lim, off]);
    ok(res, { results: rows.map(mapCountry), total: Number(total), limit: lim, offset: off });
  });
  app.post("/api/countries", write, async (req, res) => {
    const { iso2, name, unMember=1, regionCode='' } = req.body;
    if (!iso2 || !name) return err(res, "iso2 and name required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/countries", { iso2, name, unMember, regionCode }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      await query("INSERT INTO countries (iso2,name,un_member,region_code) VALUES ($1,$2,$3,$4)", [iso2.toUpperCase().trim(), name.trim(), !!unMember, regionCode.trim()]);
      ok(res, mapCountry({ iso2: iso2.toUpperCase().trim(), name: name.trim(), un_member: !!unMember, region_code: regionCode.trim() }), 201);
    }
    catch(e) { err(res, isUniqueViolation(e) ? `Country ${iso2} already exists` : e.message); }
  });
  app.put("/api/countries/:iso2", write, async (req, res) => {
    const iso2 = req.params.iso2.toUpperCase();
    if (await isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/countries/${iso2}`, req.body)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [existing] = await query("SELECT * FROM countries WHERE iso2=$1", [iso2]);
    if (!existing) return err(res, "Not found", 404);
    const { name: nameIn, unMember=1, regionCode='', invoiceAlertBusinessDays, invoiceEscalationBusinessDays } = req.body;
    // Falls back to the existing row like the two invoice-day fields just below already do —
    // omitting `name` from a partial update must preserve it, not bind `undefined` into the
    // UPDATE (which node:sqlite rejects, crashing the request).
    const name = nameIn !== undefined ? nameIn : existing.name;
    // Invoice Collections thresholds (Epic TKT-G11AHW) — country-level, admin-only for this pass:
    // no "country manager" role exists in this app's role model, a deliberate scoping decision
    // rather than an oversight (see the epic's own story description).
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
    await query(`UPDATE countries SET name=$1, un_member=$2, region_code=$3,
      invoice_alert_business_days=$4, invoice_escalation_business_days=$5 WHERE iso2=$6`,
      [name, !!unMember, regionCode, alertDays, escalationDays, iso2]);
    ok(res, mapCountry({ iso2, name, un_member: !!unMember, region_code: regionCode,
      invoice_alert_business_days: alertDays, invoice_escalation_business_days: escalationDays }));
  });
  app.delete("/api/countries/:iso2", write, async (req, res) => {
    if (await isRemote()) {
      try { await callMdmService("DELETE", `/internal/countries/${req.params.iso2.toUpperCase()}`); return ok(res, { deleted: req.params.iso2 }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const code = req.params.iso2.toUpperCase();
    // A carrier office's coverage names countries (no foreign key: a clean 409 rather than a row left pointing nowhere).
    const [coverageInUse] = await query("SELECT id FROM carrier_office_coverage WHERE country_iso2=$1 LIMIT 1", [code]);
    if (coverageInUse) return err(res, "Country is used by a carrier office's coverage (Master Data → Carriers) — remove that row first");
    const deleted = await query("DELETE FROM countries WHERE iso2=$1 RETURNING iso2", [code]); if (deleted.length===0) return err(res,"Not found",404); ok(res,{deleted:code});
  });
  app.get("/api/countries/:iso2/locations", async (req, res) => {
    const iso2   = req.params.iso2.toUpperCase();
    const search = (req.query.search || "").trim();
    const lim    = Math.min(parseInt(req.query.limit  || "50",  10), 200);
    const off    = parseInt(req.query.offset || "0", 10);
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/countries/${iso2}/locations?search=${encodeURIComponent(search)}&limit=${lim}&offset=${off}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const where  = search ? "WHERE country_code=$1 AND (unlocode ILIKE $2 OR name ILIKE $2)" : "WHERE country_code=$1";
    const params = search ? [iso2, `%${search}%`] : [iso2];
    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM port_locations ${where}`, params);
    const rows   = await query(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, lim, off]);
    ok(res, { results: rows.map(mapPortLocation), total: Number(total), limit: lim, offset: off });
  });

  // ─── UN Location Codes ────────────────────────────────────────────────────

  app.get("/api/unlocodes", async (req, res) => {
    const { search='', limit='50', offset='0' } = req.query;
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/unlocodes?search=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const where = search.trim() ? "WHERE unlocode ILIKE $1 OR name ILIKE $2" : "";
    const params = search.trim() ? [`%${search.trim().toUpperCase()}%`, `%${search.trim()}%`] : [];
    const limOffIdx = params.length;
    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM port_locations ${where}`, params);
    const rows  = await query(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT $${limOffIdx+1} OFFSET $${limOffIdx+2}`, [...params, lim, off]);
    ok(res, { results: rows.map(mapPortLocation), total: Number(total), limit: lim, offset: off });
  });

  // ─── Commodities ──────────────────────────────────────────────────────────

  app.get("/api/commodities", async (req, res) => {
    const { search='', grade='', limit='50', offset='0' } = req.query;
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/commodities?search=${encodeURIComponent(search)}&grade=${encodeURIComponent(grade)}&limit=${limit}&offset=${offset}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const lim = Math.min(parseInt(limit)||50, 300), off = parseInt(offset)||0;
    const s = search.trim(), g = grade.trim().toUpperCase();
    const clauses = [], params = [];
    const p = v => { params.push(v); return `$${params.length}`; };
    if (s) { const sp = `%${s}%`; clauses.push(`(code ILIKE ${p(sp)} OR description ILIKE ${p(sp)} OR grade_name ILIKE ${p(sp)})`); }
    if (g) clauses.push(`grade_code=${p(g)}`);
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM commodities ${where}`, params);
    const rows   = await query(`SELECT * FROM commodities ${where} ORDER BY code LIMIT ${p(lim)} OFFSET ${p(off)}`, params);
    ok(res, { results: rows.map(mapCommodity), total: Number(total), limit: lim, offset: off });
  });
  app.get("/api/commodities/search", async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return ok(res, []);
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/commodities/search?q=${encodeURIComponent(q)}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, (await query("SELECT * FROM commodities WHERE code ILIKE $1 OR description ILIKE $1 ORDER BY code LIMIT 12", [`%${q}%`])).map(mapCommodity));
  });
  app.get("/api/commodities/:code", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/commodities/${req.params.code}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [r] = await query("SELECT * FROM commodities WHERE code=$1", [req.params.code]); if (!r) return err(res,"Not found",404); ok(res,mapCommodity(r));
  });
  app.post("/api/commodities", write, async (req, res) => {
    const { code, description, gradeCode='E', gradeName='General Cargo' } = req.body;
    if (!code || !description) return err(res, "code and description required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/commodities", { code, description, gradeCode, gradeName }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      await query("INSERT INTO commodities (code,description,grade_code,grade_name) VALUES ($1,$2,$3,$4)", [code.trim(), description.trim(), gradeCode, gradeName]);
      ok(res, mapCommodity({ code: code.trim(), description: description.trim(), grade_code: gradeCode, grade_name: gradeName }), 201);
    }
    catch(e) { err(res, isUniqueViolation(e) ? `Commodity ${code} already exists` : e.message); }
  });
  app.put("/api/commodities/:code", write, async (req, res) => {
    const { description, gradeCode='E', gradeName='General Cargo' } = req.body;
    if (!description) return err(res, "description required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/commodities/${req.params.code}`, { description, gradeCode, gradeName })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const updated = await query("UPDATE commodities SET description=$1, grade_code=$2, grade_name=$3 WHERE code=$4 RETURNING code", [description, gradeCode, gradeName, req.params.code]);
    if (updated.length===0) return err(res,"Not found",404);
    ok(res, mapCommodity({ code: req.params.code, description, grade_code: gradeCode, grade_name: gradeName }));
  });
  app.delete("/api/commodities/:code", write, async (req, res) => {
    if (await isRemote()) {
      try { await callMdmService("DELETE", `/internal/commodities/${req.params.code}`); return ok(res, { deleted: req.params.code }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const deleted = await query("DELETE FROM commodities WHERE code=$1 RETURNING code", [req.params.code]); if (deleted.length===0) return err(res,"Not found",404); ok(res,{deleted:req.params.code});
  });
};
