"use strict";
// Full Postgres schema for the monolith, reconstructed directly from the live cargodesk.db's own
// sqlite_master (the true, final, currently-running schema) rather than manually reconciling the
// ~1,600-line historical migrations array that produced it — that array is now retired entirely.
// Boolean columns (INTEGER 0/1 in SQLite) become real BOOLEAN throughout; every application-side
// read/write site that did `!!row.col` or `col ? 1 : 0` needs the matching fix during the route
// file conversion pass. CHECK constraints, foreign keys, and composite/unique keys are carried
// over as-is (Postgres syntax is compatible). `DEFAULT (datetime('now'))` becomes `DEFAULT
// now()::text` — a minor, harmless format difference (SQLite's own datetime() emits
// 'YYYY-MM-DD HH:MM:SS', Postgres's now()::text emits a slightly different but still valid
// timestamp string) that only matters for the rare row relying on the DB-level default instead of
// the application's own explicit ISO-8601 created_at.
async function initSchema(query) {

await query(`CREATE TABLE IF NOT EXISTS admin_events (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL DEFAULT '',
  actor_email TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  details     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (now()::text)
)`);

await query(`CREATE TABLE IF NOT EXISTS allocations (
  id              TEXT PRIMARY KEY,
  carrier_code    TEXT NOT NULL,
  allocated_teu   INTEGER NOT NULL DEFAULT 0,
  effective_date  TEXT NOT NULL DEFAULT '2025-01-01',
  end_date        TEXT NOT NULL DEFAULT '2025-12-31',
  trade_lane      TEXT DEFAULT '',
  notes           TEXT DEFAULT '',
  alert_threshold INTEGER DEFAULT 80,
  pol             TEXT DEFAULT '',
  pod             TEXT DEFAULT '',
  origin_lane     TEXT DEFAULT '',
  dest_lane       TEXT DEFAULT '',
  coverage_scope  TEXT DEFAULT 'STRICT',
  contract_id     TEXT DEFAULT '',
  contract_number TEXT DEFAULT '',
  minimum_teu     INTEGER DEFAULT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS branches (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  country_code TEXT NOT NULL,
  city         TEXT,
  address      TEXT,
  timezone     TEXT,
  phone        TEXT,
  email        TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TEXT NOT NULL DEFAULT (now()::text),
  locode       TEXT,
  currency     TEXT DEFAULT NULL
)`);

// carrier_agents/carrier_agent_locations/carrier_agent_schedule_rows created before carriers'
// own reference isn't needed (no FK to carriers.code exists on these) but agent_customer_id
// references customers(id) — customers must exist first.
await query(`CREATE TABLE IF NOT EXISTS customers (
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
  created_at   TEXT NOT NULL,
  currency               TEXT DEFAULT 'USD',
  credit_limit           REAL DEFAULT NULL,
  credit_terms_days      INTEGER DEFAULT NULL,
  credit_hold            BOOLEAN NOT NULL DEFAULT FALSE,
  credit_hold_reason     TEXT DEFAULT '',
  parent_customer_id     TEXT REFERENCES customers(id) ON DELETE SET NULL,
  classified_location    BOOLEAN NOT NULL DEFAULT FALSE,
  latitude               REAL DEFAULT NULL,
  longitude              REAL DEFAULT NULL,
  is_nvocc               BOOLEAN NOT NULL DEFAULT FALSE,
  fmc_number             TEXT DEFAULT '',
  invoice_deadline_days  INTEGER DEFAULT NULL,
  reminder_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_interval_days INTEGER DEFAULT NULL,
  billing_by_day         INTEGER DEFAULT NULL,
  payment_settlement_day INTEGER DEFAULT NULL,
  holiday_unlocode       TEXT DEFAULT ''
)`);

await query(`CREATE TABLE IF NOT EXISTS countries (
  iso2        TEXT PRIMARY KEY CHECK(length(iso2) = 2),
  name        TEXT NOT NULL,
  un_member   BOOLEAN DEFAULT TRUE,
  region_code TEXT,
  invoice_alert_business_days      INTEGER DEFAULT NULL,
  invoice_escalation_business_days INTEGER DEFAULT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS port_locations (
  unlocode       TEXT PRIMARY KEY CHECK(length(unlocode) = 5),
  name           TEXT NOT NULL,
  latitude       REAL,
  longitude      REAL,
  country_code   TEXT,
  zone_code      TEXT,
  last_synced_at TEXT DEFAULT NULL,
  timezone       TEXT
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_port_locations_country ON port_locations(country_code)`);
await query(`CREATE INDEX IF NOT EXISTS idx_port_locations_name ON port_locations(name)`);

await query(`CREATE TABLE IF NOT EXISTS carrier_agents (
  id                TEXT PRIMARY KEY,
  carrier_code      TEXT NOT NULL,
  agent_customer_id TEXT NOT NULL REFERENCES customers(id),
  note              TEXT DEFAULT '',
  created_at        TEXT NOT NULL,
  capabilities      TEXT DEFAULT '[]',
  UNIQUE(carrier_code, agent_customer_id)
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_carrier_agents_customer ON carrier_agents(agent_customer_id)`);

await query(`CREATE TABLE IF NOT EXISTS carrier_agent_locations (
  id               TEXT PRIMARY KEY,
  carrier_agent_id TEXT NOT NULL REFERENCES carrier_agents(id) ON DELETE CASCADE,
  carrier_code     TEXT NOT NULL,
  location_type    TEXT NOT NULL CHECK(location_type IN ('unlocode','country')),
  unlocode         TEXT REFERENCES port_locations(unlocode),
  country_iso2     TEXT REFERENCES countries(iso2),
  created_at       TEXT NOT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_cal_agent ON carrier_agent_locations(carrier_agent_id)`);
await query(`CREATE INDEX IF NOT EXISTS idx_cal_carrier_country ON carrier_agent_locations(carrier_code, country_iso2)`);
await query(`CREATE INDEX IF NOT EXISTS idx_cal_carrier_unlocode ON carrier_agent_locations(carrier_code, unlocode)`);

await query(`CREATE TABLE IF NOT EXISTS carrier_agent_schedule_rows (
  id               TEXT PRIMARY KEY,
  carrier_agent_id TEXT NOT NULL REFERENCES carrier_agents(id) ON DELETE CASCADE,
  days             TEXT NOT NULL,
  start_time       TEXT NOT NULL,
  end_time         TEXT NOT NULL,
  sort_order       INTEGER DEFAULT 0,
  created_at       TEXT NOT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_casr_agent ON carrier_agent_schedule_rows(carrier_agent_id)`);

await query(`CREATE TABLE IF NOT EXISTS shipments (
  id             TEXT PRIMARY KEY,
  pol            TEXT NOT NULL,
  pod            TEXT NOT NULL,
  carrier_code   TEXT NOT NULL,
  contract_type  TEXT NOT NULL,
  contract_notes TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'Active',
  created_at     TEXT NOT NULL,
  etd TEXT DEFAULT '', eta TEXT DEFAULT '', booking_ref TEXT DEFAULT '', bl_number TEXT DEFAULT '',
  vessel TEXT DEFAULT '', voyage TEXT DEFAULT '', incoterm TEXT DEFAULT '', vessel_imo TEXT DEFAULT '',
  contract_id TEXT DEFAULT '', commodity_code TEXT DEFAULT '',
  shipper_id TEXT DEFAULT '', shipper_name TEXT DEFAULT '',
  consignee_id TEXT DEFAULT '', consignee_name TEXT DEFAULT '',
  principal_id TEXT DEFAULT '', principal_name TEXT DEFAULT '',
  contract_ref TEXT DEFAULT '',
  allocation_id TEXT DEFAULT '', space_skip_reason TEXT DEFAULT '', space_overage_reason TEXT DEFAULT '', space_badge TEXT DEFAULT '',
  freight_terms TEXT DEFAULT 'Prepaid', movement_type TEXT DEFAULT 'FCL', service_type TEXT DEFAULT 'Port-to-Port',
  place_of_receipt TEXT DEFAULT '', place_of_delivery TEXT DEFAULT '', cargo_ready_date TEXT DEFAULT NULL,
  notify_id TEXT DEFAULT '', notify_name TEXT DEFAULT '',
  declared_value REAL DEFAULT NULL, declared_value_currency TEXT DEFAULT 'USD',
  routing_term TEXT DEFAULT NULL,
  emo_office_id TEXT DEFAULT NULL, imo_office_id TEXT DEFAULT NULL, controlling_office_id TEXT DEFAULT NULL,
  contract_valid_from TEXT DEFAULT NULL, contract_valid_to TEXT DEFAULT NULL,
  atd TEXT DEFAULT '', ata TEXT DEFAULT '',
  contract_routing_id TEXT DEFAULT '',
  bl_release_type TEXT DEFAULT '', master_bl_number TEXT DEFAULT '', master_bl_release_type TEXT DEFAULT '',
  coload_tariff_reference TEXT DEFAULT ''
)`);

await query(`CREATE TABLE IF NOT EXISTS containers (
  id                TEXT PRIMARY KEY,
  shipment_id       TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  container_number  TEXT NOT NULL,
  size              TEXT NOT NULL CHECK(size IN ('20','40')),
  type              TEXT NOT NULL,
  hs_code           TEXT DEFAULT '',
  gross_weight_kg   REAL DEFAULT NULL,
  volume_cbm        REAL DEFAULT NULL,
  is_dg             BOOLEAN NOT NULL DEFAULT FALSE,
  dg_class          TEXT DEFAULT '',
  seal_number       TEXT DEFAULT '',
  commodity         TEXT DEFAULT '',
  cargo_description TEXT DEFAULT '',
  vgm_weight_kg     REAL DEFAULT NULL,
  vgm_status        TEXT DEFAULT 'Pending',
  vgm_cutoff        TEXT DEFAULT NULL,
  cy_cutoff         TEXT DEFAULT NULL,
  origin_free_time_days INTEGER DEFAULT NULL,
  dest_free_time_days   INTEGER DEFAULT NULL,
  marks_and_numbers TEXT DEFAULT '',
  origin_detention_free_days INTEGER DEFAULT NULL,
  dest_detention_free_days   INTEGER DEFAULT NULL,
  set_temperature_c REAL DEFAULT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_containers_shipment ON containers(shipment_id)`);

await query(`CREATE TABLE IF NOT EXISTS container_events (
  id               TEXT PRIMARY KEY,
  container_id     TEXT NOT NULL,
  shipment_id      TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  location         TEXT DEFAULT '',
  occurred_at      TEXT NOT NULL,
  recorded_by      TEXT DEFAULT '',
  notes            TEXT DEFAULT '',
  created_at       TEXT NOT NULL,
  condition_notes  TEXT DEFAULT '',
  damage_flag      BOOLEAN NOT NULL DEFAULT FALSE,
  chassis_provider TEXT DEFAULT ''
)`);

await query(`CREATE TABLE IF NOT EXISTS container_packages (
  id             TEXT PRIMARY KEY,
  container_id   TEXT NOT NULL,
  parent_id      TEXT DEFAULT NULL,
  description    TEXT NOT NULL,
  quantity       INTEGER NOT NULL DEFAULT 1,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  pack_type_id   TEXT DEFAULT NULL,
  is_dg          BOOLEAN NOT NULL DEFAULT FALSE,
  dg_class       TEXT DEFAULT '',
  unit_value     REAL DEFAULT NULL,
  currency       TEXT DEFAULT '',
  hs_code        TEXT DEFAULT '',
  unit_value_usd REAL DEFAULT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS container_type_definitions (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  size        TEXT NOT NULL,
  type        TEXT NOT NULL,
  teu         INTEGER NOT NULL DEFAULT 1,
  label       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS pack_type_definitions (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT '📦',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS contracts (
  id                TEXT PRIMARY KEY,
  contract_number   TEXT DEFAULT '',
  carrier_code      TEXT DEFAULT '',
  named_account_id  TEXT DEFAULT '',
  named_account     TEXT DEFAULT '',
  movement_type     TEXT DEFAULT 'FCL',
  container_types   TEXT DEFAULT '[]',
  dg_allowed        BOOLEAN NOT NULL DEFAULT FALSE,
  imdg_classes      TEXT DEFAULT '[]',
  valid_from        TEXT DEFAULT '',
  valid_to          TEXT DEFAULT '',
  currency          TEXT DEFAULT 'USD',
  status            TEXT DEFAULT 'Active',
  notes             TEXT DEFAULT '',
  created_at        TEXT NOT NULL,
  contract_ref      TEXT DEFAULT '',
  commodity_types   TEXT DEFAULT ''
)`);

await query(`CREATE TABLE IF NOT EXISTS contract_legs (
  id             TEXT PRIMARY KEY,
  contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  leg_order      INTEGER DEFAULT 0,
  pol            TEXT DEFAULT '',
  pol_name       TEXT DEFAULT '',
  pod            TEXT DEFAULT '',
  pod_name       TEXT DEFAULT '',
  transit_days   INTEGER DEFAULT 0,
  vessel_service TEXT DEFAULT '',
  pol_linked_allowed    BOOLEAN NOT NULL DEFAULT FALSE,
  pod_linked_allowed    BOOLEAN NOT NULL DEFAULT FALSE,
  pol_carrier_haulage   BOOLEAN NOT NULL DEFAULT FALSE,
  pod_carrier_haulage   BOOLEAN NOT NULL DEFAULT FALSE,
  pol_haulage_locations TEXT DEFAULT '',
  pod_haulage_locations TEXT DEFAULT '',
  pol_loc_type          TEXT DEFAULT 'Terminal',
  pod_loc_type          TEXT DEFAULT 'Terminal',
  routing_id            TEXT DEFAULT ''
)`);

await query(`CREATE TABLE IF NOT EXISTS contract_rates (
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
  notes          TEXT DEFAULT '',
  valid_from     TEXT DEFAULT '',
  valid_to       TEXT DEFAULT '',
  routing_id     TEXT DEFAULT ''
)`);

await query(`CREATE TABLE IF NOT EXISTS contract_routings (
  id           TEXT PRIMARY KEY,
  contract_id  TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  name         TEXT DEFAULT '',
  sort_order   INTEGER DEFAULT 0,
  transit_days INTEGER DEFAULT 0,
  notes        TEXT DEFAULT '',
  created_at   TEXT NOT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_contract_routings_contract ON contract_routings(contract_id)`);

await query(`CREATE TABLE IF NOT EXISTS contract_container_types (
  id             TEXT PRIMARY KEY,
  contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  container_type TEXT NOT NULL
)`);
await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_container_types_uniq ON contract_container_types(contract_id, container_type)`);

await query(`CREATE TABLE IF NOT EXISTS contract_imdg_classes (
  id          TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  imdg_class  TEXT NOT NULL
)`);
await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_imdg_classes_uniq ON contract_imdg_classes(contract_id, imdg_class)`);

