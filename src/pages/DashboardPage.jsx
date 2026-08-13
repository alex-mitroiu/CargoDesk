import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import useSaving from "../hooks/useSaving";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
         Tooltip, Legend, ResponsiveContainer, ReferenceLine } from "recharts";
import { T, STATUSES, statusVariant, contractVariant, addDays, diffDays,
         currentWeekStart, MAX_RANGE_DAYS, teuOf, LANE_BADGE_VARIANT, todayIso, parseIso } from "../tokens";
import { api } from "../api";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Inp, Sel, ContractTypeInput, Textarea, Field } from "../components/primitives/Form";
import PortField from "../components/shared/PortField";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import Spinner from "../components/primitives/spinner";
import Pagination from "../components/primitives/Pagination";
import DatePicker from "../components/primitives/DatePicker";
import { useResizableColumns, ColResizer } from "../components/primitives/useResizableColumns.jsx";
import { IconClose, IconWarning, IconPencil, IconCheck, IconRefresh, IconLock, IconUnlock,
  IconEye, IconArrowDown, IconForbid, IconSearch } from "../components/primitives/Icon";

const CHART_COLORS = [
  "#6366f1","#22c55e","#f59e0b","#3b82f6",
  "#ec4899","#8b5cf6","#06b6d4","#ef4444","#10b981","#f97316",
];

// ─── Lane pair display ───────────────────────────────────────────────────────

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

// ─── Coverage scope override button ─────────────────────────────────────────
// Disabled until Contract Management module is available.
// When enabled, marks the allocation as coverageScope="LINKED" meaning it
// intentionally covers linked port locations (e.g. "All West Coast US ports").

