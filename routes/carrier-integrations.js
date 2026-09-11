"use strict";

// Carrier Integrations — real, per-carrier API connectivity config (Epic TKT-KG4E49, story 1).
// Deliberately NOT the generic app_settings / GET /api/settings pattern — that route already
// returns ai_api_key in full plaintext to any authenticated user, a known, documented gap this
// must not repeat. Mirrors carrier_eadapter_configs' own precedent instead: a write-only store —
// PUT accepts a new secret, GET returns at most a hasCredential/hasWebhookSecret boolean, never
// the real value back.

const CAPABILITIES = ["booking", "tracking", "schedules"];

module.exports = function carrierIntegrationsRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, isUniqueViolation, mapCarrierIntegration,
          listRegisteredAdapterKeys } = ctx;
  const write = requireRole(["admin", "operator"]);

  const parseCapabilities = (input) => {
    const arr = Array.isArray(input) ? input : [];
    return arr.filter(c => CAPABILITIES.includes(c));
  };

  app.get("/api/carrier-integrations", write, async (req, res) => {
    const rows = await query("SELECT * FROM carrier_integrations ORDER BY carrier_code");
    ok(res, rows.map(mapCarrierIntegration));
  });

  // Populated from whatever's actually registered in code (lib/carrier-integrations/registry.js)
  // — never a hardcoded list, so a newly-added adapter shows up in the admin UI automatically.
  app.get("/api/carrier-integrations/adapters", write, async (req, res) => {
    ok(res, listRegisteredAdapterKeys());
  });

  app.post("/api/carrier-integrations", write, async (req, res) => {
    const { carrierCode, adapterKey, isActive = false, capabilities = [], baseUrl = "",
            authHeaderName = "", credential = "", webhookSecret = "", notes = "" } = req.body || {};
    if (!carrierCode || !carrierCode.trim()) return err(res, "Carrier code is required");
    if (!adapterKey || !listRegisteredAdapterKeys().includes(adapterKey))
      return err(res, "adapterKey must match a registered carrier adapter");

    const id = `CIN-${uid()}`;
    const code = carrierCode.trim().toUpperCase();
    const now = new Date().toISOString();
    try {
      await query(`INSERT INTO carrier_integrations
        (id, carrier_code, adapter_key, is_active, capabilities, base_url, auth_header_name, credential, webhook_secret, notes, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, code, adapterKey, !!isActive, JSON.stringify(parseCapabilities(capabilities)),
         baseUrl.trim(), authHeaderName.trim(), credential, webhookSecret, notes, now, now]);
      const [row] = await query("SELECT * FROM carrier_integrations WHERE id=$1", [id]);
      ok(res, mapCarrierIntegration(row), 201);
    } catch (e) {
      if (isUniqueViolation(e)) return err(res, `An integration already exists for carrier ${code}`, 409);
      err(res, e.message, 500);
    }
  });

  app.put("/api/carrier-integrations/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM carrier_integrations WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Integration not found", 404);

    const { adapterKey = existing.adapter_key, isActive = !!existing.is_active,
            capabilities = JSON.parse(existing.capabilities || "[]"), baseUrl = existing.base_url,
            authHeaderName = existing.auth_header_name, credential = "", webhookSecret = "",
            notes = existing.notes } = req.body || {};
    if (!listRegisteredAdapterKeys().includes(adapterKey))
      return err(res, "adapterKey must match a registered carrier adapter");

    // Blank/omitted credential or webhookSecret means "keep the existing one" — same UX rule
    // carrier_eadapter_configs.credential and office_mail_settings.smtp_password already follow.
    const cred = credential.trim() ? credential : existing.credential;
    const secret = webhookSecret.trim() ? webhookSecret : existing.webhook_secret;
    const now = new Date().toISOString();
    await query(`UPDATE carrier_integrations SET adapter_key=$1, is_active=$2, capabilities=$3,
      base_url=$4, auth_header_name=$5, credential=$6, webhook_secret=$7, notes=$8, updated_at=$9 WHERE id=$10`,
      [adapterKey, !!isActive, JSON.stringify(parseCapabilities(capabilities)), baseUrl.trim(),
       authHeaderName.trim(), cred, secret, notes, now, req.params.id]);

    const [row] = await query("SELECT * FROM carrier_integrations WHERE id=$1", [req.params.id]);
    ok(res, mapCarrierIntegration(row));
  });

  app.delete("/api/carrier-integrations/:id", write, async (req, res) => {
    await query("DELETE FROM carrier_integrations WHERE id=$1", [req.params.id]);
    ok(res, { ok: true });
  });
};