await query(`CREATE TABLE IF NOT EXISTS trade_lanes (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT DEFAULT '',
  transit_days INTEGER DEFAULT 0
)`);

await query(`CREATE TABLE IF NOT EXISTS country_trade_lanes (
  iso2      TEXT NOT NULL REFERENCES countries(iso2) ON DELETE CASCADE,
  lane_code TEXT NOT NULL REFERENCES trade_lanes(code) ON DELETE CASCADE,
  PRIMARY KEY (iso2, lane_code)
)`);

await query(`CREATE TABLE IF NOT EXISTS regions (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT ''
)`);

await query(`CREATE TABLE IF NOT EXISTS linked_ports (
  id               TEXT PRIMARY KEY,
  primary_unlocode TEXT NOT NULL REFERENCES port_locations(unlocode) ON DELETE CASCADE,
  linked_unlocode  TEXT NOT NULL REFERENCES port_locations(unlocode) ON DELETE CASCADE,
  note             TEXT DEFAULT '',
  UNIQUE(primary_unlocode, linked_unlocode),
  CHECK(primary_unlocode != linked_unlocode)
)`);

await query(`CREATE TABLE IF NOT EXISTS commodities (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  grade_code  TEXT NOT NULL DEFAULT 'E',
  grade_name  TEXT NOT NULL DEFAULT 'General Cargo'
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_commodities_desc ON commodities(description)`);

