import { useState } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";

// ─── Board Manager Primitives ────────────────────────────────────────────────
// Defined at module level so React never sees new component references on re-render.

const BmFormRow = ({ label, children }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <label style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
      textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</label>
    {children}
  </div>
);

const BmEditForm = ({ onSave, onCancel, saving, children }) => (
  <div style={{ background: T.bg, border: `1px solid ${T.accent}44`, borderRadius: 9, padding: 14,
    display: "flex", flexDirection: "column", gap: 10, marginBottom: 10 }}>
    {children}
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <button type="button" onClick={onCancel}
        style={{ fontFamily: T.body, fontSize: 12, padding: "6px 14px", background: "none",
          border: `1px solid ${T.border}`, borderRadius: 6, color: T.textMuted, cursor: "pointer" }}>Cancel</button>
      <Btn size="sm" disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save"}</Btn>
    </div>
  </div>
);

// ─── Board Manager Modal ──────────────────────────────────────────────────────
// Tabbed manager for Projects, Columns, and Versions.

const BoardManagerModal = ({ projects, currentProject, columns, versions, initialTab = "columns", onClose, onRefresh, onProjectChange }) => {
  const [tab,        setTab]        = useState(initialTab);
  const [editItem,   setEditItem]   = useState(initialTab === "versions" ? "new" : null);   // item being edited or "new"
  const [form,       setForm]       = useState({});
  const [saving,     setSaving]     = useState(false);
  const [dragIdx,    setDragIdx]    = useState(null);
  const [dragOver,   setDragOver]   = useState(null);

  const sf = k => v => setForm(p => ({ ...p, [k]: v }));
  const inp = { fontFamily: T.body, fontSize: 13, color: T.text, background: T.bg,
    border: `1px solid ${T.border}`, borderRadius: 7, padding: "7px 11px", outline: "none",
    width: "100%", boxSizing: "border-box" };

  const startNew = (defaults = {}) => { setEditItem("new"); setForm(defaults); };
  const startEdit = item => { setEditItem(item); setForm({ ...item }); };
  const cancelEdit = () => { setEditItem(null); setForm({}); };

  const VERSION_STATUSES = ["Planning", "In Development", "Released", "Archived"];

  // ── Save handlers ──────────────────────────────────────────────────────────
  const saveProject = async () => {
    if (!form.name?.trim()) return;
    setSaving(true);
    try {
      if (editItem === "new") await api.kbProjects.create({ name: form.name, key: form.key || "", color: form.color || "#6366f1", description: form.description || "" });
      else await api.kbProjects.update(editItem.id, { name: form.name, key: form.key || editItem.key, color: form.color || editItem.color, description: form.description || "" });
      cancelEdit(); onRefresh();
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const deleteProject = async id => {
    if (!window.confirm("Delete this project? Tickets in it will keep their project_id but the project will be gone.")) return;
    try { await api.kbProjects.remove(id); onRefresh(); } catch (e) { toast.error(e.message); }
  };

  const saveColumn = async () => {
    if (!form.name?.trim() || !currentProject) return;
    setSaving(true);
    try {
      if (editItem === "new") await api.kbColumns.create(currentProject.id, { name: form.name, color: form.color || "#6366f1" });
      else await api.kbColumns.update(editItem.id, { name: form.name, color: form.color || editItem.color });
      cancelEdit(); onRefresh();
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const deleteColumn = async col => {
    if (!window.confirm(`Delete column "${col.name}"? Tickets already in it keep their status value.`)) return;
    try { await api.kbColumns.remove(col.id); onRefresh(); } catch (e) { toast.error(e.message); }
  };

  const saveVersion = async () => {
    if (!form.name?.trim() || !currentProject) return;
    setSaving(true);
    try {
      if (editItem === "new") await api.kbVersions.create(currentProject.id, { name: form.name, description: form.description || "", status: form.status || "Planning", releaseDate: form.releaseDate || null });
      else await api.kbVersions.update(editItem.id, { name: form.name, description: form.description || "", status: form.status || editItem.status, releaseDate: form.releaseDate || null });
      cancelEdit(); onRefresh();
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const deleteVersion = async id => {
    if (!window.confirm("Delete this version? Tickets will be unlinked from it.")) return;
    try { await api.kbVersions.remove(id); onRefresh(); } catch (e) { toast.error(e.message); }
  };

  // Column drag-to-reorder
  const handleColDrop = async () => {
    if (dragIdx === null || dragOver === null || dragIdx === dragOver || !currentProject) return;
    const reordered = [...columns];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(dragOver, 0, moved);
    setDragIdx(null); setDragOver(null);
    try { await api.kbColumns.reorder(currentProject.id, reordered.map(c => c.id)); onRefresh(); }
    catch (e) { toast.error(e.message); }
  };

  const TAB_BTN = active => ({
    fontFamily: T.body, fontSize: 13, fontWeight: active ? 700 : 400,
    padding: "10px 18px", background: "none", border: "none", cursor: "pointer",
    color: active ? T.accent : T.textMuted,
    borderBottom: `2px solid ${active ? T.accent : "transparent"}`,
    transition: "color .12s",
  });

  const swatch = color => (
    <div style={{ width: 14, height: 14, borderRadius: 3, background: color, flexShrink: 0, border: `1px solid ${T.border}` }} />
  );


  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,.6)",
      display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "min(92vw, 680px)", maxHeight: "88vh", background: T.surface,
        border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden",
        display: "flex", flexDirection: "column", boxShadow: "0 28px 80px rgba(0,0,0,.5)" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text }}>Board Settings</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer",
            color: T.textMuted, fontSize: 22, lineHeight: 1, padding: "0 4px" }}>×</button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          {[["columns","⬛ Columns"], ["projects","📁 Projects"], ["versions","🏷 Versions"]].map(([id, label]) => (
            <button key={id} type="button" onClick={() => { cancelEdit(); setTab(id); }} style={TAB_BTN(tab === id)}>{label}</button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px 28px" }}>

          {/* ── Columns tab ── */}
          {tab === "columns" && (
            <div>
              <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 14 }}>
                Drag rows to reorder. Changes apply to the current project.
              </div>
              {columns.map((col, idx) => (
                editItem?.id === col.id ? (
                  <BmEditForm onCancel={cancelEdit} key={col.id} onSave={saveColumn} saving={saving}>
                    <BmFormRow label="Name"><input value={form.name} onChange={e => sf("name")(e.target.value)} style={inp} autoFocus /></BmFormRow>
                    <BmFormRow label="Accent Color">
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input type="color" value={form.color || "#6366f1"} onChange={e => sf("color")(e.target.value)}
                          style={{ width: 36, height: 30, borderRadius: 5, border: `1px solid ${T.border}`, padding: 2, cursor: "pointer", background: "none" }} />
                        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{form.color || "#6366f1"}</span>
                      </div>
                    </BmFormRow>
                  </BmEditForm>
                ) : (
                  <div key={col.id}
                    draggable onDragStart={() => setDragIdx(idx)} onDragEnd={handleColDrop}
                    onDragOver={e => { e.preventDefault(); setDragOver(idx); }}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                      borderRadius: 7, marginBottom: 5, cursor: "grab",
                      background: dragOver === idx ? `${T.accent}10` : T.bg,
                      border: `1px solid ${dragOver === idx ? T.accent + "44" : T.border}`,
                      transition: "background .1s" }}>
                    <span style={{ color: T.border, fontSize: 14, cursor: "grab" }}>⠿</span>
                    {swatch(col.color || "#6366f1")}
                    <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1 }}>{col.name}</span>
                    <button type="button" onClick={() => startEdit(col)} style={{ background: "none", border: "none",
                      cursor: "pointer", color: T.textMuted, fontSize: 14, padding: "2px 4px" }}>✎</button>
                    <button type="button" onClick={() => deleteColumn(col)} style={{ background: "none", border: "none",
                      cursor: "pointer", color: T.danger, fontSize: 14, padding: "2px 4px" }}>✕</button>
                  </div>
                )
              ))}
              {editItem === "new" && tab === "columns" ? (
                <BmEditForm onCancel={cancelEdit} onSave={saveColumn} saving={saving}>
                  <BmFormRow label="Column Name"><input value={form.name || ""} onChange={e => sf("name")(e.target.value)} style={inp} autoFocus placeholder="e.g. QA Review" /></BmFormRow>
                  <BmFormRow label="Accent Color">
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="color" value={form.color || "#6366f1"} onChange={e => sf("color")(e.target.value)}
                        style={{ width: 36, height: 30, borderRadius: 5, border: `1px solid ${T.border}`, padding: 2, cursor: "pointer", background: "none" }} />
                      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{form.color || "#6366f1"}</span>
                    </div>
                  </BmFormRow>
                </BmEditForm>
              ) : (
                <button type="button" onClick={() => startNew({ color: "#6366f1" })}
                  style={{ fontFamily: T.body, fontSize: 13, color: T.accent, background: "none",
                    border: `1px dashed ${T.accent}55`, borderRadius: 7, padding: "7px 16px",
                    cursor: "pointer", width: "100%", textAlign: "left", marginTop: 8 }}>
                  ＋ Add Column
                </button>
              )}
            </div>
          )}

          {/* ── Projects tab ── */}
          {tab === "projects" && (
            <div>
              {projects.map(prj => (
                editItem?.id === prj.id ? (
                  <BmEditForm onCancel={cancelEdit} key={prj.id} onSave={saveProject} saving={saving}>
                    <BmFormRow label="Name"><input value={form.name || ""} onChange={e => sf("name")(e.target.value)} style={inp} autoFocus /></BmFormRow>
                    <BmFormRow label="Key (short code)"><input value={form.key || ""} onChange={e => sf("key")(e.target.value.toUpperCase().slice(0,6))} style={inp} placeholder="e.g. MAIN" maxLength={6} /></BmFormRow>
                    <BmFormRow label="Color">
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input type="color" value={form.color || "#6366f1"} onChange={e => sf("color")(e.target.value)}
                          style={{ width: 36, height: 30, borderRadius: 5, border: `1px solid ${T.border}`, padding: 2, cursor: "pointer", background: "none" }} />
                        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{form.color || "#6366f1"}</span>
                      </div>
                    </BmFormRow>
                    <BmFormRow label="Description"><input value={form.description || ""} onChange={e => sf("description")(e.target.value)} style={inp} placeholder="Optional" /></BmFormRow>
                  </BmEditForm>
                ) : (
                  <div key={prj.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                    borderRadius: 7, marginBottom: 5, background: currentProject?.id === prj.id ? `${T.accent}10` : T.bg,
                    border: `1px solid ${currentProject?.id === prj.id ? T.accent + "44" : T.border}` }}>
                    {swatch(prj.color || "#6366f1")}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>{prj.name}</div>
                      <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{prj.key}</div>
                    </div>
                    {currentProject?.id !== prj.id && (
                      <button type="button" onClick={() => { onProjectChange(prj); onClose(); }}
                        style={{ fontFamily: T.body, fontSize: 11, padding: "3px 10px", borderRadius: 5,
                          background: T.accent + "15", border: `1px solid ${T.accent}44`, color: T.accent, cursor: "pointer" }}>
                        Switch
                      </button>
                    )}
                    {currentProject?.id === prj.id && (
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, padding: "2px 8px",
                        background: T.accent + "15", border: `1px solid ${T.accent}44`, borderRadius: 4 }}>Active</span>
                    )}
                    <button type="button" onClick={() => startEdit(prj)} style={{ background: "none", border: "none",
                      cursor: "pointer", color: T.textMuted, fontSize: 14, padding: "2px 4px" }}>✎</button>
                    <button type="button" onClick={() => deleteProject(prj.id)} style={{ background: "none", border: "none",
                      cursor: "pointer", color: T.danger, fontSize: 14, padding: "2px 4px" }}>✕</button>
                  </div>
                )
              ))}
              {editItem === "new" && tab === "projects" ? (
                <BmEditForm onCancel={cancelEdit} onSave={saveProject} saving={saving}>
                  <BmFormRow label="Project Name"><input value={form.name || ""} onChange={e => sf("name")(e.target.value)} style={inp} autoFocus placeholder="e.g. CargoDesk Platform" /></BmFormRow>
                  <BmFormRow label="Key"><input value={form.key || ""} onChange={e => sf("key")(e.target.value.toUpperCase().slice(0,6))} style={inp} placeholder="CDP" maxLength={6} /></BmFormRow>
                  <BmFormRow label="Color">
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="color" value={form.color || "#6366f1"} onChange={e => sf("color")(e.target.value)}
                        style={{ width: 36, height: 30, borderRadius: 5, border: `1px solid ${T.border}`, padding: 2, cursor: "pointer", background: "none" }} />
                    </div>
                  </BmFormRow>
                </BmEditForm>
              ) : (
                <button type="button" onClick={() => startNew({ color: "#6366f1" })}
                  style={{ fontFamily: T.body, fontSize: 13, color: T.accent, background: "none",
                    border: `1px dashed ${T.accent}55`, borderRadius: 7, padding: "7px 16px",
                    cursor: "pointer", width: "100%", textAlign: "left", marginTop: 8 }}>
                  ＋ New Project
                </button>
              )}
            </div>
          )}

          {/* ── Versions tab ── */}
          {tab === "versions" && (
            <div>
              {versions.map(ver => (
                editItem?.id === ver.id ? (
                  <BmEditForm onCancel={cancelEdit} key={ver.id} onSave={saveVersion} saving={saving}>
                    <BmFormRow label="Version Name"><input value={form.name || ""} onChange={e => sf("name")(e.target.value)} style={inp} autoFocus /></BmFormRow>
                    <BmFormRow label="Status">
                      <select value={form.status || "Planning"} onChange={e => sf("status")(e.target.value)} style={inp}>
                        {VERSION_STATUSES.map(s => <option key={s}>{s}</option>)}
                      </select>
                    </BmFormRow>
                    <BmFormRow label="Release Date">
                      <input type="date" value={form.releaseDate || ""} onChange={e => sf("releaseDate")(e.target.value)} style={{ ...inp, colorScheme: "dark" }} />
                    </BmFormRow>
                    <BmFormRow label="Description"><input value={form.description || ""} onChange={e => sf("description")(e.target.value)} style={inp} placeholder="Optional" /></BmFormRow>
                  </BmEditForm>
                ) : (
                  <div key={ver.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                    borderRadius: 7, marginBottom: 5, background: T.bg, border: `1px solid ${T.border}` }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>{ver.name}</div>
                      <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, display: "flex", gap: 10, marginTop: 2 }}>
                        <span style={{ color: ver.status === "Released" ? T.success : ver.status === "Archived" ? T.textMuted : T.accent }}>{ver.status}</span>
                        {ver.releaseDate && <span>Release: {ver.releaseDate}</span>}
                        {ver.description && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ver.description}</span>}
                      </div>
                    </div>
                    <button type="button" onClick={() => startEdit(ver)} style={{ background: "none", border: "none",
                      cursor: "pointer", color: T.textMuted, fontSize: 14, padding: "2px 4px" }}>✎</button>
                    <button type="button" onClick={() => deleteVersion(ver.id)} style={{ background: "none", border: "none",
                      cursor: "pointer", color: T.danger, fontSize: 14, padding: "2px 4px" }}>✕</button>
                  </div>
                )
              ))}
              {editItem === "new" && tab === "versions" ? (
                <BmEditForm onCancel={cancelEdit} onSave={saveVersion} saving={saving}>
                  <BmFormRow label="Version Name"><input value={form.name || ""} onChange={e => sf("name")(e.target.value)} style={inp} autoFocus placeholder="e.g. v1.0.0" /></BmFormRow>
                  <BmFormRow label="Status">
                    <select value={form.status || "Planning"} onChange={e => sf("status")(e.target.value)} style={inp}>
                      {VERSION_STATUSES.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </BmFormRow>
                  <BmFormRow label="Release Date">
                    <input type="date" value={form.releaseDate || ""} onChange={e => sf("releaseDate")(e.target.value)} style={{ ...inp, colorScheme: "dark" }} />
                  </BmFormRow>
                  <BmFormRow label="Description"><input value={form.description || ""} onChange={e => sf("description")(e.target.value)} style={inp} placeholder="Optional" /></BmFormRow>
                </BmEditForm>
              ) : (
                <button type="button" onClick={() => startNew({ status: "Planning" })}
                  style={{ fontFamily: T.body, fontSize: 13, color: T.accent, background: "none",
                    border: `1px dashed ${T.accent}55`, borderRadius: 7, padding: "7px 16px",
                    cursor: "pointer", width: "100%", textAlign: "left", marginTop: 8 }}>
                  ＋ New Version
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BoardManagerModal;
