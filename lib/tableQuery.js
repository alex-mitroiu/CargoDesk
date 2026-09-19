"use strict";

// Shared list-endpoint primitives for the Shipments-style data tables (multi-value column
// filters, free-text search, sorting, paging, and the per-column "filter options" checklist
// source). Extracted from what routes/shipments.js does inline so every table page gets identical
// semantics instead of a fresh copy that drifts. Everything here works on rows that are ALREADY
// mapped and ALREADY access-filtered (applyOfficeScopedAccessFilter / applyShipmentAccessFilter) —
// filterOptions() in particular must only ever see rows the caller may see, or a checklist would
// leak values from another office's records.
//
// Wire format differs from routes/shipments.js's multiFilter() on purpose: a column filter arrives
// as a REPEATED query param (?status=Draft&status=Sent), not a comma-joined string. Shipments'
// columns are codes and ids, which never contain a comma; a table of customer names does
// ("Smith & Sons, Ltd."), and splitting that on "," would silently turn one value into two that
// match nothing. A single value (?status=Draft) still works, so a caller that predates multi-select
// keeps working unchanged.

// null  → param absent, no filter on this column.
// []    → param present but empty (?status=) — the frontend's ColumnFilter uses an empty selection
//         to mean "show nothing", which must match no row rather than being ignored as "no filter".
const filterValues = raw => {
  if (raw === undefined) return null;
  return [].concat(raw).map(String).filter(v => v !== "");
};

/**
 * columns: { paramName: row => value } — one definition shared with filterOptions().
 * A getter may return an ARRAY for a column whose cell holds several values (a contract's container
 * types, or the route of each of its legs): the row then matches when ANY of them is selected, and
 * filterOptions() lists each one separately. A row with no values at all matches no selection.
 */
function applyColumnFilters(rows, query, columns) {
  let out = rows;
  for (const [key, get] of Object.entries(columns)) {
    const values = filterValues(query[key]);
    if (values === null) continue;
    out = out.filter(r => {
      const v = get(r);
      return (Array.isArray(v) ? v : [v]).some(x => values.includes(String(x ?? "")));
    });
  }
  return out;
}

/**
 * Distinct, sorted, non-empty values per column — the checklist source for each header's filter.
 * Built from the caller's whole visible row set, never the currently-filtered subset, so a value
 * the user just unchecked stays selectable instead of vanishing from its own list. A column with
 * more than maxOptions distinct values is cut off and named in `truncated` (a table of ids can
 * be unbounded; the popover has a search box, but an unbounded payload is not worth it).
 */
function filterOptions(rows, columns, { maxOptions = 2000 } = {}) {
  const options = {}, truncated = {};
  for (const [key, get] of Object.entries(columns)) {
    const distinct = [...new Set(
      rows.flatMap(r => { const v = get(r); return Array.isArray(v) ? v : [v]; })
        .filter(v => v !== null && v !== undefined && v !== "").map(String)
    )].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    options[key] = distinct.slice(0, maxOptions);
    if (distinct.length > maxOptions) truncated[key] = true;
  }
  return { ...options, truncated };
}

/** Case-insensitive substring match against whatever text the route says a row is searchable by. */
function applySearch(rows, term, textOf) {
  const q = String(term || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(r => textOf(r).toLowerCase().includes(q));
}

/**
 * Comparator factory for a sorter: ascending on get(row) — or descending with { desc: true } — with
 * blanks always LAST in BOTH directions: a row with no date or name yet isn't "earliest" or "A", nor
 * "newest", just because "" compares low.
 */
const blanksLast = (get, { desc = false } = {}) => (a, b) => {
  const x = get(a), y = get(b);
  if (!x && !y) return 0; if (!x) return 1; if (!y) return -1;
  const c = String(x).localeCompare(String(y));
  return desc ? -c : c;
};

/** sorters: { sortKey: (a, b) => number }. An unknown/absent key leaves the route's own order alone. */
function applySort(rows, sortKey, sorters) {
  const cmp = sorters[sortKey];
  return cmp ? [...rows].sort(cmp) : rows;
}

function paginate(rows, { limit, offset } = {}, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const lim = Math.min(parseInt(limit) || defaultLimit, maxLimit);
  const off = Math.max(parseInt(offset) || 0, 0);
  return { results: rows.slice(off, off + lim), total: rows.length, limit: lim, offset: off };
}

module.exports = { applyColumnFilters, filterOptions, applySearch, applySort, paginate, blanksLast };
