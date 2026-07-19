import { useState, useEffect } from "react";
import { T } from "../tokens";
import { api } from "../api";

const fmtUsd = v => v == null ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtSigned = v => v == null ? "—" : `${v > 0 ? "+" : ""}${fmtUsd(v)}`;

// ─── Shipment GP Overview Page ────────────────────────────────────────────
// Read-only derived aggregation of Cost Entry (BUY) + Invoice Entry (SELL) lines.
// TKT-83O41G (TKT-6QT30S phase 2): Estimated GP (from every line's original accrued
// amount) vs Actual GP (actualized/posted lines use their actual amount; still-accrued
// lines fall back to their accrual as the best known value) vs Variance, split by
// charge code. "By office" is shown as shipment-level EMO/IMO context rather than a
// real per-line breakdown dimension — cost lines aren't tagged with an office_id, and
// the ticket didn't call for adding one, so this reports what's actually derivable.
const ShipmentAccountingGpPage = ({ shipment, onBack }) => {
  const [lines,   setLines]   = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    return api.costLines.list(shipment.id).then(setLines).catch(() => setLines([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [shipment.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const actualOf = l => l.actualAmountUsd ?? l.amountUsd;

  const buyLines  = lines.filter(l => l.type === "BUY");
  const sellLines = lines.filter(l => l.type === "SELL");
  const vatTotal  = sellLines.reduce((s, l) => s + (l.vatAmountUsd || 0), 0);
  const hasVat    = vatTotal > 0;

  const estBuy  = buyLines.reduce((s, l) => s + l.amountUsd, 0);
  const estSell = sellLines.reduce((s, l) => s + l.amountUsd, 0);
  const actBuy  = buyLines.reduce((s, l) => s + actualOf(l), 0);
  const actSell = sellLines.reduce((s, l) => s + actualOf(l), 0);
  const estGp   = estSell - estBuy;
  const actGp   = actSell - actBuy;
  const varGp   = actGp - estGp;
  const estPct  = estSell > 0 ? Math.round((estGp / estSell) * 1000) / 10 : null;
  const actPct  = actSell > 0 ? Math.round((actGp / actSell) * 1000) / 10 : null;

  const actualizedCount = lines.filter(l => l.status !== 'accrued').length;

  const byCharge = {};
  for (const l of lines) {
    const k = byCharge[l.chargeCode] || (byCharge[l.chargeCode] = { chargeCode: l.chargeCode,
      estBuy: 0, estSell: 0, actBuy: 0, actSell: 0 });
    if (l.type === "BUY")  { k.estBuy  += l.amountUsd; k.actBuy  += actualOf(l); }
    else                   { k.estSell += l.amountUsd; k.actSell += actualOf(l); }
  }
  const rows = Object.values(byCharge)
    .map(r => ({ ...r, estGp: r.estSell - r.estBuy, actGp: r.actSell - r.actBuy }))
    .map(r => ({ ...r, variance: r.actGp - r.estGp }))
    .sort((a, b) => a.chargeCode.localeCompare(b.chargeCode));

  // Carrier Payment Indicator breakdown (TKT-OZD4V8): Prepaid charges are collectable at
  // origin, Collect charges at destination — distinct from the estimated/actual accrual
  // split above, this is "who pays where" rather than "what did we quote vs actually pay".
  const byCpi = { Prepaid: { estBuy: 0, estSell: 0, actBuy: 0, actSell: 0 }, Collect: { estBuy: 0, estSell: 0, actBuy: 0, actSell: 0 } };
  for (const l of lines) {
    const k = byCpi[l.paymentIndicator === "Collect" ? "Collect" : "Prepaid"];
    if (l.type === "BUY")  { k.estBuy  += l.amountUsd; k.actBuy  += actualOf(l); }
    else                   { k.estSell += l.amountUsd; k.actSell += actualOf(l); }
  }
  const cpiRows = ["Prepaid", "Collect"].map(pi => ({ pi, ...byCpi[pi],
    estGp: byCpi[pi].estSell - byCpi[pi].estBuy, actGp: byCpi[pi].actSell - byCpi[pi].actBuy }));

  const th = { fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".07em" };

  const statCard = (id, label, value, color) => (
    <div id={id} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px", flex: 1, minWidth: 130 }}>
      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 800, color: color || T.text }}>{value}</div>
    </div>
  );

  return (
    <div id="shpacct-gp-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div id="shpacct-gp-context" style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted, marginBottom: 14 }}>
        read-only · EMO {shipment.emoOfficeName || "—"} · IMO {shipment.imoOfficeName || "—"}
        {actualizedCount > 0 && ` · ${actualizedCount} line${actualizedCount !== 1 ? "s" : ""} actualized/posted`}
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading…</div>
      ) : (
        <>
          <div style={{ ...th, marginBottom: 8 }}>Estimated (Accrued)</div>
          <div id="shpacct-gp-est-stats" style={{ display: "flex", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
            {statCard("shpacct-gp-est-buy",  "Est. Buy",  fmtUsd(estBuy),  T.warning)}
            {statCard("shpacct-gp-est-sell", "Est. Sell", fmtUsd(estSell), T.success)}
            {statCard("shpacct-gp-est-gp",   "Est. GP",   fmtUsd(estGp),   estGp >= 0 ? T.success : T.danger)}
            {statCard("shpacct-gp-est-pct",  "Est. Margin %", estPct != null ? `${estPct}%` : "—", estGp >= 0 ? T.success : T.danger)}
          </div>

          <div style={{ ...th, marginBottom: 8 }}>Actual (Actualized/Posted lines; still-accrued lines use their estimate)</div>
          <div id="shpacct-gp-act-stats" style={{ display: "flex", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
            {statCard("shpacct-gp-act-buy",  "Actual Buy",  fmtUsd(actBuy),  T.warning)}
            {statCard("shpacct-gp-act-sell", "Actual Sell", fmtUsd(actSell), T.success)}
            {statCard("shpacct-gp-act-gp",   "Actual GP",   fmtUsd(actGp),   actGp >= 0 ? T.success : T.danger)}
            {statCard("shpacct-gp-act-pct",  "Actual Margin %", actPct != null ? `${actPct}%` : "—", actGp >= 0 ? T.success : T.danger)}
            {hasVat && statCard("shpacct-gp-vat", "Sell VAT", fmtUsd(vatTotal), T.textMuted)}
          </div>

          <div id="shpacct-gp-variance-card" style={{ background: varGp === 0 ? T.bg : varGp > 0 ? T.success + "12" : T.danger + "12",
            border: `1px solid ${varGp === 0 ? T.border : varGp > 0 ? T.success + "44" : T.danger + "44"}`,
            borderRadius: 10, padding: "12px 18px", marginBottom: 22, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".07em" }}>GP Variance (Actual − Estimated)</span>
            <span style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 800,
              color: varGp === 0 ? T.textMuted : varGp > 0 ? T.success : T.danger }}>{fmtSigned(varGp)}</span>
          </div>

          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
            textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
            By Payment Indicator (CPI) — who pays where
          </div>
          {rows.length === 0 ? null : (
            <div id="shpacct-gp-cpi-table" style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface, overflowX: "auto", marginBottom: 22 }}>
              <div style={{ display: "flex", alignItems: "center", padding: "7px 16px",
                borderBottom: `1px solid ${T.border}`, background: T.bg, minWidth: 560 }}>
                <div style={{ ...th, flex: 1 }}>Indicator</div>
                <div style={{ ...th, width: 110, textAlign: "right" }}>Est. Buy</div>
                <div style={{ ...th, width: 110, textAlign: "right" }}>Est. Sell</div>
                <div style={{ ...th, width: 110, textAlign: "right" }}>Est. GP</div>
                <div style={{ ...th, width: 110, textAlign: "right" }}>Actual GP</div>
              </div>
              {cpiRows.map(r => (
                <div key={r.pi} id={`shpacct-gp-cpi-row-${r.pi}`} style={{ display: "flex", alignItems: "center", padding: "9px 16px",
                  borderBottom: `1px solid ${T.border}22`, minWidth: 560 }}>
                  <div style={{ flex: 1, fontFamily: T.body, fontSize: 13, color: T.text }}>
                    {r.pi} <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                      — {r.pi === "Prepaid" ? "paid at origin" : "paid at destination"}</span>
                  </div>
                  <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: T.text }}>{fmtUsd(r.estBuy)}</div>
                  <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: T.text }}>{fmtUsd(r.estSell)}</div>
                  <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12,
                    color: r.estGp >= 0 ? T.success : T.danger }}>{fmtUsd(r.estGp)}</div>
                  <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                    color: r.actGp >= 0 ? T.success : T.danger }}>{fmtUsd(r.actGp)}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
            textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
            By Charge Code
          </div>
          {rows.length === 0 ? (
            <div id="shpacct-gp-empty" style={{ padding: 48, textAlign: "center", fontFamily: T.body,
              fontSize: 13, color: T.textMuted, fontStyle: "italic",
              background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
              No cost or invoice lines yet.
            </div>
          ) : (
            <div id="shpacct-gp-table" style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface, overflowX: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", padding: "7px 16px",
                borderBottom: `1px solid ${T.border}`, background: T.bg, minWidth: 640 }}>
                <div style={{ ...th, flex: 1 }}>Charge Code</div>
                <div style={{ ...th, width: 110, textAlign: "right" }}>Est. GP</div>
                <div style={{ ...th, width: 110, textAlign: "right" }}>Actual GP</div>
                <div style={{ ...th, width: 110, textAlign: "right" }}>Variance</div>
              </div>
              {rows.map(r => (
                <div key={r.chargeCode} id={`shpacct-gp-row-${r.chargeCode}`} style={{ display: "flex", alignItems: "center", padding: "9px 16px",
                  borderBottom: `1px solid ${T.border}22`, minWidth: 640 }}>
                  <div style={{ flex: 1, fontFamily: T.body, fontSize: 13, color: T.text }}>{r.chargeCode}</div>
                  <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12,
                    color: r.estGp >= 0 ? T.success : T.danger }}>{fmtUsd(r.estGp)}</div>
                  <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                    color: r.actGp >= 0 ? T.success : T.danger }}>{fmtUsd(r.actGp)}</div>
                  <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12,
                    color: r.variance === 0 ? T.textMuted : r.variance > 0 ? T.success : T.danger }}>{fmtSigned(r.variance)}</div>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", padding: "9px 16px", background: T.bg, minWidth: 640 }}>
                <div style={{ flex: 1, fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text }}>Total</div>
                <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                  color: estGp >= 0 ? T.success : T.danger }}>{fmtUsd(estGp)}</div>
                <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                  color: actGp >= 0 ? T.success : T.danger }}>{fmtUsd(actGp)}</div>
                <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                  color: varGp === 0 ? T.textMuted : varGp > 0 ? T.success : T.danger }}>{fmtSigned(varGp)}</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ShipmentAccountingGpPage;
