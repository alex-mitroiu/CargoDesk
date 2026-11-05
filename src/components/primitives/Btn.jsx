import { useState } from "react";
import { T } from "../../tokens";

const Btn = ({ id, children, onClick, variant = "primary", size = "md", disabled, style: extra, "data-testid": testId }) => {
  const [hov, setHov] = useState(false);
  // Trade Horizon pages (T.hz, src/tokens.js): a solid cyan primary (decided 2026-11-05, not the
  // gradient), a secondary in body text on the stronger border, slightly rounder corners.
  const hz = T.hz;
  const styles = {
    primary: {
      base:  { background: T.accent,        color: T.btnPrimaryText, border: "none" },
      hover: { background: T.accentHover,   color: T.btnPrimaryText, border: "none" },
    },
    secondary: {
      base:  { background: "transparent",       color: hz ? T.text : T.textMuted, border: `1px solid ${hz ? T.borderMid : T.border}` },
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
  const sizeStyle = hz ? {
    sm: { padding: "5px 11px",  fontSize: 12,   borderRadius: 6 },
    md: { padding: "8px 16px",  fontSize: 13,   borderRadius: 7 },
    lg: { padding: "10px 22px", fontSize: 14,   borderRadius: 8 },
  }[size] : {
    sm: { padding: "4px 11px",  fontSize: 11.5, borderRadius: 5 },
    md: { padding: "7px 16px",  fontSize: 13,   borderRadius: 6 },
    lg: { padding: "10px 22px", fontSize: 14,   borderRadius: 7 },
  }[size];
  const v = hov && !disabled ? styles.hover : styles.base;
  return (
    <button
      id={id}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        ...v, ...sizeStyle,
        fontFamily: T.body, fontWeight: hz && variant === "primary" ? 700 : 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? (hz ? 0.45 : 0.42) : 1,
        display: "inline-flex", alignItems: "center", gap: 6,
        transition: "background 0.14s, border-color 0.14s, color 0.14s",
        ...extra,
      }}
    >
      {children}
    </button>
  );
};

export default Btn;
