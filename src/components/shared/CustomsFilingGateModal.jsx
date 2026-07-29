import { T } from "../../tokens";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { IconWarning } from "../primitives/Icon";

// ─── Customs Filing — prerequisite gate ────────────────────────────────────────
// Blocks the Customs Filing page entirely until the shipment has a Customs Broker
// (Export or Import — either is sufficient, since a shipment may only ever need one
// filing type) AND at least one priced cargo line. Mirrors CarrierBookingGateModal's
// exact shape (hideClose, no backdrop dismiss, warning banner, modeled on
// ChangePasswordModal's forced pattern) — the one deviation: the two preconditions
// here have different destinations (Parties vs. Cargo), so render one button per
// missing precondition instead of a single shared one.

const CustomsFilingGateModal = ({ missingBroker, missingCargo, onGoToParties, onGoToCargo }) => {
  const both = missingBroker && missingCargo;
  const message = both
    ? "This shipment has no Customs Broker assigned and no priced cargo line yet."
    : missingBroker
    ? "This shipment doesn't have a Customs Broker (Export or Import) assigned yet."
    : "This shipment doesn't have any priced cargo line yet.";

  return (
    <Modal title="Customs Filing Unavailable" onClose={() => {}} width={440} hideClose>
      <div style={{ padding: "10px 14px", borderRadius: 8, background: `${T.warning}18`,
        border: `1px solid ${T.warning}44`, display: "flex", gap: 10, alignItems: "flex-start",
        marginBottom: 18 }}>
        <span style={{ color: T.warning, flexShrink: 0, marginTop: 1 }}><IconWarning size={15} /></span>
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, lineHeight: 1.5 }}>
          {message} A customs filing needs both a broker on the shipment and at least one
          priced cargo line before it can be created, so this page stays locked until {both ? "they're" : "it's"} set.
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {missingBroker && <Btn variant={missingCargo ? "secondary" : "primary"} onClick={onGoToParties}>Go to Parties</Btn>}
        {missingCargo  && <Btn onClick={onGoToCargo}>Go to Cargo</Btn>}
      </div>
    </Modal>
  );
};

export default CustomsFilingGateModal;
