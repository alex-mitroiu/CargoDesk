import { useState, useEffect, useRef } from "react";
import { T, STATUSES, statusVariant, contractVariant, teuOf } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { ConfirmModal } from "../../components/primitives/Modal";
import { inputBase } from "../../components/primitives/Form";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns";
import ActionMenu from "../../components/primitives/ActionMenu";
import EntityHistoryModal from "../../components/shared/EntityHistoryModal";
import ExportFieldsModal, { ALL_EXPORT_FIELDS } from "../../components/shared/ExportFieldsModal";
import Pagination from "../../components/primitives/Pagination";
import { IconRefresh, IconDownload, IconClose, IconWarning, IconTime, IconEye, IconClipboard }
  from "../../components/primitives/Icon";

const PAGE_SIZE = 50;

const SORT_OPTIONS = [
  { value: "",         label: "Default order" },
  { value: "etd_asc",  label: "ETD ↑ earliest" },
  { value: "etd_desc", label: "ETD ↓ latest" },
  { value: "eta_asc",  label: "ETA ↑ earliest" },
  { value: "teu_desc", label: "TEU ↓ largest" },
  { value: "status",   label: "Status A–Z" },
];

const STATUS_CHIPS = ["Active", "Pending", "Requires Review", "Completed", "Cancelled"];

