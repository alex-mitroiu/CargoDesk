import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mirror the REAL api.js's shape (every leaf resolves []), so a wrong method name fails here as it
// would in the app — same approach as MasterBlPanel.test.jsx.
vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k, typeof v === "function" ? vi.fn().mockResolvedValue([]) : (v && typeof v === "object") ? mockDeep(v) : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});
vi.mock("../../AuthContext", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));
vi.mock("../../utils/officeSide", () => ({ canEditShipmentSide: () => true }));

import ShipmentArrivalNoticePage from "./ShipmentArrivalNoticePage";
import { api } from "../../api";

const shipment = { id: "SHP-AQ1FIM", carrierCode: "MAEU", pod: "USNYC" };
// The shape GET /api/shipments/:id/arrival-notice answers (lib/arrival-notices.js view).
const notice = (over = {}) => ({
  id: "AN-1", version: "2", issueDateTime: "2026-11-05T06:10:00Z", receivedAt: "2026-11-05T06:10:02Z", carrierCode: "MAEU",
  transportDocumentReference: "MAEU412841377LS", isMock: true, source: "push",
  facts: { vessel: "MAERSK KENSINGTON", voyage: "448W", portOfDischarge: "USNYC", arrival: { date: "2026-11-06", classifier: "ESTIMATED" },
    pickup: { number: "448W-7720", location: { name: "Maher Terminals, Elizabeth NJ", unLocationCode: "USNYC" } },
    returnTo: { reference: "TI-55102", location: { name: "APM Terminals Elizabeth", unLocationCode: "USNYC" } },
    release: { freight: true, originalBl: false, customs: false }, customs: { manifest: "4471-2026-0911" } },
  etaChange: { from: "2026-11-07", to: "2026-11-06" },
  freeTime: [
    { containerId: "C1", containerNumber: "MSKU7743215", kind: "DEM", label: "Demurrage", days: 4, unit: "CD", lastFreeDate: "2026-11-10", onContainer: 4, state: "filled" },
    { containerId: "C1", containerNumber: "MSKU7743215", kind: "DET", label: "Detention", days: 7, unit: "CD", lastFreeDate: "2026-11-13", onContainer: 10, state: "differs" },
  ],
  charges: [
    { index: 0, name: "Terminal handling, destination", chargeCode: "Destination THC", amount: 990, currency: "USD", paymentTermCode: "COL", quantity: 2, unitPrice: 495,
      addedCostLineId: null, looksEntered: 'An accrual of USD 990.00 "Destination THC" is already in Cost Entry' },
    { index: 1, name: "Delivery order fee", chargeCode: "Documentation Fee", amount: 85, currency: "USD", paymentTermCode: "COL", basis: "PER_BL", addedCostLineId: null, looksEntered: null },
  ],
  versions: [{ id: "AN-1", version: "2", issueDateTime: "2026-11-05T06:10:00Z", isCurrent: true }, { id: "AN-0", version: "1", issueDateTime: "2026-11-03T08:00:00Z", isCurrent: false }],
  ...over,
});

describe("ShipmentArrivalNoticePage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the key facts, the ETA move, and the free time against the containers", async () => {
    api.arrivalNotice.get.mockResolvedValue(notice());
    render(<ShipmentArrivalNoticePage shipment={shipment} />);
    expect(await screen.findByText("VERSION 2")).toBeInTheDocument();
    expect(screen.getByText(/Version 2 replaces version 1/)).toBeInTheDocument();
    expect(screen.getByText("Maher Terminals, Elizabeth NJ · USNYC")).toBeInTheDocument();
    expect(screen.getByText("448W-7720")).toBeInTheDocument();
    expect(screen.getByText("FILLED · 4 DAYS")).toBeInTheDocument();
    expect(screen.getByText("SAYS 10 DAYS")).toBeInTheDocument();
  });

  it("settles a free-time difference with the carrier's days", async () => {
    api.arrivalNotice.get.mockResolvedValue(notice());
    api.arrivalNotice.freeTime.mockResolvedValue(notice({ freeTime: [{ ...notice().freeTime[1], onContainer: 7, state: "filled" }] }));
    render(<ShipmentArrivalNoticePage shipment={shipment} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use 7" }));
    await waitFor(() => expect(api.arrivalNotice.freeTime).toHaveBeenCalledWith("SHP-AQ1FIM", { containerId: "C1", kind: "DET", use: true }));
  });

  it("starts a charge that looks entered unticked, and adds the ticked ones as accruals", async () => {
    api.arrivalNotice.get.mockResolvedValue(notice());
    api.arrivalNotice.accrue.mockResolvedValue({ created: ["CL-1"], arrivalNotice: notice({ charges: [notice().charges[0], { ...notice().charges[1], addedCostLineId: "CL-1" }] }) });
    render(<ShipmentArrivalNoticePage shipment={shipment} />);
    expect(await screen.findByText("LOOKS ENTERED")).toBeInTheDocument();
    expect(screen.getByLabelText("Add Terminal handling, destination")).not.toBeChecked();
    expect(screen.getByLabelText("Add Delivery order fee")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Add 1 as accruals (USD 85.00)" }));
    await waitFor(() => expect(api.arrivalNotice.accrue).toHaveBeenCalledWith("SHP-AQ1FIM", [1]));
    expect(await screen.findByText("ADDED · BUY ACCRUAL")).toBeInTheDocument();
  });

  it("says when the carrier hasn't sent one, and asks it", async () => {
    api.arrivalNotice.get.mockResolvedValue(null);
    api.arrivalNotice.refresh.mockResolvedValue(notice());
    render(<ShipmentArrivalNoticePage shipment={shipment} />);
    expect(await screen.findByText("No Arrival Notice from MAEU yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ask MAEU now" }));
    await waitFor(() => expect(api.arrivalNotice.refresh).toHaveBeenCalledWith("SHP-AQ1FIM"));
    expect(await screen.findByText("VERSION 2")).toBeInTheDocument();
  });
});
