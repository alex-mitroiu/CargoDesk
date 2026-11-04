import { useState, useEffect, useRef } from "react";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { onServicesChanged } from "../../servicesBus";
import { sidebarOrderFromSettings, shipmentNavSequence, nextNavStop } from "../../shipmentNavSequence";
import { HZ, HZ_MONO } from "../../pages/shipments/shipmentDetailTheme";

// ─── » Advance bar ────────────────────────────────────────────────────────────
// A rail down the right edge of every shipment page: » saves what's unsaved and opens the next
// row of the sidebar tree (shipmentNavSequence.js) — the viewer's own tree, in the admin-saved
// order, read-only pages included, a group's rows one by one, a Review step counted as part of
// its row. The next page's name is written down the rail; on the last row there is no bar.
// "Saves" is navigate()'s own runNavigationGuard() — the same check a sidebar click runs (today
// only the Cargo container form and the Contracts & Schedules draft register one). If it fails,
// navigate() shows the error toast, returns false, and the bar flashes red and stays put.
// Alt+→ does the same, unless something (a dialog, a drawer) covers the bar. The one exception to
// "a dialog covers it": a page's prerequisite lock (Modal keepAdvanceBar) lifts the bar above its
// backdrop, since a locked page is a stop like any other and » has to be able to leave it.

export const ADVANCE_BAR_WIDTH = 46;
// The main scroll area (margin) and the toasts (right offset) step left of the bar by this
// much while it's showing — see App.jsx and ToastContainer.jsx.
const WIDTH_VAR = "--cd-advance-bar-w";

// Injected once — :hover/:focus-visible and keyframes can't be inline styles. Colors come in as
// custom properties set on the button from HZ, so a theme switch restyles it on the next render.
if (!document.getElementById("cd-advbar-style")) {
  const s = document.createElement("style");
  s.id = "cd-advbar-style";
  s.textContent = `
.cd-advbar { position: fixed; top: 46px; bottom: 36px; right: 0; width: ${ADVANCE_BAR_WIDTH}px; z-index: 150;
  margin: 0; padding: 14px 0; border: 0; border-left: 1px solid var(--adv-border); background: var(--adv-surface);
  cursor: pointer; font: inherit; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; transition: background .15s ease; }
:root[data-advance-bar-over-modal] .cd-advbar { z-index: 1001; }
.cd-advbar-ln { flex: 1; width: 1px;
  background: linear-gradient(to bottom, transparent, var(--adv-border-strong) 35%, var(--adv-border-strong) 65%, transparent); }
.cd-advbar-pill { width: 32px; height: 86px; flex-shrink: 0; border-radius: 10px; background: var(--adv-grad);
  color: var(--adv-on-grad); display: grid; place-items: center; box-shadow: 0 8px 20px -10px var(--adv-accent); }
.cd-advbar-pill svg { transition: transform .18s ease; }
.cd-advbar:hover { background: var(--adv-accent-bg); }
.cd-advbar:hover .cd-advbar-pill svg, .cd-advbar:focus-visible .cd-advbar-pill svg { transform: translateX(3px); }
.cd-advbar:focus-visible { outline: 2px solid var(--adv-accent); outline-offset: -3px; }
.cd-advbar-name { writing-mode: vertical-rl; font-family: ${HZ_MONO}; font-size: 10px; font-weight: 600;
  letter-spacing: .14em; text-transform: uppercase; color: var(--adv-muted); white-space: nowrap;
  max-height: 260px; overflow: hidden; text-overflow: ellipsis; }
.cd-advbar:hover .cd-advbar-name { color: var(--adv-accent); }
.cd-advbar[data-state="saving"] { cursor: progress; }
.cd-advbar-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor;
  border-right-color: transparent; animation: cd-advbar-spin .7s linear infinite; }
.cd-advbar[data-state="error"] .cd-advbar-pill { background: var(--adv-grad-crit); box-shadow: none;
  animation: cd-advbar-nudge .38s ease; }
@keyframes cd-advbar-spin { to { transform: rotate(360deg); } }
@keyframes cd-advbar-nudge { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-4px); } 70% { transform: translateX(2px); } }
@media (prefers-reduced-motion: reduce) {
  .cd-advbar, .cd-advbar-pill svg { transition: none; }
  .cd-advbar[data-state="error"] .cd-advbar-pill, .cd-advbar-spin { animation: none; }
}`;
  document.head.appendChild(s);
}