await query(`CREATE TABLE IF NOT EXISTS carriers (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  short_name TEXT
)`);

await query(`CREATE TABLE IF NOT EXISTS vessels (
  imo             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  asset_type      TEXT,
  flag_iso2       TEXT,
  flag_name       TEXT,
  build_year      INTEGER,
  gross_tonnage   INTEGER,
  mmsi            TEXT DEFAULT '',
  ais_verified_at TEXT DEFAULT ''
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_vessels_name ON vessels(name)`);

await query(`CREATE TABLE IF NOT EXISTS tickets (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  section     TEXT DEFAULT '',
  description TEXT DEFAULT '',
  priority    TEXT DEFAULT 'Medium',
  status      TEXT DEFAULT 'Ready',
  position    INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL,
  shipment_id TEXT DEFAULT NULL,
  type        TEXT DEFAULT 'Task',
  version     TEXT DEFAULT '',
  parent_id   TEXT DEFAULT NULL,
  assignee_id TEXT DEFAULT NULL,
  due_date    TEXT DEFAULT NULL,
  test_notes  TEXT DEFAULT NULL,
  project_id  TEXT DEFAULT NULL,
  version_id  TEXT DEFAULT NULL,
  source_type TEXT DEFAULT NULL,
  source_id   TEXT DEFAULT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_tickets_source ON tickets(source_type, source_id)`);

