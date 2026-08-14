import { useState } from "react";
import { T } from "../../tokens";
import { IconInfo } from "./Icon";

// ─── InfoHint ─────────────────────────────────────────────────────────────────
// Small "i" badge that reveals explanatory text on hover — same opaque popover
// styling every other dropdown/combobox in this app already uses (T.surface +
// T.border + a real shadow), not a translucent tint. Originally a one-off
// ("CommodityHint", ShipmentFormPage.jsx) with a hand-drawn "i" glyph and a
// see-through background; generalized here so any field can reuse it.

const InfoHint = ({ children, label = "About this field", width = 220 }) => {
  const [vis, setVis] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setVis(true)} onMouseLeave={() => setVis(false)}>
      <IconInfo size={13} color={T.info} style={{ cursor: "default" }} />
      {vis && (
        <span style={{
          position: "absolute", left: 0, top: "calc(100% + 7px)", zIndex: 99,
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 8, padding: "8px 12px", width,
          fontFamily: T.body, fontSize: 11.5, color: T.text, lineHeight: 1.55,
          pointerEvents: "none", boxShadow: "0 6px 18px rgba(0,0,0,.35)",
        }}>
          {label && (
            <span style={{ display: "block", fontWeight: 700, fontSize: 10,
              textTransform: "uppercase", letterSpacing: "0.07em", color: T.info, marginBottom: 4 }}>
              {label}
            </span>
          )}
          {children}
        </span>
      )}
    </span>
  );
};

export default InfoHint;
