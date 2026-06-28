import { useState, useRef, useEffect, useCallback } from "react";
import { T } from "../../tokens";
import { inputBase } from "../primitives/Form";
import { api } from "../../api";

// ─── PortCombobox ─────────────────────────────────────────────────────────────
// Dropdown uses position:fixed so it escapes Modal overflow:auto clipping.

const PortCombobox = ({ placeholder = "Search port or LOCODE…", onChange }) => {
  const [query,    setQuery]    = useState("");
  const [results,  setResults]  = useState([]);
  const [open,     setOpen]     = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [dropStyle,setDropStyle]= useState({});
  const timer    = useRef(null);
  const inputRef = useRef(null);
  const dropRef  = useRef(null);

  // Position the fixed dropdown below the input
  const positionDrop = useCallback(() => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropStyle({
      position: "fixed",
      top:   r.bottom + 4,
      left:  r.left,
      width: r.width,
      zIndex: 9000,
    });
  }, []);

  // Close on outside click
  useEffect(() => {
    const h = e => {
      if (
        inputRef.current && !inputRef.current.contains(e.target) &&
        dropRef.current  && !dropRef.current.contains(e.target)
      ) { setOpen(false); }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Reposition if window scrolls / resizes while open
  useEffect(() => {
    if (!open) return;
    const update = () => positionDrop();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [open, positionDrop]);

  const search = q => {
    setQuery(q);
    clearTimeout(timer.current);
    if (!q.trim()) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.ports.search({ search: q.trim(), limit: "12" });
        const rows = data.results || [];
        setResults(rows);
        if (rows.length > 0) { positionDrop(); setOpen(true); }
      } catch {}
      setLoading(false);
    }, 200);
  };

  const select = r => {
    setQuery(""); setResults([]); setOpen(false);
    onChange(r);
  };

  return (
    <div style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <input
          ref={inputRef}
          value={query}
          onChange={e => search(e.target.value)}
          onFocus={() => { if (results.length > 0) { positionDrop(); setOpen(true); } }}
          placeholder={placeholder}
          style={{ ...inputBase, fontFamily: T.body, fontSize: 13, paddingRight: 32 }}
        />
        {loading && (
          <span style={{ position: "absolute", right: 10, top: "50%",
            transform: "translateY(-50%)", fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
            …
          </span>
        )}
      </div>

      {open && results.length > 0 && (
        <div ref={dropRef} style={{
          ...dropStyle,
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.4)",
          overflow: "hidden", maxHeight: 260, overflowY: "auto",
        }}>
          {results.map(r => (
            <button key={r.unlocode} type="button" onClick={() => select(r)}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "9px 14px", background: "transparent", border: "none",
                borderBottom: `1px solid ${T.border}22`, cursor: "pointer", textAlign: "left" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent,
                fontWeight: 700, flexShrink: 0, width: 52 }}>{r.unlocode}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}
              </span>
              {r.countryCode && (
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, flexShrink: 0 }}>
                  {r.countryCode}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default PortCombobox;