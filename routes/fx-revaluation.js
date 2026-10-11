"use strict";

// FX Revaluation report — Reports tab (finance-only, like Scheduled Reports; a trade_manager's
// own lane-scoped view has no natural meaning for a company-wide FX exposure figure, unlike GP
// by Trade Area/Billing Performance/Invoice Collections, which they do get on their own lane).
//
// Unrealized: every confirmed, unpaid, non-USD invoice — its booked USD value (frozen at
// generation, via the same costLineEffectiveUsd rule every other GP/margin figure uses) vs. the
// same foreign amount converted at TODAY's live rate (toUsd, the existing FX cache). Realized:
// every paid invoice where Mark as Paid captured what was actually received in the invoice's own
// currency (paid_amount_original/paid_currency/paid_exchange_rate — see the routes/shipment-
// ops.js mark-paid extension) — booked USD vs. what was actually received (paid_amount, which IS
// already the USD-equivalent of paid_amount_original * paid_exchange_rate by construction).
// Report only — no journal entries or ledger writes; GL Export is the separate feature for that.
//
// Confirmed consolidated statements are included exactly like invoices (TKT-02776W), each row
// tagged source: "invoice" | "statement". Values are GROSS (net + VAT on standard-rated lines):
// the customer owes and pays the VAT too, so comparing a gross payment against a net booking would
// report the VAT as an FX gain. (It used to be net; no line carried VAT before 2026-09-29.)
//
// A part-paid document is split (TKT-SQVGJ2 audit, 2026-10-09): the paid share is realized against
// its share of the booking, the unpaid share stays unrealized. It used to drop out of unrealized as
// soon as any payment was recorded, and realized compared the part paid with the WHOLE booking, so
// the unpaid rest showed up as an FX loss.

