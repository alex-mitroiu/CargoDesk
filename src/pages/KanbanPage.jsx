import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import mermaid from "mermaid";
import { T } from "../tokens";
import { inputBase } from "../components/primitives/Form";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import ActionMenu from "../components/primitives/ActionMenu";
import { Inp, Sel, Textarea } from "../components/primitives/Form";
import { CHANGELOG } from "../version";
import { toast } from "../toast";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLUMNS = ["Ready", "In Progress", "Done", "In Testing", "Testing Failed", "Ready to Deploy", "Released"];

const SECTIONS = [
  "General", "Shipments", "Dashboard", "Contracts", "Cost Control",
  "Vessels", "Port Locations", "Carriers", "Trade Lanes", "Countries",
  "UN Location Codes", "Customers", "API / Backend", "UI / UX", "Landing Page", "Kanban",
];

const LINK_TYPES = ["Relates to", "Blocks", "Duplicates", "Implements"];
const INVERSE_LABEL = { "Blocks": "Is blocked by", "Duplicates": "Is duplicated by", "Implements": "Is implemented by", "Relates to": "Relates to" };

// Epic and Story sit above the existing work-item types for nesting (Phase 3).
// They are listed first so the picker naturally groups them at the top.
const TYPES = ["Epic", "Story", "Feature", "Bug", "Improvement", "Task", "Chore"];

const TYPE_ICON = {
  Epic:        "⚡",
  Story:       "📖",
  Feature:     "✨",
  Bug:         "🦟",
  Improvement: "🔨",
  Task:        "☑",
  Chore:       "🔧",
};

const TYPE_VARIANT = {
  Epic:        "warning",
  Story:       "info",
  Feature:     "info",
  Bug:         "danger",
  Improvement: "success",
  Task:        "default",
  Chore:       "warning",
};

const PRIORITIES = ["Critical", "High", "Medium", "Low"];

const PRIORITY_VARIANT = {
  Critical: "danger", High: "warning", Medium: "info", Low: "default",
};

const PRIORITY_DOT = {
  Critical: T?.danger  || "#ef4444",
  High:     T?.warning || "#f59e0b",
  Medium:   T?.info    || "#3b82f6",
  Low:      T?.border  || "#6b7280",
};

const COL_ACCENT = {
  "Ready":          "#6366f1",
  "In Progress":    "#f59e0b",
  "Done":           "#22c55e",
  "In Testing":     "#06b6d4",
  "Testing Failed":  "#ef4444",
  "Ready to Deploy": "#f97316",
  "Released":        "#8b5cf6",
};

const PREVIEW_LIMIT = 5;

// Returns true when a due date string (YYYY-MM-DD) is strictly in the past.
const isOverdue = d => d && d < new Date().toISOString().slice(0, 10);

// Deterministic colour for an assignee avatar based on their user ID.
// Cycles through a fixed palette so the same person always gets the same colour.
const AVATAR_PALETTE = ["#6366f1","#f59e0b","#22c55e","#06b6d4","#ef4444","#8b5cf6","#ec4899","#14b8a6"];
const avatarColor = id => AVATAR_PALETTE[(id || "").split("").reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_PALETTE.length];

// ─── Mermaid Renderer ─────────────────────────────────────────────────────────
// Renders a Mermaid diagram definition to SVG client-side.
// Each instance uses a unique ID so concurrent renders don't collide.
// Re-mounts (via key) when the definition changes to avoid stale SVG.

