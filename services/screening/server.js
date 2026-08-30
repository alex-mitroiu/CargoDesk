"use strict";
const express = require("express");
const path = require("path");
const https = require("https");
const { DatabaseSync } = require("node:sqlite");
const { readSecret } = require("./lib/dockerSecret");

const PORT = process.env.SCREENING_SERVICE_PORT || 3006;
const SERVICE_SECRET_DEV_DEFAULT = "cargoDesk-dev-screening-service-secret-do-not-use-in-prod";
const SERVICE_SECRET = readSecret("SCREENING_SERVICE_SECRET", SERVICE_SECRET_DEV_DEFAULT);
if (SERVICE_SECRET === SERVICE_SECRET_DEV_DEFAULT)
  console.warn("⚠  SCREENING_SERVICE_SECRET not set (checked SCREENING_SERVICE_SECRET_FILE, then SCREENING_SERVICE_SECRET) — using insecure dev default. Set it (and the same value in the monolith's own env) before deploying.");

// Zero-script onboarding is deliberately NOT offered here — unlike MDM/Contract Management,
// this service's data is a downloaded denylist, not hand-authored reference/business data. A
// fresh instance starts with zero entries and syncs its own copy on the first manual "Sync Now"
// (or once its auto-sync timer's own settings are enabled) — shipping a stale committed snapshot
// of a security-relevant denylist would be actively worse than an honestly-empty start.
const DB_PATH = path.join(__dirname, "screening.db");

const app = express();
const db = new DatabaseSync(DB_PATH);

// Crash-safety net — same fix applied to the monolith's server.js after a live stress-test found
// an unhandled route error (a bad enum value, `undefined` bound into a node:sqlite statement)
// kills this entire process, same as any other plain Express 4 app with no error handling. Every
// app.get/post/put/patch/delete handler registered from here on is wrapped so a thrown/rejected
// error reaches next(err) — and the error middleware near app.listen below — instead of crashing.
function wrapAsyncHandler(fn) {
  if (typeof fn !== "function") return fn;
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === "function") result.catch(next);
    } catch (e) { next(e); }
  };
}
for (const method of ["get", "post", "put", "patch", "delete"]) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => original(routePath, ...handlers.map(wrapAsyncHandler));
}
process.on("unhandledRejection", (reason) => console.error("⚠ Unhandled promise rejection (process kept alive):", reason));
process.on("uncaughtException", (e) => console.error("⚠ Uncaught exception (process kept alive):", e));

app.use(express.json({ limit: "10mb" })); // the CSL bulk-import entries payload can run a few MB

const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const ok = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });

