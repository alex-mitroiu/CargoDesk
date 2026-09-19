import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import useTableQuery from "./useTableQuery";

// useTableQuery is the shared filter/sort/search/page engine behind every Shipments-style table.
// These cover the parts that fail silently when they regress: which params actually go out, the
// "empty selection means show nothing" convention, page-1 resets, the debounce, and — the subtle
// one — a slow older response resolving AFTER a newer one and overwriting the current results.

const KEYS = ["status", "carrier"]; // module-level, like every real caller (must be a stable array)

// A fetch whose resolution the test controls, so overlapping requests can be ordered on purpose.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const page = (ids, total = ids.length) => ({ results: ids.map(id => ({ id })), total });

beforeEach(() => { localStorage.clear(); });

const setup = (fetchPage, extra = {}) =>
  renderHook(() => useTableQuery({ fetchPage, filterKeys: KEYS, ...extra }));

describe("useTableQuery — what it asks the server for", () => {
  it("loads page 1 on mount with no filters, and exposes the rows and total", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page(["A", "B"], 2));
    const { result } = setup(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    expect(result.current.rows.map(r => r.id)).toEqual(["A", "B"]);
    expect(result.current.total).toBe(2);
    expect(result.current.hasFilters).toBe(false);
    expect(result.current.canClear).toBe(false);
  });

  it("sends a column filter as an array, and only for columns that are actually filtered", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([]));
    const { result } = setup(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.setColumnFilter("status", ["Draft", "Sent"]); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0, status: ["Draft", "Sent"] });
    expect(result.current.hasFilters).toBe(true);
    expect(result.current.canClear).toBe(true);
  });

  it("passes an EMPTY selection through as [] — a deliberate 'show nothing', not the same as no filter", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([]));
    const { result } = setup(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.setColumnFilter("carrier", []); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0, carrier: [] });
    // ...and null clears it back to "no filter": the param disappears entirely.
    await act(async () => { result.current.setColumnFilter("carrier", null); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });
  });

  it("goes back to page 1 whenever a filter, sort or page size changes, but not when merely paging", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page(["A"], 500));
    const { result } = setup(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.goPage(100); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 100 });
    await act(async () => { result.current.setColumnFilter("status", ["Draft"]); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0, status: ["Draft"] });
    await act(async () => { result.current.goPage(50); });
    await act(async () => { result.current.setSort("total"); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0, status: ["Draft"], sort: "total" });
    await act(async () => { result.current.goPage(50); });
    await act(async () => { result.current.changeLimit(75); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 75, offset: 0, status: ["Draft"], sort: "total" });
  });

  it("Clear restores the untouched state (filters, search and sort) and fetches page 1", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([]));
    const { result } = setup(fetchPage, { initialSort: "newest" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.setColumnFilter("status", ["Draft"]); });
    await act(async () => { result.current.setSort("total"); });
    await act(async () => { result.current.clear(); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0, sort: "newest" });
    expect(result.current.canClear).toBe(false);
  });
});

describe("useTableQuery — scalar params (paramKeys)", () => {
  const PARAMS = ["asOf"];   // module-level, like every real caller
  const setupWithParams = fetchPage =>
    renderHook(() => useTableQuery({ fetchPage, filterKeys: KEYS, paramKeys: PARAMS }));

  it("sends a scalar param only once it has a value, as a plain string (not an array)", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([]));
    const { result } = setupWithParams(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });
    expect(result.current.filters.asOf).toBe("");

    await act(async () => { result.current.setParam("asOf", "2026-05-01"); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0, asOf: "2026-05-01" });

    await act(async () => { result.current.setParam("asOf", ""); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });   // unset again: param gone
  });

  it("counts as an active filter, goes back to page 1, and is cleared by clear()", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page(["A"], 500));
    const { result } = setupWithParams(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasFilters).toBe(false);
    expect(result.current.canClear).toBe(false);

    await act(async () => { result.current.goPage(100); });
    await act(async () => { result.current.setParam("asOf", "2026-05-01"); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0, asOf: "2026-05-01" });   // reset to page 1
    expect(result.current.hasFilters).toBe(true);
    expect(result.current.canClear).toBe(true);

    await act(async () => { result.current.clear(); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });
    expect(result.current.filters.asOf).toBe("");
    expect(result.current.hasFilters).toBe(false);
  });

  it("combines with column filters in one request", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([]));
    const { result } = setupWithParams(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.setColumnFilter("status", ["Active"]); });
    await act(async () => { result.current.setParam("asOf", "2026-05-01"); });
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0, status: ["Active"], asOf: "2026-05-01" });
  });

  it("leaves a hook that declares no paramKeys exactly as before", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([]));
    const { result } = setup(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(Object.keys(result.current.filters).sort()).toEqual(["carrier", "search", "status"]);
  });
});

describe("useTableQuery — search debounce", () => {
  it("updates the input immediately but only fetches once, after typing pauses", async () => {
    vi.useFakeTimers();
    try {
      const fetchPage = vi.fn().mockResolvedValue(page([]));
      const { result } = setup(fetchPage);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fetchPage).toHaveBeenCalledTimes(1); // the mount fetch

      act(() => { result.current.setSearch("a"); });
      act(() => { result.current.setSearch("ac"); });
      act(() => { result.current.setSearch("acm"); });
      expect(result.current.filters.search).toBe("acm");   // input reflects every keystroke at once
      expect(fetchPage).toHaveBeenCalledTimes(1);          // ...but nothing has been fetched yet

      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0, search: "acm" });
    } finally { vi.useRealTimers(); }
  });
});

describe("useTableQuery — out-of-order responses", () => {
  it("ignores a slow older response that resolves after a newer request", async () => {
    const first = deferred(), second = deferred(), third = deferred();
    const fetchPage = vi.fn()
      .mockReturnValueOnce(first.promise)    // mount
      .mockReturnValueOnce(second.promise)   // filter to Draft (slow)
      .mockReturnValueOnce(third.promise);   // filter to Sent (fast)
    const { result } = setup(fetchPage);
    first.resolve(page(["ALL"]));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.setColumnFilter("status", ["Draft"]); });
    act(() => { result.current.setColumnFilter("status", ["Sent"]); });
    await act(async () => { third.resolve(page(["SENT-ROW"])); });   // the newer request lands first
    await act(async () => { second.resolve(page(["STALE-DRAFT"])); }); // the older one lands last

    expect(result.current.rows.map(r => r.id)).toEqual(["SENT-ROW"]);
    expect(result.current.loading).toBe(false);
  });
});

describe("useTableQuery — filter option checklists and reload", () => {
  it("loads options once on mount, not on every filter change, and refreshes them on reload", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([]));
    const fetchOptions = vi.fn().mockResolvedValue({ status: ["Draft", "Sent"] });
    const { result } = setup(fetchPage, { fetchOptions });
    await waitFor(() => expect(result.current.options).toEqual({ status: ["Draft", "Sent"] }));
    expect(fetchOptions).toHaveBeenCalledTimes(1);

    await act(async () => { result.current.setColumnFilter("status", ["Draft"]); });
    expect(fetchOptions).toHaveBeenCalledTimes(1);   // checklists come from the whole set, not the filtered one

    await act(async () => { result.current.reload(); });   // after a create/edit/delete
    expect(fetchOptions).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, offset: 0, status: ["Draft"] }); // keeps the current filters
  });

  it("treats a failed page fetch as an empty table rather than leaving it stuck loading", async () => {
    const fetchPage = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = setup(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([]);
    expect(result.current.total).toBe(0);
  });
});
