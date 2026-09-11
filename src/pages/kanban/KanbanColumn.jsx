import { useState } from "react";
import { T } from "../../tokens";
import { IconSettings } from "../../components/primitives/Icon";
import TicketCard from "./TicketCard";
import { COLUMNS, COL_ACCENT, PREVIEW_LIMIT } from "./constants";

// ─── Kanban Column ────────────────────────────────────────────────────────────

const KanbanColumn = ({ status, tickets, allTickets, onEdit, onDelete, onMove, onPreview, onDiagram, onCoverage,
                        onDrop, colIndex, dragId, previewId, wipLimit, onSetWipLimit, columns = COLUMNS,
                        colAccent }) => {
  const [dropTarget, setDropTarget] = useState(null);
  const [colDragOver, setColDragOver] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const [editingWip, setEditingWip] = useState(false);
  const [wipInput,   setWipInput]   = useState(wipLimit ?? "");
  const clearDrop = () => { setDropTarget(null); setColDragOver(false); };

  // WIP status: null = no limit, "ok" = under, "warn" = at limit, "over" = exceeded
  const wipStatus = wipLimit
    ? tickets.length > wipLimit  ? "over"
    : tickets.length === wipLimit ? "warn"
    : "ok"
    : null;

  const accent = colAccent || COL_ACCENT[status] || "#6366f1";

  const WIP_BADGE_COLOR = { ok: T.success, warn: T.warning, over: T.danger };

  const handleColDragOver = e => {
    e.preventDefault();
    // Only highlight column if dragging over the empty area (no card target)
    setColDragOver(true);
  };

  const handleCardDragOver = (id, side) => {
    setColDragOver(false);
    setDropTarget({ id, side });
  };

  const handleDrop = e => {
    e.preventDefault();
    const id = e.dataTransfer.getData("ticketId");
    if (id) onDrop(id, status, dropTarget?.id, dropTarget?.side);
    clearDrop();
  };

  return (
    <div
      onDragOver={handleColDragOver}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) clearDrop(); }}
      onDrop={handleDrop}
      style={{
        flex: 1, minWidth: 220,
        background: colDragOver ? `${accent}11` : T.surface,
        border:     `1px solid ${colDragOver ? accent : T.border}`,
        borderTop:  `3px solid ${accent}`,
        borderRadius: 10, padding: 14,
        transition: "background .15s, border-color .15s",
        display: "flex", flexDirection: "column", gap: 6,
      }}
    >
      {/* Column header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text }}>{status}</span>
          {/* Count badge — colour shifts when WIP limit is at/exceeded */}
          <span style={{
            fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            color:      wipStatus ? WIP_BADGE_COLOR[wipStatus] : accent,
            background: wipStatus ? `${WIP_BADGE_COLOR[wipStatus]}22` : `${accent}22`,
            border:     `1px solid ${wipStatus ? WIP_BADGE_COLOR[wipStatus] + "55" : accent + "44"}`,
            borderRadius: 10, padding: "1px 8px",
            transition: "color .2s, background .2s, border-color .2s",
          }}>
            {tickets.length}{wipLimit ? ` / ${wipLimit}` : ""}
          </span>
          {wipStatus === "over" && (
            <span title="WIP limit exceeded" style={{ fontSize: 13 }}>⚠</span>
          )}
        </div>

        {/* WIP limit gear — admin only; shown on hover */}
        <div style={{ position: "relative" }}>
          {editingWip ? (
            <form onSubmit={e => { e.preventDefault(); onSetWipLimit(wipInput === "" ? null : Number(wipInput)); setEditingWip(false); }}
              style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="number" min="1" max="99" value={wipInput}
                onChange={e => setWipInput(e.target.value)}
                placeholder="∞"
                autoFocus
                style={{ width: 44, fontFamily: T.mono, fontSize: 12, textAlign: "center",
                  background: T.bg, border: `1px solid ${T.accent}`, borderRadius: 5,
                  color: T.text, padding: "2px 4px", outline: "none" }} />
              <button type="submit" style={{ background: T.accent, border: "none", borderRadius: 4,
                color: "#fff", cursor: "pointer", fontSize: 11, padding: "2px 6px", fontFamily: T.body }}>✓</button>
              <button type="button" onClick={() => setEditingWip(false)}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
                  color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "2px 6px", fontFamily: T.body }}>✕</button>
            </form>
          ) : (
            <button type="button" onClick={() => { setWipInput(wipLimit ?? ""); setEditingWip(true); }}
              title={wipLimit ? `WIP limit: ${wipLimit} — click to change` : "Set WIP limit"}
              style={{ background: "none", border: "none", cursor: "pointer",
                color: wipLimit ? T.accent : T.border, lineHeight: 1, display: "flex", alignItems: "center",
                padding: "2px 4px", opacity: 0.7, transition: "opacity .15s, color .15s" }}
              onMouseEnter={e => e.currentTarget.style.opacity = "1"}
              onMouseLeave={e => e.currentTarget.style.opacity = "0.7"}>
              <IconSettings size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Cards */}
      {(expanded ? tickets : tickets.slice(0, PREVIEW_LIMIT)).map(t => (
        <TicketCard
          key={t.id}
          ticket={t}
          colIndex={colIndex}
          allTickets={allTickets}
          columns={columns}
          isDragging={dragId === t.id}
          isSelected={previewId === t.id}
          dropIndicator={dropTarget?.id === t.id ? dropTarget.side : null}
          onEdit={onEdit}
          onDelete={onDelete}
          onMove={onMove}
          onPreview={onPreview}
          onDiagram={onDiagram}
          onCoverage={onCoverage}
          onDragStart={() => setDropTarget(null)}
          onDragEnd={() => clearDrop()}
          onDragOver={handleCardDragOver}
        />
      ))}

      {/* Show more / collapse */}
      {tickets.length > PREVIEW_LIMIT && !expanded && (
        <>
          <div style={{ borderTop: `1px dashed ${T.border}`, margin: "4px 0" }} />
          <button
            type="button"
            onClick={() => setExpanded(true)}
            style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, background: "none",
              border: "none", cursor: "pointer", textAlign: "center", padding: "4px 0",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
            onMouseEnter={e => e.currentTarget.style.color = T.text}
            onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
            <span>▾▾</span>
            <span>Show {tickets.length - PREVIEW_LIMIT} more</span>
          </button>
        </>
      )}
      {tickets.length > PREVIEW_LIMIT && expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, background: "none",
            border: "none", cursor: "pointer", textAlign: "center", padding: "4px 0",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
          onMouseEnter={e => e.currentTarget.style.color = T.text}
          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
          <span>▴▴</span>
          <span>Collapse</span>
        </button>
      )}

      {/* Empty state / bottom drop zone */}
      {tickets.length === 0 && (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.border,
          fontStyle: "italic", textAlign: "center", padding: "20px 0" }}>
          Drop cards here
        </div>
      )}
    </div>
  );
};

export default KanbanColumn;
