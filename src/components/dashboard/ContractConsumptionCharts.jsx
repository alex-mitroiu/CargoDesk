import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sankey, ResponsiveContainer, Rectangle } from "recharts";
import { inUnit, buildBreakdown } from "../../utils/contractConsumption";

// Contract Consumption charts for the Dashboard (approved mockup:
// https://claude.ai/artifact/TqrzSKpPFsUQF6VVkXvrs8). Every component takes `hz` — the Dashboard's
// mutable Trade Horizon token object — and reads it at render time, so a theme toggle repaints them.

// Measured width, so the SVG charts are drawn at real pixels (text stays its real size).
function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// Portaled to <body>: position:fixed inside a backdrop-filter card resolves against the card, not
// the viewport, so an in-card tooltip lands off target.
function ChartTip({ tip, hz }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const w = ref.current.offsetWidth, h = ref.current.offsetHeight, pad = 16;
    let x = tip.x + pad, y = tip.y + pad;
    if (x + w > window.innerWidth - 8) x = tip.x - w - pad;
    if (y + h > window.innerHeight - 8) y = tip.y - h - pad;
    setPos({ x, y });
  }, [tip]);
  if (!tip) return null;
  const dark = hz.bg === "#080b15";
  return createPortal(
    <div ref={ref} role="tooltip" data-testid="consumption-tooltip" style={{
      position: "fixed", left: pos?.x ?? tip.x + 16, top: pos?.y ?? tip.y + 16, zIndex: 1000, pointerEvents: "none",
      minWidth: 230, maxWidth: 320, background: dark ? "#0d1220" : "#ffffff", color: hz.ink,
      border: `1px solid ${hz.border}`, borderRadius: 10, padding: "10px 12px",
      boxShadow: "0 12px 32px -8px rgba(0,0,0,.45)", fontFamily: hz.fontBody, fontSize: 12,
    }}>{tip.content}</div>,
    document.body,
  );
}

const TipHead = ({ hz, carrierCode, title }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 7, paddingBottom: 7, marginBottom: 7, borderBottom: `1px solid ${hz.border}` }}>
    {carrierCode && <span style={{ fontFamily: hz.fontMono, fontSize: 10, fontWeight: 700, color: hz.inkMuted, border: `1px solid ${hz.border}`, borderRadius: 4, padding: "1px 5px" }}>{carrierCode}</span>}
    <span style={{ fontFamily: hz.fontMono, fontSize: 13, fontWeight: 700 }}>{title}</span>
  </div>
);
const TipRow = ({ hz, color, line, value, label, extra }) => (
  <div style={{ display: "grid", gridTemplateColumns: "10px auto 1fr", columnGap: 8, alignItems: "baseline", padding: "2px 0" }}>
    <span style={{ width: line ? 10 : 9, height: line ? 2 : 9, borderRadius: line ? 1 : 2, background: color, alignSelf: "center" }} />
    <span style={{ fontFamily: hz.fontMono, fontSize: 12.5, fontWeight: 700 }}>{value}</span>
    <span style={{ color: hz.inkMuted }}>{label}</span>
    {extra && <span style={{ gridColumn: 3, color: hz.inkMuted, fontFamily: hz.fontMono, fontSize: 11 }}>{extra}</span>}
  </div>
);
const TipFoot = ({ hz, children }) => (
  <div style={{ marginTop: 8, paddingTop: 7, borderTop: `1px solid ${hz.border}`, color: hz.inkMuted, fontSize: 11 }}>{children}</div>
);

export const UnitSwitch = ({ unit, onChange, hz }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: hz.fontBody, fontSize: 12, color: hz.inkMuted }}>
    <span>Show values as</span>
    <div role="group" aria-label="Show values as" style={{ display: "inline-flex", padding: 2, border: `1px solid ${hz.border}`, borderRadius: 7, background: hz.borderSoft }}>
      {[["teu", "TEU"], ["pct", "%"]].map(([k, label]) => (
        <button key={k} type="button" data-testid={`consumption-unit-${k}`} aria-pressed={unit === k} onClick={() => onChange(k)}
          style={{ fontFamily: hz.fontMono, fontSize: 11.5, fontWeight: 600, border: 0, borderRadius: 5, padding: "3px 10px", cursor: "pointer",
            color: unit === k ? hz.bg : hz.inkMuted, background: unit === k ? hz.gradCyan[0] : "transparent" }}>{label}</button>
      ))}
    </div>
  </div>
);