await query(`CREATE TABLE IF NOT EXISTS ticket_links (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  link_type  TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS test_items (
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
)`);

await query(`CREATE TABLE IF NOT EXISTS test_case_links (
  id         TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL,
  ticket_id  TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS kb_projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  key         TEXT NOT NULL,
  color       TEXT DEFAULT '#6366f1',
  description TEXT DEFAULT '',
  created_at  TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS kb_versions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES kb_projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT DEFAULT '',
  status       TEXT DEFAULT 'Planning',
  release_date TEXT DEFAULT NULL,
  created_at   TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS kb_columns (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES kb_projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  color      TEXT DEFAULT '#6366f1',
  wip_limit  INTEGER DEFAULT NULL,
  created_at TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_events (
  id          TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  field       TEXT DEFAULT NULL,
  old_value   TEXT DEFAULT NULL,
  new_value   TEXT DEFAULT NULL,
  actor       TEXT NOT NULL DEFAULT 'user',
  occurred_at TEXT NOT NULL,
  meta        TEXT DEFAULT ''
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_shp_events ON shipment_events(shipment_id, occurred_at)`);

await query(`CREATE TABLE IF NOT EXISTS status_log (
  id          TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  changed_at  TEXT NOT NULL,
  changed_by  TEXT NOT NULL DEFAULT 'system'
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_status_log_shipment ON status_log(shipment_id, changed_at)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_messages (
  id          TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL,
  body        TEXT NOT NULL,
  author      TEXT NOT NULL,
  role        TEXT DEFAULT '',
  created_at  TEXT NOT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_shp_msgs ON shipment_messages(shipment_id, created_at)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_legs (
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
  created_at    TEXT NOT NULL,
  leg_type      TEXT DEFAULT 'SEA',
  movement_type TEXT DEFAULT 'SEA',
  pol_loc_type  TEXT DEFAULT 'Terminal',
  pod_loc_type  TEXT DEFAULT 'Terminal',
  movement_by   TEXT DEFAULT '',
  atd TEXT DEFAULT '', ata TEXT DEFAULT '',
  atd_source TEXT DEFAULT '', ata_source TEXT DEFAULT '',
  etd_source TEXT DEFAULT '', eta_source TEXT DEFAULT '',
  pol_latitude REAL DEFAULT NULL, pol_longitude REAL DEFAULT NULL,
  pod_latitude REAL DEFAULT NULL, pod_longitude REAL DEFAULT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_shp_legs ON shipment_legs(shipment_id, leg_order)`);

await query(`CREATE TABLE IF NOT EXISTS system_messages (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT DEFAULT '',
  severity    TEXT DEFAULT 'info',
  active_from TEXT DEFAULT '',
  active_to   TEXT DEFAULT '',
  created_at  TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS entity_events (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  field       TEXT,
  old_value   TEXT,
  new_value   TEXT,
  meta        TEXT,
  created_at  TEXT NOT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_entity_events_lookup ON entity_events(entity_type, entity_id)`);

await query(`CREATE TABLE IF NOT EXISTS sanctions_entries (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL,
  ref_id           TEXT DEFAULT '',
  entity_name      TEXT NOT NULL,
  entity_name_norm TEXT NOT NULL,
  entity_type      TEXT DEFAULT '',
  program          TEXT DEFAULT '',
  aliases_norm     TEXT DEFAULT '[]'
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_sanctions_norm ON sanctions_entries(entity_name_norm)`);

await query(`CREATE TABLE IF NOT EXISTS sanctions_syncs (
  source      TEXT PRIMARY KEY,
  synced_at   TEXT NOT NULL,
  entry_count INTEGER DEFAULT 0
)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_screenings (
  id              TEXT PRIMARY KEY,
  shipment_id     TEXT NOT NULL,
  screened_at     TEXT NOT NULL,
  result          TEXT NOT NULL,
  hits            TEXT DEFAULT '[]',
  overridden_at   TEXT,
  override_reason TEXT,
  UNIQUE(shipment_id)
)`);

await query(`CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL DEFAULT '',
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'viewer',
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TEXT NOT NULL DEFAULT (now()::text),
  last_login          TEXT,
  roles               TEXT DEFAULT NULL,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT NOT NULL DEFAULT '',
  token_version       INTEGER NOT NULL DEFAULT 0,
  can_view_finance    BOOLEAN NOT NULL DEFAULT FALSE,
  all_offices         BOOLEAN NOT NULL DEFAULT TRUE,
  password_changed_at TEXT NOT NULL DEFAULT '',
  reset_token_hash    TEXT NOT NULL DEFAULT '',
  reset_token_expires TEXT NOT NULL DEFAULT ''
)`);

// offices must exist before user_offices below (FK) — created here, right after users, rather
// than in its original reading-order position further down (moved during the Postgres migration
// to fix a real create-order bug: Postgres enforces FK target existence at CREATE TABLE time,
// unlike SQLite's original migrations array, which never hit this ordering issue since ADD
// COLUMN/CREATE TABLE statements there never declared real FK constraints this strictly).
await query(`CREATE TABLE IF NOT EXISTS offices (
  id           TEXT PRIMARY KEY,
  code         TEXT UNIQUE NOT NULL,
  country_code TEXT NOT NULL DEFAULT '',
  unlocode     TEXT NOT NULL DEFAULT '',
  department   TEXT NOT NULL DEFAULT 'SE',
  name         TEXT NOT NULL DEFAULT '',
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TEXT NOT NULL DEFAULT (now()::text),
  branch_id    TEXT REFERENCES branches(id),
  manager_user_id TEXT DEFAULT '',
  invoice_alert_business_days      INTEGER DEFAULT NULL,
  invoice_escalation_business_days INTEGER DEFAULT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS user_offices (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  office_id  TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  UNIQUE(user_id, office_id)
)`);

