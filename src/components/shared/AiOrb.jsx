/**
 * AiOrb — four selectable indicator designs for the AI agent.
 * Exported as a named component so both CommandCenterView and AppSettingsPage
 * can render live previews without duplicating code.
 *
 * Style preference is persisted to localStorage under "cc_orb_style".
 */

// ─── Palette (always-dark — orb looks wrong on light backgrounds) ─────────────
const CC   = "#f97316";
const CC2  = "#fb923c";
const BD   = "#0e1f35";

// ─── CSS keyframes injected once ─────────────────────────────────────────────
const ORB_CSS = `
@keyframes orb-cw   { to { transform: rotate(360deg);  } }
@keyframes orb-ccw  { to { transform: rotate(-360deg); } }
@keyframes orb-pulse {
  0%,100% { box-shadow: 0 0 14px 6px rgba(249,115,22,.45), 0 0 36px 14px rgba(249,115,22,.18); }
  50%     { box-shadow: 0 0 28px 12px rgba(249,115,22,.72), 0 0 64px 26px rgba(249,115,22,.32); }
}
@keyframes orb-sonar-ping {
  0%   { transform: scale(0.06); opacity: 1;   }
  65%  { opacity: 0.45; }
  100% { transform: scale(1);    opacity: 0;   }
}
@keyframes orb-sonar-sweep {
  to { transform: rotate(360deg); }
}
`;
let _orbInjected = false;
function ensureOrbStyles() {
  if (_orbInjected) return;
  const s = document.createElement("style");
  s.textContent = ORB_CSS;
  document.head.appendChild(s);
  _orbInjected = true;
}

// ─── Design 1: Rings ──────────────────────────────────────────────────────────
// Three concentric border-only rings, each with a glowing orbital dot.
function OrbRings({ size }) {
  const rings = [
    { sz: size,       spd: "11s",  dir: "orb-cw",  op: 0.22 },
    { sz: size * .72, spd: "6.5s", dir: "orb-ccw", op: 0.48 },
    { sz: size * .44, spd: "3.2s", dir: "orb-cw",  op: 0.85 },
  ];
  const d = sz => Math.max(3, Math.round(sz * 0.058));
  return (
    <div style={{ position:"relative", width:size, height:size }}>
      {rings.map((r, i) => (
        <div key={i} style={{
          position:"absolute",
          width:r.sz, height:r.sz,
          top:"50%", left:"50%",
          marginTop:-r.sz/2, marginLeft:-r.sz/2,
          borderRadius:"50%",
          border:`${1.5 + i * 0.5}px solid ${CC}`,
          opacity:r.op,
          animation:`${r.dir} ${r.spd} linear infinite`,
        }}>
          <div style={{
            position:"absolute",
            top:-d(r.sz), left:"50%", marginLeft:-d(r.sz),
            width:d(r.sz)*2, height:d(r.sz)*2,
            borderRadius:"50%",
            background:CC2,
            boxShadow:`0 0 ${d(r.sz)*4}px ${d(r.sz)*2}px ${CC}`,
            opacity: Math.min(1, 1/r.op),
          }} />
        </div>
      ))}
      <div style={{
        position:"absolute",
        width:size*.28, height:size*.28,
        top:"50%", left:"50%",
        marginTop:-(size*.14), marginLeft:-(size*.14),
        borderRadius:"50%",
        background:`radial-gradient(circle, #fff 0%, ${CC2}ee 34%, ${CC}88 70%, transparent 100%)`,
        animation:"orb-pulse 2.6s ease-in-out infinite",
      }} />
    </div>
  );
}

