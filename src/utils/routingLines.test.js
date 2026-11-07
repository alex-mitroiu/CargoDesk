import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { lineKey, lineChain, chainLabel, legKind, findDuplicateLines, findChainGaps, locationsOf, lineProblems, applyLegType,
  placesOf, legMissingPorts, LINE_ORDER_HELP } from "./routingLines";

const require = createRequire(import.meta.url);
const server = require("../../lib/routingLines.js");

const leg = (pol, pod, extra = {}) => ({ legType: "SEA", pol, pod, polLocType: "Terminal", podLocType: "Terminal", vesselService: "",
  polCarrierHaulage: false, podCarrierHaulage: false, polHaulageLocations: "", podHaulageLocations: "", movementBy: "", transitDays: 0, ...extra });
// Typed legs (2026-11-07): a Pick-up leg collects from its places, a Delivery leg delivers to them.
const pickup = (places, pod, extra = {}) => leg(places.split(" ")[0] || "", pod, { legType: "Pick-up", polHaulageLocations: places, polLocType: "Door", polCarrierHaulage: true, ...extra });
const delivery = (pol, places, extra = {}) => leg(pol, places.split(" ")[0] || "", { legType: "Delivery", podHaulageLocations: places, podLocType: "Door", podCarrierHaulage: true, ...extra });

describe("lineKey", () => {
  it("is the same key the server uses, so the editor and the save agree on duplicates", () => {
    const run = [pickup("nlams DEBER", "NLRTM", { movementBy: "Truck" }), leg("nlrtm", "BEANR", { vesselService: " AL1 " }), leg("BEANR", "USNYC"), delivery("USNYC", "USCHI", { podLocType: "CY" })];
    expect(lineKey(run)).toBe(server.lineKey(run));
  });
  it("differs when only the service code differs", () => {
    expect(lineKey([leg("NLRTM", "USNYC", { vesselService: "AL1" })])).not.toBe(lineKey([leg("NLRTM", "USNYC", { vesselService: "AL5" })]));
  });
  it("differs when only the pick-up's mode differs (a barge price isn't a truck price)", () => {
    const by = m => [pickup("VNSGN", "VNVUT", { movementBy: m }), leg("VNVUT", "USSAV")];
    expect(lineKey(by("Barge"))).not.toBe(lineKey(by("Truck")));
  });
});

describe("lineProblems: the order on a contract line, the same messages as the server", () => {
  const cases = [
    [[pickup("NLAMS", "NLRTM"), leg("NLRTM", "USNYC"), delivery("USNYC", "USCHI")], []],
    [[leg("NLRTM", "USNYC"), pickup("NLAMS", "NLRTM")], ["The Pick-up leg comes first, before the SEA legs."]],
    [[pickup("NLAMS", "NLRTM"), pickup("DEBER", "NLRTM"), leg("NLRTM", "USNYC")], ["A line has at most one Pick-up leg."]],
    [[delivery("USNYC", "USCHI"), leg("NLRTM", "USNYC")], ["The Delivery leg comes last, after the SEA legs."]],
    [[pickup("NLAMS", "NLRTM")], ["A line needs at least one SEA leg."]],
    [[pickup("VNSGN", "VNVUT"), leg("VNCMT", "USSAV")], ["The Pick-up leg ends at VNVUT, but the leg after it loads at VNCMT."]],
  ];
  it.each(cases.map((c, i) => [i, ...c]))("case %i", (_, legs, expected) => {
    expect(lineProblems(legs)).toEqual(expected);
    expect(server.lineProblems(legs)).toEqual(expected);
  });
  it("has the same order help as the server", () => {
    expect(LINE_ORDER_HELP).toBe(server.LINE_ORDER_HELP);
  });
});

describe("applyLegType: the editor's Leg dropdown", () => {
  it("turns a leg into the Pick-up leg and puts it first, its port becoming its place", () => {
    const r = applyLegType([leg("NLRTM", "USNYC"), leg("NLAMS", "NLRTM")], 1, "Pick-up");
    expect(r.legs.map(l => [l.legType, l.pol, l.pod])).toEqual([["Pick-up", "NLAMS", "NLRTM"], ["SEA", "NLRTM", "USNYC"]]);
    expect(r.legs[0]).toMatchObject({ polHaulageLocations: "NLAMS", polLocType: "Door", polCarrierHaulage: true });
  });
  it("puts a Delivery leg last", () => {
    const r = applyLegType([leg("USNYC", "USCHI"), leg("NLRTM", "USNYC")], 0, "Delivery");
    expect(r.legs.map(l => l.legType)).toEqual(["SEA", "Delivery"]);
  });
  it("refuses a second Pick-up leg on one line, with what's wrong and the order", () => {
    const r = applyLegType([pickup("NLAMS", "NLRTM"), leg("DEBER", "NLRTM"), leg("NLRTM", "USNYC")], 1, "Pick-up");
    expect(r.legs).toBeUndefined();
    expect(r.refused[0]).toMatch(/at most one Pick-up leg/);
    expect(r.refused[1]).toBe(LINE_ORDER_HELP);
  });
  it("turning a Pick-up leg back to SEA clears its haulage", () => {
    const r = applyLegType([pickup("NLAMS", "NLRTM", { movementBy: "Truck" }), leg("NLRTM", "USNYC")], 0, "SEA");
    expect(r.legs[0]).toMatchObject({ legType: "SEA", polHaulageLocations: "", polCarrierHaulage: false, movementBy: "", polLocType: "Terminal" });
  });
});

