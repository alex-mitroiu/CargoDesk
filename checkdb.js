"use strict";
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(path.join(__dirname, "cargodesk.db"));

console.log("\n── port_locations sample ──────────────────────────────────");
db.prepare("SELECT unlocode, country_code, SUBSTR(unlocode,1,2) AS derived FROM port_locations LIMIT 8").all()
  .forEach(r => console.log(`  ${r.unlocode}  country_code="${r.country_code}"  derived="${r.derived}"`));

console.log("\n── ports with empty/null country_code ──────────────────────");
const empty = db.prepare("SELECT COUNT(*) AS n FROM port_locations WHERE country_code IS NULL OR country_code = ''").get();
console.log(`  ${empty.n.toLocaleString()} rows missing country_code`);

const total = db.prepare("SELECT COUNT(*) AS n FROM port_locations").get();
console.log(`  ${total.n.toLocaleString()} total port rows`);

console.log("\n── countries sample ────────────────────────────────────────");
db.prepare("SELECT iso2, name FROM countries LIMIT 5").all()
  .forEach(r => console.log(`  iso2="${r.iso2}"  name="${r.name}"`));

const totalC = db.prepare("SELECT COUNT(*) AS n FROM countries").get();
console.log(`  ${totalC.n.toLocaleString()} total country rows`);

console.log("\n── join test (top 10 by port count) ────────────────────────");
db.prepare(`
  SELECT c.iso2, c.name, COUNT(pl.unlocode) AS cnt
  FROM countries c
  LEFT JOIN port_locations pl ON pl.country_code = c.iso2
  GROUP BY c.iso2
  ORDER BY cnt DESC
  LIMIT 10
`).all().forEach(r => console.log(`  ${r.iso2}  ${r.cnt} ports  ${r.name}`));

console.log("\n── schema: does country_code column exist? ─────────────────");
const cols = db.prepare("PRAGMA table_info(port_locations)").all().map(c => c.name);
console.log("  Columns:", cols.join(", "));
console.log("  country_code exists:", cols.includes("country_code") ? "YES ✔" : "NO ✗");
console.log("  last_synced_at exists:", cols.includes("last_synced_at") ? "YES ✔" : "NO ✗");