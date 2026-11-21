import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// Mirror the REAL api.js's shape (every leaf resolves []), so a wrong method name fails here as it would in the app.
vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k, typeof v === "function" ? vi.fn().mockResolvedValue([]) : (v && typeof v === "object") ? mockDeep(v) : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});

import { PaymentTermsCard } from "./PaymentTerms";
import { api } from "../../api";

// An FOB Rotterdam → New York shipment with a billing office (the office split, §8.52).
const shipment = { id: "SHP-SPLIT1", incoterm: "FOB", status: "Active", emoOfficeId: "OFF-RTM", imoOfficeId: "OFF-NYC", billingOfficeId: "OFF-AMS",
  shipperId: "CUS-VLM", shipperName: "Van Leeuwen Meubelen BV", consigneeId: "CUS-HHI", consigneeName: "Hudson Home Imports Inc",
  principalId: "CUS-HHI", principalName: "Hudson Home Imports Inc", freightTerms: "Collect" };
const OFFICES = [
  { key: "export", label: "Export office", id: "OFF-RTM", code: "NL-NLRTM-SE", name: "Rotterdam Office", unlocode: "NLRTM", entityName: "Rotterdam Branch" },
  { key: "import", label: "Import office", id: "OFF-NYC", code: "US-USNYC-SI", name: "New York Harbor", unlocode: "USNYC", entityName: "New York Branch" },
  { key: "billing", label: "Billing office", id: "OFF-AMS", code: "NL-NLAMS-SE", name: "Amsterdam Billing", unlocode: "NLAMS", entityName: "Rotterdam Branch" },
];
// GET /api/shipments/:id/payment-terms as routes/payment-terms.js answers it, before the terms are saved. payableAt: the
// carrier's billing office per side (lib/carrier-offices.js): its destination office sits in Newark (USEWR), its origin side
// has none, so the port of loading.
const DEF = "PPPCCCC", IDS = ["originHaulage", "originPort", "originOther", "freight", "destinationPort", "destinationHaulage", "destinationOther"];
const view = (over = {}) => ({
  shipmentId: shipment.id, saved: false, followsIncoterm: true, incoterm: "FOB", billingOfficeId: "OFF-AMS", canEdit: true, offices: OFFICES,
  payableAt: { PRE: "NLRTM", COL: "USEWR" },
  categories: IDS.map((id, i) => ({ id, term: DEF[i] === "C" ? "COL" : "PRE", office: DEF[i] === "C" ? "import" : "export" })),
  ...over,
});
const lines = [
  { id: "CL-1", type: "SELL", chargeCode: "Origin THC", currency: "EUR", amount: 245, amountUsd: 264.6, exchangeRate: 1.08, chargeSide: "", responsibleOffice: "" },
  { id: "CL-2", type: "SELL", chargeCode: "Haulage", currency: "USD", amount: 650, amountUsd: 650, exchangeRate: 1, chargeSide: "", responsibleOffice: "", notes: "Delivery to Edison, NJ" },
  { id: "CL-3", type: "BUY", chargeCode: "Ocean Freight", currency: "USD", amount: 1900, amountUsd: 1900, exchangeRate: 1, chargeSide: "", responsibleOffice: "" },
];

beforeEach(() => vi.clearAllMocks());

