import { describe, it, expect } from "vitest";
import {
  DEFAULT_SIDEBAR_ORDER, sidebarOrderFromSettings, orderedServiceTypes, shipmentNavSequence, nextNavStop,
} from "./shipmentNavSequence";

// The order saved by the admin on this install (Cargo before Parties & Offices) — the » Advance
// bar follows whatever is saved, so the tests use the saved order, not the default.
const SAVED_ORDER = ["shp-documents", "shp-overview", "shp-milestones", "shp-conditions", "shp-cargo", "shp-parties",
  "shp-booking-routing", "shp-export-services", "shp-import-services", "shp-accounting", "shp-history"];
const SETTINGS = { shipment_sidebar_order: JSON.stringify(SAVED_ORDER) };

// Services as GET /api/shipments/:id/services maps them (lib/mappers.js mapService).
const svc = (side, serviceType, status = "Requested") => ({ id: `${side}-${serviceType}`, shipmentId: "SHP-AQ1FIM", side, serviceType, status });
const SERVICES = [
  svc("Export", "Fumigation"), svc("Export", "VGM", "Confirmed"),       // shown in SERVICE_TYPES order: VGM first
  svc("Import", "Delivery"), svc("Import", "Unloading"),
  svc("Import", "Storage", "Cancelled"),                                // cancelled: no row
  svc("Export", "Other"),                                               // "Other" never gets a row
];

const keys = seq => seq.map(row => row.pageKeys[0]);

describe("shipmentNavSequence — the sidebar tree as one list of stops", () => {
  it("walks the admin-saved order, a group's rows one by one, groups themselves not stops", () => {
    const seq = shipmentNavSequence({ order: sidebarOrderFromSettings(SETTINGS), services: SERVICES, isTradeManager: false });
    expect(keys(seq)).toEqual([
      "shipment-documents", "detail", "shipment-milestones", "shipment-conditions", "shipment-containers", "shipment-parties",
      "shipment-schedules", "shipment-carrier-booking-details", "shipment-shipping-instructions", "shipment-arrival-notice",
      "shipment-customs-filing-details", "service-import-delivery",
      "service-export-vgm", "service-export-fumigation",
      "service-import-unloading",
      "shipment-accounting-invoices", "shipment-accounting-costs", "shipment-accounting-gp",
      "shipment-history",
    ]);
    expect(seq.map(r => r.label).slice(0, 6))
      .toEqual(["Documents", "Overview", "Milestones & Events", "Conditions", "Cargo", "Parties & Offices"]);
    expect(seq.find(r => r.id === "service-import-delivery").label).toBe("Delivery Service");
  });

  it("leaves out Accounting for a trade manager, and a services group with nothing ordered", () => {
    const seq = shipmentNavSequence({ order: SAVED_ORDER, services: [svc("Export", "VGM")], isTradeManager: true });
    expect(keys(seq).slice(-3)).toEqual(["shipment-customs-filing-details", "service-export-vgm", "shipment-history"]);
    expect(keys(seq).some(k => k.startsWith("shipment-accounting"))).toBe(false);
    expect(keys(seq).some(k => k.startsWith("service-import"))).toBe(false);
  });

  it("shows no service rows while the services are still loading", () => {
    expect(orderedServiceTypes(null, "Export")).toEqual([]);
    expect(keys(shipmentNavSequence({ order: SAVED_ORDER, services: null })).some(k => k.startsWith("service-"))).toBe(false);
  });
});

describe("nextNavStop — where » goes", () => {
  const seq = shipmentNavSequence({ order: SAVED_ORDER, services: SERVICES });

  it("is the plain next row: from Overview, even right after ordering a service, it's Milestones & Events", () => {
    expect(nextNavStop(seq, "detail").pageKeys[0]).toBe("shipment-milestones");
  });

  it("counts a Review step as part of its row", () => {
    expect(nextNavStop(seq, "shipment-carrier-booking-details").pageKeys[0]).toBe("shipment-shipping-instructions");
    expect(nextNavStop(seq, "shipment-carrier-booking-review").pageKeys[0]).toBe("shipment-shipping-instructions");
    expect(nextNavStop(seq, "shipment-customs-filing-review").pageKeys[0]).toBe("service-import-delivery");
  });

  it("crosses from one group into the next block", () => {
    expect(nextNavStop(seq, "service-import-delivery").pageKeys[0]).toBe("service-export-vgm");
    expect(nextNavStop(seq, "service-import-unloading").pageKeys[0]).toBe("shipment-accounting-invoices");
  });

  it("has nothing after the last row, or for a page that isn't a row of this tree", () => {
    expect(nextNavStop(seq, "shipment-history")).toBeNull();
    expect(nextNavStop(seq, "service-import-storage")).toBeNull(); // its service was cancelled
    expect(nextNavStop(seq, "shipments")).toBeNull();
  });
});

describe("sidebarOrderFromSettings", () => {
  it("falls back to the default order when nothing (or garbage) is saved", () => {
    expect(sidebarOrderFromSettings({})).toEqual(DEFAULT_SIDEBAR_ORDER);
    expect(sidebarOrderFromSettings({ shipment_sidebar_order: "{not json" })).toEqual(DEFAULT_SIDEBAR_ORDER);
    expect(sidebarOrderFromSettings({ shipment_sidebar_order: "\"a string\"" })).toEqual(DEFAULT_SIDEBAR_ORDER);
  });

  it("drops ids that no longer exist and appends blocks the saved order predates", () => {
    const stale = ["shp-history", "shp-gone", "shp-overview"];
    const order = sidebarOrderFromSettings({ shipment_sidebar_order: JSON.stringify(stale) });
    expect(order.slice(0, 2)).toEqual(["shp-history", "shp-overview"]);
    expect(order).not.toContain("shp-gone");
    expect([...order].sort()).toEqual([...DEFAULT_SIDEBAR_ORDER].sort());
  });
});
