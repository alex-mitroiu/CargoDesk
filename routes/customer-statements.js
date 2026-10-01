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
    query, transaction, ok, err, uid, requireRole,
    mapCustomerStatement, mapCustomerStatementLine, mapShipment,
    applyShipmentAccessFilter, deriveEffectiveRole, billingHolds, describeHolds, entityByShipment,
    getCustomerRow, computeArExposure, toUsd,
    renderHtmlToPdf, getActiveSigningCert, signPdfBuffer,
    logEntityEvent, UPLOADS_DIR, fs, path,
  } = ctx;
  const write = requireRole(["admin", "operator"]);
  const ph = (n, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(",");

  const withLines = async statement => {
    const lines = await query("SELECT * FROM customer_statement_lines WHERE statement_id=$1 ORDER BY sort_order", [statement.id]);
    return { ...mapCustomerStatement(statement), lines: lines.map(mapCustomerStatementLine) };
  };

  // Scope (TKT-6T97DY, decided 2026-09-30): a statement is visible only when the caller can see
  // EVERY shipment on it — one that also covers another office's shipments would show their lines
  // and amounts. Same office / trade-lane / POL / country rules GET /api/shipments applies
  // (applyShipmentAccessFilter); admin and operator see everything. Deliberately no finance-access
  // gate on top: the Statements page stays open to every role (src/utils/financialsNav.js).
  const unrestricted = req => ["admin", "operator"].includes(deriveEffectiveRole(req.user, req));
  const visibleShipmentIds = async (req, shipmentIds) => {
    const ids = [...new Set(shipmentIds.filter(Boolean))];
    if (!ids.length) return new Set();
    const rows = await query(`SELECT * FROM shipments WHERE id IN (${ph(ids.length)})`, ids);
    return new Set((await applyShipmentAccessFilter(rows.map(mapShipment), req.user, req)).map(s => s.id));
  };
  // A line whose shipment has since been deleted counts as out of scope for a restricted caller —
  // nothing says which office it belonged to.
  const visibleStatementIds = async (req, rows) => {
    const ids = rows.map(r => r.id);
    if (unrestricted(req) || !ids.length) return new Set(ids);
    const lines = await query(`SELECT statement_id, shipment_id FROM customer_statement_lines WHERE statement_id IN (${ph(ids.length)})`, ids);
    const visible = await visibleShipmentIds(req, lines.map(l => l.shipment_id));
    const hidden = new Set(lines.filter(l => !visible.has(l.shipment_id)).map(l => l.statement_id));
    return new Set(ids.filter(id => !hidden.has(id)));
  };
  // A charge's VAT as it goes onto a statement (TKT-1E55AR) — the line's own rate for a
  // standard-rated charge; a zero-rated, reverse-charged or exempt one carries 0% by construction.
  const lineVat = l => {
    const treatment = l.vat_treatment || "standard";
    const rate = treatment === "standard" ? (Number(l.vat_rate) || 0) : 0;
    return { treatment, rate, vat: Math.round((Number(l.amount) || 0) * rate) / 100 };
  };

  const loadVisibleStatement = async (req, id) => {
    const [row] = await query("SELECT * FROM customer_statements WHERE id=$1", [id]);
    return row && (await visibleStatementIds(req, [row])).has(row.id) ? row : null;
  };

  app.get("/api/customer-statements", async (req, res) => {
    const { customerId, status } = req.query;
    const clauses = [], params = [];
    if (customerId) { params.push(customerId); clauses.push(`customer_id=$${params.length}`); }
    if (status)     { params.push(status);     clauses.push(`status=$${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await query(`SELECT * FROM customer_statements ${where} ORDER BY created_at DESC`, params);
    const visible = await visibleStatementIds(req, rows);
    ok(res, rows.filter(r => visible.has(r.id)).map(mapCustomerStatement));
  });

  // Registered BEFORE the :id route below (same reason /api/shipments/compliance-hits sits
  // before /api/shipments/:id — a wildcard :id registered first would swallow "eligible-lines"
  // as if it were an id; a real bug caught by this feature's own test suite). Which of this
  // customer's SELL cost lines, in the date range, are actually billable into a NEW statement:
  // on a shipment the caller can see (TKT-6T97DY), and on no live billing document — no draft or
  // confirmed invoice/credit note and no statement that isn't voided (billingHolds, the same rule
  // invoice generation now applies, TKT-2F19XD). The operator can still deselect any of these
  // before Generate; this is the eligible SET, not a forced inclusion.
  app.get("/api/customer-statements/eligible-lines", async (req, res) => {
    const { customerId, dateFrom, dateTo } = req.query;
    if (!customerId || !dateFrom || !dateTo) return err(res, "customerId, dateFrom and dateTo are required");

    const shipmentRows = await query(
      "SELECT id FROM shipments WHERE principal_id=$1 OR consignee_id=$1", [customerId]);
    let shipmentIds = shipmentRows.map(r => r.id);
    if (!unrestricted(req)) {
      const visible = await visibleShipmentIds(req, shipmentIds);
      shipmentIds = shipmentIds.filter(id => visible.has(id));
    }
    if (!shipmentIds.length) return ok(res, req.query.withHeld === "1" ? { lines: [], held: [] } : []);

    const lines = await query(
      `SELECT * FROM shipment_cost_lines
       WHERE type='SELL' AND shipment_id IN (${ph(shipmentIds.length, 3)}) AND created_at >= $1 AND created_at <= $2
       ORDER BY created_at`,
      [dateFrom, `${dateTo}T23:59:59.999Z`, ...shipmentIds]);
    if (!lines.length) return ok(res, req.query.withHeld === "1" ? { lines: [], held: [] } : []);

    const holds = await billingHolds(lines.map(l => l.id));
    const eligible = lines.filter(l => !holds.has(l.id));
    // Each line's legal entity, so the page can offer one entity's charges at a time (a statement
    // is issued by one entity, TKT-1E55AR), and the VAT that will go onto the statement.
    const entities = await entityByShipment(lines.map(l => l.shipment_id));
    const eligibleOut = eligible.map(l => {
      const ent = entities.get(l.shipment_id) || {};
      const v = lineVat(l);
      return {
        id: l.id, shipmentId: l.shipment_id, chargeCode: l.charge_code, notes: l.notes || '',
        amount: l.amount, currency: l.currency, createdAt: l.created_at,
        vatRate: v.rate, vatTreatment: v.treatment, vatAmount: v.vat,
        entityId: ent.entityId || '', entityName: ent.entityName || '',
      };
    });
    if (req.query.withHeld !== "1") return ok(res, eligibleOut);
    // withHeld=1 (the Statements page): also the charges left out because another document already
    // bills them, so the page can say how many and where instead of silently offering fewer.
    const held = lines.filter(l => holds.has(l.id)).map(l => ({
      id: l.id, shipmentId: l.shipment_id, chargeCode: l.charge_code,
      entityId: (entities.get(l.shipment_id) || {}).entityId || '', billedOn: holds.get(l.id),
    }));
    ok(res, { lines: eligibleOut, held });
  });

  // Out of scope answers 404, not 403 — same as a hidden shipment, so a caller can't probe ids.
  app.get("/api/customer-statements/:id", async (req, res) => {
    const row = await loadVisibleStatement(req, req.params.id);
    if (!row) return err(res, "Not found", 404);
    ok(res, await withLines(row));
  });

  // Mirrors GET /api/shipments/:shipmentId/documents/:docId/download exactly (same
  // inline-vs-attachment PDF convention) — statements have no shipment_id to nest this under.
  // A GET on a path ONE segment deeper than :id (:id/download) is never ambiguous with :id
  // itself, unlike eligible-lines above, so this one's position relative to :id doesn't matter.
  app.get("/api/customer-statements/:id/download", async (req, res) => {
    const row = await loadVisibleStatement(req, req.params.id);
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
      `SELECT * FROM shipment_cost_lines WHERE type='SELL' AND id IN (${ph(costLineIds.length)})`,
      costLineIds);
    if (!lines.length) return err(res, "None of the selected charge lines were found");
    // The line list comes from the client, so re-check what eligible-lines promised: every line is
    // on one of THIS customer's shipments, and none is already billed elsewhere (TKT-2F19XD).
    const lineShipmentIds = [...new Set(lines.map(l => l.shipment_id))];
    const own = new Set((await query(
      `SELECT id FROM shipments WHERE (principal_id=$1 OR consignee_id=$1) AND id IN (${ph(lineShipmentIds.length, 2)})`,
      [customerId, ...lineShipmentIds])).map(r => r.id));
    const foreign = lines.filter(l => !own.has(l.shipment_id));
    if (foreign.length)
      return err(res, `${foreign.map(l => `${l.charge_code} (${l.shipment_id})`).join(", ")} ${foreign.length === 1 ? "is" : "are"} not on ${customer.companyName}'s shipments`);
    const early = await billingHolds(lines.map(l => l.id));
    if (early.size) return err(res, `Cannot generate this statement — ${describeHolds(early, lines)}`, 409);
    // One legal entity per statement (decided 2026-09-30): a VAT invoice has exactly one supplier.
    const entities = await entityByShipment(lineShipmentIds);
    const entityOf = l => entities.get(l.shipment_id) || { entityId: null, entityName: "" };
    const entityIds = new Set(lines.map(l => entityOf(l).entityId || ""));
    if (entityIds.size > 1) {
      const names = [...new Set(lines.map(l => entityOf(l).entityName || "no legal entity"))];
      return err(res, `A statement is issued by one legal entity — these charges belong to ${names.join(" and ")}. Generate one statement per entity.`);
    }
    const entity = entityOf(lines[0]);
    const currencies = new Set(lines.map(l => l.currency));
    if (currencies.size > 1) return err(res, "All selected charge lines must share one currency for a single statement");
    const currency = [...currencies][0];
    const totalAmount = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const vatAmount = Math.round(lines.reduce((s, l) => s + lineVat(l).vat, 0) * 100) / 100;
    const grossAmount = Math.round((totalAmount + vatAmount) * 100) / 100;

    let storedName = null, committed = false;
    try {
      const cert = await getActiveSigningCert(query);
      const rawPdf = await renderHtmlToPdf(html);
      const signedPdf = await signPdfBuffer(Buffer.from(rawPdf), cert);
      const pdfFilename = `${path.parse(filename).name}.pdf`;
      storedName = `${Date.now()}_${uid()}.pdf`;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), signedPdf);

      const id = `STMT-${uid()}`;
      const now = new Date().toISOString();
      const actor = req.user?.name || req.user?.email || "";
      // Rendering above waits on the network, so another request may have billed these lines
      // meanwhile. Lock the shipments, check again and insert in one transaction — a concurrent
      // statement or invoice for the same shipments waits here and then sees these lines as held.
      await transaction(async tx => {
        await tx.query(`SELECT id FROM shipments WHERE id IN (${ph(lineShipmentIds.length)}) ORDER BY id FOR UPDATE`, lineShipmentIds);
        const holds = await billingHolds(lines.map(l => l.id));
        if (holds.size) throw Object.assign(new Error(`Cannot generate this statement — ${describeHolds(holds, lines)}`), { status: 409 });
        await tx.query(
          `INSERT INTO customer_statements
           (id, customer_id, customer_name, date_from, date_to, currency, status, total_amount, filename, stored_name, size_bytes, created_at, created_by,
            entity_id, entity_name, vat_amount, gross_amount)
           VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id, customerId, customer.companyName || "", dateFrom, dateTo, currency, totalAmount, pdfFilename, storedName, signedPdf.length, now, actor,
           entity.entityId || "", entity.entityName || "", vatAmount, grossAmount]);
        let sortOrder = 0;
        for (const l of lines) {
          const v = lineVat(l);
          await tx.query(
            `INSERT INTO customer_statement_lines (id, statement_id, shipment_id, cost_line_id, charge_code, description, amount, currency, sort_order,
              vat_rate, vat_treatment, vat_amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [`CSL-${uid()}`, id, l.shipment_id, l.id, l.charge_code, l.notes || "", l.amount, l.currency, sortOrder++, v.rate, v.treatment, v.vat]);
        }
      });
      committed = true;
      await logEntityEvent('customer_statement', id, 'GENERATED', null, null, null,
        JSON.stringify({ customerId, dateFrom, dateTo, lineCount: lines.length, totalAmount, vatAmount, grossAmount, currency, entityId: entity.entityId || "" }));

      const [row] = await query("SELECT * FROM customer_statements WHERE id=$1", [id]);
      ok(res, await withLines(row), 201);
    } catch (e) {
      // No statement row points at the PDF if the transaction didn't commit — don't leave it on disk.
      if (storedName && !committed) try { fs.unlinkSync(path.join(UPLOADS_DIR, storedName)); } catch {}
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
    const { paidAt, paidAmount, paidAmountOriginal, paidCurrency, paidExchangeRate } = req.body || {};
    if (!paidAt) return err(res, "paidAt is required");
    if (paidAmount === undefined || paidAmount === null || paidAmount === "" || Number(paidAmount) <= 0)
      return err(res, "paidAmount must be a positive number");
    // What was actually received in the statement's own currency (TKT-02776W) — optional, same rules
    // as an invoice's Mark as Paid; FX Revaluation reads it for the realized gain/loss.
    const hasOriginal = paidAmountOriginal !== undefined && paidAmountOriginal !== null && paidAmountOriginal !== "";
    if (hasOriginal && (!paidCurrency || paidExchangeRate === undefined || paidExchangeRate === null || paidExchangeRate === "" || Number(paidExchangeRate) <= 0))
      return err(res, "paidCurrency and a positive paidExchangeRate are required when paidAmountOriginal is set");
    if (hasOriginal && !(Number(paidAmountOriginal) > 0)) return err(res, "paidAmountOriginal must be a positive number");
    await query("UPDATE customer_statements SET paid_at=$1, paid_amount=$2, paid_amount_original=$3, paid_currency=$4, paid_exchange_rate=$5 WHERE id=$6",
      [paidAt, Number(paidAmount), hasOriginal ? Number(paidAmountOriginal) : null, hasOriginal ? paidCurrency : null, hasOriginal ? Number(paidExchangeRate) : null, row.id]);
    await logEntityEvent('customer_statement', row.id, 'MARKED_PAID', null, null, null, JSON.stringify({ paidAt, paidAmount: Number(paidAmount),
      ...(hasOriginal && { paidAmountOriginal: Number(paidAmountOriginal), paidCurrency, paidExchangeRate: Number(paidExchangeRate) }) }));
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
