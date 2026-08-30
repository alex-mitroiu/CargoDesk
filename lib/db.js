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

module.exports = { query, transaction };
