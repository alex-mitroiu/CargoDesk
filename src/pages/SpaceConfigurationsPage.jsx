import { useState, useEffect, useMemo, useRef } from "react";
import useSaving from "../hooks/useSaving";
import { T, addDays, diffDays, teuOf, LANE_BADGE_VARIANT, todayIso, statusVariant, contractVariant,
  buildLinkedPortIndex, matchedLegFor, allocationRouteMatch } from "../tokens";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Inp, Sel, Textarea, Field } from "../components/primitives/Form";
import PortField from "../components/shared/PortField";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import Spinner from "../components/primitives/spinner";
import Pagination from "../components/primitives/Pagination";
import DatePicker from "../components/primitives/DatePicker";
import { useResizableColumns, ColResizer } from "../components/primitives/useResizableColumns.jsx";
import ActionMenu from "../components/primitives/ActionMenu";
import EntityHistoryModal from "../components/shared/EntityHistoryModal";
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

// ─── Conflict banner ──────────────────────────────────────────────────────────

const ConflictBanner = ({ conflicts, loading }) => {
  if (loading) return (
    <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted,
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 12px" }}>
      Checking for conflicts…
    </div>
  );
  const hasExact        = conflicts.exact?.length > 0;
  const hasCrossContract = conflicts.crossContract?.length > 0;
  const hasLinked       = conflicts.linked?.length > 0;
  if (!hasExact && !hasCrossContract && !hasLinked) return null;

  const rowAccent = kind => kind === "exact" ? T.danger : T.warning;
  const ConflictRow = ({ a, kind }) => (
    <div style={{ borderTop: `1px solid ${rowAccent(kind)}22` }}>
      <div style={{ padding: "8px 12px 4px", display: "flex", flexWrap: "wrap", gap: "4px 16px", alignItems: "center" }}>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: rowAccent(kind), fontWeight: 700 }}>{a.id}</span>
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{a.carrierName}</span>
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>
          {a.pol} <span style={{ color: T.border }}>›</span> {a.pod}
        </span>
        {(a.originLane || a.destLane) && <div style={{ display: "flex" }}><LanePair origin={a.originLane} dest={a.destLane} /></div>}
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{a.effectiveDate} → {a.endDate}</span>
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 600 }}>{a.allocatedTEU} TEU</span>
        {a.contractNumber && (
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
            Contract: <span style={{ color: T.text }}>{a.contractNumber}</span>
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {hasExact && (
        <div style={{ background: T.dangerBg, border: `1px solid ${T.danger}55`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", fontFamily: T.body, fontSize: 12, color: T.danger, fontWeight: 600,
            display: "flex", alignItems: "center", gap: 6 }}>
            <IconForbid size={13} />{conflicts.exact.length} duplicate conflict{conflicts.exact.length > 1 ? "s" : ""} — same carrier, route, contract and overlapping period. Cannot save.
          </div>
          {conflicts.exact.map(a => <ConflictRow key={a.id} a={a} kind="exact" />)}
        </div>
      )}
      {hasCrossContract && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", fontFamily: T.body, fontSize: 12, color: T.warning, fontWeight: 600,
            display: "flex", alignItems: "center", gap: 6 }}>
            <IconWarning size={13} />{conflicts.crossContract.length} overlapping allocation{conflicts.crossContract.length > 1 ? "s" : ""} on this lane under a different contract — allowed, but review intentional.
          </div>
          {conflicts.crossContract.map(a => <ConflictRow key={a.id} a={a} kind="linked" />)}
        </div>
      )}
      {hasLinked && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px 6px", fontFamily: T.body, fontSize: 12, color: T.warning, fontWeight: 600,
            display: "flex", alignItems: "center", gap: 6 }}>
            <IconWarning size={13} />{conflicts.linked.length} linked-port overlap{conflicts.linked.length > 1 ? "s" : ""}
          </div>
          {conflicts.linked.map(a => <ConflictRow key={a.id} a={a} kind="linked" />)}
        </div>
      )}
    </div>
  );
};

