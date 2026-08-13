import { useState } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { VERSION } from "../version";
import { IconAnchor } from "../components/primitives/Icon";

// ─── Forgot Password ────────────────────────────────────────────────────────
// Public page, same visual shell as LoginPage — reached via the "Forgot password?" link
// there (#forgot-password) or directly. Always shows the same generic "check your inbox"
// message regardless of whether the email actually matched an account (routes/auth.js's own
// forgot-password route is deliberately built the same way) — this page just displays
// whatever the backend already decided to say, it doesn't add its own enumeration risk on top.

const ForgotPasswordPage = () => {
  const [email,   setEmail]   = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [sent,    setSent]    = useState(null); // null | the generic message string

  const handleSubmit = async e => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { message } = await api.auth.forgotPassword(email);
      setSent(message);
    } catch (e) {
      setError(e.message || "Something went wrong — try again");
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
          <h2 style={{ fontFamily: T.head, fontSize: 20, fontWeight: 700,
            color: T.text, margin: "0 0 8px" }}>
            Reset your password
          </h2>

          {sent ? (
            <>
              <p style={{ fontFamily: T.body, fontSize: 13.5, color: T.textMuted, lineHeight: 1.6, margin: "12px 0 24px" }}>
                {sent}
              </p>
              <a href="#" onClick={e => { e.preventDefault(); window.location.hash = ""; }} style={{
                display: "block", textAlign: "center", fontFamily: T.body, fontSize: 13.5,
                color: T.accent, textDecoration: "none",
              }}>
                ← Back to sign in
              </a>
            </>
          ) : (
            <>
              <p style={{ fontFamily: T.body, fontSize: 13.5, color: T.textMuted, lineHeight: 1.6, margin: "12px 0 20px" }}>
                Enter your account email and we'll send a link to reset your password.
              </p>
              <form onSubmit={handleSubmit}>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
                    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>
                    Email
                  </label>
                  <input
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    required autoFocus autoComplete="email"
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
                  marginBottom: 16,
                }}>
                  {loading ? "Sending…" : "Send reset link"}
                </button>
              </form>
              <a href="#" onClick={e => { e.preventDefault(); window.location.hash = ""; }} style={{
                display: "block", textAlign: "center", fontFamily: T.body, fontSize: 13.5,
                color: T.textMuted, textDecoration: "none",
              }}>
                ← Back to sign in
              </a>
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

export default ForgotPasswordPage;
