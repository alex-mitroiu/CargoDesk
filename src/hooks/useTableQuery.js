import { useState, useRef, useEffect, useCallback } from "react";
import { getStoredPageSize } from "../components/primitives/PageSizeSelect";

// Server-driven table state — the filter/sort/search/page logic ShipmentsPage.jsx pioneered,
// extracted so every table page gets the same behavior instead of its own copy. Pair with
// <DataTable> (rendering) and lib/tableQuery.js (the matching server-side helpers).
//
//   const t = useTableQuery({
//     fetchPage:    params => api.quotes.list(params),   // -> { results, total }
//     fetchOptions: () => api.quotes.filterOptions(),    // -> { [filterKey]: string[] }  (optional)
//     filterKeys:   QUOTE_FILTER_KEYS,                    // MUST be a stable (module-level) array
//     initialSort:  "",
//   });
//
// `filters` holds one entry per filterKey — ColumnFilter's own convention: null = no filter, an
// array = the chosen subset, and an EMPTY array is a deliberate "show nothing" (not the same as
// null). Every change resets to page 1 (a new filter/sort shape can shrink the result set below
// whatever page was showing); only goPage keeps the current filters. Search alone is debounced so
// typing doesn't fire a request per keystroke.
//
// The query lives in a ref as well as in state: handlers build the next query from the ref and
// pass it explicitly to the fetch, so a fetch never reads a stale closure or races a state update
// that hasn't landed yet. Only the response to the most recently *issued* request is applied
// (StrictMode's dev-only double mount and two quick filter clicks both fire overlapping requests;
// a slower, older one resolving last would otherwise overwrite the current results with stale
// ones).
export default function useTableQuery({ fetchPage, fetchOptions, filterKeys, initialSort = "", searchDelay = 300 }) {
  const blankFilters = () => ({ search: "", ...Object.fromEntries(filterKeys.map(k => [k, null])) });

  const [query, setQuery] = useState(() => ({ filters: blankFilters(), sort: initialSort, offset: 0, limit: getStoredPageSize() }));
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [options, setOptions] = useState({});

  const queryRef = useRef(query);
  const seqRef = useRef(0);
  const timerRef = useRef(null);
  // Latest callbacks without making run()/loadOptions() change identity every render.
  const fetchPageRef = useRef(fetchPage);       fetchPageRef.current = fetchPage;
  const fetchOptionsRef = useRef(fetchOptions); fetchOptionsRef.current = fetchOptions;

  const run = useCallback(async q => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const params = { limit: q.limit, offset: q.offset };
      filterKeys.forEach(k => { if (Array.isArray(q.filters[k])) params[k] = q.filters[k]; });
      if (q.filters.search) params.search = q.filters.search;
      if (q.sort) params.sort = q.sort;
      const r = await fetchPageRef.current(params);
      if (seq !== seqRef.current) return;
      setRows(r.results || []);
      setTotal(r.total ?? 0);
    } catch {
      if (seq !== seqRef.current) return;
      setRows([]); setTotal(0);
    }
    if (seq === seqRef.current) setLoading(false);
  }, [filterKeys]);

  const loadOptions = useCallback(() => {
    fetchOptionsRef.current?.().then(o => setOptions(o || {})).catch(() => {});
  }, []);

  const apply = patch => {
    const next = { ...queryRef.current, ...patch };
    queryRef.current = next;
    setQuery(next);
    return next;
  };
  // Any change other than paging: back to page 1, fetch now (cancelling a pending debounced search
  // fetch — this fetch already carries the latest search text).
  const change = patch => {
    clearTimeout(timerRef.current);
    run(apply({ offset: 0, ...patch }));
  };

  useEffect(() => {
    run(queryRef.current);
    loadOptions();
    return () => clearTimeout(timerRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setSearch = v => {
    apply({ filters: { ...queryRef.current.filters, search: v }, offset: 0 });
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => run(queryRef.current), searchDelay);
  };

  const { filters } = query;
  const hasFilters = !!(filters.search || filterKeys.some(k => filters[k] != null));

  return {
    rows, total, loading, options,
    filters, sort: query.sort, offset: query.offset, limit: query.limit,
    hasFilters,
    // Clear is offered when anything differs from the untouched state, sort included.
    canClear: hasFilters || query.sort !== initialSort,
    setSearch,
    setColumnFilter: (key, value) => change({ filters: { ...queryRef.current.filters, [key]: value } }),
    setSort: sort => change({ sort }),
    clear: () => change({ filters: blankFilters(), sort: initialSort }),
    goPage: offset => run(apply({ offset })),
    changeLimit: limit => change({ limit }),
    // After a create/edit/delete: refetch the current page and (by default) the checklists, since
    // a new record can add a value the checklists have never seen. Filter changes skip the
    // options refetch — the checklists come from the whole visible set, not the filtered one.
    reload: ({ refreshOptions = true } = {}) => { run(queryRef.current); if (refreshOptions) loadOptions(); },
  };
}
