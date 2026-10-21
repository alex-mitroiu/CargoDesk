import { useState } from "react";
import { T } from "../../tokens";
import Btn from "../primitives/Btn";
import { Modal } from "../primitives/Modal";
import { inputBase } from "../primitives/Form";

// Where to book (Epic TKT-KFGL81, Story 2; approved mockup https://claude.ai/artifact/KTkERe9u1qHg1yaESQaCEm):
// the Lane Steering line for the shipment and each option's status — the pick, available, full or
// skipped with its reason — with the free space behind it, from GET /api/where-to-book
// (lib/where-to-book.js works every figure out; this only shows it). onBook(option) books an
// option; the contract picker stages it, still needing Confirm Selection.

const STATUS = {
  pick:      { label: "THE PICK",  color: () => T.accent },
  available: { label: "AVAILABLE", color: () => T.success },
  full:      { label: "FULL",      color: () => T.warning },
  skipped:   { label: "SKIPPED",   color: () => T.textMuted },
};

const fmt = d => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "";

// The configuration an option would be booked on: its first with free space, else its first.
export const spaceOf = o => (o?.space || []).find(s => s.freeTEU > 0) || o?.space?.[0] || null;

// A space configuration as the contract picker's cards and its parent expect one (the subset
// pickAllocation and the overbooking dialog read), built from the answer when the picker's own
// list doesn't hold it (the shipment form narrows that list to the chosen carrier).
export const allocFromOption = (o, s, { pol = "", pod = "" } = {}) => ({
  id: s.id, contractId: o.contractId, contractNumber: o.contractNumber, carrierCode: o.carrierCode, matchedRoutingId: s.matchedRoutingId || "",
  pol, pod, allocatedTEU: s.allocatedTEU, confirmedTEU: s.confirmedTEU, pendingTEU: s.pendingTEU, rejectedTEU: 0,
  remainingTEU: Math.max(0, s.allocatedTEU - s.confirmedTEU), spaceBasis: s.spaceBasis, week: s.week, weekNumber: s.weekNumber,
  effectiveDate: s.effectiveDate, endDate: s.endDate, customerId: s.customerId, customerName: s.customerName,
  contract: o.contractRef ? { contractRef: o.contractRef } : null,
});

// ─── The out-of-order warning (Story 3) ───────────────────────────────────────────────────────
// Before a contract is saved: does this choice skip a higher steered option that has space?
// contractId: the contract being booked ("" for SPOT). → null (fine) | { kind: "out_of_order" |
// "off_line" | "spot", higher, booked }. The server works out and saves the verdict itself
// (lib/where-to-book.js recordVerdict); this only decides whether to ask for a reason first.
export function steeringCheck(answer, contractId, { spot = false } = {}) {
  if (!answer?.line) return null;
  const available = answer.options.filter(o => o.status === "available");
  if (spot) return available.length ? { kind: "spot", higher: available[0], booked: null } : null;
  const booked = answer.options.find(o => o.contractId === contractId);
  if (booked) {
    const higher = available.find(o => o.rank < booked.rank);
    return higher ? { kind: "out_of_order", higher, booked } : null;
  }
  return available.length ? { kind: "off_line", higher: available[0], booked: null } : null;
}

const freeWords = o => {
  if (o.orderOnly) return "has no space cap";
  const s = spaceOf(o);
  return `has ${Math.max(0, s?.freeTEU ?? 0)} TEU free${s?.spaceBasis === "week" ? ` in week ${s.weekNumber}` : ""}`;
};

