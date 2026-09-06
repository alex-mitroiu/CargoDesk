import { useState, useEffect, useMemo } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { PageSpinner } from "../../components/primitives/Spinner";
import { Inp } from "../../components/primitives/Form";
import {
  LAND_POLYGONS, PortHoverChip, ringToPath, usePanZoom, ZoomControls, ZOOM_STEP,
} from "../../components/shared/mapCore";
import { Timeline } from "../../components/shared/LoopRouteModal";

// ─── MDM: Loop Map Explorer ─────────────────────────────────────────────────────
// Browse every registered carrier loop on one world-spanning map at once, direct follow-up to
// LoopRouteModal.jsx's own per-shipment map (2026-09-04) — scoped to MDM specifically because
// comparing loops ACROSS different carriers only makes sense here; a shipment is already tied to
// one loop, so its own modal stays a tight view zoomed to just that loop's own ports. Shares its
// projection/decluttering/pan-zoom building blocks with that modal via ../../components/shared/
// mapCore — see that file's own header for why they're split out.

const LOOP_COLORS = ["#f5a623", "#4a90d9", "#7ed321", "#e04f5f", "#9013fe", "#50c9c3", "#d0a72e", "#ff7eb6", "#00b894", "#8899a8"];

// Selection cap for the overlay box below — not a RAM/performance limit (an SVG Timeline is cheap
// either way), purely a readability one: past ~5 loops the consolidated box turns into a wall of
// mini-tracks nobody can usefully scan. Validated in a design-decision artifact before building.
const OVERLAY_CAP = 5;

// One color per carrier code, reused for both the map's own per-loop lines (via colorFor below,
// unrelated) and the overlay box's carrier-group chip background — a carrier not in this map falls
// back to a neutral gray rather than growing the list unbounded.
const CARRIER_COLORS = { HLCU: "#c8580f", MAEU: "#1c6fb8", MSCU: "#3f8f1a", CMDU: "#a83f8f" };
const carrierColor = (code) => CARRIER_COLORS[code] || "#5a6b85";

// Fixed full-world equirectangular canvas — unlike LoopMap's own tight per-loop bounding box, the
// Explorer always shows the whole world by default and lets pan/zoom do the rest, since selected
// loops can span any combination of regions at once. Antimeridian-crossing routes (a loop with a
// leg near ±180°) will draw as a straight jump across the map rather than wrapping — a known,
// accepted v1 limitation; real registered loops so far don't cross it.
const W = 1600, H = 800;
function projectWorld(lon, lat) {
  return [(lon + 180) * (W / 360), (90 - lat) * (H / 180)];
}

// Computed once at module load — no per-loop bbox filtering needed here (unlike LoopMap), since
// the canvas already spans the entire world regardless of which loops end up selected.
const WORLD_LAND_PATH = LAND_POLYGONS.map(polygon =>
  polygon.map(ring => ringToPath(ring, projectWorld, W)).join(" ")
).join(" ");

const linkBtnStyle = {
  background: "none", border: "none", padding: 0, fontFamily: T.body, fontSize: 11.5,
  fontWeight: 600, color: T.accent, cursor: "pointer",
};

const LoopSidebarRow = ({ loop, color, checked, disabled, disabledReason, hovered, onToggle, onHover }) => (
  <label
    onMouseEnter={() => onHover(loop.id)} onMouseLeave={() => onHover(null)}
    style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8,
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
      background: hovered ? T.surfaceHover : "transparent",
    }}
    title={disabled ? disabledReason : undefined}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle}
      style={{ accentColor: color, width: 14, height: 14, flexShrink: 0 }} />
    <span style={{ width: 10, height: 10, borderRadius: "50%", background: checked ? color : T.border, flexShrink: 0 }} />
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 700, color: T.text }}>{loop.code}</span>
        {loop.carrierCode && (
          <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.textMuted,
            background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 5px" }}>{loop.carrierCode}</span>
        )}
      </div>
      <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {loop.name} · {loop.portCount} port{loop.portCount !== 1 ? "s" : ""}
      </div>
    </div>
  </label>
);