// ─── Design 2: Solar ──────────────────────────────────────────────────────────
// Planetary orbits — coloured dots circling at different speeds on faint paths.
function OrbSolar({ size }) {
  const orbits = [
    { sz: size*.92, spd:"14s",  dir:"orb-cw",  color:"#60a5fa", dot:Math.round(size*.054) },
    { sz: size*.62, spd:"8.5s", dir:"orb-ccw", color:CC2,       dot:Math.round(size*.044) },
    { sz: size*.36, spd:"4.5s", dir:"orb-cw",  color:"#4ade80", dot:Math.round(size*.036) },
  ];
  return (
    <div style={{ position:"relative", width:size, height:size }}>
      {/* Static orbit paths */}
      {orbits.map((o, i) => (
        <div key={`p-${i}`} style={{
          position:"absolute",
          width:o.sz, height:o.sz,
          top:"50%", left:"50%",
          marginTop:-o.sz/2, marginLeft:-o.sz/2,
          borderRadius:"50%",
          border:`1px solid ${CC}1a`,
        }} />
      ))}
      {/* Orbiting planets */}
      {orbits.map((o, i) => (
        <div key={`o-${i}`} style={{
          position:"absolute",
          width:o.sz, height:o.sz,
          top:"50%", left:"50%",
          marginTop:-o.sz/2, marginLeft:-o.sz/2,
          animation:`${o.dir} ${o.spd} linear infinite`,
        }}>
          <div style={{
            position:"absolute",
            top:-o.dot/2, left:"50%", marginLeft:-o.dot/2,
            width:o.dot, height:o.dot,
            borderRadius:"50%",
            background:o.color,
            boxShadow:`0 0 ${o.dot*3}px ${o.dot}px ${o.color}99`,
          }} />
        </div>
      ))}
      {/* Star */}
      <div style={{
        position:"absolute",
        width:size*.3, height:size*.3,
        top:"50%", left:"50%",
        marginTop:-(size*.15), marginLeft:-(size*.15),
        borderRadius:"50%",
        background:`radial-gradient(circle, #fffde7 0%, ${CC2}f0 28%, ${CC}99 58%, transparent 100%)`,
        animation:"orb-pulse 3s ease-in-out infinite",
      }} />
    </div>
  );
}

// ─── Design 3: Radar ──────────────────────────────────────────────────────────
// Conic sweep arcs + concentric ring guides + inner rotating dot ring.
function OrbRadar({ size }) {
  return (
    <div style={{ position:"relative", width:size, height:size }}>
      {/* Outer conic sweep */}
      <div style={{
        position:"absolute", inset:0, borderRadius:"50%",
        background:`conic-gradient(from 0deg, transparent 0%, ${CC}00 55%, ${CC}55 75%, ${CC}cc 92%, transparent 100%)`,
        animation:"orb-cw 3.8s linear infinite",
      }} />
      {/* Mid conic sweep, opposite */}
      <div style={{
        position:"absolute",
        top:size*.14, left:size*.14,
        width:size*.72, height:size*.72,
        borderRadius:"50%",
        background:`conic-gradient(from 180deg, transparent 0%, ${CC2}00 45%, ${CC2}44 68%, ${CC2}bb 88%, transparent 100%)`,
        animation:"orb-ccw 6.2s linear infinite",
      }} />
      {/* Ring guides */}
      <div style={{ position:"absolute", inset:0, borderRadius:"50%", border:`1px solid ${CC}28` }} />
      <div style={{
        position:"absolute",
        top:size*.14, left:size*.14,
        width:size*.72, height:size*.72,
        borderRadius:"50%", border:`1px solid ${CC}40`,
      }} />
      {/* Inner rotating ring + dot */}
      <div style={{
        position:"absolute",
        top:size*.28, left:size*.28,
        width:size*.44, height:size*.44,
        borderRadius:"50%",
        border:`1.5px solid ${CC}66`,
        animation:"orb-cw 2.1s linear infinite",
      }}>
        <div style={{
          position:"absolute", top:-3, left:"50%", marginLeft:-3,
          width:6, height:6, borderRadius:"50%",
          background:CC2, boxShadow:`0 0 8px 3px ${CC}`,
        }} />
      </div>
      {/* Core glow */}
      <div style={{
        position:"absolute",
        width:size*.28, height:size*.28,
        top:"50%", left:"50%",
        marginTop:-(size*.14), marginLeft:-(size*.14),
        borderRadius:"50%",
        background:`radial-gradient(circle, #fff 0%, ${CC2}f0 30%, ${CC}88 65%, transparent 100%)`,
        animation:"orb-pulse 2.6s ease-in-out infinite",
      }} />
    </div>
  );
}

