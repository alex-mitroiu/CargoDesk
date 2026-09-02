import { useState, useEffect, useRef } from "react";
import { T } from "../../tokens";
import { inputBase } from "../primitives/Form";
import { api } from "../../api";

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
        const { results } = await api.countries.list({ search: q.trim() });
        setResults(results.filter(c => !excludeIso2s.includes(c.iso2)));
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

export default CountryCombobox;