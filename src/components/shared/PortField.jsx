import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import PortCombobox from "./PortCombobox";

// ─── PortField ────────────────────────────────────────────────────────────────
// Labelled port selector used across forms throughout the app.
//
// Props:
//   label      — field label text
//   value      — controlled: { unlocode, name, countryCode } | null
//   onChange   — called with port object on select, null on clear
//   placeholder — input hint text
//   required   — shows a red asterisk next to the label
//   showLinks  — when true, fetches and shows clickable linked-port chips

const PortField = ({
  label,
  value = null,
  onChange,
  placeholder,
  required = false,
  showLinks = false,
}) => {
  const [links,   setLinks]   = useState([]);
  const [loadLnk, setLoadLnk] = useState(false);

  useEffect(() => {
    if (!showLinks || !value?.unlocode) { setLinks([]); return; }
    setLoadLnk(true);
    api.portLinks(value.unlocode)
      .then(rows => setLinks(rows || []))
      .catch(() => setLinks([]))
      .finally(() => setLoadLnk(false));
  }, [value?.unlocode, showLinks]);

  return (
    <div>
      {label && (
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>
          {label}
          {required && <span style={{ color: T.danger }}> *</span>}
        </div>
      )}

      <PortCombobox value={value} onChange={onChange} placeholder={placeholder} />

      {showLinks && (
        <>
          {loadLnk && (
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.border,
              marginTop: 5, display: "block" }}>
              Checking linked locations…
            </span>
          )}
          {!loadLnk && links.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5,
              alignItems: "center", marginTop: 6 }}>
              <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, flexShrink: 0 }}>
                Covers linked:
              </span>
              {links.map(lp => (
                <button key={lp.unlocode} type="button" title={lp.name || lp.unlocode}
                  onClick={() => onChange({ unlocode: lp.unlocode, name: lp.name || "" })}
                  style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 600,
                    color: T.textMuted, background: T.bg,
                    border: `1px solid ${T.border}`, borderRadius: 4,
                    padding: "2px 8px", cursor: "pointer",
                    transition: "border-color .1s, color .1s" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}>
                  {lp.unlocode}
                </button>
              ))}
              <span style={{ fontFamily: T.body, fontSize: 10, color: T.border, fontStyle: "italic" }}>
                — click to switch
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default PortField;
