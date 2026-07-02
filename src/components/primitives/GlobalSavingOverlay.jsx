import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { subscribeSaving } from "../../saving";

// Inject keyframe once (reuses the same animation id as Spinner)
if (!document.getElementById("cd-spinner-style")) {
  const s = document.createElement("style");
  s.id = "cd-spinner-style";
  s.textContent = `@keyframes cd-spin { to { transform: rotate(360deg) } }`;
  document.head.appendChild(s);
}

const GlobalSavingOverlay = () => {
  const [active, setActive] = useState(false);

  useEffect(() => subscribeSaving(setActive), []);

  if (!active) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9500,
      background: "rgba(0,0,0,.45)",
      display: "flex", alignItems: "center", justifyContent: "center",
      backdropFilter: "blur(2px)",
    }}>
      <div style={{
        background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: 14, padding: "28px 40px",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
        boxShadow: "0 24px 64px rgba(0,0,0,.5)",
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: "50%",
          border: `3.5px solid ${T.accent}22`,
          borderTopColor: T.accent,
          animation: "cd-spin .7s linear infinite",
        }} />
        <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          Processing…
        </span>
      </div>
    </div>
  );
};

export default GlobalSavingOverlay;
