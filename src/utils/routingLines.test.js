import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { lineKey, lineChain, chainLabel, legKind, findDuplicateLines, findChainGaps, tooManyLocations, locationsOf } from "./routingLines";

const require = createRequire(import.meta.url);
const server = require("../../lib/routingLines.js");

const leg = (pol, pod, extra = {}) => ({ pol, pod, polLocType: "Terminal", podLocType: "Terminal", vesselService: "",
  polCarrierHaulage: false, podCarrierHaulage: false, polHaulageLocations: "", podHaulageLocations: "", transitDays: 0, ...extra });

describe("lineKey", () => {
  it("is the same key the server uses, so the editor and the save agree on duplicates", () => {
    const run = [leg("nlrtm", "BEANR", { vesselService: " AL1 ", polCarrierHaulage: true, polLocType: "Door", polHaulageLocations: "nlams" }), leg("BEANR", "USNYC")];
    expect(lineKey(run)).toBe(server.lineKey(run));
  });
  it("differs when only the service code differs", () => {
    expect(lineKey([leg("NLRTM", "USNYC", { vesselService: "AL1" })])).not.toBe(lineKey([leg("NLRTM", "USNYC", { vesselService: "AL5" })]));
  });
});

describe("lineChain", () => {
  it("reads PKU, POL, via origin, POD from a pre-carriage + two sea legs (HLCU-EUN_USWC_0001)", () => {
    const c = lineChain([
      leg("NLRTM", "NLRTM", { polLocType: "Door", polCarrierHaulage: true }),
      leg("NLRTM", "BEANR"), leg("BEANR", "USLAX"),
    ]);
    expect(c).toMatchObject({ pku: "Door · NLRTM", pol: "NLRTM", viaOrigin: "BEANR", viaDestination: null, pod: "USLAX", del: null });
    expect(chainLabel(c)).toBe("NLRTM → BEANR → USLAX");
  });
  it("shows the first and last transshipment port when there are several", () => {
    const c = lineChain([leg("CNCKG", "CNSHA"), leg("CNSHA", "SGSIN"), leg("SGSIN", "NLRTM"), leg("NLRTM", "SEGOT")]);
    expect(c).toMatchObject({ pol: "CNCKG", viaOrigin: "CNSHA", viaDestination: "NLRTM", pod: "SEGOT" });
  });
  it("takes the pick-up and delivery from a door-to-door leg's single locations", () => {
    const c = lineChain([leg("NLRTM", "USNYC", { polLocType: "Door", podLocType: "Door", polCarrierHaulage: true, podCarrierHaulage: true, polHaulageLocations: "DEBER", podHaulageLocations: "usla x".replace(" ", "") })]);
    expect(c).toMatchObject({ pku: "DEBER", pol: "NLRTM", pod: "USNYC", del: "USLAX", viaOrigin: null });
  });
  it("sums transit days and collects service codes", () => {
    const c = lineChain([leg("NLRTM", "BEANR", { transitDays: 2, vesselService: "AL1" }), leg("BEANR", "USNYC", { transitDays: 9, vesselService: "AL1" })]);
    expect(c.transitDays).toBe(11);
    expect(c.services).toEqual(["AL1"]);
  });
  it("returns null for a line with no ports yet", () => {
    expect(lineChain([leg("", "")])).toBeNull();
  });
});

describe("legKind", () => {
  it("labels same-port legs at the ends as pre- and on-carriage", () => {
    const legs = [leg("DEDUI", "DEDUI"), leg("NLRTM", "USNYC"), leg("USCHI", "USCHI")];
    expect([0, 1, 2].map(i => legKind(legs, i))).toEqual(["pre", "sea", "on"]);
  });
  it("treats a single leg as sea", () => {
    expect(legKind([leg("NLRTM", "NLRTM")], 0)).toBe("sea");
  });
});

describe("findDuplicateLines", () => {
  it("points a repeated line at the first one", () => {
    const legs = [
      { ...leg("NLRTM", "USNYC"), routingIndex: 0 },
      { ...leg("DEHAM", "USNYC"), routingIndex: 1 },
      { ...leg("NLRTM", "USNYC"), routingIndex: 2 },
    ];
    expect(findDuplicateLines(3, legs)).toEqual({ 2: 0 });
  });
  it("ignores a line that is still being filled in", () => {
    const legs = [{ ...leg("NLRTM", "USNYC"), routingIndex: 0 }, { ...leg("NLRTM", ""), routingIndex: 1 }];
    expect(findDuplicateLines(2, legs)).toEqual({});
  });
});

describe("findChainGaps / tooManyLocations / locationsOf", () => {
  it("flags a leg that doesn't load where the previous one discharged", () => {
    expect(findChainGaps([leg("NLRTM", "BEANR"), leg("DEHAM", "USNYC")])).toEqual([{ afterLegPos: 1, prevPod: "BEANR", nextPol: "DEHAM" }]);
  });
  it("allows one pick-up and one delivery location, not two", () => {
    expect(tooManyLocations([leg("NLRTM", "USNYC", { polCarrierHaulage: true, polHaulageLocations: "DEBER" })])).toBeNull();
    expect(tooManyLocations([leg("NLRTM", "USNYC", { polCarrierHaulage: true, polHaulageLocations: "DEBER NLAMS" })])).toBe("pick-up");
    expect(tooManyLocations([leg("NLRTM", "USNYC", { podCarrierHaulage: true, podHaulageLocations: "USLAX,USCHI" })])).toBe("delivery");
  });
  it("splits locations on spaces and commas", () => {
    expect(locationsOf(" nlams, nlrtm ")).toEqual(["NLAMS", "NLRTM"]);
  });
});
