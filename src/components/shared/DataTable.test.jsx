import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import DataTable, { TableToolbar } from "./DataTable";

// DataTable is presentational — it renders whatever rows/filters it's given and reports user
// intent through callbacks; useTableQuery owns the state. So these tests drive it with plain props
// and assert on what the user would see and what it calls back with.

const COLUMNS = [
  { key: "id",     header: "Quote",  width: 120, filter: true, render: r => <span>{r.id}</span> },
  { key: "amount", header: "Total",  width: 100, align: "right", render: r => <span>{r.amount}</span> },
  { key: "status", header: "Status", width: 100, align: "center", filter: true, render: r => <span>{r.status}</span> },
];
const ROWS = [
  { id: "Q-1", amount: "$10", status: "Draft" },
  { id: "Q-2", amount: "$20", status: "Sent" },
];

const renderTable = (props = {}) => render(
  <DataTable
    tableId="t" columns={COLUMNS} rows={ROWS} loading={false} rowKey={r => r.id}
    filters={{ id: null, status: null }} filterOptions={{ id: ["Q-1", "Q-2"], status: ["Draft", "Sent"] }}
    onFilterChange={() => {}}
    {...props}
  />
);

beforeEach(() => { localStorage.clear(); });

describe("DataTable — rendering", () => {
  it("renders every column header and one row per record, each cell through its column's render()", () => {
    renderTable();
    for (const h of ["Quote", "Total", "Status"]) expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    expect(screen.getByTestId("t-row-Q-1")).toHaveTextContent("Q-1");
    expect(screen.getByTestId("t-row-Q-1")).toHaveTextContent("$10");
    expect(screen.getByTestId("t-row-Q-2")).toHaveTextContent("Sent");
  });

  it("gives filterable columns a filter button and leaves the others as plain labels", () => {
    renderTable();
    expect(within(screen.getByTestId("t-col-id")).getByRole("button")).toBeInTheDocument();
    expect(within(screen.getByTestId("t-col-status")).getByRole("button")).toBeInTheDocument();
    expect(within(screen.getByTestId("t-col-amount")).queryByRole("button")).toBeNull();
  });

  it("shows the loading spinner instead of rows while loading", () => {
    renderTable({ loading: true });
    expect(screen.queryByTestId("t-row-Q-1")).toBeNull();
    expect(screen.queryByTestId("t-empty")).toBeNull();
  });

  it("shows the plain empty message with no rows and no filters", () => {
    renderTable({ rows: [], hasFilters: false, emptyMessage: "No quotes yet." });
    expect(screen.getByTestId("t-empty")).toHaveTextContent("No quotes yet.");
  });

  it("shows the 'no match' message instead when filters are active", () => {
    renderTable({ rows: [], hasFilters: true, emptyMessage: "No quotes yet.", emptyFilteredMessage: "No quotes match your filters." });
    expect(screen.getByTestId("t-empty")).toHaveTextContent("No quotes match your filters.");
  });
});

describe("DataTable — interaction", () => {
  it("reports a row click with the row, and stays inert when no handler is given", () => {
    const onRowClick = vi.fn();
    const { unmount } = renderTable({ onRowClick });
    fireEvent.click(screen.getByTestId("t-row-Q-2"));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1]);
    unmount();

    renderTable();   // no handlers: clicking must not throw
    fireEvent.click(screen.getByTestId("t-row-Q-2"));
  });

  it("adds an Actions column when rowActions is given, and clicking it does not trigger the row click", () => {
    const onRowClick = vi.fn();
    const onOpen = vi.fn();
    renderTable({ onRowClick, rowActions: () => [{ label: "Open", onClick: onOpen }] });
    expect(screen.getByText("Actions")).toBeInTheDocument();
    const row = screen.getByTestId("t-row-Q-1");
    fireEvent.click(within(row).getByRole("button"));           // opens the ActionMenu
    expect(onRowClick).not.toHaveBeenCalled();                  // the row's own click was stopped
  });

  it("filters through the column's checklist: picking a value calls onFilterChange(key, [value])", () => {
    const onFilterChange = vi.fn();
    renderTable({ onFilterChange, filters: { id: null, status: [] }, });
    // With `status` currently "show nothing" ([]), ticking Draft yields exactly [Draft].
    fireEvent.click(within(screen.getByTestId("t-col-status")).getByRole("button"));
    fireEvent.click(screen.getByLabelText("Draft"));
    expect(onFilterChange).toHaveBeenCalledWith("status", ["Draft"]);
  });

  it("uses column.filter as the checklist key when it differs from the column's own key", () => {
    const onFilterChange = vi.fn();
    const cols = [{ key: "route", header: "Route", width: 120, filter: "routeKey", render: r => r.id }];
    // Two options: ticking the only option of a one-option list means "everything selected", which
    // ColumnFilter deliberately reports as null (no filter) rather than a one-element array.
    renderTable({ columns: cols, filters: { routeKey: [] }, filterOptions: { routeKey: ["NLRTM→USNYC", "CNSHA→USLAX"] }, onFilterChange });
    fireEvent.click(within(screen.getByTestId("t-col-route")).getByRole("button"));
    fireEvent.click(screen.getByLabelText("NLRTM→USNYC"));
    expect(onFilterChange).toHaveBeenCalledWith("routeKey", ["NLRTM→USNYC"]);
  });
});

