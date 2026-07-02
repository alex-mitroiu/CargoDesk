/**
 * CargoDesk — MDM Data Import
 * Reads data/carriers.csv and data/seaports.csv and bulk-loads into the DB.
 *
 * Run once (safe to re-run; uses INSERT OR IGNORE so duplicates are skipped):
 *   node scripts/import-mdm-data.js   (or: npm run seed)
 */

const path = require("path");
const fs   = require("fs");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (e) {
  console.error("✗ node:sqlite not available. Requires Node.js 22.5+");
  process.exit(1);
}

const DB_PATH     = path.join(__dirname, "..", "cargodesk.db");
const PORTS_CSV   = path.join(__dirname, "..", "data", "seaports.csv");
const CARRIERS_CSV= path.join(__dirname, "..", "data", "carriers.csv");

if (!fs.existsSync(DB_PATH)) {
  console.error("✗ cargodesk.db not found. Start the server at least once first (node server.js)");
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = OFF"); // speed during bulk import

// ─── Import Seaports ───────────────────────────────────────────────────────────

function importPorts() {
  if (!fs.existsSync(PORTS_CSV)) {
    console.warn(`⚠ ${PORTS_CSV} not found — skipping port import`);
    return 0;
  }

  const lines = fs.readFileSync(PORTS_CSV, "utf8").split(/\r?\n/).filter(Boolean);
  // Strip header
  const dataLines = lines.slice(1);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO port_locations (unlocode, name, latitude, longitude, country_code, zone_code, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let skipped  = 0;

  db.exec("BEGIN");
  try {
    for (const line of dataLines) {
      // Format: code;name;latitude;longitude;country_code;zone_code,,
      const parts = line.split(";");
      if (parts.length < 6) continue;

      const code    = parts[0].trim();
      const name    = parts[1].trim();
      const lat     = parseFloat(parts[2]) || null;
      const lon     = parseFloat(parts[3]) || null;
      const country = (parts[4] || '').trim().toUpperCase() || code.slice(0, 2);
      // zone may have trailing ",," — strip it
      const zone    = parts[5] ? parts[5].split(",")[0].trim() : '';
      const now     = new Date().toISOString();

      if (!code || code.length !== 5 || !name) { skipped++; continue; }

      const info = stmt.run(code, name, lat, lon, country, zone, now);
      if (info.changes > 0) { inserted++; continue; }
      // Delta-sync: update if name/coords changed, or country_code was empty
      db.prepare(
        "UPDATE port_locations SET name=?, latitude=?, longitude=?, country_code=?, last_synced_at=? " +
        "WHERE unlocode=? AND (name!=? OR latitude!=? OR longitude!=? OR country_code='' OR country_code IS NULL)"
      ).run(name, lat, lon, country, now, code, name, lat, lon);
      skipped++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return { inserted, skipped };
}

// ─── Import Carriers ───────────────────────────────────────────────────────────

function importCarriers() {
  if (!fs.existsSync(CARRIERS_CSV)) {
    console.warn(`⚠ ${CARRIERS_CSV} not found — skipping carrier import`);
    return { inserted: 0, skipped: 0 };
  }

  const lines = fs.readFileSync(CARRIERS_CSV, "utf8").split(/\r?\n/).filter(Boolean);
  // Strip header
  const dataLines = lines.slice(1);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO carriers (code, name, short_name)
    VALUES (?, ?, ?)
  `);

  let inserted = 0;
  let skipped  = 0;

  // CSV format: each line is a quoted row → "AbbrvName,Full Name,SCAC"
  // Strip outer quotes then split on comma
  db.exec("BEGIN");
  try {
    for (const rawLine of dataLines) {
      // Remove wrapping quotes if present
      const line = rawLine.trim().replace(/^"|"$/g, "");
      const parts = line.split(",");
      if (parts.length < 3) { skipped++; continue; }

      const shortName = parts[0].trim();
      const scac      = parts[parts.length - 1].trim();
      const fullName  = parts.slice(1, -1).join(",").trim();

      // Skip any HTML artefacts (e.g. "Hapag Lloyd Container Line/A>")
      const cleanName = fullName.replace(/<[^>]+>/g, "").replace(/\/A>$/i, "").trim();

      if (!scac || scac.length < 2 || !cleanName) { skipped++; continue; }

      const info = stmt.run(scac, cleanName, shortName);
      if (info.changes > 0) inserted++;
      else skipped++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return { inserted, skipped };
}

// ─── Run ───────────────────────────────────────────────────────────────────────

console.log("\n⚓  CargoDesk MDM Data Import\n");

console.log("Importing port locations...");
const portResult = importPorts();
console.log(`  ✔ Ports: ${portResult.inserted} inserted, ${portResult.skipped} skipped`);


// ─── Derive and import Regions from zone_codes ─────────────────────────────

function importRegions() {
  // Pull distinct zone codes from already-imported port_locations
  const zones = db.prepare("SELECT DISTINCT zone_code FROM port_locations WHERE zone_code IS NOT NULL AND zone_code != ''").all();
  if (!zones.length) {
    console.warn("  ⚠ No zone codes found — import ports first");
    return { inserted: 0, skipped: 0 };
  }

  const ins = db.prepare("INSERT OR IGNORE INTO regions (code, name, description) VALUES (?,?,?)");
  let inserted = 0, skipped = 0;
  db.exec("BEGIN");
  try {
    for (const { zone_code } of zones) {
      const info = ins.run(zone_code, zone_code, "Auto-derived from port data — update name as needed");
      if (info.changes > 0) inserted++;
      else skipped++;
    }
    db.exec("COMMIT");
  } catch(e) { db.exec("ROLLBACK"); throw e; }
  return { inserted, skipped };
}


// ─── Import Vessels ────────────────────────────────────────────────────────────

function importVessels() {
  const jsonPath = path.join(__dirname, "..", "data", "vessels.json");
  if (!fs.existsSync(jsonPath)) {
    console.warn(`  ⚠ data/vessels.json not found — skipping vessel import`);
    return { inserted: 0, skipped: 0 };
  }
  const vessels = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO vessels
      (imo, name, asset_type, flag_iso2, flag_name, build_year, gross_tonnage)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0, skipped = 0;
  db.exec("BEGIN");
  try {
    for (const v of vessels) {
      const info = stmt.run(v.imo, v.name, v.assetType || null, v.flagIso2 || null,
                            v.flagName || null, v.buildYear || null, v.grossTonnage || null);
      if (info.changes > 0) inserted++; else skipped++;
    }
    db.exec("COMMIT");
  } catch(e) { db.exec("ROLLBACK"); throw e; }
  return { inserted, skipped };
}


// ─── Import Commodities ────────────────────────────────────────────────────────

function importCommodities() {
  const jsonPath = path.join(__dirname, "..", "data", "commodities.json");
  if (!fs.existsSync(jsonPath)) {
    console.warn("  ⚠ data/commodities.json not found — skipping");
    return { inserted: 0, skipped: 0 };
  }
  const items = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const stmt  = db.prepare("INSERT OR IGNORE INTO commodities (code,description,grade_code,grade_name) VALUES (?,?,?,?)");
  let inserted = 0, skipped = 0;
  db.exec("BEGIN");
  try {
    for (const c of items) {
      const info = stmt.run(c.code, c.description, c.gradeCode, c.gradeName);
      if (info.changes > 0) inserted++; else skipped++;
    }
    db.exec("COMMIT");
  } catch(e) { db.exec("ROLLBACK"); throw e; }
  return { inserted, skipped };
}

console.log("Importing commodities...");
const commResult = importCommodities();
console.log(`  ✔ Commodities: ${commResult.inserted} inserted, ${commResult.skipped} skipped`);

console.log("Importing vessels...");
const vesselResult = importVessels();
console.log(`  ✔ Vessels:  ${vesselResult.inserted} inserted, ${vesselResult.skipped} skipped`);

console.log("Importing carriers...");
const carrierResult = importCarriers();
console.log(`  ✔ Carriers: ${carrierResult.inserted} inserted, ${carrierResult.skipped} skipped`);

console.log('Importing regions...');
const regionResult = importRegions();
console.log(`  ✔ Regions:  ${regionResult.inserted} inserted, ${regionResult.skipped} skipped`);

const { n: totalPorts }    = db.prepare("SELECT COUNT(*) AS n FROM port_locations").get();
const { n: totalCarriers } = db.prepare("SELECT COUNT(*) AS n FROM carriers").get();
const { n: totalRegions }  = db.prepare("SELECT COUNT(*) AS n FROM regions").get();

const { n: totalVessels } = db.prepare("SELECT COUNT(*) AS n FROM vessels").get();
const { n: totalCommodities } = db.prepare("SELECT COUNT(*) AS n FROM commodities").get();
console.log(`\n  DB now has ${totalPorts.toLocaleString()} ports, ${totalCarriers} carriers, ${totalRegions} regions, ${totalVessels} vessels, and ${totalCommodities} commodities.`);
console.log("\nDone. You can restart the server now.\n");