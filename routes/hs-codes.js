"use strict";

// HS Codes MDM registry — international 6-digit Harmonized System classification codes, kept
// deliberately separate from `commodities` (that table is CargoDesk's own internal cargo-grade/
// handling classification, e.g. "Food Grade" — unrelated to customs tariff classification).
// hsChapter is the same 2-digit shape as duty_rate_chapters.hs_chapter so the two registries can
// be cross-referenced (an HS code's chapter looked up against duty_rate_chapters for its
// illustrative duty %) without a formal FK.
//
// Sourcing note (2026-09-18 research): there is no free, bulk-downloadable full WCO nomenclature
// (~5,300 six-digit codes) — the one candidate free API (tariffnumber.com) is EU Combined
// Nomenclature/TARIC only, not global HS, and its free tier's own terms forbid storing/caching
// results at all. So this table is seeded (data/hs-codes.json, scripts/import-mdm-data.js) with a
// curated ~50-code set of real, well-known international HS-6 codes spanning common freight
// categories — accurate but deliberately not a claim of completeness. No remote/MDM-microservice
// mirroring (matching duty-rates.js's own local-only scope, not every MDM table has one).
module.exports = function hsCodeRoutes(app, ctx) {
  const { query, ok, err, requireRole, isUniqueViolation, mapHsCode } = ctx;
  const write = requireRole(["admin", "operator"]);

  app.get("/api/hs-codes", async (req, res) => {
    const { search = "", chapter = "", limit = 50, offset = 0 } = req.query;
    const clauses = [], params = [];
    if (search) { params.push(`%${search}%`); clauses.push(`(code ILIKE $${params.length} OR description ILIKE $${params.length})`); }
    if (chapter) { params.push(chapter); clauses.push(`hs_chapter = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const lim = Math.min(Number(limit) || 50, 200), off = Number(offset) || 0;
    const p = n => { params.push(n); return `$${params.length}`; };
    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM hs_codes ${where}`, params);
    const rows = await query(`SELECT * FROM hs_codes ${where} ORDER BY code LIMIT ${p(lim)} OFFSET ${p(off)}`, params);
    ok(res, { results: rows.map(mapHsCode), total: Number(total), limit: lim, offset: off });
  });

  // Typeahead — mirrors GET /api/commodities/search's shape, used by any future HS-code picker
  // field (e.g. wiring ContainerPackagesPanel.jsx's free-text hsCode input to a real lookup).
  app.get("/api/hs-codes/search", async (req, res) => {
    const { q = "" } = req.query;
    if (!q) return ok(res, []);
    const rows = await query("SELECT * FROM hs_codes WHERE code ILIKE $1 OR description ILIKE $1 ORDER BY code LIMIT 12", [`%${q}%`]);
    ok(res, rows.map(mapHsCode));
  });

  // Live EU Combined Nomenclature/TARIC lookup — tariffnumber.com's free, unauthenticated V1
  // endpoint, proxied server-side (browser calls would fail CORS/CSP anyway). Deliberately never
  // written to hs_codes or any other table: the free tier's own terms forbid storing or caching
  // results ("API results may not be stored or cached"), so every call here is live and its
  // response is returned straight through, not persisted. `value` comes back as an HTML-wrapped
  // string (the code re-echoed in a <span>, then the description) — stripped down to plain code/
  // description pairs so the frontend never has to trust/render raw third-party HTML. A network
  // failure degrades to an empty list rather than an error, same convention every other
  // remote-MDM-lookup in this codebase already uses (see routes/loop-codes.js's callMdmService
  // catches) — this is a "nice to have" helper, not a page-blocking dependency.
  app.get("/api/hs-codes/eu-lookup", async (req, res) => {
    const { term = "" } = req.query;
    if (!term.trim()) return ok(res, []);
    try {
      const upstream = await fetch(`https://www.tariffnumber.com/api/v1/cnSuggest?term=${encodeURIComponent(term)}&lang=en`);
      if (!upstream.ok) return ok(res, []);
      const data = await upstream.json();
      const decodeEntities = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      const results = (data.suggestions || [])
        .filter(s => s.code)
        .map(s => ({ code: s.code, description: decodeEntities(String(s.value || "").replace(/<[^>]*>/g, "")).replace(/^\s*\d+\s*/, "").trim() }));
      ok(res, results);
    } catch { ok(res, []); }
  });

  app.get("/api/hs-codes/:code", async (req, res) => {
    const [r] = await query("SELECT * FROM hs_codes WHERE code=$1", [req.params.code]);
    if (!r) return err(res, "Not found", 404);
    ok(res, mapHsCode(r));
  });

  app.post("/api/hs-codes", write, async (req, res) => {
    const { code, description, hsChapter, chapterName = "" } = req.body || {};
    if (!code || !code.trim()) return err(res, "code is required");
    if (!/^\d{6}$/.test(code.trim())) return err(res, "code must be a 6-digit HS code");
    if (!description || !description.trim()) return err(res, "description is required");
    if (!hsChapter || !/^\d{2}$/.test(hsChapter.trim())) return err(res, "hsChapter must be a 2-digit HS chapter code");
    const now = new Date().toISOString();
    try {
      await query(
        "INSERT INTO hs_codes (code,description,hs_chapter,chapter_name,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)",
        [code.trim(), description.trim(), hsChapter.trim(), chapterName.trim(), now]
      );
      const [r] = await query("SELECT * FROM hs_codes WHERE code=$1", [code.trim()]);
      ok(res, mapHsCode(r), 201);
    } catch (e) {
      err(res, isUniqueViolation(e) ? `HS code ${code.trim()} already exists` : e.message);
    }
  });

  app.put("/api/hs-codes/:code", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM hs_codes WHERE code=$1", [req.params.code]);
    if (!existing) return err(res, "Not found", 404);
    const {
      description = existing.description, hsChapter = existing.hs_chapter,
      chapterName = existing.chapter_name, isActive = existing.is_active,
    } = req.body || {};
    if (!description || !description.trim()) return err(res, "description is required");
    if (!hsChapter || !/^\d{2}$/.test(hsChapter.trim())) return err(res, "hsChapter must be a 2-digit HS chapter code");
    const now = new Date().toISOString();
    await query(
      "UPDATE hs_codes SET description=$1, hs_chapter=$2, chapter_name=$3, is_active=$4, updated_at=$5 WHERE code=$6",
      [description.trim(), hsChapter.trim(), chapterName.trim(), !!isActive, now, req.params.code]
    );
    const [r] = await query("SELECT * FROM hs_codes WHERE code=$1", [req.params.code]);
    ok(res, mapHsCode(r));
  });

  app.delete("/api/hs-codes/:code", write, async (req, res) => {
    const deleted = await query("DELETE FROM hs_codes WHERE code=$1 RETURNING code", [req.params.code]);
    if (deleted.length === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.code });
  });
};
