"use strict";
const express    = require("express");
const http       = require("http");
const https      = require("https");
const path       = require("path");
const fs         = require("fs");
const { WebSocketServer } = require("ws");
const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const {
  renderHtmlToPdf,
  generateSelfSignedSigningCert, getActiveSigningCert, signPdfBuffer,
} = require("./lib/pdf-signing");
const {
  createTransporterFromSettings, getTransporterForOffice,
  invalidateTransporterCache, buildMailOptions, sendViaOffice,
} = require("./lib/mailer");
const { createAisListener } = require("./lib/ais-listener");
const { createMappers } = require("./lib/mappers");
const { readSecret } = require("./lib/dockerSecret");
const { createRateLimiter } = require("./lib/rateLimit");
const { addBusinessDays, businessDaysBetween } = require("./lib/business-days");
const staticConfig = require("./lib/staticConfig");

const JWT_DEV_DEFAULT = "cargoDesk-dev-secret-do-not-use-in-prod";
const JWT_SECRET = readSecret("JWT_SECRET", JWT_DEV_DEFAULT);
if (JWT_SECRET === JWT_DEV_DEFAULT)
  console.warn("⚠  JWT_SECRET not set (checked JWT_SECRET_FILE, then JWT_SECRET) — using insecure dev default. Set it before deploying.");

// Document Distribution Service (services/document-distribution/) — CargoDesk's first extracted
// microservice. This secret must match DISTRIBUTION_SERVICE_SECRET in that service's own env.
const DISTRIBUTION_SERVICE_URL = process.env.DISTRIBUTION_SERVICE_URL || "http://localhost:3002";

// PDF Render Service (services/pdf-render/) — stateless, no secret needed here: this constant is
// only used for the System Health check's own GET /health probe, not for calling its protected
// /internal/render route (that call lives in lib/pdf-signing.js with its own copy of this URL).
const PDF_RENDER_SERVICE_URL = process.env.PDF_RENDER_SERVICE_URL || "http://localhost:3003";
const DISTRIBUTION_SECRET_DEV_DEFAULT = "cargoDesk-dev-distribution-secret-do-not-use-in-prod";
const DISTRIBUTION_SERVICE_SECRET = readSecret("DISTRIBUTION_SERVICE_SECRET", DISTRIBUTION_SECRET_DEV_DEFAULT);
if (DISTRIBUTION_SERVICE_SECRET === DISTRIBUTION_SECRET_DEV_DEFAULT)
  console.warn("⚠  DISTRIBUTION_SERVICE_SECRET not set (checked DISTRIBUTION_SERVICE_SECRET_FILE, then DISTRIBUTION_SERVICE_SECRET) — using insecure dev default. Set it (matching the distribution service's own env) before deploying.");

// Contract Management Service (services/contract-management/) — CargoDesk's third extracted
// microservice, and its first that runs ALONGSIDE the monolith's own in-process implementation
// rather than replacing it — selected per-request via the app_settings.contract_source toggle
// ('local'|'remote', default 'local' — see getSettings()/callContractService below). This secret
// must match CONTRACT_SERVICE_SECRET in that service's own env.
const CONTRACT_SERVICE_URL = process.env.CONTRACT_SERVICE_URL || "http://localhost:3004";
const CONTRACT_SECRET_DEV_DEFAULT = "cargoDesk-dev-contract-service-secret-do-not-use-in-prod";
const CONTRACT_SERVICE_SECRET = readSecret("CONTRACT_SERVICE_SECRET", CONTRACT_SECRET_DEV_DEFAULT);
if (CONTRACT_SERVICE_SECRET === CONTRACT_SECRET_DEV_DEFAULT)
  console.warn("⚠  CONTRACT_SERVICE_SECRET not set (checked CONTRACT_SERVICE_SECRET_FILE, then CONTRACT_SERVICE_SECRET) — using insecure dev default. Set it (matching the contract service's own env) before deploying.");

