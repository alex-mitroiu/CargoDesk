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

import CarrierMasterBlPanel, { stepText } from "./CarrierMasterBlPanel";
import { api } from "../../api";

const shipment = { id: "SHP-AQ1FIM", carrierCode: "MAEU", imoOfficeCode: "US-USNYC-SI", imoOfficeName: "New York Harbor" };
const PATH = steps => steps.map(([step, label, done = false, on = null]) => ({ step, label, done, at: done ? "2026-10-30T09:12:00.000Z" : null, detail: done ? { on } : null }));
// GET /api/shipments/:id/master-bl/custody, as lib/carrier-mbl.js view() returns it: Maersk's issued B/L, 3 paper originals.
const view = (over = {}) => ({
  number: "MAEU412841377LS", carrierCode: "MAEU",
  master: { reference: "MAEU412841377LS", status: "ISSUED", typeCode: "BOL", isElectronic: false, issueDate: "2026-10-29", shippedOnBoardDate: "2026-10-28",
    isToOrder: false, originals: 3, issuer: "MAEU demo carrier", shipper: "Van Leeuwen Meubelen BV", consignee: "Hudson Home Imports Inc",
    notify: ["Hudson Home Imports Inc"], containers: [{ number: "MSKU7743215", iso: "45G1", seals: ["ML-4471182"] }, { number: "MSKU7743220", iso: "45G1", seals: ["ML-4471183"] }] },
  pending: null, form: "PAPER", formSource: "carrier", originalsTotal: 3, ebl: { platform: "", reference: "", issuedTo: "" },
  print: null, canPrint: true, pdf: null, stage: "",
  path: PATH([["RECEIVED", "Received from the carrier"], ["SENT", "Sent to destination"], ["SURRENDERED", "Surrendered to the carrier"], ["RELEASED", "Released by the carrier"]]),
  next: [{ step: "RECEIVED", label: "Received from the carrier" }], released: false, locked: false, events: [],
  platforms: ["WAVE BL", "CargoX", "essDOCS", "Bolero", "edoxOnline", "IQAX eBL", "Other"],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("The carrier's Master B/L panel", () => {
  it("shows the carrier's issued B/L and prints it from its data", async () => {
    api.masterBl.custody.mockResolvedValue(view());
    api.masterBl.printCopy.mockResolvedValue(view({ print: { documentId: "DOC-P", filename: "MB01-MAEU412841377LS-copy.pdf", createdAt: "2026-11-10T10:00:00.000Z" } }));
    render(<CarrierMasterBlPanel shipment={shipment} canEdit />);
    expect(await screen.findByTestId("carrier-mbl-number")).toHaveTextContent("MAEU412841377LS · issued by MAEU 29 Oct 2026");
    expect(screen.getByTestId("carrier-mbl-status")).toHaveTextContent("ISSUED");
    expect(screen.getByTestId("carrier-mbl-form-chip")).toHaveTextContent("3 PAPER ORIGINALS");
    expect(screen.getByText("MSKU7743215 (45G1) · MSKU7743220 (45G1)")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("carrier-mbl-print"));
    await waitFor(() => expect(api.masterBl.printCopy).toHaveBeenCalledWith("SHP-AQ1FIM"));
    expect(await screen.findByTestId("carrier-mbl-print-doc")).toHaveTextContent("MB01-MAEU412841377LS-copy.pdf");
    expect(screen.getByTestId("carrier-mbl-print-doc")).toHaveTextContent("COPY · NOT NEGOTIABLE");
  });

  it("records the next step with what it needs", async () => {
    api.masterBl.custody.mockResolvedValue(view());
    api.masterBl.recordStep.mockResolvedValue(view({ stage: "RECEIVED", locked: true,
      next: [{ step: "SENT", label: "Sent to destination" }, { step: "SURRENDERED", label: "Surrendered at origin" }] }));
    render(<CarrierMasterBlPanel shipment={shipment} canEdit />);
    fireEvent.change(await screen.findByTestId("carrier-mbl-field-courier"), { target: { value: "DHL 4012 8833 21" } });
    fireEvent.change(screen.getByTestId("carrier-mbl-field-from"), { target: { value: "Maersk Rotterdam" } });
    fireEvent.click(screen.getByTestId("carrier-mbl-record"));
    await waitFor(() => expect(api.masterBl.recordStep).toHaveBeenCalled());
    const [, body] = api.masterBl.recordStep.mock.calls[0];
    expect(body).toMatchObject({ step: "RECEIVED", count: 3, from: "Maersk Rotterdam", courier: "DHL 4012 8833 21" });
    expect(body.on).toBe(new Date().toISOString().slice(0, 10));
    // After receiving: sent to destination, or surrendered at origin.
    expect(await screen.findByTestId("carrier-mbl-next-select")).toHaveValue("SENT");
    expect(screen.getByRole("option", { name: "Surrendered at origin" })).toBeInTheDocument();
    expect(screen.queryByTestId("carrier-mbl-setup")).toBeNull();
  });

  it("the carrier's PDF: what was found, and a container it names that isn't on the shipment", async () => {
    api.masterBl.custody.mockResolvedValue(view({ master: null, canPrint: false, pdf: { documentId: "DOC-F", filename: "MAEU412841377LS_copy.pdf", createdAt: "2026-11-10T10:00:00.000Z", by: "Dana",
      check: { readable: true, ok: false, blNumber: { value: "MAEU412841377LS", found: true },
        containers: [{ number: "MSKU7743215", found: true }, { number: "MSKU7743220", found: false }], others: ["MSKU7743299"], vessel: { value: "MAERSK KENSINGTON", found: true } } } }));
    render(<CarrierMasterBlPanel shipment={shipment} canEdit />);
    expect(await screen.findByTestId("carrier-mbl-check-bl")).toHaveTextContent("B/L number MAEU412841377LS found");
    expect(screen.getByTestId("carrier-mbl-check-MSKU7743220")).toHaveTextContent("Container MSKU7743220 not in the PDF");
    expect(screen.getByTestId("carrier-mbl-check-o-MSKU7743299")).toHaveTextContent("isn't on this shipment");
    expect(screen.getByTestId("carrier-mbl-status")).toHaveTextContent("FROM ITS PDF");
    expect(screen.queryByTestId("carrier-mbl-print")).toBeNull();
  });

  it("a scan is checked by eye, item by item", async () => {
    api.masterBl.custody.mockResolvedValue(view({ pdf: { documentId: "DOC-S", filename: "scan.pdf", createdAt: "2026-11-10T10:00:00.000Z",
      check: { readable: false, ok: false, blNumber: { value: "MAEU412841377LS", found: false }, containers: [{ number: "MSKU7743215", found: false }], others: [], vessel: { value: "", found: false } } } }));
    api.masterBl.checkPdf.mockResolvedValue(view());
    render(<CarrierMasterBlPanel shipment={shipment} canEdit />);
    expect(await screen.findByTestId("carrier-mbl-scan")).toHaveTextContent("No text in this PDF");
    fireEvent.click(screen.getByTestId("carrier-mbl-tick-blNumber:MAEU412841377LS"));
    fireEvent.click(screen.getByTestId("carrier-mbl-tick-container:MSKU7743215"));
    fireEvent.click(screen.getByText("Save what I checked"));
    await waitFor(() => expect(api.masterBl.checkPdf).toHaveBeenCalledWith("SHP-AQ1FIM",
      { byEye: { "blNumber:MAEU412841377LS": true, "container:MSKU7743215": true } }));
  });

  it("undoing the last step needs a reason; the history shows what was undone", async () => {
    api.masterBl.custody.mockResolvedValue(view({ stage: "RECEIVED", locked: true, next: [{ step: "SENT", label: "Sent to destination" }],
      events: [{ id: "E1", step: "RECEIVED", label: "Received from the carrier", detail: { on: "2026-10-30", count: 3, of: 3, from: "Maersk Rotterdam" }, actor: "Dana", createdAt: "2026-10-30T09:12:00.000Z", undone: false },
        { id: "E0", step: "SENT", label: "Sent to destination", detail: { on: "2026-10-30", to: "New York Harbor" }, actor: "Dana", createdAt: "2026-10-30T08:00:00.000Z", undone: true, undoneBy: "Dana", undoReason: "Wrong shipment" }] }));
    api.masterBl.undoStep.mockResolvedValue(view());
    render(<CarrierMasterBlPanel shipment={shipment} canEdit />);
    expect(await screen.findByTestId("carrier-mbl-history")).toHaveTextContent("3 of 3 originals received from Maersk Rotterdam, 30 Oct 2026");
    expect(screen.getByTestId("carrier-mbl-history")).toHaveTextContent("undone by Dana: Wrong shipment");
    fireEvent.click(screen.getByTestId("carrier-mbl-undo"));
    expect(screen.getByTestId("carrier-mbl-undo-confirm")).toBeDisabled();
    fireEvent.change(screen.getByTestId("carrier-mbl-undo-reason"), { target: { value: "Recorded too early" } });
    fireEvent.click(screen.getByTestId("carrier-mbl-undo-confirm"));
    await waitFor(() => expect(api.masterBl.undoStep).toHaveBeenCalledWith("SHP-AQ1FIM", "Recorded too early"));
  });

  it("an eBL: its platform and reference to record; a draft still at the carrier says where to review it", async () => {
    api.masterBl.custody.mockResolvedValue(view({ master: null, canPrint: false, pending: { reference: "MAEU412841377LS", status: "APPROVED" }, form: "EBL",
      path: PATH([["ISSUED", "Issued to you"], ["TRANSFERRED", "Transferred to destination"], ["SURRENDERED", "Surrendered to the carrier"], ["RELEASED", "Released by the carrier"]]),
      next: [{ step: "ISSUED", label: "Issued to you" }] }));
    api.masterBl.recordStep.mockResolvedValue(view());
    render(<CarrierMasterBlPanel shipment={shipment} canEdit />);
    expect(await screen.findByTestId("carrier-mbl-status")).toHaveTextContent("AT THE CARRIER · APPROVED");
    expect(screen.getByText(/review it there/)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("carrier-mbl-field-platform"), { target: { value: "WAVE BL" } });
    fireEvent.change(screen.getByTestId("carrier-mbl-field-reference"), { target: { value: "WAVE-BL-7Q4M2K9" } });
    fireEvent.click(screen.getByTestId("carrier-mbl-record"));
    await waitFor(() => expect(api.masterBl.recordStep).toHaveBeenCalledWith("SHP-AQ1FIM", expect.objectContaining({ step: "ISSUED", platform: "WAVE BL", reference: "WAVE-BL-7Q4M2K9" })));
  });

  it("words each step", () => {
    expect(stepText({ step: "SURRENDERED", detail: { count: 3, to: "Maersk Rotterdam", kind: "origin", on: "2026-10-30" } })).toBe("3 originals surrendered to Maersk Rotterdam at origin, 30 Oct 2026");
    expect(stepText({ step: "RELEASED", detail: { on: "2026-11-09", ref: "MNY-RL-55120" } })).toBe("Released by the carrier, 09 Nov 2026, ref MNY-RL-55120");
    expect(stepText({ step: "ISSUED", detail: { platform: "WAVE BL", reference: "WAVE-BL-7Q4M2K9", on: "2026-10-29" } })).toBe("eBL issued on WAVE BL (WAVE-BL-7Q4M2K9), 29 Oct 2026");
  });
});
