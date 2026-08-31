/**
 * CargoDesk — Sample Business Data Export
 *
 * Dumps the live database's business tables (shipments, customers, contracts, tickets, ...)
 * into db/cargodesk.sample-data.json, a committed demo dataset so a fresh clone can start
 * exploring the app with realistic pre-existing data instead of an empty shell.
 *
 * Deliberately excludes, and scrubs, anything that isn't safe to publish in this repo's public
 * history — see EXCLUDE_TABLES/SCRUB_RULES below for the specific reasoning per table.
 *
 * Run manually when you want to refresh the committed snapshot (not run automatically by
 * anything — same manual-tool convention as scripts/import-mdm-data.js):
 *   node scripts/export-sample-data.js   (or: npm run export:sample-data)
 */
const fs = require("fs");
const path = require("path");
const { query } = require("../lib/db.js");

const OUT_PATH = path.join(__dirname, "..", "db", "cargodesk.sample-data.json");

// Reference/MDM data — already seeded correctly and independently by `npm run seed`
// (scripts/import-mdm-data.js) from data/*.csv + the committed db/cargodesk.sample.db's own
// country list. Dumping it here too would just bloat this file with 14,000+ port rows for zero
// benefit. `vessels` is excluded for the same "keep the demo snapshot lean" reason — it's mostly
// live AIS-discovered rows accumulated over time, not curated demo content.
const SKIP_REFERENCE_DATA = new Set([
  "port_locations", "carriers", "commodities", "regions", "trade_lanes",
  "countries", "country_trade_lanes", "vessels",
  // milestone_templates/kb_projects/kb_columns/kb_versions: server.js's own boot-time seeding
  // (seedDefaultMilestoneTemplate/seedDefaultProject) already creates these with deterministic
  // ids — a real bug found this session: including them here let an independently-seeded
  // historical copy (each with its own random id from whenever it was originally created) merge
  // in as a straight duplicate, since a plain INSERT...ON CONFLICT(id) only guards an exact id
  // match, not a logical duplicate of the same milestone_key/project key. tickets.project_id has
  // no enforced FK to kb_projects (plain TEXT), so excluding these is safe even though tickets
  // themselves (elsewhere in this dump) may reference an id that won't exist in a fresh clone —
  // cosmetic at worst (ticket grouping falls back to its own status field either way).
  "milestone_templates", "kb_projects", "kb_columns", "kb_versions",
]);

// Credentials / secrets — never safe to publish, regardless of how "dummy" the rest of the data
// is. org_signing_certs holds an actual private key; app_settings' *_api_key values are live
// third-party API keys; mail/EDI configs carry SMTP/EDI credentials.
const SKIP_CREDENTIALS = new Set(["org_signing_certs"]);

// Real user accounts and identity — explicitly excluded per direct instruction. Anything keyed
// primarily around a specific user id is meaningless (and non-FK-safe) without the users table
// itself, so it's excluded alongside it rather than shipped as orphaned references.
const SKIP_USERS_AND_USER_KEYED = new Set([
  "users", "user_scope_items", "user_access_configs", "user_offices",
]);

// Transient runtime state — a "locked" edit-lock from whenever this snapshot was taken has no
// meaning in a fresh install (and would just look like a permanently stuck lock).
const SKIP_TRANSIENT = new Set(["shipment_edit_locks"]);

// A live, publicly-sourced sync (OFAC/CSL) — meant to be refreshed via Settings, not frozen into
// a demo snapshot; also 19,000+ rows, unnecessary bloat for a "try the app" dataset.
const SKIP_LIVE_SYNCED = new Set(["sanctions_entries", "sanctions_syncs"]);

const EXCLUDE_TABLES = new Set([
  ...SKIP_REFERENCE_DATA, ...SKIP_CREDENTIALS, ...SKIP_USERS_AND_USER_KEYED,
  ...SKIP_TRANSIENT, ...SKIP_LIVE_SYNCED,
]);

// Column-level scrubbing for tables that are otherwise worth including but carry one or two
// genuinely sensitive fields alongside legitimate demo content.
const SCRUB_RULES = {
  app_settings: (rows) => rows.map(r =>
    /api_key|secret|credential/i.test(r.key) ? { ...r, value: "" } : r),
  office_mail_settings: (rows) => rows.map(r => ({ ...r, smtp_password: "" })),
  system_email_settings: (rows) => rows.map(r => ({ ...r, smtp_password: "" })),
  carrier_eadapter_configs: (rows) => rows.map(r => ({ ...r, credential: "" })),
};

async function main() {
  const tables = (await query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
  )).map(r => r.table_name);

  const dump = {};
  let totalRows = 0;
  for (const table of tables) {
    if (EXCLUDE_TABLES.has(table)) { console.log(`skip   ${table} (excluded)`); continue; }
    let rows = await query(`SELECT * FROM "${table}"`);
    if (SCRUB_RULES[table]) rows = SCRUB_RULES[table](rows);
    if (rows.length === 0) continue;
    dump[table] = rows;
    totalRows += rows.length;
    console.log(`${String(rows.length).padStart(6)}  ${table}`);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(dump));
  console.log(`\nWrote ${Object.keys(dump).length} tables, ${totalRows} rows total, to ${OUT_PATH}`);
}

// pglite keeps the event loop alive indefinitely unless explicitly closed/exited — without this,
// the process never actually terminates even after main() resolves, silently leaking an open
// connection that blocks every subsequent script (and the app itself) from opening pgdata.
main().then(() => process.exit(0)).catch(e => { console.error("FATAL:", e); process.exit(1); });
