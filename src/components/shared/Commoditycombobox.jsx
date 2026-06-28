import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../../tokens";
import { inputBase } from "../primitives/Form";
import { api } from "../../api";

// ─── Grade badge colours ──────────────────────────────────────────────────────
const GRADE_COLOR = {
  M: "#34C759", // Food Grade — green
  K: "#007AFF", // Premium   — blue
  E: "#8E8E93", // General   — grey
  S: "#FF9F0A", // Flexi     — amber
  Q: "#FF3B30", // Scrap     — red
};

const GradePill = ({ code, name }) => (
  <span style={{
    display: "inline-flex", alignSelf: "center", width: "fit-content",
    fontFamily: T.mono, fontSize: 9.5, fontWeight: 700,
    color: GRADE_COLOR[code] || T.textMuted,
    background: (GRADE_COLOR[code] || T.border) + "18",
    border: `1px solid ${(GRADE_COLOR[code] || T.border)}44`,
    borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap",
  }}>
    {name}
  </span>
);

// ─── CommodityCombobox ────────────────────────────────────────────────────────

const CommodityCombobox = ({ value, onChange, placeholder = "Search by code or description…" }) => {
  const [query,    setQuery]    = useState("");
  const [results,  setResults]  = useState([]);
  const [open,     setOpen]     = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [selected,   setSelected]   = useState(null);
  const [highlighted,setHighlighted] = useState(-1);
  const timer   = useRef(null);
  const box     = useRef(null);
  const listRef = useRef(null);

  // Load selected commodity on mount / when value changes externally
  useEffect(() => {
    if (!value) { setSelected(null); return; }
    if (selected?.code === value) return;
    api.commodities.get(value)
      .then(setSelected)
      .catch(() => setSelected({ code: value, description: value, gradeCode: "E", gradeName: "General Cargo" }));
  }, [value]);

  // Close on outside click
  useEffect(() => {
    const h = e => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const search = q => {
    setQuery(q); setHighlighted(-1);
    clearTimeout(timer.current);
    if (!q.trim()) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.commodities.search(q.trim());
        setResults(data); setOpen(data.length > 0);
      } catch {}
      setLoading(false);
    }, 200);
  };

  const select = useCallback(c => {
    setSelected(c); setQuery(""); setResults([]); setOpen(false); setHighlighted(-1); onChange(c.code);
  }, [onChange]);

  const handleKeyDown = e => {
    if (!open || results.length === 0) return;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setHighlighted(h => Math.min(h + 1, results.length - 1)); break;
      case "ArrowUp":   e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); break;
      case "Enter":     e.preventDefault(); { const idx = highlighted >= 0 ? highlighted : 0; if (results[idx]) select(results[idx]); } break;
      case "Escape":    setOpen(false); setHighlighted(-1); break;
    }
  };

  const clear = () => {
    setSelected(null); setQuery(""); onChange("");
  };

  return (
    <div ref={box} style={{ position: "relative" }}>
      {selected ? (
        <div style={{
          ...inputBase,
          display: "flex", alignItems: "center", gap: 8,
          border: `1px solid ${T.accent}55`,
        }}>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700, flexShrink: 0 }}>
            {selected.code}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selected.description}
          </span>
          <GradePill code={selected.gradeCode} name={selected.gradeName} />
          <button type="button" onClick={clear}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 14, padding: "0 2px", flexShrink: 0 }}>✕</button>
        </div>
      ) : (
        <>
          <div style={{ position: "relative" }}>
            <input value={query} onChange={e => search(e.target.value)}
              onFocus={() => results.length > 0 && setOpen(true)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder} autoComplete="off"
              style={{ ...inputBase, fontFamily: T.body, fontSize: 13, paddingRight: 32 }} />
            {loading && (
              <span style={{ position: "absolute", right: 10, top: "50%",
                transform: "translateY(-50%)", fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>…</span>
            )}
          </div>

          {open && results.length > 0 && (
            <div style={{
              position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
              zIndex: 400, background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.4)",
              overflow: "hidden", maxHeight: 280, overflowY: "auto",
            }} ref={listRef}>
              {results.map((c, idx) => (
                <button key={c.code} type="button" onClick={() => select(c)}
                  onMouseEnter={() => setHighlighted(idx)}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "9px 14px", background: idx === highlighted ? T.surfaceHover : "transparent",
                    border: "none", cursor: "pointer", textAlign: "left",
                    borderBottom: `1px solid ${T.border}22` }}>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent,
                    fontWeight: 700, flexShrink: 0, width: 60 }}>{c.code}</span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text,
                    flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.description}
                  </span>
                  <GradePill code={c.gradeCode} name={c.gradeName} />
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export { CommodityCombobox, GradePill };