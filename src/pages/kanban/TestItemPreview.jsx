import { useState } from "react";
import { T } from "../../tokens";
import Badge from "../../components/primitives/Badge";
import ActionMenu from "../../components/primitives/ActionMenu";
import { ConfirmModal } from "../../components/primitives/Modal";
import { IconPencil, IconClose } from "../../components/primitives/Icon";
import TestCaseStoryLinksPanel from "../../components/shared/TestCaseStoryLinksPanel";
import { TYPE_ICON, TYPE_VARIANT, PRIORITY_VARIANT } from "./constants";
import { tcLabel, tcStatusColor } from "./testStatus";

// ─── Test Item Preview Panel ──────────────────────────────────────────────────
// Lightweight, purpose-built preview for Test Folder/Plan/Run/Case — deliberately
// separate from TicketPreview (which is deeply wired to board-ticket concepts like
// Coverage/Diagram/columns/shipments) rather than forking that large component.

const TestItemPreview = ({ item, testItems, tickets, onClose, onEdit, onDelete, onPreview }) => {
  const [confirm, setConfirm] = useState(false);
  const parent   = item.parentId ? testItems.find(t => t.id === item.parentId) : null;
  const children = testItems.filter(t => t.parentId === item.id).sort((a, b) => a.position - b.position);
  const lbl      = tcLabel(item.status);
  const color    = tcStatusColor(item.status);

  return (
    <div style={{ width: 320, flexShrink: 0, alignSelf: "stretch", display: "flex", flexDirection: "column",
      background: T.surface, border: `1px solid ${T.border}`, borderTop: `3px solid ${color}`,
      borderRadius: 10, overflow: "hidden" }}>

      {/* Header */}
      <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 15 }}>{TYPE_ICON[item.type] || "📋"}</span>
            <Badge variant={TYPE_VARIANT[item.type] || "default"}>{item.type}</Badge>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent }}>{item.id}</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer",
            color: T.textMuted, fontSize: 18, lineHeight: 1, padding: "0 2px" }}>×</button>
        </div>
        <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, lineHeight: 1.4 }}>
          {item.title}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {parent && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Badge variant={TYPE_VARIANT[parent.type] || "default"}>{parent.type}</Badge>
            <button type="button" onClick={() => onPreview?.(parent)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                fontFamily: T.mono, fontSize: 11, color: T.accent, textDecoration: "underline dotted" }}>
              {parent.id}
            </button>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{parent.title}</span>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color,
            background: `${color}18`, border: `1px solid ${color}44`, borderRadius: 10, padding: "2px 10px" }}>
            {lbl}
          </span>
          <Badge variant={PRIORITY_VARIANT[item.priority] || "default"}>{item.priority}</Badge>
        </div>

        {item.assigneeName && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>Assignee:</span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.text }}>{item.assigneeName}</span>
          </div>
        )}

        {item.dueDate && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>Due:</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{item.dueDate}</span>
          </div>
        )}

        {item.description && (
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            {item.description}
          </div>
        )}

        {item.testNotes && (
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>Test Steps</div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.7, whiteSpace: "pre-wrap",
              background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, padding: "10px 14px" }}>
              {item.testNotes}
            </div>
          </div>
        )}

        {item.type === "Test Case" && (
          <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
            <TestCaseStoryLinksPanel caseId={item.id} tickets={tickets} />
          </div>
        )}

        {children.length > 0 && (
          <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
            <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>
              Children ({children.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {children.map(c => (
                <div key={c.id} onClick={() => onPreview?.(c)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                    borderRadius: 6, background: T.bg, border: `1px solid ${T.border}`, cursor: "pointer" }}>
                  <span style={{ fontSize: 12 }}>{TYPE_ICON[c.type] || "📋"}</span>
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted }}>{tcLabel(c.status)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.border}`, display: "flex", gap: 6, flexShrink: 0 }}>
        <ActionMenu items={[
          { icon: IconPencil, label: "Edit", onClick: () => onEdit(item) },
          { icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(true) },
        ]} />
      </div>

      {confirm && (
        <ConfirmModal
          message={`Delete "${item.title}"?${children.length ? ` This will also delete ${children.length} child item(s).` : ""}`}
          onConfirm={() => { setConfirm(false); onDelete(item.id); onClose(); }}
          onCancel={() => setConfirm(false)} />
      )}
    </div>
  );
};

export default TestItemPreview;
