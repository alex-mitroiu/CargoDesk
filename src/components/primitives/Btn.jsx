import { useState } from "react";
import { T } from "../../tokens";

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

export default Btn;
