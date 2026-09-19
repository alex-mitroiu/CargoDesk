import { describe, it, expect } from "vitest";
import { applyColumnFilters, filterOptions, applySort, queryRows } from "./localTableQuery";
import { SCHEDULE_COLUMNS, SCHEDULE_FILTER_KEYS, buildScheduleSorters, scheduleSortOptions, bestRate, groupByContract, RESULT_CAP } from "./scheduleResults";

const leg = (pol, pod) => ({ pol, pod });
const C = (id, over = {}) => ({ id, contractNumber: `K-${id}`, carrierCode: "MAEU", namedAccount: "", status: "Active",
  validFrom: "2026-01-01", validTo: "2026-12-31", legs: [leg("NLRTM", "USNYC")], rates: [], ...over });

// a stand-in for the page's computeRateTotal: the contract's `rate` field (undefined/0 = none for these containers)
const rateOf = c => c.rate || 0;
const ids = rows => rows.map(r => r.id).join("");

describe("SCHEDULE_COLUMNS", () => {
  it("has one column per filter key", () => {
    expect(Object.keys(SCHEDULE_COLUMNS).sort()).toEqual([...SCHEDULE_FILTER_KEYS].sort());
  });

  it("route lists EVERY leg as \"POL › POD\", so a contract matches on any of them", () => {
    const multi = C("a", { legs: [leg("NLRTM", "DEHAM"), leg("DEHAM", "USNYC")] });
    expect(SCHEDULE_COLUMNS.route(multi)).toEqual(["NLRTM › DEHAM", "DEHAM › USNYC"]);
    const rows = [multi, C("b"), C("c", { legs: [] })];
    expect(ids(applyColumnFilters(rows, { route: ["DEHAM › USNYC"] }, SCHEDULE_COLUMNS))).toBe("a");
    expect(ids(applyColumnFilters(rows, { route: ["NLRTM › USNYC"] }, SCHEDULE_COLUMNS))).toBe("b");
  });

  it("a leg missing a port contributes no label, and a contract with no legs matches no route selection", () => {
    expect(SCHEDULE_COLUMNS.route(C("a", { legs: [leg("NLRTM", ""), leg("", "USNYC")] }))).toEqual([]);
    expect(ids(applyColumnFilters([C("a", { legs: [] })], { route: ["NLRTM › USNYC"] }, SCHEDULE_COLUMNS))).toBe("");
  });

  it("checklist options are distinct values, blanks never offered", () => {
    const rows = [C("a", { namedAccount: "Acme" }), C("b", { namedAccount: "" }), C("c", { namedAccount: "Acme", carrierCode: "HLCU" })];
    const o = filterOptions(rows, SCHEDULE_COLUMNS);
    expect(o.namedAccount).toEqual(["Acme"]);
    expect(o.carrier).toEqual(["HLCU", "MAEU"]);
    expect(o.route).toEqual(["NLRTM › USNYC"]);
  });
});

describe("buildScheduleSorters", () => {
  const sorters = buildScheduleSorters(rateOf);

  it("rate: cheapest first, and a contract with NO rate goes last (nothing to compare)", () => {
    const rows = [C("a", { rate: 900 }), C("b", { rate: 0 }), C("c", { rate: 500 }), C("d", { rate: 700 })];
    expect(ids(applySort(rows, "rate", sorters))).toBe("cdab");
  });

  it("validTo: latest expiry first, a contract with no end date last", () => {
    const rows = [C("a", { validTo: "2026-06-30" }), C("b", { validTo: "" }), C("c", { validTo: "2027-03-31" })];
    expect(ids(applySort(rows, "validTo", sorters))).toBe("cab");
  });

  it("contractNumber / carrier: A–Z, blanks last", () => {
    const rows = [C("a", { contractNumber: "B-2" }), C("b", { contractNumber: "" }), C("c", { contractNumber: "A-1" })];
    expect(ids(applySort(rows, "contractNumber", sorters))).toBe("cab");
    const byCarrier = [C("a", { carrierCode: "MSCU" }), C("b", { carrierCode: "HLCU" })];
    expect(ids(applySort(byCarrier, "carrier", sorters))).toBe("ba");
  });

  it("no key leaves the server's order alone", () => {
    const rows = [C("a"), C("b"), C("c")];
    expect(ids(applySort(rows, "", sorters))).toBe("abc");
  });
});

