/**
 * Master-data seed files carry South Africa, Zambia, Zimbabwe and the port SGSIN (TKT-XU38KY,
 * TKT-SQVGJ2 audit, 2026-10-09). The country list used to stop at YE, so 45 ports (39 in ZA) pointed
 * at a country that didn't exist and got no trade lane; port_locations had no SGSIN although it is
 * one of the biggest container ports and routes/system.js uses it as a mock transshipment hub.
 * A fresh install (CI included) is seeded from these files by scripts/import-mdm-data.js, and the
 * MDM service from its own sample DB — so the fix is pinned at the source.
 *
 * Usage:
 *   node tests/mdm-reference-data.test.js
 *
 * No server needed: reads db/cargodesk.sample.db, services/mdm/mdm.sample.db and data/seaports.csv.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const SOUTHERN_AFRICA = ["ZA", "ZM", "ZW"];

for (const rel of ["db/cargodesk.sample.db", "services/mdm/mdm.sample.db"]) {
  console.log(`\n${rel}`);
  const db = new DatabaseSync(path.join(ROOT, rel), { readOnly: true });
  try {
    const countries = new Set(db.prepare("SELECT iso2 FROM countries").all().map(r => r.iso2));
    assert("has South Africa, Zambia and Zimbabwe", SOUTHERN_AFRICA.every(c => countries.has(c)), SOUTHERN_AFRICA.filter(c => !countries.has(c)).join(","));
    const lanes = db.prepare(`SELECT iso2, lane_code FROM country_trade_lanes WHERE iso2 IN (${SOUTHERN_AFRICA.map(() => "?").join(",")})`).all(...SOUTHERN_AFRICA);
    assert("each is on trade lane SAF, like its neighbours", SOUTHERN_AFRICA.every(c => lanes.some(l => l.iso2 === c && l.lane_code === "SAF")), JSON.stringify(lanes));
    const orphans = db.prepare("SELECT COUNT(*) AS n FROM port_locations p WHERE NOT EXISTS (SELECT 1 FROM countries c WHERE c.iso2 = p.country_code) AND p.country_code IN ('ZA','ZM','ZW')").get().n;
    assert("no ZA/ZM/ZW port points at a missing country", Number(orphans) === 0, `${orphans} orphans`);
    const sgsin = db.prepare("SELECT * FROM port_locations WHERE unlocode='SGSIN'").get();
    assert("has the port SGSIN (Singapore, zone AS-SIN)", sgsin?.country_code === "SG" && sgsin?.zone_code === "AS-SIN", JSON.stringify(sgsin));
  } finally { db.close(); }
}

console.log("\ndata/seaports.csv (what scripts/import-mdm-data.js loads ports from)");
const csv = fs.readFileSync(path.join(ROOT, "data/seaports.csv"), "utf8");
const sgsinLine = csv.split(/\r?\n/).find(l => l.startsWith("SGSIN;"));
assert("has an SGSIN row in the file's own code;name;lat;lon;country;zone shape", /^SGSIN;Singapore;1\.2644;103\.84;SG;AS-SIN/.test(sgsinLine || ""), sgsinLine);
assert("and only one", csv.split(/\r?\n/).filter(l => l.startsWith("SGSIN;")).length === 1);

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
