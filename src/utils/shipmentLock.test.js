import { describe, it, expect } from "vitest";
import { isShipmentLocked, LOCKED_SHIPMENT_STATUSES } from "./shipmentLock";
import { canEditShipmentSide } from "./officeSide";

// Completed and Cancelled shipments are locked (TKT-SPXTGR). The server refuses every locked write on
// its own (tests/shipment-status-lock.test.js); these pin the client mirror that decides what the UI offers.

describe("isShipmentLocked", () => {
  it("locks Completed and Cancelled, and nothing else", () => {
    expect(LOCKED_SHIPMENT_STATUSES).toEqual(["Completed", "Cancelled"]);
    expect(isShipmentLocked({ status: "Completed" })).toBe(true);
    expect(isShipmentLocked({ status: "Cancelled" })).toBe(true);
    for (const status of ["Active", "Pending", "Requires Review", "", undefined])
      expect(isShipmentLocked({ status })).toBe(false);
  });

  it("treats a missing shipment as unlocked rather than throwing", () => {
    expect(isShipmentLocked(null)).toBe(false);
    expect(isShipmentLocked(undefined)).toBe(false);
  });
});

describe("canEditShipmentSide — the gate every side-gated shipment page uses", () => {
  const admin = { canEditShipments: true, isAdmin: true, activeRoles: ["admin"] };

  it("an admin can edit either side of an open shipment", () => {
    expect(canEditShipmentSide(admin, { status: "Active" }, "export")).toBe(true);
    expect(canEditShipmentSide(admin, { status: "Active" }, "import")).toBe(true);
  });

  it("nobody can edit either side of a Completed or Cancelled shipment, admins included", () => {
    for (const status of ["Completed", "Cancelled"]) {
      expect(canEditShipmentSide(admin, { status }, "export")).toBe(false);
      expect(canEditShipmentSide(admin, { status }, "import")).toBe(false);
      expect(canEditShipmentSide({ canEditShipments: true, activeRoles: ["operator"] }, { status }, "export")).toBe(false);
    }
  });

  it("a role without edit rights stays read-only whatever the status", () => {
    expect(canEditShipmentSide({ canEditShipments: false, isAdmin: true }, { status: "Active" }, "export")).toBe(false);
  });
});
