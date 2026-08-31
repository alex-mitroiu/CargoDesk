// Derives a schedule's own "Loop" (vessel service) code — a direct/single-leg sailing's loop is
// just its one leg's service, but a real multi-leg TSP sailing can have a different loop per leg
// (each segment is commonly its own vessel service). Direct request: when legs disagree, the loop
// covering the LONGEST transit-time leg wins (that's the leg actually defining the sailing's own
// character); when every leg that names one agrees, use that shared value.
function transitDays(leg) {
  if (!leg.etd || !leg.eta) return 0;
  const days = (new Date(leg.eta) - new Date(leg.etd)) / 86400000;
  return Number.isFinite(days) ? days : 0;
}

export function deriveLoopCode(schedule) {
  if (!schedule) return "";
  const legs = schedule.legs;
  if (!Array.isArray(legs) || legs.length < 2) return schedule.service || "";

  const named = legs.filter(l => l.service);
  if (named.length === 0) return "";
  const distinct = new Set(named.map(l => l.service));
  if (distinct.size === 1) return named[0].service;

  return named.reduce((longest, l) => transitDays(l) > transitDays(longest) ? l : longest).service;
}
