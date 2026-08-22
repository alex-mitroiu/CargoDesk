// Flat-rate-by-HS-chapter registry backing the landed-cost/duty estimate (TKT-U6IZCL, FCL
// Coverage Audit epic TKT-6PO7SV) — admin-maintained reference data, same shape/role
// pack_type_definitions/charge_code_definitions already have. Any HS chapter not listed here
// falls back to DEFAULT_DUTY_RATE_PCT at compute time (routes/shipment-ops.js).
module.exports = function dutyRateRoutes(app, ctx) {
  const { db, ok, err, requireRole, mapDutyRateChapter } = ctx;
  const write = requireRole(["admin", "operator", "trade_manager"]);

  app.get("/api/duty-rate-chapters", (req, res) => {
    const rows = db.prepare("SELECT * FROM duty_rate_chapters ORDER BY hs_chapter").all();
    ok(res, rows.map(mapDutyRateChapter));
  });

  app.post("/api/duty-rate-chapters", write, (req, res) => {
    const { hsChapter, label, ratePct } = req.body || {};
    if (!hsChapter || !/^\d{2}$/.test(hsChapter.trim())) return err(res, "hsChapter must be a 2-digit HS chapter code");
    if (!label) return err(res, "label is required");
    const rate = Number(ratePct);
    if (!Number.isFinite(rate) || rate < 0) return err(res, "ratePct must be a non-negative number");
    const now = new Date().toISOString();
    try {
      db.prepare("INSERT INTO duty_rate_chapters (hs_chapter,label,rate_pct,created_at) VALUES (?,?,?,?)")
        .run(hsChapter.trim(), label.trim(), rate, now);
      ok(res, mapDutyRateChapter({ hs_chapter: hsChapter.trim(), label: label.trim(), rate_pct: rate, created_at: now }), 201);
    } catch (e) {
      err(res, e.message?.includes("UNIQUE") ? `Chapter ${hsChapter} already exists` : e.message);
    }
  });

  app.put("/api/duty-rate-chapters/:chapter", write, (req, res) => {
    const existing = db.prepare("SELECT * FROM duty_rate_chapters WHERE hs_chapter=?").get(req.params.chapter);
    if (!existing) return err(res, "Not found", 404);
    const { label, ratePct } = req.body || {};
    if (!label) return err(res, "label is required");
    const rate = Number(ratePct);
    if (!Number.isFinite(rate) || rate < 0) return err(res, "ratePct must be a non-negative number");
    db.prepare("UPDATE duty_rate_chapters SET label=?, rate_pct=? WHERE hs_chapter=?").run(label.trim(), rate, req.params.chapter);
    ok(res, mapDutyRateChapter({ ...existing, label: label.trim(), rate_pct: rate }));
  });

  app.delete("/api/duty-rate-chapters/:chapter", write, (req, res) => {
    const info = db.prepare("DELETE FROM duty_rate_chapters WHERE hs_chapter=?").run(req.params.chapter);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.chapter });
  });
};
