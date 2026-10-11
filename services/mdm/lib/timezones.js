// Time zone of a UN/LOCODE location (port_locations.timezone), plus what that zone means today.
//
// A location stores only its IANA zone name (e.g. "Europe/Amsterdam"). Whether the zone uses
// daylight saving, its current UTC offset and its abbreviation are worked out from Node's own tz
// database at read time (zoneInfo below), never stored — a stored flag or offset goes stale when
// a country changes its rules (Mexico dropped DST in 2022, Brazil in 2019) and nothing notices.
//
// Where the zone comes from, in order:
//   1. data/port-timezones.json — every location in data/seaports.csv, worked out once by
//      scripts/build-port-timezones.js from the exact time zone borders (geo-tz, too large to
//      ship) and checked against the location's own country.
//   2. A location that isn't in that file (created later in Master Data): its country's only
//      zone, else a coordinate lookup (@photostructure/tz-lookup, small, approximate near
//      borders) kept to zones that belong to its country.
// The country → zones list (data/country-timezones.json) comes from the tz database's zone.tab.
// A coordinate guess outside the country's own zones (UN/LOCODE coordinates are rounded, so a
// border town can land in the neighbour) is mapped to the country's zone with the same offsets,
// and failing that to the country's main zone.
//
// services/mdm/lib/timezones.js is an identical copy (that service has no shared module with the
// monolith); its data files sit in services/mdm/data/. tests/timezones.test.js checks the copies
// match.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const PORTS_FILE = path.join(DATA_DIR, "port-timezones.json");
const COUNTRIES_FILE = path.join(DATA_DIR, "country-timezones.json");

let data = null;
function load() {
  if (!data) {
    data = {
      ports: fs.existsSync(PORTS_FILE) ? JSON.parse(fs.readFileSync(PORTS_FILE, "utf8")) : {},
      countries: fs.existsSync(COUNTRIES_FILE) ? JSON.parse(fs.readFileSync(COUNTRIES_FILE, "utf8")) : {},
    };
  }
  return data;
}

// Changes whenever either data file changes, so the startup correction (server.js
// backfillPortTimezones) re-checks every location once after the data is regenerated.
function timezoneDataVersion() {
  const h = crypto.createHash("sha1");
  for (const f of [PORTS_FILE, COUNTRIES_FILE]) if (fs.existsSync(f)) h.update(fs.readFileSync(f));
  return h.digest("hex");
}

function isValidZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// Minutes east of UTC for `tz` at `date`.
function offsetMinutes(tz, date) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(date).find(p => p.type === "timeZoneName").value; // "GMT+05:30", or "GMT" at UTC
  const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
}

// Two zones with the same January and July offsets keep the same clock all year (this year).
const jan = year => new Date(Date.UTC(year, 0, 15, 12));
const jul = year => new Date(Date.UTC(year, 6, 15, 12));
function offsetSignature(tz, year = new Date().getUTCFullYear()) {
  return `${offsetMinutes(tz, jan(year))}/${offsetMinutes(tz, jul(year))}`;
}

// Picks the zone for a location in `countryCode` from coordinate `guesses` (best first).
// `countries` = { CC: { main, zones: [...] } }. Pure — the build script uses it too.
function pickZone(countryCode, guesses, countries) {
  const valid = (guesses || []).filter(g => g && isValidZone(g));
  const c = countries[String(countryCode || "").toUpperCase()];
  if (!c || !c.zones.length) return valid[0] || null; // not in zone.tab (e.g. XK): trust the map
  if (c.zones.length === 1) return c.zones[0];
  for (const g of valid) if (c.zones.includes(g)) return g;
  for (const g of valid) {
    const sig = offsetSignature(g);
    const same = c.zones.find(z => offsetSignature(z) === sig);
    if (same) return same;
  }
  return c.main || c.zones[0];
}

let tzLookup = null;
function lookupCoordinates(lat, lon) {
  if (!tzLookup) tzLookup = require("@photostructure/tz-lookup");
  try { return tzLookup(lat, lon); } catch { return null; }
}

// The zone for one location. latitude/longitude may be null; 0/0 counts as "no coordinates".
function timezoneFor({ unlocode, countryCode, latitude, longitude }) {
  const { ports, countries } = load();
  const code = String(unlocode || "").trim().toUpperCase();
  if (ports[code]) return ports[code];
  const cc = String(countryCode || code.slice(0, 2)).trim().toUpperCase();
  const lat = latitude == null || latitude === "" ? NaN : Number(latitude);
  const lon = longitude == null || longitude === "" ? NaN : Number(longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
  return pickZone(cc, hasCoords ? [lookupCoordinates(lat, lon)] : [], countries);
}

// What a zone means right now: "UTC+01:00", "CET" (null when the zone has no common
// abbreviation, e.g. Asia/Shanghai), whether it uses daylight saving at all this year and
// whether it is in it today.
function zoneInfo(tz, at = new Date()) {
  if (!tz || !isValidZone(tz)) return null;
  const year = at.getUTCFullYear();
  const a = offsetMinutes(tz, jan(year)), b = offsetMinutes(tz, jul(year)), now = offsetMinutes(tz, at);
  const usesDst = a !== b;
  const sign = now < 0 ? "-" : "+", abs = Math.abs(now);
  // Each English locale only names its own region's zones (en-US: CDT, en-GB: CEST/BST, en-AU:
  // AEDT, en-IN: IST) and gives "GMT+8" elsewhere — take the first real name, else none.
  let abbreviation = null;
  for (const locale of ["en-US", "en-GB", "en-AU", "en-IN", "en-NZ"]) {
    const name = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" })
      .formatToParts(at).find(p => p.type === "timeZoneName").value;
    if (!/^(GMT|UTC)[+-]/.test(name)) { abbreviation = name; break; }
  }
  return {
    timezone: tz,
    utcOffset: `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`,
    abbreviation,
    usesDst,
    inDst: usesDst && now === Math.max(a, b),
  };
}

module.exports = { timezoneFor, pickZone, zoneInfo, offsetSignature, isValidZone, timezoneDataVersion };
