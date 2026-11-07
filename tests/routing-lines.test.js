/**
 * Contract routing lines — unit tests for lib/routingLines.js (no server needed)
 *
 * Usage:
 *   node tests/routing-lines.test.js
 *
 * normalizeRoutingLines turns any contract payload into "one routing per line": loose legs become
 * routings, a routing that isn't one connected chain is split, and two lines describing the same routing are
 * reported. Since 2026-11-07 every leg is typed (Pick-up / SEA / Delivery, the user's option D): an old carrier-
 * haulage flag becomes a Pick-up or Delivery leg with its places (several allowed), and a typed line out of order
 * is reported. The shapes below are the real ones found in the data (53-2240's three side-by-side lanes on
 * 2026-09-30; CMDU-CH-EUN-NAM, suck_it_up, HLCU-EUN_USWC_0001 and AUDIT-HAULAGE-TEST on 2026-11-06).
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { normalizeRoutingLines, droppedRoutingIds, lineProblemsError } = require("../lib/routingLines.js");

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const leg = (pol, pod, extra = {}) => ({ pol, pod, polLocType: "Terminal", podLocType: "Terminal", vesselService: "", polCarrierHaulage: false, podCarrierHaulage: false, polHaulageLocations: "", podHaulageLocations: "", ...extra });
const rate = (serviceCode, amount, extra = {}) => ({ serviceCode, amount, currency: "USD", unit: "per_container", ...extra });
const chainOf = (out, i) => out.legs.filter(l => l.routingIndex === i).map(l => `${l.pol}>${l.pod}`).join(",");

console.log("\nA plain one-chain contract becomes a single routing line");
{
  const out = normalizeRoutingLines({ legs: [leg("NLRTM", "BEANR"), leg("BEANR", "USNYC")], rates: [rate("OF", 500)] });
  assert("one routing", out.routings.length === 1, JSON.stringify(out.routings));
  assert("named after its chain", out.routings[0].name === "NLRTM → BEANR → USNYC", out.routings[0].name);
  assert("both legs on it, in order", chainOf(out, 0) === "NLRTM>BEANR,BEANR>USNYC", chainOf(out, 0));
  assert("the rate stays contract-wide", out.rates.length === 1 && out.rates[0].routingIndex === -1);
  assert("reported as changed", out.changed === true);
  assert("no duplicate", out.duplicate === null);
}

console.log("\nSide-by-side lanes in one group (53-2240 / EUS-US) split into one line each");
{
  const out = normalizeRoutingLines({ legs: [leg("NLRTM", "USLAX", { vesselService: "AL1" }), leg("DEBRE", "USLAX"), leg("DEHAM", "USNYC")], rates: [rate("OF", 900)] });
  assert("three routings", out.routings.length === 3, JSON.stringify(out.routings.map(r => r.name)));
  assert("each holds one lane", [0, 1, 2].map(i => chainOf(out, i)).join("|") === "NLRTM>USLAX|DEBRE>USLAX|DEHAM>USNYC");
  assert("the contract-wide rate still applies to all of them", out.rates.length === 1 && out.rates[0].routingIndex === -1);
}

const typed = out => out.legs.map(l => `${l.legType}:${l.pol || "*"}(${l.polLocType})>${l.pod || "*"}(${l.podLocType})${l.legType === "Pick-up" ? "[" + l.polHaulageLocations + "]" : l.legType === "Delivery" ? "[" + l.podHaulageLocations + "]" : ""}${l.movementBy ? "/" + l.movementBy : ""}`).join(" | ");

console.log("\nSeveral pick-ups / deliveries on one leg (CMDU-CH-EUN-NAM's first shape) become ONE typed line, both places on each end");
{
  const out = normalizeRoutingLines({ legs: [leg("NLRTM", "USNYC", { polLocType: "Door", podLocType: "Door", polCarrierHaulage: true, podCarrierHaulage: true, polHaulageLocations: "DEBER NLAMS", podHaulageLocations: "USLAX USCHI" })] });
  assert("one line", out.routings.length === 1, JSON.stringify(out.routings.map(r => r.name)));
  assert("Pick-up from DEBER or NLAMS, the SEA leg, Delivery to USLAX or USCHI", typed(out) === "Pick-up:DEBER(Door)>NLRTM(Terminal)[DEBER NLAMS] | SEA:NLRTM(Terminal)>USNYC(Terminal) | Delivery:USNYC(Terminal)>USLAX(Door)[USLAX USCHI]", typed(out));
  assert("the name says which pick-ups and deliveries", out.routings[0].name === "NLRTM → USNYC (pick-up DEBER NLAMS, delivery USLAX USCHI)", out.routings[0].name);
  assert("the derived flags sit on the typed legs' outer ends", out.legs[0].polCarrierHaulage && !out.legs[1].polCarrierHaulage && !out.legs[1].podCarrierHaulage && out.legs[2].podCarrierHaulage);
}

console.log("\nThe stored shapes of 2026-11-06 turn into typed legs (the startup migration), and stay put after that");
{
  const R = legs => ({ routings: [{ id: "R1", name: "x" }], legs: legs.map(l => ({ ...l, routingId: "R1" })), rates: [rate("OF", 500, { routingId: "R1" })] });
  const run = input => {
    const out = normalizeRoutingLines({ ...input, storedLegs: input.legs });
    const again = normalizeRoutingLines({ routings: out.routings, legs: out.legs, rates: out.rates, storedLegs: out.legs });
    return { out, again };
  };
  {
    const { out, again } = run(R([leg("NLRTM", "BEANR", { polCarrierHaulage: true, polLocType: "Door", polHaulageLocations: "NLAMS" }), leg("BEANR", "USNYC", { podCarrierHaulage: true, podLocType: "CY", podHaulageLocations: "USNYC" })]));
    assert("suck_it_up: Pick-up NLAMS Door, two SEA legs, Delivery to a Container Yard at USNYC (CY renamed)", typed(out) === "Pick-up:NLAMS(Door)>NLRTM(Terminal)[NLAMS] | SEA:NLRTM(Terminal)>BEANR(Terminal) | SEA:BEANR(Terminal)>USNYC(Terminal) | Delivery:USNYC(Terminal)>USNYC(Container Yard)[USNYC]", typed(out));
    assert("written once (changed), then left alone; its routing and rate kept", out.changed && !again.changed && out.rates.length === 1 && out.routings[0].id === "R1");
  }
  {
    const { out, again } = run(R([leg("NLRTM", "NLRTM", { polCarrierHaulage: true, polLocType: "Door" }), leg("NLRTM", "BEANR"), leg("BEANR", "USLAX")]));
    assert("HLCU-EUN_USWC_0001: its same-port haulage leg is the Pick-up leg, from any Door (as it matched)", typed(out) === "Pick-up:*(Door)>NLRTM(Terminal)[] | SEA:NLRTM(Terminal)>BEANR(Terminal) | SEA:BEANR(Terminal)>USLAX(Terminal)", typed(out));
    assert("then left alone", !again.changed);
  }
  {
    const { out } = run(R([leg("ZZAUD1", "ZZAUD2", { polCarrierHaulage: true, polLocType: "Terminal" })]));
    assert("AUDIT-HAULAGE-TEST: a Pick-up leg from any terminal", typed(out) === "Pick-up:*(Terminal)>ZZAUD1(Terminal)[] | SEA:ZZAUD1(Terminal)>ZZAUD2(Terminal)", typed(out));
  }
  {
    const { out } = run(R([leg("NLRTM", "USNYC")]));
    assert("a contract with no carrier haulage isn't rewritten", out.changed === false);
  }
}

console.log("\nTyped lines: the barge example saves; a line out of order is refused with what's wrong and the order");
{
  const barge = normalizeRoutingLines({ routings: [{ name: "" }], legs: [
    { ...leg("VNSGN", "VNVUT", { legType: "Pick-up", polLocType: "Door", movementBy: "Barge" }), routingIndex: 0 },
    { ...leg("VNVUT", "USSAV", { legType: "SEA" }), routingIndex: 0 }] });
  assert("Pick-up VNSGN Door by Barge → VNVUT, SEA VNVUT → USSAV, no problems", typed(barge) === "Pick-up:VNSGN(Door)>VNVUT(Terminal)[VNSGN]/Barge | SEA:VNVUT(Terminal)>USSAV(Terminal)" && barge.problems.length === 0, typed(barge));
  const bad = normalizeRoutingLines({ routings: [{ name: "" }], legs: [
    { ...leg("NLRTM", "USNYC", { legType: "SEA" }), routingIndex: 0 },
    { ...leg("NLAMS", "NLRTM", { legType: "Pick-up", polLocType: "Door" }), routingIndex: 0 }] });
  assert("refused: the Pick-up leg comes first", bad.problems.length === 1 && bad.problems[0].line === 1 && bad.problems[0].messages[0] === "The Pick-up leg comes first, before the SEA legs.", JSON.stringify(bad.problems));
  assert("not cut into two lines", bad.routings.length === 1);
  assert("the refusal names the line, the problem and the order", /^Line 1: The Pick-up leg comes first, before the SEA legs\. The order on a contract line:/.test(lineProblemsError(bad.problems)), lineProblemsError(bad.problems));
  const two = normalizeRoutingLines({ routings: [{ name: "" }], legs: [
    { ...leg("NLAMS", "NLRTM", { legType: "Pick-up" }), routingIndex: 0 }, { ...leg("DEBER", "NLRTM", { legType: "Pick-up" }), routingIndex: 0 },
    { ...leg("NLRTM", "USNYC", { legType: "SEA" }), routingIndex: 0 }] });
  assert("refused: at most one Pick-up leg", JSON.stringify(two.problems[0] && two.problems[0].messages) === JSON.stringify(["A line has at most one Pick-up leg."]), JSON.stringify(two.problems));
}

console.log("\nA named routing that is already one line is left alone");
{
  const input = { routings: [{ id: "CRTG-A", name: "via BEANR", transitDays: 12 }], legs: [leg("NLRTM", "BEANR", { routingId: "CRTG-A" }), leg("BEANR", "USNYC", { routingId: "CRTG-A" })], rates: [rate("OF", 700, { routingId: "CRTG-A" }), rate("DOC", 40)] };
  const out = normalizeRoutingLines({ ...input, storedLegs: input.legs });
  assert("not changed", out.changed === false);
  assert("same id and name", out.routings.length === 1 && out.routings[0].id === "CRTG-A" && out.routings[0].name === "via BEANR");
  assert("its rate still points at it, the DOC rate stays contract-wide", out.rates[0].routingIndex === 0 && out.rates[1].routingIndex === -1);
}

console.log("\nA named routing holding two lanes is split; its own rates follow the split-off line");
{
  const out = normalizeRoutingLines({
    routings: [{ id: "CRTG-B", name: "Europe–US", transitDays: 20 }],
    legs: [leg("NLRTM", "USNYC", { routingIndex: 0 }), leg("DEHAM", "USBAL", { routingIndex: 0 })],
    rates: [rate("OF", 800, { routingIndex: 0 }), rate("DOC", 40)],
  });
  assert("two routings, the original keeps its id", out.routings.length === 2 && out.routings[0].id === "CRTG-B" && !out.routings[1].id);
  assert("second lane on the new routing", chainOf(out, 1) === "DEHAM>USBAL");
  assert("the routing's OF rate is on both lines", out.rates.filter(r => r.serviceCode === "OF").map(r => r.routingIndex).sort().join(",") === "0,1");
  assert("the DOC rate stays contract-wide, once", out.rates.filter(r => r.serviceCode === "DOC").length === 1);
}

console.log("\nLoose legs get their old routing back when the chain is unchanged (no id churn)");
{
  const stored = [leg("NLRTM", "BEANR", { routingId: "CRTG-C", legOrder: 0 }), leg("BEANR", "USNYC", { routingId: "CRTG-C", legOrder: 1 })];
  const out = normalizeRoutingLines({ routings: [{ id: "CRTG-C", name: "via BEANR" }], legs: [leg("NLRTM", "BEANR"), leg("BEANR", "USNYC")], rates: [], storedLegs: stored });
  assert("reuses CRTG-C", out.routings.length === 1 && out.routings[0].id === "CRTG-C", JSON.stringify(out.routings));
  const outNoPayloadRouting = normalizeRoutingLines({ routings: [], legs: [leg("NLRTM", "BEANR"), leg("BEANR", "USNYC")], rates: [], storedLegs: stored });
  assert("reuses CRTG-C even when the payload lists no routings", outNoPayloadRouting.routings[0]?.id === "CRTG-C");
  const changedChain = normalizeRoutingLines({ routings: [{ id: "CRTG-C", name: "via BEANR" }], legs: [leg("NLRTM", "USNYC")], rates: [], storedLegs: stored });
  assert("a different chain gets a new routing, and the old one (now empty) drops out", changedChain.routings.length === 1 && !changedChain.routings[0].id);
}

console.log("\nTwo lines describing the same routing are reported");
{
  const out = normalizeRoutingLines({
    routings: [{ id: "R1", name: "A" }, { id: "R2", name: "B" }],
    legs: [leg("NLRTM", "USNYC", { routingIndex: 0 }), leg("NLRTM", "USNYC", { routingIndex: 1 })],
  });
  assert("duplicate found", !!out.duplicate && out.duplicate.first === 0 && out.duplicate.second === 1, JSON.stringify(out.duplicate));
  const differentService = normalizeRoutingLines({
    routings: [{ id: "R1", name: "A" }, { id: "R2", name: "B" }],
    legs: [leg("NLRTM", "USNYC", { routingIndex: 0, vesselService: "AL1" }), leg("NLRTM", "USNYC", { routingIndex: 1, vesselService: "AL5" })],
  });
  assert("same ports on a different service code is a different line", differentService.duplicate === null);
}

console.log("\nA routing with no legs is dropped, together with its own rates");
{
  const out = normalizeRoutingLines({
    routings: [{ id: "R1", name: "kept" }, { id: "R2", name: "empty" }],
    legs: [leg("NLRTM", "USNYC", { routingIndex: 0 })],
    rates: [rate("OF", 500, { routingIndex: 0 }), rate("OF", 600, { routingIndex: 1 }), rate("DOC", 40)],
  });
  assert("only the routing with legs remains", out.routings.length === 1 && out.routings[0].id === "R1");
  assert("the empty routing's rate is gone (it no longer turns contract-wide)", out.rates.length === 2 && !out.rates.some(r => r.amount === 600));
}

console.log("\nRunning the result through again changes nothing");
{
  const first = normalizeRoutingLines({ legs: [leg("NLRTM", "USLAX"), leg("DEBRE", "USLAX"), leg("NLRTM", "USNYC", { polCarrierHaulage: true, polHaulageLocations: "DEBER NLAMS" })], rates: [rate("OF", 1)] });
  const again = normalizeRoutingLines({ routings: first.routings, legs: first.legs, rates: first.rates, storedLegs: [] });
  assert("idempotent", again.changed === false && again.routings.length === first.routings.length);
}

// TKT-1QBVF9 (TKT-SQVGJ2 audit): the Contract Management Service's startup migration owns no
// shipments, so it skips any contract whose normalization would drop a stored routing.
console.log("\nWhich stored routings a normalization would drop (the service migration's guard)");
{
  const routings = [{ id: "CRTG-KEEP", name: "Line 1" }, { id: "CRTG-EMPTY", name: "Line 2" }];
  const legs = [{ ...leg("NLRTM", "USNYC"), routingId: "CRTG-KEEP" }];
  const out = normalizeRoutingLines({ routings, legs, rates: [], storedLegs: legs });
  assert("a routing left with no legs is reported as dropped", JSON.stringify(droppedRoutingIds(routings, out.routings)) === JSON.stringify(["CRTG-EMPTY"]),
    JSON.stringify(droppedRoutingIds(routings, out.routings)));
  const split = normalizeRoutingLines({ routings: [{ id: "CRTG-A", name: "Two lanes" }],
    legs: [{ ...leg("NLRTM", "USLAX"), routingId: "CRTG-A" }, { ...leg("DEBRE", "USNYC"), routingId: "CRTG-A" }], rates: [] });
  assert("a split keeps the original routing's id — nothing dropped", droppedRoutingIds([{ id: "CRTG-A" }], split.routings).length === 0,
    JSON.stringify(split.routings));
}

console.log("\nThe Contract Management Service's copy behaves the same");
{
  const svc = require("../services/contract-management/lib/routingLines.js");
  const input = () => ({ routings: [{ id: "R1", name: "x" }, { id: "R2", name: "y" }],
    legs: [{ ...leg("NLRTM", "USLAX"), routingId: "R1" }, { ...leg("DEBRE", "USLAX"), routingId: "R1" }], rates: [rate("OF", 1, { routingId: "R1" })] });
  const a = normalizeRoutingLines(input()), b = svc.normalizeRoutingLines(input());
  assert("same normalization", JSON.stringify(a) === JSON.stringify(b));
  assert("same dropped ids", JSON.stringify(droppedRoutingIds(input().routings, a.routings)) === JSON.stringify(svc.droppedRoutingIds(input().routings, b.routings)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
