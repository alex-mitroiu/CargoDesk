import { describe, it, expect } from "vitest";
import { legChainProblems, journeyOrder } from "./legChain";
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
    expect(legChainProblems([{ ...sea, eta: null }, { ...del, etd: "2026-11-10" }])).toEqual([]);
    expect(legChainProblems([{ ...sea, etd: null, eta: null }, { ...del, etd: "2026-10-01" }])).toEqual([]);
  });

  // The user's golden rule (2026-11-06): a pick-up dated after the sailing's ETD is wrong data to correct, also when
  // it has no arrival date; with no arrival on the previous leg, its departure is the bound.
  it("flags a leg that departs before the previous one even departs, when that one has no arrival date", () => {
    const p = legChainProblems([{ ...pku, podLocType: "Terminal", etd: "2026-11-02", eta: null }, sea]);
    expect(p).toEqual([expect.objectContaining({ legIndex: 1, kind: "dates" })]);
    expect(p[0].message).toBe("Leg 2 (SEA) departs 2026-11-01 (ETD), before leg 1 (Pick-up) even departs 2026-11-02 (ETD).");
  });

  it("flags a pick-up that arrives after the sailing's ETD", () => {
    const p = legChainProblems([{ ...pku, podLocType: "Terminal", etd: "2026-11-01", eta: "2026-11-03" }, sea]);
    expect(p[0].message).toBe("Leg 2 (SEA) departs 2026-11-01 (ETD), before leg 1 (Pick-up) arrives 2026-11-03 (ETA).");
  });
});

// The user's golden rule (2026-11-06): Pick-up legs never after the sea legs, Delivery legs never before them.
// The route that broke it: a Pick-up NLAMS → NLRTM stored after the sea leg, a TSP sailing staged next to that leg.
describe("journey order", () => {
  const pkuAms = leg("Pick-up", "NLAMS", "Terminal", "NLRTM", "Terminal", "2026-11-16", "2026-11-16");
  const feeder = leg("SEA", "NLRTM", "Terminal", "BEANR", "Terminal", "2026-11-20", "2026-11-22", { id: "f" });
  const main = leg("SEA", "BEANR", "Terminal", "USNYC", "Terminal", "2026-11-23", "2026-12-20", { id: "m" });

  it("flags a Pick-up after a sea leg", () => {
    const p = legChainProblems([feeder, main, pkuAms]);
    expect(p).toEqual(expect.arrayContaining([expect.objectContaining({ legIndex: 2, kind: "order" })]));
    expect(p.find(x => x.kind === "order").message)
      .toBe("Leg 3 (Pick-up) comes after a sea leg: a pick-up brings the container to the port of loading, so it goes before the sea legs.");
  });

  it("flags a Delivery before a sea leg", () => {
    const p = legChainProblems([del, sea]);
    expect(p).toEqual(expect.arrayContaining([expect.objectContaining({ legIndex: 0, kind: "order" })]));
  });

  it("puts Pick-up legs first and Delivery legs last, the sea legs keeping their own order", () => {
    const fixed = journeyOrder([feeder, del, main, pkuAms]);
    expect(fixed.map(l => `${l.legType} ${l.pol}`)).toEqual(["Pick-up NLAMS", "SEA NLRTM", "SEA BEANR", "Delivery USLAX"]);
  });

  it("turns the reported route into one with no problems", () => {
    expect(legChainProblems(journeyOrder([feeder, main, pkuAms]))).toEqual([]);
  });

  it("doesn't change a route already in order, nor the list it was given", () => {
    const route = [pkuAms, feeder, main];
    expect(journeyOrder(route)).toEqual(route);
    expect(journeyOrder(route)).not.toBe(route);
  });
});

// The user's worked example (2026-11-06): PKU = MH then CH, SEA, DEL = CH then MH.
describe("journey order within the pick-up and delivery sides", () => {
  const mhPku = leg("Pick-up", "NLAMS", "Door", "NLRTM", "Container Yard", "2026-11-17", "2026-11-17", { id: "1", movementType: "Merchant's Haulage" });
  const chPku = leg("Pick-up", "NLRTM", "Container Yard", "NLRTM", "Terminal", "2026-11-18", "2026-11-18", { id: "2", movementType: "Carrier's Haulage" });
  const seaLeg = leg("SEA", "NLRTM", "Terminal", "USNYC", "Terminal", "2026-11-20", "2026-12-01", { id: "3", movementType: "SEA" });
  const chDel = leg("Delivery", "USNYC", "Terminal", "USJEC", "Container Yard", "2026-12-02", "2026-12-02", { id: "4", movementType: "Carrier's Haulage" });
  const mhDel = leg("Delivery", "USJEC", "Container Yard", "USCHI", "Door", "2026-12-03", "2026-12-05", { id: "5", movementType: "Merchant's Haulage" });
  const route = [mhPku, chPku, seaLeg, chDel, mhDel];

  it("accepts the example route as it is", () => {
    expect(legChainProblems(route)).toEqual([]);
  });

  it("puts any shuffle of it back in that order", () => {
    expect(journeyOrder([mhDel, seaLeg, chPku, chDel, mhPku]).map(l => l.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("flags a merchant's pick-up after the carrier's one", () => {
    const p = legChainProblems([chPku, mhPku, seaLeg]).filter(x => x.kind === "order");
    expect(p).toHaveLength(1);
    expect(p[0].message).toBe("Leg 2 (Pick-up) is Merchant's Haulage after a Carrier's Haulage pick-up: the merchant's leg comes first, then the carrier's to the port.");
  });

  it("flags a carrier's delivery after the merchant's one", () => {
    const p = legChainProblems([seaLeg, mhDel, chDel]).filter(x => x.kind === "order");
    expect(p).toHaveLength(1);
    expect(p[0].message).toBe("Leg 3 (Delivery) is Carrier's Haulage after a Merchant's Haulage delivery: the carrier's leg from the port comes first, then the merchant's.");
  });

  it("ranks Customer Arranged with Merchant's Haulage", () => {
    const ca = { ...mhPku, id: "ca", movementType: "Customer Arranged" };
    expect(journeyOrder([chPku, ca]).map(l => l.id)).toEqual(["ca", "2"]);
  });
});
