"use strict";
const express = require("express");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { registerChannel, distribute } = require("./lib/channels");
const { isUrlSafe, sendWebhook } = require("./lib/webhookSender");
const { readSecret } = require("./lib/dockerSecret");

const PORT = process.env.DISTRIBUTION_SERVICE_PORT || 3002;
const SERVICE_SECRET_DEV_DEFAULT = "cargoDesk-dev-distribution-secret-do-not-use-in-prod";
const SERVICE_SECRET = readSecret("DISTRIBUTION_SERVICE_SECRET", SERVICE_SECRET_DEV_DEFAULT);
if (SERVICE_SECRET === SERVICE_SECRET_DEV_DEFAULT)
  console.warn("⚠  DISTRIBUTION_SERVICE_SECRET not set (checked DISTRIBUTION_SERVICE_SECRET_FILE, then DISTRIBUTION_SERVICE_SECRET) — using insecure dev default. Set it (and the same value in the monolith's env) before deploying.");

const app = express();
const db = new DatabaseSync(path.join(__dirname, "distribution.db"));
app.use(express.json({ limit: "5mb" }));

const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const ok = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });

db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS webhook_configs (
    id           TEXT PRIMARY KEY,
    scope_id     TEXT NOT NULL UNIQUE,
    webhook_url  TEXT NOT NULL DEFAULT '',
    secret       TEXT NOT NULL DEFAULT '',
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS edi_transmittals (
    id              TEXT PRIMARY KEY,
    shipment_id     TEXT NOT NULL,
    document_id     TEXT NOT NULL,
    doc_type        TEXT DEFAULT '',
    filename        TEXT DEFAULT '',
    size_bytes      INTEGER DEFAULT 0,
    checksum        TEXT DEFAULT '',
    recipient_code  TEXT DEFAULT '',
    recipient_label TEXT DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'sent',
    created_at      TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           TEXT PRIMARY KEY,
    shipment_id  TEXT NOT NULL,
    document_id  TEXT NOT NULL,
    scope_id     TEXT NOT NULL,
    webhook_url  TEXT NOT NULL,
    status       TEXT NOT NULL,
    http_status  INTEGER,
    error        TEXT DEFAULT '',
    payload      TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
`);

// Public liveness check — no secret required, mirrors the monolith's own GET /api/health.
app.get("/health", (req, res) => ok(res, { status: "ok", service: "document-distribution", uptime: process.uptime() }));

// Everything else under /internal/* requires the shared service-to-service secret. This service
// is never called from the browser — only from the monolith's own route handlers.
app.use("/internal", (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== SERVICE_SECRET) return err(res, "Unauthorized", 401);
  next();
});

// ─── Webhook config CRUD (per opaque scope id — the monolith's office id, never validated here) ──

app.get("/internal/webhook-configs/:scopeId", (req, res) => {
  const row = db.prepare("SELECT * FROM webhook_configs WHERE scope_id=?").get(req.params.scopeId);
  // isActive defaults true for a never-configured scope, matching office_mail_settings'
  // own DEFAULT_SETTINGS convention (routes/office-mail.js) — found live via CDP verification:
  // the frontend form always sends an explicit isActive value seeded from this GET response, so
  // defaulting false here meant a brand-new webhook silently saved as inactive even though the
  // PUT route's own isActive=true default (line below) was never actually reachable in practice.
  if (!row) return ok(res, { scopeId: req.params.scopeId, webhookUrl: "", isActive: true, hasSecret: false });
  ok(res, { scopeId: row.scope_id, webhookUrl: row.webhook_url, isActive: !!row.is_active, hasSecret: !!row.secret });
});

app.put("/internal/webhook-configs/:scopeId", (req, res) => {
  const { webhookUrl = "", secret, isActive = true } = req.body || {};
  if (webhookUrl && !isUrlSafe(webhookUrl)) return err(res, "Webhook URL must be https and not point at a private/internal address");
  const existing = db.prepare("SELECT * FROM webhook_configs WHERE scope_id=?").get(req.params.scopeId);
  const now = new Date().toISOString();
  const finalSecret = secret != null && secret !== "" ? secret : (existing?.secret || "");
  if (existing) {
    db.prepare("UPDATE webhook_configs SET webhook_url=?, secret=?, is_active=?, updated_at=? WHERE scope_id=?")
      .run(webhookUrl, finalSecret, isActive ? 1 : 0, now, req.params.scopeId);
  } else {
    db.prepare("INSERT INTO webhook_configs (id, scope_id, webhook_url, secret, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(`WHC-${uid()}`, req.params.scopeId, webhookUrl, finalSecret, isActive ? 1 : 0, now, now);
  }
  const row = db.prepare("SELECT * FROM webhook_configs WHERE scope_id=?").get(req.params.scopeId);
  ok(res, { scopeId: row.scope_id, webhookUrl: row.webhook_url, isActive: !!row.is_active, hasSecret: !!row.secret });
});

app.post("/internal/webhook-configs/:scopeId/test", async (req, res) => {
  const { webhookUrl, secret } = req.body || {};
  if (!webhookUrl) return err(res, "webhookUrl is required");
  if (!isUrlSafe(webhookUrl)) return err(res, "Webhook URL must be https and not point at a private/internal address");
  try {
    const result = await sendWebhook(webhookUrl, { event: "test", scopeId: req.params.scopeId, timestamp: new Date().toISOString() }, secret || "");
    if (!result.ok) return err(res, `Receiver responded with HTTP ${result.httpStatus}`, 502);
    ok(res, { sent: true, httpStatus: result.httpStatus });
  } catch (e) { err(res, e.message, 502); }
});

// ─── Channel handlers ──────────────────────────────────────────────────────────────────────────

registerChannel("edi", async ({ shipmentId, documentId, docType, filename, sizeBytes, checksum, recipientCode, recipientLabel }) => {
  const id = `EDIT-${uid()}`;
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO edi_transmittals
    (id, shipment_id, document_id, doc_type, filename, size_bytes, checksum, recipient_code, recipient_label, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, shipmentId, documentId, docType || "", filename || "", sizeBytes || 0, checksum || "", recipientCode || "", recipientLabel || "", "sent", createdAt);
  return { transmittalId: id, status: "sent", sentAt: createdAt };
});

registerChannel("webhook", async ({ shipmentId, documentId, docType, filename, scopeId, downloadUrl }) => {
  const config = db.prepare("SELECT * FROM webhook_configs WHERE scope_id=? AND is_active=1").get(scopeId);
  if (!config || !config.webhook_url) {
    const e = new Error("No active webhook configured for this office");
    e.status = 400;
    throw e;
  }
  const payload = { event: "document.distributed", documentId, docType, filename, shipmentId, downloadUrl, timestamp: new Date().toISOString() };
  const id = `WHD-${uid()}`;
  const createdAt = new Date().toISOString();

  // Exactly one INSERT regardless of outcome — network-level failures (sendWebhook itself
  // throwing: DNS, timeout) and HTTP-level failures (a reachable receiver returning non-2xx)
  // both fall through to the same single write below, rather than each having their own INSERT
  // (the original version double-inserted the same id on an HTTP-level failure, since it wrote
  // once inside the try block and then again after re-throwing into the catch — a real bug
  // caught live via manual verification, surfacing as a UNIQUE constraint violation).
  let status, httpStatus = null, errorMsg = "";
  try {
    const result = await sendWebhook(config.webhook_url, payload, config.secret);
    status = result.ok ? "sent" : "failed";
    httpStatus = result.httpStatus;
    if (!result.ok) errorMsg = `Receiver responded with HTTP ${result.httpStatus}`;
  } catch (e) {
    status = "failed";
    errorMsg = e.message;
  }
  db.prepare(`INSERT INTO webhook_deliveries
    (id, shipment_id, document_id, scope_id, webhook_url, status, http_status, error, payload, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, shipmentId, documentId, scopeId, config.webhook_url, status, httpStatus, errorMsg, JSON.stringify(payload), createdAt);

  if (status === "failed") { const e = new Error(errorMsg || "Webhook delivery failed"); e.status = 502; throw e; }
  return { deliveryId: id, status: "sent", httpStatus };
});

app.post("/internal/distribute/edi", async (req, res) => {
  const { shipmentId, documentId, docType, filename, sizeBytes, checksum, recipientCode, recipientLabel } = req.body || {};
  if (!shipmentId || !documentId) return err(res, "shipmentId and documentId are required");
  if (!recipientCode) return err(res, "recipientCode is required");
  try {
    const result = await distribute("edi", { shipmentId, documentId, docType, filename, sizeBytes, checksum, recipientCode, recipientLabel });
    ok(res, result, 201);
  } catch (e) { err(res, e.message, e.status || 500); }
});

app.post("/internal/distribute/webhook", async (req, res) => {
  const { shipmentId, documentId, docType, filename, scopeId, downloadUrl } = req.body || {};
  if (!shipmentId || !documentId || !scopeId) return err(res, "shipmentId, documentId, and scopeId are required");
  try {
    const result = await distribute("webhook", { shipmentId, documentId, docType, filename, scopeId, downloadUrl });
    ok(res, result, 201);
  } catch (e) { err(res, e.message, e.status || 502); }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`📦  Document Distribution Service running on http://localhost:${PORT}`));
}

module.exports = { app, db };
