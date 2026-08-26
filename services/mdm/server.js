"use strict";
const express = require("express");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { readSecret } = require("./lib/dockerSecret");

const PORT = process.env.MDM_SERVICE_PORT || 3005;
const SERVICE_SECRET_DEV_DEFAULT = "cargoDesk-dev-mdm-service-secret-do-not-use-in-prod";
const SERVICE_SECRET = readSecret("MDM_SERVICE_SECRET", SERVICE_SECRET_DEV_DEFAULT);
if (SERVICE_SECRET === SERVICE_SECRET_DEV_DEFAULT)
  console.warn("⚠  MDM_SERVICE_SECRET not set (checked MDM_SERVICE_SECRET_FILE, then MDM_SERVICE_SECRET) — using insecure dev default. Set it (and the same value in the monolith's own env) before deploying.");

// Zero-script onboarding, mirroring the monolith's own db/cargodesk.sample.db pattern: a fresh
// clone running this service in isolation (mdm_source=remote from the start) has no mdm.db yet.
// mdm.sample.db is a committed, pre-seeded copy (real ports/carriers/vessels/commodities/regions/
// trade lanes/the full countries+country_trade_lanes lists) — copied once, in place, never
// overwriting an already-running install's own database.
const DB_PATH = path.join(__dirname, "mdm.db");
const SAMPLE_DB_PATH = path.join(__dirname, "mdm.sample.db");
if (!fs.existsSync(DB_PATH) && fs.existsSync(SAMPLE_DB_PATH)) {
  fs.copyFileSync(SAMPLE_DB_PATH, DB_PATH);
  console.log("🗺️  No mdm.db found — copied the bundled reference sample (mdm.sample.db) to get started.");
}

const app = express();
const db = new DatabaseSync(DB_PATH);
app.use(express.json({ limit: "5mb" }));

const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const ok = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });
const isUniqueViolation = e => e?.message?.includes("UNIQUE constraint");

// Straight port of the monolith's carriers/vessels/port_locations/linked_ports/trade_lanes/
// country_trade_lanes/regions/countries/commodities/carrier_agents schema (server.js) — same
// columns, same defaults, including every ALTER-TABLE addition folded into the base CREATE TABLE
// here (short_name, timezone, mmsi/ais_verified_at, invoice_alert/escalation_business_days).
// This service does NOT own `customers` — carrier_agents.agent_customer_id stays a loose TEXT
// column with no REFERENCES clause (the monolith already treats it as an app-level guard, not a
// DB-enforced FK, so nothing changes there) and this service never returns a customer name for
// it, only the raw id — see /internal/carrier-agents' own route comment.
db.exec(`
  PRAGMA journal_mode=WAL;

  CREATE TABLE IF NOT EXISTS carriers (
    code       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    short_name TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS vessels (
    imo             TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    asset_type      TEXT DEFAULT '',
    flag_iso2       TEXT DEFAULT '',
    flag_name       TEXT DEFAULT '',
    build_year      INTEGER,
    gross_tonnage   INTEGER,
    mmsi            TEXT DEFAULT '',
    ais_verified_at TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS port_locations (
    unlocode       TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    latitude       REAL DEFAULT 0,
    longitude      REAL DEFAULT 0,
    country_code   TEXT DEFAULT '',
    zone_code      TEXT DEFAULT '',
    timezone       TEXT,
    last_synced_at TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS linked_ports (
    id               TEXT PRIMARY KEY,
    primary_unlocode TEXT NOT NULL REFERENCES port_locations(unlocode),
    linked_unlocode  TEXT NOT NULL REFERENCES port_locations(unlocode),
    note             TEXT DEFAULT '',
    UNIQUE(primary_unlocode, linked_unlocode)
  );

  CREATE TABLE IF NOT EXISTS trade_lanes (
    code         TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    transit_days INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS country_trade_lanes (
    iso2      TEXT NOT NULL,
    lane_code TEXT NOT NULL REFERENCES trade_lanes(code),
    PRIMARY KEY (iso2, lane_code)
  );

  CREATE TABLE IF NOT EXISTS regions (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS countries (
    iso2                               TEXT PRIMARY KEY,
    name                               TEXT NOT NULL,
    un_member                          INTEGER DEFAULT 1,
    region_code                        TEXT DEFAULT '',
    invoice_alert_business_days        INTEGER DEFAULT NULL,
    invoice_escalation_business_days   INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS commodities (
    code        TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    grade_code  TEXT NOT NULL DEFAULT 'E',
    grade_name  TEXT NOT NULL DEFAULT 'General Cargo'
  );

  CREATE TABLE IF NOT EXISTS carrier_agents (
    id                 TEXT PRIMARY KEY,
    carrier_code       TEXT NOT NULL,
    port_unlocode      TEXT NOT NULL REFERENCES port_locations(unlocode),
    agent_customer_id  TEXT NOT NULL,
    note               TEXT DEFAULT '',
    created_at         TEXT NOT NULL,
    UNIQUE(carrier_code, port_unlocode)
  );
  CREATE INDEX IF NOT EXISTS idx_carrier_agents_customer ON carrier_agents(agent_customer_id);
`);

