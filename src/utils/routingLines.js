// Contract routing lines, client side (approved mockup, Option 1:
// https://claude.ai/artifact/YMjKwCQDPdSFYP5auHrki9). A routing is ONE line: a connected run of
// legs. The server enforces the same rules in lib/routingLines.js — lineKey and lineProblems below
// must stay identical to its own, or the editor would accept a line the save then refuses (or the
// other way round).
//
// Typed legs (the user's pick, 2026-11-07, mockup https://claude.ai/code/artifact/ff9c67cb-1556-48b4-a4f8-420c4084e91e
// option D): every contract leg says what it is, as on a shipment's route table. A Pick-up leg is the carrier's
// pre-carriage to the port of loading: its From is the pick-up place(s) (polHaulageLocations, several UN/LOCODEs,
// blank = anywhere; pol mirrors the first), the kind of place (polLocType) and the mode (movementBy, blank = any).
// A Delivery leg is the same at its To end. SEA legs are port to port. Order: Pick-up first (at most one), the SEA
// legs, Delivery last (at most one).

const up = s => String(s || "").trim().toUpperCase();
export const locationsOf = s => String(s || "").split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(Boolean);

export const LEG_TYPES = ["Pick-up", "SEA", "Delivery"];
export const legTypeOf = l => (LEG_TYPES.includes(l?.legType) ? l.legType : "SEA");
// The shipment's location types (legLocation.js LOC_TYPE_OPTIONS); contract legs used to say "CY".
export const canonLocType = t => (t === "CY" ? "Container Yard" : t === "GPS Coordinates" ? "Door" : t || "Terminal");
export const CONTRACT_LOC_TYPES = ["Door", "Container Yard", "Terminal", "CFS"];
export const shortLocType = t => ({ "Container Yard": "CY", CY: "CY" }[t] || t || "Terminal");
// The shipment's transport modes (ShipmentFormPage.jsx MOVEMENT_BY_OPTIONS); "" = any.
export const CONTRACT_MODES = ["", "Barge", "Rail", "Truck", "Vessel"];
export const LINE_ORDER_HELP = "The order on a contract line: the Pick-up leg when the carrier collects (at most one), the SEA legs, then the Delivery leg when the carrier delivers (at most one).";

// The places a Pick-up leg collects from / a Delivery leg delivers to ([] = anywhere).
export function placesOf(leg) {
  const t = legTypeOf(leg);
  if (t === "Pick-up") return locationsOf(leg.polHaulageLocations).length ? locationsOf(leg.polHaulageLocations) : locationsOf(leg.pol);
  if (t === "Delivery") return locationsOf(leg.podHaulageLocations).length ? locationsOf(leg.podHaulageLocations) : locationsOf(leg.pod);
  return [];
}

// Same identity the server uses for "the same routing": each leg's type, ports, location types and
// service code, and the places and mode of its Pick-up / Delivery leg.
export function lineKey(legs) {
  if (!legs.length) return "";
  return JSON.stringify(legs.map(l => {
    const t = legTypeOf(l);
    return [t, up(l.pol), canonLocType(l.polLocType), up(l.pod), canonLocType(l.podLocType), up(l.vesselService),
      t === "Pick-up" ? locationsOf(l.polHaulageLocations).join(" ") : t === "Delivery" ? locationsOf(l.podHaulageLocations).join(" ") : "",
      t === "SEA" ? "" : up(l.movementBy)];
  }));
}

