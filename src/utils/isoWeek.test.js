import { describe, it, expect } from "vitest";
import { mondayOf, isoWeekNumber, mondaysBetween, spaceDateOf, weekLabel, weekRange, teuOverRange, rangeWeeksOf, periodTeuOf, spaceTeuLabel } from "./isoWeek";

// A weekly configuration: 15 TEU every week of 29 Sep – 31 Oct 2026 (ISO weeks 40 to 44).
const weekly = { allocatedTEU: 15, spaceBasis: "week", effectiveDate: "2026-09-29", endDate: "2026-10-31" };
const period = { allocatedTEU: 40, spaceBasis: "period", effectiveDate: "2026-09-30", endDate: "2026-10-31" };

describe("ISO weeks", () => {
  it("puts a date in its Monday-to-Sunday week", () => {
    expect(mondayOf("2026-10-28")).toBe("2026-10-26");
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
    expect(mondayOf("2026-11-01")).toBe("2026-10-26");
    expect(mondayOf("2026-10-28T09:30")).toBe("2026-10-26");
    expect(mondayOf("")).toBe("");
  });
  it("numbers weeks the ISO way, across a year end", () => {
    expect(isoWeekNumber("2026-10-28")).toBe(44);
    expect(isoWeekNumber("2026-12-31")).toBe(53);
    expect(isoWeekNumber("2027-01-01")).toBe(53);
    expect(isoWeekNumber("2027-01-04")).toBe(1);
    expect(weekLabel("2026-10-28")).toBe("Week 44");
  });
  it("lists every week that touches a range, part weeks included", () => {
    expect(mondaysBetween("2026-09-29", "2026-10-31")).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(mondaysBetween("2026-10-31", "2026-10-01")).toEqual([]);
  });
  it("counts a shipment on its ETD, else its cargo-ready date", () => {
    expect(spaceDateOf("2026-10-28", "2026-10-20")).toBe("2026-10-28");
    expect(spaceDateOf("", "2026-10-20")).toBe("2026-10-20");
    expect(spaceDateOf(null, null)).toBe("");
  });
  it("labels a week's dates", () => {
    expect(weekRange("2026-10-26")).toBe("26 Oct – 1 Nov");
  });
});

describe("TEU over a range", () => {
  it("counts weekly space once per week of the range inside its period", () => {
    expect(rangeWeeksOf(weekly, "2026-10-01", "2026-10-31")).toHaveLength(5);
    expect(teuOverRange(weekly, "2026-10-01", "2026-10-31")).toBe(75);
    expect(teuOverRange(weekly, "2026-10-19", "2026-10-25")).toBe(15);
    expect(teuOverRange(weekly, "2026-11-02", "2026-11-08")).toBe(0);
    expect(periodTeuOf(weekly)).toBe(75);
  });
  it("counts period space whole, whatever the range", () => {
    expect(teuOverRange(period, "2026-10-19", "2026-10-25")).toBe(40);
    expect(periodTeuOf(period)).toBe(40);
  });
  it("labels the TEU with its basis", () => {
    expect(spaceTeuLabel(weekly)).toBe("15 TEU/wk");
    expect(spaceTeuLabel(period)).toBe("40 TEU");
  });
});
