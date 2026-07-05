import { useState, useRef, useCallback, useEffect } from "react";
import { T, CONTAINER_OPTIONS } from "../../tokens";
import { Field, inputBase } from "../primitives/Form";
import { Modal } from "../primitives/Modal";

// ─── ContainerTypePickerModal ─────────────────────────────────────────────────
// Visual equipment picker grouped by 20ft / 40ft.
// Props:
//   current  — currently selected code string (e.g. "40DC") — highlights the row
//   onSelect — called with the full CONTAINER_OPTIONS entry on click; modal stays open
//   onClose  — called when modal should close

export const ContainerTypePickerModal = ({ current, onSelect, onClose }) => {
  const [hovered, setHovered] = useState(null);
  const groups = [
    { size: "20", teu: 1, items: CONTAINER_OPTIONS.filter(o => o.size === "20") },
    { size: "40", teu: 2, items: CONTAINER_OPTIONS.filter(o => o.size === "40") },
  ];

  return (
    <Modal title="Select Equipment Type" onClose={onClose} width={560}>
      {/* TEU info banner */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        {[{ size: "20", teu: 1 }, { size: "40", teu: 2 }].map(({ size, teu }) => (
          <div key={size} style={{ flex: 1, background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: T.mono, fontSize: 22, fontWeight: 800, color: T.accent }}>{size}ft</span>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{teu} TEU</div>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                {size === "20" ? "Standard 20ft unit" : "Standard 40ft unit"}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Options grouped by size */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {groups.map(({ size, teu, items }) => (
          <div key={size}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
                {size}ft · {teu} TEU
              </span>
              <div style={{ flex: 1, height: 1, background: T.border, opacity: 0.4 }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {items.map(opt => {
                const isSelected = current === opt.code;
                const isHovered  = hovered === opt.code;
                return (
                  <div key={opt.code}
                    onClick={() => { onSelect(opt); onClose(); }}
                    onMouseEnter={() => setHovered(opt.code)}
                    onMouseLeave={() => setHovered(null)}
                    style={{ display: "grid", gridTemplateColumns: "64px 160px 1fr",
                      alignItems: "center", gap: 12, padding: "10px 14px",
                      borderRadius: 8, cursor: "pointer",
                      background: isSelected ? T.accent + "18" : isHovered ? T.surfaceHover : T.surface,
                      border: `1px solid ${isSelected ? T.accent + "66" : isHovered ? T.border : T.border + "55"}`,
                      transition: "background .1s, border-color .1s" }}>
                    <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 800,
                      color: isSelected ? T.accent : T.text }}>
                      {opt.code}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text }}>
                      {opt.label}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, lineHeight: 1.4 }}>
                      {opt.desc}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
};

// ─── ContainerTypeField ───────────────────────────────────────────────────────
// Chip-style field matching CarrierCombobox.
// Unselected: real <input> with typeahead filtering (type "40RF", "dry", etc.)
//             + 🔍 button to open full visual picker.
// Selected:   chip row (code · label · TEU badge · 🔍 · ✕).

export const ContainerTypeField = ({ size, type, onChange, required = false, label = "Equipment Type" }) => {
  const [query,       setQuery]       = useState("");
  const [dropOpen,    setDropOpen]    = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [pickerOpen,  setPickerOpen]  = useState(false);
  const [dropStyle,   setDropStyle]   = useState({});
  const inputRef = useRef(null);
  const dropRef  = useRef(null);

  const selected = CONTAINER_OPTIONS.find(o => o.size === size && o.type === type) || null;

  const filtered = query.trim()
    ? CONTAINER_OPTIONS.filter(o =>
        o.code.toUpperCase().includes(query.toUpperCase()) ||
        o.label.toLowerCase().includes(query.toLowerCase()) ||
        o.size.includes(query) ||
        o.type.toUpperCase().includes(query.toUpperCase()))
    : CONTAINER_OPTIONS;

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
      ) setDropOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  useEffect(() => {
    if (!dropOpen) return;
    const update = () => positionDrop();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [dropOpen, positionDrop]);

  const openDrop = () => { positionDrop(); setDropOpen(true); };

  const handleInput = q => {
    setQuery(q); setHighlighted(-1);
    positionDrop(); setDropOpen(true);
  };

  const select = opt => {
    setQuery(""); setDropOpen(false); setHighlighted(-1);
    onChange(opt);
  };

  const handleKeyDown = e => {
    if (!dropOpen || filtered.length === 0) return;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setHighlighted(h => Math.min(h + 1, filtered.length - 1)); break;
      case "ArrowUp":   e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); break;
      case "Enter":     e.preventDefault(); { const i = highlighted >= 0 ? highlighted : 0; if (filtered[i]) select(filtered[i]); } break;
      case "Escape":    setDropOpen(false); setHighlighted(-1); break;
    }
  };

  return (
    <Field label={label} required={required}>
      {selected ? (
        // ── Selected chip ─────────────────────────────────────────────────────
        <div style={{ ...inputBase, display: "flex", alignItems: "center", gap: 8,
          border: `1px solid ${T.accent}55`, padding: "7px 10px" }}>
          <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent,
            fontWeight: 700, flexShrink: 0 }}>
            {selected.code}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selected.label}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
            background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4,
            padding: "1px 7px", flexShrink: 0 }}>
            {selected.teu} TEU
          </span>
          <button type="button" onClick={() => setPickerOpen(true)}
            title="Browse equipment types"
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 13, padding: "0 2px", flexShrink: 0, lineHeight: 1 }}
            onMouseEnter={e => e.currentTarget.style.color = T.text}
            onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
            🔍
          </button>
          <button type="button" onClick={() => onChange(null)}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 15, padding: "0 2px", flexShrink: 0, lineHeight: 1 }}>
            ✕
          </button>
        </div>
      ) : (
        // ── Typeahead input ───────────────────────────────────────────────────
        <>
          <div style={{ position: "relative" }}>
            <input
              ref={inputRef}
              value={query}
              onChange={e => handleInput(e.target.value)}
              onFocus={openDrop}
              onKeyDown={handleKeyDown}
              placeholder="Type code or name (40DC, reefer…)"
              autoComplete="off"
              style={{ ...inputBase, fontFamily: T.body, fontSize: 13,
                paddingRight: 36, width: "100%", boxSizing: "border-box" }}
            />
            <button type="button" onClick={() => setPickerOpen(true)}
              title="Browse all equipment types"
              style={{ position: "absolute", right: 8, top: "50%",
                transform: "translateY(-50%)", background: "none", border: "none",
                cursor: "pointer", color: T.textMuted, fontSize: 13, padding: 2, lineHeight: 1 }}
              onMouseEnter={e => e.currentTarget.style.color = T.text}
              onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
              🔍
            </button>
          </div>

          {dropOpen && filtered.length > 0 && (
            <div ref={dropRef} style={{
              ...dropStyle,
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.4)",
              overflow: "hidden",
            }}>
              {filtered.map((opt, idx) => (
                <button key={opt.code} type="button"
                  onMouseDown={e => { e.preventDefault(); select(opt); }}
                  onMouseEnter={() => setHighlighted(idx)}
                  style={{ display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "9px 14px",
                    background: idx === highlighted ? T.surfaceHover : "transparent",
                    border: "none", borderBottom: `1px solid ${T.border}22`,
                    cursor: "pointer", textAlign: "left" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent,
                    fontWeight: 700, flexShrink: 0, width: 44 }}>{opt.code}</span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1 }}>{opt.label}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
                    background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4,
                    padding: "1px 6px", flexShrink: 0 }}>{opt.teu} TEU</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {pickerOpen && (
        <ContainerTypePickerModal
          current={selected?.code}
          onSelect={opt => { onChange(opt); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </Field>
  );
};

export default ContainerTypePickerModal;
