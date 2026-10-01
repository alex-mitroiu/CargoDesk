import { useState, useEffect, useRef } from "react";
import useSaving from "../../hooks/useSaving";
import { T, IMDG_CLASSES, CONTAINER_OPTIONS as CONTAINER_OPTION_DEFS } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { toast } from "../../toast";
import Spinner from "../../components/primitives/Spinner";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Modal } from "../../components/primitives/Modal";
import { inputBase, Field } from "../../components/primitives/Form";
import DatePicker from "../../components/primitives/DatePicker";
import { IconPencil, IconClose, IconArrowUp, IconArrowDown, IconCalendar, IconClipboard } from "../../components/primitives/Icon";
import DataTable, { TableToolbar } from "../../components/shared/DataTable";
import useTableQuery from "../../hooks/useTableQuery";
import EntityHistoryModal from "../../components/shared/EntityHistoryModal";
import PortCombobox from "../../components/shared/PortCombobox";
import CustomerCombobox from "../../components/shared/CustomerCombobox";
import { CommodityCombobox } from "../../components/shared/CommodityCombobox";
import RoutingLinesEditor from "../../components/contracts/RoutingLinesEditor";
import { lineChain, chainLabel, findChainGaps, findDuplicateLines, tooManyLocations } from "../../utils/routingLines";

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


const EMPTY_FORM = {
  contractNumber: "", contractRef: "", carrierCode: "", namedAccountId: "", namedAccount: "",
  movementType: "FCL", containerTypes: [], commodityTypes: "", dgAllowed: false, imdgClasses: [],
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
// GET /api/contracts responses carry each leg/rate's real routingId (contract_routings.id).
// A routing keeps its id across saves as long as it is sent back with it (f.routings keeps the
// loaded `id`; a routing added here has none and gets a new one). Legs and rates still point at
// their routing by array index into f.routings (routingIndex), so adding, removing or
// reordering routings in the editor never needs id bookkeeping. This resolves the server's
// routingId strings to routingIndex once, right after a contract loads — -1 means "no routing"
// (the contract's single implicit bucket), matching every leg/rate on a contract with no named
// routings at all. Removing a routing a shipment still uses is refused by the server (409).
const resolveRoutingIndex = (items, routings) =>
  items.map(item => ({
    ...item,
    routingIndex: item.routingId ? routings.findIndex(r => r.id === item.routingId) : -1,
  }));

// Commodity types = codes from Master Data → Commodities (stored comma-separated), so a contract
// and a shipment name a commodity the same way and matching is exact. FAK is the registry's own
// code 9999; with nothing picked the server saves the contract as FAK.
const FAK_CODE = "9999";
const CommodityTypesField = ({ value, onChange }) => {
  const codes = String(value || "").split(/[\s,]+/).filter(Boolean);
  const [names, setNames] = useState({});
  const [pickerKey, setPickerKey] = useState(0);
  useEffect(() => {
    codes.filter(c => !(c in names)).forEach(c =>
      api.commodities.get(c).then(r => setNames(n => ({ ...n, [c]: r.description || "" }))).catch(() => setNames(n => ({ ...n, [c]: null }))));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const setCodes = next => onChange(next.join(","));
  return (
    <Field label="Commodity Types" hint="Picked from Master Data → Commodities, the same list a shipment's commodity uses. FAK (9999) covers every commodity; with nothing picked the contract is saved as FAK.">
      <div data-testid="contract-commodities" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: codes.length ? 8 : 0 }}>
        {codes.map(c => (
          <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 6,
            border: `1px solid ${names[c] === null ? T.danger : T.accent}55`, background: names[c] === null ? T.dangerBg : T.accentBg, fontSize: 12 }}>
            <span style={{ fontFamily: T.mono, fontWeight: 700, color: names[c] === null ? T.danger : T.accent }}>{c}</span>
            <span style={{ fontFamily: T.body, color: names[c] === null ? T.danger : T.textMuted }}>
              {names[c] === null ? "not in the commodity list" : (names[c] ?? "…")}
            </span>
            <button type="button" aria-label={`Remove commodity ${c}`} onClick={() => setCodes(codes.filter(x => x !== c))}
              style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 10, padding: 0 }}>✕</button>
          </span>
        ))}
      </div>
      <CommodityCombobox key={pickerKey} value="" placeholder={codes.length ? "Add another commodity…" : "Search commodities (FAK = 9999)…"}
        onChange={code => { if (code && !codes.includes(code)) setCodes([...codes, code]); setPickerKey(k => k + 1); }} />
      {codes.includes(FAK_CODE) && codes.length > 1 && (
        <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginTop: 6 }}>FAK already covers every commodity; the other codes only matter if FAK is removed.</div>
      )}
    </Field>
  );
};

