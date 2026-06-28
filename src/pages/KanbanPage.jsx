import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../tokens";
import { inputBase } from "../components/primitives/Form";
import { api } from "../api";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Inp, Sel, Field, Textarea } from "../components/primitives/Form";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLUMNS = ["Ready", "In Progress", "Done", "Released"];

const SECTIONS = [
  "General", "Shipments", "Dashboard", "Vessels", "Port Locations",
  "Carriers", "Trade Lanes", "Countries", "UN Location Codes",
  "API / Backend", "UI / UX", "Landing Page", "Kanban",
];

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

const TicketModal = ({ init = {}, onSave, onCancel }) => {
  const isEdit = !!init.id;
  const [f, setF] = useState({
    title:       init.title       || "",
    section:     init.section     || "General",
    description: init.description || "",
    priority:    init.priority    || "Medium",
    status:      init.status      || "Ready",
  });
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const valid = f.title.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Inp label="Title" value={f.title} onChange={set("title")} placeholder="e.g. Wire VesselCombobox to ShipmentForm" required />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Sel label="Section" value={f.section} onChange={set("section")}
          options={SECTIONS.map(s => ({ value: s, label: s }))} />
        <Sel label="Priority" value={f.priority} onChange={set("priority")}
          options={PRIORITIES.map(p => ({ value: p, label: p }))} />
      </div>
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

// ─── Ticket Card ──────────────────────────────────────────────────────────────

const TicketCard = ({ ticket, onEdit, onDelete, onMove, colIndex }) => {
  const [confirm, setConfirm] = useState(false);
  const [dragging, setDragging] = useState(false);

  return (
    <>
      <div
        draggable
        onDragStart={e => { e.dataTransfer.setData("ticketId", ticket.id); setDragging(true); }}
        onDragEnd={() => setDragging(false)}
        style={{
          background: T.bg, border: `1px solid ${T.border}`,
          borderLeft:  `3px solid ${PRIORITY_DOT[ticket.priority] || T.border}`,
          borderRadius: 8, padding: "12px 14px", cursor: "grab",
          opacity: dragging ? 0.4 : 1, transition: "opacity .15s, box-shadow .15s",
          boxShadow: dragging ? "none" : "0 2px 8px rgba(0,0,0,.25)",
          userSelect: "none",
        }}
        onMouseEnter={e => { if (!dragging) e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,.4)"; }}
        onMouseLeave={e => e.currentTarget.style.boxShadow = dragging ? "none" : "0 2px 8px rgba(0,0,0,.25)"}
      >
        {/* Header row */}
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

        {/* Meta */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
          <Badge variant={PRIORITY_VARIANT[ticket.priority] || "default"}>{ticket.priority}</Badge>
          {ticket.section && (
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
              background: T.surface, border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 6px" }}>
              {ticket.section}
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
        <div style={{ display: "flex", gap: 5, justifyContent: "flex-end", borderTop: `1px solid ${T.border}22`, paddingTop: 8 }}>
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
                color: T.accent, cursor: "pointer", fontSize: 11, padding: "2px 8px", fontFamily: T.body, fontWeight: 600 }}>
              {COLUMNS[colIndex + 1].split(" ")[0]} →
            </button>
          )}
        </div>
      </div>

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

const KanbanColumn = ({ status, tickets, onEdit, onDelete, onMove, onDrop, colIndex }) => {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault(); setDragOver(false);
        const id = e.dataTransfer.getData("ticketId");
        if (id) onDrop(id, status);
      }}
      style={{
        flex: 1, minWidth: 220,
        background: dragOver ? `${COL_ACCENT[status]}11` : T.surface,
        border:     `1px solid ${dragOver ? COL_ACCENT[status] : T.border}`,
        borderTop:  `3px solid ${COL_ACCENT[status]}`,
        borderRadius: 10, padding: 14,
        transition: "background .15s, border-color .15s",
        display: "flex", flexDirection: "column", gap: 10,
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
        <TicketCard key={t.id} ticket={t} colIndex={colIndex}
          onEdit={onEdit} onDelete={onDelete} onMove={onMove} />
      ))}

      {/* Empty state */}
      {tickets.length === 0 && !dragOver && (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.border,
          fontStyle: "italic", textAlign: "center", padding: "20px 0" }}>
          Drop cards here
        </div>
      )}
    </div>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

const KanbanPage = () => {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | ticket obj
  const [filter,  setFilter]  = useState({ priority: "", section: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try { setTickets(await api.tickets.list()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, []);

  const byStatus = status => {
    let list = tickets.filter(t => t.status === status);
    if (filter.priority) list = list.filter(t => t.priority === filter.priority);
    if (filter.section)  list = list.filter(t => t.section === filter.section);
    return list.sort((a, b) => a.position - b.position);
  };

  const handleDrop = async (ticketId, newStatus) => {
    const t = tickets.find(x => x.id === ticketId);
    if (!t || t.status === newStatus) return;
    await api.tickets.update(ticketId, { ...t, status: newStatus, position: 9999 });
    load();
  };

  const handleMove = async (ticket, newStatus) => {
    await api.tickets.update(ticket.id, { ...ticket, status: newStatus, position: 9999 });
    load();
  };

  const handleEdit = async (ticket) => setModal(ticket);

  const handleDelete = async (id) => {
    await api.tickets.remove(id);
    setTickets(p => p.filter(t => t.id !== id));
  };

  const handleSave = async (form) => {
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
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* Filters */}
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
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", overflowX: "auto", flex: 1, paddingBottom: 8 }}>
          {COLUMNS.map((col, i) => (
            <KanbanColumn
              key={col} status={col} colIndex={i}
              tickets={byStatus(col)}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onMove={handleMove}
              onDrop={handleDrop}
            />
          ))}
        </div>
      )}

      {/* Modal */}
      {modal && (
        <Modal
          title={modal === "add" ? "New Ticket" : `Edit — ${modal.id}`}
          onClose={() => setModal(null)}
          width={520}
        >
          <TicketModal
            init={modal === "add" ? {} : modal}
            onSave={handleSave}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
    </div>
  );
};

export default KanbanPage;