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
vi.mock("../../AuthContext", () => ({ useAuth: () => ({ user: { id: "USR-TEST", role: "admin" } }) }));
vi.mock("../../utils/officeSide", () => ({ canEditShipmentSide: () => true }));
// Shared parts with their own fetching and sockets, tested elsewhere.
vi.mock("../../components/shared/CarrierBookingsTable", () => ({ default: () => <div data-testid="bookings-table-stub" /> }));
vi.mock("../../components/shared/EdiMessageList", () => ({ default: () => <div data-testid="edi-list-stub" /> }));
vi.mock("./ShipmentDetailPage", () => ({ CommodityDisplay: ({ code }) => <span>{code}</span> }));
vi.mock("../../toast", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("../../utils/invoiceGenerator", () => ({ resolveCreditGate: vi.fn().mockResolvedValue({ blocked: false }) }));

import ShipmentCarrierBookingDetailsPage from "./ShipmentCarrierBookingDetailsPage";
import { api } from "../../api";
import { toast } from "../../toast";

// A fixture shaped like SHP-S5P9YC (2026-11-18): HLCU, FOB, NLRTM → USNYC, the booking sent to the demo carrier.
const shipment = { id: "SHP-S5P9YC", carrierCode: "HLCU", pol: "NLRTM", pod: "USNYC", incoterm: "FOB", freightTerms: "Prepaid", status: "Active",
  vessel: "DEMO CADENZA", voyage: "DM003W", etd: "2026-11-04", eta: "2026-11-20", contractType: "Central", contractRef: "EC-HLCU-NLAMS-USNYC",
  shipperName: "Acme Freight B.V.", consigneeName: "Empire Logistics Partners (Brooklyn) Inc", principalName: "Receivables Test Co DPRAU",
  emoOfficeId: "OFF-RTM", imoOfficeId: "OFF-NYC", commodityCode: "9999" };
const pending = { id: "BKG-FLKIGI", shipmentId: shipment.id, carrierCode: "HLCU", status: "Pending", lastResponseStatus: "received", bookingRef: "",
  isMock: true, requestedAt: "2026-10-21T17:18:03.985Z", requestedBy: "Test Operator", carrierBookingRequestReference: "SIM-D7MOY6VA5FKD" };
const role = (r, label, side, port, over = {}) => ({ role: r, label, side, port, office: null, source: null, fallback: false, candidates: [], ...over });
const rotterdam = { id: "CO-RTM", name: "Rotterdam Cargo Services B.V.", unlocode: "NLRTM" };
const offices = { shipmentId: shipment.id, carrierCode: "HLCU", capabilityGaps: [], offices: [rotterdam], roles: {
  booking: role("booking", "Booking office", "export", "NLRTM", { office: rotterdam, source: "migrated" }),
  billing_origin: role("billing_origin", "Billing · origin", "export", "NLRTM", { office: rotterdam, source: "fallback", fallback: true }),
  import: role("import", "Import office", "import", "USNYC"),
  billing_destination: role("billing_destination", "Billing · destination", "import", "USNYC"),
} };
const OFFICES = [
  { key: "export", label: "Export office", id: "OFF-RTM", code: "NL-NLRTM-SE", name: "Rotterdam Office", unlocode: "NLRTM" },
  { key: "import", label: "Import office", id: "OFF-NYC", code: "US-USNYC-SI", name: "New York Harbor", unlocode: "USNYC" },
];
const IDS = ["originHaulage", "originPort", "originOther", "freight", "destinationPort", "destinationHaulage", "destinationOther"];
const terms = { shipmentId: shipment.id, saved: false, followsIncoterm: true, incoterm: "FOB", billingOfficeId: "", canEdit: true, offices: OFFICES,
  payableAt: { PRE: "NLRTM", COL: "USNYC" },
  categories: IDS.map((id, i) => ({ id, term: i < 3 ? "PRE" : "COL", office: i < 3 ? "export" : "import" })) };

const mount = (booking = pending) => {
  api.carrierConnections.get.mockResolvedValue({ capabilities: { booking: true } });
  api.carrierBooking.get.mockResolvedValue(booking);
  api.shipments.carrierOffices.get.mockResolvedValue(offices);
  api.paymentTerms.get.mockResolvedValue(terms);
  return render(<ShipmentCarrierBookingDetailsPage shipment={shipment} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("Carrier Booking → Details in Trade Horizon Next (mockup a3e1b986 v2)", () => {
  it("the booking is the main card: the carrier's answer, the references and the demo carrier", async () => {
    mount();
    expect(await screen.findByTestId("carrier-booking-headline")).toHaveTextContent("Pending with HLCU");
    expect(screen.getByTestId("carrier-booking-subline")).toHaveTextContent("Sent 21 Oct 2026 by Test Operator");
    expect(screen.getByTestId("carrier-booking-booking-section")).toHaveTextContent("SIM-D7MOY6VA5FKD");
    expect(screen.getByTestId("carrier-booking-booking-section")).toHaveTextContent("DEMO CARRIER");
    expect(screen.getByTestId("carrier-booking-booking-section")).toHaveTextContent("not confirmed yet");
    // Sent and waiting: Send can't be used, so it doesn't take the page's glow.
    expect(screen.getByTestId("carrier-booking-send")).toBeDisabled();
    expect(screen.getByTestId("carrier-booking-request-section")).toHaveTextContent("Sent: waiting for the carrier's answer.");
    for (const key of ["booking", "offices", "terms", "contract", "request"]) expect(screen.getByTestId(`carrier-booking-nav-${key}`)).toBeInTheDocument();
  });

  it("the carrier offices fold to one line, a missing office in the warning colour, and stay folded (decisions A and D)", async () => {
    const { unmount } = mount();
    const offices = await screen.findByTestId("carrier-booking-offices");
    expect(within(offices).getByTestId("carrier-booking-office-billing_origin")).toHaveTextContent("no billing row: the booking office bills");
    fireEvent.click(screen.getByTestId("carrier-booking-offices-fold"));
    expect(screen.getByTestId("carrier-booking-office-booking")).not.toBeVisible();
    const pills = screen.getByTestId("carrier-booking-offices-summary-pills");
    expect(pills).toHaveTextContent("Booking office Rotterdam Cargo Services B.V. · NLRTM");
    expect(pills).toHaveTextContent("Billing · origin the booking office");
    expect(pills).toHaveTextContent("Import office none set");
    expect(screen.getByTestId("carrier-booking-nav-offices-note")).toHaveTextContent("· folded");
    unmount();
    mount();
    expect(await screen.findByTestId("carrier-booking-offices")).toHaveAttribute("data-open", "false");
  });

  it("a pill opens its folded section, then scrolls to it", async () => {
    mount();
    await screen.findByTestId("payment-terms-section");
    fireEvent.click(screen.getByTestId("payment-terms-section-fold"));
    expect(screen.getByTestId("payment-terms-section")).toHaveAttribute("data-open", "false");
    fireEvent.click(screen.getByTestId("carrier-booking-nav-terms"));
    expect(screen.getByTestId("payment-terms-section")).toHaveAttribute("data-open", "true");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("a request the carrier never received can be sent again, and a refusal is said as one (audit B1, B2)", async () => {
    mount({ ...pending, lastResponseStatus: "send_failed", carrierBookingRequestReference: "" });
    expect(await screen.findByTestId("carrier-booking-headline")).toHaveTextContent("Not received by HLCU");
    expect(screen.getByTestId("carrier-booking-subline")).toHaveTextContent("send it again at the bottom of the page");
    expect(screen.getByTestId("carrier-booking-status")).toHaveTextContent("Not received");
    await waitFor(() => expect(screen.getByTestId("carrier-booking-send")).not.toBeDisabled());
    api.ediMessages.sendBookingRequest.mockResolvedValue({ pending: true, carrierError: "Service contract HLX unknown", booking: { ...pending, lastResponseStatus: "send_failed" } });
    fireEvent.click(screen.getByTestId("carrier-booking-send"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("HLCU didn't receive the booking request: Service contract HLX unknown")));
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("a confirmed booking whose cancellation is requested says so (audit B5)", async () => {
    mount({ ...pending, status: "Confirmed", lastResponseStatus: "cancellation_requested", bookingRef: "HLCUBCN2611804", confirmedAt: "2026-11-02T09:00:00Z", confirmedBy: "HLCU" });
    expect(await screen.findByTestId("carrier-booking-headline")).toHaveTextContent("Confirmed by HLCU · cancellation requested");
    expect(screen.getByTestId("carrier-booking-subline")).toHaveTextContent("stays confirmed until HLCU agrees");
  });

  it("a booking not sent yet: Send can be used", async () => {
    mount({ ...pending, status: "Created", carrierBookingRequestReference: "", requestedAt: null, requestedBy: "", isMock: false });
    expect(await screen.findByTestId("carrier-booking-headline")).toHaveTextContent("Not sent to HLCU yet");
    await waitFor(() => expect(screen.getByTestId("carrier-booking-send")).not.toBeDisabled());
    expect(screen.getByTestId("carrier-booking-booking-section")).not.toHaveTextContent("DEMO CARRIER");
  });
});