// ─── Design 4: Sonar ─────────────────────────────────────────────────────────
// Naval sonar display: expanding pings, crosshair grid, rotating sweep arc.
function OrbSonar({ size }) {
  const pingDelays = [0, 0.75, 1.5, 2.25];
  const rings = [0.9, 0.65, 0.4]; // static reference circles (grid)
  const cr = Math.round(size / 2); // half-size for crosshair positioning
  return (
    <div style={{ position:"relative", width:size, height:size, overflow:"hidden", borderRadius:"50%" }}>
      {/* Reference circles (sonar grid) */}
      {rings.map((r, i) => (
        <div key={i} style={{
          position:"absolute",
          width:size*r, height:size*r,
          top:"50%", left:"50%",
          marginTop:-(size*r/2), marginLeft:-(size*r/2),
          borderRadius:"50%",
          border:`1px solid ${CC}18`,
        }} />
      ))}
      {/* Crosshair lines */}
      <div style={{
        position:"absolute",
        top:"50%", left:"5%", right:"5%",
        height:1, background:`${CC}18`, marginTop:-0.5,
      }} />
      <div style={{
        position:"absolute",
        left:"50%", top:"5%", bottom:"5%",
        width:1, background:`${CC}18`, marginLeft:-0.5,
      }} />
      {/* Rotating sweep */}
      <div style={{
        position:"absolute", inset:0,
        background:`conic-gradient(from 0deg, ${CC}55 0deg, ${CC}11 50deg, transparent 50deg)`,
        animation:"orb-sonar-sweep 4s linear infinite",
      }} />
      {/* Expanding pings */}
      {pingDelays.map((delay, i) => (
        <div key={i} style={{
          position:"absolute", inset:0,
          borderRadius:"50%",
          border:`2px solid ${CC}`,
          opacity:0,
          animation:`orb-sonar-ping 3s ${delay}s ease-out infinite`,
        }} />
      ))}
      {/* Centre blip */}
      <div style={{
        position:"absolute",
        width:size*.22, height:size*.22,
        top:"50%", left:"50%",
        marginTop:-(size*.11), marginLeft:-(size*.11),
        borderRadius:"50%",
        background:`radial-gradient(circle, #fff 0%, ${CC2}ee 35%, ${CC}88 65%, transparent 100%)`,
        animation:"orb-pulse 2s ease-in-out infinite",
      }} />
    </div>
  );
}

// ─── Style registry ───────────────────────────────────────────────────────────
export const ORB_STYLES = [
  { id:"rings",  label:"Rings",  desc:"Orbital rings with glowing dots" },
  { id:"solar",  label:"Solar",  desc:"Planetary system — coloured orbits" },
  { id:"radar",  label:"Radar",  desc:"Conic sweep arc (current default)" },
  { id:"sonar",  label:"Sonar",  desc:"Expanding sonar pings — sea freight" },
];

const ORB_MAP = { rings: OrbRings, solar: OrbSolar, radar: OrbRadar, sonar: OrbSonar };

// ─── Public component ─────────────────────────────────────────────────────────
export function AiOrb({ size = 140, orbStyle }) {
  ensureOrbStyles();
  const style = orbStyle || (typeof localStorage !== "undefined" && localStorage.getItem("cc_orb_style")) || "radar";
  const Variant = ORB_MAP[style] || OrbRadar;
  return <Variant size={size} />;
}

export default AiOrb;
