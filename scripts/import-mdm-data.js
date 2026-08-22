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

// Single-TZ countries only; multi-TZ handled by server startup backfill using longitude.
const COUNTRY_TZ = {
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
  AM:"Asia/Yerevan",    AZ:"Asia/Baku",        GE:"Asia/Tbilisi",
  KG:"Asia/Bishkek",    TJ:"Asia/Dushanbe",    TM:"Asia/Ashgabat",
  UZ:"Asia/Tashkent",   KZ:"Asia/Almaty",
  AE:"Asia/Dubai",      AF:"Asia/Kabul",       BH:"Asia/Bahrain",
  CY:"Asia/Nicosia",    IQ:"Asia/Baghdad",     IR:"Asia/Tehran",
  IL:"Asia/Jerusalem",  JO:"Asia/Amman",       KW:"Asia/Kuwait",
  LB:"Asia/Beirut",     OM:"Asia/Muscat",      QA:"Asia/Qatar",
  SA:"Asia/Riyadh",     SY:"Asia/Damascus",    YE:"Asia/Aden",
  BD:"Asia/Dhaka",      BN:"Asia/Brunei",      BT:"Asia/Thimphu",
  CN:"Asia/Shanghai",   HK:"Asia/Hong_Kong",   JP:"Asia/Tokyo",
  KH:"Asia/Phnom_Penh", KP:"Asia/Pyongyang",   KR:"Asia/Seoul",
  LA:"Asia/Vientiane",  LK:"Asia/Colombo",     MM:"Asia/Rangoon",
  MN:"Asia/Ulaanbaatar",MO:"Asia/Macau",       MV:"Indian/Maldives",
  MY:"Asia/Kuala_Lumpur",NP:"Asia/Kathmandu",  PH:"Asia/Manila",
  PK:"Asia/Karachi",    SG:"Asia/Singapore",   TH:"Asia/Bangkok",
  TL:"Asia/Dili",       TW:"Asia/Taipei",      VN:"Asia/Ho_Chi_Minh",
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
  AG:"America/Antigua", AW:"America/Aruba",    BB:"America/Barbados",
  BS:"America/Nassau",  BZ:"America/Belize",   BO:"America/La_Paz",
  CO:"America/Bogota",  CR:"America/Costa_Rica",CU:"America/Havana",
  DM:"America/Dominica",DO:"America/Santo_Domingo",EC:"America/Guayaquil",
  GD:"America/Grenada", GF:"America/Cayenne",  GT:"America/Guatemala",
  GY:"America/Guyana",  HN:"America/Tegucigalpa",HT:"America/Port-au-Prince",
  JM:"America/Jamaica", KN:"America/St_Kitts", KY:"America/Cayman",
  LC:"America/St_Lucia",MQ:"America/Martinique",NI:"America/Managua",
  PA:"America/Panama",  PE:"America/Lima",     PR:"America/Puerto_Rico",
  PY:"America/Asuncion",SR:"America/Paramaribo",SV:"America/El_Salvador",
  TT:"America/Port_of_Spain",UY:"America/Montevideo",VE:"America/Caracas",
  BO:"America/La_Paz",  CK:"Pacific/Rarotonga",FJ:"Pacific/Fiji",
  GU:"Pacific/Guam",    NC:"Pacific/Noumea",   NZ:"Pacific/Auckland",
  PF:"Pacific/Tahiti",  PG:"Pacific/Port_Moresby",PW:"Pacific/Palau",
  SB:"Pacific/Guadalcanal",TO:"Pacific/Tongatapu",WS:"Pacific/Apia",
};

