/**
 * Regenerates data/port-timezones.json (UN/LOCODE → IANA zone, every row of data/seaports.csv)
 * and data/country-timezones.json (country → its zones, from the tz database's zone.tab), then
 * copies both into services/mdm/data/. Run it after data/seaports.csv changes or a new tz
 * database release; commit the output. The app never runs this — it reads the JSON files
 * (lib/timezones.js).
 *
 * Needs geo-tz (exact time zone borders, ~74 MB, deliberately NOT a project dependency). Install
 * it anywhere and point at that folder:
 *   npm install --prefix /tmp/geotz geo-tz
 *   node scripts/build-port-timezones.js --geo-tz=/tmp/geotz [--zone-tab=/usr/share/zoneinfo/zone.tab]
 *
 * Each location gets the zone geo-tz finds at its coordinates, kept to its own country's zones
 * (lib/timezones.js pickZone): UN/LOCODE coordinates are rounded to the minute, so a border town
 * can land across the border, and a coastal point offshore gets an "Etc/GMT" sea zone.
 */

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { pickZone, isValidZone } = require("../lib/timezones");

const ROOT = path.join(__dirname, "..");
const arg = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || "").split("=").slice(1).join("=");
const zoneTabPath = arg("zone-tab") || "/usr/share/zoneinfo/zone.tab";
const geoTzDir = arg("geo-tz");

if (!geoTzDir) {
  console.error("✗ Pass --geo-tz=<folder where geo-tz is installed> (see the header of this script).");
  process.exit(1);
}
if (!fs.existsSync(zoneTabPath)) {
  console.error(`✗ zone.tab not found at ${zoneTabPath}. Pass --zone-tab=<path>.`);
  process.exit(1);
}
const geoTz = createRequire(path.join(path.resolve(geoTzDir), "package.json"))("geo-tz");
const tzLookup = require("@photostructure/tz-lookup");

// zone.tab: "CC<TAB>coordinates<TAB>Zone[<TAB>comments]", one row per zone per country.
const zonesByCountry = {};
for (const line of fs.readFileSync(zoneTabPath, "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const [cc, , zone] = line.split("\t");
  if (!isValidZone(zone)) { console.warn(`  ⚠ ${zone} (${cc}) unknown to this Node's tz database — skipped`); continue; }
  (zonesByCountry[cc] ||= []).push(zone);
}

const rows = fs.readFileSync(path.join(ROOT, "data", "seaports.csv"), "utf8").split(/\r?\n/).filter(Boolean).slice(1)
  .map(line => {
    const p = line.split(";");
    return { code: p[0].trim(), lat: parseFloat(p[2]), lon: parseFloat(p[3]), cc: ((p[4] || "").trim() || p[0].slice(0, 2)).toUpperCase() };
  })
  .filter(r => r.code.length === 5);

const guessesFor = r => {
  if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || (r.lat === 0 && r.lon === 0)) return [];
  let exact = [];
  try { exact = geoTz.find(r.lat, r.lon); } catch { /* outside the data */ }
  let approx = null;
  try { approx = tzLookup(r.lat, r.lon); } catch { /* ditto */ }
  return [...exact, approx];
};

// Pass 1 without a main zone, to find each country's most common one; pass 2 uses it as the
// fallback for the few locations nothing else settles.
const countries = Object.fromEntries(Object.entries(zonesByCountry).map(([cc, zones]) => [cc, { main: null, zones }]));
const tally = {};
for (const r of rows) {
  const z = pickZone(r.cc, guessesFor(r), countries);
  if (z) ((tally[r.cc] ||= {})[z] = (tally[r.cc][z] || 0) + 1);
}
for (const [cc, c] of Object.entries(countries)) {
  const counts = tally[cc] || {};
  c.main = c.zones.slice().sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0];
}

const ports = {};
let unresolved = 0;
for (const r of rows) {
  const z = pickZone(r.cc, guessesFor(r), countries);
  if (z) ports[r.code] = z; else unresolved++;
}

// One entry per line, sorted, so a regeneration diffs readably.
const writeJson = (file, obj) => {
  const body = Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`).join(",\n");
  fs.writeFileSync(file, `{\n${body}\n}\n`);
};
for (const dir of [path.join(ROOT, "data"), path.join(ROOT, "services", "mdm", "data")]) {
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "port-timezones.json"), ports);
  writeJson(path.join(dir, "country-timezones.json"), countries);
}
console.log(`✔ ${Object.keys(ports).length} locations, ${Object.keys(countries).length} countries` +
  (unresolved ? `, ${unresolved} without a zone (no coordinates and a multi-zone country)` : ""));
