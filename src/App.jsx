import { useState, useEffect, useRef, useCallback } from "react";
import { T, applyTheme } from "./tokens";
import { toast } from "./toast";
import ToastContainer from "./components/primitives/ToastContainer";
import { FullPageSpinner } from "./components/primitives/Spinner";
import { api } from "./api";

import Btn from "./components/primitives/Btn";
import { Modal } from "./components/primitives/Modal";
import { Field } from "./components/primitives/Form";

import ShipmentsPage, { ShipmentForm } from "./pages/ShipmentsPage";
import ShipmentDetailPage  from "./pages/ShipmentDetailPage";
import DashboardPage       from "./pages/DashboardPage";
import DashboardArchive    from "./pages/DashboardArchivePage";
import UserManualPage      from "./pages/UserManualPage";
import AboutPage           from "./pages/AboutPage";
import AppSettingsPage     from "./pages/AppSettingsPage";
import { VERSION, COPYRIGHT_YEAR, COPYRIGHT_OWNER } from "./version";
import LandingPage         from "./pages/LandingPage";
import KanbanPage          from "./pages/KanbanPage";

import MdmCarriersPage        from "./pages/mdm/MdmCarriersPage";
import MdmVesselsPage         from "./pages/mdm/MdmVesselsPage";
import MdmPortLocationsPage   from "./pages/mdm/MdmPortLocationsPage";
import MdmLinkedPortsPage     from "./pages/mdm/MdmLinkedPortsPage";
import MdmTradeLanesPage      from "./pages/mdm/MdmTradeLanesPage";
import MdmRegionsPage         from "./pages/mdm/MdmRegionsPage";
import MdmCountriesPage       from "./pages/mdm/MdmCountriesPage";
import MdmUNLocationCodesPage  from "./pages/mdm/MdmUNLocationCodesPage";
import MdmCommoditiesPage     from "./pages/mdm/MdmCommoditiesPage";
import MdmCustomersPage           from "./pages/mdm/MdmCustomersPage";
import MdmSanctionedCustomersPage from "./pages/mdm/MdmSanctionedCustomersPage";
import MdmContractsPage        from "./pages/mdm/MdmContractsPage";
import SpaceConfigurationsPage from "./pages/SpaceConfigurationsPage";



// ─── Health Modal ─────────────────────────────────────────────────────────────

const HEALTH_CHECKS = [
  { id: "server",    label: "API Server",              url: "/api/health",                     cat: "Internal" },
  { id: "ws",        label: "WebSocket Server",        url: null,   type: "ws",               cat: "Internal", settingKey: "api_ws_enabled" },
  { id: "shipments", label: "Shipments",               url: "/api/shipments",                  cat: "Internal" },
  { id: "contracts", label: "Contracts",               url: "/api/contracts?limit=1",          cat: "Internal" },
  { id: "carriers",  label: "Carriers",                url: "/api/carriers",                   cat: "Internal" },
  { id: "vessels",   label: "Vessels",                 url: "/api/vessels?limit=1",            cat: "Internal" },
  { id: "ports",     label: "Port Locations",          url: "/api/port-locations?limit=1",     cat: "Internal" },
  { id: "customers", label: "Customers",               url: "/api/customers?limit=1",          cat: "Internal" },
  { id: "sysmsg",    label: "System Messages",         url: "/api/system-messages",            cat: "Internal" },
  { id: "fx",      label: "FX Rates (frankfurter.app)", url: "/api/fx/rates",                                      cat: "External", settingKey: "api_fx_enabled" },
  { id: "weather", label: "Weather (open-meteo.com)",   url: "https://api.open-meteo.com/v1/forecast?latitude=51.9&longitude=4.5&current=temperature_2m", cat: "External", settingKey: "api_weather_enabled" },
];

