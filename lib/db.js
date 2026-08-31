"use strict";
// Dual-backend Postgres driver for the monolith itself — same shape as every extracted
// microservice's own lib/db.js (Postgres migration, see ARCHITECTURE.md §13). Real `pg` when
// DATABASE_URL is set (staging/production); an embedded @electric-sql/pglite instance otherwise,
// for local dev/test with no Postgres server available. Unlike a microservice, the monolith lives
// at the repo root, so pgdata/ sits at the root too rather than under services/<name>/.
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
      close: () => pool.end(),
    };
  }
  const { PGlite } = require("@electric-sql/pglite");
  const dataDir = path.join(__dirname, "..", "pgdata");
  const pglite = new PGlite(dataDir);
  return {
    query: (sql, params) => pglite.query(sql, params),
    connect: async () => ({
      query: (sql, params) => pglite.query(sql, params),
      release: () => {},
    }),
    // pglite's on-disk WAL is only safe to reopen after a clean close() — a force-killed process
    // (SIGKILL, or Windows `taskkill /F` against a detached process, which has no gentler option)
    // can leave it in a "PANIC: could not locate a valid checkpoint record" state that pglite
    // itself cannot recover from (confirmed directly; real Postgres's pg_resetwal can repair it,
    // pglite has no equivalent tool). Always route shutdown through here — see the SIGINT/SIGTERM
    // handlers in server.js — rather than ever relying on a forceful kill.
    close: () => pglite.close(),
  };
}

function getBackend() {
  if (!backend) backend = createBackend();
  return backend;
}

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

// Graceful shutdown — see createBackend()'s pglite branch for why this matters: an unclean stop
// can corrupt pglite's WAL beyond its own ability to recover. No-op if the backend was never
// actually initialized (e.g. the process is exiting before its first query).
async function close() {
  if (backend?.close) await backend.close();
}

module.exports = { query, transaction, close };
