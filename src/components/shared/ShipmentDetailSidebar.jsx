import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Spinner from "../primitives/Spinner";
import Btn from "../primitives/Btn";
import { onServicesChanged } from "../../servicesBus";
import {
  SHIPMENT_SECTIONS, SHIPMENT_SECTIONS_AFTER_ACCOUNTING, SHIPMENT_PROMOTED_ROUTES,
} from "../../shipmentSections";
import { SERVICE_TYPES, SERVICE_TYPE_ICON, servicePageKey } from "../../shipmentServicePages";
import {
  AnyIcon, IconAnchor, IconBaseStation, IconChartBar, IconCoin, IconDownload,
  IconFileCertificate, IconMapPin, IconReceipt, IconRoute, IconUpload,
} from "../primitives/Icon";

// ─── Shipment Detail Sidebar ──────────────────────────────────────────────────

// Admin-reorderable top-level nav blocks. A block can be a single row (Overview, Cargo, ...)
// or a parent+children group (Booking & Routing, Export/Import Services, Accounting) — only
// the TOP-LEVEL sequence is reorderable; children stay in their existing fixed relative order
// within their own group, keeping the drag interaction simple (11 draggable rows, not an
// arbitrary tree) and avoiding a child ever floating out to become its own top-level item,
// which would break the nav's structural meaning (e.g. "Cost Entry" isn't a thing outside of
// Accounting). This sequence was set via the admin Reorder UI (SHP-JFULNY's saved order,
// promoted to the hardcoded default) rather than the original v0.44.0 default — a fresh
// install with no admin-saved override yet should already start from the intended order.
const DEFAULT_SIDEBAR_ORDER = [
  "shp-documents", "shp-overview", "shp-milestones", "shp-conditions", "shp-parties",
  "shp-cargo", "shp-booking-routing", "shp-export-services", "shp-import-services",
  "shp-accounting", "shp-history",
];

// Reconciles an admin-saved order (possibly stale — saved before a since-added/removed nav
// block) against the current default: keeps only ids that still exist today, in the saved
// sequence, then appends any current id missing from the saved list (preserving ITS default
// relative position) — so a newly-introduced block always appears rather than silently
// vanishing just because it didn't exist yet when the order was last saved.
const reconcileSidebarOrder = stored => {
  const valid = stored.filter(id => DEFAULT_SIDEBAR_ORDER.includes(id));
  const missing = DEFAULT_SIDEBAR_ORDER.filter(id => !valid.includes(id));
  return [...valid, ...missing];
};

