import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

// ─── API Client ────────────────────────────────────────────────────────────────

const BASE = "/api";

const req = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${res.status}`);
  }
  return res.json();
};

const api = {
  carriers: {
    list:   ()           => req("GET",    "/carriers"),
    create: (data)       => req("POST",   "/carriers", data),
    update: (code, data) => req("PUT",    `/carriers/${code}`, data),
    remove: (code)       => req("DELETE", `/carriers/${code}`),
  },
  shipments: {
    list:   ()        => req("GET",    "/shipments"),
    create: (data)    => req("POST",   "/shipments", data),
    update: (id, data)=> req("PUT",    `/shipments/${id}`, data),
    remove: (id)      => req("DELETE", `/shipments/${id}`),
  },
  containers: {
    list:   ()        => req("GET",    "/containers"),
    create: (data)    => req("POST",   "/containers", data),
    update: (id, data)=> req("PUT",    `/containers/${id}`, data),
    remove: (id)      => req("DELETE", `/containers/${id}`),
  },
  allocations: {
    list:   ()           => req("GET",    "/allocations"),
    create: (data)       => req("POST",   "/allocations", data),
    update: (id, data)   => req("PUT",    `/allocations/${id}`, data),
    remove: (id)         => req("DELETE", `/allocations/${id}`),
  },
  ports: {
    search: (params)     => req("GET",    `/port-locations?${new URLSearchParams(params)}`),
    get:    (code)       => req("GET",    `/port-locations/${code}`),
    create: (data)       => req("POST",   "/port-locations", data),
    update: (code, data) => req("PUT",    `/port-locations/${code}`, data),
    remove: (code)       => req("DELETE", `/port-locations/${code}`),
  },
  linkedPorts: {
    list:   ()           => req("GET",    "/linked-ports"),
    create: (data)       => req("POST",   "/linked-ports", data),
    update: (id, data)   => req("PUT",    `/linked-ports/${id}`, data),
    remove: (id)         => req("DELETE", `/linked-ports/${id}`),
  },
  regions: {
    list:   ()           => req("GET",    "/regions"),
    create: (data)       => req("POST",   "/regions", data),
    update: (code, data) => req("PUT",    `/regions/${code}`, data),
    remove: (code)       => req("DELETE", `/regions/${code}`),
  },
  countries: {
    list:   (p = {})     => req("GET",    `/countries?${new URLSearchParams(p)}`),
    create: (data)       => req("POST",   "/countries", data),
    update: (iso2, data) => req("PUT",    `/countries/${iso2}`, data),
    remove: (iso2)       => req("DELETE", `/countries/${iso2}`),
  },
  unlocodes: {
    search: (p = {})          => req("GET",    `/unlocodes?${new URLSearchParams(p)}`),
  },
  tradeLanes: {
    list:          ()              => req("GET",    "/trade-lanes"),
    create:        (data)          => req("POST",   "/trade-lanes", data),
    update:        (code, data)    => req("PUT",    `/trade-lanes/${code}`, data),
    remove:        (code)          => req("DELETE", `/trade-lanes/${code}`),
    getCountries:  (code)          => req("GET",    `/trade-lanes/${code}/countries`),
    setCountries:  (code, iso2s)   => req("PUT",    `/trade-lanes/${code}/countries`, { iso2s }),
  },
  countryLocations: {
    list: (iso2, p = {})      => req("GET",    `/countries/${iso2}/locations?${new URLSearchParams(p)}`),
  },
  countryLanes: {
    set: (iso2, lanes)        => req("PUT",    `/countries/${iso2}/trade-lanes`, { lanes }),
  },
  vessels: {
    search: (q = "")          => req("GET",    `/vessels/search?q=${encodeURIComponent(q)}`),
    list:   (p = {})          => req("GET",    `/vessels?${new URLSearchParams(p)}`),
    get:    (imo)             => req("GET",    `/vessels/${imo}`),
    create: (data)            => req("POST",   "/vessels", data),
    update: (imo, data)       => req("PUT",    `/vessels/${imo}`, data),
    remove: (imo)             => req("DELETE", `/vessels/${imo}`),
  },
};

// ─── Constants ────────────────────────────────────────────────────────────────

const CONTRACT_PRESETS = ["Pending", "SPOT", "Customer Own"];
const CONTAINER_TYPES = ["DC", "RF", "OT", "FR", "TK"];
const STATUSES = ["Active", "Pending", "Completed", "Cancelled"];
const teuOf = (size) => (size === "40" ? 2 : 1);

// ─── Design Tokens ────────────────────────────────────────────────────────────

const T = {
  // Layout
  bg: "#080f1a", surface: "#0e1c2f", surfaceHover: "#122338",
  border: "#1a3354", borderMid: "#213f65",
  // Brand
  accent: "#e8a217", accentBg: "rgba(232,162,23,0.12)", accentHover: "#f0b428",
  // Text
  text: "#dde8f5", textMuted: "#587a9b", textCode: "#60b8f0",
  // Semantic
  success: "#2dcc8f", successBg: "rgba(45,204,143,0.10)",
  danger:  "#ef5050", dangerBg:  "rgba(239,80,80,0.10)",
  warning: "#f5b84c", warningBg: "rgba(245,184,76,0.10)",
  info:    "#4db3e8", infoBg:    "rgba(77,179,232,0.10)",
  // Button-specific
  btnPrimaryText: "#07111e",
  btnSecondaryHoverBg: "#112030",
  btnDangerHoverBg: "rgba(239,80,80,0.12)",
  // Typography
  mono: "'IBM Plex Mono', monospace",
  head: "'Syne', sans-serif",
  body: "'DM Sans', sans-serif",
};

// ─── Primitives ───────────────────────────────────────────────────────────────

const Badge = ({ children, variant = "default" }) => {
  const v = {
    default: { bg: T.surface,     c: T.textMuted },
    success: { bg: T.successBg,   c: T.success },
    warning: { bg: T.warningBg,   c: T.warning },
    danger:  { bg: T.dangerBg,    c: T.danger },
    info:    { bg: T.infoBg,      c: T.info },
    amber:   { bg: T.accentBg,    c: T.accent },
  }[variant] || { bg: T.surface, c: T.textMuted };
  return (
    <span style={{ background: v.bg, color: v.c, fontFamily: T.mono, fontSize: 10.5, fontWeight: 600,
      padding: "2px 9px", borderRadius: 4, letterSpacing: ".06em", whiteSpace: "nowrap", display: "inline-block" }}>
      {children}
    </span>
  );
};

const Btn = ({ children, onClick, variant = "primary", size = "md", disabled, style: extra }) => {
  const [hov, setHov] = useState(false);
  const styles = {
    primary: {
      base:  { background: T.accent,        color: T.btnPrimaryText, border: "none" },
      hover: { background: T.accentHover,   color: T.btnPrimaryText, border: "none" },
    },
    secondary: {
      base:  { background: "transparent",       color: T.textMuted, border: `1px solid ${T.border}` },
      hover: { background: T.btnSecondaryHoverBg, color: T.text,    border: `1px solid ${T.borderMid}` },
    },
    danger: {
      base:  { background: "transparent",      color: T.danger, border: `1px solid ${T.danger}55` },
      hover: { background: T.btnDangerHoverBg, color: T.danger, border: `1px solid ${T.danger}` },
    },
    ghost: {
      base:  { background: "transparent",       color: T.textMuted, border: "none" },
      hover: { background: T.btnSecondaryHoverBg, color: T.text,   border: "none" },
    },
  }[variant] || {};
  const sizeStyle = {
    sm: { padding: "4px 11px",  fontSize: 11.5, borderRadius: 5 },
    md: { padding: "7px 16px",  fontSize: 13,   borderRadius: 6 },
    lg: { padding: "10px 22px", fontSize: 14,   borderRadius: 7 },
  }[size];
  const v = hov && !disabled ? styles.hover : styles.base;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        ...v, ...sizeStyle,
        fontFamily: T.body, fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.42 : 1,
        display: "inline-flex", alignItems: "center", gap: 6,
        transition: "background 0.14s, border-color 0.14s, color 0.14s",
        ...extra,
      }}
    >
      {children}
    </button>
  );
};

// BtnToggle — unified selected/unselected toggle button (contract type, container size, etc.)
const BtnToggle = ({ children, selected, onClick, wide, sub }) => {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        flex: wide ? 1 : undefined,
        padding: sub ? "9px 14px" : "6px 14px",
        borderRadius: 6,
        fontFamily: T.body, fontSize: 13, fontWeight: 600,
        cursor: "pointer",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
        border: `1px solid ${selected ? T.accent : hov ? T.borderMid : T.border}`,
        background: selected ? T.accentBg : hov ? T.btnSecondaryHoverBg : "transparent",
        color: selected ? T.accent : hov ? T.text : T.textMuted,
        transition: "background 0.14s, border-color 0.14s, color 0.14s",
      }}
    >
      <span style={{ fontFamily: sub ? T.mono : T.body, fontWeight: 700 }}>{children}</span>
      {sub && <span style={{ fontSize: 10, opacity: 0.65 }}>{sub}</span>}
    </button>
  );
};

const Field = ({ label, required, hint, children }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
    {label && (
      <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
        <label style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>
          {label}{required && <span style={{ color: T.danger }}> *</span>}
        </label>
        {hint && <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.border }}>{hint}</span>}
      </div>
    )}
    {children}
  </div>
);

const inputBase = {
  background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6,
  padding: "8px 12px", color: T.text, outline: "none", width: "100%", boxSizing: "border-box",
};

const Inp = ({ label, value, onChange, placeholder, mono, maxLength, required, hint, type = "text" }) => (
  <Field label={label} required={required} hint={hint}>
    <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
      maxLength={maxLength} type={type}
      style={{ ...inputBase, fontFamily: mono ? T.mono : T.body, fontSize: mono ? 13 : 14 }} />
  </Field>
);

const Sel = ({ label, value, onChange, options, required }) => (
  <Field label={label} required={required}>
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ ...inputBase, fontFamily: T.body, fontSize: 14, cursor: "pointer" }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </Field>
);

const Textarea = ({ label, value, onChange, placeholder, rows = 3 }) => (
  <Field label={label}>
    <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows}
      style={{ ...inputBase, fontFamily: T.body, fontSize: 14, resize: "vertical" }} />
  </Field>
);

const Modal = ({ title, onClose, children, width = 520 }) => (
  <div onClick={e => e.target === e.currentTarget && onClose()}
    style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
      width: "100%", maxWidth: width, maxHeight: "90vh", overflowY: "auto",
      boxShadow: "0 30px 70px rgba(0,0,0,.65)" }}>
      <div style={{ padding: "18px 24px", borderBottom: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontFamily: T.head, fontSize: 18, fontWeight: 700, color: T.text, margin: 0 }}>{title}</h2>
        <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted,
          cursor: "pointer", fontSize: 22, lineHeight: 1, padding: "0 4px",
          borderRadius: 4, transition: "color 0.14s" }}
          onMouseEnter={e => e.currentTarget.style.color = T.text}
          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>×</button>
      </div>
      <div style={{ padding: "22px 24px" }}>{children}</div>
    </div>
  </div>
);

const ConfirmModal = ({ message, onConfirm, onCancel }) => (
  <Modal title="Confirm" onClose={onCancel} width={380}>
    <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, margin: "0 0 20px", lineHeight: 1.6 }}>{message}</p>
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
      <Btn variant="danger" onClick={onConfirm}>Confirm Delete</Btn>
    </div>
  </Modal>
);

// ─── Shared: Contract Type Picker ─────────────────────────────────────────────

const ContractTypeInput = ({ value, onChange }) => (
  <div>
    <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
      Contract Type <span style={{ color: T.danger }}>*</span>
    </div>
    <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
      {CONTRACT_PRESETS.map(t => (
        <BtnToggle key={t} selected={value === t} onClick={() => onChange(t)}>{t}</BtnToggle>
      ))}
    </div>
    <input value={value} onChange={e => onChange(e.target.value)}
      placeholder="Or type a custom contract type…"
      style={{ ...inputBase, fontFamily: T.body, fontSize: 14 }} />
  </div>
);

// ─── Forms ────────────────────────────────────────────────────────────────────

const CarrierForm = ({ init = {}, onSave, onCancel, existing = [] }) => {
  const [code, setCode] = useState(init.code || "");
  const [name, setName] = useState(init.name || "");
  const isEdit = !!init.code;
  const codeClean = code.trim().toUpperCase();
  const dupCode = !isEdit && existing.some(c => c.code === codeClean);
  const valid = codeClean.length >= 2 && codeClean.length <= 6 && name.trim().length >= 2 && !dupCode;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Inp label="Carrier Code" value={code} onChange={v => setCode(v.toUpperCase())}
        placeholder="HLCU" mono maxLength={6} required hint="2–6 uppercase chars (e.g. MAEU, HLCU)" />
      {dupCode && <div style={{ fontFamily: T.body, fontSize: 12, color: T.danger }}>A carrier with code "{codeClean}" already exists.</div>}
      <Inp label="Carrier Name" value={name} onChange={setName} placeholder="Hapag-Lloyd" required />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => valid && onSave({ code: codeClean, name: name.trim() })} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Carrier"}
        </Btn>
      </div>
    </div>
  );
};

const ShipmentForm = ({ init = {}, carriers, onSave, onCancel }) => {
  const [polPort, setPolPort] = useState(init.pol ? { unlocode: init.pol, name: "" } : null);
  const [podPort, setPodPort] = useState(init.pod ? { unlocode: init.pod, name: "" } : null);
  const [f, setF] = useState({
    carrierCode:   init.carrierCode   || carriers[0]?.code || "",
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
  });
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const valid = polPort?.unlocode?.length === 5 && podPort?.unlocode?.length === 5
    && f.carrierCode && f.contractType.trim().length > 0 && f.incoterm !== "";

  const handleSave = () => {
    if (!valid) return;
    onSave({ ...f, pol: polPort.unlocode, pod: podPort.unlocode });
  };

  const PortField = ({ label, port, onSelect, placeholder }) => (
    <Field label={label} required>
      {port?.unlocode ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ flex: 1, background: T.bg, border: `1px solid ${T.accent}55`, borderRadius: 6,
            padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{port.unlocode}</span>
            {port.name && <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{port.name}</span>}
          </div>
          <button onClick={() => onSelect(null)}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
              color: T.textMuted, cursor: "pointer", padding: "6px 10px", fontSize: 12 }}>✕</button>
        </div>
      ) : (
        <PortCombobox placeholder={placeholder} onChange={onSelect} />
      )}
    </Field>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {carriers.length === 0 && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8,
          padding: "12px 16px", fontFamily: T.body, fontSize: 13, color: T.warning }}>
          ⚠ No carriers in registry. Add a carrier first before creating a shipment.
        </div>
      )}

      {/* Ports */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <PortField label="Port of Loading"   port={polPort} onSelect={setPolPort} placeholder="Search POL (NLRTM, Rotterdam…)" />
        <PortField label="Port of Discharge" port={podPort} onSelect={setPodPort} placeholder="Search POD (CNSHA, Shanghai…)" />
      </div>

      {/* Carrier */}
      {carriers.length > 0 && (
        <Sel label="Carrier" value={f.carrierCode} onChange={set("carrierCode")} required
          options={carriers.map(c => ({ value: c.code, label: `${c.code} – ${c.name}` }))} />
      )}

      {/* Incoterm — mandatory */}
      <Sel label="Incoterm" value={f.incoterm} onChange={set("incoterm")} required
        options={[
          { value: "", label: "Select incoterm…" },
          ...INCOTERMS_2020.map(t => ({ value: t.code, label: `${t.code} – ${t.name}` })),
        ]}
      />

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
      <ContractTypeInput value={f.contractType} onChange={set("contractType")} />
      <Textarea label="Contract Notes" value={f.contractNotes} onChange={set("contractNotes")}
        placeholder="Optional reference, contract IDs, remarks…" rows={2} />
      <Sel label="Status" value={f.status} onChange={set("status")}
        options={STATUSES.map(s => ({ value: s, label: s }))} />

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={!valid || carriers.length === 0}>
          {init.id ? "Save Changes" : "Create Shipment"}
        </Btn>
      </div>
    </div>
  );
};

const ContainerForm = ({ init = {}, onSave, onCancel }) => {
  const [f, setF] = useState({ number: init.number || "", size: init.size || "40", type: init.type || "DC" });
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const typeLabel = { DC: "Dry", RF: "Reefer", OT: "Open Top", FR: "Flat Rack", TK: "Tank" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Inp label="Container Number" value={f.number}
        onChange={v => set("number")(v.toUpperCase().replace(/\s/g, ""))}
        placeholder="MAEU1234567" mono required />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Size">
          <div style={{ display: "flex", gap: 8 }}>
            {["20", "40"].map(sz => (
              <BtnToggle key={sz} selected={f.size === sz} onClick={() => set("size")(sz)} wide sub={sz === "20" ? "1 TEU" : "2 TEU"}>
                {sz}ft
              </BtnToggle>
            ))}
          </div>
        </Field>
        <Sel label="Equipment Type" value={f.type} onChange={set("type")}
          options={CONTAINER_TYPES.map(t => ({ value: t, label: `${t} – ${typeLabel[t] || t}` }))} />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => f.number.length >= 4 && onSave(f)} disabled={f.number.length < 4}>
          {init.id ? "Update Container" : "Add Container"}
        </Btn>
      </div>
    </div>
  );
};

const AllocationForm = ({ init = {}, carriers, onSave, onCancel }) => {
  const isEdit = !!init.id;
  const [carrierCode,    setCarrierCode]    = useState(init.carrierCode   || carriers[0]?.code || "");
  const [teuStr,         setTeuStr]         = useState(init.allocatedTEU  ? String(init.allocatedTEU) : "");
  const [effectiveDate,  setEffectiveDate]  = useState(init.effectiveDate || "");
  const [endDate,        setEndDate]        = useState(init.endDate       || "");
  const [serverErr,      setServerErr]      = useState("");

  useEffect(() => {
    if (!carrierCode && carriers.length > 0) setCarrierCode(carriers[0].code);
  }, [carriers]);

  const handleEffectiveChange = val => {
    setEffectiveDate(val);
    setServerErr("");
    if (endDate && val && endDate < val) setEndDate(val);
    if (endDate && val) {
      const maxEnd = addDays(val, 90);
      if (endDate > maxEnd) setEndDate(maxEnd);
    }
  };

  const teu   = parseInt(teuStr) || 0;
  const valid = carrierCode && teu > 0 && effectiveDate && endDate && endDate >= effectiveDate;

  const handleSave = async () => {
    if (!valid) return;
    try {
      await onSave({ carrierCode, allocatedTEU: teu, effectiveDate, endDate });
    } catch (e) {
      setServerErr(e.message || "Could not save — check for overlapping periods.");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Sel label="Carrier" value={carrierCode} onChange={v => { setCarrierCode(v); setServerErr(""); }} required
        options={carriers.map(c => ({ value: c.code, label: `${c.code} – ${c.name}` }))} />
      <Inp label="Allocated Space (TEU)" value={teuStr} onChange={setTeuStr}
        type="number" placeholder="100" required hint="Total TEU awarded by this carrier for the period" />

      {/* Date range — mandatory */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 12 }}>
          Effective Period <span style={{ color: T.danger }}>*</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <DatePicker
            label="Effective From"
            value={effectiveDate}
            onChange={handleEffectiveChange}
            placeholder="Start date…"
          />
          <DatePicker
            label="Effective To"
            value={endDate}
            onChange={v => { setEndDate(v); setServerErr(""); }}
            minDate={effectiveDate || undefined}
            maxDate={effectiveDate ? addDays(effectiveDate, 90) : undefined}
            placeholder="End date…"
            disabled={!effectiveDate}
          />
        </div>
        {effectiveDate && endDate && (
          <div style={{ marginTop: 8, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
            {diffDays(effectiveDate, endDate) + 1} day period
            · max 90 days per configuration
          </div>
        )}
      </div>

      {serverErr && (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.danger, background: T.dangerBg,
          border: `1px solid ${T.danger}44`, borderRadius: 6, padding: "8px 12px" }}>
          {serverErr}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Configuration"}
        </Btn>
      </div>
    </div>
  );
};

// ─── Page: Carrier Registry ───────────────────────────────────────────────────

const CarriersPage = ({ carriers, onAdd, onEdit, onDelete }) => {
  const [modal, setModal]   = useState(null); // null | "add" | carrier obj
  const [confirm, setConfirm] = useState(null);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Carrier Registry</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {carriers.length} carrier{carriers.length !== 1 ? "s" : ""} · reference database for shipments &amp; allocations
          </p>
        </div>
        <Btn onClick={() => setModal("add")} size="lg">＋ Add Carrier</Btn>
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 160px",
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Code", "Name", "Actions"].map((h, i) => (
            <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
          ))}
        </div>

        {carriers.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No carriers yet. Add your first carrier above.
          </div>
        ) : carriers.map(c => (
          <div key={c.code} style={{ display: "grid", gridTemplateColumns: "130px 1fr 160px",
            padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
            transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{c.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{c.name}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" variant="secondary" onClick={() => setModal(c)}>✎ Edit</Btn>
              <Btn size="sm" variant="danger"    onClick={() => setConfirm(c.code)}>✕ Remove</Btn>
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Carrier" onClose={() => setModal(null)}>
          <CarrierForm existing={carriers}
            onSave={data => { onAdd(data); setModal(null); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Carrier" onClose={() => setModal(null)}>
          <CarrierForm init={modal} existing={carriers}
            onSave={data => { onEdit(modal.code, data); setModal(null); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Remove carrier "${confirm}" from the registry? Existing shipments referencing this code will not be deleted.`}
          onConfirm={() => { onDelete(confirm); setConfirm(null); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── Page: Shipments List ─────────────────────────────────────────────────────

const statusVariant  = s => ({ Active: "success", Pending: "warning", Completed: "info", Cancelled: "danger" }[s] || "default");
const contractVariant = c => ({ SPOT: "info", "Customer Own": "amber", Pending: "warning" }[c] || "default");

const ShipmentsPage = ({ shipments, containers, carriers, onSelect, onDelete, onNew }) => {
  const [confirm, setConfirm] = useState(null);
  const teuFor = id => containers.filter(c => c.shipmentId === id).reduce((s, c) => s + teuOf(c.size), 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Shipments</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {shipments.length} total · {shipments.filter(s => s.status === "Active").length} active
          </p>
        </div>
        <Btn onClick={onNew} size="lg" disabled={carriers.length === 0}>＋ New Shipment</Btn>
      </div>

      {carriers.length === 0 && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8,
          padding: "12px 18px", fontFamily: T.body, fontSize: 13, color: T.warning, marginBottom: 18 }}>
          ⚠ Carrier Registry is empty. Go to <strong>Carrier Registry</strong> and add at least one carrier before creating shipments.
        </div>
      )}

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "140px 70px 70px 1fr 165px 60px 110px 110px",
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Shipment ID", "POL", "POD", "Carrier", "Contract", "TEU", "Status", ""].map((h, i) => (
            <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
          ))}
        </div>

        {shipments.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No shipments yet. Create your first one above.
          </div>
        ) : shipments.map(s => {
          const carrier = carriers.find(c => c.code === s.carrierCode);
          return (
            <div key={s.id} onClick={() => onSelect(s.id)}
              style={{ display: "grid", gridTemplateColumns: "140px 70px 70px 1fr 165px 60px 110px 110px",
                padding: "14px 20px", borderBottom: `1px solid ${T.border}22`,
                cursor: "pointer", alignItems: "center", transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textCode, fontWeight: 700 }}>{s.id}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pol}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pod}</span>
              <div>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{s.carrierCode}</span>
                {carrier && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}> · {carrier.name}</span>}
              </div>
              <Badge variant={contractVariant(s.contractType)}>{s.contractType}</Badge>
              <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>{teuFor(s.id)}</span>
              <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
              <Btn size="sm" variant="danger" onClick={e => { e.stopPropagation(); setConfirm(s.id); }}>
                ✕ Remove
              </Btn>
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
    </div>
  );
};

