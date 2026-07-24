import { useState } from "react";
import { T } from "../../tokens";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import PasswordStrengthMeter from "../primitives/PasswordStrengthMeter";
import { scorePassword } from "../../utils/passwordPolicy";
import { api } from "../../api";
import { toast } from "../../toast";

const fieldStyle = { marginBottom: 16 };
const labelStyle = { display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
  color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 };
const inputStyle = { background: T.bg, border: `1px solid ${T.border}`, color: T.text,
  borderRadius: 6, padding: "8px 12px", outline: "none", width: "100%", boxSizing: "border-box",
  fontFamily: T.body, fontSize: 14 };

// forced=true: password is past the expiry policy — no dismiss without either
// completing the change or signing out (onForceLogout).
const ChangePasswordModal = ({ forced = false, onClose, onSuccess, onForceLogout }) => {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword,     setNewPassword]     = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error,   setError]   = useState("");
  const [saving,  setSaving]  = useState(false);

  const { meetsMinimum } = scorePassword(newPassword);
  const confirmMismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmit = currentPassword && meetsMinimum && confirmPassword === newPassword && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError("");
    try {
      const { token } = await api.auth.changePassword(currentPassword, newPassword);
      toast.success("Password changed");
      onSuccess(token);
    } catch (e) {
      setError(e.message || "Failed to change password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Change Password" onClose={onClose} width={420} hideClose={forced}>
      {forced && (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: `${T.warning}18`,
          border: `1px solid ${T.warning}44`, fontFamily: T.body, fontSize: 12.5,
          color: T.text, marginBottom: 18, lineHeight: 1.5 }}>
          Your password is past this app's expiry policy — set a new one to continue.
        </div>
      )}

      <div style={fieldStyle}>
        <label style={labelStyle}>Current Password</label>
        <input type="password" autoComplete="current-password" style={inputStyle}
          value={currentPassword} onChange={e => setCurrentPassword(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submit()} />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>New Password</label>
        <input type="password" autoComplete="new-password" style={inputStyle}
          value={newPassword} onChange={e => setNewPassword(e.target.value)} />
        <PasswordStrengthMeter password={newPassword} />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>Confirm New Password</label>
        <input type="password" autoComplete="new-password" style={{ ...inputStyle,
          ...(confirmMismatch ? { borderColor: T.danger } : {}) }}
          value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submit()} />
        {confirmMismatch && (
          <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.danger, marginTop: 4 }}>
            Passwords don't match
          </div>
        )}
      </div>

      {error && (
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.danger,
          background: `${T.danger}12`, border: `1px solid ${T.danger}44`,
          borderRadius: 6, padding: "8px 12px", marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: forced ? "space-between" : "flex-end" }}>
        {forced
          ? <Btn variant="secondary" onClick={onForceLogout}>Sign out instead</Btn>
          : <Btn variant="secondary" onClick={onClose}>Cancel</Btn>}
        <Btn onClick={submit} disabled={!canSubmit}>{saving ? "Saving…" : "Change Password"}</Btn>
      </div>
    </Modal>
  );
};

export default ChangePasswordModal;
