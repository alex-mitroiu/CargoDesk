"use strict";

module.exports = function systemRoutes(app, ctx) {
  const { query, transaction, ok, err, auth, requireRole,
          mapSystemMessage, getSettings, scheduleNextOfacSync, scheduleNextCslSync, loadSanctionsIndex, fxCache,
          logAdminEvent, migrationFailures, restartAisListener, rebuildPortLanesMap,
          getAisListenerStatus,
          DISTRIBUTION_SERVICE_URL, PDF_RENDER_SERVICE_URL, CONTRACT_SERVICE_URL, MDM_SERVICE_URL,
          SCREENING_SERVICE_URL, KANBAN_SERVICE_URL, CUSTOMER_SERVICE_URL, BREAK_GLASS_EMAILS } = ctx;

  // ─── Health ───────────────────────────────────────────────────────────────

  // Every extracted microservice exposes an unauthenticated GET /health (see each service's own
  // server.js) — probed server-to-server here so the browser never has to make a cross-origin
  // request to ports 3002-3008 (this app runs no CORS middleware, see ARCHITECTURE.md).
  const MICROSERVICES = [
    { id: "distribution", label: "Document Distribution", url: DISTRIBUTION_SERVICE_URL },
    { id: "pdfRender",    label: "PDF Render",             url: PDF_RENDER_SERVICE_URL },
    { id: "contracts",    label: "Contract Management",    url: CONTRACT_SERVICE_URL },
    { id: "mdm",          label: "MDM",                    url: MDM_SERVICE_URL },
    { id: "screening",    label: "Screening",               url: SCREENING_SERVICE_URL },
    { id: "kanban",       label: "Kanban / Testing",        url: KANBAN_SERVICE_URL },
    { id: "customers",    label: "Customer",                url: CUSTOMER_SERVICE_URL },
  ];

  async function probeMicroservices() {
    const results = {};
    await Promise.all(MICROSERVICES.map(async ({ id, label, url }) => {
      const t0 = Date.now();
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        const r = await fetch(`${url}/health`, { signal: ctrl.signal });
        clearTimeout(timer);
        results[id] = { label, ok: r.ok, status: r.status, latency: Date.now() - t0 };
      } catch (e) {
        results[id] = { label, ok: false, error: e.name === "AbortError" ? "Timeout" : "Unreachable", latency: Date.now() - t0 };
      }
    }));
    return results;
  }

  app.get("/api/health", async (req, res) => {
    const t = Date.now();
    try {
      const [[{ n: shipmentsN }], [{ n: contractsN }], [{ n: portsN }], [{ n: vesselsN }]] = await Promise.all([
        query("SELECT COUNT(*) AS n FROM shipments"),
        query("SELECT COUNT(*) AS n FROM contracts"),
        query("SELECT COUNT(*) AS n FROM port_locations"),
        query("SELECT COUNT(*) AS n FROM vessels"),
      ]);
      const counts = { shipments: Number(shipmentsN), contracts: Number(contractsN), ports: Number(portsN), vessels: Number(vesselsN) };
      const services = await probeMicroservices();
      const ais = getAisListenerStatus ? getAisListenerStatus() : null;
      ok(res, {
        status:        "ok",
        version:       require('../package.json').version,
        devMode:       process.env.NODE_ENV !== "production",
        uptime:        Math.floor(process.uptime()),
        memoryMb:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        fxCurrencies:  Object.keys(fxCache.rates).length,
        fxCacheAgeMin: fxCache.ts ? Math.round((Date.now() - fxCache.ts) / 60000) : null,
        counts,
        services,
        ais,
        migrations:    { failed: migrationFailures.length, details: migrationFailures },
        latency:       Date.now() - t,
        ts:            new Date().toISOString(),
      });
    } catch (e) {
      err(res, `Health check failed: ${e.message}`, 503);
    }
  });

  // ─── System Messages ──────────────────────────────────────────────────────

  app.get("/api/system-messages", async (req, res) => {
    const now = new Date().toISOString().slice(0, 16);
    const rows = await query(`SELECT * FROM system_messages
      WHERE (active_from = '' OR active_from <= $1)
        AND (active_to   = '' OR active_to   >= $1)
      ORDER BY created_at DESC`, [now]);
    ok(res, rows.map(mapSystemMessage));
  });

  app.get("/api/system-messages/all", async (req, res) => {
    ok(res, (await query("SELECT * FROM system_messages ORDER BY created_at DESC")).map(mapSystemMessage));
  });

  app.post("/api/system-messages", auth(), async (req, res) => {
    const { title, body = "", severity = "info", activeFrom = "", activeTo = "" } = req.body;
    if (!title?.trim()) return err(res, "title required");
    const id = `MSG-${ctx.uid()}`;
    const createdAt = new Date().toISOString();
    await query("INSERT INTO system_messages (id,title,body,severity,active_from,active_to,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, title.trim(), body.trim(), severity, activeFrom, activeTo, createdAt]);
    await logAdminEvent(req.user, 'SYSMSG_CREATED', 'system_message', id, { title: title.trim(), severity });
    ok(res, mapSystemMessage({ id, title: title.trim(), body: body.trim(), severity, active_from: activeFrom, active_to: activeTo, created_at: createdAt }), 201);
  });

  app.delete("/api/system-messages/:id", auth(), async (req, res) => {
    const [existing] = await query("SELECT title FROM system_messages WHERE id=$1", [req.params.id]);
    const deleted = await query("DELETE FROM system_messages WHERE id=$1 RETURNING id", [req.params.id]);
    if (deleted.length === 0) return err(res, "Not found", 404);
    await logAdminEvent(req.user, 'SYSMSG_DELETED', 'system_message', req.params.id, { title: existing?.title });
    ok(res, { deleted: req.params.id });
  });

  // ─── Settings ─────────────────────────────────────────────────────────────

  // 2026-09-03 audit — CRITICAL: GET /api/settings has only ever had the global "any
  // authenticated user" gate (no role check), and getSettings() returns the app_settings table
  // completely verbatim with zero filtering — every key, secrets included. sso_client_secret and
  // ais_api_key rode along on that with no masking at all; ai_api_key already had its own
  // separately-known instance of this exact gap (see v0.51.0's own comment on org_signing_certs,
  // "GET /api/settings already returns [ai_api_key] in full plaintext to any authenticated user"
  // — documented, never fixed). Verified live: a plain viewer-role account (the lowest tier in
  // this app) could read all three real secret values back in full via a plain GET. SMTP
  // passwords already avoid this — they were deliberately pulled out into their own masked
  // GET/PUT/test routes (see SystemEmailSettingsPanel's/OfficeMailSettingsModal's own comments)
  // — but that precedent was never applied to these three, which stayed on the generic,
  // unfiltered blob. Masking them in place here (rather than also giving each its own dedicated
  // route set) keeps every other already-correctly-shared setting on this same page/save flow
  // untouched.
  const SECRET_SETTING_KEYS = ["sso_client_secret", "ai_api_key", "ais_api_key"];
  const maskSecrets = settings => {
    const out = { ...settings };
    for (const k of SECRET_SETTING_KEYS) {
      out[`${k}_configured`] = !!out[k];
      out[k] = "";
    }
    return out;
  };

  app.get("/api/settings", async (req, res) => ok(res, maskSecrets(await getSettings())));

  // Excludes trade_manager/viewer specifically, without changing behavior for admin/operator/
  // occ_bk who already have unrestricted settings access today.
  app.put("/api/settings", auth(), requireRole(["admin", "operator", "occ_bk"]), async (req, res) => {
    const updates = { ...(req.body || {}) };
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
      return err(res, "Expected JSON object of { key: value } pairs");
    // Every key below has its own dedicated admin-only route for exactly the reason each of
    // their own comments already gives (a "genuine data-source cutover"/nav-reorder/exclusive-
    // SSO-lockout lever, a different class of action than the operational settings this generic
    // route otherwise handles for operator/occ_bk too) — but until this fix, none of them were
    // actually excluded from this generic route, only sso_enforce_exclusive was. Confirmed live
    // during the shipment-domain audit (TKT-E25769): an operator, correctly blocked (403) by the
    // dedicated PUT /api/settings/mdm-source route, could flip mdm_source to 'remote' anyway by
    // sending it through this route instead — the exact "whoever it's meant to keep out could
    // just call this route instead" theater the sso_enforce_exclusive comment already warned
    // about, just never applied to these. Same live-confirmed bypass for
    // shipment_sidebar_order (overwrites the shared nav order for every user in the app).
    const ADMIN_ONLY_DEDICATED_KEYS = [
      "sso_enforce_exclusive", "mdm_source", "contract_source", "screening_source",
      "kanban_source", "customer_source", "shipment_sidebar_order",
    ];
    const blockedKeys = ADMIN_ONLY_DEDICATED_KEYS.filter(k => k in updates);
    if (blockedKeys.length && !req.user.roles.includes("admin"))
      return err(res, `${blockedKeys.join(", ")} can only be changed by an admin — use the dedicated PUT /api/settings/... route instead`, 403);
    // Same empty-break-glass-set lockout guard as the dedicated route above — this generic route
    // is still a valid way for an admin to set this key, so the safety check has to live here too,
    // not just there.
    if (updates.sso_enforce_exclusive === '1' && BREAK_GLASS_EMAILS.size === 0)
      return err(res, "Cannot enable sso_enforce_exclusive — no break-glass accounts configured (BREAK_GLASS_EMAILS is empty), this would lock everyone out of local login");
    // operator/occ_bk legitimately need this route for ordinary toggles/thresholds, but not for
    // provider credentials — SECRET_SETTING_KEYS is already the one list both the masking-on-GET
    // and the blank-means-keep logic below key off, so it's also the right list to gate writes
    // on here: any future secret field added to that array is admin-only automatically (TKT-67EDF3).
    if (!req.user.roles.includes("admin") && SECRET_SETTING_KEYS.some(k => k in updates))
      return err(res, "Only an admin can change credential settings (" + SECRET_SETTING_KEYS.filter(k => k in updates).join(", ") + ")", 403);
    // Same "blank means keep the existing value" idiom the SMTP password fields already use
    // (routes/office-mail.js, routes/auth.js's system-email routes) — the frontend now never
    // gets the real secret back from GET, so its input always renders blank; submitting that
    // blank untouched must not overwrite a real stored secret with an empty string. A genuine,
    // deliberate clear is still possible — send JSON `null` (distinct from `""`, since this is a
    // parsed JSON body, not a raw form) rather than an empty string; ordinary UI typing never
    // produces null, so this is purely an intentional-clear escape hatch, e.g. for a test's own
    // cleanup or a future "Clear" button.
    for (const k of SECRET_SETTING_KEYS) {
      if (k in updates && updates[k] === "") delete updates[k];
      else if (k in updates && updates[k] === null) updates[k] = "";
    }
    try {
      await transaction(async (tx) => {
        for (const [k, v] of Object.entries(updates))
          await tx.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2", [String(k), String(v)]);
      });
    } catch (e) { return err(res, e.message); }
    await scheduleNextOfacSync();
    await restartAisListener();
    // Log settings changes — skip secrets
    const safeKeys = Object.fromEntries(
      Object.entries(updates).filter(([k]) => !k.includes('secret') && !k.includes('password'))
    );
    if (Object.keys(safeKeys).length) await logAdminEvent(req.user, 'SETTINGS_UPDATED', 'settings', '', safeKeys);
    ok(res, maskSecrets(await getSettings()));
  });

  // Admin-only: the Shipment Explorer sidebar's top-level nav order (ShipmentDetailSidebar,
  // App.jsx). A dedicated, more tightly-gated route rather than folding this into the generic
  // PUT /api/settings above (which also allows operator/occ_bk) — reordering everyone's nav is
  // a different class of action than the operational settings that route otherwise handles.
  // Reads still go through the existing GET /api/settings — every user needs the stored order
  // to render their own sidebar, only writing it is restricted.
  app.put("/api/settings/shipment-sidebar-order", auth(), requireRole(["admin"]), async (req, res) => {
    const { order } = req.body || {};
    if (!Array.isArray(order) || order.some(id => typeof id !== "string"))
      return err(res, "order must be an array of section id strings");
    const value = JSON.stringify(order);
    await query("INSERT INTO app_settings (key, value) VALUES ('shipment_sidebar_order', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [value]);
    await logAdminEvent(req.user, 'SETTINGS_UPDATED', 'settings', 'shipment_sidebar_order', { order });
    ok(res, { order });
  });

  // Admin-only, same rationale as shipment-sidebar-order above: a dedicated, more tightly-gated
  // route rather than folding into the generic PUT /api/settings (which also allows operator/
  // occ_bk) — switching where every contract/rate read and write actually goes (local monolith
  // tables vs. the standalone Contract Management Service) is a genuine data-source cutover, a
  // different class of action than the operational settings that route otherwise handles.
  app.put("/api/settings/contract-source", auth(), requireRole(["admin"]), async (req, res) => {
    const { value } = req.body || {};
    if (value !== "local" && value !== "remote") return err(res, "value must be 'local' or 'remote'");
    await query("INSERT INTO app_settings (key, value) VALUES ('contract_source', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [value]);
    await logAdminEvent(req.user, 'SETTINGS_UPDATED', 'settings', 'contract_source', { value });
    ok(res, { contractSource: value });
  });

  // Admin-only, same rationale as contract-source above: this specific field decides whether
  // Entra's own MFA/Conditional Access/group-assignment policy is actually the only door into
  // the app, or just an optional one sitting next to a live local-password door (TKT-8P35S0) —
  // a materially bigger blast radius than the operational settings the generic route otherwise
  // handles, which also allows operator/occ_bk.
  app.put("/api/settings/sso-enforce-exclusive", auth(), requireRole(["admin"]), async (req, res) => {
    const { value } = req.body || {};
    if (typeof value !== "boolean") return err(res, "value must be a boolean");
    // A misconfigured/blank BREAK_GLASS_EMAILS env var would otherwise let this toggle lock out
    // every account, admins included, with recovery possible only via Entra or a manual DB edit —
    // refuse to enter that state rather than trust the deployment got the env var right.
    if (value && BREAK_GLASS_EMAILS.size === 0)
      return err(res, "Cannot enable — no break-glass accounts configured (BREAK_GLASS_EMAILS is empty), this would lock everyone out of local login", 500);
    await query("INSERT INTO app_settings (key, value) VALUES ('sso_enforce_exclusive', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [value ? '1' : '0']);
    await logAdminEvent(req.user, 'SETTINGS_UPDATED', 'settings', 'sso_enforce_exclusive', { value });
    ok(res, { ssoEnforceExclusive: value });
  });

  // Same admin-only cutover-lever shape as contract-source above, for the MDM Service
  // (services/mdm/). Flipping this also rebuilds the monolith's own portLanesMap/portCountryMap
  // caches from the new source immediately (see rebuildPortLanesMap's own mdm_source branch) —
  // no restart needed either direction.
  app.put("/api/settings/mdm-source", auth(), requireRole(["admin"]), async (req, res) => {
    const { value } = req.body || {};
    if (value !== "local" && value !== "remote") return err(res, "value must be 'local' or 'remote'");
    await query("INSERT INTO app_settings (key, value) VALUES ('mdm_source', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [value]);
    await logAdminEvent(req.user, 'SETTINGS_UPDATED', 'settings', 'mdm_source', { value });
    await rebuildPortLanesMap();
    ok(res, { mdmSource: value });
  });

  // Same shape as contract-source/mdm-source above, for the Screening Service. Also immediately
  // refreshes the local sanctionsMap cache and reschedules both auto-sync timers (which switch
  // job — sync-firing vs. cache-poll — based on this same toggle, see scheduleNextOfacSync/
  // scheduleNextCslSync's own remote branches) so the effect is instant, not a 15-minute wait.
  app.put("/api/settings/screening-source", auth(), requireRole(["admin"]), async (req, res) => {
    const { value } = req.body || {};
    if (value !== "local" && value !== "remote") return err(res, "value must be 'local' or 'remote'");
    await query("INSERT INTO app_settings (key, value) VALUES ('screening_source', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [value]);
    await logAdminEvent(req.user, 'SETTINGS_UPDATED', 'settings', 'screening_source', { value });
    await loadSanctionsIndex();
    await scheduleNextOfacSync();
    await scheduleNextCslSync();
    ok(res, { screeningSource: value });
  });

  // Same shape as the three sources above, for the Kanban/Testing Service. No cache to rebuild
  // here (unlike mdm-source/screening-source) — tickets/test items are read fresh per request in
  // both modes, there's no in-memory index that needs an immediate refresh on flip.
  app.put("/api/settings/kanban-source", auth(), requireRole(["admin"]), async (req, res) => {
    const { value } = req.body || {};
    if (value !== "local" && value !== "remote") return err(res, "value must be 'local' or 'remote'");
    await query("INSERT INTO app_settings (key, value) VALUES ('kanban_source', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [value]);
    await logAdminEvent(req.user, 'SETTINGS_UPDATED', 'settings', 'kanban_source', { value });
    ok(res, { kanbanSource: value });
  });

  // Same shape as the four sources above, for the Customer Service — the fifth and final
  // "toggle" extraction. No cache to rebuild — customers are read fresh per request either way.
  app.put("/api/settings/customer-source", auth(), requireRole(["admin"]), async (req, res) => {
    const { value } = req.body || {};
    if (value !== "local" && value !== "remote") return err(res, "value must be 'local' or 'remote'");
    await query("INSERT INTO app_settings (key, value) VALUES ('customer_source', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [value]);
    await logAdminEvent(req.user, 'SETTINGS_UPDATED', 'settings', 'customer_source', { value });
    ok(res, { customerSource: value });
  });

  // ─── Schedules ────────────────────────────────────────────────────────────

  // Common TSP hubs used in mock data
  const MOCK_TSP_HUBS = ["SGSIN", "AEDXB", "GBFXT", "DEHAM", "MAPTM"];

  function mockSailings(pol, pod, carrierCode, weeks) {
    const NAMES = ["ALLEGRO","BRAVURA","CADENZA","DULCIMER","ENSEMBLE","FANFARE","GRANDEUR","HARMONY"];
    const today = new Date();
    const count = Math.max(1, Math.round(weeks * 1.5));
    return Array.from({ length: count }, (_, i) => {
      const etd = new Date(today);
      etd.setDate(etd.getDate() + 4 + i * Math.round(7 / 1.5));
      const transit = 14 + Math.floor(Math.random() * 22);
      const eta = new Date(etd);
      eta.setDate(eta.getDate() + transit);
      const etdStr = etd.toISOString().slice(0, 10);
      const etaStr = eta.toISOString().slice(0, 10);

      // Every 3rd sailing is a TSP (transshipment) sailing with two sea legs
      const isTSP = (i % 3 === 2);
      const tspHub = isTSP ? MOCK_TSP_HUBS[i % MOCK_TSP_HUBS.length] : null;
      const leg1Transit = isTSP ? Math.round(transit * 0.55) : transit;
      const tspEta     = isTSP ? (() => { const d = new Date(etd); d.setDate(d.getDate() + leg1Transit); return d.toISOString().slice(0, 10); })() : null;

      const legs = isTSP ? [
        { pol, pod: tspHub, etd: etdStr, eta: tspEta,
          vesselName: `DEMO ${NAMES[i % NAMES.length]}`,
          voyageNumber: `DM${String(i + 1).padStart(3, "0")}W`, service: "DEMO SERVICE" },
        { pol: tspHub, pod, etd: tspEta, eta: etaStr,
          vesselName: `DEMO ${NAMES[(i + 1) % NAMES.length]}`,
          voyageNumber: `DM${String(i + 2).padStart(3, "0")}E`, service: "DEMO SERVICE" },
      ] : null;

      return {
        carrier: carrierCode || "—",
        vesselName: `DEMO ${NAMES[i % NAMES.length]}`,
        voyageNumber: `DM${String(i + 1).padStart(3, "0")}W`,
        service: "DEMO SERVICE",
        pol, pod,
        etd: etdStr,
        eta: etaStr,
        transitDays: transit,
        legs,          // null for direct, array for TSP
        isMock: true,
      };
    });
  }

  // Catalog-backed matches (Test Tools > Schedule Generator, plus any ordinary Add-Sailing pick
  // saved elsewhere — the catalog search deliberately considers every stored shipment_schedules
  // row, not just Generator-authored ones, to maximize reuse) — checked before live/demo data.
  // ETD is matched as a window (today..today+weeks*7d), mirroring the same weeks semantics the
  // live/mock paths already use, since a stored schedule's ETD is a specific date, not a range.
  const catalogSailings = async (pol, pod, weeks) => {
    const today = new Date().toISOString().slice(0, 10);
    const windowEnd = new Date(Date.now() + weeks * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // is_mock=FALSE excludes stale demo/mock data — before catalog search existed, picking ANY
    // sailing (mock, live, or catalog) via Add Sailing always inserted a shipment_schedules row
    // (POST /api/shipments/:id/schedules), including whatever synthetic "DEMO ..." sailing a user
    // happened to pick. Without this filter, those old rows resurface here mislabeled as real
    // curated matches — confirmed live (SHP-W942AJ returned 4 "DEMO DULCIMER"/"DEMO CADENZA" rows
    // tagged source:catalog, none of it real data).
    // Over-fetch (100, not the 20 we actually want) so the dedupe pass below has real headroom —
    // deduping AFTER a plain LIMIT 20 would let duplicate bookings of the same physical sailing
    // (exactly the scenario this dedupe targets) silently shrink the effective result set below
    // 20 distinct sailings even when more unique ones exist just past row 20.
    const rows = await query(`
      SELECT * FROM shipment_schedules
      WHERE pol=$1 AND pod=$2 AND etd != '' AND etd >= $3 AND etd <= $4 AND is_mock=FALSE
      ORDER BY etd ASC LIMIT 100`, [pol, pod, today, windowEnd]);
    // Several independently-saved shipment_schedules rows (one per shipment/generator run) can
    // describe the exact same physical sailing — schedule_key (content-keyed, v0.62.0) is already
    // the app's own mechanism for recognizing that; dedupe on it so a picker doesn't show the same
    // sailing 2-3x just because it's been booked (or template-generated) more than once.
    const seenKeys = new Set();
    const dedupedRows = rows.filter(r => {
      const key = r.schedule_key || `${r.carrier}|${r.vessel_imo}|${r.voyage_number}|${r.pol}|${r.pod}|${r.etd}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    }).slice(0, 20);
    return Promise.all(dedupedRows.map(async r => {
      // Content-Keyed Sailing Legs — leg detail now lives in sailing_legs, referenced (not owned)
      // via schedule_leg_refs; same join getScheduleLegRows (routes/shipment-ops.js) uses.
      const legRows = await query(`
        SELECT sl.* FROM schedule_leg_refs ref JOIN sailing_legs sl ON sl.leg_key = ref.leg_key
        WHERE ref.schedule_id=$1 ORDER BY ref.leg_order ASC
      `, [r.id]);
      const legs = legRows.length >= 2 ? legRows.map(l => ({
        pol: l.pol || "", pod: l.pod || "", etd: l.etd || "", eta: l.eta || "",
        vesselName: l.vessel_name || "", vesselImo: l.vessel_imo || "", voyageNumber: l.voyage_number || "", service: l.service || "",
        carrier: l.carrier || "",
      })) : null;
      return {
        carrier: r.carrier || "—", vesselName: r.vessel_name || "—", vesselImo: r.vessel_imo || "", voyageNumber: r.voyage_number || "—",
        service: r.service || "—", pol: r.pol, pod: r.pod, etd: r.etd, eta: r.eta,
        transitDays: r.transit_days || 0, legs, isMock: false, source: "catalog", scheduleId: r.id,
      };
    }));
  };

  app.get("/api/schedules/search", auth(), async (req, res) => {
    const { pol, pod, carrierCode, weeks: w = "4" } = req.query;
    if (!pol || !pod) return res.status(400).json({ error: "pol and pod are required" });
    const weeks = Math.min(Math.max(parseInt(w) || 4, 1), 12);

    const catalog = await catalogSailings(pol, pod, weeks);

    let sailings = [...catalog];
    const demoEnabled = (await getSettings()).demo_schedules_enabled !== 'false'; // default on
    let usedDemo = false;
    if (sailings.length === 0 && demoEnabled) {
      sailings = mockSailings(pol, pod, carrierCode, weeks).map(s => ({ ...s, source: "mock" }));
      usedDemo = true;
    }
    const isMock = usedDemo; // kept for the frontend's existing isMock check
    ok(res, { sailings, pol, pod, carrierCode, isMock, catalogCount: catalog.length });
  });
};
