import { T } from "../../tokens";
import { inputBase } from "./Form";

// ─── Shared page-size preference ────────────────────────────────────────────
// One global localStorage key rather than a per-table key — a page-size preference is a plain
// scalar "how much do I want to see at once" setting a user reasonably expects to carry across
// the whole app (same idiom as cd_theme/cargodesk_active_role/cargodesk_dismissed_bell), not
// independently-toggled UI state like the per-nav-group cd_navfold_* keys. Picking 100 on one
// table makes 100 the default everywhere else too, next time.
export const PAGE_SIZE_KEY = "cargodesk_page_size";
export const DEFAULT_PAGE_SIZE = 50;
export const PAGE_SIZE_OPTIONS = [50, 75, 100];

export function getStoredPageSize() {
  try {
    const n = parseInt(localStorage.getItem(PAGE_SIZE_KEY), 10);
    return PAGE_SIZE_OPTIONS.includes(n) ? n : DEFAULT_PAGE_SIZE;
  } catch { return DEFAULT_PAGE_SIZE; }
}

// Bare <select>, no Field/label wrapper — matches every other inline filter-bar dropdown in
// this app (ShipmentsPage's carrier/sort selects, MdmContractsPage's filters), not the vertical
// Sel/Field primitives meant for form layouts inside modals. Meant to sit next to Pagination.
const PageSizeSelect = ({ value, onChange }) => (
  <label style={{ display: "flex", alignItems: "center", gap: 6,
    fontFamily: T.body, fontSize: 12, color: T.textMuted, flexShrink: 0 }}>
    Rows per page
    <select
      value={value}
      onChange={e => {
        const n = parseInt(e.target.value, 10);
        try { localStorage.setItem(PAGE_SIZE_KEY, String(n)); } catch { /* ignore */ }
        onChange(n);
      }}
      style={{ ...inputBase, width: 68, padding: "5px 8px", cursor: "pointer", fontSize: 12 }}>
      {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
    </select>
  </label>
);

export default PageSizeSelect;
