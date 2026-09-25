import { useState } from "react";
import { INCOTERMS_2020, BL_RELEASE_TYPES, contractVariant } from "../../tokens";
import { useAuth } from "../../AuthContext";
import useSaving from "../../hooks/useSaving";
import Btn from "../../components/primitives/Btn";
import { Inp, Sel, Field } from "../../components/primitives/Form";
import { Modal } from "../../components/primitives/Modal";
import { IconPencil } from "../../components/primitives/Icon";
import { CommodityCombobox } from "../../components/shared/CommodityCombobox";
import Badge from "../../components/primitives/Badge";
import { CommodityDisplay } from "./ShipmentDetailPage";
import { HZ, HZ_MONO, HZ_BODY, useHorizonFonts } from "./shipmentDetailTheme";

// ─── Shipment Conditions Page ──────────────────────────────────────────────
// Promoted out of the Overview page's "Contract & References" card + its
// "Show all details" modal — same content, now a dedicated page instead of a
// card-behind-a-modal, matching every other promoted sub-page this session.
//
// Edit form (direct request, 2026-09-25): every field below the fold — Incoterm, Commodity,
// Declared Value, Place of Receipt/Delivery, B/L Number, B/L Release Type — reuses the exact
// same widget the New Shipment form (ShipmentFormPage.jsx) uses for it, wired to the same
// generic PUT /api/shipments/:id the Parties edit modal already calls (routes/shipments.js
// already accepts every one of these fields as a true partial update — no backend change
// needed). Master B/L fields are deliberately left out — not part of the request, and they're
// governed by the House B/L lifecycle's own Surrender/Release actions, not a plain field edit.

const DECLARED_VALUE_CURRENCIES = ["USD","EUR","GBP","CNY","JPY","AUD","CAD","CHF","SGD","HKD"];

const ConditionsEditForm = ({ shipment, onSave, onCancel }) => {
  const [f, setF] = useState({
    incoterm:              shipment.incoterm              || "",
    commodityCode:         shipment.commodityCode         || "",
    declaredValue:         shipment.declaredValue != null ? String(shipment.declaredValue) : "",
    declaredValueCurrency: shipment.declaredValueCurrency || "USD",
    placeOfReceipt:        shipment.placeOfReceipt        || "",
    placeOfDelivery:       shipment.placeOfDelivery       || "",
    blNumber:              shipment.blNumber              || "",
    blReleaseType:         shipment.blReleaseType         || "",
  });
  const [isSaving, withSaving] = useSaving();

  const setDeclaredValue = v => {
    // Same strip-the-minus-outright sanitization as the New Shipment form's own Declared Value
    // field, for the identical reason: rejecting a negative outright leaves a stray "-"/"00"
    // artifact behind while typing "-500" character by character.
    const cleaned = v.replace(/-/g, "");
    if (cleaned !== "" && Number(cleaned) < 0) return;
    setF(p => ({ ...p, declaredValue: cleaned }));
  };

  // Full-record PUT (same as PartiesEditForm) — every other field rides along unchanged.
  const handleSave = () => withSaving(() => onSave({
    ...shipment, ...f,
    declaredValue: (f.declaredValue !== "" && Number(f.declaredValue) >= 0) ? Number(f.declaredValue) : null,
  }));

  return (
    <div data-testid="shipment-conditions-edit-form" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div data-testid="shipment-conditions-form-incoterm-field">
          <Sel label="Incoterm" value={f.incoterm} onChange={v => setF(p => ({ ...p, incoterm: v }))}
            options={[{ value: "", label: "—" }, ...INCOTERMS_2020.map(t => ({ value: t.code, label: `${t.code} – ${t.name}` }))]} />
        </div>
        <div data-testid="shipment-conditions-form-commodity-field">
          <Field label="Commodity">
            <CommodityCombobox value={f.commodityCode} onChange={v => setF(p => ({ ...p, commodityCode: v }))} />
          </Field>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Place of Receipt" value={f.placeOfReceipt} onChange={v => setF(p => ({ ...p, placeOfReceipt: v }))}
          placeholder="e.g. Shipper's warehouse, Chicago IL" />
        <Inp label="Place of Delivery" value={f.placeOfDelivery} onChange={v => setF(p => ({ ...p, placeOfDelivery: v }))}
          placeholder="e.g. Consignee's dock, Antwerp" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Declared Value" value={f.declaredValue} onChange={setDeclaredValue}
          placeholder="0.00" type="number" min="0" step="0.01" hint="Customs / insured value of the goods" />
        <Sel label="Currency" value={f.declaredValueCurrency} onChange={v => setF(p => ({ ...p, declaredValueCurrency: v }))}
          options={DECLARED_VALUE_CURRENCIES.map(c => ({ value: c, label: c }))} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="B/L Number" value={f.blNumber} onChange={v => setF(p => ({ ...p, blNumber: v }))}
          placeholder="MAEU123456789" mono />
        <Sel label="B/L Release Type" value={f.blReleaseType} onChange={v => setF(p => ({ ...p, blReleaseType: v }))}
          options={[{ value: "", label: "—" }, ...BL_RELEASE_TYPES.map(t => ({ value: t, label: t }))]} />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel} disabled={isSaving}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={isSaving}>{isSaving ? "Saving…" : "Save"}</Btn>
      </div>
    </div>
  );
};