export const ChartCard = ({ hz, title, action, legend, children, testId }) => (
  <div data-testid={testId} style={{ background: hz.surface, border: `1px solid ${hz.border}`, boxShadow: hz.cardShadow, borderRadius: 16,
    backdropFilter: "blur(16px)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
      <h2 style={{ fontFamily: hz.fontDisplay, fontSize: 15, fontWeight: 600, color: hz.ink, margin: 0 }}>{title}</h2>
      {action}
    </div>
    {legend}
    {children}
  </div>
);

export const StatusLegend = ({ hz, items }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontFamily: hz.fontBody, fontSize: 11.5, color: hz.inkMuted }}>
    {items.map(([color, label]) => (
      <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {color && <i style={{ width: 10, height: 10, borderRadius: 3, background: color, display: "inline-block" }} />}{label}
      </span>
    ))}
  </div>
);

const niceStep = (max, maxTicks = 5) => [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find(k => max / k <= maxTicks) || 10000;
const pointOf = e => ({ x: e.clientX, y: e.clientY });

// ── Allocation by contract: one stacked vertical bar per contract number ──────────────────────
export function ContractBarsChart({ rows, selectedKey, onSelect, unit, hz }) {
  const [hostRef, hostWidth] = useElementWidth();
  const [tip, setTip] = useState(null);
  const pct = unit === "pct";
  const W = Math.max(380, hostWidth || 0, rows.length * 56 + 120);
  const angled = (W - 58) / Math.max(1, rows.length) < 118;
  const H = angled ? 330 : 300, M = { t: 26, r: 12, b: angled ? 86 : 44, l: angled ? 104 : 46 };
  const val = (t, v) => (pct ? (t.alloc ? (v / t.alloc) * 100 : 0) : v);
  const maxV = Math.max(1, ...rows.map(r => val(r.totals, Math.max(r.totals.alloc, r.totals.conf + r.totals.pend))));
  const step = pct ? 20 : niceStep(maxV), top = Math.ceil(maxV / step) * step;
  const y = v => M.t + (H - M.t - M.b) * (1 - v / top);
  const slot = (W - M.l - M.r) / Math.max(1, rows.length), bw = Math.min(54, slot * 0.46);
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);

  // The tooltip always shows TEU and % (it doesn't follow the unit switch).
  const tipFor = row => {
    const t = row.totals, share = v => (t.alloc ? `${Math.round((v / t.alloc) * 100)}%` : "");
    return (
      <>
        <TipHead hz={hz} carrierCode={row.carrierCode} title={row.contractNumber} />
        <div style={{ fontFamily: hz.fontDisplay, fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{Math.round(t.used * 100)}% of {t.alloc} TEU in use</div>
        <TipRow hz={hz} color={hz.good} value={`${t.conf} TEU`} label="Confirmed" extra={`${share(t.conf)} · ${t.confN} bookings`} />
        <TipRow hz={hz} color={hz.warning} value={`${t.pend} TEU`} label="Pending confirmation" extra={`${share(t.pend)} · ${t.pendN} bookings`} />
        <TipRow hz={hz} color={hz.available} value={`${Math.max(0, t.net)} TEU`} label="Available" extra={share(Math.max(0, t.net))} />
        {t.rej > 0 && <TipRow hz={hz} color={hz.critical} value={`${t.rej} TEU`} label="Rejected (not using space)" extra={`${t.rejN} bookings`} />}
        {t.over > 0 && <div style={{ marginTop: 6, color: hz.critical, fontWeight: 600, fontSize: 11.5 }}>⚠ {t.overRefs.map(r => r.ref || "(no reference)").join(", ")} {t.overRefs.length > 1 ? "are" : "is"} {t.over} TEU over {t.overRefs.length > 1 ? "their" : "its"} own allocation</div>}
        <TipFoot hz={hz}>{row.refs.length > 1 ? `${row.refs.length} references · click for the breakdown` : "Click for the breakdown"}</TipFoot>
      </>
    );
  };

  return (
    <div ref={hostRef} style={{ width: "100%", overflowX: "auto" }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Allocated space per contract number, split into confirmed, pending and available" style={{ display: "block" }}>
        {ticks.map(v => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke={hz.borderSoft} />
            <text x={M.l - 8} y={y(v) + 4} textAnchor="end" style={{ font: `500 10.5px ${hz.fontMono}`, fill: hz.inkMuted }}>{v}{pct ? "%" : ""}</text>
          </g>
        ))}
        <text x={M.l - 8} y={M.t - 12} textAnchor="end" style={{ font: `500 10.5px ${hz.fontMono}`, fill: hz.inkMuted }}>{pct ? "% of allocation" : "TEU"}</text>
        {rows.map((row, i) => {
          const t = row.totals, cx = M.l + slot * i + slot / 2, x = cx - bw / 2;
          const segs = [["conf", hz.good, val(t, t.conf)], ["pend", hz.warning, val(t, t.pend)], ["avail", hz.available, val(t, Math.max(0, t.net))]].filter(s => s[2] > 0);
          let base = 0;
          const sel = row.key === selectedKey;
          const barTop = y(val(t, Math.max(t.alloc, t.conf + t.pend)));
          const label = angled || row.contractNumber.length <= 19 ? row.contractNumber : `${row.contractNumber.slice(0, 18)}…`;
          return (
            <g key={row.key} data-testid={`consumption-bar-${row.key}`} tabIndex={0} role="button" aria-pressed={sel}
              aria-label={`${row.contractNumber}: ${Math.round(t.used * 100)}% in use. Show breakdown`} style={{ cursor: "pointer", outline: "none" }}
              onClick={() => onSelect(row.key)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(row.key); } }}
              onPointerMove={e => setTip({ ...pointOf(e), content: tipFor(row) })}
              onPointerLeave={() => setTip(null)}
              onFocus={e => { const b = e.currentTarget.getBoundingClientRect(); setTip({ x: b.right, y: b.top, content: tipFor(row) }); }}
              onBlur={() => setTip(null)}>
              <rect x={cx - slot / 2 + 4} y={M.t - 6} width={Math.max(0, slot - 8)} height={H - M.t - M.b + 6} fill="transparent" />
              {sel && <rect x={x - 4} y={barTop - 4} width={bw + 8} height={y(0) - barTop + 4} rx={6} fill="none" stroke={hz.ink} strokeWidth={1.5} strokeDasharray="3 3" />}
              {segs.map(([k, color, v], j) => {
                const y0 = y(base), y1 = y(base + v), gap = j ? 2 : 0, h = Math.max(1, y0 - y1 - gap);
                base += v;
                // 2px surface gap between segments; 4px rounded data-end on the top one only.
                return j === segs.length - 1
                  ? <path key={k} fill={color} d={`M${x},${y1 + h} V${y1 + 4} Q${x},${y1} ${x + 4},${y1} H${x + bw - 4} Q${x + bw},${y1} ${x + bw},${y1 + 4} V${y1 + h} Z`} />
                  : <rect key={k} fill={color} x={x} y={y1} width={bw} height={h} />;
              })}
              <text x={cx} y={barTop - 8} textAnchor="middle" style={{ font: `600 11px ${hz.fontMono}`, fill: hz.inkMuted }}>{Math.round(t.used * 100)}%{t.over ? " ⚠" : ""}</text>
              {angled
                ? <text x={cx + 4} y={H - M.b + 14} textAnchor="end" transform={`rotate(-35 ${cx + 4} ${H - M.b + 14})`} style={{ font: `${sel ? 700 : 500} 10.5px ${hz.fontMono}`, fill: sel ? hz.ink : hz.inkMuted }}>{label}</text>
                : <text x={cx} y={H - M.b + 18} textAnchor="middle" style={{ font: `${sel ? 700 : 500} 10.5px ${hz.fontMono}`, fill: sel ? hz.ink : hz.inkMuted }}>{label}</text>}
            </g>
          );
        })}
        <line x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} stroke={hz.border} />
      </svg>
      <ChartTip tip={tip} hz={hz} />
    </div>
  );
}