describe("lineChain", () => {
  it("reads PKU (its places, kind and mode), POL, via origin, POD from typed legs", () => {
    const c = lineChain([pickup("NLAMS DEBER", "NLRTM", { movementBy: "Truck" }), leg("NLRTM", "BEANR"), leg("BEANR", "USLAX")]);
    expect(c).toMatchObject({ pku: "NLAMS DEBER · Door · Truck", pol: "NLRTM", viaOrigin: "BEANR", viaDestination: null, pod: "USLAX", del: null });
    expect(chainLabel(c)).toBe("NLRTM → BEANR → USLAX");
  });
  it("shows a Pick-up leg with no place as 'any', and a CY delivery as CY", () => {
    const c = lineChain([pickup("", "NLRTM"), leg("NLRTM", "USNYC"), delivery("USNYC", "USNYC", { podLocType: "Container Yard" })]);
    expect(c).toMatchObject({ pku: "any · Door", del: "USNYC · CY" });
  });
  it("reads the barge example: Pick-up VNSGN by Barge to VNVUT, SEA VNVUT → USSAV", () => {
    const c = lineChain([pickup("VNSGN", "VNVUT", { movementBy: "Barge" }), leg("VNVUT", "USSAV")]);
    expect(c).toMatchObject({ pku: "VNSGN · Door · Barge", pol: "VNVUT", pod: "USSAV" });
  });
  it("shows the first and last transshipment port when there are several", () => {
    const c = lineChain([leg("CNCKG", "CNSHA"), leg("CNSHA", "SGSIN"), leg("SGSIN", "NLRTM"), leg("NLRTM", "SEGOT")]);
    expect(c).toMatchObject({ pol: "CNCKG", viaOrigin: "CNSHA", viaDestination: "NLRTM", pod: "SEGOT" });
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
  it("reads the leg's type, not its ports", () => {
    const legs = [pickup("DEDUI", "NLRTM"), leg("NLRTM", "USNYC"), delivery("USNYC", "USCHI")];
    expect([0, 1, 2].map(i => legKind(legs, i))).toEqual(["pre", "sea", "on"]);
  });
  it("a same-port leg typed SEA stays SEA", () => {
    expect(legKind([leg("NLRTM", "NLRTM"), leg("NLRTM", "USNYC")], 0)).toBe("sea");
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
  it("ignores a line that is still being filled in, but not a Pick-up leg collecting anywhere", () => {
    const legs = [{ ...leg("NLRTM", "USNYC"), routingIndex: 0 }, { ...leg("NLRTM", ""), routingIndex: 1 },
      { ...pickup("", "NLRTM"), routingIndex: 2 }, { ...leg("NLRTM", "USNYC"), routingIndex: 2 },
      { ...pickup("", "NLRTM"), routingIndex: 3 }, { ...leg("NLRTM", "USNYC"), routingIndex: 3 }];
    expect(findDuplicateLines(4, legs)).toEqual({ 3: 2 });
  });
});

describe("findChainGaps / placesOf / legMissingPorts / locationsOf", () => {
  it("flags a leg that doesn't load where the previous one discharged", () => {
    expect(findChainGaps([leg("NLRTM", "BEANR"), leg("DEHAM", "USNYC")])).toEqual([{ afterLegPos: 1, prevPod: "BEANR", nextPol: "DEHAM" }]);
  });
  it("lists a Pick-up leg's places, several allowed", () => {
    expect(placesOf(pickup("NLAMS DEBER", "NLRTM"))).toEqual(["NLAMS", "DEBER"]);
    expect(placesOf(leg("NLRTM", "USNYC"))).toEqual([]);
  });
  it("lets a Pick-up leg's From and a Delivery leg's To stay blank, nothing else", () => {
    expect(legMissingPorts(pickup("", "NLRTM"))).toBe(false);
    expect(legMissingPorts(delivery("USNYC", ""))).toBe(false);
    expect(legMissingPorts(leg("NLRTM", ""))).toBe(true);
    expect(legMissingPorts(pickup("", ""))).toBe(true);
  });
  it("splits locations on spaces and commas", () => {
    expect(locationsOf(" nlams, nlrtm ")).toEqual(["NLAMS", "NLRTM"]);
  });
});
