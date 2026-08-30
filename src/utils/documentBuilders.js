// ─── Document generation — pure HTML-string builders ──────────────────────────
// Extracted out of App.jsx (TKT-X14K0P, Split App.jsx's modal components) — these are plain
// functions with zero JSX, so they belong in a standalone module exactly like
// src/utils/invoiceGenerator.js already does for the same kind of thing (buildFreightInvoiceHtml,
// buildLoadingPlanHtml, etc.). This was the one thing blocking GenerateDocumentModal/DocumentsModal
// from ever moving out of App.jsx themselves — a separate component file would have needed to
// import these back from App.jsx, a circular import no other page in this codebase does.
import { fmtCurr, _esc, _invShell, partyByRole, buildFreightInvoiceHtml, buildLoadingPlanHtml } from "./invoiceGenerator";

const DOC_TYPES = [
  { code: "BL01", label: "Bill of Lading" },
  { code: "MB01", label: "Master Bill of Lading" },
  { code: "BR01", label: "Carrier Booking Request" },
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
        ...(nvocc ? [["Carrier of Record (NVOCC)", _esc(nvocc.customerName)]] : []),
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
// party; Notify Party is left "—" since the NVOCC's own destination agent isn't modeled as a
// distinct party (TKT-IB5IEX shipped the two-stage RELEASE TYPE tracking, master_bl_release_type,
// a narrower thing than an actual agent contact) and showing the House-side notify here would
// misattribute a party that has no role on this document.
const buildMasterBillOfLadingHtml = ({ shipment: sh, invNumber, invDate, notes, containers, parties, exportFilingItn }) => {
  const { w: totalWeight, v: totalVolume } = _ctrTotals(containers);
  const nvocc = partyByRole(parties, "NVOCC");
  // Co-loading (TKT-UR1X17): when this shipment's own NVOCC has no direct contract with the
  // vessel operator for this lane, it tenders cargo through another NVOCC's own tariff instead —
  // that OTHER NVOCC is who actually holds the direct Master B/L relationship with the vessel
  // operator, so it (not the primary NVOCC) is the real Shipper here. Falls back to today's
  // exact direct-NVOCC-to-vessel-operator behavior when no Co-Loading NVOCC party is assigned.
  const coload = partyByRole(parties, "Co-Loading NVOCC");
  const mblShipper = coload || nvocc;
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
        <div class="party-name">${_esc(mblShipper?.customerName || "—")}</div>
      </div>
      <div class="party"><div class="party-label">Consignee</div>
        <div class="party-name">${mblShipper ? `TO ORDER OF ${_esc(mblShipper.customerName)}` : "—"}</div>
      </div>
      <div class="party"><div class="party-label">Notify Party</div>
        <div class="party-name">—</div>
      </div>
    </div>
    <div class="shp-block"><div class="block-label">Transport Details</div>
      <div class="details-grid">${_detailGrid([
        ["Master B/L Number", _esc(sh.masterBlNumber || invNumber)],
        ["House B/L Number", _esc(sh.blNumber || "—")],
        ...(coload ? [
          ["Co-Loaded Via (Underlying NVOCC)", _esc(nvocc?.customerName || "—")],
          ["Co-Load Tariff Reference", _esc(sh.coloadTariffReference || "—")],
        ] : []),
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
        // Two-stage release (TKT-IB5IEX): the vessel operator's own release of the container to
        // the NVOCC's destination agent is a genuinely separate event from the NVOCC's later
        // release to the actual consignee (bl_release_type, on the House B/L / Delivery Order).
        ["Master B/L Release Type", _esc(sh.masterBlReleaseType || "Not yet decided")],
      ])}</div>
    </div>
    <div style="background:${["Telex Release", "Surrendered", "Seaway Bill"].includes(sh.masterBlReleaseType) ? "#f0fdf4" : "#fef2f2"};
      color:${["Telex Release", "Surrendered", "Seaway Bill"].includes(sh.masterBlReleaseType) ? "#166534" : "#991b1b"};
      border:1px solid ${["Telex Release", "Surrendered", "Seaway Bill"].includes(sh.masterBlReleaseType) ? "#bbf7d0" : "#fecaca"};
      border-radius:8px;padding:10px 14px;margin-bottom:20px;font-size:12px;font-weight:600">
      ${["Telex Release", "Surrendered", "Seaway Bill"].includes(sh.masterBlReleaseType)
        ? `Released to the NVOCC's destination agent — ${_esc(sh.masterBlReleaseType)}. The NVOCC's own release to the actual consignee (House B/L) is a separate, later event.`
        : "Not yet released to the NVOCC's destination agent — an Original Master B/L must be surrendered (or the release type above confirmed) before the NVOCC's own agent can take custody."}
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

// Carrier Booking Request (TKT — real bug report on SHP-XNLGBH: a carrier with no eAdapter
// config, e.g. CMDU here, has no EDI channel at all, so "Send Booking Request" is correctly
// disabled — but until now there was no way to produce anything to send the carrier manually
// either. Mirrors the exact field set the real EDI payload already assembles server-side
// (routes/edi.js's POST .../edi-messages/booking-request, ~lines 217-322) — equipment/DG/reefer
// summaries, the NVOCC shipper-of-record override, rate snapshot reference, export filing ITN —
// computed here client-side instead, from data GenerateDocumentModal already fetches (or, for
// the rate snapshot, one more conditional fetch added alongside it), same as every other
// buildXHtml function in this file. Available for any carrier, not just non-bookable ones — a
// paper record is harmless to also have for an EDI-bookable carrier.
const buildCarrierBookingRequestHtml = ({ shipment: sh, invNumber, invDate, notes, containers, parties, exportFilingItn, rateSnapshotId }) => {
  const nvocc = partyByRole(parties, "NVOCC");
  const equipmentByType = {};
  const dgByType = {};
  const reeferByKey = {};
  for (const c of containers) {
    const key = `${c.size}${c.type}`;
    const eq = equipmentByType[key] || (equipmentByType[key] = { type: key, count: 0, totalWeightKg: 0, totalVolumeCbm: 0 });
    eq.count += 1;
    eq.totalWeightKg += c.grossWeightKg || 0;
    eq.totalVolumeCbm += c.volumeCbm || 0;
    if (c.isDg) {
      const dg = dgByType[key] || (dgByType[key] = { type: key, dgClass: c.dgClass || "", count: 0 });
      dg.count += 1;
    }
    if (c.type === "RF" && c.setTemperatureC != null) {
      const rKey = `${key}_${c.setTemperatureC}`;
      const rf = reeferByKey[rKey] || (reeferByKey[rKey] = { type: key, setTemperatureC: c.setTemperatureC, count: 0 });
      rf.count += 1;
    }
  }

  const equipmentRows = Object.values(equipmentByType).map(e => `<tr>
        <td><span class="code">${_esc(e.type)}</span></td>
        <td class="num">${e.count}</td>
        <td class="num">${e.totalWeightKg > 0 ? e.totalWeightKg.toLocaleString() + " kg" : "—"}</td>
        <td class="num">${e.totalVolumeCbm > 0 ? e.totalVolumeCbm.toFixed(2) + " CBM" : "—"}</td>
      </tr>`).join("");

  const body = `
    <div class="parties" style="grid-template-columns:1fr 1fr 1fr">
      <div class="party"><div class="party-label">Shipper</div>
        <div class="party-name">${_esc(nvocc?.customerName || sh.shipperName || "—")}</div>
      </div>
      <div class="party"><div class="party-label">Consignee</div>
        <div class="party-name">${_esc(sh.consigneeName || "—")}</div>
      </div>
      <div class="party"><div class="party-label">Notify Party</div>
        <div class="party-name">${_esc(sh.notifyName || "—")}</div>
      </div>
    </div>
    <div class="shp-block"><div class="block-label">Booking Details</div>
      <div class="details-grid">${_detailGrid([
        ["Carrier", _esc(sh.carrierCode || "—")],
        ["Port of Loading", `${_esc(sh.pol)}${sh.polName ? " · " + _esc(sh.polName) : ""}`],
        ["Port of Discharge", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
        ...(sh.placeOfReceipt ? [["Place of Receipt", _esc(sh.placeOfReceipt)]] : []),
        ...(sh.placeOfDelivery ? [["Place of Delivery", _esc(sh.placeOfDelivery)]] : []),
        ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
        ...(sh.cargoReadyDate ? [["Cargo Ready Date", new Date(sh.cargoReadyDate).toLocaleDateString("en-GB")]] : []),
        ["Vessel", _esc(sh.vessel || "—")], ["Voyage", _esc(sh.voyage || "—")],
        ["Contract Type", _esc(sh.contractType || "—")],
        ...(sh.contractRef ? [["Contract Reference", _esc(sh.contractRef)]] : []),
        ...(rateSnapshotId ? [["Rate Snapshot", _esc(rateSnapshotId)]] : []),
        ...(sh.commodityCode ? [["Commodity Code", _esc(sh.commodityCode)]] : []),
        ...(exportFilingItn ? [["Export Filing ITN", _esc(exportFilingItn)]] : []),
      ])}</div>
    </div>
    <div class="section-label">Equipment</div>
    <table><thead><tr>
      <th>Type</th><th style="text-align:right">Count</th>
      <th style="text-align:right">Total Weight</th><th style="text-align:right">Total Volume</th>
    </tr></thead><tbody>${equipmentRows || `<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:16px">No containers recorded</td></tr>`}</tbody></table>
    ${Object.values(dgByType).length > 0 ? `
    <div class="section-label">Dangerous Goods Declaration</div>
    <table><thead><tr><th>Type</th><th>IMDG Class</th><th style="text-align:right">Count</th></tr></thead><tbody>
      ${Object.values(dgByType).map(d => `<tr><td><span class="code">${_esc(d.type)}</span></td><td>${_esc(d.dgClass || "—")}</td><td class="num">${d.count}</td></tr>`).join("")}
    </tbody></table>` : ""}
    ${Object.values(reeferByKey).length > 0 ? `
    <div class="section-label">Reefer Set-Point Declaration</div>
    <table><thead><tr><th>Type</th><th style="text-align:right">Set Temperature</th><th style="text-align:right">Count</th></tr></thead><tbody>
      ${Object.values(reeferByKey).map(r => `<tr><td><span class="code">${_esc(r.type)}</span></td><td class="num">${r.setTemperatureC}°C</td><td class="num">${r.count}</td></tr>`).join("")}
    </tbody></table>` : ""}
    ${notes ? `<div class="notes"><div class="notes-label">Notes / Special Instructions</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`Carrier Booking Request — ${invNumber}`, "CARRIER BOOKING REQUEST", invNumber, invDate, body);
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
  if (docCode === "BR01") {
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
    case "BR01":             return buildCarrierBookingRequestHtml(data);
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

export {
  DOC_TYPES, DOC_TYPE_MAP, docTypeLabel, FILE_ICON, fmtBytes, fmtDate, fmtAddrHtml,
  dispatchDocBuilder, getMissingDocRequirements,
};
