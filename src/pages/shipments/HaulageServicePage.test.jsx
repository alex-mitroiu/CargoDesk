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
vi.mock("../../AuthContext", () => ({ useAuth: () => ({ user: { id: "USR-TEST", role: "admin" } }) }));
vi.mock("../../utils/officeSide", () => ({ canEditShipmentSide: () => true }));
vi.mock("../../toast", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import HaulageServicePage from "./HaulageServicePage";
import { api } from "../../api";

// A fixture shaped like the mockup (3d91c28a): a shipper door, 2 × 45G1, the Pickup with a trucker typed as free text;
// MSKU7743220 had its own stops and every one of them was removed (audit A5, 2026-11-21).
const shipment = { id: "SHP-AQ1FIM", carrierCode: "MAEU", pol: "NLRTM", pod: "USNYC", status: "Active", shipperId: "CUS-LPUOVK",
  shipperName: "Van Leeuwen Meubelen BV", consigneeName: "Hudson Home Imports Inc", emoOfficeId: "OFF-C7XPBY", imoOfficeId: "OFF-NYC" };
const service = { id: "SVC-ABNVL1", shipmentId: shipment.id, side: "Export", serviceType: "Pickup", status: "Requested", vendorId: "", vendorName: "Bob's Trucks" };
const stop = { id: "HST-1", containerId: null, sequenceOrder: 1, purpose: "LOAD", purposeLabel: "Load at the door", inOut: ["arrive", "leave"],
  place: { kind: "customer", customerId: "CUS-LPUOVK", name: "Van Leeuwen Meubelen BV", lines: ["Waalhaven Oostzijde 81", "3087 BM Rotterdam, NL"] },
  contact: { name: "Van Leeuwen Meubelen BV", phone: "+31 10 428 1100" }, reference: "", effectiveReference: "", notes: "", unlocode: "NLRTM",
  timezone: "Europe/Amsterdam", utcOffset: "UTC+02:00", warnings: [], event: null };
const ctr = (id, number, own) => ({ id, containerNumber: number, isoCode: "45G1", equipment: "40' High Cube", vgmMethod: "Method 2", ownStops: own,
  stops: own ? [] : null, times: {}, checks: [], record: { driverName: "", truckPlate: "", instructions: "", costAmount: null, costCurrency: "USD", costExchangeRate: 1, costLineId: "" } });
const plan = {
  service: { id: service.id, side: "Export", serviceType: "Pickup", status: "Requested", vendorId: "", vendorName: "Bob's Trucks" },
  trucker: { id: "", name: "Bob's Trucks", email: "", phone: "", inMasterData: false },
  leg: { movementType: "Merchant's Haulage", fromType: "Door", toType: "Terminal", from: "NLRTM", to: "NLRTM" }, merchantHaulage: true,
  bookingRef: "MAEU283339JU9", masterBl: "", carrierCode: "MAEU", releaseRef: "Booking MAEU283339JU9",
  port: { unlocode: "NLRTM", name: "Rotterdam", timezone: "Europe/Amsterdam", utcOffset: "UTC+02:00" },
  purposes: [{ key: "LOAD", label: "Load at the door", side: "Export", inOut: ["arrive", "leave"] }],
  deadlines: [], stops: [stop],
  containers: [ctr("CTR-1", "MSKU7743215", false), ctr("CTR-2", "MSKU7743220", true)],
  office: null,
};

describe("HaulageServicePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.services.list.mockResolvedValue([service]);
    api.haulagePlan.get.mockResolvedValue(plan);
    api.haulagePlan.ownStops.mockResolvedValue({ ...plan, containers: [ctr("CTR-1", "MSKU7743215", false), ctr("CTR-2", "MSKU7743220", false)] });
    api.documents.list.mockResolvedValue([]);
  });

  it("A5: a container whose own stops were all removed still has its way back to the shared stops", async () => {
    render(<HaulageServicePage shipment={shipment} side="Export" serviceType="Pickup" canEdit onViewDocuments={() => {}} />);
    const back = await screen.findByTestId("haulage-shared-MSKU7743220");
    fireEvent.click(back);
    await waitFor(() => expect(api.haulagePlan.ownStops).toHaveBeenCalledWith("SHP-AQ1FIM", "SVC-ABNVL1", "CTR-2", false));
  });

  it("A1: a trucker typed as free text is said not to be in Master Data", async () => {
    render(<HaulageServicePage shipment={shipment} side="Export" serviceType="Pickup" canEdit onViewDocuments={() => {}} />);
    const note = await screen.findByTestId("haulage-trucker-typed");
    expect(note.textContent).toContain("Bob's Trucks isn't in Master Data → Customers");
  });

  it("the shared container offers its own stops, not a way back", async () => {
    render(<HaulageServicePage shipment={shipment} side="Export" serviceType="Pickup" canEdit onViewDocuments={() => {}} />);
    expect(await screen.findByTestId("haulage-own-MSKU7743215")).toBeTruthy();
    expect(screen.queryByTestId("haulage-shared-MSKU7743215")).toBeNull();
  });
});