const HealthModal = ({ onClose }) => {
  const [results,  setResults]  = useState({});
  const [running,  setRunning]  = useState(false);
  const [settings, setSettings] = useState({});

  useEffect(() => {
    fetch("/api/settings").then(r => r.ok ? r.json() : {}).then(s => setSettings(s)).catch(() => {});
  }, []);

  const runChecks = async () => {
    setRunning(true);
    setResults({});
    await Promise.all(HEALTH_CHECKS.map(async ({ id, url, type, settingKey }) => {
      // Respect user's enabled/disabled setting
      if (settingKey && settings[settingKey] === 'false') {
        setResults(p => ({ ...p, [id]: { disabled: true } }));
        return;
      }
      const t0 = Date.now();
      if (type === "ws") {
        await new Promise(resolve => {
          const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
          const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
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
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 7000);
        const r     = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        setResults(p => ({ ...p, [id]: { ok: r.ok, status: r.status, latency: Date.now() - t0 } }));
      } catch (e) {
        setResults(p => ({ ...p, [id]: { ok: false, error: e.name === "AbortError" ? "Timeout (7 s)" : e.message, latency: Date.now() - t0 } }));
      }
    }));
    setRunning(false);
  };

  useEffect(() => { runChecks(); }, []);

  const cats    = ["Internal", "External"];
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

        {/* Per-category tables */}
        {cats.map(cat => (
          <div key={cat}>
            <div style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.accent,
              textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>
              {cat} Services
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
                      {disabled ? "Disabled" : r === undefined ? "—" : r.ok ? `${r.latency} ms` : (r.error || `HTTP ${r.status}`)}
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

// ─── Root App ─────────────────────────────────────────────────────────────────

function App() {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=DM+Sans:wght@300;400;500;600&display=swap";
    document.head.appendChild(link);
    return () => document.head.removeChild(link);
  }, []);

  const [carriers,    setCarriers]    = useState([]);
  const [shipments,   setShipments]   = useState([]);
  const [containers,  setContainers]  = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [ready,       setReady]       = useState(false);
  const [apiError,    setApiError]    = useState(null);
  const [appSettings, setAppSettings] = useState({});

  const [healthOpen, setHealthOpen] = useState(false);

  // Map from page key → settings key that gates it
  const PAGE_SETTING_MAP = {
    shipments:         "api_shipments_enabled",
    detail:            "api_shipments_enabled",
    kanban:            "api_shipments_enabled",
    dashboard:         "api_shipments_enabled",
    "space-configs":   "api_shipments_enabled",
    "dashboard-archive":"api_shipments_enabled",
    "mdm-contracts":   "api_contracts_enabled",
    "mdm-customers":              "api_customers_enabled",
    "mdm-sanctioned-customers":  "api_customers_enabled",
    "mdm-carriers":    "api_carriers_enabled",
    "mdm-vessels":     "api_vessels_enabled",
    "mdm-ports":       "api_ports_enabled",
    "mdm-linked":      "api_ports_enabled",
  };

  const isEnabled = (pageKey) => {
    const k = PAGE_SETTING_MAP[pageKey];
    return !k || appSettings[k] !== 'false';
  };

  const [page,       setPage]       = useState(() => {
    const hash = window.location.hash.replace("#", "").trim();
    if (hash.startsWith("shipments/")) return "detail";
    return hash || "home";
  });
  const [selectedId, setSelectedId] = useState(() => {
    const hash = window.location.hash.replace("#", "").trim();
    if (hash.startsWith("shipments/")) return hash.split("/")[1] || null;
    return null;
  });
  const [showNewShp,   setShowNewShp]   = useState(false);
  const [pendingRenew, setPendingRenew] = useState(null);
  const [isDark,       setIsDark]       = useState(() => {
    const saved = localStorage.getItem("cd_theme");
    return saved !== "light"; // default dark
  });

  // Apply saved theme once on mount — before first paint
  useEffect(() => { applyTheme(isDark); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTheme = () => {
    const next = !isDark;
    applyTheme(next);                                            // mutate T before re-render
    localStorage.setItem("cd_theme", next ? "dark" : "light"); // persist
    setIsDark(next);                                            // trigger re-render (T already updated)
  };
  const [mdmOpen,    setMdmOpen]    = useState(true);

  // Load all data + settings on mount
  useEffect(() => {
    api.settings.get().then(s => setAppSettings(s)).catch(() => {});
    Promise.all([
      api.carriers.list(),
      api.shipments.list(),
      api.containers.list(),
      api.allocations.list(),
    ])
      .then(([c, s, ct, a]) => {
        setCarriers(c);
        setShipments(s);
        setContainers(ct);
        setAllocations(a);
        setReady(true);
      })
      .catch(e => setApiError(e.message));
  }, []);

  const selectedShipment = shipments.find(s => s.id === selectedId);
  const navigate = (key) => {
    // Reload settings when leaving the settings page so nav updates immediately
    if (page === "settings" && key !== "settings")
      api.settings.get().then(s => setAppSettings(s)).catch(() => {});
    setPage(key); setSelectedId(null); setShowNewShp(false);
    window.location.hash = key;
  };

  // Browser back/forward — supports #shipments/SHP-XXXXX
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.replace("#", "").trim();
      if (!hash) return;
      if (hash.startsWith("shipments/")) {
        const id = hash.split("/")[1];
        if (id) { setSelectedId(id); setPage("detail"); return; }
      }
      if (hash === "shipments") { setPage("shipments"); setSelectedId(null); return; }
      if (hash !== page) { setPage(hash); setSelectedId(null); }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [page]);

  // kanban is top-level, not MDM
  const MDM_PAGES = ["mdm-carriers", "mdm-ports", "mdm-linked", "mdm-vessels", "mdm-commodities", "mdm-tradelanes", "mdm-countries", "mdm-unlocodes", "mdm-customers", "mdm-sanctioned-customers", "mdm-contracts"];
  const ALL_PAGES = [...MDM_PAGES, "manual"];
  const isMdmActive = MDM_PAGES.includes(page);

  if (apiError) return (
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg, alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div style={{ fontFamily: T.head, fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 12 }}>⚓ CargoDesk</div>
        <div style={{ background: T.dangerBg, border: `1px solid ${T.danger}55`, borderRadius: 8, padding: "14px 18px",
          fontFamily: T.body, fontSize: 13, color: T.danger, marginBottom: 12 }}>
          Cannot reach the API server.<br /><strong>{apiError}</strong>
        </div>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          Make sure the Express server is running: <code style={{ fontFamily: T.mono, color: T.textCode }}>node server.js</code>
        </div>
      </div>
    </div>
  );

  if (!ready) return <FullPageSpinner label="Connecting to database…" />;

  // ── Shared nav button style ──
  const NavBtn = ({ pageKey, icon, label, indent = false, subIndent = false }) => {
    if (!isEnabled(pageKey)) return null;
    const active = page === pageKey || (pageKey === "shipments" && page === "detail");
    const pad = subIndent ? "6px 12px 6px 44px" : indent ? "7px 12px 7px 28px" : "9px 12px";
    const fs  = subIndent ? 12 : indent ? 13 : 14;
    return (
      <button onClick={() => navigate(pageKey)}
        style={{ display: "flex", alignItems: "center", gap: 9, width: "100%",
          padding: pad, borderRadius: 7, border: "none", cursor: "pointer",
          marginBottom: 2, textAlign: "left",
          background: active ? T.accentBg : "transparent",
          color: active ? T.accent : T.textMuted,
          fontFamily: T.body, fontSize: fs, fontWeight: active ? 600 : 400,
          borderLeft: `3px solid ${active ? T.accent : "transparent"}` }}>
        <span style={{ fontSize: fs }}>{icon}</span>
        {label}
      </button>
    );
  };


  const PAGE_TITLES = {
    home:               "Home",
    shipments:          "Shipments",
    "shipment-detail":  "Shipment Detail",
    dashboard:           "Consumption Dashboard",
    "space-configs":     "Space Configurations",
    "dashboard-archive": "Dashboard — Archive",
    kanban:             "Integration Board",
    "user-manual":      "User Manual",
    about:              "About",
    settings:           "Application Settings",
    "mdm-carriers":     "Master Data — Carriers",
    "mdm-vessels":      "Master Data — Vessels",
    "mdm-commodities":  "Master Data — Commodities",
    "mdm-ports":        "Master Data — Port Locations",
    "mdm-linked":       "Master Data — Linked Ports",
    "mdm-tradelanes":   "Master Data — Trade Lanes",
    "mdm-regions":      "Master Data — Regions",
    "mdm-countries":    "Master Data — Countries",
    "mdm-unlocodes":    "Master Data — UN Location Codes",
    "mdm-customers":              "Master Data — Customers",
    "mdm-sanctioned-customers":  "Master Data — Sanctioned Customers",
    "mdm-contracts":    "Master Data — Contracts",
    manual:             "User Manual",
  };

  // ── iOS-style theme toggle pill ────────────────────────────────────────────
  const ThemeToggle = () => (
    <button
      type="button"
      onClick={toggleTheme}
      title={isDark ? "Switch to Light mode" : "Switch to Dark mode"}
      style={{ display: "flex", alignItems: "center", gap: 6,
        background: "none", border: "none", cursor: "pointer", padding: "4px 0" }}>
      <div style={{
        width: 40, height: 22, borderRadius: 11, position: "relative",
        background: isDark ? T.border : "#D1D1D6",
        transition: "background .25s", flexShrink: 0,
      }}>
        <div style={{
          position: "absolute", top: 2,
          left: isDark ? 20 : 2,
          width: 18, height: 18, borderRadius: "50%",
          background: isDark ? T.accent : "#FFFFFF",
          boxShadow: "0 1px 4px rgba(0,0,0,.35)",
          transition: "left .25s, background .25s",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9,
        }}>
          {isDark ? "🌙" : "☀️"}
        </div>
      </div>
      <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, userSelect: "none" }}>
        {isDark ? "Dark" : "Light"}
      </span>
    </button>
  );


  // ── Top header bar ──────────────────────────────────────────────────────────
  const Header = () => {
    const [open, setOpen]   = useState(false);
    const menuRef           = useRef(null);

    const [bellOpen, setBellOpen] = useState(false);
    const bellRef                 = useRef(null);
    const [activeSysMsgs, setActiveSysMsgs] = useState([]);

    useEffect(() => {
      const load = () => api.systemMessages.list().then(setActiveSysMsgs).catch(() => {});
      load();
      const t = setInterval(load, 60000);
      return () => clearInterval(t);
    }, []);

    // Active allocations above their alert threshold, sorted worst-first (max 5 shown)
    const bellItems = (() => {
      if (!ready) return [];
      const today = new Date().toISOString().split('T')[0];
      const consumed = {};
      shipments.forEach(s => {
        const teu = containers.filter(c => c.shipmentId === s.id).reduce((a, c) => a + (c.size === '40' ? 2 : 1), 0);
        consumed[s.carrierCode] = (consumed[s.carrierCode] || 0) + teu;
      });
      return allocations
        .filter(a => a.endDate >= today && a.allocatedTEU > 0)
        .filter(a => (consumed[a.carrierCode] || 0) / a.allocatedTEU * 100 >= a.alertThreshold)
        .map(a => ({
          ...a,
          pct: Math.round((consumed[a.carrierCode] || 0) / a.allocatedTEU * 100),
        }))
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 5);
    })();
    const bellCount = bellItems.length + activeSysMsgs.length;

    useEffect(() => {
      const h = e => {
        if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
        if (bellRef.current && !bellRef.current.contains(e.target)) setBellOpen(false);
      };
      document.addEventListener("mousedown", h);
      return () => document.removeEventListener("mousedown", h);
    }, []);

    const MenuItem = ({ icon, label, onClick, disabled, sub }) => (
      <button type="button" disabled={disabled} onClick={() => { if (!disabled && onClick) { onClick(); setOpen(false); } }}
        style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%",
          padding: "8px 16px", background: "none", border: "none", textAlign: "left",
          cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1,
          borderRadius: 6,
        }}
        onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = T.surfaceHover; }}
        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
        <span style={{ fontSize: 14, width: 18, textAlign: "center", flexShrink: 0 }}>{icon}</span>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 13, color: disabled ? T.textMuted : T.text, fontWeight: 500 }}>
            {label}
          </div>
          {sub && <div style={{ fontFamily: T.body, fontSize: 11, color: T.border, marginTop: 1 }}>{sub}</div>}
        </div>
      </button>
    );

    const Divider = () => (
      <div style={{ height: 1, background: T.border, margin: "4px 0", opacity: 0.5 }} />
    );

    const pageTitle = PAGE_TITLES[page] || page;

    return (
      <header style={{
        height: 46, borderBottom: `1px solid ${T.border}`,
        background: T.surface, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 32px",
      }}>
        {/* Left — breadcrumb */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>CargoDesk</span>
          {page === "detail" && selectedShipment ? (
            <>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.border }}>›</span>
              <button onClick={() => navigate("shipments")}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                  fontFamily: T.body, fontSize: 12, color: T.textMuted }}
                onMouseEnter={e => e.currentTarget.style.color = T.text}
                onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
                Shipments
              </button>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.border }}>›</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>
                {selectedShipment.id}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.border }}>›</span>
              <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.textMuted }}>
                Details
              </span>
            </>
          ) : (
            <>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.border }}>›</span>
              <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.textMuted }}>
                {pageTitle}
              </span>
            </>
          )}
        </div>

        {/* Right — actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>

          {/* Notification bell */}
          <div ref={bellRef} style={{ position: "relative" }}>
            <button type="button"
              title={bellCount > 0 ? `${bellCount} notification${bellCount > 1 ? "s" : ""}` : "No active notifications"}
              onClick={() => { if (bellCount > 0) setBellOpen(o => !o); }}
              style={{ position: "relative", background: "none", border: "none",
                cursor: bellCount > 0 ? "pointer" : "default",
                opacity: bellCount > 0 ? 1 : 0.35, fontSize: 16, padding: "4px 6px" }}>
              🔔
              {bellCount > 0 && (
                <span style={{
                  position: "absolute", top: 0, right: 0,
                  background: T.danger, color: "#fff",
                  borderRadius: "50%", width: 16, height: 16,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: T.mono, fontSize: 9, fontWeight: 700, lineHeight: 1,
                }}>
                  {bellCount > 9 ? "9+" : bellCount}
                </span>
              )}
            </button>

            {bellOpen && bellCount > 0 && (
              <div style={{
                position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 500,
                background: T.surface, border: `1px solid ${T.border}`,
                borderRadius: 12, boxShadow: "0 12px 36px rgba(0,0,0,.35)",
                minWidth: 320, maxWidth: 380, overflow: "hidden",
              }}>

                {/* ── System Messages section ── */}
                {activeSysMsgs.length > 0 && (() => {
                  const sevColor = { info: T.info, warning: T.warning, danger: T.danger, success: T.success };
                  const sevIcon  = { info: "ℹ", warning: "⚠", danger: "🚨", success: "✓" };
                  return (
                    <>
                      <div style={{ padding: "10px 16px 8px",
                        borderBottom: `1px solid ${T.border}`,
                        display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.info }}>
                          📣 System Messages
                        </span>
                        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                          {activeSysMsgs.length} active
                        </span>
                      </div>
                      {activeSysMsgs.map(m => (
                        <div key={m.id} style={{
                          padding: "10px 16px",
                          borderBottom: `1px solid ${T.border}22`,
                          borderLeft: `3px solid ${sevColor[m.severity] || T.border}`,
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: m.body ? 3 : 0 }}>
                            <span style={{ fontSize: 12 }}>{sevIcon[m.severity] || "•"}</span>
                            <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700,
                              color: sevColor[m.severity] || T.text, flex: 1 }}>
                              {m.title}
                            </span>
                          </div>
                          {m.body && (
                            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted,
                              lineHeight: 1.4, marginLeft: 18 }}>
                              {m.body}
                            </div>
                          )}
                        </div>
                      ))}
                    </>
                  );
                })()}

                {/* ── Allocation threshold section ── */}
                {bellItems.length > 0 && (
                  <>
                    <div style={{ padding: "10px 16px 8px",
                      borderBottom: `1px solid ${T.border}`,
                      display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.warning }}>
                        ⚠ Above Threshold
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                        {bellItems.length} allocation{bellItems.length > 1 ? "s" : ""}
                      </span>
                    </div>
                    {bellItems.map(a => (
                      <button key={a.id} type="button"
                        onClick={() => { navigate("dashboard"); setBellOpen(false); }}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          width: "100%", padding: "10px 16px", background: "none", border: "none",
                          borderBottom: `1px solid ${T.border}22`, cursor: "pointer", textAlign: "left",
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>
                            {a.carrierCode}
                          </span>
                          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                            {a.pol} › {a.pod}
                          </span>
                        </div>
                        <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                          color: a.pct >= 100 ? T.danger : T.warning }}>
                          {a.pct}%
                        </span>
                      </button>
                    ))}
                    <button type="button"
                      onClick={() => { navigate("dashboard"); setBellOpen(false); }}
                      style={{ width: "100%", padding: "9px 16px", background: "none",
                        border: "none", cursor: "pointer",
                        fontFamily: T.body, fontSize: 12, color: T.textMuted, textAlign: "center" }}
                      onMouseEnter={e => { e.currentTarget.style.background = T.surfaceHover; e.currentTarget.style.color = T.text; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.textMuted; }}>
                      View all in Dashboard →
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Home button */}
          <button type="button" onClick={() => navigate("home")} title="Go to Home"
            style={{ background: "none", border: "none", cursor: "pointer",
              fontSize: 17, padding: "4px 6px", lineHeight: 1,
              opacity: page === "home" ? 1 : 0.55, transition: "opacity .15s" }}
            onMouseEnter={e => e.currentTarget.style.opacity = 1}
            onMouseLeave={e => e.currentTarget.style.opacity = page === "home" ? 1 : 0.55}>
            🏠
          </button>

          {/* User menu */}
          <div ref={menuRef} style={{ position: "relative" }}>
            <button type="button" onClick={() => setOpen(o => !o)}
              style={{
                width: 32, height: 32, borderRadius: "50%", border: "none",
                background: T.accent, cursor: "pointer", flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: T.head, fontSize: 14, fontWeight: 800, color: T.btnPrimaryText,
                boxShadow: open ? `0 0 0 3px ${T.accent}44` : "none",
                transition: "box-shadow .15s",
              }}>
              A
            </button>

            {open && (
              <div style={{
                position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 500,
                background: T.surface, border: `1px solid ${T.border}`,
                borderRadius: 12, boxShadow: "0 12px 36px rgba(0,0,0,.35)",
                minWidth: 240, padding: "8px",
              }}>
                {/* User info */}
                <div style={{ padding: "10px 16px 12px", display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: "50%",
                    background: T.accent, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: T.head, fontSize: 18, fontWeight: 800, color: T.btnPrimaryText,
                  }}>A</div>
                  <div>
                    <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text }}>
                      Alex
                    </div>
                    <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                      Freight Manager
                    </div>
                  </div>
                </div>

                <Divider />

                {/* Theme toggle */}
                <div style={{ padding: "4px 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 500 }}>
                    {isDark ? "🌙 Dark mode" : "☀️ Light mode"}
                  </span>
                  <ThemeToggle />
                </div>

                <Divider />

                <MenuItem icon="📖" label="User Manual"      onClick={() => navigate("manual")} />
                <MenuItem icon="ℹ" label="About CargoDesk" onClick={() => navigate("about")} />
                <MenuItem icon="⌨" label="Keyboard Shortcuts" disabled sub="Coming soon" />

                <Divider />

                <MenuItem icon="🚪" label="Sign Out" disabled
                  sub="Authentication not yet implemented" />
              </div>
            )}
          </div>
        </div>
      </header>
    );
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg, fontFamily: T.body, color: T.text }}>

      {/* ── Sidebar ── */}
      <aside style={{ width: 240, background: T.surface, borderRight: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column", flexShrink: 0, paddingBottom: 44 }}>

        {/* Logo — click to go home */}
        <div style={{ padding: "22px 20px 20px", borderBottom: `1px solid ${T.border}` }}>
          <div onClick={() => navigate("home")} style={{ fontFamily: T.head, fontSize: 17, fontWeight: 800, color: T.text, cursor: "pointer" }}>⚓ CargoDesk</div>
          <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted, marginTop: 3, letterSpacing: ".12em", textTransform: "uppercase" }}>
            Freight Management
          </div>
        </div>

        {/* Nav */}
        <nav style={{ padding: "14px 12px", flex: 1, overflowY: "auto" }}>

          {/* Top-level items */}
          <NavBtn pageKey="shipments" icon="⛴" label="Shipments" />

          {/* Dashboard sub-group */}
          <NavBtn pageKey="dashboard"      icon="◈"  label="Dashboard" />
          <NavBtn pageKey="space-configs"  icon="⚡" label="Space Configurations" indent />
          <NavBtn pageKey="dashboard-archive" icon="🗄" label="Archive"           indent />

          <NavBtn pageKey="kanban" icon="📋" label="Integration Board" />

          {/* MDM section */}
          <div style={{ marginTop: 10 }}>
            {/* MDM section header — clickable to expand/collapse */}
            <button onClick={() => setMdmOpen(o => !o)}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                width: "100%", padding: "6px 12px", background: "none", border: "none", cursor: "pointer",
                marginBottom: 2 }}>
              <span style={{ fontFamily: T.mono, fontSize: 9.5, color: isMdmActive ? T.accent : T.border,
                fontWeight: 700, textTransform: "uppercase", letterSpacing: ".12em" }}>
                Master Data
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.border, transition: "transform .2s",
                display: "inline-block", transform: mdmOpen ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
            </button>

            {mdmOpen && (
              <div>
                {/* Directory */}
                <div style={{ fontFamily: T.mono, fontSize: 9, color: T.border, fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: ".1em", padding: "5px 12px 3px 28px" }}>Directory</div>
                <NavBtn pageKey="mdm-customers"            icon="👥" label="Customers"            indent />
                <NavBtn pageKey="mdm-sanctioned-customers" icon="🔴" label="Sanctioned Customers" subIndent />
                <NavBtn pageKey="mdm-contracts"   icon="📋" label="Contracts"       indent />
                <NavBtn pageKey="mdm-carriers" icon="🏢" label="Carriers"       indent />
                <NavBtn pageKey="mdm-vessels"      icon="🚢" label="Vessels"         indent />
                <NavBtn pageKey="mdm-commodities" icon="📦" label="Commodities"     indent />
                <NavBtn pageKey="mdm-ports"    icon="📍" label="Port Locations" indent />
                <NavBtn pageKey="mdm-linked"   icon="🔗" label="Linked Ports"   indent />

                {/* Locations sub-section */}
                <div style={{ fontFamily: T.mono, fontSize: 9, color: T.border, fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: ".1em", padding: "10px 12px 3px 28px" }}>Locations</div>
                <NavBtn pageKey="mdm-tradelanes" icon="🌊" label="Trade Lanes"         indent />
                <NavBtn pageKey="mdm-countries" icon="🏳" label="Countries"          indent />
                <NavBtn pageKey="mdm-unlocodes" icon="🔢" label="UN Location Codes"  indent />
              </div>
            )}
          </div>
        </nav>

        {/* Application Settings — pinned below nav, above footer */}
        <div style={{ padding: "8px 12px 14px", borderTop: `1px solid ${T.border}33` }}>
          <NavBtn pageKey="settings" icon="⚙" label="Application Settings" />
        </div>

      </aside>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <Header />
        <main style={{ flex: 1, padding: "28px 36px 60px", overflow: "auto" }}>

        {/* Disabled module fallback */}
        {!isEnabled(page) && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", minHeight: 360, gap: 14, textAlign: "center" }}>
            <div style={{ fontSize: 40 }}>🔒</div>
            <div style={{ fontFamily: T.head, fontSize: 20, fontWeight: 700, color: T.text }}>
              Module Disabled
            </div>
            <div style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted, maxWidth: 340, lineHeight: 1.6 }}>
              This module has been turned off in Application Settings.
              Re-enable it to restore access.
            </div>
            <button onClick={() => navigate("settings")} type="button"
              style={{ marginTop: 8, padding: "8px 20px", borderRadius: 8,
                border: `1px solid ${T.accent}`, background: T.accentBg,
                color: T.accent, fontFamily: T.body, fontSize: 14,
                fontWeight: 600, cursor: "pointer" }}>
              Open Application Settings
            </button>
          </div>
        )}

        {/* Home / Landing */}
        {page === "home" && (
          <LandingPage
            shipments={shipments}
            containers={containers}
            carriers={carriers}
            allocations={allocations}
            navigate={navigate}
            onNewShipment={() => { navigate("shipments"); setShowNewShp(true); }}
          />
        )}

        {/* Operational pages */}
        {page === "shipments" && (
          <>
            <ShipmentsPage
              shipments={shipments} containers={containers} carriers={carriers}
              onSelect={id => { setSelectedId(id); setPage("detail"); window.location.hash = `shipments/${id}`; }}
              onDelete={async id => {
                try {
                  await api.shipments.remove(id);
                  setShipments(p => p.filter(s => s.id !== id));
                  setContainers(p => p.filter(c => c.shipmentId !== id));
                  toast.success("Shipment deleted");
                } catch (e) { toast.error(e.message); }
              }}
              onNew={() => setShowNewShp(true)} />
            {showNewShp && (
              <Modal title="New Shipment" onClose={() => setShowNewShp(false)} width={560}>
                <ShipmentForm
                  onSave={async form => {
                    try {
                      const created = await api.shipments.create(form);
                      setShipments(p => [created, ...p]);
                      setShowNewShp(false);
                      toast.success("Shipment created");
                      if (created.screening?.result === "HIT") {
                        const parties = (created.screening.hits || []).map(h => `${h.field}: ${h.value}`).join(", ");
                        toast.warning(`Compliance review required — sanctioned party detected${parties ? ` (${parties})` : ""}`);
                      }
                    } catch (e) { toast.error(e.message); throw e; }
                  }}
                  onCancel={() => setShowNewShp(false)} />
              </Modal>
            )}
          </>
        )}

        {page === "detail" && selectedShipment && (
          <ShipmentDetailPage
            shipment={selectedShipment} containers={containers} carriers={carriers}
            onBack={() => { setPage("shipments"); setSelectedId(null); window.location.hash = "shipments"; }}
            onUpdate={async (id, form) => {
              try {
                const updated = await api.shipments.update(id, form);
                setShipments(p => p.map(s => s.id === id ? { ...s, ...updated } : s));
                toast.success("Shipment updated");
                if (updated.screening?.result === "HIT") {
                  const parties = (updated.screening.hits || []).map(h => `${h.field}: ${h.value}`).join(", ");
                  toast.warning(`Compliance review required — sanctioned party detected${parties ? ` (${parties})` : ""}`);
                }
                return updated;
              } catch (e) { toast.error(e.message); throw e; }
            }}
            onAddContainer={async (shipmentId, form) => {
              try {
                const created = await api.containers.create({ shipmentId, ...form });
                setContainers(p => [...p, created]);
                toast.success("Container added");
              } catch (e) { toast.error(e.message); throw e; }
            }}
            onEditContainer={async (id, form) => {
              try {
                const updated = await api.containers.update(id, form);
                setContainers(p => p.map(c => c.id === id ? { ...c, ...updated } : c));
                toast.success("Container updated");
              } catch (e) { toast.error(e.message); throw e; }
            }}
            onDeleteContainer={async id => {
              try {
                await api.containers.remove(id);
                setContainers(p => p.filter(c => c.id !== id));
                toast.success("Container removed");
              } catch (e) { toast.error(e.message); }
            }} />
        )}

        {page === "kanban"    && isEnabled("kanban")    && <KanbanPage shipments={shipments} />}

        {page === "dashboard-archive" && (
          <DashboardArchive
            allocations={allocations.filter(a => a.endDate < new Date().toISOString().split("T")[0])
              .sort((a, b) => b.endDate.localeCompare(a.endDate))}
            carriers={carriers}
            onRenew={a => { setPendingRenew({ ...a, effectiveDate: "", endDate: "" }); navigate("space-configs"); }}
            onDelete={async id => { try { await api.allocations.remove(id); setAllocations(p => p.filter(x => x.id !== id)); toast.success("Configuration deleted"); } catch (e) { toast.error(e.message); } }}
            standalone
          />
        )}

        {page === "dashboard" && (
          <DashboardPage
            shipments={shipments} containers={containers} carriers={carriers}
            allocations={allocations} />
        )}

        {page === "space-configs" && (
          <SpaceConfigurationsPage
            allocations={allocations}
            carriers={carriers}
            shipments={shipments}
            containers={containers}
            pendingRenew={pendingRenew}
            onPendingRenewClear={() => setPendingRenew(null)}
            navigate={navigate}
            onAddAlloc={async form => {
              try {
                const created = await api.allocations.create(form);
                setAllocations(p => [...p, created]);
                toast.success("Space configuration added");
              } catch (e) { toast.error(e.message); throw e; }
            }}
            onEditAlloc={async (id, form) => {
              try {
                const updated = await api.allocations.update(id, form);
                setAllocations(p => p.map(a => a.id === id ? { ...a, ...updated } : a));
                toast.success("Configuration updated");
              } catch (e) { toast.error(e.message); throw e; }
            }}
            onDeleteAlloc={async id => {
              try {
                await api.allocations.remove(id);
                setAllocations(p => p.filter(a => a.id !== id));
                toast.success("Configuration deleted");
              } catch (e) { toast.error(e.message); }
            }} />
        )}

        {/* MDM pages */}
        {page === "mdm-carriers" && isEnabled("mdm-carriers") && (
          <MdmCarriersPage
            carriers={carriers}
            onAdd={async data => {
              const created = await api.carriers.create(data);
              setCarriers(p => [...p, created]);
            }}
            onEdit={async (code, data) => {
              const updated = await api.carriers.update(code, data);
              setCarriers(p => p.map(c => c.code === code ? { ...c, ...updated } : c));
            }}
            onDelete={async code => {
              await api.carriers.remove(code);
              setCarriers(p => p.filter(c => c.code !== code));
            }} />
        )}

        {page === "mdm-vessels"    && isEnabled("mdm-vessels")    && <MdmVesselsPage />}
        {page === "mdm-ports"      && isEnabled("mdm-ports")      && <MdmPortLocationsPage />}
        {page === "mdm-linked"     && isEnabled("mdm-linked")     && <MdmLinkedPortsPage />}
        {page === "mdm-tradelanes" &&                                 <MdmTradeLanesPage />}
        {page === "mdm-countries"  &&                                 <MdmCountriesPage />}
        {page === "mdm-unlocodes"  &&                                 <MdmUNLocationCodesPage />}
        {page === "mdm-commodities"&&                                 <MdmCommoditiesPage />}
        {page === "mdm-customers"              && isEnabled("mdm-customers")             && <MdmCustomersPage />}
        {page === "mdm-sanctioned-customers"   && isEnabled("mdm-sanctioned-customers")  && <MdmSanctionedCustomersPage />}
        {page === "mdm-contracts"  && isEnabled("mdm-contracts")  && <MdmContractsPage />}
        {page === "manual"         && <UserManualPage />}
        {page === "about"          && <AboutPage />}
        {page === "settings"       && <AppSettingsPage />}

        </main>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 200,
        borderTop: `1px solid ${T.border}`,
        padding: "9px 32px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: T.bg,
      }}>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>
          ⚓ CargoDesk · v{VERSION}
        </span>
        <span style={{ fontFamily: T.body, fontSize: 11, color: T.border }}>
          © {COPYRIGHT_YEAR} {COPYRIGHT_OWNER} · All rights reserved
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button type="button" onClick={() => setHealthOpen(true)}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
              display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: T.success,
              boxShadow: `0 0 5px ${T.success}88` }} />
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
              textDecoration: "underline dotted" }}>
              System Health
            </span>
          </button>
        </div>
      </footer>

      {healthOpen && <HealthModal onClose={() => setHealthOpen(false)} />}

      <ToastContainer />
    </div>
  );
}

export default App;