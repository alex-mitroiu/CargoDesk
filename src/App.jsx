import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { T, applyTheme } from "./tokens";
import { toast } from "./toast";
import ToastContainer from "./components/primitives/ToastContainer";
import GlobalSavingOverlay from "./components/primitives/GlobalSavingOverlay";
import Spinner, { FullPageSpinner } from "./components/primitives/Spinner";
import { api, TOKEN_KEY, ACTIVE_ROLE_KEY, ACTIVE_OFFICE_KEY } from "./api";
import { AuthContext, useAuth } from "./AuthContext";
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
import { Modal } from "./components/primitives/Modal";
import { Field } from "./components/primitives/Form";
import {
  IconSailboat, IconDashboard, IconFlash, IconArchive, IconClipboard, IconTag,
  IconFlask, IconRefresh, IconCheck, IconCalendar, IconGroup, IconCircle,
  IconBuilding, IconShip, IconPackage, IconMapPin, IconLink, IconRoute,
  IconFlag, IconHashtag, IconEarth, IconGovernment, IconSettings, IconChartBar, AnyIcon,
  IconReceipt, IconCoin, IconAnchor, IconSearch, IconMail, IconMailUnread, IconBaseStation,
  IconUpload, IconDownload, IconLock, IconFileCertificate, IconWarning,
} from "./components/primitives/Icon";
import TrackedDocPreviewModal from "./components/shared/TrackedDocPreviewModal";
import EntityHistoryModal from "./components/shared/EntityHistoryModal";
import ChangePasswordModal from "./components/shared/ChangePasswordModal";
import { fmtCurr, _esc, _invShell, buildFreightInvoiceHtml, partyByRole } from "./utils/invoiceGenerator";

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
import MdmCountriesPage       from "./pages/mdm/MdmCountriesPage";
import MdmUNLocationCodesPage  from "./pages/mdm/MdmUNLocationCodesPage";
import MdmCommoditiesPage     from "./pages/mdm/MdmCommoditiesPage";
import MdmChargeCodesPage     from "./pages/mdm/MdmChargeCodesPage";
import MdmPackTypesPage       from "./pages/mdm/MdmPackTypesPage";
import MdmContainerTypesPage  from "./pages/mdm/MdmContainerTypesPage";
import MdmEquipmentPage       from "./pages/mdm/MdmEquipmentPage";
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
import CreditOverridesPage from "./pages/CreditOverridesPage";
import LicensePage             from "./pages/LicensePage";
import SchedulesPage           from "./pages/SchedulesPage";
import AiChatDrawer            from "./components/shared/AiChatDrawer";
import TrackingPage            from "./pages/TrackingPage";



// ─── Documents Modal ──────────────────────────────────────────────────────────

const DOC_TYPES = [
  { code: "BL01", label: "Bill of Lading" },
  { code: "MB01", label: "Master Bill of Lading" },
  { code: "CI01", label: "Commercial Invoice" },
  { code: "CI02", label: "Commercial Invoice (Amendment)" },
  { code: "FR01", label: "Freight Invoice" },
  { code: "FR02", label: "Freight Invoice (Amendment)" },
  { code: "CN01", label: "Credit / Debit Note" },
  { code: "PL01", label: "Packing List" },
  { code: "CO01", label: "Certificate of Origin" },
  { code: "CD01", label: "Customs Declaration" },
  { code: "AN01", label: "Arrival Notice" },
  { code: "DO01", label: "Delivery Order" },
  { code: "IC01", label: "Insurance Certificate" },
  { code: "DG01", label: "Dangerous Goods Declaration" },
  { code: "LP01", label: "Loading Plan" },
  { code: "UP01", label: "Unloading Plan" },
  { code: "PU01", label: "Pickup Plan" },
  { code: "DL01", label: "Delivery Plan" },
  { code: "OT",   label: "Other" },
];
const DOC_TYPE_MAP   = Object.fromEntries(DOC_TYPES.map(t => [t.code, t.label]));
const docTypeLabel   = code => DOC_TYPE_MAP[code] || code;

const FILE_ICON = mime => {
  if (!mime) return "📄";
  if (mime.startsWith("image/"))       return "🖼";
  if (mime === "application/pdf")      return "📑";
  if (mime.includes("spreadsheet") || mime.includes("excel")) return "📊";
  if (mime.includes("word") || mime.includes("document"))     return "📝";
  return "📄";
};

