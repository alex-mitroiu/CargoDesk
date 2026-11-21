import { useCallback, useEffect, useState } from "react";
import { HZ, HZ_MONO, HZ_BODY } from "../../pages/shipments/shipmentDetailTheme";
import { frameStyle, sectionLabelStyle } from "../../pages/shipments/schedules/SchedulesParts";

// ─── A foldable section in Trade Horizon Next (2026-11-18, mockup a3e1b986 v2, ARCHITECTURE.md §8.54) ──────────────
// FoldSection: a glass frame whose header (an arrow and the section's name) folds the body away. Folded, the header
// keeps what still matters: the section's status, a one-line summary and its actions (decision B). useFolds: which
// sections are open; a section starts open and then remembers the user's choice, per user in this browser (decision A).
// The frame sets no backdrop-filter: a Modal opened from inside a section is position:fixed and would be laid out
// against a filtered ancestor instead of the window (CLAUDE.md, Trade Horizon cards).

const STORE = userId => `cd_folds_${userId || "anon"}`;
const readStore = userId => {
  try { const v = JSON.parse(localStorage.getItem(STORE(userId)) || "{}"); return v && typeof v === "object" ? v : {}; }
  catch { return {}; }
};

// keys: the sections' fold keys ("carrier-booking.offices"); only a choice the user made is stored.
export function useFolds(keys, userId) {
  const [saved, setSaved] = useState(() => readStore(userId));
  useEffect(() => { setSaved(readStore(userId)); }, [userId]);
  const isOpen = useCallback(key => saved[key] !== false, [saved]);
  const setOpen = useCallback((key, open) => {
    setSaved(prev => {
      const next = { ...prev, [key]: !!open };
      try { localStorage.setItem(STORE(userId), JSON.stringify(next)); } catch { /* kept for this visit only */ }
      return next;
    });
  }, [userId]);
  const open = Object.fromEntries((keys || []).map(k => [k, isOpen(k)]));
  return { open, isOpen, setOpen, toggle: key => setOpen(key, !isOpen(key)) };
}

// The folded summary: the section's facts as label + value pills, as in the shipment header's facts row.
// items: [{ label, value, warn?, tail? }] — warn colours the value (e.g. "none set").
export const FactsPills = ({ items, testId }) => (
  <div data-testid={testId} style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: 5, border: `1px solid ${HZ.border}`, borderRadius: 20,
    background: HZ.tint, width: "fit-content", maxWidth: "100%" }}>
    {items.map((it, i) => (
      <span key={i} style={{ fontFamily: HZ_MONO, fontSize: 11.5, color: HZ.textMuted, padding: "4px 12px", borderRadius: 999, overflowWrap: "anywhere" }}>
        {it.label} <b style={{ color: it.warn ? HZ.warn : HZ.text, fontWeight: 700 }}>{it.value}</b>{it.tail ? ` · ${it.tail}` : ""}
      </span>
    ))}
  </div>
);

const Chevron = ({ open }) => (
  <span aria-hidden style={{ width: 26, height: 26, borderRadius: "50%", border: `1px solid ${HZ.border}`, background: HZ.surface2, color: HZ.cyan,
    display: "grid", placeItems: "center", flex: "none", transition: "transform .18s ease", transform: open ? "rotate(90deg)" : "none" }}>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
  </span>
);

// open/onToggle: controlled (the page keeps it, so its pill nav can open a section); left out, the section keeps its own
// state and starts open. accent: the frame's border tint (the carrier offices are cyan, as on the page before).
export function FoldSection({ id, testId, label, tag, status, summary, actions, open: openProp, onToggle, accent, children }) {
  const [own, setOwn] = useState(true);
  const open = openProp === undefined ? own : openProp;
  const toggle = () => (onToggle ? onToggle() : setOwn(o => !o));
  const bodyId = `${id}-body`;
  return (
    <section id={id} data-testid={testId} data-open={open ? "true" : "false"}
      style={{ ...frameStyle(), scrollMarginTop: 90, ...(accent ? { border: `1px solid color-mix(in srgb, ${accent} 35%, ${HZ.border})` } : {}) }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px 14px", padding: "14px 18px", flexWrap: "wrap" }}>
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={bodyId} data-testid={`${testId}-fold`}
          title={open ? `Fold ${label}` : `Unfold ${label}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 10, background: "none", border: 0, padding: 0, cursor: "pointer", color: HZ.text, textAlign: "left" }}>
          <Chevron open={open} />
          <span style={{ ...sectionLabelStyle(), color: HZ.text }}>{label}</span>
          {tag && <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".04em", padding: "2px 8px", borderRadius: 5,
            background: HZ.neutralBg, color: HZ.textMuted, border: `1px solid ${HZ.border}` }}>{tag}</span>}
        </button>
        {status}
        {actions && <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{actions}</div>}
        {!open && summary && <div data-testid={`${testId}-summary`} style={{ order: 5, flex: "1 1 100%", minWidth: 0, display: "flex" }}>{summary}</div>}
      </div>
      {/* Hidden, not removed, when folded: the arrow's aria-controls names an element that exists (audit B3). */}
      <div id={bodyId} hidden={!open} style={{ padding: "0 18px 18px", display: open ? "grid" : "none", gap: 14, fontFamily: HZ_BODY }}>{children}</div>
    </section>
  );
}
