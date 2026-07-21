import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { inputBase, Field } from "../primitives/Form";
import { Modal } from "../primitives/Modal";
import Pagination from "../primitives/Pagination";
import Btn from "../primitives/Btn";
import { IconSearch } from "../primitives/Icon";

const PICKER_LIMIT = 20;
const EMPTY_FILTERS = { search: '', city: '', country: '', customerId: '' };

// ── Customer Picker Modal ─────────────────────────────────────────────────────
// Full paginated customer browser with the same filters as the Customers MDM page.

export const CustomerPickerModal = ({ onSelect, onClose }) => {
  const [rows,    setRows]    = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);

  const setF = k => v => setFilters(p => ({ ...p, [k]: v }));
  const hasFilters = Object.values(filters).some(v => v.trim() !== "");

  const doLoad = useCallback(async (f, off) => {
    setLoading(true);
    try {
      const res = await api.customers.list({
        search:     f.search.trim(),
        city:       f.city.trim(),
        country:    f.country.trim(),
        customerId: f.customerId.trim(),
        limit:      PICKER_LIMIT,
        offset:     off,
      });
      setRows(res.results || []);
      setTotal(res.total || 0);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { doLoad(EMPTY_FILTERS, 0); }, []);

  const handleSearch = () => { setOffset(0); doLoad(filters, 0); };
  const handleClear  = () => { setFilters(EMPTY_FILTERS); setOffset(0); doLoad(EMPTY_FILTERS, 0); };
  const handleKey    = e => { if (e.key === "Enter") handleSearch(); };
  const goPage = off => { setOffset(off); doLoad(filters, off); };

  return (
    <Modal title="Select Customer" onClose={onClose} width={660}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Filter bar — mirrors Customers MDM page */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {[
            { key: "search",     placeholder: "Company, email, phone…", width: 190 },
            { key: "city",       placeholder: "City",                   width: 120 },
            { key: "country",    placeholder: "ISO2",                   width: 70, upper: true, max: 2 },
            { key: "customerId", placeholder: "Customer code",          width: 120 },
          ].map(({ key, placeholder, width, upper, max }) => (
            <input
              key={key}
              value={filters[key]}
              onChange={e => setF(key)(upper ? e.target.value.toUpperCase().slice(0, max) : e.target.value)}
              onKeyDown={handleKey}
              placeholder={placeholder}
              maxLength={max}
              autoFocus={key === "search"}
              style={{ ...inputBase, width }}
            />
          ))}
          <Btn onClick={handleSearch}>Search</Btn>
          {hasFilters && <Btn variant="secondary" onClick={handleClear}>Clear</Btn>}
        </div>

        {/* Result count */}
        {!loading && (
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            {hasFilters ? `${total} result${total !== 1 ? "s" : ""}` : `${total} customer${total !== 1 ? "s" : ""} in registry`}
          </div>
        )}

        <div style={{ background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          {/* Column headers */}
          <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 110px",
            padding: "8px 14px", borderBottom: `1px solid ${T.border}` }}>
            {["Code", "Company", "City / Country"].map((h, i) => (
              <span key={i} style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
            ))}
          </div>

          {loading ? (
            <div style={{ padding: 28, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 28, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
              {hasFilters ? "No customers match your filters." : "No customers in registry."}
            </div>
          ) : rows.map(c => (
            <button key={c.id} type="button" onClick={() => onSelect(c)}
              style={{ display: "grid", gridTemplateColumns: "130px 1fr 110px",
                width: "100%", padding: "10px 14px", background: "none", border: "none",
                borderBottom: `1px solid ${T.border}22`, cursor: "pointer", textAlign: "left",
                alignItems: "center" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, fontWeight: 700 }}>
                {c.id}
              </span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>
                {c.companyName}
              </span>
              <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                {[c.city, c.countryIso2].filter(Boolean).join(" · ") || "—"}
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

// ── CustomerCombobox ──────────────────────────────────────────────────────────
// value:    { id: string, name: string }
// onChange: ({ id, name }) => void
//
// Accepts free-text (name or CUS- code). Typeahead suggests matching customers.
// 🔍 icon opens the full CustomerPickerModal.
// When a customer is resolved from the list/picker, the ID is shown as a chip
// and the border turns green. The user can clear it to re-enter.

const CustomerCombobox = ({ label, value = { id: "", name: "" }, onChange, required }) => {
  const [query,      setQuery]      = useState(value.name || "");
  const [results,    setResults]    = useState([]);
  const [dropOpen,   setDropOpen]   = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropPos,    setDropPos]    = useState({ top: 0, left: 0, width: 200 });

  const wrapRef  = useRef(null);
  const inputRef = useRef(null);
  const timer    = useRef(null);

  // Click-outside → close dropdown
  useEffect(() => {
    const h = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setDropOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Sync display when value is cleared externally
  useEffect(() => {
    setQuery(value.name || "");
  }, [value.name]);

  const computeDropPos = () => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropPos({ top: r.bottom + 4, left: r.left, width: r.width });
  };

  const fetchSuggestions = q => {
    clearTimeout(timer.current);
    if (!q.trim()) { setResults([]); setDropOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const res = await api.customers.list({ search: q.trim(), limit: 8 });
        const items = res.results || [];
        setResults(items);
        if (items.length > 0) { computeDropPos(); setDropOpen(true); }
      } catch {}
    }, 200);
  };

  const handleInput = v => {
    setQuery(v);
    onChange({ id: "", name: v });
    fetchSuggestions(v);
  };

  const select = c => {
    setQuery(c.companyName);
    onChange({ id: c.id, name: c.companyName });
    setResults([]);
    setDropOpen(false);
  };

  const handlePickerSelect = c => {
    select(c);
    setPickerOpen(false);
  };

  const handleClear = () => {
    setQuery("");
    onChange({ id: "", name: "" });
    setResults([]);
    setDropOpen(false);
    inputRef.current?.focus();
  };

  const resolved = !!(value.id);

  return (
    <Field label={label} required={required}>
      {/* wrapRef wraps both the input row and the fixed dropdown so
          mousedown-outside detection works correctly */}
      <div ref={wrapRef}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <input
            ref={inputRef}
            value={query}
            onChange={e => handleInput(e.target.value)}
            onFocus={() => { if (results.length > 0) { computeDropPos(); setDropOpen(true); } }}
            placeholder="Company name or CUS- code…"
            style={{
              ...inputBase,
              width: "100%",
              paddingRight: 30,
              boxSizing: "border-box",
              borderColor: resolved ? T.success + "88" : undefined,
            }}
          />
          {/* lookup icon */}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            title="Browse customer list"
            style={{
              position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)",
              background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 13, padding: 2, lineHeight: 1,
              display: "inline-flex", alignItems: "center",
            }}
            onMouseEnter={e => e.currentTarget.style.color = T.text}
            onMouseLeave={e => e.currentTarget.style.color = T.textMuted}
          >
            <IconSearch size={13} />
          </button>
        </div>

        {/* Resolved chip */}
        {resolved && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.success, fontWeight: 700 }}>
              {value.id}
            </span>
            <button type="button" onClick={handleClear}
              style={{ background: "none", border: "none", cursor: "pointer",
                color: T.textMuted, fontFamily: T.body, fontSize: 11, padding: 0 }}>
              ✕ clear
            </button>
          </div>
        )}

        {/* Typeahead dropdown — position:fixed to escape modal overflow:auto */}
        {dropOpen && results.length > 0 && (
          <div style={{
            position: "fixed",
            top: dropPos.top, left: dropPos.left, width: dropPos.width,
            background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: 8, boxShadow: "0 8px 28px rgba(0,0,0,.45)",
            zIndex: 1100, overflow: "hidden",
          }}>
            {results.map(c => (
              <button key={c.id} type="button"
                onMouseDown={e => { e.preventDefault(); select(c); }}
                style={{
                  display: "flex", flexDirection: "column", gap: 2,
                  width: "100%", padding: "8px 12px",
                  background: "none", border: "none",
                  borderBottom: `1px solid ${T.border}22`,
                  cursor: "pointer", textAlign: "left",
                }}
                onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>
                  {c.companyName}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                  {c.id}{c.city || c.countryIso2 ? ` · ${[c.city, c.countryIso2].filter(Boolean).join(", ")}` : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Picker modal */}
      {pickerOpen && (
        <CustomerPickerModal
          onSelect={handlePickerSelect}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </Field>
  );
};

export default CustomerCombobox;
