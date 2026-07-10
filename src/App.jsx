import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { T, applyTheme } from "./tokens";
import { toast } from "./toast";
import ToastContainer from "./components/primitives/ToastContainer";
import GlobalSavingOverlay from "./components/primitives/GlobalSavingOverlay";
import { FullPageSpinner } from "./components/primitives/Spinner";
import { api, TOKEN_KEY, ACTIVE_ROLE_KEY, ACTIVE_OFFICE_KEY } from "./api";
import { AuthContext } from "./AuthContext";

import Btn from "./components/primitives/Btn";
import { Modal } from "./components/primitives/Modal";
import { Field } from "./components/primitives/Form";

import ShipmentsPage     from "./pages/ShipmentsPage";
import ShipmentFormPage  from "./pages/ShipmentFormPage";
import ShipmentDetailPage, { ContainerForm } from "./pages/ShipmentDetailPage";
import DashboardPage       from "./pages/DashboardPage";
import DashboardArchive    from "./pages/DashboardArchivePage";
import UserManualPage      from "./pages/UserManualPage";
import AboutPage           from "./pages/AboutPage";
import AppSettingsPage     from "./pages/AppSettingsPage";
import { VERSION, COPYRIGHT_YEAR, COPYRIGHT_OWNER } from "./version";
import LandingPage         from "./pages/LandingPage";
import LoginPage           from "./pages/LoginPage";
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
import BranchPage              from "./pages/org/BranchPage";
import OfficePage              from "./pages/org/OfficePage";
import CountryPage             from "./pages/org/CountryPage";
import SpaceConfigurationsPage from "./pages/SpaceConfigurationsPage";
import LicensePage             from "./pages/LicensePage";
import SchedulesPage           from "./pages/SchedulesPage";
import AiChatDrawer            from "./components/shared/AiChatDrawer";
import TrackingPage            from "./pages/TrackingPage";



// ─── Documents Modal ──────────────────────────────────────────────────────────

