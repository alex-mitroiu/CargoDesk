"use strict";
const express    = require("express");
const http       = require("http");
const https      = require("https");
const path       = require("path");
const { WebSocketServer } = require("ws");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "cargoDesk-dev-secret-do-not-use-in-prod";
if (!process.env.JWT_SECRET)
  console.warn("⚠  JWT_SECRET env var not set — using insecure dev default. Set it before deploying.");

const app = express();
const db  = new DatabaseSync(path.join(__dirname, "cargodesk.db"));
app.use(express.json({ limit: "25mb" }));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2,8).toUpperCase();
const ok  = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });
const isUniqueViolation = e => e?.message?.includes("UNIQUE constraint");

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;

  CREATE TABLE IF NOT EXISTS shipments (
    id              TEXT PRIMARY KEY,
    pol             TEXT NOT NULL,
    pod             TEXT NOT NULL,
    carrier_code    TEXT NOT NULL,
    contract_type   TEXT NOT NULL DEFAULT 'SPOT',
    contract_notes  TEXT DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'Active',
    created_at      TEXT NOT NULL,
    etd             TEXT DEFAULT '',
    eta             TEXT DEFAULT '',
    booking_ref     TEXT DEFAULT '',
    bl_number       TEXT DEFAULT '',
    vessel          TEXT DEFAULT '',
    voyage          TEXT DEFAULT '',
    incoterm        TEXT DEFAULT '',
    vessel_imo      TEXT DEFAULT '',
    contract_id     TEXT DEFAULT '',
    commodity_code  TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS containers (
    id               TEXT PRIMARY KEY,
    shipment_id      TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    container_number TEXT NOT NULL DEFAULT '',
    seal_number      TEXT NOT NULL DEFAULT '',
    size             TEXT NOT NULL CHECK(size IN ('20','40')),
    type             TEXT NOT NULL,
    hs_code          TEXT DEFAULT '',
    cargo_description TEXT DEFAULT '',
    gross_weight_kg  REAL,
    volume_cbm       REAL,
    is_dg            INTEGER DEFAULT 0,
    dg_class         TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS allocations (
    id              TEXT PRIMARY KEY,
    carrier_code    TEXT NOT NULL,
    pol             TEXT DEFAULT '',
    pod             TEXT DEFAULT '',
    origin_lane     TEXT DEFAULT '',
    dest_lane       TEXT DEFAULT '',
    trade_lane      TEXT DEFAULT '',
    allocated_teu   INTEGER NOT NULL,
    effective_date  TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    alert_threshold INTEGER DEFAULT 80,
    notes           TEXT DEFAULT '',
    coverage_scope  TEXT DEFAULT 'STRICT'
  );

  CREATE TABLE IF NOT EXISTS carriers (
    code       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    short_name TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS vessels (
    imo           TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    asset_type    TEXT DEFAULT '',
    flag_iso2     TEXT DEFAULT '',
    flag_name     TEXT DEFAULT '',
    build_year    INTEGER,
    gross_tonnage INTEGER
  );

  CREATE TABLE IF NOT EXISTS port_locations (
    unlocode       TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    latitude       REAL DEFAULT 0,
    longitude      REAL DEFAULT 0,
    country_code   TEXT DEFAULT '',
    zone_code      TEXT DEFAULT '',
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
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT DEFAULT ''
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
    iso2        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    un_member   INTEGER DEFAULT 1,
    region_code TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    section     TEXT DEFAULT '',
    description TEXT DEFAULT '',
    priority    TEXT DEFAULT 'Medium',
    status      TEXT DEFAULT 'Ready',
    position    INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  -- ── Shipment event log (all changes) ──
  CREATE TABLE IF NOT EXISTS shipment_events (
    id          TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    field       TEXT DEFAULT NULL,
    old_value   TEXT DEFAULT NULL,
    new_value   TEXT DEFAULT NULL,
    actor       TEXT NOT NULL DEFAULT 'user',
    occurred_at TEXT NOT NULL,
    meta        TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_shp_events ON shipment_events(shipment_id, occurred_at);

  -- ── Shipment status audit log ──
  CREATE TABLE IF NOT EXISTS status_log (
    id           TEXT PRIMARY KEY,
    shipment_id  TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    from_status  TEXT NOT NULL,
    to_status    TEXT NOT NULL,
    changed_at   TEXT NOT NULL,
    changed_by   TEXT NOT NULL DEFAULT 'system'
  );
  CREATE INDEX IF NOT EXISTS idx_status_log_shipment ON status_log(shipment_id, changed_at);

  -- ── Customers ──
  CREATE TABLE IF NOT EXISTS customers (
    id           TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    address1     TEXT DEFAULT '',
    address2     TEXT DEFAULT '',
    city         TEXT DEFAULT '',
    state        TEXT DEFAULT '',
    postal_code  TEXT DEFAULT '',
    country_iso2 TEXT DEFAULT '',
    phone        TEXT DEFAULT '',
    fax          TEXT DEFAULT '',
    email        TEXT DEFAULT '',
    website      TEXT DEFAULT '',
    notes        TEXT DEFAULT '',
    created_at   TEXT NOT NULL
  );

  -- ── Commodities (Maersk freight type registry) ──
  CREATE TABLE IF NOT EXISTS commodities (
    code        TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    grade_code  TEXT NOT NULL DEFAULT 'E',
    grade_name  TEXT NOT NULL DEFAULT 'General Cargo'
  );
  CREATE INDEX IF NOT EXISTS idx_commodities_desc ON commodities(description);

  -- ── Shipment Messages ──
  CREATE TABLE IF NOT EXISTS shipment_messages (
    id          TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL,
    body        TEXT NOT NULL,
    author      TEXT NOT NULL,
    role        TEXT DEFAULT '',
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shp_msgs ON shipment_messages(shipment_id, created_at);

  -- ── System Messages ──
  CREATE TABLE IF NOT EXISTS system_messages (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT DEFAULT '',
    severity    TEXT DEFAULT 'info',
    active_from TEXT DEFAULT '',
    active_to   TEXT DEFAULT '',
    created_at  TEXT NOT NULL
  );

  -- ── Contracts ──
  CREATE TABLE IF NOT EXISTS contracts (
    id                TEXT PRIMARY KEY,
    contract_number   TEXT DEFAULT '',
    carrier_code      TEXT DEFAULT '',
    named_account_id  TEXT DEFAULT '',
    named_account     TEXT DEFAULT '',
    movement_type     TEXT DEFAULT 'FCL',
    container_types   TEXT DEFAULT '[]',
    dg_allowed        INTEGER DEFAULT 0,
    imdg_classes      TEXT DEFAULT '[]',
    valid_from        TEXT DEFAULT '',
    valid_to          TEXT DEFAULT '',
    currency          TEXT DEFAULT 'USD',
    status            TEXT DEFAULT 'Active',
    notes             TEXT DEFAULT '',
    created_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contract_legs (
    id             TEXT PRIMARY KEY,
    contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    leg_order      INTEGER DEFAULT 0,
    pol            TEXT DEFAULT '',
    pol_name       TEXT DEFAULT '',
    pod            TEXT DEFAULT '',
    pod_name       TEXT DEFAULT '',
    transit_days   INTEGER DEFAULT 0,
    vessel_service TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS contract_rates (
    id             TEXT PRIMARY KEY,
    contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    service_code   TEXT DEFAULT '',
    description    TEXT DEFAULT '',
    amount         REAL DEFAULT 0,
    currency       TEXT DEFAULT 'USD',
    amount_usd     REAL DEFAULT 0,
    unit           TEXT DEFAULT 'per_container',
    container_type TEXT DEFAULT '',
    sort_order     INTEGER DEFAULT 0,
    notes          TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS entity_events (
    id          TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    field       TEXT,
    old_value   TEXT,
    new_value   TEXT,
    meta        TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sanctions_entries (
    id               TEXT PRIMARY KEY,
    source           TEXT NOT NULL,
    ref_id           TEXT DEFAULT '',
    entity_name      TEXT NOT NULL,
    entity_name_norm TEXT NOT NULL,
    entity_type      TEXT DEFAULT '',
    program          TEXT DEFAULT '',
    aliases_norm     TEXT DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_sanctions_norm ON sanctions_entries(entity_name_norm);

  CREATE TABLE IF NOT EXISTS sanctions_syncs (
    source       TEXT PRIMARY KEY,
    synced_at    TEXT NOT NULL,
    entry_count  INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS shipment_screenings (
    id              TEXT PRIMARY KEY,
    shipment_id     TEXT NOT NULL,
    screened_at     TEXT NOT NULL,
    result          TEXT NOT NULL,
    hits            TEXT DEFAULT '[]',
    overridden_at   TEXT,
    override_reason TEXT,
    UNIQUE(shipment_id)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- ── Users ──
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer',
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login    TEXT
  );
`);

// ─── Safe migrations ──────────────────────────────────────────────────────────

const migrations = [
  "ALTER TABLE shipments ADD COLUMN contract_id     TEXT DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN commodity_code TEXT DEFAULT ''",
  "ALTER TABLE allocations ADD COLUMN trade_lane      TEXT    DEFAULT ''",
  "ALTER TABLE allocations ADD COLUMN notes           TEXT    DEFAULT ''",
  "ALTER TABLE allocations ADD COLUMN alert_threshold INTEGER DEFAULT 80",
  "ALTER TABLE allocations ADD COLUMN pol              TEXT    DEFAULT ''",
  "ALTER TABLE allocations ADD COLUMN pod              TEXT    DEFAULT ''",
  "ALTER TABLE allocations ADD COLUMN origin_lane      TEXT    DEFAULT ''",
  "ALTER TABLE allocations ADD COLUMN dest_lane        TEXT    DEFAULT ''",
  "ALTER TABLE allocations ADD COLUMN coverage_scope   TEXT    DEFAULT 'STRICT'",
  "ALTER TABLE containers  ADD COLUMN seal_number     TEXT    DEFAULT ''",
  "ALTER TABLE containers  ADD COLUMN commodity       TEXT    DEFAULT ''",
  "ALTER TABLE containers  ADD COLUMN gross_weight_kg REAL    DEFAULT NULL",
  "ALTER TABLE containers  ADD COLUMN volume_cbm      REAL    DEFAULT NULL",
  "ALTER TABLE containers  ADD COLUMN is_dg           INTEGER DEFAULT 0",
  "ALTER TABLE containers  ADD COLUMN dg_class        TEXT    DEFAULT ''",
  "ALTER TABLE containers  ADD COLUMN cargo_description TEXT    DEFAULT ''",
  "ALTER TABLE port_locations ADD COLUMN last_synced_at TEXT DEFAULT NULL",
  "ALTER TABLE carriers    ADD COLUMN short_name      TEXT    DEFAULT ''",
  "ALTER TABLE tickets     ADD COLUMN shipment_id     TEXT    DEFAULT NULL",
  "ALTER TABLE tickets     ADD COLUMN type            TEXT    DEFAULT 'Task'",
  "ALTER TABLE tickets     ADD COLUMN version         TEXT    DEFAULT ''",
  "ALTER TABLE shipments   ADD COLUMN shipper_id      TEXT    DEFAULT ''",
  "ALTER TABLE shipments   ADD COLUMN shipper_name    TEXT    DEFAULT ''",
  "ALTER TABLE shipments   ADD COLUMN consignee_id    TEXT    DEFAULT ''",
  "ALTER TABLE shipments   ADD COLUMN consignee_name  TEXT    DEFAULT ''",
  "ALTER TABLE shipments   ADD COLUMN principal_id    TEXT    DEFAULT ''",
  "ALTER TABLE shipments   ADD COLUMN principal_name  TEXT    DEFAULT ''",
  "ALTER TABLE shipments   ADD COLUMN contract_ref    TEXT    DEFAULT ''",
  "ALTER TABLE contract_legs ADD COLUMN pol_linked_allowed INTEGER DEFAULT 0",
  "ALTER TABLE contract_legs ADD COLUMN pod_linked_allowed INTEGER DEFAULT 0",
  "ALTER TABLE allocations ADD COLUMN contract_id     TEXT DEFAULT ''",
  "ALTER TABLE allocations ADD COLUMN contract_number TEXT DEFAULT ''",
  "UPDATE shipments SET contract_type = 'Central' WHERE contract_type = 'Central Contract'",
  `CREATE TABLE IF NOT EXISTS shipment_cost_lines (
    id            TEXT PRIMARY KEY,
    shipment_id   TEXT NOT NULL,
    type          TEXT NOT NULL,
    charge_code   TEXT NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'USD',
    amount        REAL NOT NULL DEFAULT 0,
    exchange_rate REAL NOT NULL DEFAULT 1,
    notes         TEXT DEFAULT '',
    created_at    TEXT NOT NULL
  )`,
  "ALTER TABLE shipment_cost_lines ADD COLUMN container_id TEXT DEFAULT ''",
  "ALTER TABLE shipment_cost_lines ADD COLUMN source TEXT DEFAULT 'manual'",
  "ALTER TABLE shipment_cost_lines ADD COLUMN modified_at TEXT",
  `CREATE TABLE IF NOT EXISTS ticket_links (
    id         TEXT PRIMARY KEY,
    from_id    TEXT NOT NULL,
    to_id      TEXT NOT NULL,
    link_type  TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS milestone_templates (
    id             TEXT PRIMARY KEY,
    template_key   TEXT NOT NULL DEFAULT 'FCL',
    carrier_code   TEXT NOT NULL DEFAULT '',
    trade_lane     TEXT NOT NULL DEFAULT '',
    milestone_key  TEXT NOT NULL,
    label          TEXT NOT NULL,
    sequence_order INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS shipment_milestones (
    id             TEXT PRIMARY KEY,
    shipment_id    TEXT NOT NULL,
    milestone_key  TEXT NOT NULL,
    label          TEXT NOT NULL,
    sequence_order INTEGER NOT NULL DEFAULT 0,
    estimated_date TEXT NOT NULL DEFAULT '',
    completed_at   TEXT NOT NULL DEFAULT '',
    completed_by   TEXT NOT NULL DEFAULT '',
    note           TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL
  )`,
  "ALTER TABLE contracts ADD COLUMN contract_ref TEXT DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN allocation_id        TEXT DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN space_skip_reason    TEXT DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN space_overage_reason TEXT DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN space_badge          TEXT DEFAULT ''",
];

for (const sql of migrations) {
  try { db.exec(sql); } catch {}
}

// ─── Seed admin user ──────────────────────────────────────────────────────────

;(function seedAdmin() {
  const ADMIN_EMAIL = "alex.mitroiu@gmail.com";
  const TEMP_PW    = "Admin2026!";
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
  if (!exists) {
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 'admin', 1, datetime('now'))"
    ).run(`USR-${uid()}`, ADMIN_EMAIL, "Alex Mitroiu", bcrypt.hashSync(TEMP_PW, 10));
    console.log(`\n⚓  Admin user created: ${ADMIN_EMAIL}`);
    console.log(`   Temporary password : ${TEMP_PW}`);
    console.log(`   Change it via the User Management panel.\n`);
  }
})();

// ─── App Settings ─────────────────────────────────────────────────────────────

function getSettings() {
  try {
    return Object.fromEntries(db.prepare("SELECT key, value FROM app_settings").all().map(r => [r.key, r.value]));
  } catch { return {}; }
}

// Seed defaults (INSERT OR IGNORE — never overwrite saved user choices)
const SETTING_DEFAULTS = {
  api_fx_enabled:             'true',
  api_fx_interval_value:      '1',
  api_fx_interval_unit:       'days',
  api_weather_enabled:        'true',
  api_weather_interval_value: '1',
  api_weather_interval_unit:  'days',
  api_ofac_enabled:           'true',
  api_ofac_interval_value:    '1',
  api_ofac_interval_unit:     'weeks',
  finance_view_enabled:       'true',
  api_ws_enabled:             'true',
  api_shipments_enabled:      'true',
  api_contracts_enabled:      'true',
  api_customers_enabled:      'true',
  api_carriers_enabled:       'true',
  api_vessels_enabled:        'true',
  api_ports_enabled:          'true',
  api_sysmsg_enabled:         'true',
};
{
  const ins = db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)");
  db.exec("BEGIN");
  try {
    for (const [k, v] of Object.entries(SETTING_DEFAULTS)) ins.run(k, v);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); }
}

// ─── Sanctions helpers ────────────────────────────────────────────────────────

// OFAC-embargoed country codes (2-letter ISO, extracted from port UNLOCODE prefix)
const EMBARGOED_COUNTRIES = new Set([
  'CU', // Cuba
  'IR', // Iran
  'KP', // North Korea (DPRK)
  'SY', // Syria
  'RU', // Russia
  'BY', // Belarus
  'MM', // Myanmar
  'ZW', // Zimbabwe
  'SS', // South Sudan
  'CF', // Central African Republic
  'LY', // Libya
  'SO', // Somalia
  'YE', // Yemen
  'VE', // Venezuela
  'SD', // Sudan
  'ER', // Eritrea
]);

const normSanctionName = s =>
  (s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

// In-memory index: normalized name/alias → entry metadata
let sanctionsMap = new Map();

function loadSanctionsIndex() {
  sanctionsMap = new Map();
  const rows = db.prepare(
    "SELECT source, entity_name, entity_type, program, aliases_norm FROM sanctions_entries"
  ).all();
  for (const r of rows) {
    const meta = { entityName: r.entity_name, entityType: r.entity_type, program: r.program, source: r.source };
    sanctionsMap.set(normSanctionName(r.entity_name), meta);
    try {
      for (const alias of JSON.parse(r.aliases_norm || '[]')) {
        if (!sanctionsMap.has(alias)) sanctionsMap.set(alias, meta);
      }
    } catch {}
  }
}
try { loadSanctionsIndex(); } catch {}

// ─── OFAC SDN sync (extracted so route and scheduler both call it) ─────────────

function httpsGetFollowRedirects(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("Too many redirects"));
    https.get(url, { rejectUnauthorized: false }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = r.headers.location.startsWith("http")
          ? r.headers.location
          : new URL(r.headers.location, url).href;
        return resolve(httpsGetFollowRedirects(next, depth + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error(`OFAC returned HTTP ${r.statusCode}`)); }
      resolve(r);
    }).on("error", reject);
  });
}

async function syncOfacSdn() {
  const resp = await httpsGetFollowRedirects("https://www.treasury.gov/ofac/downloads/sdn.xml");
  const xml = await new Promise((resolve, reject) => {
    const bufs = [];
    resp.on("data", c => bufs.push(c));
    resp.on("end", () => resolve(Buffer.concat(bufs).toString("utf8")));
    resp.on("error", reject);
  });

  const entries = [];
  for (const block of xml.split("<sdnEntry>").slice(1)) {
    const end = block.indexOf("</sdnEntry>");
    if (end === -1) continue;
    const e      = block.substring(0, end);
    const get    = tag => { const m = e.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)); return m ? m[1].trim() : ""; };
    const getAll = tag => [...e.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map(m => m[1].trim());
    const last   = get("lastName");
    if (!last) continue;
    const first      = get("firstName");
    const name       = first ? `${first} ${last}` : last;
    const aliasNorms = [];
    for (const ab of [...e.matchAll(/<aka>([\s\S]*?)<\/aka>/g)]) {
      const al = (ab[1].match(/<lastName>([^<]*)<\/lastName>/) || [])[1] || "";
      const af = (ab[1].match(/<firstName>([^<]*)<\/firstName>/) || [])[1] || "";
      const a  = af ? `${af} ${al}`.trim() : al.trim();
      if (a) aliasNorms.push(normSanctionName(a));
    }
    entries.push({ refId: get("uid"), name, sdnType: get("sdnType"), programs: getAll("program").join("; "), aliasNorms });
  }

  db.prepare("DELETE FROM sanctions_entries WHERE source='OFAC-SDN'").run();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO sanctions_entries (id,source,ref_id,entity_name,entity_name_norm,entity_type,program,aliases_norm)
     VALUES (?,'OFAC-SDN',?,?,?,?,?,?)`
  );
  db.exec("BEGIN");
  try {
    for (const e of entries)
      ins.run(`OFAC-${e.refId}`, e.refId, e.name, normSanctionName(e.name), e.sdnType, e.programs, JSON.stringify(e.aliasNorms));
    db.exec("COMMIT");
  } catch (e2) { db.exec("ROLLBACK"); throw e2; }

  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO sanctions_syncs (source,synced_at,entry_count) VALUES ('OFAC-SDN',?,?)").run(now, entries.length);
  loadSanctionsIndex();
  return { source: "OFAC-SDN", syncedAt: now, entries: entries.length };
}

// ─── OFAC auto-sync scheduler ─────────────────────────────────────────────────

let ofacAutoSyncTimer = null;

// setTimeout is backed by a 32-bit int; anything above ~24.8 days wraps to 1ms.
const MAX_TIMER_MS = 2_000_000_000; // ~23.1 days — safe upper bound

function scheduleNextOfacSync(retryDelayMs = null) {
  clearTimeout(ofacAutoSyncTimer);
  try {
    const s = getSettings();
    if (s.api_ofac_enabled !== 'true') return;
    const lastSync = db.prepare("SELECT synced_at FROM sanctions_syncs WHERE source='OFAC-SDN'").get();
    if (!lastSync) return; // Never synced — user must trigger the first one manually

    let delay;
    if (retryDelayMs != null) {
      // After a failed sync: wait the requested retry interval, then try again
      delay = Math.min(MAX_TIMER_MS, retryDelayMs);
    } else {
      const val        = Math.max(1, parseInt(s.api_ofac_interval_value) || 1);
      const unit       = s.api_ofac_interval_unit || 'weeks';
      const msMap      = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const intervalMs = val * (msMap[unit] || msMap.weeks);
      const nextDue    = new Date(lastSync.synced_at).getTime() + intervalMs;
      // Cap so we never exceed 32-bit int; fire early if still waiting, check again then
      delay = Math.min(MAX_TIMER_MS, Math.max(60000, nextDue - Date.now()));
    }

    ofacAutoSyncTimer = setTimeout(async () => {
      // Re-check whether the sync is actually due (handles the >24-day cap case)
      const ls = db.prepare("SELECT synced_at FROM sanctions_syncs WHERE source='OFAC-SDN'").get();
      const sv        = Math.max(1, parseInt(getSettings().api_ofac_interval_value) || 1);
      const su        = getSettings().api_ofac_interval_unit || 'weeks';
      const msMap     = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const due       = ls ? new Date(ls.synced_at).getTime() + sv * (msMap[su] || msMap.weeks) : 0;
      if (Date.now() < due) { scheduleNextOfacSync(); return; } // not due yet, reschedule

      console.log("⚓ Auto-syncing OFAC SDN…");
      try {
        const r = await syncOfacSdn();
        console.log(`  ✔ OFAC auto-sync complete: ${r.entries.toLocaleString()} entries`);
        scheduleNextOfacSync();
      } catch (e) {
        console.error("  ✗ OFAC auto-sync failed:", e.message);
        scheduleNextOfacSync(3_600_000); // retry in 1 hour, don't hammer on failure
      }
    }, delay);

    console.log(`  ⏱ OFAC auto-sync scheduled in ${Math.round(delay / 3600000 * 10) / 10}h`);
  } catch {}
}
try { scheduleNextOfacSync(); } catch {}

function screenShipmentById(shipmentId) {
  const s = db.prepare("SELECT * FROM shipments WHERE id=?").get(shipmentId);
  if (!s) return null;

  const hits = [];

  // Party name screening
  for (const [field, name] of [['Shipper', s.shipper_name], ['Consignee', s.consignee_name], ['Principal', s.principal_name]]) {
    if (!name || !name.trim()) continue;
    const match = sanctionsMap.get(normSanctionName(name));
    if (match) hits.push({ field, value: name, matchedEntry: match.entityName, program: match.program, source: match.source });
  }

  // Country embargo via UNLOCODE prefix (first 2 chars)
  for (const [field, code] of [['POL', s.pol], ['POD', s.pod]]) {
    const cc = (code || '').substring(0, 2).toUpperCase();
    if (cc && EMBARGOED_COUNTRIES.has(cc))
      hits.push({ field, value: code, matchedEntry: `Embargoed country (${cc})`, program: 'Country Embargo', source: 'OFAC' });
  }

  const prevRow = db.prepare("SELECT result FROM shipment_screenings WHERE shipment_id=?").get(shipmentId);
  const result  = hits.length > 0 ? 'HIT' : 'CLEAR';
  const id      = `SCR-${uid()}`;
  const now     = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO shipment_screenings (id, shipment_id, screened_at, result, hits) VALUES (?,?,?,?,?)`
  ).run(id, shipmentId, now, result, JSON.stringify(hits));

  if (result === 'HIT' && prevRow?.result !== 'HIT') {
    logEvent(shipmentId, 'COMPLIANCE_HIT', null, null, null, JSON.stringify({ hits }));
  }

  return { id, result, hits, screenedAt: now, overriddenAt: null, overrideReason: null };
}


// ─── FX Rate Cache (frankfurter.app, ECB rates, refreshed every 24 h) ─────────
let fxCache = { rates: {}, ts: 0 };
async function getFxRates() {
  const s        = getSettings();
  const val      = Math.max(1, parseInt(s.api_fx_interval_value) || 1);
  const unit     = s.api_fx_interval_unit || 'days';
  const msMap    = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
  const ttl      = val * (msMap[unit] || msMap.days);
  if (Date.now() - fxCache.ts < ttl && Object.keys(fxCache.rates).length) return fxCache.rates;
  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=USD");
    const d = await r.json();
    fxCache = { rates: d.rates || {}, ts: Date.now() };
  } catch (e) { console.warn("FX fetch failed:", e.message); }
  return fxCache.rates;
}
async function toUsd(amount, currency) {
  if (!currency || currency === "USD") return Math.round(amount * 100) / 100;
  const rates = await getFxRates();
  const rate = rates[currency];
  return rate ? Math.round((amount / rate) * 100) / 100 : Math.round(amount * 100) / 100;
}

// ─── Backfill port country_code from unlocode ─────────────────────────────────
// Derives country from first 2 chars of UN/LOCODE (e.g. NLRTM → NL).
// Safe to run on every startup — only touches rows where country_code is missing.
(function backfillPortCountryCodes() {
  const info = db.prepare(`
    UPDATE port_locations
    SET country_code = UPPER(SUBSTR(unlocode, 1, 2))
    WHERE country_code IS NULL OR country_code = ''
  `).run();
  if (info.changes > 0)
    console.log(`  ✔ Backfilled country_code on ${info.changes.toLocaleString()} port rows`);
})();

// ─── Column rename migrations ─────────────────────────────────────────────────

(function migrateContainersColumns() {
  const cols = db.prepare("PRAGMA table_info(containers)").all().map(c => c.name);
  if (cols.includes('number')) {
    db.exec('ALTER TABLE containers RENAME COLUMN number TO container_number');
    console.log('  ✔ containers.number renamed to container_number');
  }
  if (cols.includes('commodity') && !cols.includes('hs_code')) {
    db.exec('ALTER TABLE containers RENAME COLUMN commodity TO hs_code');
    console.log('  ✔ containers.commodity renamed to hs_code');
  }
})();

// ─── Startup cleanup ──────────────────────────────────────────────────────────

try { db.exec("UPDATE shipments SET vessel = '', vessel_imo = '' WHERE vessel_imo = ''"); } catch {}

// Seeds the default FCL milestone template if none exists.
(function seedDefaultMilestoneTemplate() {
  try {
    const existing = db.prepare("SELECT COUNT(*) as n FROM milestone_templates WHERE template_key='FCL' AND carrier_code=''").get();
    if (existing.n > 0) return;
    const now = new Date().toISOString();
    const defaults = [
      { key: 'booking_confirmed', label: 'Booking Confirmed', seq: 1 },
      { key: 'si_submitted',      label: 'SI Submitted',       seq: 2 },
      { key: 'cargo_gated_in',    label: 'Cargo Gated In',     seq: 3 },
      { key: 'vessel_departed',   label: 'Vessel Departed',    seq: 4 },
      { key: 'bl_issued',         label: 'B/L Issued',         seq: 5 },
      { key: 'vessel_arrived',    label: 'Vessel Arrived',     seq: 6 },
      { key: 'customs_cleared',   label: 'Customs Cleared',    seq: 7 },
      { key: 'cargo_released',    label: 'Cargo Released',     seq: 8 },
      { key: 'delivered',         label: 'Delivered',          seq: 9 },
    ];
    for (const d of defaults) {
      db.prepare("INSERT INTO milestone_templates (id,template_key,carrier_code,trade_lane,milestone_key,label,sequence_order,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(`MT-${uid()}`, 'FCL', '', '', d.key, d.label, d.seq, now);
    }
    console.log('  ✔ Seeded default FCL milestone template (9 steps)');
  } catch (e) { console.warn('  ⚠ Could not seed milestone template:', e.message); }
})();

// ─── Map functions ────────────────────────────────────────────────────────────

const mapShipment     = r => ({ id: r.id, pol: r.pol, polName: r.pol_name || '', pod: r.pod, podName: r.pod_name || '', carrierCode: r.carrier_code, contractType: r.contract_type, contractNotes: r.contract_notes || '', status: r.status, createdAt: r.created_at, etd: r.etd || '', eta: r.eta || '', bookingRef: r.booking_ref || '', blNumber: r.bl_number || '', vessel: r.vessel || '', voyage: r.voyage || '', incoterm: r.incoterm || '', vesselImo: r.vessel_imo || '', contractId: r.contract_id || '', contractRef: r.contract_ref || '', commodityCode: r.commodity_code || '', shipperId: r.shipper_id || '', shipperName: r.shipper_name || '', consigneeId: r.consignee_id || '', consigneeName: r.consignee_name || '', principalId: r.principal_id || '', principalName: r.principal_name || '', allocationId: r.allocation_id || '', spaceSkipReason: r.space_skip_reason || '', spaceOverageReason: r.space_overage_reason || '', spaceBadge: r.space_badge || '', marginBuyUsd: r.margin_buy_usd ?? null, marginSellUsd: r.margin_sell_usd ?? null, overdueCount: r.overdue_count ?? 0 });
const mapCostLine     = r => ({ id: r.id, shipmentId: r.shipment_id, type: r.type, chargeCode: r.charge_code, currency: r.currency, amount: r.amount, exchangeRate: r.exchange_rate, amountUsd: Math.round(r.amount * r.exchange_rate * 100) / 100, notes: r.notes || '', containerId: r.container_id || '', source: r.source || 'manual', modifiedAt: r.modified_at || null, createdAt: r.created_at });
const mapContainer    = r => ({ id: r.id, shipmentId: r.shipment_id, containerNumber: r.container_number || '', sealNumber: r.seal_number || '', size: r.size, type: r.type, hsCode: r.hs_code || '', cargoDescription: r.cargo_description || '', grossWeightKg: r.gross_weight_kg ?? null, volumeCbm: r.volume_cbm ?? null, isDg: r.is_dg === 1, dgClass: r.dg_class || '' });
const mapAllocation   = r => ({ id: r.id, carrierCode: r.carrier_code, allocatedTEU: r.allocated_teu, effectiveDate: r.effective_date || '', endDate: r.end_date || '', tradeLane: r.trade_lane || '', notes: r.notes || '', alertThreshold: r.alert_threshold ?? 80, pol: r.pol || '', pod: r.pod || '', originLane: r.origin_lane || '', destLane: r.dest_lane || '', coverageScope: r.coverage_scope || 'STRICT', contractId: r.contract_id || '', contractNumber: r.contract_number || '' });
const mapCarrier      = r => ({ code: r.code, name: r.name, shortName: r.short_name || '' });
const mapVessel       = r => ({ imo: r.imo, name: r.name, assetType: r.asset_type || '', flagIso2: r.flag_iso2 || '', flagName: r.flag_name || '', buildYear: r.build_year, grossTonnage: r.gross_tonnage });
const mapPortLocation = r => ({ unlocode: r.unlocode, name: r.name, latitude: r.latitude, longitude: r.longitude, countryCode: r.country_code, zoneCode: r.zone_code, lastSyncedAt: r.last_synced_at || null });
const mapLinkedPort   = r => ({ id: r.id, primaryUnlocode: r.primary_unlocode, primaryName: r.primary_name || '', linkedUnlocode: r.linked_unlocode, linkedName: r.linked_name || '', note: r.note || '' });
const mapTradeLane    = r => ({ code: r.code, name: r.name, description: r.description || '', countryCount: r.country_count ?? 0 });
const mapRegion       = r => ({ code: r.code, name: r.name, description: r.description || '' });
const mapCountry      = r => ({ iso2: r.iso2, name: r.name, unMember: r.un_member === 1, regionCode: r.region_code || '', portCount: r.port_count ?? 0 });
const INVERSE_LINK_LABEL = { "Blocks": "Is blocked by", "Duplicates": "Is duplicated by", "Implements": "Is implemented by", "Relates to": "Relates to" };
const inverseLinkLabel = t => INVERSE_LINK_LABEL[t] || t;
const mapTicketLink   = r => ({ id: r.id, fromId: r.from_id, toId: r.to_id, linkType: r.link_type, createdAt: r.created_at });
const mapTicket       = r => ({ id: r.id, title: r.title, section: r.section || '', description: r.description || '', priority: r.priority, status: r.status, position: r.position, createdAt: r.created_at, shipmentId: r.shipment_id || null, type: r.type || 'Task', version: r.version || '' });
const mapCustomer     = r => ({ id: r.id, companyName: r.company_name, address1: r.address1 || '', address2: r.address2 || '', city: r.city || '', state: r.state || '', postalCode: r.postal_code || '', countryIso2: r.country_iso2 || '', phone: r.phone || '', fax: r.fax || '', email: r.email || '', website: r.website || '', notes: r.notes || '', createdAt: r.created_at });
const mapCommodity    = r => ({ code: r.code, description: r.description, gradeCode: r.grade_code, gradeName: r.grade_name });
const mapSystemMessage = r => ({
  id: r.id, title: r.title, body: r.body,
  severity: r.severity, activeFrom: r.active_from, activeTo: r.active_to, createdAt: r.created_at,
});
const mapMilestone         = r => ({ id: r.id, shipmentId: r.shipment_id, milestoneKey: r.milestone_key, label: r.label, sequenceOrder: r.sequence_order, estimatedDate: r.estimated_date || '', completedAt: r.completed_at || '', completedBy: r.completed_by || '', note: r.note || '', createdAt: r.created_at });
const mapMilestoneTemplate = r => ({ id: r.id, templateKey: r.template_key, carrierCode: r.carrier_code || '', tradeLane: r.trade_lane || '', milestoneKey: r.milestone_key, label: r.label, sequenceOrder: r.sequence_order, createdAt: r.created_at });

const mapContract = r => ({
  id:              r.id,
  contractNumber:  r.contract_number,
  contractRef:     r.contract_ref     || '',
  carrierCode:     r.carrier_code,
  namedAccountId:  r.named_account_id,
  namedAccount:    r.named_account,
  movementType:    r.movement_type,
  containerTypes:  JSON.parse(r.container_types  || "[]"),
  dgAllowed:       !!r.dg_allowed,
  imdgClasses:     JSON.parse(r.imdg_classes      || "[]"),
  validFrom:       r.valid_from,
  validTo:         r.valid_to,
  currency:        r.currency,
  status:          r.status,
  notes:           r.notes,
  createdAt:       r.created_at,
});
const mapLeg = r => ({
  id:            r.id,
  contractId:    r.contract_id,
  legOrder:      r.leg_order,
  pol:           r.pol,
  polName:       r.pol_name,
  pod:           r.pod,
  podName:       r.pod_name,
  transitDays:      r.transit_days,
  vesselService:    r.vessel_service,
  polLinkedAllowed: r.pol_linked_allowed === 1,
  podLinkedAllowed: r.pod_linked_allowed === 1,
});
const mapRate = r => ({
  id:            r.id,
  contractId:    r.contract_id,
  serviceCode:   r.service_code,
  description:   r.description,
  amount:        r.amount,
  currency:      r.currency,
  amountUsd:     r.amount_usd,
  unit:          r.unit,
  containerType: r.container_type,
  sortOrder:     r.sort_order,
  notes:         r.notes,
});

// ─── Entity event logger (generic: allocations, contracts, carriers) ─────────
const logEntityEvent = (entityType, entityId, eventType, field = null, oldVal = null, newVal = null, meta = null) => {
  try {
    db.prepare(
      "INSERT INTO entity_events (id,entity_type,entity_id,event_type,field,old_value,new_value,meta,created_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(`EEV-${uid()}`, entityType, entityId, eventType,
      field   ?? null,
      oldVal  != null ? String(oldVal) : null,
      newVal  != null ? String(newVal) : null,
      meta    ?? null,
      new Date().toISOString());
  } catch(e) { console.warn('logEntityEvent failed:', e.message); }
};

// ─── Shipment event logger ────────────────────────────────────────────────────
const logEvent = (shipmentId, type, field, oldVal, newVal, meta = '') => {
  try {
    db.prepare(
      "INSERT INTO shipment_events (id,shipment_id,event_type,field,old_value,new_value,actor,occurred_at,meta) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(`EVT-${uid()}`, shipmentId, type,
      field   ?? null,
      oldVal  != null ? String(oldVal) : null,
      newVal  != null ? String(newVal) : null,
      'user', new Date().toISOString(), meta);
  } catch(e) { console.warn('logEvent failed:', e.message); }
};

// Fields to track on shipments (db column → human label)
const TRACKED_FIELDS = {
  pol:            'Port of Loading',
  pod:            'Port of Discharge',
  status:         'Status',
  etd:            'Estimated Departure',
  eta:            'Estimated Arrival',
  carrier_code:   'Carrier',
  vessel:         'Vessel',
  vessel_imo:     'Vessel IMO',
  voyage:         'Voyage',
  incoterm:       'Incoterm',
  commodity_code: 'Commodity',
  booking_ref:    'Booking Reference',
  bl_number:      'B/L Number',
  contract_type:  'Contract Type',
  contract_id:    'Contract ID',
  contract_ref:   'Contract Reference',
  allocation_id:  'Space Configuration',
};

const TRACKED_CTR_FIELDS = {
  container_number:  'Container Number',
  size:              'Size',
  type:              'Equipment Type',
  hs_code:           'HS Code',
  cargo_description: 'Cargo Description',
  gross_weight_kg:   'Gross Weight (kg)',
  volume_cbm:        'Volume (CBM)',
  is_dg:             'Dangerous Goods',
  dg_class:          'DG Class',
};

// ─── Allocation conflict helpers ──────────────────────────────────────────────

const checkOverlap = (carrierCode, effectiveDate, endDate, pol = '', pod = '', excludeId = null) => {
  const rows = db.prepare(`
    SELECT id FROM allocations
    WHERE carrier_code = ? AND pol = ? AND pod = ?
      AND effective_date <= ? AND end_date >= ?
      ${excludeId ? "AND id != ?" : ""}
  `).all(...[carrierCode, pol.toUpperCase(), pod.toUpperCase(), endDate, effectiveDate, ...(excludeId ? [excludeId] : [])]);
  return rows.length > 0;
};


// ─── Auth middleware ──────────────────────────────────────────────────────────

const auth = (roles = []) => (req, res, next) => {
  const header = req.headers["authorization"];
  if (!header?.startsWith("Bearer ")) return err(res, "Unauthorized", 401);
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    if (roles.length && !roles.includes(payload.role))
      return err(res, "Forbidden", 403);
    req.user = payload;
    next();
  } catch { err(res, "Invalid or expired token", 401); }
};

// Role check only (token already verified by global middleware)
const requireRole = (roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : err(res, "Forbidden", 403);

// Require valid token on all /api/* except /api/auth/*
app.use("/api", (req, res, next) =>
  req.path.startsWith("/auth/") ? next() : auth()(req, res, next)
);

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return err(res, "Email and password required");
  const user = db.prepare(
    "SELECT * FROM users WHERE email = ? AND is_active = 1"
  ).get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return err(res, "Invalid email or password", 401);
  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET, { expiresIn: "8h" }
  );
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
  ok(res, { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.get("/api/auth/me", auth(), (req, res) => {
  const user = db.prepare(
    "SELECT id, email, name, role, is_active, created_at, last_login FROM users WHERE id = ?"
  ).get(req.user.id);
  if (!user || !user.is_active) return err(res, "User not found or inactive", 404);
  ok(res, user);
});

app.post("/api/auth/logout", (req, res) => ok(res, { ok: true }));

// ─── Users ────────────────────────────────────────────────────────────────────

app.get("/api/users", requireRole(["admin"]), (req, res) => {
  const rows = db.prepare(
    "SELECT id, email, name, role, is_active, created_at, last_login FROM users ORDER BY created_at"
  ).all();
  ok(res, rows);
});

app.post("/api/users", requireRole(["admin"]), (req, res) => {
  const { email, name, role = "viewer", password } = req.body || {};
  if (!email || !name || !password) return err(res, "email, name, and password are required");
  if (!["admin", "operator", "viewer"].includes(role)) return err(res, "Invalid role");
  try {
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'))"
    ).run(`USR-${uid()}`, email.toLowerCase().trim(), name, bcrypt.hashSync(password, 10), role);
    ok(res, { ok: true }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return err(res, "Email already in use");
    throw e;
  }
});

app.patch("/api/users/:id", requireRole(["admin"]), (req, res) => {
  const { name, role, is_active, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return err(res, "User not found", 404);
  if (req.params.id === req.user.id && is_active === 0)
    return err(res, "Cannot deactivate your own account");
  const sets = [], vals = [];
  if (name      !== undefined) { sets.push("name = ?");          vals.push(name); }
  if (role      !== undefined) {
    if (!["admin","operator","viewer"].includes(role)) return err(res, "Invalid role");
    sets.push("role = ?"); vals.push(role);
  }
  if (is_active !== undefined) { sets.push("is_active = ?");     vals.push(is_active ? 1 : 0); }
  if (password)                { sets.push("password_hash = ?"); vals.push(bcrypt.hashSync(password, 10)); }
  if (!sets.length) return err(res, "Nothing to update");
  vals.push(req.params.id);
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  ok(res, { ok: true });
});

app.delete("/api/users/:id", requireRole(["admin"]), (req, res) => {
  if (req.params.id === req.user.id) return err(res, "Cannot delete your own account");
  const r = db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  if (!r.changes) return err(res, "User not found", 404);
  ok(res, { ok: true });
});

// ─── Shipments ────────────────────────────────────────────────────────────────

app.get("/api/shipments", (req, res) => {
  const rows = db.prepare(`
    SELECT s.*,
           p1.name AS pol_name,
           p2.name AS pod_name,
           COALESCE(buy.total, 0)  AS margin_buy_usd,
           COALESCE(sell.total, 0) AS margin_sell_usd,
           COALESCE(ms.overdue_count, 0) AS overdue_count
    FROM shipments s
    LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
    LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
    LEFT JOIN (SELECT shipment_id, SUM(amount * exchange_rate) AS total
               FROM shipment_cost_lines WHERE type='BUY' GROUP BY shipment_id) buy
           ON buy.shipment_id = s.id
    LEFT JOIN (SELECT shipment_id, SUM(amount * exchange_rate) AS total
               FROM shipment_cost_lines WHERE type='SELL' GROUP BY shipment_id) sell
           ON sell.shipment_id = s.id
    LEFT JOIN (SELECT shipment_id, COUNT(*) AS overdue_count
               FROM shipment_milestones
               WHERE estimated_date != '' AND estimated_date < date('now') AND completed_at = ''
               GROUP BY shipment_id) ms
           ON ms.shipment_id = s.id
    ORDER BY s.created_at DESC
  `).all();
  ok(res, rows.map(mapShipment));
});

app.get("/api/shipments/compliance-hits", (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, p1.name AS pol_name, p2.name AS pod_name,
           ss.result AS scr_result, ss.hits AS scr_hits, ss.screened_at, ss.overridden_at
    FROM shipments s
    JOIN shipment_screenings ss ON ss.shipment_id = s.id
    LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
    LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
    WHERE ss.result = 'HIT'
    ORDER BY ss.screened_at DESC
  `).all();
  ok(res, rows.map(r => ({
    ...mapShipment(r),
    screening: {
      result: r.scr_result,
      hits: JSON.parse(r.scr_hits || '[]'),
      screenedAt: r.screened_at,
      overriddenAt: r.overridden_at || null,
    },
  })));
});

app.get("/api/shipments/:id", (req, res) => {
  const row = db.prepare(`
    SELECT s.*, p1.name AS pol_name, p2.name AS pod_name
    FROM shipments s
    LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
    LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
    WHERE s.id = ?
  `).get(req.params.id);
  if (!row) return err(res, "Not found", 404);
  ok(res, mapShipment(row));
});

// Full shipment event history
app.get("/api/shipments/:id/events", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM shipment_events WHERE shipment_id=? ORDER BY occurred_at ASC"
  ).all(req.params.id);
  ok(res, rows.map(r => ({
    id: r.id, shipmentId: r.shipment_id,
    eventType: r.event_type, field: r.field,
    oldValue: r.old_value, newValue: r.new_value,
    actor: r.actor, occurredAt: r.occurred_at,
    meta: r.meta ? JSON.parse(r.meta) : {},
  })));
});

// Shipment status audit log
app.get("/api/shipments/:id/status-log", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM status_log WHERE shipment_id=? ORDER BY changed_at ASC"
  ).all(req.params.id);
  ok(res, rows.map(r => ({
    id: r.id, shipmentId: r.shipment_id,
    fromStatus: r.from_status, toStatus: r.to_status,
    changedAt: r.changed_at, changedBy: r.changed_by,
  })));
});

app.post("/api/shipments", (req, res) => {
  const { pol, pod, carrierCode, contractType, contractNotes = "", status = "Active",
          etd = "", eta = "", bookingRef = "", blNumber = "", vessel = "", voyage = "",
          incoterm = "", vesselImo = "", contractId = "", contractRef = "", commodityCode = "",
          shipperId = "", shipperName = "", consigneeId = "", consigneeName = "",
          principalId = "", principalName = "",
          allocationId = "", spaceSkipReason = "", spaceOverageReason = "" } = req.body;
  if (!pol || !pod || !carrierCode || !contractType) return err(res, "pol, pod, carrierCode, contractType required");
  const id = `SHP-${uid()}`;
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO shipments (id,pol,pod,carrier_code,contract_type,contract_notes,status,created_at,etd,eta,booking_ref,bl_number,vessel,voyage,incoterm,vessel_imo,contract_id,contract_ref,commodity_code,shipper_id,shipper_name,consignee_id,consignee_name,principal_id,principal_name,allocation_id,space_skip_reason,space_overage_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, polU, podU, carrierCode, contractType, contractNotes, status, createdAt, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, contractId, contractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName, allocationId, spaceSkipReason, spaceOverageReason);
  logEvent(id, 'SHIPMENT_CREATED', null, null, null,
    JSON.stringify({ pol: polU, pod: podU, carrier: carrierCode, status, etd, contractType }));
  if (contractType === 'Central' && contractId) importContractRates(id);
  const silentScreening = sanctionsMap.size > 0 ? screenShipmentById(id) : null;
  const base = mapShipment({ id, pol: polU, pod: podU, carrier_code: carrierCode, contract_type: contractType, contract_notes: contractNotes, status, created_at: createdAt, etd, eta, booking_ref: bookingRef, bl_number: blNumber, vessel, voyage, incoterm, vessel_imo: vesselImo, contract_id: contractId, contract_ref: contractRef, commodity_code: commodityCode, shipper_id: shipperId, shipper_name: shipperName, consignee_id: consigneeId, consignee_name: consigneeName, principal_id: principalId, principal_name: principalName, allocation_id: allocationId, space_skip_reason: spaceSkipReason, space_overage_reason: spaceOverageReason });
  ok(res, silentScreening ? { ...base, screening: silentScreening } : base, 201);
});

app.put("/api/shipments/:id", (req, res) => {
  const { pol, pod, carrierCode, contractType, contractNotes = "", status,
          etd = "", eta = "", bookingRef = "", blNumber = "", vessel = "", voyage = "",
          incoterm = "", vesselImo = "", contractId = "", contractRef = "", commodityCode = "",
          shipperId = "", shipperName = "", consigneeId = "", consigneeName = "",
          principalId = "", principalName = "",
          allocationId = "", spaceSkipReason = "", spaceOverageReason = "" } = req.body;
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const existing = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const info = db.prepare(`
    UPDATE shipments SET pol=?, pod=?, carrier_code=?, contract_type=?, contract_notes=?, status=?,
    etd=?, eta=?, booking_ref=?, bl_number=?, vessel=?, voyage=?, incoterm=?, vessel_imo=?, contract_id=?, contract_ref=?, commodity_code=?,
    shipper_id=?, shipper_name=?, consignee_id=?, consignee_name=?, principal_id=?, principal_name=?,
    allocation_id=?, space_skip_reason=?, space_overage_reason=? WHERE id=?
  `).run(polU, podU, carrierCode, contractType, contractNotes, status, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, contractId, contractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName, allocationId, spaceSkipReason, spaceOverageReason, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  // Log all changed fields
  const newVals = { pol: polU, pod: podU, status, etd, eta, carrier_code: carrierCode,
    vessel, vessel_imo: vesselImo, voyage, incoterm, commodity_code: commodityCode,
    booking_ref: bookingRef, bl_number: blNumber, contract_type: contractType,
    contract_id: contractId, contract_ref: contractRef, allocation_id: allocationId };
  for (const [col] of Object.entries(TRACKED_FIELDS)) {
    const o = String(existing[col] || ''), n = String(newVals[col] || '');
    if (o !== n) {
      const type = col === 'status' ? 'STATUS_CHANGED' : 'FIELD_UPDATED';
      logEvent(req.params.id, type, col, o || null, n || null);
    }
  }
  // Auto-post structured events when skip/overage reasons are newly set
  if (!existing.space_skip_reason && spaceSkipReason) {
    logEvent(req.params.id, 'SPACE_SKIPPED', 'space_skip_reason', null, spaceSkipReason,
      JSON.stringify({ contractId, contractNumber: contractRef }));
  }
  if (!existing.space_overage_reason && spaceOverageReason) {
    logEvent(req.params.id, 'SPACE_OVERAGE', 'space_overage_reason', null, spaceOverageReason,
      JSON.stringify({ allocationId }));
  }
  if (existing.status !== status) {
    db.prepare("INSERT INTO status_log (id,shipment_id,from_status,to_status,changed_at,changed_by) VALUES (?,?,?,?,?,?)")
      .run(`SL-${uid()}`, req.params.id, existing.status, status, new Date().toISOString(), "user");
  }
  const updated = db.prepare(`
    SELECT s.*, p1.name AS pol_name, p2.name AS pod_name
    FROM shipments s
    LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
    LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
    WHERE s.id = ?
  `).get(req.params.id);
  // Silent re-screen: only when SDN list is loaded, not if a compliance officer overrode it,
  // and only when party names or route changed (don't wipe a clean result on an ETA-only edit).
  let silentScreening = null;
  if (sanctionsMap.size > 0) {
    const prev = db.prepare("SELECT result, overridden_at FROM shipment_screenings WHERE shipment_id=?").get(req.params.id);
    const isOverridden = prev?.result === 'CLEAR' && prev?.overridden_at;
    const partyOrRouteChanged = !prev
      || existing.shipper_name  !== shipperName
      || existing.consignee_name !== consigneeName
      || existing.principal_name !== principalName
      || existing.pol            !== polU
      || existing.pod            !== podU;
    if (!isOverridden && partyOrRouteChanged) silentScreening = screenShipmentById(req.params.id);
  }
  ok(res, silentScreening ? { ...mapShipment(updated), screening: silentScreening } : mapShipment(updated));
});

app.delete("/api/shipments/:id", (req, res) => {
  const info = db.prepare("DELETE FROM shipments WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

// ─── Containers ───────────────────────────────────────────────────────────────

app.get("/api/containers", (req, res) => {
  const rows = req.query.shipmentId
    ? db.prepare("SELECT * FROM containers WHERE shipment_id=?").all(req.query.shipmentId)
    : db.prepare("SELECT * FROM containers").all();
  ok(res, rows.map(mapContainer));
});

// Returns an error string if the DG class violates the shipment's contract policy, else null.
const checkDgPolicy = (shipmentId, isDg, dgClass) => {
  if (!isDg || !dgClass) return null;
  const shipment = db.prepare("SELECT contract_id, contract_ref FROM shipments WHERE id=?").get(shipmentId);
  if (!shipment?.contract_id) return null;
  const contract = db.prepare("SELECT dg_allowed, imdg_classes, contract_number FROM contracts WHERE id=?").get(shipment.contract_id);
  if (!contract) return null;
  if (!contract.dg_allowed)
    return `Contract ${contract.contract_number} does not permit DG cargo`;
  const allowed = JSON.parse(contract.imdg_classes || "[]");
  if (allowed.length > 0 && !allowed.includes(dgClass))
    return `IMO class ${dgClass} is not permitted under contract ${contract.contract_number} (allowed: ${allowed.join(", ")})`;
  return null;
};

app.post("/api/containers", (req, res) => {
  const { shipmentId, containerNumber = "", sealNumber = "", size, type,
          hsCode = "", cargoDescription = "", grossWeightKg = null, volumeCbm = null, isDg = false, dgClass = "" } = req.body;
  if (!shipmentId || !size || !type) return err(res, "shipmentId, size, type required");
  const dgErr = checkDgPolicy(shipmentId, isDg, dgClass);
  if (dgErr) return err(res, dgErr, 422);
  const id  = `CTR-${uid()}`;
  const cnU = containerNumber.toUpperCase();
  db.prepare("INSERT INTO containers (id,shipment_id,container_number,seal_number,size,type,hs_code,cargo_description,gross_weight_kg,volume_cbm,is_dg,dg_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, shipmentId, cnU, sealNumber, size, type, hsCode, cargoDescription, grossWeightKg, volumeCbm, isDg ? 1 : 0, dgClass);
  const addedCtr = mapContainer({ id, shipment_id: shipmentId, container_number: cnU, seal_number: sealNumber, size, type, hs_code: hsCode, cargo_description: cargoDescription, gross_weight_kg: grossWeightKg, volume_cbm: volumeCbm, is_dg: isDg ? 1 : 0, dg_class: dgClass });
  logEvent(shipmentId, 'CONTAINER_ADDED', null, null, cnU,
    JSON.stringify({ size, type, hsCode, cargoDescription }));
  recomputeSpaceBadge(shipmentId);
  ok(res, addedCtr, 201);
});

app.put("/api/containers/:id", (req, res) => {
  const { containerNumber = "", sealNumber = "", size, type,
          hsCode = "", cargoDescription = "", grossWeightKg = null, volumeCbm = null, isDg = false, dgClass = "" } = req.body;
  const cnU    = containerNumber.toUpperCase();
  const oldCtr = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
  if (!oldCtr) return err(res, "Not found", 404);
  const dgErr = checkDgPolicy(oldCtr.shipment_id, isDg, dgClass);
  if (dgErr) return err(res, dgErr, 422);
  const info = db.prepare("UPDATE containers SET container_number=?, seal_number=?, size=?, type=?, hs_code=?, cargo_description=?, gross_weight_kg=?, volume_cbm=?, is_dg=?, dg_class=? WHERE id=?")
    .run(cnU, sealNumber, size, type, hsCode, cargoDescription, grossWeightKg, volumeCbm, isDg ? 1 : 0, dgClass, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  const newVals = { container_number: cnU, size, type, hs_code: hsCode,
    cargo_description: cargoDescription, gross_weight_kg: grossWeightKg,
    volume_cbm: volumeCbm, is_dg: isDg ? 1 : 0, dg_class: dgClass };
  const meta = JSON.stringify({ containerNumber: cnU });
  for (const [col] of Object.entries(TRACKED_CTR_FIELDS)) {
    const o = String(oldCtr[col] ?? ''), n = String(newVals[col] ?? '');
    if (o !== n && !(o === '' && n === '')) {
      logEvent(oldCtr.shipment_id, 'CONTAINER_UPDATED', col, o, n, meta);
    }
  }
  const row = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
  recomputeSpaceBadge(oldCtr.shipment_id);
  ok(res, mapContainer(row));
});

app.delete("/api/containers/:id", (req, res) => {
  const ctr = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
  if (!ctr) return err(res, "Not found", 404);
  db.prepare("DELETE FROM containers WHERE id=?").run(req.params.id);
  logEvent(ctr.shipment_id, 'CONTAINER_REMOVED', null, ctr.container_number, null,
    JSON.stringify({ size: ctr.size, type: ctr.type }));
  recomputeSpaceBadge(ctr.shipment_id);
  ok(res, { deleted: req.params.id });
});

// ─── Allocations ──────────────────────────────────────────────────────────────

app.get("/api/allocations", (req, res) => {
  ok(res, db.prepare("SELECT * FROM allocations ORDER BY effective_date DESC").all().map(mapAllocation));
});

app.post("/api/allocations", (req, res) => {
  const { carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane = '', notes = '',
          alertThreshold = 80, pol = '', pod = '', originLane = '', destLane = '', coverageScope = 'STRICT',
          contractId = '', contractNumber = '' } = req.body;
  if (!carrierCode || allocatedTEU == null || !effectiveDate || !endDate || !pol || !pod)
    return err(res, "carrierCode, allocatedTEU, effectiveDate, endDate, pol, pod all required");
  if (!contractId) return err(res, "contractId required");
  if (endDate < effectiveDate) return err(res, "end date must be on or after effective date");
  if (checkOverlap(carrierCode, effectiveDate, endDate, pol, pod))
    return err(res, `An allocation for ${carrierCode} on route ${pol.toUpperCase()} → ${pod.toUpperCase()} already covers that date range`);
  const id = `ALC-${uid()}`;
  db.prepare("INSERT INTO allocations (id,carrier_code,allocated_teu,effective_date,end_date,trade_lane,notes,alert_threshold,pol,pod,origin_lane,dest_lane,coverage_scope,contract_id,contract_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane, notes, alertThreshold, pol.toUpperCase(), pod.toUpperCase(), originLane, destLane, coverageScope, contractId, contractNumber);
  logEntityEvent('allocation', id, 'CREATED', null, null, null,
    JSON.stringify({ carrierCode, pol: pol.toUpperCase(), pod: pod.toUpperCase(), allocatedTEU, effectiveDate, endDate, contractNumber }));
  ok(res, mapAllocation({ id, carrier_code: carrierCode, allocated_teu: allocatedTEU, effective_date: effectiveDate, end_date: endDate, trade_lane: tradeLane, notes, alert_threshold: alertThreshold, pol: pol.toUpperCase(), pod: pod.toUpperCase(), origin_lane: originLane, dest_lane: destLane, coverage_scope: coverageScope, contract_id: contractId, contract_number: contractNumber }), 201);
});

app.put("/api/allocations/:id", (req, res) => {
  const { carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane = '', notes = '',
          alertThreshold = 80, pol = '', pod = '', originLane = '', destLane = '',
          contractId = '', contractNumber = '' } = req.body;
  if (!effectiveDate || !endDate || !pol || !pod) return err(res, "effectiveDate, endDate, pol, pod required");
  if (!contractId) return err(res, "contractId required");
  if (endDate < effectiveDate) return err(res, "end date must be on or after effective date");
  if (checkOverlap(carrierCode, effectiveDate, endDate, pol, pod, req.params.id))
    return err(res, `Another allocation for ${carrierCode} on route ${pol.toUpperCase()} → ${pod.toUpperCase()} already covers that date range`);
  const info = db.prepare("UPDATE allocations SET carrier_code=?, allocated_teu=?, effective_date=?, end_date=?, trade_lane=?, notes=?, alert_threshold=?, pol=?, pod=?, origin_lane=?, dest_lane=?, contract_id=?, contract_number=? WHERE id=?")
    .run(carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane, notes, alertThreshold, pol.toUpperCase(), pod.toUpperCase(), originLane, destLane, contractId, contractNumber, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  logEntityEvent('allocation', req.params.id, 'UPDATED', null, null, null,
    JSON.stringify({ carrierCode, pol: pol.toUpperCase(), pod: pod.toUpperCase(), allocatedTEU, effectiveDate, endDate, contractNumber }));
  ok(res, mapAllocation({ id: req.params.id, carrier_code: carrierCode, allocated_teu: allocatedTEU, effective_date: effectiveDate, end_date: endDate, trade_lane: tradeLane, notes, alert_threshold: alertThreshold, pol: pol.toUpperCase(), pod: pod.toUpperCase(), origin_lane: originLane, dest_lane: destLane, contract_id: contractId, contract_number: contractNumber }));
});

app.delete("/api/allocations/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM allocations WHERE id=?").get(req.params.id);
  const info = db.prepare("DELETE FROM allocations WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  if (existing) logEntityEvent('allocation', req.params.id, 'DELETED', null, null, null,
    JSON.stringify({ carrierCode: existing.carrier_code, pol: existing.pol, pod: existing.pod }));
  ok(res, { deleted: req.params.id });
});

// Shipment contract picker: find allocations matching the route + ETD date
// Placed before /conflicts so the static segment doesn't shadow a future param route
app.get("/api/allocations/match", (req, res) => {
  const { pol = "", pod = "", etd = "" } = req.query;
  if (!pol || !pod || !etd) return ok(res, []);

  const polU = pol.toUpperCase();
  const podU = pod.toUpperCase();

  const linkedTo = code => db.prepare(`
    SELECT CASE WHEN primary_unlocode=? THEN linked_unlocode ELSE primary_unlocode END AS code
    FROM linked_ports WHERE primary_unlocode=? OR linked_unlocode=?
  `).all(code, code, code).map(r => r.code);

  const polAll = [polU, ...linkedTo(polU)];
  const podAll = [podU, ...linkedTo(podU)];
  const ph = arr => arr.map(() => "?").join(",");

  const allocs = db.prepare(`
    SELECT * FROM allocations
    WHERE pol IN (${ph(polAll)}) AND pod IN (${ph(podAll)})
    AND effective_date <= ? AND end_date >= ?
    ORDER BY effective_date DESC
  `).all(...polAll, ...podAll, etd, etd);

  const results = allocs.map(a => {
    const { consumed_teu } = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN c.size=20 THEN 1 WHEN c.size IN (40,45) THEN 2 ELSE 0 END), 0) AS consumed_teu
      FROM containers c
      JOIN shipments s ON s.id = c.shipment_id
      WHERE s.allocation_id = ?
    `).get(a.id);
    const base       = mapAllocation(a);
    const matchKind  = (a.pol === polU && a.pod === podU) ? "exact" : "linked";
    const linkedPolVia = a.pol !== polU ? a.pol : null;
    const linkedPodVia = a.pod !== podU ? a.pod : null;
    return { ...base, consumedTEU: consumed_teu, remainingTEU: Math.max(0, base.allocatedTEU - consumed_teu), matchKind, linkedPolVia, linkedPodVia };
  });

  ok(res, results);
});

// Port links for conflict detection
app.get("/api/allocations/conflicts", (req, res) => {
  const { carrierCode, pol, pod, effectiveDate, endDate, excludeId = '' } = req.query;
  if (!carrierCode || !pol || !pod || !effectiveDate || !endDate) return ok(res, { exact: [], linked: [] });
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const isLinked = (a, b) => !!db.prepare("SELECT 1 FROM linked_ports WHERE (primary_unlocode=? AND linked_unlocode=?) OR (linked_unlocode=? AND primary_unlocode=?)").get(a, b, a, b);
  const exact = db.prepare("SELECT * FROM allocations WHERE carrier_code=? AND pol=? AND pod=? AND effective_date<=? AND end_date>=? AND id!=?")
    .all(carrierCode, polU, podU, endDate, effectiveDate, excludeId).map(r => {
      const carrier = db.prepare("SELECT name FROM carriers WHERE code=?").get(r.carrier_code);
      return { ...mapAllocation(r), carrierName: carrier?.name || '', conflictKind: 'exact', links: [] };
    });
  const exactIds = exact.map(e => e.id);
  const linkedCodes = db.prepare("SELECT primary_unlocode AS code FROM linked_ports WHERE linked_unlocode IN (?,?) UNION SELECT linked_unlocode AS code FROM linked_ports WHERE primary_unlocode IN (?,?)")
    .all(polU, podU, polU, podU).map(r => r.code).filter(c => c !== polU && c !== podU);
  let linked = [];
  if (linkedCodes.length > 0) {
    const ph = linkedCodes.map(() => '?').join(',');
    const excl = exactIds.length ? `AND id NOT IN (${exactIds.map(() => '?').join(',')})` : '';
    linked = db.prepare(`SELECT * FROM allocations WHERE carrier_code=? AND (pol IN (${ph}) OR pod IN (${ph})) AND effective_date<=? AND end_date>=? AND id!=? ${excl}`)
      .all(carrierCode, ...linkedCodes, ...linkedCodes, endDate, effectiveDate, excludeId, ...exactIds).map(r => {
        const a = mapAllocation(r);
        const carrier = db.prepare("SELECT name FROM carriers WHERE code=?").get(r.carrier_code);
        const links = [];
        for (const [np, nl] of [[polU,'POL'],[podU,'POD']]) for (const [tp, tl] of [[a.pol,'POL'],[a.pod,'POD']]) if (tp && isLinked(np, tp)) links.push({ newPort: np, newLabel: nl, theirPort: tp, theirLabel: tl });
        return { ...a, carrierName: carrier?.name || '', conflictKind: 'linked', links };
      });
  }
  ok(res, { exact, linked });
});

// ─── Carriers ─────────────────────────────────────────────────────────────────

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

// ─── Vessels ──────────────────────────────────────────────────────────────────

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
  const rows = db.prepare("SELECT * FROM vessels WHERE name LIKE ? OR imo LIKE ? LIMIT 12").all(`%${q}%`, `%${q}%`);
  ok(res, rows.map(mapVessel));
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

// ─── Port Locations ───────────────────────────────────────────────────────────

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

// ─── Linked Ports ─────────────────────────────────────────────────────────────

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

// ─── Trade Lanes ──────────────────────────────────────────────────────────────

app.get("/api/trade-lanes", (req, res) => ok(res, db.prepare(`
  SELECT tl.*, COUNT(ctl.iso2) AS country_count
  FROM trade_lanes tl
  LEFT JOIN country_trade_lanes ctl ON ctl.lane_code = tl.code
  GROUP BY tl.code
  ORDER BY tl.code
`).all().map(mapTradeLane)));

// Countries assigned to a trade lane
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

// Bulk replace countries for a trade lane
app.put("/api/trade-lanes/:code/countries", (req, res) => {
  const code  = req.params.code.toUpperCase();
  const iso2s = Array.isArray(req.body.iso2s) ? req.body.iso2s : [];
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM country_trade_lanes WHERE lane_code = ?").run(code);
    const ins = db.prepare("INSERT OR IGNORE INTO country_trade_lanes (iso2, lane_code) VALUES (?, ?)");
    for (const iso2 of iso2s) ins.run(iso2.toUpperCase(), code);
    db.exec("COMMIT");
    ok(res, { code, iso2s });
  } catch(e) { db.exec("ROLLBACK"); err(res, e.message); }
});
app.post("/api/trade-lanes", (req, res) => {
  const { code, name, description='' } = req.body;
  if (!code || !name) return err(res, "code and name required");
  try { db.prepare("INSERT INTO trade_lanes (code,name,description) VALUES (?,?,?)").run(code.toUpperCase().trim(), name.trim(), description.trim()); ok(res, { code: code.toUpperCase().trim(), name: name.trim(), description: description.trim() }, 201); }
  catch(e) { err(res, isUniqueViolation(e) ? `Lane ${code} already exists` : e.message); }
});
app.put("/api/trade-lanes/:code", (req, res) => {
  const { name, description='' } = req.body;
  const info = db.prepare("UPDATE trade_lanes SET name=?, description=? WHERE code=?").run(name, description, req.params.code);
  if (info.changes===0) return err(res,"Not found",404);
  ok(res, { code: req.params.code, name, description });
});
app.delete("/api/trade-lanes/:code", (req, res) => { const info = db.prepare("DELETE FROM trade_lanes WHERE code=?").run(req.params.code); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.code}); });

app.get("/api/country-trade-lanes", (req, res) => ok(res, db.prepare("SELECT * FROM country_trade_lanes").all()));
app.post("/api/country-trade-lanes", (req, res) => {
  const { iso2, laneCode } = req.body;
  if (!iso2 || !laneCode) return err(res, "iso2 and laneCode required");
  try { db.prepare("INSERT INTO country_trade_lanes (iso2,lane_code) VALUES (?,?)").run(iso2.toUpperCase(), laneCode.toUpperCase()); ok(res, { iso2: iso2.toUpperCase(), laneCode: laneCode.toUpperCase() }, 201); }
  catch(e) { err(res, isUniqueViolation(e) ? "Assignment already exists" : e.message); }
});
// Bulk replace all trade-lane assignments for a country
app.put("/api/countries/:iso2/trade-lanes", (req, res) => {
  const iso2  = req.params.iso2.toUpperCase();
  const lanes = Array.isArray(req.body.lanes) ? req.body.lanes : [];
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM country_trade_lanes WHERE iso2 = ?").run(iso2);
    const ins = db.prepare("INSERT OR IGNORE INTO country_trade_lanes (iso2, lane_code) VALUES (?, ?)");
    for (const lane of lanes) ins.run(iso2, lane.toUpperCase());
    db.exec("COMMIT");
    ok(res, { iso2, lanes });
  } catch(e) { db.exec("ROLLBACK"); err(res, e.message); }
});

app.delete("/api/country-trade-lanes/:iso2/:laneCode", (req, res) => { db.prepare("DELETE FROM country_trade_lanes WHERE iso2=? AND lane_code=?").run(req.params.iso2, req.params.laneCode); ok(res, { deleted: true }); });

// ─── Regions ──────────────────────────────────────────────────────────────────

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

// ─── Countries ────────────────────────────────────────────────────────────────

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
  const where  = search
    ? "WHERE country_code=? AND (unlocode LIKE ? OR name LIKE ?)"
    : "WHERE country_code=?";
  const params = search ? [iso2, `%${search}%`, `%${search}%`] : [iso2];
  const total  = db.prepare(`SELECT COUNT(*) AS n FROM port_locations ${where}`).get(...params).n;
  const rows   = db.prepare(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
});

// ─── UN Location Codes (alias for port-locations with simpler search) ──────────

app.get("/api/unlocodes", (req, res) => {
  const { search='', limit='50', offset='0' } = req.query;
  const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
  const where = search.trim() ? "WHERE unlocode LIKE ? OR name LIKE ?" : "";
  const params = search.trim() ? [`%${search.trim().toUpperCase()}%`, `%${search.trim()}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM port_locations ${where}`).get(...params).n;
  const rows  = db.prepare(`SELECT * FROM port_locations ${where} ORDER BY unlocode LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows.map(mapPortLocation), total, limit: lim, offset: off });
});

// ─── Integration Kanban (Tickets) ─────────────────────────────────────────────

app.get("/api/tickets", (req, res) => ok(res, db.prepare("SELECT * FROM tickets ORDER BY status, position, created_at").all().map(mapTicket)));
app.post("/api/tickets", (req, res) => {
  const { title, section='', description='', priority='Medium', status='Ready', shipmentId=null, type='Task', version='' } = req.body;
  if (!title) return err(res, "title required");
  const id = `TKT-${uid()}`;
  const pos = (db.prepare("SELECT MAX(position) AS m FROM tickets WHERE status=?").get(status)?.m ?? -1) + 1;
  const sid = shipmentId || null;
  db.prepare("INSERT INTO tickets (id,title,section,description,priority,status,position,created_at,shipment_id,type,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, title, section, description, priority, status, pos, new Date().toISOString(), sid, type, version);
  ok(res, mapTicket({ id, title, section, description, priority, status, position: pos, created_at: new Date().toISOString(), shipment_id: sid, type, version }), 201);
});
app.put("/api/tickets/:id", (req, res) => {
  const { title, section='', description='', priority='Medium', status='Ready', position=0, shipmentId=null, type='Task', version='' } = req.body;
  const sid = shipmentId || null;
  const info = db.prepare("UPDATE tickets SET title=?, section=?, description=?, priority=?, status=?, position=?, shipment_id=?, type=?, version=? WHERE id=?").run(title, section, description, priority, status, position, sid, type, version, req.params.id);
  if (info.changes===0) return err(res,"Not found",404);
  ok(res, mapTicket({ id: req.params.id, title, section, description, priority, status, position, created_at: '', shipment_id: sid, type, version }));
});
app.delete("/api/tickets/:id", (req, res) => { const info = db.prepare("DELETE FROM tickets WHERE id=?").run(req.params.id); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.id}); });

app.get("/api/tickets/:id/links", (req, res) => {
  const rows = db.prepare("SELECT * FROM ticket_links WHERE from_id=? OR to_id=?").all(req.params.id, req.params.id);
  const result = rows.map(l => {
    const isOut    = l.from_id === req.params.id;
    const otherId  = isOut ? l.to_id : l.from_id;
    const other    = db.prepare("SELECT id, title, status, type FROM tickets WHERE id=?").get(otherId);
    return { ...mapTicketLink(l), direction: isOut ? "out" : "in",
      displayType: isOut ? l.link_type : inverseLinkLabel(l.link_type),
      otherTicketId: otherId, otherTicket: other || { id: otherId, title: otherId, status: "", type: "" } };
  });
  ok(res, result);
});

app.post("/api/tickets/:id/links", (req, res) => {
  const { toId, linkType } = req.body || {};
  if (!toId || !linkType) return err(res, "toId and linkType required");
  if (!db.prepare("SELECT id FROM tickets WHERE id=?").get(toId)) return err(res, "Target ticket not found", 404);
  if (db.prepare("SELECT id FROM ticket_links WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)").get(req.params.id, toId, toId, req.params.id))
    return err(res, "Link already exists");
  const id = `LNK-${uid()}`;
  db.prepare("INSERT INTO ticket_links (id,from_id,to_id,link_type,created_at) VALUES (?,?,?,?,?)").run(id, req.params.id, toId, linkType, new Date().toISOString());
  ok(res, { id, fromId: req.params.id, toId, linkType }, 201);
});

app.delete("/api/ticket-links/:id", (req, res) => {
  const info = db.prepare("DELETE FROM ticket_links WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

// ─── Customers ────────────────────────────────────────────────────────────────

app.get("/api/customers", (req, res) => {
  const { search='', city='', country='', customerId='', limit='50', offset='0' } = req.query;
  const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
  const conditions = [], params = [];
  const s = search.trim();
  if (s) { conditions.push("(company_name LIKE ? OR email LIKE ? OR phone LIKE ? OR id LIKE ?)"); params.push(`%${s}%`, `%${s}%`, `%${s}%`, `%${s}%`); }
  const ci = city.trim();
  if (ci) { conditions.push("city LIKE ?"); params.push(`%${ci}%`); }
  const co = country.trim().toUpperCase();
  if (co) { conditions.push("country_iso2 = ?"); params.push(co); }
  const cid = customerId.trim();
  if (cid) { conditions.push("id LIKE ?"); params.push(`%${cid}%`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM customers ${where}`).get(...params).n;
  const rows  = db.prepare(`SELECT * FROM customers ${where} ORDER BY company_name LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows.map(mapCustomer), total, limit: lim, offset: off });
});

app.get("/api/customers/sanctions-check", (req, res) => {
  const s = getSettings();
  if (s.api_customers_enabled !== 'true' || s.api_ofac_enabled !== 'true') {
    return ok(res, { enabled: false, hits: [] });
  }
  if (sanctionsMap.size === 0) return ok(res, { enabled: true, hits: [] });
  const customers = db.prepare("SELECT * FROM customers ORDER BY company_name").all();
  const hits = [];
  for (const c of customers) {
    const match = sanctionsMap.get(normSanctionName(c.company_name || ''));
    if (match) hits.push({ customer: mapCustomer(c), matchedEntry: match.entityName, program: match.program, source: match.source });
  }
  ok(res, { enabled: true, hits });
});

app.get("/api/customers/:id", (req, res) => {
  const r = db.prepare("SELECT * FROM customers WHERE id=?").get(req.params.id);
  if (!r) return err(res, "Not found", 404);
  ok(res, mapCustomer(r));
});

app.post("/api/customers", (req, res) => {
  const { companyName, address1='', address2='', city='', state='', postalCode='',
          countryIso2='', phone='', fax='', email='', website='', notes='' } = req.body;
  if (!companyName?.trim()) return err(res, "companyName required");
  const id = `CUS-${uid()}`;
  const createdAt = new Date().toISOString();
  const ccU = countryIso2.toUpperCase().trim();
  db.prepare("INSERT INTO customers (id,company_name,address1,address2,city,state,postal_code,country_iso2,phone,fax,email,website,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, companyName.trim(), address1, address2, city, state, postalCode, ccU, phone, fax, email, website, notes, createdAt);
  ok(res, mapCustomer({ id, company_name: companyName.trim(), address1, address2, city, state, postal_code: postalCode, country_iso2: ccU, phone, fax, email, website, notes, created_at: createdAt }), 201);
});

app.put("/api/customers/:id", (req, res) => {
  const { companyName, address1='', address2='', city='', state='', postalCode='',
          countryIso2='', phone='', fax='', email='', website='', notes='' } = req.body;
  if (!companyName?.trim()) return err(res, "companyName required");
  const ccU = countryIso2.toUpperCase().trim();
  const info = db.prepare(`UPDATE customers SET company_name=?,address1=?,address2=?,city=?,state=?,
    postal_code=?,country_iso2=?,phone=?,fax=?,email=?,website=?,notes=? WHERE id=?`)
    .run(companyName.trim(), address1, address2, city, state, postalCode, ccU, phone, fax, email, website, notes, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, mapCustomer({ id: req.params.id, company_name: companyName.trim(), address1, address2, city, state, postal_code: postalCode, country_iso2: ccU, phone, fax, email, website, notes, created_at: '' }));
});

app.delete("/api/customers/:id", (req, res) => {
  const info = db.prepare("DELETE FROM customers WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

// ─── Commodities ──────────────────────────────────────────────────────────────

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

// ─── FX Rates proxy ───────────────────────────────────────────────────────────
app.get("/api/fx/rates", async (req, res) => {
  const rates = await getFxRates();
  ok(res, { base: "USD", rates, ts: fxCache.ts });
});

// ─── Contracts ────────────────────────────────────────────────────────────────

// Helper: save legs inside a sync block
function saveLegs(contractId, legs) {
  db.prepare("DELETE FROM contract_legs WHERE contract_id=?").run(contractId);
  legs.forEach((l, i) => {
    const legId = `CLEG-${uid()}`;
    db.prepare(`INSERT INTO contract_legs (id,contract_id,leg_order,pol,pol_name,pod,pod_name,transit_days,vessel_service,pol_linked_allowed,pod_linked_allowed)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(legId, contractId, i, l.pol||"", l.polName||"", l.pod||"", l.podName||"", l.transitDays||0, l.vesselService||"",
           l.polLinkedAllowed ? 1 : 0, l.podLinkedAllowed ? 1 : 0);
  });
}
async function saveRates(contractId, rates) {
  db.prepare("DELETE FROM contract_rates WHERE contract_id=?").run(contractId);
  for (let i = 0; i < rates.length; i++) {
    const r   = rates[i];
    const usd = await toUsd(r.amount || 0, r.currency || "USD");
    const rateId = `RATE-${uid()}`;
    db.prepare(`INSERT INTO contract_rates (id,contract_id,service_code,description,amount,currency,amount_usd,unit,container_type,sort_order,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(rateId, contractId, r.serviceCode||"", r.description||"", r.amount||0, r.currency||"USD", usd,
           r.unit||"per_container", r.containerType||"", i, r.notes||"");
  }
}

// Contract search for combobox (typeahead) — MUST be before /api/contracts/:id
app.get("/api/contracts/search", (req, res) => {
  const { q="", pol="", pod="", carrier="", asOf="" } = req.query;
  const clauses = [], params = [];
  if (q.trim()) { clauses.push(`(c.contract_number LIKE ? OR c.contract_ref LIKE ? OR c.carrier_code LIKE ? OR c.named_account LIKE ?)`); const s=`%${q.trim()}%`; params.push(s,s,s,s); }
  if (carrier.trim()) { clauses.push("c.carrier_code=?"); params.push(carrier.trim()); }
  if (asOf.trim()) { clauses.push("c.valid_from<=? AND c.valid_to>=?"); params.push(asOf, asOf); }
  clauses.push("c.status='Active'");
  const where = "WHERE " + clauses.join(" AND ");
  const rows = db.prepare(`SELECT c.* FROM contracts c ${where} ORDER BY c.contract_number LIMIT 10`).all(...params);
  ok(res, rows.map(mapContract));
});

// Contract route-match — MUST be before /api/contracts/:id
// Per-leg linked-port expansion: each leg's pol_linked_allowed / pod_linked_allowed
// controls whether the shipment can match via a linked port on that side.
app.get("/api/contracts/match", (req, res) => {
  const { pol = "", pod = "", etd = "", carrier = "" } = req.query;
  if (!pol || !pod || !etd) return ok(res, []);

  const polU = pol.toUpperCase();
  const podU = pod.toUpperCase();

  // Returns all ports bidirectionally linked to `code` (not including code itself)
  const linkedTo = code => db.prepare(`
    SELECT CASE WHEN primary_unlocode=? THEN linked_unlocode ELSE primary_unlocode END AS code
    FROM linked_ports WHERE primary_unlocode=? OR linked_unlocode=?
  `).all(code, code, code).map(r => r.code);

  // Candidate contracts: validity window + carrier
  const clauses = ["c.status='Active'", "c.valid_from<=? AND c.valid_to>=?"];
  const params  = [etd, etd];
  if (carrier.trim()) { clauses.push("c.carrier_code=?"); params.push(carrier.trim().toUpperCase()); }

  const candidates = db.prepare(
    `SELECT c.* FROM contracts c WHERE ${clauses.join(" AND ")} ORDER BY c.valid_from DESC LIMIT 50`
  ).all(...params);

  const results = [];
  for (const c of candidates) {
    const legs = db.prepare("SELECT * FROM contract_legs WHERE contract_id=? ORDER BY leg_order").all(c.id);

    for (const leg of legs) {
      // Build the set of ports this leg covers on each side
      const polSet = leg.pol_linked_allowed ? [leg.pol, ...linkedTo(leg.pol)] : [leg.pol];
      const podSet = leg.pod_linked_allowed ? [leg.pod, ...linkedTo(leg.pod)] : [leg.pod];

      if (polSet.includes(polU) && podSet.includes(podU)) {
        const matchKind    = (leg.pol === polU && leg.pod === podU) ? "exact" : "linked";
        const linkedPolVia = leg.pol !== polU ? leg.pol : null;
        const linkedPodVia = leg.pod !== podU ? leg.pod : null;
        results.push({ ...mapContract(c), legs: legs.map(mapLeg), matchKind, linkedPolVia, linkedPodVia });
        break; // first matching leg wins — don't add the same contract twice
      }
    }
  }

  // Batch-fetch rates for all matched contracts (no N+1)
  if (results.length > 0) {
    const ids = results.map(r => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const allRates = db.prepare(
      `SELECT * FROM contract_rates WHERE contract_id IN (${placeholders}) ORDER BY sort_order`
    ).all(...ids);
    const ratesById = {};
    for (const r of allRates) {
      (ratesById[r.contract_id] = ratesById[r.contract_id] || []).push(mapRate(r));
    }
    for (const c of results) c.rates = ratesById[c.id] || [];
  }

  ok(res, results);
});

app.get("/api/contracts", (req, res) => {
  const { search="", carrier="", status="", dg="", asOf="", containerType="",
          limit="50", offset="0" } = req.query;
  const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
  const clauses = [], params = [];
  if (carrier.trim()) { clauses.push("c.carrier_code LIKE ?"); params.push(`%${carrier.trim()}%`); }
  if (status.trim())  { clauses.push("c.status=?");            params.push(status.trim()); }
  if (dg !== "")      { clauses.push("c.dg_allowed=?");         params.push(dg === "1" ? 1 : 0); }
  if (asOf.trim())    { clauses.push("c.valid_from<=? AND c.valid_to>=?"); params.push(asOf, asOf); }
  if (containerType.trim()) { clauses.push(`c.container_types LIKE ?`); params.push(`%"${containerType.trim()}"%`); }
  if (search.trim()) {
    clauses.push(`(c.contract_number LIKE ? OR c.contract_ref LIKE ? OR c.named_account LIKE ? OR c.carrier_code LIKE ? OR EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND (l.pol LIKE ? OR l.pod LIKE ? OR l.pol_name LIKE ? OR l.pod_name LIKE ?)))`);
    const s = `%${search.trim()}%`;
    params.push(s, s, s, s, s, s, s, s);
  }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM contracts c ${where}`).get(...params).n;
  const rows  = db.prepare(`SELECT c.* FROM contracts c ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
  // Attach legs in one IN query rather than N+1 queries
  const ids = rows.map(r => r.id);
  let legsMap = {};
  if (ids.length > 0) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT * FROM contract_legs WHERE contract_id IN (${ph}) ORDER BY leg_order`).all(...ids)
      .forEach(l => { (legsMap[l.contract_id] = legsMap[l.contract_id] || []).push(mapLeg(l)); });
  }
  ok(res, { results: rows.map(r => ({ ...mapContract(r), legs: legsMap[r.id] || [] })), total, limit: lim, offset: off });
});

app.get("/api/contracts/:id", (req, res) => {
  const c = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
  if (!c) return err(res, "Not found", 404);
  const legs  = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(req.params.id);
  const rates = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
  ok(res, { ...mapContract(c), legs: legs.map(mapLeg), rates: rates.map(mapRate) });
});

app.post("/api/contracts", async (req, res) => {
  const { contractNumber="", contractRef="", carrierCode="", namedAccountId="", namedAccount="",
          movementType="FCL", containerTypes=[], dgAllowed=false, imdgClasses=[],
          validFrom="", validTo="", currency="USD", status="Active", notes="",
          legs=[], rates=[] } = req.body;
  const dup = db.prepare("SELECT id FROM contracts WHERE contract_number=? AND contract_ref=? AND named_account_id=?").get(contractNumber, contractRef, namedAccountId);
  if (dup) return err(res, `A contract with this number${contractRef ? ", reference" : ""}${namedAccountId ? ", and account" : ""} already exists (${dup.id})`);
  const id = `CNTR-${uid()}`;
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO contracts (id,contract_number,contract_ref,carrier_code,named_account_id,named_account,movement_type,container_types,dg_allowed,imdg_classes,valid_from,valid_to,currency,status,notes,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType,
         JSON.stringify(containerTypes), dgAllowed ? 1 : 0, JSON.stringify(imdgClasses),
         validFrom, validTo, currency, status, notes, createdAt);
  saveLegs(id, legs);
  await saveRates(id, rates);
  const c    = db.prepare("SELECT * FROM contracts WHERE id=?").get(id);
  const lgs  = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(id);
  const rts  = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(id);
  logEntityEvent('contract', id, 'CREATED', null, null, null,
    JSON.stringify({ contractNumber, contractRef, carrierCode, validFrom, validTo, status }));
  ok(res, { ...mapContract(c), legs: lgs.map(mapLeg), rates: rts.map(mapRate) }, 201);
});

app.put("/api/contracts/:id", async (req, res) => {
  const { contractNumber="", contractRef="", carrierCode="", namedAccountId="", namedAccount="",
          movementType="FCL", containerTypes=[], dgAllowed=false, imdgClasses=[],
          validFrom="", validTo="", currency="USD", status="Active", notes="",
          legs=[], rates=[] } = req.body;
  const dup = db.prepare("SELECT id FROM contracts WHERE contract_number=? AND contract_ref=? AND named_account_id=? AND id!=?").get(contractNumber, contractRef, namedAccountId, req.params.id);
  if (dup) return err(res, `A contract with this number${contractRef ? ", reference" : ""}${namedAccountId ? ", and account" : ""} already exists (${dup.id})`);
  const info = db.prepare(`UPDATE contracts SET contract_number=?,contract_ref=?,carrier_code=?,named_account_id=?,named_account=?,
    movement_type=?,container_types=?,dg_allowed=?,imdg_classes=?,valid_from=?,valid_to=?,currency=?,status=?,notes=?
    WHERE id=?`)
    .run(contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType,
         JSON.stringify(containerTypes), dgAllowed ? 1 : 0, JSON.stringify(imdgClasses),
         validFrom, validTo, currency, status, notes, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  saveLegs(req.params.id, legs);
  await saveRates(req.params.id, rates);
  const c   = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
  const lgs = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(req.params.id);
  const rts = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
  logEntityEvent('contract', req.params.id, 'UPDATED', null, null, null,
    JSON.stringify({ contractNumber, contractRef, carrierCode, validFrom, validTo, status }));
  ok(res, { ...mapContract(c), legs: lgs.map(mapLeg), rates: rts.map(mapRate) });
});

app.delete("/api/contracts/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
  const info = db.prepare("DELETE FROM contracts WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  if (existing) logEntityEvent('contract', req.params.id, 'DELETED', null, null, null,
    JSON.stringify({ contractNumber: existing.contract_number, carrierCode: existing.carrier_code }));
  ok(res, { deleted: req.params.id });
});

// ─── Entity Events ────────────────────────────────────────────────────────────

app.get("/api/entity-events/:type/:id", (req, res) => {
  // Shipments have their own event table — bridge through it
  if (req.params.type === 'shipment') {
    const rows = db.prepare(
      "SELECT * FROM shipment_events WHERE shipment_id=? ORDER BY occurred_at DESC"
    ).all(req.params.id);
    return ok(res, rows.map(r => ({
      id: r.id, entityType: 'shipment', entityId: r.shipment_id,
      eventType: r.event_type, field: r.field,
      oldValue: r.old_value, newValue: r.new_value,
      meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return r.meta; } })() : null,
      createdAt: r.occurred_at,
    })));
  }
  const rows = db.prepare(
    "SELECT * FROM entity_events WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC"
  ).all(req.params.type, req.params.id);
  ok(res, rows.map(r => ({
    id: r.id, entityType: r.entity_type, entityId: r.entity_id,
    eventType: r.event_type, field: r.field,
    oldValue: r.old_value, newValue: r.new_value,
    meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return r.meta; } })() : null,
    createdAt: r.created_at,
  })));
});

// ─── Shipment Messages ────────────────────────────────────────────────────────

const broadcastMessage = (shipmentId, payload) => {
  const subs = shipmentSubs.get(shipmentId);
  if (!subs) return;
  const frame = JSON.stringify({ type: "new_message", message: payload });
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
};

// Recompute and persist space_badge after any container change; broadcast if changed.
// NOTE: shipmentSubs is declared after this function — that's safe because this
// function is only ever called at request-time, by which point all module-level
// consts are initialised.
const recomputeSpaceBadge = shipmentId => {
  try {
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(shipmentId);
    if (!shipment) return;

    let badge = '';
    if (shipment.allocation_id) {
      const alloc = db.prepare("SELECT * FROM allocations WHERE id=?").get(shipment.allocation_id);
      if (alloc) {
        const { shipment_teu } = db.prepare(
          "SELECT COALESCE(SUM(CASE WHEN size=20 THEN 1 WHEN size IN (40,45) THEN 2 ELSE 0 END),0) AS shipment_teu FROM containers WHERE shipment_id=?"
        ).get(shipmentId);
        const { other_teu } = db.prepare(
          "SELECT COALESCE(SUM(CASE WHEN c.size=20 THEN 1 WHEN c.size IN (40,45) THEN 2 ELSE 0 END),0) AS other_teu FROM containers c JOIN shipments s ON s.id=c.shipment_id WHERE s.allocation_id=? AND s.id!=?"
        ).get(shipment.allocation_id, shipmentId);
        const remaining = Math.max(0, alloc.allocated_teu - other_teu);
        if (shipment_teu > remaining)          badge = 'exceeded';
        else if (shipment.space_overage_reason) badge = 'warning';
      }
    }

    if (badge !== (shipment.space_badge || '')) {
      db.prepare("UPDATE shipments SET space_badge=? WHERE id=?").run(badge, shipmentId);
      const subs = shipmentSubs.get(shipmentId);
      if (subs) {
        const frame = JSON.stringify({ type: "space_badge_update", badge });
        for (const ws of subs) if (ws.readyState === ws.OPEN) ws.send(frame);
      }
    }
  } catch { /* non-fatal */ }
};

app.get("/api/shipments/:id/messages", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM shipment_messages WHERE shipment_id=? ORDER BY created_at ASC"
  ).all(req.params.id);
  ok(res, rows.map(r => ({ id: r.id, shipmentId: r.shipment_id, body: r.body,
    author: r.author, role: r.role, createdAt: r.created_at })));
});

app.post("/api/shipments/:id/messages", (req, res) => {
  const { body, author = "User", role = "" } = req.body;
  if (!body || body.trim().length < 15) return err(res, "Message must be at least 15 characters", 400);
  if (body.trim().length > 500) return err(res, "Message must be at most 500 characters", 400);
  const id = `MSG-${uid()}`;
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO shipment_messages (id,shipment_id,body,author,role,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, req.params.id, body.trim(), author.trim(), role.trim(), createdAt);
  const newMsg = { id, shipmentId: req.params.id, body: body.trim(), author, role, createdAt };
  broadcastMessage(req.params.id, newMsg);
  ok(res, newMsg, 201);
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  const t = Date.now();
  try {
    const counts = {
      shipments: db.prepare("SELECT COUNT(*) AS n FROM shipments").get().n,
      contracts: db.prepare("SELECT COUNT(*) AS n FROM contracts").get().n,
      ports:     db.prepare("SELECT COUNT(*) AS n FROM port_locations").get().n,
      vessels:   db.prepare("SELECT COUNT(*) AS n FROM vessels").get().n,
    };
    ok(res, {
      status:        "ok",
      version:       "0.16.0",
      uptime:        Math.floor(process.uptime()),
      memoryMb:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      fxCurrencies:  Object.keys(fxCache.rates).length,
      fxCacheAgeMin: fxCache.ts ? Math.round((Date.now() - fxCache.ts) / 60000) : null,
      counts,
      latency:       Date.now() - t,
      ts:            new Date().toISOString(),
    });
  } catch (e) {
    err(res, `Health check failed: ${e.message}`, 503);
  }
});

// ─── System Messages ─────────────────────────────────────────────────────────

app.get("/api/system-messages", (req, res) => {
  const now = new Date().toISOString().slice(0, 16);
  const rows = db.prepare(`SELECT * FROM system_messages
    WHERE (active_from = '' OR active_from <= ?)
      AND (active_to   = '' OR active_to   >= ?)
    ORDER BY created_at DESC`).all(now, now);
  ok(res, rows.map(mapSystemMessage));
});

app.get("/api/system-messages/all", (req, res) => {
  ok(res, db.prepare("SELECT * FROM system_messages ORDER BY created_at DESC").all().map(mapSystemMessage));
});

app.post("/api/system-messages", (req, res) => {
  const { title, body = "", severity = "info", activeFrom = "", activeTo = "" } = req.body;
  if (!title?.trim()) return err(res, "title required");
  const id = `MSG-${uid()}`;
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO system_messages (id,title,body,severity,active_from,active_to,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, title.trim(), body.trim(), severity, activeFrom, activeTo, createdAt);
  ok(res, mapSystemMessage({ id, title: title.trim(), body: body.trim(), severity, active_from: activeFrom, active_to: activeTo, created_at: createdAt }), 201);
});

app.delete("/api/system-messages/:id", (req, res) => {
  const info = db.prepare("DELETE FROM system_messages WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

// ─── Sanctions & Screening ───────────────────────────────────────────────────

app.get("/api/sanctions/entries", (req, res) => {
  const { search = '', limit = '50', offset = '0', source = '' } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200);
  const off = parseInt(offset) || 0;
  const conditions = [];
  const params = [];
  if (search.trim()) {
    conditions.push("(entity_name LIKE ? OR program LIKE ?)");
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }
  if (source.trim()) { conditions.push("source = ?"); params.push(source.trim()); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM sanctions_entries ${where}`).get(...params).n;
  const rows  = db.prepare(`SELECT id, source, ref_id, entity_name, entity_type, program FROM sanctions_entries ${where} ORDER BY entity_name LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows, total, limit: lim, offset: off });
});

app.get("/api/sanctions/status", (req, res) => {
  const syncs = db.prepare("SELECT * FROM sanctions_syncs ORDER BY synced_at DESC").all();
  const count = db.prepare("SELECT COUNT(*) AS n FROM sanctions_entries").get().n;
  ok(res, { syncs, entryCount: count, indexed: sanctionsMap.size });
});

app.post("/api/sanctions/sync", async (req, res) => {
  try {
    ok(res, await syncOfacSdn());
    scheduleNextOfacSync();
  } catch (e) {
    err(res, e.message, 502);
  }
});

// ─── OFAC CSV import ──────────────────────────────────────────────────────────
// Parses OFAC sdn.csv — handles both formats:
//   (A)  ent_num, "Name", "Type", "Program", ...
//   (B)  " -0- ", ent_num, "Name", "Type", "Program", ...  (record-type-indicator variant)
function parseCSVLine(line) {
  const fields = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      fields.push(cur.trim()); cur = "";
    } else {
      cur += c;
    }
  }
  fields.push(cur.trim());
  return fields;
}

function parseOfacCsv(csvText) {
  const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const entries = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const f = parseCSVLine(raw);
    if (f.length < 2) continue;
    let entNum, name, sdnType, program;
    // Detect format (B): first field looks like -0-, -1-, -2- …
    const recIndicator = f[0].replace(/[\s-]/g, "");
    if (/^\d+$/.test(recIndicator) && f[0].includes("-")) {
      if (recIndicator !== "0") continue; // skip aliases / addresses / other sub-records
      entNum = f[1]; name = f[2]; sdnType = f[3] || ""; program = f[4] || "";
    } else {
      // Format (A): first field is entity number
      entNum = f[0]; name = f[1]; sdnType = f[2] || ""; program = f[3] || "";
    }
    if (!name || !entNum) continue;
    // Skip header rows
    if (/sdn_?name|^name$/i.test(name)) continue;
    entries.push({ refId: String(entNum), name, sdnType, program: program.replace(/;+$/, "") });
  }
  return entries;
}

app.post("/api/sanctions/import-csv", (req, res) => {
  const { csv } = req.body;
  if (!csv || typeof csv !== "string") return err(res, "csv string required");
  try {
    const entries = parseOfacCsv(csv);
    if (entries.length === 0) return err(res, "No valid entries found — check the file format");
    db.prepare("DELETE FROM sanctions_entries WHERE source='OFAC-SDN'").run();
    const ins = db.prepare(
      `INSERT OR REPLACE INTO sanctions_entries
         (id, source, ref_id, entity_name, entity_name_norm, entity_type, program, aliases_norm)
       VALUES (?, 'OFAC-SDN', ?, ?, ?, ?, ?, '[]')`
    );
    db.exec("BEGIN");
    try {
      for (const e of entries)
        ins.run(`OFAC-${e.refId}`, e.refId, e.name, normSanctionName(e.name), e.sdnType, e.program);
      db.exec("COMMIT");
    } catch (e2) { db.exec("ROLLBACK"); throw e2; }
    const now = new Date().toISOString();
    db.prepare("INSERT OR REPLACE INTO sanctions_syncs (source, synced_at, entry_count) VALUES ('OFAC-SDN', ?, ?)").run(now, entries.length);
    loadSanctionsIndex();
    scheduleNextOfacSync();
    ok(res, { source: "OFAC-SDN", syncedAt: now, entries: entries.length });
  } catch (e) {
    err(res, e.message, 400);
  }
});

app.get("/api/shipments/:id/screening", (req, res) => {
  const row = db.prepare("SELECT * FROM shipment_screenings WHERE shipment_id=?").get(req.params.id);
  if (!row) return ok(res, null);
  ok(res, { id: row.id, shipmentId: row.shipment_id, screenedAt: row.screened_at,
    result: row.result, hits: JSON.parse(row.hits || "[]"),
    overriddenAt: row.overridden_at || null, overrideReason: row.override_reason || null });
});

app.post("/api/shipments/:id/screen", (req, res) => {
  if (!db.prepare("SELECT id FROM shipments WHERE id=?").get(req.params.id)) return err(res, "Not found", 404);
  if (sanctionsMap.size === 0) return err(res, "Sanctions list not yet synced — use POST /api/sanctions/sync first.", 400);
  ok(res, screenShipmentById(req.params.id));
});

app.post("/api/shipments/:id/screening/override", (req, res) => {
  const { reason = "" } = req.body;
  if (!reason.trim()) return err(res, "Override reason is required");
  const row = db.prepare("SELECT id FROM shipment_screenings WHERE shipment_id=?").get(req.params.id);
  if (!row) return err(res, "No screening record found for this shipment", 404);
  const now = new Date().toISOString();
  db.prepare("UPDATE shipment_screenings SET result='CLEAR', overridden_at=?, override_reason=? WHERE shipment_id=?")
    .run(now, reason.trim(), req.params.id);
  ok(res, { overriddenAt: now, overrideReason: reason.trim() });
});

// ─── Contract rate → charge code mapping ─────────────────────────────────────

const SERVICE_CODE_MAP = {
  OF: 'Ocean Freight', OCF: 'Ocean Freight',
  BL: 'B/L Fee',  BLF: 'B/L Fee', DOC: 'B/L Fee',
  THC: 'Origin THC', OTHC: 'Origin THC', ORI: 'Origin THC',
  DTHC: 'Destination THC', DEST: 'Destination THC',
  CUS: 'Customs', CUST: 'Customs',
  INL: 'Inland', INLAND: 'Inland',
};

function importContractRates(shipmentId, { splitPerContainer = false } = {}) {
  const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(shipmentId);
  if (!shipment || shipment.contract_type !== 'Central' || !shipment.contract_id) return 0;
  const rates = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(shipment.contract_id);
  if (!rates.length) return 0;
  const ctrs = db.prepare("SELECT id, container_number, size, type FROM containers WHERE shipment_id=?").all(shipmentId);
  const now = new Date().toISOString();
  let created = 0;
  for (const r of rates) {
    const chargeCode   = SERVICE_CODE_MAP[r.service_code?.toUpperCase()] || 'Other';
    const exchangeRate = (r.amount > 0 && r.amount_usd > 0) ? Math.round((r.amount_usd / r.amount) * 100000) / 100000 : 1;
    const baseNotes    = [r.service_code, r.description].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' — ');

    // When the rate targets a specific container type, only apply to matching containers.
    // Skip entirely if none match — prevents phantom lines for unrelated container sizes.
    const applicableCtrs = r.container_type
      ? ctrs.filter(c => `${c.size || ''}${c.type || ''}`.toUpperCase() === r.container_type.toUpperCase())
      : ctrs;
    if (r.unit === 'per_container' && r.container_type && applicableCtrs.length === 0) continue;

    if (r.unit === 'per_container' && splitPerContainer && applicableCtrs.length > 0) {
      for (const c of applicableCtrs) {
        const cLabel = c.container_number
          ? `${c.container_number}${c.size || c.type ? ` (${c.size}${c.type})` : ''}`
          : `(${c.size || ''}${c.type || ''})`;
        const notes = [cLabel, baseNotes].filter(Boolean).join(' — ');
        const id    = `CL-${uid()}`;
        db.prepare("INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,notes,container_id,created_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, shipmentId, 'BUY', chargeCode, r.currency || 'USD', r.amount, exchangeRate, notes, c.id, now, 'contract');
        logEntityEvent('cost_line', id, 'IMPORTED', null, null, null,
          JSON.stringify({ shipmentId, chargeCode, currency: r.currency || 'USD', amount: r.amount, exchangeRate, containerId: c.id }));
        created++;
      }
    } else {
      const containerCount = r.unit === 'per_container' ? (applicableCtrs.length || 1) : 1;
      const amount = r.unit === 'per_container' ? r.amount * containerCount : r.amount;
      const id     = `CL-${uid()}`;
      db.prepare("INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,notes,container_id,created_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, shipmentId, 'BUY', chargeCode, r.currency || 'USD', amount, exchangeRate, baseNotes, '', now, 'contract');
      logEntityEvent('cost_line', id, 'IMPORTED', null, null, null,
        JSON.stringify({ shipmentId, chargeCode, currency: r.currency || 'USD', amount, exchangeRate }));
      created++;
    }
  }
  return created;
}

// ─── Cost Lines ───────────────────────────────────────────────────────────────

app.post("/api/shipments/:id/cost-lines/import-contract", (req, res) => {
  const { overwrite = false, splitPerContainer = false } = req.body || {};
  const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
  if (!shipment) return err(res, "Shipment not found", 404);
  if (shipment.contract_type !== 'Central' || !shipment.contract_id)
    return err(res, "Shipment is not linked to a Central contract");
  if (overwrite) {
    const existing = db.prepare("SELECT id FROM shipment_cost_lines WHERE shipment_id=? AND type='BUY' AND source='contract'").all(req.params.id);
    for (const row of existing) db.prepare("DELETE FROM shipment_cost_lines WHERE id=?").run(row.id);
  }
  const count = importContractRates(req.params.id, { splitPerContainer });
  ok(res, { imported: count });
});

app.get("/api/shipments/:id/cost-lines", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM shipment_cost_lines WHERE shipment_id=? ORDER BY type, created_at ASC"
  ).all(req.params.id);
  ok(res, rows.map(mapCostLine));
});

app.post("/api/shipments/:id/cost-lines", (req, res) => {
  const { type, chargeCode, currency = 'USD', amount, exchangeRate = 1, notes = '', containerId = '' } = req.body;
  if (!type || !chargeCode || amount == null) return err(res, "type, chargeCode, amount required");
  if (!['BUY','SELL'].includes(type)) return err(res, "type must be BUY or SELL");
  const id  = `CL-${uid()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,notes,container_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, req.params.id, type, chargeCode, currency.toUpperCase(), Number(amount), Number(exchangeRate), notes, containerId, now);
  logEntityEvent('cost_line', id, 'CREATED', null, null, null,
    JSON.stringify({ shipmentId: req.params.id, type, chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchangeRate: Number(exchangeRate) }));
  ok(res, mapCostLine({ id, shipment_id: req.params.id, type, charge_code: chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchange_rate: Number(exchangeRate), notes, container_id: containerId, source: 'manual', modified_at: null, created_at: now }), 201);
});

app.put("/api/shipments/:shipmentId/cost-lines/:id", (req, res) => {
  const { type, chargeCode, currency = 'USD', amount, exchangeRate = 1, notes = '', containerId = '' } = req.body;
  if (!type || !chargeCode || amount == null) return err(res, "type, chargeCode, amount required");
  if (!['BUY','SELL'].includes(type)) return err(res, "type must be BUY or SELL");
  const existing = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=? AND shipment_id=?").get(req.params.id, req.params.shipmentId);
  if (!existing) return err(res, "Not found", 404);
  const now = new Date().toISOString();
  db.prepare("UPDATE shipment_cost_lines SET type=?,charge_code=?,currency=?,amount=?,exchange_rate=?,notes=?,container_id=?,modified_at=? WHERE id=?")
    .run(type, chargeCode, currency.toUpperCase(), Number(amount), Number(exchangeRate), notes, containerId, now, req.params.id);
  for (const [field, oldV, newV] of [
    ['type',          existing.type,          type],
    ['charge_code',   existing.charge_code,   chargeCode],
    ['currency',      existing.currency,      currency.toUpperCase()],
    ['amount',        String(existing.amount), String(Number(amount))],
    ['exchange_rate', String(existing.exchange_rate), String(Number(exchangeRate))],
    ['notes',         existing.notes || '',   notes],
    ['container_id',  existing.container_id || '', containerId],
  ]) {
    if (String(oldV) !== String(newV))
      logEntityEvent('cost_line', req.params.id, 'UPDATED', field, oldV, newV,
        JSON.stringify({ shipmentId: existing.shipment_id, chargeCode: chargeCode, type }));
  }
  ok(res, mapCostLine({ id: req.params.id, shipment_id: existing.shipment_id, type, charge_code: chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchange_rate: Number(exchangeRate), notes, container_id: containerId, source: existing.source || 'manual', modified_at: now, created_at: existing.created_at }));
});

app.delete("/api/shipments/:shipmentId/cost-lines/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=? AND shipment_id=?").get(req.params.id, req.params.shipmentId);
  if (!existing) return err(res, "Not found", 404);
  db.prepare("DELETE FROM shipment_cost_lines WHERE id=?").run(req.params.id);
  logEntityEvent('cost_line', req.params.id, 'DELETED', null, null, null,
    JSON.stringify({ shipmentId: existing.shipment_id, type: existing.type, chargeCode: existing.charge_code, amount: existing.amount, currency: existing.currency, source: existing.source || 'manual' }));
  ok(res, { deleted: req.params.id });
});

app.get("/api/shipments/:id/cost-line-events", (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM entity_events
    WHERE entity_type = 'cost_line'
    AND json_extract(meta, '$.shipmentId') = ?
    ORDER BY created_at DESC
  `).all(req.params.id);
  ok(res, rows);
});

// ─── Shipment Milestones ──────────────────────────────────────────────────────

app.get("/api/shipments/:id/milestones", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM shipment_milestones WHERE shipment_id=? ORDER BY sequence_order ASC"
  ).all(req.params.id);
  ok(res, rows.map(mapMilestone));
});

app.post("/api/shipments/:id/milestones/init", (req, res) => {
  const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
  if (!shipment) return err(res, "Shipment not found", 404);
  const carrierCode = req.body?.carrierCode || shipment.carrier_code || '';
  const tradeLane   = req.body?.tradeLane || '';
  let templates = carrierCode
    ? db.prepare("SELECT * FROM milestone_templates WHERE carrier_code=? AND trade_lane=? ORDER BY sequence_order").all(carrierCode, tradeLane)
    : [];
  if (!templates.length && carrierCode)
    templates = db.prepare("SELECT * FROM milestone_templates WHERE carrier_code=? AND trade_lane='' ORDER BY sequence_order").all(carrierCode);
  if (!templates.length)
    templates = db.prepare("SELECT * FROM milestone_templates WHERE template_key='FCL' AND carrier_code='' ORDER BY sequence_order").all();
  if (!templates.length) return err(res, "No milestone template found");
  db.prepare("DELETE FROM shipment_milestones WHERE shipment_id=?").run(req.params.id);
  const now = new Date().toISOString();
  const created = [];
  for (const t of templates) {
    const id = `MS-${uid()}`;
    db.prepare("INSERT INTO shipment_milestones (id,shipment_id,milestone_key,label,sequence_order,estimated_date,completed_at,completed_by,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.params.id, t.milestone_key, t.label, t.sequence_order, '', '', '', '', now);
    created.push(mapMilestone({ id, shipment_id: req.params.id, milestone_key: t.milestone_key, label: t.label, sequence_order: t.sequence_order, estimated_date: '', completed_at: '', completed_by: '', note: '', created_at: now }));
  }
  ok(res, created, 201);
});

app.put("/api/milestones/:id", (req, res) => {
  const { estimatedDate = '', completedAt = '', completedBy = '', note = '' } = req.body || {};
  const existing = db.prepare("SELECT * FROM shipment_milestones WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  db.prepare("UPDATE shipment_milestones SET estimated_date=?,completed_at=?,completed_by=?,note=? WHERE id=?")
    .run(estimatedDate, completedAt, completedBy, note, req.params.id);
  ok(res, mapMilestone({ ...existing, estimated_date: estimatedDate, completed_at: completedAt, completed_by: completedBy, note }));
});

app.delete("/api/milestones/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM shipment_milestones WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  db.prepare("DELETE FROM shipment_milestones WHERE id=?").run(req.params.id);
  ok(res, { deleted: req.params.id });
});

// ─── Milestone Templates ──────────────────────────────────────────────────────

app.get("/api/milestone-templates", (req, res) => {
  const rows = db.prepare("SELECT * FROM milestone_templates ORDER BY template_key, carrier_code, sequence_order").all();
  ok(res, rows.map(mapMilestoneTemplate));
});

app.post("/api/milestone-templates", (req, res) => {
  const { templateKey = 'FCL', carrierCode = '', tradeLane = '', milestoneKey, label, sequenceOrder = 0 } = req.body || {};
  if (!milestoneKey || !label) return err(res, "milestoneKey and label required");
  const id = `MT-${uid()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO milestone_templates (id,template_key,carrier_code,trade_lane,milestone_key,label,sequence_order,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, templateKey, carrierCode, tradeLane, milestoneKey, label, Number(sequenceOrder), now);
  ok(res, mapMilestoneTemplate({ id, template_key: templateKey, carrier_code: carrierCode, trade_lane: tradeLane, milestone_key: milestoneKey, label, sequence_order: Number(sequenceOrder), created_at: now }), 201);
});

app.put("/api/milestone-templates/:id", (req, res) => {
  const { templateKey, carrierCode = '', tradeLane = '', milestoneKey, label, sequenceOrder } = req.body || {};
  const existing = db.prepare("SELECT * FROM milestone_templates WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const tKey = templateKey || existing.template_key;
  const mKey = milestoneKey || existing.milestone_key;
  const lbl  = label || existing.label;
  const seq  = sequenceOrder != null ? Number(sequenceOrder) : existing.sequence_order;
  db.prepare("UPDATE milestone_templates SET template_key=?,carrier_code=?,trade_lane=?,milestone_key=?,label=?,sequence_order=? WHERE id=?")
    .run(tKey, carrierCode, tradeLane, mKey, lbl, seq, req.params.id);
  ok(res, mapMilestoneTemplate({ id: req.params.id, template_key: tKey, carrier_code: carrierCode, trade_lane: tradeLane, milestone_key: mKey, label: lbl, sequence_order: seq, created_at: existing.created_at }));
});

app.delete("/api/milestone-templates/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM milestone_templates WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  db.prepare("DELETE FROM milestone_templates WHERE id=?").run(req.params.id);
  ok(res, { deleted: req.params.id });
});

// ─── Margin Summary (Dashboard) ───────────────────────────────────────────────

app.get("/api/margin/summary", (req, res) => {
  const lines = db.prepare(`
    SELECT cl.*, s.carrier_code, s.pol, s.pod, s.etd, s.created_at AS shp_created_at
    FROM shipment_cost_lines cl
    JOIN shipments s ON s.id = cl.shipment_id
  `).all();

  const todayStr = new Date().toISOString().slice(0, 10);
  const weekBuckets = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - (5 - i) * 7);
    const end   = d.toISOString().slice(0, 10);
    const start = new Date(d.setDate(d.getDate() - 6)).toISOString().slice(0, 10);
    const label = new Date(end).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    return { start, end, label };
  });

  const aggregate = (rows) => {
    const buy  = rows.filter(r => r.type === 'BUY').reduce((s, r) => s + r.amount * r.exchange_rate, 0);
    const sell = rows.filter(r => r.type === 'SELL').reduce((s, r) => s + r.amount * r.exchange_rate, 0);
    const gp   = sell - buy;
    const pct  = sell > 0 ? Math.round((gp / sell) * 1000) / 10 : null;
    return { totalBuyUsd: Math.round(buy * 100) / 100, totalSellUsd: Math.round(sell * 100) / 100, grossProfitUsd: Math.round(gp * 100) / 100, grossMarginPct: pct };
  };

  const weeklyBreakdown = (rows) => weekBuckets.map(b => {
    const inBucket = rows.filter(r => {
      const ref = (r.etd || r.shp_created_at || '').slice(0, 10);
      return ref >= b.start && ref <= b.end;
    });
    const a = aggregate(inBucket);
    return { week: b.label, ...a };
  });

  // Overall totals
  const overall = aggregate(lines);

  // By carrier
  const carrierCodes = [...new Set(lines.map(r => r.carrier_code))];
  const byCarrier = carrierCodes.map(code => {
    const rows = lines.filter(r => r.carrier_code === code);
    return { carrierCode: code, ...aggregate(rows), weeks: weeklyBreakdown(rows) };
  }).sort((a, b) => (b.totalSellUsd || 0) - (a.totalSellUsd || 0));

  // By lane (pol → pod)
  const lanes = [...new Set(lines.map(r => `${r.pol} → ${r.pod}`))];
  const byLane = lanes.map(lane => {
    const [pol, pod] = lane.split(' → ');
    const rows = lines.filter(r => r.pol === pol && r.pod === pod);
    return { lane, ...aggregate(rows), weeks: weeklyBreakdown(rows) };
  }).sort((a, b) => (b.totalSellUsd || 0) - (a.totalSellUsd || 0));

  ok(res, { ...overall, byCarrier, byLane });
});

// ─── Application Settings ────────────────────────────────────────────────────

app.get("/api/settings", (req, res) => ok(res, getSettings()));

app.put("/api/settings", (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== "object" || Array.isArray(updates))
    return err(res, "Expected JSON object of { key: value } pairs");
  const stmt = db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)");
  db.exec("BEGIN");
  try {
    for (const [k, v] of Object.entries(updates)) stmt.run(String(k), String(v));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return err(res, e.message); }
  // Reschedule OFAC auto-sync if relevant settings changed
  scheduleNextOfacSync();
  ok(res, getSettings());
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// shipmentId → Set<WebSocket>
const shipmentSubs = new Map();

wss.on("connection", ws => {
  let subscribedId = null;

  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "subscribe" && msg.shipmentId) {
        subscribedId = msg.shipmentId;
        if (!shipmentSubs.has(subscribedId)) shipmentSubs.set(subscribedId, new Set());
        shipmentSubs.get(subscribedId).add(ws);
      }
    } catch { /* ignore malformed frames */ }
  });

  ws.on("close", () => {
    if (subscribedId && shipmentSubs.has(subscribedId)) {
      const subs = shipmentSubs.get(subscribedId);
      subs.delete(ws);
      if (subs.size === 0) shipmentSubs.delete(subscribedId);
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = 3001;
httpServer.listen(PORT, () => console.log(`⚓  CargoDesk API + WS running on http://localhost:${PORT}`));