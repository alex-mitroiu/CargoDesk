import { T } from "../../tokens";

// ─── Consumption Bar ────────────────────────────────────────────────────────
// Shared 3-segment stacked bar for a space configuration's TEU split: Confirmed (the only
// bucket that actually deducts from available space — an operator's explicit Confirm click),
// Pending (Created/sent-awaiting-reply, informational), Rejected (its own visible segment,
// also informational — a future escalation workflow is separate, out of scope here). Four call
// sites render this identically (SpaceConfigurationsPage's table row + Linked Shipments modal,
// ShipmentSchedulesPage's Space Configuration panel, ShipmentFormPage's Contract Picker card),
// so it's a real shared component rather than four copies of the same track+segments JSX —
// same "tiny self-contained chart" precedent as SpaceConfigurationsPage's own Sparkline.
const ConsumptionBar = ({ allocated, confirmed = 0, pending = 0, rejected = 0, height = 6, width = "100%" }) => {
  const total = confirmed + pending + rejected;
  // When demand exceeds capacity, compress all three segments proportionally so the bar always
  // reads as exactly 100% rather than silently clipping or overflowing its own track.
  const scale = allocated > 0 && total > allocated ? allocated / total : 1;
  const pct = v => (allocated > 0 ? Math.min(100, (v * scale / allocated) * 100) : 0);
  const over = allocated > 0 && total > allocated;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, width }}>
      <div style={{ display: "flex", height, borderRadius: height / 2, background: T.border,
        overflow: "hidden", width: "100%" }}>
        {confirmed > 0 && <div style={{ height: "100%", width: `${pct(confirmed)}%`, background: T.success, flexShrink: 0 }} />}
        {pending > 0 && <div style={{ height: "100%", width: `${pct(pending)}%`, background: T.warning, flexShrink: 0 }} />}
        {rejected > 0 && <div style={{ height: "100%", width: `${pct(rejected)}%`, background: T.danger, flexShrink: 0 }} />}
      </div>
      {over && (
        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.danger, fontWeight: 700 }}>
          +{total - allocated} TEU over allocated
        </span>
      )}
    </div>
  );
};

export default ConsumptionBar;
