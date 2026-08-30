"use strict";

const SECURE_MODES = ["none", "starttls", "tls"];

module.exports = function officeMailRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, isUniqueViolation,
          mapOfficeMailSettings, createTransporterFromSettings, invalidateTransporterCache,
          createRateLimiter } = ctx;
  const adminOnly = requireRole(["admin"]);

  // Admin-only, but still a real outbound SMTP send per call — keyed by user, mirrors the
  // equivalent limiter on the system-email test route (routes/auth.js), own independent budget.
  const mailTestRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000, max: 10, maxEnvVar: "MAIL_TEST_RATE_MAX",
    keyFn: req => req.user.id,
    message: "Too many test emails sent recently — try again later",
  });

  const DEFAULT_SETTINGS = officeId => ({
    id: null, officeId, smtpHost: "", smtpPort: 587, secureMode: "starttls",
    smtpUsername: "", hasPassword: false, fromAddress: "", fromName: "",
    isActive: true, createdAt: null, updatedAt: null,
  });

  app.get("/api/offices/:id/mail-settings", adminOnly, async (req, res) => {
    const [row] = await query("SELECT * FROM office_mail_settings WHERE office_id = $1", [req.params.id]);
    ok(res, row ? mapOfficeMailSettings(row) : DEFAULT_SETTINGS(req.params.id));
  });

  app.put("/api/offices/:id/mail-settings", adminOnly, async (req, res) => {
    const [office] = await query("SELECT id FROM offices WHERE id=$1", [req.params.id]);
    if (!office) return err(res, "Office not found", 404);

    const { smtpHost = '', smtpPort = 587, secureMode = 'starttls', smtpUsername = '',
            smtpPassword = '', fromAddress = '', fromName = '', isActive = true } = req.body || {};
    if (!smtpHost.trim()) return err(res, "SMTP host is required");
    if (!SECURE_MODES.includes(secureMode)) return err(res, "secureMode must be none, starttls, or tls");
    if (!fromAddress.trim()) return err(res, "From address is required");

    const [existing] = await query("SELECT * FROM office_mail_settings WHERE office_id = $1", [req.params.id]);
    // Blank/omitted password means "keep the existing one" — standard password-field UX,
    // never overwrite a stored credential with blank just because the form field is empty.
    const password = smtpPassword.trim() ? smtpPassword : (existing ? existing.smtp_password : '');
    const now = new Date().toISOString();

    try {
      if (existing) {
        await query(`UPDATE office_mail_settings SET smtp_host=$1, smtp_port=$2, secure_mode=$3,
          smtp_username=$4, smtp_password=$5, from_address=$6, from_name=$7, is_active=$8, updated_at=$9
          WHERE office_id=$10`,
          [smtpHost, smtpPort, secureMode, smtpUsername, password, fromAddress, fromName,
            !!isActive, now, req.params.id]);
      } else {
        await query(`INSERT INTO office_mail_settings
          (id, office_id, smtp_host, smtp_port, secure_mode, smtp_username, smtp_password,
           from_address, from_name, is_active, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [`OMS-${uid()}`, req.params.id, smtpHost, smtpPort, secureMode, smtpUsername,
            password, fromAddress, fromName, !!isActive, now, now]);
      }
      invalidateTransporterCache(req.params.id);
      const [row] = await query("SELECT * FROM office_mail_settings WHERE office_id = $1", [req.params.id]);
      ok(res, mapOfficeMailSettings(row));
    } catch (e) {
      if (isUniqueViolation(e)) return err(res, "Mail settings already exist for this office");
      err(res, e.message, 500);
    }
  });

  // Builds a transporter straight from the submitted form values (not the cache, and not
  // necessarily saved yet) so "Test" always reflects exactly what's on screen. A blank password
  // in the body falls back to the already-stored one, same rule as the save route above — lets
  // an admin re-test after tweaking the host without having to retype the password first.
  app.post("/api/offices/:id/mail-settings/test", adminOnly, mailTestRateLimit, async (req, res) => {
    const { to, smtpHost = '', smtpPort = 587, secureMode = 'starttls',
            smtpUsername = '', smtpPassword = '' } = req.body || {};
    if (!to) return err(res, "A test-recipient address is required");
    if (!smtpHost.trim()) return err(res, "SMTP host is required");

    const [existing] = await query("SELECT smtp_password FROM office_mail_settings WHERE office_id = $1", [req.params.id]);
    const password = smtpPassword.trim() ? smtpPassword : (existing ? existing.smtp_password : '');

    try {
      const transporter = createTransporterFromSettings({ smtpHost, smtpPort, secureMode, smtpUsername, smtpPassword: password });
      await transporter.sendMail({
        from: smtpUsername || smtpHost,
        to,
        subject: "CargoDesk — test email",
        text: "This is a test email from CargoDesk's office email settings. If you received this, the configuration works.",
      });
      ok(res, { sent: true });
    } catch (e) {
      err(res, `Test send failed: ${e.message}`, 502);
    }
  });
};
