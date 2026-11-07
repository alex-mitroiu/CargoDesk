import { useEffect, useRef } from "react";
import { HZ } from "../shipmentDetailTheme";

// ─── Dotted route globe (Trade Horizon, next — Contracts & Schedules, 2026-11-06, mockup 402fb5b5) ─────
// A small, static canvas: ~9,000 Fibonacci-sphere dots, brighter on land, with the route drawn as great-circle
// arcs between the leg ports and, on a sea leg under way, the vessel's position by elapsed days. Drawn once per
// change (no animation loop, no WebGL); redrawn on resize and when the theme flips (the colours are HZ tokens).
// The land mask is a handful of coarse continent outlines — enough for a sense of place at this size.
//
// Props: stops — [{ code, lat, lon }] in route order (codes without coordinates are skipped);
//        position — { from, to, fraction } for the vessel dot, or null; size — the CSS width cap.
const LAND = [
  [[-168, 66], [-160, 70], [-140, 70], [-125, 70], [-95, 72], [-82, 69], [-62, 60], [-56, 52], [-66, 45], [-70, 42], [-76, 35], [-81, 31], [-80, 25], [-83, 29], [-90, 29], [-97, 26], [-97, 21], [-92, 18], [-88, 21], [-87, 15], [-83, 10], [-79, 9], [-82, 8], [-86, 12], [-92, 15], [-105, 20], [-110, 24], [-112, 30], [-117, 32], [-121, 35], [-124, 40], [-124, 48], [-135, 58], [-150, 60], [-165, 60]],
  [[-52, 60], [-44, 60], [-20, 70], [-20, 82], [-60, 82], [-70, 76], [-55, 68]],
  [[-80, 10], [-72, 12], [-62, 10], [-52, 5], [-35, -5], [-39, -15], [-48, -26], [-58, -38], [-65, -42], [-68, -52], [-74, -50], [-73, -38], [-71, -20], [-76, -14], [-81, -5], [-79, 2]],
  [[-10, 36], [-9, 43], [-2, 47], [-5, 48], [2, 51], [5, 53], [8, 55], [10, 58], [5, 62], [15, 69], [28, 71], [40, 67], [60, 70], [80, 73], [110, 76], [140, 72], [170, 69], [180, 66], [160, 60], [142, 52], [135, 43], [128, 39], [122, 31], [120, 23], [110, 20], [106, 10], [100, 13], [98, 8], [94, 16], [90, 22], [80, 15], [77, 8], [73, 20], [67, 25], [57, 25], [52, 27], [48, 30], [44, 38], [36, 36], [30, 41], [28, 41], [22, 37], [15, 38], [8, 44], [3, 43], [-2, 37]],
  [[-6, 50], [-3, 58], [-6, 58], [-5, 54], [-3, 52]],
  [[-17, 21], [-10, 30], [-5, 36], [10, 37], [20, 32], [32, 31], [35, 28], [43, 12], [51, 12], [40, -5], [40, -15], [35, -25], [20, -35], [15, -28], [12, -15], [9, -1], [9, 4], [-8, 4], [-17, 14]],
  [[35, 30], [44, 30], [56, 25], [59, 22], [52, 16], [43, 13], [37, 22]],
  [[114, -22], [122, -18], [132, -12], [142, -11], [146, -19], [153, -26], [150, -37], [140, -38], [131, -32], [118, -35], [114, -28]],
  [[130, 31], [134, 34], [140, 36], [142, 41], [140, 43], [136, 36], [130, 33]],
  [[-85, 23], [-77, 20], [-74, 19], [-80, 22]],
];
const inPoly = (lon, lat, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
};
let POINTS = null;
const points = () => {
  if (POINTS) return POINTS;
  POINTS = [];
  const N = 9000, ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - 2 * (i + 0.5) / N, r = Math.sqrt(1 - y * y), th = ga * i;
    const lat = Math.asin(y) * 180 / Math.PI, lon = Math.atan2(Math.sin(th) * r, Math.cos(th) * r) * 180 / Math.PI;
    POINTS.push([lat, lon, LAND.some(p => inPoly(lon, lat, p))]);
  }
  return POINTS;
};
const F = Math.PI / 180;
const proj = (lat, lon, c0, l0, r) => {
  const p = lat * F, dl = (lon - l0) * F, p0 = c0 * F;
  return { x: Math.cos(p) * Math.sin(dl) * r, y: (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl)) * r,
    z: Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl) };
};
const vec = ([lat, lon]) => [Math.cos(lat * F) * Math.cos(lon * F), Math.cos(lat * F) * Math.sin(lon * F), Math.sin(lat * F)];
// A point on the great circle from A to B at t (0..1), as [lat, lon].
const slerp = (A, B, t) => {
  const u = vec(A), w = vec(B), om = Math.acos(Math.max(-1, Math.min(1, u[0] * w[0] + u[1] * w[1] + u[2] * w[2])));
  if (om < 1e-6) return { at: A, om };
  const k1 = Math.sin((1 - t) * om) / Math.sin(om), k2 = Math.sin(t * om) / Math.sin(om);
  const X = k1 * u[0] + k2 * w[0], Y = k1 * u[1] + k2 * w[1], Z = k1 * u[2] + k2 * w[2];
  return { at: [Math.asin(Z) / F, Math.atan2(Y, X) / F], om };
};
// Where to look from: the mean of the stops (as vectors), tilted a little north, so the whole route faces us.
const centreOf = stops => {
  if (!stops.length) return [30, 10];
  let x = 0, y = 0, z = 0;
  for (const s of stops) { const v = vec([s.lat, s.lon]); x += v[0]; y += v[1]; z += v[2]; }
  const lat = Math.atan2(z, Math.hypot(x, y)) / F, lon = Math.atan2(y, x) / F;
  return [Math.max(-45, Math.min(55, lat + 6)), lon];
};

