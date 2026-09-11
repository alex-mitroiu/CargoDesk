import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Badge from "../../components/primitives/Badge";
import ActionMenu from "../../components/primitives/ActionMenu";
import { ConfirmModal } from "../../components/primitives/Modal";
import { IconPencil, IconChartBar, IconMap, IconClose } from "../../components/primitives/Icon";
import TicketLinksPanel from "./TicketLinksPanel";
import TestedByPanel from "./TestedByPanel";
import { COLUMNS, TYPE_ICON, TYPE_VARIANT, COL_ACCENT, PRIORITY_VARIANT, avatarColor, isOverdue } from "./constants";

// ─── Ticket Preview Panel ─────────────────────────────────────────────────────

const TicketPreview = ({ ticket, colIndex, shipments, tickets, testItems = [], users, onClose, onEdit, onMove, onDelete, onPreview, onDiagram, onCoverage, columns = COLUMNS }) => {
  const { canEditKanban: canEdit } = useAuth();
  const [confirm,    setConfirm]    = useState(false);
  const [tab,        setTab]        = useState("overview"); // "overview" | "links" | "order"
  const [links,      setLinks]      = useState(null);       // null = not yet fetched
  const [childLinks, setChildLinks] = useState(null);       // per-child link map

  const linked   = shipments.find(s => s.id === ticket.shipmentId);
  const parent   = ticket.parentId ? tickets.find(t => t.id === ticket.parentId) : null;
  const children = tickets.filter(t => t.parentId === ticket.id)
    .sort((a, b) => a.position - b.position);

  const DONE_SET = new Set(["Done", "Ready to Deploy", "Released"]);

  // Reset state when the viewed ticket changes
  useEffect(() => {
    setTab("overview");
    setLinks(null);
    setChildLinks(null);
  }, [ticket.id]);

  // Fetch this ticket's links lazily on first non-overview tab open
  useEffect(() => {
    if (tab !== "overview" && links === null) {
      api.tickets.links(ticket.id).then(setLinks).catch(() => setLinks([]));
    }
  }, [tab, ticket.id, links]);

  // Fetch per-child links lazily when Order tab opens on a parent ticket
  useEffect(() => {
    if (tab === "order" && children.length > 0 && childLinks === null) {
      Promise.all(
        children.map(c =>
          api.tickets.links(c.id).then(ls => [c.id, ls]).catch(() => [c.id, []])
        )
      ).then(pairs => setChildLinks(Object.fromEntries(pairs)));
    }
  }, [tab, children.length, childLinks]);

  // Kahn's topological sort
  const topoSort = (nodeIds, edges) => {
    const inDeg = Object.fromEntries(nodeIds.map(id => [id, 0]));
    const adj   = Object.fromEntries(nodeIds.map(id => [id, []]));
    edges.forEach(({ from, to }) => {
      if (adj[from] !== undefined && inDeg[to] !== undefined) {
        adj[from].push(to); inDeg[to]++;
      }
    });
    const queue  = nodeIds.filter(id => inDeg[id] === 0);
    const result = [];
    while (queue.length) {
      const n = queue.shift(); result.push(n);
      (adj[n] || []).forEach(m => { inDeg[m]--; if (inDeg[m] === 0) queue.push(m); });
    }
    nodeIds.forEach(id => { if (!result.includes(id)) result.push(id); });
    return result;
  };

  const tabBtn = (id, label) => (
    <button key={id} type="button" onClick={() => setTab(id)} style={{
      fontFamily: T.body, fontSize: 11, fontWeight: tab === id ? 700 : 400,
      color: tab === id ? T.accent : T.textMuted,
      background: "none", border: "none", cursor: "pointer",
      borderBottom: `2px solid ${tab === id ? T.accent : "transparent"}`,
      padding: "7px 0", flex: 1, transition: "color .12s, border-color .12s",
    }}>{label}</button>
  );

  const metaRow = (label, content) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 24 }}>
      <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, width: 68, flexShrink: 0 }}>
        {label}
      </span>
      {content}
    </div>
  );

  // ── Overview tab ──────────────────────────────────────────────────────────────
  const renderOverview = () => (
    <>
      {parent && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: -4 }}>
          <Badge variant={TYPE_VARIANT[parent.type] || "default"}>{parent.type}</Badge>
          <button type="button" onClick={() => onPreview?.(parent)}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
              fontFamily: T.mono, fontSize: 11, color: T.accent, textDecoration: "underline dotted" }}>
            {parent.id}
          </button>
          <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {parent.title}
          </span>
        </div>
      )}

      <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, lineHeight: 1.45 }}>
        {ticket.title}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8,
        paddingBottom: 16, borderBottom: `1px solid ${T.border}` }}>
        {metaRow("Status",
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            color: COL_ACCENT[ticket.status] || T.accent,
            background: `${COL_ACCENT[ticket.status] || T.accent}22`,
            border: `1px solid ${(COL_ACCENT[ticket.status] || T.accent)}44`, borderRadius: 10, padding: "2px 10px" }}>
            {ticket.status}
          </span>
        )}
        {metaRow("Type", <Badge variant={TYPE_VARIANT[ticket.type] || "default"}>{ticket.type}</Badge>)}
        {metaRow("Priority", <Badge variant={PRIORITY_VARIANT[ticket.priority] || "default"}>{ticket.priority}</Badge>)}
        {ticket.section && metaRow("Section",
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{ticket.section}</span>
        )}
        {ticket.version && metaRow("Version",
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            color: "#8b5cf6", background: "rgba(139,92,246,.12)",
            border: "1px solid rgba(139,92,246,.3)", borderRadius: 4, padding: "2px 8px" }}>
            v{ticket.version}
          </span>
        )}
        {ticket.assigneeId && metaRow("Assignee",
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
              background: avatarColor(ticket.assigneeId),
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: T.body, fontSize: 11, fontWeight: 700, color: "#fff" }}>
              {ticket.assigneeInitial || "?"}
            </div>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.text }}>
              {ticket.assigneeName || ticket.assigneeId}
            </span>
          </div>
        )}
        {ticket.dueDate && metaRow("Due Date",
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
            color:      isOverdue(ticket.dueDate) ? T.danger : T.text,
            background: isOverdue(ticket.dueDate) ? `${T.danger}15` : T.surface,
            border:     `1px solid ${isOverdue(ticket.dueDate) ? T.danger + "55" : T.border}` }}>
            {isOverdue(ticket.dueDate) ? "⚠ Overdue · " : ""}{ticket.dueDate}
          </span>
        )}
        {ticket.shipmentId && metaRow("Shipment",
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent,
            background: `${T.accent}15`, border: `1px solid ${T.accent}33`,
            borderRadius: 4, padding: "2px 8px" }}>
            ⛴ {ticket.shipmentId}{linked ? ` · ${linked.pol}→${linked.pod}` : ""}
          </span>
        )}
        {ticket.testNotes && metaRow("Test notes",
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.text,
            lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
            {ticket.testNotes}
          </span>
        )}
      </div>

      <div>
        <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
          textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>
          Description
        </div>
        {ticket.description ? (
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
            {ticket.description}
          </div>
        ) : (
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
            No description provided.
          </div>
        )}
      </div>

      {children.length > 0 && (
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
          <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8,
            display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>Children ({children.length})</span>
            <span style={{ fontWeight: 400, color: T.border }}>
              {children.filter(c => DONE_SET.has(c.status)).length} done
            </span>
          </div>
          {(() => {
            const done = children.filter(c => DONE_SET.has(c.status)).length;
            const pct  = Math.round((done / children.length) * 100);
            return (
              <div style={{ height: 4, borderRadius: 2, background: T.border, marginBottom: 10, overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 2, width: `${pct}%`,
                  background: pct === 100 ? T.success : T.accent, transition: "width .3s" }} />
              </div>
            );
          })()}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {children.map(c => (
              <div key={c.id} onClick={() => onPreview?.(c)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                  borderRadius: 6, background: T.bg, border: `1px solid ${T.border}`,
                  cursor: "pointer", transition: "background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                onMouseLeave={e => e.currentTarget.style.background = T.bg}>
                <span style={{ fontSize: 12, flexShrink: 0, color: DONE_SET.has(c.status) ? T.success : T.border }}>
                  {DONE_SET.has(c.status) ? "✓" : "○"}
                </span>
                <span style={{ fontSize: 13, flexShrink: 0 }}>{TYPE_ICON[c.type] || "📋"}</span>
                <Badge variant={TYPE_VARIANT[c.type] || "default"}>{c.type}</Badge>
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  textDecoration: DONE_SET.has(c.status) ? "line-through" : "none",
                  opacity: DONE_SET.has(c.status) ? 0.6 : 1 }}>
                  {c.title}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, flexShrink: 0 }}>
                  {c.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );

  // ── Links tab ──────────────────────────────────────────────────────────────────
  const renderLinks = () => {
    if (links === null) return (
      <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body,
        fontSize: 12, color: T.textMuted }}>Loading links…</div>
    );

    const GROUP_ORDER = ["Is blocked by", "Blocks", "Implements", "Is implemented by", "Relates to", "Duplicates", "Is duplicated by"];
    const GROUP_ICON  = { "Is blocked by": "🚧", "Blocks": "⛔", "Implements": "🔩",
      "Is implemented by": "📦", "Relates to": "↔", "Duplicates": "🔁", "Is duplicated by": "🔁" };
    const GROUP_COLOR = { "Is blocked by": T.warning, "Blocks": T.danger };

    const grouped = {};
    links.forEach(l => { (grouped[l.displayType] || (grouped[l.displayType] = [])).push(l); });
    const activeGroups = GROUP_ORDER.filter(g => grouped[g]?.length > 0);

    const hasBlocker = (grouped["Is blocked by"] || []).some(l => {
      const t = tickets.find(x => x.id === l.otherTicketId);
      return t && !DONE_SET.has(t.status);
    });

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {hasBlocker && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
            borderRadius: 7, background: `${T.warning}12`, border: `1px solid ${T.warning}44`,
            fontFamily: T.body, fontSize: 12, color: T.warning }}>
            🚧 This ticket has unresolved blockers.
          </div>
        )}

        {activeGroups.length === 0 && (
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
            No linked tickets.
          </div>
        )}

        {activeGroups.map(groupName => (
          <div key={groupName}>
            <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6,
              color: GROUP_COLOR[groupName] || T.textMuted,
              display: "flex", alignItems: "center", gap: 5 }}>
              {GROUP_ICON[groupName] || "🔗"} {groupName} ({grouped[groupName].length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {grouped[groupName].map(l => {
                const t    = tickets.find(x => x.id === l.otherTicketId);
                const done = t && DONE_SET.has(t.status);
                return (
                  <div key={l.id} onClick={() => t && onPreview?.(t)}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                      borderRadius: 6, background: T.bg, border: `1px solid ${T.border}`,
                      cursor: t ? "pointer" : "default", opacity: done ? 0.65 : 1,
                      transition: "background .1s" }}
                    onMouseEnter={e => { if (t) e.currentTarget.style.background = T.surfaceHover; }}
                    onMouseLeave={e => { e.currentTarget.style.background = T.bg; }}>
                    <span style={{ fontSize: 11, flexShrink: 0, color: done ? T.success : T.border }}>
                      {done ? "✓" : "○"}
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, flexShrink: 0 }}>
                      {l.otherTicketId}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      textDecoration: done ? "line-through" : "none" }}>
                      {l.otherTicket?.title || "Unknown ticket"}
                    </span>
                    {t?.status && (
                      <span style={{ fontFamily: T.mono, fontSize: 9, flexShrink: 0, whiteSpace: "nowrap",
                        color: COL_ACCENT[t.status] || T.textMuted,
                        background: `${COL_ACCENT[t.status] || T.border}18`,
                        border: `1px solid ${COL_ACCENT[t.status] || T.border}44`,
                        borderRadius: 4, padding: "1px 5px" }}>
                        {t.status}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {ticket.type === "Story" && (
          <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
            <TestedByPanel ticketId={ticket.id} testItems={testItems} />
          </div>
        )}

        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
          <TicketLinksPanel ticketId={ticket.id} allTickets={tickets} />
        </div>
      </div>
    );
  };

  // ── Order of Implementation tab ────────────────────────────────────────────────
  const renderOrder = () => {
    // Leaf ticket: show blocking chain (prereqs → this → unlocks)
    if (children.length === 0) {
      if (links === null) return (
        <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body,
          fontSize: 12, color: T.textMuted }}>Loading…</div>
      );
      const prereqs = links.filter(l => l.displayType === "Is blocked by");
      const unlocks = links.filter(l => l.displayType === "Blocks");

      if (prereqs.length === 0 && unlocks.length === 0) return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ padding: "16px", borderRadius: 8, background: T.bg,
            border: `1px solid ${T.border}`, fontFamily: T.body, fontSize: 12,
            color: T.textMuted, textAlign: "center", fontStyle: "italic" }}>
            No ordering constraints defined.
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.65 }}>
            On the <strong style={{ color: T.text }}>Links</strong> tab, add a{" "}
            <strong style={{ color: T.text }}>Blocks</strong> link to mark what this ticket must be
            completed before, or <strong style={{ color: T.text }}>Is blocked by</strong> to declare
            a prerequisite.
          </div>
        </div>
      );

      const chainRow = (l, alert) => {
        const t    = tickets.find(x => x.id === l.otherTicketId);
        const done = t && DONE_SET.has(t.status);
        return (
          <div key={l.id} onClick={() => t && onPreview?.(t)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
              borderRadius: 7, background: T.bg,
              border: `1px solid ${alert && !done ? T.warning + "55" : T.border}`,
              cursor: t ? "pointer" : "default", opacity: done ? 0.65 : 1, transition: "background .1s" }}
            onMouseEnter={e => { if (t) e.currentTarget.style.background = T.surfaceHover; }}
            onMouseLeave={e => { e.currentTarget.style.background = T.bg; }}>
            <span style={{ fontSize: 11, color: done ? T.success : (alert ? T.warning : T.border), flexShrink: 0 }}>
              {done ? "✓" : "○"}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, flexShrink: 0 }}>
              {l.otherTicketId}
            </span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {l.otherTicket?.title || ""}
            </span>
            {t?.status && (
              <span style={{ fontFamily: T.mono, fontSize: 9, color: COL_ACCENT[t.status] || T.textMuted, flexShrink: 0 }}>
                {t.status}
              </span>
            )}
          </div>
        );
      };

      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {prereqs.length > 0 && (
            <div>
              <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
                textTransform: "uppercase", letterSpacing: ".07em", color: T.warning, marginBottom: 6 }}>
                🚧 Prerequisites
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {prereqs.map(l => chainRow(l, true))}
              </div>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px",
            borderRadius: 7, background: `${T.accent}12`, border: `1px solid ${T.accent}44`,
            fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.accent }}>
            <span style={{ fontFamily: T.mono, fontSize: 10, flexShrink: 0 }}>{ticket.id}</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ticket.title}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, fontWeight: 400, flexShrink: 0 }}>
              this
            </span>
          </div>
          {unlocks.length > 0 && (
            <div>
              <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
                textTransform: "uppercase", letterSpacing: ".07em", color: T.textMuted, marginBottom: 6 }}>
                ✓ Unlocks
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {unlocks.map(l => chainRow(l, false))}
              </div>
            </div>
          )}
        </div>
      );
    }

    // Parent ticket: topological sort of children
    if (childLinks === null) return (
      <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body,
        fontSize: 12, color: T.textMuted }}>Building order…</div>
    );

    const childIds = new Set(children.map(c => c.id));
    const edges = [];
    children.forEach(c => {
      (childLinks[c.id] || []).forEach(l => {
        if (l.direction === "out" && childIds.has(l.otherTicketId) &&
            (l.linkType === "Blocks" || l.linkType === "Implements")) {
          edges.push({ from: c.id, to: l.otherTicketId });
        }
      });
    });

    const sorted = topoSort(children.map(c => c.id), edges)
      .map(id => children.find(c => c.id === id)).filter(Boolean);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {edges.length === 0 && (
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontStyle: "italic",
            padding: "8px 12px", borderRadius: 7, background: T.bg, border: `1px solid ${T.border}` }}>
            No dependency links between children — ordered by position. Add{" "}
            <strong style={{ color: T.text }}>Blocks</strong> links on child tickets to define ordering.
          </div>
        )}
        {sorted.map((c, i) => {
          const done      = DONE_SET.has(c.status);
          const isBlocked = edges.filter(e => e.to === c.id)
            .some(e => !DONE_SET.has(children.find(x => x.id === e.from)?.status));
          return (
            <div key={c.id} onClick={() => onPreview?.(c)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                borderRadius: 7, background: T.bg,
                border: `1px solid ${isBlocked ? T.warning + "55" : done ? T.success + "33" : T.border}`,
                cursor: "pointer", opacity: done ? 0.65 : 1,
                transition: "background .1s, border-color .15s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = T.bg}>
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, flexShrink: 0,
                width: 22, height: 22, borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                background: done ? `${T.success}22` : `${T.accent}22`,
                color: done ? T.success : T.accent,
                border: `1px solid ${done ? T.success + "44" : T.accent + "44"}` }}>
                {done ? "✓" : i + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.text, fontWeight: 500,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  textDecoration: done ? "line-through" : "none" }}>
                  {c.title}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, marginTop: 1,
                  display: "flex", gap: 5, alignItems: "center" }}>
                  {c.id}
                  {isBlocked && <span style={{ color: T.warning, fontWeight: 700 }}>· 🚧 blocked</span>}
                </div>
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 9, flexShrink: 0, whiteSpace: "nowrap",
                color: COL_ACCENT[c.status] || T.textMuted,
                background: `${COL_ACCENT[c.status] || T.border}18`,
                border: `1px solid ${COL_ACCENT[c.status] || T.border}44`,
                borderRadius: 4, padding: "1px 5px" }}>
                {c.status}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{
      width: 320, flexShrink: 0,
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderTop: `3px solid ${COL_ACCENT[ticket.status] || T.accent}`,
      borderRadius: 10,
      display: "flex", flexDirection: "column",
      overflow: "hidden",
      alignSelf: "stretch",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span title="Click to copy ticket ID"
          onClick={() => navigator.clipboard.writeText(ticket.id).then(() => toast.success(`Copied ${ticket.id}`))}
          style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, cursor: "pointer",
            userSelect: "none", padding: "2px 6px", borderRadius: 4, transition: "background .12s" }}
          onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
          {ticket.id}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {canEdit && (
            <ActionMenu items={[
              { icon: IconPencil, label: "Edit", onClick: onEdit },
              ...(ticket.type === "Epic" ? [
                { icon: IconChartBar, label: "Coverage", onClick: () => onCoverage?.(ticket) },
                { icon: IconMap, label: "Diagram",  onClick: () => onDiagram?.(ticket)  },
              ] : []),
              { icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(true) },
            ]} />
          )}
          <button onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 18, padding: "0 2px", lineHeight: 1 }}>×</button>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {tabBtn("overview", "Overview")}
        {tabBtn("links", "🔗 Links")}
        {tabBtn("order", "📋 Order")}
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px",
        display: "flex", flexDirection: "column", gap: 16 }}>
        {tab === "overview" && renderOverview()}
        {tab === "links"    && renderLinks()}
        {tab === "order"    && renderOrder()}
      </div>

      {/* Actions footer */}
      <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.border}`,
        display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
        {canEdit && !["Done", "Ready to Deploy", "Released", "Backlog"].includes(ticket.status) && (
          <button onClick={() => onMove(ticket, "Backlog")}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
              color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "5px 10px", fontFamily: T.body }}>
            ↓ Backlog
          </button>
        )}
        {canEdit && colIndex > 0 && (
          <button onClick={() => onMove(ticket, columns[colIndex - 1])}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
              color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "5px 10px", fontFamily: T.body }}>
            ← {columns[colIndex - 1].split(" ")[0]}
          </button>
        )}
        <div style={{ flex: 1 }} />
        {canEdit && colIndex < columns.length - 1 && (
          <button onClick={() => onMove(ticket, columns[colIndex + 1])}
            style={{ background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 5,
              color: T.accent, cursor: "pointer", fontSize: 11, padding: "5px 10px",
              fontFamily: T.body, fontWeight: 600 }}>
            {columns[colIndex + 1].split(" ")[0]} →
          </button>
        )}
      </div>

      {confirm && (
        <ConfirmModal
          message={`Delete "${ticket.title}"?`}
          onConfirm={() => { setConfirm(false); onDelete(ticket.id); onClose(); }}
          onCancel={() => setConfirm(false)} />
      )}
    </div>
  );
};

export default TicketPreview;
