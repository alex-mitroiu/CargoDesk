"use strict";
// A shipment's route, as the server enforces it (the user's rules, 2026-11-06, "non-negotiable"). The same order and
// date rules as the browser's src/utils/legChain.js (its legChainProblems kinds "order" and "dates"); the
// handover rule (legs meet) stays the browser's, checked by the pages that save a whole route.
// src/utils/legChain.parity.test.js runs both on the same routes, so the two can't drift.
//
//   • PKU, SEA, DEL: Pick-up legs first, then the sea legs, then the Delivery legs.
//   • Pick-up side: the customer's own legs (Merchant's Haulage, Customer Arranged) before the Carrier's Haulage leg,
//     which takes the container to the port of loading; at most one Carrier's Haulage leg.
//   • Delivery side: the Carrier's Haulage leg from the port of discharge first, then the customer's own legs; at most
//     one Carrier's Haulage leg. Either side may have no leg, or only one kind (a single CH pick-up, an MH delivery).
//   • Dates: no leg arrives before it departs; no leg departs before the previous one arrives (or, with no arrival
//     date on the previous leg, before it departs). An actual date (AIS, a DCSA event) is never judged against
//     another actual: both are facts nobody can change here.
//
// Legs come in camelCase (the API's and lib/mappers.js mapShipmentLeg's shape), in route order.

const ACTUAL_SOURCES = new Set(["ais", "dcsa_actual"]);
const CH = "Carrier's Haulage";
const isCustomersOwn = l => l.movementType === "Merchant's Haulage" || l.movementType === "Customer Arranged";
const typeOf = l => l.legType || "SEA";
const day = v => (v ? String(v).slice(0, 10) : "");
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const nameOf = (leg, i) => `leg ${i + 1} (${typeOf(leg)})`;

const ORDER_HELP = "The order is: the pick-up legs (Merchant's Haulage first, then at most one Carrier's Haulage leg to the port of loading), the sea legs, then the delivery legs (at most one Carrier's Haulage leg from the port of discharge first, then Merchant's Haulage).";

const dateOf = (leg, end) => {
  const v = day(leg[end]);
  if (!v) return null;
  const actual = ACTUAL_SOURCES.has(leg[`${end}Source`]);
  return { v, actual, label: end === "etd" ? (actual ? "ATD" : "ETD") : (actual ? "ATA" : "ETA") };
};

// legs in route order → [{ legIndex, kind: "order" | "dates", message }]
function routeProblems(legs = []) {
  const problems = [];
  const firstSea = legs.findIndex(l => typeOf(l) === "SEA");
  let lastSea = -1;
  legs.forEach((l, i) => { if (typeOf(l) === "SEA") lastSea = i; });
  const chSeen = {};
  legs.forEach((leg, i) => {
    const t = typeOf(leg);
    if (t === "Pick-up" && firstSea !== -1 && i > firstSea)
      problems.push({ legIndex: i, kind: "order",
        message: `${cap(nameOf(leg, i))} comes after a sea leg: a pick-up brings the container to the port of loading, so it goes before the sea legs.` });
    if (t === "Delivery" && lastSea !== -1 && i < lastSea)
      problems.push({ legIndex: i, kind: "order",
        message: `${cap(nameOf(leg, i))} comes before a sea leg: a delivery takes the container on from the port of discharge, so it goes after the sea legs.` });
    const prev = legs[i - 1];
    if (prev && typeOf(prev) === t && t === "Pick-up" && isCustomersOwn(leg) && !isCustomersOwn(prev))
      problems.push({ legIndex: i, kind: "order",
        message: `${cap(nameOf(leg, i))} is ${leg.movementType} after a Carrier's Haulage pick-up: the merchant's leg comes first, then the carrier's to the port.` });
    if (prev && typeOf(prev) === t && t === "Delivery" && !isCustomersOwn(leg) && isCustomersOwn(prev))
      problems.push({ legIndex: i, kind: "order",
        message: `${cap(nameOf(leg, i))} is Carrier's Haulage after a ${prev.movementType} delivery: the carrier's leg from the port comes first, then the merchant's.` });
    if ((t === "Pick-up" || t === "Delivery") && leg.movementType === CH) {
      if (chSeen[t] !== undefined)
        problems.push({ legIndex: i, kind: "order",
          message: `${cap(nameOf(leg, i))} is a second Carrier's Haulage ${t === "Pick-up" ? "pick-up" : "delivery"} (leg ${chSeen[t] + 1} is one already): a ${t === "Pick-up" ? "pick-up" : "delivery"} has at most one Carrier's Haulage leg. Make the other one Merchant's Haulage, or remove it.` });
      else chSeen[t] = i;
    }
  });
  legs.forEach((leg, i) => {
    const dep = dateOf(leg, "etd"), arr = dateOf(leg, "eta");
    if (dep && arr && !(dep.actual && arr.actual) && arr.v < dep.v)
      problems.push({ legIndex: i, kind: "dates",
        message: `${cap(nameOf(leg, i))} arrives ${arr.v} (${arr.label}), before it departs ${dep.v} (${dep.label}).` });
    if (i === 0) return;
    const prev = legs[i - 1];
    const prevArr = dateOf(prev, "eta"), prevDep = dateOf(prev, "etd"), nextDep = dateOf(leg, "etd");
    if (prevArr && nextDep && !(prevArr.actual && nextDep.actual) && nextDep.v < prevArr.v)
      problems.push({ legIndex: i, kind: "dates",
        message: `${cap(nameOf(leg, i))} departs ${nextDep.v} (${nextDep.label}), before ${nameOf(prev, i - 1)} arrives ${prevArr.v} (${prevArr.label}).` });
    else if (!prevArr && prevDep && nextDep && !(prevDep.actual && nextDep.actual) && nextDep.v < prevDep.v)
      problems.push({ legIndex: i, kind: "dates",
        message: `${cap(nameOf(leg, i))} departs ${nextDep.v} (${nextDep.label}), before ${nameOf(prev, i - 1)} even departs ${prevDep.v} (${prevDep.label}).` });
  });
  return problems;
}

// The refusal the API sends: what's wrong (every problem) and, for an order problem, what the order should be.
function refusal(problems) {
  const orderWrong = problems.some(p => p.kind === "order");
  const head = problems.length === 1 ? problems[0].message : `${problems.length} problems in the route. ${problems.map(p => p.message).join(" ")}`;
  const help = orderWrong ? ORDER_HELP : "Correct the dates: a leg can't leave before the leg before it.";
  return { error: `The route can't be saved. ${head} ${help}`, code: "ROUTE_RULES", problems: problems.map(p => p.message), help };
}

module.exports = { routeProblems, refusal, ORDER_HELP, ACTUAL_SOURCES };
