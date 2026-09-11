import { useMemo } from "react";
import { T } from "../../tokens";

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

export default EpicCoverageModal;