describe("Payment terms (CPI) on the Carrier Booking", () => {
  it("shows the Incoterm's defaults, who each category bills, and what goes to the carrier", async () => {
    api.paymentTerms.get.mockResolvedValue(view());
    render(<PaymentTermsCard shipment={shipment} />);
    expect(await screen.findByTestId("payment-terms-status")).toHaveTextContent("Not saved yet · the FOB defaults");
    const freight = screen.getByTestId("cpi-row-freight");
    expect(within(freight).getByTestId("cpi-freight-COL")).toHaveAttribute("aria-pressed", "true");
    expect(freight).toHaveTextContent("Hudson Home Imports Inc");
    expect(screen.getByTestId("cpi-row-originPort")).toHaveTextContent("Van Leeuwen Meubelen BV");
    const dcsa = JSON.parse(screen.getByTestId("payment-terms-dcsa").textContent);
    // Fix F (2026-11-18): payable at the carrier's billing office of the side paying the freight, not our import office (USNYC).
    expect(dcsa).toMatchObject({ freightPaymentTermCode: "COL", destinationChargesPaymentTerm: { portChargesPaymentTermCode: "COL" }, invoicePayableAt: { UNLocationCode: "USEWR" } });
  });

  it("the preview follows the freight term: Prepaid is payable at the origin side's place", async () => {
    api.paymentTerms.get.mockResolvedValue(view({ saved: true }));
    render(<PaymentTermsCard shipment={shipment} />);
    await screen.findByTestId("cpi-row-freight");
    fireEvent.click(screen.getByTestId("cpi-freight-PRE"));
    expect(JSON.parse(screen.getByTestId("payment-terms-dcsa").textContent).invoicePayableAt).toEqual({ UNLocationCode: "NLRTM" });
    expect(screen.getByTestId("payment-terms-status")).toHaveTextContent("Changed · not saved yet");
    expect(screen.getByTestId("payment-terms-payable-at")).toHaveTextContent("else the port of loading");
  });

  it("folds: the table and the request go, the status, a line per group of charges and the buttons stay (decisions B and C)", async () => {
    api.paymentTerms.get.mockResolvedValue(view());
    render(<PaymentTermsCard shipment={shipment} />);
    await screen.findByTestId("cpi-row-freight");
    fireEvent.click(screen.getByTestId("payment-terms-section-fold"));
    expect(screen.getByTestId("cpi-row-freight")).not.toBeVisible();
    expect(screen.getByTestId("payment-terms-dcsa")).not.toBeVisible();
    expect(screen.getByTestId("payment-terms-section")).toHaveAttribute("data-open", "false");
    const summary = screen.getByTestId("payment-terms-summary");
    // The billing office (OFF-AMS) issues the invoices, but each category keeps its responsible office.
    expect(summary).toHaveTextContent("Origin charges Prepaid · Rotterdam Office · Van Leeuwen Meubelen BV");
    expect(summary).toHaveTextContent("Freight and destination Collect · New York Harbor · Hudson Home Imports Inc");
    expect(screen.getByTestId("payment-terms-status")).toHaveTextContent("Not saved yet · the FOB defaults");
    expect(screen.getByTestId("payment-terms-save")).toBeInTheDocument();
    expect(screen.getByTestId("payment-terms-lines")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("payment-terms-section-fold"));
    expect(screen.getByTestId("cpi-row-freight")).toBeVisible();
  });

  it("switching a category moves its office and billed party, and Save sends the categories", async () => {
    api.paymentTerms.get.mockResolvedValue(view({ saved: true }));
    api.paymentTerms.save.mockResolvedValue(view({ saved: true, followsIncoterm: false }));
    render(<PaymentTermsCard shipment={shipment} />);
    await screen.findByTestId("cpi-row-originOther");
    fireEvent.click(screen.getByTestId("cpi-originOther-COL"));
    expect(screen.getByTestId("cpi-office-originOther")).toHaveValue("import");
    expect(screen.getByTestId("cpi-row-originOther")).toHaveTextContent("Hudson Home Imports Inc");
    fireEvent.click(screen.getByTestId("payment-terms-save"));
    await waitFor(() => expect(api.paymentTerms.save).toHaveBeenCalledTimes(1));
    const [id, body] = api.paymentTerms.save.mock.calls[0];
    expect(id).toBe("SHP-SPLIT1");
    expect(body.categories.originOther).toEqual({ term: "COL", office: "import" });
  });

  it("the Costs and charges pop-up: each line's category and office, a side for codes that name none, saved per line", async () => {
    api.paymentTerms.get.mockResolvedValue(view({ saved: true }));
    api.costLines.list.mockResolvedValue(lines);
    api.paymentTerms.save.mockResolvedValue(view({ saved: true }));
    render(<PaymentTermsCard shipment={shipment} />);
    fireEvent.click(await screen.findByTestId("payment-terms-lines"));
    const haulage = await screen.findByTestId("costs-line-CL-2");
    expect(haulage).toHaveTextContent("Origin haulage");
    fireEvent.change(within(haulage).getByTestId("costs-side-CL-2"), { target: { value: "Destination" } });
    expect(screen.getByTestId("costs-line-CL-2")).toHaveTextContent("Destination haulage");
    expect(screen.getByTestId("costs-line-CL-2")).toHaveTextContent("Hudson Home Imports Inc");
    // Ocean Freight names its own side: no side choice.
    expect(within(screen.getByTestId("costs-line-CL-3")).queryByTestId("costs-side-CL-3")).toBeNull();
    fireEvent.change(screen.getByTestId("costs-office-CL-3"), { target: { value: "billing" } });
    expect(screen.getByTestId("costs-line-CL-3")).toHaveTextContent("changed");
    fireEvent.click(screen.getByTestId("costs-save"));
    await waitFor(() => expect(api.paymentTerms.save).toHaveBeenCalledTimes(1));
    expect(api.paymentTerms.save.mock.calls[0][1].lines).toEqual({ "CL-2": { chargeSide: "Destination" }, "CL-3": { responsibleOffice: "billing" } });
  });

  it("an issued charge and a posted cost keep their side and office (audit S4)", async () => {
    api.paymentTerms.get.mockResolvedValue(view({ saved: true }));
    api.costLines.list.mockResolvedValue([
      lines[0],
      { ...lines[1], billedOn: { kind: "invoice", id: "DOC-1", docType: "FR01", status: "confirmed", label: "FR01-SHP-SPLIT1-1.pdf" } },
      { ...lines[2], status: "posted" },
    ]);
    render(<PaymentTermsCard shipment={shipment} />);
    fireEvent.click(await screen.findByTestId("payment-terms-lines"));
    await screen.findByTestId("costs-line-CL-2");
    expect(screen.getByTestId("costs-side-CL-2")).toBeDisabled();
    expect(screen.getByTestId("costs-office-CL-2")).toBeDisabled();
    expect(screen.getByTestId("costs-office-state-CL-2")).toHaveTextContent("issued");
    expect(screen.getByTestId("costs-office-CL-3")).toBeDisabled();
    expect(screen.getByTestId("costs-office-state-CL-3")).toHaveTextContent("posted");
    expect(screen.getByTestId("costs-office-CL-1")).not.toBeDisabled();
  });

  it("read-only for someone who can't change it", async () => {
    api.paymentTerms.get.mockResolvedValue(view({ saved: true, canEdit: false }));
    render(<PaymentTermsCard shipment={shipment} />);
    await screen.findByTestId("cpi-row-freight");
    expect(screen.getByTestId("cpi-freight-PRE")).toBeDisabled();
    expect(screen.queryByTestId("payment-terms-save")).toBeNull();
  });
});
