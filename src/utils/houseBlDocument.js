// Builds the House B/L (BL01) PDF's HTML: shared by Generate Document and the House B/L panel
// (Epic TKT-C7EBU3). Besides the builder's usual data it gathers the notify party, the issuing office
// and legal entity, the carriage and the selling charges (GET /api/shipments/:id/house-bl), and what
// this copy says: the `houseBl` statement that goes to the server with the PDF — loading, originals,
// copies, with or without charges — which the server checks (lib/house-bl.js draftStatement).
import { api } from "../api";
import { getMissingDocRequirements, dispatchDocBuilder } from "./documentBuilders";
import { renderTemplateHtml } from "./templateRenderer";

// choice "onboard" | "received"; a typed on-board date wins over the Loaded event. `counts` adds the
// originals, copies and charges chosen for this copy ({ originals, copies, withCharges }, gap G12/G14).
export const houseBlStatement = (choice, facts, typedDate, counts = {}) => ({
  ...(choice === "received" ? { shippedOnBoard: false }
    : typedDate ? { shippedOnBoard: true, onBoardDate: typedDate, onBoardDateTyped: true }
      : { shippedOnBoard: true, onBoardDate: facts?.onBoardDate || null }),
  ...(counts.originals !== undefined && counts.originals !== "" && { originals: Number(counts.originals) }),
  ...(counts.copies !== undefined && counts.copies !== "" && { copies: Number(counts.copies) }),
  ...(counts.withCharges !== undefined && { withCharges: !!counts.withCharges }),
});

// The B/L number the copy prints (gap G5): the shipment's (typed, or taken from the office series), the
// version an amendment replaces, the draft's. "" = not taken yet: the copy says "assigned at issue",
// and the panel takes the number (POST …/house-bl/number) before it prints the copy it issues.
export const houseBlNumber = (shipment, summary) =>
  shipment.blNumber || summary?.readiness?.number?.value || summary?.amends?.reference || summary?.draft?.reference || "";

// → { html, filename, houseBl } or { missing: [...] } when the builder's own minimum isn't there.
export async function buildHouseBlHtml(shipment, { docNum, docDate, notes = "", statement, signatory = "", summary = null }) {
  const [ctrsRaw, shipper, consignee, notify, parties, filings, house] = await Promise.all([
    api.containers.list(),
    shipment.shipperId   ? api.customers.get(shipment.shipperId).catch(() => null)   : Promise.resolve(null),
    shipment.consigneeId ? api.customers.get(shipment.consigneeId).catch(() => null) : Promise.resolve(null),
    shipment.notifyId    ? api.customers.get(shipment.notifyId).catch(() => null)    : Promise.resolve(null),
    api.shipmentParties.list(shipment.id).catch(() => []),
    api.customsFilings.list(shipment.id).catch(() => []),
    summary ? Promise.resolve(summary) : api.houseBl.get(shipment.id).catch(() => null),
  ]);
  const allCtrs = Array.isArray(ctrsRaw) ? ctrsRaw : (ctrsRaw?.results ?? []);
  const containers = allCtrs.filter(c => c.shipmentId === shipment.id);
  const exportFilingItn = filings.find(f => f.filingType === "AES_EEI" && f.status === "Accepted")?.confirmationNumber || null;
  const houseBl = { ...statement, ...(statement?.shippedOnBoard === false && { receivedDate: house?.onBoard?.receivedDate || null }) };
  const issuer = house?.issuer ? { ...house.issuer, signatory } : (signatory ? { signatory } : null);
  // An amendment prints its version and the date of the B/L it replaces (gap G6).
  const amends = house?.amends || null;
  const version = amends ? amends.version + 1 : (house?.draft?.version || 1);
  const dataBag = { shipment, invNumber: docNum, invDate: docDate, notes, containers, shipper, consignee, notify, parties, exportFilingItn, houseBl, issuer,
    routing: house?.routing || null, charges: house?.charges || [], version, amendsIssueDate: amends?.issueDate || null };

  // Document Template Editor — an office+carrier layout replaces the built-in one (BL01 pilot).
  const template = await api.documentTemplates.resolve("BL01", shipment.emoOfficeId || "", shipment.carrierCode || "").catch(() => null);
  let html;
  if (template) html = renderTemplateHtml(template, dataBag);
  else {
    const missing = getMissingDocRequirements("BL01", { shipment, containers, shipper, consignee, parties });
    if (missing.length) return { missing };
    html = dispatchDocBuilder("BL01", dataBag);
  }
  const { receivedDate, ...claim } = houseBl;
  return { html, filename: `BL01-${docNum || "DRAFT"}-${docDate}.pdf`, houseBl: claim };
}
