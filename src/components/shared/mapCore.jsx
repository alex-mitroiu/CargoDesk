import { useState, useRef } from "react";
import { feature } from "topojson-client";
import landTopology from "world-atlas/land-110m.json";
import { T } from "../../tokens";

// ─── Shared map building blocks ────────────────────────────────────────────────
// Extracted out of LoopRouteModal.jsx (2026-09-04) once a second consumer needed the same
// projection/decluttering/pan-zoom machinery — the MDM Loop Map Explorer, which shows many
// carriers' loops on one world-spanning map rather than one loop zoomed to its own bounding box.
// Both call sites build their own `project(lon,lat)` function and their own landmass-polygon
// filtering (a tight per-loop bbox for the modal, the whole world for the explorer) — only the
// pieces that don't depend on which projection is in play live here.

// Real landmass outlines (Natural Earth 110m resolution via world-atlas/topojson-client — public
// domain map data, not hand-drawn/guessed coastlines). Parsed once at module load; every consumer
// reuses the same polygons regardless of its own projection.
export const LAND_POLYGONS = feature(landTopology, landTopology.objects.land).features[0].geometry.coordinates;

// Builds one SVG path for a land-ring's [lon,lat] points, breaking into a new subpath (M) instead
// of drawing a straight connecting line (L) wherever two consecutive points cross the antimeridian
// — a real coastline near +/-180deg longitude (e.g. Russia's Far East, Alaska), which a naive
// projection would otherwise draw as a spurious straight line spanning nearly the full map width.
// Detected on the PROJECTED x jump, not the raw longitude delta, so it works regardless of a
// caller's own lon-shifting logic (LoopMap's useShifted) — a real coastline segment between two
// adjacent polygon points never legitimately jumps anywhere near half the map's own width.
export function ringToPath(ring, project, W) {
  let d = "", prevX = null;
  ring.forEach(([lon, lat], i) => {
    const [x, y] = project(lon, lat);
    const breaks = prevX !== null && Math.abs(x - prevX) > W / 2;
    d += (i === 0 || breaks ? "M" : "L") + `${x.toFixed(1)},${y.toFixed(1)} `;
    prevX = x;
  });
  return d + "Z";
}

// Diagonal, alternating-side labels — matches the carrier's own real Service Explorer reference
// (supplied live, 2026-09-04): rotated text reads outward from each stop at a fixed angle rather
// than sitting flat above/below it, so tightly-spaced stops still stay legible without needing
// extra vertical room per label. Code and resolved name stack as two lines (code, then name
// directly under it) rather than running side-by-side along the same diagonal — direct fix for a
// real overlap found live once fonts got bigger: two lines stacked perpendicular to the diagonal
// take roughly half the along-the-diagonal footprint of the same two strings concatenated in a row.
//
// `mirror` controls which horizontal direction a "below" label reads. A 2D cluster (mirror=true)
// fans labels radially — above reads up-right, below reads down-LEFT, a true mirror through the
// anchor — the right behavior when neighbors can be in any compass direction. A strictly linear
// layout (mirror=false, e.g. the shipment modal's Timeline strip) reads every label — above or
// below — the same left-to-right direction, since a mirrored "below" label there would run
// backward straight into the PREVIOUS point's own space.
const LABEL_ANGLE = 42;
// `hovered` + `hoverColor` reproduce a specific real behavior from the carrier's own interactive
// map CSS (supplied live, 2026-09-04): `.port-name:hover { fill: var(--color-orange-500) }`, plus
// a real size bump (their map differentiates `.transshipment-port` at 12px from
// `.connection-endpoint` at 14px vs. an implicit smaller default) — a hovered stop's label both
// grows and switches to the accent color, layered independently of `emphasis` (which is the
// hub/endpoint distinction, not a hover state).
export const RotatedLabel = ({ x, y, above, code, name, textColor, mutedColor, mirror = true, fontScale = 1, emphasis = false, hovered = false, hoverColor, nameOnly = false }) => {
  const flip = mirror && !above;
  const angle = (above ? -LABEL_ANGLE : LABEL_ANGLE);
  const xSign = flip ? -1 : 1;
  const anchorSide = flip ? "end" : "start";
  const lineGap = 11.5 * fontScale;
  const useHoverColor = hovered && hoverColor;
  const codeColor = useHoverColor ? hoverColor : textColor;
  const nameColor = useHoverColor ? hoverColor : (emphasis ? textColor : mutedColor);
  const sizeBump = hovered ? 1.15 : 1;
  // nameOnly: a single centered line (no code, no second line offset) — used where the code
  // (the UN/LOCODE) would be redundant with what's already shown elsewhere on the same view.
  if (nameOnly) {
    return (
      <g transform={`translate(${x},${y}) rotate(${angle})`}>
        <text x={10 * xSign} y={0} textAnchor={anchorSide} dominantBaseline="middle"
          fontFamily={T.body} fontSize={9.5 * fontScale * sizeBump} fontWeight={emphasis ? 900 : 700}
          style={{ textTransform: "uppercase" }} fill={nameColor}>{stripPortPrefix(name)}</text>
      </g>
    );
  }
  return (
    <g transform={`translate(${x},${y}) rotate(${angle})`}>
      <text x={10 * xSign} y={0} textAnchor={anchorSide} dominantBaseline="middle"
        fontFamily={T.mono} fontSize={11 * fontScale * sizeBump} fontWeight={700} fill={codeColor}>{code}</text>
      <text x={10 * xSign} y={lineGap} textAnchor={anchorSide} dominantBaseline="middle"
        fontFamily={T.body} fontSize={8.5 * fontScale * sizeBump} fontWeight={emphasis ? 900 : 700}
        style={{ textTransform: "uppercase" }} fill={nameColor}>{name}</text>
    </g>
  );
};

