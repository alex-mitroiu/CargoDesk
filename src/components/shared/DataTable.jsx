import { T } from "../../tokens";
import { useResizableColumns, ColResizer } from "../primitives/useResizableColumns";
import ColumnFilter from "./ColumnFilter";
import ActionMenu from "../primitives/ActionMenu";
import Pagination from "../primitives/Pagination";
import PageSizeSelect from "../primitives/PageSizeSelect";
import { PageSpinner } from "../primitives/Spinner";
import { inputBase } from "../primitives/Form";
import { IconClose } from "../primitives/Icon";

// ─── DataTable — the Shipments table, as a reusable shell ─────────────────────────────────────
// The look and behavior ShipmentsPage.jsx established, extracted so other list pages don't each
// hand-roll their own: a bordered card, an uppercase header row whose cells carry an Excel-style
// filter checklist (ColumnFilter) and a drag-to-resize handle, hover-highlighted rows, an empty and
// a "no match" state, and the page-size + pagination footer. State (filters, sort, paging) lives
// in useTableQuery — this component is presentational and never fetches.
//
//   <DataTable
//     tableId="quotes"                       // colwidths:<tableId> in localStorage + data-testid prefix
//     columns={[{ key, header, width, align?, filter?, describe?, render }]}
//     rows loading rowKey hasFilters filters filterOptions onFilterChange
//     onRowClick? onRowDoubleClick? rowTitle? rowActions?       // rowActions(row) -> ActionMenu items
//     emptyMessage emptyFilteredMessage
//     pagination={{ total, offset, limit, onPage, onLimit }}
//   />
//
// column.filter — true filters on `key`; a string filters on that key instead (when the checklist
//   key differs from the column's own key). Omit for a non-filterable column.
// column.width  — default px width; the user's own drag-resized widths win once saved.
// column.align  — "left" (default) | "center" | "right"; applies to header label and cell content.
// column.render(row) — the cell content. Return several elements to stack them (name over code).
// column.describe(value) — optional secondary label shown beside a value in that column's checklist.

const HEADER_CELL = {
  position: "relative", fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
  color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
};
const ALIGN = { left: "flex-start", center: "center", right: "flex-end" };

const DataTable = ({
  tableId, columns, rows, loading, rowKey,
  hasFilters = false, filters, filterOptions = {}, onFilterChange,
  onRowClick, onRowDoubleClick, rowTitle, rowActions, actionsWidth = 60,
  emptyMessage = "Nothing here yet.", emptyFilteredMessage = "Nothing matches your filters.",
  pagination,
}) => {
  const { template, startResize } = useResizableColumns(
    tableId, [...columns.map(c => c.width), ...(rowActions ? [actionsWidth] : [])]
  );
  const columnCount = columns.length + (rowActions ? 1 : 0);
  const clickable = !!(onRowClick || onRowDoubleClick);
  const filterKeyOf = c => (c.filter === true ? c.key : (typeof c.filter === "string" ? c.filter : null));

  return (
    <>
      <div data-testid={`${tableId}-table`}
        style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: template, padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {columns.map((c, i) => {
            const fk = filterKeyOf(c);
            const align = c.align || "left";
            return (
              <div key={c.key} data-testid={`${tableId}-col-${c.key}`}
                style={{ ...HEADER_CELL, paddingLeft: align === "center" ? 0 : 6, textAlign: align }}>
                {fk ? (
                  <ColumnFilter label={c.header} available={filterOptions[fk] || []} selected={filters[fk] ?? null}
                    onChange={v => onFilterChange(fk, v)} describe={c.describe} />
                ) : c.header}
                {i < columnCount - 1 && <ColResizer onStart={e => startResize(i, e)} />}
              </div>
            );
          })}
          {rowActions && <div style={{ ...HEADER_CELL, paddingLeft: 6 }}>Actions</div>}
        </div>

        {loading ? (
          <div style={{ padding: 48 }}><PageSpinner /></div>
        ) : rows.length === 0 ? (
          <div data-testid={`${tableId}-empty`}
            style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            {hasFilters ? emptyFilteredMessage : emptyMessage}
          </div>
        ) : rows.map(row => {
          const key = rowKey(row);
          return (
            <div key={key} data-testid={`${tableId}-row-${key}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row) : undefined}
              title={rowTitle}
              style={{ display: "grid", gridTemplateColumns: template, padding: "14px 20px",
                borderBottom: `1px solid ${T.border}22`, cursor: clickable ? "pointer" : "default",
                alignItems: "center", transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              {columns.map(c => (
                <div key={c.key} style={{ minWidth: 0, overflowWrap: "anywhere", display: "flex", flexDirection: "column",
                  gap: 1, justifyContent: "center", alignItems: ALIGN[c.align || "left"] }}>
                  {c.render(row)}
                </div>
              ))}
              {rowActions && (
                <div onClick={e => e.stopPropagation()}>
                  <ActionMenu items={rowActions(row)} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {pagination && pagination.total > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, flexWrap: "wrap", gap: 8 }}>
          <PageSizeSelect value={pagination.limit} onChange={pagination.onLimit} />
          <div style={{ flex: 1 }}>
            <Pagination total={pagination.total} offset={pagination.offset} limit={pagination.limit} onPage={pagination.onPage} />
          </div>
        </div>
      )}
    </>
  );
};

// The bar above the table: free-text search (spans several columns at once), an optional sort
// dropdown (sorting is not a filter, so it stays a dropdown rather than a header control), and a
// Clear button that appears only once something is active. `children` takes page-specific extras.
export const TableToolbar = ({
  tableId, search, onSearch, searchPlaceholder = "Search…",
  sort, sortOptions, onSort, canClear, onClear, children,
}) => (
  <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
    <input data-testid={`${tableId}-search`} value={search} onChange={e => onSearch(e.target.value)}
      placeholder={searchPlaceholder} style={{ ...inputBase, flex: "1 1 200px", minWidth: 160 }} />
    {sortOptions && (
      <select data-testid={`${tableId}-sort`} value={sort} onChange={e => onSort(e.target.value)}
        style={{ ...inputBase, width: 160, cursor: "pointer" }}>
        {sortOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )}
    {canClear && (
      <button data-testid={`${tableId}-clear`} onClick={onClear}
        style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
          color: T.textMuted, cursor: "pointer", padding: "6px 12px",
          fontFamily: T.body, fontSize: 12, whiteSpace: "nowrap",
          display: "inline-flex", alignItems: "center", gap: 5 }}>
        <IconClose size={11} />Clear
      </button>
    )}
    {children}
  </div>
);

export default DataTable;
