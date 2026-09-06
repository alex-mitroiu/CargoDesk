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
  const { query, transaction, ok, err, getSettings, callScreeningService,
          sanctionsMap, normSanctionName, loadSanctionsIndex, requireRole,
          syncOfacSdn, syncConsolidatedScreeningList, scheduleNextOfacSync, scheduleNextCslSync,
          rescreenActiveShipments, rescreenAllCustomers, createRateLimiter } = ctx;

  const isRemote = async () => ((await getSettings()).screening_source || "local") === "remote";

  // Both sync-triggering routes below are heavy (a live external OFAC/CSL fetch + full re-index,
  // or a full delete-and-bulk-reimport of sanctions_entries followed by a shipment-wide
  // re-screen), keyed per-user since the global gate already requires a valid token here.
  // 2026-09-05 audit: this used to cap only how OFTEN, not WHO — confirmed live (and expensively:
  // a "safe-looking" test payload sent as a scratch viewer-role account turned out to parse as 2
  // real entries, silently wiping the entire real OFAC-SDN dataset down to those 2 rows before
  // the gap was even reported) that a plain viewer could trigger a full destructive replace of
  // the compliance screening dataset. adminOnly below closes it; the rate limiter still applies
  // on top, unchanged.
  const adminOnly = requireRole(["admin"]);
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
    if (await isRemote()) {
      const qs = new URLSearchParams(req.query).toString();
      try { return ok(res, await callScreeningService("GET", `/internal/sanctions/entries${qs ? `?${qs}` : ""}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { search = '', limit = '50', offset = '0', source = '' } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
    const conditions = [], params = [];
    const p = v => { params.push(v); return `$${params.length}`; };
    if (search.trim()) { conditions.push(`(entity_name ILIKE ${p(`%${search.trim()}%`)} OR program ILIKE ${p(`%${search.trim()}%`)})`); }
    if (source.trim()) { conditions.push(`source = ${p(source.trim())}`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM sanctions_entries ${where}`, params);
    const rows  = await query(`SELECT id, source, ref_id, entity_name, entity_type, program FROM sanctions_entries ${where} ORDER BY entity_name LIMIT ${p(lim)} OFFSET ${p(off)}`, params);
    ok(res, { results: rows, total: Number(total), limit: lim, offset: off });
  });

  app.get("/api/sanctions/status", async (req, res) => {
    // `indexed` (the monolith's own in-memory sanctionsMap size) is meaningful in either mode —
    // it's what screening actually reads against, so it's attached locally regardless of where
    // the underlying rows live.
    if (await isRemote()) {
      try {
        const remote = await callScreeningService("GET", "/internal/sanctions/status");
        return ok(res, { ...remote, indexed: sanctionsMap.size });
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const syncs = await query("SELECT * FROM sanctions_syncs ORDER BY synced_at DESC");
    const [{ n: count }] = await query("SELECT COUNT(*) AS n FROM sanctions_entries");
    const [{ n: ofacCount }] = await query("SELECT COUNT(*) AS n FROM sanctions_entries WHERE source='OFAC-SDN'");
    const [{ n: cslCount }] = await query("SELECT COUNT(*) AS n FROM sanctions_entries WHERE id LIKE 'CSL-%'");
    ok(res, { syncs, entryCount: Number(count), ofacEntryCount: Number(ofacCount), cslEntryCount: Number(cslCount), indexed: sanctionsMap.size });
  });

  // No isRemote() branch needed — syncOfacSdn() already branches internally (server.js) and
  // calls scheduleNextOfacSync() the same way it always has.
  app.post("/api/sanctions/sync", adminOnly, sanctionsRateLimit, async (req, res) => {
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
  app.post("/api/sanctions/sync-csl", adminOnly, sanctionsRateLimit, async (req, res) => {
    try {
      ok(res, await syncConsolidatedScreeningList());
      scheduleNextCslSync();
    } catch (e) {
      err(res, e.message, 502);
    }
  });

  app.post("/api/sanctions/import-csv", adminOnly, sanctionsRateLimit, async (req, res) => {
    const { csv } = req.body;
    if (!csv || typeof csv !== "string") return err(res, "csv string required");
    const entries = parseOfacCsv(csv);
    if (entries.length === 0) return err(res, "No valid entries found — check the file format");
    if (await isRemote()) {
      try {
        const result = await callScreeningService("POST", "/internal/sanctions/import-csv", { entries });
        await loadSanctionsIndex();
        scheduleNextOfacSync();
        await rescreenActiveShipments();
        await rescreenAllCustomers();
        return ok(res, result);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    try {
      await transaction(async (tx) => {
        await tx.query("DELETE FROM sanctions_entries WHERE source='OFAC-SDN'");
        for (const e of entries)
          await tx.query(
            `INSERT INTO sanctions_entries
               (id, source, ref_id, entity_name, entity_name_norm, entity_type, program, aliases_norm)
             VALUES ($1, 'OFAC-SDN', $2, $3, $4, $5, $6, '[]')
             ON CONFLICT (id) DO UPDATE SET source='OFAC-SDN', ref_id=$2, entity_name=$3, entity_name_norm=$4, entity_type=$5, program=$6, aliases_norm='[]'`,
            [`OFAC-${e.refId}`, e.refId, e.name, normSanctionName(e.name), e.sdnType, e.program]);
      });
      const now = new Date().toISOString();
      await query(
        `INSERT INTO sanctions_syncs (source, synced_at, entry_count) VALUES ('OFAC-SDN', $1, $2)
         ON CONFLICT (source) DO UPDATE SET synced_at=$1, entry_count=$2`,
        [now, entries.length]);
      await loadSanctionsIndex();
      scheduleNextOfacSync();
      await rescreenActiveShipments();
      await rescreenAllCustomers();
      ok(res, { source: "OFAC-SDN", syncedAt: now, entries: entries.length });
    } catch (e) {
      err(res, e.message, 400);
    }
  });
};
