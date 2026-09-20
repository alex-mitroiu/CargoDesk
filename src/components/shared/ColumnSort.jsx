import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { T } from "../../tokens";

// ─── Column sort (header-click popover, sort only) ─────────────────────────────────────────────
// The sibling of ColumnFilter for a column whose values are not worth a checklist — a number a person
// wants ordered, not picked from. Click the header, choose how to order the table; nothing is hidden.
// Rendered through a portal for the same reason ColumnFilter is (an ancestor with a transform or
// filter would otherwise become the containing block of its `position: fixed`).
//
//   <ColumnSort label="Confirmed" value={sort} onChange={setSort}
//     options={[{ value: "awarded_desc", group: "Awarded TEU", label: "High to low", arrow: "↓", marker: "TEU" }, …]} />
//
// `value` is the table's current sort string ("" = none); the control is highlighted only while that
// value is one of ITS options, so two sort-capable columns never both light up. `marker` is a short tag
// shown beside the heading while a sort is on — the heading may say "Confirmed" while the table is
// really ordered by awarded TEU, and the marker says which. `group` puts a small caption above the
// first option of each run. The popover always offers a Clear sort.
//
// Escape closes it (and swallows the key, per the Modal contract, so a sort popover opened inside a
// modal closes itself rather than the modal).
const ColumnSort = ({ label, options, value, onChange, tokens }) => {
  const k = tokens || { bg: T.surface, border: T.border, borderSoft: T.borderMid, ink: T.text, inkMuted: T.textMuted, accent: T.accent, fontMono: T.mono, fontBody: T.body };
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const current = options.find(o => o.value === value);
  const active = !!current;

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 6, left: r.left });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = e => {
      if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = e => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = v => { onChange(v); setOpen(false); };

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button ref={btnRef} type="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(o => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none",
          padding: 0, margin: 0, cursor: "pointer", color: active ? k.accent : "inherit", font: "inherit",
          textTransform: "inherit", letterSpacing: "inherit" }}>
        {label}
        {/* Two triangles; the one for the current direction is filled. */}
        <svg width="9" height="12" viewBox="0 0 9 12" style={{ flexShrink: 0 }} aria-hidden="true">
          <path d="M4.5 0.6 L8 4.6 H1 Z" fill={active && current.arrow === "↑" ? "currentColor" : "none"}
            stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" />
          <path d="M4.5 11.4 L8 7.4 H1 Z" fill={active && current.arrow === "↓" ? "currentColor" : "none"}
            stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" />
        </svg>
        {active && current.marker && (
          <span data-testid="column-sort-marker" style={{ fontFamily: k.fontMono, fontSize: 9, fontWeight: 600, letterSpacing: 0 }}>
            {current.marker}
          </span>
        )}
      </button>
      {open && pos && createPortal(
        <div ref={popRef} role="menu" style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9500,
          background: k.bg, border: `1px solid ${k.border}`, borderRadius: 12, padding: 10,
          minWidth: 200, boxShadow: "0 12px 32px rgba(0,0,0,0.55)" }}>
          <div style={{ fontFamily: k.fontBody, fontSize: 10.5, fontWeight: 600, color: k.inkMuted,
            textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>Sort by</div>
          {options.map((o, i) => (
            <div key={o.value}>
              {o.group && o.group !== options[i - 1]?.group && (
                <div style={{ fontFamily: k.fontBody, fontSize: 10.5, fontWeight: 600, color: k.inkMuted,
                  margin: i === 0 ? "0 0 2px" : "8px 0 2px" }}>{o.group}</div>
              )}
              <button type="button" role="menuitemradio" aria-checked={o.value === value}
                aria-label={o.group ? `${o.group}: ${o.label}` : o.label}
                onClick={() => choose(o.value)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, width: "100%",
                  background: o.value === value ? (T.accentBg || "transparent") : "none",
                  border: `1px solid ${o.value === value ? k.accent : "transparent"}`, borderRadius: 6,
                  padding: "6px 8px", cursor: "pointer", textAlign: "left",
                  color: o.value === value ? k.accent : k.ink, fontFamily: k.fontBody, fontSize: 12 }}>
                <span>{o.label}</span>
                {o.arrow && <span style={{ fontFamily: k.fontMono, fontSize: 13, fontWeight: 700 }}>{o.arrow}</span>}
              </button>
            </div>
          ))}
          <div style={{ borderTop: `1px solid ${k.borderSoft}`, marginTop: 8, paddingTop: 6 }}>
            <button type="button" onClick={() => choose("")}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
                fontFamily: k.fontBody, fontSize: 11, fontWeight: 600, color: k.accent }}>
              Clear sort
            </button>
          </div>
        </div>,
        document.body
      )}
    </span>
  );
};

export default ColumnSort;