// ─── Contract picker modal (for AllocationForm) ───────────────────────────────

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
            <div key={c.id} onClick={() => onSelect(c)}
              onMouseEnter={() => setHovered(c.id)} onMouseLeave={() => setHovered(null)}
              style={{ border: `1px solid ${hovered === c.id ? T.accent : T.border}`, borderRadius: 8,
                padding: "14px 16px", cursor: "pointer",
                background: hovered === c.id ? T.accentBg : T.surface,
                transition: "border-color .12s, background .12s" }}>
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
                <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, flexShrink: 0, marginLeft: 8 }}>{c.validFrom} – {c.validTo}</span>
              </div>
              {c.carrierCode && (
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 6 }}>
                  Carrier: <span style={{ color: T.text, fontWeight: 600 }}>{c.carrierCode}</span>
                </div>
              )}
              {c.legs?.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                  {c.legs.map((leg, i) => (
                    <span key={i} style={{ fontFamily: T.mono, fontSize: 11, background: T.bg,
                      border: `1px solid ${T.border}`, borderRadius: 4, padding: "2px 8px", color: T.textMuted }}>
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

// ─── Allocation Form ──────────────────────────────────────────────────────────

const AllocationForm = ({ init = {}, tradeLanes = [], onSave, onCancel }) => {
  const isEdit = !!init.id;

  const [carrierCode,    setCarrierCode]    = useState(init.carrierCode    || "");
  const [teuStr,         setTeuStr]         = useState(init.allocatedTEU   ? String(init.allocatedTEU) : "");
  const [effectiveDate,  setEffectiveDate]  = useState(init.effectiveDate  || "");
  const [endDate,        setEndDate]        = useState(init.endDate        || "");
  const [notes,          setNotes]          = useState(init.notes          || "");
  const [alertThreshold, setAlertThreshold] = useState(init.alertThreshold ?? 80);
  const [serverErr,      setServerErr]      = useState("");
  const [isSaving,       withSaving]        = useSaving();

  const [contractId,         setContractId]         = useState(init.contractId     || "");
  const [contractNumber,     setContractNumber]     = useState(init.contractNumber || "");
  const [contractMatches,    setContractMatches]    = useState(null);
  const [contractLoading,    setContractLoading]    = useState(false);
  const [contractPickerOpen, setContractPickerOpen] = useState(false);
  const contractTimer           = useRef(null);
  const autoContractSelected    = useRef(false);

  const [polPort,  setPolPort]  = useState(init.pol ? { unlocode: init.pol, name: "" } : null);
  const [podPort,  setPodPort]  = useState(init.pod ? { unlocode: init.pod, name: "" } : null);

  const [originLane,    setOriginLane]    = useState(init.originLane || "");
  const [destLane,      setDestLane]      = useState(init.destLane   || "");
  const [originOptions, setOriginOptions] = useState([]);
  const [destOptions,   setDestOptions]   = useState([]);
  const [laneOverride,  setLaneOverride]  = useState(false);
  const [laneLoading,   setLaneLoading]   = useState(false);

  const [rawConflicts,    setRawConflicts]    = useState({ exact: [], linked: [] });
  const [conflictLoading, setConflictLoading] = useState(false);
  const conflictTimer = useRef(null);

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

  // Contract auto-match
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
          pol: polPort.unlocode, pod: podPort.unlocode,
          carrier: carrierCode, etd: effectiveDate || today,
        });
        setContractMatches(res);
        if (res.length === 1 && !contractId && !autoContractSelected.current) {
          autoContractSelected.current = true;
          setContractId(res[0].id);
          setContractNumber(res[0].contractNumber);
        }
      } catch { setContractMatches([]); }
      finally { setContractLoading(false); }
    }, 400);
    return () => clearTimeout(contractTimer.current);
  }, [carrierCode, polPort?.unlocode, podPort?.unlocode, effectiveDate]);

  // Conflict check
  useEffect(() => {
    clearTimeout(conflictTimer.current);
    if (!carrierCode || !polPort?.unlocode || !podPort?.unlocode || !effectiveDate || !endDate) {
      setRawConflicts({ exact: [], linked: [] }); return;
    }
    conflictTimer.current = setTimeout(async () => {
      setConflictLoading(true);
      try {
        const data = await api.allocations.conflicts({
          carrierCode, pol: polPort.unlocode, pod: podPort.unlocode,
          effectiveDate, endDate, excludeId: init.id || "",
        });
        setRawConflicts(data);
      } catch {}
      setConflictLoading(false);
    }, 500);
    return () => clearTimeout(conflictTimer.current);
  }, [carrierCode, polPort?.unlocode, podPort?.unlocode, effectiveDate, endDate]);

  // Split raw exact conflicts: same contract → hard block, different contract → soft warning
  const conflicts = useMemo(() => ({
    exact:        rawConflicts.exact.filter(a => !contractId || a.contractId === contractId),
    crossContract: rawConflicts.exact.filter(a => contractId && a.contractId !== contractId),
    linked:       rawConflicts.linked,
  }), [rawConflicts, contractId]);

  const handleEffectiveChange = val => {
    setEffectiveDate(val); setServerErr("");
    if (endDate && val && endDate < val) setEndDate(val);
    if (endDate && val) { const m = addDays(val, 90); if (endDate > m) setEndDate(m); }
  };

  const teu    = parseInt(teuStr) || 0;
  const thresh = Math.min(100, Math.max(1, parseInt(alertThreshold) || 80));
  const valid  = carrierCode && teu > 0 && effectiveDate && endDate && endDate >= effectiveDate
               && polPort?.unlocode && podPort?.unlocode && originLane && destLane && contractId
               && !conflicts.exact.length;
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
      <Field label="Carrier" required>
        <CarrierCombobox value={carrierCode} onChange={v => { setCarrierCode(v); setServerErr(""); }} />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <PortField label="Port of Loading (POL)"   value={polPort} onChange={handlePolSelect} placeholder="Search origin port…" required showLinks />
        <PortField label="Port of Discharge (POD)" value={podPort} onChange={handlePodSelect} placeholder="Search destination port…" required showLinks />
      </div>

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
              <Sel label="Origin Lane" value={originLane} onChange={setOriginLane} options={laneSelOpts(originOptions, originLane)} />
              <div style={{ fontFamily: T.mono, fontSize: 18, color: T.textMuted, fontWeight: 700, paddingBottom: 9, userSelect: "none" }}>›</div>
              <Sel label="Destination Lane" value={destLane} onChange={setDestLane} options={laneSelOpts(destOptions, destLane)} />
            </div>
          )}
        </div>
      )}

      {/* Contract picker */}
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
                style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
                  border: `1px solid ${T.accent}`, borderRadius: 5, padding: "4px 12px", cursor: "pointer" }}>
                Change
              </button>
              <button type="button" onClick={() => { setContractId(""); setContractNumber(""); autoContractSelected.current = false; }}
                style={{ fontFamily: T.body, fontSize: 12, color: T.danger, background: "none",
                  border: `1px solid ${T.danger}44`, borderRadius: 5, padding: "4px 10px", cursor: "pointer",
                  display: "inline-flex", alignItems: "center" }}>
                <IconClose size={11} />
              </button>
            </div>
          </div>
        ) : (
          <button type="button"
            disabled={!carrierCode || !polPort?.unlocode || !podPort?.unlocode}
            onClick={() => setContractPickerOpen(true)}
            style={{ width: "100%", padding: "10px 14px", borderRadius: 6, cursor: "pointer",
              background: "none", textAlign: "left",
              border: `1.5px dashed ${(!carrierCode || !polPort?.unlocode || !podPort?.unlocode) ? T.border : T.accent}`,
              color: (!carrierCode || !polPort?.unlocode || !podPort?.unlocode) ? T.textMuted : T.accent,
              fontFamily: T.body, fontSize: 13,
              opacity: (!carrierCode || !polPort?.unlocode || !podPort?.unlocode) ? 0.5 : 1 }}>
            {contractLoading ? "Searching contracts…"
              : (!carrierCode || !polPort?.unlocode || !podPort?.unlocode)
                ? "Set carrier, POL and POD to find matching contracts"
                : contractMatches === null ? "Searching contracts…"
                : contractMatches.length === 0 ? "No matching contracts — click to browse all"
                : `${contractMatches.length} contract${contractMatches.length !== 1 ? "s" : ""} found — click to select`}
          </button>
        )}
      </div>

      {contractPickerOpen && (
        <AllocContractPickerModal
          pol={polPort?.unlocode || ""} pod={podPort?.unlocode || ""}
          matches={contractMatches}
          onSelect={c => { setContractId(c.id); setContractNumber(c.contractNumber); setContractPickerOpen(false); }}
          onClose={() => setContractPickerOpen(false)} />
      )}

      <Inp label="Allocated Space (TEU)" value={teuStr} onChange={setTeuStr}
        type="number" placeholder="100" required hint="Total TEU awarded by this carrier for the period" />

      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 12 }}>
          Effective Period <span style={{ color: T.danger }}>*</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <DatePicker label="Effective From" value={effectiveDate} onChange={handleEffectiveChange}
            placeholder="Start date…" minDate={isEdit ? undefined : todayIso()} />
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

      <ConflictBanner conflicts={conflicts} loading={conflictLoading} />

      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>
          Utilisation Alert Threshold
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <input type="range" min={10} max={100} step={5} value={thresh}
            onChange={e => setAlertThreshold(Number(e.target.value))}
            style={{ flex: 1, accentColor: threshColour, cursor: "pointer" }} />
          <div style={{ minWidth: 52, textAlign: "center", fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: threshColour }}>{thresh}%</div>
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

