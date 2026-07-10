import { useState, useEffect } from "react";
import { api } from "../../api";
import { T, TIMEZONES } from "../../tokens";
import { toast } from "../../toast";
import PortCombobox from "../../components/shared/PortCombobox";

const DEPT_COLOR = { SE: { bg: "#3b82f618", text: "#3b82f6" }, SI: { bg: "#10b98118", text: "#10b981" } };

function StatChip({ label, value, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
      padding: "8px 16px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}`, minWidth: 72 }}>
      <div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 800, color: color || T.text }}>{value}</div>
      <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, marginTop: 2, textTransform: "uppercase",
        letterSpacing: ".06em" }}>{label}</div>
    </div>
  );
}

function BranchForm({ branch, onSave, onCancel }) {
  const isEdit = !!branch;
  const [form, setForm] = useState({
    code:        branch?.code        || "",
    name:        branch?.name        || "",
    locode:      branch?.locode      || "",
    countryCode: branch?.countryCode || "",
    city:        branch?.city        || "",
    address:     branch?.address     || "",
    timezone:    branch?.timezone    || "",
    phone:       branch?.phone       || "",
    email:       branch?.email       || "",
  });
  const [saving, setSaving] = useState(false);

  const inp = { width: "100%", padding: "7px 10px", borderRadius: 7, border: `1px solid ${T.border}`,
    background: T.bg, fontFamily: T.body, fontSize: 13, color: T.text, outline: "none", boxSizing: "border-box" };

  const handleLocationChange = (port) => {
    if (!port) {
      setForm(p => ({ ...p, locode: "", ...(!isEdit ? { countryCode: "" } : {}), city: "" }));
      return;
    }
    const cc = port.countryCode || port.unlocode.slice(0, 2);
    setForm(p => ({
      ...p,
      locode: port.unlocode,
      ...(!isEdit ? { countryCode: cc } : {}),
      city: p.city || port.name,
      ...(!p.timezone && port.timezone ? { timezone: port.timezone } : {}),
    }));
  };

  const handleSave = async () => {
    if (!form.code || !form.name || !form.locode || !form.countryCode)
      return toast.error("Code, name and location (LOCODE) are required");
    setSaving(true);
    try {
      const result = isEdit
        ? await api.branches.update(branch.id, form)
        : await api.branches.create(form);
      onSave(result);
      toast.success(isEdit ? "Branch updated" : "Branch created");
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.accent}44`, borderRadius: 10,
      padding: "20px 22px", marginBottom: 20 }}>
      <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 16 }}>
        {isEdit ? `Edit Branch — ${branch.code}` : "New Branch"}
      </div>

      {/* Row 1: Code | Name | LOCODE */}
      <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 260px", gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>
            Code <span style={{ color: T.danger }}>*</span>
          </div>
          <input value={form.code} disabled={isEdit}
            onChange={e => setForm(p => ({ ...p, code: e.target.value.toUpperCase() }))}
            placeholder="e.g. AMS"
            style={{ ...inp, fontFamily: T.mono, textTransform: "uppercase", opacity: isEdit ? 0.6 : 1 }} />
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>
            Branch Name <span style={{ color: T.danger }}>*</span>
          </div>
          <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            placeholder="e.g. Amsterdam Branch" style={inp} />
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>
            Location (LOCODE) <span style={{ color: T.danger }}>*</span>
          </div>
          <PortCombobox
            value={form.locode ? { unlocode: form.locode, name: form.city || "" } : null}
            onChange={handleLocationChange}
            placeholder="Search city or LOCODE…"
          />
        </div>
      </div>

      {/* Row 2: City | Country chip | Timezone */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>City</div>
          <input value={form.city} onChange={e => setForm(p => ({ ...p, city: e.target.value }))}
            placeholder="Auto-filled from LOCODE" style={inp} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", paddingBottom: 1 }}>
          <div title="Derived from LOCODE" style={{
            padding: "7px 14px", borderRadius: 7,
            border: `1px solid ${form.countryCode ? T.accent + "44" : T.border}`,
            background: form.countryCode ? T.accent + "10" : T.bg,
            fontFamily: T.mono, fontSize: 14, fontWeight: 800,
            color: form.countryCode ? T.accent : T.textMuted,
            textAlign: "center", whiteSpace: "nowrap", minWidth: 48,
          }}>
            {form.countryCode || "—"}
          </div>
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Timezone</div>
          <select value={form.timezone} onChange={e => setForm(p => ({ ...p, timezone: e.target.value }))}
            style={{ ...inp, cursor: "pointer" }}>
            <option value="">— None —</option>
            {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </div>
      </div>

      {/* Row 3: Address */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Address</div>
        <input value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))}
          placeholder="Street, postal code" style={inp} />
      </div>

      {/* Row 4: Phone | Email */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Phone</div>
          <input value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))}
            placeholder="+31 20 xxx xxxx" style={inp} />
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Email</div>
          <input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
            placeholder="amsterdam@example.com" style={inp} />
        </div>
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
          {saving ? "Saving…" : "Save Branch"}
        </button>
      </div>
    </div>
  );
}

function BranchDetail({ branch, onClose, onEdit }) {
  const [offices, setOffices]  = useState([]);
  const [loading, setLoading]  = useState(true);

  useEffect(() => {
    api.branches.offices(branch.id)
      .then(setOffices)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [branch.id]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 800,
      display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: T.surface, borderRadius: 14, border: `1px solid ${T.border}`,
        padding: "28px 30px", width: 560, maxHeight: "80vh", overflow: "auto",
        boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginBottom: 4,
              textTransform: "uppercase", letterSpacing: ".08em" }}>Branch</div>
            <div style={{ fontFamily: T.head, fontSize: 22, fontWeight: 800, color: T.text }}>{branch.code}</div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{branch.name}</div>
          </div>
          <button type="button" onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: T.textMuted }}>✕</button>
        </div>

        {/* Stats */}
        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          <StatChip label="Offices"  value={branch.officeCount || 0} color={T.accent} />
          <StatChip label="Users"    value={branch.userCount   || 0} />
        </div>

        {/* Info */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 20 }}>
          {[["Country", branch.countryCode], ["LOCODE", branch.locode], ["City", branch.city],
            ["Timezone", branch.timezone], ["Phone", branch.phone], ["Email", branch.email]].map(([label, val]) => val ? (
            <div key={label}>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{label}</div>
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{val}</div>
            </div>
          ) : null)}
          {branch.address && (
            <div style={{ gridColumn: "1/-1" }}>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>Address</div>
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{branch.address}</div>
            </div>
          )}
        </div>

        {/* Offices */}
        <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.textMuted,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>Offices</div>
        {loading ? (
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading…</div>
        ) : offices.length === 0 ? (
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>No offices assigned to this branch yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {offices.map(o => {
              const dc = DEPT_COLOR[o.department] || {};
              return (
                <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                  borderRadius: 8, background: T.bg, border: `1px solid ${T.border}` }}>
                  <code style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{o.code}</code>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 4,
                    background: dc.bg, color: dc.text }}>{o.department === "SE" ? "Sea Export" : "Sea Import"}</span>
                  <span style={{ flex: 1, fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{o.name}</span>
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{o.userCount} users</span>
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.info }}>
                    EMO {o.emoCount} · IMO {o.imoCount}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={() => onEdit(branch)}
            style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${T.border}`,
              background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 13, color: T.text }}>
            Edit
          </button>
          <button type="button" onClick={onClose}
            style={{ padding: "6px 14px", borderRadius: 7, border: "none", background: T.accent,
              color: "#fff", cursor: "pointer", fontFamily: T.body, fontSize: 13 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BranchPage() {
  const [branches,   setBranches]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [formOpen,   setFormOpen]   = useState(false);
  const [editing,    setEditing]    = useState(null);
  const [detail,     setDetail]     = useState(null);
  const [search,     setSearch]     = useState("");

  const load = () => {
    setLoading(true);
    api.branches.list()
      .then(setBranches)
      .catch(() => toast.error("Failed to load"))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleDelete = async (branch) => {
    if (!window.confirm(`Delete branch ${branch.code}?`)) return;
    try { await api.branches.remove(branch.id); toast.success("Branch deleted"); load(); }
    catch (e) { toast.error(e.message); }
  };

  const toggleActive = async (branch) => {
    try { await api.branches.update(branch.id, { isActive: !branch.isActive }); load(); }
    catch (e) { toast.error(e.message); }
  };

  const openEdit = (branch) => { setEditing(branch); setDetail(null); setFormOpen(true); };
  const openNew  = ()        => { setEditing(null);   setFormOpen(true); };

  const filtered = branches.filter(b =>
    !search || b.code.includes(search.toUpperCase()) ||
    b.name.toLowerCase().includes(search.toLowerCase()) ||
    b.countryCode.includes(search.toUpperCase())
  );

  return (
    <div style={{ maxWidth: 900 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontFamily: T.head, fontSize: 22, fontWeight: 800, color: T.text }}>Branches</div>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, marginTop: 3 }}>
            Physical locations of your organisation — each branch groups one or more operational offices.
          </div>
        </div>
        <button type="button" onClick={openNew}
          style={{ padding: "8px 18px", borderRadius: 9, border: "none", background: T.accent,
            color: "#fff", fontFamily: T.body, fontSize: 13, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>
          ＋ New Branch
        </button>
      </div>

      {/* Search */}
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search branches…"
        style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.border}`,
          background: T.bg, fontFamily: T.body, fontSize: 13, color: T.text, outline: "none",
          marginBottom: 16, boxSizing: "border-box" }} />

      {formOpen && (
        <BranchForm
          branch={editing}
          onSave={() => { setFormOpen(false); setEditing(null); load(); }}
          onCancel={() => { setFormOpen(false); setEditing(null); }}
        />
      )}

      {loading ? (
        <div style={{ padding: "48px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: "48px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          {search ? "No branches match your search." : "No branches yet — create one above."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(b => (
            <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 16px",
              background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
              opacity: b.isActive ? 1 : 0.55, cursor: "pointer" }}
              onClick={() => setDetail(b)}>
              {/* Code badge */}
              <div style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 800, color: T.accent,
                minWidth: 52, background: T.accent + "12", borderRadius: 6,
                padding: "4px 8px", textAlign: "center" }}>{b.code}</div>

              {/* Name + country */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text }}>{b.name}</div>
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                  {b.countryCode}{b.locode ? ` · ${b.locode}` : ""}{b.city ? ` · ${b.city}` : ""}{b.timezone ? ` · ${b.timezone}` : ""}
                </div>
              </div>

              {/* Stats */}
              <div style={{ display: "flex", gap: 14, flexShrink: 0 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: T.text }}>{b.officeCount || 0}</div>
                  <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>offices</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: T.text }}>{b.userCount || 0}</div>
                  <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>users</div>
                </div>
              </div>

              {!b.isActive && (
                <span style={{ fontSize: 11, color: T.warning, background: T.warning + "18",
                  borderRadius: 4, padding: "2px 6px", fontWeight: 600, flexShrink: 0 }}>Inactive</span>
              )}

              {/* Actions */}
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                <button type="button" onClick={() => openEdit(b)}
                  style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                    background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.text }}>
                  Edit
                </button>
                <button type="button" onClick={() => toggleActive(b)}
                  style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                    background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12,
                    color: b.isActive ? T.warning : T.success }}>
                  {b.isActive ? "Deactivate" : "Activate"}
                </button>
                <button type="button" onClick={() => handleDelete(b)}
                  style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.danger}44`,
                    background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.danger }}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <BranchDetail branch={detail} onClose={() => setDetail(null)} onEdit={openEdit} />
      )}
    </div>
  );
}
