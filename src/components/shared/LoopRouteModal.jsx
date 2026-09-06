import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { Modal } from "../primitives/Modal";
import { PageSpinner } from "../primitives/Spinner";
import Btn from "../primitives/Btn";
import {
  LAND_POLYGONS, PortHoverChip, RotatedLabel, currentLegSpan, ringToPath, usePanZoom, ZoomControls,
} from "./mapCore";

// ─── Loop Route Modal ──────────────────────────────────────────────────────────
// Opened from ShipmentHeaderBar's Loop field. A shipment's loop is a plain derived string
// (src/utils/scheduleLoop.js's deriveLoopCode) with no FK into the loop_codes registry, so a
// miss is expected/normal — rendered as an honest "not registered yet" state, not an error.
// Shares its projection/decluttering/pan-zoom building blocks with the MDM Loop Map Explorer via
// ./mapCore — see that file's own header for why they're split out.

// Track is a thick rounded "pill" (rx = half its own height) with plain white port-call dots
// sitting on top of it — matches the carrier's own real Service Explorer markup (supplied live,
// 2026-09-04: a <rect rx="14" height="25"> + white <circle r="5"> dots), not a thin line with
// dots straddling it. Endpoint (hub) stops get the darker/bolder name-text treatment their own
// CSS gives `.port-name.connection-endpoint` — the dot/pill styling itself doesn't change,
// exactly like the reference (no separate "hub dot color", the emphasis lives in the label only).
export const Timeline = ({ ports: portsIn, polCode, podCode, reversed = false, accentColor }) => {
  const ports = reversed ? [...portsIn].reverse() : portsIn;
  const color = accentColor || T.accent;
  // Both bars show the exact same registered rotation — just read in opposite order — rather than
  // deriving two separate real "legs" from the ports' own geography (direct request, 2026-09-05:
  // no direction field exists anywhere in the data model, so anything fancier would be a guess).
  // The direction label is the one thing computed, from whichever order is actually on screen:
  // net decreasing longitude start-to-end reads as westbound, increasing as eastbound.
  const withLon = ports.filter(p => p.longitude != null);
  const dirLabel = withLon.length >= 2
    ? (withLon[withLon.length - 1].longitude < withLon[0].longitude ? "Westbound" : "Eastbound")
    : null;
  const n = ports.length;
  // marginX is generous specifically for the diagonal name label's own overhang, not just the dot
  // — every Timeline label reads left-to-right regardless of above/below (see RotatedLabel's
  // mirror=false note), so only the LAST stop's label has nowhere further right to run into
  // before hitting the canvas edge. A real long name ("Port of Bremerhaven") at this font size
  // needs on the order of 100-110px of horizontal room past its own anchor point — found live
  // (2026-09-04): the previous, tighter margin clipped "Port of Savannah" down to "Port of Sav".
  // H is sized to the real content, not derived as a round canvas number — measured live
  // (2026-09-05): actual content spans y=8 to y=162 (badge, diagonal labels, pill, day text), the
  // rest was dead space below it. trackY is a fixed constant rather than H/2 specifically so
  // shrinking H here doesn't also shift the pill/labels — they keep the exact vertical position
  // already proven not to clip against the direction badge above them.
  const W = 900, H = 180, marginX = 115, pillH = 26, trackY = 130;
  const step = n > 1 ? (W - 2 * marginX) / (n - 1) : 0;
  const y = trackY;
  const legHops = currentLegSpan(ports, polCode, podCode);
  const [hoverIdx, setHoverIdx] = useState(null);
  const clipId = "timeline-pill-clip";
  // Extends the pill's own rounded caps past the first/last dot rather than ending exactly at it,
  // so both end stops read as nested inside the bar (matching how every interior stop already
  // sits inside it) instead of sitting right at the tip — direct request, 2026-09-04. Sized to
  // clear the hovered-hub dot's own max radius (9) plus a real gap before the end-cap arrow
  // starts, not just a value that happened to look right unhovered — a smaller pad here caused
  // the end arrow to visibly overlap the last dot the moment it (or a hover ring) got close to it.
  const capPad = 34;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block",
      background: T.bg, borderRadius: 10 }} role="img"
      aria-label={`${dirLabel || "Rotation"}: ${ports.map(p => p.portUnlocode).join(" → ")}, back to ${ports[0]?.portUnlocode}`}>
      {dirLabel && (() => {
        const pillW = dirLabel.length * 7.2 + 40;
        return (
          <g transform={`translate(${marginX - capPad},8)`}>
            <rect x={0} y={0} width={pillW} height={22} rx={11} fill={color} />
            <text x={pillW / 2} y={11.5} textAnchor="middle" dominantBaseline="middle"
              fontFamily={T.body} fontSize={12} fontWeight={800}
              style={{ textTransform: "uppercase", letterSpacing: "0.04em" }} fill="#fff">{dirLabel}</text>
          </g>
        );
      })()}
      <defs>
        <clipPath id={clipId}>
          <rect x={marginX - capPad} y={y - pillH / 2} width={step * (n - 1) + capPad * 2} height={pillH} rx={pillH / 2} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {Array.from({ length: Math.max(n - 1, 0) }).map((_, i) => {
          const on = !legHops || legHops.has(i);
          const isFirst = i === 0, isLast = i === n - 2;
          const x = marginX + step * i - (isFirst ? capPad : 0);
          const width = step + 1 + (isFirst ? capPad : 0) + (isLast ? capPad : 0);
          return <rect key={i} x={x} y={y - pillH / 2} width={width} height={pillH}
            fill={on ? color : T.borderMid} />;
        })}
      </g>
      {/* Direction arrows at the midpoint between every consecutive pair of REAL stops only — one
          past the last stop would imply an (n+1)th hop that doesn't exist (found confusing live,
          2026-09-04), since the Timeline is linear and doesn't visually render the loop's actual
          close-the-circle hop back to the first port the way the Map does. The arrow always points
          toward whichever neighbor the vessel *actually* reaches later in real time — for the
          reversed (Eastbound) bar, real day-offsets decrease left to right, so the true direction
          of travel is backward relative to reading order (caught live, 2026-09-05: both bars were
          pointing the same way, which silently mislabeled the Eastbound one). */}
      {Array.from({ length: Math.max(n - 1, 0) }).map((_, i) => {
        const mx = marginX + step * (i + 0.5);
        const points = reversed
          ? `${mx - 7},${y} ${mx + 7},${y - 7} ${mx + 7},${y + 7}`
          : `${mx + 7},${y} ${mx - 7},${y - 7} ${mx - 7},${y + 7}`;
        return <polygon key={`arrow-${i}`} points={points} fill={T.bg} opacity={0.35} />;
      })}
      {ports.map((p, i) => {
        const cx = marginX + step * i;
        const isHub = p.portUnlocode === polCode || p.portUnlocode === podCode;
        const hovered = hoverIdx === i;
        return (
          <g key={`${p.portUnlocode}-${i}`} onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)}
            style={{ cursor: "pointer" }}>
            {hovered && <circle cx={cx} cy={y} r={(isHub ? 7.5 : 6) + 5} fill={T.text} opacity={0.18} />}
            <circle cx={cx} cy={y} r={(isHub ? 7.5 : 6) + (hovered ? 1.5 : 0)} fill="#fff" />
            <RotatedLabel x={cx} y={y - pillH / 2 - 10} above nameOnly
              mirror={false} fontScale={1.5} emphasis={isHub} hovered={hovered} hoverColor={color}
              code={p.portUnlocode} name={p.portName} textColor={T.text} mutedColor={T.textMuted} />
            {p.transitDayOffset != null && (
              <text x={cx} y={y + pillH / 2 + 16} textAnchor="middle"
                fontFamily={T.mono} fontSize={13} fill={T.textMuted}>Day {p.transitDayOffset}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// Real port_locations lat/lng (already joined server-side, routes/loop-codes.js's ROTATION_SQL),
// projected with a plain equirectangular grid — genuine relative geography, not a real map
// projection or real coastlines. Matches the carrier's own real Service Explorer reference
// (supplied live, 2026-09-04): real port positions, route drawn over them, diagonal labels
// fanning out from each stop. Diagonal labels are what actually make this legible — several of
// this loop's real ports (Rotterdam/Bremerhaven/Antwerp; New York/Norfolk/Charleston/Savannah)
// sit only a few degrees apart while the canvas has to span an entire ocean, so a flat horizontal
// label collided with its neighbor every time (confirmed live) — the same clustering the
// reference's own North European ports have, and the same technique it uses to stay readable.
const LoopMap = ({ ports, polCode, podCode }) => {
  const [hoverIdx, setHoverIdx] = useState(null);
  const [hoverSegIdx, setHoverSegIdx] = useState(null);
  const withCoords = ports.filter(p => p.latitude != null && p.longitude != null);
  const { zoom, pan, svgRef, zoomBy, reset, dragging, handlers } = usePanZoom(900, 460);
  if (withCoords.length < 2) {
    return (
      <div style={{ padding: 24, textAlign: "center", fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
        Not enough of this loop's ports have known coordinates to draw a map.
      </div>
    );
  }

  // Antimeridian handling: a naive min/max longitude spans ~360° for a trans-Pacific loop
  // (+170/-170 are 20° apart the short way, ~340° the naive way) — shifting negative longitudes
  // by +360 and taking whichever spread is smaller fixes that.
  const rawLons = withCoords.map(p => p.longitude);
  const naiveSpan = Math.max(...rawLons) - Math.min(...rawLons);
  const shiftedLons = rawLons.map(lon => (lon < 0 ? lon + 360 : lon));
  const shiftedSpan = Math.max(...shiftedLons) - Math.min(...shiftedLons);
  const useShifted = shiftedSpan < naiveSpan;
  const lons = useShifted ? shiftedLons : rawLons;
  const lats = withCoords.map(p => p.latitude);

  const W = 900, H = 460, pad = 130;
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lonSpan = Math.max(lonMax - lonMin, 2), latSpan = Math.max(latMax - latMin, 2);
  // Fit within the padded box on whichever axis is more constrained, so the aspect ratio stays
  // true to the real spread instead of stretching to fill the canvas.
  const scale = Math.min((W - 2 * pad) / lonSpan, (H - 2 * pad) / latSpan);
  const usedW = lonSpan * scale, usedH = latSpan * scale;
  const offX = (W - usedW) / 2, offY = (H - usedH) / 2;
  const project = (lon, lat) => {
    const adjLon = useShifted && lon < 0 ? lon + 360 : lon;
    return [offX + (adjLon - lonMin) * scale, offY + (latMax - lat) * scale]; // higher latitude = smaller y
  };

  // The route line and every dot are drawn at these TRUE projected positions and never move.
  // Labels no longer render inline alongside the dots at all (see the hover-chip block below), so
  // there's nothing left to declutter — a label anchor only ever needs to dodge a neighboring
  // label when several are visible at once, and now at most one ever is.
  const rawPoints = withCoords.map((p) => ({ ...p, xy: project(p.longitude, p.latitude) }));
  const legHops = currentLegSpan(withCoords, polCode, podCode);

  // Real landmass background, same equirectangular projection as the ports so coastlines line up
  // exactly with the route drawn over them. Only polygons falling anywhere within a generously
  // padded view of the loop's own bounding box are kept — the rest of the world's ~125 landmasses
  // are skipped rather than projected/rendered off-canvas for no visual benefit.
  const bboxPadLon = Math.max(lonSpan * 0.6, 15);
  const bboxPadLat = Math.max(latSpan * 0.6, 15);
  const viewLonMin = lonMin - bboxPadLon, viewLonMax = lonMax + bboxPadLon;
  const viewLatMin = latMin - bboxPadLat, viewLatMax = latMax + bboxPadLat;
  const inView = (lon, lat) => {
    const adjLon = useShifted && lon < 0 ? lon + 360 : lon;
    return adjLon >= viewLonMin && adjLon <= viewLonMax && lat >= viewLatMin && lat <= viewLatMax;
  };
  const landRingPaths = [];
  for (const polygon of LAND_POLYGONS) {
    for (const ring of polygon) {
      if (!ring.some(([lon, lat]) => inView(lon, lat))) continue;
      landRingPaths.push(ringToPath(ring, project, W));
    }
  }
  const landPathD = landRingPaths.join(" ");

  return (
    <div style={{ position: "relative" }}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} {...handlers} style={{ width: "100%", height: "auto", display: "block",
        background: T.bg, border: `2px solid ${T.border}`, borderRadius: 10, boxSizing: "border-box",
        cursor: dragging ? "grabbing" : "grab", touchAction: "none", overflow: "hidden" }} role="img"
        aria-label={`${withCoords.length}-port rotation map: ${withCoords.map(p => p.portUnlocode).join(" → ")}, back to ${withCoords[0].portUnlocode}`}>
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {landPathD && <path d={landPathD} fill={T.surface} stroke={T.border} strokeWidth={0.5} fillRule="evenodd" />}
          {rawPoints.map((p, i) => {
            const next = rawPoints[(i + 1) % rawPoints.length];
            const on = !legHops || legHops.has(i);
            const near = hoverIdx === i || hoverIdx === (i + 1) % rawPoints.length || hoverSegIdx === i;
            const d = `M${p.xy[0]},${p.xy[1]} L${next.xy[0]},${next.xy[1]}`;
            return (
              <g key={`seg-${p.id}`}>
                <path d={d} fill="none" stroke={on || near ? T.accent : T.borderMid} strokeWidth={on || near ? 2 : 1.3}
                  strokeLinecap="round" opacity={on || near ? 0.95 : 0.55} />
                {/* Invisible wide hitbox layered over the thin visible line — a real, much easier
                    hover/click target than the 2-3px stroke alone (found in the carrier's own real
                    route-line markup, supplied live 2026-09-04: they pair every visible
                    `.segment-path` with its own `.segment-path-hitbox`, ~10x the stroke width). */}
                <path d={d} fill="none" stroke="transparent" strokeWidth={16} style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHoverSegIdx(i)} onMouseLeave={() => setHoverSegIdx(null)} />
              </g>
            );
          })}
          {rawPoints.map((p, i) => {
            const next = rawPoints[(i + 1) % rawPoints.length];
            const midX = (p.xy[0] + next.xy[0]) / 2, midY = (p.xy[1] + next.xy[1]) / 2;
            const angle = Math.atan2(next.xy[1] - p.xy[1], next.xy[0] - p.xy[0]) * 180 / Math.PI;
            const on = !legHops || legHops.has(i);
            const near = hoverIdx === i || hoverIdx === (i + 1) % rawPoints.length || hoverSegIdx === i;
            return (
              <polygon key={`arrow-${p.id}`} transform={`translate(${midX},${midY}) rotate(${angle})`}
                points="-6,-5 6,0 -6,5" fill={on || near ? T.accent : T.borderMid} opacity={on || near ? 0.95 : 0.55} />
            );
          })}
          {rawPoints.map((p, i) => {
            const isHub = p.portUnlocode === polCode || p.portUnlocode === podCode;
            const hovered = hoverIdx === i;
            const r = (isHub ? 7.5 : 6) + (hovered ? 1.5 : 0);
            return (
              <g key={`dot-${p.id}`} onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)}
                style={{ cursor: "pointer" }}>
                {hovered && <circle cx={p.xy[0]} cy={p.xy[1]} r={r + 5} fill={T.text} opacity={0.18} />}
                <circle cx={p.xy[0]} cy={p.xy[1]} r={r} fill="#fff" stroke={T.bg} strokeWidth={2} />
              </g>
            );
          })}
          {rawPoints.filter((p, i) => hoverIdx === i).map(p => (
            <PortHoverChip key={`label-${p.id}`} x={p.xy[0]} y={p.xy[1]} code={p.portUnlocode} name={p.portName} />
          ))}
        </g>
      </svg>
      <ZoomControls zoom={zoom} onZoomIn={() => zoomBy(ZOOM_STEP)} onZoomOut={() => zoomBy(-ZOOM_STEP)} onReset={reset} />
    </div>
  );
};

const LoopRouteModal = ({ code, polCode, podCode, onClose }) => {
  const [showMap, setShowMap] = useState(false);
  const [loop, setLoop] = useState(undefined); // undefined = loading, null = not found

  useEffect(() => {
    let live = true;
    api.loopCodes.resolve(code).then(r => { if (live) setLoop(r); }).catch(() => { if (live) setLoop(null); });
    return () => { live = false; };
  }, [code]);

  const currentLeg = loop && polCode && podCode
    ? loop.ports.find(p => p.portUnlocode === polCode)?.portName && loop.ports.find(p => p.portUnlocode === podCode)?.portName
      ? `${loop.ports.find(p => p.portUnlocode === polCode).portName} → ${loop.ports.find(p => p.portUnlocode === podCode).portName}`
      : null
    : null;

  return (
    <Modal title={`Loop ${code}`} onClose={onClose} width={860} data-testid="loop-route-modal">
      {loop === undefined ? (
        <PageSpinner />
      ) : loop === null ? (
        <div style={{ padding: "24px 4px", textAlign: "center" }}>
          <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.textMuted, lineHeight: 1.6 }}>
            No route data registered for loop <span style={{ fontFamily: T.mono, color: T.accent }}>{code}</span>.
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 6 }}>
            An admin can register it under Master Data → Loop Codes.
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
            <div>
              <span style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.text }}>{loop.code}</span>
              <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginLeft: 10 }}>
                {loop.name}{loop.carrierCode ? ` · ${loop.carrierCode}` : ""}
              </span>
            </div>
            <div style={{ display: "flex", gap: 18 }}>
              <div>
                <div style={{ fontFamily: T.body, fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: T.textMuted }}>Rotation</div>
                <div style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>{loop.ports.length} ports</div>
              </div>
              {loop.roundTripDays != null && (
                <div>
                  <div style={{ fontFamily: T.body, fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: T.textMuted }}>Round Trip</div>
                  <div style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 600 }}>{loop.roundTripDays}d</div>
                </div>
              )}
              {loop.frequencyDays != null && (
                <div>
                  <div style={{ fontFamily: T.body, fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: T.textMuted }}>Frequency</div>
                  <div style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>Every {loop.frequencyDays}d</div>
                </div>
              )}
            </div>
          </div>

          {loop.ports.length < 2 ? (
            <div style={{ padding: 24, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
              This loop has no rotation configured yet.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Timeline ports={loop.ports} polCode={polCode} podCode={podCode} />
              <Timeline ports={loop.ports} polCode={polCode} podCode={podCode} reversed accentColor={T.purple} />
            </div>
          )}

          {loop.ports.length >= 2 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
              marginTop: 12, gap: 10, flexWrap: "wrap" }}>
              {currentLeg ? (
                <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                  This shipment rides the <span style={{ color: T.text, fontWeight: 600 }}>{currentLeg}</span> leg.
                </div>
              ) : <div />}
              <Btn variant="ghost" size="sm" onClick={() => setShowMap(v => !v)}>
                {showMap ? "Hide map ↑" : "Show on map ↓"}
              </Btn>
            </div>
          )}

          {showMap && loop.ports.length >= 2 && (
            <div style={{ marginTop: 12 }}>
              <LoopMap ports={loop.ports} polCode={polCode} podCode={podCode} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default LoopRouteModal;
