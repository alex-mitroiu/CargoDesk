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

// ── Space Configurations added four things to the shared table; each is opt-in, so every other table is
// untouched. These pin the new behaviour AND that the default stays the same.

describe("DataTable — grouped headers", () => {
  const GROUPED = [
    { key: "id",     header: "Quote",       width: 100, render: r => r.id },
    { key: "origin", header: "Origin",      width: 90,  group: "Trade", filter: true, render: r => r.origin },
    { key: "dest",   header: "Destination", width: 90,  group: "Trade", filter: true, render: r => r.dest },
    { key: "amount", header: "Total",       width: 80,  render: r => r.amount },
  ];
  const G_ROWS = [{ id: "Q-1", origin: "EU-N", dest: "NAM", amount: "$10" }];
  const grouped = (props = {}) => render(
    <DataTable tableId="g" columns={GROUPED} rows={G_ROWS} loading={false} rowKey={r => r.id}
      filters={{ origin: null, dest: null }} filterOptions={{ origin: ["EU-N"], dest: ["NAM"] }} onFilterChange={() => {}} {...props} />
  );

  it("puts one shared heading over a run of adjacent columns, and keeps each column's own heading beneath it", () => {
    grouped();
    expect(screen.getAllByTestId("g-group-Trade")).toHaveLength(1);
    expect(screen.getByTestId("g-group-Trade")).toHaveTextContent("Trade");
    expect(within(screen.getByTestId("g-col-origin")).getByRole("button")).toHaveTextContent("Origin");
    expect(within(screen.getByTestId("g-col-dest")).getByRole("button")).toHaveTextContent("Destination");
  });

  it("places the group over exactly its own columns, the group's columns on the second row, the rest spanning both", () => {
    grouped();
    const style = id => screen.getByTestId(id).getAttribute("style");
    expect(style("g-group-Trade")).toMatch(/grid-column:\s*2 \/ span 2/);
    expect(style("g-group-Trade")).toMatch(/grid-row:\s*1/);
    expect(style("g-col-origin")).toMatch(/grid-row:\s*2/);
    expect(style("g-col-dest")).toMatch(/grid-column:\s*3/);
    expect(style("g-col-id")).toMatch(/grid-row:\s*1 \/ span 2/);
    expect(style("g-col-amount")).toMatch(/grid-row:\s*1 \/ span 2/);
  });

  it("makes no group heading, and sets no grid placement, for a table without groups", () => {
    renderTable();
    expect(screen.queryByTestId("t-group-Trade")).toBeNull();
    expect(screen.getByTestId("t-col-id").getAttribute("style")).not.toMatch(/grid-row/);
  });

  it("still filters through a grouped column's own checklist", () => {
    const onFilterChange = vi.fn();
    grouped({ onFilterChange, filters: { origin: [], dest: null }, filterOptions: { origin: ["EU-N", "FE"], dest: ["NAM"] } });
    fireEvent.click(within(screen.getByTestId("g-col-origin")).getByRole("button"));
    fireEvent.click(screen.getByLabelText("EU-N"));
    expect(onFilterChange).toHaveBeenCalledWith("origin", ["EU-N"]);
  });
});

