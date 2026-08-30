"use strict";

module.exports = function mdmRoutes(app, ctx) {
  const { query, transaction, ok, err, uid, isUniqueViolation, requireRole, getSettings, callMdmService, callCustomerService,
          mapCarrier, mapVessel, mapPortLocation, mapLinkedPort, mapTradeLane, mapCarrierAgent, mapCarrierAgentLocation,
          mapCarrierAgentScheduleRow,
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
      await query("INSERT INTO port_locations (unlocode,name,latitude,longitude,country_code,zone_code,last_synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [code, name.trim(), latitude, longitude, finalCC, zoneCode.trim(), now]);
      ok(res, mapPortLocation({ unlocode: code, name: name.trim(), latitude, longitude, country_code: finalCC, zone_code: zoneCode.trim(), last_synced_at: now }), 201);
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
    const cc = countryCode.toUpperCase() || req.params.unlocode.slice(0, 2).toUpperCase();
    const updated = await query("UPDATE port_locations SET name=$1, latitude=$2, longitude=$3, country_code=$4, zone_code=$5, last_synced_at=$6 WHERE unlocode=$7 RETURNING unlocode",
      [name, latitude, longitude, cc, zoneCode, new Date().toISOString(), req.params.unlocode.toUpperCase()]);
    if (updated.length===0) return err(res,"Not found",404);
    ok(res, mapPortLocation({ unlocode: req.params.unlocode.toUpperCase(), name, latitude, longitude, country_code: countryCode.toUpperCase(), zone_code: zoneCode }));
  });
  app.delete("/api/port-locations/:unlocode", write, async (req, res) => {
    if (await isRemote()) {
      try { await callMdmService("DELETE", `/internal/port-locations/${req.params.unlocode.toUpperCase()}`); return ok(res, { deleted: req.params.unlocode }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const deleted = await query("DELETE FROM port_locations WHERE unlocode=$1 RETURNING unlocode", [req.params.unlocode.toUpperCase()]); if (deleted.length===0) return err(res,"Not found",404); ok(res,{deleted:req.params.unlocode});
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

  // Operational capabilities a Line Agent can actually perform — lets a shipment cross-check the
  // assigned agent against what a leg's own haulage/service actually needs (e.g. an export leg
  // booked as Merchant's Haulage by road, but the assigned agent has no road_haulage capability)
  // before sending the booking, instead of discovering the mismatch only after a carrier
  // rejection or an operator rework. Codes only here (also mirrored in the MDM Service and in
  // src/pages/mdm/MdmCarrierAgentsPage.jsx, same split-copy convention as ADDITIONAL_PARTY_ROLES)
  // — validation only, no cross-check wired into booking yet (a separate, later pass).
  const AGENT_CAPABILITY_CODES = [
    "port_agency", "documentation", "customs_clearance",
    "road_haulage", "rail_haulage", "barge_haulage",
    "warehousing", "cy_storage", "fumigation", "empty_equipment",
  ];

  const CARRIER_AGENT_JOIN = `
    SELECT ca.*, c.company_name AS agent_customer_name
    FROM carrier_agents ca
    LEFT JOIN customers c ON c.id = ca.agent_customer_id
  `;
  const LOCATION_JOIN = `
    SELECT cal.*, pl.name AS port_name, co.name AS country_name
    FROM carrier_agent_locations cal
    LEFT JOIN port_locations pl ON pl.unlocode = cal.unlocode
    LEFT JOIN countries co ON co.iso2 = cal.country_iso2
  `;

  // Batch-fetch every location for a set of header ids in ONE query (never one query per header
  // — same no-N+1 idiom as resolveSeaPorts/attachAgentNames), group by carrier_agent_id, then map
  // each header with its own location list attached.
  async function mapHeadersWithLocations(headerRows) {
    if (headerRows.length === 0) return [];
    const ph = headerRows.map((_, i) => `$${i + 1}`).join(",");
    const locRows = await query(`${LOCATION_JOIN} WHERE cal.carrier_agent_id IN (${ph}) ORDER BY cal.created_at`,
      headerRows.map(r => r.id));
    const byHeader = new Map();
    for (const l of locRows) {
      if (!byHeader.has(l.carrier_agent_id)) byHeader.set(l.carrier_agent_id, []);
      byHeader.get(l.carrier_agent_id).push(l);
    }
    return headerRows.map(r => mapCarrierAgent(r, byHeader.get(r.id) || []));
  }

  // customer_source is independent of this file's own mdm_source toggle — a batch lookup either
  // way (never one call per agent), matching resolveSeaPorts'/resolveAssigneeNames' own idiom.
  async function attachAgentNames(mapped) {
    const list = Array.isArray(mapped) ? mapped : mapped.results;
    const ids = [...new Set((list || []).map(a => a.agentCustomerId).filter(Boolean))];
    if (ids.length === 0) return mapped;
    const names = {};
    if (((await getSettings()).customer_source || "local") === "remote") {
      const customers = await callCustomerService("GET", `/internal/customers?ids=${ids.join(",")}`);
      (customers || []).forEach(c => { names[c.id] = c.companyName; });
    } else {
      const ph = ids.map((_, i) => `$${i + 1}`).join(",");
      (await query(`SELECT id, company_name FROM customers WHERE id IN (${ph})`, ids))
        .forEach(c => { names[c.id] = c.company_name; });
    }
    (list || []).forEach(a => { a.agentCustomerName = names[a.agentCustomerId] || ''; });
    return mapped;
  }

  // Resolves what conflicts/redundancies a new location would create — called before writing,
  // from both header-creation (first location) and the add-location sub-route. Two distinct
  // outcomes on purpose: adding a MORE SPECIFIC location (a UNLOCODE) that's already covered by
  // an existing BROADER one (a country, on the same header) is simply rejected — nothing was
  // ever saved, so there's nothing to discard. Adding a NEW BROADER location (a country) that
  // makes existing SPECIFIC ones redundant is allowed, and the caller auto-discards the
  // redundant ones afterward via discardRedundantUnlocodes — that direction removes something
  // that already existed, which is what "log it in the historical records" implies.
  async function checkLocationConflict({ carrierCode, headerId, locationType, unlocode, countryIso2 }) {
    if (locationType === "unlocode") {
      const [portRow] = await query("SELECT country_code FROM port_locations WHERE unlocode=$1", [unlocode]);
      if (!portRow) return { error: `Unknown UN/LOCODE: ${unlocode}` };
      const portCountry = portRow.country_code || '';
      if (portCountry) {
        const [coveringCountry] = await query(`
          SELECT 1 FROM carrier_agent_locations WHERE carrier_agent_id=$1 AND location_type='country' AND country_iso2=$2
        `, [headerId, portCountry]);
        if (coveringCountry) return { error: `This location is already covered by this Line Agent's existing ${portCountry} country configuration.` };
      }
      const [existingDirect] = await query(`
        SELECT carrier_agent_id FROM carrier_agent_locations WHERE carrier_code=$1 AND location_type='unlocode' AND unlocode=$2
      `, [carrierCode, unlocode]);
      if (existingDirect) {
        return existingDirect.carrier_agent_id === headerId
          ? { error: "This location is already configured for this Line Agent." }
          : { error: "This location is already assigned to a different Line Agent for this carrier." };
      }
      if (portCountry) {
        const [existingViaCountry] = await query(`
          SELECT carrier_agent_id FROM carrier_agent_locations WHERE carrier_code=$1 AND location_type='country' AND country_iso2=$2
        `, [carrierCode, portCountry]);
        if (existingViaCountry && existingViaCountry.carrier_agent_id !== headerId)
          return { error: `This location's country (${portCountry}) is already assigned to a different Line Agent for this carrier.` };
      }
      return { ok: true };
    }
    // locationType === "country"
    const [countryRow] = await query("SELECT 1 FROM countries WHERE iso2=$1", [countryIso2]);
    if (!countryRow) return { error: `Unknown country code: ${countryIso2}` };
    const [existingCountry] = await query(`
      SELECT carrier_agent_id FROM carrier_agent_locations WHERE carrier_code=$1 AND location_type='country' AND country_iso2=$2
    `, [carrierCode, countryIso2]);
    if (existingCountry) {
      return existingCountry.carrier_agent_id === headerId
        ? { error: "This country is already configured for this Line Agent." }
        : { error: "This country is already assigned to a different Line Agent for this carrier." };
    }
    const [conflictingUnlocode] = await query(`
      SELECT cal.unlocode FROM carrier_agent_locations cal
      JOIN port_locations pl ON pl.unlocode = cal.unlocode
      WHERE cal.carrier_code=$1 AND cal.location_type='unlocode' AND pl.country_code=$2 AND cal.carrier_agent_id != $3
    `, [carrierCode, countryIso2, headerId]);
    if (conflictingUnlocode) {
      return { error: `${conflictingUnlocode.unlocode} in this country is already assigned to a different Line Agent for this carrier — remove it from that agent first.` };
    }
    return { ok: true };
  }

  // Runs only after a country-level location is successfully saved: any UNLOCODE already
  // configured under the SAME header whose own country now matches is obsolete — remove it and
  // log the discard as a real historical record (entity_events), never a silent delete.
  async function discardRedundantUnlocodes(headerId, carrierCode, countryIso2) {
    const redundant = await query(`
      SELECT cal.* FROM carrier_agent_locations cal
      JOIN port_locations pl ON pl.unlocode = cal.unlocode
      WHERE cal.carrier_agent_id=$1 AND cal.location_type='unlocode' AND pl.country_code=$2
    `, [headerId, countryIso2]);
    for (const loc of redundant) {
      await query("DELETE FROM carrier_agent_locations WHERE id=$1", [loc.id]);
      await logEntityEvent('carrier_agent_location', loc.id, 'DISCARDED_REDUNDANT', 'unlocode', loc.unlocode, null,
        JSON.stringify({ carrierAgentId: headerId, carrierCode, discardedUnlocode: loc.unlocode, madeObsoleteByCountry: countryIso2 }));
    }
    return redundant.map(l => l.unlocode);
  }

  // Raw insert only (no audit log) — used by the header-creation route so the insert can run
  // inside that route's own transaction via a passed-in tx.query; the standalone add-location
  // route below calls it with the default top-level `query` (no transaction needed there, since
  // it's already a single atomic statement).
  async function insertLocationRow(q, headerId, carrierCode, locationType, unlocode, countryIso2) {
    const id = `CAL-${uid()}`;
    const now = new Date().toISOString();
    await q(`INSERT INTO carrier_agent_locations (id,carrier_agent_id,carrier_code,location_type,unlocode,country_iso2,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, headerId, carrierCode, locationType,
        locationType === "unlocode" ? unlocode : null, locationType === "country" ? countryIso2 : null, now]);
    return id;
  }

  async function insertLocation(headerId, carrierCode, locationType, unlocode, countryIso2) {
    const id = await insertLocationRow(query, headerId, carrierCode, locationType, unlocode, countryIso2);
    await logEntityEvent('carrier_agent_location', id, 'CREATED', null, null, null,
      JSON.stringify({ carrierAgentId: headerId, carrierCode, locationType, unlocode, countryIso2 }));
    return id;
  }

  app.get("/api/carrier-agents", async (req, res) => {
    if (await isRemote()) {
      const qs = new URLSearchParams(req.query).toString();
      try { return ok(res, await attachAgentNames(await callMdmService("GET", `/internal/carrier-agents${qs ? `?${qs}` : ""}`))); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const headerRows = await query(`${CARRIER_AGENT_JOIN} ORDER BY ca.carrier_code, ca.agent_customer_id`);
    let mapped = await mapHeadersWithLocations(headerRows);
    // Pagination is opt-in (same shape as GET /api/shipments) — every existing caller that
    // omits limit/offset keeps getting today's exact bare-array response.
    if (req.query.limit === undefined && req.query.offset === undefined) return ok(res, mapped);
    if (req.query.search) {
      const q = req.query.search.toLowerCase();
      mapped = mapped.filter(a =>
        a.carrierCode.toLowerCase().includes(q) || (a.agentCustomerName || '').toLowerCase().includes(q)
        || (a.note || '').toLowerCase().includes(q)
        || a.locations.some(l => l.unlocode.toLowerCase().includes(q) || l.portName.toLowerCase().includes(q)
          || l.countryIso2.toLowerCase().includes(q) || l.countryName.toLowerCase().includes(q)));
    }
    const lim = Math.min(parseInt(req.query.limit) || 50, 500), off = parseInt(req.query.offset) || 0;
    ok(res, { results: mapped.slice(off, off + lim), total: mapped.length, limit: lim, offset: off });
  });
  app.post("/api/carrier-agents", write, async (req, res) => {
    const { carrierCode, agentCustomerId, note = '', locationType, unlocode, countryIso2, capabilities = [] } = req.body;
    if (!carrierCode || !agentCustomerId) return err(res, "carrierCode and agentCustomerId required");
    if (locationType !== "unlocode" && locationType !== "country") return err(res, "locationType must be 'unlocode' or 'country'");
    if (locationType === "unlocode" && !unlocode) return err(res, "unlocode required");
    if (locationType === "country" && !countryIso2) return err(res, "countryIso2 required");
    if (!Array.isArray(capabilities) || capabilities.some(c => !AGENT_CAPABILITY_CODES.includes(c)))
      return err(res, "capabilities must be an array of known capability codes");
    if (await isRemote()) {
      try {
        const created = await callMdmService("POST", "/internal/carrier-agents", { carrierCode, agentCustomerId, note, locationType, unlocode, countryIso2, capabilities });
        await attachAgentNames([created]);
        return ok(res, created, 201);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const code = carrierCode.toUpperCase().trim();
    const ucUpper = unlocode?.toUpperCase().trim();
    const ccUpper = countryIso2?.toUpperCase().trim();
    const conflict = await checkLocationConflict({ carrierCode: code, headerId: '__new__', locationType, unlocode: ucUpper, countryIso2: ccUpper });
    if (conflict.error) return err(res, conflict.error);
    const id = `CAG-${uid()}`;
    const now = new Date().toISOString();
    // Header + first location as one atomic unit — a header with zero locations is meaningless,
    // so a failure inserting the location must not leave an orphaned header behind. The audit-log
    // write is deferred until after commit (see insertLocationRow's own comment).
    let locationId;
    try {
      await transaction(async (tx) => {
        await tx.query("INSERT INTO carrier_agents (id,carrier_code,agent_customer_id,note,capabilities,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, code, agentCustomerId, note.trim(), JSON.stringify(capabilities), now]);
        locationId = await insertLocationRow(tx.query, id, code, locationType, ucUpper, ccUpper);
      });
    } catch (e) {
      return err(res, isUniqueViolation(e) ? "This carrier already has a Line Agent header for this customer — add a location to it instead" : e.message);
    }
    await logEntityEvent('carrier_agent_location', locationId, 'CREATED', null, null, null,
      JSON.stringify({ carrierAgentId: id, carrierCode: code, locationType, unlocode: ucUpper, countryIso2: ccUpper }));
    const [r] = await query(`${CARRIER_AGENT_JOIN} WHERE ca.id=$1`, [id]);
    ok(res, (await mapHeadersWithLocations([r]))[0], 201);
  });
  app.put("/api/carrier-agents/:id", write, async (req, res) => {
    if (await isRemote()) {
      try {
        const updated = await callMdmService("PUT", `/internal/carrier-agents/${req.params.id}`, req.body);
        await attachAgentNames([updated]);
        return ok(res, updated);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [existing] = await query("SELECT * FROM carrier_agents WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const { agentCustomerId = existing.agent_customer_id, note = existing.note,
            capabilities = JSON.parse(existing.capabilities || '[]') } = req.body;
    if (!agentCustomerId) return err(res, "agentCustomerId required");
    if (!Array.isArray(capabilities) || capabilities.some(c => !AGENT_CAPABILITY_CODES.includes(c)))
      return err(res, "capabilities must be an array of known capability codes");
    await query("UPDATE carrier_agents SET agent_customer_id=$1, note=$2, capabilities=$3 WHERE id=$4",
      [agentCustomerId, note.trim(), JSON.stringify(capabilities), req.params.id]);
    const [r] = await query(`${CARRIER_AGENT_JOIN} WHERE ca.id=$1`, [req.params.id]);
    ok(res, (await mapHeadersWithLocations([r]))[0]);
  });
  app.delete("/api/carrier-agents/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { await callMdmService("DELETE", `/internal/carrier-agents/${req.params.id}`); return ok(res, { deleted: req.params.id }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const deleted = await query("DELETE FROM carrier_agents WHERE id=$1 RETURNING id", [req.params.id]);
    if (deleted.length === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // ─── Carrier Agent Locations (add/remove a coverage entry on an existing header) ────────────
  // POST validates the new location against every other header for the same carrier (see
  // checkLocationConflict) before writing, then — only for a country-type add — auto-discards
  // any now-redundant UNLOCODE rows under the SAME header and reports them back as `discarded`
  // so the frontend can show the informational "these were made obsolete" notice.
  app.post("/api/carrier-agents/:id/locations", write, async (req, res) => {
    const { locationType, unlocode, countryIso2 } = req.body;
    if (locationType !== "unlocode" && locationType !== "country") return err(res, "locationType must be 'unlocode' or 'country'");
    if (locationType === "unlocode" && !unlocode) return err(res, "unlocode required");
    if (locationType === "country" && !countryIso2) return err(res, "countryIso2 required");
    if (await isRemote()) {
      try { return ok(res, await callMdmService("POST", `/internal/carrier-agents/${req.params.id}/locations`, req.body), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [header] = await query("SELECT * FROM carrier_agents WHERE id=$1", [req.params.id]);
    if (!header) return err(res, "Not found", 404);
    const uc = unlocode?.toUpperCase().trim();
    const cc = countryIso2?.toUpperCase().trim();
    const conflict = await checkLocationConflict({ carrierCode: header.carrier_code, headerId: header.id, locationType, unlocode: uc, countryIso2: cc });
    if (conflict.error) return err(res, conflict.error);
    await insertLocation(header.id, header.carrier_code, locationType, uc, cc);
    const discarded = locationType === "country" ? await discardRedundantUnlocodes(header.id, header.carrier_code, cc) : [];
    const [r] = await query(`${CARRIER_AGENT_JOIN} WHERE ca.id=$1`, [header.id]);
    const mapped = (await mapHeadersWithLocations([r]))[0];
    ok(res, { ...mapped, discarded }, 201);
  });
  app.delete("/api/carrier-agent-locations/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { await callMdmService("DELETE", `/internal/carrier-agent-locations/${req.params.id}`); return ok(res, { deleted: req.params.id }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const deleted = await query("DELETE FROM carrier_agent_locations WHERE id=$1 RETURNING id", [req.params.id]);
    if (deleted.length === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // ─── Carrier Agent Working Schedule ───────────────────────────────────────────
  // One row per day-group + hour-range (e.g. "Mon,Tue 09:00-18:00"). Always saved as a full
  // replace of every row for a header, never an incremental add/remove like locations — the "a
  // day can only belong to one row" rule is naturally enforced by validating the whole proposed
  // set in one pass instead of reconciling against whatever was already saved.
  const AGENT_SCHEDULE_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  function validateScheduleRows(rows) {
    if (!Array.isArray(rows)) return "rows must be an array";
    const seenDays = new Set();
    for (const row of rows) {
      if (!Array.isArray(row.days) || row.days.length === 0) return "Each row needs at least one day";
      for (const d of row.days) {
        if (!AGENT_SCHEDULE_DAYS.includes(d)) return `Invalid day: ${d}`;
        if (seenDays.has(d)) return `${d} appears in more than one row — a day can only belong to one row`;
        seenDays.add(d);
      }
      if (!row.startTime || !row.endTime) return "Each row needs a start and end time";
      if (row.startTime >= row.endTime) return "Start time must be before end time";
    }
    return null;
  }

  app.get("/api/carrier-agents/:id/schedule", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callMdmService("GET", `/internal/carrier-agents/${req.params.id}/schedule`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const rows = await query("SELECT * FROM carrier_agent_schedule_rows WHERE carrier_agent_id=$1 ORDER BY sort_order", [req.params.id]);
    ok(res, rows.map(mapCarrierAgentScheduleRow));
  });
  app.put("/api/carrier-agents/:id/schedule", write, async (req, res) => {
    const { rows = [] } = req.body;
    const invalid = validateScheduleRows(rows);
    if (invalid) return err(res, invalid);
    if (await isRemote()) {
      try { return ok(res, await callMdmService("PUT", `/internal/carrier-agents/${req.params.id}/schedule`, { rows })); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [header] = await query("SELECT id FROM carrier_agents WHERE id=$1", [req.params.id]);
    if (!header) return err(res, "Not found", 404);
    const now = new Date().toISOString();
    try {
      await transaction(async (tx) => {
        await tx.query("DELETE FROM carrier_agent_schedule_rows WHERE carrier_agent_id=$1", [req.params.id]);
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          await tx.query(`INSERT INTO carrier_agent_schedule_rows
            (id,carrier_agent_id,days,start_time,end_time,sort_order,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [`CSR-${uid()}`, req.params.id, JSON.stringify(row.days), row.startTime, row.endTime, i, now]);
        }
      });
    } catch (e) {
      return err(res, e.message);
    }
    const saved = await query("SELECT * FROM carrier_agent_schedule_rows WHERE carrier_agent_id=$1 ORDER BY sort_order", [req.params.id]);
    ok(res, saved.map(mapCarrierAgentScheduleRow));
  });

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
    const deleted = await query("DELETE FROM countries WHERE iso2=$1 RETURNING iso2", [req.params.iso2.toUpperCase()]); if (deleted.length===0) return err(res,"Not found",404); ok(res,{deleted:req.params.iso2});
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