// Unlike callDistributionService (routes/document-distribution.js, its only consumer), this is
// shared across routes/contracts.js, routes/allocations.js, and server.js's own
// createRateSnapshot/checkDgPolicy call sites — defined once here and handed out via ctx instead
// of being duplicated per file. Same clean-503-on-unreachable contract as its distribution-service
// counterpart.
async function callContractService(method, urlPath, body) {
  let r;
  try {
    r = await fetch(`${CONTRACT_SERVICE_URL}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${CONTRACT_SERVICE_SECRET}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    const e = new Error("Contract Management Service is unreachable — try again shortly");
    e.status = 503;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `Contract service returned HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// MDM Service (services/mdm/) — carriers/vessels/port_locations/linked_ports/trade_lanes/
// country_trade_lanes/regions/countries/commodities/carrier_agents, selected per-request via the
// app_settings.mdm_source toggle, same shape as Contract Management. This secret must match
// MDM_SERVICE_SECRET in that service's own env.
const MDM_SERVICE_URL = process.env.MDM_SERVICE_URL || "http://localhost:3005";
const MDM_SECRET_DEV_DEFAULT = "cargoDesk-dev-mdm-service-secret-do-not-use-in-prod";
const MDM_SERVICE_SECRET = readSecret("MDM_SERVICE_SECRET", MDM_SECRET_DEV_DEFAULT);
if (MDM_SERVICE_SECRET === MDM_SECRET_DEV_DEFAULT)
  console.warn("⚠  MDM_SERVICE_SECRET not set (checked MDM_SERVICE_SECRET_FILE, then MDM_SERVICE_SECRET) — using insecure dev default. Set it (matching the MDM service's own env) before deploying.");

async function callMdmService(method, urlPath, body) {
  let r;
  try {
    r = await fetch(`${MDM_SERVICE_URL}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${MDM_SERVICE_SECRET}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    const e = new Error("MDM Service is unreachable — try again shortly");
    e.status = 503;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `MDM service returned HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// Screening Service (services/screening/) — sanctions_entries/sanctions_syncs, selected
// per-request via the app_settings.screening_source toggle ('local'|'remote'), same shape as
// contract_source/mdm_source. This secret must match SCREENING_SERVICE_SECRET in that service's
// own env.
const SCREENING_SERVICE_URL = process.env.SCREENING_SERVICE_URL || "http://localhost:3006";
const SCREENING_SECRET_DEV_DEFAULT = "cargoDesk-dev-screening-service-secret-do-not-use-in-prod";
const SCREENING_SERVICE_SECRET = readSecret("SCREENING_SERVICE_SECRET", SCREENING_SECRET_DEV_DEFAULT);
if (SCREENING_SERVICE_SECRET === SCREENING_SECRET_DEV_DEFAULT)
  console.warn("⚠  SCREENING_SERVICE_SECRET not set (checked SCREENING_SERVICE_SECRET_FILE, then SCREENING_SERVICE_SECRET) — using insecure dev default. Set it (matching the screening service's own env) before deploying.");

async function callScreeningService(method, urlPath, body) {
  let r;
  try {
    r = await fetch(`${SCREENING_SERVICE_URL}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${SCREENING_SERVICE_SECRET}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    const e = new Error("Screening Service is unreachable — try again shortly");
    e.status = 503;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `Screening service returned HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// Kanban/Testing Service (services/kanban/) — tickets/ticket_links/test_items/test_case_links/
// kb_projects/kb_versions/kb_columns, selected per-request via the app_settings.kanban_source
// toggle ('local'|'remote'), same shape as contract_source/mdm_source/screening_source. This
// secret must match KANBAN_SERVICE_SECRET in that service's own env.
const KANBAN_SERVICE_URL = process.env.KANBAN_SERVICE_URL || "http://localhost:3007";
const KANBAN_SECRET_DEV_DEFAULT = "cargoDesk-dev-kanban-service-secret-do-not-use-in-prod";
const KANBAN_SERVICE_SECRET = readSecret("KANBAN_SERVICE_SECRET", KANBAN_SECRET_DEV_DEFAULT);
if (KANBAN_SERVICE_SECRET === KANBAN_SECRET_DEV_DEFAULT)
  console.warn("⚠  KANBAN_SERVICE_SECRET not set (checked KANBAN_SERVICE_SECRET_FILE, then KANBAN_SERVICE_SECRET) — using insecure dev default. Set it (matching the kanban service's own env) before deploying.");

async function callKanbanService(method, urlPath, body) {
  let r;
  try {
    r = await fetch(`${KANBAN_SERVICE_URL}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${KANBAN_SERVICE_SECRET}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    const e = new Error("Kanban Service is unreachable — try again shortly");
    e.status = 503;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `Kanban service returned HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// Customer Service (services/customers/) — customers/customer_identifiers/customer_screenings/
// customer_contacts, selected per-request via the app_settings.customer_source toggle
// ('local'|'remote'), same shape as contract_source/mdm_source/screening_source/kanban_source.
// The fifth and final "toggle" extraction (Epic 5 of the Organization Model roadmap, deliberately
// sequenced last). This secret must match CUSTOMER_SERVICE_SECRET in that service's own env.
const CUSTOMER_SERVICE_URL = process.env.CUSTOMER_SERVICE_URL || "http://localhost:3008";
const CUSTOMER_SECRET_DEV_DEFAULT = "cargoDesk-dev-customers-service-secret-do-not-use-in-prod";
const CUSTOMER_SERVICE_SECRET = readSecret("CUSTOMER_SERVICE_SECRET", CUSTOMER_SECRET_DEV_DEFAULT);
if (CUSTOMER_SERVICE_SECRET === CUSTOMER_SECRET_DEV_DEFAULT)
  console.warn("⚠  CUSTOMER_SERVICE_SECRET not set (checked CUSTOMER_SERVICE_SECRET_FILE, then CUSTOMER_SERVICE_SECRET) — using insecure dev default. Set it (matching the customers service's own env) before deploying.");

async function callCustomerService(method, urlPath, body) {
  let r;
  try {
    r = await fetch(`${CUSTOMER_SERVICE_URL}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${CUSTOMER_SERVICE_SECRET}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    const e = new Error("Customer Service is unreachable — try again shortly");
    e.status = 503;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `Customer service returned HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// Postgres migration (ARCHITECTURE.md §13) — same dual-backend driver shape as every extracted
// microservice's own lib/db.js. Real `pg` when DATABASE_URL is set; an embedded @electric-sql/
// pglite instance otherwise (local dev/test), persisted to pgdata/ at the repo root. The old
// zero-script "copy db/cargodesk.sample.db on first boot" mechanism is retired along with
// node:sqlite — MDM reference-data seeding for a fresh Postgres install goes through the same
// `npm run seed` path as any subsequent reseed (scripts/import-mdm-data.js), not an automatic
// file copy that no longer makes sense once the file isn't a SQLite database.
const { query, transaction, close: closeDb } = require("./lib/db");
const { initSchema } = require("./lib/schema");

const app = express();

// Crash-safety net, part 1: every route file in this codebase registers handlers as plain
// `app.get/post/put/patch/delete(path, ...middleware, async (req,res) => {...})` with no
// try/catch — a thrown error (a bad enum value hitting a CHECK constraint, `undefined` bound
// into a node:sqlite statement, a null-property access) becomes a rejected promise Express 4
// never catches, which by default terminates the whole process (confirmed live: a single
// malformed request killed the entire API for every user). Rather than touch ~40 route files,
// patch the registration methods once, here, before any route is registered — every handler
// passed to app.get/post/put/patch/delete from this point on is wrapped so a thrown/rejected
// error is forwarded to next(err) instead of crashing the process. Route files are completely
// unaware this exists and need no changes.
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

// Crash-safety net, part 2: a final backstop for errors thrown OUTSIDE an HTTP request entirely
// (the hourly ops-automation sweep, the AIS listener's message handlers, WS frame handlers,
// scheduled OFAC/CSL syncs) — wrapAsyncHandler above only covers Express route handlers. Node's
// own default for either event is to crash the process; logging and continuing trades a small
// risk of running past a corrupted in-memory state for the much larger, already-demonstrated risk
// of one bad event taking the whole API down for every user. Route-level errors should already be
// caught by wrapAsyncHandler + the error middleware below and never reach here.
process.on("unhandledRejection", (reason) => {
  console.error("⚠ Unhandled promise rejection (process kept alive):", reason);
});
process.on("uncaughtException", (e) => {
  console.error("⚠ Uncaught exception (process kept alive):", e);
});

// Graceful shutdown — closes the DB connection cleanly before exiting. Matters a great deal
// under the embedded pglite backend specifically: a forceful kill (SIGKILL, or Windows
// `taskkill /F` against a detached process — the only option it offers) can corrupt pglite's WAL
// beyond its own crash-recovery ability ("PANIC: could not locate a valid checkpoint record",
// confirmed directly — real Postgres's pg_resetwal can repair it after the fact, but there's no
// equivalent tool bundled with pglite). SIGTERM is also how real deployments (Docker, systemd,
// most orchestrators) actually stop this process, so this isn't just a local-dev nicety.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n⚓  ${signal} received, shutting down gracefully...`);
  httpServer.close(() => {});
  try { await closeDb(); } catch (e) { console.error("Error closing database:", e.message); }
  process.exit(0);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Dev-only escape hatch for the same graceful shutdown above, reachable over HTTP instead of a
// process signal. Needed because Windows has no way to deliver a real, catchable signal to a
// detached/background process from another process — `taskkill` against one always reports
// "can only be terminated forcefully," and Node's own cross-process `process.kill(pid, 'SIGINT')`
// silently just force-kills on Windows too (confirmed directly) — so SIGINT/SIGTERM above can
// only ever be exercised by Ctrl+C on a process's own attached console, never scripted. This
// route gives local tooling a real way to stop the process cleanly either way. Inert outside
// development (checked first, before the loopback check, so it fails the same way regardless of
// which guard would have caught it) and only ever answers on the loopback interface.
if (process.env.NODE_ENV !== "production") {
  app.post("/internal/dev/shutdown", (req, res) => {
    const ip = req.socket.remoteAddress || "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) return res.status(403).end();
    res.json({ ok: true });
    gracefulShutdown("HTTP /internal/dev/shutdown");
  });
}

app.use(express.json({ limit: "25mb" }));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2,8).toUpperCase();
const ok  = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });
const isUniqueViolation = e => e?.code === "23505";
// First place in the codebase validating a free-typed lat/lng pair — port_locations' own
// latitude/longitude is trusted/curated import data, never user-typed, so nothing like this
// existed before. Per-field, not both-or-neither: cell-level onBlur-flush editing can legitimately
// save one of the pair a moment before the other is typed.
const validCoord = (v, min, max) => v === null || v === undefined || v === ''
  ? true : Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max;

// ─── Schema ───────────────────────────────────────────────────────────────────
// Full Postgres DDL lives in lib/schema.js's initSchema() (93 tables, translated from the live
// SQLite database's own sqlite_master as ground truth — see ARCHITECTURE.md §13). The ~1,600
// lines this used to be (a base CREATE TABLE block + a ~150-statement ADD-COLUMN migrations array
// + several guarded create-copy-swap rebuilds for constraints SQLite can't ALTER around) are gone
// entirely: Postgres's initSchema() already creates every table in its final shape directly, and
// every guarded rebuild (shipment_schedules' nullable owner, the carrier_agents restructure, the
// carrier_eadapter_configs per-office rescoping) is superseded the same way every prior phase's
// guarded rebuilds were — the final shape is just the schema now. A handful of one-time DATA
// backfills (contract_container_types/imdg_classes from contracts' old JSON columns, sailing_legs
// from schedule_legs) only ever mattered for rows already present in the legacy SQLite database
// and have nothing to act on in a fresh Postgres install — dropped rather than ported.
let schemaReadyPromise = initSchema(query).catch(e => {
  console.error("Failed to initialize database schema:", e);
  process.exit(1);
});

// Always empty now — initSchema() either fully succeeds or crashes the boot via the catch
// above, unlike the old migrations array's per-statement try/catch loop (which tolerated the
// expected "duplicate column" case on every restart and collected only genuine failures here
// for GET /api/health to surface). Kept so that route's response shape is unchanged.
const migrationFailures = [];


const UPLOADS_DIR = path.join(__dirname, "uploads", "documents");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Port → trade lane index (for access-scope filtering + tradeLane display) ─
// Read synchronously on every shipment mapped (mapShipment, matchesScopeItem) — this MUST stay
// an in-memory cache, never a live per-call fetch, in either mdm_source mode. 'remote' mode
// rebuilds it from the MDM Service's one bulk GET /internal/port-lanes-index instead of the local
// 4-table JOIN; the trigger points (after a country_trade_lanes-mutating route) are unchanged.
const portLanesMap = {};
const PORT_LANES_SQL = `
  SELECT DISTINCT pl.unlocode, tl.code AS lane_code
  FROM port_locations pl
  JOIN countries c ON c.iso2 = pl.country_code
  JOIN country_trade_lanes ctl ON ctl.iso2 = c.iso2
  JOIN trade_lanes tl ON tl.code = ctl.lane_code
`;
async function rebuildPortLanesMap() {
  try {
    const plRows = ((await getSettings()).mdm_source || "local") === "remote"
      ? await callMdmService("GET", "/internal/port-lanes-index")
      : await query(PORT_LANES_SQL);
    for (const key of Object.keys(portLanesMap)) delete portLanesMap[key];
    for (const r of plRows) {
      if (!portLanesMap[r.unlocode]) portLanesMap[r.unlocode] = new Set();
      portLanesMap[r.unlocode].add(r.lane_code);
    }
    console.log(`  ✔ Port→lane index rebuilt for ${Object.keys(portLanesMap).length} ports`);
  } catch (e) {
    console.warn("  ⚠ Port→lane index failed:", e.message);
  }
}

// ─── Port → country index (for country-code access filtering) ─────────────────
// Deliberately built ONCE at boot and never refreshed thereafter, in both modes — a pre-existing
// staleness characteristic (a port's country_code changing via PUT doesn't reach this map until
// restart) that this cut preserves rather than fixes. 'remote' mode does one bulk GET
// /internal/port-country-map instead of the local read.
const portCountryMap = {};
async function rebuildPortCountryMap() {
  try {
    const pcRows = ((await getSettings()).mdm_source || "local") === "remote"
      ? await callMdmService("GET", "/internal/port-country-map")
      : await query("SELECT unlocode, country_code FROM port_locations WHERE country_code IS NOT NULL AND country_code != ''");
    for (const r of pcRows) portCountryMap[r.unlocode] = r.country_code;
    console.log(`  ✔ Port→country map built for ${Object.keys(portCountryMap).length} ports`);
  } catch (e) {
    console.warn("  ⚠ Port→country map failed:", e.message);
  }
}

// Pre-declared here so broadcastMessage / recomputeSpaceBadge (defined below) can close over it;
// the WebSocket handler in this same file populates it after the server starts.
const shipmentSubs = new Map();

// ─── Backfill user roles array ────────────────────────────────────────────────
// Not purely historical: seedAdmin/seedTestFixtureAdmin below only ever set the singular `role`
// column, never `roles` — every freshly-seeded account needs this to run right after, every boot.
async function backfillUserRoles() {
  try {
    const toUpdate = await query("SELECT id, role FROM users WHERE roles IS NULL OR roles = ''");
    for (const u of toUpdate) {
      await query("UPDATE users SET roles = $1 WHERE id = $2", [JSON.stringify([u.role || 'viewer']), u.id]);
    }
    if (toUpdate.length) console.log(`  ✔ Backfilled roles[] for ${toUpdate.length} user(s)`);
  } catch (e) { console.warn("  ⚠ User roles backfill:", e.message); }
}

// ─── Seed admin user ──────────────────────────────────────────────────────────

// Was hardcoded to the maintainer's own personal email/name — harmless for a single-operator
// local dev DB, but wrong for anyone else's fresh clone (a stranger self-hosting this repo has
// no way to know or use that login) and stale against what README.md/CLAUDE.md already
// documented as "the" default. Now reads ADMIN_EMAIL/ADMIN_PASSWORD if set (e.g. in .env),
// falling back to the generic default the docs describe — same disclosed-insecure-default
// tradeoff as JWT_SECRET etc., logged loudly so it's never mistaken for a real credential.
// Named (not an anonymous IIFE) so the admin "Reset Demo Data" panel can re-invoke this exact
// same bootstrap after wiping the users table — the database ends up in exactly the state a
// truly fresh boot would produce, not a bespoke new one.
async function seedAdmin() {
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@cargodesk.com";
  const TEMP_PW    = process.env.ADMIN_PASSWORD || "admin123";
  const [exists] = await query("SELECT id FROM users WHERE email = $1", [ADMIN_EMAIL]);
  if (!exists) {
    await query(
      "INSERT INTO users (id, email, name, password_hash, role, is_active, created_at) VALUES ($1, $2, $3, $4, 'admin', TRUE, now()::text)",
      [`USR-${uid()}`, ADMIN_EMAIL, "Admin", bcrypt.hashSync(TEMP_PW, 10)]
    );
    console.log(`\n⚓  Admin user created: ${ADMIN_EMAIL}`);
    console.log(`   Temporary password : ${TEMP_PW}`);
    console.log(`   Change it via the User Management panel.\n`);
  }
}

// Test-fixture admin — every one of the ~30 backend test files, both Cypress suites, and this
// session's own CDP verification scripts all hardcode this exact account as a documented
// prerequisite ("Admin account: claudeagent@localhost / TestFixture!2026Zq", see any
// tests/*.test.js file header) — but nothing ever actually created it. It only ever existed
// because this project's own long-lived local cargodesk.db had it created manually at some
// point; a genuinely fresh database (every CI run, always) had no way to reproduce it. This is
// why `npm test`/Cypress have never actually passed in CI even after `npm ci` itself started
// working again — confirmed directly: CI's first real failure past the dependency fix was
// `Fatal: Login failed (401)` on the very first test file. Idempotent and unconditional, same
// as seedAdmin() above — same disclosed-insecure-default tradeoff, since it's a fixed, publicly
// documented password purely for automated verification, never meant to gate anything real.
async function seedTestFixtureAdmin() {
  const EMAIL = "claudeagent@localhost";
  const PW    = "TestFixture!2026Zq";
  const [exists] = await query("SELECT id FROM users WHERE email = $1", [EMAIL]);
  if (!exists) {
    await query(
      "INSERT INTO users (id, email, name, password_hash, role, is_active, created_at) VALUES ($1, $2, $3, $4, 'admin', TRUE, now()::text)",
      [`USR-${uid()}`, EMAIL, "Test Fixture Admin", bcrypt.hashSync(PW, 10)]
    );
    console.log(`⚓  Test-fixture admin created: ${EMAIL} (used by the automated test suite)`);
  }
}

// ─── Seed document-signing certificate ────────────────────────────────────────
// Pure JS (node-forge) — safe to run unconditionally every boot, unlike the browser this
// cert will eventually be used alongside for rendering, which only needs to resolve lazily
// at render time so a machine with no browser installed yet still starts up fine.

async function seedSigningCert() {
  try {
    const [exists] = await query("SELECT id FROM org_signing_certs WHERE status = 'active'");
    if (exists) return;
    const cert = generateSelfSignedSigningCert();
    await query(`INSERT INTO org_signing_certs
      (id, cert_pem, private_key_pem, p12_base64, p12_passphrase, fingerprint_sha256, subject, not_before, not_after, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', now()::text)`,
      [`CERT-${uid()}`, cert.certPem, cert.privateKeyPem, cert.p12Base64, cert.p12Passphrase,
        cert.fingerprintSha256, cert.subject, cert.notBefore, cert.notAfter]);
    console.log(`  ✔ Document-signing certificate generated (fingerprint ${cert.fingerprintSha256.slice(0, 16)}...)`);
  } catch (e) { console.warn("  ⚠ Document-signing cert bootstrap:", e.message); }
}

// ─── Boot sequence ──────────────────────────────────────────────────────────
// Every seed/bootstrap step above needs the schema to exist first, and each other needs to run
// in this order (roles backfill after the two account seeds create rows that need it); chained
// onto schemaReadyPromise itself so a later `await schemaReadyPromise` (nothing currently needs
// to) would see every one of these settle too. rebuildPortLanesMap/rebuildPortCountryMap don't
// gate anything else, so they're fired off after but not folded into the chain — a failure there
// already just warns (see their own try/catch), same as before this migration.
schemaReadyPromise = schemaReadyPromise
  .then(() => seedAdmin())
  .then(() => seedTestFixtureAdmin())
  .then(() => backfillUserRoles())
  .then(() => seedSigningCert());
schemaReadyPromise.then(() => { rebuildPortLanesMap(); rebuildPortCountryMap(); }).catch(() => {});

// ─── App Settings ─────────────────────────────────────────────────────────────

// Async-ified ahead of the eventual Postgres driver swap (ARCHITECTURE.md §13) — same standalone
// prerequisite as logEntityEvent above. Every one of its 58 real call sites (excluding
// services/screening/server.js's own unrelated, already-async, same-named local function) was
// converted to `await` it and its enclosing function made `async`.
async function getSettings() {
  // idleTimeoutMinutes comes from config/app-settings.yaml (lib/staticConfig.js), not the
  // app_settings table — deliberately static/code-deploy config, not a runtime Settings toggle.
  // Merged into the same flat response so the frontend needs no second fetch for it.
  try {
    const rows = await query("SELECT key, value FROM app_settings");
    const dbSettings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return { ...dbSettings, idleTimeoutMinutes: String(staticConfig.session.idleTimeoutMinutes) };
  } catch { return { idleTimeoutMinutes: String(staticConfig.session.idleTimeoutMinutes) }; }
}

// Seed defaults (INSERT OR IGNORE — never overwrite saved user choices)
const SETTING_DEFAULTS = {
  api_fx_enabled:             'true',
  api_fx_interval_value:      '1',
  api_fx_interval_unit:       'days',
  api_weather_enabled:        'true',
  api_weather_interval_value: '1',
  api_weather_interval_unit:  'days',
  api_ofac_enabled:           'true',
  api_ofac_interval_value:    '1',
  api_ofac_interval_unit:     'weeks',
  // Multi-list denied-party screening beyond OFAC SDN — BIS Denied Persons/Entity/Unverified/
  // Military End User Lists, State Dept ITAR Debarred + Nonproliferation Sanctions, and 5 more
  // OFAC-family lists. Defaults on, same posture as OFAC itself (see api_ofac_enabled above) —
  // narrower screening is never the safer default for a compliance feature.
  api_csl_enabled:            'true',
  api_csl_interval_value:     '1',
  api_csl_interval_unit:      'weeks',
  finance_view_enabled:       'true',
  api_ws_enabled:             'true',
  api_shipments_enabled:      'true',
  api_contracts_enabled:      'true',
  api_customers_enabled:      'true',
  api_carriers_enabled:       'true',
  api_vessels_enabled:        'true',
  api_ports_enabled:          'true',
  api_sysmsg_enabled:         'true',
  ai_agent_enabled:           '0',
  ai_endpoint:                '',
  ai_model:                   'claude-haiku-4-5-20251001',
  ai_api_key:                 '',
  ai_system_prompt:           '',
  // 'local' (default) = the monolith's own in-process contracts/contract_legs/contract_rates/
  // contract_routings tables, exactly as today. 'remote' = the standalone Contract Management
  // Service (services/contract-management/, see CONTRACT_SERVICE_URL above). A one-way cutover
  // lever, not a live bidirectional sync — see routes/contracts.js's callContractService callers.
  contract_source:            'local',
  // 'local' (default) = the monolith's own in-process carriers/vessels/port_locations/
  // linked_ports/trade_lanes/country_trade_lanes/regions/countries/commodities/carrier_agents
  // tables, exactly as today. 'remote' = the standalone MDM Service (services/mdm/, see
  // MDM_SERVICE_URL above). Same one-way-cutover-lever shape as contract_source.
  mdm_source:                 'local',
  // Same one-way cutover lever as contract_source/mdm_source above, for the Screening Service
  // (services/screening/) — sanctions_entries/sanctions_syncs.
  screening_source:           'local',
  // Same one-way cutover lever as the three above, for the Kanban/Testing Service
  // (services/kanban/) — tickets/ticket_links/test_items/test_case_links/kb_projects/
  // kb_versions/kb_columns.
  kanban_source:              'local',
  // Same one-way cutover lever as the four above, for the Customer Service (services/customers/)
  // — customers/customer_identifiers/customer_screenings/customer_contacts. customer_documents
  // and customer_roles are deliberately NOT part of this toggle — see ARCHITECTURE.md §8.1's
  // "Customer-specific notes" for why.
  customer_source:            'local',
  // Freight Audit & Payment — a carrier invoice line whose |variance| exceeds this percentage of
  // the expected (contracted/accrued) amount is flagged 'variance' instead of auto-'matched'.
  // One flat global tolerance, not per-carrier/per-charge-type rules — the configurable-rule-
  // library depth real FAP vendors build is deliberately out of scope for this pass.
  fap_variance_tolerance_pct: '2',
  // Reports (routes/reports.js) — a region/country/carrier whose GP% falls below this is
  // flagged and sorted to the top of the list, so "where are we losing money" is a glance, not
  // a scan. '' (not '0') means unset/no target — a real 0% target is a legitimate (if unusual)
  // choice and must stay distinguishable from "nobody's configured this yet". One flat global
  // number, not per-lane/per-region targets — same simplification fap_variance_tolerance_pct
  // above already makes for the identical reason; a real per-region target scheme is a
  // meaningfully bigger feature (needs its own table + management UI), not a v1 default.
  gp_target_pct: '',
  // The following 21 keys existed in the old SQLite migrations array's own INSERT OR IGNORE
  // defaults but were missed when SETTING_DEFAULTS was first ported over during the server.js
  // core conversion — caught live via the full test-suite pass (container-packages.test.js's own
  // "dg_compliance_* keys are seeded" assertion has nothing to find on a genuinely fresh
  // database). Restored verbatim from that array rather than re-guessed.
  login_max_attempts:     '5',
  login_lockout_minutes:  '30',
  jwt_lifetime_hours:     '8',
  password_expiry_days:   '90',
  sso_enabled:            '0',
  sso_tenant_id:          '',
  sso_client_id:          '',
  sso_client_secret:      '',
  sso_redirect_uri:       '',
  sso_default_role:       'operator',
  sso_frontend_url:       'http://localhost:5173',
  shipment_sidebar_order: '[]',
  dg_compliance_contact_name: '',
  dg_compliance_phone:        '',
  dg_compliance_email:        '',
  dg_compliance_address:      '',
  demo_schedules_enabled: 'true',
  api_ais_enabled:        'false',
  ais_provider:           'aisstream',
  ais_api_key:            '',
  api_eadapter_enabled:   'true',
};
async function seedSettingDefaults() {
  await transaction(async (tx) => {
    for (const [k, v] of Object.entries(SETTING_DEFAULTS))
      await tx.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [k, v]);
  });
}
schemaReadyPromise = schemaReadyPromise.then(() => seedSettingDefaults());

// Default rows for four admin-maintained registries — carried over from the old SQLite
// migrations array's own hardcoded INSERT OR IGNORE statements (pack/container type defs,
// duty-rate chapters, invoice status reason codes), which initSchema() deliberately doesn't
// reproduce (it only ever creates table STRUCTURE, never seed DATA). Missed during the
// server.js core conversion — caught live via the full test-suite pass, since
// tests/container-packages.test.js's "seeded defaults present" assertion has nothing to find on
// a genuinely fresh database. ON CONFLICT DO NOTHING — never overwrites an admin's own edits to
// these same rows (id-conflict, matching the original's INSERT OR IGNORE semantics exactly).
async function seedRegistryDefaults() {
  await transaction(async (tx) => {
    const packTypes = [
      ['ptd-pallet', 'PALLET', 'Pallet', '🟫', 10],
      ['ptd-carton', 'CARTON', 'Carton', '📦', 20],
      ['ptd-case', 'CASE', 'Case', '🗄️', 30],
      ['ptd-crate', 'CRATE', 'Crate', '🪵', 40],
      ['ptd-drum', 'DRUM', 'Drum', '🛢️', 50],
      ['ptd-box', 'BOX', 'Box', '📦', 60],
      ['ptd-bag', 'BAG', 'Bag', '🛍️', 70],
      ['ptd-bundle', 'BUNDLE', 'Bundle', '🎋', 80],
      ['ptd-other', 'OTHER', 'Other', '📄', 90],
    ];
    const now = new Date().toISOString();
    for (const [id, code, label, icon, sortOrder] of packTypes) {
      await tx.query(
        "INSERT INTO pack_type_definitions (id,code,label,icon,sort_order,is_active,created_at) VALUES ($1,$2,$3,$4,$5,TRUE,$6) ON CONFLICT (id) DO NOTHING",
        [id, code, label, icon, sortOrder, now]
      );
    }

    const containerTypes = [
      ['ctd-20dc', '20DC', '20', 'DC', 1, '20ft Dry Container', 'Standard dry cargo — general goods, non-temperature-sensitive', 10],
      ['ctd-40dc', '40DC', '40', 'DC', 2, '40ft Dry Container', 'Standard dry cargo — general goods, non-temperature-sensitive', 20],
      ['ctd-40hc', '40HC', '40', 'HC', 2, '40ft High Cube', 'Extra interior height (9\'6") for voluminous or tall cargo', 30],
      ['ctd-20rf', '20RF', '20', 'RF', 1, '20ft Reefer', 'Temperature-controlled — food, pharma, cold-chain cargo', 40],
      ['ctd-40rf', '40RF', '40', 'RF', 2, '40ft Reefer', 'Temperature-controlled — food, pharma, cold-chain cargo', 50],
      ['ctd-20ot', '20OT', '20', 'OT', 1, '20ft Open Top', 'Removable roof — machinery, lumber, crane-loaded cargo', 60],
      ['ctd-40ot', '40OT', '40', 'OT', 2, '40ft Open Top', 'Removable roof — machinery, lumber, crane-loaded cargo', 70],
      ['ctd-20fr', '20FR', '20', 'FR', 1, '20ft Flat Rack', 'Collapsible ends — heavy machinery, vehicles, oversized loads', 80],
      ['ctd-40fr', '40FR', '40', 'FR', 2, '40ft Flat Rack', 'Collapsible ends — heavy machinery, vehicles, oversized loads', 90],
      ['ctd-20tk', '20TK', '20', 'TK', 1, '20ft Tank', 'Liquid bulk — chemicals, food-grade liquids, petroleum products', 100],
      ['ctd-40tk', '40TK', '40', 'TK', 2, '40ft Tank', 'Liquid bulk — chemicals, food-grade liquids, petroleum products', 110],
    ];
    for (const [id, code, size, type, teu, label, description, sortOrder] of containerTypes) {
      await tx.query(
        "INSERT INTO container_type_definitions (id,code,size,type,teu,label,description,sort_order,is_active,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9) ON CONFLICT (id) DO NOTHING",
        [id, code, size, type, teu, label, description, sortOrder, now]
      );
    }

    const dutyChapters = [
      ['84', 'Machinery & mechanical appliances', 2.5],
      ['85', 'Electrical machinery & electronics', 2.6],
      ['61', 'Apparel, knitted or crocheted', 16.0],
      ['62', 'Apparel, not knitted or crocheted', 16.0],
      ['64', 'Footwear', 11.0],
      ['94', 'Furniture & lighting', 0.0],
      ['39', 'Plastics & articles thereof', 5.0],
      ['73', 'Articles of iron or steel', 3.0],
      ['87', 'Vehicles & parts', 2.5],
      ['95', 'Toys, games & sports equipment', 0.0],
      ['22', 'Beverages & spirits', 3.0],
      ['09', 'Coffee, tea, spices', 0.0],
      ['42', 'Leather goods, bags & luggage', 8.0],
    ];
    for (const [hsChapter, label, ratePct] of dutyChapters) {
      await tx.query(
        "INSERT INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (hs_chapter) DO NOTHING",
        [hsChapter, label, ratePct, now]
      );
    }

    const reasonCodes = [
      ['IRC-END-OF-MONTH', 'END_OF_MONTH_TERMS', 'Customer pays on a fixed end-of-month cycle — expected once their cycle closes, not within standard terms'],
      ['IRC-DISPUTE', 'DISPUTE', 'Customer disputes the invoice amount or line items'],
      ['IRC-PENDING-DOCS', 'PENDING_DOCS', 'Awaiting supporting documentation before the customer will process payment'],
      ['IRC-INTERNAL-DELAY', 'INTERNAL_DELAY', 'Payment confirmed by the customer, not yet reconciled internally'],
      ['IRC-OTHER', 'OTHER', 'Other — see description'],
    ];
    for (const [id, code, label] of reasonCodes) {
      await tx.query(
        "INSERT INTO invoice_status_reason_codes (id,code,label,is_active,created_at) VALUES ($1,$2,$3,TRUE,$4) ON CONFLICT (id) DO NOTHING",
        [id, code, label, now]
      );
    }
  });
}
schemaReadyPromise = schemaReadyPromise.then(() => seedRegistryDefaults());

// ─── Sanctions helpers ────────────────────────────────────────────────────────

// OFAC-embargoed country codes (2-letter ISO, extracted from port UNLOCODE prefix)
const EMBARGOED_COUNTRIES = new Set([
  'CU', // Cuba
  'IR', // Iran
  'KP', // North Korea (DPRK)
  'SY', // Syria
  'RU', // Russia
  'BY', // Belarus
  'MM', // Myanmar
  'ZW', // Zimbabwe
  'SS', // South Sudan
  'CF', // Central African Republic
  'LY', // Libya
  'SO', // Somalia
  'YE', // Yemen
  'VE', // Venezuela
  'SD', // Sudan
  'ER', // Eritrea
]);

const normSanctionName = s =>
  (s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

// In-memory index: normalized name/alias → entry metadata
const sanctionsMap = new Map();

// Bug fix (found auditing this for the Screening Service extraction): this used to do
// `sanctionsMap = new Map()` — a REASSIGNMENT of the module-level variable, not an in-place
// mutation. ctx.sanctionsMap is captured once, by value, when the ctx object literal is built;
// routes/customers.js destructures it once at route-registration time. Any reload after boot (a
// manual sync, a CSL sync, a CSV import, either scheduled timer) reassigned this variable to a
// brand-new Map — screenShipmentById (defined here, closes over the variable directly) always
// saw the fresh one, but routes/customers.js's own captured reference stayed frozen at whatever
// the map was at ctx-build time forever, silently never seeing a later reload. screenCustomer()/
// GET /api/customers/:id/sanctions-check were affected; screenShipmentById was not. Fixed by
// mutating the existing Map in place (.clear() + refill) so every already-captured reference,
// however it was obtained, stays valid across every future reload — a prerequisite for the new
// remote-mode poll-refresh below, which would otherwise "work" for screenShipmentById and
// silently never reach screenCustomer, worse than today's already-rare bug.
async function loadSanctionsIndex() {
  let rows;
  if (((await getSettings()).screening_source || 'local') === 'remote') {
    try { rows = await callScreeningService("GET", "/internal/sanctions/entries/export"); }
    catch (e) { console.warn("  ⚠ Sanctions index reload from Screening Service failed:", e.message); return; }
  } else {
    rows = await query("SELECT source, entity_name, entity_type, program, aliases_norm FROM sanctions_entries");
  }
  sanctionsMap.clear();
  for (const r of rows) {
    const meta = { entityName: r.entity_name, entityType: r.entity_type, program: r.program, source: r.source };
    sanctionsMap.set(normSanctionName(r.entity_name), meta);
    try {
      for (const alias of JSON.parse(r.aliases_norm || '[]')) {
        if (!sanctionsMap.has(alias)) sanctionsMap.set(alias, meta);
      }
    } catch {}
  }
}
schemaReadyPromise.then(() => loadSanctionsIndex()).catch(() => {}); // internal try/catch already logs, this just guards the unhandled-rejection case

// ─── OFAC SDN sync (extracted so route and scheduler both call it) ─────────────

function httpsGetFollowRedirects(url, depth = 0, reqHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("Too many redirects"));
    const opts = { rejectUnauthorized: false, headers: reqHeaders };
    https.get(url, opts, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = r.headers.location.startsWith("http")
          ? r.headers.location
          : new URL(r.headers.location, url).href;
        return resolve(httpsGetFollowRedirects(next, depth + 1, reqHeaders));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error(`OFAC returned HTTP ${r.statusCode}`)); }
      resolve(r);
    }).on("error", reject);
  });
}

async function syncOfacSdn() {
  if (((await getSettings()).screening_source || 'local') === 'remote') {
    const r = await callScreeningService("POST", "/internal/sanctions/sync");
    await loadSanctionsIndex();
    await rescreenActiveShipments();
    return r;
  }
  // Treasury.gov's own WAF rejects a bare Node https.get with no User-Agent/Accept headers
  // (`https.get` sends neither by default) as bot traffic — a real 403, not a CargoDesk
  // permission gate (this route has none, see routes/sanctions.js's own comment). A plain
  // browser-shaped header set is enough to pass.
  const resp = await httpsGetFollowRedirects("https://www.treasury.gov/ofac/downloads/sdn.xml", 0, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "application/xml,text/xml,*/*",
  });
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
    const e      = block.substring(0, end);
    const get    = tag => { const m = e.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)); return m ? m[1].trim() : ""; };
    const getAll = tag => [...e.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map(m => m[1].trim());
    const last   = get("lastName");
    if (!last) continue;
    const first      = get("firstName");
    const name       = first ? `${first} ${last}` : last;
    const aliasNorms = [];
    for (const ab of [...e.matchAll(/<aka>([\s\S]*?)<\/aka>/g)]) {
      const al = (ab[1].match(/<lastName>([^<]*)<\/lastName>/) || [])[1] || "";
      const af = (ab[1].match(/<firstName>([^<]*)<\/firstName>/) || [])[1] || "";
      const a  = af ? `${af} ${al}`.trim() : al.trim();
      if (a) aliasNorms.push(normSanctionName(a));
    }
    entries.push({ refId: get("uid"), name, sdnType: get("sdnType"), programs: getAll("program").join("; "), aliasNorms });
  }

  await transaction(async (tx) => {
    await tx.query("DELETE FROM sanctions_entries WHERE source='OFAC-SDN'");
    for (const e of entries)
      await tx.query(
        `INSERT INTO sanctions_entries (id,source,ref_id,entity_name,entity_name_norm,entity_type,program,aliases_norm)
         VALUES ($1,'OFAC-SDN',$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET source='OFAC-SDN', ref_id=$2, entity_name=$3, entity_name_norm=$4, entity_type=$5, program=$6, aliases_norm=$7`,
        [`OFAC-${e.refId}`, e.refId, e.name, normSanctionName(e.name), e.sdnType, e.programs, JSON.stringify(e.aliasNorms)]);
  });

  const now = new Date().toISOString();
  await query(
    `INSERT INTO sanctions_syncs (source,synced_at,entry_count) VALUES ('OFAC-SDN',$1,$2)
     ON CONFLICT (source) DO UPDATE SET synced_at=$1, entry_count=$2`,
    [now, entries.length]);
  await loadSanctionsIndex();
  await rescreenActiveShipments();
  return { source: "OFAC-SDN", syncedAt: now, entries: entries.length };
}

// ─── Consolidated Screening List sync (multi-list denied-party screening) ─────
// The US government's own Consolidated Screening List (developer.trade.gov, free, no API key)
// bundles 11 lists beyond OFAC's own SDN list into one feed — BIS's Denied Persons/Entity/
// Unverified/Military End User Lists, State Dept's ITAR Debarred (AECA) and Nonproliferation
// Sanctions lists, and 5 more OFAC-family lists beyond SDN (SSI, CAPTA, Non-SDN Menu-Based,
// Non-SDN Chinese Military-Industrial Complex, Palestinian Legislative Council). Screening OFAC
// SDN alone (this app's previous scope) misses all of these — a real compliance program checks
// the full set, not one list. The bulk feed also includes the SDN list itself; those rows are
// filtered out here since syncOfacSdn() above already owns that list under its own 'OFAC-SDN'
// source and sync cadence — this sync is additive to it, not a replacement.
//
// sanctions_entries.source/sanctions_syncs.source were already fully generic columns before this
// (confirmed: only ever written as the literal 'OFAC-SDN' until now) — no schema change needed.
// Every CSL-sourced row's `id` is prefixed 'CSL-' specifically so the delete-then-reinsert below
// can safely scope to "every row this sync owns" without having to enumerate the list names
// themselves, which the government feed could rename or add to over time.
async function syncConsolidatedScreeningList() {
  if (((await getSettings()).screening_source || 'local') === 'remote') {
    const result = await callScreeningService("POST", "/internal/sanctions/sync-csl");
    await loadSanctionsIndex();
    await rescreenActiveShipments();
    return result;
  }
  const r = await fetch("https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.json");
  if (!r.ok) throw new Error(`Consolidated Screening List returned HTTP ${r.status}`);
  const data = await r.json();
  const results = Array.isArray(data.results) ? data.results : [];
  const entries = results.filter(e => e.id && e.name && !/^Specially Designated Nationals/i.test(e.source || ""));

  await transaction(async (tx) => {
    await tx.query("DELETE FROM sanctions_entries WHERE id LIKE 'CSL-%'");
    for (const e of entries)
      await tx.query(
        `INSERT INTO sanctions_entries (id,source,ref_id,entity_name,entity_name_norm,entity_type,program,aliases_norm)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET source=$2, ref_id=$3, entity_name=$4, entity_name_norm=$5, entity_type=$6, program=$7, aliases_norm=$8`,
        [`CSL-${e.id}`, e.source || "Consolidated Screening List", String(e.id), e.name,
         normSanctionName(e.name), e.type || "", (e.programs || []).join("; "),
         JSON.stringify((e.alt_names || []).map(normSanctionName))]);
  });

  const now = new Date().toISOString();
  await query(
    `INSERT INTO sanctions_syncs (source,synced_at,entry_count) VALUES ('CSL',$1,$2)
     ON CONFLICT (source) DO UPDATE SET synced_at=$1, entry_count=$2`,
    [now, entries.length]);
  await loadSanctionsIndex();
  await rescreenActiveShipments();
  return { source: "CSL", syncedAt: now, entries: entries.length };
}

// Organization Model Enhancement Epic 3 — after any sanctions list update (OFAC XML sync, the
// scheduled auto-sync, or a manual CSV import), re-screen every still-relevant shipment so a
// newly-added SDN entry is caught immediately instead of waiting for that shipment to be
// independently edited. Bounded to shipments that aren't Completed/Cancelled — mirrors
// CargoWise's own "rescan on list update" behavior without a full-table sweep of every
// shipment ever created, most of which are no longer operationally relevant. Same
// don't-overwrite-a-compliance-officer's-override guard every other re-screen trigger uses.
async function rescreenActiveShipments() {
  const idRows = await query("SELECT id FROM shipments WHERE status NOT IN ('Completed','Cancelled')");
  for (const { id: shipmentId } of idRows) {
    const [prev] = await query("SELECT result, overridden_at FROM shipment_screenings WHERE shipment_id=$1", [shipmentId]);
    const isOverridden = prev?.result === 'CLEAR' && prev?.overridden_at;
    if (!isOverridden) await screenShipmentById(shipmentId);
  }
}

// Organization Model Enhancement Epic 4 — the shared read-side helper the plan called for:
// given ANY customer id in a parent/child hierarchy, returns every customer id belonging to
// that same tree (root ancestor + all descendants), so a "roll up by parent" report can sum
// figures across a whole group regardless of which member's id the caller started from.
// Deliberately read-side only — the three independent customer-pointer mechanisms (shipment
// fixed FKs, shipment_parties, contracts.named_account_id) keep writing plain denormalized
// customer_id/customer_name pairs exactly as they already do everywhere else in this codebase;
// this doesn't unify or change that convention, it just reads across it for reporting.
// A caller can't know the mode in advance, so this is async unconditionally — the local branch's
// own walk-to-root-then-BFS-down logic is byte-for-byte unchanged from before this function had a
// remote branch at all. Remote does the identical walk server-side via the Customer Service's own
// GET /internal/customers/:id/group (mirrors Kanban's co-located-table-JOIN precedent) — both
// branches return the same root-first array; routes/finance.js's rootOf() depends on that order.
async function resolveCustomerGroup(customerId) {
  if (((await getSettings()).customer_source || "local") === "remote") {
    try {
      const { ids } = await callCustomerService("GET", `/internal/customers/${customerId}/group`);
      return ids;
    } catch { return [customerId]; }
  }
  let root = customerId;
  let current = customerId;
  const walked = new Set();
  while (current) {
    if (walked.has(current)) break; // safety net against a pre-existing cycle in old data
    walked.add(current);
    root = current;
    const [row] = await query("SELECT parent_customer_id FROM customers WHERE id=$1", [current]);
    current = row?.parent_customer_id || null;
  }
  const group = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const id = queue.shift();
    for (const child of await query("SELECT id FROM customers WHERE parent_customer_id=$1", [id])) {
      if (!group.has(child.id)) { group.add(child.id); queue.push(child.id); }
    }
  }
  return [...group];
}

// One shared read helper for the 4 independent credit-hold/over-limit sites (routes/customers.js
// {credit-hold/release, credit-override/approve, credit-overrides/queue, invoice-deadlines/
// overdue}, routes/shipments.js's create-time warning, routes/edi.js's booking-request block,
// routes/shipment-ops.js's findCreditHold/findOverLimitBlock) — one remote shape, not four.
// Both branches return the exact same mapCustomer camelCase shape. References mapCustomer
// (assigned later in this same module, via createMappers) — safe: this function is only ever
// invoked from a request handler, long after the whole module has finished loading.
async function getCustomerRow(id) {
  if (!id) return null;
  if (((await getSettings()).customer_source || "local") === "remote") {
    try { return await callCustomerService("GET", `/internal/customers/${id}`); }
    catch { return null; }
  }
  const [r] = await query("SELECT * FROM customers WHERE id=$1", [id]);
  return r ? mapCustomer(r) : null;
}

// screenShipmentById's own read of a party's customer-level screening result — the match DECISION
// (screenCustomer, routes/customers.js) can never move into the Customer Service, since it depends
// on the monolith-owned sanctionsMap cache; only the already-decided result's WRITE and this READ
// of it can. Local: direct query, unchanged. Remote: the service's own write-only screening record.
async function getCustomerScreeningResult(id) {
  if (!id) return null;
  if (((await getSettings()).customer_source || "local") === "remote") {
    try { return (await callCustomerService("GET", `/internal/customers/${id}/screening`))?.result || null; }
    catch { return null; }
  }
  const [row] = await query("SELECT result FROM customer_screenings WHERE customer_id=$1", [id]);
  return row?.result || null;
}

// ─── OFAC auto-sync scheduler ─────────────────────────────────────────────────

let ofacAutoSyncTimer = null;

// setTimeout is backed by a 32-bit int; anything above ~24.8 days wraps to 1ms.
const MAX_TIMER_MS = 2_000_000_000; // ~23.1 days — safe upper bound

// How often the screening_source='remote' cache-refresh poll below fires — decoupled from the
// actual sync cadence (the Screening Service now owns firing the sync on ITS OWN schedule);
// this just keeps the monolith's own sanctionsMap from lagging too far behind whatever the
// service last synced. Cheap (one bulk GET), so a short interval is fine.
const SCREENING_POLL_MS = 15 * 60 * 1000;

async function scheduleNextOfacSync(retryDelayMs = null) {
  clearTimeout(ofacAutoSyncTimer);
  // 'remote' mode: the Screening Service owns the actual sync schedule now — this timer's only
  // job is to keep the local sanctionsMap cache from drifting, via a plain fixed-interval poll
  // instead of the elaborate "is a sync due" math below, which only makes sense for deciding
  // when to FIRE a sync (a decision this side no longer makes).
  if (((await getSettings()).screening_source || 'local') === 'remote') {
    ofacAutoSyncTimer = setTimeout(() => { loadSanctionsIndex().catch(() => {}); scheduleNextOfacSync(); }, SCREENING_POLL_MS);
    return;
  }
  try {
    const s = await getSettings();
    if (s.api_ofac_enabled !== 'true') return;
    const [lastSync] = await query("SELECT synced_at FROM sanctions_syncs WHERE source='OFAC-SDN'");
    if (!lastSync) return; // Never synced — user must trigger the first one manually

    let delay;
    if (retryDelayMs != null) {
      // After a failed sync: wait the requested retry interval, then try again
      delay = Math.min(MAX_TIMER_MS, retryDelayMs);
    } else {
      const val        = Math.max(1, parseInt(s.api_ofac_interval_value) || 1);
      const unit       = s.api_ofac_interval_unit || 'weeks';
      const msMap      = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const intervalMs = val * (msMap[unit] || msMap.weeks);
      const nextDue    = new Date(lastSync.synced_at).getTime() + intervalMs;
      // Cap so we never exceed 32-bit int; fire early if still waiting, check again then
      delay = Math.min(MAX_TIMER_MS, Math.max(60000, nextDue - Date.now()));
    }

    ofacAutoSyncTimer = setTimeout(async () => {
      // Re-check whether the sync is actually due (handles the >24-day cap case)
      const [ls] = await query("SELECT synced_at FROM sanctions_syncs WHERE source='OFAC-SDN'");
      const freshSettings = await getSettings();
      const sv        = Math.max(1, parseInt(freshSettings.api_ofac_interval_value) || 1);
      const su        = freshSettings.api_ofac_interval_unit || 'weeks';
      const msMap     = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const due       = ls ? new Date(ls.synced_at).getTime() + sv * (msMap[su] || msMap.weeks) : 0;
      if (Date.now() < due) { scheduleNextOfacSync(); return; } // not due yet, reschedule

      console.log("⚓ Auto-syncing OFAC SDN…");
      try {
        const r = await syncOfacSdn();
        console.log(`  ✔ OFAC auto-sync complete: ${r.entries.toLocaleString()} entries`);
        scheduleNextOfacSync();
      } catch (e) {
        console.error("  ✗ OFAC auto-sync failed:", e.message);
        scheduleNextOfacSync(3_600_000); // retry in 1 hour, don't hammer on failure
      }
    }, delay);

    console.log(`  ⏱ OFAC auto-sync scheduled in ${Math.round(delay / 3600000 * 10) / 10}h`);
  } catch {}
}
schemaReadyPromise.then(() => { try { scheduleNextOfacSync(); } catch {} }).catch(() => {});

// Structurally identical to scheduleNextOfacSync above, just for the 'CSL' sync source and its
// own settings keys — kept as an independent copy rather than generalizing the OFAC scheduler
// into a shared multi-source one, since that would mean touching already-working, tested
// scheduling logic for a second call site; same "duplicate rather than risk the working original"
// precedent this codebase already applies elsewhere (dockerSecret.js, per-service mappers, etc.).
let cslAutoSyncTimer = null;

async function scheduleNextCslSync(retryDelayMs = null) {
  clearTimeout(cslAutoSyncTimer);
  // 'remote' mode: same reasoning as scheduleNextOfacSync's own remote branch above — the
  // Screening Service owns the actual sync schedule, this is just a cache-refresh poll.
  if (((await getSettings()).screening_source || 'local') === 'remote') {
    cslAutoSyncTimer = setTimeout(() => { loadSanctionsIndex().catch(() => {}); scheduleNextCslSync(); }, SCREENING_POLL_MS);
    return;
  }
  try {
    const s = await getSettings();
    if (s.api_csl_enabled !== 'true') return;
    const [lastSync] = await query("SELECT synced_at FROM sanctions_syncs WHERE source='CSL'");
    if (!lastSync) return; // Never synced — user must trigger the first one manually

    let delay;
    if (retryDelayMs != null) {
      delay = Math.min(MAX_TIMER_MS, retryDelayMs);
    } else {
      const val        = Math.max(1, parseInt(s.api_csl_interval_value) || 1);
      const unit       = s.api_csl_interval_unit || 'weeks';
      const msMap      = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const intervalMs = val * (msMap[unit] || msMap.weeks);
      const nextDue    = new Date(lastSync.synced_at).getTime() + intervalMs;
      delay = Math.min(MAX_TIMER_MS, Math.max(60000, nextDue - Date.now()));
    }

    cslAutoSyncTimer = setTimeout(async () => {
      const [ls] = await query("SELECT synced_at FROM sanctions_syncs WHERE source='CSL'");
      const freshSettings = await getSettings();
      const sv  = Math.max(1, parseInt(freshSettings.api_csl_interval_value) || 1);
      const su  = freshSettings.api_csl_interval_unit || 'weeks';
      const msMap = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      const due = ls ? new Date(ls.synced_at).getTime() + sv * (msMap[su] || msMap.weeks) : 0;
      if (Date.now() < due) { scheduleNextCslSync(); return; }

      console.log("⚓ Auto-syncing Consolidated Screening List…");
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
schemaReadyPromise.then(() => { try { scheduleNextCslSync(); } catch {} }).catch(() => {});

// Dunning sweep (Story TKT-4TEYT1) — deliberately simpler than the OFAC/CSL schedulers above:
// no "catch up to a due date" logic needed, since runDunningSweep itself already re-evaluates
// what's actually due (per-invoice last_reminder_sent_at + each customer's own cadence) on
// every single run — a plain daily interval is sufficient. Does NOT fire once at boot (unlike
// syncing a sanctions list, sending real customer-facing email on every dev restart would be
// a real surprise) — the first real run is 24h after this process started.
setInterval(() => { runDunningSweep().catch(e => console.error("Dunning sweep failed:", e.message)); }, 24 * 60 * 60 * 1000);
// Scheduled reports (TKT-IXAR9G) — same deliberate choice as the dunning sweep above: no fire-
// at-boot, so a dev restart never sends real report email; the first real run is 24h out.
setInterval(() => { runScheduledReportsSweep().catch(e => console.error("Scheduled reports sweep failed:", e.message)); }, 24 * 60 * 60 * 1000);

async function screenShipmentById(shipmentId) {
  const [s] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
  if (!s) return null;

  const hits = [];

  // Party name screening — Organization Model Enhancement Epic 3 broadened this from just
  // Shipper/Consignee/Principal to all 13 possible party-role slots on a shipment: the 4 fixed
  // columns (adding Notify Party, previously invisible to screening entirely) plus every
  // shipment_parties row (Forwarder, Customs Broker Export/Import, Trucker Pre/On-carriage,
  // Also Notify Party, Bank, Insurance Provider, Agent — 9 more roles that were also previously
  // invisible). `field` uses the exact role strings from FIXED_SHIPMENT_ROLES/
  // ADDITIONAL_PARTY_ROLES so the unified Compliance panel can match a hit back to its slot.
  //
  // Each party also carries a customer_id (where set) — corroborated against customer_screenings
  // ALONGSIDE the direct name-vs-sanctionsMap match, not instead of it. This matters because
  // shipper_name/consignee_name/shipment_parties.customer_name etc. are all denormalized name
  // SNAPSHOTS (this codebase's standing convention — see shipment_parties' own schema comment),
  // frozen at whichever moment that party was assigned. Renaming a customer updates
  // customers.company_name (and re-screens that customer immediately) but does NOT touch any
  // shipment's already-stored copy of the old name — a pure name-match re-screen would stay
  // blind to that rename forever. The customer_id corroboration catches it: customer-level
  // screening always reflects the customer's CURRENT name, independent of what any shipment's
  // own stale copy says.
  const fixedParties = [
    ['Shipper', s.shipper_name, s.shipper_id], ['Consignee', s.consignee_name, s.consignee_id],
    ['Principal', s.principal_name, s.principal_id], ['Notify Party', s.notify_name, s.notify_id],
  ];
  const additionalParties = (await query("SELECT role, customer_name, customer_id FROM shipment_parties WHERE shipment_id=$1", [shipmentId]))
    .map(r => [r.role, r.customer_name, r.customer_id]);
  // Service vendors (truckers, CFS/warehousing operators, ... assigned via "Request Service"
  // on Export/Import Services) were never screened at all — only the 13 party-role slots were.
  // A sanctioned vendor picked as a Loading/Pickup/Delivery/etc. provider was invisible to
  // compliance screening even though it's a real counterparty on the shipment. Cancelled
  // services are excluded (nothing to declare against a withdrawn order).
  const serviceVendors = (await query(
    "SELECT side, service_type, vendor_name, vendor_id FROM shipment_services WHERE shipment_id=$1 AND status != 'Cancelled'", [shipmentId]
  )).map(r => [`${r.side} ${r.service_type} Vendor`, r.vendor_name, r.vendor_id]);
  for (const [field, name, customerId] of [...fixedParties, ...additionalParties, ...serviceVendors]) {
    if (!name || !name.trim()) continue;
    const nameMatch = sanctionsMap.get(normSanctionName(name));
    if (nameMatch) {
      hits.push({ field, value: name, matchedEntry: nameMatch.entityName, program: nameMatch.program, source: nameMatch.source });
      continue;
    }
    const custResult = customerId ? await getCustomerScreeningResult(customerId) : null;
    if (custResult === 'HIT') {
      hits.push({ field, value: name, matchedEntry: `${name} — flagged at the customer level (name on this shipment may be outdated)`, program: 'OFAC-SDN', source: 'customer_screenings' });
    }
  }

  // Country embargo via UNLOCODE prefix (first 2 chars)
  for (const [field, code] of [['POL', s.pol], ['POD', s.pod]]) {
    const cc = (code || '').substring(0, 2).toUpperCase();
    if (cc && EMBARGOED_COUNTRIES.has(cc))
      hits.push({ field, value: code, matchedEntry: `Embargoed country (${cc})`, program: 'Country Embargo', source: 'OFAC' });
  }

  const [prevRow] = await query("SELECT result FROM shipment_screenings WHERE shipment_id=$1", [shipmentId]);
  const result  = hits.length > 0 ? 'HIT' : 'CLEAR';
  const id      = `SCR-${uid()}`;
  const now     = new Date().toISOString();
  await query(
    `INSERT INTO shipment_screenings (id, shipment_id, screened_at, result, hits) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (shipment_id) DO UPDATE SET id=$1, screened_at=$3, result=$4, hits=$5`,
    [id, shipmentId, now, result, JSON.stringify(hits)]);

  if (result === 'HIT' && prevRow?.result !== 'HIT') {
    logEvent(shipmentId, 'COMPLIANCE_HIT', null, null, null, JSON.stringify({ hits }));
  }

  return { id, result, hits, screenedAt: now, overriddenAt: null, overrideReason: null };
}

// ─── FX Rate Cache (frankfurter.app, ECB rates, refreshed every 24 h) ─────────
let fxCache = { rates: {}, ts: 0 };
async function getFxRates() {
  const s        = await getSettings();
  const val      = Math.max(1, parseInt(s.api_fx_interval_value) || 1);
  const unit     = s.api_fx_interval_unit || 'days';
  const msMap    = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
  const ttl      = val * (msMap[unit] || msMap.days);
  if (Date.now() - fxCache.ts < ttl && Object.keys(fxCache.rates).length) return fxCache.rates;
  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=USD");
    const d = await r.json();
    fxCache = { rates: d.rates || {}, ts: Date.now() };
  } catch (e) { console.warn("FX fetch failed:", e.message); }
  return fxCache.rates;
}
async function toUsd(amount, currency) {
  if (!currency || currency === "USD") return roundCents(amount);
  const rates = await getFxRates();
  const rate = rates[currency];
  return rate ? roundCents(amount / rate) : roundCents(amount);
}

// Credit Control's own AR/exposure computation (v0.73.0, TKT-O4DNFX/TKT-AJAEDO) — moved here
// from routes/customers.js (v0.73.1, TKT-GLWMFP) so routes/shipment-ops.js's invoice-generation
// gate can reuse the exact same figures the credit-status endpoint and the trade-lane override
// queue both already show, rather than a second, drifting computation. outstandingAr/
// committedExposure are already USD-equivalent (each line's own amount * exchange_rate at
// posting time), same convention as every other cost-line USD figure in this codebase.
async function computeArExposure(customerId, creditTermsDays) {
  const shipmentIds = (await query(
    "SELECT id FROM shipments WHERE principal_id=$1 OR consignee_id=$1", [customerId]
  )).map(r => r.id);

  let outstandingAr = 0;
  const coveredLineIds = new Set();
  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const todayMs = Date.now();

  if (shipmentIds.length) {
    const placeholders = shipmentIds.map((_, i) => `$${i + 1}`).join(',');
    const docs = await query(
      `SELECT * FROM shipment_documents WHERE shipment_id IN (${placeholders}) AND doc_type IN ('FR01','FR02') AND status='confirmed'`,
      shipmentIds);
    for (const doc of docs) {
      const sourceIds = doc.source_cost_line_ids ? JSON.parse(doc.source_cost_line_ids) : null;
      const lines = sourceIds && sourceIds.length
        ? await query(`SELECT id, amount, exchange_rate FROM shipment_cost_lines WHERE id IN (${sourceIds.map((_, i) => `$${i + 1}`).join(',')})`, sourceIds)
        : await query("SELECT id, amount, exchange_rate FROM shipment_cost_lines WHERE shipment_id=$1 AND type='SELL' AND container_id=$2", [doc.shipment_id, doc.container_id || '']);
      const docTotal = lines.reduce((s, l) => s + l.amount * l.exchange_rate, 0);
      for (const l of lines) coveredLineIds.add(l.id);
      // Mark as Paid (TKT-NQ87D3) — paid_amount is recorded in the same USD-equivalent unit as
      // docTotal itself (never the invoice's own display currency, which can differ per line —
      // see buildFreightInvoiceHtml's multi-currency handling). A partial payment reduces this
      // invoice's own contribution to both outstandingAr and its aging bucket, floored at 0
      // (never negative even if somehow overpaid) — it does NOT reset the aging clock to the
      // payment date; the remainder still ages from the original confirmed_at, matching standard
      // AR treatment (a partial payment shrinks the balance, it doesn't make the debt younger).
      const netOutstanding = Math.max(0, docTotal - (doc.paid_amount || 0));
      outstandingAr += netOutstanding;

      const refDate = doc.confirmed_at || doc.created_at;
      const dueMs = new Date(refDate).getTime() + (creditTermsDays || 0) * 86400000;
      const daysOverdue = Math.floor((todayMs - dueMs) / 86400000);
      if      (daysOverdue <= 0)  aging.current  += netOutstanding;
      else if (daysOverdue <= 30) aging.d1_30    += netOutstanding;
      else if (daysOverdue <= 60) aging.d31_60   += netOutstanding;
      else if (daysOverdue <= 90) aging.d61_90   += netOutstanding;
      else                        aging.d90_plus += netOutstanding;
    }
  }

  let committedExposure = 0;
  if (shipmentIds.length) {
    const placeholders = shipmentIds.map((_, i) => `$${i + 1}`).join(',');
    const sellLines = await query(
      `SELECT id, amount, exchange_rate FROM shipment_cost_lines WHERE shipment_id IN (${placeholders}) AND type='SELL'`,
      shipmentIds);
    for (const l of sellLines) if (!coveredLineIds.has(l.id)) committedExposure += l.amount * l.exchange_rate;
  }

  return {
    outstandingAr: roundCents(outstandingAr),
    committedExposure: roundCents(committedExposure),
    aging: Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, roundCents(v)])),
  };
}

// Row-level amount resolution for one FR01/FR02 doc — same source_cost_line_ids-first, live-
// container-scoped-fallback logic computeArExposure above already uses for AR, factored out so
// both the Billing Performance report (routes/reports.js) and the dunning sweep below share one
// implementation instead of drifting apart.
async function docAmountUsd(doc) {
  const sourceIds = doc.source_cost_line_ids ? JSON.parse(doc.source_cost_line_ids) : null;
  const lines = sourceIds && sourceIds.length
    ? await query(`SELECT amount, exchange_rate FROM shipment_cost_lines WHERE id IN (${sourceIds.map((_, i) => `$${i + 1}`).join(',')})`, sourceIds)
    : await query("SELECT amount, exchange_rate FROM shipment_cost_lines WHERE shipment_id=$1 AND type='SELL' AND container_id=$2", [doc.shipment_id, doc.container_id || '']);
  return roundCents(lines.reduce((s, l) => s + l.amount * l.exchange_rate, 0));
}

// ─── Overdue-invoice reminder sweep (Story TKT-4TEYT1, Epic TKT-KR6ZBT) ───────
// Configurable per-customer, not one fixed schedule — a same-day payer and an end-of-month
// consolidator should never get the same cadence, per direct request. "Is this invoice overdue"
// is already fully answered by the existing credit_terms_days-anchored due-date math (same
// formula computeArExposure's aging and the Billing Performance report's daysOverdue already
// use) — this sweep only adds the separate opt-in/cadence layer: reminder_enabled gates whether
// a customer gets reminders at all (default off), reminder_interval_days controls repeats
// (null/0 = a single reminder, never repeated). Reuses the exact EMO-office-mail machinery the
// manual send-email route already uses — same clean-failure-per-recipient behavior, a customer
// with no configured office mail settings or no email on file is skipped, not a hard error that
// aborts the whole sweep.
async function runDunningSweep() {
  const sent = [];
  const rows = await query(`
    SELECT d.*, s.principal_id, s.principal_name, s.consignee_id, s.consignee_name, s.emo_office_id
    FROM shipment_documents d
    JOIN shipments s ON s.id = d.shipment_id
    WHERE d.doc_type IN ('FR01','FR02') AND d.status='confirmed'
  `);

  const nowMs = Date.now();
  for (const r of rows) {
    const respId = r.principal_id || r.consignee_id || null;
    if (!respId) continue;
    const [cust] = await query("SELECT * FROM customers WHERE id=$1", [respId]);
    if (!cust || !cust.reminder_enabled) continue;

    const amountUsd = await docAmountUsd(r);
    const outstandingUsd = Math.max(0, roundCents(amountUsd - (r.paid_amount || 0)));
    if (outstandingUsd <= 0) continue;

    const refDate = r.confirmed_at || r.created_at;
    const dueMs = new Date(refDate).getTime() + (cust.credit_terms_days || 0) * 86400000;
    const daysOverdue = Math.floor((nowMs - dueMs) / 86400000);
    if (daysOverdue <= 0) continue;

    if (r.last_reminder_sent_at) {
      if (!cust.reminder_interval_days) continue; // no repeat configured — already reminded once
      const daysSinceLast = Math.floor((nowMs - new Date(r.last_reminder_sent_at).getTime()) / 86400000);
      if (daysSinceLast < cust.reminder_interval_days) continue;
    }

    if (!r.emo_office_id) continue; // same EMO-only resolution the manual send-email route uses
    const [mailSettings] = await query("SELECT * FROM office_mail_settings WHERE office_id=$1 AND is_active=TRUE", [r.emo_office_id]);
    if (!mailSettings) continue; // no configured SMTP for this office — skip, don't error the whole sweep
    const [primaryContact] = await query("SELECT email FROM customer_contacts WHERE customer_id=$1 AND is_primary=TRUE", [cust.id]);
    const to = (primaryContact?.email || cust.email || '').trim();
    if (!to) continue;

    try {
      const filePath = path.join(UPLOADS_DIR, r.stored_name);
      const mailOptions = buildMailOptions({
        from: mailSettings.from_address, fromName: mailSettings.from_name,
        to,
        subject: `Payment reminder — invoice ${r.filename} (${daysOverdue}d overdue)`,
        message: `This is an automated reminder that invoice ${r.filename} for ${cust.company_name}, `
          + `totaling $${outstandingUsd.toFixed(2)} outstanding, is ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} past its due date. `
          + `Please arrange payment at your earliest convenience, or contact us if this has already been settled.`,
        ...(fs.existsSync(filePath) ? { attachmentPath: filePath, attachmentFilename: r.filename } : {}),
      });
      await sendViaOffice(query, r.emo_office_id, mailOptions);
      await query("UPDATE shipment_documents SET last_reminder_sent_at=$1 WHERE id=$2", [new Date().toISOString(), r.id]);
      await logEntityEvent('document', r.id, 'REMINDER_SENT', null, null, null,
        JSON.stringify({ shipmentId: r.shipment_id, customerId: cust.id, to, daysOverdue, outstandingUsd }));
      sent.push({ docId: r.id, shipmentId: r.shipment_id, customerId: cust.id, companyName: cust.company_name, daysOverdue, outstandingUsd });
    } catch (e) {
      console.warn(`Dunning reminder failed for ${r.id}:`, e.message);
    }
  }
  return sent;
}

// Scheduled / emailed reports (TKT-IXAR9G) — same daily-tick-re-evaluate-everything shape as
// runDunningSweep just above, for the same reason: last_run_at + each report's own frequency
// already tells us exactly what's due on every run, so there's no need for OFAC/CSL's more
// complex precise-single-timer machinery. report_type is a small dispatch key, deliberately
// narrow this pass (only 'shipments-csv' — the ticket's own cheapest, most representative
// case); ctx.buildShipmentsCsvReport is handed back from routes/export.js at boot, since the
// actual CSV-building logic lives in that file's closure, not here.
async function runScheduledReportsSweep() {
  const sent = [];
  const DUE_DAYS = { daily: 1, weekly: 7, monthly: 30 };
  const reports = await query("SELECT * FROM scheduled_reports WHERE is_active=TRUE");
  const nowMs = Date.now();

  for (const r of reports) {
    const thresholdDays = DUE_DAYS[r.frequency] ?? 7;
    const lastRunMs = r.last_run_at ? new Date(r.last_run_at).getTime() : 0; // never run -> due now
    if ((nowMs - lastRunMs) / 86400000 < thresholdDays) continue;

    const recipients = r.recipients.split(",").map(s => s.trim()).filter(Boolean);
    if (recipients.length === 0) continue;
    const [mailSettings] = await query("SELECT * FROM office_mail_settings WHERE office_id=$1 AND is_active=TRUE", [r.office_id]);
    if (!mailSettings) continue;

    let report;
    if (r.report_type === 'shipments-csv') report = await ctx.buildShipmentsCsvReport();
    else { console.warn(`Unknown scheduled report type: ${r.report_type}`); continue; }

    try {
      const mailOptions = buildMailOptions({
        from: mailSettings.from_address, fromName: mailSettings.from_name,
        to: recipients.join(","),
        subject: `Scheduled Report — ${report.filename}`,
        message: `Attached is your ${r.frequency} scheduled report, generated automatically by CargoDesk.`,
        attachmentContent: report.csv, attachmentFilename: report.filename, attachmentContentType: "text/csv",
      });
      await sendViaOffice(query, r.office_id, mailOptions);
      await query("UPDATE scheduled_reports SET last_run_at=$1 WHERE id=$2", [new Date().toISOString(), r.id]);
      await logEntityEvent('scheduled_report', r.id, 'REPORT_SENT', null, null, null,
        JSON.stringify({ reportType: r.report_type, recipients, frequency: r.frequency }));
      sent.push({ id: r.id, reportType: r.report_type, recipients, filename: report.filename });
    } catch (e) {
      console.warn(`Scheduled report ${r.id} failed:`, e.message);
    }
  }
  return sent;
}

// ─── Invoice Collections thresholds + sweep (Epic TKT-G11AHW) ─────────────────
const DEFAULT_ALERT_DAYS = 5;
const DEFAULT_ESCALATION_DAYS = 8;

// Resolution order, most specific wins — same "specific override beats general default" shape
// this codebase already uses elsewhere (a pack item's own HS code override falling back to its
// container's, a customer's own currency default vs. the country default): the shipment's own
// EMO office's thresholds, then that office's own country, then the hardcoded default. Both the
// report and the sweep call this so they can never disagree on what "overdue" means for a given
// shipment.
async function resolveInvoiceThresholds(emoOfficeId) {
  const office = emoOfficeId ? (await query("SELECT * FROM offices WHERE id=$1", [emoOfficeId]))[0] : null;
  if (office?.invoice_alert_business_days != null && office?.invoice_escalation_business_days != null) {
    return { alertBusinessDays: office.invoice_alert_business_days, escalationBusinessDays: office.invoice_escalation_business_days };
  }
  const country = office?.country_code ? (await query("SELECT * FROM countries WHERE iso2=$1", [office.country_code]))[0] : null;
  return {
    alertBusinessDays: office?.invoice_alert_business_days ?? country?.invoice_alert_business_days ?? DEFAULT_ALERT_DAYS,
    escalationBusinessDays: office?.invoice_escalation_business_days ?? country?.invoice_escalation_business_days ?? DEFAULT_ESCALATION_DAYS,
  };
}

// Mirrors runDunningSweep()'s exact daily-interval, re-evaluate-everything shape — a resolved
// threshold + each document's own collections_alerted_at/collections_escalated_at timestamp
// already tells us what's due on every run, no need for more complex single-timer machinery.
// An active override (invoice_status_overrides, most recent row per document) suppresses BOTH
// the alert and the escalation entirely — the whole reason Trade Manager override authority
// exists (an explained end-of-month payment cycle isn't a collections problem to keep escalating).
async function runInvoiceCollectionsSweep() {
  const sent = [];
  const rows = await query(`
    SELECT d.*, s.emo_office_id
    FROM shipment_documents d
    JOIN shipments s ON s.id = d.shipment_id
    WHERE d.doc_type IN ('FR01','FR02') AND d.status='confirmed'
  `);

  const todayIso = new Date().toISOString();
  for (const r of rows) {
    const amountUsd = await docAmountUsd(r);
    const outstandingUsd = Math.max(0, roundCents(amountUsd - (r.paid_amount || 0)));
    if (outstandingUsd <= 0) continue;

    const [activeOverride] = await query(
      "SELECT * FROM invoice_status_overrides WHERE document_id=$1 ORDER BY overridden_at DESC LIMIT 1", [r.id]
    );
    if (activeOverride) continue;

    const { alertBusinessDays, escalationBusinessDays } = await resolveInvoiceThresholds(r.emo_office_id);
    const refDate = r.confirmed_at || r.created_at;
    const elapsed = businessDaysBetween(refDate, todayIso);

    if (elapsed >= alertBusinessDays && !r.collections_alerted_at) {
      const ownerId = r.invoice_owner_id;
      const [owner] = ownerId ? await query("SELECT * FROM users WHERE id=$1", [ownerId]) : [null];
      const [mailSettings] = r.emo_office_id ? await query("SELECT * FROM office_mail_settings WHERE office_id=$1 AND is_active=TRUE", [r.emo_office_id]) : [null];
      if (owner?.email && mailSettings) {
        try {
          const mailOptions = buildMailOptions({
            from: mailSettings.from_address, fromName: mailSettings.from_name,
            to: owner.email,
            subject: `Invoice ${r.filename} is now overdue — Shipment ${r.shipment_id}`,
            message: `This invoice has passed its ${alertBusinessDays}-business-day collections threshold with no payment recorded. Please follow up with the customer or record an override with a reason if there's a known cause (e.g. end-of-month payment terms).`,
          });
          await sendViaOffice(query, r.emo_office_id, mailOptions);
          sent.push({ id: r.id, shipmentId: r.shipment_id, stage: 'alert', to: owner.email });
        } catch (e) { console.warn(`Invoice collections alert ${r.id} failed:`, e.message); }
      }
      await query("UPDATE shipment_documents SET collections_alerted_at=$1 WHERE id=$2", [todayIso, r.id]);
    }

    if (elapsed >= escalationBusinessDays && !r.collections_escalated_at) {
      const [office] = r.emo_office_id ? await query("SELECT * FROM offices WHERE id=$1", [r.emo_office_id]) : [null];
      const [manager] = office?.manager_user_id ? await query("SELECT * FROM users WHERE id=$1", [office.manager_user_id]) : [null];
      const [mailSettings] = r.emo_office_id ? await query("SELECT * FROM office_mail_settings WHERE office_id=$1 AND is_active=TRUE", [r.emo_office_id]) : [null];
      if (manager?.email && mailSettings) {
        try {
          const mailOptions = buildMailOptions({
            from: mailSettings.from_address, fromName: mailSettings.from_name,
            to: manager.email,
            subject: `Escalation — invoice ${r.filename} still unpaid — Shipment ${r.shipment_id}`,
            message: `This invoice has now passed its ${escalationBusinessDays}-business-day escalation threshold with no payment recorded and no override on file.`,
          });
          await sendViaOffice(query, r.emo_office_id, mailOptions);
          sent.push({ id: r.id, shipmentId: r.shipment_id, stage: 'escalation', to: manager.email });
        } catch (e) { console.warn(`Invoice collections escalation ${r.id} failed:`, e.message); }
      } else {
        console.warn(`Invoice collections escalation ${r.id} skipped — no branch manager configured for office ${r.emo_office_id || '(none)'}`);
      }
      await query("UPDATE shipment_documents SET collections_escalated_at=$1 WHERE id=$2", [todayIso, r.id]);
    }
  }
  return sent;
}
setInterval(() => { runInvoiceCollectionsSweep().catch(e => console.error("Invoice collections sweep failed:", e.message)); }, 24 * 60 * 60 * 1000);

// Both backfillGeneratedScheduleTransitDays and backfillGarbledVesselNames (historical
// cleanups for rows produced by since-patched bugs) are dropped — nothing in a fresh Postgres
// install can have either legacy shape.
// ─── Backfill port country_code from unlocode ─────────────────────────────────
// Derives country from first 2 chars of UN/LOCODE (e.g. NLRTM → NL).
// Safe to run on every startup — only touches rows where country_code is missing.
async function backfillPortCountryCodes() {
  const rows = await query(`
    UPDATE port_locations
    SET country_code = UPPER(SUBSTR(unlocode, 1, 2))
    WHERE country_code IS NULL OR country_code = ''
    RETURNING unlocode
  `);
  if (rows.length > 0)
    console.log(`  ✔ Backfilled country_code on ${rows.length.toLocaleString()} port rows`);
}

// ─── Backfill timezone on port_locations ──────────────────────────────────────
// Single-TZ countries use a direct IANA map; multi-TZ countries (US, CA, AU,
// RU, BR, MX, ID) use longitude bands. Safe to re-run — only touches NULL rows.
async function backfillPortTimezones() {
  const [{ n: nullCountRaw }] = await query(
    "SELECT COUNT(*) AS n FROM port_locations WHERE timezone IS NULL OR timezone=''"
  );
  const nullCount = Number(nullCountRaw);
  if (nullCount === 0) return;

  const COUNTRY_TZ = {
    // Europe
    AD:"Europe/Andorra",  AL:"Europe/Tirane",    AT:"Europe/Vienna",
    BA:"Europe/Sarajevo", BE:"Europe/Brussels",  BG:"Europe/Sofia",
    BY:"Europe/Minsk",    CH:"Europe/Zurich",    CZ:"Europe/Prague",
    DE:"Europe/Berlin",   DK:"Europe/Copenhagen",EE:"Europe/Tallinn",
    ES:"Europe/Madrid",   FI:"Europe/Helsinki",  FR:"Europe/Paris",
    GB:"Europe/London",   GI:"Europe/Gibraltar", GR:"Europe/Athens",
    HR:"Europe/Zagreb",   HU:"Europe/Budapest",  IE:"Europe/Dublin",
    IS:"Atlantic/Reykjavik",IT:"Europe/Rome",    LI:"Europe/Vaduz",
    LT:"Europe/Vilnius",  LU:"Europe/Luxembourg",LV:"Europe/Riga",
    MC:"Europe/Monaco",   MD:"Europe/Chisinau",  ME:"Europe/Podgorica",
    MK:"Europe/Skopje",   MT:"Europe/Malta",     NL:"Europe/Amsterdam",
    NO:"Europe/Oslo",     PL:"Europe/Warsaw",    PT:"Europe/Lisbon",
    RO:"Europe/Bucharest",RS:"Europe/Belgrade",  SE:"Europe/Stockholm",
    SI:"Europe/Ljubljana",SK:"Europe/Bratislava",SM:"Europe/San_Marino",
    TR:"Europe/Istanbul", UA:"Europe/Kiev",      XK:"Europe/Belgrade",
    // Caucasus / Central Asia
    AM:"Asia/Yerevan",    AZ:"Asia/Baku",        GE:"Asia/Tbilisi",
    KG:"Asia/Bishkek",    TJ:"Asia/Dushanbe",    TM:"Asia/Ashgabat",
    UZ:"Asia/Tashkent",   KZ:"Asia/Almaty",
    // Middle East
    AE:"Asia/Dubai",      AF:"Asia/Kabul",       BH:"Asia/Bahrain",
    CY:"Asia/Nicosia",    IQ:"Asia/Baghdad",     IR:"Asia/Tehran",
    IL:"Asia/Jerusalem",  JO:"Asia/Amman",       KW:"Asia/Kuwait",
    LB:"Asia/Beirut",     OM:"Asia/Muscat",      QA:"Asia/Qatar",
    SA:"Asia/Riyadh",     SY:"Asia/Damascus",    YE:"Asia/Aden",
    // Asia (single-TZ)
    BD:"Asia/Dhaka",      BN:"Asia/Brunei",      BT:"Asia/Thimphu",
    CN:"Asia/Shanghai",   HK:"Asia/Hong_Kong",   JP:"Asia/Tokyo",
    KH:"Asia/Phnom_Penh", KP:"Asia/Pyongyang",   KR:"Asia/Seoul",
    LA:"Asia/Vientiane",  LK:"Asia/Colombo",     MM:"Asia/Rangoon",
    MN:"Asia/Ulaanbaatar",MO:"Asia/Macau",       MV:"Indian/Maldives",
    MY:"Asia/Kuala_Lumpur",NP:"Asia/Kathmandu",  PH:"Asia/Manila",
    PK:"Asia/Karachi",    SG:"Asia/Singapore",   TH:"Asia/Bangkok",
    TL:"Asia/Dili",       TW:"Asia/Taipei",      VN:"Asia/Ho_Chi_Minh",
    // Africa
    DZ:"Africa/Algiers",  EG:"Africa/Cairo",     ER:"Africa/Asmara",
    ET:"Africa/Addis_Ababa",GH:"Africa/Accra",   KE:"Africa/Nairobi",
    LY:"Africa/Tripoli",  MA:"Africa/Casablanca",MG:"Indian/Antananarivo",
    MU:"Indian/Mauritius",MW:"Africa/Blantyre",  MZ:"Africa/Maputo",
    NA:"Africa/Windhoek", NE:"Africa/Niamey",    NG:"Africa/Lagos",
    RE:"Indian/Reunion",  RW:"Africa/Kigali",    SC:"Indian/Mahe",
    SD:"Africa/Khartoum", SN:"Africa/Dakar",     SO:"Africa/Mogadishu",
    SS:"Africa/Juba",     SZ:"Africa/Mbabane",   TD:"Africa/Ndjamena",
    TG:"Africa/Lome",     TN:"Africa/Tunis",     TZ:"Africa/Dar_es_Salaam",
    UG:"Africa/Kampala",  ZA:"Africa/Johannesburg",ZM:"Africa/Lusaka",
    ZW:"Africa/Harare",   CI:"Africa/Abidjan",   CM:"Africa/Douala",
    // Americas – single-TZ
    AG:"America/Antigua", AW:"America/Aruba",    BB:"America/Barbados",
    BL:"America/St_Barthelemy",BM:"America/Bermuda",BS:"America/Nassau",
    BZ:"America/Belize",  BO:"America/La_Paz",   CO:"America/Bogota",
    CR:"America/Costa_Rica",CU:"America/Havana",  DM:"America/Dominica",
    DO:"America/Santo_Domingo",EC:"America/Guayaquil",FK:"Atlantic/Stanley",
    GD:"America/Grenada", GF:"America/Cayenne",  GP:"America/Guadeloupe",
    GT:"America/Guatemala",GY:"America/Guyana",  HN:"America/Tegucigalpa",
    HT:"America/Port-au-Prince",JM:"America/Jamaica",KN:"America/St_Kitts",
    KY:"America/Cayman",  LC:"America/St_Lucia", MQ:"America/Martinique",
    MS:"America/Montserrat",NI:"America/Managua", PA:"America/Panama",
    PE:"America/Lima",    PR:"America/Puerto_Rico",PY:"America/Asuncion",
    SR:"America/Paramaribo",SV:"America/El_Salvador",TC:"America/Grand_Turk",
    TT:"America/Port_of_Spain",UY:"America/Montevideo",VC:"America/St_Vincent",
    VE:"America/Caracas", VG:"America/Tortola",  VI:"America/St_Thomas",
    // Pacific
    CK:"Pacific/Rarotonga",FJ:"Pacific/Fiji",    GU:"Pacific/Guam",
    KI:"Pacific/Tarawa",  NC:"Pacific/Noumea",   NF:"Pacific/Norfolk",
    NR:"Pacific/Nauru",   NU:"Pacific/Niue",     NZ:"Pacific/Auckland",
    PF:"Pacific/Tahiti",  PG:"Pacific/Port_Moresby",PW:"Pacific/Palau",
    SB:"Pacific/Guadalcanal",TO:"Pacific/Tongatapu",TV:"Pacific/Funafuti",
    VU:"Pacific/Efate",   WS:"Pacific/Apia",
  };

  for (const [cc, tz] of Object.entries(COUNTRY_TZ)) {
    await query(
      "UPDATE port_locations SET timezone=$1 WHERE SUBSTR(unlocode,1,2)=$2 AND (timezone IS NULL OR timezone='')",
      [tz, cc]);
  }

  // US – longitude bands (Eastern / Central / Mountain / Pacific / Hawaii)
  await query(`UPDATE port_locations SET timezone = CASE
    WHEN longitude <= -140 THEN 'America/Honolulu'
    WHEN longitude <= -120 THEN 'America/Los_Angeles'
    WHEN longitude <= -105 THEN 'America/Denver'
    WHEN longitude <= -90  THEN 'America/Chicago'
    ELSE 'America/New_York' END
    WHERE SUBSTR(unlocode,1,2)='US' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`);
  await query("UPDATE port_locations SET timezone='America/New_York' WHERE SUBSTR(unlocode,1,2)='US' AND (timezone IS NULL OR timezone='')");

  // Canada
  await query(`UPDATE port_locations SET timezone = CASE
    WHEN longitude <= -120 THEN 'America/Vancouver'
    WHEN longitude <= -95  THEN 'America/Winnipeg'
    WHEN longitude <= -73  THEN 'America/Toronto'
    ELSE 'America/Halifax' END
    WHERE SUBSTR(unlocode,1,2)='CA' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`);
  await query("UPDATE port_locations SET timezone='America/Toronto' WHERE SUBSTR(unlocode,1,2)='CA' AND (timezone IS NULL OR timezone='')");

  // Australia
  await query(`UPDATE port_locations SET timezone = CASE
    WHEN longitude < 129 THEN 'Australia/Perth'
    WHEN longitude < 138 THEN 'Australia/Darwin'
    WHEN longitude < 141 THEN 'Australia/Adelaide'
    ELSE 'Australia/Sydney' END
    WHERE SUBSTR(unlocode,1,2)='AU' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`);
  await query("UPDATE port_locations SET timezone='Australia/Sydney' WHERE SUBSTR(unlocode,1,2)='AU' AND (timezone IS NULL OR timezone='')");

  // Russia
  await query(`UPDATE port_locations SET timezone = CASE
    WHEN longitude < 60  THEN 'Europe/Moscow'
    WHEN longitude < 73  THEN 'Asia/Yekaterinburg'
    WHEN longitude < 84  THEN 'Asia/Omsk'
    WHEN longitude < 98  THEN 'Asia/Krasnoyarsk'
    WHEN longitude < 114 THEN 'Asia/Irkutsk'
    WHEN longitude < 130 THEN 'Asia/Yakutsk'
    WHEN longitude < 143 THEN 'Asia/Vladivostok'
    ELSE 'Asia/Magadan' END
    WHERE SUBSTR(unlocode,1,2)='RU' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`);
  await query("UPDATE port_locations SET timezone='Europe/Moscow' WHERE SUBSTR(unlocode,1,2)='RU' AND (timezone IS NULL OR timezone='')");

  // Brazil
  await query(`UPDATE port_locations SET timezone = CASE
    WHEN longitude < -50 THEN 'America/Manaus'
    ELSE 'America/Sao_Paulo' END
    WHERE SUBSTR(unlocode,1,2)='BR' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`);
  await query("UPDATE port_locations SET timezone='America/Sao_Paulo' WHERE SUBSTR(unlocode,1,2)='BR' AND (timezone IS NULL OR timezone='')");

  // Mexico
  await query(`UPDATE port_locations SET timezone = CASE
    WHEN longitude < -106 THEN 'America/Tijuana'
    WHEN longitude < -98  THEN 'America/Mazatlan'
    ELSE 'America/Mexico_City' END
    WHERE SUBSTR(unlocode,1,2)='MX' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`);
  await query("UPDATE port_locations SET timezone='America/Mexico_City' WHERE SUBSTR(unlocode,1,2)='MX' AND (timezone IS NULL OR timezone='')");

  // Indonesia
  await query(`UPDATE port_locations SET timezone = CASE
    WHEN longitude < 116 THEN 'Asia/Jakarta'
    WHEN longitude < 124 THEN 'Asia/Makassar'
    ELSE 'Asia/Jayapura' END
    WHERE SUBSTR(unlocode,1,2)='ID' AND (timezone IS NULL OR timezone='') AND longitude IS NOT NULL`);
  await query("UPDATE port_locations SET timezone='Asia/Jakarta' WHERE SUBSTR(unlocode,1,2)='ID' AND (timezone IS NULL OR timezone='')");

  const [{ n: remainingRaw }] = await query(
    "SELECT COUNT(*) AS n FROM port_locations WHERE timezone IS NULL OR timezone=''"
  );
  const filled = nullCount - Number(remainingRaw);
  if (filled > 0)
    console.log(`  ✔ Backfilled timezone on ${filled.toLocaleString()} port rows`);
}

// ─── Startup cleanup ──────────────────────────────────────────────────────────
// migrateContainersColumns (column renames) and the vessel-name cleanup UPDATE are both dropped —
// schema-shape and legacy-data fixups with nothing to act on in a fresh Postgres install.

// Seeds the default FCL milestone template if none exists. Deterministic ids (not a random
// uid() guarded only by a COUNT(*) check) — a real bug found this session: merging in an
// independently-seeded historical copy of these same 9 rows (each with its own random id from
// whenever IT was first seeded) produced 18 rows instead of 9, since ON CONFLICT DO NOTHING only
// guards against an exact id collision, not a logical duplicate of the same milestone_key. Every
// shipment created afterward got two shipment_milestones rows per key — autoCompleteMilestone()
// only ever updates one of the two (SELECT with no ORDER BY, first match wins), so a real booking
// confirmation could complete the "wrong" duplicate and leave the other looking permanently open.
async function seedDefaultMilestoneTemplate() {
  try {
    const [existing] = await query("SELECT 1 AS x FROM milestone_templates WHERE template_key='FCL' AND carrier_code='' AND trade_lane='' LIMIT 1");
    if (existing) return;
    const now = new Date().toISOString();
    const defaults = [
      { key: 'booking_confirmed', label: 'Booking Confirmed', seq: 1 },
      { key: 'si_submitted',      label: 'SI Submitted',       seq: 2 },
      { key: 'cargo_gated_in',    label: 'Cargo Gated In',     seq: 3 },
      { key: 'vessel_departed',   label: 'Vessel Departed',    seq: 4 },
      { key: 'bl_issued',         label: 'B/L Issued',         seq: 5 },
      { key: 'vessel_arrived',    label: 'Vessel Arrived',     seq: 6 },
      { key: 'customs_cleared',   label: 'Customs Cleared',    seq: 7 },
      { key: 'cargo_released',    label: 'Cargo Released',     seq: 8 },
      { key: 'delivered',         label: 'Delivered',          seq: 9 },
    ];
    for (const d of defaults) {
      await query(
        "INSERT INTO milestone_templates (id,template_key,carrier_code,trade_lane,milestone_key,label,sequence_order,created_at) VALUES ($1,'FCL','','',$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING",
        [`mt-fcl-${d.key}`, d.key, d.label, d.seq, now]);
    }
  } catch (e) { console.warn('  ⚠ Could not seed milestone template:', e.message); }
}

// Deterministic ids for the same reason as seedDefaultMilestoneTemplate() above — a
// COUNT(*)-guarded random uid() let a merged-in historical "Main Board" produce a second,
// duplicate default project (and a duplicate set of 7 columns) the instant it existed alongside
// a freshly-seeded one, confirmed live this session (two PRJ- rows, both key='MAIN').
async function seedDefaultProject() {
  try {
    const [existing] = await query("SELECT 1 AS x FROM kb_projects WHERE key='MAIN' LIMIT 1");
    if (existing) return;
    const projectId = 'prj-main-default';
    const now = new Date().toISOString();
    await query(
      "INSERT INTO kb_projects (id,name,key,color,description,created_at) VALUES ($1,'Main Board','MAIN','#6366f1','Default project board',$2) ON CONFLICT (id) DO NOTHING",
      [projectId, now]);
    const DEFAULT_COLUMNS = [
      { name: 'Ready',           color: '#6366f1' },
      { name: 'In Progress',     color: '#f59e0b' },
      { name: 'In Testing',      color: '#06b6d4' },
      { name: 'Testing Failed',  color: '#ef4444' },
      { name: 'Ready to Deploy', color: '#f97316' },
      { name: 'Done',            color: '#22c55e' },
      { name: 'Released',        color: '#8b5cf6' },
    ];
    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
      await query(
        "INSERT INTO kb_columns (id,project_id,name,position,color,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING",
        [`col-main-default-${i}`, projectId, DEFAULT_COLUMNS[i].name, i, DEFAULT_COLUMNS[i].color, now]);
    }
  } catch (e) { console.warn('  ⚠ Could not seed default project:', e.message); }
}

schemaReadyPromise = schemaReadyPromise
  .then(() => backfillPortCountryCodes())
  .then(() => backfillPortTimezones())
  .then(() => seedDefaultMilestoneTemplate())
  .then(() => seedDefaultProject());

// backfillTicketProjects and backfillTestItems (both historical one-time migrations of
// pre-existing legacy ticket rows into the newer project/test_items shape) are dropped — nothing
// in a fresh Postgres install can have either legacy shape.
// ─── Map functions ────────────────────────────────────────────────────────────

// Carriers a booking request can be sent to. Single source of truth on ctx — routes/edi.js
// used to hand-copy this same Set locally (matching an equivalent copy on the frontend);
// centralized here so the two can't silently drift apart. This gates EDI booking eligibility
// only — the booking request/response itself is fully simulated (v0.35.0), not a real
// carrier integration; the once-separate "carriers you can search live schedules for" concept
// (routes/system.js's old MAERSK_CODES) is gone entirely (v0.72.0) along with the live Maersk
// developer-tools schedule/booking API it gated — schedule search is catalog-then-demo-only now.
const BOOKABLE_CARRIERS = new Set(["MAEU", "SAFM", "MCPU"]);

// eAdapter (carrier-EDI epic, story 1) — generalizes BOOKABLE_CARRIERS from a fixed 3-carrier
// set into "the built-in 3 OR any carrier with an active eAdapter config," gated behind one
// master toggle. Turning api_eadapter_enabled off blocks EVERY carrier, including the built-in
// 3 — a deliberate choice so the toggle governs the whole EDI-carrier-communication surface
// uniformly, with no special-casing; a carrier that isn't bookable already has a complete
// fallback lifecycle (manual Confirm with a hand-entered bookingRef, no EDI message ever sent),
// so "off" just means every carrier uses that same path.
//
// v0.83.0 — per-office scoping. A real carrier EDI relationship is negotiated per-country/
// per-branch, not once globally: a low-volume office is exactly the one a carrier is least
// inclined to bother configuring EDI for. carrier_eadapter_configs rows are now scoped to a
// specific office_id (see its own table comment); officeId is the shipment's own emo_office_id
// (Export Managing Office — the office actually handling the carrier relationship for this
// shipment, same field resolveInvoiceThresholds/sendViaOffice already key off). A shipment with
// no EMO office assigned yet can never match a scoped config — same "incomplete data means no,
// not yes" posture this codebase already takes elsewhere (e.g. a blank contractId never matches
// a contract). The built-in 3 (BOOKABLE_CARRIERS) are deliberately NOT office-scoped — they're a
// separate, pre-existing, always-simulated concept this pass didn't revisit.
async function isEdiBookable(carrierCode, officeId) {
  if ((await getSettings()).api_eadapter_enabled === 'false') return false;
  if (BOOKABLE_CARRIERS.has(carrierCode)) return true;
  if (!officeId) return false;
  const [cfg] = await query("SELECT is_active FROM carrier_eadapter_configs WHERE carrier_code=$1 AND office_id=$2", [carrierCode, officeId]);
  return !!cfg?.is_active;
}
// Fixed, curated additional party roles (Epic TKT-5XFCAP) — alongside the 4 hardcoded
// shipper/consignee/notify/principal roles on shipments. Frontend keeps its own copy in
// src/tokens.js (same split as BOOKABLE_CARRIERS — frontend/backend don't share a module).
// Customs Broker is split Export/Import (not a single role) since each shipment can only
// hold one party per role and the two are routinely handled by different brokers — also a
// deliberate setup for the later Customs & Regulatory Filing epic (TKT-XW6TQK). "Agent" (bare)
// is a generic, manually-picked catch-all with no carrier/port linkage — NOT the same concept
// as "Line Agent (Export/Import)" below, which is a specific carrier's local representative at
// a specific port, auto-resolved from the carrier_agents table (see resolveCarrierAgent) — the
// two are easy to confuse since they sit side by side in the same picker.
const ADDITIONAL_PARTY_ROLES = [
  "Forwarder", "Customs Broker (Export)", "Customs Broker (Import)",
  "Trucker (Pre-carriage)", "Trucker (On-carriage)",
  "Also Notify Party", "Bank", "Insurance Provider", "Agent",
  "Line Agent (Export)", "Line Agent (Import)", "NVOCC", "Co-Loading NVOCC",
];
// Customs & Regulatory Filing (Epic TKT-XW6TQK) — the two filing types a shipment can
// independently need, AES/EEI (export) and ISF/AMS (import). Simulated/mock only.
const CUSTOMS_FILING_TYPES = ["AES_EEI", "ISF_AMS"];

const LEG_LOC_ABBR = { 'Door': 'DR', 'Terminal': 'PT', 'Container Yard': 'CY', 'CFS': 'CFS', 'GPS Coordinates': 'GPS' };
const GPS_LOC_TYPE = 'GPS Coordinates';

const syncShipmentFromLegs = async (shipmentId) => {
  const legs = await query("SELECT * FROM shipment_legs WHERE shipment_id=$1 ORDER BY leg_order ASC", [shipmentId]);
  if (!legs.length) {
    // Every leg was just removed (e.g. unlinking a schedule) — the schedule-derived fields
    // this function writes are now stale and must be cleared, not left showing the last-known
    // sailing forever. pol/pod/carrier_code are shipment-level fields set independently at
    // creation (not purely leg-derived), so they're left untouched here.
    await query(`UPDATE shipments SET etd='', eta='', vessel='', vessel_imo='', voyage='', routing_term=NULL WHERE id=$1`, [shipmentId]);
    return;
  }
  const first = legs[0], last = legs[legs.length - 1];
  const seaLeg = legs.find(l => l.leg_type === 'SEA' || l.mot === 'SEA') || first;
  // Routing term: span from first carrier-arranged leg to last — Merchant's Haulage legs excluded
  const cLegs = legs.filter(l => !["Merchant's Haulage", "Customer Arranged"].includes(l.movement_type || l.mot));
  let routingTerm = null;
  if (cLegs.length > 0) {
    const a = cLegs[0].pol_loc_type || 'Terminal';
    const b = cLegs[cLegs.length - 1].pod_loc_type || 'Terminal';
    routingTerm = (LEG_LOC_ABBR[a] || a) + '-' + (LEG_LOC_ABBR[b] || b);
  }
  // Real bug found on a live shipment (SHP-L46XMM): this used to unconditionally roll the SEA
  // leg's own carrier up onto the shipment via COALESCE(NULLIF(?,''), carrier_code) — correct
  // for the "carrier decided leg-by-leg" case (blank shipment carrier, or no contract driving
  // it), but it silently clobbered a Central contract's own carrier the moment ANY leg carried
  // a different one, with no audit trail (this function writes via a bare UPDATE, never
  // logEvent) — the sailing search then read that now-wrong shipment.carrierCode and searched
  // the wrong carrier's schedules entirely, with no record anywhere of how it got that way.
  // A Central contract's carrier is the authoritative one once a contract is attached — a
  // leg's own carrier should never silently override it. Every other shipment (no Central
  // contract yet, or Central with the SAME carrier) keeps the exact prior roll-up behavior.
  const [shipmentRow] = await query("SELECT carrier_code, contract_type, contract_id FROM shipments WHERE id=$1", [shipmentId]);
  const contractLocksCarrier = shipmentRow?.contract_type === 'Central' && !!shipmentRow?.contract_id;
  const legCarrier = seaLeg.carrier_code || '';
  const newCarrierCode = contractLocksCarrier
    ? (shipmentRow.carrier_code || '')
    : (legCarrier || shipmentRow?.carrier_code || '');
  // first.pol/last.pod fall back to the SEA leg's own port when the bookending Pick-up/Delivery
  // leg is a classified GPS site (pol/pod blanked there by design) — the shipment's overall
  // pol/pod must still resolve to a real UN/LOCODE, since it feeds B/L generation, exports, and
  // every list/header surface that expects a real port.
  // etd/eta already double as the "confirmed once known" fields (AIS TKT-ZFO2OM) — when the AIS
  // listener updates a SEA leg's etd/eta in place after a confirmed departure/arrival, this
  // existing rollup carries it up to the shipment the same way it always has, no separate
  // atd/ata bookend needed.
  await query(`UPDATE shipments SET pol=$1, pod=$2, etd=$3, eta=$4, carrier_code=$5, vessel=$6, vessel_imo=$7, voyage=$8, routing_term=$9 WHERE id=$10`,
    [first.pol || seaLeg.pol || '', last.pod || seaLeg.pod || '', first.etd || null, last.eta || null,
     newCarrierCode, seaLeg.vessel || '', seaLeg.vessel_imo || '',
     seaLeg.voyage || '', routingTerm, shipmentId]);
  // Closes the "no audit trail" half of the bug above — any future roll-up that actually
  // changes carrier_code (the legitimate blank-carrier/no-contract case) is now traceable the
  // same way a manual edit already is, instead of only ever showing up as an unexplained diff.
  if (shipmentRow && newCarrierCode !== (shipmentRow.carrier_code || '')) {
    await logEvent(shipmentId, 'FIELD_UPDATED', 'carrier_code', shipmentRow.carrier_code || null, newCarrierCode || null,
      JSON.stringify({ source: 'syncShipmentFromLegs', legCarrier, seaLegId: seaLeg.id }));
  }
};

// Row-mapper functions (mapShipment, mapContainer, mapCustomer, etc.) live in lib/mappers.js —
// extracted since they're pure functions of a DB row, needing only portLanesMap (for
// mapShipment's tradeLane) and CUTOFF_WARNING_DAYS (for mapContainer's cutoff badges) threaded
// in, matching the createAisListener({ query, ... }) factory pattern already used in this codebase.
const CUTOFF_WARNING_DAYS = 3;
const {
  SVC_ABBR, longestLane, cutoffState, roundCents,
  mapShipment, mapShipmentLeg, mapCostLine, mapService, mapRateSnapshot, mapRateSnapshotLine,
  mapChargeCodeDefinition, mapContainer, mapContainerEvent, mapContainerPackage, mapShipmentParty, mapSideOffice,
  mapPackTypeDefinition, mapDutyRateChapter, mapScheduledReport, mapContainerTypeDefinition, mapAllocation, mapCarrier, mapVessel, mapPortLocation, mapLinkedPort,
  mapCarrierAgent, mapCarrierAgentScheduleRow, mapTradeLane, mapScopeItem, mapAccessConfig, mapOffice, mapOfficeMailSettings,
  mapSystemEmailSettings,
  mapBranch, mapOrgCountry, mapRegion, mapCountry, mapTicketLink, mapTicket, mapTestItem,
  mapTestCaseLink, mapEdiMessage, mapCarrierBooking, mapCustomsFiling, mapKbProject, mapKbVersion,
  mapKbColumn, mapCustomer, mapCustomerIdentifier, mapCustomerScreening, mapCustomerDoc,
  mapCustomerContact, mapCommodity, mapSystemMessage, mapMilestone, mapMilestoneTemplate,
  mapContract, mapLeg, mapRate, mapContractRouting, mapCarrierInvoice, mapCarrierInvoiceLine,
  mapQuote, mapQuoteLine, mapOpportunity,
  mapInvoiceReasonCode, mapInvoiceStatusOverride,
  mapEadapterConfig,
} = createMappers({ portLanesMap, CUTOFF_WARNING_DAYS });

function shipmentMatchesAccessConfig(s, cfg) {
  if (cfg.originLane) {
    const polLanes = portLanesMap[s.pol] || new Set();
    if (!polLanes.has(cfg.originLane)) return false;
  }
  if (cfg.destLane) {
    const podLanes = portLanesMap[s.pod] || new Set();
    if (!podLanes.has(cfg.destLane)) return false;
  }
  if (cfg.polCodes.length     && !cfg.polCodes.includes(s.pol))              return false;
  if (cfg.podCodes.length     && !cfg.podCodes.includes(s.pod))              return false;
  if (cfg.carrierCodes.length && !cfg.carrierCodes.includes(s.carrierCode))  return false;
  return true;
}

function matchesScopeItem(s, item) {
  if (item.item_type === 'trade_lane') {
    try {
      const { origin, dest } = JSON.parse(item.value);
      const polLanes = portLanesMap[s.pol] || new Set();
      const podLanes = portLanesMap[s.pod] || new Set();
      return polLanes.has(origin) && podLanes.has(dest);
    } catch { return false; }
  }
  if (item.item_type === 'pol')     return item.value === s.pol;
  if (item.item_type === 'country') return portCountryMap[s.pol] === item.value;
  return false;
}

// Credit Control Depth, third pass (TKT-GLWMFP) — "only the trade manager working that trade
// lane may ever override a credit block" is a direct, explicit business rule, not inferred: no
// fallback to admin/operator, and no fallback to a trade_manager whose own scope doesn't cover
// this shipment's lane. Plain role-membership check (req.user.roles.includes(...), matching
// requireRole's own convention exactly) rather than primaryRoleSV's effective-role/rank logic —
// trade_manager isn't the top of a hierarchy here, it's a specific, narrow grant that should
// hold even for a user who also carries a higher-ranked role.
// A credit_overrides row for an over-limit generation stays valid for this long after approval
// — a grace window, not strict single-use (see routes/shipment-ops.js's findOverLimitBlock for
// why: one logical "generate invoices" action can fire this route several times in a row for a
// per-container split, and single-use-on-first-call would silently re-block containers 2..N).
const OVERRIDE_GRACE_MS = 60 * 60 * 1000;

async function userOwnsLaneForShipment(user, shipment) {
  if (!user?.roles?.includes('trade_manager') || !shipment) return false;
  const scopeItems = await query(
    "SELECT * FROM user_scope_items WHERE user_id=$1 AND item_type='trade_lane'", [user.id]
  );
  return scopeItems.some(item => matchesScopeItem(shipment, item));
}

// Same authority, scoped to a customer rather than one shipment — true when ANY shipment where
// this customer is Shipper/Consignee/Principal falls in one of the user's own trade lanes.
// Deliberately broader than userOwnsLaneForShipment (credit_hold lives on the customer, not one
// shipment) but never broader than the user's own actual lane grants.
async function userOwnsLaneForCustomer(user, customerId) {
  if (!user?.roles?.includes('trade_manager')) return false;
  const scopeItems = await query(
    "SELECT * FROM user_scope_items WHERE user_id=$1 AND item_type='trade_lane'", [user.id]
  );
  if (!scopeItems.length) return false;
  const shipments = await query(
    "SELECT pol, pod FROM shipments WHERE shipper_id=$1 OR consignee_id=$1 OR principal_id=$1", [customerId]
  );
  return shipments.some(s => scopeItems.some(item => matchesScopeItem(s, item)));
}

// Involved Offices — per-side edit permission (Nested Office Groups follow-up, disaster-recovery
// reassignment). Who's allowed to CHANGE a shipment's Export or Import office assignment is a
// company-wide department fact, not tied to whichever specific office happens to hold it today —
// an Export-department (SE) office user can reassign ANY visible shipment's Export side to their
// own office, which is the whole point of the disaster-recovery scenario (a DIFFERENT office
// steps in, not just the one already assigned). admin/operator and any user with `allOffices`
// (the existing office-based-visibility opt-out, `users.all_offices`) bypass entirely — this only
// bites a user an admin has deliberately scoped to specific offices. `side` is 'Export'/'Import'/
// 'Controlling' — Controlling isn't tied to a department, so either side's own office user (or
// the same bypasses) may reassign it. Mirrors applyShipmentAccessFilter's own admin/operator
// bypass and the X-Office-Id "active office" header ShipmentFormPage.jsx already reads department
// off of for its own EMO/IMO auto-default.
async function canEditOfficeSide(req, side) {
  const user = req?.user;
  if (!user) return false;
  const jwtRoles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : ['viewer']);
  if (jwtRoles.includes('admin') || jwtRoles.includes('operator')) return true;
  if (user.allOffices) return true;
  if (side === 'Controlling') return (await canEditOfficeSide(req, 'Export')) || (await canEditOfficeSide(req, 'Import'));
  const dept = side === 'Export' ? 'SE' : side === 'Import' ? 'SI' : null;
  if (!dept) return false;
  const activeOfficeId = req.headers?.['x-office-id'];
  if (!activeOfficeId) return false;
  const [office] = await query("SELECT department FROM offices WHERE id=$1", [activeOfficeId]);
  return !!office && office.department === dept;
}

