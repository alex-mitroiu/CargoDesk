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

const tcLabel = s =>
  TC_PASS.has(s) ? "Pass" : TC_FAIL.has(s) ? "Fail" :
  TC_BLOCKED.has(s) ? "Blocked" : TC_ACTIVE.has(s) ? "In Progress" : "Not Executed";

const tcColor = s => JIRA_COLOR[tcLabel(s)] ?? "#6b7280";

const runStats = cases => {
  const passed  = cases.filter(c => TC_PASS.has(c.status)).length;
  const failed  = cases.filter(c => TC_FAIL.has(c.status)).length;
  const blocked = cases.filter(c => TC_BLOCKED.has(c.status)).length;
  const active  = cases.filter(c => TC_ACTIVE.has(c.status)).length;
  return { passed, failed, blocked, active,
    pending: cases.length - passed - failed - blocked - active,
    total: cases.length };
};

// ─── Shared primitives ────────────────────────────────────────────────────────

const SegBar = ({ stats, width = 80 }) => {
  if (!stats.total) return null;
  return (
    <div style={{ width, height: 6, borderRadius: 3, overflow: "hidden",
      display: "flex", flexShrink: 0, background: T.border }}>
      {[[stats.passed, JIRA_COLOR.Pass], [stats.failed, JIRA_COLOR.Fail],
        [stats.blocked, JIRA_COLOR.Blocked], [stats.active, JIRA_COLOR["In Progress"]],
        [stats.pending, "#374151"]].map(([n, col], i) => n > 0 && (
        <div key={i} style={{ height: "100%", flex: n, background: col }} />
      ))}
    </div>
  );
};

