import { describe, it, expect } from "vitest";
import { suggestAlternatives, isFull, containerCounts, availableTEU } from "./spaceSuggestions";

const contract = (ref, extra = {}) => ({
  contractNumber: "HLCU-2026-TATL-001", contractRef: ref, namedAccountId: "", namedAccount: "",
  containerTypes: ["20DC", "40DC", "40HC"], commodityTypes: "FAK", dgAllowed: false,
  oceanRates: { "20DC": { amount: 1050, currency: "USD" }, "40HC": { amount: 2150, currency: "USD" } }, ...extra,
});
const alloc = (id, remaining, c, extra = {}) => ({
  id, carrierCode: "HLCU", pol: "NLRTM", pod: "USNYC", remainingTEU: remaining, pendingTEU: 0, contract: c, ...extra,
});

const full = alloc("ALC-B", 0, contract("EUN-USEC-B", {
  namedAccountId: "CUST-NORDIC", namedAccount: "Nordic Home Retail AB",
  oceanRates: { "40HC": { amount: 2050, currency: "USD" } },
}), { pendingTEU: 4 });
const open = alloc("ALC-A", 50, contract("EUN-USEC-A"), { pendingTEU: 8 });
const reserved = alloc("ALC-R", 90, contract("EUN-USEC-R", { namedAccountId: "CUST-OTHER", namedAccount: "Other Buyer Ltd" }));
const small = alloc("ALC-S", 2, contract("EUN-USEC-S"));
const otherNumber = alloc("ALC-X", 200, contract("X", { contractNumber: "HLCU-2026-OTHER" }));
const shipment = {
  shipmentTEU: 4, principalId: "CUST-NORDIC", principalName: "Nordic Home Retail AB",
  containers: [{ size: "40", type: "HC" }, { size: "40", type: "HC" }],
};

describe("space suggestions", () => {
  it("treats a configuration as full when the shipment doesn't fit in the space left", () => {
    expect(isFull(full, 4)).toBe(true);
    expect(isFull(open, 4)).toBe(false);
    expect(isFull(full, 0)).toBe(false);
  });

  it("counts pending bookings against the space", () => {
    // 5 left before pending, 3 pending → only 2 available for a 4-TEU shipment.
    expect(isFull(alloc("ALC-P", 5, contract("P"), { pendingTEU: 3 }), 4)).toBe(true);
    expect(availableTEU(alloc("ALC-Q", 5, contract("Q"), { pendingTEU: 9 }))).toBe(0);
  });

  it("only offers references under the same carrier and contract number", () => {
    const ids = suggestAlternatives([full, open, reserved, small, otherNumber], full, shipment).map(s => s.alloc.id);
    expect(ids).not.toContain("ALC-X");
    expect(ids).not.toContain("ALC-B");
  });

  it("an open reference with space fits, and lists first", () => {
    const [first] = suggestAlternatives([full, open, reserved, small], full, shipment);
    expect(first.alloc.id).toBe("ALC-A");
    expect(first.fits).toBe(true);
    expect(first.checks.map(c => c.label)).toContain("42 TEU available (8 pending counted)");
  });

  it("a reference reserved for another account, or too small, doesn't fit and says why", () => {
    const byId = Object.fromEntries(suggestAlternatives([full, open, reserved, small], full, shipment).map(s => [s.alloc.id, s]));
    expect(byId["ALC-R"].fits).toBe(false);
    expect(byId["ALC-R"].checks.find(c => !c.ok).label).toBe("Reserved for Other Buyer Ltd");
    expect(byId["ALC-S"].checks.find(c => !c.ok).label).toBe("2 TEU available, shipment needs 4");
  });

  it("shows the ocean-freight difference for the shipment's own container mix", () => {
    const [first] = suggestAlternatives([full, open], full, shipment);
    expect(first.rateDelta).toEqual({ perType: { "40HC": 100 }, total: 200, currency: "USD" });
  });

  it("checks container types and DG against the contract", () => {
    const noHc = alloc("ALC-N", 40, contract("EUN-USEC-N", { containerTypes: ["20DC", "40DC"] }));
    const [s] = suggestAlternatives([full, noHc], full, { ...shipment, containers: [{ size: "40", type: "HC", isDg: true }] });
    expect(s.checks.filter(c => !c.ok).map(c => c.label)).toEqual(["No 40HC on this contract", "DG not allowed"]);
  });

  it("counts a 40GP as the contract's 40DC", () => {
    expect(containerCounts([{ size: "40", type: "GP" }, { size: "40", type: "DC" }])).toEqual({ "40DC": 2 });
  });
});