async function applyShipmentAccessFilter(shipments, user, req) {
  if (!user) return shipments;

  // Derive the highest-ranked role from the JWT roles array (works with both
  // old tokens that have no 'role' field and new ones that do).
  const jwtRoles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : ['viewer']);
  const primaryRole = jwtRoles.reduce(
    (best, r) => (ROLE_RANK_SV[r] ?? 0) > (ROLE_RANK_SV[best] ?? 0) ? r : best,
    'viewer'
  );

  // When the user has switched to a lower role in the UI the frontend sends
  // X-Active-Role. Only trust it if it's actually lower than the primary role.
  const requestedRole = req?.headers?.['x-active-role'] || null;
  const effectiveRole = (requestedRole && (ROLE_RANK_SV[requestedRole] ?? 0) < (ROLE_RANK_SV[primaryRole] ?? 0))
    ? requestedRole
    : primaryRole;

  if (['admin', 'operator'].includes(effectiveRole)) return shipments;

  // Office-based data segregation: filter by active office when the user is not global.
  // Org-wide "offices_allow_all" setting bypasses this for all users.
  const orgAllowAll = (await getSettings()).offices_allow_all === "1";
  if (!user.allOffices && !orgAllowAll) {
    const activeOfficeId = req?.headers?.['x-office-id'] || null;
    if (activeOfficeId) {
      // Validate that this office is actually assigned to the user
      const [validOffice] = await query(
        "SELECT id FROM user_offices WHERE user_id=$1 AND office_id=$2", [user.id, activeOfficeId]
      );
      if (!validOffice) return [];
      // Additional (backup) offices — a shipment a disaster-recovery office was added to via
      // shipment_side_offices should be visible to that office's staff too, not just the
      // shipment's original EMO/IMO/Controlling.
      const sideOfficeShipmentIds = new Set(
        (await query("SELECT shipment_id FROM shipment_side_offices WHERE office_id=$1", [activeOfficeId]))
          .map(r => r.shipment_id)
      );
      shipments = shipments.filter(s =>
        s.emoOfficeId === activeOfficeId ||
        s.imoOfficeId === activeOfficeId ||
        s.controllingOfficeId === activeOfficeId ||
        sideOfficeShipmentIds.has(s.id)
      );
    }
  }

  const scopeItems = await query("SELECT * FROM user_scope_items WHERE user_id=$1", [user.id]);
  const legacyCfgs = (await query("SELECT * FROM user_access_configs WHERE user_id=$1", [user.id])).map(mapAccessConfig);

  if (!scopeItems.length && !legacyCfgs.length) return shipments;

  // Group scope items by type.
  // Within each type: OR (any of the configured values may match).
  // Across types: AND (every configured section must be satisfied).
  // e.g. trade_lane EU-N→NAM AND pol=NLRTM → only NLRTM→NAM shipments.
  const byType = {};
  for (const item of scopeItems) {
    (byType[item.item_type] = byType[item.item_type] || []).push(item);
  }
  const typeGroups = Object.values(byType);

  return shipments.filter(s => {
    const scopePass = typeGroups.length > 0 &&
      typeGroups.every(group => group.some(item => matchesScopeItem(s, item)));
    const legacyPass = legacyCfgs.some(c => shipmentMatchesAccessConfig(s, c));
    return scopePass || legacyPass;
  });
}
const INVERSE_LINK_LABEL = { "Blocks": "Is blocked by", "Duplicates": "Is duplicated by", "Implements": "Is implemented by", "Relates to": "Relates to" };
const inverseLinkLabel = t => INVERSE_LINK_LABEL[t] || t;
// ─── Entity event logger (generic: allocations, contracts, carriers) ─────────
// Async-ified ahead of the eventual Postgres driver swap (ARCHITECTURE.md §13) — a standalone,
// zero-behavior-change prerequisite while still on node:sqlite (awaiting an already-synchronous
// call is a no-op). Every one of its 106 call sites was converted to `await` it, not left
// fire-and-forget — this logger's write must still complete before the caller's response is
// sent, exactly as it does today, since some callers (audit/history reads) depend on that
// ordering within the same request.
const logEntityEvent = async (entityType, entityId, eventType, field = null, oldVal = null, newVal = null, meta = null) => {
  try {
    await query(
      "INSERT INTO entity_events (id,entity_type,entity_id,event_type,field,old_value,new_value,meta,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [`EEV-${uid()}`, entityType, entityId, eventType,
      field   ?? null,
      oldVal  != null ? String(oldVal) : null,
      newVal  != null ? String(newVal) : null,
      meta    ?? null,
      new Date().toISOString()]);
  } catch(e) { console.warn('logEntityEvent failed:', e.message); }
};

