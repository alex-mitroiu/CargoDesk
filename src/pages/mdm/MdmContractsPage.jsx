import { useState, useEffect, useCallback, useRef } from "react";
import useSaving from "../../hooks/useSaving";
import { T, IMDG_CLASSES, CONTAINER_OPTIONS as CONTAINER_OPTION_DEFS } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { toast } from "../../toast";
import Spinner, { PageSpinner } from "../../components/primitives/Spinner";
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
import CarrierCombobox from "../../components/shared/CarrierCombobox";

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
const CONTAINER_OPTIONS = CONTAINER_OPTION_DEFS.map(o => o.code);
const CURRENCIES = ["USD","EUR","GBP","CHF","JPY","CNY","SGD","HKD","AED","SAR","AUD","CAD","DKK","NOK","SEK"];
const UNITS = ["per_container","per_bl","per_kg","per_cbm"];
const MOVEMENT_TYPES = ["FCL","LCL"];
const CONTRACT_STATUSES = ["Active","Draft","Expired","On Hold"];

const EMPTY_FILTERS = { search:"", carrier:"", status:"", dg:"", asOf:"", containerType:"" };
const LIMIT = 25;

const EMPTY_FORM = {
  contractNumber: "", contractRef: "", carrierCode: "", namedAccountId: "", namedAccount: "",
  movementType: "FCL", containerTypes: [], dgAllowed: false, imdgClasses: [],
  validFrom: "", validTo: "", currency: "USD", status: "Active", notes: "",
  legs: [],
  rates: [],
  routings: [],
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

// ─── Routing-index resolution ───────────────────────────────────────────────────
// GET /api/contracts responses carry each leg/rate's real, server-generated routingId
// (contract_routings.id) — but that id never survives a save (saveRoutings deletes and
// regenerates every routing row, same as legs/rates), so the SAVE payload correlates a
// leg/rate to a routing purely by array index into f.routings (routingIndex), the only
// identity that does survive. This resolves the server's routingId strings to the client's
// own routingIndex once, right after a contract loads — -1 means "no routing" (the
// contract's single implicit bucket), matching every leg/rate on a contract with no named
// routings at all.
const resolveRoutingIndex = (items, routings) =>
  items.map(item => ({
    ...item,
    routingIndex: item.routingId ? routings.findIndex(r => r.id === item.routingId) : -1,
  }));

// ─── Routing chain-continuity check ──────────────────────────────────────────
// A routing's legs (the ungrouped bucket, or one named routing's own group) are one
// continuous physical journey, not independent hops — leg N's own POD is where leg N+1
// must load from. Nothing enforced this before: a contract could silently save Leg 2
// discharging at FRMRS while Leg 3 loads from NLRTM with no warning anywhere. Only flags
// a gap once both ports on either side of the join are actually set, so a leg still being
// filled in never spuriously warns.
const findChainGaps = (orderedLegs) => {
  const gaps = [];
  for (let i = 1; i < orderedLegs.length; i++) {
    const prev = orderedLegs[i - 1], cur = orderedLegs[i];
    if (prev.pod && cur.pol && prev.pod !== cur.pol) {
      gaps.push({ afterLegPos: i, prevPod: prev.pod, nextPol: cur.pol });
    }
  }
  return gaps;
};

const RoutingGapWarning = ({ afterPos, prevPod, nextPol }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px",
    background: `${T.danger}18`, border: `1px solid ${T.danger}55`, borderRadius: 6,
    fontFamily: T.body, fontSize: 11, color: T.danger }}>
    <span>⚠</span>
    <span>Routing gap — Leg {afterPos} discharges at <strong style={{ fontFamily: T.mono }}>{prevPod}</strong>, but Leg {afterPos + 1} loads from <strong style={{ fontFamily: T.mono }}>{nextPol}</strong></span>
  </div>
);

// ─── Leg card — one POL/POD leg, reused for both the ungrouped bucket and each named
// routing's own leg list below, so the grouping UI doesn't duplicate this ~140-line card. ──

