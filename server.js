"use strict";
const express    = require("express");
const http       = require("http");
const https      = require("https");
const path       = require("path");
const fs         = require("fs");
const { WebSocketServer } = require("ws");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const {
  renderHtmlToPdf,
  generateSelfSignedSigningCert, getActiveSigningCert, signPdfBuffer,
} = require("./lib/pdf-signing");
const {
  createTransporterFromSettings, getTransporterForOffice,
  invalidateTransporterCache, buildMailOptions, sendViaOffice,
} = require("./lib/mailer");
const { createAisListener } = require("./lib/ais-listener");
const { createMappers } = require("./lib/mappers");
const { readSecret } = require("./lib/dockerSecret");
const { createRateLimiter } = require("./lib/rateLimit");
const { addBusinessDays, businessDaysBetween } = require("./lib/business-days");
const staticConfig = require("./lib/staticConfig");

const JWT_DEV_DEFAULT = "cargoDesk-dev-secret-do-not-use-in-prod";
const JWT_SECRET = readSecret("JWT_SECRET", JWT_DEV_DEFAULT);
if (JWT_SECRET === JWT_DEV_DEFAULT)
  console.warn("⚠  JWT_SECRET not set (checked JWT_SECRET_FILE, then JWT_SECRET) — using insecure dev default. Set it before deploying.");

// Document Distribution Service (services/document-distribution/) — CargoDesk's first extracted
// microservice. This secret must match DISTRIBUTION_SERVICE_SECRET in that service's own env.
const DISTRIBUTION_SERVICE_URL = process.env.DISTRIBUTION_SERVICE_URL || "http://localhost:3002";

// PDF Render Service (services/pdf-render/) — stateless, no secret needed here: this constant is
// only used for the System Health check's own GET /health probe, not for calling its protected
// /internal/render route (that call lives in lib/pdf-signing.js with its own copy of this URL).
const PDF_RENDER_SERVICE_URL = process.env.PDF_RENDER_SERVICE_URL || "http://localhost:3003";
const DISTRIBUTION_SECRET_DEV_DEFAULT = "cargoDesk-dev-distribution-secret-do-not-use-in-prod";
const DISTRIBUTION_SERVICE_SECRET = readSecret("DISTRIBUTION_SERVICE_SECRET", DISTRIBUTION_SECRET_DEV_DEFAULT);
if (DISTRIBUTION_SERVICE_SECRET === DISTRIBUTION_SECRET_DEV_DEFAULT)
  console.warn("⚠  DISTRIBUTION_SERVICE_SECRET not set (checked DISTRIBUTION_SERVICE_SECRET_FILE, then DISTRIBUTION_SERVICE_SECRET) — using insecure dev default. Set it (matching the distribution service's own env) before deploying.");

// Contract Management Service (services/contract-management/) — CargoDesk's third extracted
// microservice, and its first that runs ALONGSIDE the monolith's own in-process implementation
// rather than replacing it — selected per-request via the app_settings.contract_source toggle
// ('local'|'remote', default 'local' — see getSettings()/callContractService below). This secret
// must match CONTRACT_SERVICE_SECRET in that service's own env.
const CONTRACT_SERVICE_URL = process.env.CONTRACT_SERVICE_URL || "http://localhost:3004";
const CONTRACT_SECRET_DEV_DEFAULT = "cargoDesk-dev-contract-service-secret-do-not-use-in-prod";
const CONTRACT_SERVICE_SECRET = readSecret("CONTRACT_SERVICE_SECRET", CONTRACT_SECRET_DEV_DEFAULT);
if (CONTRACT_SERVICE_SECRET === CONTRACT_SECRET_DEV_DEFAULT)
  console.warn("⚠  CONTRACT_SERVICE_SECRET not set (checked CONTRACT_SERVICE_SECRET_FILE, then CONTRACT_SERVICE_SECRET) — using insecure dev default. Set it (matching the contract service's own env) before deploying.");

