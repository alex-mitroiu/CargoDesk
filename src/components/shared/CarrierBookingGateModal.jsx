import { T } from "../../tokens";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { IconWarning } from "../primitives/Icon";

// ─── Carrier Booking — prerequisite gate ──────────────────────────────────────
// Blocks the Carrier Booking page entirely until the shipment has both a contract and a
// schedule — no close button, no backdrop dismiss (Modal's own backdrop has no onClick,
// so hideClose alone is enough), only the one way out: go fix it. Modeled directly on
// ChangePasswordModal's forced pattern (warning banner + hideClose + a single action
// button in place of Cancel) rather than inventing a new blocking-modal convention.

const CarrierBookingGateModal = ({ missingContract, missingSchedule, onGoToSchedules }) => {
  const both = missingContract && missingSchedule;
  const message = both
    ? "This shipment doesn't have a contract or a schedule assigned yet."
    : missingContract
    ? "This shipment doesn't have a contract assigned yet."
    : "This shipment doesn't have a schedule assigned yet.";

  return (
    <Modal title="Carrier Booking Unavailable" onClose={() => {}} width={440} hideClose>
      <div style={{ padding: "10px 14px", borderRadius: 8, background: `${T.warning}18`,
        border: `1px solid ${T.warning}44`, display: "flex", gap: 10, alignItems: "flex-start",
        marginBottom: 18 }}>
        <span style={{ color: T.warning, flexShrink: 0, marginTop: 1 }}><IconWarning size={15} /></span>
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, lineHeight: 1.5 }}>
          {message} A carrier booking needs both before it can be sent, so this page stays
          locked until Contracts &amp; Schedules has {both ? "them" : "it"} set.
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn onClick={onGoToSchedules}>Go to Contracts &amp; Schedules</Btn>
      </div>
    </Modal>
  );
};

export default CarrierBookingGateModal;
