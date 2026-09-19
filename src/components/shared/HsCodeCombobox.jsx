import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { T } from "../../tokens";
import { inputBase } from "../primitives/Form";
import { Modal } from "../primitives/Modal";
import Pagination from "../primitives/Pagination";
import Btn from "../primitives/Btn";
import { api } from "../../api";
import { IconSearch } from "../primitives/Icon";

// ─── HS Codes combobox ──────────────────────────────────────────────────────────
// Same shape as CommodityCombobox.jsx (typeahead + full-browse picker modal), backing a real
// lookup against the MDM HS Codes registry (routes/hs-codes.js) instead of a free-text box —
// used first on the Cargo page's per-package HS Code override (ContainerPackagesPanel.jsx).
// Deliberately T-themed like its sibling fields in that same form (Unit Value, Currency,
// Schedule B Number all still use the classic <Inp>), not the page's own HZ Trade Horizon
// tokens — matches ImportContainersModal.jsx's own precedent of an HZ-styled panel still using
// this app's normal T-styled form primitives underneath.

const HS_CHAPTERS = [
  ["27", "Mineral fuels, oils"], ["30", "Pharmaceutical products"], ["39", "Plastics"],
  ["40", "Rubber"], ["42", "Leather, travel goods"], ["44", "Wood"], ["48", "Paper, paperboard"],
  ["49", "Printed books"], ["61", "Apparel, knitted"], ["62", "Apparel, not knitted"],
  ["64", "Footwear"], ["72", "Iron and steel"], ["73", "Articles of iron/steel"],
  ["76", "Aluminium"], ["83", "Misc. base metal articles"], ["84", "Machinery"],
  ["85", "Electrical machinery"], ["87", "Vehicles"], ["90", "Optical/medical instruments"],
  ["94", "Furniture, lighting"], ["95", "Toys, sports goods"],
];
const CHAPTER_NAME = Object.fromEntries(HS_CHAPTERS);

const ChapterChip = ({ code }) => (
  <span style={{
    display: "inline-flex", alignSelf: "center", width: "fit-content",
    fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.accent,
    background: `${T.accent}18`, border: `1px solid ${T.accent}44`,
    borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap",
  }}>
    {code}
  </span>
);

// ─── HS Code Picker Modal ───────────────────────────────────────────────────────

const PICKER_LIMIT = 20;

