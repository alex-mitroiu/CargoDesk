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

const SegBar = ({ stats, width = 120 }) => {
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

export default function TestRunsPage() {
  const { canEdit } = useAuth();
  const [tickets,   setTickets]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState("");
  const [planFilt,  setPlanFilt]  = useState("");
  const [collapsed, setCollapsed] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try { setTickets(await api.testItems.list()); }
    catch { toast.error("Failed to load test runs"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const testPlans = useMemo(() => tickets.filter(t => t.type === "Test Plan"), [tickets]);
  const testRuns  = useMemo(() => tickets.filter(t => t.type === "Test Run"),  [tickets]);
  const testCases = useMemo(() => tickets.filter(t => t.type === "Test Case"), [tickets]);

  const q = search.trim().toLowerCase();
  const toggle = id => setCollapsed(p => ({ ...p, [id]: !p[id] }));

  const visibleRuns = useMemo(() => {
    let runs = testRuns;
    if (planFilt) runs = runs.filter(r => r.parentId === planFilt);
    if (q) runs = runs.filter(r =>
      r.title.toLowerCase().includes(q) ||
      testCases.filter(c => c.parentId === r.id)
               .some(c => c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
    );
    return runs;
  }, [testRuns, testCases, planFilt, q]);

  const execute = async (id, status) => {
    const t = tickets.find(x => x.id === id);
    if (!t) return;
    try {
      await api.testItems.update(id, { ...t, status });
      setTickets(p => p.map(x => x.id === id ? { ...x, status } : x));
    } catch { toast.error("Failed to update"); }
  };

  // ── Sub-components ─────────────────────────────────────────────────────────

  const ExecBtn = ({ label, title, color, onClick, active }) => {
    const [hov, setHov] = useState(false);
    return (
      <button title={title} onClick={onClick}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ width: 22, height: 22, border: `1px solid ${active || hov ? color : T.border}`,
          borderRadius: 4, cursor: "pointer", fontSize: 11,
          background: active ? color + "22" : hov ? color + "11" : "transparent",
          color: active || hov ? color : T.textMuted,
          transition: "all .1s", padding: 0,
          display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.mono }}>
        {label}
      </button>
    );
  };

  const CaseRow = ({ c }) => {
    const [hov, setHov] = useState(false);
    const col = tcColor(c.status);
    return (
      <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 16px 5px 36px",
          borderBottom: `1px solid ${T.border}11`,
          background: hov ? T.border + "18" : "transparent", transition: "background .12s" }}>
        <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600,
          fontFamily: T.mono, background: col + "18", color: col,
          border: `1px solid ${col}33`, flexShrink: 0 }}>{tcLabel(c.status)}</span>
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

  const RunCard = ({ run }) => {
    const cases     = testCases.filter(c => c.parentId === run.id);
    const visible   = q ? cases.filter(c =>
      c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) : cases;
    const stats     = runStats(cases);
    const pct       = stats.total > 0 ? Math.round(stats.passed / stats.total * 100) : 0;
    const isOpen    = collapsed[run.id] !== true;
    const parentPlan = testPlans.find(p => p.id === run.parentId);

    return (
      <div style={{ background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: 10, overflow: "hidden", marginBottom: 10 }}>

        {/* Run header */}
        <div onClick={() => toggle(run.id)}
          style={{ display: "flex", alignItems: "center", gap: 10,
            padding: "11px 16px", background: T.bg,
            borderBottom: isOpen ? `1px solid ${T.border}` : "none",
            cursor: "pointer", userSelect: "none" }}>
          <span style={{ fontSize: 10, color: T.textMuted, flexShrink: 0 }}>{isOpen ? "▾" : "▸"}</span>
          <span style={{ fontSize: 14, flexShrink: 0 }}>🔄</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{run.title}</div>
            {parentPlan && (
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                🧪 {parentPlan.title}
              </div>
            )}
          </div>
          <SegBar stats={stats} width={100} />
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <Chip count={stats.passed}  color={JIRA_COLOR.Pass}    label="Pass" />
            <Chip count={stats.failed}  color={JIRA_COLOR.Fail}    label="Fail" />
            <Chip count={stats.blocked} color={JIRA_COLOR.Blocked} label="Blocked" />
          </div>
          <span style={{ fontFamily: T.mono, fontSize: 11, flexShrink: 0,
            color: pct === 100 ? JIRA_COLOR.Pass : T.textMuted, minWidth: 36, textAlign: "right" }}>
            {pct === 100 ? "✓ 100%" : `${pct}%`}
          </span>
        </div>

        {/* Cases */}
        {isOpen && (
          visible.length > 0 ? visible.map(c => <CaseRow key={c.id} c={c} />) : (
            <div style={{ padding: "10px 16px", fontFamily: T.body, fontSize: 12,
              color: T.textMuted, fontStyle: "italic" }}>
              {cases.length === 0 ? "No test cases in this run." : "No cases match search."}
            </div>
          )
        )}
      </div>
    );
  };

  // ── Global stats ───────────────────────────────────────────────────────────

  const allStats = runStats(testCases);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: T.textMuted }}>
      <Spinner size="md" />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", fontFamily: T.body }}>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0,
        padding: "12px 20px", borderBottom: `1px solid ${T.border}`, flexWrap: "wrap",
        background: T.bg }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search runs or test cases…"
          style={{ flex: 1, minWidth: 160, fontFamily: T.body, fontSize: 13, color: T.text,
            background: T.surface, border: `1px solid ${T.border}`, borderRadius: 7,
            padding: "6px 10px", outline: "none" }} />
        {testPlans.length > 0 && (
          <select value={planFilt} onChange={e => setPlanFilt(e.target.value)}
            style={{ fontFamily: T.body, fontSize: 12, color: T.text, background: T.surface,
              border: `1px solid ${T.border}`, borderRadius: 7, padding: "6px 10px",
              cursor: "pointer", outline: "none" }}>
            <option value="">All plans</option>
            {testPlans.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        )}
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          <Chip count={allStats.passed}  color={JIRA_COLOR.Pass}            label="Pass" />
          <Chip count={allStats.failed}  color={JIRA_COLOR.Fail}            label="Fail" />
          <Chip count={allStats.blocked} color={JIRA_COLOR.Blocked}         label="Blocked" />
          <Chip count={allStats.active}  color={JIRA_COLOR["In Progress"]}  label="In Progress" />
          <Chip count={allStats.pending} color={JIRA_COLOR["Not Executed"]} label="Not Executed" />
          {testCases.length > 0 && (
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>/ {testCases.length}</span>
          )}
        </div>
      </div>

      {/* Run list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px" }}>
        {visibleRuns.length === 0 ? (
          <div style={{ padding: "48px 0", textAlign: "center", fontSize: 13,
            color: T.textMuted, fontStyle: "italic" }}>
            {testRuns.length === 0 ? "No test runs yet." : "No runs match your filters."}
          </div>
        ) : (
          visibleRuns.map(run => <RunCard key={run.id} run={run} />)
        )}
      </div>
    </div>
  );
}
