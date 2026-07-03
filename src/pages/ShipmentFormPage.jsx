import { useState, useEffect, useRef } from "react";
import { toast } from "../toast";
import useSaving from "../hooks/useSaving";
import { T, STATUSES, INCOTERMS_2020, IMDG_CLASSES } from "../tokens";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import Btn from "../components/primitives/Btn";
import { Modal } from "../components/primitives/Modal";
import DatePicker from "../components/primitives/DatePicker";
import PortCombobox from "../components/shared/PortCombobox";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import { inputBase, Inp, Sel, Textarea, Field, ContractTypeInput } from "../components/primitives/Form";
import { useResizableColumns, ColResizer } from "../components/primitives/useResizableColumns";
import { CommodityCombobox } from "../components/shared/CommodityCombobox";
import CustomerCombobox from "../components/shared/CustomerCombobox";
import Spinner from "../components/primitives/Spinner";
import Pagination from "../components/primitives/Pagination";
import { ContainerTypeField } from "../components/shared/ContainerTypePickerModal";

// ─── Contract Picker Modal ────────────────────────────────────────────────────

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

  const isLoading      = matches === null || allocs === null;
  const hasAllocs      = allocs && allocs.length > 0;
  const contractsLocked = hasAllocs && !skipReason;

  const kindBadge = kind => kind === "exact"
    ? { label: "Exact match",     bg: T.success + "22", color: T.success }
    : { label: "Via linked port", bg: T.info    + "22", color: T.info    };

  const totalUsd = rates => rates && rates.length ? rates.reduce((s, r) => s + r.amountUsd, 0) : null;
  const fmtUsd   = v => `$${Math.round(v).toLocaleString("en-US")}`;

  const renderAllocCard = alloc => {
    const pct     = alloc.allocatedTEU > 0 ? Math.round((alloc.consumedTEU / alloc.allocatedTEU) * 100) : 0;
    const overage = shipmentTEU > 0 && shipmentTEU > alloc.remainingTEU;
    const reason  = overageReasons[alloc.id] || "";
    const canSelect = !overage || !!reason;
    const k       = kindBadge(alloc.matchKind);
    return (
      <div key={alloc.id} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{alloc.carrierCode}</span>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{alloc.pol} → {alloc.pod}</span>
          <span style={{ background: k.bg, color: k.color, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{k.label}</span>
        </div>
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          {alloc.contractNumber ? <>Contract <span style={{ fontFamily: T.mono, color: T.text }}>{alloc.contractNumber}</span>{" · "}</> : null}
          Valid {alloc.effectiveDate} → {alloc.endDate}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ display: "flex", gap: 14, fontFamily: T.mono, fontSize: 11, flexWrap: "wrap" }}>
            <span style={{ color: T.text, fontWeight: 600 }}>{alloc.allocatedTEU} TEU allocated</span>
            <span style={{ color: T.textMuted }}>{alloc.consumedTEU} consumed</span>
            <span style={{ color: alloc.remainingTEU > 0 ? T.success : T.danger, fontWeight: 700 }}>{alloc.remainingTEU} remaining</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: T.border + "88", overflow: "hidden" }}>
            <div style={{ height: "100%", borderRadius: 3, width: `${Math.min(100, pct)}%`,
              background: pct >= 100 ? T.danger : pct >= alloc.alertThreshold ? T.warning : T.success }} />
          </div>
        </div>
        {overage && (
          <div style={{ background: T.warning + "15", border: `1px solid ${T.warning}55`, borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.warning, fontWeight: 600 }}>
              ⚠ Shipment is {shipmentTEU} TEU — only {alloc.remainingTEU} TEU remaining
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
    const k     = kindBadge(c.matchKind);
    const rates = c.rates || [];
    const total = totalUsd(rates);
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
          opacity: contractsLocked ? 0.45 : 1,
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
            {c.namedAccount && <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{c.namedAccount}</span>}
            <span style={{ background: k.bg, color: k.color, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{k.label}</span>
            {isBest && <span style={{ background: T.success + "22", color: T.success, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>Best rate</span>}
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Valid {c.validFrom} → {c.validTo}</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0, minWidth: 80 }}>
          {total !== null
            ? <span style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 700, color: isBest ? T.success : T.text }}>{fmtUsd(total)}</span>
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
            {hasAllocs && (
              <>
                <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text }}>📦 Space Configurations</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{allocs.map(renderAllocCard)}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "2px 0" }}>
                  <div style={{ flex: 1, height: 1, background: T.border }} />
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>or</span>
                  <div style={{ flex: 1, height: 1, background: T.border }} />
                </div>
                {!skipMode ? (
                  <button type="button" onClick={() => setSkipMode(true)}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
                      background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
                      cursor: "pointer", color: T.textMuted, fontFamily: T.body, fontSize: 13, textAlign: "left" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.text; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}>
                    <span style={{ fontSize: 14 }}>↷</span>
                    <span>Skip space configurations — choose a contract directly</span>
                  </button>
                ) : !skipReason ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8 }}>
                    <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text }}>Reason for skipping</div>
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
            {matches !== null && (
              <>
                {hasAllocs && (
                  <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text, marginTop: 4 }}>
                    📄 Contracts{contractsLocked && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontWeight: 400 }}> — skip configurations above to unlock</span>}
                  </div>
                )}
                {sorted.length === 0 && (
                  <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                    No active contracts found for {pol} → {pod} within the ETD validity window.
                  </div>
                )}
                {groups !== null && groups.map(members => {
                  if (members.length === 1) return renderCard(members[0]);
                  const num = members[0].contractNumber;
                  const isOpen = expandedGroups.has(num);
                  return (
                    <div key={num} style={{ display: "flex", flexDirection: "column", gap: 6, opacity: contractsLocked ? 0.45 : 1 }}>
                      <button type="button" onClick={() => !contractsLocked && toggleGroup(num)} disabled={contractsLocked}
                        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "11px 14px",
                          background: T.surface, border: `1px solid ${isOpen ? T.accent + "66" : T.border}`,
                          borderRadius: 8, cursor: contractsLocked ? "not-allowed" : "pointer", textAlign: "left" }}>
                        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, flexShrink: 0, width: 12 }}>{isOpen ? "▾" : "▸"}</span>
                        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{num}</span>
                          <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, background: T.accent + "18", color: T.accent, border: `1px solid ${T.accent}44`, borderRadius: 4, padding: "1px 7px" }}>
                            {members.length} variants
                          </span>
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

