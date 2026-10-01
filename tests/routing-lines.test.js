/**
 * Contract routing lines — unit tests for lib/routingLines.js (no server needed)
 *
 * Usage:
 *   node tests/routing-lines.test.js
 *
 * normalizeRoutingLines turns any contract payload into "one routing per line": loose legs become
 * routings, a routing that isn't one connected chain is split, a leg listing several pick-up or
 * delivery places becomes one line per combination, and two lines describing the same routing are
 * reported. The shapes below are the real ones found in the data on 2026-09-30 (53-2240's three
 * side-by-side lanes, CMDU-CH-EUN-NAM's "DEBER NLAMS" / "USLAX USCHI" door-to-door leg).
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { normalizeRoutingLines } = require("../lib/routingLines.js");

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

console.log("\nSeveral pick-ups / deliveries on one leg (CMDU-CH-EUN-NAM) become one line per combination");
{
  const out = normalizeRoutingLines({ legs: [leg("NLRTM", "USNYC", { polLocType: "Door", podLocType: "Door", polCarrierHaulage: true, podCarrierHaulage: true, polHaulageLocations: "DEBER NLAMS", podHaulageLocations: "USLAX USCHI" })] });
  assert("four lines", out.routings.length === 4, JSON.stringify(out.routings.map(r => r.name)));
  const combos = out.legs.map(l => `${l.polHaulageLocations}/${l.podHaulageLocations}`).sort().join(",");
  assert("every combination exactly once, one location each", combos === "DEBER/USCHI,DEBER/USLAX,NLAMS/USCHI,NLAMS/USLAX", combos);
  assert("names say which pick-up and delivery", out.routings.some(r => r.name === "NLRTM → USNYC (pick-up DEBER, delivery USLAX)"), JSON.stringify(out.routings.map(r => r.name)));
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
