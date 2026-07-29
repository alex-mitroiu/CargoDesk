import { useState, useEffect, useCallback } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import Spinner from "../../components/primitives/Spinner";
import Pagination from "../../components/primitives/Pagination";
import { EVENT_CONFIG, getEventSummary, fmtDateTime } from "./ShipmentDetailPage";
import { AnyIcon, IconArrowDown, IconArrowUp } from "../../components/primitives/Icon";

// ─── Shipment History Page ─────────────────────────────────────────────────
// Promoted out of the Overview page's CompactHistory/HistoryModal (client-side
// pagination over a fully-fetched event array) into its own page using the
// same server-side {results, total, limit, offset} contract every other list
// page in the app uses — types/date-range/search filter server-side too, so
// `total` (and the Pagination control) always reflect what's actually being
// paged through.

const LIMIT = 25;

const TYPE_GROUPS = {
  Shipment:     ["SHIPMENT_CREATED", "STATUS_CHANGED"],
  Fields:       ["FIELD_UPDATED"],
  Container:    ["CONTAINER_ADDED", "CONTAINER_REMOVED", "CONTAINER_UPDATED"],
  Compliance:   ["COMPLIANCE_HIT"],
  "Cost Lines": ["COST_LINE_ADDED", "COST_LINE_UPDATED", "COST_LINE_REMOVED"],
};
const GROUP_NAMES = Object.keys(TYPE_GROUPS);

