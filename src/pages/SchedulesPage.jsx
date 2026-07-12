import { useState, useCallback, useMemo, useEffect } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Spinner from "../components/primitives/Spinner";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import Pagination from "../components/primitives/Pagination";
import { inputBase } from "../components/primitives/Form";
import PortCombobox from "../components/shared/PortCombobox";
import { Modal } from "../components/primitives/Modal";

// ─── Constants ────────────────────────────────────────────────────────────────

const LIMIT = 25;

const CONTRACT_STATUSES = ["Active", "Draft", "Expired", "On Hold"];

// CY and Door share the same pol/pod_carrier_haulage flag at DB level.
// A future contract_legs.pol_loc_type column would allow exact CY vs Door filtering.
const ROUTING_TERMS = [
  { value: "P2P",   label: "PT–PT",  polOriginLabel: "Via Origin",      podDestLabel: "Via Destination"  },
  { value: "D2P",   label: "DR–PT",  polOriginLabel: "Door Origin",     podDestLabel: "Via Destination"  },
  { value: "CY2P",  label: "CY–PT",  polOriginLabel: "CY Origin",       podDestLabel: "Via Destination"  },
  { value: "P2D",   label: "PT–DR",  polOriginLabel: "Via Origin",      podDestLabel: "Door Destination" },
  { value: "P2CY",  label: "PT–CY",  polOriginLabel: "Via Origin",      podDestLabel: "CY Destination"   },
  { value: "D2D",   label: "DR–DR",  polOriginLabel: "Door Origin",     podDestLabel: "Door Destination" },
  { value: "D2CY",  label: "DR–CY",  polOriginLabel: "Door Origin",     podDestLabel: "CY Destination"   },
  { value: "CY2D",  label: "CY–DR",  polOriginLabel: "CY Origin",       podDestLabel: "Door Destination" },
  { value: "CY2CY", label: "CY–CY",  polOriginLabel: "CY Origin",       podDestLabel: "CY Destination"   },
];

const DEFAULT_TERM = { polOriginLabel: "Via Origin", podDestLabel: "Via Destination" };

const EMPTY_FILTERS = {
  contractNumber: "",
  carrier: [],
  namedAccount: "",
  pol: null,
  polOrigin: null,
  podDestination: null,
  pod: null,
  asOf: "",
  status: "Active",
  routingTerm: "P2P",
};

// Schedule query uses the sea leg POL and POD — not the barge/haulage leg endpoints.
// When a search POL/POD query is available, prefer the leg that matches it.
function deriveSeaLeg(legs, polQuery, podQuery) {
  if (!legs || legs.length === 0) return null;
  if (polQuery || podQuery) {
    const match = legs.find(l =>
      (!polQuery || l.pol === polQuery) &&
      (!podQuery || l.pod === podQuery)
    );
    if (match) return match;
  }
  return legs.find(l => !l.polCarrierHaulage) || legs[0];
}

const hasHaulage = legs => legs?.some(l => l.polCarrierHaulage || l.podCarrierHaulage);

// ─── Rate compute helpers ─────────────────────────────────────────────────────

function buildChargeMap(rates) {
  const perCtr = (rates || []).filter(r => !r.unit || r.unit === "per_container");
  const map = {};
  for (const r of perCtr) {
    const key = r.serviceCode || r.description || r.id;
    if (!map[key]) map[key] = { rateByType: {} };
    if (r.containerType) map[key].rateByType[r.containerType] = r;
    else if (!map[key].rateByType["*"]) map[key].rateByType["*"] = r;
  }
  return map;
}

function computeRateTotal(rates, containers) {
  if (!containers?.length || !rates?.length) return 0;
  const chargeMap = buildChargeMap(rates);
  let total = 0;
  for (const { type, qty } of containers) {
    for (const charge of Object.values(chargeMap)) {
      const entry = charge.rateByType[type] || charge.rateByType["*"];
      if (entry) total += (entry.amountUsd || 0) * qty;
    }
  }
  return Math.round(total * 100) / 100;
}

function computeRateByType(rates, containers) {
  if (!containers?.length || !rates?.length) return [];
  const chargeMap = buildChargeMap(rates);
  return containers.map(({ type, qty }) => {
    let amt = 0;
    for (const charge of Object.values(chargeMap)) {
      const entry = charge.rateByType[type] || charge.rateByType["*"];
      if (entry) amt += (entry.amountUsd || 0) * qty;
    }
    return { type, qty, amount: Math.round(amt * 100) / 100 };
  }).filter(x => x.amount > 0);
}

const CONTAINER_TYPES = ["20GP","40GP","40HC","45HC","20RF","40RF","20OT","40OT","20FR","40FR"];

const fmtUsd = n => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── Container picker modal ───────────────────────────────────────────────────

const ContainerPickerModal = ({ selection, onSave, onClose }) => {
  const [local, setLocal] = useState(
    () => Object.fromEntries(CONTAINER_TYPES.map(t => [t, selection.find(s => s.type === t)?.qty || 0]))
  );

  const adj = (type, delta) => setLocal(p => ({ ...p, [type]: Math.max(0, (p[type] || 0) + delta) }));

  const active = CONTAINER_TYPES.filter(t => local[t] > 0);

  const handleSave = () => {
    onSave(CONTAINER_TYPES.filter(t => local[t] > 0).map(t => ({ type: t, qty: local[t] })));
    onClose();
  };

  const btnStyle = { width: 26, height: 26, border: `1px solid ${T.border}`, borderRadius: 5,
    background: T.surface, color: T.text, cursor: "pointer",
    fontWeight: 700, fontSize: 15, lineHeight: 1, display: "flex",
    alignItems: "center", justifyContent: "center" };

  return (
    <Modal title="Container Mix" onClose={onClose} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          Select container types and quantities for rate estimation.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
          {CONTAINER_TYPES.map(type => {
            const qty = local[type] || 0;
            const on = qty > 0;
            return (
              <div key={type} style={{ display: "flex", alignItems: "center", gap: 8,
                padding: "8px 12px", borderRadius: 8,
                background: on ? T.accentBg : T.bg,
                border: `1px solid ${on ? T.accent + "55" : T.border}` }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                  color: on ? T.accent : T.textMuted, flex: 1 }}>{type}</span>
                <button style={btnStyle} onClick={() => adj(type, -1)}>−</button>
                <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                  color: T.text, minWidth: 18, textAlign: "center" }}>{qty}</span>
                <button style={btnStyle} onClick={() => adj(type, 1)}>+</button>
              </div>
            );
          })}
        </div>
        {active.length > 0 && (
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
            padding: "8px 12px", background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: 6 }}>
            {active.map(t => `${local[t]}×${t}`).join("  ")}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handleSave}>Apply</Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Rate estimate ────────────────────────────────────────────────────────────

