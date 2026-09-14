import { useState, useEffect, useRef } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { AiOrb } from "./AiOrb";
import { IconSettings, IconAnchor, AnyIcon } from "../primitives/Icon";

// ─── Trade Horizon (page-scoped) ────────────────────────────────────────────────
// Same visual language as DashboardPage.jsx's own Overview redesign, duplicated here rather than
// shared — both are deliberately page-scoped restyles (never touching src/tokens.js or
// src/components/primitives/), so every other page keeps its current look regardless of what
// either of these two do. HZ_VIOLET is new here (the Dashboard's own HZ object already has this
// as gradCyan/gradViolet, but nothing in the Dashboard's port needed a bare mono violet — Command
// Center's AI branding does, for the orb/chat's cyan→violet identity).
const HZ_MONO    = "'IBM Plex Mono', ui-monospace, monospace";
const HZ_BODY    = "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif";
const HZ_DISPLAY = "'Sora', ui-sans-serif, system-ui, sans-serif";
const HZ_VIOLET  = "#9085e9";
const HZ_VIOLET2 = "#d5519f";
const useHorizonFonts = () => {
  useEffect(() => {
    if (document.getElementById("hz-fonts")) return;
    const link = document.createElement("link");
    link.id = "hz-fonts"; link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap";
    document.head.appendChild(link);
  }, []);
};
// Deterministic decorative gradient per carrier code, matching the Dashboard's own hzGradientFor —
// duplicated for the same page-scoping reason as the constants above. Used only as a fallback for
// a carrier code not in CARRIER_BRAND below.
const hzGradientFor = code => {
  const grads = [["#38d4e8", "#3987e5"], ["#fbc531", "#d9772a"], [HZ_VIOLET, HZ_VIOLET2]];
  let hash = 0;
  for (let i = 0; i < (code || "").length; i++) hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  return grads[hash % grads.length];
};

// Real carrier livery colors, so the badge itself carries recognition value (HLCU's badge should
// read as "Hapag-Lloyd" at a glance, not just "some cyan carrier") — a hashed gradient can also
// collide two unrelated carriers onto the same color, which this sidesteps entirely for the
// carriers actually present in this dataset. Anything not listed falls back to hzGradientFor.
const CARRIER_BRAND = {
  HLCU: { bg: "#e67300", text: "#0a2540" }, // Hapag-Lloyd — orange livery, navy wordmark
  MAEU: { bg: "#42b0e6", text: "#04212e" }, // Maersk — sky blue, dark navy star mark
  CMDU: { bg: "#0a2a53", text: "#ff6a39" }, // CMA CGM — navy hull, red-orange flourish
  EGLV: { bg: "#0fae4b", text: "#052e14" }, // Evergreen — signature green hull
  ONEY: { bg: "#e6007e", text: "#ffffff" }, // Ocean Network Express — magenta livery
  MSCU: { bg: "#ffd200", text: "#0a1f44" }, // MSC — gold swoosh, navy wordmark
  COSU: { bg: "#e2231a", text: "#ffffff" }, // COSCO — red hull
  OOLU: { bg: "#004a99", text: "#ffffff" }, // OOCL — blue hull
};
const carrierBadgeColors = code => {
  const brand = CARRIER_BRAND[code];
  if (brand) return { background: brand.bg, color: brand.text };
  const [g1, g2] = hzGradientFor(code);
  return { background: `linear-gradient(145deg, ${g1}, ${g2})`, color: "#06111f" };
};

// Palette — mutable module vars so sub-components defined outside the main function see the
// correct values. Updated at the start of each CommandCenterView render based on isDark prop.
let BG    = "#080b15";
let S1    = "#0d1220";
let S2    = "rgba(255,255,255,0.06)";
let BD    = "rgba(255,255,255,0.09)";
let CC    = "#38d4e8";
let CC2   = "#3987e5";
let MUTED = "#8c93b5";
let TEXT  = "#f3f5fc";
let CCON  = "#04121c";  // text on top of CC-coloured background

const DARK_PAL = { BG:"#080b15", S1:"#0d1220", S2:"rgba(255,255,255,0.06)", BD:"rgba(255,255,255,0.09)",
  CC:"#38d4e8", CC2:"#3987e5", MUTED:"#8c93b5", TEXT:"#f3f5fc", CCON:"#04121c" };

// ─── CSS keyframes (injected once) ───────────────────────────────────────────
const CC_STYLES = `
@keyframes cc-cw  { to { transform: rotate(360deg);  } }
@keyframes cc-ccw { to { transform: rotate(-360deg); } }
@keyframes cc-pulse {
  0%,100% { box-shadow: 0 0 14px 6px rgba(56,212,232,.4), 0 0 36px 14px rgba(56,212,232,.15); }
  50%     { box-shadow: 0 0 26px 12px rgba(56,212,232,.7), 0 0 60px 24px rgba(56,212,232,.28); }
}
@keyframes cc-blink { 0%,100%{opacity:1} 50%{opacity:.2} }
@keyframes cc-cmd-in {
  from { opacity:0; transform:scale(.95) translateY(-10px); }
  to   { opacity:1; transform:scale(1) translateY(0); }
}
@keyframes cc-typing {
  0%,80%,100% { transform:scale(.4); opacity:.25; }
  40%         { transform:scale(1);  opacity:1;   }
}
@keyframes cc-pulse-border {
  0%,100% { box-shadow: 0 0 0 0 rgba(240,82,107,.15); }
  50%     { box-shadow: 0 0 0 4px rgba(240,82,107,.35); }
}
`;
let _injected = false;
function ensureStyles() {
  if (_injected) return;
  const s = document.createElement("style");
  s.textContent = CC_STYLES;
  document.head.appendChild(s);
  _injected = true;
}

// ─── Inline SVG donut (status breakdown) ─────────────────────────────────────
function StatusDonut({ segments, size = 90 }) {
  // segments: [{ value, color, label }]
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = 34, cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments.map(seg => {
    const pct  = seg.value / total;
    const dash = pct * circ;
    const arc  = { ...seg, dasharray: `${dash} ${circ - dash}`, offset: circ - offset };
    offset += dash;
    return arc;
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: "visible" }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={BD} strokeWidth={10} />
      {arcs.filter(a => a.value > 0).map((a, i) => (
        <circle key={i} cx={cx} cy={cy} r={r} fill="none"
          stroke={a.color} strokeWidth={10}
          strokeDasharray={a.dasharray}
          strokeDashoffset={a.offset}
          strokeLinecap="butt"
          transform={`rotate(-90 ${cx} ${cy})`} />
      ))}
      <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle"
        style={{ fontFamily: "monospace", fontSize: 15, fontWeight: 900, fill: TEXT }}>
        {segments.reduce((s, x) => s + x.value, 0)}
      </text>
      <text x={cx} y={cy + 17} textAnchor="middle" dominantBaseline="middle"
        style={{ fontFamily: "sans-serif", fontSize: 8, fill: MUTED, textTransform: "uppercase", letterSpacing: "1px" }}>
        total
      </text>
    </svg>
  );
}

// ─── Inline SVG sparkline ─────────────────────────────────────────────────────
function Sparkline({ values, color, width = 120, height = 32 }) {
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * width;
    const y = height - (v / max) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <polyline fill="none" stroke={color} strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" points={pts} />
      <circle cx={pts.split(" ").pop().split(",")[0]}
        cy={pts.split(" ").pop().split(",")[1]}
        r={3} fill={color} />
    </svg>
  );
}

// ─── Horizontal bar ───────────────────────────────────────────────────────────
function Bar({ pct, color, height = 5 }) {
  const capped = Math.min(pct, 100);
  return (
    <div style={{ height, borderRadius: height / 2, background: BD, overflow: "hidden" }}>
      <div style={{ width: `${capped}%`, height: "100%", borderRadius: height / 2,
        background: pct >= 100 ? "#f0526b" : pct >= 80 ? "#fab219" : color,
        transition: "width .4s ease" }} />
    </div>
  );
}

// ─── Command palette ──────────────────────────────────────────────────────────
const CMDS = [
  { icon: "＋", label: "New Shipment",         key: "shipment-new"  },
  { icon: "📦", label: "All Shipments",         key: "shipments"     },
  { icon: "📊", label: "Consumption Dashboard", key: "dashboard"     },
  { icon: "🗂",  label: "Kanban Board",          key: "kanban"        },
  { icon: "⚖",  label: "Space Configurations",  key: "space-configs" },
  { icon: "📋", label: "Carrier Contracts",     key: "mdm-contracts" },
  { icon: IconAnchor, label: "Port Locations",        key: "mdm-ports"     },
  { icon: "🏢", label: "Branches & Offices",    key: "org-branch"    },
  { icon: IconSettings,  label: "App Settings",          key: "settings"      },
];
function CommandPalette({ onClose }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const list = CMDS.filter(c => !q || c.label.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => setIdx(0), [q]);
  const go = c => { window.location.hash = c.key; onClose(); };
  const onKey = e => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx(i => Math.min(i+1, list.length-1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setIdx(i => Math.max(i-1, 0)); }
    if (e.key === "Enter" && list[idx]) go(list[idx]);
  };
  return (
    <div style={{ position:"fixed", inset:0, zIndex:9999,
      background:"rgba(2,6,14,.82)", backdropFilter:"blur(6px)",
      display:"flex", alignItems:"flex-start", justifyContent:"center", paddingTop:"18vh" }}
      onClick={onClose}>
      <div data-testid="cc-command-palette" style={{ width:560, background:S1, backdropFilter:"blur(18px)",
        border:`1px solid ${CC}55`, borderRadius:14, overflow:"hidden",
        boxShadow:`0 32px 80px rgba(0,0,0,.7)`, animation:"cc-cmd-in .14s ease" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ padding:"13px 18px", borderBottom:`1px solid ${BD}`,
          display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ color:CC, fontSize:11, fontWeight:700 }}>⌘</span>
          <input ref={ref} data-testid="cc-command-palette-input" value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Search commands…"
            style={{ flex:1, background:"none", border:"none", outline:"none",
              fontFamily:HZ_BODY, fontSize:12, color:TEXT, caretColor:CC }} />
          <kbd style={{ fontFamily:HZ_MONO, fontSize:10, color:MUTED,
            border:`1px solid ${BD}`, borderRadius:4, padding:"2px 5px" }}>Esc</kbd>
        </div>
        <div style={{ maxHeight:330, overflowY:"auto" }}>
          {list.map((c,i) => (
            <div key={c.key} data-testid={`cc-command-item-${c.key}`}
              style={{ display:"flex", alignItems:"center", gap:12, padding:"11px 18px",
                cursor:"pointer", background: i===idx ? `${CC}12` : "none",
                borderLeft:`3px solid ${i===idx ? CC : "transparent"}` }}
              onMouseEnter={() => setIdx(i)} onClick={() => go(c)}>
              <span style={{ width:24, display:"flex", alignItems:"center", justifyContent:"center" }}><AnyIcon icon={c.icon} size={16} /></span>
              <span style={{ fontFamily:HZ_BODY, fontSize:11, color:TEXT, flex:1 }}>{c.label}</span>
            </div>
          ))}
        </div>
        <div style={{ padding:"7px 18px", borderTop:`1px solid ${BD}`,
          display:"flex", gap:16, fontFamily:HZ_MONO, fontSize:10, color:MUTED }}>
          <span>↑↓ navigate</span><span>↵ open</span><span>Esc close</span>
        </div>
      </div>
    </div>
  );
}

