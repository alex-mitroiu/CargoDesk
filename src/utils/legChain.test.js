import { describe, it, expect } from "vitest";
import { legChainProblems } from "./legChain";
import { legLocType } from "./legLocation";

const leg = (legType, pol, polLocType, pod, podLocType, etd = null, eta = null, extra = {}) =>
  ({ legType, pol, polLocType, pod, podLocType, etd, eta, ...extra });

// The route on SHP-ZT7NOW that started this (screenshot 06): the truck drops the box at the CNSHA
// container yard, the vessel loads at the CNSHA terminal, nothing moves it between the two.
const pku = leg("Pick-up", "CNTAG", "Door", "CNSHA", "Container Yard", "2026-10-28", "2026-10-29");
const sea = leg("SEA", "CNSHA", "Terminal", "USLAX", "Terminal", "2026-11-01", "2026-11-17");
const del = leg("Delivery", "USLAX", "Terminal", "USLGB", "Door", "2026-11-19", "2026-11-19");

describe("legLocType", () => {
  it("is always Terminal on a SEA leg, whatever is stored", () => {
    expect(legLocType({ legType: "SEA", polLocType: "Container Yard" }, "pol")).toBe("Terminal");
    expect(legLocType({ polLocType: "Door" }, "pol")).toBe("Terminal"); // blank leg type = SEA
  });
  it("keeps a Pick-up/Delivery leg's own type, blank meaning Terminal", () => {
    expect(legLocType({ legType: "Pick-up", polLocType: "Door" }, "pol")).toBe("Door");
    expect(legLocType({ legType: "Delivery" }, "pod")).toBe("Terminal");
  });
});

describe("legChainProblems — where legs meet", () => {
  it("flags a container yard drop followed by a terminal load in the same port", () => {
    const p = legChainProblems([pku, sea, del]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ legIndex: 1, kind: "handover" });
    expect(p[0].message).toContain("CNSHA Container Yard");
    expect(p[0].message).toContain("CNSHA Terminal");
  });

  it("accepts the route once the pick-up ends at the terminal", () => {
    expect(legChainProblems([{ ...pku, podLocType: "Terminal" }, sea, del])).toEqual([]);
  });

  it("accepts a separate yard → terminal move", () => {
    const shunt = leg("Pick-up", "CNSHA", "Container Yard", "CNSHA", "Terminal", "2026-10-30", "2026-10-30");
    expect(legChainProblems([pku, shunt, sea, del])).toEqual([]);
  });

  it("judges a SEA leg's ends as Terminal even if an old value says otherwise", () => {
    expect(legChainProblems([{ ...pku, podLocType: "Terminal" }, { ...sea, polLocType: "Container Yard" }])).toEqual([]);
  });

  it("flags different ports, and compares codes case-insensitively", () => {
    const p = legChainProblems([sea, leg("Delivery", "USLGB", "Terminal", "USCHI", "Door")]);
    expect(p).toHaveLength(1);
    expect(p[0].message).toContain("ends at USLAX Terminal, but leg 2 (Delivery) starts at USLGB Terminal");
    expect(legChainProblems([sea, { ...del, pol: "uslax" }])).toEqual([]);
  });

  it("chains the sea legs of a transshipment", () => {
    const first = leg("SEA", "CNSHA", "Terminal", "SGSIN", "Terminal", "2026-11-01", "2026-11-06");
    const second = leg("SEA", "SGSIN", "Terminal", "NLRTM", "Terminal", "2026-11-08", "2026-12-02");
    expect(legChainProblems([first, second])).toEqual([]);
    expect(legChainProblems([first, { ...second, pol: "MYPKG" }])).toHaveLength(1);
  });

  it("skips an end not filled in yet", () => {
    expect(legChainProblems([{ ...pku, pod: "" }, sea])).toEqual([]);
  });

  it("compares GPS ends by their coordinates", () => {
    const gps = { polLatitude: 31.4, polLongitude: 121.1 };
    const toSite = leg("Delivery", "USLAX", "Terminal", "", "GPS Coordinates", null, null, { podLatitude: 34.1, podLongitude: -118.2 });
    const onward = leg("Delivery", "", "GPS Coordinates", "USLGB", "Door", null, null, { polLatitude: 34.1, polLongitude: -118.2 });
    expect(legChainProblems([toSite, onward])).toEqual([]);
    expect(legChainProblems([toSite, { ...onward, polLatitude: 35 }])).toHaveLength(1);
    expect(legChainProblems([leg("Pick-up", "", "GPS Coordinates", "CNSHA", "Terminal", null, null, gps), sea])).toEqual([]);
  });
});

describe("legChainProblems — dates", () => {
  const ok = [{ ...pku, podLocType: "Terminal" }, sea, del];

  it("flags a leg that arrives before it departs", () => {
    const p = legChainProblems([{ ...sea, eta: "2026-10-30" }]);
    expect(p).toEqual([expect.objectContaining({ legIndex: 0, kind: "dates" })]);
    expect(p[0].message).toBe("Leg 1 (SEA) arrives 2026-10-30 (ETA), before it departs 2026-11-01 (ETD).");
  });

  it("flags a leg that departs before the previous one arrives", () => {
    const p = legChainProblems([ok[0], ok[1], { ...del, etd: "2026-11-15" }]);
    expect(p).toHaveLength(1);
    expect(p[0].message).toBe("Leg 3 (Delivery) departs 2026-11-15 (ETD), before leg 2 (SEA) arrives 2026-11-17 (ETA).");
  });

  it("allows departing the day the previous leg arrives", () => {
    expect(legChainProblems([ok[0], ok[1], { ...del, etd: "2026-11-17" }])).toEqual([]);
  });

  it("names an actual date ATD/ATA", () => {
    const p = legChainProblems([ok[0], { ...sea, etaSource: "dcsa_actual" }, { ...del, etd: "2026-11-15", etdSource: "manual" }]);
    expect(p[0].message).toContain("before leg 2 (SEA) arrives 2026-11-17 (ATA)");
  });

  it("doesn't judge one actual against another", () => {
    const actualArr = { ...sea, eta: "2026-11-17", etaSource: "ais" };
    const actualDep = { ...del, etd: "2026-11-16", etdSource: "dcsa_actual" };
    expect(legChainProblems([ok[0], actualArr, actualDep])).toEqual([]);
    expect(legChainProblems([{ ...sea, etdSource: "ais", eta: "2026-10-30", etaSource: "ais" }])).toEqual([]);
  });

  it("compares the date part of a date-time", () => {
    expect(legChainProblems([ok[0], { ...sea, eta: "2026-11-17T22:00:00Z" }, { ...del, etd: "2026-11-17" }])).toEqual([]);
  });

  it("skips a date not filled in yet", () => {
    expect(legChainProblems([{ ...sea, eta: null }, { ...del, etd: "2026-10-01" }])).toEqual([]);
  });
});
