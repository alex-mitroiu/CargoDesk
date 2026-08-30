"use strict";
// Dual-backend Postgres driver — same shape as services/document-distribution/lib/db.js,
// services/screening/lib/db.js, and services/customers/lib/db.js (Postgres migration, see
// ARCHITECTURE.md §13). Real `pg` when DATABASE_URL is set (staging/production); an embedded
// @electric-sql/pglite instance otherwise, for local dev/test with no Postgres server available.
// Self-contained in this service's own lib/ folder — every CargoDesk microservice is
// independently deployable with no cross-directory imports.
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
