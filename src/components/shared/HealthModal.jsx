import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api, TOKEN_KEY } from "../../api";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";

// ─── Health Modal ─────────────────────────────────────────────────────────────

const HEALTH_CHECKS = [
  { id: "server",       label: "API Server",         url: "/api/health",                     cat: "Internal" },
  { id: "ws",           label: "WebSocket Server",   url: null,   type: "ws",                 cat: "Internal", settingKey: "api_ws_enabled" },
  { id: "shipments",    label: "Shipments",          url: "/api/shipments",                  cat: "Internal" },
  { id: "quotes",       label: "Quotes",             url: "/api/quotes?limit=1",             cat: "Internal" },
  { id: "opportunities",label: "Opportunities",      url: "/api/opportunities?limit=1",      cat: "Internal" },
  { id: "contracts",    label: "Contracts",          url: "/api/contracts?limit=1",          cat: "Internal" },
  { id: "carriers",     label: "Carriers",           url: "/api/carriers",                   cat: "Internal" },
  { id: "vessels",      label: "Vessels",            url: "/api/vessels?limit=1",            cat: "Internal" },
  { id: "ports",        label: "Port Locations",     url: "/api/port-locations?limit=1",     cat: "Internal" },
  { id: "customers",    label: "Customers",          url: "/api/customers?limit=1",          cat: "Internal" },
  { id: "tickets",      label: "Integration Board",  url: "/api/tickets?limit=1",            cat: "Internal" },
  { id: "sanctions",    label: "Sanctions Screening",url: "/api/sanctions/entries?limit=1",  cat: "Internal" },
  { id: "sysmsg",       label: "System Messages",    url: "/api/system-messages",            cat: "Internal" },
  // Microservices are server-side-probed only (their /health lives on ports 3002-3008 with no
  // CORS middleware, so the browser can never reach them directly) — these rows are synthesized
  // from the "server" check's own /api/health response body, not fetched independently here.
  { id: "svc-distribution", label: "Document Distribution", cat: "Microservices", fromServer: true },
  { id: "svc-pdfRender",    label: "PDF Render",             cat: "Microservices", fromServer: true },
  { id: "svc-contracts",    label: "Contract Management",    cat: "Microservices", fromServer: true },
  { id: "svc-mdm",          label: "MDM",                    cat: "Microservices", fromServer: true },
  { id: "svc-screening",    label: "Screening",              cat: "Microservices", fromServer: true },
  { id: "svc-kanban",       label: "Kanban / Testing",       cat: "Microservices", fromServer: true },
  { id: "svc-customers",    label: "Customer",               cat: "Microservices", fromServer: true },
  { id: "fx",      label: "FX Rates (frankfurter.app)", url: "/api/fx/rates",                                      cat: "External", settingKey: "api_fx_enabled" },
  { id: "weather", label: "Weather (open-meteo.com)",   url: "https://api.open-meteo.com/v1/forecast?latitude=51.9&longitude=4.5&current=temperature_2m", cat: "External", settingKey: "api_weather_enabled" },
  // AIS is a persistent outbound WebSocket (lib/ais-listener.js), not a request/response API —
  // its connection state is read from the "server" check's response too (zero extra network cost).
  { id: "ais", label: "AIS Vessel Tracking (aisstream.io)", cat: "External", fromServer: true },
];

// Microservice/AIS ids whose result comes from the server's own /api/health body
// (services.<key> or the top-level ais field) rather than an independent fetch.
const SERVER_SOURCED = {
  "svc-distribution": s => s?.services?.distribution,
  "svc-pdfRender":    s => s?.services?.pdfRender,
  "svc-contracts":    s => s?.services?.contracts,
  "svc-mdm":          s => s?.services?.mdm,
  "svc-screening":    s => s?.services?.screening,
  "svc-kanban":       s => s?.services?.kanban,
  "svc-customers":    s => s?.services?.customers,
  "ais": s => s?.ais ? { ok: s.ais.connected, error: s.ais.connected ? null : (s.ais.lastError || "Not connected") } : { ok: false, error: "Status unavailable" },
};

