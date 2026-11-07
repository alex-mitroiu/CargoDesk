import { useState } from "react";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY, carrierBadgeColors } from "../shipmentDetailTheme";
import Btn from "../../../components/primitives/Btn";
import CustomerCombobox from "../../../components/shared/CustomerCombobox";
import { LegRoleChip } from "../../../components/shared/LegRoles";
import { mainLegIndex } from "../../../utils/mainLeg";
import { steeringChipOf } from "../../../components/shared/WhereToBook";
import RouteGlobe from "./RouteGlobe";

// ─── Contracts & Schedules, Trade Horizon next (2026-11-06, mockup 402fb5b5) ─────────────────────────
// The page's presentational pieces. Every style is a function or computed in render, never a module-level
// object: HZ is swapped in place on a theme switch (see shipmentDetailTheme.js). No frame here sets
// backdrop-filter: the Route card holds LegsTable's port and carrier lookups, whose dropdowns are
// position:fixed and would be laid out against a filtered ancestor instead of the window (CLAUDE.md).

export const todayIso = () => new Date().toISOString().slice(0, 10);
const day = v => { const s = String(v || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN; };
export const daysBetween = (a, b) => { const x = day(a), y = day(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 864e5) : null; };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDay = v => { const s = String(v || "").slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "—"; return `${s.slice(8, 10)} ${MON[+s.slice(5, 7) - 1]}`; };
export const fmtDate = v => { const s = String(v || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${fmtDay(s)} ${s.slice(0, 4)}` : "—"; };
const sourceLabel = s => (s === "ais" ? "AIS" : s || "");

// ── Shared looks ─────────────────────────────────────────────────────────────────────────────────────
export const sectionLabelStyle = () => ({ fontFamily: HZ_MONO, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase",
  letterSpacing: "0.08em", color: HZ.textMuted });
export const frameStyle = ({ featured = false } = {}) => ({
  position: "relative", borderRadius: 16, background: HZ.surface,
  border: `1px solid ${featured ? `color-mix(in srgb, ${HZ.violet} 45%, ${HZ.border})` : HZ.border}`,
  boxShadow: featured ? `0 0 0 1px color-mix(in srgb, ${HZ.violet} 10%, transparent), 0 14px 36px -18px color-mix(in srgb, ${HZ.violet} 60%, transparent)` : HZ.cardShadow,
});
// The one luminous edge of a hero frame: a gradient top line with a glow, and a soft wash under it.
export const GlowEdge = () => (
  <>
    <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: 0, height: 2, background: HZ.edge, boxShadow: `0 0 26px 3px ${HZ.glow}`, borderRadius: "16px 16px 0 0" }} />
    <div aria-hidden style={{ position: "absolute", left: "8%", right: "8%", top: 0, height: 90, pointerEvents: "none",
      background: `radial-gradient(60% 100% at 50% 0, ${HZ.glowSoft}, transparent)` }} />
  </>
);
export const pillBtnStyle = ({ disabled = false, accent = false } = {}) => ({
  fontFamily: HZ_BODY, fontSize: 12, fontWeight: 600, borderRadius: 999, padding: "6px 14px", whiteSpace: "nowrap",
  background: HZ.tint, color: accent ? HZ.cyan : HZ.text, border: `1px solid ${accent ? `color-mix(in srgb, ${HZ.cyan} 45%, transparent)` : HZ.border}`,
  cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 6,
});
// The page's one filled, glowing action.
export const ctaStyle = ({ disabled = false } = {}) => ({
  fontFamily: HZ_BODY, fontSize: 12.5, fontWeight: 700, borderRadius: 999, padding: "8px 18px", whiteSpace: "nowrap", border: 0,
  background: HZ.gradCyan, color: HZ.chipText, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  boxShadow: disabled ? "none" : `0 0 0 1px color-mix(in srgb, ${HZ.cyan} 40%, transparent), 0 6px 22px -4px ${HZ.glow}`,
  display: "inline-flex", alignItems: "center", gap: 6,
});
const pillTag = (color, bg) => ({ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".04em", padding: "2px 8px",
  borderRadius: 5, color, background: bg, border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`, whiteSpace: "nowrap" });
// A state word with a glowing dot (Planned, Sailed, Arrived); categories keep rectangle tags.
export const DotPill = ({ color, children, testId }) => (
  <span data-testid={testId} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: HZ_BODY, fontSize: 11, fontWeight: 600,
    padding: "3px 10px", borderRadius: 999, border: `1px solid ${HZ.border}`, background: HZ.tint, color: HZ.text, whiteSpace: "nowrap" }}>
    <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}` }} />{children}
  </span>
);
const CarrierChip = ({ code }) => code ? (
  <span style={{ ...carrierBadgeColors(code), fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, padding: "2px 6px", borderRadius: 4, letterSpacing: ".03em" }}>{code}</span>
) : <span style={{ fontFamily: HZ_MONO, fontSize: 10.5, color: HZ.textFaint }}>no carrier</span>;

// The route as stops: the first leg's start, then every leg's end (a repeat is dropped).
export const stopsOf = legs => {
  const out = [];
  (legs || []).forEach((l, i) => { if (i === 0 && l.pol) out.push(l.pol); if (l.pod && out[out.length - 1] !== l.pod) out.push(l.pod); });
  return out;
};

// ── Pill nav: jump links to the page's sections, and its actions ─────────────────────────────────────
const NAV = [["route", "Route", "shpsched-legs-section"], ["contract", "Contract", "shpsched-contract-section"],
  ["agents", "Line agents", "shpsched-line-agents-section"], ["sailing", "Sailing", "shpsched-sailing-section"]];
export const PillNav = ({ actions }) => {
  const [active, setActive] = useState("route");
  const jump = (key, id) => { setActive(key); document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  return (
    <div data-testid="shipment-schedules-pill-nav" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <nav aria-label="Sections" style={{ display: "inline-flex", gap: 2, padding: 4, border: `1px solid ${HZ.border}`, borderRadius: 999,
        background: HZ.surfaceSolid, boxShadow: HZ.cardShadow, flexWrap: "wrap" }}>
        {NAV.map(([key, label, id], i) => (
          <button key={key} type="button" onClick={() => jump(key, id)} data-testid={`shipment-schedules-nav-${key}`}
            aria-current={active === key ? "true" : undefined}
            style={{ fontFamily: HZ_BODY, fontSize: 12.5, fontWeight: 600, padding: "6px 16px", borderRadius: 999, cursor: "pointer",
              display: "inline-flex", gap: 6, alignItems: "center", border: 0,
              color: active === key ? HZ.text : HZ.textMuted,
              background: active === key ? `linear-gradient(180deg, ${HZ.cyanBg}, transparent)` : "none",
              boxShadow: active === key ? `inset 0 0 0 1px color-mix(in srgb, ${HZ.cyan} 40%, transparent)` : "none" }}>
            <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, opacity: 0.7 }}>{i + 1}</span>{label}
          </button>
        ))}
      </nav>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{actions}</div>
    </div>
  );
};

// ── The hero: globe, the route and its figures ───────────────────────────────────────────────────────
const Stat = ({ num, unit, children, big = true }) => (
  <li style={{ display: "grid", gridTemplateColumns: "minmax(120px, 160px) 1fr", alignItems: "baseline", gap: 14, padding: "11px 0", borderBottom: `1px solid ${HZ.border}` }}>
    <span style={{ fontFamily: HZ_DISPLAY, fontWeight: 700, letterSpacing: "-.02em", fontSize: big ? 26 : 17, lineHeight: 1.15, color: HZ.text, overflowWrap: "anywhere" }}>
      {num}{unit && <small style={{ fontFamily: HZ_BODY, fontSize: 12, fontWeight: 600, color: HZ.textMuted, marginLeft: 5, letterSpacing: 0 }}>{unit}</small>}
    </span>
    <span style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>{children}</span>
  </li>
);
const B = ({ children }) => <b style={{ color: HZ.text, fontWeight: 600 }}>{children}</b>;

export const RouteHero = ({ legs, ports, schedule, today = todayIso() }) => {
  const sea = legs.filter(l => l.legType === "SEA");
  const stops = stopsOf(legs);
  const firstSea = sea[0], lastSea = sea[sea.length - 1];
  const mi = mainLegIndex(sea), main = sea[mi] || firstSea;
  const transit = schedule?.transitDays || daysBetween(firstSea?.etd, lastSea?.eta);
  const sinceEtd = daysBetween(firstSea?.etd, today);
  const arrived = lastSea?.eta && daysBetween(lastSea.eta, today) >= 0;
  const hubs = stopsOf(sea).slice(1, -1);
  // The vessel's position: the sea leg under way today, by elapsed days.
  const underWay = sea.find(l => l.etd && l.eta && daysBetween(l.etd, today) >= 0 && daysBetween(today, l.eta) > 0);
  const pa = underWay && ports[underWay.pol], pb = underWay && ports[underWay.pod];
  const position = pa && pb && Number.isFinite(pa.lat) && Number.isFinite(pb.lat) ? {
    from: pa, to: pb, fraction: Math.max(0, Math.min(1, daysBetween(underWay.etd, today) / Math.max(1, daysBetween(underWay.etd, underWay.eta)))),
    label: `at sea, day ${daysBetween(underWay.etd, today)}`,
  } : null;
  return (
    <div data-testid="shipment-schedules-hero" style={{ ...frameStyle(), overflow: "hidden" }}>
      <GlowEdge />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, .9fr) 1.1fr", gap: 10, alignItems: "center", padding: "16px 26px 16px 6px" }}>
        <RouteGlobe stops={stops.map(code => ({ code, lat: ports[code]?.lat, lon: ports[code]?.lon }))} position={position} />
        <div style={{ position: "relative", zIndex: 1, minWidth: 0 }}>
          <div data-testid="shipment-schedules-route-string" style={{ fontFamily: HZ_MONO, fontSize: 12, fontWeight: 700, color: HZ.cyan, letterSpacing: ".04em", marginBottom: 6 }}>
            {stops.join(" → ")}
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            <Stat num={transit ?? "—"} unit={transit == null ? "" : transit === 1 ? "day" : "days"}>
              {firstSea?.etd && lastSea?.eta ? <>Transit, <B>{fmtDay(firstSea.etd)} to {fmtDay(lastSea.eta)}</B>{schedule?.transitDays ? "" : " (ETD to ETA)"}</> : "The dates come with the sailing"}
            </Stat>
            <Stat num={sea.length} unit={sea.length === 1 ? "sea leg" : "sea legs"}>
              {hubs.length ? <>Transship at <B>{hubs.join(", ")}</B></> : sea.length ? "Direct, no transshipment" : "No sea leg yet"}
              {legs.length > sea.length && <>, plus {legs.length - sea.length} {legs.length - sea.length === 1 ? "haulage leg" : "haulage legs"}</>}
            </Stat>
            <Stat big={false} num={!firstSea?.etd ? "No ETD" : arrived ? "Arrived" : sinceEtd < 0 ? `ETD in ${-sinceEtd}d` : `Day ${sinceEtd}`}>
              {!firstSea?.etd ? "No sailing on the route yet"
                : arrived ? <>At <B>{lastSea.pod}</B> on {fmtDay(lastSea.eta)}{lastSea.etaSource ? `, ETA from ${sourceLabel(lastSea.etaSource)}` : ""}</>
                : sinceEtd < 0 ? <><B>Not sailed yet</B>, all legs planned</>
                : <><B>Sailed.</B>{firstSea.etdSource ? ` ETD from ${sourceLabel(firstSea.etdSource)}` : " ETD as planned"}</>}
            </Stat>
            <Stat big={false} num={main?.vessel || "—"}>
              {main?.vessel ? <>Main vessel · <B>{main.voyage || "no voyage"}</B>{sea.length > 1 ? " (longest leg)" : ""}</> : "No vessel yet: Add Sailing picks one"}
            </Stat>
          </ul>
        </div>
      </div>
    </div>
  );
};

// No legs at all: the steps from here to a saved route (the user's case, 2026-11-06: a blank route table).
export const EmptyRouteHero = ({ shipment, ports = {}, today = todayIso() }) => {
  const crd = shipment.cargoReadyDate ? String(shipment.cargoReadyDate).slice(0, 10) : "";
  const toCrd = crd ? daysBetween(today, crd) : null;
  // A shipment always has its POL and POD from creation; with no legs, the route table is still blank.
  const ends = [shipment.pol, shipment.pod].filter(Boolean);
  const steps = [
    ends.length === 2
      ? ["Add the legs", `${shipment.pol} → ${shipment.pod} has no legs yet. Fill in the blank leg in the route table below (From and To first), or Add Sailing, which fills it from the sailing you pick.`]
      : ["Fill in the route", "In the route table below, the blank leg: the port of loading (From) and the port of discharge (To). Everything else starts from these two ports."],
    ["Choose a contract", `Once the ports are in, the contracts that fit them${crd ? ` and the cargo-ready date (${fmtDay(crd)})` : ""} are offered when you choose one.`],
    ["Pick a sailing", "The sailing search opens on its own after a Central contract, with the contract's carrier, and fills the legs' vessel, voyage and dates."],
    ["Save the route", "Save, or » on the way to the next page. The header, transit time and globe then fill in."],
  ];
  return (
    <div data-testid="shipment-schedules-hero-empty" style={{ ...frameStyle(), overflow: "hidden" }}>
      <GlowEdge />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, .9fr) 1.1fr", gap: 10, alignItems: "center", padding: "16px 26px 16px 6px" }}>
        <RouteGlobe stops={ends.map(code => ({ code, lat: ports[code]?.lat, lon: ports[code]?.lon }))} dashed emptyLabel={ends.length ? "no legs yet" : "no ports yet"} />
        <div style={{ position: "relative", zIndex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: HZ_MONO, fontSize: 12, fontWeight: 700, color: HZ.cyan, letterSpacing: ".04em", marginBottom: 4 }}>
            {ends.length === 2 ? `${shipment.pol} → ${shipment.pod} · NO LEGS YET` : "NO ROUTE YET"}</div>
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {steps.map(([t, x], i) => (
              <li key={t} style={{ display: "grid", gridTemplateColumns: "30px 1fr", gap: 12, alignItems: "start", padding: "11px 0", borderBottom: `1px solid ${HZ.border}` }}>
                <span style={{ width: 26, height: 26, borderRadius: "50%", display: "grid", placeItems: "center", fontFamily: HZ_MONO, fontSize: 11, fontWeight: 700,
                  ...(i === 0 ? { background: HZ.gradCyan, color: HZ.chipText, boxShadow: `0 0 14px ${HZ.glow}` } : { color: HZ.textMuted, border: `2px dashed ${HZ.borderStrong}` }) }}>{i + 1}</span>
                <div><b style={{ display: "block", fontFamily: HZ_BODY, fontSize: 13.5, fontWeight: 700, color: HZ.text }}>{t}</b>
                  <span style={{ display: "block", fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted, marginTop: 2, maxWidth: "62ch" }}>{x}</span></div>
              </li>
            ))}
          </ol>
          {toCrd != null && (
            <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
              <Stat num={toCrd} unit={toCrd === 1 ? "day" : "days"}>To cargo ready, <B>{fmtDay(crd)}</B>. The searches start from this date.</Stat>
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

// ── The route: a rail to read; the table (LegsTable) to configure ────────────────────────────────────
const legState = (leg, today) => {
  const started = leg.etd && daysBetween(leg.etd, today) >= 0, finished = leg.eta && daysBetween(leg.eta, today) >= 0;
  const sea = leg.legType === "SEA";
  if (finished) return { started, finished, label: "Arrived", color: HZ.good };
  if (started) return { started, finished, label: sea ? "Sailed" : "Under way", color: HZ.cyan };
  return { started, finished, label: "Planned", color: HZ.textFaint };
};
export const RouteRail = ({ legs, ports, today = todayIso() }) => {
  const sea = legs.filter(l => l.legType === "SEA");
  const mainSea = sea.length > 1 ? sea[mainLegIndex(sea)] : null;
  const startedCount = legs.filter(l => l.etd && daysBetween(l.etd, today) >= 0).length;
  const fill = startedCount ? Math.min(100, Math.round(((startedCount - 0.5) / legs.length) * 100)) : 0;
  return (
    <div data-testid="shipment-schedules-route-rail" style={{ position: "relative", padding: "8px 22px 18px" }}>
      <div aria-hidden style={{ position: "absolute", left: 44, top: 34, bottom: 34, width: 3, borderRadius: 3, background: HZ.neutralBg }} />
      {fill > 0 && <div aria-hidden style={{ position: "absolute", left: 44, top: 34, width: 3, borderRadius: 3, background: `linear-gradient(180deg, ${HZ.cyan}, ${HZ.cyan2})`,
        boxShadow: `0 0 12px ${HZ.glow}`, height: `calc((100% - 68px) * ${fill / 100})` }} />}
      {legs.map((leg, i) => {
        const st = legState(leg, today);
        const isSea = leg.legType === "SEA";
        const isMain = mainSea && leg === mainSea;
        const dur = daysBetween(leg.etd, leg.eta);
        const next = legs[i + 1];
        const meets = next ? leg.pod && leg.pod === next.pol : true;
        const gap = next ? daysBetween(leg.eta, next.etd) : null;
        const pname = c => ports[c]?.name || "";
        const progress = st.started && !st.finished && dur ? Math.round((daysBetween(leg.etd, today) / dur) * 100) : null;
        return (
          <div key={leg.id || i}>
            <div data-testid="shipment-schedules-rail-leg" style={{ position: "relative", display: "grid", gridTemplateColumns: "44px 1fr auto", gap: 12, alignItems: "center",
              padding: "12px 14px 12px 0", borderRadius: 12,
              ...(isMain ? { background: HZ.surface2, border: `1px solid color-mix(in srgb, ${HZ.cyan} 40%, ${HZ.border})`,
                boxShadow: `0 0 0 1px color-mix(in srgb, ${HZ.cyan} 12%, transparent), 0 10px 30px -14px ${HZ.glow}` } : { border: "1px solid transparent" }) }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", marginLeft: 8, position: "relative", zIndex: 1, display: "grid", placeItems: "center",
                fontFamily: HZ_MONO, fontSize: 11, fontWeight: 700,
                ...(st.started ? { background: HZ.gradCyan, color: HZ.chipText, boxShadow: `0 0 14px ${HZ.glow}` }
                  : { background: HZ.surfaceSolid, border: `2px solid ${isMain ? HZ.cyan : HZ.borderStrong}`, color: isMain ? HZ.cyan : HZ.textMuted }) }}>
                {st.started ? "✓" : i + 1}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: HZ_MONO, fontSize: 14, fontWeight: 800, color: HZ.text, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {leg.pol || "—"} → {leg.pod || "—"}
                  <small style={{ fontFamily: HZ_BODY, fontSize: 11.5, fontWeight: 500, color: HZ.textMuted }}>
                    {[leg.polName || pname(leg.pol), leg.podName || pname(leg.pod)].filter(Boolean).join(" to ")}
                  </small>
                  {sea.length > 1 && isSea && <LegRoleChip role={isMain ? "MAIN" : "FEEDER"} muted={HZ.textMuted} />}
                  {!isSea && <span style={pillTag(HZ.textMuted, HZ.neutralBg)}>{leg.legType}</span>}
                </div>
                <div style={{ fontFamily: HZ_MONO, fontSize: 11.5, color: HZ.textMuted, marginTop: 3, display: "flex", gap: "6px 14px", flexWrap: "wrap", alignItems: "center" }}>
                  {isSea ? <CarrierChip code={leg.carrierCode} /> : <span>{leg.movementType || "Haulage"}{leg.movementBy ? ` by ${leg.movementBy}` : ""}</span>}
                  {isSea && (leg.vessel || leg.voyage
                    ? <span><b style={{ color: HZ.text }}>{leg.vessel || "—"}</b> / {leg.voyage || "—"}</span>
                    : <span style={{ color: HZ.textFaint }}>no vessel yet</span>)}
                  <DotPill color={st.color}>{st.label}{st.started && !st.finished && leg.etdSource ? ` · ETD from ${sourceLabel(leg.etdSource)}` : ""}</DotPill>
                </div>
                {progress != null && (
                  <>
                    <div style={{ height: 5, borderRadius: 5, background: HZ.neutralBg, overflow: "hidden", marginTop: 8, maxWidth: 340 }}>
                      <i style={{ display: "block", height: "100%", width: `${Math.max(2, Math.min(100, progress))}%`, background: `linear-gradient(90deg, ${HZ.cyan}, ${HZ.cyan2})`, boxShadow: `0 0 10px ${HZ.glow}` }} />
                    </div>
                    <div style={{ fontFamily: HZ_MONO, fontSize: 10.5, color: HZ.textMuted, marginTop: 3 }}>Day {daysBetween(leg.etd, today)} of {dur}{leg.etaSource ? ` · ETA from ${sourceLabel(leg.etaSource)}` : ""}</div>
                  </>
                )}
              </div>
              <div style={{ textAlign: "right", fontFamily: HZ_MONO, fontSize: 11.5, color: HZ.textMuted }}>
                <b style={{ display: "block", fontSize: 13, color: HZ.text }}>{fmtDay(leg.etd)} → {fmtDay(leg.eta)}</b>
                {dur != null ? `${dur} day${dur === 1 ? "" : "s"}` : "no dates yet"}
              </div>
            </div>
            {next && (
              <div style={{ margin: "0 0 0 52px", padding: "2px 0 2px 14px", fontFamily: HZ_MONO, fontSize: 10.5, color: HZ.textFaint, display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ width: 14, borderTop: `1px dashed ${HZ.borderStrong}` }} />
                {meets
                  ? <><span style={{ color: HZ.good }}>✓ Legs meet</span> at {leg.pod}{gap != null ? ` · ${gap} day${gap === 1 ? "" : "s"} between ETA and next ETD` : ""}</>
                  : <span style={{ color: HZ.warn }}>! Leg {i + 2} starts at {next.pol || "—"}, leg {i + 1} ends at {leg.pod || "—"}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// The Route legs card: View (the rail) or Edit route (the table), plus the unsaved-changes footer.
export const RouteCard = ({ canView, editing, onEditChange, note, children, footer, canEdit }) => (
  <div id="shpsched-legs-section" data-testid="shipment-schedules-legs-section" style={{ ...frameStyle(), scrollMarginTop: 90 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 16px", borderBottom: `1px solid ${HZ.border}` }}>
      <div style={sectionLabelStyle()}>Route legs</div>
      {canView ? (
        <div role="group" aria-label="Route" style={{ display: "inline-flex", gap: 2, padding: 3, border: `1px solid ${HZ.border}`, borderRadius: 999, background: HZ.tint }}>
          {[["view", "View"], ["edit", canEdit ? "✎ Edit route" : "Table"]].map(([k, label]) => {
            const on = (k === "edit") === editing;
            return (
              <button key={k} type="button" aria-pressed={on} data-testid={`shipment-schedules-route-${k}-btn`} onClick={() => onEditChange(k === "edit")}
                style={{ fontFamily: HZ_BODY, fontSize: 12, fontWeight: 600, border: 0, borderRadius: 999, padding: "5px 12px", cursor: "pointer",
                  background: on ? HZ.cyanBg : "none", color: on ? HZ.cyan : HZ.textMuted }}>{label}</button>
            );
          })}
        </div>
      ) : (
        <span style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted }}>{note}</span>
      )}
    </div>
    <div style={{ padding: editing ? "12px 14px" : 0 }}>{children}</div>
    {footer}
  </div>
);

// ── Contract ─────────────────────────────────────────────────────────────────────────────────────────
// No charges on this tab (the user, 2026-11-06: "showing the costs is not relevant for this tab, these values are
// already available in the cost entry tab"): the card names the contract, its validity and terms, and the space.
const KV = ({ items, testId }) => (
  <div data-testid={testId} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "12px 16px", marginTop: 14 }}>
    {items.map(([label, value]) => (
      <div key={label} style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted, marginBottom: 2 }}>{label}</span>
        <b style={{ fontFamily: HZ_MONO, fontSize: 12.5, fontWeight: value ? 700 : 400, fontStyle: value ? "normal" : "italic", color: value ? HZ.text : HZ.textMuted, wordBreak: "break-word" }}>{value || "—"}</b>
      </div>
    ))}
  </div>
);

// ── Space: what's going on with a space configuration (mockup v9) ─────────────────────────────────────
// The figures are /api/allocations' buckets (or Where to book's, per steering option) for the shipment's week
// (weekly space) or the whole period: Total; Used = confirmed by the carrier, the only bucket that deducts;
// Pending = awaiting the carrier (booking sent, no answer) + not booked yet; Remaining = total − used; and what
// stays free once every pending booking is confirmed (Where to book's "free": total − used − pending).
const SPACE_DOT = { used: () => HZ.good, awaiting: () => HZ.warn, notBooked: () => `color-mix(in srgb, ${HZ.warn} 45%, transparent)`, rejected: () => HZ.crit };
const SpaceFig = ({ label, value, sub, dot, strong, testId }) => (
  <div data-testid={testId} style={{ minWidth: 0 }}>
    <div style={{ fontFamily: HZ_DISPLAY, fontSize: 22, fontWeight: 700, lineHeight: 1.1, letterSpacing: "-.02em", color: strong || HZ.text, fontVariantNumeric: "tabular-nums" }}>
      {value}<small style={{ fontFamily: HZ_BODY, fontSize: 11, fontWeight: 600, letterSpacing: 0, color: HZ.textMuted, marginLeft: 3 }}>TEU</small>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted, marginTop: 3 }}>
      {dot && <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0 }} />}{label}
    </div>
    {sub && <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginTop: 1 }}>{sub}</div>}
  </div>
);
// A configuration in its buckets (either source; older responses carry only pendingTEU: all of it is then not booked).
export const spaceBuckets = sp => {
  const allocated = Number(sp.allocatedTEU) || 0, used = Number(sp.confirmedTEU) || 0, rejected = Number(sp.rejectedTEU) || 0;
  const awaiting = Number(sp.awaitingCarrierTEU) || 0;
  const notBooked = sp.notBookedTEU != null ? Number(sp.notBookedTEU) || 0 : Math.max(0, (Number(sp.pendingTEU) || 0) - awaiting);
  const remaining = sp.remainingTEU != null ? Number(sp.remainingTEU) : Math.max(0, allocated - used);
  return { allocated, used, awaiting, notBooked, pending: awaiting + notBooked, rejected, remaining, free: allocated - used - awaiting - notBooked };
};
export const SpaceFigures = ({ space, testId = "shipment-schedules-space-figures" }) => {
  const b = spaceBuckets(space);
  const weekly = space.spaceBasis === "week";
  const demand = b.used + b.pending + b.rejected;
  const scale = b.allocated > 0 && demand > b.allocated ? b.allocated / demand : 1;
  const pct = v => (b.allocated > 0 ? Math.min(100, (v * scale / b.allocated) * 100) : 0);
  return (
    <>
      <div data-testid={testId} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: "12px 14px", marginTop: 12 }}>
        <SpaceFig testId="space-fig-allocated" label={weekly ? "Total this week" : "Total"} value={b.allocated} sub={weekly ? "allocated a week" : "allocated"} />
        <SpaceFig testId="space-fig-used" label="Used" value={b.used} dot={SPACE_DOT.used()} sub="consumed: confirmed by the carrier" />
        <SpaceFig testId="space-fig-pending" label="Pending" value={b.pending} dot={SPACE_DOT.awaiting()} sub={`${b.awaiting} awaiting the carrier · ${b.notBooked} not booked yet`} />
        {b.rejected > 0 && <SpaceFig testId="space-fig-rejected" label="Rejected" value={b.rejected} dot={SPACE_DOT.rejected()} sub="declined by the carrier" />}
        <SpaceFig testId="space-fig-remaining" label="Remaining" value={b.remaining} strong={b.remaining === 0 ? HZ.crit : HZ.good} sub="total less used" />
      </div>
      <div aria-hidden style={{ display: "flex", height: 8, borderRadius: 8, background: HZ.neutralBg, overflow: "hidden", marginTop: 12 }}>
        {[["used", b.used], ["awaiting", b.awaiting], ["notBooked", b.notBooked], ["rejected", b.rejected]].map(([k, v]) => v > 0 && (
          <div key={k} style={{ width: `${pct(v)}%`, background: SPACE_DOT[k](), flexShrink: 0, borderRight: `2px solid ${HZ.surfaceSolid}` }} />
        ))}
      </div>
      <div data-testid="space-summary-line" style={{ fontFamily: HZ_MONO, fontSize: 11, color: HZ.textMuted, marginTop: 6 }}>
        {b.used} / {b.allocated} TEU confirmed ({b.remaining} remaining)
        {b.pending > 0 && <span style={{ color: HZ.warn }}> · +{b.pending} pending</span>}
        {b.rejected > 0 && <span style={{ color: HZ.crit }}> · +{b.rejected} rejected</span>}
      </div>
      <div data-testid="space-free-line" style={{ fontFamily: HZ_BODY, fontSize: 12, color: b.free < 0 ? HZ.crit : HZ.textMuted, marginTop: 4 }}>
        {b.free < 0 ? `${-b.free} TEU over the space if every pending booking is confirmed.` : `${b.free} TEU still free once every pending booking is confirmed.`}
      </div>
    </>
  );
};
// Which bucket this shipment sits in, by its carrier booking's status.
const ThisShipment = ({ shipmentTeu, bookingStatus, carrierCode }) => {
  const mine = bookingStatus === "Confirmed" ? ["used", "used (the carrier confirmed its booking)"]
    : bookingStatus === "Rejected" ? ["rejected", "rejected (the carrier declined its booking)"]
    : bookingStatus === "Pending" ? ["awaiting", `of the pending, awaiting ${carrierCode || "the carrier"}'s answer to its booking`]
    : ["notBooked", "of the pending, not booked yet (no booking sent to the carrier)"];
  return (
    <div data-testid="shipment-schedules-space-this-shipment" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, padding: "8px 12px", borderRadius: 10,
      border: `1px solid ${HZ.border}`, background: HZ.tint, fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text, flexWrap: "wrap" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: SPACE_DOT[mine[0]](), flexShrink: 0 }} />
      <span>This shipment: <b style={{ fontFamily: HZ_MONO }}>{shipmentTeu} TEU</b>{mine[0] === "used" || mine[0] === "rejected" ? `, ${mine[1]}` : ` ${mine[1]}`}.</span>
    </div>
  );
};
const spaceWhen = sp => sp.spaceBasis === "week"
  ? <span data-testid="schedules-space-week" style={{ color: HZ.text }}>Week {sp.weekNumber}, {Number(sp.allocatedTEU) || 0} TEU a week</span>
  : <>Valid {fmtDate(sp.effectiveDate)} → {fmtDate(sp.endDate)} · {Number(sp.allocatedTEU) || 0} TEU for the period</>;

