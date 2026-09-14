import { useState, useEffect, useMemo, useCallback } from "react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
         Tooltip, Legend, ResponsiveContainer, ReferenceLine } from "recharts";
import { T, STATUSES, statusVariant, contractVariant, addDays, diffDays,
         currentWeekStart, MAX_RANGE_DAYS, teuOf, buildTeuLookup, todayIso, parseIso } from "../tokens";
import { api } from "../api";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import Pagination from "../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../components/primitives/PageSizeSelect";
import DatePicker from "../components/primitives/DatePicker";
import { useResizableColumns, ColResizer } from "../components/primitives/useResizableColumns.jsx";
import { IconWarning, IconRefresh, IconArrowDown, IconDashboard, IconFileCertificate, IconShip, IconCoin } from "../components/primitives/Icon";
import ConsumptionBar from "../components/shared/ConsumptionBar";
import InfoHint from "../components/primitives/InfoHint";
import { inputBase } from "../components/primitives/Form";
import ColumnFilter from "../components/shared/ColumnFilter";

// Booking-status badge — Confirmed is the only bucket that actively deducts from allocated
// space (v0.86.0); shown next to a shipment's own lifecycle Status wherever this dashboard
// already correlates a shipment to a space configuration, so the totals above are traceable
// back to individual rows.
const BOOKING_STATUS_VARIANT = {
  Confirmed: "success", Pending: "info", Created: "default", Rejected: "danger", Cancelled: "default",
};

// ─── "Trade Horizon" visual language (2026-09-12, direct request) ─────────────
// Page-scoped only, by direct decision — does NOT touch src/tokens.js's shared `T` object or
// any shared primitive, so every other page keeps its existing look untouched. Ported from an
// approved standalone mockup (dashboard-redesign session), itself inspired by a reference
// screenshot the user shared. `HZ.chart*` are NOT the decorative gradients below — they're the
// dataviz-skill-validated categorical/status steps (node scripts/validate_palette.js), kept
// separate on purpose so real chart color-encoding never doubles as decoration.
const HZ = {
  bg: "#080b15", surface: "rgba(255,255,255,0.045)", surfaceStrong: "rgba(255,255,255,0.075)",
  border: "rgba(255,255,255,0.09)", borderSoft: "rgba(255,255,255,0.055)",
  ink: "#f3f5fc", inkMuted: "#8c93b5", inkFaint: "#4d5476",
  fontDisplay: "'Sora', ui-sans-serif, system-ui, sans-serif",
  fontBody: "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif",
  fontMono: "'IBM Plex Mono', ui-monospace, monospace",
  gradCyan: ["#38d4e8", "#3987e5"], gradAmber: ["#fbc531", "#d9772a"], gradViolet: ["#9085e9", "#d5519f"],
  good: "#22c55e", warning: "#fab219", critical: "#f0526b",
  // dataviz-validated categorical order (node_modules-free hand check against the skill's own
  // reference steps) — cycles past 5 carriers rather than inventing a 6th hue.
  chartCategorical: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"],
};

// Trade Horizon's own token mapping for the shared ColumnFilter component (see
// src/components/shared/ColumnFilter.jsx) — passed explicitly at every call site on this page so
// its popover keeps this page's dark-glass look instead of falling back to the shared component's
// default (the app's normal theme-aware T tokens, which every other page uses unmodified). A
// solid "#0d1220", not HZ.surface's translucent glass fill — a translucent popover floating over
// table rows read muddy in practice; every other Trade Horizon popover-style surface on this page
// (chart tooltips) already made the same call.
const HZ_FILTER_TOKENS = {
  bg: "#0d1220", border: HZ.border, borderSoft: HZ.borderSoft,
  ink: HZ.ink, inkMuted: HZ.inkMuted, accent: HZ.gradCyan[0],
  fontMono: HZ.fontMono, fontBody: HZ.fontBody,
};

const hzGradientFor = code => {
  const grads = [HZ.gradCyan, HZ.gradAmber, HZ.gradViolet];
  let hash = 0;
  for (let i = 0; i < (code || "").length; i++) hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  return grads[hash % grads.length];
};

// One-time Google Fonts <link> injection — this app has no build-time font pipeline (CLAUDE.md's
// own CSP note: fonts.googleapis.com/fonts.gstatic.com are already allowlisted for exactly this
// pattern elsewhere). Guarded by id so remounting this page never duplicates the tag.
const useHorizonFonts = () => {
  useEffect(() => {
    if (document.getElementById("hz-fonts")) return;
    const link = document.createElement("link");
    link.id = "hz-fonts"; link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap";
    document.head.appendChild(link);
  }, []);
};

// Decorative backdrop only (trade-route arcs + ambient glow + sparkle accents) — absolute,
// anchored to a position:relative wrapper, never `position: fixed`. Fixed positioning both mis-
// renders under this app's own confirmed full-page-screenshot artifact (App.jsx's footer bar hit
// this exact issue) and is simply wrong for a scrollable in-page section — it would stay pinned
// to the viewport instead of scrolling with the Dashboard's own content. Inert to pointer events
// so it can never intercept a real click.
const HorizonBackdrop = () => (
  <div aria-hidden="true" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 560, zIndex: 0, pointerEvents: "none", overflow: "hidden" }}>
    <svg width="100%" height="560" viewBox="0 0 1440 560" preserveAspectRatio="xMidYMin slice" style={{ position: "absolute", opacity: 0.6 }}>
      <path d="M -40 300 Q 320 150 640 230 T 1480 120" fill="none" stroke="url(#hzRoute)" strokeWidth="1.3" strokeDasharray="1 7" strokeLinecap="round" />
      <path d="M -40 400 Q 420 280 820 340 T 1480 240" fill="none" stroke="url(#hzRoute)" strokeWidth="1.3" strokeDasharray="1 7" strokeLinecap="round" />
      <defs>
        <linearGradient id="hzRoute" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#38d4e8" stopOpacity="0.6" />
          <stop offset="50%" stopColor="#9085e9" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#fbc531" stopOpacity="0.55" />
        </linearGradient>
      </defs>
    </svg>
    <div style={{ position: "absolute", width: 600, height: 600, top: -240, left: -140, borderRadius: "50%", filter: "blur(80px)", background: "radial-gradient(circle, rgba(56,212,232,0.22), transparent 68%)" }} />
    <div style={{ position: "absolute", width: 560, height: 560, top: 0, right: -200, borderRadius: "50%", filter: "blur(80px)", background: "radial-gradient(circle, rgba(213,81,159,0.18), transparent 68%)" }} />
  </div>
);

const CHART_COLORS = HZ.chartCategorical.concat([
  "#6366f1","#8b5cf6","#06b6d4","#ef4444","#10b981","#f97316",
]);

// ─── Sparkline ────────────────────────────────────────────────────────────────

const Sparkline = ({ data = [], color = "#888", width = 76, height = 26 }) => {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1);
  const pad = 3;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - v / max) * (height - pad * 2);
    return [x, y];
  });
  const pathD = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
      <path d={pathD} fill="none" stroke={color} strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round" opacity={0.7} />
      <circle cx={lx} cy={ly} r={2.5} fill={color} />
    </svg>
  );
};

// ─── Delta badge ──────────────────────────────────────────────────────────────

const DeltaBadge = ({ delta, prevTEU }) => {
  if (delta === null || delta === undefined) return null;
  if (prevTEU === 0 && delta === 0) return (
    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.border }}>no prev data</span>
  );
  const color = delta > 5 ? T.success : delta < -5 ? T.danger : T.textMuted;
  const arrow = delta > 5 ? "↑" : delta < -5 ? "↓" : "→";
  return (
    <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, color,
      display: "flex", alignItems: "center", gap: 2 }}>
      {arrow} {delta > 0 ? "+" : ""}{delta}%
      <span style={{ fontWeight: 400, color: T.border, marginLeft: 2, fontSize: 9.5 }}>vs prev</span>
    </span>
  );
};

// ─── KPI tile (shared: Overview 3-tile row + Margin 4-tile row) ───────────────
// One shared shape instead of two bespoke ones (Overview's old plain-color number,
// MarginView's old marginColor() background+border) — a tile only gets a tinted left
// edge + soft corner glow when tintColor is actually passed (undefined/null renders
// neither, matching "Total Allocated/Buy/Sell get no tint" — those aren't utilization
// figures). zIndex:-1 on the glow is required, not optional: an absolutely-positioned
// z-index:auto child paints ABOVE normal-flow siblings per CSS painting order, so
// without it the glow would sit on top of the label/number instead of behind them.
const KpiTile = ({ label, value, caption, tintColor, unit, breakdown }) => {
  const display = typeof value === "number" ? value.toLocaleString("en-US") : value;
  return (
    <div style={{ position: "relative", overflow: "hidden", background: HZ.surface, backdropFilter: "blur(18px)",
      border: `1px solid ${HZ.border}`, borderRadius: 16, padding: "18px 20px",
      borderLeft: `3px solid ${tintColor || "transparent"}` }}>
      {tintColor && (
        <div style={{ position: "absolute", top: -46, right: -36, width: 130, height: 130,
          borderRadius: "50%", zIndex: -1,
          background: `radial-gradient(circle, ${tintColor}25 0%, transparent 72%)` }} />
      )}
      <div style={{ fontFamily: HZ.fontBody, fontSize: 10.5, color: HZ.inkMuted, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: ".08em" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, margin: "9px 0 3px" }}>
        <span style={{ fontFamily: HZ.fontDisplay, fontSize: 28, fontWeight: 700, color: HZ.ink }}>{display}</span>
        {unit && <span style={{ fontFamily: HZ.fontMono, fontSize: 12, color: HZ.inkMuted }}>{unit}</span>}
      </div>
      <div style={{ fontFamily: HZ.fontBody, fontSize: 11.5, color: HZ.inkMuted }}>{caption}</div>
      {breakdown && (breakdown.pending > 0 || breakdown.rejected > 0) && (
        <div style={{ fontFamily: HZ.fontMono, fontSize: 10.5, marginTop: 5 }}>
          {breakdown.pending > 0 && <span style={{ color: HZ.warning }}>+{breakdown.pending} pending</span>}
          {breakdown.pending > 0 && breakdown.rejected > 0 && <span style={{ color: HZ.inkMuted }}> · </span>}
          {breakdown.rejected > 0 && <span style={{ color: HZ.critical }}>+{breakdown.rejected} rejected</span>}
        </div>
      )}
    </div>
  );
};

// ─── Consumption ring (Trade Horizon hero stat) ───────────────────────────────
// Replaces the plain "Confirmed Consumption" KpiTile as the Overview tab's hero element — an SVG
// circular progress ring is this direction's single most defining piece. Legend colors are the
// real, reserved status palette (HZ.good/warning/critical), never the decorative ring gradient —
// a status color must never double as this ring's cosmetic gradient (dataviz skill's own rule).
const KpiRing = ({ pct, confirmed, pending, rejected, remaining }) => {
  const r = 56, circ = 2 * Math.PI * r;
  const offset = circ - (Math.min(100, pct) / 100) * circ;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: 132, height: 132, flexShrink: 0 }}>
        <svg width="132" height="132" viewBox="0 0 132 132" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="66" cy="66" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="14" />
          <circle cx="66" cy="66" r={r} fill="none" stroke="url(#hzRingGrad)" strokeWidth="14"
            strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" />
          <defs>
            <linearGradient id="hzRingGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={HZ.gradCyan[0]} /><stop offset="100%" stopColor={HZ.gradCyan[1]} />
            </linearGradient>
          </defs>
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontFamily: HZ.fontDisplay, fontSize: 28, fontWeight: 700, color: HZ.ink }}>
            {pct.toFixed(1)}<span style={{ fontSize: 14 }}>%</span>
          </div>
          <div style={{ fontFamily: HZ.fontMono, fontSize: 10, color: HZ.inkMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>utilized</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9, flex: 1, minWidth: 160 }}>
        {[
          ["Confirmed", confirmed, HZ.good], ["Pending", pending, HZ.warning],
          ["Rejected", rejected, HZ.critical], ["Remaining", remaining, "rgba(255,255,255,0.2)"],
        ].map(([label, val, color]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 3, background: color, flexShrink: 0 }} />
            <span style={{ color: HZ.inkMuted, flex: 1, fontFamily: HZ.fontBody }}>{label}</span>
            <span style={{ fontFamily: HZ.fontMono, fontWeight: 600, color: HZ.ink }}>{val.toLocaleString("en-US")} TEU</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Carrier badge grid (Trade Horizon) ────────────────────────────────────────
// Gradient assigned deterministically per carrier code (hash → one of 3 decorative gradient
// pairs) since real carrier lists are data-driven, unlike the mockup's 3 hardcoded examples.
const CarrierBadgeGrid = ({ rows }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 10 }}>
    {rows.map(r => {
      const [g1, g2] = hzGradientFor(r.carrier);
      return (
        <div key={r.carrier} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7,
          padding: "14px 8px", background: "rgba(255,255,255,0.03)", border: `1px solid ${HZ.borderSoft}`, borderRadius: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: HZ.fontDisplay, fontWeight: 700, fontSize: 12, color: "#06111f",
            background: `linear-gradient(145deg, ${g1}, ${g2})` }}>
            {r.carrier.slice(0, 2)}
          </div>
          <div style={{ fontFamily: HZ.fontMono, fontSize: 11, fontWeight: 600, color: HZ.inkMuted }}>{r.carrier}</div>
          <div style={{ fontFamily: HZ.fontDisplay, fontSize: 13, fontWeight: 700, color: HZ.ink }}>{r.total.toLocaleString("en-US")} TEU</div>
        </div>
      );
    })}
  </div>
);