function importPorts() {
  if (!fs.existsSync(PORTS_CSV)) {
    console.warn(`⚠ ${PORTS_CSV} not found — skipping port import`);
    return 0;
  }

  const lines = fs.readFileSync(PORTS_CSV, "utf8").split(/\r?\n/).filter(Boolean);
  // Strip header
  const dataLines = lines.slice(1);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO port_locations (unlocode, name, latitude, longitude, country_code, zone_code, timezone, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
      const tz      = COUNTRY_TZ[country] || null;
      const now     = new Date().toISOString();

      if (!code || code.length !== 5 || !name) { skipped++; continue; }

      const info = stmt.run(code, name, lat, lon, country, zone, tz, now);
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

// ─── Seed trade lanes + their default transit days ─────────────────────────────
// The 14 FIATA-style trade lanes this app has always used (routing_term display,
// longestLane() port resolution, Reports "By Region"). Found missing entirely from this
// script on a genuinely fresh database (v0.71.0's CI fix pass) — trade_lanes had always been
// populated some other way on every long-lived dev database this codebase was ever built
// against, so the gap was invisible until a truly clean install/CI run was actually tested.
// Industry-standard average FCL sea transit times (days); safe to re-run (INSERT OR IGNORE for
// the row itself, UPDATE only if transit_days is still unset/0, so a manually-edited value is
// never clobbered).
const TRANSIT_DEFAULTS = [
  ["CAR", "Caribbean & Central America", 20],
  ["EAF", "East Africa", 22],
  ["EU-N", "Europe North", 14],
  ["EU-S", "Europe South", 12],
  ["FE",  "Far East", 28],
  ["ISC", "Indian Subcontinent", 20],
  ["ME",  "Middle East", 18],
  ["NAF", "North Africa", 16],
  ["NAM", "North America", 21],
  ["OCE", "Oceania", 35],
  ["SAF", "South Africa", 20],
  ["SAM", "South America", 25],
  ["SEA", "Southeast Asia", 22],
  ["WAF", "West Africa", 18],
];
const insertTl = db.prepare("INSERT OR IGNORE INTO trade_lanes (code, name) VALUES (?, ?)");
const updateTl = db.prepare("UPDATE trade_lanes SET transit_days=? WHERE code=? AND (transit_days IS NULL OR transit_days=0)");
let tlInserted = 0, tlUpdated = 0;
for (const [code, name, days] of TRANSIT_DEFAULTS) {
  const info = insertTl.run(code, name);
  if (info.changes > 0) tlInserted++;
  const upd = updateTl.run(days, code);
  if (upd.changes > 0) tlUpdated++;
}
console.log(`  ✔ Trade lanes: ${tlInserted} inserted, ${tlUpdated} transit-days updated`);

// ─── Seed a minimal country → trade-lane assignment set ────────────────────────
// country_trade_lanes (which countries fall in which lane, used by longestLane()/
// GET /api/trade-lanes/transit-suggestion) had the exact same never-actually-seeded gap
// as trade_lanes above — found the same way, via a genuinely fresh CI database. This app's
// own Master Data pages expect an admin to configure the full set over time; this seeds
// only the small, unambiguous set real test fixtures need (CN/SA for transit-suggestion; NL +
// US for the NLRTM->USNYC route used by both tests/billing-performance.test.js's Story 4
// lane-resolution assertion and tests/customer-credit-control.test.js's whole trade-lane-scoped
// hold/override-approval mechanism, matchesScopeItem() in server.js — same
// port_locations->countries->country_trade_lanes->trade_lanes chain as portLanesMap itself.
// Both added after fresh-CI runs failed on exactly this gap, one country at a time: NL->EU-N
// held on every long-lived dev DB either test was ever written/run against, and once that was
// fixed CI got further and hit the exact same gap on the US->NAM half of the same route — not
// an attempt at a full country/lane geography.
// `countries` itself is a harder dependency here than it first looked: rebuildPortLanesMap()'s
// own query JOINs port_locations -> countries -> country_trade_lanes -> trade_lanes, so a
// country_trade_lanes row is silently useless without a matching `countries` row too — found
// via a real CI failure even after this exact seeding was added, since `countries` is a whole
// separate table `npm run seed` has never populated at all (no bundled country-name dataset
// exists to seed it from in general — see the `smoke.cy.js` gate on that). Seed only the
// countries these specific lane assignments need, not a general country registry.
const COUNTRY_LANE_DEFAULTS = [
  ["CN", "China",         "FE"],
  ["SA", "Saudi Arabia",  "ME"],
  ["NL", "Netherlands",   "EU-N"],
  ["US", "United States", "NAM"],
];
const insertCountry = db.prepare("INSERT OR IGNORE INTO countries (iso2, name) VALUES (?, ?)");
const insertCtl = db.prepare("INSERT OR IGNORE INTO country_trade_lanes (iso2, lane_code) VALUES (?, ?)");
let countryInserted = 0, ctlInserted = 0;
for (const [iso2, name, laneCode] of COUNTRY_LANE_DEFAULTS) {
  if (insertCountry.run(iso2, name).changes > 0) countryInserted++;
  if (insertCtl.run(iso2, laneCode).changes > 0) ctlInserted++;
}
console.log(`  ✔ Countries: ${countryInserted} inserted, Country trade-lane assignments: ${ctlInserted} inserted`);

const { n: totalPorts }    = db.prepare("SELECT COUNT(*) AS n FROM port_locations").get();
const { n: totalCarriers } = db.prepare("SELECT COUNT(*) AS n FROM carriers").get();
const { n: totalRegions }  = db.prepare("SELECT COUNT(*) AS n FROM regions").get();

const { n: totalVessels } = db.prepare("SELECT COUNT(*) AS n FROM vessels").get();
const { n: totalCommodities } = db.prepare("SELECT COUNT(*) AS n FROM commodities").get();
console.log(`\n  DB now has ${totalPorts.toLocaleString()} ports, ${totalCarriers} carriers, ${totalRegions} regions, ${totalVessels} vessels, and ${totalCommodities} commodities.`);
console.log("\nDone. You can restart the server now.\n");