// Contract routing lines, client side (approved mockup, Option 1:
// https://claude.ai/artifact/YMjKwCQDPdSFYP5auHrki9). A routing is ONE line: a connected run of
// legs with at most one pick-up and one delivery location. The server enforces the same rules in
// lib/routingLines.js — lineKey below must stay identical to its lineKey, or the editor would
// accept a line the save then refuses (or the other way round).

const up = s => String(s || "").trim().toUpperCase();
export const locationsOf = s => String(s || "").split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(Boolean);

// Same identity the server uses for "the same routing": pick-up, every leg's ports / location
// types / service code, delivery.
export function lineKey(legs) {
  if (!legs.length) return "";
  const first = legs[0], last = legs[legs.length - 1];
  return JSON.stringify([
    first.polCarrierHaulage ? locationsOf(first.polHaulageLocations).join(" ") : "",
    ...legs.map(l => [up(l.pol), l.polLocType || "Terminal", up(l.pod), l.podLocType || "Terminal", up(l.vesselService)]),
    last.podCarrierHaulage ? locationsOf(last.podHaulageLocations).join(" ") : "",
  ]);
}

// A leg that starts and ends at the same port is carrier haulage into or out of that port
// (e.g. NLRTM Door → NLRTM Terminal), not a sea leg.
const isHaulageLeg = l => !!l.pol && up(l.pol) === up(l.pod);

export function legKind(legs, i) {
  if (legs.length > 1 && isHaulageLeg(legs[i])) {
    if (i === 0) return "pre";
    if (i === legs.length - 1) return "on";
  }
  return "sea";
}
export const LEG_KIND_LABEL = { pre: "Pre-carriage", sea: "Sea", on: "On-carriage" };

// The line's chain as the mockup shows it: PKU → POL → Via origin → Via destination → POD → DEL.
// POL/POD come from the sea legs; transshipment ports are where sea legs meet. One transshipment
// port is "via origin" (the main leg usually runs from it to the POD); two or more show the first
// as via origin and the last as via destination.
export function lineChain(legs) {
  const set = legs.filter(l => l.pol || l.pod);
  if (!set.length) return null;
  const first = set[0], last = set[set.length - 1];
  let sea = set;
  if (sea.length > 1 && isHaulageLeg(sea[0])) sea = sea.slice(1);
  if (sea.length > 1 && isHaulageLeg(sea[sea.length - 1])) sea = sea.slice(0, -1);
  const end = (haulage, locs, locType, port) => {
    if (!haulage && (!locType || locType === "Terminal")) return null;
    const l = locationsOf(locs);
    return l.length ? l.join(" ") : `${locType || "Door"} · ${up(port)}`;
  };
  const tsps = sea.slice(0, -1).map(l => up(l.pod)).filter(Boolean);
  return {
    pku: end(first.polCarrierHaulage, first.polHaulageLocations, first.polLocType, first.pol),
    pol: up(sea[0].pol),
    viaOrigin: tsps[0] || null,
    viaDestination: tsps.length > 1 ? tsps[tsps.length - 1] : null,
    pod: up(sea[sea.length - 1].pod),
    del: end(last.podCarrierHaulage, last.podHaulageLocations, last.podLocType, last.pod),
    services: [...new Set(set.map(l => up(l.vesselService)).filter(Boolean))],
    transitDays: set.reduce((s, l) => s + (Number(l.transitDays) || 0), 0),
  };
}

export const chainLabel = c => c ? [c.pol, c.viaOrigin, c.viaDestination, c.pod].filter(Boolean).join(" → ") : "";

// Every line whose key repeats an earlier line's, as { [lineIndex]: firstLineIndex }. Lines with
// no complete leg yet are skipped, so a half-filled new line never shows as a duplicate.
export function findDuplicateLines(routingCount, legs) {
  const seen = new Map(), dup = {};
  for (let i = 0; i < routingCount; i++) {
    const own = legs.filter(l => l.routingIndex === i);
    if (!own.length || own.some(l => !l.pol || !l.pod)) continue;
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

// A line's first leg may name ONE pick-up location and its last leg ONE delivery location.
export function tooManyLocations(legs) {
  if (!legs.length) return null;
  const first = legs[0], last = legs[legs.length - 1];
  if (first.polCarrierHaulage && locationsOf(first.polHaulageLocations).length > 1) return "pick-up";
  if (last.podCarrierHaulage && locationsOf(last.podHaulageLocations).length > 1) return "delivery";
  return null;
}
