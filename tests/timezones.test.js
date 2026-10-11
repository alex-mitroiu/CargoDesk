/**
 * Location time zones (lib/timezones.js) — pure unit test, no server needed.
 *
 * Covers the cases the old one-zone-per-country table and longitude bands got wrong (Chicago on
 * New York time, the Canaries on Madrid time, India/Chile/Argentina blank), coordinate lookups
 * for locations missing from data/port-timezones.json, the zone facts worked out at read time
 * (offset, daylight saving), and that the Master Data service's copies are identical.
 *
 * Usage:
 *   node tests/timezones.test.js
 */

const fs = require("fs");
const path = require("path");
const { timezoneFor, pickZone, zoneInfo } = require("../lib/timezones");

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const eq = (label, actual, expected) => assert(label, actual === expected, `got ${actual}, expected ${expected}`);

console.log("\nKnown UN/LOCODEs (data/port-timezones.json)");
for (const [code, tz] of [
  ["NLRTM", "Europe/Amsterdam"], ["CNSHA", "Asia/Shanghai"], ["USNYC", "America/New_York"],
  ["USCHI", "America/Chicago"], ["USLAX", "America/Los_Angeles"], ["USANC", "America/Anchorage"],
  ["AUSYD", "Australia/Sydney"], ["AUBNE", "Australia/Brisbane"], ["AUPER", "Australia/Perth"],
  ["ESLPA", "Atlantic/Canary"], ["PTPDL", "Atlantic/Azores"], ["PTFNC", "Atlantic/Madeira"],
  ["INNSA", "Asia/Kolkata"], ["CLVAP", "America/Santiago"], ["BRSSZ", "America/Sao_Paulo"],
  ["CASJF", "America/St_Johns"], ["MYTPP", "Asia/Kuala_Lumpur"], ["IDDJJ", "Asia/Jayapura"],
  ["TWKHH", "Asia/Taipei"],
]) eq(`${code} → ${tz}`, timezoneFor({ unlocode: code }), tz);

console.log("\nNew locations, not in the data file");
eq("single-zone country needs no coordinates", timezoneFor({ unlocode: "NLZZZ" }), "Europe/Amsterdam");
eq("US by coordinates (Houston area)", timezoneFor({ unlocode: "USZZZ", latitude: 29.76, longitude: -95.37 }), "America/Chicago");
eq("US by coordinates (Phoenix — no daylight saving)", timezoneFor({ unlocode: "USZZY", latitude: 33.45, longitude: -112.07 }), "America/Phoenix");
eq("Canary Islands by coordinates", timezoneFor({ unlocode: "ESZZZ", latitude: 28.1, longitude: -15.43 }), "Atlantic/Canary");
eq("0/0 counts as no coordinates → country's main zone", timezoneFor({ unlocode: "USZZX", latitude: 0, longitude: 0 }), "America/New_York");
eq("country code taken from the UN/LOCODE when not given", timezoneFor({ unlocode: "INZZZ" }), "Asia/Kolkata");

console.log("\nKept to the location's own country");
const countries = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "country-timezones.json"), "utf8"));
eq("guess across the border, same clock → country's zone", pickZone("MY", ["Asia/Singapore"], countries), "Asia/Kuala_Lumpur");
eq("offshore Etc zone → country's zone with that offset", pickZone("ID", ["Etc/GMT-9"], countries), "Asia/Jayapura");
eq("guess with no matching offset → country's main zone", pickZone("CN", ["Asia/Bangkok"], countries), "Asia/Shanghai");
eq("invalid guess ignored", pickZone("US", ["Not/AZone"], countries), countries.US.main);

console.log("\nZone facts worked out at read time");
const winter = new Date("2026-01-15T12:00:00Z"), summer = new Date("2026-07-15T12:00:00Z");
const ams = zoneInfo("Europe/Amsterdam", winter);
eq("Amsterdam in January: UTC+01:00", ams.utcOffset, "UTC+01:00");
assert("Amsterdam observes daylight saving, not in January", ams.usesDst && !ams.inDst);
assert("Amsterdam is on summer time in July", zoneInfo("Europe/Amsterdam", summer).inDst);
const shanghai = zoneInfo("Asia/Shanghai", summer);
assert("Shanghai: UTC+08:00, no daylight saving", shanghai.utcOffset === "UTC+08:00" && !shanghai.usesDst);
eq("Kolkata half-hour offset", zoneInfo("Asia/Kolkata", winter).utcOffset, "UTC+05:30");
assert("Sydney is on summer time in January (southern hemisphere)", zoneInfo("Australia/Sydney", winter).inDst);
eq("Los Angeles negative offset in July", zoneInfo("America/Los_Angeles", summer).utcOffset, "UTC-07:00");
eq("unknown zone → null", zoneInfo("Not/AZone"), null);

console.log("\nData integrity");
const ports = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "port-timezones.json"), "utf8"));
const seaports = fs.readFileSync(path.join(__dirname, "..", "data", "seaports.csv"), "utf8").split(/\r?\n/).filter(Boolean).length - 1;
eq("every location in seaports.csv has a zone", Object.keys(ports).length, seaports);
const bad = Object.entries(ports).filter(([, tz]) => tz.startsWith("Etc/") || !zoneInfo(tz));
eq("no open-sea or unknown zones", bad.length, 0);
const sameFile = f => fs.readFileSync(path.join(__dirname, "..", f[0])).equals(fs.readFileSync(path.join(__dirname, "..", f[1])));
for (const pair of [["lib/timezones.js", "services/mdm/lib/timezones.js"], ["data/port-timezones.json", "services/mdm/data/port-timezones.json"], ["data/country-timezones.json", "services/mdm/data/country-timezones.json"]])
  assert(`${pair[1]} matches ${pair[0]}`, sameFile(pair));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