const Chip = ({ count, color, label }) => count === 0 ? null : (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 3,
    padding: "2px 7px", borderRadius: 10,
    background: color + "18", border: `1px solid ${color}44`,
    fontFamily: T.mono, fontSize: 10, color, fontWeight: 600, flexShrink: 0 }}>
    {count} {label}
  </span>
);

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TestPlansPage() {
  const { canEdit } = useAuth();
  const [tickets,     setTickets]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [search,      setSearch]      = useState("");
  const [navSel,      setNavSel]      = useState({ type: "all" });
  const [collapsed,   setCollapsed]   = useState({});   // right-panel expand/collapse
  const [navOpen,     setNavOpen]     = useState({});   // left-nav expand/collapse
  const [dragCase,    setDragCase]    = useState(null);
  const [dropRunId,   setDropRunId]   = useState(null);
  const [highlightId, setHighlightId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setTickets(await api.testItems.list()); }
    catch { toast.error("Failed to load test plans"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const testFolders = useMemo(() => tickets.filter(t => t.type === "Test Folder"), [tickets]);
  const testPlans   = useMemo(() => tickets.filter(t => t.type === "Test Plan"),   [tickets]);
  const testRuns    = useMemo(() => tickets.filter(t => t.type === "Test Run"),    [tickets]);
  const testCases   = useMemo(() => tickets.filter(t => t.type === "Test Case"),   [tickets]);
  const folderIds   = useMemo(() => new Set(testFolders.map(f => f.id)), [testFolders]);

  const q = search.trim().toLowerCase();
  const caseMatches = c => !q || c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q);
  const toggleRight = id => setCollapsed(p => ({ ...p, [id]: !p[id] }));
  const toggleNav   = key => setNavOpen(p => ({ ...p, [key]: p[key] === false })); // default open

  const visiblePlans = useMemo(() => {
    if (navSel.type === "plan") return testPlans.filter(p => p.id === navSel.id);
    if (navSel.type === "folder") {
      const collect = fid => {
        const kids = testFolders.filter(f => f.parentId === fid).map(f => f.id);
        return [fid, ...kids.flatMap(collect)];
      };
      const fids = new Set(collect(navSel.id));
      return testPlans.filter(p => fids.has(p.parentId));
    }
    return testPlans;
  }, [navSel, testPlans, testFolders]);

  const scrollToCase = id => {
    setHighlightId(id);
    // ensure the plan/run containing this case is expanded first
    const tc = testCases.find(c => c.id === id);
    if (tc?.parentId) setCollapsed(p => ({ ...p, [tc.parentId]: false }));
    const run = testRuns.find(r => r.id === tc?.parentId);
    if (run?.parentId) setCollapsed(p => ({ ...p, [run.parentId]: false }));
    setTimeout(() => {
      document.getElementById(`tc-row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 80);
    setTimeout(() => setHighlightId(null), 2200);
  };

  const execute = async (id, status) => {
    const t = tickets.find(x => x.id === id);
    if (!t) return;
    try {
      await api.testItems.update(id, { ...t, status });
      setTickets(p => p.map(x => x.id === id ? { ...x, status } : x));
    } catch { toast.error("Failed to update"); }
  };

  const moveCase = async (id, newParentId) => {
    const t = tickets.find(x => x.id === id);
    if (!t) return;
    try {
      await api.testItems.update(id, { ...t, parentId: newParentId });
      setTickets(p => p.map(x => x.id === id ? { ...x, parentId: newParentId } : x));
    } catch { toast.error("Failed to move"); }
  };

  // ── Right-panel sub-components ─────────────────────────────────────────────

  const ExecBtn = ({ label, title, color, onClick, active }) => {
    const [hov, setHov] = useState(false);
    return (
      <button title={title} onClick={onClick}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ width: 22, height: 22, border: `1px solid ${active || hov ? color : T.border}`,
          borderRadius: 4, cursor: "pointer", fontSize: 11, background:
            active ? color + "22" : hov ? color + "11" : "transparent",
          color: active || hov ? color : T.textMuted,
          transition: "all .1s", padding: 0, display: "flex",
          alignItems: "center", justifyContent: "center", fontFamily: T.mono }}>
        {label}
      </button>
    );
  };

  const CaseRow = ({ c, depth = 0 }) => {
    const [hov, setHov] = useState(false);
    const isHL = highlightId === c.id;
    const col  = tcColor(c.status);
    return (
      <div id={`tc-row-${c.id}`}
        draggable={!!canEdit}
        onDragStart={e => { e.stopPropagation(); setDragCase({ id: c.id, parentId: c.parentId }); }}
        onDragEnd={() => { setDragCase(null); setDropRunId(null); }}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ display: "flex", alignItems: "center", gap: 8,
          padding: `5px 12px 5px ${12 + depth * 20}px`,
          borderBottom: `1px solid ${T.border}11`,
          background: isHL ? T.accent + "18" : hov ? T.border + "18" : "transparent",
          transition: "background .15s" }}>
        <span style={{ color: hov ? T.textMuted : "transparent", fontSize: 11, cursor: "grab", flexShrink: 0 }}>⠿</span>
        <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600,
          fontFamily: T.mono, background: col + "18", color: col, border: `1px solid ${col}33`,
          flexShrink: 0 }}>{tcLabel(c.status)}</span>
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, flexShrink: 0 }}>{c.id}</span>
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
        {canEdit && hov && (
          <div style={{ display: "flex", gap: 3, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
            <ExecBtn label="✓" title="Pass"    color={JIRA_COLOR.Pass}            onClick={() => execute(c.id, "Done")}          active={TC_PASS.has(c.status)} />
            <ExecBtn label="✗" title="Fail"    color={JIRA_COLOR.Fail}            onClick={() => execute(c.id, "Testing Failed")} active={TC_FAIL.has(c.status)} />
            <ExecBtn label="⊘" title="Blocked" color={JIRA_COLOR.Blocked}         onClick={() => execute(c.id, "Cancelled")}      active={TC_BLOCKED.has(c.status)} />
            <ExecBtn label="⟳" title="Reset"   color={JIRA_COLOR["Not Executed"]} onClick={() => execute(c.id, "Ready")}         active={false} />
          </div>
        )}
      </div>
    );
  };

  const RunBlock = ({ run, depth = 1 }) => {
    const cases   = testCases.filter(c => c.parentId === run.id);
    const visible = cases.filter(caseMatches);
    const stats   = runStats(cases);
    const isOpen  = collapsed[run.id] !== true;
    const isDrop  = dropRunId === run.id;
    return (
      <div style={{ borderBottom: `1px solid ${T.border}22`,
        background: isDrop ? T.accent + "08" : "transparent", transition: "background .1s" }}
        onDragOver={e => { if (dragCase && dragCase.parentId !== run.id) { e.preventDefault(); setDropRunId(run.id); } }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropRunId(null); }}
        onDrop={e => { e.preventDefault(); if (dragCase) { moveCase(dragCase.id, run.id); setDragCase(null); setDropRunId(null); } }}>
        <div onClick={() => toggleRight(run.id)}
          style={{ display: "flex", alignItems: "center", gap: 8,
            padding: `7px 12px 7px ${12 + (depth - 1) * 20}px`, cursor: "pointer", userSelect: "none" }}>
          <span style={{ fontSize: 10, color: T.textMuted, flexShrink: 0 }}>{isOpen ? "▾" : "▸"}</span>
          <span style={{ fontSize: 12, flexShrink: 0 }}>🔄</span>
          <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text, flex: 1 }}>{run.title}</span>
          <SegBar stats={stats} width={60} />
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, flexShrink: 0 }}>
            {stats.passed}/{stats.total}
          </span>
        </div>
        {isOpen && visible.map(c => <CaseRow key={c.id} c={c} depth={depth + 1} />)}
        {isOpen && visible.length === 0 && cases.length > 0 && (
          <div style={{ padding: `4px 12px 4px ${12 + depth * 20}px`, fontFamily: T.body,
            fontSize: 11, color: T.textMuted, fontStyle: "italic" }}>No cases match search.</div>
        )}
      </div>
    );
  };

  const PlanBlock = ({ plan }) => {
    const runs        = testRuns.filter(r => r.parentId === plan.id);
    const directCases = testCases.filter(c => c.parentId === plan.id);
    const allCases    = [...testCases.filter(c => runs.some(r => r.id === c.parentId)), ...directCases];
    const stats       = runStats(allCases);
    const isOpen      = collapsed[plan.id] !== true;
    const pct         = stats.total > 0 ? Math.round(stats.passed / stats.total * 100) : 0;
    return (
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        overflow: "hidden", marginBottom: 12 }}>
        <div onClick={() => toggleRight(plan.id)}
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px",
            background: T.bg, borderBottom: isOpen ? `1px solid ${T.border}` : "none",
            cursor: "pointer", userSelect: "none" }}>
          <span style={{ fontSize: 10, color: T.textMuted, flexShrink: 0 }}>{isOpen ? "▾" : "▸"}</span>
          <span style={{ fontSize: 14, flexShrink: 0 }}>🧪</span>
          <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text, flex: 1 }}>{plan.title}</span>
          {stats.total > 0 && (
            <>
              <SegBar stats={stats} width={80} />
              <Chip count={stats.passed}  color={JIRA_COLOR.Pass}    label="Pass" />
              <Chip count={stats.failed}  color={JIRA_COLOR.Fail}    label="Fail" />
              <Chip count={stats.blocked} color={JIRA_COLOR.Blocked} label="Blocked" />
              <span style={{ fontFamily: T.mono, fontSize: 10,
                color: pct === 100 ? JIRA_COLOR.Pass : T.textMuted }}>
                {pct === 100 ? "✓ All Passed" : `${pct}%`}
              </span>
            </>
          )}
        </div>
        {isOpen && (
          <div>
            {runs.map(r => <RunBlock key={r.id} run={r} depth={1} />)}
            {directCases.filter(caseMatches).map(c => <CaseRow key={c.id} c={c} depth={1} />)}
            {runs.length === 0 && directCases.length === 0 && (
              <div style={{ padding: "10px 16px", fontFamily: T.body, fontSize: 12,
                color: T.textMuted, fontStyle: "italic" }}>No test cycles yet.</div>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Left nav (FolderTree) ──────────────────────────────────────────────────

  const navRow = (key, onClick, selected, depth, icon, label, badge) => (
    <div onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 4,
        padding: `3px 8px 3px ${8 + depth * 14}px`,
        borderRadius: 5, cursor: "pointer", userSelect: "none",
        background: selected ? T.accent + "22" : "transparent",
        color: selected ? T.accent : T.text,
        fontFamily: T.body, fontSize: 12, fontWeight: selected ? 600 : 400,
        borderLeft: selected ? `2px solid ${T.accent}` : "2px solid transparent" }}>
      <span style={{ fontSize: 13, flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {badge != null && (
        <span style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, flexShrink: 0 }}>{badge}</span>
      )}
    </div>
  );

  const NavRunNode = ({ run, depth }) => {
    const cases  = testCases.filter(c => c.parentId === run.id);
    const stats  = runStats(cases);
    const isOpen = navOpen[`run-${run.id}`] !== false;
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 4,
          padding: `3px 8px 3px ${8 + depth * 14}px`,
          fontFamily: T.body, fontSize: 11.5, color: T.text, cursor: "pointer" }}
          onClick={() => toggleNav(`run-${run.id}`)}>
          <span style={{ fontSize: 10, color: T.textMuted, width: 12, flexShrink: 0 }}>
            {cases.length > 0 ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span style={{ fontSize: 11, flexShrink: 0 }}>🔄</span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{run.title}</span>
          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, flexShrink: 0 }}>
            {stats.passed}/{stats.total}
          </span>
        </div>
        {isOpen && cases.map(tc => (
          <div key={tc.id}
            onClick={() => { setNavSel({ type: "all" }); scrollToCase(tc.id); }}
            style={{ display: "flex", alignItems: "center", gap: 5,
              padding: `2px 8px 2px ${8 + (depth + 1) * 14}px`,
              cursor: "pointer", borderRadius: 4, userSelect: "none" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%",
              background: tcColor(tc.status), flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{tc.title}</span>
          </div>
        ))}
      </div>
    );
  };

  const NavPlanNode = ({ plan, depth }) => {
    const sel    = navSel.type === "plan" && navSel.id === plan.id;
    const runs   = testRuns.filter(r => r.parentId === plan.id);
    const isOpen = navOpen[`plan-${plan.id}`] !== false;
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 4,
          padding: `3px 8px 3px ${8 + depth * 14}px`,
          borderRadius: 5, cursor: "pointer", userSelect: "none",
          background: sel ? T.accent + "22" : "transparent",
          color: sel ? T.accent : T.text,
          fontFamily: T.body, fontSize: 12, fontWeight: sel ? 600 : 400,
          borderLeft: sel ? `2px solid ${T.accent}` : "2px solid transparent" }}>
          <span onClick={e => { e.stopPropagation(); toggleNav(`plan-${plan.id}`); }}
            style={{ fontSize: 10, color: T.textMuted, width: 12, flexShrink: 0 }}>
            {runs.length > 0 ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span style={{ fontSize: 12, flexShrink: 0 }}
            onClick={() => setNavSel({ type: "plan", id: plan.id })}>🧪</span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            onClick={() => setNavSel({ type: "plan", id: plan.id })}>{plan.title}</span>
        </div>
        {isOpen && runs.map(r => <NavRunNode key={r.id} run={r} depth={depth + 1} />)}
      </div>
    );
  };

  const NavFolderNode = ({ folder, depth = 0 }) => {
    const sel          = navSel.type === "folder" && navSel.id === folder.id;
    const isOpen       = navOpen[folder.id] !== false;
    const childFolders = testFolders.filter(f => f.parentId === folder.id);
    const plansHere    = testPlans.filter(p => p.parentId === folder.id);
    const hasChildren  = childFolders.length > 0 || plansHere.length > 0;
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 4,
          padding: `4px 8px 4px ${8 + depth * 14}px`,
          borderRadius: 5, cursor: "pointer", userSelect: "none",
          background: sel ? T.accent + "22" : "transparent",
          color: sel ? T.accent : T.text,
          fontFamily: T.body, fontSize: 12, fontWeight: sel ? 600 : 400,
          borderLeft: sel ? `2px solid ${T.accent}` : "2px solid transparent" }}>
          <span onClick={e => { e.stopPropagation(); toggleNav(folder.id); }}
            style={{ fontSize: 10, color: T.textMuted, width: 12, flexShrink: 0 }}>
            {hasChildren ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span style={{ fontSize: 13, flexShrink: 0 }}
            onClick={() => setNavSel({ type: "folder", id: folder.id })}>📁</span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            onClick={() => setNavSel({ type: "folder", id: folder.id })}>{folder.title}</span>
        </div>
        {isOpen && (
          <div>
            {childFolders.map(cf => <NavFolderNode key={cf.id} folder={cf} depth={depth + 1} />)}
            {plansHere.map(p => <NavPlanNode key={p.id} plan={p} depth={depth + 1} />)}
          </div>
        )}
      </div>
    );
  };

  const rootFolders  = testFolders.filter(f => !f.parentId || !folderIds.has(f.parentId));
  const unfiledPlans = testPlans.filter(p => !p.parentId || !folderIds.has(p.parentId));

  const totalPass    = testCases.filter(c => TC_PASS.has(c.status)).length;
  const totalFail    = testCases.filter(c => TC_FAIL.has(c.status)).length;
  const totalBlocked = testCases.filter(c => TC_BLOCKED.has(c.status)).length;
  const totalActive  = testCases.filter(c => TC_ACTIVE.has(c.status)).length;
  const totalNotRun  = testCases.length - totalPass - totalFail - totalBlocked - totalActive;

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: T.textMuted }}>
      <Spinner size="md" />
    </div>
  );

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden", fontFamily: T.body }}>

      {/* ── Left nav ──────────────────────────────────────────────────────── */}
      <div style={{ width: 230, flexShrink: 0, background: T.bg,
        borderRight: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column", overflowY: "auto", overflowX: "hidden" }}>

        <div style={{ padding: "12px 8px 6px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700,
            letterSpacing: ".07em", textTransform: "uppercase", color: T.textMuted }}>
            Test Plans
          </span>
        </div>

        {/* All Tests root */}
        <div onClick={() => setNavSel({ type: "all" })}
          style={{ display: "flex", alignItems: "center", gap: 5,
            padding: "5px 8px 5px 10px", cursor: "pointer", userSelect: "none",
            borderRadius: 5, margin: "4px 4px 2px",
            background: navSel.type === "all" ? T.accent + "22" : "transparent",
            color: navSel.type === "all" ? T.accent : T.text,
            fontFamily: T.body, fontSize: 12, fontWeight: navSel.type === "all" ? 600 : 400,
            borderLeft: navSel.type === "all" ? `2px solid ${T.accent}` : "2px solid transparent" }}>
          <span style={{ fontSize: 13 }}>📂</span>
          <span>All Tests</span>
          <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
            {testCases.length}
          </span>
        </div>

        <div style={{ padding: "0 4px", flex: 1 }}>
          {rootFolders.map(f => <NavFolderNode key={f.id} folder={f} />)}
          {unfiledPlans.map(p => <NavPlanNode key={p.id} plan={p} depth={0} />)}
        </div>
      </div>

      {/* ── Right panel ───────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>

        {/* Toolbar */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0,
          padding: "10px 16px", borderBottom: `1px solid ${T.border}`, flexWrap: "wrap" }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search test cases…"
            style={{ flex: 1, minWidth: 140, fontFamily: T.body, fontSize: 13, color: T.text,
              background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7,
              padding: "6px 10px", outline: "none" }} />
          <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
            <Chip count={totalPass}    color={JIRA_COLOR.Pass}            label="Pass" />
            <Chip count={totalFail}    color={JIRA_COLOR.Fail}            label="Fail" />
            <Chip count={totalBlocked} color={JIRA_COLOR.Blocked}         label="Blocked" />
            <Chip count={totalActive}  color={JIRA_COLOR["In Progress"]}  label="In Progress" />
            <Chip count={totalNotRun}  color={JIRA_COLOR["Not Executed"]} label="Not Executed" />
            {testCases.length > 0 && (
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>/ {testCases.length}</span>
            )}
          </div>
        </div>

        {/* Plan tree */}
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px" }}>
          {visiblePlans.length === 0 ? (
            <div style={{ padding: "48px 0", textAlign: "center", fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
              {navSel.type === "all" ? "No test plans yet." : "No plans in this selection."}
            </div>
          ) : (
            visiblePlans.map(plan => <PlanBlock key={plan.id} plan={plan} />)
          )}
        </div>
      </div>
    </div>
  );
}