// ── Weekly confirmed per contract — last 6 weeks ─────────────────────────────────────────────
// Series colors are the reference categorical slots 1–6 (validated for both themes), in a fixed
// order by contract number, so a contract keeps its color; past 6 contracts, the table shows the rest.
const MAX_SERIES = 6;
export function ContractTrendChart({ trend, allocByKey, selectedKey, onSelect, unit, hz, asTable }) {
  const [hostRef, hostWidth] = useElementWidth();
  const [tip, setTip] = useState(null);
  const [hoverWeek, setHoverWeek] = useState(null);
  const palette = [...hz.chartCategorical, "#008300"];
  const drawn = trend.series.slice(0, MAX_SERIES).map((s, i) => ({ ...s, color: palette[i] }));
  const pct = unit === "pct";
  const valueOf = (s, i) => (pct ? (allocByKey[s.key] ? (s.values[i] / allocByKey[s.key]) * 100 : 0) : s.values[i]);
  const fmt = (s, i) => inUnit(s.values[i], allocByKey[s.key], unit);

  const legend = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
      {drawn.map(s => (
        <button key={s.key} type="button" onClick={() => onSelect(s.key)} data-testid={`consumption-trend-legend-${s.key}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, font: `${s.key === selectedKey ? 700 : 500} 11.5px ${hz.fontMono}`,
            color: s.key === selectedKey ? hz.ink : hz.inkMuted, background: s.key === selectedKey ? hz.borderSoft : "none", border: 0, borderRadius: 4, padding: "2px 4px", cursor: "pointer" }}>
          <i style={{ width: 14, height: 2, borderRadius: 1, background: s.color, display: "inline-block" }} />{s.contractNumber}
        </button>
      ))}
      {trend.series.length > MAX_SERIES && <span style={{ fontSize: 11.5, color: hz.inkMuted }}>+{trend.series.length - MAX_SERIES} more in the table view</span>}
    </div>
  );

  if (!trend.series.length) {
    return <div style={{ padding: "40px 0", textAlign: "center", color: hz.inkMuted, fontFamily: hz.fontBody, fontSize: 12.5 }}>No confirmed bookings on a space configuration in these 6 weeks.</div>;
  }

  if (asTable) {
    const cell = { padding: "7px 6px", borderBottom: `1px solid ${hz.borderSoft}`, textAlign: "center", verticalAlign: "middle" };
    return (
      <div ref={hostRef} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {legend}
        <div style={{ overflowX: "auto" }}>
          <table data-testid="consumption-trend-table" style={{ width: "100%", borderCollapse: "collapse", fontFamily: hz.fontBody, fontSize: 11.5, color: hz.ink }}>
            <thead><tr>{["Contract", ...trend.weeks.map(w => w.label)].map(h => (
              <th key={h} style={{ ...cell, font: `600 10px ${hz.fontBody}`, color: hz.inkMuted, textTransform: "uppercase", letterSpacing: ".07em" }}>{h}</th>
            ))}</tr></thead>
            <tbody>{trend.series.map(s => (
              <tr key={s.key}>
                <td style={{ ...cell, whiteSpace: "nowrap" }}>{s.contractNumber}</td>
                {s.values.map((_, i) => <td key={i} style={{ ...cell, fontFamily: hz.fontMono, fontVariantNumeric: "tabular-nums" }}>{fmt(s, i)}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: hz.inkMuted }}>{pct ? "% of each contract's total allocation in the selected period, confirmed in that week." : "Confirmed TEU per week, by ETD."}</p>
      </div>
    );
  }

  const W = Math.max(380, hostWidth || 0), H = 270, M = { t: 28, r: 30, b: 30, l: 46 };
  const maxV = Math.max(...drawn.flatMap(s => s.values.map((_, i) => valueOf(s, i))));
  const step = niceStep(maxV || 1), top = Math.ceil((maxV || 1) / step) * step;
  const n = trend.weeks.length;
  const x = i => M.l + (W - M.l - M.r) * (i / (n - 1)), y = v => M.t + (H - M.t - M.b) * (1 - v / top);
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  const weekAt = (e, svg) => {
    const b = svg.getBoundingClientRect(), px = (e.clientX - b.left) * (W / b.width);
    return Math.max(0, Math.min(n - 1, Math.round((px - M.l) / ((W - M.l - M.r) / (n - 1)))));
  };
  const tipFor = i => (
    <>
      <TipHead hz={hz} title={`Week ending ${trend.weeks[i].label}`} />
      {[...drawn].sort((a, b) => valueOf(b, i) - valueOf(a, i)).map(s => (
        <TipRow key={s.key} hz={hz} line color={s.color} value={fmt(s, i)} label={`${s.carrierCode} · ${s.contractNumber}`} />
      ))}
      <TipFoot hz={hz}>Click a line or a legend entry for its breakdown</TipFoot>
    </>
  );

  return (
    <div ref={hostRef} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {legend}
      <div style={{ width: "100%", overflowX: "auto" }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly confirmed consumption per contract, last 6 weeks" style={{ display: "block" }}>
          {ticks.map(v => (
            <g key={v}>
              <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke={hz.borderSoft} />
              <text x={M.l - 8} y={y(v) + 4} textAnchor="end" style={{ font: `500 10.5px ${hz.fontMono}`, fill: hz.inkMuted }}>{v}{pct ? "%" : ""}</text>
            </g>
          ))}
          <text x={M.l - 8} y={M.t - 14} textAnchor="end" style={{ font: `500 10.5px ${hz.fontMono}`, fill: hz.inkMuted }}>{pct ? "%" : "TEU"}</text>
          {trend.weeks.map((w, i) => <text key={w.start} x={x(i)} y={H - 8} textAnchor="middle" style={{ font: `500 10.5px ${hz.fontMono}`, fill: hz.inkMuted }}>{w.label}</text>)}
          {hoverWeek != null && <line x1={x(hoverWeek)} x2={x(hoverWeek)} y1={M.t} y2={H - M.b} stroke={hz.inkMuted} />}
          {drawn.map(s => {
            const d = s.values.map((_, i) => `${i ? "L" : "M"}${x(i)},${y(valueOf(s, i))}`).join(" ");
            const dim = selectedKey && selectedKey !== s.key;
            return (
              <g key={s.key} opacity={dim ? 0.28 : 1}>
                <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
                {s.values.map((_, i) => <circle key={i} cx={x(i)} cy={y(valueOf(s, i))} r={4} fill={s.color} stroke={hz.bg} strokeWidth={2} />)}
              </g>
            );
          })}
          <rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} fill="transparent" style={{ cursor: "pointer" }}
            onPointerMove={e => { const i = weekAt(e, e.currentTarget.ownerSVGElement); setHoverWeek(i); setTip({ ...pointOf(e), content: tipFor(i) }); }}
            onPointerLeave={() => { setHoverWeek(null); setTip(null); }}
            onClick={e => {
              const svg = e.currentTarget.ownerSVGElement, i = weekAt(e, svg), b = svg.getBoundingClientRect(), py = (e.clientY - b.top) * (H / b.height);
              const near = [...drawn].sort((a, c) => Math.abs(y(valueOf(a, i)) - py) - Math.abs(y(valueOf(c, i)) - py))[0];
              if (near) onSelect(near.key);
            }} />
          <line x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} stroke={hz.border} />
        </svg>
      </div>
      <ChartTip tip={tip} hz={hz} />
    </div>
  );
}

// Per reference: space in the selected unit, then how its shipments' space was picked in the
// contract picker — steered there by the same-contract suggestion, picked directly, or booked onto
// it though full. "Not recorded" = booked before this was tracked. Cancelled bookings aren't counted.
function ReferenceTable({ row, unit, hz }) {
  const base = row.totals.alloc, u = v => inUnit(v, base, unit);
  const th = { font: `600 10px ${hz.fontBody}`, color: hz.inkMuted, textTransform: "uppercase", letterSpacing: ".07em", padding: "7px 8px", textAlign: "center", borderBottom: `1px solid ${hz.border}`, whiteSpace: "nowrap" };
  const td = { padding: "8px", textAlign: "center", borderBottom: `1px solid ${hz.borderSoft}`, fontFamily: hz.fontMono, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  const count = (n, color) => <span style={{ color: n ? color || hz.ink : hz.inkMuted, fontWeight: n ? 700 : 400 }}>{n}</span>;
  const all = [...row.refs, { ...row.totals, ref: "Total", namedAccount: "", isTotal: true }];
  return (
    <div style={{ overflowX: "auto" }}>
      <table data-testid="consumption-reference-table" style={{ width: "100%", borderCollapse: "collapse", fontFamily: hz.fontBody, fontSize: 12, color: hz.ink }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Reference</th><th style={{ ...th, textAlign: "left" }}>Named account</th>
            <th style={th}>Allocated</th><th style={th}>Confirmed</th><th style={th}>Pending</th><th style={th}>Available</th>
            <th style={th} title="Booked here through the picker's suggestion (steered from a full reference)">Steered here</th>
            <th style={th}>Picked directly</th>
            <th style={th} title="Booked here although it had no space left (Book here anyway)">Overbooked</th>
            <th style={th} title="Booked before this was recorded">Not recorded</th>
          </tr>
        </thead>
        <tbody>
          {all.map((r, i) => {
            const avail = r.alloc - r.conf - r.pend;
            const tot = r.isTotal ? { fontWeight: 700, borderTop: `1px solid ${hz.border}` } : {};
            return (
              <tr key={r.recordKey || `row${i}`}>
                <td style={{ ...td, ...tot, textAlign: "left", fontFamily: hz.fontBody }}>{r.ref || "(no reference)"}</td>
                <td style={{ ...td, ...tot, textAlign: "left", fontFamily: hz.fontBody, color: hz.inkMuted }}>{r.isTotal ? "" : r.namedAccount || "All accounts"}</td>
                <td style={{ ...td, ...tot }}>{u(r.alloc)}</td>
                <td style={{ ...td, ...tot, color: hz.good }}>{u(r.conf)}</td>
                <td style={{ ...td, ...tot, color: hz.warning }}>{u(r.pend)}</td>
                <td style={{ ...td, ...tot, color: avail < 0 ? hz.critical : hz.available }}>{avail < 0 ? `${u(-avail)} over` : u(avail)}</td>
                <td style={{ ...td, ...tot }}>{count(r.selSuggested, hz.gradCyan[0])}</td>
                <td style={{ ...td, ...tot }}>{count(r.selDirect)}</td>
                <td style={{ ...td, ...tot }}>{count(r.selOverbooked, hz.critical)}</td>
                <td style={{ ...td, ...tot }}>{count(r.selUnknown, hz.inkMuted)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Contract breakdown: the Profit Breakdown's Recharts Sankey, contract → references → status ──
const kindColor = (hz, kind) => ({ contract: hz.gradCyan[0], ref: hz.gradCyan[0], over: hz.critical, confirmed: hz.good, pending: hz.warning, available: hz.available }[kind] || hz.inkMuted);

export function ContractBreakdown({ row, unit, hz }) {
  const [tip, setTip] = useState(null);
  const data = useMemo(() => (row ? buildBreakdown(row) : null), [row]);
  if (!row) return null;
  const t = row.totals, u = v => inUnit(v, t.alloc, unit);
  const subOf = nd => {
    if (nd.kind === "contract") return unit === "pct" ? "100% allocated" : `${t.alloc} TEU allocated`;
    if (nd.kind === "over") return `+${u(nd.teu)}`;
    if (nd.kind === "ref") return unit === "pct" ? `${u(nd.teu)} of contract` : `${nd.teu} TEU · ${t.alloc ? Math.round((nd.teu / t.alloc) * 100) : 0}% of contract`;
    if (nd.bookings != null) return `${u(nd.teu)} · ${nd.bookings} bookings`;
    return u(nd.teu);
  };
  const stat = (label, value, color) => (
    <span style={{ display: "flex", flexDirection: "column", fontSize: 12, color: hz.inkMuted }}>{label}
      <b style={{ font: `700 17px ${hz.fontMono}`, color: color || hz.ink }}>{value}</b></span>
  );

  const Node = ({ x, y, width, height, payload }) => {
    const color = kindColor(hz, payload.kind), isSource = payload.kind === "contract" || payload.kind === "over";
    const lx = isSource ? x - 10 : x + width + 10, anchor = isSource ? "end" : "start";
    const halo = { paintOrder: "stroke", stroke: hz.bg, strokeWidth: 4, strokeLinejoin: "round" };
    return (
      <g onPointerMove={e => setTip({ ...pointOf(e), content: <><TipHead hz={hz} title={payload.name} /><div style={{ fontFamily: hz.fontMono, fontWeight: 700 }}>{u(payload.teu)}</div>{payload.bookings != null && <div style={{ color: hz.inkMuted }}>{payload.bookings} active bookings</div>}</> })}
        onPointerLeave={() => setTip(null)}>
        <Rectangle x={x} y={y} width={width} height={Math.max(height, 2)} fill={color} radius={2} />
        <text x={lx} y={y + height / 2 - 3} textAnchor={anchor} style={{ font: `700 12px ${hz.fontBody}`, fill: hz.ink, ...halo }}>{payload.name}</text>
        <text x={lx} y={y + height / 2 + 13} textAnchor={anchor} style={{ font: `500 11px ${hz.fontMono}`, fill: hz.inkMuted, ...halo }}>{subOf(payload)}</text>
      </g>
    );
  };
  const Link = ({ sourceX, sourceY, targetX, targetY, sourceControlX, targetControlX, linkWidth, payload }) => (
    <path d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none" stroke={kindColor(hz, payload.kind)} strokeWidth={Math.max(linkWidth, 1)} strokeOpacity={0.32}
      onPointerMove={e => setTip({ ...pointOf(e), content: <><TipHead hz={hz} title={`${payload.source.name} → ${payload.target.name}`} /><div style={{ fontFamily: hz.fontMono, fontWeight: 700 }}>{u(payload.value)}</div>{payload.bookings != null && <div style={{ color: hz.inkMuted }}>{payload.bookings} booking{payload.bookings !== 1 ? "s" : ""}</div>}</> })}
      onPointerLeave={() => setTip(null)} />
  );

  return (
    <div data-testid="consumption-breakdown" style={{ background: hz.surface, border: `1px solid ${hz.border}`, boxShadow: hz.cardShadow, borderRadius: 16,
      backdropFilter: "blur(16px)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 10 }}>
        <div>
          <h2 style={{ fontFamily: hz.fontDisplay, fontSize: 16, fontWeight: 600, color: hz.ink, margin: 0 }}>
            Contract breakdown — {row.contractNumber}
            <span style={{ font: `700 10px ${hz.fontMono}`, color: hz.inkMuted, border: `1px solid ${hz.border}`, borderRadius: 4, padding: "1px 5px", marginLeft: 8, verticalAlign: 2 }}>{row.carrierCode}</span>
          </h2>
          <p style={{ fontFamily: hz.fontBody, fontSize: 12, color: hz.inkMuted, margin: "3px 0 0" }}>
            How the allocated space is split across references, and how much of each is confirmed, pending or still free.
          </p>
        </div>
        <div data-testid="consumption-breakdown-stats" style={{ display: "flex", flexWrap: "wrap", gap: "8px 22px", fontFamily: hz.fontBody }}>
          {stat("Allocated", unit === "pct" ? "100%" : `${t.alloc} TEU`)}
          {stat("Confirmed", u(t.conf), hz.good)}
          {stat("Pending", u(t.pend), hz.warning)}
          {stat("Available", u(t.free))}
          {t.over > 0 && stat("Over allocation", `+${u(t.over)}`, hz.critical)}
        </div>
      </div>
      <StatusLegend hz={hz} items={[[hz.gradCyan[0], "Allocated space"], [hz.good, "Confirmed"], [hz.warning, "Pending confirmation"], [hz.available, "Available"], [hz.critical, "Over allocation"]]} />
      {data ? (
        <ResponsiveContainer width="100%" height={340}>
          <Sankey data={{ nodes: data.nodes, links: data.links }} nodeWidth={12} nodePadding={22} linkCurvature={0.5} iterations={48}
            margin={{ top: 16, right: 210, bottom: 16, left: 190 }} node={Node} link={Link} />
        </ResponsiveContainer>
      ) : (
        <div style={{ padding: "30px 0", textAlign: "center", color: hz.inkMuted, fontSize: 12.5 }}>No allocated space or bookings to break down.</div>
      )}
      <ReferenceTable row={row} unit={unit} hz={hz} />
      {t.rej > 0 && (
        <div style={{ fontFamily: hz.fontBody, fontSize: 12, color: hz.inkMuted }}>
          Rejected by the carrier: <b style={{ color: hz.critical, fontFamily: hz.fontMono }}>{u(t.rej)}</b> ({t.rejN} bookings). They don't use space, so they aren't in the diagram.
        </div>
      )}
      <ChartTip tip={tip} hz={hz} />
    </div>
  );
}
