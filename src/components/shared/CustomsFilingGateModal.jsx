import { T } from "../../tokens";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { IconWarning, IconCheck } from "../primitives/Icon";

// ─── Customs Filing — prerequisite gate ────────────────────────────────────────
// Blocks the Customs Filing page entirely until the shipment has a Customs Broker
// (Export or Import — either is sufficient, since a shipment may only ever need one
// filing type) AND at least one priced cargo line. Mirrors CarrierBookingGateModal's
// exact shape (hideClose, no backdrop dismiss, warning banner, modeled on
// ChangePasswordModal's forced pattern) — the one deviation: the two preconditions
// here have different destinations (Parties vs. Cargo), so render one button per
// missing precondition instead of a single shared one.
//
// Point-by-point checklist rather than one combined sentence — a direct report found the
// original single-paragraph phrasing ("needs both a broker... and at least one priced cargo
// line") read as if BOTH were missing even when only one actually was, since the sentence
// mentioned both preconditions regardless of which one had actually failed the check.

const CHECK_ITEMS = [
  { key: "broker", label: "Customs Broker assigned", detail: "Export or Import — either satisfies this" },
  { key: "cargo",  label: "At least one priced cargo line", detail: "Set a Unit Value on any package under Cargo" },
];

const CustomsFilingGateModal = ({ missingBroker, missingCargo, onGoToParties, onGoToCargo }) => {
  const missing = { broker: missingBroker, cargo: missingCargo };

  return (
    <Modal title="Customs Filing Unavailable" onClose={() => {}} width={440} hideClose>
      <div style={{ padding: "10px 14px", borderRadius: 8, background: `${T.warning}18`,
        border: `1px solid ${T.warning}44`, display: "flex", gap: 10, alignItems: "flex-start",
        marginBottom: 14 }}>
        <span style={{ color: T.warning, flexShrink: 0, marginTop: 1 }}><IconWarning size={15} /></span>
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, lineHeight: 1.5 }}>
          Both of the following are required before a customs filing can be created for this
          shipment. This page stays locked until whichever is still missing below is set.
        </div>
      </div>

      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
        overflow: "hidden", marginBottom: 18 }}>
        {CHECK_ITEMS.map((item, i) => {
          const isMissing = missing[item.key];
          const col = isMissing ? T.danger : T.success;
          return (
            <div key={item.key} style={{ display: "flex", alignItems: "flex-start", gap: 10,
              padding: "10px 14px", borderBottom: i < CHECK_ITEMS.length - 1 ? `1px solid ${T.border}` : "none" }}>
              <span style={{ color: col, flexShrink: 0, marginTop: 2, display: "inline-flex" }}>
                {isMissing ? <span style={{ fontSize: 12, fontWeight: 700 }}>✗</span> : <IconCheck size={13} />}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: T.body, fontSize: 12.5, fontWeight: 600, color: T.text }}>
                  {item.label}
                </div>
                <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 1 }}>
                  {item.detail}
                </div>
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, letterSpacing: ".06em",
                textTransform: "uppercase", color: col, background: `${col}18`,
                border: `1px solid ${col}44`, borderRadius: 4, padding: "2px 7px",
                flexShrink: 0, marginTop: 1 }}>
                {isMissing ? "Missing" : "Set"}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {missingBroker && <Btn variant={missingCargo ? "secondary" : "primary"} onClick={onGoToParties}>Go to Parties</Btn>}
        {missingCargo  && <Btn onClick={onGoToCargo}>Go to Cargo</Btn>}
      </div>
    </Modal>
  );
};

export default CustomsFilingGateModal;
