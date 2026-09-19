// Client-side twin of lib/tableQuery.js, for the SMALL, bounded lists where the server hands over the
// whole set in one response and filtering it in the browser is the right tool (the Credit Overrides
// queue: only shipments currently blocked by a credit hold or an over-limit customer, unpaginated, and
// produced by an expensive per-request computation that would otherwise run twice per refresh — once for
// the rows and once for the checklist options). Big or growing lists stay server-driven: see
// lib/tableQuery.js and ARCHITECTURE.md §8.23.
//
// These are deliberately the SAME semantics as the server module, in the same order — the two must
// never drift, so src/utils/localTableQuery.test.js runs every case through both implementations and
// requires identical results. Change one, change the other, and that test says so if you forget.
//
// It plugs into useTableQuery unchanged: `params` is exactly what the hook would send over the wire
// ({ limit, offset, search?, sort?, [columnKey]: string[] }), and the return value is the same
// { results, total, limit, offset } a table endpoint would answer with.

// undefined → no filter on this column.  []  → an EMPTY selection, which means "show nothing" and must
// match no row rather than being ignored as "no filter".
// The ONE intended difference from the server module: `null` also means "no filter" here. A query string
// can never carry null, but client code can pass one (ColumnFilter's own "no filter" value), and on the
// server's rules it would become the literal value "null". The parity test pins this difference.
const filterValues = raw => {
  if (raw === undefined || raw === null) return null;
  return [].concat(raw).map(String).filter(v => v !== "");
};

/**
 * columns: { paramName: row => value } — one definition shared with filterOptions().
 * A getter may return an ARRAY for a cell that holds several values: the row matches when ANY is selected.
 */
export function applyColumnFilters(rows, query, columns) {
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
 * Distinct, sorted, non-empty values per column — the checklist source for each header's filter. Built
 * from the WHOLE row set, never the currently-filtered subset, so a value just unchecked stays selectable.
 */
export function filterOptions(rows, columns, { maxOptions = 2000 } = {}) {
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

/** Case-insensitive substring match against whatever text the caller says a row is searchable by. */
export function applySearch(rows, term, textOf) {
  const q = String(term || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(r => textOf(r).toLowerCase().includes(q));
}

/** Comparator factory: ascending (or `{ desc: true }`) on get(row), blanks always LAST in both directions. */
export const blanksLast = (get, { desc = false } = {}) => (a, b) => {
  const x = get(a), y = get(b);
  if (!x && !y) return 0; if (!x) return 1; if (!y) return -1;
  const c = String(x).localeCompare(String(y));
  return desc ? -c : c;
};

/** sorters: { sortKey: (a, b) => number }. An unknown/absent key leaves the incoming order alone. */
export function applySort(rows, sortKey, sorters) {
  const cmp = sorters[sortKey];
  return cmp ? [...rows].sort(cmp) : rows;
}

export function paginate(rows, { limit, offset } = {}, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const lim = Math.min(parseInt(limit) || defaultLimit, maxLimit);
  const off = Math.max(parseInt(offset) || 0, 0);
  return { results: rows.slice(off, off + lim), total: rows.length, limit: lim, offset: off };
}

/**
 * The whole pipeline in the order every table route uses it: column filters → search → sort → page.
 * spec: { columns, searchText?, sorters? }
 */
export function queryRows(rows, params = {}, { columns = {}, searchText, sorters = {} } = {}) {
  let out = applyColumnFilters(rows, params, columns);
  if (searchText) out = applySearch(out, params.search, searchText);
  out = applySort(out, params.sort, sorters);
  return paginate(out, params);
}