await query(`CREATE TABLE IF NOT EXISTS user_scope_items (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT '',
  item_type  TEXT NOT NULL,
  value      TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (now()::text)
)`);

await query(`CREATE TABLE IF NOT EXISTS user_access_configs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  origin_lane   TEXT,
  dest_lane     TEXT,
  pol_codes     TEXT,
  pod_codes     TEXT,
  carrier_codes TEXT,
  created_at    TEXT NOT NULL DEFAULT (now()::text)
)`);

await query(`CREATE TABLE IF NOT EXISTS org_countries (
  country_code     TEXT PRIMARY KEY,
  default_currency TEXT,
  timezone         TEXT,
  branch_id        TEXT REFERENCES branches(id),
  compliance_notes TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  added_at         TEXT NOT NULL DEFAULT (now()::text)
)`);

await query(`CREATE TABLE IF NOT EXISTS office_mail_settings (
  id            TEXT PRIMARY KEY,
  office_id     TEXT NOT NULL UNIQUE REFERENCES offices(id) ON DELETE CASCADE,
  smtp_host     TEXT NOT NULL DEFAULT '',
  smtp_port     INTEGER NOT NULL DEFAULT 587,
  secure_mode   TEXT NOT NULL DEFAULT 'starttls',
  smtp_username TEXT NOT NULL DEFAULT '',
  smtp_password TEXT NOT NULL DEFAULT '',
  from_address  TEXT NOT NULL DEFAULT '',
  from_name     TEXT NOT NULL DEFAULT '',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS system_email_settings (
  id            TEXT PRIMARY KEY,
  smtp_host     TEXT NOT NULL DEFAULT '',
  smtp_port     INTEGER NOT NULL DEFAULT 587,
  secure_mode   TEXT NOT NULL DEFAULT 'starttls',
  smtp_username TEXT NOT NULL DEFAULT '',
  smtp_password TEXT NOT NULL DEFAULT '',
  from_address  TEXT NOT NULL DEFAULT '',
  from_name     TEXT NOT NULL DEFAULT '',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS org_signing_certs (
  id                 TEXT PRIMARY KEY,
  cert_pem           TEXT NOT NULL,
  private_key_pem    TEXT NOT NULL,
  p12_base64         TEXT NOT NULL,
  p12_passphrase     TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  subject            TEXT NOT NULL,
  not_before         TEXT NOT NULL,
  not_after          TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  created_at         TEXT NOT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_org_signing_certs_status ON org_signing_certs(status)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_side_offices (
  id          TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  side        TEXT NOT NULL,
  office_id   TEXT NOT NULL REFERENCES offices(id),
  added_at    TEXT NOT NULL,
  added_by    TEXT NOT NULL DEFAULT '',
  UNIQUE(shipment_id, side, office_id)
)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_edit_locks (
  shipment_id       TEXT PRIMARY KEY REFERENCES shipments(id) ON DELETE CASCADE,
  locked_by_id      TEXT NOT NULL,
  locked_by_name    TEXT NOT NULL,
  locked_at         TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  expires_at        TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_parties (
  id            TEXT PRIMARY KEY,
  shipment_id   TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  customer_id   TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE(shipment_id, role)
)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_cost_lines (
  id            TEXT PRIMARY KEY,
  shipment_id   TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  charge_code   TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  amount        REAL NOT NULL DEFAULT 0,
  exchange_rate REAL NOT NULL DEFAULT 1,
  notes         TEXT DEFAULT '',
  created_at    TEXT NOT NULL,
  container_id  TEXT DEFAULT '',
  source        TEXT DEFAULT 'manual',
  modified_at   TEXT,
  vat_rate      REAL NOT NULL DEFAULT 0,
  rate_snapshot_id TEXT DEFAULT '',
  status        TEXT DEFAULT 'accrued',
  actual_amount REAL DEFAULT NULL,
  actual_exchange_rate REAL DEFAULT NULL,
  actualized_at TEXT DEFAULT NULL,
  actualized_by TEXT DEFAULT '',
  posted_at     TEXT DEFAULT NULL,
  posted_by     TEXT DEFAULT '',
  payment_indicator TEXT DEFAULT 'Prepaid',
  adjusts_cost_line_id TEXT DEFAULT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_cost_lines_shipment ON shipment_cost_lines(shipment_id)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_documents (
  id           TEXT PRIMARY KEY,
  shipment_id  TEXT NOT NULL,
  filename     TEXT NOT NULL,
  stored_name  TEXT NOT NULL,
  mime_type    TEXT NOT NULL DEFAULT '',
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  doc_type     TEXT NOT NULL DEFAULT 'Other',
  uploaded_by  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  status        TEXT DEFAULT 'draft',
  confirmed_at  TEXT DEFAULT NULL,
  confirmed_by  TEXT DEFAULT '',
  container_id  TEXT DEFAULT '',
  responsible_party TEXT DEFAULT '',
  related_doc_id TEXT DEFAULT NULL,
  source_cost_line_ids TEXT DEFAULT NULL,
  paid_at TEXT DEFAULT NULL,
  paid_amount REAL DEFAULT NULL,
  transaction_id TEXT DEFAULT '',
  first_sent_at TEXT DEFAULT NULL,
  last_reminder_sent_at TEXT DEFAULT NULL,
  container_event_id TEXT DEFAULT '',
  invoice_owner_id TEXT DEFAULT '',
  collections_alerted_at TEXT DEFAULT NULL,
  collections_escalated_at TEXT DEFAULT NULL,
  bl_surrendered_at TEXT DEFAULT NULL,
  bl_surrendered_by TEXT DEFAULT '',
  bl_released_at TEXT DEFAULT NULL,
  bl_released_by TEXT DEFAULT ''
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_shipment_documents_shipment ON shipment_documents(shipment_id)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_haulage_records (
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
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_haulage_records_service ON shipment_haulage_records(service_id)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_haulage_waypoints (
  id                TEXT PRIMARY KEY,
  haulage_record_id TEXT NOT NULL REFERENCES shipment_haulage_records(id) ON DELETE CASCADE,
  sequence_order    INTEGER NOT NULL DEFAULT 1,
  loc_type          TEXT NOT NULL DEFAULT 'Door',
  location          TEXT DEFAULT '',
  latitude          REAL DEFAULT NULL,
  longitude         REAL DEFAULT NULL,
  notes             TEXT DEFAULT '',
  created_at        TEXT NOT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_haulage_waypoints_record ON shipment_haulage_waypoints(haulage_record_id)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_loading_plan_lines (
  service_id     TEXT NOT NULL,
  container_id   TEXT NOT NULL,
  planned_date   TEXT DEFAULT '',
  sequence_order INTEGER DEFAULT 0,
  notes          TEXT DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT,
  PRIMARY KEY (service_id, container_id)
)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_milestones (
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
)`);

