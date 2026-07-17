import { useState, useRef, useEffect, useCallback } from "react";
import { T } from "../../tokens";
import { inputBase } from "../primitives/Form";
import { Modal } from "../primitives/Modal";
import Pagination from "../primitives/Pagination";
import Btn from "../primitives/Btn";
import { api } from "../../api";

const PICKER_LIMIT = 20;

// ─── Port Picker Modal ────────────────────────────────────────────────────────
// Full paginated port browser: search by name or LOCODE, filter by country code.

export const PortPickerModal = ({ onSelect, onClose }) => {
  const [search,  setSearch]  = useState("");
  const [country, setCountry] = useState("");
  const [rows,    setRows]    = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [loading, setLoading] = useState(true);
  const searchRef = useRef(null);

  const doLoad = useCallback(async (s, c, off) => {
    setLoading(true);
    try {
      const res = await api.ports.search({
        search: s.trim(), country: c.trim(), limit: PICKER_LIMIT, offset: off,
      });
      setRows(res.results || []);
      setTotal(res.total || 0);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { doLoad("", "", 0); searchRef.current?.focus(); }, []);

  const hasFilters = search.trim() || country.trim();
  const handleSearch = () => { setOffset(0); doLoad(search, country, 0); };
  const handleClear  = () => { setSearch(""); setCountry(""); setOffset(0); doLoad("", "", 0); };
  const handleKey    = e => { if (e.key === "Enter") handleSearch(); };
  const goPage       = off => { setOffset(off); doLoad(search, country, off); };

  return (
    <Modal title="Select Port" onClose={onClose} width={620}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Filter bar */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            ref={searchRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Port name or LOCODE…"
            style={{ ...inputBase, flex: "1 1 200px" }}
          />
          <input
            value={country}
            onChange={e => setCountry(e.target.value.toUpperCase().slice(0, 2))}
            onKeyDown={handleKey}
            placeholder="CC"
            maxLength={2}
            style={{ ...inputBase, width: 52, textAlign: "center", textTransform: "uppercase" }}
          />
          <Btn onClick={handleSearch}>Search</Btn>
          {hasFilters && <Btn variant="secondary" onClick={handleClear}>Clear</Btn>}
        </div>

        {/* Count */}
        {!loading && (
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            {hasFilters
              ? `${total} result${total !== 1 ? "s" : ""}`
              : `${total.toLocaleString()} ports in directory`}
          </div>
        )}

        {/* Results table */}
        <div style={{ background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "76px 1fr 44px",
            padding: "7px 14px", borderBottom: `1px solid ${T.border}` }}>
            {["LOCODE", "Port Name", "CC"].map(h => (
              <span key={h} style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
            ))}
          </div>

          {loading ? (
            <div style={{ padding: 36, textAlign: "center", color: T.textMuted,
              fontFamily: T.body, fontSize: 13 }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 36, textAlign: "center", color: T.textMuted,
              fontFamily: T.body, fontSize: 13 }}>
              {hasFilters ? "No ports match your filters." : "No ports in directory."}
            </div>
          ) : rows.map(r => (
            <button key={r.unlocode} type="button" onClick={() => onSelect(r)}
              style={{ display: "grid", gridTemplateColumns: "76px 1fr 44px",
                width: "100%", padding: "10px 14px",
                background: "none", border: "none",
                borderBottom: `1px solid ${T.border}22`,
                cursor: "pointer", textAlign: "left", alignItems: "center" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>
                {r.unlocode}
              </span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 }}>
                {r.name}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                {r.countryCode}
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

// ─── PortCombobox ─────────────────────────────────────────────────────────────
// Self-contained port picker: typeahead dropdown + full picker modal.
//
// Props:
//   value      — controlled: { unlocode, name, countryCode } | null
//   onChange   — called with port object on select, null on clear
//   placeholder — input hint text

const PortCombobox = ({ value = null, onChange, placeholder = "Search port or LOCODE…" }) => {
  // displayValue enriches value.name via a background fetch when name is blank
  const [displayValue, setDisplayValue] = useState(value);
  const [query,        setQuery]        = useState("");
  const [results,      setResults]      = useState([]);
  const [open,         setOpen]         = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [highlighted,  setHighlighted]  = useState(-1);
  const [pickerOpen,   setPickerOpen]   = useState(false);
  const [dropStyle,    setDropStyle]    = useState({});
  const timer    = useRef(null);
  const inputRef = useRef(null);
  const dropRef  = useRef(null);

  // Keep displayValue in sync with value prop; fetch full name if missing
  useEffect(() => {
    setDisplayValue(value);
    if (!value?.unlocode || value.name) return;
    api.ports.get(value.unlocode)
      .then(r => { if (r) setDisplayValue({ unlocode: r.unlocode, name: r.name, countryCode: r.countryCode }); })
      .catch(() => {});
  }, [value?.unlocode]);

  const positionDrop = useCallback(() => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropStyle({ position: "fixed", top: r.bottom + 4, left: r.left, width: r.width, zIndex: 9000 });
  }, []);

  // Close dropdown on outside click
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
    setQuery(q); setHighlighted(-1);
    clearTimeout(timer.current);
    if (!q.trim()) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.ports.search({ search: q.trim(), limit: "12" });
        const rows = data.results || [];
        setResults(rows);
        if (rows.length > 0) { positionDrop(); setOpen(true); }
        else setOpen(false);
      } catch {}
      setLoading(false);
    }, 200);
  };

  const select = r => {
    setQuery(""); setResults([]); setOpen(false); setHighlighted(-1);
    onChange(r);
  };

  const clear = () => { onChange(null); };

  const handlePickerSelect = r => { onChange(r); setPickerOpen(false); };

  const handleKeyDown = e => {
    if (!open || results.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlighted(h => Math.min(h + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlighted(h => Math.max(h - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        { const i = highlighted >= 0 ? highlighted : 0; if (results[i]) select(results[i]); }
        break;
      case "Escape":
        setOpen(false); setHighlighted(-1);
        break;
    }
  };

  return (
    <div style={{ position: "relative" }}>
      {displayValue?.unlocode ? (
        // ── Selected chip ──────────────────────────────────────────────────────
        <div style={{ ...inputBase, display: "flex", alignItems: "center", gap: 8,
          border: `1px solid ${T.accent}55`, padding: "7px 10px" }}>
          <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent,
            fontWeight: 700, flexShrink: 0 }}>
            {displayValue.unlocode}
          </span>
          {displayValue.name && (
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {displayValue.name}
            </span>
          )}
          {displayValue.countryCode && (
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, flexShrink: 0 }}>
              {displayValue.countryCode}
            </span>
          )}
          <button type="button" onClick={() => setPickerOpen(true)}
            title="Browse port directory"
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 13, padding: "0 2px", flexShrink: 0, lineHeight: 1 }}
            onMouseEnter={e => e.currentTarget.style.color = T.text}
            onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
            🔍
          </button>
          <button type="button" onClick={clear}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 15, padding: "0 2px", flexShrink: 0, lineHeight: 1 }}>
            ✕
          </button>
        </div>
      ) : (
        // ── Search input ───────────────────────────────────────────────────────
        <>
          <div style={{ position: "relative", paddingTop: 5, paddingBottom: 5 }}>
            <input
              ref={inputRef}
              value={query}
              onChange={e => search(e.target.value)}
              onFocus={() => { if (results.length > 0) { positionDrop(); setOpen(true); } }}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              autoComplete="off"
              style={{ ...inputBase, fontFamily: T.body, fontSize: 13,
                paddingRight: 36, width: "100%", boxSizing: "border-box" }}
            />
            {loading && (
              <span style={{ position: "absolute", right: 34, top: "50%",
                transform: "translateY(-50%)", fontFamily: T.mono, fontSize: 11,
                color: T.textMuted, pointerEvents: "none" }}>…</span>
            )}
            <button type="button" onClick={() => setPickerOpen(true)}
              title="Browse port directory"
              style={{ position: "absolute", right: 8, top: "50%",
                transform: "translateY(-50%)", background: "none", border: "none",
                cursor: "pointer", color: T.textMuted, fontSize: 13, padding: 2, lineHeight: 1 }}
              onMouseEnter={e => e.currentTarget.style.color = T.text}
              onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
              🔍
            </button>
          </div>

          {/* Typeahead dropdown — position:fixed to escape Modal overflow:auto */}
          {open && results.length > 0 && (
            <div ref={dropRef} style={{
              ...dropStyle,
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.4)",
              overflow: "hidden", maxHeight: 260, overflowY: "auto",
            }}>
              {results.map((r, idx) => (
                <button key={r.unlocode} type="button"
                  onMouseDown={e => { e.preventDefault(); select(r); }}
                  onMouseEnter={() => setHighlighted(idx)}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "9px 14px",
                    background: idx === highlighted ? T.surfaceHover : "transparent",
                    border: "none", borderBottom: `1px solid ${T.border}22`,
                    cursor: "pointer", textAlign: "left" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent,
                    fontWeight: 700, flexShrink: 0, width: 52 }}>{r.unlocode}</span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  {r.countryCode && (
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, flexShrink: 0 }}>
                      {r.countryCode}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Full picker modal */}
      {pickerOpen && (
        <PortPickerModal onSelect={handlePickerSelect} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
};

export default PortCombobox;