const draw = (cv, stops, position, emptyLabel, dashed) => {
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth || 300;
  cv.width = W * dpr; cv.height = W * dpr;
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, W);
  const R = W * 0.42, cx = W / 2, cy = W / 2;
  const [c0, l0] = centreOf(stops);
  const halo = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.18);
  halo.addColorStop(0, "rgba(0,0,0,0)"); halo.addColorStop(0.86, HZ.glow); halo.addColorStop(1, "rgba(0,0,0,0)");
  g.globalAlpha = 0.35; g.fillStyle = halo; g.beginPath(); g.arc(cx, cy, R * 1.18, 0, 7); g.fill(); g.globalAlpha = 1;
  g.strokeStyle = HZ.globeRim; g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke();
  for (const [lat, lon, land] of points()) {
    const q = proj(lat, lon, c0, l0, R);
    if (q.z <= 0) continue;
    g.globalAlpha = land ? 0.45 + 0.55 * q.z : 0.12 + 0.45 * q.z;
    g.fillStyle = land ? HZ.globeOn : HZ.globeOff;
    const sz = (land ? 1.55 : 0.9) * (0.55 + 0.5 * q.z) * (W / 300);
    g.fillRect(cx + q.x - sz / 2, cy - q.y - sz / 2, sz, sz);
  }
  g.globalAlpha = 1;
  if (!stops.length || dashed) {
    g.fillStyle = HZ.textMuted; g.font = "600 10px 'IBM Plex Mono', monospace"; g.textAlign = "center";
    g.fillText(emptyLabel, cx, cy + R * 0.62);
    if (!stops.length) return;
  }
  // The lane, leg by leg (dashed and without glow when it is only the shipment's ports, no legs yet).
  g.lineWidth = 2; g.strokeStyle = HZ.globeArc; g.shadowColor = HZ.globeArc; g.shadowBlur = 10; g.lineCap = "round";
  if (dashed) { g.strokeStyle = HZ.textMuted; g.shadowBlur = 0; g.lineWidth = 1.6; g.setLineDash([3, 5]); }
  for (let a = 0; a < stops.length - 1; a++) {
    const A = [stops[a].lat, stops[a].lon], B = [stops[a + 1].lat, stops[a + 1].lon];
    const { om } = slerp(A, B, 0.5);
    if (om < 0.003) continue;
    g.beginPath(); let started = false;
    for (let t = 0; t <= 1.0001; t += 1 / 48) {
      const { at } = slerp(A, B, t);
      const lift = 1 + 0.1 * Math.sin(Math.PI * t) * Math.min(1, om);
      const q = proj(at[0], at[1], c0, l0, R * lift);
      if (proj(at[0], at[1], c0, l0, R).z <= 0) { started = false; continue; }
      if (!started) { g.moveTo(cx + q.x, cy - q.y); started = true; } else g.lineTo(cx + q.x, cy - q.y);
    }
    g.stroke();
  }
  g.shadowBlur = 0; g.setLineDash([]);
  // Ports, with labels pointing outward; ports that sit on top of each other share one label.
  const placed = [];
  for (const s of stops) {
    const q = proj(s.lat, s.lon, c0, l0, R);
    if (q.z <= 0) continue;
    const x = cx + q.x, y = cy - q.y;
    g.fillStyle = dashed ? HZ.textMuted : HZ.globeArc; g.shadowColor = HZ.globeArc; g.shadowBlur = dashed ? 0 : 12;
    g.beginPath(); g.arc(x, y, 3.6, 0, 7); g.fill(); g.shadowBlur = 0;
    g.lineWidth = 1.5; g.strokeStyle = HZ.text; g.beginPath(); g.arc(x, y, 5.6, 0, 7); g.stroke();
    const near = placed.find(p => Math.hypot(p.x - x, p.y - y) < 16);
    if (near) { if (!near.codes.includes(s.code)) near.codes.push(s.code); } else placed.push({ x, y, codes: [s.code] });
  }
  g.fillStyle = HZ.text; g.font = `700 ${W < 260 ? 9 : 10.5}px 'IBM Plex Mono', monospace`;
  for (const p of placed) {
    const right = p.x >= cx;
    g.textAlign = right ? "left" : "right";
    g.fillText(p.codes.join(" · "), p.x + (right ? 10 : -10), p.y + (p.y < cy ? -6 : 12));
  }
  // The vessel, on the leg it is sailing.
  if (position) {
    const { at, om } = slerp([position.from.lat, position.from.lon], [position.to.lat, position.to.lon], position.fraction);
    const lift = 1 + 0.1 * Math.sin(Math.PI * position.fraction) * Math.min(1, om);
    const q = proj(at[0], at[1], c0, l0, R * lift);
    if (q.z > 0) {
      g.fillStyle = HZ.text; g.shadowColor = HZ.globeArc; g.shadowBlur = 14;
      g.beginPath(); g.arc(cx + q.x, cy - q.y, 4.2, 0, 7); g.fill(); g.shadowBlur = 0;
      if (position.label && !placed.some(p => Math.hypot(p.x - (cx + q.x), p.y - (cy - q.y)) < 46)) {
        g.fillStyle = HZ.textMuted; g.font = "600 9.5px 'IBM Plex Mono', monospace"; g.textAlign = "center";
        g.fillText(position.label, cx + q.x + 4, cy - q.y + 18);
      }
    }
  }
};

const RouteGlobe = ({ stops = [], position = null, size = 320, emptyLabel = "no ports yet", dashed = false, label }) => {
  const ref = useRef(null);
  const drawable = stops.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  const key = JSON.stringify([drawable, position, emptyLabel, dashed]);
  // HZ.globeArc changes with the theme; reading it here redraws on a theme switch (the page re-renders then).
  const themeKey = HZ.globeArc + HZ.globeOn;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const run = () => draw(cv, drawable, position, emptyLabel, dashed);
    run();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(run) : null;
    ro?.observe(cv);
    return () => ro?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, themeKey]);
  return (
    <canvas ref={ref} role="img" data-testid="route-globe"
      aria-label={label || (drawable.length ? `Globe showing the route ${drawable.map(s => s.code).join(" to ")}` : "Globe with no route on it yet")}
      style={{ width: "100%", maxWidth: size, aspectRatio: "1 / 1", display: "block", margin: "0 auto" }} />
  );
};

export default RouteGlobe;
