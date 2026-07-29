import { useState } from "react";
import { T } from "../../tokens";
import { IconUpload, IconDownload } from "../primitives/Icon";

export const EDI_STATUS_COLOR = {
  pending: "#6b7280", sent: "#3b82f6", acknowledged: "#3b82f6",
  confirmed: "#22c55e", accepted: "#22c55e", rejected: "#ef4444", error: "#ef4444",
};

const fmtTs = iso => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
    " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
};

const payloadFor = m => {
  const raw = m.direction === "out" ? m.rawPayload : (m.parsedPayload || m.rawPayload);
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw || ""; }
};

// Plain message-thread rendering, lifted out of the old EdiMessagesDrawer so the Carrier
// Booking Details/Review pages (and the Test Tools simulator) can all reuse it instead of
// duplicating the same ~60 lines of JSX per consumer.
const EdiMessageList = ({ messages, emptyText = "No EDI messages yet." }) => {
  const [expandedId, setExpandedId] = useState(null);

  if (messages.length === 0) {
    return (
      <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted,
        fontStyle: "italic", textAlign: "center", padding: "40px 0" }}>
        {emptyText}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {messages.map(m => {
        const color = EDI_STATUS_COLOR[m.status] || T.textMuted;
        const expanded = expandedId === m.id;
        return (
          <div key={m.id} style={{ background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.text,
                display: "inline-flex", alignItems: "center", gap: 4 }}>
                {m.direction === "out" ? <><IconUpload size={11} />Sent</> : <><IconDownload size={11} />Received</>}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>
                {m.messageType.replace(/_/g, " ")}
              </span>
              <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                color, background: `${color}18`, border: `1px solid ${color}44`,
                borderRadius: 4, padding: "1px 7px", textTransform: "uppercase" }}>
                {m.status}{m.isMock ? " · demo" : ""}
              </span>
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, marginBottom: 8 }}>
              {fmtTs(m.createdAt)}
            </div>
            <button onClick={() => setExpandedId(expanded ? null : m.id)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                fontFamily: T.body, fontSize: 11, color: T.accent, textDecoration: "underline dotted" }}>
              {expanded ? "Hide payload" : "View payload"}
            </button>
            {expanded && (
              <pre style={{ marginTop: 8, fontFamily: T.mono, fontSize: 10.5, color: T.text,
                background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6,
                padding: "10px 12px", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {payloadFor(m)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default EdiMessageList;
