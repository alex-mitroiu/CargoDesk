import { useState, useEffect } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import { Modal } from "./primitives/Modal";
import Btn from "./primitives/Btn";

const ROLE_COLORS = {
  admin:    { bg: "#3b82f618", text: "#3b82f6", border: "#3b82f644" },
  operator: { bg: "#10b98118", text: "#10b981", border: "#10b98144" },
  viewer:   { bg: T.border + "30", text: T.textMuted, border: T.border },
};

const RoleBadge = ({ role }) => {
  const c = ROLE_COLORS[role] || ROLE_COLORS.viewer;
  return (
    <span style={{
      display: "inline-block", padding: "2px 9px", borderRadius: 20,
      fontFamily: T.mono, fontSize: 11, fontWeight: 600,
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
      textTransform: "capitalize",
    }}>
      {role}
    </span>
  );
};

const inputStyle = () => ({
  width: "100%", padding: "8px 12px", borderRadius: 7,
  border: `1px solid ${T.border}`, background: T.bg,
  fontFamily: T.body, fontSize: 13, color: T.text,
  outline: "none", boxSizing: "border-box",
});

// ─── Create / Edit modal ──────────────────────────────────────────────────────

const UserModal = ({ user: existing, onSave, onClose }) => {
  const isNew = !existing;
  const [name,     setName]     = useState(existing?.name      ?? "");
  const [email,    setEmail]    = useState(existing?.email     ?? "");
  const [role,     setRole]     = useState(existing?.role      ?? "operator");
  const [password, setPassword] = useState("");
  const [active,   setActive]   = useState(existing?.is_active ?? 1);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState("");

  const handleSave = async () => {
    if (!name.trim()) return setError("Name is required");
    if (!email.trim()) return setError("Email is required");
    if (isNew && !password.trim()) return setError("Password is required for new users");
    setError(""); setSaving(true);
    try {
      const payload = { name: name.trim(), email: email.trim(), role, is_active: Number(active) };
      if (isNew) payload.password = password;
      else if (password.trim()) payload.password = password.trim();
      await onSave(payload);
      onClose();
    } catch (e) {
      setError(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={isNew ? "New User" : "Edit User"} onClose={onClose} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

        {error && (
          <div style={{
            padding: "9px 13px", borderRadius: 7, background: T.danger + "18",
            border: `1px solid ${T.danger}44`, fontFamily: T.body, fontSize: 13, color: T.danger,
          }}>
            {error}
          </div>
        )}

        <div>
          <label style={{ display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
            color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 5 }}>
            Full Name
          </label>
          <input value={name} onChange={e => setName(e.target.value)}
            style={inputStyle()} placeholder="e.g. Jane Smith"
            onFocus={e => e.currentTarget.style.borderColor = T.accent}
            onBlur={e  => e.currentTarget.style.borderColor = T.border} />
        </div>

        <div>
          <label style={{ display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
            color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 5 }}>
            Email
          </label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            style={inputStyle()} placeholder="jane@example.com"
            onFocus={e => e.currentTarget.style.borderColor = T.accent}
            onBlur={e  => e.currentTarget.style.borderColor = T.border} />
        </div>

        <div>
          <label style={{ display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
            color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 5 }}>
            Role
          </label>
          <select value={role} onChange={e => setRole(e.target.value)}
            style={{ ...inputStyle(), cursor: "pointer" }}>
            <option value="admin">Admin — full access</option>
            <option value="operator">Operator — create and edit</option>
            <option value="viewer">Viewer — read only</option>
          </select>
        </div>

        <div>
          <label style={{ display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
            color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 5 }}>
            {isNew ? "Password" : "New Password (leave blank to keep current)"}
          </label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            style={inputStyle()} placeholder={isNew ? "Set a password" : "Leave blank to keep unchanged"}
            onFocus={e => e.currentTarget.style.borderColor = T.accent}
            onBlur={e  => e.currentTarget.style.borderColor = T.border} />
        </div>

        {!isNew && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <label style={{ fontFamily: T.body, fontSize: 13, color: T.text, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={!!active}
                onChange={e => setActive(e.target.checked ? 1 : 0)}
                style={{ width: 15, height: 15, cursor: "pointer" }} />
              Account active
            </label>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
              (inactive users cannot sign in)
            </span>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <Btn variant="ghost" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : isNew ? "Create User" : "Save Changes"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Confirm delete dialog ────────────────────────────────────────────────────

const ConfirmModal = ({ user, onConfirm, onClose }) => (
  <Modal title="Delete User" onClose={onClose} width={400}>
    <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.6, marginBottom: 20 }}>
      Are you sure you want to permanently delete <strong>{user.name}</strong>?
      This action cannot be undone.
    </div>
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
      <Btn variant="danger" onClick={onConfirm}>Delete</Btn>
    </div>
  </Modal>
);

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function UserManagementPanel() {
  const [users,      setUsers]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [editTarget, setEditTarget] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = () => {
    setLoading(true);
    api.users.list()
      .then(u => setUsers(u))
      .catch(() => toast.error("Failed to load users"))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleCreate = async (data) => {
    await api.users.create(data);
    toast.success("User created");
    load();
  };

  const handleEdit = async (data) => {
    await api.users.update(editTarget.id, data);
    toast.success("User updated");
    load();
  };

  const handleDelete = async () => {
    try {
      await api.users.remove(deleteTarget.id);
      setUsers(p => p.filter(u => u.id !== deleteTarget.id));
      toast.success("User deleted");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDeleteTarget(null);
    }
  };

  const colHd = (label, width) => (
    <th style={{ textAlign: "left", padding: "8px 14px", fontFamily: T.mono, fontSize: 11,
      fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
      borderBottom: `1px solid ${T.border}`, width }}>
      {label}
    </th>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <div style={{ fontFamily: T.head, fontSize: 16, fontWeight: 700, color: T.text }}>
            User Management
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 2 }}>
            Manage who can access CargoDesk and what they can do.
          </div>
        </div>
        <Btn variant="primary" onClick={() => setShowCreate(true)}>+ New User</Btn>
      </div>

      {loading ? (
        <div style={{ padding: "40px 0", textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
          Loading…
        </div>
      ) : (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {colHd("Name", 180)}
                {colHd("Email", undefined)}
                {colHd("Role", 110)}
                {colHd("Status", 90)}
                {colHd("Last Login", 140)}
                {colHd("", 80)}
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr key={u.id} style={{
                  borderBottom: i < users.length - 1 ? `1px solid ${T.border}` : "none",
                  background: i % 2 === 0 ? "transparent" : T.bg + "55",
                }}>
                  <td style={{ padding: "11px 14px", fontFamily: T.body, fontSize: 13,
                    fontWeight: 600, color: T.text }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: "50%",
                        background: T.accent + "22", border: `1px solid ${T.accent}44`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.accent,
                        flexShrink: 0,
                      }}>
                        {u.name?.[0]?.toUpperCase() ?? "?"}
                      </div>
                      {u.name}
                    </div>
                  </td>
                  <td style={{ padding: "11px 14px", fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
                    {u.email}
                  </td>
                  <td style={{ padding: "11px 14px" }}>
                    <RoleBadge role={u.role} />
                  </td>
                  <td style={{ padding: "11px 14px" }}>
                    <span style={{
                      display: "inline-block", padding: "2px 9px", borderRadius: 20,
                      fontFamily: T.mono, fontSize: 11, fontWeight: 600,
                      background: u.is_active ? T.success + "18" : T.danger + "18",
                      color: u.is_active ? T.success : T.danger,
                      border: `1px solid ${u.is_active ? T.success + "44" : T.danger + "44"}`,
                    }}>
                      {u.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td style={{ padding: "11px 14px", fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                    {u.last_login
                      ? new Date(u.last_login).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
                      : <span style={{ color: T.border }}>Never</span>}
                  </td>
                  <td style={{ padding: "11px 14px" }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => setEditTarget(u)} title="Edit"
                        style={{ padding: "3px 9px", borderRadius: 6, border: `1px solid ${T.border}`,
                          background: T.bg, color: T.textMuted, fontFamily: T.body, fontSize: 12,
                          cursor: "pointer" }}>
                        Edit
                      </button>
                      <button onClick={() => setDeleteTarget(u)} title="Delete"
                        style={{ padding: "3px 9px", borderRadius: 6, border: `1px solid ${T.danger}44`,
                          background: T.danger + "10", color: T.danger, fontFamily: T.body, fontSize: 12,
                          cursor: "pointer" }}>
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: "32px", textAlign: "center",
                    fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <UserModal onSave={handleCreate} onClose={() => setShowCreate(false)} />
      )}
      {editTarget && (
        <UserModal user={editTarget} onSave={handleEdit} onClose={() => setEditTarget(null)} />
      )}
      {deleteTarget && (
        <ConfirmModal user={deleteTarget} onConfirm={handleDelete} onClose={() => setDeleteTarget(null)} />
      )}
    </div>
  );
}