// Asks why, before booking against the steering: a reason is required (decided 2026-10-21), and it
// is saved on the shipment and in its History. onInstead books the better option instead; onAnyway
// books the choice with the reason. Warn, never block.
export function SteeringWarningDialog({ check, choiceLabel, insteadLabel, onInstead, onAnyway, onCancel }) {
  const [reason, setReason] = useState("");
  const h = check.higher;
  const better = `#${h.rank} ${h.carrierCode} ${h.contractNumber}`;
  const title = check.kind === "out_of_order" ? `Book on #${check.booked.rank} while ${better} has space?`
    : check.kind === "spot" ? `Buy SPOT while ${better} has space?` : `Book off the steering while ${better} has space?`;
  return (
    <Modal title={title} onClose={onCancel} width={540} data-testid="steering-warning-dialog">
      <div style={{ display: "flex", flexDirection: "column", gap: 12, fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.55 }}>
        <span style={{ alignSelf: "flex-start", fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: ".06em", padding: "2px 8px", borderRadius: 4,
          background: T.warning + "22", color: T.warning }}>{check.kind === "out_of_order" ? "OUT OF ORDER" : "OFF THE STEERING"}</span>
        <div>
          {better} {freeWords(h)} and comes first in the steering. {choiceLabel ? <>Booking <strong>{choiceLabel}</strong> is allowed, </> : "It's allowed, "}
          but it is recorded as {check.kind === "out_of_order" ? "out of order" : check.kind === "spot" ? "SPOT while steered space was free" : "off the steering"}.
        </div>
        <label htmlFor="steering-warning-reason" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: T.textMuted }}>
          Why book this one? Saved on the shipment and in its History.
          <textarea id="steering-warning-reason" data-testid="steering-warning-reason" rows={3} value={reason} onChange={e => setReason(e.target.value)}
            placeholder="e.g. The customer asked for this carrier" style={{ ...inputBase, fontFamily: T.body, fontSize: 13, resize: "vertical" }} />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn variant="secondary" disabled={!reason.trim()} onClick={() => onAnyway(reason.trim())} data-testid="steering-warning-anyway">
            {check.kind === "spot" ? "Use SPOT anyway" : "Book here anyway"}
          </Btn>
          {onInstead && <Btn onClick={onInstead} data-testid="steering-warning-instead">{insteadLabel || `Book on #${h.rank} instead`}</Btn>}
        </div>
      </div>
    </Modal>
  );
}

// What a shipment's saved verdict says, for the chip in its Contract area. null = nothing to show.
export function steeringChipOf(s) {
  const p = s?.steeringPick || {};
  const of = p.options ? ` of ${p.options}` : "";
  const better = p.rank ? `#${p.rank} ${p.carrierCode} ${p.contractNumber}${p.orderOnly ? "" : ` had ${p.freeTeu ?? 0} TEU free`}` : "";
  const why = s?.steeringReason ? `Reason: ${s.steeringReason}` : "No reason given";
  switch (s?.steeringVerdict) {
    case "steered":        return { tone: "good", label: `#${s.steeringRank}${of} · steered`, title: "Booked as the Lane Steering says" };
    case "rebooked":       return { tone: "good", label: `${s.steeringRank ? `#${s.steeringRank}${of} · ` : ""}rebooked down the line`, title: "Moved to the next option by an escalation or the no-answer switch" };
    case "out_of_order":   return { tone: "warn", label: `#${s.steeringRank}${of} · out of order`, title: `${better}. ${why}` };
    case "other_contract": return { tone: "warn", label: "Off the steering · other contract", title: `${better}. ${why}` };
    case "other_carrier":  return { tone: "warn", label: "Off the steering · other carrier", title: `${better}. ${why}` };
    case "spot":           return { tone: "warn", label: "SPOT while steered space was free", title: `${better}. ${why}` };
    case "other_loop":     return { tone: "warn", label: "Off its space's loop", title: "The sailing moved to another loop, so its space configuration was dropped" };
    case "not_covered":    return { tone: "muted", label: "No steering with space", title: "No Lane Steering line for this lane and customer, or no option had space" };
    default:               return null;
  }
}

const detailOf = o => {
  if (o.status === "skipped") return `Skipped: ${o.reason}`;
  if (o.orderOnly) return "No space configured — order only, no cap";
  const s = spaceOf(o);
  if (!s) return "";
  return [`Space ${s.id}`, s.spaceBasis === "week" ? `week ${s.weekNumber}, ${s.allocatedTEU} TEU a week` : `${fmt(s.effectiveDate)} – ${fmt(s.endDate)}`,
    s.loopCode ? `loop ${s.loopCode}` : "", s.customerName ? `${s.customerName} only` : ""].filter(Boolean).join(" · ");
};
const freeText = o => {
  if (o.status === "skipped") return "";
  if (o.orderOnly) return "no cap";
  const s = spaceOf(o);
  return o.status === "full" ? `Full${s?.spaceBasis === "week" ? ` in week ${s.weekNumber}` : ""}` : s ? `${Math.max(0, s.freeTEU)} of ${s.allocatedTEU} TEU free` : "";
};

const Chip = ({ status }) => {
  const c = STATUS[status].color();
  return (
    <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: ".06em", padding: "2px 8px", borderRadius: 4,
      background: c + "1f", color: c }}>{STATUS[status].label}</span>
  );
};

