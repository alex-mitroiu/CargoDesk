import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { SECTIONS, PRIORITY_DOT, TYPE_ICON } from "./constants";

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

export default BacklogDrawer;