// ─── Admin event logger ───────────────────────────────────────────────────────
const logAdminEvent = async (actor, action, targetType = '', targetId = '', details = {}) => {
  try {
    await query(
      "INSERT INTO admin_events (id,actor_id,actor_email,action,target_type,target_id,details,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [`AEV-${uid()}`,
      actor?.id    ?? '', actor?.email ?? '',
      action, targetType, targetId,
      JSON.stringify(details), new Date().toISOString()]);
  } catch(e) { console.warn('logAdminEvent failed:', e.message); }
};

// ─── Shipment event logger ────────────────────────────────────────────────────
const logEvent = async (shipmentId, type, field, oldVal, newVal, meta = '') => {
  try {
    await query(
      "INSERT INTO shipment_events (id,shipment_id,event_type,field,old_value,new_value,actor,occurred_at,meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [`EVT-${uid()}`, shipmentId, type,
      field   ?? null,
      oldVal  != null ? String(oldVal) : null,
      newVal  != null ? String(newVal) : null,
      'user', new Date().toISOString(), meta]);
  } catch(e) { console.warn('logEvent failed:', e.message); }
};

// Fields to track on shipments (db column → human label)
const TRACKED_FIELDS = {
  pol:            'Port of Loading',
  pod:            'Port of Discharge',
  status:         'Status',
  etd:            'Estimated Departure',
  eta:            'Estimated Arrival',
  carrier_code:   'Carrier',
  vessel:         'Vessel',
  vessel_imo:     'Vessel IMO',
  voyage:         'Voyage',
  incoterm:       'Incoterm',
  commodity_code: 'Commodity',
  booking_ref:    'Booking Reference',
  bl_number:      'B/L Number',
  master_bl_number: 'Master B/L Number',
  bl_release_type: 'B/L Release Type',
  master_bl_release_type: 'Master B/L Release Type',
  coload_tariff_reference: 'Co-Load Tariff Reference',
  contract_type:  'Contract Type',
  contract_id:    'Contract ID',
  contract_ref:   'Contract Reference',
  allocation_id:  'Space Configuration',
};