// ─── Page: Shipment Detail ────────────────────────────────────────────────────

const ShipmentDetailPage = ({ shipment, containers, carriers, onBack, onUpdate, onAddContainer, onEditContainer, onDeleteContainer }) => {
  const [ctrModal,  setCtrModal]  = useState(null); // null | "add" | container obj
  const [editShp,   setEditShp]   = useState(false);
  const [confirmCtr, setConfirmCtr] = useState(null);
  const carrier  = carriers.find(c => c.code === shipment.carrierCode);
  const ctrs     = containers.filter(c => c.shipmentId === shipment.id);
  const totalTEU = ctrs.reduce((s, c) => s + teuOf(c.size), 0);

  const InfoCard = ({ label, value, color, mono }) => (
    <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px" }}>
      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: mono ? T.mono : T.body, fontSize: 16, fontWeight: 700,
        color: color || T.text, wordBreak: "break-word" }}>{value}</div>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
        <Btn variant="secondary" onClick={onBack}>← Back</Btn>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ fontFamily: T.head, fontSize: 24, fontWeight: 800, color: T.text, margin: 0 }}>{shipment.id}</h1>
            <Badge variant={statusVariant(shipment.status)}>{shipment.status}</Badge>
          </div>
          <p style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted, margin: "3px 0 0" }}>
            {shipment.pol} → {shipment.pod} · created {shipment.createdAt}
          </p>
        </div>
        <Btn variant="secondary" onClick={() => setEditShp(true)}>✎ Edit Shipment</Btn>
      </div>

      {/* Info cards row 1 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 14 }}>
        <InfoCard label="Port of Loading"   value={shipment.pol} color={T.textCode} mono />
        <InfoCard label="Port of Discharge" value={shipment.pod} color={T.textCode} mono />
        <InfoCard label="Carrier" value={`${shipment.carrierCode}${carrier ? ` · ${carrier.name}` : ""}`} color={T.accent} mono />
        <InfoCard label="Total TEU" value={`${totalTEU} TEU`} mono />
      </div>

      {/* Info cards row 2 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 22 }}>
        <InfoCard label="ETD" value={shipment.etd || "—"} mono />
        <InfoCard label="ETA" value={shipment.eta || "—"} mono />
        <InfoCard label="Vessel"
          value={shipment.vessel || (shipment.vesselImo ? shipment.vesselImo : "—")}
          color={shipment.vessel ? T.text : T.border}
          sub={shipment.vesselImo ? `IMO ${shipment.vesselImo}` : null}
        />
        <InfoCard label="Voyage" value={shipment.voyage || "—"} mono />
      </div>

      {/* Contract + references */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "16px 20px", marginBottom: 22 }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 12 }}>Contract &amp; References</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 14 }}>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Contract Type</div>
            <Badge variant={contractVariant(shipment.contractType)}>{shipment.contractType}</Badge>
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Incoterm</div>
            {shipment.incoterm
              ? <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textCode, fontWeight: 700 }}>
                  {shipment.incoterm}
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontWeight: 400, marginLeft: 6 }}>
                    {INCOTERMS_2020.find(t => t.code === shipment.incoterm)?.name || ""}
                  </span>
                </span>
              : <span style={{ fontFamily: T.body, fontSize: 13, color: T.border }}>—</span>
            }
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Booking Ref</div>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.bookingRef ? T.textCode : T.border }}>{shipment.bookingRef || "—"}</span>
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>B/L Number</div>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.blNumber ? T.textCode : T.border }}>{shipment.blNumber || "—"}</span>
          </div>
        </div>
        {shipment.contractNotes && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}33` }}>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Notes</div>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.6 }}>{shipment.contractNotes}</span>
          </div>
        )}
      </div>

      {/* Cargo Details */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "15px 20px", borderBottom: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 style={{ fontFamily: T.head, fontSize: 17, fontWeight: 700, color: T.text, margin: 0 }}>Cargo Details</h2>
            <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "2px 0 0" }}>
              {ctrs.length} container{ctrs.length !== 1 ? "s" : ""} · {totalTEU} TEU total
            </p>
          </div>
          <Btn onClick={() => setCtrModal("add")}>＋ Add Container</Btn>
        </div>

        {ctrs.length === 0 ? (
          <div style={{ padding: 36, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No containers yet. Add one above.
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 130px 70px 140px",
              padding: "9px 20px", borderBottom: `1px solid ${T.border}` }}>
              {["Container No.", "Size", "Type", "TEU", "Actions"].map((h, i) => (
                <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
              ))}
            </div>
            {ctrs.map(c => (
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: "1fr 90px 130px 70px 140px",
                padding: "12px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textCode, fontWeight: 600 }}>{c.number}</span>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{c.size}ft</span>
                <Badge>{c.type}</Badge>
                <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.text }}>{teuOf(c.size)}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn size="sm" variant="secondary" onClick={() => setCtrModal(c)}>Edit</Btn>
                  <Btn size="sm" variant="danger"    onClick={() => setConfirmCtr(c.id)}>✕</Btn>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Modals */}
      {ctrModal && (
        <Modal title={ctrModal === "add" ? "Add Container" : "Edit Container"} onClose={() => setCtrModal(null)}>
          <ContainerForm init={ctrModal === "add" ? {} : ctrModal}
            onSave={form => {
              ctrModal === "add" ? onAddContainer(shipment.id, form) : onEditContainer(ctrModal.id, form);
              setCtrModal(null);
            }}
            onCancel={() => setCtrModal(null)} />
        </Modal>
      )}
      {editShp && (
        <Modal title="Edit Shipment" onClose={() => setEditShp(false)} width={560}>
          <ShipmentForm init={shipment} carriers={carriers}
            onSave={form => { onUpdate(shipment.id, form); setEditShp(false); }}
            onCancel={() => setEditShp(false)} />
        </Modal>
      )}
      {confirmCtr && (
        <ConfirmModal
          message="Remove this container from the shipment?"
          onConfirm={() => { onDeleteContainer(confirmCtr); setConfirmCtr(null); }}
          onCancel={() => setConfirmCtr(null)} />
      )}
    </div>
  );
};

// ─── Page: Dashboard ──────────────────────────────────────────────────────────

// ─── Date range helpers ────────────────────────────────────────────────────────

const addDays      = (isoStr, n) => { const d = new Date(isoStr + "T12:00:00"); d.setDate(d.getDate() + n); return toIso(d); };
const diffDays     = (a, b)      => Math.round((new Date(b+"T12:00:00") - new Date(a+"T12:00:00")) / 86400000);
const currentWeekStart = () => {
  const d = new Date(); const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return toIso(d);
};
const MAX_RANGE_DAYS = 90;

const DashboardPage = ({ shipments, containers, carriers, allocations, onAddAlloc, onEditAlloc, onDeleteAlloc }) => {
  const [allocModal,   setAllocModal]   = useState(null);
  const [confirmAlloc, setConfirmAlloc] = useState(null);
  const [rangePickerOpen, setRangePickerOpen] = useState(false);

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

  // Shipments with ETD (or createdAt) in range
  const rangeShipments = useMemo(() => shipments.filter(s => {
    const ref = s.etd || s.createdAt || "";
    return ref >= rangeStart && ref <= rangeEnd;
  }), [shipments, rangeStart, rangeEnd]);

  // TEU consumed per carrier — all shipments in range, all contract types
  const consumedMap = useMemo(() => {
    const m = {};
    rangeShipments.forEach(s => {
      const teu = containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size), 0);
      m[s.carrierCode] = (m[s.carrierCode] || 0) + teu;
    });
    return m;
  }, [rangeShipments, containers]);

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
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Consumption Dashboard</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            TEU allocation &amp; consumption · 20ft = 1 TEU · 40ft = 2 TEU
          </p>
        </div>
      </div>

      {/* ── Date range picker ── */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "16px 20px", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
          {/* Navigation */}
          <Btn variant="secondary" size="sm" onClick={() => shiftRange(-1)}>← Prev</Btn>

          {/* Date range pickers */}
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "end" }}>
            <DatePicker
              label="From"
              value={rangeStart}
              onChange={handleStartChange}
              placeholder="Start date…"
            />
            <div style={{ fontFamily: T.mono, fontSize: 18, color: T.textMuted, paddingBottom: 9, userSelect: "none" }}>—</div>
            <DatePicker
              label="To"
              value={rangeEnd}
              onChange={handleEndChange}
              minDate={rangeStart}
              maxDate={rangeStart ? addDays(rangeStart, MAX_RANGE_DAYS) : undefined}
              placeholder="End date…"
            />
          </div>

          <Btn variant="secondary" size="sm" onClick={() => shiftRange(1)}>Next →</Btn>
          <Btn variant="ghost" size="sm" onClick={goToday}
            style={{ borderLeft: `1px solid ${T.border}`, paddingLeft: 14 }}>
            This Week
          </Btn>
        </div>

        {/* Range summary */}
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

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 26 }}>
        {[
          { label: "Total Allocated",      value: totalAlloc,    color: T.text,    sub: `${allocations.length} configuration${allocations.length !== 1 ? "s" : ""}` },
          { label: "Active Consumption",   value: totalConsumed, color: T.success, sub: `${totalAlloc > 0 ? ((totalConsumed / totalAlloc) * 100).toFixed(1) : 0}% of total utilized` },
          { label: "Remaining Capacity",   value: totalRemain,   color: T.accent,  sub: "available to book" },
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

      {/* Bar Chart */}
      {chartData.length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "24px", marginBottom: 22 }}>
          <h2 style={{ fontFamily: T.head, fontSize: 17, fontWeight: 700, color: T.text, margin: "0 0 4px" }}>TEU by Carrier</h2>
          <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "0 0 20px" }}>
            Remaining / Active Consumption / Total Awarded — all contracts combined per carrier
          </p>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
              <XAxis dataKey="carrier" tick={{ fontFamily: T.mono, fontSize: 12, fill: T.textMuted }} axisLine={{ stroke: T.border }} tickLine={false} />
              <YAxis tick={{ fontFamily: T.body, fontSize: 11, fill: T.textMuted }} axisLine={false} tickLine={false} />
              <Tooltip content={<TooltipContent />} cursor={{ fill: T.border + "44" }} />
              <Legend wrapperStyle={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, paddingTop: 14 }} />
              <Bar dataKey="consumed"  name="Active Consumption" stackId="s" fill={T.success} />
              <Bar dataKey="remaining" name="Remaining"          stackId="s" fill={T.borderMid} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Space Configuration Table */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "15px 20px", borderBottom: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 style={{ fontFamily: T.head, fontSize: 17, fontWeight: 700, color: T.text, margin: 0 }}>Space Configurations</h2>
            <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "2px 0 0" }}>
              Awarded TEU per carrier &amp; contract — click ✎ to edit, ＋ to add a new one
            </p>
          </div>
          <Btn onClick={() => setAllocModal("add")} disabled={carriers.length === 0}>＋ Add Configuration</Btn>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 100px 150px 110px 110px 130px",
          padding: "9px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Carrier", "Name", "TEU", "Effective Period", "Consumed", "Remaining", "Actions"].map((h, i) => (
            <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
          ))}
        </div>

        {allocations.length === 0 ? (
          <div style={{ padding: 36, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No configurations yet. Use "+ Add Configuration" to set up carrier space allocations.
          </div>
        ) : allocations.map(a => {
          const isActive  = activeAllocations.some(x => x.id === a.id);
          const consumed  = isActive ? (consumedMap[a.carrierCode] || 0) : 0;
          const remaining = Math.max(0, a.allocatedTEU - consumed);
          const pct       = a.allocatedTEU > 0 ? (consumed / a.allocatedTEU) * 100 : 0;
          const carrier   = carriers.find(c => c.code === a.carrierCode);
          return (
            <div key={a.id}
              style={{ display: "grid", gridTemplateColumns: "90px 1fr 100px 150px 110px 110px 130px",
                padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                opacity: isActive ? 1 : 0.45, transition: "background .1s, opacity .2s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{a.carrierCode}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{carrier?.name || "—"}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{a.allocatedTEU} TEU</span>
                {isActive && (
                  <>
                    <div style={{ background: T.border, borderRadius: 4, height: 4, width: 72, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.min(100, pct)}%`,
                        background: pct >= 90 ? T.danger : pct >= 70 ? T.warning : T.success, transition: "width .4s" }} />
                    </div>
                    <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted }}>{pct.toFixed(0)}%</span>
                  </>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontFamily: T.mono, fontSize: 10.5, color: isActive ? T.success : T.textMuted }}>
                  {a.effectiveDate || "—"}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>
                  {a.endDate ? `→ ${a.endDate}` : ""}
                </span>
                {isActive && (
                  <span style={{ fontFamily: T.body, fontSize: 9.5, color: T.success, fontWeight: 600 }}>● Active</span>
                )}
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: isActive ? T.success : T.textMuted, fontWeight: 600 }}>
                {isActive ? `${consumed} TEU` : "—"}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 600,
                color: isActive ? (remaining === 0 ? T.danger : remaining < 10 ? T.warning : T.textMuted) : T.border }}>
                {isActive ? `${remaining} TEU` : "—"}
              </span>
              <div style={{ display: "flex", gap: 5 }}>
                <Btn size="sm" variant="secondary" onClick={() => setAllocModal(a)}>✎ Edit</Btn>
                <Btn size="sm" variant="danger"    onClick={() => setConfirmAlloc(a.id)}>✕</Btn>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modals */}
      {allocModal === "add" && (
        <Modal title="Add Space Configuration" onClose={() => setAllocModal(null)} width={520}>
          <AllocationForm carriers={carriers}
            onSave={async form => { await onAddAlloc(form); setAllocModal(null); }}
            onCancel={() => setAllocModal(null)} />
        </Modal>
      )}
      {allocModal && allocModal !== "add" && (
        <Modal title="Edit Space Configuration" onClose={() => setAllocModal(null)} width={520}>
          <AllocationForm init={allocModal} carriers={carriers}
            onSave={async form => { await onEditAlloc(allocModal.id, form); setAllocModal(null); }}
            onCancel={() => setAllocModal(null)} />
        </Modal>
      )}
      {confirmAlloc && (
        <ConfirmModal
          message="Remove this space configuration? Existing shipments will not be affected."
          onConfirm={() => { onDeleteAlloc(confirmAlloc); setConfirmAlloc(null); }}
          onCancel={() => setConfirmAlloc(null)} />
      )}
    </div>
  );
};