const fmtBytes = b => b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b/1024).toFixed(1)} KB` : `${(b/1024**2).toFixed(1)} MB`;
const fmtDate  = s => s ? new Date(s).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";

// ─── Invoice generation helpers ───────────────────────────────────────────────
// fmtCurr / _esc / INV_CSS / _invShell / buildFreightInvoiceHtml now live in
// src/utils/invoiceGenerator.js (shared with ShipmentAccountingInvoicesPage.jsx,
// which can't import them back from here without a circular dependency).

const fmtAddrHtml = c => {
  if (!c) return "";
  return [c.companyName, c.address1, c.address2, [c.city, c.state].filter(Boolean).join(", "), [c.postalCode, c.countryIso2].filter(Boolean).join(" ")].filter(Boolean).join("<br>");
};

const buildCommercialInvoiceHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, consignee }) => {
  // Structured cargo line items (Epic TKT-P3ASH1, Story TKT-LUNODU) — a container with
  // pack items (container.packages, only populated for CI01/CI02/PL01 by handlePreview)
  // renders one row per item with a real declared value; a container with none renders
  // exactly the same single row this document has always produced (regression-safe).
  let totalDeclaredUsd = 0, anyPriced = false;
  const containerRow = c => `<tr>
        <td><span class="code" style="font-size:11px">${c.containerNumber || "TBC"}</span></td>
        <td>${c.size}ft ${c.type}${c.isDg ? ` <span class="dg">DG ${c.dgClass}</span>` : ""}</td>
        <td class="num">${c.grossWeightKg != null ? Number(c.grossWeightKg).toLocaleString() + " kg" : "—"}</td>
        <td class="num">${c.volumeCbm != null ? Number(c.volumeCbm).toLocaleString() + " CBM" : "—"}</td>
        <td>${c.cargoDescription || "—"}</td>
        <td>${c.hsCode || "—"}</td>
        <td class="num">—</td>
      </tr>`;
  const packageRow = (c, p) => {
    const lineValue = p.unitValue != null ? p.quantity * p.unitValue : null;
    if (p.unitValueUsd != null) { totalDeclaredUsd += p.quantity * p.unitValueUsd; anyPriced = true; }
    return `<tr>
        <td><span class="code" style="font-size:11px">${c.containerNumber || "TBC"}</span></td>
        <td>${c.size}ft ${c.type}${p.isDg ? ` <span class="dg">DG ${_esc(p.dgClass)}</span>` : ""}</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td>${_esc(p.description)} × ${p.quantity}</td>
        <td>${_esc(p.hsCode || c.hsCode || "—")}</td>
        <td class="num">${lineValue != null ? fmtCurr(lineValue, p.currency || "USD") : "—"}</td>
      </tr>`;
  };
  const rows = containers.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:20px">No containers recorded</td></tr>`
    : containers.map(c => {
        const pkgs = c.packages || [];
        return pkgs.length > 0 ? pkgs.map(p => packageRow(c, p)).join("") : containerRow(c);
      }).join("");

  const detailItems = [
    ["Shipment ID", sh.id], ["B/L Number", sh.blNumber || "—"],
    ["Origin (POL)", `${sh.pol}${sh.polName ? " · " + sh.polName : ""}`],
    ["Destination (POD)", `${sh.pod}${sh.podName ? " · " + sh.podName : ""}`],
    ["Carrier", sh.carrierCode || "—"],
    ["Vessel / Voyage", [sh.vessel, sh.voyage].filter(Boolean).join(" / ") || "—"],
    ["Incoterm", sh.incoterm || "—"],
    ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
    ["ETA", sh.eta ? new Date(sh.eta).toLocaleDateString("en-GB") : "—"],
  ].map(([k, v]) => `<div><div class="detail-key">${k}</div><div class="detail-val">${v}</div></div>`).join("");

  const sellerAddr = fmtAddrHtml(shipper);
  const buyerAddr  = fmtAddrHtml(consignee);

  const body = `
    <div class="parties">
      <div class="party"><div class="party-label">Seller / Exporter</div>
        <div class="party-name">${sh.shipperName || shipper?.companyName || "—"}</div>
        ${sellerAddr ? `<div class="party-addr">${sellerAddr}</div>` : ""}
      </div>
      <div class="party"><div class="party-label">Buyer / Importer</div>
        <div class="party-name">${sh.consigneeName || consignee?.companyName || "—"}</div>
        ${buyerAddr ? `<div class="party-addr">${buyerAddr}</div>` : ""}
      </div>
    </div>
    <div class="shp-block"><div class="block-label">Shipment Details</div><div class="details-grid">${detailItems}</div></div>
    <div class="section-label">Goods Description</div>
    <table><thead><tr>
      <th>Container #</th><th>Type</th><th style="text-align:right">Weight</th>
      <th style="text-align:right">Volume</th><th>Description</th><th>HS Code</th>
      <th style="text-align:right">Declared Value</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div class="totals">
      <div class="total-row grand"><span class="total-label">Total Declared Value</span><span class="total-amt">${anyPriced ? fmtCurr(totalDeclaredUsd, "USD") : "As per attached"}</span></div>
    </div>
    ${notes ? `<div class="notes"><div class="notes-label">Notes</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Commercial Invoice — ${invNumber}`, "COMMERCIAL INVOICE", invNumber, invDate, body);
};

const _detailGrid = items => items.map(([k, v]) => `<div><div class="detail-key">${k}</div><div class="detail-val">${v}</div></div>`).join("");
const _ctrTotals = ctrs => {
  const w = ctrs.reduce((s, c) => s + (parseFloat(c.grossWeightKg) || 0), 0);
  const v = ctrs.reduce((s, c) => s + (parseFloat(c.volumeCbm) || 0), 0);
  return { w, v };
};

const buildBillOfLadingHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, consignee, parties, exportFilingItn }) => {
  const { w: totalWeight, v: totalVolume } = _ctrTotals(containers);
  // Additive party roles (Epic TKT-5XFCAP), same falls-back-to-today's-output pattern CD01/IC01
  // already use: an unassigned role renders nothing rather than a blank placeholder row.
  const alsoNotify = partyByRole(parties, "Also Notify Party");
  const preCarrier = partyByRole(parties, "Trucker (Pre-carriage)");
  const nvocc      = partyByRole(parties, "NVOCC");
  // Real legal significance, not paperwork trivia — see BL_RELEASE_TYPES' own comment in
  // tokens.js: an Original B/L needs a physical set surrendered before release, so a full set
  // is issued (3 is the standard trade-practice count); Telex/Surrendered already gave up the
  // original at origin, so zero travel with the goods; a Seaway Bill is never negotiable and
  // never issued as a physical original at all.
  const originalsLine = {
    "Original": "3 ORIGINALS", "Telex Release": "0 ORIGINALS — TELEX RELEASE",
    "Surrendered": "0 ORIGINALS — SURRENDERED AT ORIGIN",
    "Seaway Bill": "NOT NEGOTIABLE — NO ORIGINALS ISSUED (SEAWAY BILL)",
  }[sh.blReleaseType] || "—";
  const rows = containers.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:16px">No containers recorded</td></tr>`
    : containers.map(c => `<tr>
        <td><span class="code">${_esc(c.containerNumber || "TBC")}</span></td>
        <td>${_esc(c.sealNumber || "—")}</td>
        <td>${_esc(c.size)}ft ${_esc(c.type)}${c.isDg ? ` <span class="dg">DG ${_esc(c.dgClass)}</span>` : ""}</td>
        <td>${_esc(c.cargoDescription || "—")}</td>
        <td class="num">${c.grossWeightKg != null ? Number(c.grossWeightKg).toLocaleString() + " kg" : "—"}</td>
        <td class="num">${c.volumeCbm != null ? Number(c.volumeCbm) + " CBM" : "—"}</td>
        <td>${c.hsCode ? `<span class="code" style="font-size:11px">${_esc(c.hsCode)}</span>` : "—"}</td>
      </tr>`).join("");

  const body = `
    <div class="parties" style="grid-template-columns:${alsoNotify ? "1fr 1fr 1fr 1fr" : "1fr 1fr 1fr"}">
      <div class="party"><div class="party-label">Shipper / Exporter</div>
        <div class="party-name">${_esc(sh.shipperName || shipper?.companyName || "—")}</div>
        ${fmtAddrHtml(shipper) ? `<div class="party-addr">${fmtAddrHtml(shipper)}</div>` : ""}
      </div>
      <div class="party"><div class="party-label">Consignee</div>
        <div class="party-name">${_esc(sh.consigneeName || consignee?.companyName || "—")}</div>
        ${fmtAddrHtml(consignee) ? `<div class="party-addr">${fmtAddrHtml(consignee)}</div>` : ""}
      </div>
      <div class="party"><div class="party-label">Notify Party</div>
        <div class="party-name">${_esc(sh.notifyName || "—")}</div>
      </div>
      ${alsoNotify ? `<div class="party"><div class="party-label">Also Notify Party</div>
        <div class="party-name">${_esc(alsoNotify.customerName)}</div>
      </div>` : ""}
    </div>
    <div class="shp-block"><div class="block-label">Transport Details</div>
      <div class="details-grid">${_detailGrid([
        ["B/L Number", _esc(sh.blNumber || invNumber)], ["Release Type", _esc(sh.blReleaseType || "—")],
        ...(sh.masterBlNumber ? [["Master B/L Number", _esc(sh.masterBlNumber)]] : []),
        ...(nvocc ? [["NVOCC", _esc(nvocc.customerName)]] : []),
        // ITN (Internal Transaction Number, TKT-6A7J45 story 1) — only present once the
        // shipment's own AES/EEI export filing has actually been Accepted; additive, so a
        // shipment with no filing (or one still Draft/Filed/Rejected) renders byte-identical
        // to today. A carrier is legally required to have this before loading export cargo.
        ...(exportFilingItn ? [["Export Filing ITN", _esc(exportFilingItn)]] : []),
        ["No. of Originals", originalsLine], ["Booking Ref", _esc(sh.bookingRef || "—")],
        ...(preCarrier ? [["Pre-carriage By", _esc(preCarrier.customerName)]] : []),
        ["Place of Receipt", _esc(sh.placeOfReceipt || "—")],
        ["Vessel", _esc(sh.vessel || "—")], ["Voyage", _esc(sh.voyage || "—")],
        ["Port of Loading", `${_esc(sh.pol)}${sh.polName ? " · " + _esc(sh.polName) : ""}`],
        ["Port of Discharge", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
        ["Place of Delivery", _esc(sh.placeOfDelivery || "—")],
        ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
        ["ETA", sh.eta ? new Date(sh.eta).toLocaleDateString("en-GB") : "—"],
        ["Carrier", _esc(sh.carrierCode || "—")], ["Incoterm", _esc(sh.incoterm || "—")],
        ["Freight Terms", _esc(sh.freightTerms || "Prepaid")], ["Movement", _esc(sh.movementType || "FCL")],
        ["Declared Value", sh.declaredValue != null ? fmtCurr(sh.declaredValue, sh.declaredValueCurrency || "USD") : "—"],
      ])}</div>
    </div>
    <div class="section-label">Containers / Cargo</div>
    <table><thead><tr>
      <th>Container #</th><th>Seal #</th><th>Type</th><th>Cargo Description</th>
      <th style="text-align:right">Gross Weight</th><th style="text-align:right">Volume</th><th>HS Code</th>
    </tr></thead><tbody>${rows}</tbody>
    ${containers.length > 0 ? `<tfoot><tr>
      <td colspan="4" style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px">
        ${containers.length} container${containers.length > 1 ? "s" : ""} total
      </td>
      <td class="num" style="font-weight:700">${totalWeight > 0 ? totalWeight.toLocaleString() + " kg" : "—"}</td>
      <td class="num" style="font-weight:700">${totalVolume > 0 ? totalVolume.toFixed(2) + " CBM" : "—"}</td>
      <td></td>
    </tr></tfoot>` : ""}
    </table>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:11px;color:#374151;line-height:1.7">
      <strong>SHIPPED ON BOARD</strong> the above named vessel in apparent good order and condition,
      weight, measure, marks, numbers, quality, contents and value unknown. Freight and charges payable as indicated.
      In accepting this Bill of Lading, the shipper, consignee and holder agree to be bound by all stipulations,
      exceptions and conditions stated herein.
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px">
        <div class="party-label">Place and Date of Issue</div>
        <div style="font-size:12px;margin-top:4px">${_esc(sh.pol || "—")} / ${new Date(invDate + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}</div>
      </div>
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px">
        <div class="party-label">Signed for the Carrier</div>
        <div style="height:48px"></div>
        <div style="border-top:1px solid #d1d5db;padding-top:8px;font-size:11px;color:#6b7280">Authorised Signatory</div>
      </div>
    </div>
    ${notes ? `<div class="notes"><div class="notes-label">Notes / Special Instructions</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Bill of Lading — ${invNumber}`, "BILL OF LADING", invNumber, invDate, body);
};

// Master B/L — issued by the real vessel operator TO the NVOCC, a genuinely different document
// from the House B/L above (issued BY the NVOCC to the underlying shipper): different Shipper/
// Consignee, same physical movement (Epic TKT-Q52B38, Finding 05). Deliberately its own builder,
// not a mode flag on buildBillOfLadingHtml — the two documents' party resolution is different
// enough (NVOCC-as-shipper here vs. NVOCC-as-carrier-identity there) that branching one function
// would obscure more than it'd share. Consignee is rendered "TO ORDER OF {NVOCC}" — standard
// trade language for a non-negotiable master bill controlled by the NVOCC, not a fabricated
// party; Notify Party is left "—" since the NVOCC's own destination agent isn't modeled yet
// (see TKT-IB5IEX, logged backlog) and showing the House-side notify here would misattribute a
// party that has no role on this document.
const buildMasterBillOfLadingHtml = ({ shipment: sh, invNumber, invDate, notes, containers, parties, exportFilingItn }) => {
  const { w: totalWeight, v: totalVolume } = _ctrTotals(containers);
  const nvocc = partyByRole(parties, "NVOCC");
  const rows = containers.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:16px">No containers recorded</td></tr>`
    : containers.map(c => `<tr>
        <td><span class="code">${_esc(c.containerNumber || "TBC")}</span></td>
        <td>${_esc(c.sealNumber || "—")}</td>
        <td>${_esc(c.size)}ft ${_esc(c.type)}${c.isDg ? ` <span class="dg">DG ${_esc(c.dgClass)}</span>` : ""}</td>
        <td>${_esc(c.cargoDescription || "—")}</td>
        <td class="num">${c.grossWeightKg != null ? Number(c.grossWeightKg).toLocaleString() + " kg" : "—"}</td>
        <td class="num">${c.volumeCbm != null ? Number(c.volumeCbm) + " CBM" : "—"}</td>
        <td>${c.hsCode ? `<span class="code" style="font-size:11px">${_esc(c.hsCode)}</span>` : "—"}</td>
      </tr>`).join("");

  const body = `
    <div class="parties" style="grid-template-columns:1fr 1fr 1fr">
      <div class="party"><div class="party-label">Shipper (NVOCC)</div>
        <div class="party-name">${_esc(nvocc?.customerName || "—")}</div>
      </div>
      <div class="party"><div class="party-label">Consignee</div>
        <div class="party-name">${nvocc ? `TO ORDER OF ${_esc(nvocc.customerName)}` : "—"}</div>
      </div>
      <div class="party"><div class="party-label">Notify Party</div>
        <div class="party-name">—</div>
      </div>
    </div>
    <div class="shp-block"><div class="block-label">Transport Details</div>
      <div class="details-grid">${_detailGrid([
        ["Master B/L Number", _esc(sh.masterBlNumber || invNumber)],
        ["House B/L Number", _esc(sh.blNumber || "—")],
        ["Booking Ref", _esc(sh.bookingRef || "—")],
        // Same additive ITN row as the House B/L — see that builder's own comment.
        ...(exportFilingItn ? [["Export Filing ITN", _esc(exportFilingItn)]] : []),
        ["Vessel", _esc(sh.vessel || "—")], ["Voyage", _esc(sh.voyage || "—")],
        ["Port of Loading", `${_esc(sh.pol)}${sh.polName ? " · " + _esc(sh.polName) : ""}`],
        ["Port of Discharge", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
        ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
        ["ETA", sh.eta ? new Date(sh.eta).toLocaleDateString("en-GB") : "—"],
        ["Carrier", _esc(sh.carrierCode || "—")],
        ["Movement", _esc(sh.movementType || "FCL")],
      ])}</div>
    </div>
    <div class="section-label">Containers / Cargo</div>
    <table><thead><tr>
      <th>Container #</th><th>Seal #</th><th>Type</th><th>Cargo Description</th>
      <th style="text-align:right">Gross Weight</th><th style="text-align:right">Volume</th><th>HS Code</th>
    </tr></thead><tbody>${rows}</tbody>
    ${containers.length > 0 ? `<tfoot><tr>
      <td colspan="4" style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px">
        ${containers.length} container${containers.length > 1 ? "s" : ""} total
      </td>
      <td class="num" style="font-weight:700">${totalWeight > 0 ? totalWeight.toLocaleString() + " kg" : "—"}</td>
      <td class="num" style="font-weight:700">${totalVolume > 0 ? totalVolume.toFixed(2) + " CBM" : "—"}</td>
      <td></td>
    </tr></tfoot>` : ""}
    </table>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:11px;color:#374151;line-height:1.7">
      <strong>SHIPPED ON BOARD</strong> the above named vessel in apparent good order and condition,
      weight, measure, marks, numbers, quality, contents and value unknown. Freight and charges payable as indicated.
      In accepting this Bill of Lading, the shipper, consignee and holder agree to be bound by all stipulations,
      exceptions and conditions stated herein.
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px">
        <div class="party-label">Place and Date of Issue</div>
        <div style="font-size:12px;margin-top:4px">${_esc(sh.pol || "—")} / ${new Date(invDate + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}</div>
      </div>
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px">
        <div class="party-label">Signed for the Carrier</div>
        <div style="height:48px"></div>
        <div style="border-top:1px solid #d1d5db;padding-top:8px;font-size:11px;color:#6b7280">Authorised Signatory</div>
      </div>
    </div>
    ${notes ? `<div class="notes"><div class="notes-label">Notes / Special Instructions</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Master Bill of Lading — ${invNumber}`, "MASTER BILL OF LADING", invNumber, invDate, body);
};

const buildPackingListHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, consignee }) => {
  const { w: totalWeight, v: totalVolume } = _ctrTotals(containers);
  // Structured cargo line items (Epic TKT-P3ASH1, Story TKT-LUNODU) — same fallback shape
  // as buildCommercialInvoiceHtml: a container with pack items gets one row per item, a
  // container with none renders exactly today's single row (regression-safe). No value
  // column here — not part of this story for the Packing List.
  const containerRow = c => `<tr>
        <td><span class="code">${_esc(c.containerNumber || "TBC")}</span></td>
        <td>${_esc(c.size)}ft ${_esc(c.type)}</td>
        <td>${_esc(c.cargoDescription || "—")}</td>
        <td>${c.hsCode ? `<span class="code" style="font-size:11px">${_esc(c.hsCode)}</span>` : "—"}</td>
        <td class="num">${c.grossWeightKg != null ? Number(c.grossWeightKg).toLocaleString() + " kg" : "—"}</td>
        <td class="num">${c.volumeCbm != null ? Number(c.volumeCbm) + " CBM" : "—"}</td>
        <td>${c.isDg ? `<span class="dg">DG ${_esc(c.dgClass)}</span>` : "—"}</td>
      </tr>`;
  const packageRow = (c, p) => `<tr>
        <td><span class="code">${_esc(c.containerNumber || "TBC")}</span></td>
        <td>${_esc(c.size)}ft ${_esc(c.type)}</td>
        <td>${_esc(p.description)} × ${p.quantity}</td>
        <td>${(p.hsCode || c.hsCode) ? `<span class="code" style="font-size:11px">${_esc(p.hsCode || c.hsCode)}</span>` : "—"}</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td>${p.isDg ? `<span class="dg">DG ${_esc(p.dgClass)}</span>` : "—"}</td>
      </tr>`;
  const rows = containers.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:16px">No containers recorded</td></tr>`
    : containers.map(c => {
        const pkgs = c.packages || [];
        return pkgs.length > 0 ? pkgs.map(p => packageRow(c, p)).join("") : containerRow(c);
      }).join("");

  const body = `
    <div class="parties">
      <div class="party"><div class="party-label">Shipper / Exporter</div>
        <div class="party-name">${_esc(sh.shipperName || shipper?.companyName || "—")}</div>
        ${fmtAddrHtml(shipper) ? `<div class="party-addr">${fmtAddrHtml(shipper)}</div>` : ""}
      </div>
      <div class="party"><div class="party-label">Consignee</div>
        <div class="party-name">${_esc(sh.consigneeName || consignee?.companyName || "—")}</div>
        ${fmtAddrHtml(consignee) ? `<div class="party-addr">${fmtAddrHtml(consignee)}</div>` : ""}
      </div>
    </div>
    <div class="shp-block"><div class="block-label">Shipment Reference</div>
      <div class="details-grid">${_detailGrid([
        ["Shipment ID", sh.id], ["B/L Number", _esc(sh.blNumber || "—")], ["Booking Ref", _esc(sh.bookingRef || "—")],
        ["Origin (POL)", `${_esc(sh.pol)}${sh.polName ? " · " + _esc(sh.polName) : ""}`],
        ["Destination (POD)", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
        ["Carrier", _esc(sh.carrierCode || "—")],
        ["Vessel / Voyage", [sh.vessel, sh.voyage].filter(Boolean).map(_esc).join(" / ") || "—"],
        ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
        ["ETA", sh.eta ? new Date(sh.eta).toLocaleDateString("en-GB") : "—"],
      ])}</div>
    </div>
    <div class="section-label">Packing Details</div>
    <table><thead><tr>
      <th>Container #</th><th>Type</th><th>Cargo Description</th><th>HS Code</th>
      <th style="text-align:right">Gross Weight</th><th style="text-align:right">Volume</th><th>DG</th>
    </tr></thead><tbody>${rows}</tbody>
    ${containers.length > 0 ? `<tfoot><tr>
      <td colspan="4" style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px">
        Total — ${containers.length} container${containers.length > 1 ? "s" : ""}
      </td>
      <td class="num" style="font-weight:700">${totalWeight > 0 ? totalWeight.toLocaleString() + " kg" : "—"}</td>
      <td class="num" style="font-weight:700">${totalVolume > 0 ? totalVolume.toFixed(2) + " CBM" : "—"}</td>
      <td></td>
    </tr></tfoot>` : ""}
    </table>
    ${notes ? `<div class="notes"><div class="notes-label">Notes</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Packing List — ${invNumber}`, "PACKING LIST", invNumber, invDate, body);
};

const buildCertOriginHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, consignee }) => {
  const rows = containers.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:16px">No cargo details</td></tr>`
    : containers.map(c => `<tr>
        <td>${_esc(c.cargoDescription || "—")}</td>
        <td>${c.hsCode ? `<span class="code" style="font-size:11px">${_esc(c.hsCode)}</span>` : "—"}</td>
        <td class="num">${c.grossWeightKg != null ? Number(c.grossWeightKg).toLocaleString() + " kg" : "—"}</td>
        <td>Country of Origin</td>
      </tr>`).join("");

  const body = `
    <div class="parties">
      <div class="party"><div class="party-label">Exporter / Producer</div>
        <div class="party-name">${_esc(sh.shipperName || shipper?.companyName || "—")}</div>
        ${fmtAddrHtml(shipper) ? `<div class="party-addr">${fmtAddrHtml(shipper)}</div>` : ""}
      </div>
      <div class="party"><div class="party-label">Consignee / Importer</div>
        <div class="party-name">${_esc(sh.consigneeName || consignee?.companyName || "—")}</div>
        ${fmtAddrHtml(consignee) ? `<div class="party-addr">${fmtAddrHtml(consignee)}</div>` : ""}
      </div>
    </div>
    <div class="shp-block"><div class="block-label">Transport</div>
      <div class="details-grid">${_detailGrid([
        ["Vessel / Voyage", [sh.vessel, sh.voyage].filter(Boolean).map(_esc).join(" / ") || "—"],
        ["Port of Loading", `${_esc(sh.pol)}${sh.polName ? " · " + _esc(sh.polName) : ""}`],
        ["Port of Discharge", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
        ["Carrier", _esc(sh.carrierCode || "—")], ["B/L Number", _esc(sh.blNumber || "—")],
        ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
      ])}</div>
    </div>
    <div class="section-label">Goods Description</div>
    <table><thead><tr>
      <th>Description of Goods</th><th>HS Code</th><th style="text-align:right">Gross Weight</th><th>Country of Origin</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:11px;color:#374151;line-height:1.7">
      The undersigned hereby declares that the above details and statements are correct, that all the goods were produced
      in the country shown and comply with the applicable origin requirements.
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px">
        <div class="party-label">Certifying Authority — Stamp / Signature</div>
        <div style="height:56px"></div>
      </div>
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px">
        <div class="party-label">Declaration by Exporter</div>
        <div style="height:40px"></div>
        <div style="border-top:1px solid #d1d5db;padding-top:8px;font-size:11px;color:#6b7280">
          Place / Date: ${_esc(sh.pol || "—")} / ${new Date(invDate + "T00:00:00").toLocaleDateString("en-GB")}
        </div>
      </div>
    </div>
    ${notes ? `<div class="notes"><div class="notes-label">Notes</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Certificate of Origin — ${invNumber}`, "CERTIFICATE OF ORIGIN", invNumber, invDate, body);
};

const buildInsuranceCertHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, parties }) => {
  const { w: totalWeight } = _ctrTotals(containers);
  const descriptions = [...new Set(containers.map(c => c.cargoDescription).filter(Boolean))].join("; ") || "As described in Bill of Lading";
  // Insurance Provider (Epic TKT-5XFCAP) preferred over the Shipper fallback when assigned —
  // additive: a shipment with none assigned falls back to today's exact behavior.
  const insuranceProvider = partyByRole(parties, "Insurance Provider");

  const body = `
    <div class="shp-block"><div class="block-label">Assured</div>
      <div class="details-grid" style="grid-template-columns:repeat(2,1fr)">${_detailGrid([
        ["Assured / Insured Party", _esc(insuranceProvider?.customerName || sh.shipperName || shipper?.companyName || "—")],
        ["Certificate Reference", _esc(invNumber)],
      ])}</div>
    </div>
    <div class="shp-block"><div class="block-label">Shipment Details</div>
      <div class="details-grid">${_detailGrid([
        ["Shipment ID", sh.id], ["B/L Number", _esc(sh.blNumber || "—")],
        ["Origin (POL)", `${_esc(sh.pol)}${sh.polName ? " · " + _esc(sh.polName) : ""}`],
        ["Destination (POD)", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
        ["Vessel / Voyage", [sh.vessel, sh.voyage].filter(Boolean).map(_esc).join(" / ") || "—"],
        ["Carrier", _esc(sh.carrierCode || "—")],
        ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
        ["ETA", sh.eta ? new Date(sh.eta).toLocaleDateString("en-GB") : "—"],
        ["Incoterm", _esc(sh.incoterm || "—")],
      ])}</div>
    </div>
    <div class="shp-block"><div class="block-label">Coverage</div>
      <div class="details-grid">${_detailGrid([
        ["Cargo Description", _esc(descriptions)],
        ["Total Gross Weight", totalWeight > 0 ? totalWeight.toLocaleString() + " kg" : "As per B/L"],
        ["No. of Containers", containers.length > 0 ? `${containers.length} × FCL` : "—"],
        ["Coverage Type", "All Risks (Institute Cargo Clauses A)"],
        ["Sum Insured / Declared Value", sh.declaredValue != null ? fmtCurr(sh.declaredValue, sh.declaredValueCurrency || "USD") : "As declared — contact insurer"],
        ["Policy / Cover Note", "To be confirmed"],
      ])}</div>
    </div>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:11px;color:#374151;line-height:1.7">
      This is to certify that the above-described shipment has been insured under the terms and conditions of the Open Policy /
      Cover Note as referenced. Claims, if any, are payable in the currency and country stipulated in the policy,
      upon surrender of this certificate duly endorsed.
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px">
        <div class="party-label">Authorised by Insurer — Signature / Stamp</div>
        <div style="height:56px"></div>
      </div>
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px">
        <div class="party-label">Date of Issue</div>
        <div style="font-size:12px;margin-top:6px">${new Date(invDate + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}</div>
      </div>
    </div>
    ${notes ? `<div class="notes"><div class="notes-label">Notes</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Insurance Certificate — ${invNumber}`, "INSURANCE CERTIFICATE", invNumber, invDate, body);
};

const buildDGDeclHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, consignee, dgCompliance }) => {
  const dgCtrs = containers.filter(c => c.isDg);
  const rows = dgCtrs.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#dc2626;padding:16px;font-weight:600">No containers flagged as DG — verify cargo details</td></tr>`
    : dgCtrs.map(c => `<tr>
        <td><span class="code">${_esc(c.containerNumber || "TBC")}</span></td>
        <td><span class="dg">DG ${_esc(c.dgClass)}</span></td>
        <td>—</td><td>As per SDS</td><td>—</td>
        <td class="num">${c.grossWeightKg != null ? Number(c.grossWeightKg).toLocaleString() + " kg" : "—"}</td>
        <td>${_esc(c.cargoDescription || "—")}</td>
      </tr>`).join("");

  const body = `
    <div style="background:#fef2f2;border:2px solid #dc2626;border-radius:8px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;gap:12px">
      <span style="font-size:22px">⚠</span>
      <div>
        <div style="font-size:12px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:.5px">Dangerous Goods Declaration — IMDG Code</div>
        <div style="font-size:11px;color:#7f1d1d;margin-top:2px">International Maritime Dangerous Goods</div>
      </div>
    </div>
    <div class="parties">
      <div class="party"><div class="party-label">Shipper / Consignor</div>
        <div class="party-name">${_esc(sh.shipperName || shipper?.companyName || "—")}</div>
        ${fmtAddrHtml(shipper) ? `<div class="party-addr">${fmtAddrHtml(shipper)}</div>` : ""}
      </div>
      <div class="party"><div class="party-label">Consignee</div>
        <div class="party-name">${_esc(sh.consigneeName || consignee?.companyName || "—")}</div>
        ${fmtAddrHtml(consignee) ? `<div class="party-addr">${fmtAddrHtml(consignee)}</div>` : ""}
      </div>
    </div>
    <div class="shp-block"><div class="block-label">Transport Details</div>
      <div class="details-grid">${_detailGrid([
        ["Vessel / Voyage", [sh.vessel, sh.voyage].filter(Boolean).map(_esc).join(" / ") || "—"],
        ["Port of Loading", `${_esc(sh.pol)}${sh.polName ? " · " + _esc(sh.polName) : ""}`],
        ["Port of Discharge", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
        ["Carrier", _esc(sh.carrierCode || "—")], ["B/L Number", _esc(sh.blNumber || "—")],
        ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
      ])}</div>
    </div>
    <div class="section-label">Dangerous Goods Details</div>
    <table><thead><tr>
      <th>Container #</th><th>DG Class</th><th>UN Number</th><th>Proper Shipping Name</th>
      <th>Packing Group</th><th style="text-align:right">Net Weight</th><th>Description</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:11px;color:#374151;line-height:1.7">
      I hereby declare that the contents of this consignment are fully and accurately described above by the proper shipping name,
      and are classified, packaged, marked and labelled/placarded, and are in all respects in proper condition for transport
      according to applicable international and national governmental regulations.
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px">
        <div class="party-label">Shipper's Declaration — Name / Signature / Date</div>
        <div style="height:40px"></div>
        <div style="border-top:1px solid #d1d5db;padding-top:8px;font-size:11px;color:#6b7280">
          Date: ${new Date(invDate + "T00:00:00").toLocaleDateString("en-GB")}
        </div>
      </div>
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px">
        <div class="party-label">Emergency Contact</div>
        <div style="font-size:11px;color:#374151;margin-top:6px;line-height:1.8">
          ${dgCompliance && (dgCompliance.contactName || dgCompliance.phone || dgCompliance.email || dgCompliance.address)
            ? [
                dgCompliance.contactName && _esc(dgCompliance.contactName),
                dgCompliance.phone       && `Phone: ${_esc(dgCompliance.phone)}`,
                dgCompliance.email       && `Email: ${_esc(dgCompliance.email)}`,
                dgCompliance.address     && _esc(dgCompliance.address),
              ].filter(Boolean).join("<br>")
            : `24hr Emergency: ___________<br>CHEMTREC: +1 703-527-3887<br>CANUTEC: +1 613-996-6666`}
        </div>
      </div>
    </div>
    ${notes ? `<div class="notes"><div class="notes-label">Special Instructions</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`DG Declaration — ${invNumber}`, "DANGEROUS GOODS DECLARATION", invNumber, invDate, body);
};

const buildCustomsDeclHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, consignee, parties }) => {
  // Customs Broker (Export)/(Import) (Epic TKT-5XFCAP) — additive detail rows, only rendered
  // when that role is assigned; falls back to today's exact output when neither is.
  const brokerExport = partyByRole(parties, "Customs Broker (Export)");
  const brokerImport = partyByRole(parties, "Customs Broker (Import)");
  const rows = containers.length === 0
    ? `<tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:16px">No containers recorded</td></tr>`
    : containers.map(c => `<tr>
        <td><span class="code">${_esc(c.containerNumber || "TBC")}</span></td>
        <td>${c.hsCode ? `<span class="code" style="font-size:11px">${_esc(c.hsCode)}</span>` : "—"}</td>
        <td>${_esc(c.cargoDescription || "—")}</td>
        <td class="num">${c.grossWeightKg != null ? Number(c.grossWeightKg).toLocaleString() + " kg" : "—"}</td>
        <td class="num">—</td><td>—</td>
      </tr>`).join("");

  const body = `
    <div class="parties">
      <div class="party"><div class="party-label">Declarant / Exporter</div>
        <div class="party-name">${_esc(sh.shipperName || shipper?.companyName || "—")}</div>
        ${fmtAddrHtml(shipper) ? `<div class="party-addr">${fmtAddrHtml(shipper)}</div>` : ""}
      </div>
      <div class="party"><div class="party-label">Importer / Consignee</div>
        <div class="party-name">${_esc(sh.consigneeName || consignee?.companyName || "—")}</div>
        ${fmtAddrHtml(consignee) ? `<div class="party-addr">${fmtAddrHtml(consignee)}</div>` : ""}
      </div>
    </div>
    <div class="shp-block"><div class="block-label">Shipment Reference</div>
      <div class="details-grid">${_detailGrid([
        ["Declaration Ref", _esc(invNumber)], ["B/L Number", _esc(sh.blNumber || "—")],
        ["Origin (POL)", `${_esc(sh.pol)}${sh.polName ? " · " + _esc(sh.polName) : ""}`],
        ["Destination (POD)", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
        ["Carrier", _esc(sh.carrierCode || "—")],
        ["Vessel / Voyage", [sh.vessel, sh.voyage].filter(Boolean).map(_esc).join(" / ") || "—"],
        ["Incoterm", _esc(sh.incoterm || "—")],
        ["Declared Value", sh.declaredValue != null ? fmtCurr(sh.declaredValue, sh.declaredValueCurrency || "USD") : "—"],
        ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
        ["ETA", sh.eta ? new Date(sh.eta).toLocaleDateString("en-GB") : "—"],
        ...(brokerExport ? [["Customs Broker (Export)", _esc(brokerExport.customerName)]] : []),
        ...(brokerImport ? [["Customs Broker (Import)", _esc(brokerImport.customerName)]] : []),
      ])}</div>
    </div>
    <div class="section-label">Goods Declaration</div>
    <table><thead><tr>
      <th>Container #</th><th>HS Code</th><th>Description of Goods</th>
      <th style="text-align:right">Gross Weight</th><th style="text-align:right">Declared Value</th><th>Country of Origin</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:11px;color:#374151;line-height:1.7">
      I hereby declare that the information provided is complete, true and correct. Any false declaration may result in
      seizure of goods and/or legal action. Place/Date of declaration: ${_esc(sh.pod || "—")} / ${new Date(invDate + "T00:00:00").toLocaleDateString("en-GB")}
    </div>
    ${notes ? `<div class="notes"><div class="notes-label">Notes</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Customs Declaration — ${invNumber}`, "CUSTOMS DECLARATION", invNumber, invDate, body);
};

// Carrier/forwarder -> notify party: "your container arrives on X, free time starts" — one of
// the highest-frequency documents on any import file, previously only reachable via the
// free-text "Other" doc type with none of the right fields auto-populated (TKT-Q13HBD).
const buildArrivalNoticeHtml = ({ shipment: sh, invNumber, invDate, notes, containers, consignee, parties }) => {
  const alsoNotify = partyByRole(parties, "Also Notify Party");
  const eta = sh.eta ? new Date(sh.eta) : null;
  // Estimated, not authoritative — the real deadline is whatever the container compliance
  // badges compute once Discharged is actually logged (container_events); this is a heads-up
  // for the notify party ahead of that, so every value it's built from is explicitly an estimate.
  const lastFreeDay = (eta && containers.length > 0 && containers[0].destFreeTimeDays != null)
    ? new Date(eta.getTime() + containers[0].destFreeTimeDays * 86400000)
    : null;
  const rows = containers.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:16px">No containers recorded</td></tr>`
    : containers.map(c => `<tr>
        <td><span class="code">${_esc(c.containerNumber || "TBC")}</span></td>
        <td>${_esc(c.size)}ft ${_esc(c.type)}</td>
        <td>${_esc(c.sealNumber || "—")}</td>
        <td class="num">${c.grossWeightKg != null ? Number(c.grossWeightKg).toLocaleString() + " kg" : "—"}</td>
      </tr>`).join("");

  const body = `
    <div class="shp-block"><div class="block-label">Notify</div>
      <div class="details-grid" style="grid-template-columns:repeat(2,1fr)">${_detailGrid([
        ["Notify Party", _esc(sh.notifyName || "—")],
        ...(alsoNotify ? [["Also Notify Party", _esc(alsoNotify.customerName)]] : []),
        ["Consignee", _esc(sh.consigneeName || consignee?.companyName || "—")],
      ])}</div>
    </div>
    <div class="shp-block"><div class="block-label">Arrival Details</div>
      <div class="details-grid">${_detailGrid([
        ["B/L Number", _esc(sh.blNumber || "—")], ["Booking Ref", _esc(sh.bookingRef || "—")],
        ["Vessel", _esc(sh.vessel || "—")], ["Voyage", _esc(sh.voyage || "—")],
        ["Carrier", _esc(sh.carrierCode || "—")],
        ["Port of Discharge", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
        ["ETA", eta ? eta.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }) : "—"],
        ["Est. Last Free Day", lastFreeDay ? lastFreeDay.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }) : "To be confirmed on discharge"],
      ])}</div>
    </div>
    <div class="section-label">Containers</div>
    <table><thead><tr>
      <th>Container #</th><th>Type</th><th>Seal #</th><th style="text-align:right">Gross Weight</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:11px;color:#374151;line-height:1.7">
      This shipment is expected to arrive as shown above. Demurrage and detention free time begins upon
      discharge — the Last Free Day above is an estimate; the confirmed deadline is issued once discharge
      is logged. Please arrange customs clearance and cargo release in good time.
    </div>
    ${notes ? `<div class="notes"><div class="notes-label">Notes</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Arrival Notice — ${invNumber}`, "ARRIVAL NOTICE", invNumber, invDate, body);
};

// Cargo-release authorization to the destination trucker once the B/L is surrendered — the
// other routine, high-frequency import document with no dedicated type before this (TKT-V5KU48).
const buildDeliveryOrderHtml = ({ shipment: sh, invNumber, invDate, notes, containers, consignee, parties }) => {
  const trucker = partyByRole(parties, "Trucker (On-carriage)");
  const releasable = ["Telex Release", "Surrendered", "Seaway Bill"].includes(sh.blReleaseType);
  const rows = containers.length === 0
    ? `<tr><td colspan="3" style="text-align:center;color:#9ca3af;padding:16px">No containers recorded</td></tr>`
    : containers.map(c => `<tr>
        <td><span class="code">${_esc(c.containerNumber || "TBC")}</span></td>
        <td>${_esc(c.size)}ft ${_esc(c.type)}</td>
        <td>${_esc(c.sealNumber || "—")}</td>
      </tr>`).join("");

  const body = `
    <div class="shp-block"><div class="block-label">Deliver To</div>
      <div class="details-grid" style="grid-template-columns:repeat(2,1fr)">${_detailGrid([
        ["Consignee", _esc(sh.consigneeName || consignee?.companyName || "—")],
        ...(trucker ? [["Trucker (On-carriage)", _esc(trucker.customerName)]] : []),
      ])}</div>
    </div>
    <div class="shp-block"><div class="block-label">Release Status</div>
      <div class="details-grid" style="grid-template-columns:repeat(2,1fr)">${_detailGrid([
        ["B/L Number", _esc(sh.blNumber || "—")],
        ["Release Type", _esc(sh.blReleaseType || "Not yet decided")],
      ])}</div>
      <div style="margin-top:12px;padding:10px 14px;border-radius:8px;font-size:12px;font-weight:600;
        background:${releasable ? "#f0fdf4" : "#fef2f2"};color:${releasable ? "#166534" : "#991b1b"};
        border:1px solid ${releasable ? "#bbf7d0" : "#fecaca"}">
        ${releasable
          ? `Cargo may be released — ${_esc(sh.blReleaseType)}, no original B/L presentation required.`
          : "Cargo may NOT be released until an Original B/L is surrendered (or the release type above is confirmed)."}
      </div>
    </div>
    <div class="section-label">Containers</div>
    <table><thead><tr>
      <th>Container #</th><th>Type</th><th>Seal #</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:11px;color:#374151;line-height:1.7">
      This Delivery Order authorises release of the above cargo to the named consignee (or their appointed
      agent/trucker) upon presentation of valid identification and satisfaction of all outstanding charges.
    </div>
    ${notes ? `<div class="notes"><div class="notes-label">Notes</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Delivery Order — ${invNumber}`, "DELIVERY ORDER", invNumber, invDate, body);
};

