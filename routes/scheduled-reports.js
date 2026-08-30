// Scheduled / emailed reports (TKT-IXAR9G, Competitive Gap Analysis epic TKT-GTGM6R) —
// reporting today was manual-trigger only; this lets an admin configure a report to be
// generated and emailed on a recurring cadence, reusing office_mail_settings/sendViaOffice
// (already built for the invoice-email flow) rather than new mail infrastructure. The actual
// sweep (runScheduledReportsSweep) lives in server.js, on the same daily-tick idiom the
// dunning-reminder sweep already established.
module.exports = function scheduledReportRoutes(app, ctx) {
  const { query, ok, err, uid, auth, requireRole, mapScheduledReport, runScheduledReportsSweep } = ctx;
  const REPORT_TYPES = ["shipments-csv"];
  const FREQUENCIES = ["daily", "weekly", "monthly"];
  // Same admin-only tier as the manual dunning-reminder trigger — configuring or firing a
  // schedule that sends real outbound email is a step above viewing/generating a report once.
  const write = requireRole(["admin"]);

  const OFFICE_JOIN = `
    SELECT sr.*, o.name AS office_name
    FROM scheduled_reports sr
    LEFT JOIN offices o ON o.id = sr.office_id
  `;

  app.get("/api/scheduled-reports", auth(), async (req, res) => {
    const rows = await query(`${OFFICE_JOIN} ORDER BY sr.created_at DESC`);
    ok(res, rows.map(mapScheduledReport));
  });

  app.post("/api/scheduled-reports", write, async (req, res) => {
    const { reportType, frequency, recipients, officeId, isActive = true } = req.body || {};
    if (!REPORT_TYPES.includes(reportType)) return err(res, `reportType must be one of: ${REPORT_TYPES.join(", ")}`);
    if (!FREQUENCIES.includes(frequency)) return err(res, `frequency must be one of: ${FREQUENCIES.join(", ")}`);
    const recipientList = (recipients || "").split(",").map(s => s.trim()).filter(Boolean);
    if (recipientList.length === 0) return err(res, "At least one recipient email is required");
    if (!officeId) return err(res, "officeId is required — whose mail settings should send this report?");
    const [office] = await query("SELECT id FROM offices WHERE id=$1", [officeId]);
    if (!office) return err(res, "Office not found", 404);

    const id = `SREP-${uid()}`;
    const now = new Date().toISOString();
    const createdBy = req.user?.name || req.user?.email || "";
    await query(`INSERT INTO scheduled_reports (id, report_type, frequency, recipients, office_id, is_active, created_by, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, reportType, frequency, recipientList.join(","), officeId, !!isActive, createdBy, now]);
    const [row] = await query(`${OFFICE_JOIN} WHERE sr.id=$1`, [id]);
    ok(res, mapScheduledReport(row), 201);
  });

  app.put("/api/scheduled-reports/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM scheduled_reports WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const { reportType, frequency, recipients, officeId, isActive } = req.body || {};
    if (reportType && !REPORT_TYPES.includes(reportType)) return err(res, `reportType must be one of: ${REPORT_TYPES.join(", ")}`);
    if (frequency && !FREQUENCIES.includes(frequency)) return err(res, `frequency must be one of: ${FREQUENCIES.join(", ")}`);
    const recipientList = recipients !== undefined
      ? recipients.split(",").map(s => s.trim()).filter(Boolean)
      : existing.recipients.split(",").map(s => s.trim()).filter(Boolean);
    if (recipientList.length === 0) return err(res, "At least one recipient email is required");
    if (officeId) {
      const [office] = await query("SELECT id FROM offices WHERE id=$1", [officeId]);
      if (!office) return err(res, "Office not found", 404);
    }
    await query(`UPDATE scheduled_reports SET report_type=$1, frequency=$2, recipients=$3, office_id=$4, is_active=$5 WHERE id=$6`,
      [reportType || existing.report_type, frequency || existing.frequency, recipientList.join(","),
       officeId || existing.office_id, isActive !== undefined ? !!isActive : existing.is_active, req.params.id]);
    const [row] = await query(`${OFFICE_JOIN} WHERE sr.id=$1`, [req.params.id]);
    ok(res, mapScheduledReport(row));
  });

  app.delete("/api/scheduled-reports/:id", write, async (req, res) => {
    const deleted = await query("DELETE FROM scheduled_reports WHERE id=$1 RETURNING id", [req.params.id]);
    if (deleted.length === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // Manual trigger — mirrors POST /api/billing/send-reminders exactly: the real sweep runs on
  // a daily interval at server boot, this exposes the identical function as an admin action so
  // testing/verification doesn't require waiting up to 24h for a real report to go out.
  app.post("/api/scheduled-reports/send-due", write, async (req, res) => {
    try {
      const sent = await runScheduledReportsSweep();
      ok(res, { sentCount: sent.length, sent });
    } catch (e) { err(res, e.message || "Scheduled report sweep failed", 500); }
  });
};
