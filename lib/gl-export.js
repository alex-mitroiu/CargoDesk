"use strict";

// GL Export — turns a date range of confirmed SELL invoices/credit-debit-notes and posted BUY
// cost lines into a generic journal-entry CSV, driven by an admin-maintained Charge Code + Type
// -> GL Account mapping (gl_account_mappings, routes/gl-account-mappings.js) plus 3 standing
// control accounts (AR/AP/Unmapped, held in app_settings — see server.js's SETTING_DEFAULTS).
//
// SELL and BUY are recognized on different triggers, matching how this codebase already treats
// them asymmetrically: SELL has no per-line "posted" concept that maps naturally to revenue
// recognition — a generated, CONFIRMED invoice (FR01/FR02) or credit/debit note (CN01) is the
// real "this was billed" moment, so that's the SELL trigger (confirmed_at). BUY cost lines have
// no wrapping document at all — POSTED is the real "this cost is final" moment, so that's the
// BUY trigger (posted_at). Every row this run touches gets INSERT-marked with the same batch id
// so a re-run of the same date range never double-exports it.

const AR_KEY = "gl_control_account_ar";
const AP_KEY = "gl_control_account_ap";
const UNMAPPED_KEY = "gl_control_account_unmapped";

module.exports = function createGlExport({ query, uid, costLineEffectiveUsd, getSettings }) {
  async function resolveMappings() {
    const rows = await query("SELECT * FROM gl_account_mappings");
    const byKey = new Map(rows.map(r => [`${r.type}:${r.charge_code}`, r]));
    const settings = await getSettings();
    return {
      lookup: (type, chargeCode) => byKey.get(`${type}:${chargeCode}`) || null,
      arAccount: settings[AR_KEY] || "",
      apAccount: settings[AP_KEY] || "",
      unmappedAccount: settings[UNMAPPED_KEY] || "UNMAPPED",
    };
  }

  // One row per (doc, charge_code) revenue credit, plus one AR debit for the doc's own total —
  // the standard "one debit to the control account, N credits to revenue" invoice-posting shape.
  async function sellRows(dateFrom, dateTo, mappings) {
    const docs = await query(
      `SELECT * FROM shipment_documents
       WHERE doc_type IN ('FR01','FR02','CN01') AND status='confirmed' AND gl_exported_at IS NULL
         AND confirmed_at >= $1 AND confirmed_at <= $2`,
      [dateFrom, `${dateTo}T23:59:59.999Z`]);
    const rows = [];
    const exportedDocIds = [];
    for (const doc of docs) {
      const sourceIds = doc.source_cost_line_ids ? JSON.parse(doc.source_cost_line_ids) : [];
      if (!sourceIds.length) continue; // nothing to post — a legacy doc with no snapshot, skip rather than guess
      const lines = await query(
        `SELECT * FROM shipment_cost_lines WHERE id IN (${sourceIds.map((_, i) => `$${i + 1}`).join(",")})`,
        sourceIds);
      if (!lines.length) continue;
      const byCode = new Map();
      for (const l of lines) {
        const usd = costLineEffectiveUsd(l);
        byCode.set(l.charge_code, (byCode.get(l.charge_code) || 0) + usd);
      }
      let docTotal = 0;
      for (const [chargeCode, usd] of byCode) {
        const mapping = mappings.lookup("SELL", chargeCode);
        docTotal += usd;
        rows.push({
          date: doc.confirmed_at.slice(0, 10), reference: doc.id, memo: `${chargeCode} — ${doc.filename}`,
          accountCode: mapping?.gl_account_code || mappings.unmappedAccount,
          accountName: mapping?.gl_account_name || (mapping ? "" : "Unmapped / Suspense"),
          debit: 0, credit: Math.round(usd * 100) / 100, currency: "USD",
        });
      }
      rows.push({
        date: doc.confirmed_at.slice(0, 10), reference: doc.id, memo: `AR — ${doc.filename}`,
        accountCode: mappings.arAccount, accountName: mappings.arAccount ? "" : "Accounts Receivable (unset)",
        debit: Math.round(docTotal * 100) / 100, credit: 0, currency: "USD",
      });
      exportedDocIds.push(doc.id);
    }
    return { rows, exportedDocIds };
  }

  async function buyRows(dateFrom, dateTo, mappings) {
    const lines = await query(
      `SELECT * FROM shipment_cost_lines
       WHERE type='BUY' AND status='posted' AND gl_exported_at IS NULL
         AND posted_at >= $1 AND posted_at <= $2`,
      [dateFrom, `${dateTo}T23:59:59.999Z`]);
    const rows = [];
    for (const l of lines) {
      const usd = Math.round(costLineEffectiveUsd(l) * 100) / 100;
      const mapping = mappings.lookup("BUY", l.charge_code);
      rows.push({
        date: l.posted_at.slice(0, 10), reference: l.shipment_id, memo: `${l.charge_code} — ${l.id}`,
        accountCode: mapping?.gl_account_code || mappings.unmappedAccount,
        accountName: mapping?.gl_account_name || (mapping ? "" : "Unmapped / Suspense"),
        debit: usd, credit: 0, currency: "USD",
      });
      rows.push({
        date: l.posted_at.slice(0, 10), reference: l.shipment_id, memo: `AP — ${l.id}`,
        accountCode: mappings.apAccount, accountName: mappings.apAccount ? "" : "Accounts Payable (unset)",
        debit: 0, credit: usd, currency: "USD",
      });
    }
    return { rows, exportedLineIds: lines.map(l => l.id) };
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

  async function runGlExport({ dateFrom, dateTo, user }) {
    const mappings = await resolveMappings();
    const { rows: sell, exportedDocIds } = await sellRows(dateFrom, dateTo, mappings);
    const { rows: buy, exportedLineIds } = await buyRows(dateFrom, dateTo, mappings);
    const rows = [...sell, ...buy];

    const batchId = `GLB-${uid()}`;
    const now = new Date().toISOString();
    const totalDebit = rows.reduce((s, r) => s + (r.debit || 0), 0);
    const totalCredit = rows.reduce((s, r) => s + (r.credit || 0), 0);
    const unmappedCount = rows.filter(r => r.accountCode === mappings.unmappedAccount).length;

    if (rows.length) {
      if (exportedDocIds.length) {
        const ph = exportedDocIds.map((_, i) => `$${i + 3}`).join(",");
        await query(`UPDATE shipment_documents SET gl_exported_at=$1, gl_export_batch_id=$2 WHERE id IN (${ph})`,
          [now, batchId, ...exportedDocIds]);
      }
      if (exportedLineIds.length) {
        const ph = exportedLineIds.map((_, i) => `$${i + 3}`).join(",");
        await query(`UPDATE shipment_cost_lines SET gl_exported_at=$1, gl_export_batch_id=$2 WHERE id IN (${ph})`,
          [now, batchId, ...exportedLineIds]);
      }
    }
    await query(
      `INSERT INTO gl_export_batches (id, date_from, date_to, row_count, total_debit, total_credit, unmapped_count, created_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [batchId, dateFrom, dateTo, rows.length, Math.round(totalDebit * 100) / 100, Math.round(totalCredit * 100) / 100,
       unmappedCount, now, user || ""]);

    return { batchId, rows, csv: toCsv(rows), unmappedCount, totalDebit, totalCredit };
  }

  return { runGlExport, toCsv };
};
