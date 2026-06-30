import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../tokens";
import { inputBase } from "../components/primitives/Form";
import { api } from "../api";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Inp, Sel, Field, Textarea } from "../components/primitives/Form";
import { CHANGELOG } from "../version";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLUMNS = ["Ready", "In Progress", "Done", "Released"];

const SECTIONS = [
  "General", "Shipments", "Dashboard", "Vessels", "Port Locations",
  "Carriers", "Trade Lanes", "Countries", "UN Location Codes",
  "Customers", "API / Backend", "UI / UX", "Landing Page", "Kanban",
];

const TYPES = ["Feature", "Bug", "Improvement", "Task", "Chore"];

const TYPE_VARIANT = {
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
  "Ready":       "#6366f1",
  "In Progress": "#f59e0b",
  "Done":        "#22c55e",
  "Released":    "#8b5cf6",
};

// ─── Ticket Modal ─────────────────────────────────────────────────────────────

const TicketModal = ({ init = {}, shipments = [], onSave, onCancel }) => {
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
  });
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const valid = f.title.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Inp label="Title" value={f.title} onChange={set("title")} placeholder="e.g. Wire VesselCombobox to ShipmentForm" required />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Sel label="Type" value={f.type} onChange={set("type")}
          options={TYPES.map(t => ({ value: t, label: t }))} />
        <Sel label="Section" value={f.section} onChange={set("section")}
          options={SECTIONS.map(s => ({ value: s, label: s }))} />
        <Sel label="Priority" value={f.priority} onChange={set("priority")}
          options={PRIORITIES.map(p => ({ value: p, label: p }))} />
      </div>
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

const TicketCard = ({ ticket, onEdit, onDelete, onMove, colIndex,
                      isDragging, dropIndicator, onDragStart, onDragEnd, onDragOver }) => {
  const [confirm, setConfirm] = useState(false);
  const cardRef = useRef(null);

  const handleDragOver = e => {
    e.preventDefault();
    e.stopPropagation();
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const mid  = rect.top + rect.height / 2;
    onDragOver(ticket.id, e.clientY < mid ? "before" : "after");
  };

  return (
    <>
      {dropIndicator === "before" && <DropLine />}

      <div
        ref={cardRef}
        draggable
        onDragStart={e => { e.dataTransfer.setData("ticketId", ticket.id); onDragStart(ticket.id); }}
        onDragEnd={onDragEnd}
        onDragOver={handleDragOver}
        style={{
          background: T.bg, border: `1px solid ${T.border}`,
          borderLeft:  `3px solid ${PRIORITY_DOT[ticket.priority] || T.border}`,
          borderRadius: 8, padding: "12px 14px", cursor: "grab",
          opacity: isDragging ? 0.35 : 1,
          transition: "opacity .15s, box-shadow .15s",
          boxShadow: isDragging ? "none" : "0 2px 8px rgba(0,0,0,.25)",
          userSelect: "none",
        }}
        onMouseEnter={e => { if (!isDragging) e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,.4)"; }}
        onMouseLeave={e => e.currentTarget.style.boxShadow = isDragging ? "none" : "0 2px 8px rgba(0,0,0,.25)"}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text, lineHeight: 1.4 }}>
              {ticket.title}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, marginTop: 2 }}>
              {ticket.id}
            </div>
          </div>
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

        {/* Actions */}
        <div style={{ display: "flex", gap: 5, justifyContent: "flex-end",
          borderTop: `1px solid ${T.border}22`, paddingTop: 8 }}>
          {colIndex > 0 && (
            <button onClick={() => onMove(ticket, COLUMNS[colIndex - 1])}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
                color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "2px 8px", fontFamily: T.body }}>
              ← {COLUMNS[colIndex - 1].split(" ")[0]}
            </button>
          )}
          <button onClick={() => onEdit(ticket)}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
              color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "2px 8px", fontFamily: T.body }}>
            ✎
          </button>
          <button onClick={() => setConfirm(true)}
            style={{ background: "none", border: `1px solid ${T.danger}44`, borderRadius: 4,
              color: T.danger, cursor: "pointer", fontSize: 11, padding: "2px 8px", fontFamily: T.body }}>
            ✕
          </button>
          {colIndex < COLUMNS.length - 1 && (
            <button onClick={() => onMove(ticket, COLUMNS[colIndex + 1])}
              style={{ background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 4,
                color: T.accent, cursor: "pointer", fontSize: 11, padding: "2px 8px",
                fontFamily: T.body, fontWeight: 600 }}>
              {COLUMNS[colIndex + 1].split(" ")[0]} →
            </button>
          )}
        </div>
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

// ─── Kanban Column ────────────────────────────────────────────────────────────

