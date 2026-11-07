import { describe, it, expect, vi } from "vitest";

// What a shipment asks a contract for (deriveHaulageNeeds / haulageMatchParams, ShipmentFormPage.jsx): the side's
// Carrier's Haulage leg wherever it sits in the route (the user, 2026-11-07: "yes" — Merchant's Haulage comes before
// it on a pick-up and after it on a delivery), its outer end's place and kind, and its mode.
vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api");
  const mockDeep = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k,
    typeof v === "function" ? vi.fn().mockResolvedValue([]) : (v && typeof v === "object") ? mockDeep(v) : v]));
  return { ...actual, api: mockDeep(actual.api) };
});

import { deriveHaulageNeeds, haulageMatchParams, haulageChip } from "./ShipmentFormPage";

const leg = (legType, movementType, pol, polLocType, pod, podLocType, movementBy = "") => ({ legType, movementType, pol, polLocType, pod, podLocType, movementBy });
const SEA = leg("SEA", "SEA", "NLRTM", "Terminal", "USNYC", "Terminal");

describe("deriveHaulageNeeds", () => {
  it("the user's route: MH then CH on the pick-up, CH then MH on the delivery — asks for both CH legs' outer ends", () => {
    const h = deriveHaulageNeeds([
      leg("Pick-up", "Merchant's Haulage", "NLAMS", "Door", "NLRTM", "Container Yard"),
      leg("Pick-up", "Carrier's Haulage", "NLRTM", "Container Yard", "NLRTM", "Terminal"),
      SEA,
      leg("Delivery", "Carrier's Haulage", "USNYC", "Terminal", "USJEC", "Container Yard"),
      leg("Delivery", "Merchant's Haulage", "USJEC", "Container Yard", "USCHI", "Door"),
    ]);
    expect(h).toMatchObject({ needsPolHaulage: true, pkuLocation: "NLRTM", pkuLocType: "Container Yard",
      needsPodHaulage: true, delLocation: "USJEC", delLocType: "Container Yard" });
  });
  it("the barge example: a CH pick-up by Barge from a door at VNSGN asks for that mode", () => {
    const h = deriveHaulageNeeds([leg("Pick-up", "Carrier's Haulage", "VNSGN", "Door", "VNVUT", "Terminal", "Barge"),
      leg("SEA", "SEA", "VNVUT", "Terminal", "USSAV", "Terminal")]);
    expect(h).toMatchObject({ needsPolHaulage: true, pkuLocation: "VNSGN", pkuLocType: "Door", pkuMode: "Barge", needsPodHaulage: false });
    expect(haulageMatchParams(h)).toEqual({ needsPolHaulage: "1", pkuLocation: "VNSGN", pkuLocType: "Door", pkuMode: "Barge" });
    expect(haulageChip(h.pkuLocation, h.pkuLocType, h.pkuMode)).toBe("VNSGN · Door · Barge");
  });
  it("Merchant's Haulage alone asks the contract for nothing", () => {
    const h = deriveHaulageNeeds([leg("Pick-up", "Merchant's Haulage", "NLAMS", "Door", "NLRTM", "Terminal"), SEA]);
    expect(h.needsPolHaulage).toBe(false);
    expect(haulageMatchParams(h)).toEqual({});
  });
  it("a GPS pick-up point is a door", () => {
    const h = deriveHaulageNeeds([leg("Pick-up", "Carrier's Haulage", "", "GPS Coordinates", "NLRTM", "Terminal"), SEA]);
    expect(h.pkuLocType).toBe("Door");
  });
});
