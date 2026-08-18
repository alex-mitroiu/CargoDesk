import { T, INCOTERMS_2020, contractVariant } from "../../tokens";
import Badge from "../../components/primitives/Badge";
import { CommodityDisplay } from "./ShipmentDetailPage";

// ─── Shipment Conditions Page ──────────────────────────────────────────────
// Promoted out of the Overview page's "Contract & References" card + its
// "Show all details" modal — same content, now a dedicated page instead of a
// card-behind-a-modal, matching every other promoted sub-page this session.

const Row = ({ id, label, node }) => (
  <div id={id} style={{ display: "flex", alignItems: "center", gap: 16, padding: "13px 20px",
    borderBottom: `1px solid ${T.border}22` }}>
    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: ".06em", width: 130, flexShrink: 0 }}>
      {label}
    </span>
    {node}
  </div>
);

const ShipmentConditionsPage = ({ shipment }) => (
  <div id="shpcond-page" style={{ maxWidth: 640 }}>
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
      <Row id="shpcond-contract-type" label="Contract Type" node={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Badge variant={contractVariant(shipment.contractType)}>{shipment.contractType}</Badge>
          {shipment.contractRef && <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{shipment.contractRef}</span>}
        </div>
      } />
      <Row id="shpcond-contract-id" label="Contract ID" node={
        <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.contractId ? T.textCode : T.border }}>
          {shipment.contractId || "—"}
        </span>
      } />
      <Row id="shpcond-incoterm" label="Incoterm" node={
        shipment.incoterm
          ? <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textCode, fontWeight: 700 }}>
              {shipment.incoterm}
              <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontWeight: 400, marginLeft: 8 }}>
                {INCOTERMS_2020.find(t => t.code === shipment.incoterm)?.name || ""}
              </span>
            </span>
          : <span style={{ fontFamily: T.body, fontSize: 13, color: T.border }}>—</span>
      } />
      <Row id="shpcond-booking-ref" label="Booking Ref" node={
        <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.bookingRef ? T.textCode : T.border }}>
          {shipment.bookingRef || "—"}
        </span>
      } />
      <Row id="shpcond-bl-number" label="B/L Number" node={
        <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.blNumber ? T.textCode : T.border }}>
          {shipment.blNumber || "—"}
        </span>
      } />
      <Row id="shpcond-bl-release-type" label="B/L Release Type" node={
        <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.blReleaseType ? T.textCode : T.border }}>
          {shipment.blReleaseType || "—"}
        </span>
      } />
      <Row id="shpcond-master-bl-number" label="Master B/L Number" node={
        <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.masterBlNumber ? T.textCode : T.border }}>
          {shipment.masterBlNumber || "—"}
        </span>
      } />

      {shipment.commodityCode && (
        <div id="shpcond-commodity" style={{ padding: "16px 20px", borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Commodity</div>
          <CommodityDisplay code={shipment.commodityCode} />
        </div>
      )}

      {shipment.declaredValue != null && (
        <div id="shpcond-declared-value" style={{ padding: "16px 20px", borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Declared Value</div>
          <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>
            {(shipment.declaredValueCurrency || "USD")}{" "}
            {Number(shipment.declaredValue).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      )}

      {shipment.contractNotes && (
        <div id="shpcond-notes" style={{ padding: "16px 20px", borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>Notes</div>
          <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.6, margin: 0 }}>
            {shipment.contractNotes}
          </p>
        </div>
      )}
    </div>
  </div>
);

export default ShipmentConditionsPage;
