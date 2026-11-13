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

import ShipmentQaExportModal, { ImportedShipmentBanner, ImportedChip } from "./ShipmentQaExport";
import { api } from "../../api";

// SHP-AQ1FIM as the database holds it (2026-11-13): GET /api/shipments/:id/qa-export.
const contents = {
  shipmentId: "SHP-AQ1FIM",
  parts: [{ table: "containers", label: "containers", count: 2 }, { table: "vgm_declarations", label: "VGM declarations", count: 3 },
    { table: "edi_messages", label: "carrier messages", count: 10 }, { table: "shipment_events", label: "history events", count: 23 }],
  context: [{ table: "tickets", count: 6 }],
  files: [{ filename: "VG01-SHP-AQ1FIM-MSKU7743215.pdf", docType: "VG01", sizeBytes: 118668, onDisk: true }, { filename: "WB-RTM-2026-10871.pdf", docType: "VG02", sizeBytes: 101, onDisk: true }],
  references: { customers: [{ name: "Van Leeuwen Meubelen BV", roles: ["Shipper", "Principal"], countryIso2: "NL" }, { name: "Hudson Home Imports Inc", roles: ["Consignee", "Notify"], countryIso2: "US" }],
    offices: [{ code: "NL-NLW4FI-SE", name: "Verify Entity Office A", roles: ["export"] }, { code: "US-USNYC-SI", name: "New York Harbor", roles: ["import"] }],
    carriers: ["MAEU"], ports: ["NLRTM", "USNYC"], vessels: ["MAERSK KENSINGTON"], contract: "MAEU-SC-2026-0418" },
  estimatedBytes: 245000,
};

beforeEach(() => vi.clearAllMocks());

describe("Export for QA", () => {
  it("says the file holds real data, lists what goes in, and downloads it with the report", async () => {
    api.qaExport.contents.mockResolvedValue(contents);
    api.qaExport.download.mockResolvedValue("SHP-AQ1FIM-for-QA-2026-11-13.json");
    const onClose = vi.fn();
    render(<ShipmentQaExportModal shipment={{ id: "SHP-AQ1FIM" }} onClose={onClose} />);
    expect(screen.getByTestId("qa-export-warning")).toHaveTextContent("Real data.");
    const parts = await screen.findByTestId("qa-export-parts");
    expect(parts).toHaveTextContent("VGM declarations3");
    expect(parts).toHaveTextContent("Carrier messages10");
    expect(parts).toHaveTextContent("Documents (the files themselves): VG01-SHP-AQ1FIM-MSKU7743215.pdf, WB-RTM-2026-10871.pdf2");
    expect(parts).toHaveTextContent("For reading only: 6 tickets");
    expect(parts).toHaveTextContent("2 customers (Van Leeuwen Meubelen BV, Hudson Home Imports Inc), whole records · offices NL-NLW4FI-SE, US-USNYC-SI · carrier MAEU");
    expect(screen.getByTestId("qa-export-size")).toHaveTextContent("About 239 KB · recorded in the admin log");
    fireEvent.change(screen.getByTestId("qa-export-wrong"), { target: { value: "VG01 prints the old weight" } });
    fireEvent.change(screen.getByTestId("qa-export-steps"), { target: { value: "Open VGM\nChange the weight" } });
    fireEvent.click(screen.getByTestId("qa-export-download"));
    await waitFor(() => expect(api.qaExport.download).toHaveBeenCalledWith("SHP-AQ1FIM", { whatWentWrong: "VG01 prints the old weight", steps: "Open VGM\nChange the weight" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("An imported shipment", () => {
  const shipment = { id: "SHP-7QK2MD", importedFrom: "SHP-AQ1FIM", importedMeta: { system: "production", importedAt: "2026-11-13T10:05:00.000Z", importedBy: "Claude",
    exportedAt: "2026-11-13T09:42:00.000Z", exportedBy: { name: "Claude", email: "claudeagent@localhost" },
    report: { whatWentWrong: "VG01 prints the old weight", stepsToReproduce: ["Open VGM", "Change the weight"] } } };

  it("says where it came from, what went wrong, and that it sends nothing; the steps unfold", () => {
    render(<ImportedShipmentBanner shipment={shipment} />);
    const b = screen.getByTestId("shipment-imported-banner");
    expect(b).toHaveTextContent("Imported from production SHP-AQ1FIM on 13 Nov 2026");
    expect(b).toHaveTextContent("What went wrong: VG01 prints the old weight");
    expect(b).toHaveTextContent("Sending is off: no emails, EDI, webhooks or carrier messages");
    expect(screen.queryByTestId("shipment-imported-steps")).toBeNull();
    fireEvent.click(screen.getByTestId("shipment-imported-steps-toggle"));
    expect(screen.getByTestId("shipment-imported-steps")).toHaveTextContent("Open VGMChange the weight");
  });

  it("shows nothing for a shipment that wasn't imported; the chip reads IMPORTED", () => {
    const { container } = render(<ImportedShipmentBanner shipment={{ id: "SHP-AQ1FIM", importedFrom: "" }} />);
    expect(container).toBeEmptyDOMElement();
    render(<ImportedChip />);
    expect(screen.getByTestId("shipment-imported-chip")).toHaveTextContent("IMPORTED");
  });
});
