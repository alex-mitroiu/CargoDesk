import { useState, useEffect } from "react";
import { api } from "../../api";
import GpBreakdownPanel from "../../components/shared/GpBreakdownPanel";
import { HZ, HZ_MONO, HZ_BODY, useHorizonFonts } from "./shipmentDetailTheme";

const fmtUsd = v => v == null ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ─── Shipment GP Overview Page ────────────────────────────────────────────
// Read-only derived aggregation of Cost Entry (BUY) + Invoice Entry (SELL) lines.
// TKT-83O41G (TKT-6QT30S phase 2): Estimated GP vs Actual GP vs Variance, split by charge
// code. "By office" is shown as shipment-level EMO/IMO context rather than a real per-line
// breakdown dimension — cost lines aren't tagged with an office_id. The actual breakdown
// rendering (stat cards, Profit Breakdown Sankey, CPI/charge-code tables) lives in the shared
// GpBreakdownPanel — see that file for why (ReportsPage.jsx's region/country aggregates reuse
// it unchanged over a differently-scoped lines array).
//
// Accounting Tabs Restyle (approved mockup: https://claude.ai/artifact/25ygL745mmMfvYWBXZWoAE) —
// deliberately HEADER-ONLY, per direct decision: GpBreakdownPanel stays exactly as it is (still
// base app T tokens, still shared with ReportsPage) — only this page's own context line + a
// small Trade Horizon stat strip are new. The 4 numbers below are recomputed here rather than
// read back off the panel (it has no prop to report them upward) — same math as the panel's own
// Estimated/Actual cards, just this page's own header display.
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
  const estSell = sellLines.reduce((s, l) => s + l.amountUsd, 0);
  const estBuy  = buyLines.reduce((s, l) => s + l.amountUsd, 0);
  const actSell = sellLines.reduce((s, l) => s + actualOf(l), 0);
  const actBuy  = buyLines.reduce((s, l) => s + actualOf(l), 0);
  const estGp = estSell - estBuy;
  const actGp = actSell - actBuy;
  const marginPct = estSell > 0 ? Math.round((estGp / estSell) * 1000) / 10 : null;
  const actualizedCount = lines.filter(l => l.status && l.status !== "accrued").length;

  useHorizonFonts();

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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, padding: "14px 18px" }}>
            {[
              ["Est. GP", fmtUsd(estGp), estGp >= 0 ? HZ.good : HZ.crit],
              ["Act. GP", fmtUsd(actGp), actGp >= 0 ? HZ.good : HZ.crit],
              ["Variance", fmtUsd(actGp - estGp), HZ.text],
              ["Margin", marginPct != null ? `${marginPct}%` : "—", estGp >= 0 ? HZ.good : HZ.crit],
            ].map(([label, value, color]) => (
              <div key={label} style={{ background: HZ.bg, border: `1px solid ${HZ.border}`, borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontFamily: HZ_BODY, fontSize: 10, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
                <div style={{ fontFamily: HZ_MONO, fontSize: 16, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <GpBreakdownPanel lines={lines} loading={loading} />
    </div>
  );
};

export default ShipmentAccountingGpPage;
