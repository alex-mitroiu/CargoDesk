// Does a shipment's route hold together from one leg to the next? (agreed 2026-11-03)
//   • each leg starts where the previous one ended: the same location AND the same location type.
//     A truck that drops the container at the CNSHA container yard hasn't brought it to the CNSHA
//     terminal the vessel loads at; that move is a leg of its own.
//   • a leg doesn't arrive before it departs;
//   • a leg doesn't depart before the previous one arrives (the same day is fine: dates carry no time).
// An actual date (ATD/ATA, confirmed by AIS or the carrier) isn't checked against another actual:
// both are facts nobody can change here. An end or date not filled in yet is skipped; that's
// incomplete rather than inconsistent, and the required-field checks report it.
// One rule for the legs table (shown live), the Contracts & Schedules Save and the New Shipment form.

import { isGpsLeg, legLocType } from "./legLocation";

const ACTUAL_SOURCES = new Set(["ais", "dcsa_actual"]);

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

// legs in route order → [{ legIndex, kind: "handover" | "dates", message }]
export function legChainProblems(legs = []) {
  const problems = [];
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
    const prevArr = dateOf(prev, "eta"), nextDep = dateOf(leg, "etd");
    if (prevArr && nextDep && !(prevArr.actual && nextDep.actual) && nextDep.v < prevArr.v) {
      problems.push({ legIndex: i, kind: "dates",
        message: `${cap(nameOf(leg, i))} departs ${nextDep.v} (${nextDep.label}), before ${nameOf(prev, i - 1)} arrives ${prevArr.v} (${prevArr.label}).` });
    }
  });
  return problems;
}
