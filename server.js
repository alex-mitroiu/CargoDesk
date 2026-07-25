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
];

for (const sql of migrations) {
  try { db.exec(sql); } catch {}
}

const UPLOADS_DIR = path.join(__dirname, "uploads", "documents");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Port → trade lane index (for access-scope filtering + tradeLane display) ─
const portLanesMap = {};
const PORT_LANES_SQL = `
  SELECT DISTINCT pl.unlocode, tl.code AS lane_code
  FROM port_locations pl
  JOIN countries c ON c.iso2 = pl.country_code
  JOIN country_trade_lanes ctl ON ctl.iso2 = c.iso2
  JOIN trade_lanes tl ON tl.code = ctl.lane_code
`;
function rebuildPortLanesMap() {
  try {
    const plRows = db.prepare(PORT_LANES_SQL).all();
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
const portCountryMap = {};
try {
  const pcRows = db.prepare(
    "SELECT unlocode, country_code FROM port_locations WHERE country_code IS NOT NULL AND country_code != ''"
  ).all();
  for (const r of pcRows) portCountryMap[r.unlocode] = r.country_code;
  console.log(`  ✔ Port→country map built for ${Object.keys(portCountryMap).length} ports`);
} catch (e) {
  console.warn("  ⚠ Port→country map failed:", e.message);
}

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
  ai_agent_enabled:           '0',
  ai_endpoint:                '',
  ai_model:                   'claude-haiku-4-5-20251001',
  ai_api_key:                 '',
  ai_system_prompt:           '',
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

const SVC_ABBR = { 'Port-to-Port': 'P2P', 'Door-to-Port': 'D2P', 'Port-to-Door': 'P2D', 'Door-to-Door': 'D2D' };
function longestLane(un) {
  const s = portLanesMap[un]; if (!s || !s.size) return ''; return [...s].sort((a, b) => b.length - a.length)[0];
}

const mapShipment     = r => { const polLane = longestLane(r.pol), podLane = longestLane(r.pod); return { id: r.id, pol: r.pol, polName: r.pol_name || '', pod: r.pod, podName: r.pod_name || '', carrierCode: r.carrier_code, contractType: r.contract_type, contractNotes: r.contract_notes || '', status: r.status, createdAt: r.created_at, etd: r.etd || '', eta: r.eta || '', bookingRef: r.booking_ref || '', blNumber: r.bl_number || '', vessel: r.vessel || '', voyage: r.voyage || '', incoterm: r.incoterm || '', vesselImo: r.vessel_imo || '', contractId: r.contract_id || '', contractRef: r.contract_ref || '', commodityCode: r.commodity_code || '', shipperId: r.shipper_id || '', shipperName: r.shipper_name || '', consigneeId: r.consignee_id || '', consigneeName: r.consignee_name || '', principalId: r.principal_id || '', principalName: r.principal_name || '', allocationId: r.allocation_id || '', spaceSkipReason: r.space_skip_reason || '', spaceOverageReason: r.space_overage_reason || '', spaceBadge: r.space_badge || '', marginBuyUsd: r.margin_buy_usd ?? null, marginSellUsd: r.margin_sell_usd ?? null, overdueCount: r.overdue_count ?? 0, freightTerms: r.freight_terms || 'Prepaid', movementType: r.movement_type || 'FCL', serviceType: r.service_type || 'Port-to-Port', placeOfReceipt: r.place_of_receipt || '', placeOfDelivery: r.place_of_delivery || '', cargoReadyDate: r.cargo_ready_date || null, notifyId: r.notify_id || '', notifyName: r.notify_name || '', declaredValue: r.declared_value ?? null, declaredValueCurrency: r.declared_value_currency || 'USD', routingTerm: r.routing_term || (SVC_ABBR[r.service_type] || 'P2P'), tradeLane: polLane && podLane ? polLane + ' → ' + podLane : '', emoOfficeId: r.emo_office_id || null, emoOfficeCode: r.emo_office_code || '', emoOfficeName: r.emo_office_name || '', imoOfficeId: r.imo_office_id || null, imoOfficeCode: r.imo_office_code || '', imoOfficeName: r.imo_office_name || '', controllingOfficeId: r.controlling_office_id || null, controllingOfficeCode: r.controlling_office_code || '', controllingOfficeName: r.controlling_office_name || '', contractValidFrom: r.contract_valid_from || '', contractValidTo: r.contract_valid_to || '' }; };
const mapShipmentLeg = r => ({
  id: r.id, shipmentId: r.shipment_id, legOrder: r.leg_order,
  mot: r.mot || 'SEA',
  legType:      r.leg_type      || r.mot || 'SEA',
  movementType: r.movement_type || r.mot || 'SEA',
  pol: r.pol || '', pod: r.pod || '',
  polLocType: r.pol_loc_type || 'Terminal', podLocType: r.pod_loc_type || 'Terminal',
  etd: r.etd || null, eta: r.eta || null,
  carrierCode: r.carrier_code || '', vessel: r.vessel || '', vesselImo: r.vessel_imo || '',
  voyage: r.voyage || '', movementBy: r.movement_by || '',
  contractType: r.contract_type || '', contractRef: r.contract_ref || '',
  createdAt: r.created_at,
});

const LEG_LOC_ABBR = { 'Door': 'DR', 'Terminal': 'PT', 'Container Yard': 'CY', 'CFS': 'CFS' };

const syncShipmentFromLegs = (shipmentId) => {
  const legs = db.prepare("SELECT * FROM shipment_legs WHERE shipment_id=? ORDER BY leg_order ASC").all(shipmentId);
  if (!legs.length) return;
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
  // COALESCE(NULLIF(?, ''), carrier_code) preserves an existing carrier when the leg has none set
  db.prepare(`UPDATE shipments SET pol=?, pod=?, etd=?, eta=?, carrier_code=COALESCE(NULLIF(?, ''), carrier_code), vessel=?, vessel_imo=?, voyage=?, routing_term=? WHERE id=?`)
    .run(first.pol || '', last.pod || '', first.etd || null, last.eta || null,
         seaLeg.carrier_code || '', seaLeg.vessel || '', seaLeg.vessel_imo || '',
         seaLeg.voyage || '', routingTerm, shipmentId);
};

const mapCostLine     = r => {
  const amountUsd = Math.round(r.amount * r.exchange_rate * 100) / 100;
  const actualAmountUsd = r.actual_amount != null
    ? Math.round(r.actual_amount * (r.actual_exchange_rate ?? r.exchange_rate) * 100) / 100
    : null;
  return {
    id: r.id, shipmentId: r.shipment_id, type: r.type, chargeCode: r.charge_code, currency: r.currency,
    amount: r.amount, exchangeRate: r.exchange_rate, amountUsd,
    vatRate: r.vat_rate || 0, vatAmountUsd: Math.round(r.amount * r.exchange_rate * (r.vat_rate || 0) / 100 * 100) / 100,
    notes: r.notes || '', containerId: r.container_id || '', source: r.source || 'manual',
    paymentIndicator: r.payment_indicator || 'Prepaid',
    modifiedAt: r.modified_at || null, createdAt: r.created_at, rateSnapshotId: r.rate_snapshot_id || '',
    status: r.status || 'accrued',
    actualAmount: r.actual_amount, actualExchangeRate: r.actual_exchange_rate, actualAmountUsd,
    actualizedAt: r.actualized_at || null, actualizedBy: r.actualized_by || '',
    postedAt: r.posted_at || null, postedBy: r.posted_by || '',
    varianceUsd: actualAmountUsd != null ? Math.round((actualAmountUsd - amountUsd) * 100) / 100 : null,
  };
};
const mapService      = r => ({ id: r.id, shipmentId: r.shipment_id, side: r.side, serviceType: r.service_type, status: r.status, vendorId: r.vendor_id || '', vendorName: r.vendor_name || '', officeId: r.office_id || '', officeCode: r.office_code || '', officeName: r.office_name || '', requestedDate: r.requested_date || '', confirmedDate: r.confirmed_date || '', completedDate: r.completed_date || '', notes: r.notes || '', createdAt: r.created_at, createdBy: r.created_by || '' });
const mapRateSnapshot     = r => ({ id: r.id, shipmentId: r.shipment_id, contractId: r.contract_id, generatedAt: r.generated_at, generatedBy: r.generated_by || '', reason: r.reason });
const mapRateSnapshotLine = r => ({ id: r.id, snapshotId: r.snapshot_id, serviceCode: r.service_code || '', description: r.description || '', amount: r.amount, currency: r.currency, amountUsd: r.amount_usd, unit: r.unit || 'per_container', containerType: r.container_type || '', notes: r.notes || '' });
const mapChargeCodeDefinition = r => ({ id: r.id, code: r.code, label: r.label, trigger: r.trigger, amount: r.amount, currency: r.currency, unit: r.unit, isActive: r.is_active === 1, createdAt: r.created_at });
// Fixed-deadline compliance badge (VGM/CY cutoff): 'none' when unset, 'closed-ok'
// once resolved (e.g. VGM Submitted) regardless of date, else 'ok'/'amber'/'red'
// against CUTOFF_WARNING_DAYS. Pure function of the date + today — no DB join needed,
// so it's cheap enough to run inline in mapContainer on every read.
const cutoffState = (dateStr, resolved) => {
  if (resolved) return 'closed-ok';
  if (!dateStr) return 'none';
  const parsed = new Date(dateStr);
  if (isNaN(parsed)) return 'none';
  const days = Math.round((parsed - new Date(new Date().toISOString().slice(0, 10))) / 86400000);
  return days < 0 ? 'red' : days <= CUTOFF_WARNING_DAYS ? 'amber' : 'ok';
};
const mapContainer    = r => ({ id: r.id, shipmentId: r.shipment_id, containerNumber: r.container_number || '', sealNumber: r.seal_number || '', size: r.size, type: r.type, hsCode: r.hs_code || '', cargoDescription: r.cargo_description || '', grossWeightKg: r.gross_weight_kg ?? null, volumeCbm: r.volume_cbm ?? null, isDg: r.is_dg === 1, dgClass: r.dg_class || '',
  vgmWeightKg: r.vgm_weight_kg ?? null, vgmStatus: r.vgm_status || 'Pending', vgmCutoff: r.vgm_cutoff || '',
  vgmCutoffState: cutoffState(r.vgm_cutoff, (r.vgm_status || 'Pending') === 'Submitted'),
  cyCutoff: r.cy_cutoff || '', cyCutoffState: cutoffState(r.cy_cutoff, false),
  originFreeTimeDays: r.origin_free_time_days ?? null, destFreeTimeDays: r.dest_free_time_days ?? null });
const mapContainerEvent = r => ({ id: r.id, containerId: r.container_id, shipmentId: r.shipment_id, eventType: r.event_type, location: r.location || '', occurredAt: r.occurred_at, recordedBy: r.recorded_by || '', notes: r.notes || '', createdAt: r.created_at });
const mapContainerPackage = r => ({ id: r.id, containerId: r.container_id, parentId: r.parent_id || null, description: r.description, quantity: r.quantity, position: r.position, createdAt: r.created_at });
const mapAllocation   = r => ({ id: r.id, carrierCode: r.carrier_code, allocatedTEU: r.allocated_teu, effectiveDate: r.effective_date || '', endDate: r.end_date || '', tradeLane: r.trade_lane || '', notes: r.notes || '', alertThreshold: r.alert_threshold ?? 80, pol: r.pol || '', pod: r.pod || '', originLane: r.origin_lane || '', destLane: r.dest_lane || '', coverageScope: r.coverage_scope || 'STRICT', contractId: r.contract_id || '', contractNumber: r.contract_number || '' });
const mapCarrier      = r => ({ code: r.code, name: r.name, shortName: r.short_name || '' });
const mapVessel       = r => ({ imo: r.imo, name: r.name, assetType: r.asset_type || '', flagIso2: r.flag_iso2 || '', flagName: r.flag_name || '', buildYear: r.build_year, grossTonnage: r.gross_tonnage });
const mapPortLocation = r => ({ unlocode: r.unlocode, name: r.name, latitude: r.latitude, longitude: r.longitude, countryCode: r.country_code, zoneCode: r.zone_code, timezone: r.timezone || null, lastSyncedAt: r.last_synced_at || null });
const mapLinkedPort   = r => ({ id: r.id, primaryUnlocode: r.primary_unlocode, primaryName: r.primary_name || '', linkedUnlocode: r.linked_unlocode, linkedName: r.linked_name || '', note: r.note || '' });
const mapTradeLane    = r => ({ code: r.code, name: r.name, description: r.description || '', countryCount: r.country_count ?? 0, transitDays: r.transit_days ?? 0 });
const mapScopeItem    = r => ({
  id:        r.id,
  userId:    r.user_id,
  role:      r.role     || '',
  itemType:  r.item_type,
  value:     r.value,
  label:     r.label    || '',
  createdAt: r.created_at,
});
const mapAccessConfig = r => ({
  id:           r.id,
  userId:       r.user_id,
  label:        r.label || '',
  originLane:   r.origin_lane  || null,
  destLane:     r.dest_lane    || null,
  polCodes:     r.pol_codes      ? JSON.parse(r.pol_codes)      : [],
  podCodes:     r.pod_codes      ? JSON.parse(r.pod_codes)      : [],
  carrierCodes: r.carrier_codes  ? JSON.parse(r.carrier_codes)  : [],
  createdAt:    r.created_at,
});

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
      shipments = shipments.filter(s =>
        s.emoOfficeId === activeOfficeId ||
        s.imoOfficeId === activeOfficeId ||
        s.controllingOfficeId === activeOfficeId
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
const mapOffice       = r => ({ id: r.id, code: r.code, countryCode: r.country_code, unlocode: r.unlocode, department: r.department, name: r.name, isActive: !!r.is_active, branchId: r.branch_id || null, createdAt: r.created_at });
const mapBranch       = r => ({ id: r.id, code: r.code, name: r.name, countryCode: r.country_code, locode: r.locode || null, city: r.city || null, address: r.address || null, timezone: r.timezone || null, phone: r.phone || null, email: r.email || null, isActive: !!r.is_active, createdAt: r.created_at });
const mapOrgCountry   = r => ({ countryCode: r.country_code, countryName: r.country_name || null, defaultCurrency: r.default_currency || null, timezone: r.timezone || null, branchId: r.branch_id || null, branchCode: r.branch_code || null, branchName: r.branch_name || null, complianceNotes: r.compliance_notes || null, isActive: !!r.is_active, addedAt: r.added_at });
const mapRegion       = r => ({ code: r.code, name: r.name, description: r.description || '' });
const mapCountry      = r => ({ iso2: r.iso2, name: r.name, unMember: r.un_member === 1, regionCode: r.region_code || '', portCount: r.port_count ?? 0 });
const INVERSE_LINK_LABEL = { "Blocks": "Is blocked by", "Duplicates": "Is duplicated by", "Implements": "Is implemented by", "Relates to": "Relates to" };
const inverseLinkLabel = t => INVERSE_LINK_LABEL[t] || t;
const mapTicketLink   = r => ({ id: r.id, fromId: r.from_id, toId: r.to_id, linkType: r.link_type, createdAt: r.created_at });
const mapTicket       = r => ({
  id:              r.id,
  title:           r.title,
  section:         r.section         || '',
  description:     r.description     || '',
  priority:        r.priority        || 'Medium',
  status:          r.status          || 'Ready',
  position:        r.position        ?? 0,
  createdAt:       r.created_at,
  shipmentId:      r.shipment_id     || null,
  type:            r.type            || 'Task',
  version:         r.version         || '',
  // v0.20.0 — nesting + assignee + due date
  parentId:        r.parent_id       || null,
  assigneeId:      r.assignee_id     || null,
  assigneeName:    r.assignee_name   || null,   // joined from users at query time
  assigneeInitial: r.assignee_name   ? r.assignee_name.trim()[0].toUpperCase() : null,
  dueDate:         r.due_date        || null,
  testNotes:       r.test_notes      || null,
  projectId:       r.project_id      || null,
  versionId:       r.version_id      || null,
});
const mapTestItem     = r => ({
  id:              r.id,
  type:            r.type,
  title:           r.title,
  description:     r.description     || '',
  priority:        r.priority        || 'Medium',
  status:          r.status          || 'Ready',
  position:        r.position        ?? 0,
  createdAt:       r.created_at,
  shipmentId:      r.shipment_id     || null,
  parentId:        r.parent_id       || null,
  assigneeId:      r.assignee_id     || null,
  assigneeName:    r.assignee_name   || null,
  assigneeInitial: r.assignee_name   ? r.assignee_name.trim()[0].toUpperCase() : null,
  dueDate:         r.due_date        || null,
  testNotes:       r.test_notes      || null,
  projectId:       r.project_id      || null,
  versionId:       r.version_id      || null,
});
const mapTestCaseLink = r => ({ id: r.id, caseId: r.case_id, ticketId: r.ticket_id, createdAt: r.created_at });
const mapEdiMessage = r => ({
  id:            r.id,
  shipmentId:    r.shipment_id,
  carrierCode:   r.carrier_code,
  direction:     r.direction,
  messageType:   r.message_type,
  format:        r.format || 'JSON',
  rawPayload:    r.raw_payload    || '',
  parsedPayload: r.parsed_payload || '',
  status:        r.status || 'pending',
  correlationId: r.correlation_id || '',
  isMock:        !!r.is_mock,
  createdAt:     r.created_at,
  processedAt:   r.processed_at || null,
});
const mapCarrierBooking = r => ({
  id:                 r.id,
  shipmentId:         r.shipment_id,
  carrierCode:        r.carrier_code || '',
  status:             r.status || 'Pending',
  lastResponseStatus: r.last_response_status || '',
  bookingRef:         r.booking_ref || '',
  correlationId:      r.correlation_id || '',
  isMock:             !!r.is_mock,
  requestedAt:        r.requested_at || null,
  requestedBy:        r.requested_by || '',
  respondedAt:        r.responded_at || null,
  confirmedAt:        r.confirmed_at || null,
  confirmedBy:        r.confirmed_by || '',
  cancelledAt:        r.cancelled_at || null,
  cancelledBy:        r.cancelled_by || '',
  cancelReason:       r.cancel_reason || '',
  createdAt:          r.created_at,
  updatedAt:          r.updated_at,
});
const mapKbProject = r => ({ id: r.id, name: r.name, key: r.key, color: r.color || '#6366f1', description: r.description || '', createdAt: r.created_at });
const mapKbVersion = r => ({ id: r.id, projectId: r.project_id, name: r.name, description: r.description || '', status: r.status || 'Planning', releaseDate: r.release_date || null, createdAt: r.created_at });
const mapKbColumn  = r => ({ id: r.id, projectId: r.project_id, name: r.name, position: r.position ?? 0, color: r.color || '#6366f1', wipLimit: r.wip_limit ?? null, createdAt: r.created_at });
const mapCustomer            = r => ({ id: r.id, companyName: r.company_name, address1: r.address1 || '', address2: r.address2 || '', city: r.city || '', state: r.state || '', postalCode: r.postal_code || '', countryIso2: r.country_iso2 || '', phone: r.phone || '', fax: r.fax || '', email: r.email || '', website: r.website || '', notes: r.notes || '', createdAt: r.created_at, screeningResult: r.screening_result || null, currency: r.currency || 'USD' });
const mapCustomerIdentifier  = r => ({ id: r.id, customerId: r.customer_id, idType: r.id_type, idCode: r.id_code, countryIso2: r.country_iso2 || '', label: r.label || '', isPrimary: !!r.is_primary, createdAt: r.created_at });
const mapCustomerScreening   = r => ({ id: r.id, customerId: r.customer_id, screenedAt: r.screened_at, result: r.result, hits: JSON.parse(r.hits || '[]'), overriddenAt: r.overridden_at || null, overrideReason: r.override_reason || null });
const mapCustomerDoc         = r => ({ id: r.id, customerId: r.customer_id, filename: r.filename, mimeType: r.mime_type, sizeBytes: r.size_bytes, docType: r.doc_type, uploadedBy: r.uploaded_by, createdAt: r.created_at });
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
  transitDays:         r.transit_days,
  vesselService:       r.vessel_service,
  polLinkedAllowed:    r.pol_linked_allowed   === 1,
  podLinkedAllowed:    r.pod_linked_allowed   === 1,
  polCarrierHaulage:   r.pol_carrier_haulage  === 1,
  podCarrierHaulage:   r.pod_carrier_haulage  === 1,
  polHaulageLocations: r.pol_haulage_locations || '',
  podHaulageLocations: r.pod_haulage_locations || '',
  polLocType: r.pol_loc_type || (r.pol_carrier_haulage === 1 ? 'Door' : 'Terminal'),
  podLocType: r.pod_loc_type || (r.pod_carrier_haulage === 1 ? 'Door' : 'Terminal'),
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
  origin_free_time_days: 'Origin Free Time (days)',
  dest_free_time_days:   'Destination Free Time (days)',
};

// Compliance-badge thresholds: how many days out a fixed cutoff (VGM/CY) or a
// container-events-derived free-time window (demurrage/detention) turns amber
// before it's overdue. Free time windows are themselves usually only 3-7 days,
// so they get a tighter warning window than a fixed planning-deadline cutoff.
const CUTOFF_WARNING_DAYS = 3;
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

// Finds a run of legs covering pol->pod as one connected journey. Contracts in this app
// store legs in two different shapes: sequential TSP hops of ONE journey (leg[i].pod ===
// leg[i+1].pol, e.g. NLRTM->BEANR->USNYC) and independent ALTERNATE LANES bundled under a
// single contract (unrelated pol/pod pairs, e.g. an Asia-Europe lane and a separate
// Europe-US lane on the same contract) — a fixed "whole array is one chain" assumption
// breaks the second shape. So: try every possible starting leg whose pol matches the query,
// walk forward only while consecutive legs actually connect, and stop as soon as that
// walked run's pod reaches the query pod — that's the natural boundary of one lane. Haulage
// only attaches at the outer edges of the matched run: the first leg's POL haulage
// (pre-carriage into the run's own first port) and the last leg's POD haulage (on-carriage
// out of its own last port) — never the legs in between. A single-leg run is the simple case.
const findMatchingContractLeg = (legs, { pol, pod, needsPolHaulage, needsPodHaulage, pkuLocation = '', delLocation = '' }) => {
  if (legs.length === 0) return null;
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const pkuU = pkuLocation.toUpperCase(), delU = delLocation.toUpperCase();
  const ordered = [...legs].sort((a, b) => a.leg_order - b.leg_order);

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

  for (let i = 0; i < ordered.length; i++) {
    if (!polMatches(ordered[i])) continue;
    let j = i;
    for (;;) {
      if (podMatches(ordered[j])) {
        if (haulageOk(ordered[i], ordered[j])) {
          return { legs: ordered.slice(i, j + 1), firstLeg: ordered[i], lastLeg: ordered[j],
            matchKind: (ordered[i].pol === polU && ordered[j].pod === podU) ? "exact" : "linked" };
        }
        break; // reached the query pod but haulage failed — this lane is done, try the next start
      }
      const next = ordered[j + 1];
      if (!next || ordered[j].pod !== next.pol) break; // chain doesn't continue — dead end
      j++;
    }
  }
  return null;
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

const SERVICE_CODE_MAP = {
  OF: 'Ocean Freight', OCF: 'Ocean Freight',
  BL: 'B/L Fee',  BLF: 'B/L Fee', DOC: 'B/L Fee',
  THC: 'Origin THC', OTHC: 'Origin THC', ORI: 'Origin THC',
  DTHC: 'Destination THC', DEST: 'Destination THC',
  CUS: 'Customs', CUST: 'Customs',
  INL: 'Inland', INLAND: 'Inland',
};

// Freezes a copy of contract_rates at the point they're committed to a shipment. Later edits to
// contract_rates in MDM never rewrite what was already quoted — "Reset to Contract" replays this
// frozen snapshot, and "Update Carrier Costs" is the only action that generates a new one. See TKT-6QT30S.
function createRateSnapshot(shipmentId, contractId, reason, generatedBy = '') {
  const rates = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(contractId);
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
function importContractRates(shipmentId, opts = {}) {
  const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(shipmentId);
  if (!shipment || shipment.contract_type !== 'Central' || !shipment.contract_id) return 0;
  const existing = db.prepare("SELECT id FROM shipment_rate_snapshots WHERE shipment_id=? ORDER BY generated_at DESC LIMIT 1").get(shipmentId);
  const snapshotId = existing ? existing.id : createRateSnapshot(shipmentId, shipment.contract_id, 'initial');
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

const ctx = {
  db, uid, ok, err, isUniqueViolation,
  auth, requireRole,
  portLanesMap, portCountryMap, rebuildPortLanesMap, longestLane,
  applyShipmentAccessFilter,
  fxCache, getFxRates, toUsd,
  sanctionsMap, loadSanctionsIndex, syncOfacSdn, scheduleNextOfacSync,
  normSanctionName, EMBARGOED_COUNTRIES,
  getSettings,
  shipmentSubs, broadcastMessage, recomputeSpaceBadge,
  UPLOADS_DIR,
  SVC_ABBR, LEG_LOC_ABBR,
  VALID_ROLES, ROLE_RANK_SV, primaryRoleSV, parseUserRoles,
  SERVICE_CODE_MAP, importContractRates, createRateSnapshot, generateCostLinesFromSnapshot,
  mapShipment, mapShipmentLeg, mapCostLine, mapService, mapContainer, mapContainerEvent, mapContainerPackage, mapAllocation,
  mapRateSnapshot, mapRateSnapshotLine, mapChargeCodeDefinition,
  mapCarrier, mapVessel, mapPortLocation, mapLinkedPort, mapTradeLane,
  mapScopeItem, mapAccessConfig, mapOffice, mapBranch, mapOrgCountry, mapRegion, mapCountry, mapTicketLink, mapTicket,
  mapTestItem, mapTestCaseLink,
  mapEdiMessage,
  mapCarrierBooking,
  mapKbProject, mapKbVersion, mapKbColumn,
  mapCustomer, mapCustomerIdentifier, mapCustomerScreening, mapCustomerDoc,
  mapCommodity, mapSystemMessage, mapMilestone, mapMilestoneTemplate,
  mapContract, mapLeg, mapRate,
  logEvent, logEntityEvent, logAdminEvent, TRACKED_FIELDS, TRACKED_CTR_FIELDS,
  CUTOFF_WARNING_DAYS, FREE_TIME_WARNING_DAYS,
  ssoNonces,
  syncShipmentFromLegs,
  checkOverlap,
  autoCompleteMilestone,
  linkedPortCodes, findMatchingContractLeg,
  screenShipmentById,
  bcrypt, jwt, JWT_SECRET,
  inverseLinkLabel,
  fs, path,
};

require('./routes/auth')(app, ctx);
require('./routes/shipments')(app, ctx);
require('./routes/allocations')(app, ctx);
require('./routes/mdm')(app, ctx);
require('./routes/kanban')(app, ctx);
require('./routes/testcases')(app, ctx);
require('./routes/edi')(app, ctx);
require('./routes/customers')(app, ctx);
require('./routes/contracts')(app, ctx);
require('./routes/shipment-ops')(app, ctx);
require('./routes/finance')(app, ctx);
require('./routes/system')(app, ctx);
require('./routes/export')(app, ctx);
require('./routes/ai')(app, ctx);
require('./routes/share')(app, ctx);
require('./routes/offices')(app, ctx);
require('./routes/organization')(app, ctx);
require('./routes/charge-codes')(app, ctx);

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return err(res, "Email and password required");
  const user = db.prepare(
    "SELECT * FROM users WHERE email = ? AND is_active = 1"
  ).get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return err(res, "Invalid email or password", 401);
  const roles = JSON.parse(user.roles || JSON.stringify([user.role || 'viewer']));
  const allOffices = !!user.all_offices;
  const userOffices = db.prepare(`
    SELECT o.id, o.code, o.name, o.department, uo.is_default
    FROM user_offices uo JOIN offices o ON o.id = uo.office_id
    WHERE uo.user_id = ? ORDER BY uo.is_default DESC, o.code
  `).all(user.id).map(r => ({ id: r.id, code: r.code, name: r.name, department: r.department, isDefault: !!r.is_default }));
  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role, roles, allOffices },
    JWT_SECRET, { expiresIn: "8h" }
  );
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
  ok(res, { token, user: { id: user.id, email: user.email, name: user.name, roles, allOffices, offices: userOffices } });
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
// NOTE: VALID_ROLES / ROLE_RANK_SV / primaryRoleSV / parseUserRoles hoisted above to shared helpers.

app.get("/api/users", requireRole(["admin"]), (req, res) => {
  const rows = db.prepare(
    "SELECT id, email, name, role, roles, is_active, created_at, last_login FROM users ORDER BY created_at"
  ).all();
  ok(res, rows.map(r => ({ ...r, roles: parseUserRoles(r) })));
});

app.post("/api/users", requireRole(["admin"]), (req, res) => {
  const { email, name, roles = ["viewer"], password } = req.body || {};
  if (!email || !name || !password) return err(res, "email, name, and password are required");
  if (!roles.length || !roles.every(r => VALID_ROLES.includes(r))) return err(res, "Invalid roles");
  const primary = primaryRoleSV(roles);
  try {
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, role, roles, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))"
    ).run(`USR-${uid()}`, email.toLowerCase().trim(), name, bcrypt.hashSync(password, 10), primary, JSON.stringify(roles));
    ok(res, { ok: true }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return err(res, "Email already in use");
    throw e;
  }
});

app.patch("/api/users/:id", requireRole(["admin"]), (req, res) => {
  const { name, roles, is_active, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return err(res, "User not found", 404);
  if (req.params.id === req.user.id && is_active === 0)
    return err(res, "Cannot deactivate your own account");
  const sets = [], vals = [];
  if (name  !== undefined)     { sets.push("name = ?");          vals.push(name); }
  if (roles !== undefined)     {
    if (!Array.isArray(roles) || !roles.length || !roles.every(r => VALID_ROLES.includes(r)))
      return err(res, "Invalid roles");
    const primary = primaryRoleSV(roles);
    sets.push("role = ?", "roles = ?"); vals.push(primary, JSON.stringify(roles));
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

// ─── User Access Configs ──────────────────────────────────────────────────────

app.get("/api/users/:id/access-configs", requireRole(["admin"]), (req, res) => {
  const rows = db.prepare("SELECT * FROM user_access_configs WHERE user_id=? ORDER BY created_at ASC")
    .all(req.params.id);
  ok(res, rows.map(mapAccessConfig));
});

app.post("/api/users/:id/access-configs", requireRole(["admin"]), (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id=?").get(req.params.id);
  if (!user) return err(res, "User not found", 404);
  const { label = "", originLane, destLane, polCodes, podCodes, carrierCodes } = req.body || {};
  const id  = `UAC-${uid()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_access_configs (id, user_id, label, origin_lane, dest_lane, pol_codes, pod_codes, carrier_codes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.params.id, label.trim(),
    originLane  || null,
    destLane    || null,
    polCodes?.length     ? JSON.stringify(polCodes.map(c => c.toUpperCase()))     : null,
    podCodes?.length     ? JSON.stringify(podCodes.map(c => c.toUpperCase()))     : null,
    carrierCodes?.length ? JSON.stringify(carrierCodes.map(c => c.toUpperCase())) : null,
    now,
  );
  ok(res, mapAccessConfig(db.prepare("SELECT * FROM user_access_configs WHERE id=?").get(id)), 201);
});

app.delete("/api/access-configs/:configId", requireRole(["admin"]), (req, res) => {
  const info = db.prepare("DELETE FROM user_access_configs WHERE id=?").run(req.params.configId);
  if (!info.changes) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.configId });
});

// ─── User Scope Items ─────────────────────────────────────────────────────────

app.get("/api/users/:id/scope", requireRole(["admin"]), (req, res) => {
  const rows = db.prepare("SELECT * FROM user_scope_items WHERE user_id=? ORDER BY created_at ASC")
    .all(req.params.id);
  ok(res, rows.map(mapScopeItem));
});

app.post("/api/users/:id/scope", requireRole(["admin"]), (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id=?").get(req.params.id);
  if (!user) return err(res, "User not found", 404);
  const { role = "", itemType, value, label = "" } = req.body || {};
  if (!itemType || !value) return err(res, "itemType and value are required");
  if (!["trade_lane", "pol", "country"].includes(itemType)) return err(res, "Invalid itemType");
  const id  = `USI-${uid()}`;
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO user_scope_items (id, user_id, role, item_type, value, label, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(id, req.params.id, role, itemType, value, label, now);
  ok(res, mapScopeItem(db.prepare("SELECT * FROM user_scope_items WHERE id=?").get(id)), 201);
});

app.delete("/api/scope-items/:itemId", requireRole(["admin"]), (req, res) => {
  const info = db.prepare("DELETE FROM user_scope_items WHERE id=?").run(req.params.itemId);
  if (!info.changes) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.itemId });
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
  ok(res, applyShipmentAccessFilter(rows.map(mapShipment), req.user, req));
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
  const s = mapShipment(row);
  if (!applyShipmentAccessFilter([s], req.user, req).length) return err(res, "Not found", 404);
  ok(res, s);
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
          allocationId = "", spaceSkipReason = "", spaceOverageReason = "",
          freightTerms = "Prepaid", movementType = "FCL", serviceType = "Port-to-Port",
          placeOfReceipt = "", placeOfDelivery = "", cargoReadyDate = null,
          notifyId = "", notifyName = "",
          declaredValue = null, declaredValueCurrency = "USD" } = req.body;
  if (!pol || !pod || !carrierCode || !contractType) return err(res, "pol, pod, carrierCode, contractType required");
  const id = `SHP-${uid()}`;
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO shipments (id,pol,pod,carrier_code,contract_type,contract_notes,status,created_at,etd,eta,booking_ref,bl_number,vessel,voyage,incoterm,vessel_imo,contract_id,contract_ref,commodity_code,shipper_id,shipper_name,consignee_id,consignee_name,principal_id,principal_name,allocation_id,space_skip_reason,space_overage_reason,freight_terms,movement_type,service_type,place_of_receipt,place_of_delivery,cargo_ready_date,notify_id,notify_name,declared_value,declared_value_currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, polU, podU, carrierCode, contractType, contractNotes, status, createdAt, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, contractId, contractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName, allocationId, spaceSkipReason, spaceOverageReason, freightTerms, movementType, serviceType, placeOfReceipt, placeOfDelivery, cargoReadyDate || null, notifyId, notifyName, (declaredValue !== null && declaredValue !== undefined && String(declaredValue).trim() !== '') ? Number(declaredValue) : null, declaredValueCurrency || "USD");
  logEvent(id, 'SHIPMENT_CREATED', null, null, null,
    JSON.stringify({ pol: polU, pod: podU, carrier: carrierCode, status, etd, contractType }));
  if (contractType === 'Central' && contractId) importContractRates(id);
  const silentScreening = sanctionsMap.size > 0 ? screenShipmentById(id) : null;
  const base = mapShipment(db.prepare("SELECT * FROM shipments WHERE id=?").get(id));
  ok(res, silentScreening ? { ...base, screening: silentScreening } : base, 201);
});

app.put("/api/shipments/:id", (req, res) => {
  const { pol, pod, carrierCode, contractType, contractNotes = "", status,
          etd = "", eta = "", bookingRef = "", blNumber = "", vessel = "", voyage = "",
          incoterm = "", vesselImo = "", contractId = "", contractRef = "", commodityCode = "",
          shipperId = "", shipperName = "", consigneeId = "", consigneeName = "",
          principalId = "", principalName = "",
          allocationId = "", spaceSkipReason = "", spaceOverageReason = "",
          freightTerms = "Prepaid", movementType = "FCL", serviceType = "Port-to-Port",
          placeOfReceipt = "", placeOfDelivery = "", cargoReadyDate = null,
          notifyId = "", notifyName = "",
          declaredValue = null, declaredValueCurrency = "USD" } = req.body;
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const existing = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const info = db.prepare(`
    UPDATE shipments SET pol=?, pod=?, carrier_code=?, contract_type=?, contract_notes=?, status=?,
    etd=?, eta=?, booking_ref=?, bl_number=?, vessel=?, voyage=?, incoterm=?, vessel_imo=?, contract_id=?, contract_ref=?, commodity_code=?,
    shipper_id=?, shipper_name=?, consignee_id=?, consignee_name=?, principal_id=?, principal_name=?,
    allocation_id=?, space_skip_reason=?, space_overage_reason=?,
    freight_terms=?, movement_type=?, service_type=?, place_of_receipt=?, place_of_delivery=?,
    cargo_ready_date=?, notify_id=?, notify_name=?,
    declared_value=?, declared_value_currency=? WHERE id=?
  `).run(polU, podU, carrierCode, contractType, contractNotes, status, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, contractId, contractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName, allocationId, spaceSkipReason, spaceOverageReason, freightTerms, movementType, serviceType, placeOfReceipt, placeOfDelivery, cargoReadyDate || null, notifyId, notifyName, (declaredValue !== null && declaredValue !== undefined && String(declaredValue).trim() !== '') ? Number(declaredValue) : null, declaredValueCurrency || "USD", req.params.id);
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

  // Auto-create per-container BUY lines when shipment is on a Central contract
  const shipForSync = db.prepare("SELECT contract_type, contract_id FROM shipments WHERE id=?").get(shipmentId);
  if (shipForSync?.contract_type === 'Central' && shipForSync?.contract_id) {
    const perCtrRates = db.prepare(
      "SELECT * FROM contract_rates WHERE contract_id=? AND unit='per_container' ORDER BY sort_order"
    ).all(shipForSync.contract_id);
    const now = new Date().toISOString();
    for (const r of perCtrRates) {
      const ctrKey = `${size || ''}${type || ''}`.toUpperCase();
      const rateKey = (r.container_type || '').toUpperCase();
      const matches = !rateKey || ctrKey === rateKey;
      const chargeCode   = SERVICE_CODE_MAP[r.service_code?.toUpperCase()] || 'Other';
      const exchangeRate = (r.amount > 0 && r.amount_usd > 0) ? Math.round((r.amount_usd / r.amount) * 100000) / 100000 : 1;
      const notes = [r.service_code, r.description].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' — ');
      const lineId = `CL-${uid()}`;
      db.prepare("INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,notes,container_id,created_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(lineId, shipmentId, 'BUY', chargeCode, r.currency || 'USD', matches ? r.amount : 0, exchangeRate, notes, id, now, 'contract');
    }
  }

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
  // Remove contract-sourced BUY lines scoped to this container before deleting it
  db.prepare("DELETE FROM shipment_cost_lines WHERE container_id=? AND source='contract' AND type='BUY'").run(req.params.id);
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
    rebuildPortLanesMap();
    ok(res, { iso2, lanes });
  } catch(e) { db.exec("ROLLBACK"); err(res, e.message); }
});

app.delete("/api/country-trade-lanes/:iso2/:laneCode", (req, res) => { db.prepare("DELETE FROM country_trade_lanes WHERE iso2=? AND lane_code=?").run(req.params.iso2, req.params.laneCode); rebuildPortLanesMap(); ok(res, { deleted: true }); });

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
// Each ticket row is JOIN-ed with users so assignee name is always included in
// the response without a second round-trip from the client.

const TICKET_JOIN = `
  SELECT t.*, u.name AS assignee_name
  FROM   tickets t
  LEFT   JOIN users u ON t.assignee_id = u.id
`;

app.get("/api/tickets", (req, res) =>
  ok(res, db.prepare(`${TICKET_JOIN} ORDER BY t.status, t.position, t.created_at`).all().map(mapTicket))
);

app.post("/api/tickets", (req, res) => {
  const {
    title, section = '', description = '', priority = 'Medium', status = 'Ready',
    shipmentId = null, type = 'Task', version = '',
    parentId = null, assigneeId = null, dueDate = null, testNotes = null,
  } = req.body;
  if (!title) return err(res, "title required");
  const id  = `TKT-${uid()}`;
  const pos = (db.prepare("SELECT MAX(position) AS m FROM tickets WHERE status=?").get(status)?.m ?? -1) + 1;
  db.prepare(`
    INSERT INTO tickets
      (id, title, section, description, priority, status, position, created_at,
       shipment_id, type, version, parent_id, assignee_id, due_date, test_notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, title, section, description, priority, status, pos, new Date().toISOString(),
         shipmentId || null, type, version, parentId || null, assigneeId || null, dueDate || null,
         testNotes || null);
  const row = db.prepare(`${TICKET_JOIN} WHERE t.id=?`).get(id);
  ok(res, mapTicket(row), 201);
});

app.put("/api/tickets/:id", (req, res) => {
  const {
    title, section = '', description = '', priority = 'Medium', status = 'Ready', position = 0,
    shipmentId = null, type = 'Task', version = '',
    parentId = null, assigneeId = null, dueDate = null, testNotes = null,
  } = req.body;
  const info = db.prepare(`
    UPDATE tickets
    SET title=?, section=?, description=?, priority=?, status=?, position=?,
        shipment_id=?, type=?, version=?, parent_id=?, assignee_id=?, due_date=?, test_notes=?
    WHERE id=?
  `).run(title, section, description, priority, status, position,
         shipmentId || null, type, version, parentId || null, assigneeId || null, dueDate || null,
         testNotes || null, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  const row = db.prepare(`${TICKET_JOIN} WHERE t.id=?`).get(req.params.id);
  ok(res, mapTicket(row));
});

app.delete("/api/tickets/:id", (req, res) => {
  const info = db.prepare("DELETE FROM tickets WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

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
    db.prepare(`INSERT INTO contract_legs (id,contract_id,leg_order,pol,pol_name,pod,pod_name,transit_days,vessel_service,pol_linked_allowed,pod_linked_allowed,pol_carrier_haulage,pod_carrier_haulage,pol_haulage_locations,pod_haulage_locations,pol_loc_type,pod_loc_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(legId, contractId, i, l.pol||"", l.polName||"", l.pod||"", l.podName||"", l.transitDays||0, l.vesselService||"",
           l.polLinkedAllowed ? 1 : 0, l.podLinkedAllowed ? 1 : 0,
           l.polCarrierHaulage ? 1 : 0, l.podCarrierHaulage ? 1 : 0,
           l.polHaulageLocations || "", l.podHaulageLocations || "",
           l.polLocType || 'Terminal', l.podLocType || 'Terminal');
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
  const { pol = "", pod = "", etd = "", crd = "", carrier = "",
          routingTerm = "", pkuLocation = "", delLocation = "" } = req.query;
  if (!pol || !pod) return ok(res, []);

  const polU = pol.toUpperCase();
  const podU = pod.toUpperCase();
  const pkuU = pkuLocation.toUpperCase();
  const delU = delLocation.toUpperCase();
  const dateRef = crd || etd; // prefer Cargo Ready Date; fall back to ETD

  // Routing term components: e.g. "DR-PT" → polLoc="DR", podLoc="PT"
  const [polLocAbbr = "", podLocAbbr = ""] = routingTerm.split("-");
  const needsPolHaulage = polLocAbbr === "DR";
  const needsPodHaulage = podLocAbbr === "DR";

  // Returns all ports bidirectionally linked to `code` (not including code itself)
  const linkedTo = code => db.prepare(`
    SELECT CASE WHEN primary_unlocode=? THEN linked_unlocode ELSE primary_unlocode END AS code
    FROM linked_ports WHERE primary_unlocode=? OR linked_unlocode=?
  `).all(code, code, code).map(r => r.code);

  // Candidate contracts: validity window (if date provided) + carrier + active
  const clauses = ["c.status='Active'"];
  const params  = [];
  if (dateRef) { clauses.push("c.valid_from<=? AND c.valid_to>=?"); params.push(dateRef, dateRef); }
  if (carrier.trim()) { clauses.push("c.carrier_code=?"); params.push(carrier.trim().toUpperCase()); }

  const candidates = db.prepare(
    `SELECT c.* FROM contracts c WHERE ${clauses.join(" AND ")} ORDER BY c.valid_from DESC LIMIT 50`
  ).all(...params);

  const results = [];
  for (const c of candidates) {
    const legs = db.prepare("SELECT * FROM contract_legs WHERE contract_id=? ORDER BY leg_order").all(c.id);

    for (const leg of legs) {
      // POL/POD port matching (with linked-port expansion)
      const polSet = leg.pol_linked_allowed ? [leg.pol, ...linkedTo(leg.pol)] : [leg.pol];
      const podSet = leg.pod_linked_allowed ? [leg.pod, ...linkedTo(leg.pod)] : [leg.pod];
      if (!polSet.includes(polU) || !podSet.includes(podU)) continue;

      // Carrier haulage (pickup) — inclusive: contract WITH haulage matches shipments that don't need it
      if (needsPolHaulage && !leg.pol_carrier_haulage) continue;
      if (needsPolHaulage && leg.pol_carrier_haulage && leg.pol_haulage_locations) {
        const allowed = leg.pol_haulage_locations.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
        if (allowed.length > 0 && pkuU && !allowed.includes(pkuU)) continue;
      }

      // Carrier haulage (delivery) — same inclusive logic
      if (needsPodHaulage && !leg.pod_carrier_haulage) continue;
      if (needsPodHaulage && leg.pod_carrier_haulage && leg.pod_haulage_locations) {
        const allowed = leg.pod_haulage_locations.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
        if (allowed.length > 0 && delU && !allowed.includes(delU)) continue;
      }

      const matchKind    = (leg.pol === polU && leg.pod === podU) ? "exact" : "linked";
      const linkedPolVia = leg.pol !== polU ? leg.pol : null;
      const linkedPodVia = leg.pod !== podU ? leg.pod : null;
      results.push({ ...mapContract(c), legs: legs.map(mapLeg), matchKind, linkedPolVia, linkedPodVia });
      break; // first matching leg wins — don't add the same contract twice
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
          pol="", pod="", polOrigin="", podDestination="", routingTerm="",
          namedAccount="",
          limit="50", offset="0" } = req.query;
  const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
  const clauses = [], params = [];

  if (carrier.trim()) {
    const codes = carrier.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
    if (codes.length === 1) { clauses.push("c.carrier_code LIKE ?"); params.push(`%${codes[0]}%`); }
    else { clauses.push(`c.carrier_code IN (${codes.map(() => "?").join(",")})`); params.push(...codes); }
  }
  if (status.trim())        { clauses.push("c.status=?");               params.push(status.trim()); }
  if (dg !== "")            { clauses.push("c.dg_allowed=?");           params.push(dg === "1" ? 1 : 0); }
  if (asOf.trim())          { clauses.push("c.valid_from<=? AND c.valid_to>=?"); params.push(asOf, asOf); }
  if (containerType.trim()) { clauses.push("c.container_types LIKE ?"); params.push(`%"${containerType.trim()}"%`); }
  if (namedAccount.trim())  { clauses.push("(c.named_account LIKE ? OR c.named_account_id LIKE ?)"); const n = `%${namedAccount.trim()}%`; params.push(n, n); }

  // Leg-based port filters
  if (pol.trim()) {
    clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND UPPER(l.pol)=UPPER(?))");
    params.push(pol.trim());
  }
  if (pod.trim()) {
    clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND UPPER(l.pod)=UPPER(?))");
    params.push(pod.trim());
  }
  // Via origin: door/barge origin before the seaport POL (pol_carrier_haulage leg)
  if (polOrigin.trim()) {
    clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND UPPER(l.pol)=UPPER(?) AND l.pol_carrier_haulage=1)");
    params.push(polOrigin.trim());
  }
  // Via destination: door/barge destination after the seaport POD (pod_carrier_haulage leg)
  if (podDestination.trim()) {
    clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND UPPER(l.pod)=UPPER(?) AND l.pod_carrier_haulage=1)");
    params.push(podDestination.trim());
  }
  // Routing term filter based on haulage leg presence.
  // CY and Door both use the same pol_carrier_haulage / pod_carrier_haulage flags for now;
  // a future contract_legs.pol_loc_type column would allow exact CY vs Door distinction.
  if (routingTerm.trim()) {
    const hasPol = "EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pol_carrier_haulage=1)";
    const hasPod = "EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pod_carrier_haulage=1)";
    if (routingTerm === "P2P")                                  clauses.push(`NOT ${hasPol} AND NOT ${hasPod}`);
    if (["D2P","CY2P"].includes(routingTerm))                   clauses.push(`${hasPol} AND NOT ${hasPod}`);
    if (["P2D","P2CY"].includes(routingTerm))                   clauses.push(`NOT ${hasPol} AND ${hasPod}`);
    if (["D2D","D2CY","CY2D","CY2CY"].includes(routingTerm))   clauses.push(`${hasPol} AND ${hasPod}`);
  }

  if (search.trim()) {
    clauses.push(`(c.contract_number LIKE ? OR c.contract_ref LIKE ? OR c.named_account LIKE ? OR c.carrier_code LIKE ? OR EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND (l.pol LIKE ? OR l.pod LIKE ? OR l.pol_name LIKE ? OR l.pod_name LIKE ?)))`);
    const s = `%${search.trim()}%`;
    params.push(s, s, s, s, s, s, s, s);
  }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM contracts c ${where}`).get(...params).n;
  const rows  = db.prepare(`SELECT c.* FROM contracts c ${where} ORDER BY c.valid_from DESC, c.created_at DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
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

// Pending-contract revalidation — exact match on contract_number, Active only.
// Must be registered before /api/contracts/:id to avoid the param route swallowing it.
app.get("/api/contracts/revalidate", (req, res) => {
  const { ref = "" } = req.query;
  if (!ref.trim()) return ok(res, []);
  const rows = db.prepare(
    "SELECT * FROM contracts WHERE LOWER(contract_number) = LOWER(?) AND status = 'Active' ORDER BY valid_from DESC"
  ).all(ref.trim());
  ok(res, rows.map(mapContract));
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
// NOTE: broadcastMessage / recomputeSpaceBadge hoisted above to shared helpers.

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

// ─── Shipment Legs ────────────────────────────────────────────────────────────

app.get("/api/shipments/:id/legs", auth(), (req, res) => {
  const rows = db.prepare("SELECT * FROM shipment_legs WHERE shipment_id=? ORDER BY leg_order ASC").all(req.params.id);
  ok(res, rows.map(mapShipmentLeg));
});

const LEG_TO_MOT = { 'SEA': 'SEA', 'AIR': 'AIR', 'RAIL': 'RAIL', 'Pick-up': 'ROAD', 'Delivery': 'ROAD', 'Feeder': 'SEA' };

app.post("/api/shipments/:id/legs", auth(), (req, res) => {
  const { legType='SEA', movementType='SEA', movementBy='',
          mot: rawMot, pol='', pod='', etd=null, eta=null, carrierCode='',
          polLocType='Terminal', podLocType='Terminal',
          vessel='', vesselImo='', voyage='', contractType='', contractRef='' } = req.body;
  const mot = rawMot || LEG_TO_MOT[legType] || 'SEA';
  const id = `LEG-${uid()}`;
  const maxOrder = db.prepare("SELECT MAX(leg_order) as m FROM shipment_legs WHERE shipment_id=?").get(req.params.id);
  const legOrder = (maxOrder?.m ?? -1) + 1;
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO shipment_legs (id,shipment_id,leg_order,mot,leg_type,movement_type,pol,pod,pol_loc_type,pod_loc_type,etd,eta,carrier_code,vessel,vessel_imo,voyage,movement_by,contract_type,contract_ref,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.params.id, legOrder, mot, legType, movementType,
         pol.toUpperCase(), pod.toUpperCase(), polLocType, podLocType,
         etd||null, eta||null, carrierCode, vessel, vesselImo, voyage, movementBy,
         contractType, contractRef, createdAt);
  syncShipmentFromLegs(req.params.id);
  ok(res, mapShipmentLeg(db.prepare("SELECT * FROM shipment_legs WHERE id=?").get(id)), 201);
});

app.put("/api/shipments/:id/legs/:legId", auth(), (req, res) => {
  const { legType='SEA', movementType='SEA', movementBy='',
          mot: rawMot, pol='', pod='', etd=null, eta=null, carrierCode='',
          polLocType='Terminal', podLocType='Terminal',
          vessel='', vesselImo='', voyage='', contractType='', contractRef='', legOrder } = req.body;
  const mot = rawMot || LEG_TO_MOT[legType] || 'SEA';
  const existing = db.prepare("SELECT * FROM shipment_legs WHERE id=? AND shipment_id=?").get(req.params.legId, req.params.id);
  if (!existing) return err(res, "Not found", 404);
  db.prepare(`UPDATE shipment_legs SET mot=?,leg_type=?,movement_type=?,pol=?,pod=?,pol_loc_type=?,pod_loc_type=?,etd=?,eta=?,carrier_code=?,vessel=?,vessel_imo=?,voyage=?,movement_by=?,contract_type=?,contract_ref=?,leg_order=? WHERE id=?`)
    .run(mot, legType, movementType, pol.toUpperCase(), pod.toUpperCase(),
         polLocType, podLocType, etd||null, eta||null,
         carrierCode, vessel, vesselImo, voyage, movementBy,
         contractType, contractRef, legOrder ?? existing.leg_order, req.params.legId);
  syncShipmentFromLegs(req.params.id);
  ok(res, mapShipmentLeg(db.prepare("SELECT * FROM shipment_legs WHERE id=?").get(req.params.legId)));
});

app.delete("/api/shipments/:id/legs/:legId", auth(), (req, res) => {
  const info = db.prepare("DELETE FROM shipment_legs WHERE id=? AND shipment_id=?").run(req.params.legId, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  syncShipmentFromLegs(req.params.id);
  ok(res, { deleted: req.params.legId });
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
      version:       "0.20.0",
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

// ─── Cost Lines ───────────────────────────────────────────────────────────────
// NOTE: SERVICE_CODE_MAP / importContractRates hoisted above to shared helpers.

app.post("/api/shipments/:id/cost-lines/import-contract", (req, res) => {
  const { overwrite = false, splitPerContainer = false } = req.body || {};
  const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
  if (!shipment) return err(res, "Shipment not found", 404);
  if (shipment.contract_type !== 'Central' || !shipment.contract_id)
    return err(res, "Shipment is not linked to a Central contract");
  let includeSell = false;
  if (overwrite) {
    const existingBuy  = db.prepare("SELECT id FROM shipment_cost_lines WHERE shipment_id=? AND type='BUY'  AND source='contract'").all(req.params.id);
    const existingSell = db.prepare("SELECT id FROM shipment_cost_lines WHERE shipment_id=? AND type='SELL' AND source='contract'").all(req.params.id);
    includeSell = existingSell.length > 0;
    for (const row of [...existingBuy, ...existingSell]) db.prepare("DELETE FROM shipment_cost_lines WHERE id=?").run(row.id);
  }
  const count = importContractRates(req.params.id, { splitPerContainer, includeSell });
  ok(res, { imported: count });
});

app.get("/api/shipments/:id/cost-lines", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM shipment_cost_lines WHERE shipment_id=? ORDER BY type, created_at ASC"
  ).all(req.params.id);
  ok(res, rows.map(mapCostLine));
});

app.post("/api/shipments/:id/cost-lines", (req, res) => {
  const { type, chargeCode, currency = 'USD', amount, exchangeRate = 1, notes = '', containerId = '', source: rawSource } = req.body;
  if (!type || !chargeCode || amount == null) return err(res, "type, chargeCode, amount required");
  if (!['BUY','SELL'].includes(type)) return err(res, "type must be BUY or SELL");
  const source = rawSource === 'contract' ? 'contract' : 'manual';
  const id  = `CL-${uid()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,notes,container_id,created_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, req.params.id, type, chargeCode, currency.toUpperCase(), Number(amount), Number(exchangeRate), notes, containerId, now, source);
  logEntityEvent('cost_line', id, 'CREATED', null, null, null,
    JSON.stringify({ shipmentId: req.params.id, type, chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchangeRate: Number(exchangeRate) }));
  ok(res, mapCostLine({ id, shipment_id: req.params.id, type, charge_code: chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchange_rate: Number(exchangeRate), notes, container_id: containerId, source, modified_at: null, created_at: now }), 201);
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

// ─── Shipment Documents ───────────────────────────────────────────────────────

const STALE_EVENTS = db.prepare(`
  SELECT COUNT(*) as n FROM shipment_events
  WHERE shipment_id = ? AND occurred_at > ?
  AND event_type IN ('FIELD_UPDATED','CONTAINER_ADDED','CONTAINER_REMOVED','CONTAINER_UPDATED')
`);

const mapDoc = (r, shipmentId) => {
  const sid = shipmentId || r.shipment_id;
  const { n } = STALE_EVENTS.get(sid, r.created_at);
  return {
    id: r.id, shipmentId: r.shipment_id, filename: r.filename,
    mimeType: r.mime_type, sizeBytes: r.size_bytes,
    docType: r.doc_type, uploadedBy: r.uploaded_by, createdAt: r.created_at,
    status: r.status || 'draft',
    confirmedAt: r.confirmed_at || null, confirmedBy: r.confirmed_by || '',
    isStale: n > 0,
  };
};

app.get("/api/shipments/:id/documents", auth(), (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM shipment_documents WHERE shipment_id = ? ORDER BY created_at DESC"
  ).all(req.params.id);
  ok(res, rows.map(r => mapDoc(r, req.params.id)));
});

app.post("/api/shipments/:id/documents", auth(), (req, res) => {
  const { filename, mimeType, docType, data } = req.body;
  if (!filename || !data) return err(res, "filename and data are required");
  try {
    const buf        = Buffer.from(data, "base64");
    const ext        = path.extname(filename) || "";
    const storedName = `${Date.now()}_${uid()}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buf);
    const id       = `DOC-${uid()}`;
    const now      = new Date().toISOString();
    const uploader = req.user?.name || req.user?.email || "";
    db.prepare(`INSERT INTO shipment_documents
      (id, shipment_id, filename, stored_name, mime_type, size_bytes, doc_type, uploaded_by, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`)
      .run(id, req.params.id, filename, storedName, mimeType || "", buf.length, docType || "OT", uploader, now);
    const row = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(id);
    ok(res, mapDoc(row, req.params.id), 201);
  } catch (e) { err(res, e.message, 500); }
});

app.patch("/api/documents/:docId", auth(), (req, res) => {
  const doc = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(req.params.docId);
  if (!doc) return err(res, "Not found", 404);
  const { status } = req.body;
  if (!["draft", "confirmed"].includes(status)) return err(res, "status must be draft or confirmed");
  const now = new Date().toISOString();
  db.prepare("UPDATE shipment_documents SET status=?, confirmed_at=?, confirmed_by=? WHERE id=?")
    .run(status, status === "confirmed" ? now : null, status === "confirmed" ? (req.user?.name || req.user?.email || "") : "", req.params.docId);
  const updated = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(req.params.docId);
  ok(res, mapDoc(updated, updated.shipment_id));
});

app.get("/api/documents/:docId/download", auth(), (req, res) => {
  const doc = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(req.params.docId);
  if (!doc) return err(res, "Not found", 404);
  const filePath = path.join(UPLOADS_DIR, doc.stored_name);
  if (!fs.existsSync(filePath)) return err(res, "File not found on disk", 404);
  const inline = (doc.mime_type || "").startsWith("text/") || doc.mime_type === "application/pdf";
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${doc.filename}"`);
  res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
  fs.createReadStream(filePath).pipe(res);
});

app.delete("/api/documents/:docId", auth(), (req, res) => {
  const doc = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(req.params.docId);
  if (!doc) return err(res, "Not found", 404);
  try { fs.unlinkSync(path.join(UPLOADS_DIR, doc.stored_name)); } catch {}
  db.prepare("DELETE FROM shipment_documents WHERE id = ?").run(req.params.docId);
  ok(res, { ok: true });
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

// ─── Schedules ────────────────────────────────────────────────────────────────

// Carrier codes served by the Maersk Developer API
const MAERSK_CODES = new Set(["CMDU", "MAEU", "SAFM", "MCPU"]);

function mockSailings(pol, pod, carrierCode, weeks) {
  const NAMES = ["ALLEGRO","BRAVURA","CADENZA","DULCIMER","ENSEMBLE","FANFARE","GRANDEUR","HARMONY"];
  const today = new Date();
  const count = Math.max(1, Math.round(weeks * 1.5));
  return Array.from({ length: count }, (_, i) => {
    const etd = new Date(today);
    etd.setDate(etd.getDate() + 4 + i * Math.round(7 / 1.5));
    const transit = 14 + Math.floor(Math.random() * 22);
    const eta = new Date(etd);
    eta.setDate(eta.getDate() + transit);
    return {
      carrier: carrierCode || "—",
      vesselName: `DEMO ${NAMES[i % NAMES.length]}`,
      voyageNumber: `DM${String(i + 1).padStart(3, "0")}W`,
      service: "DEMO SERVICE",
      pol, pod,
      etd: etd.toISOString().slice(0, 10),
      eta: eta.toISOString().slice(0, 10),
      transitDays: transit,
      isMock: true,
    };
  });
}

async function maerskSchedules(pol, pod, weeks) {
  const key = getSettings().maersk_api_key;
  if (!key) return null;
  try {
    const startDate = new Date().toISOString().slice(0, 10);
    const qs = new URLSearchParams({
      portOfOrigin: pol, portOfDestination: pod,
      startDateType: "D", startDate, searchRange: String(weeks),
    });
    const r = await fetch(`https://api.maersk.com/schedules/point-to-point?${qs}`, {
      headers: { "Consumer-Key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const items = Array.isArray(data) ? data : (data.sailings || []);
    return items.map(s => {
      const svc = (s.services || [])[0] || {};
      return {
        carrier: "CMDU",
        vesselName: svc.vesselName || "—",
        voyageNumber: svc.voyageNumber || "—",
        service: svc.serviceCode || "—",
        pol, pod,
        etd: (s.originDepartureDateTimeLocal || "").slice(0, 10),
        eta: (s.destinationArrivalDateTimeLocal || "").slice(0, 10),
        transitDays: s.transitTime || 0,
        isMock: false,
      };
    });
  } catch { return null; }
}

app.get("/api/schedules/search", auth(), async (req, res) => {
  const { pol, pod, carrierCode, weeks: w = "4" } = req.query;
  if (!pol || !pod) return res.status(400).json({ error: "pol and pod are required" });
  const weeks = Math.min(Math.max(parseInt(w) || 4, 1), 12);

  let sailings = null;
  if (MAERSK_CODES.has(carrierCode)) sailings = await maerskSchedules(pol, pod, weeks);

  const isMock = !sailings;
  if (isMock) sailings = mockSailings(pol, pod, carrierCode, weeks);

  ok(res, { sailings, pol, pod, carrierCode, isMock });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// shipmentSubs is pre-declared near portLanesMap above so route modules can receive it via ctx.

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