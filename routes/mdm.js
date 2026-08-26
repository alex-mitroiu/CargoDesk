"use strict";

module.exports = function mdmRoutes(app, ctx) {
  const { db, ok, err, uid, isUniqueViolation, requireRole, getSettings, callMdmService, callCustomerService,
          mapCarrier, mapVessel, mapPortLocation, mapLinkedPort, mapTradeLane, mapCarrierAgent,
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
  const isRemote = () => (getSettings().mdm_source || "local") === "remote";

  // ─── Carriers ─────────────────────────────────────────────────────────────

  app.get("/api/carriers", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", "/internal/carriers")); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, db.prepare("SELECT * FROM carriers ORDER BY name").all().map(mapCarrier));
  });
  app.get("/api/carriers/:code", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/carriers/${req.params.code}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const r = db.prepare("SELECT * FROM carriers WHERE code=?").get(req.params.code); if (!r) return err(res,"Not found",404); ok(res,mapCarrier(r));
  });
  app.post("/api/carriers", write, async (req, res) => {
    const { code, name, shortName = '' } = req.body;
    if (!code || !name) return err(res, "code and name required");
    if (isRemote()) {
      try {
        const created = await callMdmService("POST", "/internal/carriers", { code, name, shortName });
        logEntityEvent('carrier', created.code, 'CREATED', null, null, null, JSON.stringify({ name: name.trim() }));
        return ok(res, created, 201);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      const codeU = code.toUpperCase().trim();
      db.prepare("INSERT INTO carriers (code,name,short_name) VALUES (?,?,?)").run(codeU, name.trim(), shortName.trim());
      logEntityEvent('carrier', codeU, 'CREATED', null, null, null, JSON.stringify({ name: name.trim() }));
      ok(res, mapCarrier({ code: codeU, name: name.trim(), short_name: shortName.trim() }), 201);
    } catch(e) { err(res, isUniqueViolation(e) ? `Carrier ${code} already exists` : e.message); }
  });
  app.put("/api/carriers/:code", write, async (req, res) => {
    const { name, shortName = '' } = req.body;
    if (isRemote()) {
      try {
        const before = await callMdmService("GET", `/internal/carriers/${req.params.code}`).catch(() => null);
        const updated = await callMdmService("PUT", `/internal/carriers/${req.params.code}`, { name, shortName });
        if (before && before.name !== name) logEntityEvent('carrier', req.params.code, 'UPDATED', 'name', before.name, name);
        return ok(res, updated);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const existing = db.prepare("SELECT * FROM carriers WHERE code=?").get(req.params.code);
    const info = db.prepare("UPDATE carriers SET name=?, short_name=? WHERE code=?").run(name, shortName, req.params.code);
    if (info.changes === 0) return err(res, "Not found", 404);
    if (existing && existing.name !== name) logEntityEvent('carrier', req.params.code, 'UPDATED', 'name', existing.name, name);
    ok(res, mapCarrier({ code: req.params.code, name, short_name: shortName }));
  });
  app.delete("/api/carriers/:code", write, async (req, res) => {
    if (isRemote()) {
      try {
        const existing = await callMdmService("GET", `/internal/carriers/${req.params.code}`).catch(() => null);
        await callMdmService("DELETE", `/internal/carriers/${req.params.code}`);
        if (existing) logEntityEvent('carrier', req.params.code, 'DELETED', null, null, null, JSON.stringify({ name: existing.name }));
        return ok(res, { deleted: req.params.code });
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const existing = db.prepare("SELECT * FROM carriers WHERE code=?").get(req.params.code);
    const info = db.prepare("DELETE FROM carriers WHERE code=?").run(req.params.code);
    if (info.changes===0) return err(res,"Not found",404);
    if (existing) logEntityEvent('carrier', req.params.code, 'DELETED', null, null, null, JSON.stringify({ name: existing.name }));
    ok(res,{deleted:req.params.code});
  });

  // ─── Vessels ──────────────────────────────────────────────────────────────

  app.get("/api/vessels", async (req, res) => {
    const { search = '', limit = '50', offset = '0' } = req.query;
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/vessels?search=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const where = search.trim() ? "WHERE name LIKE ? OR imo LIKE ? OR asset_type LIKE ?" : "";
    const params = search.trim() ? [`%${search.trim()}%`,`%${search.trim()}%`,`%${search.trim()}%`] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM vessels ${where}`).get(...params).n;
    const rows  = db.prepare(`SELECT * FROM vessels ${where} ORDER BY name LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapVessel), total, limit: lim, offset: off });
  });
  app.get("/api/vessels/search", async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return ok(res, []);
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/vessels/search?q=${encodeURIComponent(q)}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, db.prepare("SELECT * FROM vessels WHERE name LIKE ? OR imo LIKE ? LIMIT 12").all(`%${q}%`, `%${q}%`).map(mapVessel));
  });
  app.get("/api/vessels/:imo", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/vessels/${req.params.imo}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const r = db.prepare("SELECT * FROM vessels WHERE imo=?").get(req.params.imo); if (!r) return err(res,"Not found",404); ok(res,mapVessel(r));
  });
  app.post("/api/vessels", write, async (req, res) => {
    const { imo, name, assetType='', flagIso2='', flagName='', buildYear=null, grossTonnage=null } = req.body;
    if (!imo || !name) return err(res, "imo and name required");
    if (isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/vessels", { imo, name, assetType, flagIso2, flagName, buildYear, grossTonnage }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    try { db.prepare("INSERT INTO vessels (imo,name,asset_type,flag_iso2,flag_name,build_year,gross_tonnage) VALUES (?,?,?,?,?,?,?)").run(imo.trim(), name.trim(), assetType, flagIso2, flagName, buildYear, grossTonnage); ok(res, mapVessel({ imo: imo.trim(), name: name.trim(), asset_type: assetType, flag_iso2: flagIso2, flag_name: flagName, build_year: buildYear, gross_tonnage: grossTonnage }), 201); }
    catch(e) { err(res, isUniqueViolation(e) ? `Vessel ${imo} already exists` : e.message); }
  });
  app.put("/api/vessels/:imo", write, async (req, res) => {
    const { name, assetType='', flagIso2='', flagName='', buildYear=null, grossTonnage=null } = req.body;
    if (isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/vessels/${req.params.imo}`, { name, assetType, flagIso2, flagName, buildYear, grossTonnage })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("UPDATE vessels SET name=?, asset_type=?, flag_iso2=?, flag_name=?, build_year=?, gross_tonnage=? WHERE imo=?").run(name, assetType, flagIso2, flagName, buildYear, grossTonnage, req.params.imo);
    if (info.changes===0) return err(res,"Not found",404);
    ok(res, mapVessel({ imo: req.params.imo, name, asset_type: assetType, flag_iso2: flagIso2, flag_name: flagName, build_year: buildYear, gross_tonnage: grossTonnage }));
  });
  app.delete("/api/vessels/:imo", write, async (req, res) => {
    if (isRemote()) {
      try { await callMdmService("DELETE", `/internal/vessels/${req.params.imo}`); return ok(res, { deleted: req.params.imo }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("DELETE FROM vessels WHERE imo=?").run(req.params.imo); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.imo});
  });

  // ─── Port Locations ───────────────────────────────────────────────────────

  app.get("/api/port-locations", async (req, res) => {
    const { search='', country='', limit='50', offset='0' } = req.query;
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/port-locations?search=${encodeURIComponent(search)}&country=${encodeURIComponent(country)}&limit=${limit}&offset=${offset}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const clauses = [], params = [];
    if (search.trim()) { clauses.push("(unlocode LIKE ? OR name LIKE ?)"); const s=`%${search.trim().toUpperCase()}%`; params.push(s, `%${search.trim()}%`); }
    if (country.trim()) { clauses.push("country_code=?"); params.push(country.trim().toUpperCase()); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS n FROM port_locations ${where}`).get(...params).n;
    const rows  = db.prepare(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
  });
  app.get("/api/port-locations/:code/links", async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/port-locations/${code}/links`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const rows = db.prepare(`SELECT CASE WHEN lp.primary_unlocode=? THEN lp.linked_unlocode ELSE lp.primary_unlocode END AS unlocode, pl.name, lp.note FROM linked_ports lp LEFT JOIN port_locations pl ON pl.unlocode=(CASE WHEN lp.primary_unlocode=? THEN lp.linked_unlocode ELSE lp.primary_unlocode END) WHERE lp.primary_unlocode=? OR lp.linked_unlocode=? ORDER BY unlocode`).all(code,code,code,code);
    ok(res, rows);
  });
  app.get("/api/port-locations/:code/lanes", async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/port-locations/${code}/lanes`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const port = db.prepare("SELECT country_code FROM port_locations WHERE unlocode=?").get(code);
    if (!port) return ok(res, { lanes: [], primary: null });
    const lanes = db.prepare("SELECT ctl.lane_code AS code, tl.name FROM country_trade_lanes ctl JOIN trade_lanes tl ON tl.code=ctl.lane_code WHERE ctl.iso2=? ORDER BY ctl.lane_code").all(port.country_code);
    ok(res, { lanes, primary: lanes[0]?.code || null });
  });
  app.get("/api/port-locations/:unlocode", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/port-locations/${req.params.unlocode.toUpperCase()}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const r = db.prepare("SELECT * FROM port_locations WHERE unlocode=?").get(req.params.unlocode.toUpperCase()); if (!r) return err(res,"Not found",404); ok(res,mapPortLocation(r));
  });
  app.post("/api/port-locations", write, async (req, res) => {
    const { unlocode, name, latitude=0, longitude=0, countryCode='', zoneCode='' } = req.body;
    if (!unlocode || !name) return err(res, "unlocode and name required");
    if (isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/port-locations", { unlocode, name, latitude, longitude, countryCode, zoneCode }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const code = unlocode.toUpperCase().trim();
    const derivedCC = code.length >= 2 ? code.slice(0, 2) : countryCode.trim().toUpperCase();
    const finalCC = countryCode.trim().toUpperCase() || derivedCC;
    const now = new Date().toISOString();
    try { db.prepare("INSERT INTO port_locations (unlocode,name,latitude,longitude,country_code,zone_code,last_synced_at) VALUES (?,?,?,?,?,?,?)").run(code, name.trim(), latitude, longitude, finalCC, zoneCode.trim(), now); ok(res, mapPortLocation({ unlocode: code, name: name.trim(), latitude, longitude, country_code: finalCC, zone_code: zoneCode.trim(), last_synced_at: now }), 201); }
    catch(e) { err(res, isUniqueViolation(e) ? `Port ${unlocode} already exists` : e.message); }
  });
  app.put("/api/port-locations/:unlocode", write, async (req, res) => {
    const { name, latitude=0, longitude=0, countryCode='', zoneCode='' } = req.body;
    if (isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/port-locations/${req.params.unlocode.toUpperCase()}`, { name, latitude, longitude, countryCode, zoneCode })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const cc = countryCode.toUpperCase() || req.params.unlocode.slice(0, 2).toUpperCase();
    const info = db.prepare("UPDATE port_locations SET name=?, latitude=?, longitude=?, country_code=?, zone_code=?, last_synced_at=? WHERE unlocode=?").run(name, latitude, longitude, cc, zoneCode, new Date().toISOString(), req.params.unlocode.toUpperCase());
    if (info.changes===0) return err(res,"Not found",404);
    ok(res, mapPortLocation({ unlocode: req.params.unlocode.toUpperCase(), name, latitude, longitude, country_code: countryCode.toUpperCase(), zone_code: zoneCode }));
  });
  app.delete("/api/port-locations/:unlocode", write, async (req, res) => {
    if (isRemote()) {
      try { await callMdmService("DELETE", `/internal/port-locations/${req.params.unlocode.toUpperCase()}`); return ok(res, { deleted: req.params.unlocode }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("DELETE FROM port_locations WHERE unlocode=?").run(req.params.unlocode.toUpperCase()); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.unlocode});
  });

  // ─── Linked Ports ─────────────────────────────────────────────────────────

  app.get("/api/linked-ports", async (req, res) => {
    if (isRemote()) {
      const qs = new URLSearchParams(req.query).toString();
      try { return ok(res, await callMdmService("GET", `/internal/linked-ports${qs ? `?${qs}` : ""}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const rows = db.prepare(`SELECT lp.*, p1.name AS primary_name, p2.name AS linked_name FROM linked_ports lp LEFT JOIN port_locations p1 ON p1.unlocode=lp.primary_unlocode LEFT JOIN port_locations p2 ON p2.unlocode=lp.linked_unlocode ORDER BY lp.primary_unlocode`).all();
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
    if (isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/linked-ports", { primaryUnlocode, linkedUnlocode, note }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const id = `LNK-${uid()}`;
    try { db.prepare("INSERT INTO linked_ports (id,primary_unlocode,linked_unlocode,note) VALUES (?,?,?,?)").run(id, primaryUnlocode.toUpperCase(), linkedUnlocode.toUpperCase(), note); ok(res, { id, primaryUnlocode: primaryUnlocode.toUpperCase(), linkedUnlocode: linkedUnlocode.toUpperCase(), note }, 201); }
    catch(e) { err(res, isUniqueViolation(e) ? "This port link already exists" : e.message); }
  });
  app.put("/api/linked-ports/:id", write, async (req, res) => {
    const { note='' } = req.body;
    if (isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/linked-ports/${req.params.id}`, { note })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("UPDATE linked_ports SET note=? WHERE id=?").run(note, req.params.id);
    if (info.changes===0) return err(res,"Not found",404);
    const r = db.prepare("SELECT lp.*, p1.name AS primary_name, p2.name AS linked_name FROM linked_ports lp LEFT JOIN port_locations p1 ON p1.unlocode=lp.primary_unlocode LEFT JOIN port_locations p2 ON p2.unlocode=lp.linked_unlocode WHERE lp.id=?").get(req.params.id);
    ok(res, mapLinkedPort(r));
  });
  app.delete("/api/linked-ports/:id", write, async (req, res) => {
    if (isRemote()) {
      try { await callMdmService("DELETE", `/internal/linked-ports/${req.params.id}`); return ok(res, { deleted: req.params.id }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("DELETE FROM linked_ports WHERE id=?").run(req.params.id); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.id});
  });

  // ─── Carrier Agents ───────────────────────────────────────────────────────
  // Which local company represents a carrier at a given port (carrier x port -> agent
  // customer) — auto-resolves onto every shipment's Additional Parties as "Line Agent
  // (Export/Import)" (see resolveCarrierAgent/maybeAssignLineAgents, routes/shipments.js).
  // Unlike Linked Ports (where the pair itself is the fixed identity), the agent assignment is
  // exactly the kind of thing that changes over time while carrier+port stay fixed, so PUT here
  // allows reassigning the agent customer, not just the note.
  //
  // Remote mode: the MDM Service owns carrier_agents but NOT customers, so its own responses
  // carry only the raw agentCustomerId — attachAgentNames() below does one local batch
  // `SELECT id, company_name FROM customers WHERE id IN (...)` to fill in agentCustomerName,
  // mirroring the batch-resolve idiom this codebase already uses for resolveSeaPorts.

  const CARRIER_AGENT_JOIN = `
    SELECT ca.*, pl.name AS port_name, c.company_name AS agent_customer_name
    FROM carrier_agents ca
    LEFT JOIN port_locations pl ON pl.unlocode = ca.port_unlocode
    LEFT JOIN customers c ON c.id = ca.agent_customer_id
  `;

  // customer_source is independent of this file's own mdm_source toggle — a batch lookup either
  // way (never one call per agent), matching resolveSeaPorts'/resolveAssigneeNames' own idiom.
  async function attachAgentNames(mapped) {
    const list = Array.isArray(mapped) ? mapped : mapped.results;
    const ids = [...new Set((list || []).map(a => a.agentCustomerId).filter(Boolean))];
    if (ids.length === 0) return mapped;
    const names = {};
    if ((getSettings().customer_source || "local") === "remote") {
      const customers = await callCustomerService("GET", `/internal/customers?ids=${ids.join(",")}`);
      (customers || []).forEach(c => { names[c.id] = c.companyName; });
    } else {
      const ph = ids.map(() => "?").join(",");
      db.prepare(`SELECT id, company_name FROM customers WHERE id IN (${ph})`).all(...ids)
        .forEach(c => { names[c.id] = c.company_name; });
    }
    (list || []).forEach(a => { a.agentCustomerName = names[a.agentCustomerId] || ''; });
    return mapped;
  }

  app.get("/api/carrier-agents", async (req, res) => {
    if (isRemote()) {
      const qs = new URLSearchParams(req.query).toString();
      try { return ok(res, await attachAgentNames(await callMdmService("GET", `/internal/carrier-agents${qs ? `?${qs}` : ""}`))); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const rows = db.prepare(`${CARRIER_AGENT_JOIN} ORDER BY ca.carrier_code, ca.port_unlocode`).all();
    let mapped = rows.map(mapCarrierAgent);
    // Pagination is opt-in (same shape as GET /api/shipments) — every existing caller that
    // omits limit/offset keeps getting today's exact bare-array response.
    if (req.query.limit === undefined && req.query.offset === undefined) return ok(res, mapped);
    if (req.query.search) {
      const q = req.query.search.toLowerCase();
      mapped = mapped.filter(a =>
        a.carrierCode.toLowerCase().includes(q) || a.portUnlocode.toLowerCase().includes(q)
        || (a.portName || '').toLowerCase().includes(q) || (a.agentCustomerName || '').toLowerCase().includes(q)
        || (a.note || '').toLowerCase().includes(q));
    }
    const lim = Math.min(parseInt(req.query.limit) || 50, 500), off = parseInt(req.query.offset) || 0;
    ok(res, { results: mapped.slice(off, off + lim), total: mapped.length, limit: lim, offset: off });
  });
  app.post("/api/carrier-agents", write, async (req, res) => {
    const { carrierCode, portUnlocode, agentCustomerId, note = '' } = req.body;
    if (!carrierCode || !portUnlocode || !agentCustomerId) return err(res, "carrierCode, portUnlocode and agentCustomerId required");
    if (isRemote()) {
      try {
        const created = await callMdmService("POST", "/internal/carrier-agents", { carrierCode, portUnlocode, agentCustomerId, note });
        await attachAgentNames([created]);
        return ok(res, created, 201);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const id = `CAG-${uid()}`;
    const now = new Date().toISOString();
    try {
      db.prepare("INSERT INTO carrier_agents (id,carrier_code,port_unlocode,agent_customer_id,note,created_at) VALUES (?,?,?,?,?,?)")
        .run(id, carrierCode.toUpperCase().trim(), portUnlocode.toUpperCase().trim(), agentCustomerId, note.trim(), now);
    } catch (e) {
      return err(res, isUniqueViolation(e) ? "This carrier already has an agent registered at this port" : e.message);
    }
    const r = db.prepare(`${CARRIER_AGENT_JOIN} WHERE ca.id=?`).get(id);
    ok(res, mapCarrierAgent(r), 201);
  });
  app.put("/api/carrier-agents/:id", write, async (req, res) => {
    if (isRemote()) {
      try {
        const updated = await callMdmService("PUT", `/internal/carrier-agents/${req.params.id}`, req.body);
        await attachAgentNames([updated]);
        return ok(res, updated);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const existing = db.prepare("SELECT * FROM carrier_agents WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const { agentCustomerId = existing.agent_customer_id, note = existing.note } = req.body;
    if (!agentCustomerId) return err(res, "agentCustomerId required");
    db.prepare("UPDATE carrier_agents SET agent_customer_id=?, note=? WHERE id=?").run(agentCustomerId, note.trim(), req.params.id);
    const r = db.prepare(`${CARRIER_AGENT_JOIN} WHERE ca.id=?`).get(req.params.id);
    ok(res, mapCarrierAgent(r));
  });
  app.delete("/api/carrier-agents/:id", write, async (req, res) => {
    if (isRemote()) {
      try { await callMdmService("DELETE", `/internal/carrier-agents/${req.params.id}`); return ok(res, { deleted: req.params.id }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("DELETE FROM carrier_agents WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // ─── Trade Lanes ──────────────────────────────────────────────────────────

  app.get("/api/trade-lanes", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", "/internal/trade-lanes")); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, db.prepare(`
      SELECT tl.*, COUNT(ctl.iso2) AS country_count
      FROM trade_lanes tl
      LEFT JOIN country_trade_lanes ctl ON ctl.lane_code = tl.code
      GROUP BY tl.code
      ORDER BY tl.code
    `).all().map(mapTradeLane));
  });

  app.get("/api/trade-lanes/:code/countries", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/trade-lanes/${req.params.code.toUpperCase()}/countries`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const rows = db.prepare(`
      SELECT c.iso2, c.name, c.un_member, c.region_code
      FROM country_trade_lanes ctl
      JOIN countries c ON c.iso2 = ctl.iso2
      WHERE ctl.lane_code = ?
      ORDER BY c.name
    `).all(req.params.code.toUpperCase());
    ok(res, rows.map(mapCountry));
  });

  app.put("/api/trade-lanes/:code/countries", write, async (req, res) => {
    const code  = req.params.code.toUpperCase();
    const iso2s = Array.isArray(req.body.iso2s) ? req.body.iso2s : [];
    if (isRemote()) {
      try {
        const result = await callMdmService("PUT", `/internal/trade-lanes/${code}/countries`, { iso2s });
        await rebuildPortLanesMap();
        return ok(res, result);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM country_trade_lanes WHERE lane_code = ?").run(code);
      const ins = db.prepare("INSERT OR IGNORE INTO country_trade_lanes (iso2, lane_code) VALUES (?, ?)");
      for (const iso2 of iso2s) ins.run(iso2.toUpperCase(), code);
      db.exec("COMMIT");
      await rebuildPortLanesMap();
      ok(res, { code, iso2s });
    } catch(e) { db.exec("ROLLBACK"); err(res, e.message); }
  });

  app.post("/api/trade-lanes", write, async (req, res) => {
    const { code, name, description='', transitDays=0 } = req.body;
    if (!code || !name) return err(res, "code and name required");
    if (isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/trade-lanes", { code, name, description, transitDays }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      const c = code.toUpperCase().trim();
      db.prepare("INSERT INTO trade_lanes (code,name,description,transit_days) VALUES (?,?,?,?)").run(c, name.trim(), description.trim(), Number(transitDays) || 0);
      ok(res, { code: c, name: name.trim(), description: description.trim(), transitDays: Number(transitDays) || 0, countryCount: 0 }, 201);
    } catch(e) { err(res, isUniqueViolation(e) ? `Lane ${code} already exists` : e.message); }
  });
  app.put("/api/trade-lanes/:code", write, async (req, res) => {
    const { name, description='', transitDays=0 } = req.body;
    if (isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/trade-lanes/${req.params.code}`, { name, description, transitDays })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("UPDATE trade_lanes SET name=?, description=?, transit_days=? WHERE code=?").run(name, description, Number(transitDays) || 0, req.params.code);
    if (info.changes===0) return err(res,"Not found",404);
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
    if (isRemote()) {
      try {
        const { days } = await callMdmService("GET", `/internal/trade-lanes/transit-suggestion?polLane=${polLane}&podLane=${podLane}`);
        return ok(res, { days, lane: polLane });
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const row = db.prepare("SELECT transit_days FROM trade_lanes WHERE code=?").get(polLane);
    ok(res, { days: row?.transit_days || null, lane: polLane });
  });
  app.delete("/api/trade-lanes/:code", write, async (req, res) => {
    if (isRemote()) {
      try { await callMdmService("DELETE", `/internal/trade-lanes/${req.params.code}`); return ok(res, { deleted: req.params.code }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("DELETE FROM trade_lanes WHERE code=?").run(req.params.code); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.code});
  });

  app.get("/api/country-trade-lanes", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", "/internal/country-trade-lanes")); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, db.prepare("SELECT * FROM country_trade_lanes").all());
  });
  app.post("/api/country-trade-lanes", write, async (req, res) => {
    const { iso2, laneCode } = req.body;
    if (!iso2 || !laneCode) return err(res, "iso2 and laneCode required");
    if (isRemote()) {
      try {
        const result = await callMdmService("POST", "/internal/country-trade-lanes", { iso2, laneCode });
        await rebuildPortLanesMap();
        return ok(res, result, 201);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    try { db.prepare("INSERT INTO country_trade_lanes (iso2,lane_code) VALUES (?,?)").run(iso2.toUpperCase(), laneCode.toUpperCase()); await rebuildPortLanesMap(); ok(res, { iso2: iso2.toUpperCase(), laneCode: laneCode.toUpperCase() }, 201); }
    catch(e) { err(res, isUniqueViolation(e) ? "Assignment already exists" : e.message); }
  });
  app.put("/api/countries/:iso2/trade-lanes", write, async (req, res) => {
    const iso2  = req.params.iso2.toUpperCase();
    const lanes = Array.isArray(req.body.lanes) ? req.body.lanes : [];
    if (isRemote()) {
      try {
        const result = await callMdmService("PUT", `/internal/countries/${iso2}/trade-lanes`, { lanes });
        await rebuildPortLanesMap();
        return ok(res, result);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM country_trade_lanes WHERE iso2 = ?").run(iso2);
      const ins = db.prepare("INSERT OR IGNORE INTO country_trade_lanes (iso2, lane_code) VALUES (?, ?)");
      for (const lane of lanes) ins.run(iso2, lane.toUpperCase());
      db.exec("COMMIT");
      await rebuildPortLanesMap();
      ok(res, { iso2, lanes });
    } catch(e) { db.exec("ROLLBACK"); err(res, e.message); }
  });
  app.delete("/api/country-trade-lanes/:iso2/:laneCode", write, async (req, res) => {
    if (isRemote()) {
      try {
        await callMdmService("DELETE", `/internal/country-trade-lanes/${req.params.iso2}/${req.params.laneCode}`);
        await rebuildPortLanesMap();
        return ok(res, { deleted: true });
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    db.prepare("DELETE FROM country_trade_lanes WHERE iso2=? AND lane_code=?").run(req.params.iso2, req.params.laneCode); await rebuildPortLanesMap(); ok(res, { deleted: true });
  });

  // ─── Regions ──────────────────────────────────────────────────────────────

  app.get("/api/regions", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", "/internal/regions")); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, db.prepare("SELECT * FROM regions ORDER BY code").all().map(mapRegion));
  });
  app.post("/api/regions", write, async (req, res) => {
    const { code, name, description='' } = req.body;
    if (!code || !name) return err(res, "code and name required");
    if (isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/regions", { code, name, description }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    try { db.prepare("INSERT INTO regions (code,name,description) VALUES (?,?,?)").run(code.toUpperCase().trim(), name.trim(), description.trim()); ok(res, { code: code.toUpperCase().trim(), name: name.trim(), description: description.trim() }, 201); }
    catch(e) { err(res, isUniqueViolation(e) ? `Region ${code} already exists` : e.message); }
  });
  app.put("/api/regions/:code", write, async (req, res) => {
    const { name, description='' } = req.body;
    if (isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/regions/${req.params.code}`, { name, description })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("UPDATE regions SET name=?, description=? WHERE code=?").run(name, description, req.params.code);
    if (info.changes===0) return err(res,"Not found",404);
    ok(res, { code: req.params.code, name, description });
  });
  app.delete("/api/regions/:code", write, async (req, res) => {
    if (isRemote()) {
      try { await callMdmService("DELETE", `/internal/regions/${req.params.code}`); return ok(res, { deleted: req.params.code }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("DELETE FROM regions WHERE code=?").run(req.params.code); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.code});
  });

  // ─── Countries ────────────────────────────────────────────────────────────

  app.get("/api/countries", async (req, res) => {
    const { search='', limit='50', offset='0' } = req.query;
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/countries?search=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
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
  app.post("/api/countries", write, async (req, res) => {
    const { iso2, name, unMember=1, regionCode='' } = req.body;
    if (!iso2 || !name) return err(res, "iso2 and name required");
    if (isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/countries", { iso2, name, unMember, regionCode }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    try { db.prepare("INSERT INTO countries (iso2,name,un_member,region_code) VALUES (?,?,?,?)").run(iso2.toUpperCase().trim(), name.trim(), unMember ? 1 : 0, regionCode.trim()); ok(res, mapCountry({ iso2: iso2.toUpperCase().trim(), name: name.trim(), un_member: unMember ? 1 : 0, region_code: regionCode.trim() }), 201); }
    catch(e) { err(res, isUniqueViolation(e) ? `Country ${iso2} already exists` : e.message); }
  });
  app.put("/api/countries/:iso2", write, async (req, res) => {
    const iso2 = req.params.iso2.toUpperCase();
    if (isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/countries/${iso2}`, req.body)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const existing = db.prepare("SELECT * FROM countries WHERE iso2=?").get(iso2);
    if (!existing) return err(res, "Not found", 404);
    const { name, unMember=1, regionCode='', invoiceAlertBusinessDays, invoiceEscalationBusinessDays } = req.body;
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
    db.prepare(`UPDATE countries SET name=?, un_member=?, region_code=?,
      invoice_alert_business_days=?, invoice_escalation_business_days=? WHERE iso2=?`)
      .run(name, unMember ? 1 : 0, regionCode, alertDays, escalationDays, iso2);
    ok(res, mapCountry({ iso2, name, un_member: unMember ? 1 : 0, region_code: regionCode,
      invoice_alert_business_days: alertDays, invoice_escalation_business_days: escalationDays }));
  });
  app.delete("/api/countries/:iso2", write, async (req, res) => {
    if (isRemote()) {
      try { await callMdmService("DELETE", `/internal/countries/${req.params.iso2.toUpperCase()}`); return ok(res, { deleted: req.params.iso2 }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("DELETE FROM countries WHERE iso2=?").run(req.params.iso2.toUpperCase()); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.iso2});
  });
  app.get("/api/countries/:iso2/locations", async (req, res) => {
    const iso2   = req.params.iso2.toUpperCase();
    const search = (req.query.search || "").trim();
    const lim    = Math.min(parseInt(req.query.limit  || "50",  10), 200);
    const off    = parseInt(req.query.offset || "0", 10);
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/countries/${iso2}/locations?search=${encodeURIComponent(search)}&limit=${lim}&offset=${off}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const where  = search ? "WHERE country_code=? AND (unlocode LIKE ? OR name LIKE ?)" : "WHERE country_code=?";
    const params = search ? [iso2, `%${search}%`, `%${search}%`] : [iso2];
    const total  = db.prepare(`SELECT COUNT(*) AS n FROM port_locations ${where}`).get(...params).n;
    const rows   = db.prepare(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
  });

  // ─── UN Location Codes ────────────────────────────────────────────────────

  app.get("/api/unlocodes", async (req, res) => {
    const { search='', limit='50', offset='0' } = req.query;
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/unlocodes?search=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const where = search.trim() ? "WHERE unlocode LIKE ? OR name LIKE ?" : "";
    const params = search.trim() ? [`%${search.trim().toUpperCase()}%`, `%${search.trim()}%`] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM port_locations ${where}`).get(...params).n;
    const rows  = db.prepare(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
  });

  // ─── Commodities ──────────────────────────────────────────────────────────

  app.get("/api/commodities", async (req, res) => {
    const { search='', grade='', limit='50', offset='0' } = req.query;
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/commodities?search=${encodeURIComponent(search)}&grade=${encodeURIComponent(grade)}&limit=${limit}&offset=${offset}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
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
  app.get("/api/commodities/search", async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return ok(res, []);
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/commodities/search?q=${encodeURIComponent(q)}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, db.prepare("SELECT * FROM commodities WHERE code LIKE ? OR description LIKE ? ORDER BY code LIMIT 12").all(`%${q}%`, `%${q}%`).map(mapCommodity));
  });
  app.get("/api/commodities/:code", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/commodities/${req.params.code}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const r = db.prepare("SELECT * FROM commodities WHERE code=?").get(req.params.code); if (!r) return err(res,"Not found",404); ok(res,mapCommodity(r));
  });
  app.post("/api/commodities", write, async (req, res) => {
    const { code, description, gradeCode='E', gradeName='General Cargo' } = req.body;
    if (!code || !description) return err(res, "code and description required");
    if (isRemote()) {
      try { return ok(res, await callMdmService("POST", "/internal/commodities", { code, description, gradeCode, gradeName }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    try { db.prepare("INSERT INTO commodities (code,description,grade_code,grade_name) VALUES (?,?,?,?)").run(code.trim(), description.trim(), gradeCode, gradeName); ok(res, mapCommodity({ code: code.trim(), description: description.trim(), grade_code: gradeCode, grade_name: gradeName }), 201); }
    catch(e) { err(res, isUniqueViolation(e) ? `Commodity ${code} already exists` : e.message); }
  });
  app.put("/api/commodities/:code", write, async (req, res) => {
    const { description, gradeCode='E', gradeName='General Cargo' } = req.body;
    if (isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/commodities/${req.params.code}`, { description, gradeCode, gradeName })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("UPDATE commodities SET description=?, grade_code=?, grade_name=? WHERE code=?").run(description, gradeCode, gradeName, req.params.code);
    if (info.changes===0) return err(res,"Not found",404);
    ok(res, mapCommodity({ code: req.params.code, description, grade_code: gradeCode, grade_name: gradeName }));
  });
  app.delete("/api/commodities/:code", write, async (req, res) => {
    if (isRemote()) {
      try { await callMdmService("DELETE", `/internal/commodities/${req.params.code}`); return ok(res, { deleted: req.params.code }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const info = db.prepare("DELETE FROM commodities WHERE code=?").run(req.params.code); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.code});
  });
};