await query(`CREATE TABLE IF NOT EXISTS milestone_templates (
  id             TEXT PRIMARY KEY,
  template_key   TEXT NOT NULL DEFAULT 'FCL',
  carrier_code   TEXT NOT NULL DEFAULT '',
  trade_lane     TEXT NOT NULL DEFAULT '',
  milestone_key  TEXT NOT NULL,
  label          TEXT NOT NULL,
  sequence_order INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
)`);

// Document Template Editor — free-form canvas layout per (doc type, office?, carrier?), BL01
// pilot only. No DB-level UNIQUE on the scope triple: Postgres treats NULL <> NULL, so two
// generic (office/carrier both NULL) rows for the same doc_type wouldn't collide at the
// constraint level anyway — the create route enforces uniqueness itself via an
// IS NOT DISTINCT FROM check instead.
await query(`CREATE TABLE IF NOT EXISTS document_templates (
  id           TEXT PRIMARY KEY,
  doc_type     TEXT NOT NULL,
  office_id    TEXT DEFAULT NULL REFERENCES offices(id),
  carrier_code TEXT DEFAULT NULL,
  name         TEXT NOT NULL DEFAULT '',
  page_size    TEXT NOT NULL DEFAULT 'A4',
  fields       TEXT NOT NULL DEFAULT '[]',
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  created_by   TEXT DEFAULT ''
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_document_templates_lookup ON document_templates(doc_type, office_id, carrier_code)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_rate_snapshots (
  id           TEXT PRIMARY KEY,
  shipment_id  TEXT NOT NULL,
  contract_id  TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  generated_by TEXT DEFAULT '',
  reason       TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_rate_snapshot_lines (
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
)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_services (
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
)`);

await query(`CREATE TABLE IF NOT EXISTS sailing_legs (
  leg_key       TEXT PRIMARY KEY,
  carrier       TEXT DEFAULT '',
  pol           TEXT DEFAULT '',
  pod           TEXT DEFAULT '',
  etd           TEXT DEFAULT '',
  eta           TEXT DEFAULT '',
  vessel_name   TEXT DEFAULT '',
  vessel_imo    TEXT DEFAULT '',
  voyage_number TEXT DEFAULT '',
  service       TEXT DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS shipment_schedules (
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
  is_mock       BOOLEAN DEFAULT FALSE,
  saved_at      TEXT NOT NULL,
  saved_by      TEXT NOT NULL DEFAULT '',
  vessel_imo    TEXT DEFAULT '',
  atd           TEXT DEFAULT '',
  ata           TEXT DEFAULT '',
  source        TEXT DEFAULT 'search',
  template_id   TEXT REFERENCES shipment_schedules(id) ON DELETE SET NULL,
  schedule_key  TEXT DEFAULT ''
)`);

await query(`CREATE TABLE IF NOT EXISTS schedule_legs (
  id            TEXT PRIMARY KEY,
  schedule_id   TEXT NOT NULL REFERENCES shipment_schedules(id) ON DELETE CASCADE,
  leg_order     INTEGER NOT NULL DEFAULT 0,
  pol           TEXT DEFAULT '',
  pod           TEXT DEFAULT '',
  etd           TEXT DEFAULT '',
  eta           TEXT DEFAULT '',
  vessel_name   TEXT DEFAULT '',
  vessel_imo    TEXT DEFAULT '',
  voyage_number TEXT DEFAULT '',
  service       TEXT DEFAULT '',
  carrier       TEXT DEFAULT ''
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_schedule_legs_schedule ON schedule_legs(schedule_id)`);

await query(`CREATE TABLE IF NOT EXISTS schedule_leg_refs (
  schedule_id TEXT NOT NULL REFERENCES shipment_schedules(id) ON DELETE CASCADE,
  leg_key     TEXT NOT NULL REFERENCES sailing_legs(leg_key),
  leg_order   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (schedule_id, leg_order)
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_schedule_leg_refs_leg ON schedule_leg_refs(leg_key)`);

await query(`CREATE TABLE IF NOT EXISTS schedule_shipment_links (
  schedule_id TEXT NOT NULL REFERENCES shipment_schedules(id) ON DELETE CASCADE,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  linked_at   TEXT NOT NULL,
  linked_by   TEXT DEFAULT '',
  PRIMARY KEY (schedule_id, shipment_id)
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_schedule_links_shipment ON schedule_shipment_links(shipment_id)`);

