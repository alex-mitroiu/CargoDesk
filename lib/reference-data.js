// Reference data a fresh install needs, loaded by the server itself on start (2026-11-22, the user: "with the first
// deployment all this data is seeded so that people do not have to run scripts constantly or upload manually files").
// Before this, ports, carriers, countries and the rest came only from `npm run setup` / `npm run seed`, which had to run
// with the server stopped (pglite is single-connection), and the Docker image (plain `node server.js`) never ran them.
//
// The committed files in data/ are loaded dataset by dataset. Each load is recorded in reference_data_loads (the file's
// version and the keys it held), so:
//   - first start: every row of the file is added;
//   - same file at a later start: nothing happens;
//   - a release with a changed file: only the rows that are NEW in the file are added (the user's decision 2026-11-22).
//     Nothing is ever overwritten or deleted, so an edited, deactivated or deleted row stays as the user left it.
// `npm run seed` (scripts/import-mdm-data.js) runs mode 'full': every missing row is added back and changed ports are
// refreshed, as that script always did.
//
// The mock vessel list (data/vessels.json: retired Maersk ships, not a real fleet) loads outside production only (the
// user's decision 2026-11-22). The SMDG terminals are not here: they can't be committed (no licence) and are downloaded
// once on first start by lib/facilities.js (firstStartImport).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const BATCH = 500;

// The 14 FIATA-style trade lanes and their average FCL sea transit days (moved from scripts/import-mdm-data.js).
const TRADE_LANES = Object.freeze([
  ["CAR", "Caribbean & Central America", 20],
  ["EAF", "East Africa", 22],
  ["EU-N", "Europe North", 14],
  ["EU-S", "Europe South", 12],
  ["FE", "Far East", 28],
  ["ISC", "Indian Subcontinent", 20],
  ["ME", "Middle East", 18],
  ["NAF", "North Africa", 16],
  ["NAM", "North America", 21],
  ["OCE", "Oceania", 35],
  ["SAF", "South Africa", 20],
  ["SAM", "South America", 25],
  ["SEA", "Southeast Asia", 22],
  ["WAF", "West Africa", 18],
]);

const read = file => fs.readFileSync(path.join(DATA_DIR, file), "utf8");
const lines = file => read(file).split(/\r?\n/).filter(Boolean).slice(1); // header dropped
const sha = rows => crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);

// ─── The files, parsed (pure) ─────────────────────────────────────────────────────────────────────────────────────────

// data/seaports.csv: code;name;latitude;longitude;country_code;zone_code (the zone may carry trailing commas).
function parsePorts(text, timezoneFor) {
  const out = [];
  for (const line of text.split(/\r?\n/).filter(Boolean).slice(1)) {
    const parts = line.split(";");
    if (parts.length < 6) continue;
    const unlocode = parts[0].trim();
    const name = parts[1].trim();
    if (unlocode.length !== 5 || !name) continue;
    const latitude = parseFloat(parts[2]) || null;
    const longitude = parseFloat(parts[3]) || null;
    const countryCode = (parts[4] || "").trim().toUpperCase() || unlocode.slice(0, 2);
    const zoneCode = parts[5] ? parts[5].split(",")[0].trim() : "";
    const timezone = timezoneFor ? timezoneFor({ unlocode, countryCode, latitude, longitude }) : null;
    out.push({ unlocode, name, latitude, longitude, countryCode, zoneCode, timezone });
  }
  return out;
}

// data/carriers.csv: each line a quoted "Short name,Full name,SCAC" (a full name may hold a comma).
function parseCarriers(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/).filter(Boolean).slice(1)) {
    const parts = raw.trim().replace(/^"|"$/g, "").split(",");
    if (parts.length < 3) continue;
    const code = parts[parts.length - 1].trim();
    const name = parts.slice(1, -1).join(",").trim().replace(/<[^>]+>/g, "").replace(/\/A>$/i, "").trim();
    if (!code || code.length < 2 || !name) continue;
    out.push({ code, name, shortName: parts[0].trim() });
  }
  return out;
}

