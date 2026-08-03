"use strict";

module.exports = function systemRoutes(app, ctx) {
  const { db, ok, err, auth, requireRole,
          mapSystemMessage, getSettings, scheduleNextOfacSync, fxCache,
          logAdminEvent, migrationFailures, restartAisListener } = ctx;

  // ─── Health ───────────────────────────────────────────────────────────────

  app.get("/api/health", (req, res) => {
    const t = Date.now();
    try {
      const counts = {
        shipments: db.prepare("SELECT COUNT(*) AS n FROM shipments").get().n,
        contracts: db.prepare("SELECT COUNT(*) AS n FROM contracts").get().n,
        ports:     db.prepare("SELECT COUNT(*) AS n FROM port_locations").get().n,
        vessels:   db.prepare("SELECT COUNT(*) AS n FROM vessels").get().n,
      };
      ok(res, {
        status:        "ok",
        version:       require('../package.json').version,
        uptime:        Math.floor(process.uptime()),
        memoryMb:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        fxCurrencies:  Object.keys(fxCache.rates).length,
        fxCacheAgeMin: fxCache.ts ? Math.round((Date.now() - fxCache.ts) / 60000) : null,
        counts,
        migrations:    { failed: migrationFailures.length, details: migrationFailures },
        latency:       Date.now() - t,
        ts:            new Date().toISOString(),
      });
    } catch (e) {
      err(res, `Health check failed: ${e.message}`, 503);
    }
  });

  // ─── System Messages ──────────────────────────────────────────────────────

  app.get("/api/system-messages", (req, res) => {
    const now = new Date().toISOString().slice(0, 16);
    const rows = db.prepare(`SELECT * FROM system_messages
      WHERE (active_from = '' OR active_from <= ?)
        AND (active_to   = '' OR active_to   >= ?)
      ORDER BY created_at DESC`).all(now, now);
    ok(res, rows.map(mapSystemMessage));
  });

  app.get("/api/system-messages/all", (req, res) => {
    ok(res, db.prepare("SELECT * FROM system_messages ORDER BY created_at DESC").all().map(mapSystemMessage));
  });

  app.post("/api/system-messages", auth(), (req, res) => {
    const { title, body = "", severity = "info", activeFrom = "", activeTo = "" } = req.body;
    if (!title?.trim()) return err(res, "title required");
    const id = `MSG-${ctx.uid()}`;
    const createdAt = new Date().toISOString();
    db.prepare("INSERT INTO system_messages (id,title,body,severity,active_from,active_to,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, title.trim(), body.trim(), severity, activeFrom, activeTo, createdAt);
    logAdminEvent(req.user, 'SYSMSG_CREATED', 'system_message', id, { title: title.trim(), severity });
    ok(res, mapSystemMessage({ id, title: title.trim(), body: body.trim(), severity, active_from: activeFrom, active_to: activeTo, created_at: createdAt }), 201);
  });

  app.delete("/api/system-messages/:id", auth(), (req, res) => {
    const existing = db.prepare("SELECT title FROM system_messages WHERE id=?").get(req.params.id);
    const info = db.prepare("DELETE FROM system_messages WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    logAdminEvent(req.user, 'SYSMSG_DELETED', 'system_message', req.params.id, { title: existing?.title });
    ok(res, { deleted: req.params.id });
  });

  // ─── Settings ─────────────────────────────────────────────────────────────

  app.get("/api/settings", (req, res) => ok(res, getSettings()));

  // Excludes trade_manager/viewer specifically, without changing behavior for admin/operator/
  // occ_bk who already have unrestricted settings access today.
  app.put("/api/settings", auth(), requireRole(["admin", "operator", "occ_bk"]), (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== "object" || Array.isArray(updates))
      return err(res, "Expected JSON object of { key: value } pairs");
    const stmt = db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)");
    db.exec("BEGIN");
    try {
      for (const [k, v] of Object.entries(updates)) stmt.run(String(k), String(v));
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); return err(res, e.message); }
    scheduleNextOfacSync();
    restartAisListener();
    // Log settings changes — skip secrets
    const safeKeys = Object.fromEntries(
      Object.entries(updates).filter(([k]) => !k.includes('secret') && !k.includes('password'))
    );
    if (Object.keys(safeKeys).length) logAdminEvent(req.user, 'SETTINGS_UPDATED', 'settings', '', safeKeys);
    ok(res, getSettings());
  });

  // Admin-only: the Shipment Explorer sidebar's top-level nav order (ShipmentDetailSidebar,
  // App.jsx). A dedicated, more tightly-gated route rather than folding this into the generic
  // PUT /api/settings above (which also allows operator/occ_bk) — reordering everyone's nav is
  // a different class of action than the operational settings that route otherwise handles.
  // Reads still go through the existing GET /api/settings — every user needs the stored order
  // to render their own sidebar, only writing it is restricted.
  app.put("/api/settings/shipment-sidebar-order", auth(), requireRole(["admin"]), (req, res) => {
    const { order } = req.body || {};
    if (!Array.isArray(order) || order.some(id => typeof id !== "string"))
      return err(res, "order must be an array of section id strings");
    const value = JSON.stringify(order);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('shipment_sidebar_order', ?)").run(value);
    logAdminEvent(req.user, 'SETTINGS_UPDATED', 'settings', 'shipment_sidebar_order', { order });
    ok(res, { order });
  });

  // ─── Schedules ────────────────────────────────────────────────────────────

  const MAERSK_CODES = new Set(["MAEU", "SAFM", "MCPU"]);

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

  async function maerskSchedules(pol, pod, carrierCode, weeks) {
    const key = getSettings().maersk_api_key;
    if (!key) return null;
    try {
      const startDate = new Date().toISOString().slice(0, 10);
      const qs = new URLSearchParams({
        portOfOrigin: pol, portOfDestination: pod,
        startDateType: "D", startDate, searchRange: String(weeks),
      });
      const r = await fetch(`https://api.maersk.com/schedules/point-to-point?${qs}`, {
        headers: { "Consumer-Key": key, Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      const data = await r.json();
      const items = Array.isArray(data) ? data : (data.sailings || []);
      return items.map(s => {
        // services[]: one entry per sea leg (direct = 1, TSP = 2+)
        const services = s.services || [];
        const first    = services[0] || {};
        const legs = services.length > 1
          ? services.map(svc => ({
              pol:          svc.fromLocation?.unloCode || pol,
              pod:          svc.toLocation?.unloCode   || pod,
              etd:          (svc.departureDateTime || "").slice(0, 10),
              eta:          (svc.arrivalDateTime   || "").slice(0, 10),
              vesselName:   svc.vesselName   || "—",
              voyageNumber: svc.voyageNumber || "—",
              service:      svc.serviceCode  || "—",
            }))
          : null;   // null = direct sailing, no TSP
        return {
          carrier:      carrierCode,
          vesselName:   first.vesselName   || "—",
          voyageNumber: first.voyageNumber || "—",
          service:      first.serviceCode  || "—",
          pol, pod,
          etd:          (s.originDepartureDateTimeLocal      || "").slice(0, 10),
          eta:          (s.destinationArrivalDateTimeLocal   || "").slice(0, 10),
          transitDays:  s.transitTime || 0,
          legs,
          isMock: false,
        };
      });
    } catch { return null; }
  }

  // Catalog-backed matches (Test Tools > Schedule Generator, plus any ordinary Add-Sailing pick
  // saved elsewhere — the catalog search deliberately considers every stored shipment_schedules
  // row, not just Generator-authored ones, to maximize reuse) — checked before live/demo data.
  // ETD is matched as a window (today..today+weeks*7d), mirroring the same weeks semantics the
  // live/mock paths already use, since a stored schedule's ETD is a specific date, not a range.
  const catalogSailings = (pol, pod, weeks) => {
    const today = new Date().toISOString().slice(0, 10);
    const windowEnd = new Date(Date.now() + weeks * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // is_mock=0 excludes stale demo/mock data — before catalog search existed, picking ANY
    // sailing (mock, live, or catalog) via Add Sailing always inserted a shipment_schedules row
    // (POST /api/shipments/:id/schedules), including whatever synthetic "DEMO ..." sailing a user
    // happened to pick. Without this filter, those old rows resurface here mislabeled as real
    // curated matches — confirmed live (SHP-W942AJ returned 4 "DEMO DULCIMER"/"DEMO CADENZA" rows
    // tagged source:catalog, none of it real data).
    const rows = db.prepare(`
      SELECT * FROM shipment_schedules
      WHERE pol=? AND pod=? AND etd != '' AND etd >= ? AND etd <= ? AND is_mock=0
      ORDER BY etd ASC LIMIT 20`).all(pol, pod, today, windowEnd);
    return rows.map(r => {
      // Content-Keyed Sailing Legs — leg detail now lives in sailing_legs, referenced (not owned)
      // via schedule_leg_refs; same join getScheduleLegRows (routes/shipment-ops.js) uses.
      const legRows = db.prepare(`
        SELECT sl.* FROM schedule_leg_refs ref JOIN sailing_legs sl ON sl.leg_key = ref.leg_key
        WHERE ref.schedule_id=? ORDER BY ref.leg_order ASC
      `).all(r.id);
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
    });
  };

  app.get("/api/schedules/search", auth(), async (req, res) => {
    const { pol, pod, carrierCode, weeks: w = "4" } = req.query;
    if (!pol || !pod) return res.status(400).json({ error: "pol and pod are required" });
    const weeks = Math.min(Math.max(parseInt(w) || 4, 1), 12);

    const catalog = catalogSailings(pol, pod, weeks);
    let live = null;
    if (MAERSK_CODES.has(carrierCode)) live = await maerskSchedules(pol, pod, carrierCode, weeks);
    const liveTagged = (live || []).map(s => ({ ...s, source: "live" }));

    let sailings = [...catalog, ...liveTagged];
    const demoEnabled = getSettings().demo_schedules_enabled !== 'false'; // default on
    let usedDemo = false;
    if (sailings.length === 0 && demoEnabled) {
      sailings = mockSailings(pol, pod, carrierCode, weeks).map(s => ({ ...s, source: "mock" }));
      usedDemo = true;
    }
    const isMock = usedDemo; // kept for the frontend's existing isMock check
    ok(res, { sailings, pol, pod, carrierCode, isMock, catalogCount: catalog.length });
  });
};
