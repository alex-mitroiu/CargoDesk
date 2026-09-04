/**
 * CargoDesk — MDM Data Import
 * Reads data/carriers.csv and data/seaports.csv and bulk-loads into the DB.
 *
 * Run once the server has booted at least once (safe to re-run after that; uses ON CONFLICT DO
 * NOTHING so duplicates are skipped) — but the SERVER MUST BE STOPPED FIRST:
 *   node scripts/import-mdm-data.js   (or: npm run seed)
 *
 * Do not run this while `npm run dev`/`npm run server` is still up in another terminal — with
 * the embedded pglite fallback (no DATABASE_URL set), that silently corrupts the database with
 * no error here; the corruption only shows up the next time the server restarts, as an opaque
 * WASM abort out of lib/schema.js. This script refuses to run if it detects the server already
 * listening on :3001, but stop it properly first regardless of that guard.
 *
 * Postgres migration note: the old --db=<path> flag (pointed this script at a second SQLite
 * file to seed services/mdm/mdm.sample.db without a second copy of this script) no longer
 * applies — that service is Postgres-backed via its own lib/db.js now, not a raw file path this
 * script could open directly. This script only seeds the monolith's own database, via the
 * standard DATABASE_URL env var lib/db.js already reads (or the embedded pglite fallback).
 */

const path = require("path");
const net  = require("net");
const fs   = require("fs");
const { query, transaction, close } = require("../lib/db.js");

const PORTS_CSV    = path.join(__dirname, "..", "data", "seaports.csv");
const CARRIERS_CSV = path.join(__dirname, "..", "data", "carriers.csv");

// pglite (the embedded dev fallback lib/db.js uses whenever DATABASE_URL is unset) tolerates
// exactly ONE connection to pgdata/ at a time — running this script while server.js is ALSO
// live silently corrupts its WAL with no error here; the corruption only surfaces later, as a
// generic WASM abort on the server's NEXT restart with no useful message pointing back to this
// script (confirmed via a live repro: seed while the server's running, restart the server,
// RuntimeError: Aborted() out of lib/schema.js's initSchema). A rough but reliable-enough
// signal: the server always listens on :3001, so if something's already there, refuse rather
// than risk it — real Postgres (DATABASE_URL set) has no such restriction and skips this check.
function isPortInUse(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

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

async function importPorts() {
  if (!fs.existsSync(PORTS_CSV)) {
    console.warn(`⚠ ${PORTS_CSV} not found — skipping port import`);
    return { inserted: 0, skipped: 0 };
  }

  const lines = fs.readFileSync(PORTS_CSV, "utf8").split(/\r?\n/).filter(Boolean);
  // Strip header
  const dataLines = lines.slice(1);

  let inserted = 0;
  let skipped  = 0;

  // Committed in batches (not one 14,000+-row transaction) — found live while validating the
  // Postgres migration: pglite's embedded WASM engine gets progressively slower per statement as
  // a single transaction grows, turning a ~1-minute job into a ~30-minute one at this table's real
  // size. A real Postgres server wouldn't show this effect nearly as badly, but batching is cheap
  // insurance either way and keeps a partial run's progress durable if it's ever interrupted.
  const BATCH_SIZE = 500;
  for (let i = 0; i < dataLines.length; i += BATCH_SIZE) {
    const batch = dataLines.slice(i, i + BATCH_SIZE);
    await transaction(async (tx) => {
      for (const line of batch) {
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

        const rows = await tx.query(`
          INSERT INTO port_locations (unlocode, name, latitude, longitude, country_code, zone_code, timezone, last_synced_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (unlocode) DO NOTHING
          RETURNING unlocode
        `, [code, name, lat, lon, country, zone, tz, now]);
        if (rows.length > 0) { inserted++; continue; }
        // Delta-sync: update if name/coords changed, or country_code was empty
        await tx.query(
          "UPDATE port_locations SET name=$1, latitude=$2, longitude=$3, country_code=$4, last_synced_at=$5 " +
          "WHERE unlocode=$6 AND (name!=$7 OR latitude!=$8 OR longitude!=$9 OR country_code='' OR country_code IS NULL)",
          [name, lat, lon, country, now, code, name, lat, lon]
        );
        skipped++;
      }
    });
    console.log(`  … ${Math.min(i + BATCH_SIZE, dataLines.length)}/${dataLines.length} port rows processed`);
  }

  return { inserted, skipped };
}

// ─── Import Carriers ───────────────────────────────────────────────────────────

async function importCarriers() {
  if (!fs.existsSync(CARRIERS_CSV)) {
    console.warn(`⚠ ${CARRIERS_CSV} not found — skipping carrier import`);
    return { inserted: 0, skipped: 0 };
  }

  const lines = fs.readFileSync(CARRIERS_CSV, "utf8").split(/\r?\n/).filter(Boolean);
  // Strip header
  const dataLines = lines.slice(1);

  let inserted = 0;
  let skipped  = 0;

  // CSV format: each line is a quoted row → "AbbrvName,Full Name,SCAC"
  // Strip outer quotes then split on comma
  await transaction(async (tx) => {
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

      const rows = await tx.query(
        "INSERT INTO carriers (code, name, short_name) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING RETURNING code",
        [scac, cleanName, shortName]
      );
      if (rows.length > 0) inserted++;
      else skipped++;
    }
  });

  return { inserted, skipped };
}

