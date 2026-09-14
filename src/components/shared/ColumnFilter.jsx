import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { T } from "../../tokens";

// ─── Column filter (Excel-style header-click checklist) ────────────────────────────────────────
// Click a header, get a checklist of every value actually present in that column (built from
// `available`, computed by the caller from the UN-filtered row/data set so an unchecked value
// stays selectable rather than vanishing from its own filter list), toggle to narrow. `selected`
// — null means "no filter, show every value"; a non-null array is the chosen subset (an empty
// array is a real, deliberate "show nothing", not the same as "no filter" — callers should treat
// it that way rather than collapsing it back to null).
//
// Originally built for the Dashboard's Carrier column, since generalized to every column on both
// the Dashboard's Overview tab and the main Shipments list. `describe` is the one per-column hook,
// an optional secondary label shown next to the raw value (Carrier/POL/POD use it for a name;
// most columns leave it blank since the cell's own value is already the whole story).
//
// `tokens` lets a caller override the visual palette without forking this component — the
// Dashboard's Overview tab uses its own page-scoped Trade Horizon palette (never the shared `T`
// system, by deliberate design), while every other page uses the app's normal theme-aware `T`
// tokens. Defaulting to live `T.*` reads (not a hoisted constant) matters: `T` is mutated in place
// when the user toggles light/dark theme, so a value captured once at module load would freeze at
// whatever theme was active on first import — see FilterSelect's own identical concern elsewhere
// in this codebase. A default *parameter* re-evaluates on every call with no argument, which is
// exactly what's needed here.
//
// Rendered through a portal (document.body), not inline where the trigger sits — the caller's own
// header cell may sit inside a container with `backdropFilter`/`filter`/`transform` set (true of
// the Dashboard's glass cards), and any of those on an ancestor redefines the containing block for
// a `position:fixed` descendant (the same trap that broke the Dashboard's own date-range picker
// earlier). A portal sidesteps the whole bug class instead of requiring every caller to avoid that
// ancestor property, since the trigger's position is wherever the header cell happens to land, not
// a fixed layout element worth restructuring per page.
const ColumnFilter = ({
  label, available, selected, onChange, describe = () => "",
  tokens = { bg: T.surface, border: T.border, borderSoft: T.borderMid, ink: T.text, inkMuted: T.textMuted, accent: T.accent, fontMono: T.mono, fontBody: T.body },
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [search, setSearch] = useState("");
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const active = !!selected;

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
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Search clears on close — reopening with a stale query would confusingly hide options that
  // were never actually excluded from the selection.
  useEffect(() => { if (!open) setSearch(""); }, [open]);

  // Focused on open so a keyboard user can start typing immediately — this list is a checkbox
  // count away from becoming unscrollable on a high-cardinality column like Shipment ID. A
  // callback ref, not a useEffect keyed on `open`: the portaled input only mounts once `pos` is
  // computed by the sibling effect above (one render after `open` first flips true), so a plain
  // ref read in an `[open]`-keyed effect would still be null. A callback ref fires exactly once,
  // right when the node is actually created — and, critically, does NOT fire again on the
  // position updates `pos` gets on every scroll/resize while open, since those just update props
  // on the same already-mounted node rather than recreating it (recreating it would've meant
  // every scroll tick re-stealing focus back into the box mid-keystroke).
  const focusOnMount = el => el?.focus();

  const checkedSet = selected ? new Set(selected) : new Set(available);
  const toggle = value => {
    const next = new Set(checkedSet);
    if (next.has(value)) next.delete(value); else next.add(value);
    onChange(next.size === available.length ? null : [...next]);
  };

  // Search matches the value or its describe() label — "Select all"/"Clear" always act on the
  // full `available` list regardless of the query, not just what's currently visible, so the
  // search stays a pure "find it faster" aid and never quietly changes what a bare click on
  // those two buttons does.
  const q = search.trim().toLowerCase();
  const visible = !q ? available : available.filter(value =>
    value.toLowerCase().includes(q) || describe(value).toLowerCase().includes(q));

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button ref={btnRef} type="button" onClick={() => setOpen(o => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none",
          padding: 0, margin: 0, cursor: "pointer", color: active ? tokens.accent : "inherit", font: "inherit" }}>
        {label}
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ flexShrink: 0 }}>
          <path d="M0.5 1 L9.5 1 L6 5.2 L6 9 L4 9.5 L4 5.2 Z"
            fill={active ? tokens.accent : "none"} stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9500,
          background: tokens.bg, border: `1px solid ${tokens.border}`, borderRadius: 12, padding: 10,
          minWidth: 190, boxShadow: "0 12px 32px rgba(0,0,0,0.55)" }}>
          <input ref={focusOnMount} type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search…" style={{ width: "100%", boxSizing: "border-box", marginBottom: 8,
              background: "rgba(127,127,127,0.12)", border: `1px solid ${tokens.border}`, borderRadius: 7,
              padding: "5px 8px", fontFamily: tokens.fontBody, fontSize: 12, color: tokens.ink, outline: "none" }} />
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8,
            paddingBottom: 8, borderBottom: `1px solid ${tokens.borderSoft}` }}>
            <button type="button" onClick={() => onChange(null)}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
                fontFamily: tokens.fontBody, fontSize: 11, fontWeight: 600, color: tokens.accent }}>
              Select all
            </button>
            <button type="button" onClick={() => onChange([])}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
                fontFamily: tokens.fontBody, fontSize: 11, fontWeight: 600, color: tokens.inkMuted }}>
              Clear
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7, maxHeight: 240, overflowY: "auto" }}>
            {visible.length === 0 ? (
              <div style={{ fontFamily: tokens.fontBody, fontSize: 11.5, color: tokens.inkMuted, padding: "4px 2px" }}>
                No matches
              </div>
            ) : visible.map(value => (
              <label key={value} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={checkedSet.has(value)} onChange={() => toggle(value)} />
                <span style={{ fontFamily: tokens.fontMono, fontWeight: 600, color: tokens.ink }}>{value}</span>
                {describe(value) && (
                  <span style={{ fontFamily: tokens.fontBody, fontSize: 10.5, color: tokens.inkMuted, overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {describe(value)}
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>,
        document.body
      )}
    </span>
  );
};

export default ColumnFilter;
