"use strict";

// Contract routing lines (approved mockup: https://claude.ai/artifact/YMjKwCQDPdSFYP5auHrki9).
// Every leg of a contract belongs to a routing (contract_routings row), and each routing is ONE
// line: a single connected run of legs, at most one pick-up location on its first leg and one
// delivery location on its last, and no two routings on a contract may describe the same line.
//
// Contracts didn't always look like this. Legs could sit in the implicit '' group, and that
// group could hold several unrelated lanes (53-2240 lists NLRTM→USLAX, DEBRE→USLAX and
// DEHAM→USNYC side by side); a leg's haulage-locations field could list several places
// ("DEBER NLAMS"). normalizeRoutingLines rewrites a contract payload into the line shape; the
// save routes run every payload through it, and the startup migration runs every stored contract
// through it, so both old data and new saves end up in the same shape.
//
// Rates are untouched except where a routing is split: a routing-specific rate is copied onto the
// lines split off from its routing, and a rate of a routing that ends up with no legs is dropped
// (it used to silently become contract-wide). Contract-wide rates (no routing) stay contract-wide
// and keep applying to every line, so splitting the old '' group changes no price.
//
// A copy of the monolith's lib/routingLines.js (the service is its own package and image) —
// change both together.

const locs = s => String(s || "").split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(Boolean);

// Legs in the given order, cut wherever a leg doesn't load where the previous one discharged.
function runsOf(legs) {
  const runs = [];
  for (const l of legs) {
    const cur = runs[runs.length - 1];
    if (cur && String(cur[cur.length - 1].pod || "").toUpperCase() === String(l.pol || "").toUpperCase()) cur.push(l);
    else runs.push([l]);
  }
  return runs;
}

// One run, one line per pick-up × delivery combination when either end lists several places.
function expandLocations(run) {
  const first = run[0], last = run[run.length - 1];
  const pkus = first.polCarrierHaulage ? locs(first.polHaulageLocations) : [];
  const dels = last.podCarrierHaulage ? locs(last.podHaulageLocations) : [];
  if (pkus.length <= 1 && dels.length <= 1) return [run];
  const out = [];
  for (const pku of pkus.length ? pkus : [null]) {
    for (const del of dels.length ? dels : [null]) {
      const legs = run.map(l => ({ ...l }));
      if (pku !== null) legs[0].polHaulageLocations = pku;
      if (del !== null) legs[legs.length - 1].podHaulageLocations = del;
      out.push(legs);
    }
  }
  return out;
}

// What makes two lines "the same": ports and location types in order, service codes, and the
// pick-up / delivery at the ends.
function lineKey(run) {
  const first = run[0], last = run[run.length - 1];
  const up = s => String(s || "").trim().toUpperCase();
  return JSON.stringify([
    first.polCarrierHaulage ? locs(first.polHaulageLocations).join(" ") : "",
    ...run.map(l => [up(l.pol), l.polLocType || "Terminal", up(l.pod), l.podLocType || "Terminal", up(l.vesselService)]),
    last.podCarrierHaulage ? locs(last.podHaulageLocations).join(" ") : "",
  ]);
}

// e.g. "NLRTM → BEANR → USNYC" or "NLRTM → USNYC (pick-up DEBER, delivery USLAX)".
function lineLabel(run) {
  const first = run[0], last = run[run.length - 1];
  const ports = [first.pol, ...run.map(l => l.pod)].map(p => String(p || "").toUpperCase());
  const ends = [];
  const pku = first.polCarrierHaulage ? locs(first.polHaulageLocations)[0] : "";
  const del = last.podCarrierHaulage ? locs(last.podHaulageLocations)[0] : "";
  if (pku) ends.push(`pick-up ${pku}`);
  if (del) ends.push(`delivery ${del}`);
  return ports.join(" → ") + (ends.length ? ` (${ends.join(", ")})` : "");
}

