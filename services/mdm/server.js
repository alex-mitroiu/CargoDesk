"use strict";
const express = require("express");
const path = require("path");
const fs = require("fs");
const { query, transaction } = require("./lib/db");
const { readSecret } = require("./lib/dockerSecret");

const PORT = process.env.MDM_SERVICE_PORT || 3005;
const SERVICE_SECRET_DEV_DEFAULT = "cargoDesk-dev-mdm-service-secret-do-not-use-in-prod";
const SERVICE_SECRET = readSecret("MDM_SERVICE_SECRET", SERVICE_SECRET_DEV_DEFAULT);
if (SERVICE_SECRET === SERVICE_SECRET_DEV_DEFAULT)
  console.warn("⚠  MDM_SERVICE_SECRET not set (checked MDM_SERVICE_SECRET_FILE, then MDM_SERVICE_SECRET) — using insecure dev default. Set it (and the same value in the monolith's own env) before deploying.");

const app = express();

// Crash-safety net — same fix applied to the monolith's server.js after a live stress-test found
// an unhandled route error (a bad enum value, `undefined` bound into a node:sqlite statement)
// kills this entire process, same as any other plain Express 4 app with no error handling. Every
// app.get/post/put/patch/delete handler registered from here on is wrapped so a thrown/rejected
// error reaches next(err) — and the error middleware near app.listen below — instead of crashing.
function wrapAsyncHandler(fn) {
  if (typeof fn !== "function") return fn;
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === "function") result.catch(next);
    } catch (e) { next(e); }
  };
}
for (const method of ["get", "post", "put", "patch", "delete"]) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => original(routePath, ...handlers.map(wrapAsyncHandler));
}
process.on("unhandledRejection", (reason) => console.error("⚠ Unhandled promise rejection (process kept alive):", reason));
process.on("uncaughtException", (e) => console.error("⚠ Uncaught exception (process kept alive):", e));

app.use(express.json({ limit: "5mb" }));

const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const ok = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });
// Postgres/pglite's own unique-violation error code (SQLSTATE 23505) — was a SQLite-specific
// `e.message.includes("UNIQUE constraint")` string check before this migration.
const isUniqueViolation = e => e?.code === "23505";

