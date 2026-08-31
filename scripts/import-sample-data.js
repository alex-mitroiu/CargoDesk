/**
 * CargoDesk — Sample Business Data Import
 *
 * Counterpart to scripts/export-sample-data.js. Loads db/cargodesk.sample-data.json (shipments,
 * customers, contracts, tickets, ...) into the live database so a fresh clone starts with
 * realistic pre-existing data instead of an empty shell — same idea as `npm run seed`
 * (scripts/import-mdm-data.js) for MDM reference data, just for the business tables.
 *
 * Idempotent (INSERT ... ON CONFLICT DO NOTHING) — safe to re-run, and safe to run against a
 * database that already has its own real data (existing rows are never touched or overwritten).
 *
 *   node scripts/import-sample-data.js   (or: npm run seed:sample-data)
 */
const fs = require("fs");
const path = require("path");
const { query, transaction } = require("../lib/db.js");

const DATA_PATH = path.join(__dirname, "..", "db", "cargodesk.sample-data.json");
const BATCH_SIZE = 500;

async function getPgPrimaryKey(table) {
  const rows = await query(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
     WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [table]
  );
  return rows.map(r => r.column_name);
}

async function importTable(table, rows) {
  if (rows.length === 0) return { attempted: 0, inserted: 0 };
  const cols = Object.keys(rows[0]);
  const pk = await getPgPrimaryKey(table);
  if (pk.length === 0) { console.log(`  skip ${table} — no primary key found in live schema`); return { attempted: 0, inserted: 0 }; }

  const colList = cols.map(c => `"${c}"`).join(",");
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const sql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT (${pk.map(c => `"${c}"`).join(",")}) DO NOTHING RETURNING ${pk[0]}`;

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await transaction(async (tx) => {
      for (const row of chunk) {
        const r = await tx.query(sql, cols.map(c => row[c]));
        inserted += r.length;
      }
    });
  }
  return { attempted: rows.length, inserted };
}

async function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.log("No db/cargodesk.sample-data.json found — nothing to import.");
    return;
  }
  const dump = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const tables = Object.keys(dump);
  console.log(`Loaded ${tables.length} tables from ${DATA_PATH}.\n`);

  // Bypass FK ordering entirely for this bulk load, same technique used for the live-data
  // recovery this dataset itself was originally built from — real Postgres's standard approach
  // for loading a dump without hand-solving a 90-table dependency order.
  await query("SET session_replication_role = replica");
  try {
    for (const table of tables) {
      try {
        const { attempted, inserted } = await importTable(table, dump[table]);
        if (attempted > 0) console.log(`${String(inserted).padStart(6)} / ${String(attempted).padEnd(6)} ${table}`);
      } catch (e) {
        console.error(`ERROR  ${table}: ${e.message}`);
      }
    }
  } finally {
    await query("SET session_replication_role = DEFAULT");
  }
  console.log("\nDone.");
}

// pglite keeps the event loop alive indefinitely unless explicitly closed/exited — without this,
// the process never actually terminates even after main() resolves, silently leaking an open
// connection that blocks every subsequent script (and the app itself) from opening pgdata.
main().then(() => process.exit(0)).catch(e => { console.error("FATAL:", e); process.exit(1); });
