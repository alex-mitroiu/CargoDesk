import { useState, useEffect, useCallback, useRef } from "react";
import { T, IMDG_CLASSES } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { PageSpinner } from "../../components/primitives/Spinner";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Modal } from "../../components/primitives/Modal";
import Pagination from "../../components/primitives/Pagination";
import { inputBase, Field } from "../../components/primitives/Form";
import DatePicker from "../../components/primitives/DatePicker";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";
import ActionMenu from "../../components/primitives/ActionMenu";
import EntityHistoryModal from "../../components/shared/EntityHistoryModal";
import PortCombobox from "../../components/shared/PortCombobox";
import CustomerCombobox from "../../components/shared/CustomerCombobox";

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_CODES = [
  { code: "OF",    label: "Ocean Freight" },
  { code: "BAF",   label: "Bunker Adj. Factor" },
  { code: "CAF",   label: "Currency Adj. Factor" },
  { code: "EBS",   label: "Emergency Bunker" },
  { code: "THC-O", label: "THC Origin" },
  { code: "THC-D", label: "THC Destination" },
  { code: "BL",    label: "B/L Fee" },
  { code: "AMS",   label: "Advance Manifest" },
  { code: "ENS",   label: "Entry Summary" },
  { code: "IMO",   label: "IMO/DG Surcharge" },
  { code: "PSS",   label: "Peak Season" },
  { code: "ISPS",  label: "ISPS Security" },
  { code: "DOC",   label: "Documentation" },
  { code: "CUC",   label: "Carrier Uplift" },
  { code: "WRS",   label: "War Risk" },
  { code: "SCS",   label: "Suez Canal" },
  { code: "OTHER", label: "Other / Custom" },
];
const CONTAINER_OPTIONS = ["20DC","40DC","40HC","40RF","20RF","20OT","40OT","20FR","40FR","20TK","40TK"];
const CURRENCIES = ["USD","EUR","GBP","CHF","JPY","CNY","SGD","HKD","AED","SAR","AUD","CAD","DKK","NOK","SEK"];
const UNITS = ["per_container","per_bl","per_kg","per_cbm"];
const MOVEMENT_TYPES = ["FCL","LCL"];
const CONTRACT_STATUSES = ["Active","Draft","Expired","On Hold"];

const EMPTY_FILTERS = { search:"", carrier:"", status:"", dg:"", asOf:"", containerType:"" };
const LIMIT = 25;

const EMPTY_FORM = {
  contractNumber: "", carrierCode: "", namedAccountId: "", namedAccount: "",
  movementType: "FCL", containerTypes: [], dgAllowed: false, imdgClasses: [],
  validFrom: "", validTo: "", currency: "USD", status: "Active", notes: "",
  legs: [],
  rates: [],
};

// ─── Section header style helper ─────────────────────────────────────────────
// Returns a fresh object on every call so T.* tokens are read at render time.

const sectionHeader = () => ({
  fontFamily: T.mono,
  fontSize: 10,
  fontWeight: 700,
  color: T.accent,
  textTransform: "uppercase",
  letterSpacing: ".1em",
  marginBottom: 10,
  marginTop: 20,
});

// ─── Status badge variant ─────────────────────────────────────────────────────

const contractStatusVariant = s => ({
  Active: "success",
  Draft: "warning",
  Expired: "danger",
  "On Hold": "default",
}[s] || "default");

// ─── Route summary helper ──────────────────────────────────────────────────────

function routeSummary(legs) {
  if (!legs || legs.length === 0) return "—";
  if (legs.length === 1) {
    return `${legs[0].pol || "?"} → ${legs[0].pod || "?"}`;
  }
  return `${legs[0].pol || "?"} → … → ${legs[legs.length - 1].pod || "?"}`;
}

// ─── Contract Modal Form ──────────────────────────────────────────────────────

