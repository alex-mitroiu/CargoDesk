import { useState, useEffect, useRef } from "react";
import { T, CONTRACT_PRESETS, CONTAINER_TYPES, STATUSES, INCOTERMS_2020,
         statusVariant, contractVariant, teuOf, addDays, diffDays } from "../tokens";
import { api } from "../api";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import DatePicker from "../components/primitives/DatePicker";
import PortField from "../components/shared/PortField";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import { VesselField } from "../components/shared/VesselCombobox";
import { inputBase, BtnToggle, Inp, Sel, Textarea, Field, ContractTypeInput } from "../components/primitives/Form";
import { CommodityCombobox } from "../components/shared/CommodityCombobox";
import CustomerCombobox from "../components/shared/CustomerCombobox";
import Spinner from "../components/primitives/Spinner";
import { useResizableColumns, ColResizer } from "../components/primitives/useResizableColumns";
import ActionMenu from "../components/primitives/ActionMenu";
import EntityHistoryModal from "../components/shared/EntityHistoryModal";

// ─── Contract Picker Modal (Central) — two-path: space configs → contracts ─────

const SKIP_REASONS = [
  { value: "exhausted",             label: "Allocation exhausted" },
  { value: "carrier_direct",        label: "Carrier-direct booking" },
  { value: "customer_request",      label: "Customer request" },
  { value: "operational_exception", label: "Operational exception" },
];
const OVERAGE_REASONS = [
  { value: "carrier_verbal", label: "Carrier verbal approval" },
  { value: "priority_cargo", label: "Priority cargo" },
  { value: "emergency",      label: "Emergency booking" },
  { value: "agreed_uplift",  label: "Agreed uplift" },
];

