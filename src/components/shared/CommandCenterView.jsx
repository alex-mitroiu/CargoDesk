import { useState, useEffect, useRef } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { AiOrb } from "./AiOrb";
import { IconSettings, IconAnchor, AnyIcon } from "../primitives/Icon";

// Palette — mutable module vars so sub-components defined outside the main function see the
// correct values. Updated at the start of each CommandCenterView render based on isDark prop.
let BG    = "#030a14";
let S1    = "#061020";
let S2    = "#0a1828";
let BD    = "#0e1f35";
let CC    = "#f97316";
let CC2   = "#fb923c";
let MUTED = "#3a5a78";
let TEXT  = "#c8d8e8";
let CCON  = "#050e1a";  // text on top of CC-coloured background

const DARK_PAL = { BG:"#030a14", S1:"#061020", S2:"#0a1828", BD:"#0e1f35",
  CC:"#f97316", CC2:"#fb923c", MUTED:"#3a5a78", TEXT:"#c8d8e8", CCON:"#050e1a" };

// ─── CSS keyframes (injected once) ───────────────────────────────────────────
const CC_STYLES = `
@keyframes cc-cw  { to { transform: rotate(360deg);  } }
@keyframes cc-ccw { to { transform: rotate(-360deg); } }
@keyframes cc-pulse {
  0%,100% { box-shadow: 0 0 14px 6px rgba(249,115,22,.4), 0 0 36px 14px rgba(249,115,22,.15); }
  50%     { box-shadow: 0 0 26px 12px rgba(249,115,22,.7), 0 0 60px 24px rgba(249,115,22,.28); }
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
  0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,.15); }
  50%     { box-shadow: 0 0 0 4px rgba(239,68,68,.35); }
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
        background: pct >= 100 ? "#ef4444" : pct >= 80 ? "#f59e0b" : color,
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
      <div style={{ width:560, background:S1,
        border:`1px solid ${CC}55`, borderRadius:14, overflow:"hidden",
        boxShadow:`0 32px 80px rgba(0,0,0,.7)`, animation:"cc-cmd-in .14s ease" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ padding:"13px 18px", borderBottom:`1px solid ${BD}`,
          display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ color:CC, fontSize:11, fontWeight:700 }}>⌘</span>
          <input ref={ref} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Search commands…"
            style={{ flex:1, background:"none", border:"none", outline:"none",
              fontFamily:"sans-serif", fontSize:12, color:TEXT, caretColor:CC }} />
          <kbd style={{ fontFamily:"monospace", fontSize:10, color:MUTED,
            border:`1px solid ${BD}`, borderRadius:4, padding:"2px 5px" }}>Esc</kbd>
        </div>
        <div style={{ maxHeight:330, overflowY:"auto" }}>
          {list.map((c,i) => (
            <div key={c.key}
              style={{ display:"flex", alignItems:"center", gap:12, padding:"11px 18px",
                cursor:"pointer", background: i===idx ? `${CC}12` : "none",
                borderLeft:`3px solid ${i===idx ? CC : "transparent"}` }}
              onMouseEnter={() => setIdx(i)} onClick={() => go(c)}>
              <span style={{ width:24, display:"flex", alignItems:"center", justifyContent:"center" }}><AnyIcon icon={c.icon} size={16} /></span>
              <span style={{ fontFamily:"sans-serif", fontSize:11, color:TEXT, flex:1 }}>{c.label}</span>
            </div>
          ))}
        </div>
        <div style={{ padding:"7px 18px", borderTop:`1px solid ${BD}`,
          display:"flex", gap:16, fontFamily:"monospace", fontSize:10, color:MUTED }}>
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
      fontFamily:"sans-serif", fontSize:12, color:MUTED }}>Initialising…</div>
  );

  if (!enabled) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center", gap:8, padding:20, textAlign:"center" }}>
      <div style={{ fontSize:22, opacity:.12 }}>✦</div>
      <div style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED, lineHeight:1.7 }}>
        AI Agent not configured.<br/>Enable in <strong style={{ color:TEXT }}>Settings → API Controls → AI Agent</strong>.
      </div>
    </div>
  );

  return (
    <>
      <div style={{ flex:1, overflowY:"auto", padding:"10px 12px",
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
                  fontFamily:"monospace", fontSize:8, fontWeight:700, color:CCON }}>✦</div>
              )}
              <div style={{ maxWidth:"84%",
                background: isUser ? CC : S1,
                color: isUser ? CCON : TEXT,
                border: isUser ? "none" : `1px solid ${BD}`,
                borderRadius: isUser ? "9px 9px 2px 9px" : "9px 9px 9px 2px",
                padding:"7px 10px", fontFamily:"sans-serif", fontSize:11, lineHeight:1.55 }}>
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
              fontFamily:"monospace", fontSize:8, fontWeight:700, color:CCON }}>✦</div>
            <div style={{ background:S1, border:`1px solid ${BD}`,
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
      <div style={{ padding:"8px 10px", borderTop:`1px solid ${BD}`, flexShrink:0 }}>
        <div style={{ display:"flex", gap:6, alignItems:"flex-end" }}>
          <textarea ref={inputRef} value={input}
            onChange={e => setInput(e.target.value)} onKeyDown={onKey} rows={1}
            placeholder="Ask about shipments, carriers…"
            style={{ flex:1, resize:"none", background:S1, border:`1px solid ${BD}`,
              borderRadius:7, padding:"6px 9px", fontFamily:"sans-serif", fontSize:11,
              color:TEXT, outline:"none", lineHeight:1.4, maxHeight:72, overflowY:"auto" }} />
          <button type="button" onClick={send} disabled={loading || !input.trim()}
            style={{ padding:"6px 11px", borderRadius:7, border:"none", flexShrink:0,
              background: (loading||!input.trim()) ? S2 : CC,
              color: (loading||!input.trim()) ? MUTED : CCON,
              cursor: (loading||!input.trim()) ? "default" : "pointer",
              fontFamily:"monospace", fontSize:11, fontWeight:700, lineHeight:1 }}>↑</button>
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
      <span style={{ fontFamily:"monospace", fontSize:10, color:MUTED, minWidth:110, flexShrink:0 }}>{label}</span>
      <span style={{ fontFamily:"monospace", fontSize:11, color:TEXT, wordBreak:"break-word" }}>{value}</span>
    </div>
  ) : null;

  const STATUS_COLOR = { Active:"#22c55e", Pending:"#f59e0b", "Requires Review":"#ef4444",
    Completed:"#3b82f6", Cancelled:"#475569" };
  const sc = STATUS_COLOR[s.status] || MUTED;

  const openInNewTab = () => {
    window.open(`${window.location.pathname}#shipments/${s.id}`, "_blank");
    onClose();
  };

  const btnBase = {
    padding:"4px 10px", borderRadius:6, border:`1px solid ${BD}`,
    background:"none", cursor:"pointer", fontFamily:"monospace", fontSize:12,
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
      <div style={{
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
          padding:"13px 16px", background:S1, borderBottom:`1px solid ${BD}` }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontFamily:"monospace", fontSize:13, fontWeight:900,
              color:TEXT, letterSpacing:".04em", overflow:"hidden",
              textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.id}</div>
            {s.bookingRef && (
              <div style={{ fontFamily:"monospace", fontSize:10, color:MUTED, marginTop:2 }}>
                Booking {s.bookingRef}
              </div>
            )}
          </div>
          <span style={{ flexShrink:0, fontFamily:"monospace", fontSize:10, fontWeight:700,
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
          <button type="button" onClick={onClose}
            style={btnBase}
            onMouseEnter={e => { e.currentTarget.style.borderColor="#ef4444"; e.currentTarget.style.color="#ef4444"; }}
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
                  fontFamily:"monospace", fontSize: isDoor ? 11 : 18,
                  fontWeight: isDoor ? 600 : 900,
                  color: isDoor ? MUTED : TEXT,
                  fontStyle: isDoor ? "italic" : "normal",
                }}>{code}</div>
                {sub && <div style={{ fontFamily:"sans-serif", fontSize:10, color:MUTED }}>{sub}</div>}
              </div>
            );
            const Arrow = ({ label }) => (
              <div style={{ flex:1, textAlign:"center", minWidth:40 }}>
                <div style={{ height:1, background:BD, position:"relative" }}>
                  {label && <span style={{ position:"absolute", top:-8, left:"50%", transform:"translateX(-50%)",
                    fontFamily:"monospace", fontSize:9, color:CC, background:S1, padding:"0 6px",
                    whiteSpace:"nowrap" }}>{label}</span>}
                </div>
              </div>
            );
            return (
              <div style={{ marginBottom:16, padding:"12px 16px", background:S1, borderRadius:9, border:`1px solid ${BD}` }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  {pickupLabel && <><Node code={pickupLabel} isDoor /><Arrow /></>}
                  <Node code={s.pol || "—"} sub={s.polName} />
                  <Arrow label={`${s.carrierCode || "—"}${carrier?.name ? ` · ${carrier.name}` : ""}`} />
                  <Node code={s.pod || "—"} sub={s.podName} />
                  {deliveryLabel && <><Arrow /><Node code={deliveryLabel} isDoor /></>}
                </div>
                {(s.vessel || s.routingTerm) && (
                  <div style={{ fontFamily:"monospace", fontSize:9, color:MUTED, marginTop:10,
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
              <div style={{ fontFamily:"monospace", fontSize:9, fontWeight:700, color:MUTED,
                textTransform:"uppercase", letterSpacing:".12em", marginBottom:8 }}>
                Containers — {ctrs.length} unit{ctrs.length > 1 ? "s" : ""}, {teu} TEU
              </div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                {ctrs.map(c => (
                  <div key={c.id} style={{ fontFamily:"monospace", fontSize:10, padding:"4px 9px",
                    borderRadius:6, background:S1, border:`1px solid ${BD}`, color:TEXT }}>
                    {c.size}ft {c.type}
                    {c.containerNumber ? <span style={{ color:MUTED }}> · {c.containerNumber}</span> : ""}
                    {c.isDg ? <span style={{ color:"#ef4444", marginLeft:4 }}>DG</span> : ""}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer */}
          <div style={{ display:"flex", justifyContent:"flex-end", paddingTop:4 }}>
            <button type="button" onClick={openInNewTab}
              style={{ padding:"7px 16px", borderRadius:7, border:`1px solid ${CC}55`,
                background:"none", cursor:"pointer", fontFamily:"monospace", fontSize:11,
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
  <div style={{ fontFamily:"monospace", fontSize:11, fontWeight:700, color:MUTED,
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
const PRIORITY_COLOR = { High:"#ef4444", Medium:"#f59e0b", Low:"#3b82f6" };

// ─── Integration board overdue card ──────────────────────────────────────────
function TicketAlertCard({ overdueTickets, dueSoonTickets, today, onNavigate }) {
  const [ticketTab, setTicketTab] = useState("overdue");
  const shown = ticketTab === "overdue" ? overdueTickets : dueSoonTickets;
  const daysLate  = iso => Math.round((new Date(today) - new Date(iso)) / 86400000);
  const daysUntil = iso => Math.round((new Date(iso)   - new Date(today)) / 86400000);
  return (
    <div style={{ marginBottom:20, background:S1, border:`1px solid ${BD}`,
      borderTop:`2px solid #ef444488`, borderRadius:9, overflow:"hidden" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px 8px" }}>
        <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700,
          color:"#ef4444", textTransform:"uppercase", letterSpacing:".12em" }}>
          🎫 Integration Board
        </span>
        <div style={{ display:"flex", gap:6, marginLeft:4 }}>
          {[
            { key:"overdue",   label:"Overdue",       count:overdueTickets.length,  color:"#ef4444" },
            { key:"due-soon",  label:"Due this week", count:dueSoonTickets.length,  color:"#f59e0b" },
          ].map(tab => {
            const active = ticketTab === tab.key;
            return (
              <button key={tab.key} type="button" onClick={() => setTicketTab(tab.key)}
                style={{ display:"flex", alignItems:"center", gap:5,
                  padding:"3px 10px", borderRadius:10,
                  fontFamily:"monospace", fontSize:11, fontWeight:700,
                  cursor:"pointer", transition:"all .12s",
                  background: active ? `${tab.color}22` : "none",
                  color: active ? tab.color : MUTED,
                  border: active ? `1px solid ${tab.color}55` : `1px solid ${BD}` }}>
                {tab.label}
                {tab.count > 0 && (
                  <span style={{ fontFamily:"monospace", fontSize:12,
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
          style={{ marginLeft:"auto", fontFamily:"monospace", fontSize:11, color:MUTED,
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
          <div style={{ padding:"14px 14px 16px", fontFamily:"sans-serif",
            fontSize:11, color:MUTED, fontStyle:"italic" }}>
            {ticketTab === "overdue" ? "No overdue tickets." : "Nothing due in the next 7 days."}
          </div>
        ) : shown.map(t => {
          const pColor = PRIORITY_COLOR[t.priority] || MUTED;
          const isOD   = ticketTab === "overdue";
          const dLabel = isOD ? `+${daysLate(t.dueDate)}d` : `${daysUntil(t.dueDate)}d`;
          const dColor = isOD ? "#ef4444" : (daysUntil(t.dueDate) <= 2 ? "#f59e0b" : MUTED);
          return (
            <div key={t.id} style={{ display:"flex", alignItems:"center", gap:8,
              padding:"7px 14px", borderTop:`1px solid ${BD}` }}>
              <div style={{ width:8, height:8, borderRadius:"50%", flexShrink:0,
                background:pColor, boxShadow:`0 0 4px ${pColor}88` }} />
              <span style={{ fontFamily:"monospace", fontSize:11, color:MUTED,
                flexShrink:0, minWidth:90, overflow:"hidden",
                textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {t.id.length > 12 ? t.id.slice(-10) : t.id}
              </span>
              <span style={{ fontFamily:"sans-serif", fontSize:12, color:TEXT, flex:1,
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {t.title}
              </span>
              <span style={{ fontFamily:"monospace", fontSize:12, flexShrink:0,
                padding:"2px 8px", borderRadius:4, background:S2,
                border:`1px solid ${BD}`, color:MUTED }}>
                {t.status}
              </span>
              <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700,
                color:dColor, flexShrink:0, minWidth:36, textAlign:"right" }}>
                {dLabel}
              </span>
              {t.assigneeInitial ? (
                <div style={{ width:26, height:26, borderRadius:"50%", flexShrink:0,
                  background:`${CC}22`, border:`1px solid ${CC}44`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontFamily:"monospace", fontSize:13, fontWeight:700, color:CC }}>
                  {t.assigneeInitial}
                </div>
              ) : (
                <div style={{ width:26, height:26, borderRadius:"50%", flexShrink:0,
                  background:BD, border:`1px solid ${BD}`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontFamily:"monospace", fontSize:13, color:MUTED }}>
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
  { key:"scheduleSlip",       label:"Schedule Slip",       color:"#f59e0b" },
  { key:"unconfirmedBooking", label:"Unconfirmed Booking", color:"#ef4444" },
  { key:"stalledMilestone",   label:"Stalled Milestone",   color:"#f59e0b" },
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
    <div style={{ marginBottom:20, background:S1, border:`1px solid ${BD}`,
      borderTop:`2px solid #f59e0b88`, borderRadius:9, overflow:"hidden" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px 8px", flexWrap:"wrap" }}>
        <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700,
          color:"#f59e0b", textTransform:"uppercase", letterSpacing:".12em" }}>
          ⚠ Exceptions
        </span>
        <div style={{ display:"flex", gap:6, marginLeft:4, flexWrap:"wrap" }}>
          {EXC_TABS.map(t => {
            const count = (queue[t.key] || []).length;
            const isActive = tab === t.key;
            return (
              <button key={t.key} type="button" onClick={() => setTab(t.key)}
                style={{ display:"flex", alignItems:"center", gap:5,
                  padding:"3px 10px", borderRadius:10,
                  fontFamily:"monospace", fontSize:11, fontWeight:700,
                  cursor:"pointer", transition:"all .12s",
                  background: isActive ? `${t.color}22` : "none",
                  color: isActive ? t.color : MUTED,
                  border: isActive ? `1px solid ${t.color}55` : `1px solid ${BD}` }}>
                {t.label}
                {count > 0 && (
                  <span style={{ fontFamily:"monospace", fontSize:10,
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
          <div style={{ padding:"14px 14px 16px", fontFamily:"sans-serif",
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
            <span style={{ fontFamily:"monospace", fontSize:11, fontWeight:700, color:TEXT,
              flexShrink:0, minWidth:90 }}>
              {row.shipmentId}
            </span>
            <span style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED, flex:1,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {rowDetail(row)}
            </span>
            <span style={{ fontFamily:"monospace", fontSize:11, fontWeight:700,
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
    { label:"Pending",  value: byStatus["Pending"]         || 0, color:"#f59e0b" },
    { label:"Review",   value: byStatus["Requires Review"] || 0, color:"#ef4444" },
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
  const recentShipments = filteredForList
    .sort((a, b) => {
      const aOD = a.etd && a.etd < today ? 0 : 1;
      const bOD = b.etd && b.etd < today ? 0 : 1;
      return aOD - bOD;
    })
    .slice(0, activeFilter ? 50 : 10);

  // TEU helper per shipment
  const shipTEU = sid => containers
    .filter(c => c.shipmentId === sid)
    .reduce((n, c) => n + (c.size === "40" ? 2 : 1), 0);

  const STATUS_DOT = { Active:"#22c55e", Pending:"#f59e0b", "Requires Review":"#ef4444" };

  return (
    <div style={{
      display:"flex", flexDirection:"column",
      // fills the fixed wrapper in LandingPage (top:46, bottom:36, left:240, right:0)
      height:"100%",
      background: BG,
      overflow:"hidden",
      backgroundImage:`radial-gradient(circle, ${BD}40 1px, transparent 1px)`,
      backgroundSize:"28px 28px",
      colorScheme: isDark ? "dark" : "light",
    }}>

      {/* ── Top bar ── */}
      <div style={{ flexShrink:0, display:"flex", alignItems:"center",
        justifyContent:"space-between", padding:"9px 22px",
        background:S1, borderBottom:`1px solid ${BD}` }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <span style={{ fontFamily:"monospace", fontSize:16, fontWeight:800, color:CC,
            textTransform:"uppercase", letterSpacing:".18em",
            textShadow:`0 0 12px ${CC}` }}>
            Command Center
          </span>
          <div style={{ display:"flex", alignItems:"center", gap:5 }}>
            <div style={{ width:8, height:8, borderRadius:"50%", background:"#22c55e",
              boxShadow:"0 0 6px #22c55e", animation:"cc-blink 2.5s ease-in-out infinite" }} />
            <span style={{ fontFamily:"monospace", fontSize:11, color:MUTED }}>LIVE</span>
          </div>
          {/* Live clock */}
          <span style={{ fontFamily:"monospace", fontSize:14, color:MUTED,
            fontVariantNumeric:"tabular-nums", letterSpacing:".04em" }}>
            {now.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" })}
            <span style={{ fontSize:10, marginLeft:5, opacity:.5 }}>
              UTC{now.toTimeString().match(/GMT([+-]\d{4})/)?.[1]?.replace(/(\d{2})(\d{2})/, "$1:$2") || ""}
            </span>
          </span>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button type="button" onClick={() => setCmdOpen(true)}
            style={{ padding:"5px 12px", borderRadius:6,
              border:`1px solid ${BD}`, background:"none",
              cursor:"pointer", fontFamily:"monospace", fontSize:11, color:MUTED,
              transition:"all .15s" }}
            onMouseEnter={e=>{ e.currentTarget.style.borderColor=CC; e.currentTarget.style.color=CC; }}
            onMouseLeave={e=>{ e.currentTarget.style.borderColor=BD; e.currentTarget.style.color=MUTED; }}>
            ⌘K Commands
          </button>
          <button type="button" onClick={onExit}
            style={{ padding:"5px 12px", borderRadius:6,
              border:`1px solid ${BD}`, background:"none",
              cursor:"pointer", fontFamily:"sans-serif", fontSize:11, color:MUTED,
              transition:"all .15s" }}
            onMouseEnter={e=>{ e.currentTarget.style.borderColor="#ef4444"; e.currentTarget.style.color="#ef4444"; }}
            onMouseLeave={e=>{ e.currentTarget.style.borderColor=BD; e.currentTarget.style.color=MUTED; }}>
            Exit ✕
          </button>
        </div>
      </div>

      {/* ── Body: left (flex:1 min-width:0) + right (fixed 300px) ── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", minHeight:0 }}>

        {/* ══ LEFT ══════════════════════════════════════════════════════════ */}
        <div style={{ flex:1, minWidth:0, overflowY:"auto", padding:"18px 22px",
          borderRight:`1px solid ${BD}` }}>

          {/* Row 1: KPI cards */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:10, marginBottom:20 }}>
            {[
              { label:"Active",    value: byStatus["Active"]||0,   sub:`${shipments.length} total`,       color:"#22c55e", icon:"📦", filter:{ status:"Active" } },
              { label:"Pending",   value: byStatus["Pending"]||0,  sub:"awaiting confirmation",           color:"#f59e0b", icon:"⏳", filter:{ status:"Pending" } },
              { label:"Review",    value: byStatus["Requires Review"]||0, sub:"action required",         color:"#ef4444", icon:"⚠",  filter:{ status:"Requires Review" } },
              { label:"TEU Booked",value: totalTEU,                sub:`${containers.length} containers`, color:CC,        icon:"⬛", filter:{} },
              { label:"Overdue",   value: overdueShipments.length, sub:"ETD passed, not closed",        color:"#ef4444", icon:"🚨",
                pulse: overdueShipments.length > 0, filter:{ status:"_overdue" } },
              // TKT-550J25 — fleet-wide milestone on-time KPI. Value is the breach COUNT (matches
              // this row's own "raw count" convention, e.g. Overdue) rather than the %, since the
              // sub-line already carries the % and a scanning eye reads the big number as "how
              // many need attention" consistently across every card here.
              { label:"Milestones", value: msOverdueSummary?.shipmentsWithBreach ?? "—",
                sub: msOverdueSummary ? `${msOverdueSummary.onTimePct}% on-time` : "loading…",
                color:"#f59e0b", icon:"🎯",
                pulse: !!msOverdueSummary?.shipmentsWithBreach, filter:{ milestoneBreach:true } },
            ].map(k => {
              const filterKey = f => f.status ? `status:${f.status}` : f.milestoneBreach ? "msBreach" : "all";
              const isActive = activeFilter && filterKey(activeFilter) === filterKey(k.filter);
              return (
              <button key={k.label} type="button"
                onClick={() => setActiveFilter(af =>
                  af && filterKey(af) === filterKey(k.filter) ? null : k.filter
                )}
                style={{ background: isActive ? `${k.color}14` : S1, textAlign:"left",
                  border:`1px solid ${isActive ? k.color + "88" : k.pulse ? k.color + "55" : k.color+"18"}`,
                  borderTop:`2px solid ${k.color}${isActive ? "" : k.pulse ? "cc" : "44"}`,
                  borderRadius:9, padding:"13px 15px", cursor:"pointer",
                  animation: k.pulse && !isActive ? "cc-pulse-border 2s ease-in-out infinite" : "none",
                  transition:"border-color .15s, background .15s" }}
                onMouseEnter={e => { e.currentTarget.style.background = `${k.color}1a`; }}
                onMouseLeave={e => { e.currentTarget.style.background = isActive ? `${k.color}14` : S1; }}>
                <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:5 }}>
                  <span style={{ fontSize:16 }}>{k.icon}</span>
                  <span style={{ fontFamily:"monospace", fontSize:11, color:`${k.color}${isActive ? "dd" : "88"}`,
                    textTransform:"uppercase", letterSpacing:".12em", fontWeight:700 }}>
                    {k.label}
                  </span>
                  {isActive && <span style={{ marginLeft:"auto", fontFamily:"monospace", fontSize:10,
                    color:k.color, letterSpacing:".08em" }}>✓</span>}
                </div>
                <div style={{ fontFamily:"monospace", fontSize:22, fontWeight:900,
                  color:k.color, lineHeight:1, fontVariantNumeric:"tabular-nums",
                  textShadow:`0 0 16px ${k.color}55` }}>{k.value}</div>
                <div style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED, marginTop:4 }}>{k.sub}</div>
              </button>
              );
            })}
          </div>

          {/* Row 2: Status donut + Monthly trend + Expiring allocs */}
          <div style={{ display:"grid", gridTemplateColumns:"auto 1fr auto auto", gap:14, marginBottom:20,
            alignItems:"stretch" }}>

            {/* Status donut */}
            <div style={{ background:S1, border:`1px solid ${BD}`, borderRadius:9, padding:"14px 16px" }}>
              <SLabel>Status Breakdown</SLabel>
              <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                <StatusDonut segments={donutSegs} size={90} />
                <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                  {donutSegs.map(s => (
                    <div key={s.label} style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <div style={{ width:10, height:10, borderRadius:"50%", background:s.color, flexShrink:0 }} />
                      <span style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED }}>{s.label}</span>
                      <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700, color:TEXT, marginLeft:"auto" }}>{s.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Monthly booking trend */}
            <div style={{ background:S1, border:`1px solid ${BD}`, borderRadius:9, padding:"14px 16px",
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
                      <span style={{ fontFamily:"monospace", fontSize:11, color: isLast ? CC : MUTED,
                        fontWeight: isLast ? 700 : 400 }}>{v}</span>
                      <div style={{ width:"100%", height:h,
                        background: isLast ? CC : `${CC}33`,
                        borderRadius:"3px 3px 0 0", transition:"height .4s ease" }} />
                      <span style={{ fontFamily:"sans-serif", fontSize:10, color:MUTED }}>{lbl}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Expiring allocations */}
            <div style={{ background:S1, border:`1px solid ${BD}`, borderRadius:9, padding:"14px 16px",
              minWidth:180 }}>
              <SLabel>Expiring configs (30d)</SLabel>
              {expiringAllocs.length === 0 ? (
                <div style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED, padding:"8px 0" }}>
                  None expiring soon ✓
                </div>
              ) : expiringAllocs.slice(0,5).map(a => {
                const daysLeft = Math.round((new Date(a.endDate) - new Date()) / 86400000);
                return (
                  <div key={a.id} style={{ display:"flex", alignItems:"center", gap:8,
                    padding:"5px 0", borderBottom:`1px solid ${BD}` }}>
                    <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700,
                      color:CC, minWidth:60 }}>{a.carrierCode}</span>
                    <span style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED, flex:1 }}>
                      {a.pol}›{a.pod}
                    </span>
                    <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700,
                      color: daysLeft <= 7 ? "#ef4444" : "#f59e0b" }}>
                      {daysLeft}d
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Milestone alerts breakdown (TKT-550J25 / TKT-Q09G0T) — same visual language as
                "Expiring configs" alongside it; also the Command Center's always-on surfacing of
                the same feed the notification bell's Milestone Alerts section pulls from. */}
            <div style={{ background:S1, border:`1px solid ${BD}`, borderRadius:9, padding:"14px 16px",
              minWidth:190 }}>
              <SLabel>Milestone Alerts</SLabel>
              {!msOverdueSummary ? (
                <div style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED, padding:"8px 0" }}>Loading…</div>
              ) : msOverdueSummary.byMilestoneKey.length === 0 ? (
                <div style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED, padding:"8px 0" }}>
                  Nothing overdue ✓
                </div>
              ) : msOverdueSummary.byMilestoneKey.slice(0, 5).map(m => (
                <div key={m.milestoneKey} style={{ display:"flex", alignItems:"center", gap:8,
                  padding:"5px 0", borderBottom:`1px solid ${BD}` }}>
                  <span style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED, flex:1,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {m.label}
                  </span>
                  <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700, color:"#f59e0b" }}>
                    {m.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Row 3: Carrier consumption + Top routes */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:20 }}>

            {/* Carrier consumption ranking */}
            <div style={{ background:S1, border:`1px solid ${BD}`, borderRadius:9, padding:"14px 16px" }}>
              <SLabel>Carrier Consumption (TEU)</SLabel>
              {carrierStats.length === 0 ? (
                <div style={{ fontFamily:"sans-serif", fontSize:12, color:MUTED, padding:"8px 0" }}>No data</div>
              ) : carrierStats.map((c, i) => {
                // TKT-LI5KYW — on-time % as an added column on this same ranking, so a
                // chronically-late carrier doesn't look identical to an always-on-time one just
                // because both move the same TEU. Only rendered once real AIS-confirmed samples
                // exist for that carrier — a carrier with zero samples isn't "bad," just unproven.
                const otp = carrierScorecardByCode[c.code];
                return (
                <div key={c.code} style={{ marginBottom:11 }}>
                  <div style={{ display:"flex", alignItems:"baseline", gap:6, marginBottom:4 }}>
                    <span style={{ fontFamily:"monospace", fontSize:14, fontWeight:700,
                      color: i===0 ? CC : TEXT }}>{c.code}</span>
                    <span style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED, flex:1,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {c.name !== c.code ? c.name : ""}
                    </span>
                    {otp && (
                      <span title={`${otp.onTimeCount}/${otp.sampleSize} AIS-confirmed legs on time`}
                        style={{ fontFamily:"monospace", fontSize:10, fontWeight:700, padding:"1px 6px",
                          borderRadius:4, color: otp.onTimePct >= 80 ? "#22c55e" : otp.onTimePct >= 50 ? "#f59e0b" : "#ef4444",
                          background: `${otp.onTimePct >= 80 ? "#22c55e" : otp.onTimePct >= 50 ? "#f59e0b" : "#ef4444"}18`,
                          border:`1px solid ${otp.onTimePct >= 80 ? "#22c55e" : otp.onTimePct >= 50 ? "#f59e0b" : "#ef4444"}44` }}>
                        {otp.onTimePct}% on-time
                      </span>
                    )}
                    <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700,
                      color: i===0 ? CC : TEXT }}>
                      {c.consumed} TEU
                    </span>
                    {c.pct !== null && (
                      <span style={{ fontFamily:"monospace", fontSize:12,
                        color: c.pct >= 100 ? "#ef4444" : c.pct >= 80 ? "#f59e0b" : MUTED }}>
                        {c.pct}%
                      </span>
                    )}
                  </div>
                  <Bar pct={Math.round(c.consumed / maxConsumed * 100)} color={i===0 ? CC : "#3b82f6"} />
                  {c.allocated > 0 && (
                    <div style={{ fontFamily:"sans-serif", fontSize:10, color:MUTED, marginTop:2 }}>
                      {c.consumed} / {c.allocated} allocated
                    </div>
                  )}
                </div>
                );
              })}
            </div>

            {/* Top routes */}
            <div style={{ background:S1, border:`1px solid ${BD}`, borderRadius:9, padding:"14px 16px" }}>
              <SLabel>Top Routes by Volume</SLabel>
              {topRoutes.length === 0 ? (
                <div style={{ fontFamily:"sans-serif", fontSize:12, color:MUTED, padding:"8px 0" }}>No data</div>
              ) : topRoutes.map(([route, count], i) => (
                <div key={route} style={{ marginBottom:11 }}>
                  <div style={{ display:"flex", alignItems:"baseline", gap:6, marginBottom:4 }}>
                    <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700,
                      color: i===0 ? "#22c55e" : TEXT, flex:1 }}>
                      {route}
                    </span>
                    <span style={{ fontFamily:"monospace", fontSize:14, fontWeight:700,
                      color: i===0 ? "#22c55e" : TEXT }}>
                      {count}
                    </span>
                    <span style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED }}>shipments</span>
                  </div>
                  <Bar pct={Math.round(count / maxRoute * 100)} color="#22c55e" height={4} />
                </div>
              ))}
            </div>
          </div>

          {/* Row 3a: Transit-time variance by lane (TKT-PZ3JS2) — planned vs the AIS-confirmed
              actual ETD->ETA span, worst-variance lane first. */}
          {laneVariance.length > 0 && (
            <div style={{ background:S1, border:`1px solid ${BD}`, borderRadius:9,
              padding:"14px 16px", marginBottom:20 }}>
              <SLabel>Transit-Time Variance by Lane</SLabel>
              {laneVariance.map(l => {
                const over = l.varianceDays != null && l.varianceDays > 0;
                const vColor = l.varianceDays == null ? MUTED : over ? "#ef4444" : "#22c55e";
                return (
                  <div key={l.tradeLane} style={{ display:"flex", alignItems:"center", gap:12,
                    padding:"7px 0", borderBottom:`1px solid ${BD}` }}>
                    <span style={{ fontFamily:"monospace", fontSize:12, fontWeight:700, color:TEXT,
                      minWidth:150, flexShrink:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {l.tradeLane}
                    </span>
                    <span style={{ fontFamily:"sans-serif", fontSize:10, color:MUTED, flexShrink:0, minWidth:110 }}>
                      planned {l.plannedAvgDays ?? "—"}d · actual {l.actualAvgDays}d
                    </span>
                    <span style={{ flexShrink:0 }}>
                      <Sparkline values={l.trend} color={vColor} width={80} height={22} />
                    </span>
                    <span style={{ fontFamily:"monospace", fontSize:12, fontWeight:700, color:vColor,
                      marginLeft:"auto", flexShrink:0 }}>
                      {l.varianceDays == null ? "no plan" : `${over ? "+" : ""}${l.varianceDays}d`}
                    </span>
                    <span style={{ fontFamily:"sans-serif", fontSize:10, color:MUTED, flexShrink:0 }}>
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
            <div style={{ fontFamily:"monospace", fontSize:13, fontWeight:700, color:MUTED,
              textTransform:"uppercase", letterSpacing:".14em" }}>
              {activeFilter
                ? activeFilter.status === "_overdue" ? "Overdue Shipments"
                  : activeFilter.status ? `${activeFilter.status} Shipments`
                  : "All Shipments"
                : "Recent Active Shipments"}
            </div>
            <span style={{ fontFamily:"monospace", fontSize:11, color:MUTED }}>
              {recentShipments.length} shown
            </span>
            {activeFilter && (
              <button type="button" onClick={() => setActiveFilter(null)}
                style={{ marginLeft:"auto", fontFamily:"monospace", fontSize:11, color:MUTED,
                  background:"none", border:`1px solid ${BD}`, borderRadius:4,
                  padding:"4px 10px", cursor:"pointer", lineHeight:1 }}
                onMouseEnter={e => { e.currentTarget.style.color="#ef4444"; e.currentTarget.style.borderColor="#ef444455"; }}
                onMouseLeave={e => { e.currentTarget.style.color=MUTED; e.currentTarget.style.borderColor=BD; }}>
                ✕ clear
              </button>
            )}
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            {recentShipments.length === 0 ? (
              <div style={{ fontFamily:"sans-serif", fontSize:12, color:MUTED, padding:"16px 0" }}>
                No active shipments.
              </div>
            ) : recentShipments.map(s => {
              const dot      = STATUS_DOT[s.status] || MUTED;
              const teu      = shipTEU(s.id);
              const isOD     = s.etd && s.etd < today;
              const daysLate = isOD ? Math.round((new Date(today) - new Date(s.etd)) / 86400000) : 0;
              return (
                <div key={s.id}
                  onClick={() => setPreviewShipment(s)}
                  style={{ display:"flex", alignItems:"center", gap:10,
                    padding:"9px 14px", borderRadius:7,
                    background: isOD ? `${S2}` : S2,
                    border:`1px solid ${isOD ? "#ef444433" : BD}`,
                    cursor:"pointer", transition:"border-color .12s" }}
                  onMouseEnter={e => e.currentTarget.style.borderColor=isOD ? "#ef4444aa" : `${CC}55`}
                  onMouseLeave={e => e.currentTarget.style.borderColor=isOD ? "#ef444433" : BD}>
                  <div style={{ fontFamily:"monospace", fontSize:13, fontWeight:700,
                    color:TEXT, minWidth:110, flexShrink:0 }}>{s.id}</div>
                  <div style={{ flex:1, fontFamily:"sans-serif", fontSize:11, color:MUTED,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {s.pol && s.pod ? `${s.pol} → ${s.pod}` : "—"}
                  </div>
                  {s.carrierCode && (
                    <div style={{ fontFamily:"monospace", fontSize:11, padding:"2px 8px",
                      borderRadius:4, background:BG, border:`1px solid ${BD}`,
                      color:MUTED, flexShrink:0 }}>{s.carrierCode}</div>
                  )}
                  {teu > 0 && (
                    <div style={{ fontFamily:"monospace", fontSize:11, padding:"2px 8px",
                      borderRadius:4, background:`${CC}14`, border:`1px solid ${CC}33`,
                      color:CC2, flexShrink:0 }}>{teu} TEU</div>
                  )}
                  {isOD ? (
                    <div style={{ fontFamily:"monospace", fontSize:11, fontWeight:700,
                      color:"#ef4444", flexShrink:0 }}>+{daysLate}d late</div>
                  ) : s.etd ? (
                    <div style={{ fontFamily:"monospace", fontSize:11, color:MUTED, flexShrink:0 }}>
                      {s.etd}
                    </div>
                  ) : null}
                  <div style={{ width:8, height:8, borderRadius:"50%", flexShrink:0,
                    background:dot, boxShadow:`0 0 5px ${dot}` }} />
                </div>
              );
            })}
          </div>
        </div>

        {/* ══ RIGHT (fixed width, never squeezed) ══════════════════════════ */}
        <div style={{ flexShrink:0, width:300,
          display:"flex", flexDirection:"column",
          background:S1,
          borderLeft:`1px solid ${CC}22`,
          minHeight:0, overflow:"hidden" }}>

          {/* Orb + brand */}
          <div style={{ flexShrink:0, padding:"16px 16px 12px",
            borderBottom:`1px solid ${BD}`,
            display:"flex", flexDirection:"column", alignItems:"center", gap:8,
            background:`radial-gradient(ellipse at 50% 65%, ${CC}08 0%, transparent 70%)` }}>
            <AiOrb size={100} orbStyle={orbStyle} />
            <div style={{ textAlign:"center" }}>
              <div style={{ fontFamily:"monospace", fontSize:18, fontWeight:900,
                color:CC, letterSpacing:".22em", textTransform:"uppercase",
                textShadow:`0 0 18px ${CC}cc, 0 0 44px ${CC}44` }}>
                CARGODESK AI
              </div>
              <div style={{ fontFamily:"sans-serif", fontSize:10, color:MUTED,
                letterSpacing:".08em", marginTop:4, textTransform:"uppercase" }}>
                Intelligent freight assistant
              </div>
            </div>
          </div>

          {/* Allocation utilization mini-summary */}
          <div style={{ flexShrink:0, padding:"12px 14px", borderBottom:`1px solid ${BD}` }}>
            <SLabel>Allocation Utilization</SLabel>
            {allocations.filter(a => a.endDate >= today).slice(0, 4).map(a => {
              const consumed = teuByCarrier[a.carrierCode] || 0;
              const pct = a.allocatedTEU > 0 ? Math.round(consumed / a.allocatedTEU * 100) : 0;
              return (
                <div key={a.id} style={{ marginBottom:8 }}>
                  <div style={{ display:"flex", justifyContent:"space-between",
                    fontFamily:"monospace", fontSize:11, marginBottom:3 }}>
                    <span style={{ color:TEXT }}>{a.carrierCode}</span>
                    <span style={{ color: pct>=100 ? "#ef4444" : pct>=80 ? "#f59e0b" : MUTED }}>
                      {pct}%
                    </span>
                  </div>
                  <Bar pct={pct} color={CC} height={4} />
                </div>
              );
            })}
            {allocations.filter(a => a.endDate >= today).length === 0 && (
              <div style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED }}>
                No active allocations
              </div>
            )}
          </div>

          {/* Weather + FX strip */}
          <div style={{ flexShrink:0, borderBottom:`1px solid ${BD}` }}>
            {/* Weather row */}
            <div style={{ padding:"10px 14px 8px", borderBottom:`1px solid ${BD}22` }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                marginBottom:6 }}>
                <div style={{ fontFamily:"monospace", fontSize:10, color:MUTED,
                  textTransform:"uppercase", letterSpacing:".14em" }}>
                  Weather
                </div>
                <button type="button"
                  onClick={() => setWxInput(v => !v)}
                  style={{ fontFamily:"monospace", fontSize:12, color:MUTED, background:"none",
                    border:"none", cursor:"pointer", padding:0 }}>
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
                  <input name="city" defaultValue={wxCity} autoFocus
                    style={{ width:"100%", background:BG, border:`1px solid ${CC}44`,
                      borderRadius:5, padding:"4px 8px", fontFamily:"monospace",
                      fontSize:12, color:TEXT, outline:"none", boxSizing:"border-box" }} />
                </form>
              ) : weather ? (
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:16 }}>{weatherIcon(weather.code)}</span>
                  <span style={{ fontFamily:"monospace", fontSize:14, fontWeight:900,
                    color:TEXT, fontVariantNumeric:"tabular-nums" }}>{weather.temp}°C</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontFamily:"sans-serif", fontSize:10, color:MUTED,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {weather.city}{weather.country ? `, ${weather.country}` : ""}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ fontFamily:"sans-serif", fontSize:11, color:MUTED }}>
                  Loading…
                </div>
              )}
            </div>

            {/* FX row */}
            <div style={{ padding:"8px 14px 10px" }}>
              <div style={{ fontFamily:"monospace", fontSize:10, color:MUTED,
                textTransform:"uppercase", letterSpacing:".14em", marginBottom:6 }}>
                FX Converter
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:6 }}>
                <input value={fxAmt} onChange={e => setFxAmt(e.target.value)}
                  style={{ width:68, background:BG, border:`1px solid ${BD}`, borderRadius:5,
                    padding:"4px 6px", fontFamily:"monospace", fontSize:12, color:TEXT,
                    outline:"none", textAlign:"right" }} />
                <select value={fxFrom}
                  onChange={e => { setFxFrom(e.target.value); localStorage.setItem("cc_fx_from", e.target.value); }}
                  style={{ background:BG, border:`1px solid ${BD}`, borderRadius:5,
                    padding:"4px 4px", fontFamily:"monospace", fontSize:12, color:TEXT,
                    outline:"none", cursor:"pointer", flex:1 }}>
                  {FX_CCYS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <button type="button" onClick={swapFx}
                  style={{ padding:"4px 6px", borderRadius:5, border:`1px solid ${BD}`,
                    background:"none", cursor:"pointer", color:CC, fontSize:12,
                    fontFamily:"monospace", flexShrink:0 }}>⇄</button>
                <select value={fxTo}
                  onChange={e => { setFxTo(e.target.value); localStorage.setItem("cc_fx_to", e.target.value); }}
                  style={{ background:BG, border:`1px solid ${BD}`, borderRadius:5,
                    padding:"4px 4px", fontFamily:"monospace", fontSize:12, color:TEXT,
                    outline:"none", cursor:"pointer", flex:1 }}>
                  {FX_CCYS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              {fxResult !== null && (
                <div style={{ fontFamily:"monospace", fontSize:15, fontWeight:700,
                  color:CC, textShadow:`0 0 10px ${CC}55` }}>
                  {fxResult.toLocaleString("en-US", { minimumFractionDigits:2, maximumFractionDigits:2 })}
                  <span style={{ fontFamily:"sans-serif", fontSize:10, color:MUTED,
                    fontWeight:400, marginLeft:5 }}>{fxTo}</span>
                </div>
              )}
            </div>
          </div>

          {/* AI Chat */}
          <AiChatPanel />
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