// ─── ContractField ────────────────────────────────────────────────────────────

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
        if (allocRes.length === 0 && contractRes.length === 1 && !value.id && !autoSelected.current) {
          autoSelected.current = true;
          onChange({ id: contractRes[0].id, ref: contractRes[0].contractNumber, carrierCode: contractRes[0].carrierCode, allocationId: "", spaceSkipReason: "", spaceOverageReason: "" });
        }
      } catch {
        setMatches([]); setAllocs([]);
      } finally { setMatching(false); }
    }, 400);
  }, [isCentral, pol, pod, etd]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearContract = () => { onChange({ id: "", ref: "", carrierCode: null, allocationId: "", spaceSkipReason: "", spaceOverageReason: "" }); autoSelected.current = false; };
  const pickContract  = (c, skipReason = "") => { onChange({ id: c.id, ref: c.contractNumber, carrierCode: c.carrierCode, allocationId: "", spaceSkipReason: skipReason, spaceOverageReason: "" }); setPickerOpen(false); };
  const pickAllocation = (alloc, overageReason = "") => { onChange({ id: alloc.contractId, ref: alloc.contractNumber, carrierCode: alloc.carrierCode, allocationId: alloc.id, spaceSkipReason: "", spaceOverageReason: overageReason }); setPickerOpen(false); };

  if (!isCentral) return null;

  const hasAllocs = allocs && allocs.length > 0;
  const missing   = !pol ? "POL" : !pod ? "POD" : !etd ? "ETD" : null;
  const browseDisabled = !!missing || (!hasAllocs && matches !== null && matches.length === 0);
  const browseLabel = missing
    ? `Set ${missing} first to search for contracts`
    : matching ? "Searching…"
    : matches === null ? "Browse matching contracts…"
    : hasAllocs ? `${allocs.length} space config${allocs.length !== 1 ? "s" : ""} + ${matches.length} contract${matches.length !== 1 ? "s" : ""} — click to review`
    : matches.length === 0 ? "No contracts found for this route"
    : `${matches.length} contract${matches.length !== 1 ? "s" : ""} found — click to select`;

  return (
    <Field label="Contract Ref">
      {value.id ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
          background: T.bg, border: `1px solid ${T.accent}55`, borderRadius: 6 }}>
          <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700, flex: 1 }}>{value.ref}</span>
          {value.allocationId && (
            <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, background: T.success + "22", color: T.success,
              border: `1px solid ${T.success}44`, borderRadius: 4, padding: "2px 8px" }}>📦 Space config</span>
          )}
          <button type="button" onClick={() => setPickerOpen(true)}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4, cursor: "pointer",
              color: T.text, fontFamily: T.body, fontSize: 11, padding: "2px 8px" }}>Change</button>
          <button type="button" onClick={clearContract}
            style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 13, padding: "0 2px", lineHeight: 1 }}>✕</button>
        </div>
      ) : (
        <button type="button" onClick={() => !browseDisabled && setPickerOpen(true)}
          style={{ ...inputBase, width: "100%", cursor: browseDisabled ? "not-allowed" : "pointer",
            textAlign: "left", fontFamily: T.body, fontSize: 13,
            color: !missing && !hasAllocs && matches !== null && matches.length === 0 ? T.danger : T.textMuted,
            background: T.bg, borderStyle: missing ? "solid" : "dashed", opacity: browseDisabled ? 0.55 : 1 }}>
          {browseLabel}
        </button>
      )}
      {pickerOpen && (
        <ContractPickerModal pol={pol} pod={pod} matches={matches} allocs={allocs}
          onSelectContract={pickContract} onSelectAllocation={pickAllocation}
          onClose={() => setPickerOpen(false)} />
      )}
    </Field>
  );
};

// ─── Legs table ───────────────────────────────────────────────────────────────

const MOT_OPTIONS = ["SEA", "ROAD", "AIR", "RAIL"];
const MOT_COLOR   = { SEA: T.info, ROAD: T.warning, AIR: T.accent, RAIL: T.success };

const LEG_COLS = [
  { key: "mot",          label: "MoT",           w: 60  },
  { key: "pol",          label: "POL *",         w: 170 },
  { key: "etd",          label: "ETD",           w: 100 },
  { key: "pod",          label: "POD *",         w: 170 },
  { key: "eta",          label: "ETA",           w: 100 },
  { key: "carrierCode",  label: "Carrier",       w: 138 },
  { key: "vessel",       label: "Vessel",        w: 88  },
  { key: "voyage",       label: "Voyage",        w: 66  },
  { key: "contractType", label: "Ctr. Type",     w: 66  },
  { key: "contractRef",  label: "Contract No.",  w: 78  },
];

const cellInput = {
  background: "transparent", border: "none", outline: "none",
  fontFamily: T.mono, fontSize: 12, color: T.text, width: "100%",
  padding: 0,
};

