import React, { useState } from "react";
import { T, CONTRACT_PRESETS } from "../../tokens";
import Btn from "./Btn";

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

// Getters re-evaluate T on every spread — theme-safe across light/dark switches.
export const inputBase = {
  get background() { return T.bg; },
  get border()     { return `1px solid ${T.border}`; },
  get color()      { return T.text; },
  borderRadius: 6, padding: "8px 12px",
  outline: "none", width: "100%", boxSizing: "border-box",
};

const Inp = ({ label, value, onChange, placeholder, mono, maxLength, required, hint, type = "text", inputMode }) => (
  <Field label={label} required={required} hint={hint}>
    <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
      maxLength={maxLength} type={type} inputMode={inputMode}
      style={{ ...inputBase, fontFamily: mono ? T.mono : T.body, fontSize: mono ? 13 : 14 }} />
  </Field>
);

const Sel = ({ label, value, onChange, options, required, error }) => (
  <Field label={label} required={required}>
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ ...inputBase, fontFamily: T.body, fontSize: 14, cursor: "pointer",
        ...(error ? { borderColor: T.danger, boxShadow: `0 0 0 2px ${T.danger}44` } : {}) }}>
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


// ─── Shared: Contract Type Picker ─────────────────────────────────────────────

const ContractTypeInput = ({ value, onChange }) => (
  <div>
    <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
      Contract Type <span style={{ color: T.danger }}>*</span>
    </div>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {CONTRACT_PRESETS.map(t => (
        <BtnToggle key={t} selected={value === t} onClick={() => onChange(t)}>{t}</BtnToggle>
      ))}
    </div>
  </div>
);

// ─── Forms ────────────────────────────────────────────────────────────────────

export { BtnToggle, Field, Inp, Sel, Textarea, ContractTypeInput };