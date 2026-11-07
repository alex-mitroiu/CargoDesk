import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// Regression for a bug found live on #shipments/:id/schedules: clicking the header's Loop code opened a
// route modal that could not be closed — its × sat above the top of the window.
//
// Cause: #shphdr, the persistent shipment header card, sets `backdrop-filter: blur(22px)`, and a filtered
// element becomes the containing block for its `position: fixed` descendants. Every modal and drawer this
// component opens was rendered INSIDE that card, so "fixed" meant "fixed to the header card": the dimming
// overlay shrank to the card's box, the dialog was centred on it and ran off the top of the screen, and a
// drawer was pinned to the card's edge instead of the window's.
//
// jsdom does no layout, so the geometry itself can't be asserted here (the real-browser check did that). What
// CAN be asserted, and is the actual invariant, is where the overlays live in the DOM: never inside #shphdr.

// Mirror the REAL api.js's shape and default every leaf to "resolves []" — the same approach App.test.jsx uses,
// so a wrong method name fails here as it would in the app instead of being invented by a hand-written mock.
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

import ShipmentHeaderBar from "./ShipmentHeaderBar";
import { api } from "../../api";
import { AuthContext } from "../../AuthContext";

const SHIPMENT = {
  id: "SHP-TEST01", status: "Active", movementType: "FCL", pol: "NLRTM", pod: "USNYC",
  polName: "Rotterdam", podName: "New York", etd: "2026-09-21", eta: "2026-09-30",
  carrierCode: "HLCU", contractType: "Central", contractRef: "C-1", routingTerm: "PT-PT",
};
const LOOP = {
  id: "LP1", code: "AL1", name: "Atlantic Loop 1", carrierCode: "HLCU", roundTripDays: 56, frequencyDays: 7,
  ports: [
    { id: "p1", portUnlocode: "NLRTM", portName: "Rotterdam", direction: "EB", transitDayOffset: 0 },
    { id: "p2", portUnlocode: "USNYC", portName: "New York", direction: "EB", transitDayOffset: 9 },
    { id: "p3", portUnlocode: "USNYC", portName: "New York", direction: "WB", transitDayOffset: 20 },
    { id: "p4", portUnlocode: "NLRTM", portName: "Rotterdam", direction: "WB", transitDayOffset: 30 },
  ],
};

// A position:fixed element anywhere inside #shphdr is the bug, whatever it is.
const fixedInsideHeader = () =>
  [...document.getElementById("shphdr").querySelectorAll("*")].filter(el => el.style.position === "fixed");
const fixedOnPage = () =>
  [...document.body.querySelectorAll("*")].filter(el => el.style.position === "fixed");

const renderHeader = async () => {
  render(<ShipmentHeaderBar shipment={SHIPMENT} containers={[]} />);
  await screen.findByText("SHP-TEST01");
  return document.getElementById("shphdr");
};
const tile = key => screen.getByTestId(`shipment-detail-header-icon-${key}`).querySelector("button");

let realWebSocket;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.schedules.list.mockResolvedValue([{ id: "SCH1", service: "AL1", legs: [] }]);
  api.loopCodes.resolve.mockResolvedValue(LOOP);
  api.shipments.shareToken.mockResolvedValue({ url: "https://example.test/track/abc" });
  // the messages drawer opens a socket; jsdom's would try to reach a real server
  realWebSocket = global.WebSocket;
  global.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
});
afterEach(() => { global.WebSocket = realWebSocket; });

