import { useState } from "react";
import { T } from "../../tokens";

// ─── Test Outcome Modal ───────────────────────────────────────────────────────
// Shown when a ticket leaves "In Testing". Forces an explicit Pass / Fail
// decision and captures optional (Pass) or mandatory (Fail) test notes before
// the ticket is routed to "Ready to Deploy" or "Testing Failed".

const TestOutcomeModal = ({ ticket, onConfirm, onCancel }) => {
  const [outcome, setOutcome] = useState(null);    // "pass" | "fail"
  const [notes,   setNotes]   = useState(ticket.testNotes || "");
  const [touched, setTouched] = useState(false);

  const notesRequired = outcome === "fail";
  const notesEmpty    = notes.trim() === "";
  const invalid       = notesRequired && notesEmpty;

  const submit = () => {
    setTouched(true);
    if (!outcome || invalid) return;
    onConfirm({
      newStatus: outcome === "pass" ? "Ready to Deploy" : "Testing Failed",
      testNotes: notes.trim() || null,
    });
  };

  const BTN_BASE = {
    flex: 1, padding: "18px 12px", borderRadius: 10, cursor: "pointer",
    fontFamily: T.head, fontSize: 15, fontWeight: 700, border: "2px solid",
    transition: "all .15s", display: "flex", flexDirection: "column",
    alignItems: "center", gap: 6,
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10002,
      background: "rgba(0,0,0,.7)", display: "flex", alignItems: "center",
      justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={{ width: "min(92vw, 460px)", background: T.surface,
        border: `1px solid ${T.border}`, borderRadius: 14,
        boxShadow: "0 28px 80px rgba(0,0,0,.6)", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text }}>
            Testing outcome
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 3 }}>
            <span style={{ fontFamily: T.mono, fontSize: 11 }}>{ticket.id}</span>
            {" · "}{ticket.title.length > 52 ? ticket.title.slice(0, 52) + "…" : ticket.title}
          </div>
        </div>

        <div style={{ padding: "20px 20px 0" }}>
          {/* Pass / Fail choice */}
          <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
            <button type="button" onClick={() => setOutcome("pass")} style={{
              ...BTN_BASE,
              background:   outcome === "pass" ? `${T.success}18` : "none",
              borderColor:  outcome === "pass" ? T.success : T.border,
              color:        outcome === "pass" ? T.success : T.textMuted,
            }}>
              <span style={{ fontSize: 28 }}>✅</span>
              <span>Pass</span>
              <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 400,
                color: outcome === "pass" ? T.success : T.textMuted, opacity: .8 }}>
                → Ready to Deploy
              </span>
            </button>

            <button type="button" onClick={() => setOutcome("fail")} style={{
              ...BTN_BASE,
              background:   outcome === "fail" ? `${T.danger}18` : "none",
              borderColor:  outcome === "fail" ? T.danger : T.border,
              color:        outcome === "fail" ? T.danger : T.textMuted,
            }}>
              <span style={{ fontSize: 28 }}>❌</span>
              <span>Fail</span>
              <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 400,
                color: outcome === "fail" ? T.danger : T.textMuted, opacity: .8 }}>
                → Testing Failed
              </span>
            </button>
          </div>

          {/* Notes field — always visible, mandatory label swaps on outcome */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600,
              color: (touched && invalid) ? T.danger : T.text,
              display: "block", marginBottom: 6 }}>
              {outcome === "fail" ? "Failure reason *" : "Test notes"}
              {outcome === "pass" && (
                <span style={{ fontWeight: 400, color: T.textMuted, marginLeft: 4 }}>(optional)</span>
              )}
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={outcome === "fail"
                ? "Describe what failed — steps to reproduce, error messages, environment…"
                : "Any notes about what was tested or verified…"}
              rows={4}
              style={{
                width: "100%", resize: "vertical", boxSizing: "border-box",
                fontFamily: T.body, fontSize: 13, color: T.text,
                background: T.bg, borderRadius: 7, padding: "9px 12px",
                border: `1px solid ${(touched && invalid) ? T.danger : T.border}`,
                outline: "none", lineHeight: 1.5,
              }}
            />
            {touched && invalid && (
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.danger, marginTop: 4 }}>
                A failure reason is required before marking as failed.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "0 20px 20px", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel}
            style={{ fontFamily: T.body, fontSize: 13, padding: "8px 18px",
              background: "none", border: `1px solid ${T.border}`, borderRadius: 7,
              color: T.textMuted, cursor: "pointer" }}>
            Cancel
          </button>
          <button type="button" onClick={submit}
            disabled={!outcome}
            style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700,
              padding: "8px 22px", borderRadius: 7, cursor: outcome ? "pointer" : "not-allowed",
              background: !outcome    ? T.border
                        : outcome === "pass" ? T.success : T.danger,
              border: "none", color: "#fff",
              opacity: !outcome ? 0.45 : 1,
              transition: "background .15s, opacity .15s" }}>
            {!outcome      ? "Select outcome"
             : outcome === "pass" ? "✅ Move to Ready to Deploy"
             :                      "❌ Move to Testing Failed"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TestOutcomeModal;