const buildGenericDocHtml = ({ shipment: sh, invNumber, invDate, notes }) => {
  const body = `
    <div class="shp-block"><div class="block-label">Shipment Details</div>
      <div class="details-grid">${_detailGrid([
        ["Shipment ID", sh.id], ["B/L Number", _esc(sh.blNumber || "—")], ["Booking Ref", _esc(sh.bookingRef || "—")],
        ["Origin (POL)", `${_esc(sh.pol)}${sh.polName ? " · " + _esc(sh.polName) : ""}`],
        ["Destination (POD)", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
        ["Carrier", _esc(sh.carrierCode || "—")],
        ["Vessel / Voyage", [sh.vessel, sh.voyage].filter(Boolean).map(_esc).join(" / ") || "—"],
        ["Shipper", _esc(sh.shipperName || "—")], ["Consignee", _esc(sh.consigneeName || "—")],
        ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
        ["ETA", sh.eta ? new Date(sh.eta).toLocaleDateString("en-GB") : "—"],
        ["Incoterm", _esc(sh.incoterm || "—")],
      ])}</div>
    </div>
    ${notes
      ? `<div class="notes"><div class="notes-label">Notes / Content</div><div class="notes-text">${_esc(notes)}</div></div>`
      : `<div style="background:#f9fafb;border:2px dashed #d1d5db;border-radius:8px;padding:40px;text-align:center;color:#9ca3af;font-size:12px">Add content in the Notes field when generating this document</div>`}`;

  return _invShell(`Document — ${invNumber}`, "DOCUMENT", invNumber, invDate, body);
};