const ShipmentDetailSidebar = ({ shipment, ctrCount, navigate, onSectionClick, currentPage = "detail",
  appSettings = {}, onSidebarOrderSaved }) => {
  const { isTradeManager, isAdmin } = useAuth();

  // Admin-only sidebar reorder mode — see DEFAULT_SIDEBAR_ORDER/reconcileSidebarOrder above.
  // draftOrder is only ever used while actively reordering; the live tree below always
  // renders from the committed effectiveOrder (derived from appSettings), never draftOrder.
  const [reorderMode, setReorderMode] = useState(false);
  const [draftOrder,  setDraftOrder]  = useState([]);
  const [dragIdx,     setDragIdx]     = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const [savingOrder, setSavingOrder] = useState(false);

  let storedOrder = [];
  try { storedOrder = JSON.parse(appSettings.shipment_sidebar_order || "[]"); } catch { storedOrder = []; }
  const effectiveOrder = reconcileSidebarOrder(Array.isArray(storedOrder) ? storedOrder : []);

  const startReorder = () => { setDraftOrder(effectiveOrder); setReorderMode(true); };
  const cancelReorder = () => { setReorderMode(false); setDragIdx(null); setDragOverIdx(null); };
  const handleReorderDrop = () => {
    if (dragIdx === null || dragOverIdx === null || dragIdx === dragOverIdx) { setDragIdx(null); setDragOverIdx(null); return; }
    const reordered = [...draftOrder];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(dragOverIdx, 0, moved);
    setDraftOrder(reordered);
    setDragIdx(null); setDragOverIdx(null);
  };
  const saveOrder = async () => {
    setSavingOrder(true);
    try {
      await api.settings.updateSidebarOrder(draftOrder);
      onSidebarOrderSaved?.(draftOrder);
      toast.success("Sidebar order saved — applies to every user");
      setReorderMode(false);
    } catch (e) { toast.error(e.message || "Failed to save sidebar order"); }
    setSavingOrder(false);
  };

  // Self-fetches shipment_services (Epic TKT-TBS7QD) purely to decide which Export/Import
  // Services nav rows are visible — separate from ServicesPanel's own copy on Overview
  // (cousins, not parent/child). Refetches on every subpage nav (cheap, small per-shipment
  // list) and also on the servicesBus signal so ordering a service on Overview updates the
  // nav immediately instead of only on the next navigation. null (not []) while the FIRST
  // fetch for this shipment is in flight, so the nav can show a brief loading placeholder
  // instead of silently omitting the Export/Import Services group — which otherwise looks
  // identical to "nothing was ordered" for the second or so the request takes.
  const [services, setServices] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => api.services.list(shipment.id).then(list => !cancelled && setServices(list)).catch(() => !cancelled && setServices([]));
    load();
    const unsub = onServicesChanged(sid => { if (sid === shipment.id) load(); });
    return () => { cancelled = true; unsub(); };
  }, [shipment.id, currentPage]);

  const servicesLoading = services === null;

  // Self-fetches the current booking status purely for the sidebar badge below — same
  // "fetch once per shipment, no WS subscription" idiom already used for the Tickets
  // badge count (no live-push need for a badge that's just a hint to go look, and this
  // keeps the sidebar from taking on a WS dependency it doesn't otherwise have).
  const [bookingStatus, setBookingStatus] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.carrierBooking.get(shipment.id)
      .then(b => !cancelled && setBookingStatus(b?.status || null))
      .catch(() => !cancelled && setBookingStatus(null));
    return () => { cancelled = true; };
  }, [shipment.id, currentPage]);
  const bookingBadge = bookingStatus === "Pending" ? { text: "Pending", color: T.accent }
    : bookingStatus === "Rejected" ? { text: "Rejected", color: T.danger }
    : null;

  // Same self-fetch, no-WS idiom as bookingBadge above — a shipment can have up to 2 filings
  // (AES/EEI + ISF/AMS), so this looks across all of them: Rejected takes priority over Filed,
  // same minimal 2-state treatment the booking badge already uses.
  const [filingStatuses, setFilingStatuses] = useState([]);
  useEffect(() => {
    let cancelled = false;
    api.customsFilings.list(shipment.id)
      .then(rows => !cancelled && setFilingStatuses(rows.map(r => r.status)))
      .catch(() => !cancelled && setFilingStatuses([]));
    return () => { cancelled = true; };
  }, [shipment.id, currentPage]);
  const filingBadge = filingStatuses.includes("Rejected") ? { text: "Rejected", color: T.danger }
    : filingStatuses.includes("Filed") ? { text: "Filed", color: T.accent }
    : null;

  // One nav row per distinct, non-cancelled ordered type per side, in canonical
  // SERVICE_TYPES order (not order-ordered) for predictable placement.
  const orderedTypesFor = (side) => {
    if (servicesLoading) return [];
    const ordered = new Set(services.filter(s => s.side === side && s.status !== "Cancelled").map(s => s.serviceType));
    return SERVICE_TYPES.filter(t => t !== "Other" && ordered.has(t));
  };
  const exportTypes = orderedTypesFor("Export");
  const importTypes = orderedTypesFor("Import");
  // Delivery stays grouped under "Booking & Routing" below (excluded here so that group's own
  // visibility reflects only the ancillary types it actually still renders) — Pickup moved
  // back into Export Services as a regular child, per direct request, so it's no longer
  // filtered out of exportTypes here.
  const genericExportTypes = exportTypes;
  const genericImportTypes = importTypes.filter(t => t !== "Delivery");

  const goBack = () => {
    if (window.opener) window.close();
    else navigate("shipments");
  };

  const scrollTo = (id) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

  // Promoted sections are real sub-pages now — every other section (just
  // Overview at this point) is still an anchor inside the Overview page, so a
  // cross-page click lands on Overview and a same-page click just scrolls.
  // Accounting is the only *nested* promotion — the parent row and all three
  // children route via this same map, so handleSection needs no special-casing.
  // The flat (non-Accounting) entries come from the shared config (shipmentSections.js)
  // so this page and the hash-parsing/labels below can't silently drift apart (see M9,
  // ARCHITECTURE.md §11) — Accounting's own two-segment-hash entries are merged in here
  // since its parent+children shape doesn't fit that shared flat array.
  const PROMOTED_ROUTES = {
    ...SHIPMENT_PROMOTED_ROUTES,
    "shp-accounting":          "shipment-accounting-invoices", // parent row → first child
    "shp-accounting-invoices": "shipment-accounting-invoices",
    "shp-accounting-costs":    "shipment-accounting-costs",
    "shp-accounting-gp":       "shipment-accounting-gp",
    "shp-carrier-booking":         "shipment-carrier-booking-details", // parent row → first child
    "shp-carrier-booking-details": "shipment-carrier-booking-details",
    "shp-carrier-booking-review":  "shipment-carrier-booking-review",
    "shp-customs-filing":         "shipment-customs-filing-details", // parent row → first child
    "shp-customs-filing-details": "shipment-customs-filing-details",
    "shp-customs-filing-review":  "shipment-customs-filing-review",
    // "Booking & Routing" groups the booking pipeline (Schedules → Carrier Booking →
    // Pickup/Delivery) under one parent — same "parent row → first child" idiom.
    "shp-booking-routing": "shipment-schedules",
    // Export/Import Services parent rows route to their side's first ordered *generic*
    // type (canonical SERVICE_TYPES order) — same "parent row → first child" idiom as
    // Accounting above. Children route to their own dedicated/WIP page directly. Pickup/
    // Delivery are excluded here (they route via "Booking & Routing" instead) but still
    // need their own page-key routes, so the full exportTypes/importTypes feed those below.
    ...(genericExportTypes.length > 0 ? { "shp-export-services": servicePageKey("Export", genericExportTypes[0]) } : {}),
    ...(genericImportTypes.length > 0 ? { "shp-import-services": servicePageKey("Import", genericImportTypes[0]) } : {}),
    ...Object.fromEntries(exportTypes.map(t => [servicePageKey("Export", t), servicePageKey("Export", t)])),
    ...Object.fromEntries(importTypes.map(t => [servicePageKey("Import", t), servicePageKey("Import", t)])),
  };
  const ACCOUNTING_ROUTES = ["shipment-accounting-invoices", "shipment-accounting-costs", "shipment-accounting-gp"];
  const handleSection = (id) => {
    const route = PROMOTED_ROUTES[id];
    if (route) {
      navigate(route, shipment.id);
      return;
    }
    if (currentPage !== "detail") {
      navigate("detail", shipment.id);
      return;
    }
    scrollTo(id);
    onSectionClick(id);
  };

  const STATUS_COLORS = {
    ACTIVE:    { bg: "#22c55e22", color: "#22c55e" },
    COMPLETED: { bg: "#3b82f622", color: "#3b82f6" },
    CANCELLED: { bg: "#ef444422", color: "#ef4444" },
    DRAFT:     { bg: "#ffffff11", color: T.textMuted },
  };
  const sc = STATUS_COLORS[shipment.status] || STATUS_COLORS.DRAFT;

  // ctrCount (the only per-render dynamic value among these) is spliced onto the Cargo
  // entry here rather than baked into the static shared config. "shp-schedules" is filtered
  // out of the flat list — it's still a real entry in SHIPMENT_SECTIONS (its hash/page-key/
  // label wiring is unchanged) but now renders as the first child of "Booking & Routing"
  // below instead of as its own top-level row.
  const sections = [
    { id: "shp-overview", icon: "◎", label: "Overview" },
    ...SHIPMENT_SECTIONS.filter(s => s.id !== "shp-schedules")
      .map(s => s.id === "shp-cargo" ? { ...s, badge: ctrCount || null } : s),
  ];
  const schedulesSection = SHIPMENT_SECTIONS.find(s => s.id === "shp-schedules");
  // Groups the booking pipeline — what & when (Schedules) → booked with the carrier
  // (Carrier Booking) → physically arranged (Pickup/Delivery, once ordered) — under one
  // parent, same NavRow parent+children idiom as Accounting just below. Schedules/Carrier
  // Booking are always-visible children; Pickup/Delivery only appear once actually ordered
  // (mirrors Export/Import Services' own "only show if ordered" rule).
  const bookingRoutingChildren = [
    { id: schedulesSection.id, icon: schedulesSection.icon, label: schedulesSection.label },
    { id: "shp-carrier-booking", icon: IconBaseStation, label: "Carrier Booking",
      badge: bookingBadge?.text, badgeColor: bookingBadge?.color },
    { id: "shp-customs-filing", icon: IconFileCertificate, label: "Customs Filing",
      badge: filingBadge?.text, badgeColor: filingBadge?.color },
    ...(importTypes.includes("Delivery")
      ? [{ id: servicePageKey("Import", "Delivery"), icon: IconMapPin, label: "Delivery Service" }] : []),
  ];
  const BOOKING_ROUTING_ROUTES = [
    "shipment-schedules", "shipment-carrier-booking-details", "shipment-carrier-booking-review",
    "shipment-customs-filing-details", "shipment-customs-filing-review",
    ...(importTypes.includes("Delivery") ? [servicePageKey("Import", "Delivery")] : []),
  ];
  const accountingChildren = [
    { id: "shp-accounting-invoices", icon: IconReceipt, label: "Invoice Entry" },
    { id: "shp-accounting-costs",    icon: IconCoin, label: "Cost Entry" },
    { id: "shp-accounting-gp",       icon: IconChartBar, label: "GP Overview" },
  ];
  // Lookup for the 6 top-level blocks that are single flat rows sourced from `sections`
  // (Overview, Conditions, Parties, Cargo, Milestones, Documents, History) — reordering
  // renders from this plus TOP_LEVEL_META below (the 5 blocks that are groups or otherwise
  // not a plain `sections` entry: Booking & Routing, Export/Import Services, Accounting).
  const sectionById = Object.fromEntries([...sections, ...SHIPMENT_SECTIONS_AFTER_ACCOUNTING].map(s => [s.id, s]));
  const TOP_LEVEL_META = {
    "shp-booking-routing":   { icon: IconRoute,    label: "Booking & Routing" },
    "shp-export-services":   { icon: IconUpload,   label: "Export Services" },
    "shp-import-services":   { icon: IconDownload, label: "Import Services" },
    "shp-accounting":        { icon: "◈",          label: "Accounting" },
  };
  return (
    <aside style={{ width: 240, height: "100vh", position: "sticky", top: 0,
      background: T.surface, borderRight: `1px solid ${T.border}`,
      display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>

      {/* Logo */}
      <div style={{ padding: "22px 20px 18px", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontFamily: T.head, fontSize: 17, fontWeight: 800, color: T.text,
          display: "flex", alignItems: "center", gap: 7 }}>
          <IconAnchor size={17} />CargoDesk
        </div>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted, marginTop: 3,
          letterSpacing: ".12em", textTransform: "uppercase" }}>
          Freight Management
        </div>
      </div>

      {/* Back */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}` }}>
        <button onClick={goBack} style={{
          display: "flex", alignItems: "center", gap: 8,
          width: "100%", padding: "8px 12px", borderRadius: 8,
          background: T.bg, border: `1px solid ${T.border}`,
          fontFamily: T.body, fontSize: 13, color: T.text,
          cursor: "pointer", fontWeight: 500, textAlign: "left",
        }}>
          ← {window.opener ? "Close tab" : "All Shipments"}
        </button>
      </div>

      {/* Shipment context card */}
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column", gap: 7 }}>

        <div
          title="Click to copy shipment ID"
          onClick={() => navigator.clipboard.writeText(shipment.id)
            .then(() => toast.success(`Copied ${shipment.id}`))}
          style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 800, color: T.text,
            cursor: "pointer", userSelect: "none", letterSpacing: ".02em" }}>
          {shipment.id}
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, borderRadius: 4,
            padding: "2px 8px", background: sc.bg, color: sc.color }}>
            {shipment.status}
          </span>
          {shipment.carrier && (
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
              {shipment.carrier}
            </span>
          )}
        </div>

        {(shipment.pol || shipment.pod) && (
          <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 600 }}>
            {shipment.pol || "—"} → {shipment.pod || "—"}
          </div>
        )}

        {shipment.etd && (
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
            ETD {shipment.etd}
          </div>
        )}
      </div>

      {/* Section nav — Explorer-tree pattern, same visual language as TestCasesPage's folder tree */}
      <nav style={{ padding: "14px 12px", flex: 1, overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", marginBottom: 8 }}>
          <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
            textTransform: "uppercase", letterSpacing: ".12em" }}>
            Explorer
          </div>
          {/* Admin-only — sets the sidebar order every user sees, not just this admin's own
              view. See DEFAULT_SIDEBAR_ORDER/reconcileSidebarOrder above. */}
          {isAdmin && !reorderMode && (
            <button onClick={startReorder} title="Reorder the sidebar for all users"
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
                color: T.textMuted, fontFamily: T.mono, fontSize: 9.5, fontWeight: 700,
                textTransform: "uppercase", letterSpacing: ".04em", padding: "2px 7px", cursor: "pointer" }}>
              ⇅ Reorder
            </button>
          )}
        </div>
        {reorderMode && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontStyle: "italic",
              padding: "0 12px 8px" }}>
              Drag rows to set the order every user's sidebar will use.
            </div>
            {draftOrder.map((id, idx) => {
              const meta = TOP_LEVEL_META[id] || { icon: sectionById[id]?.icon, label: sectionById[id]?.label };
              if (!meta.label) return null;
              return (
                <div key={id} draggable onDragStart={() => setDragIdx(idx)} onDragEnd={handleReorderDrop}
                  onDragOver={e => { e.preventDefault(); setDragOverIdx(idx); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                    borderRadius: 6, marginBottom: 3, cursor: "grab",
                    background: dragOverIdx === idx ? `${T.accent}12` : T.bg,
                    border: `1px solid ${dragOverIdx === idx ? T.accent + "55" : T.border}` }}>
                  <span style={{ color: T.border, fontSize: 13 }}>⠿</span>
                  <span style={{ width: 16, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <AnyIcon icon={meta.icon} size={13} />
                  </span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{meta.label}</span>
                </div>
              );
            })}
            <div style={{ display: "flex", gap: 8, marginTop: 10, padding: "0 4px" }}>
              <Btn size="sm" onClick={saveOrder} disabled={savingOrder}>{savingOrder ? "Saving…" : "Save Order"}</Btn>
              <Btn size="sm" variant="secondary" onClick={cancelReorder} disabled={savingOrder}>Cancel</Btn>
            </div>
          </div>
        )}
        {/* Root node — the shipment in focus. Hidden along with the live tree while
            reordering — the draft list above is the only thing being edited right now. */}
        {!reorderMode && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px",
          fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.textMuted }}>
          <span style={{ fontSize: 11, width: 10, textAlign: "center" }}>▾</span>
          <span style={{ fontSize: 13 }}>🚢</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shipment.id}</span>
        </div>
        )}
        {/* NavRow — depth-aware row renderer, same visual/indentation pattern as
            TestCasesPage.jsx's NavRow/NavFolderNode. Accounting is the only nested
            entry today (a fixed, always-expanded 3-child subtree — no collapse state
            needed for a subtree this small; more restructuring planned later). */}
        {!reorderMode && (() => {
          const NavRow = ({ id, icon, label, badge, badgeColor = T.accent, depth = 0, selected, promoted, onClick }) => (
            <div key={id} onClick={onClick}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: `5px 8px 5px ${32 + depth * 14}px`, borderRadius: 5, cursor: "pointer", userSelect: "none",
                background: selected ? T.accent + "22" : "transparent",
                color: selected ? T.accent : T.text,
                fontFamily: T.body, fontSize: 13, fontWeight: selected ? 600 : 400,
                borderLeft: selected ? `2px solid ${T.accent}` : "2px solid transparent",
                marginBottom: 1,
              }}
              onMouseEnter={e => { if (!selected) e.currentTarget.style.background = T.bg; }}
              onMouseLeave={e => { if (!selected) e.currentTarget.style.background = "transparent"; }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ width: 16, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}><AnyIcon icon={icon} size={13} /></span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                {promoted && <span style={{ fontSize: 9, color: T.border }}>↗</span>}
              </span>
              {badge != null && (
                <span style={{ fontFamily: T.mono, fontSize: 11, background: badgeColor + "22",
                  color: badgeColor, borderRadius: 10, padding: "1px 7px", fontWeight: 700, flexShrink: 0 }}>
                  {badge}
                </span>
              )}
            </div>
          );

          const renderSection = ({ id, icon, label, badge }) => {
            const promotedRoute = PROMOTED_ROUTES[id];
            const isPromotedNode = !!promotedRoute;
            const selected = isPromotedNode
              ? currentPage === promotedRoute
              : currentPage === "detail" && id === "shp-overview"; // best-effort default highlight
            return <NavRow key={id} id={id} icon={icon} label={label} badge={badge} depth={0}
              selected={selected} promoted={isPromotedNode} onClick={() => handleSection(id)} />;
          };

          // Export/Import Services parent + dynamic children (Epic TKT-TBS7QD) — visible
          // only once at least one service is ordered on that side, per the user's own
          // framing ("the sidebar nav menu makes visible" the page). Genuinely dynamic
          // per-shipment nav shape, unlike the fixed shipmentSections.js array, so it's
          // handled here as its own block — same special-case precedent as Accounting.
          const renderServiceGroup = (side, types, icon) => types.length === 0 ? null : (
            <>
              <NavRow id={`shp-${side.toLowerCase()}-services`} icon={icon} label={`${side} Services`} depth={0}
                selected={types.some(t => currentPage === servicePageKey(side, t))} promoted
                onClick={() => handleSection(`shp-${side.toLowerCase()}-services`)} />
              {types.map(type => (
                <NavRow key={servicePageKey(side, type)} id={servicePageKey(side, type)}
                  icon={SERVICE_TYPE_ICON[type] || "•"} label={type} depth={1}
                  selected={currentPage === servicePageKey(side, type)} promoted
                  onClick={() => handleSection(servicePageKey(side, type))} />
              ))}
            </>
          );

          // One render function per admin-reorderable top-level block (DEFAULT_SIDEBAR_ORDER)
          // — the sequence they're called in is now driven entirely by effectiveOrder, not a
          // hardcoded slice-and-splice of `sections`. A block renders null when it has nothing
          // to show right now (Export/Import Services with nothing ordered, Accounting for a
          // trade manager) — same conditional visibility as before, just relocated here.
          const blockRenderers = {
            "shp-overview":   () => renderSection(sectionById["shp-overview"]),
            "shp-conditions": () => renderSection(sectionById["shp-conditions"]),
            "shp-parties":    () => renderSection(sectionById["shp-parties"]),
            "shp-cargo":      () => renderSection(sectionById["shp-cargo"]),
            "shp-milestones": () => renderSection(sectionById["shp-milestones"]),
            "shp-documents":  () => renderSection(sectionById["shp-documents"]),
            "shp-history":    () => renderSection(sectionById["shp-history"]),
            // "Booking & Routing" — Schedules, Carrier Booking, and Pickup/Delivery (once
            // ordered) grouped under one parent. Unconditional/no role gate, matching the old
            // standalone Carrier Booking row's own zero-gate visibility (not Accounting's
            // finance restriction below, which is unrelated).
            "shp-booking-routing": () => (
              <div key="shp-booking-routing">
                <NavRow id="shp-booking-routing" icon={IconRoute} label="Booking & Routing" depth={0}
                  selected={BOOKING_ROUTING_ROUTES.includes(currentPage)} promoted
                  onClick={() => handleSection("shp-booking-routing")} />
                {bookingRoutingChildren.map(({ id, icon, label, badge, badgeColor }) => (
                  <NavRow key={id} id={id} icon={icon} label={label} depth={1} badge={badge} badgeColor={badgeColor}
                    selected={currentPage === PROMOTED_ROUTES[id]} promoted
                    onClick={() => handleSection(id)} />
                ))}
              </div>
            ),
            "shp-export-services": () => servicesLoading ? (
              <div key="shp-export-services" style={{ display: "flex", alignItems: "center", gap: 8,
                padding: "5px 8px 5px 32px", marginBottom: 1 }}>
                <Spinner size="sm" />
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>Loading services…</span>
              </div>
            ) : <div key="shp-export-services">{renderServiceGroup("Export", genericExportTypes, IconUpload)}</div>,
            "shp-import-services": () => servicesLoading ? null
              : <div key="shp-import-services">{renderServiceGroup("Import", genericImportTypes, IconDownload)}</div>,
            // Shipment cost lines are hidden from trade_manager entirely — not just the
            // Finance/Margin dashboard's canViewFinance gate, per the role spec.
            "shp-accounting": () => isTradeManager ? null : (
              <div key="shp-accounting">
                <NavRow id="shp-accounting" icon="◈" label="Accounting" depth={0}
                  selected={ACCOUNTING_ROUTES.includes(currentPage)} promoted
                  onClick={() => handleSection("shp-accounting")} />
                {accountingChildren.map(({ id, icon, label }) => (
                  <NavRow key={id} id={id} icon={icon} label={label} depth={1}
                    selected={currentPage === PROMOTED_ROUTES[id]} promoted
                    onClick={() => handleSection(id)} />
                ))}
              </div>
            ),
          };

          return <>{effectiveOrder.map(id => blockRenderers[id]?.())}</>;
        })()}
      </nav>
    </aside>
  );
};

export default ShipmentDetailSidebar;