module.exports = function fxRevaluationRoutes(app, ctx) {
  const { query, ok, err, toUsd, costLineEffectiveUsd, vatFactor } = ctx;

  const financeGate = (req, res) => {
    const u = req.user;
    const roles = Array.isArray(u.roles) ? u.roles : [u.role || 'viewer'];
    if (roles.includes('admin') || u.canViewFinance) return true;
    err(res, "Finance access not enabled for your account", 403);
    return false;
  };

  async function docCostLines(doc) {
    const sourceIds = doc.source_cost_line_ids ? JSON.parse(doc.source_cost_line_ids) : [];
    if (!sourceIds.length) return [];
    return query(`SELECT * FROM shipment_cost_lines WHERE id IN (${sourceIds.map((_, i) => `$${i + 1}`).join(",")})`, sourceIds);
  }
  const statementCostLines = st => query(
    `SELECT scl.* FROM customer_statement_lines csl JOIN shipment_cost_lines scl ON scl.id = csl.cost_line_id WHERE csl.statement_id=$1`, [st.id]);

  const round2 = n => Math.round(n * 100) / 100;
  const grossFactor = vatFactor; // server.js — the same gross rule AR and credit exposure use
  const bookedUsdOf = lines => lines.reduce((s, l) => s + costLineEffectiveUsd(l) * grossFactor(l), 0);

  // A document's gross per currency: currency → { amount (in that currency), bookedUsd }.
  function byCurrencyOf(lines) {
    const byCurrency = new Map();
    for (const l of lines) {
      if (!byCurrency.has(l.currency)) byCurrency.set(l.currency, { amount: 0, bookedUsd: 0 });
      const g = byCurrency.get(l.currency);
      g.amount += l.amount * grossFactor(l);
      g.bookedUsd += costLineEffectiveUsd(l) * grossFactor(l);
    }
    return byCurrency;
  }
  // How much of a document is settled, 0–1, measured in its own currency when Mark as Paid captured
  // what was received in it. A payment recorded in USD only can't tell a part-payment from an FX
  // difference, so it still counts as settled, as before. 0 when nothing is paid.
  function settledShare(doc, byCurrency) {
    const paidGroup = doc.paid_currency && byCurrency.get(doc.paid_currency);
    if (doc.paid_amount_original != null && paidGroup && paidGroup.amount > 0) return Math.min(1, doc.paid_amount_original / paidGroup.amount);
    return doc.paid_at ? 1 : 0;
  }

  // One unrealized row per currency on the document (a rare mixed-currency invoice still gets a
  // correct row per currency rather than one computed against an arbitrary line's currency), for
  // the share not yet paid.
  async function unrealizedRows(ident, lines, doc) {
    const byCurrency = byCurrencyOf(lines);
    const open = 1 - settledShare(doc, byCurrency);
    if (open < 1e-6) return [];
    const out = [];
    for (const [currency, g] of byCurrency) {
      if (currency === "USD") continue; // no FX exposure
      const amount = g.amount * open, bookedUsd = g.bookedUsd * open;
      const todaysUsd = await toUsd(amount, currency);
      out.push({ ...ident, currency, foreignAmount: round2(amount), bookedUsd: round2(bookedUsd), todaysUsd: round2(todaysUsd),
        gainLossUsd: round2(todaysUsd - bookedUsd), ...(open < 1 ? { partlyPaid: true } : {}) });
    }
    return out;
  }
  // The paid share's booked USD vs what was received for it.
  function realizedRow(ident, lines, doc) {
    const share = settledShare(doc, byCurrencyOf(lines));
    const bookedUsd = bookedUsdOf(lines) * share;
    return {
      ...ident, currency: doc.paid_currency,
      paidAmountOriginal: doc.paid_amount_original, paidExchangeRate: doc.paid_exchange_rate,
      bookedUsd: round2(bookedUsd), receivedUsd: round2(doc.paid_amount),
      gainLossUsd: round2(doc.paid_amount - bookedUsd), ...(share < 1 ? { partlyPaid: true } : {}),
    };
  }

  app.get("/api/fx-revaluation/summary", async (req, res) => {
    if (!financeGate(req, res)) return;

    // A doc's own lines are grouped by currency rather than assumed single-currency — a rare
    // mixed-currency invoice still contributes a correct row per currency instead of either
    // crashing or silently computing garbage against one arbitrary line's currency.
    // Every confirmed document, paid or not — unrealizedRows keeps whatever share is still open.
    const confirmedDocs = await query(
      "SELECT * FROM shipment_documents WHERE doc_type IN ('FR01','FR02') AND status='confirmed'");
    const unrealized = [];
    for (const doc of confirmedDocs) {
      const lines = await docCostLines(doc);
      if (!lines.length) continue;
      unrealized.push(...await unrealizedRows({ source: "invoice", docId: doc.id, shipmentId: doc.shipment_id, filename: doc.filename }, lines, doc));
    }
    const confirmedStatements = await query("SELECT * FROM customer_statements WHERE status='confirmed'");
    for (const st of confirmedStatements) {
      const lines = await statementCostLines(st);
      if (!lines.length) continue;
      unrealized.push(...await unrealizedRows({ source: "statement", docId: st.id, shipmentId: "", filename: st.filename || st.id }, lines, st));
    }

    const paidDocs = await query(
      "SELECT * FROM shipment_documents WHERE doc_type IN ('FR01','FR02') AND status='confirmed' AND paid_amount_original IS NOT NULL");
    const realized = [];
    for (const doc of paidDocs) {
      const lines = await docCostLines(doc);
      // Same guard as the unrealized loop above — a doc whose source cost lines can no longer
      // be resolved (e.g. the shipment was since deleted; shipment_documents has no cascade
      // relationship with shipments) would otherwise compute bookedUsd as 0 and report its
      // entire received amount as a fabricated "gain," a real bug this feature's own live
      // verification caught.
      if (!lines.length) continue;
      realized.push(realizedRow({ source: "invoice", docId: doc.id, shipmentId: doc.shipment_id, filename: doc.filename }, lines, doc));
    }
    const paidStatements = await query("SELECT * FROM customer_statements WHERE status='confirmed' AND paid_amount_original IS NOT NULL");
    for (const st of paidStatements) {
      const lines = await statementCostLines(st);
      if (!lines.length) continue; // same skip as invoices: no lines left means no booked value to compare
      realized.push(realizedRow({ source: "statement", docId: st.id, shipmentId: "", filename: st.filename || st.id }, lines, st));
    }

    ok(res, {
      unrealized, realized,
      totals: {
        unrealizedUsd: round2(unrealized.reduce((s, r) => s + r.gainLossUsd, 0)),
        realizedUsd: round2(realized.reduce((s, r) => s + r.gainLossUsd, 0)),
      },
    });
  });
};
