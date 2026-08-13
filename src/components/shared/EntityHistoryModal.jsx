import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { Modal } from "../primitives/Modal";
import Spinner from "../primitives/spinner";
import { api } from "../../api";

const EVENT_CONFIG = {
  CREATED:   { icon: "✦", label: "Created",       color: () => T.success },
  UPDATED:   { icon: "✎", label: "Updated",       color: () => T.accent  },
  DELETED:   { icon: "✕", label: "Deleted",       color: () => T.danger  },
  PUBLISHED: { icon: "▲", label: "Published",     color: () => T.success },
  WITHDRAWN: { icon: "▽", label: "Withdrawn to Draft", color: () => T.warning },
};

const fmt = iso => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
};

const MetaRow = ({ label, value }) =>
  value ? (
    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
      <span style={{ color: T.border }}>{label}: </span>{value}
    </span>
  ) : null;

const EventRow = ({ ev }) => {
  const cfg = EVENT_CONFIG[ev.eventType] || { icon: "·", label: ev.eventType, color: () => T.textMuted };
  const color = cfg.color();

  const metaPills = ev.meta ? Object.entries(ev.meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => ({ k, v: String(v) })) : [];

  return (
    <div style={{ display: "flex", gap: 12, padding: "14px 0", borderBottom: `1px solid ${T.border}22` }}>
      <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: "50%",
        background: color + "18", border: `1.5px solid ${color}44`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 13, color }}>
        {cfg.icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>{cfg.label}</span>
          <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>{fmt(ev.createdAt)}</span>
        </div>
        {ev.field && (
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 4 }}>
            Field: <span style={{ fontFamily: T.mono, color: T.text }}>{ev.field}</span>
            {ev.oldValue !== null && ev.oldValue !== undefined && (
              <> · <span style={{ textDecoration: "line-through", color: T.danger }}>{ev.oldValue}</span>
                {" → "}
                <span style={{ color: T.success }}>{ev.newValue}</span>
              </>
            )}
          </div>
        )}
        {metaPills.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
            {metaPills.map(({ k, v }) => (
              <span key={k} style={{
                fontFamily: T.mono, fontSize: 10.5,
                background: T.bg, border: `1px solid ${T.border}`,
                borderRadius: 4, padding: "2px 8px", color: T.textMuted,
              }}>
                {k}: {v}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const EntityHistoryModal = ({ entityType, entityId, title, headerContent, onClose }) => {
  const [events,  setEvents]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    setLoading(true);
    api.entityEvents.list(entityType, entityId)
      .then(setEvents)
      .catch(e => setError(e.message || "Failed to load history"))
      .finally(() => setLoading(false));
  }, [entityType, entityId]);

  return (
    <Modal title={title || "History"} onClose={onClose} width={600}>
      {headerContent && (
        <div style={{
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
          padding: "12px 16px", marginBottom: 20,
          display: "flex", flexWrap: "wrap", gap: "6px 20px",
        }}>
          {headerContent}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "48px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <Spinner />
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading history…</span>
        </div>
      ) : error ? (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.danger, textAlign: "center", padding: "32px 0" }}>{error}</div>
      ) : events.length === 0 ? (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>📋</div>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted }}>No history recorded yet.</div>
        </div>
      ) : (
        <div style={{ maxHeight: 480, overflowY: "auto", paddingRight: 4 }}>
          {events.map(ev => <EventRow key={ev.id} ev={ev} />)}
        </div>
      )}
    </Modal>
  );
};

export default EntityHistoryModal;