const ContractModal = ({ editing, onSave, onClose }) => {
  const [f, setF] = useState(() => {
    if (!editing) return { ...EMPTY_FORM };
    return {
      contractNumber: editing.contractNumber || "",
      carrierCode:    editing.carrierCode    || "",
      namedAccountId: editing.namedAccountId || "",
      namedAccount:   editing.namedAccount   || "",
      movementType:   editing.movementType   || "FCL",
      containerTypes: editing.containerTypes || [],
      dgAllowed:      editing.dgAllowed      || false,
      imdgClasses:    editing.imdgClasses    || [],
      validFrom:      editing.validFrom      || "",
      validTo:        editing.validTo        || "",
      currency:       editing.currency       || "USD",
      status:         editing.status         || "Active",
      notes:          editing.notes          || "",
      legs:           editing.legs           || [],
      rates:          editing.rates          || [],
    };
  });

  const [fxRates,      setFxRates]      = useState({});
  const [saving,       setSaving]       = useState(false);
  const [allCarriers,  setAllCarriers]  = useState([]);
  const [carrierOpen,  setCarrierOpen]  = useState(false);
  const [carrierQuery, setCarrierQuery] = useState(editing?.carrierCode || "");
  const carrierRef = useRef(null);
  const carrierDropPos = useRef({});

  // Fetch carriers + FX rates once on mount
  useEffect(() => {
    api.carriers.list().then(setAllCarriers).catch(() => {});
    api.fx.rates().then(r => setFxRates(r.rates || {})).catch(() => {});
  }, []);

  // Close carrier dropdown on outside click
  useEffect(() => {
    if (!carrierOpen) return;
    const handler = e => { if (!carrierRef.current?.contains(e.target)) setCarrierOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [carrierOpen]);

  const carrierMatches = allCarriers.filter(c =>
    c.code.includes(carrierQuery.toUpperCase()) ||
    c.name.toLowerCase().includes(carrierQuery.toLowerCase())
  );

  // Load legs+rates when editing
  useEffect(() => {
    if (editing?.id) {
      api.contracts.get(editing.id).then(full => {
        setF(p => ({ ...p, legs: full.legs || [], rates: full.rates || [] }));
      }).catch(() => {});
    }
  }, [editing?.id]);

  const updateLeg = (i, patch) =>
    setF(p => ({ ...p, legs: p.legs.map((l, idx) => idx === i ? { ...l, ...patch } : l) }));

  const addLeg = () =>
    setF(p => ({ ...p, legs: [...p.legs, { pol:"", polName:"", pod:"", podName:"", transitDays:0, vesselService:"", polLinkedAllowed:false, podLinkedAllowed:false }] }));

  const removeLeg = i =>
    setF(p => ({ ...p, legs: p.legs.filter((_, idx) => idx !== i) }));

  const calcUsd = (amount, currency) => {
    if (!currency || currency === "USD") return Math.round(amount * 100) / 100;
    const rate = fxRates[currency];
    return rate ? Math.round((amount / rate) * 100) / 100 : Math.round(amount * 100) / 100;
  };

  const updateRate = (i, patch) => {
    setF(p => {
      const rates = p.rates.map((r, idx) => {
        if (idx !== i) return r;
        const updated = { ...r, ...patch };
        // Recalc USD if amount or currency changed
        if ("amount" in patch || "currency" in patch) {
          updated.amountUsd = calcUsd(updated.amount || 0, updated.currency || "USD");
        }
        return updated;
      });
      return { ...p, rates };
    });
  };

  const addRate = () =>
    setF(p => ({ ...p, rates: [...p.rates, { serviceCode:"OF", description:"", containerType:"", amount:0, currency: p.currency, amountUsd:0, unit:"per_container", notes:"" }] }));

  const removeRate = i =>
    setF(p => ({ ...p, rates: p.rates.filter((_, idx) => idx !== i) }));

  const toggleContainer = ct =>
    setF(p => ({
      ...p,
      containerTypes: p.containerTypes.includes(ct)
        ? p.containerTypes.filter(c => c !== ct)
        : [...p.containerTypes, ct],
    }));

  const toggleImdg = code =>
    setF(p => ({
      ...p,
      imdgClasses: p.imdgClasses.includes(code)
        ? p.imdgClasses.filter(c => c !== code)
        : [...p.imdgClasses, code],
    }));

  const handleSave = async () => {
    if (!f.contractNumber.trim()) return toast.error("Contract number required");
    if (!f.carrierCode.trim())    return toast.error("Carrier code required");
    if (allCarriers.length > 0 && !allCarriers.find(c => c.code === f.carrierCode))
      return toast.error(`"${f.carrierCode}" is not a recognised carrier code`);
    if (!f.validFrom || !f.validTo) return toast.error("Validity dates required");
    if (f.legs.length === 0) return toast.error("At least one routing leg required");
    setSaving(true);
    try {
      if (editing) {
        await api.contracts.update(editing.id, f);
      } else {
        await api.contracts.create(f);
      }
      toast.success(editing ? "Contract updated" : "Contract created");
      onSave();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const selectBase = {
    ...inputBase,
    fontFamily: T.body,
    fontSize: 13,
    cursor: "pointer",
    width: "100%",
  };

  const chipStyle = (active) => ({
    padding: "4px 10px",
    borderRadius: 5,
    fontFamily: T.mono,
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    border: `1px solid ${active ? T.accent : T.border}`,
    background: active ? T.accentBg : "transparent",
    color: active ? T.accent : T.textMuted,
    transition: "background 0.12s, border-color 0.12s",
    userSelect: "none",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>

      {/* ── Section 1: Identification ── */}
      <div style={sectionHeader()}>Identification</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {/* Contract Number */}
        <Field label="Contract Number" required>
          <input
            value={f.contractNumber}
            onChange={e => setF(p => ({ ...p, contractNumber: e.target.value }))}
            placeholder="SC-MAEU-2025-001"
            style={{ ...inputBase, fontFamily: T.mono, fontSize: 13 }}
          />
        </Field>
        {/* Carrier Code */}
        <Field label="Carrier Code" required>
          <div ref={carrierRef} style={{ position: "relative" }}>
            <input
              value={carrierQuery}
              onChange={e => {
                const q = e.target.value.toUpperCase();
                setCarrierQuery(q);
                setF(p => ({ ...p, carrierCode: q }));
                setCarrierOpen(true);
              }}
              onFocus={() => {
                if (carrierRef.current) {
                  const r = carrierRef.current.getBoundingClientRect();
                  carrierDropPos.current = { top: r.bottom + 4, left: r.left, width: r.width };
                }
                setCarrierOpen(true);
              }}
              placeholder="MAEU"
              autoComplete="off"
              style={{
                ...inputBase, fontFamily: T.mono, fontSize: 13,
                borderColor: f.carrierCode && allCarriers.length > 0 && !allCarriers.find(c => c.code === f.carrierCode)
                  ? T.danger : undefined,
              }}
            />
            {carrierOpen && carrierMatches.length > 0 && (
              <div style={{
                position: "fixed",
                top: carrierDropPos.current.top,
                left: carrierDropPos.current.left,
                width: carrierDropPos.current.width,
                background: T.surface, border: `1px solid ${T.border}`,
                borderRadius: 8, zIndex: 2000, boxShadow: "0 8px 24px rgba(0,0,0,.35)",
                maxHeight: 220, overflowY: "auto",
              }}>
                {carrierMatches.map(c => (
                  <div key={c.code}
                    onMouseDown={e => {
                      e.preventDefault();
                      setCarrierQuery(c.code);
                      setF(p => ({ ...p, carrierCode: c.code }));
                      setCarrierOpen(false);
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "8px 12px", cursor: "pointer",
                      borderBottom: `1px solid ${T.border}22`,
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = T.bg}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, minWidth: 48 }}>{c.code}</span>
                    <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{c.name}</span>
                  </div>
                ))}
              </div>
            )}
            {f.carrierCode && allCarriers.length > 0 && !allCarriers.find(c => c.code === f.carrierCode) && (
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.danger, marginTop: 4 }}>
                Not a recognised carrier code
              </div>
            )}
          </div>
        </Field>
        {/* Named Account */}
        <div style={{ gridColumn: "1 / -1" }}>
          <CustomerCombobox
            label="Named Account"
            value={{ id: f.namedAccountId, name: f.namedAccount }}
            onChange={({ id, name }) => setF(p => ({ ...p, namedAccountId: id, namedAccount: name }))}
          />
        </div>
        {/* Movement Type */}
        <Field label="Movement Type">
          <select value={f.movementType} onChange={e => setF(p => ({ ...p, movementType: e.target.value }))} style={selectBase}>
            {MOVEMENT_TYPES.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        {/* Currency */}
        <Field label="Currency">
          <select value={f.currency} onChange={e => setF(p => ({ ...p, currency: e.target.value }))} style={selectBase}>
            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        {/* Status */}
        <Field label="Status">
          <select value={f.status} onChange={e => setF(p => ({ ...p, status: e.target.value }))} style={selectBase}>
            {CONTRACT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
      </div>

      {/* ── Section 2: Validity ── */}
      <div style={sectionHeader()}>Validity</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <DatePicker label="Valid From" value={f.validFrom} onChange={v => setF(p => ({ ...p, validFrom: v }))} />
        <DatePicker label="Valid To"   value={f.validTo}   onChange={v => setF(p => ({ ...p, validTo: v }))}
          minDate={f.validFrom || undefined} />
      </div>

      {/* ── Section 3: Routing ── */}
      <div style={sectionHeader()}>Routing (Multi-Leg)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {f.legs.map((leg, i) => (
          <div key={i} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px" }}>
            {/* Row 1: Leg label · POL · → · POD · remove */}
            <div style={{ display: "grid", gridTemplateColumns: "44px 1fr 18px 1fr 32px", gap: 8, alignItems: "start" }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, fontWeight: 700, paddingTop: 8 }}>
                Leg {i + 1}
              </span>

              {/* POL */}
              <div>
                {leg.pol ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, background: T.surface,
                    border: `1px solid ${T.accent}55`, borderRadius: 6, padding: "6px 10px" }}>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{leg.pol}</span>
                    {leg.polName && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{leg.polName}</span>}
                    <button type="button" onClick={() => updateLeg(i, { pol: "", polName: "", polLinkedAllowed: false })}
                      style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 10, padding: 0, flexShrink: 0 }}>✕</button>
                  </div>
                ) : (
                  <PortCombobox placeholder="POL…" onChange={r => updateLeg(i, { pol: r.unlocode, polName: r.name })} />
                )}
                {leg.pol && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 5, cursor: "pointer" }}>
                    <input type="checkbox"
                      checked={!!leg.polLinkedAllowed}
                      onChange={e => updateLeg(i, { polLinkedAllowed: e.target.checked })}
                      style={{ width: 13, height: 13, accentColor: T.info, cursor: "pointer" }}
                    />
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>Allow linked POL</span>
                  </label>
                )}
              </div>

              <span style={{ textAlign: "center", color: T.textMuted, fontSize: 13, paddingTop: 8 }}>→</span>

              {/* POD */}
              <div>
                {leg.pod ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, background: T.surface,
                    border: `1px solid ${T.accent}55`, borderRadius: 6, padding: "6px 10px" }}>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{leg.pod}</span>
                    {leg.podName && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{leg.podName}</span>}
                    <button type="button" onClick={() => updateLeg(i, { pod: "", podName: "", podLinkedAllowed: false })}
                      style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 10, padding: 0, flexShrink: 0 }}>✕</button>
                  </div>
                ) : (
                  <PortCombobox placeholder="POD…" onChange={r => updateLeg(i, { pod: r.unlocode, podName: r.name })} />
                )}
                {leg.pod && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 5, cursor: "pointer" }}>
                    <input type="checkbox"
                      checked={!!leg.podLinkedAllowed}
                      onChange={e => updateLeg(i, { podLinkedAllowed: e.target.checked })}
                      style={{ width: 13, height: 13, accentColor: T.info, cursor: "pointer" }}
                    />
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>Allow linked POD</span>
                  </label>
                )}
              </div>

              {/* Remove */}
              <button type="button" onClick={() => removeLeg(i)}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
                  color: T.danger, cursor: "pointer", fontSize: 13, padding: "4px 8px",
                  display: "flex", alignItems: "center", justifyContent: "center", marginTop: 2 }}>
                ✕
              </button>
            </div>

            {/* Row 2: Transit days + Vessel service */}
            <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 8, marginTop: 8 }}>
              <input
                type="number" min={0} max={999}
                value={leg.transitDays}
                onChange={e => updateLeg(i, { transitDays: parseInt(e.target.value) || 0 })}
                placeholder="Days"
                title="Transit days"
                style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, textAlign: "center" }}
              />
              <input
                value={leg.vesselService}
                onChange={e => updateLeg(i, { vesselService: e.target.value })}
                placeholder="Vessel service (e.g. AEX-1)…"
                style={{ ...inputBase, fontFamily: T.mono, fontSize: 12 }}
              />
            </div>
          </div>
        ))}
        <div>
          <Btn variant="secondary" onClick={addLeg}>+ Add Leg</Btn>
        </div>
      </div>

      {/* ── Section 4: Container & DG ── */}
      <div style={sectionHeader()}>Container Types &amp; Dangerous Goods</div>

      <Field label="Container Types">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {CONTAINER_OPTIONS.map(ct => (
            <button key={ct} type="button" onClick={() => toggleContainer(ct)}
              style={chipStyle(f.containerTypes.includes(ct))}>
              {ct}
            </button>
          ))}
        </div>
      </Field>

      <div style={{ marginTop: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
          fontFamily: T.body, fontSize: 13, color: T.text }}>
          <input
            type="checkbox"
            checked={f.dgAllowed}
            onChange={e => setF(p => ({ ...p, dgAllowed: e.target.checked, imdgClasses: e.target.checked ? p.imdgClasses : [] }))}
            style={{ width: 16, height: 16, accentColor: T.accent, cursor: "pointer" }}
          />
          Dangerous Goods Accepted
        </label>
      </div>

      {f.dgAllowed && (
        <div style={{ marginTop: 10 }}>
          <Field label="IMDG Classes">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {IMDG_CLASSES.map(cls => (
                <button key={cls.code} type="button" onClick={() => toggleImdg(cls.code)}
                  title={cls.name}
                  style={chipStyle(f.imdgClasses.includes(cls.code))}>
                  {cls.code}
                </button>
              ))}
              <button type="button"
                onClick={() => setF(p => ({
                  ...p,
                  imdgClasses: p.imdgClasses.length === IMDG_CLASSES.length
                    ? []
                    : IMDG_CLASSES.map(c => c.code),
                }))}
                style={chipStyle(f.imdgClasses.length === IMDG_CLASSES.length)}>
                All
              </button>
            </div>
          </Field>
        </div>
      )}

      {/* ── Section 5: Rates ── */}
      <div style={sectionHeader()}>Rates</div>

      {f.rates.length > 0 && (
        <div style={{ background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`, overflow: "hidden", marginBottom: 8 }}>
          {/* Header */}
          <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 90px 80px 70px 70px 100px 1fr 32px",
            gap: 6, padding: "7px 10px", borderBottom: `1px solid ${T.border}`,
            fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".07em" }}>
            <span>Service</span>
            <span>Description</span>
            <span>Container</span>
            <span>Amount</span>
            <span>Currency</span>
            <span>≈ USD</span>
            <span>Unit</span>
            <span>Notes</span>
            <span></span>
          </div>
          {f.rates.map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "130px 1fr 90px 80px 70px 70px 100px 1fr 32px",
              gap: 6, padding: "6px 10px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
              {/* Service code */}
              <select value={r.serviceCode} onChange={e => updateRate(i, { serviceCode: e.target.value })}
                style={{ ...inputBase, fontFamily: T.mono, fontSize: 11, padding: "5px 6px" }}>
                {SERVICE_CODES.map(s => <option key={s.code} value={s.code}>{s.code} – {s.label}</option>)}
              </select>
              {/* Description */}
              <input value={r.description} onChange={e => updateRate(i, { description: e.target.value })}
                placeholder="Description…"
                style={{ ...inputBase, fontFamily: T.body, fontSize: 12, padding: "5px 8px" }} />
              {/* Container type */}
              <select value={r.containerType} onChange={e => updateRate(i, { containerType: e.target.value })}
                style={{ ...inputBase, fontFamily: T.mono, fontSize: 11, padding: "5px 6px" }}>
                <option value="">All</option>
                {CONTAINER_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {/* Amount */}
              <input type="number" min={0} step="0.01"
                value={r.amount}
                onChange={e => updateRate(i, { amount: parseFloat(e.target.value) || 0 })}
                style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, padding: "5px 8px", textAlign: "right" }} />
              {/* Currency */}
              <select value={r.currency} onChange={e => updateRate(i, { currency: e.target.value })}
                style={{ ...inputBase, fontFamily: T.mono, fontSize: 11, padding: "5px 6px" }}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {/* ≈ USD (read-only) */}
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, textAlign: "right",
                padding: "5px 8px", background: T.surface, borderRadius: 4, border: `1px solid ${T.border}55` }}>
                {r.amountUsd != null ? r.amountUsd.toFixed(2) : "—"}
              </div>
              {/* Unit */}
              <select value={r.unit} onChange={e => updateRate(i, { unit: e.target.value })}
                style={{ ...inputBase, fontFamily: T.mono, fontSize: 11, padding: "5px 6px" }}>
                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
              {/* Notes */}
              <input value={r.notes} onChange={e => updateRate(i, { notes: e.target.value })}
                placeholder="Notes…"
                style={{ ...inputBase, fontFamily: T.body, fontSize: 12, padding: "5px 8px" }} />
              {/* Remove */}
              <button type="button" onClick={() => removeRate(i)}
                style={{ background: "none", border: "none", cursor: "pointer",
                  color: T.danger, fontSize: 13, padding: "4px", display: "flex",
                  alignItems: "center", justifyContent: "center" }}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div>
        <Btn variant="secondary" onClick={addRate}>+ Add Rate</Btn>
      </div>

      {/* ── Section 6: Notes ── */}
      <div style={sectionHeader()}>Notes</div>
      <textarea
        value={f.notes}
        onChange={e => setF(p => ({ ...p, notes: e.target.value }))}
        placeholder="Internal remarks, special terms, contact info…"
        rows={4}
        style={{ ...inputBase, fontFamily: T.body, fontSize: 14, resize: "vertical" }}
      />

      {/* Footer */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 16 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : (editing ? "Save Changes" : "Create Contract")}
        </Btn>
      </div>
    </div>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

const MdmContractsPage = () => {
  const [results, setResults] = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [modal,           setModal]           = useState(null);
  const [historyContract, setHistoryContract] = useState(null);
  const timer = useRef(null);

  const doLoad = useCallback(async (f, off) => {
    setLoading(true);
    try {
      const res = await api.contracts.search({
        search:        f.search,
        carrier:       f.carrier,
        status:        f.status,
        dg:            f.dg,
        asOf:          f.asOf,
        containerType: f.containerType,
        limit:         LIMIT,
        offset:        off,
      });
      setResults(res.results || []);
      setTotal(res.total || 0);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { doLoad(EMPTY_FILTERS, 0); }, []);

  const handleSearch = () => { setOffset(0); doLoad(filters, 0); };
  const handleClear  = () => { setFilters(EMPTY_FILTERS); setOffset(0); doLoad(EMPTY_FILTERS, 0); };
  const goPage = off => { setOffset(off); doLoad(filters, off); };

  const handleSaved = () => { setModal(null); doLoad(filters, offset); };

  const handleDelete = async id => {
    if (!window.confirm("Delete this contract? This cannot be undone.")) return;
    try {
      await api.contracts.remove(id);
      toast.success("Contract deleted");
      doLoad(filters, offset);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const handleSearchChange = (key, val) => {
    const next = { ...filters, [key]: val };
    setFilters(next);
    clearTimeout(timer.current);
    if (key === "search") {
      timer.current = setTimeout(() => { setOffset(0); doLoad(next, 0); }, 300);
    }
  };

  const hasFilters = Object.values(filters).some(v => v !== "");

  // Column resizer
  const { template, startResize } = useResizableColumns("mdm-contracts", [120,100,120,180,140,50,100,100,90,80]);
  const headers = ["Contract #","Carrier","Named Account","Route","Containers","DG","Valid From","Valid To","Status",""];

  const th = {
    position: "relative", fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>
            Contracts
          </h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total} contract{total !== 1 ? "s" : ""}
            {hasFilters ? " matching filters" : " in registry"}
          </p>
        </div>
        <Btn size="lg" onClick={() => setModal("new")}>＋ New Contract</Btn>
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={filters.search}
          onChange={e => handleSearchChange("search", e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") handleSearch(); }}
          placeholder="Search contract #, carrier, account, route…"
          style={{ ...inputBase, flex: "1 1 220px", minWidth: 180 }}
        />
        <input
          value={filters.carrier}
          onChange={e => handleSearchChange("carrier", e.target.value.toUpperCase())}
          placeholder="Carrier"
          style={{ ...inputBase, width: 90, fontFamily: T.mono }}
        />
        <select value={filters.status} onChange={e => handleSearchChange("status", e.target.value)}
          style={{ ...inputBase, width: 120, cursor: "pointer" }}>
          <option value="">All Statuses</option>
          {CONTRACT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filters.dg} onChange={e => handleSearchChange("dg", e.target.value)}
          style={{ ...inputBase, width: 110, cursor: "pointer" }}>
          <option value="">DG: All</option>
          <option value="1">DG Allowed</option>
          <option value="0">No DG</option>
        </select>
        <input
          type="date"
          value={filters.asOf}
          onChange={e => handleSearchChange("asOf", e.target.value)}
          title="Active as of date"
          style={{ ...inputBase, width: 140, fontFamily: T.mono, fontSize: 12 }}
        />
        <select value={filters.containerType} onChange={e => handleSearchChange("containerType", e.target.value)}
          style={{ ...inputBase, width: 90, cursor: "pointer", fontFamily: T.mono }}>
          <option value="">All Types</option>
          {CONTAINER_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <Btn onClick={handleSearch}>Search</Btn>
        {hasFilters && <Btn variant="secondary" onClick={handleClear}>Clear</Btn>}
      </div>

      {/* Table */}
      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: template,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}`, gap: 0 }}>
          {headers.map((h, i) => (
            <div key={i} style={th}>
              {h}
              {i < headers.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
            </div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 48 }}><PageSpinner /></div>
        ) : results.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted,
            fontFamily: T.body, fontSize: 14, fontStyle: "italic" }}>
            {hasFilters ? "No contracts match your filters." : "No contracts yet. Create your first one above."}
          </div>
        ) : results.map(c => {
          const legs = c.legs || [];
          const ctypes = c.containerTypes || [];
          const shown = ctypes.slice(0, 3);
          const more  = ctypes.length - shown.length;
          return (
            <div key={c.id}
              style={{ display: "grid", gridTemplateColumns: template,
                padding: "13px 20px", borderBottom: `1px solid ${T.border}22`,
                alignItems: "center", gap: 0 }}>

              {/* Contract # */}
              <div>
                <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>
                  {c.contractNumber || "—"}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, marginTop: 2 }}>
                  {c.id}
                </div>
              </div>

              {/* Carrier */}
              <div>
                <Badge variant="info">{c.carrierCode || "—"}</Badge>
              </div>

              {/* Named Account */}
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.text,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.namedAccount || <span style={{ color: T.border }}>—</span>}
              </div>

              {/* Route */}
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>
                {routeSummary(legs)}
              </div>

              {/* Container types */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {shown.map(ct => (
                  <span key={ct} style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                    color: T.textMuted, background: T.bg, border: `1px solid ${T.border}`,
                    borderRadius: 4, padding: "1px 5px" }}>
                    {ct}
                  </span>
                ))}
                {more > 0 && (
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>+{more}</span>
                )}
                {ctypes.length === 0 && <span style={{ color: T.border }}>—</span>}
              </div>

              {/* DG */}
              <div>
                {c.dgAllowed
                  ? <Badge variant="success">DG</Badge>
                  : <span style={{ color: T.border }}>—</span>}
              </div>

              {/* Valid From */}
              <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>
                {c.validFrom || <span style={{ color: T.border }}>—</span>}
              </div>

              {/* Valid To */}
              <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>
                {c.validTo || <span style={{ color: T.border }}>—</span>}
              </div>

              {/* Status */}
              <div>
                <Badge variant={contractStatusVariant(c.status)}>{c.status}</Badge>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <ActionMenu items={[
                  { icon: "✎",  label: "Edit",    onClick: () => setModal(c) },
                  { icon: "📋", label: "History",  onClick: () => setHistoryContract(c) },
                  { icon: "✕",  label: "Delete",  variant: "danger", onClick: () => handleDelete(c.id) },
                ]} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {total > LIMIT && (
        <div style={{ marginTop: 16 }}>
          <Pagination total={total} limit={LIMIT} offset={offset} onPage={goPage} />
        </div>
      )}

      {/* Contract modal */}
      {modal && (
        <Modal
          title={modal === "new" ? "New Contract" : `Edit — ${modal.contractNumber}`}
          onClose={() => setModal(null)}
          width={820}
        >
          <ContractModal
            editing={modal === "new" ? null : modal}
            onSave={handleSaved}
            onClose={() => setModal(null)}
          />
        </Modal>
      )}

      {/* History modal */}
      {historyContract && (
        <EntityHistoryModal
          entityType="contract"
          entityId={historyContract.id}
          title={`History — ${historyContract.contractNumber}`}
          headerContent={
            <>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{historyContract.contractNumber}</span>
              {historyContract.carrierCode && <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{historyContract.carrierCode}</span>}
              {historyContract.validFrom && (
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
                  {historyContract.validFrom} – {historyContract.validTo}
                </span>
              )}
            </>
          }
          onClose={() => setHistoryContract(null)} />
      )}
    </div>
  );
};

export default MdmContractsPage;