const OverrideBtn = () => {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block", flexShrink: 0 }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <button type="button" disabled
        style={{
          padding: "4px 12px", borderRadius: 6, cursor: "not-allowed",
          fontFamily: T.body, fontSize: 11, fontWeight: 600,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.border, opacity: 0.6, whiteSpace: "nowrap",
          display: "inline-flex", alignItems: "center", gap: 5,
        }}>
        <IconUnlock size={11} />Override Coverage
      </button>
      {show && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 500,
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 10, padding: "12px 16px",
          boxShadow: "0 8px 28px rgba(0,0,0,.55)",
          minWidth: 280, maxWidth: 320,
        }}>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.warning, fontWeight: 700, marginBottom: 6,
            display: "flex", alignItems: "center", gap: 5 }}>
            <IconLock size={12} />Requires Contract Management
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.65 }}>
            Override allows this configuration to intentionally cover linked port locations —
            for example, a contract that covers <em>all West Coast US ports</em> rather than
            a single POL. This requires a Contract Management source to validate the declared
            coverage scope before it can be applied.
          </div>
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${T.border}44`,
            fontFamily: T.mono, fontSize: 10, color: T.border }}>
            Future value: coverageScope = "LINKED" | "CONTRACT:id"
          </div>
          {/* Tooltip arrow */}
          <div style={{
            position: "absolute", top: -6, right: 18,
            width: 10, height: 10, background: T.surface,
            borderLeft: `1px solid ${T.border}`, borderTop: `1px solid ${T.border}`,
            transform: "rotate(45deg)",
          }} />
        </div>
      )}
    </div>
  );
};

// ─── Conflict banner ──────────────────────────────────────────────────────────

const ConflictBanner = ({ conflicts, loading }) => {
  if (loading) return (
    <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted,
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 12px" }}>
      Checking for conflicts…
    </div>
  );
  if (!conflicts.exact.length && !conflicts.linked.length) return null;

  const accent = kind => kind === 'exact' ? T.danger : T.warning;

  const ConflictRow = ({ a, kind }) => (
    <div style={{ borderTop: `1px solid ${accent(kind)}22` }}>
      {/* Main conflict info */}
      <div style={{ padding: "8px 12px 4px", display: "flex", flexWrap: "wrap",
        gap: "4px 16px", alignItems: "center" }}>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: accent(kind), fontWeight: 700 }}>{a.id}</span>
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{a.carrierName}</span>
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>
          {a.pol} <span style={{ color: T.border }}>›</span> {a.pod}
        </span>
        {(a.originLane || a.destLane) && <div style={{ display: "flex" }}><LanePair origin={a.originLane} dest={a.destLane} /></div>}
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{a.effectiveDate} → {a.endDate}</span>
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 600 }}>{a.allocatedTEU} TEU</span>
      </div>
      {/* Link path — only for linked conflicts */}
      {kind === 'linked' && a.links?.length > 0 && (
        <div style={{ padding: "0 12px 8px 24px", display: "flex", flexDirection: "column", gap: 2 }}>
          {a.links.map((lk, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6,
              fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
              <span style={{ color: T.warning }}>↳</span>
              <span>Your</span>
              <span style={{ fontFamily: T.mono, color: T.warning, fontWeight: 700 }}>{lk.newPort}</span>
              <span style={{ color: T.textMuted }}>({lk.newLabel})</span>
              <span>is linked to their</span>
              <span style={{ fontFamily: T.mono, color: T.warning, fontWeight: 700 }}>{lk.theirPort}</span>
              <span style={{ color: T.textMuted }}>({lk.theirLabel})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {conflicts.exact.length > 0 && (
        <div style={{ background: T.dangerBg, border: `1px solid ${T.danger}55`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", fontFamily: T.body, fontSize: 12, color: T.danger, fontWeight: 600,
            display: "flex", alignItems: "center", gap: 6 }}>
            <IconForbid size={13} />{conflicts.exact.length} exact conflict{conflicts.exact.length > 1 ? "s" : ""} — same carrier, route and overlapping period
          </div>
          {conflicts.exact.map(a => <ConflictRow key={a.id} a={a} kind="exact" />)}
        </div>
      )}
      {conflicts.linked.length > 0 && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px 6px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.warning, fontWeight: 600,
              display: "flex", alignItems: "center", gap: 6 }}>
              <IconWarning size={13} />{conflicts.linked.length} linked-port overlap{conflicts.linked.length > 1 ? "s" : ""} — a linked port location matches an existing configuration
            </span>
            <OverrideBtn />
          </div>
          {conflicts.linked.map(a => <ConflictRow key={a.id} a={a} kind="linked" />)}
        </div>
      )}
    </div>
  );
};

// ─── AllocContractPickerModal ─────────────────────────────────────────────────

const AllocContractPickerModal = ({ pol, pod, matches, onSelect, onClose }) => {
  const [hovered, setHovered] = useState(null);
  return (
    <Modal title={`Select Contract — ${pol} → ${pod}`} onClose={onClose} width={600}>
      {matches === null ? (
        <div style={{ padding: "48px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <Spinner />
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Searching contracts…</span>
        </div>
      ) : matches.length === 0 ? (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <div style={{ marginBottom: 10, color: T.textMuted, display: "flex", justifyContent: "center" }}><IconSearch size={28} /></div>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, marginBottom: 4 }}>No contracts found for this route</div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            Try adjusting the POL, POD, or carrier, or check the valid-from / valid-to dates on your contracts.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 420, overflowY: "auto", padding: "4px 2px" }}>
          {matches.map(c => (
            <div key={c.id}
              onClick={() => onSelect(c)}
              onMouseEnter={() => setHovered(c.id)}
              onMouseLeave={() => setHovered(null)}
              style={{
                border: `1px solid ${hovered === c.id ? T.accent : T.border}`,
                borderRadius: 8, padding: "14px 16px", cursor: "pointer",
                background: hovered === c.id ? T.accentBg : T.surface,
                transition: "border-color .12s, background .12s",
              }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.accent }}>{c.contractNumber}</span>
                  {c.contractRef && (
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{c.contractRef}</span>
                  )}
                  {c.namedAccount && (
                    <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>· {c.namedAccount}</span>
                  )}
                </div>
                <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, flexShrink: 0, marginLeft: 8 }}>
                  {c.validFrom} – {c.validTo}
                </span>
              </div>
              {c.carrierCode && (
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 6 }}>
                  Carrier: <span style={{ color: T.text, fontWeight: 600 }}>{c.carrierCode}</span>
                </div>
              )}
              {c.legs?.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                  {c.legs.map((leg, i) => (
                    <span key={i} style={{
                      fontFamily: T.mono, fontSize: 11,
                      background: T.bg, border: `1px solid ${T.border}`,
                      borderRadius: 4, padding: "2px 8px", color: T.textMuted,
                    }}>
                      {leg.pol} → {leg.pod}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
};

// ─── AllocationForm ───────────────────────────────────────────────────────────

const AllocationForm = ({ init = {}, tradeLanes = [], onSave, onCancel }) => {
  const isEdit = !!init.id;

  // Core fields
  const [carrierCode,    setCarrierCode]    = useState(init.carrierCode    || "");
  const [teuStr,         setTeuStr]         = useState(init.allocatedTEU   ? String(init.allocatedTEU) : "");
  const [effectiveDate,  setEffectiveDate]  = useState(init.effectiveDate  || "");
  const [endDate,        setEndDate]        = useState(init.endDate        || "");
  const [notes,          setNotes]          = useState(init.notes          || "");
  const [alertThreshold, setAlertThreshold] = useState(init.alertThreshold ?? 80);
  const [serverErr,      setServerErr]      = useState("");
  const [isSaving,       withSaving]        = useSaving();

  // Contract picker
  const [contractId,         setContractId]         = useState(init.contractId     || "");
  const [contractNumber,     setContractNumber]     = useState(init.contractNumber || "");
  const [contractMatches,    setContractMatches]    = useState(null);
  const [contractLoading,    setContractLoading]    = useState(false);
  const [contractPickerOpen, setContractPickerOpen] = useState(false);
  const contractTimer = useRef(null);
  const autoContractSelected = useRef(false);

  // POL / POD
  const [polPort,  setPolPort]  = useState(init.pol ? { unlocode: init.pol,  name: "" } : null);
  const [podPort,  setPodPort]  = useState(init.pod ? { unlocode: init.pod,  name: "" } : null);

  // Lane auto-detection
  const [originLane,    setOriginLane]    = useState(init.originLane || "");
  const [destLane,      setDestLane]      = useState(init.destLane   || "");
  const [originOptions, setOriginOptions] = useState([]);
  const [destOptions,   setDestOptions]   = useState([]);
  const [laneOverride,  setLaneOverride]  = useState(false);
  const [laneLoading,   setLaneLoading]   = useState(false);

  // Conflict detection
  const [conflicts,       setConflicts]       = useState({ exact: [], linked: [] });
  const [conflictLoading, setConflictLoading] = useState(false);
  const conflictTimer = useRef(null);

  // On edit load: fetch lanes for existing ports
  useEffect(() => {
    if (init.pol) fetchLane(init.pol, setOriginLane, setOriginOptions, true);
    if (init.pod) fetchLane(init.pod, setDestLane,   setDestOptions,   true);
  }, []);

  const fetchLane = async (unlocode, setLane, setOptions, keepExisting = false) => {
    if (!unlocode) { setLane(""); setOptions([]); return; }
    setLaneLoading(true);
    try {
      const data = await api.portLanes(unlocode);
      setOptions(data.lanes || []);
      if (!keepExisting || !setLane.toString().includes(unlocode)) {
        if (data.primary) setLane(data.primary);
      }
    } catch {}
    setLaneLoading(false);
  };

  const handlePolSelect = port => {
    setPolPort(port);
    if (port) fetchLane(port.unlocode, setOriginLane, setOriginOptions);
    else { setOriginLane(""); setOriginOptions([]); }
  };

  const handlePodSelect = port => {
    setPodPort(port);
    if (port) fetchLane(port.unlocode, setDestLane, setDestOptions);
    else { setDestLane(""); setDestOptions([]); }
  };

  // Contract auto-match — debounced 400ms, triggers when carrier + POL + POD are set
  useEffect(() => {
    clearTimeout(contractTimer.current);
    if (!carrierCode || !polPort?.unlocode || !podPort?.unlocode) {
      setContractMatches(null); return;
    }
    setContractLoading(true);
    contractTimer.current = setTimeout(async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const res = await api.contracts.match({
          pol: polPort.unlocode,
          pod: podPort.unlocode,
          carrier: carrierCode,
          etd: effectiveDate || today,
        });
        setContractMatches(res);
        if (res.length === 1 && !contractId && !autoContractSelected.current) {
          autoContractSelected.current = true;
          setContractId(res[0].id);
          setContractNumber(res[0].contractNumber);
        }
      } catch {
        setContractMatches([]);
      } finally {
        setContractLoading(false);
      }
    }, 400);
    return () => clearTimeout(contractTimer.current);
  }, [carrierCode, polPort?.unlocode, podPort?.unlocode, effectiveDate]);

  // Conflict check — debounced 500ms
  useEffect(() => {
    clearTimeout(conflictTimer.current);
    if (!carrierCode || !polPort?.unlocode || !podPort?.unlocode || !effectiveDate || !endDate) {
      setConflicts({ exact: [], linked: [] }); return;
    }
    conflictTimer.current = setTimeout(async () => {
      setConflictLoading(true);
      try {
        const data = await api.allocations.conflicts({
          carrierCode, pol: polPort.unlocode, pod: podPort.unlocode,
          effectiveDate, endDate, excludeId: init.id || '',
        });
        setConflicts(data);
      } catch {}
      setConflictLoading(false);
    }, 500);
    return () => clearTimeout(conflictTimer.current);
  }, [carrierCode, polPort?.unlocode, podPort?.unlocode, effectiveDate, endDate]);

  const handleEffectiveChange = val => {
    setEffectiveDate(val); setServerErr("");
    if (endDate && val && endDate < val) setEndDate(val);
    if (endDate && val) { const m = addDays(val, 90); if (endDate > m) setEndDate(m); }
  };

  const teu    = parseInt(teuStr) || 0;
  const thresh = Math.min(100, Math.max(1, parseInt(alertThreshold) || 80));
  const valid  = carrierCode && teu > 0 && effectiveDate && endDate && endDate >= effectiveDate
               && polPort?.unlocode && podPort?.unlocode && originLane && destLane
               && contractId;

  const threshColour = thresh >= 90 ? T.danger : thresh >= 75 ? T.warning : T.success;

  const handleSave = () => {
    if (!valid) return;
    withSaving(async () => {
      try {
        await onSave({
          carrierCode, allocatedTEU: teu, effectiveDate, endDate, notes,
          alertThreshold: thresh,
          pol: polPort.unlocode, pod: podPort.unlocode,
          originLane, destLane,
          tradeLane: `${originLane}_${destLane}`,
          contractId, contractNumber,
        });
      } catch (e) { setServerErr(e.message || "Could not save — check for overlapping periods."); }
    });
  };

  const laneSelOpts = (options, fallback) => [
    ...((options.length ? options : tradeLanes).map(l => ({ value: l.code, label: `${l.code} – ${l.name}` }))),
    ...(fallback && !options.find(o => o.code === fallback) ? [{ value: fallback, label: fallback }] : []),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Carrier */}
      <Field label="Carrier" required>
        <CarrierCombobox value={carrierCode} onChange={v => { setCarrierCode(v); setServerErr(""); }} />
      </Field>

      {/* POL / POD */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <PortField label="Port of Loading (POL)"   value={polPort} onChange={handlePolSelect} placeholder="Search origin port…" required showLinks />
        <PortField label="Port of Discharge (POD)" value={podPort} onChange={handlePodSelect} placeholder="Search destination port…" required showLinks />
      </div>

      {/* Auto-detected trade lane pair */}
      {(polPort || podPort) && (
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: laneOverride ? 12 : 0 }}>
            <div>
              <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
                Trade Lane Route {laneLoading && <span style={{ fontWeight: 400, color: T.border }}>· detecting…</span>}
              </div>
              <LanePair origin={originLane} dest={destLane} />
            </div>
            <button type="button" onClick={() => setLaneOverride(o => !o)}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
                color: T.textMuted, cursor: "pointer", padding: "4px 10px",
                fontFamily: T.body, fontSize: 11, flexShrink: 0 }}>
              {laneOverride
                ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><IconCheck size={10} />Done</span>
                : <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><IconPencil size={10} />Override</span>}
            </button>
          </div>
          {laneOverride && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "end", marginTop: 4 }}>
              <Sel label="Origin Lane" value={originLane} onChange={setOriginLane}
                options={laneSelOpts(originOptions, originLane)} />
              <div style={{ fontFamily: T.mono, fontSize: 18, color: T.textMuted, fontWeight: 700, paddingBottom: 9, userSelect: "none" }}>›</div>
              <Sel label="Destination Lane" value={destLane} onChange={setDestLane}
                options={laneSelOpts(destOptions, destLane)} />
            </div>
          )}
        </div>
      )}

      {/* Contract */}
      <div style={{ background: T.bg, border: `1px solid ${contractId ? T.success : T.border}`, borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>
          Contract <span style={{ color: T.danger }}>*</span>
        </div>
        {contractId ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <IconCheck size={13} color={T.success} />
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>{contractNumber}</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setContractPickerOpen(true)}
                style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none", border: `1px solid ${T.accent}`, borderRadius: 5, padding: "4px 12px", cursor: "pointer" }}>
                Change
              </button>
              <button type="button" onClick={() => { setContractId(""); setContractNumber(""); autoContractSelected.current = false; }}
                style={{ fontFamily: T.body, fontSize: 12, color: T.danger, background: "none", border: `1px solid ${T.danger}44`, borderRadius: 5, padding: "4px 10px", cursor: "pointer",
                  display: "inline-flex", alignItems: "center" }}>
                <IconClose size={11} />
              </button>
            </div>
          </div>
        ) : (
          <button type="button"
            disabled={!carrierCode || !polPort?.unlocode || !podPort?.unlocode}
            onClick={() => setContractPickerOpen(true)}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: 6, cursor: "pointer",
              background: "none", textAlign: "left",
              border: `1.5px dashed ${(!carrierCode || !polPort?.unlocode || !podPort?.unlocode) ? T.border : T.accent}`,
              color: (!carrierCode || !polPort?.unlocode || !podPort?.unlocode) ? T.textMuted : T.accent,
              fontFamily: T.body, fontSize: 13, opacity: (!carrierCode || !polPort?.unlocode || !podPort?.unlocode) ? 0.5 : 1,
            }}>
            {contractLoading
              ? "Searching contracts…"
              : (!carrierCode || !polPort?.unlocode || !podPort?.unlocode)
                ? "Set carrier, POL and POD to find matching contracts"
                : contractMatches === null
                  ? "Searching contracts…"
                  : contractMatches.length === 0
                    ? "No matching contracts — click to browse all"
                    : `${contractMatches.length} contract${contractMatches.length !== 1 ? "s" : ""} found — click to select`}
          </button>
        )}
      </div>

      {contractPickerOpen && (
        <AllocContractPickerModal
          pol={polPort?.unlocode || ""}
          pod={podPort?.unlocode || ""}
          matches={contractMatches}
          onSelect={c => { setContractId(c.id); setContractNumber(c.contractNumber); setContractPickerOpen(false); }}
          onClose={() => setContractPickerOpen(false)}
        />
      )}

      {/* TEU */}
      <Inp label="Allocated Space (TEU)" value={teuStr} onChange={setTeuStr}
        type="number" placeholder="100" required hint="Total TEU awarded by this carrier for the period" />

      {/* Effective Period */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 12 }}>
          Effective Period <span style={{ color: T.danger }}>*</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <DatePicker label="Effective From" value={effectiveDate} onChange={handleEffectiveChange} placeholder="Start date…" />
          <DatePicker label="Effective To" value={endDate}
            onChange={v => { setEndDate(v); setServerErr(""); }}
            minDate={effectiveDate || undefined}
            maxDate={effectiveDate ? addDays(effectiveDate, 90) : undefined}
            placeholder="End date…" disabled={!effectiveDate} />
        </div>
        {effectiveDate && endDate && (
          <div style={{ marginTop: 8, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
            {diffDays(effectiveDate, endDate) + 1} day period · max 90 days per configuration
          </div>
        )}
      </div>

      {/* Conflict detection banner */}
      <ConflictBanner conflicts={conflicts} loading={conflictLoading} />

      {/* Alert Threshold */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>
          Utilisation Alert Threshold
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <input type="range" min={10} max={100} step={5} value={thresh}
            onChange={e => setAlertThreshold(Number(e.target.value))}
            style={{ flex: 1, accentColor: threshColour, cursor: "pointer" }} />
          <div style={{ minWidth: 52, textAlign: "center", fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: threshColour }}>
            {thresh}%
          </div>
        </div>
        <div style={{ marginTop: 10, background: T.border, borderRadius: 4, height: 6, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${thresh}%`, background: threshColour, transition: "width .15s, background .15s" }} />
        </div>
        <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 6 }}>
          Bar turns <span style={{ color: threshColour, fontWeight: 600 }}>
            {thresh >= 90 ? "red — critical" : thresh >= 75 ? "amber — warning" : "green — normal"}
          </span> above this level
        </div>
      </div>

      {/* Notes */}
      <Textarea label="Notes" value={notes} onChange={setNotes} rows={3}
        placeholder="Contract caveats, rollover terms, special conditions…" />

      {serverErr && (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.danger, background: T.dangerBg,
          border: `1px solid ${T.danger}44`, borderRadius: 6, padding: "8px 12px" }}>
          {serverErr}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={!valid || isSaving}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {isSaving && <Spinner size="sm" color="currentColor" />}
            {isSaving ? "Saving…" : (isEdit ? "Save Changes" : "Add Configuration")}
          </span>
        </Btn>
      </div>
    </div>
  );
};

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