const LegCard = ({ leg, label, onUpdate, onRemove }) => (
  <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px" }}>
    {/* Row 1: Leg label · POL · → · POD · remove */}
    <div style={{ display: "grid", gridTemplateColumns: "44px 1fr 18px 1fr 32px", gap: 8, alignItems: "start" }}>
      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, fontWeight: 700, paddingTop: 8 }}>
        {label}
      </span>

      {/* POL */}
      <div>
        {leg.pol ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: T.surface,
            border: `1px solid ${T.accent}55`, borderRadius: 6, padding: "6px 10px" }}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{leg.pol}</span>
            {leg.polName && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{leg.polName}</span>}
            <button type="button" onClick={() => onUpdate({ pol: "", polName: "", polLinkedAllowed: false, polCarrierHaulage: false, polHaulageLocations: "", polLocType: "Terminal" })}
              style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 10, padding: 0, flexShrink: 0 }}>✕</button>
          </div>
        ) : (
          <PortCombobox placeholder="POL…" onChange={r => onUpdate({ pol: r.unlocode, polName: r.name })} />
        )}
        {leg.pol && (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: "flex", gap: 0, borderRadius: 5, overflow: "hidden", border: `1px solid ${T.border}`, width: "fit-content" }}>
              {["Terminal","Door","CY"].map(lt => (
                <button key={lt} type="button"
                  onClick={() => onUpdate({ polLocType: lt, polCarrierHaulage: lt !== "Terminal" })}
                  style={{ fontFamily: T.body, fontSize: 11, padding: "3px 9px", border: "none", cursor: "pointer", borderRight: lt !== "CY" ? `1px solid ${T.border}` : "none",
                    background: (leg.polLocType || "Terminal") === lt ? T.accent : T.surface,
                    color: (leg.polLocType || "Terminal") === lt ? "#fff" : T.textMuted }}>
                  {lt}
                </button>
              ))}
            </div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 5, cursor: "pointer" }}>
              <input type="checkbox"
                checked={!!leg.polLinkedAllowed}
                onChange={e => onUpdate({ polLinkedAllowed: e.target.checked })}
                style={{ width: 13, height: 13, accentColor: T.info, cursor: "pointer" }}
              />
              <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>Allow linked POL</span>
            </label>
            {(leg.polLocType === "Door" || leg.polLocType === "CY") && (
              <div style={{ marginTop: 5 }}>
                <input
                  value={leg.polHaulageLocations || ""}
                  onChange={e => onUpdate({ polHaulageLocations: e.target.value })}
                  placeholder="UN/LOCODEs e.g. NLAMS NLRTM (leave blank for any)"
                  style={{ ...inputBase, fontFamily: T.mono, fontSize: 11, width: "100%", boxSizing: "border-box" }}
                />
                <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, marginTop: 2, display: "block" }}>
                  Door and CY both enable Carrier's Haulage routing — leave blank to accept any location
                </span>
              </div>
            )}
          </div>
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
            <button type="button" onClick={() => onUpdate({ pod: "", podName: "", podLinkedAllowed: false, podCarrierHaulage: false, podHaulageLocations: "", podLocType: "Terminal" })}
              style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 10, padding: 0, flexShrink: 0 }}>✕</button>
          </div>
        ) : (
          <PortCombobox placeholder="POD…" onChange={r => onUpdate({ pod: r.unlocode, podName: r.name })} />
        )}
        {leg.pod && (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: "flex", gap: 0, borderRadius: 5, overflow: "hidden", border: `1px solid ${T.border}`, width: "fit-content" }}>
              {["Terminal","Door","CY"].map(lt => (
                <button key={lt} type="button"
                  onClick={() => onUpdate({ podLocType: lt, podCarrierHaulage: lt !== "Terminal" })}
                  style={{ fontFamily: T.body, fontSize: 11, padding: "3px 9px", border: "none", cursor: "pointer", borderRight: lt !== "CY" ? `1px solid ${T.border}` : "none",
                    background: (leg.podLocType || "Terminal") === lt ? T.accent : T.surface,
                    color: (leg.podLocType || "Terminal") === lt ? "#fff" : T.textMuted }}>
                  {lt}
                </button>
              ))}
            </div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 5, cursor: "pointer" }}>
              <input type="checkbox"
                checked={!!leg.podLinkedAllowed}
                onChange={e => onUpdate({ podLinkedAllowed: e.target.checked })}
                style={{ width: 13, height: 13, accentColor: T.info, cursor: "pointer" }}
              />
              <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>Allow linked POD</span>
            </label>
            {(leg.podLocType === "Door" || leg.podLocType === "CY") && (
              <div style={{ marginTop: 5 }}>
                <input
                  value={leg.podHaulageLocations || ""}
                  onChange={e => onUpdate({ podHaulageLocations: e.target.value })}
                  placeholder="UN/LOCODEs e.g. USCHI USLGB (leave blank for any)"
                  style={{ ...inputBase, fontFamily: T.mono, fontSize: 11, width: "100%", boxSizing: "border-box" }}
                />
                <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, marginTop: 2, display: "block" }}>
                  Door and CY both enable Carrier's Haulage routing — leave blank to accept any location
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Remove */}
      <button type="button" onClick={onRemove}
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
        onChange={e => onUpdate({ transitDays: parseInt(e.target.value) || 0 })}
        placeholder="Days"
        title="Transit days"
        style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, textAlign: "center" }}
      />
      <input
        value={leg.vesselService}
        onChange={e => onUpdate({ vesselService: e.target.value })}
        placeholder="Vessel service (e.g. AEX-1)…"
        style={{ ...inputBase, fontFamily: T.mono, fontSize: 12 }}
      />
    </div>
  </div>
);

