import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../tokens";
import { inputBase } from "../components/primitives/Form";
import { api } from "../api";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Inp, Sel, Textarea } from "../components/primitives/Form";
import { CHANGELOG } from "../version";
import { toast } from "../toast";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLUMNS = ["Ready", "In Progress", "Done", "Released"];

const SECTIONS = [
  "General", "Shipments", "Dashboard", "Contracts", "Cost Control",
  "Vessels", "Port Locations", "Carriers", "Trade Lanes", "Countries",
  "UN Location Codes", "Customers", "API / Backend", "UI / UX", "Landing Page", "Kanban",
];

const LINK_TYPES = ["Relates to", "Blocks", "Duplicates", "Implements"];
const INVERSE_LABEL = { "Blocks": "Is blocked by", "Duplicates": "Is duplicated by", "Implements": "Is implemented by", "Relates to": "Relates to" };

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

// ─── Ticket Links Panel ───────────────────────────────────────────────────────

const TicketLinksPanel = ({ ticketId, allTickets = [] }) => {
  const [links,    setLinks]    = useState([]);
  const [adding,   setAdding]   = useState(false);
  const [search,   setSearch]   = useState("");
  const [linkType, setLinkType] = useState("Relates to");
  const [selected, setSelected] = useState(null);

  const load = () => api.tickets.links(ticketId).then(setLinks).catch(() => {});
  useEffect(() => { load(); }, [ticketId]);

  const linkedIds = new Set(links.map(l => l.otherTicketId));
  const candidates = search.trim().length > 1
    ? allTickets.filter(t =>
        t.id !== ticketId && !linkedIds.has(t.id) &&
        (t.id.toLowerCase().includes(search.toLowerCase()) ||
         t.title.toLowerCase().includes(search.toLowerCase()))
      ).slice(0, 6)
    : [];

  const handleAdd = async () => {
    if (!selected) return;
    try {
      await api.tickets.addLink(ticketId, { toId: selected.id, linkType });
      toast.success("Link added");
      setAdding(false); setSearch(""); setSelected(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleRemove = async linkId => {
    try {
      await api.tickets.removeLink(linkId);
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
      <div style={sectionLbl}>Links</div>

      {links.map(l => (
        <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 8,
          padding: "5px 10px", marginBottom: 4, borderRadius: 6,
          background: T.bg, border: `1px solid ${T.border}` }}>
          <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
            background: T.surface, border: `1px solid ${T.border}`, borderRadius: 4,
            padding: "1px 6px", flexShrink: 0, whiteSpace: "nowrap" }}>
            {l.displayType}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, flexShrink: 0 }}>
            {l.otherTicketId}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {l.otherTicket?.title || ""}
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
          No linked tickets.
        </div>
      )}

      {adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
          <input value={search}
            onChange={e => { setSearch(e.target.value); setSelected(null); }}
            placeholder="Search by ticket ID or title…" style={inp} autoFocus />
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
            <select value={linkType} onChange={e => setLinkType(e.target.value)}
              style={{ ...inp, flex: 1, width: "auto" }}>
              {LINK_TYPES.map(lt => <option key={lt}>{lt}</option>)}
            </select>
            <Btn size="sm" disabled={!selected} onClick={handleAdd}>Link</Btn>
            <Btn size="sm" variant="secondary" onClick={() => { setAdding(false); setSearch(""); setSelected(null); }}>Cancel</Btn>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)}
          style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
            border: `1px dashed ${T.accent}55`, borderRadius: 6, padding: "5px 12px",
            cursor: "pointer", width: "100%", textAlign: "left", marginTop: links.length ? 6 : 0 }}>
          ＋ Link ticket
        </button>
      )}
    </div>
  );
};

// ─── Ticket Modal ─────────────────────────────────────────────────────────────

