"use strict";
// Dual-backend Postgres driver for the monolith itself — same shape as every extracted
// microservice's own lib/db.js (Postgres migration, see ARCHITECTURE.md §13). Real `pg` when
// DATABASE_URL is set (staging/production); an embedded @electric-sql/pglite instance otherwise,
// for local dev/test with no Postgres server available. Unlike a microservice, the monolith lives
// at the repo root, so pgdata/ sits at the root too rather than under services/<name>/.
const path = require("path");
const fs   = require("fs");

let backend = null;

// pglite tolerates exactly ONE process holding pgdata/ open at a time — a second process (a
// stray script, a second `npm run server`, anything) opening its own PGlite instance against the
// same directory silently corrupts the WAL, with no error at the time; the corruption only
// surfaces later, on the NEXT restart, as an opaque WASM RuntimeError: Aborted() with no clue
// pointing back to the actual cause (confirmed via a live repro — this is the real bug behind a
// customer-reported crash, 2026-09-04). Real Postgres (DATABASE_URL set) needs none of this — it
// already handles concurrent connections itself — so this lock only exists on the pglite path.
function acquirePgliteLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, ".cargodesk.lock");
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return lockPath;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // A lock file already exists — check whether the process that created it is actually still
    // alive. `process.kill(pid, 0)` sends no signal, it's a pure liveness probe (works the same
    // on Windows via Node's own polyfill): throws ESRCH if that process is gone, meaning this is
    // just a stale lock a crashed process never cleaned up, not a real live conflict.
    const heldByPid = Number(fs.readFileSync(lockPath, "utf8").trim());
    let stillAlive = true;
    try { process.kill(heldByPid, 0); } catch { stillAlive = false; }
    if (stillAlive) {
      throw new Error(
        `Another process (pid ${heldByPid}) already has this database open at ${dataDir} — ` +
        `pglite only tolerates one connection at a time. Stop that process first (the server's ` +
        `own graceful-shutdown route, not a force-kill, if it's the server), then try again. ` +
        `Running two processes against this data directory at once WILL silently corrupt it.`
      );
    }
    // Stale — reclaim it and retry once.
    fs.unlinkSync(lockPath);
    return acquirePgliteLock(dataDir);
  }
}

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
  const lockPath = acquirePgliteLock(dataDir);
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
    close: async () => {
      await pglite.close();
      try { fs.unlinkSync(lockPath); } catch {}
    },
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
