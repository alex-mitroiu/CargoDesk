// Invoice Entry → Generate invoices on a split shipment (the office split, §8.52): one invoice per issuing legal entity
// and billed party, each addressed to its party, in its currency, with the issuing entity as the supplier. The api is
// mocked with the names src/api.js really has.
import { describe, it, expect, vi, beforeEach } from "vitest";

const generated = [];
vi.mock("../api", () => ({
  api: {
    offices: { list: vi.fn(async () => [
      { id: "OFF-RTM", branchId: "BRN-NL" }, { id: "OFF-AMS", branchId: "BRN-NL" }, { id: "OFF-NYC", branchId: "BRN-US" }]) },
    branches: { get: vi.fn(async id => ({ "BRN-NL": { name: "Rotterdam Forwarding BV", taxRegistrationNumber: "NL812345678B01" }, "BRN-US": { name: "New York Forwarding Inc", taxRegistrationNumber: "" } }[id])) },
    customers: {
      get: vi.fn(async id => ({ "CUS-VLM": { currency: "EUR" }, "CUS-HHI": { currency: "USD" } }[id])),
      identifiers: { list: vi.fn(async () => []) },
    },
    documents: {
      list: vi.fn(async () => []),
      remove: vi.fn(async () => ({})),
      generate: vi.fn(async (shipmentId, data) => { generated.push(data); return { id: `DOC-${generated.length}`, ...data }; }),
    },
    chargeCodes: { list: vi.fn(async () => []) },
  },
}));

const { generateInvoices } = await import("./invoiceGenerator");

const shipment = { id: "SHP-SPLIT1", pol: "NLRTM", pod: "USNYC", incoterm: "FOB", emoOfficeId: "OFF-RTM", imoOfficeId: "OFF-NYC",
  shipperId: "CUS-VLM", shipperName: "Van Leeuwen Meubelen BV", consigneeId: "CUS-HHI", consigneeName: "Hudson Home Imports Inc",
  principalId: "CUS-HHI", principalName: "Hudson Home Imports Inc" };
const party = { shipper: { customerId: "CUS-VLM", name: "Van Leeuwen Meubelen BV", role: "Shipper" }, buyer: { customerId: "CUS-HHI", name: "Hudson Home Imports Inc", role: "Principal" } };
const line = (id, chargeCode, currency, amount, issuerOfficeId, billTo) => ({ id, type: "SELL", chargeCode, currency, amount, exchangeRate: 1, amountUsd: amount,
  vatRate: 0, vatTreatment: "standard", containerId: "", billedOn: null, split: { issuerOfficeId, officeId: issuerOfficeId, billTo } });

beforeEach(() => { generated.length = 0; });

describe("generating invoices on a split shipment", () => {
  it("one invoice per billed party when the billing office issues everything", async () => {
    const lines = [line("CL-1", "Origin THC", "EUR", 245, "OFF-AMS", party.shipper), line("CL-2", "B/L Fee", "EUR", 75, "OFF-AMS", party.shipper),
      line("CL-3", "Ocean Freight", "USD", 2450, "OFF-AMS", party.buyer), line("CL-4", "Destination THC", "USD", 380, "OFF-AMS", party.buyer)];
    const out = await generateInvoices(shipment, { costLines: lines, targetCurrency: "USD", fxRates: { USD: 1, EUR: 0.92 } });
    expect(out).toHaveLength(2);
    const toShipper = generated.find(g => g.responsibleParty === "Van Leeuwen Meubelen BV");
    const toBuyer = generated.find(g => g.responsibleParty === "Hudson Home Imports Inc");
    expect(toShipper.sourceCostLineIds).toEqual(["CL-1", "CL-2"]);
    expect(toBuyer.sourceCostLineIds).toEqual(["CL-3", "CL-4"]);
    // Addressed to its party, from the Dutch entity (the billing office's), in the party's currency.
    expect(toShipper.html).toMatch(/Bill To<\/div><div class="party-name">Van Leeuwen Meubelen BV/);
    expect(toShipper.html).toContain("NL812345678B01");
    expect(toBuyer.html).toMatch(/Bill To<\/div><div class="party-name">Hudson Home Imports Inc/);
    expect(new Set(generated.map(g => g.filename)).size).toBe(2);
  });

  it("the same billed party, two issuing entities: two invoices", async () => {
    const lines = [line("CL-5", "Other", "EUR", 40, "OFF-RTM", party.buyer), line("CL-6", "Customs", "USD", 185, "OFF-NYC", party.buyer)];
    await generateInvoices(shipment, { costLines: lines, targetCurrency: "USD", fxRates: { USD: 1, EUR: 0.92 } });
    expect(generated.map(g => g.sourceCostLineIds)).toEqual([["CL-5"], ["CL-6"]]);
  });

  it("two offices of one legal entity, one party: one invoice", async () => {
    const lines = [line("CL-7", "Origin THC", "EUR", 245, "OFF-RTM", party.shipper), line("CL-8", "B/L Fee", "EUR", 75, "OFF-AMS", party.shipper)];
    await generateInvoices(shipment, { costLines: lines, targetCurrency: "USD", fxRates: { USD: 1, EUR: 0.92 } });
    expect(generated.map(g => g.sourceCostLineIds)).toEqual([["CL-7", "CL-8"]]);
  });

  it("a shipment that isn't split: one invoice to the principal, as before", async () => {
    const lines = [{ ...line("CL-9", "Ocean Freight", "USD", 2450, "", null), split: null }, { ...line("CL-10", "Origin THC", "USD", 200, "", null), split: null }];
    await generateInvoices(shipment, { costLines: lines, targetCurrency: "USD", fxRates: { USD: 1 } });
    expect(generated).toHaveLength(1);
    expect(generated[0].responsibleParty).toBe("Hudson Home Imports Inc");
  });
});