export default function WhereToBookPanel({ answer, onBook, stagedRank = null }) {
  if (!answer) return null;
  if (!answer.line) {
    return (
      <div data-testid="where-to-book-none" style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, padding: "8px 12px",
        border: `1px dashed ${T.border}`, borderRadius: 8 }}>
        No steering for {answer.lane || "this trade lane"}: pick from the space configurations and contracts below.
      </div>
    );
  }
  const { line, pick } = answer;
  return (
    <section aria-label="Where to book" data-testid="where-to-book"
      style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", borderRadius: 10, border: `1px solid ${T.accent}55`, background: T.surface }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: "4px 16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 700, color: T.text }}>Where to book</span>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            Steering for <strong style={{ color: T.text }}>{line.customerName || "everyone"}</strong> · {answer.lane} · {fmt(line.validFrom)} – {fmt(line.validTo)}
          </span>
        </div>
        {line.note && <span data-testid="where-to-book-line-note" style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Note: “{line.note}”</span>}
      </div>
      {answer.options.map(o => {
        const isPick = pick?.rank === o.rank;
        const status = isPick ? "pick" : o.status;
        const canBook = o.status === "available" && !isPick && pick && o.rank > pick.rank;
        const staged = stagedRank === o.rank;
        return (
          <div key={o.rank} data-testid={`where-to-book-option-${o.rank}`}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 8,
              border: `1px solid ${isPick || staged ? T.accent : T.border}`, background: isPick ? T.accent + "0f" : T.bg }}>
            <span style={{ flexShrink: 0, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 7,
              fontFamily: T.mono, fontSize: 13, fontWeight: 700, background: isPick ? T.accent : T.border + "66", color: isPick ? "#fff" : T.text }}>#{o.rank}</span>
            <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{o.carrierCode}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{o.contractNumber}{o.contractRef ? ` · ${o.contractRef}` : ""}</span>
                <Chip status={status} />
              </div>
              <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{detailOf(o)}</span>
              {o.note && <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, fontStyle: "italic" }}>{o.note}</span>}
            </div>
            <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5, minWidth: 130 }}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: o.status === "full" ? T.warning : T.text }}>{freeText(o)}</span>
              {isPick && onBook && (
                <Btn size="sm" onClick={() => onBook(o)} data-testid={`where-to-book-book-${o.rank}`}>
                  {staged ? "Selected — confirm below" : `Book on #${o.rank}${pick.overbooking ? " (overbook)" : ""}`}
                </Btn>
              )}
              {canBook && onBook && (
                <Btn size="sm" variant="secondary" onClick={() => onBook(o)} data-testid={`where-to-book-book-${o.rank}`}>
                  {staged ? "Selected — confirm below" : "Book here"}
                </Btn>
              )}
            </div>
          </div>
        );
      })}
      <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
        Free space = allocated − confirmed − pending, in the ETD’s week for weekly space. Options are in the order set in Lane Steering.
        {pick?.allFull ? " Every option is full: the first one takes it as an overbooking." : ""}
      </span>
    </section>
  );
}
