"use strict";
const express    = require("express");
const http       = require("http");
const path       = require("path");
const { WebSocketServer } = require("ws");
const { DatabaseSync } = require("node:sqlite");

const app = express();
const db  = new DatabaseSync(path.join(__dirname, "cargodesk.db"));
app.use(express.json());

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
];

for (const sql of migrations) {
  try { db.exec(sql); } catch {}
}


// ─── FX Rate Cache (frankfurter.app, ECB rates, refreshed every 24 h) ─────────
let fxCache = { rates: {}, ts: 0 };
async function getFxRates() {
  if (Date.now() - fxCache.ts < 86400000 && Object.keys(fxCache.rates).length) return fxCache.rates;
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

// ─── Map functions ────────────────────────────────────────────────────────────

const mapShipment     = r => ({ id: r.id, pol: r.pol, polName: r.pol_name || '', pod: r.pod, podName: r.pod_name || '', carrierCode: r.carrier_code, contractType: r.contract_type, contractNotes: r.contract_notes || '', status: r.status, createdAt: r.created_at, etd: r.etd || '', eta: r.eta || '', bookingRef: r.booking_ref || '', blNumber: r.bl_number || '', vessel: r.vessel || '', voyage: r.voyage || '', incoterm: r.incoterm || '', vesselImo: r.vessel_imo || '', contractId: r.contract_id || '', contractRef: r.contract_ref || '', commodityCode: r.commodity_code || '', shipperId: r.shipper_id || '', shipperName: r.shipper_name || '', consigneeId: r.consignee_id || '', consigneeName: r.consignee_name || '', principalId: r.principal_id || '', principalName: r.principal_name || '' });
const mapContainer    = r => ({ id: r.id, shipmentId: r.shipment_id, containerNumber: r.container_number || '', sealNumber: r.seal_number || '', size: r.size, type: r.type, hsCode: r.hs_code || '', cargoDescription: r.cargo_description || '', grossWeightKg: r.gross_weight_kg ?? null, volumeCbm: r.volume_cbm ?? null, isDg: r.is_dg === 1, dgClass: r.dg_class || '' });
const mapAllocation   = r => ({ id: r.id, carrierCode: r.carrier_code, allocatedTEU: r.allocated_teu, effectiveDate: r.effective_date || '', endDate: r.end_date || '', tradeLane: r.trade_lane || '', notes: r.notes || '', alertThreshold: r.alert_threshold ?? 80, pol: r.pol || '', pod: r.pod || '', originLane: r.origin_lane || '', destLane: r.dest_lane || '', coverageScope: r.coverage_scope || 'STRICT', contractId: r.contract_id || '', contractNumber: r.contract_number || '' });
const mapCarrier      = r => ({ code: r.code, name: r.name, shortName: r.short_name || '' });
const mapVessel       = r => ({ imo: r.imo, name: r.name, assetType: r.asset_type || '', flagIso2: r.flag_iso2 || '', flagName: r.flag_name || '', buildYear: r.build_year, grossTonnage: r.gross_tonnage });
const mapPortLocation = r => ({ unlocode: r.unlocode, name: r.name, latitude: r.latitude, longitude: r.longitude, countryCode: r.country_code, zoneCode: r.zone_code, lastSyncedAt: r.last_synced_at || null });
const mapLinkedPort   = r => ({ id: r.id, primaryUnlocode: r.primary_unlocode, primaryName: r.primary_name || '', linkedUnlocode: r.linked_unlocode, linkedName: r.linked_name || '', note: r.note || '' });
const mapTradeLane    = r => ({ code: r.code, name: r.name, description: r.description || '', countryCount: r.country_count ?? 0 });
const mapRegion       = r => ({ code: r.code, name: r.name, description: r.description || '' });
const mapCountry      = r => ({ iso2: r.iso2, name: r.name, unMember: r.un_member === 1, regionCode: r.region_code || '', portCount: r.port_count ?? 0 });
const mapTicket       = r => ({ id: r.id, title: r.title, section: r.section || '', description: r.description || '', priority: r.priority, status: r.status, position: r.position, createdAt: r.created_at, shipmentId: r.shipment_id || null, type: r.type || 'Task', version: r.version || '' });
const mapCustomer     = r => ({ id: r.id, companyName: r.company_name, address1: r.address1 || '', address2: r.address2 || '', city: r.city || '', state: r.state || '', postalCode: r.postal_code || '', countryIso2: r.country_iso2 || '', phone: r.phone || '', fax: r.fax || '', email: r.email || '', website: r.website || '', notes: r.notes || '', createdAt: r.created_at });
const mapCommodity    = r => ({ code: r.code, description: r.description, gradeCode: r.grade_code, gradeName: r.grade_name });
const mapSystemMessage = r => ({
  id: r.id, title: r.title, body: r.body,
  severity: r.severity, activeFrom: r.active_from, activeTo: r.active_to, createdAt: r.created_at,
});

const mapContract = r => ({
  id:              r.id,
  contractNumber:  r.contract_number,
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


// ─── Shipments ────────────────────────────────────────────────────────────────

app.get("/api/shipments", (req, res) => {
  const rows = db.prepare(`
    SELECT s.*,
           p1.name AS pol_name,
           p2.name AS pod_name
    FROM shipments s
    LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
    LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
    ORDER BY s.created_at DESC
  `).all();
  ok(res, rows.map(mapShipment));
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
          principalId = "", principalName = "" } = req.body;
  if (!pol || !pod || !carrierCode || !contractType) return err(res, "pol, pod, carrierCode, contractType required");
  const id = `SHP-${uid()}`;
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO shipments (id,pol,pod,carrier_code,contract_type,contract_notes,status,created_at,etd,eta,booking_ref,bl_number,vessel,voyage,incoterm,vessel_imo,contract_id,contract_ref,commodity_code,shipper_id,shipper_name,consignee_id,consignee_name,principal_id,principal_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, polU, podU, carrierCode, contractType, contractNotes, status, createdAt, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, contractId, contractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName);
  logEvent(id, 'SHIPMENT_CREATED', null, null, null,
    JSON.stringify({ pol: polU, pod: podU, carrier: carrierCode, status, etd, contractType }));
  ok(res, mapShipment({ id, pol: polU, pod: podU, carrier_code: carrierCode, contract_type: contractType, contract_notes: contractNotes, status, created_at: createdAt, etd, eta, booking_ref: bookingRef, bl_number: blNumber, vessel, voyage, incoterm, vessel_imo: vesselImo, contract_id: contractId, contract_ref: contractRef, commodity_code: commodityCode, shipper_id: shipperId, shipper_name: shipperName, consignee_id: consigneeId, consignee_name: consigneeName, principal_id: principalId, principal_name: principalName }), 201);
});

app.put("/api/shipments/:id", (req, res) => {
  const { pol, pod, carrierCode, contractType, contractNotes = "", status,
          etd = "", eta = "", bookingRef = "", blNumber = "", vessel = "", voyage = "",
          incoterm = "", vesselImo = "", contractId = "", contractRef = "", commodityCode = "",
          shipperId = "", shipperName = "", consigneeId = "", consigneeName = "",
          principalId = "", principalName = "" } = req.body;
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const existing = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const info = db.prepare(`
    UPDATE shipments SET pol=?, pod=?, carrier_code=?, contract_type=?, contract_notes=?, status=?,
    etd=?, eta=?, booking_ref=?, bl_number=?, vessel=?, voyage=?, incoterm=?, vessel_imo=?, contract_id=?, contract_ref=?, commodity_code=?,
    shipper_id=?, shipper_name=?, consignee_id=?, consignee_name=?, principal_id=?, principal_name=? WHERE id=?
  `).run(polU, podU, carrierCode, contractType, contractNotes, status, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, contractId, contractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  // Log all changed fields
  const newVals = { pol: polU, pod: podU, status, etd, eta, carrier_code: carrierCode,
    vessel, vessel_imo: vesselImo, voyage, incoterm, commodity_code: commodityCode,
    booking_ref: bookingRef, bl_number: blNumber, contract_type: contractType,
    contract_id: contractId, contract_ref: contractRef };
  for (const [col] of Object.entries(TRACKED_FIELDS)) {
    const o = String(existing[col] || ''), n = String(newVals[col] || '');
    if (o !== n) {
      const type = col === 'status' ? 'STATUS_CHANGED' : 'FIELD_UPDATED';
      logEvent(req.params.id, type, col, o || null, n || null);
    }
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
  ok(res, mapShipment(updated));
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

app.post("/api/containers", (req, res) => {
  const { shipmentId, containerNumber = "", sealNumber = "", size, type,
          hsCode = "", cargoDescription = "", grossWeightKg = null, volumeCbm = null, isDg = false, dgClass = "" } = req.body;
  if (!shipmentId || !size || !type) return err(res, "shipmentId, size, type required");
  const id  = `CTR-${uid()}`;
  const cnU = containerNumber.toUpperCase();
  db.prepare("INSERT INTO containers (id,shipment_id,container_number,seal_number,size,type,hs_code,cargo_description,gross_weight_kg,volume_cbm,is_dg,dg_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, shipmentId, cnU, sealNumber, size, type, hsCode, cargoDescription, grossWeightKg, volumeCbm, isDg ? 1 : 0, dgClass);
  const addedCtr = mapContainer({ id, shipment_id: shipmentId, container_number: cnU, seal_number: sealNumber, size, type, hs_code: hsCode, cargo_description: cargoDescription, gross_weight_kg: grossWeightKg, volume_cbm: volumeCbm, is_dg: isDg ? 1 : 0, dg_class: dgClass });
  logEvent(shipmentId, 'CONTAINER_ADDED', null, null, cnU,
    JSON.stringify({ size, type, hsCode, cargoDescription }));
  ok(res, addedCtr, 201);
});

app.put("/api/containers/:id", (req, res) => {
  const { containerNumber = "", sealNumber = "", size, type,
          hsCode = "", cargoDescription = "", grossWeightKg = null, volumeCbm = null, isDg = false, dgClass = "" } = req.body;
  const cnU    = containerNumber.toUpperCase();
  const oldCtr = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
  if (!oldCtr) return err(res, "Not found", 404);
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
  ok(res, mapContainer(row));
});

app.delete("/api/containers/:id", (req, res) => {
  const ctr = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
  if (!ctr) return err(res, "Not found", 404);
  db.prepare("DELETE FROM containers WHERE id=?").run(req.params.id);
  logEvent(ctr.shipment_id, 'CONTAINER_REMOVED', null, ctr.container_number, null,
    JSON.stringify({ size: ctr.size, type: ctr.type }));
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
  if (q.trim()) { clauses.push(`(c.contract_number LIKE ? OR c.carrier_code LIKE ? OR c.named_account LIKE ?)`); const s=`%${q.trim()}%`; params.push(s,s,s); }
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
    clauses.push(`(c.contract_number LIKE ? OR c.named_account LIKE ? OR c.carrier_code LIKE ? OR EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND (l.pol LIKE ? OR l.pod LIKE ? OR l.pol_name LIKE ? OR l.pod_name LIKE ?)))`);
    const s = `%${search.trim()}%`;
    params.push(s, s, s, s, s, s, s);
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
  const { contractNumber="", carrierCode="", namedAccountId="", namedAccount="",
          movementType="FCL", containerTypes=[], dgAllowed=false, imdgClasses=[],
          validFrom="", validTo="", currency="USD", status="Active", notes="",
          legs=[], rates=[] } = req.body;
  const id = `CNTR-${uid()}`;
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO contracts (id,contract_number,carrier_code,named_account_id,named_account,movement_type,container_types,dg_allowed,imdg_classes,valid_from,valid_to,currency,status,notes,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, contractNumber, carrierCode, namedAccountId, namedAccount, movementType,
         JSON.stringify(containerTypes), dgAllowed ? 1 : 0, JSON.stringify(imdgClasses),
         validFrom, validTo, currency, status, notes, createdAt);
  saveLegs(id, legs);
  await saveRates(id, rates);
  const c    = db.prepare("SELECT * FROM contracts WHERE id=?").get(id);
  const lgs  = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(id);
  const rts  = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(id);
  logEntityEvent('contract', id, 'CREATED', null, null, null,
    JSON.stringify({ contractNumber, carrierCode, validFrom, validTo, status }));
  ok(res, { ...mapContract(c), legs: lgs.map(mapLeg), rates: rts.map(mapRate) }, 201);
});

app.put("/api/contracts/:id", async (req, res) => {
  const { contractNumber="", carrierCode="", namedAccountId="", namedAccount="",
          movementType="FCL", containerTypes=[], dgAllowed=false, imdgClasses=[],
          validFrom="", validTo="", currency="USD", status="Active", notes="",
          legs=[], rates=[] } = req.body;
  const info = db.prepare(`UPDATE contracts SET contract_number=?,carrier_code=?,named_account_id=?,named_account=?,
    movement_type=?,container_types=?,dg_allowed=?,imdg_classes=?,valid_from=?,valid_to=?,currency=?,status=?,notes=?
    WHERE id=?`)
    .run(contractNumber, carrierCode, namedAccountId, namedAccount, movementType,
         JSON.stringify(containerTypes), dgAllowed ? 1 : 0, JSON.stringify(imdgClasses),
         validFrom, validTo, currency, status, notes, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  saveLegs(req.params.id, legs);
  await saveRates(req.params.id, rates);
  const c   = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
  const lgs = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(req.params.id);
  const rts = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
  logEntityEvent('contract', req.params.id, 'UPDATED', null, null, null,
    JSON.stringify({ contractNumber, carrierCode, validFrom, validTo, status }));
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