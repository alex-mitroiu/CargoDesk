import { useState, useMemo } from "react";
import { T } from "../../tokens";
import Badge from "../../components/primitives/Badge";
import { TC_PASS, TC_FAIL, TC_BLOCKED, TC_ACTIVE, JIRA_COLOR, tcLabel, tcStatusIcon, tcStatusColor, runStats } from "./testStatus";

const TestSuiteView = ({ tickets, onPreview, onEdit, onAdd, onExecute, onMoveCase, canEdit }) => {
  const [search,      setSearch]      = useState("");
  // navSel: { type: "all" | "folder" | "plan", id?: string }
  const [navSel,      setNavSel]      = useState({ type: "all" });
  const [planFilt,    setPlanFilt]    = useState("");
  const [collapsed,   setCollapsed]   = useState({});
  const [folderOpen,  setFolderOpen]  = useState({});  // { folderId: true } = open
  const [dragCase,    setDragCase]    = useState(null);
  const [dropRunId,   setDropRunId]   = useState(null);
  const [dragFolder,  setDragFolder]  = useState(null);  // folder/plan id being dragged
  const [dropFolderId, setDropFolderId] = useState(null);

  const toggle = id => setCollapsed(p => ({ ...p, [id]: !p[id] }));
  const q = search.trim().toLowerCase();

  const testFolders = tickets.filter(t => t.type === "Test Folder");
  const testPlans   = tickets.filter(t => t.type === "Test Plan");
  const testRuns    = tickets.filter(t => t.type === "Test Run");
  const testCases   = tickets.filter(t => t.type === "Test Case");

  // Compute which plans are visible based on the left-nav selection
  const folderIds = new Set(testFolders.map(f => f.id));
  const visiblePlans = useMemo(() => {
    if (navSel.type === "plan")   return testPlans.filter(p => p.id === navSel.id);
    if (navSel.type === "folder") {
      // Recursively collect all folder IDs under a folder
      const collect = fid => {
        const subs = testFolders.filter(f => f.parentId === fid).map(f => f.id);
        return [fid, ...subs.flatMap(collect)];
      };
      const fids = new Set(collect(navSel.id));
      return testPlans.filter(p => fids.has(p.parentId));
    }
    return testPlans;
  }, [navSel, testPlans, testFolders]);

  const totalPass    = testCases.filter(c => TC_PASS.has(c.status)).length;
  const totalFail    = testCases.filter(c => TC_FAIL.has(c.status)).length;
  const totalBlocked = testCases.filter(c => TC_BLOCKED.has(c.status)).length;
  const totalActive  = testCases.filter(c => TC_ACTIVE.has(c.status)).length;
  const totalNotRun  = testCases.length - totalPass - totalFail - totalBlocked - totalActive;

  const childRuns   = planId   => testRuns.filter(r => r.parentId === planId);
  const childCases  = parentId => testCases.filter(c => c.parentId === parentId);
  const caseMatches = c => !q || c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q);

  // When nav selection changes, clear the plan sub-filter
  const selectNav = sel => { setNavSel(sel); setPlanFilt(""); };

  if (testCases.length === 0 && testRuns.length === 0 && testPlans.length === 0 && testFolders.length === 0) return (
    <div style={{ padding: "60px 24px", textAlign: "center", fontFamily: T.body, fontSize: 14, color: T.textMuted }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🧪</div>
      <div style={{ fontWeight: 600, color: T.text, marginBottom: 8 }}>No test artefacts yet</div>
      <div>Use <strong>＋ Test Folder</strong> to organise, or <strong>＋ Test Plan</strong> to start executing.</div>
    </div>
  );

  // ── ExecBtn ───────────────────────────────────────────────────────────────────
  const ExecBtn = ({ label, title, color, onClick, active }) => (
    <button title={title} onClick={onClick}
      style={{ background: active ? `${color}22` : "none", border: `1px solid ${active ? color : T.border}55`,
        borderRadius: 3, color: active ? color : T.textMuted, cursor: "pointer", fontSize: 11,
        padding: "0px 5px", fontFamily: T.mono, flexShrink: 0, lineHeight: "18px", transition: "all .12s" }}
      onMouseEnter={e => { e.currentTarget.style.background = `${color}22`; e.currentTarget.style.borderColor = color; e.currentTarget.style.color = color; }}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.background = "none"; e.currentTarget.style.borderColor = `${T.border}55`; e.currentTarget.style.color = T.textMuted; } }}>
      {label}
    </button>
  );

  // ── SegBar ────────────────────────────────────────────────────────────────────
  const SegBar = ({ stats, width = 80 }) => {
    if (stats.total === 0) return null;
    const segs = [
      [stats.passed,  JIRA_COLOR.Pass],
      [stats.failed,  JIRA_COLOR.Fail],
      [stats.blocked, JIRA_COLOR.Blocked],
      [stats.active,  JIRA_COLOR["In Progress"]],
      [stats.pending, "#374151"],
    ];
    return (
      <div style={{ width, height: 6, borderRadius: 3, overflow: "hidden", display: "flex", flexShrink: 0, background: T.border }}>
        {segs.map(([n, color], i) => n > 0 && (
          <div key={i} style={{ height: "100%", flex: n, background: color }} />
        ))}
      </div>
    );
  };

  // ── StatChip ──────────────────────────────────────────────────────────────────
  const StatChip = ({ count, color, label }) => count === 0 ? null : (
    <span title={`${count} ${label}`} style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
      padding: "1px 6px", borderRadius: 3, color, background: `${color}18`, border: `1px solid ${color}33`,
      flexShrink: 0, whiteSpace: "nowrap" }}>
      {count} {label}
    </span>
  );

  // ── CaseRow ───────────────────────────────────────────────────────────────────
  const CaseRow = ({ c, depth = 0 }) => {
    const [hover, setHover] = useState(false);
    if (!caseMatches(c)) return null;
    const lbl   = tcLabel(c.status);
    const color = JIRA_COLOR[lbl] || "#6b7280";
    const icon  = tcStatusIcon(c.status);
    const isDragging = dragCase?.id === c.id;

    return (
      <div
        draggable={!!canEdit}
        onDragStart={e => { e.stopPropagation(); setDragCase({ id: c.id, parentId: c.parentId }); }}
        onDragEnd={() => { setDragCase(null); setDropRunId(null); }}
        onClick={() => !isDragging && onPreview?.(c)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ display: "flex", alignItems: "center", gap: 8,
          paddingLeft: 10 + depth * 24, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
          borderBottom: `1px solid ${T.border}18`, cursor: isDragging ? "grabbing" : "pointer",
          background: isDragging ? `${T.accent}08` : hover ? T.surfaceHover : "transparent",
          opacity: isDragging ? 0.45 : 1, transition: "background .1s" }}>

        {/* Drag handle */}
        <span style={{ color: hover ? T.textMuted : "transparent", fontSize: 11, cursor: "grab",
          flexShrink: 0, lineHeight: 1, userSelect: "none", transition: "color .1s" }}>⠿</span>

        <span style={{ fontSize: 12, color, flexShrink: 0, width: 14, textAlign: "center" }}>{icon}</span>
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, flexShrink: 0 }}>{c.id}</span>
        <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.title}
        </span>

        {/* Inline execution buttons — hover-reveal */}
        {canEdit && hover && (
          <div style={{ display: "flex", gap: 3, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
            <ExecBtn label="✓" title="Mark Pass"    color={JIRA_COLOR.Pass}            onClick={() => onExecute?.(c.id, "Done")}           active={TC_PASS.has(c.status)} />
            <ExecBtn label="✗" title="Mark Fail"    color={JIRA_COLOR.Fail}            onClick={() => onExecute?.(c.id, "Testing Failed")}  active={TC_FAIL.has(c.status)} />
            <ExecBtn label="⊘" title="Mark Blocked" color={JIRA_COLOR.Blocked}         onClick={() => onExecute?.(c.id, "Cancelled")}       active={TC_BLOCKED.has(c.status)} />
            <ExecBtn label="⟳" title="Reset"        color={JIRA_COLOR["Not Executed"]} onClick={() => onExecute?.(c.id, "Ready")}           active={false} />
          </div>
        )}

        {/* JIRA-style status pill */}
        <span style={{ fontFamily: T.mono, fontSize: 10, padding: "1px 7px", borderRadius: 3,
          color, background: `${color}18`, border: `1px solid ${color}40`, flexShrink: 0, letterSpacing: ".02em" }}>
          {lbl}
        </span>

        {c.assigneeName && (
          <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, flexShrink: 0,
            maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {c.assigneeName}
          </span>
        )}
        {canEdit && !hover && (
          <button onClick={e => { e.stopPropagation(); onEdit(c); }}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
              color: T.textMuted, cursor: "pointer", fontSize: 10, padding: "1px 6px",
              fontFamily: T.body, flexShrink: 0 }}>✎</button>
        )}
      </div>
    );
  };

  // ── RunBlock ──────────────────────────────────────────────────────────────────
  const RunBlock = ({ run, depth = 1 }) => {
    const cases        = childCases(run.id);
    const stats        = runStats(cases);
    const isOpen       = !collapsed[run.id];
    const pct          = stats.total > 0 ? Math.round(stats.passed / stats.total * 100) : 0;
    const runColor     = tcStatusColor(run.status);
    const isDragTarget = dropRunId === run.id && dragCase?.parentId !== run.id;

    const visibleCases = cases.filter(caseMatches);
    if (q && visibleCases.length === 0 && !run.id.toLowerCase().includes(q) && !run.title.toLowerCase().includes(q)) return null;

    return (
      <div style={{ borderBottom: `1px solid ${T.border}22` }}
        onDragOver={e => { if (dragCase && dragCase.parentId !== run.id) { e.preventDefault(); setDropRunId(run.id); } }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropRunId(null); }}
        onDrop={e => { e.preventDefault(); if (dragCase) { onMoveCase?.(dragCase.id, run.id); setDragCase(null); setDropRunId(null); } }}>

        {isDragTarget && <div style={{ height: 3, background: T.accent, margin: "0 12px", borderRadius: 2 }} />}

        {/* Run header */}
        <div onClick={() => toggle(run.id)}
          style={{ display: "flex", alignItems: "center", gap: 8,
            paddingLeft: 12 + depth * 16, paddingRight: 12, paddingTop: 8, paddingBottom: 8,
            cursor: "pointer", background: isDragTarget ? `${T.accent}08` : T.bg, transition: "background .1s",
            borderLeft: `3px solid ${runColor}66` }}
          onMouseEnter={e => { if (!isDragTarget) e.currentTarget.style.background = T.surfaceHover; }}
          onMouseLeave={e => { e.currentTarget.style.background = isDragTarget ? `${T.accent}08` : T.bg; }}>
          <span style={{ fontSize: 10, color: T.textMuted, flexShrink: 0, width: 10 }}>{isOpen ? "▾" : "▸"}</span>
          <span style={{ fontSize: 13 }}>▶</span>
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, flexShrink: 0 }}>{run.id}</span>
          <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text, flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {run.title}
          </span>

          {stats.total > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
              <StatChip count={stats.passed}  color={JIRA_COLOR.Pass}             label="Pass" />
              <StatChip count={stats.failed}  color={JIRA_COLOR.Fail}             label="Fail" />
              <StatChip count={stats.blocked} color={JIRA_COLOR.Blocked}          label="Blocked" />
              <StatChip count={stats.active}  color={JIRA_COLOR["In Progress"]}   label="In Progress" />
              <StatChip count={stats.pending} color={JIRA_COLOR["Not Executed"]}  label="Not Executed" />
              <SegBar stats={stats} width={60} />
              <span style={{ fontFamily: T.mono, fontSize: 10, color: pct === 100 ? JIRA_COLOR.Pass : T.textMuted, flexShrink: 0 }}>
                {pct}%
              </span>
            </div>
          )}
          {stats.total === 0 && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontStyle: "italic" }}>No cases</span>}

          {canEdit && (
            <button onClick={e => { e.stopPropagation(); onEdit(run); }}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
                color: T.textMuted, cursor: "pointer", fontSize: 10, padding: "1px 6px",
                fontFamily: T.body, flexShrink: 0 }}>✎</button>
          )}
        </div>

        {/* Cases + inline add */}
        {isOpen && (
          <div>
            {visibleCases.map(c => <CaseRow key={c.id} c={c} depth={depth} />)}
            {cases.length === 0 && (
              <div style={{ paddingLeft: 48 + depth * 12, paddingTop: 5, paddingBottom: 5,
                fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
                No test cases yet.
              </div>
            )}
            {canEdit && onAdd && (
              <div style={{ paddingLeft: 14 + depth * 24, paddingTop: 4, paddingBottom: 8 }}>
                <button onClick={() => onAdd({ type: "Test Case", parentId: run.id })}
                  style={{ background: "none", border: `1px dashed ${T.border}`, borderRadius: 4,
                    color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "3px 10px", fontFamily: T.body }}>
                  ＋ Add Test Case
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── PlanBlock ─────────────────────────────────────────────────────────────────
  const PlanBlock = ({ plan }) => {
    const runs        = childRuns(plan.id);
    const directCases = childCases(plan.id);
    const allCases    = [...runs.flatMap(r => childCases(r.id)), ...directCases];
    const stats       = runStats(allCases);
    const pct         = stats.total > 0 ? Math.round(stats.passed / stats.total * 100) : 0;
    const isOpen      = !collapsed[plan.id];

    const hasVisibleContent = !q || runs.some(r => {
      const cases = childCases(r.id);
      return cases.some(caseMatches) || r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q);
    }) || directCases.some(caseMatches) || plan.title.toLowerCase().includes(q) || plan.id.toLowerCase().includes(q);
    if (!hasVisibleContent) return null;

    return (
      <div style={{ background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>

        {/* Plan header */}
        <div onClick={() => toggle(plan.id)}
          style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px",
            cursor: "pointer", background: T.bg, transition: "background .1s",
            borderLeft: `4px solid ${T.accent}` }}
          onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
          onMouseLeave={e => e.currentTarget.style.background = T.bg}>
          <span style={{ fontSize: 11, color: T.textMuted, flexShrink: 0, width: 12 }}>{isOpen ? "▾" : "▸"}</span>
          <span style={{ fontSize: 16 }}>📋</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plan.title}</span>
              <span style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted }}>{plan.id}</span>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 5, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                {runs.length} cycle{runs.length !== 1 ? "s" : ""} · {allCases.length} test{allCases.length !== 1 ? "s" : ""}
              </span>
              {stats.total > 0 && (
                <>
                  <SegBar stats={stats} width={100} />
                  <StatChip count={stats.passed}  color={JIRA_COLOR.Pass}            label="Pass" />
                  <StatChip count={stats.failed}  color={JIRA_COLOR.Fail}            label="Fail" />
                  <StatChip count={stats.blocked} color={JIRA_COLOR.Blocked}         label="Blocked" />
                  <StatChip count={stats.pending} color={JIRA_COLOR["Not Executed"]} label="Not Executed" />
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: pct === 100 ? JIRA_COLOR.Pass : T.textMuted }}>
                    {pct === 100 ? "✓ All Passed" : `${pct}% pass rate`}
                  </span>
                </>
              )}
            </div>
          </div>
          {canEdit && (
            <button onClick={e => { e.stopPropagation(); onEdit(plan); }}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
                color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "2px 8px",
                fontFamily: T.body, flexShrink: 0 }}>✎</button>
          )}
        </div>

        {/* Cycles + direct cases + inline add */}
        {isOpen && (
          <div>
            {runs.map(r => <RunBlock key={r.id} run={r} depth={1} />)}
            {directCases.filter(caseMatches).map(c => <CaseRow key={c.id} c={c} depth={1} />)}
            {runs.length === 0 && directCases.length === 0 && (
              <div style={{ padding: "8px 20px", fontFamily: T.body, fontSize: 12,
                color: T.textMuted, fontStyle: "italic" }}>
                No test cycles yet.
              </div>
            )}
            {canEdit && onAdd && (
              <div style={{ padding: "6px 16px 10px" }}>
                <button onClick={() => onAdd({ type: "Test Run", parentId: plan.id })}
                  style={{ background: "none", border: `1px dashed ${T.border}`, borderRadius: 4,
                    color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "3px 10px", fontFamily: T.body }}>
                  ＋ Add Test Cycle
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── FolderTree (left nav sidebar) ────────────────────────────────────────────
  const FolderTree = () => {
    // Recursive folder node
    const FolderNode = ({ folder, depth = 0 }) => {
      const isOpen = folderOpen[folder.id] !== false; // open by default
      const childFolders = testFolders.filter(f => f.parentId === folder.id);
      const plansHere    = testPlans.filter(p => p.parentId === folder.id);
      const isSelected   = navSel.type === "folder" && navSel.id === folder.id;

      return (
        <div>
          {/* Folder row */}
          <div
            draggable={!!canEdit}
            onDragStart={e => { e.stopPropagation(); setDragFolder(folder.id); }}
            onDragEnd={() => { setDragFolder(null); setDropFolderId(null); }}
            onDragOver={e => {
              if (dragFolder && dragFolder !== folder.id) {
                e.preventDefault(); e.stopPropagation();
                setDropFolderId(folder.id);
              }
            }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropFolderId(null); }}
            onDrop={e => {
              e.preventDefault(); e.stopPropagation();
              if (!dragFolder || dragFolder === folder.id) return;
              onMoveCase?.(dragFolder, folder.id);
              setDragFolder(null); setDropFolderId(null);
            }}
            onClick={() => selectNav({ type: "folder", id: folder.id })}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: `4px 8px 4px ${8 + depth * 14}px`,
              borderRadius: 5, cursor: "pointer", userSelect: "none",
              background: isSelected ? T.accent + "22"
                        : dropFolderId === folder.id ? T.accent + "11"
                        : "transparent",
              color: isSelected ? T.accent : T.text,
              fontFamily: T.body, fontSize: 12, fontWeight: isSelected ? 600 : 400,
              borderLeft: isSelected ? `2px solid ${T.accent}` : "2px solid transparent",
            }}>
            <span onClick={e => { e.stopPropagation(); setFolderOpen(p => ({ ...p, [folder.id]: !isOpen })); }}
              style={{ fontSize: 10, color: T.textMuted, width: 12, flexShrink: 0 }}>
              {(childFolders.length > 0 || plansHere.length > 0) ? (isOpen ? "▾" : "▸") : ""}
            </span>
            <span style={{ fontSize: 13, flexShrink: 0 }}>📁</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{folder.title}</span>
            {canEdit && (
              <span onClick={e => { e.stopPropagation(); onEdit(folder); }}
                style={{ color: T.textMuted, fontSize: 10, opacity: 0.6, flexShrink: 0 }}>✎</span>
            )}
          </div>

          {/* Children */}
          {isOpen && (
            <div>
              {childFolders.map(cf => <FolderNode key={cf.id} folder={cf} depth={depth + 1} />)}
              {plansHere.map(plan => {
                const isPlanSel = navSel.type === "plan" && navSel.id === plan.id;
                return (
                  <div key={plan.id} onClick={() => selectNav({ type: "plan", id: plan.id })}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: `3px 8px 3px ${8 + (depth + 1) * 14}px`,
                      borderRadius: 5, cursor: "pointer", userSelect: "none",
                      background: isPlanSel ? T.accent + "22" : "transparent",
                      color: isPlanSel ? T.accent : T.text,
                      fontFamily: T.body, fontSize: 12, fontWeight: isPlanSel ? 600 : 400,
                      borderLeft: isPlanSel ? `2px solid ${T.accent}` : "2px solid transparent",
                    }}>
                    <span style={{ width: 12, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, flexShrink: 0 }}>🧪</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plan.title}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    };

    // Root-level folders (no parent or parent not a folder)
    const rootFolders = testFolders.filter(f => !f.parentId || !folderIds.has(f.parentId));
    // Plans not inside any folder
    const unfiledPlans = testPlans.filter(p => !p.parentId || !folderIds.has(p.parentId));

    return (
      <div style={{
        width: 220, flexShrink: 0, background: T.bg,
        borderRight: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column",
        overflowY: "auto", overflowX: "hidden",
      }}>
        {/* Sidebar header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 8px 6px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, letterSpacing: ".07em",
            textTransform: "uppercase", color: T.textMuted }}>Repository</span>
          {canEdit && onAdd && (
            <button onClick={() => onAdd({ type: "Test Folder" })}
              title="New Test Folder"
              style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted,
                fontSize: 14, lineHeight: 1, padding: "0 2px", fontFamily: T.body }}>＋</button>
          )}
        </div>

        {/* All Tests root node */}
        <div onClick={() => selectNav({ type: "all" })}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "5px 8px 5px 10px", cursor: "pointer", userSelect: "none",
            borderRadius: 5, margin: "4px 4px 2px",
            background: navSel.type === "all" ? T.accent + "22" : "transparent",
            color: navSel.type === "all" ? T.accent : T.text,
            fontFamily: T.body, fontSize: 12, fontWeight: navSel.type === "all" ? 600 : 400,
            borderLeft: navSel.type === "all" ? `2px solid ${T.accent}` : "2px solid transparent",
          }}>
          <span style={{ fontSize: 13 }}>📂</span>
          <span>All Tests</span>
          <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{testCases.length}</span>
        </div>

        {/* Folder tree */}
        <div style={{ padding: "0 4px", flex: 1 }}>
          {rootFolders.map(f => <FolderNode key={f.id} folder={f} />)}
          {/* Unfiled plans (no folder parent) */}
          {unfiledPlans.map(plan => {
            const isPlanSel = navSel.type === "plan" && navSel.id === plan.id;
            return (
              <div key={plan.id} onClick={() => selectNav({ type: "plan", id: plan.id })}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "3px 8px 3px 8px", borderRadius: 5, cursor: "pointer", userSelect: "none",
                  background: isPlanSel ? T.accent + "22" : "transparent",
                  color: isPlanSel ? T.accent : T.text,
                  fontFamily: T.body, fontSize: 12, fontWeight: isPlanSel ? 600 : 400,
                  borderLeft: isPlanSel ? `2px solid ${T.accent}` : "2px solid transparent",
                }}>
                <span style={{ width: 12, flexShrink: 0 }} />
                <span style={{ fontSize: 12, flexShrink: 0 }}>🧪</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plan.title}</span>
              </div>
            );
          })}
        </div>

        {/* Add Plan/Folder footer */}
        {canEdit && onAdd && (
          <div style={{ padding: "6px 8px", borderTop: `1px solid ${T.border}`, display: "flex", gap: 6, flexShrink: 0 }}>
            <button onClick={() => onAdd({ type: "Test Plan" })}
              style={{ flex: 1, background: "none", border: `1px dashed ${T.border}`, borderRadius: 4,
                color: T.textMuted, cursor: "pointer", fontSize: 10, padding: "3px 0", fontFamily: T.body }}>
              ＋ Plan
            </button>
            <button onClick={() => onAdd({ type: "Test Folder" })}
              style={{ flex: 1, background: "none", border: `1px dashed ${T.border}`, borderRadius: 4,
                color: T.textMuted, cursor: "pointer", fontSize: 10, padding: "3px 0", fontFamily: T.body }}>
              ＋ Folder
            </button>
          </div>
        )}
      </div>
    );
  };

  const planIds = new Set(testPlans.map(p => p.id));
  const runIds  = new Set(testRuns.map(r => r.id));
  const orphanRuns      = testRuns.filter(r => !r.parentId || !planIds.has(r.parentId));
  const standaloneCases = testCases.filter(c => !c.parentId || (!planIds.has(c.parentId) && !runIds.has(c.parentId)));

  // Which plans show in the right panel?
  const rightPlans = planFilt
    ? visiblePlans.filter(p => p.id === planFilt)
    : visiblePlans;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Left nav / folder tree ─────────────────────────── */}
      <FolderTree />

      {/* ── Right execution panel ──────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
        {/* Toolbar */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0,
          padding: "10px 14px 10px", borderBottom: `1px solid ${T.border}`, flexWrap: "wrap" }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search cycles, test cases…"
            style={{ flex: 1, minWidth: 140, fontFamily: T.body, fontSize: 13, color: T.text, background: T.bg,
              border: `1px solid ${T.border}`, borderRadius: 7, padding: "6px 10px", outline: "none" }} />
          {visiblePlans.length > 1 && (
            <select value={planFilt} onChange={e => setPlanFilt(e.target.value)}
              style={{ fontFamily: T.body, fontSize: 12, color: T.text, background: T.bg,
                border: `1px solid ${T.border}`, borderRadius: 7, padding: "6px 10px", cursor: "pointer", outline: "none" }}>
              <option value="">All plans</option>
              {visiblePlans.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          )}
          {/* Execution summary chips */}
          <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>
            <StatChip count={totalPass}    color={JIRA_COLOR.Pass}            label="Pass" />
            <StatChip count={totalFail}    color={JIRA_COLOR.Fail}            label="Fail" />
            <StatChip count={totalBlocked} color={JIRA_COLOR.Blocked}         label="Blocked" />
            <StatChip count={totalActive}  color={JIRA_COLOR["In Progress"]}  label="In Progress" />
            <StatChip count={totalNotRun}  color={JIRA_COLOR["Not Executed"]} label="Not Executed" />
            {testCases.length > 0 && (
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>/ {testCases.length}</span>
            )}
          </div>
        </div>

        {/* Plan tree (right panel body) */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px" }}>
          {rightPlans.map(plan => <PlanBlock key={plan.id} plan={plan} />)}
          {navSel.type === "all" && orphanRuns.length > 0 && !planFilt && (
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
              <div style={{ padding: "10px 16px", background: T.bg, borderBottom: `1px solid ${T.border}`,
                fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.textMuted, letterSpacing: ".06em", textTransform: "uppercase" }}>
                Unplanned Cycles
              </div>
              {orphanRuns.map(r => <RunBlock key={r.id} run={r} depth={0} />)}
            </div>
          )}
          {navSel.type === "all" && standaloneCases.filter(caseMatches).length > 0 && !planFilt && (
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
              <div style={{ padding: "10px 16px", background: T.bg, borderBottom: `1px solid ${T.border}`,
                fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.textMuted, letterSpacing: ".06em", textTransform: "uppercase" }}>
                Standalone Cases
              </div>
              {standaloneCases.filter(caseMatches).map(c => <CaseRow key={c.id} c={c} depth={0} />)}
            </div>
          )}
          {rightPlans.length === 0 && orphanRuns.length === 0 && standaloneCases.length === 0 && (
            <div style={{ padding: "48px 24px", textAlign: "center", fontFamily: T.body,
              fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
              {navSel.type === "all" ? "Nothing matches your search." : "No test plans in this selection."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TestSuiteView;