// ─── Page ─────────────────────────────────────────────────────────────────────

const SpaceConfigurationsPage = ({
  allocations, carriers, shipments, containers,
  onAddAlloc, onEditAlloc, onDeleteAlloc,
  pendingRenew, onPendingRenewClear,
  navigate,
}) => {
  const { canManageConfigs } = useAuth();
  const [allocModal,    setAllocModal]    = useState(null);
  const [confirmAlloc,  setConfirmAlloc]  = useState(null);
  const [renewInit,     setRenewInit]     = useState(null);
  const [historyAlloc,  setHistoryAlloc]  = useState(null);
  const [linkedAlloc,   setLinkedAlloc]   = useState(null); // alloc obj for linked shipments modal
  const [tradeLanes,    setTradeLanes]    = useState([]);
  const [linkedPorts,   setLinkedPorts]   = useState([]);
  const [contractsById, setContractsById] = useState({});

  const { template: allocTemplate, startResize: allocStartResize } =
    useResizableColumns("space-configs", [150, 200, 160, 100, 150, 110, 100, 56]);
  const allocHeaders = ["Carrier", "Name / Route", "Contract", "TEU", "Effective Period", "Consumed", "Status", "Actions"];

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

  // Returns true when a shipment's contract matches an allocation's linked contract
  const contractMatch = (s, a) => {
    if (a.contractId)     return s.contractId === a.contractId;
    if (a.contractNumber) return s.contractRef === a.contractNumber;
    return s.contractType === "Central";
  };

  // Per-allocation consumed TEU — scoped to carrier + contract + route + period
  const consumedPerAlloc = useMemo(() => {
    const m = {};
    allocations.forEach(a => {
      const teu = shipments
        .filter(s =>
          s.carrierCode === a.carrierCode &&
          s.etd >= a.effectiveDate && s.etd <= a.endDate &&
          contractMatch(s, a) &&
          allocationRouteMatch(s, a, contractsById, linkedPortIdx)
        )
        .reduce((sum, s) =>
          sum + containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size), 0), 0);
      m[a.id] = teu;
    });
    return m;
  }, [allocations, shipments, containers, contractsById, linkedPortIdx]);

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
            sum + containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size), 0), 0);
      });
    });
    return m;
  }, [allocations, shipments, containers]);

  const currentAllocs = allocations.filter(a => a.endDate >= today);

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
            {currentAllocs.length} active configuration{currentAllocs.length !== 1 ? "s" : ""} · click <IconSettings size={12} style={{ position: "relative", top: 2 }} /> to edit or view history
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Btn variant="secondary" onClick={() => navigate("dashboard-archive")}><IconArchive size={13} />Archive</Btn>
          {canManageConfigs && <Btn onClick={() => setAllocModal("add")} disabled={carriers.length === 0}>＋ Add Configuration</Btn>}
        </div>
      </div>

      {/* ── Table ── */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
        {/* Header row */}
        <div style={{ display: "grid", gridTemplateColumns: allocTemplate,
          padding: "9px 20px", borderBottom: `1px solid ${T.border}` }}>
          {allocHeaders.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5,
              fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < allocHeaders.length - 1 && <ColResizer onStart={e => allocStartResize(i, e)} />}
            </div>
          ))}
        </div>

        {currentAllocs.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No active configurations. Use "+ Add Configuration" to set up carrier space allocations.
          </div>
        ) : currentAllocs.map(a => {
          const consumed  = consumedPerAlloc[a.id] || 0;
          const remaining = Math.max(0, a.allocatedTEU - consumed);
          const pct       = a.allocatedTEU > 0 ? (consumed / a.allocatedTEU) * 100 : 0;
          const carrier   = carriers.find(c => c.code === a.carrierCode);
          const thresh    = a.alertThreshold ?? 80;
          const barColour = pct >= 100 ? T.danger : pct >= thresh ? (thresh >= 90 ? T.danger : T.warning) : T.success;
          const spark     = sparkPerAlloc[a.id] || [];
          const sparkColor = pct > 5 ? T.success : pct < -5 ? T.danger : T.textMuted;

          const isActive = a.effectiveDate <= today && a.endDate >= today;
          const isFuture = a.effectiveDate > today;
          const statusLabel = isFuture ? "Future" : isActive ? "Active" : "Ending";
          const statusColor = isFuture ? T.accent : isActive ? T.success : T.warning;

          const alertColor = pct >= 100 ? T.danger : T.warning;
          const isAlerting = pct >= thresh;

          return (
            <div key={a.id}
              style={{ display: "grid", gridTemplateColumns: allocTemplate,
                padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                borderLeft: isAlerting ? `3px solid ${alertColor}` : "3px solid transparent",
                transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>

              {/* Carrier */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{a.carrierCode}</span>
                {(a.originLane || a.destLane) && <div style={{ display: "flex" }}><LanePair origin={a.originLane} dest={a.destLane} /></div>}
              </div>

              {/* Name / Route */}
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{carrier?.name || "—"}</span>
                {(a.pol && a.pod) && (
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                    {a.pol} <span style={{ color: T.border }}>›</span> {a.pod}
                  </span>
                )}
                {a.notes && (
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontStyle: "italic",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
                    {a.notes}
                  </span>
                )}
              </div>

              {/* Contract */}
              <div>
                {a.contractNumber
                  ? <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 600 }}>{a.contractNumber}</span>
                  : <span style={{ fontFamily: T.body, fontSize: 12, color: T.danger }}>— missing</span>}
              </div>

              {/* TEU */}
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{a.allocatedTEU} TEU</span>
                <div style={{ background: T.border, borderRadius: 4, height: 4, width: 72, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: barColour, transition: "width .4s" }} />
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 9.5, color: barColour }}>
                  {pct.toFixed(0)}% <span style={{ color: T.border }}>/ {thresh}%</span>
                </span>
              </div>

              {/* Effective Period */}
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.text }}>{a.effectiveDate || "—"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>{a.endDate ? `→ ${a.endDate}` : ""}</span>
              </div>

              {/* Consumed */}
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: consumed > 0 ? T.success : T.textMuted, fontWeight: 600 }}>
                  {consumed} TEU
                </span>
                <Sparkline data={spark} color={sparkColor} />
              </div>

              {/* Status */}
              {isActive && isAlerting ? (
                <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: alertColor }}>
                  ● {pct >= 100 ? "Over Limit" : "At Limit"}
                </span>
              ) : (
                <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: statusColor }}>● {statusLabel}</span>
              )}

              {/* Cog menu */}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <ActionMenu items={[
                  ...(canManageConfigs ? [{ icon: IconPencil, label: "Edit", onClick: () => setAllocModal(a) }] : []),
                  { icon: IconLink,      label: "Linked Shipments",  onClick: () => setLinkedAlloc(a) },
                  { icon: IconClipboard, label: "History",           onClick: () => setHistoryAlloc(a) },
                  ...(canManageConfigs ? [{ icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirmAlloc(a.id) }] : []),
                ]} />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Add / Edit modal ── */}
      {allocModal === "add" && (
        <Modal title={renewInit ? "Renew Space Configuration" : "Add Space Configuration"}
          onClose={() => { setAllocModal(null); setRenewInit(null); }} width={620} minHeight={620}>
          <AllocationForm init={renewInit || {}} tradeLanes={tradeLanes}
            onSave={async form => { await onAddAlloc(form); setAllocModal(null); setRenewInit(null); }}
            onCancel={() => { setAllocModal(null); setRenewInit(null); }} />
        </Modal>
      )}
      {allocModal && allocModal !== "add" && (
        <Modal title="Edit Space Configuration" onClose={() => setAllocModal(null)} width={620} minHeight={620}>
          <AllocationForm init={allocModal} tradeLanes={tradeLanes}
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
        const linked = shipments.filter(s =>
          s.carrierCode === a.carrierCode &&
          s.etd >= a.effectiveDate && s.etd <= a.endDate &&
          contractMatch(s, a) &&
          allocationRouteMatch(s, a, contractsById, linkedPortIdx)
        ).map(s => {
          const leg = contract ? matchedLegFor(contract, linkedPortIdx, s.pol, s.pod) : null;
          return {
            ...s,
            teu: containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size), 0),
            viaLinkedPol: !!leg && leg.pol !== s.pol,
            viaLinkedPod: !!leg && leg.pod !== s.pod,
          };
        }).filter(s => s.teu > 0);

        const totalTEU    = linked.reduce((acc, s) => acc + s.teu, 0);
        const allocated   = a.allocatedTEU;
        const pct         = allocated > 0 ? Math.round((totalTEU / allocated) * 100) : 0;
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
                  <span style={{ color: barColor, fontWeight: 700 }}>{totalTEU}</span>
                  {" / "}{allocated} TEU consumed ({pct}%)
                </div>
                <div style={{ background: T.border + "44", borderRadius: 4, height: 6, width: 140, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, pct)}%`,
                    background: barColor, borderRadius: 4, transition: "width .4s" }} />
                </div>
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
