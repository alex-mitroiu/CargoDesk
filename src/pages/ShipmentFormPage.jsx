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
import SailingPickerModal from "../components/shared/SailingPickerModal";
import { IconClose, IconWarning, IconPackage, IconPencil, IconCheck, IconRefresh, IconLock, IconAnchor } from "../components/primitives/Icon";

// ─── Draft Container Manager ──────────────────────────────────────────────────

const BLANK_DRAFT_CTR = () => ({
  _key: Date.now() + Math.random(),
  size: '', type: '',
  grossWeightKg: null, volumeCbm: null,
  hsCode: '', cargoDescription: '',
  isDg: false, dgClass: '',
  containerNumber: '', sealNumber: '',
});

const DraftCtrRow = ({ idx, ctr, onChange, onRemove }) => (
  <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
      <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.textMuted }}>Container #{idx + 1}</span>
      <button type="button" onClick={onRemove}
        style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 14, padding: "0 2px", lineHeight: 1,
          display: "inline-flex", alignItems: "center" }}><IconClose size={12} /></button>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "163px 1fr 1fr 1fr", gap: 10, marginBottom: 8 }}>
      <div>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 5 }}>Container Type</div>
        <ContainerTypeField size={ctr.size} type={ctr.type} label={null}
          onChange={opt => { onChange('size', opt?.size || ''); onChange('type', opt?.type || ''); }} />
      </div>
      <Inp label="Weight (kg)" value={ctr.grossWeightKg != null ? String(ctr.grossWeightKg) : ''} mono
        onChange={v => onChange('grossWeightKg', v === '' ? null : parseFloat(v) || null)} placeholder="18000" />
      <Inp label="Volume (CBM)" value={ctr.volumeCbm != null ? String(ctr.volumeCbm) : ''} mono
        onChange={v => onChange('volumeCbm', v === '' ? null : parseFloat(v) || null)} placeholder="28" />
      <Inp label="HS Code" value={ctr.hsCode} mono
        onChange={v => onChange('hsCode', v)} placeholder="e.g. 8471.30" />
    </div>
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <div style={{ flex: 1 }}>
        <Inp label="Cargo Description" value={ctr.cargoDescription}
          onChange={v => onChange('cargoDescription', v)} placeholder="e.g. Electronics components" />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 20 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
          fontFamily: T.body, fontSize: 13, color: T.text, userSelect: "none", whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={ctr.isDg}
            onChange={e => { onChange('isDg', e.target.checked); if (!e.target.checked) onChange('dgClass', ''); }}
            style={{ accentColor: T.accent }} />
          DG Cargo
        </label>
        {ctr.isDg && (
          <select value={ctr.dgClass}
            onChange={e => onChange('dgClass', e.target.value)}
            style={{ ...inputBase, fontFamily: T.body, fontSize: 13, cursor: "pointer" }}>
            <option value="">Select class…</option>
            {IMDG_CLASSES.map(c => <option key={c.code} value={c.code}>{c.label} — {c.name}</option>)}
          </select>
        )}
      </div>
    </div>
  </div>
);

const DraftContainerManagerModal = ({ containers, onSave, onClose }) => {
  const [items, setItems] = useState(() =>
    containers.length > 0
      ? containers.map(c => ({ ...c, _key: Math.random() }))
      : [BLANK_DRAFT_CTR()]
  );
  const add    = () => setItems(p => [...p, BLANK_DRAFT_CTR()]);
  const remove = key => setItems(p => p.filter(c => c._key !== key));
  const update = (key, field, value) =>
    setItems(p => p.map(c => c._key === key ? { ...c, [field]: value } : c));

  return (
    <Modal title="Manage Containers" onClose={onClose} width={700}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((ctr, idx) => (
          <DraftCtrRow key={ctr._key} idx={idx} ctr={ctr}
            onChange={(f, v) => update(ctr._key, f, v)}
            onRemove={() => remove(ctr._key)} />
        ))}
        <div>
          <Btn variant="secondary" onClick={add}>+ Add Container</Btn>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8,
          borderTop: `1px solid ${T.border}`, paddingTop: 12, marginTop: 4 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={() => onSave(items.map(({ _key, ...rest }) => rest))}>Done</Btn>
        </div>
      </div>
    </Modal>
  );
};

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

export const ContractPickerModal = ({ pol, pod, matches, allocs, shipmentTEU = 0, onSelectContract, onSelectAllocation, onClose, onBack }) => {
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
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.warning, fontWeight: 600,
              display: "flex", alignItems: "center", gap: 5 }}>
              <IconWarning size={12} />Shipment is {shipmentTEU} TEU — only {alloc.remainingTEU} TEU remaining
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
        {onBack && (
          <button type="button" onClick={onBack}
            style={{ alignSelf: "flex-start", background: T.bg, border: `1px solid ${T.border}`,
              borderRadius: 7, cursor: "pointer", color: T.text, fontFamily: T.body, fontSize: 12,
              fontWeight: 600, padding: "6px 12px", marginBottom: 2 }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.text; }}>
            ← Change contract type (SPOT / Pending / Customer Own)
          </button>
        )}
        {isLoading && <div style={{ padding: 40, display: "flex", justifyContent: "center" }}><Spinner /></div>}
        {!isLoading && (
          <>
            {hasAllocs && (
              <>
                <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text,
                  display: "flex", alignItems: "center", gap: 5 }}><IconPackage size={13} />Space Configurations</div>
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
                    <IconCheck size={13} color={T.success} />
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

// Derives contract-matching haulage facts straight from a shipment's own legs — a Pick-up
// leg that's Carrier's Haulage means the contract needs to cover POL haulage, a Delivery leg
// that's Carrier's Haulage means it needs POD haulage. Shared so every call site (shipment
// form, Schedules page, header mismatch badge) agrees on what "needs haulage" means, instead
// of each recomputing it — or worse, passing shipment.routingTerm (the door-to-door bookend
// term) straight through unexamined.
export const deriveHaulageNeeds = (legs) => {
  const pkuLeg = legs[0]?.legType === "Pick-up" && legs[0]?.movementType === "Carrier's Haulage" ? legs[0] : null;
  const delLeg = legs[legs.length - 1]?.legType === "Delivery" && legs[legs.length - 1]?.movementType === "Carrier's Haulage" ? legs[legs.length - 1] : null;
  return {
    needsPolHaulage: !!pkuLeg,
    needsPodHaulage: !!delLeg,
    pkuLocation: pkuLeg?.pol || "",
    delLocation: delLeg?.pod || "",
  };
};

export const ContractField = ({ value, onChange, pol, pod, etd, crd, needsPolHaulage, needsPodHaulage, pkuLocation, delLocation, contractType, carrierCode }) => {
  const isCentral = contractType === "Central";
  const [matches,    setMatches]    = useState(null);
  const [allocs,     setAllocs]     = useState(null);
  const [matching,   setMatching]   = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const matchTimer   = useRef(null);
  const autoSelected = useRef(false);

  const dateRef = crd || etd;

  useEffect(() => {
    clearTimeout(matchTimer.current);
    if (!isCentral) { setMatches(null); setAllocs(null); autoSelected.current = false; return; }
    if (!pol || !pod) { setMatches(null); setAllocs(null); return; }
    setMatching(true);
    matchTimer.current = setTimeout(async () => {
      try {
        // needsPolHaulage/needsPodHaulage are booleans the caller already knows (derived from
        // the shipment's own Pick-up/Delivery legs), not a routingTerm string to re-parse — a
        // contract and its own space-config allocations are judged by the identical rule.
        const haulageParams = { ...(needsPolHaulage && { needsPolHaulage: "1" }),
          ...(needsPodHaulage && { needsPodHaulage: "1" }),
          ...(pkuLocation && { pkuLocation }),
          ...(delLocation && { delLocation }) };
        const matchParams = { pol, pod, ...(dateRef && { crd: dateRef }), ...haulageParams };
        const [contractRes, allocRes] = await Promise.all([
          api.contracts.match(matchParams),
          api.allocations.match({ pol, pod, etd, ...haulageParams }),
        ]);
        const filteredContracts = carrierCode ? contractRes.filter(c => c.carrierCode === carrierCode) : contractRes;
        const filteredAllocs    = carrierCode ? allocRes.filter(a => a.carrierCode === carrierCode)    : allocRes;
        setMatches(filteredContracts);
        setAllocs(filteredAllocs);
        if (filteredAllocs.length === 0 && filteredContracts.length === 1 && !value.id && !autoSelected.current) {
          autoSelected.current = true;
          onChange({ id: filteredContracts[0].id, ref: filteredContracts[0].contractNumber, carrierCode: filteredContracts[0].carrierCode, allocationId: "", spaceSkipReason: "", spaceOverageReason: "" });
        }
      } catch {
        setMatches([]); setAllocs([]);
      } finally { setMatching(false); }
    }, 400);
  }, [isCentral, pol, pod, dateRef, needsPolHaulage, needsPodHaulage, pkuLocation, delLocation, carrierCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearContract = () => { onChange({ id: "", ref: "", carrierCode: null, allocationId: "", spaceSkipReason: "", spaceOverageReason: "" }); autoSelected.current = false; };
  const pickContract  = (c, skipReason = "") => { onChange({ id: c.id, ref: c.contractNumber, carrierCode: c.carrierCode, allocationId: "", spaceSkipReason: skipReason, spaceOverageReason: "" }); setPickerOpen(false); };
  const pickAllocation = (alloc, overageReason = "") => { onChange({ id: alloc.contractId, ref: alloc.contractNumber, carrierCode: alloc.carrierCode, allocationId: alloc.id, spaceSkipReason: "", spaceOverageReason: overageReason }); setPickerOpen(false); };

  if (!isCentral) return null;

  const hasAllocs = allocs && allocs.length > 0;
  const missing   = !pol ? "POL" : !pod ? "POD" : null;
  const browseDisabled = !!missing || (!hasAllocs && matches !== null && matches.length === 0);
  const browseLabel = missing
    ? `Set ${missing} first to search for contracts`
    : matching ? "Searching…"
    : matches === null ? "Browse matching contracts…"
    : hasAllocs ? `${allocs.length} space config${allocs.length !== 1 ? "s" : ""} + ${matches.length} contract${matches.length !== 1 ? "s" : ""} — click to review`
    : matches.length === 0 ? "No contracts found for this route"
    : `${matches.length} contract${matches.length !== 1 ? "s" : ""} found — click to select`;

  return (
    <Field label="Contract Ref" required={isCentral}>
      {value.id ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
          background: T.bg, border: `1px solid ${T.accent}55`, borderRadius: 6 }}>
          <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700, flex: 1 }}>{value.ref}</span>
          {value.allocationId && (
            <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, background: T.success + "22", color: T.success,
              border: `1px solid ${T.success}44`, borderRadius: 4, padding: "2px 8px",
              display: "inline-flex", alignItems: "center", gap: 3 }}><IconPackage size={10} />Space config</span>
          )}
          <button type="button" onClick={() => setPickerOpen(true)}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4, cursor: "pointer",
              color: T.text, fontFamily: T.body, fontSize: 11, padding: "2px 8px" }}>Change</button>
          <button type="button" onClick={clearContract}
            style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 13, padding: "0 2px", lineHeight: 1,
              display: "inline-flex", alignItems: "center" }}><IconClose size={11} /></button>
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