// ─── Matched Shipments Table (Overview tab) ───────────────────────────────────

const MatchedShipmentsTable = ({ shipments, containers, carriers, activeAllocations }) => {
  const rows = useMemo(() => shipments.map(s => {
    const teu     = containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size), 0);
    const carrier = carriers.find(c => c.code === s.carrierCode);
    const alloc   = activeAllocations.find(a =>
      a.carrierCode === s.carrierCode && (!a.pol || a.pol === s.pol) && (!a.pod || a.pod === s.pod)
    );
    return { ...s, teu, carrier, alloc };
  }), [shipments, activeAllocations, containers, carriers]);

  const HDR = ["Shipment ID", "POL → POD", "Carrier", "Contract", "Space Config", "TEU", "Status"];
  const { template: COL, startResize } = useResizableColumns("dashboard-matched-shipments", [130, 120, 120, 110, 140, 48, 90]);

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "15px 20px", borderBottom: `1px solid ${T.border}` }}>
        <h2 style={{ fontFamily: T.head, fontSize: 17, fontWeight: 700, color: T.text, margin: 0 }}>
          Shipments in Period
        </h2>
        <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "2px 0 0" }}>
          {shipments.length} shipment{shipments.length !== 1 ? "s" : ""} with ETD in range — correlated to active space configurations
        </p>
      </div>

      {shipments.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
          No shipments with ETD in this period. Adjust the date range or create new shipments.
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: COL,
            padding: "9px 20px", borderBottom: `1px solid ${T.border}` }}>
            {HDR.map((h, i) => (
              <div key={h} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5,
                fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
                {h}{i < HDR.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
              </div>
            ))}
          </div>
          {rows.map(s => (
            <div key={s.id}
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
            </div>
          ))}
        </>
      )}
    </div>
  );
};