describe("scheduleSortOptions", () => {
  it("offers Cheapest first only when containers were chosen in the search (otherwise there is no rate)", () => {
    expect(scheduleSortOptions(false).map(o => o.value)).not.toContain("rate");
    expect(scheduleSortOptions(true).map(o => o.value)).toContain("rate");
    expect(scheduleSortOptions(false)[0]).toEqual({ value: "", label: "Newest first" });
  });
});

describe("bestRate", () => {
  it("is the lowest POSITIVE total; contracts with no rate are ignored; 0 when none has one", () => {
    expect(bestRate([C("a", { rate: 900 }), C("b", { rate: 0 }), C("c", { rate: 500 })], rateOf)).toBe(500);
    expect(bestRate([C("a"), C("b")], rateOf)).toBe(0);
    expect(bestRate([], rateOf)).toBe(0);
  });

  it("is relative to whatever rows it is given, so filtering the table re-evaluates it", () => {
    const rows = [C("a", { carrierCode: "MAEU", rate: 900 }), C("b", { carrierCode: "HLCU", rate: 500 })];
    expect(bestRate(rows, rateOf)).toBe(500);
    expect(bestRate(applyColumnFilters(rows, { carrier: ["MAEU"] }, SCHEDULE_COLUMNS), rateOf)).toBe(900);
  });
});

describe("groupByContract", () => {
  it("groups rows that share a contract number, in order of first appearance", () => {
    const rows = [C("a", { contractNumber: "X" }), C("b", { contractNumber: "Y" }), C("c", { contractNumber: "X" })];
    const groups = groupByContract(rows);
    expect(groups.map(g => g.key)).toEqual(["X", "Y"]);
    expect(groups[0].contracts.map(c => c.id)).toEqual(["a", "c"]);
  });

  it("a contract with no number never shares a group — it is keyed by its id", () => {
    const groups = groupByContract([C("a", { contractNumber: "" }), C("b", { contractNumber: "" })]);
    expect(groups.map(g => g.key)).toEqual(["_a", "_b"]);
  });

  it("copes with no rows", () => {
    expect(groupByContract([])).toEqual([]);
    expect(groupByContract(undefined)).toEqual([]);
  });

  it("after a sort, a group's members collect under the FIRST one to appear", () => {
    const rows = [C("a", { contractNumber: "X", rate: 900 }), C("b", { contractNumber: "Y", rate: 100 }), C("c", { contractNumber: "X", rate: 50 })];
    const sorted = applySort(rows, "rate", buildScheduleSorters(rateOf));   // c, b, a
    expect(groupByContract(sorted).map(g => `${g.key}:${g.contracts.map(c => c.id).join("")}`)).toEqual(["X:ca", "Y:b"]);
  });
});

describe("the whole pipeline over a search result", () => {
  const rows = [C("a", { rate: 900 }), C("b", { carrierCode: "HLCU", rate: 500 }), C("c", { status: "Expired", rate: 0 })];
  const spec = { columns: SCHEDULE_COLUMNS, sorters: buildScheduleSorters(rateOf) };

  it("filters, sorts and pages in one go, exactly as useTableQuery would ask for it", () => {
    const r = queryRows(rows, { status: ["Active"], sort: "rate", limit: 1, offset: 0 }, spec);
    expect(r.total).toBe(2);
    expect(ids(r.results)).toBe("b");
    expect(ids(queryRows(rows, { status: ["Active"], sort: "rate", limit: 1, offset: 1 }, spec).results)).toBe("a");
    expect(queryRows(rows, { status: [] }, spec).total).toBe(0);            // empty selection shows nothing
  });

  it("RESULT_CAP matches the server's page cap for GET /api/contracts", () => {
    expect(RESULT_CAP).toBe(200);
  });
});