// ─── Mappers (duplicated from lib/mappers.js — no shared module between processes) ─────────────
// agentCustomerName is deliberately absent here (unlike the monolith's own mapCarrierAgent) —
// this service owns no `customers` table to join against. The monolith's routes/mdm.js remote
// branch attaches it locally after calling this service — see that file's own comment.
const mapCarrier      = r => ({ code: r.code, name: r.name, shortName: r.short_name || '' });
const mapVessel       = r => ({ imo: r.imo, name: r.name, assetType: r.asset_type || '', flagIso2: r.flag_iso2 || '', flagName: r.flag_name || '', buildYear: r.build_year, grossTonnage: r.gross_tonnage, mmsi: r.mmsi || '', aisVerifiedAt: r.ais_verified_at || '' });
const mapPortLocation = r => ({ unlocode: r.unlocode, name: r.name, latitude: r.latitude, longitude: r.longitude, countryCode: r.country_code, zoneCode: r.zone_code, timezone: r.timezone || null, lastSyncedAt: r.last_synced_at || null });
const mapLinkedPort   = r => ({ id: r.id, primaryUnlocode: r.primary_unlocode, primaryName: r.primary_name || '', linkedUnlocode: r.linked_unlocode, linkedName: r.linked_name || '', note: r.note || '' });
const mapCarrierAgent = r => ({ id: r.id, carrierCode: r.carrier_code, portUnlocode: r.port_unlocode, portName: r.port_name || '', agentCustomerId: r.agent_customer_id, note: r.note || '', createdAt: r.created_at });
const mapTradeLane    = r => ({ code: r.code, name: r.name, description: r.description || '', countryCount: r.country_count ?? 0, transitDays: r.transit_days ?? 0 });
const mapRegion       = r => ({ code: r.code, name: r.name, description: r.description || '' });
const mapCountry      = r => ({ iso2: r.iso2, name: r.name, unMember: r.un_member === 1, regionCode: r.region_code || '', portCount: r.port_count ?? 0, invoiceAlertBusinessDays: r.invoice_alert_business_days ?? null, invoiceEscalationBusinessDays: r.invoice_escalation_business_days ?? null });
const mapCommodity    = r => ({ code: r.code, description: r.description, gradeCode: r.grade_code, gradeName: r.grade_name });

// Public liveness check — no secret required, matches every other service's own GET /health.
app.get("/health", (req, res) => ok(res, { status: "ok", service: "mdm", uptime: process.uptime() }));

// Everything else under /internal/* requires the shared service-to-service secret. This service
// is never called from the browser — only from the monolith's own route handlers and the AIS
// listener.
app.use("/internal", (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== SERVICE_SECRET) return err(res, "Unauthorized", 401);
  next();
});

// ─── Carriers ─────────────────────────────────────────────────────────────

app.get("/internal/carriers", (req, res) => ok(res, db.prepare("SELECT * FROM carriers ORDER BY name").all().map(mapCarrier)));
app.get("/internal/carriers/:code", (req, res) => { const r = db.prepare("SELECT * FROM carriers WHERE code=?").get(req.params.code); if (!r) return err(res, "Not found", 404); ok(res, mapCarrier(r)); });
app.post("/internal/carriers", (req, res) => {
  const { code, name, shortName = '' } = req.body;
  if (!code || !name) return err(res, "code and name required");
  try {
    const codeU = code.toUpperCase().trim();
    db.prepare("INSERT INTO carriers (code,name,short_name) VALUES (?,?,?)").run(codeU, name.trim(), shortName.trim());
    ok(res, mapCarrier({ code: codeU, name: name.trim(), short_name: shortName.trim() }), 201);
  } catch (e) { err(res, isUniqueViolation(e) ? `Carrier ${code} already exists` : e.message); }
});
app.put("/internal/carriers/:code", (req, res) => {
  const { name, shortName = '' } = req.body;
  const info = db.prepare("UPDATE carriers SET name=?, short_name=? WHERE code=?").run(name, shortName, req.params.code);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, mapCarrier({ code: req.params.code, name, short_name: shortName }));
});
app.delete("/internal/carriers/:code", (req, res) => { const info = db.prepare("DELETE FROM carriers WHERE code=?").run(req.params.code); if (info.changes === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.code }); });

// ─── Vessels ──────────────────────────────────────────────────────────────

