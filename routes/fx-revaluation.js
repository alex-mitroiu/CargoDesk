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

module.exports = function fxRevaluationRoutes(app, ctx) {
  const { query, ok, err, toUsd, costLineEffectiveUsd } = ctx;

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

  const round2 = n => Math.round(n * 100) / 100;

  app.get("/api/fx-revaluation/summary", async (req, res) => {
    if (!financeGate(req, res)) return;

    // A doc's own lines are grouped by currency rather than assumed single-currency — a rare
    // mixed-currency invoice still contributes a correct row per currency instead of either
    // crashing or silently computing garbage against one arbitrary line's currency.
    const unpaidDocs = await query(
      "SELECT * FROM shipment_documents WHERE doc_type IN ('FR01','FR02') AND status='confirmed' AND paid_at IS NULL");
    const unrealized = [];
    for (const doc of unpaidDocs) {
      const lines = await docCostLines(doc);
      if (!lines.length) continue;
      const byCurrency = new Map();
      for (const l of lines) {
        if (!byCurrency.has(l.currency)) byCurrency.set(l.currency, { amount: 0, bookedUsd: 0 });
        const g = byCurrency.get(l.currency);
        g.amount += l.amount;
        g.bookedUsd += costLineEffectiveUsd(l);
      }
      for (const [currency, g] of byCurrency) {
        if (currency === "USD") continue; // no FX exposure
        const todaysUsd = await toUsd(g.amount, currency);
        unrealized.push({
          docId: doc.id, shipmentId: doc.shipment_id, filename: doc.filename, currency,
          foreignAmount: round2(g.amount), bookedUsd: round2(g.bookedUsd), todaysUsd: round2(todaysUsd),
          gainLossUsd: round2(todaysUsd - g.bookedUsd),
        });
      }
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
      const bookedUsd = lines.reduce((s, l) => s + costLineEffectiveUsd(l), 0);
      realized.push({
        docId: doc.id, shipmentId: doc.shipment_id, filename: doc.filename, currency: doc.paid_currency,
        paidAmountOriginal: doc.paid_amount_original, paidExchangeRate: doc.paid_exchange_rate,
        bookedUsd: round2(bookedUsd), receivedUsd: round2(doc.paid_amount),
        gainLossUsd: round2(doc.paid_amount - bookedUsd),
      });
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
