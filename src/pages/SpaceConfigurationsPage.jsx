import SpaceConfigurationForm from "../components/spaceConfig/SpaceConfigurationForm";
import { useState, useEffect, useMemo, useRef } from "react";
import useSaving from "../hooks/useSaving";
import { T, addDays, diffDays, teuOf, buildTeuLookup, LANE_BADGE_VARIANT, todayIso, statusVariant, contractVariant,
  buildLinkedPortIndex, matchedLegFor, allocationRouteMatch } from "../tokens";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Inp, Sel, Textarea, Field } from "../components/primitives/Form";
import PortField from "../components/shared/PortField";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import Spinner from "../components/primitives/Spinner";
import DatePicker from "../components/primitives/DatePicker";
import EntityHistoryModal from "../components/shared/EntityHistoryModal";
import ConsumptionBar from "../components/shared/ConsumptionBar";
import LanePill from "../components/shared/LanePill";
import DataTable, { TableToolbar } from "../components/shared/DataTable";
import useTableQuery from "../hooks/useTableQuery";
import { queryRows, filterOptions } from "../utils/localTableQuery";
import { buildSpaceRows, portLookupsNeeded, SPACE_COLUMNS, SPACE_FILTER_KEYS, SPACE_SORT_OPTIONS, SPACE_SPEC } from "../utils/spaceConfigTable";
import { IconCheck, IconClose, IconPencil, IconWarning, IconForbid, IconLink,
  IconClipboard, IconArchive, IconSettings, IconSearch } from "../components/primitives/Icon";

// ─── Config ID chip with copy-to-clipboard ───────────────────────────────────
const IdChip = ({ id }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(id).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
      <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
        textTransform: "uppercase", letterSpacing: ".08em", flexShrink: 0 }}>Config ID</span>
      <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700,
        letterSpacing: ".04em" }}>{id}</span>
      <button type="button" onClick={copy}
        style={{ background: copied ? T.success + "22" : "none",
          border: `1px solid ${copied ? T.success : T.border}`,
          borderRadius: 4, cursor: "pointer",
          fontFamily: T.mono, fontSize: 10,
          color: copied ? T.success : T.textMuted,
          padding: "2px 8px", transition: "all .15s", flexShrink: 0 }}>
        {copied ? <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><IconCheck size={9} />copied</span> : "copy"}
      </button>
    </div>
  );
};

// ─── Lane pair display ────────────────────────────────────────────────────────

const LanePair = ({ origin, dest }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    {origin
      ? <Badge variant={LANE_BADGE_VARIANT[origin] || "default"}>{origin}</Badge>
      : <span style={{ fontFamily: T.mono, fontSize: 12, color: T.border }}>—</span>}
    <span style={{ fontFamily: T.mono, fontSize: 16, color: T.textMuted, fontWeight: 700 }}>›</span>
    {dest
      ? <Badge variant={LANE_BADGE_VARIANT[dest] || "default"}>{dest}</Badge>
      : <span style={{ fontFamily: T.mono, fontSize: 12, color: T.border }}>—</span>}
  </div>
);

// One half of the form's Trade panel — the origin's or the destination's trade lane, with the port it was
// worked out from. (The panel used to show one "Trade Lane Route" pill pair; the table now has a column for
// each side, and the form says the same words.)
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

// ─── Page ─────────────────────────────────────────────────────────────────────

