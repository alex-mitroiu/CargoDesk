import { useState, useEffect, useMemo, useCallback } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { toast } from "../toast";
import Spinner from "../components/primitives/Spinner";
import Badge from "../components/primitives/Badge";

// ─── Constants ────────────────────────────────────────────────────────────────

const VER_STATUSES = ["Planning", "In Development", "Released", "Archived"];

const VER_COLOR = {
  "Planning":       "#6366f1",
  "In Development": "#3b82f6",
  "Released":       "#22c55e",
  "Archived":       "#94a3b8",
};

const DONE_STATUSES = new Set(["Done", "Ready to Deploy", "Released"]);

const TYPE_ICON = {
  Epic: "⚡", Story: "📖", Feature: "✨", Bug: "🦟",
  Improvement: "🔨", Task: "☑", Chore: "🔧",
  "Test Plan": "📋", "Test Run": "▶", "Test Case": "🧪", "Test Folder": "📁",
};
const TYPE_VARIANT = {
  Epic: "warning", Story: "info", Feature: "info", Bug: "danger",
  Improvement: "success", Task: "default", Chore: "warning",
  "Test Plan": "warning", "Test Run": "info", "Test Case": "default", "Test Folder": "warning",
};
const PRIORITY_DOT = {
  Critical: "#ef4444", High: "#f59e0b", Medium: "#3b82f6", Low: "#94a3b8",
};

// ─── SegBar ───────────────────────────────────────────────────────────────────

const SegBar = ({ done, total, width = "100%", height = 6 }) => {
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height, borderRadius: 3, background: T.border, overflow: "hidden", width }}>
        <div style={{ height: "100%", width: `${pct}%`, borderRadius: 3,
          background: pct === 100 ? T.success : T.accent, transition: "width .3s" }} />
      </div>
      <span style={{ fontFamily: T.mono, fontSize: 11, color: pct === 100 ? T.success : T.textMuted,
        flexShrink: 0, minWidth: 36, textAlign: "right" }}>
        {pct === 100 ? "✓ 100%" : `${done}/${total}`}
      </span>
    </div>
  );
};

// ─── Version Form Modal ───────────────────────────────────────────────────────

