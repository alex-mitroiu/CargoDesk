// The main vessel (agreed with the user 2026-10-21): of a sailing's or a shipment's sea legs, the one
// with the longest transit — the ocean crossing, as opposed to the feeders before and after it. On a
// tie, the earlier leg. A leg without both dates counts as 0 days, so dates decide whenever any leg
// has them; with none, it's the first leg. The same rule is in lib/mainLeg.js: change both.

const day = v => {
  const s = String(v || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
};

// A leg's transit in whole days ({ etd, eta }), 0 when either date is missing or out of order.
export function legDays(leg) {
  const a = day(leg?.etd), b = day(leg?.eta);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 864e5) : 0;
}

// → the index of the main leg in `legs`, or -1 for none.
export function mainLegIndex(legs) {
  let best = -1, bestDays = -1;
  (Array.isArray(legs) ? legs : []).forEach((leg, i) => {
    const d = legDays(leg);
    if (d > bestDays) { best = i; bestDays = d; }
  });
  return best;
}

// A sailing's legs in order, each with its role: "MAIN" for the main leg, "FEEDER" for the others.
// [] for a direct sailing. Prefers the server's own mainLegIndex (routes/system.js) when it sent one.
export function legRoles(sailing) {
  const legs = Array.isArray(sailing?.legs) && sailing.legs.length > 1 ? sailing.legs : [];
  if (!legs.length) return [];
  const main = Number.isInteger(sailing.mainLegIndex) && sailing.mainLegIndex >= 0 ? sailing.mainLegIndex : mainLegIndex(legs);
  return legs.map((leg, i) => ({ ...leg, role: i === main ? "MAIN" : "FEEDER", days: legDays(leg) }));
}