// Consolidated overlay — one draggable/resizable/minimizable box holding every selected loop's
// own shipment-level Timeline (imported, reused in full per direct request rather than a
// simplified rebuild), grouped by carrier code. Validated against 3 candidate designs in a
// standalone artifact before being built for real — "One overlay"/"One per loop" were rejected in
// favor of this single-box shape once multi-loop selection needed carrier grouping anyway.
const LoopOverlayBox = ({ boxLoops, state, setState, onHoverLoop }) => {
  const startDrag = (e) => {
    if (e.target.closest("[data-overlay-btn]")) return;
    const startX = e.clientX, startY = e.clientY;
    const origX = state.x, origY = state.y;
    const onMove = (ev) => setState(s => ({ ...s, x: origX + (ev.clientX - startX), y: origY + (ev.clientY - startY) }));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const startResize = (e) => {
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const origW = state.w, origH = state.h;
    const onMove = (ev) => setState(s => ({
      ...s,
      w: Math.max(320, origW + (ev.clientX - startX)),
      h: Math.max(220, origH + (ev.clientY - startY)),
    }));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const byCarrier = useMemo(() => {
    const map = new Map();
    boxLoops.forEach(entry => {
      const key = entry.loop.carrierCode || "—";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(entry);
    });
    return [...map.entries()];
  }, [boxLoops]);

  return (
    <div style={{
      position: "absolute", left: state.x, top: state.y, width: state.w,
      height: state.minimized ? "auto" : state.h, background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: 11, boxShadow: "0 18px 40px rgba(20,30,50,.20), 0 2px 8px rgba(20,30,50,.10)",
      overflow: "hidden", userSelect: "none", display: "flex", flexDirection: "column", zIndex: 5,
    }}>
      <div onMouseDown={startDrag} style={{
        display: "flex", alignItems: "center", gap: 8, padding: "8px 8px 8px 12px",
        background: T.surfaceHover, borderBottom: `1px solid ${T.border}`, cursor: "grab", flexShrink: 0,
      }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: T.accent, flexShrink: 0 }} />
        <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text, flex: 1 }}>
          {boxLoops.length} loop{boxLoops.length !== 1 ? "s" : ""} selected
        </span>
        <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600 }}>grouped by carrier</span>
        <button type="button" data-overlay-btn onClick={() => setState(s => ({ ...s, minimized: !s.minimized }))}
          style={{
            width: 22, height: 22, borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface,
            color: T.textMuted, fontSize: 13, lineHeight: 1, cursor: "pointer", display: "flex",
            alignItems: "center", justifyContent: "center", flexShrink: 0,
          }} title={state.minimized ? "Expand" : "Minimize"}>
          {state.minimized ? "▢" : "−"}
        </button>
      </div>

      {!state.minimized && (
        <div style={{ padding: "14px 14px 12px", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", flex: 1 }}>
          {byCarrier.map(([carrier, entries]) => (
            <div key={carrier} style={{ display: "flex", flexDirection: "column", gap: 10,
              borderTop: `1px solid ${T.border}`, paddingTop: 10, marginTop: -2 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: T.mono, fontSize: 10.5,
                fontWeight: 800, letterSpacing: "0.05em", color: T.textMuted }}>
                <span style={{ borderRadius: 6, padding: "2.5px 8px", color: "#fff", fontSize: 11.5,
                  fontWeight: 800, background: carrierColor(carrier) }}>{carrier}</span>
                {entries.length} loop{entries.length !== 1 ? "s" : ""}
              </div>
              {entries.map(({ loop, ports }) => (
                <div key={loop.id} onMouseEnter={() => onHoverLoop(loop.id)} onMouseLeave={() => onHoverLoop(null)}
                  style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>
                    <b style={{ color: T.text }}>{loop.code}</b> · {loop.name}
                  </div>
                  <Timeline ports={ports} />
                  <Timeline ports={ports} reversed accentColor={T.purple} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {!state.minimized && (
        <div onMouseDown={startResize} style={{
          position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize",
          background: `linear-gradient(135deg, transparent 50%, ${T.border} 50%, ${T.border} 62%, transparent 62%, transparent 74%, ${T.border} 74%, ${T.border} 86%, transparent 86%)`,
        }} />
      )}
    </div>
  );
};

const LoopMapExplorerPage = () => {
  const [loops, setLoops] = useState(null); // null = loading
  const [selected, setSelected] = useState(() => new Set());
  const [rotations, setRotations] = useState({}); // loopId -> resolved {ports:[...]}, fetched lazily
  const [search, setSearch] = useState("");
  const [hoverLoopId, setHoverLoopId] = useState(null);
  const [hoverPortId, setHoverPortId] = useState(null); // a single dot's own hover — independent of
  // hoverLoopId (which still drives the dim/highlight treatment) — with several ports on screen at
  // once, showing every label simultaneously was unreadable (real screenshot, 2026-09-05); a label
  // now only ever appears one at a time, for whichever specific dot the cursor is actually on.
  const { zoom, pan, svgRef, zoomBy, reset, dragging, handlers } = usePanZoom(W, H, { cursorAnchored: true });
  const [overlayBox, setOverlayBox] = useState({ x: 20, y: 20, w: 380, h: 420, minimized: false });

  useEffect(() => { api.loopCodes.list().then(setLoops).catch(() => setLoops([])); }, []);

  const filtered = useMemo(() => {
    if (!loops) return [];
    const q = search.trim().toLowerCase();
    if (!q) return loops;
    return loops.filter(l =>
      l.code.toLowerCase().includes(q) || l.name.toLowerCase().includes(q) ||
      (l.carrierCode || "").toLowerCase().includes(q));
  }, [loops, search]);

  const colorFor = (loopId) => {
    const idx = (loops || []).findIndex(l => l.id === loopId);
    return LOOP_COLORS[idx % LOOP_COLORS.length];
  };

  const toggleLoop = async (loop) => {
    const willSelect = !selected.has(loop.id);
    if (willSelect && selected.size >= OVERLAY_CAP) return; // cap enforced below via disabled checkboxes too
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(loop.id)) next.delete(loop.id); else next.add(loop.id);
      return next;
    });
    if (willSelect && !rotations[loop.id]) {
      try {
        const full = await api.loopCodes.get(loop.id);
        setRotations(prev => ({ ...prev, [loop.id]: full }));
      } catch { /* selection stays on; simply won't render until a retry */ }
    }
  };

  const selectAll = () => filtered
    .filter(l => l.portCount >= 2 && !selected.has(l.id))
    .slice(0, OVERLAY_CAP - selected.size)
    .forEach(toggleLoop);
  const clearAll = () => setSelected(new Set());

  const activeLoops = (loops || [])
    .filter(l => selected.has(l.id) && rotations[l.id])
    .map(l => ({ loop: l, ports: rotations[l.id].ports.filter(p => p.latitude != null && p.longitude != null) }))
    .filter(x => x.ports.length >= 2);

  // Unlike activeLoops above (lat/lng-filtered, for the map's own geographic drawing), the overlay
  // box's Timeline doesn't project ports geographically — it lays every stop out along a fixed
  // pill regardless of whether coordinates are known — so this uses the loop's full unfiltered
  // rotation instead, the same shape LoopRouteModal's own Timeline already consumes.
  const boxLoops = (loops || [])
    .filter(l => selected.has(l.id) && rotations[l.id])
    .map(l => ({ loop: l, ports: rotations[l.id].ports }))
    .filter(x => x.ports.length >= 2);

  if (loops === null) return <PageSpinner />;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Loop Map Explorer</h1>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
          {loops.length} registered loop{loops.length !== 1 ? "s" : ""} — pick as many as you want to compare on one map
        </p>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ width: 300, flexShrink: 0, background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 12, display: "flex", flexDirection: "column", height: 720 }}>
          <div style={{ padding: 12, borderBottom: `1px solid ${T.border}` }}>
            <Inp value={search} onChange={setSearch} placeholder="Search code, name, carrier..." />
            <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center" }}>
              <button type="button" onClick={selectAll} style={linkBtnStyle}>Select all</button>
              <button type="button" onClick={clearAll} style={linkBtnStyle}>Clear</button>
              <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                color: selected.size >= OVERLAY_CAP ? T.danger : T.textMuted }}>
                {selected.size} / {OVERLAY_CAP}
              </span>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 6 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 20, textAlign: "center", fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
                No loop codes match.
              </div>
            ) : filtered.map(loop => {
              const tooFew = loop.portCount < 2;
              const atCap = !tooFew && selected.size >= OVERLAY_CAP && !selected.has(loop.id);
              return (
                <LoopSidebarRow key={loop.id} loop={loop} color={colorFor(loop.id)}
                  checked={selected.has(loop.id)} disabled={tooFew || atCap}
                  disabledReason={tooFew ? "This loop has fewer than 2 registered ports — nothing to draw yet"
                    : atCap ? `Up to ${OVERLAY_CAP} loops at once — deselect one first` : undefined}
                  hovered={hoverLoopId === loop.id} onToggle={() => toggleLoop(loop)} onHover={setHoverLoopId} />
              );
            })}
          </div>
        </div>

        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} {...handlers} style={{ width: "100%", height: 720, display: "block",
            background: T.bg, border: `2px solid ${T.border}`, borderRadius: 12, boxSizing: "border-box",
            cursor: dragging ? "grabbing" : "grab", touchAction: "none", overflow: "hidden" }} role="img"
            aria-label={`World map showing ${activeLoops.length} selected loop${activeLoops.length !== 1 ? "s" : ""}`}>
            <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
              <path d={WORLD_LAND_PATH} fill={T.surface} stroke={T.border} strokeWidth={0.4} fillRule="evenodd" />
              {activeLoops.map(({ loop, ports }) => {
                const color = colorFor(loop.id);
                const pts = ports.map((p) => ({ ...p, xy: projectWorld(p.longitude, p.latitude) }));
                const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.xy[0]},${p.xy[1]}`).join(" ") + ` L${pts[0].xy[0]},${pts[0].xy[1]}`;
                const isHovered = hoverLoopId === loop.id;
                const dim = hoverLoopId && !isHovered;
                return (
                  <g key={loop.id} opacity={dim ? 0.3 : 1}>
                    <path d={d} fill="none" stroke={color} strokeWidth={isHovered ? 2 : 1.3} strokeLinecap="round" opacity={0.9} />
                    {pts.map(p => (
                      <circle key={p.id} cx={p.xy[0]} cy={p.xy[1]} r={hoverPortId === p.id ? 6.5 : (isHovered ? 5.5 : 4)}
                        fill="#fff" stroke={color} strokeWidth={2} style={{ cursor: "pointer" }}
                        onMouseEnter={() => setHoverPortId(p.id)} onMouseLeave={() => setHoverPortId(null)} />
                    ))}
                    {/* One label at a time, on a real per-dot hover — see PortHoverChip's own
                        comment above for why this replaced the old always-on-loop-hover labels. */}
                    {pts.filter(p => hoverPortId === p.id).map(p => (
                      <PortHoverChip key={`lbl-${p.id}`} x={p.xy[0]} y={p.xy[1]} code={p.portUnlocode} name={p.portName} />
                    ))}
                  </g>
                );
              })}
            </g>
          </svg>
          <ZoomControls zoom={zoom} onZoomIn={() => zoomBy(ZOOM_STEP)} onZoomOut={() => zoomBy(-ZOOM_STEP)} onReset={reset} />
          {boxLoops.length > 0 && (
            <LoopOverlayBox boxLoops={boxLoops} state={overlayBox} setState={setOverlayBox} onHoverLoop={setHoverLoopId} />
          )}
          {activeLoops.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, background: T.surface,
                border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 18px" }}>
                Select a loop from the list to show it on the map
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LoopMapExplorerPage;
