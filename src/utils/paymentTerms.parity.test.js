import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import * as browser from "./paymentTerms";

// The payment terms and office split exist twice: the browser's (the booking screen and the costs pop-up show it live)
// and the server's (lib/payment-terms.js: the booking request, invoices, reports). Both must answer the same (2026-11-14).
const server = createRequire(import.meta.url)("../../lib/payment-terms.js");

const ship = (incoterm, extra = {}) => ({
  incoterm, emoOfficeId: "OFF-RTM", imoOfficeId: "OFF-NYC", shipperId: "CUS-VLM", shipperName: "Van Leeuwen Meubelen BV",
  consigneeId: "CUS-HHI", consigneeName: "Hudson Home Imports Inc", principalId: "", principalName: "", paymentTerms: { followsIncoterm: true }, ...extra,
});
const LINES = [
  { chargeCode: "Origin THC" }, { chargeCode: "Ocean Freight" }, { chargeCode: "Destination THC" }, { chargeCode: "Haulage" },
  { chargeCode: "Haulage", chargeSide: "Destination" }, { chargeCode: "Customs", chargeSide: "Destination" }, { chargeCode: "B/L Fee" },
  { chargeCode: "Other", source: "arrival_notice" }, { chargeCode: "Ocean Freight", responsibleOffice: "billing" },
];

