import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../../tokens";
import { inputBase } from "../primitives/Form";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { api } from "../../api";
import { IconSearch } from "../primitives/Icon";

// ─── Carrier Picker Modal ─────────────────────────────────────────────────────

const CarrierPickerModal = ({ carriers, onSelect, onClose }) => {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = query.trim()
    ? carriers.filter(c =>
        c.code.toUpperCase().includes(query.toUpperCase()) ||
        (c.name || "").toLowerCase().includes(query.toLowerCase()))
    : carriers;

  return (
    <Modal title="Select Carrier" onClose={onClose} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by code or name…"
          style={{ ...inputBase }}
        />

        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          {query.trim()
            ? `${filtered.length} result${filtered.length !== 1 ? "s" : ""}`
            : `${carriers.length} carrier${carriers.length !== 1 ? "s" : ""} in registry`}
        </div>

        <div style={{ background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`,
          overflow: "hidden", maxHeight: 380, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "72px 1fr",
            padding: "7px 14px", borderBottom: `1px solid ${T.border}` }}>
            {["Code", "Name"].map(h => (
              <span key={h} style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
            ))}
          </div>
          {filtered.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: T.textMuted,
              fontFamily: T.body, fontSize: 13 }}>No carriers match your search.</div>
          ) : filtered.map(c => (
            <button key={c.code} type="button" onClick={() => onSelect(c)}
              style={{ display: "grid", gridTemplateColumns: "72px 1fr",
                width: "100%", padding: "10px 14px",
                background: "none", border: "none",
                borderBottom: `1px solid ${T.border}22`,
                cursor: "pointer", textAlign: "left", alignItems: "center" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>
                {c.code}
              </span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
};

// ─── CarrierCombobox ──────────────────────────────────────────────────────────
// Self-contained carrier selector. value = carrier code string (e.g. "MAEU").
// Fetches its own carrier list; no carriers prop required from the parent.

const CarrierCombobox = ({ value = "", onChange, required = false }) => {
  const [carriers,    setCarriers]    = useState([]);
  const [loaded,      setLoaded]      = useState(false);
  const [query,       setQuery]       = useState("");
  const [open,        setOpen]        = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [pickerOpen,  setPickerOpen]  = useState(false);
  const [dropStyle,   setDropStyle]   = useState({});
  const inputRef = useRef(null);
  const dropRef  = useRef(null);

  useEffect(() => {
    api.carriers.list()
      .then(list => { setCarriers(list); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  const selected = carriers.find(c => c.code === value) || null;

  const positionDrop = useCallback(() => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropStyle({ position: "fixed", top: r.bottom + 4, left: r.left, width: r.width, zIndex: 9000 });
  }, []);

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

  useEffect(() => {
    if (!open) return;
    const update = () => positionDrop();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [open, positionDrop]);

  const filtered = query.trim()
    ? carriers.filter(c =>
        c.code.toUpperCase().includes(query.toUpperCase()) ||
        (c.name || "").toLowerCase().includes(query.toLowerCase()))
    : carriers;

  const openDrop = () => {
    if (filtered.length > 0) { positionDrop(); setOpen(true); }
  };

  const handleInput = q => {
    setQuery(q); setHighlighted(-1);
    if (!q.trim()) { setOpen(false); return; }
    positionDrop(); setOpen(true);
  };

  const select = c => {
    setQuery(""); setOpen(false); setHighlighted(-1);
    onChange(c.code);
  };

  const clear = () => onChange("");

  const handleKeyDown = e => {
    if (!open || filtered.length === 0) return;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setHighlighted(h => Math.min(h + 1, filtered.length - 1)); break;
      case "ArrowUp":   e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); break;
      case "Enter":     e.preventDefault(); { const i = highlighted >= 0 ? highlighted : 0; if (filtered[i]) select(filtered[i]); } break;
      case "Escape":    setOpen(false); setHighlighted(-1); break;
    }
  };

  if (!loaded && !value) {
    return (
      <div style={{ ...inputBase, color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
        Loading…
      </div>
    );
  }

  if (loaded && carriers.length === 0) {
    return (
      <div style={{ ...inputBase, color: T.warning, fontFamily: T.body, fontSize: 13,
        background: T.warningBg, border: `1px solid ${T.warning}55` }}>
        ⚠ No carriers in registry
      </div>
    );
  }

  return (
    // minWidth:0 overrides a flex child's implicit min-width:auto — without it, this component
    // (width:100% internally via inputBase) refuses to shrink below its own content's intrinsic
    // width whenever a caller places it inside a `display:flex` cell narrower than that content
    // (e.g. a fixed-width table column with a long carrier name selected) — the visible symptom
    // is the selected chip bleeding into the next column instead of truncating/ellipsizing.
    <div style={{ position: "relative", minWidth: 0 }}>
      {selected ? (
        // ── Selected chip ────────────────────────────────────────────────────
        <div style={{ ...inputBase, display: "flex", alignItems: "center", gap: 8,
          border: `1px solid ${T.accent}55`, padding: "7px 10px" }}>
          <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent,
            fontWeight: 700, flexShrink: 0 }}>
            {selected.code}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selected.name}
          </span>
          <button type="button" onClick={() => setPickerOpen(true)}
            title="Browse carriers"
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 13, padding: "0 2px", flexShrink: 0, lineHeight: 1,
              display: "inline-flex", alignItems: "center" }}
            onMouseEnter={e => e.currentTarget.style.color = T.text}
            onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
            <IconSearch size={13} />
          </button>
          <button type="button" onClick={clear}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 15, padding: "0 2px", flexShrink: 0, lineHeight: 1 }}>
            ✕
          </button>
        </div>
      ) : (
        // ── Search input ─────────────────────────────────────────────────────
        <>
          <div style={{ position: "relative" }}>
            <input
              ref={inputRef}
              value={query}
              onChange={e => handleInput(e.target.value)}
              onFocus={openDrop}
              onKeyDown={handleKeyDown}
              placeholder="Search carrier code or name…"
              autoComplete="off"
              style={{ ...inputBase, fontFamily: T.body, fontSize: 13,
                paddingRight: 36, width: "100%", boxSizing: "border-box" }}
            />
            <button type="button" onClick={() => setPickerOpen(true)}
              title="Browse all carriers"
              style={{ position: "absolute", right: 8, top: "50%",
                transform: "translateY(-50%)", background: "none", border: "none",
                cursor: "pointer", color: T.textMuted, fontSize: 13, padding: 2, lineHeight: 1,
                display: "inline-flex", alignItems: "center" }}
              onMouseEnter={e => e.currentTarget.style.color = T.text}
              onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
              <IconSearch size={13} />
            </button>
          </div>

          {open && filtered.length > 0 && (
            <div ref={dropRef} style={{
              ...dropStyle,
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.4)",
              overflow: "hidden", maxHeight: 260, overflowY: "auto",
            }}>
              {filtered.map((c, idx) => (
                <button key={c.code} type="button"
                  onMouseDown={e => { e.preventDefault(); select(c); }}
                  onMouseEnter={() => setHighlighted(idx)}
                  style={{ display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "9px 14px",
                    background: idx === highlighted ? T.surfaceHover : "transparent",
                    border: "none", borderBottom: `1px solid ${T.border}22`,
                    cursor: "pointer", textAlign: "left" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent,
                    fontWeight: 700, flexShrink: 0, width: 44 }}>{c.code}</span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {pickerOpen && (
        <CarrierPickerModal
          carriers={carriers}
          onSelect={c => { onChange(c.code); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
};

export default CarrierCombobox;
