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
      for (const extra of [{}, { principalId: "CUS-HHI", principalName: "Hudson Home Imports Inc" }, { billingOfficeId: "OFF-AMS" }]) {
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
});