// Blocks generation when data a real document of this type genuinely can't be issued without
// is missing, and names every gap at once rather than making the user click Generate repeatedly
// to discover them one at a time. Deliberately excludes LP01/UP01/PU01/DL01/OT/CN01 — those are
// either free-text, backed by a dedicated page with its own validation (LoadingServicePage.jsx),
// or (per dispatchDocBuilder's own comment above) intentionally allowed to render a
// blank-template fallback from this generic modal.
const getMissingDocRequirements = (docCode, { shipment: sh, containers, shipper, consignee, costLines, dgCompliance, parties }) => {
  const missing = [];
  const hasShipper   = !!(sh.shipperName || shipper?.companyName);
  const hasConsignee = !!(sh.consigneeName || consignee?.companyName);
  if (["BL01", "CI01", "CI02", "PL01", "CO01", "CD01", "DG01"].includes(docCode)) {
    if (!hasShipper) missing.push("Shipper");
    if (!hasConsignee) missing.push("Consignee");
  }
  if (["BL01", "CI01", "CI02", "PL01", "CO01", "CD01"].includes(docCode) && containers.length === 0) {
    missing.push("At least one container");
  }
  if (["BL01", "CI01", "CI02", "PL01"].includes(docCode)) {
    if (!sh.pol) missing.push("Port of Loading");
    if (!sh.pod) missing.push("Port of Discharge");
  }
  if (docCode === "MB01") {
    if (!partyByRole(parties, "NVOCC")?.customerName) missing.push("NVOCC (assign one on Parties & Offices)");
    if (!sh.masterBlNumber) missing.push("Master B/L Number (set on the Conditions page)");
    if (containers.length === 0) missing.push("At least one container");
    if (!sh.pol) missing.push("Port of Loading");
    if (!sh.pod) missing.push("Port of Discharge");
  }
  if (["AN01", "DO01"].includes(docCode)) {
    if (!hasConsignee) missing.push("Consignee");
    if (!sh.pod) missing.push("Port of Discharge");
    if (containers.length === 0) missing.push("At least one container");
  }
  if (docCode === "CD01" && containers.length > 0) {
    const noHs = containers.filter(c => !c.hsCode).length;
    if (noHs > 0) missing.push(`HS Code (missing on ${noHs} of ${containers.length} container${containers.length > 1 ? "s" : ""})`);
  }
  if (docCode === "IC01") {
    const insuranceProvider = partyByRole(parties, "Insurance Provider");
    if (!insuranceProvider?.customerName && !hasShipper) missing.push("Assured Party (Shipper or an assigned Insurance Provider)");
  }
  if (docCode === "DG01") {
    if (containers.filter(c => c.isDg).length === 0) missing.push("At least one container flagged as Dangerous Goods");
    if (!dgCompliance?.contactName && !dgCompliance?.phone && !dgCompliance?.email) {
      missing.push("DG Compliance Contact (Application Settings → Compliance)");
    }
  }
  if ((docCode === "FR01" || docCode === "FR02") && costLines.length === 0) {
    missing.push("At least one valid SELL charge line");
  }
  return missing;
};

const dispatchDocBuilder = (code, data) => {
  switch (code) {
    case "BL01":             return buildBillOfLadingHtml(data);
    case "MB01":             return buildMasterBillOfLadingHtml(data);
    case "CI01": case "CI02": return buildCommercialInvoiceHtml(data);
    case "FR01": case "FR02": return buildFreightInvoiceHtml(data);
    case "PL01":             return buildPackingListHtml(data);
    case "CO01":             return buildCertOriginHtml(data);
    case "IC01":             return buildInsuranceCertHtml(data);
    case "DG01":             return buildDGDeclHtml(data);
    case "CD01":             return buildCustomsDeclHtml(data);
    case "AN01":             return buildArrivalNoticeHtml(data);
    case "DO01":             return buildDeliveryOrderHtml(data);
    // No loadingPlanLines from the generic picker (it has no concept of "service") —
    // buildLoadingPlanHtml still renders a sensible template with blank planned dates;
    // the rich version comes from the dedicated Loading/Unloading Service page
    // (LoadingServicePage.jsx), which fetches and passes the real per-container lines.
    case "LP01":             return buildLoadingPlanHtml(data);
    case "UP01":             return buildLoadingPlanHtml({ ...data, planLabel: "Unloading Plan" });
    case "PU01":             return buildLoadingPlanHtml({ ...data, planLabel: "Pickup Plan" });
    case "DL01":             return buildLoadingPlanHtml({ ...data, planLabel: "Delivery Plan" });
    default:                 return buildGenericDocHtml(data);
  }
};

