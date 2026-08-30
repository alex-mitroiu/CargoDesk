import { T } from "../../tokens";
import Btn from "./Btn";

// ─── Global Pagination ────────────────────────────────────────────────────────
// Single shared component — use everywhere instead of inline prev/next buttons.

const Pagination = ({ total, offset, limit, onPage }) => {
  if (!total || total <= limit) return null;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages  = Math.ceil(total / limit);
  return (
    // No marginTop here — every call site already wraps this component in its own flex row
    // alongside PageSizeSelect, and that row supplies its own top spacing (marginTop on the
    // wrapper). A marginTop here too used to double up with that, and — since this row sits in
    // a shared alignItems:center wrapper — an asymmetric top-only margin on a flex item shifts
    // its effective centering box, not just its position, throwing this row visibly a few px
    // lower than "Rows per page" next to it (measured ~8px, a real reported misalignment, not
    // cosmetic nitpicking). minHeight matches PageSizeSelect's own <select> (28px, padding
    // "5px 8px" vs. this row's own tallest child, Btn size="sm" at 25px) so the two rows'
    // cross-axis centers coincide exactly rather than off by the small remaining px gap.
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 28 }}>
      <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
        {(offset + 1).toLocaleString()}–{Math.min(offset + limit, total).toLocaleString()} of {total.toLocaleString()}
        <span style={{ marginLeft: 8, color: T.border }}>· page {currentPage} / {totalPages}</span>
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="secondary" size="sm" disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - limit))}>← Prev</Btn>
        <Btn variant="secondary" size="sm" disabled={offset + limit >= total}
          onClick={() => onPage(offset + limit)}>Next →</Btn>
      </div>
    </div>
  );
};

export default Pagination;
