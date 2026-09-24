import { useState, useEffect, useCallback } from "react";
import { api } from "../../api";
import Spinner from "../../components/primitives/Spinner";
import Pagination from "../../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../../components/primitives/PageSizeSelect";
import { EVENT_CONFIG, getEventSummary, fmtDateTime } from "./ShipmentDetailPage";
import { AnyIcon, IconArrowDown, IconArrowUp } from "../../components/primitives/Icon";
import { HZ, HZ_MONO, HZ_BODY, useHorizonFonts } from "./shipmentDetailTheme";

// ─── Shipment History Page ─────────────────────────────────────────────────
// Promoted out of the Overview page's CompactHistory/HistoryModal (client-side
// pagination over a fully-fetched event array) into its own page using the
// same server-side {results, total, limit, offset} contract every other list
// page in the app uses — types/date-range/search filter server-side too, so
// `total` (and the Pagination control) always reflect what's actually being
// paged through.
//
// Trade Horizon "New Style" pass (same treatment as Cargo/Accounting — approved
// mockup https://claude.ai/artifact/25ygL745mmMfvYWBXZWoAE): a stat strip above a
// real <table>, replacing the flex-row fake table. EVENT_CONFIG's own colors
// (ShipmentDetailPage.jsx, this page's only real consumer) were migrated to HZ
// alongside this.

const TYPE_GROUPS = {
  Shipment:     ["SHIPMENT_CREATED", "STATUS_CHANGED", "CONTRACT_DROPPED", "SPACE_SKIPPED", "SPACE_OVERAGE"],
  Fields:       ["FIELD_UPDATED"],
  Container:    ["CONTAINER_ADDED", "CONTAINER_REMOVED", "CONTAINER_UPDATED", "CONTAINER_EVENT_ADDED"],
  Compliance:   ["COMPLIANCE_HIT"],
  "Cost Lines": ["COST_LINE_ADDED", "COST_LINE_UPDATED", "COST_LINE_REMOVED"],
  Parties:      ["PARTY_ASSIGNED", "PARTY_REASSIGNED", "PARTY_REMOVED", "SIDE_OFFICE_ADDED", "SIDE_OFFICE_REMOVED",
                 "OFFICE_REASSIGNED", "LINE_AGENT_AUTO_ASSIGNED"],
  Schedule:     ["SCHEDULE_ASSIGNED", "SCHEDULE_UPDATED", "SCHEDULE_REMOVED"],
  Services:     ["SERVICE_ORDERED", "SERVICE_UPDATED", "SERVICE_REMOVED"],
  Documents:    ["DOCUMENT_GENERATED", "DOCUMENT_GENERATION_ATTEMPTED", "DOCUMENT_GENERATION_FAILED"],
};
const GROUP_NAMES = Object.keys(TYPE_GROUPS);
const DATE_RANGE_LABEL = { all: "All time", today: "Today", "7d": "7 days" };

