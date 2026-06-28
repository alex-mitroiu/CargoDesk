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


// ─── Shared: Contract Type Picker ─────────────────────────────────────────────

const ContractTypeTooltip = ({ text }) => {
  const [show, setShow] = React.useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <div style={{
        padding: "6px 14px", borderRadius: 6, fontFamily: T.body, fontSize: 13, fontWeight: 500,
        background: T.surface, border: `1px solid ${T.border}`,
        color: T.border, cursor: "not-allowed", userSelect: "none",
        opacity: 0.55,
      }}>
        Central Contract
      </div>
      {show && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: "50%",
          transform: "translateX(-50%)", zIndex: 400,
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 8, padding: "10px 14px",
          boxShadow: "0 8px 24px rgba(0,0,0,.5)",
          minWidth: 240, maxWidth: 300,
        }}>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.warning, fontWeight: 600, marginBottom: 4 }}>
            🔒 Not yet available
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
            Central Contracts require a dedicated Contract Management module and a separate DB table.
            This will be implemented in a future release.
          </div>
          {/* Tooltip arrow */}
          <div style={{
            position: "absolute", bottom: -6, left: "50%", transform: "translateX(-50%) rotate(45deg)",
            width: 10, height: 10, background: T.surface, borderRight: `1px solid ${T.border}`,
            borderBottom: `1px solid ${T.border}`,
          }} />
        </div>
      )}
    </div>
  );
};

const ContractTypeInput = ({ value, onChange }) => (
  <div>
    <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
      Contract Type <span style={{ color: T.danger }}>*</span>
    </div>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {CONTRACT_PRESETS.map(t => (
        <BtnToggle key={t} selected={value === t} onClick={() => onChange(t)}>{t}</BtnToggle>
      ))}
      <ContractTypeTooltip />
    </div>
  </div>
);

// ─── Forms ────────────────────────────────────────────────────────────────────

export { BtnToggle, Field, Inp, Sel, Textarea, ContractTypeInput };