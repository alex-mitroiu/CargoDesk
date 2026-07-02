import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../../tokens";
import { inputBase } from "../primitives/Form";
import { Modal } from "../primitives/Modal";
import Pagination from "../primitives/Pagination";
import Btn from "../primitives/Btn";
import { api } from "../../api";

// ─── Grade colours ────────────────────────────────────────────────────────────
const GRADE_COLOR = {
  M: "#34C759",
  K: "#007AFF",
  E: "#8E8E93",
  S: "#FF9F0A",
  Q: "#FF3B30",
};

const GRADES = [
  { code: "M", name: "Food Grade" },
  { code: "K", name: "Premium" },
  { code: "E", name: "General" },
  { code: "S", name: "Flexi" },
  { code: "Q", name: "Scrap" },
];

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

// ─── Commodity Picker Modal ───────────────────────────────────────────────────

const PICKER_LIMIT = 20;

export const CommodityPickerModal = ({ onSelect, onClose }) => {
  const [rows,    setRows]    = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [search,  setSearch]  = useState("");
  const [grade,   setGrade]   = useState("");
  const [loading, setLoading] = useState(true);
  const searchRef = useRef(null);

  const doLoad = useCallback(async (s, g, off) => {
    setLoading(true);
    try {
      const res = await api.commodities.list({ search: s.trim(), grade: g, limit: PICKER_LIMIT, offset: off });
      setRows(res.results || []);
      setTotal(res.total  || 0);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { doLoad("", "", 0); searchRef.current?.focus(); }, []);

  const handleSearch = () => { setOffset(0); doLoad(search, grade, 0); };
  const handleKey    = e => { if (e.key === "Enter") handleSearch(); };
  const handleGrade  = g => {
    const next = grade === g ? "" : g;
    setGrade(next); setOffset(0); doLoad(search, next, 0);
  };
  const handleClear  = () => { setSearch(""); setGrade(""); setOffset(0); doLoad("", "", 0); };
  const goPage = off => { setOffset(off); doLoad(search, grade, off); };

  const hasFilters = search.trim() || grade;

  return (
    <Modal title="Select Commodity" onClose={onClose} width={660}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Search + grade filters */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <input
            ref={searchRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Code or description…"
            style={{ ...inputBase, flex: "1 1 200px", minWidth: 160 }}
          />
          <Btn onClick={handleSearch}>Search</Btn>
          {hasFilters && <Btn variant="secondary" onClick={handleClear}>Clear</Btn>}
        </div>

        {/* Grade pills */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {GRADES.map(g => {
            const active = grade === g.code;
            return (
              <button key={g.code} type="button" onClick={() => handleGrade(g.code)}
                style={{
                  fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
                  padding: "3px 10px", borderRadius: 20,
                  color:      active ? "#fff" : GRADE_COLOR[g.code],
                  background: active ? GRADE_COLOR[g.code] : GRADE_COLOR[g.code] + "18",
                  border: `1px solid ${GRADE_COLOR[g.code]}${active ? "" : "44"}`,
                  transition: "all .1s",
                }}>
                {g.code} — {g.name}
              </button>
            );
          })}
        </div>

        {/* Result count */}
        {!loading && (
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            {hasFilters
              ? `${total} result${total !== 1 ? "s" : ""}`
              : `${total} commodity code${total !== 1 ? "s" : ""} in registry`}
          </div>
        )}

        {/* Table */}
        <div style={{ background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 0, padding: "8px 14px", borderBottom: `1px solid ${T.border}` }}>
            <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".08em", width: 72, flexShrink: 0 }}>Code</span>
            <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".08em", width: 180, flexShrink: 0 }}>Grade</span>
            <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".08em" }}>Description</span>
          </div>

          {loading ? (
            <div style={{ padding: 32, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
              {hasFilters ? "No commodities match your filters." : "No commodities in registry."}
            </div>
          ) : rows.map(c => (
            <button key={c.code} type="button" onClick={() => onSelect(c)}
              style={{ display: "flex", alignItems: "flex-start",
                width: "100%", padding: "10px 14px", background: "none", border: "none",
                borderBottom: `1px solid ${T.border}22`, cursor: "pointer", textAlign: "left" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700,
                width: 72, flexShrink: 0, paddingTop: 1 }}>
                {c.code}
              </span>
              <div style={{ width: 180, flexShrink: 0, paddingRight: 16, paddingTop: 1 }}>
                <GradePill code={c.gradeCode} name={c.gradeName} />
              </div>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.4 }}>
                {c.description}
              </span>
            </button>
          ))}
        </div>

        {total > PICKER_LIMIT && (
          <Pagination total={total} limit={PICKER_LIMIT} offset={offset} onPage={goPage} />
        )}
      </div>
    </Modal>
  );
};

