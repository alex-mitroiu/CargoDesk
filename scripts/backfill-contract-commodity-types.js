"use strict";
// One-off backfill for the new contracts.commodity_types column (added alongside the
// POST/PUT /api/contracts default-to-FAK logic) — existing Active contracts predate the column
// and are left with an empty string, which the API's own default only ever applies on a NEW
// save, not retroactively. Run once: `node scripts/backfill-contract-commodity-types.js`.
//
// Operates directly against the monolith's local `contracts` table via lib/db.js — the real
// data store while app_settings.contract_source is 'local' (the default). If a deployment has
// flipped contract_source to 'remote', this script has nothing to act on there; the equivalent
// fix would need to run against services/contract-management/'s own database instead (same
// local/remote split scripts/migrate-contracts-to-service.js already documents).
// IMPORTANT: this must run with the monolith NOT running — pglite (the embedded dev backend,
// active whenever DATABASE_URL is unset) is single-connection only, and a second process opening
// the same pgdata/ directory while server.js already holds it open can silently lose writes or
// corrupt the WAL. Stop the server first (POST /internal/dev/shutdown), run this alone, then
// restart it.
const { query, close } = require("../lib/db.js");

async function main() {
  const blank = await query(
    "SELECT id, contract_number, contract_ref FROM contracts WHERE status='Active' AND (commodity_types IS NULL OR TRIM(commodity_types) = '')"
  );
  console.log(`${blank.length} Active contract(s) with no commodity_types set.`);
  if (blank.length === 0) { console.log("Nothing to do."); return; }

  for (const c of blank) {
    await query("UPDATE contracts SET commodity_types='FAK' WHERE id=$1", [c.id]);
    console.log(`  ${c.id}  ${c.contract_number || "(no number)"}${c.contract_ref ? ` / ${c.contract_ref}` : ""}  -> FAK`);
  }
  console.log(`\nBackfilled ${blank.length} contract(s).`);
}

main()
  .then(() => close())
  .then(() => process.exit(0))
  .catch(e => { console.error(e); close().finally(() => process.exit(1)); });