app.get("/internal/vessels", (req, res) => {
  const { search = '', limit = '50', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
  const where = search.trim() ? "WHERE name LIKE ? OR imo LIKE ? OR asset_type LIKE ?" : "";
  const params = search.trim() ? [`%${search.trim()}%`, `%${search.trim()}%`, `%${search.trim()}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM vessels ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM vessels ${where} ORDER BY name LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows.map(mapVessel), total, limit: lim, offset: off });
});
app.get("/internal/vessels/search", (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return ok(res, []);
  ok(res, db.prepare("SELECT * FROM vessels WHERE name LIKE ? OR imo LIKE ? LIMIT 12").all(`%${q}%`, `%${q}%`).map(mapVessel));
});
app.get("/internal/vessels/:imo", (req, res) => { const r = db.prepare("SELECT * FROM vessels WHERE imo=?").get(req.params.imo); if (!r) return err(res, "Not found", 404); ok(res, mapVessel(r)); });
app.post("/internal/vessels", (req, res) => {
  const { imo, name, assetType = '', flagIso2 = '', flagName = '', buildYear = null, grossTonnage = null } = req.body;
  if (!imo || !name) return err(res, "imo and name required");
  try { db.prepare("INSERT INTO vessels (imo,name,asset_type,flag_iso2,flag_name,build_year,gross_tonnage) VALUES (?,?,?,?,?,?,?)").run(imo.trim(), name.trim(), assetType, flagIso2, flagName, buildYear, grossTonnage); ok(res, mapVessel({ imo: imo.trim(), name: name.trim(), asset_type: assetType, flag_iso2: flagIso2, flag_name: flagName, build_year: buildYear, gross_tonnage: grossTonnage }), 201); }
  catch (e) { err(res, isUniqueViolation(e) ? `Vessel ${imo} already exists` : e.message); }
});
app.put("/internal/vessels/:imo", (req, res) => {
  const { name, assetType = '', flagIso2 = '', flagName = '', buildYear = null, grossTonnage = null } = req.body;
  const info = db.prepare("UPDATE vessels SET name=?, asset_type=?, flag_iso2=?, flag_name=?, build_year=?, gross_tonnage=? WHERE imo=?").run(name, assetType, flagIso2, flagName, buildYear, grossTonnage, req.params.imo);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, mapVessel({ imo: req.params.imo, name, asset_type: assetType, flag_iso2: flagIso2, flag_name: flagName, build_year: buildYear, gross_tonnage: grossTonnage }));
});
app.delete("/internal/vessels/:imo", (req, res) => { const info = db.prepare("DELETE FROM vessels WHERE imo=?").run(req.params.imo); if (info.changes === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.imo }); });

// New: AIS listener's write target (lib/ais-listener.js's handleShipStaticData, remote branch) —
// a three-way insert/update/rename upsert, ported verbatim from the monolith's own inline logic
// so the "same name = quiet mmsi/timestamp refresh, different name = logged RENAMED" behavior is
// identical either side of the toggle. Returns {renamed: bool, previousName} so the caller can
// still decide whether to log an entity_event (this service has no entity_events table of its
// own — that stays a monolith concern).
app.post("/internal/vessels/upsert", (req, res) => {
  const { imo, name, mmsi = '' } = req.body;
  if (!imo || imo === "0" || !name) return err(res, "imo and name required");
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM vessels WHERE imo=?").get(imo);
  if (!existing) {
    try {
      db.prepare("INSERT INTO vessels (imo, name, mmsi, ais_verified_at) VALUES (?,?,?,?)").run(imo, name, mmsi, now);
    } catch { /* a race with a manual MDM insert of the same imo — harmless, next message updates it */ }
    return ok(res, { renamed: false, previousName: null });
  }
  if (existing.name === name) {
    db.prepare("UPDATE vessels SET mmsi=?, ais_verified_at=? WHERE imo=?").run(mmsi, now, imo);
    return ok(res, { renamed: false, previousName: null });
  }
  db.prepare("UPDATE vessels SET name=?, mmsi=?, ais_verified_at=? WHERE imo=?").run(name, mmsi, now, imo);
  ok(res, { renamed: true, previousName: existing.name });
});

// ─── Port Locations ───────────────────────────────────────────────────────

app.get("/internal/port-locations", (req, res) => {
  const { search = '', country = '', limit = '50', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
  const clauses = [], params = [];
  if (search.trim()) { clauses.push("(unlocode LIKE ? OR name LIKE ?)"); const s = `%${search.trim().toUpperCase()}%`; params.push(s, `%${search.trim()}%`); }
  if (country.trim()) { clauses.push("country_code=?"); params.push(country.trim().toUpperCase()); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM port_locations ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
});
app.get("/internal/port-locations/:code/links", (req, res) => {
  const code = req.params.code.toUpperCase();
  const rows = db.prepare(`SELECT CASE WHEN lp.primary_unlocode=? THEN lp.linked_unlocode ELSE lp.primary_unlocode END AS unlocode, pl.name, lp.note FROM linked_ports lp LEFT JOIN port_locations pl ON pl.unlocode=(CASE WHEN lp.primary_unlocode=? THEN lp.linked_unlocode ELSE lp.primary_unlocode END) WHERE lp.primary_unlocode=? OR lp.linked_unlocode=? ORDER BY unlocode`).all(code, code, code, code);
  ok(res, rows);
});
app.get("/internal/port-locations/:code/lanes", (req, res) => {
  const code = req.params.code.toUpperCase();
  const port = db.prepare("SELECT country_code FROM port_locations WHERE unlocode=?").get(code);
  if (!port) return ok(res, { lanes: [], primary: null });
  const lanes = db.prepare("SELECT ctl.lane_code AS code, tl.name FROM country_trade_lanes ctl JOIN trade_lanes tl ON tl.code=ctl.lane_code WHERE ctl.iso2=? ORDER BY ctl.lane_code").all(port.country_code);
  ok(res, { lanes, primary: lanes[0]?.code || null });
});
app.get("/internal/port-locations/:unlocode", (req, res) => { const r = db.prepare("SELECT * FROM port_locations WHERE unlocode=?").get(req.params.unlocode.toUpperCase()); if (!r) return err(res, "Not found", 404); ok(res, mapPortLocation(r)); });
app.post("/internal/port-locations", (req, res) => {
  const { unlocode, name, latitude = 0, longitude = 0, countryCode = '', zoneCode = '' } = req.body;
  if (!unlocode || !name) return err(res, "unlocode and name required");
  const code = unlocode.toUpperCase().trim();
  const derivedCC = code.length >= 2 ? code.slice(0, 2) : countryCode.trim().toUpperCase();
  const finalCC = countryCode.trim().toUpperCase() || derivedCC;
  const now = new Date().toISOString();
  try { db.prepare("INSERT INTO port_locations (unlocode,name,latitude,longitude,country_code,zone_code,last_synced_at) VALUES (?,?,?,?,?,?,?)").run(code, name.trim(), latitude, longitude, finalCC, zoneCode.trim(), now); ok(res, mapPortLocation({ unlocode: code, name: name.trim(), latitude, longitude, country_code: finalCC, zone_code: zoneCode.trim(), last_synced_at: now }), 201); }
  catch (e) { err(res, isUniqueViolation(e) ? `Port ${unlocode} already exists` : e.message); }
});
app.put("/internal/port-locations/:unlocode", (req, res) => {
  const { name, latitude = 0, longitude = 0, countryCode = '', zoneCode = '' } = req.body;
  const cc = countryCode.toUpperCase() || req.params.unlocode.slice(0, 2).toUpperCase();
  const info = db.prepare("UPDATE port_locations SET name=?, latitude=?, longitude=?, country_code=?, zone_code=?, last_synced_at=? WHERE unlocode=?").run(name, latitude, longitude, cc, zoneCode, new Date().toISOString(), req.params.unlocode.toUpperCase());
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, mapPortLocation({ unlocode: req.params.unlocode.toUpperCase(), name, latitude, longitude, country_code: countryCode.toUpperCase(), zone_code: zoneCode }));
});
app.delete("/internal/port-locations/:unlocode", (req, res) => { const info = db.prepare("DELETE FROM port_locations WHERE unlocode=?").run(req.params.unlocode.toUpperCase()); if (info.changes === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.unlocode }); });

// New: bulk lat/lon export — powers lib/ais-listener.js's getPortCoords cache in remote mode
// (a background refill, never a synchronous per-frame call — see that file's own comment).
app.get("/internal/port-coords", (req, res) => {
  ok(res, db.prepare("SELECT unlocode, latitude, longitude FROM port_locations").all());
});

// ─── Linked Ports ─────────────────────────────────────────────────────────

app.get("/internal/linked-ports", (req, res) => {
  const rows = db.prepare(`SELECT lp.*, p1.name AS primary_name, p2.name AS linked_name FROM linked_ports lp LEFT JOIN port_locations p1 ON p1.unlocode=lp.primary_unlocode LEFT JOIN port_locations p2 ON p2.unlocode=lp.linked_unlocode ORDER BY lp.primary_unlocode`).all();
  let mapped = rows.map(mapLinkedPort);
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
app.post("/internal/linked-ports", (req, res) => {
  const { primaryUnlocode, linkedUnlocode, note = '' } = req.body;
  if (!primaryUnlocode || !linkedUnlocode) return err(res, "primaryUnlocode and linkedUnlocode required");
  if (primaryUnlocode.toUpperCase() === linkedUnlocode.toUpperCase()) return err(res, "A port cannot be linked to itself");
  const id = `LNK-${uid()}`;
  try { db.prepare("INSERT INTO linked_ports (id,primary_unlocode,linked_unlocode,note) VALUES (?,?,?,?)").run(id, primaryUnlocode.toUpperCase(), linkedUnlocode.toUpperCase(), note); ok(res, { id, primaryUnlocode: primaryUnlocode.toUpperCase(), linkedUnlocode: linkedUnlocode.toUpperCase(), note }, 201); }
  catch (e) { err(res, isUniqueViolation(e) ? "This port link already exists" : e.message); }
});
app.put("/internal/linked-ports/:id", (req, res) => {
  const { note = '' } = req.body;
  const info = db.prepare("UPDATE linked_ports SET note=? WHERE id=?").run(note, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  const r = db.prepare("SELECT lp.*, p1.name AS primary_name, p2.name AS linked_name FROM linked_ports lp LEFT JOIN port_locations p1 ON p1.unlocode=lp.primary_unlocode LEFT JOIN port_locations p2 ON p2.unlocode=lp.linked_unlocode WHERE lp.id=?").get(req.params.id);
  ok(res, mapLinkedPort(r));
});
app.delete("/internal/linked-ports/:id", (req, res) => { const info = db.prepare("DELETE FROM linked_ports WHERE id=?").run(req.params.id); if (info.changes === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.id }); });

// New: bulk pairs export — powers routes/contracts.js's linkedPortPairsJson() and
// routes/allocations.js's own linked-port matching in remote mode (both need the whole set, not
// one lookup at a time — same "hand over the small table wholesale" idiom the Contract
// Management service already established for its own /internal/contracts/match route).
app.get("/internal/linked-ports/all", (req, res) => {
  ok(res, db.prepare("SELECT primary_unlocode, linked_unlocode FROM linked_ports").all()
    .map(r => [r.primary_unlocode, r.linked_unlocode]));
});

// ─── Carrier Agents ───────────────────────────────────────────────────────
// This service owns carrier_agents + port_locations but NOT customers — every route below joins
// port_locations locally for port_name (owned data) but returns only the raw agent_customer_id,
// never a resolved company name. The monolith's routes/mdm.js remote branch attaches
// agentCustomerName via one local batch `SELECT id, company_name FROM customers WHERE id IN
// (...)` after calling this service, mirroring the same batch-resolve idiom used for
// resolveSeaPorts/resolveAssigneeNames elsewhere in this codebase.

const CARRIER_AGENT_JOIN = `
  SELECT ca.*, pl.name AS port_name
  FROM carrier_agents ca
  LEFT JOIN port_locations pl ON pl.unlocode = ca.port_unlocode
`;

app.get("/internal/carrier-agents", (req, res) => {
  const rows = db.prepare(`${CARRIER_AGENT_JOIN} ORDER BY ca.carrier_code, ca.port_unlocode`).all();
  let mapped = rows.map(mapCarrierAgent);
  if (req.query.limit === undefined && req.query.offset === undefined) return ok(res, mapped);
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    mapped = mapped.filter(a =>
      a.carrierCode.toLowerCase().includes(q) || a.portUnlocode.toLowerCase().includes(q)
      || (a.portName || '').toLowerCase().includes(q) || (a.note || '').toLowerCase().includes(q));
  }
  const lim = Math.min(parseInt(req.query.limit) || 50, 500), off = parseInt(req.query.offset) || 0;
  ok(res, { results: mapped.slice(off, off + lim), total: mapped.length, limit: lim, offset: off });
});
app.post("/internal/carrier-agents", (req, res) => {
  const { carrierCode, portUnlocode, agentCustomerId, note = '' } = req.body;
  if (!carrierCode || !portUnlocode || !agentCustomerId) return err(res, "carrierCode, portUnlocode and agentCustomerId required");
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
app.put("/internal/carrier-agents/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM carrier_agents WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const { agentCustomerId = existing.agent_customer_id, note = existing.note } = req.body;
  if (!agentCustomerId) return err(res, "agentCustomerId required");
  db.prepare("UPDATE carrier_agents SET agent_customer_id=?, note=? WHERE id=?").run(agentCustomerId, note.trim(), req.params.id);
  const r = db.prepare(`${CARRIER_AGENT_JOIN} WHERE ca.id=?`).get(req.params.id);
  ok(res, mapCarrierAgent(r));
});
app.delete("/internal/carrier-agents/:id", (req, res) => {
  const info = db.prepare("DELETE FROM carrier_agents WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

// New: server-side resolveCarrierAgent, including the linked-port fallback — this service owns
// both carrier_agents and linked_ports, so the fallback walk stays entirely local instead of the
// caller doing two round trips. Returns the raw row (no customer name) or null.
app.get("/internal/carrier-agents/resolve", (req, res) => {
  const { carrierCode = '', port = '' } = req.query;
  if (!carrierCode || !port) return ok(res, null);
  const tryPort = p => db.prepare(`${CARRIER_AGENT_JOIN} WHERE ca.carrier_code=? AND ca.port_unlocode=?`).get(carrierCode, p);
  const direct = tryPort(port);
  if (direct) return ok(res, mapCarrierAgent(direct));
  const linked = db.prepare(`
    SELECT CASE WHEN primary_unlocode=? THEN linked_unlocode ELSE primary_unlocode END AS code
    FROM linked_ports WHERE primary_unlocode=? OR linked_unlocode=?
  `).all(port, port, port).map(r => r.code);
  for (const p of linked) { const row = tryPort(p); if (row) return ok(res, mapCarrierAgent(row)); }
  ok(res, null);
});

// ─── Trade Lanes ──────────────────────────────────────────────────────────

app.get("/internal/trade-lanes", (req, res) => ok(res, db.prepare(`
  SELECT tl.*, COUNT(ctl.iso2) AS country_count
  FROM trade_lanes tl
  LEFT JOIN country_trade_lanes ctl ON ctl.lane_code = tl.code
  GROUP BY tl.code
  ORDER BY tl.code
`).all().map(mapTradeLane)));

app.get("/internal/trade-lanes/:code/countries", (req, res) => {
  const rows = db.prepare(`
    SELECT c.iso2, c.name, c.un_member, c.region_code
    FROM country_trade_lanes ctl
    JOIN countries c ON c.iso2 = ctl.iso2
    WHERE ctl.lane_code = ?
    ORDER BY c.name
  `).all(req.params.code.toUpperCase());
  ok(res, rows.map(mapCountry));
});

app.put("/internal/trade-lanes/:code/countries", (req, res) => {
  const code = req.params.code.toUpperCase();
  const iso2s = Array.isArray(req.body.iso2s) ? req.body.iso2s : [];
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM country_trade_lanes WHERE lane_code = ?").run(code);
    const ins = db.prepare("INSERT OR IGNORE INTO country_trade_lanes (iso2, lane_code) VALUES (?, ?)");
    for (const iso2 of iso2s) ins.run(iso2.toUpperCase(), code);
    db.exec("COMMIT");
    ok(res, { code, iso2s });
  } catch (e) { db.exec("ROLLBACK"); err(res, e.message); }
});

app.post("/internal/trade-lanes", (req, res) => {
  const { code, name, description = '', transitDays = 0 } = req.body;
  if (!code || !name) return err(res, "code and name required");
  try {
    const c = code.toUpperCase().trim();
    db.prepare("INSERT INTO trade_lanes (code,name,description,transit_days) VALUES (?,?,?,?)").run(c, name.trim(), description.trim(), Number(transitDays) || 0);
    ok(res, { code: c, name: name.trim(), description: description.trim(), transitDays: Number(transitDays) || 0, countryCount: 0 }, 201);
  } catch (e) { err(res, isUniqueViolation(e) ? `Lane ${code} already exists` : e.message); }
});
app.put("/internal/trade-lanes/:code", (req, res) => {
  const { name, description = '', transitDays = 0 } = req.body;
  const info = db.prepare("UPDATE trade_lanes SET name=?, description=?, transit_days=? WHERE code=?").run(name, description, Number(transitDays) || 0, req.params.code);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { code: req.params.code, name, description, transitDays: Number(transitDays) || 0 });
});
app.get("/internal/trade-lanes/transit-suggestion", (req, res) => {
  const { polLane = '', podLane = '' } = req.query;
  if (!polLane || !podLane || polLane !== podLane) return ok(res, { days: null });
  const row = db.prepare("SELECT transit_days FROM trade_lanes WHERE code=?").get(polLane);
  ok(res, { days: row?.transit_days || null });
});
app.delete("/internal/trade-lanes/:code", (req, res) => { const info = db.prepare("DELETE FROM trade_lanes WHERE code=?").run(req.params.code); if (info.changes === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.code }); });

app.get("/internal/country-trade-lanes", (req, res) => ok(res, db.prepare("SELECT * FROM country_trade_lanes").all()));
app.post("/internal/country-trade-lanes", (req, res) => {
  const { iso2, laneCode } = req.body;
  if (!iso2 || !laneCode) return err(res, "iso2 and laneCode required");
  try { db.prepare("INSERT INTO country_trade_lanes (iso2,lane_code) VALUES (?,?)").run(iso2.toUpperCase(), laneCode.toUpperCase()); ok(res, { iso2: iso2.toUpperCase(), laneCode: laneCode.toUpperCase() }, 201); }
  catch (e) { err(res, isUniqueViolation(e) ? "Assignment already exists" : e.message); }
});
app.put("/internal/countries/:iso2/trade-lanes", (req, res) => {
  const iso2 = req.params.iso2.toUpperCase();
  const lanes = Array.isArray(req.body.lanes) ? req.body.lanes : [];
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM country_trade_lanes WHERE iso2 = ?").run(iso2);
    const ins = db.prepare("INSERT OR IGNORE INTO country_trade_lanes (iso2, lane_code) VALUES (?, ?)");
    for (const lane of lanes) ins.run(iso2, lane.toUpperCase());
    db.exec("COMMIT");
    ok(res, { iso2, lanes });
  } catch (e) { db.exec("ROLLBACK"); err(res, e.message); }
});
app.delete("/internal/country-trade-lanes/:iso2/:laneCode", (req, res) => { db.prepare("DELETE FROM country_trade_lanes WHERE iso2=? AND lane_code=?").run(req.params.iso2, req.params.laneCode); ok(res, { deleted: true }); });

// New: bulk unlocode -> [laneCode] export — powers server.js's rebuildPortLanesMap in remote
// mode. This is read synchronously on every shipment-list request (mapShipment, matchesScopeItem)
// so it MUST stay a monolith-side in-memory cache, never a live per-call fetch — see the plan's
// own note on this. One 4-table JOIN, same shape as the monolith's own PORT_LANES_SQL.
app.get("/internal/port-lanes-index", (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT pl.unlocode, tl.code AS lane_code
    FROM port_locations pl
    JOIN countries c ON c.iso2 = pl.country_code
    JOIN country_trade_lanes ctl ON ctl.iso2 = c.iso2
    JOIN trade_lanes tl ON tl.code = ctl.lane_code
  `).all();
  ok(res, rows);
});

// New: bulk unlocode -> country_code export — powers server.js's portCountryMap boot-time build
// in remote mode. Deliberately a one-time fetch, matching this map's existing "never refreshed
// after boot" behavior on the local side (a known, pre-existing staleness characteristic this
// cut does not fix — see the plan).
app.get("/internal/port-country-map", (req, res) => {
  ok(res, db.prepare("SELECT unlocode, country_code FROM port_locations WHERE country_code IS NOT NULL AND country_code != ''").all());
});

// ─── Regions ──────────────────────────────────────────────────────────────

app.get("/internal/regions", (req, res) => ok(res, db.prepare("SELECT * FROM regions ORDER BY code").all().map(mapRegion)));
app.post("/internal/regions", (req, res) => {
  const { code, name, description = '' } = req.body;
  if (!code || !name) return err(res, "code and name required");
  try { db.prepare("INSERT INTO regions (code,name,description) VALUES (?,?,?)").run(code.toUpperCase().trim(), name.trim(), description.trim()); ok(res, { code: code.toUpperCase().trim(), name: name.trim(), description: description.trim() }, 201); }
  catch (e) { err(res, isUniqueViolation(e) ? `Region ${code} already exists` : e.message); }
});
app.put("/internal/regions/:code", (req, res) => {
  const { name, description = '' } = req.body;
  const info = db.prepare("UPDATE regions SET name=?, description=? WHERE code=?").run(name, description, req.params.code);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { code: req.params.code, name, description });
});
app.delete("/internal/regions/:code", (req, res) => { const info = db.prepare("DELETE FROM regions WHERE code=?").run(req.params.code); if (info.changes === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.code }); });

// ─── Countries ────────────────────────────────────────────────────────────

app.get("/internal/countries", (req, res) => {
  const { search = '', limit = '50', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 300), off = parseInt(offset) || 0;
  const where = search.trim() ? "WHERE c.iso2 LIKE ? OR c.name LIKE ?" : "";
  const params = search.trim() ? [`%${search.trim().toUpperCase()}%`, `%${search.trim()}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM countries c ${where}`).get(...params).n;
  const rows = db.prepare(`
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
app.post("/internal/countries", (req, res) => {
  const { iso2, name, unMember = 1, regionCode = '' } = req.body;
  if (!iso2 || !name) return err(res, "iso2 and name required");
  try { db.prepare("INSERT INTO countries (iso2,name,un_member,region_code) VALUES (?,?,?,?)").run(iso2.toUpperCase().trim(), name.trim(), unMember ? 1 : 0, regionCode.trim()); ok(res, mapCountry({ iso2: iso2.toUpperCase().trim(), name: name.trim(), un_member: unMember ? 1 : 0, region_code: regionCode.trim() }), 201); }
  catch (e) { err(res, isUniqueViolation(e) ? `Country ${iso2} already exists` : e.message); }
});
app.put("/internal/countries/:iso2", (req, res) => {
  const iso2 = req.params.iso2.toUpperCase();
  const existing = db.prepare("SELECT * FROM countries WHERE iso2=?").get(iso2);
  if (!existing) return err(res, "Not found", 404);
  const { name, unMember = 1, regionCode = '', invoiceAlertBusinessDays, invoiceEscalationBusinessDays } = req.body;
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
app.delete("/internal/countries/:iso2", (req, res) => { const info = db.prepare("DELETE FROM countries WHERE iso2=?").run(req.params.iso2.toUpperCase()); if (info.changes === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.iso2 }); });
app.get("/internal/countries/:iso2/locations", (req, res) => {
  const iso2 = req.params.iso2.toUpperCase();
  const search = (req.query.search || "").trim();
  const lim = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const off = parseInt(req.query.offset || "0", 10);
  const where = search ? "WHERE country_code=? AND (unlocode LIKE ? OR name LIKE ?)" : "WHERE country_code=?";
  const params = search ? [iso2, `%${search}%`, `%${search}%`] : [iso2];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM port_locations ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
});

// ─── UN Location Codes ────────────────────────────────────────────────────

app.get("/internal/unlocodes", (req, res) => {
  const { search = '', limit = '50', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
  const where = search.trim() ? "WHERE unlocode LIKE ? OR name LIKE ?" : "";
  const params = search.trim() ? [`%${search.trim().toUpperCase()}%`, `%${search.trim()}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM port_locations ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
});

// ─── Commodities ──────────────────────────────────────────────────────────

app.get("/internal/commodities", (req, res) => {
  const { search = '', grade = '', limit = '50', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 300), off = parseInt(offset) || 0;
  const s = search.trim(), g = grade.trim().toUpperCase();
  const clauses = [], params = [];
  if (s) { clauses.push("(code LIKE ? OR description LIKE ? OR grade_name LIKE ?)"); params.push(`%${s}%`, `%${s}%`, `%${s}%`); }
  if (g) { clauses.push("grade_code=?"); params.push(g); }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM commodities ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM commodities ${where} ORDER BY code LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows.map(mapCommodity), total, limit: lim, offset: off });
});
app.get("/internal/commodities/search", (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return ok(res, []);
  ok(res, db.prepare("SELECT * FROM commodities WHERE code LIKE ? OR description LIKE ? ORDER BY code LIMIT 12").all(`%${q}%`, `%${q}%`).map(mapCommodity));
});
app.get("/internal/commodities/:code", (req, res) => { const r = db.prepare("SELECT * FROM commodities WHERE code=?").get(req.params.code); if (!r) return err(res, "Not found", 404); ok(res, mapCommodity(r)); });
app.post("/internal/commodities", (req, res) => {
  const { code, description, gradeCode = 'E', gradeName = 'General Cargo' } = req.body;
  if (!code || !description) return err(res, "code and description required");
  try { db.prepare("INSERT INTO commodities (code,description,grade_code,grade_name) VALUES (?,?,?,?)").run(code.trim(), description.trim(), gradeCode, gradeName); ok(res, mapCommodity({ code: code.trim(), description: description.trim(), grade_code: gradeCode, grade_name: gradeName }), 201); }
  catch (e) { err(res, isUniqueViolation(e) ? `Commodity ${code} already exists` : e.message); }
});
app.put("/internal/commodities/:code", (req, res) => {
  const { description, gradeCode = 'E', gradeName = 'General Cargo' } = req.body;
  const info = db.prepare("UPDATE commodities SET description=?, grade_code=?, grade_name=? WHERE code=?").run(description, gradeCode, gradeName, req.params.code);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, mapCommodity({ code: req.params.code, description, grade_code: gradeCode, grade_name: gradeName }));
});
app.delete("/internal/commodities/:code", (req, res) => { const info = db.prepare("DELETE FROM commodities WHERE code=?").run(req.params.code); if (info.changes === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.code }); });

// Bulk import for the one-time migration script (scripts/migrate-mdm-to-service.js) — one payload
// per table, each an array of raw snake_case rows (as read directly off the monolith's own
// tables), inserted with INSERT OR IGNORE so a re-run against an already-migrated target doesn't
// blow up on the primary-key collision (unlike Contract Management's own migrate script, MDM's
// tables are all natural-key primary keys — code/imo/unlocode — so IGNORE is the right semantics
// here, not a source of silent duplication the way a surrogate-key table would be).
app.post("/internal/mdm/bulk-import", (req, res) => {
  const { carriers = [], vessels = [], portLocations = [], linkedPorts = [], tradeLanes = [],
          countryTradeLanes = [], regions = [], countries = [], commodities = [], carrierAgents = [] } = req.body || {};
  const counts = {};
  const run = (label, table, cols, rows) => {
    const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    let n = 0;
    // INSERT OR IGNORE never throws on a conflict — it silently affects 0 rows — so the only way
    // to tell "actually inserted" from "ignored duplicate" is result.changes, not whether .run()
    // threw. A real error (malformed row) still throws and is skipped as before.
    for (const r of rows) { try { const info = ins.run(...cols.map(c => r[c] ?? null)); n += info.changes; } catch { /* skip malformed row */ } }
    counts[label] = n;
  };
  db.exec("BEGIN");
  try {
    run("carriers", "carriers", ["code", "name", "short_name"], carriers);
    run("vessels", "vessels", ["imo", "name", "asset_type", "flag_iso2", "flag_name", "build_year", "gross_tonnage", "mmsi", "ais_verified_at"], vessels);
    run("portLocations", "port_locations", ["unlocode", "name", "latitude", "longitude", "country_code", "zone_code", "timezone", "last_synced_at"], portLocations);
    run("linkedPorts", "linked_ports", ["id", "primary_unlocode", "linked_unlocode", "note"], linkedPorts);
    run("tradeLanes", "trade_lanes", ["code", "name", "description", "transit_days"], tradeLanes);
    run("countryTradeLanes", "country_trade_lanes", ["iso2", "lane_code"], countryTradeLanes);
    run("regions", "regions", ["code", "name", "description"], regions);
    run("countries", "countries", ["iso2", "name", "un_member", "region_code", "invoice_alert_business_days", "invoice_escalation_business_days"], countries);
    run("commodities", "commodities", ["code", "description", "grade_code", "grade_name"], commodities);
    run("carrierAgents", "carrier_agents", ["id", "carrier_code", "port_unlocode", "agent_customer_id", "note", "created_at"], carrierAgents);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return err(res, e.message, 500); }
  ok(res, counts, 201);
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`🗺️  MDM Service running on http://localhost:${PORT}`));
}

module.exports = { app, db };
