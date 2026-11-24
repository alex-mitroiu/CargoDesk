import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mirror the REAL api.js's shape (every leaf resolves []), so a wrong method name fails here as it would in the app.
vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k, typeof v === "function" ? vi.fn().mockResolvedValue([]) : (v && typeof v === "object") ? mockDeep(v) : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});

import { TransportDocumentCard } from "./TransportDocumentCard";
import { PaymentTermsCard } from "./PaymentTerms";
import { api } from "../../api";

// TKT-JV1SF2 point 5 (2026-11-23, mockup dffb8ab2) and D1 (TKT-ML3GRC): SHP-S5P9YC, HLCU, FOB, NLRTM → USNYC.
const shipment = { id: "SHP-S5P9YC", incoterm: "FOB", status: "Active", pol: "NLRTM", pod: "USNYC", freightTerms: "Prepaid", emoOfficeId: "OFF-RTM", imoOfficeId: "OFF-NYC",
  shipperId: "CUS-ACME", shipperName: "Acme Freight B.V.", consigneeId: "CUS-EMP", consigneeName: "Empire Logistics Partners (Brooklyn) Inc", principalId: "CUS-EMP",
  principalName: "Empire Logistics Partners (Brooklyn) Inc" };
const EMPTY = { transportDocumentType: "", numberOfDocuments: null, placeOfIssue: "", partialLoad: null, customsReferences: [] };
const answer = (options = EMPTY, dcsa = {}, canEdit = true) => ({ options, dcsa, canEdit, portOfLoading: "NLRTM" });

beforeEach(() => vi.clearAllMocks());

