import { useState, useEffect, useCallback } from "react";
import { api } from "../../api";
import { T } from "../../tokens";
import { toast } from "../../toast";

const DEPT_COLOR  = { SE: { bg: "#3b82f618", text: "#3b82f6" }, SI: { bg: "#10b98118", text: "#10b981" } };
const DEPT_LABELS = { SE: "Sea Export", SI: "Sea Import" };

function OfficeStats({ officeId, onClose }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.offices.stats(officeId)
      .then(setData)
      .catch(() => toast.error("Failed to load office stats"))
      .finally(() => setLoading(false));
  }, [officeId]);

  if (!data && loading) return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 800,
      display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: T.surface, borderRadius: 14, padding: "40px 50px",
        fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading…</div>
    </div>
  );

  const { office, users, shipmentStats: s } = data || {};

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 800,
      display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: T.surface, borderRadius: 14, border: `1px solid ${T.border}`,
        padding: "28px 30px", width: 580, maxHeight: "82vh", overflow: "auto",
        boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>

        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18 }}>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, textTransform: "uppercase",
              letterSpacing: ".08em", marginBottom: 4 }}>Office</div>
            <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 800, color: T.text }}>{office?.code}</div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{office?.name}</div>
          </div>
          <button type="button" onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: T.textMuted }}>✕</button>
        </div>

        {/* Shipment stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 22 }}>
          {[
            { label: "EMO Total",  value: s?.emoTotal,  color: T.accent },
            { label: "IMO Total",  value: s?.imoTotal,  color: T.accent },
            { label: "Ctrl Total", value: s?.ctrlTotal, color: T.textMuted },
            { label: "EMO Active", value: s?.emoActive, color: T.success },
            { label: "IMO Active", value: s?.imoActive, color: T.success },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: "center",
              padding: "10px 6px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}` }}>
              <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 800, color }}>{value ?? 0}</div>
              <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, textTransform: "uppercase",
                letterSpacing: ".05em", marginTop: 2, textAlign: "center" }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Assigned users */}
        <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.textMuted,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>
          Assigned Users ({users?.length || 0})
        </div>
        {!users?.length ? (
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, marginBottom: 16 }}>
            No users assigned to this office yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
            {users.map(u => (
              <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                borderRadius: 8, background: T.bg, border: `1px solid ${T.border}` }}>
                <div style={{ width: 30, height: 30, borderRadius: "50%", background: T.accent + "22",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: T.head, fontSize: 12, fontWeight: 700, color: T.accent, flexShrink: 0 }}>
                  {u.name?.[0]?.toUpperCase() || "?"}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>
                    {u.name}
                    {u.isDefault && <span style={{ marginLeft: 6, fontSize: 10, color: T.accent,
                      background: T.accent + "18", borderRadius: 4, padding: "1px 5px" }}>default</span>}
                  </div>
                  <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{u.email}</div>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
                  background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, padding: "2px 6px" }}>
                  {u.role}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}
            style={{ padding: "6px 18px", borderRadius: 7, border: "none", background: T.accent,
              color: "#fff", cursor: "pointer", fontFamily: T.body, fontSize: 13 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function OfficeForm({ office, branches, onSave, onCancel }) {
  const isEdit = !!office;
  const [form, setForm] = useState({
    unlocode:   office?.unlocode   || "",
    department: office?.department || "SE",
    name:       office?.name       || "",
    branchId:   office?.branchId   || "",
  });
  const [saving,     setSaving]     = useState(false);
  const [resolving,  setResolving]  = useState(false);
  const [codePreview,setCodePreview]= useState(
    office ? "" : ""
  );

  const inp = { width: "100%", padding: "7px 10px", borderRadius: 7, border: `1px solid ${T.border}`,
    background: T.bg, fontFamily: T.body, fontSize: 13, color: T.text, outline: "none", boxSizing: "border-box" };

  const resolveLocode = async (raw) => {
    const locode = raw.toUpperCase().trim();
    const country = locode.length >= 2 ? locode.slice(0, 2) : "";
    setCodePreview(locode.length >= 3 ? `${country}-${locode}-${form.department}` : "");
    setForm(p => ({ ...p, unlocode: locode }));
    if (locode.length < 5) return;
    setResolving(true);
    try {
      const port = await api.portLocations.get(locode);
      if (port) {
        const deptLabel = { SE: "Sea Export", SI: "Sea Import" };
        setForm(p => ({ ...p, name: p.name || `${port.name} ${deptLabel[p.department] || p.department}` }));
      }
    } catch { /* ignore */ } finally { setResolving(false); }
  };

  const handleSave = async () => {
    if (!form.unlocode || !form.name) return toast.error("LOCODE and name are required");
    setSaving(true);
    try {
      if (isEdit) {
        await api.offices.update(office.id, { name: form.name, branchId: form.branchId || null, isActive: true });
        toast.success("Office updated");
      } else {
        const country = form.unlocode.slice(0, 2);
        await api.offices.create({ unlocode: form.unlocode, department: form.department, name: form.name, countryCode: country, branchId: form.branchId || null });
        toast.success("Office created");
      }
      onSave();
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.accent}44`, borderRadius: 10,
      padding: "20px 22px", marginBottom: 20 }}>
      <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 16 }}>
        {isEdit ? `Edit Office — ${office.code}` : "New Office"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: 10, marginBottom: 4 }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>UN/LOCODE <span style={{ color: T.danger }}>*</span></div>
          <input value={form.unlocode} disabled={isEdit}
            onChange={e => resolveLocode(e.target.value)} placeholder="e.g. NLRTM"
            style={{ ...inp, fontFamily: T.mono, opacity: isEdit ? 0.6 : 1 }} />
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Department</div>
          <select value={form.department} disabled={isEdit}
            onChange={e => { const dept=e.target.value; setForm(p=>({...p,department:dept})); if(form.unlocode.length>=3) setCodePreview(`${form.unlocode.slice(0,2)}-${form.unlocode}-${dept}`); }}
            style={{ ...inp, cursor: "pointer", opacity: isEdit ? 0.6 : 1 }}>
            <option value="SE">SE — Sea Export</option>
            <option value="SI">SI — Sea Import</option>
          </select>
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>
            Office Name <span style={{ color: T.danger }}>*</span>{resolving && <span style={{ color: T.accent }}> resolving…</span>}
          </div>
          <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            placeholder="e.g. Rotterdam Sea Export" style={inp} />
        </div>
      </div>
      {!isEdit && codePreview && (
        <div style={{ marginBottom: 10, fontFamily: T.mono, fontSize: 12, color: T.accent,
          padding: "4px 8px", background: T.accent + "10", borderRadius: 5, display: "inline-block" }}>
          Code: <strong>{codePreview}</strong>
        </div>
      )}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Branch (optional)</div>
        <select value={form.branchId}
          onChange={e => setForm(p => ({ ...p, branchId: e.target.value }))}
          style={{ ...inp, maxWidth: 320, cursor: "pointer" }}>
          <option value="">— No branch —</option>
          {branches.filter(b => b.isActive).map(b => (
            <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel} disabled={saving}
          style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${T.border}`,
            background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          Cancel
        </button>
        <button type="button" onClick={handleSave} disabled={saving}
          style={{ padding: "6px 18px", borderRadius: 7, border: "none", background: T.accent,
            color: "#fff", cursor: "pointer", fontFamily: T.body, fontSize: 13, fontWeight: 600 }}>
          {saving ? "Saving…" : "Save Office"}
        </button>
      </div>
    </div>
  );
}

export default function OfficePage() {
  const [offices,   setOffices]   = useState([]);
  const [branches,  setBranches]  = useState([]);
  const [settings,  setSettings]  = useState({});
  const [loading,   setLoading]   = useState(true);
  const [formOpen,  setFormOpen]  = useState(false);
  const [editing,   setEditing]   = useState(null);
  const [statsId,   setStatsId]   = useState(null);
  const [defaultId, setDefaultId] = useState("");
  const [allowAll,  setAllowAll]  = useState(false);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [search,    setSearch]    = useState("");

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.offices.list(), api.branches.list(), api.settings.get()])
      .then(([off, br, s]) => {
        setOffices(off);
        setBranches(br);
        setSettings(s);
        setDefaultId(s.default_office_id || "");
        setAllowAll(s.offices_allow_all === "1");
      })
      .catch(() => toast.error("Failed to load"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const toggleActive = async (o) => {
    try { await api.offices.update(o.id, { name: o.name, isActive: !o.isActive }); load(); }
    catch (e) { toast.error(e.message); }
  };

  const handleDelete = async (o) => {
    if (!window.confirm(`Delete office ${o.code}?`)) return;
    try { await api.offices.remove(o.id); toast.success("Office deleted"); load(); }
    catch (e) { toast.error(e.message); }
  };

  const setAsDefault = async (id) => {
    const next = defaultId === String(id) ? "" : String(id);
    try { await api.settings.update({ default_office_id: next }); setDefaultId(next); } catch (e) { toast.error(e.message); }
  };

  const toggleAllowAll = async () => {
    setSavingGlobal(true);
    const next = !allowAll;
    try {
      await api.settings.update({ offices_allow_all: next ? "1" : "0" });
      setAllowAll(next);
      toast.success(next ? "Global access enabled" : "Global access disabled");
    } catch (e) { toast.error(e.message); } finally { setSavingGlobal(false); }
  };

  // Group offices by branch
  const branchMap = Object.fromEntries(branches.map(b => [b.id, b]));
  const grouped = {};
  for (const o of offices) {
    const key = o.branchId || "__none__";
    (grouped[key] = grouped[key] || []).push(o);
  }
  const groupOrder = [...branches.map(b => b.id), "__none__"];

  const filtered = offices.filter(o =>
    !search || o.code.toLowerCase().includes(search.toLowerCase()) ||
    o.name.toLowerCase().includes(search.toLowerCase())
  );
  const filteredGrouped = {};
  for (const o of filtered) {
    const key = o.branchId || "__none__";
    (filteredGrouped[key] = filteredGrouped[key] || []).push(o);
  }

  return (
    <div style={{ maxWidth: 920 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ fontFamily: T.head, fontSize: 22, fontWeight: 800, color: T.text }}>Offices</div>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, marginTop: 3 }}>
            Operational offices stamped on shipments as EMO, IMO and Controlling Office.
          </div>
        </div>
        <button type="button" onClick={() => { setEditing(null); setFormOpen(true); }}
          style={{ padding: "8px 18px", borderRadius: 9, border: "none", background: T.accent,
            color: "#fff", fontFamily: T.body, fontSize: 13, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>
          ＋ New Office
        </button>
      </div>

      {/* Global access toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", borderRadius: 10, marginBottom: 16,
        background: allowAll ? T.accent + "12" : T.surface, border: `1px solid ${allowAll ? T.accent + "55" : T.border}` }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>Allow all orgs (global access)</div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 2 }}>
            All users see shipments from every office regardless of individual assignments.
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexShrink: 0, marginLeft: 20 }}>
          <input type="checkbox" checked={allowAll} disabled={savingGlobal}
            onChange={toggleAllowAll} style={{ accentColor: T.accent, width: 16, height: 16 }} />
          <span style={{ fontFamily: T.body, fontSize: 13, color: allowAll ? T.accent : T.textMuted, fontWeight: 600 }}>
            {allowAll ? "Enabled" : "Disabled"}
          </span>
        </label>
      </div>

      {/* Search */}
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search offices…"
        style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.border}`,
          background: T.bg, fontFamily: T.body, fontSize: 13, color: T.text, outline: "none",
          marginBottom: 16, boxSizing: "border-box" }} />

      {formOpen && (
        <OfficeForm office={editing} branches={branches}
          onSave={() => { setFormOpen(false); setEditing(null); load(); }}
          onCancel={() => { setFormOpen(false); setEditing(null); }} />
      )}

      {loading ? (
        <div style={{ padding: "48px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: "48px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          {search ? "No offices match." : "No offices yet — create one above."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {groupOrder.filter(k => filteredGrouped[k]).map(key => {
            const branch = key !== "__none__" ? branchMap[key] : null;
            return (
              <div key={key}>
                {/* Branch group header */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <div style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.textMuted,
                    textTransform: "uppercase", letterSpacing: ".1em" }}>
                    {branch ? `${branch.code} — ${branch.name}` : "Unassigned"}
                  </div>
                  <div style={{ flex: 1, height: 1, background: T.border }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {filteredGrouped[key].map(o => {
                    const dc = DEPT_COLOR[o.department] || {};
                    const isDefault = defaultId === String(o.id);
                    return (
                      <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
                        background: T.surface, border: `1px solid ${isDefault ? T.accent + "66" : T.border}`,
                        borderRadius: 9, opacity: o.isActive ? 1 : 0.55 }}>
                        <label title="Set as org default" style={{ cursor: "pointer", flexShrink: 0 }}>
                          <input type="checkbox" checked={isDefault} onChange={() => setAsDefault(o.id)}
                            style={{ accentColor: T.accent }} />
                        </label>
                        <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                          color: isDefault ? T.accent : T.text, minWidth: 150 }}>
                          {o.code}
                          {isDefault && <span style={{ marginLeft: 6, fontSize: 10, fontFamily: T.body,
                            color: T.accent, background: T.accent + "18", borderRadius: 4, padding: "1px 5px" }}>default</span>}
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 4, padding: "2px 8px",
                          background: dc.bg || T.border + "20", color: dc.text || T.textMuted, flexShrink: 0 }}>
                          {DEPT_LABELS[o.department] || o.department}
                        </span>
                        <div style={{ flex: 1, fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{o.name}</div>
                        {!o.isActive && <span style={{ fontSize: 11, color: T.warning, background: T.warning + "18",
                          borderRadius: 4, padding: "2px 6px", fontWeight: 600 }}>Inactive</span>}
                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                          <button type="button" onClick={() => setStatsId(o.id)}
                            style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.accent}44`,
                              background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.accent }}>
                            Stats
                          </button>
                          <button type="button" onClick={() => { setEditing(o); setFormOpen(true); }}
                            style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                              background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.text }}>
                            Edit
                          </button>
                          <button type="button" onClick={() => toggleActive(o)}
                            style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                              background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12,
                              color: o.isActive ? T.warning : T.success }}>
                            {o.isActive ? "Deactivate" : "Activate"}
                          </button>
                          <button type="button" onClick={() => handleDelete(o)}
                            style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.danger}44`,
                              background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.danger }}>
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {statsId && <OfficeStats officeId={statsId} onClose={() => { setStatsId(null); load(); }} />}
    </div>
  );
}