const TRACKED_CTR_FIELDS = {
  container_number:  'Container Number',
  size:              'Size',
  type:              'Equipment Type',
  hs_code:           'HS Code',
  cargo_description: 'Cargo Description',
  gross_weight_kg:   'Gross Weight (kg)',
  volume_cbm:        'Volume (CBM)',
  is_dg:             'Dangerous Goods',
  dg_class:          'DG Class',
  vgm_weight_kg:        'VGM Weight (kg)',
  vgm_status:            'VGM Status',
  vgm_cutoff:            'VGM Cutoff',
  cy_cutoff:             'CY Cutoff',
  origin_free_time_days: 'Origin Demurrage Free Time (days)',
  dest_free_time_days:   'Destination Demurrage Free Time (days)',
  origin_detention_free_days: 'Origin Detention Free Time (days)',
  dest_detention_free_days:   'Destination Detention Free Time (days)',
  set_temperature_c: 'Reefer Set Temperature (°C)',
};

// Compliance-badge thresholds: how many days out a fixed cutoff (VGM/CY) or a
// container-events-derived free-time window (demurrage/detention) turns amber
// before it's overdue. Free time windows are themselves usually only 3-7 days,
// so they get a tighter warning window than a fixed planning-deadline cutoff.
// (CUTOFF_WARNING_DAYS itself is declared earlier, alongside the createMappers() call —
// mapContainer's cutoffState needs it threaded in at factory-creation time.)
const FREE_TIME_WARNING_DAYS = 2;

