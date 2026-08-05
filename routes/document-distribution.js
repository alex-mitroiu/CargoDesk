"use strict";

const crypto = require("crypto");
const { signToken } = require("../lib/shareToken");

// Thin monolith-side surface over the Document Distribution Service (services/document-
// distribution/) — CargoDesk's first extracted microservice. Every route here either proxies
// straight through to it or resolves the small amount of monolith-owned context (the document's
// file on disk, the shipment's EMO office) the service itself deliberately has no access to.
module.exports = function documentDistributionRoutes(app, ctx) {
  const { db, ok, err, requireRole, logEntityEvent, JWT_SECRET,
          DISTRIBUTION_SERVICE_URL, DISTRIBUTION_SERVICE_SECRET,
          UPLOADS_DIR, fs, path } = ctx;

  const shipmentWrite = requireRole(["admin", "operator", "occ_bk"]);
  const adminOnly = requireRole(["admin"]);

  // Shorter than the 30-day shipment-level tracking link (routes/share.js) — this is a one-off
  // artifact handed to a single webhook receiver at send time, not a standing customer-facing link.
  const DOC_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // Every call to the service goes through here, so a downed/unreachable service fails cleanly —
  // a clear error the UI can toast — instead of hanging the request or surfacing a raw 500.
  async function callDistributionService(method, urlPath, body) {
    let r;
    try {
      r = await fetch(`${DISTRIBUTION_SERVICE_URL}${urlPath}`, {
        method,
        headers: { Authorization: `Bearer ${DISTRIBUTION_SERVICE_SECRET}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      const e = new Error("Document Distribution Service is unreachable — try again shortly");
      e.status = 503;
      throw e;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(data.error || `Distribution service returned HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return data;
  }

  // ─── EDI transmittal ──────────────────────────────────────────────────────────────────────────

  app.post("/api/shipments/:id/documents/:docId/send-edi", shipmentWrite, async (req, res) => {
    const { recipientCode, recipientLabel } = req.body || {};
    if (!recipientCode) return err(res, "A recipient code is required");
    const doc = db.prepare("SELECT * FROM shipment_documents WHERE id=? AND shipment_id=?").get(req.params.docId, req.params.id);
    if (!doc) return err(res, "Document not found", 404);
    const filePath = path.join(UPLOADS_DIR, doc.stored_name);
    if (!fs.existsSync(filePath)) return err(res, "File not found on disk", 404);
    const checksum = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    try {
      const result = await callDistributionService("POST", "/internal/distribute/edi", {
        shipmentId: req.params.id, documentId: doc.id, docType: doc.doc_type, filename: doc.filename,
        sizeBytes: doc.size_bytes, checksum, recipientCode, recipientLabel: recipientLabel || "",
      });
      // Local shadow-copy of the audit event — the monolith's entity_events stays the single place
      // the existing generic EntityHistoryModal reads from; the full transmittal record (payload,
      // checksum) is the distribution service's own, as the owning source of truth.
      logEntityEvent('document', doc.id, 'EDI_SENT', null, null, null,
        JSON.stringify({ shipmentId: req.params.id, recipientCode, recipientLabel: recipientLabel || "", transmittalId: result.transmittalId }));
      ok(res, { sent: true, transmittalId: result.transmittalId }, 201);
    } catch (e) { err(res, e.message, e.status || 502); }
  });

  // ─── Webhook distribution ─────────────────────────────────────────────────────────────────────

  // Same EMO-only resolution the existing send-email route uses (routes/shipment-ops.js) — no
  // office picker, no silent IMO fallback.
  app.post("/api/shipments/:id/documents/:docId/send-webhook", shipmentWrite, async (req, res) => {
    const shipment = db.prepare("SELECT emo_office_id FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (!shipment.emo_office_id) return err(res, "This shipment has no Export Managing Office assigned");
    const doc = db.prepare("SELECT * FROM shipment_documents WHERE id=? AND shipment_id=?").get(req.params.docId, req.params.id);
    if (!doc) return err(res, "Document not found", 404);
    const token = signToken({ shipmentId: req.params.id, docId: doc.id, exp: Date.now() + DOC_SHARE_TTL_MS }, JWT_SECRET);
    const downloadUrl = `${req.protocol}://${req.get("host")}/api/share/document/${token}`;
    try {
      const result = await callDistributionService("POST", "/internal/distribute/webhook", {
        shipmentId: req.params.id, documentId: doc.id, docType: doc.doc_type, filename: doc.filename,
        scopeId: shipment.emo_office_id, downloadUrl,
      });
      logEntityEvent('document', doc.id, 'WEBHOOK_SENT', null, null, null,
        JSON.stringify({ shipmentId: req.params.id, officeId: shipment.emo_office_id, deliveryId: result.deliveryId }));
      ok(res, { sent: true, deliveryId: result.deliveryId }, 201);
    } catch (e) { err(res, e.message, e.status || 502); }
  });

  // ─── Office webhook settings (mirrors routes/office-mail.js almost exactly) ──────────────────

  app.get("/api/offices/:id/webhook-settings", adminOnly, async (req, res) => {
    try {
      const data = await callDistributionService("GET", `/internal/webhook-configs/${req.params.id}`);
      ok(res, { officeId: req.params.id, webhookUrl: data.webhookUrl, isActive: data.isActive, hasSecret: data.hasSecret });
    } catch (e) { err(res, e.message, e.status || 502); }
  });

  app.put("/api/offices/:id/webhook-settings", adminOnly, async (req, res) => {
    const office = db.prepare("SELECT id FROM offices WHERE id=?").get(req.params.id);
    if (!office) return err(res, "Office not found", 404);
    const { webhookUrl = "", secret, isActive = true } = req.body || {};
    if (!webhookUrl.trim()) return err(res, "Webhook URL is required");
    try {
      const data = await callDistributionService("PUT", `/internal/webhook-configs/${req.params.id}`, { webhookUrl, secret, isActive });
      ok(res, { officeId: req.params.id, webhookUrl: data.webhookUrl, isActive: data.isActive, hasSecret: data.hasSecret });
    } catch (e) { err(res, e.message, e.status || 502); }
  });

  app.post("/api/offices/:id/webhook-settings/test", adminOnly, async (req, res) => {
    const { webhookUrl, secret } = req.body || {};
    if (!webhookUrl) return err(res, "A webhook URL is required");
    try {
      const data = await callDistributionService("POST", `/internal/webhook-configs/${req.params.id}/test`, { webhookUrl, secret });
      ok(res, data);
    } catch (e) { err(res, e.message, e.status || 502); }
  });

  // ─── Test Tools Webhook Simulator — dev-only mock receiver ───────────────────────────────────

  const webhookReceiverLog = [];
  app.post("/api/test/webhook-receiver", (req, res) => {
    webhookReceiverLog.unshift({
      receivedAt: new Date().toISOString(),
      signature: req.headers["x-cargodesk-signature"] || "",
      body: req.body,
    });
    webhookReceiverLog.length = Math.min(webhookReceiverLog.length, 20);
    ok(res, { received: true });
  });
  app.get("/api/test/webhook-receiver", (req, res) => ok(res, webhookReceiverLog));
  app.delete("/api/test/webhook-receiver", (req, res) => { webhookReceiverLog.length = 0; ok(res, { cleared: true }); });
};
