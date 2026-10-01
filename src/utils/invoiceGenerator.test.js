import { describe, it, expect } from "vitest";
import { buildFreightInvoiceHtml, buildCreditDebitNoteHtml, buildStatementHtml } from "./invoiceGenerator";

// Tax handling (2026-09-29) — the invoice/credit-note HTML is built in the browser, so these are
// the only automated checks on what actually lands in the signed PDF a customer receives.

const shipment = { id: "SHP-TEST01", pol: "GBFXT", pod: "USNYC", shipperName: "Shipper Co", consigneeName: "Consignee Co" };
const line = (over = {}) => ({ chargeCode: "Ocean Freight", type: "SELL", currency: "USD", amount: 1000, vatRate: 0, vatTreatment: "standard", ...over });
const taxInfo = { supplierName: "CargoDesk UK Ltd", supplierTaxNumber: "GB123456789", customerName: "Acme Freight", customerTaxNumber: "NL999999999B01" };
const build = (costLines, extra = {}) =>
  buildFreightInvoiceHtml({ shipment, invNumber: "INV-1", invDate: "2026-09-29", notes: "", costLines, ...extra });

describe("freight invoice — tax details", () => {
  it("prints both the supplier's and the customer's VAT numbers when known", () => {
    const html = build([line()], { taxInfo });
    expect(html).toContain("Tax Details");
    expect(html).toContain("GB123456789");
    expect(html).toContain("CargoDesk UK Ltd");
    expect(html).toContain("NL999999999B01");
  });

  it("leaves the block out entirely when neither number is known — the old document, unchanged", () => {
    expect(build([line()])).not.toContain("Tax Details");
    expect(build([line()], { taxInfo: { supplierTaxNumber: "", customerTaxNumber: "" } })).not.toContain("Tax Details");
  });

  it("prints just the supplier line when only that number is known", () => {
    const html = build([line()], { taxInfo: { ...taxInfo, customerTaxNumber: "" } });
    expect(html).toContain("GB123456789");
    expect(html).not.toContain("Customer VAT");
  });
});

describe("freight invoice — VAT treatment", () => {
  it("shows the VAT amount and rate on a standard-rated line", () => {
    const html = build([line({ vatRate: 20 })]);
    expect(html).toContain("USD 200.00");
    expect(html).toContain("20%");
  });

  it("labels zero-rated, reverse-charged and exempt lines instead of a bare dash", () => {
    const html = build([line({ vatTreatment: "zero_rated" }), line({ vatTreatment: "reverse_charge" }), line({ vatTreatment: "exempt" })]);
    expect(html).toContain("Zero-rated");
    expect(html).toContain("Reverse charge");
    expect(html).toContain("Exempt");
  });

  it("adds the reverse-charge legal note only when a line is reverse-charged", () => {
    expect(build([line({ vatTreatment: "reverse_charge" })])).toContain("to be accounted for by the customer");
    expect(build([line({ vatTreatment: "zero_rated" })])).not.toContain("to be accounted for by the customer");
    expect(build([line({ vatRate: 20 })])).not.toContain("to be accounted for by the customer");
  });

  it("scopes the note to the container being invoiced on a per-container split", () => {
    const lines = [line({ containerId: "C1" }), line({ containerId: "C2", vatTreatment: "reverse_charge" })];
    expect(build(lines, { container: { id: "C1", containerNumber: "MSKU1" } })).not.toContain("to be accounted for by the customer");
    expect(build(lines, { container: { id: "C2", containerNumber: "MSKU2" } })).toContain("to be accounted for by the customer");
  });

  it("escapes a tax number rather than rendering it as markup", () => {
    const html = build([line()], { taxInfo: { ...taxInfo, supplierTaxNumber: "<b>GB1</b>" } });
    expect(html).toContain("&lt;b&gt;GB1&lt;/b&gt;");
  });
});

