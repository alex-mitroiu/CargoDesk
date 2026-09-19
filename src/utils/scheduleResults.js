// Pure helpers behind the Schedule Search results table (src/pages/SchedulesPage.jsx). Schedule Search is a
// search tool — its form is its filter — so the results are fetched once (up to RESULT_CAP contracts) and the
// column filters / sort / paging run in the BROWSER over that set, through localTableQuery.js. These live in
// their own module so the parts with real logic (what a column filters on, how "cheapest" sorts, what counts
// as the best rate, how contracts group) can be unit-tested without rendering the page.
import { blanksLast } from "./localTableQuery";

// The server's page cap for GET /api/contracts. A search needs POL, POD and a valid-as-of date, so it is
// narrow by construction; if it ever returns more than this the page says so rather than silently truncating.
export const RESULT_CAP = 200;

export const SCHEDULE_FILTER_KEYS = ["contractNumber", "carrier", "namedAccount", "route", "status"];

// Column → what the table shows and filters on. `route` is multi-valued: every leg's "POL › POD", the same
// labels the row's leg pills show, so a contract matches when ANY of its legs is selected.
export const SCHEDULE_COLUMNS = {
  contractNumber: c => c.contractNumber,
  carrier:        c => c.carrierCode,
  namedAccount:   c => c.namedAccount,
  route:          c => (c.legs || []).filter(l => l.pol && l.pod).map(l => `${l.pol} › ${l.pod}`),
  status:         c => c.status,
};

// rateTotalOf(contract) → the contract's Buy Rate total for the containers chosen in the search form, or 0
// when there is none. The default order (no sort key) is the server's own: newest validity start first.
export const buildScheduleSorters = rateTotalOf => ({
  validTo:        blanksLast(c => c.validTo, { desc: true }),
  contractNumber: blanksLast(c => c.contractNumber),
  carrier:        blanksLast(c => c.carrierCode),
  // Cheapest first; a contract with no rate for these containers has nothing to compare, so it goes last.
  rate: (a, b) => {
    const x = rateTotalOf(a), y = rateTotalOf(b);
    if (!x && !y) return 0; if (!x) return 1; if (!y) return -1;
    return x - y;
  },
});

export const scheduleSortOptions = showRate => [
  { value: "",               label: "Newest first" },
  { value: "validTo",        label: "Latest expiry" },
  { value: "contractNumber", label: "Contract # A–Z" },
  { value: "carrier",        label: "Carrier A–Z" },
  ...(showRate ? [{ value: "rate", label: "Cheapest first" }] : []),
];

/** The lowest positive rate total among `rows`, or 0 when none has one. */
export function bestRate(rows, rateTotalOf) {
  const totals = rows.map(rateTotalOf).filter(v => v > 0);
  return totals.length > 0 ? Math.min(...totals) : 0;
}

/**
 * Group rows that share a contract number under one header, in order of first appearance. A contract with no
 * number can never share, so it gets its own group keyed by id.
 */
export function groupByContract(rows) {
  const groups = [], map = {};
  (rows || []).forEach(c => {
    const key = c.contractNumber || `_${c.id}`;
    if (!map[key]) { map[key] = { key, contracts: [] }; groups.push(map[key]); }
    map[key].contracts.push(c);
  });
  return groups;
}
