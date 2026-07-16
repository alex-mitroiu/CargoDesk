import { api } from "../api";

// ─── Invoice generation helpers ───────────────────────────────────────────────
// Extracted from App.jsx so both App.jsx (DocumentsModal / GenerateDocumentModal)
// and ShipmentAccountingInvoicesPage.jsx can generate freight invoices without a
// circular import — App.jsx imports the Invoices page, so these can't stay
// module-private consts inside App.jsx.

export const fmtCurr = (n, curr = "USD") =>
  `${curr} ${(parseFloat(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const _esc = s => String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

export const INV_CSS = `
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

export const _invShell = (title, invType, invNumber, invDate, body) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${INV_CSS}</style></head>
<body>
<button class="no-print" onclick="window.print()">🖨 Print / Save as PDF</button>
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

// `container`, when passed, scopes the invoice to that container's tagged SELL
// lines only and adds a Container row to the details grid — used for per-container
// invoice generation. Omit it for the existing whole-shipment consolidated invoice.
//
// `targetCurrency`/`fxRates`, when passed, are used ONLY if the scoped lines span more
// than one currency — the grand total is then converted (via each line's amountUsd) into
// targetCurrency and shown as a single figure instead of one "Total X" row per currency.
// Single-currency invoices are unaffected — same per-currency total as before.
export const buildFreightInvoiceHtml = ({ shipment: sh, invNumber, invDate, notes, costLines, container, targetCurrency, fxRates }) => {
  const scopedLines = container ? costLines.filter(cl => cl.containerId === container.id) : costLines;
  const distinctCurrencies = [...new Set(scopedLines.map(cl => cl.currency))];
  const isMultiCurrency = distinctCurrencies.length > 1;

  const rows = scopedLines.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:20px">No cost lines recorded for this ${container ? "container" : "shipment"}</td></tr>`
    : scopedLines.map(cl => `<tr>
        <td><span class="code">${cl.chargeCode || "—"}</span></td>
        <td>${cl.type || "—"}${cl.notes ? `<br><span style="color:#6b7280;font-size:11px">${cl.notes}</span>` : ""}</td>
        <td>${cl.currency}</td>
        <td class="num">${fmtCurr(cl.amount, cl.currency)}</td>
      </tr>`).join("");

  let totalRows;
  if (isMultiCurrency) {
    const rate = targetCurrency === "USD" ? 1 : (fxRates?.[targetCurrency] || 1);
    const grandTotal = scopedLines.reduce((s, cl) => s + (cl.amountUsd || 0), 0) * rate;
    totalRows = `<div class="total-row grand"><span class="total-label">Grand Total (${targetCurrency})</span><span class="total-amt">${fmtCurr(grandTotal, targetCurrency)}</span></div>
      <div style="font-size:10px;color:#9ca3af;margin-top:4px;text-align:right">Converted from multiple currencies (${distinctCurrencies.join(", ")}) to ${targetCurrency}</div>`;
  } else {
    const totals = {};
    for (const cl of scopedLines) totals[cl.currency] = (totals[cl.currency] || 0) + (parseFloat(cl.amount) || 0);
    totalRows = Object.entries(totals).map(([c, a]) =>
      `<div class="total-row"><span class="total-label">Total ${c}</span><span class="total-amt">${fmtCurr(a, c)}</span></div>`).join("") ||
      `<div class="total-row"><span class="total-label">Total</span><span class="total-amt">—</span></div>`;
  }

  const detailItems = [
    ["Shipment ID", sh.id],
    ...(container ? [["Container", container.containerNumber || `(${container.size || ""}${container.type || ""})`]] : []),
    ["B/L Number", sh.blNumber || "—"], ["Booking Ref", sh.bookingRef || "—"],
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

  const invType       = container ? "FREIGHT INVOICE — PER CONTAINER" : "FREIGHT INVOICE";
  const displayNumber = container ? `${invNumber}-${container.containerNumber || container.id}` : invNumber;
  return _invShell(`Freight Invoice — ${displayNumber}`, invType, displayNumber, invDate, body);
};

// Resolves which currency to use for the grand total when a generated invoice's charge
// lines span multiple currencies. Reads the shipment's Principal customer profile — falls
// back to USD (flagged via isFallback) when no Principal is set, since there's nothing to
// resolve a currency from in that case.
export async function resolveInvoiceCurrency(shipment) {
  if (!shipment.principalId) {
    return { currency: "USD", isFallback: true, principalName: shipment.principalName || "" };
  }
  try {
    const customer = await api.customers.get(shipment.principalId);
    return { currency: customer.currency || "USD", isFallback: false, principalName: customer.companyName || shipment.principalName || "" };
  } catch {
    return { currency: "USD", isFallback: true, principalName: shipment.principalName || "" };
  }
}

// Generates + persists freight invoice document(s) for a shipment: either one
// consolidated invoice over all SELL cost lines, or one per container (only for
// containers with at least one SELL line tagged to them via CostLineForm's
// container field). Returns the created shipment_documents rows (mapDoc shape).
//
// `targetCurrency`/`fxRates` are only consulted when the relevant SELL lines span more
// than one currency — see buildFreightInvoiceHtml. Resolve targetCurrency up front via
// resolveInvoiceCurrency() and fxRates via api.fx.rates() before calling this, since the
// caller is expected to confirm the conversion with the user first when it applies.
export async function generateInvoices(shipment, { containers = [], costLines, splitPerContainer = false, targetCurrency = "USD", fxRates = {} }) {
  const sellLines         = costLines.filter(cl => cl.type === "SELL");
  const responsibleParty  = shipment.principalName || shipment.consigneeName || "";
  const now               = new Date();
  const invDate           = now.toISOString().slice(0, 10);
  const baseNumber        = `${shipment.id}-${now.getTime().toString(36).toUpperCase().slice(-6)}`;

  // Regenerating while a still-draft invoice of the same scope (consolidated, or a given
  // container) already exists REPLACES it, rather than piling up a new duplicate every time
  // a charge line is added/edited during the same editing pass. A CONFIRMED invoice is left
  // alone — that's the record of what was actually sent to the client — regenerating over it
  // creates a fresh document instead of silently rewriting something already issued.
  const existingDocs = await api.documents.list(shipment.id)
    .then(rows => rows.filter(d => d.docType === "FR01" || d.docType === "FR02"))
    .catch(() => []);
  const replaceDraftIfAny = async containerId => {
    const existing = existingDocs.find(d => (d.containerId || "") === containerId && d.status !== "confirmed");
    if (existing) await api.documents.remove(existing.id).catch(() => {});
  };

  const upload = (html, filename, containerId) =>
    api.documents.upload(shipment.id, {
      filename, mimeType: "text/html", docType: "FR01",
      data: btoa(unescape(encodeURIComponent(html))),
      containerId, responsibleParty,
    });

  if (!splitPerContainer) {
    await replaceDraftIfAny("");
    const html  = buildFreightInvoiceHtml({ shipment, invNumber: baseNumber, invDate, notes: "", costLines: sellLines, targetCurrency, fxRates });
    const saved = await upload(html, `FR01-${baseNumber}-${invDate}.html`, "");
    return [saved];
  }

  const targets = containers.filter(c => sellLines.some(cl => cl.containerId === c.id));
  if (targets.length === 0) {
    throw new Error("No Invoice Entry lines are tagged to a container yet — tag at least one line first.");
  }
  const results = [];
  for (const container of targets) {
    await replaceDraftIfAny(container.id);
    const html  = buildFreightInvoiceHtml({ shipment, invNumber: baseNumber, invDate, notes: "", costLines: sellLines, container, targetCurrency, fxRates });
    const label = container.containerNumber || container.id;
    const saved = await upload(html, `FR01-${baseNumber}-${label}-${invDate}.html`, container.id);
    results.push(saved);
  }
  return results;
}
