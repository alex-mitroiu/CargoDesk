/**
 * CargoDesk — MDM reference data, loaded by hand (npm run seed)
 *
 * Not needed for a new install any more (2026-11-22): the server loads the same data itself on every start
 * (lib/reference-data.js — everything on a fresh database, only a changed file's NEW rows later, never overwriting or
 * deleting anything). This script is the explicit "restore from the files": mode 'full' adds back EVERY missing row
 * (including ones someone deleted), refreshes ports whose name, place, country or time zone changed in the file, fills
 * empty trade-lane transit days, and loads the mock vessels even in production. Same files, same parsing, one copy:
 * data/seaports.csv, carriers.csv, countries.json (countries and their trade lanes), commodities.json, hs-codes.json,
 * vessels.json, plus the 14 trade lanes and the regions derived from the ports' zones.
 *
 * The SERVER MUST BE STOPPED FIRST when it runs on the embedded pglite database (no DATABASE_URL): pglite allows one
 * connection, and lib/db.js's lock refuses a second one (a concurrent run corrupted a database on 2026-09-04). This
 * script also refuses to run while something listens on :3001.
 *   node scripts/import-mdm-data.js   (or: npm run seed)
 */

const net = require("net");
const { query, transaction, close } = require("../lib/db.js");
const { timezoneFor } = require("../lib/timezones");
const createReferenceData = require("../lib/reference-data");

function isPortInUse(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

async function main() {
  console.log("\n⚓  CargoDesk MDM Data Import (full restore from data/)\n");

  if (!process.env.DATABASE_URL && await isPortInUse(3001)) {
    console.error("✗ The CargoDesk server appears to already be running on port 3001.");
    console.error("  This script writes to the same embedded database file the server does —");
    console.error("  running both at once will silently corrupt it, with no error shown here.");
    console.error("  Stop the server first (Ctrl+C, or Danger Zone → Shutdown Dev Server), then re-run this.");
    console.error("  (Not needed for a new install: the server loads this data itself when it starts.)");
    process.exit(1);
  }

  const [{ n: schemaReady }] = await query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'reference_data_loads'"
  );
  if (Number(schemaReady) === 0) {
    console.error("✗ Schema not found (no 'reference_data_loads' table). Start the server once first (node server.js): it creates");
    console.error("  its schema and loads this data by itself.");
    process.exit(1);
  }

  const referenceData = createReferenceData({ query, transaction, timezoneFor });
  const summary = await referenceData.load({ mode: "full", vessels: true });
  for (const s of summary) {
    if (s.skipped) { console.log(`  – ${s.dataset}: skipped (${s.error || s.reason})`); continue; }
    console.log(`  ✔ ${s.dataset}: ${s.added.toLocaleString()} added${s.refreshed ? `, ${s.refreshed.toLocaleString()} refreshed` : ""} (${s.inFile.toLocaleString()} in the file)`);
  }
  const { datasets } = await referenceData.status();
  console.log(`\n  The database now holds ${datasets.map(d => `${d.rowsNow.toLocaleString()} ${d.table}`).join(", ")}.`);
  console.log("\nDone. You can start the server now.\n");
}

// Exit explicitly (2026-08-31, a CI hang): pglite's connection is a module-level singleton that is never closed on its
// own, so the process would otherwise sit there after the last line. close() first, so pglite shuts down cleanly.
main()
  .then(() => close())
  .then(() => process.exit(0))
  .catch(e => { console.error(e); close().finally(() => process.exit(1)); });