// ─── Derive and import Regions from zone_codes ─────────────────────────────

async function importRegions() {
  // Pull distinct zone codes from already-imported port_locations
  const zones = await query("SELECT DISTINCT zone_code FROM port_locations WHERE zone_code IS NOT NULL AND zone_code != ''");
  if (!zones.length) {
    console.warn("  ⚠ No zone codes found — import ports first");
    return { inserted: 0, skipped: 0 };
  }

  let inserted = 0, skipped = 0;
  await transaction(async (tx) => {
    for (const { zone_code } of zones) {
      const rows = await tx.query(
        "INSERT INTO regions (code, name, description) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING RETURNING code",
        [zone_code, zone_code, "Auto-derived from port data — update name as needed"]
      );
      if (rows.length > 0) inserted++;
      else skipped++;
    }
  });
  return { inserted, skipped };
}

// ─── Import Vessels ────────────────────────────────────────────────────────────

async function importVessels() {
  const jsonPath = path.join(__dirname, "..", "data", "vessels.json");
  if (!fs.existsSync(jsonPath)) {
    console.warn(`  ⚠ data/vessels.json not found — skipping vessel import`);
    return { inserted: 0, skipped: 0 };
  }
  const vessels = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  let inserted = 0, skipped = 0;
  await transaction(async (tx) => {
    for (const v of vessels) {
      const rows = await tx.query(`
        INSERT INTO vessels
          (imo, name, asset_type, flag_iso2, flag_name, build_year, gross_tonnage)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (imo) DO NOTHING
        RETURNING imo
      `, [v.imo, v.name, v.assetType || null, v.flagIso2 || null,
          v.flagName || null, v.buildYear || null, v.grossTonnage || null]);
      if (rows.length > 0) inserted++; else skipped++;
    }
  });
  return { inserted, skipped };
}

// ─── Import Commodities ────────────────────────────────────────────────────────

async function importCommodities() {
  const jsonPath = path.join(__dirname, "..", "data", "commodities.json");
  if (!fs.existsSync(jsonPath)) {
    console.warn("  ⚠ data/commodities.json not found — skipping");
    return { inserted: 0, skipped: 0 };
  }
  const items = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  let inserted = 0, skipped = 0;
  await transaction(async (tx) => {
    for (const c of items) {
      const rows = await tx.query(
        "INSERT INTO commodities (code,description,grade_code,grade_name) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING RETURNING code",
        [c.code, c.description, c.gradeCode, c.gradeName]
      );
      if (rows.length > 0) inserted++; else skipped++;
    }
  });
  return { inserted, skipped };
}

