// Does a shipment's route hold together from one leg to the next? (agreed 2026-11-03)
//   • each leg starts where the previous one ended: the same location AND the same location type.
//     A truck that drops the container at the CNSHA container yard hasn't brought it to the CNSHA
//     terminal the vessel loads at; that move is a leg of its own.
//   • a leg doesn't arrive before it departs;
//   • a leg doesn't depart before the previous one arrives (the same day is fine: dates carry no time).
// An actual date (ATD/ATA, confirmed by AIS or the carrier) isn't checked against another actual:
// both are facts nobody can change here. An end or date not filled in yet is skipped; that's
// incomplete rather than inconsistent, and the required-field checks report it.
//   • (2026-11-06, the user's golden rule) Pick-up legs come before the sea legs and Delivery legs after them.
// One rule for the legs table (shown live), the Contracts & Schedules Save and the New Shipment form.

import { isGpsLeg, legLocType } from "./legLocation";

// A leg date confirmed by AIS or the carrier's DCSA event (an ATD/ATA rather than an ETD/ETA).
export const ACTUAL_SOURCES = new Set(["ais", "dcsa_actual"]);

const day = v => (v ? String(v).slice(0, 10) : "");

const dateOf = (leg, end) => {
  const v = day(leg[end]);
  if (!v) return null;
  const actual = ACTUAL_SOURCES.has(leg[`${end}Source`]);
  return { v, actual, label: end === "etd" ? (actual ? "ATD" : "ETD") : (actual ? "ATA" : "ETA") };
};

