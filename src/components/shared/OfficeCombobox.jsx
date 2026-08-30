import { useState, useRef, useEffect, useCallback } from "react";
import { T } from "../../tokens";
import { inputBase } from "../primitives/Form";
import { IconSearch } from "../primitives/Icon";

// ─── OfficeCombobox ─────────────────────────────────────────────────────────
// Searchable office picker — replaces a flat <select> that would otherwise list every
// candidate office at once (Involved Offices' Reassign modal, direct request: "we should not
// have a dropdown"). Deliberately NOT modeled on PortCombobox's server-search + browse-modal
// shape — that exists to tame a genuinely huge 14,269-row port table; an office directory stays
// in the dozens/low-hundreds even at real scale, so filtering the already-loaded `offices` array
// client-side is enough on its own, no API round-trip or separate picker modal needed.
//
// Props:
//   offices     — candidate offices to search within (caller pre-filters by department/active —
//                 same list a <select> would have rendered as <option>s)
//   value       — controlled: an office id string, or ""
//   onChange    — called with the new office id ("" to clear)
//   placeholder — input hint text
//   allowClear  — whether a ✕ that blanks the value entirely shows on the selected chip (default
//                 true — set false for a required field, e.g. EMO/IMO in the Reassign modal,
//                 where clearing to nothing is never valid). The chip's own text is always
//                 clickable to swap to a different office regardless of allowClear — that's a
//                 replace, not a clear, and a required field still needs to be replaceable.

const OfficeCombobox = ({ offices, value, onChange, placeholder = "Search office by name, code, or country…", allowClear = true }) => {
  const selected = offices.find(o => o.id === value) || null;
  // Once something's selected the combobox collapses to a chip (see PortCombobox's own
  // selected-chip pattern) — `editing` is what lets the chip's own text reopen the search input
  // to pick something ELSE, independent of allowClear (clearing to blank vs. replacing are two
  // different actions — a required field disallows the former but still needs the latter).
  const [editing,      setEditing]      = useState(false);
  const [query,        setQuery]        = useState("");
  const [open,         setOpen]         = useState(false);
  const [highlighted,  setHighlighted]  = useState(-1);
  const [dropStyle,    setDropStyle]    = useState({});
  const inputRef = useRef(null);
  const dropRef  = useRef(null);

  const positionDrop = useCallback(() => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropStyle({ position: "fixed", top: r.bottom + 4, left: r.left, width: r.width, zIndex: 9000 });
  }, []);

  // Close dropdown on outside click — same idiom PortCombobox/CarrierCombobox already use.
  // Clicking away mid-edit with nothing picked reverts to showing the original chip rather than
  // leaving a blank search box behind — editing a value is only a real change once one is made.
  useEffect(() => {
    const h = e => {
      if (
        inputRef.current && !inputRef.current.contains(e.target) &&
        dropRef.current  && !dropRef.current.contains(e.target)
      ) { setOpen(false); setEditing(false); setQuery(""); }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Entering edit mode (clicked the chip to swap offices) focuses the now-rendered input and
  // opens the dropdown immediately — the whole point of clicking the chip is to pick something
  // else, so requiring a second click to actually see the candidate list would be redundant.
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    openDrop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Reposition if window scrolls/resizes while open (position:fixed to escape a Modal's own
  // overflow:auto, same reason every other combobox in this app already does this)
  useEffect(() => {
    if (!open) return;
    const update = () => positionDrop();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [open, positionDrop]);

  const q = query.trim().toLowerCase();
  const results = (q
    ? offices.filter(o =>
        o.code.toLowerCase().includes(q) ||
        o.name.toLowerCase().includes(q) ||
        o.countryCode.toLowerCase().includes(q))
    : offices
  ).slice(0, 30);

  const openDrop = () => { positionDrop(); setOpen(true); setHighlighted(-1); };

  const select = o => { setQuery(""); setOpen(false); setHighlighted(-1); setEditing(false); onChange(o.id); };
  const clear  = () => { setEditing(false); onChange(""); };
  const startEditing = () => { setQuery(""); setEditing(true); };

  const handleKeyDown = e => {
    // Escape always exits back to the chip (if there's one to return to) — even with the
    // dropdown already closed or empty, since it's still "cancel this edit," not just "close
    // the list."
    if (e.key === "Escape") { setOpen(false); setHighlighted(-1); setEditing(false); setQuery(""); return; }
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
    }
  };

  return (
    <div style={{ position: "relative" }}>
      {selected && !editing ? (
        // ── Selected chip — click the office name/code to swap it for a different one ──────
        <div style={{ ...inputBase, display: "flex", alignItems: "center", gap: 8,
          border: `1px solid ${T.accent}55`, padding: "7px 10px" }}>
          <button type="button" onClick={startEditing} title="Change office"
            style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0,
              background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
            <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.accent, fontWeight: 700, flexShrink: 0 }}>
              {selected.code}
            </span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {selected.name}
            </span>
          </button>
          {allowClear && (
            <button type="button" onClick={clear} title="Clear"
              style={{ background: "none", border: "none", cursor: "pointer",
                color: T.textMuted, fontSize: 15, padding: "0 2px", flexShrink: 0, lineHeight: 1 }}>
              ✕
            </button>
          )}
        </div>
      ) : (
        // ── Search input ─────────────────────────────────────────────────────
        <>
          <div style={{ position: "relative" }}>
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); openDrop(); }}
              onFocus={openDrop}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              autoComplete="off"
              style={{ ...inputBase, fontFamily: T.body, fontSize: 13, paddingRight: 32 }}
            />
            <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
              color: T.textMuted, pointerEvents: "none", display: "flex", alignItems: "center" }}>
              <IconSearch size={13} />
            </span>
          </div>

          {/* Typeahead dropdown — position:fixed to escape the Reassign modal's own overflow */}
          {open && (
            <div ref={dropRef} style={{
              ...dropStyle,
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.4)",
              overflow: "hidden", maxHeight: 260, overflowY: "auto",
            }}>
              {results.length === 0 ? (
                <div style={{ padding: "14px 16px", fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
                  No offices match "{query}".
                </div>
              ) : results.map((o, idx) => (
                <button key={o.id} type="button"
                  onMouseDown={e => { e.preventDefault(); select(o); }}
                  onMouseEnter={() => setHighlighted(idx)}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "9px 14px",
                    background: idx === highlighted ? T.surfaceHover : "transparent",
                    border: "none", borderBottom: `1px solid ${T.border}22`,
                    cursor: "pointer", textAlign: "left" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.accent, fontWeight: 700,
                    flexShrink: 0, width: 92, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {o.code}
                  </span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {o.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default OfficeCombobox;
