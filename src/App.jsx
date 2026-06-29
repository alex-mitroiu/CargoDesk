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

  // Load all data on mount
  useEffect(() => {
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
  const MDM_PAGES = ["mdm-carriers", "mdm-ports", "mdm-linked", "mdm-vessels", "mdm-commodities", "mdm-tradelanes", "mdm-countries", "mdm-unlocodes"];
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
  const NavBtn = ({ pageKey, icon, label, indent = false }) => {
    const active = page === pageKey || (pageKey === "shipments" && page === "detail");
    return (
      <button onClick={() => navigate(pageKey)}
        style={{ display: "flex", alignItems: "center", gap: 9, width: "100%",
          padding: indent ? "7px 12px 7px 28px" : "9px 12px",
          borderRadius: 7, border: "none", cursor: "pointer", marginBottom: 2, textAlign: "left",
          background: active ? T.accentBg : "transparent",
          color: active ? T.accent : T.textMuted,
          fontFamily: T.body, fontSize: indent ? 13 : 14, fontWeight: active ? 600 : 400,
          borderLeft: `3px solid ${active ? T.accent : "transparent"}` }}>
        <span style={{ fontSize: indent ? 13 : 15 }}>{icon}</span>
        {label}
      </button>
    );
  };


  const PAGE_TITLES = {
    home:               "Home",
    shipments:          "Shipments",
    "shipment-detail":  "Shipment Detail",
    dashboard:          "Dashboard — Space Configurations",
    "dashboard-archive":"Dashboard — Archive",
    kanban:             "Integration Board",
    "user-manual":      "User Manual",
    about:              "About",
    "mdm-carriers":     "Master Data — Carriers",
    "mdm-vessels":      "Master Data — Vessels",
    "mdm-commodities":  "Master Data — Commodities",
    "mdm-ports":        "Master Data — Port Locations",
    "mdm-linked":       "Master Data — Linked Ports",
    "mdm-tradelanes":   "Master Data — Trade Lanes",
    "mdm-regions":      "Master Data — Regions",
    "mdm-countries":    "Master Data — Countries",
    "mdm-unlocodes":    "Master Data — UN Location Codes",
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

    useEffect(() => {
      const h = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false); };
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
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.border }}>›</span>
          <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.textMuted }}>
            {pageTitle}
          </span>
        </div>

        {/* Right — actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>

          {/* Notification bell — placeholder */}
          <button type="button"
            title="Notifications — coming in a future release"
            style={{ background: "none", border: "none", cursor: "default",
              opacity: 0.35, fontSize: 16, padding: "4px 6px" }}>
            🔔
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

                <MenuItem icon="⌨" label="Keyboard Shortcuts" disabled sub="Coming soon" />
                <MenuItem icon="ℹ" label="About CargoDesk" onClick={() => navigate("about")} />

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
        display: "flex", flexDirection: "column", flexShrink: 0 }}>

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

          {/* Dashboard + Archive sub-group */}
          <NavBtn pageKey="dashboard" icon="◈" label="Dashboard" />
          <NavBtn pageKey="dashboard-archive" icon="🗄" label="Archive" indent />

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
          {/* Utility */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, color: T.border, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: ".1em", padding: "5px 12px 3px 12px" }}>Help</div>
            <NavBtn pageKey="manual" icon="📖" label="User Manual" />
            <NavBtn pageKey="about"  icon="ℹ"  label="About"       />
          </div>
        </nav>

      </aside>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <Header />
        <main style={{ flex: 1, padding: "28px 36px 60px", overflow: "auto" }}>

        {/* Home / Landing */}
        {page === "home" && (
          <LandingPage
            shipments={shipments}
            containers={containers}
            carriers={carriers}
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
                <ShipmentForm carriers={carriers}
                  onSave={async form => {
                    try {
                      const created = await api.shipments.create(form);
                      setShipments(p => [created, ...p]);
                      setShowNewShp(false);
                      toast.success("Shipment created");
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

        {page === "kanban"    && <KanbanPage />}

        {page === "dashboard-archive" && (
          <DashboardArchive
            allocations={allocations.filter(a => a.endDate < new Date().toISOString().split("T")[0])
              .sort((a, b) => b.endDate.localeCompare(a.endDate))}
            carriers={carriers}
            onRenew={a => { setPendingRenew({ ...a, effectiveDate: "", endDate: "" }); navigate("dashboard"); }}
            onDelete={async id => { try { await api.allocations.remove(id); setAllocations(p => p.filter(x => x.id !== id)); toast.success("Configuration deleted"); } catch (e) { toast.error(e.message); } }}
            standalone
          />
        )}

        {page === "dashboard" && (
          <DashboardPage
            pendingRenew={pendingRenew}
            onPendingRenewClear={() => setPendingRenew(null)}
            shipments={shipments} containers={containers} carriers={carriers}
            allocations={allocations}
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
        {page === "mdm-carriers" && (
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

        {page === "mdm-vessels"   && <MdmVesselsPage />}
        {page === "mdm-ports"     && <MdmPortLocationsPage />}
        {page === "mdm-linked"    && <MdmLinkedPortsPage />}
        {page === "mdm-tradelanes" && <MdmTradeLanesPage />}
        {page === "mdm-countries" && <MdmCountriesPage />}
        {page === "mdm-unlocodes"   && <MdmUNLocationCodesPage />}
        {page === "mdm-commodities" && <MdmCommoditiesPage />}
        {page === "manual"         && <UserManualPage />}
        {page === "about"          && <AboutPage />}

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
        <button type="button" onClick={() => navigate("about")}
          style={{ background: "none", border: "none", cursor: "pointer",
            fontFamily: T.mono, fontSize: 11, color: T.textMuted,
            padding: 0, textDecoration: "underline dotted" }}>
          About
        </button>
      </footer>

      <ToastContainer />
    </div>
  );
}

export default App;