const RateEstimate = ({ containers, rates }) => {
  if (!containers.length || !rates.length) return null;

  const perCtr = rates.filter(r => !r.unit || r.unit === "per_container");

  // Group rates by charge (serviceCode or description)
  const chargeMap = {};
  for (const r of perCtr) {
    const key = r.serviceCode || r.description || "Other";
    if (!chargeMap[key]) chargeMap[key] = { label: r.description || r.serviceCode || "Other", rateByType: {} };
    if (r.containerType) chargeMap[key].rateByType[r.containerType] = r;
    else if (!chargeMap[key].rateByType["*"]) chargeMap[key].rateByType["*"] = r; // fallback for any type
  }

  let grandTotal = 0;
  const chargeItems = Object.entries(chargeMap).map(([key, charge]) => {
    const lines = [];
    let subtotal = 0;
    for (const { type, qty } of containers) {
      const entry = charge.rateByType[type] || charge.rateByType["*"] || null;
      if (entry) {
        const lineTotal = Math.round((entry.amountUsd || 0) * qty * 100) / 100;
        subtotal += lineTotal;
        lines.push({ type, qty, entry, lineTotal });
      }
    }
    grandTotal += subtotal;
    return { key, label: charge.label, lines, subtotal };
  }).filter(c => c.lines.length > 0);

  if (!chargeItems.length) return (
    <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic",
      padding: "10px 14px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8 }}>
      No per-container rates on this contract for the selected container types.
    </div>
  );

  return (
    <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: `1px solid ${T.border}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
        background: T.surface }}>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.textMuted,
          textTransform: "uppercase", letterSpacing: ".1em" }}>Buy Rate Estimate</span>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
          {containers.map(c => `${c.qty}×${c.type}`).join(" + ")}
        </span>
      </div>
      <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        {chargeItems.map(charge => (
          <div key={charge.key}>
            <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 5 }}>
              {charge.label}
            </div>
            {charge.lines.map((line, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6,
                padding: "3px 0", fontFamily: T.mono, fontSize: 11 }}>
                <span style={{ color: T.textMuted, minWidth: 18 }}>{line.qty}×</span>
                <span style={{ color: T.accent, minWidth: 38, fontWeight: 700 }}>{line.type}</span>
                <span style={{ color: T.border }}>@</span>
                <span style={{ color: T.text }}>{fmtUsd(line.entry.amountUsd)}
                  {line.entry.currency !== "USD" && (
                    <span style={{ color: T.textMuted, fontSize: 10 }}> ({line.entry.currency})</span>
                  )}
                </span>
                <span style={{ color: T.textMuted, marginLeft: "auto" }}>=</span>
                <span style={{ color: T.text, fontWeight: 600, minWidth: 80, textAlign: "right" }}>
                  {fmtUsd(line.lineTotal)}
                </span>
              </div>
            ))}
            {charge.lines.length > 1 && (
              <div style={{ textAlign: "right", fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                color: T.text, borderTop: `1px solid ${T.border}22`, paddingTop: 3, marginTop: 3 }}>
                Subtotal: {fmtUsd(charge.subtotal)}
              </div>
            )}
          </div>
        ))}
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10, marginTop: 2,
          display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.text,
            textTransform: "uppercase", letterSpacing: ".06em" }}>Total BUY</span>
          <span style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 800, color: T.warning }}>
            {fmtUsd(grandTotal)}
          </span>
        </div>
      </div>
    </div>
  );
};

// ─── Carrier multi-tag input ─────────────────────────────────────────────────

const CarrierMultiInput = ({ value, onChange, onKeyDown }) => {
  const [inputVal,  setInputVal]  = useState("");
  const [open,      setOpen]      = useState(false);
  const [carriers,  setCarriers]  = useState([]);
  const [loaded,    setLoaded]    = useState(false);

  useEffect(() => {
    if (loaded) return;
    api.carriers.list()
      .then(cs => { setCarriers(cs || []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [loaded]);

  const filtered = inputVal
    ? carriers.filter(c =>
        !value.includes(c.code) && (
          c.code?.toUpperCase().startsWith(inputVal.toUpperCase()) ||
          c.name?.toLowerCase().includes(inputVal.toLowerCase())
        )
      ).slice(0, 8)
    : [];

  const add = code => {
    if (!value.includes(code)) onChange([...value, code]);
    setInputVal(""); setOpen(false);
  };

  const remove = code => onChange(value.filter(c => c !== code));

  const handleKeyDown = e => {
    if (e.key === "Enter" && inputVal) {
      const match = carriers.find(c => c.code.toUpperCase() === inputVal.toUpperCase());
      if (match) add(match.code);
      else if (inputVal.length === 4) add(inputVal);
      e.preventDefault(); return;
    }
    if (e.key === "Backspace" && !inputVal && value.length > 0) { remove(value.at(-1)); return; }
    onKeyDown?.(e);
  };

  return (
    <div style={{ ...inputBase, width: "100%", height: "auto", minHeight: 34,
      display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center",
      padding: "4px 8px", position: "relative", cursor: "text" }}>
      {value.map(code => (
        <span key={code} style={{ display: "inline-flex", alignItems: "center", gap: 3,
          background: T.accentBg, border: `1px solid ${T.accent}44`,
          borderRadius: 4, padding: "1px 4px 1px 7px",
          fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>
          {code}
          <span onMouseDown={e => { e.preventDefault(); remove(code); }}
            style={{ cursor: "pointer", color: T.textMuted, fontSize: 14, lineHeight: 1,
              paddingLeft: 2 }}>×</span>
        </span>
      ))}
      <input
        value={inputVal}
        onChange={e => { const v = e.target.value.replace(/[^A-Za-z]/g,"").toUpperCase().slice(0,4);
          setInputVal(v); setOpen(v.length > 0); }}
        onKeyDown={handleKeyDown}
        onFocus={() => inputVal && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={value.length === 0 ? "CMDU" : ""}
        style={{ border: "none", outline: "none", background: "transparent",
          fontFamily: T.mono, fontSize: 12, letterSpacing: ".05em",
          color: T.text, minWidth: 48, flex: 1, padding: 0 }}
      />
      {open && filtered.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 200,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6,
          marginTop: 2, overflow: "hidden", boxShadow: "0 4px 14px rgba(0,0,0,.14)" }}>
          {filtered.map(c => (
            <div key={c.code} onMouseDown={() => add(c.code)}
              style={{ padding: "8px 12px", cursor: "pointer",
                display: "flex", alignItems: "center", gap: 10,
                borderBottom: `1px solid ${T.border}22` }}>
              <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                color: T.accent, minWidth: 40 }}>{c.code}</span>
              {c.name && (
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                  {c.name}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Customer typeahead ───────────────────────────────────────────────────────

const CustomerCombobox = ({ value, onChange, onKeyDown }) => {
  const [open,        setOpen]        = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    if (!value || value.length < 2) { setSuggestions([]); setOpen(false); return; }
    const t = setTimeout(() => {
      api.customers.list({ search: value, limit: 8 })
        .then(r => {
          const names = (r.results || []).map(c => c.companyName).filter(Boolean);
          setSuggestions(names); setOpen(names.length > 0);
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <div style={{ position: "relative" }}>
      <input
        value={value}
        onChange={e => onChange(e.target.value.replace(/[^\w\s\-.,&'/()]/g, "").slice(0, 80))}
        onKeyDown={onKeyDown}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Customer name or ID"
        style={{ ...inputBase, width: "100%" }}
        maxLength={80}
      />
      {open && suggestions.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 200,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6,
          marginTop: 2, overflow: "hidden", boxShadow: "0 4px 14px rgba(0,0,0,.14)" }}>
          {suggestions.map((name, i) => (
            <div key={i} onMouseDown={() => { onChange(name); setOpen(false); }}
              style={{ padding: "8px 12px", cursor: "pointer",
                fontFamily: T.body, fontSize: 12, color: T.text,
                borderBottom: `1px solid ${T.border}22` }}>
              {name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Search form ──────────────────────────────────────────────────────────────

const SearchForm = ({ onSearch, loading }) => {
  const [f,          setF]          = useState(EMPTY_FILTERS);
  const [containers, setContainers] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const set = (key, val) => setF(p => ({ ...p, [key]: val }));

  const hasFilters = f.contractNumber.trim() || f.carrier.length > 0 || f.namedAccount.trim() ||
    f.pol || f.polOrigin || f.podDestination || f.pod ||
    f.asOf || f.status !== "Active" || f.routingTerm !== "P2P";

  const canSearch = !!f.pol && !!f.pod && !!f.asOf;

  const handleSearch = () => {
    onSearch({
      search:         f.contractNumber.trim(),
      carrier:        f.carrier.join(","),
      namedAccount:   f.namedAccount.trim(),
      pol:            f.pol?.unlocode           || "",
      polOrigin:      f.polOrigin?.unlocode     || "",
      podDestination: f.podDestination?.unlocode || "",
      pod:            f.pod?.unlocode           || "",
      asOf:           f.asOf,
      status:         f.status,
      routingTerm:    f.routingTerm,
      containers,
    });
  };

  const handleClear = () => { setF(EMPTY_FILTERS); setContainers([]); onSearch(null); };
  const handleKey   = e => { if (e.key === "Enter") handleSearch(); };

  // When switching routing term, clear fields that the new term doesn't use
  const handleTermChange = (term) => {
    const polHasOrigin = ["D2P","CY2P","D2D","D2CY","CY2D","CY2CY"].includes(term);
    const podHasDest   = ["P2D","P2CY","D2D","D2CY","CY2D","CY2CY"].includes(term);
    setF(p => ({
      ...p,
      routingTerm:    term,
      polOrigin:      (term && !polHasOrigin) ? null : p.polOrigin,
      podDestination: (term && !podHasDest)   ? null : p.podDestination,
    }));
  };

  const lbl = txt => (
    <div style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted,
      textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>{txt}</div>
  );

  const sep = (
    <span style={{ color: T.border, fontSize: 16, flexShrink: 0, alignSelf: "flex-end",
      paddingBottom: 9, userSelect: "none" }}>›</span>
  );

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: 10, padding: "18px 20px", marginBottom: 20 }}>

      {/* Row 1: Contract #, Carrier, Named Account */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div>
          {lbl("Contract #")}
          <input value={f.contractNumber} onChange={e => set("contractNumber", e.target.value)}
            onKeyDown={handleKey} placeholder="SC-CMDU-2025-001"
            style={{ ...inputBase, width: "100%", fontFamily: T.mono }} />
        </div>
        <div>
          {lbl("Carrier Code")}
          <CarrierMultiInput
            value={f.carrier}
            onChange={v => set("carrier", v)}
            onKeyDown={handleKey}
          />
        </div>
        <div>
          {lbl("Named Account")}
          <CustomerCombobox
            value={f.namedAccount}
            onChange={v => set("namedAccount", v)}
            onKeyDown={handleKey}
          />
        </div>
      </div>

      {/* Row 2: Routing Term › location slots in journey order */}
      {(() => {
        const term         = f.routingTerm;
        const termDef      = ROUTING_TERMS.find(r => r.value === term);
        const anyTerm      = !term;
        const showOrigin   = anyTerm || ["D2P","CY2P","D2D","D2CY","CY2D","CY2CY"].includes(term);
        const showDest     = anyTerm || ["P2D","P2CY","D2D","D2CY","CY2D","CY2CY"].includes(term);
        const originLabel  = termDef?.polOriginLabel || "Pre-carriage Origin";
        const destLabel    = termDef?.podDestLabel   || "On-carriage Destination";

        // Build slots left-to-right in actual journey order
        const slots = [];
        if (showOrigin) slots.push(
          <div key="origin" style={{ flex: 1, minWidth: 0 }}>
            {lbl(originLabel)}
            <PortCombobox value={f.polOrigin} onChange={v => set("polOrigin", v)}
              placeholder="Pickup location…" />
          </div>
        );
        slots.push(
          <div key="pol" style={{ flex: 1, minWidth: 0 }}>
            {lbl("POL")}
            <PortCombobox value={f.pol} onChange={v => set("pol", v)}
              placeholder="Port of Loading" />
          </div>
        );
        slots.push(
          <div key="pod" style={{ flex: 1, minWidth: 0 }}>
            {lbl("POD")}
            <PortCombobox value={f.pod} onChange={v => set("pod", v)}
              placeholder="Port of Discharge" />
          </div>
        );
        if (showDest) slots.push(
          <div key="dest" style={{ flex: 1, minWidth: 0 }}>
            {lbl(destLabel)}
            <PortCombobox value={f.podDestination} onChange={v => set("podDestination", v)}
              placeholder="Delivery location…" />
          </div>
        );

        // Interleave separators
        const row = [];
        slots.forEach((slot, i) => {
          row.push(slot);
          if (i < slots.length - 1) row.push(<span key={`sep${i}`} style={{ color: T.border, fontSize: 16, flexShrink: 0, alignSelf: "flex-end", paddingBottom: 9, userSelect: "none" }}>›</span>);
        });

        return (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>

              {/* Routing Term selector */}
              <div style={{ flexShrink: 0, width: 148 }}>
                {lbl("Routing Term")}
                <select value={f.routingTerm} onChange={e => handleTermChange(e.target.value)}
                  style={{ ...inputBase, width: "100%", cursor: "pointer" }}>
                  <option value="">Any Term</option>
                  {ROUTING_TERMS.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>

              {sep}

              {row}

              {/* Containers — last element of this row */}
              <div style={{ flexShrink: 0 }}>
                {lbl("Containers")}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button type="button" onClick={() => setPickerOpen(true)}
                    style={{ fontFamily: T.body, fontSize: 13,
                      color: containers.length > 0 ? T.accent : T.textMuted,
                      background: T.bg,
                      border: `1px solid ${containers.length > 0 ? T.accent + "55" : T.border}`,
                      borderRadius: 8, padding: "7px 14px", cursor: "pointer", textAlign: "left",
                      minWidth: 160 }}>
                    {containers.length > 0
                      ? containers.map(c => `${c.qty}×${c.type}`).join(" + ")
                      : "Containers…"}
                  </button>
                  {containers.length > 0 && (
                    <button type="button" onClick={() => setContainers([])}
                      style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted,
                        background: "none", border: "none", cursor: "pointer", padding: "4px 0" }}>
                      ✕
                    </button>
                  )}
                </div>
              </div>

            </div>
          </div>
        );
      })()}

      {/* Row 3: Valid as of + Status */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div>
          {lbl("Valid as of")}
          <input type="date" value={f.asOf} onChange={e => set("asOf", e.target.value)}
            style={{ ...inputBase, width: "100%", fontFamily: T.mono, fontSize: 12 }} />
        </div>
        <div>
          {lbl("Status")}
          <select value={f.status} onChange={e => set("status", e.target.value)}
            style={{ ...inputBase, width: "100%", cursor: "pointer" }}>
            <option value="">All Statuses</option>
            {CONTRACT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {pickerOpen && (
        <ContainerPickerModal
          selection={containers}
          onSave={setContainers}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* Actions */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
        {!canSearch && (
          <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
            POL, POD and Valid as of are required
          </span>
        )}
        {hasFilters && (
          <Btn variant="secondary" onClick={handleClear} disabled={loading}>Clear</Btn>
        )}
        <Btn onClick={handleSearch} disabled={loading || !canSearch}>
          {loading ? (
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <Spinner size="sm" color="currentColor" /> Searching…
            </span>
          ) : "Search Contracts →"}
        </Btn>
      </div>
    </div>
  );
};

// ─── Contract row (full-width line format) ────────────────────────────────────

const getCols = (showRate) => [
  { key: "num",     label: "Contract #",    w: 185, pl: 14 },
  { key: "carrier", label: "Carrier",       w: 92,  pl: 8  },
  { key: "account", label: "Named Account", w: null, pl: 8  },  // flex
  { key: "route",   label: "Route",         w: 215, pl: 8  },
  { key: "valid",   label: "Validity",      w: 200, pl: 8  },
  { key: "status",  label: "Status",        w: 78,  pl: 8  },
  ...(showRate ? [{ key: "rate", label: "Buy Rate (USD)", w: 170, pl: 8 }] : []),
  { key: "action",  label: "",              w: 116, pl: 4  },
];

const TableHeader = ({ showRate = false }) => (
  <div style={{ display: "flex", alignItems: "center",
    background: T.bg, borderBottom: `1px solid ${T.border}` }}>
    {getCols(showRate).map(col => (
      <div key={col.key} style={{
        width:     col.w || undefined,
        flex:      col.w ? undefined : 1,
        minWidth:  col.w ? undefined : 0,
        flexShrink: col.w ? 0 : undefined,
        padding:   `8px 8px 8px ${col.pl}px`,
        fontFamily: T.body, fontSize: 10, fontWeight: 600,
        color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em",
        userSelect: "none",
      }}>
        {col.label}
      </div>
    ))}
  </div>
);

// ─── Group header row (same column layout as ContractRow, acts as parent) ─────

const GroupHeaderRow = ({ group, isExpanded, onToggle, polQuery, podQuery, containers = [], groupMinRate = 0 }) => {
  const [hovered, setHovered] = useState(false);
  const first    = group.contracts[0];
  const seaLeg   = deriveSeaLeg(first.legs || [], polQuery, podQuery);
  const validFrom = group.contracts.map(c => c.validFrom).filter(Boolean).sort()[0]      || "";
  const validTo   = group.contracts.map(c => c.validTo  ).filter(Boolean).sort().at(-1)  || "";
  const status    = group.contracts.some(c => c.status === "Active") ? "Active" : first.status;
  const showRate  = containers.length > 0;

  return (
    <div
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center",
        background: hovered ? T.surfaceHover : T.bg,
        borderLeft: `3px solid ${isExpanded ? T.accent + "66" : "transparent"}`,
        borderBottom: `1px solid ${T.border}`,
        cursor: "pointer", transition: "background .1s", userSelect: "none",
      }}
    >
      <div style={{ width: 185, flexShrink: 0, padding: "10px 8px 10px 14px" }}>
        <div style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 700, color: T.text,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {group.key}
        </div>
      </div>
      <div style={{ width: 92, flexShrink: 0, padding: "10px 8px",
        display: "flex", alignItems: "center", gap: 5 }}>
        <Badge variant="info">{first.carrierCode}</Badge>
        {hasHaulage(first.legs) && (
          <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700,
            color: T.textMuted, background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: 3, padding: "0 4px" }}>CH</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, padding: "10px 8px" }}>
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
          {group.contracts.length} contracts
        </span>
      </div>
      <div style={{ width: 215, flexShrink: 0, padding: "10px 8px" }}>
        {seaLeg ? (
          <span style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 700, color: T.text }}>
            {seaLeg.pol} › {seaLeg.pod}
          </span>
        ) : (
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>
        )}
      </div>
      <div style={{ width: 200, flexShrink: 0, padding: "10px 8px" }}>
        {validFrom && (
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
            fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
            {validFrom} – {validTo}
          </span>
        )}
      </div>
      <div style={{ width: 78, flexShrink: 0, padding: "10px 8px" }}>
        <Badge variant={status === "Active" ? "success" : status === "Expired" ? "danger" : "warning"}>
          {status}
        </Badge>
      </div>
      {showRate && (
        <div style={{ width: 170, flexShrink: 0, padding: "10px 8px" }}>
          {groupMinRate > 0 ? (
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, fontStyle: "italic" }}>
              from {fmtUsd(groupMinRate)}
            </span>
          ) : (
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>
          )}
        </div>
      )}
      <div style={{ width: 116, flexShrink: 0, padding: "8px 14px 8px 4px",
        display: "flex", justifyContent: "flex-end" }}>
        <Btn variant="secondary" onClick={e => { e.stopPropagation(); onToggle(); }}>
          {isExpanded ? "▲" : "▶"} {group.contracts.length}
        </Btn>
      </div>
    </div>
  );
};

// ─── Contract row (full-width line format) ────────────────────────────────────

const CHILD_BG     = "rgba(139,92,246,.05)";
const CHILD_BORDER = "rgba(139,92,246,.35)";

const ContractRow = ({ contract, selected, onSelect, inGroup, isChild, polQuery, podQuery, containers = [], rateTotal = 0, isBest = false }) => {
  const [hovered, setHovered] = useState(false);
  const isActive  = selected?.id === contract.id;
  const seaLeg    = deriveSeaLeg(contract.legs || [], polQuery, podQuery);
  const multiLeg  = (contract.legs?.length || 0) > 1;
  const showRate  = containers.length > 0;
  const rateSubs  = showRate ? computeRateByType(contract.rates || [], containers) : [];

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center",
        background: isActive ? T.accentBg : hovered ? T.surfaceHover : isChild ? CHILD_BG : "transparent",
        borderLeft: `3px solid ${isActive ? T.accent : isChild ? CHILD_BORDER : "transparent"}`,
        borderBottom: `1px solid ${T.border}22`,
        cursor: "pointer", transition: "background .1s",
      }}
    >
      {/* Contract # */}
      <div style={{ width: 185, flexShrink: 0, padding: "10px 8px 10px 14px" }}>
        <div style={{
          fontFamily: T.mono, fontSize: 12.5, fontWeight: 700,
          color: isActive ? T.accent : T.text,
          opacity: inGroup ? .55 : 1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {contract.contractNumber}
        </div>
        {contract.contractRef && (
          <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>
            {contract.contractRef}
          </div>
        )}
      </div>

      {/* Carrier + CH badge */}
      <div style={{ width: 92, flexShrink: 0, padding: "10px 8px",
        display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
        <Badge variant="info">{contract.carrierCode}</Badge>
        {hasHaulage(contract.legs) && (
          <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700,
            color: T.textMuted, background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: 3, padding: "0 4px" }}>CH</span>
        )}
      </div>

      {/* Named Account */}
      <div style={{ flex: 1, minWidth: 0, padding: "10px 8px" }}>
        <span style={{ fontFamily: T.body, fontSize: 12,
          color: contract.namedAccount ? T.text : T.border,
          display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {contract.namedAccount || "—"}
        </span>
      </div>

      {/* Route: sea leg + leg pills for multi-leg contracts */}
      <div style={{ width: 215, flexShrink: 0, padding: "10px 8px" }}>
        {seaLeg ? (
          <>
            <div style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 700,
              color: isActive ? T.accent : T.text, whiteSpace: "nowrap" }}>
              {seaLeg.pol} › {seaLeg.pod}
            </div>
            {multiLeg && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                {contract.legs.map((leg, i) => (
                  <span key={i} style={{
                    fontFamily: T.mono, fontSize: 9,
                    border: `1px solid ${leg === seaLeg ? T.accent + "55" : T.border + "88"}`,
                    borderRadius: 3, padding: "1px 5px",
                    color: leg === seaLeg ? (isActive ? T.accent : T.textMuted) : T.border,
                  }}>
                    {leg.polCarrierHaulage ? "● " : ""}{leg.pol}→{leg.pod}{leg.podCarrierHaulage ? " ●" : ""}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>
        )}
      </div>

      {/* Validity */}
      <div style={{ width: 200, flexShrink: 0, padding: "10px 8px" }}>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
          fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {contract.validFrom} – {contract.validTo}
        </span>
      </div>

      {/* Status */}
      <div style={{ width: 78, flexShrink: 0, padding: "10px 8px" }}>
        <Badge variant={
          contract.status === "Active"  ? "success" :
          contract.status === "Expired" ? "danger"  : "warning"
        }>{contract.status}</Badge>
      </div>

      {/* Buy Rate column — only when containers are configured */}
      {showRate && (
        <div style={{ width: 170, flexShrink: 0, padding: "8px 8px" }}>
          {rateTotal > 0 ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: rateSubs.length > 0 ? 4 : 0 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 800,
                  color: isBest ? T.success : T.text, fontVariantNumeric: "tabular-nums" }}>
                  {fmtUsd(rateTotal)}
                </span>
                {isBest && (
                  <span style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700,
                    color: T.success, background: `${T.success}18`,
                    border: `1px solid ${T.success}44`, borderRadius: 4,
                    padding: "1px 5px", whiteSpace: "nowrap" }}>
                    BEST
                  </span>
                )}
              </div>
              {rateSubs.map((s, i) => (
                <div key={i} style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
                  fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {s.qty}×{s.type} {fmtUsd(s.amount)}
                </div>
              ))}
            </>
          ) : (
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>
          )}
        </div>
      )}

      {/* Action */}
      <div style={{ width: 116, flexShrink: 0, padding: "8px 14px 8px 4px",
        display: "flex", justifyContent: "flex-end" }}>
        <Btn
          variant="secondary"
          onClick={e => { e.stopPropagation(); onSelect(); }}
        >
          {isActive ? "▲ Sailings" : "Sailings →"}
        </Btn>
      </div>
    </div>
  );
};

// ─── Schedule panel ───────────────────────────────────────────────────────────

const SchedulePanel = ({ contract, polQuery, podQuery, containers = [] }) => {
  const [legs,    setLegs]    = useState(null);
  const [rates,   setRates]   = useState([]);
  const [weeks,   setWeeks]   = useState(4);
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);

  useEffect(() => {
    if (!contract) { setLegs(null); setRates([]); setResult(null); return; }
    setLegs(null);
    setRates([]);
    setResult(null);
    api.contracts.get(contract.id)
      .then(full => { setLegs(full.legs || []); setRates(full.rates || []); })
      .catch(() => { setLegs([]); setRates([]); });
  }, [contract?.id]);

  const seaLeg   = deriveSeaLeg(legs, polQuery, podQuery);
  const pol      = seaLeg?.pol;
  const pod      = seaLeg?.pod;
  const isMultiLeg = (legs?.length || 0) > 1;

  const search = async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await api.schedules.search({
        pol, pod, carrierCode: contract.carrierCode, weeks,
      });
      setResult(r);
    } catch (e) { toast.error(e.message); }
    setLoading(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

      {/* Contract header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 800, color: T.accent }}>
          {contract.contractNumber}
        </span>
        <Badge variant="info">{contract.carrierCode}</Badge>
        {contract.contractRef && (
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
            {contract.contractRef}
          </span>
        )}
        {contract.namedAccount && (
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            {contract.namedAccount}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
          Valid {contract.validFrom} – {contract.validTo}
        </span>
      </div>

      {/* Routing + query */}
      {legs === null ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Spinner size="sm" />
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading legs…</span>
        </div>
      ) : legs.length === 0 ? (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.warning,
          background: `${T.warning}18`, border: `1px solid ${T.warning}44`,
          borderRadius: 6, padding: "10px 14px" }}>
          No routing legs on this contract — cannot derive schedule query.
        </div>
      ) : (
        <>
          {/* Leg table */}
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>
              Contract routing
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {legs.map((leg, i) => {
                const isSea = leg === seaLeg;
                return (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                    padding: "7px 12px", borderRadius: 7,
                    background: isSea ? T.accentBg : T.bg,
                    border: `1px solid ${isSea ? T.accent + "55" : T.border}`,
                  }}>
                    <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                      color: T.border, background: T.surface,
                      border: `1px solid ${T.border}`, borderRadius: 4,
                      padding: "1px 5px", flexShrink: 0 }}>
                      {i + 1}
                    </span>
                    {leg.polCarrierHaulage && (
                      <span title="Carrier's Haulage" style={{ fontSize: 10 }}>🔵</span>
                    )}
                    <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                      color: isSea ? T.accent : T.text }}>{leg.pol}</span>
                    {leg.polName && (
                      <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted }}>
                        {leg.polName}
                      </span>
                    )}
                    <span style={{ color: T.border }}>›</span>
                    <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                      color: isSea ? T.accent : T.text }}>{leg.pod}</span>
                    {leg.podName && (
                      <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted }}>
                        {leg.podName}
                      </span>
                    )}
                    {leg.podCarrierHaulage && (
                      <span title="Carrier's Haulage" style={{ fontSize: 10 }}>🔵</span>
                    )}
                    {leg.transitDays > 0 && (
                      <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 10,
                        color: T.textMuted }}>{leg.transitDays}d</span>
                    )}
                    {isSea && (
                      <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                        color: T.accent, marginLeft: leg.transitDays > 0 ? 0 : "auto" }}>
                        ← schedule
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Query + controls */}
          <div style={{ background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 20,
              flexWrap: "wrap", marginBottom: isMultiLeg ? 10 : 0 }}>
              <div>
                <div style={{ fontFamily: T.body, fontSize: 9.5, color: T.textMuted,
                  textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 2 }}>
                  Query POL
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 800, color: T.accent }}>
                  {pol}
                </span>
                {seaLeg?.polName && (
                  <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, marginTop: 1 }}>
                    {seaLeg.polName}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 18, color: T.border, flexShrink: 0 }}>›</span>
              <div>
                <div style={{ fontFamily: T.body, fontSize: 9.5, color: T.textMuted,
                  textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 2 }}>
                  Query POD
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 800, color: T.accent }}>
                  {pod}
                </span>
                {seaLeg?.podName && (
                  <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, marginTop: 1 }}>
                    {seaLeg.podName}
                  </div>
                )}
              </div>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ fontFamily: T.body, fontSize: 12, color: T.text,
                  display: "flex", alignItems: "center", gap: 6 }}>
                  Weeks
                  <select value={weeks} onChange={e => setWeeks(parseInt(e.target.value))}
                    disabled={loading}
                    style={{ ...inputBase, width: 62, cursor: "pointer" }}>
                    {[1, 2, 4, 6, 8, 12].map(w => (
                      <option key={w} value={w}>{w}</option>
                    ))}
                  </select>
                </label>
                <Btn onClick={search} disabled={!pol || !pod || loading}>
                  {loading ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <Spinner size="sm" color="currentColor" /> Searching…
                    </span>
                  ) : "Get Sailings"}
                </Btn>
              </div>
            </div>

            {isMultiLeg && (
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted,
                borderTop: `1px solid ${T.border}`, paddingTop: 8, marginTop: 4 }}>
                🔵 = Carrier's Haulage leg — schedule query uses seaport POL{" "}
                <strong style={{ color: T.text }}>{pol}</strong>, not the barge/door origin.
              </div>
            )}
          </div>
        </>
      )}

      {/* Demo banner */}
      {result?.isMock && (
        <div style={{ background: `${T.warning}15`, border: `1px solid ${T.warning}44`,
          borderRadius: 6, padding: "8px 14px", fontFamily: T.body, fontSize: 12,
          color: T.warning }}>
          Demo sailings — no Maersk API key configured. Add{" "}
          <code style={{ fontFamily: T.mono, fontSize: 11 }}>maersk_api_key</code> in
          Settings → API Controls for live schedules.
        </div>
      )}

      {/* Sailings table */}
      {result && (
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>
            {result.sailings.length} Sailing{result.sailings.length !== 1 ? "s" : ""}
            {result.isMock ? " (demo)" : ""}
          </div>
          {result.sailings.length === 0 ? (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
              No sailings found for {pol} → {pod} in {weeks} weeks.
            </div>
          ) : (
            <div style={{ background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 8, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: T.bg }}>
                      {["#", "Vessel", "Voyage", "Service", "ETD", "ETA", "Transit"].map(h => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left",
                          fontFamily: T.body, fontSize: 10, fontWeight: 600,
                          color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em",
                          borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.sailings.map((s, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${T.border}22` }}>
                        <td style={{ padding: "10px 12px", fontFamily: T.mono,
                          fontSize: 10.5, color: T.border,
                          fontVariantNumeric: "tabular-nums" }}>{i + 1}</td>
                        <td style={{ padding: "10px 12px", fontFamily: T.mono,
                          fontSize: 11.5, fontWeight: 700, color: T.text,
                          whiteSpace: "nowrap" }}>{s.vesselName}</td>
                        <td style={{ padding: "10px 12px", fontFamily: T.mono,
                          fontSize: 11.5, color: T.textMuted }}>{s.voyageNumber}</td>
                        <td style={{ padding: "10px 12px", fontFamily: T.body,
                          fontSize: 11.5, color: T.textMuted }}>{s.service}</td>
                        <td style={{ padding: "10px 12px", fontFamily: T.mono,
                          fontSize: 11.5, color: T.accent,
                          fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                          {s.etd || "—"}
                        </td>
                        <td style={{ padding: "10px 12px", fontFamily: T.mono,
                          fontSize: 11.5, color: T.accent,
                          fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                          {s.eta || "—"}
                        </td>
                        <td style={{ padding: "10px 12px", fontFamily: T.mono,
                          fontSize: 11.5, color: T.textMuted, whiteSpace: "nowrap" }}>
                          {s.transitDays ? `${s.transitDays}d` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Rate estimate — shown when containers are configured */}
      {result && containers.length > 0 && (
        <RateEstimate containers={containers} rates={rates} />
      )}
    </div>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

const SchedulesPage = () => {
  const [searched,  setSearched]  = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [results,   setResults]   = useState([]);
  const [total,     setTotal]     = useState(0);
  const [offset,    setOffset]    = useState(0);
  const [lastQuery, setLastQuery] = useState(null);
  const [selected,       setSelected]       = useState(null);
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  const toggleGroup = (key, groupContracts) => {
    const willCollapse = expandedGroups.has(key);
    if (willCollapse && groupContracts.some(c => c.id === selected?.id)) {
      setSelected(null);
    }
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Group results by contractNumber so rows sharing a number appear together.
  const groupedResults = useMemo(() => {
    const groups = [];
    const map    = {};
    (results || []).forEach(c => {
      const key = c.contractNumber || `_${c.id}`;
      if (!map[key]) { map[key] = { key, contracts: [] }; groups.push(map[key]); }
      map[key].contracts.push(c);
    });
    return groups;
  }, [results]);

  const doSearch = useCallback(async (params, off = 0) => {
    setLoading(true);
    setSelected(null);
    try {
      const res = await api.contracts.search({ ...params, limit: LIMIT, offset: off });
      setResults(res.results || []);
      setTotal(res.total   || 0);
      setOffset(off);
      setSearched(true);
    } catch (e) {
      toast.error(e.message || "Search failed");
    }
    setLoading(false);
  }, []);

  const handleSearch = params => {
    if (!params) { setSearched(false); setResults([]); setTotal(0); setLastQuery(null); return; }
    setLastQuery(params);
    doSearch(params, 0);
  };

  const handlePage = off => { if (lastQuery) doSearch(lastQuery, off); };

  return (
    <div>
      {/* Page header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>
          Schedule Search
        </h1>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
          Search contracts by routing, carrier, or account — then request available sailings.
        </p>
      </div>

      {/* Search form */}
      <SearchForm onSearch={handleSearch} loading={loading} />

      {/* Results */}
      {!searched ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", minHeight: 260, gap: 12, opacity: .6 }}>
          <div style={{ fontSize: 36 }}>🔍</div>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted }}>
            Enter search criteria above and click <strong>Search Contracts</strong>.
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted,
            textAlign: "center", maxWidth: 440, lineHeight: 1.6 }}>
            Use POL / POD to find contracts by seaport, or Via Origin / Via Destination
            to find contracts with Carrier's Haulage coverage at door or CY locations.
          </div>
        </div>
      ) : (
        <>
          {/* Result count */}
          <div style={{ display: "flex", alignItems: "center",
            justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
              {loading ? "Searching…" : (
                total === 0
                  ? "No contracts found"
                  : `${total} contract${total !== 1 ? "s" : ""} found${total > LIMIT
                      ? ` — showing ${LIMIT} per page` : ""}`
              )}
            </span>
          </div>

          {loading ? (
            <div style={{ padding: "32px 0", display: "flex", justifyContent: "center" }}>
              <Spinner />
            </div>
          ) : results.length === 0 ? (
            <div style={{ padding: "32px 0", textAlign: "center" }}>
              <div style={{ fontSize: 26, marginBottom: 8, opacity: .5 }}>🔍</div>
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                No contracts match the filters.
              </div>
              <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 4 }}>
                Try different POL / POD or adjust the status filter.
              </div>
            </div>
          ) : (
            <>
              {/* Full-width results table */}
              <div style={{ background: T.surface, border: `1px solid ${T.border}`,
                borderRadius: 10, overflow: "hidden" }}>

                {(() => {
                  const qPol        = lastQuery?.pol || "";
                  const qPod        = lastQuery?.pod || "";
                  const qContainers = lastQuery?.containers || [];
                  const showRate    = qContainers.length > 0;

                  // Compute totals + best rate across all results
                  const rateTotals = showRate
                    ? Object.fromEntries(results.map(c => [c.id, computeRateTotal(c.rates || [], qContainers)]))
                    : {};
                  const allTotals  = Object.values(rateTotals).filter(v => v > 0);
                  const bestRate   = allTotals.length > 0 ? Math.min(...allTotals) : 0;

                  return (
                    <>
                      <TableHeader showRate={showRate} />

                      {groupedResults.map(group => {
                        const isMulti    = group.contracts.length > 1;
                        const isExpanded = !isMulti || expandedGroups.has(group.key);
                        const groupMinRate = showRate
                          ? Math.min(...group.contracts.map(c => rateTotals[c.id] || 0).filter(v => v > 0), Infinity)
                          : 0;

                        const rows = group.contracts.map(c => (
                          <div key={c.id}>
                            <ContractRow
                              contract={c}
                              selected={selected}
                              onSelect={() => setSelected(prev => prev?.id === c.id ? null : c)}
                              inGroup={isMulti}
                              isChild={isMulti}
                              polQuery={qPol}
                              podQuery={qPod}
                              containers={qContainers}
                              rateTotal={rateTotals[c.id] || 0}
                              isBest={showRate && bestRate > 0 && rateTotals[c.id] === bestRate}
                            />
                            {selected?.id === c.id && (
                              <div style={{
                                borderLeft: `3px solid ${T.accent}`,
                                borderBottom: `1px solid ${T.border}`,
                                background: T.accentBg,
                                padding: "20px 24px",
                              }}>
                                <SchedulePanel contract={c} polQuery={qPol} podQuery={qPod} containers={qContainers} />
                              </div>
                            )}
                          </div>
                        ));

                        return (
                          <div key={group.key}>
                            {isMulti && (
                              <GroupHeaderRow
                                group={group}
                                isExpanded={isExpanded}
                                onToggle={() => toggleGroup(group.key, group.contracts)}
                                polQuery={qPol}
                                podQuery={qPod}
                                containers={qContainers}
                                groupMinRate={groupMinRate === Infinity ? 0 : groupMinRate}
                              />
                            )}
                            {isExpanded && rows}
                          </div>
                        );
                      })}
                    </>
                  );
                })()}
              </div>

              {total > LIMIT && (
                <div style={{ marginTop: 16 }}>
                  <Pagination total={total} limit={LIMIT} offset={offset} onPage={handlePage} />
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

export default SchedulesPage;
