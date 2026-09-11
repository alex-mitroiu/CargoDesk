import { useState, useEffect, useMemo } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import MermaidRenderer from "./MermaidRenderer";
import { TYPE_ICON } from "./constants";

// ─── Ticket Diagram Modal ─────────────────────────────────────────────────────
// Shows two views for an Epic:
//   Hierarchy  — parent → child tree for all descendants
//   Dependencies — directed graph of Blocks / Implements / etc. links within the epic
// Links are fetched in parallel on open; the hierarchy renders immediately from props.

const TicketDiagramModal = ({ ticket, allTickets, onClose }) => {
  const [links,       setLinks]       = useState({});   // ticketId → link[]
  const [linksLoaded, setLinksLoaded] = useState(false);
  const [view,        setView]        = useState("hierarchy");

  // Collect all descendants of this Epic recursively (breadth-first).
  const descendants = useMemo(() => {
    const result = [], queue = [ticket.id], seen = new Set([ticket.id]);
    while (queue.length) {
      const pid = queue.shift();
      allTickets
        .filter(t => t.parentId === pid)
        .forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); result.push(t); queue.push(t.id); } });
    }
    return result;
  }, [ticket.id, allTickets]);

  const epicGroup = useMemo(() => [ticket, ...descendants], [ticket, descendants]);

  // Fetch links for every ticket in the group in parallel.
  useEffect(() => {
    Promise.all(epicGroup.map(t =>
      api.tickets.links(t.id)
        .then(ls => ({ id: t.id, ls }))
        .catch(()  => ({ id: t.id, ls: [] }))
    )).then(results => {
      const map = {};
      results.forEach(r => { map[r.id] = r.ls; });
      setLinks(map);
      setLinksLoaded(true);
    });
  }, [ticket.id]);   // re-fetch only when the root ticket changes

  // Safe Mermaid node ID — hyphens are not allowed.
  const sid = id => id.replace(/-/g, "_");

  // Escape user-controlled text (ticket titles, link types) before it goes into a
  // quoted Mermaid label — otherwise a `"` in a title breaks out of the label string
  // and injects raw Mermaid syntax (e.g. a `click id "javascript:..."` directive),
  // which then renders unsanitized via dangerouslySetInnerHTML in MermaidRenderer.
  const escLabel = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // ── Hierarchy diagram definition ──────────────────────────────────────────
  const hierarchyDef = useMemo(() => {
    const lines = ["flowchart TD"];
    epicGroup.forEach(t => {
      const icon  = TYPE_ICON[t.type] || "📋";
      const label = escLabel(t.title.length > 38 ? t.title.slice(0, 38) + "…" : t.title);
      const done  = ["Done", "Ready to Deploy", "Released"].includes(t.status);
      // Different node shapes: Epic = stadium, Story = rect, others = rounded rect
      const [o, c] = t.type === "Epic"  ? (["([", "])"])
                   : t.type === "Story" ? (["[",  "]" ])
                   :                      (["(",  ")" ]);
      lines.push(`  ${sid(t.id)}${o}"${icon} ${t.id}\\n${label}"${c}`);
      if (done) lines.push(`  style ${sid(t.id)} opacity:0.55`);
    });
    descendants.forEach(t => {
      if (t.parentId) lines.push(`  ${sid(t.parentId)} --> ${sid(t.id)}`);
    });
    return lines.join("\n");
  }, [epicGroup, descendants]);

  // ── Dependency diagram definition ─────────────────────────────────────────
  const dependencyDef = useMemo(() => {
    if (!linksLoaded) return "flowchart LR\n  loading[\"⏳ Loading links…\"]";

    const epicIds = new Set(epicGroup.map(t => t.id));
    const edges   = [];

    epicGroup.forEach(t => {
      (links[t.id] || [])
        .filter(l => l.direction === "out" && epicIds.has(l.otherTicketId))
        .forEach(l => {
          const arrow = l.linkType === "Blocks"     ? "-->"
                      : l.linkType === "Implements" ? "-..->"
                      : l.linkType === "Duplicates" ? "==>"
                      :                               "--->";
          edges.push({ from: t.id, to: l.otherTicketId, arrow, label: escLabel(l.linkType.toLowerCase()) });
        });
    });

    if (edges.length === 0) return (
      "flowchart LR\n  none[\"No dependency links between\\ntickets in this Epic\"]"
    );

    const involvedIds = new Set(edges.flatMap(e => [e.from, e.to]));
    const lines = ["flowchart LR"];
    [...involvedIds].forEach(id => {
      const t     = epicGroup.find(e => e.id === id);
      if (!t) return;
      const icon  = TYPE_ICON[t.type] || "📋";
      const label = escLabel(t.title.length > 30 ? t.title.slice(0, 30) + "…" : t.title);
      lines.push(`  ${sid(id)}["${icon} ${id}\\n${label}"]`);
    });
    edges.forEach(e =>
      lines.push(`  ${sid(e.from)} ${e.arrow}|"${e.label}"| ${sid(e.to)}`)
    );
    return lines.join("\n");
  }, [linksLoaded, links, epicGroup]);

  const currentDef = view === "hierarchy" ? hierarchyDef : dependencyDef;

  const TAB_BTN = active => ({
    fontFamily: T.body, fontSize: 13, fontWeight: active ? 700 : 400,
    padding: "10px 20px", background: "none", border: "none", cursor: "pointer",
    color:       active ? T.accent    : T.textMuted,
    borderBottom: active ? `2px solid ${T.accent}` : "2px solid transparent",
    transition: "color .12s",
  });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10001,
      background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "min(92vw, 900px)", maxHeight: "88vh", background: T.surface,
        border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden",
        display: "flex", flexDirection: "column", boxShadow: "0 28px 80px rgba(0,0,0,.55)" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>🏔</span>
            <div>
              <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
                {ticket.title}
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                {ticket.id} · {epicGroup.length} ticket{epicGroup.length !== 1 ? "s" : ""}
              </div>
            </div>
          </div>
          <button onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 22, lineHeight: 1, padding: "0 4px" }}>×</button>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", alignItems: "center",
          borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <button type="button" onClick={() => setView("hierarchy")} style={TAB_BTN(view === "hierarchy")}>
            🌳 Hierarchy
          </button>
          <button type="button" onClick={() => setView("dependencies")} style={TAB_BTN(view === "dependencies")}>
            🔗 Dependencies
          </button>
          {!linksLoaded && view === "dependencies" && (
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted,
              marginLeft: 8, fontStyle: "italic" }}>
              loading links…
            </span>
          )}
        </div>

        {/* Diagram canvas — key forces MermaidRenderer to remount on view/def change */}
        <div style={{ flex: 1, overflowY: "auto", overflowX: "auto",
          background: T.bg, padding: 16, display: "flex", justifyContent: "center" }}>
          <MermaidRenderer key={currentDef} definition={currentDef} />
        </div>
      </div>
    </div>
  );
};

export default TicketDiagramModal;
