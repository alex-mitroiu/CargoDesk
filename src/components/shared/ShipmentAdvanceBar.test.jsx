import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// Mirror the REAL api.js's shape and default every leaf to "resolves []" — the same approach
// ShipmentHeaderBar.test.jsx uses, so a wrong method name fails here as it would in the app.
vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [
    k,
    typeof v === "function" ? vi.fn().mockResolvedValue([])
      : (v && typeof v === "object") ? mockDeep(v)
      : v,
  ]));
  return { ...actual, api: mockDeep(actual.api) };
});

import ShipmentAdvanceBar from "./ShipmentAdvanceBar";
import { api } from "../../api";
import { AuthContext } from "../../AuthContext";
import { emitServicesChanged } from "../../servicesBus";

const SHIPMENT = { id: "SHP-AQ1FIM", status: "Active", pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU" };
const SETTINGS = { shipment_sidebar_order: JSON.stringify([
  "shp-documents", "shp-overview", "shp-milestones", "shp-conditions", "shp-cargo", "shp-parties",
  "shp-booking-routing", "shp-export-services", "shp-import-services", "shp-accounting", "shp-history"]) };

const renderBar = (page, { navigate = vi.fn().mockResolvedValue(true), auth = {} } = {}) => {
  const view = render(
    <AuthContext.Provider value={{ isTradeManager: false, ...auth }}>
      <ShipmentAdvanceBar shipment={SHIPMENT} currentPage={page} appSettings={SETTINGS} navigate={navigate} />
    </AuthContext.Provider>,
  );
  const rerenderAt = next => view.rerender(
    <AuthContext.Provider value={{ isTradeManager: false, ...auth }}>
      <ShipmentAdvanceBar shipment={SHIPMENT} currentPage={next} appSettings={SETTINGS} navigate={navigate} />
    </AuthContext.Provider>,
  );
  return { navigate, rerenderAt };
};
const bar = () => screen.findByTestId("shipment-advance-bar");
const altRight = () => fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.style.removeProperty("--cd-advance-bar-w");
  api.services.list.mockResolvedValue([
    { id: "S1", shipmentId: SHIPMENT.id, side: "Export", serviceType: "VGM", status: "Requested" },
  ]);
  delete document.elementFromPoint;
});

describe("ShipmentAdvanceBar", () => {
  it("names the next row of the tree and opens it on click", async () => {
    const { navigate } = renderBar("detail");
    expect(await screen.findByTestId("shipment-advance-bar-next")).toHaveTextContent("Next · Milestones & Events");
    expect(await bar()).toHaveAttribute("aria-label", "Save and go to Milestones & Events");
    fireEvent.click(await bar());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("shipment-milestones", "SHP-AQ1FIM"));
  });

  it("shows the side for a service row, and a Review step advances like its Details step", async () => {
    renderBar("shipment-customs-filing-review");
    expect(await bar()).toHaveAttribute("aria-label", "Save and go to Export VGM");
    expect(screen.getByTestId("shipment-advance-bar-next")).toHaveTextContent("Next · VGM");
  });

  it("flashes red and stays put when the page's save check fails", async () => {
    const { navigate } = renderBar("shipment-containers", { navigate: vi.fn().mockResolvedValue(false) });
    fireEvent.click(await bar());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("shipment-parties", "SHP-AQ1FIM"));
    await waitFor(() => expect(screen.getByTestId("shipment-advance-bar")).toHaveAttribute("data-state", "error"));
  });

  it("is not there on the last row, and gives back its width when it goes", async () => {
    const { rerenderAt } = renderBar("shipment-accounting-gp");
    await bar();
    expect(document.documentElement.style.getPropertyValue("--cd-advance-bar-w")).toBe("46px");
    rerenderAt("shipment-history");
    await waitFor(() => expect(screen.queryByTestId("shipment-advance-bar")).toBeNull());
    expect(document.documentElement.style.getPropertyValue("--cd-advance-bar-w")).toBe("");
  });

  it("follows the viewer's own tree: a trade manager goes from the last service straight to History", async () => {
    renderBar("service-export-vgm", { auth: { isTradeManager: true } });
    expect(await screen.findByTestId("shipment-advance-bar-next")).toHaveTextContent("Next · History");
  });

  it("picks up a service ordered on Overview without a page switch", async () => {
    renderBar("shipment-customs-filing-details");
    expect(await screen.findByTestId("shipment-advance-bar-next")).toHaveTextContent("Next · VGM");
    api.services.list.mockResolvedValue([
      { id: "S1", shipmentId: SHIPMENT.id, side: "Export", serviceType: "VGM", status: "Requested" },
      { id: "S2", shipmentId: SHIPMENT.id, side: "Import", serviceType: "Delivery", status: "Requested" },
    ]);
    act(() => emitServicesChanged(SHIPMENT.id));
    await waitFor(() => expect(screen.getByTestId("shipment-advance-bar-next")).toHaveTextContent("Next · Delivery Service"));
  });

  it("Alt+→ advances when the bar is reachable, and not when a dialog covers it", async () => {
    const { navigate } = renderBar("detail");
    const button = await bar();
    const dialog = document.createElement("div");
    document.body.appendChild(dialog);

    document.elementFromPoint = () => dialog;
    altRight();
    expect(navigate).not.toHaveBeenCalled();

    document.elementFromPoint = () => button.querySelector(".cd-advbar-pill");
    altRight();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("shipment-milestones", "SHP-AQ1FIM"));
    dialog.remove();
  });
});
