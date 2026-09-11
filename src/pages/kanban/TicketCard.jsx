import { useState, useRef } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import Badge from "../../components/primitives/Badge";
import ActionMenu from "../../components/primitives/ActionMenu";
import { ConfirmModal } from "../../components/primitives/Modal";
import { IconArrowDown, IconPencil, IconChartBar, IconMap, IconClose } from "../../components/primitives/Icon";
import { COLUMNS, PRIORITY_DOT, TYPE_VARIANT, TYPE_ICON, PRIORITY_VARIANT, avatarColor, isOverdue } from "./constants";

// ─── Drop Indicator ───────────────────────────────────────────────────────────

const DropLine = () => (
  <div style={{
    height: 2, borderRadius: 2,
    background: T.accent,
    boxShadow: `0 0 6px ${T.accent}88`,
    margin: "2px 0",
    flexShrink: 0,
  }} />
);

// ─── Ticket Card ──────────────────────────────────────────────────────────────

const TicketCard = ({ ticket, onEdit, onDelete, onMove, onPreview, onDiagram, onCoverage, colIndex,
                      isSelected, isDragging, dropIndicator,
                      onDragStart, onDragEnd, onDragOver,
                      allTickets = [], columns = COLUMNS }) => {
  const { canEditKanban: canEdit } = useAuth();
  const [confirm, setConfirm] = useState(false);
  const cardRef  = useRef(null);
  const dragged  = useRef(false);

  // Compute child progress for Epic cards (done / total children).
  const children   = ticket.type === "Epic" ? allTickets.filter(t => t.parentId === ticket.id) : [];
  const doneCount  = children.filter(t => ["Done","Ready to Deploy","Released"].includes(t.status)).length;
  const totalCount = children.length;
  const progress   = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : null;

  // Parent breadcrumb for non-top-level tickets.
  const parent = ticket.parentId ? allTickets.find(t => t.id === ticket.parentId) : null;

  const handleDragOver = e => {
    e.preventDefault();
    e.stopPropagation();
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const mid  = rect.top + rect.height / 2;
    onDragOver(ticket.id, e.clientY < mid ? "before" : "after");
  };

  const stop = fn => e => { e.stopPropagation(); fn(); };

  return (
    <>
      {dropIndicator === "before" && <DropLine />}

      <div
        ref={cardRef}
        draggable={canEdit}
        onDragStart={canEdit ? (e => { dragged.current = true; e.dataTransfer.setData("ticketId", ticket.id); onDragStart(ticket.id); }) : undefined}
        onDragEnd={canEdit ? (e => { dragged.current = false; onDragEnd(e); }) : undefined}
        onDragOver={canEdit ? handleDragOver : undefined}
        onClick={() => { if (!dragged.current) onPreview(ticket); }}
        style={{
          background: isSelected ? `${T.accent}0d` : T.bg,
          border: `1px solid ${isSelected ? T.accent + "66" : T.border}`,
          borderLeft: `3px solid ${isSelected ? T.accent : (PRIORITY_DOT[ticket.priority] || T.border)}`,
          borderRadius: 8, padding: "12px 14px", cursor: "pointer",
          opacity: isDragging ? 0.35 : 1,
          transition: "opacity .15s, box-shadow .15s, border-color .15s, background .15s",
          boxShadow: isDragging ? "none" : isSelected ? `0 0 0 1px ${T.accent}33, 0 2px 8px rgba(0,0,0,.25)` : "0 2px 8px rgba(0,0,0,.25)",
          userSelect: "none",
        }}
        onMouseEnter={e => { if (!isDragging) e.currentTarget.style.boxShadow = isSelected ? `0 0 0 1px ${T.accent}33, 0 4px 16px rgba(0,0,0,.4)` : "0 4px 16px rgba(0,0,0,.4)"; }}
        onMouseLeave={e => e.currentTarget.style.boxShadow = isDragging ? "none" : isSelected ? `0 0 0 1px ${T.accent}33, 0 2px 8px rgba(0,0,0,.25)` : "0 2px 8px rgba(0,0,0,.25)"}
      >
        {/* Parent breadcrumb — shown on tickets that have a parent */}
        {parent && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
            <Badge variant={TYPE_VARIANT[parent.type] || "default"} style={{ fontSize: 9 }}>{parent.type}</Badge>
            <span style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
              {parent.title}
            </span>
          </div>
        )}

        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text, lineHeight: 1.4 }}>
              {ticket.title}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, marginTop: 2,
              display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11 }}>{TYPE_ICON[ticket.type] || "📋"}</span>
              {ticket.id}
            </div>
          </div>
          {/* Epic progress ring */}
          {ticket.type === "Epic" && progress !== null && (
            <div title={`${doneCount} / ${totalCount} children done`}
              style={{ position: "relative", width: 32, height: 32, flexShrink: 0 }}>
              <svg width="32" height="32" style={{ transform: "rotate(-90deg)" }}>
                <circle cx="16" cy="16" r="12" fill="none" stroke={T.border} strokeWidth="3" />
                <circle cx="16" cy="16" r="12" fill="none"
                  stroke={progress === 100 ? T.success : T.accent} strokeWidth="3"
                  strokeDasharray={`${2 * Math.PI * 12}`}
                  strokeDashoffset={`${2 * Math.PI * 12 * (1 - progress / 100)}`}
                  strokeLinecap="round" style={{ transition: "stroke-dashoffset .3s" }} />
              </svg>
              <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
                justifyContent: "center", fontFamily: T.mono, fontSize: 8, fontWeight: 700,
                color: progress === 100 ? T.success : T.text }}>
                {progress}%
              </span>
            </div>
          )}
          {/* Actions gear — top-right, stops click propagation so it doesn't open preview */}
          {canEdit && (
            <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}>
              <ActionMenu items={[
                ...(!["Done", "Ready to Deploy", "Released", "Backlog"].includes(ticket.status)
                  ? [{ icon: IconArrowDown, label: "Send to Backlog", onClick: () => onMove(ticket, "Backlog") }]
                  : []),
                { icon: IconPencil, label: "Edit", onClick: () => onEdit(ticket) },
                ...(ticket.type === "Epic"
                  ? [
                      { icon: IconChartBar, label: "Coverage", onClick: () => onCoverage && onCoverage(ticket) },
                      { icon: IconMap, label: "Diagram",  onClick: () => onDiagram  && onDiagram(ticket)  },
                    ]
                  : []),
                { icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(true) },
              ]} />
            </div>
          )}
        </div>

        {/* Linked shipment */}
        {ticket.shipmentId && (
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.accent,
            background: `${T.accent}15`, border: `1px solid ${T.accent}33`,
            borderRadius: 4, padding: "2px 7px", marginBottom: 8, display: "inline-block" }}>
            ⛴ {ticket.shipmentId}
          </div>
        )}

        {/* Meta */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
          {ticket.type && ticket.type !== "Task" && (
            <Badge variant={TYPE_VARIANT[ticket.type] || "default"}>{ticket.type}</Badge>
          )}
          <Badge variant={PRIORITY_VARIANT[ticket.priority] || "default"}>{ticket.priority}</Badge>
          {ticket.section && (
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
              background: T.surface, border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 6px" }}>
              {ticket.section}
            </span>
          )}
          {ticket.version && (
            <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
              color: "#8b5cf6", background: "rgba(139,92,246,.12)",
              border: "1px solid rgba(139,92,246,.3)", borderRadius: 4, padding: "1px 6px" }}>
              v{ticket.version}
            </span>
          )}
        </div>

        {/* Description preview */}
        {ticket.description && (
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.5,
            overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
            marginBottom: 10 }}>
            {ticket.description}
          </div>
        )}

        {/* Assignee + due date footer */}
        {(ticket.assigneeId || ticket.dueDate) && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: 8, gap: 6 }}>
            {ticket.assigneeId ? (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                {/* Avatar circle — colour is deterministic from the user ID */}
                <div style={{
                  width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                  background: avatarColor(ticket.assigneeId),
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: T.body, fontSize: 10, fontWeight: 700, color: "#fff",
                }}>
                  {ticket.assigneeInitial || "?"}
                </div>
                <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                  {ticket.assigneeName || ticket.assigneeId}
                </span>
              </div>
            ) : <span />}

            {ticket.dueDate && (
              <span style={{
                fontFamily: T.mono, fontSize: 10, fontWeight: 600,
                padding: "1px 6px", borderRadius: 4,
                color:      isOverdue(ticket.dueDate) ? T.danger  : T.textMuted,
                background: isOverdue(ticket.dueDate) ? `${T.danger}15`  : T.surface,
                border:     `1px solid ${isOverdue(ticket.dueDate) ? T.danger + "55" : T.border}`,
              }}>
                {isOverdue(ticket.dueDate) ? "⚠ " : ""}{ticket.dueDate}
              </span>
            )}
          </div>
        )}

        {/* Nav arrows — back / forward only */}
        {canEdit && (colIndex > 0 || colIndex < columns.length - 1) && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 5,
          borderTop: `1px solid ${T.border}22`, paddingTop: 8 }}>
          {colIndex > 0 ? (
            <button onClick={stop(() => onMove(ticket, columns[colIndex - 1]))}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
                color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "2px 8px", fontFamily: T.body }}>
              ← {columns[colIndex - 1].split(" ")[0]}
            </button>
          ) : <span />}
          {colIndex < columns.length - 1 && (
            <button onClick={stop(() => onMove(ticket, columns[colIndex + 1]))}
              style={{ background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 4,
                color: T.accent, cursor: "pointer", fontSize: 11, padding: "2px 8px",
                fontFamily: T.body, fontWeight: 600 }}>
              {columns[colIndex + 1].split(" ")[0]} →
            </button>
          )}
        </div>
        )}
      </div>

      {dropIndicator === "after" && <DropLine />}

      {confirm && (
        <ConfirmModal
          message={`Delete "${ticket.title}"?`}
          onConfirm={() => { setConfirm(false); onDelete(ticket.id); }}
          onCancel={() => setConfirm(false)} />
      )}
    </>
  );
};

export default TicketCard;
