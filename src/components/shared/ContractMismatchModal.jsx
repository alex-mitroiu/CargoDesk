import { useState } from "react";
import { T } from "../../tokens";
import { Modal } from "../primitives/Modal";
import { ContractTypeInput, Inp } from "../primitives/Form";
import { ContractField } from "../../pages/ShipmentFormPage";

// ─── Contract Mismatch — forcing modal ─────────────────────────────────────
// Auto-opened by ShipmentHeaderBar whenever a Central contract no longer covers
// the shipment's current POL/POD (route changed after the contract was picked,
// with nothing re-validating it — same gap PendingRevalidationModal already
// covers for Pending shipments). No close button: the only way out is to
// actually resolve it — pick a matching contract/space config, or switch to a
// manual contract type (SPOT / Pending / Customer Own).

const ContractMismatchModal = ({ shipment, pol, pod, needsPolHaulage, needsPodHaulage, pkuLocation, delLocation, onUpdate }) => {
  const [refVal, setRefVal] = useState(shipment.contractRef || "");

  const updateType = v => {
    onUpdate(shipment.id, {
      ...shipment, contractType: v,
      ...(v !== "Central" ? { contractId: "", contractRef: "", allocationId: "" } : {}),
    });
    setRefVal("");
  };

  const saveRef = () => {
    if (refVal !== (shipment.contractRef || "")) onUpdate(shipment.id, { ...shipment, contractRef: refVal });
  };

  return (
    <Modal title="⚠ Contract doesn't match this route" width={560} hideClose>
      <p style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, margin: "0 0 4px", lineHeight: 1.6 }}>
        <strong style={{ fontFamily: T.mono }}>{shipment.contractRef || "The attached contract"}</strong> no longer covers{" "}
        <strong style={{ fontFamily: T.mono }}>{pol} → {pod}</strong>.
      </p>
      <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "0 0 20px", lineHeight: 1.6 }}>
        Pick a contract that actually covers this route — via a linked space configuration or the
        Central contract list — or switch to a manual contract type below.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <ContractTypeInput value={shipment.contractType} onChange={updateType} />
        {shipment.contractType === "Central" ? (
          <ContractField
            value={{ id: shipment.contractId, ref: shipment.contractRef, allocationId: shipment.allocationId }}
            onChange={({ id, ref, carrierCode, allocationId, spaceSkipReason, spaceOverageReason }) => {
              onUpdate(shipment.id, {
                ...shipment,
                contractId: id, contractRef: ref,
                allocationId: allocationId !== undefined ? allocationId : shipment.allocationId,
                spaceSkipReason: spaceSkipReason !== undefined ? spaceSkipReason : shipment.spaceSkipReason,
                spaceOverageReason: spaceOverageReason !== undefined ? spaceOverageReason : shipment.spaceOverageReason,
                ...(carrierCode ? { carrierCode } : {}),
              });
            }}
            pol={pol} pod={pod} etd={shipment.etd} crd={shipment.cargoReadyDate}
            needsPolHaulage={needsPolHaulage} needsPodHaulage={needsPodHaulage}
            pkuLocation={pkuLocation} delLocation={delLocation}
            contractType={shipment.contractType} carrierCode={shipment.carrierCode}
          />
        ) : (
          <Inp label="Contract Reference" value={refVal} onChange={setRefVal} onBlur={saveRef}
            placeholder="e.g. SPOT-2025-001" mono hint="Free-text reference for this contract arrangement" />
        )}
      </div>
    </Modal>
  );
};

export default ContractMismatchModal;