describe("credit/debit note — same tax treatment as the invoice it reverses", () => {
  it("carries the tax details and the reverse-charge note", () => {
    const html = buildCreditDebitNoteHtml({
      shipment, invNumber: "INV-1-CN", invDate: "2026-09-29", notes: "Duplicate",
      costLines: [line({ amount: -300, vatTreatment: "reverse_charge" })], originalDoc: { filename: "FR01.pdf" }, taxInfo,
    });
    expect(html).toContain("GB123456789");
    expect(html).toContain("Reverse charge");
    expect(html).toContain("to be accounted for by the customer");
  });
});

// Statements carry VAT (TKT-1E55AR). On a statement the three amounts go Gross, VAT, Net — per
// line, in the VAT summary and in the totals (the user's convention for statements, 2026-09-30).
describe("customer statement — VAT, Gross / VAT / Net", () => {
  const sLine = (over = {}) => ({ shipmentId: "SHP-PZ9IJI", chargeCode: "DOC", notes: "Documentation", currency: "USD", amount: 400, vatRate: 21, vatTreatment: "standard", ...over });
  const buildStmt = (lines, extra = {}) => buildStatementHtml({
    customerName: "Atlantic Trading Corp", entityName: "Rotterdam Branch", dateFrom: "2026-09-01", dateTo: "2026-10-31",
    invNumber: "STMT-1", invDate: "2026-11-01", currency: "USD", lines, ...extra });
  const order = (html, ...words) => words.map(w => html.indexOf(w));

  it("orders each line's columns Gross, VAT, Net", () => {
    const html = buildStmt([sLine()]);
    const [g, v, n] = order(html, ">Gross<", ">VAT<", ">Net<");
    expect(g).toBeGreaterThan(-1);
    expect(g).toBeLessThan(v);
    expect(v).toBeLessThan(n);
    const row = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    const [gross, vat, net] = order(row, "484.00", "84.00", "400.00");
    expect(gross).toBeLessThan(vat);
    expect(vat).toBeLessThan(net);
  });

  it("orders the totals Total incl. VAT, VAT, Net Total", () => {
    const html = buildStmt([sLine(), sLine({ chargeCode: "OFR", amount: 600, vatRate: 0, vatTreatment: "zero_rated" })]);
    const totals = html.slice(html.lastIndexOf('<div class="totals">'));
    const [g, v, n] = order(totals, "Total incl. VAT (USD)", ">VAT<", "Net Total");
    expect(g).toBeLessThan(v);
    expect(v).toBeLessThan(n);
    expect(totals).toContain("1,084.00"); // gross: 1000 net + 84 VAT
  });

  it("adds a VAT summary by rate and treatment, also Gross, VAT, Net", () => {
    const html = buildStmt([sLine(), sLine({ chargeCode: "OFR", amount: 600, vatRate: 0, vatTreatment: "zero_rated" })]);
    expect(html).toContain("VAT Summary");
    expect(html).toContain("Standard 21%");
    expect(html).toContain("Zero-rated");
  });

  it("leaves the VAT summary out when no charge carries VAT information", () => {
    expect(buildStmt([sLine({ vatRate: 0 })])).not.toContain("VAT Summary");
  });

  it("prints the reverse-charge wording only when a charge is reverse-charged", () => {
    expect(buildStmt([sLine()])).not.toContain("to be accounted for by the customer");
    expect(buildStmt([sLine({ vatRate: 0, vatTreatment: "reverse_charge" })])).toContain("to be accounted for by the customer");
  });

  it("prints the issuing entity and both VAT numbers", () => {
    const html = buildStmt([sLine()], { taxInfo: { supplierName: "Rotterdam Branch", supplierTaxNumber: "NL859312660B01", customerName: "Atlantic Trading Corp", customerTaxNumber: "US-EIN 84-2917734" } });
    expect(html).toContain("Issued by");
    expect(html).toContain("Rotterdam Branch");
    expect(html).toContain("NL859312660B01");
    expect(html).toContain("US-EIN 84-2917734");
  });
});