// ─── AI Chat panel ────────────────────────────────────────────────────────────
const fmt = ts => new Date(ts).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });

function AiChatPanel() {
  const [msgs,    setMsgs]    = useState([]);
  const [input,   setInput]   = useState("");
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState(null);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  useEffect(() => {
    api.ai.settings()
      .then(s => {
        setEnabled(!!s.enabled);
        if (s.enabled) setMsgs([{
          role: "assistant",
          content: "CargoDesk AI online. Ask me about shipments, carriers, space configurations, or contract data.",
          ts: new Date().toISOString(),
        }]);
      })
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [msgs, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const userMsg = { role:"user", content:text, ts:new Date().toISOString() };
    setMsgs(m => [...m, userMsg]);
    setInput("");
    setLoading(true);
    try {
      const history = [...msgs, userMsg].map(({ role, content }) => ({ role, content }));
      const data    = await api.ai.chat(history);
      setMsgs(m => [...m, { role:"assistant", content: data.reply || String(data), ts:new Date().toISOString() }]);
    } catch(e) { toast.error(e.message || "AI error"); }
    finally { setLoading(false); setTimeout(() => inputRef.current?.focus(), 50); }
  };

  const onKey = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };

  if (enabled === null) return (
    <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:HZ_BODY, fontSize:12, color:MUTED }}>Initialising…</div>
  );

  if (!enabled) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center", gap:8, padding:20, textAlign:"center" }}>
      <div style={{ fontSize:22, opacity:.12 }}>✦</div>
      <div style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED, lineHeight:1.7 }}>
        AI Agent not configured.<br/>Enable in <strong style={{ color:TEXT }}>Settings → API Controls → AI Agent</strong>.
      </div>
    </div>
  );

  return (
    <>
      <div style={{ flex:1, overflowY:"auto",
        display:"flex", flexDirection:"column", minHeight:0 }}>
        {msgs.map((m,i) => {
          const isUser = m.role === "user";
          return (
            <div key={i} style={{ display:"flex",
              justifyContent: isUser ? "flex-end" : "flex-start", marginBottom:7 }}>
              {!isUser && (
                <div style={{ width:18, height:18, borderRadius:"50%", flexShrink:0,
                  marginRight:5, background:CC, alignSelf:"flex-end",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontFamily:HZ_MONO, fontSize:8, fontWeight:700, color:CCON }}>✦</div>
              )}
              <div style={{ maxWidth:"84%",
                background: isUser ? CC : S1,
                color: isUser ? CCON : TEXT,
                border: isUser ? "none" : `1px solid ${BD}`,
                borderRadius: isUser ? "9px 9px 2px 9px" : "9px 9px 9px 2px",
                padding:"7px 10px", fontFamily:HZ_BODY, fontSize:11, lineHeight:1.55 }}>
                <div style={{ whiteSpace:"pre-wrap", wordBreak:"break-word" }}>{m.content}</div>
                <div style={{ fontSize:9, marginTop:2,
                  color: isUser ? `${CCON}88` : MUTED,
                  textAlign: isUser ? "right" : "left" }}>{fmt(m.ts)}</div>
              </div>
            </div>
          );
        })}
        {loading && (
          <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:7 }}>
            <div style={{ width:18, height:18, borderRadius:"50%", background:CC, flexShrink:0,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontFamily:HZ_MONO, fontSize:8, fontWeight:700, color:CCON }}>✦</div>
            <div style={{ background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`,
              borderRadius:"9px 9px 9px 2px", padding:"8px 11px",
              display:"flex", gap:3, alignItems:"center" }}>
              {[0,1,2].map(i => (
                <span key={i} style={{ width:4, height:4, borderRadius:"50%",
                  background:MUTED, display:"inline-block",
                  animation:`cc-typing 1.2s ${i*.2}s ease-in-out infinite` }} />
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div style={{ paddingTop:10, marginTop:2, borderTop:`1px solid ${BD}`, flexShrink:0 }}>
        <div style={{ display:"flex", gap:6, alignItems:"flex-end" }}>
          <textarea ref={inputRef} data-testid="cc-ai-chat-input" value={input}
            onChange={e => setInput(e.target.value)} onKeyDown={onKey} rows={1}
            placeholder="Ask about shipments, carriers…"
            style={{ flex:1, resize:"none", background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`,
              borderRadius:7, padding:"6px 9px", fontFamily:HZ_BODY, fontSize:11,
              color:TEXT, outline:"none", lineHeight:1.4, maxHeight:72, overflowY:"auto" }} />
          <button type="button" data-testid="cc-ai-chat-send-btn" onClick={send} disabled={loading || !input.trim()}
            style={{ padding:"6px 11px", borderRadius:7, border:"none", flexShrink:0,
              background: (loading||!input.trim()) ? S2 : CC,
              color: (loading||!input.trim()) ? MUTED : CCON,
              cursor: (loading||!input.trim()) ? "default" : "pointer",
              fontFamily:HZ_MONO, fontSize:11, fontWeight:700, lineHeight:1 }}>↑</button>
        </div>
      </div>
    </>
  );
}