const ShipmentHistoryPage = ({ shipment }) => {
  const [activeGroups, setActiveGroups] = useState(() => new Set(GROUP_NAMES));
  const [dateRange, setDateRange] = useState("all");
  const [search, setSearch] = useState("");
  const [sortDir, setSortDir] = useState("desc");
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(getStoredPageSize);
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

  const load = useCallback((off = 0, lim = limit) => {
    setLoading(true);
    // Every group selected (the default) means "show everything" — sending an explicit types
    // allowlist here would silently hide any event type not yet added to a TYPE_GROUPS entry
    // above, which is exactly what happened before this fix: several real event types (contract
    // drops, schedule/service/party changes) were being logged to shipment_events all along but
    // never showed up on this tab because nobody remembered to list them here. Only narrow the
    // query once the user has actually deselected a group.
    const allSelected = activeGroups.size === GROUP_NAMES.length;
    const types = allSelected ? "" : GROUP_NAMES.filter(g => activeGroups.has(g)).flatMap(g => TYPE_GROUPS[g]).join(",");
    api.shipmentEvents.list(shipment.id, {
      limit: lim, offset: off, types, sort: sortDir,
      ...(dateRange !== "all" && { dateRange }),
      ...(search.trim() && { search: search.trim() }),
    }).then(r => {
      setResults(r.results || []);
      setTotal(r.total || 0);
      setOffset(off);
    }).catch(() => { setResults([]); setTotal(0); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipment.id, activeTypesKey, dateRange, search, sortDir, limit]);

  useEffect(() => { load(0); }, [load]);

  const changeLimit = n => { setLimit(n); load(0, n); };

  const exportCSV = () => {
    const rows = [["Event Type", "Summary", "Date/Time", "User"]];
    results.forEach(ev => rows.push([
      EVENT_CONFIG[ev.eventType]?.label || ev.eventType,
      `"${getEventSummary(ev).replace(/"/g, '""')}"`,
      fmtDateTime(ev.occurredAt),
      ev.actor || "system",
    ]));
    const csv = rows.map(r => r.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${shipment.id}-history-p${Math.floor(offset / limit) + 1}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const inp = { fontFamily: HZ_BODY, fontSize: 12, color: HZ.text, background: HZ.bg,
    border: `1px solid ${HZ.border}`, borderRadius: 7, padding: "5px 10px", outline: "none" };
  const pageCount = Math.max(1, Math.ceil(total / limit));

  useHorizonFonts();

  return (
    <div id="shphist-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Stat strip — same New Style treatment as Cargo/Accounting (approved mockup:
          https://claude.ai/artifact/25ygL745mmMfvYWBXZWoAE). */}
      <div id="shphist-stat-strip" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        {[
          ["Events", loading ? "—" : `${total}`],
          ["Page", `${Math.floor(offset / limit) + 1} / ${pageCount}`],
          ["Types Shown", `${activeGroups.size}/${GROUP_NAMES.length}`],
          ["Date Range", DATE_RANGE_LABEL[dateRange]],
        ].map(([label, value]) => (
          <div key={label} style={{ background: HZ.bg, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow,
            borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontFamily: HZ_BODY, fontSize: 10, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontFamily: HZ_MONO, fontSize: 16, fontWeight: 700, color: HZ.text, marginTop: 2 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div id="shphist-toolbar" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {GROUP_NAMES.map(g => {
          const on = activeGroups.has(g);
          return (
            <button key={g} id={`shphist-group-${g.toLowerCase().replace(/\s+/g, "-")}`} type="button" onClick={() => toggleGroup(g)}
              style={{ fontFamily: HZ_BODY, fontSize: 11, padding: "3px 10px", borderRadius: 20,
                border: `1px solid ${on ? HZ.cyan + "66" : HZ.border}`,
                background: on ? HZ.cyanBg : "transparent",
                color: on ? HZ.cyan : HZ.textMuted, cursor: "pointer" }}>
              {g}
            </button>
          );
        })}
        <div style={{ width: 1, height: 18, background: HZ.border, flexShrink: 0 }} />
        <div id="shphist-date-range" style={{ display: "flex", borderRadius: 7, overflow: "hidden", border: `1px solid ${HZ.border}` }}>
          {[["all", "All time"], ["today", "Today"], ["7d", "7 days"]].map(([r, label], idx) => (
            <button key={r} type="button" onClick={() => setDateRange(r)}
              style={{ fontFamily: HZ_BODY, fontSize: 11, padding: "4px 10px",
                background: dateRange === r ? HZ.cyan : "transparent",
                color: dateRange === r ? "#06111f" : HZ.textMuted,
                border: "none", borderRight: idx < 2 ? `1px solid ${HZ.border}` : "none", cursor: "pointer" }}>
              {label}
            </button>
          ))}
        </div>
        <input id="shphist-search" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search events…" style={{ ...inp, minWidth: 180 }} />
        <div style={{ flex: 1 }} />
        <button id="shphist-export-btn" type="button" onClick={exportCSV} disabled={results.length === 0}
          style={{ ...inp, cursor: results.length === 0 ? "default" : "pointer",
            color: results.length === 0 ? HZ.textFaint : HZ.textMuted, padding: "5px 12px",
            display: "inline-flex", alignItems: "center", gap: 5 }}>
          <IconArrowDown size={12} /> Export page as CSV
        </button>
      </div>

      {/* Table */}
      <div id="shphist-table" style={{ background: HZ.surface, backdropFilter: "blur(20px)",
        border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 40, display: "flex", justifyContent: "center" }}><Spinner /></div>
        ) : results.length === 0 ? (
          <div id="shphist-empty" style={{ padding: 32, textAlign: "center", fontFamily: HZ_BODY,
            fontSize: 13, color: HZ.textMuted, fontStyle: "italic" }}>
            No events match the current filters.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: HZ.bg, borderBottom: `1px solid ${HZ.border}` }}>
                <th style={{ textAlign: "left", padding: "9px 14px", width: 170, fontFamily: HZ_BODY, fontSize: 10,
                  fontWeight: 700, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: ".06em" }}>Event Type</th>
                <th style={{ textAlign: "left", padding: "9px 14px", fontFamily: HZ_BODY, fontSize: 10,
                  fontWeight: 700, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: ".06em" }}>Summary</th>
                <th onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")}
                  style={{ textAlign: "left", padding: "9px 14px", width: 170, cursor: "pointer", userSelect: "none",
                    fontFamily: HZ_BODY, fontSize: 10, fontWeight: 700, color: HZ.textMuted,
                    textTransform: "uppercase", letterSpacing: ".06em" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    Date / Time {sortDir === "desc" ? <IconArrowDown size={11} /> : <IconArrowUp size={11} />}
                  </span>
                </th>
                <th style={{ textAlign: "left", padding: "9px 14px", width: 120, fontFamily: HZ_BODY, fontSize: 10,
                  fontWeight: 700, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: ".06em" }}>User</th>
              </tr>
            </thead>
            <tbody>
              {results.map(ev => {
                const cfg = EVENT_CONFIG[ev.eventType] ?? { icon: "·", label: ev.eventType, color: () => HZ.textMuted };
                const color = cfg.color();
                return (
                  <tr key={ev.id} id={`shphist-event-${ev.id}`} style={{ borderBottom: `1px solid ${HZ.border}` }}>
                    <td style={{ padding: "9px 14px" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13, display: "inline-flex", alignItems: "center", color }}><AnyIcon icon={cfg.icon} size={13} /></span>
                        <span style={{ fontFamily: HZ_BODY, fontSize: 11, fontWeight: 600, color }}>{cfg.label}</span>
                      </span>
                    </td>
                    <td style={{ padding: "9px 14px", fontFamily: HZ_MONO, fontSize: 11, color: HZ.textMuted,
                      maxWidth: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {getEventSummary(ev)}
                    </td>
                    <td style={{ padding: "9px 14px", fontFamily: HZ_MONO, fontSize: 11, color: HZ.textFaint }}>
                      {fmtDateTime(ev.occurredAt)}
                    </td>
                    <td title={ev.actor || ""} style={{ padding: "9px 14px", fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {ev.actor && ev.actor !== "system" ? ev.actor : "System"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div id="shphist-pagination" style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <PageSizeSelect value={limit} onChange={changeLimit} />
        <div style={{ flex: 1 }}><Pagination total={total} limit={limit} offset={offset} onPage={load} /></div>
      </div>
    </div>
  );
};

export default ShipmentHistoryPage;
