import { diffDays } from "../tokens";

// Everything the Space Configurations table needs to know about a row, kept out of the component so
// it is testable without rendering and so the table's filters, sorts and search all read ONE
// definition of "what this row is". The table is the client-side tier (src/utils/localTableQuery.js):
// `allocations` is an App-level array that the bell, Landing, Dashboard and Archive also read, so the
// page filters its own prop rather than fetching a second copy from a table endpoint.
//
// The confirmed / pending / rejected / remaining figures are the SERVER's (routes/allocations.js
// loadTeuBuckets) and are carried through untouched — nothing here recomputes them. The one figure
// derived here is consumption (confirmed ÷ awarded), which is exactly the percentage the row already
// prints beneath the TEU bar.

// The row's Status wording. Ended configurations never reach this table (they live on the Archive
// page), so "Ending" is not reachable from here — kept only because the page always spelled the
// three-way split out, and a change to it belongs to whoever changes what "ended" means.
export const statusOf = (a, today, pct, thresh) => {
  const isActive = a.effectiveDate <= today && a.endDate >= today;
  const isFuture = a.effectiveDate > today;
  const label = isFuture ? "Future" : isActive ? "Active" : "Ending";
  return isActive && pct >= thresh ? (pct >= 100 ? "Over Limit" : "At Limit") : label;
};

/**
 * One view-model per ACTIVE-or-upcoming configuration (ended ones belong to the Archive page).
 * portInfo: { names: { UNLOCODE: "Rotterdam" }, lanes: { UNLOCODE: "EU-N" } } — port names and each
 * port's primary trade lane, looked up by the page. `lanes` is only ever consulted for a side the
 * configuration has no stored lane on; a stored lane always wins.
 */
export function buildSpaceRows({ allocations, carriers = [], portInfo = {}, today }) {
  const names = portInfo.names || {};
  const lanes = portInfo.lanes || {};
  const carrierName = code => carriers.find(c => c.code === code)?.name || "";
  const laneOf = (stored, port) => {
    if (stored) return { code: stored, derived: false };
    const d = port ? lanes[port] : null;
    return d ? { code: d, derived: true } : null;
  };
  return allocations.filter(a => a.endDate >= today).map(a => {
    const confirmed = a.confirmedTEU ?? 0;
    const pending   = a.pendingTEU ?? 0;
    const rejected  = a.rejectedTEU ?? 0;
    const remaining = a.remainingTEU ?? Math.max(0, a.allocatedTEU - confirmed);
    const pct       = a.allocatedTEU > 0 ? (confirmed / a.allocatedTEU) * 100 : 0;
    const thresh    = a.alertThreshold ?? 80;
    const alerting  = pct >= thresh;

    // Minimum Quantity Commitment: the floor, opposite of the ceiling the alert threshold guards.
    // Urgency scales with how much of the period has already elapsed — being under commitment on
    // day 2 of 90 is normal, on day 85 it is not.
    const belowMinimum = a.minimumTEU != null && confirmed < a.minimumTEU;
    const periodTotalDays = Math.max(1, diffDays(a.effectiveDate, a.endDate) + 1);
    const periodElapsedPct = Math.min(100, Math.max(0, (diffDays(a.effectiveDate, today) / periodTotalDays) * 100));

    return {
      id: a.id, a,
      carrierCode: a.carrierCode,
      carrierName: carrierName(a.carrierCode),
      pol: a.pol || "", pod: a.pod || "",
      polName: names[a.pol] || "", podName: names[a.pod] || "",
      route: a.pol && a.pod ? `${a.pol} › ${a.pod}` : "",
      origin: laneOf(a.originLane, a.pol),
      dest:   laneOf(a.destLane, a.pod),
      contract: a.contractNumber || "",
      notes: a.notes || "",
      allocated: a.allocatedTEU, confirmed, pending, rejected, remaining, pct, thresh,
      status: statusOf(a, today, pct, thresh),
      alertLevel: !alerting ? null : pct >= 100 ? "over" : "at",
      // The bar's colour: red once full, amber/red from the threshold (red when the threshold is 90+).
      barLevel: pct >= 100 ? "danger" : pct >= thresh ? (thresh >= 90 ? "danger" : "warning") : "success",
      belowMinimum,
      mqcUrgent: belowMinimum && periodElapsedPct >= 70,
    };
  });
}

// Column → the value the checklist offers and the filter matches. ONE definition feeds both, so a
// checklist can never offer a value the filter doesn't understand. Blanks are never offered (a
// configuration with no contract or no resolvable lane can't be picked from a list; it simply drops
// out once any value is ticked — the same rule every other shared table follows).
export const SPACE_COLUMNS = {
  carrier:  r => r.carrierCode,
  route:    r => r.route,
  origin:   r => r.origin?.code,
  dest:     r => r.dest?.code,
  contract: r => r.contract,
  status:   r => r.status,
};
export const SPACE_FILTER_KEYS = ["carrier", "route", "origin", "dest", "contract", "status"];

// Ties keep the incoming order (Array.prototype.sort is stable and a 0 comparator leaves them alone),
// so equal-TEU or equal-consumption rows never shuffle between clicks.
const numeric = (get, dir) => (a, b) => dir * (get(a) - get(b));
export const SPACE_SORTERS = {
  awarded_desc:     numeric(r => r.allocated, -1),
  awarded_asc:      numeric(r => r.allocated,  1),
  consumption_desc: numeric(r => r.pct, -1),
  consumption_asc:  numeric(r => r.pct,  1),
};

// The Confirmed header's sort-only control. `marker` is the small tag shown beside the heading while a
// sort is on, because the heading says "Confirmed" but the sort may be by awarded TEU.
export const SPACE_SORT_OPTIONS = [
  { value: "awarded_desc",     group: "Awarded TEU",                       label: "High to low", arrow: "↓", marker: "TEU" },
  { value: "awarded_asc",      group: "Awarded TEU",                       label: "Low to high", arrow: "↑", marker: "TEU" },
  { value: "consumption_desc", group: "Consumption (confirmed ÷ awarded)", label: "High to low", arrow: "↓", marker: "%" },
  { value: "consumption_asc",  group: "Consumption (confirmed ÷ awarded)", label: "Low to high", arrow: "↑", marker: "%" },
];

// Free-text search: whatever a person can read in the row.
export const spaceSearchText = r =>
  [r.carrierCode, r.carrierName, r.pol, r.pod, r.polName, r.podName, r.route, r.contract, r.notes].join(" ");

export const SPACE_SPEC = { columns: SPACE_COLUMNS, searchText: spaceSearchText, sorters: SPACE_SORTERS };

// Which sides of which allocations still need a lane looked up, and which ports need a name — so the
// page fetches only what the table will actually show, and never a lane for a side that stores one.
export function portLookupsNeeded(allocations, today) {
  const names = new Set(), lanes = new Set();
  for (const a of allocations) {
    if (a.endDate < today) continue;
    if (a.pol) { names.add(a.pol); if (!a.originLane) lanes.add(a.pol); }
    if (a.pod) { names.add(a.pod); if (!a.destLane)   lanes.add(a.pod); }
  }
  return { names: [...names], lanes: [...lanes] };
}