const GenerateDocumentModal = ({ shipment, onClose, onSaved, defaultCode }) => {
  const defaultNum = `${shipment.id}-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const [docCode,  setDocCode]  = useState(defaultCode || DOC_TYPES[0].code);
  const [docNum,   setDocNum]   = useState(defaultNum);
  const [docDate,  setDocDate]  = useState(new Date().toISOString().slice(0, 10));
  const [notes,    setNotes]    = useState("");
  const [loading,  setLoading]  = useState(false);

  const handlePreview = async () => {
    setLoading(true);
    try {
      const needsCostLines = docCode === "FR01" || docCode === "FR02";
      const needsDgSettings = docCode === "DG01";
      // ITN (TKT-6A7J45 story 1) — only House/Master B/L carry it, no reason to fetch
      // customs filings for every other document type.
      const needsExportFiling = docCode === "BL01" || docCode === "MB01";
      const [ctrsRaw, shipper, consignee, costLines, orgSettings, parties, filings] = await Promise.all([
        api.containers.list(),
        shipment.shipperId   ? api.customers.get(shipment.shipperId).catch(() => null)   : Promise.resolve(null),
        shipment.consigneeId ? api.customers.get(shipment.consigneeId).catch(() => null) : Promise.resolve(null),
        needsCostLines ? api.costLines.list(shipment.id).then(ls => ls.filter(l => l.type === "SELL")) : Promise.resolve([]),
        needsDgSettings ? api.settings.get().catch(() => null) : Promise.resolve(null),
        api.shipmentParties.list(shipment.id).catch(() => []),
        needsExportFiling ? api.customsFilings.list(shipment.id).catch(() => []) : Promise.resolve([]),
      ]);
      const exportFilingItn = filings.find(f => f.filingType === "AES_EEI" && f.status === "Accepted")?.confirmationNumber || null;
      const allCtrs         = Array.isArray(ctrsRaw) ? ctrsRaw : (ctrsRaw?.results ?? []);
      const containersBase  = allCtrs.filter(c => c.shipmentId === shipment.id);
      // Structured cargo line items (Epic TKT-P3ASH1, Story TKT-LUNODU) — only CI01/CI02/PL01
      // render per-pack-item rows; every other doc type is left untouched (no extra requests)
      // since container_packages has no bulk "packages for a whole shipment" endpoint.
      const needsPackages = docCode === "CI01" || docCode === "CI02" || docCode === "PL01";
      const containers = needsPackages
        ? await Promise.all(containersBase.map(async c => ({ ...c, packages: await api.containerPackages.list(c.id).catch(() => []) })))
        : containersBase;
      // Org-wide DG compliance address (TKT-DPLQTV) — pulled onto the DG01 declaration's
      // emergency-contact line in place of a hand-filled blank; falls back to the generic
      // CHEMTREC/CANUTEC hotlines if the org hasn't filled its own compliance address in yet.
      const dgCompliance = orgSettings ? {
        contactName: orgSettings.dg_compliance_contact_name || "",
        phone:       orgSettings.dg_compliance_phone         || "",
        email:       orgSettings.dg_compliance_email         || "",
        address:     orgSettings.dg_compliance_address       || "",
      } : null;
      const missing = getMissingDocRequirements(docCode, { shipment, containers, shipper, consignee, costLines, dgCompliance, parties });
      if (missing.length > 0) {
        toast.error(`Cannot generate ${docTypeLabel(docCode)} — missing:\n${missing.map(m => `• ${m}`).join("\n")}`);
        setLoading(false);
        return;
      }
      const html = dispatchDocBuilder(docCode, {
        shipment, invNumber: docNum, invDate: docDate, notes, containers, shipper, consignee, costLines, dgCompliance, parties, exportFilingItn,
      });

      // Save to shipment documents — server renders + signs the PDF, so the signing key
      // never has to leave the server.
      const filename = `${docCode}-${docNum}-${docDate}.pdf`;
      const saved    = await api.documents.generate(shipment.id, {
        html, filename, docType: docCode,
      });
      toast.success(`${docTypeLabel(docCode)} saved to Documents`);
      onSaved?.(saved);
    } catch (ex) { toast.error(ex.message); }
    setLoading(false);
  };

  return (
    <Modal title="Generate Document" onClose={onClose} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 6 }}>Document Type</div>
          <select value={docCode} onChange={e => setDocCode(e.target.value)}
            style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", cursor: "pointer" }}>
            {/* CN01 is excluded — it's only ever produced by the Reverse action on Invoice Entry,
                never picked ad hoc (it needs real reversal-line data behind it). */}
            {DOC_TYPES.filter(t => t.code !== "CN01").map(t => <option key={t.code} value={t.code}>{t.code} · {t.label}</option>)}
          </select>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Reference Number</div>
            <input value={docNum} onChange={e => setDocNum(e.target.value)}
              style={{ width: "100%", fontFamily: T.mono, fontSize: 12, background: T.surface, color: T.text,
                border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px" }} />
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Date</div>
            <input type="date" value={docDate} onChange={e => setDocDate(e.target.value)}
              style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
                border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px" }} />
          </div>
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Notes (optional)</div>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            placeholder="Additional notes to appear on the document…"
            style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", resize: "vertical", boxSizing: "border-box" }} />
        </div>
        <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
          Generates a digitally signed PDF and saves it to Documents.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handlePreview} disabled={loading || !docNum.trim()}>
            {loading ? "Building…" : "Generate →"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Documents Modal ──────────────────────────────────────────────────────────
// TrackedDocPreviewModal (in-app preview) now lives in
// src/components/shared/TrackedDocPreviewModal.jsx — shared with the Accounting
// Invoice Entry page, which can't import it back from here.

const DOC_STATUS_STYLE = {
  draft:     { label: "Draft",     bg: "", color: T.textMuted, border: T.border },
  confirmed: { label: "Confirmed", bg: "", color: T.success,   border: T.success + "66" },
};

const DOC_READINESS_COLOR = {
  confirmed: "#34d399",
  draft:     "#94a3b8",
  outdated:  "#fbbf24",
  missing:   "#f87171",
};
const DOC_READINESS_LABEL = {
  confirmed: "✓ Confirmed",
  draft:     "Draft",
  outdated:  "⚠ Outdated",
  missing:   "Missing",
};

// ─── Send Document Email Modal ─────────────────────────────────────────────────
// Always sends from the shipment's EMO (Export Managing Office) — a direct scope decision,
// not a user-facing office picker (see the shipped plan). Recipient candidates mirror
// GenerateDocumentModal.handlePreview's existing party-resolution pattern just below.

const SendDocumentEmailModal = ({ shipment, doc, onClose }) => {
  const [candidates, setCandidates] = useState([]);
  const [loadingCandidates, setLoadingCandidates] = useState(true);
  const [to,          setTo]          = useState("");
  const [customMode,  setCustomMode]  = useState(false);
  const [subject,     setSubject]     = useState(`${docTypeLabel(doc.docType)} — ${shipment.id}`);
  const [message,     setMessage]     = useState(`Please find attached the ${docTypeLabel(doc.docType)} for shipment ${shipment.id}.`);
  const [sending,     setSending]     = useState(false);

  useEffect(() => {
    (async () => {
      const fixedRoles = [
        ["Shipper", shipment.shipperId, shipment.shipperName],
        ["Consignee", shipment.consigneeId, shipment.consigneeName],
        ["Notify Party", shipment.notifyId, shipment.notifyName],
        ["Principal", shipment.principalId, shipment.principalName],
      ].filter(([, id]) => id);
      const parties = await api.shipmentParties.list(shipment.id).catch(() => []);
      const allRefs = [...fixedRoles, ...parties.map(p => [p.role, p.customerId, p.customerName])];
      const resolved = await Promise.all(allRefs.map(async ([role, customerId, name]) => {
        const cust = await api.customers.get(customerId).catch(() => null);
        return cust?.email ? { role, name: name || cust.companyName, email: cust.email } : null;
      }));
      const list = resolved.filter(Boolean);
      setCandidates(list);
      if (list.length) setTo(list[0].email); else setCustomMode(true);
      setLoadingCandidates(false);
    })();
  }, [shipment.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = async () => {
    if (!to.trim()) return toast.error("A recipient email address is required");
    setSending(true);
    try {
      await api.documents.sendEmail(shipment.id, doc.id, { to: to.trim(), subject, message });
      toast.success(`Sent to ${to.trim()}`);
      onClose();
    } catch (ex) { toast.error(ex.message); } finally { setSending(false); }
  };

  return (
    <Modal title={`Send — ${doc.filename}`} onClose={onClose} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted,
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px" }}>
          Sends from <strong>{shipment.emoOfficeName || "the shipment's Export Managing Office"}</strong>
          {shipment.emoOfficeName ? "" : " — configure it under Parties & Offices if unset"}.
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 6 }}>To</div>
          {!customMode && candidates.length > 0 ? (
            <select value={to} onChange={e => { if (e.target.value === "__custom__") { setCustomMode(true); setTo(""); } else setTo(e.target.value); }}
              style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
                border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", cursor: "pointer" }}>
              {candidates.map(c => <option key={c.role} value={c.email}>{c.role}: {c.name} &lt;{c.email}&gt;</option>)}
              <option value="__custom__">Other (enter manually)…</option>
            </select>
          ) : (
            <input type="email" value={to} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com"
              style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
                border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px", boxSizing: "border-box" }} />
          )}
          {!loadingCandidates && candidates.length === 0 && (
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 4 }}>
              No party on this shipment has an email on file — enter one manually.
            </div>
          )}
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Subject</div>
          <input value={subject} onChange={e => setSubject(e.target.value)}
            style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px", boxSizing: "border-box" }} />
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Message</div>
          <textarea value={message} onChange={e => setMessage(e.target.value)} rows={4}
            style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", resize: "vertical", boxSizing: "border-box" }} />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handleSend} disabled={sending || !to.trim()}>{sending ? "Sending…" : "Send →"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

// EDI distribution — a formal transmittal record only (this app's EDI has always been
// simulated/structured-JSON, no attachment concept anywhere in edi_messages); the "recipient" is
// free text since a document's EDI counterparty isn't always a carrier (a Certificate of Origin
// might go to a customs broker), mirroring carrier_code's own established loose-text convention.
const SendDocumentEdiModal = ({ shipment, doc, onClose }) => {
  const [recipientCode,  setRecipientCode]  = useState("");
  const [recipientLabel, setRecipientLabel] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!recipientCode.trim()) return toast.error("A recipient code is required");
    setSending(true);
    try {
      await api.documents.sendEdi(shipment.id, doc.id, { recipientCode: recipientCode.trim(), recipientLabel: recipientLabel.trim() });
      toast.success(`EDI transmittal sent to ${recipientCode.trim()}`);
      onClose();
    } catch (ex) { toast.error(ex.message); } finally { setSending(false); }
  };

  return (
    <Modal title={`Send via EDI — ${doc.filename}`} onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted,
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px" }}>
          Records a formal EDI transmittal (document metadata + checksum, simulated — no real EDI
          network integration) via the Document Distribution Service.
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Recipient Code <span style={{ color: T.danger }}>*</span></div>
          <input value={recipientCode} onChange={e => setRecipientCode(e.target.value)} placeholder="e.g. MAEU, or a customs broker code"
            style={{ width: "100%", fontFamily: T.mono, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px", boxSizing: "border-box" }} />
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Recipient Label (optional)</div>
          <input value={recipientLabel} onChange={e => setRecipientLabel(e.target.value)} placeholder="e.g. Maersk Line"
            style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px", boxSizing: "border-box" }} />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handleSend} disabled={sending || !recipientCode.trim()}>{sending ? "Sending…" : "Send →"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

// Webhook distribution — no recipient input, everything resolves server-side from the shipment's
// EMO office's configured webhook (Document Distribution Service). A confirm-style modal rather
// than a silent one-click action, so a mis-click doesn't fire a real external HTTP POST unseen.
const SendDocumentWebhookModal = ({ shipment, doc, onClose }) => {
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    setSending(true);
    try {
      await api.documents.sendWebhook(shipment.id, doc.id);
      toast.success("Webhook delivered");
      onClose();
    } catch (ex) { toast.error(ex.message); } finally { setSending(false); }
  };

  return (
    <Modal title={`Send via Webhook — ${doc.filename}`} onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted,
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px" }}>
          Delivers to <strong>{shipment.emoOfficeName || "the shipment's Export Managing Office"}</strong>'s
          configured webhook{shipment.emoOfficeName ? "" : " — configure it under Parties & Offices if unset"},
          via a signed, expiring download link. Configure the webhook URL under the office's Webhook
          Settings first.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handleSend} disabled={sending}>{sending ? "Sending…" : "Send →"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

// Kept in App.jsx (not a separate src/pages/ file) — GenerateDocumentModal here depends on
// ~450 lines of buildXHtml/dispatchDocBuilder template functions defined earlier in this
// file (lines ~74-566); a separate page file would need to import them back from App.jsx,
// a circular import no other page in this codebase does. standalone=true renders the
// Documents section's body directly in the routing switch below instead.
const DocumentsModal = ({ shipment, canEdit, onClose, standalone = false }) => {
  const [docs,           setDocs]           = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [uploading,      setUploading]      = useState(false);
  const [docType,        setDocType]        = useState(DOC_TYPES[0].code);
  const [file,           setFile]           = useState(null);
  const [genInvOpen,     setGenInvOpen]     = useState(false);
  const [genDefaultCode, setGenDefaultCode] = useState(null);
  const [previewDoc,     setPreviewDoc]     = useState(null);
  const [sendDoc,        setSendDoc]        = useState(null);
  const [ediDoc,         setEdiDoc]         = useState(null);
  const [webhookDoc,     setWebhookDoc]     = useState(null);
  const [historyDoc,     setHistoryDoc]     = useState(null);
  const fileRef = useRef(null);

  // Best doc per type: confirmed+fresh > confirmed+stale > draft+fresh > draft+stale
  const latestByCode = useMemo(() => {
    const map = {};
    docs.forEach(doc => { (map[doc.docType] ||= []).push(doc); });
    const result = {};
    Object.entries(map).forEach(([code, list]) => {
      const pri = d => (d.status === "confirmed" && !d.isStale) ? 0
                     : (d.status === "confirmed")                ? 1
                     : (!d.isStale)                              ? 2 : 3;
      list.sort((a, b) => pri(a) - pri(b) || new Date(b.createdAt) - new Date(a.createdAt));
      result[code] = list[0];
    });
    return result;
  }, [docs]);

  const typeStatus = code => {
    const doc = latestByCode[code];
    if (!doc)                                    return "missing";
    if (doc.status === "confirmed" && !doc.isStale) return "confirmed";
    if (doc.isStale)                             return "outdated";
    return "draft";
  };

  const confirmedCount = DOC_TYPES.filter(t => typeStatus(t.code) === "confirmed").length;
  const draftCount     = DOC_TYPES.filter(t => ["draft","outdated"].includes(typeStatus(t.code))).length;
  const missingCount   = DOC_TYPES.filter(t => typeStatus(t.code) === "missing").length;
  const total          = DOC_TYPES.length;

  useEffect(() => {
    api.documents.list(shipment.id)
      .then(setDocs)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [shipment.id]);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async e => {
      const base64 = e.target.result.split(",")[1];
      try {
        const doc = await api.documents.upload(shipment.id, {
          filename: file.name, mimeType: file.type, docType, data: base64,
        });
        setDocs(p => [doc, ...p]);
        setFile(null);
        fileRef.current.value = "";
        toast.success("Document uploaded");
      } catch (ex) { toast.error(ex.message); }
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const handleDelete = async id => {
    if (!window.confirm("Remove this document?")) return;
    try {
      await api.documents.remove(id);
      setDocs(p => p.filter(d => d.id !== id));
      toast.success("Document removed");
    } catch (ex) { toast.error(ex.message); }
  };

  const handleConfirm = async id => {
    try {
      const updated = await api.documents.patch(id, { status: "confirmed" });
      setDocs(p => p.map(d => d.id === id ? updated : d));
      setPreviewDoc(p => p?.id === id ? updated : p);
      toast.success("Document confirmed");
    } catch (ex) { toast.error(ex.message); }
  };

  const statusBadge = doc => {
    if (doc.isStale) return (
      <span title="Shipment data changed after this document was generated — consider regenerating"
        style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "1px 6px",
          background: T.warning + "22", color: T.warning, border: `1px solid ${T.warning + "55"}` }}>
        ⚠ Outdated
      </span>
    );
    const s = DOC_STATUS_STYLE[doc.status] || DOC_STATUS_STYLE.draft;
    return (
      <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "1px 6px",
        background: doc.status === "confirmed" ? T.success + "18" : T.surface,
        color: s.color, border: `1px solid ${s.border}` }}>
        {doc.status === "confirmed" ? "✓ " : ""}{s.label}
      </span>
    );
  };

  const body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Toolbar */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="secondary" onClick={() => { setGenDefaultCode(null); setGenInvOpen(true); }}>⚡ Generate Document</Btn>
        </div>

        {/* Document readiness overview */}
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
          {/* Coverage bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 20,
            padding: "14px 16px", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ display: "flex", gap: 20, flexShrink: 0 }}>
              {[[confirmedCount, "Confirmed", DOC_READINESS_COLOR.confirmed],
                [draftCount,     "Draft / Outdated", DOC_READINESS_COLOR.outdated],
                [missingCount,   "Missing",   DOC_READINESS_COLOR.missing]].map(([n, lbl, color]) => (
                <div key={lbl}>
                  <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 800,
                    fontVariantNumeric: "tabular-nums", lineHeight: 1, color }}>{n}</div>
                  <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
                    letterSpacing: ".08em", textTransform: "uppercase", color: T.textMuted }}>{lbl}</div>
                </div>
              ))}
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ height: 6, borderRadius: 3, background: T.border, overflow: "hidden", display: "flex" }}>
                <div style={{ width: `${confirmedCount / total * 100}%`, background: DOC_READINESS_COLOR.confirmed }} />
                <div style={{ width: `${draftCount     / total * 100}%`, background: DOC_READINESS_COLOR.outdated  }} />
                <div style={{ width: `${missingCount   / total * 100}%`, background: DOC_READINESS_COLOR.missing   }} />
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, textAlign: "right" }}>
                {confirmedCount} / {total} confirmed
              </div>
            </div>
          </div>

          {/* Doc type rows */}
          {DOC_TYPES.map((t, idx) => {
            const doc  = latestByCode[t.code];
            const stat = typeStatus(t.code);
            const col  = DOC_READINESS_COLOR[stat];
            const handleRowClick = () => {
              if (doc) { setPreviewDoc(doc); }
              else     { setGenDefaultCode(t.code); setGenInvOpen(true); }
            };
            return (
              <div key={t.code}
                onClick={handleRowClick}
                style={{ display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 16px",
                  borderBottom: idx < DOC_TYPES.length - 1 ? `1px solid ${T.border}22` : "none",
                  cursor: "pointer", transition: "background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background = T.surface}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  color: T.accent, background: T.accent + "18",
                  border: `1px solid ${T.accent}33`, borderRadius: 4,
                  padding: "1px 6px", flexShrink: 0, minWidth: 38, textAlign: "center" }}>
                  {t.code}
                </span>
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1 }}>
                  {t.label}
                </span>
                {doc && (
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, flexShrink: 0 }}>
                    {fmtDate(doc.createdAt)}
                  </span>
                )}
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  color: col, background: col + "18", border: `1px solid ${col}44`,
                  borderRadius: 4, padding: "1px 7px", flexShrink: 0, minWidth: 78, textAlign: "center" }}>
                  {DOC_READINESS_LABEL[stat]}
                </span>
                {!doc && canEdit && (
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.accent,
                    background: T.accent + "15", border: `1px solid ${T.accent}44`,
                    borderRadius: 4, padding: "1px 8px", flexShrink: 0 }}>
                    ⚡ Generate
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Upload area — editors only */}
        {canEdit && (
          <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>
              Upload External Document
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>File</div>
                <input ref={fileRef} type="file" onChange={e => setFile(e.target.files[0] || null)}
                  style={{ fontFamily: T.body, fontSize: 13, color: T.text, width: "100%" }} />
              </div>
              <div>
                <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Document Type</div>
                <select value={docType} onChange={e => setDocType(e.target.value)}
                  style={{ fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
                    border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}>
                  {DOC_TYPES.map(t => <option key={t.code} value={t.code}>{t.code} · {t.label}</option>)}
                </select>
              </div>
              <Btn onClick={handleUpload} disabled={!file || uploading}>
                {uploading ? "Uploading…" : "Upload"}
              </Btn>
            </div>
          </div>
        )}

        {/* Document list */}
        {loading ? (
          <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            Loading…
          </div>
        ) : docs.length === 0 ? (
          <div style={{ padding: "40px 0", textAlign: "center" }}>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, marginBottom: 8 }}>
              No documents yet.
            </div>
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
              Use <strong>⚡ Generate Document</strong> to create a Bill of Lading, Invoice, Packing List and more.
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {docs.map(doc => (
              <div key={doc.id} style={{ display: "flex", alignItems: "flex-start", gap: 12,
                padding: "12px 14px", background: T.bg,
                border: `1px solid ${doc.isStale ? T.warning + "55" : T.border}`,
                borderRadius: 8, transition: "border-color .15s" }}>
                <span style={{ fontSize: 20, flexShrink: 0, marginTop: 2 }}>{FILE_ICON(doc.mimeType)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 4 }}>
                    {doc.filename}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                      background: T.accent + "22", color: T.accent, borderRadius: 4, padding: "1px 6px" }}>
                      {doc.docType}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                      {docTypeLabel(doc.docType)}
                    </span>
                    {statusBadge(doc)}
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                      {fmtBytes(doc.sizeBytes)} · {fmtDate(doc.createdAt)}
                      {doc.uploadedBy && ` · ${doc.uploadedBy}`}
                    </span>
                    {doc.status === "confirmed" && doc.confirmedBy && (
                      <span style={{ fontFamily: T.body, fontSize: 11, color: T.success }}>
                        confirmed by {doc.confirmedBy}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 5, flexShrink: 0, alignItems: "center", marginTop: 1 }}>
                  <Btn size="sm" variant="secondary" onClick={() => setPreviewDoc(doc)}>
                    👁 Preview
                  </Btn>
                  <Btn size="sm" variant="secondary"
                    onClick={() => api.documents.download(doc.id, doc.filename).catch(() => toast.error("Download failed"))}>
                    ↓
                  </Btn>
                  <Btn size="sm" variant="secondary" onClick={() => setSendDoc(doc)}>
                    ✉ Send
                  </Btn>
                  <Btn size="sm" variant="secondary" onClick={() => setEdiDoc(doc)}>
                    📡 EDI
                  </Btn>
                  <Btn size="sm" variant="secondary" onClick={() => setWebhookDoc(doc)}>
                    🔗 Webhook
                  </Btn>
                  <Btn size="sm" variant="secondary" onClick={() => setHistoryDoc(doc)}>
                    🕐
                  </Btn>
                  {canEdit && doc.status !== "confirmed" && (
                    <Btn size="sm" variant="secondary" onClick={() => handleConfirm(doc.id)}
                      style={{ color: T.success, borderColor: T.success + "66" }}>
                      ✓ Confirm
                    </Btn>
                  )}
                  {canEdit && (
                    <Btn size="sm" variant="danger" onClick={() => handleDelete(doc.id)}>✕</Btn>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
  );

  return (
    <>
      {standalone ? body : (
        <Modal title={`Documents — ${shipment.id}`} onClose={onClose} width={720}>{body}</Modal>
      )}
      {genInvOpen && (
        <GenerateDocumentModal
          shipment={shipment}
          defaultCode={genDefaultCode}
          onClose={() => { setGenInvOpen(false); setGenDefaultCode(null); }}
          onSaved={doc => { setDocs(p => [doc, ...p]); setGenInvOpen(false); setGenDefaultCode(null); setPreviewDoc(doc); }}
        />
      )}
      {previewDoc && (
        <TrackedDocPreviewModal
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
          onConfirm={canEdit ? () => handleConfirm(previewDoc.id) : null}
          onSend={() => setSendDoc(previewDoc)}
        />
      )}
      {sendDoc && (
        <SendDocumentEmailModal shipment={shipment} doc={sendDoc} onClose={() => setSendDoc(null)} />
      )}
      {ediDoc && (
        <SendDocumentEdiModal shipment={shipment} doc={ediDoc} onClose={() => setEdiDoc(null)} />
      )}
      {webhookDoc && (
        <SendDocumentWebhookModal shipment={shipment} doc={webhookDoc} onClose={() => setWebhookDoc(null)} />
      )}
      {historyDoc && (
        <EntityHistoryModal
          entityType="document"
          entityId={historyDoc.id}
          title={`History — ${historyDoc.filename}`}
          onClose={() => setHistoryDoc(null)} />
      )}
    </>
  );
};

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
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    fetch("/api/settings", { headers }).then(r => r.ok ? r.json() : {}).then(s => setSettings(s)).catch(() => {});
  }, []);

  const runChecks = async () => {
    setRunning(true);
    setResults({});
    const token   = localStorage.getItem(TOKEN_KEY);
    const authHdr = token ? { Authorization: `Bearer ${token}` } : {};
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
        let migrations = null;
        if (id === "server" && r.ok) {
          try { migrations = (await r.clone().json())?.migrations || null; } catch { /* non-JSON, ignore */ }
        }
        setResults(p => ({ ...p, [id]: { ok: r.ok, status: r.status, latency: Date.now() - t0, migrations } }));
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

// ─── Shipment Form Sidebar ────────────────────────────────────────────────────

const ShipmentFormSidebar = ({ shipment, mode, navigate, onContainers }) => {
  const goBack = () => {
    if (window.opener) { window.close(); return; }
    if (mode === "edit" && shipment) navigate("detail", shipment.id);
    else navigate("shipments");
  };

  const STATUS_COLORS = {
    Active:    { bg: "#22c55e22", color: "#22c55e" },
    Completed: { bg: "#3b82f622", color: "#3b82f6" },
    Cancelled: { bg: "#ef444422", color: "#ef4444" },
  };
  const sc = shipment ? (STATUS_COLORS[shipment.status] || { bg: "#ffffff11", color: T.textMuted }) : null;

  return (
    <aside style={{ width: 240, background: T.surface, borderRight: `1px solid ${T.border}`,
      display: "flex", flexDirection: "column", flexShrink: 0 }}>

      <div style={{ padding: "22px 20px 18px", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontFamily: T.head, fontSize: 17, fontWeight: 800, color: T.text,
          display: "flex", alignItems: "center", gap: 7 }}><IconAnchor size={17} />CargoDesk</div>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted, marginTop: 3,
          letterSpacing: ".12em", textTransform: "uppercase" }}>Freight Management</div>
      </div>

      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}` }}>
        <button onClick={goBack} style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "8px 12px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}`,
          fontFamily: T.body, fontSize: 13, color: T.text, cursor: "pointer", fontWeight: 500, textAlign: "left",
        }}>
          ← {mode === "edit" && shipment ? shipment.id : "All Shipments"}
        </button>
      </div>

      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column", gap: 7 }}>
        {mode === "new" ? (
          <>
            <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.textMuted }}>New Shipment</div>
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>Fill in the form to create</div>
          </>
        ) : shipment ? (
          <>
            <div style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 800, color: T.text,
              cursor: "pointer", userSelect: "none" }}
              title="Click to copy"
              onClick={() => navigator.clipboard.writeText(shipment.id).then(() => toast.success(`Copied ${shipment.id}`))}>
              {shipment.id}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, borderRadius: 4,
                padding: "2px 8px", background: sc.bg, color: sc.color }}>{shipment.status}</span>
              {shipment.carrierCode && (
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{shipment.carrierCode}</span>
              )}
            </div>
            {(shipment.pol || shipment.pod) && (
              <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 600 }}>
                {shipment.pol || "—"} → {shipment.pod || "—"}
              </div>
            )}
            {shipment.etd && (
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>ETD {shipment.etd}</div>
            )}
          </>
        ) : null}
      </div>

      {onContainers && (
        <div style={{ padding: "10px 16px", borderBottom: `1px solid ${T.border}` }}>
          <button onClick={onContainers} style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%",
            padding: "8px 12px", borderRadius: 8, background: "transparent",
            border: `1px solid ${T.border}`, fontFamily: T.body, fontSize: 13,
            color: T.text, cursor: "pointer", fontWeight: 500, textAlign: "left",
            transition: "border-color .15s, background .15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.background = T.accentBg; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; }}>
            📦 {mode === "new" ? "Manage Containers" : "Containers"}
          </button>
        </div>
      )}

      <div style={{ padding: "14px 16px", flex: 1 }}>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 8 }}>
          {mode === "new" ? "Creating" : "Editing"}
        </div>
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.55 }}>
          {mode === "new"
            ? "Unsaved changes will be lost if you navigate away."
            : "Changes are saved when you click Save Changes."}
        </div>
      </div>
    </aside>
  );
};

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

