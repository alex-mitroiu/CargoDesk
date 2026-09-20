import { describe, it, expect } from "vitest";
import { queryRows, filterOptions } from "./localTableQuery";
import {
  buildSpaceRows, statusOf, portLookupsNeeded,
  SPACE_COLUMNS, SPACE_SPEC, SPACE_SORT_OPTIONS,
} from "./spaceConfigTable";

const TODAY = "2026-09-20";
const alloc = (o = {}) => ({
  id: "A", carrierCode: "HLCU", pol: "NLRTM", pod: "USLAX", contractNumber: "C-1", allocatedTEU: 100,
  confirmedTEU: 0, pendingTEU: 0, rejectedTEU: 0, alertThreshold: 80, minimumTEU: null,
  effectiveDate: "2026-09-01", endDate: "2026-09-30", originLane: "", destLane: "", notes: "", ...o,
});
const CARRIERS = [{ code: "HLCU", name: "Hapag Lloyd" }, { code: "EGLV", name: "Evergreen" }];
const build = (allocations, portInfo) => buildSpaceRows({ allocations, carriers: CARRIERS, portInfo, today: TODAY });

describe("statusOf", () => {
  it("is Active inside the period, Future before it", () => {
    expect(statusOf(alloc(), TODAY, 10, 80)).toBe("Active");
    expect(statusOf(alloc({ effectiveDate: "2026-09-25" }), TODAY, 0, 80)).toBe("Future");
  });
  it("turns into At Limit from the threshold and Over Limit from 100%", () => {
    expect(statusOf(alloc(), TODAY, 79.9, 80)).toBe("Active");
    expect(statusOf(alloc(), TODAY, 80, 80)).toBe("At Limit");
    expect(statusOf(alloc(), TODAY, 100, 80)).toBe("Over Limit");
  });
});

describe("buildSpaceRows", () => {
  it("leaves out ended configurations", () => {
    const rows = build([alloc({ id: "LIVE" }), alloc({ id: "OLD", endDate: "2026-09-19" })]);
    expect(rows.map(r => r.id)).toEqual(["LIVE"]);
  });

  it("carries the server's confirmed / pending / rejected / remaining through untouched", () => {
    const [r] = build([alloc({ confirmedTEU: 13, pendingTEU: 5, rejectedTEU: 2, remainingTEU: 87, allocatedTEU: 50 })]);
    expect([r.confirmed, r.pending, r.rejected, r.remaining]).toEqual([13, 5, 2, 87]);
    expect(r.pct).toBeCloseTo(26);
  });

  it("treats zero awarded TEU as 0% consumption rather than dividing by zero", () => {
    const [r] = build([alloc({ allocatedTEU: 0, confirmedTEU: 4 })]);
    expect(r.pct).toBe(0);
  });

  it("sets the alert level: none below the threshold, 'at' from it, 'over' at 100%", () => {
    const lvl = c => build([alloc({ confirmedTEU: c })])[0].alertLevel;
    expect([lvl(79), lvl(80), lvl(100)]).toEqual([null, "at", "over"]);
  });

  it("colours the bar red at 100%, amber at the threshold, but red when the threshold itself is 90 or more", () => {
    const bar = (c, t) => build([alloc({ confirmedTEU: c, alertThreshold: t })])[0].barLevel;
    expect([bar(10, 80), bar(80, 80), bar(95, 90), bar(100, 80)]).toEqual(["success", "warning", "danger", "danger"]);
  });

  it("flags a configuration under its minimum commitment, urgent once 70% of the period has gone", () => {
    const early = build([alloc({ minimumTEU: 40, confirmedTEU: 13, effectiveDate: "2026-09-18", endDate: "2026-12-17" })])[0];
    expect([early.belowMinimum, early.mqcUrgent]).toEqual([true, false]);
    const late = build([alloc({ minimumTEU: 40, confirmedTEU: 13, effectiveDate: "2026-07-01", endDate: "2026-09-30" })])[0];
    expect([late.belowMinimum, late.mqcUrgent]).toEqual([true, true]);
    const met = build([alloc({ minimumTEU: 10, confirmedTEU: 13 })])[0];
    expect(met.belowMinimum).toBe(false);
    expect(build([alloc()])[0].belowMinimum).toBe(false);          // no minimum set: nothing to fall below
  });

  describe("trade lanes", () => {
    const info = { lanes: { NLRTM: "EU-N", USLAX: "NAM" }, names: {} };
    it("uses the stored lane, marked as not derived", () => {
      const [r] = build([alloc({ originLane: "FE", destLane: "ME" })], info);
      expect(r.origin).toEqual({ code: "FE", derived: false });
      expect(r.dest).toEqual({ code: "ME", derived: false });
    });
    it("derives a missing side from its port's primary lane, marked as derived", () => {
      const [r] = build([alloc()], info);
      expect(r.origin).toEqual({ code: "EU-N", derived: true });
      expect(r.dest).toEqual({ code: "NAM", derived: true });
    });
    it("derives each side independently, and a stored lane beats the port's own lane", () => {
      const [r] = build([alloc({ originLane: "FE" })], info);
      expect(r.origin).toEqual({ code: "FE", derived: false });
      expect(r.dest).toEqual({ code: "NAM", derived: true });
    });
    it("is null when nothing is stored and the port has no lane", () => {
      const [r] = build([alloc({ pol: "ZZAUD1", pod: "ZZAUD2" })], info);
      expect(r.origin).toBeNull();
      expect(r.dest).toBeNull();
    });
  });

  it("builds the route and looks up port names", () => {
    const [r] = build([alloc()], { names: { NLRTM: "Rotterdam", USLAX: "Los Angeles" }, lanes: {} });
    expect(r.route).toBe("NLRTM › USLAX");
    expect([r.polName, r.podName]).toEqual(["Rotterdam", "Los Angeles"]);
    expect(build([alloc({ pol: "", pod: "" })])[0].route).toBe("");
  });
});