// Regions are the ports' zone codes, named after themselves until someone renames them.
const regionsOf = ports => [...new Set(ports.map(p => p.zoneCode).filter(Boolean))].sort()
  .map(code => ({ code, name: code, description: "Auto-derived from port data — update name as needed" }));

// What to add: everything when the dataset was never loaded (or in mode 'full'); nothing when the file is the one loaded
// last time; otherwise only the keys the last loaded file didn't have.
function planLoad({ rows, keyOf, version, record, mode = "auto" }) {
  if (mode === "full" || !record) return { rows, reason: record ? "full" : "first" };
  if (record.version === version) return { rows: [], reason: "unchanged" };
  let before;
  try { before = new Set(JSON.parse(record.row_keys || "[]")); } catch { before = new Set(); }
  return { rows: rows.filter(r => !before.has(keyOf(r))), reason: "changed" };
}

module.exports = function createReferenceData({ query, transaction, timezoneFor, isProduction = process.env.NODE_ENV === "production", log = console.log } = {}) {
  // Each dataset: its rows (plain objects, no timestamps, so the version only moves with the file), the key, and how a
  // batch is added (→ the keys added). Order matters: lanes and countries before their assignments.
  let portsCache = null;
  const ports = () => (portsCache ||= parsePorts(read("seaports.csv"), timezoneFor));
  const countriesFile = () => JSON.parse(read("countries.json"));

  const DATASETS = [
    {
      name: "trade-lanes", table: "trade_lanes",
      rows: () => TRADE_LANES.map(([code, name, transitDays]) => ({ code, name, transitDays })),
      keyOf: r => r.code,
      insert: (tx, rows) => insertValues(tx, "trade_lanes", ["code", "name", "transit_days"], rows.map(r => [r.code, r.name, r.transitDays]), "code"),
      // mode 'full' only: transit days still empty get the default; a value someone typed stays.
      refresh: async (tx, rows) => {
        let n = 0;
        for (const r of rows) n += (await tx.query("UPDATE trade_lanes SET transit_days=$1 WHERE code=$2 AND (transit_days IS NULL OR transit_days=0) RETURNING code", [r.transitDays, r.code])).length;
        return n;
      },
    },
    {
      name: "countries", table: "countries",
      rows: () => countriesFile().map(c => ({ iso2: c.iso2, name: c.name })),
      keyOf: r => r.iso2,
      insert: (tx, rows) => insertValues(tx, "countries", ["iso2", "name"], rows.map(r => [r.iso2, r.name]), "iso2"),
    },
    {
      // Only where both the country and the lane exist: a country or lane someone deleted isn't brought back by this.
      name: "country-trade-lanes", table: "country_trade_lanes",
      rows: () => countriesFile().flatMap(c => (c.lanes || []).map(laneCode => ({ iso2: c.iso2, laneCode }))),
      keyOf: r => `${r.iso2}:${r.laneCode}`,
      insert: async (tx, rows) => {
        const params = [];
        const values = rows.map(r => { params.push(r.iso2, r.laneCode); return `($${params.length - 1},$${params.length})`; });
        const got = await tx.query(`INSERT INTO country_trade_lanes (iso2, lane_code)
          SELECT v.iso2, v.lane FROM (VALUES ${values.join(",")}) AS v(iso2, lane)
          WHERE EXISTS (SELECT 1 FROM countries c WHERE c.iso2 = v.iso2) AND EXISTS (SELECT 1 FROM trade_lanes t WHERE t.code = v.lane)
          ON CONFLICT (iso2, lane_code) DO NOTHING RETURNING iso2`, params);
        return got.length;
      },
    },
    {
      name: "ports", table: "port_locations",
      rows: ports,
      keyOf: r => r.unlocode,
      insert: (tx, rows, now) => insertValues(tx, "port_locations",
        ["unlocode", "name", "latitude", "longitude", "country_code", "zone_code", "timezone", "last_synced_at"],
        rows.map(r => [r.unlocode, r.name, r.latitude, r.longitude, r.countryCode, r.zoneCode, r.timezone, now]), "unlocode"),
      // mode 'full' only (npm run seed, as before): a port whose name, place, country or time zone changed in the file.
      refresh: async (tx, rows, now) => {
        const params = [now];
        const values = rows.map(r => {
          params.push(r.unlocode, r.name, r.latitude, r.longitude, r.countryCode, r.timezone);
          const n = params.length;
          return `($${n - 5}::text,$${n - 4}::text,$${n - 3}::real,$${n - 2}::real,$${n - 1}::text,$${n}::text)`;
        });
        const got = await tx.query(`UPDATE port_locations p SET name=v.name, latitude=v.lat, longitude=v.lon, country_code=v.cc,
            timezone=v.tz, last_synced_at=$1
          FROM (VALUES ${values.join(",")}) AS v(unlocode, name, lat, lon, cc, tz)
          WHERE p.unlocode = v.unlocode AND (p.name IS DISTINCT FROM v.name OR p.latitude IS DISTINCT FROM v.lat
            OR p.longitude IS DISTINCT FROM v.lon OR p.country_code IS DISTINCT FROM v.cc OR p.timezone IS DISTINCT FROM v.tz)
          RETURNING p.unlocode`, params);
        return got.length;
      },
    },
    {
      name: "regions", table: "regions",
      rows: () => regionsOf(ports()),
      keyOf: r => r.code,
      insert: (tx, rows) => insertValues(tx, "regions", ["code", "name", "description"], rows.map(r => [r.code, r.name, r.description]), "code"),
    },
    {
      name: "carriers", table: "carriers",
      rows: () => parseCarriers(read("carriers.csv")),
      keyOf: r => r.code,
      insert: (tx, rows) => insertValues(tx, "carriers", ["code", "name", "short_name"], rows.map(r => [r.code, r.name, r.shortName]), "code"),
    },
    {
      name: "commodities", table: "commodities",
      rows: () => JSON.parse(read("commodities.json")).map(c => ({ code: c.code, description: c.description, gradeCode: c.gradeCode, gradeName: c.gradeName })),
      keyOf: r => r.code,
      insert: (tx, rows) => insertValues(tx, "commodities", ["code", "description", "grade_code", "grade_name"],
        rows.map(r => [r.code, r.description, r.gradeCode, r.gradeName]), "code"),
    },
    {
      name: "hs-codes", table: "hs_codes",
      rows: () => JSON.parse(read("hs-codes.json")).map(h => ({ code: h.code, description: h.description, hsChapter: h.hsChapter, chapterName: h.chapterName })),
      keyOf: r => r.code,
      insert: (tx, rows, now) => insertValues(tx, "hs_codes", ["code", "description", "hs_chapter", "chapter_name", "created_at", "updated_at"],
        rows.map(r => [r.code, r.description, r.hsChapter, r.chapterName, now, now]), "code"),
    },
    {
      // Mock data (retired Maersk ships): outside production only, unless someone runs npm run seed.
      name: "vessels", table: "vessels", mock: true,
      rows: () => JSON.parse(read("vessels.json")).map(v => ({ imo: String(v.imo), name: v.name, assetType: v.assetType || null,
        flagIso2: v.flagIso2 || null, flagName: v.flagName || null, buildYear: v.buildYear || null, grossTonnage: v.grossTonnage || null })),
      keyOf: r => r.imo,
      insert: (tx, rows) => insertValues(tx, "vessels", ["imo", "name", "asset_type", "flag_iso2", "flag_name", "build_year", "gross_tonnage"],
        rows.map(r => [r.imo, r.name, r.assetType, r.flagIso2, r.flagName, r.buildYear, r.grossTonnage]), "imo"),
    },
  ];

  // One multi-row INSERT … ON CONFLICT DO NOTHING per call (→ rows added). A statement per row made the port list a
  // minute's job on pglite; one per 500 rows makes it seconds.
  async function insertValues(tx, table, columns, rows, key) {
    if (!rows.length) return 0;
    const params = [];
    const values = rows.map(r => `(${r.map(v => { params.push(v); return `$${params.length}`; }).join(",")})`);
    const got = await tx.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values.join(",")}
      ON CONFLICT (${key}) DO NOTHING RETURNING ${key}`, params);
    return got.length;
  }

  // mode 'auto' (the server's start) or 'full' (npm run seed). vessels: 'auto' (outside production only), true, false.
  // → [{ dataset, reason, inFile, added, refreshed, skipped }]
  async function load({ mode = "auto", vessels = "auto" } = {}) {
    const loadVessels = vessels === "auto" ? !isProduction : !!vessels;
    const records = new Map((await query("SELECT * FROM reference_data_loads")).map(r => [r.dataset, r]));
    const summary = [];
    for (const ds of DATASETS) {
      if (ds.mock && !loadVessels) { summary.push({ dataset: ds.name, reason: "production", inFile: 0, added: 0, skipped: true }); continue; }
      let rows;
      try { rows = ds.rows(); } catch (e) {
        log(`  ⚠ Reference data ${ds.name}: its file couldn't be read (${e.message}); skipped`);
        summary.push({ dataset: ds.name, reason: "unreadable", inFile: 0, added: 0, skipped: true, error: e.message });
        continue;
      }
      const version = sha(rows);
      const plan = planLoad({ rows, keyOf: ds.keyOf, version, record: records.get(ds.name), mode });
      const now = new Date().toISOString();
      let added = 0, refreshed = 0;
      // One dataset failing doesn't stop the others (2026-11-22 audit R2). Batches already committed stay (inserts only),
      // and it isn't recorded, so the next start tries it again.
      try {
        for (let i = 0; i < plan.rows.length; i += BATCH) {
          const batch = plan.rows.slice(i, i + BATCH);
          added += await transaction(tx => ds.insert(tx, batch, now));
        }
        if (mode === "full" && ds.refresh) {
          for (let i = 0; i < rows.length; i += BATCH) refreshed += await transaction(tx => ds.refresh(tx, rows.slice(i, i + BATCH), now));
        }
        if (plan.reason !== "unchanged") {
          await query(`INSERT INTO reference_data_loads (dataset, version, row_keys, rows_in_file, rows_added, mode, loaded_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (dataset) DO UPDATE SET version=EXCLUDED.version, row_keys=EXCLUDED.row_keys, rows_in_file=EXCLUDED.rows_in_file,
              rows_added=EXCLUDED.rows_added, mode=EXCLUDED.mode, loaded_at=EXCLUDED.loaded_at`,
            [ds.name, version, JSON.stringify(rows.map(ds.keyOf)), rows.length, added, mode, now]);
        }
      } catch (e) {
        log(`  ⚠ Reference data ${ds.name}: not loaded (${e.message}); the next start tries again`);
        summary.push({ dataset: ds.name, reason: "failed", inFile: rows.length, added, refreshed, skipped: true, error: e.message });
        continue;
      }
      summary.push({ dataset: ds.name, reason: plan.reason, inFile: rows.length, added, refreshed });
    }
    return summary;
  }

  // What was loaded, for GET /api/reference-data: each dataset's last load and how many rows its table holds now.
  async function status() {
    const records = new Map((await query("SELECT dataset, version, rows_in_file, rows_added, mode, loaded_at FROM reference_data_loads")).map(r => [r.dataset, r]));
    const out = [];
    for (const ds of DATASETS) {
      const [{ n }] = await query(`SELECT COUNT(*)::int AS n FROM ${ds.table}`);
      const r = records.get(ds.name);
      out.push({ dataset: ds.name, table: ds.table, rowsNow: Number(n), mock: !!ds.mock,
        loaded: r ? { version: r.version, rowsInFile: Number(r.rows_in_file), rowsAdded: Number(r.rows_added), mode: r.mode, at: r.loaded_at } : null });
    }
    return { datasets: out, vesselsLoadedAutomatically: !isProduction };
  }

  return { load, status, DATASETS };
};

module.exports.parsePorts = parsePorts;
module.exports.parseCarriers = parseCarriers;
module.exports.regionsOf = regionsOf;
module.exports.planLoad = planLoad;
module.exports.TRADE_LANES = TRADE_LANES;
