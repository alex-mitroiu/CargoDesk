import { useState } from "react";
import { T } from "../../tokens";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";

// ─── Export CSV — field picker ──────────────────────────────────────────────
// Mirrors routes/export.js's own CSV_FIELDS registry (key/label/mandatory) — kept as a second,
// independent copy since frontend and backend don't share a module in this app (same split as
// ADDITIONAL_PARTY_ROLES/CONTRACT_PRESETS elsewhere). Mandatory fields are shown checked and
// disabled here, but the real enforcement is server-side (the route force-includes them
// regardless of what's sent) — this UI is just making that constraint visible up front rather
// than silently overriding a user's uncheck.
//
// "ETD / ATD" and "ETA / ATA" are one row each, not four — this app has no independently-
// populated ATD/ATA distinct from ETD/ETA; a shipment's etd/eta gets overwritten in place once
// AIS-confirmed, so that same field already *is* the ATD/ATA once known.
export const EXPORT_FIELD_GROUPS = [
  {
    group: "Identity & Status",
    fields: [
      { key: "id",     label: "Shipment ID", mandatory: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    group: "Route",
    fields: [
      { key: "pol",             label: "POL", mandatory: true },
      { key: "polName",         label: "POL Name" },
      { key: "pod",             label: "POD", mandatory: true },
      { key: "podName",         label: "POD Name" },
      { key: "doorPickup",      label: "Door Pickup" },
      { key: "doorDelivery",    label: "Door Delivery" },
      { key: "tradeLane",       label: "Trade Lane" },
      { key: "routingTerm",     label: "Routing Term" },
      { key: "placeOfReceipt",  label: "Place of Receipt" },
      { key: "placeOfDelivery", label: "Place of Delivery" },
    ],
  },
  {
    group: "Dates",
    fields: [
      { key: "etd",             label: "ETD / ATD", mandatory: true },
      { key: "eta",             label: "ETA / ATA", mandatory: true },
      { key: "cargoReadyDate",  label: "Cargo Ready Date" },
      { key: "createdAt",       label: "Created At" },
    ],
  },
  {
    group: "Carrier & Vessel",
    fields: [
      { key: "carrierCode", label: "Carrier" },
      { key: "vessel",      label: "Vessel" },
      { key: "vesselImo",   label: "Vessel IMO" },
      { key: "voyage",      label: "Voyage" },
      { key: "bookingRef",  label: "Booking Ref" },
      { key: "blNumber",    label: "B/L Number" },
    ],
  },
  {
    group: "Contract & Commercial Terms",
    fields: [
      { key: "contractType",      label: "Contract Type" },
      { key: "contractRef",       label: "Contract Ref" },
      { key: "contractValidFrom", label: "Contract Valid From" },
      { key: "contractValidTo",   label: "Contract Valid To" },
      { key: "incoterm",          label: "Incoterm" },
      { key: "freightTerms",      label: "Freight Terms" },
      { key: "movementType",      label: "Movement Type" },
      { key: "serviceType",       label: "Service Type" },
    ],
  },
  {
    group: "Cargo",
    fields: [
      { key: "commodityCode",  label: "Commodity" },
      { key: "containerCount", label: "Containers" },
      { key: "totalTeu",       label: "TEU" },
    ],
  },
  {
    group: "Parties",
    fields: [
      { key: "shipperName",   label: "Shipper" },
      { key: "consigneeName", label: "Consignee" },
      { key: "principalName", label: "Principal" },
      { key: "notifyName",    label: "Notify Party" },
    ],
  },
  {
    group: "Offices",
    fields: [
      { key: "emoOfficeName",         label: "EMO Office" },
      { key: "imoOfficeName",         label: "IMO Office" },
      { key: "controllingOfficeName", label: "Controlling Office" },
    ],
  },
  {
    group: "Financial",
    fields: [
      { key: "declaredValue",         label: "Declared Value" },
      { key: "declaredValueCurrency", label: "Declared Value Currency" },
      { key: "marginBuyUsd",          label: "Buy (USD)" },
      { key: "marginSellUsd",         label: "Sell (USD)" },
      { key: "grossProfit",           label: "Gross Profit (USD)" },
      { key: "marginPct",             label: "Margin %" },
    ],
  },
];

export const MANDATORY_EXPORT_FIELDS = EXPORT_FIELD_GROUPS
  .flatMap(g => g.fields)
  .filter(f => f.mandatory)
  .map(f => f.key);

export const ALL_EXPORT_FIELDS = EXPORT_FIELD_GROUPS.flatMap(g => g.fields).map(f => f.key);

const ExportFieldsModal = ({ initialSelected, onExport, onClose }) => {
  const [selected, setSelected] = useState(() => new Set(initialSelected?.length ? initialSelected : ALL_EXPORT_FIELDS));

  const toggle = (key, mandatory) => {
    if (mandatory) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const selectAll  = () => setSelected(new Set(ALL_EXPORT_FIELDS));
  const selectNone = () => setSelected(new Set(MANDATORY_EXPORT_FIELDS));

  const count = selected.size;

  return (
    <Modal title="Export Shipments — Select Fields" onClose={onClose} width={640}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, margin: 0, lineHeight: 1.5, maxWidth: 420 }}>
            Shipment ID, POL, POD, ETD/ATD, and ETA/ATA are always included.
          </p>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button type="button" onClick={selectAll}
              style={{ background: "none", border: "none", cursor: "pointer",
                fontFamily: T.body, fontSize: 12, color: T.accent, padding: "2px 4px" }}>
              Select all
            </button>
            <span style={{ color: T.border, fontSize: 12 }}>·</span>
            <button type="button" onClick={selectNone}
              style={{ background: "none", border: "none", cursor: "pointer",
                fontFamily: T.body, fontSize: 12, color: T.accent, padding: "2px 4px" }}>
              Select none
            </button>
          </div>
        </div>

        <div style={{ maxHeight: 460, overflowY: "auto", paddingRight: 6 }}>
          {EXPORT_FIELD_GROUPS.map(({ group, fields }) => (
            <div key={group} style={{ marginBottom: 16 }}>
              <div style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, color: T.textMuted,
                textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>
                {group}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px" }}>
                {fields.map(f => (
                  <label key={f.key} title={f.mandatory ? "Always included" : undefined}
                    style={{ display: "flex", alignItems: "center", gap: 8,
                      cursor: f.mandatory ? "default" : "pointer",
                      fontFamily: T.body, fontSize: 13, color: f.mandatory ? T.textMuted : T.text }}>
                    <input type="checkbox"
                      checked={f.mandatory || selected.has(f.key)}
                      disabled={f.mandatory}
                      onChange={() => toggle(f.key, f.mandatory)} />
                    {f.label}
                    {f.mandatory && (
                      <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: T.textMuted,
                        background: T.bg, border: `1px solid ${T.border}`, borderRadius: 3,
                        padding: "1px 4px", lineHeight: 1.4 }}>
                        REQUIRED
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            {count} field{count !== 1 ? "s" : ""} selected
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
            <Btn onClick={() => onExport([...selected])}>Export CSV</Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default ExportFieldsModal;
