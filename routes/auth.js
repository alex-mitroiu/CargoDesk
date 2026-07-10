"use strict";
const crypto = require("crypto");

module.exports = function authRoutes(app, ctx) {
  const { db, ok, err, uid, auth, requireRole,
          VALID_ROLES, ROLE_RANK_SV, primaryRoleSV, parseUserRoles,
          mapScopeItem, mapAccessConfig,
          bcrypt, jwt, JWT_SECRET,
          logAdminEvent, getSettings, ssoNonces } = ctx;

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const getSecuritySettings = () => {
    const s = getSettings();
    return {
      maxAttempts:    parseInt(s.login_max_attempts  || "5",  10),
      lockoutMinutes: parseInt(s.login_lockout_minutes || "30", 10),
      jwtHours:       parseInt(s.jwt_lifetime_hours  || "8",  10),
    };
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
  });

  // ─── Login ─────────────────────────────────────────────────────────────────

  app.post("/api/auth/login", (req, res) => {
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

    const { jwtHours } = getSecuritySettings();
    const roles = JSON.parse(user.roles || JSON.stringify([user.role || 'viewer']));
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, roles,
        canViewFinance: !!user.can_view_finance,
        tv: user.token_version ?? 0 },
      JWT_SECRET,
      { expiresIn: `${jwtHours}h` }
    );
    ok(res, { token, user: { id: user.id, email: user.email, name: user.name, roles,
      canViewFinance: !!user.can_view_finance } });
  });

  app.get("/api/auth/me", auth(), (req, res) => {
    const user = db.prepare(
      "SELECT id, email, name, role, roles, is_active FROM users WHERE id = ?"
    ).get(req.user.id);
    if (!user || !user.is_active) return err(res, "User not found or inactive", 404);
    ok(res, user);
  });

  app.post("/api/auth/logout", (req, res) => ok(res, { ok: true }));

  // ─── SSO ───────────────────────────────────────────────────────────────────

  app.get("/api/auth/sso/config", (req, res) => {
    const s = getSettings();
    ok(res, {
      enabled:  s.sso_enabled === '1',
      tenantId: s.sso_tenant_id || '',
      clientId: s.sso_client_id || '',
    });
  });

  app.get("/api/auth/sso/init", (req, res) => {
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

  app.get("/api/auth/sso/callback", async (req, res) => {
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
              failed_attempts, locked_until, token_version, can_view_finance FROM users ORDER BY created_at`
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
        "INSERT INTO users (id, email, name, password_hash, role, roles, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))"
      ).run(id, email.toLowerCase().trim(), name, bcrypt.hashSync(password, 10), primary, JSON.stringify(roles));
      logAdminEvent(req.user, 'USER_CREATED', 'user', id, { email: email.toLowerCase().trim(), roles });
      ok(res, { ok: true });
    } catch (e) {
      err(res, e.message?.includes("UNIQUE") ? "Email already exists" : e.message);
    }
  });

  app.patch("/api/users/:id", requireRole(["admin"]), (req, res) => {
    const { name, roles, password, isActive, unlock, canViewFinance } = req.body || {};
    const existing = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);

    const newRoles = roles || parseUserRoles(existing);
    if (!newRoles.every(r => VALID_ROLES.includes(r))) return err(res, "Invalid roles");
    const primary = primaryRoleSV(newRoles);
    const active  = isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active;
    const hash    = password ? bcrypt.hashSync(password, 10) : existing.password_hash;

    // Revoke sessions when deactivating or when password is reset
    let newTokenVersion = existing.token_version ?? 0;
    if ((!active && existing.is_active) || password) newTokenVersion++;

    // Unlock clears lockout fields
    const failedAttempts = unlock ? 0 : (existing.failed_attempts ?? 0);
    const lockedUntil    = unlock ? '' : (existing.locked_until   ?? '');
    const financeFlag    = canViewFinance !== undefined ? (canViewFinance ? 1 : 0) : (existing.can_view_finance ?? 0);

    db.prepare(`UPDATE users SET name=?, role=?, roles=?, is_active=?, password_hash=?,
                  token_version=?, failed_attempts=?, locked_until=?, can_view_finance=? WHERE id=?`)
      .run(name || existing.name, primary, JSON.stringify(newRoles),
           active, hash, newTokenVersion, failedAttempts, lockedUntil, financeFlag, req.params.id);

    // Log what changed
    const changes = {};
    if (name && name !== existing.name) changes.name = { from: existing.name, to: name };
    if (JSON.stringify(newRoles) !== existing.roles) changes.roles = { from: parseUserRoles(existing), to: newRoles };
    if (isActive !== undefined && !!active !== !!existing.is_active) changes.isActive = { from: !!existing.is_active, to: !!active };
    if (password) changes.password = 'reset';
    if (unlock)   changes.unlock   = true;
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
