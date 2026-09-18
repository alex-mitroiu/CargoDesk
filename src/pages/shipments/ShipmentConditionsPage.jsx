import { INCOTERMS_2020, contractVariant } from "../../tokens";
import Badge from "../../components/primitives/Badge";
import { CommodityDisplay } from "./ShipmentDetailPage";
import { HZ, HZ_MONO, HZ_BODY, useHorizonFonts } from "./shipmentDetailTheme";

// ─── Shipment Conditions Page ──────────────────────────────────────────────
// Promoted out of the Overview page's "Contract & References" card + its
// "Show all details" modal — same content, now a dedicated page instead of a
// card-behind-a-modal, matching every other promoted sub-page this session.

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

const ShipmentConditionsPage = ({ shipment }) => {
  useHorizonFonts();
  return (
  <div id="shpcond-page" data-testid="shipment-conditions-page" style={{ maxWidth: 640 }}>
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
  </div>
  );
};

export default ShipmentConditionsPage;