// ─── Seed trade lanes + their default transit days ─────────────────────────────
// The 14 FIATA-style trade lanes this app has always used (routing_term display,
// longestLane() port resolution, Reports "By Region"). Found missing entirely from this
// script on a genuinely fresh database (v0.71.0's CI fix pass) — trade_lanes had always been
// populated some other way on every long-lived dev database this codebase was ever built
// against, so the gap was invisible until a truly clean install/CI run was actually tested.
// Industry-standard average FCL sea transit times (days); safe to re-run (ON CONFLICT DO NOTHING
// for the row itself, UPDATE only if transit_days is still unset/0, so a manually-edited value is
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

async function importTradeLanes() {
  let tlInserted = 0, tlUpdated = 0;
  await transaction(async (tx) => {
    for (const [code, name, days] of TRANSIT_DEFAULTS) {
      const insRows = await tx.query("INSERT INTO trade_lanes (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING code", [code, name]);
      if (insRows.length > 0) tlInserted++;
      const updRows = await tx.query("UPDATE trade_lanes SET transit_days=$1 WHERE code=$2 AND (transit_days IS NULL OR transit_days=0) RETURNING code", [days, code]);
      if (updRows.length > 0) tlUpdated++;
    }
  });
  return { tlInserted, tlUpdated };
}

// ─── Seed the full country + country→trade-lane registry ───────────────────────
// `countries`/`country_trade_lanes` had the exact same never-actually-seeded gap as
// trade_lanes above under Postgres — `initSchema()` only creates table STRUCTURE, it never
// carries over any data. Under the old SQLite backend this wasn't a gap at all: `server.js`
// auto-copied the committed `db/cargodesk.sample.db` to `cargodesk.db` on first boot with no
// database yet, and that file already carried the real, accumulated 208-country/182-lane-
// assignment data (built up through the admin UI over time — see CLAUDE.md's v0.79.0 entry).
// That auto-copy is dead now (the app reads Postgres/pglite, never a raw `.db` file), but the
// sample file itself is still a legitimate committed reference dataset — read directly here,
// read-only, via `node:sqlite` (this script's only use of the old driver, and only ever
// against this static file, never the live app database) rather than re-deriving/guessing a
// country list from scratch. An earlier narrower version of this function hardcoded just the
// 4 countries (CN/SA/NL/US) specific test fixtures needed — confirmed all 4 already carry the
// exact same lane assignment in the full sample file, so nothing from that narrower set is lost.
async function importFullCountries() {
  const { DatabaseSync } = require("node:sqlite");
  const samplePath = path.join(__dirname, "..", "db", "cargodesk.sample.db");
  if (!fs.existsSync(samplePath)) return { countryInserted: 0, ctlInserted: 0 };
  const sample = new DatabaseSync(samplePath, { readOnly: true });
  const countries = sample.prepare("SELECT iso2, name FROM countries").all();
  const lanes = sample.prepare("SELECT iso2, lane_code FROM country_trade_lanes").all();
  sample.close();

  let countryInserted = 0, ctlInserted = 0;
  await transaction(async (tx) => {
    for (const { iso2, name } of countries) {
      const rows = await tx.query("INSERT INTO countries (iso2, name) VALUES ($1, $2) ON CONFLICT (iso2) DO NOTHING RETURNING iso2", [iso2, name]);
      if (rows.length > 0) countryInserted++;
    }
    for (const { iso2, lane_code } of lanes) {
      const rows = await tx.query("INSERT INTO country_trade_lanes (iso2, lane_code) VALUES ($1, $2) ON CONFLICT (iso2, lane_code) DO NOTHING RETURNING iso2", [iso2, lane_code]);
      if (rows.length > 0) ctlInserted++;
    }
  });
  return { countryInserted, ctlInserted };
}

