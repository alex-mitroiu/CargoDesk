import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mirror the REAL api.js's shape (every leaf resolves []), so a wrong method name fails here as it would in the app.
vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k, typeof v === "function" ? vi.fn().mockResolvedValue([]) : (v && typeof v === "object") ? mockDeep(v) : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});

import ShipmentImportPanel from "./ShipmentImportPanel";
import { api } from "../api";

// A real export (SHP-AQ1FIM) read by a test system that doesn't have its export office or its consignee:
// POST /api/shipment-import/preview, as lib/shipment-transfer.js plan() answers.
const plan = (over = {}) => ({
  source: { system: "production", host: "cargodesk.example.com", shipmentId: "SHP-AQ1FIM", exportedAt: "2026-11-13T09:42:00.000Z", exportedBy: { name: "Claude" } },
  report: { whatWentWrong: "VG01 prints the old weight", stepsToReproduce: ["Open VGM", "Change the weight"] }, summary: "Shipment SHP-AQ1FIM …",
  version: { file: "0.91.14", here: "0.91.14", ok: true },
  shipment: { id: "SHP-AQ1FIM", status: "Active", route: "NLRTM → USNYC", carrier: "MAEU", shipper: "Van Leeuwen Meubelen BV", consignee: "Hudson Home Imports Inc" },
  offices: [
    { oldId: "OFF-W4FI", code: "NL-NLW4FI-SE", name: "Verify Entity Office A", roles: ["export"], department: "SE", required: true, role: "export", found: null, chosen: null },
    { oldId: "OFF-NYSI", code: "US-USNYC-SI", name: "New York Harbor", roles: ["import"], department: "SI", required: true, role: "import", found: { id: "OFF-NYSI", code: "US-USNYC-SI", name: "New York Harbor" }, chosen: null },
  ],
  customers: [
    { oldId: "CUS-VLM", name: "Van Leeuwen Meubelen BV", countryIso2: "NL", roles: ["Shipper", "Principal"], match: { id: "CUS-VLM", name: "Van Leeuwen Meubelen BV", by: "same name" }, identifiers: [], contacts: 0 },
    { oldId: "CUS-HHI", name: "Hudson Home Imports Inc", countryIso2: "US", roles: ["Consignee"], match: null, identifiers: ["LEI 5493001KJTIIGC8Y1R47"], contacts: 1 },
  ],
  mdm: [{ kind: "Carrier", value: "MAEU", found: true }, { kind: "Vessel", value: "MAERSK KENSINGTON", found: true }],
  kept: { contract: false, allocation: false, laneSteering: false, quote: false },
  counts: [{ table: "containers", label: "containers", count: 2 }, { table: "shipment_events", label: "history events", count: 23 }],
  files: [{ filename: "VG01-SHP-AQ1FIM-MSKU7743215.pdf", docType: "VG01", sizeBytes: 118668, included: true }],
  warnings: [],
  officeChoices: { export: [{ id: "OFF-RTM", code: "NL-NLRTM-SE", name: "Rotterdam Office" }, { id: "OFF-NYSE", code: "US-USNYC-SE", name: "New York Export Office" }], import: [] },
  ...over,
});
const file = { format: "cargodesk-shipment-export/1", shipment: { id: "SHP-AQ1FIM" }, sections: {} };
const choose = () => {
  const input = screen.getByTestId("shipment-import-file");
  const f = new File([JSON.stringify(file)], "SHP-AQ1FIM-for-QA-2026-11-13.json", { type: "application/json" });
  fireEvent.change(input, { target: { files: [f] } });
};

beforeEach(() => vi.clearAllMocks());

describe("Test Tools → Shipment Import", () => {
  it("reads the file, asks for the export office this system lacks, then imports", async () => {
    api.shipmentImport.status.mockResolvedValue({ production: false, allowed: true });
    api.shipmentImport.preview
      .mockResolvedValueOnce({ problems: ["The export office NL-NLW4FI-SE (Verify Entity Office A) isn't in this system: choose one of its export offices"], plan: plan() })
      .mockResolvedValueOnce({ problems: [], plan: plan({ offices: [{ ...plan().offices[0], chosen: { id: "OFF-RTM", code: "NL-NLRTM-SE", name: "Rotterdam Office" } }, plan().offices[1]] }) });
    api.shipmentImport.run.mockResolvedValue({ shipmentId: "SHP-7QK2MD", from: "SHP-AQ1FIM", createdCustomers: [{ id: "CUS-NEW", name: "Hudson Home Imports Inc" }], dropped: [], warnings: [] });
    api.shipments.get.mockResolvedValue({ id: "SHP-7QK2MD", importedFrom: "SHP-AQ1FIM" });
    const navigate = vi.fn(), onShipmentCreated = vi.fn();
    render(<ShipmentImportPanel navigate={navigate} onShipmentCreated={onShipmentCreated} />);
    await screen.findByTestId("shipment-import-panel");
    choose();
    expect(await screen.findByTestId("shipment-import-source")).toHaveTextContent("production (cargodesk.example.com)");
    expect(screen.getByTestId("shipment-import-report")).toHaveTextContent("VG01 prints the old weight");
    expect(screen.getByTestId("shipment-import-customer-CUS-HHI")).toHaveTextContent("Newcreated from the file with LEI 5493001KJTIIGC8Y1R47 and 1 contact");
    expect(screen.getByTestId("shipment-import-customer-CUS-VLM")).toHaveTextContent("Foundsame name: Van Leeuwen Meubelen BV is used");
    expect(screen.getByTestId("shipment-import-problems")).toHaveTextContent("choose one of its export offices");
    expect(screen.getByTestId("shipment-import-run")).toBeDisabled();
    fireEvent.change(screen.getByTestId("shipment-import-pick-export"), { target: { value: "OFF-RTM" } });
    await waitFor(() => expect(api.shipmentImport.preview).toHaveBeenLastCalledWith(file, { export: "OFF-RTM" }));
    await waitFor(() => expect(screen.getByTestId("shipment-import-run")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("shipment-import-run"));
    await waitFor(() => expect(api.shipmentImport.run).toHaveBeenCalledWith(file, { export: "OFF-RTM" }));
    expect(await screen.findByTestId("shipment-import-result")).toHaveTextContent("Imported as SHP-7QK2MD, marked IMPORTED.");
    // The app's list was loaded before it existed: it is added, so Open it finds it.
    await waitFor(() => expect(onShipmentCreated).toHaveBeenCalledWith({ id: "SHP-7QK2MD", importedFrom: "SHP-AQ1FIM" }));
    fireEvent.click(screen.getByText("Open it"));
    expect(navigate).toHaveBeenCalledWith("detail", "SHP-7QK2MD");
  });

  it("is off on a production server until an admin turns it on", async () => {
    api.shipmentImport.status.mockResolvedValue({ production: true, allowed: false });
    render(<ShipmentImportPanel navigate={vi.fn()} />);
    expect(await screen.findByTestId("shipment-import-off")).toHaveTextContent("App Settings → Shipment imports");
  });
});