// ─── Contract Consumption View (Contract tab) ─────────────────────────────────

const ContractConsumptionView = ({ rangeShipments, containers, carriers, allocations = [], contractTrendData }) => {
  const [contractMap, setContractMap] = useState({});
  const [loading,     setLoading]     = useState(false);

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

  // Consumed TEU per contract from shipments
  const consumedByContract = useMemo(() => {
    const m = {};
    centralShipments.forEach(s => {
      const teu = containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size), 0);
      m[s.contractId] = (m[s.contractId] || 0) + teu;
    });
    return m;
  }, [centralShipments, containers]);

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
      const consumed  = consumedByContract[id] || 0;
      const pct       = allocated > 0 ? Math.round((consumed / allocated) * 100) : null;
      const barColor  = pct === null ? T.info
                      : pct >= 100  ? T.danger
                      : pct >= 80   ? T.warning
                      : T.success;
      return {
        contractId:     id,
        contractNumber: contract?.contractNumber || alloc?.contractNumber || group?.contractRef || id,
        carrierCode:    contract?.carrierCode    || alloc?.carrierCode    || group?.carrierCode || "",
        allocated, consumed, pct, barColor,
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

  const teuFor = s => containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size), 0);

  const SHP_COL = "140px 130px 90px 48px 90px";
  const SHP_HDR = ["Shipment ID", "POL → POD", "ETD", "TEU", "Status"];

  if (centralShipments.length === 0) {
    return (
      <div>
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ fontFamily: T.head, fontSize: 19, fontWeight: 700, color: T.text, margin: 0 }}>Contract Consumption</h2>
          <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "3px 0 0" }}>
            Central shipments in the selected period, grouped by contract
          </p>
        </div>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
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
        <h2 style={{ fontFamily: T.head, fontSize: 19, fontWeight: 700, color: T.text, margin: 0 }}>Contract Consumption</h2>
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
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
              padding: "18px 20px" }}>
              <div style={{ marginBottom: 14 }}>
                <h2 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 3px" }}>
                  Allocated vs Consumed TEU
                </h2>
                <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>
                  Contract-level rollup for the selected date range — sums every Central shipment
                  against this contract (any allocation) in range, not one specific space config's
                  own real-time figure. Can differ from that config's own Consumed number on the
                  Space Configurations page, which is scoped to explicitly-linked shipments only,
                  with no date-range filter.
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
                    <div style={{ position: "relative", height: 16, borderRadius: 3,
                      background: T.border + "44", overflow: "hidden" }}>
                      {row.allocated > 0 && (
                        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0,
                          width: `${Math.min(100, (row.consumed / row.allocated) * 100)}%`,
                          background: row.barColor, borderRadius: 3, transition: "width .4s ease",
                          minWidth: row.consumed > 0 ? 4 : 0 }} />
                      )}
                      {row.allocated === 0 && row.consumed > 0 && (
                        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0,
                          width: "100%", background: T.info + "55", borderRadius: 3 }} />
                      )}
                    </div>
                    <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: row.barColor }}>
                        {row.consumed}
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                        {" / "}{row.allocated > 0 ? row.allocated : "—"} TEU
                      </span>
                      {row.pct !== null && (
                        <span style={{ fontFamily: T.mono, fontSize: 10, color: row.barColor,
                          marginLeft: 5, background: row.barColor + "18",
                          border: `1px solid ${row.barColor}44`,
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
                  { color: T.success, label: "< 80%" },
                  { color: T.warning, label: "80–99%" },
                  { color: T.danger,  label: "≥ 100%" },
                  { color: T.info,    label: "No config" },
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
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
              padding: "20px 20px 14px" }}>
              <div style={{ marginBottom: 16 }}>
                <h2 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 3px" }}>
                  6-Week TEU Trend
                </h2>
                <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>
                  Weekly consumption per contract — last 6 weeks
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
                    contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontFamily: T.body, fontSize: 12 }}
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

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {groups.map(g => {
          const contract = contractMap[g.contractId];
          const groupTEU = g.shipments.reduce((acc, s) => acc + teuFor(s), 0);
          const carrier  = carriers.find(c => c.code === g.carrierCode);

          return (
            <div key={g.contractId} style={{ background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 12, overflow: "hidden" }}>

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
                    <span style={{ fontFamily: T.mono, fontSize: 26, fontWeight: 700, color: T.success }}>{groupTEU}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>TEU</span>
                  </div>
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                    {g.shipments.length} shipment{g.shipments.length !== 1 ? "s" : ""}
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
              {g.shipments.map(s => (
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

  const kpiStyle = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 24px" };
  const kpiLabel = { fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" };
  const kpiVal   = (v, col) => (
    <div style={{ fontFamily: T.mono, fontSize: 28, fontWeight: 700, color: col, margin: "8px 0 2px" }}>
      {financeEnabled ? v : "••••"}
    </div>
  );

  const pct  = data?.grossMarginPct ?? null;
  const col  = marginColor(pct);

  const TrendChart = ({ rows, dataKeys, title, subtitle }) => (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 20px 14px" }}>
      <div style={{ marginBottom: 14 }}>
        <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 2px" }}>{title}</h3>
        <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>{subtitle}</p>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={rows} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
          <XAxis dataKey="week" tick={{ fontFamily: T.mono, fontSize: 10, fill: T.textMuted }} axisLine={{ stroke: T.border }} tickLine={false} />
          <YAxis tick={{ fontFamily: T.body, fontSize: 10, fill: T.textMuted }} axisLine={false} tickLine={false}
            tickFormatter={v => `${v}%`} domain={['auto', 'auto']} allowDecimals={false} />
          <ReferenceLine y={0} stroke={T.border} strokeDasharray="3 3" />
          <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontFamily: T.body, fontSize: 12 }}
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
          <h2 style={{ fontFamily: T.head, fontSize: 19, fontWeight: 700, color: T.text, margin: 0 }}>Margin Overview</h2>
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
        <div style={kpiStyle}>
          <div style={kpiLabel}>Total Buy</div>
          {kpiVal(fmtUsd(data.totalBuyUsd), T.warning)}
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>cost to carrier</div>
        </div>
        <div style={kpiStyle}>
          <div style={kpiLabel}>Total Sell</div>
          {kpiVal(fmtUsd(data.totalSellUsd), T.success)}
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>revenue from customer</div>
        </div>
        <div style={kpiStyle}>
          <div style={kpiLabel}>Gross Profit</div>
          {kpiVal(fmtUsd(data.grossProfitUsd), data.grossProfitUsd >= 0 ? T.success : T.danger)}
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>sell − buy</div>
        </div>
        <div style={{ ...kpiStyle, background: pct != null ? `${col}10` : T.surface, borderColor: pct != null ? `${col}44` : T.border }}>
          <div style={kpiLabel}>Gross Margin</div>
          <div style={{ fontFamily: T.mono, fontSize: 28, fontWeight: 700, color: pct != null ? col : T.textMuted, margin: "8px 0 2px" }}>
            {pct != null ? `${pct}%` : "—"}
          </div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
            {pct == null ? "no sell lines" : pct >= 20 ? "healthy" : pct >= 10 ? "watch" : "below target"}
          </div>
        </div>
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
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ padding: "13px 20px", borderBottom: `1px solid ${T.border}` }}>
            <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>By Carrier</h3>
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
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ padding: "13px 20px", borderBottom: `1px solid ${T.border}`,
            display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>By Customer</h3>
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
        <h2 style={{ fontFamily: T.head, fontSize: 19, fontWeight: 700, color: T.text, margin: 0 }}>Carrier Volumes</h2>
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>All shipments · by carrier code · TEU</span>
      </div>

      {/* Charts — side by side */}
      <div style={{ display: "grid", gridTemplateColumns: barData.length > 0 ? "1fr 1fr" : "1fr", gap: 16, marginBottom: 20 }}>

        {/* Bar chart */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 20px 14px" }}>
          <div style={{ marginBottom: 14 }}>
            <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 2px" }}>TEU by Carrier — Selected Period</h3>
            <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>Total: {totalTEU} TEU across {barData.length} carrier{barData.length !== 1 ? "s" : ""}</p>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={barData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
              <XAxis dataKey="carrier" tick={{ fontFamily: T.mono, fontSize: 11, fill: T.textMuted }} axisLine={{ stroke: T.border }} tickLine={false} />
              <YAxis tick={{ fontFamily: T.body, fontSize: 10, fill: T.textMuted }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontFamily: T.body, fontSize: 12 }}
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
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 20px 14px" }}>
            <div style={{ marginBottom: 14 }}>
              <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 2px" }}>6-Week Volume Trend</h3>
              <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>TEU shipped per carrier, calendar-week aligned</p>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trendData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                <XAxis dataKey="week" tick={{ fontFamily: T.mono, fontSize: 10, fill: T.textMuted }} axisLine={{ stroke: T.border }} tickLine={false} />
                <YAxis tick={{ fontFamily: T.body, fontSize: 10, fill: T.textMuted }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontFamily: T.body, fontSize: 12 }}
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
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "13px 20px", borderBottom: `1px solid ${T.border}` }}>
          <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>Carrier Rankings</h3>
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

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontFamily: T.head, fontSize: 19, fontWeight: 700, color: T.text, margin: 0 }}>
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
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T.border}`,
              display: "flex", alignItems: "center", gap: 10 }}>
              <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>
                Shipments — Active Compliance Hits
              </h3>
              {shipHits.length > 0 && (
                <span style={{ background: T.danger, color: "#fff", fontFamily: T.mono, fontSize: 10,
                  fontWeight: 700, borderRadius: 10, padding: "1px 7px" }}>
                  {shipHits.length}
                </span>
              )}
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
            ) : shipHits.map(s => {
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
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T.border}`,
              display: "flex", alignItems: "center", gap: 10 }}>
              <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>
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


