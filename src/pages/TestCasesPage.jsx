import { useState, useEffect, useMemo, useCallback } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { toast } from "../toast";
import Spinner from "../components/primitives/Spinner";

// ─── Status helpers ───────────────────────────────────────────────────────────

const TC_PASS    = new Set(["Done", "Ready to Deploy", "Released"]);
const TC_FAIL    = new Set(["Testing Failed"]);
const TC_BLOCKED = new Set(["Cancelled"]);
const TC_ACTIVE  = new Set(["In Testing", "In Progress"]);

const JIRA_COLOR = {
  "Pass":         "#22c55e",
  "Fail":         "#ef4444",
  "Blocked":      "#f97316",
  "In Progress":  "#3b82f6",
  "Not Executed": "#6b7280",
};

const PRIORITY_COLOR = { Critical: "#ef4444", High: "#f97316", Medium: "#3b82f6", Low: "#6b7280" };

const tcLabel = s =>
  TC_PASS.has(s) ? "Pass" : TC_FAIL.has(s) ? "Fail" :
  TC_BLOCKED.has(s) ? "Blocked" : TC_ACTIVE.has(s) ? "In Progress" : "Not Executed";
const tcColor = s => JIRA_COLOR[tcLabel(s)] ?? "#6b7280";

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TestCasesPage() {
  const { canEdit } = useAuth();
  const [tickets,    setTickets]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState("");
  const [navSel,     setNavSel]     = useState({ type: "all" });
  const [navOpen,    setNavOpen]    = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [statusFilt, setStatusFilt] = useState("");
  const [modal,      setModal]      = useState(null); // { kind: "folder"|"case", parentId? }
  const [saving,     setSaving]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setTickets(await api.tickets.list()); }
    catch { toast.error("Failed to load test cases"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const testFolders = useMemo(() => tickets.filter(t => t.type === "Test Folder"), [tickets]);
  const testPlans   = useMemo(() => tickets.filter(t => t.type === "Test Plan"),   [tickets]);
  const testRuns    = useMemo(() => tickets.filter(t => t.type === "Test Run"),    [tickets]);
  const testCases   = useMemo(() => tickets.filter(t => t.type === "Test Case"),   [tickets]);
  const folderIds   = useMemo(() => new Set(testFolders.map(f => f.id)), [testFolders]);
  const runIds      = useMemo(() => new Set(testRuns.map(r => r.id)),    [testRuns]);

  const toggleNav = key => setNavOpen(p => ({ ...p, [key]: p[key] === false }));

  // Collect all TC IDs under a subtree (folder or plan)
  const casesUnderFolder = useCallback(fid => {
    const childFolderIds = testFolders.filter(f => f.parentId === fid).map(f => f.id);
    const direct = testCases.filter(c => c.parentId === fid).map(c => c.id);
    return [...direct, ...childFolderIds.flatMap(casesUnderFolder)];
  }, [testFolders, testCases]);

  // Center panel: which TCs to show based on nav selection + filters
  const centerCases = useMemo(() => {
    let pool;
    if (navSel.type === "folder") {
      const ids = new Set(casesUnderFolder(navSel.id));
      pool = testCases.filter(c => ids.has(c.id));
    } else if (navSel.type === "run") {
      pool = testCases.filter(c => c.parentId === navSel.id);
    } else {
      pool = testCases;
    }

    const q = search.trim().toLowerCase();
    return pool.filter(c => {
      if (statusFilt && tcLabel(c.status) !== statusFilt) return false;
      if (q && !c.id.toLowerCase().includes(q) && !c.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [navSel, testCases, casesUnderFolder, search, statusFilt]);

  const selected = useMemo(() => tickets.find(t => t.id === selectedId) ?? null, [tickets, selectedId]);

  const execute = async (id, status) => {
    const t = tickets.find(x => x.id === id);
    if (!t) return;
    try {
      await api.tickets.update(id, { ...t, status });
      setTickets(p => p.map(x => x.id === id ? { ...x, status } : x));
    } catch { toast.error("Failed to update"); }
  };

  // ── Left nav helpers ────────────────────────────────────────────────────────

  const NavRow = ({ nodeKey, icon, label, badge, depth, selected: sel, onClick, onToggle, hasChildren, isOpen }) => (
    <div style={{ display: "flex", alignItems: "center" }}>
      <div onClick={onClick}
        style={{ display: "flex", alignItems: "center", gap: 4, flex: 1,
          padding: `3px 8px 3px ${8 + depth * 14}px`,
          borderRadius: 5, cursor: "pointer", userSelect: "none",
          background: sel ? T.accent + "22" : "transparent",
          color: sel ? T.accent : T.text,
          fontFamily: T.body, fontSize: 12, fontWeight: sel ? 600 : 400,
          borderLeft: sel ? `2px solid ${T.accent}` : "2px solid transparent" }}>
        {onToggle && (
          <span onClick={e => { e.stopPropagation(); onToggle(); }}
            style={{ fontSize: 9, color: T.textMuted, width: 10, flexShrink: 0, textAlign: "center" }}>
            {hasChildren ? (isOpen ? "▾" : "▸") : ""}
          </span>
        )}
        <span style={{ fontSize: 13, flexShrink: 0 }}>{icon}</span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        {badge != null && (
          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, flexShrink: 0 }}>{badge}</span>
        )}
      </div>
    </div>
  );

  const NavFolderNode = ({ folder, depth = 0 }) => {
    const childFolders = testFolders.filter(f => f.parentId === folder.id);
    const caseCount    = casesUnderFolder(folder.id).length;
    const isOpen       = navOpen[folder.id] !== false;
    const sel          = navSel.type === "folder" && navSel.id === folder.id;

    return (
      <div>
        <NavRow nodeKey={folder.id} icon="📁" label={folder.title} badge={caseCount}
          depth={depth} selected={sel}
          onClick={() => setNavSel({ type: "folder", id: folder.id })}
          onToggle={() => toggleNav(folder.id)}
          hasChildren={childFolders.length > 0} isOpen={isOpen} />
        {isOpen && childFolders.map(cf => <NavFolderNode key={cf.id} folder={cf} depth={depth + 1} />)}
      </div>
    );
  };

  const NavRunNode = ({ run, depth }) => {
    const count = testCases.filter(c => c.parentId === run.id).length;
    const sel   = navSel.type === "run" && navSel.id === run.id;
    return (
      <NavRow nodeKey={run.id} icon="🔄" label={run.title} badge={count}
        depth={depth} selected={sel}
        onClick={() => setNavSel({ type: "run", id: run.id })} />
    );
  };

  const rootFolders = testFolders.filter(f => !f.parentId || !folderIds.has(f.parentId));

  // ── Right panel ─────────────────────────────────────────────────────────────

  const ExecBtn = ({ label, title, color, onClick, active }) => {
    const [hov, setHov] = useState(false);
    return (
      <button title={title} onClick={onClick}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ flex: 1, padding: "6px 0", border: `1px solid ${active || hov ? color : T.border}`,
          borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
          background: active ? color + "22" : hov ? color + "11" : "transparent",
          color: active || hov ? color : T.textMuted,
          transition: "all .1s", fontFamily: T.body }}>
        {label}
      </button>
    );
  };

  const breadcrumb = tc => {
    if (!tc) return null;
    const parent = tickets.find(t => t.id === tc.parentId);
    if (!parent) return null;
    const grandparent = tickets.find(t => t.id === parent.parentId);
    return (
      <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
        {grandparent && <><span>{grandparent.title}</span><span style={{ margin: "0 4px", opacity: .5 }}>›</span></>}
        <span>{parent.title}</span>
      </span>
    );
  };

  // ── Status counts for filter chips ─────────────────────────────────────────

  const countsByLabel = useMemo(() => {
    let pool = testCases;
    if (navSel.type === "folder") { const ids = new Set(casesUnderFolder(navSel.id)); pool = testCases.filter(c => ids.has(c.id)); }
    else if (navSel.type === "run")    { pool = testCases.filter(c => c.parentId === navSel.id); }
    const q = search.trim().toLowerCase();
    if (q) pool = pool.filter(c => c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
    return Object.fromEntries(
      Object.keys(JIRA_COLOR).map(lbl => [lbl, pool.filter(c => tcLabel(c.status) === lbl).length])
    );
  }, [navSel, testCases, casesUnderFolder, search]);

  const saveTicket = async (form, editId) => {
    setSaving(true);
    try {
      if (editId) {
        const existing = tickets.find(t => t.id === editId);
        const updated  = await api.tickets.update(editId, { ...existing, ...form });
        setTickets(p => p.map(t => t.id === editId ? updated : t));
      } else {
        const created = await api.tickets.create({ status: "Ready", ...form });
        setTickets(p => [...p, created]);
        if (form.type === "Test Case") setSelectedId(created.id);
      }
      setModal(null);
    } catch { toast.error(editId ? "Failed to save" : "Failed to create"); }
    finally { setSaving(false); }
  };

  const deleteTicket = async id => {
    if (!window.confirm("Delete this test case? This cannot be undone.")) return;
    try {
      await api.tickets.remove(id);
      setTickets(p => p.filter(t => t.id !== id));
      if (selectedId === id) setSelectedId(null);
      toast.success("Deleted");
    } catch { toast.error("Failed to delete"); }
  };

  // ── Create / Edit modal ─────────────────────────────────────────────────────

  const TicketFormModal = () => {
    const { kind, parentId: initParent, editTicket } = modal;
    const isEdit   = !!editTicket;
    const isFolder = kind === "folder";

    const [title,    setTitle]    = useState(editTicket?.title    ?? "");
    const [priority, setPriority] = useState(editTicket?.priority ?? "Medium");
    const [notes,    setNotes]    = useState(editTicket?.testNotes    ?? "");
    const [desc,     setDesc]     = useState(editTicket?.description  ?? "");
    const [parentId, setParentId] = useState(editTicket?.parentId ?? initParent ?? "");

    const inp = { fontFamily: T.body, fontSize: 13, color: T.text, background: T.bg,
      border: `1px solid ${T.border}`, borderRadius: 7, padding: "7px 10px",
      outline: "none", width: "100%", boxSizing: "border-box" };
    const lbl = txt => (
      <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
        textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>{txt}</div>
    );

    const handleSubmit = e => {
      e.preventDefault();
      if (!title.trim()) return;
      saveTicket({
        type: isFolder ? "Test Folder" : "Test Case",
        title: title.trim(),
        parentId: parentId || null,
        ...(isFolder ? {} : { priority, testNotes: notes.trim() || null, description: desc.trim() || null }),
      }, editTicket?.id ?? null);
    };

    const heading = isEdit
      ? (isFolder ? "Edit Folder" : "Edit Test Case")
      : (isFolder ? "New Test Folder" : "New Test Case");

    return (
      <div style={{ position: "fixed", inset: 0, background: "#00000055", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 12, padding: "24px 24px 20px", width: 480,
          boxShadow: "0 8px 32px #0006", fontFamily: T.body }}>

          <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 18 }}>{heading}</div>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              {lbl("Title")}
              <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
                placeholder={isFolder ? "Folder name…" : "Test case title…"}
                style={inp} />
            </div>

            {/* Parent selector */}
            <div>
              {lbl(isFolder ? "Parent folder" : "Parent folder or cycle")}
              <select value={parentId} onChange={e => setParentId(e.target.value)} style={{ ...inp, cursor: "pointer" }}>
                <option value="">None (root)</option>
                {testFolders.map(f => <option key={f.id} value={f.id}>📁 {f.title}</option>)}
                {!isFolder && testRuns.map(r => <option key={r.id} value={r.id}>🔄 {r.title}</option>)}
              </select>
            </div>

            {/* Test case–only fields */}
            {!isFolder && (
              <>
                <div>
                  {lbl("Priority")}
                  <select value={priority} onChange={e => setPriority(e.target.value)} style={{ ...inp, cursor: "pointer" }}>
                    {["Critical", "High", "Medium", "Low"].map(p => <option key={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  {lbl("Description")}
                  <textarea value={desc} onChange={e => setDesc(e.target.value)}
                    placeholder="What is this test case verifying?"
                    rows={2} style={{ ...inp, resize: "vertical" }} />
                </div>
                <div>
                  {lbl("Test Steps")}
                  <textarea value={notes} onChange={e => setNotes(e.target.value)}
                    placeholder={"1. Navigate to…\n2. Click…\n3. Verify…"}
                    rows={4} style={{ ...inp, resize: "vertical", fontFamily: T.mono, fontSize: 12 }} />
                </div>
              </>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button type="button" onClick={() => setModal(null)}
                style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, background: "none",
                  border: `1px solid ${T.border}`, borderRadius: 7, padding: "7px 16px", cursor: "pointer" }}>
                Cancel
              </button>
              <button type="submit" disabled={saving || !title.trim()}
                style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: "#fff",
                  background: title.trim() ? T.accent : T.border, border: "none",
                  borderRadius: 7, padding: "7px 18px", cursor: title.trim() ? "pointer" : "default",
                  transition: "background .15s" }}>
                {saving ? "Saving…" : isEdit ? "Save Changes" : isFolder ? "Create Folder" : "Create Test Case"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: T.textMuted }}>
      <Spinner size="md" />
    </div>
  );

  return (
    <>
    <div style={{ display: "flex", height: "100%", overflow: "hidden", fontFamily: T.body }}>

      {/* ── Panel 1: folder / plan tree ───────────────────────────────────── */}
      <div style={{ width: 220, flexShrink: 0, background: T.bg,
        borderRight: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column", overflowY: "auto", overflowX: "hidden" }}>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 8px 6px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700,
            letterSpacing: ".07em", textTransform: "uppercase", color: T.textMuted }}>
            Test Cases
          </span>
          {canEdit && (
            <button onClick={() => setModal({ kind: "folder", parentId: navSel.type === "folder" ? navSel.id : null })}
              title="New Test Folder"
              style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted,
                fontSize: 15, lineHeight: 1, padding: "0 2px", fontFamily: T.body }}>＋</button>
          )}
        </div>

        {/* All root */}
        <div onClick={() => setNavSel({ type: "all" })}
          style={{ display: "flex", alignItems: "center", gap: 5,
            padding: "5px 8px 5px 10px", cursor: "pointer", userSelect: "none",
            borderRadius: 5, margin: "4px 4px 2px",
            background: navSel.type === "all" ? T.accent + "22" : "transparent",
            color: navSel.type === "all" ? T.accent : T.text,
            fontFamily: T.body, fontSize: 12, fontWeight: navSel.type === "all" ? 600 : 400,
            borderLeft: navSel.type === "all" ? `2px solid ${T.accent}` : "2px solid transparent" }}>
          <span style={{ fontSize: 13 }}>📂</span>
          <span>All Test Cases</span>
          <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 9, color: T.textMuted }}>
            {testCases.length}
          </span>
        </div>

        <div style={{ padding: "0 4px", flex: 1 }}>
          {rootFolders.map(f => <NavFolderNode key={f.id} folder={f} />)}
          {testRuns.length > 0 && (
            <>
              <div style={{ padding: "8px 8px 3px", fontFamily: T.body, fontSize: 10,
                fontWeight: 700, color: T.textMuted, letterSpacing: ".07em",
                textTransform: "uppercase" }}>Cycles</div>
              {testRuns.map(r => <NavRunNode key={r.id} run={r} depth={0} />)}
            </>
          )}
        </div>
      </div>

      {/* ── Panel 2: TC list ──────────────────────────────────────────────── */}
      <div style={{ width: 0, flex: "0 0 380px", display: "flex", flexDirection: "column",
        borderRight: `1px solid ${T.border}`, overflow: "hidden", minWidth: 0 }}>

        {/* Search + status chips */}
        <div style={{ padding: "10px 12px 8px", borderBottom: `1px solid ${T.border}`,
          flexShrink: 0, display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search…"
              style={{ flex: 1, minWidth: 0, fontFamily: T.body, fontSize: 12,
                color: T.text, background: T.surface, border: `1px solid ${T.border}`,
                borderRadius: 6, padding: "5px 9px", outline: "none" }} />
            {canEdit && (
              <button
                onClick={() => setModal({ kind: "case", parentId: navSel.type === "folder" ? navSel.id : navSel.type === "run" ? navSel.id : null })}
                title="New Test Case"
                style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600,
                  color: T.accent, background: T.accent + "18",
                  border: `1px solid ${T.accent}44`, borderRadius: 6,
                  padding: "5px 10px", cursor: "pointer", whiteSpace: "nowrap" }}>
                ＋ New TC
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {Object.entries(JIRA_COLOR).map(([lbl, col]) => {
              const n = countsByLabel[lbl] ?? 0;
              const active = statusFilt === lbl;
              return (
                <span key={lbl} onClick={() => setStatusFilt(p => p === lbl ? "" : lbl)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 3,
                    padding: "2px 7px", borderRadius: 10, cursor: "pointer", userSelect: "none",
                    background: active ? col + "30" : col + "14",
                    border: `1px solid ${active ? col : col + "44"}`,
                    fontFamily: T.mono, fontSize: 9, color: col, fontWeight: 600 }}>
                  {n} {lbl}
                </span>
              );
            })}
          </div>
        </div>

        {/* TC rows */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {centerCases.length === 0 ? (
            <div style={{ padding: "40px 16px", textAlign: "center", fontSize: 12,
              color: T.textMuted, fontStyle: "italic" }}>
              {testCases.length === 0 ? "No test cases yet." : "Nothing matches your filters."}
            </div>
          ) : centerCases.map(c => {
            const isSel = selectedId === c.id;
            const col   = tcColor(c.status);
            const run   = testRuns.find(r => r.id === c.parentId);
            const plan  = testPlans.find(p => p.id === run?.parentId);
            const folder = testFolders.find(f => f.id === c.parentId);
            return (
              <div key={c.id} onClick={() => setSelectedId(isSel ? null : c.id)}
                style={{ padding: "9px 12px", borderBottom: `1px solid ${T.border}22`,
                  cursor: "pointer", userSelect: "none",
                  background: isSel ? T.accent + "14" : "transparent",
                  borderLeft: isSel ? `3px solid ${T.accent}` : "3px solid transparent",
                  transition: "background .12s" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                  {/* Status dot */}
                  <span style={{ width: 8, height: 8, borderRadius: "50%",
                    background: col, flexShrink: 0 }} />
                  {/* Priority */}
                  {c.priority && (
                    <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                      color: PRIORITY_COLOR[c.priority] ?? T.textMuted, flexShrink: 0 }}>
                      {c.priority.toUpperCase()}
                    </span>
                  )}
                  {/* ID */}
                  <span style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, flexShrink: 0 }}>
                    {c.id}
                  </span>
                  <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 9,
                    color: col, fontWeight: 600, flexShrink: 0 }}>
                    {tcLabel(c.status)}
                  </span>
                </div>
                {/* Title */}
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.text,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  marginBottom: 2 }}>{c.title}</div>
                {/* Breadcrumb */}
                <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {folder ? `📁 ${folder.title}` :
                    plan && run ? `🧪 ${plan.title} › 🔄 ${run.title}` :
                    run ? `🔄 ${run.title}` : "—"}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer count */}
        <div style={{ padding: "5px 12px", borderTop: `1px solid ${T.border}`,
          fontFamily: T.mono, fontSize: 9, color: T.textMuted, background: T.bg, flexShrink: 0 }}>
          {centerCases.length} of {testCases.length} test cases
        </div>
      </div>

      {/* ── Panel 3: TC detail / preview ──────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column",
        minWidth: 0, overflow: "hidden", background: T.surface }}>
        {!selected ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", height: "100%", gap: 10, color: T.textMuted }}>
            <span style={{ fontSize: 36 }}>🔍</span>
            <span style={{ fontFamily: T.body, fontSize: 13 }}>Select a test case to preview</span>
          </div>
        ) : (
          <>
            {/* Detail header */}
            <div style={{ padding: "14px 20px 12px", borderBottom: `1px solid ${T.border}`,
              background: T.bg, flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                {/* Status pill */}
                <span style={{ padding: "2px 9px", borderRadius: 4, fontSize: 11, fontWeight: 700,
                  fontFamily: T.mono, background: tcColor(selected.status) + "20",
                  color: tcColor(selected.status), border: `1px solid ${tcColor(selected.status)}44`,
                  flexShrink: 0 }}>
                  {tcLabel(selected.status)}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{selected.id}</span>
                {selected.priority && (
                  <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                    color: PRIORITY_COLOR[selected.priority] ?? T.textMuted }}>
                    {selected.priority}
                  </span>
                )}
                {/* Edit / Delete */}
                {canEdit && (
                  <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    <button
                      onClick={() => setModal({ kind: "case", editTicket: selected })}
                      style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted,
                        background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
                        padding: "3px 10px", cursor: "pointer" }}>
                      ✎ Edit
                    </button>
                    <button
                      onClick={() => deleteTicket(selected.id)}
                      style={{ fontFamily: T.body, fontSize: 11, color: T.danger,
                        background: "none", border: `1px solid ${T.danger}44`, borderRadius: 5,
                        padding: "3px 10px", cursor: "pointer" }}>
                      ✕ Delete
                    </button>
                  </div>
                )}
              </div>

              {/* Title */}
              <div style={{ fontFamily: T.body, fontSize: 15, fontWeight: 700, color: T.text,
                marginBottom: 6, lineHeight: 1.35 }}>{selected.title}</div>

              {/* Breadcrumb */}
              <div style={{ marginBottom: 10 }}>{breadcrumb(selected)}</div>

              {/* Execution buttons */}
              {canEdit && (
                <div style={{ display: "flex", gap: 6 }}>
                  <ExecBtn label="✓ Pass"    color={JIRA_COLOR.Pass}            active={TC_PASS.has(selected.status)}    onClick={() => execute(selected.id, "Done")}          title="Mark as Passed" />
                  <ExecBtn label="✗ Fail"    color={JIRA_COLOR.Fail}            active={TC_FAIL.has(selected.status)}    onClick={() => execute(selected.id, "Testing Failed")} title="Mark as Failed" />
                  <ExecBtn label="⊘ Block"   color={JIRA_COLOR.Blocked}         active={TC_BLOCKED.has(selected.status)} onClick={() => execute(selected.id, "Cancelled")}      title="Mark as Blocked" />
                  <ExecBtn label="⟳ Reset"   color={JIRA_COLOR["Not Executed"]} active={false}                           onClick={() => execute(selected.id, "Ready")}          title="Reset to Not Executed" />
                </div>
              )}
            </div>

            {/* Detail body */}
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>

              {/* Assignee */}
              {selected.assigneeName && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: ".07em",
                    color: T.textMuted, marginBottom: 4 }}>Assignee</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ width: 24, height: 24, borderRadius: "50%",
                      background: T.accent + "33", color: T.accent,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontFamily: T.mono, fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                      {selected.assigneeInitial ?? selected.assigneeName[0]}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>
                      {selected.assigneeName}
                    </span>
                  </div>
                </div>
              )}

              {/* Description */}
              {selected.description && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: ".07em",
                    color: T.textMuted, marginBottom: 6 }}>Description</div>
                  <div style={{ fontFamily: T.body, fontSize: 13, color: T.text,
                    lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{selected.description}</div>
                </div>
              )}

              {/* Test Notes / Steps */}
              {selected.testNotes ? (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: ".07em",
                    color: T.textMuted, marginBottom: 6 }}>Test Steps</div>
                  <div style={{ fontFamily: T.body, fontSize: 13, color: T.text,
                    lineHeight: 1.7, whiteSpace: "pre-wrap",
                    background: T.bg, border: `1px solid ${T.border}`,
                    borderRadius: 7, padding: "10px 14px" }}>{selected.testNotes}</div>
                </div>
              ) : (
                !selected.description && (
                  <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted,
                    fontStyle: "italic", marginBottom: 16 }}>
                    No description or test steps added yet.
                  </div>
                )
              )}

              {/* Meta row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
                {selected.version && (
                  <div>
                    <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
                      textTransform: "uppercase", letterSpacing: ".07em",
                      color: T.textMuted, marginBottom: 3 }}>Version</div>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{selected.version}</span>
                  </div>
                )}
                {selected.dueDate && (
                  <div>
                    <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
                      textTransform: "uppercase", letterSpacing: ".07em",
                      color: T.textMuted, marginBottom: 3 }}>Due</div>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{selected.dueDate}</span>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>

    {modal && <TicketFormModal />}
    </>
  );
}