// ─── Carrier filter empty state (Overview tab, carrierFilter explicitly cleared to []) ─────────
// Shared by the main DashboardPage component (in place of the bento-grid hero) and
// MatchedShipmentsTable (in place of its row list) — both need identical copy, defined once here
// since they're separate components in this same module.
const NO_CARRIERS_SELECTED_MESSAGE = "No information available, please select at least one value to showcase the data.";
const NoCarriersSelected = ({ minHeight = 140 }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight,
    fontFamily: HZ.fontBody, fontSize: 13, color: HZ.inkMuted, textAlign: "center", padding: 24 }}>
    {NO_CARRIERS_SELECTED_MESSAGE}
  </div>
);

// ─── Carrier performance row (Total Allocated card — confirmation-rate ranking) ────────────────
const PerfRow = ({ rank, carrier, rate }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
    {rank != null && <span style={{ fontFamily: HZ.fontMono, fontSize: 10, color: HZ.inkFaint, width: 10 }}>{rank}</span>}
    <span style={{ fontFamily: HZ.fontMono, fontWeight: 600, color: HZ.ink, flex: 1 }}>{carrier}</span>
    <span style={{ fontFamily: HZ.fontMono, fontWeight: 700,
      color: rate >= 80 ? HZ.good : rate >= 50 ? HZ.warning : HZ.critical }}>
      {rate.toFixed(0)}%
    </span>
  </div>
);

// ─── Tab button (Dashboard tab bar) ────────────────────────────────────────────
const TAB_ICONS = {
  overview: IconDashboard, contracts: IconFileCertificate, carriers: IconShip,
  margin: IconCoin, compliance: IconWarning,
};

const TabButton = ({ tab, active, onClick }) => {
  const [hov, setHov] = useState(false);
  const TabIcon = TAB_ICONS[tab.key];
  return (
    <button type="button" onClick={onClick} data-testid={`dashboard-tab-${tab.key}`}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        padding: "10px 16px", background: active ? "rgba(56,212,232,0.12)" : hov ? "rgba(255,255,255,0.05)" : "none",
        border: "none", borderRadius: "10px 10px 0 0",
        borderBottom: active ? `2px solid ${HZ.gradCyan[0]}` : "2px solid transparent",
        color: active ? HZ.gradCyan[0] : hov ? HZ.ink : HZ.inkMuted,
        fontFamily: HZ.fontBody, fontSize: 13, fontWeight: 600,
        cursor: "pointer", marginBottom: -1,
        transition: "background .15s, color .15s, border-color .15s",
        display: "flex", alignItems: "center", gap: 7,
      }}>
      {TabIcon && <TabIcon size={14} />}
      {tab.label}
      {tab.count != null && tab.count > 0 && (
        <span style={{
          background: HZ.critical, color: "#fff",
          fontFamily: HZ.fontMono, fontSize: 10, fontWeight: 700,
          borderRadius: 10, padding: "1px 6px", lineHeight: "16px",
        }}>
          {tab.count}
        </span>
      )}
    </button>
  );
};

// ─── Filter select (Status/Booking filter bars — Overview, Contract Consumption,
// Compliance Review tabs) — a plain <select style={inputBase}> pairing, not the Sel
// primitive (its own label block is too tall for an inline filter bar). Built as a
// component (not a hoisted style object) so its inputBase spread re-resolves T's
// live theme values on every render rather than freezing them at module load.
const FilterSelect = ({ label, value, onChange, options }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <label style={{ fontFamily: T.body, fontSize: 9.5, fontWeight: 700, color: T.textMuted,
      textTransform: "uppercase", letterSpacing: ".08em" }}>{label}</label>
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ ...inputBase, width: "auto", padding: "6px 10px", fontFamily: T.mono,
        fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>
      <option value="All">All</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  </div>
);

// Every column's filter definition in display order, including Carrier (isCarrier: true — its
// state is owned by the parent DashboardPage, not local to this table, since it also drives the
// ring/badges/charts above; see the Overview call site). The other seven are local-only display
// filters, replacing what used to be two separate Status/Booking <select> dropdowns with the same
// per-column mechanism applied uniformly.
const TABLE_COLUMNS = [
  { key: "id",       label: "Shipment ID",  getValue: r => r.id },
  { key: "route",    label: "POL → POD",    getValue: r => `${r.pol} → ${r.pod}` },
  { key: "carrier",  label: "Carrier",      isCarrier: true },
  { key: "contract", label: "Contract",     getValue: r => r.contractType },
  { key: "space",    label: "Space Config", getValue: r => (r.alloc ? `${r.alloc.pol} → ${r.alloc.pod}` : "No config match") },
  { key: "teu",      label: "TEU",          getValue: r => String(r.teu) },
  { key: "status",   label: "Status",       getValue: r => r.status },
  { key: "booking",  label: "Booking",      getValue: r => r.bookingStatus || "—" },
];

// ─── Matched Shipments Table (Overview tab) ───────────────────────────────────

// Bug fix (found live via exploratory QA, 2026-09): this used to match a shipment to a space
// config by carrier+pol/pod alone, the same heuristic already replaced everywhere else on this
// page (consumedMap, chartData, carrierTrends, ContractConsumptionView — see their own "2026-09
// Space Configuration spec, gap #1" comments) because it can both false-positive (a shipment that
// merely resembles a match but was never actually linked, so it contributes 0 to that config's
// real totals) and false-negative (a shipment linked via a linked-port equivalence the heuristic
// doesn't understand shows "No config match" even though it genuinely is one). Verified live on
// real shipments both ways. Now keyed off the same allocationId link everywhere else on this page
// already uses.
export const MatchedShipmentsTable = ({
  shipments, containers, carriers, activeAllocations, teuDefs,
  carrierFilter = null, availableCarriers = null, onCarrierFilterChange = () => {},
}) => {
  // Falls back to deriving its own candidate list from `shipments` when the caller doesn't pass
  // one (e.g. the direct-render unit test) — the Overview call site passes the real one, computed
  // from the UN-filtered row set so an excluded carrier stays selectable.
  const carrierOptions = availableCarriers ?? [...new Set(shipments.map(s => s.carrierCode))].sort();
  const rows = useMemo(() => shipments.map(s => {
    const teu     = containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size, c.type, teuDefs), 0);
    const carrier = carriers.find(c => c.code === s.carrierCode);
    const alloc   = s.allocationId ? activeAllocations.find(a => a.id === s.allocationId) : null;
    return { ...s, teu, carrier, alloc };
  }), [shipments, activeAllocations, containers, carriers, teuDefs]);

  // Display-layer filters only — layered on top of the allocationId-matched `rows` above, never a
  // substitute for that matching. Keyed by column key; a missing/null entry means "no filter" for
  // that column, an array is the chosen subset (same convention as the Carrier filter above it —
  // an empty array is a real, deliberate "show nothing", not the same as "no filter").
  const [colFilters, setColFilters] = useState({});
  const setColFilter = (key, value) => setColFilters(prev => ({ ...prev, [key]: value }));
  const localColumns = TABLE_COLUMNS.filter(c => !c.isCarrier);

  // Each column's own checklist is built from the full, un-filtered-by-any-column row set — same
  // precedent as the Carrier filter's own available list — so unchecking a value never removes it
  // from its own filter's future options.
  const availableByColumn = useMemo(() => {
    const out = {};
    localColumns.forEach(col => {
      out[col.key] = [...new Set(rows.map(col.getValue))].sort((a, b) => {
        const na = Number(a), nb = Number(b);
        return !Number.isNaN(na) && !Number.isNaN(nb) ? na - nb : a.localeCompare(b);
      });
    });
    return out;
  }, [rows]);

  const filteredRows = useMemo(() => rows.filter(r =>
    localColumns.every(col => {
      const sel = colFilters[col.key];
      return sel == null || sel.includes(col.getValue(r));
    })
  ), [rows, colFilters]);

  const [offset, setOffset] = useState(0);
  const [limit,  setLimit]  = useState(getStoredPageSize);
  // A changed date range or filter can shrink the result set below whatever page was showing.
  useEffect(() => { setOffset(0); }, [filteredRows]);
  const pageRows = filteredRows.slice(offset, offset + limit);

  const { template: COL, startResize } = useResizableColumns("dashboard-matched-shipments", [130, 120, 120, 110, 140, 48, 90, 90]);

  return (
    <div data-testid="matched-shipments-table" style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)", overflow: "hidden" }}>
      <div style={{ padding: "15px 20px", borderBottom: `1px solid ${T.border}` }}>
        <h2 style={{ fontFamily: HZ.fontDisplay, fontSize: 17, fontWeight: 600, color: HZ.ink, margin: 0 }}>
          Shipments in Period
        </h2>
        <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "2px 0 0" }}>
          {shipments.length} shipment{shipments.length !== 1 ? "s" : ""} with ETD in range — correlated to active space configurations
        </p>
      </div>

      {/* The header row — and with it every column's filter trigger — always renders, independent
          of whether there's any data below it. It's the only way back out of an empty-selection
          state below (all-carriers-cleared or any other column filtered to nothing), so it can't
          be part of a branch that state replaces (that was the earlier bug: Clear used to remove
          the very control needed to undo it). Column filters used to be two separate Status/
          Booking <select> dropdowns here; replaced by the same per-column mechanism every other
          column now uses. */}
      <div style={{ display: "grid", gridTemplateColumns: COL,
        padding: "9px 20px", borderBottom: `1px solid ${T.border}` }}>
        {TABLE_COLUMNS.map((col, i) => (
          <div key={col.key} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5,
            fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
            {col.isCarrier ? (
              <ColumnFilter label="Carrier" available={carrierOptions} selected={carrierFilter}
                onChange={onCarrierFilterChange} describe={code => carriers.find(c => c.code === code)?.name || ""}
                tokens={HZ_FILTER_TOKENS} />
            ) : (
              <ColumnFilter label={col.label} available={availableByColumn[col.key]}
                selected={colFilters[col.key] ?? null} onChange={v => setColFilter(col.key, v)}
                tokens={HZ_FILTER_TOKENS} />
            )}
            {i < TABLE_COLUMNS.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
          </div>
        ))}
      </div>

      {Array.isArray(carrierFilter) && carrierFilter.length === 0 ? (
        <NoCarriersSelected minHeight={120} />
      ) : shipments.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
          No shipments with ETD in this period. Adjust the date range or create new shipments.
        </div>
      ) : filteredRows.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
          No shipments match the selected filters.
        </div>
      ) : (
        <>
          {pageRows.map(s => (
            <div key={s.id} data-testid={`shipment-row-${s.id}`}
              style={{ display: "grid", gridTemplateColumns: COL,
                padding: "12px 20px", borderBottom: `1px solid ${T.border}22`,
                alignItems: "center", transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textCode, fontWeight: 700 }}>{s.id}</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{s.pol} → {s.pod}</span>
              <div>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{s.carrierCode}</span>
                {s.carrier && <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}> · {s.carrier.name}</span>}
              </div>
              <Badge variant={contractVariant(s.contractType)}>{s.contractType}</Badge>
              {s.alloc ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={{ fontFamily: T.body, fontSize: 10, color: T.success, fontWeight: 600 }}>● Matched</span>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                    {s.alloc.pol} › {s.alloc.pod} · {s.alloc.allocatedTEU} TEU
                  </span>
                </div>
              ) : (
                <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>No config match</span>
              )}
              <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.text }}>{s.teu}</span>
              <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
              {s.bookingStatus
                ? <Badge variant={BOOKING_STATUS_VARIANT[s.bookingStatus] || "default"}>{s.bookingStatus}</Badge>
                : <span style={{ fontFamily: T.body, fontSize: 10, color: T.border }}>—</span>}
            </div>
          ))}
          <div style={{ padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <PageSizeSelect value={limit} onChange={n => { setLimit(n); setOffset(0); }} />
            <div style={{ flex: 1 }}><Pagination total={filteredRows.length} offset={offset} limit={limit} onPage={setOffset} /></div>
          </div>
        </>
      )}
    </div>
  );
};

// ─── Contract Consumption View (Contract tab) ─────────────────────────────────