const SpaceConfigurationsPage = ({
  allocations, carriers, shipments, containers, containerTypeDefs = [],
  onAddAlloc, onEditAlloc, onDeleteAlloc,
  pendingRenew, onPendingRenewClear,
  navigate,
}) => {
  const { canManageConfigs } = useAuth();
  // Admin-configured TEU overrides (Master Data → Equipment) — same lookup the backend's
  // TEU_EXPR reads (2026-09 Space Configuration spec, gap #8).
  const teuDefs = useMemo(() => buildTeuLookup(containerTypeDefs), [containerTypeDefs]);
  const [allocModal,    setAllocModal]    = useState(null);
  const [confirmAlloc,  setConfirmAlloc]  = useState(null);
  const [renewInit,     setRenewInit]     = useState(null);
  const [historyAlloc,  setHistoryAlloc]  = useState(null);
  const [linkedAlloc,   setLinkedAlloc]   = useState(null); // alloc obj for linked shipments modal
  const [tradeLanes,    setTradeLanes]    = useState([]);
  const [linkedPorts,   setLinkedPorts]   = useState([]);
  const [contractsById, setContractsById] = useState({});

  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => { api.tradeLanes.list().then(setTradeLanes).catch(() => {}); }, []);
  useEffect(() => { api.linkedPorts.list().then(setLinkedPorts).catch(() => {}); }, []);

  // Fetch (and cache) the system contract — with its legs — behind each allocation's
  // contractId, so route matching can honor per-leg linked-port expansion.
  useEffect(() => {
    const ids = [...new Set(allocations.map(a => a.contractId).filter(Boolean))];
    const missing = ids.filter(id => !contractsById[id]);
    if (!missing.length) return;
    Promise.all(missing.map(id => api.contracts.get(id).catch(() => null))).then(results => {
      setContractsById(prev => {
        const next = { ...prev };
        results.forEach(c => { if (c) next[c.id] = c; });
        return next;
      });
    });
  }, [allocations]); // eslint-disable-line react-hooks/exhaustive-deps

  const linkedPortIdx = useMemo(() => buildLinkedPortIndex(linkedPorts), [linkedPorts]);

  // Open renew modal when navigated from Archive page
  useEffect(() => {
    if (pendingRenew) {
      setRenewInit(pendingRenew);
      setAllocModal("add");
      onPendingRenewClear?.();
    }
  }, [pendingRenew]);

  // Per-allocation TEU is now read directly off each allocation's own confirmedTEU/pendingTEU/
  // rejectedTEU fields (server-computed, scoped strictly to shipments explicitly linked via
  // shipment.allocationId, bucketed by carrier_bookings.status — routes/allocations.js's
  // loadTeuBuckets()). This used to be recomputed here client-side with a broader
  // carrier+contract+route heuristic (contractMatch/allocationRouteMatch below) that could — and
  // did — disagree with the server's own /api/allocations/match number and with the Dashboard's
  // Contract Consumption tab's own third definition, showing three different "Consumed" figures
  // for the same allocation depending which screen you were on. One authoritative source now,
  // reused everywhere.

  // Still used by the Linked Shipments modal below to render the linked-port badge on a properly
  // linked shipment's row (matchedLegFor), and to resolve a shipment's contract for display —
  // NOT used anymore to decide which shipments count toward Confirmed/Pending/Rejected.
  const contractMatch = (s, a) => {
    if (a.contractId)     return s.contractId === a.contractId;
    if (a.contractNumber) return s.contractRef === a.contractNumber;
    return s.contractType === "Central";
  };

  // 6-week sparkline per allocation carrier
  const sparkPerAlloc = useMemo(() => {
    const m = {};
    allocations.forEach(a => {
      m[a.id] = Array.from({ length: 6 }, (_, i) => {
        const wEnd   = new Date(); wEnd.setDate(wEnd.getDate() - (5 - i) * 7);
        const wStart = new Date(wEnd); wStart.setDate(wEnd.getDate() - 6);
        const wEs = wEnd.toISOString().slice(0, 10);
        const wSs = wStart.toISOString().slice(0, 10);
        return shipments
          .filter(s => s.carrierCode === a.carrierCode && s.etd >= wSs && s.etd <= wEs)
          .reduce((sum, s) =>
            sum + containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size, c.type, teuDefs), 0), 0);
      });
    });
    return m;
  }, [allocations, shipments, containers, teuDefs]);

  const activeCount = allocations.filter(a => a.endDate >= today).length;

  // The table: the shared Shipments-style behaviour (header checklists, search, sort, paging) run
  // CLIENT-side over the `allocations` prop — that array is App-level state the bell, Landing, Dashboard
  // and Archive also read, patched in place on create/edit/delete, so this page filters its own prop rather
  // than fetch a second copy. The rows, filters and sorts are src/utils/spaceConfigTable.js; the server's
  // confirmed/pending/rejected/remaining figures pass through untouched.
  //
  // What the prop lacks is port names and, for older configurations, a trade lane: only some rows store
  // originLane/destLane. A missing side is worked out from its port's primary lane — the same lookup the
  // Add/Edit form uses — and marked as derived. Lookups are made once per port per page visit, and only for
  // what the table shows (portLookupsNeeded); the table waits for them, so lanes never pop in afterwards.
  const allocRef = useRef(allocations);  allocRef.current = allocations;
  const carriersRef = useRef(carriers);  carriersRef.current = carriers;
  const portCache = useRef({ names: new Map(), lanes: new Map() });
  const [portNames, setPortNames] = useState({});

  const buildRows = async () => {
    const day = new Date().toISOString().slice(0, 10);
    const need = portLookupsNeeded(allocRef.current, day);
    const cache = portCache.current;
    // A lookup that fails (an unknown port, a slow or unreachable service) must only cost that port its name or
    // lane — never blank the table — so every load, even one that throws before returning a promise, ends in null.
    const once = (map, code, load) => { if (!map.has(code)) map.set(code, Promise.resolve().then(load).catch(() => null)); return map.get(code); };
    await Promise.all([
      ...need.names.map(c => once(cache.names, c, () => api.ports.get(c).then(p => p?.name || ""))),
      ...need.lanes.map(c => once(cache.lanes, c, () => api.portLanes(c).then(d => d?.primary || null))),
    ]);
    const names = {}, lanes = {};
    for (const c of need.names) names[c] = (await cache.names.get(c)) || "";
    for (const c of need.lanes) lanes[c] = await cache.lanes.get(c);
    setPortNames(names);
    return buildSpaceRows({ allocations: allocRef.current, carriers: carriersRef.current, portInfo: { names, lanes }, today: day });
  };
  const t = useTableQuery({
    fetchPage: async params => queryRows(await buildRows(), params, SPACE_SPEC),
    fetchOptions: async () => filterOptions(await buildRows(), SPACE_COLUMNS),
    filterKeys: SPACE_FILTER_KEYS,
  });
  // The hook fetches on mount by itself; after that a create/edit/delete (or a carrier rename) changes the
  // props, and the table re-derives its rows and checklists.
  const seenProps = useRef(false);
  useEffect(() => {
    if (!seenProps.current) { seenProps.current = true; return; }
    t.reload();
  }, [allocations, carriers]); // eslint-disable-line react-hooks/exhaustive-deps

  const carrierName = code => carriers.find(c => c.code === code)?.name || "";
  const laneName = code => tradeLanes.find(l => l.code === code)?.name || "";
  const STATUS_COLOR = { "Over Limit": T.danger, "At Limit": T.warning, Active: T.success, Future: T.accent, Ending: T.warning };

  const laneCell = (lane, port, side) => !lane
    ? <span style={{ fontFamily: T.mono, fontSize: 12, color: T.border }}>—</span>
    : (
      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}
        title={lane.derived ? `Derived from ${side} ${port} — not stored on this configuration` : "Stored on this configuration"}>
        <LanePill code={lane.code} derived={lane.derived} />
        {laneName(lane.code) && (
          <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, lineHeight: 1.25 }}>{laneName(lane.code)}</span>
        )}
      </div>
    );

  const columns = [
    { key: "carrier", header: "Carrier", width: 90, filter: true, describe: carrierName,
      render: r => <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{r.carrierCode}</span> },
    { key: "route", header: "Name / Route", width: 168, filter: true,
      describe: v => { const [pol, pod] = v.split(" › "); return portNames[pol] && portNames[pod] ? `${portNames[pol]} › ${portNames[pod]}` : ""; },
      render: r => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{r.carrierName || "—"}</span>
          {r.route && (
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
              {r.pol} <span style={{ color: T.border }}>›</span> {r.pod}
              {r.extraRoutings > 0 && <span style={{ fontFamily: T.body }}> +{r.extraRoutings} more routing{r.extraRoutings === 1 ? "" : "s"}</span>}
            </span>
          )}
          {(r.loopCode || r.customerName) && (
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
              {r.loopCode && <>Loop <span style={{ fontFamily: T.mono }}>{r.loopCode}</span></>}
              {r.loopCode && r.customerName && " · "}
              {r.customerName && <>for {r.customerName}</>}
            </span>
          )}
          {r.notes && (
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontStyle: "italic",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>
              {r.notes}
            </span>
          )}
        </div>
      ) },
    { key: "origin", header: "Origin", group: "Trade", width: 96, filter: true, describe: laneName,
      render: r => laneCell(r.origin, r.pol, "POL") },
    { key: "dest", header: "Destination", group: "Trade", width: 108, filter: true, describe: laneName,
      render: r => laneCell(r.dest, r.pod, "POD") },
    { key: "contract", header: "Contract", width: 148, filter: true,
      render: r => r.contract
        ? <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 600 }}>{r.contract}</span>
        : <span style={{ fontFamily: T.body, fontSize: 12, color: T.danger }}>— missing</span> },
    { key: "teu", header: "TEU", width: 100,
      render: r => (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{r.allocated} TEU</span>
          <ConsumptionBar allocated={r.allocated} confirmed={r.confirmed} pending={r.pending} rejected={r.rejected} height={4} width={72} />
          <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T[r.barLevel] }}>
            {r.pct.toFixed(0)}% <span style={{ color: T.border }}>/ {r.thresh}%</span>
          </span>
        </div>
      ) },
    { key: "period", header: "Effective Period", width: 132,
      render: r => (
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.text }}>{r.a.effectiveDate || "—"}</span>
          <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>{r.a.endDate ? `→ ${r.a.endDate}` : ""}</span>
        </div>
      ) },
    // The cells show the server's figures as they are. The header's control is a SORT only (awarded TEU or
    // consumption, each both ways) — there is nothing to pick from a list of confirmed-TEU values.
    { key: "confirmed", header: "Confirmed", width: 110, sortOptions: SPACE_SORT_OPTIONS,
      render: r => {
        const spark = sparkPerAlloc[r.id] || [];
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: r.confirmed > 0 ? T.success : T.textMuted, fontWeight: 600 }}>
              {r.confirmed} TEU
            </span>
            <Sparkline data={spark} color={r.pct > 5 ? T.success : r.pct < -5 ? T.danger : T.textMuted} />
            {(r.pending > 0 || r.rejected > 0) && (
              <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted }}>
                {r.pending > 0 && <span style={{ color: T.warning }}>+{r.pending} pending</span>}
                {r.pending > 0 && r.rejected > 0 && " · "}
                {r.rejected > 0 && <span style={{ color: T.danger }}>+{r.rejected} rejected</span>}
              </span>
            )}
            {r.belowMinimum && (
              <span title={`Committed to ${r.a.minimumTEU} TEU by ${r.a.endDate} — ${r.confirmed} confirmed so far`}
                style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: r.mqcUrgent ? T.danger : T.info }}>
                ⚠ MQC {r.confirmed}/{r.a.minimumTEU}
              </span>
            )}
          </div>
        );
      } },
    { key: "status", header: "Status", width: 90, filter: true,
      render: r => (
        <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: r.status.endsWith("Limit") ? 700 : 600, color: STATUS_COLOR[r.status] }}>
          ● {r.status}
        </span>
      ) },
  ];

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <button type="button" onClick={() => navigate("dashboard")}
              style={{ background: "none", border: "none", cursor: "pointer",
                fontFamily: T.body, fontSize: 13, color: T.textMuted, padding: 0 }}>
              Dashboard
            </button>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.border }}>›</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>Space Configurations</span>
          </div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Space Configurations</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {activeCount} active configuration{activeCount !== 1 ? "s" : ""} · click <IconSettings size={12} style={{ position: "relative", top: 2 }} /> to edit or view history
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Btn variant="secondary" onClick={() => navigate("dashboard-archive")}><IconArchive size={13} />Archive</Btn>
          {canManageConfigs && <Btn onClick={() => setAllocModal("add")} disabled={carriers.length === 0}>＋ Add Configuration</Btn>}
        </div>
      </div>

      {/* ── Table ── */}
      <TableToolbar tableId="space-configs" search={t.filters.search} onSearch={t.setSearch}
        searchPlaceholder="Search carrier, route, contract, notes…"
        canClear={t.canClear} onClear={t.clear} />

      {/* Wider than the other shared tables (two trade columns), so it scrolls sideways on a narrow window
          instead of clipping Status and Actions. Sorting lives in the Confirmed header, not a dropdown. */}
      <DataTable tableId="space-configs" columns={columns} rows={t.rows} loading={t.loading}
        rowKey={r => r.id} scrollX uppercaseHeaders actionsWidth={56}
        rowAccent={r => r.alertLevel === "over" ? T.danger : r.alertLevel === "at" ? T.warning : null}
        hasFilters={t.hasFilters} filters={t.filters} filterOptions={t.options} onFilterChange={t.setColumnFilter}
        sort={t.sort} onSort={t.setSort}
        rowActions={r => [
          ...(canManageConfigs ? [{ icon: IconPencil, label: "Edit", onClick: () => setAllocModal(r.a) }] : []),
          { icon: IconLink,      label: "Linked Shipments",  onClick: () => setLinkedAlloc(r.a) },
          { icon: IconClipboard, label: "History",           onClick: () => setHistoryAlloc(r.a) },
          ...(canManageConfigs ? [{ icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirmAlloc(r.id) }] : []),
        ]}
        emptyMessage={'No active configurations. Use "+ Add Configuration" to set up carrier space allocations.'}
        emptyFilteredMessage="No configurations match your filters."
        pagination={{ total: t.total, offset: t.offset, limit: t.limit, onPage: t.goPage, onLimit: t.changeLimit }} />

      {/* ── Add / Edit modal ── */}
      {allocModal === "add" && (
        <Modal title={renewInit ? "Renew Space Configuration" : "Add Space Configuration"}
          onClose={() => { setAllocModal(null); setRenewInit(null); }} width={760} minHeight={620}>
          {/* A renewal is a NEW configuration prefilled from an old one — drop the source's id so
              the form treats it as new (and checks it against its source for duplicates). */}
          <SpaceConfigurationForm init={renewInit ? { ...renewInit, id: undefined } : {}} tradeLanes={tradeLanes}
            onSave={async form => { await onAddAlloc(form); setAllocModal(null); setRenewInit(null); }}
            onCancel={() => { setAllocModal(null); setRenewInit(null); }} />
        </Modal>
      )}
      {allocModal && allocModal !== "add" && (
        <Modal title="Edit Space Configuration" onClose={() => setAllocModal(null)} width={760} minHeight={620}>
          <SpaceConfigurationForm init={allocModal} tradeLanes={tradeLanes}
            onSave={async form => { await onEditAlloc(allocModal.id, form); setAllocModal(null); }}
            onCancel={() => setAllocModal(null)} />
        </Modal>
      )}

      {/* ── Delete confirm ── */}
      {confirmAlloc && (
        <ConfirmModal
          message="Remove this space configuration? Existing shipments will not be affected."
          onConfirm={() => { onDeleteAlloc(confirmAlloc); setConfirmAlloc(null); }}
          onCancel={() => setConfirmAlloc(null)} />
      )}

      {/* ── Linked Shipments modal ── */}
      {linkedAlloc && (() => {
        const a = linkedAlloc;
        const contract = a.contractId ? contractsById[a.contractId] : null;
        // Explicitly linked via shipment.allocationId — the same authoritative relationship
        // routes/allocations.js's TEU buckets are scoped to, so this list's own total always
        // agrees with the header row's Confirmed figure above (see the comment on contractMatch).
        const linked = shipments.filter(s => s.allocationId === a.id).map(s => {
          const leg = contract ? matchedLegFor(contract, linkedPortIdx, s.pol, s.pod) : null;
          return {
            ...s,
            teu: containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size, c.type, teuDefs), 0),
            viaLinkedPol: !!leg && leg.pol !== s.pol,
            viaLinkedPod: !!leg && leg.pod !== s.pod,
          };
        }).filter(s => s.teu > 0);

        // Shipments that LOOK related (same carrier/contract/route/period) but were never
        // explicitly linked via the contract-assignment flow — surfaced separately, below, so
        // an operator can spot and fix a missing link rather than have it silently inflate or
        // (as before this fix) produce a disagreeing Consumed number on this modal alone.
        const possiblyRelated = shipments.filter(s =>
          s.allocationId !== a.id &&
          s.carrierCode === a.carrierCode &&
          s.etd >= a.effectiveDate && s.etd <= a.endDate &&
          contractMatch(s, a) &&
          allocationRouteMatch(s, a, contractsById, linkedPortIdx)
        ).map(s => ({
          ...s, teu: containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size, c.type, teuDefs), 0),
        })).filter(s => s.teu > 0);

        // Header figures come straight from the allocation row itself — the same authoritative,
        // unscoped loadTeuBuckets() aggregate the table already reads (routes/allocations.js) —
        // rather than being re-summed from `linked` above. `linked` is built by filtering the
        // App-level `shipments` state, which DOES pass through applyShipmentAccessFilter for any
        // office/trade-lane-scoped role (trade_manager, sales, occ_bk, viewer — all of whom can
        // open this page); re-summing it here used to silently show a lower Confirmed TEU (and
        // %) than the table row a few pixels away for exactly those roles (2026-09-23 QA finding).
        // The shipment list below is still the possibly-scoped `linked` rows — that's correct,
        // it's just "which shipments can I see," not "what does the bar mean."
        const confirmedTEU = a.confirmedTEU;
        const pendingTEU   = a.pendingTEU;
        const rejectedTEU  = a.rejectedTEU;
        const totalTEU    = confirmedTEU + pendingTEU + rejectedTEU;
        const allocated   = a.allocatedTEU;
        const pct         = allocated > 0 ? Math.round((confirmedTEU / allocated) * 100) : 0;
        const barColor    = pct >= 100 ? T.danger : pct >= (a.alertThreshold ?? 80) ? T.warning : T.success;
        const SHP_COLS    = ["Shipment ID", "POL → POD", "ETD", "Contract", "TEU", "Status"];
        const SHP_TMPL    = "140px 130px 90px 150px 52px 90px";

        return (
          <Modal title="Linked Shipments" onClose={() => setLinkedAlloc(null)} width={700}>
            {/* Config summary */}
            <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
              padding: "12px 16px", marginBottom: 16, display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
              <div>
                <div style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{a.carrierCode}</div>
                {(a.pol && a.pod) && (
                  <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{a.pol} › {a.pod}</div>
                )}
              </div>
              {a.contractNumber && (
                <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{a.contractNumber}</div>
              )}
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                {a.effectiveDate} – {a.endDate}
              </div>
              <div style={{ marginLeft: "auto", textAlign: "right" }}>
                <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginBottom: 3 }}>
                  <span style={{ color: barColor, fontWeight: 700 }}>{confirmedTEU}</span>
                  {" / "}{allocated} TEU confirmed ({pct}%)
                </div>
                <ConsumptionBar allocated={allocated} confirmed={confirmedTEU} pending={pendingTEU} rejected={rejectedTEU} height={6} width={140} />
              </div>
            </div>

            {linked.length === 0 ? (
              <div style={{ padding: "40px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                No shipments match this configuration's carrier, route, and period.
              </div>
            ) : (
              <>
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 10 }}>
                  {linked.length} shipment{linked.length !== 1 ? "s" : ""} in period
                </div>
                <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ display: "grid", gridTemplateColumns: SHP_TMPL,
                    padding: "8px 14px", borderBottom: `1px solid ${T.border}` }}>
                    {SHP_COLS.map(h => (
                      <span key={h} style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600,
                        color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
                    ))}
                  </div>
                  {linked.map(s => (
                    <div key={s.id} style={{ display: "grid", gridTemplateColumns: SHP_TMPL,
                      padding: "10px 14px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                      transition: "background .1s" }}
                      onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, fontWeight: 700 }}>{s.id}</span>
                      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text, display: "flex", alignItems: "center", gap: 5 }}>
                        {s.pol} → {s.pod}
                        {(s.viaLinkedPol || s.viaLinkedPod) && (
                          <span title="Matched via a linked port equivalent on the carrier's contract leg"
                            style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, color: T.warning,
                              background: T.warning + "18", border: `1px solid ${T.warning}44`,
                              borderRadius: 3, padding: "1px 4px", flexShrink: 0 }}>
                            ↔ linked
                          </span>
                        )}
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{s.etd || "—"}</span>
                      <Badge variant={contractVariant(s.contractType)}>{s.contractType || "—"}</Badge>
                      <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{s.teu}</span>
                      <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                    </div>
                  ))}
                </div>
              </>
            )}

            {possiblyRelated.length > 0 && (
              <div style={{ marginTop: 16, padding: "10px 14px", borderRadius: 8,
                background: T.warning + "0f", border: `1px solid ${T.warning}44` }}>
                <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.warning, marginBottom: 4 }}>
                  {possiblyRelated.length} shipment{possiblyRelated.length !== 1 ? "s" : ""} look related but aren't linked to this configuration
                </div>
                <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 8 }}>
                  Same carrier, route, and period — but their own contract-assignment step never set this specific
                  configuration, so they aren't counted toward Consumed above. Re-run "Change Contract" on each
                  shipment's Schedules page to link it explicitly, if it should count here.
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {possiblyRelated.map(s => (
                    <span key={s.id} style={{ fontFamily: T.mono, fontSize: 10.5, color: T.text,
                      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, padding: "2px 6px" }}>
                      {s.id} · {s.teu} TEU
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Modal>
        );
      })()}

      {/* ── History modal ── */}
      {historyAlloc && (
        <EntityHistoryModal
          entityType="allocation"
          entityId={historyAlloc.id}
          title="Configuration History"
          headerContent={
            <>
              <IdChip id={historyAlloc.id} />
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{historyAlloc.carrierCode}</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{historyAlloc.pol} → {historyAlloc.pod}</span>
              {historyAlloc.contractNumber && (
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{historyAlloc.contractNumber}</span>
              )}
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{historyAlloc.effectiveDate} – {historyAlloc.endDate}</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>{historyAlloc.allocatedTEU} TEU</span>
            </>
          }
          onClose={() => setHistoryAlloc(null)} />
      )}
    </div>
  );
};

export default SpaceConfigurationsPage;
