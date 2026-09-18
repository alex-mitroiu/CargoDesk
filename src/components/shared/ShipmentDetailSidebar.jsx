import { useState, useEffect } from "react";
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
  AnyIcon, IconAnchor, IconArrowDown, IconBaseStation, IconChartBar, IconClipboard, IconCoin, IconDownload,
  IconFileCertificate, IconMapPin, IconReceipt, IconRoute, IconUpload,
} from "../primitives/Icon";
import { parseIso, todayIso } from "../../tokens";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY, useHorizonFonts, carrierBadgeColors } from "../../pages/shipments/shipmentDetailTheme";

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

// Per-viewer UI preferences (NOT the admin-shared sidebar order above) — whether each nested
// group is folded, and whether the whole sidebar is collapsed to an icon rail. Personal to
// whoever's browser it is, so plain localStorage, not a server-saved setting.
const LS_GROUPS_KEY = "cargodesk_shp_sidebar_groups";
const LS_RAIL_KEY = "cargodesk_shp_sidebar_rail";
const safeGet = (key, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch { return fallback; }
};
const safeSet = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

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

  // Fold state for the four parent+children blocks (Booking & Routing, Export Services,
  // Import Services, Accounting) — undefined/false means "open" (matches the old
  // always-expanded behavior exactly, so nobody's view changes until they fold something
  // themselves), `true` means folded. Whichever group contains the page you're actually on
  // is always forced open regardless of stored state, so folding one can never hide where
  // you currently are — see isGroupOpen below.
  const [groupCollapsed, setGroupCollapsed] = useState(() => safeGet(LS_GROUPS_KEY, {}));
  const toggleGroup = id => setGroupCollapsed(prev => {
    const next = { ...prev, [id]: !prev[id] };
    safeSet(LS_GROUPS_KEY, next);
    return next;
  });
  const isGroupOpen = (id, hasActive) => hasActive || groupCollapsed[id] !== true;

  // Collapse the whole sidebar to a 64px icon rail — labels/badges/group children all hide,
  // hover shows a floating tooltip instead (see hoverTip below), and the vitals card shrinks
  // to a clickable status dot + carrier chip that opens the full card as a flyout.
  const [railCollapsed, setRailCollapsed] = useState(() => safeGet(LS_RAIL_KEY, false));
  const toggleRail = () => setRailCollapsed(prev => { const next = !prev; safeSet(LS_RAIL_KEY, next); return next; });
  const [hoverTip, setHoverTip] = useState(null); // { label, badge, x, y } — rail mode only
  const [vitalsFlyoutOpen, setVitalsFlyoutOpen] = useState(false);
  const [vitalsFlyoutPos, setVitalsFlyoutPos] = useState(null);

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
  const bookingBadge = bookingStatus === "Pending" ? { text: "Pending", color: HZ.cyan }
    : bookingStatus === "Rejected" ? { text: "Rejected", color: HZ.crit }
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
  const filingBadge = filingStatuses.includes("Rejected") ? { text: "Rejected", color: HZ.crit }
    : filingStatuses.includes("Filed") ? { text: "Filed", color: HZ.cyan }
    : null;

  // Same self-fetch, no-WS idiom as bookingBadge/filingBadge above.
  const [siStatus, setSiStatus] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.shippingInstructions.get(shipment.id)
      .then(row => !cancelled && setSiStatus(row?.status || null))
      .catch(() => !cancelled && setSiStatus(null));
    return () => { cancelled = true; };
  }, [shipment.id, currentPage]);
  const siBadge = siStatus === "Rejected" ? { text: "Rejected", color: HZ.crit }
    : siStatus === "Submitted" ? { text: "Submitted", color: HZ.cyan }
    : null;

  // Self-fetches milestones purely to power the vitals card's progress rail + "next
  // milestone" chip below — same self-fetch, no-WS idiom as booking/filing/SI above. Reuses
  // the exact completed/overdue/current/upcoming state logic MilestonePanel (ShipmentDetailPage.jsx)
  // already established, so the two views can never disagree about a milestone's state.
  const [milestones, setMilestones] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.milestones.list(shipment.id)
      .then(m => !cancelled && setMilestones(m))
      .catch(() => !cancelled && setMilestones([]));
    return () => { cancelled = true; };
  }, [shipment.id, currentPage]);
  const msList = milestones || [];
  const todayStr = todayIso();
  const msFirstIncompleteIdx = msList.findIndex(m => !m.completedAt);
  const msState = (m, idx) => {
    if (m.completedAt) return "completed";
    if (m.estimatedDate && m.estimatedDate < todayStr) return "overdue";
    return idx === msFirstIncompleteIdx ? "current" : "upcoming";
  };
  const msColor = st => ({ completed: HZ.good, overdue: HZ.crit, current: HZ.cyan, upcoming: HZ.textFaint }[st]);
  const nextMs = msFirstIncompleteIdx >= 0 ? msList[msFirstIncompleteIdx] : null;
  const nextMsState = nextMs ? msState(nextMs, msFirstIncompleteIdx) : null;

  const daysUntil = iso => {
    if (!iso) return null;
    return Math.round((parseIso(iso) - parseIso(todayStr)) / 86400000);
  };
  const etdDays = daysUntil(shipment.etd);
  const etdCountdown = etdDays == null ? null
    : etdDays > 0 ? `in ${etdDays}d`
    : etdDays === 0 ? "today"
    : `${Math.abs(etdDays)}d ago`;

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
    ACTIVE:    { bg: HZ.goodBg, color: HZ.good },
    COMPLETED: { bg: HZ.infoBg, color: HZ.infoPillText },
    CANCELLED: { bg: HZ.critBg, color: HZ.crit },
    DRAFT:     { bg: "rgba(255,255,255,0.06)", color: HZ.textMuted },
  };
  const sc = STATUS_COLORS[shipment.status] || STATUS_COLORS.DRAFT;

  // ctrCount (the only per-render dynamic value among these) is spliced onto the Cargo
  // entry here rather than baked into the static shared config. "shp-schedules" is filtered
  // out of the flat list — it's still a real entry in SHIPMENT_SECTIONS (its hash/page-key/
  // label wiring is unchanged) but now renders as the first child of "Booking & Routing"
  // below instead of as its own top-level row.
  const sections = [
    { id: "shp-overview", icon: "◎", label: "Overview" },
    ...SHIPMENT_SECTIONS.filter(s => s.id !== "shp-schedules" && s.id !== "shp-shipping-instructions")
      .map(s => s.id === "shp-cargo" ? { ...s, badge: ctrCount || null } : s),
  ];
  const schedulesSection = SHIPMENT_SECTIONS.find(s => s.id === "shp-schedules");
  const siSection = SHIPMENT_SECTIONS.find(s => s.id === "shp-shipping-instructions");
  // Groups the booking pipeline — what & when (Schedules) → booked with the carrier
  // (Carrier Booking) → Shipping Instructions/Customs Filing (pre-departure filings) →
  // physically arranged (Pickup/Delivery, once ordered) — under one parent, same NavRow
  // parent+children idiom as Accounting just below. Schedules/Carrier Booking/Shipping
  // Instructions/Customs Filing are always-visible children; Pickup/Delivery only appear
  // once actually ordered (mirrors Export/Import Services' own "only show if ordered" rule).
  const bookingRoutingChildren = [
    { id: schedulesSection.id, icon: schedulesSection.icon, label: schedulesSection.label },
    { id: "shp-carrier-booking", icon: IconBaseStation, label: "Carrier Booking",
      badge: bookingBadge?.text, badgeColor: bookingBadge?.color },
    { id: siSection.id, icon: siSection.icon, label: siSection.label,
      badge: siBadge?.text, badgeColor: siBadge?.color },
    { id: "shp-customs-filing", icon: IconFileCertificate, label: "Customs Filing",
      badge: filingBadge?.text, badgeColor: filingBadge?.color },
    ...(importTypes.includes("Delivery")
      ? [{ id: servicePageKey("Import", "Delivery"), icon: IconMapPin, label: "Delivery Service" }] : []),
  ];
  const BOOKING_ROUTING_ROUTES = [
    "shipment-schedules", "shipment-carrier-booking-details", "shipment-carrier-booking-review",
    "shipment-shipping-instructions",
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
  useHorizonFonts();

  // ── Vitals card body — shared between the full (expanded sidebar) and mini (rail, as a
  // click-to-open flyout) presentations so the two never drift apart. ────────────────────
  const msDotRail = msList.length === 0 ? null : (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        {msList.flatMap((m, idx) => {
          const st = msState(m, idx);
          const color = msColor(st);
          const dot = (
            <span key={`dot-${m.id}`} title={`${m.label} — ${st}`} style={{
              width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: color,
              ...(st === "overdue" ? { boxShadow: `0 0 0 3px ${HZ.critBg}` } : {}),
            }} />
          );
          if (idx === 0) return [dot];
          const prevDone = msState(msList[idx - 1], idx - 1) === "completed";
          const seg = (
            <span key={`seg-${m.id}`} style={{ height: 2, flex: 1, background: prevDone ? HZ.cyan : HZ.border }} />
          );
          return [seg, dot];
        })}
      </div>
      <div style={{ fontFamily: HZ_MONO, fontSize: 9.5, color: HZ.textFaint, marginTop: 4 }}>
        {msList.filter(m => m.completedAt).length}/{msList.length} milestones
      </div>
    </div>
  );

  const vitalsBody = (
    <>
      <div
        title="Click to copy shipment ID"
        onClick={() => navigator.clipboard.writeText(shipment.id)
          .then(() => toast.success(`Copied ${shipment.id}`))}
        style={{ fontFamily: HZ_MONO, fontSize: 14.5, fontWeight: 700, color: HZ.text,
          cursor: "pointer", userSelect: "none", letterSpacing: ".01em" }}>
        {shipment.id}
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontFamily: HZ_MONO, fontSize: 11, fontWeight: 700, borderRadius: 4,
          padding: "2px 8px", background: sc.bg, color: sc.color }}>
          {shipment.status}
        </span>
      </div>

      {shipment.carrierCode && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <span style={{ ...carrierBadgeColors(shipment.carrierCode), fontFamily: HZ_MONO, fontWeight: 700,
            fontSize: 10, padding: "2px 7px", borderRadius: 4 }}>
            {shipment.carrierCode}
          </span>
          {(shipment.vessel || shipment.voyage) && (
            <span style={{ fontFamily: HZ_MONO, fontSize: 10.5, color: HZ.textMuted }}>
              {shipment.vessel}{shipment.voyage ? ` / ${shipment.voyage}` : ""}
            </span>
          )}
        </div>
      )}

      {(shipment.pol || shipment.pod) && (
        <div style={{ fontFamily: HZ_MONO, fontSize: 12, color: HZ.text, fontWeight: 600 }}>
          {shipment.pol || "—"} → {shipment.pod || "—"}
        </div>
      )}

      {msDotRail}

      {(shipment.etd || shipment.eta) && (
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: HZ_MONO, fontSize: 10.5, color: HZ.textMuted }}>
          <span>{shipment.etd ? `ETD ${shipment.etd}${etdCountdown ? ` · ${etdCountdown}` : ""}` : ""}</span>
          <span>{shipment.eta ? `ETA ${shipment.eta}` : ""}</span>
        </div>
      )}

      {nextMs && (
        <div onClick={() => handleSection("shp-milestones")} role="button" tabIndex={0}
          style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
            border: `1px solid ${nextMsState === "overdue" ? `${HZ.crit}55` : HZ.border}`,
            background: nextMsState === "overdue" ? HZ.critBg : HZ.surface,
            borderRadius: 8, padding: "7px 9px" }}>
          <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, gap: 1 }}>
            <span style={{ fontFamily: HZ_MONO, fontSize: 9, color: HZ.textFaint, textTransform: "uppercase", letterSpacing: ".06em" }}>
              Next milestone
            </span>
            <span style={{ fontFamily: HZ_BODY, fontSize: 11.5, fontWeight: 600, color: HZ.text,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {nextMs.label}
            </span>
          </span>
          {nextMsState === "overdue" && (
            <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, color: HZ.crit,
              background: `${HZ.crit}30`, borderRadius: 4, padding: "2px 6px", flexShrink: 0 }}>
              Overdue
            </span>
          )}
        </div>
      )}
    </>
  );

  return (
    <aside style={{ width: railCollapsed ? 64 : 240, height: "100vh", position: "sticky", top: 0,
      background: HZ.surfaceSolid, borderRight: `1px solid ${HZ.border}`,
      display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden",
      transition: "width 0.2s ease" }}>

      {/* Logo */}
      <div style={{ padding: railCollapsed ? "20px 0 16px" : "22px 20px 18px", borderBottom: `1px solid ${HZ.border}`,
        display: "flex", flexDirection: "column", alignItems: railCollapsed ? "center" : "flex-start" }}>
        <div style={{ fontFamily: HZ_DISPLAY, fontSize: 17, fontWeight: 800, color: HZ.text,
          display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 26, height: 26, borderRadius: 8, background: HZ.gradCyan,
            display: "flex", alignItems: "center", justifyContent: "center", color: "#04121c", flexShrink: 0 }}>
            <IconAnchor size={14} />
          </span>
          {!railCollapsed && "CargoDesk"}
        </div>
        {!railCollapsed && (
          <div style={{ fontFamily: HZ_MONO, fontSize: 9, color: HZ.textFaint, marginTop: 5,
            letterSpacing: ".16em", textTransform: "uppercase" }}>
            Freight Management
          </div>
        )}
      </div>

      {/* Back */}
      <div style={{ padding: railCollapsed ? "12px 0" : "12px 16px", borderBottom: `1px solid ${HZ.border}`,
        display: "flex", justifyContent: "center" }}>
        <button onClick={goBack} title={window.opener ? "Close tab" : "All Shipments"} style={{
          display: "flex", alignItems: "center", gap: 8, justifyContent: railCollapsed ? "center" : "flex-start",
          width: railCollapsed ? 36 : "100%", height: railCollapsed ? 36 : "auto",
          padding: railCollapsed ? 0 : "8px 12px", borderRadius: 9,
          background: HZ.surface, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow,
          fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text,
          cursor: "pointer", fontWeight: 500, textAlign: "left",
        }}>
          ← {!railCollapsed && (window.opener ? "Close tab" : "All Shipments")}
        </button>
      </div>

      {/* Shipment context / vitals card */}
      {railCollapsed ? (
        <div style={{ padding: "14px 0", borderBottom: `1px solid ${HZ.border}`,
          display: "flex", flexDirection: "column", alignItems: "center", gap: 8, position: "relative" }}>
          <div
            onClick={e => {
              if (vitalsFlyoutOpen) { setVitalsFlyoutOpen(false); return; }
              const r = e.currentTarget.getBoundingClientRect();
              setVitalsFlyoutPos({ x: r.right + 10, y: r.top });
              setVitalsFlyoutOpen(true);
            }}
            title="Shipment summary" role="button" tabIndex={0}
            style={{ cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: sc.color,
              boxShadow: `0 0 0 3px ${sc.bg}` }} />
            {shipment.carrierCode && (
              <span style={{ ...carrierBadgeColors(shipment.carrierCode), fontFamily: HZ_MONO, fontWeight: 700,
                fontSize: 8, borderRadius: 4, padding: "2px 5px", lineHeight: 1.4 }}>
                {shipment.carrierCode}
              </span>
            )}
          </div>
          {vitalsFlyoutOpen && vitalsFlyoutPos && (
            <div style={{ position: "fixed", left: vitalsFlyoutPos.x, top: vitalsFlyoutPos.y, width: 220,
              background: "#111729", border: `1px solid ${HZ.borderStrong}`, borderRadius: 10, padding: 12,
              zIndex: 200, boxShadow: "0 20px 45px -15px rgba(0,0,0,.7)",
              display: "flex", flexDirection: "column", gap: 7 }}>
              {vitalsBody}
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${HZ.border}`,
          display: "flex", flexDirection: "column", gap: 7 }}>
          {vitalsBody}
        </div>
      )}

      {/* Section nav — Explorer-tree pattern, same visual language as TestCasesPage's folder tree */}
      <nav style={{ padding: railCollapsed ? "14px 6px 10px" : "14px 12px", flex: 1, overflowY: "auto" }}>
        {!railCollapsed && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", marginBottom: 8 }}>
            <div style={{ fontFamily: HZ_MONO, fontSize: 9, color: HZ.textFaint, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: ".14em" }}>
              Explorer
            </div>
            {/* Admin-only — sets the sidebar order every user sees, not just this admin's own
                view. See DEFAULT_SIDEBAR_ORDER/reconcileSidebarOrder above. */}
            {isAdmin && !reorderMode && (
              <button onClick={startReorder} title="Reorder the sidebar for all users"
                style={{ background: "none", border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 4,
                  color: HZ.textMuted, fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: ".04em", padding: "2px 7px", cursor: "pointer" }}>
                ⇅ Reorder
              </button>
            )}
          </div>
        )}
        {reorderMode && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, fontStyle: "italic",
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
                    borderRadius: 7, marginBottom: 3, cursor: "grab",
                    background: dragOverIdx === idx ? HZ.cyanBg : "rgba(255,255,255,0.03)",
                    border: `1px solid ${dragOverIdx === idx ? `${HZ.cyan}55` : HZ.border}` }}>
                  <span style={{ color: HZ.textFaint, fontSize: 13 }}>⠿</span>
                  <span style={{ width: 16, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <AnyIcon icon={meta.icon} size={13} />
                  </span>
                  <span style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.text }}>{meta.label}</span>
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
        {!reorderMode && !railCollapsed && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px",
          fontFamily: HZ_BODY, fontSize: 12, fontWeight: 700, color: HZ.textMuted }}>
          <span style={{ fontSize: 11, width: 10, textAlign: "center" }}>▾</span>
          <span style={{ fontSize: 13 }}>🚢</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shipment.id}</span>
        </div>
        )}
        {/* NavRow — depth-aware row renderer, same visual/indentation pattern as
            TestCasesPage.jsx's NavRow/NavFolderNode. GroupRow wraps it with a fold chevron
            for the four parent+children blocks. */}
        {!reorderMode && (() => {
          const NavRow = ({ id, icon, label, badge, badgeColor = HZ.cyan, depth = 0, selected, promoted, onClick }) => (
            <div key={id} onClick={onClick}
              style={{
                display: "flex", alignItems: "center", justifyContent: railCollapsed ? "center" : "space-between",
                padding: railCollapsed ? "7px 0" : `6px 8px 6px ${32 + depth * 14}px`,
                borderRadius: 6, cursor: "pointer", userSelect: "none",
                background: selected ? HZ.cyanBg : "transparent",
                color: selected ? HZ.cyan : HZ.text,
                fontFamily: HZ_BODY, fontSize: 12.7, fontWeight: selected ? 600 : 400,
                marginBottom: 1,
              }}
              onMouseEnter={e => {
                if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                if (railCollapsed) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setHoverTip({ label, badge, x: r.right + 8, y: r.top });
                }
              }}
              onMouseLeave={e => {
                if (!selected) e.currentTarget.style.background = "transparent";
                if (railCollapsed) setHoverTip(null);
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: railCollapsed ? 0 : 9, minWidth: 0,
                justifyContent: railCollapsed ? "center" : "flex-start", width: railCollapsed ? "100%" : "auto" }}>
                <span style={{
                  width: railCollapsed ? 36 : 26, height: railCollapsed ? 36 : 26, borderRadius: 7,
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  opacity: selected ? 1 : .85,
                  background: selected ? HZ.gradCyan : "transparent",
                  color: selected ? "#04121c" : "inherit",
                }}>
                  <AnyIcon icon={icon} size={13} />
                </span>
                {!railCollapsed && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>}
                {!railCollapsed && promoted && <span style={{ fontSize: 9, color: HZ.textFaint }}>↗</span>}
              </span>
              {!railCollapsed && badge != null && (
                <span style={{ fontFamily: HZ_MONO, fontSize: 10, background: `${badgeColor}22`,
                  color: badgeColor, borderRadius: 9, padding: "1px 7px", fontWeight: 700, flexShrink: 0 }}>
                  {badge}
                </span>
              )}
            </div>
          );

          // GroupRow — a NavRow plus a fold/unfold chevron (hidden in rail mode, where
          // children never render regardless of fold state, matching how a collapsed rail
          // already drops every other label/badge).
          const GroupRow = ({ id, icon, label, hasActive, isOpen, onToggle, onClick }) => (
            <div style={{ display: "flex", alignItems: "stretch" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <NavRow id={id} icon={icon} label={label} depth={0} selected={hasActive} promoted onClick={onClick} />
              </div>
              {!railCollapsed && (
                <button onClick={e => { e.stopPropagation(); onToggle(); }}
                  title={isOpen ? `Collapse ${label}` : `Expand ${label}`}
                  style={{ background: "none", border: "none", cursor: "pointer", color: HZ.textFaint,
                    padding: "0 6px", display: "flex", alignItems: "center", flexShrink: 0 }}>
                  <span style={{ display: "inline-flex", transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)",
                    transition: "transform .15s ease" }}>
                    <IconArrowDown size={11} />
                  </span>
                </button>
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
          const renderServiceGroup = (side, types, icon) => {
            if (types.length === 0) return null;
            const gid = `shp-${side.toLowerCase()}-services`;
            const hasActive = types.some(t => currentPage === servicePageKey(side, t));
            const open = isGroupOpen(gid, hasActive);
            return (
              <div key={gid}>
                <GroupRow id={gid} icon={icon} label={`${side} Services`} hasActive={hasActive} isOpen={open}
                  onToggle={() => toggleGroup(gid)} onClick={() => handleSection(gid)} />
                {!railCollapsed && open && types.map(type => (
                  <NavRow key={servicePageKey(side, type)} id={servicePageKey(side, type)}
                    icon={SERVICE_TYPE_ICON[type] || "•"} label={type} depth={1}
                    selected={currentPage === servicePageKey(side, type)} promoted
                    onClick={() => handleSection(servicePageKey(side, type))} />
                ))}
              </div>
            );
          };

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
            "shp-booking-routing": () => {
              const hasActive = BOOKING_ROUTING_ROUTES.includes(currentPage);
              const open = isGroupOpen("shp-booking-routing", hasActive);
              return (
                <div key="shp-booking-routing">
                  <GroupRow id="shp-booking-routing" icon={IconRoute} label="Booking & Routing"
                    hasActive={hasActive} isOpen={open} onToggle={() => toggleGroup("shp-booking-routing")}
                    onClick={() => handleSection("shp-booking-routing")} />
                  {!railCollapsed && open && bookingRoutingChildren.map(({ id, icon, label, badge, badgeColor }) => (
                    <NavRow key={id} id={id} icon={icon} label={label} depth={1} badge={badge} badgeColor={badgeColor}
                      selected={currentPage === PROMOTED_ROUTES[id]} promoted
                      onClick={() => handleSection(id)} />
                  ))}
                </div>
              );
            },
            "shp-export-services": () => servicesLoading ? (
              <div key="shp-export-services" style={{ display: "flex", alignItems: "center",
                gap: railCollapsed ? 0 : 8, justifyContent: railCollapsed ? "center" : "flex-start",
                padding: railCollapsed ? "5px 0" : "5px 8px 5px 32px", marginBottom: 1 }}>
                <Spinner size="sm" />
                {!railCollapsed && <span style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted, fontStyle: "italic" }}>Loading services…</span>}
              </div>
            ) : renderServiceGroup("Export", genericExportTypes, IconUpload),
            "shp-import-services": () => servicesLoading ? null
              : renderServiceGroup("Import", genericImportTypes, IconDownload),
            // Shipment cost lines are hidden from trade_manager entirely — not just the
            // Finance/Margin dashboard's canViewFinance gate, per the role spec.
            "shp-accounting": () => {
              if (isTradeManager) return null;
              const hasActive = ACCOUNTING_ROUTES.includes(currentPage);
              const open = isGroupOpen("shp-accounting", hasActive);
              return (
                <div key="shp-accounting">
                  <GroupRow id="shp-accounting" icon="◈" label="Accounting" hasActive={hasActive} isOpen={open}
                    onToggle={() => toggleGroup("shp-accounting")} onClick={() => handleSection("shp-accounting")} />
                  {!railCollapsed && open && accountingChildren.map(({ id, icon, label }) => (
                    <NavRow key={id} id={id} icon={icon} label={label} depth={1}
                      selected={currentPage === PROMOTED_ROUTES[id]} promoted
                      onClick={() => handleSection(id)} />
                  ))}
                </div>
              );
            },
          };

          return <>{effectiveOrder.map(id => blockRenderers[id]?.())}</>;
        })()}
      </nav>

      {/* Footer — icon-rail collapse toggle. Hidden mid-reorder so there's no path to a
          reordering-while-rail-collapsed state, which the drag rows aren't designed for. */}
      {!reorderMode && (
        <div style={{ borderTop: `1px solid ${HZ.border}`, padding: 10, flexShrink: 0 }}>
          <button onClick={() => { toggleRail(); setVitalsFlyoutOpen(false); setHoverTip(null); }}
            title={railCollapsed ? "Expand sidebar" : "Collapse to icon rail"}
            style={{ display: "flex", alignItems: "center", gap: 8, width: "100%",
              justifyContent: railCollapsed ? "center" : "flex-start",
              padding: "7px 8px", borderRadius: 7, background: "none", border: "none",
              color: HZ.textFaint, fontFamily: HZ_BODY, fontSize: 11, cursor: "pointer" }}
            onMouseEnter={e => { e.currentTarget.style.background = HZ.surface; e.currentTarget.style.color = HZ.textMuted; }}
            onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = HZ.textFaint; }}>
            <span style={{ display: "inline-flex", transform: railCollapsed ? "rotate(180deg)" : "none", transition: "transform .2s ease" }}>◂</span>
            {!railCollapsed && <span>Collapse</span>}
          </button>
        </div>
      )}

      {/* Rail-mode hover tooltip — floating, follows whichever row is currently hovered. */}
      {hoverTip && (
        <div style={{ position: "fixed", left: hoverTip.x, top: hoverTip.y, background: "#151b2e",
          border: `1px solid ${HZ.borderStrong}`, color: HZ.text, fontFamily: HZ_BODY, fontSize: 11.5,
          padding: "6px 10px", borderRadius: 7, maxWidth: 220, lineHeight: 1.4, zIndex: 200,
          boxShadow: "0 12px 30px -10px rgba(0,0,0,.6)", pointerEvents: "none" }}>
          {hoverTip.label}{hoverTip.badge ? ` — ${hoverTip.badge}` : ""}
        </div>
      )}
    </aside>
  );
};

export default ShipmentDetailSidebar;