// What's wrong with one line's legs, in order (empty = fine). Same messages as the server's lineProblems.
export function lineProblems(legs) {
  const types = legs.map(legTypeOf);
  const problems = [];
  const nP = types.filter(t => t === "Pick-up").length, nD = types.filter(t => t === "Delivery").length;
  if (nP > 1) problems.push("A line has at most one Pick-up leg.");
  if (nD > 1) problems.push("A line has at most one Delivery leg.");
  if (nP && types[0] !== "Pick-up") problems.push("The Pick-up leg comes first, before the SEA legs.");
  if (nD && types[types.length - 1] !== "Delivery") problems.push("The Delivery leg comes last, after the SEA legs.");
  if (legs.length && !types.includes("SEA")) problems.push("A line needs at least one SEA leg.");
  // A Pick-up leg ends where the line loads, a Delivery leg starts where it discharges: without that port it would be cut off
  // into a line of its own (audit 2026-11-07, A3 TKT-19CS91).
  legs.forEach((l, i) => {
    if (types[i] === "Pick-up" && !up(l.pod)) problems.push("The Pick-up leg needs its To: the port of loading it takes the container to.");
    if (types[i] === "Delivery" && !up(l.pol)) problems.push("The Delivery leg needs its From: the port of discharge it collects the container at.");
  });
  const pIdx = types.indexOf("Pick-up"), dIdx = types.lastIndexOf("Delivery");
  const next = legs[pIdx + 1], prev = legs[dIdx - 1];
  if (nP === 1 && pIdx === 0 && next && legTypeOf(next) === "SEA" && legs[0].pod && next.pol && up(legs[0].pod) !== up(next.pol))
    problems.push(`The Pick-up leg ends at ${up(legs[0].pod)}, but the leg after it loads at ${up(next.pol)}.`);
  if (nD === 1 && dIdx === legs.length - 1 && dIdx > 0 && prev && legTypeOf(prev) === "SEA" && legs[dIdx].pol && prev.pod && up(legs[dIdx].pol) !== up(prev.pod))
    problems.push(`The Delivery leg starts at ${up(legs[dIdx].pol)}, but the leg before it discharges at ${up(prev.pod)}.`);
  return problems;
}

// The editor's Leg dropdown: the line's legs with leg `index` turned into `type`, put in the line's order (the
// way the shipment's route table orders its legs), or { refused } when the line already has a leg of that kind
// (one Pick-up and one Delivery per line). The leg's fields follow its new type.
const RANK = { "Pick-up": 0, SEA: 1, Delivery: 2 };
export function applyLegType(lineLegs, index, type) {
  const cur = lineLegs[index];
  if (!cur || legTypeOf(cur) === type) return { legs: lineLegs };
  if (type !== "SEA" && lineLegs.some((l, i) => i !== index && legTypeOf(l) === type)) {
    return { refused: [`A line has at most one ${type} leg, and this change would make a second one. Make the other one a SEA leg, or remove it.`, LINE_ORDER_HELP] };
  }
  let leg;
  if (type === "Pick-up") {
    leg = { ...cur, legType: type, polHaulageLocations: locationsOf(cur.pol).join(" "), polCarrierHaulage: true, polLinkedAllowed: false,
      polLocType: cur.polLocType && canonLocType(cur.polLocType) !== "Terminal" ? canonLocType(cur.polLocType) : "Door",
      podLocType: "Terminal", podHaulageLocations: "", podCarrierHaulage: false, movementBy: cur.movementBy || "" };
  } else if (type === "Delivery") {
    leg = { ...cur, legType: type, podHaulageLocations: locationsOf(cur.pod).join(" "), podCarrierHaulage: true, podLinkedAllowed: false,
      podLocType: cur.podLocType && canonLocType(cur.podLocType) !== "Terminal" ? canonLocType(cur.podLocType) : "Door",
      polLocType: "Terminal", polHaulageLocations: "", polCarrierHaulage: false, movementBy: cur.movementBy || "" };
  } else {
    leg = { ...cur, legType: "SEA", polLocType: "Terminal", podLocType: "Terminal", polHaulageLocations: "", podHaulageLocations: "",
      polCarrierHaulage: false, podCarrierHaulage: false, movementBy: "" };
  }
  const next = lineLegs.map((l, i) => (i === index ? leg : l));
  return { legs: next.map((l, i) => [l, i]).sort((a, b) => RANK[legTypeOf(a[0])] - RANK[legTypeOf(b[0])] || a[1] - b[1]).map(([l]) => l) };
}

// The leg's position in its line, for the old badge (kept for readers that only show it).
export function legKind(legs, i) {
  const t = legTypeOf(legs[i]);
  return t === "Pick-up" ? "pre" : t === "Delivery" ? "on" : "sea";
}
export const LEG_KIND_LABEL = { pre: "Pick-up", sea: "SEA", on: "Delivery" };

