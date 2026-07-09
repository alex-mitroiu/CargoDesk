import { useState, useEffect } from "react";
import { T } from "../tokens";
import { api, TOKEN_KEY } from "../api";
import { VERSION } from "../version";

const LoginPage = ({ onLogin }) => {
  const [email,       setEmail]       = useState("");
  const [password,    setPassword]    = useState("");
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState("");
  const [ssoEnabled,  setSsoEnabled]  = useState(false);

  // Check for SSO availability and handle redirect params on mount
  useEffect(() => {
    api.auth.ssoConfig()
      .then(({ enabled }) => setSsoEnabled(!!enabled))
      .catch(() => {});

    const params = new URLSearchParams(window.location.search);

    const ssoToken = params.get("sso_token");
    if (ssoToken) {
      params.delete("sso_token");
      const newSearch = params.toString();
      window.history.replaceState({}, "", newSearch ? `?${newSearch}` : window.location.pathname);
      // Decode the JWT payload to extract the user object
      try {
        const payload = JSON.parse(atob(ssoToken.split(".")[1]));
        const user = { id: payload.id, email: payload.email, name: payload.name,
          role: payload.role, roles: payload.roles };
        onLogin(ssoToken, user);
        return;
      } catch {
        setError("SSO sign-in failed — invalid token received");
      }
    }

    const ssoError = params.get("sso_error");
    if (ssoError) {
      params.delete("sso_error");
      const newSearch = params.toString();
      window.history.replaceState({}, "", newSearch ? `?${newSearch}` : window.location.pathname);
      setError(decodeURIComponent(ssoError));
    }
  }, [onLogin]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { token, user } = await api.auth.login(email, password);
      onLogin(token, user);
    } catch (e) {
      setError(e.message || "Sign in failed");
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

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ fontFamily: T.head, fontSize: 30, fontWeight: 800, color: T.text, marginBottom: 6 }}>
            ⚓ CargoDesk
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
            letterSpacing: ".14em", textTransform: "uppercase" }}>
            Freight Management Platform
          </div>
        </div>

        {/* Card */}
        <div style={{
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 14, padding: "32px 32px 28px",
          boxShadow: "0 8px 32px rgba(0,0,0,.18)",
        }}>
          <h2 style={{ fontFamily: T.head, fontSize: 20, fontWeight: 700,
            color: T.text, margin: "0 0 24px" }}>
            Sign in
          </h2>

          {ssoEnabled && (
            <>
              <a href="/api/auth/sso/init" style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                width: "100%", padding: "11px", borderRadius: 8, textDecoration: "none",
                border: `1px solid ${T.border}`, background: T.bg, color: T.text,
                fontFamily: T.body, fontSize: 14, fontWeight: 600,
                transition: "border-color .15s, background .15s",
                boxSizing: "border-box",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.background = T.accent + "0a"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.bg; }}>
                <MicrosoftIcon />
                Sign in with Microsoft
              </a>
              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "20px 0" }}>
                <div style={{ flex: 1, height: 1, background: T.border }} />
                <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>or</span>
                <div style={{ flex: 1, height: 1, background: T.border }} />
              </div>
            </>
          )}

          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 16 }}>
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

            <div style={{ marginBottom: 24 }}>
              <label style={{ display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>
                Password
              </label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                required autoComplete="current-password"
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
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        <div style={{ textAlign: "center", marginTop: 20,
          fontFamily: T.mono, fontSize: 10, color: T.border, letterSpacing: ".08em" }}>
          v{VERSION} · CargoDesk
        </div>
      </div>
    </div>
  );
};

const MicrosoftIcon = () => (
  <svg width="18" height="18" viewBox="0 0 23 23" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="1" width="10" height="10" fill="#f25022"/>
    <rect x="12" y="1" width="10" height="10" fill="#7fba00"/>
    <rect x="1" y="12" width="10" height="10" fill="#00a4ef"/>
    <rect x="12" y="12" width="10" height="10" fill="#ffb900"/>
  </svg>
);

export default LoginPage;