await query(`CREATE TABLE IF NOT EXISTS scheduled_reports (
  id          TEXT PRIMARY KEY,
  report_type TEXT NOT NULL DEFAULT 'shipments-csv',
  frequency   TEXT NOT NULL DEFAULT 'weekly',
  recipients  TEXT NOT NULL DEFAULT '',
  office_id   TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TEXT DEFAULT NULL,
  created_by  TEXT DEFAULT '',
  created_at  TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS edi_messages (
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
  is_mock        BOOLEAN DEFAULT FALSE,
  created_at     TEXT NOT NULL,
  processed_at   TEXT DEFAULT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS carrier_bookings (
  id                   TEXT PRIMARY KEY,
  shipment_id          TEXT NOT NULL UNIQUE REFERENCES shipments(id) ON DELETE CASCADE,
  carrier_code         TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'Pending',
  last_response_status TEXT NOT NULL DEFAULT '',
  booking_ref          TEXT DEFAULT '',
  correlation_id       TEXT DEFAULT '',
  is_mock              BOOLEAN DEFAULT FALSE,
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
  bl_document_id       TEXT DEFAULT NULL REFERENCES shipment_documents(id)
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_carrier_bookings_status ON carrier_bookings(status)`);

await query(`CREATE TABLE IF NOT EXISTS carrier_booking_archive (
  id                   TEXT PRIMARY KEY,
  shipment_id          TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  carrier_code         TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'Pending',
  last_response_status TEXT NOT NULL DEFAULT '',
  booking_ref          TEXT DEFAULT '',
  correlation_id       TEXT DEFAULT '',
  is_mock              BOOLEAN DEFAULT FALSE,
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
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_carrier_booking_archive_shipment ON carrier_booking_archive(shipment_id)`);

await query(`CREATE TABLE IF NOT EXISTS carrier_eadapter_configs (
  id               TEXT PRIMARY KEY,
  carrier_code     TEXT NOT NULL,
  country_iso2     TEXT NOT NULL DEFAULT '',
  office_id        TEXT NOT NULL DEFAULT '',
  transport_type   TEXT NOT NULL DEFAULT 'rest_api',
  endpoint_url     TEXT NOT NULL DEFAULT '',
  auth_header_name TEXT NOT NULL DEFAULT '',
  credential       TEXT NOT NULL DEFAULT '',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  notes            TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE(carrier_code, office_id)
)`);

await query(`CREATE TABLE IF NOT EXISTS carrier_invoices (
  id             TEXT PRIMARY KEY,
  shipment_id    TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  carrier_code   TEXT DEFAULT '',
  invoice_number TEXT DEFAULT '',
  invoice_date   TEXT DEFAULT '',
  currency       TEXT DEFAULT 'USD',
  status         TEXT NOT NULL DEFAULT 'Pending',
  notes          TEXT DEFAULT '',
  created_at     TEXT NOT NULL,
  created_by     TEXT DEFAULT ''
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_carrier_invoices_shipment ON carrier_invoices(shipment_id)`);

await query(`CREATE TABLE IF NOT EXISTS carrier_invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES carrier_invoices(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
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
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_carrier_invoice_lines_invoice ON carrier_invoice_lines(invoice_id)`);

await query(`CREATE TABLE IF NOT EXISTS charge_code_definitions (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  trigger    TEXT NOT NULL DEFAULT 'per_container_split',
  amount     REAL NOT NULL DEFAULT 0,
  currency   TEXT NOT NULL DEFAULT 'USD',
  unit       TEXT NOT NULL DEFAULT 'per_container',
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS duty_rate_chapters (
  hs_chapter TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  rate_pct   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS invoice_status_reason_codes (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS invoice_status_overrides (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL,
  reason_code       TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  overridden_status TEXT NOT NULL,
  overridden_by     TEXT NOT NULL DEFAULT '',
  overridden_at     TEXT NOT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_invoice_status_overrides_doc ON invoice_status_overrides(document_id)`);

await query(`CREATE TABLE IF NOT EXISTS credit_overrides (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  shipment_id      TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  override_type    TEXT NOT NULL,
  reason           TEXT NOT NULL,
  approved_by      TEXT NOT NULL,
  approved_by_name TEXT DEFAULT '',
  created_at       TEXT NOT NULL,
  consumed_at      TEXT DEFAULT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_credit_overrides_shipment ON credit_overrides(shipment_id, override_type, consumed_at)`);

await query(`CREATE TABLE IF NOT EXISTS customer_contacts (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  department  TEXT NOT NULL DEFAULT 'Other',
  is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS customer_documents (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  filename    TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type   TEXT NOT NULL DEFAULT '',
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  doc_type    TEXT NOT NULL DEFAULT 'Other',
  uploaded_by TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS customer_identifiers (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  id_type      TEXT NOT NULL DEFAULT 'VAT',
  id_code      TEXT NOT NULL DEFAULT '',
  country_iso2 TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL DEFAULT '',
  is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TEXT NOT NULL
)`);

await query(`CREATE TABLE IF NOT EXISTS customer_roles (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  role        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(customer_id, role)
)`);

await query(`CREATE TABLE IF NOT EXISTS customer_screenings (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL,
  screened_at     TEXT NOT NULL,
  result          TEXT NOT NULL,
  hits            TEXT DEFAULT '[]',
  overridden_at   TEXT,
  override_reason TEXT,
  UNIQUE(customer_id)
)`);

await query(`CREATE TABLE IF NOT EXISTS customs_filings (
  id                  TEXT PRIMARY KEY,
  shipment_id         TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  filing_type         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'Draft',
  filing_reference    TEXT DEFAULT '',
  confirmation_number TEXT DEFAULT '',
  rejection_reason    TEXT DEFAULT '',
  filed_at            TEXT DEFAULT NULL,
  filed_by            TEXT DEFAULT '',
  responded_at        TEXT DEFAULT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  carrier_code        TEXT DEFAULT '',
  vessel_name         TEXT DEFAULT '',
  voyage_number       TEXT DEFAULT '',
  export_date         TEXT DEFAULT '',
  cargo_snapshot      TEXT DEFAULT '[]',
  UNIQUE(shipment_id, filing_type)
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_customs_filings_status ON customs_filings(status)`);

await query(`CREATE TABLE IF NOT EXISTS opportunities (
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
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_opportunities_assignee ON opportunities(assignee_id)`);
await query(`CREATE INDEX IF NOT EXISTS idx_opportunities_customer ON opportunities(customer_id)`);
await query(`CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status)`);