// ─── CommodityCombobox ────────────────────────────────────────────────────────

const CommodityCombobox = ({ value, onChange, placeholder = "Search by code or description…" }) => {
  const [query,       setQuery]       = useState("");
  const [results,     setResults]     = useState([]);
  const [open,        setOpen]        = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [selected,    setSelected]    = useState(null);
  const [highlighted, setHighlighted] = useState(-1);
  const [pickerOpen,  setPickerOpen]  = useState(false);
  const [dropPos,     setDropPos]     = useState({ top: 0, left: 0, width: 0 });
  const timer   = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const box     = useRef(null);

  useEffect(() => {
    if (!value) { setSelected(null); return; }
    if (selected?.code === value) return;
    api.commodities.get(value)
      .then(setSelected)
      .catch(() => setSelected({ code: value, description: value, gradeCode: "E", gradeName: "General Cargo" }));
  }, [value]);

  useEffect(() => {
    const h = e => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const computeDropPos = () => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropPos({ top: r.bottom + 4, left: r.left, width: r.width });
  };

  const search = q => {
    setQuery(q); setHighlighted(-1);
    clearTimeout(timer.current);
    if (!q.trim()) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.commodities.search(q.trim());
        setResults(data);
        if (data.length > 0) { computeDropPos(); setOpen(true); }
        else setOpen(false);
      } catch {}
      setLoading(false);
    }, 200);
  };

  const select = useCallback(c => {
    setSelected(c); setQuery(""); setResults([]); setOpen(false); setHighlighted(-1); onChange(c.code);
  }, [onChange]);

  const handlePickerSelect = c => { select(c); setPickerOpen(false); };

  const handleKeyDown = e => {
    if (!open || results.length === 0) return;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setHighlighted(h => Math.min(h + 1, results.length - 1)); break;
      case "ArrowUp":   e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); break;
      case "Enter":     e.preventDefault(); { const idx = highlighted >= 0 ? highlighted : 0; if (results[idx]) select(results[idx]); } break;
      case "Escape":    setOpen(false); setHighlighted(-1); break;
    }
  };

  const clear = () => { setSelected(null); setQuery(""); onChange(""); };

  return (
    <div ref={box} style={{ position: "relative" }}>
      {selected ? (
        <div style={{ ...inputBase, display: "flex", alignItems: "center", gap: 8, border: `1px solid ${T.accent}55` }}>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700, flexShrink: 0 }}>
            {selected.code}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selected.description}
          </span>
          <GradePill code={selected.gradeCode} name={selected.gradeName} />
          <button type="button" onClick={() => setPickerOpen(true)}
            title="Browse commodity list"
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 13, padding: "0 2px", flexShrink: 0 }}
            onMouseEnter={e => e.currentTarget.style.color = T.text}
            onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
            🔍
          </button>
          <button type="button" onClick={clear}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 14, padding: "0 2px", flexShrink: 0 }}>✕</button>
        </div>
      ) : (
        <>
          <div style={{ position: "relative" }}>
            <input ref={inputRef} value={query} onChange={e => search(e.target.value)}
              onFocus={() => { if (results.length > 0) { computeDropPos(); setOpen(true); } }}
              onKeyDown={handleKeyDown}
              placeholder={placeholder} autoComplete="off"
              style={{ ...inputBase, fontFamily: T.body, fontSize: 13, paddingRight: 52, width: "100%", boxSizing: "border-box" }} />
            {loading && (
              <span style={{ position: "absolute", right: 32, top: "50%",
                transform: "translateY(-50%)", fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>…</span>
            )}
            {/* 🔍 browse button */}
            <button type="button" onClick={() => setPickerOpen(true)}
              title="Browse all commodities"
              style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer",
                color: T.textMuted, fontSize: 13, padding: 2, lineHeight: 1 }}
              onMouseEnter={e => e.currentTarget.style.color = T.text}
              onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
              🔍
            </button>
          </div>

          {/* Typeahead dropdown — position:fixed to escape modal overflow */}
          {open && results.length > 0 && (
            <div ref={listRef} style={{
              position: "fixed",
              top: dropPos.top, left: dropPos.left, width: dropPos.width,
              zIndex: 1100, background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.4)",
              overflow: "hidden", maxHeight: 280, overflowY: "auto",
            }}>
              {results.map((c, idx) => (
                <button key={c.code} type="button"
                  onMouseDown={e => { e.preventDefault(); select(c); }}
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

      {/* Full picker modal */}
      {pickerOpen && (
        <CommodityPickerModal
          onSelect={handlePickerSelect}
          onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
};

export { CommodityCombobox, GradePill };