const KanbanColumn = ({ status, tickets, onEdit, onDelete, onMove,
                        onDrop, colIndex, dragId }) => {
  // { id: ticketId, side: "before"|"after" } — where the drop line appears
  const [dropTarget, setDropTarget] = useState(null);
  const [colDragOver, setColDragOver] = useState(false);

  const clearDrop = () => { setDropTarget(null); setColDragOver(false); };

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
          <span style={{
            fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            color: COL_ACCENT[status],
            background: `${COL_ACCENT[status]}22`,
            border: `1px solid ${COL_ACCENT[status]}44`,
            borderRadius: 10, padding: "1px 8px",
          }}>{tickets.length}</span>
        </div>
      </div>

      {/* Cards */}
      {tickets.map(t => (
        <TicketCard
          key={t.id}
          ticket={t}
          colIndex={colIndex}
          isDragging={dragId === t.id}
          dropIndicator={dropTarget?.id === t.id ? dropTarget.side : null}
          onEdit={onEdit}
          onDelete={onDelete}
          onMove={onMove}
          onDragStart={id => setDropTarget(null)}
          onDragEnd={() => clearDrop()}
          onDragOver={handleCardDragOver}
        />
      ))}

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

// ─── Page ─────────────────────────────────────────────────────────────────────

const KanbanPage = ({ shipments = [] }) => {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null);
  const [filter,  setFilter]  = useState({ priority: "", section: "" });
  const [dragId,  setDragId]  = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setTickets(await api.tickets.list()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, []);

  const byStatus = status => {
    let list = tickets.filter(t => t.status === status);
    if (filter.priority) list = list.filter(t => t.priority === filter.priority);
    if (filter.section)  list = list.filter(t => t.section  === filter.section);
    return list.sort((a, b) => a.position - b.position);
  };

  const handleDrop = async (ticketId, newStatus, targetId, side) => {
    const dragged = tickets.find(t => t.id === ticketId);
    if (!dragged) return;
    setDragId(null);

    // ── Cross-column move ──────────────────────────────────────────────────────
    if (dragged.status !== newStatus) {
      const colCards = tickets
        .filter(t => t.status === newStatus)
        .sort((a, b) => a.position - b.position);
      const newPos = colCards.length > 0 ? colCards[colCards.length - 1].position + 1 : 0;
      const updated = { ...dragged, status: newStatus, position: newPos };
      setTickets(prev => prev.map(t => t.id === ticketId ? updated : t));
      await api.tickets.update(ticketId, updated);
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
    const colCards = tickets
      .filter(t => t.status === newStatus)
      .sort((a, b) => a.position - b.position);
    const newPos = colCards.length > 0 ? colCards[colCards.length - 1].position + 1 : 0;
    const updated = { ...ticket, status: newStatus, position: newPos };
    setTickets(prev => prev.map(t => t.id === ticket.id ? updated : t));
    await api.tickets.update(ticket.id, updated);
  };

  const handleDelete = async id => {
    await api.tickets.remove(id);
    setTickets(p => p.filter(t => t.id !== id));
  };

  const handleSave = async form => {
    if (modal === "add") {
      await api.tickets.create(form);
    } else {
      await api.tickets.update(modal.id, { ...modal, ...form });
    }
    setModal(null);
    load();
  };

  const totalOpen = tickets.filter(t => t.status !== "Released").length;

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
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <select value={filter.priority} onChange={e => setFilter(f => ({ ...f, priority: e.target.value }))}
            style={{ ...inputBase, fontFamily: T.body, fontSize: 13, width: 130, cursor: "pointer" }}>
            <option value="">All priorities</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={filter.section} onChange={e => setFilter(f => ({ ...f, section: e.target.value }))}
            style={{ ...inputBase, fontFamily: T.body, fontSize: 13, width: 150, cursor: "pointer" }}>
            <option value="">All sections</option>
            {SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <Btn onClick={() => setModal("add")} size="lg">＋ Add Ticket</Btn>
        </div>
      </div>

      {/* Board */}
      {loading ? (
        <div style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted, padding: 40, textAlign: "center" }}>
          Loading board…
        </div>
      ) : (
        <div
          style={{ display: "flex", gap: 14, alignItems: "flex-start", overflowX: "auto", flex: 1, paddingBottom: 8 }}
          onDragEnd={() => setDragId(null)}
        >
          {COLUMNS.map((col, i) => (
            <KanbanColumn
              key={col} status={col} colIndex={i}
              tickets={byStatus(col)}
              onEdit={t => setModal(t)}
              onDelete={handleDelete}
              onMove={handleMove}
              onDrop={handleDrop}
              dragId={dragId}
            />
          ))}
        </div>
      )}

      {modal && (
        <Modal
          title={modal === "add" ? "New Ticket" : `Edit — ${modal.id}`}
          onClose={() => setModal(null)} width={520}
        >
          <TicketModal
            init={modal === "add" ? {} : modal}
            shipments={shipments}
            onSave={handleSave}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
    </div>
  );
};

export default KanbanPage;