// Real registry names carry a "Port of " prefix (e.g. "Port of Norfolk") — genuine UN/LOCODE data,
// left completely untouched at the source; this only trims it for display on a map label.
export const stripPortPrefix = (name) => (name || "").replace(/^Port of\s+/i, "");

// Horizontal, single-line hover chip — the shared standard both map views use for a per-dot hover
// label (2026-09-05): show exactly one label at a time, only on a real hover, rather than every
// port's label always on screen. Started on the MDM Loop Map Explorer specifically because several
// loops' full rotations on screen at once made the older always-visible diagonal labels genuinely
// unreadable (a real screenshot proved it); brought over to the shipment-level LoopMap afterward so
// both views share one implementation instead of two diverging ones.
export const PortHoverChip = ({ x, y, code, name }) => {
  const label = `${code} · ${stripPortPrefix(name)}`;
  const w = label.length * 6.4 + 18;
  return (
    <g transform={`translate(${x},${y - 16})`} style={{ pointerEvents: "none" }}>
      <rect x={-w / 2} y={-11} width={w} height={22} rx={6} fill="#4a90d9" />
      <text x={0} y={0.5} textAnchor="middle" dominantBaseline="middle"
        fontFamily={T.body} fontSize={11} fontWeight={700} fill="#fff">{label}</text>
    </g>
  );
};

// Which hops of a rotation belong to a specific POL/POD span, so a view can mute the rest of the
// rotation and pull the relevant span forward. Walks forward from the POL's index to the POD's
// index, wrapping past the end of the array if the POD sits earlier in the rotation than the POL
// (the loop closing back on itself) — hop index i means the segment from ports[i] to
// ports[(i+1) % n]. Returns null (every hop treated as "relevant") when either port isn't
// actually in this loop's own registry, so an unrelated/unmatched shipment still renders the
// full rotation at full strength rather than looking broken with nothing highlighted at all.
export function currentLegSpan(ports, polCode, podCode) {
  const polIdx = ports.findIndex(p => p.portUnlocode === polCode);
  const podIdx = ports.findIndex(p => p.portUnlocode === podCode);
  if (polIdx === -1 || podIdx === -1 || polIdx === podIdx) return null;
  const n = ports.length;
  const hops = new Set();
  for (let i = polIdx; i !== podIdx; i = (i + 1) % n) hops.add(i);
  return hops;
}

