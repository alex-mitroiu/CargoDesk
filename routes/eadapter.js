"use strict";

// eAdapter — per-carrier EDI connectivity configuration (carrier-EDI epic, story 1). One row per
// carrier, mirrors office-mail.js's own shape (typed transport columns, is_active, timestamps,
// blank-credential-means-keep-existing). This story is configuration + CRUD only — no live
// outbound call is attempted yet; adding an active config here only affects isEdiBookable()
// (server.js), which routes/edi.js and supersedeIfCarrierChanged already gate on.

const TRANSPORT_TYPES = ["rest_api", "as2", "sftp"];

module.exports = function eadapterRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, isUniqueViolation, mapEadapterConfig,
          getSettings, BOOKABLE_CARRIERS } = ctx;
  const write = requireRole(["admin", "operator"]);

  app.get("/api/eadapter/configs", write, (req, res) => {
    const rows = db.prepare("SELECT * FROM carrier_eadapter_configs ORDER BY carrier_code").all();
    ok(res, rows.map(mapEadapterConfig));
  });

  app.post("/api/eadapter/configs", write, (req, res) => {
    const { carrierCode, transportType = "rest_api", endpointUrl = "", authHeaderName = "",
            credential = "", isActive = true, notes = "" } = req.body || {};
    if (!carrierCode || !carrierCode.trim()) return err(res, "Carrier code is required");
    if (!TRANSPORT_TYPES.includes(transportType)) return err(res, "transportType must be rest_api, as2, or sftp");

    const id = `EAC-${uid()}`;
    const code = carrierCode.trim().toUpperCase();
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT INTO carrier_eadapter_configs
        (id, carrier_code, transport_type, endpoint_url, auth_header_name, credential, is_active, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, code, transportType, endpointUrl.trim(), authHeaderName.trim(), credential, isActive ? 1 : 0, notes, now, now);
      const row = db.prepare("SELECT * FROM carrier_eadapter_configs WHERE id=?").get(id);
      ok(res, mapEadapterConfig(row), 201);
    } catch (e) {
      if (isUniqueViolation(e)) return err(res, `A config already exists for carrier ${code}`, 409);
      err(res, e.message, 500);
    }
  });

  app.put("/api/eadapter/configs/:id", write, (req, res) => {
    const existing = db.prepare("SELECT * FROM carrier_eadapter_configs WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Config not found", 404);

    const { transportType = existing.transport_type, endpointUrl = existing.endpoint_url,
            authHeaderName = existing.auth_header_name, credential = "",
            isActive = !!existing.is_active, notes = existing.notes } = req.body || {};
    if (!TRANSPORT_TYPES.includes(transportType)) return err(res, "transportType must be rest_api, as2, or sftp");

    // Blank/omitted credential means "keep the existing one" — same UX rule office-mail.js's
    // smtp_password field already follows; never overwrite a stored secret with blank just
    // because the form field was left empty.
    const cred = credential.trim() ? credential : existing.credential;
    const now = new Date().toISOString();
    db.prepare(`UPDATE carrier_eadapter_configs SET transport_type=?, endpoint_url=?, auth_header_name=?,
      credential=?, is_active=?, notes=?, updated_at=? WHERE id=?`)
      .run(transportType, endpointUrl.trim(), authHeaderName.trim(), cred, isActive ? 1 : 0, notes, now, req.params.id);

    const row = db.prepare("SELECT * FROM carrier_eadapter_configs WHERE id=?").get(req.params.id);
    ok(res, mapEadapterConfig(row));
  });

  app.delete("/api/eadapter/configs/:id", write, (req, res) => {
    db.prepare("DELETE FROM carrier_eadapter_configs WHERE id=?").run(req.params.id);
    ok(res, { ok: true });
  });

  // Public (any authenticated user, no secrets in the response) — the live effective bookable
  // set, used by the two Carrier Booking pages instead of importing the static BOOKABLE_CARRIERS
  // Set. Mirrors isEdiBookable()'s exact logic (server.js) so the two never drift apart.
  app.get("/api/eadapter/bookable-carriers", (req, res) => {
    const enabled = getSettings().api_eadapter_enabled !== "false";
    const active = enabled
      ? db.prepare("SELECT carrier_code FROM carrier_eadapter_configs WHERE is_active=1").all().map(r => r.carrier_code)
      : [];
    const carriers = enabled ? [...new Set([...BOOKABLE_CARRIERS, ...active])] : [];
    ok(res, { enabled, carriers });
  });
};