const LEG_TYPE_OPTIONS      = ["Pick-up", "SEA", "Delivery"];
const MOVEMENT_TYPE_OPTIONS = ["Carrier's Haulage", "Merchant's Haulage", "Customer Arranged"];
const LOC_TYPE_OPTIONS      = ["Door", "Terminal", "Container Yard", "CFS"];
// Pick-up/Delivery-only (SEA legs always show "—" here) — inland/short-haul movement modes.
// "Air" removed: a loaded FCL container can't realistically move by air for a door leg.
const MOVEMENT_BY_OPTIONS   = ["", "Barge", "Rail", "Truck", "Vessel"];
const LEG_TYPE_COLOR        = { "Pick-up": T.accent, "SEA": T.info, "Delivery": T.textMuted };
const LEG_LOC_ABBR_C        = { "Door": "DR", "Terminal": "PT", "Container Yard": "CY", "CFS": "CFS" };
const LEG_TYPE_DEFAULT_MT   = { "Pick-up": "Carrier's Haulage", "SEA": "SEA", "Delivery": "Carrier's Haulage" };

// Widths sized to fit the longest actual option text plus the native <select> arrow
// (e.g. movementType must fit "Merchant's Haulage", polLocType/podLocType must fit
// "Container Yard") — too narrow and the browser clips the text against its own arrow.
const LEG_COLS = [
  { key: "legType",      label: "Leg Type",      w: 96  },
  { key: "movementType", label: "Movement Type", w: 168 },
  { key: "pol",          label: "From",          w: 185 },
  { key: "polLocType",   label: "Loc. Type",     w: 116 },
  { key: "etd",          label: "Date",          w: 108 },
  { key: "pod",          label: "To",            w: 185 },
  { key: "podLocType",   label: "Loc. Type",     w: 116 },
  { key: "eta",          label: "Date",          w: 108 },
  { key: "carrierCode",  label: "Carrier",       w: 100 },
  { key: "movementBy",   label: "Movement by",   w: 90  },
  { key: "vessel",       label: "Vessel",        w: 100 },
  { key: "voyage",       label: "Voyage",        w: 72  },
  { key: "contractType", label: "Ctr. Type",     w: 72  },
  { key: "contractRef",  label: "Contract No.",  w: 88  },
];

const cellInput = {
  background: "transparent", border: "none", outline: "none",
  fontFamily: T.mono, fontSize: 12, color: T.text, width: "100%",
  padding: 0,
};

