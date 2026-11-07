import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { legChainProblems, ORDER_HELP } from "./legChain";

// The route rules exist twice: the browser's (legChain.js, shown live under the route table and checked by Save) and
// the server's (lib/route-rules.js, which refuses a route that breaks them). The server checks the "order" and "dates"
// kinds; "handover" (legs meet) is the browser's alone. Every route here goes through both, and the two must agree,
// message for message (the user's rules, 2026-11-06).
const server = createRequire(import.meta.url)("../../lib/route-rules.js");
const browserOf = legs => legChainProblems(legs).filter(p => p.kind !== "handover").map(p => [p.legIndex, p.kind, p.message]);
const serverOf = legs => server.routeProblems(legs).map(p => [p.legIndex, p.kind, p.message]);
const sortRows = rows => [...rows].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));

const L = (legType, movementType, pol, polLocType, pod, podLocType, etd = null, eta = null, extra = {}) =>
  ({ legType, movementType, pol, polLocType, pod, podLocType, etd, eta, ...extra });
// The user's example: PKU (MH, then CH), SEA, DEL (CH, then MH).
const mhPku = L("Pick-up", "Merchant's Haulage", "NLAMS", "Door", "NLRTM", "Container Yard", "2026-11-17", "2026-11-17");
const chPku = L("Pick-up", "Carrier's Haulage", "NLRTM", "Container Yard", "NLRTM", "Terminal", "2026-11-18", "2026-11-18");
const sea = L("SEA", "SEA", "NLRTM", "Terminal", "USNYC", "Terminal", "2026-11-20", "2026-12-01");
const chDel = L("Delivery", "Carrier's Haulage", "USNYC", "Terminal", "USJEC", "Container Yard", "2026-12-02", "2026-12-02");
const mhDel = L("Delivery", "Merchant's Haulage", "USJEC", "Container Yard", "USCHI", "Door", "2026-12-03", "2026-12-05");

const ROUTES = {
  "the user's example, in order": [mhPku, chPku, sea, chDel, mhDel],
  "a single CH pick-up, SEA, an MH delivery": [chPku, sea, { ...mhDel, pol: "USNYC", polLocType: "Terminal" }],
  "a pick-up after the sea leg (SHP-IOJNTD as reported)": [sea, { ...chPku, pol: "NLAMS", etd: "2026-11-16", eta: "2026-11-16" }],
  "a delivery before the sea leg": [chDel, sea],
  "MH after CH on the pick-up": [chPku, mhPku, sea],
  "CH after MH on the delivery": [sea, mhDel, chDel],
  "two CH pick-ups": [chPku, { ...chPku, pol: "NLAMS" }, sea],
  "two CH deliveries": [sea, chDel, { ...chDel, pol: "USJEC" }],
  "two MH pick-ups (allowed)": [mhPku, { ...mhPku, pol: "NLUTC" }, chPku, sea],
  "Customer Arranged after CH on the pick-up": [chPku, { ...mhPku, movementType: "Customer Arranged" }, sea],
  "a pick-up arriving after the ETD": [{ ...chPku, etd: "2026-11-19", eta: "2026-11-21" }, sea],
  "a pick-up dated after the ETD, no arrival date": [{ ...chPku, etd: "2026-11-21", eta: null }, sea],
  "a leg arriving before it departs": [{ ...sea, eta: "2026-11-10" }],
  "one actual against another isn't judged": [{ ...chPku, eta: "2026-11-21", etaSource: "ais" }, { ...sea, etd: "2026-11-20", etdSource: "dcsa_actual" }],
  "API legs without a movement type": [L("Pick-up", "SEA", "NLAMS", "Terminal", "NLRTM", "Terminal"), L("Pick-up", "SEA", "NLRTM", "Terminal", "NLRTM", "Terminal"), sea],
  "empty": [],
};

describe("route rules: the browser and the server agree", () => {
  for (const [name, legs] of Object.entries(ROUTES)) {
    it(name, () => expect(sortRows(serverOf(legs))).toEqual(sortRows(browserOf(legs))));
  }

  it("finds what each route breaks", () => {
    const kinds = name => serverOf(ROUTES[name]).map(r => r[1]);
    expect(kinds("the user's example, in order")).toEqual([]);
    expect(kinds("a single CH pick-up, SEA, an MH delivery")).toEqual([]);
    expect(kinds("two MH pick-ups (allowed)")).toEqual([]);
    expect(kinds("API legs without a movement type")).toEqual([]);
    expect(kinds("one actual against another isn't judged")).toEqual([]);
    for (const n of ["a pick-up after the sea leg (SHP-IOJNTD as reported)", "a delivery before the sea leg", "MH after CH on the pick-up",
      "CH after MH on the delivery", "two CH pick-ups", "two CH deliveries", "Customer Arranged after CH on the pick-up"])
      expect(kinds(n)).toContain("order");
    for (const n of ["a pick-up arriving after the ETD", "a pick-up dated after the ETD, no arrival date", "a leg arriving before it departs"])
      expect(kinds(n)).toEqual(["dates"]);
  });

  it("refuses with what's wrong and, for an order problem, what the order should be", () => {
    const r = server.refusal(server.routeProblems(ROUTES["two CH pick-ups"]));
    expect(r.code).toBe("ROUTE_RULES");
    expect(r.problems).toEqual(["Leg 2 (Pick-up) is a second Carrier's Haulage pick-up (leg 1 is one already): a pick-up has at most one Carrier's Haulage leg. Make the other one Merchant's Haulage, or remove it."]);
    expect(r.error).toBe(`The route can't be saved. ${r.problems[0]} ${ORDER_HELP}`);
    expect(r.help).toBe(server.ORDER_HELP);
    expect(server.ORDER_HELP).toBe(ORDER_HELP);
    const d = server.refusal(server.routeProblems(ROUTES["a pick-up arriving after the ETD"]));
    expect(d.error).toBe("The route can't be saved. Leg 2 (SEA) departs 2026-11-20 (ETD), before leg 1 (Pick-up) arrives 2026-11-21 (ETA). Correct the dates: a leg can't leave before the leg before it.");
  });
});
