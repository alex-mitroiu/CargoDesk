"use strict";

// GL Export — turns a date range of confirmed SELL invoices/credit-debit-notes and posted BUY
// cost lines into a generic journal-entry CSV, driven by an admin-maintained Charge Code + Type
// -> GL Account mapping (gl_account_mappings, routes/gl-account-mappings.js) plus 5 standing
// control accounts (AR / AP / Unmapped / Output VAT / Input VAT, held in app_settings — see
// server.js's SETTING_DEFAULTS).
//
// A confirmed consolidated statement posts exactly like an invoice (TKT-02776W, statementRows).
//
// VAT (TKT-AEPGWA): revenue and cost stay at the net amount; a standard-rated line's VAT posts to
// the Output VAT (sales) or Input VAT (purchases) control account, and AR / AP carry the gross.
// A reverse-charged purchase is self-assessed at the buying entity's standard rate — the same VAT
// debited to Input VAT and credited to Output VAT, net zero. Zero-rated, exempt and reverse-charged
// sales post no VAT. The figures use the same formula as the VAT Liability report (net USD × the
// line's rate), so the GL's VAT accounts and that report always agree for the same period.
//
// SELL and BUY are recognized on different triggers, matching how this codebase already treats
// them asymmetrically: SELL has no per-line "posted" concept that maps naturally to revenue
// recognition — a generated, CONFIRMED invoice (FR01/FR02) or credit/debit note (CN01) is the
// real "this was billed" moment, so that's the SELL trigger (confirmed_at). BUY cost lines have
// no wrapping document at all — POSTED is the real "this cost is final" moment, so that's the
// BUY trigger (posted_at). Every row this run exports is stamped with the same batch id so a
// re-run of the same date range never double-exports it — claimed atomically, see runGlExport.

const { ISSUED_BILLING_DOC_SQL } = require("./mappers");

const AR_KEY = "gl_control_account_ar";
const AP_KEY = "gl_control_account_ap";
const UNMAPPED_KEY = "gl_control_account_unmapped";
const VAT_OUTPUT_KEY = "gl_control_account_vat_output";
const VAT_INPUT_KEY = "gl_control_account_vat_input";

const cents = n => Math.round(n * 100) / 100;
// A line's own VAT rate: its vat_rate when standard-rated, 0 for zero-rated / reverse charge / exempt.
const standardRate = l => ((l.vat_treatment || "standard") === "standard" ? Number(l.vat_rate) || 0 : 0);

