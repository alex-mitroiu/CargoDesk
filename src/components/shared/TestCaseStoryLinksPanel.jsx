import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";

// ─── Test Case ↔ Story Links Panel ────────────────────────────────────────────
// Fixed relationship, no type selector: a Test Case "Tests" a Story.
// Shared between KanbanPage's Tests tab and the standalone TestCasesPage.

const TestCaseStoryLinksPanel = ({ caseId, tickets = [] }) => {
  const [links,    setLinks]    = useState([]);
  const [adding,   setAdding]   = useState(false);
  const [search,   setSearch]   = useState("");
  const [selected, setSelected] = useState(null);

  const load = () => api.testItems.storyLinks(caseId).then(setLinks).catch(() => {});
  useEffect(() => { load(); }, [caseId]);

  const linkedIds = new Set(links.map(l => l.ticketId));
  const stories = tickets.filter(t => t.type === "Story");
  const candidates = search.trim().length > 1
    ? stories.filter(t =>
        !linkedIds.has(t.id) &&
        (t.id.toLowerCase().includes(search.toLowerCase()) ||
         t.title.toLowerCase().includes(search.toLowerCase()))
      ).slice(0, 6)
    : [];

  const handleAdd = async () => {
    if (!selected) return;
    try {
      await api.testItems.addStoryLink(caseId, { ticketId: selected.id });
      toast.success("Linked to story");
      setAdding(false); setSearch(""); setSelected(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleRemove = async linkId => {
    try {
      await api.testItems.removeStoryLink(linkId);
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
      <div style={sectionLbl}>Tests (Story)</div>

      {links.map(l => (
        <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 8,
          padding: "5px 10px", marginBottom: 4, borderRadius: 6,
          background: T.bg, border: `1px solid ${T.border}` }}>
          <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
            background: T.surface, border: `1px solid ${T.border}`, borderRadius: 4,
            padding: "1px 6px", flexShrink: 0, whiteSpace: "nowrap" }}>
            Tests
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, flexShrink: 0 }}>
            {l.ticketId}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {l.ticket?.title || ""}
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
          Not linked to a story yet.
        </div>
      )}

      {adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
          <input value={search}
            onChange={e => { setSearch(e.target.value); setSelected(null); }}
            placeholder="Search stories by ID or title…" style={inp} autoFocus />
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
            <Btn size="sm" disabled={!selected} onClick={handleAdd}>Link</Btn>
            <Btn size="sm" variant="secondary" onClick={() => { setAdding(false); setSearch(""); setSelected(null); }}>Cancel</Btn>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)}
          style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
            border: `1px dashed ${T.accent}55`, borderRadius: 6, padding: "5px 12px",
            cursor: "pointer", width: "100%", textAlign: "left", marginTop: links.length ? 6 : 0 }}>
          ＋ Link to Story
        </button>
      )}
    </div>
  );
};

export default TestCaseStoryLinksPanel;