// ─── Under Construction ───────────────────────────────────────────────────────

const ORG_LABELS = { "org-country": "Country", "org-branch": "Branch", "org-office": "Office" };
const ORG_ICONS  = { "org-country": "🌍", "org-branch": "🏛️", "org-office": "🏢" };

function UnderConstructionPage({ page }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: 420, gap: 16, textAlign: "center" }}>
      <div style={{ fontSize: 52 }}>{ORG_ICONS[page] || "🚧"}</div>
      <div style={{ fontFamily: T.head, fontSize: 24, fontWeight: 800, color: T.text }}>
        {ORG_LABELS[page] || page}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 18px",
        borderRadius: 20, background: T.warning + "18", border: `1px solid ${T.warning}44` }}>
        <span style={{ fontSize: 14 }}>🚧</span>
        <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700,
          color: T.warning, textTransform: "uppercase", letterSpacing: ".08em" }}>
          Under Construction
        </span>
      </div>
      <div style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted,
        maxWidth: 380, lineHeight: 1.7, marginTop: 4 }}>
        This module is being built. Check back in a future release.
      </div>
    </div>
  );
}

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
  const [detailAction, setDetailAction] = useState(null);
  const [user,         setUser]         = useState(null);
  const [authLoading,  setAuthLoading]  = useState(true);
  const [changePwOpen,   setChangePwOpen]   = useState(false);
  const [changePwForced, setChangePwForced] = useState(false);

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
  const availableRoles = (roles) =>
    Object.keys(ROLE_RANK)
      .filter(r => ROLE_RANK[r] <= ROLE_RANK[primaryRole(roles)])
      .sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a]);
  const userRoles       = Array.isArray(user?.roles) ? user.roles : (user?.role ? [user.role] : ['viewer']);
  const userPrimaryRole = primaryRole(userRoles);

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
    if (passwordExpired) { setChangePwForced(true); setChangePwOpen(true); }
  };
  const handleLogout = () => {
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
  const handleEditContainer = async (id, form, { silent = false } = {}) => {
    try {
      const updated = await api.containers.update(id, form);
      setContainers(p => p.map(c => c.id === id ? { ...c, ...updated } : c));
      if (!silent) toast.success("Container updated");
      return updated;
    } catch (e) { toast.error(e.message); throw e; }
  };
  const handleDeleteContainer = async id => {
    try {
      await api.containers.remove(id);
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

  // kanban is top-level, not MDM
  const MDM_PAGES = ["mdm-carriers", "mdm-carrier-agents", "mdm-ports", "mdm-linked", "mdm-vessels", "mdm-commodities", "mdm-tradelanes", "mdm-countries", "mdm-unlocodes", "mdm-customers", "mdm-sanctioned-customers", "mdm-contracts", "rate-benchmark", "mdm-charge-codes", "mdm-equipment", "mdm-pack-types", "mdm-container-types"];
  const ORG_PAGES = ["org-country", "org-branch", "org-office"];
  const ALL_PAGES = [...MDM_PAGES, ...ORG_PAGES, "manual"];
  const isMdmActive = MDM_PAGES.includes(page);
  const isOrgActive = ORG_PAGES.includes(page);

  if (page === "track") return <TrackingPage token={selectedId} />;
  if (page === "forgot-password") return <ForgotPasswordPage />;
  if (page === "reset-password")  return <ResetPasswordPage token={selectedId} />;

  if (authLoading) return <FullPageSpinner />;
  if (!user)       return <LoginPage onLogin={handleLogin} />;

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
    "mdm-tradelanes":   "Master Data — Trade Lanes",
    "mdm-regions":      "Master Data — Regions",
    "mdm-countries":    "Master Data — Countries",
    "mdm-unlocodes":    "Master Data — UN Location Codes",
    "mdm-customers":              "Master Data — Customers",
    "mdm-sanctioned-customers":  "Master Data — Sanctioned Customers",
    "mdm-contracts":    "Master Data — Contracts",
    "rate-benchmark":   "Rate Benchmarking",
    "mdm-charge-codes": "Master Data — Automated Charge Codes",
    "mdm-equipment": "Master Data — Equipment",
    "mdm-pack-types": "Master Data — Pack Types",
    "mdm-container-types": "Master Data — Container Types",
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
      if (remainingBell.length === 0 && remainingBookingBell.length === 0 && remainingExpiring.length === 0 && remainingOverdueInv.length === 0 && activeSysMsgs.length === 0) setBellOpen(false);
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

    const bellCount = visibleBellItems.length + visibleBookingBellItems.length + visibleExpiringContracts.length + visibleOverdueInvoiceDeadlines.length + activeSysMsgs.length;

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
                    {visibleExpiringContracts.map(c => (
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
                    {visibleOverdueInvoiceDeadlines.map(d => (
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

  const effectiveRoles = activeRole ? [activeRole] : userRoles;
  const effectiveRole  = activeRole || userPrimaryRole;
  const authCtxValue = {
    user,
    activeRole:         effectiveRole,
    activeRoles:        effectiveRoles,
    canEdit:            effectiveRoles.some(r => r !== 'viewer'),
    canEditShipments:   effectiveRoles.some(r => ['admin', 'operator', 'occ_bk'].includes(r)),
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

            {/* Reports — same finance-access gate as Dashboard's Margin tab; hidden outright here
                since (unlike Margin's mask-the-numbers approach) the backend hard-403s a non-
                finance user rather than serving redacted data. */}
            {(appSettings.finance_view_enabled !== 'false' && (effectiveRoles.includes('admin') || !!(user?.canViewFinance))) && (
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
                  <NavBtn pageKey="mdm-customers"            icon={IconGroup} label="Customers"            indent />
                  <NavBtn pageKey="mdm-sanctioned-customers" icon={IconCircle} iconColor="#ef4444" label="Sanctioned Customers" subIndent />
                  <NavBtn pageKey="mdm-contracts"   icon={IconClipboard} label="Contracts"       indent />
                  <NavBtn pageKey="rate-benchmark"  icon={IconSearch}    label="Rate Benchmarking" subIndent />
                  <NavBtn pageKey="mdm-charge-codes" icon={IconTag} label="Charge Codes"    indent />
                  <NavBtn pageKey="mdm-carriers" icon={IconBuilding} label="Carriers"       indent />
                  <NavBtn pageKey="mdm-carrier-agents" icon={IconLink} label="Carrier Agents" subIndent />
                  <NavBtn pageKey="mdm-vessels"      icon={IconShip} label="Vessels"         indent />
                  <NavBtn pageKey="mdm-commodities" icon={IconPackage} label="Commodities"     indent />
                  <NavBtn pageKey="mdm-ports"    icon={IconMapPin} label="Port Locations" indent />
                  <NavBtn pageKey="mdm-linked"   icon={IconLink} label="Linked Ports"   subIndent />

                  <NavBtn pageKey="mdm-equipment" icon={IconArchive} label="Equipment"      indent />

                  {/* Locations sub-section */}
                  <div style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: ".1em", padding: "10px 12px 3px 28px" }}>Locations</div>
                  <NavBtn pageKey="mdm-tradelanes" icon={IconRoute} label="Trade Lanes"         indent />
                  <NavBtn pageKey="mdm-countries" icon={IconFlag} label="Countries"          indent />
                  <NavBtn pageKey="mdm-unlocodes" icon={IconHashtag} label="UN Location Codes"  indent />
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
            onDeleteContainer={handleDeleteContainer} />
        )}

        {page === "shipment-parties" && selectedShipment && (
          <ShipmentPartiesPage
            shipment={selectedShipment}
            onBack={() => navigate("detail", selectedShipment.id)}
            onUpdate={handleUpdateShipment} />
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
            standalone
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
        {page === "mdm-tradelanes" &&                                 <MdmTradeLanesPage />}
        {page === "mdm-countries"  &&                                 <MdmCountriesPage />}
        {page === "mdm-unlocodes"  &&                                 <MdmUNLocationCodesPage />}
        {page === "mdm-commodities"&&                                 <MdmCommoditiesPage />}
        {page === "mdm-charge-codes"&&                                <MdmChargeCodesPage />}
        {page === "mdm-equipment"&&                                   <MdmEquipmentPage navigate={navigate} />}
        {page === "mdm-pack-types"&&                                  <MdmPackTypesPage />}
        {page === "mdm-container-types"&&                             <MdmContainerTypesPage />}
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
                            await api.containers.remove(c.id);
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
                const updated = await api.containers.update(formCtrModal.id, form);
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