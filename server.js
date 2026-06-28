"use strict";
const express    = require("express");
const path       = require("path");
const fs         = require("fs");
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
    unlocode     TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    latitude     REAL DEFAULT 0,
    longitude    REAL DEFAULT 0,
    country_code TEXT DEFAULT '',
    zone_code    TEXT DEFAULT ''
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

  -- ── Commodities (Maersk freight type registry) ──
  CREATE TABLE IF NOT EXISTS commodities (
    code        TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    grade_code  TEXT NOT NULL DEFAULT 'E',
    grade_name  TEXT NOT NULL DEFAULT 'General Cargo'
  );
  CREATE INDEX IF NOT EXISTS idx_commodities_desc ON commodities(description);
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
  "ALTER TABLE carriers    ADD COLUMN short_name      TEXT    DEFAULT ''",
];

for (const sql of migrations) {
  try { db.exec(sql); } catch {}
}

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

const mapShipment     = r => ({ id: r.id, pol: r.pol, polName: r.pol_name || '', pod: r.pod, podName: r.pod_name || '', carrierCode: r.carrier_code, contractType: r.contract_type, contractNotes: r.contract_notes || '', status: r.status, createdAt: r.created_at, etd: r.etd || '', eta: r.eta || '', bookingRef: r.booking_ref || '', blNumber: r.bl_number || '', vessel: r.vessel || '', voyage: r.voyage || '', incoterm: r.incoterm || '', vesselImo: r.vessel_imo || '', contractId: r.contract_id || '', commodityCode: r.commodity_code || '' });
const mapContainer    = r => ({ id: r.id, shipmentId: r.shipment_id, containerNumber: r.container_number || '', sealNumber: r.seal_number || '', size: r.size, type: r.type, hsCode: r.hs_code || '', cargoDescription: r.cargo_description || '', grossWeightKg: r.gross_weight_kg ?? null, volumeCbm: r.volume_cbm ?? null, isDg: r.is_dg === 1, dgClass: r.dg_class || '' });
const mapAllocation   = r => ({ id: r.id, carrierCode: r.carrier_code, allocatedTEU: r.allocated_teu, effectiveDate: r.effective_date || '', endDate: r.end_date || '', tradeLane: r.trade_lane || '', notes: r.notes || '', alertThreshold: r.alert_threshold ?? 80, pol: r.pol || '', pod: r.pod || '', originLane: r.origin_lane || '', destLane: r.dest_lane || '', coverageScope: r.coverage_scope || 'STRICT' });
const mapCarrier      = r => ({ code: r.code, name: r.name, shortName: r.short_name || '' });
const mapVessel       = r => ({ imo: r.imo, name: r.name, assetType: r.asset_type || '', flagIso2: r.flag_iso2 || '', flagName: r.flag_name || '', buildYear: r.build_year, grossTonnage: r.gross_tonnage });
const mapPortLocation = r => ({ unlocode: r.unlocode, name: r.name, latitude: r.latitude, longitude: r.longitude, countryCode: r.country_code, zoneCode: r.zone_code });
const mapLinkedPort   = r => ({ id: r.id, primaryUnlocode: r.primary_unlocode, primaryName: r.primary_name || '', linkedUnlocode: r.linked_unlocode, linkedName: r.linked_name || '', note: r.note || '' });
const mapTradeLane    = r => ({ code: r.code, name: r.name, description: r.description || '' });
const mapRegion       = r => ({ code: r.code, name: r.name, description: r.description || '' });
const mapCountry      = r => ({ iso2: r.iso2, name: r.name, unMember: r.un_member === 1, regionCode: r.region_code || '' });
const mapTicket       = r => ({ id: r.id, title: r.title, section: r.section || '', description: r.description || '', priority: r.priority, status: r.status, position: r.position, createdAt: r.created_at });
const mapCommodity    = r => ({ code: r.code, description: r.description, gradeCode: r.grade_code, gradeName: r.grade_name });

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
          incoterm = "", vesselImo = "", contractId = "", commodityCode = "" } = req.body;
  if (!pol || !pod || !carrierCode || !contractType) return err(res, "pol, pod, carrierCode, contractType required");
  const id = `SHP-${uid()}`;
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO shipments (id,pol,pod,carrier_code,contract_type,contract_notes,status,created_at,etd,eta,booking_ref,bl_number,vessel,voyage,incoterm,vessel_imo,contract_id,commodity_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, polU, podU, carrierCode, contractType, contractNotes, status, createdAt, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, contractId, commodityCode);
  ok(res, mapShipment({ id, pol: polU, pod: podU, carrier_code: carrierCode, contract_type: contractType, contract_notes: contractNotes, status, created_at: createdAt, etd, eta, booking_ref: bookingRef, bl_number: blNumber, vessel, voyage, incoterm, vessel_imo: vesselImo, contract_id: contractId, commodity_code: commodityCode }), 201);
});

