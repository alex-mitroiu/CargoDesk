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