describe("DataTable — sort-only columns", () => {
  const SORT_OPTIONS = [
    { value: "awarded_desc", group: "Awarded TEU", label: "High to low", arrow: "↓", marker: "TEU" },
    { value: "awarded_asc",  group: "Awarded TEU", label: "Low to high", arrow: "↑", marker: "TEU" },
    { value: "use_desc",     group: "Consumption", label: "High to low", arrow: "↓", marker: "%" },
  ];
  const S_COLS = [
    { key: "id", header: "Quote", width: 100, filter: true, render: r => r.id },
    { key: "conf", header: "Confirmed", width: 100, sortOptions: SORT_OPTIONS, render: r => r.amount },
  ];
  const sortable = (props = {}) => render(
    <DataTable tableId="s" columns={S_COLS} rows={ROWS} loading={false} rowKey={r => r.id}
      filters={{ id: null }} filterOptions={{ id: ["Q-1", "Q-2"] }} onFilterChange={() => {}} sort="" onSort={() => {}} {...props} />
  );
  const open = () => fireEvent.click(within(screen.getByTestId("s-col-conf")).getByRole("button"));

  it("gives the column a sort control rather than a checklist, and shows the cells' own values", () => {
    sortable();
    expect(screen.getByTestId("s-row-Q-1")).toHaveTextContent("$10");
    open();
    expect(screen.getByRole("menuitemradio", { name: "Awarded TEU: High to low" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Consumption: High to low" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search…")).toBeNull();          // no checklist search box
    expect(screen.queryByText("Select all")).toBeNull();
  });

  it("reports the chosen sort through onSort, and closes", () => {
    const onSort = vi.fn();
    sortable({ onSort });
    open();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Awarded TEU: Low to high" }));
    expect(onSort).toHaveBeenCalledWith("awarded_asc");
    expect(screen.queryByText("Sort by")).toBeNull();
  });

  it("marks the current choice, and names what is being sorted beside the heading", () => {
    sortable({ sort: "use_desc" });
    expect(screen.getByTestId("column-sort-marker")).toHaveTextContent("%");
    open();
    expect(screen.getByRole("menuitemradio", { name: "Consumption: High to low" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Awarded TEU: High to low" })).toHaveAttribute("aria-checked", "false");
  });

  it("stays unlit when the table is sorted by something that is not one of its options", () => {
    sortable({ sort: "somethingElse" });
    expect(screen.queryByTestId("column-sort-marker")).toBeNull();
  });

  it("offers Clear sort, which reports an empty sort", () => {
    const onSort = vi.fn();
    sortable({ sort: "awarded_desc", onSort });
    open();
    fireEvent.click(screen.getByText("Clear sort"));
    expect(onSort).toHaveBeenCalledWith("");
  });

  it("closes on Escape and on a click elsewhere", () => {
    sortable();
    open();
    expect(screen.getByText("Sort by")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Sort by")).toBeNull();
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Sort by")).toBeNull();
  });
});

describe("DataTable — row accent", () => {
  it("draws a coloured stripe on the rows that ask for one and reserves the same width on the others", () => {
    renderTable({ rowAccent: r => (r.id === "Q-1" ? "rgb(255, 0, 0)" : null) });
    expect(screen.getByTestId("t-row-Q-1").style.borderLeft).toBe("3px solid rgb(255, 0, 0)");
    expect(screen.getByTestId("t-row-Q-2").style.borderLeft).toBe("3px solid transparent");
  });

  it("adds nothing at all when the table has no rowAccent", () => {
    renderTable();
    expect(screen.getByTestId("t-row-Q-1").style.borderLeft).toBe("");
  });
});

describe("DataTable — sideways scroll", () => {
  it("scrolls sideways instead of clipping when asked, holding the columns at their full width", () => {
    renderTable({ scrollX: true });
    const card = screen.getByTestId("t-table");
    expect(card.style.overflowX).toBe("auto");
    // 120 + 100 + 100 of columns, plus the rows' 20px side padding each way.
    expect(card.firstElementChild.style.minWidth).toBe("360px");
  });

  it("keeps the clip everywhere else", () => {
    renderTable();
    expect(screen.getByTestId("t-table").style.overflowX).toBe("hidden");
    expect(screen.getByTestId("t-table").firstElementChild.style.minWidth).toBe("");
  });
});

describe("DataTable — uppercase headings", () => {
  const headerButton = () => within(screen.getByTestId("t-col-id")).getByRole("button");
  it("leaves filterable headings as written by default", () => {
    renderTable();
    expect(headerButton().style.textTransform).toBe("");
  });
  it("makes them inherit the header's uppercase when asked", () => {
    renderTable({ uppercaseHeaders: true });
    expect(headerButton().style.textTransform).toBe("inherit");
    expect(headerButton().style.letterSpacing).toBe("inherit");
  });
});
