import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { T, applyTheme } from "./tokens";
import { toast } from "./toast";
import ToastContainer from "./components/primitives/ToastContainer";
import GlobalSavingOverlay from "./components/primitives/GlobalSavingOverlay";
import Spinner, { FullPageSpinner } from "./components/primitives/Spinner";
import { api, TOKEN_KEY, ACTIVE_ROLE_KEY, ACTIVE_OFFICE_KEY } from "./api";
import { AuthContext, useAuth } from "./AuthContext";
import useIdleLogout from "./hooks/useIdleLogout";
import {
  SHIPMENT_SECTIONS, SHIPMENT_SECTIONS_AFTER_ACCOUNTING, SHIPMENT_PROMOTED_ROUTES,
  SHIPMENT_SUBPAGES as SHARED_SHIPMENT_SUBPAGES, SHIPMENT_SUBPAGE_HASHES as SHARED_SHIPMENT_SUBPAGE_HASHES,
  SHIPMENT_SUBPAGE_LABELS as SHARED_SHIPMENT_SUBPAGE_LABELS, SHIPMENT_PAGE_KEYS, SHIPMENT_SUBPAGE_HASH_PATTERN,
} from "./shipmentSections";
import {
  SERVICE_TYPES, SERVICE_TYPE_ICON, SERVICE_PAGE_KEYS, SERVICE_SUBPAGES,
  SERVICE_SUBPAGE_HASHES, SERVICE_SUBPAGE_LABELS, SERVICE_PAGE_INFO,
  isBespokeServiceType, servicePageKey,
} from "./shipmentServicePages";
import { onServicesChanged } from "./servicesBus";
import { runNavigationGuard } from "./navigationGuard";
import { buildLoadingPlanHtml } from "./utils/invoiceGenerator";
import LoadingServicePage from "./pages/shipments/LoadingServicePage";
import GenericServicePage from "./pages/shipments/GenericServicePage";
import VgmServicePage from "./pages/shipments/VgmServicePage";

import Btn from "./components/primitives/Btn";
import { Modal, ConfirmModal } from "./components/primitives/Modal";
import { Field } from "./components/primitives/Form";
import {
  IconSailboat, IconDashboard, IconFlash, IconArchive, IconClipboard, IconTag, IconFile,
  IconFlask, IconRefresh, IconCheck, IconCalendar, IconGroup, IconCircle,
  IconBuilding, IconShip, IconPackage, IconMapPin, IconLink, IconRoute,
  IconFlag, IconHashtag, IconEarth, IconGovernment, IconSettings, IconChartBar, AnyIcon,
  IconReceipt, IconCoin, IconAnchor, IconSearch, IconMail, IconMailUnread, IconBaseStation,
  IconUpload, IconDownload, IconLock, IconFileCertificate, IconWarning,
} from "./components/primitives/Icon";
import ChangePasswordModal from "./components/shared/ChangePasswordModal";
import DocumentsModal from "./components/shared/DocumentsModal";
import HealthModal from "./components/shared/HealthModal";
import ShipmentFormSidebar from "./components/shared/ShipmentFormSidebar";
import ShipmentDetailSidebar from "./components/shared/ShipmentDetailSidebar";

import ShipmentsPage     from "./pages/shipments/ShipmentsPage";
import ShipmentFormPage  from "./pages/shipments/ShipmentFormPage";
import ShipmentDetailPage, { ContainerForm } from "./pages/shipments/ShipmentDetailPage";
import ShipmentConditionsPage from "./pages/shipments/ShipmentConditionsPage";
import ShipmentContainersPage from "./pages/shipments/ShipmentContainersPage";
import ShipmentPartiesPage from "./pages/shipments/ShipmentPartiesPage";
import ShipmentSchedulesPage from "./pages/shipments/ShipmentSchedulesPage";
import ShipmentMilestonesPage from "./pages/shipments/ShipmentMilestonesPage";
import ShipmentAccountingCostsPage from "./pages/shipments/ShipmentAccountingCostsPage";
import ShipmentAccountingInvoicesPage from "./pages/shipments/ShipmentAccountingInvoicesPage";
import ShipmentAccountingGpPage from "./pages/shipments/ShipmentAccountingGpPage";
import ShipmentCarrierBookingPage from "./pages/shipments/ShipmentCarrierBookingPage";
import ShipmentCustomsFilingPage from "./pages/shipments/ShipmentCustomsFilingPage";
import ShipmentHistoryPage from "./pages/shipments/ShipmentHistoryPage";
import ShipmentHeaderBar from "./components/shared/ShipmentHeaderBar";
import DashboardPage       from "./pages/DashboardPage";
import ReportsPage         from "./pages/ReportsPage";
import DashboardArchive    from "./pages/DashboardArchivePage";
import UserManualPage      from "./pages/UserManualPage";
import AboutPage           from "./pages/AboutPage";
import AppSettingsPage     from "./pages/AppSettingsPage";
import { VERSION, COPYRIGHT_YEAR, COPYRIGHT_OWNER } from "./version";
import LandingPage         from "./pages/LandingPage";
import LoginPage           from "./pages/LoginPage";
import ForgotPasswordPage  from "./pages/ForgotPasswordPage";
import ResetPasswordPage   from "./pages/ResetPasswordPage";
// Lazy-loaded: pulls in mermaid (KanbanPage's only consumer, ~600 kB+ of the main chunk
// between the core lib and its diagram-renderer sub-chunks) only when Integration Board
// is actually opened, instead of on every single page load.
const KanbanPage           = lazy(() => import("./pages/KanbanPage"));
import TestPlansPage        from "./pages/TestPlansPage";
import TestRunsPage         from "./pages/TestRunsPage";
import TestCasesPage        from "./pages/TestCasesPage";
import TestToolsPage        from "./pages/TestToolsPage";
import ReleasesPage         from "./pages/ReleasesPage";