// ─── Global Pagination ────────────────────────────────────────────────────────
// Single shared component — use everywhere instead of inline prev/next buttons.

const Pagination = ({ total, offset, limit, onPage }) => {
  if (!total || total <= limit) return null;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages  = Math.ceil(total / limit);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
      <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
        {(offset + 1).toLocaleString()}–{Math.min(offset + limit, total).toLocaleString()} of {total.toLocaleString()}
        <span style={{ marginLeft: 8, color: T.border }}>· page {currentPage} / {totalPages}</span>
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="secondary" size="sm" disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - limit))}>← Prev</Btn>
        <Btn variant="secondary" size="sm" disabled={offset + limit >= total}
          onClick={() => onPage(offset + limit)}>Next →</Btn>
      </div>
    </div>
  );
};


// ─── Date Picker ──────────────────────────────────────────────────────────────
// Custom dark-themed calendar popover. Fully controlled: value = ISO "YYYY-MM-DD"
// or "". minDate/maxDate also ISO strings. Grays out out-of-range days.

const MONTHS_LONG  = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS_SHORT   = ["Mo","Tu","We","Th","Fr","Sa","Su"];

const parseIso  = iso => iso ? new Date(iso + "T12:00:00") : null;
const toIso     = d  => d.toISOString().split("T")[0];
const todayIso  = () => toIso(new Date());
const fmtIso    = iso => {
  if (!iso) return "";
  const d = parseIso(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

const DatePicker = ({
  value = "", onChange,
  minDate, maxDate,
  label, hint, placeholder = "Select date…",
  disabled = false,
}) => {
  const today = todayIso();
  const init  = value ? parseIso(value) : new Date();
  const [open,      setOpen]      = useState(false);
  const [viewYear,  setViewYear]  = useState(init.getFullYear());
  const [viewMonth, setViewMonth] = useState(init.getMonth());
  const ref = useRef(null);

  // Sync view to value when it changes from outside
  useEffect(() => {
    if (value) { const d = parseIso(value); setViewYear(d.getFullYear()); setViewMonth(d.getMonth()); }
  }, [value]);

  // Close on outside click
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y=>y-1); } else setViewMonth(m=>m-1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear(y=>y+1); } else setViewMonth(m=>m+1); };

  // Build 6×7 calendar grid, Monday-first
  const buildGrid = () => {
    const firstDow = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
    const offset   = firstDow === 0 ? 6 : firstDow - 1;        // shift to Mon=0
    const daysInM  = new Date(viewYear, viewMonth + 1, 0).getDate();
    const prevDays = new Date(viewYear, viewMonth, 0).getDate();
    const cells    = [];
    for (let i = offset - 1; i >= 0; i--)
      cells.push({ day: prevDays - i, m: viewMonth - 1, y: viewMonth === 0 ? viewYear - 1 : viewYear, outside: true });
    for (let d = 1; d <= daysInM; d++)
      cells.push({ day: d, m: viewMonth, y: viewYear, outside: false });
    while (cells.length < 42)
      cells.push({ day: cells.length - offset - daysInM + 1, m: viewMonth + 1, y: viewMonth === 11 ? viewYear + 1 : viewYear, outside: true });
    return cells;
  };

  const cellIso = c => `${c.y}-${String(c.m+1).padStart(2,"0")}-${String(c.day).padStart(2,"0")}`;

  const isCellDisabled = c => {
    if (c.outside) return true;
    const iso = cellIso(c);
    if (minDate && iso < minDate) return true;
    if (maxDate && iso > maxDate) return true;
    return false;
  };

  const isCellGrayed = c => {
    // Within the month but outside min/max: show grayed instead of hidden
    if (c.outside) return true;
    const iso = cellIso(c);
    if (minDate && iso < minDate) return true;
    if (maxDate && iso > maxDate) return true;
    return false;
  };

  const cells = buildGrid();

  return (
    <Field label={label} hint={hint}>
      <div ref={ref} style={{ position: "relative" }}>
        {/* Trigger */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen(o => !o)}
          style={{
            ...inputBase,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            cursor: disabled ? "not-allowed" : "pointer",
            fontFamily: value ? T.mono : T.body, fontSize: 13,
            color: value ? T.text : T.border,
            opacity: disabled ? 0.45 : 1,
            border: open ? `1px solid ${T.accent}` : inputBase.border,
            transition: "border-color .12s",
          }}
        >
          <span>{value ? fmtIso(value) : placeholder}</span>
          <span style={{ color: T.textMuted, fontSize: 13 }}>▾</span>
        </button>

        {/* Calendar popover */}
        {open && !disabled && (
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 600,
            background: T.surface, border: `1px solid ${T.borderMid}`, borderRadius: 12,
            boxShadow: "0 20px 50px rgba(0,0,0,.7)", padding: "14px 12px", width: 268,
          }}>
            {/* Month/year nav */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <button type="button" onClick={prevMonth}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
                  color: T.textMuted, cursor: "pointer", fontSize: 14, padding: "2px 10px",
                  fontFamily: T.mono, lineHeight: 1.4 }}>‹</button>
              <span style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text }}>
                {MONTHS_LONG[viewMonth]} {viewYear}
              </span>
              <button type="button" onClick={nextMonth}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
                  color: T.textMuted, cursor: "pointer", fontSize: 14, padding: "2px 10px",
                  fontFamily: T.mono, lineHeight: 1.4 }}>›</button>
            </div>

            {/* Day-of-week headers */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 4 }}>
              {DAYS_SHORT.map(d => (
                <div key={d} style={{ textAlign: "center", fontFamily: T.mono,
                  fontSize: 9.5, color: T.textMuted, fontWeight: 700,
                  textTransform: "uppercase", padding: "2px 0" }}>{d}</div>
              ))}
            </div>

            {/* Day cells */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
              {cells.map((cell, i) => {
                const iso     = cellIso(cell);
                const sel     = iso === value;
                const grayed  = isCellGrayed(cell);
                const isToday = iso === today && !cell.outside;
                return (
                  <button type="button" key={i}
                    disabled={grayed}
                    onClick={() => { if (!grayed) { onChange(iso); setOpen(false); } }}
                    style={{
                      width: "100%", aspectRatio: "1", border: sel ? "none" : `1px solid ${sel ? T.accent : "transparent"}`,
                      borderRadius: 6, cursor: grayed ? "default" : "pointer",
                      background: sel ? T.accent : "transparent",
                      color: sel ? T.btnPrimaryText : grayed ? T.border : isToday ? T.accent : T.text,
                      fontFamily: T.mono, fontSize: 11.5,
                      fontWeight: sel || isToday ? 700 : 400,
                      textDecoration: isToday && !sel ? "underline" : "none",
                      transition: "background .1s",
                    }}
                    onMouseEnter={e => { if (!grayed && !sel) e.currentTarget.style.background = T.surfaceHover; }}
                    onMouseLeave={e => { if (!sel) e.currentTarget.style.background = "transparent"; }}
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>

            {/* Footer: Today + Clear */}
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              <button type="button"
                disabled={!!(minDate && today < minDate) || !!(maxDate && today > maxDate)}
                onClick={() => {
                  const t = today;
                  if ((!minDate || t >= minDate) && (!maxDate || t <= maxDate)) { onChange(t); setOpen(false); }
                }}
                style={{ flex: 1, padding: "5px 0", background: "none",
                  border: `1px solid ${T.border}`, borderRadius: 6, color: T.textMuted,
                  fontFamily: T.body, fontSize: 11.5, cursor: "pointer" }}>
                Today
              </button>
              {value && (
                <button type="button" onClick={() => { onChange(""); setOpen(false); }}
                  style={{ flex: 1, padding: "5px 0", background: "none",
                    border: `1px solid ${T.border}`, borderRadius: 6, color: T.danger,
                    fontFamily: T.body, fontSize: 11.5, cursor: "pointer" }}>
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </Field>
  );
};

// ─── Shared: Port Search Combobox ────────────────────────────────────────────
// Async typeahead that queries /api/port-locations on every keystroke (debounced).

const PortCombobox = ({ value, onChange, placeholder = "Search ports…" }) => {
  const [query, setQuery]       = useState(value?.unlocode ? `${value.unlocode} – ${value.name}` : "");
  const [results, setResults]   = useState([]);
  const [open, setOpen]         = useState(false);
  const [loading, setLoading]   = useState(false);
  const timer = useRef(null);
  const box   = useRef(null);

  // Close on outside click
  useEffect(() => {
    const handler = e => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const search = (q) => {
    clearTimeout(timer.current);
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.ports.search({ search: q.trim(), limit: 10 });
        setResults(data.results);
        setOpen(true);
      } catch {}
      finally { setLoading(false); }
    }, 280);
  };

  const select = (port) => {
    setQuery(`${port.unlocode} – ${port.name}`);
    setResults([]);
    setOpen(false);
    onChange(port);
  };

  return (
    <div ref={box} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input value={query} onChange={e => search(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder={placeholder}
          style={{ ...inputBase, fontFamily: T.mono, fontSize: 13, paddingRight: 32 }} />
        {loading && (
          <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
            fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>…</span>
        )}
      </div>
      {open && results.length > 0 && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 200,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
          boxShadow: "0 12px 32px rgba(0,0,0,.5)", overflow: "hidden" }}>
          {results.map(p => (
            <button key={p.unlocode} onClick={() => select(p)}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 14px",
                background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
                borderBottom: `1px solid ${T.border}33` }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700, flexShrink: 0 }}>{p.unlocode}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, flexShrink: 0 }}>{p.countryCode}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── MDM: Port Locations Page ─────────────────────────────────────────────────

const MdmPortLocationsPage = () => {
  const [search,   setSearch]   = useState("");
  const [country,  setCountry]  = useState("");
  const [results,  setResults]  = useState([]);
  const [total,    setTotal]    = useState(0);
  const [offset,   setOffset]   = useState(0);
  const [loading,  setLoading]  = useState(false);
  const [modal,    setModal]    = useState(null); // null | "add" | port obj
  const [confirm,  setConfirm]  = useState(null);
  const LIMIT = 50;
  const timer  = useRef(null);

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const res = await api.ports.search({
        search:  opts.search  !== undefined ? opts.search  : search,
        country: opts.country !== undefined ? opts.country : country,
        limit:   LIMIT,
        offset:  opts.offset  !== undefined ? opts.offset  : offset,
      });
      setResults(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [search, country, offset]);

  useEffect(() => { load(); }, []);

  const handleSearch = (val) => {
    setSearch(val);
    setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: val, offset: 0 }), 300);
  };

  const handleCountry = (val) => {
    setCountry(val);
    setOffset(0);
    load({ country: val, offset: 0 });
  };

  const goPage = (newOffset) => { setOffset(newOffset); load({ offset: newOffset }); };

  const PortForm = ({ init = {}, onSave, onCancel }) => {
    const [f, setF] = useState({
      unlocode: init.unlocode || "", name: init.name || "", latitude: init.latitude ?? "",
      longitude: init.longitude ?? "", countryCode: init.countryCode || "", zoneCode: init.zoneCode || "",
    });
    const set = k => v => setF(p => ({ ...p, [k]: v }));
    const valid = f.unlocode.length === 5 && f.name.trim().length > 0;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp label="UN/LOCODE" value={f.unlocode} onChange={v => set("unlocode")(v.toUpperCase())} placeholder="NLRTM" mono maxLength={5} required />
          <Inp label="Country Code" value={f.countryCode} onChange={v => set("countryCode")(v.toUpperCase())} placeholder="NL" mono maxLength={2} />
        </div>
        <Inp label="Port Name" value={f.name} onChange={set("name")} placeholder="Rotterdam" required />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp label="Latitude"  value={String(f.latitude)}  onChange={v => set("latitude")(v)}  placeholder="51.9225" type="number" />
          <Inp label="Longitude" value={String(f.longitude)} onChange={v => set("longitude")(v)} placeholder="4.47917" type="number" />
        </div>
        <Inp label="Zone Code" value={f.zoneCode} onChange={set("zoneCode")} placeholder="EU-WEU" />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn onClick={() => valid && onSave({ ...f, latitude: parseFloat(f.latitude) || null, longitude: parseFloat(f.longitude) || null })} disabled={!valid}>
            {init.unlocode ? "Save Changes" : "Add Port"}
          </Btn>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Port Locations</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total.toLocaleString()} UN/LOCODE records · ISO 3166 country codes · coordinates
          </p>
        </div>
        <Btn onClick={() => setModal("add")} size="lg">＋ Add Port</Btn>
      </div>

      {/* Search bar */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 10, marginBottom: 16 }}>
        <div style={{ position: "relative" }}>
          <input value={search} onChange={e => handleSearch(e.target.value)}
            placeholder="Search by UN/LOCODE or port name…"
            style={{ ...inputBase, fontFamily: T.body, fontSize: 14, paddingLeft: 36 }} />
          <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: T.textMuted, fontSize: 14 }}>🔍</span>
        </div>
        <input value={country} onChange={e => handleCountry(e.target.value.toUpperCase())}
          placeholder="Country (NL…)" maxLength={2}
          style={{ ...inputBase, fontFamily: T.mono, fontSize: 13, textTransform: "uppercase" }} />
      </div>

      {/* Table */}
      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 70px 110px 110px 110px 80px",
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["UN/LOCODE", "Name", "Country", "Latitude", "Longitude", "Zone", "Map"].map((h, i) => (
            <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>Loading…</div>
        ) : results.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            {search || country ? "No ports match your search." : "No port data yet. Run: node import-mdm-data.js"}
          </div>
        ) : results.map(p => (
          <div key={p.unlocode}
            style={{ display: "grid", gridTemplateColumns: "90px 1fr 70px 110px 110px 110px 80px",
              padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{p.unlocode}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{p.name}</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{p.countryCode}</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{p.latitude?.toFixed(4) ?? "—"}</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{p.longitude?.toFixed(4) ?? "—"}</span>
            <Badge>{p.zoneCode || "—"}</Badge>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {p.latitude && p.longitude ? (
                <a href={`https://www.google.com/maps/search/?api=1&query=${p.latitude}%2C${p.longitude}`}
                  target="_blank" rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  style={{ fontFamily: T.body, fontSize: 11, color: T.info, textDecoration: "none",
                    background: T.infoBg, border: `1px solid ${T.info}44`, borderRadius: 4,
                    padding: "2px 7px", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 3 }}>
                  📍 Map
                </a>
              ) : <span style={{ color: T.border, fontSize: 11, fontFamily: T.mono }}>—</span>}
              <Btn size="sm" variant="secondary" onClick={() => setModal(p)}>✎</Btn>
              <Btn size="sm" variant="danger"    onClick={() => setConfirm(p.unlocode)}>✕</Btn>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      <Pagination total={total} offset={offset} limit={LIMIT} onPage={goPage} />

      {modal === "add" && (
        <Modal title="Add Port Location" onClose={() => setModal(null)}>
          <PortForm onSave={async data => { await api.ports.create(data); setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Port Location" onClose={() => setModal(null)}>
          <PortForm init={modal}
            onSave={async data => { await api.ports.update(modal.unlocode, data); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      <Pagination total={total} offset={offset} limit={LIMIT} onPage={goPage} />

      {confirm && (
        <ConfirmModal
          message={`Remove port ${confirm} from the master data? Linked ports referencing it will also be removed.`}
          onConfirm={async () => { await api.ports.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── MDM: Linked Ports Page ───────────────────────────────────────────────────

const MdmLinkedPortsPage = () => {
  const [links,   setLinks]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | link obj
  const [confirm, setConfirm] = useState(null);
  const [apiErr,  setApiErr]  = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setLinks(await api.linkedPorts.list()); setApiErr(null); }
    catch (e) { setApiErr(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, []);

  const LinkForm = ({ init = {}, onSave, onCancel }) => {
    const [primary, setPrimary] = useState(init.primaryUnlocode ? { unlocode: init.primaryUnlocode, name: init.primaryName || "" } : null);
    const [linked,  setLinked]  = useState(init.linkedUnlocode  ? { unlocode: init.linkedUnlocode,  name: init.linkedName  || "" } : null);
    const [note, setNote]       = useState(init.note || "");
    const [fErr, setFErr]       = useState("");
    const isEdit = !!init.id;
    const valid  = (isEdit || (primary && linked)) && !(primary?.unlocode === linked?.unlocode);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {!isEdit && (
          <>
            <Field label="Primary Port" required>
              <PortCombobox value={primary} onChange={p => { setPrimary(p); setFErr(""); }} placeholder="Search primary UN/LOCODE…" />
            </Field>
            <Field label="Linked Port" required>
              <PortCombobox value={linked} onChange={p => { setLinked(p); setFErr(""); }} placeholder="Search linked UN/LOCODE…" />
            </Field>
            {primary && linked && primary.unlocode === linked.unlocode && (
              <div style={{ fontFamily: T.body, fontSize: 12, color: T.danger, background: T.dangerBg, borderRadius: 6, padding: "8px 12px" }}>
                A port cannot be linked to itself.
              </div>
            )}
          </>
        )}
        {isEdit && (
          <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 16px" }}>
            <div style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>
              {init.primaryUnlocode} → {init.linkedUnlocode}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 2 }}>
              {init.primaryName} → {init.linkedName}
            </div>
          </div>
        )}
        <Inp label="Note (optional)" value={note} onChange={setNote} placeholder="e.g. Same terminal area, different berth codes" />
        {fErr && <div style={{ fontFamily: T.body, fontSize: 12, color: T.danger }}>{fErr}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid} onClick={() => {
            if (!isEdit && (!primary || !linked)) return setFErr("Both ports are required");
            onSave({ primaryUnlocode: primary?.unlocode, linkedUnlocode: linked?.unlocode, note });
          }}>
            {isEdit ? "Save Note" : "Add Link"}
          </Btn>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Linked Ports</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {links.length} link{links.length !== 1 ? "s" : ""} configured · map one UN/LOCODE to another (e.g. USLAX → USLGB)
          </p>
        </div>
        <Btn onClick={() => setModal("add")} size="lg">＋ Add Link</Btn>
      </div>

      {apiErr && (
        <div style={{ background: T.dangerBg, border: `1px solid ${T.danger}44`, borderRadius: 8,
          padding: "12px 16px", fontFamily: T.body, fontSize: 13, color: T.danger, marginBottom: 16 }}>
          {apiErr} — make sure Port Locations data is imported first.
        </div>
      )}

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 30px 100px 1fr 1fr 120px",
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Primary", "Port Name", "", "Linked To", "Port Name", "Note", "Actions"].map((h, i) => (
            <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body }}>Loading…</div>
        ) : links.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No port links configured yet. Use "+ Add Link" to create one.
          </div>
        ) : links.map(l => (
          <div key={l.id}
            style={{ display: "grid", gridTemplateColumns: "100px 1fr 30px 100px 1fr 1fr 120px",
              padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{l.primaryUnlocode}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{l.primaryName}</span>
            <span style={{ fontFamily: T.mono, fontSize: 14, color: T.textMuted, textAlign: "center" }}>→</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, fontWeight: 700 }}>{l.linkedUnlocode}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{l.linkedName}</span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: l.note ? "normal" : "italic" }}>
              {l.note || "—"}
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" variant="secondary" onClick={() => setModal(l)}>✎ Note</Btn>
              <Btn size="sm" variant="danger"    onClick={() => setConfirm(l.id)}>✕</Btn>
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Port Link" onClose={() => setModal(null)} width={560}>
          <LinkForm
            onSave={async data => { await api.linkedPorts.create(data); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Link Note" onClose={() => setModal(null)} width={480}>
          <LinkForm init={modal}
            onSave={async data => { await api.linkedPorts.update(modal.id, { note: data.note }); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message="Remove this port link? Shipments are not affected."
          onConfirm={async () => { await api.linkedPorts.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};



// ─── MDM: Trade Lanes Page ────────────────────────────────────────────────────


// ─── Shared: Country Combobox ────────────────────────────────────────────────
// Async typeahead that searches countries by name or ISO2, debounced.

const CountryCombobox = ({ onSelect, placeholder = "Search countries…", excludeIso2s = [] }) => {
  const [query,   setQuery]   = useState("");
  const [results, setResults] = useState([]);
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);
  const box   = useRef(null);

  useEffect(() => {
    const handler = e => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const search = q => {
    setQuery(q);
    clearTimeout(timer.current);
    if (q.trim().length < 1) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const all = await api.countries.list({ search: q.trim() });
        setResults(all.filter(c => !excludeIso2s.includes(c.iso2)));
        setOpen(true);
      } catch {}
      setLoading(false);
    }, 220);
  };

  const select = country => {
    setQuery("");
    setResults([]);
    setOpen(false);
    onSelect(country);
  };

  return (
    <div ref={box} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input
          value={query}
          onChange={e => search(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder={placeholder}
          style={{ ...inputBase, fontFamily: T.body, fontSize: 13, paddingRight: 32 }}
        />
        {loading && (
          <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
            fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>…</span>
        )}
      </div>
      {open && results.length > 0 && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 300,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
          boxShadow: "0 12px 32px rgba(0,0,0,.5)", overflow: "hidden", maxHeight: 240, overflowY: "auto" }}>
          {results.map(c => (
            <button key={c.iso2} onClick={() => select(c)}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "9px 14px", background: "transparent", border: "none",
                cursor: "pointer", textAlign: "left", borderBottom: `1px solid ${T.border}33` }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700, flexShrink: 0, width: 28 }}>{c.iso2}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1 }}>{c.name}</span>
              {c.portCount > 0 && (
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, flexShrink: 0 }}>{c.portCount} ports</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const MdmTradeLanesPage = () => {
  const [lanes,   setLanes]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setLanes(await api.tradeLanes.list()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, []);

  const LaneForm = ({ init = {}, onSave, onCancel }) => {
    const [code,      setCode]      = useState(init.code || "");
    const [name,      setName]      = useState(init.name || "");
    const [desc,      setDesc]      = useState(init.description || "");
    const [countries, setCountries] = useState([]);   // assigned countries list
    const [loadingC,  setLoadingC]  = useState(false);
    const isEdit = !!init.code;
    const valid  = (isEdit || code.trim().length >= 2) && name.trim().length >= 2;

    // Load current country assignments when editing
    useEffect(() => {
      if (!isEdit) return;
      setLoadingC(true);
      api.tradeLanes.getCountries(init.code)
        .then(list => setCountries(list))
        .catch(() => {})
        .finally(() => setLoadingC(false));
    }, [init.code]);

    const addCountry    = c => setCountries(p => p.some(x => x.iso2 === c.iso2) ? p : [...p, c]);
    const removeCountry = iso2 => setCountries(p => p.filter(c => c.iso2 !== iso2));

    const handleSave = () => {
      onSave({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description: desc,
        iso2s: countries.map(c => c.iso2),
      });
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Lane code */}
        {!isEdit
          ? <Inp label="Lane Code" value={code} onChange={v => setCode(v.toUpperCase())}
              placeholder="EU-N" mono required hint="e.g. FE, SEA, EU-N, ME" />
          : <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
                padding: "10px 14px", fontFamily: T.mono, fontSize: 15, color: T.accent, fontWeight: 700 }}>
                {init.code}
              </div>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{init.name}</span>
            </div>
        }

        {/* Name + description */}
        <Inp label="Trade Lane Name" value={name} onChange={setName} placeholder="Europe North" required />
        <Textarea label="Description" value={desc} onChange={setDesc} placeholder="Optional description…" rows={2} />

        {/* Country assignments — only when editing */}
        {isEdit && (
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
              Assigned Countries
              <span style={{ marginLeft: 8, color: T.border, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                — search by name or ISO2 code
              </span>
            </div>

            {/* Autocomplete search */}
            <CountryCombobox
              placeholder="Add country…"
              excludeIso2s={countries.map(c => c.iso2)}
              onSelect={addCountry}
            />

            {/* Assigned list */}
            <div style={{ marginTop: 10, maxHeight: 260, overflowY: "auto",
              border: `1px solid ${T.border}`, borderRadius: 8, background: T.bg }}>
              {loadingC ? (
                <div style={{ padding: "20px 16px", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading…</div>
              ) : countries.length === 0 ? (
                <div style={{ padding: "20px 16px", fontFamily: T.body, fontSize: 13, color: T.border, fontStyle: "italic" }}>
                  No countries assigned yet — search above to add one.
                </div>
              ) : countries.map(c => (
                <div key={c.iso2} style={{ display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 14px", borderBottom: `1px solid ${T.border}22` }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700, width: 28, flexShrink: 0 }}>{c.iso2}</span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1 }}>{c.name}</span>
                  {c.portCount > 0 && (
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{c.portCount} ports</span>
                  )}
                  <button onClick={() => removeCountry(c.iso2)}
                    style={{ background: "none", border: `1px solid ${T.danger}44`, borderRadius: 4,
                      color: T.danger, cursor: "pointer", padding: "2px 8px", fontSize: 11,
                      fontFamily: T.body, fontWeight: 600, flexShrink: 0, transition: "border-color .12s, background .12s" }}
                    onMouseEnter={e => { e.currentTarget.style.background = T.dangerBg; e.currentTarget.style.borderColor = T.danger; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.borderColor = `${T.danger}44`; }}>
                    ✕ Remove
                  </button>
                </div>
              ))}
            </div>

            {countries.length > 0 && (
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 6 }}>
                {countries.length} countr{countries.length !== 1 ? "ies" : "y"} assigned to this lane
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid} onClick={handleSave}>
            {isEdit ? "Save Changes" : "Add Trade Lane"}
          </Btn>
        </div>
      </div>
    );
  };

  const LANE_COLORS = {
    "FE":"info","SEA":"info","ISC":"amber","ME":"warning","EU-N":"success","EU-S":"success",
    "NAM":"default","CAR":"default","SAM":"default","WAF":"danger","EAF":"danger",
    "SAF":"danger","NAF":"warning","OCE":"default",
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Trade Lanes</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {lanes.length} FIATA high-level trade lanes · linked to countries
          </p>
        </div>
        <Btn onClick={() => setModal("add")} size="lg">＋ Add Lane</Btn>
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 1fr 120px 130px",
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Code", "Name", "Description", "Countries", "Actions"].map((h, i) => (
            <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
          ))}
        </div>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body }}>Loading…</div>
        ) : lanes.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No trade lanes yet. Restart the server to auto-seed FIATA lanes.
          </div>
        ) : lanes.map(l => (
          <div key={l.code}
            style={{ display: "grid", gridTemplateColumns: "90px 1fr 1fr 120px 130px",
              padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <Badge variant={LANE_COLORS[l.code] || "default"}>{l.code}</Badge>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>{l.name}</span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{l.description || "—"}</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{l.countryCount} countries</span>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" variant="secondary" onClick={() => setModal(l)}>✎ Edit</Btn>
              <Btn size="sm" variant="danger"    onClick={() => setConfirm(l.code)}>✕</Btn>
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Trade Lane" onClose={() => setModal(null)} width={540}>
          <LaneForm onSave={async d => { await api.tradeLanes.create(d); setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Trade Lane" onClose={() => setModal(null)} width={600}>
          <LaneForm init={modal}
            onSave={async d => {
              await api.tradeLanes.update(modal.code, { name: d.name, description: d.description });
              await api.tradeLanes.setCountries(modal.code, d.iso2s);
              setModal(null);
              load();
            }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={`Remove trade lane "${confirm}"? Country assignments will also be removed.`}
          onConfirm={async () => { await api.tradeLanes.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── Shared: Country Locations Modal ──────────────────────────────────────────
// Read-only popup listing all UN Location Codes + port names for a given country.

const CountryLocationsModal = ({ country, onClose }) => {
  const [rows,    setRows]    = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [search,  setSearch]  = useState("");
  const [loading, setLoading] = useState(true);
  const LIMIT = 50;
  const timer  = useRef(null);

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const res = await api.countryLocations.list(country.iso2, {
        search: opts.search  !== undefined ? opts.search  : search,
        limit:  LIMIT,
        offset: opts.offset  !== undefined ? opts.offset  : offset,
      });
      setRows(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [country.iso2, search, offset]);

  useEffect(() => { load(); }, []);

  const handleSearch = v => {
    setSearch(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 280);
  };
  const goPage = off => { setOffset(off); load({ offset: off }); };

  return (
    <Modal title={`Locations — ${country.name} (${country.iso2})`} onClose={onClose} width={660}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search by UN/LOCODE or location name…"
          style={{ ...inputBase, fontFamily: T.body, fontSize: 14 }} />

        <div style={{ background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 100px",
            padding: "9px 16px", borderBottom: `1px solid ${T.border}` }}>
            {["UN/LOCODE", "Location Name", "Zone"].map((h, i) => (
              <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
            ))}
          </div>
          {loading ? (
            <div style={{ padding: 32, textAlign: "center", color: T.textMuted, fontFamily: T.body }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
              {search ? "No locations match your search." : "No port locations found for this country."}
            </div>
          ) : rows.map(p => (
            <div key={p.unlocode}
              style={{ display: "grid", gridTemplateColumns: "100px 1fr 100px",
                padding: "10px 16px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{p.unlocode}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{p.name}</span>
              <Badge>{p.zoneCode || "—"}</Badge>
            </div>
          ))}
        </div>
        <Pagination total={total} offset={offset} limit={LIMIT} onPage={goPage} />
      </div>
    </Modal>
  );
};

// ─── MDM Locations: Regions Page ──────────────────────────────────────────────

const MdmRegionsPage = () => {
  const [regions,  setRegions]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [modal,    setModal]    = useState(null);
  const [confirm,  setConfirm]  = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setRegions(await api.regions.list()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, []);

  const RegionForm = ({ init = {}, onSave, onCancel }) => {
    const [code, setCode] = useState(init.code || "");
    const [name, setName] = useState(init.name || "");
    const [desc, setDesc] = useState(init.description || "");
    const isEdit = !!init.code;
    const valid  = (isEdit || code.trim().length >= 2) && name.trim().length >= 2;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!isEdit && <Inp label="Region Code" value={code} onChange={v => setCode(v.toUpperCase())} placeholder="EU-WEU" mono required hint="e.g. EU-WEU, AS-SIN" />}
        {isEdit && (
          <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px",
            fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{init.code}</div>
        )}
        <Inp label="Region Name" value={name} onChange={setName} placeholder="Europe – Western Europe" required />
        <Textarea label="Description" value={desc} onChange={setDesc} placeholder="Optional description…" rows={2} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid} onClick={() => onSave({ code: code.trim().toUpperCase(), name: name.trim(), description: desc })}>
            {isEdit ? "Save Changes" : "Add Region"}
          </Btn>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Regions</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {regions.length} region{regions.length !== 1 ? "s" : ""} — derived from UN/LOCODE zone codes
          </p>
        </div>
        <Btn onClick={() => setModal("add")} size="lg">＋ Add Region</Btn>
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr 90px 130px",
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Code", "Name", "Description", "Ports", "Actions"].map((h, i) => (
            <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
          ))}
        </div>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body }}>Loading…</div>
        ) : regions.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No regions yet. Run <code style={{ fontFamily: T.mono, color: T.textCode }}>node import-mdm-data.js</code> to auto-populate from port data.
          </div>
        ) : regions.map(r => (
          <div key={r.code}
            style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr 90px 130px",
              padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{r.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{r.name}</span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: r.description ? "normal" : "italic" }}>
              {r.description || "—"}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>{r.portCount.toLocaleString()}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" variant="secondary" onClick={() => setModal(r)}>✎ Edit</Btn>
              <Btn size="sm" variant="danger"    onClick={() => setConfirm(r.code)}>✕</Btn>
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Region" onClose={() => setModal(null)}>
          <RegionForm onSave={async d => { await api.regions.create(d); setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Region" onClose={() => setModal(null)}>
          <RegionForm init={modal}
            onSave={async d => { await api.regions.update(modal.code, d); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={`Remove region "${confirm}"? Port data will not be affected.`}
          onConfirm={async () => { await api.regions.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── MDM Locations: Countries Page ────────────────────────────────────────────

const LANE_BADGE_VARIANT = {
  "FE":"info","SEA":"info","ISC":"amber","ME":"warning","EU-N":"success","EU-S":"success",
  "NAM":"default","CAR":"default","SAM":"default","WAF":"danger","EAF":"danger",
  "SAF":"danger","NAF":"warning","OCE":"default",
};

const MdmCountriesPage = () => {
  const [countries,      setCountries]      = useState([]);
  const [allLanes,       setAllLanes]       = useState([]);
  const [search,         setSearch]         = useState("");
  const [loading,        setLoading]        = useState(true);
  const [modal,          setModal]          = useState(null);   // null | "add" | country obj
  const [confirm,        setConfirm]        = useState(null);
  const [viewLocations,  setViewLocations]  = useState(null);   // country obj for popup
  const timer = useRef(null);

  const load = useCallback(async (s = search) => {
    setLoading(true);
    try {
      const [c, l] = await Promise.all([api.countries.list({ search: s }), api.tradeLanes.list()]);
      setCountries(c);
      setAllLanes(l);
    } catch {}
    setLoading(false);
  }, [search]);

  useEffect(() => { load(""); }, []);

  const handleSearch = v => {
    setSearch(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load(v), 280);
  };

  const CountryForm = ({ init = {}, onSave, onCancel }) => {
    const [iso2,      setIso2]      = useState(init.iso2 || "");
    const [name,      setName]      = useState(init.name || "");
    const [unMember,  setUnMember]  = useState(init.unMember !== false);
    const [selLanes,  setSelLanes]  = useState(init.tradeLanes || []);
    const isEdit = !!init.iso2;
    const valid  = (isEdit || iso2.trim().length === 2) && name.trim().length >= 2;

    const toggleLane = code => setSelLanes(p =>
      p.includes(code) ? p.filter(c => c !== code) : [...p, code]
    );

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!isEdit
          ? <Inp label="ISO2 Code" value={iso2} onChange={v => setIso2(v.toUpperCase())}
              placeholder="NL" mono maxLength={2} required hint="2-char ISO 3166-1 alpha-2" />
          : <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
              padding: "10px 14px", fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{init.iso2}</div>
        }
        <Inp label="Country Name" value={name} onChange={setName} placeholder="Netherlands" required />
        <Field label="UN Member State">
          <div style={{ display: "flex", gap: 8 }}>
            <BtnToggle selected={unMember}  onClick={() => setUnMember(true)}>✅ UN Member</BtnToggle>
            <BtnToggle selected={!unMember} onClick={() => setUnMember(false)}>⬜ Territory / Observer</BtnToggle>
          </div>
        </Field>
        <Field label="Trade Lanes" hint="select all that apply">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {allLanes.map(lane => (
              <BtnToggle key={lane.code} selected={selLanes.includes(lane.code)} onClick={() => toggleLane(lane.code)}>
                <span style={{ fontFamily: T.mono, fontSize: 11, marginRight: 4 }}>{lane.code}</span>
                <span style={{ fontSize: 12 }}>{lane.name}</span>
              </BtnToggle>
            ))}
          </div>
        </Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid} onClick={() => onSave({
            iso2: iso2.trim().toUpperCase(), name: name.trim(), unMember, tradeLanes: selLanes
          })}>
            {isEdit ? "Save Changes" : "Add Country"}
          </Btn>
        </div>
      </div>
    );
  };

  const handleSave = async (d, isEdit) => {
    if (isEdit) {
      await api.countries.update(d.iso2, { name: d.name, unMember: d.unMember });
    } else {
      await api.countries.create({ iso2: d.iso2, name: d.name, unMember: d.unMember });
    }
    await api.countryLanes.set(d.iso2, d.tradeLanes);
    setModal(null);
    load("");
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Countries</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {countries.length} entr{countries.length !== 1 ? "ies" : "y"} · ISO 3166-1 alpha-2 · with FIATA trade lane assignments
          </p>
        </div>
        <Btn onClick={() => setModal("add")} size="lg">＋ Add Country</Btn>
      </div>

      <div style={{ marginBottom: 14 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search by ISO2 code or country name…"
          style={{ ...inputBase, fontFamily: T.body, fontSize: 14, maxWidth: 420 }} />
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "65px 160px 120px 1fr 80px 180px",
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["ISO2", "Country Name", "UN Member?", "Trade Lanes", "Ports", "Actions"].map((h, i) => (
            <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
          ))}
        </div>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body }}>Loading…</div>
        ) : countries.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>No countries match your search.</div>
        ) : countries.map(c => (
          <div key={c.iso2}
            style={{ display: "grid", gridTemplateColumns: "65px 160px 120px 1fr 80px 180px",
              padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{c.iso2}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{c.name}</span>
            <span style={{ fontFamily: T.body, fontSize: 12 }}>
              {c.unMember ? "✅ Member" : <span style={{ color: T.textMuted }}>— Territory</span>}
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {c.tradeLanes.length > 0
                ? c.tradeLanes.map(l => <Badge key={l} variant={LANE_BADGE_VARIANT[l] || "default"}>{l}</Badge>)
                : <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>
              }
            </div>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: c.portCount > 0 ? T.success : T.textMuted, fontWeight: c.portCount > 0 ? 700 : 400 }}>
              {c.portCount.toLocaleString()}
            </span>
            <div style={{ display: "flex", gap: 5 }}>
              {c.portCount > 0 && (
                <Btn size="sm" variant="ghost" onClick={() => setViewLocations(c)}>View Locations</Btn>
              )}
              <Btn size="sm" variant="secondary" onClick={() => setModal(c)}>✎</Btn>
              <Btn size="sm" variant="danger"    onClick={() => setConfirm(c.iso2)}>✕</Btn>
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Country" onClose={() => setModal(null)} width={560}>
          <CountryForm onSave={d => handleSave(d, false)} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Country" onClose={() => setModal(null)} width={560}>
          <CountryForm init={modal} onSave={d => handleSave(d, true)} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={`Remove country "${confirm}"? Port and trade lane data will not be affected.`}
          onConfirm={async () => { await api.countries.remove(confirm); setConfirm(null); load(""); }}
          onCancel={() => setConfirm(null)} />
      )}
      {viewLocations && (
        <CountryLocationsModal country={viewLocations} onClose={() => setViewLocations(null)} />
      )}
    </div>
  );
};

// ─── MDM Locations: UN Location Codes Page ────────────────────────────────────

const MdmUNLocationCodesPage = () => {
  const [rows,     setRows]     = useState([]);
  const [total,    setTotal]    = useState(0);
  const [offset,   setOffset]   = useState(0);
  const [search,   setSearch]   = useState("");
  const [loading,  setLoading]  = useState(true);
  const LIMIT = 50;
  const timer  = useRef(null);

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const res = await api.unlocodes.search({
        search: opts.search  !== undefined ? opts.search  : search,
        limit:  LIMIT,
        offset: opts.offset  !== undefined ? opts.offset  : offset,
      });
      setRows(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [search, offset]);

  useEffect(() => { load(); }, []);

  const handleSearch = v => {
    setSearch(v);
    setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 300);
  };

  const goPage = off => { setOffset(off); load({ offset: off }); };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>UN Location Codes</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total.toLocaleString()} codes · 5-char identifiers cross-checked against seaport data
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Badge variant="success">✅ = Seaport in DB</Badge>
          <Badge variant="default">— = No seaport record</Badge>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search by UN/LOCODE (e.g. NLRTM, DEHAM)…"
          style={{ ...inputBase, fontFamily: T.mono, fontSize: 13, maxWidth: 380 }} />
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 80px 130px 120px",
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["UN/LOCODE", "Port / Location Name", "Country", "Zone", "Has Seaport?"].map((h, i) => (
            <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
          ))}
        </div>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            {search ? "No codes match your search." : "No data yet — run node import-mdm-data.js first."}
          </div>
        ) : rows.map(r => (
          <div key={r.code}
            style={{ display: "grid", gridTemplateColumns: "110px 1fr 80px 130px 120px",
              padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{r.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: r.name ? T.text : T.border, fontStyle: r.name ? "normal" : "italic" }}>
              {r.name || "Unknown"}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{r.countryCode || "—"}</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{r.zoneCode || "—"}</span>
            <span style={{ fontSize: 16 }}>{r.hasSeaport ? "✅" : <span style={{ color: T.border, fontFamily: T.mono, fontSize: 11 }}>—</span>}</span>
          </div>
        ))}
      </div>

      <Pagination total={total} offset={offset} limit={LIMIT} onPage={goPage} />
    </div>
  );
};


// ─── Incoterms Modal ──────────────────────────────────────────────────────────

const INCOTERMS_2020 = [
  {
    code: "EXW", name: "Ex Works", scope: "any",
    risk: "At seller's premises",
    seller: "Makes goods available at their premises only.",
    buyer: "Bears all costs and risks from seller's door to final destination.",
    notes: "Maximum obligation on buyer. Suitable for domestic trade or when buyer has own logistics.",
  },
  {
    code: "FCA", name: "Free Carrier", scope: "any",
    risk: "When goods delivered to named carrier at seller's premises or named place",
    seller: "Delivers to named carrier or other nominated person at agreed place.",
    buyer: "Bears all costs and risks once goods are handed to carrier.",
    notes: "Replaces FOB for containerised cargo. Can specify that buyer instructs carrier to issue on-board B/L.",
  },
  {
    code: "CPT", name: "Carriage Paid To", scope: "any",
    risk: "When goods delivered to first carrier",
    seller: "Contracts and pays for carriage to named destination. Risk transfers at first carrier handover.",
    buyer: "Bears risk from first carrier handover; seller pays freight.",
    notes: "Risk and cost transfer at different points — a common source of confusion.",
  },
  {
    code: "CIP", name: "Carriage and Insurance Paid To", scope: "any",
    risk: "When goods delivered to first carrier",
    seller: "As CPT, plus must obtain Institute Cargo Clauses (A) — all-risks insurance.",
    buyer: "Bears risk from first carrier handover.",
    notes: "Upgraded insurance vs CIF. Preferred for high-value cargo on any transport mode.",
  },
  {
    code: "DAP", name: "Delivered at Place", scope: "any",
    risk: "At named place of destination, ready for unloading",
    seller: "Bears all costs and risks to deliver to named destination, not unloaded.",
    buyer: "Responsible for unloading and import clearance.",
    notes: "Very common for door-to-door shipments. Customs clearance is buyer's responsibility.",
  },
  {
    code: "DPU", name: "Delivered at Place Unloaded", scope: "any",
    risk: "After goods unloaded at named place",
    seller: "Bears all costs and risks including unloading at destination.",
    buyer: "Responsible for import clearance after unloading.",
    notes: "Replaced DAT (Incoterms 2010). Seller must be able to organise unloading at destination.",
  },
  {
    code: "DDP", name: "Delivered Duty Paid", scope: "any",
    risk: "At named place of destination, ready for unloading",
    seller: "Maximum obligation — bears all costs including import duties and taxes to destination.",
    buyer: "Only needs to unload the goods.",
    notes: "Seller assumes full responsibility. Be cautious if seller cannot easily handle import formalities.",
  },
  {
    code: "FAS", name: "Free Alongside Ship", scope: "sea",
    risk: "When goods placed alongside vessel at named port",
    seller: "Delivers goods alongside vessel at named loading port. Export cleared by seller.",
    buyer: "Bears all costs from alongside ship onwards, including loading.",
    notes: "Suitable for bulk/break-bulk cargo. Buyer arranges loading.",
  },
  {
    code: "FOB", name: "Free On Board", scope: "sea",
    risk: "When goods on board vessel at named port of loading",
    seller: "Loads goods on board vessel nominated by buyer at named port.",
    buyer: "Bears all costs and risks from the moment goods are on board.",
    notes: "Most common term in ocean freight. Not recommended for containerised cargo — use FCA instead.",
  },
  {
    code: "CFR", name: "Cost and Freight", scope: "sea",
    risk: "When goods on board vessel at port of loading",
    seller: "Contracts and pays freight to named destination port. Risk transfers on loading.",
    buyer: "Bears risk from loading; seller pays ocean freight.",
    notes: "Like FOB but seller pays freight. Risk and cost split at different points.",
  },
  {
    code: "CIF", name: "Cost, Insurance and Freight", scope: "sea",
    risk: "When goods on board vessel at port of loading",
    seller: "As CFR, plus obtains minimum insurance (Institute Cargo Clauses C).",
    buyer: "Bears risk from loading; entitled to insurance policy proceeds.",
    notes: "Minimum insurance only. For higher-value cargo, consider CIP with Clauses (A).",
  },
];

const IncotermsModal = ({ onClose }) => {
  const [active, setActive] = useState(null);
  const anyMode = INCOTERMS_2020.filter(t => t.scope === "any");
  const seaMode = INCOTERMS_2020.filter(t => t.scope === "sea");

  const termRow = (t) => (
    <div key={t.code} onClick={() => setActive(active?.code === t.code ? null : t)}
      style={{ borderBottom: `1px solid ${T.border}22`, cursor: "pointer",
        background: active?.code === t.code ? T.accentBg : "transparent",
        transition: "background .12s" }}
      onMouseEnter={e => { if (active?.code !== t.code) e.currentTarget.style.background = T.surfaceHover; }}
      onMouseLeave={e => { if (active?.code !== t.code) e.currentTarget.style.background = "transparent"; }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px" }}>
        <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 800, color: T.accent, width: 36, flexShrink: 0 }}>{t.code}</span>
        <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text, flex: 1 }}>{t.name}</span>
        <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{active?.code === t.code ? "▲" : "▼"}</span>
      </div>
      {active?.code === t.code && (
        <div style={{ padding: "0 16px 14px 64px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em" }}>Risk Transfer — </span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.warning }}>{t.risk}</span>
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 2 }}>Seller obligations</div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6 }}>{t.seller}</div>
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 2 }}>Buyer obligations</div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6 }}>{t.buyer}</div>
          </div>
          <div style={{ background: T.bg, borderRadius: 6, padding: "8px 12px", fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
            💡 {t.notes}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <Modal title="Incoterms® 2020 Reference" onClose={onClose} width={640}>
      <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 16, lineHeight: 1.6 }}>
        International Commercial Terms published by the International Chamber of Commerce (ICC).
        Click any term to expand its obligations and risk transfer point.
      </div>

      <div style={{ marginBottom: 6, fontFamily: T.mono, fontSize: 10, color: T.textMuted, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".1em" }}>All Transport Modes</div>
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
        {anyMode.map(termRow)}
      </div>

      <div style={{ marginBottom: 6, fontFamily: T.mono, fontSize: 10, color: T.textMuted, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".1em" }}>Sea &amp; Inland Waterway Only</div>
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
        {seaMode.map(termRow)}
      </div>

      <div style={{ marginTop: 14, fontFamily: T.body, fontSize: 11, color: T.border, lineHeight: 1.5 }}>
        Incoterms® is a registered trademark of the ICC. This reference is provided for informational purposes only.
      </div>
    </Modal>
  );
};

// ─── User Manual Page ─────────────────────────────────────────────────────────

const UserManualPage = () => {
  const [section, setSection] = useState("overview");
  const [showIncoterms, setShowIncoterms] = useState(false);

  const SECTIONS = [
    { id: "overview",   label: "Overview" },
    { id: "shipments",  label: "Shipments" },
    { id: "dashboard",  label: "Dashboard" },
    { id: "mdm",        label: "Master Data" },
    { id: "incoterms",  label: "Incoterms" },
  ];

  const SectionBtn = ({ id, label }) => (
    <button onClick={() => setSection(id)} style={{
      display: "block", width: "100%", textAlign: "left", padding: "8px 14px",
      background: section === id ? T.accentBg : "transparent",
      border: "none", borderLeft: `3px solid ${section === id ? T.accent : "transparent"}`,
      color: section === id ? T.accent : T.textMuted,
      fontFamily: T.body, fontSize: 13, fontWeight: section === id ? 600 : 400,
      cursor: "pointer", borderRadius: "0 6px 6px 0", marginBottom: 2,
    }}>{label}</button>
  );

  const H2 = ({ children }) => (
    <h2 style={{ fontFamily: T.head, fontSize: 20, fontWeight: 700, color: T.text, margin: "0 0 10px" }}>{children}</h2>
  );
  const H3 = ({ children }) => (
    <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.accent, margin: "20px 0 6px" }}>{children}</h3>
  );
  const P = ({ children }) => (
    <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.75, margin: "0 0 10px" }}>{children}</p>
  );
  const Tag = ({ children }) => (
    <code style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, background: T.bg,
      border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 6px" }}>{children}</code>
  );

  const content = {
    overview: (
      <div>
        <H2>CargoDesk — User Manual</H2>
        <P>CargoDesk is a freight management platform for creating and tracking ocean shipments, monitoring TEU consumption against carrier allocations, and maintaining master data for ports, carriers, trade lanes, and countries.</P>
        <H3>Navigation</H3>
        <P>The sidebar is organised into two areas: <strong>Operational</strong> (Shipments and Dashboard) and <strong>Master Data</strong> (MDM). Use the Master Data section header to expand or collapse the sub-menu.</P>
        <H3>Data model</H3>
        <P>Everything flows from Master Data. Carriers and ports must exist in the MDM before you can create a shipment. Allocations on the Dashboard are configured per carrier and contract type. Trade lanes link countries to FIATA high-level regions.</P>
      </div>
    ),
    shipments: (
      <div>
        <H2>Shipments</H2>
        <P>A shipment represents one booking with a carrier, from a Port of Loading (POL) to a Port of Discharge (POD).</P>
        <H3>Creating a shipment</H3>
        <P>Click <strong>＋ New Shipment</strong>. Search for the POL and POD using the port search — it queries the 14,000+ UN/LOCODE database. Select a carrier, set the contract type, and optionally add dates, booking reference, B/L number, vessel, and voyage.</P>
        <H3>Contract types</H3>
        <P>Use the preset buttons for <Tag>Pending</Tag>, <Tag>SPOT</Tag>, or <Tag>Customer Own</Tag>, or type a custom contract label. The contract type links to your Dashboard allocation configuration.</P>
        <H3>Cargo Details</H3>
        <P>Open a shipment to access Cargo Details. Add containers by specifying the container number, size (<Tag>20ft = 1 TEU</Tag>, <Tag>40ft = 2 TEU</Tag>), and equipment type (DC, RF, OT, FR, TK). TEU totals update instantly on the Dashboard.</P>
        <H3>Status workflow</H3>
        <P>Set the shipment status to <Tag>Active</Tag>, <Tag>Pending</Tag>, <Tag>Completed</Tag>, or <Tag>Cancelled</Tag> as it progresses.</P>
      </div>
    ),
    dashboard: (
      <div>
        <H2>Consumption Dashboard</H2>
        <P>The Dashboard shows TEU consumption against your configured carrier space allocations, scoped to a specific week.</P>
        <H3>Week picker</H3>
        <P>The dashboard always opens on the current week (Monday–Sunday). Use the <strong>← Prev</strong> and <strong>Next →</strong> arrows to navigate between weeks, or click <strong>Today</strong> to return to the current week. Only shipments with an ETD (or creation date) falling in the selected week are counted.</P>
        <H3>KPIs</H3>
        <P><strong>Total Allocated</strong> — the sum of all configured space across all carriers and contract types. <strong>Active Consumption</strong> — TEU booked in the selected week. <strong>Remaining</strong> — how much space is still available.</P>
        <H3>Space Configurations</H3>
        <P>Click <strong>＋ Add Configuration</strong> to set the awarded TEU for a specific carrier and contract type combination — e.g. MAEU / Customer Own = 80 TEU. Edit or remove configurations at any time. The utilisation bar turns amber above 70% and red above 90%.</P>
      </div>
    ),
    mdm: (
      <div>
        <H2>Master Data Management (MDM)</H2>
        <P>MDM is the reference layer for all operational data. Changes here propagate automatically to shipment forms and the dashboard.</P>
        <H3>Carriers</H3>
        <P>Add, edit, or remove ocean carriers. Each carrier requires a SCAC code (e.g. <Tag>MAEU</Tag>) and a full name. Carriers listed here appear in the shipment carrier dropdown.</P>
        <H3>Port Locations</H3>
        <P>The port database contains 14,000+ UN/LOCODE records with coordinates. Use the search bar to filter by code or name. Every row with coordinates includes a <strong>📍 Map</strong> link that opens Google Maps at that location. You can add custom ports or edit existing ones.</P>
        <H3>Linked Ports</H3>
        <P>Create links between ports that share a geographical area (e.g. <Tag>USLAX</Tag> → <Tag>USLGB</Tag>). Useful for matching booking data where the same physical port appears under multiple codes.</P>
        <H3>Trade Lanes</H3>
        <P>14 FIATA high-level trade lanes are pre-configured (<Tag>FE</Tag>, <Tag>EU-N</Tag>, <Tag>ME</Tag>, etc.). Each lane lists its assigned countries. Use the edit modal to search for countries by name or ISO2 code and add or remove them from the lane.</P>
        <H3>Countries</H3>
        <P>ISO 3166-1 alpha-2 country registry pre-populated with 193 UN member states and key territories. Each country shows its assigned trade lanes and seaport count. Click <strong>View Locations</strong> to see all UN/LOCODE ports for that country.</P>
        <H3>UN Location Codes</H3>
        <P>A complete index of all 5-character codes in the system. The <strong>Has Seaport?</strong> column shows ✅ for any code that matches a port in the Port Locations database, and <Tag>—</Tag> for codes referenced in shipments but not yet in the master data.</P>
      </div>
    ),
    incoterms: (
      <div>
        <H2>Incoterms® 2020</H2>
        <P>Incoterms® are standardised trade terms published by the ICC, used in every international shipment to define where risk and cost transfer from seller to buyer.</P>
        <button onClick={() => setShowIncoterms(true)} style={{
          display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 20,
          padding: "9px 18px", borderRadius: 7, cursor: "pointer",
          background: T.accentBg, border: `1px solid ${T.accent}55`,
          color: T.accent, fontFamily: T.body, fontSize: 13, fontWeight: 600,
        }}>
          📋 Open Incoterm Information
        </button>
        <H3>The two groups</H3>
        <P><strong>Any transport mode</strong> (EXW, FCA, CPT, CIP, DAP, DPU, DDP) — suitable for all cargo types including containerised ocean freight.</P>
        <P><strong>Sea and inland waterway only</strong> (FAS, FOB, CFR, CIF) — intended for bulk and break-bulk. For containerised cargo, prefer FCA over FOB and CIP over CIF.</P>
        <H3>Key principle</H3>
        <P>Incoterms define where <em>risk</em> and <em>cost</em> transfer from seller to buyer. They do not determine title of goods, payment terms, or liability for cargo damage beyond the risk transfer point.</P>
        {showIncoterms && <IncotermsModal onClose={() => setShowIncoterms(false)} />}
      </div>
    ),
  };

  return (
    <div style={{ display: "flex", gap: 28 }}>
      {/* Sidebar TOC */}
      <div style={{ width: 180, flexShrink: 0 }}>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: ".1em", padding: "0 14px 8px" }}>Contents</div>
        {SECTIONS.map(s => <SectionBtn key={s.id} id={s.id} label={s.label} />)}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {content[section]}
      </div>
    </div>
  );
};


