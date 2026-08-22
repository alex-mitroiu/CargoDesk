import { T } from "../../tokens";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { IconWarning } from "../primitives/Icon";

// Credit hold — hard block, no way to proceed from here (Organization Model Enhancement
// Epic 2, extended by Credit Control Depth / TKT-Q00WHF to fire at carrier-booking send time
// too, not just invoice generation — extracted here so both call sites share one component
// instead of drifting apart). Named per role rather than just "this customer" since more than
// one attached party (Shipper/Consignee/Principal/the linked contract's Named Account) could
// be the one actually on hold, and the operator needs to know which relationship to go resolve.
// `action` is the specific thing being blocked ("generating a new invoice", "sending a carrier
// booking request") — same component, different call-site wording, never a generic "something
// blocked" message.
const CreditHoldModal = ({ holds, action = "generating a new invoice", onClose }) => (
  <Modal title="Blocked — Credit Hold" onClose={onClose} width={460}>
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ padding: "10px 14px", borderRadius: 8, background: `${T.danger}18`,
        border: `1px solid ${T.danger}44`, display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span style={{ color: T.danger, flexShrink: 0, marginTop: 1 }}><IconWarning size={15} /></span>
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, lineHeight: 1.5 }}>
          {holds.length === 1
            ? <>The {holds[0].role.toLowerCase()} on this shipment, <strong>{holds[0].companyName}</strong>, is on credit hold.</>
            : <>{holds.length} parties on this shipment are on credit hold.</>}
          {" "}{action.charAt(0).toUpperCase() + action.slice(1)} can't proceed until the hold is cleared on their customer profile.
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {holds.map((h, i) => (
          <div key={i} style={{ padding: "8px 12px", borderRadius: 6, background: T.bg, border: `1px solid ${T.border}` }}>
            <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.text }}>
              {h.companyName} <span style={{ fontWeight: 400, color: T.textMuted }}>— {h.role}</span>
            </div>
            {h.reason && (
              <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginTop: 2 }}>{h.reason}</div>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn onClick={onClose}>Close</Btn>
      </div>
    </div>
  </Modal>
);

export default CreditHoldModal;
