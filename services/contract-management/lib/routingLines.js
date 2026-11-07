"use strict";

// Contract routing lines (approved mockup: https://claude.ai/artifact/YMjKwCQDPdSFYP5auHrki9).
// Every leg of a contract belongs to a routing (contract_routings row), and each routing is ONE
// line: a single connected run of legs, and no two routings on a contract may describe the same line.
//
// Typed legs (the user's pick, 2026-11-07, mockup https://claude.ai/code/artifact/ff9c67cb-1556-48b4-a4f8-420c4084e91e
// option D): every contract leg says what it is, as on a shipment's route table. "Pick-up" is the carrier's
// pre-carriage to the port of loading, "SEA" a sea leg, "Delivery" the carrier's on-carriage from the port of
// discharge. A Pick-up leg's From is where the carrier collects: its places (polHaulageLocations, several
// UN/LOCODEs, blank = anywhere; pol mirrors the first), the kind of place (polLocType: Door, Container Yard,
// Terminal or CFS, the shipment's location types) and the mode (movementBy: Barge, Rail, Truck, Vessel; blank =
// any). Its To is the line's port of loading. A Delivery leg is the same at the To end. So a barge from a door in
// Ho Chi Minh City to the Vung Tau terminal is Pick-up VNSGN Door → VNVUT Terminal by Barge, then SEA VNVUT → USSAV.
// A line: at most one Pick-up leg (first), the SEA legs, at most one Delivery leg (last); no Merchant's Haulage
// (a carrier contract prices only its own haulage). pol/podCarrierHaulage stay as derived flags (true on the
// Pick-up / Delivery leg's outer end) for readers that only show them.
//
// Contracts didn't always look like this. Legs could sit in the implicit '' group, and that
// group could hold several unrelated lanes (53-2240 lists NLRTM→USLAX, DEBRE→USLAX and
// DEHAM→USNYC side by side). Carrier haulage was a flag on the first leg's From end (or the last
// leg's To end), with a location type and one place, or a leg from and to the same port. normalizeRoutingLines
// rewrites a contract payload into the line shape with typed legs; the save routes run every payload through
// it, and the startup migration runs every stored contract through it, so both old data and new saves end up
// in the same shape.
//
// Rates are untouched except where a routing is split: a routing-specific rate is copied onto the
// lines split off from its routing, and a rate of a routing that ends up with no legs is dropped
// (it used to silently become contract-wide). Contract-wide rates (no routing) stay contract-wide
// and keep applying to every line, so splitting the old '' group changes no price.
//
// A copy of the monolith's lib/routingLines.js (the service is its own package and image) —
// change both together.

const locs = s => String(s || "").split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
const up = s => String(s || "").trim().toUpperCase();
const uniq = a => [...new Set(a)];

const LEG_TYPES = ["Pick-up", "SEA", "Delivery"];
const legTypeOf = l => (LEG_TYPES.includes(l && l.legType) ? l.legType : "SEA");
// The shipment's location types (src/utils/legLocation.js LOC_TYPE_OPTIONS). Contract legs used to say "CY";
// GPS coordinates are a door.
const canonLocType = t => (t === "CY" ? "Container Yard" : t === "GPS Coordinates" ? "Door" : t || "Terminal");
const LINE_ORDER_HELP = "The order on a contract line: the Pick-up leg when the carrier collects (at most one), the SEA legs, then the Delivery leg when the carrier delivers (at most one).";

// A leg in its typed shape: the type's derived fields filled in, the rest of the haulage fields cleared.
function typedLeg(l) {
  const t = legTypeOf(l);
  const out = { ...l, legType: t, polLocType: canonLocType(l.polLocType), podLocType: canonLocType(l.podLocType) };
  if (t === "Pick-up") {
    const places = uniq(locs(l.polHaulageLocations).length ? locs(l.polHaulageLocations) : locs(l.pol));
    Object.assign(out, {
      pol: places[0] || "", polName: places[0] && places[0] === up(l.pol) ? (l.polName || "") : "",
      polHaulageLocations: places.join(" "), polCarrierHaulage: true, polLinkedAllowed: false,
      podHaulageLocations: "", podCarrierHaulage: false, movementBy: l.movementBy || "",
    });
  } else if (t === "Delivery") {
    const places = uniq(locs(l.podHaulageLocations).length ? locs(l.podHaulageLocations) : locs(l.pod));
    Object.assign(out, {
      pod: places[0] || "", podName: places[0] && places[0] === up(l.pod) ? (l.podName || "") : "",
      podHaulageLocations: places.join(" "), podCarrierHaulage: true, podLinkedAllowed: false,
      polHaulageLocations: "", polCarrierHaulage: false, movementBy: l.movementBy || "",
    });
  } else {
    Object.assign(out, { polLocType: "Terminal", podLocType: "Terminal", polHaulageLocations: "", podHaulageLocations: "",
      polCarrierHaulage: false, podCarrierHaulage: false, movementBy: "" });
  }
  return out;
}