// Pan/zoom for an SVG map. `cursorAnchored` (the MDM Loop Map Explorer, a full standalone world
// map) keeps whatever point is under the mouse fixed while the wheel zooms, like a real map
// product; the default center-anchored mode (the shipment modal's single-loop map, already tightly
// framed to that loop's own bounding box) just keeps the middle of the current view roughly where
// it was on a button click — simpler, and there's no meaningful "point under the cursor" concept
// worth preserving on a map that's already zoomed to fit one small loop.
export const ZOOM_MIN = 1, ZOOM_MAX = 6, ZOOM_STEP = 0.35;
// At zoom z, the viewport shows a (W/z, H/z)-sized window of the canvas starting at world
// coordinate (-pan.x/z, -pan.y/z) — clamping that window to stay within the canvas's own 0..W /
// 0..H bounds is what stops panning past the edge into empty space (found live, 2026-09-04: with
// no clamp, dragging vertically had nothing stopping it, scrolling the whole map clean out of
// view with no way back short of the reset button). Collapses to exactly {0,0} at zoom=1, since
// the full canvas already fills the viewport with nothing left to pan.
function clampPan(p, z, W, H) {
  return { x: Math.min(0, Math.max(-W * (z - 1), p.x)), y: Math.min(0, Math.max(-H * (z - 1), p.y)) };
}
export function usePanZoom(W, H, { cursorAnchored = false } = {}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const svgRef = useRef(null);
  const dragRef = useRef(null);

  // zoomBy/zoomAt read the current `zoom`/`pan` state directly (closed over from this render)
  // and call setZoom/setPan once each, synchronously — deliberately NOT a functional updater with
  // a setPan(...) side effect nested inside it. React (StrictMode, in dev) double-invokes a
  // functional updater to check it's pure; a setPan call nested inside setZoom's updater fires
  // on both invocations, and since setPan there was ALSO a functional updater, the second firing
  // built on the first firing's already-shifted pan instead of the real starting pan — a real bug
  // that was live here, compounding on repeated zooms (found live, 2026-09-05).
  const zoomBy = (delta) => {
    const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + delta));
    if (nz === zoom) return;
    setZoom(nz);
    setPan(clampPan({ x: pan.x - (W / 2) * (nz - zoom), y: pan.y - (H / 2) * (nz - zoom) }, nz, W, H));
  };
  const zoomAt = (delta, clientX, clientY) => {
    if (!svgRef.current) return zoomBy(delta);
    const rect = svgRef.current.getBoundingClientRect();
    // The box isn't always at the viewBox's own W:H ratio (a narrower window leaves less room
    // once the sidebar is subtracted) — the SVG's default preserveAspectRatio letterboxes rather
    // than stretching, so the real conversion needs the one uniform scale it actually applied,
    // plus whichever axis got the centering offset, not a naive per-axis rect.width/height ratio.
    const scale = Math.min(rect.width / W, rect.height / H);
    const offsetX = (rect.width - W * scale) / 2;
    const offsetY = (rect.height - H * scale) / 2;
    const svgX = (clientX - rect.left - offsetX) / scale;
    const svgY = (clientY - rect.top - offsetY) / scale;
    const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + delta));
    if (nz === zoom) return;
    const worldX = (svgX - pan.x) / zoom, worldY = (svgY - pan.y) / zoom;
    setZoom(nz);
    setPan(clampPan({ x: svgX - worldX * nz, y: svgY - worldY * nz }, nz, W, H));
  };
  const onWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
    if (cursorAnchored) zoomAt(delta, e.clientX, e.clientY); else zoomBy(delta);
  };
  const onPointerDown = (e) => { dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y }; setDragging(true); };
  const onPointerMove = (e) => {
    if (!dragRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scale = Math.min(rect.width / W, rect.height / H);
    const unitsPerPx = (1 / scale) / zoom;
    setPan(clampPan({
      x: dragRef.current.panX + (e.clientX - dragRef.current.startX) * unitsPerPx,
      y: dragRef.current.panY + (e.clientY - dragRef.current.startY) * unitsPerPx,
    }, zoom, W, H));
  };
  const onPointerUp = () => { dragRef.current = null; setDragging(false); };
  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  return { zoom, pan, svgRef, zoomBy, zoomAt, reset, dragging,
    handlers: { onWheel, onMouseDown: onPointerDown, onMouseMove: onPointerMove, onMouseUp: onPointerUp, onMouseLeave: onPointerUp } };
}

// Small square icon buttons overlaid top-right of the map, mirroring the reference's own
// `.control-buttons`/`.zoom-buttons` placement and disabled-at-limit styling.
export const ZoomControls = ({ zoom, onZoomIn, onZoomOut, onReset }) => (
  <div style={{ position: "absolute", top: 10, right: 10, display: "flex", flexDirection: "column", gap: 6 }}>
    {[
      { label: "+", onClick: onZoomIn, disabled: zoom >= ZOOM_MAX },
      { label: "−", onClick: onZoomOut, disabled: zoom <= ZOOM_MIN },
      { label: "⤾", onClick: onReset, disabled: zoom === 1 },
    ].map((b, i) => (
      <button key={i} type="button" onClick={b.onClick} disabled={b.disabled} title={b.label === "⤾" ? "Reset view" : undefined}
        style={{
          width: 26, height: 26, borderRadius: 6, border: `1px solid ${T.border}`,
          background: T.surface, color: b.disabled ? T.border : T.text, fontFamily: T.body,
          fontSize: 15, fontWeight: 700, lineHeight: 1, cursor: b.disabled ? "default" : "pointer",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        }}>{b.label}</button>
    ))}
  </div>
);