// ─── Contract Modal Form ──────────────────────────────────────────────────────

const ContractModal = ({ editing, prefill, onSave, onClose }) => {
  const src = editing || prefill;
  const [f, setF] = useState(() => {
    if (!src) return { ...EMPTY_FORM };
    const routings = src.routings || [];
    return {
      contractNumber: src.contractNumber || "",
      contractRef:    src.contractRef    || "",
      carrierCode:    src.carrierCode    || "",
      namedAccountId: src.namedAccountId || "",
      namedAccount:   src.namedAccount   || "",
      movementType:   src.movementType   || "FCL",
      containerTypes: src.containerTypes || [],
      dgAllowed:      src.dgAllowed      || false,
      imdgClasses:    src.imdgClasses    || [],
      validFrom:      src.validFrom      || "",
      validTo:        src.validTo        || "",
      currency:       src.currency       || "USD",
      status:         src.status         || "Active",
      notes:          src.notes          || "",
      legs:           resolveRoutingIndex(src.legs  || [], routings),
      rates:          resolveRoutingIndex(src.rates || [], routings),
      routings,
    };
  });

  const [fxRates,      setFxRates]      = useState({});
  const [saving,       withSaving]      = useSaving();
  const [allCarriers,  setAllCarriers]  = useState([]);
  const [carrierOpen,  setCarrierOpen]  = useState(false);
  const [carrierQuery, setCarrierQuery] = useState(src?.carrierCode || "");
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

  // Load legs+rates+routings when editing
  useEffect(() => {
    if (editing?.id) {
      api.contracts.get(editing.id).then(full => {
        const routings = full.routings || [];
        setF(p => ({ ...p, legs: resolveRoutingIndex(full.legs || [], routings), rates: resolveRoutingIndex(full.rates || [], routings), routings }));
      }).catch(() => {});
    }
  }, [editing?.id]);

  const updateLeg = (i, patch) =>
    setF(p => ({ ...p, legs: p.legs.map((l, idx) => idx === i ? { ...l, ...patch } : l) }));

  // routingIndex: -1 (default) = the contract's single implicit routing/no grouping; an
  // integer index into f.routings assigns the new leg straight into that named routing's
  // own group (used by each routing card's own "+ Add Leg" button below).
  const addLeg = (routingIndex = -1) =>
    setF(p => ({ ...p, legs: [...p.legs, { pol:"", polName:"", pod:"", podName:"", transitDays:0, vesselService:"", polLinkedAllowed:false, podLinkedAllowed:false, polCarrierHaulage:false, podCarrierHaulage:false, polHaulageLocations:"", podHaulageLocations:"", polLocType:"Terminal", podLocType:"Terminal", routingIndex }] }));

  const removeLeg = i =>
    setF(p => ({ ...p, legs: p.legs.filter((_, idx) => idx !== i) }));

  // A named routing (e.g. "Via Rotterdam") groups a subset of legs (and, in the Rates section
  // below, optionally a subset of rates) under one label — see resolveRoutingIndex's own
  // comment for why correlation is by array index, not a server id, while editing.
  const addRouting = () =>
    setF(p => ({ ...p, routings: [...p.routings, { name: "", transitDays: 0, notes: "" }] }));

  const updateRouting = (i, patch) =>
    setF(p => ({ ...p, routings: p.routings.map((r, idx) => idx === i ? { ...r, ...patch } : r) }));

  // Removing a named routing removes ITS OWN legs/rates too (not just ungroups them) — a rate
  // or leg scoped to "Via Hamburg" has no meaning once "Via Hamburg" no longer exists. Every
  // leg/rate belonging to a LATER routing has its routingIndex shifted down by one so it still
  // points at the correct (now-reindexed) entry in the shortened routings array.
  const removeRouting = i =>
    setF(p => ({
      ...p,
      routings: p.routings.filter((_, idx) => idx !== i),
      legs: p.legs.filter(l => l.routingIndex !== i).map(l => l.routingIndex > i ? { ...l, routingIndex: l.routingIndex - 1 } : l),
      rates: p.rates.filter(r => r.routingIndex !== i).map(r => r.routingIndex > i ? { ...r, routingIndex: r.routingIndex - 1 } : r),
    }));

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
    setF(p => ({ ...p, rates: [...p.rates, { serviceCode:"OF", description:"", containerType:"", amount:0, currency: p.currency, amountUsd:0, unit:"per_container", notes:"", validFrom:"", validTo:"", routingIndex:-1 }] }));

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
    // Every named routing (and the ungrouped bucket, routingIndex -1) is one continuous
    // physical journey — validate each group's own leg chain, not just leg presence.
    for (const gk of [-1, ...f.routings.map((_, ri) => ri)]) {
      const gaps = findChainGaps(f.legs.filter(l => l.routingIndex === gk));
      if (gaps.length > 0) {
        const g = gaps[0];
        const where = gk === -1 ? "" : ` in routing "${f.routings[gk].name || `Routing ${gk + 1}`}"`;
        return toast.error(`Routing gap${where}: Leg ${g.afterLegPos} discharges at ${g.prevPod} but Leg ${g.afterLegPos + 1} loads from ${g.nextPol}`);
      }
    }
    withSaving(async () => {
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
      }
    });
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

  // Rate table grid — gains a leading Routing column only once the contract has at least one
  // named routing, so a plain single-routing contract's table is untouched.
  const rateCols = f.routings.length > 0
    ? "130px 130px 1fr 90px 80px 70px 70px 100px 108px 108px 1fr 32px"
    : "130px 1fr 90px 80px 70px 70px 100px 108px 108px 1fr 32px";

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
        {/* Contract Reference */}
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Contract Reference" hint="Disambiguates contracts sharing the same number — e.g. per region or customer">
            <input
              value={f.contractRef}
              onChange={e => setF(p => ({ ...p, contractRef: e.target.value }))}
              placeholder="e.g. REF-2025-APAC-001"
              style={{ ...inputBase, fontFamily: T.mono, fontSize: 13 }}
            />
          </Field>
        </div>
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
        <DatePicker label="Valid From" required value={f.validFrom} onChange={v => setF(p => ({ ...p, validFrom: v }))} />
        <DatePicker label="Valid To"   required value={f.validTo}   onChange={v => setF(p => ({ ...p, validTo: v }))}
          minDate={f.validFrom || undefined} />
      </div>

      {/* ── Section 3: Routing ── */}
      <div style={sectionHeader()}>Routing (Multi-Leg) <span style={{ color: T.danger }}>*</span></div>
      {/* Ungrouped legs (routingIndex -1) — a contract with zero named routings renders exactly
          this, nothing more: no routing chrome, just "+ Add Leg" like before this feature. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {f.legs.map((l, i) => ({ ...l, _i: i })).filter(l => l.routingIndex < 0).map((leg, pos, arr) => (
          <div key={leg._i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pos > 0 && arr[pos - 1].pod && leg.pol && arr[pos - 1].pod !== leg.pol && (
              <RoutingGapWarning afterPos={pos} prevPod={arr[pos - 1].pod} nextPol={leg.pol} />
            )}
            <LegCard leg={leg} label={`Leg ${pos + 1}`}
              onUpdate={patch => updateLeg(leg._i, patch)} onRemove={() => removeLeg(leg._i)} />
          </div>
        ))}
        <div>
          <Btn variant="secondary" onClick={() => addLeg(-1)}>+ Add Leg</Btn>
        </div>
      </div>

      {/* Named routings — each a self-contained group of its own legs (e.g. "Via Rotterdam"
          vs. "Via Hamburg" for the same POL/POD), independently priced in the Rates section
          below. Only appears once at least one routing has been added. */}
      {f.routings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
          {f.routings.map((routing, ri) => (
            <div key={ri} style={{ background: T.surface, border: `1px solid ${T.accent}44`, borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <input value={routing.name} onChange={e => updateRouting(ri, { name: e.target.value })}
                  placeholder={`Routing ${ri + 1} name (e.g. "Via Rotterdam")`}
                  style={{ ...inputBase, fontFamily: T.body, fontSize: 13, fontWeight: 600, flex: 1 }} />
                <input type="number" min={0} max={999}
                  value={routing.transitDays}
                  onChange={e => updateRouting(ri, { transitDays: parseInt(e.target.value) || 0 })}
                  placeholder="Days" title="Total transit days for this routing"
                  style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, width: 90, textAlign: "center" }} />
                <button type="button" onClick={() => removeRouting(ri)}
                  title="Remove this routing and its legs/rates"
                  style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
                    color: T.danger, cursor: "pointer", fontSize: 13, padding: "4px 8px" }}>
                  ✕
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {f.legs.map((l, i) => ({ ...l, _i: i })).filter(l => l.routingIndex === ri).map((leg, pos, arr) => (
                  <div key={leg._i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {pos > 0 && arr[pos - 1].pod && leg.pol && arr[pos - 1].pod !== leg.pol && (
                      <RoutingGapWarning afterPos={pos} prevPod={arr[pos - 1].pod} nextPol={leg.pol} />
                    )}
                    <LegCard leg={leg} label={`Leg ${pos + 1}`}
                      onUpdate={patch => updateLeg(leg._i, patch)} onRemove={() => removeLeg(leg._i)} />
                  </div>
                ))}
                <div>
                  <Btn variant="secondary" size="sm" onClick={() => addLeg(ri)}>+ Add Leg</Btn>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <Btn variant="secondary" onClick={addRouting}>+ Add Routing</Btn>
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
          {/* Header — the Routing column only exists once the contract has at least one named
              routing, so a plain single-routing contract's rate table looks exactly like it
              did before this feature (see rateCols below). */}
          <div style={{ display: "grid", gridTemplateColumns: rateCols,
            gap: 6, padding: "7px 10px", borderBottom: `1px solid ${T.border}`,
            fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".07em" }}>
            {f.routings.length > 0 && <span>Routing</span>}
            <span>Service</span>
            <span>Description</span>
            <span>Container</span>
            <span>Amount</span>
            <span>Currency</span>
            <span>≈ USD</span>
            <span>Unit</span>
            <span title="Blank = inherits the contract's own Valid From/To window">Valid From</span>
            <span title="Blank = inherits the contract's own Valid From/To window">Valid To</span>
            <span>Notes</span>
            <span></span>
          </div>
          {f.rates.map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: rateCols,
              gap: 6, padding: "6px 10px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
              {/* Routing — '' / -1 means "all routings" (a contract-wide line, e.g. a flat
                  documentation fee), same as this field's meaning on every legacy contract's
                  rates today. */}
              {f.routings.length > 0 && (
                <select value={r.routingIndex ?? -1} onChange={e => updateRate(i, { routingIndex: parseInt(e.target.value, 10) })}
                  title="Which routing this rate applies to — 'All routings' applies regardless of which one was matched"
                  style={{ ...inputBase, fontFamily: T.body, fontSize: 11, padding: "5px 6px" }}>
                  <option value={-1}>All routings</option>
                  {f.routings.map((rt, ri) => <option key={ri} value={ri}>{rt.name || `Routing ${ri + 1}`}</option>)}
                </select>
              )}
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
              {/* Valid From — blank inherits the contract's own window */}
              <input type="date" value={r.validFrom || ""} max={r.validTo || undefined}
                onChange={e => updateRate(i, { validFrom: e.target.value })}
                style={{ ...inputBase, fontFamily: T.mono, fontSize: 10.5, padding: "5px 4px" }} />
              {/* Valid To — blank inherits the contract's own window */}
              <input type="date" value={r.validTo || ""} min={r.validFrom || undefined}
                onChange={e => updateRate(i, { validTo: e.target.value })}
                style={{ ...inputBase, fontFamily: T.mono, fontSize: 10.5, padding: "5px 4px" }} />
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
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {saving && <Spinner size="sm" color="currentColor" />}
            {saving ? "Saving…" : (editing ? "Save Changes" : "Create Contract")}
          </span>
        </Btn>
      </div>
    </div>
  );
};

// ─── Schedules Modal ──────────────────────────────────────────────────────────

const SchedulesModal = ({ contract, onClose }) => {
  const [legs,     setLegs]     = useState(null);
  const [weeks,    setWeeks]    = useState(4);
  const [loading,  setLoading]  = useState(false);
  const [result,   setResult]   = useState(null);

  useEffect(() => {
    api.contracts.get(contract.id)
      .then(full => setLegs(full.legs || []))
      .catch(() => setLegs([]));
  }, [contract.id]);

  // Derive the sea leg: first leg where POL side has no carrier haulage;
  // fall back to first leg if all legs have haulage (single-leg contracts).
  const seaLeg = legs && (legs.find(l => !l.polCarrierHaulage) || legs[0]);
  const pol = seaLeg?.pol;
  const pod = seaLeg?.pod;

  const handleSearch = async () => {
    if (!pol || !pod) return;
    setLoading(true);
    setResult(null);
    try {
      const r = await api.schedules.search({
        pol, pod, carrierCode: contract.carrierCode, weeks,
      });
      setResult(r);
    } catch (e) {
      toast.error(e.message);
    }
    setLoading(false);
  };

  const colHead = { fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".08em", padding: "0 8px 8px", whiteSpace: "nowrap" };
  const cell    = { fontFamily: T.mono, fontSize: 12, color: T.text, padding: "10px 8px",
    borderTop: `1px solid ${T.border}22` };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Route derivation — rendered in journey order based on loc types */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}`,
        borderRadius: 8, padding: "12px 16px" }}>
        {legs === null ? (
          <Spinner size="sm" />
        ) : legs.length === 0 ? (
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
            No legs configured on this contract.
          </span>
        ) : !seaLeg ? null : (() => {
          const polIsDoor = seaLeg.polLocType === "Door";
          const podIsDoor = seaLeg.podLocType === "Door";
          const polIsCY   = seaLeg.polLocType === "Container Yard" || seaLeg.polLocType === "CFS";
          const podIsCY   = seaLeg.podLocType === "Container Yard" || seaLeg.podLocType === "CFS";

          const LegNode = ({ label, code, name, highlight }) => (
            <div>
              <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
                textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 2 }}>{label}</div>
              <span style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700,
                color: highlight ? T.accent : T.text }}>{code || "—"}</span>
              {name && (
                <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 1 }}>{name}</div>
              )}
            </div>
          );
          const Arrow = () => (
            <div style={{ fontSize: 18, color: T.border, flexShrink: 0, alignSelf: "center" }}>›</div>
          );

          // Build journey steps in correct order
          const steps = [];
          if (polIsDoor || polIsCY) steps.push(
            <LegNode key="origin" label={polIsDoor ? "Origin (Door)" : "Origin (CY/CFS)"}
              code={polIsDoor ? "DOOR" : "CY"} name={seaLeg.polHaulageLocations || null} highlight={false} />
          );
          steps.push(<LegNode key="pol" label="Port of Loading" code={pol} name={seaLeg.polName} highlight={true} />);
          steps.push(<LegNode key="pod" label="Port of Discharge" code={pod} name={seaLeg.podName} highlight={true} />);
          if (podIsDoor || podIsCY) steps.push(
            <LegNode key="dest" label={podIsDoor ? "Destination (Door)" : "Destination (CY/CFS)"}
              code={podIsDoor ? "DOOR" : "CY"} name={seaLeg.podHaulageLocations || null} highlight={false} />
          );

          const nodes = [];
          steps.forEach((s, i) => {
            nodes.push(s);
            if (i < steps.length - 1) nodes.push(<Arrow key={`a${i}`} />);
          });

          return (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
              {nodes}
              {legs.length > 1 && (
                <div style={{ marginLeft: "auto", fontFamily: T.body, fontSize: 11, color: T.textMuted,
                  fontStyle: "italic", alignSelf: "center" }}>
                  Using sea leg ({legs.indexOf(seaLeg) + 1} of {legs.length})
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Search controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <label style={{ fontFamily: T.body, fontSize: 13, color: T.text, display: "flex",
          alignItems: "center", gap: 8 }}>
          Weeks ahead
          <select
            value={weeks}
            onChange={e => setWeeks(parseInt(e.target.value))}
            disabled={loading}
            style={{ ...inputBase, width: 70, cursor: "pointer" }}
          >
            {[1, 2, 4, 6, 8, 12].map(w => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </label>

        <Btn onClick={handleSearch} disabled={!pol || !pod || loading}>
          {loading ? (
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <Spinner size="sm" color="currentColor" /> Searching…
            </span>
          ) : "Search Sailings"}
        </Btn>
      </div>

      {/* Mock banner */}
      {result?.isMock && (
        <div style={{ background: `${T.warning}18`, border: `1px solid ${T.warning}44`,
          borderRadius: 6, padding: "8px 12px", fontFamily: T.body, fontSize: 12, color: T.warning }}>
          Showing demo sailings — no matching sailing found in the schedule catalog for this route/date window.
        </div>
      )}

      {/* Results */}
      {result && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 8, overflow: "hidden" }}>
          {result.sailings.length === 0 ? (
            <div style={{ padding: "24px 16px", textAlign: "center", fontFamily: T.body,
              fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
              No sailings found for this route in the selected window.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Vessel","Voyage","Service","ETD","ETA","Transit"].map(h => (
                      <th key={h} style={colHead}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.sailings.map((s, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : `${T.border}10` }}>
                      <td style={{ ...cell, fontWeight: 600 }}>{s.vesselName}</td>
                      <td style={cell}>{s.voyageNumber}</td>
                      <td style={cell}>{s.service}</td>
                      <td style={{ ...cell, color: T.accent }}>{s.etd || "—"}</td>
                      <td style={{ ...cell, color: T.accent }}>{s.eta || "—"}</td>
                      <td style={{ ...cell, color: T.textMuted }}>
                        {s.transitDays ? `${s.transitDays}d` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

const MdmContractsPage = () => {
  const { canManageConfigs } = useAuth();
  const [results, setResults] = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [modal,            setModal]            = useState(null);
  const [cloneSource,      setCloneSource]      = useState(null);
  const [historyContract,   setHistoryContract]   = useState(null);
  const [routingContract,   setRoutingContract]   = useState(null);
  const [schedulesContract, setSchedulesContract] = useState(null);
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

  const handleSaved = () => { setModal(null); setCloneSource(null); doLoad(filters, offset); };

  const handleDuplicate = async c => {
    try {
      const full = await api.contracts.get(c.id);
      setCloneSource(full);
      setModal("new");
    } catch (e) {
      toast.error(e.message);
    }
  };

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

  const handlePublish = async id => {
    try {
      await api.contracts.publish(id);
      toast.success("Contract published — now selectable for shipments");
      doLoad(filters, offset);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const handleWithdraw = async id => {
    if (!window.confirm("Withdraw this contract back to Draft? It will no longer be selectable for new shipments.")) return;
    try {
      await api.contracts.withdraw(id);
      toast.success("Contract withdrawn to Draft");
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
    } else if (key === "carrier") {
      // CarrierCombobox only calls onChange on an actual selection (click or Enter on a real
      // match) or its own clear button — never per-keystroke, typing lives in the combobox's
      // own internal query state — so unlike the free-text search box above, this is already a
      // discrete, validated pick and doesn't need a debounce; filter immediately.
      setOffset(0); doLoad(next, 0);
    }
  };

  const hasFilters = Object.values(filters).some(v => v !== "");

  // Column resizer
  const { template, startResize } = useResizableColumns("mdm-contracts", [120,100,120,180,140,50,100,100,90,80]);
  const headers = ["Contract #","Carrier","Named Account","Route","Containers","DG","Valid From","Valid To","Status","Actions"];

  const th = {
    position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
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
        {canManageConfigs && <Btn size="lg" onClick={() => setModal("new")}>＋ New Contract</Btn>}
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
        {/* Was a plain free-text input — the backend already does an exact carrier_code=?
            match here (routes/contracts.js), never a partial LIKE, so a typo silently
            returned zero results with no feedback, and Enter didn't trigger search at all
            (no onKeyDown, unlike the search box above). CarrierCombobox validates against the
            real carrier registry as you type, closing both gaps at once. */}
        <div style={{ width: 160 }}>
          <CarrierCombobox value={filters.carrier} onChange={code => handleSearchChange("carrier", code)} />
        </div>
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
          const routings = c.routings || [];
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
                {c.contractRef && (
                  <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.text, marginTop: 2 }}>
                    {c.contractRef}
                  </div>
                )}
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
              <div>
                {legs.length === 0 ? (
                  <span style={{ color: T.border }}>—</span>
                ) : (
                  <>
                    <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 600 }}>
                      {legs[0].pol} <span style={{ color: T.border }}>›</span> {legs[0].pod}
                    </div>
                    {(legs[0].polName || legs[0].podName) && (
                      <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, marginTop: 1,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {legs[0].polName} › {legs[0].podName}
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      {legs.length > 1 && (
                        <button type="button"
                          onClick={e => { e.stopPropagation(); setRoutingContract(c); }}
                          style={{ background: "none", border: "none", padding: 0,
                            cursor: "pointer", fontFamily: T.body, fontSize: 10.5, color: T.accent,
                            textDecoration: "underline", textDecorationStyle: "dotted" }}>
                          +{legs.length - 1} more leg{legs.length - 1 > 1 ? "s" : ""}
                        </button>
                      )}
                      {/* Named routings (e.g. "Via Rotterdam" vs "Via Hamburg") are a distinct
                          concept from raw leg count — surfaced here so a multi-priced-path
                          contract is visible straight from the list. */}
                      {routings.length > 1 && (
                        <span title={routings.map(r => r.name || "Unnamed").join(", ")}>
                          <Badge variant="info">{routings.length} routings</Badge>
                        </span>
                      )}
                    </div>
                  </>
                )}
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
                  ...(canManageConfigs ? [{ icon: "✎",  label: "Edit",      onClick: () => setModal(c) }] : []),
                  ...(canManageConfigs && c.status === "Draft"  ? [{ icon: "▲", label: "Publish",  onClick: () => handlePublish(c.id) }] : []),
                  ...(canManageConfigs && c.status === "Active" ? [{ icon: "▽", label: "Withdraw to Draft", onClick: () => handleWithdraw(c.id) }] : []),
                  ...(canManageConfigs ? [{ icon: "⧉",  label: "Duplicate", onClick: () => handleDuplicate(c) }] : []),
                  { icon: "🗓", label: "Schedules",  onClick: () => setSchedulesContract(c) },
                  { icon: "📋", label: "History",   onClick: () => setHistoryContract(c) },
                  ...(canManageConfigs ? [{ icon: "✕",  label: "Delete",    variant: "danger", onClick: () => handleDelete(c.id) }] : []),
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
          title={
            modal === "new"
              ? (cloneSource ? `New Contract — copy of ${cloneSource.contractNumber}` : "New Contract")
              : `Edit — ${modal.contractNumber}`
          }
          onClose={() => { setModal(null); setCloneSource(null); }}
          width={820}
        >
          <ContractModal
            editing={modal === "new" ? null : modal}
            prefill={modal === "new" ? cloneSource : null}
            onSave={handleSaved}
            onClose={() => { setModal(null); setCloneSource(null); }}
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

      {/* Schedules modal */}
      {schedulesContract && (
        <Modal
          title={`Sailing Schedules — ${schedulesContract.contractNumber}`}
          onClose={() => setSchedulesContract(null)}
          width={700}
        >
          <SchedulesModal
            contract={schedulesContract}
            onClose={() => setSchedulesContract(null)}
          />
        </Modal>
      )}

      {/* Route Legs modal — was labeled "Routings" before this feature, but it always meant
          "leg detail," not "named alternative path"; renamed to free up that word for the
          real contract_routings grouping, which this view now also groups legs by when any
          exist (falls back to one flat unlabeled list for a contract with none, unchanged). */}
      {routingContract && (
        <Modal
          title={`Route Legs — ${routingContract.contractNumber}`}
          onClose={() => setRoutingContract(null)}
          width={500}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {(() => {
              const legs = routingContract.legs || [];
              const routings = routingContract.routings || [];
              const ungrouped = legs.filter(l => !l.routingId || !routings.some(r => r.id === l.routingId));
              const groups = routings.length > 0
                ? [
                    ...routings.map(r => ({ routing: r, legs: legs.filter(l => l.routingId === r.id) })),
                    ...(ungrouped.length > 0 ? [{ routing: null, legs: ungrouped }] : []),
                  ]
                : [{ routing: null, legs }];
              return groups.map((group, gi) => (
                <div key={gi}>
                  {group.routing && (
                    <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.accent,
                      marginBottom: 8, textTransform: "uppercase", letterSpacing: ".05em" }}>
                      {group.routing.name || `Routing ${gi + 1}`}
                      {group.routing.transitDays > 0 && (
                        <span style={{ color: T.textMuted, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                          {" "}· {group.routing.transitDays}d total
                        </span>
                      )}
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {group.legs.map((leg, i) => (
                      <div key={i} style={{ background: T.bg, border: `1px solid ${T.border}`,
                        borderRadius: 8, padding: "12px 16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: leg.polName || leg.podName || leg.transitDays || leg.vesselService ? 8 : 0 }}>
                          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.border, fontWeight: 600,
                            background: T.surface, border: `1px solid ${T.border}`, borderRadius: 4,
                            padding: "1px 6px", flexShrink: 0 }}>
                            Leg {i + 1}
                          </span>
                          <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.accent }}>{leg.pol}</span>
                          <span style={{ fontFamily: T.mono, fontSize: 14, color: T.textMuted }}>›</span>
                          <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.accent }}>{leg.pod}</span>
                        </div>
                        {(leg.polName || leg.podName) && (
                          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 6 }}>
                            {leg.polName} <span style={{ color: T.border }}>›</span> {leg.podName}
                          </div>
                        )}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 20px" }}>
                          {leg.transitDays > 0 && (
                            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                              Transit: <span style={{ color: T.text }}>{leg.transitDays}d</span>
                            </span>
                          )}
                          {leg.vesselService && (
                            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                              Service: <span style={{ color: T.text }}>{leg.vesselService}</span>
                            </span>
                          )}
                          {(leg.polLinkedAllowed || leg.podLinkedAllowed) && (
                            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                              Linked ports:{" "}
                              <span style={{ color: T.text }}>
                                {[leg.polLinkedAllowed && "POL", leg.podLinkedAllowed && "POD"].filter(Boolean).join(", ")}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ));
            })()}
          </div>
        </Modal>
      )}
    </div>
  );
};

export default MdmContractsPage;