// An untyped (pre-2026-11-07) run in its typed shape. The first leg's carrier-haulage flag becomes a Pick-up leg
// in front of it (or the leg itself, when it runs from and to the same port), with the flag's places and location
// type; the last leg's becomes a Delivery leg after it. A run that already has a typed leg is left alone.
function typeLegacyRun(run) {
  if (run.some(l => LEG_TYPES.includes(l.legType))) return run.map(typedLeg);
  const legs = run.map(l => ({ ...l, legType: "SEA" }));
  const n = legs.length, first = legs[0], last = legs[n - 1];
  const samePort = l => !!l.pol && up(l.pol) === up(l.pod);
  const slot = l => ({ routingIndex: l.routingIndex, routingId: l.routingId });
  const out = [...legs];
  if (first.polCarrierHaulage) {
    const kind = canonLocType(first.polLocType), places = locs(first.polHaulageLocations).join(" ");
    if (n > 1 && samePort(first)) {
      Object.assign(first, { legType: "Pick-up", polLocType: kind, polHaulageLocations: places, pol: "" });
    } else {
      out.unshift({ ...slot(first), legType: "Pick-up", pol: "", polName: "", pod: first.pol, podName: first.polName || "",
        polLocType: kind, podLocType: "Terminal", polHaulageLocations: places, movementBy: "", transitDays: 0, vesselService: "" });
      Object.assign(first, { polCarrierHaulage: false, polHaulageLocations: "", polLocType: "Terminal" });
    }
  }
  if (last.podCarrierHaulage) {
    const kind = canonLocType(last.podLocType), places = locs(last.podHaulageLocations).join(" ");
    if (n > 1 && samePort(last)) {
      Object.assign(last, { legType: "Delivery", podLocType: kind, podHaulageLocations: places, pod: "" });
    } else {
      out.push({ ...slot(last), legType: "Delivery", pol: last.pod, polName: last.podName || "", pod: "", podName: "",
        polLocType: "Terminal", podLocType: kind, podHaulageLocations: places, movementBy: "", transitDays: 0, vesselService: "" });
      Object.assign(last, { podCarrierHaulage: false, podHaulageLocations: "", podLocType: "Terminal" });
    }
  }
  return out.map(typedLeg);
}

// What's wrong with one line's legs, in payload order (empty = fine). The order the shipment's route table
// keeps: the Pick-up leg first, the SEA legs, the Delivery leg last, and each meets the next.
function lineProblems(legs) {
  const types = legs.map(legTypeOf);
  const problems = [];
  const nP = types.filter(t => t === "Pick-up").length, nD = types.filter(t => t === "Delivery").length;
  if (nP > 1) problems.push("A line has at most one Pick-up leg.");
  if (nD > 1) problems.push("A line has at most one Delivery leg.");
  if (nP && types[0] !== "Pick-up") problems.push("The Pick-up leg comes first, before the SEA legs.");
  if (nD && types[types.length - 1] !== "Delivery") problems.push("The Delivery leg comes last, after the SEA legs.");
  if (legs.length && !types.includes("SEA")) problems.push("A line needs at least one SEA leg.");
  const pIdx = types.indexOf("Pick-up"), dIdx = types.lastIndexOf("Delivery");
  const next = legs[pIdx + 1], prev = legs[dIdx - 1];
  if (nP === 1 && pIdx === 0 && next && legTypeOf(next) === "SEA" && legs[0].pod && next.pol && up(legs[0].pod) !== up(next.pol))
    problems.push(`The Pick-up leg ends at ${up(legs[0].pod)}, but the leg after it loads at ${up(next.pol)}.`);
  if (nD === 1 && dIdx === legs.length - 1 && dIdx > 0 && prev && legTypeOf(prev) === "SEA" && legs[dIdx].pol && prev.pod && up(legs[dIdx].pol) !== up(prev.pod))
    problems.push(`The Delivery leg starts at ${up(legs[dIdx].pol)}, but the leg before it discharges at ${up(prev.pod)}.`);
  return problems;
}

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

// One run, one line per pick-up × delivery combination when either end lists several places. Only for the old
// one-place-per-end rule; typed lines take several places on their Pick-up and Delivery legs.
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

// What makes two lines "the same": each leg's type, ports and location types, service code, and the
// places and mode of its Pick-up / Delivery leg. Identical to src/utils/routingLines.js's lineKey.
function lineKey(run) {
  return JSON.stringify(run.map(l => {
    const t = legTypeOf(l);
    return [t, up(l.pol), canonLocType(l.polLocType), up(l.pod), canonLocType(l.podLocType), up(l.vesselService),
      t === "Pick-up" ? locs(l.polHaulageLocations).join(" ") : t === "Delivery" ? locs(l.podHaulageLocations).join(" ") : "",
      t === "SEA" ? "" : up(l.movementBy)];
  }));
}