// The shipment's own space configuration, when no steering line covers it (with one, the steering block shows it).
export const SpacePanel = ({ space, shipmentTeu = 0, bookingStatus, carrierCode }) => (
  <div id="shpsched-space-config-section" data-testid="shipment-schedules-space-config-section" style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${HZ.border}`, scrollMarginTop: 90 }}>
    <div style={{ ...sectionLabelStyle(), marginBottom: 6 }}>Space configuration</div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
      <b style={{ fontFamily: HZ_MONO, fontSize: 12, color: HZ.text }}>{space.carrierCode} · {space.pol} → {space.pod}</b>
      {space.contractNumber && <span style={{ fontFamily: HZ_MONO, fontSize: 10.5, color: HZ.textMuted }}>{space.contractNumber}</span>}
    </div>
    <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted, marginTop: 4 }}>
      {spaceWhen(space)}{space.spaceBasis === "week" && <> · this shipment's week (its ETD's, else its cargo-ready date's)</>}
    </div>
    <SpaceFigures space={space} />
    <ThisShipment shipmentTeu={shipmentTeu} bookingStatus={bookingStatus} carrierCode={carrierCode} />
  </div>
);

// ── Lane steering (mockup v8–v9): the steering line that covers the shipment's lane and customer, its options in
// order with the space each has in the shipment's week (Where to book's answer, lib/where-to-book.js), which one the
// shipment is booked on, and the verdict saved when its contract was (steeringChipOf). With a line, this block holds
// the space: the separate space panel isn't shown, so no figure appears twice.
const optionTag = (o, booked, pickRank) => booked ? ["booked here", HZ.good, HZ.goodBg]
  : o.status === "skipped" ? ["skipped", HZ.textMuted, HZ.neutralBg]
  : o.status === "full" ? ["full", HZ.crit, HZ.critBg]
  : o.rank === pickRank ? ["the pick", HZ.good, HZ.goodBg]
  : o.orderOnly ? ["order only", HZ.textMuted, HZ.neutralBg] : ["available", HZ.cyan, HZ.cyanBg];
export const SteeringBlock = ({ answer, shipment, shipmentTeu = 0, canEdit, isDirty, onRebook }) => {
  const line = answer.line;
  const chip = steeringChipOf(shipment);
  const chipColor = chip?.tone === "good" ? HZ.good : chip?.tone === "warn" ? HZ.warn : HZ.textMuted;
  const notFollowed = ["out_of_order", "other_contract", "other_carrier", "spot"].includes(shipment.steeringVerdict);
  const pickRank = answer.pick?.rank;
  const bookedOn = o => !!shipment.contractId && o.contractId === shipment.contractId && o.carrierCode === shipment.carrierCode;
  return (
    <div id="shpsched-steering" data-testid="shipment-schedules-steering" style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${HZ.border}`, scrollMarginTop: 90 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={sectionLabelStyle()}>Lane steering</span>
        {chip && <span data-testid="shipment-schedules-steering-chip" title={chip.title}
          style={{ fontFamily: HZ_MONO, fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 999, color: chipColor, background: chipColor + "1f" }}>{chip.label}</span>}
      </div>
      <div data-testid="shipment-schedules-steering-line" style={{ fontFamily: HZ_MONO, fontSize: 11.5, color: HZ.textMuted, marginTop: 4 }}>
        {[answer.lane, `for ${line.customerName || "everyone"}`, line.validFrom && line.validTo ? `${fmtDate(line.validFrom)} → ${fmtDate(line.validTo)}` : "", `auto-switch ${line.autoSwitch ? "on" : "off"}`].filter(Boolean).join(" · ")}
      </div>
      {answer.options.map(o => {
        const booked = bookedOn(o);
        const [tag, tagColor, tagBg] = optionTag(o, booked, pickRank);
        return (
          <div key={`${o.rank}-${o.contractId}`} data-testid={`shipment-schedules-steering-option-${o.rank}`} data-booked={booked ? "true" : "false"}
            style={{ marginTop: 8, padding: "10px 12px", borderRadius: 10, border: `1px solid ${booked ? `color-mix(in srgb, ${HZ.good} 50%, ${HZ.border})` : HZ.border}`,
              background: booked ? HZ.goodBg : HZ.tint }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontFamily: HZ_MONO, fontSize: 13, fontWeight: 800, color: HZ.textMuted }}>#{o.rank}</span>
              <CarrierChip code={o.carrierCode} />
              <b style={{ fontFamily: HZ_MONO, fontSize: 12, color: HZ.text }}>{o.contractNumber}</b>
              <span style={{ marginLeft: "auto", fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase",
                padding: "2px 8px", borderRadius: 999, color: tagColor, background: tagBg }}>{tag}</span>
            </div>
            {(o.note || o.reason) && <div style={{ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted, marginTop: 4 }}>{[o.note, o.reason].filter(Boolean).join(" · ")}</div>}
            {o.orderOnly && <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted, marginTop: 6, fontStyle: "italic" }}>No space configured on this route: booked on order, with no cap.</div>}
            {(o.space || []).map(sp => (
              <div key={sp.id} style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${HZ.border}` }}>
                <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted }}>Space configuration {sp.id} · {spaceWhen(sp)}{sp.customerName ? ` · ${sp.customerName} only` : ""}</div>
                <SpaceFigures space={sp} testId={`shipment-schedules-steering-space-${o.rank}`} />
                {booked && sp.id === shipment.allocationId && <ThisShipment shipmentTeu={shipmentTeu} bookingStatus={shipment.bookingStatus} carrierCode={shipment.carrierCode} />}
              </div>
            ))}
          </div>
        );
      })}
      {notFollowed && chip && (
        <div data-testid="shipment-schedules-steering-off" style={{ marginTop: 12, borderRadius: 10, padding: "10px 12px", border: `1px solid color-mix(in srgb, ${HZ.warn} 45%, transparent)`,
          background: HZ.warnBg, fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text }}>
          {chip.title}
          {canEdit && <div style={{ marginTop: 8 }}>
            <button type="button" data-testid="shipment-schedules-steering-rebook" disabled={isDirty} onClick={onRebook} style={pillBtnStyle({ disabled: isDirty })}>
              Book on #{pickRank || 1} instead</button></div>}
        </div>
      )}
    </div>
  );
};

export const ContractCard = ({ shipment, contractDetail, commodityLabel, rateSnapshotId, mismatch, pol, pod, canEdit, isDirty, onChange, steeringChip,
  space = null, spaceMissing = false, steering = null, shipmentTeu = 0, today = todayIso() }) => {
  const isCentral = shipment.contractType === "Central";
  const detail = isCentral ? contractDetail : null;
  const unlinked = isCentral && shipment.contractRef && !shipment.contractId;
  // The shipment's own reference, else its linked contract's number (records with a contract linked and the reference
  // blank used to read "No contract assigned" right under the contract's number).
  const contractShown = shipment.contractRef || detail?.contractNumber || "";
  const hasContract = !!(shipment.contractRef || shipment.contractId);
  const validFrom = detail?.validFrom || (!isCentral ? shipment.contractValidFrom : "") || "";
  const validTo = detail?.validTo || (!isCentral ? shipment.contractValidTo : "") || "";
  const span = daysBetween(validFrom, validTo);
  const pct = d => (span ? Math.max(0, Math.min(100, (daysBetween(validFrom, d) / span) * 100)) : 0);
  const routingRates = (detail?.rates || []).filter(r => !r.routingId || r.routingId === shipment.contractRoutingId);
  const types = new Set(routingRates.map(r => r.containerType).filter(Boolean));
  const routeLegs = (detail?.legs || []).filter(l => !shipment.contractRoutingId || l.routingId === shipment.contractRoutingId).sort((a, b) => (a.legOrder ?? 0) - (b.legOrder ?? 0));
  const contractRoute = routeLegs.length ? stopsOf(routeLegs).join(" → ") : "";
  const expired = !isCentral && shipment.contractValidTo && shipment.contractValidTo < today;
  const spare = shipment.etd && validTo ? daysBetween(shipment.etd, validTo) : null;
  const steered = !!steering?.line;
  return (
    <div style={{ ...frameStyle({ featured: isCentral && !!detail }), padding: "18px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={sectionLabelStyle()}>Contract</div>
          <div data-testid="shipment-schedules-contract-number" style={{ fontFamily: HZ_DISPLAY, fontSize: 22, fontWeight: 800, letterSpacing: "-.01em", color: (detail?.contractNumber || shipment.contractRef) ? HZ.text : HZ.textMuted,
            fontStyle: (detail?.contractNumber || shipment.contractRef) ? "normal" : "italic", margin: "8px 0 2px", overflowWrap: "anywhere" }}>
            {detail?.contractNumber || shipment.contractRef || (shipment.contractType === "SPOT" ? "SPOT" : "No contract yet")}
          </div>
          {detail && <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted }}>
            {[shipment.carrierCode, shipment.movementType || "FCL", types.size ? `${types.size} container type${types.size === 1 ? "" : "s"}` : "", commodityLabel ? `commodity ${commodityLabel}` : ""].filter(Boolean).join(" · ")}
          </div>}
        </div>
        {detail?.status && <DotPill color={detail.status === "Active" ? HZ.good : HZ.warn}>{detail.status}</DotPill>}
      </div>

      {mismatch && (
        <div id="shpsched-contract-mismatch" data-testid="shipment-schedules-contract-mismatch" style={{ marginTop: 12, borderRadius: 10, padding: "10px 12px",
          border: `1px solid color-mix(in srgb, ${HZ.crit} 45%, transparent)`, background: HZ.critBg, fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text }}>
          <b style={{ color: HZ.crit }}>The contract doesn't cover this route.</b>{" "}
          <span style={{ fontFamily: HZ_MONO }}>{contractShown || "This contract"}</span> no longer matches <span style={{ fontFamily: HZ_MONO }}>{pol} → {pod}</span>.
          Pick a new one: through a linked space configuration, the Central contract list, or switch to SPOT, Pending or Customer Own.
        </div>
      )}

      <div id="shpsched-contract-summary" data-testid="shipment-schedules-contract-summary" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <span style={isCentral ? pillTag(HZ.violetPillText, HZ.violetBg) : pillTag(HZ.cyan, HZ.cyanBg)}>{shipment.contractType || "—"}</span>
        <span style={{ fontFamily: HZ_MONO, fontSize: 12.5, color: contractShown ? HZ.text : HZ.textMuted, fontWeight: contractShown ? 700 : 400,
          fontStyle: contractShown ? "normal" : "italic", overflowWrap: "anywhere" }}>{contractShown || "No contract assigned"}</span>
        {shipment.spotOfferId && shipment.contractType === "SPOT" && <span data-testid="shipment-schedules-contract-spot-chip" style={pillTag(HZ.text, HZ.surface2)}>Spot offer</span>}
        {shipment.allocationId && <span style={pillTag(HZ.good, HZ.goodBg)}>Space config</span>}
        {expired && <span title={`Expired ${shipment.contractValidTo}`} style={pillTag(HZ.warn, HZ.warnBg)}>Expired</span>}
      </div>

      {unlinked && (
        <div style={{ marginTop: 12, borderRadius: 10, padding: "10px 12px", border: `1px solid color-mix(in srgb, ${HZ.warn} 45%, transparent)`, background: HZ.warnBg, fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text }}>
          <b>Reference saved, record not linked.</b> This shipment keeps the contract reference but no contract record, so its validity and terms can't load. Change Contract links one.
        </div>
      )}

      {validFrom && validTo && span > 0 && (
        <div style={{ margin: "14px 0 4px" }}>
          <div style={{ position: "relative", height: 6, borderRadius: 6, background: HZ.neutralBg }}>
            {shipment.etd && <span style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: `${pct(shipment.etd)}%`, borderRadius: 6, opacity: 0.75,
              background: `linear-gradient(90deg, ${HZ.violet}, ${HZ.cyan2})` }} />}
            <i title="Today" style={{ position: "absolute", top: -3, bottom: -3, left: `${pct(today)}%`, width: 3, borderRadius: 2, background: HZ.cyan, boxShadow: `0 0 10px ${HZ.glow}` }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: HZ_MONO, fontSize: 11, color: HZ.textMuted, marginTop: 6 }}>
            <span>{fmtDate(validFrom)}</span><span>Today {fmtDay(today)}</span><span>{fmtDate(validTo)}</span>
          </div>
          <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: spare != null && spare < 0 ? HZ.warn : HZ.textMuted, marginTop: 4 }}>
            {spare == null ? "No ETD yet to check the validity against."
              : spare < 0 ? `ETD (${fmtDay(shipment.etd)}) is ${-spare} day${spare === -1 ? "" : "s"} after the contract ends.`
              : `Valid through ETD (${fmtDay(shipment.etd)}), with ${spare} day${spare === 1 ? "" : "s"} to spare after it.`}
          </div>
        </div>
      )}

      {steered ? (
        <SteeringBlock answer={steering} shipment={shipment} shipmentTeu={shipmentTeu} canEdit={canEdit} isDirty={isDirty} onRebook={onChange} />
      ) : (
        <>
          {space && <SpacePanel space={space} shipmentTeu={shipmentTeu} bookingStatus={shipment.bookingStatus} carrierCode={shipment.carrierCode} />}
          {spaceMissing && (
            <div id="shpsched-space-config-section" data-testid="shipment-schedules-space-config-section" style={{ marginTop: 16, fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted,
              fontStyle: "italic", border: `1px dashed ${HZ.borderStrong}`, borderRadius: 10, padding: "12px 14px" }}>
              No active space configuration matches this shipment.
            </div>
          )}
          {steeringChip}
        </>
      )}

      <KV testId="shipment-schedules-contract-details" items={[
        ["Rate ID", isCentral ? rateSnapshotId || "" : ""],
        ["Named account", detail?.namedAccount || ""],
        ...(isCentral ? [] : [["Valid from", validFrom], ["Valid to", validTo]]),
      ]} />
      {contractRoute && <div style={{ fontFamily: HZ_MONO, fontSize: 11, color: HZ.textMuted, marginTop: 10 }}>Contract route: {contractRoute}</div>}
      {canEdit && (
        <div style={{ marginTop: 14 }}>
          <button id="shpsched-contract-btn" data-testid="shipment-schedules-contract-btn" type="button" disabled={isDirty} onClick={onChange}
            title={isDirty ? "Save or discard your route changes first. A contract that no longer fits the route comes off when you save." : undefined} style={pillBtnStyle({ disabled: isDirty })}>
            {hasContract ? "Change Contract" : "＋ Add Contract"}
          </button>
        </div>
      )}
    </div>
  );
};

// ── Sailing ──────────────────────────────────────────────────────────────────────────────────────────
export const SailingCard = ({ schedule, staged, hasPorts, legVessel }) => (
  <div id="shpsched-sailing-section" data-testid="shipment-schedules-sailing-section" style={{ ...frameStyle(), padding: "18px 20px", scrollMarginTop: 90 }}>
    <div style={{ ...sectionLabelStyle(), marginBottom: 8 }}>Sailing</div>
    {schedule ? (
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: HZ_MONO, fontSize: 14, fontWeight: 800, color: HZ.text }}>{schedule.vesselName || "—"} / {schedule.voyageNumber || "—"}</div>
          <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted, marginTop: 2 }}>
            {[schedule.service ? `Service ${schedule.service}` : "", schedule.transitDays ? `${schedule.transitDays} days on the sea route` : "", schedule.etd ? `${fmtDay(schedule.etd)} → ${fmtDay(schedule.eta)}` : ""].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {staged && <span style={pillTag(HZ.cyan, HZ.cyanBg)}>Staged, not saved</span>}
          {schedule.isMock && <span style={pillTag(HZ.warn, HZ.warnBg)}>Demo data</span>}
          {schedule.source && <span style={pillTag(HZ.textMuted, HZ.neutralBg)}>from {schedule.source}</span>}
        </div>
      </div>
    ) : (
      <div style={{ border: `1px dashed ${HZ.borderStrong}`, borderRadius: 10, padding: "12px 14px", background: HZ.tint }}>
        <div style={{ fontFamily: HZ_BODY, fontSize: 13, fontWeight: 600, fontStyle: "italic", color: HZ.textMuted }}>No sailing saved</div>
        <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted, marginTop: 2 }}>
          {legVessel ? <>The sea leg carries <b style={{ fontFamily: HZ_MONO, color: HZ.text }}>{legVessel.vessel || "—"} / {legVessel.voyage || "—"}</b>, but no saved sailing is attached (no service or transit time on record). Change Sailing attaches one.</>
            : hasPorts ? "Add Sailing searches the carrier's sailings for the route; the vessel, voyage, service and transit time come from the one you pick."
            : "The sailing search needs a port of loading and discharge first."}
        </div>
      </div>
    )}
  </div>
);

// ── Line agents ──────────────────────────────────────────────────────────────────────────────────────
// Export/Import Line Agent: assign, reassign or remove, each gated on its own office side (the page passes
// canEdit). Same test ids as before the redesign.
export const LineAgentTile = ({ label, role, party, canEdit, onAssign, onRemove }) => {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState({ id: "", name: "" });
  const [saving, setSaving] = useState(false);
  const tid = `shipment-schedules-line-agent-${role.toLowerCase().replace(/\s+/g, "-")}`;
  const startEdit = () => { setValue(party ? { id: party.customerId, name: party.customerName } : { id: "", name: "" }); setEditing(true); };
  const save = async () => {
    if (!value.id) return;
    setSaving(true); await onAssign(party?.id, value.id, value.name); setSaving(false); setEditing(false);
  };
  const initials = (party?.customerName || "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
  return (
    <div data-testid={tid} style={{ display: "flex", flexDirection: editing ? "column" : "row", alignItems: editing ? "stretch" : "center", gap: 12, padding: "12px 14px",
      borderRadius: 12, background: HZ.tint, border: `1px ${party ? "solid" : "dashed"} ${party ? HZ.border : HZ.borderStrong}` }}>
      {editing ? (
        <>
          <div style={{ fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted }}>{label}</div>
          <CustomerCombobox label="Customer" value={value} onChange={setValue} roleFilter={role} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn size="sm" variant="secondary" onClick={() => setEditing(false)} data-testid={`${tid}-cancel-btn`}>Cancel</Btn>
            <Btn size="sm" disabled={saving || !value.id} onClick={save} data-testid={`${tid}-save-btn`}>{saving ? "Saving…" : "Save"}</Btn>
          </div>
        </>
      ) : (
        <>
          <div aria-hidden style={{ width: 36, height: 36, borderRadius: "50%", flexShrink: 0, display: "grid", placeItems: "center", fontFamily: HZ_DISPLAY, fontSize: 13, fontWeight: 800,
            ...(party ? { background: HZ.gradCyan, color: HZ.chipText } : { background: HZ.neutralBg, color: HZ.textMuted }) }}>{party ? initials : "＋"}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted }}>{label}</div>
            <div style={{ fontFamily: HZ_BODY, fontSize: 13.5, fontWeight: party ? 700 : 600, fontStyle: party ? "normal" : "italic", color: party ? HZ.text : HZ.textMuted,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{party ? party.customerName : "Not assigned"}</div>
          </div>
          {canEdit && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button type="button" onClick={startEdit} data-testid={`${tid}-edit-btn`} title={party ? "Reassign" : "Assign"} style={pillBtnStyle()}>{party ? "Reassign" : "＋ Assign"}</button>
              {party && (
                <button type="button" onClick={() => onRemove(party.id)} data-testid={`${tid}-remove-btn`} title="Remove" aria-label={`Remove the ${label}`}
                  style={{ ...pillBtnStyle(), padding: "4px 10px", color: HZ.textMuted }}>×</button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
