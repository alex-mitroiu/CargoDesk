"use strict";
const { query } = require("../lib/db.js");

async function main() {
  console.log("\n── port_locations sample ──────────────────────────────────");
  (await query("SELECT unlocode, country_code, SUBSTR(unlocode,1,2) AS derived FROM port_locations LIMIT 8"))
    .forEach(r => console.log(`  ${r.unlocode}  country_code="${r.country_code}"  derived="${r.derived}"`));

  console.log("\n── ports with empty/null country_code ──────────────────────");
  const [empty] = await query("SELECT COUNT(*) AS n FROM port_locations WHERE country_code IS NULL OR country_code = ''");
  console.log(`  ${Number(empty.n).toLocaleString()} rows missing country_code`);

  const [total] = await query("SELECT COUNT(*) AS n FROM port_locations");
  console.log(`  ${Number(total.n).toLocaleString()} total port rows`);

  console.log("\n── countries sample ────────────────────────────────────────");
  (await query("SELECT iso2, name FROM countries LIMIT 5"))
    .forEach(r => console.log(`  iso2="${r.iso2}"  name="${r.name}"`));

  const [totalC] = await query("SELECT COUNT(*) AS n FROM countries");
  console.log(`  ${Number(totalC.n).toLocaleString()} total country rows`);

  console.log("\n── join test (top 10 by port count) ────────────────────────");
  (await query(`
    SELECT c.iso2, c.name, COUNT(pl.unlocode) AS cnt
    FROM countries c
    LEFT JOIN port_locations pl ON pl.country_code = c.iso2
    GROUP BY c.iso2, c.name
    ORDER BY cnt DESC
    LIMIT 10
  `)).forEach(r => console.log(`  ${r.iso2}  ${r.cnt} ports  ${r.name}`));

  console.log("\n── schema: does country_code column exist? ─────────────────");
  const colRows = await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'port_locations'");
  const cols = colRows.map(c => c.column_name);
  console.log("  Columns:", cols.join(", "));
  console.log("  country_code exists:", cols.includes("country_code") ? "YES ✔" : "NO ✗");
  console.log("  last_synced_at exists:", cols.includes("last_synced_at") ? "YES ✔" : "NO ✗");
}

main().catch(e => { console.error(e); process.exit(1); });