const ContractPickerModal = ({ pol, pod, matches, allocs, shipmentTEU = 0, onSelectContract, onSelectAllocation, onClose }) => {
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [skipMode,       setSkipMode]       = useState(false);
  const [skipReason,     setSkipReason]     = useState("");
  const [overageReasons, setOverageReasons] = useState({});

  const isLoading    = matches === null || allocs === null;
  const hasAllocs    = allocs && allocs.length > 0;
  const contractsLocked = hasAllocs && !skipReason;

  const kindBadge = kind => kind === "exact"
    ? { label: "Exact match",     bg: T.success + "22", color: T.success }
    : { label: "Via linked port", bg: T.info    + "22", color: T.info    };

  const totalUsd = rates => rates && rates.length ? rates.reduce((s, r) => s + r.amountUsd, 0) : null;
  const fmtUsd   = v => `$${Math.round(v).toLocaleString("en-US")}`;

  // ── Allocation card ────────────────────────────────────────────────────────
  const renderAllocCard = alloc => {
    const pct      = alloc.allocatedTEU > 0 ? Math.round((alloc.consumedTEU / alloc.allocatedTEU) * 100) : 0;
    const overage  = shipmentTEU > 0 && shipmentTEU > alloc.remainingTEU;
    const reason   = overageReasons[alloc.id] || "";
    const canSelect = !overage || !!reason;
    const k        = kindBadge(alloc.matchKind);
    return (
      <div key={alloc.id} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Route + badges */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{alloc.carrierCode}</span>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{alloc.pol} → {alloc.pod}</span>
          <span style={{ background: k.bg, color: k.color, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{k.label}</span>
          {alloc.linkedPolVia && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.info }}>POL via {alloc.linkedPolVia}</span>}
          {alloc.linkedPodVia && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.info }}>POD via {alloc.linkedPodVia}</span>}
        </div>
        {/* Contract + validity */}
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          {alloc.contractNumber
            ? <>Contract <span style={{ fontFamily: T.mono, color: T.text }}>{alloc.contractNumber}</span>{" · "}</>
            : null}
          Valid {alloc.effectiveDate} → {alloc.endDate}
        </div>
        {/* TEU summary + bar */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ display: "flex", gap: 14, fontFamily: T.mono, fontSize: 11, flexWrap: "wrap" }}>
            <span style={{ color: T.text, fontWeight: 600 }}>{alloc.allocatedTEU} TEU allocated</span>
            <span style={{ color: T.textMuted }}>{alloc.consumedTEU} consumed</span>
            <span style={{ color: alloc.remainingTEU > 0 ? T.success : T.danger, fontWeight: 700 }}>{alloc.remainingTEU} remaining</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: T.border + "88", overflow: "hidden" }}>
            <div style={{ height: "100%", borderRadius: 3, width: `${Math.min(100, pct)}%`,
              background: pct >= 100 ? T.danger : pct >= alloc.alertThreshold ? T.warning : T.success, transition: "width .3s" }} />
          </div>
        </div>
        {/* Overage warning + reason picker */}
        {overage && (
          <div style={{ background: T.warning + "15", border: `1px solid ${T.warning}55`, borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.warning, fontWeight: 600 }}>
              ⚠ Shipment is {shipmentTEU} TEU — only {alloc.remainingTEU} TEU remaining (Δ +{shipmentTEU - alloc.remainingTEU})
            </div>
            <select value={reason} onChange={e => setOverageReasons(p => ({ ...p, [alloc.id]: e.target.value }))}
              style={{ ...inputBase, fontFamily: T.body, fontSize: 13 }}>
              <option value="">Select overage reason to proceed…</option>
              {OVERAGE_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
        )}
        <Btn disabled={!canSelect} onClick={() => canSelect && onSelectAllocation(alloc, reason)}
          style={{ alignSelf: "flex-start" }}>
          Select this configuration
        </Btn>
      </div>
    );
  };

  // ── Contract card + group renderer ────────────────────────────────────────
  const sorted = matches ? [...matches].sort((a, b) => {
    const ta = totalUsd(a.rates) ?? Infinity;
    const tb = totalUsd(b.rates) ?? Infinity;
    return ta - tb;
  }) : null;

  const lowestTotal = sorted && sorted.length > 0
    ? Math.min(...sorted.map(c => totalUsd(c.rates) ?? Infinity).filter(v => v < Infinity))
    : null;

  const groups = sorted ? (() => {
    const map = new Map();
    for (const c of sorted) {
      if (!map.has(c.contractNumber)) map.set(c.contractNumber, []);
      map.get(c.contractNumber).push(c);
    }
    return [...map.values()];
  })() : null;

  const toggleGroup = num =>
    setExpandedGroups(prev => { const next = new Set(prev); next.has(num) ? next.delete(num) : next.add(num); return next; });

  const renderCard = (c, { indented = false } = {}) => {
    const k      = kindBadge(c.matchKind);
    const rates  = c.rates || [];
    const total  = totalUsd(rates);
    const isBest = !contractsLocked && lowestTotal !== null && total === lowestTotal && sorted.length > 1;
    return (
      <button key={c.id} type="button"
        onClick={() => !contractsLocked && onSelectContract(c, skipReason)}
        disabled={contractsLocked}
        style={{
          display: "flex", alignItems: "center", gap: 14, width: "100%",
          padding: "12px 14px", background: T.bg, textAlign: "left",
          border: `1px solid ${isBest ? T.success + "88" : T.border}`,
          borderRadius: 8, cursor: contractsLocked ? "not-allowed" : "pointer",
          opacity: contractsLocked ? 0.45 : 1, transition: "border-color .15s",
          ...(indented && { marginLeft: 16, width: "calc(100% - 16px)", borderLeft: `3px solid ${T.accent}22` }),
        }}
        onMouseEnter={e => { if (!contractsLocked) e.currentTarget.style.borderColor = T.accent; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = isBest ? T.success + "88" : T.border; }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {!indented && <span style={{ fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{c.contractNumber}</span>}
            {c.contractRef
              ? <span style={{ fontFamily: T.mono, fontSize: indented ? 13 : 12, fontWeight: indented ? 700 : 400, color: indented ? T.accent : T.text }}>{c.contractRef}</span>
              : indented && <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>No reference</span>}
            {c.namedAccount && <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{indented ? "" : "· "}{c.namedAccount}</span>}
            <span style={{ background: k.bg, color: k.color, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{k.label}</span>
            {isBest && <span style={{ background: T.success + "22", color: T.success, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>Best rate</span>}
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Valid {c.validFrom} → {c.validTo}</span>
            {c.linkedPolVia && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.info }}>POL via {c.linkedPolVia}</span>}
            {c.linkedPodVia && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.info }}>POD via {c.linkedPodVia}</span>}
          </div>
          {c.legs && c.legs.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {c.legs.map((l, i) => (
                <span key={i} style={{ fontFamily: T.mono, fontSize: 11, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 4, padding: "2px 8px", color: T.text }}>
                  {l.pol} → {l.pod}
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0, minWidth: 80 }}>
          {total !== null
            ? <span style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 700, color: isBest ? T.success : T.text, letterSpacing: "-.01em" }}>{fmtUsd(total)}</span>
            : <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted }}>—</span>}
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{c.carrierCode}</span>
        </div>
      </button>
    );
  };

  return (
    <Modal title={`Select Contract — ${pol} → ${pod}`} onClose={onClose} width={680}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

        {isLoading && <div style={{ padding: 40, display: "flex", justifyContent: "center" }}><Spinner /></div>}

        {!isLoading && (
          <>
            {/* ── Space Configurations section ──────────────────────────────── */}
            {hasAllocs && (
              <>
                <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>📦 Space Configurations</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, fontWeight: 400 }}>
                    {allocs.length} found for this route
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {allocs.map(renderAllocCard)}
                </div>

                {/* Skip divider */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "2px 0" }}>
                  <div style={{ flex: 1, height: 1, background: T.border }} />
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>or</span>
                  <div style={{ flex: 1, height: 1, background: T.border }} />
                </div>

                {/* Skip affordance */}
                {!skipMode ? (
                  <button type="button" onClick={() => setSkipMode(true)}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
                      background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
                      cursor: "pointer", color: T.textMuted, fontFamily: T.body, fontSize: 13,
                      transition: "all .15s", textAlign: "left" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.text; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}>
                    <span style={{ fontSize: 14 }}>↷</span>
                    <span>Skip space configurations — choose a contract directly</span>
                  </button>
                ) : !skipReason ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8 }}>
                    <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text }}>Reason for skipping space configurations</div>
                    <select value={skipReason} onChange={e => setSkipReason(e.target.value)}
                      style={{ ...inputBase, fontFamily: T.body, fontSize: 13 }}>
                      <option value="">Select reason…</option>
                      {SKIP_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    <button type="button" onClick={() => setSkipMode(false)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontFamily: T.body, fontSize: 11, alignSelf: "flex-start", padding: 0, textDecoration: "underline" }}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: T.success + "18", border: `1px solid ${T.success}44`, borderRadius: 8 }}>
                    <span style={{ color: T.success, fontSize: 14 }}>✓</span>
                    <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1 }}>
                      Skipping: <strong>{SKIP_REASONS.find(r => r.value === skipReason)?.label}</strong>
                    </span>
                    <button type="button" onClick={() => setSkipReason("")}
                      style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontFamily: T.body, fontSize: 11, padding: 0, textDecoration: "underline" }}>
                      Change
                    </button>
                  </div>
                )}
              </>
            )}

            {/* ── Contracts section ─────────────────────────────────────────── */}
            {matches !== null && (
              <>
                {hasAllocs && (
                  <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text, display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <span>📄 Contracts</span>
                    {contractsLocked
                      ? <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontWeight: 400 }}>— skip configurations above to unlock</span>
                      : sorted && sorted.length > 0 && (
                          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, fontWeight: 400 }}>
                            {sorted.length} found{groups && groups.length < sorted.length ? ` in ${groups.length} groups` : ""}
                          </span>
                        )}
                  </div>
                )}

                {(!hasAllocs || !contractsLocked) && sorted && sorted.length > 1 && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, paddingRight: 2 }}>
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                      Sorted by lowest buy rate · {sorted.length} contract{sorted.length !== 1 ? "s" : ""}
                      {groups && groups.length < sorted.length ? ` in ${groups.length} group${groups.length !== 1 ? "s" : ""}` : ""}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>All prices expressed in USD</span>
                  </div>
                )}

                {sorted.length === 0 && (
                  <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                    No active contracts found for {pol} → {pod} within the ETD validity window.
                  </div>
                )}

                {groups !== null && groups.map(members => {
                  if (members.length === 1) return renderCard(members[0]);

                  const num          = members[0].contractNumber;
                  const isOpen       = expandedGroups.has(num);
                  const groupBest    = Math.min(...members.map(c => totalUsd(c.rates) ?? Infinity).filter(v => v < Infinity));
                  const isBestGroup  = !contractsLocked && lowestTotal !== null && groupBest === lowestTotal;
                  const groupCarrier = [...new Set(members.map(m => m.carrierCode))].join(", ");

                  return (
                    <div key={num} style={{ display: "flex", flexDirection: "column", gap: 6, opacity: contractsLocked ? 0.45 : 1 }}>
                      <button type="button" onClick={() => !contractsLocked && toggleGroup(num)}
                        disabled={contractsLocked}
                        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "11px 14px", background: T.surface,
                          border: `1px solid ${isOpen ? T.accent + "66" : T.border}`, borderRadius: 8,
                          cursor: contractsLocked ? "not-allowed" : "pointer", textAlign: "left", transition: "border-color .15s" }}
                        onMouseEnter={e => { if (!contractsLocked) e.currentTarget.style.borderColor = T.accent; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = isOpen ? T.accent + "66" : T.border; }}>
                        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, flexShrink: 0, width: 12 }}>{isOpen ? "▾" : "▸"}</span>
                        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                          <span style={{ fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{num}</span>
                          <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, background: T.accent + "18", color: T.accent, border: `1px solid ${T.accent}44`, borderRadius: 4, padding: "1px 7px" }}>
                            {members.length} variants
                          </span>
                          {isBestGroup && <span style={{ background: T.success + "22", color: T.success, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>Best rate</span>}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                          {groupBest < Infinity
                            ? <span style={{ fontFamily: T.mono, fontSize: 13, color: isBestGroup ? T.success : T.textMuted, fontWeight: 600 }}>from {fmtUsd(groupBest)}</span>
                            : <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted }}>—</span>}
                          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{groupCarrier}</span>
                        </div>
                      </button>
                      {isOpen && !contractsLocked && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {members.map(c => renderCard(c, { indented: true }))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};

// ─── ContractField ─────────────────────────────────────────────────────────────

const ContractField = ({ value, onChange, pol, pod, etd, contractType }) => {
  const isCentral = contractType === "Central";

  const [matches,    setMatches]    = useState(null);
  const [allocs,     setAllocs]     = useState(null);
  const [matching,   setMatching]   = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const matchTimer   = useRef(null);
  const autoSelected = useRef(false);

  useEffect(() => {
    clearTimeout(matchTimer.current);
    if (!isCentral) { setMatches(null); setAllocs(null); autoSelected.current = false; return; }
    if (!pol || !pod || !etd) { setMatches(null); setAllocs(null); return; }
    setMatching(true);
    matchTimer.current = setTimeout(async () => {
      try {
        const [contractRes, allocRes] = await Promise.all([
          api.contracts.match({ pol, pod, etd }),
          api.allocations.match({ pol, pod, etd }),
        ]);
        setMatches(contractRes);
        setAllocs(allocRes);
        // Auto-select only when no space configs found and exactly one contract matches
        if (allocRes.length === 0 && contractRes.length === 1 && !value.id && !autoSelected.current) {
          autoSelected.current = true;
          onChange({ id: contractRes[0].id, ref: contractRes[0].contractNumber, carrierCode: contractRes[0].carrierCode, allocationId: "", spaceSkipReason: "", spaceOverageReason: "" });
        }
      } catch {
        setMatches([]);
        setAllocs([]);
      } finally {
        setMatching(false);
      }
    }, 400);
  }, [isCentral, pol, pod, etd]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearContract = () => {
    onChange({ id: "", ref: "", carrierCode: null, allocationId: "", spaceSkipReason: "", spaceOverageReason: "" });
    autoSelected.current = false;
  };

  const pickContract = (c, skipReason = "") => {
    onChange({ id: c.id, ref: c.contractNumber, carrierCode: c.carrierCode, allocationId: "", spaceSkipReason: skipReason, spaceOverageReason: "" });
    setPickerOpen(false);
  };

  const pickAllocation = (alloc, overageReason = "") => {
    onChange({ id: alloc.contractId, ref: alloc.contractNumber, carrierCode: alloc.carrierCode, allocationId: alloc.id, spaceSkipReason: "", spaceOverageReason: overageReason });
    setPickerOpen(false);
  };

  const allReady = pol && pod && etd;

  if (isCentral) {
    const hasAllocs     = allocs && allocs.length > 0;
    const missing = !pol ? "POL" : !pod ? "POD" : !etd ? "ETD" : null;
    const browseLabel   = missing
      ? `Set ${missing} first to search for contracts`
      : matching
        ? "Searching…"
        : matches === null
          ? "Browse matching contracts…"
          : hasAllocs
            ? `${allocs.length} space config${allocs.length !== 1 ? "s" : ""} + ${matches.length} contract${matches.length !== 1 ? "s" : ""} — click to review`
            : matches.length === 0
              ? "No contracts found for this route"
              : `${matches.length} contract${matches.length !== 1 ? "s" : ""} found — click to select`;

    const browseDisabled = !!missing || (!hasAllocs && matches !== null && matches.length === 0);

    return (
      <Field label="Contract Ref">
        {value.id ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
            background: T.bg, border: `1px solid ${T.accent}55`, borderRadius: 6 }}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700, flex: 1 }}>
              {value.ref}
            </span>
            {value.allocationId && (
              <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                background: T.success + "22", color: T.success,
                border: `1px solid ${T.success}44`, borderRadius: 4, padding: "2px 8px", whiteSpace: "nowrap" }}>
                📦 Space config
              </span>
            )}
            <button type="button" onClick={() => setPickerOpen(true)}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
                cursor: "pointer", color: T.text, fontFamily: T.body, fontSize: 11, padding: "2px 8px" }}>
              Change
            </button>
            <button type="button" onClick={clearContract}
              style={{ background: "none", border: "none", cursor: "pointer",
                color: T.textMuted, fontSize: 13, padding: "0 2px", lineHeight: 1 }}>
              ✕
            </button>
          </div>
        ) : (
          <button type="button"
            onClick={() => !browseDisabled && setPickerOpen(true)}
            style={{ ...inputBase, width: "100%",
              cursor: browseDisabled ? (missing ? "not-allowed" : "default") : "pointer",
              textAlign: "left", fontFamily: T.body, fontSize: 13,
              color: !missing && !hasAllocs && matches !== null && matches.length === 0 ? T.danger : T.textMuted,
              background: T.bg, borderStyle: missing ? "solid" : "dashed",
              opacity: browseDisabled ? 0.55 : 1 }}>
            {browseLabel}
          </button>
        )}

        {pickerOpen && (
          <ContractPickerModal
            pol={pol} pod={pod}
            matches={matches}
            allocs={allocs}
            onSelectContract={pickContract}
            onSelectAllocation={pickAllocation}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </Field>
    );
  }

};