const VersionModal = ({ init, projectId, onSave, onCancel }) => {
  const [f, setF] = useState({
    name:        init?.name        || "",
    description: init?.description || "",
    status:      init?.status      || "Planning",
    releaseDate: init?.releaseDate || "",
  });
  const [saving, setSaving] = useState(false);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  const handleSave = async () => {
    if (!f.name.trim()) return toast.error("Version name is required");
    setSaving(true);
    try {
      const payload = { ...f, name: f.name.trim(), releaseDate: f.releaseDate || null };
      const saved = init?.id
        ? await api.versions.update(init.id, payload)
        : await api.versions.create(projectId, payload);
      onSave(saved);
    } catch { toast.error("Failed to save version"); }
    finally { setSaving(false); }
  };

  const inp = (label, key, type = "text", placeholder = "") => (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600,
        color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</label>
      <input type={type} value={f[key]} onChange={set(key)} placeholder={placeholder}
        style={{ fontFamily: T.body, fontSize: 13, color: T.text, background: T.surface,
          border: `1px solid ${T.border}`, borderRadius: 7, padding: "7px 10px", outline: "none", width: "100%" }} />
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 9000,
      display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
        width: 440, boxShadow: "0 20px 60px rgba(0,0,0,.25)", overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
            {init ? "Edit Version" : "New Version"}
          </span>
          <button onClick={onCancel} style={{ background: "none", border: "none",
            cursor: "pointer", color: T.textMuted, fontSize: 18, lineHeight: 1, padding: 2 }}>✕</button>
        </div>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          {inp("Version name *", "name", "text", "e.g. v1.2.0 — Sprint 8")}
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600,
              color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>Status</label>
            <select value={f.status} onChange={set("status")}
              style={{ fontFamily: T.body, fontSize: 13, color: T.text, background: T.surface,
                border: `1px solid ${T.border}`, borderRadius: 7, padding: "7px 10px", outline: "none" }}>
              {VER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {inp("Release date", "releaseDate", "date")}
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600,
              color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>Description</label>
            <textarea value={f.description} onChange={set("description")} rows={3}
              placeholder="What does this release include?"
              style={{ fontFamily: T.body, fontSize: 13, color: T.text, background: T.surface,
                border: `1px solid ${T.border}`, borderRadius: 7, padding: "7px 10px",
                outline: "none", resize: "vertical", width: "100%" }} />
          </div>
        </div>
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${T.border}`,
          display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel}
            style={{ fontFamily: T.body, fontSize: 13, padding: "7px 14px", borderRadius: 7,
              border: `1px solid ${T.border}`, background: "transparent", color: T.text, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            style={{ fontFamily: T.body, fontSize: 13, padding: "7px 16px", borderRadius: 7,
              border: "none", background: T.accent, color: "#fff", cursor: saving ? "default" : "pointer",
              opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save Version"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Ticket row ───────────────────────────────────────────────────────────────

const TicketRow = ({ t }) => {
  const [hov, setHov] = useState(false);
  const done = DONE_STATUSES.has(t.status);
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px",
        borderBottom: `1px solid ${T.border}22`,
        background: hov ? T.border + "18" : "transparent", transition: "background .1s" }}>
      <span style={{ fontSize: 13, flexShrink: 0, opacity: done ? 0.5 : 1 }}>
        {done ? "✓" : (TYPE_ICON[t.type] || "☑")}
      </span>
      <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
        background: PRIORITY_DOT[t.priority] || T.border }} />
      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, flexShrink: 0 }}>{t.id}</span>
      <Badge variant={TYPE_VARIANT[t.type] || "default"} style={{ fontSize: 9, flexShrink: 0 }}>{t.type}</Badge>
      <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        textDecoration: done ? "line-through" : "none", opacity: done ? 0.6 : 1 }}>
        {t.title}
      </span>
      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
        flexShrink: 0, padding: "2px 7px", borderRadius: 4,
        background: T.border + "44" }}>{t.status}</span>
      {t.assigneeName && (
        <span title={t.assigneeName}
          style={{ width: 22, height: 22, borderRadius: "50%", background: T.accent,
            color: "#fff", fontSize: 10, fontWeight: 700, fontFamily: T.mono,
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          {t.assigneeInitial || t.assigneeName[0]}
        </span>
      )}
    </div>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReleasesPage() {
  const { canEdit } = useAuth();
  const [projects,  setProjects]  = useState([]);
  const [projId,    setProjId]    = useState(null);
  const [versions,  setVersions]  = useState([]);
  const [tickets,   setTickets]   = useState([]);
  const [selVer,    setSelVer]    = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [modal,     setModal]     = useState(null); // null | "new" | version-object

  // ── Load ────────────────────────────────────────────────────────────────────

  const loadAll = useCallback(async (pid) => {
    setLoading(true);
    try {
      const [vers, tix] = await Promise.all([
        api.versions.list(pid),
        api.tickets.list({ projectId: pid }),
      ]);
      setVersions(vers);
      setTickets(tix);
      setSelVer(v => {
        if (v && vers.find(x => x.id === v.id)) return vers.find(x => x.id === v.id);
        return vers[0] || null;
      });
    } catch { toast.error("Failed to load releases"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const projs = await api.projects.list();
        setProjects(projs);
        if (projs.length) {
          setProjId(projs[0].id);
          await loadAll(projs[0].id);
        } else { setLoading(false); }
      } catch { toast.error("Failed to load projects"); setLoading(false); }
    })();
  }, [loadAll]);

  const switchProject = async (id) => {
    setProjId(id);
    setSelVer(null);
    await loadAll(id);
  };

  // ── Version CRUD ────────────────────────────────────────────────────────────

  const handleSaveVersion = (saved) => {
    setVersions(prev => {
      const idx = prev.findIndex(v => v.id === saved.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
      return [...prev, saved];
    });
    setSelVer(saved);
    setModal(null);
    toast.success(modal === "new" ? "Version created" : "Version updated");
  };

  const handleDelete = async (ver) => {
    if (!window.confirm(`Delete version "${ver.name}"? Tickets will become unversioned.`)) return;
    try {
      await api.versions.remove(ver.id);
      const next = versions.filter(v => v.id !== ver.id);
      setVersions(next);
      setSelVer(next[0] || null);
      toast.success("Version deleted");
    } catch { toast.error("Failed to delete version"); }
  };

  // ── Derived ─────────────────────────────────────────────────────────────────

  const verTickets = useMemo(() =>
    selVer ? tickets.filter(t => t.versionId === selVer.id) : [],
  [selVer, tickets]);

  const unversioned = useMemo(() =>
    tickets.filter(t => !t.versionId),
  [tickets]);

  const done  = verTickets.filter(t => DONE_STATUSES.has(t.status)).length;
  const total = verTickets.length;

  const verColor = v => VER_COLOR[v.status] || T.textMuted;

  // ── Left nav item ────────────────────────────────────────────────────────────

  const VerItem = ({ ver }) => {
    const isActive = selVer?.id === ver.id;
    const cnt      = tickets.filter(t => t.versionId === ver.id).length;
    const col      = verColor(ver);
    return (
      <div onClick={() => setSelVer(ver)}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px",
          borderRadius: 7, cursor: "pointer", transition: "background .1s",
          background: isActive ? T.accent + "18" : "transparent",
          border: isActive ? `1px solid ${T.accent}33` : "1px solid transparent",
          margin: "1px 0" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: col }} />
        <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: isActive ? 600 : 400,
          color: isActive ? T.accent : T.text, flex: 1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {ver.name}
        </span>
        {cnt > 0 && (
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, flexShrink: 0 }}>{cnt}</span>
        )}
      </div>
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
      height: "100%", color: T.textMuted }}>
      <Spinner size="md" />
    </div>
  );

  return (
    <>
      <div style={{ display: "flex", height: "100%", overflow: "hidden", fontFamily: T.body }}>

        {/* ── Left panel ── */}
        <div style={{ width: 220, flexShrink: 0, display: "flex", flexDirection: "column",
          borderRight: `1px solid ${T.border}`, background: T.bg, overflow: "hidden" }}>

          {/* Project picker */}
          <div style={{ padding: "12px 10px 10px", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Project</div>
            {projects.length > 1 ? (
              <select value={projId || ""} onChange={e => switchProject(e.target.value)}
                style={{ width: "100%", fontFamily: T.body, fontSize: 12, color: T.text,
                  background: T.surface, border: `1px solid ${T.border}`, borderRadius: 7,
                  padding: "6px 8px", outline: "none", cursor: "pointer" }}>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : (
              <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text,
                padding: "4px 2px" }}>
                {projects[0]?.name || "—"}
              </div>
            )}
          </div>

          {/* Versions list */}
          <div style={{ flex: 1, overflowY: "auto", padding: "10px 8px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
              paddingLeft: 4, paddingRight: 2, marginBottom: 6 }}>
              <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
                textTransform: "uppercase", letterSpacing: ".06em" }}>Versions</span>
              {canEdit && projId && (
                <button onClick={() => setModal("new")}
                  title="New version"
                  style={{ background: "none", border: "none", cursor: "pointer",
                    color: T.accent, fontSize: 16, lineHeight: 1, padding: "2px 4px",
                    borderRadius: 4 }}>＋</button>
              )}
            </div>
            {versions.length === 0 ? (
              <div style={{ padding: "12px 6px", fontFamily: T.body, fontSize: 12,
                color: T.textMuted, fontStyle: "italic" }}>
                No versions yet.{canEdit && " Click ＋ to create one."}
              </div>
            ) : (
              versions.map(v => <VerItem key={v.id} ver={v} />)
            )}

            {/* Unversioned bucket */}
            {unversioned.length > 0 && (
              <>
                <div style={{ margin: "12px 0 6px", height: 1, background: T.border }} />
                <div onClick={() => setSelVer({ id: "__unversioned__", name: "Unversioned",
                  status: "Planning", description: "Tickets not yet assigned to a version." })}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px",
                    borderRadius: 7, cursor: "pointer",
                    background: selVer?.id === "__unversioned__" ? T.border + "30" : "transparent",
                    border: selVer?.id === "__unversioned__" ? `1px solid ${T.border}` : "1px solid transparent" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: T.border }} />
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, flex: 1 }}>
                    Unversioned
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{unversioned.length}</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Right panel ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {!selVer ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", height: "100%", gap: 12, color: T.textMuted }}>
              <div style={{ fontSize: 48 }}>🏷</div>
              <div style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text }}>
                No versions defined
              </div>
              <div style={{ fontFamily: T.body, fontSize: 13 }}>
                {canEdit && projId ? 'Click ＋ to create the first version for this project.' : 'No versions have been created for this project yet.'}
              </div>
              {canEdit && projId && (
                <button onClick={() => setModal("new")}
                  style={{ marginTop: 8, padding: "8px 18px", borderRadius: 8,
                    background: T.accent, color: "#fff", border: "none",
                    fontFamily: T.body, fontSize: 13, cursor: "pointer" }}>
                  New Version
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Version header */}
              <div style={{ padding: "16px 24px 14px", borderBottom: `1px solid ${T.border}`,
                background: T.bg, flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontFamily: T.head, fontSize: 20, fontWeight: 800, color: T.text }}>
                        {selVer.name}
                      </span>
                      {selVer.id !== "__unversioned__" && (
                        <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                          padding: "3px 9px", borderRadius: 5,
                          color: verColor(selVer),
                          background: `${verColor(selVer)}18`,
                          border: `1px solid ${verColor(selVer)}44` }}>
                          {selVer.status}
                        </span>
                      )}
                      {selVer.releaseDate && (
                        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                          📅 {selVer.releaseDate}
                        </span>
                      )}
                    </div>
                    {selVer.description && (
                      <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted,
                        marginTop: 4, lineHeight: 1.5 }}>
                        {selVer.description}
                      </div>
                    )}
                  </div>
                  {canEdit && selVer.id !== "__unversioned__" && (
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button onClick={() => setModal(selVer)}
                        style={{ fontFamily: T.body, fontSize: 12, padding: "5px 12px",
                          borderRadius: 7, border: `1px solid ${T.border}`, background: "transparent",
                          color: T.text, cursor: "pointer" }}>✎ Edit</button>
                      <button onClick={() => handleDelete(selVer)}
                        style={{ fontFamily: T.body, fontSize: 12, padding: "5px 12px",
                          borderRadius: 7, border: `1px solid ${T.danger}44`, background: "transparent",
                          color: T.danger, cursor: "pointer" }}>✕ Delete</button>
                    </div>
                  )}
                </div>

                {/* Progress bar */}
                {total > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <SegBar done={done} total={total} />
                  </div>
                )}

                {/* Stat chips */}
                {total > 0 && (
                  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                    {[
                      { label: "Total",     count: total,                  color: T.textMuted },
                      { label: "Done",      count: done,                   color: T.success },
                      { label: "In Progress", count: verTickets.filter(t => t.status === "In Progress" || t.status === "In Testing").length, color: T.accent },
                      { label: "Open",      count: total - done - verTickets.filter(t => t.status === "In Progress" || t.status === "In Testing").length, color: T.textMuted },
                    ].filter(s => s.count > 0).map(s => (
                      <span key={s.label} style={{ fontFamily: T.mono, fontSize: 11, padding: "2px 8px",
                        borderRadius: 4, background: `${s.color}18`, color: s.color,
                        border: `1px solid ${s.color}33`, fontWeight: 600 }}>
                        {s.count} {s.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Ticket list */}
              <div style={{ flex: 1, overflowY: "auto" }}>
                {verTickets.length === 0 && selVer.id !== "__unversioned__" ? (
                  <div style={{ padding: "48px 24px", textAlign: "center",
                    fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
                    No tickets assigned to this version yet.<br />
                    Set the version on any ticket from the Kanban board.
                  </div>
                ) : (
                  (selVer.id === "__unversioned__" ? unversioned : verTickets).map(t => (
                    <TicketRow key={t.id} t={t} />
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Version form modal */}
      {modal && (
        <VersionModal
          init={modal === "new" ? null : modal}
          projectId={projId}
          onSave={handleSaveVersion}
          onCancel={() => setModal(null)}
        />
      )}
    </>
  );
}
