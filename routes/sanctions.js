"use strict";
// Extracted out of routes/customers.js (where these 5 routes had lived since day one, with no
// dedicated file of their own — unlike MDM, which already had routes/mdm.js before any split was
// proposed) as the first step of the Screening Service extraction. screenCustomer()/
// rescreenShipmentsForCustomer() stay in routes/customers.js — customer-domain, unchanged, they
// only ever read the shared sanctionsMap cache, never sanctions_entries/sanctions_syncs directly.
//
// 'local' (default) keeps every route below exactly as it's always behaved. 'remote' proxies to
// the standalone Screening Service instead. POST /sync and /sync-csl need NO route-level branch
// at all — syncOfacSdn()/syncConsolidatedScreeningList() (server.js) already branch internally,
// so calling them here is identical either way. Only /entries, /status, and /import-csv (which
// writes sanctions_entries directly in local mode) need an explicit branch here.
module.exports = function sanctionsRoutes(app, ctx) {
  const { db, ok, err, getSettings, callScreeningService,
          sanctionsMap, normSanctionName, loadSanctionsIndex,
          syncOfacSdn, syncConsolidatedScreeningList, scheduleNextOfacSync, scheduleNextCslSync,
          rescreenActiveShipments, createRateLimiter } = ctx;

  const isRemote = () => (getSettings().screening_source || "local") === "remote";

  // Both sync-triggering routes below are heavy (a live external OFAC/CSL fetch + full re-index,
  // or a full delete-and-bulk-reimport of sanctions_entries followed by a shipment-wide
  // re-screen) and reachable by any authenticated user — keyed per-user since the global gate
  // already requires a valid token here. Note: neither route is role-restricted today (any
  // viewer can trigger either); this limiter caps how often, not who — a pre-existing, disclosed
  // gap carried over unchanged from routes/customers.js, not something this extraction fixes.
  const sanctionsRateLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000, max: 5, maxEnvVar: "SANCTIONS_RATE_MAX",
    keyFn: req => req.user.id,
    message: "Too many sanctions sync/import requests recently — try again later",
  });

  // ─── CSV parsing (local to this domain, unchanged either way — pure string processing with
  // no dependency on which side owns the resulting data) ─────────────────────────────────────

  function parseCSVLine(line) {
    const fields = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) {
        fields.push(cur.trim()); cur = "";
      } else {
        cur += c;
      }
    }
    fields.push(cur.trim());
    return fields;
  }

  function parseOfacCsv(csvText) {
    const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const entries = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const f = parseCSVLine(raw);
      if (f.length < 2) continue;
      let entNum, name, sdnType, program;
      const recIndicator = f[0].replace(/[\s-]/g, "");
      if (/^\d+$/.test(recIndicator) && f[0].includes("-")) {
        if (recIndicator !== "0") continue;
        entNum = f[1]; name = f[2]; sdnType = f[3] || ""; program = f[4] || "";
      } else {
        entNum = f[0]; name = f[1]; sdnType = f[2] || ""; program = f[3] || "";
      }
      if (!name || !entNum) continue;
      if (/sdn_?name|^name$/i.test(name)) continue;
      entries.push({ refId: String(entNum), name, sdnType, program: program.replace(/;+$/, "") });
    }
    return entries;
  }

  // ─── Routes ─────────────────────────────────────────────────────────────────────────────────

  app.get("/api/sanctions/entries", async (req, res) => {
    if (isRemote()) {
      const qs = new URLSearchParams(req.query).toString();
      try { return ok(res, await callScreeningService("GET", `/internal/sanctions/entries${qs ? `?${qs}` : ""}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { search = '', limit = '50', offset = '0', source = '' } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
    const conditions = [], params = [];
    if (search.trim()) { conditions.push("(entity_name LIKE ? OR program LIKE ?)"); params.push(`%${search.trim()}%`, `%${search.trim()}%`); }
    if (source.trim()) { conditions.push("source = ?"); params.push(source.trim()); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS n FROM sanctions_entries ${where}`).get(...params).n;
    const rows  = db.prepare(`SELECT id, source, ref_id, entity_name, entity_type, program FROM sanctions_entries ${where} ORDER BY entity_name LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows, total, limit: lim, offset: off });
  });

  app.get("/api/sanctions/status", async (req, res) => {
    // `indexed` (the monolith's own in-memory sanctionsMap size) is meaningful in either mode —
    // it's what screening actually reads against, so it's attached locally regardless of where
    // the underlying rows live.
    if (isRemote()) {
      try {
        const remote = await callScreeningService("GET", "/internal/sanctions/status");
        return ok(res, { ...remote, indexed: sanctionsMap.size });
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const syncs = db.prepare("SELECT * FROM sanctions_syncs ORDER BY synced_at DESC").all();
    const count = db.prepare("SELECT COUNT(*) AS n FROM sanctions_entries").get().n;
    const ofacCount = db.prepare("SELECT COUNT(*) AS n FROM sanctions_entries WHERE source='OFAC-SDN'").get().n;
    const cslCount = db.prepare("SELECT COUNT(*) AS n FROM sanctions_entries WHERE id LIKE 'CSL-%'").get().n;
    ok(res, { syncs, entryCount: count, ofacEntryCount: ofacCount, cslEntryCount: cslCount, indexed: sanctionsMap.size });
  });

  // No isRemote() branch needed — syncOfacSdn() already branches internally (server.js) and
  // calls scheduleNextOfacSync() the same way it always has.
  app.post("/api/sanctions/sync", sanctionsRateLimit, async (req, res) => {
    try {
      ok(res, await syncOfacSdn());
      scheduleNextOfacSync();
    } catch (e) {
      err(res, e.message, 502);
    }
  });

  // Consolidated Screening List — the 11 US denied-party lists beyond OFAC's own SDN list
  // (BIS Denied Persons/Entity/Unverified/Military End User, State Dept ITAR Debarred +
  // Nonproliferation Sanctions, and 5 more OFAC-family lists). Additive to the OFAC sync above,
  // not a replacement — see syncConsolidatedScreeningList's own comment in server.js. No
  // isRemote() branch needed here either, same reasoning as /sync above.
  app.post("/api/sanctions/sync-csl", sanctionsRateLimit, async (req, res) => {
    try {
      ok(res, await syncConsolidatedScreeningList());
      scheduleNextCslSync();
    } catch (e) {
      err(res, e.message, 502);
    }
  });

  app.post("/api/sanctions/import-csv", sanctionsRateLimit, async (req, res) => {
    const { csv } = req.body;
    if (!csv || typeof csv !== "string") return err(res, "csv string required");
    const entries = parseOfacCsv(csv);
    if (entries.length === 0) return err(res, "No valid entries found — check the file format");
    if (isRemote()) {
      try {
        const result = await callScreeningService("POST", "/internal/sanctions/import-csv", { entries });
        await loadSanctionsIndex();
        scheduleNextOfacSync();
        rescreenActiveShipments();
        return ok(res, result);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      db.prepare("DELETE FROM sanctions_entries WHERE source='OFAC-SDN'").run();
      const ins = db.prepare(
        `INSERT OR REPLACE INTO sanctions_entries
           (id, source, ref_id, entity_name, entity_name_norm, entity_type, program, aliases_norm)
         VALUES (?, 'OFAC-SDN', ?, ?, ?, ?, ?, '[]')`
      );
      db.exec("BEGIN");
      try {
        for (const e of entries)
          ins.run(`OFAC-${e.refId}`, e.refId, e.name, normSanctionName(e.name), e.sdnType, e.program);
        db.exec("COMMIT");
      } catch (e2) { db.exec("ROLLBACK"); throw e2; }
      const now = new Date().toISOString();
      db.prepare("INSERT OR REPLACE INTO sanctions_syncs (source, synced_at, entry_count) VALUES ('OFAC-SDN', ?, ?)").run(now, entries.length);
      await loadSanctionsIndex();
      scheduleNextOfacSync();
      rescreenActiveShipments();
      ok(res, { source: "OFAC-SDN", syncedAt: now, entries: entries.length });
    } catch (e) {
      err(res, e.message, 400);
    }
  });
};