// key compares, text reads; null = not filled in yet.
const pointOf = (leg, side) => {
  if (isGpsLeg(leg, side)) {
    const lat = leg[`${side}Latitude`], lng = leg[`${side}Longitude`];
    if (lat == null || lat === "" || lng == null || lng === "") return null;
    const coords = `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;
    return { key: `GPS ${coords}`, text: `GPS ${coords}` };
  }
  const code = String(leg[side] || "").trim().toUpperCase();
  if (!code) return null;
  const type = legLocType(leg, side);
  return { key: `${code} ${type}`, text: `${code} ${type}` };
};

const nameOf = (leg, i) => `leg ${i + 1} (${leg.legType || "SEA"})`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// The journey's order (the user's golden rule, 2026-11-06): Pick-up legs first, Delivery legs last, every other leg
// in between, each group in its own relative order (a stable sort). A pick-up brings the container to the port of
// loading, so it can never come after a sea leg; a delivery takes it on from the port of discharge, so never before.
// Within each side (the user, same day, "non-negotiable"): a pick-up's Merchant's Haulage leg comes before its
// Carrier's Haulage leg (e.g. MH NLAMS door → NLRTM CY, then CH NLRTM CY → NLRTM terminal); a delivery's Carrier's
// Haulage leg before its Merchant's Haulage leg (CH USNYC terminal → USJEC CY, then MH USJEC CY → USCHI door).
// Customer Arranged is the customer's own move like Merchant's Haulage, so it ranks with it (pending the user's word).
const JOURNEY_RANK = { "Pick-up": 0, "Delivery": 2 };
const rankOf = leg => JOURNEY_RANK[leg.legType] ?? 1;
const isCustomersOwn = leg => leg.movementType === "Merchant's Haulage" || leg.movementType === "Customer Arranged";
const sideRank = leg => leg.legType === "Pick-up" ? (isCustomersOwn(leg) ? 0 : 1)
  : leg.legType === "Delivery" ? (isCustomersOwn(leg) ? 1 : 0) : 0;
export const journeyOrder = (legs = []) => [...legs].sort((a, b) => rankOf(a) - rankOf(b) || sideRank(a) - sideRank(b));
// The sentence every order message ends with on screen (the user: "instructing the user what the correct order should
// be"); lib/route-rules.js ORDER_HELP says the same for the API's refusals.
export const ORDER_HELP = "The order is: the pick-up legs (Merchant's Haulage first, then at most one Carrier's Haulage leg to the port of loading), the sea legs, then the delivery legs (at most one Carrier's Haulage leg from the port of discharge first, then Merchant's Haulage).";
export const isCarriersHaulageLeg = l => (l.legType === "Pick-up" || l.legType === "Delivery") && l.movementType === "Carrier's Haulage";

// legs in route order → [{ legIndex, kind: "order" | "handover" | "dates", message }]
//   order:    a Pick-up after a SEA leg, or a Delivery before one;
//   handover: a leg doesn't start where the previous one ended;
//   dates:    a leg arrives before it departs, or departs before the previous one arrived (or, with no arrival
//             date on the previous leg, before it departed: a pick-up dated after the sailing's ETD is wrong data).
export function legChainProblems(legs = []) {
  const problems = [];
  const firstSea = legs.findIndex(l => (l.legType || "SEA") === "SEA");
  let lastSea = -1;
  legs.forEach((l, i) => { if ((l.legType || "SEA") === "SEA") lastSea = i; });
  legs.forEach((leg, i) => {
    if (leg.legType === "Pick-up" && firstSea !== -1 && i > firstSea)
      problems.push({ legIndex: i, kind: "order",
        message: `${cap(nameOf(leg, i))} comes after a sea leg: a pick-up brings the container to the port of loading, so it goes before the sea legs.` });
    if (leg.legType === "Delivery" && lastSea !== -1 && i < lastSea)
      problems.push({ legIndex: i, kind: "order",
        message: `${cap(nameOf(leg, i))} comes before a sea leg: a delivery takes the container on from the port of discharge, so it goes after the sea legs.` });
    // At most one Carrier's Haulage leg on each side (the user, 2026-11-06); any number of the customer's own legs.
    if ((leg.legType === "Pick-up" || leg.legType === "Delivery") && leg.movementType === "Carrier's Haulage") {
      const side = leg.legType === "Pick-up" ? "pick-up" : "delivery";
      const first = legs.findIndex(l => l.legType === leg.legType && l.movementType === "Carrier's Haulage");
      if (first !== i)
        problems.push({ legIndex: i, kind: "order",
          message: `${cap(nameOf(leg, i))} is a second Carrier's Haulage ${side} (leg ${first + 1} is one already): a ${side} has at most one Carrier's Haulage leg. Make the other one Merchant's Haulage, or remove it.` });
    }
    const prev = legs[i - 1];
    if (prev && prev.legType === leg.legType && leg.legType === "Pick-up" && isCustomersOwn(leg) && !isCustomersOwn(prev))
      problems.push({ legIndex: i, kind: "order",
        message: `${cap(nameOf(leg, i))} is ${leg.movementType} after a Carrier's Haulage pick-up: the merchant's leg comes first, then the carrier's to the port.` });
    if (prev && prev.legType === leg.legType && leg.legType === "Delivery" && !isCustomersOwn(leg) && isCustomersOwn(prev))
      problems.push({ legIndex: i, kind: "order",
        message: `${cap(nameOf(leg, i))} is Carrier's Haulage after a ${prev.movementType} delivery: the carrier's leg from the port comes first, then the merchant's.` });
  });
  legs.forEach((leg, i) => {
    const dep = dateOf(leg, "etd"), arr = dateOf(leg, "eta");
    if (dep && arr && !(dep.actual && arr.actual) && arr.v < dep.v) {
      problems.push({ legIndex: i, kind: "dates",
        message: `${cap(nameOf(leg, i))} arrives ${arr.v} (${arr.label}), before it departs ${dep.v} (${dep.label}).` });
    }
    if (i === 0) return;
    const prev = legs[i - 1];
    const end = pointOf(prev, "pod"), start = pointOf(leg, "pol");
    if (end && start && end.key !== start.key) {
      problems.push({ legIndex: i, kind: "handover",
        message: `${cap(nameOf(prev, i - 1))} ends at ${end.text}, but ${nameOf(leg, i)} starts at ${start.text}. ` +
          `Add a leg for the move between them, or make the two meet.` });
    }
    const prevArr = dateOf(prev, "eta"), prevDep = dateOf(prev, "etd"), nextDep = dateOf(leg, "etd");
    if (prevArr && nextDep && !(prevArr.actual && nextDep.actual) && nextDep.v < prevArr.v) {
      problems.push({ legIndex: i, kind: "dates",
        message: `${cap(nameOf(leg, i))} departs ${nextDep.v} (${nextDep.label}), before ${nameOf(prev, i - 1)} arrives ${prevArr.v} (${prevArr.label}).` });
    } else if (!prevArr && prevDep && nextDep && !(prevDep.actual && nextDep.actual) && nextDep.v < prevDep.v) {
      problems.push({ legIndex: i, kind: "dates",
        message: `${cap(nameOf(leg, i))} departs ${nextDep.v} (${nextDep.label}), before ${nameOf(prev, i - 1)} even departs ${prevDep.v} (${prevDep.label}).` });
    }
  });
  return problems;
}