const ContractConsumptionView = ({ rangeShipments, containers, carriers, allocations = [], contractTrendData, teuDefs }) => {
  const [contractMap, setContractMap] = useState({});
  const [loading,     setLoading]     = useState(false);
  // Display-layer filter for "Shipments by Contract" below — applied once, per contract
  // group's own shipment list, not duplicated per card. Does not touch allocByContract/
  // consumedByContract/chartRows (the charts above stay date-range-scoped only, untouched).
  const [statusFilter, setStatusFilter]   = useState("All");
  const [bookingFilter, setBookingFilter] = useState("All");

  const centralShipments = useMemo(() =>
    rangeShipments.filter(s => s.contractType === "Central" && s.contractId),
    [rangeShipments]
  );

  const groups = useMemo(() => {
    const m = {};
    centralShipments.forEach(s => {
      if (!m[s.contractId]) m[s.contractId] = {
        contractId: s.contractId, contractRef: s.contractRef,
        carrierCode: s.carrierCode, shipments: [],
      };
      m[s.contractId].shipments.push(s);
    });
    return Object.values(m);
  }, [centralShipments]);

  // Allocated TEU per contract from space configs
  const allocByContract = useMemo(() => {
    const m = {};
    allocations.forEach(a => {
      if (!a.contractId) return;
      m[a.contractId] = (m[a.contractId] || 0) + a.allocatedTEU;
    });
    return m;
  }, [allocations]);

  // TEU per contract from shipments, bucketed by booking status — same rule as loadTeuBuckets()
  // (routes/allocations.js): only a Confirmed booking counts as real consumption; Pending covers
  // Created/Pending/no-booking-row-yet; Rejected is its own bucket; Cancelled is excluded
  // entirely. Matched to a contract via the shipment's own allocationId -> that allocation's
  // contractId (exactly what loadTeuBuckets keys off), NOT the old carrier+contract+lane
  // heuristic — this page used to be able to disagree with the Space Configurations page's own
  // per-allocation figures for the same contract (2026-09 Space Configuration spec, gap #1: a
  // shipment matching by attributes alone but never actually linked via allocationId would count
  // here and not there, or vice versa). Date-range scoping (this view's own distinct value) is
  // unchanged — only the matching key changed.
  const allocationToContract = useMemo(() => {
    const m = new Map();
    allocations.forEach(a => { if (a.contractId) m.set(a.id, a.contractId); });
    return m;
  }, [allocations]);

  const consumedByContract = useMemo(() => {
    const m = {};
    centralShipments.forEach(s => {
      if (!s.allocationId || !allocationToContract.has(s.allocationId)) return;
      const contractId = allocationToContract.get(s.allocationId);
      const teu = containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size, c.type, teuDefs), 0);
      const bucket = m[contractId] || (m[contractId] = { confirmed: 0, pending: 0, rejected: 0 });
      if (s.bookingStatus === "Confirmed") bucket.confirmed += teu;
      else if (s.bookingStatus === "Rejected") bucket.rejected += teu;
      else if (s.bookingStatus === "Cancelled") { /* excluded — no live demand left */ }
      else bucket.pending += teu; // Created, Pending, or no carrier_bookings row yet
    });
    return m;
  }, [centralShipments, containers, allocationToContract, teuDefs]);

  const emptyBucket = { confirmed: 0, pending: 0, rejected: 0 };

  // Chart rows — union of contracts from allocations + shipments, sorted by utilisation desc
  const chartRows = useMemo(() => {
    const ids = new Set([
      ...Object.keys(allocByContract),
      ...Object.keys(consumedByContract),
    ]);
    return Array.from(ids).map(id => {
      const alloc    = allocations.find(a => a.contractId === id);
      const group    = groups.find(g => g.contractId === id);
      const contract = contractMap[id] || null; // populated async by the useEffect below
      const allocated = allocByContract[id] || 0;
      const b         = consumedByContract[id] || emptyBucket;
      const pct       = allocated > 0 ? Math.round((b.confirmed / allocated) * 100) : null;
      return {
        contractId:     id,
        contractNumber: contract?.contractNumber || alloc?.contractNumber || group?.contractRef || id,
        carrierCode:    contract?.carrierCode    || alloc?.carrierCode    || group?.carrierCode || "",
        allocated, confirmed: b.confirmed, pending: b.pending, rejected: b.rejected, pct,
      };
    }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  }, [allocByContract, consumedByContract, allocations, groups, contractMap]);

  useEffect(() => {
    // Fetch contract details for all IDs visible in the chart (shipment groups + allocation-only contracts)
    const allIds = [
      ...groups.map(g => g.contractId),
      ...Object.keys(allocByContract),
    ];
    const missing = [...new Set(allIds)].filter(id => !contractMap[id]);
    if (!missing.length) return;
    setLoading(true);
    Promise.all(missing.map(id => api.contracts.get(id).catch(() => null)))
      .then(results => {
        setContractMap(prev => {
          const next = { ...prev };
          results.forEach(c => { if (c) next[c.id] = c; });
          return next;
        });
      })
      .finally(() => setLoading(false));
  }, [groups, allocByContract]); // eslint-disable-line react-hooks/exhaustive-deps

  const teuFor = s => containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size, c.type, teuDefs), 0);

  const SHP_COL = "140px 130px 90px 48px 90px 90px";
  const SHP_HDR = ["Shipment ID", "POL → POD", "ETD", "TEU", "Status", "Booking"];

  if (centralShipments.length === 0) {
    return (
      <div>
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ fontFamily: HZ.fontDisplay, fontSize: 19, fontWeight: 600, color: HZ.ink, margin: 0 }}>Contract Consumption</h2>
          <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "3px 0 0" }}>
            Central shipments in the selected period, grouped by contract
          </p>
        </div>
        <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)",
          padding: 48, textAlign: "center" }}>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted, marginBottom: 8 }}>
            No Central shipments in this period.
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>
            Shipments must have contract type "Central" and a linked system contract to appear here.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontFamily: HZ.fontDisplay, fontSize: 19, fontWeight: 600, color: HZ.ink, margin: 0 }}>Contract Consumption</h2>
        <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "3px 0 0" }}>
          {groups.length} contract{groups.length !== 1 ? "s" : ""} · {centralShipments.length} Central shipment{centralShipments.length !== 1 ? "s" : ""} in range
        </p>
      </div>

      {/* ── Charts row ── */}
      {(chartRows.length > 0 || contractTrendData?.contractIds?.length > 0) && (
        <div style={{ display: "grid",
          gridTemplateColumns: contractTrendData?.contractIds?.length > 0 ? "1fr 1fr" : "1fr",
          gap: 16, marginBottom: 18 }}>

          {/* Left: allocated vs consumed bars */}
          {chartRows.length > 0 && (
            <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)",
              padding: "18px 20px" }}>
              <div style={{ marginBottom: 14 }}>
                <h2 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: "0 0 3px" }}>
                  Allocated vs Confirmed TEU
                </h2>
                <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>
                  Contract-level rollup for the selected date range — sums every one of this
                  contract's space configurations, scoped to shipments actually linked to them
                  (same allocationId match the Space Configurations page itself uses), just
                  restricted to this date range and rolled up per contract instead of per config.
                  Only a Confirmed booking counts as consumed; Pending and Rejected are shown
                  alongside, not folded in.
                </p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10,
                maxHeight: 260, overflowY: "auto" }}>
                {chartRows.map(row => (
                  <div key={row.contractId} style={{ display: "grid",
                    gridTemplateColumns: "160px 1fr 120px", gap: 10, alignItems: "center" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.accent,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.contractNumber}
                      </div>
                      {row.carrierCode && (
                        <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, marginTop: 1 }}>
                          {row.carrierCode}
                        </div>
                      )}
                    </div>
                    <ConsumptionBar allocated={row.allocated} confirmed={row.confirmed}
                      pending={row.pending} rejected={row.rejected} height={16} width="100%" />
                    <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.text }}>
                        {row.confirmed}
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                        {" / "}{row.allocated > 0 ? row.allocated : "—"} TEU
                      </span>
                      {row.pct !== null && (
                        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
                          marginLeft: 5, background: T.border + "22",
                          border: `1px solid ${T.border}`,
                          borderRadius: 3, padding: "0 4px" }}>
                          {row.pct}%
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 12, marginTop: 14, paddingTop: 12,
                borderTop: `1px solid ${T.border}22`, flexWrap: "wrap" }}>
                {[
                  { color: T.success, label: "Confirmed" },
                  { color: T.warning, label: "Pending" },
                  { color: T.danger,  label: "Rejected" },
                ].map(({ color, label }) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Right: 6-week trend by contract */}
          {contractTrendData?.contractIds?.length > 0 && (
            <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)",
              padding: "20px 20px 14px" }}>
              <div style={{ marginBottom: 16 }}>
                <h2 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: "0 0 3px" }}>
                  6-Week TEU Trend
                </h2>
                <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>
                  Weekly Confirmed consumption per contract — last 6 weeks
                </p>
              </div>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={contractTrendData.weeks} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                  <XAxis dataKey="week" tick={{ fontFamily: T.mono, fontSize: 10, fill: T.textMuted }}
                    axisLine={{ stroke: T.border }} tickLine={false} />
                  <YAxis tick={{ fontFamily: T.body, fontSize: 10, fill: T.textMuted }}
                    axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: "#0d1220", border: `1px solid ${HZ.border}`, borderRadius: 12, fontFamily: HZ.fontBody, fontSize: 12 }}
                    labelStyle={{ color: T.text, fontWeight: 600, marginBottom: 4 }}
                    itemStyle={{ color: T.textMuted }}
                    formatter={(v, name) => [`${v} TEU`, contractTrendData.refMap[name] || name]}
                    cursor={{ stroke: T.border, strokeWidth: 1 }} />
                  <Legend
                    wrapperStyle={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, paddingTop: 10 }}
                    formatter={name => contractTrendData.refMap[name] || name} />
                  {contractTrendData.contractIds.map((id, i) => (
                    <Line key={id} type="monotone" dataKey={id}
                      stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2}
                      dot={{ r: 3, fill: CHART_COLORS[i % CHART_COLORS.length] }} activeDot={{ r: 5 }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 12, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: T.body, fontSize: 10.5,
          fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
          <span style={{ width: 3, height: 11, borderRadius: 2, background: T.accent, display: "inline-block" }} />
          Shipments by Contract
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <FilterSelect label="Status" value={statusFilter} onChange={setStatusFilter} options={STATUSES} />
          <FilterSelect label="Booking" value={bookingFilter} onChange={setBookingFilter} options={Object.keys(BOOKING_STATUS_VARIANT)} />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {groups.map(g => {
          const contract = contractMap[g.contractId];
          // Pure display-layer filter — applied to this group's own shipment list only,
          // the contract-level totals/bars above (allocByContract/consumedByContract/
          // chartRows) are untouched.
          const filteredShipments = g.shipments.filter(s =>
            (statusFilter === "All"  || s.status === statusFilter) &&
            (bookingFilter === "All" || s.bookingStatus === bookingFilter)
          );
          const groupBuckets = filteredShipments.reduce((acc, s) => {
            const teu = teuFor(s);
            if (s.bookingStatus === "Confirmed") acc.confirmed += teu;
            else if (s.bookingStatus === "Rejected") acc.rejected += teu;
            else if (s.bookingStatus === "Cancelled") { /* excluded */ }
            else acc.pending += teu;
            return acc;
          }, { confirmed: 0, pending: 0, rejected: 0 });
          const carrier  = carriers.find(c => c.code === g.carrierCode);

          return (
            <div key={g.contractId} style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, backdropFilter: "blur(16px)",
              borderRadius: 16, overflow: "hidden" }}>

              {/* Contract header */}
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T.border}`,
                background: T.accentBg, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 15, color: T.accent, fontWeight: 700 }}>
                    {contract?.contractNumber || g.contractRef || g.contractId}
                    {loading && !contract && (
                      <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontWeight: 400, marginLeft: 8 }}>
                        loading…
                      </span>
                    )}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
                    {g.carrierCode}{carrier ? ` · ${carrier.name}` : ""}
                    {contract && ` · Valid ${contract.validFrom} → ${contract.validTo}`}
                  </span>
                </div>

                {contract?.legs?.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {contract.legs.map((l, i) => (
                      <span key={i} style={{ fontFamily: T.mono, fontSize: 11, background: T.surface,
                        border: `1px solid ${T.border}`, borderRadius: 4, padding: "2px 8px", color: T.text }}>
                        {l.pol} → {l.pod}
                      </span>
                    ))}
                  </div>
                )}

                <div style={{ marginLeft: "auto", textAlign: "right" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, justifyContent: "flex-end" }}>
                    <span style={{ fontFamily: T.mono, fontSize: 26, fontWeight: 700, color: T.success }}>{groupBuckets.confirmed}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>TEU confirmed</span>
                  </div>
                  {(groupBuckets.pending > 0 || groupBuckets.rejected > 0) && (
                    <div style={{ fontFamily: T.mono, fontSize: 10.5 }}>
                      {groupBuckets.pending > 0 && <span style={{ color: T.warning }}>+{groupBuckets.pending} pending</span>}
                      {groupBuckets.pending > 0 && groupBuckets.rejected > 0 && <span style={{ color: T.textMuted }}> · </span>}
                      {groupBuckets.rejected > 0 && <span style={{ color: T.danger }}>+{groupBuckets.rejected} rejected</span>}
                    </div>
                  )}
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                    {filteredShipments.length} shipment{filteredShipments.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </div>

              {/* Shipments under this contract */}
              <div style={{ display: "grid", gridTemplateColumns: SHP_COL,
                padding: "8px 20px", borderBottom: `1px solid ${T.border}` }}>
                {SHP_HDR.map(h => (
                  <span key={h} style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600,
                    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
                ))}
              </div>
              {filteredShipments.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: T.textMuted,
                  fontFamily: T.body, fontSize: 12.5, fontStyle: "italic" }}>
                  No shipments in this contract match the selected filters.
                </div>
              ) : filteredShipments.map(s => (
                <div key={s.id}
                  style={{ display: "grid", gridTemplateColumns: SHP_COL,
                    padding: "10px 20px", borderBottom: `1px solid ${T.border}22`,
                    alignItems: "center", transition: "background .1s" }}
                  onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textCode, fontWeight: 700 }}>{s.id}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{s.pol} → {s.pod}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{s.etd || "—"}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{teuFor(s)}</span>
                  <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                  {s.bookingStatus
                    ? <Badge variant={BOOKING_STATUS_VARIANT[s.bookingStatus] || "default"}>{s.bookingStatus}</Badge>
                    : <span style={{ fontFamily: T.body, fontSize: 10, color: T.border }}>—</span>}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Margin tab ───────────────────────────────────────────────────────────────

const fmtUsd = v => v == null ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const marginColor = pct => pct == null ? T.textMuted : pct >= 20 ? T.success : pct >= 10 ? T.warning : T.danger;
// Multi-Entity Accounting (TKT-EEV4I9) — a per-entity figure is in that entity's own reporting
// currency, not always USD, so it needs its own symbol-less formatter (fmtUsd's literal "$"
// would misrepresent a EUR/GBP/etc. entity total).
const fmtCcy = (v, ccy) => v == null ? "—" : `${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ${ccy}`;

const MarginView = ({ financeEnabled }) => {
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [exporting, setExporting] = useState(null); // "xlsx" | "template" | null
  // Organization Model Enhancement Epic 4 — off by default (each customer record's own margin
  // stays the primary view); toggling on re-fetches with the same grouping /api/margin/summary
  // itself does server-side, so a multinational shipper's regional accounts sum into one row.
  const [groupByParent, setGroupByParent] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.margin.summary(groupByParent)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [groupByParent]);

  const handleExport = async (mode) => {
    setExporting(mode);
    try {
      if (mode === "xlsx")     await api.export.dashboardXlsx();
      if (mode === "template") await api.export.dashboardTemplate();
    } catch (e) {
      // Import toast lazily to avoid circular-dep risk
      const { toast: t } = await import("../toast");
      t.error(e.message);
    } finally {
      setExporting(null);
    }
  };

  if (loading) return (
    <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
      Loading margin data…
    </div>
  );

  const noData = !data || (data.byCarrier.length === 0 && data.byLane.length === 0);

  const pct  = data?.grossMarginPct ?? null;
  const col  = marginColor(pct);

  const TrendChart = ({ rows, dataKeys, title, subtitle }) => (
    <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)", padding: "20px 20px 14px" }}>
      <div style={{ marginBottom: 14 }}>
        <h3 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: "0 0 2px" }}>{title}</h3>
        <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>{subtitle}</p>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={rows} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
          <XAxis dataKey="week" tick={{ fontFamily: T.mono, fontSize: 10, fill: T.textMuted }} axisLine={{ stroke: T.border }} tickLine={false} />
          <YAxis tick={{ fontFamily: T.body, fontSize: 10, fill: T.textMuted }} axisLine={false} tickLine={false}
            tickFormatter={v => `${v}%`} domain={['auto', 'auto']} allowDecimals={false} />
          <ReferenceLine y={0} stroke={T.border} strokeDasharray="3 3" />
          <Tooltip contentStyle={{ background: "#0d1220", border: `1px solid ${HZ.border}`, borderRadius: 12, fontFamily: HZ.fontBody, fontSize: 12 }}
            labelStyle={{ color: T.text, fontWeight: 600, marginBottom: 4 }} itemStyle={{ color: T.textMuted }}
            formatter={(v, name) => [v != null ? `${v}%` : "—", name]} cursor={{ fill: `${T.accent}18` }} />
          <Legend wrapperStyle={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, paddingTop: 10 }} />
          {dataKeys.map((k, i) => (
            <Bar key={k} dataKey={k} name={k}
              fill={CHART_COLORS[i % CHART_COLORS.length]}
              radius={[3, 3, 0, 0]} maxBarSize={32} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );

  // Build carrier margin % trend: weeks × carrier
  const carrierWeekData = noData ? [] : (() => {
    const allWeeks = data.byCarrier[0]?.weeks || [];
    return allWeeks.map((w, wi) => {
      const pt = { week: w.week };
      data.byCarrier.forEach(c => {
        const wk = c.weeks[wi];
        if (wk?.totalSellUsd > 0) pt[c.carrierCode] = Math.round((wk.grossProfitUsd / wk.totalSellUsd) * 1000) / 10;
      });
      return pt;
    });
  })();

  // Build lane margin % trend: weeks × lane
  const laneWeekData = noData ? [] : (() => {
    const top5 = data.byLane.slice(0, 5);
    const allWeeks = top5[0]?.weeks || [];
    return allWeeks.map((w, wi) => {
      const pt = { week: w.week };
      top5.forEach(l => {
        const wk = l.weeks[wi];
        if (wk?.totalSellUsd > 0) pt[l.lane] = Math.round((wk.grossProfitUsd / wk.totalSellUsd) * 1000) / 10;
      });
      return pt;
    });
  })();

  const carrierKeys = noData ? [] : data.byCarrier.map(c => c.carrierCode);
  const laneKeys    = noData ? [] : data.byLane.slice(0, 5).map(l => l.lane);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontFamily: HZ.fontDisplay, fontSize: 19, fontWeight: 600, color: HZ.ink, margin: 0 }}>Margin Overview</h2>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>All time · base currency USD</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn size="sm" variant="ghost"
            disabled={exporting === "xlsx"}
            onClick={() => handleExport("xlsx")}>
            {exporting === "xlsx" ? "Generating…" : <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><IconArrowDown size={11} />XLSX (programmatic)</span>}
          </Btn>
          <Btn size="sm" variant="ghost"
            disabled={exporting === "template"}
            onClick={() => handleExport("template")}>
            {exporting === "template" ? "Generating…" : <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><IconArrowDown size={11} />XLSX (template)</span>}
          </Btn>
        </div>
      </div>

      {noData ? (
        <div style={{ padding: "48px 0", textAlign: "center", color: T.textMuted,
          fontFamily: T.body, fontSize: 14, fontStyle: "italic" }}>
          No cost lines recorded yet. Open a shipment and add BUY / SELL lines in Cost Control.
        </div>
      ) : <div>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 24 }}>
        <KpiTile label="Total Buy" caption="cost to carrier"
          value={financeEnabled ? fmtUsd(data.totalBuyUsd) : "••••"} />
        <KpiTile label="Total Sell" caption="revenue from customer"
          value={financeEnabled ? fmtUsd(data.totalSellUsd) : "••••"} />
        <KpiTile label="Gross Profit" caption="sell − buy"
          value={financeEnabled ? fmtUsd(data.grossProfitUsd) : "••••"}
          tintColor={data.grossProfitUsd >= 0 ? T.success : T.danger} />
        <KpiTile label="Gross Margin"
          value={pct != null ? `${pct}%` : "—"}
          tintColor={pct != null ? col : undefined}
          caption={pct == null ? "no sell lines" : pct >= 20 ? "healthy" : pct >= 10 ? "watch" : "below target"} />
      </div>

      {/* Trend charts */}
      {(carrierKeys.length > 0 || laneKeys.length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>
          {carrierKeys.length > 0 && (
            <TrendChart
              rows={carrierWeekData}
              dataKeys={carrierKeys}
              title="6-Week Margin Trend — By Carrier"
              subtitle="Gross margin % per carrier, rolling 6 weeks" />
          )}
          {laneKeys.length > 0 && (
            <TrendChart
              rows={laneWeekData}
              dataKeys={laneKeys}
              title="6-Week Margin Trend — By Trade Lane"
              subtitle="Gross margin % per lane (top 5), rolling 6 weeks" />
          )}
        </div>
      )}

      {/* Carrier breakdown table */}
      {data.byCarrier.length > 0 && (
        <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)", overflow: "hidden", marginBottom: 16 }}>
          <div style={{ padding: "13px 20px", borderBottom: `1px solid ${T.border}` }}>
            <h3 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: 0 }}>By Carrier</h3>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 1fr 1fr 80px",
            padding: "8px 20px", borderBottom: `1px solid ${T.border}` }}>
            {["Carrier","Buy (USD)","Sell (USD)","GP (USD)","Margin"].map((h, i) => (
              <div key={i} style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
                textTransform: "uppercase", letterSpacing: ".07em" }}>{h}</div>
            ))}
          </div>
          {data.byCarrier.map(c => {
            const cpct = c.grossMarginPct; const cc = marginColor(cpct);
            return (
              <div key={c.carrierCode}
                style={{ display: "grid", gridTemplateColumns: "100px 1fr 1fr 1fr 80px",
                  padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                  transition: "background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.accent }}>{c.carrierCode}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.warning }}>{financeEnabled ? fmtUsd(c.totalBuyUsd) : "••••"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.success }}>{financeEnabled ? fmtUsd(c.totalSellUsd) : "••••"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: c.grossProfitUsd >= 0 ? T.success : T.danger }}>
                  {financeEnabled ? `${c.grossProfitUsd >= 0 ? "+" : ""}${fmtUsd(c.grossProfitUsd)}` : "••••"}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: cc,
                  background: `${cc}18`, borderRadius: 6, padding: "2px 8px", border: `1px solid ${cc}33` }}>
                  {cpct != null ? `${cpct}%` : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Customer breakdown table (Organization Model Enhancement Epic 4) */}
      {data.byCustomer?.length > 0 && (
        <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)", overflow: "hidden", marginBottom: 16 }}>
          <div style={{ padding: "13px 20px", borderBottom: `1px solid ${T.border}`,
            display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: 0 }}>By Customer</h3>
            <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
              fontFamily: T.body, fontSize: 12, color: T.textMuted, userSelect: "none" }}>
              <input type="checkbox" checked={groupByParent} onChange={e => setGroupByParent(e.target.checked)}
                style={{ accentColor: T.accent, width: 13, height: 13 }} />
              Roll up by parent
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 80px",
            padding: "8px 20px", borderBottom: `1px solid ${T.border}` }}>
            {["Customer","Buy (USD)","Sell (USD)","GP (USD)","Margin"].map((h, i) => (
              <div key={i} style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
                textTransform: "uppercase", letterSpacing: ".07em" }}>{h}</div>
            ))}
          </div>
          {data.byCustomer.map(c => {
            const cpct = c.grossMarginPct; const cc = marginColor(cpct);
            return (
              <div key={c.customerId}
                style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 80px",
                  padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                  transition: "background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.customerName || "—"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.warning }}>{financeEnabled ? fmtUsd(c.totalBuyUsd) : "••••"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.success }}>{financeEnabled ? fmtUsd(c.totalSellUsd) : "••••"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: c.grossProfitUsd >= 0 ? T.success : T.danger }}>
                  {financeEnabled ? `${c.grossProfitUsd >= 0 ? "+" : ""}${fmtUsd(c.grossProfitUsd)}` : "••••"}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: cc,
                  background: `${cc}18`, borderRadius: 6, padding: "2px 8px", border: `1px solid ${cc}33` }}>
                  {cpct != null ? `${cpct}%` : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Entity breakdown table (Multi-Entity Accounting, TKT-EEV4I9) — a branch doubles as
          CargoDesk's legal-entity boundary; this is the one breakdown that also shows figures in
          the entity's own reporting currency alongside the USD figures every other breakdown
          uses, since that's the number a multi-entity user actually wants and the USD-only views
          don't give them. Only rendered when the shipment data actually resolves to an entity
          (every branch needs a country + an EMO/IMO office pointing at it) — a single-entity/
          single-branch deployment simply never sees this table, no configuration needed. */}
      {data.byEntity?.length > 0 && (
        <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)", overflow: "hidden", marginBottom: 16 }}>
          <div style={{ padding: "13px 20px", borderBottom: `1px solid ${T.border}` }}>
            <h3 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: 0 }}>By Entity</h3>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr 80px",
            padding: "8px 20px", borderBottom: `1px solid ${T.border}` }}>
            {["Entity","Buy (Local)","Sell (Local)","Buy (USD)","GP (USD)","Margin"].map((h, i) => (
              <div key={i} style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
                textTransform: "uppercase", letterSpacing: ".07em" }}>{h}</div>
            ))}
          </div>
          {data.byEntity.map(e => {
            const epct = e.grossMarginPct; const ec = marginColor(epct);
            return (
              <div key={e.entityId}
                style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr 80px",
                  padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                  transition: "background .1s" }}
                onMouseEnter={ev => ev.currentTarget.style.background = T.surfaceHover}
                onMouseLeave={ev => ev.currentTarget.style.background = "transparent"}>
                <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.entityName || "—"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.warning }}>{financeEnabled ? fmtCcy(e.localBuy, e.currency) : "••••"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.success }}>{financeEnabled ? fmtCcy(e.localSell, e.currency) : "••••"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{financeEnabled ? fmtUsd(e.totalBuyUsd) : "••••"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: e.grossProfitUsd >= 0 ? T.success : T.danger }}>
                  {financeEnabled ? `${e.grossProfitUsd >= 0 ? "+" : ""}${fmtUsd(e.grossProfitUsd)}` : "••••"}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: ec,
                  background: `${ec}18`, borderRadius: 6, padding: "2px 8px", border: `1px solid ${ec}33` }}>
                  {epct != null ? `${epct}%` : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}
      </div>}
    </div>
  );
};

// ─── Carrier Volumes tab ──────────────────────────────────────────────────────

const CarrierView = ({ rangeShipments, containers, carriers, carrierTrends, rangeStart }) => {
  const barData = useMemo(() => {
    const m = {};
    rangeShipments.forEach(s => {
      if (!s.carrierCode) return;
      const teu = containers
        .filter(c => c.shipmentId === s.id)
        .reduce((acc, c) => acc + teuOf(c.size), 0);
      if (teu > 0) m[s.carrierCode] = (m[s.carrierCode] || 0) + teu;
    });
    return Object.entries(m)
      .map(([code, teu]) => ({
        carrier: code,
        name: carriers.find(c => c.code === code)?.name || code,
        teu,
      }))
      .sort((a, b) => b.teu - a.teu);
  }, [rangeShipments, containers, carriers]);

  const trendData = useMemo(() =>
    Array.from({ length: 6 }, (_, i) => {
      const wStart  = addDays(rangeStart, -(5 - i) * 7);
      const weekEnd = addDays(wStart, 6);
      const label   = parseIso(weekEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      const pt = { week: label };
      barData.forEach(({ carrier: code }) => {
        pt[code] = carrierTrends[code]?.sparkData[i] ?? 0;
      });
      return pt;
    }),
    [carrierTrends, barData, rangeStart]
  );

  const totalTEU = barData.reduce((s, r) => s + r.teu, 0);

  if (barData.length === 0) return (
    <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14, fontStyle: "italic" }}>
      No shipments with containers in the selected period.
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 22 }}>
        <h2 style={{ fontFamily: HZ.fontDisplay, fontSize: 19, fontWeight: 600, color: HZ.ink, margin: 0 }}>Carrier Volumes</h2>
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>All shipments · by carrier code · TEU</span>
      </div>

      {/* Charts — side by side */}
      <div style={{ display: "grid", gridTemplateColumns: barData.length > 0 ? "1fr 1fr" : "1fr", gap: 16, marginBottom: 20 }}>

        {/* Bar chart */}
        <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)", padding: "20px 20px 14px" }}>
          <div style={{ marginBottom: 14 }}>
            <h3 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: "0 0 2px" }}>TEU by Carrier — Selected Period</h3>
            <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>Total: {totalTEU} TEU across {barData.length} carrier{barData.length !== 1 ? "s" : ""}</p>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={barData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
              <XAxis dataKey="carrier" tick={{ fontFamily: T.mono, fontSize: 11, fill: T.textMuted }} axisLine={{ stroke: T.border }} tickLine={false} />
              <YAxis tick={{ fontFamily: T.body, fontSize: 10, fill: T.textMuted }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: "#0d1220", border: `1px solid ${HZ.border}`, borderRadius: 12, fontFamily: HZ.fontBody, fontSize: 12 }}
                labelStyle={{ color: T.text, fontWeight: 600, marginBottom: 4 }}
                itemStyle={{ color: T.textMuted }}
                formatter={(v, _name, props) => [`${v} TEU`, props.payload.name || props.payload.carrier]}
                cursor={{ fill: `${T.accent}18` }} />
              <Bar dataKey="teu" name="TEU" fill={T.accent} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* 6-week trend line chart */}
        {barData.length > 0 && (
          <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)", padding: "20px 20px 14px" }}>
            <div style={{ marginBottom: 14 }}>
              <h3 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: "0 0 2px" }}>6-Week Volume Trend</h3>
              <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>TEU shipped per carrier, calendar-week aligned</p>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trendData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                <XAxis dataKey="week" tick={{ fontFamily: T.mono, fontSize: 10, fill: T.textMuted }} axisLine={{ stroke: T.border }} tickLine={false} />
                <YAxis tick={{ fontFamily: T.body, fontSize: 10, fill: T.textMuted }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: "#0d1220", border: `1px solid ${HZ.border}`, borderRadius: 12, fontFamily: HZ.fontBody, fontSize: 12 }}
                  labelStyle={{ color: T.text, fontWeight: 600, marginBottom: 4 }}
                  itemStyle={{ color: T.textMuted }}
                  formatter={(v, name) => [`${v} TEU`, name]}
                  cursor={{ stroke: T.border }} />
                <Legend wrapperStyle={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, paddingTop: 10 }} />
                {barData.map(({ carrier: code }, i) => (
                  <Line key={code} type="monotone" dataKey={code} name={code}
                    stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2}
                    dot={{ r: 3, fill: CHART_COLORS[i % CHART_COLORS.length] }}
                    activeDot={{ r: 5 }} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Ranking table */}
      <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)", overflow: "hidden" }}>
        <div style={{ padding: "13px 20px", borderBottom: `1px solid ${T.border}` }}>
          <h3 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: 0 }}>Carrier Rankings</h3>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "40px 100px 1fr 120px 120px",
          padding: "8px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["#", "Code", "Carrier Name", "TEU", "Share"].map((h, i) => (
            <div key={i} style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".07em" }}>{h}</div>
          ))}
        </div>
        {barData.map(({ carrier: code, name, teu }, idx) => {
          const share = totalTEU > 0 ? Math.round((teu / totalTEU) * 1000) / 10 : 0;
          return (
            <div key={code}
              style={{ display: "grid", gridTemplateColumns: "40px 100px 1fr 120px 120px",
                padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{idx + 1}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.accent }}>{code}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{name}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 600, color: T.text }}>{teu}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1, height: 6, background: T.border, borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${share}%`, height: "100%", background: T.accent, borderRadius: 3 }} />
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, minWidth: 36, textAlign: "right" }}>{share}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Compliance Review tab ────────────────────────────────────────────────────

const ComplianceReviewView = ({ compHits, custHits, loading, onRefresh }) => {
  const th = {
    position: "relative", paddingLeft: 6,
    fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
  };

  const shipHits = Array.isArray(compHits) ? compHits : [];
  const cHits    = custHits?.hits || [];
  const bothEnabled = custHits?.enabled !== false;

  // Display-layer filter on the Shipments hit table only — the customer hits table below has
  // no filter (matches the approved mockup). Doesn't touch compHits/custHits fetch logic.
  const [statusFilter, setStatusFilter] = useState("All");
  const filteredShipHits = shipHits.filter(s => statusFilter === "All" || s.status === statusFilter);

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontFamily: HZ.fontDisplay, fontSize: 19, fontWeight: 600, color: HZ.ink, margin: 0 }}>
            Compliance Review
          </h2>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            Active OFAC SDN hits requiring officer review
          </p>
        </div>
        <button type="button" onClick={onRefresh}
          style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
            border: `1px solid ${T.accent}44`, borderRadius: 7, padding: "6px 14px",
            cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
          <IconRefresh size={12} />Refresh
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
          Loading compliance data…
        </div>
      ) : (
        <>
          {/* ── Shipment Hits ── */}
          <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)", overflow: "hidden", marginBottom: 24 }}>
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T.border}`,
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h3 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: 0 }}>
                  Shipments — Active Compliance Hits
                </h3>
                {shipHits.length > 0 && (
                  <span style={{ background: T.danger, color: "#fff", fontFamily: T.mono, fontSize: 10,
                    fontWeight: 700, borderRadius: 10, padding: "1px 7px" }}>
                    {shipHits.length}
                  </span>
                )}
              </div>
              <FilterSelect label="Status" value={statusFilter} onChange={setStatusFilter} options={STATUSES} />
            </div>
            {/* Column headers */}
            <div style={{ display: "grid", gridTemplateColumns: "140px 130px 110px 1fr 120px 90px",
              padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
              {["Shipment ID", "Route", "Carrier", "Flagged Parties", "Screened At", "Status"].map((h, i) => (
                <div key={i} style={th}>{h}</div>
              ))}
            </div>
            {shipHits.length === 0 ? (
              <div style={{ padding: 32, textAlign: "center", color: T.textMuted,
                fontFamily: T.body, fontSize: 14, fontStyle: "italic" }}>
                No active compliance hits — all shipments are clear.
              </div>
            ) : filteredShipHits.length === 0 ? (
              <div style={{ padding: 32, textAlign: "center", color: T.textMuted,
                fontFamily: T.body, fontSize: 14, fontStyle: "italic" }}>
                No compliance hits match the selected Status filter.
              </div>
            ) : filteredShipHits.map(s => {
              const hitLabels = s.screening.hits.map(h => `${h.field}: ${h.value}`).join(" · ");
              return (
                <div key={s.id}
                  style={{ display: "grid", gridTemplateColumns: "140px 130px 110px 1fr 120px 90px",
                    padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                    background: "#ef444408", transition: "background .1s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#ef444412"}
                  onMouseLeave={e => e.currentTarget.style.background = "#ef444408"}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>{s.id}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{s.pol} → {s.pod}</span>
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{s.carrierCode}</span>
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.danger, fontWeight: 600,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <IconWarning size={11} />{hitLabels}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                    {s.screening.screenedAt ? new Date(s.screening.screenedAt).toLocaleDateString("en-GB") : "—"}
                  </span>
                  <Badge variant={statusVariant(s.status)} size={11}>{s.status}</Badge>
                </div>
              );
            })}
          </div>

          {/* ── Customer Hits ── */}
          <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 16, backdropFilter: "blur(16px)", overflow: "hidden" }}>
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T.border}`,
              display: "flex", alignItems: "center", gap: 10 }}>
              <h3 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: 0 }}>
                Customer — SDN Matches
              </h3>
              {cHits.length > 0 && (
                <span style={{ background: T.danger, color: "#fff", fontFamily: T.mono, fontSize: 10,
                  fontWeight: 700, borderRadius: 10, padding: "1px 7px" }}>
                  {cHits.length}
                </span>
              )}
            </div>
            {!bothEnabled ? (
              <div style={{ padding: "20px 24px", fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
                Requires both <strong>Customers</strong> and <strong>OFAC SDN</strong> APIs to be enabled in Application Settings.
              </div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr 140px",
                  padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
                  {["Customer ID", "Company Name", "Matched SDN Entry", "Program"].map((h, i) => (
                    <div key={i} style={th}>{h}</div>
                  ))}
                </div>
                {cHits.length === 0 ? (
                  <div style={{ padding: 32, textAlign: "center", color: T.textMuted,
                    fontFamily: T.body, fontSize: 14, fontStyle: "italic" }}>
                    No customers matched against the SDN list.
                  </div>
                ) : cHits.map((h, i) => (
                  <div key={i}
                    style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr 140px",
                      padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                      background: "#ef444408", transition: "background .1s" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#ef444412"}
                    onMouseLeave={e => e.currentTarget.style.background = "#ef444408"}>
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{h.customer.id}</span>
                    <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.danger,
                      display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <IconWarning size={11} />{h.customer.companyName}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 12, color: T.text }}>{h.matchedEntry}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{h.program || "—"}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};

// ─── Page: Dashboard ──────────────────────────────────────────────────────────

// ─── Date range helpers ────────────────────────────────────────────────────────


const DashboardPage = ({ shipments, containers, carriers, allocations, containerTypeDefs = [], financeEnabled = true }) => {
  const [view, setView] = useState("overview"); // "overview" | "contracts" | "compliance"
  // Admin-configured TEU overrides (Master Data → Equipment) — same lookup the backend's
  // TEU_EXPR reads, so this page's client-side figures agree with the server (2026-09 Space
  // Configuration spec, gap #8).
  const teuDefs = useMemo(() => buildTeuLookup(containerTypeDefs), [containerTypeDefs]);

  // Sales Pipeline tile (2026-09 Quoting/RFQ gap-closing pass) — quotes/opportunities aren't part
  // of App.jsx's shared top-level state (nothing else needs them there), so this page self-fetches
  // its own small summary on mount, same precedent as CommandCenterView's TicketAlertCard self-
  // fetching api.tickets.list() independently rather than receiving it as a prop.
  // null (not []) while loading — this codebase has hit the "empty array reads as confirmed-zero"
  // bug enough times (ServicesPanel, PartiesOfficesPanel, ...) that null-gating is the house rule.
  const [pipelineQuotes, setPipelineQuotes] = useState(null);
  const [pipelineOpportunities, setPipelineOpportunities] = useState(null);
  useEffect(() => {
    api.quotes.list({ limit: 200 }).then(r => setPipelineQuotes(r.results || [])).catch(() => setPipelineQuotes([]));
    api.opportunities.list({ limit: 200 }).then(r => setPipelineOpportunities(r.results || r || [])).catch(() => setPipelineOpportunities([]));
  }, []);

  // Compliance tab state — loaded on first open
  const [compHits,     setCompHits]     = useState(null);   // null = not yet loaded
  const [custHits,     setCustHits]     = useState(null);
  const [compLoading,  setCompLoading]  = useState(false);

  const loadCompliance = useCallback(async () => {
    setCompLoading(true);
    try {
      const [ch, cu] = await Promise.all([
        api.screening.complianceHits(),
        api.customers.sanctionsCheck(),
      ]);
      setCompHits(ch);
      setCustHits(cu);
    } catch { setCompHits([]); setCustHits({ enabled: false, hits: [] }); }
    setCompLoading(false);
  }, []);

  const handleTabChange = key => {
    setView(key);
    if (key === "compliance" && compHits === null) loadCompliance();
  };
  // Date range state — defaults to current Mon-Sun
  const [rangeStart, setRangeStart] = useState(() => currentWeekStart());
  const [rangeEnd,   setRangeEnd]   = useState(() => addDays(currentWeekStart(), 6));

  const handleStartChange = newStart => {
    setRangeStart(newStart);
    // Clamp end to start+MAX or keep if still valid
    const maxEnd = addDays(newStart, MAX_RANGE_DAYS);
    if (!rangeEnd || rangeEnd < newStart) setRangeEnd(newStart);
    else if (rangeEnd > maxEnd) setRangeEnd(maxEnd);
  };

  const handleEndChange = newEnd => setRangeEnd(newEnd);

  const spanDays  = rangeStart && rangeEnd ? diffDays(rangeStart, rangeEnd) + 1 : 7;
  const shiftRange = n => {
    const shift = n * spanDays;
    setRangeStart(s => addDays(s, shift));
    setRangeEnd(e => addDays(e, shift));
  };
  const goToday = () => {
    const ws = currentWeekStart();
    setRangeStart(ws);
    setRangeEnd(addDays(ws, 6));
  };

  // Overview tab's carrier column filter (Shipments in Period table) — persisted the same
  // try/catch-guarded JSON idiom PageSizeSelect/useResizableColumns already use elsewhere on
  // this page. null = "no filter, show every carrier"; a non-null array is the selected subset.
  const CARRIER_FILTER_KEY = "cd_dashboard_carrier_filter";
  const [carrierFilter, setCarrierFilter] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem(CARRIER_FILTER_KEY) || "null");
      return Array.isArray(v) ? v : null;
    } catch { return null; }
  });
  useEffect(() => {
    try { localStorage.setItem(CARRIER_FILTER_KEY, JSON.stringify(carrierFilter)); } catch {}
  }, [carrierFilter]);

  // Active allocations: those whose effective period overlaps the selected range
  const activeAllocations = useMemo(() =>
    allocations.filter(a => {
      if (!a.effectiveDate || !a.endDate) return true;
      return a.effectiveDate <= rangeEnd && a.endDate >= rangeStart;
    }),
    [allocations, rangeStart, rangeEnd]
  );

  // Shipments with ETD (or createdAt) in range, with at least 1 TEU
  const rangeShipments = useMemo(() => shipments.filter(s => {
    const ref = s.etd || s.createdAt || "";
    if (!(ref >= rangeStart && ref <= rangeEnd)) return false;
    return containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size, c.type, teuDefs), 0) > 0;
  }), [shipments, rangeStart, rangeEnd, containers, teuDefs]);

  // Overview tab's carrier filter — derived from rangeShipments/activeAllocations but never
  // written back into them, since both are shared with Contract Consumption/Carrier Volumes
  // (ContractConsumptionView/CarrierView props below) and must stay unfiltered for those tabs.
  //
  // The popover's own checklist is built from overviewCentralShipments (BEFORE the carrier
  // filter is applied) so an unchecked carrier stays selectable instead of vanishing from the
  // list the moment it's excluded — the same way a spreadsheet's own column filter behaves.
  const overviewCentralShipments = useMemo(() =>
    rangeShipments.filter(s => s.contractType === "Central"), [rangeShipments]);

  const availableCarrierCodes = useMemo(() =>
    [...new Set(overviewCentralShipments.map(s => s.carrierCode))].sort(),
    [overviewCentralShipments]);

  // Reconciled against carriers actually present this period — a filter selection saved while
  // looking at a different date range shouldn't silently zero out this one just because none of
  // those carriers shipped anything now.
  const carrierFilterSet = useMemo(() => {
    if (!carrierFilter) return null; // never customized — no filter
    const reconciled = carrierFilter.filter(c => availableCarrierCodes.includes(c));
    // A non-empty saved filter that no longer matches anything this period (e.g. saved while
    // looking at a different date range) falls back to "no filter" rather than a confusingly
    // empty tab. But an explicit Clear — carrierFilter was already [] — means "show nothing" and
    // must stay that way: collapsing an empty result to "show all" here regardless of *why* it's
    // empty was exactly the bug that made the Clear button look like it did nothing.
    if (carrierFilter.length > 0 && reconciled.length === 0) return null;
    return new Set(reconciled);
  }, [carrierFilter, availableCarrierCodes]);

  // Distinct from carrierFilterSet being null (no filter) or non-empty (a real subset) — this is
  // specifically "the user unchecked everything," which every consumption widget on the tab
  // needs to render as an explicit empty state rather than a bare 0/blank chart.
  const carrierFilterIsEmpty = Array.isArray(carrierFilter) && carrierFilter.length === 0;

  const filteredRangeShipments = useMemo(() =>
    carrierFilterSet ? rangeShipments.filter(s => carrierFilterSet.has(s.carrierCode)) : rangeShipments,
    [rangeShipments, carrierFilterSet]);

  const filteredActiveAllocations = useMemo(() =>
    carrierFilterSet ? activeAllocations.filter(a => carrierFilterSet.has(a.carrierCode)) : activeAllocations,
    [activeAllocations, carrierFilterSet]);

  const today = todayIso();

  // Split allocations: current (not expired) vs archived (expired)
  const currentAllocations  = allocations.filter(a => a.endDate >= today);

  // TEU per carrier, bucketed by booking status (only Confirmed actively counts as consumed
  // space, matching loadTeuBuckets() in routes/allocations.js) — Pending covers Created/Pending/
  // no-booking-row-yet, Rejected is its own bucket, Cancelled is excluded entirely. Matched by
  // the shipment's own allocationId, not a carrier+contract+pol/pod heuristic (2026-09 Space
  // Configuration spec, gap #1 — this used to be able to disagree with the Space Configurations
  // page's own per-allocation figures; now it's the same join, just date-range-scoped).
  const consumedMap = useMemo(() => {
    const m = {};
    filteredRangeShipments.forEach(s => {
      const matched = s.allocationId && activeAllocations.find(a => a.id === s.allocationId);
      if (!matched) return;
      const teu = containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size, c.type, teuDefs), 0);
      const bucket = m[s.carrierCode] || (m[s.carrierCode] = { confirmed: 0, pending: 0, rejected: 0 });
      if (s.bookingStatus === "Confirmed") bucket.confirmed += teu;
      else if (s.bookingStatus === "Rejected") bucket.rejected += teu;
      else if (s.bookingStatus === "Cancelled") { /* excluded */ }
      else bucket.pending += teu;
    });
    return m;
  }, [filteredRangeShipments, containers, activeAllocations, teuDefs]);


  // Trend data: delta vs previous equivalent period + 6-week sparkline — Confirmed only, matching
  // what "consumption" means everywhere else post-v0.86.0 (raw all-status volume trend is still
  // available, unchanged, on the Carrier Volumes tab).
  //
  // Bug fix (found live, 2026-09): this used to count ANY Confirmed-booking shipment for the
  // carrier code, with no allocationId check at all — unlike consumedMap/chartData just above,
  // which correctly require a real allocationId link (2026-09 Space Configuration spec, gap #1).
  // A SPOT shipment with no matching space config ("No config match" in the Shipments table)
  // still has a Confirmed booking, so it silently inflated this trend line while correctly
  // contributing 0 to the "TEU by Carrier" bar chart sitting right next to it — the exact kind of
  // two-engines-disagreeing bug this session's gap-closing pass was supposed to eliminate.
  // allocationId truthiness is trusted directly (shipments.allocation_id now carries a real FK,
  // so a non-null value is guaranteed to reference a real allocation row) rather than
  // cross-checking against activeAllocations, since history here spans weeks outside the
  // currently-selected range where "active" wouldn't mean the same thing.
  const carrierTrends = useMemo(() => {
    const periodDays = diffDays(rangeStart, rangeEnd) + 1;
    const prevEnd    = addDays(rangeStart, -1);
    const prevStart  = addDays(prevEnd, -(periodDays - 1));
    // All carrier codes that appear in the selected range — not just allocated ones
    const allCodes = [...new Set(filteredRangeShipments.map(s => s.carrierCode).filter(Boolean))];
    const trends   = {};

    allCodes.forEach(code => {
      // Current TEU — sum directly from range shipments for this carrier
      const currentTEU = rangeShipments
        .filter(s => s.carrierCode === code && s.bookingStatus === "Confirmed" && s.allocationId)
        .reduce((acc, s) =>
          acc + containers.filter(c => c.shipmentId === s.id)
                          .reduce((a2, c) => a2 + teuOf(c.size, c.type, teuDefs), 0), 0);

      // Previous period TEU
      const prevTEU = shipments
        .filter(s => s.carrierCode === code && s.bookingStatus === "Confirmed" && s.allocationId && s.etd >= prevStart && s.etd <= prevEnd)
        .reduce((acc, s) =>
          acc + containers.filter(c => c.shipmentId === s.id)
                          .reduce((a2, c) => a2 + teuOf(c.size, c.type, teuDefs), 0), 0);

      // Delta %
      const delta = prevTEU > 0
        ? Math.round(((currentTEU - prevTEU) / prevTEU) * 100)
        : currentTEU > 0 ? 100 : 0;

      // 6-week sparkline — i=5 window starts at rangeStart, earlier windows go back 7 days each
      const sparkData = Array.from({ length: 6 }, (_, i) => {
        const wStart = addDays(rangeStart, -(5 - i) * 7);
        const wEnd   = addDays(wStart, 6);
        return shipments
          .filter(s => s.carrierCode === code && s.bookingStatus === "Confirmed" && s.allocationId && s.etd >= wStart && s.etd <= wEnd)
          .reduce((acc, s) =>
            acc + containers.filter(c => c.shipmentId === s.id)
                            .reduce((a2, c) => a2 + teuOf(c.size, c.type, teuDefs), 0), 0);
      });

      trends[code] = { delta, prevTEU, sparkData };
    });

    return trends;
  }, [filteredRangeShipments, shipments, containers, rangeStart, rangeEnd, teuDefs]);

  // Carrier Volumes tab's own trend line needs a genuinely raw (all-status, no allocationId
  // requirement) sparkline to actually match its own bar chart's philosophy — that tab is framed
  // as "all shipments · by carrier code · TEU", not a space-consumption view. It used to borrow
  // carrierTrends above directly, which was already Confirmed-only (undercutting the "raw"
  // framing) and, after the allocationId fix, would have undercounted it further still. Same
  // per-carrier sparkline shape, just with every status filter dropped.
  const rawCarrierTrends = useMemo(() => {
    const allCodes = [...new Set(rangeShipments.map(s => s.carrierCode).filter(Boolean))];
    const trends = {};
    allCodes.forEach(code => {
      const sparkData = Array.from({ length: 6 }, (_, i) => {
        const wStart = addDays(rangeStart, -(5 - i) * 7);
        const wEnd   = addDays(wStart, 6);
        return shipments
          .filter(s => s.carrierCode === code && s.etd >= wStart && s.etd <= wEnd)
          .reduce((acc, s) =>
            acc + containers.filter(c => c.shipmentId === s.id)
                            .reduce((a2, c) => a2 + teuOf(c.size, c.type, teuDefs), 0), 0);
      });
      trends[code] = { sparkData };
    });
    return trends;
  }, [rangeShipments, shipments, containers, rangeStart, teuDefs]);

  // Chart: group by carrier — consumption is total across all contract types
  const chartData = useMemo(() => {
    const byCarrier = {};
    filteredActiveAllocations.forEach(a => {
      if (!byCarrier[a.carrierCode]) byCarrier[a.carrierCode] = { allocated: 0 };
      byCarrier[a.carrierCode].allocated += a.allocatedTEU;
      byCarrier[a.carrierCode].bucket = consumedMap[a.carrierCode] || { confirmed: 0, pending: 0, rejected: 0 };
    });
    return Object.entries(byCarrier).map(([code, d]) => ({
      carrier: code,
      name: carriers.find(c => c.code === code)?.name || code,
      confirmed: d.bucket.confirmed,
      pending: d.bucket.pending,
      rejected: d.bucket.rejected,
      remaining: Math.max(0, d.allocated - d.bucket.confirmed),
      total: d.allocated,
    }));
  }, [filteredActiveAllocations, consumedMap, carriers]);

  // Confirmation-rate ranking (Total Allocated card, Overview) — Confirmed ÷ (Confirmed+Pending+
  // Rejected) per carrier, off the same chartData buckets the bar chart/badge grid already use.
  // A minimum requested-TEU floor keeps one small shipment from swinging a carrier to a
  // meaningless 100%/0%. With 6 or fewer qualifying carriers a real top-3/bottom-3 split would
  // overlap (the same carrier landing in both groups), so that case renders one ranked list
  // instead — the split only kicks in once there's enough carriers for the two groups to be
  // genuinely disjoint.
  const MIN_RANKED_TEU = 4;
  const carrierPerformance = useMemo(() => {
    const ranked = chartData
      .map(d => {
        const requested = d.confirmed + d.pending + d.rejected;
        return { carrier: d.carrier, requested, rate: requested > 0 ? (d.confirmed / requested) * 100 : null };
      })
      .filter(d => d.rate !== null && d.requested >= MIN_RANKED_TEU)
      .sort((a, b) => b.rate - a.rate);
    if (ranked.length <= 6) return { mode: "all", rows: ranked };
    return { mode: "split", top: ranked.slice(0, 3), bottom: ranked.slice(-3) };
  }, [chartData]);

  const totalAlloc    = filteredActiveAllocations.reduce((s, a) => s + a.allocatedTEU, 0);

  // Trend chart data: reshape sparkData arrays into recharts [{week, MAEU, HLCU, ...}]
  const trendChartData = useMemo(() => {
    const activeCodesSet = new Set(filteredActiveAllocations.map(a => a.carrierCode));
    const activeCodes  = [...activeCodesSet];
    return Array.from({ length: 6 }, (_, i) => {
      const wStart  = addDays(rangeStart, -(5 - i) * 7);
      const weekEnd = addDays(wStart, 6);
      const label   = parseIso(weekEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      const pt      = { week: label };
      activeCodes.forEach(code => {
        pt[code] = carrierTrends[code]?.sparkData[i] ?? 0;
      });
      return pt;
    });
  }, [carrierTrends, filteredActiveAllocations, rangeStart]);

  const trendCarriers = [...new Set(filteredActiveAllocations.map(a => a.carrierCode))];

  // 6-week TEU trend by contract (Central shipments only). 2026-09-03 audit: contractIds used to
  // be every Central contract that EVER had a shipment, all-time, unbounded — not scoped to this
  // chart's own 6-week window at all (unlike its sibling trend chart, trendChartData/
  // activeCodesSet above, which correctly limits itself to allocations active in the visible
  // range). Verified live against this dev DB: 12 contracts drew a line, only 1 had any real
  // (Confirmed, in-window) data — the other 11 were permanent flat-zero clutter, directly
  // contradicting the chart's own caption ("Weekly Confirmed consumption per contract — last 6
  // weeks"), and only grows worse as more historical contracts accumulate. Fixed: a contract only
  // earns a line if it has at least one Confirmed shipment whose ETD actually falls somewhere in
  // the visible 6-week window — the same criterion that would make its line non-zero anyway.
  const contractTrendData = useMemo(() => {
    const trendWindowStart = addDays(rangeStart, -35);
    const trendWindowEnd   = addDays(rangeStart, 6);
    const centralSh    = shipments.filter(s => s.contractType === "Central" && s.contractId);
    const inWindow      = centralSh.filter(s =>
      s.bookingStatus === "Confirmed" && s.etd && s.etd >= trendWindowStart && s.etd <= trendWindowEnd);
    const contractIds  = [...new Set(inWindow.map(s => s.contractId))];
    const refMap       = {};
    inWindow.forEach(s => { if (!refMap[s.contractId]) refMap[s.contractId] = s.contractRef || String(s.contractId); });
    const weeks = Array.from({ length: 6 }, (_, i) => {
      const wStart = addDays(rangeStart, -(5 - i) * 7);
      const wEnd   = addDays(wStart, 6);
      const label  = parseIso(wEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      const pt     = { week: label };
      contractIds.forEach(id => {
        // Confirmed only — matches what "consumption" means everywhere else post-v0.86.0;
        // raw all-status volume is still available, unchanged, on the Carrier Volumes tab.
        pt[id] = centralSh
          .filter(s => s.contractId === id && s.bookingStatus === "Confirmed" && s.etd >= wStart && s.etd <= wEnd)
          .reduce((acc, s) =>
            acc + containers.filter(c => c.shipmentId === s.id).reduce((a2, c) => a2 + teuOf(c.size, c.type, teuDefs), 0), 0);
      });
      return pt;
    });
    return { weeks, contractIds, refMap };
  }, [shipments, containers, rangeStart, teuDefs]);

  const totalConfirmed = chartData.reduce((s, d) => s + d.confirmed, 0);
  const totalPending   = chartData.reduce((s, d) => s + d.pending, 0);
  const totalRejected  = chartData.reduce((s, d) => s + d.rejected, 0);
  const totalRemain    = Math.max(0, totalAlloc - totalConfirmed);

  // KPI-tile utilization tint (Confirmed Consumption / Remaining Capacity share the same
  // confirmed/allocated ratio, just two sides of it) — no tint under 80%, warning 80-99%,
  // danger at 100%+. Total Allocated is the denominator, not a utilization figure, so it
  // never gets a tint regardless of this value.
  const utilPct  = totalAlloc > 0 ? (totalConfirmed / totalAlloc) * 100 : 0;
  const utilTint = totalAlloc === 0 ? undefined : utilPct >= 100 ? T.danger : utilPct >= 80 ? T.warning : undefined;

  const TooltipContent = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const d = chartData.find(x => x.carrier === label);
    return (
      <div style={{ background: "#0d1220", border: `1px solid ${HZ.border}`, borderRadius: 12, padding: "12px 16px" }}>
        <div style={{ fontFamily: HZ.fontMono, fontWeight: 700, color: HZ.gradCyan[0], marginBottom: 8, fontSize: 13 }}>{label} · {d?.name}</div>
        <div style={{ fontFamily: HZ.fontBody, fontSize: 13, color: HZ.good }}>Confirmed: {d?.confirmed} TEU</div>
        {d?.pending > 0 && <div style={{ fontFamily: HZ.fontBody, fontSize: 13, color: HZ.warning }}>Pending: {d.pending} TEU</div>}
        {d?.rejected > 0 && <div style={{ fontFamily: HZ.fontBody, fontSize: 13, color: HZ.critical }}>Rejected: {d.rejected} TEU</div>}
        <div style={{ fontFamily: HZ.fontBody, fontSize: 13, color: HZ.inkMuted }}>Remaining: {d?.remaining} TEU</div>
        <div style={{ fontFamily: HZ.fontBody, fontSize: 13, fontWeight: 700, color: HZ.ink,
          borderTop: `1px solid ${HZ.border}`, marginTop: 8, paddingTop: 8 }}>Total: {d?.total} TEU</div>
      </div>
    );
  };

  useHorizonFonts();

  return (
    <div style={{ position: "relative", background: HZ.bg, margin: -24, padding: 24, borderRadius: 16 }}>
      <HorizonBackdrop />
      <div style={{ position: "relative", zIndex: 1 }}>
      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0,
              background: `linear-gradient(135deg, ${HZ.gradCyan[0]}, ${HZ.gradCyan[1]})`,
              boxShadow: "0 0 0 1px rgba(255,255,255,0.12) inset, 0 8px 20px -8px rgba(56,212,232,0.55)",
              display: "flex", alignItems: "center", justifyContent: "center" }}>
              <IconDashboard size={17} color="#04121c" />
            </div>
            <h1 style={{ fontFamily: HZ.fontDisplay, fontSize: 26, fontWeight: 700, color: HZ.ink, margin: 0 }}>Trade Horizon</h1>
          </div>
          <p style={{ fontFamily: HZ.fontBody, fontSize: 13, color: HZ.inkMuted, margin: "4px 0 0",
            display: "flex", alignItems: "center", gap: 6 }}>
            TEU allocation and consumption across active space configurations
            <InfoHint>20ft = 1 TEU · 40ft = 2 TEU</InfoHint>
          </p>
        </div>
      </div>

      {/* ── Date range picker (always visible) ── */}
      {/* The glass fill lives on an absolutely-positioned DECORATIVE layer behind the real content,
          not on the content wrapper itself. backdropFilter (like filter/transform/perspective) on an
          ancestor doesn't just trap paint order — it also redefines the CONTAINING BLOCK for any
          position:fixed descendant, so the DatePicker's calendar popup (position:fixed internally)
          stops resolving its coordinates against the viewport and resolves them against this card's
          box instead, landing wildly misplaced (found live, 2026-09-12, after an earlier z-index-only
          fix cured the paint-order symptom but not this positioning one). Keeping backdropFilter off
          every real ancestor of the DatePicker sidesteps both problems at once — the content wrapper
          below has only position:relative for plain DOM stacking, nothing from the filter family. */}
      <div data-testid="dashboard-date-range" style={{ position: "relative", borderRadius: 16, marginBottom: 20 }}>
        <div aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 0, borderRadius: 16,
          background: HZ.surface, border: `1px solid ${HZ.border}`, backdropFilter: "blur(18px)" }} />
        <div style={{ position: "relative", zIndex: 1, padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
            <Btn variant="secondary" size="sm" onClick={() => shiftRange(-1)}>← Prev</Btn>
            <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "end" }}>
              <DatePicker id="dashboard-date-from" label="From" value={rangeStart} onChange={handleStartChange} placeholder="Start date…" />
              <div style={{ fontFamily: HZ.fontMono, fontSize: 18, color: HZ.inkMuted, paddingBottom: 9, userSelect: "none" }}>—</div>
              <DatePicker id="dashboard-date-to" label="To" value={rangeEnd} onChange={handleEndChange}
                minDate={rangeStart} maxDate={rangeStart ? addDays(rangeStart, MAX_RANGE_DAYS) : undefined}
                placeholder="End date…" />
            </div>
            <Btn variant="secondary" size="sm" onClick={() => shiftRange(1)}>Next →</Btn>
            <Btn variant="ghost" size="sm" onClick={goToday}
              style={{ borderLeft: `1px solid ${HZ.border}`, paddingLeft: 14 }}>
              This Week
            </Btn>
          </div>
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 14,
            borderTop: `1px solid ${HZ.borderSoft}`, paddingTop: 10 }}>
            <span style={{ fontFamily: HZ.fontMono, fontSize: 11, fontWeight: 700, color: HZ.gradCyan[0],
              background: "rgba(56,212,232,0.12)", borderRadius: 20, padding: "3px 12px" }}>
              {spanDays} day{spanDays !== 1 ? "s" : ""} · max {MAX_RANGE_DAYS}
            </span>
            <span style={{ fontFamily: HZ.fontBody, fontSize: 12, color: HZ.inkMuted }}>
              {rangeShipments.length} shipment{rangeShipments.length !== 1 ? "s" : ""} with ETD in range
            </span>
            {activeAllocations.length !== allocations.length && (
              <span style={{ fontFamily: HZ.fontBody, fontSize: 12, color: HZ.gradCyan[0] }}>
                ↳ {activeAllocations.length} of {allocations.length} space configs active in this period
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div data-testid="dashboard-tab-bar" style={{ display: "flex", borderBottom: `1px solid ${HZ.border}`, marginBottom: 24, gap: 2 }}>
        {[
          { key: "overview",   label: "Overview" },
          { key: "contracts",  label: "Contract Consumption" },
          { key: "carriers",   label: "Carrier Volumes" },
          { key: "margin",     label: "Margin" },
          { key: "compliance", label: "Compliance Review", count: Array.isArray(compHits) ? compHits.length : null },
        ].map(tab => (
          <TabButton key={tab.key} tab={tab} active={view === tab.key} onClick={() => handleTabChange(tab.key)} />
        ))}
      </div>

      {/* ── Overview tab ── */}
      {view === "overview" && (
        <div data-testid="dashboard-panel-overview">
          {/* Hero: consumption ring + carrier badges — bento grid, asymmetric spans. Replaced
              entirely by a single empty-state panel when the carrier filter is explicitly
              cleared to zero carriers — every figure in it would otherwise just read 0/blank,
              which reads as broken rather than as "you asked for nothing." The charts section
              below needs no equivalent branch: its own chartData.length > 0 gate already hides
              it automatically once chartData comes back empty from the same filtered inputs. */}
          {carrierFilterIsEmpty ? (
            <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 20,
              backdropFilter: "blur(18px)", marginBottom: 20 }}>
              <NoCarriersSelected />
            </div>
          ) : (
          <div style={{ display: "grid", gridTemplateColumns: "5fr 3fr 4fr", gap: 16, marginBottom: 20 }}>
            <div data-testid="space-consumption-card" style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 20, backdropFilter: "blur(18px)", padding: 22 }}>
              <div style={{ fontFamily: HZ.fontDisplay, fontSize: 14.5, fontWeight: 600, color: HZ.ink, marginBottom: 2 }}>Space Consumption</div>
              <div style={{ fontFamily: HZ.fontBody, fontSize: 12, color: HZ.inkMuted, marginBottom: 16 }}>
                Across {filteredActiveAllocations.length} active allocation{filteredActiveAllocations.length !== 1 ? "s" : ""} · {totalAlloc.toLocaleString("en-US")} TEU committed
              </div>
              <KpiRing pct={totalAlloc > 0 ? (totalConfirmed / totalAlloc) * 100 : 0}
                confirmed={totalConfirmed} pending={totalPending} rejected={totalRejected} remaining={totalRemain} />
            </div>
            <div data-testid="active-carriers-card" style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 20, backdropFilter: "blur(18px)", padding: 22 }}>
              <div style={{ fontFamily: HZ.fontDisplay, fontSize: 14.5, fontWeight: 600, color: HZ.ink, marginBottom: 2 }}>Active Carriers</div>
              <div style={{ fontFamily: HZ.fontBody, fontSize: 12, color: HZ.inkMuted, marginBottom: 14 }}>By space commitment</div>
              <CarrierBadgeGrid rows={chartData} />
            </div>
            <div data-testid="total-allocated-card" style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 20, backdropFilter: "blur(18px)", padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <div style={{ fontFamily: HZ.fontDisplay, fontSize: 14.5, fontWeight: 600, color: HZ.ink }}>Total Allocated</div>
                <div style={{ fontFamily: HZ.fontDisplay, fontSize: 25, fontWeight: 700, color: HZ.ink, marginTop: 6 }}>{totalAlloc.toLocaleString("en-US")} <span style={{ fontSize: 13, color: HZ.inkMuted, fontFamily: HZ.fontBody }}>TEU</span></div>
                <div style={{ fontFamily: HZ.fontBody, fontSize: 12, color: HZ.inkMuted }}>{filteredActiveAllocations.length} configuration{filteredActiveAllocations.length !== 1 ? "s" : ""}</div>
              </div>
              {(carrierPerformance.mode === "all" ? carrierPerformance.rows.length > 0 : true) && (
                <div data-testid="carrier-performance-table" style={{ borderTop: `1px solid ${HZ.borderSoft}`, paddingTop: 14,
                  display: "flex", flexDirection: "column", gap: 12 }}>
                  {carrierPerformance.mode === "all" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      <div style={{ fontFamily: HZ.fontBody, fontSize: 10, fontWeight: 600, color: HZ.inkMuted,
                        textTransform: "uppercase", letterSpacing: ".08em" }}>
                        Confirmation Rate
                      </div>
                      {carrierPerformance.rows.map((r, i) => <PerfRow key={r.carrier} rank={i + 1} carrier={r.carrier} rate={r.rate} />)}
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                        <div style={{ fontFamily: HZ.fontBody, fontSize: 10, fontWeight: 600, color: HZ.good,
                          textTransform: "uppercase", letterSpacing: ".08em" }}>
                          Top Performers
                        </div>
                        {carrierPerformance.top.map(r => <PerfRow key={r.carrier} carrier={r.carrier} rate={r.rate} />)}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                        <div style={{ fontFamily: HZ.fontBody, fontSize: 10, fontWeight: 600, color: HZ.critical,
                          textTransform: "uppercase", letterSpacing: ".08em" }}>
                          Needs Attention
                        </div>
                        {carrierPerformance.bottom.map(r => <PerfRow key={r.carrier} carrier={r.carrier} rate={r.rate} />)}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 26 }}>
          {/* Shipment health: on-time vs overdue */}
          {(() => {
            const active   = shipments.filter(s => s.status === "Active");
            const overdue  = active.filter(s => s.overdueCount > 0);
            const onTime   = active.length - overdue.length;
            const pct      = active.length > 0 ? Math.round((onTime / active.length) * 100) : null;
            if (active.length === 0) return null;
            const barW = pct ?? 100;
            return (
              <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 20, backdropFilter: "blur(18px)",
                padding: "16px 24px", display: "flex", alignItems: "center", gap: 32 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: HZ.fontBody, fontSize: 10.5, color: HZ.inkMuted, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
                    Active Shipment Health
                  </div>
                  <div style={{ height: 8, background: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${barW}%`, background: overdue.length > 0 ? HZ.warning : HZ.good,
                      borderRadius: 4, transition: "width .4s" }} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 24, flexShrink: 0 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontFamily: HZ.fontDisplay, fontSize: 26, fontWeight: 700, color: HZ.good }}>{onTime}</div>
                    <div style={{ fontFamily: HZ.fontBody, fontSize: 10.5, color: HZ.inkMuted }}>On Time</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontFamily: HZ.fontDisplay, fontSize: 26, fontWeight: 700,
                      color: overdue.length > 0 ? HZ.critical : HZ.inkMuted }}>{overdue.length}</div>
                    <div style={{ fontFamily: HZ.fontBody, fontSize: 10.5, color: HZ.inkMuted }}>Overdue</div>
                  </div>
                  {pct !== null && (
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontFamily: HZ.fontDisplay, fontSize: 26, fontWeight: 700,
                        color: pct === 100 ? HZ.good : pct >= 80 ? HZ.warning : HZ.critical }}>{pct}%</div>
                      <div style={{ fontFamily: HZ.fontBody, fontSize: 10.5, color: HZ.inkMuted }}>On-Time Rate</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Sales Pipeline: Opportunities + Quotes ahead of a real shipment (2026-09 gap-closing
              pass) — same bare-metric tile shape as Active Shipment Health above, not a new
              visual language. null while loading (still-fetching, not "confirmed zero"). */}
          {pipelineQuotes !== null && pipelineOpportunities !== null && (() => {
            const openOpportunities = pipelineOpportunities.filter(o => o.status === "New" || o.status === "Qualified").length;
            const draftQuotes = pipelineQuotes.filter(q => q.status === "Draft").length;
            const sentQuotes = pipelineQuotes.filter(q => q.status === "Sent");
            const sentValueUsd = sentQuotes.reduce((sum, q) => sum + (q.totalAmountUsd || 0), 0);
            if (openOpportunities === 0 && draftQuotes === 0 && sentQuotes.length === 0) return null;
            return (
              <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 20, backdropFilter: "blur(18px)",
                padding: "16px 24px", display: "flex", alignItems: "center", gap: 32 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: HZ.fontBody, fontSize: 10.5, color: HZ.inkMuted, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
                    Sales Pipeline
                  </div>
                  <div style={{ fontFamily: HZ.fontBody, fontSize: 12, color: HZ.inkMuted }}>
                    Opportunities and quotes ahead of a real shipment
                  </div>
                </div>
                <div style={{ display: "flex", gap: 24, flexShrink: 0 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontFamily: HZ.fontDisplay, fontSize: 26, fontWeight: 700, color: HZ.ink }}>{openOpportunities}</div>
                    <div style={{ fontFamily: HZ.fontBody, fontSize: 10.5, color: HZ.inkMuted }}>Open Opportunities</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontFamily: HZ.fontDisplay, fontSize: 26, fontWeight: 700, color: HZ.ink }}>{draftQuotes}</div>
                    <div style={{ fontFamily: HZ.fontBody, fontSize: 10.5, color: HZ.inkMuted }}>Draft Quotes</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontFamily: HZ.fontDisplay, fontSize: 26, fontWeight: 700, color: HZ.gradCyan[0] }}>{sentQuotes.length}</div>
                    <div style={{ fontFamily: HZ.fontBody, fontSize: 10.5, color: HZ.inkMuted }}>Sent Quotes</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontFamily: HZ.fontDisplay, fontSize: 26, fontWeight: 700, color: HZ.good }}>
                      ${sentValueUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </div>
                    <div style={{ fontFamily: HZ.fontBody, fontSize: 10.5, color: HZ.inkMuted }}>Sent Value (USD)</div>
                  </div>
                </div>
              </div>
            );
          })()}
          </div>

          {/* Charts */}
          {chartData.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>
              <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 20, backdropFilter: "blur(18px)", padding: "20px 20px 14px" }}>
                <div style={{ marginBottom: 16 }}>
                  <h2 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: "0 0 3px" }}>TEU by Carrier</h2>
                  <p style={{ fontFamily: HZ.fontBody, fontSize: 11, color: HZ.inkMuted, margin: 0 }}>Awarded vs Confirmed/Pending/Rejected for the selected period</p>
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={chartData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={HZ.borderSoft} vertical={false} />
                    <XAxis dataKey="carrier" tick={{ fontFamily: HZ.fontMono, fontSize: 11, fill: HZ.inkMuted }} axisLine={{ stroke: HZ.border }} tickLine={false} />
                    <YAxis tick={{ fontFamily: HZ.fontBody, fontSize: 10, fill: HZ.inkMuted }} axisLine={false} tickLine={false} />
                    <Tooltip content={<TooltipContent />} cursor={{ fill: "rgba(255,255,255,0.06)" }} />
                    <Legend wrapperStyle={{ fontFamily: HZ.fontBody, fontSize: 11, color: HZ.inkMuted, paddingTop: 10 }} />
                    <Bar dataKey="confirmed" name="Confirmed" stackId="s" fill={HZ.good} />
                    <Bar dataKey="pending"   name="Pending"   stackId="s" fill={HZ.warning} />
                    <Bar dataKey="rejected"  name="Rejected"  stackId="s" fill={HZ.critical} />
                    <Bar dataKey="remaining" name="Remaining" stackId="s" fill="rgba(255,255,255,0.1)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{ background: HZ.surface, border: `1px solid ${HZ.border}`, borderRadius: 20, backdropFilter: "blur(18px)", padding: "20px 20px 14px" }}>
                <div style={{ marginBottom: 16 }}>
                  <h2 style={{ fontFamily: HZ.fontDisplay, fontSize: 15, fontWeight: 600, color: HZ.ink, margin: "0 0 3px" }}>6-Week TEU Trend</h2>
                  <p style={{ fontFamily: HZ.fontBody, fontSize: 11, color: HZ.inkMuted, margin: 0 }}>Weekly Confirmed consumption per carrier — last 6 weeks</p>
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={trendChartData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={HZ.borderSoft} vertical={false} />
                    <XAxis dataKey="week" tick={{ fontFamily: HZ.fontMono, fontSize: 10, fill: HZ.inkMuted }} axisLine={{ stroke: HZ.border }} tickLine={false} />
                    <YAxis tick={{ fontFamily: HZ.fontBody, fontSize: 10, fill: HZ.inkMuted }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "#0d1220", border: `1px solid ${HZ.border}`, borderRadius: 12, fontFamily: HZ.fontBody, fontSize: 12 }}
                      labelStyle={{ color: HZ.ink, fontWeight: 600, marginBottom: 4 }} itemStyle={{ color: HZ.inkMuted }}
                      formatter={(v, name) => [`${v} TEU`, name]} cursor={{ stroke: HZ.border, strokeWidth: 1 }} />
                    <Legend wrapperStyle={{ fontFamily: HZ.fontBody, fontSize: 11, color: HZ.inkMuted, paddingTop: 10 }} />
                    {trendCarriers.map((code, i) => (
                      <Line key={code} type="monotone" dataKey={code}
                        stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2}
                        dot={{ r: 3, fill: CHART_COLORS[i % CHART_COLORS.length] }} activeDot={{ r: 5 }} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Matched shipments — Central only, same principle Contract Consumption's own table
              already applies: a SPOT/Customer Own/Pending shipment never carries an allocationId,
              so it never contributes to any of the consumption figures above it on this tab, and
              listing it here just for it to say "No config match" only confuses the total against
              what those figures actually count. */}
          <MatchedShipmentsTable
            shipments={overviewCentralShipments.filter(s => !carrierFilterSet || carrierFilterSet.has(s.carrierCode))}
            containers={containers}
            carriers={carriers}
            activeAllocations={activeAllocations}
            teuDefs={teuDefs}
            carrierFilter={carrierFilter}
            availableCarriers={availableCarrierCodes}
            onCarrierFilterChange={setCarrierFilter}
          />
        </div>
      )}

      {/* ── Contract Consumption tab ── */}
      {view === "contracts" && (
        <div data-testid="dashboard-panel-contracts">
          <ContractConsumptionView
            rangeShipments={rangeShipments}
            containers={containers}
            carriers={carriers}
            allocations={activeAllocations}
            teuDefs={teuDefs}
            contractTrendData={contractTrendData}
          />
        </div>
      )}

      {/* ── Carrier Volumes tab ── */}
      {view === "carriers" && (
        <div data-testid="dashboard-panel-carriers">
          <CarrierView
            rangeShipments={rangeShipments}
            containers={containers}
            carriers={carriers}
            carrierTrends={rawCarrierTrends}
            rangeStart={rangeStart}
          />
        </div>
      )}

      {/* ── Margin tab ── */}
      {view === "margin" && (
        <div data-testid="dashboard-panel-margin"><MarginView financeEnabled={financeEnabled} /></div>
      )}

      {/* ── Compliance Review tab ── */}
      {view === "compliance" && (
        <div data-testid="dashboard-panel-compliance">
          <ComplianceReviewView
            compHits={compHits}
            custHits={custHits}
            loading={compLoading}
            onRefresh={loadCompliance}
          />
        </div>
      )}

      </div>
    </div>
  );
};

export default DashboardPage;