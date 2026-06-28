import { useState, useEffect, useRef } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { inputBase, Field } from "../primitives/Form";

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

export { VesselCombobox, VesselField };