const HealthModal = ({ onClose }) => {
  const [results,  setResults]  = useState({});
  const [running,  setRunning]  = useState(false);
  const [settings, setSettings] = useState({});

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    fetch("/api/settings", { headers }).then(r => r.ok ? r.json() : {}).then(s => setSettings(s)).catch(() => {});
  }, []);

  const runChecks = async () => {
    setRunning(true);
    setResults({});
    const token   = localStorage.getItem(TOKEN_KEY);
    const authHdr = token ? { Authorization: `Bearer ${token}` } : {};

    // The "server" check's own /api/health response body carries the microservice probe results
    // and the AIS listener status (both server-aggregated to avoid a cross-origin fetch from the
    // browser) — run it first so the fromServer rows below have something to read from.
    let serverBody = null;
    {
      const t0 = Date.now();
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 7000);
        const r     = await fetch("/api/health", { signal: ctrl.signal, headers: authHdr });
        clearTimeout(timer);
        serverBody = r.ok ? await r.clone().json().catch(() => null) : null;
        setResults(p => ({ ...p, server: { ok: r.ok, status: r.status, latency: Date.now() - t0, migrations: serverBody?.migrations || null } }));
      } catch (e) {
        setResults(p => ({ ...p, server: { ok: false, error: e.name === "AbortError" ? "Timeout (7 s)" : e.message, latency: Date.now() - t0 } }));
      }
    }

    await Promise.all(HEALTH_CHECKS.filter(c => c.id !== "server").map(async ({ id, url, type, settingKey, fromServer }) => {
      // Respect user's enabled/disabled setting
      if (settingKey && settings[settingKey] === 'false') {
        setResults(p => ({ ...p, [id]: { disabled: true } }));
        return;
      }
      if (fromServer) {
        const derive = SERVER_SOURCED[id];
        const r = derive ? derive(serverBody) : null;
        setResults(p => ({ ...p, [id]: r || { ok: false, error: "No data" } }));
        return;
      }
      const t0 = Date.now();
      if (type === "ws") {
        await new Promise(resolve => {
          const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
          const wsHost = import.meta.env.DEV ? "localhost:3001" : window.location.host;
          const ws = new WebSocket(`${proto}//${wsHost}/ws`);
          const timer = setTimeout(() => {
            ws.close();
            setResults(p => ({ ...p, [id]: { ok: false, error: "Timeout (7 s)", latency: Date.now() - t0 } }));
            resolve();
          }, 7000);
          ws.onopen = () => {
            clearTimeout(timer);
            ws.close();
            setResults(p => ({ ...p, [id]: { ok: true, status: 101, latency: Date.now() - t0 } }));
            resolve();
          };
          ws.onerror = () => {
            clearTimeout(timer);
            setResults(p => ({ ...p, [id]: { ok: false, error: "Connection refused", latency: Date.now() - t0 } }));
            resolve();
          };
        });
        return;
      }
      // External URLs (absolute) don't need auth; internal /api/* paths do
      const isInternal = url?.startsWith("/");
      const headers = isInternal ? authHdr : {};
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 7000);
        const r     = await fetch(url, { signal: ctrl.signal, headers });
        clearTimeout(timer);
        setResults(p => ({ ...p, [id]: { ok: r.ok, status: r.status, latency: Date.now() - t0 } }));
      } catch (e) {
        setResults(p => ({ ...p, [id]: { ok: false, error: e.name === "AbortError" ? "Timeout (7 s)" : e.message, latency: Date.now() - t0 } }));
      }
    }));
    setRunning(false);
  };

  useEffect(() => { runChecks(); }, []);

  const cats       = ["Internal", "Microservices", "External"];
  const catHeading = { Internal: "Internal Services", Microservices: "Microservices", External: "External Services" };
  const allDone = HEALTH_CHECKS.every(c => c.id in results);
  const allOk   = allDone && HEALTH_CHECKS.every(c => results[c.id]?.disabled || results[c.id]?.ok);
  const anyFail = allDone && HEALTH_CHECKS.some(c => !results[c.id]?.disabled && !results[c.id]?.ok);

  return (
    <Modal title="System Health" onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

        {/* Summary bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600,
            color: running ? T.textMuted : allOk ? T.success : anyFail ? T.danger : T.textMuted }}>
            {running ? "Checking services…" : allOk ? "✓ All systems operational" : anyFail ? "✗ One or more services degraded" : ""}
          </span>
          <Btn variant="secondary" onClick={runChecks} disabled={running}>
            {running ? "Running…" : "Re-check"}
          </Btn>
        </div>

        {/* Startup migration failures — surfaces what used to be a silent server.js catch{} */}
        {results.server?.migrations?.failed > 0 && (
          <div style={{ background: `${T.danger}15`, border: `1px solid ${T.danger}44`,
            borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontFamily: T.body, fontSize: 12.5, fontWeight: 700, color: T.danger,
              marginBottom: 4 }}>
              ⚠ {results.server.migrations.failed} startup migration{results.server.migrations.failed > 1 ? "s" : ""} failed
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, lineHeight: 1.6 }}>
              {results.server.migrations.details.map((d, i) => (
                <div key={i}>{d.error}</div>
              ))}
            </div>
          </div>
        )}

        {/* Per-category tables */}
        {cats.map(cat => (
          <div key={cat}>
            <div style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.accent,
              textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>
              {catHeading[cat]}
            </div>
            <div style={{ background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`, overflow: "hidden" }}>
              {HEALTH_CHECKS.filter(c => c.cat === cat).map((c, i, arr) => {
                const r        = results[c.id];
                const isLast   = i === arr.length - 1;
                const disabled = r?.disabled;
                const dotColor = disabled ? T.border : r === undefined ? T.border : r.ok ? T.success : T.danger;
                return (
                  <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 12,
                    padding: "10px 14px", borderBottom: isLast ? "none" : `1px solid ${T.border}22`,
                    opacity: disabled ? 0.5 : 1 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                      background: dotColor,
                      boxShadow: (!disabled && r?.ok) ? `0 0 6px ${T.success}77` : (r && !r.ok && !disabled) ? `0 0 6px ${T.danger}77` : "none",
                      transition: "background .3s, box-shadow .3s" }} />
                    <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1 }}>
                      {c.label}
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 11,
                      color: disabled ? T.border : r === undefined ? T.border : r.ok ? T.success : T.danger }}>
                      {disabled ? "Disabled" : r === undefined ? "—" : r.ok ? (r.latency != null ? `${r.latency} ms` : "Connected") : (r.error || `HTTP ${r.status}`)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {/* Help note */}
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.7,
          background: T.bg, borderRadius: 8, padding: "12px 14px", border: `1px solid ${T.border}` }}>
          When reporting a bug, note which services show errors above and include their status codes or
          error messages. Internal services run on{" "}
          <code style={{ fontFamily: T.mono, color: T.textCode, fontSize: 11 }}>localhost:3001</code>.
          External services require an internet connection.
        </div>
      </div>
    </Modal>
  );
};

export default HealthModal;