const MermaidRenderer = ({ definition }) => {
  const [svg,   setSvg]   = useState("");
  const [error, setError] = useState(null);
  // Unique stable ID for this renderer instance
  const diagId = useRef(`mcd-${Math.random().toString(36).slice(2, 9)}`);

  useEffect(() => {
    let cancelled = false;
    setSvg("");
    setError(null);

    mermaid.initialize({
      startOnLoad: false,
      theme:       "dark",
      flowchart:   { curve: "basis", padding: 24, nodeSpacing: 48, rankSpacing: 64 },
      securityLevel: "loose",   // needed to allow <br/> in node labels
    });

    mermaid.render(diagId.current, definition)
      .then(({ svg: out }) => { if (!cancelled) setSvg(out); })
      .catch(e            => { if (!cancelled) setError(String(e)); });

    return () => { cancelled = true; };
  }, [definition]);

  if (error) return (
    <div style={{ padding: 20, fontFamily: T.mono, fontSize: 12, color: T.danger,
      background: `${T.danger}11`, borderRadius: 8, margin: 16 }}>
      ⚠ Diagram render error — check the definition syntax.<br />
      <span style={{ opacity: 0.7, fontSize: 11 }}>{error}</span>
    </div>
  );

  if (!svg) return (
    <div style={{ padding: 48, textAlign: "center", fontFamily: T.body,
      fontSize: 13, color: T.textMuted }}>
      Rendering diagram…
    </div>
  );

  return (
    <div dangerouslySetInnerHTML={{ __html: svg }}
      style={{ width: "100%", display: "flex", justifyContent: "center" }} />
  );
};

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

  // ── Hierarchy diagram definition ──────────────────────────────────────────
  const hierarchyDef = useMemo(() => {
    const lines = ["flowchart TD"];
    epicGroup.forEach(t => {
      const icon  = TYPE_ICON[t.type] || "📋";
      const label = t.title.length > 38 ? t.title.slice(0, 38) + "…" : t.title;
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
          edges.push({ from: t.id, to: l.otherTicketId, arrow, label: l.linkType.toLowerCase() });
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
      const label = t.title.length > 30 ? t.title.slice(0, 30) + "…" : t.title;
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

// ─── Epic Coverage Modal ──────────────────────────────────────────────────────
// Full-screen coverage analysis for an Epic: progress bar, phase cards (one per
// direct Story child), item rows for grandchildren, and a verdict block.

const DONE_COLS    = new Set(["Done", "Released", "Ready to Deploy"]);
const PARTIAL_COLS = new Set(["In Progress", "In Testing", "Testing Failed"]);
const coverStatus  = t => DONE_COLS.has(t.status) ? "done" : PARTIAL_COLS.has(t.status) ? "partial" : "todo";
const COVER_COLORS = { done: "#34d399", partial: "#fbbf24", todo: "#f87171" };
const COVER_LABELS = { done: "Done", partial: "In Progress", todo: "Not Started" };
const COVER_ICON   = { done: "✓", partial: "⚠", todo: "✗" };

const EpicCoverageModal = ({ ticket, allTickets, onClose, onPreview }) => {
  const descendants = useMemo(() => {
    const result = [], queue = [ticket.id], seen = new Set([ticket.id]);
    while (queue.length) {
      const pid = queue.shift();
      allTickets.filter(t => t.parentId === pid).forEach(t => {
        if (!seen.has(t.id)) { seen.add(t.id); result.push(t); queue.push(t.id); }
      });
    }
    return result;
  }, [ticket.id, allTickets]);

  const directChildren = descendants.filter(t => t.parentId === ticket.id);
  const phases    = directChildren.filter(t => ["Story", "Feature"].includes(t.type));
  const ungrouped = directChildren.filter(t => !["Story", "Feature"].includes(t.type));

  const phaseItems = phases.flatMap(p => descendants.filter(t => t.parentId === p.id));
  const countItems = phaseItems.length > 0 ? phaseItems : directChildren;
  const total = countItems.length;

  const doneCount    = countItems.filter(t => coverStatus(t) === "done").length;
  const partialCount = countItems.filter(t => coverStatus(t) === "partial").length;
  const todoCount    = countItems.filter(t => coverStatus(t) === "todo").length;
  const donePct      = total ? Math.round(doneCount    / total * 100) : 0;
  const partialPct   = total ? Math.round(partialCount / total * 100) : 0;
  const todoPct      = total ? Math.round(todoCount    / total * 100) : 0;

  const phaseRollup = p => {
    const kids = descendants.filter(t => t.parentId === p.id);
    if (kids.length === 0) return coverStatus(p);
    if (kids.every(t => coverStatus(t) === "done"))  return "done";
    if (kids.some(t  => coverStatus(t) !== "todo"))  return "partial";
    return "todo";
  };

  const outstanding = countItems.filter(t => coverStatus(t) === "todo");
  const inProgress  = countItems.filter(t => coverStatus(t) === "partial");

  const CoverPill = ({ cs }) => (
    <span style={{
      fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: ".06em",
      textTransform: "uppercase", borderRadius: 4, padding: "2px 8px", flexShrink: 0,
      background: `${COVER_COLORS[cs]}18`, color: COVER_COLORS[cs],
      border: `1px solid ${COVER_COLORS[cs]}44`,
    }}>{COVER_LABELS[cs]}</span>
  );

  const ItemRow = ({ kid, isLast }) => {
    const cs = coverStatus(kid);
    return (
      <div
        onClick={() => onPreview?.(kid)}
        style={{ display: "grid", gridTemplateColumns: "20px 108px 1fr auto",
          alignItems: "start", gap: "8px 10px", padding: "10px 16px",
          borderBottom: isLast ? "none" : `1px solid ${T.border}22`,
          cursor: onPreview ? "pointer" : "default", transition: "background .1s" }}
        onMouseEnter={e => { if (onPreview) e.currentTarget.style.background = T.surfaceHover; }}
        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
        <span style={{ fontSize: 12, marginTop: 2, textAlign: "center",
          color: COVER_COLORS[cs], fontWeight: 700 }}>{COVER_ICON[cs]}</span>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, paddingTop: 1 }}>{kid.id}</span>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.4 }}>{kid.title}</div>
          {kid.description && (
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 3,
              fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {kid.description.length > 110 ? kid.description.slice(0, 110) + "…" : kid.description}
            </div>
          )}
        </div>
        <CoverPill cs={cs} />
      </div>
    );
  };

  const PhaseCard = ({ phase }) => {
    const kids   = descendants.filter(t => t.parentId === phase.id);
    const rollup = phaseRollup(phase);
    return (
      <div style={{ background: T.bg, border: `1px solid ${T.border}`,
        borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10,
          padding: "11px 16px", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
          <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
            letterSpacing: ".1em", textTransform: "uppercase", color: T.textMuted, flexShrink: 0 }}>
            {phase.type}
          </span>
          <span onClick={() => onPreview?.(phase)}
            style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, flexShrink: 0,
              cursor: onPreview ? "pointer" : "default",
              textDecoration: onPreview ? "underline dotted" : "none" }}>
            {phase.id}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text,
            flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {phase.title}
          </span>
          <CoverPill cs={rollup} />
        </div>
        {kids.length === 0 ? (
          <div style={{ padding: "10px 16px", fontFamily: T.body, fontSize: 12,
            color: T.textMuted, fontStyle: "italic" }}>No sub-tasks.</div>
        ) : kids.map((kid, idx) => (
          <ItemRow key={kid.id} kid={kid} isLast={idx === kids.length - 1} />
        ))}
      </div>
    );
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10001,
      background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "min(92vw, 860px)", maxHeight: "90vh", background: T.surface,
        border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden",
        display: "flex", flexDirection: "column", boxShadow: "0 28px 80px rgba(0,0,0,.55)" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>📊</span>
            <div>
              <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
                {ticket.title}
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                {ticket.id} · Coverage analysis · {total} item{total !== 1 ? "s" : ""}
              </div>
            </div>
          </div>
          <button onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 22, lineHeight: 1, padding: "0 4px" }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 32px" }}>

          {/* Coverage bar */}
          {total > 0 && (
            <div style={{ background: T.bg, border: `1px solid ${T.border}`,
              borderRadius: 10, padding: "16px 20px", marginBottom: 24,
              display: "flex", alignItems: "center", gap: 20 }}>
              <div style={{ display: "flex", gap: 22, flexShrink: 0 }}>
                {[["done", doneCount, "Done"], ["partial", partialCount, "In Progress"], ["todo", todoCount, "Not Started"]].map(([s, n, lbl]) => (
                  <div key={s} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontFamily: T.mono, fontSize: 22, fontWeight: 800,
                      fontVariantNumeric: "tabular-nums", lineHeight: 1, color: COVER_COLORS[s] }}>{n}</span>
                    <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
                      letterSpacing: ".08em", textTransform: "uppercase", color: T.textMuted }}>{lbl}</span>
                  </div>
                ))}
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ height: 8, borderRadius: 4, background: T.border,
                  overflow: "hidden", display: "flex" }}>
                  <div style={{ width: `${donePct}%`,    background: COVER_COLORS.done    }} />
                  <div style={{ width: `${partialPct}%`, background: COVER_COLORS.partial }} />
                  <div style={{ width: `${todoPct}%`,    background: COVER_COLORS.todo    }} />
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  {[["done","Done"],["partial","In Progress"],["todo","Not Started"]].map(([s,lbl]) => (
                    <span key={s} style={{ display: "flex", alignItems: "center", gap: 4,
                      fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%",
                        background: COVER_COLORS[s], flexShrink: 0 }} />
                      {lbl}
                    </span>
                  ))}
                  <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 12,
                    fontWeight: 700, color: T.text }}>
                    {doneCount} / {total} · {donePct}%
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Phase cards */}
          {phases.map(phase => <PhaseCard key={phase.id} phase={phase} />)}

          {/* Ungrouped direct tasks */}
          {ungrouped.length > 0 && (
            <div style={{ background: T.bg, border: `1px solid ${T.border}`,
              borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10,
                padding: "11px 16px", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  letterSpacing: ".1em", textTransform: "uppercase", color: T.textMuted }}>Tasks</span>
                <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600,
                  color: T.text, flex: 1 }}>Direct tasks</span>
              </div>
              {ungrouped.map((kid, idx) => (
                <ItemRow key={kid.id} kid={kid} isLast={idx === ungrouped.length - 1} />
              ))}
            </div>
          )}

          {total === 0 && (
            <div style={{ textAlign: "center", padding: "60px 24px",
              fontFamily: T.body, fontSize: 14, color: T.textMuted, fontStyle: "italic" }}>
              This Epic has no child tickets yet.
            </div>
          )}

          {/* Verdict */}
          {total > 0 && (
            <div style={{ marginTop: 24, background: T.bg, border: `1px solid ${T.border}`,
              borderRadius: 10, overflow: "hidden" }}>
              <div style={{ background: T.surface, padding: "10px 16px",
                borderBottom: `1px solid ${T.border}`, fontFamily: T.mono,
                fontSize: 10, fontWeight: 700, letterSpacing: ".12em",
                textTransform: "uppercase", color: T.textMuted }}>
                Recommendation
              </div>
              <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                {doneCount === total ? (
                  <div style={{ display: "flex", gap: 10, alignItems: "baseline",
                    fontFamily: T.body, fontSize: 13, color: T.text }}>
                    <span style={{ color: T.textMuted, flexShrink: 0, fontSize: 15 }}>→</span>
                    <span>All {total} items are done.{" "}
                      <span style={{ color: T.success, fontWeight: 600 }}>
                        This Epic is complete — consider marking it as Released.
                      </span>
                    </span>
                  </div>
                ) : (
                  <>
                    {inProgress.length > 0 && (
                      <div style={{ display: "flex", gap: 10, alignItems: "baseline",
                        fontFamily: T.body, fontSize: 13, color: T.text }}>
                        <span style={{ color: T.textMuted, flexShrink: 0, fontSize: 15 }}>→</span>
                        <span>
                          <span style={{ color: T.warning, fontWeight: 600 }}>
                            {inProgress.length} item{inProgress.length !== 1 ? "s" : ""} in progress
                          </span>
                          {" — "}{inProgress.slice(0, 3).map(t => t.id).join(", ")}
                          {inProgress.length > 3 ? ` and ${inProgress.length - 3} more` : ""}.
                        </span>
                      </div>
                    )}
                    {outstanding.length > 0 && (
                      <div style={{ display: "flex", gap: 10, alignItems: "baseline",
                        fontFamily: T.body, fontSize: 13, color: T.text }}>
                        <span style={{ color: T.textMuted, flexShrink: 0, fontSize: 15 }}>→</span>
                        <span>
                          <span style={{ color: T.danger, fontWeight: 600 }}>
                            {outstanding.length} item{outstanding.length !== 1 ? "s" : ""} not yet started
                          </span>
                          {" — "}{outstanding.slice(0, 3).map(t => t.id).join(", ")}
                          {outstanding.length > 3 ? ` and ${outstanding.length - 3} more` : ""}.
                        </span>
                      </div>
                    )}
                    {phases.some(p => phaseRollup(p) === "done") && (
                      <div style={{ display: "flex", gap: 10, alignItems: "baseline",
                        fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
                        <span style={{ flexShrink: 0, fontSize: 15 }}>→</span>
                        <span>
                          {phases.filter(p => phaseRollup(p) === "done").length} phase
                          {phases.filter(p => phaseRollup(p) === "done").length !== 1 ? "s" : ""} fully
                          complete — remaining work is isolated to the other phases.
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Test Outcome Modal ───────────────────────────────────────────────────────
// Shown when a ticket leaves "In Testing". Forces an explicit Pass / Fail
// decision and captures optional (Pass) or mandatory (Fail) test notes before
// the ticket is routed to "Ready to Deploy" or "Testing Failed".

const TestOutcomeModal = ({ ticket, onConfirm, onCancel }) => {
  const [outcome, setOutcome] = useState(null);    // "pass" | "fail"
  const [notes,   setNotes]   = useState(ticket.testNotes || "");
  const [touched, setTouched] = useState(false);

  const notesRequired = outcome === "fail";
  const notesEmpty    = notes.trim() === "";
  const invalid       = notesRequired && notesEmpty;

  const submit = () => {
    setTouched(true);
    if (!outcome || invalid) return;
    onConfirm({
      newStatus: outcome === "pass" ? "Ready to Deploy" : "Testing Failed",
      testNotes: notes.trim() || null,
    });
  };

  const BTN_BASE = {
    flex: 1, padding: "18px 12px", borderRadius: 10, cursor: "pointer",
    fontFamily: T.head, fontSize: 15, fontWeight: 700, border: "2px solid",
    transition: "all .15s", display: "flex", flexDirection: "column",
    alignItems: "center", gap: 6,
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10002,
      background: "rgba(0,0,0,.7)", display: "flex", alignItems: "center",
      justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={{ width: "min(92vw, 460px)", background: T.surface,
        border: `1px solid ${T.border}`, borderRadius: 14,
        boxShadow: "0 28px 80px rgba(0,0,0,.6)", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text }}>
            Testing outcome
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 3 }}>
            <span style={{ fontFamily: T.mono, fontSize: 11 }}>{ticket.id}</span>
            {" · "}{ticket.title.length > 52 ? ticket.title.slice(0, 52) + "…" : ticket.title}
          </div>
        </div>

        <div style={{ padding: "20px 20px 0" }}>
          {/* Pass / Fail choice */}
          <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
            <button type="button" onClick={() => setOutcome("pass")} style={{
              ...BTN_BASE,
              background:   outcome === "pass" ? `${T.success}18` : "none",
              borderColor:  outcome === "pass" ? T.success : T.border,
              color:        outcome === "pass" ? T.success : T.textMuted,
            }}>
              <span style={{ fontSize: 28 }}>✅</span>
              <span>Pass</span>
              <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 400,
                color: outcome === "pass" ? T.success : T.textMuted, opacity: .8 }}>
                → Ready to Deploy
              </span>
            </button>

            <button type="button" onClick={() => setOutcome("fail")} style={{
              ...BTN_BASE,
              background:   outcome === "fail" ? `${T.danger}18` : "none",
              borderColor:  outcome === "fail" ? T.danger : T.border,
              color:        outcome === "fail" ? T.danger : T.textMuted,
            }}>
              <span style={{ fontSize: 28 }}>❌</span>
              <span>Fail</span>
              <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 400,
                color: outcome === "fail" ? T.danger : T.textMuted, opacity: .8 }}>
                → Testing Failed
              </span>
            </button>
          </div>

          {/* Notes field — always visible, mandatory label swaps on outcome */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600,
              color: (touched && invalid) ? T.danger : T.text,
              display: "block", marginBottom: 6 }}>
              {outcome === "fail" ? "Failure reason *" : "Test notes"}
              {outcome === "pass" && (
                <span style={{ fontWeight: 400, color: T.textMuted, marginLeft: 4 }}>(optional)</span>
              )}
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={outcome === "fail"
                ? "Describe what failed — steps to reproduce, error messages, environment…"
                : "Any notes about what was tested or verified…"}
              rows={4}
              style={{
                width: "100%", resize: "vertical", boxSizing: "border-box",
                fontFamily: T.body, fontSize: 13, color: T.text,
                background: T.bg, borderRadius: 7, padding: "9px 12px",
                border: `1px solid ${(touched && invalid) ? T.danger : T.border}`,
                outline: "none", lineHeight: 1.5,
              }}
            />
            {touched && invalid && (
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.danger, marginTop: 4 }}>
                A failure reason is required before marking as failed.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "0 20px 20px", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel}
            style={{ fontFamily: T.body, fontSize: 13, padding: "8px 18px",
              background: "none", border: `1px solid ${T.border}`, borderRadius: 7,
              color: T.textMuted, cursor: "pointer" }}>
            Cancel
          </button>
          <button type="button" onClick={submit}
            disabled={!outcome}
            style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700,
              padding: "8px 22px", borderRadius: 7, cursor: outcome ? "pointer" : "not-allowed",
              background: !outcome    ? T.border
                        : outcome === "pass" ? T.success : T.danger,
              border: "none", color: "#fff",
              opacity: !outcome ? 0.45 : 1,
              transition: "background .15s, opacity .15s" }}>
            {!outcome      ? "Select outcome"
             : outcome === "pass" ? "✅ Move to Ready to Deploy"
             :                      "❌ Move to Testing Failed"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Ticket Links Panel ───────────────────────────────────────────────────────

const TicketLinksPanel = ({ ticketId, allTickets = [] }) => {
  const [links,    setLinks]    = useState([]);
  const [adding,   setAdding]   = useState(false);
  const [search,   setSearch]   = useState("");
  const [linkType, setLinkType] = useState("Relates to");
  const [selected, setSelected] = useState(null);

  const load = () => api.tickets.links(ticketId).then(setLinks).catch(() => {});
  useEffect(() => { load(); }, [ticketId]);

  const linkedIds = new Set(links.map(l => l.otherTicketId));
  const candidates = search.trim().length > 1
    ? allTickets.filter(t =>
        t.id !== ticketId && !linkedIds.has(t.id) &&
        (t.id.toLowerCase().includes(search.toLowerCase()) ||
         t.title.toLowerCase().includes(search.toLowerCase()))
      ).slice(0, 6)
    : [];

  const handleAdd = async () => {
    if (!selected) return;
    try {
      await api.tickets.addLink(ticketId, { toId: selected.id, linkType });
      toast.success("Link added");
      setAdding(false); setSearch(""); setSelected(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleRemove = async linkId => {
    try {
      await api.tickets.removeLink(linkId);
      setLinks(l => l.filter(x => x.id !== linkId));
    } catch (e) { toast.error(e.message); }
  };

  const sectionLbl = { fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 };
  const inp = { fontFamily: T.body, fontSize: 12, color: T.text, background: T.bg,
    border: `1px solid ${T.border}`, borderRadius: 7, padding: "6px 10px",
    outline: "none", width: "100%", boxSizing: "border-box" };

  return (
    <div>
      <div style={sectionLbl}>Links</div>

      {links.map(l => (
        <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 8,
          padding: "5px 10px", marginBottom: 4, borderRadius: 6,
          background: T.bg, border: `1px solid ${T.border}` }}>
          <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
            background: T.surface, border: `1px solid ${T.border}`, borderRadius: 4,
            padding: "1px 6px", flexShrink: 0, whiteSpace: "nowrap" }}>
            {l.displayType}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, flexShrink: 0 }}>
            {l.otherTicketId}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {l.otherTicket?.title || ""}
          </span>
          <button onClick={() => handleRemove(l.id)} title="Remove link"
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0,
              transition: "color .12s" }}
            onMouseEnter={e => e.currentTarget.style.color = T.danger}
            onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
            ×
          </button>
        </div>
      ))}

      {links.length === 0 && !adding && (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic", marginBottom: 6 }}>
          No linked tickets.
        </div>
      )}

      {adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
          <input value={search}
            onChange={e => { setSearch(e.target.value); setSelected(null); }}
            placeholder="Search by ticket ID or title…" style={inp} autoFocus />
          {candidates.length > 0 && (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 7, overflow: "hidden" }}>
              {candidates.map((t, i) => (
                <div key={t.id}
                  onClick={() => { setSelected(t); setSearch(`${t.id} — ${t.title}`); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                    cursor: "pointer", borderBottom: i < candidates.length - 1 ? `1px solid ${T.border}22` : "none",
                    background: "transparent" }}
                  onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, flexShrink: 0 }}>{t.id}</span>
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.text,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select value={linkType} onChange={e => setLinkType(e.target.value)}
              style={{ ...inp, flex: 1, width: "auto" }}>
              {LINK_TYPES.map(lt => <option key={lt}>{lt}</option>)}
            </select>
            <Btn size="sm" disabled={!selected} onClick={handleAdd}>Link</Btn>
            <Btn size="sm" variant="secondary" onClick={() => { setAdding(false); setSearch(""); setSelected(null); }}>Cancel</Btn>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)}
          style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
            border: `1px dashed ${T.accent}55`, borderRadius: 6, padding: "5px 12px",
            cursor: "pointer", width: "100%", textAlign: "left", marginTop: links.length ? 6 : 0 }}>
          ＋ Link ticket
        </button>
      )}
    </div>
  );
};