const ShipmentsPage = ({ shipments, containers, carriers, onSelect, onDelete, onNew, onRefresh, financeEnabled = true }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [confirm,         setConfirm]         = useState(null);
  const [historyShipment, setHistoryShipment] = useState(null);
  const [filters,         setFilters]         = useState(() => {
    try {
      const pending = sessionStorage.getItem("cc_filter");
      if (pending) { sessionStorage.removeItem("cc_filter"); return { search: '', carrier: '', ...JSON.parse(pending) }; }
    } catch { /* ignore */ }
    return { search: '', status: '', carrier: '' };
  });
  const [sort,            setSort]            = useState("");
  const [exporting,       setExporting]       = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [staleCount,      setStaleCount]      = useState(0);
  const [refreshing,      setRefreshing]      = useState(false);
  const [offset,          setOffset]          = useState(0);
  const knownIdsRef = useRef(new Set(shipments.map(s => s.id)));

  // A new filter/sort can shrink the result set below the page a user was already on —
  // reset to page 1 whenever the filtered set's shape changes, not just on mount.
  useEffect(() => { setOffset(0); }, [filters.search, filters.status, filters.carrier, sort]);

  // Sync known IDs when parent pushes a fresh list (after manual refresh or other updates)
  useEffect(() => {
    knownIdsRef.current = new Set(shipments.map(s => s.id));
    setStaleCount(0);
  }, [shipments]);

  // Poll every 90 s for new shipments the parent hasn't loaded yet
  useEffect(() => {
    if (!onRefresh) return;
    const id = setInterval(async () => {
      try {
        const fresh = await api.shipments.list();
        const newIds = fresh.filter(s => !knownIdsRef.current.has(s.id));
        if (newIds.length > 0) setStaleCount(newIds.length);
      } catch { /* silent */ }
    }, 90_000);
    return () => clearInterval(id);
  }, [onRefresh]);

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  };

  // Remembers the operator's field selection across visits (same localStorage-preference idiom
  // as cd_theme/cd_navfold_*/cargodesk_wip_limits elsewhere in this app) — falls back to "every
  // field" the first time, matching the old one-click button's behavior exactly so nobody's
  // export silently gets narrower just because this feature shipped.
  const EXPORT_FIELDS_KEY = "cargodesk_export_fields";

  const handleExportCSV = async fields => {
    setExporting(true);
    try {
      await api.export.shipmentsCSV(fields);
      try { localStorage.setItem(EXPORT_FIELDS_KEY, JSON.stringify(fields)); } catch { /* ignore */ }
      toast.success("CSV downloaded");
      setExportModalOpen(false);
    } catch (e) { toast.error(e.message); }
    finally { setExporting(false); }
  };

  const openExportModal = () => setExportModalOpen(true);

  const savedExportFields = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(EXPORT_FIELDS_KEY) || "null");
      return Array.isArray(raw) && raw.length ? raw : ALL_EXPORT_FIELDS;
    } catch { return ALL_EXPORT_FIELDS; }
  };

  const teuFor = id => containers.filter(c => c.shipmentId === id).reduce((s, c) => s + teuOf(c.size), 0);
  const { template: shipTemplate, startResize: shipStartResize } = useResizableColumns("shipments", [140,70,70,80,100,150,165,46,60,80,90]);
  const shipHeaders = ["Shipment ID","POL","POD","Routing Term","Trade Lane","Carrier","Contract","TEU","Status","Margin","Actions"];

  const today = new Date().toISOString().slice(0, 10);
  const filtered = shipments.filter(s => {
    if (filters.status === "_overdue") {
      if (!s.etd || s.etd >= today) return false;
      if (s.status === "Completed" || s.status === "Cancelled") return false;
    } else if (filters.status) {
      if (s.status !== filters.status) return false;
    }
    if (filters.carrier && s.carrierCode !== filters.carrier) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!s.id.toLowerCase().includes(q)
        && !s.pol.toLowerCase().includes(q)
        && !s.pod.toLowerCase().includes(q)
        && !(s.seaPol || '').toLowerCase().includes(q)
        && !(s.seaPod || '').toLowerCase().includes(q)
        && !(s.bookingRef || '').toLowerCase().includes(q)
        && !(s.blNumber   || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const hasFilters = !!(filters.search || filters.status || filters.carrier);

  const teuFor2 = s => containers.filter(c => c.shipmentId === s.id).reduce((n, c) => n + teuOf(c.size), 0);
  const displayed = sort === "etd_asc"  ? [...filtered].sort((a,b) => (a.etd||"9").localeCompare(b.etd||"9"))
                  : sort === "etd_desc" ? [...filtered].sort((a,b) => (b.etd||"0").localeCompare(a.etd||"0"))
                  : sort === "eta_asc"  ? [...filtered].sort((a,b) => (a.eta||"9").localeCompare(b.eta||"9"))
                  : sort === "teu_desc" ? [...filtered].sort((a,b) => teuFor2(b) - teuFor2(a))
                  : sort === "status"   ? [...filtered].sort((a,b) => (a.status||"").localeCompare(b.status||""))
                  : filtered;

  const pageItems = displayed.slice(offset, offset + PAGE_SIZE);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Shipments</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {hasFilters ? `${displayed.length} of ${shipments.length}` : shipments.length} total
            · {shipments.filter(s => s.status === "Active").length} active
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Refresh button — badge lights up when poll detects new shipments */}
          <div style={{ position: "relative" }}>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title={staleCount > 0 ? `${staleCount} new shipment${staleCount > 1 ? "s" : ""} available` : "Refresh shipments"}
              style={{ background: "none", border: `1px solid ${staleCount > 0 ? T.accent : T.border}`,
                borderRadius: 6, padding: "5px 9px", cursor: refreshing ? "wait" : "pointer",
                fontFamily: T.mono, fontSize: 14, color: staleCount > 0 ? T.accent : T.textMuted,
                lineHeight: 1, display: "flex", alignItems: "center", gap: 5,
                transition: "border-color .15s, color .15s" }}
              onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}}
              onMouseLeave={e => { e.currentTarget.style.borderColor = staleCount > 0 ? T.accent : T.border; e.currentTarget.style.color = staleCount > 0 ? T.accent : T.textMuted; }}>
              <IconRefresh size={13} />
            </button>
            {staleCount > 0 && (
              <span style={{ position: "absolute", top: -6, right: -6,
                background: T.accent, color: "#fff", borderRadius: "50%",
                fontSize: 9, fontWeight: 700, fontFamily: T.mono,
                minWidth: 16, height: 16, display: "flex", alignItems: "center",
                justifyContent: "center", padding: "0 3px", lineHeight: 1,
                boxShadow: `0 0 0 2px ${T.bg}` }}>
                {staleCount}
              </span>
            )}
          </div>
          <Btn onClick={openExportModal} size="sm" variant="ghost" disabled={exporting || shipments.length === 0}>
            {exporting ? "Exporting…" : <><IconDownload size={12} />CSV</>}
          </Btn>
          {canEdit && <Btn onClick={onNew} size="lg" disabled={carriers.length === 0}>＋ New Shipment</Btn>}
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 10, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={filters.search}
          onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
          placeholder="Search ID, POL, POD, booking ref…"
          style={{ ...inputBase, flex: "1 1 200px", minWidth: 160 }}
        />
        <select
          value={filters.carrier}
          onChange={e => setFilters(f => ({ ...f, carrier: e.target.value }))}
          style={{ ...inputBase, width: 180, cursor: "pointer" }}
        >
          <option value="">All carriers</option>
          {carriers.map(c => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}
        </select>
        <select
          value={sort}
          onChange={e => setSort(e.target.value)}
          style={{ ...inputBase, width: 160, cursor: "pointer" }}
        >
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {(hasFilters || sort) && (
          <button
            onClick={() => { setFilters({ search: '', status: '', carrier: '' }); setSort(""); }}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
              color: T.textMuted, cursor: "pointer", padding: "6px 12px",
              fontFamily: T.body, fontSize: 12, whiteSpace: "nowrap",
              display: "inline-flex", alignItems: "center", gap: 5 }}>
            <IconClose size={11} />Clear
          </button>
        )}
      </div>

      {/* Quick-status chips */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {["", ...STATUS_CHIPS, "_overdue"].map(s => {
          const active = filters.status === s;
          const colors = { Active:"#22c55e", Pending:"#f59e0b", "Requires Review":"#ef4444",
                           Completed:"#3b82f6", Cancelled:"#64748b", _overdue:"#ef4444" };
          const label = s === "_overdue" ? <><IconTime size={11} />Overdue</> : (s || "All");
          const col = s ? colors[s] || T.accent : T.textMuted;
          return (
            <button key={s || "all"} type="button"
              onClick={() => setFilters(f => ({ ...f, status: s }))}
              style={{ padding:"3px 11px", borderRadius:20,
                border:`1px solid ${active ? col : T.border}`,
                background: active ? `${col}18` : "none",
                cursor:"pointer", fontFamily: T.body, fontSize: 11.5,
                color: active ? col : T.textMuted, fontWeight: active ? 600 : 400,
                transition:"all .12s", whiteSpace:"nowrap",
                display: "inline-flex", alignItems: "center", gap: 4 }}>
              {label}
              {s && s !== "_overdue" && (() => {
                const cnt = shipments.filter(x => x.status === s).length;
                return cnt > 0 ? (
                  <span style={{ marginLeft:5, fontFamily: T.mono, fontSize:10,
                    color: active ? col : T.border }}>
                    {cnt}
                  </span>
                ) : null;
              })()}
            </button>
          );
        })}
      </div>

      {carriers.length === 0 && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8,
          padding: "12px 18px", fontFamily: T.body, fontSize: 13, color: T.warning, marginBottom: 18,
          display: "flex", alignItems: "center", gap: 8 }}>
          <IconWarning size={13} />
          <span>Carrier Registry is empty. Go to <strong>Carrier Registry</strong> and add at least one carrier before creating shipments.</span>
        </div>
      )}

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: shipTemplate,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {shipHeaders.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < shipHeaders.length - 1 && <ColResizer onStart={e => shipStartResize(i, e)} />}
            </div>
          ))}
        </div>

        {displayed.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            {hasFilters ? "No shipments match your filters." : "No shipments yet. Create your first one above."}
          </div>
        ) : pageItems.map(s => {
          const carrier = carriers.find(c => c.code === s.carrierCode);
          return (
            <div key={s.id} onDoubleClick={() => window.open(`#shipments/${s.id}`, "_blank")}
              title="Double-click to open"
              style={{ display: "grid", gridTemplateColumns: shipTemplate,
                padding: "14px 20px", borderBottom: `1px solid ${T.border}22`,
                cursor: "pointer", alignItems: "center", transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textCode, fontWeight: 700 }}>{s.id}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}
                title={s.seaPol && s.seaPol !== s.pol ? `Door pickup: ${s.pol}${s.polName ? ` (${s.polName})` : ""}` : undefined}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.seaPol || s.pol}</span>
                {(s.seaPolName || s.polName) && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{s.seaPolName || s.polName}</span>}
                {s.seaPol && s.seaPol !== s.pol && (
                  <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border }}>Door: {s.pol}</span>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}
                title={s.seaPod && s.seaPod !== s.pod ? `Final delivery: ${s.pod}${s.podName ? ` (${s.podName})` : ""}` : undefined}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.seaPod || s.pod}</span>
                {(s.seaPodName || s.podName) && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{s.seaPodName || s.podName}</span>}
                {s.seaPod && s.seaPod !== s.pod && (
                  <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border }}>→ {s.pod}</span>
                )}
              </div>
              <div>
                {s.routingTerm
                  ? <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, background: `${T.border}50`, borderRadius: 4, padding: "2px 6px", whiteSpace: "nowrap" }}>{s.routingTerm}</span>
                  : <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>}
              </div>
              <div>
                {s.tradeLane
                  ? <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 600, color: T.text, whiteSpace: "nowrap" }}>{s.tradeLane}</span>
                  : <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{s.carrierCode}</span>
                {carrier && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{carrier.name}</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "center" }}>
                <Badge variant={contractVariant(s.contractType)}>{s.contractType}</Badge>
                {s.contractRef && <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>{s.contractRef}</span>}
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>{teuFor(s.id)}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "center" }}>
                <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                {s.overdueCount > 0 && (
                  <Badge variant="danger" size={9.5}>{s.overdueCount} overdue</Badge>
                )}
                {s.bookingStatus === "Pending" && (
                  <Badge variant="info" size={9.5}>Booking pending</Badge>
                )}
                {s.bookingStatus === "Rejected" && (
                  <Badge variant="danger" size={9.5}>Booking rejected</Badge>
                )}
              </div>
              <div>{(() => {
                if (!financeEnabled) return null;
                const buy = s.marginBuyUsd || 0, sell = s.marginSellUsd || 0;
                if (buy === 0 && sell === 0) return <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>;
                const gp  = sell - buy;
                const pct = sell > 0 ? Math.round((gp / sell) * 1000) / 10 : null;
                const col = pct == null ? T.textMuted : pct >= 20 ? T.success : pct >= 10 ? T.warning : T.danger;
                return (
                  <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                    color: col, background: `${col}18`, borderRadius: 6, padding: "2px 8px",
                    border: `1px solid ${col}33` }}>
                    {pct != null ? `${pct}%` : "—"}
                  </span>
                );
              })()}</div>
              <div onClick={e => e.stopPropagation()}>
                <ActionMenu items={[
                  { icon: IconEye,       label: "Open",    onClick: () => window.open(`#shipments/${s.id}`, "_blank") },
                  { icon: IconClipboard, label: "History", onClick: () => setHistoryShipment(s) },
                  ...(canEdit ? [{ icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(s.id) }] : []),
                ]} />
              </div>
            </div>
          );
        })}
      </div>

      <Pagination total={displayed.length} offset={offset} limit={PAGE_SIZE} onPage={setOffset} />

      {confirm && (
        <ConfirmModal
          message={`Remove shipment ${confirm} and all its containers? This cannot be undone.`}
          onConfirm={() => { onDelete(confirm); setConfirm(null); }}
          onCancel={() => setConfirm(null)} />
      )}
      {historyShipment && (
        <EntityHistoryModal
          entityType="shipment"
          entityId={historyShipment.id}
          title={`History — ${historyShipment.id}`}
          headerContent={
            <>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{historyShipment.id}</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{historyShipment.pol} → {historyShipment.pod}</span>
              {historyShipment.carrierCode && <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{historyShipment.carrierCode}</span>}
              {historyShipment.etd && <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>ETD {historyShipment.etd}</span>}
            </>
          }
          onClose={() => setHistoryShipment(null)} />
      )}
      {exportModalOpen && (
        <ExportFieldsModal
          initialSelected={savedExportFields()}
          onExport={handleExportCSV}
          onClose={() => setExportModalOpen(false)} />
      )}
    </div>
  );
};

export default ShipmentsPage;
