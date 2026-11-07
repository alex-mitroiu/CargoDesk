import { describe, it, expect, vi, beforeEach } from "vitest";

// The real api names (src/api.js): legs.list and legs.saveRoute (PUT /shipments/:id/legs, the whole route at once).
vi.mock("../api", () => ({ api: { legs: { list: vi.fn(), saveRoute: vi.fn() } } }));
vi.mock("../toast", () => ({ toast: { success: vi.fn() } }));

import { api } from "../api";
import { applySailingToLegs } from "./applySailingToLegs";

const tsp = {
  carrier: "MAEU", pol: "AEDXB", pod: "NZWLG",
  legs: [
    { pol: "AEDXB", pod: "SGSIN", etd: "2026-11-09", eta: "2026-12-01", vesselName: "TSP HAPPY LEG1", voyageNumber: "THP1" },
    { pol: "SGSIN", pod: "NZWLG", etd: "2026-12-02", eta: "2026-12-10", vesselName: "TSP HAPPY LEG2", voyageNumber: "THP2" },
  ],
};
const seaLeg = over => ({ id: "LEG-1", legType: "SEA", movementType: "SEA", pol: "", pod: "", polName: "", podName: "",
  etd: null, eta: null, vessel: "", voyage: "", carrierCode: "MAEU", contractType: "SPOT", contractRef: "", ...over });

describe("applySailingToLegs, a two-leg (transshipment) sailing", () => {
  beforeEach(() => { api.legs.list.mockReset(); api.legs.saveRoute.mockReset(); api.legs.saveRoute.mockResolvedValue([]); });

  it("fills leg 1's port of loading when the existing sea leg has none (the blank leg, 2026-11-06)", async () => {
    api.legs.list.mockResolvedValue([seaLeg()]);
    await applySailingToLegs("SHP-1", tsp, { silent: true });
    const route = api.legs.saveRoute.mock.calls[0][1];
    expect(route.map(l => [l.pol, l.pod, l.vessel])).toEqual([
      ["AEDXB", "SGSIN", "TSP HAPPY LEG1"],
      ["SGSIN", "NZWLG", "TSP HAPPY LEG2"],
    ]);
    expect(route[0].id).toBe("LEG-1");
  });

  it("replaces a port of loading left over from an earlier sailing", async () => {
    api.legs.list.mockResolvedValue([seaLeg({ pol: "AEJEA", polName: "Jebel Ali", pod: "NZWLG" })]);
    await applySailingToLegs("SHP-1", tsp, { silent: true });
    const [first] = api.legs.saveRoute.mock.calls[0][1];
    expect(first.pol).toBe("AEDXB");
    expect(first.polName).toBe("");
  });

  it("keeps the port's name when the port of loading doesn't change", async () => {
    api.legs.list.mockResolvedValue([seaLeg({ pol: "AEDXB", polName: "Dubai", pod: "NZWLG" })]);
    await applySailingToLegs("SHP-1", tsp, { silent: true });
    expect(api.legs.saveRoute.mock.calls[0][1][0].polName).toBe("Dubai");
  });
});
