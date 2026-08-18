import { useMemo, useRef, useState } from "react";
import { Sankey, ResponsiveContainer, Rectangle } from "recharts";
import { T } from "../../tokens";

const fmtUsd = v => `$${Math.round(v).toLocaleString("en-US")}`;
const fmtUsdSigned = v => `${v < 0 ? "-" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;

const NODE_W = 14;
const MAX_LEAVES = 6; // series-count ceiling — past this, fold the tail into "Other"

// kind -> the one status hue it wears throughout: revenue family (accent), profit outcome
// (success), cost family + loss outcome (danger), tax (info — same hue the SELL row's own
// "VAT 12%" badge already uses in ShipmentDetailPage.jsx's CostLineRow, so the diagram and the
// line-item list read as the same concept). Every node also carries its own text label, so
// color is never the only channel identifying what a node/link means (status-color rule).
// A function, not a precomputed object — T's colors mutate in place on theme toggle, so this
// must re-read T.accent/T.danger/T.success on every call rather than freezing their values at
// module-load time (same class of bug this codebase already fixed once, see v0.55.1's
// LEG_TYPE_COLOR note).
const kindColor = kind => ({ revenue: T.accent, cost: T.danger, profit: T.success, loss: T.danger, tax: T.info }[kind]) || T.textMuted;

// Builds a conservation-safe Sankey graph from a shipment's own BUY/SELL cost lines:
//   [SELL charge codes] -> Revenue -> Gross Profit                    (gp >= 0)
//                                  \-> Total Cost -> [BUY charge codes]
//   VAT on Sales -> VAT (Collected)                                   (a separate lane, when > 0)
// When cost exceeds revenue (gp < 0), Revenue can only forward what it actually received
// (totalSell) — the shortfall is a distinct "Net Loss" source feeding Total Cost directly, so
// Total Cost's inbound (totalSell + shortfall) still exactly balances its own outbound (the real
// BUY breakdown) rather than silently understating it.
// VAT is deliberately its own disconnected lane, not folded into the Revenue chain — every SELL
// line's amountUsd (and therefore totalSell/GP) is already VAT-exclusive (see mapCostLine), so
// wiring VAT into the same nodes would either double-count it or require re-deriving each
// charge code's VAT share, both wrong. This lane exists purely so a viewer of the graph doesn't
// have to already know VAT is invisible here — real money the business collects and remits,
// shown for completeness, explicitly outside the GP calculation.
function buildSankey(lines, mode) {
  const amtOf = l => (mode === "actual" ? (l.actualAmountUsd ?? l.amountUsd) : l.amountUsd) || 0;

  const group = arr => {
    const map = new Map();
    for (const l of arr) {
      const amt = amtOf(l);
      if (!amt) continue;
      map.set(l.chargeCode, (map.get(l.chargeCode) || 0) + amt);
    }
    return [...map.entries()].map(([chargeCode, value]) => ({ chargeCode, value })).sort((a, b) => b.value - a.value);
  };
  const fold = (rows, otherLabel) => {
    if (rows.length <= MAX_LEAVES) return rows;
    const head = rows.slice(0, MAX_LEAVES - 1);
    const tail = rows.slice(MAX_LEAVES - 1).reduce((s, r) => s + r.value, 0);
    return [...head, { chargeCode: otherLabel, value: tail }];
  };

  const sellRows  = fold(group(lines.filter(l => l.type === "SELL")), "Other Revenue");
  const buyRows   = fold(group(lines.filter(l => l.type === "BUY")),  "Other Costs");
  const totalSell = sellRows.reduce((s, r) => s + r.value, 0);
  const totalBuy  = buyRows.reduce((s, r) => s + r.value, 0);
  const gp        = totalSell - totalBuy;
  // No actual/estimated split exists for VAT (mapCostLine always derives it from the line's
  // original amount, never actual_amount) — same one number regardless of `mode`, matching
  // GpBreakdownPanel's own "Sell VAT" stat card just above this diagram.
  const totalVat  = lines.filter(l => l.type === "SELL").reduce((s, l) => s + (l.vatAmountUsd || 0), 0);
  if (totalSell === 0 && totalBuy === 0 && totalVat === 0) return null;

  const nodes = [];
  const links = [];
  const idxOf = {};
  const add = (key, name, kind) => {
    if (idxOf[key] == null) { idxOf[key] = nodes.length; nodes.push({ name, kind }); }
    return idxOf[key];
  };

  const revIdx = totalSell > 0 ? add("__revenue__", "Revenue", "revenue") : null;
  sellRows.forEach(r => links.push({
    source: add(`sell:${r.chargeCode}`, r.chargeCode, "revenue"), target: revIdx, value: r.value, kind: "revenue",
  }));

  const costIdx = totalBuy > 0 ? add("__cost__", "Total Cost", "cost") : null;
  buyRows.forEach(r => links.push({
    source: costIdx, target: add(`buy:${r.chargeCode}`, r.chargeCode, "cost"), value: r.value, kind: "cost",
  }));

  if (revIdx != null && costIdx != null) {
    links.push({ source: revIdx, target: costIdx, value: gp >= 0 ? totalBuy : totalSell, kind: "cost" });
  }
  if (gp > 0) {
    links.push({ source: revIdx, target: add("__profit__", "Gross Profit", "profit"), value: gp, kind: "profit" });
  } else if (gp < 0 && costIdx != null) {
    links.push({ source: add("__loss__", "Net Loss", "loss"), target: costIdx, value: -gp, kind: "loss" });
  }

  if (totalVat > 0) {
    const vatSrcIdx = add("__vat_src__", "VAT on Sales", "tax");
    const vatIdx    = add("__vat__", "VAT (Collected)", "tax");
    links.push({ source: vatSrcIdx, target: vatIdx, value: totalVat, kind: "tax" });
  }

  return { nodes, links, totalSell, totalBuy, totalVat, gp };
}

function SankeyNode({ x, y, width, height, payload, onHover, onLeave, revenueTotal }) {
  const color = kindColor(payload.kind);
  const isSource = payload.sourceNodes.length === 0; // true source (no inbound) -> label sits left of the bar
  // "% of revenue" is meaningless for the VAT lane — it isn't revenue, and dividing by
  // revenueTotal would understate it (or mislead a reader into thinking it's part of GP).
  const pct = payload.kind !== "tax" && revenueTotal > 0 ? (payload.value / revenueTotal) * 100 : null;
  const sub = payload.kind === "tax"
    ? "Collected on behalf of the tax authority — not part of GP"
    : (pct != null ? `${pct.toFixed(1)}% of revenue` : null);
  const labelX = isSource ? x - 8 : x + width + 8;
  const anchor = isSource ? "end" : "start";
  return (
    <g
      onMouseEnter={e => onHover(e, { title: payload.name, value: payload.value, sub, color })}
      onMouseMove={e => onHover(e, { title: payload.name, value: payload.value, sub, color })}
      onMouseLeave={onLeave}
      style={{ cursor: "default" }}
    >
      <Rectangle x={x} y={y} width={width} height={Math.max(height, 2)} fill={color} radius={2} />
      <text x={labelX} y={y + height / 2 - 6} textAnchor={anchor} fontFamily={T.body} fontSize={12} fontWeight={700} fill={T.text}>
        {payload.name}
      </text>
      <text x={labelX} y={y + height / 2 + 10} textAnchor={anchor} fontFamily={T.mono} fontSize={11} fill={T.textMuted}>
        {fmtUsd(payload.value)}{pct != null ? `  (${pct.toFixed(1)}%)` : ""}
      </text>
    </g>
  );
}

function SankeyLink({ sourceX, sourceY, targetX, targetY, sourceControlX, targetControlX, linkWidth, payload, onHover, onLeave, hovered }) {
  const color = kindColor(payload.kind);
  const d = `M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`;
  const isHovered = hovered === payload;
  return (
    <path
      d={d} fill="none" stroke={color}
      strokeWidth={Math.max(linkWidth, 1)}
      strokeOpacity={isHovered ? 0.55 : 0.28}
      onMouseEnter={e => onHover(e, {
        title: `${payload.source.name} → ${payload.target.name}`, value: payload.value, sub: null, color, link: payload,
      })}
      onMouseMove={e => onHover(e, {
        title: `${payload.source.name} → ${payload.target.name}`, value: payload.value, sub: null, color, link: payload,
      })}
      onMouseLeave={onLeave}
      style={{ cursor: "default", transition: "stroke-opacity .12s" }}
    />
  );
}

const ShipmentGpSankey = ({ lines }) => {
  const [mode, setMode] = useState("actual");
  const [tip, setTip]   = useState(null); // { x, y, title, value, sub, color, link }
  const wrapRef = useRef(null);

  const data = useMemo(() => buildSankey(lines || [], mode), [lines, mode]);

  const showTip = (e, info) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, ...info });
  };
  const hideTip = () => setTip(null);

  if (!data) return null;
  const { nodes, links, totalSell, totalVat, gp } = data;

  return (
    <div id="shpacct-gp-sankey" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "18px 18px 14px", marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div>
          <h2 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 3px" }}>Profit Breakdown</h2>
          <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>
            Revenue by charge code flowing through to {gp >= 0 ? "Gross Profit" : "Net Loss"}
          </p>
        </div>
        <div id="shpacct-gp-sankey-mode" style={{ display: "inline-flex", gap: 2, padding: 3, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 9 }}>
          {[["estimated", "Estimated"], ["actual", "Actual"]].map(([key, label]) => (
            <button key={key} onClick={() => setMode(key)} style={{
              padding: "5px 12px", fontFamily: T.body, fontSize: 12, fontWeight: mode === key ? 700 : 500,
              color: mode === key ? T.btnPrimaryText : T.textMuted,
              background: mode === key ? T.accent : "transparent",
              border: "none", borderRadius: 6, cursor: "pointer", transition: "background .12s, color .12s",
            }}>{label}</button>
          ))}
        </div>
      </div>

      <div ref={wrapRef} style={{ position: "relative" }}>
        <ResponsiveContainer width="100%" height={460}>
          <Sankey
            data={{ nodes, links }}
            nodeWidth={NODE_W}
            nodePadding={30}
            linkCurvature={0.5}
            iterations={48}
            margin={{ top: 24, right: 176, bottom: 24, left: 176 }}
            node={props => <SankeyNode {...props} onHover={showTip} onLeave={hideTip} revenueTotal={totalSell} />}
            link={props => <SankeyLink {...props} onHover={showTip} onLeave={hideTip} hovered={tip?.link} />}
          />
        </ResponsiveContainer>

        {tip && (
          <div style={{
            position: "absolute", left: tip.x + 14, top: tip.y + 14, pointerEvents: "none", zIndex: 5,
            background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
            boxShadow: "0 4px 20px rgba(0,0,0,.18)", padding: "8px 12px", minWidth: 140,
          }}>
            <div style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 800, color: tip.color }}>{fmtUsd(tip.value)}</div>
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 2 }}>{tip.title}</div>
            {tip.sub && <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, marginTop: 1 }}>{tip.sub}</div>}
          </div>
        )}
      </div>

      <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 4 }}>
        {gp >= 0
          ? <>Net result: <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.success }}>{fmtUsd(gp)}</span> gross profit</>
          : <>Net result: <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.danger }}>{fmtUsdSigned(gp)}</span> net loss — costs exceeded revenue</>}
        {totalVat > 0 && <> · plus <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.info }}>{fmtUsd(totalVat)}</span> VAT collected, excluded from GP</>}
      </div>
    </div>
  );
};

export default ShipmentGpSankey;