describe("DataTable — footer", () => {
  it("shows page size and pager only once there are results to page", () => {
    const { rerender } = renderTable({ pagination: { total: 0, offset: 0, limit: 50, onPage: () => {}, onLimit: () => {} } });
    expect(screen.queryByText(/Rows per page/)).toBeNull();

    rerender(
      <DataTable tableId="t" columns={COLUMNS} rows={ROWS} loading={false} rowKey={r => r.id}
        filters={{}} onFilterChange={() => {}}
        pagination={{ total: 120, offset: 0, limit: 50, onPage: () => {}, onLimit: () => {} }} />
    );
    expect(screen.getByText(/Rows per page/)).toBeInTheDocument();
    expect(screen.getByText(/Next/)).toBeInTheDocument();
  });

  it("pages forward through onPage with the next offset", () => {
    const onPage = vi.fn();
    renderTable({ pagination: { total: 120, offset: 0, limit: 50, onPage, onLimit: () => {} } });
    fireEvent.click(screen.getByText(/Next/));
    expect(onPage).toHaveBeenCalledWith(50);
  });
});

describe("TableToolbar", () => {
  const toolbar = (props = {}) => render(
    <TableToolbar tableId="t" search="" onSearch={() => {}} sort="" onSort={() => {}} canClear={false} onClear={() => {}} {...props} />
  );

  it("passes typed search text to onSearch", () => {
    const onSearch = vi.fn();
    toolbar({ onSearch, searchPlaceholder: "Search quotes…" });
    fireEvent.change(screen.getByPlaceholderText("Search quotes…"), { target: { value: "acme" } });
    expect(onSearch).toHaveBeenCalledWith("acme");
  });

  it("omits the search box when no onSearch is given (a page whose own form is the search)", () => {
    toolbar({ onSearch: undefined, sortOptions: [{ value: "", label: "Newest first" }], canClear: true });
    expect(screen.queryByTestId("t-search")).toBeNull();
    expect(screen.getByTestId("t-sort")).toBeInTheDocument();      // the rest of the bar is unaffected
    expect(screen.getByTestId("t-clear")).toBeInTheDocument();
  });

  it("renders the sort dropdown only when sortOptions are given, and reports the choice", () => {
    const onSort = vi.fn();
    const { unmount } = toolbar();
    expect(screen.queryByTestId("t-sort")).toBeNull();
    unmount();

    toolbar({ onSort, sortOptions: [{ value: "", label: "Newest first" }, { value: "total", label: "Total" }] });
    fireEvent.change(screen.getByTestId("t-sort"), { target: { value: "total" } });
    expect(onSort).toHaveBeenCalledWith("total");
  });

  it("shows Clear only when there is something to clear, and calls onClear", () => {
    const onClear = vi.fn();
    const { unmount } = toolbar({ canClear: false });
    expect(screen.queryByTestId("t-clear")).toBeNull();
    unmount();

    toolbar({ canClear: true, onClear });
    fireEvent.click(screen.getByTestId("t-clear"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