// ─── Milestone auto-completion (TKT-OZD4V8) ────────────────────────────────────
// Wires external events (EDI booking confirmation, container Gate In/Out, VGM
// submission) into the existing shipment_milestones lifecycle instead of requiring a
// manual completion for things the system already knows happened. No-ops if the
// milestone row doesn't exist yet (init hasn't run) or is already completed — a manual
// completion (with its own note/date) is never silently overwritten by an auto one.
const autoCompleteMilestone = async (shipmentId, milestoneKey, note) => {
  const [row] = await query("SELECT * FROM shipment_milestones WHERE shipment_id=$1 AND milestone_key=$2", [shipmentId, milestoneKey]);
  if (!row || row.completed_at) return;
  const now = new Date().toISOString();
  await query("UPDATE shipment_milestones SET completed_at=$1, completed_by=$2, note=$3 WHERE id=$4",
    [now, 'System (Auto)', note, row.id]);
};

// ─── Carrier booking auto-creation ─────────────────────────────────────────────
// Once a shipment has both a contract (contract_id for Central, or a manual contract_ref
// for SPOT/Pending/Customer Own) and a schedule, it's ready to book: a carrier_bookings
// row is created automatically in a new 'Created' status, giving it a real BKG- surrogate
// key before anyone has to explicitly send anything.
//
// "Has a schedule" deliberately covers TWO cases, not just one — found via a real bug
// report (SHP-VSB0Z2): a shipment_schedules row (from a sailing search-and-save or a
// Schedule Generator link) is the formal case, but a shipment can just as legitimately
// have its Route Legs filled in by hand (real POL/POD/ETD per SEA leg) without ever going
// through Add Sailing — that's still a real schedule from the operator's point of view,
// it just never produced an audit-trail row. Requiring etd specifically (not just "a SEA
// leg exists") matters: ShipmentFormPage defaults every new leg to legType SEA, so nearly
// every shipment has an empty one from the moment it's created — checking bare existence
// would fire the moment a contract is added to ANY shipment, regardless of whether real
// routing info exists yet.
//
// Called from every route that can newly satisfy either precondition (contract
// assignment, schedule save, Schedule Generator create/link) — idempotent (no-ops once a
// booking row already exists, same "never silently overwritten" rule autoCompleteMilestone
// above already follows) and safe to call unconditionally even when nothing changed.
// Copies a booking row into carrier_booking_archive AS-IS (keeps its own BKG- id — the
// surrogate key it already had) then deletes it from the live table. Called only from
// ensureBookingCreated's supersede branch below.
const archiveBooking = async (booking, reason) => {
  const now = new Date().toISOString();
  await query(`INSERT INTO carrier_booking_archive
    (id, shipment_id, carrier_code, status, last_response_status, booking_ref, correlation_id,
     is_mock, requested_at, requested_by, responded_at, confirmed_at, confirmed_by,
     cancelled_at, cancelled_by, cancel_reason, created_at, updated_at, archived_at, archived_reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [booking.id, booking.shipment_id, booking.carrier_code, booking.status,
     booking.last_response_status, booking.booking_ref, booking.correlation_id,
     booking.is_mock, booking.requested_at, booking.requested_by, booking.responded_at,
     booking.confirmed_at, booking.confirmed_by, booking.cancelled_at, booking.cancelled_by,
     booking.cancel_reason, booking.created_at, booking.updated_at, now, reason || '']);
  await query("DELETE FROM carrier_bookings WHERE id=$1", [booking.id]);
  await logEntityEvent('carrier_booking', booking.id, 'ARCHIVED', null, null, null,
    JSON.stringify({ shipmentId: booking.shipment_id, reason: reason || '' }));
};

// Supersede: ANY not-yet-Confirmed booking (Created, Pending, Rejected, or already Cancelled)
// whose carrier no longer matches the shipment's current one is stale — the arrangement moved
// on. Changing the carrier IS the cancellation trigger now, not a precondition of it — the
// operator doesn't have to have manually cancelled (or had it rejected) first; even a booking
// still Pending (a real request already sent, awaiting the carrier's response) gets auto-
// cancelled the moment the carrier changes. A Confirmed booking is never touched here — that's
// a real commitment, not something to silently supersede. A same-carrier edit (a contract/date
// correction that doesn't actually change who's carrying it) leaves the existing booking and
// its id completely alone — this is what makes the surrogate key persist across an edit.
//
// The old booking is transitioned to Cancelled first (if it wasn't already) — including
// sending the exact same cancellation EDI message the manual Cancel action already sends
// (only when something was actually transmitted: a bare Created booking with no
// correlation_id never had a request sent, so there's no carrier to notify) — then archived
// under its own original BKG- id (reason recorded), and the caller creates a fresh booking
// under the new carrier in its place.
//
// Shared by every place that reads "the current carrier_bookings row for this shipment" and
// then decides whether to keep building on it — not just ensureBookingCreated. Send Booking
// Request (upsertPendingBooking, routes/edi.js) and the manual Confirm route both used to read
// `existing` and unconditionally UPDATE it in place regardless of status, which is exactly what
// let a stale booking's own id/carrier/history quietly get overwritten by a completely
// different carrier's attempt the moment Send or Confirm was clicked again — the actual
// still-reproducible shape of the original SHP-Y9E98X bug, since neither of those call sites
// went through ensureBookingCreated at all.
const supersedeIfCarrierChanged = async (shipment, existing) => {
  if (!existing || existing.status === "Confirmed" || shipment.carrier_code === existing.carrier_code) return existing;
  const now = new Date().toISOString();
  const reason = `Carrier changed to ${shipment.carrier_code || '(none)'}`;
  if (existing.status !== "Cancelled") {
    // Notify the old carrier only if something was actually transmitted for THIS booking —
    // its own carrier_code (who the request actually went to), not the shipment's new one.
    if (existing.correlation_id && await isEdiBookable(existing.carrier_code, shipment.emo_office_id)) {
      const cancelId = `EDI-${uid()}`;
      await query(`
        INSERT INTO edi_messages (id, shipment_id, carrier_code, direction, message_type, format, raw_payload, status, correlation_id, is_mock, created_at)
        VALUES ($1,$2,$3,'out','booking_cancellation','JSON',$4,'sent',$5,FALSE,$6)
      `, [cancelId, shipment.id, existing.carrier_code, JSON.stringify({ reason }), existing.correlation_id, now]);
      const subs = shipmentSubs.get(shipment.id);
      if (subs) {
        const [cancelRow] = await query("SELECT * FROM edi_messages WHERE id=$1", [cancelId]);
        const frame = JSON.stringify({
          type: "new_edi_message",
          message: mapEdiMessage(cancelRow),
        });
        for (const ws of subs) if (ws.readyState === ws.OPEN) ws.send(frame);
      }
    }
    await query(`UPDATE carrier_bookings SET status='Cancelled', cancelled_at=$1, cancelled_by=$2, cancel_reason=$3, updated_at=$4 WHERE id=$5`,
      [now, 'System (Auto)', reason, now, existing.id]);
    [existing] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [existing.id]);
  }
  await archiveBooking(existing, `Superseded — ${reason}`);
  return null;
};

const ensureBookingCreated = async (shipmentId) => {
  const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
  if (!shipment) return;
  if (!(shipment.contract_id || shipment.contract_ref)) return;
  const [hasScheduleRow] = await query(`
    SELECT 1 FROM shipment_schedules WHERE shipment_id=$1
    UNION
    SELECT 1 FROM shipment_legs WHERE shipment_id=$1 AND leg_type='SEA' AND etd IS NOT NULL AND etd != ''
  `, [shipmentId]);
  if (!hasScheduleRow) return;
  let [existing] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipmentId]);
  existing = await supersedeIfCarrierChanged(shipment, existing);
  if (existing) return;
  const now = new Date().toISOString();
  const id = `BKG-${uid()}`;
  await query(`INSERT INTO carrier_bookings (id, shipment_id, carrier_code, status, created_at, updated_at)
    VALUES ($1,$2,$3,'Created',$4,$5)`, [id, shipmentId, shipment.carrier_code || '', now, now]);
  await logEntityEvent('carrier_booking', id, 'CREATED', null, null, null,
    JSON.stringify({ shipmentId, actor: 'System (Auto)' }));
  // Live-push the new booking — matters much more now than when this was write-only-at-
  // creation: a booking can be auto-superseded (and its own id swapped) at any time a not-yet-
  // Confirmed booking's carrier changes, including while a Details/Review tab for it is
  // already open. Same broadcast shape Send/Confirm/Cancel already use.
  const subs = shipmentSubs.get(shipmentId);
  if (subs) {
    const [newBooking] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [id]);
    const frame = JSON.stringify({
      type: "booking_status_changed",
      booking: mapCarrierBooking(newBooking),
    });
    for (const ws of subs) if (ws.readyState === ws.OPEN) ws.send(frame);
  }
};

// One-time startup backfill — the auto-creation trigger above only fires from write
// routes going forward; shipments that already satisfied both conditions before this
// feature existed (or via a code path that doesn't call it, like SHP-VSB0Z2's hand-entered
// legs) need a one-time sweep. Safe to re-run on every startup: ensureBookingCreated
// itself no-ops for anything that already has a booking or doesn't qualify.
async function backfillCarrierBookings() {
  const candidates = await query(`
    SELECT id FROM shipments
    WHERE (contract_id IS NOT NULL AND contract_id != '') OR (contract_ref IS NOT NULL AND contract_ref != '')
  `);
  let created = 0;
  for (const { id } of candidates) {
    const [before] = await query("SELECT id FROM carrier_bookings WHERE shipment_id=$1", [id]);
    await ensureBookingCreated(id);
    const [after] = await query("SELECT id FROM carrier_bookings WHERE shipment_id=$1", [id]);
    if (!before && after) created++;
  }
  if (created > 0) console.log(`  ✔ Backfilled ${created} carrier booking(s) for already-qualifying shipments`);
}
schemaReadyPromise = schemaReadyPromise.then(() => backfillCarrierBookings());

// ─── Ops-automation sweep: auto-create Kanban tickets from stuck process signals ──────────────
// Previously the app had zero automatic ticket creation anywhere — a stuck carrier booking, an
// overdue milestone, or an unresolved compliance HIT were only ever visible as a transient
// notification-bell badge (App.jsx's Header) or a page-level badge, nothing that persisted,
// could be assigned, or survived the badge being dismissed. This sweep turns those same three
// conditions into real, trackable Kanban tickets — same "detect a condition, act once, never
// re-fire" idiom as autoCompleteMilestone/ensureBookingCreated above, just running on a timer
// instead of off a write-path call, since "stuck"/"overdue" are inherently time-based conditions
// with no single write event that would ever trigger them.
//
// Mirrors App.jsx's own STALE_BOOKING_HOURS=48 (frontend/backend don't share a module, same
// split as CONTRACT_TYPES/BOOKABLE_CARRIERS elsewhere in this app) — a Pending booking with no
// carrier response past this age is exactly what the notification bell already flags.
const STALE_BOOKING_HOURS = 48;

// Batch-resolves rows' assigneeId -> assigneeName/assigneeInitial for whatever the Kanban Service
// returns in remote mode (it owns no `users` table of its own) — same batch-IN pattern
// routes/shipments.js's own resolveSeaPorts() already established for sea-port names. Mutates and
// returns the same array; a cheap no-op when nothing has an assignee.
async function resolveAssigneeNames(rows) {
  const ids = [...new Set(rows.map(r => r.assigneeId).filter(Boolean))];
  if (!ids.length) return rows;
  const names = {};
  (await query(`SELECT id, name FROM users WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`, ids))
    .forEach(u => { names[u.id] = u.name; });
  for (const r of rows) {
    const name = r.assigneeId ? names[r.assigneeId] : null;
    r.assigneeName = name || null;
    r.assigneeInitial = name ? name.trim()[0].toUpperCase() : null;
  }
  return rows;
}

// Dedupes on (sourceType, sourceId) via the tickets.source_type/source_id columns — once a
// ticket exists for a given source it's never recreated, even if a human later closes it and the
// underlying condition still holds (closing it is treated as "handled", same as this codebase's
// other one-shot auto-triggers never re-firing once their target is in a settled state). Returns
// the new ticket id, or null if one already existed.
//
// Remote branch (kanban_source='remote') calls the Kanban Service's own atomic
// POST /internal/tickets/ensure — an INSERT OR IGNORE against a real UNIQUE(source_type,
// source_id) constraint that table only has in that service's schema. The local path below keeps
// its original check-then-insert (a narrow, low-probability race under concurrent sweeps,
// unchanged) rather than retrofitting the same constraint onto the monolith's own long-lived
// tickets table — the remote path closes the race outright instead of porting it.
const ensureOpsTicket = async (sourceType, sourceId, { shipmentId, title, description, priority = 'Medium' }) => {
  if (((await getSettings()).kanban_source || 'local') === 'remote') {
    try {
      const r = await callKanbanService('POST', '/internal/tickets/ensure',
        { sourceType, sourceId, shipmentId: shipmentId || null, title, description, priority });
      return r.created ? r.id : null;
    } catch (e) {
      console.error('ensureOpsTicket (remote) failed:', e.message);
      return null;
    }
  }
  const [existing] = await query("SELECT id FROM tickets WHERE source_type=$1 AND source_id=$2", [sourceType, sourceId]);
  if (existing) return null;
  const id = `TKT-${uid()}`;
  const now = new Date().toISOString();
  const [maxRow] = await query("SELECT MAX(position) AS m FROM tickets WHERE status='Ready'");
  const pos = (maxRow?.m ?? -1) + 1;
  await query(`INSERT INTO tickets
    (id, title, description, priority, status, position, created_at, shipment_id, type, source_type, source_id)
    VALUES ($1,$2,$3,$4,'Ready',$5,$6,$7,'Task',$8,$9)`,
    [id, title, description, priority, pos, now, shipmentId || null, sourceType, sourceId]);
  return id;
};

const runOpsAutomationSweep = async () => {
  const now = Date.now();
  const staleBookings = await query(`
    SELECT id, shipment_id, carrier_code, requested_at FROM carrier_bookings
    WHERE status='Pending' AND requested_at IS NOT NULL AND requested_at != ''
  `);
  for (const b of staleBookings) {
    const ageHours = (now - new Date(b.requested_at).getTime()) / 36e5;
    if (ageHours < STALE_BOOKING_HOURS) continue;
    await ensureOpsTicket('carrier_booking_stale', b.id, {
      shipmentId: b.shipment_id, priority: 'High',
      title: `Carrier booking stuck — no response in ${Math.floor(ageHours)}h (${b.shipment_id})`,
      description: `Carrier booking ${b.id} on ${b.shipment_id} (${b.carrier_code || 'unknown carrier'}) has had no carrier response for over ${STALE_BOOKING_HOURS}h. Auto-created by the ops automation sweep.`,
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const overdueMilestones = await query(`
    SELECT m.id, m.shipment_id, m.label, m.estimated_date FROM shipment_milestones m
    JOIN shipments s ON s.id = m.shipment_id
    WHERE (m.completed_at IS NULL OR m.completed_at='') AND m.estimated_date != '' AND m.estimated_date < $1
      AND s.status NOT IN ('Completed', 'Cancelled')
  `, [today]);
  for (const m of overdueMilestones) {
    await ensureOpsTicket('milestone_overdue', m.id, {
      shipmentId: m.shipment_id, priority: 'Medium',
      title: `Overdue milestone: ${m.label} (${m.shipment_id})`,
      description: `Milestone "${m.label}" on ${m.shipment_id} was estimated for ${m.estimated_date} and is still incomplete. Auto-created by the ops automation sweep.`,
    });
  }

  const complianceHits = await query(`
    SELECT sc.id, sc.shipment_id FROM shipment_screenings sc
    JOIN shipments s ON s.id = sc.shipment_id
    WHERE sc.result='HIT' AND sc.overridden_at IS NULL AND s.status NOT IN ('Completed', 'Cancelled')
  `);
  for (const sc of complianceHits) {
    // Dedupe on shipment_id, not sc.id — shipment_screenings has UNIQUE(shipment_id), so a
    // re-screen (party change, customer rename, sanctions sync, this very sweep's own
    // rescreenActiveShipments call) does an INSERT OR REPLACE that regenerates sc.id even
    // though it's the same still-unresolved HIT. Deduping on the regenerating id let every
    // re-screen of an already-ticketed shipment create a fresh duplicate Critical ticket —
    // confirmed live (SHP-0YZJJ8 and SHP-W6K9NO each had two). carrier_booking_stale (above)
    // doesn't have this bug since carrier_bookings.id is genuinely stable.
    await ensureOpsTicket('compliance_hit', sc.shipment_id, {
      shipmentId: sc.shipment_id, priority: 'Critical',
      title: `Compliance HIT requires review — ${sc.shipment_id}`,
      description: `Sanctions screening on ${sc.shipment_id} returned a HIT with no override on record. Auto-created by the ops automation sweep.`,
    });
  }
};
schemaReadyPromise.then(() => runOpsAutomationSweep()).catch(e => console.error('runOpsAutomationSweep failed:', e.message));
setInterval(() => runOpsAutomationSweep().catch(e => console.error('runOpsAutomationSweep failed:', e.message)),
  60 * 60 * 1000); // hourly, same cadence as expireStaleContracts

// ─── Allocation conflict helpers ──────────────────────────────────────────────

const checkOverlap = async (carrierCode, effectiveDate, endDate, pol = '', pod = '', excludeId = null) => {
  const params = [carrierCode, pol.toUpperCase(), pod.toUpperCase(), endDate, effectiveDate, ...(excludeId ? [excludeId] : [])];
  const rows = await query(`
    SELECT id FROM allocations
    WHERE carrier_code = $1 AND pol = $2 AND pod = $3
      AND effective_date <= $4 AND end_date >= $5
      ${excludeId ? "AND id != $6" : ""}
  `, params);
  return rows.length > 0;
};

// ─── Shared route/haulage matching (contracts + allocations) ──────────────────
// One codepath for "does this leg actually cover the requested route + haulage",
// shared by /api/contracts/match and /api/allocations/match so a Central contract
// and its own space-config allocations are judged by the identical rule — not two
// endpoints quietly disagreeing. Deliberately separate from GET /api/contracts
// (the #schedules search page), which has its own independent-EXISTS-clause
// logic and is left untouched.
const linkedPortCodes = async code => (await query(`
  SELECT CASE WHEN primary_unlocode=$1 THEN linked_unlocode ELSE primary_unlocode END AS code
  FROM linked_ports WHERE primary_unlocode=$1 OR linked_unlocode=$1
`, [code])).map(r => r.code);

// Carrier Line Agents — resolves the registered Line Agent for a carrier at a port, falling
// back to any linked port (same linked-port-aware matching findMatchingContractLeg already
// uses below) so a carrier_agents row registered against a seaport still matches a shipment
// routed via a linked inland ICD. Returns the matched row (with a live-joined agent name) or
// null if nothing's registered for this carrier at this port (or any of its linked ports).
// 'remote' mode calls the MDM Service's own /internal/carrier-agents/resolve, which does its own
// linked-port fallback server-side (it owns both tables) — this function then does the one local
// `customers` lookup the service can't do itself, so the returned shape (agent_customer_name
// included) matches the local path exactly. NOTE (named, accepted gap): the LOCAL path's own
// linked-port fallback (linkedPortCodes, below) always reads the local linked_ports table even
// when mdm_source=remote — only affects the narrow case of contract_source=local combined with
// mdm_source=remote; see ARCHITECTURE.md.
// Resolves EVERY Line Agent candidate covering a given carrier+port — a location can match either
// as a direct UNLOCODE row or via a country-level row (the port's own country), and if neither
// matches directly, falls back through linked ports. A direct or country-level match is always
// exclusivity-enforced at write time (only one carrier_agents header can claim a given port or
// country per carrier), so those two tiers can only ever produce 0 or 1 result — genuine ambiguity
// (2+ candidates) can only arise from the linked-ports fallback, when a port is linked to several
// others and more than one of them has its own independent, valid agent for the same carrier.
// Each returned row carries `matched_via` (the actual port that matched — the query port itself
// for a direct/country hit, or whichever linked port produced it) so a caller can explain *why*
// each candidate is plausible. resolveCarrierAgent (below) is the old single-result contract, kept
// for its two existing callers that only ever want "the" match when unambiguous.
async function resolveCarrierAgentCandidates(carrierCode, portUnlocode) {
  if (((await getSettings()).mdm_source || "local") === "remote") {
    let rows;
    try { rows = await callMdmService("GET", `/internal/carrier-agents/resolve?carrierCode=${encodeURIComponent(carrierCode)}&port=${encodeURIComponent(portUnlocode)}&all=1`); }
    catch { return []; }
    rows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    return Promise.all(rows.map(async row => {
      const [cust] = await query("SELECT company_name FROM customers WHERE id=$1", [row.agentCustomerId]);
      return { id: row.id, carrier_code: row.carrierCode,
        agent_customer_id: row.agentCustomerId, agent_customer_name: cust?.company_name || '',
        note: row.note, created_at: row.createdAt, matched_via: row.matchedVia || portUnlocode };
    }));
  }
  const tryPort = async p => {
    const [direct] = await query(`
      SELECT ca.*, c.company_name AS agent_customer_name
      FROM carrier_agents ca
      JOIN carrier_agent_locations cal ON cal.carrier_agent_id = ca.id
      JOIN customers c ON c.id = ca.agent_customer_id
      WHERE ca.carrier_code=$1 AND cal.location_type='unlocode' AND cal.unlocode=$2
    `, [carrierCode, p]);
    if (direct) return direct;
    const [port] = await query("SELECT country_code FROM port_locations WHERE unlocode=$1", [p]);
    if (!port?.country_code) return null;
    const [row] = await query(`
      SELECT ca.*, c.company_name AS agent_customer_name
      FROM carrier_agents ca
      JOIN carrier_agent_locations cal ON cal.carrier_agent_id = ca.id
      JOIN customers c ON c.id = ca.agent_customer_id
      WHERE ca.carrier_code=$1 AND cal.location_type='country' AND cal.country_iso2=$2
    `, [carrierCode, port.country_code]);
    return row;
  };
  const direct = await tryPort(portUnlocode);
  if (direct) return [{ ...direct, matched_via: portUnlocode }];
  const linked = await linkedPortCodes(portUnlocode);
  const candidates = await Promise.all(linked.map(async p => { const row = await tryPort(p); return row ? { ...row, matched_via: p } : null; }));
  return candidates.filter(Boolean);
}

async function resolveCarrierAgent(carrierCode, portUnlocode) {
  const candidates = await resolveCarrierAgentCandidates(carrierCode, portUnlocode);
  return candidates[0] || null;
}

// Finds every distinct run of legs covering pol->pod as one connected journey, one match per
// contract_routings group. Legs are grouped by routing_id FIRST — '' (the column default) is one
// implicit group, which is every leg on every contract that predates the multi-routing feature —
// so genuinely alternative routings for the same lane are never confused with each other, and a
// legacy contract's legs are never split across groups they were never assigned to.
//
// Within one group, contracts in this app store legs in two different shapes: sequential TSP hops
// of ONE journey (leg[i].pod === leg[i+1].pol, e.g. NLRTM->BEANR->USNYC) and independent ALTERNATE
// LANES bundled under the same group (unrelated pol/pod pairs, e.g. an Asia-Europe lane and a
// separate Europe-US lane sharing the implicit '' routing on a contract created before named
// routings existed) — a fixed "whole array is one chain" assumption breaks the second shape. So:
// try every possible starting leg whose pol matches the query, walk forward only while consecutive
// legs actually connect, and stop as soon as that walked run's pod reaches the query pod — that's
// the natural boundary of one lane. Unlike the old single-match version, scanning continues past a
// successful match to find every other independent run in the SAME group too (this only changes
// behavior for the rare legacy contract bundling two unrelated lanes that both happen to satisfy
// the same pol/pod query — previously only the leg-order-earliest one was ever visible). Haulage
// only attaches at the outer edges of a matched run: the first leg's POL haulage (pre-carriage into
// the run's own first port) and the last leg's POD haulage (on-carriage out of its own last port)
// — never the legs in between. A single-leg run is the simple case.
const findMatchingContractLegs = async (legs, { pol, pod, needsPolHaulage, needsPodHaulage, pkuLocation = '', delLocation = '' }) => {
  if (legs.length === 0) return [];
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const pkuU = pkuLocation.toUpperCase(), delU = delLocation.toUpperCase();

  // linkedPortCodes is async (a real query) — pre-resolve every distinct linked-allowed leg
  // port up front so the actual matching walk below can stay synchronous.
  const linkedCache = new Map();
  const distinctPorts = new Set();
  for (const leg of legs) {
    if (leg.pol_linked_allowed) distinctPorts.add(leg.pol);
    if (leg.pod_linked_allowed) distinctPorts.add(leg.pod);
  }
  await Promise.all([...distinctPorts].map(async p => linkedCache.set(p, await linkedPortCodes(p))));

  const polMatches = leg => (leg.pol_linked_allowed ? [leg.pol, ...(linkedCache.get(leg.pol) || [])] : [leg.pol]).includes(polU);
  const podMatches = leg => (leg.pod_linked_allowed ? [leg.pod, ...(linkedCache.get(leg.pod) || [])] : [leg.pod]).includes(podU);

  const haulageOk = (first, last) => {
    if (needsPolHaulage) {
      if (!first.pol_carrier_haulage) return false;
      if (first.pol_haulage_locations) {
        const allowed = first.pol_haulage_locations.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
        if (allowed.length > 0 && pkuU && !allowed.includes(pkuU)) return false;
      }
    }
    if (needsPodHaulage) {
      if (!last.pod_carrier_haulage) return false;
      if (last.pod_haulage_locations) {
        const allowed = last.pod_haulage_locations.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
        if (allowed.length > 0 && delU && !allowed.includes(delU)) return false;
      }
    }
    return true;
  };

  const groups = new Map();
  for (const leg of legs) {
    const key = leg.routing_id || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(leg);
  }

  const matches = [];
  for (const [routingId, groupLegs] of groups) {
    const ordered = [...groupLegs].sort((a, b) => a.leg_order - b.leg_order);
    for (let i = 0; i < ordered.length; i++) {
      if (!polMatches(ordered[i])) continue;
      let j = i;
      for (;;) {
        if (podMatches(ordered[j])) {
          if (haulageOk(ordered[i], ordered[j])) {
            matches.push({ routingId, legs: ordered.slice(i, j + 1), firstLeg: ordered[i], lastLeg: ordered[j],
              matchKind: (ordered[i].pol === polU && ordered[j].pod === podU) ? "exact" : "linked" });
          }
          break; // reached the query pod (haulage ok or not) — this lane is done, try the next start
        }
        const next = ordered[j + 1];
        if (!next || ordered[j].pod !== next.pol) break; // chain doesn't continue — dead end
        j++;
      }
    }
  }
  return matches;
};

// ─── Role helpers (hoisted from inline routes so ctx can include them) ────────

const VALID_ROLES  = ["admin", "operator", "occ_bk", "trade_manager", "viewer"];
const ROLE_RANK_SV = { viewer: 0, occ_bk: 1, trade_manager: 1, operator: 2, admin: 3 };
const primaryRoleSV  = (roles) => [...roles].sort((a, b) => ROLE_RANK_SV[b] - ROLE_RANK_SV[a])[0] || 'viewer';
const parseUserRoles = (u) => JSON.parse(u.roles || JSON.stringify([u.role || 'viewer']));

// ─── WebSocket broadcast helpers (hoisted; shipmentSubs pre-declared above) ───

const broadcastMessage = (shipmentId, payload) => {
  const subs = shipmentSubs.get(shipmentId);
  if (!subs) return;
  const frame = JSON.stringify({ type: "new_message", message: payload });
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
};

const broadcastEditLockChange = (shipmentId, payload) => {
  const subs = shipmentSubs.get(shipmentId);
  if (!subs) return;
  const frame = JSON.stringify({ type: "edit_lock_changed", shipmentId, ...payload });
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
};

const recomputeSpaceBadge = async shipmentId => {
  try {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
    if (!shipment) return;
    let badge = '';
    if (shipment.allocation_id) {
      const [alloc] = await query("SELECT * FROM allocations WHERE id=$1", [shipment.allocation_id]);
      if (alloc) {
        const [{ shipment_teu }] = await query(
          "SELECT COALESCE(SUM(CASE WHEN size='20' THEN 1 WHEN size IN ('40','45') THEN 2 ELSE 0 END),0) AS shipment_teu FROM containers WHERE shipment_id=$1", [shipmentId]
        );
        const [{ other_teu }] = await query(
          "SELECT COALESCE(SUM(CASE WHEN c.size='20' THEN 1 WHEN c.size IN ('40','45') THEN 2 ELSE 0 END),0) AS other_teu FROM containers c JOIN shipments s ON s.id=c.shipment_id WHERE s.allocation_id=$1 AND s.id!=$2",
          [shipment.allocation_id, shipmentId]
        );
        const remaining = Math.max(0, alloc.allocated_teu - Number(other_teu));
        if (Number(shipment_teu) > remaining)  badge = 'exceeded';
        else if (shipment.space_overage_reason) badge = 'warning';
      }
    }
    if (badge !== (shipment.space_badge || '')) {
      await query("UPDATE shipments SET space_badge=$1 WHERE id=$2", [badge, shipmentId]);
      const subs = shipmentSubs.get(shipmentId);
      if (subs) {
        const frame = JSON.stringify({ type: "space_badge_update", badge });
        for (const ws of subs) if (ws.readyState === ws.OPEN) ws.send(frame);
      }
    }
  } catch { /* non-fatal */ }
};

// ─── Contract rate → charge code mapping (hoisted so importContractRates + ctx are together) ─
// charge_code is plain TEXT (no backend enum) — CHARGE_CODES in ShipmentDetailPage.jsx is only
// a client-side suggestion list for a manually-typed NEW cost line, it doesn't constrain what a
// contract-generated line can carry. This previously only recognized 6 of the 17 service codes
// MdmContractsPage.jsx's own rate-entry UI offers (SERVICE_CODES) — every surcharge code (BAF,
// CAF, EBS, PSS, ISPS, WRS, SCS, AMS, ENS, IMO) fell through to the generic literal 'Other',
// losing its specific identity on the resulting cost line's structured charge_code field (the
// original code/description survived only in the line's free-text notes) — meaning the GP
// Overview's "by charge code" breakdown could never distinguish a bunker surcharge from a peak-
// season surcharge from a war-risk surcharge, they all just landed in one 'Other' bucket.
const SERVICE_CODE_MAP = {
  OF: 'Ocean Freight', OCF: 'Ocean Freight',
  BAF: 'Bunker Adjustment Factor',
  CAF: 'Currency Adjustment Factor',
  EBS: 'Emergency Bunker Surcharge',
  'THC-O': 'Origin THC', THC: 'Origin THC', OTHC: 'Origin THC', ORI: 'Origin THC',
  'THC-D': 'Destination THC', DTHC: 'Destination THC', DEST: 'Destination THC',
  BL: 'B/L Fee', BLF: 'B/L Fee', DOC: 'B/L Fee',
  AMS: 'Advance Manifest Surcharge',
  ENS: 'Entry Summary Declaration',
  IMO: 'IMO/DG Surcharge',
  PSS: 'Peak Season Surcharge',
  ISPS: 'ISPS Security Surcharge',
  CUC: 'Carrier Uplift Charge',
  WRS: 'War Risk Surcharge',
  SCS: 'Suez Canal Surcharge',
  CUS: 'Customs', CUST: 'Customs',
  INL: 'Inland', INLAND: 'Inland',
  DET: 'Detention', DEM: 'Demurrage',
};

// The Contract Management Service returns rates through its own mapRate (camelCase, same field
// names as lib/mappers.js's copy) — converts one back to the snake_case row shape the insert
// loop below (and the valid_from/valid_to filter above it) already expects, so that loop doesn't
// need two implementations depending on contract_source.
const rateToRow = r => ({
  routing_id: r.routingId || '', service_code: r.serviceCode || '', description: r.description || '',
  amount: r.amount, currency: r.currency || 'USD', amount_usd: r.amountUsd, unit: r.unit || 'per_container',
  container_type: r.containerType || '', notes: r.notes || '', valid_from: r.validFrom || '', valid_to: r.validTo || '',
});

// Freezes a copy of contract_rates at the point they're committed to a shipment. Later edits to
// contract_rates in MDM never rewrite what was already quoted — "Reset to Contract" replays this
// frozen snapshot, and "Update Carrier Costs" is the only action that generates a new one. See TKT-6QT30S.
// The snapshot itself is always a local write regardless of contract_source — it's a monolith-
// owned freeze of whatever the live rates said at commit time, not a mirror of the source's own
// storage. async because 'remote' mode resolves the live rates via a network call to the Contract
// Management Service first — callers must await this (see e.g. routes/shipment-ops.js's
// import-contract route, which resolves the snapshot BEFORE opening its own write transaction,
// same reasoning as saveRates in routes/contracts.js: never hold a transaction open across a
// network call).
async function createRateSnapshot(shipmentId, contractId, reason, generatedBy = '') {
  const today = new Date().toISOString().slice(0, 10);
  // Scoped to the shipment's own stored contract_routing_id (which named routing was actually
  // assigned) plus contract-wide routing_id='' rows (e.g. a flat documentation fee that applies
  // regardless of routing) — never every rate on the whole contract. A shipment that predates
  // multi-routing contracts has contract_routing_id='', and every rate on a contract that
  // predates named routings also has routing_id='' by column default, so this condition selects
  // every rate on the contract for that combination — identical to this function's pre-routing
  // behavior.
  const [routingRow] = await query("SELECT contract_routing_id FROM shipments WHERE id=$1", [shipmentId]);
  const routingId = routingRow?.contract_routing_id || '';
  // A rate line's own valid_from/valid_to (blank on both ends = inherits the parent contract's
  // already-enforced window) — a mid-contract surcharge that hasn't started yet, or one that's
  // already lapsed, is excluded from a freshly-generated snapshot. Already-frozen snapshots on
  // other shipments are unaffected — this only ever gates what goes INTO a new one.
  let allRates;
  if (((await getSettings()).contract_source || 'local') === 'remote') {
    try { allRates = (await callContractService("GET", `/internal/contracts/${contractId}`)).rates.map(rateToRow); }
    catch { allRates = []; } // an unreachable/vanished remote contract yields no rates to snapshot, not a hard failure
  } else {
    allRates = await query("SELECT * FROM contract_rates WHERE contract_id=$1 AND (routing_id=$2 OR routing_id='') ORDER BY sort_order", [contractId, routingId]);
  }
  const rates = allRates
    .filter(r => r.routing_id === routingId || !r.routing_id)
    .filter(r => (!r.valid_from || r.valid_from <= today) && (!r.valid_to || r.valid_to >= today));
  if (!rates.length) return null;
  const snapshotId = `RATE-${uid()}`;
  const now = new Date().toISOString();
  await query("INSERT INTO shipment_rate_snapshots (id,shipment_id,contract_id,generated_at,generated_by,reason) VALUES ($1,$2,$3,$4,$5,$6)",
    [snapshotId, shipmentId, contractId, now, generatedBy, reason]);
  for (const r of rates) {
    await query(`INSERT INTO shipment_rate_snapshot_lines
      (id,snapshot_id,service_code,description,amount,currency,amount_usd,unit,container_type,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [`RSL-${uid()}`, snapshotId, r.service_code || '', r.description || '', r.amount,
       r.currency || 'USD', r.amount_usd, r.unit || 'per_container', r.container_type || '', r.notes || '']);
  }
  await logEntityEvent('rate_snapshot', snapshotId, 'GENERATED', null, null, null,
    JSON.stringify({ shipmentId, contractId, reason, lineCount: rates.length }));
  return snapshotId;
}

