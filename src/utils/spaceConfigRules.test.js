import { describe, it, expect } from "vitest";
import { contractLines, loopsOf, lineOnLoop, commodityCodesOf, findClashes, periodProblems, periodDays, nextFreePeriod, overlappingConfigs } from "./spaceConfigRules";

const leg = (routingId, legOrder, pol, pod, vesselService = "") => ({ routingId, legOrder, pol, pod, vesselService, polLocType: "Terminal", podLocType: "Terminal" });
// Your VNVUT example: one reference, two lines, loops TPX (both) and PN3 (Long Beach only).
const contract = {
  id: "CNTR-EX", commodityTypes: "9999,002001",
  routings: [{ id: "R-LGB", name: "" }, { id: "R-SAV", name: "" }],
  legs: [leg("R-LGB", 0, "VNVUT", "USLGB", "TPX"), leg("R-LGB", 1, "VNVUT", "USLGB", "PN3"), leg("R-SAV", 2, "VNVUT", "USSAV", "TPX")],
};
const cfg = (id, extra) => ({ id, contractId: "CNTR-EX", effectiveDate: "2026-10-01", endDate: "2026-10-31", loopCode: "TPX", customerId: "", commodityCode: "9999", routingIds: ["R-LGB"], ...extra });

describe("contractLines / loops", () => {
  it("builds one entry per routing line with its chain and loops", () => {
    const lines = contractLines({ ...contract, legs: [leg("R-LGB", 0, "VNVUT", "USLGB", "TPX"), leg("R-SAV", 1, "VNVUT", "USSAV", "TPX")] });
    expect(lines.map(l => [l.id, l.label, l.loops])).toEqual([["R-LGB", "VNVUT → USLGB", ["TPX"]], ["R-SAV", "VNVUT → USSAV", ["TPX"]]]);
  });
  it("collects every loop and lets a line with no loop code go with any loop", () => {
    const lines = [{ loops: ["TPX", "PN3"] }, { loops: ["TPX"] }, { loops: [] }];
    expect(loopsOf(lines)).toEqual(["TPX", "PN3"]);
    expect(lineOnLoop(lines[1], "PN3")).toBe(false);
    expect(lineOnLoop(lines[2], "PN3")).toBe(true);
  });
  it("reads the contract's commodity codes, FAK when none", () => {
    expect(commodityCodesOf(contract)).toEqual(["9999", "002001"]);
    expect(commodityCodesOf({ commodityTypes: "" })).toEqual(["9999"]);
  });
});

describe("findClashes — duplicates are per routing line", () => {
  const configs = [cfg("ALC-1"), cfg("ALC-2", { customerId: "CUS-ACME" }), cfg("ALC-3", { loopCode: "PN3" })];
  const base = { contractId: "CNTR-EX", loopCode: "TPX", customerId: "", commodityCode: "9999", from: "2026-10-01", to: "2026-10-31" };
  it("a separate configuration for another line of the same reference is fine", () => {
    expect(findClashes(configs, { ...base, routingIds: ["R-SAV"] })).toEqual([]);
  });
  it("the same line with the same loop, customer and commodity clashes", () => {
    expect(findClashes(configs, { ...base, routingIds: ["R-LGB", "R-SAV"] }).map(c => [c.routingId, c.config.id])).toEqual([["R-LGB", "ALC-1"]]);
  });
  it("another customer, loop or commodity doesn't clash", () => {
    expect(findClashes(configs, { ...base, routingIds: ["R-LGB"], customerId: "CUS-OTHER" })).toEqual([]);
    expect(findClashes(configs, { ...base, routingIds: ["R-LGB"], loopCode: "XYZ" })).toEqual([]);
    expect(findClashes(configs, { ...base, routingIds: ["R-LGB"], commodityCode: "002001" })).toEqual([]);
  });
  it("a period that doesn't overlap doesn't clash, and editing a configuration ignores itself", () => {
    expect(findClashes(configs, { ...base, routingIds: ["R-LGB"], from: "2026-11-01", to: "2026-11-30" })).toEqual([]);
    expect(findClashes(configs, { ...base, routingIds: ["R-LGB"], excludeId: "ALC-1" })).toEqual([]);
  });
  it("lists the configurations overlapping a period", () => {
    expect(overlappingConfigs(configs, { contractId: "CNTR-EX", from: "2026-10-15", to: "2026-11-15", excludeId: "ALC-3" }).map(c => c.id)).toEqual(["ALC-1", "ALC-2"]);
  });
});

describe("periods", () => {
  it("counts days inclusively", () => {
    expect(periodDays("2026-10-01", "2026-10-31")).toBe(31);
  });
  it("flags a period outside the contract's validity and one over 90 days", () => {
    expect(periodProblems({ from: "2026-12-15", to: "2027-01-15", validFrom: "2026-10-01", validTo: "2026-12-31" })[0]).toMatch(/inside the contract/);
    expect(periodProblems({ from: "2026-01-01", to: "2026-06-30" }).some(p => /at most 90 days/.test(p))).toBe(true);
    expect(periodProblems({ from: "2026-10-01", to: "2026-10-31", validFrom: "2026-10-01", validTo: "2026-12-31" })).toEqual([]);
  });
  it("proposes the month after the last clashing configuration, within the contract", () => {
    const configs = [cfg("ALC-1")];
    expect(nextFreePeriod(configs, { contractId: "CNTR-EX", routingIds: ["R-LGB"], loopCode: "TPX", customerId: "", commodityCode: "9999", validFrom: "2026-10-01", validTo: "2026-12-31" }))
      .toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(nextFreePeriod([cfg("ALC-9", { endDate: "2026-12-31" })], { contractId: "CNTR-EX", routingIds: ["R-LGB"], loopCode: "TPX", customerId: "", commodityCode: "9999", validTo: "2026-12-31" }))
      .toBeNull();
  });
});