// ─── Shipment preview modal (R/O, custom dark overlay) ───────────────────────
function ShipmentPreviewModal({ shipment: s, containers, carriers, onClose }) {
  const ctrs    = containers.filter(c => c.shipmentId === s.id);
  const teu     = ctrs.reduce((n, c) => n + (c.size === "40" ? 2 : 1), 0);
  const carrier = carriers.find(c => c.code === s.carrierCode);

  const row = (label, value) => value ? (
    <div style={{ display:"flex", gap:10, padding:"6px 0", borderBottom:`1px solid ${BD}` }}>
      <span style={{ fontFamily:HZ_MONO, fontSize:10, color:MUTED, minWidth:110, flexShrink:0 }}>{label}</span>
      <span style={{ fontFamily:HZ_MONO, fontSize:11, color:TEXT, wordBreak:"break-word" }}>{value}</span>
    </div>
  ) : null;

  const STATUS_COLOR = { Active:"#22c55e", Pending:"#fab219", "Requires Review":"#f0526b",
    Completed:"#3b82f6", Cancelled:"#475569" };
  const sc = STATUS_COLOR[s.status] || MUTED;

  const openInNewTab = () => {
    window.open(`${window.location.pathname}#shipments/${s.id}`, "_blank");
    onClose();
  };

  const btnBase = {
    padding:"4px 10px", borderRadius:6, border:`1px solid ${BD}`,
    background:"none", cursor:"pointer", fontFamily:HZ_MONO, fontSize:12,
    color:MUTED, lineHeight:1, transition:"all .15s",
  };

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position:"fixed", inset:0, background:"rgba(0,2,8,.75)",
        backdropFilter:"blur(3px)", zIndex:3000,
      }} />

      {/* Panel */}
      <div data-testid="cc-shipment-preview-modal" style={{
        position:"fixed", top:"50%", left:"50%",
        transform:"translate(-50%,-50%)",
        width:530, maxWidth:"calc(100vw - 32px)",
        maxHeight:"calc(100vh - 80px)",
        background:BG, border:`1px solid ${CC}33`,
        borderRadius:12, zIndex:3001,
        display:"flex", flexDirection:"column",
        overflow:"hidden",
        boxShadow:`0 32px 80px rgba(0,0,0,.8), 0 0 0 1px ${BD}`,
      }}>

        {/* Header */}
        <div style={{ flexShrink:0, display:"flex", alignItems:"center", gap:10,
          padding:"13px 16px", background:S1, backdropFilter:"blur(18px)", borderBottom:`1px solid ${BD}` }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontFamily:HZ_MONO, fontSize:13, fontWeight:900,
              color:TEXT, letterSpacing:".04em", overflow:"hidden",
              textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.id}</div>
            {s.bookingRef && (
              <div style={{ fontFamily:HZ_MONO, fontSize:10, color:MUTED, marginTop:2 }}>
                Booking {s.bookingRef}
              </div>
            )}
          </div>
          <span style={{ flexShrink:0, fontFamily:HZ_MONO, fontSize:10, fontWeight:700,
            padding:"3px 9px", borderRadius:5,
            background:`${sc}18`, color:sc, border:`1px solid ${sc}44` }}>
            {s.status}
          </span>
          {/* Open in new tab */}
          <button type="button" onClick={openInNewTab}
            title="Open in new tab"
            style={btnBase}
            onMouseEnter={e => { e.currentTarget.style.borderColor=CC; e.currentTarget.style.color=CC; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor=BD; e.currentTarget.style.color=MUTED; }}>
            ↗
          </button>
          {/* Close */}
          <button type="button" data-testid="cc-shipment-preview-close-btn" onClick={onClose}
            style={btnBase}
            onMouseEnter={e => { e.currentTarget.style.borderColor="#f0526b"; e.currentTarget.style.color="#f0526b"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor=BD; e.currentTarget.style.color=MUTED; }}>
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ flex:1, overflowY:"auto", padding:"16px 18px" }}>

          {/* Route hero */}
          {(() => {
            const LOC_FULL = { DR:"Door", CY:"CY", CFS:"CFS", PT:null };
            const parts = s.routingTerm ? s.routingTerm.split("-") : [];
            const pickupLabel   = parts[0] && LOC_FULL[parts[0]] !== null ? LOC_FULL[parts[0]] : null;
            const deliveryLabel = parts[1] && LOC_FULL[parts[1]] !== null ? LOC_FULL[parts[1]] : null;

            const Node = ({ code, sub, isDoor }) => (
              <div style={{ textAlign:"center", flexShrink:0 }}>
                <div style={{
                  fontFamily:HZ_MONO, fontSize: isDoor ? 11 : 18,
                  fontWeight: isDoor ? 600 : 900,
                  color: isDoor ? MUTED : TEXT,
                  fontStyle: isDoor ? "italic" : "normal",
                }}>{code}</div>
                {sub && <div style={{ fontFamily:HZ_BODY, fontSize:10, color:MUTED }}>{sub}</div>}
              </div>
            );
            const Arrow = ({ label }) => (
              <div style={{ flex:1, textAlign:"center", minWidth:40 }}>
                <div style={{ height:1, background:BD, position:"relative" }}>
                  {label && <span style={{ position:"absolute", top:-8, left:"50%", transform:"translateX(-50%)",
                    fontFamily:HZ_MONO, fontSize:9, color:CC, background:S1, backdropFilter:"blur(18px)", padding:"0 6px",
                    whiteSpace:"nowrap" }}>{label}</span>}
                </div>
              </div>
            );
            return (
              <div style={{ marginBottom:16, padding:"12px 16px", background:S1, backdropFilter:"blur(18px)", borderRadius:16, border:`1px solid ${BD}` }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  {pickupLabel && <><Node code={pickupLabel} isDoor /><Arrow /></>}
                  <Node code={s.pol || "—"} sub={s.polName} />
                  <Arrow label={`${s.carrierCode || "—"}${carrier?.name ? ` · ${carrier.name}` : ""}`} />
                  <Node code={s.pod || "—"} sub={s.podName} />
                  {deliveryLabel && <><Arrow /><Node code={deliveryLabel} isDoor /></>}
                </div>
                {(s.vessel || s.routingTerm) && (
                  <div style={{ fontFamily:HZ_MONO, fontSize:9, color:MUTED, marginTop:10,
                    textAlign:"center", borderTop:`1px solid ${BD}`, paddingTop:8 }}>
                    {s.vessel ? `${s.vessel}${s.voyage ? ` / ${s.voyage}` : ""}` : ""}
                    {s.vessel && s.routingTerm ? "  ·  " : ""}
                    {s.routingTerm || ""}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Detail rows */}
          <div style={{ marginBottom:14 }}>
            {row("ETD", s.etd)}
            {row("ETA", s.eta)}
            {row("B/L Number", s.blNumber)}
            {row("Incoterm", s.incoterm)}
            {row("Freight Terms", s.freightTerms)}
            {row("Shipper", s.shipperName)}
            {row("Consignee", s.consigneeName)}
            {row("Service Type", s.serviceType)}
            {row("Trade Lane", s.tradeLane)}
          </div>

          {/* Containers */}
          {ctrs.length > 0 && (
            <div style={{ marginBottom:14 }}>
              <div style={{ fontFamily:HZ_MONO, fontSize:9, fontWeight:700, color:MUTED,
                textTransform:"uppercase", letterSpacing:".12em", marginBottom:8 }}>
                Containers — {ctrs.length} unit{ctrs.length > 1 ? "s" : ""}, {teu} TEU
              </div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                {ctrs.map(c => (
                  <div key={c.id} style={{ fontFamily:HZ_MONO, fontSize:10, padding:"4px 9px",
                    borderRadius:6, background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, color:TEXT }}>
                    {c.size}ft {c.type}
                    {c.containerNumber ? <span style={{ color:MUTED }}> · {c.containerNumber}</span> : ""}
                    {c.isDg ? <span style={{ color:"#f0526b", marginLeft:4 }}>DG</span> : ""}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer */}
          <div style={{ display:"flex", justifyContent:"flex-end", paddingTop:4 }}>
            <button type="button" onClick={openInNewTab}
              style={{ padding:"7px 16px", borderRadius:7, border:`1px solid ${CC}55`,
                background:"none", cursor:"pointer", fontFamily:HZ_MONO, fontSize:11,
                color:CC, transition:"all .15s" }}
              onMouseEnter={e => { e.currentTarget.style.background=`${CC}14`; }}
              onMouseLeave={e => { e.currentTarget.style.background="none"; }}>
              Open full details ↗
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────
const SLabel = ({ children }) => (
  <div style={{ fontFamily:HZ_MONO, fontSize:11, fontWeight:700, color:MUTED,
    textTransform:"uppercase", letterSpacing:".14em", marginBottom:8 }}>
    {children}
  </div>
);

// ─── Weather code → emoji ─────────────────────────────────────────────────────
const weatherIcon = code => {
  if (code === 0) return "☀️";
  if (code <= 3)  return "⛅";
  if (code <= 48) return "🌫";
  if (code <= 67) return "🌧";
  if (code <= 77) return "❄️";
  if (code <= 82) return "🌦";
  return "⛈";
};

// ─── City-name weather fetch (Open-Meteo, no API key) ────────────────────────
async function fetchWeatherByCity(cityName, setter) {
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`
    ).then(r => r.json());
    const loc = geo.results?.[0];
    if (!loc) return;
    const wx = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      `&current=temperature_2m,weather_code&timezone=auto`
    ).then(r => r.json());
    setter({
      temp: Math.round(wx.current.temperature_2m),
      code: wx.current.weather_code,
      city: loc.name,
      country: loc.country_code,
    });
  } catch {}
}

const DONE_STATUSES = new Set(["Done", "Ready to Deploy", "Released"]);
const PRIORITY_COLOR = { High:"#f0526b", Medium:"#fab219", Low:"#3b82f6" };

// ─── Integration board overdue card ──────────────────────────────────────────
function TicketAlertCard({ overdueTickets, dueSoonTickets, today, onNavigate }) {
  const [ticketTab, setTicketTab] = useState("overdue");
  const shown = ticketTab === "overdue" ? overdueTickets : dueSoonTickets;
  const daysLate  = iso => Math.round((new Date(today) - new Date(iso)) / 86400000);
  const daysUntil = iso => Math.round((new Date(iso)   - new Date(today)) / 86400000);
  return (
    <div data-testid="cc-ticket-alert-card" style={{ marginBottom:20, background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`,
      borderTop:`2px solid #f0526b88`, borderRadius:16, overflow:"hidden" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px 8px" }}>
        <span style={{ fontFamily:HZ_MONO, fontSize:13, fontWeight:700,
          color:"#f0526b", textTransform:"uppercase", letterSpacing:".12em" }}>
          🎫 Integration Board
        </span>
        <div style={{ display:"flex", gap:6, marginLeft:4 }}>
          {[
            { key:"overdue",   label:"Overdue",       count:overdueTickets.length,  color:"#f0526b" },
            { key:"due-soon",  label:"Due this week", count:dueSoonTickets.length,  color:"#fab219" },
          ].map(tab => {
            const active = ticketTab === tab.key;
            return (
              <button key={tab.key} type="button" data-testid={`cc-ticket-tab-${tab.key}`} onClick={() => setTicketTab(tab.key)}
                style={{ display:"flex", alignItems:"center", gap:5,
                  padding:"3px 10px", borderRadius:10,
                  fontFamily:HZ_MONO, fontSize:11, fontWeight:700,
                  cursor:"pointer", transition:"all .12s",
                  background: active ? `${tab.color}22` : "none",
                  color: active ? tab.color : MUTED,
                  border: active ? `1px solid ${tab.color}55` : `1px solid ${BD}` }}>
                {tab.label}
                {tab.count > 0 && (
                  <span style={{ fontFamily:HZ_MONO, fontSize:12,
                    background: active ? tab.color : BD,
                    color: active ? CCON : MUTED,
                    borderRadius:8, padding:"1px 5px", minWidth:14, textAlign:"center" }}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <button type="button"
          onClick={() => { if (onNavigate) onNavigate("kanban"); else window.location.hash = "kanban"; }}
          style={{ marginLeft:"auto", fontFamily:HZ_MONO, fontSize:11, color:MUTED,
            background:"none", border:`1px solid ${BD}`, borderRadius:5,
            padding:"4px 10px", cursor:"pointer" }}
          onMouseEnter={e => { e.currentTarget.style.color=CC; e.currentTarget.style.borderColor=`${CC}55`; }}
          onMouseLeave={e => { e.currentTarget.style.color=MUTED; e.currentTarget.style.borderColor=BD; }}>
          View board ↗
        </button>
      </div>

      {/* Ticket rows */}
      <div style={{ maxHeight:200, overflowY:"auto" }}>
        {shown.length === 0 ? (
          <div style={{ padding:"14px 14px 16px", fontFamily:HZ_BODY,
            fontSize:11, color:MUTED, fontStyle:"italic" }}>
            {ticketTab === "overdue" ? "No overdue tickets." : "Nothing due in the next 7 days."}
          </div>
        ) : shown.map(t => {
          const pColor = PRIORITY_COLOR[t.priority] || MUTED;
          const isOD   = ticketTab === "overdue";
          const dLabel = isOD ? `+${daysLate(t.dueDate)}d` : `${daysUntil(t.dueDate)}d`;
          const dColor = isOD ? "#f0526b" : (daysUntil(t.dueDate) <= 2 ? "#fab219" : MUTED);
          return (
            <div key={t.id} style={{ display:"flex", alignItems:"center", gap:8,
              padding:"7px 14px", borderTop:`1px solid ${BD}` }}>
              <div style={{ width:8, height:8, borderRadius:"50%", flexShrink:0,
                background:pColor, boxShadow:`0 0 4px ${pColor}88` }} />
              <span style={{ fontFamily:HZ_MONO, fontSize:11, color:MUTED,
                flexShrink:0, minWidth:90, overflow:"hidden",
                textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {t.id.length > 12 ? t.id.slice(-10) : t.id}
              </span>
              <span style={{ fontFamily:HZ_BODY, fontSize:12, color:TEXT, flex:1,
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {t.title}
              </span>
              <span style={{ fontFamily:HZ_MONO, fontSize:12, flexShrink:0,
                padding:"2px 8px", borderRadius:4, background:S2,
                border:`1px solid ${BD}`, color:MUTED }}>
                {t.status}
              </span>
              <span style={{ fontFamily:HZ_MONO, fontSize:13, fontWeight:700,
                color:dColor, flexShrink:0, minWidth:36, textAlign:"right" }}>
                {dLabel}
              </span>
              {t.assigneeInitial ? (
                <div style={{ width:26, height:26, borderRadius:"50%", flexShrink:0,
                  background:`${CC}22`, border:`1px solid ${CC}44`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontFamily:HZ_MONO, fontSize:13, fontWeight:700, color:CC }}>
                  {t.assigneeInitial}
                </div>
              ) : (
                <div style={{ width:26, height:26, borderRadius:"50%", flexShrink:0,
                  background:BD, border:`1px solid ${BD}`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontFamily:HZ_MONO, fontSize:13, color:MUTED }}>
                  —
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Exception queue, classified by root cause (TKT-FKJPBO) ─────────────────
const EXC_TABS = [
  { key:"scheduleSlip",       label:"Schedule Slip",       color:"#fab219" },
  { key:"unconfirmedBooking", label:"Unconfirmed Booking", color:"#f0526b" },
  { key:"stalledMilestone",   label:"Stalled Milestone",   color:"#fab219" },
];
function ExceptionQueueCard({ queue, onOpenShipment }) {
  const [tab, setTab] = useState("scheduleSlip");
  const active = EXC_TABS.find(t => t.key === tab);
  const shown  = queue[tab] || [];

  const rowDetail = row => {
    if (tab === "scheduleSlip") return `${row.pol || "—"} → ${row.pod || "—"} · confirmed ${row.confirmedDate} (est. ${row.estimatedDate})`;
    if (tab === "unconfirmedBooking") return `${row.carrierCode || "—"} · ETD ${row.etd}, booking still "${row.bookingStatus}"`;
    return `${row.label} · est. ${row.estimatedDate}`;
  };
  const rowDays = row => tab === "scheduleSlip" ? row.daysSlipped : tab === "unconfirmedBooking" ? row.daysPastEtd : row.daysStalled;

  return (
    <div data-testid="cc-exception-queue-card" style={{ marginBottom:20, background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`,
      borderTop:`2px solid #fab21988`, borderRadius:16, overflow:"hidden" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px 8px", flexWrap:"wrap" }}>
        <span style={{ fontFamily:HZ_MONO, fontSize:13, fontWeight:700,
          color:"#fab219", textTransform:"uppercase", letterSpacing:".12em" }}>
          ⚠ Exceptions
        </span>
        <div style={{ display:"flex", gap:6, marginLeft:4, flexWrap:"wrap" }}>
          {EXC_TABS.map(t => {
            const count = (queue[t.key] || []).length;
            const isActive = tab === t.key;
            return (
              <button key={t.key} type="button" data-testid={`cc-exc-tab-${t.key}`} onClick={() => setTab(t.key)}
                style={{ display:"flex", alignItems:"center", gap:5,
                  padding:"3px 10px", borderRadius:10,
                  fontFamily:HZ_MONO, fontSize:11, fontWeight:700,
                  cursor:"pointer", transition:"all .12s",
                  background: isActive ? `${t.color}22` : "none",
                  color: isActive ? t.color : MUTED,
                  border: isActive ? `1px solid ${t.color}55` : `1px solid ${BD}` }}>
                {t.label}
                {count > 0 && (
                  <span style={{ fontFamily:HZ_MONO, fontSize:10,
                    background: isActive ? t.color : BD,
                    color: isActive ? CCON : MUTED,
                    borderRadius:8, padding:"1px 5px", minWidth:14, textAlign:"center" }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ maxHeight:200, overflowY:"auto" }}>
        {shown.length === 0 ? (
          <div style={{ padding:"14px 14px 16px", fontFamily:HZ_BODY,
            fontSize:11, color:MUTED, fontStyle:"italic" }}>
            No {active.label.toLowerCase()} exceptions.
          </div>
        ) : shown.map((row, i) => (
          <div key={`${row.shipmentId}-${i}`}
            onClick={() => onOpenShipment(row.shipmentId)}
            style={{ display:"flex", alignItems:"center", gap:8,
              padding:"7px 14px", borderTop:`1px solid ${BD}`, cursor:"pointer" }}
            onMouseEnter={e => e.currentTarget.style.background = S2}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily:HZ_MONO, fontSize:11, fontWeight:700, color:TEXT,
              flexShrink:0, minWidth:90 }}>
              {row.shipmentId}
            </span>
            <span style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED, flex:1,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {rowDetail(row)}
            </span>
            <span style={{ fontFamily:HZ_MONO, fontSize:11, fontWeight:700,
              color: active.color, flexShrink:0 }}>
              +{rowDays(row)}d
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function CommandCenterView({ shipments=[], containers=[], allocations=[], carriers=[], onExit, onNavigate, isDark=true }) {
  // Sync module-level palette vars before any sub-component renders
  const pal = isDark ? DARK_PAL : {
    BG: T.bg, S1: T.surface, S2: T.surfaceHover,
    BD: T.border, CC: T.accent, CC2: T.accentHover,
    MUTED: T.textMuted, TEXT: T.text, CCON: T.btnPrimaryText,
  };
  [BG, S1, S2, BD, CC, CC2, MUTED, TEXT, CCON] = [pal.BG, pal.S1, pal.S2, pal.BD, pal.CC, pal.CC2, pal.MUTED, pal.TEXT, pal.CCON];
  const [cmdOpen,         setCmdOpen]         = useState(false);
  const [previewShipment, setPreviewShipment] = useState(null);
  const [activeFilter,    setActiveFilter]    = useState(null);
  const [showAllRecent,   setShowAllRecent]   = useState(false);
  const [tickets,         setTickets]         = useState([]);

  // Command Center — Quality & Exception Management (Epic TKT-IBHB0K)
  const [msOverdueSummary, setMsOverdueSummary] = useState(null);
  const [exceptionQueue,   setExceptionQueue]   = useState(null);
  const [carrierScorecard, setCarrierScorecard] = useState([]);
  const [transitTrend,     setTransitTrend]     = useState([]);
  useEffect(() => {
    api.milestonesOverdueSummary().then(setMsOverdueSummary).catch(() => {});
    api.exceptionsQueue().then(setExceptionQueue).catch(() => {});
    api.carrierOnTimeScorecard().then(setCarrierScorecard).catch(() => {});
    api.laneTransitTimeTrend().then(setTransitTrend).catch(() => {});
  }, []);

  // Live clock
  const [now, setNow] = useState(new Date());

  // Orb style (synced from localStorage; updated when settings change)
  const [orbStyle, setOrbStyle] = useState(() => localStorage.getItem("cc_orb_style") || "radar");
  useEffect(() => {
    const sync = () => setOrbStyle(localStorage.getItem("cc_orb_style") || "radar");
    window.addEventListener("cc-orb-style-changed", sync);
    return () => window.removeEventListener("cc-orb-style-changed", sync);
  }, []);

  // Weather
  const [weather,  setWeather]  = useState(null);
  const [wxCity,   setWxCity]   = useState(() => localStorage.getItem("cc_wx_city") || "Rotterdam");
  const [wxInput,  setWxInput]  = useState(false); // editing city name

  // FX
  const [fxRates,  setFxRates]  = useState({});
  const [fxFrom,   setFxFrom]   = useState(() => localStorage.getItem("cc_fx_from") || "EUR");
  const [fxTo,     setFxTo]     = useState(() => localStorage.getItem("cc_fx_to")   || "USD");
  const [fxAmt,    setFxAmt]    = useState("1000");

  useEffect(() => {
    ensureStyles();
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setCmdOpen(p => !p); }
    };
    window.addEventListener("keydown", onKey);
    api.tickets.list().then(setTickets).catch(() => {});
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Live clock tick
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Weather — try geolocation first, fall back to saved city
  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
          `&current=temperature_2m,weather_code&timezone=auto`)
          .then(r => r.json())
          .then(d => {
            const tz   = d.timezone || "";
            const city = tz.split("/").pop()?.replace(/_/g, " ") || "Local";
            setWeather({ temp: Math.round(d.current.temperature_2m), code: d.current.weather_code, city });
          })
          .catch(() => fetchWeatherByCity(wxCity, setWeather));
      },
      () => fetchWeatherByCity(wxCity, setWeather)
    );
    api.fx.rates().then(r => setFxRates(r.rates || {})).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fxConvert = (amt, from, to) => {
    const n = parseFloat(amt);
    if (!n || !from || !to) return null;
    const toUsd = from === "USD" ? n : (fxRates[from] ? n / fxRates[from] : null);
    if (toUsd === null) return null;
    return to === "USD" ? toUsd : toUsd * (fxRates[to] || 1);
  };
  const fxResult = fxConvert(fxAmt, fxFrom, fxTo);

  const FX_CCYS = ["USD","EUR","GBP","CNY","SGD","JPY","CHF","AED","HKD","AUD","CAD","INR","BRL","NOK","SEK"];
  const swapFx = () => {
    const [a, b] = [fxTo, fxFrom];
    setFxFrom(a); setFxTo(b);
    localStorage.setItem("cc_fx_from", a);
    localStorage.setItem("cc_fx_to",   b);
  };

  // ── Analytics computations ──────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);

  // Status breakdown
  const byStatus = {};
  shipments.forEach(s => { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });
  const donutSegs = [
    { label:"Active",   value: byStatus["Active"]          || 0, color:"#22c55e" },
    { label:"Pending",  value: byStatus["Pending"]         || 0, color:"#fab219" },
    { label:"Review",   value: byStatus["Requires Review"] || 0, color:"#f0526b" },
    { label:"Completed",value: byStatus["Completed"]       || 0, color:"#3b82f6" },
    { label:"Other",    value: shipments.length - (byStatus["Active"]||0) - (byStatus["Pending"]||0)
                               - (byStatus["Requires Review"]||0) - (byStatus["Completed"]||0), color:"#475569" },
  ].filter(s => s.value > 0);

  // Containers count
  const totalTEU = containers.reduce((n,c) => n + (c.size === "40" ? 2 : 1), 0);

  // TEU per carrier (from shipments + containers)
  const teuByCarrier = {};
  shipments.forEach(s => {
    if (!s.carrierCode) return;
    const teu = containers.filter(c => c.shipmentId === s.id)
      .reduce((n, c) => n + (c.size === "40" ? 2 : 1), 0);
    teuByCarrier[s.carrierCode] = (teuByCarrier[s.carrierCode] || 0) + teu;
  });

  // Carrier consumption vs allocation
  const carrierMap = Object.fromEntries(carriers.map(c => [c.code, c.name]));
  const carrierStats = Object.entries(teuByCarrier)
    .map(([code, consumed]) => {
      const alloc = allocations.filter(a => a.carrierCode === code && a.endDate >= today)
        .reduce((n,a) => n + a.allocatedTEU, 0);
      return { code, name: carrierMap[code] || code, consumed, allocated: alloc,
        pct: alloc > 0 ? Math.round(consumed / alloc * 100) : null };
    })
    .sort((a,b) => b.consumed - a.consumed)
    .slice(0, 6);
  const maxConsumed = Math.max(...carrierStats.map(c => c.consumed), 1);
  const carrierScorecardByCode = Object.fromEntries(carrierScorecard.map(c => [c.carrierCode, c]));

  // Top routes
  const routeCount = {};
  shipments.forEach(s => {
    if (s.pol && s.pod) {
      const k = `${s.pol} › ${s.pod}`;
      routeCount[k] = (routeCount[k]||0) + 1;
    }
  });
  const topRoutes = Object.entries(routeCount)
    .sort((a,b) => b[1]-a[1]).slice(0, 5);
  const maxRoute = Math.max(...topRoutes.map(r => r[1]), 1);

  // TKT-PZ3JS2 — transit-time variance per lane, collapsed from the endpoint's per-month
  // buckets into one row per lane (sample-weighted average across every month returned, plus
  // the monthly actualAvgDays series for the sparkline trend) — "which lanes are becoming less
  // predictable" needs the trend line, but the headline sort/badge needs one comparable number.
  const laneVariance = (() => {
    const byLane = {};
    transitTrend.forEach(b => {
      byLane[b.tradeLane] ??= { tradeLane: b.tradeLane, months: [], actualSum: 0, plannedSum: 0, plannedN: 0, sampleSize: 0 };
      const l = byLane[b.tradeLane];
      l.months.push({ month: b.month, actualAvgDays: b.actualAvgDays });
      l.actualSum += b.actualAvgDays * b.sampleSize;
      l.sampleSize += b.sampleSize;
      if (b.plannedAvgDays != null) { l.plannedSum += b.plannedAvgDays * b.sampleSize; l.plannedN += b.sampleSize; }
    });
    return Object.values(byLane).map(l => ({
      tradeLane: l.tradeLane,
      sampleSize: l.sampleSize,
      actualAvgDays: l.sampleSize ? Math.round(l.actualSum / l.sampleSize * 10) / 10 : null,
      plannedAvgDays: l.plannedN ? Math.round(l.plannedSum / l.plannedN * 10) / 10 : null,
      trend: l.months.sort((a, b) => a.month.localeCompare(b.month)).map(m => m.actualAvgDays),
    })).map(l => ({ ...l, varianceDays: l.plannedAvgDays != null ? Math.round((l.actualAvgDays - l.plannedAvgDays) * 10) / 10 : null }))
      .sort((a, b) => (b.varianceDays ?? -999) - (a.varianceDays ?? -999))
      .slice(0, 5);
  })();

  // Monthly bookings (last 6 months)
  const monthlyBookings = Array.from({ length: 6 }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - (5 - i));
    const ym = d.toISOString().slice(0, 7);
    return shipments.filter(s => s.createdAt && s.createdAt.startsWith(ym)).length;
  });

  // Expiring allocations (next 30 days)
  const in30 = new Date(today);
  in30.setDate(in30.getDate() + 30);
  const in30str = in30.toISOString().slice(0,10);
  const expiringAllocs = allocations
    .filter(a => a.endDate >= today && a.endDate <= in30str)
    .sort((a,b) => a.endDate.localeCompare(b.endDate));

  // Overdue shipments (ETD past today, not closed)
  const overdueShipments = shipments.filter(s =>
    s.etd && s.etd < today &&
    s.status !== "Completed" && s.status !== "Cancelled"
  );

  // Ticket analytics
  const in7str = (() => { const d = new Date(today); d.setDate(d.getDate() + 7); return d.toISOString().slice(0,10); })();
  const openTickets    = tickets.filter(t => !DONE_STATUSES.has(t.status));
  const overdueTickets = openTickets.filter(t => t.dueDate && t.dueDate < today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const dueSoonTickets = openTickets.filter(t => t.dueDate && t.dueDate >= today && t.dueDate <= in7str)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // Milestone breach ids (TKT-550J25) — every shipment with at least one overdue milestone,
  // from the same bulk-scoped summary the KPI card + breakdown panel + bell all share.
  const milestoneBreachIds = new Set((msOverdueSummary?.items || []).map(i => i.shipmentId));

  // Recent active shipments — filtered by KPI card selection
  const filteredForList = shipments.filter(s => {
    if (!activeFilter) return s.status !== "Completed" && s.status !== "Cancelled";
    if (activeFilter.status === "_overdue")
      return s.etd && s.etd < today && s.status !== "Completed" && s.status !== "Cancelled";
    if (activeFilter.milestoneBreach) return milestoneBreachIds.has(s.id);
    if (activeFilter.status) return s.status === activeFilter.status;
    return true; // empty filter = all
  });
  // `shipments` is already the full in-memory list (used for the KPI aggregates above too), so
  // there's no extra fetch involved in holding up to 50 ready — only 10 render by default, with
  // the rest revealed by the expand toggle below.
  const recentShipments = filteredForList
    .sort((a, b) => {
      const aOD = a.etd && a.etd < today ? 0 : 1;
      const bOD = b.etd && b.etd < today ? 0 : 1;
      return aOD - bOD;
    })
    .slice(0, 50);
  const visibleRecentShipments = showAllRecent ? recentShipments : recentShipments.slice(0, 10);

  // TEU helper per shipment
  const shipTEU = sid => containers
    .filter(c => c.shipmentId === sid)
    .reduce((n, c) => n + (c.size === "40" ? 2 : 1), 0);

  const STATUS_DOT = { Active:"#22c55e", Pending:"#fab219", "Requires Review":"#f0526b" };

  useHorizonFonts();

  return (
    <div style={{
      position:"relative",
      display:"flex", flexDirection:"column",
      // fills the fixed wrapper in LandingPage (top:46, bottom:36, left:240, right:0)
      height:"100%",
      background: BG,
      overflow:"hidden",
      backgroundImage:`radial-gradient(circle, ${BD} 1px, transparent 1px)`,
      backgroundSize:"28px 28px",
      colorScheme: isDark ? "dark" : "light",
    }}>

      {/* Ambient decorative glow — position:absolute anchored to the position:relative wrapper
          above, never position:fixed (this component itself already lives inside a position:fixed
          shell in LandingPage.jsx; a second nested fixed layer isn't needed and this codebase has
          confirmed position:fixed content inside a scroll-captured region also mis-renders under
          Puppeteer's fullPage screenshot stitching). pointerEvents:none so it can never intercept a
          click; zIndex:0 with the top bar/body siblings below explicitly at zIndex:1. */}
      <div aria-hidden="true" style={{ position:"absolute", inset:0, zIndex:0, pointerEvents:"none", overflow:"hidden" }}>
        <div style={{ position:"absolute", width:560, height:560, top:-220, left:-140, borderRadius:"50%",
          filter:"blur(90px)", background:"radial-gradient(circle, rgba(56,212,232,0.16), transparent 68%)" }} />
        <div style={{ position:"absolute", width:520, height:520, top:-100, right:-180, borderRadius:"50%",
          filter:"blur(90px)", background:"radial-gradient(circle, rgba(213,81,159,0.12), transparent 68%)" }} />
      </div>

      {/* ── Top bar ── */}
      <div data-testid="cc-topbar" style={{ position:"relative", zIndex:1, flexShrink:0, display:"flex", alignItems:"center",
        justifyContent:"space-between", padding:"9px 22px",
        background:S1, backdropFilter:"blur(18px)", borderBottom:`1px solid ${BD}` }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:30, height:30, borderRadius:9, flexShrink:0,
            background:`linear-gradient(135deg, ${CC}, ${CC2})`,
            boxShadow:`0 0 0 1px rgba(255,255,255,0.12) inset, 0 6px 16px -6px ${CC}88`,
            display:"flex", alignItems:"center", justifyContent:"center" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M3 17h18M5 17V9l4-4h6l4 4v8M9 17V11h6v6" stroke="#04121c" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span style={{ fontFamily:HZ_DISPLAY, fontSize:19, fontWeight:700, color:TEXT }}>
            Command Center
          </span>
          <div style={{ display:"flex", alignItems:"center", gap:5, marginLeft:4 }}>
            <div style={{ width:8, height:8, borderRadius:"50%", background:"#22c55e",
              boxShadow:"0 0 6px #22c55e", animation:"cc-blink 2.5s ease-in-out infinite" }} />
            <span style={{ fontFamily:HZ_MONO, fontSize:11, color:MUTED }}>LIVE</span>
          </div>
          {/* Live clock */}
          <span style={{ fontFamily:HZ_MONO, fontSize:14, color:MUTED,
            fontVariantNumeric:"tabular-nums", letterSpacing:".04em" }}>
            {now.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" })}
            <span style={{ fontSize:10, marginLeft:5, opacity:.5 }}>
              UTC{now.toTimeString().match(/GMT([+-]\d{4})/)?.[1]?.replace(/(\d{2})(\d{2})/, "$1:$2") || ""}
            </span>
          </span>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button type="button" data-testid="cc-commands-btn" onClick={() => setCmdOpen(true)}
            style={{ padding:"5px 12px", borderRadius:6,
              border:`1px solid ${BD}`, background:"none",
              cursor:"pointer", fontFamily:HZ_MONO, fontSize:11, color:MUTED,
              transition:"all .15s" }}
            onMouseEnter={e=>{ e.currentTarget.style.borderColor=CC; e.currentTarget.style.color=CC; }}
            onMouseLeave={e=>{ e.currentTarget.style.borderColor=BD; e.currentTarget.style.color=MUTED; }}>
            ⌘K Commands
          </button>
          <button type="button" data-testid="cc-exit-btn" onClick={onExit}
            style={{ padding:"5px 12px", borderRadius:6,
              border:`1px solid ${BD}`, background:"none",
              cursor:"pointer", fontFamily:HZ_BODY, fontSize:11, color:MUTED,
              transition:"all .15s" }}
            onMouseEnter={e=>{ e.currentTarget.style.borderColor="#f0526b"; e.currentTarget.style.color="#f0526b"; }}
            onMouseLeave={e=>{ e.currentTarget.style.borderColor=BD; e.currentTarget.style.color=MUTED; }}>
            Exit ✕
          </button>
        </div>
      </div>

      {/* ── Body: left (flex:1 min-width:0) + right (fixed 300px) ── */}
      <div style={{ position:"relative", zIndex:1, flex:1, display:"flex", overflow:"hidden", minHeight:0 }}>

        {/* ══ LEFT ══════════════════════════════════════════════════════════ */}
        <div style={{ flex:1, minWidth:0, overflowY:"auto", padding:"18px 22px",
          borderRight:`1px solid ${BD}` }}>

          {/* Hero: fleet status ring + alert tile + TEU summary — bento, asymmetric spans.
              Consolidates the original 6 flat KPI tiles into 3 richer cards; every original
              click-to-filter interaction is preserved exactly (same setActiveFilter/filterKey
              logic), just redistributed — Active/Pending/Review now live as clickable legend
              rows on the Fleet Status ring, Overdue/Milestones as the two Needs Attention
              alert-stat rows, and the TEU headline keeps its own original filter:{{}} (explicit
              "show all") click behavior. Completed has no filter equivalent, same as before —
              it was never a clickable KPI tile, only ever a ring segment. */}
          {(() => {
            const filterKey = f => f.status ? `status:${f.status}` : f.milestoneBreach ? "msBreach" : "all";
            const isActiveFor = f => activeFilter && filterKey(activeFilter) === filterKey(f);
            const toggle = f => { setActiveFilter(af => af && filterKey(af) === filterKey(f) ? null : f); setShowAllRecent(false); };
            const legendItems = [
              { label:"Active", value: byStatus["Active"]||0, color:"#22c55e", filter:{ status:"Active" } },
              { label:"Pending", value: byStatus["Pending"]||0, color:"#fab219", filter:{ status:"Pending" } },
              { label:"Requires Review", value: byStatus["Requires Review"]||0, color:"#f0526b", filter:{ status:"Requires Review" } },
              { label:"Completed", value: byStatus["Completed"]||0, color:"#3987e5", filter:null },
            ];
            return (
          <div data-testid="cc-kpi-hero" style={{ display:"grid", gridTemplateColumns:"5fr 4fr 3fr", gap:16, marginBottom:20 }}>
            <div data-testid="cc-fleet-status-card" style={{ background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:20, padding:22 }}>
              <div style={{ fontFamily:HZ_DISPLAY, fontSize:14.5, fontWeight:600, color:TEXT, marginBottom:2 }}>Fleet Status</div>
              <div style={{ fontFamily:HZ_BODY, fontSize:12, color:MUTED, marginBottom:16 }}>{shipments.length} shipments across every active lane</div>
              <div style={{ display:"flex", alignItems:"center", gap:22, flexWrap:"wrap" }}>
                <StatusDonut segments={donutSegs} size={116} />
                <div style={{ display:"flex", flexDirection:"column", gap:7, flex:1, minWidth:160 }}>
                  {legendItems.map(s => {
                    const clickable = !!s.filter;
                    const active = clickable && isActiveFor(s.filter);
                    return (
                      <button key={s.label} type="button" disabled={!clickable}
                        data-testid={`cc-legend-${s.label.toLowerCase().replace(/\s+/g,"-")}`}
                        onClick={() => clickable && toggle(s.filter)}
                        style={{ display:"flex", alignItems:"center", gap:9, fontSize:12.5, background:"none",
                          border:"none", padding:active ? "3px 6px" : "3px 0", margin:0, textAlign:"left",
                          borderRadius:7, cursor:clickable ? "pointer" : "default",
                          backgroundColor: active ? `${s.color}18` : "transparent" }}>
                        <span style={{ width:8, height:8, borderRadius:3, background:s.color, flexShrink:0 }} />
                        <span style={{ color:MUTED, flex:1, fontFamily:HZ_BODY }}>{s.label}</span>
                        <span style={{ fontFamily:HZ_MONO, fontWeight:600, color:TEXT }}>{s.value}</span>
                        {active && <span style={{ fontFamily:HZ_MONO, fontSize:10, color:s.color }}>✓</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div data-testid="cc-needs-attention-card" style={{ background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:20, padding:22,
              display:"flex", flexDirection:"column", gap:14 }}>
              <div>
                <div style={{ fontFamily:HZ_DISPLAY, fontSize:14.5, fontWeight:600, color:TEXT }}>Needs Attention</div>
                <div style={{ fontFamily:HZ_BODY, fontSize:12, color:MUTED, marginTop:2 }}>Click a card to filter the list below</div>
              </div>
              {(() => {
                const overdueActive = isActiveFor({ status:"_overdue" });
                const msActive = isActiveFor({ milestoneBreach:true });
                return (<>
              <button type="button" data-testid="cc-overdue-btn" onClick={() => toggle({ status:"_overdue" })}
                style={{ display:"flex", alignItems:"center", gap:14, padding:"12px 14px", borderRadius:14, textAlign:"left",
                  background: overdueActive ? "rgba(240,82,107,.12)" : "rgba(255,255,255,.03)",
                  border:`1px solid ${overdueActive ? "rgba(240,82,107,.5)" : "rgba(240,82,107,.3)"}`,
                  cursor:"pointer", animation: overdueShipments.length > 0 && !overdueActive ? "cc-pulse-border 2s ease-in-out infinite" : "none" }}>
                <div style={{ fontFamily:HZ_DISPLAY, fontSize:26, fontWeight:700, lineHeight:1, color:"#f0526b" }}>{overdueShipments.length}</div>
                <div>
                  <div style={{ fontFamily:HZ_BODY, fontSize:12, fontWeight:600, color:TEXT }}>Overdue Shipments</div>
                  <div style={{ fontFamily:HZ_BODY, fontSize:11.5, color:MUTED }}>ETD passed, not closed</div>
                </div>
              </button>
              <button type="button" data-testid="cc-milestone-breach-btn" onClick={() => toggle({ milestoneBreach:true })}
                style={{ display:"flex", alignItems:"center", gap:14, padding:"12px 14px", borderRadius:14, textAlign:"left",
                  background: msActive ? "rgba(250,178,25,.14)" : "rgba(250,178,25,.06)",
                  border:`1px solid ${msActive ? "rgba(250,178,25,.5)" : "rgba(250,178,25,.3)"}`,
                  cursor:"pointer", animation: msOverdueSummary?.shipmentsWithBreach && !msActive ? "cc-pulse-border 2s ease-in-out infinite" : "none" }}>
                <div style={{ fontFamily:HZ_DISPLAY, fontSize:26, fontWeight:700, lineHeight:1, color:"#fab219" }}>{msOverdueSummary?.shipmentsWithBreach ?? "—"}</div>
                <div>
                  <div style={{ fontFamily:HZ_BODY, fontSize:12, fontWeight:600, color:TEXT }}>Milestone Breaches</div>
                  <div style={{ fontFamily:HZ_BODY, fontSize:11.5, color:MUTED }}>{msOverdueSummary ? `${msOverdueSummary.onTimePct}% fleet-wide on-time` : "loading…"}</div>
                </div>
              </button>
                </>);
              })()}
            </div>

            <button type="button" data-testid="cc-teu-card" onClick={() => toggle({})}
              style={{ background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:20, padding:22,
                textAlign:"left", cursor:"pointer", display:"block", width:"100%" }}>
              <div style={{ fontFamily:HZ_DISPLAY, fontSize:14.5, fontWeight:600, color:TEXT }}>TEU Booked</div>
              <div style={{ fontFamily:HZ_DISPLAY, fontSize:30, fontWeight:700, color:TEXT, marginTop:4 }}>
                {totalTEU} <span style={{ fontSize:13, color:MUTED, fontFamily:HZ_BODY, fontWeight:500 }}>TEU</span>
              </div>
              <div style={{ fontFamily:HZ_BODY, fontSize:12, color:MUTED, marginTop:4 }}>{containers.length} containers · {carrierStats.length} active carriers</div>
              <div style={{ display:"flex", gap:8, marginTop:16, flexWrap:"wrap" }}>
                <div style={{ flex:1, minWidth:60, textAlign:"center", background:"rgba(255,255,255,.03)", border:`1px solid ${BD}`, borderRadius:10, padding:"8px 4px" }}>
                  <div style={{ fontFamily:HZ_MONO, fontSize:15, fontWeight:600, color:"#22c55e" }}>{byStatus["Active"]||0}</div>
                  <div style={{ fontFamily:HZ_BODY, fontSize:9.5, color:MUTED, textTransform:"uppercase", letterSpacing:".06em", marginTop:2 }}>Active</div>
                </div>
                <div style={{ flex:1, minWidth:60, textAlign:"center", background:"rgba(255,255,255,.03)", border:`1px solid ${BD}`, borderRadius:10, padding:"8px 4px" }}>
                  <div style={{ fontFamily:HZ_MONO, fontSize:15, fontWeight:600, color:"#fab219" }}>{byStatus["Pending"]||0}</div>
                  <div style={{ fontFamily:HZ_BODY, fontSize:9.5, color:MUTED, textTransform:"uppercase", letterSpacing:".06em", marginTop:2 }}>Pending</div>
                </div>
                <div style={{ flex:1, minWidth:60, textAlign:"center", background:"rgba(255,255,255,.03)", border:`1px solid ${BD}`, borderRadius:10, padding:"8px 4px" }}>
                  <div style={{ fontFamily:HZ_MONO, fontSize:15, fontWeight:600, color:"#f0526b" }}>{byStatus["Requires Review"]||0}</div>
                  <div style={{ fontFamily:HZ_BODY, fontSize:9.5, color:MUTED, textTransform:"uppercase", letterSpacing:".06em", marginTop:2 }}>Review</div>
                </div>
              </div>
            </button>
          </div>
            );
          })()}

          {/* Row 2: Monthly trend + Expiring allocs + Milestone alerts (status donut folded into the hero above) */}
          <div style={{ display:"grid", gridTemplateColumns:"1.3fr 1fr 1fr", gap:16, marginBottom:20 }}>

            {/* Monthly booking trend */}
            <div data-testid="cc-monthly-bookings-card" style={{ background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:16, padding:"14px 16px",
              display:"flex", flexDirection:"column" }}>
              <SLabel>Monthly Bookings — last 6 months</SLabel>
              <div style={{ display:"flex", alignItems:"flex-end", gap:6, flex:1, minHeight:44 }}>
                {monthlyBookings.map((v, i) => {
                  const maxV = Math.max(...monthlyBookings, 1);
                  const h    = Math.round((v / maxV) * 44) + 4;
                  const d    = new Date();
                  d.setMonth(d.getMonth() - (5 - i));
                  const lbl  = d.toLocaleString("default", { month:"short" });
                  const isLast = i === monthlyBookings.length - 1;
                  return (
                    <div key={i} style={{ flex:1, display:"flex", flexDirection:"column",
                      alignItems:"center", justifyContent:"flex-end", gap:3 }}>
                      <span style={{ fontFamily:HZ_MONO, fontSize:11, color: isLast ? CC : MUTED,
                        fontWeight: isLast ? 700 : 400 }}>{v}</span>
                      <div style={{ width:"100%", height:h,
                        background: isLast ? `linear-gradient(180deg, ${CC}, ${CC2})` : `${CC}33`,
                        borderRadius:"5px 5px 0 0", transition:"height .4s ease" }} />
                      <span style={{ fontFamily:HZ_BODY, fontSize:10, color:MUTED }}>{lbl}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Expiring allocations */}
            <div data-testid="cc-expiring-configs-card" style={{ background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:16, padding:"14px 16px",
              minWidth:180 }}>
              <SLabel>Expiring configs (30d)</SLabel>
              {expiringAllocs.length === 0 ? (
                <div style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED, padding:"8px 0" }}>
                  None expiring soon ✓
                </div>
              ) : expiringAllocs.slice(0,5).map(a => {
                const daysLeft = Math.round((new Date(a.endDate) - new Date()) / 86400000);
                return (
                  <div key={a.id} style={{ display:"flex", alignItems:"center", gap:8,
                    padding:"5px 0", borderBottom:`1px solid ${BD}` }}>
                    <span style={{ fontFamily:HZ_MONO, fontSize:13, fontWeight:700,
                      color:CC, minWidth:60 }}>{a.carrierCode}</span>
                    <span style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED, flex:1 }}>
                      {a.pol}›{a.pod}
                    </span>
                    <span style={{ fontFamily:HZ_MONO, fontSize:13, fontWeight:700,
                      color: daysLeft <= 7 ? "#f0526b" : "#fab219" }}>
                      {daysLeft}d
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Milestone alerts breakdown (TKT-550J25 / TKT-Q09G0T) — same visual language as
                "Expiring configs" alongside it; also the Command Center's always-on surfacing of
                the same feed the notification bell's Milestone Alerts section pulls from. */}
            <div data-testid="cc-milestone-alerts-card" style={{ background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:16, padding:"14px 16px",
              minWidth:190 }}>
              <SLabel>Milestone Alerts</SLabel>
              {!msOverdueSummary ? (
                <div style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED, padding:"8px 0" }}>Loading…</div>
              ) : msOverdueSummary.byMilestoneKey.length === 0 ? (
                <div style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED, padding:"8px 0" }}>
                  Nothing overdue ✓
                </div>
              ) : msOverdueSummary.byMilestoneKey.slice(0, 5).map(m => (
                <div key={m.milestoneKey} style={{ display:"flex", alignItems:"center", gap:8,
                  padding:"5px 0", borderBottom:`1px solid ${BD}` }}>
                  <span style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED, flex:1,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {m.label}
                  </span>
                  <span style={{ fontFamily:HZ_MONO, fontSize:13, fontWeight:700, color:"#fab219" }}>
                    {m.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Row 3: Carrier consumption + Top routes */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:20 }}>

            {/* Carrier consumption ranking */}
            <div data-testid="cc-carrier-consumption-card" style={{ background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:16, padding:"14px 16px" }}>
              <SLabel>Carrier Consumption (TEU)</SLabel>
              {carrierStats.length === 0 ? (
                <div style={{ fontFamily:HZ_BODY, fontSize:12, color:MUTED, padding:"8px 0" }}>No data</div>
              ) : carrierStats.map((c, i) => {
                // TKT-LI5KYW — on-time % as an added column on this same ranking, so a
                // chronically-late carrier doesn't look identical to an always-on-time one just
                // because both move the same TEU. Only rendered once real AIS-confirmed samples
                // exist for that carrier — a carrier with zero samples isn't "bad," just unproven.
                const otp = carrierScorecardByCode[c.code];
                const badge = carrierBadgeColors(c.code);
                return (
                <div key={c.code} style={{ marginBottom:11 }} data-testid={`cc-carrier-row-${c.code}`}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:5 }}>
                    <div style={{ width:24, height:24, borderRadius:7, flexShrink:0, display:"flex",
                      alignItems:"center", justifyContent:"center", fontFamily:HZ_DISPLAY, fontWeight:700,
                      fontSize:9.5, color:badge.color, background:badge.background }}>
                      {c.code.slice(0,2)}
                    </div>
                    <span style={{ fontFamily:HZ_MONO, fontSize:14, fontWeight:700,
                      color: i===0 ? CC : TEXT }}>{c.code}</span>
                    <span style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED, flex:1,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {c.name !== c.code ? c.name : ""}
                    </span>
                    {otp && (
                      <span title={`${otp.onTimeCount}/${otp.sampleSize} AIS-confirmed legs on time`}
                        style={{ fontFamily:HZ_MONO, fontSize:10, fontWeight:700, padding:"1px 6px",
                          borderRadius:4, color: otp.onTimePct >= 80 ? "#22c55e" : otp.onTimePct >= 50 ? "#fab219" : "#f0526b",
                          background: `${otp.onTimePct >= 80 ? "#22c55e" : otp.onTimePct >= 50 ? "#fab219" : "#f0526b"}18`,
                          border:`1px solid ${otp.onTimePct >= 80 ? "#22c55e" : otp.onTimePct >= 50 ? "#fab219" : "#f0526b"}44` }}>
                        {otp.onTimePct}% on-time
                      </span>
                    )}
                    <span style={{ fontFamily:HZ_MONO, fontSize:13, fontWeight:700,
                      color: i===0 ? CC : TEXT }}>
                      {c.consumed} TEU
                    </span>
                    {c.pct !== null && (
                      <span style={{ fontFamily:HZ_MONO, fontSize:12,
                        color: c.pct >= 100 ? "#f0526b" : c.pct >= 80 ? "#fab219" : MUTED }}>
                        {c.pct}%
                      </span>
                    )}
                  </div>
                  <Bar pct={Math.round(c.consumed / maxConsumed * 100)} color={i===0 ? CC : "#3b82f6"} />
                  {c.allocated > 0 && (
                    <div style={{ fontFamily:HZ_BODY, fontSize:10, color:MUTED, marginTop:2 }}>
                      {c.consumed} / {c.allocated} allocated
                    </div>
                  )}
                </div>
                );
              })}
            </div>

            {/* Top routes */}
            <div data-testid="cc-top-routes-card" style={{ background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:16, padding:"14px 16px" }}>
              <SLabel>Top Routes by Volume</SLabel>
              {topRoutes.length === 0 ? (
                <div style={{ fontFamily:HZ_BODY, fontSize:12, color:MUTED, padding:"8px 0" }}>No data</div>
              ) : topRoutes.map(([route, count], i) => (
                <div key={route} style={{ marginBottom:11 }}>
                  <div style={{ display:"flex", alignItems:"baseline", gap:6, marginBottom:4 }}>
                    <span style={{ fontFamily:HZ_MONO, fontSize:13, fontWeight:700,
                      color: i===0 ? "#22c55e" : TEXT, flex:1 }}>
                      {route}
                    </span>
                    <span style={{ fontFamily:HZ_MONO, fontSize:14, fontWeight:700,
                      color: i===0 ? "#22c55e" : TEXT }}>
                      {count}
                    </span>
                    <span style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED }}>shipments</span>
                  </div>
                  <Bar pct={Math.round(count / maxRoute * 100)} color="#22c55e" height={4} />
                </div>
              ))}
            </div>
          </div>

          {/* Row 3a: Transit-time variance by lane (TKT-PZ3JS2) — planned vs the AIS-confirmed
              actual ETD->ETA span, worst-variance lane first. */}
          {laneVariance.length > 0 && (
            <div data-testid="cc-transit-variance-card" style={{ background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:16,
              padding:"14px 16px", marginBottom:20 }}>
              <SLabel>Transit-Time Variance by Lane</SLabel>
              {laneVariance.map(l => {
                const over = l.varianceDays != null && l.varianceDays > 0;
                const vColor = l.varianceDays == null ? MUTED : over ? "#f0526b" : "#22c55e";
                return (
                  <div key={l.tradeLane} style={{ display:"flex", alignItems:"center", gap:12,
                    padding:"7px 0", borderBottom:`1px solid ${BD}` }}>
                    <span style={{ fontFamily:HZ_MONO, fontSize:12, fontWeight:700, color:TEXT,
                      minWidth:150, flexShrink:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {l.tradeLane}
                    </span>
                    <span style={{ fontFamily:HZ_BODY, fontSize:10, color:MUTED, flexShrink:0, minWidth:110 }}>
                      planned {l.plannedAvgDays ?? "—"}d · actual {l.actualAvgDays}d
                    </span>
                    <span style={{ flexShrink:0 }}>
                      <Sparkline values={l.trend} color={vColor} width={80} height={22} />
                    </span>
                    <span style={{ fontFamily:HZ_MONO, fontSize:12, fontWeight:700, color:vColor,
                      marginLeft:"auto", flexShrink:0 }}>
                      {l.varianceDays == null ? "no plan" : `${over ? "+" : ""}${l.varianceDays}d`}
                    </span>
                    <span style={{ fontFamily:HZ_BODY, fontSize:10, color:MUTED, flexShrink:0 }}>
                      n={l.sampleSize}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Row 3b: Exception queue (TKT-FKJPBO) */}
          {exceptionQueue && (
            exceptionQueue.scheduleSlip.length + exceptionQueue.unconfirmedBooking.length + exceptionQueue.stalledMilestone.length > 0
          ) && (
            <ExceptionQueueCard queue={exceptionQueue}
              onOpenShipment={id => window.open(`${window.location.pathname}#shipments/${id}`, "_blank")} />
          )}

          {/* Row 4: Integration board overdue */}
          {(overdueTickets.length > 0 || dueSoonTickets.length > 0) && (
            <TicketAlertCard
              overdueTickets={overdueTickets}
              dueSoonTickets={dueSoonTickets}
              today={today}
              onNavigate={onNavigate}
            />
          )}

          {/* Row 5: Recent / filtered shipments */}
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
            <div style={{ fontFamily:HZ_MONO, fontSize:13, fontWeight:700, color:MUTED,
              textTransform:"uppercase", letterSpacing:".14em" }}>
              {activeFilter
                ? activeFilter.status === "_overdue" ? "Overdue Shipments"
                  : activeFilter.status ? `${activeFilter.status} Shipments`
                  : "All Shipments"
                : "Recent Active Shipments"}
            </div>
            <span style={{ fontFamily:HZ_MONO, fontSize:11, color:MUTED }} data-testid="cc-recent-shipments-count">
              {visibleRecentShipments.length} of {recentShipments.length} shown
            </span>
            {activeFilter && (
              <button type="button" data-testid="cc-clear-filter-btn" onClick={() => setActiveFilter(null)}
                style={{ marginLeft:"auto", fontFamily:HZ_MONO, fontSize:11, color:MUTED,
                  background:"none", border:`1px solid ${BD}`, borderRadius:4,
                  padding:"4px 10px", cursor:"pointer", lineHeight:1 }}
                onMouseEnter={e => { e.currentTarget.style.color="#f0526b"; e.currentTarget.style.borderColor="#f0526b55"; }}
                onMouseLeave={e => { e.currentTarget.style.color=MUTED; e.currentTarget.style.borderColor=BD; }}>
                ✕ clear
              </button>
            )}
          </div>
          <div data-testid="cc-recent-shipments" style={{ display:"flex", flexDirection:"column", gap:3 }}>
            {recentShipments.length === 0 ? (
              <div style={{ fontFamily:HZ_BODY, fontSize:12, color:MUTED, padding:"16px 0" }}>
                No active shipments.
              </div>
            ) : visibleRecentShipments.map(s => {
              const dot      = STATUS_DOT[s.status] || MUTED;
              const teu      = shipTEU(s.id);
              const isOD     = s.etd && s.etd < today;
              const daysLate = isOD ? Math.round((new Date(today) - new Date(s.etd)) / 86400000) : 0;
              return (
                <div key={s.id} data-testid={`cc-shipment-row-${s.id}`}
                  onClick={() => setPreviewShipment(s)}
                  style={{ display:"flex", alignItems:"center", gap:10,
                    padding:"9px 14px", borderRadius:7,
                    background: isOD ? `${S2}` : S2,
                    border:`1px solid ${isOD ? "#f0526b33" : BD}`,
                    cursor:"pointer", transition:"border-color .12s" }}
                  onMouseEnter={e => e.currentTarget.style.borderColor=isOD ? "#f0526baa" : `${CC}55`}
                  onMouseLeave={e => e.currentTarget.style.borderColor=isOD ? "#f0526b33" : BD}>
                  <div style={{ fontFamily:HZ_MONO, fontSize:13, fontWeight:700,
                    color:TEXT, minWidth:110, flexShrink:0 }}>{s.id}</div>
                  <div style={{ flex:1, fontFamily:HZ_BODY, fontSize:11, color:MUTED,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {s.pol && s.pod ? `${s.pol} → ${s.pod}` : "—"}
                  </div>
                  {s.carrierCode && (
                    <div style={{ fontFamily:HZ_MONO, fontSize:11, padding:"2px 8px",
                      borderRadius:4, background:BG, border:`1px solid ${BD}`,
                      color:MUTED, flexShrink:0 }}>{s.carrierCode}</div>
                  )}
                  {teu > 0 && (
                    <div style={{ fontFamily:HZ_MONO, fontSize:11, padding:"2px 8px",
                      borderRadius:4, background:`${CC}14`, border:`1px solid ${CC}33`,
                      color:CC2, flexShrink:0 }}>{teu} TEU</div>
                  )}
                  {isOD ? (
                    <div style={{ fontFamily:HZ_MONO, fontSize:11, fontWeight:700,
                      color:"#f0526b", flexShrink:0 }}>+{daysLate}d late</div>
                  ) : s.etd ? (
                    <div style={{ fontFamily:HZ_MONO, fontSize:11, color:MUTED, flexShrink:0 }}>
                      {s.etd}
                    </div>
                  ) : null}
                  <div style={{ width:8, height:8, borderRadius:"50%", flexShrink:0,
                    background:dot, boxShadow:`0 0 5px ${dot}` }} />
                </div>
              );
            })}
          </div>
          {recentShipments.length > 10 && (
            <button type="button" data-testid="cc-recent-shipments-toggle"
              onClick={() => setShowAllRecent(v => !v)}
              style={{ width:"100%", marginTop:6, padding:"7px 0", borderRadius:7,
                border:`1px solid ${BD}`, background:"none", cursor:"pointer",
                display:"flex", alignItems:"center", justifyContent:"center", gap:6,
                fontFamily:HZ_MONO, fontSize:11, color:MUTED, transition:"all .12s" }}
              onMouseEnter={e => { e.currentTarget.style.color=CC; e.currentTarget.style.borderColor=`${CC}55`; }}
              onMouseLeave={e => { e.currentTarget.style.color=MUTED; e.currentTarget.style.borderColor=BD; }}>
              {showAllRecent
                ? <>▲▲ Show fewer</>
                : <>▼▼ Show all {recentShipments.length}</>}
            </button>
          )}
        </div>

        {/* ══ RIGHT (fixed width, never squeezed) ══════════════════════════
            Plain flex column with a gap, no shared background/border-left — matches the
            approved mockup's `.rail` treatment, where every section below is its own
            independent floating "glass" card (bordered, rounded, blurred), not one
            continuous bordered strip. */}
        <div style={{ flexShrink:0, width:300,
          display:"flex", flexDirection:"column", gap:16,
          padding:"18px 16px", minHeight:0, overflowY:"auto" }}>

          {/* Orb + brand */}
          <div data-testid="cc-ai-brand" style={{ flexShrink:0, position:"relative", overflow:"hidden",
            background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:20,
            padding:"24px 20px 20px",
            display:"flex", flexDirection:"column", alignItems:"center", gap:10, textAlign:"center" }}>
            <div aria-hidden="true" style={{ position:"absolute", inset:0, pointerEvents:"none",
              background:"radial-gradient(ellipse at 50% 30%, rgba(144,133,233,.16), transparent 70%)" }} />
            {/* AiOrb is a genuinely shared component (also used by AppSettingsPage.jsx's orb-style
                picker) — its own CC/CC2 are hardcoded orange, module-local to that file, not
                sourced from this page's palette. Recoloring it directly would leak this
                page-scoped restyle into Settings too. A hue-rotate wrapper gets the same visual
                result (orange -> cyan/violet) without touching shared code, same principle as
                every other "page-scoped, never touch shared primitives" call this restyle makes. */}
            <div style={{ position:"relative", filter:"hue-rotate(165deg) saturate(1.15)" }}>
              <AiOrb size={92} orbStyle={orbStyle} />
            </div>
            <div style={{ position:"relative" }}>
              <div style={{ fontFamily:HZ_DISPLAY, fontSize:15, fontWeight:700,
                letterSpacing:".08em", textTransform:"uppercase",
                background:`linear-gradient(90deg, ${CC}, ${HZ_VIOLET})`,
                WebkitBackgroundClip:"text", backgroundClip:"text", color:"transparent" }}>
                CargoDesk AI
              </div>
              <div style={{ fontFamily:HZ_BODY, fontSize:10.5, color:MUTED,
                letterSpacing:".06em", marginTop:4, textTransform:"uppercase" }}>
                Intelligent freight assistant
              </div>
            </div>
          </div>

          {/* Allocation utilization mini-summary */}
          <div data-testid="cc-allocation-utilization" style={{ flexShrink:0,
            background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:20,
            padding:"18px 20px" }}>
            <SLabel>Allocation Utilization</SLabel>
            {allocations.filter(a => a.endDate >= today).slice(0, 4).map(a => {
              const consumed = teuByCarrier[a.carrierCode] || 0;
              const pct = a.allocatedTEU > 0 ? Math.round(consumed / a.allocatedTEU * 100) : 0;
              return (
                <div key={a.id} style={{ marginBottom:11 }}>
                  <div style={{ display:"flex", justifyContent:"space-between",
                    fontFamily:HZ_MONO, fontSize:11.5, marginBottom:4 }}>
                    <span style={{ color:TEXT }}>{a.carrierCode}</span>
                    <span style={{ fontWeight:600, color: pct>=100 ? "#f0526b" : pct>=80 ? "#fab219" : MUTED }}>
                      {pct}%
                    </span>
                  </div>
                  <Bar pct={pct} color={CC} height={6} />
                </div>
              );
            })}
            {allocations.filter(a => a.endDate >= today).length === 0 && (
              <div style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED }}>
                No active allocations
              </div>
            )}
          </div>

          {/* Weather + FX card */}
          <div data-testid="cc-weather-widget" style={{ flexShrink:0,
            background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:20,
            padding:"18px 20px" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
              marginBottom:8 }}>
              <SLabel>Weather</SLabel>
              <button type="button" data-testid="cc-weather-edit-btn"
                onClick={() => setWxInput(v => !v)}
                style={{ fontFamily:HZ_MONO, fontSize:12, color:MUTED, background:"none",
                  border:"none", cursor:"pointer", padding:0, marginTop:-10 }}>
                {wxInput ? "✕" : "✎"}
              </button>
            </div>
            {wxInput ? (
              <form onSubmit={e => {
                e.preventDefault();
                const city = e.target.city.value.trim();
                if (city) {
                  localStorage.setItem("cc_wx_city", city);
                  setWxCity(city);
                  setWeather(null);
                  fetchWeatherByCity(city, setWeather);
                }
                setWxInput(false);
              }}>
                <input name="city" data-testid="cc-weather-city-input" defaultValue={wxCity} autoFocus
                  style={{ width:"100%", background:BG, border:`1px solid ${CC}44`,
                    borderRadius:5, padding:"4px 8px", fontFamily:HZ_MONO,
                    fontSize:12, color:TEXT, outline:"none", boxSizing:"border-box" }} />
              </form>
            ) : weather ? (
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:18 }}>{weatherIcon(weather.code)}</span>
                <span style={{ fontFamily:HZ_MONO, fontSize:17, fontWeight:700,
                  color:TEXT, fontVariantNumeric:"tabular-nums" }}>{weather.temp}°C</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {weather.city}{weather.country ? `, ${weather.country}` : ""}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ fontFamily:HZ_BODY, fontSize:11, color:MUTED }}>
                Loading…
              </div>
            )}

            <div style={{ height:1, background:BD, margin:"14px 0" }} />

            <div data-testid="cc-fx-converter">
              <SLabel>FX Converter</SLabel>
              <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
                <input data-testid="cc-fx-amount-input" value={fxAmt} onChange={e => setFxAmt(e.target.value)}
                  style={{ width:68, background:"rgba(255,255,255,.04)", border:`1px solid ${BD}`, borderRadius:7,
                    padding:"6px 9px", fontFamily:HZ_MONO, fontSize:11.5, color:TEXT,
                    outline:"none", textAlign:"right" }} />
                <select value={fxFrom} data-testid="cc-fx-from-select"
                  onChange={e => { setFxFrom(e.target.value); localStorage.setItem("cc_fx_from", e.target.value); }}
                  style={{ background:"rgba(255,255,255,.04)", border:`1px solid ${BD}`, borderRadius:7,
                    padding:"6px 4px", fontFamily:HZ_MONO, fontSize:11.5, color:TEXT,
                    outline:"none", cursor:"pointer", flex:1 }}>
                  {FX_CCYS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <button type="button" data-testid="cc-fx-swap-btn" onClick={swapFx}
                  style={{ padding:"5px 6px", borderRadius:7, border:`1px solid ${BD}`,
                    background:"none", cursor:"pointer", color:CC, fontSize:12,
                    fontFamily:HZ_MONO, flexShrink:0 }}>⇄</button>
                <select value={fxTo} data-testid="cc-fx-to-select"
                  onChange={e => { setFxTo(e.target.value); localStorage.setItem("cc_fx_to", e.target.value); }}
                  style={{ background:"rgba(255,255,255,.04)", border:`1px solid ${BD}`, borderRadius:7,
                    padding:"6px 4px", fontFamily:HZ_MONO, fontSize:11.5, color:TEXT,
                    outline:"none", cursor:"pointer", flex:1 }}>
                  {FX_CCYS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              {fxResult !== null && (
                <div style={{ fontFamily:HZ_MONO, fontSize:16, fontWeight:700, color:CC }}>
                  {fxResult.toLocaleString("en-US", { minimumFractionDigits:2, maximumFractionDigits:2 })}
                  <span style={{ fontFamily:HZ_BODY, fontSize:10.5, color:MUTED,
                    fontWeight:500, marginLeft:5 }}>{fxTo}</span>
                </div>
              )}
            </div>
          </div>

          {/* AI Assistant / chat card */}
          <div data-testid="cc-ai-chat-panel" style={{ flex:1, minHeight:120, display:"flex", flexDirection:"column",
            background:S1, backdropFilter:"blur(18px)", border:`1px solid ${BD}`, borderRadius:20,
            padding:"16px 16px 14px", overflow:"hidden" }}>
            <SLabel>AI Assistant</SLabel>
            <AiChatPanel />
          </div>
        </div>
      </div>

      {cmdOpen && <CommandPalette onClose={() => setCmdOpen(false)} />}

      {previewShipment && (
        <ShipmentPreviewModal
          shipment={previewShipment}
          containers={containers}
          carriers={carriers}
          onClose={() => setPreviewShipment(null)}
        />
      )}
    </div>
  );
}