// Generates shipment_cost_lines from a frozen rate snapshot (not live contract_rates). Same
// line-generation logic importContractRates always used — container matching, per-container
// split, SERVICE_CODE_MAP lookup — just sourced from shipment_rate_snapshot_lines.
async function generateCostLinesFromSnapshot(shipmentId, snapshotId, { splitPerContainer = false, includeSell = false } = {}) {
  const lines = await query("SELECT * FROM shipment_rate_snapshot_lines WHERE snapshot_id=$1", [snapshotId]);
  if (!lines.length) return 0;
  const ctrs = await query("SELECT id, container_number, size, type FROM containers WHERE shipment_id=$1", [shipmentId]);
  const now = new Date().toISOString();
  let created = 0;
  for (const r of lines) {
    const chargeCode   = SERVICE_CODE_MAP[r.service_code?.toUpperCase()] || 'Other';
    const exchangeRate = (r.amount > 0 && r.amount_usd > 0) ? Math.round((r.amount_usd / r.amount) * 100000) / 100000 : 1;
    const baseNotes    = [r.service_code, r.description].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' — ');
    const applicableCtrs = r.container_type
      ? ctrs.filter(c => `${c.size || ''}${c.type || ''}`.toUpperCase() === r.container_type.toUpperCase())
      : ctrs;
    if (r.unit === 'per_container' && r.container_type && applicableCtrs.length === 0) continue;
    const insertLine = async (type, amount, notes, containerId) => {
      const lineId = `CL-${uid()}`;
      await query("INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,notes,container_id,created_at,source,rate_snapshot_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [lineId, shipmentId, type, chargeCode, r.currency || 'USD', amount, exchangeRate, notes, containerId, now, 'contract', snapshotId]);
      await logEntityEvent('cost_line', lineId, 'IMPORTED', null, null, null,
        JSON.stringify({ shipmentId, chargeCode, currency: r.currency || 'USD', amount, exchangeRate, containerId, snapshotId }));
      created++;
    };
    if (r.unit === 'per_container' && splitPerContainer && applicableCtrs.length > 0) {
      for (const c of applicableCtrs) {
        const cLabel = c.container_number
          ? `${c.container_number}${c.size || c.type ? ` (${c.size}${c.type})` : ''}`
          : `(${c.size || ''}${c.type || ''})`;
        const notes = [cLabel, baseNotes].filter(Boolean).join(' — ');
        await insertLine('BUY', r.amount, notes, c.id);
        if (includeSell) await insertLine('SELL', r.amount, notes, c.id);
      }
    } else {
      const containerCount = r.unit === 'per_container' ? (applicableCtrs.length || 1) : 1;
      const amount = r.unit === 'per_container' ? r.amount * containerCount : r.amount;
      await insertLine('BUY', amount, baseNotes, '');
      if (includeSell) await insertLine('SELL', amount, baseNotes, '');
    }
  }
  return created;
}