const ShipmentHistoryPage = ({ shipment }) => {
  const [activeGroups, setActiveGroups] = useState(() => new Set(GROUP_NAMES));
  const [dateRange, setDateRange] = useState("all");
  const [search, setSearch] = useState("");
  const [sortDir, setSortDir] = useState("desc");
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  // Deselecting every group would send types="" to the backend, which reads as
  // "no type filter" (show everything) rather than "show nothing" — block it
  // rather than silently doing the opposite of what an empty toolbar implies.
  const toggleGroup = g => setActiveGroups(prev => {
    if (prev.has(g) && prev.size === 1) return prev;
    const next = new Set(prev);
    next.has(g) ? next.delete(g) : next.add(g);
    return next;
  });

  const activeTypesKey = GROUP_NAMES.filter(g => activeGroups.has(g)).join(",");

  const load = useCallback((off = 0) => {
    setLoading(true);
    const types = GROUP_NAMES.filter(g => activeGroups.has(g)).flatMap(g => TYPE_GROUPS[g]).join(",");
    api.shipmentEvents.list(shipment.id, {
      limit: LIMIT, offset: off, types, sort: sortDir,
      ...(dateRange !== "all" && { dateRange }),
      ...(search.trim() && { search: search.trim() }),
    }).then(r => {
      setResults(r.results || []);
      setTotal(r.total || 0);
      setOffset(off);
    }).catch(() => { setResults([]); setTotal(0); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipment.id, activeTypesKey, dateRange, search, sortDir]);

  useEffect(() => { load(0); }, [load]);

  const exportCSV = () => {
    const rows = [["Event Type", "Summary", "Date/Time", "Actor"]];
    results.forEach(ev => rows.push([
      EVENT_CONFIG[ev.eventType]?.label || ev.eventType,
      `"${getEventSummary(ev).replace(/"/g, '""')}"`,
      fmtDateTime(ev.occurredAt),
      ev.actor || "system",
    ]));
    const csv = rows.map(r => r.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${shipment.id}-history-p${Math.floor(offset / LIMIT) + 1}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const th  = { fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em" };
  const inp = { fontFamily: T.body, fontSize: 12, color: T.text, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, padding: "5px 10px", outline: "none" };

  return (
    <div id="shphist-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Toolbar */}
      <div id="shphist-toolbar" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {GROUP_NAMES.map(g => {
          const on = activeGroups.has(g);
          return (
            <button key={g} id={`shphist-group-${g.toLowerCase().replace(/\s+/g, "-")}`} type="button" onClick={() => toggleGroup(g)}
              style={{ fontFamily: T.body, fontSize: 11, padding: "3px 10px", borderRadius: 20,
                border: `1px solid ${on ? T.accent + "66" : T.border}`,
                background: on ? T.accentBg : "transparent",
                color: on ? T.accent : T.textMuted, cursor: "pointer" }}>
              {g}
            </button>
          );
        })}
        <div style={{ width: 1, height: 18, background: T.border, flexShrink: 0 }} />
        <div id="shphist-date-range" style={{ display: "flex", borderRadius: 7, overflow: "hidden", border: `1px solid ${T.border}` }}>
          {[["all", "All time"], ["today", "Today"], ["7d", "7 days"]].map(([r, label], idx) => (
            <button key={r} type="button" onClick={() => setDateRange(r)}
              style={{ fontFamily: T.body, fontSize: 11, padding: "4px 10px",
                background: dateRange === r ? T.accent : "transparent",
                color: dateRange === r ? T.btnPrimaryText : T.textMuted,
                border: "none", borderRight: idx < 2 ? `1px solid ${T.border}` : "none", cursor: "pointer" }}>
              {label}
            </button>
          ))}
        </div>
        <input id="shphist-search" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search events…" style={{ ...inp, minWidth: 180 }} />
        <div style={{ flex: 1 }} />
        <button id="shphist-export-btn" type="button" onClick={exportCSV} disabled={results.length === 0}
          style={{ ...inp, cursor: results.length === 0 ? "default" : "pointer",
            color: results.length === 0 ? T.border : T.textMuted, padding: "5px 12px",
            display: "inline-flex", alignItems: "center", gap: 5 }}>
          <IconArrowDown size={12} /> Export page as CSV
        </button>
      </div>

      <div id="shphist-count" style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 10 }}>
        {loading ? "Loading…" : `${total} event${total !== 1 ? "s" : ""}`}
      </div>

      {/* Table */}
      <div id="shphist-table" style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface }}>
        <div style={{ display: "flex", alignItems: "center", padding: "7px 14px",
          borderBottom: `1px solid ${T.border}`, background: T.bg, gap: 10 }}>
          <div style={{ ...th, width: 160, flexShrink: 0 }}>Event Type</div>
          <div style={{ ...th, flex: 1 }}>Summary</div>
          <div style={{ ...th, width: 160, flexShrink: 0, cursor: "pointer", userSelect: "none",
            display: "flex", alignItems: "center", gap: 4 }}
            onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")}>
            Date / Time {sortDir === "desc" ? <IconArrowDown size={11} /> : <IconArrowUp size={11} />}
          </div>
          <div style={{ ...th, width: 90, flexShrink: 0 }}>Actor</div>
        </div>

        {loading ? (
          <div style={{ padding: 40, display: "flex", justifyContent: "center" }}><Spinner /></div>
        ) : results.length === 0 ? (
          <div id="shphist-empty" style={{ padding: 32, textAlign: "center", fontFamily: T.body,
            fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
            No events match the current filters.
          </div>
        ) : results.map(ev => {
          const cfg = EVENT_CONFIG[ev.eventType] ?? { icon: "·", label: ev.eventType, color: () => T.textMuted };
          const color = cfg.color();
          return (
            <div key={ev.id} id={`shphist-event-${ev.id}`}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px",
                borderBottom: `1px solid ${T.border}22` }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ width: 160, flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, display: "inline-flex", alignItems: "center" }}><AnyIcon icon={cfg.icon} size={13} /></span>
                <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color }}>{cfg.label}</span>
              </div>
              <div style={{ flex: 1, fontFamily: T.mono, fontSize: 11, color: T.textMuted,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {getEventSummary(ev)}
              </div>
              <div style={{ width: 160, flexShrink: 0, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                {fmtDateTime(ev.occurredAt)}
              </div>
              <div style={{ width: 90, flexShrink: 0, fontFamily: T.body, fontSize: 11, color: T.textMuted,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {ev.actor || "—"}
              </div>
            </div>
          );
        })}
      </div>

      <div id="shphist-pagination">
        <Pagination total={total} limit={LIMIT} offset={offset} onPage={load} />
      </div>
    </div>
  );
};

export default ShipmentHistoryPage;
