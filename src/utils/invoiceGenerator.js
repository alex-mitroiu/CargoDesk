import { api } from "../api";

// ─── Invoice generation helpers ───────────────────────────────────────────────
// Extracted from App.jsx so both App.jsx (DocumentsModal / GenerateDocumentModal)
// and ShipmentAccountingInvoicesPage.jsx can generate freight invoices without a
// circular import — App.jsx imports the Invoices page, so these can't stay
// module-private consts inside App.jsx.

export const fmtCurr = (n, curr = "USD") =>
  `${curr} ${(parseFloat(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const _esc = s => String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

// Looks up an Additional Party (Epic TKT-5XFCAP) by role on a shipment's parties list.
// Additive/optional everywhere it's used — a missing role just means no matching party,
// never an error.
export const partyByRole = (parties, role) => (parties || []).find(p => p.role === role) || null;

// A cost line's own VAT amount in ITS OWN currency (not vatAmountUsd, the USD-converted figure
// mapCostLine also computes server-side — showing that here would mislabel a non-USD line's VAT
// with the wrong currency symbol). Shared by buildFreightInvoiceHtml and
// buildCreditDebitNoteHtml — both previously omitted VAT from the actual generated document
// entirely, even on a line with a real, non-zero vatRate: ShipmentAccountingInvoicesPage.jsx's
// own summary bar always computed and displayed VAT correctly, but that total was never
// carried into the signed PDF an operator actually sends a customer.
const lineVatAmount = cl => (parseFloat(cl.amount) || 0) * ((cl.vatRate || 0) / 100);

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
    ? `<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:20px">No cost lines recorded for this ${container ? "container" : "shipment"}</td></tr>`
    : scopedLines.map(cl => `<tr>
        <td><span class="code">${cl.chargeCode || "—"}</span></td>
        <td>${cl.type || "—"}${cl.notes ? `<br><span style="color:#6b7280;font-size:11px">${cl.notes}</span>` : ""}</td>
        <td>${cl.currency}</td>
        <td class="num">${fmtCurr(cl.amount, cl.currency)}</td>
        <td class="num">${cl.vatRate ? `${fmtCurr(lineVatAmount(cl), cl.currency)}<br><span style="color:#9ca3af;font-size:10px">${cl.vatRate}%</span>` : "—"}</td>
      </tr>`).join("");

  let totalRows;
  if (isMultiCurrency) {
    const rate = targetCurrency === "USD" ? 1 : (fxRates?.[targetCurrency] || 1);
    const subtotal  = scopedLines.reduce((s, cl) => s + (cl.amountUsd || 0), 0) * rate;
    const vatTotal  = scopedLines.reduce((s, cl) => s + (cl.vatAmountUsd || 0), 0) * rate;
    const grandTotal = subtotal + vatTotal;
    totalRows = (vatTotal > 0
      ? `<div class="total-row"><span class="total-label">Subtotal (${targetCurrency})</span><span class="total-amt">${fmtCurr(subtotal, targetCurrency)}</span></div>
         <div class="total-row"><span class="total-label">VAT (${targetCurrency})</span><span class="total-amt">${fmtCurr(vatTotal, targetCurrency)}</span></div>
         <div class="total-row grand"><span class="total-label">Grand Total (${targetCurrency}, incl. VAT)</span><span class="total-amt">${fmtCurr(grandTotal, targetCurrency)}</span></div>`
      : `<div class="total-row grand"><span class="total-label">Grand Total (${targetCurrency})</span><span class="total-amt">${fmtCurr(grandTotal, targetCurrency)}</span></div>`)
      + `<div style="font-size:10px;color:#9ca3af;margin-top:4px;text-align:right">Converted from multiple currencies (${distinctCurrencies.join(", ")}) to ${targetCurrency}</div>`;
  } else {
    // Grouped per currency (single-currency branch can still see >1 group only if scopedLines
    // is empty, in which case the fallback "—" row below applies) — a group with no VAT on any
    // of its lines collapses to the original plain Total row, byte-identical to before this fix.
    const grouped = {};
    for (const cl of scopedLines) {
      const c = cl.currency;
      if (!grouped[c]) grouped[c] = { amount: 0, vat: 0 };
      const amt = parseFloat(cl.amount) || 0;
      grouped[c].amount += amt;
      grouped[c].vat += lineVatAmount(cl);
    }
    totalRows = Object.entries(grouped).map(([c, { amount, vat }]) => vat > 0
      ? `<div class="total-row"><span class="total-label">Subtotal ${c}</span><span class="total-amt">${fmtCurr(amount, c)}</span></div>
         <div class="total-row"><span class="total-label">VAT ${c}</span><span class="total-amt">${fmtCurr(vat, c)}</span></div>
         <div class="total-row grand"><span class="total-label">Total ${c} (incl. VAT)</span><span class="total-amt">${fmtCurr(amount + vat, c)}</span></div>`
      : `<div class="total-row"><span class="total-label">Total ${c}</span><span class="total-amt">${fmtCurr(amount, c)}</span></div>`
    ).join("") || `<div class="total-row"><span class="total-label">Total</span><span class="total-amt">—</span></div>`;
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
    <table><thead><tr><th>Code</th><th>Type / Description</th><th>Currency</th><th style="text-align:right">Amount</th><th style="text-align:right">VAT</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="totals">${totalRows}</div>
    ${notes ? `<div class="notes"><div class="notes-label">Notes</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  const invType       = container ? "FREIGHT INVOICE — PER CONTAINER" : "FREIGHT INVOICE";
  const displayNumber = container ? `${invNumber}-${container.containerNumber || container.id}` : invNumber;
  return _invShell(`Freight Invoice — ${displayNumber}`, invType, displayNumber, invDate, body);
};

// Builds the produced "Loading Plan" (LP01) / "Unloading Plan" (UP01) document from the
// per-container structured data (Epic TKT-TBS7QD / TKT-X3SA2E, reused for Unloading — same
// per-container date/time-plan shape for both directions) — one row per container with its
// planned date, merged against the shipment's current container list so a container with no
// plan line yet still shows (blank date) rather than being silently omitted. Lives here (not
// App.jsx) for the same reason buildFreightInvoiceHtml does — the dedicated Loading/Unloading
// Service page (src/pages/LoadingServicePage.jsx) needs to call it too, and App.jsx imports
// that page, so a circular import isn't possible the other way around. Usable both from that
// dedicated page (passes real loadingPlanLines) and the generic Documents "⚡ Generate" picker
// in App.jsx (passes containers only — blank dates, a starting template).
export const buildLoadingPlanHtml = ({ shipment: sh, invNumber, invDate, notes, side = "Export", planLabel = "Loading Plan", containers = [], loadingPlanLines = [], parties = [] }) => {
  // Trucker (Epic TKT-5XFCAP) — additive only. Loading/Unloading Plans have no trucker
  // role (truckerRole stays null, so this section renders byte-identical to before this
  // epic); Pickup/Delivery Plans surface the matching Trucker party when one is assigned.
  const truckerRole = planLabel === "Pickup Plan" ? "Trucker (Pre-carriage)"
                     : planLabel === "Delivery Plan" ? "Trucker (On-carriage)" : null;
  const trucker = truckerRole ? partyByRole(parties, truckerRole) : null;
  const lineByContainer = Object.fromEntries(loadingPlanLines.map(l => [l.containerId, l]));
  const sortedContainers = [...containers].sort((a, b) => {
    const la = lineByContainer[a.id], lb = lineByContainer[b.id];
    const sa = la?.sequenceOrder ?? 0, sb = lb?.sequenceOrder ?? 0;
    return sa - sb || String(a.containerNumber || "").localeCompare(String(b.containerNumber || ""));
  });

  const rows = sortedContainers.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:16px">No containers recorded</td></tr>`
    : sortedContainers.map(c => {
        const line = lineByContainer[c.id];
        // plannedDate is "YYYY-MM-DDTHH:mm" (date + time, see DatePicker's withTime) — older
        // date-only values ("YYYY-MM-DD", 10 chars) still render fine, just with no time shown.
        const dateCell = line?.plannedDate
          ? (line.plannedDate.length > 10
              ? new Date(line.plannedDate).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
              : new Date(line.plannedDate + "T00:00:00").toLocaleDateString("en-GB"))
          : `<span style="color:#dc2626">Not yet planned</span>`;
        return `<tr>
          <td><span class="code">${_esc(c.containerNumber || "TBC")}</span></td>
          <td>${_esc(c.size)}ft ${_esc(c.type)}</td>
          <td class="num">${line?.sequenceOrder ?? "—"}</td>
          <td>${dateCell}</td>
          <td>${_esc(line?.notes || "—")}</td>
        </tr>`;
      }).join("");

  const detailItems = [
    ["Shipment ID", sh.id],
    ["Carrier", _esc(sh.carrierCode || "—")],
    ["Vessel / Voyage", [sh.vessel, sh.voyage].filter(Boolean).map(_esc).join(" / ") || "—"],
    ["Origin (POL)", `${_esc(sh.pol)}${sh.polName ? " · " + _esc(sh.polName) : ""}`],
    ["Destination (POD)", `${_esc(sh.pod)}${sh.podName ? " · " + _esc(sh.podName) : ""}`],
    ["ETD", sh.etd ? new Date(sh.etd).toLocaleDateString("en-GB") : "—"],
    ...(trucker ? [["Trucker", _esc(trucker.customerName)]] : []),
  ].map(([k, v]) => `<div><div class="detail-key">${k}</div><div class="detail-val">${v}</div></div>`).join("");

  const body = `
    <div class="shp-block"><div class="block-label">${_esc(side)} ${_esc(planLabel.replace(" Plan", ""))} — Shipment Reference</div>
      <div class="details-grid">${detailItems}</div>
    </div>
    <div class="section-label">Container ${_esc(planLabel)}</div>
    <table><thead><tr>
      <th>Container #</th><th>Type</th><th style="text-align:right">Sequence</th><th>Planned Date & Time</th><th>Notes</th>
    </tr></thead><tbody>${rows}</tbody></table>
    ${notes ? `<div class="notes"><div class="notes-label">Notes</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  return _invShell(`${planLabel} — ${invNumber}`, planLabel.toUpperCase(), invNumber, invDate, body);
};

// Generic produced document for every ordered service type without a bespoke page (i.e.
// everything except Loading/Unloading — see BESPOKE_SERVICE_TYPES in shipmentServicePages.js).
// Deliberately not tailored per type: a vendor/status/dates recap plus whatever free-text
// detail was entered on GenericServicePage.jsx's Details field (the same shipment_services.notes
// column ServicesPanel shows, just with more room to write). Saved under the catch-all "OT"
// (Other) doc type rather than inventing a new tracked type per service type, which would
// either collide across services sharing one global doc-type slot or require statically
// pre-registering many more rows on every shipment's Documents page regardless of relevance.
export const buildGenericServiceDocHtml = ({ shipment: sh, invNumber, invDate, side, serviceType, service }) => {
  const detailItems = [
    ["Shipment ID", sh.id],
    ["Service", `${_esc(side)} · ${_esc(serviceType)}`],
    ["Vendor", _esc(service?.vendorName || "—")],
    ["Status", _esc(service?.status || "—")],
    ["Requested Date", _esc(service?.requestedDate || "—")],
    ["Confirmed Date", _esc(service?.confirmedDate || "—")],
    ["Completed Date", _esc(service?.completedDate || "—")],
  ].map(([k, v]) => `<div><div class="detail-key">${k}</div><div class="detail-val">${v}</div></div>`).join("");

  const body = `
    <div class="shp-block"><div class="block-label">Service Summary</div>
      <div class="details-grid">${detailItems}</div>
    </div>
    ${service?.notes ? `<div class="notes"><div class="notes-label">Details</div><div class="notes-text">${_esc(service.notes)}</div></div>`
      : `<div style="background:#f9fafb;border:2px dashed #d1d5db;border-radius:8px;padding:40px;text-align:center;color:#9ca3af;font-size:12px">No details entered yet</div>`}`;

  const label = `${side} · ${serviceType} Service`;
  return _invShell(`${label} — ${invNumber}`, label.toUpperCase(), invNumber, invDate, body);
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

// Organization Model Enhancement Epic 2 (Credit Control) — resolves whether generating a NEW
// invoice for this shipment should be hard-blocked (any of Shipper/Consignee/Principal, or the
// linked contract's Named Account, is on credit_hold) or should carry a soft over-limit warning.
// `newAmountUsd` is the dollar total of THIS generation action (the caller already knows it —
// scoped by splitPerContainer, same as the currency check right after this one) — overLimit is
// deliberately computed as outstandingAr + newAmountUsd > creditLimit, not just outstandingAr
// alone: checking only prior confirmed invoices would never catch the very FIRST invoice that
// actually pushes a customer over their limit, only ones generated after they're already over.
// Mirrors resolveInvoiceCurrency's shape: resolve up front, let the caller decide how to present
// it, rather than baking UI decisions into this helper.
export async function resolveCreditGate(shipment, newAmountUsd = 0) {
  const candidates = [];
  if (shipment.shipperId)   candidates.push({ id: shipment.shipperId,   role: "Shipper" });
  if (shipment.consigneeId) candidates.push({ id: shipment.consigneeId, role: "Consignee" });
  if (shipment.principalId) candidates.push({ id: shipment.principalId, role: "Principal" });
  if (shipment.contractId) {
    try {
      const contract = await api.contracts.get(shipment.contractId);
      if (contract.namedAccountId) candidates.push({ id: contract.namedAccountId, role: "Contract Named Account" });
    } catch { /* no contract, or it has no named account — not a blocker either way */ }
  }
  // Dedup by customer id — a customer very often fills more than one role (e.g. Principal and
  // the contract's own Named Account are commonly the same company).
  const seen = new Set();
  const unique = candidates.filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  const resolved = (await Promise.all(unique.map(async c => {
    try { return { ...c, status: await api.customers.creditStatus(c.id) }; }
    catch { return null; }
  }))).filter(Boolean);

  const holds = resolved
    .filter(r => r.status.creditHold)
    .map(r => ({ role: r.role, companyName: r.status.companyName, reason: r.status.creditHoldReason }));

  // Same principal-then-consignee precedence generateInvoices() itself already uses for
  // responsibleParty — the AR warning is scoped to whoever is actually being billed.
  const respId = shipment.principalId || shipment.consigneeId || null;
  const respStatus = respId ? resolved.find(r => r.id === respId)?.status : null;
  const projectedAr = respStatus ? Math.round((respStatus.outstandingAr + newAmountUsd) * 100) / 100 : 0;
  const overLimit = respStatus?.creditLimit != null && projectedAr > respStatus.creditLimit;

  return {
    blocked: holds.length > 0,
    holds,
    overLimit,
    responsibleParty: respStatus
      ? { companyName: respStatus.companyName, creditLimit: respStatus.creditLimit, outstandingAr: respStatus.outstandingAr, projectedAr }
      : null,
  };
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
  // Automated charge-code registry (TKT-OK5H34): when splitting per container, any active
  // charge-code definition whose trigger is 'per_container_split' gets auto-injected as a
  // SELL cost line for every container that doesn't already have one from that definition —
  // e.g. a $10/container "Containerized Invoicing" fee. This runs before sellLines/targets
  // are computed below so a container whose only charge is the automated one still gets its
  // own invoice, matching "5 containers -> 5 invoices" even with no manual lines tagged yet.
  let workingLines = costLines;
  if (splitPerContainer && containers.length > 0) {
    const defs = await api.chargeCodes.list().catch(() => []);
    const triggered = defs.filter(d => d.isActive && d.trigger === "per_container_split");
    for (const def of triggered) {
      for (const container of containers) {
        const already = workingLines.some(cl => cl.type === "SELL" && cl.containerId === container.id
          && cl.source === "automated" && cl.chargeCode === def.label);
        if (already) continue;
        const created = await api.costLines.create(shipment.id, {
          type: "SELL", chargeCode: def.label, currency: def.currency,
          amount: def.amount, exchangeRate: 1, vatRate: 0, notes: "",
          containerId: container.id, source: "automated",
        });
        workingLines = [...workingLines, created];
      }
    }
  }

  const sellLines         = workingLines.filter(cl => cl.type === "SELL");
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

  const upload = (html, filename, containerId, sourceCostLineIds) =>
    api.documents.generate(shipment.id, {
      html, filename, docType: "FR01",
      containerId, responsibleParty, sourceCostLineIds,
    });

  if (!splitPerContainer) {
    await replaceDraftIfAny("");
    const html  = buildFreightInvoiceHtml({ shipment, invNumber: baseNumber, invDate, notes: "", costLines: sellLines, targetCurrency, fxRates });
    const saved = await upload(html, `FR01-${baseNumber}-${invDate}.pdf`, "", sellLines.map(l => l.id));
    return [saved];
  }

  const targets = containers.filter(c => sellLines.some(cl => cl.containerId === c.id));
  if (targets.length === 0) {
    throw new Error("No Invoice Entry lines are tagged to a container yet — tag at least one line first.");
  }
  const results = [];
  for (const container of targets) {
    await replaceDraftIfAny(container.id);
    const scopedLines = sellLines.filter(cl => cl.containerId === container.id);
    const html  = buildFreightInvoiceHtml({ shipment, invNumber: baseNumber, invDate, notes: "", costLines: sellLines, container, targetCurrency, fxRates });
    const label = container.containerNumber || container.id;
    const saved = await upload(html, `FR01-${baseNumber}-${label}-${invDate}.pdf`, container.id, scopedLines.map(l => l.id));
    results.push(saved);
  }
  return results;
}

// Builds the produced Credit / Debit Note (CN01) document for an invoice reversal
// (TKT-DUADU3) — modeled directly on buildFreightInvoiceHtml (same details-grid/charges-table/
// totals shape via _invShell) with two differences: the title reads as a credit/debit note, and
// the body calls out which original invoice it reverses. `costLines` here is already the exact
// (negative-amount) reversal set the backend created — no further container filtering needed.
export const buildCreditDebitNoteHtml = ({ shipment: sh, invNumber, invDate, notes, costLines, container, originalDoc }) => {
  // Reversal lines carry negative amounts (they're crediting the original charge back) —
  // lineVatAmount(cl) = amount * vatRate/100 stays correctly negative for them too, no special
  // casing needed; the VAT being reversed shows as a negative figure, same sign as the charge.
  const rows = costLines.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:20px">No reversal lines</td></tr>`
    : costLines.map(cl => `<tr>
        <td><span class="code">${cl.chargeCode || "—"}</span></td>
        <td>${cl.type || "—"}${cl.notes ? `<br><span style="color:#6b7280;font-size:11px">${cl.notes}</span>` : ""}</td>
        <td>${cl.currency}</td>
        <td class="num">${fmtCurr(cl.amount, cl.currency)}</td>
        <td class="num">${cl.vatRate ? `${fmtCurr(lineVatAmount(cl), cl.currency)}<br><span style="color:#9ca3af;font-size:10px">${cl.vatRate}%</span>` : "—"}</td>
      </tr>`).join("");

  const grouped = {};
  for (const cl of costLines) {
    const c = cl.currency;
    if (!grouped[c]) grouped[c] = { amount: 0, vat: 0 };
    grouped[c].amount += parseFloat(cl.amount) || 0;
    grouped[c].vat += lineVatAmount(cl);
  }
  const totalRows = Object.entries(grouped).map(([c, { amount, vat }]) => vat !== 0
    ? `<div class="total-row"><span class="total-label">Subtotal ${c}</span><span class="total-amt">${fmtCurr(amount, c)}</span></div>
       <div class="total-row"><span class="total-label">VAT ${c}</span><span class="total-amt">${fmtCurr(vat, c)}</span></div>
       <div class="total-row grand"><span class="total-label">Total ${c} (incl. VAT)</span><span class="total-amt">${fmtCurr(amount + vat, c)}</span></div>`
    : `<div class="total-row grand"><span class="total-label">Total ${c}</span><span class="total-amt">${fmtCurr(amount, c)}</span></div>`
  ).join("") || `<div class="total-row grand"><span class="total-label">Total</span><span class="total-amt">—</span></div>`;

  const detailItems = [
    ["Shipment ID", sh.id],
    ...(container ? [["Container", container.containerNumber || `(${container.size || ""}${container.type || ""})`]] : []),
    ["Reverses Invoice", originalDoc?.filename || "—"],
    ["Original Issue Date", originalDoc?.createdAt ? new Date(originalDoc.createdAt).toLocaleDateString("en-GB") : "—"],
    ["B/L Number", sh.blNumber || "—"], ["Booking Ref", sh.bookingRef || "—"],
  ].map(([k, v]) => `<div><div class="detail-key">${k}</div><div class="detail-val">${v}</div></div>`).join("");

  const body = `
    <div class="parties">
      <div class="party"><div class="party-label">Shipper / Exporter</div><div class="party-name">${sh.shipperName || "—"}</div></div>
      <div class="party"><div class="party-label">Consignee / Bill To</div><div class="party-name">${sh.consigneeName || "—"}</div></div>
    </div>
    <div class="shp-block"><div class="block-label">Shipment Details</div><div class="details-grid">${detailItems}</div></div>
    <div class="section-label">Reversed Charges</div>
    <table><thead><tr><th>Code</th><th>Type / Description</th><th>Currency</th><th style="text-align:right">Amount</th><th style="text-align:right">VAT</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="totals">${totalRows}</div>
    ${notes ? `<div class="notes"><div class="notes-label">Reason</div><div class="notes-text">${_esc(notes)}</div></div>` : ""}`;

  const displayNumber = container ? `${invNumber}-${container.containerNumber || container.id}` : invNumber;
  return _invShell(`Credit / Debit Note — ${displayNumber}`, "CREDIT / DEBIT NOTE", displayNumber, invDate, body);
};
