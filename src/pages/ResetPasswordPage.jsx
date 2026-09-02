import { useState } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { VERSION } from "../version";
import { IconAnchor } from "../components/primitives/Icon";

// ─── Reset Password ─────────────────────────────────────────────────────────
// Public page reached via the emailed link (#reset-password/<token>) — App.jsx's own
// parseHash carve-out reads the token the same way #track/<token> already does. Deliberately
// does NOT auto-log-in on success (unlike the self-service change-password flow, whose caller
// was already authenticated) — this caller wasn't, so the safer move is making them sign in
// fresh with the new password.

const ResetPasswordPage = ({ token }) => {
  const [newPassword,     setNewPassword]     = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [done,    setDone]    = useState(false);

  const handleSubmit = async e => {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) { setError("Passwords don't match"); return; }
    setLoading(true);
    try {
      await api.auth.resetPassword(token, newPassword);
      setDone(true);
    } catch (e) {
      setError(e.message || "Something went wrong — request a new reset link and try again");
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    width: "100%", padding: "10px 14px", borderRadius: 8,
    border: `1px solid ${T.border}`, background: T.bg,
    fontFamily: T.body, fontSize: 14, color: T.text,
    outline: "none", boxSizing: "border-box", transition: "border-color .15s",
  };

  return (
    <div style={{
      minHeight: "100vh", background: T.bg,
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      fontFamily: T.body, padding: "24px",
    }}>
      <div style={{ width: "100%", maxWidth: 400 }}>

        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ fontFamily: T.head, fontSize: 30, fontWeight: 800, color: T.text, marginBottom: 6,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <IconAnchor size={28} />CargoDesk
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
            letterSpacing: ".14em", textTransform: "uppercase" }}>
            Freight Management Platform
          </div>
        </div>

        <div style={{
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 14, padding: "32px 32px 28px",
          boxShadow: "0 8px 32px rgba(0,0,0,.18)",
        }}>
          {!token ? (
            <>
              <h2 style={{ fontFamily: T.head, fontSize: 20, fontWeight: 700, color: T.text, margin: "0 0 12px" }}>
                Invalid reset link
              </h2>
              <p style={{ fontFamily: T.body, fontSize: 13.5, color: T.textMuted, lineHeight: 1.6, margin: "0 0 20px" }}>
                This link is missing its reset token. Request a new one from the sign-in page.
              </p>
              <a href="#forgot-password" style={{
                display: "block", textAlign: "center", fontFamily: T.body, fontSize: 13.5,
                color: T.accent, textDecoration: "none",
              }}>
                Request a new link
              </a>
            </>
          ) : done ? (
            <>
              <h2 style={{ fontFamily: T.head, fontSize: 20, fontWeight: 700, color: T.text, margin: "0 0 12px" }}>
                Password reset
              </h2>
              <p style={{ fontFamily: T.body, fontSize: 13.5, color: T.textMuted, lineHeight: 1.6, margin: "0 0 20px" }}>
                Your password has been changed. Sign in with your new password below.
              </p>
              <a href="#login" onClick={e => { e.preventDefault(); window.location.hash = "login"; }} style={{
                display: "block", textAlign: "center", padding: "11px", borderRadius: 8,
                background: T.accent, color: "#fff", fontFamily: T.body, fontSize: 14, fontWeight: 600,
                textDecoration: "none",
              }}>
                Go to sign in
              </a>
            </>
          ) : (
            <>
              <h2 style={{ fontFamily: T.head, fontSize: 20, fontWeight: 700, color: T.text, margin: "0 0 20px" }}>
                Choose a new password
              </h2>
              <form onSubmit={handleSubmit}>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
                    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>
                    New Password
                  </label>
                  <input
                    type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                    required autoFocus autoComplete="new-password"
                    style={inputStyle}
                    onFocus={e => e.currentTarget.style.borderColor = T.accent}
                    onBlur={e  => e.currentTarget.style.borderColor = T.border}
                  />
                  <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 5, lineHeight: 1.5 }}>
                    At least 12 characters, with 3 of: lowercase, uppercase, digit, symbol.
                  </div>
                </div>

                <div style={{ marginBottom: 24 }}>
                  <label style={{ display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
                    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>
                    Confirm New Password
                  </label>
                  <input
                    type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                    required autoComplete="new-password"
                    style={inputStyle}
                    onFocus={e => e.currentTarget.style.borderColor = T.accent}
                    onBlur={e  => e.currentTarget.style.borderColor = T.border}
                  />
                </div>

                {error && (
                  <div style={{
                    padding: "10px 14px", borderRadius: 8, marginBottom: 16,
                    background: T.danger + "18", border: `1px solid ${T.danger}44`,
                    fontFamily: T.body, fontSize: 13, color: T.danger,
                  }}>
                    {error}
                  </div>
                )}

                <button type="submit" disabled={loading} style={{
                  width: "100%", padding: "11px",
                  background: loading ? T.border : T.accent,
                  color: "#fff", border: "none", borderRadius: 8,
                  fontFamily: T.body, fontSize: 14, fontWeight: 600,
                  cursor: loading ? "default" : "pointer",
                  transition: "background .15s",
                }}>
                  {loading ? "Resetting…" : "Reset password"}
                </button>
              </form>
            </>
          )}
        </div>

        <div style={{ textAlign: "center", marginTop: 20,
          fontFamily: T.mono, fontSize: 10, color: T.border, letterSpacing: ".08em" }}>
          v{VERSION} · CargoDesk
        </div>
      </div>
    </div>
  );
};

export default ResetPasswordPage;