const LegRow = ({ leg, onSave, onRemove, canEdit, widths, inheritedContractType, inheritedContractRef }) => {
  const [d, setD] = useState(leg);
  useEffect(() => setD(leg), [leg]);
  const set  = k => v => setD(p => ({ ...p, [k]: v }));
  const flush = () => onSave(d);

  if (!canEdit) {
    return (
      <div style={{ display: "flex", borderBottom: `1px solid ${T.border}` }}>
        {LEG_COLS.map((c, i) => (
          <div key={c.key} style={{ width: widths[i], minWidth: widths[i], padding: "10px 8px 10px 10px",
            fontFamily: c.key === "pol" || c.key === "pod" || c.key === "voyage" || c.key === "carrierCode" ? T.mono : T.body,
            fontSize: 12, color: c.key === "mot" ? (MOT_COLOR[d[c.key]] || T.textMuted) : T.text,
            fontWeight: c.key === "mot" ? 700 : 400, borderRight: `1px solid ${T.border}22` }}>
            {c.key === "contractType" ? (inheritedContractType || "—")
              : c.key === "contractRef" ? (inheritedContractRef || "—")
              : (d[c.key] || "—")}
          </div>
        ))}
        <div style={{ width: 36, minWidth: 36 }} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", borderBottom: `1px solid ${T.border}` }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) flush(); }}>

      {/* MoT */}
      <div style={{ width: widths[0], minWidth: widths[0], padding: "8px 0 8px 10px", borderRight: `1px solid ${T.border}33` }}>
        <select value={d.mot} onChange={e => set("mot")(e.target.value)} onBlur={flush}
          style={{ ...cellInput, cursor: "pointer", color: MOT_COLOR[d.mot] || T.textMuted, fontWeight: 700 }}>
          {MOT_OPTIONS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {/* POL */}
      <div style={{ width: widths[1], minWidth: widths[1], borderRight: `1px solid ${T.border}33`, overflow: "visible" }}>
        <PortCombobox
          value={d.pol ? { unlocode: d.pol, name: d.polName || "" } : null}
          onChange={v => {
            const newD = { ...d, pol: v?.unlocode || "", polName: v?.name || "" };
            setD(newD);
            if (v?.unlocode) onSave(newD);
          }}
          placeholder="Search POL…"
        />
      </div>

      {/* ETD */}
      <div style={{ width: widths[2], minWidth: widths[2], padding: "8px 0 8px 10px", borderRight: `1px solid ${T.border}33` }}>
        <input type="date" value={d.etd || ""} onChange={e => set("etd")(e.target.value || null)}
          onBlur={flush} style={cellInput} />
      </div>

      {/* POD */}
      <div style={{ width: widths[3], minWidth: widths[3], borderRight: `1px solid ${T.border}33`, overflow: "visible" }}>
        <PortCombobox
          value={d.pod ? { unlocode: d.pod, name: d.podName || "" } : null}
          onChange={v => {
            const newD = { ...d, pod: v?.unlocode || "", podName: v?.name || "" };
            setD(newD);
            if (v?.unlocode) onSave(newD);
          }}
          placeholder="Search POD…"
        />
      </div>

      {/* ETA */}
      <div style={{ width: widths[4], minWidth: widths[4], padding: "8px 0 8px 10px", borderRight: `1px solid ${T.border}33` }}>
        <input type="date" value={d.eta || ""} onChange={e => set("eta")(e.target.value || null)}
          onBlur={flush} style={cellInput} />
      </div>

      {/* Carrier */}
      <div style={{ width: widths[5], minWidth: widths[5], borderRight: `1px solid ${T.border}33`, overflow: "visible" }}>
        <CarrierCombobox
          value={d.carrierCode || ""}
          onChange={v => {
            const newD = { ...d, carrierCode: v };
            setD(newD);
            onSave(newD);
          }}
        />
      </div>

      {/* Vessel */}
      <div style={{ width: widths[6], minWidth: widths[6], padding: "8px 0 8px 10px", borderRight: `1px solid ${T.border}33` }}>
        <input value={d.vessel} onChange={e => set("vessel")(e.target.value)}
          onBlur={flush} placeholder="Name…" style={{ ...cellInput, fontFamily: T.body }} />
      </div>

      {/* Voyage */}
      <div style={{ width: widths[7], minWidth: widths[7], padding: "8px 0 8px 10px", borderRight: `1px solid ${T.border}33` }}>
        <input value={d.voyage} onChange={e => set("voyage")(e.target.value)}
          onBlur={flush} placeholder="423E" style={cellInput} />
      </div>

      {/* Contract Type — read-only, inherited from shipment-level Contract Type field */}
      <div style={{ width: widths[8], minWidth: widths[8], padding: "8px 0 8px 10px", borderRight: `1px solid ${T.border}33`,
        fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
        {inheritedContractType || "—"}
      </div>

      {/* Contract No. — read-only, inherited from shipment-level Contract No. field */}
      <div style={{ width: widths[9], minWidth: widths[9], padding: "8px 0 8px 10px", borderRight: `1px solid ${T.border}33`,
        fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
        {inheritedContractRef || "—"}
      </div>

      {/* Delete */}
      <div style={{ width: 36, minWidth: 36, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <button onClick={onRemove}
          style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 13, lineHeight: 1, padding: 4 }}
          onMouseEnter={e => e.currentTarget.style.color = T.danger}
          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>✕</button>
      </div>
    </div>
  );
};

const LegsTable = ({ shipmentId, draftLegs, onDraftLegsChange, onLegsChange, inheritedCarrier, inheritedContractType, inheritedContractRef, canEdit }) => {
  const [legs,   setLegs]   = useState([]);
  const [saving, setSaving] = useState(null);
  const isDraft = !shipmentId;
  const { widths, startResize } = useResizableColumns("legs", LEG_COLS.map(c => c.w));

  useEffect(() => {
    if (isDraft) {
      const l = draftLegs || [];
      setLegs(l);
      onLegsChange?.(l);
    } else {
      api.legs.list(shipmentId).then(result => { setLegs(result); onLegsChange?.(result); }).catch(() => {});
    }
  }, [shipmentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const propagate = newLegs => {
    setLegs(newLegs);
    onDraftLegsChange?.(newLegs);
    onLegsChange?.(newLegs);
  };

  const addLeg = async () => {
    const newLeg = {
      mot: "SEA", pol: "", pod: "", etd: null, eta: null,
      carrierCode: inheritedCarrier || "",
      vessel: "", vesselImo: "", voyage: "",
      contractType: inheritedContractType || "SPOT",
      contractRef:  inheritedContractRef  || "",
    };
    if (isDraft) {
      const draftLeg = { ...newLeg, id: `draft_${Date.now()}` };
      propagate([...legs, draftLeg]);
    } else {
      const leg = await api.legs.create(shipmentId, newLeg);
      const next = [...legs, leg];
      setLegs(next);
      onLegsChange?.(next);
    }
  };

  const saveLeg = async leg => {
    const toSave = { ...leg, contractType: inheritedContractType || leg.contractType, contractRef: inheritedContractRef || leg.contractRef };
    if (isDraft) {
      propagate(legs.map(l => l.id === toSave.id ? toSave : l));
    } else {
      setSaving(toSave.id);
      try {
        const updated = await api.legs.update(shipmentId, toSave.id, toSave);
        const next = legs.map(l => l.id === toSave.id ? updated : l);
        setLegs(next);
        onLegsChange?.(next);
      } finally { setSaving(null); }
    }
  };

  const removeLeg = async legId => {
    if (isDraft) {
      propagate(legs.filter(l => l.id !== legId));
    } else {
      await api.legs.remove(shipmentId, legId);
      const next = legs.filter(l => l.id !== legId);
      setLegs(next);
      onLegsChange?.(next);
    }
  };

  const totalCols = widths.reduce((s, w) => s + w, 0) + 36;

  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
      {isDraft && (
        <div style={{ padding: "6px 14px", background: T.info + "12", borderBottom: `1px solid ${T.info}33`,
          fontFamily: T.body, fontSize: 11, color: T.info }}>
          ℹ Draft — legs will be saved when you create the shipment.
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: totalCols }}>
          <div style={{ display: "flex", padding: "10px 0", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
            {LEG_COLS.map((c, i) => (
              <div key={c.key} style={{ position: "relative", width: widths[i], minWidth: widths[i], paddingLeft: 10,
                fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
                borderRight: `1px solid ${T.border}33` }}>
                {c.label}
                {i < LEG_COLS.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
              </div>
            ))}
            <div style={{ width: 36, minWidth: 36 }} />
          </div>
          {legs.length === 0 ? (
            <div style={{ padding: "14px 16px", fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
              No legs yet — add one below.
            </div>
          ) : legs.map(leg => (
            <div key={leg.id} style={{ position: "relative" }}>
              {saving === leg.id && (
                <div style={{ position: "absolute", inset: 0, background: T.accent + "08", zIndex: 1, pointerEvents: "none" }} />
              )}
              <LegRow leg={leg} onSave={saveLeg} onRemove={() => removeLeg(leg.id)} canEdit={canEdit} widths={widths} inheritedContractType={inheritedContractType} inheritedContractRef={inheritedContractRef} />
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 12px", borderTop: legs.length ? `1px solid ${T.border}` : "none", background: T.surface }}>
        <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
          {legs.length} leg{legs.length !== 1 ? "s" : ""}
          {legs.length > 1 && (
            <span style={{ marginLeft: 8, fontFamily: T.mono }}>
              {legs[0]?.pol || "?"} → {legs[legs.length - 1]?.pod || "?"}
            </span>
          )}
        </span>
        {canEdit && (
          <button onClick={addLeg}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
              padding: "4px 12px", fontFamily: T.body, fontSize: 12, color: T.accent, cursor: "pointer" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = T.accent}
            onMouseLeave={e => e.currentTarget.style.borderColor = T.border}>
            + Add leg
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Form helpers ─────────────────────────────────────────────────────────────

const CommodityHint = () => {
  const [vis, setVis] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setVis(true)} onMouseLeave={() => setVis(false)}>
      <span style={{
        fontFamily: T.body, fontSize: 10, fontWeight: 700, fontStyle: "italic",
        color: T.info, cursor: "default", background: T.info + "18",
        border: `1px solid ${T.info}55`, borderRadius: "50%",
        width: 14, height: 14,
        display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
        userSelect: "none",
      }}>i</span>
      {vis && (
        <span style={{
          position: "absolute", left: 0, top: "calc(100% + 7px)", zIndex: 99,
          background: T.info + "12", border: `1px solid ${T.info}44`,
          borderRadius: 8, padding: "8px 12px",
          fontFamily: T.body, fontSize: 11.5, color: T.text, lineHeight: 1.55,
          width: 220, pointerEvents: "none",
          boxShadow: "0 6px 18px rgba(0,0,0,.15)",
        }}>
          <span style={{ display: "block", fontWeight: 700, fontSize: 10,
            textTransform: "uppercase", letterSpacing: "0.07em", color: T.info, marginBottom: 4 }}>
            About this field
          </span>
          Maersk freight type — determines handling, documentation, and service eligibility.
        </span>
      )}
    </span>
  );
};

const SectionDivider = ({ label }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 0" }}>
    <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
      color: T.textMuted, textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</span>
    <div style={{ flex: 1, height: 1, background: T.border }} />
  </div>
);

const FieldError = ({ show, msg }) =>
  show ? <div style={{ fontFamily: T.body, fontSize: 11, color: T.danger, marginTop: 2 }}>{msg}</div> : null;

const errRing = show => show
  ? { borderRadius: 8, boxShadow: `0 0 0 2px ${T.danger}55`, transition: "box-shadow .15s" }
  : { transition: "box-shadow .15s" };

// ─── ShipmentForm ─────────────────────────────────────────────────────────────

const ShipmentForm = ({ init = {}, onSave, onBack, onDirtyChange, draftLegs, onDraftLegsChange }) => {
  const { canEdit } = useAuth();
  const [legs,    setLegs]   = useState([]);
  const [touched, setTouch]  = useState({});
  const touch = k => setTouch(p => ({ ...p, [k]: true }));

  const [f, setF] = useState({
    carrierCode:        init.carrierCode        || "",
    contractType:       init.contractType       || "SPOT",
    contractNotes:      init.contractNotes      || "",
    status:             init.status             || "Active",
    etd:                init.etd                || "",
    eta:                init.eta                || "",
    bookingRef:         init.bookingRef         || "",
    blNumber:           init.blNumber           || "",
    vessel:             init.vessel             || "",
    vesselImo:          init.vesselImo          || "",
    voyage:             init.voyage             || "",
    incoterm:           init.incoterm           || "",
    contractId:         init.contractId         || "",
    contractRef:        init.contractRef        || "",
    commodityCode:      init.commodityCode      || "",
    shipperId:          init.shipperId          || "",
    shipperName:        init.shipperName        || "",
    consigneeId:        init.consigneeId        || "",
    consigneeName:      init.consigneeName      || "",
    principalId:        init.principalId        || "",
    principalName:      init.principalName      || "",
    notifyId:           init.notifyId           || "",
    notifyName:         init.notifyName         || "",
    allocationId:       init.allocationId       || "",
    spaceSkipReason:    init.spaceSkipReason    || "",
    spaceOverageReason: init.spaceOverageReason || "",
    freightTerms:       init.freightTerms       || "Prepaid",
    movementType:       init.movementType       || "FCL",
    serviceType:        init.serviceType        || "Port-to-Port",
    placeOfReceipt:     init.placeOfReceipt     || "",
    placeOfDelivery:    init.placeOfDelivery    || "",
    cargoReadyDate:     init.cargoReadyDate     || "",
  });
  const [carrierUpdated, setCarrierUpdated] = useState("");
  const [isSaving, withSaving] = useSaving();
  const set = k => v => setF(p => ({ ...p, [k]: v }));

  const [quickCargo, setQuickCargo] = useState({
    count: '', size: '', type: '', weight: '', volume: '',
    distribution: 'all', cargoDescription: '', isDg: false, dgClass: '',
  });
  const [draftContainers,  setDraftContainers]  = useState([]);
  const [contractDgPolicy, setContractDgPolicy] = useState(null); // { dgAllowed, imdgClasses }

  // Keep already-generated containers in sync when the user edits cargo fields after clicking Generate.
  // Uses functional updater so prev always reflects the latest state, not the stale closure.
  useEffect(() => {
    setDraftContainers(prev => {
      if (prev.length === 0) return prev;
      const n = prev.length;
      const totalWeight = parseFloat(quickCargo.weight) || 0;
      const totalVolume = parseFloat(quickCargo.volume) || 0;
      const perWeight = quickCargo.distribution === 'all'
        ? (totalWeight ? +((totalWeight / n).toFixed(2)) : null)
        : (totalWeight || null);
      const perVolume = quickCargo.distribution === 'all'
        ? (totalVolume ? +((totalVolume / n).toFixed(2)) : null)
        : (totalVolume || null);
      return prev.map(c => ({ ...c, grossWeightKg: perWeight, volumeCbm: perVolume, cargoDescription: quickCargo.cargoDescription }));
    });
  }, [quickCargo.weight, quickCargo.volume, quickCargo.cargoDescription, quickCargo.distribution]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!f.contractId) { setContractDgPolicy(null); return; }
    api.contracts.get(f.contractId)
      .then(c => setContractDgPolicy({ dgAllowed: c.dgAllowed, imdgClasses: c.imdgClasses || [] }))
      .catch(() => setContractDgPolicy(null));
  }, [f.contractId]); // eslint-disable-line react-hooks/exhaustive-deps

  const generateContainers = () => {
    const n = parseInt(quickCargo.count, 10);
    if (!n || n < 1 || n > 200) { toast.error("Enter a valid container count (1–200)"); return; }
    if (!quickCargo.size || !quickCargo.type) { toast.error("Select a container type before generating"); return; }
    if (quickCargo.isDg && contractDgPolicy) {
      if (!contractDgPolicy.dgAllowed) {
        toast.error("The selected contract does not permit DG cargo."); return;
      }
      if (contractDgPolicy.imdgClasses.length > 0 && quickCargo.dgClass && !contractDgPolicy.imdgClasses.includes(quickCargo.dgClass)) {
        toast.error(`IMDG class ${quickCargo.dgClass} is not permitted by the selected contract (allowed: ${contractDgPolicy.imdgClasses.join(", ")}).`); return;
      }
    }
    const totalWeight = parseFloat(quickCargo.weight) || 0;
    const totalVolume = parseFloat(quickCargo.volume) || 0;
    const perWeight = quickCargo.distribution === 'all'
      ? (totalWeight ? +((totalWeight / n).toFixed(2)) : null)
      : (totalWeight || null);
    const perVolume = quickCargo.distribution === 'all'
      ? (totalVolume ? +((totalVolume / n).toFixed(2)) : null)
      : (totalVolume || null);
    setDraftContainers(Array.from({ length: n }, () => ({
      size: quickCargo.size, type: quickCargo.type,
      grossWeightKg: perWeight, volumeCbm: perVolume,
      cargoDescription: quickCargo.cargoDescription,
      isDg: quickCargo.isDg, dgClass: quickCargo.isDg ? quickCargo.dgClass : '',
      containerNumber: '', sealNumber: '', hsCode: '',
    })));
  };

  const prevFRef = useRef(f);
  useEffect(() => {
    if (prevFRef.current === f) return; // same reference = no user change (survives Strict Mode double-invoke)
    prevFRef.current = f;
    onDirtyChange?.(true);
  }, [f]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstLeg    = legs[0] || null;
  const lastLeg     = legs[legs.length - 1] || null;
  const derivedPol  = firstLeg?.pol || "";
  const derivedPod  = lastLeg?.pod  || "";
  const derivedEtd  = firstLeg?.etd || "";
  const derivedEta  = lastLeg?.eta  || "";
  const transitDays = (() => {
    if (!derivedEtd || !derivedEta) return null;
    const d1 = new Date(derivedEtd), d2 = new Date(derivedEta);
    if (isNaN(d1) || isNaN(d2)) return null;
    return Math.round((d2 - d1) / 864e5);
  })();
  const tsps = legs.length > 1
    ? legs.slice(0, -1).map(l => ({ code: l.pod, name: l.podName })).filter(t => t.code)
    : [];

  const isCentral = f.contractType === "Central";
  const valid = f.incoterm !== ""
    && f.commodityCode.trim().length > 0
    && (!isCentral || f.contractId.trim().length > 0);

  const handleSave = () => {
    if (!valid) {
      setTouch({ incoterm: true, commodityCode: true });
      toast.error("Please fill in all required fields before saving.");
      return;
    }
    if (contractDgPolicy && draftContainers.some(c => c.isDg)) {
      const dgContainers = draftContainers.filter(c => c.isDg);
      if (!contractDgPolicy.dgAllowed) {
        toast.error("Cannot save: the selected contract does not permit DG cargo. Remove DG containers or change the contract.");
        return;
      }
      if (contractDgPolicy.imdgClasses.length > 0) {
        const blocked = dgContainers.find(c => c.dgClass && !contractDgPolicy.imdgClasses.includes(c.dgClass));
        if (blocked) {
          toast.error(`Cannot save: IMDG class ${blocked.dgClass} is not permitted by the selected contract (allowed: ${contractDgPolicy.imdgClasses.join(", ")}).`);
          return;
        }
      }
    }
    onDirtyChange?.(false);
    withSaving(() => onSave({
      ...f,
      pol: derivedPol,
      pod: derivedPod,
      etd: derivedEtd,
      eta: derivedEta,
    }, draftLegs || [], draftContainers));
  };

  const statusColor = { Active: T.success, Completed: T.info, Cancelled: T.danger, "On Hold": T.warning }[f.status] || T.textMuted;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Parties ───────────────────────────────────────────────────────────── */}
      <SectionDivider label="Parties" />
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
      <CustomerCombobox label="Notify Party"
        value={{ id: f.notifyId, name: f.notifyName }}
        onChange={v => setF(p => ({ ...p, notifyId: v.id, notifyName: v.name }))} />

      {/* ── Cargo ─────────────────────────────────────────────────────────────── */}
      <SectionDivider label="Cargo" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <Sel label="Incoterm" value={f.incoterm}
            onChange={v => {
              touch("incoterm");
              // C/D terms → seller pays → Shipper is principal; E/F terms → buyer arranges → Consignee is principal
              const sellerPays = new Set(['CPT','CIP','CFR','CIF','DAP','DPU','DDP']);
              setF(p => {
                const next = { ...p, incoterm: v };
                if (sellerPays.has(v) && p.shipperId) {
                  next.principalId = p.shipperId; next.principalName = p.shipperName;
                } else if (!sellerPays.has(v) && v && p.consigneeId) {
                  next.principalId = p.consigneeId; next.principalName = p.consigneeName;
                }
                return next;
              });
            }} required
            error={touched.incoterm && !f.incoterm}
            options={[
              { value: "", label: "Select incoterm…" },
              ...INCOTERMS_2020.map(t => ({ value: t.code, label: `${t.code} – ${t.name}` })),
            ]}
          />
          <FieldError show={touched.incoterm && !f.incoterm} msg="Incoterm is required" />
        </div>
        <Sel label="Freight Terms" value={f.freightTerms} onChange={set("freightTerms")}
          options={[
            { value: "Prepaid",                label: "Prepaid" },
            { value: "Collect",                label: "Collect" },
            { value: "Payable at Destination", label: "Payable at Destination" },
          ]}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Sel label="Movement Type" value={f.movementType} onChange={set("movementType")}
          options={[
            { value: "FCL", label: "FCL — Full Container Load" },
            { value: "LCL", label: "LCL — Less than Container Load" },
            { value: "BCO", label: "BCO — Beneficial Cargo Owner" },
          ]}
        />
        <Sel label="Service Type" value={f.serviceType} onChange={set("serviceType")}
          options={[
            { value: "Port-to-Port",     label: "Port-to-Port (P2P)" },
            { value: "Door-to-Port",     label: "Door-to-Port (D2P)" },
            { value: "Port-to-Door",     label: "Port-to-Door (P2D)" },
            { value: "Door-to-Door",     label: "Door-to-Door (D2D)" },
          ]}
        />
      </div>
      <div>
        <div style={errRing(touched.commodityCode && !f.commodityCode)}>
          <Field label={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              Commodity <CommodityHint />
            </span>
          } required>
            <CommodityCombobox value={f.commodityCode}
              onChange={v => { set("commodityCode")(v); touch("commodityCode"); }} />
          </Field>
        </div>
        <FieldError show={touched.commodityCode && !f.commodityCode} msg="Commodity is required" />
      </div>

      {/* ── Transport & References ─────────────────────────────────────────────── */}
      <SectionDivider label="Transport & References" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Place of Receipt" value={f.placeOfReceipt} onChange={set("placeOfReceipt")}
          placeholder="e.g. Inland depot, city" hint="Where cargo is received from shipper" />
        <Inp label="Place of Delivery" value={f.placeOfDelivery} onChange={set("placeOfDelivery")}
          placeholder="e.g. Inland destination, city" hint="Where cargo is delivered to consignee" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <DatePicker label="Cargo Ready Date" value={f.cargoReadyDate} onChange={set("cargoReadyDate")} />
        <Inp label="Booking Reference" value={f.bookingRef} onChange={set("bookingRef")} placeholder="BK-2025-00123" mono />
        {init.id
          ? <Inp label="B/L Number" value={f.blNumber} onChange={set("blNumber")} placeholder="MAEU123456789" mono />
          : <div />}
      </div>
      <LegsTable
        shipmentId={init.id}
        draftLegs={draftLegs}
        onDraftLegsChange={legs => { onDirtyChange?.(true); onDraftLegsChange?.(legs); }}
        onLegsChange={setLegs}
        inheritedCarrier={f.carrierCode}
        inheritedContractType={f.contractType}
        inheritedContractRef={f.contractRef}
        canEdit={canEdit}
      />

      {/* ── Route summary (derived from legs) ─────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr",
        background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
        {/* POL */}
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: "0.09em", color: T.textMuted }}>Port of Loading</span>
          <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700,
            color: derivedPol ? T.text : T.border }}>{derivedPol || "—"}</span>
          {firstLeg?.polName
            ? <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{firstLeg.polName}</span>
            : <span style={{ fontFamily: T.body, fontSize: 11, color: T.border, fontStyle: "italic" }}>Add a leg to set</span>}
        </div>

        {/* Centre: ETD → transit → ETA */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 6, padding: "12px 24px",
          borderLeft: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}`,
          background: T.surface }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
              <span style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
                letterSpacing: "0.09em", color: T.textMuted }}>ETD</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: derivedEtd ? T.text : T.border }}>
                {derivedEtd || "—"}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              {transitDays !== null
                ? <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.accent,
                    background: T.accentBg, border: `1px solid ${T.accent}33`,
                    borderRadius: 10, padding: "2px 10px", whiteSpace: "nowrap" }}>
                    {transitDays}d transit
                  </span>
                : <span style={{ color: T.border, fontSize: 16 }}>→</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
              <span style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
                letterSpacing: "0.09em", color: T.textMuted }}>ETA</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: derivedEta ? T.text : T.border }}>
                {derivedEta || "—"}</span>
            </div>
          </div>
          {tsps.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
              {tsps.map((tsp, i) => (
                <span key={`${tsp.code}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {i > 0 && <span style={{ color: T.textMuted, fontSize: 10 }}>›</span>}
                  <span title={tsp.name || tsp.code}
                    style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text,
                      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4,
                      padding: "1px 7px" }}>
                    {tsp.code}
                  </span>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {(() => {
              const code = firstLeg?.carrierCode || f.carrierCode;
              return (
                <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                  color: code ? T.accent : T.border }}>
                  {code || "—"}
                </span>
              );
            })()}
            {legs.length > 1 && (
              <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>
                · {legs.length} legs
              </span>
            )}
          </div>
        </div>

        {/* POD */}
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 3, textAlign: "right" }}>
          <span style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: "0.09em", color: T.textMuted }}>Port of Discharge</span>
          <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700,
            color: derivedPod ? T.text : T.border }}>{derivedPod || "—"}</span>
          {lastLeg?.podName
            ? <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{lastLeg.podName}</span>
            : <span style={{ fontFamily: T.body, fontSize: 11, color: T.border, fontStyle: "italic" }}>Add a leg to set</span>}
        </div>
      </div>

      {/* ── Containers (new shipment only) ────────────────────────────────────── */}
      {!init.id && (
        <>
          <SectionDivider label="Containers" />

          {/* Row 1: count · type · weight · volume · distribution */}
          <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 140px 130px 190px", gap: 12, alignItems: "end" }}>
            <Inp label="Count" value={quickCargo.count}
              onChange={v => setQuickCargo(q => ({ ...q, count: v.replace(/\D/g, '') }))}
              placeholder="1" mono />
            <div>
              <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 5 }}>
                Container Type
              </div>
              <ContainerTypeField
                size={quickCargo.size} type={quickCargo.type}
                onChange={opt => setQuickCargo(q => ({ ...q, size: opt?.size || '20', type: opt?.type || 'DC' }))} />
            </div>
            <Inp label="Weight (kg)" value={quickCargo.weight}
              onChange={v => setQuickCargo(q => ({ ...q, weight: v }))}
              placeholder="e.g. 18000" mono />
            <Inp label="Volume (CBM)" value={quickCargo.volume}
              onChange={v => setQuickCargo(q => ({ ...q, volume: v }))}
              placeholder="e.g. 28" mono />
            <div>
              <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 5 }}>
                Distribution
              </div>
              <select value={quickCargo.distribution}
                onChange={e => setQuickCargo(q => ({ ...q, distribution: e.target.value }))}
                style={{ ...inputBase, fontFamily: T.body, fontSize: 13, cursor: "pointer" }}>
                <option value="all">Total — divide by N</option>
                <option value="per">Per container — copy to each</option>
              </select>
            </div>
          </div>

          {/* Row 2: cargo description + DG on the same line */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <Inp label="Cargo Description"
                value={quickCargo.cargoDescription}
                onChange={v => setQuickCargo(q => ({ ...q, cargoDescription: v }))}
                placeholder="e.g. Electronics components in cartons" />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 9, flexShrink: 0 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                fontFamily: T.body, fontSize: 13, color: T.text, userSelect: "none", whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={quickCargo.isDg}
                  onChange={e => setQuickCargo(q => ({ ...q, isDg: e.target.checked, dgClass: '' }))} />
                DG Cargo
              </label>
              {quickCargo.isDg && (
                <>
                  <select value={quickCargo.dgClass}
                    onChange={e => setQuickCargo(q => ({ ...q, dgClass: e.target.value }))}
                    style={{ ...inputBase, width: 220, fontFamily: T.body, fontSize: 13, cursor: "pointer" }}>
                    <option value="">Select IMDG class…</option>
                    {IMDG_CLASSES.map(c => <option key={c.code} value={c.code}>{c.label} — {c.name}</option>)}
                  </select>
                  {(() => {
                    if (!contractDgPolicy) return null;
                    if (!contractDgPolicy.dgAllowed)
                      return <span style={{ fontFamily: T.body, fontSize: 11, color: T.danger, whiteSpace: "nowrap" }}>Contract blocks DG</span>;
                    if (contractDgPolicy.imdgClasses.length > 0 && quickCargo.dgClass && !contractDgPolicy.imdgClasses.includes(quickCargo.dgClass))
                      return <span style={{ fontFamily: T.body, fontSize: 11, color: T.danger, whiteSpace: "nowrap" }}>Class not permitted</span>;
                    if (contractDgPolicy.dgAllowed)
                      return <span style={{ fontFamily: T.body, fontSize: 11, color: T.success, whiteSpace: "nowrap" }}>✓ Permitted</span>;
                    return null;
                  })()}
                </>
              )}
            </div>
          </div>

          {/* Row 4: generate button + summary */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <Btn variant="secondary" onClick={generateContainers}>
              Generate {quickCargo.count ? `${quickCargo.count} Container${+quickCargo.count !== 1 ? 's' : ''}` : 'Containers'}
            </Btn>
            {draftContainers.length > 0 && (
              <>
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.success }}>
                  ✓ {draftContainers.length} container{draftContainers.length !== 1 ? 's' : ''} queued
                </span>
                <button onClick={() => setDraftContainers([])}
                  style={{ background: "none", border: "none", cursor: "pointer",
                    fontFamily: T.body, fontSize: 11, color: T.textMuted, padding: 0 }}>
                  ✕ Clear
                </button>
              </>
            )}
          </div>

          {/* Preview chips */}
          {draftContainers.length > 0 && (() => {
            const c0 = draftContainers[0];
            const typeLabel = `${c0.size}${c0.type}`;
            const wt = c0.grossWeightKg != null ? `${c0.grossWeightKg.toLocaleString()} kg` : null;
            const vol = c0.volumeCbm != null ? `${c0.volumeCbm} CBM` : null;
            const dg = c0.isDg ? (c0.dgClass ? `DG ${c0.dgClass}` : 'DG') : null;
            const parts = [typeLabel, wt, vol, dg].filter(Boolean);
            return (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {draftContainers.map((_, i) => (
                  <span key={i} style={{
                    fontFamily: T.mono, fontSize: 11, fontWeight: 600,
                    background: T.accentBg, color: T.accent,
                    border: `1px solid ${T.accent}44`, borderRadius: 6,
                    padding: "2px 8px", whiteSpace: "nowrap",
                  }}>
                    #{i + 1} · {parts.join(' · ')}
                  </span>
                ))}
              </div>
            );
          })()}
        </>
      )}

      {/* ── Contract ──────────────────────────────────────────────────────────── */}
      <SectionDivider label="Contract" />
      <ContractTypeInput value={f.contractType} onChange={v => {
        if (v !== "Central") {
          setF(p => ({ ...p, contractType: v, contractId: "", contractRef: "", allocationId: "" }));
        } else if (!init.id && draftContainers.length === 0) {
          toast.warning("Add containers first — Central Contract eligibility is verified against your cargo details.");
        } else {
          set("contractType")(v);
        }
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
                allocationId:       allocationId       !== undefined ? allocationId       : p.allocationId,
                spaceSkipReason:    spaceSkipReason    !== undefined ? spaceSkipReason    : p.spaceSkipReason,
                spaceOverageReason: spaceOverageReason !== undefined ? spaceOverageReason : p.spaceOverageReason,
              };
              if (carrierCode && carrierCode !== p.carrierCode) { setCarrierUpdated(carrierCode); next.carrierCode = carrierCode; }
              else if (!id) { setCarrierUpdated(""); }
              return next;
            });
            if (carrierCode) onDraftLegsChange(draftLegs.map(leg => ({ ...leg, carrierCode })));
          }}
          pol={derivedPol}
          pod={derivedPod}
          etd={derivedEtd}
          contractType={f.contractType}
        />
      )}
      {isCentral && carrierUpdated && (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.info,
          background: T.info + "18", border: `1px solid ${T.info}44`, borderRadius: 6, padding: "6px 10px" }}>
          Carrier updated to <strong style={{ fontFamily: T.mono }}>{carrierUpdated}</strong> to match the selected contract.
        </div>
      )}
      {!isCentral && (
        <Inp label="Contract Reference" value={f.contractRef}
          onChange={v => setF(p => ({ ...p, contractRef: v }))}
          placeholder="e.g. SPOT-2025-001" mono hint="Free-text reference for this contract arrangement" />
      )}
      <Textarea label="Contract Notes" value={f.contractNotes} onChange={set("contractNotes")}
        placeholder="Optional reference, contract IDs, remarks…" rows={2} />

      {/* ── Status ────────────────────────────────────────────────────────────── */}
      <SectionDivider label="Status" />
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor,
          flexShrink: 0, boxShadow: `0 0 6px ${statusColor}88` }} />
        <div style={{ flex: 1 }}>
          <Sel label="" value={f.status} onChange={set("status")}
            options={STATUSES.map(s => ({ value: s, label: s }))} />
        </div>
      </div>

      {/* ── Actions ───────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 8,
        borderTop: `1px solid ${T.border}`, marginTop: 8 }}>
        <Btn variant="secondary" onClick={onBack}>Cancel</Btn>
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

// ─── ShipmentFormPage ─────────────────────────────────────────────────────────

const BLANK_LEG = () => ({
  id: `draft_${Date.now()}`,
  mot: "SEA", pol: "", polName: "", pod: "", podName: "",
  etd: null, eta: null, carrierCode: "",
  vessel: "", vesselImo: "", voyage: "",
  contractType: "SPOT", contractRef: "",
});

const ShipmentFormPage = ({ mode, init = {}, onSave, onBack, onDirtyChange }) => {
  const [draftLegs, setDraftLegs] = useState(() => mode === "new" ? [BLANK_LEG()] : []);

  const isEdit = mode === "edit" && !!init.id;
  const title  = isEdit ? `Edit — ${init.id}` : "New Shipment";

  return (
    <div style={{ maxWidth: 1600, margin: "0 auto" }}>
      {/* Page header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 24, fontWeight: 800, color: T.text, margin: 0 }}>
          {title}
        </h1>
        {isEdit && (
          <p style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted, margin: "4px 0 0" }}>
            {init.pol} → {init.pod}{init.carrierCode ? ` · ${init.carrierCode}` : ""}
          </p>
        )}
      </div>

      {/* Form card */}
      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`,
        padding: "28px 28px" }}>
        <ShipmentForm
          init={init}
          onSave={onSave}
          onBack={onBack}
          onDirtyChange={onDirtyChange}
          draftLegs={draftLegs}
          onDraftLegsChange={setDraftLegs}
        />
      </div>
    </div>
  );
};

export default ShipmentFormPage;