// Thin wrapper for the "first import" case — if the shipment has no rate snapshot yet, creates
// an 'initial' one, then generates cost lines from it. Existing callers (shipment creation with a
// Central contract, the one-time import-contract endpoint) go through this unchanged; they don't
// need to know about snapshots. Reset/Update Carrier Costs (routes/shipment-ops.js) call
// createRateSnapshot/generateCostLinesFromSnapshot directly since they need explicit control over
// which snapshot is used.
async function importContractRates(shipmentId, opts = {}) {
  const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
  if (!shipment || shipment.contract_type !== 'Central' || !shipment.contract_id) return 0;
  const [existing] = await query("SELECT id FROM shipment_rate_snapshots WHERE shipment_id=$1 ORDER BY generated_at DESC LIMIT 1", [shipmentId]);
  const snapshotId = existing ? existing.id : await createRateSnapshot(shipmentId, shipment.contract_id, 'initial');
  if (!snapshotId) return 0;
  return await generateCostLinesFromSnapshot(shipmentId, snapshotId, opts);
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

// In-memory nonce store for SSO OAuth2 state parameter (TTL = 5 min)
const ssoNonces = new Map();
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [k, v] of ssoNonces) if (v.ts < cutoff) ssoNonces.delete(k);
}, 60_000);

const auth = (allowed = []) => async (req, res, next) => {
  const header = req.headers["authorization"];
  if (!header?.startsWith("Bearer ")) return err(res, "Unauthorized", 401);
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    // support old single-role tokens and new multi-role tokens
    payload.roles = Array.isArray(payload.roles) ? payload.roles
      : (payload.role ? [payload.role] : ['viewer']);
    if (allowed.length && !allowed.some(r => payload.roles.includes(r)))
      return err(res, "Forbidden", 403);
    // token_version check — invalidates tokens issued before a revoke
    if (payload.tv != null) {
      const [row] = await query("SELECT token_version, is_active FROM users WHERE id=$1", [payload.id]);
      if (!row || !row.is_active) return err(res, "Account inactive", 401);
      if (row.token_version !== payload.tv) return err(res, "Session revoked — please sign in again", 401);
    }
    req.user = payload;
    next();
  } catch { err(res, "Invalid or expired token", 401); }
};

// Role check only (token already verified by global middleware)
const requireRole = (allowed) => (req, res, next) =>
  req.user?.roles?.some(r => allowed.includes(r)) ? next() : err(res, "Forbidden", 403);

// Require valid token on all /api/* except /api/auth/*, /api/health, and /api/share/* (public)
app.use("/api", (req, res, next) =>
  req.path.startsWith("/auth/") || req.path === "/health" || req.path.startsWith("/share/") ? next() : auth()(req, res, next)
);

// ─── Shared context passed to every route module ───────────────────────────────

const aisListener = createAisListener({
  query, transaction, getSettings, broadcastMessage, logEntityEvent, uid, syncShipmentFromLegs, callMdmService,
  schemaReady: schemaReadyPromise,
});

const ctx = {
  // Captured here (not re-read later) so a route file's own one-time startup sweep — anything
  // that fires an un-awaited query the moment `require('./routes/x')(app, ctx)` runs, before
  // httpServer.listen()'s own schemaReadyPromise gate — can defer its first run until the base
  // schema actually exists, the same real ordering bug the AIS listener's initial cache load hit.
  // Later schemaReadyPromise reassignments (chained seed/bootstrap steps further down this file)
  // aren't needed for this — every route-level sweep only depends on tables existing, which this
  // already guarantees.
  schemaReady: schemaReadyPromise,
  query, transaction, uid, ok, err, isUniqueViolation, validCoord,
  auth, requireRole,
  portLanesMap, portCountryMap, rebuildPortLanesMap, longestLane,
  applyShipmentAccessFilter,
  fxCache, getFxRates, toUsd, roundCents,
  sanctionsMap, loadSanctionsIndex, syncOfacSdn, scheduleNextOfacSync,
  syncConsolidatedScreeningList, scheduleNextCslSync,
  normSanctionName, EMBARGOED_COUNTRIES,
  getSettings,
  shipmentSubs, broadcastMessage, broadcastEditLockChange, recomputeSpaceBadge,
  UPLOADS_DIR,
  renderHtmlToPdf, getActiveSigningCert, signPdfBuffer,
  createTransporterFromSettings, getTransporterForOffice, invalidateTransporterCache,
  buildMailOptions, sendViaOffice, mapOfficeMailSettings, mapSystemEmailSettings,
  SVC_ABBR, LEG_LOC_ABBR, GPS_LOC_TYPE,
  VALID_ROLES, ROLE_RANK_SV, primaryRoleSV, parseUserRoles,
  SERVICE_CODE_MAP, importContractRates, createRateSnapshot, generateCostLinesFromSnapshot,
  mapShipment, mapShipmentLeg, mapCostLine, mapService, mapContainer, mapContainerEvent, mapContainerPackage, mapAllocation,
  mapShipmentParty, ADDITIONAL_PARTY_ROLES, mapSideOffice,
  mapRateSnapshot, mapRateSnapshotLine, mapChargeCodeDefinition, mapPackTypeDefinition, mapDutyRateChapter, mapScheduledReport, mapContainerTypeDefinition,
  mapCarrier, mapVessel, mapPortLocation, mapLinkedPort, mapTradeLane, mapCarrierAgent, mapCarrierAgentScheduleRow,
  mapScopeItem, mapAccessConfig, mapOffice, mapBranch, mapOrgCountry, mapRegion, mapCountry, mapTicketLink, mapTicket,
  mapTestItem, mapTestCaseLink,
  mapEdiMessage,
  mapCarrierBooking, BOOKABLE_CARRIERS, isEdiBookable, mapEadapterConfig,
  mapCustomsFiling, CUSTOMS_FILING_TYPES,
  mapKbProject, mapKbVersion, mapKbColumn,
  mapCustomer, mapCustomerIdentifier, mapCustomerScreening, mapCustomerDoc, mapCustomerContact,
  mapCommodity, mapSystemMessage, mapMilestone, mapMilestoneTemplate,
  mapContract, mapLeg, mapRate, mapContractRouting, mapCarrierInvoice, mapCarrierInvoiceLine,
  mapQuote, mapQuoteLine, mapOpportunity,
  mapInvoiceReasonCode, mapInvoiceStatusOverride,
  resolveInvoiceThresholds, runInvoiceCollectionsSweep, addBusinessDays, businessDaysBetween,
  logEvent, logEntityEvent, logAdminEvent, TRACKED_FIELDS, TRACKED_CTR_FIELDS,
  seedAdmin, seedTestFixtureAdmin, seedSigningCert,
  CUTOFF_WARNING_DAYS, FREE_TIME_WARNING_DAYS,
  ssoNonces,
  syncShipmentFromLegs,
  restartAisListener: aisListener.applySettings,
  ingestAisMessage: aisListener.ingestMessage,
  getAisListenerStatus: aisListener.getStatus,
  forceRefreshAisTrackedLegs: aisListener.forceRefreshTrackedLegs,
  checkOverlap,
  autoCompleteMilestone,
  ensureBookingCreated, supersedeIfCarrierChanged,
  runOpsAutomationSweep,
  linkedPortCodes, findMatchingContractLegs, resolveCarrierAgent, resolveCarrierAgentCandidates,
  screenShipmentById, rescreenActiveShipments, resolveCustomerGroup,
  computeArExposure, docAmountUsd, runDunningSweep, runScheduledReportsSweep, matchesScopeItem, userOwnsLaneForShipment, userOwnsLaneForCustomer,
  canEditOfficeSide,
  OVERRIDE_GRACE_MS,
  bcrypt, jwt, JWT_SECRET,
  DISTRIBUTION_SERVICE_URL, DISTRIBUTION_SERVICE_SECRET,
  PDF_RENDER_SERVICE_URL,
  CONTRACT_SERVICE_URL, CONTRACT_SERVICE_SECRET, callContractService,
  MDM_SERVICE_URL, MDM_SERVICE_SECRET, callMdmService,
  SCREENING_SERVICE_URL, SCREENING_SERVICE_SECRET, callScreeningService,
  KANBAN_SERVICE_URL, KANBAN_SERVICE_SECRET, callKanbanService, resolveAssigneeNames,
  CUSTOMER_SERVICE_URL, CUSTOMER_SERVICE_SECRET, callCustomerService, getCustomerRow,
  inverseLinkLabel,
  fs, path,
  migrationFailures,
  createRateLimiter,
};

require('./routes/auth')(app, ctx);
require('./routes/shipments')(app, ctx);
require('./routes/allocations')(app, ctx);
require('./routes/mdm')(app, ctx);
require('./routes/sanctions')(app, ctx);
require('./routes/kanban')(app, ctx);
require('./routes/testcases')(app, ctx);
require('./routes/edi')(app, ctx);
require('./routes/customs-filing')(app, ctx);
require('./routes/customers')(app, ctx);
require('./routes/contracts')(app, ctx);
require('./routes/shipment-ops')(app, ctx);
require('./routes/carrier-invoices')(app, ctx);
require('./routes/quotes')(app, ctx);
require('./routes/opportunities')(app, ctx);
require('./routes/admin-reset')(app, ctx);
require('./routes/finance')(app, ctx);
require('./routes/reports')(app, ctx);
require('./routes/command-center')(app, ctx);
require('./routes/invoice-reason-codes')(app, ctx);
require('./routes/system')(app, ctx);
require('./routes/export')(app, ctx);
require('./routes/ai')(app, ctx);
require('./routes/share')(app, ctx);
require('./routes/offices')(app, ctx);
require('./routes/office-mail')(app, ctx);
require('./routes/eadapter')(app, ctx);
require('./routes/document-distribution')(app, ctx);
require('./routes/organization')(app, ctx);
require('./routes/charge-codes')(app, ctx);
require('./routes/pack-types')(app, ctx);
require('./routes/container-types')(app, ctx);
require('./routes/duty-rates')(app, ctx);
require('./routes/scheduled-reports')(app, ctx);
require('./routes/ais')(app, ctx);

// ─── Static frontend (production only) ─────────────────────────────────────────
// Local dev never hits this — Vite's own dev server (npm run client) serves the frontend and
// proxies /api + /ws to this process instead (vite.config.js). In production there's no Vite
// dev server running at all, so this process needs to serve the already-built dist/ itself.
// Registered after every /api/* route above, so an unmatched /api/* path still 404s normally
// instead of falling through to index.html.
if (process.env.NODE_ENV === "production") {
  const distDir = path.join(__dirname, "dist");
  app.use(express.static(distDir));
  // SPA fallback: any non-API, non-WS path (including a hard refresh on a hash route, or a
  // path Express's own router didn't match) gets index.html — the app's own client-side hash
  // routing takes it from there. Must be registered last.
  app.get(/^(?!\/api|\/ws).*/, (req, res) => res.sendFile(path.join(distDir, "index.html")));
}

// Crash-safety net, part 3: the actual Express error-handling middleware (4-arg signature is
// what tells Express this is one) — must be registered after every other app.use/get/post/etc.
// call to catch errors from all of them. Two cases:
//  - A malformed JSON body (e.g. a literal `null`, or truncated JSON) previously reached the
//    client as body-parser's raw HTML stack trace — full internal file paths, before auth was
//    even checked, on any route. Now a clean, consistent JSON 400.
//  - Anything forwarded here via wrapAsyncHandler (part 1) or a background job (part 2 handles
//    those instead) — an unexpected error the specific route didn't already turn into a clean
//    `err(res, ...)` response itself. Logged in full server-side; the client gets a generic
//    message, never the raw error/stack (which could leak internal file paths or query detail).
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({ error: "Malformed request body — expected valid JSON" });
  }
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, error);
  res.status(error?.status || 500).json({ error: "Internal server error" });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// shipmentSubs is pre-declared near portLanesMap above so route modules can receive it via ctx.

// The /ws endpoint has no auth at all (by design — it's a plain shipment-update fanout, not a
// place secrets flow through) and previously had no cap of any kind — a single client could open
// unlimited connections or flood "subscribe" frames with zero pushback. Two independent, cheap
// guards: a per-IP concurrent-connection cap (protects against a connection-exhaustion flood) and
// a per-connection message-rate cap (protects against a single open socket spamming frames).
const WS_MAX_CONN_PER_IP = Number(process.env.WS_MAX_CONN_PER_IP) || 20;
const WS_MSG_WINDOW_MS = 10_000;
const WS_MSG_RATE_MAX = Number(process.env.WS_MSG_RATE_MAX) || 30;
const wsConnCountByIp = new Map(); // ip -> open connection count

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress || "unknown";
  if ((wsConnCountByIp.get(ip) || 0) >= WS_MAX_CONN_PER_IP) {
    ws.close(1013, "Too many connections from this address");
    return;
  }
  wsConnCountByIp.set(ip, (wsConnCountByIp.get(ip) || 0) + 1);

  let subscribedId = null;
  let msgCount = 0;
  let msgWindowStart = Date.now();

  ws.on("message", raw => {
    const now = Date.now();
    if (now - msgWindowStart > WS_MSG_WINDOW_MS) { msgWindowStart = now; msgCount = 0; }
    msgCount++;
    if (msgCount > WS_MSG_RATE_MAX) { ws.close(1013, "Message rate exceeded"); return; }
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "subscribe" && msg.shipmentId) {
        subscribedId = msg.shipmentId;
        if (!shipmentSubs.has(subscribedId)) shipmentSubs.set(subscribedId, new Set());
        shipmentSubs.get(subscribedId).add(ws);
      }
    } catch { /* ignore malformed frames */ }
  });

  ws.on("close", () => {
    const remaining = (wsConnCountByIp.get(ip) || 1) - 1;
    if (remaining <= 0) wsConnCountByIp.delete(ip); else wsConnCountByIp.set(ip, remaining);
    if (subscribedId && shipmentSubs.has(subscribedId)) {
      const subs = shipmentSubs.get(subscribedId);
      subs.delete(ws);
      if (subs.size === 0) shipmentSubs.delete(subscribedId);
    }
  });
});

// Outbound AIS listener (TKT-ZFO2OM) — settings-gated (api_ais_enabled + a key), no-ops
// cleanly if unconfigured. Wrapped defensively so a bad config can never take the HTTP
// server down with it, same "fail soft" contract external integrations follow elsewhere.
schemaReadyPromise
  .then(() => ctx.restartAisListener())
  .catch(e => console.error("AIS listener bootstrap failed:", e.message));

// ─── Start ────────────────────────────────────────────────────────────────────
// Every schema/seed/bootstrap step chained onto schemaReadyPromise throughout this file (initial
// schema creation, account seeding, settings defaults, MDM backfills, carrier-booking backfill)
// must complete before the server starts accepting traffic — a request landing mid-bootstrap
// against a still-empty or partially-seeded database is worse than a slightly slower cold start.

const PORT = 3001;
schemaReadyPromise
  .then(() => httpServer.listen(PORT, () => console.log(`⚓  CargoDesk API + WS running on http://localhost:${PORT}`)))
  .catch(e => { console.error("Failed to initialize database:", e); process.exit(1); });