const Row = ({ id, label, node }) => (
  <div id={id} data-testid={id ? `shipment-conditions-${id.replace(/^shpcond-/, "")}` : undefined}
    style={{ display: "flex", alignItems: "center", gap: 16, padding: "13px 20px",
    borderBottom: `1px solid ${HZ.border}` }}>
    <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: ".06em", width: 130, flexShrink: 0 }}>
      {label}
    </span>
    {node}
  </div>
);

const ShipmentConditionsPage = ({ shipment, onUpdate }) => {
  useHorizonFonts();
  const { canEditShipments: canEdit } = useAuth();
  const [editing, setEditing] = useState(false);
  return (
  <div id="shpcond-page" data-testid="shipment-conditions-page" style={{ maxWidth: 640 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
      <div style={{ fontFamily: HZ_BODY, fontSize: 10.5, color: HZ.textMuted, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".08em" }}>
        Conditions
      </div>
      {canEdit && onUpdate && (
        <Btn id="shpcond-edit-btn" data-testid="shipment-conditions-edit-btn" size="sm" variant="secondary" onClick={() => setEditing(true)}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><IconPencil size={12} />Edit</span>
        </Btn>
      )}
    </div>
    <div style={{ background: HZ.surface, backdropFilter: "blur(20px)", border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10, overflow: "hidden" }}>
      <Row id="shpcond-contract-type" label="Contract Type" node={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Badge variant={contractVariant(shipment.contractType)}>{shipment.contractType}</Badge>
          {shipment.contractRef && <span style={{ fontFamily: HZ_MONO, fontSize: 12, color: HZ.textMuted }}>{shipment.contractRef}</span>}
        </div>
      } />
      <Row id="shpcond-contract-id" label="Contract ID" node={
        <span style={{ fontFamily: HZ_MONO, fontSize: 13, color: shipment.contractId ? HZ.text : HZ.textFaint }}>
          {shipment.contractId || "—"}
        </span>
      } />
      <Row id="shpcond-incoterm" label="Incoterm" node={
        shipment.incoterm
          ? <span style={{ fontFamily: HZ_MONO, fontSize: 13, color: HZ.text, fontWeight: 700 }}>
              {shipment.incoterm}
              <span style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted, fontWeight: 400, marginLeft: 8 }}>
                {INCOTERMS_2020.find(t => t.code === shipment.incoterm)?.name || ""}
              </span>
            </span>
          : <span style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.textFaint }}>—</span>
      } />
      <Row id="shpcond-booking-ref" label="Booking Ref" node={
        <span style={{ fontFamily: HZ_MONO, fontSize: 13, color: shipment.bookingRef ? HZ.text : HZ.textFaint }}>
          {shipment.bookingRef || "—"}
        </span>
      } />
      <Row id="shpcond-place-of-receipt" label="Place of Receipt" node={
        <span style={{ fontFamily: HZ_BODY, fontSize: 13, color: shipment.placeOfReceipt ? HZ.text : HZ.textFaint }}>
          {shipment.placeOfReceipt || "—"}
        </span>
      } />
      <Row id="shpcond-place-of-delivery" label="Place of Delivery" node={
        <span style={{ fontFamily: HZ_BODY, fontSize: 13, color: shipment.placeOfDelivery ? HZ.text : HZ.textFaint }}>
          {shipment.placeOfDelivery || "—"}
        </span>
      } />
      <Row id="shpcond-bl-number" label="B/L Number" node={
        <span style={{ fontFamily: HZ_MONO, fontSize: 13, color: shipment.blNumber ? HZ.text : HZ.textFaint }}>
          {shipment.blNumber || "—"}
        </span>
      } />
      <Row id="shpcond-bl-release-type" label="B/L Release Type" node={
        <span style={{ fontFamily: HZ_MONO, fontSize: 13, color: shipment.blReleaseType ? HZ.text : HZ.textFaint }}>
          {shipment.blReleaseType || "—"}
        </span>
      } />
      <Row id="shpcond-master-bl-number" label="Master B/L Number" node={
        <span style={{ fontFamily: HZ_MONO, fontSize: 13, color: shipment.masterBlNumber ? HZ.text : HZ.textFaint }}>
          {shipment.masterBlNumber || "—"}
        </span>
      } />
      <Row id="shpcond-master-bl-release-type" label="Master B/L Release Type" node={
        <span style={{ fontFamily: HZ_MONO, fontSize: 13, color: shipment.masterBlReleaseType ? HZ.text : HZ.textFaint }}>
          {shipment.masterBlReleaseType || "—"}
        </span>
      } />

      {shipment.coloadTariffReference && (
        <div id="shpcond-coload-tariff" data-testid="shipment-conditions-coload-tariff" style={{ padding: "16px 20px", borderTop: `1px solid ${HZ.border}` }}>
          <div style={{ fontFamily: HZ_BODY, fontSize: 10, color: HZ.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Co-Load Tariff Reference</div>
          <span style={{ fontFamily: HZ_MONO, fontSize: 13, color: HZ.text }}>{shipment.coloadTariffReference}</span>
          <div style={{ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted, marginTop: 4 }}>
            Cargo moves under the assigned Co-Loading NVOCC's own tariff with the vessel operator
          </div>
        </div>
      )}

      {shipment.commodityCode && (
        <div id="shpcond-commodity" data-testid="shipment-conditions-commodity" style={{ padding: "16px 20px", borderTop: `1px solid ${HZ.border}` }}>
          <div style={{ fontFamily: HZ_BODY, fontSize: 10, color: HZ.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Commodity</div>
          <CommodityDisplay code={shipment.commodityCode} />
        </div>
      )}

      {shipment.declaredValue != null && (
        <div id="shpcond-declared-value" data-testid="shipment-conditions-declared-value" style={{ padding: "16px 20px", borderTop: `1px solid ${HZ.border}` }}>
          <div style={{ fontFamily: HZ_BODY, fontSize: 10, color: HZ.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Declared Value</div>
          <span style={{ fontFamily: HZ_MONO, fontSize: 15, fontWeight: 700, color: HZ.text }}>
            {(shipment.declaredValueCurrency || "USD")}{" "}
            {Number(shipment.declaredValue).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      )}

      {shipment.contractNotes && (
        <div id="shpcond-notes" data-testid="shipment-conditions-notes" style={{ padding: "16px 20px", borderTop: `1px solid ${HZ.border}` }}>
          <div style={{ fontFamily: HZ_BODY, fontSize: 10, color: HZ.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>Notes</div>
          <p style={{ fontFamily: HZ_BODY, fontSize: 14, color: HZ.text, lineHeight: 1.6, margin: 0 }}>
            {shipment.contractNotes}
          </p>
        </div>
      )}
    </div>

    {editing && (
      <Modal title="Edit Conditions" onClose={() => setEditing(false)} width={560} data-testid="shipment-conditions-edit-modal">
        <ConditionsEditForm
          shipment={shipment}
          onCancel={() => setEditing(false)}
          onSave={async form => {
            try {
              await onUpdate(shipment.id, form);
              setEditing(false);
            } catch { /* error already toasted by caller */ }
          }} />
      </Modal>
    )}
  </div>
  );
};

export default ShipmentConditionsPage;
