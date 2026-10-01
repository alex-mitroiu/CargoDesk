// Space configuration rules, client side (approved form mockup:
// https://claude.ai/artifact/MDkX8f7EEG3TNVquYeor3h). The server enforces the same rules in
// routes/allocations.js resolveConfig; these let the form show them while you fill it in.
//
// A configuration belongs to one contract record and ticks one or more of its routing lines,
// which share its TEU. When the ticked lines carry loop codes it names one loop and every ticked
// line with loops must sail on it; a line with no loop code goes with any loop. Two
// configurations clash only when they share a routing LINE with the same loop, customer and
// commodity in overlapping periods (the rule the user set on 2026-09-30).

import { lineChain, chainLabel } from "./routingLines";

export const FAK_CODE = "9999";
export const MAX_PERIOD_DAYS = 90;

const up = s => String(s || "").trim().toUpperCase();

export function contractLines(contract) {
  if (!contract) return [];
  const legs = contract.legs || [];
  return (contract.routings || []).map(r => {
    const own = legs.filter(l => l.routingId === r.id).sort((a, b) => (a.legOrder ?? 0) - (b.legOrder ?? 0));
    const chain = lineChain(own);
    return {
      id: r.id, name: r.name || "", legs: own, chain,
      label: chainLabel(chain) || r.name || r.id,
      loops: [...new Set(own.map(l => up(l.vesselService)).filter(Boolean))],
    };
  });
}

export const loopsOf = lines => [...new Set(lines.flatMap(l => l.loops))];
export const lineOnLoop = (line, loop) => !loop || !line.loops.length || line.loops.includes(up(loop));

export function commodityCodesOf(contract) {
  const codes = String(contract?.commodityTypes || "").split(/[\s,]+/).filter(Boolean);
  return codes.length ? codes : [FAK_CODE];
}

export const periodsOverlap = (aFrom, aTo, bFrom, bTo) => !!(aFrom && aTo && bFrom && bTo && aFrom <= bTo && bFrom <= aTo);

// Every other configuration of this contract whose period overlaps [from, to].
export const overlappingConfigs = (configs, { contractId, from, to, excludeId }) =>
  configs.filter(c => c.contractId === contractId && c.id !== excludeId && periodsOverlap(c.effectiveDate, c.endDate, from, to));

// The ticked lines that already have space in an overlapping configuration with the same loop,
// customer and commodity: [{ routingId, config }].
export function findClashes(configs, { contractId, routingIds, loopCode = "", customerId = "", commodityCode = "", from, to, excludeId }) {
  const out = [];
  for (const c of overlappingConfigs(configs, { contractId, from, to, excludeId })) {
    if ((c.loopCode || "") !== up(loopCode) || (c.customerId || "") !== (customerId || "") || (c.commodityCode || "") !== (commodityCode || "")) continue;
    for (const rid of c.routingIds || []) if (routingIds.includes(rid)) out.push({ routingId: rid, config: c });
  }
  return out;
}

const DAY = 86400000;
const t = s => new Date(`${s}T00:00:00Z`).getTime();
export const periodDays = (from, to) => (from && to ? Math.round((t(to) - t(from)) / DAY) + 1 : 0);

export function periodProblems({ from, to, validFrom, validTo }) {
  const out = [];
  if (!from || !to) return out;
  if (to < from) out.push("The end date is before the start date.");
  if ((validFrom && from < validFrom) || (validTo && to > validTo)) out.push(`The period must sit inside the contract's validity (${validFrom || "…"} – ${validTo || "…"}).`);
  if (periodDays(from, to) > MAX_PERIOD_DAYS) out.push(`A configuration covers at most ${MAX_PERIOD_DAYS} days — split the period.`);
  return out;
}

// The calendar month after the last configuration that clashes on any ticked line (same loop,
// customer and commodity), clipped to the contract's validity — "use the next free period".
export function nextFreePeriod(configs, { contractId, routingIds, loopCode, customerId, commodityCode, excludeId, validFrom, validTo }) {
  const same = configs.filter(c => c.contractId === contractId && c.id !== excludeId
    && (c.loopCode || "") === up(loopCode) && (c.customerId || "") === (customerId || "") && (c.commodityCode || "") === (commodityCode || "")
    && (c.routingIds || []).some(r => routingIds.includes(r)));
  const lastEnd = same.map(c => c.endDate).sort().pop();
  const start = new Date(lastEnd ? t(lastEnd) + DAY : (validFrom ? t(validFrom) : Date.now()));
  const monthEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  const iso = d => d.toISOString().slice(0, 10);
  const from = iso(start), to = validTo && iso(monthEnd) > validTo ? validTo : iso(monthEnd);
  return from <= to ? { from, to } : null;
}