export const HsCodePickerModal = ({ onSelect, onClose }) => {
  const [rows,    setRows]    = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [search,  setSearch]  = useState("");
  const [chapter, setChapter] = useState("");
  const [loading, setLoading] = useState(true);
  const searchRef = useRef(null);

  const doLoad = useCallback(async (s, c, off) => {
    setLoading(true);
    try {
      const res = await api.hsCodes.list({ search: s.trim(), chapter: c, limit: PICKER_LIMIT, offset: off });
      setRows(res.results || []);
      setTotal(res.total  || 0);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { doLoad("", "", 0); searchRef.current?.focus(); }, []);

  const handleSearch = () => { setOffset(0); doLoad(search, chapter, 0); };
  const handleKey    = e => { if (e.key === "Enter") handleSearch(); };
  const handleChapter = c => {
    const next = chapter === c ? "" : c;
    setChapter(next); setOffset(0); doLoad(search, next, 0);
  };
  const handleClear  = () => { setSearch(""); setChapter(""); setOffset(0); doLoad("", "", 0); };
  const goPage = off => { setOffset(off); doLoad(search, chapter, off); };

  const hasFilters = search.trim() || chapter;

  return (
    <Modal title="Select HS Code" onClose={onClose} width={660}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

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

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {HS_CHAPTERS.map(([c, name]) => {
            const active = chapter === c;
            return (
              <button key={c} type="button" onClick={() => handleChapter(c)}
                title={name}
                style={{
                  fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
                  padding: "3px 10px", borderRadius: 20,
                  color:      active ? "#fff" : T.accent,
                  background: active ? T.accent : `${T.accent}18`,
                  border: `1px solid ${T.accent}${active ? "" : "44"}`,
                  transition: "all .1s",
                }}>
                {c}
              </button>
            );
          })}
        </div>

        {!loading && (
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            {hasFilters
              ? `${total} result${total !== 1 ? "s" : ""}`
              : `${total} HS code${total !== 1 ? "s" : ""} in registry`}
          </div>
        )}

        <div style={{ background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 0, padding: "8px 14px", borderBottom: `1px solid ${T.border}` }}>
            <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".08em", width: 72, flexShrink: 0 }}>Code</span>
            <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".08em", width: 60, flexShrink: 0 }}>Ch.</span>
            <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".08em" }}>Description</span>
          </div>

          {loading ? (
            <div style={{ padding: 32, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
              {hasFilters ? "No HS codes match your filters." : "No HS codes in registry."}
            </div>
          ) : rows.map(h => (
            <button key={h.code} type="button" onClick={() => onSelect(h)}
              style={{ display: "flex", alignItems: "flex-start",
                width: "100%", padding: "10px 14px", background: "none", border: "none",
                borderBottom: `1px solid ${T.border}22`, cursor: "pointer", textAlign: "left" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700,
                width: 72, flexShrink: 0, paddingTop: 1 }}>
                {h.code}
              </span>
              <div style={{ width: 60, flexShrink: 0, paddingTop: 1 }}>
                <ChapterChip code={h.hsChapter} />
              </div>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.4 }}>
                {h.description}
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

// ─── HsCodeCombobox ─────────────────────────────────────────────────────────────

const HsCodeCombobox = ({ value, onChange, placeholder = "Search by code or description…" }) => {
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
  const box     = useRef(null);
  const dropRef  = useRef(null);

  useEffect(() => {
    if (!value) { setSelected(null); return; }
    if (selected?.code === value) return;
    api.hsCodes.get(value)
      .then(setSelected)
      // Unknown/legacy free-text value (e.g. a pre-existing "8471.30"-style entry from before
      // this registry existed) — render it as-is rather than erroring, same clean-degrade
      // CommodityCombobox uses for the same situation.
      .catch(() => setSelected({ code: value, description: value, hsChapter: "" }));
  }, [value]);

  useEffect(() => {
    // Checks both refs — the dropdown is rendered through a portal (see below), so it's no
    // longer a DOM descendant of `box` and a click inside it would otherwise be misread as
    // "outside" and close the list before the option's own click can register.
    const h = e => {
      if (box.current?.contains(e.target)) return;
      if (dropRef.current?.contains(e.target)) return;
      setOpen(false);
    };
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
        const data = await api.hsCodes.search(q.trim());
        setResults(data);
        if (data.length > 0) { computeDropPos(); setOpen(true); }
        else setOpen(false);
      } catch {}
      setLoading(false);
    }, 200);
  };

  const select = useCallback(h => {
    setSelected(h); setQuery(""); setResults([]); setOpen(false); setHighlighted(-1); onChange(h.code);
  }, [onChange]);

  const handlePickerSelect = h => { select(h); setPickerOpen(false); };

  const handleKeyDown = e => {
    // Escape closes the dropdown and is marked handled (preventDefault) so an enclosing Modal's own
    // Escape-to-close leaves the modal open; with the dropdown already closed it bubbles up to the Modal.
    if (e.key === "Escape" && open) { e.preventDefault(); setOpen(false); setHighlighted(-1); return; }
    if (!open || results.length === 0) return;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setHighlighted(h => Math.min(h + 1, results.length - 1)); break;
      case "ArrowUp":   e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); break;
      case "Enter":     e.preventDefault(); { const idx = highlighted >= 0 ? highlighted : 0; if (results[idx]) select(results[idx]); } break;
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
          {selected.hsChapter && <ChapterChip code={selected.hsChapter} />}
          <button type="button" onClick={() => setPickerOpen(true)}
            title="Browse HS code list"
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 13, padding: "0 2px", flexShrink: 0,
              display: "inline-flex", alignItems: "center" }}
            onMouseEnter={e => e.currentTarget.style.color = T.text}
            onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
            <IconSearch size={13} />
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
            <button type="button" onClick={() => setPickerOpen(true)}
              title="Browse all HS codes"
              style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer",
                color: T.textMuted, fontSize: 13, padding: 2, lineHeight: 1,
                display: "inline-flex", alignItems: "center" }}
              onMouseEnter={e => e.currentTarget.style.color = T.text}
              onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
              <IconSearch size={13} />
            </button>
          </div>

          {/* Portaled to document.body — this field is used inside Trade Horizon glass cards
              (ContainerPackagesPanel.jsx, ShipmentDetailPage.jsx's ContainerForm), whose
              backdropFilter redefines the containing block for a plain position:fixed
              descendant (same bug class ColumnFilter.jsx's own portal comment documents,
              caught live here via the Cargo page's HS Code field rendering its dropdown
              hundreds of pixels away from the input, 2026-09-18). */}
          {open && results.length > 0 && createPortal(
            <div ref={dropRef} style={{
              position: "fixed",
              top: dropPos.top, left: dropPos.left, width: dropPos.width,
              zIndex: 1100, background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.4)",
              overflow: "hidden", maxHeight: 280, overflowY: "auto",
            }}>
              {results.map((h, idx) => (
                <button key={h.code} type="button"
                  onMouseDown={e => { e.preventDefault(); select(h); }}
                  onMouseEnter={() => setHighlighted(idx)}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "9px 14px", background: idx === highlighted ? T.surfaceHover : "transparent",
                    border: "none", cursor: "pointer", textAlign: "left",
                    borderBottom: `1px solid ${T.border}22` }}>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent,
                    fontWeight: 700, flexShrink: 0, width: 60 }}>{h.code}</span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text,
                    flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {h.description}
                  </span>
                  <ChapterChip code={h.hsChapter} />
                </button>
              ))}
            </div>,
            document.body
          )}
        </>
      )}

      {pickerOpen && (
        <HsCodePickerModal
          onSelect={handlePickerSelect}
          onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
};

export { HsCodeCombobox, ChapterChip, CHAPTER_NAME };