const ShipmentForm = ({ init = {}, onSave, onCancel }) => {
  const [polPort, setPolPort] = useState(init.pol ? { unlocode: init.pol, name: "" } : null);
  const [podPort, setPodPort] = useState(init.pod ? { unlocode: init.pod, name: "" } : null);
  const [f, setF] = useState({
    carrierCode:   init.carrierCode   || "",
    contractType:  init.contractType  || "SPOT",
    contractNotes: init.contractNotes || "",
    status:        init.status        || "Active",
    etd:           init.etd           || "",
    eta:           init.eta           || "",
    bookingRef:    init.bookingRef     || "",
    blNumber:      init.blNumber      || "",
    vessel:        init.vessel        || "",
    vesselImo:     init.vesselImo     || "",
    voyage:        init.voyage        || "",
    incoterm:      init.incoterm      || "",
    contractId:    init.contractId     || "",
    contractRef:   init.contractRef    || "",
    commodityCode: init.commodityCode  || "",
    shipperId:     init.shipperId      || "",
    shipperName:   init.shipperName    || "",
    consigneeId:   init.consigneeId    || "",
    consigneeName: init.consigneeName  || "",
    principalId:       init.principalId       || "",
    principalName:     init.principalName     || "",
    allocationId:      init.allocationId      || "",
    spaceSkipReason:   init.spaceSkipReason   || "",
    spaceOverageReason: init.spaceOverageReason || "",
  });
  const [carrierUpdated, setCarrierUpdated] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const set = k => v => setF(p => ({ ...p, [k]: v }));

  const isCentral = f.contractType === "Central";
  const valid = polPort?.unlocode?.length === 5 && podPort?.unlocode?.length === 5
    && f.carrierCode && f.contractType.trim().length > 0 && f.incoterm !== ""
    && f.commodityCode.trim().length > 0
    && (!isCentral || f.contractId.trim().length > 0);

  const handleSave = async () => {
    if (!valid) return;
    setIsSaving(true);
    try {
      await onSave({ ...f, pol: polPort.unlocode, pod: podPort.unlocode });
    } finally { setIsSaving(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Parties */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <CustomerCombobox label="Shipper"
          value={{ id: f.shipperId, name: f.shipperName }}
          onChange={v => setF(p => ({ ...p, shipperId: v.id, shipperName: v.name }))} />
        <CustomerCombobox label="Consignee"
          value={{ id: f.consigneeId, name: f.consigneeName }}
          onChange={v => setF(p => ({ ...p, consigneeId: v.id, consigneeName: v.name }))} />
        <CustomerCombobox label="Principal"
          value={{ id: f.principalId, name: f.principalName }}
          onChange={v => setF(p => ({ ...p, principalId: v.id, principalName: v.name }))} />
      </div>

      {/* Ports */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <PortField label="Port of Loading"   value={polPort} onChange={setPolPort} placeholder="Search POL (NLRTM, Rotterdam…)" required />
        <PortField label="Port of Discharge" value={podPort} onChange={setPodPort} placeholder="Search POD (CNSHA, Shanghai…)" required />
      </div>

      {/* Carrier */}
      <Field label="Carrier" required>
        <CarrierCombobox value={f.carrierCode} onChange={set("carrierCode")} />
      </Field>

      {/* Incoterm — mandatory */}
      <Sel label="Incoterm" value={f.incoterm} onChange={set("incoterm")} required
        options={[
          { value: "", label: "Select incoterm…" },
          ...INCOTERMS_2020.map(t => ({ value: t.code, label: `${t.code} – ${t.name}` })),
        ]}
      />

      {/* Commodity — mandatory, core cargo identity */}
      <Field label="Commodity" required hint="Maersk freight type — determines handling, documentation, and service eligibility">
        <CommodityCombobox
          value={f.commodityCode}
          onChange={v => set("commodityCode")(v)}
        />
      </Field>

      {/* Dates + references */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <DatePicker label="ETD" value={f.etd} onChange={set("etd")} hint="Estimated Departure" />
        <DatePicker label="ETA" value={f.eta} onChange={set("eta")} hint="Estimated Arrival"
          minDate={f.etd || undefined} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Booking Reference" value={f.bookingRef} onChange={set("bookingRef")} placeholder="BK-2025-00123" mono />
        <Inp label="B/L Number"        value={f.blNumber}   onChange={set("blNumber")}   placeholder="MAEU123456789" mono />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <VesselField
          vessel={f.vesselImo ? { imo: f.vesselImo, name: f.vessel } : null}
          onSelect={v => setF(p => ({ ...p, vessel: v ? v.name : "", vesselImo: v ? v.imo : "" }))}
        />
        <Inp label="Voyage" value={f.voyage} onChange={set("voyage")} placeholder="423E" mono />
      </div>

      {/* Contract */}
      <ContractTypeInput value={f.contractType} onChange={v => {
        if (v !== "Central") setF(p => ({ ...p, contractType: v, contractId: "", contractRef: "", allocationId: "" }));
        else set("contractType")(v);
      }} />
      {isCentral && (
        <ContractField
          value={{ id: f.contractId, ref: f.contractRef, allocationId: f.allocationId }}
          onChange={({ id, ref, carrierCode, allocationId, spaceSkipReason, spaceOverageReason }) => {
            setF(p => {
              const next = {
                ...p,
                contractId:         id,
                contractRef:        ref,
                allocationId:       allocationId      !== undefined ? allocationId      : p.allocationId,
                spaceSkipReason:    spaceSkipReason   !== undefined ? spaceSkipReason   : p.spaceSkipReason,
                spaceOverageReason: spaceOverageReason !== undefined ? spaceOverageReason : p.spaceOverageReason,
              };
              if (carrierCode !== null && carrierCode !== undefined && carrierCode && carrierCode !== p.carrierCode) {
                setCarrierUpdated(carrierCode);
                next.carrierCode = carrierCode;
              } else if (!id) {
                setCarrierUpdated("");
              }
              return next;
            });
          }}
          pol={polPort?.unlocode}
          pod={podPort?.unlocode}
          etd={f.etd}
          contractType={f.contractType}
        />
      )}
      {isCentral && carrierUpdated && (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.info,
          background: T.info + "18", border: `1px solid ${T.info}44`,
          borderRadius: 6, padding: "6px 10px" }}>
          Carrier updated to <strong style={{ fontFamily: T.mono }}>{carrierUpdated}</strong> to match the selected contract.
        </div>
      )}
      {!isCentral && (
        <Inp label="Contract Reference" value={f.contractRef} onChange={v => setF(p => ({ ...p, contractRef: v }))}
          placeholder="e.g. SPOT-2025-001" mono hint="Free-text reference for this contract arrangement" />
      )}
      <Textarea label="Contract Notes" value={f.contractNotes} onChange={set("contractNotes")}
        placeholder="Optional reference, contract IDs, remarks…" rows={2} />
      <Sel label="Status" value={f.status} onChange={set("status")}
        options={STATUSES.map(s => ({ value: s, label: s }))} />

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={!valid}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {isSaving && <Spinner size="sm" color="currentColor" />}
            {isSaving ? "Saving…" : (init.id ? "Save Changes" : "Create Shipment")}
          </span>
        </Btn>
      </div>
    </div>
  );
};

const ShipmentsPage = ({ shipments, containers, carriers, onSelect, onDelete, onNew, financeEnabled = true }) => {
  const [confirm,       setConfirm]       = useState(null);
  const [historyShipment, setHistoryShipment] = useState(null);
  const [filters,  setFilters]  = useState({ search: '', status: '', carrier: '' });
  const teuFor = id => containers.filter(c => c.shipmentId === id).reduce((s, c) => s + teuOf(c.size), 0);
  const { template: shipTemplate, startResize: shipStartResize } = useResizableColumns("shipments", [140,70,70,150,165,46,60,80,130,90]);
  const shipHeaders = ["Shipment ID","POL","POD","Carrier","Contract","TEU","Status","Margin","Actions"];

  const filtered = shipments.filter(s => {
    if (filters.status  && s.status      !== filters.status)  return false;
    if (filters.carrier && s.carrierCode !== filters.carrier) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!s.id.toLowerCase().includes(q)
        && !s.pol.toLowerCase().includes(q)
        && !s.pod.toLowerCase().includes(q)
        && !(s.bookingRef || '').toLowerCase().includes(q)
        && !(s.blNumber   || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const hasFilters = !!(filters.search || filters.status || filters.carrier);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Shipments</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {hasFilters ? `${filtered.length} of ${shipments.length}` : shipments.length} total
            · {shipments.filter(s => s.status === "Active").length} active
          </p>
        </div>
        <Btn onClick={onNew} size="lg" disabled={carriers.length === 0}>＋ New Shipment</Btn>
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={filters.search}
          onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
          placeholder="Search ID, POL, POD, booking ref…"
          style={{ ...inputBase, flex: "1 1 200px", minWidth: 160 }}
        />
        <select
          value={filters.status}
          onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
          style={{ ...inputBase, width: 148, cursor: "pointer" }}
        >
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={filters.carrier}
          onChange={e => setFilters(f => ({ ...f, carrier: e.target.value }))}
          style={{ ...inputBase, width: 180, cursor: "pointer" }}
        >
          <option value="">All carriers</option>
          {carriers.map(c => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}
        </select>
        {hasFilters && (
          <button
            onClick={() => setFilters({ search: '', status: '', carrier: '' })}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
              color: T.textMuted, cursor: "pointer", padding: "6px 12px",
              fontFamily: T.body, fontSize: 12, whiteSpace: "nowrap" }}>
            ✕ Clear
          </button>
        )}
      </div>

      {carriers.length === 0 && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8,
          padding: "12px 18px", fontFamily: T.body, fontSize: 13, color: T.warning, marginBottom: 18 }}>
          ⚠ Carrier Registry is empty. Go to <strong>Carrier Registry</strong> and add at least one carrier before creating shipments.
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

        {filtered.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            {hasFilters ? "No shipments match your filters." : "No shipments yet. Create your first one above."}
          </div>
        ) : filtered.map(s => {
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
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pol}</span>
                {s.polName && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{s.polName}</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pod}</span>
                {s.podName && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{s.podName}</span>}
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
                  { icon: "↗", label: "Open",    onClick: () => window.open(`#shipments/${s.id}`, "_blank") },
                  { icon: "📋", label: "History", onClick: () => setHistoryShipment(s) },
                  { icon: "✕", label: "Delete",  variant: "danger", onClick: () => setConfirm(s.id) },
                ]} />
              </div>
            </div>
          );
        })}
      </div>

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
    </div>
  );
};

// ─── Page: Shipment Detail ────────────────────────────────────────────────────

export { ShipmentForm };
export default ShipmentsPage;