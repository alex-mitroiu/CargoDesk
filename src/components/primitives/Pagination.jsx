import { T } from "../../tokens";
import Btn from "./Btn";

// ─── Global Pagination ────────────────────────────────────────────────────────
// Single shared component — use everywhere instead of inline prev/next buttons.

const Pagination = ({ total, offset, limit, onPage }) => {
  if (!total || total <= limit) return null;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages  = Math.ceil(total / limit);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
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