const CHEVRONS = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6l6 6-6 6M13 6l6 6-6 6" />
  </svg>
);

const ShipmentAdvanceBar = ({ shipment, currentPage, appSettings, navigate }) => {
  const { isTradeManager } = useAuth();

  // Self-fetches shipment_services, as the sidebar does, to know which Export/Import Services
  // rows the tree has — refreshed on every page switch and on the servicesBus signal (ordering
  // a service on Overview). Tagged with the shipment it belongs to, so a previous shipment's
  // list is never walked while this one's first fetch is in flight; no bar until it arrives.
  const [services, setServices] = useState(null); // { shipmentId, list }
  useEffect(() => {
    let cancelled = false;
    const load = () => api.services.list(shipment.id)
      .then(list => !cancelled && setServices({ shipmentId: shipment.id, list }))
      .catch(() => !cancelled && setServices({ shipmentId: shipment.id, list: [] }));
    load();
    const unsub = onServicesChanged(sid => { if (sid === shipment.id) load(); });
    return () => { cancelled = true; unsub(); };
  }, [shipment.id, currentPage]);

  const loaded = services?.shipmentId === shipment.id ? services.list : null;
  const sequence = loaded
    ? shipmentNavSequence({ order: sidebarOrderFromSettings(appSettings), services: loaded, isTradeManager })
    : [];
  const next = nextNavStop(sequence, currentPage);
  const visible = !!next;

  useEffect(() => {
    if (!visible) return undefined;
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty(WIDTH_VAR, `${ADVANCE_BAR_WIDTH}px`);
    return () => rootStyle.removeProperty(WIDTH_VAR);
  }, [visible]);

  const [barState, setBarState] = useState("idle"); // idle | saving | error
  const busyRef = useRef(false);
  const errTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(errTimerRef.current), []);

  const advance = async () => {
    if (!next || busyRef.current) return;
    busyRef.current = true;
    clearTimeout(errTimerRef.current);
    setBarState("saving");
    const moved = await navigate(next.pageKeys[0], shipment.id);
    busyRef.current = false;
    if (moved === false) {
      setBarState("error");
      errTimerRef.current = setTimeout(() => setBarState("idle"), 900);
    } else {
      setBarState("idle");
    }
  };
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  // Alt+→. While the bar shows, the browser's own Alt+→ (history Forward) never fires on a
  // shipment page; the key advances only when the bar is actually reachable — the topmost
  // element at its centre is the bar itself, not an open dialog's backdrop or a drawer.
  const btnRef = useRef(null);
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = e => {
      if (e.key !== "ArrowRight" || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      if (e.repeat) return;
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint?.(r.left + r.width / 2, r.top + r.height / 2);
      if (!top || !btn.contains(top)) return;
      advanceRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  if (!visible) return null;
  const nextName = next.fullLabel || next.label;
  return (
    <button ref={btnRef} type="button" className="cd-advbar" data-testid="shipment-advance-bar"
      data-state={barState} data-next={next.pageKeys[0]} onClick={advance}
      aria-label={`Save and go to ${nextName}`} aria-keyshortcuts="Alt+ArrowRight" aria-busy={barState === "saving"}
      style={{
        "--adv-surface": HZ.surfaceSolid, "--adv-border": HZ.border, "--adv-border-strong": HZ.borderStrong,
        "--adv-accent": HZ.cyan, "--adv-accent-bg": HZ.cyanBg, "--adv-muted": HZ.textMuted,
        "--adv-grad": HZ.gradCyan, "--adv-on-grad": HZ.chipText,
        "--adv-grad-crit": `linear-gradient(135deg, ${HZ.crit}, ${HZ.violet2})`,
      }}>
      <span className="cd-advbar-ln" />
      <span className="cd-advbar-pill">
        {barState === "saving" ? <span className="cd-advbar-spin" /> : CHEVRONS}
      </span>
      <span className="cd-advbar-name" data-testid="shipment-advance-bar-next">Next · {next.label}</span>
      <span className="cd-advbar-ln" />
    </button>
  );
};

export default ShipmentAdvanceBar;