describe("ShipmentHeaderBar — overlays live outside the filtered header card", () => {
  it("opens the Loop route modal outside #shphdr, so it is laid out against the window", async () => {
    const header = await renderHeader();
    fireEvent.click(screen.getByText("Expand"));
    const loopField = await screen.findByTestId("shipment-detail-header-field-loop");
    await waitFor(() => expect(loopField).toHaveTextContent("AL1"));
    fireEvent.click(loopField);

    const modal = await screen.findByTestId("loop-route-modal");
    expect(header.contains(modal)).toBe(false);
    expect(fixedOnPage().length).toBeGreaterThan(0);            // the overlay really is on the page…
    expect(fixedInsideHeader()).toEqual([]);                    // …and none of it is inside the header
    await screen.findByText(/Atlantic Loop 1/);                 // the loop loaded, so this is the real dialog
  });

  it("closes that modal with its × button", async () => {
    await renderHeader();
    fireEvent.click(screen.getByText("Expand"));
    const loopField = await screen.findByTestId("shipment-detail-header-field-loop");
    await waitFor(() => expect(loopField).toHaveTextContent("AL1"));
    fireEvent.click(loopField);
    await screen.findByTestId("loop-route-modal");
    fireEvent.click(screen.getByText("×"));
    await waitFor(() => expect(screen.queryByTestId("loop-route-modal")).toBeNull());
  });

  it("opens the Customer Tracking Link modal outside #shphdr", async () => {
    const header = await renderHeader();
    fireEvent.click(tile("share"));
    const title = await screen.findByText("Customer Tracking Link");
    expect(header.contains(title)).toBe(false);
    expect(fixedOnPage().length).toBeGreaterThan(0);
    expect(fixedInsideHeader()).toEqual([]);
  });

  it("opens the Messages drawer outside #shphdr", async () => {
    const header = await renderHeader();
    fireEvent.click(tile("messages"));
    await waitFor(() => expect(fixedOnPage().length).toBeGreaterThan(0));
    expect(fixedInsideHeader()).toEqual([]);
    expect(header.nextElementSibling).not.toBeNull();           // the overlay is a sibling of the header card
  });

  it("opens the Tickets drawer outside #shphdr", async () => {
    const header = await renderHeader();
    fireEvent.click(tile("tickets"));
    const title = await screen.findByText("◩ Tickets");
    expect(header.contains(title)).toBe(false);
    expect(fixedInsideHeader()).toEqual([]);
  });

  it("keeps the header card itself sticky at the top with its filter — only the overlays moved out", async () => {
    const header = await renderHeader();
    expect(header.style.position).toBe("sticky");
    expect(header.style.top).toBe("0px");
    expect(header.style.zIndex).toBe("5");
    expect(header.style.backdropFilter).toContain("blur");     // still there, which is exactly why overlays must not be inside
  });
});