app.put("/api/shipments/:id", (req, res) => {
  const { pol, pod, carrierCode, contractType, contractNotes = "", status,
          etd = "", eta = "", bookingRef = "", blNumber = "", vessel = "", voyage = "",
          incoterm = "", vesselImo = "", contractId = "", commodityCode = "" } = req.body;
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const existing = db.prepare("SELECT status FROM shipments WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const info = db.prepare(`
    UPDATE shipments SET pol=?, pod=?, carrier_code=?, contract_type=?, contract_notes=?, status=?,
    etd=?, eta=?, booking_ref=?, bl_number=?, vessel=?, voyage=?, incoterm=?, vessel_imo=?, contract_id=?, commodity_code=? WHERE id=?
  `).run(polU, podU, carrierCode, contractType, contractNotes, status, etd, eta, bookingRef, blNumber, vessel, voyage, incoterm, vesselImo, contractId, commodityCode, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
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
  ok(res, mapContainer({ id, shipment_id: shipmentId, container_number: cnU, seal_number: sealNumber, size, type, hs_code: hsCode, cargo_description: cargoDescription, gross_weight_kg: grossWeightKg, volume_cbm: volumeCbm, is_dg: isDg ? 1 : 0, dg_class: dgClass }), 201);
});

app.put("/api/containers/:id", (req, res) => {
  const { containerNumber = "", sealNumber = "", size, type,
          hsCode = "", cargoDescription = "", grossWeightKg = null, volumeCbm = null, isDg = false, dgClass = "" } = req.body;
  const cnU  = containerNumber.toUpperCase();
  const info = db.prepare("UPDATE containers SET container_number=?, seal_number=?, size=?, type=?, hs_code=?, cargo_description=?, gross_weight_kg=?, volume_cbm=?, is_dg=?, dg_class=? WHERE id=?")
    .run(cnU, sealNumber, size, type, hsCode, cargoDescription, grossWeightKg, volumeCbm, isDg ? 1 : 0, dgClass, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  const row = db.prepare("SELECT * FROM containers WHERE id=?").get(req.params.id);
  ok(res, mapContainer(row));
});

app.delete("/api/containers/:id", (req, res) => {
  const info = db.prepare("DELETE FROM containers WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

// ─── Allocations ──────────────────────────────────────────────────────────────

app.get("/api/allocations", (req, res) => {
  ok(res, db.prepare("SELECT * FROM allocations ORDER BY effective_date DESC").all().map(mapAllocation));
});

app.post("/api/allocations", (req, res) => {
  const { carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane = '', notes = '',
          alertThreshold = 80, pol = '', pod = '', originLane = '', destLane = '', coverageScope = 'STRICT' } = req.body;
  if (!carrierCode || allocatedTEU == null || !effectiveDate || !endDate || !pol || !pod)
    return err(res, "carrierCode, allocatedTEU, effectiveDate, endDate, pol, pod all required");
  if (endDate < effectiveDate) return err(res, "end date must be on or after effective date");
  if (checkOverlap(carrierCode, effectiveDate, endDate, pol, pod))
    return err(res, `An allocation for ${carrierCode} on route ${pol.toUpperCase()} → ${pod.toUpperCase()} already covers that date range`);
  const id = `ALC-${uid()}`;
  db.prepare("INSERT INTO allocations (id,carrier_code,allocated_teu,effective_date,end_date,trade_lane,notes,alert_threshold,pol,pod,origin_lane,dest_lane,coverage_scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane, notes, alertThreshold, pol.toUpperCase(), pod.toUpperCase(), originLane, destLane, coverageScope);
  ok(res, mapAllocation({ id, carrier_code: carrierCode, allocated_teu: allocatedTEU, effective_date: effectiveDate, end_date: endDate, trade_lane: tradeLane, notes, alert_threshold: alertThreshold, pol: pol.toUpperCase(), pod: pod.toUpperCase(), origin_lane: originLane, dest_lane: destLane, coverage_scope: coverageScope }), 201);
});

app.put("/api/allocations/:id", (req, res) => {
  const { carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane = '', notes = '',
          alertThreshold = 80, pol = '', pod = '', originLane = '', destLane = '' } = req.body;
  if (!effectiveDate || !endDate || !pol || !pod) return err(res, "effectiveDate, endDate, pol, pod required");
  if (endDate < effectiveDate) return err(res, "end date must be on or after effective date");
  if (checkOverlap(carrierCode, effectiveDate, endDate, pol, pod, req.params.id))
    return err(res, `Another allocation for ${carrierCode} on route ${pol.toUpperCase()} → ${pod.toUpperCase()} already covers that date range`);
  const info = db.prepare("UPDATE allocations SET carrier_code=?, allocated_teu=?, effective_date=?, end_date=?, trade_lane=?, notes=?, alert_threshold=?, pol=?, pod=?, origin_lane=?, dest_lane=? WHERE id=?")
    .run(carrierCode, allocatedTEU, effectiveDate, endDate, tradeLane, notes, alertThreshold, pol.toUpperCase(), pod.toUpperCase(), originLane, destLane, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, mapAllocation({ id: req.params.id, carrier_code: carrierCode, allocated_teu: allocatedTEU, effective_date: effectiveDate, end_date: endDate, trade_lane: tradeLane, notes, alert_threshold: alertThreshold, pol: pol.toUpperCase(), pod: pod.toUpperCase(), origin_lane: originLane, dest_lane: destLane }));
});

app.delete("/api/allocations/:id", (req, res) => {
  const info = db.prepare("DELETE FROM allocations WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
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
  try { db.prepare("INSERT INTO carriers (code,name,short_name) VALUES (?,?,?)").run(code.toUpperCase().trim(), name.trim(), shortName.trim()); ok(res, mapCarrier({ code: code.toUpperCase().trim(), name: name.trim(), short_name: shortName.trim() }), 201); }
  catch(e) { err(res, isUniqueViolation(e) ? `Carrier ${code} already exists` : e.message); }
});
app.put("/api/carriers/:code", (req, res) => {
  const { name, shortName = '' } = req.body;
  const info = db.prepare("UPDATE carriers SET name=?, short_name=? WHERE code=?").run(name, shortName, req.params.code);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, mapCarrier({ code: req.params.code, name, short_name: shortName }));
});
app.delete("/api/carriers/:code", (req, res) => { const info = db.prepare("DELETE FROM carriers WHERE code=?").run(req.params.code); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.code}); });

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
  try { db.prepare("INSERT INTO port_locations (unlocode,name,latitude,longitude,country_code,zone_code) VALUES (?,?,?,?,?,?)").run(code, name.trim(), latitude, longitude, countryCode.trim().toUpperCase(), zoneCode.trim()); ok(res, mapPortLocation({ unlocode: code, name: name.trim(), latitude, longitude, country_code: countryCode.trim().toUpperCase(), zone_code: zoneCode.trim() }), 201); }
  catch(e) { err(res, isUniqueViolation(e) ? `Port ${unlocode} already exists` : e.message); }
});
app.put("/api/port-locations/:unlocode", (req, res) => {
  const { name, latitude=0, longitude=0, countryCode='', zoneCode='' } = req.body;
  const info = db.prepare("UPDATE port_locations SET name=?, latitude=?, longitude=?, country_code=?, zone_code=? WHERE unlocode=?").run(name, latitude, longitude, countryCode.toUpperCase(), zoneCode, req.params.unlocode.toUpperCase());
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

app.get("/api/trade-lanes", (req, res) => ok(res, db.prepare("SELECT * FROM trade_lanes ORDER BY code").all().map(mapTradeLane)));
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
    LEFT JOIN port_locations pl ON SUBSTR(pl.unlocode, 1, 2) = c.iso2
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
  const { title, section='', description='', priority='Medium', status='Ready' } = req.body;
  if (!title) return err(res, "title required");
  const id = `TKT-${uid()}`;
  const pos = (db.prepare("SELECT MAX(position) AS m FROM tickets WHERE status=?").get(status)?.m ?? -1) + 1;
  db.prepare("INSERT INTO tickets (id,title,section,description,priority,status,position,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, title, section, description, priority, status, pos, new Date().toISOString());
  ok(res, mapTicket({ id, title, section, description, priority, status, position: pos, created_at: new Date().toISOString() }), 201);
});
app.put("/api/tickets/:id", (req, res) => {
  const { title, section='', description='', priority='Medium', status='Ready', position=0 } = req.body;
  const info = db.prepare("UPDATE tickets SET title=?, section=?, description=?, priority=?, status=?, position=? WHERE id=?").run(title, section, description, priority, status, position, req.params.id);
  if (info.changes===0) return err(res,"Not found",404);
  ok(res, mapTicket({ id: req.params.id, title, section, description, priority, status, position, created_at: '' }));
});
app.delete("/api/tickets/:id", (req, res) => { const info = db.prepare("DELETE FROM tickets WHERE id=?").run(req.params.id); if (info.changes===0) return err(res,"Not found",404); ok(res,{deleted:req.params.id}); });

// ─── Commodities ──────────────────────────────────────────────────────────────

app.get("/api/commodities", (req, res) => {
  const { search='', limit='50', offset='0' } = req.query;
  const lim = Math.min(parseInt(limit)||50, 300), off = parseInt(offset)||0;
  const s = search.trim();
  const where  = s ? "WHERE code LIKE ? OR description LIKE ? OR grade_name LIKE ?" : "";
  const params = s ? [`%${s}%`, `%${s}%`, `%${s}%`] : [];
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

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = 3001;
app.listen(PORT, () => console.log(`⚓  CargoDesk API running on http://localhost:${PORT}`));