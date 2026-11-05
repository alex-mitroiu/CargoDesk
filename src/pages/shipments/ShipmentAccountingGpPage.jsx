import { useState, useEffect } from "react";
import { api } from "../../api";
import GpBreakdownPanel, { gpTotals } from "../../components/shared/GpBreakdownPanel";
import { HZ, HZ_MONO, HZ_BODY, useHorizonFonts } from "./shipmentDetailTheme";

const fmtUsd = v => v == null ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtSigned = v => v == null ? "—" : `${v > 0 ? "+" : ""}${fmtUsd(v)}`;
const fmtPct = v => v == null ? "—" : `${v}%`;
const fmtPts = v => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)} pts`;

// ─── Shipment GP Overview Page ────────────────────────────────────────────
// Read-only derived aggregation of Cost Entry (BUY) + Invoice Entry (SELL) lines.
// TKT-83O41G (TKT-6QT30S phase 2): Estimated GP vs Actual GP vs Variance, split by charge
// code. "By office" is shown as shipment-level EMO/IMO context rather than a real per-line
// breakdown dimension — cost lines aren't tagged with an office_id. The Profit Breakdown Sankey
// and the CPI/charge-code tables live in the shared GpBreakdownPanel (ReportsPage.jsx's
// region/country aggregates reuse it over a differently-scoped lines array).
//
// The Profitability card holds every headline figure: the four tiles plus Buy / Sell / GP / Margin,
// estimated against actual. The panel used to repeat them in eight tiles and a variance strip; that
// was merged here (Trade Horizon rollout, decided 2026-11-05, mockup
// https://claude.ai/code/artifact/ea0e96f7-7c88-4b82-9d67-bf6e8edb2fef), so the page passes
// summaryAbove. Both read the same gpTotals, so they can never disagree.
const ShipmentAccountingGpPage = ({ shipment, onBack }) => {
  const [lines,   setLines]   = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    return api.costLines.list(shipment.id).then(setLines).catch(() => setLines([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [shipment.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const { estBuy, estSell, actBuy, actSell, estGp, actGp, varGp, estPct, actPct, vatTotal, actualizedCount } = gpTotals(lines);
  const tone = v => v > 0 ? HZ.good : v < 0 ? HZ.crit : HZ.textMuted;
  const gpColor = v => v >= 0 ? HZ.good : HZ.crit;

  useHorizonFonts();

  const cell = { width: 120, textAlign: "right", fontFamily: HZ_MONO, fontSize: 12 };
  const th = { fontFamily: HZ_BODY, fontSize: 10, fontWeight: 700, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: ".07em" };
  const marginDiff = estPct != null && actPct != null ? Math.round((actPct - estPct) * 10) / 10 : null;
  const summaryRows = [
    { key: "buy",  label: "Buy",          est: fmtUsd(estBuy),  act: fmtUsd(actBuy),  diff: fmtSigned(actBuy - estBuy),   diffColor: HZ.textMuted },
    { key: "sell", label: "Sell",         est: fmtUsd(estSell), act: fmtUsd(actSell), diff: fmtSigned(actSell - estSell), diffColor: HZ.textMuted },
    { key: "gp",   label: "Gross profit", est: fmtUsd(estGp),   act: fmtUsd(actGp),   diff: fmtSigned(varGp),             diffColor: tone(varGp),
      estColor: gpColor(estGp), actColor: gpColor(actGp) },
    { key: "margin", label: "Margin",     est: fmtPct(estPct),  act: fmtPct(actPct),  diff: fmtPts(marginDiff),
      diffColor: marginDiff != null ? tone(marginDiff) : HZ.textMuted, estColor: gpColor(estGp), actColor: gpColor(actGp) },
  ];

  return (
    <div id="shpacct-gp-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div id="shpacct-gp-header" style={{ background: HZ.surface, backdropFilter: "blur(20px)",
        border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8,
          padding: "14px 18px", borderBottom: `1px solid ${HZ.border}` }}>
          <span style={{ fontFamily: HZ_BODY, fontSize: 11, fontWeight: 700, color: HZ.textMuted,
            textTransform: "uppercase", letterSpacing: ".08em" }}>Profitability</span>
          <span style={{ fontFamily: HZ_MONO, fontSize: 11.5, color: HZ.textMuted }}>
            read-only · EMO {shipment.emoOfficeName || "—"} · IMO {shipment.imoOfficeName || "—"}
            {actualizedCount > 0 && ` · ${actualizedCount} line${actualizedCount !== 1 ? "s" : ""} actualized/posted`}
          </span>
        </div>
        {!loading && (
          <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
              {[
                ["Est. GP", fmtUsd(estGp), gpColor(estGp)],
                ["Act. GP", fmtUsd(actGp), gpColor(actGp)],
                ["Variance", fmtUsd(varGp), HZ.text],
                ["Margin", fmtPct(estPct), gpColor(estGp)],
              ].map(([label, value, color]) => (
                <div key={label} style={{ background: HZ.bg, border: `1px solid ${HZ.border}`, borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontFamily: HZ_BODY, fontSize: 10, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
                  <div style={{ fontFamily: HZ_MONO, fontSize: 16, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
                </div>
              ))}
            </div>

            <div id="shpacct-gp-summary" style={{ border: `1px solid ${HZ.border}`, borderRadius: 8, overflowX: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", padding: "8px 16px", borderBottom: `1px solid ${HZ.border}`,
                background: HZ.tint, minWidth: 480 }}>
                <div style={{ ...th, flex: 1 }} />
                <div style={{ ...th, ...cell }}>Estimated</div>
                <div style={{ ...th, ...cell }}>Actual</div>
                <div style={{ ...th, ...cell }}>Variance</div>
              </div>
              {summaryRows.map((r, i) => (
                <div key={r.key} id={`shpacct-gp-summary-${r.key}`} style={{ display: "flex", alignItems: "center", padding: "9px 16px",
                  borderBottom: i < summaryRows.length - 1 ? `1px solid ${HZ.border}` : "none", minWidth: 480 }}>
                  <div style={{ flex: 1, fontFamily: HZ_BODY, fontSize: 13, color: HZ.text }}>{r.label}</div>
                  <div style={{ ...cell, color: r.estColor || HZ.text }}>{r.est}</div>
                  <div style={{ ...cell, fontWeight: r.actColor ? 700 : 400, color: r.actColor || HZ.text }}>{r.act}</div>
                  <div style={{ ...cell, color: r.diffColor }}>{r.diff}</div>
                </div>
              ))}
            </div>

            <div style={{ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted }}>
              Actual counts actualized and posted lines; lines still accrued use their estimate.
              {vatTotal > 0 && <> Sell VAT <span id="shpacct-gp-summary-vat" style={{ fontFamily: HZ_MONO, color: HZ.text }}>{fmtUsd(vatTotal)}</span> is charged on top of Sell and isn't part of GP.</>}
            </div>
          </div>
        )}
      </div>
      <GpBreakdownPanel lines={lines} loading={loading} summaryAbove />
    </div>
  );
};

export default ShipmentAccountingGpPage;