// e.g. "NLRTM → BEANR → USNYC" or "NLRTM → USNYC (pick-up NLAMS DEBER, delivery USCHI)".
function lineLabel(run) {
  const sea = run.filter(l => legTypeOf(l) === "SEA");
  const legs = sea.length ? sea : run;
  const ports = [legs[0].pol, ...legs.map(l => l.pod)].map(p => String(p || "").toUpperCase());
  const pick = run.find(l => legTypeOf(l) === "Pick-up"), drop = run.find(l => legTypeOf(l) === "Delivery");
  const ends = [];
  if (pick) ends.push(`pick-up ${locs(pick.polHaulageLocations).join(" ") || "anywhere"}`);
  if (drop) ends.push(`delivery ${locs(drop.podHaulageLocations).join(" ") || "anywhere"}`);
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
 * @returns {{ routings, legs, rates, changed, duplicate, problems }} legs/rates carry routingIndex into the
 *   returned routings (-1 on a rate = contract-wide); legs are typed. `duplicate` names two lines that describe
 *   the same routing, `problems` lines whose typed legs break the order ([{ line, messages }]); the save must be
 *   refused for either.
 */
function normalizeRoutingLines({ routings = [], legs = [], rates = [], storedLegs = [] }) {
  const inRoutings = routings.map(r => ({ ...r }));
  const legSlots = legs.map(l => slotOf(l, inRoutings));
  const typedPayload = legs.some(l => LEG_TYPES.includes(l.legType));
  const problems = [];

  // The key each stored routing's chain had before this save (typed, so an old-shape stored line still
  // finds itself again once typed).
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
      if (runs.length === 1) storedKeyById.set(id, lineKey(typeLegacyRun(runs[0])));
    }
  }
  // A line's legs as typed runs. A typed payload is checked for the order first: a Pick-up leg that doesn't
  // meet the SEA leg must be refused, not cut off into a line of its own.
  const linesOf = (own, label) => {
    if (typedPayload) {
      const p = lineProblems(own);
      if (p.length) { problems.push({ line: label, messages: p }); return [own.map(typedLeg)]; }
    }
    return runsOf(own).map(typeLegacyRun);
  };

  // Output lines: { routing, legs, fromSlot }.
  const lines = [];
  const splitFrom = []; // [outIndex, fromSlot] — lines split off an existing routing, for rate copies
  inRoutings.forEach((r, k) => {
    const own = legs.filter((_, i) => legSlots[i] === k);
    if (!own.length) return;
    const variants = linesOf(own, k + 1);
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
  for (const run of runsOf(loose).map(typeLegacyRun)) {
    if (typedPayload) {
      const p = lineProblems(run);
      if (p.length) problems.push({ line: lines.length + 1, messages: p });
    }
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

  // Everything a leg's typed shape can change, so the startup migration writes a contract whose legs it typed.
  const legSig = l => [legTypeOf(l), up(l.pol), up(l.pod), canonLocType(l.polLocType), canonLocType(l.podLocType),
    locs(l.polHaulageLocations).join(" "), locs(l.podHaulageLocations).join(" "), !!l.polCarrierHaulage, !!l.podCarrierHaulage,
    up(l.movementBy), !!l.polLinkedAllowed, !!l.podLinkedAllowed];
  // legTypeOf, not the raw value: a stored leg with no type yet (leg_type '') reads as SEA, so a contract with no
  // carrier haulage isn't rewritten just to write 'SEA' (its rates would be re-inserted for nothing).
  const sig = (rs, ls) => JSON.stringify([rs.map(r => [r.id || null, r.name || ""]), ls.map(l => [...legSig(l), slotOf(l, rs)])]);
  const changed = sig(inRoutings, legs) !== sig(outRoutings, outLegs) || outRates.length !== rates.length;

  return { routings: outRoutings, legs: outLegs, rates: outRates, changed, duplicate, problems };
}

// The save's refusal for problems from normalizeRoutingLines: each line's problems, then the order.
const lineProblemsError = problems =>
  `${problems.map(p => `Line ${p.line}: ${p.messages.join(" ")}`).join(" ")} ${LINE_ORDER_HELP}`;

// Stored routing ids that a normalized result no longer has — what a save or migration would
// delete. A routing with no legs left is dropped by normalizeRoutingLines.
function droppedRoutingIds(storedRoutings, normalizedRoutings) {
  const kept = new Set((normalizedRoutings || []).map(r => r.id).filter(Boolean));
  return (storedRoutings || []).map(r => r.id).filter(id => id && !kept.has(id));
}

module.exports = { normalizeRoutingLines, droppedRoutingIds, runsOf, expandLocations, lineKey, lineLabel,
  LEG_TYPES, legTypeOf, canonLocType, typedLeg, typeLegacyRun, lineProblems, lineProblemsError, LINE_ORDER_HELP };
