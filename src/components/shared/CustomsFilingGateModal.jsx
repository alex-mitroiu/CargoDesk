import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { IconWarning, IconCheck } from "../primitives/Icon";
import { HZ, HZ_MONO, HZ_BODY } from "../../pages/shipments/shipmentDetailTheme";

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
  // USPPI (Shipper) / Ultimate Consignee (TKT-6A7J45 story 7) — both legally required EEI
  // fields the shipment already carries, but nothing previously checked they were actually
  // filled in before letting a filing be created.
  { key: "parties", label: "Shipper (USPPI) and Consignee set", detail: "Set both on Parties & Offices" },
];

const CustomsFilingGateModal = ({ missingBroker, missingCargo, missingParties, onGoToParties, onGoToCargo }) => {
  const missing = { broker: missingBroker, cargo: missingCargo, parties: missingParties };

  return (
    <Modal title="Customs Filing Unavailable" onClose={() => {}} width={440} hideClose>
      <div style={{ padding: "10px 14px", borderRadius: 8, background: HZ.warnBg,
        border: `1px solid ${HZ.warn}44`, display: "flex", gap: 10, alignItems: "flex-start",
        marginBottom: 14 }}>
        <span style={{ color: HZ.warn, flexShrink: 0, marginTop: 1 }}><IconWarning size={15} /></span>
        <div style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text, lineHeight: 1.5 }}>
          All of the following are required before a customs filing can be created for this
          shipment. This page stays locked until whichever is still missing below is set.
        </div>
      </div>

      <div style={{ background: HZ.bg, border: `1px solid ${HZ.border}`, borderRadius: 8,
        overflow: "hidden", marginBottom: 18 }}>
        {CHECK_ITEMS.map((item, i) => {
          const isMissing = missing[item.key];
          const col = isMissing ? HZ.crit : HZ.good;
          return (
            <div key={item.key} style={{ display: "flex", alignItems: "flex-start", gap: 10,
              padding: "10px 14px", borderBottom: i < CHECK_ITEMS.length - 1 ? `1px solid ${HZ.border}` : "none" }}>
              <span style={{ color: col, flexShrink: 0, marginTop: 2, display: "inline-flex" }}>
                {isMissing ? <span style={{ fontSize: 12, fontWeight: 700 }}>✗</span> : <IconCheck size={13} />}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: HZ_BODY, fontSize: 12.5, fontWeight: 600, color: HZ.text }}>
                  {item.label}
                </div>
                <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginTop: 1 }}>
                  {item.detail}
                </div>
              </div>
              <span style={{ fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".06em",
                textTransform: "uppercase", color: col, background: col + "22",
                borderRadius: 4, padding: "2px 7px",
                flexShrink: 0, marginTop: 1 }}>
                {isMissing ? "Missing" : "Set"}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {(missingBroker || missingParties) &&
          <Btn variant={missingCargo ? "secondary" : "primary"} onClick={onGoToParties}>Go to Parties</Btn>}
        {missingCargo  && <Btn onClick={onGoToCargo}>Go to Cargo</Btn>}
      </div>
    </Modal>
  );
};

export default CustomsFilingGateModal;