// ─── Run ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n⚓  CargoDesk MDM Data Import\n");

  if (!process.env.DATABASE_URL && await isPortInUse(3001)) {
    console.error("✗ The CargoDesk server appears to already be running on port 3001.");
    console.error("  This script writes to the same embedded database file the server does —");
    console.error("  running both at once will silently corrupt it, with no error shown here.");
    console.error("  The corruption only shows up the NEXT time the server restarts.");
    console.error("  Stop the server first (Ctrl+C, or Danger Zone → Shutdown Dev Server), then re-run this.");
    process.exit(1);
  }

  const [{ n: schemaReady }] = await query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'carriers'"
  );
  if (Number(schemaReady) === 0) {
    console.error("✗ Schema not found (no 'carriers' table). Start the server at least once first (node server.js) so its schema is created.");
    process.exit(1);
  }

  console.log("Importing port locations...");
  const portResult = await importPorts();
  console.log(`  ✔ Ports: ${portResult.inserted} inserted, ${portResult.skipped} skipped`);

  console.log("Importing commodities...");
  const commResult = await importCommodities();
  console.log(`  ✔ Commodities: ${commResult.inserted} inserted, ${commResult.skipped} skipped`);

  console.log("Importing vessels...");
  const vesselResult = await importVessels();
  console.log(`  ✔ Vessels:  ${vesselResult.inserted} inserted, ${vesselResult.skipped} skipped`);

  console.log("Importing carriers...");
  const carrierResult = await importCarriers();
  console.log(`  ✔ Carriers: ${carrierResult.inserted} inserted, ${carrierResult.skipped} skipped`);

  console.log('Importing regions...');
  const regionResult = await importRegions();
  console.log(`  ✔ Regions:  ${regionResult.inserted} inserted, ${regionResult.skipped} skipped`);

  const { tlInserted, tlUpdated } = await importTradeLanes();
  console.log(`  ✔ Trade lanes: ${tlInserted} inserted, ${tlUpdated} transit-days updated`);

  const { countryInserted, ctlInserted } = await importFullCountries();
  console.log(`  ✔ Countries: ${countryInserted} inserted, Country trade-lane assignments: ${ctlInserted} inserted`);

  const [{ n: totalPorts }]      = await query("SELECT COUNT(*) AS n FROM port_locations");
  const [{ n: totalCarriers }]   = await query("SELECT COUNT(*) AS n FROM carriers");
  const [{ n: totalRegions }]    = await query("SELECT COUNT(*) AS n FROM regions");
  const [{ n: totalVessels }]    = await query("SELECT COUNT(*) AS n FROM vessels");
  const [{ n: totalCommodities }]= await query("SELECT COUNT(*) AS n FROM commodities");
  console.log(`\n  DB now has ${Number(totalPorts).toLocaleString()} ports, ${Number(totalCarriers)} carriers, ${Number(totalRegions)} regions, ${Number(totalVessels)} vessels, and ${Number(totalCommodities)} commodities.`);
  console.log("\nDone. You can restart the server now.\n");
}

// The real cause of a CI hang traced to this file (2026-08-31): main() resolving with no
// explicit process.exit(0) relies on Node's event loop draining naturally to exit — but
// lib/db.js's pglite connection (the embedded dev/CI backend whenever DATABASE_URL is unset)
// is a long-lived module-level singleton that's never closed on its own, so the process just
// hung forever after printing its last line. The "Seed database" CI step's own script had
// already finished successfully; the JOB just never got control back, until the outer job
// timeout eventually killed it — see close()'s own doc comment in lib/db.js on why an explicit
// close() (not just process.exit()) matters for pglite specifically.
main()
  .then(() => close())
  .then(() => process.exit(0))
  .catch(e => { console.error(e); close().finally(() => process.exit(1)); });