module.exports = function createGlExport({ query, transaction, uid, costLineEffectiveUsd, getSettings, entityByShipment }) {
  async function resolveMappings() {
    const rows = await query("SELECT * FROM gl_account_mappings");
    const byKey = new Map(rows.map(r => [`${r.type}:${r.charge_code}`, r]));
    const settings = await getSettings();
    return {
      lookup: (type, chargeCode) => byKey.get(`${type}:${chargeCode}`) || null,
      arAccount: settings[AR_KEY] || "",
      apAccount: settings[AP_KEY] || "",
      unmappedAccount: settings[UNMAPPED_KEY] || "UNMAPPED",
      vatOutputAccount: settings[VAT_OUTPUT_KEY] || "",
      vatInputAccount: settings[VAT_INPUT_KEY] || "",
    };
  }
  const vatRow = (mappings, side, { date, reference, memo, debit = 0, credit = 0 }) => {
    const account = side === "output" ? mappings.vatOutputAccount : mappings.vatInputAccount;
    return { date, reference, memo, accountCode: account,
      accountName: account ? "" : (side === "output" ? "Output VAT (unset)" : "Input VAT (unset)"),
      debit, credit, currency: "USD" };
  };

  // One row per (document, charge_code) revenue credit at net, one Output VAT credit, and one AR
  // debit for the document's gross total — the standard "one debit to the control account, N
  // credits" invoice-posting shape. Shared by invoices/credit notes and consolidated statements so
  // the two post identically. AR is the sum of the rounded credits, so the entry always balances.
  function revenueRows({ id, date, label }, lines, mappings) {
    const byCode = new Map();
    let vat = 0;
    for (const l of lines) {
      const net = costLineEffectiveUsd(l);
      byCode.set(l.charge_code, (byCode.get(l.charge_code) || 0) + net);
      vat += net * standardRate(l) / 100;
    }
    const rows = [];
    for (const [chargeCode, usd] of byCode) {
      const mapping = mappings.lookup("SELL", chargeCode);
      rows.push({
        date, reference: id, memo: `${chargeCode} — ${label}`,
        accountCode: mapping?.gl_account_code || mappings.unmappedAccount,
        accountName: mapping?.gl_account_name || (mapping ? "" : "Unmapped / Suspense"),
        debit: 0, credit: cents(usd), currency: "USD",
      });
    }
    if (cents(vat) !== 0) rows.push(vatRow(mappings, "output", { date, reference: id, memo: `Output VAT — ${label}`, credit: cents(vat) }));
    rows.push({
      date, reference: id, memo: `AR — ${label}`,
      accountCode: mappings.arAccount, accountName: mappings.arAccount ? "" : "Accounts Receivable (unset)",
      debit: cents(rows.reduce((s, r) => s + r.credit, 0)), credit: 0, currency: "USD",
    });
    return rows;
  }

  async function sellRows(dateFrom, dateTo, mappings) {
    const docs = await query(
      `SELECT * FROM shipment_documents
       WHERE ${ISSUED_BILLING_DOC_SQL} AND gl_exported_at IS NULL
         AND confirmed_at >= $1 AND confirmed_at <= $2`,
      [dateFrom, `${dateTo}T23:59:59.999Z`]);
    const groups = [];
    for (const doc of docs) {
      const sourceIds = doc.source_cost_line_ids ? JSON.parse(doc.source_cost_line_ids) : [];
      if (!sourceIds.length) continue; // nothing to post — a legacy doc with no snapshot, skip rather than guess
      const lines = await query(
        `SELECT * FROM shipment_cost_lines WHERE id IN (${sourceIds.map((_, i) => `$${i + 1}`).join(",")})`,
        sourceIds);
      if (!lines.length) continue;
      groups.push({ id: doc.id, rows: revenueRows({ id: doc.id, date: doc.confirmed_at.slice(0, 10), label: doc.filename }, lines, mappings) });
    }
    return groups;
  }

  // A confirmed consolidated statement is an issued billing document too (TKT-02776W), recognized
  // on its confirmed_at like an invoice. Its revenue is read from the cost lines it bills, the same
  // way an invoice's is, and it is stamped as exported on customer_statements. A statement whose
  // cost lines are all gone (its shipments deleted) is skipped rather than posted as zero.
  async function statementRows(dateFrom, dateTo, mappings) {
    const statements = await query(
      `SELECT * FROM customer_statements
       WHERE status='confirmed' AND gl_exported_at IS NULL AND confirmed_at >= $1 AND confirmed_at <= $2`,
      [dateFrom, `${dateTo}T23:59:59.999Z`]);
    const groups = [];
    for (const st of statements) {
      const lines = await query(
        `SELECT scl.* FROM customer_statement_lines csl JOIN shipment_cost_lines scl ON scl.id = csl.cost_line_id
         WHERE csl.statement_id=$1 ORDER BY csl.sort_order`, [st.id]);
      if (!lines.length) continue;
      groups.push({ id: st.id, rows: revenueRows({ id: st.id, date: st.confirmed_at.slice(0, 10), label: st.filename || st.id }, lines, mappings) });
    }
    return groups;
  }

  async function buyRows(dateFrom, dateTo, mappings) {
    const lines = await query(
      `SELECT * FROM shipment_cost_lines
       WHERE type='BUY' AND status='posted' AND gl_exported_at IS NULL
         AND posted_at >= $1 AND posted_at <= $2`,
      [dateFrom, `${dateTo}T23:59:59.999Z`]);
    // The buying entity's standard rate, for self-assessing reverse-charged purchases (TKT-MQAXQX).
    const reverseCharged = lines.filter(l => l.vat_treatment === "reverse_charge");
    const entities = reverseCharged.length && entityByShipment ? await entityByShipment(reverseCharged.map(l => l.shipment_id)) : new Map();
    return lines.map(l => {
      const date = l.posted_at.slice(0, 10), reference = l.shipment_id;
      const net = cents(costLineEffectiveUsd(l));
      const vat = cents(costLineEffectiveUsd(l) * standardRate(l) / 100);
      const mapping = mappings.lookup("BUY", l.charge_code);
      const rows = [{
        date, reference, memo: `${l.charge_code} — ${l.id}`,
        accountCode: mapping?.gl_account_code || mappings.unmappedAccount,
        accountName: mapping?.gl_account_name || (mapping ? "" : "Unmapped / Suspense"),
        debit: net, credit: 0, currency: "USD",
      }];
      if (vat !== 0) rows.push(vatRow(mappings, "input", { date, reference, memo: `Input VAT — ${l.id}`, debit: vat }));
      rows.push({
        date, reference, memo: `AP — ${l.id}`,
        accountCode: mappings.apAccount, accountName: mappings.apAccount ? "" : "Accounts Payable (unset)",
        debit: 0, credit: cents(net + vat), currency: "USD",
      });
      const rate = l.vat_treatment === "reverse_charge" ? entities.get(l.shipment_id)?.standardVatRate : null;
      const selfAssessed = rate != null ? cents(costLineEffectiveUsd(l) * rate / 100) : 0;
      if (selfAssessed !== 0) {
        rows.push(vatRow(mappings, "input", { date, reference, memo: `Input VAT (self-assessed) — ${l.id}`, debit: selfAssessed }));
        rows.push(vatRow(mappings, "output", { date, reference, memo: `Output VAT (self-assessed) — ${l.id}`, credit: selfAssessed }));
      }
      return { id: l.id, rows };
    });
  }

  function toCsv(rows) {
    const header = ["Date", "Account Code", "Account Name", "Debit", "Credit", "Currency", "Memo", "Reference"];
    const esc = v => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push([r.date, r.accountCode, r.accountName, r.debit || "", r.credit || "", r.currency, r.memo, r.reference].map(esc).join(","));
    }
    return lines.join("\r\n");
  }

  // Claims its rows atomically (TKT-OBCQH7): the candidate rows are built first, then stamped
  // with a conditional UPDATE … WHERE gl_exported_at IS NULL RETURNING id, and only what that
  // UPDATE actually returned is exported. It used to select, then stamp, then record the batch as
  // separate statements — two runs started together (two users, a double-click) could both select
  // the same rows and both put them in their CSV, i.e. duplicate journal entries downstream. On
  // Postgres the second run's UPDATE waits for the first to commit and then finds the rows already
  // stamped. The stamping and the batch row commit together, so a crash can no longer leave rows
  // stamped with a batch id that has no gl_export_batches row. A document with nothing to post (a
  // legacy one with no line snapshot) is left unclaimed, as before.
  async function runGlExport({ dateFrom, dateTo, user }) {
    const mappings = await resolveMappings();
    const sellGroups = await sellRows(dateFrom, dateTo, mappings);
    const statementGroups = await statementRows(dateFrom, dateTo, mappings);
    const buyGroups = await buyRows(dateFrom, dateTo, mappings);

    const batchId = `GLB-${uid()}`;
    const now = new Date().toISOString();
    const claim = async (tx, table, ids) => {
      if (!ids.length) return new Set();
      const rows = await tx.query(
        `UPDATE ${table} SET gl_exported_at=$1, gl_export_batch_id=$2
         WHERE gl_exported_at IS NULL AND id IN (${ids.map((_, i) => `$${i + 3}`).join(",")}) RETURNING id`,
        [now, batchId, ...ids]);
      return new Set(rows.map(r => r.id));
    };

    return transaction(async tx => {
      const docIds = await claim(tx, "shipment_documents", sellGroups.map(g => g.id));
      const statementIds = await claim(tx, "customer_statements", statementGroups.map(g => g.id));
      const lineIds = await claim(tx, "shipment_cost_lines", buyGroups.map(g => g.id));
      const rows = [
        ...sellGroups.filter(g => docIds.has(g.id)).flatMap(g => g.rows),
        ...statementGroups.filter(g => statementIds.has(g.id)).flatMap(g => g.rows),
        ...buyGroups.filter(g => lineIds.has(g.id)).flatMap(g => g.rows),
      ];
      const totalDebit = rows.reduce((s, r) => s + (r.debit || 0), 0);
      const totalCredit = rows.reduce((s, r) => s + (r.credit || 0), 0);
      const unmappedCount = rows.filter(r => r.accountCode === mappings.unmappedAccount).length;
      await tx.query(
        `INSERT INTO gl_export_batches (id, date_from, date_to, row_count, total_debit, total_credit, unmapped_count, created_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [batchId, dateFrom, dateTo, rows.length, Math.round(totalDebit * 100) / 100, Math.round(totalCredit * 100) / 100,
         unmappedCount, now, user || ""]);
      return { batchId, rows, csv: toCsv(rows), unmappedCount, totalDebit, totalCredit };
    });
  }

  return { runGlExport, toCsv };
};
