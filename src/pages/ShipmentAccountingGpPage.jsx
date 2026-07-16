import { useState, useEffect } from "react";
import { T } from "../tokens";
import { api } from "../api";

const fmtUsd = v => v == null ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ─── Shipment GP Overview Page ────────────────────────────────────────────
// Read-only derived aggregation of Cost Entry (BUY) + Invoice Entry (SELL)
// lines, broken down by charge code — same Buy/Sell/GP math CostControl's
// summary strip already computed, split out as its own page (TKT-6QT30S).
// NOTE: this is the "simple" version — Estimated vs Actual vs Variance by
// accrual state (accrued/actualized/posted) is deferred to a follow-up
// ticket since it needs a status column that doesn't exist yet.

const ShipmentAccountingGpPage = ({ shipment, onBack }) => {
  const [lines,   setLines]   = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.costLines.list(shipment.id)
      .then(setLines).catch(() => setLines([])).finally(() => setLoading(false));
  }, [shipment.id]);

  const buy      = lines.filter(l => l.type === "BUY").reduce((s, l) => s + l.amountUsd, 0);
  const sell     = lines.filter(l => l.type === "SELL").reduce((s, l) => s + l.amountUsd, 0);
  const vatTotal = lines.filter(l => l.type === "SELL").reduce((s, l) => s + (l.vatAmountUsd || 0), 0);
  const hasVat   = vatTotal > 0;
  const gp       = sell - buy;
  const pct      = sell > 0 ? Math.round((gp / sell) * 1000) / 10 : null;

  const byCharge = {};
  for (const l of lines) {
    const k = byCharge[l.chargeCode] || (byCharge[l.chargeCode] = { chargeCode: l.chargeCode, buy: 0, sell: 0 });
    k[l.type === "BUY" ? "buy" : "sell"] += l.amountUsd;
  }
  const rows = Object.values(byCharge)
    .map(r => ({ ...r, gp: r.sell - r.buy }))
    .sort((a, b) => a.chargeCode.localeCompare(b.chargeCode));

  const th = { fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".07em" };

  const statCard = (label, value, color) => (
    <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px", flex: 1 }}>
      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 800, color: color || T.text }}>{value}</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted, marginBottom: 14 }}>
        read-only
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 14, marginBottom: 22, flexWrap: "wrap" }}>
            {statCard("Total Buy", fmtUsd(buy), T.warning)}
            {statCard(hasVat ? "Sell (ex. VAT)" : "Total Sell", fmtUsd(sell), T.success)}
            {hasVat && statCard("Sell (incl. VAT)", fmtUsd(sell + vatTotal), T.success)}
            {statCard("Gross Profit", fmtUsd(gp), gp >= 0 ? T.success : T.danger)}
            {statCard("Margin %", pct != null ? `${pct}%` : "—", gp >= 0 ? T.success : T.danger)}
          </div>

          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
            textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
            By Charge Code
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", fontFamily: T.body,
              fontSize: 13, color: T.textMuted, fontStyle: "italic",
              background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
              No cost or invoice lines yet.
            </div>
          ) : (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface }}>
              <div style={{ display: "flex", alignItems: "center", padding: "7px 16px",
                borderBottom: `1px solid ${T.border}`, background: T.bg }}>
                <div style={{ ...th, flex: 1 }}>Charge Code</div>
                <div style={{ ...th, width: 120, textAlign: "right" }}>Buy (USD)</div>
                <div style={{ ...th, width: 120, textAlign: "right" }}>Sell (USD)</div>
                <div style={{ ...th, width: 120, textAlign: "right" }}>GP (USD)</div>
              </div>
              {rows.map(r => (
                <div key={r.chargeCode} style={{ display: "flex", alignItems: "center", padding: "9px 16px",
                  borderBottom: `1px solid ${T.border}22` }}>
                  <div style={{ flex: 1, fontFamily: T.body, fontSize: 13, color: T.text }}>{r.chargeCode}</div>
                  <div style={{ width: 120, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: T.warning }}>{fmtUsd(r.buy)}</div>
                  <div style={{ width: 120, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: T.success }}>{fmtUsd(r.sell)}</div>
                  <div style={{ width: 120, textAlign: "right", fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                    color: r.gp >= 0 ? T.success : T.danger }}>{fmtUsd(r.gp)}</div>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", padding: "9px 16px", background: T.bg }}>
                <div style={{ flex: 1, fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text }}>Total</div>
                <div style={{ width: 120, textAlign: "right", fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.warning }}>{fmtUsd(buy)}</div>
                <div style={{ width: 120, textAlign: "right", fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.success }}>{fmtUsd(sell)}</div>
                <div style={{ width: 120, textAlign: "right", fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                  color: gp >= 0 ? T.success : T.danger }}>{fmtUsd(gp)}</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ShipmentAccountingGpPage;