// Straight port of the monolith's carriers/vessels/port_locations/linked_ports/trade_lanes/
// country_trade_lanes/regions/countries/commodities/carrier_agents schema (server.js) — same
// columns, same defaults, including every ALTER-TABLE addition folded into the base CREATE TABLE
// here (short_name, timezone, mmsi/ais_verified_at, invoice_alert/escalation_business_days,
// capabilities). This service does NOT own `customers` — carrier_agents.agent_customer_id stays
// a loose TEXT column with no REFERENCES clause (the monolith already treats it as an app-level
// guard, not a DB-enforced FK, so nothing changes there) and this service never returns a
// customer name for it, only the raw id — see /internal/carrier-agents' own route comment.
//
// Migrated to Postgres (ARCHITECTURE.md §13, Phase 5) — no PRAGMA needed (Postgres's
// ON DELETE CASCADE on carrier_agent_locations/carrier_agent_schedule_rows is always enforced
// natively). `un_member` is now a real BOOLEAN instead of INTEGER 0/1. The SQLite-era
// create-copy-swap guarded rebuild (`rebuildCarrierAgentsLocations`, restructuring a pre-v0.61
// flat `port_unlocode` column into the header+locations shape) and the additive
// `ALTER TABLE ... ADD COLUMN capabilities` are BOTH eliminated entirely rather than translated —
// Postgres supports every operation those migrations existed to work around natively, and any
// real SQLite mdm.db old enough to need them has already run them at least once (this guard has
// existed since the MDM service's own v0.80.0 launch) — so a table migrated via
// scripts/migrate-mdm-to-service.js is guaranteed to already be in the post-rebuild shape, and a
// brand-new Postgres table is simply created directly in that shape from day one.
async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS carriers (
      code       TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      short_name TEXT DEFAULT ''
    )
  `);
  await query(`
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
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS port_locations (
      unlocode       TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      latitude       REAL DEFAULT 0,
      longitude      REAL DEFAULT 0,
      country_code   TEXT DEFAULT '',
      zone_code      TEXT DEFAULT '',
      timezone       TEXT,
      last_synced_at TEXT DEFAULT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS linked_ports (
      id               TEXT PRIMARY KEY,
      primary_unlocode TEXT NOT NULL REFERENCES port_locations(unlocode),
      linked_unlocode  TEXT NOT NULL REFERENCES port_locations(unlocode),
      note             TEXT DEFAULT '',
      UNIQUE(primary_unlocode, linked_unlocode)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS trade_lanes (
      code         TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      description  TEXT DEFAULT '',
      transit_days INTEGER DEFAULT 0
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS country_trade_lanes (
      iso2      TEXT NOT NULL,
      lane_code TEXT NOT NULL REFERENCES trade_lanes(code),
      PRIMARY KEY (iso2, lane_code)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS regions (
      code        TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT DEFAULT ''
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS countries (
      iso2                               TEXT PRIMARY KEY,
      name                               TEXT NOT NULL,
      un_member                          BOOLEAN NOT NULL DEFAULT TRUE,
      region_code                        TEXT DEFAULT '',
      invoice_alert_business_days        INTEGER DEFAULT NULL,
      invoice_escalation_business_days   INTEGER DEFAULT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS commodities (
      code        TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      grade_code  TEXT NOT NULL DEFAULT 'E',
      grade_name  TEXT NOT NULL DEFAULT 'General Cargo'
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS carrier_agents (
      id                 TEXT PRIMARY KEY,
      carrier_code       TEXT NOT NULL,
      agent_customer_id  TEXT NOT NULL,
      note               TEXT DEFAULT '',
      capabilities       TEXT DEFAULT '[]',
      created_at         TEXT NOT NULL,
      UNIQUE(carrier_code, agent_customer_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_carrier_agents_customer ON carrier_agents(agent_customer_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS carrier_agent_locations (
      id                TEXT PRIMARY KEY,
      carrier_agent_id  TEXT NOT NULL REFERENCES carrier_agents(id) ON DELETE CASCADE,
      carrier_code      TEXT NOT NULL,
      location_type     TEXT NOT NULL CHECK(location_type IN ('unlocode','country')),
      unlocode          TEXT REFERENCES port_locations(unlocode),
      country_iso2      TEXT REFERENCES countries(iso2),
      created_at        TEXT NOT NULL
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cal_agent ON carrier_agent_locations(carrier_agent_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cal_carrier_unlocode ON carrier_agent_locations(carrier_code, unlocode)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cal_carrier_country ON carrier_agent_locations(carrier_code, country_iso2)`);

  await query(`
    CREATE TABLE IF NOT EXISTS carrier_agent_schedule_rows (
      id                TEXT PRIMARY KEY,
      carrier_agent_id  TEXT NOT NULL REFERENCES carrier_agents(id) ON DELETE CASCADE,
      days              TEXT NOT NULL,
      start_time        TEXT NOT NULL,
      end_time          TEXT NOT NULL,
      sort_order        INTEGER DEFAULT 0,
      created_at        TEXT NOT NULL
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_casr_agent ON carrier_agent_schedule_rows(carrier_agent_id)`);
}

// Zero-script onboarding, mirroring the monolith's own db/cargodesk.sample.db pattern — but
// reworked for this migration. The old mechanism (copy a committed mdm.sample.db SQLite FILE into
// place before the process ever opens a connection) has no equivalent once the live database is
// Postgres/pglite, not a single portable file — there's nothing to "copy" into a running Postgres
// server, and pglite's own on-disk format isn't the plain SQLite file either. Replaced with a
// data-level seed: mdm.sample-data.json (committed, extracted once from the retired
// mdm.sample.db via a one-off script) is bulk-inserted through the exact same run() helper
// bulk-import uses, gated on the carriers table being empty — same "only ever seeds a genuinely
// fresh install, never overwrites a running one" guarantee the file-copy version had, just
// checked with a row count instead of a file-existence check. carrier_agents/
// carrier_agent_locations were never in the old sample DB either (every row would point at a
// customers record a fresh install doesn't have yet) and aren't in the JSON — unaffected.
// mdm.sample.db itself is left in the repo as the historical source the JSON was extracted from,
// not deleted — it's just no longer read by this service at runtime.
async function seedIfEmpty() {
  const [{ n }] = await query("SELECT COUNT(*) AS n FROM carriers");
  if (Number(n) > 0) return;
  const seedPath = path.join(__dirname, "mdm.sample-data.json");
  if (!fs.existsSync(seedPath)) return;
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const counts = await bulkImportTables(seed);
  console.log(`🗺️  No MDM reference data found — seeded from the bundled mdm.sample-data.json to get started (${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(", ")})`);
}

// ─── Mappers (duplicated from lib/mappers.js — no shared module between processes) ─────────────
// agentCustomerName is deliberately absent here (unlike the monolith's own mapCarrierAgent) —
// this service owns no `customers` table to join against. The monolith's routes/mdm.js remote
// branch attaches it locally after calling this service — see that file's own comment.
const mapCarrier      = r => ({ code: r.code, name: r.name, shortName: r.short_name || '' });
const mapVessel       = r => ({ imo: r.imo, name: r.name, assetType: r.asset_type || '', flagIso2: r.flag_iso2 || '', flagName: r.flag_name || '', buildYear: r.build_year, grossTonnage: r.gross_tonnage, mmsi: r.mmsi || '', aisVerifiedAt: r.ais_verified_at || '' });
const mapPortLocation = r => ({ unlocode: r.unlocode, name: r.name, latitude: r.latitude, longitude: r.longitude, countryCode: r.country_code, zoneCode: r.zone_code, timezone: r.timezone || null, lastSyncedAt: r.last_synced_at || null });
const mapLinkedPort   = r => ({ id: r.id, primaryUnlocode: r.primary_unlocode, primaryName: r.primary_name || '', linkedUnlocode: r.linked_unlocode, linkedName: r.linked_name || '', note: r.note || '' });
const mapCarrierAgentLocation = l => ({ id: l.id, type: l.location_type, unlocode: l.unlocode || '', portName: l.port_name || '', countryIso2: l.country_iso2 || '', countryName: l.country_name || '' });
const mapCarrierAgentScheduleRow = r => ({ id: r.id, days: JSON.parse(r.days || '[]'), startTime: r.start_time, endTime: r.end_time });
const mapCarrierAgent = (r, locations = []) => ({ id: r.id, carrierCode: r.carrier_code, agentCustomerId: r.agent_customer_id, note: r.note || '', createdAt: r.created_at, capabilities: JSON.parse(r.capabilities || '[]'), locations: locations.map(mapCarrierAgentLocation) });
const mapTradeLane    = r => ({ code: r.code, name: r.name, description: r.description || '', countryCount: Number(r.country_count ?? 0), transitDays: r.transit_days ?? 0 });
const mapRegion       = r => ({ code: r.code, name: r.name, description: r.description || '' });
// unMember read via `!!` rather than `=== 1` — a real bug this migration would otherwise
// introduce silently: `true === 1` is `false`, so a straight port of the old SQLite-integer
// equality check would have made every country's unMember always read as false once the
// underlying column became a real BOOLEAN. Same bug class Phase 4 (contract-management) caught.
const mapCountry      = r => ({ iso2: r.iso2, name: r.name, unMember: !!r.un_member, regionCode: r.region_code || '', portCount: Number(r.port_count ?? 0), invoiceAlertBusinessDays: r.invoice_alert_business_days ?? null, invoiceEscalationBusinessDays: r.invoice_escalation_business_days ?? null });
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

app.get("/internal/carriers", async (req, res) => ok(res, (await query("SELECT * FROM carriers ORDER BY name")).map(mapCarrier)));
app.get("/internal/carriers/:code", async (req, res) => { const [r] = await query("SELECT * FROM carriers WHERE code=$1", [req.params.code]); if (!r) return err(res, "Not found", 404); ok(res, mapCarrier(r)); });
app.post("/internal/carriers", async (req, res) => {
  const { code, name, shortName = '' } = req.body;
  if (!code || !name) return err(res, "code and name required");
  try {
    const codeU = code.toUpperCase().trim();
    await query("INSERT INTO carriers (code,name,short_name) VALUES ($1,$2,$3)", [codeU, name.trim(), shortName.trim()]);
    ok(res, mapCarrier({ code: codeU, name: name.trim(), short_name: shortName.trim() }), 201);
  } catch (e) { err(res, isUniqueViolation(e) ? `Carrier ${code} already exists` : e.message); }
});
app.put("/internal/carriers/:code", async (req, res) => {
  const { name, shortName = '' } = req.body;
  if (!name) return err(res, "name required");
  const result = await query("UPDATE carriers SET name=$1, short_name=$2 WHERE code=$3 RETURNING code", [name, shortName, req.params.code]);
  if (result.length === 0) return err(res, "Not found", 404);
  ok(res, mapCarrier({ code: req.params.code, name, short_name: shortName }));
});
app.delete("/internal/carriers/:code", async (req, res) => { const result = await query("DELETE FROM carriers WHERE code=$1 RETURNING code", [req.params.code]); if (result.length === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.code }); });

// ─── Vessels ──────────────────────────────────────────────────────────────

app.get("/internal/vessels", async (req, res) => {
  const { search = '', limit = '50', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
  const where = search.trim() ? "WHERE name ILIKE $1 OR imo ILIKE $2 OR asset_type ILIKE $3" : "";
  const params = search.trim() ? [`%${search.trim()}%`, `%${search.trim()}%`, `%${search.trim()}%`] : [];
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM vessels ${where}`, params);
  const total = Number(n);
  const limPh = `$${params.length + 1}`, offPh = `$${params.length + 2}`;
  const rows = await query(`SELECT * FROM vessels ${where} ORDER BY name LIMIT ${limPh} OFFSET ${offPh}`, [...params, lim, off]);
  ok(res, { results: rows.map(mapVessel), total, limit: lim, offset: off });
});
app.get("/internal/vessels/search", async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return ok(res, []);
  const rows = await query("SELECT * FROM vessels WHERE name ILIKE $1 OR imo ILIKE $2 LIMIT 12", [`%${q}%`, `%${q}%`]);
  ok(res, rows.map(mapVessel));
});
app.get("/internal/vessels/:imo", async (req, res) => { const [r] = await query("SELECT * FROM vessels WHERE imo=$1", [req.params.imo]); if (!r) return err(res, "Not found", 404); ok(res, mapVessel(r)); });
app.post("/internal/vessels", async (req, res) => {
  const { imo, name, assetType = '', flagIso2 = '', flagName = '', buildYear = null, grossTonnage = null } = req.body;
  if (!imo || !name) return err(res, "imo and name required");
  try {
    await query("INSERT INTO vessels (imo,name,asset_type,flag_iso2,flag_name,build_year,gross_tonnage) VALUES ($1,$2,$3,$4,$5,$6,$7)", [imo.trim(), name.trim(), assetType, flagIso2, flagName, buildYear, grossTonnage]);
    ok(res, mapVessel({ imo: imo.trim(), name: name.trim(), asset_type: assetType, flag_iso2: flagIso2, flag_name: flagName, build_year: buildYear, gross_tonnage: grossTonnage }), 201);
  } catch (e) { err(res, isUniqueViolation(e) ? `Vessel ${imo} already exists` : e.message); }
});
app.put("/internal/vessels/:imo", async (req, res) => {
  const { name, assetType = '', flagIso2 = '', flagName = '', buildYear = null, grossTonnage = null } = req.body;
  if (!name) return err(res, "name required");
  const result = await query("UPDATE vessels SET name=$1, asset_type=$2, flag_iso2=$3, flag_name=$4, build_year=$5, gross_tonnage=$6 WHERE imo=$7 RETURNING imo", [name, assetType, flagIso2, flagName, buildYear, grossTonnage, req.params.imo]);
  if (result.length === 0) return err(res, "Not found", 404);
  ok(res, mapVessel({ imo: req.params.imo, name, asset_type: assetType, flag_iso2: flagIso2, flag_name: flagName, build_year: buildYear, gross_tonnage: grossTonnage }));
});
app.delete("/internal/vessels/:imo", async (req, res) => { const result = await query("DELETE FROM vessels WHERE imo=$1 RETURNING imo", [req.params.imo]); if (result.length === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.imo }); });

// New: AIS listener's write target (lib/ais-listener.js's handleShipStaticData, remote branch) —
// a three-way insert/update/rename upsert, ported verbatim from the monolith's own inline logic
// so the "same name = quiet mmsi/timestamp refresh, different name = logged RENAMED" behavior is
// identical either side of the toggle. Returns {renamed: bool, previousName} so the caller can
// still decide whether to log an entity_event (this service has no entity_events table of its
// own — that stays a monolith concern).
app.post("/internal/vessels/upsert", async (req, res) => {
  const { imo, name, mmsi = '' } = req.body;
  if (!imo || imo === "0" || !name) return err(res, "imo and name required");
  const now = new Date().toISOString();
  const [existing] = await query("SELECT * FROM vessels WHERE imo=$1", [imo]);
  if (!existing) {
    try {
      await query("INSERT INTO vessels (imo, name, mmsi, ais_verified_at) VALUES ($1,$2,$3,$4)", [imo, name, mmsi, now]);
    } catch { /* a race with a manual MDM insert of the same imo — harmless, next message updates it */ }
    return ok(res, { renamed: false, previousName: null });
  }
  if (existing.name === name) {
    await query("UPDATE vessels SET mmsi=$1, ais_verified_at=$2 WHERE imo=$3", [mmsi, now, imo]);
    return ok(res, { renamed: false, previousName: null });
  }
  await query("UPDATE vessels SET name=$1, mmsi=$2, ais_verified_at=$3 WHERE imo=$4", [name, mmsi, now, imo]);
  ok(res, { renamed: true, previousName: existing.name });
});

// ─── Port Locations ───────────────────────────────────────────────────────

app.get("/internal/port-locations", async (req, res) => {
  const { search = '', country = '', limit = '50', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
  const clauses = [], params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (search.trim()) { const s = `%${search.trim()}%`; clauses.push(`(unlocode ILIKE ${p(s)} OR name ILIKE ${p(s)})`); }
  if (country.trim()) { clauses.push(`country_code=${p(country.trim().toUpperCase())}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM port_locations ${where}`, params);
  const total = Number(n);
  const limPh = p(lim), offPh = p(off);
  const rows = await query(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ${limPh} OFFSET ${offPh}`, params);
  ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
});
app.get("/internal/port-locations/:code/links", async (req, res) => {
  const code = req.params.code.toUpperCase();
  const rows = await query(`SELECT CASE WHEN lp.primary_unlocode=$1 THEN lp.linked_unlocode ELSE lp.primary_unlocode END AS unlocode, pl.name, lp.note FROM linked_ports lp LEFT JOIN port_locations pl ON pl.unlocode=(CASE WHEN lp.primary_unlocode=$1 THEN lp.linked_unlocode ELSE lp.primary_unlocode END) WHERE lp.primary_unlocode=$1 OR lp.linked_unlocode=$1 ORDER BY unlocode`, [code]);
  ok(res, rows);
});
app.get("/internal/port-locations/:code/lanes", async (req, res) => {
  const code = req.params.code.toUpperCase();
  const [port] = await query("SELECT country_code FROM port_locations WHERE unlocode=$1", [code]);
  if (!port) return ok(res, { lanes: [], primary: null });
  const lanes = await query("SELECT ctl.lane_code AS code, tl.name FROM country_trade_lanes ctl JOIN trade_lanes tl ON tl.code=ctl.lane_code WHERE ctl.iso2=$1 ORDER BY ctl.lane_code", [port.country_code]);
  ok(res, { lanes, primary: lanes[0]?.code || null });
});
app.get("/internal/port-locations/:unlocode", async (req, res) => { const [r] = await query("SELECT * FROM port_locations WHERE unlocode=$1", [req.params.unlocode.toUpperCase()]); if (!r) return err(res, "Not found", 404); ok(res, mapPortLocation(r)); });
app.post("/internal/port-locations", async (req, res) => {
  const { unlocode, name, latitude = 0, longitude = 0, countryCode = '', zoneCode = '' } = req.body;
  if (!unlocode || !name) return err(res, "unlocode and name required");
  const code = unlocode.toUpperCase().trim();
  const derivedCC = code.length >= 2 ? code.slice(0, 2) : countryCode.trim().toUpperCase();
  const finalCC = countryCode.trim().toUpperCase() || derivedCC;
  const now = new Date().toISOString();
  try {
    await query("INSERT INTO port_locations (unlocode,name,latitude,longitude,country_code,zone_code,last_synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [code, name.trim(), latitude, longitude, finalCC, zoneCode.trim(), now]);
    ok(res, mapPortLocation({ unlocode: code, name: name.trim(), latitude, longitude, country_code: finalCC, zone_code: zoneCode.trim(), last_synced_at: now }), 201);
  } catch (e) { err(res, isUniqueViolation(e) ? `Port ${unlocode} already exists` : e.message); }
});
app.put("/internal/port-locations/:unlocode", async (req, res) => {
  const { name, latitude = 0, longitude = 0, countryCode = '', zoneCode = '' } = req.body;
  if (!name) return err(res, "name required");
  const cc = countryCode.toUpperCase() || req.params.unlocode.slice(0, 2).toUpperCase();
  const result = await query("UPDATE port_locations SET name=$1, latitude=$2, longitude=$3, country_code=$4, zone_code=$5, last_synced_at=$6 WHERE unlocode=$7 RETURNING unlocode", [name, latitude, longitude, cc, zoneCode, new Date().toISOString(), req.params.unlocode.toUpperCase()]);
  if (result.length === 0) return err(res, "Not found", 404);
  ok(res, mapPortLocation({ unlocode: req.params.unlocode.toUpperCase(), name, latitude, longitude, country_code: countryCode.toUpperCase(), zone_code: zoneCode }));
});
app.delete("/internal/port-locations/:unlocode", async (req, res) => { const result = await query("DELETE FROM port_locations WHERE unlocode=$1 RETURNING unlocode", [req.params.unlocode.toUpperCase()]); if (result.length === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.unlocode }); });

// New: bulk lat/lon export — powers lib/ais-listener.js's getPortCoords cache in remote mode
// (a background refill, never a synchronous per-frame call — see that file's own comment).
app.get("/internal/port-coords", async (req, res) => {
  ok(res, await query("SELECT unlocode, latitude, longitude FROM port_locations"));
});

// ─── Linked Ports ─────────────────────────────────────────────────────────

app.get("/internal/linked-ports", async (req, res) => {
  const rows = await query(`SELECT lp.*, p1.name AS primary_name, p2.name AS linked_name FROM linked_ports lp LEFT JOIN port_locations p1 ON p1.unlocode=lp.primary_unlocode LEFT JOIN port_locations p2 ON p2.unlocode=lp.linked_unlocode ORDER BY lp.primary_unlocode`);
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
app.post("/internal/linked-ports", async (req, res) => {
  const { primaryUnlocode, linkedUnlocode, note = '' } = req.body;
  if (!primaryUnlocode || !linkedUnlocode) return err(res, "primaryUnlocode and linkedUnlocode required");
  if (primaryUnlocode.toUpperCase() === linkedUnlocode.toUpperCase()) return err(res, "A port cannot be linked to itself");
  const id = `LNK-${uid()}`;
  try {
    await query("INSERT INTO linked_ports (id,primary_unlocode,linked_unlocode,note) VALUES ($1,$2,$3,$4)", [id, primaryUnlocode.toUpperCase(), linkedUnlocode.toUpperCase(), note]);
    ok(res, { id, primaryUnlocode: primaryUnlocode.toUpperCase(), linkedUnlocode: linkedUnlocode.toUpperCase(), note }, 201);
  } catch (e) { err(res, isUniqueViolation(e) ? "This port link already exists" : e.message); }
});
app.put("/internal/linked-ports/:id", async (req, res) => {
  const { note = '' } = req.body;
  const result = await query("UPDATE linked_ports SET note=$1 WHERE id=$2 RETURNING id", [note, req.params.id]);
  if (result.length === 0) return err(res, "Not found", 404);
  const [r] = await query("SELECT lp.*, p1.name AS primary_name, p2.name AS linked_name FROM linked_ports lp LEFT JOIN port_locations p1 ON p1.unlocode=lp.primary_unlocode LEFT JOIN port_locations p2 ON p2.unlocode=lp.linked_unlocode WHERE lp.id=$1", [req.params.id]);
  ok(res, mapLinkedPort(r));
});
app.delete("/internal/linked-ports/:id", async (req, res) => { const result = await query("DELETE FROM linked_ports WHERE id=$1 RETURNING id", [req.params.id]); if (result.length === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.id }); });

// New: bulk pairs export — powers routes/contracts.js's linkedPortPairsJson() and
// routes/allocations.js's own linked-port matching in remote mode (both need the whole set, not
// one lookup at a time — same "hand over the small table wholesale" idiom the Contract
// Management service already established for its own /internal/contracts/match route).
app.get("/internal/linked-ports/all", async (req, res) => {
  const rows = await query("SELECT primary_unlocode, linked_unlocode FROM linked_ports");
  ok(res, rows.map(r => [r.primary_unlocode, r.linked_unlocode]));
});

// ─── Carrier Agents ───────────────────────────────────────────────────────
// This service owns carrier_agents + port_locations but NOT customers — every route below joins
// port_locations locally for port_name (owned data) but returns only the raw agent_customer_id,
// never a resolved company name. The monolith's routes/mdm.js remote branch attaches
// agentCustomerName via one local batch `SELECT id, company_name FROM customers WHERE id IN
// (...)` after calling this service, mirroring the same batch-resolve idiom used for
// resolveSeaPorts/resolveAssigneeNames elsewhere in this codebase.

// Same capability list as the monolith's own routes/mdm.js copy — see that file's comment.
const AGENT_CAPABILITY_CODES = [
  "port_agency", "documentation", "customs_clearance",
  "road_haulage", "rail_haulage", "barge_haulage",
  "warehousing", "cy_storage", "fumigation", "empty_equipment",
];

const CARRIER_AGENT_JOIN = `SELECT ca.* FROM carrier_agents ca`;
const LOCATION_JOIN = `
  SELECT cal.*, pl.name AS port_name, co.name AS country_name
  FROM carrier_agent_locations cal
  LEFT JOIN port_locations pl ON pl.unlocode = cal.unlocode
  LEFT JOIN countries co ON co.iso2 = cal.country_iso2
`;

async function mapHeadersWithLocations(headerRows) {
  if (headerRows.length === 0) return [];
  const ph = headerRows.map((_, i) => `$${i + 1}`).join(",");
  const locRows = await query(`${LOCATION_JOIN} WHERE cal.carrier_agent_id IN (${ph}) ORDER BY cal.created_at`, headerRows.map(r => r.id));
  const byHeader = new Map();
  for (const l of locRows) {
    if (!byHeader.has(l.carrier_agent_id)) byHeader.set(l.carrier_agent_id, []);
    byHeader.get(l.carrier_agent_id).push(l);
  }
  return headerRows.map(r => mapCarrierAgent(r, byHeader.get(r.id) || []));
}

// Same conflict/redundancy rules as the monolith's own routes/mdm.js copy — see that file's
// comment for the full rationale. Duplicated rather than shared since these are separate
// processes with independent databases.
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

async function discardRedundantUnlocodes(headerId, carrierCode, countryIso2) {
  const redundant = await query(`
    SELECT cal.* FROM carrier_agent_locations cal
    JOIN port_locations pl ON pl.unlocode = cal.unlocode
    WHERE cal.carrier_agent_id=$1 AND cal.location_type='unlocode' AND pl.country_code=$2
  `, [headerId, countryIso2]);
  for (const loc of redundant) await query("DELETE FROM carrier_agent_locations WHERE id=$1", [loc.id]);
  return redundant.map(l => l.unlocode);
}

async function insertLocation(headerId, carrierCode, locationType, unlocode, countryIso2) {
  const id = `CAL-${uid()}`;
  await query(`INSERT INTO carrier_agent_locations (id,carrier_agent_id,carrier_code,location_type,unlocode,country_iso2,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, headerId, carrierCode, locationType,
      locationType === "unlocode" ? unlocode : null, locationType === "country" ? countryIso2 : null, new Date().toISOString()]);
  return id;
}

app.get("/internal/carrier-agents", async (req, res) => {
  const headerRows = await query(`${CARRIER_AGENT_JOIN} ORDER BY ca.carrier_code, ca.agent_customer_id`);
  let mapped = await mapHeadersWithLocations(headerRows);
  if (req.query.limit === undefined && req.query.offset === undefined) return ok(res, mapped);
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    mapped = mapped.filter(a =>
      a.carrierCode.toLowerCase().includes(q) || (a.note || '').toLowerCase().includes(q)
      || a.locations.some(l => l.unlocode.toLowerCase().includes(q) || l.portName.toLowerCase().includes(q)
        || l.countryIso2.toLowerCase().includes(q) || l.countryName.toLowerCase().includes(q)));
  }
  const lim = Math.min(parseInt(req.query.limit) || 50, 500), off = parseInt(req.query.offset) || 0;
  ok(res, { results: mapped.slice(off, off + lim), total: mapped.length, limit: lim, offset: off });
});
app.post("/internal/carrier-agents", async (req, res) => {
  const { carrierCode, agentCustomerId, note = '', locationType, unlocode, countryIso2, capabilities = [] } = req.body;
  if (!carrierCode || !agentCustomerId) return err(res, "carrierCode and agentCustomerId required");
  if (locationType !== "unlocode" && locationType !== "country") return err(res, "locationType must be 'unlocode' or 'country'");
  if (!Array.isArray(capabilities) || capabilities.some(c => !AGENT_CAPABILITY_CODES.includes(c)))
    return err(res, "capabilities must be an array of known capability codes");
  const code = carrierCode.toUpperCase().trim();
  const uc = unlocode?.toUpperCase().trim(), cc = countryIso2?.toUpperCase().trim();
  const conflict = await checkLocationConflict({ carrierCode: code, headerId: '__new__', locationType, unlocode: uc, countryIso2: cc });
  if (conflict.error) return err(res, conflict.error);
  const id = `CAG-${uid()}`;
  const now = new Date().toISOString();
  // Header + first location as one atomic unit — see the monolith's own routes/mdm.js copy of
  // this route for the full rationale (a header with zero locations is meaningless).
  try {
    await transaction(async ({ query: q }) => {
      await q("INSERT INTO carrier_agents (id,carrier_code,agent_customer_id,note,capabilities,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, code, agentCustomerId, note.trim(), JSON.stringify(capabilities), now]);
      await q(`INSERT INTO carrier_agent_locations (id,carrier_agent_id,carrier_code,location_type,unlocode,country_iso2,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [`CAL-${uid()}`, id, code, locationType,
          locationType === "unlocode" ? uc : null, locationType === "country" ? cc : null, now]);
    });
  } catch (e) {
    return err(res, isUniqueViolation(e) ? "This carrier already has a Line Agent header for this customer — add a location to it instead" : e.message);
  }
  const [r] = await query(`${CARRIER_AGENT_JOIN} WHERE ca.id=$1`, [id]);
  ok(res, (await mapHeadersWithLocations([r]))[0], 201);
});
app.put("/internal/carrier-agents/:id", async (req, res) => {
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
app.delete("/internal/carrier-agents/:id", async (req, res) => {
  const result = await query("DELETE FROM carrier_agents WHERE id=$1 RETURNING id", [req.params.id]);
  if (result.length === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});
app.post("/internal/carrier-agents/:id/locations", async (req, res) => {
  const { locationType, unlocode, countryIso2 } = req.body;
  if (locationType !== "unlocode" && locationType !== "country") return err(res, "locationType must be 'unlocode' or 'country'");
  const [header] = await query("SELECT * FROM carrier_agents WHERE id=$1", [req.params.id]);
  if (!header) return err(res, "Not found", 404);
  const uc = unlocode?.toUpperCase().trim(), cc = countryIso2?.toUpperCase().trim();
  const conflict = await checkLocationConflict({ carrierCode: header.carrier_code, headerId: header.id, locationType, unlocode: uc, countryIso2: cc });
  if (conflict.error) return err(res, conflict.error);
  await insertLocation(header.id, header.carrier_code, locationType, uc, cc);
  const discarded = locationType === "country" ? await discardRedundantUnlocodes(header.id, header.carrier_code, cc) : [];
  const [r] = await query(`${CARRIER_AGENT_JOIN} WHERE ca.id=$1`, [header.id]);
  ok(res, { ...(await mapHeadersWithLocations([r]))[0], discarded }, 201);
});
app.delete("/internal/carrier-agent-locations/:id", async (req, res) => {
  const result = await query("DELETE FROM carrier_agent_locations WHERE id=$1 RETURNING id", [req.params.id]);
  if (result.length === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

// Same validate-the-whole-set-in-one-pass shape as the monolith's own copy of these two routes —
// see routes/mdm.js for the full rationale.
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
app.get("/internal/carrier-agents/:id/schedule", async (req, res) => {
  const rows = await query("SELECT * FROM carrier_agent_schedule_rows WHERE carrier_agent_id=$1 ORDER BY sort_order", [req.params.id]);
  ok(res, rows.map(mapCarrierAgentScheduleRow));
});
app.put("/internal/carrier-agents/:id/schedule", async (req, res) => {
  const { rows = [] } = req.body;
  const invalid = validateScheduleRows(rows);
  if (invalid) return err(res, invalid);
  const [header] = await query("SELECT id FROM carrier_agents WHERE id=$1", [req.params.id]);
  if (!header) return err(res, "Not found", 404);
  const now = new Date().toISOString();
  try {
    await transaction(async ({ query: q }) => {
      await q("DELETE FROM carrier_agent_schedule_rows WHERE carrier_agent_id=$1", [req.params.id]);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        await q(`INSERT INTO carrier_agent_schedule_rows
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

// Server-side resolveCarrierAgent, including the linked-port fallback — this service owns both
// carrier_agents and linked_ports, so the fallback walk stays entirely local. A location can
// match either a direct UNLOCODE row or a country-level row (the port's own country). Returns
// the raw row + locations (no customer name) or null.
app.get("/internal/carrier-agents/resolve", async (req, res) => {
  const { carrierCode = '', port = '', all } = req.query;
  if (!carrierCode || !port) return ok(res, all ? [] : null);
  const tryPort = async p => {
    const [direct] = await query(`
      SELECT ca.* FROM carrier_agents ca
      JOIN carrier_agent_locations cal ON cal.carrier_agent_id = ca.id
      WHERE ca.carrier_code=$1 AND cal.location_type='unlocode' AND cal.unlocode=$2
    `, [carrierCode, p]);
    if (direct) return direct;
    const [portRow] = await query("SELECT country_code FROM port_locations WHERE unlocode=$1", [p]);
    if (!portRow?.country_code) return null;
    const [viaCountry] = await query(`
      SELECT ca.* FROM carrier_agents ca
      JOIN carrier_agent_locations cal ON cal.carrier_agent_id = ca.id
      WHERE ca.carrier_code=$1 AND cal.location_type='country' AND cal.country_iso2=$2
    `, [carrierCode, portRow.country_code]);
    return viaCountry || null;
  };
  const direct = await tryPort(port);
  if (direct) return ok(res, all ? [{ ...mapCarrierAgent(direct), matchedVia: port }] : mapCarrierAgent(direct));
  const linkedRows = await query(`
    SELECT CASE WHEN primary_unlocode=$1 THEN linked_unlocode ELSE primary_unlocode END AS code
    FROM linked_ports WHERE primary_unlocode=$1 OR linked_unlocode=$1
  `, [port]);
  const linked = linkedRows.map(r => r.code);
  if (all) {
    const candidates = [];
    for (const p of linked) { const row = await tryPort(p); if (row) candidates.push({ ...mapCarrierAgent(row), matchedVia: p }); }
    return ok(res, candidates);
  }
  for (const p of linked) { const row = await tryPort(p); if (row) return ok(res, mapCarrierAgent(row)); }
  ok(res, null);
});

// ─── Trade Lanes ──────────────────────────────────────────────────────────

app.get("/internal/trade-lanes", async (req, res) => {
  const rows = await query(`
    SELECT tl.*, COUNT(ctl.iso2) AS country_count
    FROM trade_lanes tl
    LEFT JOIN country_trade_lanes ctl ON ctl.lane_code = tl.code
    GROUP BY tl.code
    ORDER BY tl.code
  `);
  ok(res, rows.map(mapTradeLane));
});

app.get("/internal/trade-lanes/:code/countries", async (req, res) => {
  const rows = await query(`
    SELECT c.iso2, c.name, c.un_member, c.region_code
    FROM country_trade_lanes ctl
    JOIN countries c ON c.iso2 = ctl.iso2
    WHERE ctl.lane_code = $1
    ORDER BY c.name
  `, [req.params.code.toUpperCase()]);
  ok(res, rows.map(mapCountry));
});

app.put("/internal/trade-lanes/:code/countries", async (req, res) => {
  const code = req.params.code.toUpperCase();
  const iso2s = Array.isArray(req.body.iso2s) ? req.body.iso2s : [];
  try {
    await transaction(async ({ query: q }) => {
      await q("DELETE FROM country_trade_lanes WHERE lane_code = $1", [code]);
      for (const iso2 of iso2s) await q("INSERT INTO country_trade_lanes (iso2, lane_code) VALUES ($1, $2) ON CONFLICT DO NOTHING", [iso2.toUpperCase(), code]);
    });
    ok(res, { code, iso2s });
  } catch (e) { err(res, e.message); }
});

app.post("/internal/trade-lanes", async (req, res) => {
  const { code, name, description = '', transitDays = 0 } = req.body;
  if (!code || !name) return err(res, "code and name required");
  try {
    const c = code.toUpperCase().trim();
    await query("INSERT INTO trade_lanes (code,name,description,transit_days) VALUES ($1,$2,$3,$4)", [c, name.trim(), description.trim(), Number(transitDays) || 0]);
    ok(res, { code: c, name: name.trim(), description: description.trim(), transitDays: Number(transitDays) || 0, countryCount: 0 }, 201);
  } catch (e) { err(res, isUniqueViolation(e) ? `Lane ${code} already exists` : e.message); }
});
app.put("/internal/trade-lanes/:code", async (req, res) => {
  const { name, description = '', transitDays = 0 } = req.body;
  if (!name) return err(res, "name required");
  const result = await query("UPDATE trade_lanes SET name=$1, description=$2, transit_days=$3 WHERE code=$4 RETURNING code", [name, description, Number(transitDays) || 0, req.params.code]);
  if (result.length === 0) return err(res, "Not found", 404);
  ok(res, { code: req.params.code, name, description, transitDays: Number(transitDays) || 0 });
});
app.get("/internal/trade-lanes/transit-suggestion", async (req, res) => {
  const { polLane = '', podLane = '' } = req.query;
  if (!polLane || !podLane || polLane !== podLane) return ok(res, { days: null });
  const [row] = await query("SELECT transit_days FROM trade_lanes WHERE code=$1", [polLane]);
  ok(res, { days: row?.transit_days || null });
});
app.delete("/internal/trade-lanes/:code", async (req, res) => { const result = await query("DELETE FROM trade_lanes WHERE code=$1 RETURNING code", [req.params.code]); if (result.length === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.code }); });

app.get("/internal/country-trade-lanes", async (req, res) => ok(res, await query("SELECT * FROM country_trade_lanes")));
app.post("/internal/country-trade-lanes", async (req, res) => {
  const { iso2, laneCode } = req.body;
  if (!iso2 || !laneCode) return err(res, "iso2 and laneCode required");
  try {
    await query("INSERT INTO country_trade_lanes (iso2,lane_code) VALUES ($1,$2)", [iso2.toUpperCase(), laneCode.toUpperCase()]);
    ok(res, { iso2: iso2.toUpperCase(), laneCode: laneCode.toUpperCase() }, 201);
  } catch (e) { err(res, isUniqueViolation(e) ? "Assignment already exists" : e.message); }
});
app.put("/internal/countries/:iso2/trade-lanes", async (req, res) => {
  const iso2 = req.params.iso2.toUpperCase();
  const lanes = Array.isArray(req.body.lanes) ? req.body.lanes : [];
  try {
    await transaction(async ({ query: q }) => {
      await q("DELETE FROM country_trade_lanes WHERE iso2 = $1", [iso2]);
      for (const lane of lanes) await q("INSERT INTO country_trade_lanes (iso2, lane_code) VALUES ($1, $2) ON CONFLICT DO NOTHING", [iso2, lane.toUpperCase()]);
    });
    ok(res, { iso2, lanes });
  } catch (e) { err(res, e.message); }
});
app.delete("/internal/country-trade-lanes/:iso2/:laneCode", async (req, res) => { await query("DELETE FROM country_trade_lanes WHERE iso2=$1 AND lane_code=$2", [req.params.iso2, req.params.laneCode]); ok(res, { deleted: true }); });

// New: bulk unlocode -> [laneCode] export — powers server.js's rebuildPortLanesMap in remote
// mode. This is read synchronously on every shipment-list request (mapShipment, matchesScopeItem)
// so it MUST stay a monolith-side in-memory cache, never a live per-call fetch — see the plan's
// own note on this. One 4-table JOIN, same shape as the monolith's own PORT_LANES_SQL.
app.get("/internal/port-lanes-index", async (req, res) => {
  const rows = await query(`
    SELECT DISTINCT pl.unlocode, tl.code AS lane_code
    FROM port_locations pl
    JOIN countries c ON c.iso2 = pl.country_code
    JOIN country_trade_lanes ctl ON ctl.iso2 = c.iso2
    JOIN trade_lanes tl ON tl.code = ctl.lane_code
  `);
  ok(res, rows);
});

// New: bulk unlocode -> country_code export — powers server.js's portCountryMap boot-time build
// in remote mode. Deliberately a one-time fetch, matching this map's existing "never refreshed
// after boot" behavior on the local side (a known, pre-existing staleness characteristic this
// cut does not fix — see the plan).
app.get("/internal/port-country-map", async (req, res) => {
  ok(res, await query("SELECT unlocode, country_code FROM port_locations WHERE country_code IS NOT NULL AND country_code != ''"));
});

// ─── Regions ──────────────────────────────────────────────────────────────

app.get("/internal/regions", async (req, res) => ok(res, (await query("SELECT * FROM regions ORDER BY code")).map(mapRegion)));
app.post("/internal/regions", async (req, res) => {
  const { code, name, description = '' } = req.body;
  if (!code || !name) return err(res, "code and name required");
  try {
    await query("INSERT INTO regions (code,name,description) VALUES ($1,$2,$3)", [code.toUpperCase().trim(), name.trim(), description.trim()]);
    ok(res, { code: code.toUpperCase().trim(), name: name.trim(), description: description.trim() }, 201);
  } catch (e) { err(res, isUniqueViolation(e) ? `Region ${code} already exists` : e.message); }
});
app.put("/internal/regions/:code", async (req, res) => {
  const { name, description = '' } = req.body;
  if (!name) return err(res, "name required");
  const result = await query("UPDATE regions SET name=$1, description=$2 WHERE code=$3 RETURNING code", [name, description, req.params.code]);
  if (result.length === 0) return err(res, "Not found", 404);
  ok(res, { code: req.params.code, name, description });
});
app.delete("/internal/regions/:code", async (req, res) => { const result = await query("DELETE FROM regions WHERE code=$1 RETURNING code", [req.params.code]); if (result.length === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.code }); });

// ─── Countries ────────────────────────────────────────────────────────────

app.get("/internal/countries", async (req, res) => {
  const { search = '', limit = '50', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 300), off = parseInt(offset) || 0;
  const where = search.trim() ? "WHERE c.iso2 ILIKE $1 OR c.name ILIKE $2" : "";
  const params = search.trim() ? [`%${search.trim()}%`, `%${search.trim()}%`] : [];
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM countries c ${where}`, params);
  const total = Number(n);
  const limPh = `$${params.length + 1}`, offPh = `$${params.length + 2}`;
  const rows = await query(`
    SELECT c.*, COUNT(pl.unlocode) AS port_count
    FROM countries c
    LEFT JOIN port_locations pl ON pl.country_code = c.iso2
    ${where}
    GROUP BY c.iso2
    ORDER BY c.name
    LIMIT ${limPh} OFFSET ${offPh}
  `, [...params, lim, off]);
  ok(res, { results: rows.map(mapCountry), total, limit: lim, offset: off });
});
app.post("/internal/countries", async (req, res) => {
  const { iso2, name, unMember = true, regionCode = '' } = req.body;
  if (!iso2 || !name) return err(res, "iso2 and name required");
  try {
    await query("INSERT INTO countries (iso2,name,un_member,region_code) VALUES ($1,$2,$3,$4)", [iso2.toUpperCase().trim(), name.trim(), !!unMember, regionCode.trim()]);
    ok(res, mapCountry({ iso2: iso2.toUpperCase().trim(), name: name.trim(), un_member: !!unMember, region_code: regionCode.trim() }), 201);
  } catch (e) { err(res, isUniqueViolation(e) ? `Country ${iso2} already exists` : e.message); }
});
app.put("/internal/countries/:iso2", async (req, res) => {
  const iso2 = req.params.iso2.toUpperCase();
  const [existing] = await query("SELECT * FROM countries WHERE iso2=$1", [iso2]);
  if (!existing) return err(res, "Not found", 404);
  const { name: nameIn, unMember = true, regionCode = '', invoiceAlertBusinessDays, invoiceEscalationBusinessDays } = req.body;
  // Falls back to the existing row like the two invoice-day fields just below already do —
  // omitting `name` from a partial update must preserve it, not bind `undefined`.
  const name = nameIn !== undefined ? nameIn : existing.name;
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
app.delete("/internal/countries/:iso2", async (req, res) => { const result = await query("DELETE FROM countries WHERE iso2=$1 RETURNING iso2", [req.params.iso2.toUpperCase()]); if (result.length === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.iso2 }); });
app.get("/internal/countries/:iso2/locations", async (req, res) => {
  const iso2 = req.params.iso2.toUpperCase();
  const search = (req.query.search || "").trim();
  const lim = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const off = parseInt(req.query.offset || "0", 10);
  const where = search ? "WHERE country_code=$1 AND (unlocode ILIKE $2 OR name ILIKE $3)" : "WHERE country_code=$1";
  const params = search ? [iso2, `%${search}%`, `%${search}%`] : [iso2];
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM port_locations ${where}`, params);
  const total = Number(n);
  const limPh = `$${params.length + 1}`, offPh = `$${params.length + 2}`;
  const rows = await query(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ${limPh} OFFSET ${offPh}`, [...params, lim, off]);
  ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
});

// ─── UN Location Codes ────────────────────────────────────────────────────

app.get("/internal/unlocodes", async (req, res) => {
  const { search = '', limit = '50', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
  const where = search.trim() ? "WHERE unlocode ILIKE $1 OR name ILIKE $2" : "";
  const params = search.trim() ? [`%${search.trim()}%`, `%${search.trim()}%`] : [];
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM port_locations ${where}`, params);
  const total = Number(n);
  const limPh = `$${params.length + 1}`, offPh = `$${params.length + 2}`;
  const rows = await query(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ${limPh} OFFSET ${offPh}`, [...params, lim, off]);
  ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
});

// ─── Commodities ──────────────────────────────────────────────────────────

app.get("/internal/commodities", async (req, res) => {
  const { search = '', grade = '', limit = '50', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 300), off = parseInt(offset) || 0;
  const s = search.trim(), g = grade.trim().toUpperCase();
  const clauses = [], params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (s) { const sv = `%${s}%`; clauses.push(`(code ILIKE ${p(sv)} OR description ILIKE ${p(sv)} OR grade_name ILIKE ${p(sv)})`); }
  if (g) { clauses.push(`grade_code=${p(g)}`); }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM commodities ${where}`, params);
  const total = Number(n);
  const limPh = p(lim), offPh = p(off);
  const rows = await query(`SELECT * FROM commodities ${where} ORDER BY code LIMIT ${limPh} OFFSET ${offPh}`, params);
  ok(res, { results: rows.map(mapCommodity), total, limit: lim, offset: off });
});
app.get("/internal/commodities/search", async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return ok(res, []);
  const rows = await query("SELECT * FROM commodities WHERE code ILIKE $1 OR description ILIKE $2 ORDER BY code LIMIT 12", [`%${q}%`, `%${q}%`]);
  ok(res, rows.map(mapCommodity));
});
app.get("/internal/commodities/:code", async (req, res) => { const [r] = await query("SELECT * FROM commodities WHERE code=$1", [req.params.code]); if (!r) return err(res, "Not found", 404); ok(res, mapCommodity(r)); });
app.post("/internal/commodities", async (req, res) => {
  const { code, description, gradeCode = 'E', gradeName = 'General Cargo' } = req.body;
  if (!code || !description) return err(res, "code and description required");
  try {
    await query("INSERT INTO commodities (code,description,grade_code,grade_name) VALUES ($1,$2,$3,$4)", [code.trim(), description.trim(), gradeCode, gradeName]);
    ok(res, mapCommodity({ code: code.trim(), description: description.trim(), grade_code: gradeCode, grade_name: gradeName }), 201);
  } catch (e) { err(res, isUniqueViolation(e) ? `Commodity ${code} already exists` : e.message); }
});
app.put("/internal/commodities/:code", async (req, res) => {
  const { description, gradeCode = 'E', gradeName = 'General Cargo' } = req.body;
  if (!description) return err(res, "description required");
  const result = await query("UPDATE commodities SET description=$1, grade_code=$2, grade_name=$3 WHERE code=$4 RETURNING code", [description, gradeCode, gradeName, req.params.code]);
  if (result.length === 0) return err(res, "Not found", 404);
  ok(res, mapCommodity({ code: req.params.code, description, grade_code: gradeCode, grade_name: gradeName }));
});
app.delete("/internal/commodities/:code", async (req, res) => { const result = await query("DELETE FROM commodities WHERE code=$1 RETURNING code", [req.params.code]); if (result.length === 0) return err(res, "Not found", 404); ok(res, { deleted: req.params.code }); });

// Shared by both the bulk-import route and seedIfEmpty() above — one payload per table, each an
// array of raw snake_case rows, inserted with ON CONFLICT DO NOTHING so a re-run against an
// already-migrated/already-seeded target doesn't blow up on the primary-key collision. Every one
// of these tables uses a natural-key primary key (code/imo/unlocode), so DO NOTHING is exactly
// the right semantics — not a source of silent duplication the way a surrogate-key table would be.
async function bulkImportTables(payload) {
  const { carriers = [], vessels = [], portLocations = [], linkedPorts = [], tradeLanes = [],
          countryTradeLanes = [], regions = [], countries = [], commodities = [],
          carrierAgents = [], carrierAgentLocations = [] } = payload || {};
  const counts = {};
  const run = async ({ query: q }, label, table, cols, rows) => {
    let n = 0;
    for (const r of rows) {
      try {
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
        const result = await q(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING RETURNING 1`,
          cols.map(c => r[c] ?? null));
        n += result.length;
      } catch { /* skip malformed row */ }
    }
    counts[label] = n;
  };
  await transaction(async (client) => {
    await run(client, "carriers", "carriers", ["code", "name", "short_name"], carriers);
    await run(client, "vessels", "vessels", ["imo", "name", "asset_type", "flag_iso2", "flag_name", "build_year", "gross_tonnage", "mmsi", "ais_verified_at"], vessels);
    await run(client, "portLocations", "port_locations", ["unlocode", "name", "latitude", "longitude", "country_code", "zone_code", "timezone", "last_synced_at"], portLocations);
    await run(client, "linkedPorts", "linked_ports", ["id", "primary_unlocode", "linked_unlocode", "note"], linkedPorts);
    await run(client, "tradeLanes", "trade_lanes", ["code", "name", "description", "transit_days"], tradeLanes);
    await run(client, "countryTradeLanes", "country_trade_lanes", ["iso2", "lane_code"], countryTradeLanes);
    await run(client, "regions", "regions", ["code", "name", "description"], regions);
    await run(client, "countries", "countries", ["iso2", "name", "un_member", "region_code", "invoice_alert_business_days", "invoice_escalation_business_days"], countries);
    await run(client, "commodities", "commodities", ["code", "description", "grade_code", "grade_name"], commodities);
    await run(client, "carrierAgents", "carrier_agents", ["id", "carrier_code", "agent_customer_id", "note", "created_at"], carrierAgents);
    await run(client, "carrierAgentLocations", "carrier_agent_locations", ["id", "carrier_agent_id", "carrier_code", "location_type", "unlocode", "country_iso2", "created_at"], carrierAgentLocations);
  });
  return counts;
}

// Bulk import for the one-time migration script (scripts/migrate-mdm-to-service.js).
app.post("/internal/mdm/bulk-import", async (req, res) => {
  try {
    const counts = await bulkImportTables(req.body);
    ok(res, counts, 201);
  } catch (e) { err(res, e.message, 500); }
});

// Error-handling middleware — must be registered after every route above. Malformed JSON bodies
// get a clean 400 instead of body-parser's raw HTML/stack-trace page; anything else forwarded via
// wrapAsyncHandler is logged in full server-side and answered with a generic 500 (never the raw
// error/stack to the caller).
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({ error: "Malformed request body — expected valid JSON" });
  }
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, error);
  res.status(error?.status || 500).json({ error: "Internal server error" });
});

if (require.main === module) {
  initSchema()
    .then(async () => {
      await seedIfEmpty();
      app.listen(PORT, () => console.log(`🗺️  MDM Service running on http://localhost:${PORT}`));
    })
    .catch(e => { console.error("Failed to initialize database schema:", e); process.exit(1); });
}

module.exports = { app, initSchema };