// The line's chain as the mockup shows it: PKU → POL → Via origin → Via destination → POD → DEL.
// POL/POD come from the SEA legs; transshipment ports are where SEA legs meet. One transshipment
// port is "via origin" (the main leg usually runs from it to the POD); two or more show the first
// as via origin and the last as via destination. PKU / DEL: the Pick-up / Delivery leg's places
// ("any" when it names none), kind of place and mode, e.g. "NLAMS DEBER · Door · Truck".
export function lineChain(legs) {
  const set = legs.filter(l => l.pol || l.pod || legTypeOf(l) !== "SEA");
  if (!set.length) return null;
  const seaLegs = set.filter(l => legTypeOf(l) === "SEA");
  const sea = seaLegs.length ? seaLegs : set;
  const pick = set.find(l => legTypeOf(l) === "Pick-up"), drop = set.find(l => legTypeOf(l) === "Delivery");
  const endOf = (leg, side) => {
    if (!leg) return null;
    const places = placesOf(leg);
    return [places.length ? places.join(" ") : "any", shortLocType(canonLocType(leg[`${side}LocType`])), leg.movementBy].filter(Boolean).join(" · ");
  };
  const tsps = sea.slice(0, -1).map(l => up(l.pod)).filter(Boolean);
  return {
    pku: endOf(pick, "pol"),
    pol: up(sea[0].pol),
    viaOrigin: tsps[0] || null,
    viaDestination: tsps.length > 1 ? tsps[tsps.length - 1] : null,
    pod: up(sea[sea.length - 1].pod),
    hubs: tsps, // every transshipment port in order ([] = direct) — the sailing search follows them
    del: endOf(drop, "pod"),
    services: [...new Set(set.map(l => up(l.vesselService)).filter(Boolean))],
    transitDays: set.reduce((s, l) => s + (Number(l.transitDays) || 0), 0),
  };
}

export const chainLabel = c => c ? [c.pol, c.viaOrigin, c.viaDestination, c.pod].filter(Boolean).join(" → ") : "";

// One contract leg as a chip (the Dashboard's contract card): a SEA leg as its ports, a Pick-up / Delivery leg as what the
// carrier does there, e.g. "PKU NLAMS DEBER · Door · Truck" or "DEL any · CY" (audit 2026-11-07, A4: it read " → NLRTM").
export function legChipLabel(leg) {
  const t = legTypeOf(leg);
  if (t === "SEA") return `${up(leg.pol)} → ${up(leg.pod)}`;
  const places = placesOf(leg);
  const kind = shortLocType(canonLocType(t === "Pick-up" ? leg.polLocType : leg.podLocType));
  return `${t === "Pick-up" ? "PKU" : "DEL"} ${[places.length ? places.join(" ") : "any", kind, leg.movementBy].filter(Boolean).join(" · ")}`;
}

// Every line whose key repeats an earlier line's, as { [lineIndex]: firstLineIndex }. Lines with
// no complete leg yet are skipped, so a half-filled new line never shows as a duplicate. A Pick-up
// leg's From and a Delivery leg's To may be blank (anywhere).
const legComplete = l => {
  const t = legTypeOf(l);
  return (t === "Pick-up" || !!l.pol) && (t === "Delivery" || !!l.pod);
};
export function findDuplicateLines(routingCount, legs) {
  const seen = new Map(), dup = {};
  for (let i = 0; i < routingCount; i++) {
    const own = legs.filter(l => l.routingIndex === i);
    if (!own.length || own.some(l => !legComplete(l))) continue;
    const key = lineKey(own);
    if (seen.has(key)) dup[i] = seen.get(key); else seen.set(key, i);
  }
  return dup;
}

// Where a line's legs don't connect: leg N discharges somewhere other than where leg N+1 loads.
// Only flagged once both ports around the join are set, so a leg being filled in never warns.
export function findChainGaps(orderedLegs) {
  const gaps = [];
  for (let i = 1; i < orderedLegs.length; i++) {
    const prev = orderedLegs[i - 1], cur = orderedLegs[i];
    if (prev.pod && cur.pol && up(prev.pod) !== up(cur.pol)) gaps.push({ afterLegPos: i, prevPod: up(prev.pod), nextPol: up(cur.pol) });
  }
  return gaps;
}

// The ports a leg still needs before the line can be saved: both, except a Pick-up leg's From and a Delivery
// leg's To, which may stay blank (anywhere).
export const legMissingPorts = l => !legComplete(l);
