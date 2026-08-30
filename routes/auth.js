"use strict";
const crypto = require("crypto");

module.exports = function authRoutes(app, ctx) {
  const { db, ok, err, uid, auth, requireRole,
          VALID_ROLES, ROLE_RANK_SV, primaryRoleSV, parseUserRoles,
          mapScopeItem, mapAccessConfig, mapSystemEmailSettings,
          bcrypt, jwt, JWT_SECRET,
          createTransporterFromSettings, buildMailOptions,
          logAdminEvent, getSettings, ssoNonces, createRateLimiter } = ctx;
  const adminOnly = requireRole(["admin"]);
  const SECURE_MODES = ["none", "starttls", "tls"];

  // Admin-only, but still a real outbound SMTP send per call — keyed by user (not IP) since
  // every caller here is already authenticated, and the actor is the meaningful key, not
  // whatever office network they happen to be on.
  const mailTestRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000, max: 10, maxEnvVar: "MAIL_TEST_RATE_MAX",
    keyFn: req => req.user.id,
    message: "Too many test emails sent recently — try again later",
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const getSecuritySettings = () => {
    const s = getSettings();
    return {
      maxAttempts:      parseInt(s.login_max_attempts   || "5",  10),
      lockoutMinutes:   parseInt(s.login_lockout_minutes || "30", 10),
      jwtHours:         parseInt(s.jwt_lifetime_hours   || "8",  10),
      passwordExpiryDays: parseInt(s.password_expiry_days ?? "90", 10),
    };
  };

  const isPasswordExpired = (user, expiryDays) => {
    if (!expiryDays) return false; // 0 = disabled
    const changedAt = user.password_changed_at || user.created_at;
    if (!changedAt) return false;
    const ageMs = Date.now() - new Date(changedAt).getTime();
    return ageMs > expiryDays * 24 * 60 * 60 * 1000;
  };

  // Mirrors src/utils/passwordPolicy.js's scorePassword — frontend is ESM, this route
  // is CommonJS, so it's duplicated rather than shared; keep both in sync if this changes.
  const COMMON_WEAK_PW = /^(password|12345678|123456789|qwerty|letmein|admin123|iloveyou|welcome1|passw0rd)/i;
  const passwordMeetsPolicy = (pw) => {
    const pass = pw || "";
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(pass)).length;
    return pass.length >= 12 && classes >= 3 && !COMMON_WEAK_PW.test(pass);
  };

  const mapUser = (r) => ({
    id:             r.id,
    email:          r.email,
    name:           r.name,
    role:           r.role,
    roles:          parseUserRoles(r),
    isActive:       !!r.is_active,
    createdAt:      r.created_at,
    lastLogin:      r.last_login,
    failedAttempts: r.failed_attempts  ?? 0,
    lockedUntil:    r.locked_until     ?? '',
    tokenVersion:   r.token_version    ?? 0,
    canViewFinance: !!r.can_view_finance,
    allOffices:     !!r.all_offices,
  });

  // ─── Rate limiting ───────────────────────────────────────────────────────────
  // All limiters below share one factory (lib/rateLimit.js, exposed via ctx) — each call still
  // gets its own private Map/interval, so limiters never bleed into each other's budget; only
  // the window/sweep bookkeeping itself is shared code.

  // Per-account lockout (below) only engages after N failed attempts against ONE email — it does
  // nothing to stop a spray across many different accounts from the same source. This is a
  // separate, per-IP throttle on the login endpoint itself.
  // Overridable via env for CI: a single continuous test run logs in once per test file (23+
  // files across the monolith + document-distribution suites) from one IP, well past the
  // real-world default of 20 — the same friction that forced a manual restart-between-batches
  // workaround throughout local verification. Any real deployment leaves this unset and gets
  // the unchanged default.
  const loginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000, max: 20, maxEnvVar: "LOGIN_RATE_MAX",
    message: "Too many login attempts from this address — try again later",
  });

  // ─── Login ─────────────────────────────────────────────────────────────────

  app.post("/api/auth/login", loginRateLimit, (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return err(res, "Email and password required");

    const user = db.prepare(
      "SELECT * FROM users WHERE email = ? AND is_active = 1"
    ).get(email.toLowerCase().trim());

    if (!user) return err(res, "Invalid email or password", 401);

    // Lockout check
    const now = new Date().toISOString();
    if (user.locked_until && user.locked_until > now) {
      const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      return err(res, `Account locked. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 423);
    }

    if (!bcrypt.compareSync(password, user.password_hash)) {
      const { maxAttempts, lockoutMinutes } = getSecuritySettings();
      const attempts = (user.failed_attempts || 0) + 1;
      if (attempts >= maxAttempts) {
        const lockedUntil = new Date(Date.now() + lockoutMinutes * 60_000).toISOString();
        db.prepare("UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?")
          .run(attempts, lockedUntil, user.id);
        logAdminEvent({ id: '', email: email.toLowerCase().trim() },
          'LOGIN_LOCKED', 'user', user.id, { attempts });
        return err(res, `Too many failed attempts. Account locked for ${lockoutMinutes} minutes.`, 423);
      }
      db.prepare("UPDATE users SET failed_attempts=? WHERE id=?").run(attempts, user.id);
      return err(res, "Invalid email or password", 401);
    }

    // Successful login — reset lockout state
    db.prepare("UPDATE users SET failed_attempts=0, locked_until='', last_login=datetime('now') WHERE id=?")
      .run(user.id);

    const { jwtHours, passwordExpiryDays } = getSecuritySettings();
    const roles = JSON.parse(user.roles || JSON.stringify([user.role || 'viewer']));
    const allOffices = !!user.all_offices;
    const passwordExpired = isPasswordExpired(user, passwordExpiryDays);

    // Fetch user's assigned offices for the picker
    const userOfficesRows = db.prepare(
      `SELECT o.*, uo.is_default FROM offices o
       JOIN user_offices uo ON uo.office_id = o.id
       WHERE uo.user_id = ? AND o.is_active = 1
       ORDER BY uo.is_default DESC, o.code`
    ).all(user.id);
    const mapOffice = ctx.mapOffice;
    const offices = userOfficesRows.map(r => ({ ...mapOffice(r), isDefault: !!r.is_default }));

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, roles,
        canViewFinance: !!user.can_view_finance,
        allOffices,
        tv: user.token_version ?? 0 },
      JWT_SECRET,
      { expiresIn: `${jwtHours}h` }
    );
    ok(res, { token, passwordExpired, user: { id: user.id, email: user.email, name: user.name, roles,
      canViewFinance: !!user.can_view_finance, allOffices, offices } });
  });

  app.get("/api/auth/me", auth(), (req, res) => {
    const user = db.prepare(
      "SELECT id, email, name, role, roles, is_active, created_at, password_changed_at, all_offices FROM users WHERE id = ?"
    ).get(req.user.id);
    if (!user || !user.is_active) return err(res, "User not found or inactive", 404);
    // Silent token-restore-on-mount (a still-valid JWT from a prior session) bypasses
    // the login endpoint entirely — without this, a user who never re-enters credentials
    // could stay on an expired password indefinitely. Same check as login's.
    const { passwordExpiryDays } = getSecuritySettings();
    // Real bug fix: allOffices/offices were never returned here at all (only login's own
    // response carried them) — a silent restore (any page reload with an already-valid token,
    // the common case, not the fresh-login one) left an office-scoped user's activeOffice stuck
    // null forever, since App.jsx's office-picker auto-select effect keys off user.offices.
    // Every office-department permission check downstream of activeOffice (canEditOfficeSide's
    // client-side mirror, ShipmentFormPage's EMO/IMO auto-default) silently stopped working
    // the moment the page was reloaded instead of freshly logged into. Mirrors login's own query.
    const allOffices = !!user.all_offices;
    const userOfficesRows = db.prepare(
      `SELECT o.*, uo.is_default FROM offices o
       JOIN user_offices uo ON uo.office_id = o.id
       WHERE uo.user_id = ? AND o.is_active = 1
       ORDER BY uo.is_default DESC, o.code`
    ).all(user.id);
    const offices = userOfficesRows.map(r => ({ ...ctx.mapOffice(r), isDefault: !!r.is_default }));
    // Real bug fix: this returned user.roles as the raw JSON-text DB column (e.g. the literal
    // string '["admin","occ_bk"]'), never parsed like every other roles-emitting route already
    // does via parseUserRoles. App.jsx's own Array.isArray(user.roles) check then silently fell
    // back to the single legacy `role` column — a multi-role account lost every role but its
    // primary one on any silent session restore (a page reload with an already-valid token),
    // which is the common case, not the fresh-login one.
    ok(res, { ...user, roles: parseUserRoles(user), allOffices, offices,
      passwordExpired: isPasswordExpired(user, passwordExpiryDays) });
  });

  app.post("/api/auth/logout", (req, res) => ok(res, { ok: true }));

  // Self-service password change — any authenticated user, own account only.
  // Requires the current password (not just an admin-issued reset) so a hijacked
  // session alone can't silently take over the account's long-term credential.
  app.post("/api/auth/change-password", auth(), (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return err(res, "Current and new password are required");

    const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    if (!user) return err(res, "Not found", 404);
    // 400, not 401 — the caller IS authenticated (valid bearer token got them past
    // auth() above); this is a wrong-field rejection, not a session failure. api.js's
    // req() treats any 401 as "session dead" and force-logs-out + clears the token,
    // which would wrongly kick the user out of their own password-change attempt.
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) return err(res, "Current password is incorrect", 400);
    if (!passwordMeetsPolicy(newPassword)) {
      return err(res, "New password must be at least 12 characters and include 3 of: lowercase, uppercase, digit, symbol — and not be a common password");
    }
    if (bcrypt.compareSync(newPassword, user.password_hash)) return err(res, "New password must be different from the current one");

    const newTokenVersion = (user.token_version ?? 0) + 1;
    const now = new Date().toISOString();
    db.prepare("UPDATE users SET password_hash=?, password_changed_at=?, token_version=? WHERE id=?")
      .run(bcrypt.hashSync(newPassword, 10), now, newTokenVersion, user.id);
    logAdminEvent(req.user, 'PASSWORD_CHANGED_SELF', 'user', user.id, {});

    // token_version just bumped, invalidating the token this very request came in on —
    // issue a fresh one so the user isn't logged out by their own password change.
    const { jwtHours } = getSecuritySettings();
    const roles = parseUserRoles(user);
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, roles,
        canViewFinance: !!user.can_view_finance, allOffices: !!user.all_offices,
        tv: newTokenVersion },
      JWT_SECRET,
      { expiresIn: `${jwtHours}h` }
    );
    ok(res, { token });
  });

  // ─── Forgot / Reset Password ─────────────────────────────────────────────────
  // Separate per-IP throttle from loginRateLimit above — a different abuse shape (email-
  // bombing a victim's inbox, not brute-forcing a password), so it gets its own budget rather
  // than sharing login's. Stricter too: legitimate use is rare-repeat, so 5 requests/hour/IP is
  // generous for a real user and still cheap to hit for an attacker probing for valid emails —
  // which the generic response below already defeats regardless.
  const forgotPasswordRateLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000, max: 5, maxEnvVar: "FORGOT_PW_MAX",
    message: "Too many password reset requests from this address — try again later",
  });

  // reset-password is the OTHER half of this flow, and was missing its own throttle entirely —
  // it's just as public/unauthenticated as forgot-password, and its abuse shape (brute-forcing a
  // reset token, or just hammering the endpoint) is closer to login's than forgot-password's own.
  // A real token is 32 random bytes (crypto.randomBytes(32)) so brute-forcing one is not
  // realistically achievable within any rate limit's budget — this exists as a floor against
  // blunt endpoint spam, not as the token's actual security boundary.
  const resetPasswordRateLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000, max: 10, maxEnvVar: "RESET_PW_MAX",
    message: "Too many password reset attempts from this address — try again later",
  });

  const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
  const hashResetToken = token => crypto.createHash("sha256").update(token).digest("hex");

  // Always the same generic response whether or not the email matches a real account — the
  // one thing this route must never do is let a caller distinguish "that email exists" from
  // "it doesn't" (user enumeration). The actual work only happens inside the `if (user)` branch;
  // everything outside it is identical either way, including the response and its timing profile
  // being close enough that a network-level timing attack isn't practically useful here.
  app.post("/api/auth/forgot-password", forgotPasswordRateLimit, async (req, res) => {
    const { email = "" } = req.body || {};
    const GENERIC_MSG = "If an account exists for that email, a password reset link has been sent.";
    if (!email.trim()) return err(res, "Email is required");

    const user = db.prepare("SELECT * FROM users WHERE email = ? AND is_active = 1").get(email.toLowerCase().trim());
    if (user) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      db.prepare("UPDATE users SET reset_token_hash=?, reset_token_expires=? WHERE id=?")
        .run(hashResetToken(rawToken), expires, user.id);

      const settingsRow = db.prepare("SELECT * FROM system_email_settings WHERE id='system'").get();
      if (settingsRow && settingsRow.is_active && settingsRow.smtp_host) {
        try {
          const transporter = createTransporterFromSettings({
            smtpHost: settingsRow.smtp_host, smtpPort: settingsRow.smtp_port,
            secureMode: settingsRow.secure_mode, smtpUsername: settingsRow.smtp_username,
            smtpPassword: settingsRow.smtp_password,
          });
          const resetUrl = `${req.protocol}://${req.get("host")}/#reset-password/${rawToken}`;
          await transporter.sendMail(buildMailOptions({
            from: settingsRow.from_address, fromName: settingsRow.from_name || "CargoDesk",
            to: user.email, subject: "Reset your CargoDesk password",
            message: `Hi ${user.name || ""},\n\nA password reset was requested for your CargoDesk account. Click the link below to choose a new password — this link expires in 1 hour and can only be used once:\n\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email; your password won't change.`,
          }));
        } catch (e) {
          // Never surface a send failure to the caller — that alone would confirm the email
          // exists. Logged server-side only, matching this app's own established pattern for
          // integrations that must fail soft outward (e.g. the AIS listener's own bootstrap).
          console.error("forgot-password: failed to send reset email:", e.message);
        }
      } else {
        console.warn("forgot-password: system email is not configured (Settings → System Email) — no email sent, but the reset token was still generated.");
      }
      logAdminEvent({ id: '', email: user.email }, 'PASSWORD_RESET_REQUESTED', 'user', user.id, {});
      // Dev/test-only: the raw token otherwise only ever exists inside the emailed link, with
      // no other retrieval path by design (same reasoning webhook_receiver's dev-only mock
      // endpoint follows for otherwise-hidden async state — see Test Tools' Webhook Simulator).
      // Never present when NODE_ENV=production, which every real deployment sets (see the
      // static-file-serving gate elsewhere in server.js) — a real user always gets the token
      // exclusively via email.
      if (process.env.NODE_ENV !== "production") {
        return ok(res, { message: GENERIC_MSG, devToken: rawToken });
      }
    }
    ok(res, { message: GENERIC_MSG });
  });

  app.post("/api/auth/reset-password", resetPasswordRateLimit, (req, res) => {
    const { token = "", newPassword = "" } = req.body || {};
    if (!token || !newPassword) return err(res, "Token and new password are required");

    const tokenHash = hashResetToken(token);
    const user = db.prepare("SELECT * FROM users WHERE reset_token_hash = ? AND reset_token_hash != ''").get(tokenHash);
    if (!user) return err(res, "This reset link is invalid or has already been used", 400);
    if (!user.reset_token_expires || user.reset_token_expires < new Date().toISOString())
      return err(res, "This reset link has expired — request a new one", 400);
    if (!passwordMeetsPolicy(newPassword)) {
      return err(res, "New password must be at least 12 characters and include 3 of: lowercase, uppercase, digit, symbol — and not be a common password");
    }

    const newTokenVersion = (user.token_version ?? 0) + 1;
    const now = new Date().toISOString();
    // Clears the reset token (single-use) and any pre-existing lockout — a successful reset via
    // a link only the account owner's inbox could have received is itself proof of ownership,
    // the same bar an admin-issued unlock already clears.
    db.prepare(`UPDATE users SET password_hash=?, password_changed_at=?, token_version=?,
      reset_token_hash='', reset_token_expires='', failed_attempts=0, locked_until='' WHERE id=?`)
      .run(bcrypt.hashSync(newPassword, 10), now, newTokenVersion, user.id);
    logAdminEvent({ id: '', email: user.email }, 'PASSWORD_RESET_COMPLETED', 'user', user.id, {});

    // Deliberately does NOT return a token / log the user in automatically, unlike
    // change-password — that route's caller was already authenticated; this one's wasn't.
    // Safer to make them log in fresh with the new password.
    ok(res, { ok: true });
  });

  // ─── System Email Settings (used only to send forgot-password links) ────────────
  // Org-wide, not per-office — office_mail_settings (routes/office-mail.js) exists for
  // shipment-document sending, tied to a specific office's identity; a password-reset email
  // isn't naturally any one office's concern. Deliberately its own small settings surface
  // rather than folded into the generic GET /api/settings blob, which is PUBLIC and returns
  // its contents unfiltered — an SMTP password must never be reachable through that route.

  const SYSTEM_EMAIL_DEFAULTS = {
    smtpHost: "", smtpPort: 587, secureMode: "starttls", smtpUsername: "", hasPassword: false,
    fromAddress: "", fromName: "", isActive: true, createdAt: null, updatedAt: null,
  };

  app.get("/api/settings/system-email", adminOnly, (req, res) => {
    const row = db.prepare("SELECT * FROM system_email_settings WHERE id='system'").get();
    ok(res, row ? mapSystemEmailSettings(row) : SYSTEM_EMAIL_DEFAULTS);
  });

  app.put("/api/settings/system-email", adminOnly, (req, res) => {
    const { smtpHost = '', smtpPort = 587, secureMode = 'starttls', smtpUsername = '',
            smtpPassword = '', fromAddress = '', fromName = '', isActive = true } = req.body || {};
    if (!smtpHost.trim()) return err(res, "SMTP host is required");
    if (!SECURE_MODES.includes(secureMode)) return err(res, "secureMode must be none, starttls, or tls");
    if (!fromAddress.trim()) return err(res, "From address is required");

    const existing = db.prepare("SELECT * FROM system_email_settings WHERE id='system'").get();
    // Blank/omitted password means "keep the existing one" — same password-field UX
    // office_mail_settings already established.
    const password = smtpPassword.trim() ? smtpPassword : (existing ? existing.smtp_password : '');
    const now = new Date().toISOString();

    if (existing) {
      db.prepare(`UPDATE system_email_settings SET smtp_host=?, smtp_port=?, secure_mode=?,
        smtp_username=?, smtp_password=?, from_address=?, from_name=?, is_active=?, updated_at=?
        WHERE id='system'`)
        .run(smtpHost, smtpPort, secureMode, smtpUsername, password, fromAddress, fromName,
          isActive ? 1 : 0, now);
    } else {
      db.prepare(`INSERT INTO system_email_settings
        (id, smtp_host, smtp_port, secure_mode, smtp_username, smtp_password,
         from_address, from_name, is_active, created_at, updated_at)
        VALUES ('system',?,?,?,?,?,?,?,?,?,?)`)
        .run(smtpHost, smtpPort, secureMode, smtpUsername, password, fromAddress, fromName,
          isActive ? 1 : 0, now, now);
    }
    const row = db.prepare("SELECT * FROM system_email_settings WHERE id='system'").get();
    ok(res, mapSystemEmailSettings(row));
  });

  // Builds a transporter straight from the submitted form values (not the cache, and not
  // necessarily saved yet) — mirrors office_mail_settings' own test-send route exactly.
  app.post("/api/settings/system-email/test", adminOnly, mailTestRateLimit, async (req, res) => {
    const { to, smtpHost = '', smtpPort = 587, secureMode = 'starttls',
            smtpUsername = '', smtpPassword = '' } = req.body || {};
    if (!to) return err(res, "A test-recipient address is required");
    if (!smtpHost.trim()) return err(res, "SMTP host is required");

    const existing = db.prepare("SELECT smtp_password FROM system_email_settings WHERE id='system'").get();
    const password = smtpPassword.trim() ? smtpPassword : (existing ? existing.smtp_password : '');

    try {
      const transporter = createTransporterFromSettings({ smtpHost, smtpPort, secureMode, smtpUsername, smtpPassword: password });
      await transporter.sendMail({
        from: smtpUsername || smtpHost,
        to,
        subject: "CargoDesk — system email test",
        text: "This is a test email from CargoDesk's system email settings (used for password-reset links). If you received this, the configuration works.",
      });
      ok(res, { sent: true });
    } catch (e) {
      err(res, `Test send failed: ${e.message}`, 502);
    }
  });

  // ─── SSO ───────────────────────────────────────────────────────────────────
  // init/callback are both public and each make real outbound calls to Microsoft
  // (login.microsoftonline.com / graph.microsoft.com) — a per-IP throttle here isn't about
  // brute-forcing anything (state is a random nonce, checked separately), it's about not letting
  // one source burn through those outbound calls or the redirect chain in a tight loop.
  const ssoRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000, max: 30, maxEnvVar: "SSO_RATE_MAX",
    message: "Too many SSO attempts from this address — try again later",
  });

  app.get("/api/auth/sso/config", (req, res) => {
    const s = getSettings();
    ok(res, {
      enabled:  s.sso_enabled === '1',
      tenantId: s.sso_tenant_id || '',
      clientId: s.sso_client_id || '',
    });
  });

  app.get("/api/auth/sso/init", ssoRateLimit, (req, res) => {
    const s = getSettings();
    if (s.sso_enabled !== '1') return err(res, "SSO not enabled", 404);
    const { sso_tenant_id: tenantId, sso_client_id: clientId, sso_redirect_uri: redirectUri } = s;
    if (!tenantId || !clientId || !redirectUri)
      return err(res, "SSO not configured — set tenant_id, client_id, and redirect_uri in Settings", 500);

    const state = crypto.randomBytes(16).toString("hex");
    ssoNonces.set(state, { ts: Date.now() });

    const params = new URLSearchParams({
      client_id:     clientId,
      response_type: "code",
      redirect_uri:  redirectUri,
      response_mode: "query",
      scope:         "openid email profile",
      state,
    });
    res.redirect(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params}`);
  });

  app.get("/api/auth/sso/callback", ssoRateLimit, async (req, res) => {
    const s = getSettings();
    if (s.sso_enabled !== '1') return err(res, "SSO not enabled", 404);

    const { code, state, error: oauthError } = req.query;
    if (oauthError) return err(res, `SSO error: ${oauthError}`, 400);
    if (!code || !state) return err(res, "Missing code or state", 400);
    if (!ssoNonces.has(state)) return err(res, "Invalid or expired state", 400);
    ssoNonces.delete(state);

    const { sso_tenant_id: tenantId, sso_client_id: clientId,
            sso_client_secret: clientSecret, sso_redirect_uri: redirectUri,
            sso_default_role: defaultRole = 'operator',
            sso_frontend_url: frontendUrl = 'http://localhost:5173' } = s;

    try {
      // Exchange code for tokens
      const tokenRes = await fetch(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body:    new URLSearchParams({
            client_id: clientId, client_secret: clientSecret,
            code, redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
      const tokens = await tokenRes.json();

      // Get user info
      const userRes = await fetch("https://graph.microsoft.com/oidc/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal:  AbortSignal.timeout(8_000),
      });
      if (!userRes.ok) throw new Error("Failed to fetch user info");
      const profile = await userRes.json();

      const email = (profile.email || profile.preferred_username || '').toLowerCase().trim();
      const name  = profile.name || profile.given_name || email;
      if (!email) throw new Error("No email in SSO profile");

      // Find or create the local user
      let user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
      if (!user) {
        const id    = `USR-${uid()}`;
        const roles = [VALID_ROLES.includes(defaultRole) ? defaultRole : 'operator'];
        const primary = primaryRoleSV(roles);
        db.prepare(`INSERT INTO users (id,email,name,password_hash,role,roles,is_active,created_at)
          VALUES (?,?,?,?,?,?,1,datetime('now'))`)
          .run(id, email, name, '', primary, JSON.stringify(roles));
        user = db.prepare("SELECT * FROM users WHERE id=?").get(id);
        logAdminEvent({ id: '', email: 'sso' }, 'USER_CREATED_SSO', 'user', id, { email, provider: 'Azure AD' });
      }

      if (!user.is_active) return res.redirect(`${frontendUrl}?sso_error=Account+deactivated`);

      db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(user.id);

      const { jwtHours } = getSecuritySettings();
      const roles = parseUserRoles(user);
      const token = jwt.sign(
        { id: user.id, email: user.email, name: user.name, role: user.role, roles,
          tv: user.token_version ?? 0, sso: true },
        JWT_SECRET,
        { expiresIn: `${jwtHours}h` }
      );

      res.redirect(`${frontendUrl}?sso_token=${encodeURIComponent(token)}&sso_name=${encodeURIComponent(name)}`);
    } catch (e) {
      console.error("SSO callback error:", e.message);
      res.redirect(`${frontendUrl}?sso_error=${encodeURIComponent(e.message)}`);
    }
  });

  // ─── Users ─────────────────────────────────────────────────────────────────

  app.get("/api/users", requireRole(["admin"]), (req, res) => {
    const rows = db.prepare(
      `SELECT id, email, name, role, roles, is_active, created_at, last_login,
              failed_attempts, locked_until, token_version, can_view_finance, all_offices FROM users ORDER BY created_at`
    ).all();
    ok(res, rows.map(mapUser));
  });

  app.post("/api/users", requireRole(["admin"]), (req, res) => {
    const { email, name, roles = ["viewer"], password } = req.body || {};
    if (!email || !name || !password) return err(res, "email, name, and password are required");
    if (!roles.length || !roles.every(r => VALID_ROLES.includes(r))) return err(res, "Invalid roles");
    const primary = primaryRoleSV(roles);
    try {
      const id = `USR-${uid()}`;
      db.prepare(
        "INSERT INTO users (id, email, name, password_hash, role, roles, is_active, all_offices, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, datetime('now'))"
      ).run(id, email.toLowerCase().trim(), name, bcrypt.hashSync(password, 10), primary, JSON.stringify(roles));
      logAdminEvent(req.user, 'USER_CREATED', 'user', id, { email: email.toLowerCase().trim(), roles });
      ok(res, { ok: true });
    } catch (e) {
      err(res, e.message?.includes("UNIQUE") ? "Email already exists" : e.message);
    }
  });

  app.patch("/api/users/:id", requireRole(["admin"]), (req, res) => {
    const { name, roles, password, isActive, unlock, canViewFinance, allOffices } = req.body || {};
    const existing = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);

    const newRoles = roles || parseUserRoles(existing);
    if (!newRoles.every(r => VALID_ROLES.includes(r))) return err(res, "Invalid roles");
    const primary = primaryRoleSV(newRoles);
    const active  = isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active;
    const hash    = password ? bcrypt.hashSync(password, 10) : existing.password_hash;

    // Revoke sessions when deactivating, resetting the password, or changing roles —
    // otherwise a downgraded user's already-issued token keeps its old (higher)
    // privileges until it naturally expires (up to 8h, see the jwt.sign expiresIn below).
    const rolesChanged = JSON.stringify(newRoles) !== existing.roles;
    let newTokenVersion = existing.token_version ?? 0;
    if ((!active && existing.is_active) || password || rolesChanged) newTokenVersion++;

    // Unlock clears lockout fields
    const failedAttempts = unlock ? 0 : (existing.failed_attempts ?? 0);
    const lockedUntil    = unlock ? '' : (existing.locked_until   ?? '');
    const financeFlag    = canViewFinance !== undefined ? (canViewFinance ? 1 : 0) : (existing.can_view_finance ?? 0);
    const allOfficesFlag = allOffices    !== undefined ? (allOffices    ? 1 : 0) : (existing.all_offices      ?? 1);

    db.prepare(`UPDATE users SET name=?, role=?, roles=?, is_active=?, password_hash=?,
                  token_version=?, failed_attempts=?, locked_until=?, can_view_finance=?, all_offices=? WHERE id=?`)
      .run(name || existing.name, primary, JSON.stringify(newRoles),
           active, hash, newTokenVersion, failedAttempts, lockedUntil, financeFlag, allOfficesFlag, req.params.id);

    // Log what changed
    const changes = {};
    if (name && name !== existing.name) changes.name = { from: existing.name, to: name };
    if (JSON.stringify(newRoles) !== existing.roles) changes.roles = { from: parseUserRoles(existing), to: newRoles };
    if (isActive !== undefined && !!active !== !!existing.is_active) changes.isActive = { from: !!existing.is_active, to: !!active };
    if (password) changes.password = 'reset';
    if (unlock)   changes.unlock   = true;
    if (allOffices !== undefined) changes.allOffices = { from: !!existing.all_offices, to: !!allOfficesFlag };
    logAdminEvent(req.user, 'USER_UPDATED', 'user', req.params.id, changes);

    ok(res, { ok: true });
  });

  app.post("/api/users/:id/revoke-sessions", requireRole(["admin"]), (req, res) => {
    const existing = db.prepare("SELECT id, token_version FROM users WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    db.prepare("UPDATE users SET token_version=? WHERE id=?")
      .run((existing.token_version ?? 0) + 1, req.params.id);
    logAdminEvent(req.user, 'SESSIONS_REVOKED', 'user', req.params.id, {});
    ok(res, { ok: true });
  });

  app.delete("/api/users/:id", requireRole(["admin"]), (req, res) => {
    const existing = db.prepare("SELECT id, email FROM users WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
    logAdminEvent(req.user, 'USER_DELETED', 'user', req.params.id, { email: existing.email });
    ok(res, { deleted: req.params.id });
  });

  // ─── Admin Events ──────────────────────────────────────────────────────────

  app.get("/api/admin/events", requireRole(["admin"]), (req, res) => {
    const { limit = 100, offset = 0, action, targetType } = req.query;
    let sql  = "SELECT * FROM admin_events WHERE 1=1";
    const params = [];
    if (action)     { sql += " AND action=?";      params.push(action); }
    if (targetType) { sql += " AND target_type=?"; params.push(targetType); }
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit, 10), parseInt(offset, 10));
    const rows  = db.prepare(sql).all(...params);
    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM admin_events WHERE 1=1${action ? " AND action=?" : ""}${targetType ? " AND target_type=?" : ""}`
    ).get(...params.slice(0, -2)).n;
    ok(res, { results: rows.map(r => ({ ...r, details: JSON.parse(r.details || '{}') })), total });
  });

  // ─── Access Configs ────────────────────────────────────────────────────────

  app.get("/api/users/:id/access-configs", requireRole(["admin"]), (req, res) => {
    const rows = db.prepare("SELECT * FROM user_access_configs WHERE user_id=?").all(req.params.id);
    ok(res, rows.map(mapAccessConfig));
  });

  app.post("/api/users/:id/access-configs", requireRole(["admin"]), (req, res) => {
    const { label='', originLane=null, destLane=null, polCodes=[], podCodes=[], carrierCodes=[] } = req.body || {};
    const id = `UAC-${uid()}`;
    db.prepare(`INSERT INTO user_access_configs (id,user_id,label,origin_lane,dest_lane,pol_codes,pod_codes,carrier_codes,created_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(id, req.params.id, label, originLane, destLane,
        JSON.stringify(polCodes), JSON.stringify(podCodes), JSON.stringify(carrierCodes));
    ok(res, mapAccessConfig({ id, user_id: req.params.id, label, origin_lane: originLane,
      dest_lane: destLane, pol_codes: JSON.stringify(polCodes), pod_codes: JSON.stringify(podCodes),
      carrier_codes: JSON.stringify(carrierCodes), created_at: new Date().toISOString() }), 201);
  });

  app.delete("/api/access-configs/:configId", requireRole(["admin"]), (req, res) => {
    const info = db.prepare("DELETE FROM user_access_configs WHERE id=?").run(req.params.configId);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.configId });
  });

  // ─── Scope Items ───────────────────────────────────────────────────────────

  app.get("/api/users/:id/scope", requireRole(["admin"]), (req, res) => {
    ok(res, db.prepare("SELECT * FROM user_scope_items WHERE user_id=? ORDER BY created_at").all(req.params.id).map(mapScopeItem));
  });

  app.post("/api/users/:id/scope", requireRole(["admin"]), (req, res) => {
    const { role='', itemType, value, label='' } = req.body || {};
    if (!itemType || !value) return err(res, "itemType and value required");
    const id = `USI-${uid()}`;
    db.prepare("INSERT INTO user_scope_items (id,user_id,role,item_type,value,label) VALUES (?,?,?,?,?,?)")
      .run(id, req.params.id, role, itemType, value, label);
    ok(res, mapScopeItem({ id, user_id: req.params.id, role, item_type: itemType, value, label, created_at: new Date().toISOString() }), 201);
  });

  app.delete("/api/scope-items/:itemId", requireRole(["admin"]), (req, res) => {
    const info = db.prepare("DELETE FROM user_scope_items WHERE id=?").run(req.params.itemId);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.itemId });
  });
};
