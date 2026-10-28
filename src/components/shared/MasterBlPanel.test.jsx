import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mirror the REAL api.js's shape (every leaf resolves []), so a wrong method name fails here as it
// would in the app — same approach as HouseBlPanel.test.jsx.
vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k, typeof v === "function" ? vi.fn().mockResolvedValue([]) : (v && typeof v === "object") ? mockDeep(v) : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});

import MasterBlPanel from "./MasterBlPanel";
import { api } from "../../api";

const shipment = { id: "SHP-AQ1FIM", carrierCode: "MAEU" };
const row = (key, label, sent, carrier = sent) => ({ key, label, sent, carrier, changed: sent !== carrier });
// The shape GET /api/shipments/:id/master-bl answers (routes/master-bl.js view + compareDraft).
const masterBl = (over = {}, { seal = "ML-4471183" } = {}) => ({
  id: "TD-1", reference: "MAEU412841377LS", status: "DRAFT", carrierCode: "MAEU", isMock: true, draftCount: 1, approvedAt: null, approvedBy: "",
  issueDate: null, shippedOnBoardDate: null, createdAt: "2026-10-27T22:48:04Z",
  events: [{ eventType: "MASTER_DRAFT", createdAt: "2026-10-27T22:48:04Z" }],
  document: {
    transportDocumentTypeCode: "BOL", freightPaymentTermCode: "PRE", numberOfOriginalsWithoutCharges: 3,
    utilizedTransportEquipments: [
      { equipment: { equipmentReference: "MSKU7743215", ISOEquipmentCode: "45G1" }, seals: [{ number: "ML-4471182" }] },
      { equipment: { equipmentReference: "MSKU7743220", ISOEquipmentCode: "45G1" }, seals: [{ number: seal }] },
    ],
    consignmentItems: [{ cargoItems: [{ cargoGrossWeight: { value: 11850 } }, { cargoGrossWeight: { value: 12940 } }] }],
  },
  comparison: [
    row("documentType", "Document", "BOL"), row("freight", "Freight", "PRE"), row("originals", "Originals", "3"),
    row("shipper", "Shipper", "Van Leeuwen Meubelen BV"), row("consignee", "Consignee", "Hudson Home Imports Inc"), row("notify", "Notify party", "Hudson Home Imports Inc"),
    row("portOfLoading", "Port of loading", "NLRTM"), row("portOfDischarge", "Port of discharge", "USNYC"), row("vessel", "Vessel / voyage", "MAERSK KENSINGTON 448W"),
    row("container:MSKU7743215", "Container MSKU7743215", "MSKU7743215"), row("seal:MSKU7743215", "  Seal", "ML-4471182"),
    row("container:MSKU7743220", "Container MSKU7743220", "MSKU7743220"), row("seal:MSKU7743220", "  Seal", "ML-4471183", seal),
  ],
  ...over,
});

describe("MasterBlPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the critical information first: the status, no differences, the key facts", async () => {
    api.masterBl.get.mockResolvedValue(masterBl());
    render(<MasterBlPanel shipment={shipment} canEdit />);
    expect(await screen.findByText("DRAFT · TO REVIEW")).toBeInTheDocument();
    expect(screen.getByText("No differences: the draft says what you sent")).toBeInTheDocument();
    expect(screen.getByText("Bill of Lading · 3 originals · prepaid")).toBeInTheDocument();
    expect(screen.getByText(/2 × 40' HC · 24,790 kg · seals ML-4471182, ML-4471183/)).toBeInTheDocument();
    expect(screen.queryByText(/Differs from what you sent/)).toBeNull();
    // The field-by-field list stays behind the button.
    expect(document.querySelector("#mbl-all-fields")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 11 fields" }));
    expect(document.querySelector("#mbl-all-fields")).not.toBeNull();
    expect(screen.getByText("Container MSKU7743220")).toBeInTheDocument();
  });

  it("puts a difference on top and marks the fact it belongs to", async () => {
    api.masterBl.get.mockResolvedValue(masterBl({}, { seal: "ML-4471188" }));
    render(<MasterBlPanel shipment={shipment} canEdit />);
    expect(await screen.findByText("1 difference — check before approving")).toBeInTheDocument();
    expect(screen.getByText("Differs from what you sent")).toBeInTheDocument();
    expect(screen.getByText("Container MSKU7743220 · Seal")).toBeInTheDocument();
    expect(screen.getAllByLabelText("differs from what you sent")).toHaveLength(1);
  });

  it("folds, and approves the draft through the API", async () => {
    api.masterBl.get.mockResolvedValue(masterBl());
    api.masterBl.approve.mockResolvedValue(masterBl({ status: "APPROVED", approvedBy: "Dana" }));
    const onChanged = vi.fn();
    render(<MasterBlPanel shipment={shipment} canEdit onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: /Master B\/L from MAEU/ }));
    expect(document.querySelector("#mbl-body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Master B\/L from MAEU/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve draft" }));
    await waitFor(() => expect(api.masterBl.approve).toHaveBeenCalledWith("SHP-AQ1FIM"));
    expect(await screen.findByText("APPROVED")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve draft" })).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });

  it("offers no actions to someone who can't edit, and shows nothing before the carrier drafts", async () => {
    api.masterBl.get.mockResolvedValue(masterBl());
    const { unmount } = render(<MasterBlPanel shipment={shipment} canEdit={false} />);
    expect(await screen.findByText("DRAFT · TO REVIEW")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve draft" })).toBeNull();
    unmount();
    api.masterBl.get.mockResolvedValue(null);
    const { container } = render(<MasterBlPanel shipment={shipment} canEdit />);
    await waitFor(() => expect(api.masterBl.get).toHaveBeenCalled());
    expect(container.querySelector("#mbl-panel")).toBeNull();
  });
});