const LegRow = ({ leg, onSave, canEdit, widths, inheritedContractType, inheritedContractRef, showContractCols = true, locked = false, onUpdateSchedule = null }) => {
  const [d, setD] = useState(leg);
  useEffect(() => setD(leg), [leg]);
  const set   = k => v => setD(p => ({ ...p, [k]: v }));
  const flush = () => onSave(d);

  const [suggEta, setSuggEta] = useState(null);
  const suggRef = useRef(null);
  useEffect(() => {
    const isSeaLeg = (d.legType || "SEA") === "SEA";
    if (!isSeaLeg || !d.etd || !d.pol || !d.pod) { setSuggEta(null); return; }
    clearTimeout(suggRef.current);
    suggRef.current = setTimeout(async () => {
      try {
        const r = await api.tradeLanes.transitSuggestion(d.pol, d.pod);
        if (!r.days) { setSuggEta(null); return; }
        const base = new Date(d.etd + "T00:00:00Z");
        base.setUTCDate(base.getUTCDate() + r.days);
        const date = base.toISOString().slice(0, 10);
        // Only show if different from current ETA (either unset or would change)
        if (d.eta && d.eta === date) { setSuggEta(null); return; }
        setSuggEta({ date, days: r.days, lane: r.lane, isRecalc: !!d.eta });
      } catch { setSuggEta(null); }
    }, 400);
    return () => clearTimeout(suggRef.current);
  }, [d.etd, d.pol, d.pod, d.legType, d.eta]);

  const MONO_KEYS = new Set(["pol", "pod", "voyage", "carrierCode"]);

  const visibleCols = showContractCols ? LEG_COLS : LEG_COLS.slice(0, -2);

  if (!canEdit || locked) {
    return (
      <div style={{ display: "flex", borderBottom: `1px solid ${T.border}` }}
        title={locked && canEdit ? "Locked — linked to an assigned schedule. Remove this leg to unlink and edit again." : undefined}>
        {locked && canEdit && (
          <div style={{ width: onUpdateSchedule && d.legType === "SEA" ? 40 : 18, minWidth: onUpdateSchedule && d.legType === "SEA" ? 40 : 18,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
            borderRight: `1px solid ${T.border}22`, color: T.textMuted, fontSize: 11 }}>
            <IconLock size={11} />
            {onUpdateSchedule && d.legType === "SEA" && (
              <button type="button" onClick={e => { e.stopPropagation(); onUpdateSchedule(d); }}
                title="Update schedule — correct vessel/voyage/dates without unlinking"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                  fontSize: 12, lineHeight: 1, color: T.accent,
                  display: "inline-flex", alignItems: "center" }}><IconPencil size={11} /></button>
            )}
          </div>
        )}
        {visibleCols.map((c, i) => {
          const isPort = c.key === "pol" || c.key === "pod";
          const nameKey = c.key === "pol" ? "polName" : c.key === "pod" ? "podName" : null;
          const value = c.key === "contractType" ? (inheritedContractType || "—")
            : c.key === "contractRef" ? (inheritedContractRef || "—")
            : c.key === "carrierCode" && (d.legType === "Pick-up" || d.legType === "Delivery") ? "—"
            : (d[c.key] || "—");
          return (
            <div key={c.key} id={`leg-${d.id}-${c.key}`} style={{ width: widths[i], minWidth: widths[i], padding: "8px 8px 8px 10px",
              display: "flex", alignItems: "center", borderRight: `1px solid ${T.border}22` }}>
              {/* Ports get the same bordered chip weight as the editable PortCombobox, so a
                  locked row doesn't look visually "cheaper" than an editable one beside it. */}
              {isPort && d[c.key] ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", boxSizing: "border-box",
                  border: `1px solid ${T.border}`, borderRadius: 6, padding: "5px 9px", overflow: "hidden" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text, flexShrink: 0 }}>
                    {value}
                  </span>
                  {nameKey && d[nameKey] && (
                    <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {d[nameKey]}
                    </span>
                  )}
                </div>
              ) : (
                <span style={{ fontFamily: MONO_KEYS.has(c.key) ? T.mono : T.body, fontSize: 12,
                  color: c.key === "legType" ? (LEG_TYPE_COLOR[d[c.key]] || T.textMuted) : T.text,
                  fontWeight: c.key === "legType" ? 700 : 400,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {value}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", borderBottom: `1px solid ${T.border}` }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) flush(); }}>

      {/* Leg Type */}
      <div id={`leg-${d.id}-legType`} style={{ width: widths[0], minWidth: widths[0], padding: "0 0 0 10px",
        display: "flex", alignItems: "center", borderRight: `1px solid ${T.border}33` }}>
        <select value={d.legType || "SEA"} onChange={e => {
          const lt = e.target.value;
          const newD = { ...d, legType: lt, movementType: LEG_TYPE_DEFAULT_MT[lt] || d.movementType };
          setD(newD); onSave(newD);
        }} style={{ ...cellInput, cursor: "pointer", color: LEG_TYPE_COLOR[d.legType] || T.textMuted, fontWeight: 700 }}>
          {LEG_TYPE_OPTIONS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {/* Movement Type */}
      <div id={`leg-${d.id}-movementType`} style={{ width: widths[1], minWidth: widths[1], padding: "0 0 0 10px",
        display: "flex", alignItems: "center", borderRight: `1px solid ${T.border}33` }}>
        {(d.legType || "SEA") === "SEA"
          ? <span style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>—</span>
          : <select value={d.movementType || "Carrier's Haulage"} onChange={e => set("movementType")(e.target.value)} onBlur={flush}
              style={{ ...cellInput, cursor: "pointer" }}>
              {MOVEMENT_TYPE_OPTIONS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
        }
      </div>

      {/* From (POL) */}
      <div id={`leg-${d.id}-pol`} style={{ width: widths[2], minWidth: widths[2], borderRight: `1px solid ${T.border}33`, overflow: "visible" }}>
        <PortCombobox
          value={d.pol ? { unlocode: d.pol, name: d.polName || "" } : null}
          onChange={v => {
            const newD = { ...d, pol: v?.unlocode || "", polName: v?.name || "" };
            setD(newD); if (v?.unlocode) onSave(newD);
          }}
          placeholder="Search From…"
        />
      </div>

      {/* Loc. Type (From) */}
      <div id={`leg-${d.id}-polLocType`} style={{ width: widths[3], minWidth: widths[3], padding: "0 0 0 10px",
        display: "flex", alignItems: "center", borderRight: `1px solid ${T.border}33` }}>
        <select value={d.polLocType || "Terminal"} onChange={e => set("polLocType")(e.target.value)} onBlur={flush}
          style={{ ...cellInput, cursor: "pointer" }}>
          {LOC_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {/* Date (ETD) */}
      <div id={`leg-${d.id}-etd`} style={{ width: widths[4], minWidth: widths[4], padding: "0 0 0 10px",
        display: "flex", alignItems: "center", borderRight: `1px solid ${T.border}33` }}>
        <input type="date" value={d.etd || ""} max={d.eta || undefined}
          onChange={e => set("etd")(e.target.value || null)}
          onBlur={flush} style={cellInput} />
      </div>

      {/* To (POD) */}
      <div id={`leg-${d.id}-pod`} style={{ width: widths[5], minWidth: widths[5], borderRight: `1px solid ${T.border}33`, overflow: "visible" }}>
        <PortCombobox
          value={d.pod ? { unlocode: d.pod, name: d.podName || "" } : null}
          onChange={v => {
            const newD = { ...d, pod: v?.unlocode || "", podName: v?.name || "" };
            setD(newD); if (v?.unlocode) onSave(newD);
          }}
          placeholder="Search To…"
        />
      </div>

      {/* Loc. Type (To) */}
      <div id={`leg-${d.id}-podLocType`} style={{ width: widths[6], minWidth: widths[6], padding: "0 0 0 10px",
        display: "flex", alignItems: "center", borderRight: `1px solid ${T.border}33` }}>
        <select value={d.podLocType || "Terminal"} onChange={e => set("podLocType")(e.target.value)} onBlur={flush}
          style={{ ...cellInput, cursor: "pointer" }}>
          {LOC_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {/* Date (ETA) */}
      <div id={`leg-${d.id}-eta`} style={{ width: widths[7], minWidth: widths[7], padding: "0 0 0 10px", borderRight: `1px solid ${T.border}33`,
        display: "flex", flexDirection: "column", justifyContent: "center", gap: 3 }}>
        <input type="date" value={d.eta || ""} min={d.etd || undefined}
          onChange={e => set("eta")(e.target.value || null)}
          onBlur={flush} style={cellInput} />
        {suggEta && (
          <button type="button" title={`Based on ${suggEta.lane} average transit (${suggEta.days}d)`}
            onClick={() => { const next = { ...d, eta: suggEta.date }; setD(next); onSave(next); setSuggEta(null); }}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
              fontFamily: T.mono, fontSize: 10,
              color: suggEta.isRecalc ? T.warning : T.accent,
              textAlign: "left",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {suggEta.isRecalc ? <><IconRefresh size={9} style={{ marginRight: 2 }} />recalc:</> : "→"} {suggEta.date} ({suggEta.days}d)
          </button>
        )}
      </div>

      {/* Carrier — only relevant for SEA legs */}
      <div id={`leg-${d.id}-carrierCode`} style={{ width: widths[8], minWidth: widths[8], borderRight: `1px solid ${T.border}33`, overflow: "visible",
        display: "flex", alignItems: "center" }}>
        {d.legType === "Pick-up" || d.legType === "Delivery"
          ? <span style={{ display: "block", padding: "0 8px 0 10px", fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>—</span>
          : <CarrierCombobox
              value={d.carrierCode || ""}
              onChange={v => { const newD = { ...d, carrierCode: v }; setD(newD); onSave(newD); }}
            />
        }
      </div>

      {/* Movement by */}
      <div id={`leg-${d.id}-movementBy`} style={{ width: widths[9], minWidth: widths[9], padding: "0 0 0 10px",
        display: "flex", alignItems: "center", borderRight: `1px solid ${T.border}33` }}>
        {(d.legType || "SEA") === "SEA"
          ? <span style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>—</span>
          : <select value={d.movementBy || ""} onChange={e => set("movementBy")(e.target.value)} onBlur={flush}
              style={{ ...cellInput, cursor: "pointer" }}>
              {MOVEMENT_BY_OPTIONS.map(b => <option key={b} value={b}>{b || "—"}</option>)}
            </select>
        }
      </div>

      {/* Vessel */}
      {(() => {
        const vesselDisabled = (d.legType === "Pick-up" || d.legType === "Delivery") && d.movementBy !== "Barge";
        return (
          <div id={`leg-${d.id}-vessel`} style={{ width: widths[10], minWidth: widths[10], padding: "0 0 0 10px",
            display: "flex", alignItems: "center", borderRight: `1px solid ${T.border}33` }}>
            {vesselDisabled
              ? <span style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>—</span>
              : <input value={d.vessel} onChange={e => set("vessel")(e.target.value)}
                  onBlur={flush} placeholder="Name…" style={{ ...cellInput, fontFamily: T.body }} />}
          </div>
        );
      })()}

      {/* Voyage */}
      {(() => {
        const voyageDisabled = (d.legType === "Pick-up" || d.legType === "Delivery") && d.movementBy !== "Barge";
        return (
          <div id={`leg-${d.id}-voyage`} style={{ width: widths[11], minWidth: widths[11], padding: "0 0 0 10px",
            display: "flex", alignItems: "center", borderRight: `1px solid ${T.border}33` }}>
            {voyageDisabled
              ? <span style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>—</span>
              : <input value={d.voyage} onChange={e => set("voyage")(e.target.value)}
                  onBlur={flush} placeholder="423E" style={cellInput} />}
          </div>
        );
      })()}

      {showContractCols && (
        <>
          {/* Contract Type — read-only, inherited */}
          <div id={`leg-${d.id}-contractType`} style={{ width: widths[12], minWidth: widths[12], padding: "0 0 0 10px",
            display: "flex", alignItems: "center", borderRight: `1px solid ${T.border}33`,
            fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            {inheritedContractType || "—"}
          </div>

          {/* Contract No. — read-only, inherited */}
          <div id={`leg-${d.id}-contractRef`} style={{ width: widths[13], minWidth: widths[13], padding: "0 0 0 10px",
            display: "flex", alignItems: "center", borderRight: `1px solid ${T.border}33`,
            fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
            {inheritedContractRef || "—"}
          </div>
        </>
      )}

    </div>
  );
};

// Journey order is Pick-up leg(s) → SEA/other leg(s) → Delivery leg(s) — several places
// already assume this (e.g. ShipmentForm's pkuLeg/delLeg derivation reads legs[0]/legs[-1]
// directly). Array.prototype.sort is stable, so this only moves Pick-up/Delivery legs to
// their group's edge and leaves every other relative ordering untouched.
const LEG_TYPE_RANK = { "Pick-up": 0, "Delivery": 2 };
const orderLegs = legsArr => [...legsArr].sort((a, b) =>
  (LEG_TYPE_RANK[a.legType] ?? 1) - (LEG_TYPE_RANK[b.legType] ?? 1));

export const LegsTable = ({ shipmentId, draftLegs, onDraftLegsChange, onLegsChange, inheritedCarrier, inheritedContractType, inheritedContractRef, canEdit, showContractCols = true, extraAction = null, lockedSeaLegs = false, onUpdateSchedule = null }) => {
  const [legs,          setLegs]          = useState([]);
  const [saving,        setSaving]        = useState(null);
  const [selectedLegId, setSelectedLegId] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null); // leg pending removal confirmation
  const isDraft = !shipmentId;
  // Contract Type/No. are the trailing two LEG_COLS entries — dropping them from the end
  // keeps every other column's index (and LegRow's index-based widths[i] lookups) intact.
  const visibleCols = showContractCols ? LEG_COLS : LEG_COLS.slice(0, -2);
  // v2: widened defaults to fit real option text (e.g. "Merchant's Haulage", "Container
  // Yard") without clipping against the native <select> arrow — new key so anyone with
  // previously-persisted (narrower) widths picks up the fix instead of loading stale ones.
  const { widths, startResize } = useResizableColumns(showContractCols ? "legs-v2" : "legs-compact-v2", visibleCols.map(c => c.w));

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
      legType: "SEA", mot: "SEA", pol: "", pod: "", etd: null, eta: null,
      carrierCode: inheritedCarrier || "",
      vessel: "", vesselImo: "", voyage: "",
      contractType: inheritedContractType || "SPOT",
      contractRef:  inheritedContractRef  || "",
    };
    if (isDraft) {
      const draftLeg = { ...newLeg, id: `draft_${Date.now()}` };
      propagate(orderLegs([...legs, draftLeg]));
    } else {
      // New legs default to legType SEA (middle group) but a trailing Delivery leg would
      // otherwise land after it — reorder + re-stamp legOrder the same way saveLeg does.
      const created = await api.legs.create(shipmentId, newLeg);
      const ordered = orderLegs([...legs, created]).map((l, i) => ({ ...l, legOrder: i }));
      const next = await Promise.all(ordered.map(l => api.legs.update(shipmentId, l.id, l)));
      setLegs(next);
      onLegsChange?.(next);
    }
  };

  const saveLeg = async leg => {
    const toSave = { ...leg, contractType: inheritedContractType || leg.contractType, contractRef: inheritedContractRef || leg.contractRef };
    if (isDraft) {
      const merged = legs.map(l => l.id === toSave.id ? toSave : l);
      propagate(orderLegs(merged));
    } else {
      setSaving(toSave.id);
      try {
        // Reorder (Pick-up first, Delivery last) before persisting, so a legType change
        // — the common way a leg becomes a Pick-up/Delivery — lands in the right position
        // instead of staying wherever it was created. legOrder is re-stamped on every leg
        // so GET .../legs (ORDER BY leg_order) reflects the same sequence next load.
        const merged  = legs.map(l => l.id === toSave.id ? toSave : l);
        const ordered = orderLegs(merged).map((l, i) => ({ ...l, legOrder: i }));
        const next = await Promise.all(ordered.map(l => api.legs.update(shipmentId, l.id, l)));
        setLegs(next);
        onLegsChange?.(next);
      } finally { setSaving(null); }
    }
  };

  const removeLeg = async legId => {
    setSelectedLegId(null);
    if (isDraft) {
      propagate(legs.filter(l => l.id !== legId));
    } else {
      await api.legs.remove(shipmentId, legId);
      const next = legs.filter(l => l.id !== legId);
      setLegs(next);
      onLegsChange?.(next);
    }
  };

  const totalCols = widths.reduce((s, w) => s + w, 0);

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
            {visibleCols.map((c, i) => (
              <div key={c.key} style={{ position: "relative", width: widths[i], minWidth: widths[i], paddingLeft: 10,
                fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
                borderRight: `1px solid ${T.border}33` }}>
                {c.label}
                {i < visibleCols.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
              </div>
            ))}
          </div>
          {legs.length === 0 ? (
            <div style={{ padding: "14px 16px", fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
              No legs yet — add one below.
            </div>
          ) : legs.map(leg => {
            const isSelected = selectedLegId === leg.id;
            return (
              <div key={leg.id} id={`leg-row-${leg.id}`}
                onClick={() => canEdit && setSelectedLegId(id => id === leg.id ? null : leg.id)}
                style={{ position: "relative", cursor: canEdit ? "pointer" : "default",
                  borderLeft: isSelected ? `3px solid ${T.accent}` : "3px solid transparent",
                  transition: "border-color .12s" }}>
                {saving === leg.id && (
                  <div style={{ position: "absolute", inset: 0, background: T.accent + "08", zIndex: 1, pointerEvents: "none" }} />
                )}
                {isSelected && (
                  <div style={{ position: "absolute", inset: 0, background: T.accent + "06", pointerEvents: "none" }} />
                )}
                {/* A SEA leg is only "the schedule's leg" (and thus locked) once a real sailing has
                    been applied to it (vessel/voyage populated by applySailingToLegs) — a brand new
                    leg from "+ Add leg" also defaults to legType SEA but starts blank, and must stay
                    editable so its type can still be changed to Pick-up/Delivery. Previously this
                    locked on legType alone, trapping a fresh leg as uneditable the instant it was
                    created whenever any schedule already existed on the shipment. */}
                <LegRow leg={leg} onSave={saveLeg} canEdit={canEdit} widths={widths} inheritedContractType={inheritedContractType} inheritedContractRef={inheritedContractRef} showContractCols={showContractCols} locked={lockedSeaLegs && leg.legType === "SEA" && !!(leg.vessel || leg.voyage)} onUpdateSchedule={onUpdateSchedule} />
              </div>
            );
          })}
        </div>
      </div>
      {(() => {
        const cLegs = legs.filter(l => !["Merchant's Haulage", "Customer Arranged"].includes(l.movementType));
        const routingChip = cLegs.length > 0
          ? (LEG_LOC_ABBR_C[cLegs[0].polLocType] || cLegs[0].polLocType || "PT") + "-" +
            (LEG_LOC_ABBR_C[cLegs[cLegs.length-1].podLocType] || cLegs[cLegs.length-1].podLocType || "PT")
          : null;
        return (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "8px 12px", borderTop: legs.length ? `1px solid ${T.border}` : "none", background: T.surface }}>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, display: "flex", alignItems: "center", gap: 8 }}>
              {legs.length} leg{legs.length !== 1 ? "s" : ""}
              {legs.length > 1 && (
                <span style={{ fontFamily: T.mono }}>
                  {(cLegs[0]?.pol || legs[0]?.pol) || "?"} → {(cLegs[cLegs.length - 1]?.pod || legs[legs.length - 1]?.pod) || "?"}
                </span>
              )}
              {routingChip && (
                <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.accent,
                  background: T.accentBg, borderRadius: 4, padding: "1px 7px", border: `1px solid ${T.accent}33` }}>
                  {routingChip}
                </span>
              )}
            </span>
            {canEdit && (
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={addLeg}
                  style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
                    padding: "4px 12px", fontFamily: T.body, fontSize: 12, color: T.accent, cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = T.accent}
                  onMouseLeave={e => e.currentTarget.style.borderColor = T.border}>
                  + Add leg
                </button>
                {extraAction}
                <button
                  disabled={!selectedLegId}
                  onClick={() => selectedLegId && setConfirmRemove(legs.find(l => l.id === selectedLegId) || null)}
                  style={{ background: "none", borderRadius: 6, padding: "4px 12px",
                    fontFamily: T.body, fontSize: 12, cursor: selectedLegId ? "pointer" : "default",
                    border: `1px solid ${selectedLegId ? T.danger + "88" : T.border}`,
                    color: selectedLegId ? T.danger : T.textMuted,
                    opacity: selectedLegId ? 1 : 0.45, transition: "opacity .15s, border-color .15s, color .15s" }}>
                  Remove leg
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {confirmRemove && (() => {
        // Matches the same "is this actually the schedule's own leg" check the lock above
        // uses (vessel/voyage populated) — a brand new, still-blank SEA leg being removed is
        // not a cascade, it's just deleting an unconfigured row.
        const isCascade = lockedSeaLegs && confirmRemove.legType === "SEA" && !!(confirmRemove.vessel || confirmRemove.voyage);
        return (
          <Modal title="Remove leg?" onClose={() => setConfirmRemove(null)} width={440}>
            <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, margin: "0 0 6px", lineHeight: 1.6 }}>
              Remove the <strong>{confirmRemove.legType}</strong> leg
              {confirmRemove.pol || confirmRemove.pod
                ? <> (<span style={{ fontFamily: T.mono }}>{confirmRemove.pol || "—"} → {confirmRemove.pod || "—"}</span>)</>
                : null}?
            </p>
            {isCascade && (
              <p style={{ fontFamily: T.body, fontSize: 13, color: T.warning, margin: "0 0 14px", lineHeight: 1.6 }}>
                This is linked to an assigned schedule — removing it will also remove every other SEA leg from
                that schedule and unlink it. You'll need to add a new sailing afterward.
              </p>
            )}
            <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "0 0 20px" }}>
              This can't be undone.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setConfirmRemove(null)}>Cancel</Btn>
              <Btn variant="danger" onClick={() => { removeLeg(confirmRemove.id); setConfirmRemove(null); }}>Remove</Btn>
            </div>
          </Modal>
        );
      })()}
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

const SectionDivider = ({ label, id }) => (
  <div id={id} style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 0" }}>
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

const ShipmentForm = ({ init = {}, onSave, onBack, onDirtyChange, draftLegs, onDraftLegsChange, ctrManagerTrigger = 0 }) => {
  const { canEdit, activeOffice, userOffices, allOffices } = useAuth();
  const [legs,    setLegs]   = useState([]);
  const [touched, setTouch]  = useState({});
  const touch = k => setTouch(p => ({ ...p, [k]: true }));
  const [sameNotify, setSameNotify] = useState(
    !init.notifyId || init.notifyId === init.consigneeId
  );

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
    cargoReadyDate:         init.cargoReadyDate         || "",
    declaredValue:          init.declaredValue           != null ? String(init.declaredValue) : "",
    declaredValueCurrency:  init.declaredValueCurrency  || "USD",
    emoOfficeId:            init.emoOfficeId            || "",
    imoOfficeId:            init.imoOfficeId            || "",
    controllingOfficeId:    init.controllingOfficeId    || "",
  });
  const [offices, setOffices] = useState([]);
  useEffect(() => { api.offices.list().then(setOffices).catch(() => {}); }, []);

  // Smart-default offices when creating a new shipment based on user's active office
  useEffect(() => {
    if (init.id) return; // edit mode — don't override
    if (!activeOffice) return;
    setF(p => ({
      ...p,
      emoOfficeId: activeOffice.department === 'SE' ? activeOffice.id : (p.emoOfficeId || ""),
      imoOfficeId: activeOffice.department === 'SI' ? activeOffice.id : (p.imoOfficeId || ""),
    }));
  }, [activeOffice?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // IMO office suggestion: when POD country matches an active SI office, suggest it
  const [imoSuggestion, setImoSuggestion] = useState(null);
  useEffect(() => {
    if (init.id || f.imoOfficeId) { setImoSuggestion(null); return; }
    const podCode = (legs[legs.length - 1]?.pod || "").slice(0, 2).toUpperCase();
    if (!podCode) { setImoSuggestion(null); return; }
    const match = offices.find(o => o.department === "SI" && o.isActive && (o.countryCode || "").toUpperCase() === podCode);
    setImoSuggestion(match || null);
  }, [legs, offices, f.imoOfficeId, init.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [carrierUpdated, setCarrierUpdated] = useState("");
  const [isSaving, withSaving] = useSaving();
  const set = k => v => setF(p => ({ ...p, [k]: v }));

  const [quickCargo, setQuickCargo] = useState({
    count: '', size: '', type: '', weight: '', volume: '',
    distribution: 'all', cargoDescription: '', isDg: false, dgClass: '',
  });
  const [draftContainers,       setDraftContainers]       = useState([]);
  const [containerManagerOpen,  setContainerManagerOpen]  = useState(false);
  const [useContainerManager,   setUseContainerManager]   = useState(false);
  const [contractDgPolicy, setContractDgPolicy] = useState(null); // { dgAllowed, imdgClasses }
  const [selectedSailing,  setSelectedSailing]  = useState(null); // { carrier, vesselName, … }
  const [sailingPickerOpen, setSailingPickerOpen] = useState(false);
  const [savedSchedules,    setSavedSchedules]    = useState([]); // edit mode: persisted sailings
  const [schedLoading,      setSchedLoading]      = useState(false);
  const [confirmSailing,    setConfirmSailing]    = useState(null); // pending sailing awaiting confirmation

  // Open the container manager modal when the sidebar button fires the trigger.
  const prevTriggerRef = useRef(0);
  useEffect(() => {
    if (ctrManagerTrigger > prevTriggerRef.current) {
      setContainerManagerOpen(true);
      prevTriggerRef.current = ctrManagerTrigger;
    }
  }, [ctrManagerTrigger]);

  // Auto-compute preview chips whenever quickCargo changes (no Generate button needed).
  useEffect(() => {
    if (useContainerManager) return;
    const n = parseInt(quickCargo.count, 10);
    if (!n || n < 1 || n > 200 || !quickCargo.size || !quickCargo.type) {
      setDraftContainers([]);
      return;
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
  }, [quickCargo.count, quickCargo.size, quickCargo.type, quickCargo.weight, quickCargo.volume, quickCargo.distribution, quickCargo.cargoDescription, quickCargo.isDg, quickCargo.dgClass, useContainerManager]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!f.contractId) { setContractDgPolicy(null); return; }
    api.contracts.get(f.contractId)
      .then(c => setContractDgPolicy({ dgAllowed: c.dgAllowed, imdgClasses: c.imdgClasses || [] }))
      .catch(() => setContractDgPolicy(null));
  }, [f.contractId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load persisted schedules for edit mode
  useEffect(() => {
    if (!init.id) return;
    setSchedLoading(true);
    api.schedules.list(init.id)
      .then(setSavedSchedules)
      .catch(() => {})
      .finally(() => setSchedLoading(false));
  }, [init.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const prevFRef = useRef(f);
  useEffect(() => {
    if (prevFRef.current === f) return; // same reference = no user change (survives Strict Mode double-invoke)
    prevFRef.current = f;
    onDirtyChange?.(true);
  }, [f]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync notify party to consignee when "same as consignee" is active
  useEffect(() => {
    if (!sameNotify) return;
    setF(p => {
      if (p.notifyId === p.consigneeId && p.notifyName === p.consigneeName) return p;
      return { ...p, notifyId: p.consigneeId, notifyName: p.consigneeName };
    });
  }, [sameNotify, f.consigneeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstLeg    = legs[0] || null;
  const lastLeg     = legs[legs.length - 1] || null;
  // Merchant's Haulage and Customer Arranged legs are the customer's own responsibility —
  // we're not the carrier and don't arrange that haulage, so an incomplete one shouldn't
  // block saving the shipment or count as a missing POL/POD. Derive the shipment's own
  // door-to-door bookend from the first/last leg we're actually responsible for instead —
  // same filter already used for contractMatchRoutingTerm below, just computed earlier so
  // derivedPol/derivedPod can use it too.
  const cLegsForMatch = legs.filter(l => !["Merchant's Haulage", "Customer Arranged"].includes(l.movementType));
  const derivedPol  = cLegsForMatch[0]?.pol || firstLeg?.pol || "";
  const derivedPod  = cLegsForMatch[cLegsForMatch.length - 1]?.pod || lastLeg?.pod || "";
  const derivedEtd  = firstLeg?.etd || "";
  const derivedEta  = lastLeg?.eta  || "";

  // A journey can have more than one SEA leg (TSP/transshipment routing, e.g. from a
  // Central contract's own multi-leg contract_legs) — legs.find() would silently grab
  // only the FIRST one, giving the wrong Port of Discharge and sailing-search target for
  // anything past a single-hop route. Mirrors RouteSummaryBar's seaLegs/firstSeaLeg
  // pattern in ShipmentDetailPage.jsx.
  const seaLegs     = legs.filter(l => l.legType === "SEA");
  const firstSeaLeg = seaLegs[0] || null;
  const lastSeaLeg  = seaLegs[seaLegs.length - 1] || null;

  // Contract match routing context — excludes Merchant's Haulage and Customer Arranged
  const LEG_LOC_ABBR_C = { Door: "DR", Terminal: "PT", "Container Yard": "CY", CFS: "CFS" };
  const contractMatchRoutingTerm = cLegsForMatch.length > 0
    ? (LEG_LOC_ABBR_C[cLegsForMatch[0].polLocType] || "PT") + "-" + (LEG_LOC_ABBR_C[cLegsForMatch[cLegsForMatch.length - 1].podLocType] || "PT")
    : "";
  const pkuLeg = legs[0]?.legType === "Pick-up" && legs[0]?.movementType === "Carrier's Haulage" ? legs[0] : null;
  const delLeg = legs[legs.length - 1]?.legType === "Delivery" && legs[legs.length - 1]?.movementType === "Carrier's Haulage" ? legs[legs.length - 1] : null;
  const contractPkuLocation = pkuLeg?.pol || "";
  const contractDelLocation = delLeg?.pod || "";
  // Contract match uses the seaport POL/POD, not the door pickup/delivery location —
  // POL from the first SEA leg, POD from the last, so a multi-leg TSP journey resolves
  // to its true end-to-end sea route instead of just the first hop.
  const contractMatchPol = firstSeaLeg?.pol || derivedPol;
  const contractMatchPod = lastSeaLeg?.pod  || derivedPod;

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
  const effectiveCarrierCode = firstSeaLeg?.carrierCode || firstLeg?.carrierCode || f.carrierCode || "";
  const valid = f.incoterm !== ""
    && f.commodityCode.trim().length > 0
    && !!f.shipperId && !!f.consigneeId && !!f.principalId
    && (!isCentral || f.contractId.trim().length > 0)
    && (!init.id ? (legs.length > 0 && !!derivedPol && !!derivedPod && !!effectiveCarrierCode) : true);

  const handleSave = () => {
    if (!valid) {
      setTouch({ incoterm: true, commodityCode: true, legs: true, parties: true, offices: true });
      const missing = [];
      if (!f.shipperId || !f.consigneeId || !f.principalId) missing.push("Parties");
      if (!f.incoterm) missing.push("Incoterm");
      if (!f.commodityCode.trim()) missing.push("Commodity");
      if (!init.id) {
        if (legs.length === 0) missing.push("at least one Leg");
        else if (!derivedPol || !derivedPod) missing.push("Leg POL/POD");
        else if (!effectiveCarrierCode) missing.push("Carrier on leg");
      }
      if (isCentral && !f.contractId.trim()) missing.push("Contract (required for Central)");
      toast.error(`Missing required fields: ${missing.join(", ") || "unknown"}.`);
      return;
    }
    // Containers managed via modal take priority; otherwise rebuild from quickCargo.
    let containersToSave = draftContainers;
    const qn = parseInt(quickCargo.count, 10);
    if (!useContainerManager && !init.id && qn > 0 && quickCargo.size && quickCargo.type) {
      const totalWeight = parseFloat(quickCargo.weight) || 0;
      const totalVolume = parseFloat(quickCargo.volume) || 0;
      const perWeight = quickCargo.distribution === 'all'
        ? (totalWeight ? +((totalWeight / qn).toFixed(2)) : null)
        : (totalWeight || null);
      const perVolume = quickCargo.distribution === 'all'
        ? (totalVolume ? +((totalVolume / qn).toFixed(2)) : null)
        : (totalVolume || null);
      containersToSave = Array.from({ length: qn }, () => ({
        size: quickCargo.size, type: quickCargo.type,
        grossWeightKg: perWeight, volumeCbm: perVolume,
        cargoDescription: quickCargo.cargoDescription,
        isDg: quickCargo.isDg, dgClass: quickCargo.isDg ? quickCargo.dgClass : '',
        containerNumber: '', sealNumber: '', hsCode: '',
      }));
    }
    if (contractDgPolicy && containersToSave.some(c => c.isDg)) {
      const dgContainers = containersToSave.filter(c => c.isDg);
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
      carrierCode: effectiveCarrierCode,
      declaredValue: f.declaredValue !== "" ? Number(f.declaredValue) : null,
    }, draftLegs || [], containersToSave, selectedSailing));
  };

  const statusColor = { Active: T.success, Completed: T.info, Cancelled: T.danger, "On Hold": T.warning }[f.status] || T.textMuted;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Parties ───────────────────────────────────────────────────────────── */}
      <SectionDivider label="Parties" id="shpform-parties" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <CustomerCombobox label="Shipper" required
          value={{ id: f.shipperId, name: f.shipperName }}
          onChange={v => setF(p => ({ ...p, shipperId: v.id, shipperName: v.name }))} />
        <CustomerCombobox label="Consignee" required
          value={{ id: f.consigneeId, name: f.consigneeName }}
          onChange={v => setF(p => ({ ...p, consigneeId: v.id, consigneeName: v.name }))} />
        <CustomerCombobox label="Principal" required
          value={{ id: f.principalId, name: f.principalName }}
          onChange={v => setF(p => ({ ...p, principalId: v.id, principalName: v.name }))} />
      </div>
      {touched.parties && (!f.shipperId || !f.consigneeId || !f.principalId) && (
        <FieldError show msg="Shipper, Consignee and Principal are required" />
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
          fontFamily: T.body, fontSize: 12, color: T.textMuted, userSelect: "none", width: "fit-content" }}>
          <input type="checkbox" checked={!sameNotify}
            onChange={e => {
              const diff = e.target.checked;
              setSameNotify(!diff);
              if (!diff) setF(p => ({ ...p, notifyId: p.consigneeId, notifyName: p.consigneeName }));
            }}
            style={{ accentColor: T.accent, width: 13, height: 13 }} />
          Different notify party
        </label>
        {sameNotify
          ? <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic", paddingLeft: 2 }}>
              {f.consigneeName
                ? <>Notify → <span style={{ color: T.text, fontStyle: "normal" }}>{f.consigneeName}</span></>
                : "Same as Consignee (select a Consignee above)"}
            </div>
          : <CustomerCombobox label="Notify Party"
              value={{ id: f.notifyId, name: f.notifyName }}
              onChange={v => setF(p => ({ ...p, notifyId: v.id, notifyName: v.name }))} />
        }
      </div>

      {/* ── Cargo ─────────────────────────────────────────────────────────────── */}
      <SectionDivider label="Cargo" id="shpform-cargo" />
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
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
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Inp label="Declared Value" value={f.declaredValue}
            onChange={v => setF(p => ({ ...p, declaredValue: v }))}
            placeholder="0.00" type="number" min="0" step="0.01"
            hint="Customs / insured value of the goods" />
          <Sel label="Currency" value={f.declaredValueCurrency}
            onChange={v => setF(p => ({ ...p, declaredValueCurrency: v }))}
            options={["USD","EUR","GBP","CNY","JPY","AUD","CAD","CHF","SGD","HKD"].map(c => ({ value: c, label: c }))}
            hint="Currency the declared value is expressed in" />
        </div>
      </div>

      {/* ── Offices ───────────────────────────────────────────────────────────── */}
      <SectionDivider label="Offices" id="shpform-offices" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        {[
          { key: "emoOfficeId", label: "Export Managing Office (EMO)", required: true,  dept: "SE" },
          { key: "imoOfficeId", label: "Import Managing Office (IMO)", required: true,  dept: "SI" },
          { key: "controllingOfficeId", label: "Controlling Office",   required: false, dept: null },
        ].map(({ key, label, required, dept }) => {
          const candidates = dept ? offices.filter(o => o.department === dept && o.isActive) : offices.filter(o => o.isActive);
          return (
            <div key={key}>
              <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 5 }}>
                {label}{required && <span style={{ color: T.danger, marginLeft: 2 }}>*</span>}
              </div>
              <select value={f[key] || ""} onChange={e => setF(p => ({ ...p, [key]: e.target.value || null }))}
                style={{ width: "100%", padding: "7px 10px", borderRadius: 7, fontFamily: T.mono, fontSize: 12,
                  color: f[key] ? T.text : T.textMuted,
                  border: `1px solid ${required && touched.offices && !f[key] ? T.danger : T.border}`,
                  background: T.bg, outline: "none", cursor: "pointer", boxSizing: "border-box" }}>
                <option value="">{required ? "Select office…" : "None (optional)"}</option>
                {candidates.map(o => <option key={o.id} value={o.id}>{o.code} — {o.name}</option>)}
              </select>
              {key === "imoOfficeId" && imoSuggestion && !f.imoOfficeId && (
                <div style={{ marginTop: 5, padding: "5px 9px", borderRadius: 7,
                  background: T.info + "18", border: `1px solid ${T.info}44`,
                  display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.info, flex: 1 }}>
                    ✦ {imoSuggestion.code} — {imoSuggestion.name}
                  </span>
                  <button type="button"
                    onClick={() => setF(p => ({ ...p, imoOfficeId: imoSuggestion.id }))}
                    style={{ padding: "2px 8px", borderRadius: 5, border: "none", background: T.info,
                      color: "#fff", cursor: "pointer", fontFamily: T.body, fontSize: 11, fontWeight: 600 }}>
                    Use
                  </button>
                  <button type="button" onClick={() => setImoSuggestion(null)}
                    style={{ padding: "2px 4px", borderRadius: 5, border: "none", background: "none",
                      cursor: "pointer", fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1,
                      display: "inline-flex", alignItems: "center" }}>
                    <IconClose size={11} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {touched.offices && (!f.emoOfficeId || !f.imoOfficeId) && (
        <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.danger, marginTop: -4 }}>
          EMO and IMO are required
        </div>
      )}

      {/* ── Transport & References ─────────────────────────────────────────────── */}
      <SectionDivider label="Transport & References" id="shpform-transport" />
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
      {(() => {
        const seaPolCode = firstSeaLeg?.pol || derivedPol;
        const seaPodCode = lastSeaLeg?.pod  || derivedPod;
        const seaPolName = firstSeaLeg?.polName || (firstSeaLeg ? null : firstLeg?.polName);
        const seaPodName = lastSeaLeg?.podName  || (lastSeaLeg  ? null : lastLeg?.podName);
        const gridCols = `${pkuLeg ? "auto " : ""}1fr auto 1fr${delLeg ? " auto" : ""}`;
        const doorCell = { padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3, background: T.surface };
        const labelStyle = { fontFamily: T.body, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.09em", color: T.textMuted };
        return (
          <div id="shpform-route" style={{ display: "grid", gridTemplateColumns: gridCols,
            background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>

            {/* PKU flanking cell */}
            {pkuLeg && (
              <div id="shpform-route-pku" style={{ ...doorCell, borderRight: `1px dashed ${T.border}` }}>
                <span style={{ ...labelStyle, color: T.accent }}>Pick-up</span>
                <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>{pkuLeg.pol || "—"}</span>
                {pkuLeg.polName && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{pkuLeg.polName}</span>}
                <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>Carrier's Haulage →</span>
              </div>
            )}

            {/* POL */}
            <div id="shpform-route-pol" style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>Port of Loading</span>
              <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700,
                color: seaPolCode ? T.text : T.border }}>{seaPolCode || "—"}</span>
              {seaPolName
                ? <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{seaPolName}</span>
                : <span style={{ fontFamily: T.body, fontSize: 11, color: T.border, fontStyle: "italic" }}>Add a leg to set</span>}
            </div>

            {/* Centre: ETD → transit → ETA */}
            <div id="shpform-route-transit" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              gap: 6, padding: "12px 24px",
              borderLeft: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}`,
              background: T.surface }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                  <span style={labelStyle}>ETD</span>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: derivedEtd ? T.text : T.border }}>
                    {derivedEtd || "—"}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  {transitDays !== null && transitDays >= 0
                    ? <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.accent,
                        background: T.accentBg, border: `1px solid ${T.accent}33`,
                        borderRadius: 10, padding: "2px 10px", whiteSpace: "nowrap" }}>
                        {transitDays}d transit
                      </span>
                    : transitDays !== null && transitDays < 0
                      ? <span title="ETA is before ETD — check leg dates" style={{ fontFamily: T.mono, fontSize: 11,
                          fontWeight: 700, color: T.warning, background: T.warning + "18",
                          border: `1px solid ${T.warning}44`, borderRadius: 10,
                          padding: "2px 10px", whiteSpace: "nowrap", cursor: "default",
                          display: "inline-flex", alignItems: "center", gap: 3 }}>
                          <IconWarning size={10} />dates
                        </span>
                      : <span style={{ color: T.border, fontSize: 16 }}>→</span>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                  <span style={labelStyle}>ETA</span>
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
                  const code = firstSeaLeg?.carrierCode || firstLeg?.carrierCode || f.carrierCode;
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
            <div id="shpform-route-pod" style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 3, textAlign: "right" }}>
              <span style={{ ...labelStyle, textAlign: "right" }}>Port of Discharge</span>
              <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700,
                color: seaPodCode ? T.text : T.border }}>{seaPodCode || "—"}</span>
              {seaPodName
                ? <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{seaPodName}</span>
                : <span style={{ fontFamily: T.body, fontSize: 11, color: T.border, fontStyle: "italic" }}>Add a leg to set</span>}
            </div>

            {/* DEL flanking cell */}
            {delLeg && (
              <div id="shpform-route-del" style={{ ...doorCell, borderLeft: `1px dashed ${T.border}`, textAlign: "right" }}>
                <span style={{ ...labelStyle, color: T.accent }}>Delivery</span>
                <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>{delLeg.pod || "—"}</span>
                {delLeg.podName && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{delLeg.podName}</span>}
                <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>→ Carrier's Haulage</span>
              </div>
            )}
          </div>
        );
      })()}

      <FieldError show={touched.legs && !init.id && legs.length === 0}
        msg="At least one leg is required — add a leg to set Port of Loading, Port of Discharge, and ETD" />

      {/* ── Containers (new shipment only; hidden when manager has ≥1 container) ─ */}
      {!init.id && useContainerManager && draftContainers.length >= 1 && (
        <>
          <SectionDivider label="Containers" id="shpform-containers" />
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
            background: T.bg, border: `1px solid ${T.accent}33`, borderRadius: 8 }}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>
              {draftContainers.length} container{draftContainers.length !== 1 ? 's' : ''} configured
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, flex: 1 }}>
              {draftContainers.map((c, i) => (
                <span key={i} style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 600,
                  background: T.accentBg, color: T.accent, border: `1px solid ${T.accent}44`,
                  borderRadius: 6, padding: "2px 8px", whiteSpace: "nowrap" }}>
                  #{i + 1} · {c.size}{c.type}{c.grossWeightKg ? ` · ${c.grossWeightKg} kg` : ''}{c.isDg ? ` · DG ${c.dgClass}` : ''}
                </span>
              ))}
            </div>
            <button type="button" onClick={() => setContainerManagerOpen(true)}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
                cursor: "pointer", color: T.text, fontFamily: T.body, fontSize: 11,
                padding: "4px 10px", whiteSpace: "nowrap" }}>
              Edit
            </button>
          </div>
        </>
      )}
      {!init.id && !(useContainerManager && draftContainers.length >= 1) && (
        <>
          <SectionDivider label="Containers" id="shpform-containers" />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
            {/* Left: cargo fields stacked */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Row 1: Count · Type · Weight · Volume */}
              <div style={{ display: "grid", gridTemplateColumns: "72px 163px 130px 120px", gap: 10, alignItems: "end" }}>
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
              </div>

              {/* Row 2: Distribution + DG flag inline */}
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div>
                  <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 5 }}>
                    Distribution
                  </div>
                  <select value={quickCargo.distribution}
                    onChange={e => setQuickCargo(q => ({ ...q, distribution: e.target.value }))}
                    style={{ ...inputBase, fontFamily: T.body, fontSize: 13, cursor: "pointer", width: "fit-content" }}>
                    <option value="all">Total ÷ N</option>
                    <option value="per">Per container</option>
                  </select>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 20 }}>
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
                        style={{ ...inputBase, fontFamily: T.body, fontSize: 13, cursor: "pointer" }}>
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
                          return <span style={{ fontFamily: T.body, fontSize: 11, color: T.success, whiteSpace: "nowrap",
                            display: "inline-flex", alignItems: "center", gap: 3 }}><IconCheck size={10} />Permitted</span>;
                        return null;
                      })()}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Right: Cargo Description (tall textarea) */}
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 5 }}>
                Cargo Description
              </div>
              <textarea
                value={quickCargo.cargoDescription}
                onChange={e => setQuickCargo(q => ({ ...q, cargoDescription: e.target.value }))}
                placeholder="e.g. Electronics components in cartons"
                rows={5}
                style={{ ...inputBase, fontFamily: T.body, fontSize: 13, resize: "vertical",
                  flex: 1, minHeight: 110, padding: "8px 10px", lineHeight: 1.5 }} />
            </div>
          </div>

          {/* Preview chips — auto-updated as fields change */}
          {draftContainers.length > 0 && (() => {
            const c0 = draftContainers[0];
            const typeLabel = `${c0.size}${c0.type}`;
            const wt  = c0.grossWeightKg != null ? `${c0.grossWeightKg.toLocaleString()} kg` : null;
            const vol = c0.volumeCbm     != null ? `${c0.volumeCbm} CBM` : null;
            const dg  = c0.isDg ? (c0.dgClass ? `DG ${c0.dgClass}` : 'DG') : null;
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
      <SectionDivider label="Contract" id="shpform-contract" />
      <ContractTypeInput value={f.contractType} onChange={v => {
        if (v !== "Central") {
          setF(p => ({ ...p, contractType: v, contractId: "", contractRef: "", allocationId: "" }));
        } else if (!init.id && !((useContainerManager && draftContainers.length >= 1) || (parseInt(quickCargo.count, 10) > 0 && quickCargo.size && quickCargo.type))) {
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
          pol={contractMatchPol}
          pod={contractMatchPod}
          etd={derivedEtd}
          crd={f.cargoReadyDate || ""}
          needsPolHaulage={!!pkuLeg}
          needsPodHaulage={!!delLeg}
          pkuLocation={contractPkuLocation}
          delLocation={contractDelLocation}
          contractType={f.contractType}
          carrierCode={effectiveCarrierCode || undefined}
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

      {/* ── Sailing ───────────────────────────────────────────────────────────── */}
      <SectionDivider label="Sailing" id="shpform-sailing" />
      {(() => {
        const pol = contractMatchPol || derivedPol;
        const pod = contractMatchPod || derivedPod;
        const carrier = effectiveCarrierCode;
        const canSearch = !!(pol && pod && carrier);

        const applySailingToLegs = (sailing) => {
          const list = draftLegs || [];
          const firstSeaIdx = list.findIndex(l => l.legType === "SEA");
          const isTSPForCreate = sailing.legs && sailing.legs.length > 1;

          // No SEA leg staged yet — create it/them from the sailing instead of silently
          // doing nothing (mirrors ShipmentSchedulesPage.jsx's equivalent fix for the same
          // gap post-creation — nothing seeds an initial leg automatically, so a shipment
          // that goes straight to Add Sailing used to leave Route Legs empty with no error).
          if (firstSeaIdx === -1) {
            const segments = isTSPForCreate ? sailing.legs : [{
              pol: sailing.pol, pod: sailing.pod, etd: sailing.etd, eta: sailing.eta,
              vesselName: sailing.vesselName, voyageNumber: sailing.voyageNumber,
            }];
            const newLegs = segments.map((leg, i) => ({
              id:           `draft_${Date.now() + i}`,
              legType:      "SEA",
              movementType: "SEA",
              movementBy:   "",
              polLocType:   "Terminal",
              podLocType:   "Terminal",
              pol:          leg.pol,      polName: "",
              pod:          leg.pod,      podName: "",
              etd:          leg.etd,
              eta:          leg.eta,
              carrierCode:  sailing.carrier || "",
              vessel:       leg.vesselName   || "",
              vesselImo:    "",
              voyage:       leg.voyageNumber || "",
              contractType: "SPOT",
              contractRef:  "",
            }));
            onDraftLegsChange([...list, ...newLegs]);
            toast.success(isTSPForCreate
              ? `TSP sailing applied — ${newLegs.length} sea legs created`
              : "Sailing applied — SEA leg created");
            return;
          }
          const firstSeaLeg = list[firstSeaIdx];
          // Drop every SEA leg AFTER the first one — they belong to whatever routing was
          // there before (including a contract's own pre-populated multi-leg legs), and
          // would otherwise sit stale alongside whatever this sailing applies next. Mirrors
          // ShipmentSchedulesPage.jsx's applySailingToLegs, which already gets this right
          // for existing shipments.
          const base = list.filter((l, i) => i === firstSeaIdx || l.legType !== "SEA");
          const baseFirstIdx = base.indexOf(firstSeaLeg);
          const isTSP = sailing.legs && sailing.legs.length > 1;
          if (isTSP) {
            const updatedFirst = {
              ...firstSeaLeg,
              vessel:      sailing.legs[0].vesselName   || firstSeaLeg.vessel,
              voyage:      sailing.legs[0].voyageNumber || firstSeaLeg.voyage,
              etd:         sailing.legs[0].etd          || firstSeaLeg.etd,
              eta:         sailing.legs[0].eta          || firstSeaLeg.eta,
              pod:         sailing.legs[0].pod          || firstSeaLeg.pod,
              podName:     sailing.legs[0].pod !== firstSeaLeg.pod ? "" : firstSeaLeg.podName,
              carrierCode: sailing.carrier              || firstSeaLeg.carrierCode,
            };
            const extraLegs = sailing.legs.slice(1).map((leg, i) => ({
              id:           `draft_${Date.now() + i + 1}`,
              legType:      "SEA",
              movementType: "SEA",
              movementBy:   "",
              polLocType:   "Terminal",
              podLocType:   "Terminal",
              pol:          leg.pol,      polName: "",
              pod:          leg.pod,      podName: "",
              etd:          leg.etd,
              eta:          leg.eta,
              carrierCode:  sailing.carrier || "",
              vessel:       leg.vesselName   || "",
              vesselImo:    "",
              voyage:       leg.voyageNumber || "",
              contractType: firstSeaLeg.contractType || "SPOT",
              contractRef:  firstSeaLeg.contractRef  || "",
            }));
            const newLegs = [...base];
            newLegs[baseFirstIdx] = updatedFirst;
            newLegs.splice(baseFirstIdx + 1, 0, ...extraLegs);
            onDraftLegsChange(newLegs);
            toast.success(`TSP sailing applied — ${sailing.legs.length} sea legs updated`);
          } else {
            // A direct sailing's own pol/pod are always the true door-to-door endpoints —
            // reset both in case this leg currently holds a TSP hub from a previously
            // applied sailing (or a contract's own multi-leg routing being collapsed).
            const updatedFirst = {
              ...firstSeaLeg,
              vessel:      sailing.vesselName   || firstSeaLeg.vessel,
              voyage:      sailing.voyageNumber || firstSeaLeg.voyage,
              etd:         sailing.etd          || firstSeaLeg.etd,
              eta:         sailing.eta          || firstSeaLeg.eta,
              carrierCode: sailing.carrier      || firstSeaLeg.carrierCode,
              pol:         sailing.pol          || firstSeaLeg.pol,
              pod:         sailing.pod          || firstSeaLeg.pod,
              polName:     sailing.pol !== firstSeaLeg.pol ? "" : firstSeaLeg.polName,
              podName:     sailing.pod !== firstSeaLeg.pod ? "" : firstSeaLeg.podName,
            };
            const updated = base.map((l, i) => i === baseFirstIdx ? updatedFirst : l);
            onDraftLegsChange(updated);
            toast.success("Sailing applied to SEA leg");
          }
        };

        const commitSailing = async (sailing) => {
          if (init.id) {
            try {
              await Promise.all(savedSchedules.map(s => api.schedules.remove(init.id, s.id)));
              const saved = await api.schedules.save(init.id, sailing);
              setSavedSchedules([saved]);
              applySailingToLegs(sailing);
            } catch (e) { toast.error(e.message); }
          } else {
            setSelectedSailing(sailing);
          }
        };

        const handleSelectSailing = (sailing) => {
          setSailingPickerOpen(false);
          const existingVoy = savedSchedules[0]?.voyageNumber || selectedSailing?.voyageNumber;
          const isReplacing = !!(init.id ? savedSchedules.length > 0 : selectedSailing);
          const isSameVoy   = existingVoy === sailing.voyageNumber;
          if (isReplacing && !isSameVoy) {
            setConfirmSailing(sailing); // show inline confirmation strip
          } else {
            commitSailing(sailing);
          }
        };

        const removeSchedule = async (scheduleId) => {
          try {
            await api.schedules.remove(init.id, scheduleId);
            setSavedSchedules(p => p.filter(s => s.id !== scheduleId));
            toast.success("Sailing removed");
          } catch (e) { toast.error(e.message); }
        };

        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

            {/* Edit mode: show persisted sailings */}
            {init.id && (
              schedLoading
                ? <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Loading…</div>
                : savedSchedules.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {savedSchedules.map(s => (
                      <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10,
                        padding: "10px 14px", background: T.bg,
                        border: `1px solid ${T.border}`, borderRadius: 8 }}>
                        <div style={{ flex: 1, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                          <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>
                            {s.vesselName || "—"}
                          </span>
                          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                            Voy {s.voyageNumber}
                          </span>
                          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>
                            {s.etd} → {s.eta}
                          </span>
                          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent,
                            background: T.accentBg, borderRadius: 4, padding: "1px 7px",
                            border: `1px solid ${T.accent}33` }}>
                            {s.transitDays}d
                          </span>
                          {s.isMock && (
                            <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                              background: T.warning + "22", color: T.warning,
                              border: `1px solid ${T.warning}44`, borderRadius: 4,
                              padding: "1px 6px", textTransform: "uppercase" }}>Demo</span>
                          )}
                        </div>
                        {canEdit && (draftLegs || []).some(l => l.legType === "SEA") && (
                          <button type="button"
                            onClick={() => applySailingToLegs({
                              carrier:      s.carrier,
                              vesselName:   s.vesselName,
                              voyageNumber: s.voyageNumber,
                              etd:          s.etd,
                              eta:          s.eta,
                              legs:         null,
                            })}
                            style={{ background: "none", border: `1px solid ${T.border}`,
                              borderRadius: 4, cursor: "pointer", fontFamily: T.body,
                              fontSize: 11, color: T.textMuted, padding: "2px 8px", flexShrink: 0 }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}
                            title="Apply vessel &amp; dates to SEA leg">↳ Apply</button>
                        )}
                        {canEdit && (
                          <button type="button" onClick={() => removeSchedule(s.id)}
                            style={{ background: "none", border: "none", cursor: "pointer",
                              color: T.textMuted, fontSize: 14, padding: "0 2px", lineHeight: 1,
                              display: "inline-flex", alignItems: "center" }}
                            title="Remove sailing"><IconClose size={12} /></button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
                    No sailings saved — add one below.
                  </div>
                )
            )}

            {/* New mode: show selected sailing chip */}
            {!init.id && selectedSailing && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                  background: T.accentBg, border: `1px solid ${T.accent}44`, borderRadius: 8 }}>
                  <div style={{ flex: 1, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.accent }}>
                      {selectedSailing.vesselName}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                      Voy {selectedSailing.voyageNumber}
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>
                      {selectedSailing.etd} → {selectedSailing.eta}
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent,
                      background: T.accentBg, borderRadius: 4, padding: "1px 7px",
                      border: `1px solid ${T.accent}33` }}>
                      {selectedSailing.transitDays}d
                    </span>
                    {selectedSailing.isMock && (
                      <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                        background: T.warning + "22", color: T.warning,
                        border: `1px solid ${T.warning}44`, borderRadius: 4,
                        padding: "1px 6px", textTransform: "uppercase" }}>Demo</span>
                    )}
                  </div>
                  <button type="button" onClick={() => setSelectedSailing(null)}
                    style={{ background: "none", border: "none", cursor: "pointer",
                      color: T.textMuted, fontSize: 14, padding: "0 2px", lineHeight: 1,
                      display: "inline-flex", alignItems: "center" }}><IconClose size={12} /></button>
                </div>
                {(draftLegs || []).some(l => l.legType === "SEA") && (
                  <button type="button"
                    onClick={() => applySailingToLegs(selectedSailing)}
                    style={{ alignSelf: "flex-start", background: "none",
                      border: `1px solid ${T.border}`, borderRadius: 5,
                      padding: "4px 12px", cursor: "pointer",
                      fontFamily: T.body, fontSize: 12, color: T.textMuted }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}>
                    ↳ Apply sailing to SEA leg{selectedSailing?.legs?.length > 1 ? `s (TSP · ${selectedSailing.legs.length} legs)` : ""}
                  </button>
                )}
              </div>
            )}

            {confirmSailing && (
              <Modal title="Replace sailing?" onClose={() => setConfirmSailing(null)} width={420}>
                <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, margin: "0 0 6px", lineHeight: 1.6 }}>
                  This will replace{" "}
                  <strong style={{ fontFamily: T.mono }}>
                    {savedSchedules[0]?.vesselName || selectedSailing?.vesselName || "the current sailing"}
                  </strong>{" "}
                  with{" "}
                  <strong style={{ fontFamily: T.mono }}>{confirmSailing.vesselName}</strong>
                  {" "}· Voy {confirmSailing.voyageNumber}.
                </p>
                <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "0 0 20px" }}>
                  The sea leg dates will be updated automatically.
                </p>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Btn variant="secondary" onClick={() => setConfirmSailing(null)}>Cancel</Btn>
                  <Btn onClick={() => { commitSailing(confirmSailing); setConfirmSailing(null); }}>Replace</Btn>
                </div>
              </Modal>
            )}

            {/* Search button */}
            {canEdit && (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button"
                  disabled={!canSearch}
                  onClick={() => canSearch && setSailingPickerOpen(true)}
                  style={{ background: canSearch ? T.surface : T.bg,
                    border: `1px solid ${canSearch ? T.border : T.border}`,
                    borderRadius: 6, padding: "7px 14px", cursor: canSearch ? "pointer" : "not-allowed",
                    fontFamily: T.body, fontSize: 13, color: canSearch ? T.text : T.textMuted,
                    opacity: canSearch ? 1 : 0.5, display: "flex", alignItems: "center", gap: 6 }}
                  onMouseEnter={e => { if (canSearch) { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = canSearch ? T.text : T.textMuted; }}>
                  <IconAnchor size={13} />{init.id ? (savedSchedules.length > 0 ? "Change Sailing" : "Add Sailing") : (selectedSailing ? "Change Sailing" : "Search Sailings")}
                </button>
                {!canSearch && (
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                    Set POL, POD and carrier via legs first
                  </span>
                )}
              </div>
            )}

            {sailingPickerOpen && canSearch && (
              <SailingPickerModal
                pol={pol} pod={pod} carrierCode={carrier}
                routingTerm={contractMatchRoutingTerm}
                activeSailing={savedSchedules[0] || selectedSailing || null}
                onSelect={handleSelectSailing}
                onClose={() => setSailingPickerOpen(false)} />
            )}
          </div>
        );
      })()}

      {/* ── Status ────────────────────────────────────────────────────────────── */}
      <SectionDivider label="Status" id="shpform-status" />
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor,
          flexShrink: 0, boxShadow: `0 0 6px ${statusColor}88` }} />
        <div style={{ flex: 1 }}>
          <Sel label="" value={f.status} onChange={set("status")}
            options={STATUSES.map(s => ({ value: s, label: s }))} />
        </div>
      </div>

      {/* ── Actions ───────────────────────────────────────────────────────────── */}
      <div id="shpform-actions" style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 8,
        borderTop: `1px solid ${T.border}`, marginTop: 8 }}>
        <Btn variant="secondary" onClick={onBack}>Cancel</Btn>
        <Btn onClick={handleSave}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {isSaving && <Spinner size="sm" color="currentColor" />}
            {isSaving ? "Saving…" : (init.id ? "Save Changes" : "Create Shipment")}
          </span>
        </Btn>
      </div>

      {containerManagerOpen && (
        <DraftContainerManagerModal
          containers={draftContainers}
          onSave={containers => {
            setDraftContainers(containers);
            setUseContainerManager(containers.length >= 1);
            setContainerManagerOpen(false);
          }}
          onClose={() => setContainerManagerOpen(false)}
        />
      )}
    </div>
  );
};

// ─── ShipmentFormPage ─────────────────────────────────────────────────────────

const BLANK_LEG = () => ({
  id: `draft_${Date.now()}`,
  legType: "SEA", movementType: "SEA", movementBy: "",
  polLocType: "Terminal", podLocType: "Terminal",
  pol: "", polName: "", pod: "", podName: "",
  etd: null, eta: null, carrierCode: "",
  vessel: "", vesselImo: "", voyage: "",
  contractType: "SPOT", contractRef: "",
});

const ShipmentFormPage = ({ mode, init = {}, onSave, onBack, onDirtyChange, ctrManagerTrigger = 0 }) => {
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
          ctrManagerTrigger={ctrManagerTrigger}
        />
      </div>
    </div>
  );
};

export default ShipmentFormPage;