import MdmCarriersPage        from "./pages/mdm/MdmCarriersPage";
import MdmVesselsPage         from "./pages/mdm/MdmVesselsPage";
import MdmPortLocationsPage   from "./pages/mdm/MdmPortLocationsPage";
import MdmLinkedPortsPage     from "./pages/mdm/MdmLinkedPortsPage";
import MdmCarrierAgentsPage   from "./pages/mdm/MdmCarrierAgentsPage";
import MdmTradeLanesPage      from "./pages/mdm/MdmTradeLanesPage";
import MdmRegionsPage         from "./pages/mdm/MdmRegionsPage";
import MdmLoopCodesPage       from "./pages/mdm/MdmLoopCodesPage";
import LoopMapExplorerPage    from "./pages/mdm/LoopMapExplorerPage";
import MdmCountriesPage       from "./pages/mdm/MdmCountriesPage";
import MdmUNLocationCodesPage  from "./pages/mdm/MdmUNLocationCodesPage";
import MdmCommoditiesPage     from "./pages/mdm/MdmCommoditiesPage";
import MdmChargeCodesPage     from "./pages/mdm/MdmChargeCodesPage";
import MdmDutyRatesPage       from "./pages/mdm/MdmDutyRatesPage";
import MdmPackTypesPage       from "./pages/mdm/MdmPackTypesPage";
import MdmInvoiceReasonCodesPage from "./pages/mdm/MdmInvoiceReasonCodesPage";
import DocumentTemplatesPage  from "./pages/mdm/DocumentTemplatesPage";
import MdmContainerTypesPage  from "./pages/mdm/MdmContainerTypesPage";
import MdmEquipmentPage       from "./pages/mdm/MdmEquipmentPage";
import MdmFinancePage         from "./pages/mdm/MdmFinancePage";
import MdmLocationsPage       from "./pages/mdm/MdmLocationsPage";
import MdmCustomersPage           from "./pages/mdm/MdmCustomersPage";
import MdmSanctionedCustomersPage from "./pages/mdm/MdmSanctionedCustomersPage";
import MdmContractsPage        from "./pages/mdm/MdmContractsPage";
import RateBenchmarkPage       from "./pages/RateBenchmarkPage";
import BranchPage              from "./pages/org/BranchPage";
import OfficePage              from "./pages/org/OfficePage";
import CountryPage             from "./pages/org/CountryPage";
import SpaceConfigurationsPage from "./pages/SpaceConfigurationsPage";
import FreightAuditPage from "./pages/FreightAuditPage";
import QuotesPage from "./pages/QuotesPage";
import OpportunitiesPage from "./pages/OpportunitiesPage";
import CreditOverridesPage from "./pages/CreditOverridesPage";
import LicensePage             from "./pages/LicensePage";
import SchedulesPage           from "./pages/SchedulesPage";
import AiChatDrawer            from "./components/shared/AiChatDrawer";
import TrackingPage            from "./pages/TrackingPage";


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

  const [healthOpen,       setHealthOpen]       = useState(false);
  const [aiChatOpen,       setAiChatOpen]       = useState(false);
  const [licenseAccepted,  setLicenseAccepted]  = useState(
    () => !!localStorage.getItem("cargodesk_license_accepted")
  );

  // Map from page key → settings key that gates it
  const PAGE_SETTING_MAP = {
    quotes:            "api_shipments_enabled",
    opportunities:     "api_shipments_enabled",
    shipments:         "api_shipments_enabled",
    detail:            "api_shipments_enabled",
    kanban:            "api_shipments_enabled",
    dashboard:         "api_shipments_enabled",
    "space-configs":   "api_shipments_enabled",
    "dashboard-archive":"api_shipments_enabled",
    "freight-audit":   "api_shipments_enabled",
    "credit-overrides":"api_shipments_enabled",
    reports:           "api_shipments_enabled",
    // Promoted shipment sub-pages inherit the same gate "detail" uses — otherwise
    // disabling the Shipments module only hides Overview, not Cargo/Accounting/etc.
    // Flat (non-Accounting) entries come from the shared config; Accounting's own
    // 3 keys are merged in below since they're not part of that shared array (see M9).
    ...Object.fromEntries(SHIPMENT_PAGE_KEYS.map(k => [k, "api_shipments_enabled"])),
    "shipment-accounting-invoices": "api_shipments_enabled",
    "shipment-accounting-costs":    "api_shipments_enabled",
    "shipment-accounting-gp":       "api_shipments_enabled",
    "shipment-carrier-booking-details": "api_shipments_enabled",
    "shipment-carrier-booking-review":  "api_shipments_enabled",
    "shipment-customs-filing-details":  "api_shipments_enabled",
    "shipment-customs-filing-review":   "api_shipments_enabled",
    // Export/Import Services dedicated pages (Epic TKT-TBS7QD) — same gate, not part
    // of the shared shipmentSections.js array since they're a dynamic combinatorial set.
    ...Object.fromEntries(SERVICE_PAGE_KEYS.map(k => [k, "api_shipments_enabled"])),
    "mdm-contracts":   "api_contracts_enabled",
    "rate-benchmark":  "api_contracts_enabled",
    "mdm-customers":              "api_customers_enabled",
    "mdm-sanctioned-customers":  "api_customers_enabled",
    "mdm-carriers":    "api_carriers_enabled",
    "mdm-carrier-agents": "api_carriers_enabled",
    "mdm-vessels":     "api_vessels_enabled",
    "mdm-ports":       "api_ports_enabled",
    "mdm-linked":      "api_ports_enabled",
  };

  const isEnabled = (pageKey) => {
    const k = PAGE_SETTING_MAP[pageKey];
    return !k || appSettings[k] !== 'false';
  };

  // Promoted shipment sub-pages — suffix in the hash maps to a page key. Sourced from the
  // shared config (shipmentSections.js) so this and parseHash's regex below can't drift
  // from the sidebar nav the way the old hand-typed version could (see M9).
  const SHIPMENT_SUBPAGES = SHARED_SHIPMENT_SUBPAGES;
  const SHIPMENT_SUBPAGE_HASHES = SHARED_SHIPMENT_SUBPAGE_HASHES;
  // Accounting sub-pages live under a two-segment hash (shipments/:id/accounting/:child) since
  // Accounting is a nested parent with children, unlike the single-segment promoted sections above.
  const ACCOUNTING_SUBPAGES = {
    costs:    "shipment-accounting-costs",
    invoices: "shipment-accounting-invoices",
    gp:       "shipment-accounting-gp",
  };
  const ACCOUNTING_SUBPAGE_HASHES = Object.fromEntries(
    Object.entries(ACCOUNTING_SUBPAGES).map(([suffix, key]) => [key, suffix])
  );
  // Carrier Booking is the same nested-parent-with-children shape as Accounting —
  // shipments/:id/booking/:child — for the same reason (Details/Review are two distinct
  // pages under one nav entry, not a single flat section).
  const CARRIER_BOOKING_SUBPAGES = {
    details: "shipment-carrier-booking-details",
    review:  "shipment-carrier-booking-review",
  };
  const CARRIER_BOOKING_SUBPAGE_HASHES = Object.fromEntries(
    Object.entries(CARRIER_BOOKING_SUBPAGES).map(([suffix, key]) => [key, suffix])
  );
  // Customs Filing (Epic TKT-XW6TQK) — same nested-parent-with-children shape as Carrier
  // Booking (shipments/:id/customs-filing/:child), for the same reason (Details/Review are
  // two distinct pages under one nav entry, not a single flat section).
  const CUSTOMS_FILING_SUBPAGES = {
    details: "shipment-customs-filing-details",
    review:  "shipment-customs-filing-review",
  };
  const CUSTOMS_FILING_SUBPAGE_HASHES = Object.fromEntries(
    Object.entries(CUSTOMS_FILING_SUBPAGES).map(([suffix, key]) => [key, suffix])
  );

  const parseHash = hash => {
    if (!hash) return { page: "home", selectedId: null };
    if (hash === "shipments/new") return { page: "shipment-new", selectedId: null };
    if (/^shipments\/[^/]+\/edit$/.test(hash)) return { page: "shipment-edit", selectedId: hash.split("/")[1] };
    const acctMatch = hash.match(/^shipments\/([^/]+)\/accounting\/(costs|invoices|gp)$/);
    if (acctMatch) return { page: ACCOUNTING_SUBPAGES[acctMatch[2]], selectedId: acctMatch[1] };
    const bookingMatch = hash.match(/^shipments\/([^/]+)\/booking\/(details|review)$/);
    if (bookingMatch) return { page: CARRIER_BOOKING_SUBPAGES[bookingMatch[2]], selectedId: bookingMatch[1] };
    const filingMatch = hash.match(/^shipments\/([^/]+)\/customs-filing\/(details|review)$/);
    if (filingMatch) return { page: CUSTOMS_FILING_SUBPAGES[filingMatch[2]], selectedId: filingMatch[1] };
    // Export/Import Services — two-segment hash (shipments/:id/services/:side/:type),
    // same shape as Accounting's, since it's also a nested parent+children page family.
    const svcMatch = hash.match(/^shipments\/([^/]+)\/services\/(export|import)\/([a-z0-9-]+)$/i);
    if (svcMatch) {
      const pageKey = SERVICE_SUBPAGES[`${svcMatch[2].toLowerCase()}/${svcMatch[3].toLowerCase()}`];
      if (pageKey) return { page: pageKey, selectedId: svcMatch[1] };
    }
    const subMatch = hash.match(new RegExp(`^shipments/([^/]+)/(${SHIPMENT_SUBPAGE_HASH_PATTERN})$`));
    if (subMatch) return { page: SHIPMENT_SUBPAGES[subMatch[2]], selectedId: subMatch[1] };
    if (hash.startsWith("shipments/")) return { page: "detail", selectedId: hash.split("/")[1] || null };
    if (hash.startsWith("track/")) return { page: "track", selectedId: hash.slice(6) };
    if (hash.startsWith("reset-password/")) return { page: "reset-password", selectedId: hash.slice(15) };
    return { page: hash, selectedId: null };
  };

  const [page,       setPage]       = useState(() => {
    const hash = window.location.hash.replace("#", "").trim();
    return parseHash(hash).page;
  });
  const [selectedId, setSelectedId] = useState(() => {
    const hash = window.location.hash.replace("#", "").trim();
    return parseHash(hash).selectedId;
  });
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
  // Nav fold state persists per group (cd_navfold_*, same idiom as cd_theme) so an
  // expanded group survives reload; absent key = collapsed, the all-minimized default.
  const useFoldState = (storageKey) => {
    const [open, setOpen] = useState(() => localStorage.getItem(storageKey) === "1");
    useEffect(() => { localStorage.setItem(storageKey, open ? "1" : "0"); }, [open, storageKey]);
    return [open, setOpen];
  };
  const [mdmOpen,      setMdmOpen]      = useFoldState("cd_navfold_mdm");
  const [orgOpen,      setOrgOpen]      = useFoldState("cd_navfold_org");
  const [dashboardNavOpen, setDashboardNavOpen] = useFoldState("cd_navfold_dashboard");
  const [kanbanNavOpen,    setKanbanNavOpen]    = useFoldState("cd_navfold_kanban");
  const [financeNavOpen,   setFinanceNavOpen]   = useFoldState("cd_navfold_mdm_finance");
  const [locationsNavOpen, setLocationsNavOpen] = useFoldState("cd_navfold_mdm_locations");
  const [customersNavOpen, setCustomersNavOpen] = useFoldState("cd_navfold_mdm_customers");
  const [contractsNavOpen, setContractsNavOpen] = useFoldState("cd_navfold_mdm_contracts");
  const [carriersNavOpen,  setCarriersNavOpen]  = useFoldState("cd_navfold_mdm_carriers");
  const [loopCodesNavOpen, setLoopCodesNavOpen] = useFoldState("cd_navfold_mdm_loop_codes");
  const [portsNavOpen,     setPortsNavOpen]     = useFoldState("cd_navfold_mdm_ports");
  const [detailAction, setDetailAction] = useState(null);
  const [user,         setUser]         = useState(null);
  const [authLoading,  setAuthLoading]  = useState(true);
  const [changePwOpen,   setChangePwOpen]   = useState(false);
  const [changePwForced, setChangePwForced] = useState(false);
  const [logoutNotice, setLogoutNotice] = useState(null);

  // Verify stored token on mount — a still-valid JWT restores the session silently,
  // bypassing the login form entirely, so the password-expiry check has to be
  // re-evaluated here too (not just in handleLogin) or it could go unenforced forever.
  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { setAuthLoading(false); return; }
    api.auth.me()
      .then(u => {
        setUser(u);
        setAuthLoading(false);
        if (u.passwordExpired) { setChangePwForced(true); setChangePwOpen(true); }
      })
      .catch(() => { localStorage.removeItem(TOKEN_KEY); setAuthLoading(false); });
  }, []);

  // Listen for 401 → auto-logout
  useEffect(() => {
    const h = () => { setUser(null); };
    window.addEventListener("cargodesk:logout", h);
    return () => window.removeEventListener("cargodesk:logout", h);
  }, []);

  const [activeRole, setActiveRole] = useState(() => localStorage.getItem("cargodesk_active_role") || null);
  const activeRoleInitialized = useRef(false);
  useEffect(() => {
    // Persist so api.js can attach X-Active-Role header on every request
    if (activeRole) localStorage.setItem(ACTIVE_ROLE_KEY, activeRole);
    else            localStorage.removeItem(ACTIVE_ROLE_KEY);
    if (!activeRoleInitialized.current) { activeRoleInitialized.current = true; return; }
    if (user) {
      navigate("home");
      // Re-fetch shipments so the server-side scope filter runs with the new role
      api.shipments.list().then(setShipments).catch(() => {});
    }
  }, [activeRole]);

  // ── Office state ────────────────────────────────────────────────────────────
  // ACTIVE_OFFICE_KEY ("cargodesk_active_office") stores the plain office ID for api.js headers.
  // A separate key stores the full JSON object so we can restore the full office on reload.
  const OFFICE_DATA_KEY     = "cargodesk_active_office_data";
  const OFFICE_REMEMBER_KEY = "cargodesk_remember_office";
  const [activeOffice,     setActiveOfficeState] = useState(() => {
    try { return JSON.parse(localStorage.getItem(OFFICE_DATA_KEY) || "null"); } catch { return null; }
  });
  const [officePicker,   setOfficePicker]   = useState(false);
  const [rememberOffice, setRememberOffice] = useState(
    () => localStorage.getItem(OFFICE_REMEMBER_KEY) === "1"
  );

  const setActiveOffice = (office) => {
    setActiveOfficeState(office);
    if (office) {
      localStorage.setItem(ACTIVE_OFFICE_KEY, String(office.id));   // plain ID for api.js header
      localStorage.setItem(OFFICE_DATA_KEY, JSON.stringify(office)); // full object for reload
    } else {
      localStorage.removeItem(ACTIVE_OFFICE_KEY);
      localStorage.removeItem(OFFICE_DATA_KEY);
    }
  };

  // Offices available in the picker:
  // - allOffices users: all active org offices (fetched fresh after login)
  // - regular users: only their assigned offices from the login response
  const userOffices    = user?.offices || [];
  const userAllOffices = !!user?.allOffices;
  const [pickerOffices, setPickerOffices] = useState([]);

  useEffect(() => {
    if (!user) return;
    // If a remembered office is already restored from localStorage, skip picker
    if (activeOffice && localStorage.getItem(OFFICE_REMEMBER_KEY) === "1") return;
    // Global-access users already see every office unconditionally (server-side, allOffices
    // bypasses office scoping entirely — see applyShipmentAccessFilter) — picking a "current
    // office" is meaningless for them, so skip the forced picker rather than interrupt every
    // fresh login with a choice that has no actual effect on what they can see or do.
    if (userAllOffices) return;
    if (userOffices.length === 1 && !activeOffice) {
      setActiveOffice(userOffices[0]);
      return;
    }
    if (userOffices.length > 1 && !activeOffice) {
      setPickerOffices(userOffices);
      setOfficePicker(true);
    }
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const ROLE_RANK   = { viewer: 0, occ_bk: 1, trade_manager: 1, operator: 2, admin: 3 };
  const ROLE_LABELS = { admin: "Admin", operator: "Operator", occ_bk: "OCC Booking", trade_manager: "Trade Manager", viewer: "Viewer" };
  const primaryRole    = (roles) => [...(roles || [])].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0] || 'viewer';
  // Direct bug report: this used to offer every role in the whole system ranked at or below the
  // user's own primary role (an admin's own "impersonate any lower role" testing shortcut) —
  // surprising and wrong from the account owner's side, since the switcher's options had no
  // relationship to what was actually assigned to them (User Management showed 2 roles, the
  // switcher offered all 5). Now strictly the roles this account actually has, nothing more.
  const availableRoles = (roles) =>
    [...new Set(roles || [])].sort((a, b) => (ROLE_RANK[b] ?? -1) - (ROLE_RANK[a] ?? -1));
  const userRoles       = Array.isArray(user?.roles) ? user.roles : (user?.role ? [user.role] : ['viewer']);
  const userPrimaryRole = primaryRole(userRoles);
  const effectiveRoles  = activeRole ? [activeRole] : userRoles;
  const effectiveRole   = activeRole || userPrimaryRole;
  const roleCanEditShipments = effectiveRoles.some(r => ['admin', 'operator', 'occ_bk'].includes(r));

  const handleLogin  = (token, userData, passwordExpired) => {
    localStorage.setItem(TOKEN_KEY, token);
    // Only clear office selection if user hasn't opted to remember it
    if (localStorage.getItem(OFFICE_REMEMBER_KEY) !== "1") {
      localStorage.removeItem(ACTIVE_OFFICE_KEY);
      localStorage.removeItem(OFFICE_DATA_KEY);
      setActiveOfficeState(null);
    }
    setUser(userData);
    setActiveRole(null);
    setLogoutNotice(null);
    // Clear a stale "inactivity" flag now, not just after the next idle-logout — otherwise a
    // later, unrelated manual logout would clear TOKEN_KEY again and other tabs' storage
    // listener would still see the OLD reason and wrongly show the inactivity banner.
    localStorage.removeItem("cargodesk_logout_reason");
    if (passwordExpired) { setChangePwForced(true); setChangePwOpen(true); }
    // Return this tab to wherever IT was showing when an idle-timeout logged it out — a plain
    // manual logout never sets this key, so a deliberate sign-out still lands on the default
    // home screen rather than silently reopening whatever was on screen before.
    const returnHash = sessionStorage.getItem("cargodesk_return_hash");
    if (returnHash) {
      sessionStorage.removeItem("cargodesk_return_hash");
      window.location.hash = returnHash;
    } else if (window.location.hash.replace("#", "").trim() === "login") {
      // A normal fresh login (not an idle-timeout tab restore) still has the hash forced to
      // "login" by the logged-out effect above — nothing else ever moves it off that once
      // `user` becomes truthy, so the app would otherwise render blank on hash="login" (no
      // page block matches it) instead of landing on Home.
      window.location.hash = "home";
    }
  };
  const handleLogout = ({ reason } = {}) => {
    if (reason === "inactivity") {
      // Captured BEFORE clearing anything — sessionStorage is per-tab (unlike localStorage), so
      // each open tab remembers its own screen independently. cargodesk_logout_reason is the
      // one shared (localStorage) signal every OTHER tab's `storage` listener reacts to, so all
      // of them show the same accurate banner too, not just the tab that actually noticed.
      sessionStorage.setItem("cargodesk_return_hash", window.location.hash);
      localStorage.setItem("cargodesk_logout_reason", "inactivity");
      setLogoutNotice("Logged out due to inactivity");
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ACTIVE_ROLE_KEY);
    localStorage.removeItem(ACTIVE_OFFICE_KEY);
    localStorage.removeItem(OFFICE_DATA_KEY);
    localStorage.removeItem(OFFICE_REMEMBER_KEY);
    setRememberOffice(false);
    setUser(null);
    setActiveRole(null);
    setActiveOfficeState(null);
    setPickerOffices([]);
  };

  // Idle-timeout auto-logout — multi-tab aware (see src/hooks/useIdleLogout.js). Activity in
  // ANY open tab keeps the whole session alive; when the shared idle threshold is actually
  // crossed, every tab (the one that noticed, and every other one reacting to the resulting
  // `storage` event) logs itself out and remembers its own screen to return to.
  useIdleLogout({
    enabled: !!user,
    timeoutMinutes: Number(appSettings.idleTimeoutMinutes) || 30,
    onIdle: useCallback(({ broadcastOnly } = {}) => {
      if (broadcastOnly) {
        // Another tab already cleared the token and set the reason — this tab just needs to
        // capture its own screen and drop its own session state, not repeat the localStorage work.
        sessionStorage.setItem("cargodesk_return_hash", window.location.hash);
        setLogoutNotice("Logged out due to inactivity");
        setUser(null);
        setActiveRole(null);
        setActiveOfficeState(null);
      } else {
        handleLogout({ reason: "inactivity" });
      }
    }, []), // eslint-disable-line react-hooks/exhaustive-deps
  });

  // Load all data + settings — only after user is authenticated
  useEffect(() => {
    if (!user) return;
    setReady(false);
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
  }, [user?.id]);

  const selectedShipment = shipments.find(s => s.id === selectedId);

  // Shipment edit-locking (first-come-first-served, whole-shipment) — direct request: two
  // edit-capable users on the same shipment at the same time can produce conflicting writes,
  // and this app has no field-level merge/conflict resolution anywhere. The lock is claimed the
  // instant an edit-capable user opens a shipment (any of its sub-pages, not just Overview —
  // this fires off selectedId directly rather than a specific page component, since some of
  // those pages, like the full edit form, don't mount ShipmentHeaderBar) and released the moment
  // they navigate to a different shipment or stop being edit-capable (e.g. an admin switching to
  // the viewer role mid-session). A viewer/trade_manager never attempts to acquire — they can't
  // edit shipments regardless of the lock, so there's nothing for them to claim. No manual
  // force-unlock: a crashed tab or lost connection just self-clears via the server's own
  // heartbeat expiry (EDIT_LOCK_TTL_MINUTES) once this effect stops renewing it.
  const [shipmentLock, setShipmentLock] = useState(null);
  useEffect(() => {
    if (!selectedId || !roleCanEditShipments) { setShipmentLock(null); return; }
    let live = true;
    let owned = false;
    const applyResult = (r) => {
      if (!live) return;
      owned = !!r.ownedByMe;
      setShipmentLock({ shipmentId: selectedId, ...r });
    };
    api.shipments.editLock.acquire(selectedId).then(applyResult).catch(() => {});
    const heartbeat = setInterval(() => {
      api.shipments.editLock.acquire(selectedId).then(applyResult).catch(() => {});
    }, 5 * 60 * 1000);

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsHost = import.meta.env.DEV ? "localhost:3001" : window.location.host;
    const ws = new WebSocket(`${proto}//${wsHost}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", shipmentId: selectedId }));
    ws.onmessage = e => {
      try {
        const frame = JSON.parse(e.data);
        if (frame.type !== "edit_lock_changed" || frame.shipmentId !== selectedId) return;
        if (frame.locked) {
          owned = frame.lockedById === user?.id;
          setShipmentLock({
            shipmentId: selectedId, locked: true, ownedByMe: owned,
            lockedById: frame.lockedById, lockedByName: frame.lockedByName, expiresAt: frame.expiresAt,
          });
        } else {
          owned = false;
          setShipmentLock({ shipmentId: selectedId, locked: false, ownedByMe: false });
        }
      } catch { /* ignore */ }
    };

    return () => {
      live = false;
      clearInterval(heartbeat);
      ws.close();
      if (owned) api.shipments.editLock.release(selectedId).catch(() => {});
    };
  }, [selectedId, roleCanEditShipments, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared by ShipmentDetailPage and its promoted sub-pages (e.g. ShipmentPartiesPage) — same shipment PUT, multiple entry points.
  const handleUpdateShipment = async (id, form) => {
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
  };

  // Shared by ShipmentDetailPage and ShipmentContainersPage — same container CRUD, two entry points.
  const handleAddContainer = async (shipmentId, form) => {
    try {
      const created = await api.containers.create({ shipmentId, ...form });
      setContainers(p => [...p, created]);
      toast.success("Container added");
    } catch (e) { toast.error(e.message); throw e; }
  };
  // Bulk Container Import — the modal itself already calls api.containerImport.commit and gets
  // back every created container in one response; this just merges them into the same shared
  // `containers` array handleAddContainer maintains, so both entry points stay in sync.
  const handleImportContainers = created => { setContainers(p => [...p, ...created]); };
  // Both handlers only ever fire from within a shipment-detail context (ShipmentDetailPage/
  // ShipmentContainersPage, neither renders without a selected shipment), so selectedId is
  // reliably the right scope — matches handleAddContainer's own explicit shipmentId param
  // in spirit without needing to thread a new prop through every child caller.
  const handleEditContainer = async (id, form, { silent = false } = {}) => {
    try {
      const updated = await api.containers.update(selectedId, id, form);
      setContainers(p => p.map(c => c.id === id ? { ...c, ...updated } : c));
      if (!silent) toast.success("Container updated");
      return updated;
    } catch (e) { toast.error(e.message); throw e; }
  };
  const handleDeleteContainer = async id => {
    try {
      await api.containers.remove(selectedId, id);
      setContainers(p => p.filter(c => c.id !== id));
      toast.success("Container removed");
    } catch (e) { toast.error(e.message); }
  };

  const formDirtyRef = useRef(false);
  const [formCtrListOpen,  setFormCtrListOpen]  = useState(false);
  const [formCtrModal,     setFormCtrModal]     = useState(null);
  const [newCtrSignal,     setNewCtrSignal]     = useState(0);

  const isFormPage = p => p === "shipment-new" || p === "shipment-edit";
  const formHash   = (p, id) => p === "shipment-new" ? "shipments/new" : `shipments/${id}/edit`;

  // TKT-OJYO71: a dirty in-page form (e.g. Add/Edit Container on the Cargo page) can
  // register a navigation guard that auto-validates + auto-saves before letting a
  // section switch through, rather than silently discarding it — distinct from the
  // isFormPage/formDirtyRef check right below, which is the older, separate
  // confirm-then-discard mechanism for the standalone shipment create/edit page.
  const navigate = async (key, id = null) => {
    const guardResult = await runNavigationGuard();
    if (!guardResult.proceed) { toast.error(guardResult.error); return; }
    if (isFormPage(page) && formDirtyRef.current) {
      if (!window.confirm("You have unsaved changes. Leave and discard them?")) return;
    }
    formDirtyRef.current = false;
    if (page === "settings" && key !== "settings")
      api.settings.get().then(s => setAppSettings(s)).catch(() => {});
    setPage(key);
    setSelectedId(id);
    if (key === "shipment-new")                          window.location.hash = "shipments/new";
    else if (key === "shipment-edit" && id)              window.location.hash = `shipments/${id}/edit`;
    else if (SHIPMENT_SUBPAGE_HASHES[key] && id)         window.location.hash = `shipments/${id}/${SHIPMENT_SUBPAGE_HASHES[key]}`;
    else if (ACCOUNTING_SUBPAGE_HASHES[key] && id)       window.location.hash = `shipments/${id}/accounting/${ACCOUNTING_SUBPAGE_HASHES[key]}`;
    else if (CARRIER_BOOKING_SUBPAGE_HASHES[key] && id)  window.location.hash = `shipments/${id}/booking/${CARRIER_BOOKING_SUBPAGE_HASHES[key]}`;
    else if (CUSTOMS_FILING_SUBPAGE_HASHES[key] && id)   window.location.hash = `shipments/${id}/customs-filing/${CUSTOMS_FILING_SUBPAGE_HASHES[key]}`;
    else if (SERVICE_SUBPAGE_HASHES[key] && id)          window.location.hash = `shipments/${id}/services/${SERVICE_SUBPAGE_HASHES[key]}`;
    else if (key === "detail" && id)                     window.location.hash = `shipments/${id}`;
    else                                                  window.location.hash = key;
  };

  // Browser back/forward
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.replace("#", "").trim();
      if (!hash) return;
      if (isFormPage(page) && formDirtyRef.current) {
        if (!window.confirm("You have unsaved changes. Leave and discard them?")) {
          window.location.hash = formHash(page, selectedId);
          return;
        }
        formDirtyRef.current = false;
      }
      const parsed = parseHash(hash);
      setPage(parsed.page);
      setSelectedId(parsed.selectedId);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [page, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Give the login page a real, explicit address once we're actually sure there's no
  // signed-in session — gated on authLoading the same way the render logic below is, so a
  // page reload with a still-valid stored token never gets its real deep-link hash
  // clobbered mid-restore. Direct report: the Forgot/Reset Password pages' own "Back to
  // sign in" links used to just clear the hash to "" — onHash's own `if (!hash) return`
  // guard above silently ignores an empty-hash change, so the link visibly did nothing.
  // Landing here on a real #login hash gives those links (and any future one) something
  // real to navigate back to.
  useEffect(() => {
    if (authLoading || user) return;
    if (page === "track" || page === "forgot-password" || page === "reset-password") return;
    if (window.location.hash.replace("#", "").trim() !== "login") window.location.hash = "login";
  }, [authLoading, user, page]);

  // kanban is top-level, not MDM
  const MDM_PAGES = ["mdm-carriers", "mdm-carrier-agents", "mdm-ports", "mdm-linked", "mdm-vessels", "mdm-commodities", "mdm-loop-codes", "mdm-loop-map-explorer", "mdm-tradelanes", "mdm-countries", "mdm-unlocodes", "mdm-customers", "mdm-sanctioned-customers", "mdm-contracts", "rate-benchmark", "mdm-finance", "mdm-charge-codes", "mdm-duty-rates", "mdm-equipment", "mdm-pack-types", "mdm-container-types", "mdm-invoice-reason-codes", "mdm-locations", "mdm-document-templates"];
  const ORG_PAGES = ["org-country", "org-branch", "org-office"];
  const ALL_PAGES = [...MDM_PAGES, ...ORG_PAGES, "manual"];
  const isMdmActive = MDM_PAGES.includes(page);
  const isOrgActive = ORG_PAGES.includes(page);

  if (page === "track") return <TrackingPage token={selectedId} />;
  if (page === "forgot-password") return <ForgotPasswordPage />;
  if (page === "reset-password")  return <ResetPasswordPage token={selectedId} />;

  if (authLoading) return <FullPageSpinner />;
  if (!user)       return <LoginPage onLogin={handleLogin} notice={logoutNotice} />;

  if (apiError) return (
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg, alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div style={{ fontFamily: T.head, fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 12,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><IconAnchor size={22} />CargoDesk</div>
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
  const NavBtn = ({ pageKey, icon: IconComp, iconColor, label, indent = false, subIndent = false,
                    activeExtra = false, foldable = false, open, onToggleFold }) => {
    if (!isEnabled(pageKey)) return null;
    const active = page === pageKey || activeExtra || (pageKey === "shipments" && (page === "detail" || page === "shipment-new" || page === "shipment-edit"));
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
        <IconComp size={fs + 3} color={iconColor} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1 }}>{label}</span>
        {foldable && (
          <span onClick={e => { e.stopPropagation(); onToggleFold(); }}
            title={open ? "Collapse" : "Expand"}
            style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, transition: "transform .2s",
              display: "inline-block", padding: "3px 4px", marginRight: -4, flexShrink: 0,
              transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
        )}
      </button>
    );
  };


  const PAGE_TITLES = {
    home:               "Home",
    quotes:             "Quotes",
    opportunities:      "Opportunities",
    shipments:          "Shipments",
    "shipment-detail":  "Shipment Detail",
    "shipment-new":     "New Shipment",
    "shipment-edit":    "Edit Shipment",
    dashboard:           "Consumption Dashboard",
    "space-configs":     "Space Configurations",
    "dashboard-archive": "Dashboard — Archive",
    "freight-audit":     "Freight Audit & Payment",
    "credit-overrides":  "Credit Overrides",
    kanban:             "Integration Board",
    "test-tools":       "Test Tools",
    "user-manual":      "User Manual",
    about:              "About",
    settings:           "Application Settings",
    "mdm-carriers":     "Master Data — Carriers",
    "mdm-carrier-agents": "Master Data — Carrier Agents",
    "mdm-vessels":      "Master Data — Vessels",
    "mdm-commodities":  "Master Data — Commodities",
    "mdm-ports":        "Master Data — Port Locations",
    "mdm-linked":       "Master Data — Linked Ports",
    "mdm-loop-codes":   "Master Data — Loop Codes",
    "mdm-loop-map-explorer": "Master Data — Loop Map Explorer",
    "mdm-tradelanes":   "Master Data — Trade Lanes",
    "mdm-regions":      "Master Data — Regions",
    "mdm-countries":    "Master Data — Countries",
    "mdm-unlocodes":    "Master Data — UN Location Codes",
    "mdm-customers":              "Master Data — Customers",
    "mdm-sanctioned-customers":  "Master Data — Sanctioned Customers",
    "mdm-contracts":    "Master Data — Contracts",
    "rate-benchmark":   "Rate Benchmarking",
    "mdm-finance": "Master Data — Finance",
    "mdm-charge-codes": "Master Data — Automated Charge Codes",
    "mdm-duty-rates": "Master Data — Duty Rate Chapters",
    "mdm-equipment": "Master Data — Equipment",
    "mdm-pack-types": "Master Data — Pack Types",
    "mdm-document-templates": "Master Data — Document Templates",
    "mdm-container-types": "Master Data — Container Types",
    "mdm-invoice-reason-codes": "Master Data — Invoice Reason Codes",
    "mdm-locations": "Master Data — Locations",
    "org-country":      "Organization — Countries",
    "org-branch":       "Organization — Branches",
    "org-office":       "Organization — Offices",
    schedules:          "Schedule Search",
    manual:             "User Manual",
  };

  // Breadcrumb label for each promoted shipment sub-page — without this the
  // header falls back to the raw page key (e.g. "shipment-accounting-gp").
  // Flat entries from the shared config; Accounting's 3 keys merged in (see M9 note above).
  const SHIPMENT_SUBPAGE_LABELS = {
    ...SHARED_SHIPMENT_SUBPAGE_LABELS,
    "shipment-accounting-invoices":"Invoice Entry",
    "shipment-accounting-costs":   "Cost Entry",
    "shipment-accounting-gp":      "GP Overview",
    // Both keys share one label — Details/Review are in-page tabs on a single page,
    // not two distinct pages, so the breadcrumb/header shouldn't change between them.
    "shipment-carrier-booking-details": "Carrier Booking",
    "shipment-carrier-booking-review":  "Carrier Booking",
    "shipment-customs-filing-details":  "Customs Filing",
    "shipment-customs-filing-review":   "Customs Filing",
    ...SERVICE_SUBPAGE_LABELS,
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

    // Shutdown Dev Server shortcut (admin + devMode only) — same admin-gated, dev-only
    // POST /api/admin/dev-shutdown the Danger Zone card in Application Settings calls; this is
    // just a faster second entry point, same precedent as the Test Tools icon right next to it
    // (a full settings-page/nav entry PLUS a header shortcut, not a replacement for either).
    const [devMode,         setDevMode]         = useState(false);
    const [shutdownConfirm, setShutdownConfirm] = useState(false);
    const [shuttingDown,    setShuttingDown]    = useState(false);
    const isAdminUser = effectiveRoles.includes('admin');

    useEffect(() => {
      fetch("/api/health").then(r => r.json()).then(d => setDevMode(!!d.devMode)).catch(() => {});
    }, []);

    const doShutdown = async () => {
      setShuttingDown(true);
      try { await api.admin.devShutdown(); }
      catch (e) { toast.error(e.message || "Shutdown request failed"); setShuttingDown(false); }
    };

    const [bellOpen, setBellOpen] = useState(false);
    const bellRef                 = useRef(null);
    const [activeSysMsgs, setActiveSysMsgs] = useState([]);
    const [expiringContracts, setExpiringContracts] = useState([]);

    useEffect(() => {
      const load = () => api.systemMessages.list().then(setActiveSysMsgs).catch(() => {});
      load();
      const t = setInterval(load, 60000);
      return () => clearInterval(t);
    }, []);

    // Contracts within 14 days of (or already past) their own valid_to — the one alert here
    // that isn't derived from already-loaded top-level state (shipments/allocations), since
    // contracts aren't fetched at the App.jsx level at all; a small dedicated endpoint keeps
    // this cheap rather than loading the full contracts list just for this. Same 60s poll
    // cadence as system messages.
    useEffect(() => {
      const load = () => api.contracts.expiring(14).then(setExpiringContracts).catch(() => {});
      load();
      const t = setInterval(load, 60000);
      return () => clearInterval(t);
    }, []);

    // Invoicing Discipline (TKT-YC7PZP) — shipments delivered past their responsible party's
    // own configured invoice-generation window with no confirmed invoice yet. Same shape as
    // expiring contracts above: a small dedicated endpoint (already scoped/bounded server-side),
    // purely informational — clicking navigates to Invoice Entry, never a block.
    const [overdueInvoiceDeadlines, setOverdueInvoiceDeadlines] = useState([]);
    useEffect(() => {
      const load = () => api.invoiceDeadlinesOverdue().then(setOverdueInvoiceDeadlines).catch(() => {});
      load();
      const t = setInterval(load, 60000);
      return () => clearInterval(t);
    }, []);

    // Command Center — Quality & Exception Management, TKT-Q09G0T. Same shape as the two bell
    // sections above (a milestone can silently blow past its planned date with nothing watching
    // it until now) — backed by the same bulk overdue-summary endpoint the Command Center's own
    // KPI card/breakdown panel use, so the bell and the always-on control-tower view never drift.
    const [milestoneAlerts, setMilestoneAlerts] = useState([]);
    useEffect(() => {
      const load = () => api.milestonesOverdueSummary().then(d => setMilestoneAlerts(d.items || [])).catch(() => {});
      load();
      const t = setInterval(load, 60000);
      return () => clearInterval(t);
    }, []);

    const BELL_DISMISS_KEY = "cargodesk_dismissed_bell";
    const todayStr = new Date().toISOString().split('T')[0];
    // Fixed rather than a configurable setting — same "surface it at all" scoping as the
    // rest of this pass; promote to an app_setting later if the fixed value needs tuning.
    const STALE_BOOKING_HOURS = 48;

    const [dismissedBell, setDismissedBell] = useState(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(BELL_DISMISS_KEY) || "{}");
        // Drop stale (non-today) entries on load
        return Object.fromEntries(Object.entries(raw).filter(([, d]) => d === todayStr));
      } catch { return {}; }
    });

    const dismissBellItem = id => {
      const next = { ...dismissedBell, [id]: todayStr };
      setDismissedBell(next);
      localStorage.setItem(BELL_DISMISS_KEY, JSON.stringify(next));
      // Close panel if this was the last visible item and no system messages remain
      const remainingBell        = visibleBellItems.filter(a => a.id !== id);
      const remainingBookingBell = visibleBookingBellItems.filter(b => b.id !== id);
      const remainingExpiring    = visibleExpiringContracts.filter(c => c.id !== id);
      const remainingOverdueInv = visibleOverdueInvoiceDeadlines.filter(d => d.shipmentId !== id);
      const remainingMilestones = visibleMilestoneAlerts.filter(m => `${m.shipmentId}-${m.milestoneKey}` !== id);
      if (remainingBell.length === 0 && remainingBookingBell.length === 0 && remainingExpiring.length === 0 && remainingOverdueInv.length === 0 && remainingMilestones.length === 0 && activeSysMsgs.length === 0) setBellOpen(false);
    };

    // Active allocations above their alert threshold, sorted worst-first (max 5 shown)
    const bellItems = (() => {
      if (!ready) return [];
      const consumed = {};
      shipments.forEach(s => {
        const teu = containers.filter(c => c.shipmentId === s.id).reduce((a, c) => a + (c.size === '40' ? 2 : 1), 0);
        consumed[s.carrierCode] = (consumed[s.carrierCode] || 0) + teu;
      });
      return allocations
        .filter(a => a.endDate >= todayStr && a.allocatedTEU > 0)
        .filter(a => (consumed[a.carrierCode] || 0) / a.allocatedTEU * 100 >= a.alertThreshold)
        .map(a => ({
          ...a,
          pct: Math.round((consumed[a.carrierCode] || 0) / a.allocatedTEU * 100),
        }))
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 5);
    })();
    const visibleBellItems = bellItems.filter(a => !dismissedBell[a.id]);

    // Carrier bookings needing attention: Rejected (auto-advanced, needs a manual
    // Confirm/Cancel decision) or Pending with no carrier response after STALE_BOOKING_HOURS.
    const bookingBellItems = (() => {
      if (!ready) return [];
      const now = Date.now();
      return shipments
        .filter(s => {
          if (s.bookingStatus === "Rejected") return true;
          if (s.bookingStatus === "Pending" && s.bookingRequestedAt) {
            return (now - new Date(s.bookingRequestedAt).getTime()) / 36e5 >= STALE_BOOKING_HOURS;
          }
          return false;
        })
        .map(s => ({
          id:       s.id,
          rejected: s.bookingStatus === "Rejected",
          hours:    s.bookingRequestedAt ? Math.floor((now - new Date(s.bookingRequestedAt).getTime()) / 36e5) : null,
        }))
        .sort((a, b) => (b.rejected - a.rejected) || ((b.hours || 0) - (a.hours || 0)))
        .slice(0, 5);
    })();
    const visibleBookingBellItems = bookingBellItems.filter(b => !dismissedBell[b.id]);
    const visibleExpiringContracts = expiringContracts.filter(c => !dismissedBell[c.id]);
    const visibleOverdueInvoiceDeadlines = overdueInvoiceDeadlines.filter(d => !dismissedBell[d.shipmentId]);
    const visibleMilestoneAlerts = milestoneAlerts.filter(m => !dismissedBell[`${m.shipmentId}-${m.milestoneKey}`]);

    const bellCount = visibleBellItems.length + visibleBookingBellItems.length + visibleExpiringContracts.length + visibleOverdueInvoiceDeadlines.length + visibleMilestoneAlerts.length + activeSysMsgs.length;

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
        <span style={{ width: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <AnyIcon icon={icon} size={14} />
        </span>
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
          {(page === "detail" || SHIPMENT_SUBPAGE_LABELS[page]) && selectedShipment ? (
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
                {SHIPMENT_SUBPAGE_LABELS[page] || "Details"}
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
              {/* Inner scroll wrapper — the outer div's own overflow:hidden only exists to clip
                  the rounded corners; without a bounded-height inner scroller, an account with
                  several active alert sections at once grows this panel as tall as its content,
                  stretching the page rather than scrolling ("infinite scroll" reported live). */}
              <div style={{ maxHeight: "70vh", overflowY: "auto" }}>

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

                {/* ── Carrier bookings section ── */}
                {visibleBookingBellItems.length > 0 && (
                  <>
                    <div style={{ padding: "10px 16px 8px",
                      borderBottom: `1px solid ${T.border}`,
                      display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.danger }}>
                        ⚓ Carrier Bookings
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                        {visibleBookingBellItems.length} shipment{visibleBookingBellItems.length > 1 ? "s" : ""}
                      </span>
                    </div>
                    {visibleBookingBellItems.map(b => (
                      <div key={b.id} style={{
                          display: "flex", alignItems: "center",
                          borderBottom: `1px solid ${T.border}22`,
                        }}>
                        <button type="button"
                          onClick={() => { navigate("shipment-carrier-booking-review", b.id); setBellOpen(false); }}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            flex: 1, padding: "10px 12px 10px 16px", background: "none", border: "none",
                            cursor: "pointer", textAlign: "left",
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>
                            {b.id}
                          </span>
                          <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600,
                            color: b.rejected ? T.danger : T.warning }}>
                            {b.rejected ? "Rejected" : `Pending ${b.hours}h`}
                          </span>
                        </button>
                        <button type="button"
                          onClick={() => dismissBellItem(b.id)}
                          title="Dismiss until tomorrow"
                          style={{ background: "none", border: "none", cursor: "pointer",
                            color: T.textMuted, fontSize: 14, padding: "10px 12px", lineHeight: 1, flexShrink: 0 }}
                          onMouseEnter={e => e.currentTarget.style.color = T.text}
                          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
                          ✕
                        </button>
                      </div>
                    ))}
                    <button type="button"
                      onClick={() => { navigate("shipments"); setBellOpen(false); }}
                      style={{ width: "100%", padding: "9px 16px", background: "none",
                        border: "none", cursor: "pointer",
                        fontFamily: T.body, fontSize: 12, color: T.textMuted, textAlign: "center" }}
                      onMouseEnter={e => { e.currentTarget.style.background = T.surfaceHover; e.currentTarget.style.color = T.text; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.textMuted; }}>
                      View all in Shipments →
                    </button>
                  </>
                )}

                {/* ── Contract expiry section ── */}
                {visibleExpiringContracts.length > 0 && (
                  <>
                    <div style={{ padding: "10px 16px 8px",
                      borderBottom: `1px solid ${T.border}`,
                      display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.warning }}>
                        📄 Contract Expiry
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                        {visibleExpiringContracts.length} contract{visibleExpiringContracts.length > 1 ? "s" : ""}
                      </span>
                    </div>
                    {visibleExpiringContracts.slice(0, 5).map(c => (
                      <div key={c.id} style={{
                          display: "flex", alignItems: "center",
                          borderBottom: `1px solid ${T.border}22`,
                        }}>
                        <button type="button"
                          onClick={() => { navigate("mdm-contracts"); setBellOpen(false); }}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            flex: 1, padding: "10px 12px 10px 16px", background: "none", border: "none",
                            cursor: "pointer", textAlign: "left",
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>
                              {c.contractNumber}
                            </span>
                            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                              {c.carrierCode}
                            </span>
                          </div>
                          <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600,
                            color: c.expired ? T.danger : T.warning }}>
                            {c.expired ? "Expired" : `Expires ${c.validTo}`}
                          </span>
                        </button>
                        <button type="button"
                          onClick={() => dismissBellItem(c.id)}
                          title="Dismiss until tomorrow"
                          style={{ background: "none", border: "none", cursor: "pointer",
                            color: T.textMuted, fontSize: 14, padding: "10px 12px", lineHeight: 1, flexShrink: 0 }}
                          onMouseEnter={e => e.currentTarget.style.color = T.text}
                          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
                          ✕
                        </button>
                      </div>
                    ))}
                    <button type="button"
                      onClick={() => { navigate("mdm-contracts"); setBellOpen(false); }}
                      style={{ width: "100%", padding: "9px 16px", background: "none",
                        border: "none", cursor: "pointer",
                        fontFamily: T.body, fontSize: 12, color: T.textMuted, textAlign: "center" }}
                      onMouseEnter={e => { e.currentTarget.style.background = T.surfaceHover; e.currentTarget.style.color = T.text; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.textMuted; }}>
                      View all in Master Data →
                    </button>
                  </>
                )}

                {/* ── Overdue invoice-generation deadline section (TKT-YC7PZP) ── */}
                {visibleOverdueInvoiceDeadlines.length > 0 && (
                  <>
                    <div style={{ padding: "10px 16px 8px",
                      borderBottom: `1px solid ${T.border}`,
                      display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.warning }}>
                        🧾 Invoicing Overdue
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                        {visibleOverdueInvoiceDeadlines.length} shipment{visibleOverdueInvoiceDeadlines.length > 1 ? "s" : ""}
                      </span>
                    </div>
                    {visibleOverdueInvoiceDeadlines.slice(0, 5).map(d => (
                      <div key={d.shipmentId} style={{
                          display: "flex", alignItems: "center",
                          borderBottom: `1px solid ${T.border}22`,
                        }}>
                        <button type="button"
                          onClick={() => { navigate("shipment-accounting-invoices", d.shipmentId); setBellOpen(false); }}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            flex: 1, padding: "10px 12px 10px 16px", background: "none", border: "none",
                            cursor: "pointer", textAlign: "left",
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>
                              {d.shipmentId}
                            </span>
                            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                              {d.companyName}
                            </span>
                          </div>
                          <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.warning }}>
                            {d.daysOverdue}d over
                          </span>
                        </button>
                        <button type="button"
                          onClick={() => dismissBellItem(d.shipmentId)}
                          title="Dismiss until tomorrow"
                          style={{ background: "none", border: "none", cursor: "pointer",
                            color: T.textMuted, fontSize: 14, padding: "10px 12px", lineHeight: 1, flexShrink: 0 }}
                          onMouseEnter={e => e.currentTarget.style.color = T.text}
                          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
                          ✕
                        </button>
                      </div>
                    ))}
                    <button type="button"
                      onClick={() => { navigate("reports"); setBellOpen(false); }}
                      style={{ width: "100%", padding: "9px 16px", background: "none",
                        border: "none", cursor: "pointer",
                        fontFamily: T.body, fontSize: 12, color: T.textMuted, textAlign: "center" }}
                      onMouseEnter={e => { e.currentTarget.style.background = T.surfaceHover; e.currentTarget.style.color = T.text; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.textMuted; }}>
                      View all in Reports →
                    </button>
                  </>
                )}

                {/* ── Milestone alerts section (TKT-Q09G0T) ── */}
                {visibleMilestoneAlerts.length > 0 && (
                  <>
                    <div style={{ padding: "10px 16px 8px",
                      borderBottom: `1px solid ${T.border}`,
                      display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.warning }}>
                        🎯 Milestone Alerts
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                        {visibleMilestoneAlerts.length} alert{visibleMilestoneAlerts.length > 1 ? "s" : ""}
                      </span>
                    </div>
                    {visibleMilestoneAlerts.slice(0, 5).map(m => {
                      const id = `${m.shipmentId}-${m.milestoneKey}`;
                      return (
                      <div key={id} style={{
                          display: "flex", alignItems: "center",
                          borderBottom: `1px solid ${T.border}22`,
                        }}>
                        <button type="button"
                          onClick={() => { navigate("shipment-milestones", m.shipmentId); setBellOpen(false); }}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            flex: 1, padding: "10px 12px 10px 16px", background: "none", border: "none",
                            cursor: "pointer", textAlign: "left",
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>
                              {m.shipmentId}
                            </span>
                            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                              {m.label}
                            </span>
                          </div>
                          <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.warning }}>
                            {m.daysOverdue}d over
                          </span>
                        </button>
                        <button type="button"
                          onClick={() => dismissBellItem(id)}
                          title="Dismiss until tomorrow"
                          style={{ background: "none", border: "none", cursor: "pointer",
                            color: T.textMuted, fontSize: 14, padding: "10px 12px", lineHeight: 1, flexShrink: 0 }}
                          onMouseEnter={e => e.currentTarget.style.color = T.text}
                          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
                          ✕
                        </button>
                      </div>
                      );
                    })}
                  </>
                )}

                {/* ── Allocation threshold section ── */}
                {visibleBellItems.length > 0 && (
                  <>
                    <div style={{ padding: "10px 16px 8px",
                      borderBottom: `1px solid ${T.border}`,
                      display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.warning }}>
                        ⚠ Above Threshold
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                        {visibleBellItems.length} allocation{visibleBellItems.length > 1 ? "s" : ""}
                      </span>
                    </div>
                    {visibleBellItems.map(a => (
                      <div key={a.id} style={{
                          display: "flex", alignItems: "center",
                          borderBottom: `1px solid ${T.border}22`,
                        }}>
                        <button type="button"
                          onClick={() => { navigate("dashboard"); setBellOpen(false); }}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            flex: 1, padding: "10px 12px 10px 16px", background: "none", border: "none",
                            cursor: "pointer", textAlign: "left",
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
                        <button type="button"
                          onClick={() => dismissBellItem(a.id)}
                          title="Dismiss until tomorrow"
                          style={{ background: "none", border: "none", cursor: "pointer",
                            color: T.textMuted, fontSize: 14, padding: "10px 12px", lineHeight: 1, flexShrink: 0 }}
                          onMouseEnter={e => e.currentTarget.style.color = T.text}
                          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
                          ✕
                        </button>
                      </div>
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

          {devMode && isAdminUser && (
            <button type="button" onClick={() => setShutdownConfirm(true)} title="Shutdown Dev Server"
              style={{ background: "none", border: "none", cursor: "pointer",
                fontSize: 15, padding: "4px 6px", lineHeight: 1,
                opacity: 0.55, color: T.text, transition: "opacity .15s, color .15s" }}
              onMouseEnter={e => { e.currentTarget.style.opacity = 1; e.currentTarget.style.color = T.danger; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = 0.55; e.currentTarget.style.color = T.text; }}>
              ⏻
            </button>
          )}

          {shutdownConfirm && (
            <ConfirmModal
              message="Stop the API server now? Every open tab (yours and anyone else's) loses its connection until it's restarted."
              confirmLabel="Shutdown Server"
              onConfirm={() => { setShutdownConfirm(false); doShutdown(); }}
              onCancel={() => setShutdownConfirm(false)}
            />
          )}

          {shuttingDown && (
            <Modal title="Server Shutting Down" onClose={() => {}} hideClose width={420}>
              <p style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6, margin: 0 }}>
                The API server is stopping cleanly. Restart it with <code style={{ fontFamily: T.mono, color: T.textCode }}>npm run dev</code>,
                then reload this page.
              </p>
            </Modal>
          )}

          {/* Test Tools shortcut — same IconBaseStation used for its sidebar entry under
              Integration Board, so it reads as the same destination from a second entry
              point rather than a new icon language. Direct nav, no dropdown — nothing about
              "tools like: schedule generator" implies more destinations, just more sections
              inside the one Test Tools page. */}
          <button type="button" onClick={() => navigate("test-tools")} title="Test Tools"
            style={{ background: "none", border: "none", cursor: "pointer",
              padding: "4px 6px", lineHeight: 1, display: "flex", alignItems: "center",
              opacity: page === "test-tools" ? 1 : 0.55, transition: "opacity .15s" }}
            onMouseEnter={e => e.currentTarget.style.opacity = 1}
            onMouseLeave={e => e.currentTarget.style.opacity = page === "test-tools" ? 1 : 0.55}>
            <IconBaseStation size={16} color={T.text} />
          </button>

          {/* Office switcher — shown when user has multiple offices or allOffices */}
          {(userOffices.length > 1 || userAllOffices) && (
            <button type="button"
              onClick={() => setOfficePicker(true)}
              title={activeOffice ? `Active office: ${activeOffice.code}` : "Select office"}
              style={{
                padding: "3px 10px", borderRadius: 20, cursor: "pointer",
                border: `1px solid ${activeOffice ? T.accent + "66" : T.border}`,
                background: activeOffice ? T.accent + "18" : "transparent",
                fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                color: activeOffice ? T.accent : T.textMuted,
                display: "flex", alignItems: "center", gap: 4,
              }}>
              <span style={{ fontSize: 12 }}>🏢</span>
              {activeOffice ? activeOffice.code : (userAllOffices ? "Global" : "No office")}
            </button>
          )}

          {/* Role selector — inline dropdown in nav; amber when overriding primary */}
          {availableRoles(userRoles).length > 1 && (() => {
            const isSwitched = activeRole !== null;
            return (
              <select
                value={activeRole || ""}
                onChange={e => setActiveRole(e.target.value || null)}
                title={isSwitched ? `Viewing as ${ROLE_LABELS[activeRole]} — primary: ${ROLE_LABELS[userPrimaryRole]}` : `Roles: ${userRoles.map(r => ROLE_LABELS[r]).join(", ")}`}
                style={{
                  padding: "3px 8px", borderRadius: 20,
                  border: `1px solid ${isSwitched ? T.warning + "66" : T.border}`,
                  background: isSwitched ? T.warning + "18" : "transparent",
                  fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                  color: isSwitched ? T.warning : T.textMuted,
                  cursor: "pointer", outline: "none",
                }}>
                <option value="">{ROLE_LABELS[userPrimaryRole]}</option>
                {availableRoles(userRoles).filter(r => r !== userPrimaryRole).map(r => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            );
          })()}

          {/* User menu */}
          <div ref={menuRef} style={{ position: "relative" }}>
            <button type="button" data-testid="user-avatar-btn" onClick={() => setOpen(o => !o)}
              style={{
                width: 32, height: 32, borderRadius: "50%", border: "none",
                background: T.accent, cursor: "pointer", flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: T.head, fontSize: 14, fontWeight: 800, color: T.btnPrimaryText,
                boxShadow: open ? `0 0 0 3px ${T.accent}44` : "none",
                transition: "box-shadow .15s",
              }}>
              {user.name?.[0]?.toUpperCase() || "?"}
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
                  }}>{user.name?.[0]?.toUpperCase() || "?"}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text }}>
                      {user.name}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                      {userRoles.map(r => (
                        <span key={r} style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                          {ROLE_LABELS[r]}
                        </span>
                      ))}
                      {activeRole !== null && (
                        <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                          color: T.warning, background: T.warning + "18",
                          borderRadius: 4, padding: "1px 6px", border: `1px solid ${T.warning}44` }}>
                          → {ROLE_LABELS[activeRole]}
                        </span>
                      )}
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
                <MenuItem icon="⚖" label="License & Terms"  onClick={() => navigate("license")} />
                <MenuItem icon="⌨" label="Keyboard Shortcuts" disabled sub="Coming soon" />

                <Divider />

                {!authCtxValue.isTradeManager && <MenuItem icon={IconSettings} label="Application Settings" onClick={() => navigate("settings")} />}
                <MenuItem icon={IconLock} label="Change Password" onClick={() => { setChangePwForced(false); setChangePwOpen(true); }} />

                <Divider />

                <MenuItem icon="🚪" label="Sign Out" onClick={handleLogout} />
              </div>
            )}
          </div>
        </div>
      </header>
    );
  };

  const authCtxValue = {
    user,
    activeRole:         effectiveRole,
    activeRoles:        effectiveRoles,
    canEdit:            effectiveRoles.some(r => r !== 'viewer'),
    // Downgraded to read-only whenever another edit-capable user currently holds the open
    // shipment's edit lock — see the shipmentLock effect below. Guarded on shipmentId matching
    // selectedId so a brief render between navigating away and the lock effect's own cleanup
    // never misattributes a stale lock to the newly-selected shipment.
    canEditShipments:   roleCanEditShipments && !(shipmentLock?.locked && !shipmentLock?.ownedByMe && shipmentLock?.shipmentId === selectedId),
    canManageConfigs:   effectiveRoles.some(r => ['admin', 'operator', 'trade_manager'].includes(r)),
    // MDM reference data (carriers/vessels/ports/lanes/countries/regions/commodities/linked
    // ports) is read-only for trade_manager — they manage Contracts/Allocations (above), not
    // the underlying reference data those entities point to.
    canManageMdm:       effectiveRoles.some(r => ['admin', 'operator'].includes(r)),
    canEditKanban:      effectiveRoles.some(r => ['admin', 'operator'].includes(r)),
    isAdmin:            effectiveRoles.includes('admin'),
    isViewer:           effectiveRoles.every(r => r === 'viewer'),
    isOccBk:            effectiveRoles.includes('occ_bk'),
    isTradeManager:     effectiveRoles.includes('trade_manager'),
    shipmentLock:       shipmentLock?.shipmentId === selectedId ? shipmentLock : null,
    activeOffice,
    userOffices,
    allOffices:         userAllOffices,
    setActiveOffice,
  };

  return (
  <AuthContext.Provider value={authCtxValue}>
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg, fontFamily: T.body, color: T.text }}>

      {/* ── Sidebar ── */}
      {(page === "detail" || Object.values(SHIPMENT_SUBPAGES).includes(page) || Object.values(ACCOUNTING_SUBPAGES).includes(page) || Object.values(CARRIER_BOOKING_SUBPAGES).includes(page) || Object.values(CUSTOMS_FILING_SUBPAGES).includes(page) || SERVICE_PAGE_KEYS.includes(page)) && selectedShipment ? (
        <ShipmentDetailSidebar
          shipment={selectedShipment}
          ctrCount={containers.filter(c => c.shipmentId === selectedShipment.id).length}
          navigate={navigate}
          onSectionClick={setDetailAction}
          currentPage={page}
          appSettings={appSettings}
          onSidebarOrderSaved={order => setAppSettings(s => ({ ...s, shipment_sidebar_order: JSON.stringify(order) }))}
        />
      ) : page === "shipment-new" ? (
        <ShipmentFormSidebar mode="new" shipment={null} navigate={navigate} onContainers={() => setNewCtrSignal(p => p + 1)} />
      ) : page === "shipment-edit" && selectedShipment ? (
        <ShipmentFormSidebar mode="edit" shipment={selectedShipment} navigate={navigate} onContainers={() => setFormCtrListOpen(true)} />
      ) : (
        <aside style={{ width: 240, height: "100vh", position: "sticky", top: 0,
          background: T.surface, borderRight: `1px solid ${T.border}`,
          display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>

          {/* Logo — click to go home */}
          <div style={{ padding: "22px 20px 20px", borderBottom: `1px solid ${T.border}` }}>
            <div onClick={() => navigate("home")} style={{ fontFamily: T.head, fontSize: 17, fontWeight: 800, color: T.text, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 7 }}><IconAnchor size={17} />CargoDesk</div>
            <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted, marginTop: 3, letterSpacing: ".12em", textTransform: "uppercase" }}>
              Freight Management
            </div>
          </div>

          {/* Nav */}
          <nav data-testid="main-nav" style={{ padding: "14px 12px", flex: 1, overflowY: "auto" }}>

            {/* Top-level items */}
            <NavBtn pageKey="opportunities" icon={IconFlag} label="Opportunities" />
            <NavBtn pageKey="quotes" icon={IconReceipt} label="Quotes" />
            <NavBtn pageKey="shipments" icon={IconSailboat} label="Shipments" />

            {/* Credit Overrides (TKT-GLWMFP) — deliberately a standalone top-level item, NOT
                nested under Accounting (that whole section is hidden from trade_manager's nav,
                v0.29.0) — a narrow carve-out so the one action a trade_manager IS exclusively
                authorized for stays reachable. Gated to the same 3 roles the backend queue
                endpoint itself accepts, so occ_bk/viewer never see a link that would just 403. */}
            {effectiveRoles.some(r => ["admin", "operator", "trade_manager"].includes(r)) && (
              <NavBtn pageKey="credit-overrides" icon={IconWarning} label="Credit Overrides" />
            )}

            {/* Dashboard sub-group — folded by default (see NavBtn's foldable prop) */}
            <NavBtn pageKey="dashboard" icon={IconDashboard} label="Dashboard"
              activeExtra={["space-configs", "dashboard-archive", "freight-audit"].includes(page)}
              foldable open={dashboardNavOpen} onToggleFold={() => setDashboardNavOpen(o => !o)} />
            {dashboardNavOpen && (
              <>
                <NavBtn pageKey="space-configs"  icon={IconFlash} label="Space Configurations" indent />
                <NavBtn pageKey="dashboard-archive" icon={IconArchive} label="Archive"           indent />
                <NavBtn pageKey="freight-audit" icon={IconFileCertificate} label="Freight Audit" indent />
              </>
            )}

            {/* Reports — same finance-access gate as Dashboard's Margin tab for the GP/Billing
                tabs (the backend hard-403s a non-finance user rather than serving redacted
                data); a trade_manager also sees this link even without canViewFinance, since
                Invoice Collections is where their own lane-scoped status-override authority
                actually gets exercised — ReportsPage itself hides the finance-only tabs and
                defaults straight to Collections for a trade_manager-only visitor. */}
            {(appSettings.finance_view_enabled !== 'false' && (effectiveRoles.includes('admin') || !!(user?.canViewFinance) || authCtxValue.isTradeManager)) && (
              <NavBtn pageKey="reports" icon={IconChartBar} label="Reports" />
            )}

            <NavBtn pageKey="kanban" icon={IconClipboard} label="Integration Board"
              activeExtra={["releases", "test-plans", "test-runs", "test-cases", "test-tools"].includes(page)}
              foldable open={kanbanNavOpen} onToggleFold={() => setKanbanNavOpen(o => !o)} />
            {kanbanNavOpen && (
              <>
                <NavBtn pageKey="releases"    icon={IconTag} label="Releases"    indent />
                <NavBtn pageKey="test-plans"  icon={IconFlask} label="Test Plans"  indent />
                <NavBtn pageKey="test-runs"   icon={IconRefresh} label="Test Runs"   indent />
                <NavBtn pageKey="test-cases"  icon={IconCheck}  label="Test Cases"  indent />
                <NavBtn pageKey="test-tools"  icon={IconBaseStation} label="Test Tools"  indent />
              </>
            )}
            <NavBtn pageKey="schedules"  icon={IconCalendar} label="Schedule Search" />

            {/* AI Chat button — only shown when ai_agent_enabled=1 */}
            {appSettings.ai_agent_enabled === '1' && (
              <button
                type="button"
                onClick={() => setAiChatOpen(true)}
                title="Open AI Assistant"
                style={{
                  display: "flex", alignItems: "center", gap: 9,
                  width: "100%", padding: "7px 12px", marginBottom: 2,
                  background: aiChatOpen ? T.accentBg : "none",
                  border: `1px solid ${aiChatOpen ? T.accent + "44" : "transparent"}`,
                  borderRadius: 7, cursor: "pointer",
                  fontFamily: T.body, fontSize: 13, fontWeight: 500,
                  color: aiChatOpen ? T.accent : T.textMuted,
                  transition: "background .12s, color .12s",
                }}>
                <span style={{ fontSize: 14 }}>✦</span>
                AI Assistant
              </button>
            )}

            {/* MDM section */}
            <div style={{ marginTop: 10 }}>
              {/* MDM section header — clickable to expand/collapse */}
              <button onClick={() => setMdmOpen(o => !o)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "6px 12px", background: "none", border: "none", cursor: "pointer",
                  marginBottom: 2 }}>
                <span style={{ fontFamily: T.mono, fontSize: 9.5, color: isMdmActive ? T.accent : T.textMuted,
                  fontWeight: 700, textTransform: "uppercase", letterSpacing: ".12em" }}>
                  Master Data
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, transition: "transform .2s",
                  display: "inline-block", transform: mdmOpen ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
              </button>

              {mdmOpen && (
                <div>
                  {/* Sea Freight */}
                  <div style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: ".1em", padding: "5px 12px 3px 28px" }}>Sea Freight</div>
                  <NavBtn pageKey="mdm-customers"            icon={IconGroup} label="Customers"            indent
                    foldable open={customersNavOpen} onToggleFold={() => setCustomersNavOpen(o => !o)} />
                  {customersNavOpen && (
                    <NavBtn pageKey="mdm-sanctioned-customers" icon={IconCircle} iconColor="#ef4444" label="Sanctioned Customers" subIndent />
                  )}
                  <NavBtn pageKey="mdm-contracts"   icon={IconClipboard} label="Contracts"       indent
                    foldable open={contractsNavOpen} onToggleFold={() => setContractsNavOpen(o => !o)} />
                  {contractsNavOpen && (
                    <NavBtn pageKey="rate-benchmark"  icon={IconSearch}    label="Rate Benchmarking" subIndent />
                  )}
                  <NavBtn pageKey="mdm-carriers" icon={IconBuilding} label="Carriers"       indent
                    foldable open={carriersNavOpen} onToggleFold={() => setCarriersNavOpen(o => !o)} />
                  {carriersNavOpen && (
                    <NavBtn pageKey="mdm-carrier-agents" icon={IconLink} label="Carrier Agents" subIndent />
                  )}
                  <NavBtn pageKey="mdm-vessels"      icon={IconShip} label="Vessels"         indent />
                  <NavBtn pageKey="mdm-loop-codes" icon={IconRoute} label="Loop Codes"     indent
                    foldable open={loopCodesNavOpen} onToggleFold={() => setLoopCodesNavOpen(o => !o)} />
                  {loopCodesNavOpen && (
                    <NavBtn pageKey="mdm-loop-map-explorer" icon={IconEarth} label="Loop Map Explorer" subIndent />
                  )}
                  <NavBtn pageKey="mdm-commodities" icon={IconPackage} label="Commodities"     indent />
                  <NavBtn pageKey="mdm-ports"    icon={IconMapPin} label="Port Locations" indent
                    foldable open={portsNavOpen} onToggleFold={() => setPortsNavOpen(o => !o)} />
                  {portsNavOpen && (
                    <NavBtn pageKey="mdm-linked"   icon={IconLink} label="Linked Ports"   subIndent />
                  )}

                  <NavBtn pageKey="mdm-equipment" icon={IconArchive} label="Equipment"      indent />
                  <NavBtn pageKey="mdm-document-templates" icon={IconFile} label="Document Templates" indent />

                  {/* Finance sub-section — a real hub page (MdmFinancePage), not just a label,
                      per direct request; its children stay listed right here too for one-click
                      repeat access instead of always detouring through the hub's own cards.
                      Foldable, minimized by default (same NavBtn foldable prop the Dashboard/
                      Integration Board sub-groups already use). */}
                  <div style={{ marginTop: 10 }} />
                  <NavBtn pageKey="mdm-finance" icon={IconCoin} label="Finance" indent
                    foldable open={financeNavOpen} onToggleFold={() => setFinanceNavOpen(o => !o)} />
                  {financeNavOpen && (
                    <>
                      <NavBtn pageKey="mdm-charge-codes" icon={IconTag} label="Charge Codes"    subIndent />
                      <NavBtn pageKey="mdm-duty-rates" icon={IconCoin} label="Duty Rate Chapters" subIndent />
                      <NavBtn pageKey="mdm-invoice-reason-codes" icon={IconTag} label="Invoice Reason Codes" subIndent />
                    </>
                  )}

                  {/* Locations sub-section — same real-hub-page + foldable treatment as Finance. */}
                  <NavBtn pageKey="mdm-locations" icon={IconEarth} label="Locations" indent
                    foldable open={locationsNavOpen} onToggleFold={() => setLocationsNavOpen(o => !o)} />
                  {locationsNavOpen && (
                    <>
                      <NavBtn pageKey="mdm-tradelanes" icon={IconRoute} label="Trade Lanes"         subIndent />
                      <NavBtn pageKey="mdm-countries" icon={IconFlag} label="Countries"          subIndent />
                      <NavBtn pageKey="mdm-unlocodes" icon={IconHashtag} label="UN Location Codes"  subIndent />
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Organization section */}
            <div style={{ marginTop: 10 }}>
              <button onClick={() => setOrgOpen(o => !o)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "6px 12px", background: "none", border: "none", cursor: "pointer",
                  marginBottom: 2 }}>
                <span style={{ fontFamily: T.mono, fontSize: 9.5, color: isOrgActive ? T.accent : T.textMuted,
                  fontWeight: 700, textTransform: "uppercase", letterSpacing: ".12em" }}>
                  Organization
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, transition: "transform .2s",
                  display: "inline-block", transform: orgOpen ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
              </button>
              {orgOpen && (
                <div>
                  <NavBtn pageKey="org-country" icon={IconEarth} label="Country"  indent />
                  <NavBtn pageKey="org-branch"  icon={IconGovernment} label="Branch"   indent />
                  <NavBtn pageKey="org-office"  icon={IconBuilding} label="Office"   indent />
                </div>
              )}
            </div>
          </nav>

        </aside>
      )}

      {/* ── Main ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <Header />
        <main style={{ flex: 1, padding: "28px 36px 60px", overflow: "auto" }}>

        {(page === "detail" || SHIPMENT_SUBPAGE_LABELS[page]) && selectedShipment && isEnabled(page) && (
          <ShipmentHeaderBar shipment={selectedShipment} containers={containers}
            onNavigateToSchedules={() => navigate("shipment-schedules", selectedShipment.id)}
            onNavigateToParties={() => navigate("shipment-parties", selectedShipment.id)}
            onUpdate={handleUpdateShipment}
            onEdit={() => navigate("shipment-edit", selectedShipment.id)}
            onRefresh={async () => {
              const fresh = await api.shipments.get(selectedShipment.id);
              setShipments(p => p.map(s => s.id === fresh.id ? { ...s, ...fresh } : s));
            }} />
        )}

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
            onNewShipment={() => navigate("shipment-new")}
            isDark={isDark}
          />
        )}

        {/* Operational pages */}
        {page === "shipments" && (
          <ShipmentsPage
            shipments={shipments} containers={containers} carriers={carriers}
            financeEnabled={appSettings.finance_view_enabled !== 'false' && (effectiveRoles.includes('admin') || !!(user?.canViewFinance))}
            onSelect={id => navigate("detail", id)}
            onDelete={async id => {
              try {
                await api.shipments.remove(id);
                setShipments(p => p.filter(s => s.id !== id));
                setContainers(p => p.filter(c => c.shipmentId !== id));
                toast.success("Shipment deleted");
              } catch (e) { toast.error(e.message); }
            }}
            onNew={() => navigate("shipment-new")}
            onRefresh={() => api.shipments.list().then(setShipments).catch(() => {})} />
        )}

        {page === "shipment-new" && (
          <ShipmentFormPage
            mode="new"
            init={{}}
            ctrManagerTrigger={newCtrSignal}
            onDirtyChange={v => { formDirtyRef.current = v; }}
            onBack={() => navigate("shipments")}
            onSave={async (form, draftLegs = [], draftContainers = [], selectedSailing = null) => {
              try {
                const created = await api.shipments.create(form);
                setShipments(p => [created, ...p]);
                toast.success("Shipment created");
                if (created.screening?.result === "HIT") {
                  const parties = (created.screening.hits || []).map(h => `${h.field}: ${h.value}`).join(", ");
                  toast.warning(`Compliance review required — sanctioned party detected${parties ? ` (${parties})` : ""}`);
                }
                if (created.creditWarning?.onHold?.length) {
                  const names = created.creditWarning.onHold.map(h => `${h.companyName} (${h.role})`).join(", ");
                  toast.warning(`On credit hold: ${names} — this will block sending a carrier booking request and generating invoices until it's cleared`);
                }
                for (const { id: _draftId, polName: _pn, podName: _ppn, ...leg } of draftLegs.filter(l => l.pol || l.pod)) {
                  await api.legs.create(created.id, leg);
                }
                for (const ctr of draftContainers) {
                  const newCtr = await api.containers.create({ shipmentId: created.id, ...ctr });
                  setContainers(p => [...p, newCtr]);
                }
                if (selectedSailing) {
                  await api.schedules.save(created.id, { ...selectedSailing, templateId: selectedSailing.scheduleId ?? null }).catch(() => {});
                }
                navigate("detail", created.id);
              } catch (e) { toast.error(e.message); throw e; }
            }} />
        )}

        {page === "shipment-edit" && selectedId && (() => {
          const shp = shipments.find(s => s.id === selectedId);
          if (!shp) return null;
          return (
            <ShipmentFormPage
              mode="edit"
              init={shp}
              onDirtyChange={v => { formDirtyRef.current = v; }}
              onBack={() => navigate("detail", selectedId)}
              onSave={async (form) => {
                try {
                  const updated = await api.shipments.update(shp.id, form);
                  setShipments(p => p.map(s => s.id === shp.id ? { ...s, ...updated } : s));
                  toast.success("Shipment updated");
                  if (updated.screening?.result === "HIT") {
                    const parties = (updated.screening.hits || []).map(h => `${h.field}: ${h.value}`).join(", ");
                    toast.warning(`Compliance review required — sanctioned party detected${parties ? ` (${parties})` : ""}`);
                  }
                  navigate("detail", shp.id);
                } catch (e) { toast.error(e.message); throw e; }
              }} />
          );
        })()}

        {page === "detail" && selectedShipment && (
          <ShipmentDetailPage
            shipment={selectedShipment} containers={containers} carriers={carriers}
            detailAction={detailAction} onDetailActionConsumed={() => setDetailAction(null)}
            onBack={() => navigate("shipments")}
            onEdit={() => navigate("shipment-edit", selectedShipment.id)}
            onRefresh={async () => {
              const fresh = await api.shipments.get(selectedShipment.id);
              setShipments(p => p.map(s => s.id === fresh.id ? { ...s, ...fresh } : s));
            }}
            onUpdate={handleUpdateShipment}
            onAddContainer={handleAddContainer}
            onEditContainer={handleEditContainer}
            onDeleteContainer={handleDeleteContainer}
            onManageContainers={() => navigate("shipment-containers", selectedShipment.id)}
            onManagePartiesOffices={() => navigate("shipment-parties", selectedShipment.id)}
            onManageSchedules={() => navigate("shipment-schedules", selectedShipment.id)}
            onManageMilestones={() => navigate("shipment-milestones", selectedShipment.id)}
            onManageAccountingCosts={() => navigate("shipment-accounting-costs", selectedShipment.id)}
            onManageAccountingInvoices={() => navigate("shipment-accounting-invoices", selectedShipment.id)}
            onManageAccountingGp={() => navigate("shipment-accounting-gp", selectedShipment.id)} />
        )}

        {page === "shipment-conditions" && selectedShipment && (
          <ShipmentConditionsPage shipment={selectedShipment} />
        )}

        {page === "shipment-containers" && selectedShipment && (
          <ShipmentContainersPage
            shipment={selectedShipment} containers={containers}
            onBack={() => navigate("detail", selectedShipment.id)}
            onAddContainer={handleAddContainer}
            onEditContainer={handleEditContainer}
            onDeleteContainer={handleDeleteContainer}
            onImportContainers={handleImportContainers} />
        )}

        {page === "shipment-parties" && selectedShipment && (
          <ShipmentPartiesPage
            shipment={selectedShipment}
            onBack={() => navigate("detail", selectedShipment.id)}
            onUpdate={handleUpdateShipment}
            onShipmentPatched={updated => setShipments(p => p.map(s => s.id === updated.id ? { ...s, ...updated } : s))} />
        )}

        {page === "shipment-schedules" && selectedShipment && (
          <ShipmentSchedulesPage
            shipment={selectedShipment}
            onBack={() => navigate("detail", selectedShipment.id)}
            onUpdate={handleUpdateShipment}
            onRefresh={async () => {
              const fresh = await api.shipments.get(selectedShipment.id);
              setShipments(p => p.map(s => s.id === fresh.id ? { ...s, ...fresh } : s));
            }} />
        )}

        {page === "shipment-milestones" && selectedShipment && (
          <ShipmentMilestonesPage
            shipment={selectedShipment} containers={containers}
            onBack={() => navigate("detail", selectedShipment.id)} />
        )}

        {page === "shipment-documents" && selectedShipment && (
          <div style={{ maxWidth: 1100, margin: "0 auto" }}>
            <DocumentsModal shipment={selectedShipment} canEdit={authCtxValue.canEditShipments} standalone />
          </div>
        )}

        {page === "shipment-history" && selectedShipment && (
          <ShipmentHistoryPage shipment={selectedShipment} />
        )}

        {/* Export/Import Services dedicated pages (Epic TKT-TBS7QD) — one generic block
            handles all side x type combinations rather than one hardcoded JSX block per
            type. VGM gets its own VgmServicePage.jsx (its data lives directly on
            `containers`, not a satellite table, so it doesn't fit LoadingServicePage's
            shape — checked first, ahead of the generic isBespokeServiceType branch, since
            LoadingServicePage indexes doc-type/label maps that have no "VGM" entry).
            Loading/Unloading/Pickup/Delivery share LoadingServicePage.jsx (identical
            per-container date/time-plan shape); every other type gets GenericServicePage.jsx. */}
        {SERVICE_PAGE_INFO[page] && selectedShipment && (() => {
          const { side, type } = SERVICE_PAGE_INFO[page];
          return type === "VGM" ? (
            <VgmServicePage
              shipment={selectedShipment} containers={containers} side={side}
              canEdit={authCtxValue.canEditShipments}
              onEditContainer={handleEditContainer} />
          ) : isBespokeServiceType(type) ? (
            <LoadingServicePage
              shipment={selectedShipment} containers={containers} side={side} serviceType={type}
              canEdit={authCtxValue.canEditShipments}
              onViewDocuments={() => navigate("shipment-documents", selectedShipment.id)} />
          ) : (
            <GenericServicePage
              shipment={selectedShipment} side={side} serviceType={type}
              canEdit={authCtxValue.canEditShipments}
              onViewDocuments={() => navigate("shipment-documents", selectedShipment.id)} />
          );
        })()}

        {page === "shipment-accounting-costs" && selectedShipment && (
          <ShipmentAccountingCostsPage
            shipment={selectedShipment} containers={containers}
            onBack={() => navigate("detail", selectedShipment.id)} />
        )}

        {page === "shipment-accounting-invoices" && selectedShipment && (
          <ShipmentAccountingInvoicesPage
            shipment={selectedShipment} containers={containers}
            onBack={() => navigate("detail", selectedShipment.id)} />
        )}

        {page === "shipment-accounting-gp" && selectedShipment && (
          <ShipmentAccountingGpPage
            shipment={selectedShipment}
            onBack={() => navigate("detail", selectedShipment.id)} />
        )}

        {(page === "shipment-carrier-booking-details" || page === "shipment-carrier-booking-review") && selectedShipment && (
          <ShipmentCarrierBookingPage
            shipment={selectedShipment}
            initialTab={page === "shipment-carrier-booking-review" ? "review" : "details"}
            navigate={navigate}
            onBack={() => navigate("detail", selectedShipment.id)}
            onRefresh={async () => {
              const fresh = await api.shipments.get(selectedShipment.id);
              setShipments(p => p.map(s => s.id === fresh.id ? { ...s, ...fresh } : s));
            }} />
        )}

        {(page === "shipment-customs-filing-details" || page === "shipment-customs-filing-review") && selectedShipment && (
          <ShipmentCustomsFilingPage
            shipment={selectedShipment}
            initialTab={page === "shipment-customs-filing-review" ? "review" : "details"}
            navigate={navigate}
            onBack={() => navigate("detail", selectedShipment.id)} />
        )}

        {page === "kanban"      && isEnabled("kanban")    && (
          <Suspense fallback={<FullPageSpinner />}>
            <KanbanPage shipments={shipments} />
          </Suspense>
        )}
        {page === "releases"    && isEnabled("kanban")    && <ReleasesPage />}
        {page === "test-plans"  && isEnabled("kanban")    && <TestPlansPage />}
        {page === "test-runs"   && isEnabled("kanban")    && <TestRunsPage />}
        {page === "test-cases"  && isEnabled("kanban")    && <TestCasesPage />}
        {page === "test-tools"  && isEnabled("kanban")    && <TestToolsPage navigate={navigate} />}

        {page === "dashboard-archive" && (
          <DashboardArchive
            allocations={allocations.filter(a => a.endDate < new Date().toISOString().split("T")[0])
              .sort((a, b) => b.endDate.localeCompare(a.endDate))}
            carriers={carriers}
            onRenew={a => { setPendingRenew({ ...a, effectiveDate: "", endDate: "" }); navigate("space-configs"); }}
            onDelete={async id => { try { await api.allocations.remove(id); setAllocations(p => p.filter(x => x.id !== id)); toast.success("Configuration deleted"); } catch (e) { toast.error(e.message); } }}
          />
        )}

        {page === "dashboard" && (
          <DashboardPage
            shipments={shipments} containers={containers} carriers={carriers}
            allocations={allocations}
            financeEnabled={appSettings.finance_view_enabled !== 'false' && (effectiveRoles.includes('admin') || !!(user?.canViewFinance))} />
        )}

        {page === "reports" && isEnabled("reports") && <ReportsPage />}

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

        {page === "freight-audit" && (
          <FreightAuditPage shipments={shipments} navigate={navigate} />
        )}

        {page === "opportunities" && <OpportunitiesPage navigate={navigate} />}

        {page === "quotes" && (
          <QuotesPage navigate={navigate}
            onShipmentCreated={shp => setShipments(p => [shp, ...p])} />
        )}

        {page === "credit-overrides" && <CreditOverridesPage />}

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

        {page === "mdm-carrier-agents" && isEnabled("mdm-carrier-agents") && <MdmCarrierAgentsPage />}
        {page === "mdm-vessels"    && isEnabled("mdm-vessels")    && <MdmVesselsPage />}
        {page === "mdm-ports"      && isEnabled("mdm-ports")      && <MdmPortLocationsPage />}
        {page === "mdm-linked"     && isEnabled("mdm-linked")     && <MdmLinkedPortsPage />}
        {page === "mdm-loop-codes"&&                                  <MdmLoopCodesPage />}
        {page === "mdm-loop-map-explorer" &&                          <LoopMapExplorerPage />}
        {page === "mdm-tradelanes" &&                                 <MdmTradeLanesPage />}
        {page === "mdm-countries"  &&                                 <MdmCountriesPage />}
        {page === "mdm-unlocodes"  &&                                 <MdmUNLocationCodesPage />}
        {page === "mdm-commodities"&&                                 <MdmCommoditiesPage />}
        {page === "mdm-finance"&&                                     <MdmFinancePage navigate={navigate} />}
        {page === "mdm-locations"&&                                   <MdmLocationsPage navigate={navigate} />}
        {page === "mdm-charge-codes"&&                                <MdmChargeCodesPage />}
        {page === "mdm-duty-rates"&&                                  <MdmDutyRatesPage />}
        {page === "mdm-equipment"&&                                   <MdmEquipmentPage navigate={navigate} />}
        {page === "mdm-pack-types"&&                                  <MdmPackTypesPage />}
        {page === "mdm-document-templates"&&                          <DocumentTemplatesPage />}
        {page === "mdm-container-types"&&                             <MdmContainerTypesPage />}
        {page === "mdm-invoice-reason-codes"&&                        <MdmInvoiceReasonCodesPage />}
        {page === "mdm-customers"              && isEnabled("mdm-customers")             && <MdmCustomersPage />}
        {page === "mdm-sanctioned-customers"   && isEnabled("mdm-sanctioned-customers")  && <MdmSanctionedCustomersPage />}
        {page === "mdm-contracts"  && isEnabled("mdm-contracts")  && <MdmContractsPage />}
        {page === "rate-benchmark" && isEnabled("rate-benchmark") && <RateBenchmarkPage />}
        {page === "org-country"    && <CountryPage />}
        {page === "org-branch"     && <BranchPage />}
        {page === "org-office"     && <OfficePage />}
        {page === "schedules"      && <SchedulesPage />}
        {page === "manual"         && <UserManualPage />}
        {page === "about"          && <AboutPage />}
        {page === "license"        && <LicensePage />}
        {page === "settings" && !authCtxValue.isTradeManager && <AppSettingsPage />}

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
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border,
          display: "inline-flex", alignItems: "center", gap: 5 }}>
          <IconAnchor size={11} />CargoDesk · v{VERSION}
        </span>
        <span style={{ fontFamily: T.body, fontSize: 11, color: T.border }}>
          © {COPYRIGHT_YEAR} {COPYRIGHT_OWNER} ·{" "}
          <button type="button" onClick={() => navigate("license")}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
              fontFamily: T.body, fontSize: 11, color: T.border, textDecoration: "underline" }}>
            License & Terms
          </button>
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

      <AiChatDrawer
        open={aiChatOpen}
        onClose={() => setAiChatOpen(false)}
        shipmentId={(page === "detail" || SHIPMENT_SUBPAGE_LABELS[page]) ? selectedId : null}
      />

      {!licenseAccepted && (
        <div data-testid="license-modal" style={{ position: "fixed", inset: 0, zIndex: 9000,
          background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
            padding: "32px 36px", maxWidth: 560, width: "calc(100% - 48px)", boxShadow: "0 24px 64px rgba(0,0,0,.5)" }}>
            <h2 style={{ fontFamily: T.head, fontSize: 20, fontWeight: 800, color: T.text, margin: "0 0 8px" }}>
              License Agreement
            </h2>
            <p style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, margin: "0 0 20px" }}>
              CargoDesk · © {COPYRIGHT_YEAR} {COPYRIGHT_OWNER}
            </p>
            <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.7,
              background: T.bg, borderRadius: 8, padding: "16px 18px", marginBottom: 20,
              border: `1px solid ${T.border}`, maxHeight: 220, overflowY: "auto" }}>
              <p style={{ margin: "0 0 10px" }}>
                CargoDesk is provided for <strong>non-commercial use only</strong>. By clicking
                "I Accept" you agree to the End-User License Agreement (EULA).
              </p>
              <p style={{ margin: "0 0 10px" }}>
                You may not use this software for commercial purposes — including deploying it
                within a for-profit organisation, offering it as a service, or integrating it
                into a commercial product — without obtaining a separate written licence from
                the author.
              </p>
              <p style={{ margin: 0 }}>
                The software is provided "as is" without warranty of any kind. Full terms are
                available on the{" "}
                <button type="button" onClick={() => { navigate("license"); }}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                    fontFamily: T.body, fontSize: 13.5, color: T.accent, textDecoration: "underline" }}>
                  License & Terms
                </button>{" "}page.
              </p>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button"
                onClick={() => { localStorage.setItem("cargodesk_license_accepted", "1"); setLicenseAccepted(true); }}
                style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, cursor: "pointer",
                  background: T.accent, color: "#fff", border: "none", borderRadius: 7,
                  padding: "10px 22px" }}>
                I Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Container list modal (triggered from edit-form sidebar) ── */}
      {formCtrListOpen && selectedShipment && (() => {
        const shipCtrs = containers.filter(c => c.shipmentId === selectedShipment.id);
        return (
          <Modal title={`Containers — ${selectedShipment.id}`} onClose={() => setFormCtrListOpen(false)} width={760}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Btn onClick={() => { setFormCtrListOpen(false); setFormCtrModal("add"); }}>＋ Add Container</Btn>
              </div>
              {shipCtrs.length === 0 ? (
                <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body,
                  fontSize: 13, color: T.textMuted }}>
                  No containers yet — click Add Container to start.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {shipCtrs.map(c => (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 12,
                      padding: "10px 14px", background: T.bg, border: `1px solid ${T.border}`,
                      borderRadius: 8 }}>
                      <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text, flex: 1 }}>
                        {c.containerNumber || <em style={{ color: T.textMuted }}>No number</em>}
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent,
                        background: T.accentBg, border: `1px solid ${T.accent}33`,
                        borderRadius: 4, padding: "2px 8px" }}>{c.size}</span>
                      <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{c.type}</span>
                      {c.isDg && <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                        color: T.danger, background: T.danger + "18", border: `1px solid ${T.danger}44`,
                        borderRadius: 4, padding: "2px 6px" }}>DG {c.dgClass}</span>}
                      <div style={{ display: "flex", gap: 6 }}>
                        <Btn size="sm" variant="secondary" onClick={() => { setFormCtrListOpen(false); setFormCtrModal(c); }}>Edit</Btn>
                        <Btn size="sm" variant="danger" onClick={async () => {
                          if (!window.confirm(`Remove container ${c.containerNumber || c.id}?`)) return;
                          try {
                            await api.containers.remove(selectedShipment.id, c.id);
                            setContainers(p => p.filter(x => x.id !== c.id));
                            toast.success("Container removed");
                          } catch (e) { toast.error(e.message); }
                        }}>✕</Btn>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Modal>
        );
      })()}

      {/* ── Container add/edit modal (triggered from edit-form sidebar) ── */}
      {formCtrModal && selectedShipment && (
        <ContainerForm
          init={formCtrModal === "add" ? {} : formCtrModal}
          onSave={async (form) => {
            try {
              if (formCtrModal === "add") {
                const ctr = await api.containers.create({ shipmentId: selectedShipment.id, ...form });
                setContainers(p => [...p, ctr]);
                toast.success("Container added");
              } else {
                const updated = await api.containers.update(selectedShipment.id, formCtrModal.id, form);
                setContainers(p => p.map(c => c.id === formCtrModal.id ? { ...c, ...updated } : c));
                toast.success("Container updated");
              }
              setFormCtrModal(null);
              setFormCtrListOpen(true);
            } catch (e) { toast.error(e.message); }
          }}
          onCancel={() => { setFormCtrModal(null); setFormCtrListOpen(true); }}
        />
      )}

      {/* ── Office Picker Modal ─────────────────────────────────────────────── */}
      {/* Suppressed while a forced (expired-password) change is pending — that gate takes
          priority, and this modal's z-index (9000) would otherwise sit on top of it (z:1000). */}
      {officePicker && !(changePwOpen && changePwForced) && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 9000,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`,
            padding: "32px 36px", maxWidth: 520, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,.3)",
          }}>
            <div style={{ fontFamily: T.head, fontSize: 20, fontWeight: 800, color: T.text, marginBottom: 6 }}>
              Select Office
            </div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, marginBottom: 24 }}>
              Choose the office you are logging in as. You can switch later from the header.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {userAllOffices && (
                <button type="button" onClick={() => { setActiveOffice(null); setOfficePicker(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "14px 18px",
                    background: !activeOffice ? T.accent + "18" : T.bg,
                    border: `1.5px solid ${!activeOffice ? T.accent : T.border}`,
                    borderRadius: 10, cursor: "pointer", textAlign: "left", width: "100%",
                  }}>
                  <div style={{ fontSize: 22 }}>🌐</div>
                  <div>
                    <div style={{ fontFamily: T.head, fontSize: 13, fontWeight: 700, color: T.text }}>Global Access</div>
                    <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>View all offices — no filter applied</div>
                  </div>
                </button>
              )}
              {pickerOffices.map(office => (
                <button key={office.id} type="button"
                  onClick={() => { setActiveOffice(office); setOfficePicker(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "14px 18px",
                    background: activeOffice?.id === office.id ? T.accent + "18" : T.bg,
                    border: `1.5px solid ${activeOffice?.id === office.id ? T.accent : T.border}`,
                    borderRadius: 10, cursor: "pointer", textAlign: "left", width: "100%",
                  }}>
                  <div style={{ fontSize: 22 }}>{office.department === 'SE' ? '🚢' : '📦'}</div>
                  <div>
                    <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>
                      {office.code}
                      {office.isDefault && <span style={{ marginLeft: 8, fontFamily: T.body, fontSize: 10,
                        color: T.accent, background: T.accent + "18", borderRadius: 4, padding: "1px 6px" }}>default</span>}
                    </div>
                    <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{office.name}</div>
                  </div>
                </button>
              ))}
            </div>
            {/* Remember checkbox */}
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 18,
              cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
              <input type="checkbox" checked={rememberOffice}
                onChange={e => {
                  const val = e.target.checked;
                  setRememberOffice(val);
                  if (val) localStorage.setItem(OFFICE_REMEMBER_KEY, "1");
                  else localStorage.removeItem(OFFICE_REMEMBER_KEY);
                }}
                style={{ accentColor: T.accent }} />
              Remember my office selection until I switch or log out
            </label>
            {(activeOffice || userAllOffices) && (
              <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
                <button type="button" onClick={() => setOfficePicker(false)}
                  style={{
                    fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.textMuted,
                    background: "none", border: "none", cursor: "pointer", padding: "6px 12px",
                  }}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {changePwOpen && (
        <ChangePasswordModal
          forced={changePwForced}
          onClose={() => setChangePwOpen(false)}
          onSuccess={(newToken) => {
            if (newToken) localStorage.setItem(TOKEN_KEY, newToken);
            setChangePwOpen(false);
            setChangePwForced(false);
          }}
          onForceLogout={handleLogout}
        />
      )}

      <ToastContainer />
      <GlobalSavingOverlay />
    </div>
  </AuthContext.Provider>
  );
}

export default App;