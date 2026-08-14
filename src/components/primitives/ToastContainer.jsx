import { useState, useEffect, useRef } from "react";
import { T } from "../../tokens";
import { subscribe } from "../../toast";

// ─── Inject shrink keyframe once ─────────────────────────────────────────────
if (!document.getElementById("cd-toast-style")) {
  const s = document.createElement("style");
  s.id = "cd-toast-style";
  s.textContent = `@keyframes cd-shrink { from { width:100% } to { width:0% } }
    @keyframes cd-slide-in { from { opacity:0; transform:translateX(24px) } to { opacity:1; transform:translateX(0) } }`;
  document.head.appendChild(s);
}

// ─── Individual Toast ─────────────────────────────────────────────────────────
const Toast = ({ t, onDismiss }) => {
  const pauseRef = useRef(false);
  const startRef = useRef(Date.now());
  const timerRef = useRef(null);

  const TYPE = {
    success: { icon: "✓", color: () => T.success  },
    error:   { icon: "✕", color: () => T.danger   },
    warning: { icon: "⚠", color: () => T.warning  },
    info:    { icon: "ℹ", color: () => T.info     },
  }[t.type] ?? { icon: "·", color: () => T.textMuted };

  const color = TYPE.color();

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, t.duration);
    return () => clearTimeout(timerRef.current);
  }, []);

  const pause = () => {
    pauseRef.current = true;
    clearTimeout(timerRef.current);
  };
  const resume = () => {
    pauseRef.current = false;
    const elapsed  = Date.now() - startRef.current;
    const remaining = Math.max(0, t.duration - elapsed);
    timerRef.current = setTimeout(onDismiss, remaining);
  };

  return (
    <div
      onMouseEnter={pause}
      onMouseLeave={resume}
      style={{
        pointerEvents: "all",
        background: T.surface, border: `1px solid ${color}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 0, padding: "11px 14px",
        display: "flex", alignItems: "flex-start", gap: 10,
        minWidth: 260, maxWidth: 380,
        boxShadow: "0 6px 24px rgba(0,0,0,.25)",
        animation: "cd-slide-in .2s ease forwards",
        position: "relative", overflow: "hidden",
        fontFamily: T.body,
      }}>
      {/* Type icon */}
      <span style={{ fontSize: 14, fontWeight: 700, color, flexShrink: 0, marginTop: 1 }}>
        {TYPE.icon}
      </span>
      {/* Message */}
      <span style={{ fontSize: 13, color: T.text, flex: 1, lineHeight: 1.5, whiteSpace: "pre-line" }}>
        {t.message}
      </span>
      {/* Dismiss */}
      <button type="button" onClick={onDismiss}
        style={{ background: "none", border: "none", cursor: "pointer",
          color: T.textMuted, fontSize: 14, padding: 0, flexShrink: 0,
          lineHeight: 1, marginTop: 1 }}>
        ✕
      </button>
      {/* Progress bar */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, height: 2,
        background: color, opacity: 0.45,
        animation: `cd-shrink ${t.duration}ms linear forwards`,
        animationPlayState: pauseRef.current ? "paused" : "running",
      }} />
    </div>
  );
};

// ─── ToastContainer ───────────────────────────────────────────────────────────
const ToastContainer = () => {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    return subscribe(t => {
      setToasts(prev => [...prev.slice(-4), t]); // max 5 at once
    });
  }, []);

  const dismiss = id => setToasts(prev => prev.filter(t => t.id !== id));

  if (toasts.length === 0) return null;

  return (
    <div style={{
      position: "fixed", top: 54, right: 20,
      zIndex: 10000, display: "flex", flexDirection: "column",
      gap: 8, alignItems: "flex-end",
      pointerEvents: "none",
    }}>
      {toasts.map(t => (
        <Toast key={t.id} t={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
};

export default ToastContainer;