import { useState, useEffect, useCallback } from "react";
import { T } from "../tokens";
import { inputBase } from "../components/primitives/Form";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { Modal } from "../components/primitives/Modal";
import Btn from "../components/primitives/Btn";
import { IconSettings } from "../components/primitives/Icon";
import { COLUMNS, COL_ACCENT, TYPES, TYPE_ICON, PRIORITIES } from "./kanban/constants";
import TicketDiagramModal from "./kanban/TicketDiagramModal";
import EpicCoverageModal from "./kanban/EpicCoverageModal";
import TestOutcomeModal from "./kanban/TestOutcomeModal";
import TicketModal from "./kanban/TicketModal";
import TestItemModal from "./kanban/TestItemModal";
import TicketPreview from "./kanban/TicketPreview";
import KanbanColumn from "./kanban/KanbanColumn";
import BacklogDrawer from "./kanban/BacklogDrawer";
import BoardManagerModal from "./kanban/BoardManagerModal";
import RoadmapView from "./kanban/RoadmapView";
import TestItemPreview from "./kanban/TestItemPreview";
import TestSuiteView from "./kanban/TestSuiteView";

// ─── Page ─────────────────────────────────────────────────────────────────────

const KanbanPage = ({ shipments = [] }) => {
  const { canEditKanban: canEdit } = useAuth();
  const [tickets,       setTickets]       = useState([]);
  const [testItems,     setTestItems]     = useState([]);
  const [users,         setUsers]         = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [modal,         setModal]         = useState(null);
  const [testModal,     setTestModal]     = useState(null);
  const [testPreviewId, setTestPreviewId] = useState(null);
  const [filter,        setFilter]        = useState({ priority: "", section: "", type: "", assigneeId: "", versionId: "" });
  const [dragId,        setDragId]        = useState(null);
  const [previewId,     setPreviewId]     = useState(null);
  const [showReleased,  setShowReleased]  = useState(true);
  const [backlogOpen,   setBacklogOpen]   = useState(false);
  const [boardView,     setBoardView]     = useState("board"); // "board" | "roadmap" | "tests"
  const [boardMgr,      setBoardMgr]      = useState(false);

  // Multi-project support
  const [projects,       setProjects]       = useState([]);
  const [currentProject, setCurrentProject] = useState(null);
  const [columns,        setColumns]        = useState([]);
  const [versions,       setVersions]       = useState([]);

  // colNames: ordered column names for the current project (or fallback to hardcoded)
  const colNames = columns.length > 0 ? columns.map(c => c.name) : COLUMNS;

  const [diagramTicket,      setDiagramTicket]      = useState(null);
  const [coverageTicket,     setCoverageTicket]     = useState(null);
  const [testOutcomePending, setTestOutcomePending] = useState(null);

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

  const preview     = previewId     ? tickets.find(t => t.id === previewId) ?? null : null;
  const testPreview = testPreviewId ? testItems.find(t => t.id === testPreviewId) ?? null : null;

  const loadBoard = useCallback(async (proj) => {
    setLoading(true);
    const safe = p => p.catch(() => []);
    const [tix, tst, cols, vers] = await Promise.all([
      safe(api.tickets.list(proj ? { projectId: proj.id } : {})),
      safe(api.testItems.list(proj ? { projectId: proj.id } : {})),
      proj ? safe(api.kbColumns.list(proj.id))  : Promise.resolve([]),
      proj ? safe(api.kbVersions.list(proj.id)) : Promise.resolve([]),
    ]);
    setTickets(tix);
    setTestItems(tst);
    setColumns(cols);
    setVersions(vers);
    setLoading(false);
  }, []);

  const load = useCallback(async () => {
    try {
      const projs = await api.kbProjects.list();
      setProjects(projs);
      const proj = projs[0] || null;
      if (proj && !currentProject) setCurrentProject(proj);
      await loadBoard(proj || currentProject);
    } catch {
      await loadBoard(null);
    }
  }, [currentProject, loadBoard]);

  const switchProject = async proj => {
    setCurrentProject(proj);
    await loadBoard(proj);
  };

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
    if (filter.versionId)  list = list.filter(t => t.versionId  === filter.versionId);
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
    const payload = {
      ...form,
      assigneeId: form.assigneeId || null,
      dueDate:    form.dueDate    || null,
      parentId:   form.parentId   || null,
      testNotes:  form.testNotes  || null,
      versionId:  form.versionId  || null,
      projectId:  currentProject?.id || null,
    };
    if (modal === "add" || modal === "add-backlog") {
      await api.tickets.create(payload);
    } else {
      await api.tickets.update(modal.id, { ...modal, ...payload });
    }
    setModal(null);
    load();
  };

  const handleTestItemSave = async form => {
    const payload = {
      ...form,
      assigneeId: form.assigneeId || null,
      dueDate:    form.dueDate    || null,
      parentId:   form.parentId   || null,
      testNotes:  form.testNotes  || null,
      shipmentId: form.shipmentId || null,
      versionId:  form.versionId  || null,
      projectId:  currentProject?.id || null,
    };
    if (testModal?._action === "add") {
      await api.testItems.create(payload);
    } else {
      await api.testItems.update(testModal.id, { ...testModal, ...payload });
    }
    setTestModal(null);
    load();
  };

  const handleTestItemDelete = async id => {
    await api.testItems.remove(id);
    setTestItems(p => p.filter(t => t.id !== id));
    setTestPreviewId(p => p === id ? null : p);
  };

  const totalOpen      = tickets.filter(t => !["Released", "Testing Failed", "Ready to Deploy", "Done"].includes(t.status)).length;
  const backlogTickets = tickets.filter(t => t.status === "Backlog").sort((a, b) => a.position - b.position);

  // Column accent colours: prefer colour from kb_columns, fall back to hardcoded map
  const colAccentMap = columns.length > 0
    ? Object.fromEntries(columns.map(c => [c.name, c.color]))
    : COL_ACCENT;

  const VIEW_BTN = id => ({
    fontFamily: T.body, fontSize: 12, fontWeight: boardView === id ? 700 : 400,
    padding: "5px 12px", borderRadius: 6, cursor: "pointer", border: "none",
    background: boardView === id ? T.accent : T.surface,
    color:      boardView === id ? "#fff"   : T.textMuted,
    transition: "background .12s, color .12s",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: T.head, fontSize: 22, fontWeight: 800, color: T.text, margin: 0 }}>
              {currentProject ? currentProject.name : "Integration Board"}
            </h1>
            <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "2px 0 0" }}>
              {tickets.length} ticket{tickets.length !== 1 ? "s" : ""} · {totalOpen} open
              {dragId && <span style={{ fontStyle: "italic" }}> · dragging…</span>}
            </p>
          </div>
          {/* Project switcher */}
          {projects.length > 1 && (
            <select value={currentProject?.id || ""}
              onChange={e => { const p = projects.find(x => x.id === e.target.value); if (p) switchProject(p); }}
              style={{ ...inputBase, fontFamily: T.body, fontSize: 12, cursor: "pointer", width: 160 }}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
            </select>
          )}
          {/* View tabs */}
          <div style={{ display: "flex", gap: 4, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: 3 }}>
            <button type="button" onClick={() => setBoardView("board")}  style={VIEW_BTN("board")}>📋 Board</button>
            <button type="button" onClick={() => setBoardView("roadmap")} style={VIEW_BTN("roadmap")}>🗺 Roadmap</button>
            <button type="button" onClick={() => setBoardView("tests")}  style={VIEW_BTN("tests")}>🧪 Tests</button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Filters — only show on Board view */}
          {boardView === "board" && (
            <>
              <select value={filter.type} onChange={e => setFilter(f => ({ ...f, type: e.target.value }))}
                style={{ ...inputBase, fontFamily: T.body, fontSize: 12, width: 130, cursor: "pointer" }}>
                <option value="">All types</option>
                {TYPES.map(t => <option key={t} value={t}>{TYPE_ICON[t]} {t}</option>)}
              </select>
              <select value={filter.priority} onChange={e => setFilter(f => ({ ...f, priority: e.target.value }))}
                style={{ ...inputBase, fontFamily: T.body, fontSize: 12, width: 120, cursor: "pointer" }}>
                <option value="">All priorities</option>
                {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              {versions.length > 0 && (
                <select value={filter.versionId} onChange={e => setFilter(f => ({ ...f, versionId: e.target.value }))}
                  style={{ ...inputBase, fontFamily: T.body, fontSize: 12, width: 140, cursor: "pointer" }}>
                  <option value="">All versions</option>
                  {versions.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              )}
              {users.length > 0 && (
                <select value={filter.assigneeId} onChange={e => setFilter(f => ({ ...f, assigneeId: e.target.value }))}
                  style={{ ...inputBase, fontFamily: T.body, fontSize: 12, width: 140, cursor: "pointer" }}>
                  <option value="">All assignees</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              )}
              <button type="button" onClick={() => setBacklogOpen(true)}
                style={{ fontFamily: T.body, fontSize: 12, cursor: "pointer",
                  padding: "5px 12px", borderRadius: 7, display: "flex", alignItems: "center", gap: 6,
                  border: `1px solid ${backlogTickets.length > 0 ? T.accent + "88" : T.border}`,
                  background: backlogTickets.length > 0 ? T.accent + "10" : "none",
                  color: backlogTickets.length > 0 ? T.accent : T.textMuted, transition: "all .15s" }}>
                Backlog
                {backlogTickets.length > 0 && (
                  <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, background: T.accent,
                    color: "#fff", borderRadius: 10, padding: "0 6px", lineHeight: "16px" }}>
                    {backlogTickets.length}
                  </span>
                )}
              </button>
              <button type="button" onClick={() => setShowReleased(v => !v)}
                style={{ fontFamily: T.body, fontSize: 12, cursor: "pointer",
                  padding: "5px 12px", borderRadius: 7,
                  border: `1px solid ${showReleased ? "#8b5cf6" : T.border}`,
                  background: showReleased ? "rgba(139,92,246,.12)" : "none",
                  color: showReleased ? "#8b5cf6" : T.textMuted, transition: "all .15s" }}>
                {showReleased ? "● Released" : "○ Released"}
              </button>
            </>
          )}
          {canEdit && (
            <button type="button" onClick={() => setBoardMgr(true)}
              title="Board settings — projects, columns, versions"
              style={{ fontFamily: T.body, fontSize: 12, padding: "5px 11px", borderRadius: 7,
                background: "none", border: `1px solid ${T.border}`, color: T.textMuted,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
                transition: "color .12s, border-color .12s" }}
              onMouseEnter={e => { e.currentTarget.style.color = T.text; e.currentTarget.style.borderColor = T.text; }}
              onMouseLeave={e => { e.currentTarget.style.color = T.textMuted; e.currentTarget.style.borderColor = T.border; }}>
              <IconSettings size={13} /> Board
            </button>
          )}
          {canEdit && (
            <Btn onClick={() => boardView === "tests"
              ? setTestModal({ _action: "add", type: "Test Plan" })
              : setModal("add")} size="sm">
              {boardView === "tests" ? "＋ Test Plan" : "＋ Add Ticket"}
            </Btn>
          )}
        </div>
      </div>

      {/* Views */}
      {loading ? (
        <div style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted, padding: 40, textAlign: "center" }}>
          Loading board…
        </div>
      ) : boardView === "roadmap" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <RoadmapView
            tickets={tickets}
            versions={versions}
            onPreview={t => setPreviewId(t.id)}
            onManageVersions={() => setBoardMgr("versions")}
          />
        </div>
      ) : boardView === "tests" ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <TestSuiteView
              tickets={testItems}
              canEdit={canEdit}
              onPreview={t => setTestPreviewId(t.id)}
              onEdit={t => setTestModal(t)}
              onAdd={init => setTestModal({ _action: "add", ...init })}
              onExecute={async (id, status) => {
                const t = testItems.find(x => x.id === id);
                if (!t) return;
                await api.testItems.update(id, { ...t, status });
                load();
              }}
              onMoveCase={async (id, newParentId) => {
                const t = testItems.find(x => x.id === id);
                if (!t) return;
                await api.testItems.update(id, { ...t, parentId: newParentId });
                load();
              }}
            />
          </div>
          {testPreview && (
            <TestItemPreview
              item={testPreview}
              testItems={testItems}
              tickets={tickets}
              onClose={() => setTestPreviewId(null)}
              onEdit={t => setTestModal(t)}
              onDelete={handleTestItemDelete}
              onPreview={t => setTestPreviewId(t.id)}
            />
          )}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 14, flex: 1, minHeight: 0 }}>
          {/* Columns */}
          <div
            style={{ display: "flex", gap: 14, alignItems: "flex-start", overflowX: "auto", flex: 1, paddingBottom: 8 }}
            onDragEnd={() => setDragId(null)}
          >
            {colNames
              .filter(col => showReleased || col !== "Released")
              .map((col) => (
                <KanbanColumn
                  key={col} status={col} colIndex={colNames.indexOf(col)}
                  columns={colNames}
                  colAccent={colAccentMap[col]}
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
              colIndex={colNames.indexOf(preview.status)}
              columns={colNames}
              shipments={shipments}
              tickets={tickets}
              testItems={testItems}
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
          onPromote={async t => { await commitMove(t, colNames[0] || "Ready"); load(); }}
          onEdit={t => { setBacklogOpen(false); setModal(t); }}
          onAdd={() => { setBacklogOpen(false); setModal("add-backlog"); }}
        />
      )}

      {modal && (
        <Modal
          title={modal === "add" ? "New Ticket"
            : modal === "add-backlog" ? "New Ticket"
            : modal?._action === "add" ? `New ${modal.type || "Ticket"}`
            : `Edit — ${modal.id}`}
          onClose={() => setModal(null)} width={560}
        >
          <TicketModal
            init={modal === "add" ? {}
              : modal === "add-backlog" ? { status: "Backlog" }
              : modal?._action === "add" ? (({ _action, ...rest }) => rest)(modal)
              : modal}
            shipments={shipments}
            tickets={tickets}
            testItems={testItems}
            users={users}
            columns={colNames}
            versions={versions}
            onSave={handleSave}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {testModal && (
        <Modal
          title={testModal?._action === "add" ? `New ${testModal.type || "Test Item"}` : `Edit — ${testModal.id}`}
          onClose={() => setTestModal(null)} width={560}
        >
          <TestItemModal
            init={testModal?._action === "add" ? (({ _action, ...rest }) => rest)(testModal) : testModal}
            shipments={shipments}
            testItems={testItems}
            tickets={tickets}
            users={users}
            versions={versions}
            onSave={handleTestItemSave}
            onCancel={() => setTestModal(null)}
          />
        </Modal>
      )}

      {boardMgr && (
        <BoardManagerModal
          projects={projects}
          currentProject={currentProject}
          columns={columns}
          versions={versions}
          initialTab={boardMgr === true ? "columns" : boardMgr}
          onClose={() => setBoardMgr(false)}
          onRefresh={load}
          onProjectChange={switchProject}
        />
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
