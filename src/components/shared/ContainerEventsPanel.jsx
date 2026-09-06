import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Btn from "../primitives/Btn";
import { inputBase } from "../primitives/Form";
import { AnyIcon, IconPackage, IconDoor, IconArrowUp, IconArrowDown, IconShip, IconRefresh, IconWarning, IconFile } from "../primitives/Icon";

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

const ContainerEventsPanel = ({ shipmentId, containerId, containerNumber }) => {
  const { canEdit } = useAuth();
  const [events,          setEvents]          = useState(null); // null = loading
  const [adding,          setAdding]          = useState(false);
  const [eventType,       setEventType]       = useState(CONTAINER_EVENT_TYPES[0]);
  const [occurredAt,      setOccurredAt]      = useState(() => new Date().toISOString().slice(0, 10));
  const [location,        setLocation]        = useState("");
  const [notes,           setNotes]           = useState("");
  const [damageFlag,      setDamageFlag]      = useState(false);
  const [conditionNotes,  setConditionNotes]  = useState("");
  const [chassisProvider, setChassisProvider] = useState("");
  const [photoFile,       setPhotoFile]       = useState(null);
  const [saving,          setSaving]          = useState(false);

  const load = () => api.containers.events(shipmentId, containerId).then(setEvents).catch(() => setEvents([]));
  useEffect(() => { load(); }, [containerId]);

  const usedTypes     = new Set((events || []).map(e => e.eventType));
  const nextSuggested = CONTAINER_EVENT_TYPES.find(t => !usedTypes.has(t)) || CONTAINER_EVENT_TYPES[0];

  const resetForm = () => {
    setAdding(false); setLocation(""); setNotes(""); setDamageFlag(false);
    setConditionNotes(""); setChassisProvider(""); setPhotoFile(null);
  };

  // Equipment condition capture (EIR, TKT-QSUTQ7) — a disputed detention charge almost
  // always comes down to proving condition at a specific gate movement, so a photo attached
  // here is uploaded through the existing generic document mechanism (reused, not a new
  // subsystem) and tagged with this specific event's id, not just the container in general.
  const uploadPhoto = (shipmentId, eventId) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        await api.documents.upload(shipmentId, {
          filename: photoFile.name, mimeType: photoFile.type, docType: "OT",
          data: e.target.result.split(",")[1], containerId, containerEventId: eventId,
        });
        resolve();
      } catch (ex) { reject(ex); }
    };
    reader.onerror = reject;
    reader.readAsDataURL(photoFile);
  });

  const handleAdd = async () => {
    if (!occurredAt) return;
    setSaving(true);
    try {
      const created = await api.containers.addEvent(shipmentId, containerId, {
        eventType, occurredAt, location: location.trim(), notes: notes.trim(),
        damageFlag, conditionNotes: conditionNotes.trim(), chassisProvider: chassisProvider.trim(),
      });
      if (photoFile) {
        try { await uploadPhoto(created.shipmentId, created.id); }
        catch (ex) { toast.warning(`Event logged, but the photo failed to upload: ${ex.message}`); }
      }
      resetForm();
      await load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const handleRemove = async id => {
    try {
      await api.containers.removeEvent(shipmentId, id);
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
                  {ev.damageFlag && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4,
                      fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.danger,
                      background: `${T.danger}18`, border: `1px solid ${T.danger}55`,
                      borderRadius: 20, padding: "2px 8px" }}>
                      <AnyIcon icon={IconWarning} size={11} /> Damage Reported
                    </span>
                  )}
                </div>
                {(ev.location || ev.notes) && (
                  <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginTop: 2 }}>
                    {ev.location}{ev.location && ev.notes ? " · " : ""}{ev.notes}
                  </div>
                )}
                {ev.conditionNotes && (
                  <div style={{ fontFamily: T.body, fontSize: 11.5, color: ev.damageFlag ? T.danger : T.textMuted,
                    marginTop: 2, fontStyle: "italic" }}>
                    Condition: {ev.conditionNotes}
                  </div>
                )}
                {ev.chassisProvider && (
                  <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                    Chassis: {ev.chassisProvider}
                  </div>
                )}
                {ev.photos?.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    {ev.photos.map(p => (
                      <button key={p.id} type="button" onClick={() => api.documents.download(shipmentId, p.id, p.filename).catch(e => toast.error(e.message))}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: T.body,
                        fontSize: 10.5, color: T.accent, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                        <AnyIcon icon={IconFile} size={11} /> {p.filename}
                      </button>
                    ))}
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
          <input value={chassisProvider} onChange={e => setChassisProvider(e.target.value)}
            placeholder="Chassis provider (optional)" style={inpStyle} />

          <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
            fontFamily: T.body, fontSize: 12, color: T.text }}>
            <input type="checkbox" checked={damageFlag} onChange={e => setDamageFlag(e.target.checked)} />
            Damage found at this movement
          </label>
          <input value={conditionNotes} onChange={e => setConditionNotes(e.target.value)}
            placeholder="Condition / damage notes (optional)" style={inpStyle} />
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: T.body,
            fontSize: 11, color: T.textMuted }}>
            Attach a condition photo (optional)
            <input type="file" accept="image/*,application/pdf"
              onChange={e => setPhotoFile(e.target.files?.[0] || null)} style={{ fontSize: 11 }} />
          </label>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn size="sm" variant="secondary" onClick={resetForm}>Cancel</Btn>
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
