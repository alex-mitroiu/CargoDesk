"use strict";
// Dual-backend Postgres driver — Phase 0 of the CargoDesk Postgres migration (see
// ARCHITECTURE.md's Postgres Migration section). Real `pg` when DATABASE_URL is set (staging/
// production); an embedded @electric-sql/pglite instance otherwise, for local dev/test in an
// environment with no Postgres server available (no Docker, no native install). PGlite is a
// genuine WASM-compiled build of real Postgres, not a compatibility shim — it validates schema
// and query correctness, but it's explicitly single-connection/alpha-status, so it can't stand
// in for real concurrent-connection-pool behavior; that still needs a real server.
//
// Self-contained in this service's own lib/ folder rather than a cross-directory shared module —
// every CargoDesk microservice is independently deployable with no imports reaching outside its
// own directory (confirmed: none of the 7 services import from another service or the monolith's
// root lib/). Any future service migrated to Postgres gets its own copy of this file, same as
// other small, deliberately-duplicated pieces already are in this codebase (e.g. routes/quotes.js's
// own copy of maybeAssignLineAgents).
const path = require("path");

let backend = null;

function createBackend() {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString });
    return {
      query: (sql, params) => pool.query(sql, params),
      connect: () => pool.connect(),
    };
  }
  const { PGlite } = require("@electric-sql/pglite");
  const dataDir = path.join(__dirname, "..", "pgdata");
  const pglite = new PGlite(dataDir);
  // PGlite is single-connection (its own documented limitation) — "checking out a client" for a
  // transaction just serializes on the same instance. Still correct, just not concurrent; that's
  // a property of this dev/test stand-in, not of the real pg-backed production path above.
  return {
    query: (sql, params) => pglite.query(sql, params),
    connect: async () => ({
      query: (sql, params) => pglite.query(sql, params),
      release: () => {},
    }),
  };
}

function getBackend() {
  if (!backend) backend = createBackend();
  return backend;
}

// Returns the row array directly (not the {rows} wrapper) — callers do `(await query(...))[0]`
// for a single-row lookup, or use the array directly for a list, mirroring the .get()/.all()
// split node:sqlite's DatabaseSync API already had.
async function query(sql, params = []) {
  const { rows } = await getBackend().query(sql, params);
  return rows;
}

async function transaction(fn) {
  const client = await getBackend().connect();
  try {
    await client.query("BEGIN");
    const result = await fn({ query: (sql, params = []) => client.query(sql, params).then(r => r.rows) });
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { query, transaction };