describe("portLookupsNeeded", () => {
  it("asks for a name for every port on a live row, and a lane only for a side with none stored", () => {
    const need = portLookupsNeeded([
      alloc({ pol: "NLRTM", pod: "USLAX", originLane: "EU-N", destLane: "" }),
      alloc({ pol: "CNSHA", pod: "USLAX", originLane: "", destLane: "NAM" }),
    ], TODAY);
    expect(need.names.sort()).toEqual(["CNSHA", "NLRTM", "USLAX"]);
    expect(need.lanes.sort()).toEqual(["CNSHA", "USLAX"]);       // NLRTM's side stores EU-N already
  });
  it("ignores ended configurations entirely", () => {
    expect(portLookupsNeeded([alloc({ endDate: "2026-09-01" })], TODAY)).toEqual({ names: [], lanes: [] });
  });
});

// The whole pipeline, run the way the page runs it.
describe("filtering, search and sorting", () => {
  const info = { names: { NLRTM: "Rotterdam", USLAX: "Los Angeles", CNSHA: "Shanghai", ZZ1: "", ZZ2: "" },
    lanes: { NLRTM: "EU-N", USLAX: "NAM", CNSHA: "FE" } };
  const ROWS = build([
    alloc({ id: "1", carrierCode: "HLCU", allocatedTEU: 50,  confirmedTEU: 13, contractNumber: "K-1", originLane: "EU-N", destLane: "NAM" }),
    alloc({ id: "2", carrierCode: "EGLV", allocatedTEU: 200, confirmedTEU: 19, contractNumber: "K-2", pol: "CNSHA" }),
    alloc({ id: "3", carrierCode: "HLCU", allocatedTEU: 50,  confirmedTEU: 0,  contractNumber: "K-3", pol: "CNSHA" }),
    alloc({ id: "4", carrierCode: "HLCU", allocatedTEU: 180, confirmedTEU: 18, contractNumber: "",    pol: "ZZ1", pod: "ZZ2" }),
  ], info);
  const ids = (params = {}) => queryRows(ROWS, params, SPACE_SPEC).results.map(r => r.id);

  it("offers every value present, with blanks left out", () => {
    const o = filterOptions(ROWS, SPACE_COLUMNS);
    expect(o.carrier).toEqual(["EGLV", "HLCU"]);
    expect(o.origin).toEqual(["EU-N", "FE"]);
    expect(o.dest).toEqual(["NAM"]);
    expect(o.contract).toEqual(["K-1", "K-2", "K-3"]);            // the row with no contract isn't listed
    expect(o.route).toContain("CNSHA › USLAX");
  });

  it("filters by any column, and columns combine with AND", () => {
    expect(ids({ carrier: ["HLCU"] })).toEqual(["1", "3", "4"]);
    expect(ids({ carrier: ["HLCU"], origin: ["FE"] })).toEqual(["3"]);
    expect(ids({ dest: ["NAM"] })).toEqual(["1", "2", "3"]);      // derived NAM counts as NAM
    expect(ids({ carrier: [] })).toEqual([]);                      // an empty selection shows nothing
  });

  it("a row with no lane on a side drops out as soon as that column is filtered", () => {
    expect(ids({ origin: ["EU-N", "FE"] })).toEqual(["1", "2", "3"]);   // row 4 has no lane
    expect(ids({})).toEqual(["1", "2", "3", "4"]);
  });

  it("searches what a person can read in the row, including port and carrier names", () => {
    expect(ids({ search: "shanghai" })).toEqual(["2", "3"]);
    expect(ids({ search: "evergreen" })).toEqual(["2"]);
    expect(ids({ search: "k-3" })).toEqual(["3"]);
    expect(ids({ search: "nothing like this" })).toEqual([]);
  });

  it("sorts by awarded TEU in both directions, ties keeping their incoming order", () => {
    expect(ids({ sort: "awarded_desc" })).toEqual(["2", "4", "1", "3"]);
    expect(ids({ sort: "awarded_asc" })).toEqual(["1", "3", "4", "2"]);
  });

  it("sorts by consumption (confirmed ÷ awarded) in both directions", () => {
    // 1: 26%   2: 9.5%   3: 0%   4: 10%
    expect(ids({ sort: "consumption_desc" })).toEqual(["1", "4", "2", "3"]);
    expect(ids({ sort: "consumption_asc" })).toEqual(["3", "2", "4", "1"]);
  });

  it("leaves the delivered order alone for no sort, and for an unknown one", () => {
    expect(ids({ sort: "" })).toEqual(["1", "2", "3", "4"]);
    expect(ids({ sort: "bogus" })).toEqual(["1", "2", "3", "4"]);
  });

  it("filters, then searches, then sorts, then pages", () => {
    const r = queryRows(ROWS, { carrier: ["HLCU"], sort: "awarded_desc", limit: 2, offset: 0 }, SPACE_SPEC);
    expect(r.results.map(x => x.id)).toEqual(["4", "1"]);
    expect(r.total).toBe(3);
  });
});

describe("the Confirmed header's sort options", () => {
  it("are exactly the four the design calls for, each backed by a sorter", () => {
    expect(SPACE_SORT_OPTIONS.map(o => `${o.group}|${o.label}`)).toEqual([
      "Awarded TEU|High to low", "Awarded TEU|Low to high",
      "Consumption (confirmed ÷ awarded)|High to low", "Consumption (confirmed ÷ awarded)|Low to high",
    ]);
    for (const o of SPACE_SORT_OPTIONS) expect(SPACE_SPEC.sorters[o.value]).toBeTypeOf("function");
  });
});
