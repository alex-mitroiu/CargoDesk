"use strict";

// Consolidated/Statement Billing — one billing document spanning several shipments for the same
// customer, alongside (never replacing) the existing per-shipment FR01/FR02 flow. Manual,
// on-demand only (no scheduled/recurring generation — a clearly separate follow-on, not built
// here). See lib/schema.js's own comment on customer_statements/customer_statement_lines for why
// this needed its own tables rather than reusing shipment_documents.
//
// Same client-builds-HTML/server-renders-and-signs split every other generated document already
// follows (buildStatementHtml, src/utils/invoiceGenerator.js) — this route never constructs the
// document's own markup.

module.exports = function customerStatementsRoutes(app, ctx) {
  const {
    query, ok, err, uid, requireRole,
    mapCustomerStatement, mapCustomerStatementLine,
    getCustomerRow, computeArExposure, toUsd,
    renderHtmlToPdf, getActiveSigningCert, signPdfBuffer,
    logEntityEvent, UPLOADS_DIR, fs, path,
  } = ctx;
  const write = requireRole(["admin", "operator"]);

  const withLines = async statement => {
    const lines = await query("SELECT * FROM customer_statement_lines WHERE statement_id=$1 ORDER BY sort_order", [statement.id]);
    return { ...mapCustomerStatement(statement), lines: lines.map(mapCustomerStatementLine) };
  };

  app.get("/api/customer-statements", async (req, res) => {
    const { customerId, status } = req.query;
    const clauses = [], params = [];
    if (customerId) { params.push(customerId); clauses.push(`customer_id=$${params.length}`); }
    if (status)     { params.push(status);     clauses.push(`status=$${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await query(`SELECT * FROM customer_statements ${where} ORDER BY created_at DESC`, params);
    ok(res, rows.map(mapCustomerStatement));
  });

  // Registered BEFORE the :id route below (same reason /api/shipments/compliance-hits sits
  // before /api/shipments/:id — a wildcard :id registered first would swallow "eligible-lines"
  // as if it were an id; a real bug caught by this feature's own test suite). Which of this
  // customer's SELL cost lines, in the date range, are actually billable into a NEW statement —
  // excludes anything already on a confirmed per-shipment invoice/credit-debit note (checked via
  // source_cost_line_ids, in JS since it's a JSON array column, not joinable) and anything
  // already on a draft or confirmed statement (a voided statement's lines return to the pool —
  // it never happened). The operator can still deselect any of these before Generate; this is
  // the eligible SET, not a forced inclusion.
  app.get("/api/customer-statements/eligible-lines", async (req, res) => {
    const { customerId, dateFrom, dateTo } = req.query;
    if (!customerId || !dateFrom || !dateTo) return err(res, "customerId, dateFrom and dateTo are required");

    const shipmentRows = await query(
      "SELECT id FROM shipments WHERE principal_id=$1 OR consignee_id=$1", [customerId]);
    const shipmentIds = shipmentRows.map(r => r.id);
    if (!shipmentIds.length) return ok(res, []);

    const ph = shipmentIds.map((_, i) => `$${i + 3}`).join(",");
    const lines = await query(
      `SELECT * FROM shipment_cost_lines
       WHERE type='SELL' AND shipment_id IN (${ph}) AND created_at >= $1 AND created_at <= $2
       ORDER BY created_at`,
      [dateFrom, `${dateTo}T23:59:59.999Z`, ...shipmentIds]);
    if (!lines.length) return ok(res, []);

    // A fresh $1.. placeholder string, bound to shipmentIds alone — NOT `ph` above, which is
    // offset to $3.. to make room for the OTHER query's own dateFrom/dateTo (a real bug caught
    // by this feature's own test suite: reusing `ph` here left $1/$2 referenced nowhere in this
    // query's text while only 2 values were bound, which pglite/Postgres can't type-infer).
    const shipmentPh = shipmentIds.map((_, i) => `$${i + 1}`).join(",");
    const confirmedDocs = await query(
      `SELECT source_cost_line_ids FROM shipment_documents
       WHERE doc_type IN ('FR01','FR02','CN01') AND status='confirmed' AND shipment_id IN (${shipmentPh})`,
      shipmentIds);
    const alreadyInvoiced = new Set();
    for (const d of confirmedDocs) {
      if (!d.source_cost_line_ids) continue;
      for (const id of JSON.parse(d.source_cost_line_ids)) alreadyInvoiced.add(id);
    }
    const statementLines = await query(
      `SELECT csl.cost_line_id FROM customer_statement_lines csl
       JOIN customer_statements cs ON cs.id = csl.statement_id
       WHERE cs.status != 'voided' AND csl.cost_line_id IN (${lines.map((_, i) => `$${i + 1}`).join(",")})`,
      lines.map(l => l.id));
    const alreadyStatemented = new Set(statementLines.map(r => r.cost_line_id));

    const eligible = lines.filter(l => !alreadyInvoiced.has(l.id) && !alreadyStatemented.has(l.id));
    ok(res, eligible.map(l => ({
      id: l.id, shipmentId: l.shipment_id, chargeCode: l.charge_code, notes: l.notes || '',
      amount: l.amount, currency: l.currency, createdAt: l.created_at,
    })));
  });

  app.get("/api/customer-statements/:id", async (req, res) => {
    const [row] = await query("SELECT * FROM customer_statements WHERE id=$1", [req.params.id]);
    if (!row) return err(res, "Not found", 404);
    ok(res, await withLines(row));
  });

  // Mirrors GET /api/shipments/:shipmentId/documents/:docId/download exactly (same
  // inline-vs-attachment PDF convention) — statements have no shipment_id to nest this under.
  // A GET on a path ONE segment deeper than :id (:id/download) is never ambiguous with :id
  // itself, unlike eligible-lines above, so this one's position relative to :id doesn't matter.
  app.get("/api/customer-statements/:id/download", async (req, res) => {
    const [row] = await query("SELECT * FROM customer_statements WHERE id=$1", [req.params.id]);
    if (!row) return err(res, "Not found", 404);
    const filePath = path.join(UPLOADS_DIR, row.stored_name);
    if (!fs.existsSync(filePath)) return err(res, "File not found on disk", 404);
    res.setHeader("Content-Disposition", `inline; filename="${row.filename}"`);
    res.setHeader("Content-Type", "application/pdf");
    fs.createReadStream(filePath).pipe(res);
  });

  app.post("/api/customer-statements/generate", write, async (req, res) => {
    const { customerId, dateFrom, dateTo, costLineIds, html, filename } = req.body || {};
    if (!customerId || !dateFrom || !dateTo) return err(res, "customerId, dateFrom and dateTo are required");
    if (!Array.isArray(costLineIds) || !costLineIds.length) return err(res, "Select at least one charge line");
    if (!html || !filename) return err(res, "html and filename are required");

    const customer = await getCustomerRow(customerId);
    if (!customer) return err(res, "Customer not found", 404);
    // Same credit-hold check every other billing path enforces — no override path for a
    // statement yet (unlike a single shipment's own credit_overrides flow, which this
    // deliberately doesn't try to extend to a multi-shipment document): a customer genuinely
    // over limit or on hold needs the existing per-shipment override route, or a controller's
    // manual sign-off, before a statement can be generated for them.
    if (customer.creditHold) return err(res, `Cannot generate a statement — ${customer.companyName} is on credit hold${customer.creditHoldReason ? ` (${customer.creditHoldReason})` : ''}`, 409);
    if (customer.creditLimit != null) {
      const { outstandingAr, committedExposure } = await computeArExposure(customer.id, customer.creditTermsDays);
      const limitUsd = await toUsd(customer.creditLimit, customer.currency || 'USD');
      if (outstandingAr + committedExposure > limitUsd)
        return err(res, `Cannot generate a statement — ${customer.companyName} is over their credit limit`, 409);
    }

    const lines = await query(
      `SELECT * FROM shipment_cost_lines WHERE type='SELL' AND id IN (${costLineIds.map((_, i) => `$${i + 1}`).join(",")})`,
      costLineIds);
    if (!lines.length) return err(res, "None of the selected charge lines were found");
    const currencies = new Set(lines.map(l => l.currency));
    if (currencies.size > 1) return err(res, "All selected charge lines must share one currency for a single statement");
    const currency = [...currencies][0];
    const totalAmount = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

    try {
      const cert = await getActiveSigningCert(query);
      const rawPdf = await renderHtmlToPdf(html);
      const signedPdf = await signPdfBuffer(Buffer.from(rawPdf), cert);
      const pdfFilename = `${path.parse(filename).name}.pdf`;
      const storedName  = `${Date.now()}_${uid()}.pdf`;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), signedPdf);

      const id = `STMT-${uid()}`;
      const now = new Date().toISOString();
      const actor = req.user?.name || req.user?.email || "";
      await query(
        `INSERT INTO customer_statements
         (id, customer_id, customer_name, date_from, date_to, currency, status, total_amount, filename, stored_name, size_bytes, created_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12)`,
        [id, customerId, customer.companyName || "", dateFrom, dateTo, currency, totalAmount, pdfFilename, storedName, signedPdf.length, now, actor]);
      let sortOrder = 0;
      for (const l of lines) {
        await query(
          `INSERT INTO customer_statement_lines (id, statement_id, shipment_id, cost_line_id, charge_code, description, amount, currency, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [`CSL-${uid()}`, id, l.shipment_id, l.id, l.charge_code, l.notes || "", l.amount, l.currency, sortOrder++]);
      }
      await logEntityEvent('customer_statement', id, 'GENERATED', null, null, null,
        JSON.stringify({ customerId, dateFrom, dateTo, lineCount: lines.length, totalAmount, currency }));

      const [row] = await query("SELECT * FROM customer_statements WHERE id=$1", [id]);
      ok(res, await withLines(row), 201);
    } catch (e) {
      err(res, e.message, e.status || 500);
    }
  });

  app.post("/api/customer-statements/:id/confirm", write, async (req, res) => {
    const [row] = await query("SELECT * FROM customer_statements WHERE id=$1", [req.params.id]);
    if (!row) return err(res, "Not found", 404);
    if (row.status !== "draft") return err(res, "Only a draft statement can be confirmed", 409);
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    await query("UPDATE customer_statements SET status='confirmed', confirmed_at=$1, confirmed_by=$2 WHERE id=$3", [now, actor, row.id]);
    await logEntityEvent('customer_statement', row.id, 'CONFIRMED', null, null, null, JSON.stringify({ customerId: row.customer_id }));
    const [updated] = await query("SELECT * FROM customer_statements WHERE id=$1", [row.id]);
    ok(res, await withLines(updated));
  });

  app.post("/api/customer-statements/:id/mark-paid", write, async (req, res) => {
    const [row] = await query("SELECT * FROM customer_statements WHERE id=$1", [req.params.id]);
    if (!row) return err(res, "Not found", 404);
    if (row.status !== "confirmed") return err(res, "Only a confirmed statement can be marked paid", 409);
    const { paidAt, paidAmount } = req.body || {};
    if (!paidAt) return err(res, "paidAt is required");
    if (paidAmount === undefined || paidAmount === null || paidAmount === "" || Number(paidAmount) <= 0)
      return err(res, "paidAmount must be a positive number");
    await query("UPDATE customer_statements SET paid_at=$1, paid_amount=$2 WHERE id=$3", [paidAt, Number(paidAmount), row.id]);
    await logEntityEvent('customer_statement', row.id, 'MARKED_PAID', null, null, null, JSON.stringify({ paidAt, paidAmount: Number(paidAmount) }));
    const [updated] = await query("SELECT * FROM customer_statements WHERE id=$1", [row.id]);
    ok(res, await withLines(updated));
  });

  // Voiding a CONFIRMED statement (undoing across several shipments' worth of billing at once)
  // is real complexity deliberately not built in this pass — only an unconfirmed draft can be
  // voided/removed, mirroring how a draft FR01/FR02 is simply deleted and regenerated today.
  app.post("/api/customer-statements/:id/void", write, async (req, res) => {
    const [row] = await query("SELECT * FROM customer_statements WHERE id=$1", [req.params.id]);
    if (!row) return err(res, "Not found", 404);
    if (row.status !== "draft") return err(res, "Only a draft statement can be voided — a confirmed statement isn't reversible yet", 409);
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    await query("UPDATE customer_statements SET status='voided', voided_at=$1, voided_by=$2 WHERE id=$3", [now, actor, row.id]);
    await logEntityEvent('customer_statement', row.id, 'VOIDED', null, null, null, JSON.stringify({ customerId: row.customer_id }));
    const [updated] = await query("SELECT * FROM customer_statements WHERE id=$1", [row.id]);
    ok(res, await withLines(updated));
  });
};