const emptyLeg = routingIndex => ({ pol:"", polName:"", pod:"", podName:"", transitDays:0, vesselService:"", polLinkedAllowed:false, podLinkedAllowed:false, polCarrierHaulage:false, podCarrierHaulage:false, polHaulageLocations:"", podHaulageLocations:"", polLocType:"Terminal", podLocType:"Terminal", routingIndex });
const emptyRouting = () => ({ name: "", transitDays: 0, notes: "" });

// ─── Contract Modal Form ──────────────────────────────────────────────────────

const ContractModal = ({ editing, prefill, onSave, onClose }) => {
  const src = editing || prefill;
  const [f, setF] = useState(() => {
    // A new contract starts with one empty routing line, ready for its first leg.
    if (!src) return { ...EMPTY_FORM, routings: [emptyRouting()], legs: [emptyLeg(0)] };
    const routings = src.routings || [];
    return {
      contractNumber: src.contractNumber || "",
      contractRef:    src.contractRef    || "",
      carrierCode:    src.carrierCode    || "",
      namedAccountId: src.namedAccountId || "",
      namedAccount:   src.namedAccount   || "",
      movementType:   src.movementType   || "FCL",
      containerTypes: src.containerTypes || [],
      commodityTypes: src.commodityTypes || "",
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

  // routingIndex: an index into f.routings — the routing line the new leg belongs to (each
  // line's own "＋ Add leg" button passes its index).
  const addLeg = (routingIndex = -1) =>
    setF(p => ({ ...p, legs: [...p.legs, emptyLeg(routingIndex)] }));

  const removeLeg = i =>
    setF(p => ({ ...p, legs: p.legs.filter((_, idx) => idx !== i) }));

  // Every leg belongs to a routing line (src/utils/routingLines.js). A new line comes with its
  // first, empty leg. Legs/rates point at their line by array index (see resolveRoutingIndex).
  const addRouting = () =>
    setF(p => ({ ...p, routings: [...p.routings, emptyRouting()], legs: [...p.legs, emptyLeg(p.routings.length)] }));

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
    if (f.legs.length === 0) return toast.error("Add at least one routing line with a leg");
    // Every routing is ONE line (src/utils/routingLines.js; the server applies the same rules).
    for (let ri = 0; ri < f.routings.length; ri++) {
      const own = f.legs.filter(l => l.routingIndex === ri);
      if (!own.length) return toast.error(`Line ${ri + 1} has no legs — add one or remove the line`);
      const blank = own.findIndex(l => !l.pol || !l.pod);
      if (blank >= 0) return toast.error(`Line ${ri + 1}, leg ${blank + 1}: pick both the From and To port`);
      const gaps = findChainGaps(own);
      if (gaps.length > 0) return toast.error(`Line ${ri + 1}: leg ${gaps[0].afterLegPos} discharges at ${gaps[0].prevPod} but leg ${gaps[0].afterLegPos + 1} loads from ${gaps[0].nextPol}`);
      const many = tooManyLocations(own);
      if (many) return toast.error(`Line ${ri + 1}: one ${many} location per line — add another line for each additional location`);
    }
    const dups = findDuplicateLines(f.routings.length, f.legs);
    const firstDup = Object.keys(dups)[0];
    if (firstDup != null) return toast.error(`Line ${Number(firstDup) + 1} is the same routing as line ${dups[firstDup] + 1}`);
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

      {/* ── Section 3: Routing lines (approved mockup Option 1) ── */}
      <div style={sectionHeader()}>Routing lines <span style={{ color: T.danger }}>*</span></div>
      <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "-4px 0 10px", lineHeight: 1.5 }}>
        One line per routing: a connected run of legs with at most one pick-up and one delivery location. A contract can't list the same routing twice. Space configurations pick from these lines.
      </p>
      <RoutingLinesEditor routings={f.routings} legs={f.legs}
        onAddRouting={addRouting} onUpdateRouting={updateRouting} onRemoveRouting={removeRouting}
        onAddLeg={addLeg} onUpdateLeg={updateLeg} onRemoveLeg={removeLeg} />

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
          <button type="button"
            onClick={() => setF(p => ({
              ...p,
              containerTypes: p.containerTypes.length === CONTAINER_OPTIONS.length
                ? []
                : [...CONTAINER_OPTIONS],
            }))}
            style={chipStyle(f.containerTypes.length === CONTAINER_OPTIONS.length)}>
            All
          </button>
        </div>
      </Field>

      <div style={{ marginTop: 12 }}>
        <CommodityTypesField value={f.commodityTypes} onChange={v => setF(p => ({ ...p, commodityTypes: v }))} />
      </div>

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
                  {f.routings.map((rt, ri) => (
                    <option key={ri} value={ri}>
                      {`Line ${ri + 1} · ${rt.name || chainLabel(lineChain(f.legs.filter(l => l.routingIndex === ri))) || "new line"}`}
                    </option>
                  ))}
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

// Filterable columns — keys match routes/contracts.js's CONTRACT_COLUMNS. Module-level so
// useTableQuery gets stable arrays. `asOf` is the one non-column filter: a single "active on this
// date" value, kept as a plain param rather than a header checklist.
const CONTRACT_FILTER_KEYS = ["contractNumber", "carrier", "namedAccount", "route", "containerType", "dg", "validFrom", "validTo", "status"];
const CONTRACT_PARAM_KEYS = ["asOf"];
const CONTRACT_SORT_OPTIONS = [
  // Labels stay short: TableToolbar's sort select is 160px wide. "Newest/oldest" mean by Valid From.
  { value: "",               label: "Newest first" },
  { value: "oldest",         label: "Oldest first" },
  { value: "validTo",        label: "Expiring soonest" },
  { value: "contractNumber", label: "Contract # A–Z" },
  { value: "carrier",        label: "Carrier A–Z" },
];

const MdmContractsPage = ({ highlightContractId, onHighlightHandled } = {}) => {
  const { canManageConfigs } = useAuth();
  const [modal,            setModal]            = useState(null);
  const [cloneSource,      setCloneSource]      = useState(null);
  const [historyContract,   setHistoryContract]   = useState(null);
  const [routingContract,   setRoutingContract]   = useState(null);
  const [schedulesContract, setSchedulesContract] = useState(null);

  // Same table behavior as Shipments and Quotes (column-header checklists, search, sort, paging) —
  // see useTableQuery/DataTable. The old carrier/status/DG/container-type dropdowns and the Search
  // button are gone: each column's own header filter replaces its dropdown, and search runs as you
  // type, rather than keeping two possibly-disagreeing ways to filter one column.
  const t = useTableQuery({
    fetchPage: params => api.contracts.table(params),
    fetchOptions: () => api.contracts.filterOptions(),
    filterKeys: CONTRACT_FILTER_KEYS,
    paramKeys: CONTRACT_PARAM_KEYS,
  });

  // Deep-link from the notification bell's Contract Expiry section — open that specific
  // contract's edit modal directly rather than landing on the plain filtered list, since the
  // contract that expired may not even be on the first page of the default (unfiltered) sort.
  useEffect(() => {
    if (!highlightContractId) return;
    (async () => {
      try {
        const full = await api.contracts.get(highlightContractId);
        setModal(full);
      } catch (e) {
        toast.error(e.message || "Could not open that contract");
      } finally {
        onHighlightHandled?.();
      }
    })();
  }, [highlightContractId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaved = () => { setModal(null); setCloneSource(null); t.reload(); };

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
      t.reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const handlePublish = async id => {
    try {
      await api.contracts.publish(id);
      toast.success("Contract published — now selectable for shipments");
      t.reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const handleWithdraw = async id => {
    if (!window.confirm("Withdraw this contract back to Draft? It will no longer be selectable for new shipments.")) return;
    try {
      await api.contracts.withdraw(id);
      toast.success("Contract withdrawn to Draft");
      t.reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const dash = <span style={{ color: T.border }}>—</span>;

  // Each cell is the same markup the list always had; the header filter for a column reads the
  // matching key in routes/contracts.js's CONTRACT_COLUMNS, so what a cell shows is what its
  // checklist offers.
  const columns = [
    { key: "contractNumber", header: "Contract #", width: 130, filter: true,
      render: c => (
        <>
          <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>
            {c.contractNumber || "—"}
          </div>
          {c.contractRef && (
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.text, marginTop: 2 }}>{c.contractRef}</div>
          )}
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, marginTop: 2 }}>{c.id}</div>
        </>
      ) },
    { key: "carrier", header: "Carrier", width: 80, align: "center", filter: true,
      render: c => <Badge variant="info">{c.carrierCode || "—"}</Badge> },
    { key: "namedAccount", header: "Named Account", width: 130, filter: true,
      render: c => (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, maxWidth: "100%",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.namedAccount || dash}
        </div>
      ) },
    { key: "route", header: "Route", width: 180, filter: true,
      render: c => {
        const legs = c.legs || [];
        const routings = c.routings || [];
        if (legs.length === 0) return dash;
        return (
          <>
            <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 600 }}>
              {legs[0].pol} <span style={{ color: T.border }}>›</span> {legs[0].pod}
            </div>
            {(legs[0].polName || legs[0].podName) && (
              <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, marginTop: 1, maxWidth: "100%",
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
        );
      } },
    { key: "containerType", header: "Containers", width: 140, filter: true,
      render: c => {
        const ctypes = c.containerTypes || [];
        const shown = ctypes.slice(0, 3);
        const more  = ctypes.length - shown.length;
        return (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            {shown.map(ct => (
              <span key={ct} style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                color: T.textMuted, background: T.bg, border: `1px solid ${T.border}`,
                borderRadius: 4, padding: "1px 5px" }}>
                {ct}
              </span>
            ))}
            {more > 0 && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>+{more}</span>}
            {ctypes.length === 0 && dash}
          </div>
        );
      } },
    { key: "dg", header: "DG", width: 70, align: "center", filter: true,
      render: c => (c.dgAllowed ? <Badge variant="success">DG</Badge> : dash) },
    { key: "validFrom", header: "Valid From", width: 105, filter: true,
      render: c => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{c.validFrom || dash}</span> },
    { key: "validTo", header: "Valid To", width: 105, filter: true,
      render: c => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{c.validTo || dash}</span> },
    { key: "status", header: "Status", width: 100, align: "center", filter: true,
      render: c => <Badge variant={contractStatusVariant(c.status)}>{c.status}</Badge> },
  ];

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>
            Contracts
          </h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {t.total} contract{t.total !== 1 ? "s" : ""}
            {t.hasFilters ? " matching filters" : " in registry"}
          </p>
        </div>
        {canManageConfigs && <Btn size="lg" onClick={() => setModal("new")}>＋ New Contract</Btn>}
      </div>

      <TableToolbar tableId="contracts" search={t.filters.search} onSearch={t.setSearch}
        searchPlaceholder="Search contract #, carrier, account, route…"
        sort={t.sort} sortOptions={CONTRACT_SORT_OPTIONS} onSort={t.setSort}
        canClear={t.canClear} onClear={t.clear}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          Active as of
          <input type="date" data-testid="contracts-asof" value={t.filters.asOf}
            onChange={e => t.setParam("asOf", e.target.value)}
            title="Show only contracts valid on this date"
            style={{ ...inputBase, width: 140, fontFamily: T.mono, fontSize: 12 }} />
        </label>
      </TableToolbar>

      <DataTable tableId="contracts" columns={columns} rows={t.rows} loading={t.loading} rowKey={c => c.id} actionsWidth={80}
        hasFilters={t.hasFilters} filters={t.filters} filterOptions={t.options} onFilterChange={t.setColumnFilter}
        rowActions={c => [
          ...(canManageConfigs ? [{ icon: IconPencil,  label: "Edit",      onClick: () => setModal(c) }] : []),
          ...(canManageConfigs && c.status === "Draft"  ? [{ icon: IconArrowUp, label: "Publish",  onClick: () => handlePublish(c.id) }] : []),
          ...(canManageConfigs && c.status === "Active" ? [{ icon: IconArrowDown, label: "Withdraw to Draft", onClick: () => handleWithdraw(c.id) }] : []),
          ...(canManageConfigs ? [{ icon: "⧉",  label: "Duplicate", onClick: () => handleDuplicate(c) }] : []),
          { icon: IconCalendar, label: "Schedules",  onClick: () => setSchedulesContract(c) },
          { icon: IconClipboard, label: "History",   onClick: () => setHistoryContract(c) },
          ...(canManageConfigs ? [{ icon: IconClose,  label: "Delete",    variant: "danger", onClick: () => handleDelete(c.id) }] : []),
        ]}
        emptyMessage="No contracts yet. Create your first one above." emptyFilteredMessage="No contracts match your filters."
        pagination={{ total: t.total, offset: t.offset, limit: t.limit, onPage: t.goPage, onLimit: t.changeLimit }} />

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