describe("Payment terms and the office split", () => {
  it("every Incoterm: the same split in the browser and on the server", () => {
    for (const t of ["", "EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"]) {
      // D1 (2026-11-23): before the terms are saved, the freight follows Freight Terms; every value in both copies.
      for (const extra of [{}, { principalId: "CUS-HHI", principalName: "Hudson Home Imports Inc" }, { billingOfficeId: "OFF-AMS" },
        { freightTerms: "Prepaid" }, { freightTerms: "Collect" }, { freightTerms: "Payable at Destination" }]) {
        const s = ship(t, extra);
        expect(browser.termsOf(s)).toEqual(server.termsOf(s));
        for (const l of LINES) expect(browser.lineSplit(s, l)).toEqual(server.lineSplit(s, l));
        expect(browser.dcsaPaymentTerms(browser.termsOf(s), { freightPayableAt: "USNYC" })).toEqual(server.dcsaPaymentTerms(server.termsOf(s), { freightPayableAt: "USNYC" }));
      }
    }
  });

  it("FOB: origin charges to the shipper through the export office, freight and destination to the buyer through the import office", () => {
    const s = ship("FOB", { principalId: "CUS-HHI", principalName: "Hudson Home Imports Inc" });
    const othc = browser.lineSplit(s, { chargeCode: "Origin THC" });
    expect(othc).toMatchObject({ category: "originPort", term: "PRE", officeId: "OFF-RTM", billTo: { name: "Van Leeuwen Meubelen BV", role: "Shipper" } });
    expect(browser.lineSplit(s, { chargeCode: "Ocean Freight" })).toMatchObject({ category: "freight", term: "COL", officeId: "OFF-NYC", billTo: { role: "Principal" } });
    expect(browser.lineSplit(s, { chargeCode: "Customs", chargeSide: "Destination" })).toMatchObject({ category: "destinationOther", officeId: "OFF-NYC" });
  });

  it("a billing office issues every line; a line can name its own office", () => {
    const s = ship("CIF", { billingOfficeId: "OFF-AMS" });
    expect(browser.lineSplit(s, { chargeCode: "Destination THC" })).toMatchObject({ officeId: "OFF-NYC", issuerOfficeId: "OFF-AMS" });
    expect(browser.lineSplit(s, { chargeCode: "Ocean Freight", responsibleOffice: "billing" })).toMatchObject({ officeId: "OFF-AMS", followsCategory: false });
    // An office the shipment doesn't have: the line follows its category again.
    expect(browser.lineSplit(ship("CIF"), { chargeCode: "Ocean Freight", responsibleOffice: "billing" })).toMatchObject({ followsCategory: true, officeId: "OFF-RTM" });
  });

  it("not saved: the defaults are shown but the shipment isn't split; saved terms someone changed are kept", () => {
    expect(browser.termsOf(ship("FOB", { paymentTerms: null }))).toMatchObject({ saved: false, followsIncoterm: true });
    const own = { followsIncoterm: false, categories: { freight: { term: "PRE", office: "billing" } } };
    const t = browser.termsOf(ship("FOB", { paymentTerms: JSON.stringify(own) }));
    expect(t.categories.freight).toEqual({ term: "PRE", office: "billing" });
    expect(t.categories.destinationPort).toEqual({ term: "COL", office: "import" });
  });

  it("the DCSA booking fields", () => {
    expect(browser.dcsaPaymentTerms(browser.termsOf(ship("DAP")), { freightPayableAt: "nlrtm" })).toEqual({
      originChargesPaymentTerm: { haulageChargesPaymentTermCode: "PRE", portChargesPaymentTermCode: "PRE", otherChargesPaymentTermCode: "PRE" },
      freightPaymentTermCode: "PRE",
      destinationChargesPaymentTerm: { portChargesPaymentTermCode: "PRE", haulageChargesPaymentTermCode: "PRE", otherChargesPaymentTermCode: "COL" },
      invoicePayableAt: { UNLocationCode: "NLRTM" },
    });
    expect(browser.freightTermsFor("COL", "Payable at Destination")).toBe("Payable at Destination");
    expect(browser.freightTermsFor("PRE", "Collect")).toBe("Prepaid");
  });

  // The 0.91.18 audit (2026-11-24): A — Freight Terms follows the Incoterm until picked (E/F Collect, C/D Prepaid); D — only
  // the three values, one reader of Freight Terms everywhere.
  it("Freight Terms: what an Incoterm implies, following it, the three values, one reader", () => {
    const incoterms = ["", "EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP", null];
    for (const t of incoterms) expect(browser.incotermFreightTerms(t)).toBe(server.incotermFreightTerms(t));
    expect(incoterms.map(t => browser.incotermFreightTerms(t))).toEqual(["Prepaid", "Collect", "Collect", "Collect", "Collect",
      "Prepaid", "Prepaid", "Prepaid", "Prepaid", "Prepaid", "Prepaid", "Prepaid", "Prepaid"]);
    const values = ["", "Prepaid", "Collect", "Payable at Destination", "Freight Collect", null];
    for (const v of values) for (const a of incoterms) for (const b of ["FOB", "CIF", ""])
      expect(browser.followFreightTerms(v, a, b)).toBe(server.followFreightTerms(v, a, b));
    expect(browser.followFreightTerms("Collect", "FOB", "CIF")).toBe("Prepaid");          // implied before: follows
    expect(browser.followFreightTerms("", "", "FCA")).toBe("Collect");                    // none: follows
    expect(browser.followFreightTerms("Prepaid", "FOB", "DAP")).toBe("Prepaid");         // picked under FOB: stays
    expect(browser.followFreightTerms("Collect", "CIF", "DDP")).toBe("Collect");         // picked under CIF: stays
    expect(browser.followFreightTerms("Payable at Destination", "FOB", "CIF")).toBe("Payable at Destination");
    for (const v of ["  payable  at DESTINATION ", "collect", "PREPAID", "Freight Collect", "", undefined, "Third party"]) {
      expect(browser.freightTermsValue(v)).toBe(server.freightTermsValue(v));
      expect(browser.freightTermOf(v)).toBe(server.freightTermOf(v));
    }
    expect(browser.freightTermsValue("  payable  at DESTINATION ")).toBe("Payable at Destination");
    expect(browser.freightTermsValue("Freight Collect")).toBe(null);
    expect(browser.freightTermsValue("")).toBe("");
    expect([browser.freightTermOf("Collect"), browser.freightTermOf("Payable at Destination"), browser.freightTermOf("Prepaid"), browser.freightTermOf("")])
      .toEqual(["COL", "COL", "PRE", null]);
  });
});
