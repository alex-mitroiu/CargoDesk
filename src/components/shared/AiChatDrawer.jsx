import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../../tokens";
import { api } from "../../api";

const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const Bubble = ({ msg }) => {
  const isUser = msg.role === "user";
  return (
    <div style={{
      display: "flex", justifyContent: isUser ? "flex-end" : "flex-start",
      marginBottom: 10,
    }}>
      {!isUser && (
        <div style={{
          width: 26, height: 26, borderRadius: "50%", flexShrink: 0, marginRight: 8,
          background: T.accent, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.btnPrimaryText,
          alignSelf: "flex-end",
        }}>✦</div>
      )}
      <div style={{
        maxWidth: "78%",
        background: isUser ? T.accent : T.surface,
        color:      isUser ? T.btnPrimaryText : T.text,
        border:     isUser ? "none" : `1px solid ${T.border}`,
        borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
        padding: "9px 12px",
        fontFamily: T.body, fontSize: 13, lineHeight: 1.55,
      }}>
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.content}</div>
        <div style={{
          fontSize: 10, marginTop: 4,
          color: isUser ? T.btnPrimaryText + "aa" : T.textMuted,
          textAlign: isUser ? "right" : "left",
        }}>{fmtTime(msg.ts)}</div>
      </div>
    </div>
  );
};

const TypingIndicator = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
    <div style={{
      width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
      background: T.accent, display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.btnPrimaryText,
    }}>✦</div>
    <div style={{
      background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: "12px 12px 12px 2px", padding: "10px 14px",
      display: "flex", gap: 4, alignItems: "center",
    }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 6, height: 6, borderRadius: "50%", background: T.textMuted,
          animation: `aiTypingDot 1.2s ${i * 0.2}s ease-in-out infinite`,
          display: "inline-block",
        }} />
      ))}
    </div>
  </div>
);

export default function AiChatDrawer({ open, onClose, shipmentId }) {
  const [messages, setMessages] = useState([]);
  const [input,    setInput]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [enabled,  setEnabled]  = useState(false);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  // Check if AI is enabled
  useEffect(() => {
    api.ai.settings().then(s => setEnabled(s.enabled)).catch(() => {});
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
      if (messages.length === 0) {
        setMessages([{
          role: "assistant",
          content: shipmentId
            ? `Hello! I'm your CargoDesk AI assistant. I can see you're viewing shipment ${shipmentId}. How can I help?`
            : "Hello! I'm your CargoDesk AI assistant. Ask me anything about your shipments, contracts, or freight operations.",
          ts: new Date().toISOString(),
        }]);
      }
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");

    const userMsg = { role: "user", content: text, ts: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      // Build conversation history (exclude greeting, only user/assistant pairs)
      const history = [...messages, userMsg]
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({ role: m.role, content: m.content }));

      const data = await api.ai.chat(history, shipmentId ? { shipmentId } : {});
      setMessages(prev => [...prev, {
        role: "assistant",
        content: data.reply || "Sorry, I couldn't generate a response.",
        ts: new Date().toISOString(),
      }]);
    } catch (e) {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `Error: ${e.message}`,
        ts: new Date().toISOString(),
      }]);
    }
    setLoading(false);
  }, [input, loading, messages, shipmentId]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Typing animation keyframes */}
      <style>{`
        @keyframes aiTypingDot {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
          40%            { opacity: 1;   transform: scale(1); }
        }
      `}</style>

      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 1199, background: "rgba(0,0,0,.2)" }}
      />

      {/* Drawer panel */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0,
        width: 380, zIndex: 1200,
        background: T.bg, borderLeft: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 32px rgba(0,0,0,.2)",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
          flexShrink: 0,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: "50%",
            background: T.accent, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.btnPrimaryText,
          }}>✦</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text }}>
              CargoDesk AI
            </div>
            {shipmentId && (
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.accent }}>
                Context: {shipmentId}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 18, lineHeight: 1, padding: 4 }}
          >✕</button>
        </div>

        {/* Not enabled warning */}
        {!enabled && (
          <div style={{
            margin: 16, padding: "10px 14px", borderRadius: 8,
            background: T.warning + "18", border: `1px solid ${T.warning}44`,
            fontFamily: T.body, fontSize: 12, color: T.warning, lineHeight: 1.5,
          }}>
            AI Agent is not enabled. Ask an admin to configure it in Application Settings → AI Agent.
          </div>
        )}

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 14px" }}>
          {messages.map((m, i) => <Bubble key={i} msg={m} />)}
          {loading && <TypingIndicator />}
          <div ref={bottomRef} />
        </div>

        {/* Composer */}
        <div style={{
          padding: "12px 14px", borderTop: `1px solid ${T.border}`,
          display: "flex", gap: 8, flexShrink: 0,
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!enabled || loading}
            placeholder={enabled ? "Ask about shipments, contracts… (Enter to send)" : "AI Agent not configured"}
            rows={2}
            style={{
              flex: 1, padding: "8px 12px",
              border: `1px solid ${T.border}`, borderRadius: 8,
              background: T.surface, color: T.text,
              fontFamily: T.body, fontSize: 13, lineHeight: 1.4,
              resize: "none", outline: "none",
              opacity: enabled ? 1 : 0.5,
            }}
            onFocus={e => e.currentTarget.style.borderColor = T.accent}
            onBlur={e  => e.currentTarget.style.borderColor = T.border}
          />
          <button
            type="button"
            onClick={send}
            disabled={!enabled || !input.trim() || loading}
            style={{
              padding: "0 16px", borderRadius: 8, border: "none",
              background: T.accent, color: T.btnPrimaryText,
              fontFamily: T.body, fontSize: 13, fontWeight: 600,
              cursor: (!enabled || !input.trim() || loading) ? "not-allowed" : "pointer",
              opacity: (!enabled || !input.trim() || loading) ? 0.5 : 1,
              alignSelf: "stretch",
            }}
          >
            Send
          </button>
        </div>
      </div>
    </>
  );
}