describe("Carrier Booking → Transport document and loading", () => {
  it("nothing stated: says so, sends nothing, and offers the port of loading as the place of issue", async () => {
    api.bookingRequestOptions.get.mockResolvedValue(answer());
    render(<TransportDocumentCard shipment={shipment} />);
    expect(await screen.findByTestId("transport-document-status")).toHaveTextContent("NOTHING STATED · NOT SENT");
    expect(screen.getByTestId("transport-document-dcsa")).toHaveTextContent("nothing stated");
    expect(screen.getByTestId("td-type-none")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("td-partial-none")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("td-place-pol")).toHaveTextContent("Use the port of loading (NLRTM)");
  });

  it("a choice saves at once and the request preview shows what the server says goes", async () => {
    api.bookingRequestOptions.get.mockResolvedValue(answer());
    api.bookingRequestOptions.save.mockResolvedValue(answer({ ...EMPTY, transportDocumentType: "SWB" }, { transportDocumentTypeCode: "SWB" }));
    render(<TransportDocumentCard shipment={shipment} />);
    fireEvent.click(await screen.findByTestId("td-type-SWB"));
    await waitFor(() => expect(api.bookingRequestOptions.save).toHaveBeenCalledWith("SHP-S5P9YC", { transportDocumentType: "SWB" }));
    expect(await screen.findByTestId("transport-document-status")).toHaveTextContent("1 STATED · SENT WITH THE BOOKING");
    expect(JSON.parse(screen.getByTestId("transport-document-dcsa").textContent)).toEqual({ transportDocumentTypeCode: "SWB" });
  });

  it("typed fields save when left; partial loading Not allowed sends false; a customs reference row goes as one value", async () => {
    api.bookingRequestOptions.get.mockResolvedValue(answer());
    api.bookingRequestOptions.save.mockImplementation(async (id, body) => answer({ ...EMPTY, ...body,
      customsReferences: body.customsReferences || [] }, {}));
    render(<TransportDocumentCard shipment={shipment} />);
    const count = await screen.findByTestId("td-count");
    fireEvent.change(count, { target: { value: "2" } });
    fireEvent.blur(count);
    await waitFor(() => expect(api.bookingRequestOptions.save).toHaveBeenCalledWith("SHP-S5P9YC", { numberOfDocuments: 2 }));
    fireEvent.click(screen.getByTestId("td-partial-false"));
    await waitFor(() => expect(api.bookingRequestOptions.save).toHaveBeenCalledWith("SHP-S5P9YC", { partialLoad: false }));
    fireEvent.click(screen.getByTestId("td-ref-add"));
    fireEvent.change(screen.getByLabelText("Customs reference 1 type"), { target: { value: "ACID" } });
    fireEvent.change(screen.getByLabelText("Customs reference 1 country"), { target: { value: "eg" } });
    const value = screen.getByLabelText("Customs reference 1 value");
    fireEvent.change(value, { target: { value: "4471202611230001" } });
    fireEvent.blur(value);
    await waitFor(() => expect(api.bookingRequestOptions.save).toHaveBeenLastCalledWith("SHP-S5P9YC",
      { customsReferences: [{ type: "ACID", countryCode: "EG", values: ["4471202611230001"] }] }));
  });

  // The 0.91.18 audit, E (TKT-EYDOU0): once the booking went, a change goes with the next update, and the card says so.
  it("after the booking went: says a change goes with the next update, and where to send it", async () => {
    api.bookingRequestOptions.get.mockResolvedValue(answer());
    api.bookingRequestOptions.save.mockResolvedValue(answer({ ...EMPTY, transportDocumentType: "SWB" }, { transportDocumentTypeCode: "SWB" }));
    const { toast } = await import("../../toast");
    const ok = vi.spyOn(toast, "success");
    render(<TransportDocumentCard shipment={shipment} sentToCarrier />);
    expect(await screen.findByTestId("transport-document-status")).toHaveTextContent("NOTHING STATED · NOT SENT");
    fireEvent.click(screen.getByTestId("td-type-SWB"));
    expect(await screen.findByText("1 STATED · GOES WITH THE NEXT UPDATE")).toBeInTheDocument();
    expect(ok).toHaveBeenCalledWith(expect.stringContaining("Send update to carrier"));
  });

  it("read-only for someone who may not change it", async () => {
    api.bookingRequestOptions.get.mockResolvedValue(answer({ ...EMPTY, transportDocumentType: "BOL" }, { transportDocumentTypeCode: "BOL" }, false));
    render(<TransportDocumentCard shipment={shipment} />);
    expect(await screen.findByTestId("td-type-BOL")).toBeDisabled();
    expect(screen.queryByTestId("td-ref-add")).not.toBeInTheDocument();
    expect(screen.getByText(/Only the shipment's OCC\/BK/)).toBeInTheDocument();
  });
});

describe("D1: before the payment terms are saved, the freight follows Freight Terms", () => {
  const IDS = ["originHaulage", "originPort", "originOther", "freight", "destinationPort", "destinationHaulage", "destinationOther"];
  const TERMS = "PPPPCCC"; // FOB, with Freight Terms Prepaid on the freight
  it("says so in the status and on each row", async () => {
    api.paymentTerms.get.mockResolvedValue({ shipmentId: shipment.id, saved: false, followsIncoterm: false, freightFromFreightTerms: true, freightTerms: "Prepaid",
      incoterm: "FOB", canEdit: true, payableAt: { PRE: "NLRTM", COL: "USNYC" },
      offices: [{ key: "export", label: "Export office", id: "OFF-RTM", code: "NL-NLRTM-SE", name: "Rotterdam Office" }, { key: "import", label: "Import office", id: "OFF-NYC", code: "US-USNYC-SI", name: "New York Harbor" }],
      categories: IDS.map((id, i) => ({ id, term: TERMS[i] === "C" ? "COL" : "PRE", office: TERMS[i] === "C" ? "import" : "export" })) });
    render(<PaymentTermsCard shipment={shipment} />);
    expect(await screen.findByTestId("payment-terms-status")).toHaveTextContent("Not saved yet · freight from Freight Terms, the rest from FOB");
    expect(screen.getByTestId("cpi-source-freight")).toHaveTextContent("from Freight Terms");
    expect(screen.getByTestId("cpi-source-destinationPort")).toHaveTextContent("from FOB");
    expect(screen.getByTestId("cpi-freight-PRE")).toHaveAttribute("aria-pressed", "true");
  });
});