// What the header always shows (the user, 2026-11-06): Principal, Shipper, Consignee, Incoterm, the container
// count with the DG flag, POL with ETD/ATD and POD with ETA/ATA. ATD/ATA come from the sea legs' date sources.
describe("ShipmentHeaderBar — the always-visible facts (horizonNext: Contracts & Schedules only for now)", () => {
  const PARTIES = { ...SHIPMENT, principalName: "Van Leeuwen Meubelen BV", shipperName: "Van Leeuwen Meubelen BV",
    consigneeName: "Hudson Home Imports Inc", incoterm: "FOB" };
  const CTRS = [
    { id: "C1", shipmentId: "SHP-TEST01", size: "40", type: "HC", isDg: true, dgClass: "3" },
    { id: "C2", shipmentId: "SHP-TEST01", size: "40", type: "HC", isDg: false },
  ];
  const sea = (pol, pod, etdSource = "", etaSource = "") => ({ id: pol + pod, legType: "SEA", pol, pod, etdSource, etaSource });

  it("leads the folded row with Principal, Shipper, Consignee and Incoterm, in that order", async () => {
    render(<ShipmentHeaderBar horizonNext shipment={PARTIES} containers={[]} />);
    const row = await screen.findByTestId("shipment-detail-header-chip-row");
    const labels = [...row.children].map(el => el.dataset.testid.replace("shipment-detail-header-chip-", ""));
    expect(labels.slice(0, 4)).toEqual(["principal", "shipper", "consignee", "incoterm"]); // then the sailing facts (below)
    expect(screen.getByTestId("shipment-detail-header-chip-consignee")).toHaveTextContent("Hudson Home Imports Inc");
  });

  it("shows a dash, not a gap, for a party that isn't set", async () => {
    render(<ShipmentHeaderBar horizonNext shipment={{ ...PARTIES, principalName: "" }} containers={[]} />);
    expect(await screen.findByTestId("shipment-detail-header-chip-principal")).toHaveTextContent("Principal —");
  });

  it("shows the containers as 2×40HC with the TEU under them, and the DG class beside the route with its meaning", async () => {
    render(<ShipmentHeaderBar horizonNext shipment={PARTIES} containers={CTRS} />);
    const block = await screen.findByTestId("shipment-detail-header-containers");
    expect(block).toHaveTextContent("2×40HC4 TEU");
    const dg = screen.getByTestId("shipment-detail-header-dg-badge");
    expect(dg).toHaveTextContent("DG · CLASS 3");
    expect(dg).toHaveTextContent("Flammable Liquids");
    expect(block.contains(dg)).toBe(false);
  });

  it("says 6 containers when the types differ", async () => {
    render(<ShipmentHeaderBar horizonNext shipment={PARTIES} containers={[CTRS[0], { ...CTRS[1], size: "20", type: "GP" }]} />);
    expect(await screen.findByTestId("shipment-detail-header-containers")).toHaveTextContent("2 containers3 TEU");
  });

  it("gives the carrier's code, the main vessel, its voyage and the service, and no contract", async () => {
    render(<ShipmentHeaderBar horizonNext shipment={{ ...PARTIES, carrierCode: "HLCU", vessel: "DEMO FANFARE", voyage: "DM006W" }} containers={[]} />);
    const row = await screen.findByTestId("shipment-detail-header-chip-row");
    const labels = [...row.children].map(el => el.dataset.testid.replace("shipment-detail-header-chip-", ""));
    expect(labels).toEqual(["principal", "shipper", "consignee", "incoterm", "carrier", "vessel", "voyage", "service"]);
    expect(screen.getByTestId("shipment-detail-header-chip-carrier")).toHaveTextContent("Carrier HLCU");
    expect(screen.getByTestId("shipment-detail-header-chip-vessel")).toHaveTextContent("Vessel DEMO FANFARE");
    await waitFor(() => expect(screen.getByTestId("shipment-detail-header-chip-service")).toHaveTextContent("Service AL1"));
    expect(row).not.toHaveTextContent("Contract");
  });

  it("puts the transshipment ports and the transit time under the route", async () => {
    api.legs.list.mockResolvedValue([sea("NLRTM", "BEANR"), sea("BEANR", "USNYC")]);
    render(<ShipmentHeaderBar horizonNext shipment={PARTIES} containers={[]} />);
    await waitFor(() => expect(screen.getByTestId("shipment-detail-header-route-via")).toHaveTextContent("via BEANR · 9 days transit"));
  });

  it("has no DG flag when no container is dangerous goods", async () => {
    render(<ShipmentHeaderBar horizonNext shipment={PARTIES} containers={[CTRS[1]]} />);
    await screen.findByTestId("shipment-detail-header-containers");
    expect(screen.queryByTestId("shipment-detail-header-dg-badge")).toBeNull();
  });

  it("reads ETD and ETA while the sea legs' dates are estimates", async () => {
    api.legs.list.mockResolvedValue([sea("NLRTM", "BEANR"), sea("BEANR", "USNYC")]);
    render(<ShipmentHeaderBar horizonNext shipment={PARTIES} containers={[]} />);
    const route = await screen.findByTestId("shipment-detail-header-route");
    await waitFor(() => expect(api.legs.list).toHaveBeenCalled());
    expect(route).toHaveTextContent("ETD 21 Sep");
    expect(route).toHaveTextContent("ETA 30 Sep");
  });

  it("reads ATD once the first sea leg departed for real, and ATA once the last one arrived", async () => {
    api.legs.list.mockResolvedValue([sea("NLRTM", "BEANR", "ais", "ais"), sea("BEANR", "USNYC", "", "dcsa_actual")]);
    render(<ShipmentHeaderBar horizonNext shipment={PARTIES} containers={[]} />);
    const route = await screen.findByTestId("shipment-detail-header-route");
    await waitFor(() => expect(route).toHaveTextContent("ATD 21 Sep"));
    expect(route).toHaveTextContent("ATA 30 Sep");
  });

  it("keeps the classic header on every other page: route block, DG badge with its meaning, the classic folded row", async () => {
    render(<ShipmentHeaderBar shipment={PARTIES} containers={CTRS} />);
    const badge = await screen.findByTestId("shipment-detail-header-dg-badge");
    expect(badge).toHaveTextContent("DG · CLASS 3");
    expect(badge).toHaveTextContent("Flammable Liquids");
    expect(screen.queryByTestId("shipment-detail-header-containers")).toBeNull();
    expect(screen.queryByTestId("shipment-detail-header-chip-principal")).toBeNull();
    expect(screen.getByTestId("shipment-detail-header-chip-shipper")).toHaveTextContent("Van Leeuwen Meubelen BV");
  });
});

// Completed and Cancelled shipments are locked (TKT-SPXTGR): the header drops its Edit action and says why.
describe("ShipmentHeaderBar — Completed / Cancelled lock", () => {
  const renderAs = async status => {
    render(
      <AuthContext.Provider value={{ canEditShipments: true, isAdmin: true, activeRoles: ["admin"], shipmentLock: null }}>
        <ShipmentHeaderBar shipment={{ ...SHIPMENT, status }} containers={[]} onEdit={() => {}} />
      </AuthContext.Provider>
    );
    await screen.findByText("SHP-TEST01");
  };

  it("offers Edit on an open shipment, with no lock badge", async () => {
    await renderAs("Active");
    expect(screen.getByTestId("shipment-detail-header-icon-edit")).toBeInTheDocument();
    expect(screen.queryByTestId("shipment-detail-header-status-lock-badge")).toBeNull();
  });

  it.each(["Completed", "Cancelled"])("hides Edit and shows the lock badge on a %s shipment", async status => {
    await renderAs(status);
    expect(screen.queryByTestId("shipment-detail-header-icon-edit")).toBeNull();
    expect(screen.getByTestId("shipment-detail-header-status-lock-badge")).toHaveTextContent(`${status} · locked`);
  });
});
