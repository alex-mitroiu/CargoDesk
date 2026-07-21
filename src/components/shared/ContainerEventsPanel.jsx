import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Btn from "../primitives/Btn";
import { inputBase } from "../primitives/Form";
import { AnyIcon, IconPackage, IconDoor, IconArrowUp, IconArrowDown, IconShip, IconRefresh } from "../primitives/Icon";

// ─── Container Lifecycle Events Panel ─────────────────────────────────────────
// FCL container movement: Empty Pickup → Gate In → Loaded → Sailed → Discharged
// → Gate Out → Empty Return. Foundation for demurrage/detention tracking.

export const CONTAINER_EVENT_TYPES = ["Empty Pickup", "Gate In", "Loaded", "Sailed", "Discharged", "Gate Out", "Empty Return"];

const EVENT_ICON = {
  "Empty Pickup": IconPackage, "Gate In": IconDoor, "Loaded": IconArrowUp, "Sailed": IconShip,
  "Discharged": IconArrowDown, "Gate Out": IconDoor, "Empty Return": IconRefresh,
};

const fmtDate = iso => {
  try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return iso; }
};

const ContainerEventsPanel = ({ containerId, containerNumber }) => {
  const { canEdit } = useAuth();
  const [events,     setEvents]     = useState(null); // null = loading
  const [adding,     setAdding]     = useState(false);
  const [eventType,  setEventType]  = useState(CONTAINER_EVENT_TYPES[0]);
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [location,   setLocation]   = useState("");
  const [notes,      setNotes]      = useState("");
  const [saving,     setSaving]     = useState(false);

  const load = () => api.containers.events(containerId).then(setEvents).catch(() => setEvents([]));
  useEffect(() => { load(); }, [containerId]);

  const usedTypes     = new Set((events || []).map(e => e.eventType));
  const nextSuggested = CONTAINER_EVENT_TYPES.find(t => !usedTypes.has(t)) || CONTAINER_EVENT_TYPES[0];

  const handleAdd = async () => {
    if (!occurredAt) return;
    setSaving(true);
    try {
      await api.containers.addEvent(containerId, {
        eventType, occurredAt, location: location.trim(), notes: notes.trim(),
      });
      setAdding(false); setLocation(""); setNotes("");
      await load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const handleRemove = async id => {
    try {
      await api.containers.removeEvent(id);
      setEvents(list => list.filter(e => e.id !== id));
    } catch (e) { toast.error(e.message); }
  };

  const selStyle = { ...inputBase, fontFamily: T.body, fontSize: 12, cursor: "pointer" };
  const inpStyle = { ...inputBase, fontFamily: T.body, fontSize: 12 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
        {containerNumber || containerId}
      </div>

      {events === null && (
        <div style={{ padding: "24px 0", textAlign: "center", fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          Loading events…
        </div>
      )}

      {events !== null && events.length === 0 && (
        <div style={{ padding: "20px 0", textAlign: "center", fontFamily: T.body, fontSize: 12,
          color: T.textMuted, fontStyle: "italic" }}>
          No lifecycle events logged yet.
        </div>
      )}

      {events !== null && events.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {events.map(ev => (
            <div key={ev.id} style={{ display: "flex", alignItems: "flex-start", gap: 10,
              padding: "9px 12px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1, display: "inline-flex", color: T.textMuted }}>
                <AnyIcon icon={EVENT_ICON[ev.eventType] || "•"} size={16} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: T.body, fontSize: 12.5, fontWeight: 700, color: T.text }}>
                    {ev.eventType}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{fmtDate(ev.occurredAt)}</span>
                </div>
                {(ev.location || ev.notes) && (
                  <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginTop: 2 }}>
                    {ev.location}{ev.location && ev.notes ? " · " : ""}{ev.notes}
                  </div>
                )}
                {ev.recordedBy && (
                  <div style={{ fontFamily: T.body, fontSize: 10, color: T.border, marginTop: 2 }}>
                    logged by {ev.recordedBy}
                  </div>
                )}
              </div>
              {canEdit && (
                <button type="button" onClick={() => handleRemove(ev.id)} title="Delete event"
                  style={{ background: "none", border: "none", cursor: "pointer",
                    color: T.textMuted, fontSize: 14, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
                  onMouseEnter={e => e.currentTarget.style.color = T.danger}
                  onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12,
          borderRadius: 8, border: `1px dashed ${T.accent}55`, background: T.bg }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 8 }}>
            <select value={eventType} onChange={e => setEventType(e.target.value)} style={selStyle}>
              {CONTAINER_EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input type="date" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} style={inpStyle} />
          </div>
          <input value={location} onChange={e => setLocation(e.target.value)}
            placeholder="Location (optional)" style={inpStyle} />
          <input value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Notes (optional)" style={inpStyle} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn size="sm" variant="secondary" onClick={() => setAdding(false)}>Cancel</Btn>
            <Btn size="sm" disabled={saving || !occurredAt} onClick={handleAdd}>
              {saving ? "Saving…" : "Log Event"}
            </Btn>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => { setEventType(nextSuggested); setAdding(true); }}
          style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
            border: `1px dashed ${T.accent}55`, borderRadius: 6, padding: "7px 12px",
            cursor: "pointer", width: "100%", textAlign: "center" }}>
          ＋ Log Event
        </button>
      ))}
    </div>
  );
};

export default ContainerEventsPanel;