// ─── Shared: Vessel Combobox ──────────────────────────────────────────────────
// Async typeahead searching vessels by name, IMO, or asset type.

const VesselCombobox = ({ onSelect, placeholder = "Search vessels…", excludeImo }) => {
  const [query,   setQuery]   = useState("");
  const [results, setResults] = useState([]);
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);
  const box   = useRef(null);

  useEffect(() => {
    const h = e => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const search = q => {
    setQuery(q);
    clearTimeout(timer.current);
    if (q.trim().length < 1) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.vessels.search(q.trim());
        setResults(data.filter(v => v.imo !== excludeImo));
        setOpen(true);
      } catch {}
      setLoading(false);
    }, 220);
  };

  const select = vessel => { setQuery(""); setResults([]); setOpen(false); onSelect(vessel); };

  return (
    <div ref={box} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input value={query} onChange={e => search(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder={placeholder}
          style={{ ...inputBase, fontFamily: T.body, fontSize: 13, paddingRight: 32 }} />
        {loading && <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>…</span>}
      </div>
      {open && results.length > 0 && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 300,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
          boxShadow: "0 12px 32px rgba(0,0,0,.5)", overflow: "hidden", maxHeight: 260, overflowY: "auto" }}>
          {results.map(v => (
            <button key={v.imo} onClick={() => select(v)}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "9px 14px", background: "transparent", border: "none",
                cursor: "pointer", textAlign: "left", borderBottom: `1px solid ${T.border}33` }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, fontWeight: 700, flexShrink: 0, width: 70 }}>{v.imo}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</span>
              {v.assetType && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, flexShrink: 0, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.assetType}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// Vessel field used inside ShipmentForm (shows selected vessel or search input)
const VesselField = ({ vessel, onSelect }) => (
  <Field label="Vessel">
    {vessel?.imo ? (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ flex: 1, background: T.bg, border: `1px solid ${T.accent}55`, borderRadius: 6,
          padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>IMO {vessel.imo}</span>
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>{vessel.name}</span>
        </div>
        <button type="button" onClick={() => onSelect(null)}
          style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
            color: T.textMuted, cursor: "pointer", padding: "6px 10px", fontSize: 12 }}>✕</button>
      </div>
    ) : (
      <VesselCombobox placeholder="Search by name or IMO…" onSelect={onSelect} />
    )}
  </Field>
);