const DashboardPage = ({ shipments, containers, carriers, allocations, financeEnabled = true }) => {
  const [view, setView] = useState("overview"); // "overview" | "contracts" | "compliance"

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
    return containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size), 0) > 0;
  }), [shipments, rangeStart, rangeEnd, containers]);

  const today = todayIso();

  // Split allocations: current (not expired) vs archived (expired)
  const currentAllocations  = allocations.filter(a => a.endDate >= today);

  const allocContractMatch = (s, a) => {
    if (a.contractId)     return s.contractId === a.contractId;
    if (a.contractNumber) return s.contractRef === a.contractNumber;
    return s.contractType === "Central";
  };

  // TEU consumed per carrier — filtered by contract + pol/pod to avoid overcounting
  const consumedMap = useMemo(() => {
    const m = {};
    rangeShipments.forEach(s => {
      const matched = activeAllocations.find(a =>
        s.carrierCode === a.carrierCode &&
        allocContractMatch(s, a) &&
        (!a.pol || s.pol === a.pol) &&
        (!a.pod || s.pod === a.pod)
      );
      if (!matched) return;
      const teu = containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size), 0);
      m[s.carrierCode] = (m[s.carrierCode] || 0) + teu;
    });
    return m;
  }, [rangeShipments, containers, activeAllocations]);


  // Trend data: delta vs previous equivalent period + 6-week sparkline
  const carrierTrends = useMemo(() => {
    const periodDays = diffDays(rangeStart, rangeEnd) + 1;
    const prevEnd    = addDays(rangeStart, -1);
    const prevStart  = addDays(prevEnd, -(periodDays - 1));
    // All carrier codes that appear in the selected range — not just allocated ones
    const allCodes = [...new Set(rangeShipments.map(s => s.carrierCode).filter(Boolean))];
    const trends   = {};

    allCodes.forEach(code => {
      // Current TEU — sum directly from range shipments for this carrier
      const currentTEU = rangeShipments
        .filter(s => s.carrierCode === code)
        .reduce((acc, s) =>
          acc + containers.filter(c => c.shipmentId === s.id)
                          .reduce((a2, c) => a2 + teuOf(c.size), 0), 0);

      // Previous period TEU
      const prevTEU = shipments
        .filter(s => s.carrierCode === code && s.etd >= prevStart && s.etd <= prevEnd)
        .reduce((acc, s) =>
          acc + containers.filter(c => c.shipmentId === s.id)
                          .reduce((a2, c) => a2 + teuOf(c.size), 0), 0);

      // Delta %
      const delta = prevTEU > 0
        ? Math.round(((currentTEU - prevTEU) / prevTEU) * 100)
        : currentTEU > 0 ? 100 : 0;

      // 6-week sparkline — i=5 window starts at rangeStart, earlier windows go back 7 days each
      const sparkData = Array.from({ length: 6 }, (_, i) => {
        const wStart = addDays(rangeStart, -(5 - i) * 7);
        const wEnd   = addDays(wStart, 6);
        return shipments
          .filter(s => s.carrierCode === code && s.etd >= wStart && s.etd <= wEnd)
          .reduce((acc, s) =>
            acc + containers.filter(c => c.shipmentId === s.id)
                            .reduce((a2, c) => a2 + teuOf(c.size), 0), 0);
      });

      trends[code] = { delta, prevTEU, sparkData };
    });

    return trends;
  }, [rangeShipments, shipments, containers, rangeStart, rangeEnd]);

  // Chart: group by carrier — consumption is total across all contract types
  const chartData = useMemo(() => {
    const byCarrier = {};
    activeAllocations.forEach(a => {
      if (!byCarrier[a.carrierCode]) byCarrier[a.carrierCode] = { allocated: 0, consumed: 0 };
      byCarrier[a.carrierCode].allocated += a.allocatedTEU;
      byCarrier[a.carrierCode].consumed   = consumedMap[a.carrierCode] || 0;
    });
    return Object.entries(byCarrier).map(([code, d]) => ({
      carrier: code,
      name: carriers.find(c => c.code === code)?.name || code,
      consumed: d.consumed,
      remaining: Math.max(0, d.allocated - d.consumed),
      total: d.allocated,
    }));
  }, [activeAllocations, consumedMap, carriers]);

  const totalAlloc    = activeAllocations.reduce((s, a) => s + a.allocatedTEU, 0);

  // Trend chart data: reshape sparkData arrays into recharts [{week, MAEU, HLCU, ...}]
  const trendChartData = useMemo(() => {
    const activeCodesSet = new Set(activeAllocations.map(a => a.carrierCode));
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
  }, [carrierTrends, activeAllocations, rangeStart]);

  const trendCarriers = [...new Set(activeAllocations.map(a => a.carrierCode))];

  // 6-week TEU trend by contract (Central shipments only)
  const contractTrendData = useMemo(() => {
    const centralSh    = shipments.filter(s => s.contractType === "Central" && s.contractId);
    const contractIds  = [...new Set(centralSh.map(s => s.contractId))];
    const refMap       = {};
    centralSh.forEach(s => { if (!refMap[s.contractId]) refMap[s.contractId] = s.contractRef || String(s.contractId); });
    const weeks = Array.from({ length: 6 }, (_, i) => {
      const wStart = addDays(rangeStart, -(5 - i) * 7);
      const wEnd   = addDays(wStart, 6);
      const label  = parseIso(wEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      const pt     = { week: label };
      contractIds.forEach(id => {
        pt[id] = centralSh
          .filter(s => s.contractId === id && s.etd >= wStart && s.etd <= wEnd)
          .reduce((acc, s) =>
            acc + containers.filter(c => c.shipmentId === s.id).reduce((a2, c) => a2 + teuOf(c.size), 0), 0);
      });
      return pt;
    });
    return { weeks, contractIds, refMap };
  }, [shipments, containers, rangeStart]);

  const totalConsumed = chartData.reduce((s, d) => s + d.consumed, 0);
  const totalRemain   = Math.max(0, totalAlloc - totalConsumed);

  const TooltipContent = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const d = chartData.find(x => x.carrier === label);
    return (
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 16px" }}>
        <div style={{ fontFamily: T.mono, fontWeight: 700, color: T.accent, marginBottom: 8, fontSize: 13 }}>{label} · {d?.name}</div>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.success }}>Active: {d?.consumed} TEU</div>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Remaining: {d?.remaining} TEU</div>
        <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text,
          borderTop: `1px solid ${T.border}`, marginTop: 8, paddingTop: 8 }}>Total: {d?.total} TEU</div>
      </div>
    );
  };

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Consumption Dashboard</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            TEU allocation &amp; consumption · 20ft = 1 TEU · 40ft = 2 TEU
          </p>
        </div>
      </div>

      {/* ── Date range picker (always visible) ── */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "16px 20px", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
          <Btn variant="secondary" size="sm" onClick={() => shiftRange(-1)}>← Prev</Btn>
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "end" }}>
            <DatePicker label="From" value={rangeStart} onChange={handleStartChange} placeholder="Start date…" />
            <div style={{ fontFamily: T.mono, fontSize: 18, color: T.textMuted, paddingBottom: 9, userSelect: "none" }}>—</div>
            <DatePicker label="To" value={rangeEnd} onChange={handleEndChange}
              minDate={rangeStart} maxDate={rangeStart ? addDays(rangeStart, MAX_RANGE_DAYS) : undefined}
              placeholder="End date…" />
          </div>
          <Btn variant="secondary" size="sm" onClick={() => shiftRange(1)}>Next →</Btn>
          <Btn variant="ghost" size="sm" onClick={goToday}
            style={{ borderLeft: `1px solid ${T.border}`, paddingLeft: 14 }}>
            This Week
          </Btn>
        </div>
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 14,
          borderTop: `1px solid ${T.border}33`, paddingTop: 10 }}>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
            {spanDays} day{spanDays !== 1 ? "s" : ""} · max {MAX_RANGE_DAYS}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            {rangeShipments.length} shipment{rangeShipments.length !== 1 ? "s" : ""} with ETD in range
          </span>
          {activeAllocations.length !== allocations.length && (
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.accent }}>
              ↳ {activeAllocations.length} of {allocations.length} space configs active in this period
            </span>
          )}
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, marginBottom: 24 }}>
        {[
          { key: "overview",   label: "Overview" },
          { key: "contracts",  label: "Contract Consumption" },
          { key: "carriers",   label: "Carrier Volumes" },
          { key: "margin",     label: "Margin" },
          { key: "compliance", label: "Compliance Review", count: Array.isArray(compHits) ? compHits.length : null },
        ].map(tab => (
          <button key={tab.key} type="button" onClick={() => handleTabChange(tab.key)}
            style={{
              padding: "10px 20px", background: "none", border: "none",
              borderBottom: view === tab.key ? `2px solid ${T.accent}` : "2px solid transparent",
              color: view === tab.key ? T.accent : T.textMuted,
              fontFamily: T.body, fontSize: 13, fontWeight: 600,
              cursor: "pointer", marginBottom: -1,
              transition: "color .15s, border-color .15s",
              display: "flex", alignItems: "center", gap: 7,
            }}>
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <span style={{
                background: T.danger, color: "#fff",
                fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                borderRadius: 10, padding: "1px 6px", lineHeight: "16px",
              }}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Overview tab ── */}
      {view === "overview" && (
        <>
          {/* KPIs */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 26 }}>
            {[
              { label: "Total Allocated",    value: totalAlloc,    color: T.text,    sub: `${activeAllocations.length} configuration${activeAllocations.length !== 1 ? "s" : ""}` },
              { label: "Active Consumption", value: totalConsumed, color: T.success, sub: `${totalAlloc > 0 ? ((totalConsumed / totalAlloc) * 100).toFixed(1) : 0}% of total utilized` },
              { label: "Remaining Capacity", value: totalRemain,   color: T.accent,  sub: "available to book" },
            ].map((k, i) => (
              <div key={i} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 24px" }}>
                <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>{k.label}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, margin: "8px 0 4px" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 36, fontWeight: 700, color: k.color }}>{k.value}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 14, color: T.textMuted }}>TEU</span>
                </div>
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{k.sub}</div>
              </div>
            ))}
          </div>

          {/* Shipment health: on-time vs overdue */}
          {(() => {
            const active   = shipments.filter(s => s.status === "Active");
            const overdue  = active.filter(s => s.overdueCount > 0);
            const onTime   = active.length - overdue.length;
            const pct      = active.length > 0 ? Math.round((onTime / active.length) * 100) : null;
            if (active.length === 0) return null;
            const barW = pct ?? 100;
            return (
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
                padding: "16px 24px", marginBottom: 26, display: "flex", alignItems: "center", gap: 32 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
                    Active Shipment Health
                  </div>
                  <div style={{ height: 8, background: T.bg, borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${barW}%`, background: overdue.length > 0 ? T.warning : T.success,
                      borderRadius: 4, transition: "width .4s" }} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 24, flexShrink: 0 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontFamily: T.mono, fontSize: 26, fontWeight: 700, color: T.success }}>{onTime}</div>
                    <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted }}>On Time</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontFamily: T.mono, fontSize: 26, fontWeight: 700,
                      color: overdue.length > 0 ? T.danger : T.textMuted }}>{overdue.length}</div>
                    <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted }}>Overdue</div>
                  </div>
                  {pct !== null && (
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontFamily: T.mono, fontSize: 26, fontWeight: 700,
                        color: pct === 100 ? T.success : pct >= 80 ? T.warning : T.danger }}>{pct}%</div>
                      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted }}>On-Time Rate</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Charts */}
          {chartData.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 20px 14px" }}>
                <div style={{ marginBottom: 16 }}>
                  <h2 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 3px" }}>TEU by Carrier</h2>
                  <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>Awarded vs consumed for the selected period</p>
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={chartData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                    <XAxis dataKey="carrier" tick={{ fontFamily: T.mono, fontSize: 11, fill: T.textMuted }} axisLine={{ stroke: T.border }} tickLine={false} />
                    <YAxis tick={{ fontFamily: T.body, fontSize: 10, fill: T.textMuted }} axisLine={false} tickLine={false} />
                    <Tooltip content={<TooltipContent />} cursor={{ fill: T.border + "44" }} />
                    <Legend wrapperStyle={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, paddingTop: 10 }} />
                    <Bar dataKey="consumed"  name="Consumed"  stackId="s" fill={T.success} />
                    <Bar dataKey="remaining" name="Remaining" stackId="s" fill={T.borderMid} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 20px 14px" }}>
                <div style={{ marginBottom: 16 }}>
                  <h2 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 3px" }}>6-Week TEU Trend</h2>
                  <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>Weekly shipment consumption per carrier — last 6 weeks</p>
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={trendChartData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                    <XAxis dataKey="week" tick={{ fontFamily: T.mono, fontSize: 10, fill: T.textMuted }} axisLine={{ stroke: T.border }} tickLine={false} />
                    <YAxis tick={{ fontFamily: T.body, fontSize: 10, fill: T.textMuted }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontFamily: T.body, fontSize: 12 }}
                      labelStyle={{ color: T.text, fontWeight: 600, marginBottom: 4 }} itemStyle={{ color: T.textMuted }}
                      formatter={(v, name) => [`${v} TEU`, name]} cursor={{ stroke: T.border, strokeWidth: 1 }} />
                    <Legend wrapperStyle={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, paddingTop: 10 }} />
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

          {/* Matched shipments */}
          <MatchedShipmentsTable
            shipments={rangeShipments}
            containers={containers}
            carriers={carriers}
            activeAllocations={activeAllocations}
          />
        </>
      )}

      {/* ── Contract Consumption tab ── */}
      {view === "contracts" && (
        <ContractConsumptionView
          rangeShipments={rangeShipments}
          containers={containers}
          carriers={carriers}
          allocations={activeAllocations}
          contractTrendData={contractTrendData}
        />
      )}

      {/* ── Carrier Volumes tab ── */}
      {view === "carriers" && (
        <CarrierView
          rangeShipments={rangeShipments}
          containers={containers}
          carriers={carriers}
          carrierTrends={carrierTrends}
          rangeStart={rangeStart}
        />
      )}

      {/* ── Margin tab ── */}
      {view === "margin" && <MarginView financeEnabled={financeEnabled} />}

      {/* ── Compliance Review tab ── */}
      {view === "compliance" && (
        <ComplianceReviewView
          compHits={compHits}
          custHits={custHits}
          loading={compLoading}
          onRefresh={loadCompliance}
        />
      )}

    </div>
  );
};

export default DashboardPage;