// Straight port of the monolith's sanctions_entries/sanctions_syncs schema (server.js), plus a
// small settings table this service owns for itself — the auto-sync scheduling knobs
// (api_ofac_enabled/interval, api_csl_enabled/interval) that used to live in the monolith's
// app_settings. No admin UI for these yet on this side (config + CRUD only this pass, matching
// this codebase's own established scoping precedent) — seeded with the exact same defaults the
// monolith always shipped, so scheduling works with zero configuration either way.
db.exec(`
  PRAGMA journal_mode=WAL;

  CREATE TABLE IF NOT EXISTS sanctions_entries (
    id               TEXT PRIMARY KEY,
    source           TEXT NOT NULL,
    ref_id           TEXT DEFAULT '',
    entity_name      TEXT NOT NULL,
    entity_name_norm TEXT NOT NULL,
    entity_type      TEXT DEFAULT '',
    program          TEXT DEFAULT '',
    aliases_norm     TEXT DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_sanctions_norm ON sanctions_entries(entity_name_norm);

  CREATE TABLE IF NOT EXISTS sanctions_syncs (
    source      TEXT PRIMARY KEY,
    synced_at   TEXT NOT NULL,
    entry_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
const SETTING_DEFAULTS = {
  api_ofac_enabled: "true", api_ofac_interval_value: "1", api_ofac_interval_unit: "weeks",
  api_csl_enabled: "true", api_csl_interval_value: "1", api_csl_interval_unit: "weeks",
};
{
  const insSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) insSetting.run(k, v);
}
function getSettings() {
  try { return Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map(r => [r.key, r.value])); }
  catch { return {}; }
}

const normSanctionName = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();

// ─── OFAC SDN sync — ported verbatim from server.js's own syncOfacSdn/httpsGetFollowRedirects ──

function httpsGetFollowRedirects(url, depth = 0, reqHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("Too many redirects"));
    const opts = { rejectUnauthorized: false, headers: reqHeaders };
    https.get(url, opts, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = r.headers.location.startsWith("http") ? r.headers.location : new URL(r.headers.location, url).href;
        return resolve(httpsGetFollowRedirects(next, depth + 1, reqHeaders));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error(`OFAC returned HTTP ${r.statusCode}`)); }
      resolve(r);
    }).on("error", reject);
  });
}

async function syncOfacSdn() {
  const resp = await httpsGetFollowRedirects("https://www.treasury.gov/ofac/downloads/sdn.xml");
  const xml = await new Promise((resolve, reject) => {
    const bufs = [];
    resp.on("data", c => bufs.push(c));
    resp.on("end", () => resolve(Buffer.concat(bufs).toString("utf8")));
    resp.on("error", reject);
  });

  const entries = [];
  for (const block of xml.split("<sdnEntry>").slice(1)) {
    const end = block.indexOf("</sdnEntry>");
    if (end === -1) continue;
    const e = block.substring(0, end);
    const get = tag => { const m = e.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)); return m ? m[1].trim() : ""; };
    const getAll = tag => [...e.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map(m => m[1].trim());
    const last = get("lastName");
    if (!last) continue;
    const first = get("firstName");
    const name = first ? `${first} ${last}` : last;
    const aliasNorms = [];
    for (const ab of [...e.matchAll(/<aka>([\s\S]*?)<\/aka>/g)]) {
      const al = (ab[1].match(/<lastName>([^<]*)<\/lastName>/) || [])[1] || "";
      const af = (ab[1].match(/<firstName>([^<]*)<\/firstName>/) || [])[1] || "";
      const a = af ? `${af} ${al}`.trim() : al.trim();
      if (a) aliasNorms.push(normSanctionName(a));
    }
    entries.push({ refId: get("uid"), name, sdnType: get("sdnType"), programs: getAll("program").join("; "), aliasNorms });
  }

  db.prepare("DELETE FROM sanctions_entries WHERE source='OFAC-SDN'").run();
  const ins = db.prepare(`INSERT OR REPLACE INTO sanctions_entries (id,source,ref_id,entity_name,entity_name_norm,entity_type,program,aliases_norm)
    VALUES (?,'OFAC-SDN',?,?,?,?,?,?)`);
  db.exec("BEGIN");
  try {
    for (const e of entries) ins.run(`OFAC-${e.refId}`, e.refId, e.name, normSanctionName(e.name), e.sdnType, e.programs, JSON.stringify(e.aliasNorms));
    db.exec("COMMIT");
  } catch (e2) { db.exec("ROLLBACK"); throw e2; }

  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO sanctions_syncs (source,synced_at,entry_count) VALUES ('OFAC-SDN',?,?)").run(now, entries.length);
  return { source: "OFAC-SDN", syncedAt: now, entries: entries.length };
}

// ─── Consolidated Screening List sync — ported verbatim from server.js ─────────────────────────
async function syncConsolidatedScreeningList() {
  const r = await fetch("https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.json");
  if (!r.ok) throw new Error(`Consolidated Screening List returned HTTP ${r.status}`);
  const data = await r.json();
  const results = Array.isArray(data.results) ? data.results : [];
  const entries = results.filter(e => e.id && e.name && !/^Specially Designated Nationals/i.test(e.source || ""));

  db.prepare("DELETE FROM sanctions_entries WHERE id LIKE 'CSL-%'").run();
  const ins = db.prepare(`INSERT OR REPLACE INTO sanctions_entries (id,source,ref_id,entity_name,entity_name_norm,entity_type,program,aliases_norm)
    VALUES (?,?,?,?,?,?,?,?)`);
  db.exec("BEGIN");
  try {
    for (const e of entries)
      ins.run(`CSL-${e.id}`, e.source || "Consolidated Screening List", String(e.id), e.name,
               normSanctionName(e.name), e.type || "", (e.programs || []).join("; "),
               JSON.stringify((e.alt_names || []).map(normSanctionName)));
    db.exec("COMMIT");
  } catch (e2) { db.exec("ROLLBACK"); throw e2; }

  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO sanctions_syncs (source,synced_at,entry_count) VALUES ('CSL',?,?)").run(now, entries.length);
  return { source: "CSL", syncedAt: now, entries: entries.length };
}

// ─── Auto-sync schedulers — ported verbatim from server.js, reading this service's own local
// settings table instead of the monolith's app_settings ──────────────────────────────────────

const MAX_TIMER_MS = 2_000_000_000; // ~23.1 days — setTimeout is backed by a 32-bit int
let ofacAutoSyncTimer = null;
let cslAutoSyncTimer = null;

function scheduleNextOfacSync(retryDelayMs = null) {
  clearTimeout(ofacAutoSyncTimer);
  try {
    const s = getSettings();
    if (s.api_ofac_enabled !== "true") return;
    const lastSync = db.prepare("SELECT synced_at FROM sanctions_syncs WHERE source='OFAC-SDN'").get();
    if (!lastSync) return; // never synced — an operator must trigger the first one manually

    let delay;
    if (retryDelayMs != null) {
      delay = Math.min(MAX_TIMER_MS, retryDelayMs);
    } else {
      const val = Math.max(1, parseInt(s.api_ofac_interval_value) || 1);
      const unit = s.api_ofac_interval_unit || "weeks";
      const msMap = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const intervalMs = val * (msMap[unit] || msMap.weeks);
      const nextDue = new Date(lastSync.synced_at).getTime() + intervalMs;
      delay = Math.min(MAX_TIMER_MS, Math.max(60000, nextDue - Date.now()));
    }

    ofacAutoSyncTimer = setTimeout(async () => {
      const ls = db.prepare("SELECT synced_at FROM sanctions_syncs WHERE source='OFAC-SDN'").get();
      const sv = Math.max(1, parseInt(getSettings().api_ofac_interval_value) || 1);
      const su = getSettings().api_ofac_interval_unit || "weeks";
      const msMap = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const due = ls ? new Date(ls.synced_at).getTime() + sv * (msMap[su] || msMap.weeks) : 0;
      if (Date.now() < due) { scheduleNextOfacSync(); return; }

      console.log("🛂 Auto-syncing OFAC SDN…");
      try {
        const r = await syncOfacSdn();
        console.log(`  ✔ OFAC auto-sync complete: ${r.entries.toLocaleString()} entries`);
        scheduleNextOfacSync();
      } catch (e) {
        console.error("  ✗ OFAC auto-sync failed:", e.message);
        scheduleNextOfacSync(3_600_000);
      }
    }, delay);

    console.log(`  ⏱ OFAC auto-sync scheduled in ${Math.round(delay / 3600000 * 10) / 10}h`);
  } catch {}
}

function scheduleNextCslSync(retryDelayMs = null) {
  clearTimeout(cslAutoSyncTimer);
  try {
    const s = getSettings();
    if (s.api_csl_enabled !== "true") return;
    const lastSync = db.prepare("SELECT synced_at FROM sanctions_syncs WHERE source='CSL'").get();
    if (!lastSync) return;

    let delay;
    if (retryDelayMs != null) {
      delay = Math.min(MAX_TIMER_MS, retryDelayMs);
    } else {
      const val = Math.max(1, parseInt(s.api_csl_interval_value) || 1);
      const unit = s.api_csl_interval_unit || "weeks";
      const msMap = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const intervalMs = val * (msMap[unit] || msMap.weeks);
      const nextDue = new Date(lastSync.synced_at).getTime() + intervalMs;
      delay = Math.min(MAX_TIMER_MS, Math.max(60000, nextDue - Date.now()));
    }

    cslAutoSyncTimer = setTimeout(async () => {
      const ls = db.prepare("SELECT synced_at FROM sanctions_syncs WHERE source='CSL'").get();
      const sv = Math.max(1, parseInt(getSettings().api_csl_interval_value) || 1);
      const su = getSettings().api_csl_interval_unit || "weeks";
      const msMap = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const due = ls ? new Date(ls.synced_at).getTime() + sv * (msMap[su] || msMap.weeks) : 0;
      if (Date.now() < due) { scheduleNextCslSync(); return; }

      console.log("🛂 Auto-syncing Consolidated Screening List…");
      try {
        const r = await syncConsolidatedScreeningList();
        console.log(`  ✔ CSL auto-sync complete: ${r.entries.toLocaleString()} entries`);
        scheduleNextCslSync();
      } catch (e) {
        console.error("  ✗ CSL auto-sync failed:", e.message);
        scheduleNextCslSync(3_600_000);
      }
    }, delay);

    console.log(`  ⏱ CSL auto-sync scheduled in ${Math.round(delay / 3600000 * 10) / 10}h`);
  } catch {}
}
try { scheduleNextOfacSync(); } catch {}
try { scheduleNextCslSync(); } catch {}

// Public liveness check — no secret required, matches every other service's own GET /health.
app.get("/health", (req, res) => ok(res, { status: "ok", service: "screening", uptime: process.uptime() }));

app.use("/internal", (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== SERVICE_SECRET) return err(res, "Unauthorized", 401);
  next();
});

// ─── Routes ─────────────────────────────────────────────────────────────────────────────────────

app.get("/internal/sanctions/entries", (req, res) => {
  const { search = "", limit = "50", offset = "0", source = "" } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
  const conditions = [], params = [];
  if (search.trim()) { conditions.push("(entity_name LIKE ? OR program LIKE ?)"); params.push(`%${search.trim()}%`, `%${search.trim()}%`); }
  if (source.trim()) { conditions.push("source = ?"); params.push(source.trim()); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM sanctions_entries ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT id, source, ref_id, entity_name, entity_type, program FROM sanctions_entries ${where} ORDER BY entity_name LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows, total, limit: lim, offset: off });
});

// Bulk, unpaginated — powers the monolith's own sanctionsMap in-memory cache in remote mode
// (loadSanctionsIndex). Deliberately the columns loadSanctionsIndex actually needs, not SELECT *.
app.get("/internal/sanctions/entries/export", (req, res) => {
  ok(res, db.prepare("SELECT source, entity_name, entity_type, program, aliases_norm FROM sanctions_entries").all());
});

app.get("/internal/sanctions/status", (req, res) => {
  const syncs = db.prepare("SELECT * FROM sanctions_syncs ORDER BY synced_at DESC").all();
  const count = db.prepare("SELECT COUNT(*) AS n FROM sanctions_entries").get().n;
  const ofacCount = db.prepare("SELECT COUNT(*) AS n FROM sanctions_entries WHERE source='OFAC-SDN'").get().n;
  const cslCount = db.prepare("SELECT COUNT(*) AS n FROM sanctions_entries WHERE id LIKE 'CSL-%'").get().n;
  ok(res, { syncs, entryCount: count, ofacEntryCount: ofacCount, cslEntryCount: cslCount });
});

app.post("/internal/sanctions/sync", async (req, res) => {
  try { const r = await syncOfacSdn(); scheduleNextOfacSync(); ok(res, r); }
  catch (e) { err(res, e.message, 502); }
});

app.post("/internal/sanctions/sync-csl", async (req, res) => {
  try { const r = await syncConsolidatedScreeningList(); scheduleNextCslSync(); ok(res, r); }
  catch (e) { err(res, e.message, 502); }
});

// Accepts PRE-PARSED entries ({refId, name, sdnType, program}[]) — CSV text parsing stays on the
// monolith side (routes/sanctions.js's parseOfacCsv, unchanged either way), since it's pure
// string processing with no dependency on which side owns the data.
app.post("/internal/sanctions/import-csv", (req, res) => {
  const { entries = [] } = req.body || {};
  if (!Array.isArray(entries) || entries.length === 0) return err(res, "entries array required");
  try {
    db.prepare("DELETE FROM sanctions_entries WHERE source='OFAC-SDN'").run();
    const ins = db.prepare(`INSERT OR REPLACE INTO sanctions_entries (id,source,ref_id,entity_name,entity_name_norm,entity_type,program,aliases_norm)
      VALUES (?,'OFAC-SDN',?,?,?,?,?,'[]')`);
    db.exec("BEGIN");
    try {
      for (const e of entries) ins.run(`OFAC-${e.refId}`, e.refId, e.name, normSanctionName(e.name), e.sdnType || "", e.program || "");
      db.exec("COMMIT");
    } catch (e2) { db.exec("ROLLBACK"); throw e2; }
    const now = new Date().toISOString();
    db.prepare("INSERT OR REPLACE INTO sanctions_syncs (source,synced_at,entry_count) VALUES ('OFAC-SDN', ?, ?)").run(now, entries.length);
    scheduleNextOfacSync();
    ok(res, { source: "OFAC-SDN", syncedAt: now, entries: entries.length });
  } catch (e) { err(res, e.message, 400); }
});

// Bulk import for the one-time migration script (scripts/migrate-sanctions-to-service.js).
// INSERT OR IGNORE — idempotent, safe to re-run (sanctions_entries.id is a natural key: the
// source-prefixed ref id, e.g. "OFAC-12345" / "CSL-98765").
app.post("/internal/sanctions/bulk-import", (req, res) => {
  const { entries = [] } = req.body || {};
  const ins = db.prepare(`INSERT OR IGNORE INTO sanctions_entries (id,source,ref_id,entity_name,entity_name_norm,entity_type,program,aliases_norm)
    VALUES (?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const e of entries) {
      const info = ins.run(e.id, e.source, e.refId || "", e.entityName, normSanctionName(e.entityName), e.entityType || "", e.program || "", e.aliasesNorm || "[]");
      inserted += info.changes;
    }
    db.exec("COMMIT");
  } catch (e2) { db.exec("ROLLBACK"); return err(res, e2.message, 500); }
  ok(res, { inserted }, 201);
});

// Error-handling middleware — must be registered after every route above. Malformed JSON bodies
// get a clean 400 instead of body-parser's raw HTML/stack-trace page; anything else forwarded via
// wrapAsyncHandler is logged in full server-side and answered with a generic 500 (never the raw
// error/stack to the caller).
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({ error: "Malformed request body — expected valid JSON" });
  }
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, error);
  res.status(error?.status || 500).json({ error: "Internal server error" });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`🛂  Screening Service running on http://localhost:${PORT}`));
}

module.exports = { app, db };