// ─── MDM: Vessels Page ────────────────────────────────────────────────────────

const MdmVesselsPage = () => {
  const [results, setResults]  = useState([]);
  const [total,   setTotal]    = useState(0);
  const [offset,  setOffset]   = useState(0);
  const [search,  setSearch]   = useState("");
  const [loading, setLoading]  = useState(true);
  const [modal,   setModal]    = useState(null);
  const [confirm, setConfirm]  = useState(null);
  const LIMIT = 50;
  const timer  = useRef(null);

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const res = await api.vessels.list({
        search: opts.search  !== undefined ? opts.search  : search,
        limit:  LIMIT,
        offset: opts.offset  !== undefined ? opts.offset  : offset,
      });
      setResults(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [search, offset]);

  useEffect(() => { load(); }, []);

  const handleSearch = v => {
    setSearch(v); setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 300);
  };
  const goPage = off => { setOffset(off); load({ offset: off }); };

  const VesselForm = ({ init = {}, onSave, onCancel }) => {
    const [f, setF] = useState({
      imo:          init.imo          || "",
      name:         init.name         || "",
      assetType:    init.assetType    || "",
      flagIso2:     init.flagIso2     || "",
      flagName:     init.flagName     || "",
      buildYear:    init.buildYear    ? String(init.buildYear)    : "",
      grossTonnage: init.grossTonnage ? String(init.grossTonnage) : "",
    });
    const set = k => v => setF(p => ({ ...p, [k]: v }));
    const isEdit = !!init.imo;
    const valid  = (isEdit || f.imo.trim().length >= 5) && f.name.trim().length >= 2;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!isEdit
          ? <Inp label="IMO Number" value={f.imo} onChange={set("imo")} placeholder="9222560" mono required hint="7-digit IMO identifier" />
          : <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px", fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>IMO {init.imo}</div>
        }
        <Inp label="Ship Name" value={f.name} onChange={v => setF(p => ({ ...p, name: v.toUpperCase() }))} placeholder="MSC ANNA" required />
        <Inp label="Asset Type" value={f.assetType} onChange={set("assetType")} placeholder="Container Ship" hint="Vessel type / category" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp label="Country Flag" value={f.flagName} onChange={set("flagName")} placeholder="Panama" />
          <Inp label="Flag ISO2" value={f.flagIso2} onChange={v => setF(p => ({ ...p, flagIso2: v.toUpperCase() }))} placeholder="PA" mono maxLength={2} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp label="Build Year" value={f.buildYear} onChange={set("buildYear")} type="number" placeholder="2010" />
          <Inp label="Gross Tonnage" value={f.grossTonnage} onChange={set("grossTonnage")} type="number" placeholder="164580" />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid} onClick={() => onSave({
            imo: f.imo.trim(), name: f.name.trim(), assetType: f.assetType || null,
            flagIso2: f.flagIso2 || null, flagName: f.flagName || null,
            buildYear: parseInt(f.buildYear) || null, grossTonnage: parseInt(f.grossTonnage) || null,
          })}>
            {isEdit ? "Save Changes" : "Add Vessel"}
          </Btn>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Vessels</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total.toLocaleString()} vessel{total !== 1 ? "s" : ""} · IMO registry · linked to country flags
          </p>
        </div>
        <Btn onClick={() => setModal("add")} size="lg">＋ Add Vessel</Btn>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 14 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search by ship name, IMO, or vessel type…"
          style={{ ...inputBase, fontFamily: T.body, fontSize: 14, maxWidth: 460 }} />
      </div>

      {/* Table */}
      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 1fr 90px 80px 110px 130px",
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["IMO", "Ship Name", "Asset Type", "Flag", "Built", "Gross Ton.", "Actions"].map((h, i) => (
            <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body }}>Loading…</div>
        ) : results.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            {search ? "No vessels match your search." : "No vessels yet. Run: node import-mdm-data.js"}
          </div>
        ) : results.map(v => (
          <div key={v.imo}
            style={{ display: "grid", gridTemplateColumns: "90px 1fr 1fr 90px 80px 110px 130px",
              padding: "12px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, fontWeight: 700 }}>{v.imo}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>{v.name}</span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{v.assetType || "—"}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {v.flagIso2
                ? <><Badge variant="default">{v.flagIso2}</Badge><span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>{v.flagName}</span></>
                : <span style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>{v.flagName || "—"}</span>
              }
            </div>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{v.buildYear || "—"}</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{v.grossTonnage ? v.grossTonnage.toLocaleString() : "—"}</span>
            <div style={{ display: "flex", gap: 5 }}>
              <Btn size="sm" variant="secondary" onClick={() => setModal(v)}>✎ Edit</Btn>
              <Btn size="sm" variant="danger"    onClick={() => setConfirm(v.imo)}>✕</Btn>
            </div>
          </div>
        ))}
      </div>

      <Pagination total={total} offset={offset} limit={LIMIT} onPage={goPage} />

      {modal === "add" && (
        <Modal title="Add Vessel" onClose={() => setModal(null)} width={520}>
          <VesselForm onSave={async d => { await api.vessels.create(d); setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Vessel" onClose={() => setModal(null)} width={520}>
          <VesselForm init={modal}
            onSave={async d => { await api.vessels.update(modal.imo, d); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Remove vessel IMO ${confirm}? Shipments referencing it will retain the vessel name.`}
          onConfirm={async () => { await api.vessels.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=DM+Sans:wght@300;400;500;600&display=swap";
    document.head.appendChild(link);
    return () => document.head.removeChild(link);
  }, []);

  const [carriers,    setCarriers]    = useState([]);
  const [shipments,   setShipments]   = useState([]);
  const [containers,  setContainers]  = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [ready,       setReady]       = useState(false);
  const [apiError,    setApiError]    = useState(null);

  const [page,       setPage]       = useState("shipments");
  const [selectedId, setSelectedId] = useState(null);
  const [showNewShp, setShowNewShp] = useState(false);
  const [mdmOpen,    setMdmOpen]    = useState(true);

  // Load all data on mount
  useEffect(() => {
    Promise.all([
      api.carriers.list(),
      api.shipments.list(),
      api.containers.list(),
      api.allocations.list(),
    ])
      .then(([c, s, ct, a]) => {
        setCarriers(c);
        setShipments(s);
        setContainers(ct);
        setAllocations(a);
        setReady(true);
      })
      .catch(e => setApiError(e.message));
  }, []);

  const selectedShipment = shipments.find(s => s.id === selectedId);
  const navigate = (key) => { setPage(key); setSelectedId(null); setShowNewShp(false); };

  const MDM_PAGES = ["mdm-carriers", "mdm-ports", "mdm-linked", "mdm-vessels", "mdm-tradelanes", "mdm-countries", "mdm-unlocodes"];
  const ALL_PAGES = [...MDM_PAGES, "manual"];
  const isMdmActive = MDM_PAGES.includes(page);

  if (apiError) return (
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg, alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div style={{ fontFamily: T.head, fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 12 }}>⚓ CargoDesk</div>
        <div style={{ background: T.dangerBg, border: `1px solid ${T.danger}55`, borderRadius: 8, padding: "14px 18px",
          fontFamily: T.body, fontSize: 13, color: T.danger, marginBottom: 12 }}>
          Cannot reach the API server.<br /><strong>{apiError}</strong>
        </div>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          Make sure the Express server is running: <code style={{ fontFamily: T.mono, color: T.textCode }}>node server.js</code>
        </div>
      </div>
    </div>
  );

  if (!ready) return (
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg, alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: T.head, fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 8 }}>⚓ CargoDesk</div>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Connecting to database…</div>
      </div>
    </div>
  );

  // ── Shared nav button style ──
  const NavBtn = ({ pageKey, icon, label, indent = false }) => {
    const active = page === pageKey || (pageKey === "shipments" && page === "detail");
    return (
      <button onClick={() => navigate(pageKey)}
        style={{ display: "flex", alignItems: "center", gap: 9, width: "100%",
          padding: indent ? "7px 12px 7px 28px" : "9px 12px",
          borderRadius: 7, border: "none", cursor: "pointer", marginBottom: 2, textAlign: "left",
          background: active ? T.accentBg : "transparent",
          color: active ? T.accent : T.textMuted,
          fontFamily: T.body, fontSize: indent ? 13 : 14, fontWeight: active ? 600 : 400,
          borderLeft: `3px solid ${active ? T.accent : "transparent"}` }}>
        <span style={{ fontSize: indent ? 13 : 15 }}>{icon}</span>
        {label}
      </button>
    );
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg, fontFamily: T.body, color: T.text }}>

      {/* ── Sidebar ── */}
      <aside style={{ width: 240, background: T.surface, borderRight: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column", flexShrink: 0 }}>

        {/* Logo */}
        <div style={{ padding: "22px 20px 20px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ fontFamily: T.head, fontSize: 17, fontWeight: 800, color: T.text }}>⚓ CargoDesk</div>
          <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted, marginTop: 3, letterSpacing: ".12em", textTransform: "uppercase" }}>
            Freight Management
          </div>
        </div>

        {/* Nav */}
        <nav style={{ padding: "14px 12px", flex: 1, overflowY: "auto" }}>

          {/* Top-level items */}
          <NavBtn pageKey="shipments" icon="⛴" label="Shipments" />
          <NavBtn pageKey="dashboard" icon="◈" label="Dashboard" />

          {/* MDM section */}
          <div style={{ marginTop: 10 }}>
            {/* MDM section header — clickable to expand/collapse */}
            <button onClick={() => setMdmOpen(o => !o)}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                width: "100%", padding: "6px 12px", background: "none", border: "none", cursor: "pointer",
                marginBottom: 2 }}>
              <span style={{ fontFamily: T.mono, fontSize: 9.5, color: isMdmActive ? T.accent : T.border,
                fontWeight: 700, textTransform: "uppercase", letterSpacing: ".12em" }}>
                Master Data
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.border, transition: "transform .2s",
                display: "inline-block", transform: mdmOpen ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
            </button>

            {mdmOpen && (
              <div>
                {/* Directory */}
                <div style={{ fontFamily: T.mono, fontSize: 9, color: T.border, fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: ".1em", padding: "5px 12px 3px 28px" }}>Directory</div>
                <NavBtn pageKey="mdm-carriers" icon="🏢" label="Carriers"       indent />
                <NavBtn pageKey="mdm-vessels"  icon="🚢" label="Vessels"         indent />
                <NavBtn pageKey="mdm-ports"    icon="📍" label="Port Locations" indent />
                <NavBtn pageKey="mdm-linked"   icon="🔗" label="Linked Ports"   indent />

                {/* Locations sub-section */}
                <div style={{ fontFamily: T.mono, fontSize: 9, color: T.border, fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: ".1em", padding: "10px 12px 3px 28px" }}>Locations</div>
                <NavBtn pageKey="mdm-tradelanes" icon="🌊" label="Trade Lanes"         indent />
                <NavBtn pageKey="mdm-countries" icon="🏳" label="Countries"          indent />
                <NavBtn pageKey="mdm-unlocodes" icon="🔢" label="UN Location Codes"  indent />
              </div>
            )}
          </div>
          {/* Utility */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, color: T.border, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: ".1em", padding: "5px 12px 3px 12px" }}>Help</div>
            <NavBtn pageKey="manual" icon="📖" label="User Manual" />
          </div>
        </nav>

      </aside>

      {/* ── Main ── */}
      <main style={{ flex: 1, padding: "32px 36px", overflow: "auto" }}>

        {/* Operational pages */}
        {page === "shipments" && (
          <>
            <ShipmentsPage
              shipments={shipments} containers={containers} carriers={carriers}
              onSelect={id => { setSelectedId(id); setPage("detail"); }}
              onDelete={async id => {
                await api.shipments.remove(id);
                setShipments(p => p.filter(s => s.id !== id));
                setContainers(p => p.filter(c => c.shipmentId !== id));
              }}
              onNew={() => setShowNewShp(true)} />
            {showNewShp && (
              <Modal title="New Shipment" onClose={() => setShowNewShp(false)} width={560}>
                <ShipmentForm carriers={carriers}
                  onSave={async form => {
                    const created = await api.shipments.create(form);
                    setShipments(p => [created, ...p]);
                    setShowNewShp(false);
                  }}
                  onCancel={() => setShowNewShp(false)} />
              </Modal>
            )}
          </>
        )}

        {page === "detail" && selectedShipment && (
          <ShipmentDetailPage
            shipment={selectedShipment} containers={containers} carriers={carriers}
            onBack={() => { setPage("shipments"); setSelectedId(null); }}
            onUpdate={async (id, form) => {
              const updated = await api.shipments.update(id, form);
              setShipments(p => p.map(s => s.id === id ? { ...s, ...updated } : s));
            }}
            onAddContainer={async (shipmentId, form) => {
              const created = await api.containers.create({ shipmentId, ...form });
              setContainers(p => [...p, created]);
            }}
            onEditContainer={async (id, form) => {
              const updated = await api.containers.update(id, form);
              setContainers(p => p.map(c => c.id === id ? { ...c, ...updated } : c));
            }}
            onDeleteContainer={async id => {
              await api.containers.remove(id);
              setContainers(p => p.filter(c => c.id !== id));
            }} />
        )}

        {page === "dashboard" && (
          <DashboardPage
            shipments={shipments} containers={containers} carriers={carriers}
            allocations={allocations}
            onAddAlloc={async form => {
              const created = await api.allocations.create(form);
              setAllocations(p => [...p, created]);
            }}
            onEditAlloc={async (id, form) => {
              const updated = await api.allocations.update(id, form);
              setAllocations(p => p.map(a => a.id === id ? { ...a, ...updated } : a));
            }}
            /* note: errors propagate to AllocationForm.handleSave catch block */
            onDeleteAlloc={async id => {
              await api.allocations.remove(id);
              setAllocations(p => p.filter(a => a.id !== id));
            }} />
        )}

        {/* MDM pages */}
        {page === "mdm-carriers" && (
          <CarriersPage
            carriers={carriers}
            onAdd={async data => {
              const created = await api.carriers.create(data);
              setCarriers(p => [...p, created]);
            }}
            onEdit={async (code, data) => {
              const updated = await api.carriers.update(code, data);
              setCarriers(p => p.map(c => c.code === code ? { ...c, ...updated } : c));
            }}
            onDelete={async code => {
              await api.carriers.remove(code);
              setCarriers(p => p.filter(c => c.code !== code));
            }} />
        )}

        {page === "mdm-vessels"   && <MdmVesselsPage />}
        {page === "mdm-ports"     && <MdmPortLocationsPage />}
        {page === "mdm-linked"    && <MdmLinkedPortsPage />}
        {page === "mdm-tradelanes" && <MdmTradeLanesPage />}
        {page === "mdm-countries" && <MdmCountriesPage />}
        {page === "mdm-unlocodes" && <MdmUNLocationCodesPage />}
        {page === "manual"         && <UserManualPage />}

      </main>


    </div>
  );
}