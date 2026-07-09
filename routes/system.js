"use strict";

module.exports = function systemRoutes(app, ctx) {
  const { db, ok, err, auth,
          mapSystemMessage, getSettings, scheduleNextOfacSync, fxCache,
          logAdminEvent } = ctx;

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

  app.put("/api/settings", auth(), (req, res) => {
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
    // Log settings changes — skip secrets
    const safeKeys = Object.fromEntries(
      Object.entries(updates).filter(([k]) => !k.includes('secret') && !k.includes('password'))
    );
    if (Object.keys(safeKeys).length) logAdminEvent(req.user, 'SETTINGS_UPDATED', 'settings', '', safeKeys);
    ok(res, getSettings());
  });

  // ─── Schedules ────────────────────────────────────────────────────────────

  const MAERSK_CODES = new Set(["MAEU", "SAFM", "MCPU"]);

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
      return {
        carrier: carrierCode || "—",
        vesselName: `DEMO ${NAMES[i % NAMES.length]}`,
        voyageNumber: `DM${String(i + 1).padStart(3, "0")}W`,
        service: "DEMO SERVICE",
        pol, pod,
        etd: etd.toISOString().slice(0, 10),
        eta: eta.toISOString().slice(0, 10),
        transitDays: transit,
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
        const svc = (s.services || [])[0] || {};
        return {
          carrier: carrierCode,
          vesselName: svc.vesselName || "—",
          voyageNumber: svc.voyageNumber || "—",
          service: svc.serviceCode || "—",
          pol, pod,
          etd: (s.originDepartureDateTimeLocal || "").slice(0, 10),
          eta: (s.destinationArrivalDateTimeLocal || "").slice(0, 10),
          transitDays: s.transitTime || 0,
          isMock: false,
        };
      });
    } catch { return null; }
  }

  app.get("/api/schedules/search", auth(), async (req, res) => {
    const { pol, pod, carrierCode, weeks: w = "4" } = req.query;
    if (!pol || !pod) return res.status(400).json({ error: "pol and pod are required" });
    const weeks = Math.min(Math.max(parseInt(w) || 4, 1), 12);
    let sailings = null;
    if (MAERSK_CODES.has(carrierCode)) sailings = await maerskSchedules(pol, pod, carrierCode, weeks);
    const isMock = !sailings;
    if (isMock) sailings = mockSailings(pol, pod, carrierCode, weeks);
    ok(res, { sailings, pol, pod, carrierCode, isMock });
  });
};