// A leg/rate's routing slot in `routings`: its routingIndex if valid, else the position of its
// routingId, else -1 (a loose leg / a contract-wide rate).
function slotOf(item, routings) {
  if (Number.isInteger(item.routingIndex) && item.routingIndex >= 0 && item.routingIndex < routings.length) return item.routingIndex;
  if (item.routingId) {
    const i = routings.findIndex(r => r.id && r.id === item.routingId);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * @param {object} p
 * @param {object[]} p.routings  [{ id?, name, transitDays, notes }] — the payload's routings
 * @param {object[]} p.legs      legs in payload order, each with routingIndex and/or routingId
 * @param {object[]} p.rates     rates, each with routingIndex and/or routingId ('' = contract-wide)
 * @param {object[]} [p.storedLegs] the contract's legs as stored before this save ({ routingId, ... }),
 *   used to hand a loose run back its old routing when the chain is unchanged — so a caller that
 *   PUTs plain legs, or the startup migration, doesn't churn routing ids.
 * @returns {{ routings, legs, rates, changed, duplicate }} legs/rates carry routingIndex into the
 *   returned routings (-1 on a rate = contract-wide). `duplicate` names two lines that describe
 *   the same routing (the save must be refused); null otherwise.
 */
function normalizeRoutingLines({ routings = [], legs = [], rates = [], storedLegs = [] }) {
  const inRoutings = routings.map(r => ({ ...r }));
  const legSlots = legs.map(l => slotOf(l, inRoutings));

  // The key each stored routing's chain had before this save.
  const storedKeyById = new Map();
  {
    const byRouting = new Map();
    for (const l of storedLegs) {
      if (!l.routingId) continue;
      if (!byRouting.has(l.routingId)) byRouting.set(l.routingId, []);
      byRouting.get(l.routingId).push(l);
    }
    for (const [id, ls] of byRouting) {
      const runs = runsOf([...ls].sort((a, b) => (a.legOrder ?? 0) - (b.legOrder ?? 0)));
      if (runs.length === 1) storedKeyById.set(id, lineKey(runs[0]));
    }
  }

  // Output lines: { routing, legs, fromSlot }.
  const lines = [];
  const splitFrom = []; // [outIndex, fromSlot] — lines split off an existing routing, for rate copies
  inRoutings.forEach((r, k) => {
    const own = legs.filter((_, i) => legSlots[i] === k);
    if (!own.length) return;
    const variants = runsOf(own).flatMap(expandLocations);
    variants.forEach((run, v) => {
      if (v === 0) lines.push({ routing: r, legs: run, fromSlot: k });
      else {
        lines.push({ routing: { name: lineLabel(run), transitDays: r.transitDays || 0, notes: "" }, legs: run, fromSlot: k });
        splitFrom.push([lines.length - 1, k]);
      }
    });
  });

  // Loose legs: back to a routing whose stored chain matches (and that has no legs of its own in
  // this payload), else a new routing.
  const loose = legs.filter((_, i) => legSlots[i] === -1);
  const takenIds = new Set(lines.map(x => x.routing.id).filter(Boolean));
  for (const run of runsOf(loose).flatMap(expandLocations)) {
    const key = lineKey(run);
    const reuse = inRoutings.find(r => r.id && !takenIds.has(r.id) && storedKeyById.get(r.id) === key);
    let routing = reuse;
    if (!routing) {
      const storedId = [...storedKeyById].find(([id, k]) => k === key && !takenIds.has(id))?.[0];
      routing = storedId ? { id: storedId, name: lineLabel(run), transitDays: 0, notes: "" } : { name: lineLabel(run), transitDays: 0, notes: "" };
    }
    if (routing.id) takenIds.add(routing.id);
    lines.push({ routing, legs: run, fromSlot: reuse ? inRoutings.indexOf(reuse) : -1 });
  }

  // Two lines describing the same routing can't both exist.
  const seen = new Map();
  let duplicate = null;
  lines.forEach((x, i) => {
    const key = lineKey(x.legs);
    if (seen.has(key) && !duplicate) duplicate = { first: seen.get(key), second: i, label: lineLabel(x.legs) };
    if (!seen.has(key)) seen.set(key, i);
  });

  const outRoutings = lines.map(x => x.routing);
  const outLegs = lines.flatMap((x, i) => x.legs.map(l => ({ ...l, routingIndex: i, routingId: x.routing.id || "" })));
  const outIndexOfSlot = new Map();
  lines.forEach((x, i) => { if (x.fromSlot >= 0 && !outIndexOfSlot.has(x.fromSlot)) outIndexOfSlot.set(x.fromSlot, i); });

  const outRates = [];
  for (const rate of rates) {
    const slot = slotOf(rate, inRoutings);
    if (slot === -1) {
      // Contract-wide, or a stale routingId the save's name fallback may still resolve.
      outRates.push(rate.routingId && !inRoutings.some(r => r.id === rate.routingId) ? { ...rate } : { ...rate, routingIndex: -1, routingId: "" });
      continue;
    }
    if (!outIndexOfSlot.has(slot)) continue; // its routing has no legs left — drop the rate with it
    outRates.push({ ...rate, routingIndex: outIndexOfSlot.get(slot), routingId: outRoutings[outIndexOfSlot.get(slot)].id || "" });
    for (const [outIdx, from] of splitFrom) {
      if (from === slot) outRates.push({ ...rate, id: undefined, routingIndex: outIdx, routingId: "" });
    }
  }

  const sig = (rs, ls) => JSON.stringify([rs.map(r => [r.id || null, r.name || ""]), ls.map(l => [l.pol, l.pod, l.polHaulageLocations || "", l.podHaulageLocations || "", slotOf(l, rs)])]);
  const changed = sig(inRoutings, legs) !== sig(outRoutings, outLegs) || outRates.length !== rates.length;

  return { routings: outRoutings, legs: outLegs, rates: outRates, changed, duplicate };
}

module.exports = { normalizeRoutingLines, runsOf, expandLocations, lineKey, lineLabel };