await query(`CREATE TABLE IF NOT EXISTS quotes (
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
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes(customer_id)`);
await query(`CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status)`);

await query(`CREATE TABLE IF NOT EXISTS quote_lines (
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
  sort_order INTEGER DEFAULT 0,
  set_temperature_c REAL DEFAULT NULL
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_quote_lines_quote ON quote_lines(quote_id)`);

// ─── Incremental schema changes (post-migration) ───────────────────────────
// Every CREATE TABLE above already reflects the final shape a fresh install gets — but an
// already-initialized live database's tables were created before this point and CREATE TABLE
// IF NOT EXISTS is a no-op against them. Unlike SQLite (no ADD COLUMN IF NOT EXISTS at all, so
// the old migrations array had to swallow "duplicate column" errors one statement at a time),
// Postgres supports IF NOT EXISTS natively here too — each statement below is safe to run on
// every boot. First entry since the Postgres migration; add future column additions the same way.
await query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS commodity_types TEXT DEFAULT ''`);

// House B/L lifecycle status (Surrendered/Released) — meaningful only for BL01 rows, same sparse
// per-doc-type idiom as paid_at/paid_amount/transaction_id (FR01/FR02-only) above.
await query(`ALTER TABLE shipment_documents ADD COLUMN IF NOT EXISTS bl_surrendered_at TEXT DEFAULT NULL`);
await query(`ALTER TABLE shipment_documents ADD COLUMN IF NOT EXISTS bl_surrendered_by TEXT DEFAULT ''`);
await query(`ALTER TABLE shipment_documents ADD COLUMN IF NOT EXISTS bl_released_at TEXT DEFAULT NULL`);
await query(`ALTER TABLE shipment_documents ADD COLUMN IF NOT EXISTS bl_released_by TEXT DEFAULT ''`);

// shipment_cost_lines.shipment_id was the one child table (of 13+) with no
// REFERENCES shipments(id) ON DELETE CASCADE — deleting a shipment left its cost lines
// permanently orphaned instead of cascading (2026-09-02 shipment-domain audit,
// ARCHITECTURE.md §11). Postgres validates existing rows against a new FK constraint, so the
// already-orphaned rows (accumulated from real shipment deletions over this project's history,
// overwhelmingly test-fixture churn — 5,435 found in this dev DB, some already 'posted') are
// deleted first; ADD CONSTRAINT has no native IF NOT EXISTS, so the existence check below
// makes this safe to run on every boot rather than only once.
const [orphaned] = await query(`
  WITH deleted AS (
    DELETE FROM shipment_cost_lines cl
    WHERE NOT EXISTS (SELECT 1 FROM shipments s WHERE s.id = cl.shipment_id)
    RETURNING id
  )
  SELECT COUNT(*)::int AS n FROM deleted
`);
if (orphaned.n > 0) console.log(`  ✔ Removed ${orphaned.n} orphaned shipment_cost_lines rows (shipment already deleted, pre-dating the FK fix below)`);
const [{ exists: costLineFkExists }] = await query(`
  SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipment_cost_lines_shipment_id_fkey') AS exists
`);
if (!costLineFkExists) {
  await query(`ALTER TABLE shipment_cost_lines ADD CONSTRAINT shipment_cost_lines_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE`);
  console.log(`  ✔ shipment_cost_lines.shipment_id now cascades on shipment delete`);
}

// BUY-side cost-line Adjust action (2026-09-03 shipment-domain audit) — a posted line can
// never be edited or deleted (matches the SELL-side invariant), but until now the only way to
// correct one was manually inserting a new, completely unlinked cost line and trusting whoever
// did it to size it correctly. adjusts_cost_line_id records that link explicitly, the same
// plain-TEXT-no-FK idiom shipment_documents.related_doc_id already uses for the analogous
// SELL-side Credit/Debit Note link.
await query(`ALTER TABLE shipment_cost_lines ADD COLUMN IF NOT EXISTS adjusts_cost_line_id TEXT DEFAULT NULL`);

// shipment_side_offices.office_id had no FK at all (2026-09-03 shipment-domain audit) — unlike
// every other office_id column in the schema, which either cascades (user_offices,
// office_mail_settings) or at least blocks via a bare REFERENCES (document_templates). Verified
// live: deleting an office that was only ever added as a shipment's additional Export/Import
// office (not its primary EMO/IMO/Controlling column, which DELETE /api/offices/:id already
// guards against) succeeded silently, leaving a permanently orphaned row the feature's own GET
// route's INNER JOIN then hid from view — an operator would see a shorter office list with zero
// indication anything was wrong. Same orphan-then-add-constraint idiom as the shipment_cost_lines
// fix above. RESTRICT (the default, no ON DELETE clause), not CASCADE — mirrors this codebase's
// own "an office referenced by a shipment must be deactivated, never deleted" precedent already
// enforced for the primary EMO/IMO/Controlling columns, not silently dropping shipment history.
const [orphanedSideOffices] = await query(`
  WITH deleted AS (
    DELETE FROM shipment_side_offices so
    WHERE NOT EXISTS (SELECT 1 FROM offices o WHERE o.id = so.office_id)
    RETURNING id
  )
  SELECT COUNT(*)::int AS n FROM deleted
`);
if (orphanedSideOffices.n > 0) console.log(`  ✔ Removed ${orphanedSideOffices.n} orphaned shipment_side_offices rows (office already deleted, pre-dating the FK fix below)`);
const [{ exists: sideOfficeFkExists }] = await query(`
  SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipment_side_offices_office_id_fkey') AS exists
`);
if (!sideOfficeFkExists) {
  await query(`ALTER TABLE shipment_side_offices ADD CONSTRAINT shipment_side_offices_office_id_fkey FOREIGN KEY (office_id) REFERENCES offices(id)`);
  console.log(`  ✔ shipment_side_offices.office_id now protected against a dangling office reference`);
}

}

module.exports = { initSchema };
