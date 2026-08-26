"use strict";

// eAdapter — per-carrier, per-office EDI connectivity configuration (carrier-EDI epic, story 1;
// office-scoped as of v0.83.0). Mirrors office-mail.js's own shape (typed transport columns,
// is_active, timestamps, blank-credential-means-keep-existing). This story is configuration +
// CRUD only — no live outbound call is attempted yet; adding an active config here only affects
// isEdiBookable() (server.js), which routes/edi.js and supersedeIfCarrierChanged already gate on.

const TRANSPORT_TYPES = ["rest_api", "as2", "sftp"];

module.exports = function eadapterRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, isUniqueViolation, mapEadapterConfig,
          getSettings, BOOKABLE_CARRIERS } = ctx;
  const write = requireRole(["admin", "operator"]);

  const CONFIG_JOIN = `
    SELECT c.*, o.code AS office_code, o.name AS office_name
    FROM   carrier_eadapter_configs c
    LEFT   JOIN offices o ON o.id = c.office_id
  `;

  app.get("/api/eadapter/configs", write, (req, res) => {
    const rows = db.prepare(`${CONFIG_JOIN} ORDER BY c.carrier_code, o.code`).all();
    ok(res, rows.map(mapEadapterConfig));
  });

  app.post("/api/eadapter/configs", write, (req, res) => {
    const { carrierCode, officeId, transportType = "rest_api", endpointUrl = "", authHeaderName = "",
            credential = "", isActive = true, notes = "" } = req.body || {};
    if (!carrierCode || !carrierCode.trim()) return err(res, "Carrier code is required");
    if (!officeId) return err(res, "An office is required — a carrier's EDI relationship is negotiated per office, not globally");
    if (!TRANSPORT_TYPES.includes(transportType)) return err(res, "transportType must be rest_api, as2, or sftp");

    // office_id is the real scope key; country_iso2 is always derived from the office row here,
    // never taken from the request body — a client-supplied country could otherwise drift from
    // the office actually picked, which would silently break the (carrier, office) uniqueness
    // guarantee this table now depends on.
    const office = db.prepare("SELECT id, code, country_code, is_active FROM offices WHERE id=?").get(officeId);
    if (!office) return err(res, "Office not found", 404);
    if (!office.is_active) return err(res, "That office is inactive — pick an active one");

    const id = `EAC-${uid()}`;
    const code = carrierCode.trim().toUpperCase();
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT INTO carrier_eadapter_configs
        (id, carrier_code, country_iso2, office_id, transport_type, endpoint_url, auth_header_name, credential, is_active, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, code, office.country_code || '', office.id, transportType, endpointUrl.trim(), authHeaderName.trim(), credential, isActive ? 1 : 0, notes, now, now);
      const row = db.prepare(`${CONFIG_JOIN} WHERE c.id=?`).get(id);
      ok(res, mapEadapterConfig(row), 201);
    } catch (e) {
      if (isUniqueViolation(e)) return err(res, `A config already exists for carrier ${code} at ${office.code}`, 409);
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
    // because the form field was left empty. carrierCode/officeId/countryIso2 are immutable
    // after creation, same as carrierCode always was — changing scope would silently reassign
    // which shipments this config now governs; delete and re-add instead.
    const cred = credential.trim() ? credential : existing.credential;
    const now = new Date().toISOString();
    db.prepare(`UPDATE carrier_eadapter_configs SET transport_type=?, endpoint_url=?, auth_header_name=?,
      credential=?, is_active=?, notes=?, updated_at=? WHERE id=?`)
      .run(transportType, endpointUrl.trim(), authHeaderName.trim(), cred, isActive ? 1 : 0, notes, now, req.params.id);

    const row = db.prepare(`${CONFIG_JOIN} WHERE c.id=?`).get(req.params.id);
    ok(res, mapEadapterConfig(row));
  });

  app.delete("/api/eadapter/configs/:id", write, (req, res) => {
    db.prepare("DELETE FROM carrier_eadapter_configs WHERE id=?").run(req.params.id);
    ok(res, { ok: true });
  });

  // Public (any authenticated user, no secrets in the response) — the live effective bookable
  // set for a given office, used by the two Carrier Booking pages instead of importing the
  // static BOOKABLE_CARRIERS Set. officeId is optional (a caller with no shipment/office context
  // gets only the built-in 3, since a scoped config can never apply without one) — mirrors
  // isEdiBookable()'s exact logic (server.js) so the two never drift apart.
  app.get("/api/eadapter/bookable-carriers", (req, res) => {
    const { officeId = "" } = req.query;
    const enabled = getSettings().api_eadapter_enabled !== "false";
    const active = enabled && officeId
      ? db.prepare("SELECT carrier_code FROM carrier_eadapter_configs WHERE is_active=1 AND office_id=?").all(officeId).map(r => r.carrier_code)
      : [];
    const carriers = enabled ? [...new Set([...BOOKABLE_CARRIERS, ...active])] : [];
    ok(res, { enabled, carriers });
  });
};
