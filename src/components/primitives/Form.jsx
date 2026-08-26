import React, { useState } from "react";
import { T, CONTRACT_PRESETS } from "../../tokens";
import Btn from "./Btn";
import InfoHint from "./InfoHint";

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

// hint renders as an InfoHint icon next to the label, revealed on hover, rather than a
// permanent caption line underneath — was a real report (originally the Commodity field's own
// hand-rolled version, ShipmentFormPage.jsx): a plain always-visible caption competed with the
// label for the same row's height, so two side-by-side Fields in a grid row with different
// combined label+hint lengths wrapped to a different number of lines and visibly misaligned
// (VGM Weight/VGM Status, ContainerForm) — an earlier fix (v0.39.1) gave label and hint their
// own lines, which helped but still let hint length vary row height. Hiding it behind hover
// removes that variable entirely: every field's visible height is now just label + input,
// regardless of whether — or how much — hint text it carries.
const Field = ({ label, required, hint, children }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    {label && (
      <label style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>
        {label}{required && <span style={{ color: T.danger }}> *</span>}
        {hint && <InfoHint>{hint}</InfoHint>}
      </label>
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

const Inp = ({ id, label, value, onChange, onBlur, placeholder, mono, maxLength, required, hint, type = "text", inputMode, disabled = false }) => (
  <Field label={label} required={required} hint={hint}>
    <input id={id} value={value} onChange={e => onChange(e.target.value)} onBlur={onBlur} placeholder={placeholder}
      maxLength={maxLength} type={type} inputMode={inputMode} disabled={disabled}
      style={{ ...inputBase, fontFamily: mono ? T.mono : T.body, fontSize: mono ? 13 : 14,
        opacity: disabled ? 0.6 : 1, cursor: disabled ? "not-allowed" : "text" }} />
  </Field>
);

const Sel = ({ id, label, value, onChange, options, required, error, hint, disabled = false }) => (
  <Field label={label} required={required} hint={hint}>
    <select id={id} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
      style={{ ...inputBase, fontFamily: T.body, fontSize: 14, cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        ...(error ? { borderColor: T.danger, boxShadow: `0 0 0 2px ${T.danger}44` } : {}) }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </Field>
);

const Textarea = ({ label, value, onChange, placeholder, rows = 3, disabled = false }) => (
  <Field label={label}>
    <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows} disabled={disabled}
      style={{ ...inputBase, fontFamily: T.body, fontSize: 14, resize: "vertical", opacity: disabled ? 0.6 : 1 }} />
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