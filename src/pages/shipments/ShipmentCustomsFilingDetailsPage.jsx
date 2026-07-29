import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import { fmtCurr } from "../../utils/invoiceGenerator";
import Btn from "../../components/primitives/Btn";
import Spinner from "../../components/primitives/Spinner";
import EdiMessageList from "../../components/shared/EdiMessageList";
import { IconFileCertificate } from "../../components/primitives/Icon";

// ─── Customs Filing — Details ───────────────────────────────────────────────────
// Two side-by-side cards (Export AES/EEI | Import ISF/AMS), not a type-switcher —
// a shipment can independently need 0, 1, or both. Each card sources its broker
// from shipmentParties and its cargo rollup from container_packages (both fetched
// once by the wrapper page and passed down), and owns Create/Submit for its own
// filing type. Submit lives here (not on Review) since unlike carrier booking
// there's no equipment/contract composition step to review first — just "submit
// this Draft."

const FILING_TYPES = [
  { type: "AES_EEI", label: "AES/EEI (Export)", brokerRole: "Customs Broker (Export)" },
  { type: "ISF_AMS", label: "ISF/AMS (Import)", brokerRole: "Customs Broker (Import)" },
];

const STATUS_COLOR = { Draft: "", Filed: "accent", Accepted: "success", Rejected: "danger" };

const ShipmentCustomsFilingDetailsPage = ({ shipment, parties, packages, hasExportBroker, hasImportBroker }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [filings,  setFilings]  = useState(null); // null = loading
  const [messages, setMessages] = useState([]);
  const [busy,     setBusy]     = useState(null); // filing type currently busy

  const load = () => Promise.all([
    api.customsFilings.list(shipment.id),
    api.ediMessages.list(shipment.id),
  ]).then(([f, m]) => { setFilings(f); setMessages(m); }).catch(() => { setFilings([]); setMessages([]); });

  useEffect(() => { load(); }, [shipment.id]);

  const priced = packages.filter(p => p.unitValueUsd != null);
  const cargoTotalUsd = priced.reduce((s, p) => s + p.unitValueUsd * p.quantity, 0);

  const handleCreate = async filingType => {
    setBusy(filingType);
    try {
      await api.customsFilings.create(shipment.id, { filingType });
      toast.success("Filing created");
      await load();
    } catch (e) { toast.error(e.message); }
    setBusy(null);
  };

  const handleSubmit = async filing => {
    setBusy(filing.filingType);
    try {
      await api.customsFilings.submit(shipment.id, filing.id);
      toast.success("Filing submitted");
      await load();
    } catch (e) { toast.error(e.message); }
    setBusy(null);
  };

  if (filings === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.textMuted,
        fontFamily: T.body, fontSize: 13, padding: "30px 0", justifyContent: "center" }}>
        <Spinner size="sm" /> Loading customs filings…
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      {FILING_TYPES.map(({ type, label, brokerRole }) => {
        const filing = filings.find(f => f.filingType === type) || null;
        const broker = parties.find(p => p.role === brokerRole) || null;
        const hasThisBroker = type === "AES_EEI" ? hasExportBroker : hasImportBroker;
        const thread = filing ? messages.filter(m => m.correlationId === filing.id && m.direction === "out") : [];
        const statusColorKey = filing ? STATUS_COLOR[filing.status] : "";

        return (
          <div key={type} id={`shpfiling-${type}-card`}
            style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <h3 style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, margin: 0,
                display: "flex", alignItems: "center", gap: 6 }}>
                <IconFileCertificate size={14} /> {label}
              </h3>
              {filing && (
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  color: statusColorKey ? T[statusColorKey] : T.textMuted, textTransform: "uppercase" }}>
                  {filing.status}
                </span>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
              <div>
                <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Broker</div>
                <div style={{ fontFamily: T.body, fontSize: 13, color: broker ? T.text : T.border }}>
                  {broker?.customerName || "Not yet assigned"}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Cargo</div>
                <div style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>
                  {priced.length} priced line{priced.length !== 1 ? "s" : ""} · {fmtCurr(cargoTotalUsd, "USD")}
                </div>
              </div>
            </div>

            {!filing ? (
              canEdit && (
                <div>
                  <Btn id={`shpfiling-${type}-create-btn`} size="sm" disabled={!hasThisBroker || busy === type}
                    onClick={() => handleCreate(type)}>
                    {busy === type ? "Creating…" : "Create Filing"}
                  </Btn>
                  {!hasThisBroker && (
                    <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 6, fontStyle: "italic" }}>
                      Assign a {label.includes("Export") ? "Customs Broker (Export)" : "Customs Broker (Import)"} to enable this.
                    </div>
                  )}
                </div>
              )
            ) : (
              <>
                {filing.status === "Draft" && canEdit && (
                  <Btn id={`shpfiling-${type}-submit-btn`} size="sm" disabled={busy === type} onClick={() => handleSubmit(filing)}>
                    {busy === type ? "Submitting…" : "Submit"}
                  </Btn>
                )}
                {filing.status !== "Draft" && filing.filingReference && (
                  <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginBottom: 10 }}>
                    Ref: {filing.filingReference}
                  </div>
                )}
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>Sent</div>
                  <EdiMessageList messages={thread} emptyText="Not submitted yet." />
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default ShipmentCustomsFilingDetailsPage;