// ─── Parent Picker Modal ──────────────────────────────────────────────────────
// Full-screen picker for selecting a parent Epic or Story.
// Supports free-text search across title + ID, and one-click type filtering.

const PARENT_TYPES = ["Epic", "Story"];

const ParentPickerModal = ({ tickets = [], excludeId, onSelect, onClose }) => {
  const [search,     setSearch]     = useState("");
  const [typeFilter, setTypeFilter] = useState(""); // "" = all, "Epic", "Story"

  const q = search.trim().toLowerCase();
  const results = tickets
    .filter(t =>
      t.id !== excludeId &&
      PARENT_TYPES.includes(t.type) &&
      (typeFilter === "" || t.type === typeFilter) &&
      (q.length === 0 ||
        t.id.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q))
    )
    .sort((a, b) => {
      // Epics first, then by status position, then alphabetical
      if (a.type !== b.type) return a.type === "Epic" ? -1 : 1;
      return a.title.localeCompare(b.title);
    });

  const btnBase = active => ({
    fontFamily: T.body, fontSize: 12, fontWeight: active ? 700 : 400,
    padding: "4px 12px", borderRadius: 6, cursor: "pointer", border: "none",
    background: active ? T.accent : T.surface,
    color:      active ? "#fff"   : T.textMuted,
    transition: "background .12s, color .12s",
  });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10000,
      background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: 560, maxHeight: "80vh", background: T.surface,
        border: `1px solid ${T.border}`, borderRadius: 14,
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "0 20px 60px rgba(0,0,0,.4)" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 18px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
            Select Parent Epic / Story
          </span>
          <button onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 20, lineHeight: 1, padding: "0 2px" }}>×</button>
        </div>

        {/* Search + type filter */}
        <div style={{ padding: "12px 18px", borderBottom: `1px solid ${T.border}`, flexShrink: 0,
          display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            autoFocus
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by type, ID, title, or keywords…"
            style={{ ...inputBase, fontFamily: T.body, fontSize: 13,
              width: "100%", boxSizing: "border-box" }} />
          <div style={{ display: "flex", gap: 6 }}>
            {["", ...PARENT_TYPES].map(t => (
              <button key={t} type="button"
                onClick={() => setTypeFilter(t)}
                style={btnBase(typeFilter === t)}>
                {t === "" ? "All" : `${TYPE_ICON[t]} ${t}`}
              </button>
            ))}
            <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 11,
              color: T.textMuted, alignSelf: "center" }}>
              {results.length} result{results.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>

        {/* Results list */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {results.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", fontFamily: T.body,
              fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
              No {typeFilter || "Epics or Stories"} match your search.
            </div>
          ) : results.map((t, i) => (
            <div key={t.id}
              onClick={() => { onSelect(t); onClose(); }}
              style={{ display: "flex", alignItems: "center", gap: 10,
                padding: "11px 18px", cursor: "pointer",
                borderBottom: i < results.length - 1 ? `1px solid ${T.border}22` : "none",
                transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>{TYPE_ICON[t.type] || "📋"}</span>
              <Badge variant={TYPE_VARIANT[t.type] || "default"}>{t.type}</Badge>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, flexShrink: 0 }}>
                {t.id}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 500,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.title}
                </div>
                {t.description && (
                  <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                    {t.description}
                  </div>
                )}
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
                background: T.bg, border: `1px solid ${T.border}`,
                borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>
                {t.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── Ticket Modal ─────────────────────────────────────────────────────────────

const TicketModal = ({ init = {}, shipments = [], tickets = [], users = [], onSave, onCancel }) => {
  const isEdit = !!init.id;
  const [f, setF] = useState({
    title:       init.title       || "",
    type:        init.type        || "Task",
    section:     init.section     || "General",
    description: init.description || "",
    priority:    init.priority    || "Medium",
    status:      init.status      || "Ready",
    shipmentId:  init.shipmentId  || "",
    version:     init.version     || "",
    assigneeId:  init.assigneeId  || "",
    dueDate:     init.dueDate     || "",
    parentId:    init.parentId    || "",   // ID of parent Epic/Story, or empty for top-level
  });
  const [showParentPicker, setShowParentPicker] = useState(false);
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const valid = f.title.trim().length > 0;

  const selectedParent = f.parentId ? tickets.find(t => t.id === f.parentId) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Inp label="Title" value={f.title} onChange={set("title")} placeholder="e.g. Wire VesselCombobox to ShipmentForm" required />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Sel label="Type" value={f.type} onChange={set("type")}
          options={TYPES.map(t => ({ value: t, label: `${TYPE_ICON[t]} ${t}` }))} />
        <Sel label="Section" value={f.section} onChange={set("section")}
          options={SECTIONS.map(s => ({ value: s, label: s }))} />
        <Sel label="Priority" value={f.priority} onChange={set("priority")}
          options={PRIORITIES.map(p => ({ value: p, label: p }))} />
      </div>

      {/* Assignee + Due date on one row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Sel label="Assignee" value={f.assigneeId} onChange={set("assigneeId")}
          options={[
            { value: "", label: "— Unassigned —" },
            ...users.filter(u => u.isActive !== false).map(u => ({ value: u.id, label: u.name })),
          ]}
        />
        {/* Native date input styled to match the design system */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".06em" }}>Due Date</label>
          <input type="date" value={f.dueDate} onChange={e => set("dueDate")(e.target.value)}
            style={{ ...inputBase, fontFamily: T.mono, fontSize: 13, cursor: "pointer",
              colorScheme: "dark" }} />
        </div>
      </div>

      {/* Parent Epic / Story — lookup button opens ParentPickerModal */}
      {f.type !== "Epic" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".06em" }}>
            Parent Epic / Story <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span>
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* Display chip when a parent is selected */}
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, minHeight: 36,
              background: T.bg, border: `1px solid ${selectedParent ? T.accent + "66" : T.border}`,
              borderRadius: 7, padding: "6px 12px" }}>
              {selectedParent ? (
                <>
                  <span style={{ fontSize: 15, flexShrink: 0 }}>{TYPE_ICON[selectedParent.type] || "📋"}</span>
                  <Badge variant={TYPE_VARIANT[selectedParent.type] || "default"}>{selectedParent.type}</Badge>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, flexShrink: 0 }}>
                    {selectedParent.id}
                  </span>
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selectedParent.title}
                  </span>
                  <button type="button" onClick={() => set("parentId")("")}
                    style={{ background: "none", border: "none", cursor: "pointer",
                      color: T.textMuted, fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
                    onMouseEnter={e => e.currentTarget.style.color = T.danger}
                    onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>×</button>
                </>
              ) : (
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.border, fontStyle: "italic" }}>
                  None — click 🔍 to search
                </span>
              )}
            </div>
            {/* Lookup button */}
            <button type="button" onClick={() => setShowParentPicker(true)}
              title="Search for a parent Epic or Story"
              style={{ background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 7,
                color: T.accent, cursor: "pointer", fontSize: 16, padding: "6px 12px",
                lineHeight: 1, flexShrink: 0, transition: "background .12s" }}
              onMouseEnter={e => e.currentTarget.style.background = `${T.accent}33`}
              onMouseLeave={e => e.currentTarget.style.background = T.accentBg}>
              🔍
            </button>
          </div>
        </div>
      )}

      {/* Parent picker modal — rendered outside the form to avoid z-index issues */}
      {showParentPicker && (
        <ParentPickerModal
          tickets={tickets}
          excludeId={init.id}
          onSelect={t => set("parentId")(t.id)}
          onClose={() => setShowParentPicker(false)}
        />
      )}

      <Sel label="Linked Shipment (optional)" value={f.shipmentId} onChange={set("shipmentId")}
        options={[
          { value: "", label: "— None —" },
          ...shipments.map(s => ({ value: s.id, label: `${s.id} · ${s.pol}→${s.pod} · ${s.carrierCode} (${s.status})` })),
        ]}
      />
      <Sel label="Version tag (optional)" value={f.version} onChange={set("version")}
        options={[
          { value: "", label: "— Untagged —" },
          ...CHANGELOG.map(c => ({ value: c.version, label: `v${c.version}${c.codename ? ` "${c.codename}"` : ""} · ${c.date}` })),
        ]}
      />
      <Textarea label="Description" value={f.description} onChange={set("description")}
        placeholder="What needs to be done, acceptance criteria, notes…" rows={4} />

      {isEdit && (
        <Sel label="Status" value={f.status} onChange={set("status")}
          options={COLUMNS.map(c => ({ value: c, label: c }))} />
      )}
      {isEdit && (
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <TicketLinksPanel ticketId={init.id} allTickets={tickets} />
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!valid} onClick={() => onSave(f)}>
          {isEdit ? "Save Changes" : "Create Ticket"}
        </Btn>
      </div>
    </div>
  );
};

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
                      allTickets = [] }) => {
  const { canEdit } = useAuth();
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
                  ? [{ icon: "↓", label: "Send to Backlog", onClick: () => onMove(ticket, "Backlog") }]
                  : []),
                { icon: "✎", label: "Edit", onClick: () => onEdit(ticket) },
                ...(ticket.type === "Epic"
                  ? [
                      { icon: "📊", label: "Coverage", onClick: () => onCoverage && onCoverage(ticket) },
                      { icon: "🗺", label: "Diagram",  onClick: () => onDiagram  && onDiagram(ticket)  },
                    ]
                  : []),
                { icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(true) },
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
        {canEdit && (colIndex > 0 || colIndex < COLUMNS.length - 1) && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 5,
          borderTop: `1px solid ${T.border}22`, paddingTop: 8 }}>
          {colIndex > 0 ? (
            <button onClick={stop(() => onMove(ticket, COLUMNS[colIndex - 1]))}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
                color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "2px 8px", fontFamily: T.body }}>
              ← {COLUMNS[colIndex - 1].split(" ")[0]}
            </button>
          ) : <span />}
          {colIndex < COLUMNS.length - 1 && (
            <button onClick={stop(() => onMove(ticket, COLUMNS[colIndex + 1]))}
              style={{ background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 4,
                color: T.accent, cursor: "pointer", fontSize: 11, padding: "2px 8px",
                fontFamily: T.body, fontWeight: 600 }}>
              {COLUMNS[colIndex + 1].split(" ")[0]} →
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

// ─── Ticket Preview Panel ─────────────────────────────────────────────────────

const TicketPreview = ({ ticket, colIndex, shipments, tickets, users, onClose, onEdit, onMove, onDelete, onPreview, onDiagram, onCoverage }) => {
  const { canEdit } = useAuth();
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
            color: COL_ACCENT[ticket.status], background: `${COL_ACCENT[ticket.status]}22`,
            border: `1px solid ${COL_ACCENT[ticket.status]}44`, borderRadius: 10, padding: "2px 10px" }}>
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
      borderTop: `3px solid ${COL_ACCENT[ticket.status]}`,
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
        <button onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer",
            color: T.textMuted, fontSize: 18, padding: "0 2px", lineHeight: 1 }}>×</button>
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
        display: "flex", gap: 6, flexShrink: 0 }}>
        {canEdit && !["Done", "Ready to Deploy", "Released", "Backlog"].includes(ticket.status) && (
          <button onClick={() => onMove(ticket, "Backlog")}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
              color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "5px 10px", fontFamily: T.body }}>
            ↓ Backlog
          </button>
        )}
        {canEdit && colIndex > 0 && (
          <button onClick={() => onMove(ticket, COLUMNS[colIndex - 1])}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
              color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "5px 10px", fontFamily: T.body }}>
            ← {COLUMNS[colIndex - 1].split(" ")[0]}
          </button>
        )}
        {ticket.type === "Epic" && (
          <button onClick={() => onCoverage?.(ticket)}
            style={{ background: "none", border: `1px solid ${T.accent}55`, borderRadius: 5,
              color: T.accent, cursor: "pointer", fontSize: 12, padding: "5px 10px", fontFamily: T.body }}>
            📊 Coverage
          </button>
        )}
        {ticket.type === "Epic" && (
          <button onClick={() => onDiagram?.(ticket)}
            style={{ background: "none", border: `1px solid ${T.accent}55`, borderRadius: 5,
              color: T.accent, cursor: "pointer", fontSize: 12, padding: "5px 10px", fontFamily: T.body }}>
            🗺 Diagram
          </button>
        )}
        {canEdit && (
          <button onClick={onEdit}
            style={{ flex: 1, background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 5,
              color: T.accent, cursor: "pointer", fontSize: 12, padding: "5px 10px",
              fontFamily: T.body, fontWeight: 600 }}>
            ✎ Edit
          </button>
        )}
        {canEdit && colIndex < COLUMNS.length - 1 && (
          <button onClick={() => onMove(ticket, COLUMNS[colIndex + 1])}
            style={{ background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 5,
              color: T.accent, cursor: "pointer", fontSize: 11, padding: "5px 10px",
              fontFamily: T.body, fontWeight: 600 }}>
            {COLUMNS[colIndex + 1].split(" ")[0]} →
          </button>
        )}
        {canEdit && (
          <button onClick={() => setConfirm(true)}
            style={{ background: "none", border: `1px solid ${T.danger}44`, borderRadius: 5,
              color: T.danger, cursor: "pointer", fontSize: 11, padding: "5px 10px", fontFamily: T.body }}>
            ✕
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

// ─── Kanban Column ────────────────────────────────────────────────────────────

const KanbanColumn = ({ status, tickets, allTickets, onEdit, onDelete, onMove, onPreview, onDiagram, onCoverage,
                        onDrop, colIndex, dragId, previewId, wipLimit, onSetWipLimit }) => {
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
        background: colDragOver ? `${COL_ACCENT[status]}11` : T.surface,
        border:     `1px solid ${colDragOver ? COL_ACCENT[status] : T.border}`,
        borderTop:  `3px solid ${COL_ACCENT[status]}`,
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
            color:      wipStatus ? WIP_BADGE_COLOR[wipStatus] : COL_ACCENT[status],
            background: wipStatus ? `${WIP_BADGE_COLOR[wipStatus]}22` : `${COL_ACCENT[status]}22`,
            border:     `1px solid ${wipStatus ? WIP_BADGE_COLOR[wipStatus] + "55" : COL_ACCENT[status] + "44"}`,
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
                color: wipLimit ? T.accent : T.border, fontSize: 13, lineHeight: 1,
                padding: "2px 4px", opacity: 0.7, transition: "opacity .15s, color .15s" }}
              onMouseEnter={e => e.currentTarget.style.opacity = "1"}
              onMouseLeave={e => e.currentTarget.style.opacity = "0.7"}>
              ⚙
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

// ─── Backlog Drawer ───────────────────────────────────────────────────────────

const BacklogDrawer = ({ tickets, onClose, onPromote, onEdit, onAdd }) => {
  const [sectionFilter, setSectionFilter] = useState("");
  const [search,        setSearch]        = useState("");

  const visible = tickets
    .filter(t => !sectionFilter || t.section === sectionFilter)
    .filter(t => !search || t.title.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const typeOrder = { Epic: 0, Story: 1, Feature: 2, Bug: 3, Improvement: 4, Task: 5, Chore: 6 };
      const pa = { Critical: 0, High: 1, Medium: 2, Low: 3 };
      return (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9)
          || (pa[a.priority] ?? 9) - (pa[b.priority] ?? 9);
    });

  // Close on Escape
  useEffect(() => {
    const h = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 400 }}
      />

      {/* Drawer panel */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0,
        width: 400, zIndex: 401,
        background: T.surface, borderLeft: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 32px rgba(0,0,0,.18)",
        animation: "slideInRight .18s ease-out",
      }}>
        <style>{`@keyframes slideInRight { from { transform: translateX(100%) } to { transform: translateX(0) } }`}</style>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 18px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div>
            <span style={{ fontFamily: T.head, fontSize: 16, fontWeight: 700, color: T.text }}>
              Backlog
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              color: T.accent, background: T.accent + "18",
              border: `1px solid ${T.accent}44`, borderRadius: 10,
              padding: "1px 8px", marginLeft: 10 }}>
              {tickets.length}
            </span>
          </div>
          <button onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 20, lineHeight: 1, padding: "0 4px" }}>
            ×
          </button>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 8, padding: "10px 18px",
          borderBottom: `1px solid ${T.border}22`, flexShrink: 0 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            style={{ flex: 1, fontFamily: T.body, fontSize: 12, background: T.bg,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "5px 10px",
              color: T.text, outline: "none" }}
          />
          <select
            value={sectionFilter}
            onChange={e => setSectionFilter(e.target.value)}
            style={{ fontFamily: T.body, fontSize: 12, background: T.bg,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "5px 8px",
              color: sectionFilter ? T.text : T.textMuted, cursor: "pointer", outline: "none" }}>
            <option value="">All sections</option>
            {SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* Ticket list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          {visible.length === 0 ? (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted,
              textAlign: "center", padding: "32px 18px", fontStyle: "italic" }}>
              {tickets.length === 0 ? "Backlog is empty" : "No tickets match the filter"}
            </div>
          ) : visible.map(t => (
            <div key={t.id} style={{
              display: "flex", alignItems: "flex-start", gap: 10,
              padding: "9px 18px", borderBottom: `1px solid ${T.border}11`,
              transition: "background .12s",
            }}
            onMouseEnter={e => e.currentTarget.style.background = T.bg}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>

              {/* Priority dot */}
              <div style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, marginTop: 5,
                background: PRIORITY_DOT[t.priority] || T.border }} />

              {/* Type + title */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span title={t.type} style={{ fontSize: 11 }}>{TYPE_ICON[t.type] || "📋"}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{t.id}</span>
                  {t.section && (
                    <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted,
                      background: T.border + "44", borderRadius: 4, padding: "0 5px" }}>
                      {t.section}
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.4,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={t.title}>
                  {t.title}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: 5, flexShrink: 0, alignItems: "center" }}>
                <button
                  onClick={() => onEdit(t)}
                  title="Edit"
                  style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
                    color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "3px 7px",
                    fontFamily: T.body, transition: "color .12s, border-color .12s" }}
                  onMouseEnter={e => { e.currentTarget.style.color = T.text; e.currentTarget.style.borderColor = T.text; }}
                  onMouseLeave={e => { e.currentTarget.style.color = T.textMuted; e.currentTarget.style.borderColor = T.border; }}>
                  ✎
                </button>
                <button
                  onClick={() => onPromote(t)}
                  title="Move to Ready"
                  style={{ background: T.accent + "18", border: `1px solid ${T.accent}55`,
                    borderRadius: 5, color: T.accent, cursor: "pointer",
                    fontSize: 11, padding: "3px 8px", fontFamily: T.body, fontWeight: 600,
                    transition: "background .12s" }}
                  onMouseEnter={e => e.currentTarget.style.background = T.accent + "30"}
                  onMouseLeave={e => e.currentTarget.style.background = T.accent + "18"}>
                  Ready →
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Footer — add to backlog */}
        <div style={{ padding: "12px 18px", borderTop: `1px solid ${T.border}`, flexShrink: 0 }}>
          <button
            onClick={onAdd}
            style={{ width: "100%", fontFamily: T.body, fontSize: 13, fontWeight: 600,
              color: T.accent, background: T.accent + "12",
              border: `1px dashed ${T.accent}55`, borderRadius: 8,
              padding: "9px 0", cursor: "pointer", transition: "background .12s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.accent + "22"}
            onMouseLeave={e => e.currentTarget.style.background = T.accent + "12"}>
            ＋ Add to Backlog
          </button>
        </div>
      </div>
    </>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

const KanbanPage = ({ shipments = [] }) => {
  const { canEdit } = useAuth();
  const [tickets,       setTickets]       = useState([]);
  const [users,         setUsers]         = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [modal,         setModal]         = useState(null);
  const [filter,        setFilter]        = useState({ priority: "", section: "", type: "", assigneeId: "" });
  const [dragId,        setDragId]        = useState(null);
  const [previewId,     setPreviewId]     = useState(null);
  const [showReleased,  setShowReleased]  = useState(true);
  const [backlogOpen,   setBacklogOpen]   = useState(false);

  // WIP limits are persisted to localStorage so they survive page refreshes.
  // Shape: { "Ready": 5, "In Progress": 3, ... } — columns without a limit are absent.
  const [diagramTicket,      setDiagramTicket]      = useState(null);
  const [coverageTicket,     setCoverageTicket]     = useState(null);
  const [testOutcomePending, setTestOutcomePending] = useState(null); // { ticket } waiting for outcome

  const [wipLimits, setWipLimits] = useState(() => {
    try { return JSON.parse(localStorage.getItem("cargodesk_wip_limits") || "{}"); }
    catch { return {}; }
  });

  const setWipLimit = (col, limit) => {
    setWipLimits(prev => {
      const next = { ...prev };
      if (limit == null) delete next[col]; else next[col] = limit;
      localStorage.setItem("cargodesk_wip_limits", JSON.stringify(next));
      return next;
    });
  };

  // Derive preview from live tickets so it reflects edits/moves automatically.
  const preview = previewId ? tickets.find(t => t.id === previewId) ?? null : null;

  const load = useCallback(async () => {
    setLoading(true);
    try { setTickets(await api.tickets.list()); } catch {}
    setLoading(false);
  }, []);

  // Users are loaded once — they change rarely and are only needed for the
  // assignee picker and filter dropdown.
  useEffect(() => {
    load();
    api.users.list().then(setUsers).catch(() => {});
  }, []);

  const byStatus = status => {
    let list = tickets.filter(t => t.status === status);
    if (filter.priority)   list = list.filter(t => t.priority   === filter.priority);
    if (filter.section)    list = list.filter(t => t.section    === filter.section);
    if (filter.type)       list = list.filter(t => t.type       === filter.type);
    if (filter.assigneeId) list = list.filter(t => t.assigneeId === filter.assigneeId);
    return list.sort((a, b) => a.position - b.position);
  };

  // Shared helper — executes a cross-column move, persisting testNotes when supplied.
  const commitMove = async (ticket, newStatus, testNotes = undefined) => {
    const colCards = tickets
      .filter(t => t.status === newStatus)
      .sort((a, b) => a.position - b.position);
    const newPos  = colCards.length > 0 ? colCards[colCards.length - 1].position + 1 : 0;
    const updated = {
      ...ticket,
      status:    newStatus,
      position:  newPos,
      // Only overwrite testNotes when we have a value to write (undefined = leave existing).
      ...(testNotes !== undefined ? { testNotes } : {}),
    };
    setTickets(prev => prev.map(t => t.id === ticket.id ? updated : t));
    await api.tickets.update(ticket.id, updated);
  };

  const handleDrop = async (ticketId, newStatus, targetId, side) => {
    const dragged = tickets.find(t => t.id === ticketId);
    if (!dragged) return;
    setDragId(null);

    // ── Cross-column move ──────────────────────────────────────────────────────
    if (dragged.status !== newStatus) {
      // Gate: leaving "In Testing" → show outcome modal instead of moving directly.
      if (dragged.status === "In Testing" &&
          (newStatus === "Ready to Deploy" || newStatus === "Testing Failed")) {
        setTestOutcomePending(dragged);
        return;
      }
      await commitMove(dragged, newStatus);
      return;
    }

    // ── Same-column reorder ────────────────────────────────────────────────────
    const col = tickets
      .filter(t => t.status === newStatus)
      .sort((a, b) => a.position - b.position);

    // Remove dragged card from its current position
    const without = col.filter(t => t.id !== ticketId);

    // Find insertion index
    let insertAt = without.length; // default: end
    if (targetId) {
      const targetIdx = without.findIndex(t => t.id === targetId);
      if (targetIdx !== -1) insertAt = side === "before" ? targetIdx : targetIdx + 1;
    }

    // Rebuild column order
    const reordered = [...without];
    reordered.splice(insertAt, 0, dragged);

    // Assign sequential positions
    const withPositions = reordered.map((t, i) => ({ ...t, position: i }));

    // Optimistic update
    setTickets(prev => {
      const other = prev.filter(t => t.status !== newStatus);
      return [...other, ...withPositions];
    });

    // Persist only changed positions
    const toSave = withPositions.filter(t => {
      const original = tickets.find(x => x.id === t.id);
      return original?.position !== t.position;
    });
    await Promise.all(toSave.map(t => api.tickets.update(t.id, t)));
  };

  const handleMove = async (ticket, newStatus) => {
    if (ticket.status === "In Testing" &&
        (newStatus === "Ready to Deploy" || newStatus === "Testing Failed")) {
      setTestOutcomePending(ticket);
      return;
    }
    await commitMove(ticket, newStatus);
  };

  const handleDelete = async id => {
    await api.tickets.remove(id);
    setTickets(p => p.filter(t => t.id !== id));
    setPreviewId(p => p === id ? null : p);
  };

  const handleTestOutcome = async ({ newStatus, testNotes }) => {
    const ticket = testOutcomePending;
    setTestOutcomePending(null);
    if (!ticket) return;
    await commitMove(ticket, newStatus, testNotes);
  };

  const handleSave = async form => {
    // Normalise empty strings to null so the server stores NULL in the DB.
    const payload = {
      ...form,
      assigneeId: form.assigneeId || null,
      dueDate:    form.dueDate    || null,
      parentId:   form.parentId   || null,
      testNotes:  form.testNotes  || null,
    };
    if (modal === "add" || modal === "add-backlog") {
      await api.tickets.create(payload);
    } else {
      await api.tickets.update(modal.id, { ...modal, ...payload });
    }
    setModal(null);
    load();
  };

  const totalOpen     = tickets.filter(t => !["Released", "Testing Failed", "Ready to Deploy", "Done"].includes(t.status)).length;
  const backlogTickets = tickets.filter(t => t.status === "Backlog").sort((a, b) => a.position - b.position);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, height: "100%" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>
            Integration Board
          </h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {tickets.length} ticket{tickets.length !== 1 ? "s" : ""} · {totalOpen} open
            {dragId && <span style={{ color: T.textMuted, fontStyle: "italic" }}> · dragging…</span>}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {/* Type filter */}
          <select value={filter.type} onChange={e => setFilter(f => ({ ...f, type: e.target.value }))}
            style={{ ...inputBase, fontFamily: T.body, fontSize: 13, width: 140, cursor: "pointer" }}>
            <option value="">All types</option>
            {TYPES.map(t => <option key={t} value={t}>{TYPE_ICON[t]} {t}</option>)}
          </select>
          {/* Priority filter */}
          <select value={filter.priority} onChange={e => setFilter(f => ({ ...f, priority: e.target.value }))}
            style={{ ...inputBase, fontFamily: T.body, fontSize: 13, width: 130, cursor: "pointer" }}>
            <option value="">All priorities</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          {/* Section filter */}
          <select value={filter.section} onChange={e => setFilter(f => ({ ...f, section: e.target.value }))}
            style={{ ...inputBase, fontFamily: T.body, fontSize: 13, width: 150, cursor: "pointer" }}>
            <option value="">All sections</option>
            {SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {/* Assignee filter — only shown when there are assigned users */}
          {users.length > 0 && (
            <select value={filter.assigneeId} onChange={e => setFilter(f => ({ ...f, assigneeId: e.target.value }))}
              style={{ ...inputBase, fontFamily: T.body, fontSize: 13, width: 150, cursor: "pointer" }}>
              <option value="">All assignees</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          <button
            type="button"
            onClick={() => setBacklogOpen(true)}
            style={{
              fontFamily: T.body, fontSize: 12, cursor: "pointer",
              padding: "5px 12px", borderRadius: 7, display: "flex", alignItems: "center", gap: 7,
              border: `1px solid ${backlogTickets.length > 0 ? T.accent + "88" : T.border}`,
              background: backlogTickets.length > 0 ? T.accent + "10" : "none",
              color: backlogTickets.length > 0 ? T.accent : T.textMuted,
              transition: "all .15s",
            }}>
            Backlog
            {backlogTickets.length > 0 && (
              <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                background: T.accent, color: "#fff",
                borderRadius: 10, padding: "0px 6px", lineHeight: "16px" }}>
                {backlogTickets.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setShowReleased(v => !v)}
            style={{
              fontFamily: T.body, fontSize: 12, cursor: "pointer",
              padding: "5px 12px", borderRadius: 7,
              border: `1px solid ${showReleased ? "#8b5cf6" : T.border}`,
              background: showReleased ? "rgba(139,92,246,.12)" : "none",
              color: showReleased ? "#8b5cf6" : T.textMuted,
              transition: "all .15s",
            }}>
            {showReleased ? "● Released" : "○ Released"}
          </button>
          {canEdit && <Btn onClick={() => setModal("add")} size="lg">＋ Add Ticket</Btn>}
        </div>
      </div>

      {/* Board + preview */}
      {loading ? (
        <div style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted, padding: 40, textAlign: "center" }}>
          Loading board…
        </div>
      ) : (
        <div style={{ display: "flex", gap: 14, flex: 1, minHeight: 0 }}>
          {/* Columns */}
          <div
            style={{ display: "flex", gap: 14, alignItems: "flex-start", overflowX: "auto", flex: 1, paddingBottom: 8 }}
            onDragEnd={() => setDragId(null)}
          >
            {COLUMNS.filter(col => showReleased || col !== "Released").map((col) => (
              <KanbanColumn
                key={col} status={col} colIndex={COLUMNS.indexOf(col)}
                tickets={byStatus(col)}
                allTickets={tickets}
                onEdit={t => setModal(t)}
                onDelete={handleDelete}
                onMove={handleMove}
                onDrop={handleDrop}
                onPreview={t => setPreviewId(p => p === t.id ? null : t.id)}
                onDiagram={t => setDiagramTicket(t)}
                onCoverage={t => setCoverageTicket(t)}
                dragId={dragId}
                previewId={previewId}
                wipLimit={wipLimits[col] ?? null}
                onSetWipLimit={limit => setWipLimit(col, limit)}
              />
            ))}
          </div>

          {/* Preview panel */}
          {preview && (
            <TicketPreview
              ticket={preview}
              colIndex={COLUMNS.indexOf(preview.status)}
              shipments={shipments}
              tickets={tickets}
              users={users}
              onClose={() => setPreviewId(null)}
              onEdit={() => setModal(preview)}
              onMove={handleMove}
              onDelete={handleDelete}
              onPreview={t => setPreviewId(t.id)}
              onDiagram={t => setDiagramTicket(t)}
              onCoverage={t => setCoverageTicket(t)}
            />
          )}
        </div>
      )}

      {backlogOpen && (
        <BacklogDrawer
          tickets={backlogTickets}
          onClose={() => setBacklogOpen(false)}
          onPromote={async t => { await commitMove(t, "Ready"); load(); }}
          onEdit={t => { setBacklogOpen(false); setModal(t); }}
          onAdd={() => { setBacklogOpen(false); setModal("add-backlog"); }}
        />
      )}

      {modal && (
        <Modal
          title={modal === "add" || modal === "add-backlog" ? "New Ticket" : `Edit — ${modal.id}`}
          onClose={() => setModal(null)} width={560}
        >
          <TicketModal
            init={modal === "add" ? {} : modal === "add-backlog" ? { status: "Backlog" } : modal}
            shipments={shipments}
            tickets={tickets}
            users={users}
            onSave={handleSave}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {coverageTicket && (
        <EpicCoverageModal
          ticket={coverageTicket}
          allTickets={tickets}
          onClose={() => setCoverageTicket(null)}
          onPreview={t => { setCoverageTicket(null); setPreviewId(t.id); }}
        />
      )}

      {diagramTicket && (
        <TicketDiagramModal
          ticket={diagramTicket}
          allTickets={tickets}
          onClose={() => setDiagramTicket(null)}
        />
      )}

      {testOutcomePending && (
        <TestOutcomeModal
          ticket={testOutcomePending}
          onConfirm={handleTestOutcome}
          onCancel={() => setTestOutcomePending(null)}
        />
      )}
    </div>
  );
};

export default KanbanPage;