const DOC_TYPES = [
  { code: "BL01", label: "Bill of Lading" },
  { code: "CI01", label: "Commercial Invoice" },
  { code: "CI02", label: "Commercial Invoice (Amendment)" },
  { code: "FR01", label: "Freight Invoice" },
  { code: "FR02", label: "Freight Invoice (Amendment)" },
  { code: "PL01", label: "Packing List" },
  { code: "CO01", label: "Certificate of Origin" },
  { code: "CD01", label: "Customs Declaration" },
  { code: "IC01", label: "Insurance Certificate" },
  { code: "DG01", label: "Dangerous Goods Declaration" },
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

const fmtCurr = (n, curr = "USD") =>
  `${curr} ${(parseFloat(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtAddrHtml = c => {
  if (!c) return "";
  return [c.companyName, c.address1, c.address2, [c.city, c.state].filter(Boolean).join(", "), [c.postalCode, c.countryIso2].filter(Boolean).join(" ")].filter(Boolean).join("<br>");
};

const INV_CSS = `
  @page{margin:18mm}
  @media print{.no-print{display:none!important}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;color:#111827;background:#fff;padding:32px;max-width:880px;margin:0 auto}
  .no-print{display:block;margin:0 0 20px auto;width:fit-content;padding:9px 18px;background:#2563eb;color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;letter-spacing:.3px}
  .no-print:hover{background:#1d4ed8}
  .header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:22px;border-bottom:3px solid #2563eb;margin-bottom:28px}
  .brand-name{font-size:26px;font-weight:900;color:#2563eb;letter-spacing:-1px}
  .brand-tag{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;margin-top:3px}
  .inv-info{text-align:right}
  .inv-type{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2.5px;color:#6b7280;margin-bottom:5px}
  .inv-number{font-size:21px;font-weight:800;color:#111827;font-variant-numeric:tabular-nums;letter-spacing:-0.5px}
  .inv-date{font-size:12px;color:#374151;margin-top:5px}
  .parties{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
  .party{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px}
  .party-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#9ca3af;margin-bottom:8px}
  .party-name{font-size:14px;font-weight:700;color:#111827;margin-bottom:4px}
  .party-addr{font-size:11px;color:#4b5563;line-height:1.7}
  .shp-block{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:20px}
  .block-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#9ca3af;margin-bottom:10px}
  .details-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 16px}
  .detail-key{font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
  .detail-val{font-size:12px;font-weight:600;color:#111827;font-variant-numeric:tabular-nums}
  .section-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#9ca3af;margin-bottom:10px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  th{background:#111827;color:#fff;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:10px 12px;text-align:left}
  td{padding:9px 12px;font-size:12px;border-bottom:1px solid #e5e7eb;color:#111827}
  tr:nth-child(even) td{background:#f9fafb}
  .num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
  .code{font-family:monospace;font-weight:700;color:#2563eb}
  .dg{background:#fee2e2;color:#dc2626;border-radius:3px;padding:1px 5px;font-size:10px;font-weight:700}
  .totals{border-top:2px solid #111827;padding-top:12px;margin-bottom:20px}
  .total-row{display:flex;justify-content:flex-end;gap:32px;padding:5px 0}
  .total-row.grand{padding-top:10px;margin-top:6px;border-top:1px solid #d1d5db}
  .total-label{font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;min-width:120px;text-align:right}
  .total-amt{font-size:13px;font-weight:700;color:#111827;font-variant-numeric:tabular-nums;min-width:140px;text-align:right}
  .grand .total-label{color:#111827;font-size:13px}
  .grand .total-amt{font-size:16px}
  .notes{background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:14px 16px;margin-bottom:20px}
  .notes-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#9ca3af;margin-bottom:6px}
  .notes-text{font-size:12px;color:#374151;line-height:1.7;white-space:pre-wrap}
  .footer{margin-top:32px;padding-top:14px;border-top:1px solid #e5e7eb;text-align:center;font-size:10px;color:#9ca3af}
`;

const _invShell = (title, invType, invNumber, invDate, body) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${INV_CSS}</style></head>
<body>
<button class="no-print" onclick="window.print()">🖨 Print / Save as PDF</button>
<div class="header">
  <div><div class="brand-name">CargoDesk</div><div class="brand-tag">Freight Management</div></div>
  <div class="inv-info">
    <div class="inv-type">${invType}</div>
    <div class="inv-number">${invNumber}</div>
    <div class="inv-date">Date: ${new Date(invDate + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}</div>
  </div>
</div>
${body}
<div class="footer">Generated by CargoDesk &mdash; ${new Date().toLocaleString()}</div>
</body></html>`;

const buildFreightInvoiceHtml = ({ shipment: sh, invNumber, invDate, notes, costLines }) => {
  const totals = {};
  for (const cl of costLines) totals[cl.currency] = (totals[cl.currency] || 0) + (parseFloat(cl.amount) || 0);

  const rows = costLines.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:20px">No cost lines recorded for this shipment</td></tr>`
    : costLines.map(cl => `<tr>
        <td><span class="code">${cl.chargeCode || "—"}</span></td>
        <td>${cl.type || "—"}${cl.notes ? `<br><span style="color:#6b7280;font-size:11px">${cl.notes}</span>` : ""}</td>
        <td>${cl.currency}</td>
        <td class="num">${fmtCurr(cl.amount, cl.currency)}</td>
      </tr>`).join("");

  const totalRows = Object.entries(totals).map(([c, a]) =>
    `<div class="total-row"><span class="total-label">Total ${c}</span><span class="total-amt">${fmtCurr(a, c)}</span></div>`).join("") ||
    `<div class="total-row"><span class="total-label">Total</span><span class="total-amt">—</span></div>`;

  const detailItems = [
    ["Shipment ID", sh.id], ["B/L Number", sh.blNumber || "—"], ["Booking Ref", sh.bookingRef || "—"],
    ["Origin (POL)", `${sh.pol}${sh.polName ? " · " + sh.polName : ""}`],
    ["Destination (POD)", `${sh.pod}${sh.podName ? " · " + sh.podName : ""}`],
    ["Carrier", sh.carrierCode || "—"],
    ["Vessel / Voyage", [sh.vessel, sh.voyage].filter(Boolean).join(" / ") || "—"],
    ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
    ["ETA", sh.eta ? new Date(sh.eta).toLocaleDateString("en-GB") : "—"],
    ["Incoterm", sh.incoterm || "—"], ["Freight Terms", sh.freightTerms || "Prepaid"],
    ["Declared Value", sh.declaredValue != null ? fmtCurr(sh.declaredValue, sh.declaredValueCurrency || "USD") : "—"],
  ].map(([k, v]) => `<div><div class="detail-key">${k}</div><div class="detail-val">${v}</div></div>`).join("");

  const body = `
    <div class="parties">
      <div class="party"><div class="party-label">Shipper / Exporter</div><div class="party-name">${sh.shipperName || "—"}</div></div>
      <div class="party"><div class="party-label">Consignee / Bill To</div><div class="party-name">${sh.consigneeName || "—"}</div></div>
    </div>
    <div class="shp-block"><div class="block-label">Shipment Details</div><div class="details-grid">${detailItems}</div></div>
    <div class="section-label">Charges</div>
    <table><thead><tr><th>Code</th><th>Type / Description</th><th>Currency</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="totals">${totalRows}</div>
    ${notes ? `<div class="notes"><div class="notes-label">Notes</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Freight Invoice — ${invNumber}`, "FREIGHT INVOICE", invNumber, invDate, body);
};

const buildCommercialInvoiceHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, consignee }) => {
  const rows = containers.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:20px">No containers recorded</td></tr>`
    : containers.map(c => `<tr>
        <td><span class="code" style="font-size:11px">${c.containerNumber || "TBC"}</span></td>
        <td>${c.size}ft ${c.type}${c.isDg ? ` <span class="dg">DG ${c.dgClass}</span>` : ""}</td>
        <td class="num">${c.grossWeightKg != null ? Number(c.grossWeightKg).toLocaleString() + " kg" : "—"}</td>
        <td class="num">${c.volumeCbm != null ? Number(c.volumeCbm).toLocaleString() + " CBM" : "—"}</td>
        <td>${c.cargoDescription || "—"}</td>
        <td>${c.hsCode || "—"}</td>
        <td class="num">—</td>
      </tr>`).join("");

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
      <div class="total-row grand"><span class="total-label">Total Declared Value</span><span class="total-amt">As per attached</span></div>
    </div>
    ${notes ? `<div class="notes"><div class="notes-label">Notes</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Commercial Invoice — ${invNumber}`, "COMMERCIAL INVOICE", invNumber, invDate, body);
};

const _esc = s => String(s).replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
const _detailGrid = items => items.map(([k, v]) => `<div><div class="detail-key">${k}</div><div class="detail-val">${v}</div></div>`).join("");
const _ctrTotals = ctrs => {
  const w = ctrs.reduce((s, c) => s + (parseFloat(c.grossWeightKg) || 0), 0);
  const v = ctrs.reduce((s, c) => s + (parseFloat(c.volumeCbm) || 0), 0);
  return { w, v };
};

const buildBillOfLadingHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, consignee }) => {
  const { w: totalWeight, v: totalVolume } = _ctrTotals(containers);
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
    </div>
    <div class="shp-block"><div class="block-label">Transport Details</div>
      <div class="details-grid">${_detailGrid([
        ["B/L Number", _esc(sh.blNumber || invNumber)], ["Booking Ref", _esc(sh.bookingRef || "—")],
        ["Vessel", _esc(sh.vessel || "—")], ["Voyage", _esc(sh.voyage || "—")],
        ["Port of Loading", `${_esc(sh.pol)}${sh.polName ? " · " + _esc(sh.polName) : ""}`],
        ["Port of Discharge", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
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

const buildPackingListHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, consignee }) => {
  const { w: totalWeight, v: totalVolume } = _ctrTotals(containers);
  const rows = containers.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:16px">No containers recorded</td></tr>`
    : containers.map(c => `<tr>
        <td><span class="code">${_esc(c.containerNumber || "TBC")}</span></td>
        <td>${_esc(c.size)}ft ${_esc(c.type)}</td>
        <td>${_esc(c.cargoDescription || "—")}</td>
        <td>${c.hsCode ? `<span class="code" style="font-size:11px">${_esc(c.hsCode)}</span>` : "—"}</td>
        <td class="num">${c.grossWeightKg != null ? Number(c.grossWeightKg).toLocaleString() + " kg" : "—"}</td>
        <td class="num">${c.volumeCbm != null ? Number(c.volumeCbm) + " CBM" : "—"}</td>
        <td>${c.isDg ? `<span class="dg">DG ${_esc(c.dgClass)}</span>` : "—"}</td>
      </tr>`).join("");

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

const buildInsuranceCertHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper }) => {
  const { w: totalWeight } = _ctrTotals(containers);
  const descriptions = [...new Set(containers.map(c => c.cargoDescription).filter(Boolean))].join("; ") || "As described in Bill of Lading";

  const body = `
    <div class="shp-block"><div class="block-label">Assured</div>
      <div class="details-grid" style="grid-template-columns:repeat(2,1fr)">${_detailGrid([
        ["Assured / Insured Party", _esc(sh.shipperName || shipper?.companyName || "—")],
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

const buildDGDeclHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, consignee }) => {
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
          24hr Emergency: ___________<br>CHEMTREC: +1 703-527-3887<br>CANUTEC: +1 613-996-6666
        </div>
      </div>
    </div>
    ${notes ? `<div class="notes"><div class="notes-label">Special Instructions</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`DG Declaration — ${invNumber}`, "DANGEROUS GOODS DECLARATION", invNumber, invDate, body);
};

const buildCustomsDeclHtml = ({ shipment: sh, invNumber, invDate, notes, containers, shipper, consignee }) => {
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

const dispatchDocBuilder = (code, data) => {
  switch (code) {
    case "BL01":             return buildBillOfLadingHtml(data);
    case "CI01": case "CI02": return buildCommercialInvoiceHtml(data);
    case "FR01": case "FR02": return buildFreightInvoiceHtml(data);
    case "PL01":             return buildPackingListHtml(data);
    case "CO01":             return buildCertOriginHtml(data);
    case "IC01":             return buildInsuranceCertHtml(data);
    case "DG01":             return buildDGDeclHtml(data);
    case "CD01":             return buildCustomsDeclHtml(data);
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
      const [ctrsRaw, shipper, consignee, costLines] = await Promise.all([
        api.containers.list(),
        shipment.shipperId   ? api.customers.get(shipment.shipperId).catch(() => null)   : Promise.resolve(null),
        shipment.consigneeId ? api.customers.get(shipment.consigneeId).catch(() => null) : Promise.resolve(null),
        needsCostLines ? api.costLines.list(shipment.id).then(ls => ls.filter(l => l.type === "SELL")) : Promise.resolve([]),
      ]);
      const allCtrs    = Array.isArray(ctrsRaw) ? ctrsRaw : (ctrsRaw?.results ?? []);
      const containers = allCtrs.filter(c => c.shipmentId === shipment.id);
      const html = dispatchDocBuilder(docCode, {
        shipment, invNumber: docNum, invDate: docDate, notes, containers, shipper, consignee, costLines,
      });

      // Save to shipment documents
      const filename = `${docCode}-${docNum}-${docDate}.html`;
      const base64   = btoa(unescape(encodeURIComponent(html)));
      const saved    = await api.documents.upload(shipment.id, {
        filename, mimeType: "text/html", docType: docCode, data: base64,
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
            {DOC_TYPES.map(t => <option key={t.code} value={t.code}>{t.code} · {t.label}</option>)}
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
          Opens in a new window — use your browser's Print dialog to save as PDF.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handlePreview} disabled={loading || !docNum.trim()}>
            {loading ? "Building…" : "Preview / Print →"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── In-app document preview ──────────────────────────────────────────────────

const DocumentPreviewModal = ({ doc, onClose, onConfirm }) => {
  const [src,       setSrc]       = useState(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("cargodesk_token");
    fetch(`/api/documents/${doc.id}/download`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => setSrc(URL.createObjectURL(blob)))
      .catch(() => toast.error("Preview failed — try Download instead"));
    return () => { setSrc(s => { if (s) URL.revokeObjectURL(s); return null; }); };
  }, [doc.id]);

  const handleConfirm = async () => {
    setConfirming(true);
    await onConfirm?.();
    setConfirming(false);
  };

  const isConfirmed = doc.status === "confirmed";

  return (
    <Modal title={`${doc.docType} · ${doc.filename}`} onClose={onClose} width={960}>
      {/* Status bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 12, padding: "8px 12px",
        background: isConfirmed ? T.success + "14" : doc.isStale ? T.warning + "14" : T.bg,
        border: `1px solid ${isConfirmed ? T.success + "44" : doc.isStale ? T.warning + "44" : T.border}`,
        borderRadius: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            color: isConfirmed ? T.success : doc.isStale ? T.warning : T.textMuted }}>
            {isConfirmed ? "✓ Confirmed" : doc.isStale ? "⚠ Outdated" : "Draft"}
          </span>
          {isConfirmed && doc.confirmedBy && (
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
              by {doc.confirmedBy} · {fmtDate(doc.confirmedAt)}
            </span>
          )}
          {doc.isStale && (
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
              Shipment data changed after this document was generated
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn size="sm" variant="secondary"
            onClick={() => api.documents.download(doc.id, doc.filename).catch(() => toast.error("Download failed"))}>
            ↓ Download
          </Btn>
          {onConfirm && !isConfirmed && (
            <Btn size="sm" onClick={handleConfirm} disabled={confirming}>
              {confirming ? "Confirming…" : "✓ Confirm Document"}
            </Btn>
          )}
        </div>
      </div>

      {src
        ? <iframe src={src} title={doc.filename}
            style={{ width: "100%", height: "68vh", border: "none", borderRadius: 6, background: "#fff" }} />
        : <div style={{ height: "68vh", display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading preview…</div>}
    </Modal>
  );
};

// ─── Documents Modal ──────────────────────────────────────────────────────────

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

const DocumentsModal = ({ shipment, canEdit, onClose }) => {
  const [docs,           setDocs]           = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [uploading,      setUploading]      = useState(false);
  const [docType,        setDocType]        = useState(DOC_TYPES[0].code);
  const [file,           setFile]           = useState(null);
  const [genInvOpen,     setGenInvOpen]     = useState(false);
  const [genDefaultCode, setGenDefaultCode] = useState(null);
  const [previewDoc,     setPreviewDoc]     = useState(null);
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

  return (
    <Modal title={`Documents — ${shipment.id}`} onClose={onClose} width={720}>
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

      {genInvOpen && (
        <GenerateDocumentModal
          shipment={shipment}
          defaultCode={genDefaultCode}
          onClose={() => { setGenInvOpen(false); setGenDefaultCode(null); }}
          onSaved={doc => { setDocs(p => [doc, ...p]); setGenInvOpen(false); setGenDefaultCode(null); setPreviewDoc(doc); }}
        />
      )}
      {previewDoc && (
        <DocumentPreviewModal
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
          onConfirm={canEdit ? () => handleConfirm(previewDoc.id) : null}
        />
      )}
    </Modal>
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
        <div style={{ fontFamily: T.head, fontSize: 17, fontWeight: 800, color: T.text }}>⚓ CargoDesk</div>
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

const ShipmentDetailSidebar = ({ shipment, ctrCount, navigate, onSectionClick, onDocuments }) => {
  const goBack = () => {
    if (window.opener) window.close();
    else navigate("shipments");
  };

  const scrollTo = (id) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

  const handleSection = (id) => {
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

  const sections = [
    { id: "shp-overview",   icon: "◎",  label: "Overview" },
    { id: "shp-cargo",      icon: "📦", label: "Cargo",      badge: ctrCount || null },
    { id: "shp-milestones", icon: "⚑",  label: "Milestones" },
    { id: "shp-accounting", icon: "◈",  label: "Accounting" },
    { id: "shp-schedules",  icon: "⚓", label: "Schedules" },
    { id: "shp-tickets",    icon: "◩",  label: "Tickets" },
  ];

  return (
    <aside style={{ width: 240, background: T.surface, borderRight: `1px solid ${T.border}`,
      display: "flex", flexDirection: "column", flexShrink: 0 }}>

      {/* Logo */}
      <div style={{ padding: "22px 20px 18px", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontFamily: T.head, fontSize: 17, fontWeight: 800, color: T.text }}>
          ⚓ CargoDesk
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

      {/* Documents action */}
      <div style={{ padding: "10px 16px", borderBottom: `1px solid ${T.border}` }}>
        <button onClick={onDocuments} style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "8px 12px", borderRadius: 8, background: "transparent",
          border: `1px solid ${T.border}`, fontFamily: T.body, fontSize: 13,
          color: T.text, cursor: "pointer", fontWeight: 500, textAlign: "left",
          transition: "border-color .15s, background .15s",
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.background = T.accentBg; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; }}>
          📄 Documents
        </button>
      </div>

      {/* Section nav */}
      <nav style={{ padding: "14px 12px", flex: 1, overflowY: "auto" }}>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: ".12em", padding: "0 12px", marginBottom: 8 }}>
          Sections
        </div>
        {sections.map(({ id, icon, label, badge }) => (
          <button key={id} onClick={() => handleSection(id)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              width: "100%", padding: "8px 12px", borderRadius: 8,
              background: "none", border: "none", cursor: "pointer",
              fontFamily: T.body, fontSize: 13, color: T.text,
              marginBottom: 2,
            }}
            onMouseEnter={e => e.currentTarget.style.background = T.bg}
            onMouseLeave={e => e.currentTarget.style.background = "none"}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 18, textAlign: "center", fontSize: 14 }}>{icon}</span>
              <span>{label}</span>
            </span>
            {badge != null && (
              <span style={{ fontFamily: T.mono, fontSize: 11, background: T.accent + "22",
                color: T.accent, borderRadius: 10, padding: "1px 7px", fontWeight: 700 }}>
                {badge}
              </span>
            )}
          </button>
        ))}
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

  const parseHash = hash => {
    if (!hash) return { page: "home", selectedId: null };
    if (hash === "shipments/new") return { page: "shipment-new", selectedId: null };
    if (/^shipments\/[^/]+\/edit$/.test(hash)) return { page: "shipment-edit", selectedId: hash.split("/")[1] };
    if (hash.startsWith("shipments/")) return { page: "detail", selectedId: hash.split("/")[1] || null };
    if (hash.startsWith("track/")) return { page: "track", selectedId: hash.slice(6) };
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
  const [mdmOpen,      setMdmOpen]      = useState(true);
  const [orgOpen,      setOrgOpen]      = useState(true);
  const [detailAction, setDetailAction] = useState(null);
  const [user,         setUser]         = useState(null);
  const [authLoading,  setAuthLoading]  = useState(true);

  // Verify stored token on mount
  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { setAuthLoading(false); return; }
    api.auth.me()
      .then(u => { setUser(u); setAuthLoading(false); })
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
    if (userAllOffices) {
      api.offices.list()
        .then(list => {
          const active = list.filter(o => o.isActive);
          setPickerOffices(active);
          if (active.length > 0 && !activeOffice) setOfficePicker(true);
        })
        .catch(() => {});
      return;
    }
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

  const handleLogin  = (token, userData) => {
    localStorage.setItem(TOKEN_KEY, token);
    // Only clear office selection if user hasn't opted to remember it
    if (localStorage.getItem(OFFICE_REMEMBER_KEY) !== "1") {
      localStorage.removeItem(ACTIVE_OFFICE_KEY);
      localStorage.removeItem(OFFICE_DATA_KEY);
      setActiveOfficeState(null);
    }
    setUser(userData);
    setActiveRole(null);
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
  const formDirtyRef = useRef(false);
  const [formCtrListOpen,  setFormCtrListOpen]  = useState(false);
  const [formCtrModal,     setFormCtrModal]     = useState(null);
  const [newCtrSignal,     setNewCtrSignal]     = useState(0);
  const [docsOpen,         setDocsOpen]         = useState(false);

  const isFormPage = p => p === "shipment-new" || p === "shipment-edit";
  const formHash   = (p, id) => p === "shipment-new" ? "shipments/new" : `shipments/${id}/edit`;

  const navigate = (key, id = null) => {
    if (isFormPage(page) && formDirtyRef.current) {
      if (!window.confirm("You have unsaved changes. Leave and discard them?")) return;
    }
    formDirtyRef.current = false;
    if (page === "settings" && key !== "settings")
      api.settings.get().then(s => setAppSettings(s)).catch(() => {});
    setPage(key);
    setSelectedId(id);
    if (key === "shipment-new")             window.location.hash = "shipments/new";
    else if (key === "shipment-edit" && id) window.location.hash = `shipments/${id}/edit`;
    else if (key === "detail" && id)        window.location.hash = `shipments/${id}`;
    else                                    window.location.hash = key;
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
  const MDM_PAGES = ["mdm-carriers", "mdm-ports", "mdm-linked", "mdm-vessels", "mdm-commodities", "mdm-tradelanes", "mdm-countries", "mdm-unlocodes", "mdm-customers", "mdm-sanctioned-customers", "mdm-contracts"];
  const ORG_PAGES = ["org-country", "org-branch", "org-office"];
  const ALL_PAGES = [...MDM_PAGES, ...ORG_PAGES, "manual"];
  const isMdmActive = MDM_PAGES.includes(page);
  const isOrgActive = ORG_PAGES.includes(page);

  if (page === "track") return <TrackingPage token={selectedId} />;

  if (authLoading) return <FullPageSpinner />;
  if (!user)       return <LoginPage onLogin={handleLogin} />;

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
    const active = page === pageKey || (pageKey === "shipments" && (page === "detail" || page === "shipment-new" || page === "shipment-edit"));
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
    "shipment-new":     "New Shipment",
    "shipment-edit":    "Edit Shipment",
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
    "org-country":      "Organization — Countries",
    "org-branch":       "Organization — Branches",
    "org-office":       "Organization — Offices",
    schedules:          "Schedule Search",
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

    const BELL_DISMISS_KEY = "cargodesk_dismissed_bell";
    const todayStr = new Date().toISOString().split('T')[0];

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
      const remainingBell = visibleBellItems.filter(a => a.id !== id);
      if (remainingBell.length === 0 && activeSysMsgs.length === 0) setBellOpen(false);
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
    const bellCount = visibleBellItems.length + activeSysMsgs.length;

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

                {!authCtxValue.isTradeManager && <MenuItem icon="⚙" label="Application Settings" onClick={() => navigate("settings")} />}

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
      {page === "detail" && selectedShipment ? (
        <ShipmentDetailSidebar
          shipment={selectedShipment}
          ctrCount={containers.filter(c => c.shipmentId === selectedShipment.id).length}
          navigate={navigate}
          onSectionClick={setDetailAction}
          onDocuments={() => setDocsOpen(true)}
        />
      ) : page === "shipment-new" ? (
        <ShipmentFormSidebar mode="new" shipment={null} navigate={navigate} onContainers={() => setNewCtrSignal(p => p + 1)} />
      ) : page === "shipment-edit" && selectedShipment ? (
        <ShipmentFormSidebar mode="edit" shipment={selectedShipment} navigate={navigate} onContainers={() => setFormCtrListOpen(true)} />
      ) : (
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
          <nav data-testid="main-nav" style={{ padding: "14px 12px", flex: 1, overflowY: "auto" }}>

            {/* Top-level items */}
            <NavBtn pageKey="shipments" icon="⛴" label="Shipments" />

            {/* Dashboard sub-group */}
            <NavBtn pageKey="dashboard"      icon="◈"  label="Dashboard" />
            <NavBtn pageKey="space-configs"  icon="⚡" label="Space Configurations" indent />
            <NavBtn pageKey="dashboard-archive" icon="🗄" label="Archive"           indent />

            <NavBtn pageKey="kanban"    icon="📋" label="Integration Board" />
            <NavBtn pageKey="schedules" icon="🗓" label="Schedule Search" />

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
                  <NavBtn pageKey="mdm-customers"            icon="👥" label="Customers"            indent />
                  <NavBtn pageKey="mdm-sanctioned-customers" icon="🔴" label="Sanctioned Customers" subIndent />
                  <NavBtn pageKey="mdm-contracts"   icon="📋" label="Contracts"       indent />
                  <NavBtn pageKey="mdm-carriers" icon="🏢" label="Carriers"       indent />
                  <NavBtn pageKey="mdm-vessels"      icon="🚢" label="Vessels"         indent />
                  <NavBtn pageKey="mdm-commodities" icon="📦" label="Commodities"     indent />
                  <NavBtn pageKey="mdm-ports"    icon="📍" label="Port Locations" indent />
                  <NavBtn pageKey="mdm-linked"   icon="🔗" label="Linked Ports"   indent />

                  {/* Locations sub-section */}
                  <div style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: ".1em", padding: "10px 12px 3px 28px" }}>Locations</div>
                  <NavBtn pageKey="mdm-tradelanes" icon="🌊" label="Trade Lanes"         indent />
                  <NavBtn pageKey="mdm-countries" icon="🏳" label="Countries"          indent />
                  <NavBtn pageKey="mdm-unlocodes" icon="🔢" label="UN Location Codes"  indent />
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
                  <NavBtn pageKey="org-country" icon="🌍" label="Country"  indent />
                  <NavBtn pageKey="org-branch"  icon="🏛️" label="Branch"   indent />
                  <NavBtn pageKey="org-office"  icon="🏢" label="Office"   indent />
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
                for (const { id: _draftId, polName: _pn, podName: _ppn, ...leg } of draftLegs.filter(l => l.pol || l.pod)) {
                  await api.legs.create(created.id, leg);
                }
                for (const ctr of draftContainers) {
                  const newCtr = await api.containers.create({ shipmentId: created.id, ...ctr });
                  setContainers(p => [...p, newCtr]);
                }
                if (selectedSailing) {
                  await api.schedules.save(created.id, selectedSailing).catch(() => {});
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
            allocations={allocations}
            financeEnabled={appSettings.finance_view_enabled !== 'false' && (effectiveRoles.includes('admin') || !!(user?.canViewFinance))} />
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
        {page === "org-country"    && <CountryPage />}
        {page === "org-branch"     && <BranchPage />}
        {page === "org-office"     && <OfficePage />}
        {page === "schedules"      && <SchedulesPage />}
        {page === "manual"         && <UserManualPage />}
        {page === "about"          && <AboutPage />}
        {page === "license"        && <LicensePage />}
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
        shipmentId={page === "detail" ? selectedId : null}
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

      {/* ── Documents modal ── */}
      {docsOpen && selectedShipment && (
        <DocumentsModal
          shipment={selectedShipment}
          canEdit={authCtxValue.canEditShipments}
          onClose={() => setDocsOpen(false)}
        />
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
      {officePicker && (
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

      <ToastContainer />
      <GlobalSavingOverlay />
    </div>
  </AuthContext.Provider>
  );
}

export default App;