const TicketModal = ({ init = {}, shipments = [], tickets = [], onSave, onCancel }) => {
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
      {isEdit && (
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <TicketLinksPanel ticketId={init.id} allTickets={tickets} />
        </div>
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

const TicketCard = ({ ticket, onEdit, onDelete, onMove, onPreview, colIndex,
                      isSelected, isDragging, dropIndicator,
                      onDragStart, onDragEnd, onDragOver }) => {
  const [confirm, setConfirm] = useState(false);
  const cardRef  = useRef(null);
  const dragged  = useRef(false);

  const handleDragOver = e => {
    e.preventDefault();
    e.stopPropagation();
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const mid  = rect.top + rect.height / 2;
    onDragOver(ticket.id, e.clientY < mid ? "before" : "after");
  };

  const stop = fn => e => { e.stopPropagation(); fn(); };

  return (
    <>
      {dropIndicator === "before" && <DropLine />}

      <div
        ref={cardRef}
        draggable
        onDragStart={e => { dragged.current = true; e.dataTransfer.setData("ticketId", ticket.id); onDragStart(ticket.id); }}
        onDragEnd={e => { dragged.current = false; onDragEnd(e); }}
        onDragOver={handleDragOver}
        onClick={() => { if (!dragged.current) onPreview(ticket); }}
        style={{
          background: isSelected ? `${T.accent}0d` : T.bg,
          border: `1px solid ${isSelected ? T.accent + "66" : T.border}`,
          borderLeft: `3px solid ${isSelected ? T.accent : (PRIORITY_DOT[ticket.priority] || T.border)}`,
          borderRadius: 8, padding: "12px 14px", cursor: "pointer",
          opacity: isDragging ? 0.35 : 1,
          transition: "opacity .15s, box-shadow .15s, border-color .15s, background .15s",
          boxShadow: isDragging ? "none" : isSelected ? `0 0 0 1px ${T.accent}33, 0 2px 8px rgba(0,0,0,.25)` : "0 2px 8px rgba(0,0,0,.25)",
          userSelect: "none",
        }}
        onMouseEnter={e => { if (!isDragging) e.currentTarget.style.boxShadow = isSelected ? `0 0 0 1px ${T.accent}33, 0 4px 16px rgba(0,0,0,.4)` : "0 4px 16px rgba(0,0,0,.4)"; }}
        onMouseLeave={e => e.currentTarget.style.boxShadow = isDragging ? "none" : isSelected ? `0 0 0 1px ${T.accent}33, 0 2px 8px rgba(0,0,0,.25)` : "0 2px 8px rgba(0,0,0,.25)"}
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
            <button onClick={stop(() => onMove(ticket, COLUMNS[colIndex - 1]))}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
                color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "2px 8px", fontFamily: T.body }}>
              ← {COLUMNS[colIndex - 1].split(" ")[0]}
            </button>
          )}
          <button onClick={stop(() => onEdit(ticket))}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
              color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "2px 8px", fontFamily: T.body }}>
            ✎
          </button>
          <button onClick={stop(() => setConfirm(true))}
            style={{ background: "none", border: `1px solid ${T.danger}44`, borderRadius: 4,
              color: T.danger, cursor: "pointer", fontSize: 11, padding: "2px 8px", fontFamily: T.body }}>
            ✕
          </button>
          {colIndex < COLUMNS.length - 1 && (
            <button onClick={stop(() => onMove(ticket, COLUMNS[colIndex + 1]))}
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

// ─── Ticket Preview Panel ─────────────────────────────────────────────────────

const TicketPreview = ({ ticket, colIndex, shipments, tickets, onClose, onEdit, onMove, onDelete }) => {
  const [confirm, setConfirm] = useState(false);
  const linked = shipments.find(s => s.id === ticket.shipmentId);

  const MetaRow = ({ label, children }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 24 }}>
      <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted,
        width: 68, flexShrink: 0 }}>
        {label}
      </span>
      {children}
    </div>
  );

  return (
    <div style={{
      width: 320, flexShrink: 0,
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderTop: `3px solid ${COL_ACCENT[ticket.status]}`,
      borderRadius: 10,
      display: "flex", flexDirection: "column",
      overflow: "hidden",
      alignSelf: "stretch",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span
          title="Click to copy ticket ID"
          onClick={() => navigator.clipboard.writeText(ticket.id).then(() => toast.success(`Copied ${ticket.id}`))}
          style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
            cursor: "pointer", userSelect: "none",
            padding: "2px 6px", borderRadius: 4, transition: "background .12s" }}
          onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
          {ticket.id}
        </span>
        <button onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer",
            color: T.textMuted, fontSize: 18, padding: "0 2px", lineHeight: 1 }}>
          ×
        </button>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px", display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Title */}
        <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, lineHeight: 1.45 }}>
          {ticket.title}
        </div>

        {/* Meta */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8,
          paddingBottom: 16, borderBottom: `1px solid ${T.border}` }}>
          <MetaRow label="Status">
            <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              color: COL_ACCENT[ticket.status],
              background: `${COL_ACCENT[ticket.status]}22`,
              border: `1px solid ${COL_ACCENT[ticket.status]}44`,
              borderRadius: 10, padding: "2px 10px" }}>
              {ticket.status}
            </span>
          </MetaRow>
          <MetaRow label="Type">
            <Badge variant={TYPE_VARIANT[ticket.type] || "default"}>{ticket.type}</Badge>
          </MetaRow>
          <MetaRow label="Priority">
            <Badge variant={PRIORITY_VARIANT[ticket.priority] || "default"}>{ticket.priority}</Badge>
          </MetaRow>
          {ticket.section && (
            <MetaRow label="Section">
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{ticket.section}</span>
            </MetaRow>
          )}
          {ticket.version && (
            <MetaRow label="Version">
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                color: "#8b5cf6", background: "rgba(139,92,246,.12)",
                border: "1px solid rgba(139,92,246,.3)", borderRadius: 4, padding: "2px 8px" }}>
                v{ticket.version}
              </span>
            </MetaRow>
          )}
          {ticket.shipmentId && (
            <MetaRow label="Shipment">
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent,
                background: `${T.accent}15`, border: `1px solid ${T.accent}33`,
                borderRadius: 4, padding: "2px 8px" }}>
                ⛴ {ticket.shipmentId}{linked ? ` · ${linked.pol}→${linked.pod}` : ""}
              </span>
            </MetaRow>
          )}
        </div>

        {/* Description */}
        <div>
          <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>
            Description
          </div>
          {ticket.description ? (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.text,
              lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
              {ticket.description}
            </div>
          ) : (
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
              No description provided.
            </div>
          )}
        </div>

        {/* Links */}
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
          <TicketLinksPanel ticketId={ticket.id} allTickets={tickets} />
        </div>
      </div>

      {/* Actions footer */}
      <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.border}`,
        display: "flex", gap: 6, flexShrink: 0 }}>
        {colIndex > 0 && (
          <button onClick={() => onMove(ticket, COLUMNS[colIndex - 1])}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
              color: T.textMuted, cursor: "pointer", fontSize: 11, padding: "5px 10px", fontFamily: T.body }}>
            ← {COLUMNS[colIndex - 1].split(" ")[0]}
          </button>
        )}
        <button onClick={onEdit}
          style={{ flex: 1, background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 5,
            color: T.accent, cursor: "pointer", fontSize: 12, padding: "5px 10px",
            fontFamily: T.body, fontWeight: 600 }}>
          ✎ Edit
        </button>
        {colIndex < COLUMNS.length - 1 && (
          <button onClick={() => onMove(ticket, COLUMNS[colIndex + 1])}
            style={{ background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 5,
              color: T.accent, cursor: "pointer", fontSize: 11, padding: "5px 10px",
              fontFamily: T.body, fontWeight: 600 }}>
            {COLUMNS[colIndex + 1].split(" ")[0]} →
          </button>
        )}
        <button onClick={() => setConfirm(true)}
          style={{ background: "none", border: `1px solid ${T.danger}44`, borderRadius: 5,
            color: T.danger, cursor: "pointer", fontSize: 11, padding: "5px 10px", fontFamily: T.body }}>
          ✕
        </button>
      </div>

      {confirm && (
        <ConfirmModal
          message={`Delete "${ticket.title}"?`}
          onConfirm={() => { setConfirm(false); onDelete(ticket.id); onClose(); }}
          onCancel={() => setConfirm(false)} />
      )}
    </div>
  );
};

// ─── Kanban Column ────────────────────────────────────────────────────────────

const KanbanColumn = ({ status, tickets, onEdit, onDelete, onMove, onPreview,
                        onDrop, colIndex, dragId, previewId }) => {
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
          isSelected={previewId === t.id}
          dropIndicator={dropTarget?.id === t.id ? dropTarget.side : null}
          onEdit={onEdit}
          onDelete={onDelete}
          onMove={onMove}
          onPreview={onPreview}
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
  const [tickets,   setTickets]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [modal,     setModal]     = useState(null);
  const [filter,    setFilter]    = useState({ priority: "", section: "" });
  const [dragId,    setDragId]    = useState(null);
  const [previewId, setPreviewId] = useState(null);

  // Derive preview from live tickets so it reflects edits/moves automatically
  const preview = previewId ? tickets.find(t => t.id === previewId) ?? null : null;

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
    setPreviewId(p => p === id ? null : p);
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

      {/* Board + preview */}
      {loading ? (
        <div style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted, padding: 40, textAlign: "center" }}>
          Loading board…
        </div>
      ) : (
        <div style={{ display: "flex", gap: 14, flex: 1, minHeight: 0 }}>
          {/* Columns */}
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
                onPreview={t => setPreviewId(p => p === t.id ? null : t.id)}
                dragId={dragId}
                previewId={previewId}
              />
            ))}
          </div>

          {/* Preview panel */}
          {preview && (
            <TicketPreview
              ticket={preview}
              colIndex={COLUMNS.indexOf(preview.status)}
              shipments={shipments}
              tickets={tickets}
              onClose={() => setPreviewId(null)}
              onEdit={() => setModal(preview)}
              onMove={handleMove}
              onDelete={handleDelete}
            />
          )}
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
            tickets={tickets}
            onSave={handleSave}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
    </div>
  );
};

export default KanbanPage;