// Unlike callDistributionService (routes/document-distribution.js, its only consumer), this is
// shared across routes/contracts.js, routes/allocations.js, and server.js's own
// createRateSnapshot/checkDgPolicy call sites — defined once here and handed out via ctx instead
// of being duplicated per file. Same clean-503-on-unreachable contract as its distribution-service
// counterpart.
async function callContractService(method, urlPath, body) {
  let r;
  try {
    r = await fetch(`${CONTRACT_SERVICE_URL}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${CONTRACT_SERVICE_SECRET}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    const e = new Error("Contract Management Service is unreachable — try again shortly");
    e.status = 503;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `Contract service returned HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// MDM Service (services/mdm/) — carriers/vessels/port_locations/linked_ports/trade_lanes/
// country_trade_lanes/regions/countries/commodities/carrier_agents, selected per-request via the
// app_settings.mdm_source toggle, same shape as Contract Management. This secret must match
// MDM_SERVICE_SECRET in that service's own env.
const MDM_SERVICE_URL = process.env.MDM_SERVICE_URL || "http://localhost:3005";
const MDM_SECRET_DEV_DEFAULT = "cargoDesk-dev-mdm-service-secret-do-not-use-in-prod";
const MDM_SERVICE_SECRET = readSecret("MDM_SERVICE_SECRET", MDM_SECRET_DEV_DEFAULT);
if (MDM_SERVICE_SECRET === MDM_SECRET_DEV_DEFAULT)
  console.warn("⚠  MDM_SERVICE_SECRET not set (checked MDM_SERVICE_SECRET_FILE, then MDM_SERVICE_SECRET) — using insecure dev default. Set it (matching the MDM service's own env) before deploying.");

async function callMdmService(method, urlPath, body) {
  let r;
  try {
    r = await fetch(`${MDM_SERVICE_URL}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${MDM_SERVICE_SECRET}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    const e = new Error("MDM Service is unreachable — try again shortly");
    e.status = 503;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `MDM service returned HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// Screening Service (services/screening/) — sanctions_entries/sanctions_syncs, selected
// per-request via the app_settings.screening_source toggle ('local'|'remote'), same shape as
// contract_source/mdm_source. This secret must match SCREENING_SERVICE_SECRET in that service's
// own env.
const SCREENING_SERVICE_URL = process.env.SCREENING_SERVICE_URL || "http://localhost:3006";
const SCREENING_SECRET_DEV_DEFAULT = "cargoDesk-dev-screening-service-secret-do-not-use-in-prod";
const SCREENING_SERVICE_SECRET = readSecret("SCREENING_SERVICE_SECRET", SCREENING_SECRET_DEV_DEFAULT);
if (SCREENING_SERVICE_SECRET === SCREENING_SECRET_DEV_DEFAULT)
  console.warn("⚠  SCREENING_SERVICE_SECRET not set (checked SCREENING_SERVICE_SECRET_FILE, then SCREENING_SERVICE_SECRET) — using insecure dev default. Set it (matching the screening service's own env) before deploying.");

async function callScreeningService(method, urlPath, body) {
  let r;
  try {
    r = await fetch(`${SCREENING_SERVICE_URL}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${SCREENING_SERVICE_SECRET}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    const e = new Error("Screening Service is unreachable — try again shortly");
    e.status = 503;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `Screening service returned HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// Kanban/Testing Service (services/kanban/) — tickets/ticket_links/test_items/test_case_links/
// kb_projects/kb_versions/kb_columns, selected per-request via the app_settings.kanban_source
// toggle ('local'|'remote'), same shape as contract_source/mdm_source/screening_source. This
// secret must match KANBAN_SERVICE_SECRET in that service's own env.
const KANBAN_SERVICE_URL = process.env.KANBAN_SERVICE_URL || "http://localhost:3007";
const KANBAN_SECRET_DEV_DEFAULT = "cargoDesk-dev-kanban-service-secret-do-not-use-in-prod";
const KANBAN_SERVICE_SECRET = readSecret("KANBAN_SERVICE_SECRET", KANBAN_SECRET_DEV_DEFAULT);
if (KANBAN_SERVICE_SECRET === KANBAN_SECRET_DEV_DEFAULT)
  console.warn("⚠  KANBAN_SERVICE_SECRET not set (checked KANBAN_SERVICE_SECRET_FILE, then KANBAN_SERVICE_SECRET) — using insecure dev default. Set it (matching the kanban service's own env) before deploying.");

async function callKanbanService(method, urlPath, body) {
  let r;
  try {
    r = await fetch(`${KANBAN_SERVICE_URL}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${KANBAN_SERVICE_SECRET}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    const e = new Error("Kanban Service is unreachable — try again shortly");
    e.status = 503;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `Kanban service returned HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// Customer Service (services/customers/) — customers/customer_identifiers/customer_screenings/
// customer_contacts, selected per-request via the app_settings.customer_source toggle
// ('local'|'remote'), same shape as contract_source/mdm_source/screening_source/kanban_source.
// The fifth and final "toggle" extraction (Epic 5 of the Organization Model roadmap, deliberately
// sequenced last). This secret must match CUSTOMER_SERVICE_SECRET in that service's own env.
const CUSTOMER_SERVICE_URL = process.env.CUSTOMER_SERVICE_URL || "http://localhost:3008";
const CUSTOMER_SECRET_DEV_DEFAULT = "cargoDesk-dev-customers-service-secret-do-not-use-in-prod";
const CUSTOMER_SERVICE_SECRET = readSecret("CUSTOMER_SERVICE_SECRET", CUSTOMER_SECRET_DEV_DEFAULT);
if (CUSTOMER_SERVICE_SECRET === CUSTOMER_SECRET_DEV_DEFAULT)
  console.warn("⚠  CUSTOMER_SERVICE_SECRET not set (checked CUSTOMER_SERVICE_SECRET_FILE, then CUSTOMER_SERVICE_SECRET) — using insecure dev default. Set it (matching the customers service's own env) before deploying.");

async function callCustomerService(method, urlPath, body) {
  let r;
  try {
    r = await fetch(`${CUSTOMER_SERVICE_URL}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${CUSTOMER_SERVICE_SECRET}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    const e = new Error("Customer Service is unreachable — try again shortly");
    e.status = 503;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `Customer service returned HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// Zero-script onboarding: a fresh clone has no cargodesk.db yet. db/cargodesk.sample.db is a
// committed, pre-seeded copy carrying only static MDM reference data (ports, carriers, vessels,
// commodities, regions, trade lanes, countries) — never shipments/contracts/customers/users,
// which every real install should create for itself. Copied once, in place; never overwrites an
// already-running install's own database.
const DB_PATH = path.join(__dirname, "cargodesk.db");
const SAMPLE_DB_PATH = path.join(__dirname, "db", "cargodesk.sample.db");
if (!fs.existsSync(DB_PATH) && fs.existsSync(SAMPLE_DB_PATH)) {
  fs.copyFileSync(SAMPLE_DB_PATH, DB_PATH);
  console.log("⚓  No cargodesk.db found — copied the bundled MDM reference sample (db/cargodesk.sample.db) to get started.");
}

const app = express();
const db  = new DatabaseSync(DB_PATH);

// Crash-safety net, part 1: every route file in this codebase registers handlers as plain
// `app.get/post/put/patch/delete(path, ...middleware, async (req,res) => {...})` with no
// try/catch — a thrown error (a bad enum value hitting a CHECK constraint, `undefined` bound
// into a node:sqlite statement, a null-property access) becomes a rejected promise Express 4
// never catches, which by default terminates the whole process (confirmed live: a single
// malformed request killed the entire API for every user). Rather than touch ~40 route files,
// patch the registration methods once, here, before any route is registered — every handler
// passed to app.get/post/put/patch/delete from this point on is wrapped so a thrown/rejected
// error is forwarded to next(err) instead of crashing the process. Route files are completely
// unaware this exists and need no changes.
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

// Crash-safety net, part 2: a final backstop for errors thrown OUTSIDE an HTTP request entirely
// (the hourly ops-automation sweep, the AIS listener's message handlers, WS frame handlers,
// scheduled OFAC/CSL syncs) — wrapAsyncHandler above only covers Express route handlers. Node's
// own default for either event is to crash the process; logging and continuing trades a small
// risk of running past a corrupted in-memory state for the much larger, already-demonstrated risk
// of one bad event taking the whole API down for every user. Route-level errors should already be
// caught by wrapAsyncHandler + the error middleware below and never reach here.
process.on("unhandledRejection", (reason) => {
  console.error("⚠ Unhandled promise rejection (process kept alive):", reason);
});
process.on("uncaughtException", (e) => {
  console.error("⚠ Uncaught exception (process kept alive):", e);
});

app.use(express.json({ limit: "25mb" }));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2,8).toUpperCase();
const ok  = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });
const isUniqueViolation = e => e?.message?.includes("UNIQUE constraint");
// First place in the codebase validating a free-typed lat/lng pair — port_locations' own
// latitude/longitude is trusted/curated import data, never user-typed, so nothing like this
// existed before. Per-field, not both-or-neither: cell-level onBlur-flush editing can legitimately
// save one of the pair a moment before the other is typed.
const validCoord = (v, min, max) => v === null || v === undefined || v === ''
  ? true : Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max;

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
  -- Every shipment-detail-page load queries "all containers for this shipment" — 9 call sites,
  -- no index before this (verified via a direct grep of WHERE-clause usage, not assumed).
  CREATE INDEX IF NOT EXISTS idx_containers_shipment ON containers(shipment_id);

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

  -- ── Shipment Legs ──
  CREATE TABLE IF NOT EXISTS shipment_legs (
    id            TEXT PRIMARY KEY,
    shipment_id   TEXT NOT NULL,
    leg_order     INTEGER NOT NULL DEFAULT 0,
    mot           TEXT NOT NULL DEFAULT 'SEA',
    pol           TEXT NOT NULL DEFAULT '',
    pod           TEXT NOT NULL DEFAULT '',
    etd           TEXT DEFAULT NULL,
    eta           TEXT DEFAULT NULL,
    carrier_code  TEXT DEFAULT '',
    vessel        TEXT DEFAULT '',
    vessel_imo    TEXT DEFAULT '',
    voyage        TEXT DEFAULT '',
    contract_type TEXT DEFAULT '',
    contract_ref  TEXT DEFAULT '',
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shp_legs ON shipment_legs(shipment_id, leg_order);

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
  -- Backs every "🕐 History" modal across the app (documents, allocations, contracts, carriers,
  -- ...) — always queried as entity_type=? AND entity_id=?, no index before this.
  CREATE INDEX IF NOT EXISTS idx_entity_events_lookup ON entity_events(entity_type, entity_id);

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
  "ALTER TABLE containers  ADD COLUMN vgm_weight_kg        REAL    DEFAULT NULL",
  "ALTER TABLE containers  ADD COLUMN vgm_status            TEXT    DEFAULT 'Pending'",
  "ALTER TABLE containers  ADD COLUMN vgm_cutoff            TEXT    DEFAULT NULL",
  "ALTER TABLE containers  ADD COLUMN cy_cutoff             TEXT    DEFAULT NULL",
  "ALTER TABLE containers  ADD COLUMN origin_free_time_days INTEGER DEFAULT NULL",
  "ALTER TABLE containers  ADD COLUMN dest_free_time_days   INTEGER DEFAULT NULL",
  // Demurrage (terminal dwell, Gate In->Sailed / Discharged->Gate Out, the two columns above)
  // and Detention (carrier EQUIPMENT held outside the terminal, Empty Pickup->Gate In /
  // Gate Out->Empty Return) are two commercially distinct charge types with separate carrier
  // tariffs and separate free-time allowances — the original v0.30.0 free-time model only ever
  // captured demurrage under a generic "free time" name, despite container_events already
  // logging every event needed to compute detention too. These two new columns are Detention's
  // own free-time allowance, independent of the (now explicitly demurrage-only) pair above.
  "ALTER TABLE containers  ADD COLUMN origin_detention_free_days INTEGER DEFAULT NULL",
  "ALTER TABLE containers  ADD COLUMN dest_detention_free_days   INTEGER DEFAULT NULL",
  // Reefer (20RF/40RF) has been a registered container type since v0.46.0's Pack Types work,
  // but nothing on `containers` ever recorded the carrier's required set-point temperature —
  // essential operational data for a cold-chain booking (food/pharma), and something the
  // carrier's own booking confirmation and the Bill of Lading both need to state. Nullable,
  // Celsius (the ocean-freight reefer convention) — only meaningful when type='RF', but not
  // DB-constrained to that (mirrors this app's existing convention of not enforcing
  // conditionally-relevant fields at the schema level, e.g. dg_class only means something
  // when is_dg=1).
  "ALTER TABLE containers  ADD COLUMN set_temperature_c REAL DEFAULT NULL",
  // What actually releases cargo at destination — 'Original' (must be physically surrendered,
  // or a Letter of Indemnity issued), 'Telex Release'/'Surrendered' (shipper already gave up
  // the original at origin, destination releases on a copy), 'Seaway Bill' (no document
  // presentation at all, ID verification only). '' means not yet recorded — shipments.bl_number
  // is free text with zero concept of how it's actually released, which the Import-side ops
  // team needs to know before they can tell a consignee whether cargo can move without the
  // physical document in hand.
  "ALTER TABLE shipments   ADD COLUMN bl_release_type TEXT DEFAULT ''",
  // Master B/L (carrier <-> forwarder) vs House B/L (forwarder <-> actual shipper) — a real,
  // independent-of-LCL distinction: any shipment booked through an NVOCC/forwarder gets both,
  // even a single-shipper FCL container with zero consolidation involved. bl_number stays the
  // House B/L (every existing reader — BL01, carrier-booking link, etc. — is unaffected);
  // master_bl_number is additive and blank for shipments booked direct with the carrier.
  "ALTER TABLE shipments   ADD COLUMN master_bl_number TEXT DEFAULT ''",
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
  "ALTER TABLE contract_legs ADD COLUMN pol_linked_allowed   INTEGER DEFAULT 0",
  "ALTER TABLE contract_legs ADD COLUMN pod_linked_allowed   INTEGER DEFAULT 0",
  "ALTER TABLE contract_legs ADD COLUMN pol_carrier_haulage  INTEGER DEFAULT 0",
  "ALTER TABLE contract_legs ADD COLUMN pod_carrier_haulage  INTEGER DEFAULT 0",
  "ALTER TABLE contract_legs ADD COLUMN pol_haulage_locations TEXT   DEFAULT ''",
  "ALTER TABLE contract_legs ADD COLUMN pod_haulage_locations TEXT   DEFAULT ''",
  "ALTER TABLE contract_legs ADD COLUMN pol_loc_type          TEXT   DEFAULT 'Terminal'",
  "ALTER TABLE contract_legs ADD COLUMN pod_loc_type          TEXT   DEFAULT 'Terminal'",
  "UPDATE contract_legs SET pol_loc_type='Door' WHERE pol_carrier_haulage=1 AND pol_loc_type='Terminal'",
  "UPDATE contract_legs SET pod_loc_type='Door' WHERE pod_carrier_haulage=1 AND pod_loc_type='Terminal'",
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
  // Every shipment-detail-page load queries "all cost lines for this shipment" — 11 call
  // sites (highest of any table checked), no index before this.
  "CREATE INDEX IF NOT EXISTS idx_cost_lines_shipment ON shipment_cost_lines(shipment_id)",
  "ALTER TABLE shipment_cost_lines ADD COLUMN container_id TEXT DEFAULT ''",
  "ALTER TABLE shipment_cost_lines ADD COLUMN source TEXT DEFAULT 'manual'",
  "ALTER TABLE shipment_cost_lines ADD COLUMN modified_at TEXT",
  // Accrual/posting state machine + GP variance (TKT-83O41G, TKT-6QT30S phase 2).
  // accrued (default) = the estimate, recognized before any real invoice exists.
  // actualized = the real AP/AR invoice has come in — actual_amount/actual_exchange_rate
  // are kept SEPARATE from amount/exchange_rate (the original accrual) so variance =
  // actual - accrued stays computable rather than overwriting the estimate silently.
  // posted = pushed to GL via an explicit admin/operator-only action; a posted line is
  // locked (PUT/DELETE reject it) — any correction is a new adjusting line, never a rewrite.
  "ALTER TABLE shipment_cost_lines ADD COLUMN status TEXT DEFAULT 'accrued'",
  "ALTER TABLE shipment_cost_lines ADD COLUMN actual_amount REAL DEFAULT NULL",
  "ALTER TABLE shipment_cost_lines ADD COLUMN actual_exchange_rate REAL DEFAULT NULL",
  "ALTER TABLE shipment_cost_lines ADD COLUMN actualized_at TEXT DEFAULT NULL",
  "ALTER TABLE shipment_cost_lines ADD COLUMN actualized_by TEXT DEFAULT ''",
  "ALTER TABLE shipment_cost_lines ADD COLUMN posted_at TEXT DEFAULT NULL",
  "ALTER TABLE shipment_cost_lines ADD COLUMN posted_by TEXT DEFAULT ''",
  `CREATE TABLE IF NOT EXISTS shipment_services (
    id             TEXT PRIMARY KEY,
    shipment_id    TEXT NOT NULL,
    side           TEXT NOT NULL,
    service_type   TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'Requested',
    vendor_id      TEXT DEFAULT '',
    vendor_name    TEXT DEFAULT '',
    office_id      TEXT DEFAULT '',
    requested_date TEXT DEFAULT '',
    confirmed_date TEXT DEFAULT '',
    completed_date TEXT DEFAULT '',
    notes          TEXT DEFAULT '',
    created_at     TEXT NOT NULL,
    created_by     TEXT DEFAULT ''
  )`,
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
  // v0.20.0 — Kanban board enhancements
  "ALTER TABLE tickets ADD COLUMN parent_id   TEXT DEFAULT NULL", // self-ref FK: epic › story › sub-task nesting
  "ALTER TABLE tickets ADD COLUMN assignee_id TEXT DEFAULT NULL", // FK → users.id
  "ALTER TABLE tickets ADD COLUMN due_date    TEXT DEFAULT NULL", // ISO date string YYYY-MM-DD
  "ALTER TABLE tickets ADD COLUMN test_notes  TEXT DEFAULT NULL", // captured in TestOutcomeModal when leaving In Testing
  // v0.20.0 — shipment form Phase 1: missing operational fields
  "ALTER TABLE shipments ADD COLUMN freight_terms     TEXT DEFAULT 'Prepaid'",
  "ALTER TABLE shipments ADD COLUMN movement_type     TEXT DEFAULT 'FCL'",
  "ALTER TABLE shipments ADD COLUMN service_type      TEXT DEFAULT 'Port-to-Port'",
  "ALTER TABLE shipments ADD COLUMN place_of_receipt  TEXT DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN place_of_delivery TEXT DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN cargo_ready_date  TEXT DEFAULT NULL",
  "ALTER TABLE shipments ADD COLUMN notify_id              TEXT    DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN notify_name            TEXT    DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN declared_value         REAL    DEFAULT NULL",
  "ALTER TABLE shipments ADD COLUMN declared_value_currency TEXT   DEFAULT 'USD'",
  "ALTER TABLE shipments ADD COLUMN routing_term           TEXT    DEFAULT NULL",
  "ALTER TABLE shipment_legs ADD COLUMN leg_type      TEXT DEFAULT 'SEA'",
  "ALTER TABLE shipment_legs ADD COLUMN movement_type TEXT DEFAULT 'SEA'",
  "ALTER TABLE shipment_legs ADD COLUMN pol_loc_type  TEXT DEFAULT 'Terminal'",
  "ALTER TABLE shipment_legs ADD COLUMN pod_loc_type  TEXT DEFAULT 'Terminal'",
  "ALTER TABLE shipment_legs ADD COLUMN movement_by   TEXT DEFAULT ''",
  // v0.21.0 — multi-role per user + data access scoping
  "ALTER TABLE users ADD COLUMN roles TEXT DEFAULT NULL",
  `CREATE TABLE IF NOT EXISTS user_scope_items (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT '',
    item_type  TEXT NOT NULL,
    value      TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS user_access_configs (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label          TEXT NOT NULL DEFAULT '',
    origin_lane    TEXT,
    dest_lane      TEXT,
    pol_codes      TEXT,
    pod_codes      TEXT,
    carrier_codes  TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS shipment_documents (
    id           TEXT PRIMARY KEY,
    shipment_id  TEXT NOT NULL,
    filename     TEXT NOT NULL,
    stored_name  TEXT NOT NULL,
    mime_type    TEXT NOT NULL DEFAULT '',
    size_bytes   INTEGER NOT NULL DEFAULT 0,
    doc_type     TEXT NOT NULL DEFAULT 'Other',
    uploaded_by  TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_shipment_documents_shipment ON shipment_documents(shipment_id)",
  "ALTER TABLE shipment_documents ADD COLUMN status        TEXT DEFAULT 'draft'",
  "ALTER TABLE shipment_documents ADD COLUMN confirmed_at  TEXT DEFAULT NULL",
  "ALTER TABLE shipment_documents ADD COLUMN confirmed_by  TEXT DEFAULT ''",
  "ALTER TABLE trade_lanes ADD COLUMN transit_days INTEGER DEFAULT 0",
  // v0.24.0 — admin security hardening
  "ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN locked_until    TEXT    NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN token_version   INTEGER NOT NULL DEFAULT 0",
  `CREATE TABLE IF NOT EXISTS admin_events (
    id          TEXT PRIMARY KEY,
    actor_id    TEXT NOT NULL DEFAULT '',
    actor_email TEXT NOT NULL DEFAULT '',
    action      TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id   TEXT NOT NULL DEFAULT '',
    details     TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // v0.25.0 — customer profiles enhancement
  `CREATE TABLE IF NOT EXISTS customer_identifiers (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL,
    id_type      TEXT NOT NULL DEFAULT 'VAT',
    id_code      TEXT NOT NULL DEFAULT '',
    country_iso2 TEXT NOT NULL DEFAULT '',
    label        TEXT NOT NULL DEFAULT '',
    is_primary   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS customer_screenings (
    id              TEXT PRIMARY KEY,
    customer_id     TEXT NOT NULL,
    screened_at     TEXT NOT NULL,
    result          TEXT NOT NULL,
    hits            TEXT DEFAULT '[]',
    overridden_at   TEXT,
    override_reason TEXT,
    UNIQUE(customer_id)
  )`,
  `CREATE TABLE IF NOT EXISTS customer_documents (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL,
    filename     TEXT NOT NULL,
    stored_name  TEXT NOT NULL,
    mime_type    TEXT NOT NULL DEFAULT '',
    size_bytes   INTEGER NOT NULL DEFAULT 0,
    doc_type     TEXT NOT NULL DEFAULT 'Other',
    uploaded_by  TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL
  )`,
  // Organization Model Enhancement Epic 1 (contacts + role-eligible pickers) — multiple named
  // people per customer, replacing the old "cram it into the notes field" workaround.
  `CREATE TABLE IF NOT EXISTS customer_contacts (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL,
    name         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    email        TEXT NOT NULL DEFAULT '',
    phone        TEXT NOT NULL DEFAULT '',
    department   TEXT NOT NULL DEFAULT 'Other',
    is_primary   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  )`,
  // Which of ALL_CUSTOMER_ROLES (below) this customer is eligible for — lets CustomerCombobox
  // filter pickers (e.g. only Bank-flagged customers when assigning the "Bank" shipment_parties
  // role) instead of every picker offering every customer regardless of fitness for the slot.
  `CREATE TABLE IF NOT EXISTS customer_roles (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL,
    role         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    UNIQUE(customer_id, role)
  )`,
  // seed security defaults (INSERT OR IGNORE so they only apply once)
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('login_max_attempts','5')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('login_lockout_minutes','30')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('jwt_lifetime_hours','8')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('password_expiry_days','90')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('sso_enabled','0')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('sso_tenant_id','')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('sso_client_id','')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('sso_client_secret','')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('sso_redirect_uri','')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('sso_default_role','operator')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('sso_frontend_url','http://localhost:5173')",
  // v0.43.0 — admin-defined Shipment Explorer sidebar order (see PUT /api/settings/shipment-sidebar-order,
  // routes/system.js). Empty array means "no override, use the built-in default order" — reconciled
  // client-side (ShipmentDetailSidebar, App.jsx) against whatever top-level nav ids actually exist today,
  // so a future new section added in code just appends itself rather than silently vanishing.
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('shipment_sidebar_order','[]')",
  // v0.25.0 — VAT on cost lines
  "ALTER TABLE shipment_cost_lines ADD COLUMN vat_rate REAL NOT NULL DEFAULT 0",
  // v0.26.0 — per-user finance access flag
  "ALTER TABLE users ADD COLUMN can_view_finance INTEGER NOT NULL DEFAULT 0",
  // v0.25.0 — Shipment-level schedule bookings
  `CREATE TABLE IF NOT EXISTS shipment_schedules (
    id            TEXT PRIMARY KEY,
    shipment_id   TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    carrier       TEXT DEFAULT '',
    vessel_name   TEXT DEFAULT '',
    voyage_number TEXT DEFAULT '',
    service       TEXT DEFAULT '',
    pol           TEXT DEFAULT '',
    pod           TEXT DEFAULT '',
    etd           TEXT DEFAULT '',
    eta           TEXT DEFAULT '',
    transit_days  INTEGER DEFAULT 0,
    is_mock       INTEGER DEFAULT 0,
    saved_at      TEXT NOT NULL,
    saved_by      TEXT NOT NULL DEFAULT ''
  )`,
  // v0.27.0 — Office-based login locations
  `CREATE TABLE IF NOT EXISTS offices (
    id           TEXT PRIMARY KEY,
    code         TEXT UNIQUE NOT NULL,
    country_code TEXT NOT NULL DEFAULT '',
    unlocode     TEXT NOT NULL DEFAULT '',
    department   TEXT NOT NULL DEFAULT 'SE',
    name         TEXT NOT NULL DEFAULT '',
    is_active    INTEGER DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS user_offices (
    id        TEXT PRIMARY KEY,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
    is_default INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, office_id)
  )`,
  // DEFAULT 1 so all rows that exist at migration time get global access (preserves current behaviour)
  "ALTER TABLE users     ADD COLUMN all_offices         INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE shipments ADD COLUMN emo_office_id        TEXT DEFAULT NULL",
  "ALTER TABLE shipments ADD COLUMN imo_office_id        TEXT DEFAULT NULL",
  "ALTER TABLE shipments ADD COLUMN controlling_office_id TEXT DEFAULT NULL",
  // Organisation hierarchy
  `CREATE TABLE IF NOT EXISTS branches (
    id          TEXT PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    country_code TEXT NOT NULL,
    city        TEXT,
    address     TEXT,
    timezone    TEXT,
    phone       TEXT,
    email       TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS org_countries (
    country_code      TEXT PRIMARY KEY,
    default_currency  TEXT,
    timezone          TEXT,
    branch_id         TEXT REFERENCES branches(id),
    compliance_notes  TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    added_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  "ALTER TABLE offices ADD COLUMN branch_id TEXT REFERENCES branches(id)",
  "ALTER TABLE branches ADD COLUMN locode TEXT",
  "ALTER TABLE port_locations ADD COLUMN timezone TEXT",
  // v0.28.0 — Project Board: multi-project support + structured versions
  `CREATE TABLE IF NOT EXISTS kb_projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    key         TEXT NOT NULL,
    color       TEXT DEFAULT '#6366f1',
    description TEXT DEFAULT '',
    created_at  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS kb_versions (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES kb_projects(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    status       TEXT DEFAULT 'Planning',
    release_date TEXT DEFAULT NULL,
    created_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS kb_columns (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES kb_projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    color      TEXT DEFAULT '#6366f1',
    wip_limit  INTEGER DEFAULT NULL,
    created_at TEXT NOT NULL
  )`,
  "ALTER TABLE tickets ADD COLUMN project_id TEXT DEFAULT NULL",
  "ALTER TABLE tickets ADD COLUMN version_id TEXT DEFAULT NULL",
  // vNext — test-case repository separation: Test Folder/Plan/Run/Case move out of
  // the shared tickets table into their own store (see backfillTestItems() below).
  `CREATE TABLE IF NOT EXISTS test_items (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT DEFAULT '',
    priority     TEXT DEFAULT 'Medium',
    status       TEXT DEFAULT 'Ready',
    position     INTEGER DEFAULT 0,
    created_at   TEXT NOT NULL,
    shipment_id  TEXT DEFAULT NULL,
    parent_id    TEXT DEFAULT NULL,
    assignee_id  TEXT DEFAULT NULL,
    due_date     TEXT DEFAULT NULL,
    test_notes   TEXT DEFAULT NULL,
    project_id   TEXT DEFAULT NULL,
    version_id   TEXT DEFAULT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS test_case_links (
    id         TEXT PRIMARY KEY,
    case_id    TEXT NOT NULL,
    ticket_id  TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  // vNext — EDI messaging: carrier booking requests/responses, stored per shipment.
  `CREATE TABLE IF NOT EXISTS edi_messages (
    id             TEXT PRIMARY KEY,
    shipment_id    TEXT NOT NULL,
    carrier_code   TEXT NOT NULL,
    direction      TEXT NOT NULL,
    message_type   TEXT NOT NULL,
    format         TEXT NOT NULL DEFAULT 'JSON',
    raw_payload    TEXT DEFAULT '',
    parsed_payload TEXT DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'pending',
    correlation_id TEXT DEFAULT '',
    is_mock        INTEGER DEFAULT 0,
    created_at     TEXT NOT NULL,
    processed_at   TEXT DEFAULT NULL
  )`,
  // vNext — FCL container-level lifecycle events (Empty Pickup, Gate In, Loaded, Sailed,
  // Discharged, Gate Out, Empty Return). Foundation for demurrage/detention tracking.
  `CREATE TABLE IF NOT EXISTS container_events (
    id           TEXT PRIMARY KEY,
    container_id TEXT NOT NULL,
    shipment_id  TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    location     TEXT DEFAULT '',
    occurred_at  TEXT NOT NULL,
    recorded_by  TEXT DEFAULT '',
    notes        TEXT DEFAULT '',
    created_at   TEXT NOT NULL
  )`,
  // Rate snapshots — frozen copies of contract_rates at the point they're committed to a
  // shipment, so a later "Reset to Contract" replays what was actually quoted rather than
  // silently picking up live carrier rate changes. See TKT-6QT30S.
  `CREATE TABLE IF NOT EXISTS shipment_rate_snapshots (
    id            TEXT PRIMARY KEY,
    shipment_id   TEXT NOT NULL,
    contract_id   TEXT NOT NULL,
    generated_at  TEXT NOT NULL,
    generated_by  TEXT DEFAULT '',
    reason        TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS shipment_rate_snapshot_lines (
    id             TEXT PRIMARY KEY,
    snapshot_id    TEXT NOT NULL,
    service_code   TEXT DEFAULT '',
    description    TEXT DEFAULT '',
    amount         REAL DEFAULT 0,
    currency       TEXT DEFAULT 'USD',
    amount_usd     REAL DEFAULT 0,
    unit           TEXT DEFAULT 'per_container',
    container_type TEXT DEFAULT '',
    notes          TEXT DEFAULT ''
  )`,
  "ALTER TABLE shipment_cost_lines ADD COLUMN rate_snapshot_id TEXT DEFAULT ''",
  // Per-container invoice support — a generated FR01/FR02 document can now be scoped to a
  // single container (container_id set) instead of the whole shipment (container_id empty).
  // responsible_party is a frozen snapshot of the shipment's Principal at generation time.
  "ALTER TABLE shipment_documents ADD COLUMN container_id      TEXT DEFAULT ''",
  "ALTER TABLE shipment_documents ADD COLUMN responsible_party TEXT DEFAULT ''",
  // Customer's main currency — used to resolve a single grand total on a generated invoice
  // when its charge lines span multiple currencies, instead of showing several totals.
  "ALTER TABLE customers ADD COLUMN currency TEXT DEFAULT 'USD'",
  // Organization Model Enhancement Epic 2 (Credit Control) — credit_limit/credit_terms_days
  // are nullable (null = no limit set, not "$0 limit"); credit_hold is a hard gate on
  // generating a NEW invoice for this customer (existing lines/documents stay fully visible
  // and editable — only the Generate action is blocked), independent of credit_limit.
  "ALTER TABLE customers ADD COLUMN credit_limit REAL DEFAULT NULL",
  "ALTER TABLE customers ADD COLUMN credit_terms_days INTEGER DEFAULT NULL",
  "ALTER TABLE customers ADD COLUMN credit_hold INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE customers ADD COLUMN credit_hold_reason TEXT DEFAULT ''",
  // Organization Model Enhancement Epic 4 (Customer Hierarchy) — self-referential, nullable
  // (no parent = a standalone customer, the default/common case). Unlike the shipment_schedules
  // rebuild elsewhere in this file, this doesn't need a table rebuild: it's a brand new nullable
  // column, not an existing NOT NULL one being loosened, so a plain ADD COLUMN with its own
  // REFERENCES clause is sufficient — foreign_keys=ON is set globally (top of this file), so
  // ON DELETE SET NULL is actually enforced, not just documentation.
  "ALTER TABLE customers ADD COLUMN parent_customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL",
  // Manual contract types (SPOT/Pending/Customer Own) — validity window, TKT-UONN72
  "ALTER TABLE shipments ADD COLUMN contract_valid_from TEXT DEFAULT NULL",
  "ALTER TABLE shipments ADD COLUMN contract_valid_to   TEXT DEFAULT NULL",
  // Loading Service dedicated page (Epic TKT-TBS7QD, Story TKT-TR6OBR) — one row per
  // container per service, the carrier's planned loading date reduced to structured
  // data. Keyed by (service_id, container_id) rather than a synthetic id since a
  // container only ever has one plan line per service.
  `CREATE TABLE IF NOT EXISTS shipment_loading_plan_lines (
    service_id     TEXT NOT NULL,
    container_id   TEXT NOT NULL,
    planned_date   TEXT DEFAULT '',
    sequence_order INTEGER DEFAULT 0,
    notes          TEXT DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT,
    PRIMARY KEY (service_id, container_id)
  )`,
  // Sequence has no "0th"/negative position in a physical Loading/Unloading/Pickup/Delivery
  // plan — 1 is the floor, enforced going forward in the PUT loading-plan route (routes/
  // shipment-ops.js). One-time backfill for the handful of rows already saved as 0 before
  // this rule existed — idempotent, a re-run after all rows are already >=1 is a no-op. Moved
  // here, right after this table's own CREATE TABLE, from its original spot much earlier in
  // this array (found via a genuinely fresh-database boot, v0.71.0's CI fix pass) — the
  // migrations array runs top-to-bottom in one pass, so on a brand-new database the original
  // position ran this UPDATE before the table existed at all ("no such table"), silently
  // logged as a startup migration failure (GET /api/health's migrations.failed) on every fresh
  // install/CI run ever since this table was introduced. Harmless in practice (nothing to
  // backfill on a fresh database anyway), but a real, now-fixed correctness gap.
  "UPDATE shipment_loading_plan_lines SET sequence_order = 1 WHERE sequence_order <= 0",
  // Merchant's Haulage details (Pickup/Delivery, Merchant's Haulage only) — one record per
  // container per service, mirroring shipment_loading_plan_lines' own per-container shape but
  // with a synthetic id (not a literal composite PK) since this table needs a clean single-
  // column FK target for waypoints below, and a clean value to store back as the reverse
  // pointer to whichever shipment_cost_lines row its own cost value creates.
  `CREATE TABLE IF NOT EXISTS shipment_haulage_records (
    id                 TEXT PRIMARY KEY,
    service_id         TEXT NOT NULL,
    container_id       TEXT NOT NULL,
    gate_in_at         TEXT DEFAULT '',
    gate_out_at        TEXT DEFAULT '',
    driver_name        TEXT DEFAULT '',
    driver_id_number   TEXT DEFAULT '',
    instructions       TEXT DEFAULT '',
    cost_amount        REAL DEFAULT NULL,
    cost_currency      TEXT DEFAULT 'USD',
    cost_exchange_rate REAL DEFAULT 1,
    cost_line_id       TEXT DEFAULT '',
    created_at         TEXT NOT NULL,
    updated_at         TEXT,
    UNIQUE(service_id, container_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_haulage_records_service ON shipment_haulage_records(service_id)",
  // Variable-length ordered waypoint list per haulage record — a real parent FK with cascade
  // delete (unlike shipment_loading_plan_lines.container_id, a waypoint has no meaning without
  // its parent record, exactly like contract_legs -> contracts). loc_type reuses the same
  // Door/Terminal/Container Yard/CFS/GPS Coordinates vocabulary shipment_legs' own endpoints
  // already use; latitude/longitude are only populated in GPS mode, same either/or rule.
  `CREATE TABLE IF NOT EXISTS shipment_haulage_waypoints (
    id                TEXT PRIMARY KEY,
    haulage_record_id TEXT NOT NULL REFERENCES shipment_haulage_records(id) ON DELETE CASCADE,
    sequence_order    INTEGER NOT NULL DEFAULT 1,
    loc_type          TEXT NOT NULL DEFAULT 'Door',
    location          TEXT DEFAULT '',
    latitude          REAL DEFAULT NULL,
    longitude         REAL DEFAULT NULL,
    notes             TEXT DEFAULT '',
    created_at        TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_haulage_waypoints_record ON shipment_haulage_waypoints(haulage_record_id)",
  // Automated charge-code registry (TKT-OK5H34) — admin-maintained definitions that get
  // auto-injected as SELL cost lines when their trigger fires. Only trigger today is
  // 'per_container_split' (fired from generateInvoices() when splitting an invoice per
  // container), but the column exists so more triggers can be added later without a
  // schema change.
  `CREATE TABLE IF NOT EXISTS charge_code_definitions (
    id         TEXT PRIMARY KEY,
    code       TEXT NOT NULL,
    label      TEXT NOT NULL,
    trigger    TEXT NOT NULL DEFAULT 'per_container_split',
    amount     REAL NOT NULL DEFAULT 0,
    currency   TEXT NOT NULL DEFAULT 'USD',
    unit       TEXT NOT NULL DEFAULT 'per_container',
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  // source='automated' — cost lines auto-injected by a charge-code-definition trigger,
  // distinct from 'manual'/'contract'/'mirror'. Column already exists (TEXT, no enum), this
  // is just documenting the new value it can hold.
  // Carrier Payment Indicator (CPI) — per cost-line, not per-shipment, since a shipment
  // can mix Prepaid and Collect charges (TKT-OZD4V8, decision confirmed with user).
  "ALTER TABLE shipment_cost_lines ADD COLUMN payment_indicator TEXT DEFAULT 'Prepaid'",
  // Container cargo manifest: pallet/box sub-level breakdown (TKT-EMFIBR). Self-referencing
  // so nesting depth is arbitrary (not a fixed Pallet->Box model, per the 2026-07-17 scoping
  // decision) — container_id is denormalized onto every row (not just roots) so the whole
  // tree for a container is one flat query; parent_id=NULL marks a top-level package.
  // Independent of containers.cargo_description/gross_weight_kg/volume_cbm, which remain
  // the source of truth elsewhere in the app — this is a supplementary detail view only.
  `CREATE TABLE IF NOT EXISTS container_packages (
    id           TEXT PRIMARY KEY,
    container_id TEXT NOT NULL,
    parent_id    TEXT DEFAULT NULL,
    description  TEXT NOT NULL,
    quantity     INTEGER NOT NULL DEFAULT 1,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  )`,
  // v0.34.5 — password expiry policy: track when each user's password was last set.
  // Backfilled to created_at (not "now") for existing rows, since we don't actually
  // know when an existing account's password was last changed — created_at is the
  // most recent point we CAN vouch for, so an old-enough account correctly shows as
  // already due rather than being given a fresh, unearned 90-day grace period.
  "ALTER TABLE users ADD COLUMN password_changed_at TEXT NOT NULL DEFAULT ''",
  "UPDATE users SET password_changed_at = created_at WHERE password_changed_at = ''",
  // Self-service forgot-password. Stores a SHA-256 hash of the reset token, never the raw
  // token itself — mirrors password_hash's own "never store the recoverable secret" rule. The
  // raw token only ever exists in the emailed link and the incoming request that redeems it.
  "ALTER TABLE users ADD COLUMN reset_token_hash    TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN reset_token_expires TEXT NOT NULL DEFAULT ''",
  `CREATE TABLE IF NOT EXISTS system_email_settings (
    id              TEXT PRIMARY KEY,
    smtp_host       TEXT NOT NULL DEFAULT '',
    smtp_port       INTEGER NOT NULL DEFAULT 587,
    secure_mode     TEXT NOT NULL DEFAULT 'starttls',
    smtp_username   TEXT NOT NULL DEFAULT '',
    smtp_password   TEXT NOT NULL DEFAULT '',
    from_address    TEXT NOT NULL DEFAULT '',
    from_name       TEXT NOT NULL DEFAULT '',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  )`,
  // v0.35.0 — Carrier Booking. One row per shipment, not a history table — edi_messages
  // already IS the full historical ledger of every request/response; this is a derived
  // "current state" projection over it (same relationship shipments.booking_ref already
  // has to the same data). status/last_response_status are tracked separately on purpose:
  // a confirmed carrier response must NOT auto-finalize the booking, so it only sets
  // last_response_status='confirmed' and leaves status='Pending' until the operator's own
  // Confirm action moves it to 'Confirmed' — a rejected response has nothing to lock in,
  // so it DOES auto-advance status straight to 'Rejected'.
  `CREATE TABLE IF NOT EXISTS carrier_bookings (
    id                   TEXT PRIMARY KEY,
    shipment_id          TEXT NOT NULL UNIQUE REFERENCES shipments(id) ON DELETE CASCADE,
    carrier_code         TEXT NOT NULL DEFAULT '',
    status               TEXT NOT NULL DEFAULT 'Pending',
    last_response_status TEXT NOT NULL DEFAULT '',
    booking_ref          TEXT DEFAULT '',
    correlation_id       TEXT DEFAULT '',
    is_mock              INTEGER DEFAULT 0,
    requested_at         TEXT DEFAULT NULL,
    requested_by         TEXT DEFAULT '',
    responded_at         TEXT DEFAULT NULL,
    confirmed_at         TEXT DEFAULT NULL,
    confirmed_by         TEXT DEFAULT '',
    cancelled_at         TEXT DEFAULT NULL,
    cancelled_by         TEXT DEFAULT '',
    cancel_reason        TEXT DEFAULT '',
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_carrier_bookings_status ON carrier_bookings(status)",

  // Booking-to-B/L traceability (TKT-LAK8P4) — nullable, points at a specific generated
  // document instance rather than the free-text shipments.bl_number: a shipment can have
  // multiple BL01 document rows (drafts, amendments) with no "current" flag, so a user has
  // to pick which one; nothing auto-links here.
  "ALTER TABLE carrier_bookings ADD COLUMN bl_document_id TEXT DEFAULT NULL REFERENCES shipment_documents(id)",

  // Archive for superseded booking attempts (found via a real bug report — SHP-Y9E98X:
  // carrier_bookings.shipment_id is UNIQUE, so a Cancelled/Rejected booking was the only
  // record for that shipment, permanently, even once the carrier/schedule genuinely moved
  // on). Same shape as carrier_bookings minus the uniqueness, plus archived_at/reason — an
  // archived row keeps its OWN original id (the surrogate key it already had), so a
  // shipment's full booking history is just carrier_bookings' current row + however many of
  // these. See ensureBookingCreated below for what actually triggers an archive.
  `CREATE TABLE IF NOT EXISTS carrier_booking_archive (
    id                   TEXT PRIMARY KEY,
    shipment_id          TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    carrier_code         TEXT NOT NULL DEFAULT '',
    status               TEXT NOT NULL DEFAULT 'Pending',
    last_response_status TEXT NOT NULL DEFAULT '',
    booking_ref          TEXT DEFAULT '',
    correlation_id       TEXT DEFAULT '',
    is_mock              INTEGER DEFAULT 0,
    requested_at         TEXT DEFAULT NULL,
    requested_by         TEXT DEFAULT '',
    responded_at         TEXT DEFAULT NULL,
    confirmed_at         TEXT DEFAULT NULL,
    confirmed_by         TEXT DEFAULT '',
    cancelled_at         TEXT DEFAULT NULL,
    cancelled_by         TEXT DEFAULT '',
    cancel_reason        TEXT DEFAULT '',
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    archived_at          TEXT NOT NULL,
    archived_reason      TEXT DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_carrier_booking_archive_shipment ON carrier_booking_archive(shipment_id)",

  // Sea-schedule field completeness (vessel IMO alongside the existing free-text vessel_name;
  // ATD/ATA actuals alongside the existing ETD/ETA estimates) + the shared-schedule catalog —
  // 'source' distinguishes a normal per-shipment search-and-save ('search', the default, so
  // every pre-existing row is unaffected) from one authored by the Test Tools Schedule
  // Generator ('generated'), which is the only kind additional shipments can link to.
  "ALTER TABLE shipment_schedules ADD COLUMN vessel_imo TEXT DEFAULT ''",
  "ALTER TABLE shipment_schedules ADD COLUMN atd        TEXT DEFAULT ''",
  "ALTER TABLE shipment_schedules ADD COLUMN ata        TEXT DEFAULT ''",
  "ALTER TABLE shipment_schedules ADD COLUMN source     TEXT DEFAULT 'search'",

  // Additive sharing layer: shipment_schedules.shipment_id keeps meaning "the shipment that
  // originally saved this row" (unchanged, every existing owned-schedule flow untouched) —
  // this table lets ADDITIONAL shipments link to that same schedule without duplicating it.
  `CREATE TABLE IF NOT EXISTS schedule_shipment_links (
    schedule_id  TEXT NOT NULL REFERENCES shipment_schedules(id) ON DELETE CASCADE,
    shipment_id  TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    linked_at    TEXT NOT NULL,
    linked_by    TEXT DEFAULT '',
    PRIMARY KEY (schedule_id, shipment_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_schedule_links_shipment ON schedule_shipment_links(shipment_id)",

  // Pack-type registry for the container cargo manifest tree (container_packages) — admin-
  // maintained, mirrors charge_code_definitions structurally. Nullable FK on the package
  // itself (below) means existing packages simply have no type/icon yet, not an error.
  `CREATE TABLE IF NOT EXISTS pack_type_definitions (
    id         TEXT PRIMARY KEY,
    code       TEXT NOT NULL,
    label      TEXT NOT NULL,
    icon       TEXT NOT NULL DEFAULT '📦',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  "INSERT OR IGNORE INTO pack_type_definitions (id,code,label,icon,sort_order,is_active,created_at) VALUES ('ptd-pallet','PALLET','Pallet','🟫',10,1,datetime('now'))",
  "INSERT OR IGNORE INTO pack_type_definitions (id,code,label,icon,sort_order,is_active,created_at) VALUES ('ptd-carton','CARTON','Carton','📦',20,1,datetime('now'))",
  "INSERT OR IGNORE INTO pack_type_definitions (id,code,label,icon,sort_order,is_active,created_at) VALUES ('ptd-case','CASE','Case','🗄️',30,1,datetime('now'))",
  "INSERT OR IGNORE INTO pack_type_definitions (id,code,label,icon,sort_order,is_active,created_at) VALUES ('ptd-crate','CRATE','Crate','🪵',40,1,datetime('now'))",
  "INSERT OR IGNORE INTO pack_type_definitions (id,code,label,icon,sort_order,is_active,created_at) VALUES ('ptd-drum','DRUM','Drum','🛢️',50,1,datetime('now'))",
  "INSERT OR IGNORE INTO pack_type_definitions (id,code,label,icon,sort_order,is_active,created_at) VALUES ('ptd-box','BOX','Box','📦',60,1,datetime('now'))",
  "INSERT OR IGNORE INTO pack_type_definitions (id,code,label,icon,sort_order,is_active,created_at) VALUES ('ptd-bag','BAG','Bag','🛍️',70,1,datetime('now'))",
  "INSERT OR IGNORE INTO pack_type_definitions (id,code,label,icon,sort_order,is_active,created_at) VALUES ('ptd-bundle','BUNDLE','Bundle','🎋',80,1,datetime('now'))",
  "INSERT OR IGNORE INTO pack_type_definitions (id,code,label,icon,sort_order,is_active,created_at) VALUES ('ptd-other','OTHER','Other','📄',90,1,datetime('now'))",
  "ALTER TABLE container_packages ADD COLUMN pack_type_id TEXT DEFAULT NULL",

  // Container-type registry (Equipment section) — admin-maintained, same shape/role
  // pack_type_definitions has for pack types. Seeded from the app's own long-standing hardcoded
  // CONTAINER_OPTIONS list (src/tokens.js) so nothing currently reading that list changes
  // behavior; this table is purely additive reference data for now, not yet the live source
  // any existing container-type dropdown reads from.
  `CREATE TABLE IF NOT EXISTS container_type_definitions (
    id          TEXT PRIMARY KEY,
    code        TEXT NOT NULL,
    size        TEXT NOT NULL,
    type        TEXT NOT NULL,
    teu         INTEGER NOT NULL DEFAULT 1,
    label       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  )`,
  "INSERT OR IGNORE INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ('ctd-20dc','20DC','20','DC',1,'20ft Dry Container','Standard dry cargo — general goods, non-temperature-sensitive',10,1,datetime('now'))",
  "INSERT OR IGNORE INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ('ctd-40dc','40DC','40','DC',2,'40ft Dry Container','Standard dry cargo — general goods, non-temperature-sensitive',20,1,datetime('now'))",
  "INSERT OR IGNORE INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ('ctd-40hc','40HC','40','HC',2,'40ft High Cube','Extra interior height (9''6\") for voluminous or tall cargo',30,1,datetime('now'))",
  "INSERT OR IGNORE INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ('ctd-20rf','20RF','20','RF',1,'20ft Reefer','Temperature-controlled — food, pharma, cold-chain cargo',40,1,datetime('now'))",
  "INSERT OR IGNORE INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ('ctd-40rf','40RF','40','RF',2,'40ft Reefer','Temperature-controlled — food, pharma, cold-chain cargo',50,1,datetime('now'))",
  "INSERT OR IGNORE INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ('ctd-20ot','20OT','20','OT',1,'20ft Open Top','Removable roof — machinery, lumber, crane-loaded cargo',60,1,datetime('now'))",
  "INSERT OR IGNORE INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ('ctd-40ot','40OT','40','OT',2,'40ft Open Top','Removable roof — machinery, lumber, crane-loaded cargo',70,1,datetime('now'))",
  "INSERT OR IGNORE INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ('ctd-20fr','20FR','20','FR',1,'20ft Flat Rack','Collapsible ends — heavy machinery, vehicles, oversized loads',80,1,datetime('now'))",
  "INSERT OR IGNORE INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ('ctd-40fr','40FR','40','FR',2,'40ft Flat Rack','Collapsible ends — heavy machinery, vehicles, oversized loads',90,1,datetime('now'))",
  "INSERT OR IGNORE INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ('ctd-20tk','20TK','20','TK',1,'20ft Tank','Liquid bulk — chemicals, food-grade liquids, petroleum products',100,1,datetime('now'))",
  "INSERT OR IGNORE INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ('ctd-40tk','40TK','40','TK',2,'40ft Tank','Liquid bulk — chemicals, food-grade liquids, petroleum products',110,1,datetime('now'))",

  // Cargo Manifest & Container Details Redesign (TKT-OTKNJN). Marks & Nos. is a real
  // packing-list/BOL field that never existed on containers — Description of Goods is NOT
  // a new field, it's the existing container_packages.description shown as a rollup on the
  // container's own detail view (see ShipmentContainersPage.jsx).
  "ALTER TABLE containers ADD COLUMN marks_and_numbers TEXT DEFAULT ''",
  // DG classification extends down from the container level (containers.is_dg/dg_class,
  // already existed) to the individual pallet/item level (TKT-9VAD6R) — a single DG pallet
  // inside an otherwise clean container no longer forces the whole container to be flagged.
  "ALTER TABLE container_packages ADD COLUMN is_dg INTEGER DEFAULT 0",
  "ALTER TABLE container_packages ADD COLUMN dg_class TEXT DEFAULT ''",
  // DG Compliance Address (TKT-DPLQTV) — one reusable org-wide emergency-contact/compliance
  // record (confirmed: FCL means one is enough, no per-office variant), pulled onto the DG01
  // declaration's emergency-contact line (buildDGDeclHtml, App.jsx) instead of a hand-filled
  // blank. Plain app_settings keys, same idiom as every other single-record setting.
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('dg_compliance_contact_name','')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('dg_compliance_phone','')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('dg_compliance_email','')",
  "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('dg_compliance_address','')",

  // Additional Parties (Epic TKT-5XFCAP, Story TKT-HG10IK) — generic, extensible party-role
  // mechanism sitting ALONGSIDE the 4 fixed shipper/consignee/notify/principal columns on
  // shipments (untouched — high blast radius, not broken, not in scope). role is drawn from
  // a fixed, curated list (ADDITIONAL_PARTY_ROLES below), not free text, so the frontend can
  // render a clean "roles not yet assigned" picker. customer_id/customer_name are plain
  // denormalized columns with no FK to customers, matching shipments.shipper_id/shipper_name's
  // own existing convention. UNIQUE(shipment_id, role): one active party per role per shipment.
  `CREATE TABLE IF NOT EXISTS shipment_parties (
    id            TEXT PRIMARY KEY,
    shipment_id   TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    role          TEXT NOT NULL,
    customer_id   TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE(shipment_id, role)
  )`,

  // Additional (backup) offices per side, Involved Offices redesign follow-up — direct request:
  // a shipment's EMO/IMO are exactly-one fixed columns, but a real disaster-recovery scenario
  // needs MORE than one office able to hold Export (or Import) work at once. Side-tagged (not
  // pooled like Controlling) so an added office shows as its own home-style group in that
  // column immediately, even before anything is assigned to it — see OfficeColumn in
  // ShipmentDetailPage.jsx. office_id is intentionally NOT constrained to the EMO/IMO
  // department at the schema level (enforced in routes/shipments.js instead, same
  // enforce-in-route-not-in-schema precedent shipment_parties' role list already uses).
  `CREATE TABLE IF NOT EXISTS shipment_side_offices (
    id          TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    side        TEXT NOT NULL,
    office_id   TEXT NOT NULL,
    added_at    TEXT NOT NULL,
    added_by    TEXT NOT NULL DEFAULT '',
    UNIQUE(shipment_id, side, office_id)
  )`,

  // Structured Cargo / Commodity Line Items (Epic TKT-P3ASH1, Story TKT-PV5P5L) — extends
  // container_packages with a real per-item declared value, replacing the container-level
  // hs_code/cargo_description as the sole source for Commercial Invoice / Packing List line
  // items and the cargo value rollup (TKT-NSTDKF). unit_value stays NULL (not 0) when nothing
  // has been entered — "$0" and "not priced yet" are different facts the rollup/document
  // fallback must be able to tell apart. hs_code is a per-item OVERRIDE of the container's own
  // hs_code (untouched) — blank means "inherit the container's code". unit_value_usd is
  // precomputed at write time (same amount_usd-at-write-time idiom as contract_rates,
  // saveRates/toUsd) so the rollup and generated documents never need a live FX call.
  "ALTER TABLE container_packages ADD COLUMN unit_value REAL DEFAULT NULL",
  "ALTER TABLE container_packages ADD COLUMN currency TEXT DEFAULT ''",
  "ALTER TABLE container_packages ADD COLUMN hs_code TEXT DEFAULT ''",
  "ALTER TABLE container_packages ADD COLUMN unit_value_usd REAL DEFAULT NULL",

  // Customs & Regulatory Filing (Epic TKT-XW6TQK, Story TKT-QRNGK9) — mirrors carrier_bookings'
  // shape closely, minus its archive/supersede machinery (not needed here: a shipment needs at
  // most one AES/EEI export filing and one ISF/AMS import filing, two independent things that
  // coexist rather than something a carrier change "supersedes"). UNIQUE(shipment_id,
  // filing_type), not UNIQUE(shipment_id) alone, is what lets both types coexist as independent
  // rows. SIMULATED/MOCK ONLY — no real government EDI integration, matching the carrier-booking
  // Test Tools precedent (direct scope decision, not revisited here).
  `CREATE TABLE IF NOT EXISTS customs_filings (
    id                   TEXT PRIMARY KEY,
    shipment_id          TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    filing_type          TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'Draft',
    filing_reference     TEXT DEFAULT '',
    confirmation_number  TEXT DEFAULT '',
    rejection_reason     TEXT DEFAULT '',
    filed_at             TEXT DEFAULT NULL,
    filed_by             TEXT DEFAULT '',
    responded_at         TEXT DEFAULT NULL,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    UNIQUE(shipment_id, filing_type)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_customs_filings_status ON customs_filings(status)",

  // Carrier Line Agents (CargoWise-baseline gap: a carrier's LOCAL representative differs by
  // location — Maersk's Rotterdam agent isn't its New York agent — distinct from a Forwarder's
  // own overseas correspondent network, which this doesn't model). carrier_code stays loose
  // text, matching shipments/contracts/allocations' own carrier_code convention everywhere else
  // (never FK'd to `carriers`). agent_customer_id is a real FK to customers(id) with NO ON
  // DELETE clause (neither CASCADE — which would let a customer delete silently destroy master
  // data — nor SET NULL, which would leave a meaningless NOT NULL-in-spirit row with nothing
  // left to point at); customer delete is instead blocked by an app-level guard, mirroring
  // offices.js's own "referenced by shipments — deactivate it instead" pattern. No denormalized
  // agent_customer_name column — this is live master data, not a shipment-time snapshot, so
  // reads always join to customers for the current name (same idiom CUST_JOIN already uses for
  // parent_customer_name).
  //
  // Header + child-locations shape (restructured from an earlier one-row-per-port design, see
  // the guarded rebuildCarrierAgentsLocations migration below): one (carrier, agent) pairing is
  // a single header row here, which can then cover any number of specific UN/LOCODEs and/or
  // whole countries via carrier_agent_locations — "a Line Agent in Spain can also handle the
  // shipment in Andorra" is one header with two country-level location rows, not two headers.
  `CREATE TABLE IF NOT EXISTS carrier_agents (
    id                 TEXT PRIMARY KEY,
    carrier_code       TEXT NOT NULL,
    agent_customer_id  TEXT NOT NULL REFERENCES customers(id),
    note               TEXT DEFAULT '',
    capabilities       TEXT DEFAULT '[]',
    created_at         TEXT NOT NULL,
    UNIQUE(carrier_code, agent_customer_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_carrier_agents_customer ON carrier_agents(agent_customer_id)",
  // Additive for any DB whose carrier_agents predates this column (every DB that already went
  // through the header+locations restructure above) — a JSON array of capability codes (e.g.
  // ["warehousing","road_haulage"]), same "flat flag-set as JSON on the row" idiom contracts.
  // imdg_classes already uses. Lets a shipment cross-check a Line Agent's own operational
  // capabilities against what a leg's haulage actually needs before booking, instead of finding
  // out only after the carrier rejects it or an operator has to rework the booking.
  "ALTER TABLE carrier_agents ADD COLUMN capabilities TEXT DEFAULT '[]'",

  // One row per covered location under a carrier_agents header — either a specific UN/LOCODE or
  // a whole country, never both on the same row (enforced by the CHECK + app-level validation).
  // carrier_code is denormalized from the header on purpose: the "this location is already
  // claimed for this carrier" uniqueness rule (enforced in routes/mdm.js, not a DB constraint,
  // since it must look ACROSS every header for the same carrier, not just within one) needs to
  // query by carrier_code without an extra join, mirroring TRACKED_FIELDS-style denormalization
  // used elsewhere in this codebase purely for query convenience.
  `CREATE TABLE IF NOT EXISTS carrier_agent_locations (
    id                TEXT PRIMARY KEY,
    carrier_agent_id  TEXT NOT NULL REFERENCES carrier_agents(id) ON DELETE CASCADE,
    carrier_code      TEXT NOT NULL,
    location_type     TEXT NOT NULL CHECK(location_type IN ('unlocode','country')),
    unlocode          TEXT REFERENCES port_locations(unlocode),
    country_iso2      TEXT REFERENCES countries(iso2),
    created_at        TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cal_agent ON carrier_agent_locations(carrier_agent_id)",
  "CREATE INDEX IF NOT EXISTS idx_cal_carrier_unlocode ON carrier_agent_locations(carrier_code, unlocode)",
  "CREATE INDEX IF NOT EXISTS idx_cal_carrier_country ON carrier_agent_locations(carrier_code, country_iso2)",

  // One row per day-group + hour-range a Line Agent is reachable — e.g. "Mon,Tue 09:00-18:00" is
  // one row, "Wed,Fri 09:00-13:00" a second, so an agent's real working pattern (different hours
  // on different days) is captured directly rather than forcing one hour range across every open
  // day. days is a JSON array of the 3-letter labels (["Mon","Tue"]) — always saved as a full
  // replace of every row for a header (PUT .../schedule), not incrementally, since the "a day can
  // only belong to one row" rule is naturally enforced by validating the whole proposed set at
  // once rather than reconciling against whatever was already saved.
  `CREATE TABLE IF NOT EXISTS carrier_agent_schedule_rows (
    id                TEXT PRIMARY KEY,
    carrier_agent_id  TEXT NOT NULL REFERENCES carrier_agents(id) ON DELETE CASCADE,
    days              TEXT NOT NULL,
    start_time        TEXT NOT NULL,
    end_time          TEXT NOT NULL,
    sort_order        INTEGER DEFAULT 0,
    created_at        TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_casr_agent ON carrier_agent_schedule_rows(carrier_agent_id)",

  // Shipment edit-locking (first-come-first-served, whole-shipment) — direct request: two
  // edit-capable users on the same shipment at the same time can produce conflicting writes,
  // and this app has no field-level merge/conflict resolution anywhere. One row per currently-
  // locked shipment; a heartbeat (POST .../edit-lock, called on open and renewed periodically
  // while the shipment stays open) keeps expires_at rolling forward, so a crashed tab/lost
  // connection self-clears the lock rather than needing a manual override.
  `CREATE TABLE IF NOT EXISTS shipment_edit_locks (
    shipment_id       TEXT PRIMARY KEY REFERENCES shipments(id) ON DELETE CASCADE,
    locked_by_id      TEXT NOT NULL,
    locked_by_name    TEXT NOT NULL,
    locked_at         TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    expires_at        TEXT NOT NULL
  )`,

  // Signed PDF Document Generation (Epic TKT-YOFYFZ) — deliberately its own table rather
  // than an app_settings row: GET /api/settings already returns the whole app_settings
  // table in plaintext to any authenticated user (it's how ai_api_key leaks today), and the
  // signing private key must never be reachable that way. Only one row is ever 'active' at
  // a time; rotating in a new cert flips the old row to 'superseded' instead of deleting it,
  // so documents signed under a retired cert stay independently self-verifying.
  `CREATE TABLE IF NOT EXISTS org_signing_certs (
    id                  TEXT PRIMARY KEY,
    cert_pem            TEXT NOT NULL,
    private_key_pem     TEXT NOT NULL,
    p12_base64          TEXT NOT NULL,
    p12_passphrase      TEXT NOT NULL,
    fingerprint_sha256  TEXT NOT NULL,
    subject             TEXT NOT NULL,
    not_before          TEXT NOT NULL,
    not_after           TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active',
    created_at          TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_org_signing_certs_status ON org_signing_certs(status)",

  // Office-Level Email Distribution (Epic TKT-O4B0IB) — per-office outgoing SMTP config, not
  // org-wide app_settings: different EMO/IMO offices (e.g. different countries) need separate
  // mail servers/from-addresses. UNIQUE(office_id) — one config per office, upsert on save.
  // smtp_password mirrors org_signing_certs' secret-column precedent: stored plaintext, but
  // NO mapper or route ever returns it — GET /api/settings's existing plaintext app_settings
  // leak (any authenticated user, no role gate) is exactly the mistake this avoids.
  `CREATE TABLE IF NOT EXISTS office_mail_settings (
    id              TEXT PRIMARY KEY,
    office_id       TEXT NOT NULL UNIQUE REFERENCES offices(id) ON DELETE CASCADE,
    smtp_host       TEXT NOT NULL DEFAULT '',
    smtp_port       INTEGER NOT NULL DEFAULT 587,
    secure_mode     TEXT NOT NULL DEFAULT 'starttls',
    smtp_username   TEXT NOT NULL DEFAULT '',
    smtp_password   TEXT NOT NULL DEFAULT '',
    from_address    TEXT NOT NULL DEFAULT '',
    from_name       TEXT NOT NULL DEFAULT '',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  )`,

  // Invoice Reversal / Debit-Credit Note workflow (TKT-DUADU3), SELL-side only — reversing a
  // confirmed FR01/FR02 invoice creates a new CN01 doc and voids the original; related_doc_id
  // links the two symmetrically (set on both rows once the CN01 doc exists). source_cost_line_ids
  // (JSON array) is captured at FR01/FR02 generation time so a later reversal knows exactly which
  // cost lines to negate rather than re-deriving from whatever SELL lines currently exist — a
  // doc with no value here (generated before this shipped) falls back to a live container-scoped
  // filter instead, no backfill needed.
  "ALTER TABLE shipment_documents ADD COLUMN related_doc_id       TEXT DEFAULT NULL",
  "ALTER TABLE shipment_documents ADD COLUMN source_cost_line_ids TEXT DEFAULT NULL",

  // Decoupled Schedule Generator / catalog-backed sailing search — Test Tools' Schedule
  // Generator no longer forces a shipment link at creation time (shipment_schedules.shipment_id
  // nullability is handled by a one-time table-rebuild migration below, since SQLite can't drop
  // NOT NULL via ALTER TABLE). A generated schedule can now be a genuine multi-leg/TSP sailing —
  // schedule_legs mirrors the existing shipment_legs/contract_legs multi-leg pattern (one row =
  // direct sailing, 2+ rows = TSP), while the parent shipment_schedules row keeps summarizing the
  // overall journey (first leg's pol/vessel/etd, last leg's pod/eta) so every existing consumer
  // of mapSchedule() keeps working unchanged.
  `CREATE TABLE IF NOT EXISTS schedule_legs (
    id             TEXT PRIMARY KEY,
    schedule_id    TEXT NOT NULL REFERENCES shipment_schedules(id) ON DELETE CASCADE,
    leg_order      INTEGER NOT NULL DEFAULT 0,
    pol            TEXT DEFAULT '',
    pod            TEXT DEFAULT '',
    etd            TEXT DEFAULT '',
    eta            TEXT DEFAULT '',
    vessel_name    TEXT DEFAULT '',
    vessel_imo     TEXT DEFAULT '',
    voyage_number  TEXT DEFAULT '',
    service        TEXT DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_schedule_legs_schedule ON schedule_legs(schedule_id)",
  "ALTER TABLE schedule_legs ADD COLUMN carrier TEXT DEFAULT ''",

  // Content-Keyed Sailing Legs — schedule_legs (above) gives every schedule its OWN fresh leg
  // rows with zero dedup, even when two schedules describe the exact same physical dated sailing
  // segment (same carrier/vessel/voyage/route/date). sailing_legs is the canonical, deduplicated
  // catalog instead: one row per distinct leg, keyed by a deterministic content key (computeLegKey,
  // routes/shipment-ops.js) over carrier+vesselImo+voyageNumber+pol+pod+etd — those 6 fields ARE
  // the identity, so they never change in place; eta/vesselName/service are descriptive and CAN be
  // revised later (a live carrier feed, a re-run generator) via upsertLeg's real upsert-with-audit
  // (diffs old vs new, logs one entity_events('sailing_leg', ...) row per changed field — same
  // idiom the schedule PUT route already uses). schedule_leg_refs is the ordered composition: which
  // legs make up a schedule, in what order — every schedule now has 1+ refs (a "direct" sailing is
  // just a schedule with exactly one ref), removing the old 0-1-rows-means-direct special case.
  `CREATE TABLE IF NOT EXISTS sailing_legs (
    leg_key        TEXT PRIMARY KEY,
    carrier        TEXT DEFAULT '',
    pol            TEXT DEFAULT '',
    pod            TEXT DEFAULT '',
    etd            TEXT DEFAULT '',
    eta            TEXT DEFAULT '',
    vessel_name    TEXT DEFAULT '',
    vessel_imo     TEXT DEFAULT '',
    voyage_number  TEXT DEFAULT '',
    service        TEXT DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS schedule_leg_refs (
    schedule_id  TEXT NOT NULL REFERENCES shipment_schedules(id) ON DELETE CASCADE,
    leg_key      TEXT NOT NULL REFERENCES sailing_legs(leg_key),
    leg_order    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (schedule_id, leg_order)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_schedule_leg_refs_leg ON schedule_leg_refs(leg_key)",
  // schedule_key: the ordered concatenation of this schedule's leg_keys — lets two independently
  // -created schedule rows be recognized as literally the same sailing via string equality, without
  // comparing individual leg rows. Written once at create time (Generator + Add Sailing), same
  // write-time idiom as the existing pol/pod/vessel summary fields below.
  "ALTER TABLE shipment_schedules ADD COLUMN schedule_key TEXT DEFAULT ''",

  // Gates the synthetic "DEMO ..." mockSailings() fallback in GET /api/schedules/search — default
  // on, so sailing search/tests keep working with zero setup; an admin turns it off once real
  // generated schedules exist in the catalog and synthetic fallback data is no longer wanted.
  "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('demo_schedules_enabled', 'true')",
  // AIS integration (TKT-ZFO2OM) — mmsi is the structural link a PositionReport (MMSI-only, no
  // IMO) needs to resolve back to a vessel; ais_verified_at distinguishes an MDM-imported row
  // from one AIS has actually confirmed live.
  "ALTER TABLE vessels ADD COLUMN mmsi TEXT DEFAULT ''",
  "ALTER TABLE vessels ADD COLUMN ais_verified_at TEXT DEFAULT ''",
  // First design pass tracked actual departure/arrival as separate atd/ata columns alongside
  // etd/eta — reworked per direct feedback: ETD/ETA should update in place once AIS confirms
  // a real departure/arrival (an estimate becoming a known fact), not sit next to a second,
  // always-visible pair of columns. atd/ata/atd_source/ata_source are left in place, unused
  // going forward — same "no migration, old rows/columns are just inert" precedent used
  // throughout this codebase — etd_source/eta_source are the ones actually read/written now.
  "ALTER TABLE shipment_legs ADD COLUMN atd TEXT DEFAULT ''",
  "ALTER TABLE shipment_legs ADD COLUMN ata TEXT DEFAULT ''",
  "ALTER TABLE shipment_legs ADD COLUMN atd_source TEXT DEFAULT ''",
  "ALTER TABLE shipment_legs ADD COLUMN ata_source TEXT DEFAULT ''",
  "ALTER TABLE shipment_legs ADD COLUMN etd_source TEXT DEFAULT ''",
  "ALTER TABLE shipment_legs ADD COLUMN eta_source TEXT DEFAULT ''",
  // Persistent-connection feature, defaults OFF (unlike fx/weather/ofac, which no-op cleanly
  // with no key) — an unconfigured AIS listener would otherwise try to open a socket on every
  // boot and fail its auth handshake for nothing. Provider seam exists now; only 'aisstream' is
  // wired to an actual connection this pass (see lib/ais-listener.js).
  "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('api_ais_enabled', 'false')",
  "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('ais_provider', 'aisstream')",
  "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('ais_api_key', '')",
  // Classified-location customers — a site (military/government/restricted) that can only ever
  // be identified by GPS coordinates, never a normal address or port/UN-LOCODE lookup. DEFAULT
  // NULL (not port_locations' own DEFAULT 0) — 0,0 is a real ocean coordinate, so NULL is the
  // only way to mean "unset."
  "ALTER TABLE customers ADD COLUMN classified_location INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE customers ADD COLUMN latitude  REAL DEFAULT NULL",
  "ALTER TABLE customers ADD COLUMN longitude REAL DEFAULT NULL",
  // A Pick-up/Delivery leg to a classified-location site — pol_loc_type/pod_loc_type gains a
  // "GPS Coordinates" value (alongside Door/Terminal/Container Yard/CFS) instead of a parallel
  // mode column, since it's already the "what kind of location is this endpoint" field. When set,
  // pol/pod (the UN/LOCODE) is blanked and these carry the real location instead — never both.
  "ALTER TABLE shipment_legs ADD COLUMN pol_latitude  REAL DEFAULT NULL",
  "ALTER TABLE shipment_legs ADD COLUMN pol_longitude REAL DEFAULT NULL",
  "ALTER TABLE shipment_legs ADD COLUMN pod_latitude  REAL DEFAULT NULL",
  "ALTER TABLE shipment_legs ADD COLUMN pod_longitude REAL DEFAULT NULL",
  // Rate-line-level validity window — previously only the whole contract had valid_from/valid_to,
  // so a single line (e.g. a GRI or PSS surcharge effective for only part of the contract's own
  // term) couldn't carry its own effective window. Blank on both ends (the default for every
  // existing row) means "inherits the parent contract's own window" — a pure additive column,
  // no backfill needed since blank already means exactly that everywhere it's read.
  "ALTER TABLE contract_rates ADD COLUMN valid_from TEXT DEFAULT ''",
  "ALTER TABLE contract_rates ADD COLUMN valid_to   TEXT DEFAULT ''",
  // Minimum Quantity Commitment — allocations were ceiling-only (alertThreshold warns on going
  // OVER allocatedTEU); there was no floor/under-commitment signal at all. NULL (not 0) means
  // "no MQC set" — a real $0 minimum isn't a thing, so NULL/blank stays distinguishable from an
  // explicit, deliberately-zero commitment.
  "ALTER TABLE allocations ADD COLUMN minimum_teu INTEGER DEFAULT NULL",
  // Ops-automation sweep (runOpsAutomationSweep, below) — lets an auto-created ticket record
  // exactly which stuck-booking/overdue-milestone/compliance-hit row it came from, so the sweep
  // can check "does a ticket already exist for this exact source" and never create a duplicate
  // on its next run. NULL/NULL on every ticket created through the normal UI, same as every other
  // additive nullable column in this codebase.
  "ALTER TABLE tickets ADD COLUMN source_type TEXT DEFAULT NULL",
  "ALTER TABLE tickets ADD COLUMN source_id   TEXT DEFAULT NULL",
  "CREATE INDEX IF NOT EXISTS idx_tickets_source ON tickets(source_type, source_id)",
  // Multiple routing options per contract (e.g. HLCU/Kuehne+Nagel CNCKG->SEGOT priced
  // independently via CNSHA->NLRTM, via CNSHA->DEHAM, via CNSHA->Wilhelmshaven) — a routing is a
  // named, ordered bundle of contract_legs rows with its own optional contract_rates rows.
  // routing_id='' (the column default, not NULL — matches this codebase's existing
  // named_account_id/contract_ref "unset means blank string" convention) means "the contract's
  // single implicit routing" on both contract_legs and contract_rates — every leg/rate on every
  // contract that predates this feature, unaffected, zero backfill needed. On contract_rates,
  // '' additionally means "applies regardless of which routing was matched" (e.g. a flat
  // documentation fee) — coexists freely with routing-specific rate rows on the same contract.
  `CREATE TABLE IF NOT EXISTS contract_routings (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    name TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    transit_days INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  "ALTER TABLE contract_legs ADD COLUMN routing_id TEXT DEFAULT ''",
  "ALTER TABLE contract_rates ADD COLUMN routing_id TEXT DEFAULT ''",
  // Which routing the operator actually picked when assigning this contract to the shipment.
  // '' means "single implicit routing" (or not yet recorded, for shipments that predate this
  // feature) — importContractRates/createRateSnapshot fall back to "match every rate on the
  // contract" in that case, identical to today's behavior.
  "ALTER TABLE shipments ADD COLUMN contract_routing_id TEXT DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_contract_routings_contract ON contract_routings(contract_id)",
  // Freight Audit & Payment — reconciles a carrier's own submitted invoice against what was
  // actually CONTRACTED (contract_rates) and/or already accrued (shipment_cost_lines), flagging
  // variance beyond a configurable tolerance rather than trusting the carrier's number at face
  // value. Deliberately distinct from the existing accrued->actualized->posted state machine on
  // shipment_cost_lines — that machine tracks CargoDesk's OWN cost estimate maturing into a real
  // figure over time; this validates an EXTERNAL document against what was agreed. amount_usd/
  // expected_amount_usd are resolved at write time (same idiom as contract_rates.amount_usd),
  // not recomputed live, so a later FX-rate change never silently reopens an already-reviewed line.
  `CREATE TABLE IF NOT EXISTS carrier_invoices (
    id TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    carrier_code TEXT DEFAULT '',
    invoice_number TEXT DEFAULT '',
    invoice_date TEXT DEFAULT '',
    currency TEXT DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'Pending',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    created_by TEXT DEFAULT ''
  )`,
  // free_time_side ('' | 'origin' | 'destination') only applies to a Detention/Demurrage line
  // (service_code DET/DEM) tied to a specific container — it tells the matching engine which of
  // the container's two independent free-time windows (containers.origin_free_time_days/
  // dest_free_time_days, already tracked for the compliance badges on the Cargo page) this charge
  // is actually for; the carrier's own invoice tells the person entering it which side applies,
  // so this is operator-supplied, not inferred. expected_source records HOW expected_amount was
  // resolved ('cost_line' | 'contract_rate' | 'dnd_calc' | '' when no comparison was possible)
  // so the UI can show its provenance rather than a bare number.
  `CREATE TABLE IF NOT EXISTS carrier_invoice_lines (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES carrier_invoices(id) ON DELETE CASCADE,
    service_code TEXT DEFAULT '',
    description TEXT DEFAULT '',
    container_id TEXT DEFAULT '',
    free_time_side TEXT DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    amount_usd REAL DEFAULT 0,
    expected_amount REAL DEFAULT NULL,
    expected_currency TEXT DEFAULT 'USD',
    expected_amount_usd REAL DEFAULT NULL,
    expected_source TEXT DEFAULT '',
    matched_cost_line_id TEXT DEFAULT '',
    variance_usd REAL DEFAULT NULL,
    variance_pct REAL DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    resolved_at TEXT DEFAULT NULL,
    resolved_by TEXT DEFAULT '',
    resolution_notes TEXT DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_carrier_invoices_shipment ON carrier_invoices(shipment_id)",
  "CREATE INDEX IF NOT EXISTS idx_carrier_invoice_lines_invoice ON carrier_invoice_lines(invoice_id)",
  // CRM / pre-sales pipeline (TKT-WW8THL, Epic TKT-GTGM6R) — precedes and converts into a quote,
  // the same way a quote precedes and converts into a shipment. Lifecycle: New -> Qualified ->
  // Converted (to Quote, Qualified only) | Lost (from New or Qualified). Deliberately no line-item
  // child table — an opportunity is pre-pricing; real line-item detail belongs on the Quote it
  // converts into. estimated_value_usd is resolved once via toUsd() at write time, same idiom as
  // quote_lines.amount_usd/contract_rates.amount_usd.
  `CREATE TABLE IF NOT EXISTS opportunities (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'New',
    title TEXT DEFAULT '',
    customer_id TEXT DEFAULT '',
    customer_name TEXT DEFAULT '',
    pol TEXT DEFAULT '',
    pod TEXT DEFAULT '',
    carrier_code TEXT DEFAULT '',
    commodity_code TEXT DEFAULT '',
    movement_type TEXT DEFAULT 'FCL',
    estimated_value REAL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    estimated_value_usd REAL DEFAULT 0,
    estimated_close_date TEXT DEFAULT '',
    lead_source TEXT DEFAULT '',
    assignee_id TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    qualified_at TEXT DEFAULT '',
    lost_at TEXT DEFAULT '',
    lost_reason TEXT DEFAULT '',
    converted_quote_id TEXT DEFAULT '',
    converted_at TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    created_by TEXT DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status)",
  "CREATE INDEX IF NOT EXISTS idx_opportunities_customer ON opportunities(customer_id)",
  "CREATE INDEX IF NOT EXISTS idx_opportunities_assignee ON opportunities(assignee_id)",
  // Quoting / RFQ pre-booking stage — every competitor platform researched (CargoWise, Magaya,
  // Descartes, Flexport, Freightos) treats a quote as a distinct object that precedes and
  // converts into a booking; CargoDesk previously had none (POST /api/shipments created a live
  // numbered shipment directly, no prior quote entity). Lifecycle: Draft -> Sent -> Accepted |
  // Declined | Expired -> Converted. Pricing reuses the existing contract-match/rate
  // infrastructure (GET /api/contracts/match) as a reference; quote_lines carry the actual
  // SELL-side price offered to the customer, which on conversion become the new shipment's SELL
  // cost lines (source 'quote') — the BUY side still comes from the real matched contract via the
  // existing importContractRates path, unchanged.
  `CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'Draft',
    customer_id TEXT DEFAULT '',
    customer_name TEXT DEFAULT '',
    pol TEXT DEFAULT '',
    pod TEXT DEFAULT '',
    carrier_code TEXT DEFAULT '',
    contract_id TEXT DEFAULT '',
    contract_ref TEXT DEFAULT '',
    commodity_code TEXT DEFAULT '',
    movement_type TEXT DEFAULT 'FCL',
    service_type TEXT DEFAULT 'Port-to-Port',
    incoterm TEXT DEFAULT '',
    cargo_ready_date TEXT DEFAULT '',
    valid_until TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    currency TEXT DEFAULT 'USD',
    total_amount_usd REAL DEFAULT 0,
    sent_at TEXT DEFAULT '',
    accepted_at TEXT DEFAULT '',
    declined_at TEXT DEFAULT '',
    decline_reason TEXT DEFAULT '',
    expired_at TEXT DEFAULT '',
    converted_shipment_id TEXT DEFAULT '',
    converted_at TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    created_by TEXT DEFAULT ''
  )`,
  // quantity*rate = amount in the line's own currency; amount_usd is resolved once via toUsd() at
  // write time — same idiom as carrier_invoice_lines.amount_usd/contract_rates.amount_usd — not
  // recomputed live, so a later FX-rate change never silently reopens an already-quoted line.
  `CREATE TABLE IF NOT EXISTS quote_lines (
    id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    service_code TEXT DEFAULT '',
    description TEXT DEFAULT '',
    container_type TEXT DEFAULT '',
    quantity REAL NOT NULL DEFAULT 1,
    unit TEXT DEFAULT 'per_container',
    rate REAL NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    amount_usd REAL DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status)",
  "CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes(customer_id)",
  "CREATE INDEX IF NOT EXISTS idx_quote_lines_quote ON quote_lines(quote_id)",
  // Reefer set-point temperature at the pricing stage — a quote's own containerType (e.g. "40RF")
  // already distinguishes a reefer line from a dry one, but nothing recorded what temperature was
  // actually being quoted. Same Celsius-only-persisted convention as containers.set_temperature_c
  // (the frontend's own °C/°F toggle converts before it ever reaches here) — kept independent of
  // that column: a quote's temperature is what's being OFFERED, not yet a real container's setting,
  // and quote-to-shipment conversion doesn't create containers at all (it only creates SELL cost
  // lines), so there's nothing to auto-carry it into regardless.
  "ALTER TABLE quote_lines ADD COLUMN set_temperature_c REAL DEFAULT NULL",
  // TKT-5YYLNT — contracts.container_types/imdg_classes were JSON-encoded string arrays, not
  // queryable/indexable (the GET /api/contracts?containerType= filter had to LIKE-match against
  // the raw JSON text). Junction tables instead — one row per (contract, type/class) pair, same
  // delete-then-reinsert-per-save shape contract_legs/contract_rates already use. The old columns
  // are left in place (SQLite can't cheaply drop them, and this codebase's standing precedent is
  // additive-only) but are no longer written to after this ships — every read/write path moves to
  // these tables instead (see routes/contracts.js's withContractArrays/saveContractArray).
  `CREATE TABLE IF NOT EXISTS contract_container_types (
    id             TEXT PRIMARY KEY,
    contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    container_type TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS contract_imdg_classes (
    id             TEXT PRIMARY KEY,
    contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    imdg_class     TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_container_types_uniq ON contract_container_types(contract_id, container_type)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_imdg_classes_uniq ON contract_imdg_classes(contract_id, imdg_class)",
  // NVOCC support, Epic TKT-Q52B38 — a customer eligible for the new "NVOCC" party role (below)
  // can carry its own FMC (or equivalent non-US) license/registration number. Mirrors the
  // classified_location boolean-flag-plus-detail-field pattern (v0.63.0) exactly: is_nvocc
  // gates whether fmc_number means anything, same as classified_location gates latitude/longitude.
  "ALTER TABLE customers ADD COLUMN is_nvocc INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE customers ADD COLUMN fmc_number TEXT DEFAULT ''",
  // Export Filing <-> Pickup integration (Epic TKT-6A7J45). A Submitted AES/EEI filing
  // previously carried no snapshot of what was actually declared beyond its own reference —
  // these columns are written once, at Submit time, from the shipment's real conveyance/cargo
  // data (routes/customs-filing.js), so (a) the transmitted payload actually states carrier/
  // vessel/voyage/export date, not just pol/pod, and (b) a later mismatch against the
  // shipment's now-current data can be detected and flagged (see the GET route's own
  // isStale computation) rather than a Filed/Accepted filing silently going stale.
  "ALTER TABLE customs_filings ADD COLUMN carrier_code   TEXT DEFAULT ''",
  "ALTER TABLE customs_filings ADD COLUMN vessel_name    TEXT DEFAULT ''",
  "ALTER TABLE customs_filings ADD COLUMN voyage_number  TEXT DEFAULT ''",
  "ALTER TABLE customs_filings ADD COLUMN export_date    TEXT DEFAULT ''",
  "ALTER TABLE customs_filings ADD COLUMN cargo_snapshot TEXT DEFAULT '[]'",
  // Credit Control Depth, third pass (Epic TKT-6XFJQM, Story TKT-GLWMFP) — a consumable
  // "permission slip" for the one class of credit block that's a soft warning rather than a
  // hard gate: generating an invoice while the responsible party is over their credit_limit.
  // credit_hold's release needs no equivalent table — it's an instant, global action recorded
  // directly on customers.credit_hold/credit_hold_reason, not a standing grant. An over-limit
  // approval is scoped to one shipment (the context it was requested from) and consumed the
  // moment the invoice it was approved for is actually generated — a customer going over limit
  // again later (a fresh invoice, a lowered limit) needs a fresh approval, never a standing
  // bypass. consumed_at NULL = still valid/unused.
  `CREATE TABLE IF NOT EXISTS credit_overrides (
    id               TEXT PRIMARY KEY,
    customer_id      TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    shipment_id      TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    override_type    TEXT NOT NULL,
    reason           TEXT NOT NULL,
    approved_by      TEXT NOT NULL,
    approved_by_name TEXT DEFAULT '',
    created_at       TEXT NOT NULL,
    consumed_at      TEXT DEFAULT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_credit_overrides_shipment ON credit_overrides(shipment_id, override_type, consumed_at)",
  // Invoicing Discipline & Billing Performance (Epic TKT-KR6ZBT), Story TKT-NQ87D3 — a real
  // payment-receipt primitive. Before this, "outstanding AR" (computeArExposure) meant purely
  // "confirmed, non-voided invoice" — there was no concept anywhere of a customer having
  // actually paid. paid_at is the date the financial controller enters (required at the API
  // level when marking paid, never defaulted to "now" — a payment recorded a few days after the
  // fact should still age from when the money actually arrived). paid_amount supports a partial
  // payment without silently reading as fully settled. transaction_id is optional reference
  // data only (bank reference, wire confirmation, etc.) — never validated or acted on.
  "ALTER TABLE shipment_documents ADD COLUMN paid_at        TEXT DEFAULT NULL",
  "ALTER TABLE shipment_documents ADD COLUMN paid_amount    REAL DEFAULT NULL",
  "ALTER TABLE shipment_documents ADD COLUMN transaction_id TEXT DEFAULT ''",
  // Story TKT-PLAVEK — whether a document was ever sent is reconstructed today by joining
  // entity_events (email, routes/shipment-ops.js's send-email route) and the document-
  // distribution microservice's own edi_transmittals/webhook_deliveries tables (each keyed by
  // document_id, never written back here) — fine for an on-demand history modal, too expensive
  // to join live for every row of a report. Written once by whichever channel succeeds first;
  // purely a fast read-side signal — the full multi-channel history stays exactly where it
  // already lives, this column never replaces it.
  "ALTER TABLE shipment_documents ADD COLUMN first_sent_at  TEXT DEFAULT NULL",
  // Story TKT-YC7PZP — mirrors credit_terms_days exactly: nullable, per-customer, blank means
  // no deadline configured (not "0 days"). Days after the shipment's own "delivered" milestone
  // within which an invoice should be generated and sent — a soft, informational flag only,
  // never a hard block (matches this Epic's own credit-hold-vs-limit precedent: blocking
  // shipment progress over a billing-process lag would hold up the wrong side of the business).
  "ALTER TABLE customers ADD COLUMN invoice_deadline_days INTEGER DEFAULT NULL",
  // Story TKT-4TEYT1 (Epic TKT-KR6ZBT) — configurable per-customer reminder cadence, direct
  // follow-up: "some clients may pay the same day, but some clients make the payment at the end
  // of the month ... notifications need to be configurable". Opt-in (default off) rather than
  // spammy-by-default — reminder_enabled gates whether this customer gets automated dunning
  // emails at all. reminder_interval_days controls repeats once overdue: null/0 means send a
  // single reminder and stop; a real value re-sends every N days for as long as the invoice
  // stays overdue and unpaid. Deliberately does NOT duplicate credit_terms_days/
  // invoice_deadline_days — "is this invoice overdue" is already fully answered by the existing
  // credit_terms_days-anchored due-date math (computeArExposure's aging, the Billing
  // Performance report's daysOverdue) — a same-day payer's short terms and an end-of-month
  // consolidator's 30-day terms already produce naturally different "overdue" dates with zero
  // new fields; these two columns only control the SEPARATE question of whether/how often to
  // remind once that's true.
  "ALTER TABLE customers ADD COLUMN reminder_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE customers ADD COLUMN reminder_interval_days INTEGER DEFAULT NULL",
  // Tracks the sweep's own cadence per invoice — null means never reminded yet.
  "ALTER TABLE shipment_documents ADD COLUMN last_reminder_sent_at TEXT DEFAULT NULL",
  // Equipment condition capture at gate in/out (TKT-QSUTQ7, FCL Coverage Audit epic
  // TKT-6PO7SV) — container_events logged WHEN a container moved but never its CONDITION.
  // condition_notes is deliberately separate from the pre-existing free-text `notes` column
  // (general event commentary, e.g. "processed by Agent Jones") — this is specifically a
  // damage/condition observation, the evidence a disputed detention charge usually comes
  // down to. damage_flag lets the row be queried/badged without parsing notes text.
  "ALTER TABLE container_events ADD COLUMN condition_notes TEXT DEFAULT ''",
  "ALTER TABLE container_events ADD COLUMN damage_flag INTEGER NOT NULL DEFAULT 0",
  // Chassis / drayage tracking (TKT-V8MIG0) rides directly on the EIR columns above per that
  // ticket's own scoping — a chassis-provider field on the same gate-event row a condition
  // photo is already being attached to, rather than a separate subsystem. Per-diem charges
  // need no new machinery — the existing generic charge-code/cost-line system already accepts
  // any charge code, chassis per-diem included.
  "ALTER TABLE container_events ADD COLUMN chassis_provider TEXT DEFAULT ''",
  // Lets an uploaded document (a condition/damage photo, via the existing generic upload
  // route) point at the specific gate-movement event it documents, not just the container in
  // general — a disputed charge needs "this photo proves the state at Gate In on this date,"
  // not just "some photo of this container exists somewhere."
  "ALTER TABLE shipment_documents ADD COLUMN container_event_id TEXT DEFAULT ''",
  // Landed-cost / duty estimate (TKT-U6IZCL, FCL Coverage Audit epic TKT-6PO7SV) — an
  // explicit ballpark tool, not a customs broker's system of record (a real per-country HS-
  // tariff feed is the same "needs a data business, not code" gap already named for carrier
  // networks in the v0.69.0 competitive analysis). Admin-maintained flat-rate-by-HS-chapter
  // registry, same shape/role pack_type_definitions/charge_code_definitions already have —
  // any HS chapter not listed here falls back to a constant default rate at compute time.
  `CREATE TABLE IF NOT EXISTS duty_rate_chapters (
    hs_chapter TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    rate_pct   REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('84','Machinery & mechanical appliances',2.5,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('85','Electrical machinery & electronics',2.6,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('61','Apparel, knitted or crocheted',16.0,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('62','Apparel, not knitted or crocheted',16.0,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('64','Footwear',11.0,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('94','Furniture & lighting',0.0,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('39','Plastics & articles thereof',5.0,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('73','Articles of iron or steel',3.0,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('87','Vehicles & parts',2.5,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('95','Toys, games & sports equipment',0.0,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('22','Beverages & spirits',3.0,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('09','Coffee, tea, spices',0.0,datetime('now'))",
  "INSERT OR IGNORE INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ('42','Leather goods, bags & luggage',8.0,datetime('now'))",
  // Dual carrier/shipper identity, second half (TKT-9O2B3T, NVOCC epic TKT-Q52B38) — the actual
  // structural gap wasn't a new carrier_code/principal_id pair (the existing shipment_parties
  // NVOCC role already carries that identity, see routes/share.js and buildBillOfLadingHtml);
  // it was that bl_release_type only ever modeled ONE release event, when an NVOCC shipment
  // genuinely has two: the vessel operator releasing to the NVOCC's own destination agent
  // (this new column), separate from the NVOCC's own release to the actual consignee
  // (bl_release_type, unchanged, still governs the existing Delivery Order document).
  "ALTER TABLE shipments ADD COLUMN master_bl_release_type TEXT DEFAULT ''",
  // NVOCC co-loading (TKT-UR1X17): the reference/tariff number under which this shipment's own
  // NVOCC tenders cargo through ANOTHER NVOCC's own contract with the vessel operator, when it
  // has none of its own for this lane. Free text, mirrors contract_ref's own nature — there's no
  // real registry of another NVOCC's tariff in this system, same reasoning contract_ref already
  // uses for SPOT/Pending/Customer Own contract types.
  "ALTER TABLE shipments ADD COLUMN coload_tariff_reference TEXT DEFAULT ''",
  // Scheduled / emailed reports (TKT-IXAR9G, Competitive Gap Analysis epic TKT-GTGM6R) —
  // reporting today is manual-trigger only (fixed dashboard tabs, one-click CSV/XLSX export).
  // Reuses office_mail_settings/sendViaOffice (already built for the invoice-email flow) —
  // no new mail infrastructure. report_type is a small, deliberately extensible dispatch key
  // (see runScheduledReportsSweep) — this first pass ships exactly one ('shipments-csv'),
  // the ticket's own cheapest, most representative case; adding another report type later is
  // one more dispatch branch, not a schema change. last_run_at null means never run — due
  // immediately regardless of frequency, same "never synced yet" convention scheduleNextOfacSync
  // already uses.
  `CREATE TABLE IF NOT EXISTS scheduled_reports (
    id           TEXT PRIMARY KEY,
    report_type  TEXT NOT NULL DEFAULT 'shipments-csv',
    frequency    TEXT NOT NULL DEFAULT 'weekly',
    recipients   TEXT NOT NULL DEFAULT '',
    office_id    TEXT NOT NULL,
    is_active    INTEGER NOT NULL DEFAULT 1,
    last_run_at  TEXT DEFAULT NULL,
    created_by   TEXT DEFAULT '',
    created_at   TEXT NOT NULL
  )`,

  // Invoice Collections Report + Automated Escalation (Epic TKT-G11AHW). "User responsible" and
  // "local branch manager" are genuinely new concepts — grep confirmed neither existed anywhere
  // (shipments/shipment_documents had no owner/assignee field, offices had no manager field).
  // invoice_owner_id defaults to whoever confirmed the invoice (a real, present person) and is
  // reassignable afterward. collections_alerted_at/collections_escalated_at are sibling columns
  // to the pre-existing last_reminder_sent_at (same dunning-sweep-timestamp idiom, just for the
  // new internal-alert sweep instead of the existing customer-facing reminder one).
  "ALTER TABLE shipment_documents ADD COLUMN invoice_owner_id       TEXT DEFAULT ''",
  "ALTER TABLE shipment_documents ADD COLUMN collections_alerted_at   TEXT DEFAULT NULL",
  "ALTER TABLE shipment_documents ADD COLUMN collections_escalated_at TEXT DEFAULT NULL",

  // Per-customer billing cycle (direct follow-up: "the business day helper can be a section of
  // the customer profile ... billing by date ... payment settlement date"). Both are day-of-month
  // integers (1-31), recurring — not literal calendar dates — same shape as the existing
  // invoice_deadline_days, chosen over a DatePicker per direct clarification since a single
  // stored date wouldn't repeat on its own and the real business case (end-of-month payers) is
  // inherently a recurring monthly pattern. unlocode is a placeholder for a future public-holiday
  // lookup — explicitly not wired to any live data source yet ("skip for now, but add a
  // placeholder... UNLocationCode based").
  "ALTER TABLE customers ADD COLUMN billing_by_day         INTEGER DEFAULT NULL",
  "ALTER TABLE customers ADD COLUMN payment_settlement_day INTEGER DEFAULT NULL",
  "ALTER TABLE customers ADD COLUMN holiday_unlocode       TEXT    DEFAULT ''",

  // Configurable per-office / per-country alert & escalation thresholds (direct follow-up: real
  // invoicing-deadline law varies by jurisdiction — "For Spain we would get fined if we issue the
  // invoice too late"). Resolution order, most specific wins: office -> country -> the sweep's own
  // hardcoded DEFAULT_ALERT_DAYS/DEFAULT_ESCALATION_DAYS fallback. offices.manager_user_id is the
  // "local branch manager" this epic needs (also absent from the schema before this) — it doubles
  // as both the escalation recipient AND the authority allowed to edit that office's own
  // thresholds, since no "branch manager"/"country manager" role exists in this app's role model
  // (trade_manager is lane-scoped, a different axis entirely) — a deliberate scoping choice, not
  // an oversight.
  "ALTER TABLE offices ADD COLUMN manager_user_id                TEXT    DEFAULT ''",
  "ALTER TABLE offices ADD COLUMN invoice_alert_business_days      INTEGER DEFAULT NULL",
  "ALTER TABLE offices ADD COLUMN invoice_escalation_business_days INTEGER DEFAULT NULL",
  "ALTER TABLE countries ADD COLUMN invoice_alert_business_days      INTEGER DEFAULT NULL",
  "ALTER TABLE countries ADD COLUMN invoice_escalation_business_days INTEGER DEFAULT NULL",

  // Reason codes are admin-configurable (same dual precedent as Pack Types/Duty Rate Chapters —
  // sensible defaults out of the box, fully editable via Master Data on top), seeded below with
  // the exact business case described.
  `CREATE TABLE IF NOT EXISTS invoice_status_reason_codes (
    id         TEXT PRIMARY KEY,
    code       TEXT NOT NULL,
    label      TEXT NOT NULL,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  "INSERT OR IGNORE INTO invoice_status_reason_codes (id,code,label,is_active,created_at) VALUES ('IRC-END-OF-MONTH','END_OF_MONTH_TERMS','Customer pays on a fixed end-of-month cycle — expected once their cycle closes, not within standard terms',1,datetime('now'))",
  "INSERT OR IGNORE INTO invoice_status_reason_codes (id,code,label,is_active,created_at) VALUES ('IRC-DISPUTE','DISPUTE','Customer disputes the invoice amount or line items',1,datetime('now'))",
  "INSERT OR IGNORE INTO invoice_status_reason_codes (id,code,label,is_active,created_at) VALUES ('IRC-PENDING-DOCS','PENDING_DOCS','Awaiting supporting documentation before the customer will process payment',1,datetime('now'))",
  "INSERT OR IGNORE INTO invoice_status_reason_codes (id,code,label,is_active,created_at) VALUES ('IRC-INTERNAL-DELAY','INTERNAL_DELAY','Payment confirmed by the customer, not yet reconciled internally',1,datetime('now'))",
  "INSERT OR IGNORE INTO invoice_status_reason_codes (id,code,label,is_active,created_at) VALUES ('IRC-OTHER','OTHER','Other — see description',1,datetime('now'))",

  // An audit-trail INSERT per override event (never an overwritten single field) — same
  // convention entity_events/CostLineHistoryModal's diff history already use throughout this
  // codebase. The most recent row for a document is its active override.
  `CREATE TABLE IF NOT EXISTS invoice_status_overrides (
    id                TEXT PRIMARY KEY,
    document_id       TEXT NOT NULL,
    reason_code       TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    overridden_status TEXT NOT NULL,
    overridden_by     TEXT NOT NULL DEFAULT '',
    overridden_at     TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_invoice_status_overrides_doc ON invoice_status_overrides(document_id)",

  // eAdapter — per-carrier EDI connectivity configuration, first story of the carrier-EDI epic.
  // One row per (carrier, office) as of v0.83.0 — a real carrier relationship is negotiated
  // per-country/per-branch, not once globally (a low-volume office is exactly the case a carrier
  // is least likely to bother giving EDI access to), so a carrier can hold several rows, one per
  // office it's actually configured for. office_id is the real scope key; country_iso2 is
  // denormalized from that office at write time (never trusted from the request body) purely so
  // the config list is scannable/groupable by country without a JOIN — see routes/eadapter.js.
  // Mirrors office_mail_settings' own shape otherwise (typed transport columns, is_active,
  // timestamps). credential is stored plaintext but — same precedent as
  // office_mail_settings.smtp_password/org_signing_certs — NO mapper or route ever returns it
  // raw; only a hasCredential boolean. This pass is configuration + CRUD only, no live outbound
  // call is attempted yet (see isEdiBookable below).
  `CREATE TABLE IF NOT EXISTS carrier_eadapter_configs (
    id               TEXT PRIMARY KEY,
    carrier_code     TEXT NOT NULL,
    country_iso2     TEXT NOT NULL DEFAULT '',
    office_id        TEXT NOT NULL DEFAULT '',
    transport_type   TEXT NOT NULL DEFAULT 'rest_api',
    endpoint_url     TEXT NOT NULL DEFAULT '',
    auth_header_name TEXT NOT NULL DEFAULT '',
    credential       TEXT NOT NULL DEFAULT '',
    is_active        INTEGER NOT NULL DEFAULT 1,
    notes            TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE(carrier_code, office_id)
  )`,
  // Defaults ON — the original 3 hardcoded BOOKABLE_CARRIERS (MAEU/SAFM/MCPU) keep working
  // exactly as they do today on every existing install; nothing breaks silently on upgrade.
  // Turning this off collapses ALL carriers (built-in or eAdapter-configured) to manual mode
  // uniformly — see isEdiBookable.
  "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('api_eadapter_enabled', 'true')",

  // Multi-Entity / Multi-Branch Accounting (TKT-EEV4I9) — a `branches` row already groups
  // offices by country/location, the same "Enterprise Unit ≈ legal entity" concept CargoWise's
  // own multi-entity model uses; this is the one piece it was missing to also serve as a real
  // accounting boundary. Kept 1:1 with `branches` deliberately — no new `entities` table — see
  // routes/finance.js's byEntity breakdown for how a shipment's owning entity is resolved
  // (EMO office's branch, falling back to IMO's) with zero new columns on shipments/cost lines.
  "ALTER TABLE branches ADD COLUMN currency TEXT DEFAULT NULL",
];

// "duplicate column name" is the expected, harmless result of re-running an ADD COLUMN
// migration against a DB that already has it (SQLite has no ADD COLUMN IF NOT EXISTS) —
// every one of the ~100 ALTER TABLE lines above hits this on every restart after the first.
// Anything else (syntax error, wrong type, locked db, disk full, ...) is a genuine failure
// that used to vanish into this same catch-all with zero trace.
const migrationFailures = [];
for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/duplicate column name/i.test(e.message)) {
      migrationFailures.push({ sql: sql.slice(0, 100), error: e.message });
      console.error(`[migration] FAILED: ${e.message}\n  SQL: ${sql.slice(0, 140)}`);
    }
  }
}
if (migrationFailures.length) {
  console.error(`[migration] ${migrationFailures.length} startup migration(s) failed — schema may be incomplete, see above.`);
}

// One-time backfill (TKT-5YYLNT): populate the new junction tables from every contract's existing
// container_types/imdg_classes JSON column, now that the migration loop above has actually created
// them. Idempotent via the unique index on each table — a second run (e.g. after a restart) hits
// the same "UNIQUE constraint failed" INSERT OR IGNORE already treats as the expected no-op, same
// as every other backfill in this codebase.
(function backfillContractArrayFields() {
  const rows = db.prepare("SELECT id, container_types, imdg_classes FROM contracts").all();
  const insType = db.prepare("INSERT OR IGNORE INTO contract_container_types (id, contract_id, container_type) VALUES (?,?,?)");
  const insClass = db.prepare("INSERT OR IGNORE INTO contract_imdg_classes (id, contract_id, imdg_class) VALUES (?,?,?)");
  for (const r of rows) {
    let types = [], classes = [];
    try { types = JSON.parse(r.container_types || "[]"); } catch { /* malformed legacy value, skip */ }
    try { classes = JSON.parse(r.imdg_classes || "[]"); } catch { /* malformed legacy value, skip */ }
    for (const t of types) if (t) insType.run(`CCT-${uid()}`, r.id, t);
    for (const c of classes) if (c) insClass.run(`CIC-${uid()}`, r.id, c);
  }
})();

// One-time table rebuild: shipment_schedules.shipment_id NOT NULL -> nullable, plus a new
// self-referential template_id column. SQLite can't drop a NOT NULL constraint via ALTER TABLE
// (unlike the ~150 plain ADD COLUMN migrations above), so this is a real create-copy-swap —
// guarded by checking the column's own notnull flag first, so it only ever runs once per DB.
// Narrow blast radius: nothing else in this schema joins on shipment_id expecting non-null
// (mapSchedule/linked-shipment lookups already null-guard), and the everyday "Add Sailing" flow
// keeps writing shipment-owned rows exactly as before — only the Schedule Generator's new
// ownerless "template" rows actually exercise the null case.
;(function rebuildShipmentSchedulesNullableOwner() {
  try {
    const cols = db.prepare("PRAGMA table_info(shipment_schedules)").all();
    const shipmentIdCol = cols.find(c => c.name === "shipment_id");
    if (!shipmentIdCol || shipmentIdCol.notnull === 0) return; // already migrated (or table missing)
    // foreign_keys can't be toggled mid-transaction (SQLite silently no-ops it) — must be set
    // before BEGIN, per SQLite's own documented recipe for this class of rebuild.
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN");
    db.exec(`CREATE TABLE shipment_schedules_new (
      id            TEXT PRIMARY KEY,
      shipment_id   TEXT REFERENCES shipments(id) ON DELETE CASCADE,
      carrier       TEXT DEFAULT '',
      vessel_name   TEXT DEFAULT '',
      voyage_number TEXT DEFAULT '',
      service       TEXT DEFAULT '',
      pol           TEXT DEFAULT '',
      pod           TEXT DEFAULT '',
      etd           TEXT DEFAULT '',
      eta           TEXT DEFAULT '',
      transit_days  INTEGER DEFAULT 0,
      is_mock       INTEGER DEFAULT 0,
      saved_at      TEXT NOT NULL,
      saved_by      TEXT NOT NULL DEFAULT '',
      vessel_imo    TEXT DEFAULT '',
      atd           TEXT DEFAULT '',
      ata           TEXT DEFAULT '',
      source        TEXT DEFAULT 'search',
      template_id   TEXT REFERENCES shipment_schedules(id) ON DELETE SET NULL,
      schedule_key  TEXT DEFAULT ''
    )`);
    db.exec(`INSERT INTO shipment_schedules_new
      (id, shipment_id, carrier, vessel_name, voyage_number, service, pol, pod, etd, eta,
       transit_days, is_mock, saved_at, saved_by, vessel_imo, atd, ata, source, template_id, schedule_key)
      SELECT id, shipment_id, carrier, vessel_name, voyage_number, service, pol, pod, etd, eta,
             transit_days, is_mock, saved_at, saved_by, vessel_imo, atd, ata, source, NULL, schedule_key
      FROM shipment_schedules`);
    db.exec("DROP TABLE shipment_schedules");
    db.exec("ALTER TABLE shipment_schedules_new RENAME TO shipment_schedules");
    db.exec("COMMIT");
    console.log("  ✔ shipment_schedules rebuilt: shipment_id is now nullable, template_id added");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    console.error("[migration] FAILED shipment_schedules rebuild:", e.message);
    migrationFailures.push({ sql: "rebuildShipmentSchedulesNullableOwner", error: e.message });
  } finally {
    try { db.exec("PRAGMA foreign_keys=ON"); } catch {}
  }
})();

// One-time restructure: carrier_agents moves from one-row-per-port to a header (carrier_code +
// agent_customer_id) + child carrier_agent_locations table, so a single Line Agent can cover
// several UN/LOCODEs and/or whole countries instead of exactly one port. SQLite can't drop the
// old UNIQUE(carrier_code, port_unlocode)/NOT NULL port_unlocode via ALTER TABLE, so this is the
// same guarded create-copy-swap shape as the shipment_schedules/carrier_eadapter_configs rebuilds
// above — gated on the presence of the old port_unlocode column, so it only ever runs once per
// DB. Every pre-existing row becomes one location under a header grouped by (carrier_code,
// agent_customer_id) — the only way to represent "one agent, several ports" before this existed
// was already several separate rows sharing that same pair, so grouping them is lossless for
// carrier/agent/location; only a differing note across grouped rows can't all survive (the
// header keeps the first non-blank one, matching this codebase's own precedent of a disclosed,
// reasonable simplification during a structural migration rather than blocking on it).
;(function rebuildCarrierAgentsLocations() {
  try {
    const cols = db.prepare("PRAGMA table_info(carrier_agents)").all();
    if (!cols.some(c => c.name === "port_unlocode")) return; // already migrated (or table missing)
    const oldRows = db.prepare("SELECT * FROM carrier_agents ORDER BY created_at").all();
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN");
    db.exec("ALTER TABLE carrier_agents RENAME TO carrier_agents_old_v1");
    // SQLite's ALTER TABLE RENAME silently rewrites any OTHER table's foreign-key reference that
    // points at the renamed table — carrier_agent_locations (already created moments earlier by
    // the flat migrations array above, on a fresh boot) has its FK repointed at
    // carrier_agents_old_v1, which is about to be dropped, leaving a dangling reference. Drop and
    // recreate it fresh here, after the real carrier_agents table exists again, so its FK binds
    // correctly. Harmless no-op on an already-migrated DB (never has the old shape to trigger this
    // branch at all) and on a schema where the array hasn't run yet (DROP TABLE IF EXISTS).
    db.exec("DROP TABLE IF EXISTS carrier_agent_locations");
    db.exec(`CREATE TABLE carrier_agents (
      id                 TEXT PRIMARY KEY,
      carrier_code       TEXT NOT NULL,
      agent_customer_id  TEXT NOT NULL REFERENCES customers(id),
      note               TEXT DEFAULT '',
      created_at         TEXT NOT NULL,
      UNIQUE(carrier_code, agent_customer_id)
    )`);
    db.exec(`CREATE TABLE carrier_agent_locations (
      id                TEXT PRIMARY KEY,
      carrier_agent_id  TEXT NOT NULL REFERENCES carrier_agents(id) ON DELETE CASCADE,
      carrier_code      TEXT NOT NULL,
      location_type     TEXT NOT NULL CHECK(location_type IN ('unlocode','country')),
      unlocode          TEXT REFERENCES port_locations(unlocode),
      country_iso2      TEXT REFERENCES countries(iso2),
      created_at        TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_cal_agent ON carrier_agent_locations(carrier_agent_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_cal_carrier_unlocode ON carrier_agent_locations(carrier_code, unlocode)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_cal_carrier_country ON carrier_agent_locations(carrier_code, country_iso2)");
    const headerMap  = new Map(); // "carrierCode|agentCustomerId" -> new header id
    const insHeader  = db.prepare("INSERT INTO carrier_agents (id,carrier_code,agent_customer_id,note,created_at) VALUES (?,?,?,?,?)");
    const insLoc     = db.prepare("INSERT INTO carrier_agent_locations (id,carrier_agent_id,carrier_code,location_type,unlocode,created_at) VALUES (?,?,?,'unlocode',?,?)");
    for (const r of oldRows) {
      const key = `${r.carrier_code}|${r.agent_customer_id}`;
      let headerId = headerMap.get(key);
      if (!headerId) {
        headerId = `CAG-${uid()}`;
        insHeader.run(headerId, r.carrier_code, r.agent_customer_id, r.note || '', r.created_at);
        headerMap.set(key, headerId);
      }
      insLoc.run(`CAL-${uid()}`, headerId, r.carrier_code, r.port_unlocode, r.created_at);
    }
    db.exec("DROP TABLE carrier_agents_old_v1");
    db.exec("COMMIT");
    console.log(`  ✔ carrier_agents restructured: ${oldRows.length} row(s) -> ${headerMap.size} header(s) + locations`);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    console.error("[migration] FAILED carrier_agents restructure:", e.message);
    migrationFailures.push({ sql: "rebuildCarrierAgentsLocations", error: e.message });
  } finally {
    try { db.exec("PRAGMA foreign_keys=ON"); } catch {}
  }
})();

// One-time table rebuild: carrier_eadapter_configs — carrier_code was a lone UNIQUE key (one row
// per carrier, no scope); v0.83.0 rescopes it to (carrier_code, office_id) and adds country_iso2.
// SQLite can't drop a UNIQUE constraint via ALTER TABLE, so this is the same guarded create-copy-
// swap as the shipment_schedules rebuild above — gated by checking whether office_id already
// exists, so it only ever runs once per DB. Every pre-existing row predates per-office scoping and
// has no real office to attribute itself to, so rather than guess one, each is deactivated with an
// explanatory note appended — an admin re-adds it properly, scoped to the office it actually
// applies to, via the (now office-aware) config modal.
;(function rebuildCarrierEadapterConfigsScoped() {
  try {
    const cols = db.prepare("PRAGMA table_info(carrier_eadapter_configs)").all();
    if (cols.some(c => c.name === "office_id")) return; // already migrated (or table missing)
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN");
    db.exec(`CREATE TABLE carrier_eadapter_configs_new (
      id               TEXT PRIMARY KEY,
      carrier_code     TEXT NOT NULL,
      country_iso2     TEXT NOT NULL DEFAULT '',
      office_id        TEXT NOT NULL DEFAULT '',
      transport_type   TEXT NOT NULL DEFAULT 'rest_api',
      endpoint_url     TEXT NOT NULL DEFAULT '',
      auth_header_name TEXT NOT NULL DEFAULT '',
      credential       TEXT NOT NULL DEFAULT '',
      is_active        INTEGER NOT NULL DEFAULT 1,
      notes            TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      UNIQUE(carrier_code, office_id)
    )`);
    db.prepare(`INSERT INTO carrier_eadapter_configs_new
      (id, carrier_code, country_iso2, office_id, transport_type, endpoint_url, auth_header_name,
       credential, is_active, notes, created_at, updated_at)
      SELECT id, carrier_code, '', '', transport_type, endpoint_url, auth_header_name,
             credential, 0,
             TRIM(notes || ' [Deactivated by the office-scoping migration — re-add scoped to a real office.]'),
             created_at, ?
      FROM carrier_eadapter_configs`).run(new Date().toISOString());
    db.exec("DROP TABLE carrier_eadapter_configs");
    db.exec("ALTER TABLE carrier_eadapter_configs_new RENAME TO carrier_eadapter_configs");
    db.exec("COMMIT");
    console.log("  ✔ carrier_eadapter_configs rebuilt: scoped to (carrier_code, office_id); any pre-existing rows deactivated pending re-scoping");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    console.error("[migration] FAILED carrier_eadapter_configs rebuild:", e.message);
    migrationFailures.push({ sql: "rebuildCarrierEadapterConfigsScoped", error: e.message });
  } finally {
    try { db.exec("PRAGMA foreign_keys=ON"); } catch {}
  }
})();

// One-time backfill: give every pre-existing shipment_schedules row a uniform leg-backed
// representation under the new content-keyed model (sailing_legs/schedule_leg_refs above) —
// idempotent (skips any schedule that already has schedule_leg_refs rows, so re-running on every
// boot after the first is a no-op). A real TSP row (2+ existing schedule_legs) gets each of its
// legs upserted into sailing_legs and referenced in order; a direct row (0-1 schedule_legs) gets
// ONE synthetic leg built from its own top-level carrier/pol/pod/vessel/voyage/etd/eta/service —
// the same "every schedule has 1+ legs" convention the rewritten write paths use going forward.
// No entity_events logging here: this is populating sailing_legs for the first time, not revising
// an existing row, so there's nothing to diff against yet.
;(function backfillSailingLegs() {
  const legKeyOf = l => [l.carrier, l.vessel_imo, l.voyage_number, l.pol, l.pod, l.etd]
    .map(v => (v || '').toString().trim().toUpperCase()).join('|');
  const upsertBackfillLeg = (l, now) => {
    const legKey = legKeyOf(l);
    db.prepare(`INSERT INTO sailing_legs (leg_key, carrier, pol, pod, etd, eta, vessel_name, vessel_imo, voyage_number, service, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(leg_key) DO NOTHING`)
      .run(legKey, l.carrier || '', l.pol || '', l.pod || '', l.etd || '', l.eta || '',
           l.vessel_name || '', l.vessel_imo || '', l.voyage_number || '', l.service || '', now, now);
    return legKey;
  };
  try {
    const schedules = db.prepare(`
      SELECT s.* FROM shipment_schedules s
      WHERE NOT EXISTS (SELECT 1 FROM schedule_leg_refs r WHERE r.schedule_id = s.id)
    `).all();
    if (schedules.length === 0) return;
    const insertRef = db.prepare("INSERT INTO schedule_leg_refs (schedule_id, leg_key, leg_order) VALUES (?,?,?)");
    const updateKey = db.prepare("UPDATE shipment_schedules SET schedule_key=? WHERE id=?");
    const now = new Date().toISOString();
    db.exec("BEGIN");
    for (const sched of schedules) {
      const oldLegs = db.prepare("SELECT * FROM schedule_legs WHERE schedule_id=? ORDER BY leg_order ASC").all(sched.id);
      const legRows = oldLegs.length >= 2 ? oldLegs : [{
        carrier: sched.carrier, pol: sched.pol, pod: sched.pod, etd: sched.etd, eta: sched.eta,
        vessel_name: sched.vessel_name, vessel_imo: sched.vessel_imo, voyage_number: sched.voyage_number, service: sched.service,
      }];
      const legKeys = legRows.map(l => upsertBackfillLeg(l, now));
      legKeys.forEach((legKey, i) => insertRef.run(sched.id, legKey, i));
      updateKey.run(legKeys.join("→"), sched.id);
    }
    db.exec("COMMIT");
    console.log(`  ✔ Backfilled ${schedules.length} schedule(s) into sailing_legs/schedule_leg_refs`);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    console.error("[migration] FAILED backfillSailingLegs:", e.message);
    migrationFailures.push({ sql: "backfillSailingLegs", error: e.message });
  }
})();

const UPLOADS_DIR = path.join(__dirname, "uploads", "documents");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Port → trade lane index (for access-scope filtering + tradeLane display) ─
// Read synchronously on every shipment mapped (mapShipment, matchesScopeItem) — this MUST stay
// an in-memory cache, never a live per-call fetch, in either mdm_source mode. 'remote' mode
// rebuilds it from the MDM Service's one bulk GET /internal/port-lanes-index instead of the local
// 4-table JOIN; the trigger points (after a country_trade_lanes-mutating route) are unchanged.
const portLanesMap = {};
const PORT_LANES_SQL = `
  SELECT DISTINCT pl.unlocode, tl.code AS lane_code
  FROM port_locations pl
  JOIN countries c ON c.iso2 = pl.country_code
  JOIN country_trade_lanes ctl ON ctl.iso2 = c.iso2
  JOIN trade_lanes tl ON tl.code = ctl.lane_code
`;
async function rebuildPortLanesMap() {
  try {
    const plRows = (getSettings().mdm_source || "local") === "remote"
      ? await callMdmService("GET", "/internal/port-lanes-index")
      : db.prepare(PORT_LANES_SQL).all();
    for (const key of Object.keys(portLanesMap)) delete portLanesMap[key];
    for (const r of plRows) {
      if (!portLanesMap[r.unlocode]) portLanesMap[r.unlocode] = new Set();
      portLanesMap[r.unlocode].add(r.lane_code);
    }
    console.log(`  ✔ Port→lane index rebuilt for ${Object.keys(portLanesMap).length} ports`);
  } catch (e) {
    console.warn("  ⚠ Port→lane index failed:", e.message);
  }
}
rebuildPortLanesMap();

// ─── Port → country index (for country-code access filtering) ─────────────────
// Deliberately built ONCE at boot and never refreshed thereafter, in both modes — a pre-existing
// staleness characteristic (a port's country_code changing via PUT doesn't reach this map until
// restart) that this cut preserves rather than fixes. 'remote' mode does one bulk GET
// /internal/port-country-map instead of the local read.
const portCountryMap = {};
(async () => {
  try {
    const pcRows = (getSettings().mdm_source || "local") === "remote"
      ? await callMdmService("GET", "/internal/port-country-map")
      : db.prepare("SELECT unlocode, country_code FROM port_locations WHERE country_code IS NOT NULL AND country_code != ''").all();
    for (const r of pcRows) portCountryMap[r.unlocode] = r.country_code;
    console.log(`  ✔ Port→country map built for ${Object.keys(portCountryMap).length} ports`);
  } catch (e) {
    console.warn("  ⚠ Port→country map failed:", e.message);
  }
})();

// Pre-declared here so broadcastMessage / recomputeSpaceBadge (defined below) can close over it;
// the WebSocket handler in this same file populates it after the server starts.
const shipmentSubs = new Map();

// ─── Backfill user roles array ────────────────────────────────────────────────
;(function backfillUserRoles() {
  try {
    const toUpdate = db.prepare("SELECT id, role FROM users WHERE roles IS NULL OR roles = ''").all();
    for (const u of toUpdate) {
      db.prepare("UPDATE users SET roles = ? WHERE id = ?")
        .run(JSON.stringify([u.role || 'viewer']), u.id);
    }
    if (toUpdate.length) console.log(`  ✔ Backfilled roles[] for ${toUpdate.length} user(s)`);
  } catch (e) { console.warn("  ⚠ User roles backfill:", e.message); }
})();

// ─── Seed admin user ──────────────────────────────────────────────────────────

// Was hardcoded to the maintainer's own personal email/name — harmless for a single-operator
// local dev DB, but wrong for anyone else's fresh clone (a stranger self-hosting this repo has
// no way to know or use that login) and stale against what README.md/CLAUDE.md already
// documented as "the" default. Now reads ADMIN_EMAIL/ADMIN_PASSWORD if set (e.g. in .env),
// falling back to the generic default the docs describe — same disclosed-insecure-default
// tradeoff as JWT_SECRET etc., logged loudly so it's never mistaken for a real credential.
// Named (not an anonymous IIFE) so the admin "Reset Demo Data" panel can re-invoke this exact
// same bootstrap after wiping the users table — the database ends up in exactly the state a
// truly fresh boot would produce, not a bespoke new one.
function seedAdmin() {
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@cargodesk.com";
  const TEMP_PW    = process.env.ADMIN_PASSWORD || "admin123";
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
  if (!exists) {
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 'admin', 1, datetime('now'))"
    ).run(`USR-${uid()}`, ADMIN_EMAIL, "Admin", bcrypt.hashSync(TEMP_PW, 10));
    console.log(`\n⚓  Admin user created: ${ADMIN_EMAIL}`);
    console.log(`   Temporary password : ${TEMP_PW}`);
    console.log(`   Change it via the User Management panel.\n`);
  }
}
seedAdmin();

// Test-fixture admin — every one of the ~30 backend test files, both Cypress suites, and this
// session's own CDP verification scripts all hardcode this exact account as a documented
// prerequisite ("Admin account: claudeagent@localhost / TestFixture!2026Zq", see any
// tests/*.test.js file header) — but nothing ever actually created it. It only ever existed
// because this project's own long-lived local cargodesk.db had it created manually at some
// point; a genuinely fresh database (every CI run, always) had no way to reproduce it. This is
// why `npm test`/Cypress have never actually passed in CI even after `npm ci` itself started
// working again — confirmed directly: CI's first real failure past the dependency fix was
// `Fatal: Login failed (401)` on the very first test file. Idempotent and unconditional, same
// as seedAdmin() above — same disclosed-insecure-default tradeoff, since it's a fixed, publicly
// documented password purely for automated verification, never meant to gate anything real.
function seedTestFixtureAdmin() {
  const EMAIL = "claudeagent@localhost";
  const PW    = "TestFixture!2026Zq";
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(EMAIL);
  if (!exists) {
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 'admin', 1, datetime('now'))"
    ).run(`USR-${uid()}`, EMAIL, "Test Fixture Admin", bcrypt.hashSync(PW, 10));
    console.log(`⚓  Test-fixture admin created: ${EMAIL} (used by the automated test suite)`);
  }
}
seedTestFixtureAdmin();

// ─── Seed document-signing certificate ────────────────────────────────────────
// Pure JS (node-forge) — safe to run unconditionally every boot, unlike the browser this
// cert will eventually be used alongside for rendering, which only needs to resolve lazily
// at render time so a machine with no browser installed yet still starts up fine.

function seedSigningCert() {
  try {
    const exists = db.prepare("SELECT id FROM org_signing_certs WHERE status = 'active'").get();
    if (exists) return;
    const cert = generateSelfSignedSigningCert();
    db.prepare(`INSERT INTO org_signing_certs
      (id, cert_pem, private_key_pem, p12_base64, p12_passphrase, fingerprint_sha256, subject, not_before, not_after, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))`)
      .run(`CERT-${uid()}`, cert.certPem, cert.privateKeyPem, cert.p12Base64, cert.p12Passphrase,
        cert.fingerprintSha256, cert.subject, cert.notBefore, cert.notAfter);
    console.log(`  ✔ Document-signing certificate generated (fingerprint ${cert.fingerprintSha256.slice(0, 16)}...)`);
  } catch (e) { console.warn("  ⚠ Document-signing cert bootstrap:", e.message); }
}
seedSigningCert();

// ─── App Settings ─────────────────────────────────────────────────────────────

function getSettings() {
  // idleTimeoutMinutes comes from config/app-settings.yaml (lib/staticConfig.js), not the
  // app_settings table — deliberately static/code-deploy config, not a runtime Settings toggle.
  // Merged into the same flat response so the frontend needs no second fetch for it.
  try {
    const dbSettings = Object.fromEntries(db.prepare("SELECT key, value FROM app_settings").all().map(r => [r.key, r.value]));
    return { ...dbSettings, idleTimeoutMinutes: String(staticConfig.session.idleTimeoutMinutes) };
  } catch { return { idleTimeoutMinutes: String(staticConfig.session.idleTimeoutMinutes) }; }
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
  // Multi-list denied-party screening beyond OFAC SDN — BIS Denied Persons/Entity/Unverified/
  // Military End User Lists, State Dept ITAR Debarred + Nonproliferation Sanctions, and 5 more
  // OFAC-family lists. Defaults on, same posture as OFAC itself (see api_ofac_enabled above) —
  // narrower screening is never the safer default for a compliance feature.
  api_csl_enabled:            'true',
  api_csl_interval_value:     '1',
  api_csl_interval_unit:      'weeks',
  finance_view_enabled:       'true',
  api_ws_enabled:             'true',
  api_shipments_enabled:      'true',
  api_contracts_enabled:      'true',
  api_customers_enabled:      'true',
  api_carriers_enabled:       'true',
  api_vessels_enabled:        'true',
  api_ports_enabled:          'true',
  api_sysmsg_enabled:         'true',
  ai_agent_enabled:           '0',
  ai_endpoint:                '',
  ai_model:                   'claude-haiku-4-5-20251001',
  ai_api_key:                 '',
  ai_system_prompt:           '',
  // 'local' (default) = the monolith's own in-process contracts/contract_legs/contract_rates/
  // contract_routings tables, exactly as today. 'remote' = the standalone Contract Management
  // Service (services/contract-management/, see CONTRACT_SERVICE_URL above). A one-way cutover
  // lever, not a live bidirectional sync — see routes/contracts.js's callContractService callers.
  contract_source:            'local',
  // 'local' (default) = the monolith's own in-process carriers/vessels/port_locations/
  // linked_ports/trade_lanes/country_trade_lanes/regions/countries/commodities/carrier_agents
  // tables, exactly as today. 'remote' = the standalone MDM Service (services/mdm/, see
  // MDM_SERVICE_URL above). Same one-way-cutover-lever shape as contract_source.
  mdm_source:                 'local',
  // Same one-way cutover lever as contract_source/mdm_source above, for the Screening Service
  // (services/screening/) — sanctions_entries/sanctions_syncs.
  screening_source:           'local',
  // Same one-way cutover lever as the three above, for the Kanban/Testing Service
  // (services/kanban/) — tickets/ticket_links/test_items/test_case_links/kb_projects/
  // kb_versions/kb_columns.
  kanban_source:              'local',
  // Same one-way cutover lever as the four above, for the Customer Service (services/customers/)
  // — customers/customer_identifiers/customer_screenings/customer_contacts. customer_documents
  // and customer_roles are deliberately NOT part of this toggle — see ARCHITECTURE.md §8.1's
  // "Customer-specific notes" for why.
  customer_source:            'local',
  // Freight Audit & Payment — a carrier invoice line whose |variance| exceeds this percentage of
  // the expected (contracted/accrued) amount is flagged 'variance' instead of auto-'matched'.
  // One flat global tolerance, not per-carrier/per-charge-type rules — the configurable-rule-
  // library depth real FAP vendors build is deliberately out of scope for this pass.
  fap_variance_tolerance_pct: '2',
  // Reports (routes/reports.js) — a region/country/carrier whose GP% falls below this is
  // flagged and sorted to the top of the list, so "where are we losing money" is a glance, not
  // a scan. '' (not '0') means unset/no target — a real 0% target is a legitimate (if unusual)
  // choice and must stay distinguishable from "nobody's configured this yet". One flat global
  // number, not per-lane/per-region targets — same simplification fap_variance_tolerance_pct
  // above already makes for the identical reason; a real per-region target scheme is a
  // meaningfully bigger feature (needs its own table + management UI), not a v1 default.
  gp_target_pct: '',
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
const sanctionsMap = new Map();

// Bug fix (found auditing this for the Screening Service extraction): this used to do
// `sanctionsMap = new Map()` — a REASSIGNMENT of the module-level variable, not an in-place
// mutation. ctx.sanctionsMap is captured once, by value, when the ctx object literal is built;
// routes/customers.js destructures it once at route-registration time. Any reload after boot (a
// manual sync, a CSL sync, a CSV import, either scheduled timer) reassigned this variable to a
// brand-new Map — screenShipmentById (defined here, closes over the variable directly) always
// saw the fresh one, but routes/customers.js's own captured reference stayed frozen at whatever
// the map was at ctx-build time forever, silently never seeing a later reload. screenCustomer()/
// GET /api/customers/:id/sanctions-check were affected; screenShipmentById was not. Fixed by
// mutating the existing Map in place (.clear() + refill) so every already-captured reference,
// however it was obtained, stays valid across every future reload — a prerequisite for the new
// remote-mode poll-refresh below, which would otherwise "work" for screenShipmentById and
// silently never reach screenCustomer, worse than today's already-rare bug.
async function loadSanctionsIndex() {
  let rows;
  if ((getSettings().screening_source || 'local') === 'remote') {
    try { rows = await callScreeningService("GET", "/internal/sanctions/entries/export"); }
    catch (e) { console.warn("  ⚠ Sanctions index reload from Screening Service failed:", e.message); return; }
  } else {
    rows = db.prepare("SELECT source, entity_name, entity_type, program, aliases_norm FROM sanctions_entries").all();
  }
  sanctionsMap.clear();
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
loadSanctionsIndex().catch(() => {}); // async now (remote mode) — internal try/catch already logs, this just guards the unhandled-rejection case

// ─── OFAC SDN sync (extracted so route and scheduler both call it) ─────────────

function httpsGetFollowRedirects(url, depth = 0, reqHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("Too many redirects"));
    const opts = { rejectUnauthorized: false, headers: reqHeaders };
    https.get(url, opts, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = r.headers.location.startsWith("http")
          ? r.headers.location
          : new URL(r.headers.location, url).href;
        return resolve(httpsGetFollowRedirects(next, depth + 1, reqHeaders));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error(`OFAC returned HTTP ${r.statusCode}`)); }
      resolve(r);
    }).on("error", reject);
  });
}

async function syncOfacSdn() {
  if ((getSettings().screening_source || 'local') === 'remote') {
    const r = await callScreeningService("POST", "/internal/sanctions/sync");
    await loadSanctionsIndex();
    await rescreenActiveShipments();
    return r;
  }
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
  await loadSanctionsIndex();
  await rescreenActiveShipments();
  return { source: "OFAC-SDN", syncedAt: now, entries: entries.length };
}

// ─── Consolidated Screening List sync (multi-list denied-party screening) ─────
// The US government's own Consolidated Screening List (developer.trade.gov, free, no API key)
// bundles 11 lists beyond OFAC's own SDN list into one feed — BIS's Denied Persons/Entity/
// Unverified/Military End User Lists, State Dept's ITAR Debarred (AECA) and Nonproliferation
// Sanctions lists, and 5 more OFAC-family lists beyond SDN (SSI, CAPTA, Non-SDN Menu-Based,
// Non-SDN Chinese Military-Industrial Complex, Palestinian Legislative Council). Screening OFAC
// SDN alone (this app's previous scope) misses all of these — a real compliance program checks
// the full set, not one list. The bulk feed also includes the SDN list itself; those rows are
// filtered out here since syncOfacSdn() above already owns that list under its own 'OFAC-SDN'
// source and sync cadence — this sync is additive to it, not a replacement.
//
// sanctions_entries.source/sanctions_syncs.source were already fully generic columns before this
// (confirmed: only ever written as the literal 'OFAC-SDN' until now) — no schema change needed.
// Every CSL-sourced row's `id` is prefixed 'CSL-' specifically so the delete-then-reinsert below
// can safely scope to "every row this sync owns" without having to enumerate the list names
// themselves, which the government feed could rename or add to over time.
async function syncConsolidatedScreeningList() {
  if ((getSettings().screening_source || 'local') === 'remote') {
    const result = await callScreeningService("POST", "/internal/sanctions/sync-csl");
    await loadSanctionsIndex();
    await rescreenActiveShipments();
    return result;
  }
  const r = await fetch("https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.json");
  if (!r.ok) throw new Error(`Consolidated Screening List returned HTTP ${r.status}`);
  const data = await r.json();
  const results = Array.isArray(data.results) ? data.results : [];
  const entries = results.filter(e => e.id && e.name && !/^Specially Designated Nationals/i.test(e.source || ""));

  db.prepare("DELETE FROM sanctions_entries WHERE id LIKE 'CSL-%'").run();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO sanctions_entries (id,source,ref_id,entity_name,entity_name_norm,entity_type,program,aliases_norm)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  db.exec("BEGIN");
  try {
    for (const e of entries)
      ins.run(`CSL-${e.id}`, e.source || "Consolidated Screening List", String(e.id), e.name,
               normSanctionName(e.name), e.type || "", (e.programs || []).join("; "),
               JSON.stringify((e.alt_names || []).map(normSanctionName)));
    db.exec("COMMIT");
  } catch (e2) { db.exec("ROLLBACK"); throw e2; }

  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO sanctions_syncs (source,synced_at,entry_count) VALUES ('CSL',?,?)").run(now, entries.length);
  await loadSanctionsIndex();
  await rescreenActiveShipments();
  return { source: "CSL", syncedAt: now, entries: entries.length };
}

// Organization Model Enhancement Epic 3 — after any sanctions list update (OFAC XML sync, the
// scheduled auto-sync, or a manual CSV import), re-screen every still-relevant shipment so a
// newly-added SDN entry is caught immediately instead of waiting for that shipment to be
// independently edited. Bounded to shipments that aren't Completed/Cancelled — mirrors
// CargoWise's own "rescan on list update" behavior without a full-table sweep of every
// shipment ever created, most of which are no longer operationally relevant. Same
// don't-overwrite-a-compliance-officer's-override guard every other re-screen trigger uses.
async function rescreenActiveShipments() {
  const ids = db.prepare("SELECT id FROM shipments WHERE status NOT IN ('Completed','Cancelled')").all().map(r => r.id);
  for (const shipmentId of ids) {
    const prev = db.prepare("SELECT result, overridden_at FROM shipment_screenings WHERE shipment_id=?").get(shipmentId);
    const isOverridden = prev?.result === 'CLEAR' && prev?.overridden_at;
    if (!isOverridden) await screenShipmentById(shipmentId);
  }
}

// Organization Model Enhancement Epic 4 — the shared read-side helper the plan called for:
// given ANY customer id in a parent/child hierarchy, returns every customer id belonging to
// that same tree (root ancestor + all descendants), so a "roll up by parent" report can sum
// figures across a whole group regardless of which member's id the caller started from.
// Deliberately read-side only — the three independent customer-pointer mechanisms (shipment
// fixed FKs, shipment_parties, contracts.named_account_id) keep writing plain denormalized
// customer_id/customer_name pairs exactly as they already do everywhere else in this codebase;
// this doesn't unify or change that convention, it just reads across it for reporting.
// A caller can't know the mode in advance, so this is async unconditionally — the local branch's
// own walk-to-root-then-BFS-down logic is byte-for-byte unchanged from before this function had a
// remote branch at all. Remote does the identical walk server-side via the Customer Service's own
// GET /internal/customers/:id/group (mirrors Kanban's co-located-table-JOIN precedent) — both
// branches return the same root-first array; routes/finance.js's rootOf() depends on that order.
async function resolveCustomerGroup(customerId) {
  if ((getSettings().customer_source || "local") === "remote") {
    try {
      const { ids } = await callCustomerService("GET", `/internal/customers/${customerId}/group`);
      return ids;
    } catch { return [customerId]; }
  }
  let root = customerId;
  let current = customerId;
  const walked = new Set();
  while (current) {
    if (walked.has(current)) break; // safety net against a pre-existing cycle in old data
    walked.add(current);
    root = current;
    current = db.prepare("SELECT parent_customer_id FROM customers WHERE id=?").get(current)?.parent_customer_id || null;
  }
  const group = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const id = queue.shift();
    for (const child of db.prepare("SELECT id FROM customers WHERE parent_customer_id=?").all(id)) {
      if (!group.has(child.id)) { group.add(child.id); queue.push(child.id); }
    }
  }
  return [...group];
}

// One shared read helper for the 4 independent credit-hold/over-limit sites (routes/customers.js
// {credit-hold/release, credit-override/approve, credit-overrides/queue, invoice-deadlines/
// overdue}, routes/shipments.js's create-time warning, routes/edi.js's booking-request block,
// routes/shipment-ops.js's findCreditHold/findOverLimitBlock) — one remote shape, not four.
// Both branches return the exact same mapCustomer camelCase shape. References mapCustomer
// (assigned later in this same module, via createMappers) — safe: this function is only ever
// invoked from a request handler, long after the whole module has finished loading.
async function getCustomerRow(id) {
  if (!id) return null;
  if ((getSettings().customer_source || "local") === "remote") {
    try { return await callCustomerService("GET", `/internal/customers/${id}`); }
    catch { return null; }
  }
  const r = db.prepare("SELECT * FROM customers WHERE id=?").get(id);
  return r ? mapCustomer(r) : null;
}

// screenShipmentById's own read of a party's customer-level screening result — the match DECISION
// (screenCustomer, routes/customers.js) can never move into the Customer Service, since it depends
// on the monolith-owned sanctionsMap cache; only the already-decided result's WRITE and this READ
// of it can. Local: direct query, unchanged. Remote: the service's own write-only screening record.
async function getCustomerScreeningResult(id) {
  if (!id) return null;
  if ((getSettings().customer_source || "local") === "remote") {
    try { return (await callCustomerService("GET", `/internal/customers/${id}/screening`))?.result || null; }
    catch { return null; }
  }
  return db.prepare("SELECT result FROM customer_screenings WHERE customer_id=?").get(id)?.result || null;
}

// ─── OFAC auto-sync scheduler ─────────────────────────────────────────────────

let ofacAutoSyncTimer = null;

// setTimeout is backed by a 32-bit int; anything above ~24.8 days wraps to 1ms.
const MAX_TIMER_MS = 2_000_000_000; // ~23.1 days — safe upper bound

// How often the screening_source='remote' cache-refresh poll below fires — decoupled from the
// actual sync cadence (the Screening Service now owns firing the sync on ITS OWN schedule);
// this just keeps the monolith's own sanctionsMap from lagging too far behind whatever the
// service last synced. Cheap (one bulk GET), so a short interval is fine.
const SCREENING_POLL_MS = 15 * 60 * 1000;

function scheduleNextOfacSync(retryDelayMs = null) {
  clearTimeout(ofacAutoSyncTimer);
  // 'remote' mode: the Screening Service owns the actual sync schedule now — this timer's only
  // job is to keep the local sanctionsMap cache from drifting, via a plain fixed-interval poll
  // instead of the elaborate "is a sync due" math below, which only makes sense for deciding
  // when to FIRE a sync (a decision this side no longer makes).
  if ((getSettings().screening_source || 'local') === 'remote') {
    ofacAutoSyncTimer = setTimeout(() => { loadSanctionsIndex().catch(() => {}); scheduleNextOfacSync(); }, SCREENING_POLL_MS);
    return;
  }
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

// Structurally identical to scheduleNextOfacSync above, just for the 'CSL' sync source and its
// own settings keys — kept as an independent copy rather than generalizing the OFAC scheduler
// into a shared multi-source one, since that would mean touching already-working, tested
// scheduling logic for a second call site; same "duplicate rather than risk the working original"
// precedent this codebase already applies elsewhere (dockerSecret.js, per-service mappers, etc.).
let cslAutoSyncTimer = null;

function scheduleNextCslSync(retryDelayMs = null) {
  clearTimeout(cslAutoSyncTimer);
  // 'remote' mode: same reasoning as scheduleNextOfacSync's own remote branch above — the
  // Screening Service owns the actual sync schedule, this is just a cache-refresh poll.
  if ((getSettings().screening_source || 'local') === 'remote') {
    cslAutoSyncTimer = setTimeout(() => { loadSanctionsIndex().catch(() => {}); scheduleNextCslSync(); }, SCREENING_POLL_MS);
    return;
  }
  try {
    const s = getSettings();
    if (s.api_csl_enabled !== 'true') return;
    const lastSync = db.prepare("SELECT synced_at FROM sanctions_syncs WHERE source='CSL'").get();
    if (!lastSync) return; // Never synced — user must trigger the first one manually

    let delay;
    if (retryDelayMs != null) {
      delay = Math.min(MAX_TIMER_MS, retryDelayMs);
    } else {
      const val        = Math.max(1, parseInt(s.api_csl_interval_value) || 1);
      const unit       = s.api_csl_interval_unit || 'weeks';
      const msMap      = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const intervalMs = val * (msMap[unit] || msMap.weeks);
      const nextDue    = new Date(lastSync.synced_at).getTime() + intervalMs;
      delay = Math.min(MAX_TIMER_MS, Math.max(60000, nextDue - Date.now()));
    }

    cslAutoSyncTimer = setTimeout(async () => {
      const ls  = db.prepare("SELECT synced_at FROM sanctions_syncs WHERE source='CSL'").get();
      const sv  = Math.max(1, parseInt(getSettings().api_csl_interval_value) || 1);
      const su  = getSettings().api_csl_interval_unit || 'weeks';
      const msMap = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const due = ls ? new Date(ls.synced_at).getTime() + sv * (msMap[su] || msMap.weeks) : 0;
      if (Date.now() < due) { scheduleNextCslSync(); return; }

      console.log("⚓ Auto-syncing Consolidated Screening List…");
      try {
        const r = await syncConsolidatedScreeningList();
        console.log(`  ✔ CSL auto-sync complete: ${r.entries.toLocaleString()} entries`);
        scheduleNextCslSync();
      } catch (e) {
        console.error("  ✗ CSL auto-sync failed:", e.message);
        scheduleNextCslSync(3_600_000);
      }
    }, delay);

    console.log(`  ⏱ CSL auto-sync scheduled in ${Math.round(delay / 3600000 * 10) / 10}h`);
  } catch {}
}
try { scheduleNextCslSync(); } catch {}

// Dunning sweep (Story TKT-4TEYT1) — deliberately simpler than the OFAC/CSL schedulers above:
// no "catch up to a due date" logic needed, since runDunningSweep itself already re-evaluates
// what's actually due (per-invoice last_reminder_sent_at + each customer's own cadence) on
// every single run — a plain daily interval is sufficient. Does NOT fire once at boot (unlike
// syncing a sanctions list, sending real customer-facing email on every dev restart would be
// a real surprise) — the first real run is 24h after this process started.
setInterval(() => { runDunningSweep().catch(e => console.error("Dunning sweep failed:", e.message)); }, 24 * 60 * 60 * 1000);
// Scheduled reports (TKT-IXAR9G) — same deliberate choice as the dunning sweep above: no fire-
// at-boot, so a dev restart never sends real report email; the first real run is 24h out.
setInterval(() => { runScheduledReportsSweep().catch(e => console.error("Scheduled reports sweep failed:", e.message)); }, 24 * 60 * 60 * 1000);

async function screenShipmentById(shipmentId) {
  const s = db.prepare("SELECT * FROM shipments WHERE id=?").get(shipmentId);
  if (!s) return null;

  const hits = [];

  // Party name screening — Organization Model Enhancement Epic 3 broadened this from just
  // Shipper/Consignee/Principal to all 13 possible party-role slots on a shipment: the 4 fixed
  // columns (adding Notify Party, previously invisible to screening entirely) plus every
  // shipment_parties row (Forwarder, Customs Broker Export/Import, Trucker Pre/On-carriage,
  // Also Notify Party, Bank, Insurance Provider, Agent — 9 more roles that were also previously
  // invisible). `field` uses the exact role strings from FIXED_SHIPMENT_ROLES/
  // ADDITIONAL_PARTY_ROLES so the unified Compliance panel can match a hit back to its slot.
  //
  // Each party also carries a customer_id (where set) — corroborated against customer_screenings
  // ALONGSIDE the direct name-vs-sanctionsMap match, not instead of it. This matters because
  // shipper_name/consignee_name/shipment_parties.customer_name etc. are all denormalized name
  // SNAPSHOTS (this codebase's standing convention — see shipment_parties' own schema comment),
  // frozen at whichever moment that party was assigned. Renaming a customer updates
  // customers.company_name (and re-screens that customer immediately) but does NOT touch any
  // shipment's already-stored copy of the old name — a pure name-match re-screen would stay
  // blind to that rename forever. The customer_id corroboration catches it: customer-level
  // screening always reflects the customer's CURRENT name, independent of what any shipment's
  // own stale copy says.
  const fixedParties = [
    ['Shipper', s.shipper_name, s.shipper_id], ['Consignee', s.consignee_name, s.consignee_id],
    ['Principal', s.principal_name, s.principal_id], ['Notify Party', s.notify_name, s.notify_id],
  ];
  const additionalParties = db.prepare("SELECT role, customer_name, customer_id FROM shipment_parties WHERE shipment_id=?")
    .all(shipmentId).map(r => [r.role, r.customer_name, r.customer_id]);
  // Service vendors (truckers, CFS/warehousing operators, ... assigned via "Request Service"
  // on Export/Import Services) were never screened at all — only the 13 party-role slots were.
  // A sanctioned vendor picked as a Loading/Pickup/Delivery/etc. provider was invisible to
  // compliance screening even though it's a real counterparty on the shipment. Cancelled
  // services are excluded (nothing to declare against a withdrawn order).
  const serviceVendors = db.prepare(
    "SELECT side, service_type, vendor_name, vendor_id FROM shipment_services WHERE shipment_id=? AND status != 'Cancelled'"
  ).all(shipmentId).map(r => [`${r.side} ${r.service_type} Vendor`, r.vendor_name, r.vendor_id]);
  for (const [field, name, customerId] of [...fixedParties, ...additionalParties, ...serviceVendors]) {
    if (!name || !name.trim()) continue;
    const nameMatch = sanctionsMap.get(normSanctionName(name));
    if (nameMatch) {
      hits.push({ field, value: name, matchedEntry: nameMatch.entityName, program: nameMatch.program, source: nameMatch.source });
      continue;
    }
    const custResult = customerId ? await getCustomerScreeningResult(customerId) : null;
    if (custResult === 'HIT') {
      hits.push({ field, value: name, matchedEntry: `${name} — flagged at the customer level (name on this shipment may be outdated)`, program: 'OFAC-SDN', source: 'customer_screenings' });
    }
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
  if (!currency || currency === "USD") return roundCents(amount);
  const rates = await getFxRates();
  const rate = rates[currency];
  return rate ? roundCents(amount / rate) : roundCents(amount);
}

// Credit Control's own AR/exposure computation (v0.73.0, TKT-O4DNFX/TKT-AJAEDO) — moved here
// from routes/customers.js (v0.73.1, TKT-GLWMFP) so routes/shipment-ops.js's invoice-generation
// gate can reuse the exact same figures the credit-status endpoint and the trade-lane override
// queue both already show, rather than a second, drifting computation. outstandingAr/
// committedExposure are already USD-equivalent (each line's own amount * exchange_rate at
// posting time), same convention as every other cost-line USD figure in this codebase.
function computeArExposure(customerId, creditTermsDays) {
  const shipmentIds = db.prepare(
    "SELECT id FROM shipments WHERE principal_id=? OR consignee_id=?"
  ).all(customerId, customerId).map(r => r.id);

  let outstandingAr = 0;
  const coveredLineIds = new Set();
  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const todayMs = Date.now();

  if (shipmentIds.length) {
    const placeholders = shipmentIds.map(() => '?').join(',');
    const docs = db.prepare(
      `SELECT * FROM shipment_documents WHERE shipment_id IN (${placeholders}) AND doc_type IN ('FR01','FR02') AND status='confirmed'`
    ).all(...shipmentIds);
    for (const doc of docs) {
      const sourceIds = doc.source_cost_line_ids ? JSON.parse(doc.source_cost_line_ids) : null;
      const lines = sourceIds && sourceIds.length
        ? db.prepare(`SELECT id, amount, exchange_rate FROM shipment_cost_lines WHERE id IN (${sourceIds.map(() => '?').join(',')})`).all(...sourceIds)
        : db.prepare("SELECT id, amount, exchange_rate FROM shipment_cost_lines WHERE shipment_id=? AND type='SELL' AND container_id=?").all(doc.shipment_id, doc.container_id || '');
      const docTotal = lines.reduce((s, l) => s + l.amount * l.exchange_rate, 0);
      for (const l of lines) coveredLineIds.add(l.id);
      // Mark as Paid (TKT-NQ87D3) — paid_amount is recorded in the same USD-equivalent unit as
      // docTotal itself (never the invoice's own display currency, which can differ per line —
      // see buildFreightInvoiceHtml's multi-currency handling). A partial payment reduces this
      // invoice's own contribution to both outstandingAr and its aging bucket, floored at 0
      // (never negative even if somehow overpaid) — it does NOT reset the aging clock to the
      // payment date; the remainder still ages from the original confirmed_at, matching standard
      // AR treatment (a partial payment shrinks the balance, it doesn't make the debt younger).
      const netOutstanding = Math.max(0, docTotal - (doc.paid_amount || 0));
      outstandingAr += netOutstanding;

      const refDate = doc.confirmed_at || doc.created_at;
      const dueMs = new Date(refDate).getTime() + (creditTermsDays || 0) * 86400000;
      const daysOverdue = Math.floor((todayMs - dueMs) / 86400000);
      if      (daysOverdue <= 0)  aging.current  += netOutstanding;
      else if (daysOverdue <= 30) aging.d1_30    += netOutstanding;
      else if (daysOverdue <= 60) aging.d31_60   += netOutstanding;
      else if (daysOverdue <= 90) aging.d61_90   += netOutstanding;
      else                        aging.d90_plus += netOutstanding;
    }
  }

  let committedExposure = 0;
  if (shipmentIds.length) {
    const placeholders = shipmentIds.map(() => '?').join(',');
    const sellLines = db.prepare(
      `SELECT id, amount, exchange_rate FROM shipment_cost_lines WHERE shipment_id IN (${placeholders}) AND type='SELL'`
    ).all(...shipmentIds);
    for (const l of sellLines) if (!coveredLineIds.has(l.id)) committedExposure += l.amount * l.exchange_rate;
  }

  return {
    outstandingAr: roundCents(outstandingAr),
    committedExposure: roundCents(committedExposure),
    aging: Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, roundCents(v)])),
  };
}

// Row-level amount resolution for one FR01/FR02 doc — same source_cost_line_ids-first, live-
// container-scoped-fallback logic computeArExposure above already uses for AR, factored out so
// both the Billing Performance report (routes/reports.js) and the dunning sweep below share one
// implementation instead of drifting apart.
function docAmountUsd(doc) {
  const sourceIds = doc.source_cost_line_ids ? JSON.parse(doc.source_cost_line_ids) : null;
  const lines = sourceIds && sourceIds.length
    ? db.prepare(`SELECT amount, exchange_rate FROM shipment_cost_lines WHERE id IN (${sourceIds.map(() => '?').join(',')})`).all(...sourceIds)
    : db.prepare("SELECT amount, exchange_rate FROM shipment_cost_lines WHERE shipment_id=? AND type='SELL' AND container_id=?").all(doc.shipment_id, doc.container_id || '');
  return roundCents(lines.reduce((s, l) => s + l.amount * l.exchange_rate, 0));
}

// ─── Overdue-invoice reminder sweep (Story TKT-4TEYT1, Epic TKT-KR6ZBT) ───────
// Configurable per-customer, not one fixed schedule — a same-day payer and an end-of-month
// consolidator should never get the same cadence, per direct request. "Is this invoice overdue"
// is already fully answered by the existing credit_terms_days-anchored due-date math (same
// formula computeArExposure's aging and the Billing Performance report's daysOverdue already
// use) — this sweep only adds the separate opt-in/cadence layer: reminder_enabled gates whether
// a customer gets reminders at all (default off), reminder_interval_days controls repeats
// (null/0 = a single reminder, never repeated). Reuses the exact EMO-office-mail machinery the
// manual send-email route already uses — same clean-failure-per-recipient behavior, a customer
// with no configured office mail settings or no email on file is skipped, not a hard error that
// aborts the whole sweep.
async function runDunningSweep() {
  const sent = [];
  const rows = db.prepare(`
    SELECT d.*, s.principal_id, s.principal_name, s.consignee_id, s.consignee_name, s.emo_office_id
    FROM shipment_documents d
    JOIN shipments s ON s.id = d.shipment_id
    WHERE d.doc_type IN ('FR01','FR02') AND d.status='confirmed'
  `).all();

  const nowMs = Date.now();
  for (const r of rows) {
    const respId = r.principal_id || r.consignee_id || null;
    if (!respId) continue;
    const cust = db.prepare("SELECT * FROM customers WHERE id=?").get(respId);
    if (!cust || !cust.reminder_enabled) continue;

    const amountUsd = docAmountUsd(r);
    const outstandingUsd = Math.max(0, roundCents(amountUsd - (r.paid_amount || 0)));
    if (outstandingUsd <= 0) continue;

    const refDate = r.confirmed_at || r.created_at;
    const dueMs = new Date(refDate).getTime() + (cust.credit_terms_days || 0) * 86400000;
    const daysOverdue = Math.floor((nowMs - dueMs) / 86400000);
    if (daysOverdue <= 0) continue;

    if (r.last_reminder_sent_at) {
      if (!cust.reminder_interval_days) continue; // no repeat configured — already reminded once
      const daysSinceLast = Math.floor((nowMs - new Date(r.last_reminder_sent_at).getTime()) / 86400000);
      if (daysSinceLast < cust.reminder_interval_days) continue;
    }

    if (!r.emo_office_id) continue; // same EMO-only resolution the manual send-email route uses
    const mailSettings = db.prepare("SELECT * FROM office_mail_settings WHERE office_id=? AND is_active=1").get(r.emo_office_id);
    if (!mailSettings) continue; // no configured SMTP for this office — skip, don't error the whole sweep
    const primaryContact = db.prepare("SELECT email FROM customer_contacts WHERE customer_id=? AND is_primary=1").get(cust.id);
    const to = (primaryContact?.email || cust.email || '').trim();
    if (!to) continue;

    try {
      const filePath = path.join(UPLOADS_DIR, r.stored_name);
      const mailOptions = buildMailOptions({
        from: mailSettings.from_address, fromName: mailSettings.from_name,
        to,
        subject: `Payment reminder — invoice ${r.filename} (${daysOverdue}d overdue)`,
        message: `This is an automated reminder that invoice ${r.filename} for ${cust.company_name}, `
          + `totaling $${outstandingUsd.toFixed(2)} outstanding, is ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} past its due date. `
          + `Please arrange payment at your earliest convenience, or contact us if this has already been settled.`,
        ...(fs.existsSync(filePath) ? { attachmentPath: filePath, attachmentFilename: r.filename } : {}),
      });
      await sendViaOffice(db, r.emo_office_id, mailOptions);
      db.prepare("UPDATE shipment_documents SET last_reminder_sent_at=? WHERE id=?").run(new Date().toISOString(), r.id);
      logEntityEvent('document', r.id, 'REMINDER_SENT', null, null, null,
        JSON.stringify({ shipmentId: r.shipment_id, customerId: cust.id, to, daysOverdue, outstandingUsd }));
      sent.push({ docId: r.id, shipmentId: r.shipment_id, customerId: cust.id, companyName: cust.company_name, daysOverdue, outstandingUsd });
    } catch (e) {
      console.warn(`Dunning reminder failed for ${r.id}:`, e.message);
    }
  }
  return sent;
}

// Scheduled / emailed reports (TKT-IXAR9G) — same daily-tick-re-evaluate-everything shape as
// runDunningSweep just above, for the same reason: last_run_at + each report's own frequency
// already tells us exactly what's due on every run, so there's no need for OFAC/CSL's more
// complex precise-single-timer machinery. report_type is a small dispatch key, deliberately
// narrow this pass (only 'shipments-csv' — the ticket's own cheapest, most representative
// case); ctx.buildShipmentsCsvReport is handed back from routes/export.js at boot, since the
// actual CSV-building logic lives in that file's closure, not here.
async function runScheduledReportsSweep() {
  const sent = [];
  const DUE_DAYS = { daily: 1, weekly: 7, monthly: 30 };
  const reports = db.prepare("SELECT * FROM scheduled_reports WHERE is_active=1").all();
  const nowMs = Date.now();

  for (const r of reports) {
    const thresholdDays = DUE_DAYS[r.frequency] ?? 7;
    const lastRunMs = r.last_run_at ? new Date(r.last_run_at).getTime() : 0; // never run -> due now
    if ((nowMs - lastRunMs) / 86400000 < thresholdDays) continue;

    const recipients = r.recipients.split(",").map(s => s.trim()).filter(Boolean);
    if (recipients.length === 0) continue;
    const mailSettings = db.prepare("SELECT * FROM office_mail_settings WHERE office_id=? AND is_active=1").get(r.office_id);
    if (!mailSettings) continue;

    let report;
    if (r.report_type === 'shipments-csv') report = ctx.buildShipmentsCsvReport();
    else { console.warn(`Unknown scheduled report type: ${r.report_type}`); continue; }

    try {
      const mailOptions = buildMailOptions({
        from: mailSettings.from_address, fromName: mailSettings.from_name,
        to: recipients.join(","),
        subject: `Scheduled Report — ${report.filename}`,
        message: `Attached is your ${r.frequency} scheduled report, generated automatically by CargoDesk.`,
        attachmentContent: report.csv, attachmentFilename: report.filename, attachmentContentType: "text/csv",
      });
      await sendViaOffice(db, r.office_id, mailOptions);
      db.prepare("UPDATE scheduled_reports SET last_run_at=? WHERE id=?").run(new Date().toISOString(), r.id);
      logEntityEvent('scheduled_report', r.id, 'REPORT_SENT', null, null, null,
        JSON.stringify({ reportType: r.report_type, recipients, frequency: r.frequency }));
      sent.push({ id: r.id, reportType: r.report_type, recipients, filename: report.filename });
    } catch (e) {
      console.warn(`Scheduled report ${r.id} failed:`, e.message);
    }
  }
  return sent;
}

// ─── Invoice Collections thresholds + sweep (Epic TKT-G11AHW) ─────────────────
const DEFAULT_ALERT_DAYS = 5;
const DEFAULT_ESCALATION_DAYS = 8;

// Resolution order, most specific wins — same "specific override beats general default" shape
// this codebase already uses elsewhere (a pack item's own HS code override falling back to its
// container's, a customer's own currency default vs. the country default): the shipment's own
// EMO office's thresholds, then that office's own country, then the hardcoded default. Both the
// report and the sweep call this so they can never disagree on what "overdue" means for a given
// shipment.
function resolveInvoiceThresholds(emoOfficeId) {
  const office = emoOfficeId ? db.prepare("SELECT * FROM offices WHERE id=?").get(emoOfficeId) : null;
  if (office?.invoice_alert_business_days != null && office?.invoice_escalation_business_days != null) {
    return { alertBusinessDays: office.invoice_alert_business_days, escalationBusinessDays: office.invoice_escalation_business_days };
  }
  const country = office?.country_code ? db.prepare("SELECT * FROM countries WHERE iso2=?").get(office.country_code) : null;
  return {
    alertBusinessDays: office?.invoice_alert_business_days ?? country?.invoice_alert_business_days ?? DEFAULT_ALERT_DAYS,
    escalationBusinessDays: office?.invoice_escalation_business_days ?? country?.invoice_escalation_business_days ?? DEFAULT_ESCALATION_DAYS,
  };
}

// Mirrors runDunningSweep()'s exact daily-interval, re-evaluate-everything shape — a resolved
// threshold + each document's own collections_alerted_at/collections_escalated_at timestamp
// already tells us what's due on every run, no need for more complex single-timer machinery.
// An active override (invoice_status_overrides, most recent row per document) suppresses BOTH
// the alert and the escalation entirely — the whole reason Trade Manager override authority
// exists (an explained end-of-month payment cycle isn't a collections problem to keep escalating).
async function runInvoiceCollectionsSweep() {
  const sent = [];
  const rows = db.prepare(`
    SELECT d.*, s.emo_office_id
    FROM shipment_documents d
    JOIN shipments s ON s.id = d.shipment_id
    WHERE d.doc_type IN ('FR01','FR02') AND d.status='confirmed'
  `).all();

  const todayIso = new Date().toISOString();
  for (const r of rows) {
    const amountUsd = docAmountUsd(r);
    const outstandingUsd = Math.max(0, roundCents(amountUsd - (r.paid_amount || 0)));
    if (outstandingUsd <= 0) continue;

    const activeOverride = db.prepare(
      "SELECT * FROM invoice_status_overrides WHERE document_id=? ORDER BY overridden_at DESC LIMIT 1"
    ).get(r.id);
    if (activeOverride) continue;

    const { alertBusinessDays, escalationBusinessDays } = resolveInvoiceThresholds(r.emo_office_id);
    const refDate = r.confirmed_at || r.created_at;
    const elapsed = businessDaysBetween(refDate, todayIso);

    if (elapsed >= alertBusinessDays && !r.collections_alerted_at) {
      const ownerId = r.invoice_owner_id;
      const owner = ownerId ? db.prepare("SELECT * FROM users WHERE id=?").get(ownerId) : null;
      const mailSettings = r.emo_office_id ? db.prepare("SELECT * FROM office_mail_settings WHERE office_id=? AND is_active=1").get(r.emo_office_id) : null;
      if (owner?.email && mailSettings) {
        try {
          const mailOptions = buildMailOptions({
            from: mailSettings.from_address, fromName: mailSettings.from_name,
            to: owner.email,
            subject: `Invoice ${r.filename} is now overdue — Shipment ${r.shipment_id}`,
            message: `This invoice has passed its ${alertBusinessDays}-business-day collections threshold with no payment recorded. Please follow up with the customer or record an override with a reason if there's a known cause (e.g. end-of-month payment terms).`,
          });
          await sendViaOffice(db, r.emo_office_id, mailOptions);
          sent.push({ id: r.id, shipmentId: r.shipment_id, stage: 'alert', to: owner.email });
        } catch (e) { console.warn(`Invoice collections alert ${r.id} failed:`, e.message); }
      }
      db.prepare("UPDATE shipment_documents SET collections_alerted_at=? WHERE id=?").run(todayIso, r.id);
    }

    if (elapsed >= escalationBusinessDays && !r.collections_escalated_at) {
      const office = r.emo_office_id ? db.prepare("SELECT * FROM offices WHERE id=?").get(r.emo_office_id) : null;
      const manager = office?.manager_user_id ? db.prepare("SELECT * FROM users WHERE id=?").get(office.manager_user_id) : null;
      const mailSettings = r.emo_office_id ? db.prepare("SELECT * FROM office_mail_settings WHERE office_id=? AND is_active=1").get(r.emo_office_id) : null;
      if (manager?.email && mailSettings) {
        try {
          const mailOptions = buildMailOptions({
            from: mailSettings.from_address, fromName: mailSettings.from_name,
            to: manager.email,
            subject: `Escalation — invoice ${r.filename} still unpaid — Shipment ${r.shipment_id}`,
            message: `This invoice has now passed its ${escalationBusinessDays}-business-day escalation threshold with no payment recorded and no override on file.`,
          });
          await sendViaOffice(db, r.emo_office_id, mailOptions);
          sent.push({ id: r.id, shipmentId: r.shipment_id, stage: 'escalation', to: manager.email });
        } catch (e) { console.warn(`Invoice collections escalation ${r.id} failed:`, e.message); }
      } else {
        console.warn(`Invoice collections escalation ${r.id} skipped — no branch manager configured for office ${r.emo_office_id || '(none)'}`);
      }
      db.prepare("UPDATE shipment_documents SET collections_escalated_at=? WHERE id=?").run(todayIso, r.id);
    }
  }
  return sent;
}
setInterval(() => { runInvoiceCollectionsSweep().catch(e => console.error("Invoice collections sweep failed:", e.message)); }, 24 * 60 * 60 * 1000);

// ─── Backfill transit_days on generated schedules ─────────────────────────────
// POST /api/schedules (Schedule Generator) unconditionally hardcoded transit_days to 0 at
// insert time instead of deriving it from etd/eta — every schedule created through the
// Generator before this fix has a wrong "0d" transit shown wherever it surfaces (the catalog
// browser, Add Sailing search results). Purely a computed value with no user input involved,
// so a one-time backfill is safe — only touches rows the bug actually affected (source =
// 'generated', transit_days still 0, real etd/eta both present with eta after etd).
// Safe to re-run — already-fixed rows (transit_days > 0) are left untouched.
(function backfillGeneratedScheduleTransitDays() {
  // Originally scoped to source='generated' only (the Schedule Generator's own bug — see the
  // v0.54.3 changelog). Broadened: a shipment committing a catalog-picked sailing (source=
  // 'search') copies the picked sailing's own fields via a plain object spread on the frontend
  // (ShipmentSchedulesPage.jsx's commitSailing) — any commit made *before* the generator fix
  // above landed baked in the same wrong 0 permanently, since a copy is a point-in-time
  // snapshot, not a live reference back to its template. Same safe condition either way: only
  // rows that are still exactly 0 with a real, positive etd/eta span are touched.
  const info = db.prepare(`
    UPDATE shipment_schedules
    SET transit_days = CAST(ROUND(julianday(eta) - julianday(etd)) AS INTEGER)
    WHERE transit_days = 0
      AND etd != '' AND eta != '' AND julianday(eta) > julianday(etd)
  `).run();
  if (info.changes > 0)
    console.log(`  ✔ Backfilled transit_days on ${info.changes.toLocaleString()} schedule row(s)`);
})();

// ─── Backfill garbled AIS-sourced vessel names ─────────────────────────────────
// Direct bug report: real vessels (confirmed against a third-party AIS tracker) showing garbled
// names like "#!C?7($GA@A7S%I@SCP," instead of their real name (e.g. "DE VERWONDERING") — see
// lib/ais-listener.js's PLAUSIBLE_VESSEL_NAME for why this is a Name-field-only decode issue
// upstream, not a bad IMO/MMSI (those stay untouched here). One-time cleanup for rows already
// corrupted before that fix landed — clears the name back to blank rather than guessing a
// replacement, so AIS's own next clean ShipStaticData message for that vessel repopulates it
// naturally (now filtered through the same plausibility check). Safe to re-run on every startup
// — a no-op once every already-corrupted row has been cleared.
(function backfillGarbledVesselNames() {
  const PLAUSIBLE_VESSEL_NAME = /^[A-Z0-9 .\-']{1,30}$/;
  const rows = db.prepare("SELECT imo, name FROM vessels WHERE name IS NOT NULL AND name != ''").all();
  let cleared = 0;
  for (const v of rows) {
    if (!PLAUSIBLE_VESSEL_NAME.test(String(v.name).toUpperCase())) {
      db.prepare("UPDATE vessels SET name='' WHERE imo=?").run(v.imo);
      cleared++;
    }
  }
  if (cleared > 0) console.log(`  ✔ Cleared ${cleared.toLocaleString()} garbled AIS vessel name(s)`);
})();

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

// ─── Backfill timezone on port_locations ──────────────────────────────────────
// Single-TZ countries use a direct IANA map; multi-TZ countries (US, CA, AU,
// RU, BR, MX, ID) use longitude bands. Safe to re-run — only touches NULL rows.
(function backfillPortTimezones() {
  const nullCount = db.prepare(
    "SELECT COUNT(*) AS n FROM port_locations WHERE timezone IS NULL OR timezone=''"
  ).get().n;
  if (nullCount === 0) return;

  const COUNTRY_TZ = {
    // Europe
    AD:"Europe/Andorra",  AL:"Europe/Tirane",    AT:"Europe/Vienna",
    BA:"Europe/Sarajevo", BE:"Europe/Brussels",  BG:"Europe/Sofia",
    BY:"Europe/Minsk",    CH:"Europe/Zurich",    CZ:"Europe/Prague",
    DE:"Europe/Berlin",   DK:"Europe/Copenhagen",EE:"Europe/Tallinn",
    ES:"Europe/Madrid",   FI:"Europe/Helsinki",  FR:"Europe/Paris",
    GB:"Europe/London",   GI:"Europe/Gibraltar", GR:"Europe/Athens",
    HR:"Europe/Zagreb",   HU:"Europe/Budapest",  IE:"Europe/Dublin",
    IS:"Atlantic/Reykjavik",IT:"Europe/Rome",    LI:"Europe/Vaduz",
    LT:"Europe/Vilnius",  LU:"Europe/Luxembourg",LV:"Europe/Riga",
    MC:"Europe/Monaco",   MD:"Europe/Chisinau",  ME:"Europe/Podgorica",
    MK:"Europe/Skopje",   MT:"Europe/Malta",     NL:"Europe/Amsterdam",
    NO:"Europe/Oslo",     PL:"Europe/Warsaw",    PT:"Europe/Lisbon",
    RO:"Europe/Bucharest",RS:"Europe/Belgrade",  SE:"Europe/Stockholm",
    SI:"Europe/Ljubljana",SK:"Europe/Bratislava",SM:"Europe/San_Marino",
    TR:"Europe/Istanbul", UA:"Europe/Kiev",      XK:"Europe/Belgrade",
    // Caucasus / Central Asia
    AM:"Asia/Yerevan",    AZ:"Asia/Baku",        GE:"Asia/Tbilisi",
    KG:"Asia/Bishkek",    TJ:"Asia/Dushanbe",    TM:"Asia/Ashgabat",
    UZ:"Asia/Tashkent",   KZ:"Asia/Almaty",
    // Middle East
    AE:"Asia/Dubai",      AF:"Asia/Kabul",       BH:"Asia/Bahrain",
    CY:"Asia/Nicosia",    IQ:"Asia/Baghdad",     IR:"Asia/Tehran",
    IL:"Asia/Jerusalem",  JO:"Asia/Amman",       KW:"Asia/Kuwait",
    LB:"Asia/Beirut",     OM:"Asia/Muscat",      QA:"Asia/Qatar",
    SA:"Asia/Riyadh",     SY:"Asia/Damascus",    YE:"Asia/Aden",
    // Asia (single-TZ)
    BD:"Asia/Dhaka",      BN:"Asia/Brunei",      BT:"Asia/Thimphu",
    CN:"Asia/Shanghai",   HK:"Asia/Hong_Kong",   JP:"Asia/Tokyo",
    KH:"Asia/Phnom_Penh", KP:"Asia/Pyongyang",   KR:"Asia/Seoul",
    LA:"Asia/Vientiane",  LK:"Asia/Colombo",     MM:"Asia/Rangoon",
    MN:"Asia/Ulaanbaatar",MO:"Asia/Macau",       MV:"Indian/Maldives",
    MY:"Asia/Kuala_Lumpur",NP:"Asia/Kathmandu",  PH:"Asia/Manila",
    PK:"Asia/Karachi",    SG:"Asia/Singapore",   TH:"Asia/Bangkok",
    TL:"Asia/Dili",       TW:"Asia/Taipei",      VN:"Asia/Ho_Chi_Minh",
    // Africa
    DZ:"Africa/Algiers",  EG:"Africa/Cairo",     ER:"Africa/Asmara",
    ET:"Africa/Addis_Ababa",GH:"Africa/Accra",   KE:"Africa/Nairobi",
    LY:"Africa/Tripoli",  MA:"Africa/Casablanca",MG:"Indian/Antananarivo",
    MU:"Indian/Mauritius",MW:"Africa/Blantyre",  MZ:"Africa/Maputo",
    NA:"Africa/Windhoek", NE:"Africa/Niamey",    NG:"Africa/Lagos",
    RE:"Indian/Reunion",  RW:"Africa/Kigali",    SC:"Indian/Mahe",
    SD:"Africa/Khartoum", SN:"Africa/Dakar",     SO:"Africa/Mogadishu",
    SS:"Africa/Juba",     SZ:"Africa/Mbabane",   TD:"Africa/Ndjamena",
    TG:"Africa/Lome",     TN:"Africa/Tunis",     TZ:"Africa/Dar_es_Salaam",
    UG:"Africa/Kampala",  ZA:"Africa/Johannesburg",ZM:"Africa/Lusaka",
    ZW:"Africa/Harare",   CI:"Africa/Abidjan",   CM:"Africa/Douala",
    // Americas – single-TZ
    AG:"America/Antigua", AW:"America/Aruba",    BB:"America/Barbados",
    BL:"America/St_Barthelemy",BM:"America/Bermuda",BS:"America/Nassau",
    BZ:"America/Belize",  BO:"America/La_Paz",   CO:"America/Bogota",
    CR:"America/Costa_Rica",CU:"America/Havana",  DM:"America/Dominica",
    DO:"America/Santo_Domingo",EC:"America/Guayaquil",FK:"Atlantic/Stanley",
    GD:"America/Grenada", GF:"America/Cayenne",  GP:"America/Guadeloupe",
    GT:"America/Guatemala",GY:"America/Guyana",  HN:"America/Tegucigalpa",
    HT:"America/Port-au-Prince",JM:"America/Jamaica",KN:"America/St_Kitts",
    KY:"America/Cayman",  LC:"America/St_Lucia", MQ:"America/Martinique",
    MS:"America/Montserrat",NI:"America/Managua", PA:"America/Panama",
    PE:"America/Lima",    PR:"America/Puerto_Rico",PY:"America/Asuncion",
    SR:"America/Paramaribo",SV:"America/El_Salvador",TC:"America/Grand_Turk",
    TT:"America/Port_of_Spain",UY:"America/Montevideo",VC:"America/St_Vincent",
    VE:"America/Caracas", VG:"America/Tortola",  VI:"America/St_Thomas",
    // Pacific
    CK:"Pacific/Rarotonga",FJ:"Pacific/Fiji",    GU:"Pacific/Guam",
    KI:"Pacific/Tarawa",  NC:"Pacific/Noumea",   NF:"Pacific/Norfolk",
    NR:"Pacific/Nauru",   NU:"Pacific/Niue",     NZ:"Pacific/Auckland",
    PF:"Pacific/Tahiti",  PG:"Pacific/Port_Moresby",PW:"Pacific/Palau",
    SB:"Pacific/Guadalcanal",TO:"Pacific/Tongatapu",TV:"Pacific/Funafuti",
    VU:"Pacific/Efate",   WS:"Pacific/Apia",
  };

  for (const [cc, tz] of Object.entries(COUNTRY_TZ)) {
    db.prepare(
      "UPDATE port_locations SET timezone=? WHERE SUBSTR(unlocode,1,2)=? AND (timezone IS NULL OR timezone='')"
    ).run(tz, cc);
  }

  // US – longitude bands (Eastern / Central / Mountain / Pacific / Hawaii)
  db.prepare(`UPDATE port_locations SET timezone = CASE
    WHEN longitude <= -140 THEN 'America/Honolulu'
    WHEN longitude <= -120 THEN 'America/Los_Angeles'
    WHEN longitude <= -105 THEN 'America/Denver'
    WHEN longitude <= -90  THEN 'America/Chicago'
    ELSE 'America/New_York' END
    WHERE SUBSTR(unlocode,1,2)='US' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`).run();
  db.prepare("UPDATE port_locations SET timezone='America/New_York' WHERE SUBSTR(unlocode,1,2)='US' AND (timezone IS NULL OR timezone='')").run();

  // Canada
  db.prepare(`UPDATE port_locations SET timezone = CASE
    WHEN longitude <= -120 THEN 'America/Vancouver'
    WHEN longitude <= -95  THEN 'America/Winnipeg'
    WHEN longitude <= -73  THEN 'America/Toronto'
    ELSE 'America/Halifax' END
    WHERE SUBSTR(unlocode,1,2)='CA' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`).run();
  db.prepare("UPDATE port_locations SET timezone='America/Toronto' WHERE SUBSTR(unlocode,1,2)='CA' AND (timezone IS NULL OR timezone='')").run();

  // Australia
  db.prepare(`UPDATE port_locations SET timezone = CASE
    WHEN longitude < 129 THEN 'Australia/Perth'
    WHEN longitude < 138 THEN 'Australia/Darwin'
    WHEN longitude < 141 THEN 'Australia/Adelaide'
    ELSE 'Australia/Sydney' END
    WHERE SUBSTR(unlocode,1,2)='AU' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`).run();
  db.prepare("UPDATE port_locations SET timezone='Australia/Sydney' WHERE SUBSTR(unlocode,1,2)='AU' AND (timezone IS NULL OR timezone='')").run();

  // Russia
  db.prepare(`UPDATE port_locations SET timezone = CASE
    WHEN longitude < 60  THEN 'Europe/Moscow'
    WHEN longitude < 73  THEN 'Asia/Yekaterinburg'
    WHEN longitude < 84  THEN 'Asia/Omsk'
    WHEN longitude < 98  THEN 'Asia/Krasnoyarsk'
    WHEN longitude < 114 THEN 'Asia/Irkutsk'
    WHEN longitude < 130 THEN 'Asia/Yakutsk'
    WHEN longitude < 143 THEN 'Asia/Vladivostok'
    ELSE 'Asia/Magadan' END
    WHERE SUBSTR(unlocode,1,2)='RU' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`).run();
  db.prepare("UPDATE port_locations SET timezone='Europe/Moscow' WHERE SUBSTR(unlocode,1,2)='RU' AND (timezone IS NULL OR timezone='')").run();

  // Brazil
  db.prepare(`UPDATE port_locations SET timezone = CASE
    WHEN longitude < -50 THEN 'America/Manaus'
    ELSE 'America/Sao_Paulo' END
    WHERE SUBSTR(unlocode,1,2)='BR' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`).run();
  db.prepare("UPDATE port_locations SET timezone='America/Sao_Paulo' WHERE SUBSTR(unlocode,1,2)='BR' AND (timezone IS NULL OR timezone='')").run();

  // Mexico
  db.prepare(`UPDATE port_locations SET timezone = CASE
    WHEN longitude < -106 THEN 'America/Tijuana'
    WHEN longitude < -98  THEN 'America/Mazatlan'
    ELSE 'America/Mexico_City' END
    WHERE SUBSTR(unlocode,1,2)='MX' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`).run();
  db.prepare("UPDATE port_locations SET timezone='America/Mexico_City' WHERE SUBSTR(unlocode,1,2)='MX' AND (timezone IS NULL OR timezone='')").run();

  // Indonesia
  db.prepare(`UPDATE port_locations SET timezone = CASE
    WHEN longitude < 116 THEN 'Asia/Jakarta'
    WHEN longitude < 124 THEN 'Asia/Makassar'
    ELSE 'Asia/Jayapura' END
    WHERE SUBSTR(unlocode,1,2)='ID' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`).run();
  db.prepare("UPDATE port_locations SET timezone='Asia/Jakarta' WHERE SUBSTR(unlocode,1,2)='ID' AND (timezone IS NULL OR timezone='')").run();

  const filled = nullCount - db.prepare(
    "SELECT COUNT(*) AS n FROM port_locations WHERE timezone IS NULL OR timezone=''"
  ).get().n;
  if (filled > 0)
    console.log(`  ✔ Backfilled timezone on ${filled.toLocaleString()} port rows`);
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

(function seedDefaultProject() {
  try {
    const existing = db.prepare("SELECT COUNT(*) as n FROM kb_projects").get();
    if (existing.n > 0) return;
    const projectId = `PRJ-${uid()}`;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO kb_projects (id,name,key,color,description,created_at) VALUES (?,?,?,?,?,?)")
      .run(projectId, 'Main Board', 'MAIN', '#6366f1', 'Default project board', now);
    const DEFAULT_COLUMNS = [
      { name: 'Ready',           color: '#6366f1' },
      { name: 'In Progress',     color: '#f59e0b' },
      { name: 'In Testing',      color: '#06b6d4' },
      { name: 'Testing Failed',  color: '#ef4444' },
      { name: 'Ready to Deploy', color: '#f97316' },
      { name: 'Done',            color: '#22c55e' },
      { name: 'Released',        color: '#8b5cf6' },
    ];
    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
      db.prepare("INSERT INTO kb_columns (id,project_id,name,position,color,created_at) VALUES (?,?,?,?,?,?)")
        .run(`COL-${uid()}`, projectId, DEFAULT_COLUMNS[i].name, i, DEFAULT_COLUMNS[i].color, now);
    }
    console.log('  ✔ Seeded default project board with 7 columns');
  } catch (e) { console.warn('  ⚠ Could not seed default project:', e.message); }
})();

// Assign any tickets that predate the project column to the first project.
(function backfillTicketProjects() {
  try {
    const firstProject = db.prepare("SELECT id FROM kb_projects ORDER BY created_at ASC LIMIT 1").get();
    if (!firstProject) return;
    const info = db.prepare("UPDATE tickets SET project_id=? WHERE project_id IS NULL").run(firstProject.id);
    if (info.changes > 0) console.log(`  ✔ Backfilled ${info.changes} ticket(s) → project ${firstProject.id}`);
  } catch (e) { console.warn('  ⚠ Could not backfill ticket projects:', e.message); }
})();

(function backfillTestItems() {
  try {
    const testTypes = ["Test Folder", "Test Plan", "Test Run", "Test Case"];
    const placeholders = testTypes.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM tickets WHERE type IN (${placeholders})`).all(...testTypes);
    if (rows.length === 0) return;

    const migratedIds = new Set(rows.map(r => r.id));
    db.exec("BEGIN");
    try {
      const insert = db.prepare(`
        INSERT INTO test_items
          (id, type, title, description, priority, status, position, created_at,
           shipment_id, parent_id, assignee_id, due_date, test_notes, project_id, version_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      let severedParents = 0;
      for (const r of rows) {
        const parentId = r.parent_id && migratedIds.has(r.parent_id) ? r.parent_id : null;
        if (r.parent_id && !parentId) severedParents++;
        insert.run(
          r.id, r.type, r.title, r.description, r.priority, r.status, r.position, r.created_at,
          r.shipment_id, parentId, r.assignee_id, r.due_date, r.test_notes, r.project_id, r.version_id
        );
      }

      const idPlaceholders = rows.map(() => "?").join(",");
      const linkRows = db.prepare(`
        SELECT id FROM ticket_links WHERE from_id IN (${idPlaceholders}) OR to_id IN (${idPlaceholders})
      `).all(...rows.map(r => r.id), ...rows.map(r => r.id));
      const deleteLink = db.prepare("DELETE FROM ticket_links WHERE id=?");
      for (const l of linkRows) deleteLink.run(l.id);

      const deleteTicket = db.prepare("DELETE FROM tickets WHERE id=?");
      for (const r of rows) deleteTicket.run(r.id);

      db.exec("COMMIT");
      console.log(`  ✔ Migrated ${rows.length} test artifact(s) to test_items` +
        (severedParents ? `; severed ${severedParents} dangling parent link(s)` : "") +
        (linkRows.length ? `; dropped ${linkRows.length} stale ticket_link(s)` : ""));
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } catch (e) { console.warn('  ⚠ test_items migration failed, rolled back:', e.message); }
})();

// ─── Map functions ────────────────────────────────────────────────────────────

// Carriers a booking request can be sent to. Single source of truth on ctx — routes/edi.js
// used to hand-copy this same Set locally (matching an equivalent copy on the frontend);
// centralized here so the two can't silently drift apart. This gates EDI booking eligibility
// only — the booking request/response itself is fully simulated (v0.35.0), not a real
// carrier integration; the once-separate "carriers you can search live schedules for" concept
// (routes/system.js's old MAERSK_CODES) is gone entirely (v0.72.0) along with the live Maersk
// developer-tools schedule/booking API it gated — schedule search is catalog-then-demo-only now.
const BOOKABLE_CARRIERS = new Set(["MAEU", "SAFM", "MCPU"]);

// eAdapter (carrier-EDI epic, story 1) — generalizes BOOKABLE_CARRIERS from a fixed 3-carrier
// set into "the built-in 3 OR any carrier with an active eAdapter config," gated behind one
// master toggle. Turning api_eadapter_enabled off blocks EVERY carrier, including the built-in
// 3 — a deliberate choice so the toggle governs the whole EDI-carrier-communication surface
// uniformly, with no special-casing; a carrier that isn't bookable already has a complete
// fallback lifecycle (manual Confirm with a hand-entered bookingRef, no EDI message ever sent),
// so "off" just means every carrier uses that same path.
//
// v0.83.0 — per-office scoping. A real carrier EDI relationship is negotiated per-country/
// per-branch, not once globally: a low-volume office is exactly the one a carrier is least
// inclined to bother configuring EDI for. carrier_eadapter_configs rows are now scoped to a
// specific office_id (see its own table comment); officeId is the shipment's own emo_office_id
// (Export Managing Office — the office actually handling the carrier relationship for this
// shipment, same field resolveInvoiceThresholds/sendViaOffice already key off). A shipment with
// no EMO office assigned yet can never match a scoped config — same "incomplete data means no,
// not yes" posture this codebase already takes elsewhere (e.g. a blank contractId never matches
// a contract). The built-in 3 (BOOKABLE_CARRIERS) are deliberately NOT office-scoped — they're a
// separate, pre-existing, always-simulated concept this pass didn't revisit.
function isEdiBookable(carrierCode, officeId) {
  if (getSettings().api_eadapter_enabled === 'false') return false;
  if (BOOKABLE_CARRIERS.has(carrierCode)) return true;
  if (!officeId) return false;
  const cfg = db.prepare("SELECT is_active FROM carrier_eadapter_configs WHERE carrier_code=? AND office_id=?").get(carrierCode, officeId);
  return !!cfg?.is_active;
}
// Fixed, curated additional party roles (Epic TKT-5XFCAP) — alongside the 4 hardcoded
// shipper/consignee/notify/principal roles on shipments. Frontend keeps its own copy in
// src/tokens.js (same split as BOOKABLE_CARRIERS — frontend/backend don't share a module).
// Customs Broker is split Export/Import (not a single role) since each shipment can only
// hold one party per role and the two are routinely handled by different brokers — also a
// deliberate setup for the later Customs & Regulatory Filing epic (TKT-XW6TQK). "Agent" (bare)
// is a generic, manually-picked catch-all with no carrier/port linkage — NOT the same concept
// as "Line Agent (Export/Import)" below, which is a specific carrier's local representative at
// a specific port, auto-resolved from the carrier_agents table (see resolveCarrierAgent) — the
// two are easy to confuse since they sit side by side in the same picker.
const ADDITIONAL_PARTY_ROLES = [
  "Forwarder", "Customs Broker (Export)", "Customs Broker (Import)",
  "Trucker (Pre-carriage)", "Trucker (On-carriage)",
  "Also Notify Party", "Bank", "Insurance Provider", "Agent",
  "Line Agent (Export)", "Line Agent (Import)", "NVOCC", "Co-Loading NVOCC",
];
// Customs & Regulatory Filing (Epic TKT-XW6TQK) — the two filing types a shipment can
// independently need, AES/EEI (export) and ISF/AMS (import). Simulated/mock only.
const CUSTOMS_FILING_TYPES = ["AES_EEI", "ISF_AMS"];

const LEG_LOC_ABBR = { 'Door': 'DR', 'Terminal': 'PT', 'Container Yard': 'CY', 'CFS': 'CFS', 'GPS Coordinates': 'GPS' };
const GPS_LOC_TYPE = 'GPS Coordinates';

const syncShipmentFromLegs = (shipmentId) => {
  const legs = db.prepare("SELECT * FROM shipment_legs WHERE shipment_id=? ORDER BY leg_order ASC").all(shipmentId);
  if (!legs.length) {
    // Every leg was just removed (e.g. unlinking a schedule) — the schedule-derived fields
    // this function writes are now stale and must be cleared, not left showing the last-known
    // sailing forever. pol/pod/carrier_code are shipment-level fields set independently at
    // creation (not purely leg-derived), so they're left untouched here.
    db.prepare(`UPDATE shipments SET etd='', eta='', vessel='', vessel_imo='', voyage='', routing_term=NULL WHERE id=?`).run(shipmentId);
    return;
  }
  const first = legs[0], last = legs[legs.length - 1];
  const seaLeg = legs.find(l => l.leg_type === 'SEA' || l.mot === 'SEA') || first;
  // Routing term: span from first carrier-arranged leg to last — Merchant's Haulage legs excluded
  const cLegs = legs.filter(l => !["Merchant's Haulage", "Customer Arranged"].includes(l.movement_type || l.mot));
  let routingTerm = null;
  if (cLegs.length > 0) {
    const a = cLegs[0].pol_loc_type || 'Terminal';
    const b = cLegs[cLegs.length - 1].pod_loc_type || 'Terminal';
    routingTerm = (LEG_LOC_ABBR[a] || a) + '-' + (LEG_LOC_ABBR[b] || b);
  }
  // Real bug found on a live shipment (SHP-L46XMM): this used to unconditionally roll the SEA
  // leg's own carrier up onto the shipment via COALESCE(NULLIF(?,''), carrier_code) — correct
  // for the "carrier decided leg-by-leg" case (blank shipment carrier, or no contract driving
  // it), but it silently clobbered a Central contract's own carrier the moment ANY leg carried
  // a different one, with no audit trail (this function writes via a bare UPDATE, never
  // logEvent) — the sailing search then read that now-wrong shipment.carrierCode and searched
  // the wrong carrier's schedules entirely, with no record anywhere of how it got that way.
  // A Central contract's carrier is the authoritative one once a contract is attached — a
  // leg's own carrier should never silently override it. Every other shipment (no Central
  // contract yet, or Central with the SAME carrier) keeps the exact prior roll-up behavior.
  const shipmentRow = db.prepare("SELECT carrier_code, contract_type, contract_id FROM shipments WHERE id=?").get(shipmentId);
  const contractLocksCarrier = shipmentRow?.contract_type === 'Central' && !!shipmentRow?.contract_id;
  const legCarrier = seaLeg.carrier_code || '';
  const newCarrierCode = contractLocksCarrier
    ? (shipmentRow.carrier_code || '')
    : (legCarrier || shipmentRow?.carrier_code || '');
  // first.pol/last.pod fall back to the SEA leg's own port when the bookending Pick-up/Delivery
  // leg is a classified GPS site (pol/pod blanked there by design) — the shipment's overall
  // pol/pod must still resolve to a real UN/LOCODE, since it feeds B/L generation, exports, and
  // every list/header surface that expects a real port.
  // etd/eta already double as the "confirmed once known" fields (AIS TKT-ZFO2OM) — when the AIS
  // listener updates a SEA leg's etd/eta in place after a confirmed departure/arrival, this
  // existing rollup carries it up to the shipment the same way it always has, no separate
  // atd/ata bookend needed.
  db.prepare(`UPDATE shipments SET pol=?, pod=?, etd=?, eta=?, carrier_code=?, vessel=?, vessel_imo=?, voyage=?, routing_term=? WHERE id=?`)
    .run(first.pol || seaLeg.pol || '', last.pod || seaLeg.pod || '', first.etd || null, last.eta || null,
         newCarrierCode, seaLeg.vessel || '', seaLeg.vessel_imo || '',
         seaLeg.voyage || '', routingTerm, shipmentId);
  // Closes the "no audit trail" half of the bug above — any future roll-up that actually
  // changes carrier_code (the legitimate blank-carrier/no-contract case) is now traceable the
  // same way a manual edit already is, instead of only ever showing up as an unexplained diff.
  if (shipmentRow && newCarrierCode !== (shipmentRow.carrier_code || '')) {
    logEvent(shipmentId, 'FIELD_UPDATED', 'carrier_code', shipmentRow.carrier_code || null, newCarrierCode || null,
      JSON.stringify({ source: 'syncShipmentFromLegs', legCarrier, seaLegId: seaLeg.id }));
  }
};

// Row-mapper functions (mapShipment, mapContainer, mapCustomer, etc.) live in lib/mappers.js —
// extracted since they're pure functions of a DB row, needing only portLanesMap (for
// mapShipment's tradeLane) and CUTOFF_WARNING_DAYS (for mapContainer's cutoff badges) threaded
// in, matching the createAisListener({ db, ... }) factory pattern already used in this codebase.
const CUTOFF_WARNING_DAYS = 3;
const {
  SVC_ABBR, longestLane, cutoffState, roundCents,
  mapShipment, mapShipmentLeg, mapCostLine, mapService, mapRateSnapshot, mapRateSnapshotLine,
  mapChargeCodeDefinition, mapContainer, mapContainerEvent, mapContainerPackage, mapShipmentParty, mapSideOffice,
  mapPackTypeDefinition, mapDutyRateChapter, mapScheduledReport, mapContainerTypeDefinition, mapAllocation, mapCarrier, mapVessel, mapPortLocation, mapLinkedPort,
  mapCarrierAgent, mapCarrierAgentScheduleRow, mapTradeLane, mapScopeItem, mapAccessConfig, mapOffice, mapOfficeMailSettings,
  mapSystemEmailSettings,
  mapBranch, mapOrgCountry, mapRegion, mapCountry, mapTicketLink, mapTicket, mapTestItem,
  mapTestCaseLink, mapEdiMessage, mapCarrierBooking, mapCustomsFiling, mapKbProject, mapKbVersion,
  mapKbColumn, mapCustomer, mapCustomerIdentifier, mapCustomerScreening, mapCustomerDoc,
  mapCustomerContact, mapCommodity, mapSystemMessage, mapMilestone, mapMilestoneTemplate,
  mapContract, mapLeg, mapRate, mapContractRouting, mapCarrierInvoice, mapCarrierInvoiceLine,
  mapQuote, mapQuoteLine, mapOpportunity,
  mapInvoiceReasonCode, mapInvoiceStatusOverride,
  mapEadapterConfig,
} = createMappers({ portLanesMap, CUTOFF_WARNING_DAYS });

function shipmentMatchesAccessConfig(s, cfg) {
  if (cfg.originLane) {
    const polLanes = portLanesMap[s.pol] || new Set();
    if (!polLanes.has(cfg.originLane)) return false;
  }
  if (cfg.destLane) {
    const podLanes = portLanesMap[s.pod] || new Set();
    if (!podLanes.has(cfg.destLane)) return false;
  }
  if (cfg.polCodes.length     && !cfg.polCodes.includes(s.pol))              return false;
  if (cfg.podCodes.length     && !cfg.podCodes.includes(s.pod))              return false;
  if (cfg.carrierCodes.length && !cfg.carrierCodes.includes(s.carrierCode))  return false;
  return true;
}

function matchesScopeItem(s, item) {
  if (item.item_type === 'trade_lane') {
    try {
      const { origin, dest } = JSON.parse(item.value);
      const polLanes = portLanesMap[s.pol] || new Set();
      const podLanes = portLanesMap[s.pod] || new Set();
      return polLanes.has(origin) && podLanes.has(dest);
    } catch { return false; }
  }
  if (item.item_type === 'pol')     return item.value === s.pol;
  if (item.item_type === 'country') return portCountryMap[s.pol] === item.value;
  return false;
}

// Credit Control Depth, third pass (TKT-GLWMFP) — "only the trade manager working that trade
// lane may ever override a credit block" is a direct, explicit business rule, not inferred: no
// fallback to admin/operator, and no fallback to a trade_manager whose own scope doesn't cover
// this shipment's lane. Plain role-membership check (req.user.roles.includes(...), matching
// requireRole's own convention exactly) rather than primaryRoleSV's effective-role/rank logic —
// trade_manager isn't the top of a hierarchy here, it's a specific, narrow grant that should
// hold even for a user who also carries a higher-ranked role.
// A credit_overrides row for an over-limit generation stays valid for this long after approval
// — a grace window, not strict single-use (see routes/shipment-ops.js's findOverLimitBlock for
// why: one logical "generate invoices" action can fire this route several times in a row for a
// per-container split, and single-use-on-first-call would silently re-block containers 2..N).
const OVERRIDE_GRACE_MS = 60 * 60 * 1000;

function userOwnsLaneForShipment(user, shipment) {
  if (!user?.roles?.includes('trade_manager') || !shipment) return false;
  const scopeItems = db.prepare(
    "SELECT * FROM user_scope_items WHERE user_id=? AND item_type='trade_lane'"
  ).all(user.id);
  return scopeItems.some(item => matchesScopeItem(shipment, item));
}

// Same authority, scoped to a customer rather than one shipment — true when ANY shipment where
// this customer is Shipper/Consignee/Principal falls in one of the user's own trade lanes.
// Deliberately broader than userOwnsLaneForShipment (credit_hold lives on the customer, not one
// shipment) but never broader than the user's own actual lane grants.
function userOwnsLaneForCustomer(user, customerId) {
  if (!user?.roles?.includes('trade_manager')) return false;
  const scopeItems = db.prepare(
    "SELECT * FROM user_scope_items WHERE user_id=? AND item_type='trade_lane'"
  ).all(user.id);
  if (!scopeItems.length) return false;
  const shipments = db.prepare(
    "SELECT pol, pod FROM shipments WHERE shipper_id=? OR consignee_id=? OR principal_id=?"
  ).all(customerId, customerId, customerId);
  return shipments.some(s => scopeItems.some(item => matchesScopeItem(s, item)));
}

// Involved Offices — per-side edit permission (Nested Office Groups follow-up, disaster-recovery
// reassignment). Who's allowed to CHANGE a shipment's Export or Import office assignment is a
// company-wide department fact, not tied to whichever specific office happens to hold it today —
// an Export-department (SE) office user can reassign ANY visible shipment's Export side to their
// own office, which is the whole point of the disaster-recovery scenario (a DIFFERENT office
// steps in, not just the one already assigned). admin/operator and any user with `allOffices`
// (the existing office-based-visibility opt-out, `users.all_offices`) bypass entirely — this only
// bites a user an admin has deliberately scoped to specific offices. `side` is 'Export'/'Import'/
// 'Controlling' — Controlling isn't tied to a department, so either side's own office user (or
// the same bypasses) may reassign it. Mirrors applyShipmentAccessFilter's own admin/operator
// bypass and the X-Office-Id "active office" header ShipmentFormPage.jsx already reads department
// off of for its own EMO/IMO auto-default.
function canEditOfficeSide(req, side) {
  const user = req?.user;
  if (!user) return false;
  const jwtRoles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : ['viewer']);
  if (jwtRoles.includes('admin') || jwtRoles.includes('operator')) return true;
  if (user.allOffices) return true;
  if (side === 'Controlling') return canEditOfficeSide(req, 'Export') || canEditOfficeSide(req, 'Import');
  const dept = side === 'Export' ? 'SE' : side === 'Import' ? 'SI' : null;
  if (!dept) return false;
  const activeOfficeId = req.headers?.['x-office-id'];
  if (!activeOfficeId) return false;
  const office = db.prepare("SELECT department FROM offices WHERE id=?").get(activeOfficeId);
  return !!office && office.department === dept;
}

function applyShipmentAccessFilter(shipments, user, req) {
  if (!user) return shipments;

  // Derive the highest-ranked role from the JWT roles array (works with both
  // old tokens that have no 'role' field and new ones that do).
  const jwtRoles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : ['viewer']);
  const primaryRole = jwtRoles.reduce(
    (best, r) => (ROLE_RANK_SV[r] ?? 0) > (ROLE_RANK_SV[best] ?? 0) ? r : best,
    'viewer'
  );

  // When the user has switched to a lower role in the UI the frontend sends
  // X-Active-Role. Only trust it if it's actually lower than the primary role.
  const requestedRole = req?.headers?.['x-active-role'] || null;
  const effectiveRole = (requestedRole && (ROLE_RANK_SV[requestedRole] ?? 0) < (ROLE_RANK_SV[primaryRole] ?? 0))
    ? requestedRole
    : primaryRole;

  if (['admin', 'operator'].includes(effectiveRole)) return shipments;

  // Office-based data segregation: filter by active office when the user is not global.
  // Org-wide "offices_allow_all" setting bypasses this for all users.
  const orgAllowAll = getSettings().offices_allow_all === "1";
  if (!user.allOffices && !orgAllowAll) {
    const activeOfficeId = req?.headers?.['x-office-id'] || null;
    if (activeOfficeId) {
      // Validate that this office is actually assigned to the user
      const validOffice = db.prepare(
        "SELECT id FROM user_offices WHERE user_id=? AND office_id=?"
      ).get(user.id, activeOfficeId);
      if (!validOffice) return [];
      // Additional (backup) offices — a shipment a disaster-recovery office was added to via
      // shipment_side_offices should be visible to that office's staff too, not just the
      // shipment's original EMO/IMO/Controlling.
      const sideOfficeShipmentIds = new Set(
        db.prepare("SELECT shipment_id FROM shipment_side_offices WHERE office_id=?")
          .all(activeOfficeId).map(r => r.shipment_id)
      );
      shipments = shipments.filter(s =>
        s.emoOfficeId === activeOfficeId ||
        s.imoOfficeId === activeOfficeId ||
        s.controllingOfficeId === activeOfficeId ||
        sideOfficeShipmentIds.has(s.id)
      );
    }
  }

  const scopeItems = db.prepare("SELECT * FROM user_scope_items WHERE user_id=?").all(user.id);
  const legacyCfgs = db.prepare("SELECT * FROM user_access_configs WHERE user_id=?")
    .all(user.id).map(mapAccessConfig);

  if (!scopeItems.length && !legacyCfgs.length) return shipments;

  // Group scope items by type.
  // Within each type: OR (any of the configured values may match).
  // Across types: AND (every configured section must be satisfied).
  // e.g. trade_lane EU-N→NAM AND pol=NLRTM → only NLRTM→NAM shipments.
  const byType = {};
  for (const item of scopeItems) {
    (byType[item.item_type] = byType[item.item_type] || []).push(item);
  }
  const typeGroups = Object.values(byType);

  return shipments.filter(s => {
    const scopePass = typeGroups.length > 0 &&
      typeGroups.every(group => group.some(item => matchesScopeItem(s, item)));
    const legacyPass = legacyCfgs.some(c => shipmentMatchesAccessConfig(s, c));
    return scopePass || legacyPass;
  });
}
const INVERSE_LINK_LABEL = { "Blocks": "Is blocked by", "Duplicates": "Is duplicated by", "Implements": "Is implemented by", "Relates to": "Relates to" };
const inverseLinkLabel = t => INVERSE_LINK_LABEL[t] || t;
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

// ─── Admin event logger ───────────────────────────────────────────────────────
const logAdminEvent = (actor, action, targetType = '', targetId = '', details = {}) => {
  try {
    db.prepare(
      "INSERT INTO admin_events (id,actor_id,actor_email,action,target_type,target_id,details,created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(`AEV-${uid()}`,
      actor?.id    ?? '', actor?.email ?? '',
      action, targetType, targetId,
      JSON.stringify(details), new Date().toISOString());
  } catch(e) { console.warn('logAdminEvent failed:', e.message); }
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
  master_bl_number: 'Master B/L Number',
  bl_release_type: 'B/L Release Type',
  master_bl_release_type: 'Master B/L Release Type',
  coload_tariff_reference: 'Co-Load Tariff Reference',
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
  vgm_weight_kg:        'VGM Weight (kg)',
  vgm_status:            'VGM Status',
  vgm_cutoff:            'VGM Cutoff',
  cy_cutoff:             'CY Cutoff',
  origin_free_time_days: 'Origin Demurrage Free Time (days)',
  dest_free_time_days:   'Destination Demurrage Free Time (days)',
  origin_detention_free_days: 'Origin Detention Free Time (days)',
  dest_detention_free_days:   'Destination Detention Free Time (days)',
  set_temperature_c: 'Reefer Set Temperature (°C)',
};

// Compliance-badge thresholds: how many days out a fixed cutoff (VGM/CY) or a
// container-events-derived free-time window (demurrage/detention) turns amber
// before it's overdue. Free time windows are themselves usually only 3-7 days,
// so they get a tighter warning window than a fixed planning-deadline cutoff.
// (CUTOFF_WARNING_DAYS itself is declared earlier, alongside the createMappers() call —
// mapContainer's cutoffState needs it threaded in at factory-creation time.)
const FREE_TIME_WARNING_DAYS = 2;

// ─── Milestone auto-completion (TKT-OZD4V8) ────────────────────────────────────
// Wires external events (EDI booking confirmation, container Gate In/Out, VGM
// submission) into the existing shipment_milestones lifecycle instead of requiring a
// manual completion for things the system already knows happened. No-ops if the
// milestone row doesn't exist yet (init hasn't run) or is already completed — a manual
// completion (with its own note/date) is never silently overwritten by an auto one.
const autoCompleteMilestone = (shipmentId, milestoneKey, note) => {
  const row = db.prepare("SELECT * FROM shipment_milestones WHERE shipment_id=? AND milestone_key=?").get(shipmentId, milestoneKey);
  if (!row || row.completed_at) return;
  const now = new Date().toISOString();
  db.prepare("UPDATE shipment_milestones SET completed_at=?, completed_by=?, note=? WHERE id=?")
    .run(now, 'System (Auto)', note, row.id);
};

// ─── Carrier booking auto-creation ─────────────────────────────────────────────
// Once a shipment has both a contract (contract_id for Central, or a manual contract_ref
// for SPOT/Pending/Customer Own) and a schedule, it's ready to book: a carrier_bookings
// row is created automatically in a new 'Created' status, giving it a real BKG- surrogate
// key before anyone has to explicitly send anything.
//
// "Has a schedule" deliberately covers TWO cases, not just one — found via a real bug
// report (SHP-VSB0Z2): a shipment_schedules row (from a sailing search-and-save or a
// Schedule Generator link) is the formal case, but a shipment can just as legitimately
// have its Route Legs filled in by hand (real POL/POD/ETD per SEA leg) without ever going
// through Add Sailing — that's still a real schedule from the operator's point of view,
// it just never produced an audit-trail row. Requiring etd specifically (not just "a SEA
// leg exists") matters: ShipmentFormPage defaults every new leg to legType SEA, so nearly
// every shipment has an empty one from the moment it's created — checking bare existence
// would fire the moment a contract is added to ANY shipment, regardless of whether real
// routing info exists yet.
//
// Called from every route that can newly satisfy either precondition (contract
// assignment, schedule save, Schedule Generator create/link) — idempotent (no-ops once a
// booking row already exists, same "never silently overwritten" rule autoCompleteMilestone
// above already follows) and safe to call unconditionally even when nothing changed.
// Copies a booking row into carrier_booking_archive AS-IS (keeps its own BKG- id — the
// surrogate key it already had) then deletes it from the live table. Called only from
// ensureBookingCreated's supersede branch below.
const archiveBooking = (booking, reason) => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO carrier_booking_archive
    (id, shipment_id, carrier_code, status, last_response_status, booking_ref, correlation_id,
     is_mock, requested_at, requested_by, responded_at, confirmed_at, confirmed_by,
     cancelled_at, cancelled_by, cancel_reason, created_at, updated_at, archived_at, archived_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(booking.id, booking.shipment_id, booking.carrier_code, booking.status,
         booking.last_response_status, booking.booking_ref, booking.correlation_id,
         booking.is_mock, booking.requested_at, booking.requested_by, booking.responded_at,
         booking.confirmed_at, booking.confirmed_by, booking.cancelled_at, booking.cancelled_by,
         booking.cancel_reason, booking.created_at, booking.updated_at, now, reason || '');
  db.prepare("DELETE FROM carrier_bookings WHERE id=?").run(booking.id);
  logEntityEvent('carrier_booking', booking.id, 'ARCHIVED', null, null, null,
    JSON.stringify({ shipmentId: booking.shipment_id, reason: reason || '' }));
};

// Supersede: ANY not-yet-Confirmed booking (Created, Pending, Rejected, or already Cancelled)
// whose carrier no longer matches the shipment's current one is stale — the arrangement moved
// on. Changing the carrier IS the cancellation trigger now, not a precondition of it — the
// operator doesn't have to have manually cancelled (or had it rejected) first; even a booking
// still Pending (a real request already sent, awaiting the carrier's response) gets auto-
// cancelled the moment the carrier changes. A Confirmed booking is never touched here — that's
// a real commitment, not something to silently supersede. A same-carrier edit (a contract/date
// correction that doesn't actually change who's carrying it) leaves the existing booking and
// its id completely alone — this is what makes the surrogate key persist across an edit.
//
// The old booking is transitioned to Cancelled first (if it wasn't already) — including
// sending the exact same cancellation EDI message the manual Cancel action already sends
// (only when something was actually transmitted: a bare Created booking with no
// correlation_id never had a request sent, so there's no carrier to notify) — then archived
// under its own original BKG- id (reason recorded), and the caller creates a fresh booking
// under the new carrier in its place.
//
// Shared by every place that reads "the current carrier_bookings row for this shipment" and
// then decides whether to keep building on it — not just ensureBookingCreated. Send Booking
// Request (upsertPendingBooking, routes/edi.js) and the manual Confirm route both used to read
// `existing` and unconditionally UPDATE it in place regardless of status, which is exactly what
// let a stale booking's own id/carrier/history quietly get overwritten by a completely
// different carrier's attempt the moment Send or Confirm was clicked again — the actual
// still-reproducible shape of the original SHP-Y9E98X bug, since neither of those call sites
// went through ensureBookingCreated at all.
const supersedeIfCarrierChanged = (shipment, existing) => {
  if (!existing || existing.status === "Confirmed" || shipment.carrier_code === existing.carrier_code) return existing;
  const now = new Date().toISOString();
  const reason = `Carrier changed to ${shipment.carrier_code || '(none)'}`;
  if (existing.status !== "Cancelled") {
    // Notify the old carrier only if something was actually transmitted for THIS booking —
    // its own carrier_code (who the request actually went to), not the shipment's new one.
    if (existing.correlation_id && isEdiBookable(existing.carrier_code, shipment.emo_office_id)) {
      const cancelId = `EDI-${uid()}`;
      db.prepare(`
        INSERT INTO edi_messages (id, shipment_id, carrier_code, direction, message_type, format, raw_payload, status, correlation_id, is_mock, created_at)
        VALUES (?,?,?,'out','booking_cancellation','JSON',?,'sent',?,0,?)
      `).run(cancelId, shipment.id, existing.carrier_code, JSON.stringify({ reason }), existing.correlation_id, now);
      const subs = shipmentSubs.get(shipment.id);
      if (subs) {
        const frame = JSON.stringify({
          type: "new_edi_message",
          message: mapEdiMessage(db.prepare("SELECT * FROM edi_messages WHERE id=?").get(cancelId)),
        });
        for (const ws of subs) if (ws.readyState === ws.OPEN) ws.send(frame);
      }
    }
    db.prepare(`UPDATE carrier_bookings SET status='Cancelled', cancelled_at=?, cancelled_by=?, cancel_reason=?, updated_at=? WHERE id=?`)
      .run(now, 'System (Auto)', reason, now, existing.id);
    existing = db.prepare("SELECT * FROM carrier_bookings WHERE id=?").get(existing.id);
  }
  archiveBooking(existing, `Superseded — ${reason}`);
  return null;
};

const ensureBookingCreated = (shipmentId) => {
  const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(shipmentId);
  if (!shipment) return;
  if (!(shipment.contract_id || shipment.contract_ref)) return;
  const hasSchedule = !!db.prepare(`
    SELECT 1 FROM shipment_schedules WHERE shipment_id=?
    UNION
    SELECT 1 FROM shipment_legs WHERE shipment_id=? AND leg_type='SEA' AND etd IS NOT NULL AND etd != ''
  `).get(shipmentId, shipmentId);
  if (!hasSchedule) return;
  let existing = db.prepare("SELECT * FROM carrier_bookings WHERE shipment_id=?").get(shipmentId);
  existing = supersedeIfCarrierChanged(shipment, existing);
  if (existing) return;
  const now = new Date().toISOString();
  const id = `BKG-${uid()}`;
  db.prepare(`INSERT INTO carrier_bookings (id, shipment_id, carrier_code, status, created_at, updated_at)
    VALUES (?,?,?,'Created',?,?)`).run(id, shipmentId, shipment.carrier_code || '', now, now);
  logEntityEvent('carrier_booking', id, 'CREATED', null, null, null,
    JSON.stringify({ shipmentId, actor: 'System (Auto)' }));
  // Live-push the new booking — matters much more now than when this was write-only-at-
  // creation: a booking can be auto-superseded (and its own id swapped) at any time a not-yet-
  // Confirmed booking's carrier changes, including while a Details/Review tab for it is
  // already open. Same broadcast shape Send/Confirm/Cancel already use.
  const subs = shipmentSubs.get(shipmentId);
  if (subs) {
    const frame = JSON.stringify({
      type: "booking_status_changed",
      booking: mapCarrierBooking(db.prepare("SELECT * FROM carrier_bookings WHERE id=?").get(id)),
    });
    for (const ws of subs) if (ws.readyState === ws.OPEN) ws.send(frame);
  }
};

// One-time startup backfill — the auto-creation trigger above only fires from write
// routes going forward; shipments that already satisfied both conditions before this
// feature existed (or via a code path that doesn't call it, like SHP-VSB0Z2's hand-entered
// legs) need a one-time sweep. Safe to re-run on every startup: ensureBookingCreated
// itself no-ops for anything that already has a booking or doesn't qualify.
(function backfillCarrierBookings() {
  const candidates = db.prepare(`
    SELECT id FROM shipments
    WHERE (contract_id IS NOT NULL AND contract_id != '') OR (contract_ref IS NOT NULL AND contract_ref != '')
  `).all();
  let created = 0;
  for (const { id } of candidates) {
    const before = db.prepare("SELECT id FROM carrier_bookings WHERE shipment_id=?").get(id);
    ensureBookingCreated(id);
    if (!before && db.prepare("SELECT id FROM carrier_bookings WHERE shipment_id=?").get(id)) created++;
  }
  if (created > 0) console.log(`  ✔ Backfilled ${created} carrier booking(s) for already-qualifying shipments`);
})();

// ─── Ops-automation sweep: auto-create Kanban tickets from stuck process signals ──────────────
// Previously the app had zero automatic ticket creation anywhere — a stuck carrier booking, an
// overdue milestone, or an unresolved compliance HIT were only ever visible as a transient
// notification-bell badge (App.jsx's Header) or a page-level badge, nothing that persisted,
// could be assigned, or survived the badge being dismissed. This sweep turns those same three
// conditions into real, trackable Kanban tickets — same "detect a condition, act once, never
// re-fire" idiom as autoCompleteMilestone/ensureBookingCreated above, just running on a timer
// instead of off a write-path call, since "stuck"/"overdue" are inherently time-based conditions
// with no single write event that would ever trigger them.
//
// Mirrors App.jsx's own STALE_BOOKING_HOURS=48 (frontend/backend don't share a module, same
// split as CONTRACT_TYPES/BOOKABLE_CARRIERS elsewhere in this app) — a Pending booking with no
// carrier response past this age is exactly what the notification bell already flags.
const STALE_BOOKING_HOURS = 48;

// Batch-resolves rows' assigneeId -> assigneeName/assigneeInitial for whatever the Kanban Service
// returns in remote mode (it owns no `users` table of its own) — same batch-IN pattern
// routes/shipments.js's own resolveSeaPorts() already established for sea-port names. Mutates and
// returns the same array; a cheap no-op when nothing has an assignee.
function resolveAssigneeNames(rows) {
  const ids = [...new Set(rows.map(r => r.assigneeId).filter(Boolean))];
  if (!ids.length) return rows;
  const names = {};
  db.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids).forEach(u => { names[u.id] = u.name; });
  for (const r of rows) {
    const name = r.assigneeId ? names[r.assigneeId] : null;
    r.assigneeName = name || null;
    r.assigneeInitial = name ? name.trim()[0].toUpperCase() : null;
  }
  return rows;
}

// Dedupes on (sourceType, sourceId) via the tickets.source_type/source_id columns — once a
// ticket exists for a given source it's never recreated, even if a human later closes it and the
// underlying condition still holds (closing it is treated as "handled", same as this codebase's
// other one-shot auto-triggers never re-firing once their target is in a settled state). Returns
// the new ticket id, or null if one already existed.
//
// Remote branch (kanban_source='remote') calls the Kanban Service's own atomic
// POST /internal/tickets/ensure — an INSERT OR IGNORE against a real UNIQUE(source_type,
// source_id) constraint that table only has in that service's schema. The local path below keeps
// its original check-then-insert (a narrow, low-probability race under concurrent sweeps,
// unchanged) rather than retrofitting the same constraint onto the monolith's own long-lived
// tickets table — the remote path closes the race outright instead of porting it.
const ensureOpsTicket = async (sourceType, sourceId, { shipmentId, title, description, priority = 'Medium' }) => {
  if ((getSettings().kanban_source || 'local') === 'remote') {
    try {
      const r = await callKanbanService('POST', '/internal/tickets/ensure',
        { sourceType, sourceId, shipmentId: shipmentId || null, title, description, priority });
      return r.created ? r.id : null;
    } catch (e) {
      console.error('ensureOpsTicket (remote) failed:', e.message);
      return null;
    }
  }
  const existing = db.prepare("SELECT id FROM tickets WHERE source_type=? AND source_id=?").get(sourceType, sourceId);
  if (existing) return null;
  const id = `TKT-${uid()}`;
  const now = new Date().toISOString();
  const pos = (db.prepare("SELECT MAX(position) AS m FROM tickets WHERE status='Ready'").get()?.m ?? -1) + 1;
  db.prepare(`INSERT INTO tickets
    (id, title, description, priority, status, position, created_at, shipment_id, type, source_type, source_id)
    VALUES (?,?,?,?,'Ready',?,?,?,'Task',?,?)`)
    .run(id, title, description, priority, pos, now, shipmentId || null, sourceType, sourceId);
  return id;
};

const runOpsAutomationSweep = async () => {
  const now = Date.now();
  const staleBookings = db.prepare(`
    SELECT id, shipment_id, carrier_code, requested_at FROM carrier_bookings
    WHERE status='Pending' AND requested_at IS NOT NULL AND requested_at != ''
  `).all();
  for (const b of staleBookings) {
    const ageHours = (now - new Date(b.requested_at).getTime()) / 36e5;
    if (ageHours < STALE_BOOKING_HOURS) continue;
    await ensureOpsTicket('carrier_booking_stale', b.id, {
      shipmentId: b.shipment_id, priority: 'High',
      title: `Carrier booking stuck — no response in ${Math.floor(ageHours)}h (${b.shipment_id})`,
      description: `Carrier booking ${b.id} on ${b.shipment_id} (${b.carrier_code || 'unknown carrier'}) has had no carrier response for over ${STALE_BOOKING_HOURS}h. Auto-created by the ops automation sweep.`,
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const overdueMilestones = db.prepare(`
    SELECT m.id, m.shipment_id, m.label, m.estimated_date FROM shipment_milestones m
    JOIN shipments s ON s.id = m.shipment_id
    WHERE (m.completed_at IS NULL OR m.completed_at='') AND m.estimated_date != '' AND m.estimated_date < ?
      AND s.status NOT IN ('Completed', 'Cancelled')
  `).all(today);
  for (const m of overdueMilestones) {
    await ensureOpsTicket('milestone_overdue', m.id, {
      shipmentId: m.shipment_id, priority: 'Medium',
      title: `Overdue milestone: ${m.label} (${m.shipment_id})`,
      description: `Milestone "${m.label}" on ${m.shipment_id} was estimated for ${m.estimated_date} and is still incomplete. Auto-created by the ops automation sweep.`,
    });
  }

  const complianceHits = db.prepare(`
    SELECT sc.id, sc.shipment_id FROM shipment_screenings sc
    JOIN shipments s ON s.id = sc.shipment_id
    WHERE sc.result='HIT' AND sc.overridden_at IS NULL AND s.status NOT IN ('Completed', 'Cancelled')
  `).all();
  for (const sc of complianceHits) {
    // Dedupe on shipment_id, not sc.id — shipment_screenings has UNIQUE(shipment_id), so a
    // re-screen (party change, customer rename, sanctions sync, this very sweep's own
    // rescreenActiveShipments call) does an INSERT OR REPLACE that regenerates sc.id even
    // though it's the same still-unresolved HIT. Deduping on the regenerating id let every
    // re-screen of an already-ticketed shipment create a fresh duplicate Critical ticket —
    // confirmed live (SHP-0YZJJ8 and SHP-W6K9NO each had two). carrier_booking_stale (above)
    // doesn't have this bug since carrier_bookings.id is genuinely stable.
    await ensureOpsTicket('compliance_hit', sc.shipment_id, {
      shipmentId: sc.shipment_id, priority: 'Critical',
      title: `Compliance HIT requires review — ${sc.shipment_id}`,
      description: `Sanctions screening on ${sc.shipment_id} returned a HIT with no override on record. Auto-created by the ops automation sweep.`,
    });
  }
};
runOpsAutomationSweep().catch(e => console.error('runOpsAutomationSweep failed:', e.message));
setInterval(() => runOpsAutomationSweep().catch(e => console.error('runOpsAutomationSweep failed:', e.message)),
  60 * 60 * 1000); // hourly, same cadence as expireStaleContracts

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

// ─── Shared route/haulage matching (contracts + allocations) ──────────────────
// One codepath for "does this leg actually cover the requested route + haulage",
// shared by /api/contracts/match and /api/allocations/match so a Central contract
// and its own space-config allocations are judged by the identical rule — not two
// endpoints quietly disagreeing. Deliberately separate from GET /api/contracts
// (the #schedules search page), which has its own independent-EXISTS-clause
// logic and is left untouched.
const linkedPortCodes = code => db.prepare(`
  SELECT CASE WHEN primary_unlocode=? THEN linked_unlocode ELSE primary_unlocode END AS code
  FROM linked_ports WHERE primary_unlocode=? OR linked_unlocode=?
`).all(code, code, code).map(r => r.code);

// Carrier Line Agents — resolves the registered Line Agent for a carrier at a port, falling
// back to any linked port (same linked-port-aware matching findMatchingContractLeg already
// uses below) so a carrier_agents row registered against a seaport still matches a shipment
// routed via a linked inland ICD. Returns the matched row (with a live-joined agent name) or
// null if nothing's registered for this carrier at this port (or any of its linked ports).
// 'remote' mode calls the MDM Service's own /internal/carrier-agents/resolve, which does its own
// linked-port fallback server-side (it owns both tables) — this function then does the one local
// `customers` lookup the service can't do itself, so the returned shape (agent_customer_name
// included) matches the local path exactly. NOTE (named, accepted gap): the LOCAL path's own
// linked-port fallback (linkedPortCodes, below) always reads the local linked_ports table even
// when mdm_source=remote — only affects the narrow case of contract_source=local combined with
// mdm_source=remote; see ARCHITECTURE.md.
// Resolves the Line Agent covering a given carrier+port — a location can match either as a
// direct UNLOCODE row or via a country-level row (the port's own country), and if neither
// matches directly, falls back through linked ports exactly as before this restructure.
async function resolveCarrierAgent(carrierCode, portUnlocode) {
  if ((getSettings().mdm_source || "local") === "remote") {
    let row;
    try { row = await callMdmService("GET", `/internal/carrier-agents/resolve?carrierCode=${encodeURIComponent(carrierCode)}&port=${encodeURIComponent(portUnlocode)}`); }
    catch { return null; }
    if (!row) return null;
    const cust = db.prepare("SELECT company_name FROM customers WHERE id=?").get(row.agentCustomerId);
    return { id: row.id, carrier_code: row.carrierCode,
      agent_customer_id: row.agentCustomerId, agent_customer_name: cust?.company_name || '',
      note: row.note, created_at: row.createdAt };
  }
  const tryPort = p => {
    const direct = db.prepare(`
      SELECT ca.*, c.company_name AS agent_customer_name
      FROM carrier_agents ca
      JOIN carrier_agent_locations cal ON cal.carrier_agent_id = ca.id
      JOIN customers c ON c.id = ca.agent_customer_id
      WHERE ca.carrier_code=? AND cal.location_type='unlocode' AND cal.unlocode=?
    `).get(carrierCode, p);
    if (direct) return direct;
    const port = db.prepare("SELECT country_code FROM port_locations WHERE unlocode=?").get(p);
    if (!port?.country_code) return null;
    return db.prepare(`
      SELECT ca.*, c.company_name AS agent_customer_name
      FROM carrier_agents ca
      JOIN carrier_agent_locations cal ON cal.carrier_agent_id = ca.id
      JOIN customers c ON c.id = ca.agent_customer_id
      WHERE ca.carrier_code=? AND cal.location_type='country' AND cal.country_iso2=?
    `).get(carrierCode, port.country_code);
  };
  return tryPort(portUnlocode) || linkedPortCodes(portUnlocode).map(tryPort).find(Boolean) || null;
}

// Finds every distinct run of legs covering pol->pod as one connected journey, one match per
// contract_routings group. Legs are grouped by routing_id FIRST — '' (the column default) is one
// implicit group, which is every leg on every contract that predates the multi-routing feature —
// so genuinely alternative routings for the same lane are never confused with each other, and a
// legacy contract's legs are never split across groups they were never assigned to.
//
// Within one group, contracts in this app store legs in two different shapes: sequential TSP hops
// of ONE journey (leg[i].pod === leg[i+1].pol, e.g. NLRTM->BEANR->USNYC) and independent ALTERNATE
// LANES bundled under the same group (unrelated pol/pod pairs, e.g. an Asia-Europe lane and a
// separate Europe-US lane sharing the implicit '' routing on a contract created before named
// routings existed) — a fixed "whole array is one chain" assumption breaks the second shape. So:
// try every possible starting leg whose pol matches the query, walk forward only while consecutive
// legs actually connect, and stop as soon as that walked run's pod reaches the query pod — that's
// the natural boundary of one lane. Unlike the old single-match version, scanning continues past a
// successful match to find every other independent run in the SAME group too (this only changes
// behavior for the rare legacy contract bundling two unrelated lanes that both happen to satisfy
// the same pol/pod query — previously only the leg-order-earliest one was ever visible). Haulage
// only attaches at the outer edges of a matched run: the first leg's POL haulage (pre-carriage into
// the run's own first port) and the last leg's POD haulage (on-carriage out of its own last port)
// — never the legs in between. A single-leg run is the simple case.
const findMatchingContractLegs = (legs, { pol, pod, needsPolHaulage, needsPodHaulage, pkuLocation = '', delLocation = '' }) => {
  if (legs.length === 0) return [];
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const pkuU = pkuLocation.toUpperCase(), delU = delLocation.toUpperCase();

  const polMatches = leg => (leg.pol_linked_allowed ? [leg.pol, ...linkedPortCodes(leg.pol)] : [leg.pol]).includes(polU);
  const podMatches = leg => (leg.pod_linked_allowed ? [leg.pod, ...linkedPortCodes(leg.pod)] : [leg.pod]).includes(podU);

  const haulageOk = (first, last) => {
    if (needsPolHaulage) {
      if (!first.pol_carrier_haulage) return false;
      if (first.pol_haulage_locations) {
        const allowed = first.pol_haulage_locations.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
        if (allowed.length > 0 && pkuU && !allowed.includes(pkuU)) return false;
      }
    }
    if (needsPodHaulage) {
      if (!last.pod_carrier_haulage) return false;
      if (last.pod_haulage_locations) {
        const allowed = last.pod_haulage_locations.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
        if (allowed.length > 0 && delU && !allowed.includes(delU)) return false;
      }
    }
    return true;
  };

  const groups = new Map();
  for (const leg of legs) {
    const key = leg.routing_id || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(leg);
  }

  const matches = [];
  for (const [routingId, groupLegs] of groups) {
    const ordered = [...groupLegs].sort((a, b) => a.leg_order - b.leg_order);
    for (let i = 0; i < ordered.length; i++) {
      if (!polMatches(ordered[i])) continue;
      let j = i;
      for (;;) {
        if (podMatches(ordered[j])) {
          if (haulageOk(ordered[i], ordered[j])) {
            matches.push({ routingId, legs: ordered.slice(i, j + 1), firstLeg: ordered[i], lastLeg: ordered[j],
              matchKind: (ordered[i].pol === polU && ordered[j].pod === podU) ? "exact" : "linked" });
          }
          break; // reached the query pod (haulage ok or not) — this lane is done, try the next start
        }
        const next = ordered[j + 1];
        if (!next || ordered[j].pod !== next.pol) break; // chain doesn't continue — dead end
        j++;
      }
    }
  }
  return matches;
};

// ─── Role helpers (hoisted from inline routes so ctx can include them) ────────

const VALID_ROLES  = ["admin", "operator", "occ_bk", "trade_manager", "viewer"];
const ROLE_RANK_SV = { viewer: 0, occ_bk: 1, trade_manager: 1, operator: 2, admin: 3 };
const primaryRoleSV  = (roles) => [...roles].sort((a, b) => ROLE_RANK_SV[b] - ROLE_RANK_SV[a])[0] || 'viewer';
const parseUserRoles = (u) => JSON.parse(u.roles || JSON.stringify([u.role || 'viewer']));

// ─── WebSocket broadcast helpers (hoisted; shipmentSubs pre-declared above) ───

const broadcastMessage = (shipmentId, payload) => {
  const subs = shipmentSubs.get(shipmentId);
  if (!subs) return;
  const frame = JSON.stringify({ type: "new_message", message: payload });
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
};

const broadcastEditLockChange = (shipmentId, payload) => {
  const subs = shipmentSubs.get(shipmentId);
  if (!subs) return;
  const frame = JSON.stringify({ type: "edit_lock_changed", shipmentId, ...payload });
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
};

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

// ─── Contract rate → charge code mapping (hoisted so importContractRates + ctx are together) ─
// charge_code is plain TEXT (no backend enum) — CHARGE_CODES in ShipmentDetailPage.jsx is only
// a client-side suggestion list for a manually-typed NEW cost line, it doesn't constrain what a
// contract-generated line can carry. This previously only recognized 6 of the 17 service codes
// MdmContractsPage.jsx's own rate-entry UI offers (SERVICE_CODES) — every surcharge code (BAF,
// CAF, EBS, PSS, ISPS, WRS, SCS, AMS, ENS, IMO) fell through to the generic literal 'Other',
// losing its specific identity on the resulting cost line's structured charge_code field (the
// original code/description survived only in the line's free-text notes) — meaning the GP
// Overview's "by charge code" breakdown could never distinguish a bunker surcharge from a peak-
// season surcharge from a war-risk surcharge, they all just landed in one 'Other' bucket.
const SERVICE_CODE_MAP = {
  OF: 'Ocean Freight', OCF: 'Ocean Freight',
  BAF: 'Bunker Adjustment Factor',
  CAF: 'Currency Adjustment Factor',
  EBS: 'Emergency Bunker Surcharge',
  'THC-O': 'Origin THC', THC: 'Origin THC', OTHC: 'Origin THC', ORI: 'Origin THC',
  'THC-D': 'Destination THC', DTHC: 'Destination THC', DEST: 'Destination THC',
  BL: 'B/L Fee', BLF: 'B/L Fee', DOC: 'B/L Fee',
  AMS: 'Advance Manifest Surcharge',
  ENS: 'Entry Summary Declaration',
  IMO: 'IMO/DG Surcharge',
  PSS: 'Peak Season Surcharge',
  ISPS: 'ISPS Security Surcharge',
  CUC: 'Carrier Uplift Charge',
  WRS: 'War Risk Surcharge',
  SCS: 'Suez Canal Surcharge',
  CUS: 'Customs', CUST: 'Customs',
  INL: 'Inland', INLAND: 'Inland',
  DET: 'Detention', DEM: 'Demurrage',
};

// The Contract Management Service returns rates through its own mapRate (camelCase, same field
// names as lib/mappers.js's copy) — converts one back to the snake_case row shape the insert
// loop below (and the valid_from/valid_to filter above it) already expects, so that loop doesn't
// need two implementations depending on contract_source.
const rateToRow = r => ({
  routing_id: r.routingId || '', service_code: r.serviceCode || '', description: r.description || '',
  amount: r.amount, currency: r.currency || 'USD', amount_usd: r.amountUsd, unit: r.unit || 'per_container',
  container_type: r.containerType || '', notes: r.notes || '', valid_from: r.validFrom || '', valid_to: r.validTo || '',
});

// Freezes a copy of contract_rates at the point they're committed to a shipment. Later edits to
// contract_rates in MDM never rewrite what was already quoted — "Reset to Contract" replays this
// frozen snapshot, and "Update Carrier Costs" is the only action that generates a new one. See TKT-6QT30S.
// The snapshot itself is always a local write regardless of contract_source — it's a monolith-
// owned freeze of whatever the live rates said at commit time, not a mirror of the source's own
// storage. async because 'remote' mode resolves the live rates via a network call to the Contract
// Management Service first — callers must await this (see e.g. routes/shipment-ops.js's
// import-contract route, which resolves the snapshot BEFORE opening its own write transaction,
// same reasoning as saveRates in routes/contracts.js: never hold a transaction open across a
// network call).
async function createRateSnapshot(shipmentId, contractId, reason, generatedBy = '') {
  const today = new Date().toISOString().slice(0, 10);
  // Scoped to the shipment's own stored contract_routing_id (which named routing was actually
  // assigned) plus contract-wide routing_id='' rows (e.g. a flat documentation fee that applies
  // regardless of routing) — never every rate on the whole contract. A shipment that predates
  // multi-routing contracts has contract_routing_id='', and every rate on a contract that
  // predates named routings also has routing_id='' by column default, so this condition selects
  // every rate on the contract for that combination — identical to this function's pre-routing
  // behavior.
  const routingId = db.prepare("SELECT contract_routing_id FROM shipments WHERE id=?").get(shipmentId)?.contract_routing_id || '';
  // A rate line's own valid_from/valid_to (blank on both ends = inherits the parent contract's
  // already-enforced window) — a mid-contract surcharge that hasn't started yet, or one that's
  // already lapsed, is excluded from a freshly-generated snapshot. Already-frozen snapshots on
  // other shipments are unaffected — this only ever gates what goes INTO a new one.
  let allRates;
  if ((getSettings().contract_source || 'local') === 'remote') {
    try { allRates = (await callContractService("GET", `/internal/contracts/${contractId}`)).rates.map(rateToRow); }
    catch { allRates = []; } // an unreachable/vanished remote contract yields no rates to snapshot, not a hard failure
  } else {
    allRates = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? AND (routing_id=? OR routing_id='') ORDER BY sort_order").all(contractId, routingId);
  }
  const rates = allRates
    .filter(r => r.routing_id === routingId || !r.routing_id)
    .filter(r => (!r.valid_from || r.valid_from <= today) && (!r.valid_to || r.valid_to >= today));
  if (!rates.length) return null;
  const snapshotId = `RATE-${uid()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO shipment_rate_snapshots (id,shipment_id,contract_id,generated_at,generated_by,reason) VALUES (?,?,?,?,?,?)")
    .run(snapshotId, shipmentId, contractId, now, generatedBy, reason);
  for (const r of rates) {
    db.prepare(`INSERT INTO shipment_rate_snapshot_lines
      (id,snapshot_id,service_code,description,amount,currency,amount_usd,unit,container_type,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(`RSL-${uid()}`, snapshotId, r.service_code || '', r.description || '', r.amount,
           r.currency || 'USD', r.amount_usd, r.unit || 'per_container', r.container_type || '', r.notes || '');
  }
  logEntityEvent('rate_snapshot', snapshotId, 'GENERATED', null, null, null,
    JSON.stringify({ shipmentId, contractId, reason, lineCount: rates.length }));
  return snapshotId;
}

// Generates shipment_cost_lines from a frozen rate snapshot (not live contract_rates). Same
// line-generation logic importContractRates always used — container matching, per-container
// split, SERVICE_CODE_MAP lookup — just sourced from shipment_rate_snapshot_lines.
function generateCostLinesFromSnapshot(shipmentId, snapshotId, { splitPerContainer = false, includeSell = false } = {}) {
  const lines = db.prepare("SELECT * FROM shipment_rate_snapshot_lines WHERE snapshot_id=?").all(snapshotId);
  if (!lines.length) return 0;
  const ctrs = db.prepare("SELECT id, container_number, size, type FROM containers WHERE shipment_id=?").all(shipmentId);
  const now = new Date().toISOString();
  let created = 0;
  for (const r of lines) {
    const chargeCode   = SERVICE_CODE_MAP[r.service_code?.toUpperCase()] || 'Other';
    const exchangeRate = (r.amount > 0 && r.amount_usd > 0) ? Math.round((r.amount_usd / r.amount) * 100000) / 100000 : 1;
    const baseNotes    = [r.service_code, r.description].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' — ');
    const applicableCtrs = r.container_type
      ? ctrs.filter(c => `${c.size || ''}${c.type || ''}`.toUpperCase() === r.container_type.toUpperCase())
      : ctrs;
    if (r.unit === 'per_container' && r.container_type && applicableCtrs.length === 0) continue;
    const insertLine = (type, amount, notes, containerId) => {
      const lineId = `CL-${uid()}`;
      db.prepare("INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,notes,container_id,created_at,source,rate_snapshot_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(lineId, shipmentId, type, chargeCode, r.currency || 'USD', amount, exchangeRate, notes, containerId, now, 'contract', snapshotId);
      logEntityEvent('cost_line', lineId, 'IMPORTED', null, null, null,
        JSON.stringify({ shipmentId, chargeCode, currency: r.currency || 'USD', amount, exchangeRate, containerId, snapshotId }));
      created++;
    };
    if (r.unit === 'per_container' && splitPerContainer && applicableCtrs.length > 0) {
      for (const c of applicableCtrs) {
        const cLabel = c.container_number
          ? `${c.container_number}${c.size || c.type ? ` (${c.size}${c.type})` : ''}`
          : `(${c.size || ''}${c.type || ''})`;
        const notes = [cLabel, baseNotes].filter(Boolean).join(' — ');
        insertLine('BUY', r.amount, notes, c.id);
        if (includeSell) insertLine('SELL', r.amount, notes, c.id);
      }
    } else {
      const containerCount = r.unit === 'per_container' ? (applicableCtrs.length || 1) : 1;
      const amount = r.unit === 'per_container' ? r.amount * containerCount : r.amount;
      insertLine('BUY', amount, baseNotes, '');
      if (includeSell) insertLine('SELL', amount, baseNotes, '');
    }
  }
  return created;
}

// Thin wrapper for the "first import" case — if the shipment has no rate snapshot yet, creates
// an 'initial' one, then generates cost lines from it. Existing callers (shipment creation with a
// Central contract, the one-time import-contract endpoint) go through this unchanged; they don't
// need to know about snapshots. Reset/Update Carrier Costs (routes/shipment-ops.js) call
// createRateSnapshot/generateCostLinesFromSnapshot directly since they need explicit control over
// which snapshot is used.
async function importContractRates(shipmentId, opts = {}) {
  const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(shipmentId);
  if (!shipment || shipment.contract_type !== 'Central' || !shipment.contract_id) return 0;
  const existing = db.prepare("SELECT id FROM shipment_rate_snapshots WHERE shipment_id=? ORDER BY generated_at DESC LIMIT 1").get(shipmentId);
  const snapshotId = existing ? existing.id : await createRateSnapshot(shipmentId, shipment.contract_id, 'initial');
  if (!snapshotId) return 0;
  return generateCostLinesFromSnapshot(shipmentId, snapshotId, opts);
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

// In-memory nonce store for SSO OAuth2 state parameter (TTL = 5 min)
const ssoNonces = new Map();
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [k, v] of ssoNonces) if (v.ts < cutoff) ssoNonces.delete(k);
}, 60_000);

const auth = (allowed = []) => (req, res, next) => {
  const header = req.headers["authorization"];
  if (!header?.startsWith("Bearer ")) return err(res, "Unauthorized", 401);
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    // support old single-role tokens and new multi-role tokens
    payload.roles = Array.isArray(payload.roles) ? payload.roles
      : (payload.role ? [payload.role] : ['viewer']);
    if (allowed.length && !allowed.some(r => payload.roles.includes(r)))
      return err(res, "Forbidden", 403);
    // token_version check — invalidates tokens issued before a revoke
    if (payload.tv != null) {
      const row = db.prepare("SELECT token_version, is_active FROM users WHERE id=?").get(payload.id);
      if (!row || !row.is_active) return err(res, "Account inactive", 401);
      if (row.token_version !== payload.tv) return err(res, "Session revoked — please sign in again", 401);
    }
    req.user = payload;
    next();
  } catch { err(res, "Invalid or expired token", 401); }
};

// Role check only (token already verified by global middleware)
const requireRole = (allowed) => (req, res, next) =>
  req.user?.roles?.some(r => allowed.includes(r)) ? next() : err(res, "Forbidden", 403);

// Require valid token on all /api/* except /api/auth/*, /api/health, and /api/share/* (public)
app.use("/api", (req, res, next) =>
  req.path.startsWith("/auth/") || req.path === "/health" || req.path.startsWith("/share/") ? next() : auth()(req, res, next)
);

// ─── Shared context passed to every route module ───────────────────────────────

const aisListener = createAisListener({
  db, getSettings, broadcastMessage, logEntityEvent, uid, syncShipmentFromLegs, callMdmService,
});

const ctx = {
  db, uid, ok, err, isUniqueViolation, validCoord,
  auth, requireRole,
  portLanesMap, portCountryMap, rebuildPortLanesMap, longestLane,
  applyShipmentAccessFilter,
  fxCache, getFxRates, toUsd, roundCents,
  sanctionsMap, loadSanctionsIndex, syncOfacSdn, scheduleNextOfacSync,
  syncConsolidatedScreeningList, scheduleNextCslSync,
  normSanctionName, EMBARGOED_COUNTRIES,
  getSettings,
  shipmentSubs, broadcastMessage, broadcastEditLockChange, recomputeSpaceBadge,
  UPLOADS_DIR,
  renderHtmlToPdf, getActiveSigningCert, signPdfBuffer,
  createTransporterFromSettings, getTransporterForOffice, invalidateTransporterCache,
  buildMailOptions, sendViaOffice, mapOfficeMailSettings, mapSystemEmailSettings,
  SVC_ABBR, LEG_LOC_ABBR, GPS_LOC_TYPE,
  VALID_ROLES, ROLE_RANK_SV, primaryRoleSV, parseUserRoles,
  SERVICE_CODE_MAP, importContractRates, createRateSnapshot, generateCostLinesFromSnapshot,
  mapShipment, mapShipmentLeg, mapCostLine, mapService, mapContainer, mapContainerEvent, mapContainerPackage, mapAllocation,
  mapShipmentParty, ADDITIONAL_PARTY_ROLES, mapSideOffice,
  mapRateSnapshot, mapRateSnapshotLine, mapChargeCodeDefinition, mapPackTypeDefinition, mapDutyRateChapter, mapScheduledReport, mapContainerTypeDefinition,
  mapCarrier, mapVessel, mapPortLocation, mapLinkedPort, mapTradeLane, mapCarrierAgent, mapCarrierAgentScheduleRow,
  mapScopeItem, mapAccessConfig, mapOffice, mapBranch, mapOrgCountry, mapRegion, mapCountry, mapTicketLink, mapTicket,
  mapTestItem, mapTestCaseLink,
  mapEdiMessage,
  mapCarrierBooking, BOOKABLE_CARRIERS, isEdiBookable, mapEadapterConfig,
  mapCustomsFiling, CUSTOMS_FILING_TYPES,
  mapKbProject, mapKbVersion, mapKbColumn,
  mapCustomer, mapCustomerIdentifier, mapCustomerScreening, mapCustomerDoc, mapCustomerContact,
  mapCommodity, mapSystemMessage, mapMilestone, mapMilestoneTemplate,
  mapContract, mapLeg, mapRate, mapContractRouting, mapCarrierInvoice, mapCarrierInvoiceLine,
  mapQuote, mapQuoteLine, mapOpportunity,
  mapInvoiceReasonCode, mapInvoiceStatusOverride,
  resolveInvoiceThresholds, runInvoiceCollectionsSweep, addBusinessDays, businessDaysBetween,
  logEvent, logEntityEvent, logAdminEvent, TRACKED_FIELDS, TRACKED_CTR_FIELDS,
  seedAdmin, seedTestFixtureAdmin, seedSigningCert,
  CUTOFF_WARNING_DAYS, FREE_TIME_WARNING_DAYS,
  ssoNonces,
  syncShipmentFromLegs,
  restartAisListener: aisListener.applySettings,
  ingestAisMessage: aisListener.ingestMessage,
  getAisListenerStatus: aisListener.getStatus,
  forceRefreshAisTrackedLegs: aisListener.forceRefreshTrackedLegs,
  checkOverlap,
  autoCompleteMilestone,
  ensureBookingCreated, supersedeIfCarrierChanged,
  runOpsAutomationSweep,
  linkedPortCodes, findMatchingContractLegs, resolveCarrierAgent,
  screenShipmentById, rescreenActiveShipments, resolveCustomerGroup,
  computeArExposure, docAmountUsd, runDunningSweep, runScheduledReportsSweep, matchesScopeItem, userOwnsLaneForShipment, userOwnsLaneForCustomer,
  canEditOfficeSide,
  OVERRIDE_GRACE_MS,
  bcrypt, jwt, JWT_SECRET,
  DISTRIBUTION_SERVICE_URL, DISTRIBUTION_SERVICE_SECRET,
  PDF_RENDER_SERVICE_URL,
  CONTRACT_SERVICE_URL, CONTRACT_SERVICE_SECRET, callContractService,
  MDM_SERVICE_URL, MDM_SERVICE_SECRET, callMdmService,
  SCREENING_SERVICE_URL, SCREENING_SERVICE_SECRET, callScreeningService,
  KANBAN_SERVICE_URL, KANBAN_SERVICE_SECRET, callKanbanService, resolveAssigneeNames,
  CUSTOMER_SERVICE_URL, CUSTOMER_SERVICE_SECRET, callCustomerService, getCustomerRow,
  inverseLinkLabel,
  fs, path,
  migrationFailures,
  createRateLimiter,
};

require('./routes/auth')(app, ctx);
require('./routes/shipments')(app, ctx);
require('./routes/allocations')(app, ctx);
require('./routes/mdm')(app, ctx);
require('./routes/sanctions')(app, ctx);
require('./routes/kanban')(app, ctx);
require('./routes/testcases')(app, ctx);
require('./routes/edi')(app, ctx);
require('./routes/customs-filing')(app, ctx);
require('./routes/customers')(app, ctx);
require('./routes/contracts')(app, ctx);
require('./routes/shipment-ops')(app, ctx);
require('./routes/carrier-invoices')(app, ctx);
require('./routes/quotes')(app, ctx);
require('./routes/opportunities')(app, ctx);
require('./routes/admin-reset')(app, ctx);
require('./routes/finance')(app, ctx);
require('./routes/reports')(app, ctx);
require('./routes/command-center')(app, ctx);
require('./routes/invoice-reason-codes')(app, ctx);
require('./routes/system')(app, ctx);
require('./routes/export')(app, ctx);
require('./routes/ai')(app, ctx);
require('./routes/share')(app, ctx);
require('./routes/offices')(app, ctx);
require('./routes/office-mail')(app, ctx);
require('./routes/eadapter')(app, ctx);
require('./routes/document-distribution')(app, ctx);
require('./routes/organization')(app, ctx);
require('./routes/charge-codes')(app, ctx);
require('./routes/pack-types')(app, ctx);
require('./routes/container-types')(app, ctx);
require('./routes/duty-rates')(app, ctx);
require('./routes/scheduled-reports')(app, ctx);
require('./routes/ais')(app, ctx);

// ─── Static frontend (production only) ─────────────────────────────────────────
// Local dev never hits this — Vite's own dev server (npm run client) serves the frontend and
// proxies /api + /ws to this process instead (vite.config.js). In production there's no Vite
// dev server running at all, so this process needs to serve the already-built dist/ itself.
// Registered after every /api/* route above, so an unmatched /api/* path still 404s normally
// instead of falling through to index.html.
if (process.env.NODE_ENV === "production") {
  const distDir = path.join(__dirname, "dist");
  app.use(express.static(distDir));
  // SPA fallback: any non-API, non-WS path (including a hard refresh on a hash route, or a
  // path Express's own router didn't match) gets index.html — the app's own client-side hash
  // routing takes it from there. Must be registered last.
  app.get(/^(?!\/api|\/ws).*/, (req, res) => res.sendFile(path.join(distDir, "index.html")));
}

// Crash-safety net, part 3: the actual Express error-handling middleware (4-arg signature is
// what tells Express this is one) — must be registered after every other app.use/get/post/etc.
// call to catch errors from all of them. Two cases:
//  - A malformed JSON body (e.g. a literal `null`, or truncated JSON) previously reached the
//    client as body-parser's raw HTML stack trace — full internal file paths, before auth was
//    even checked, on any route. Now a clean, consistent JSON 400.
//  - Anything forwarded here via wrapAsyncHandler (part 1) or a background job (part 2 handles
//    those instead) — an unexpected error the specific route didn't already turn into a clean
//    `err(res, ...)` response itself. Logged in full server-side; the client gets a generic
//    message, never the raw error/stack (which could leak internal file paths or query detail).
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({ error: "Malformed request body — expected valid JSON" });
  }
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, error);
  res.status(error?.status || 500).json({ error: "Internal server error" });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// shipmentSubs is pre-declared near portLanesMap above so route modules can receive it via ctx.

// The /ws endpoint has no auth at all (by design — it's a plain shipment-update fanout, not a
// place secrets flow through) and previously had no cap of any kind — a single client could open
// unlimited connections or flood "subscribe" frames with zero pushback. Two independent, cheap
// guards: a per-IP concurrent-connection cap (protects against a connection-exhaustion flood) and
// a per-connection message-rate cap (protects against a single open socket spamming frames).
const WS_MAX_CONN_PER_IP = Number(process.env.WS_MAX_CONN_PER_IP) || 20;
const WS_MSG_WINDOW_MS = 10_000;
const WS_MSG_RATE_MAX = Number(process.env.WS_MSG_RATE_MAX) || 30;
const wsConnCountByIp = new Map(); // ip -> open connection count

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress || "unknown";
  if ((wsConnCountByIp.get(ip) || 0) >= WS_MAX_CONN_PER_IP) {
    ws.close(1013, "Too many connections from this address");
    return;
  }
  wsConnCountByIp.set(ip, (wsConnCountByIp.get(ip) || 0) + 1);

  let subscribedId = null;
  let msgCount = 0;
  let msgWindowStart = Date.now();

  ws.on("message", raw => {
    const now = Date.now();
    if (now - msgWindowStart > WS_MSG_WINDOW_MS) { msgWindowStart = now; msgCount = 0; }
    msgCount++;
    if (msgCount > WS_MSG_RATE_MAX) { ws.close(1013, "Message rate exceeded"); return; }
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
    const remaining = (wsConnCountByIp.get(ip) || 1) - 1;
    if (remaining <= 0) wsConnCountByIp.delete(ip); else wsConnCountByIp.set(ip, remaining);
    if (subscribedId && shipmentSubs.has(subscribedId)) {
      const subs = shipmentSubs.get(subscribedId);
      subs.delete(ws);
      if (subs.size === 0) shipmentSubs.delete(subscribedId);
    }
  });
});

// Outbound AIS listener (TKT-ZFO2OM) — settings-gated (api_ais_enabled + a key), no-ops
// cleanly if unconfigured. Wrapped defensively so a bad config can never take the HTTP
// server down with it, same "fail soft" contract external integrations follow elsewhere.
try { ctx.restartAisListener(); } catch (e) { console.error("AIS listener bootstrap failed:", e.message); }

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = 3001;
httpServer.listen(PORT, () => console.log(`⚓  CargoDesk API + WS running on http://localhost:${PORT}`));
