import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import { fmtCurr } from "../../utils/invoiceGenerator";
import Btn from "../../components/primitives/Btn";
import Spinner from "../../components/primitives/Spinner";
import EdiMessageList from "../../components/shared/EdiMessageList";
import { IconFileCertificate, IconWarning } from "../../components/primitives/Icon";
import { servicePageKey } from "../../shipmentServicePages";

// ─── Customs Filing — Details ───────────────────────────────────────────────────
// Two side-by-side cards (Export AES/EEI | Import ISF/AMS), not a type-switcher —
// a shipment can independently need 0, 1, or both. Each card sources its broker
// from shipmentParties and its cargo rollup from container_packages (both fetched
// once by the wrapper page and passed down), and owns Create/Submit for its own
// filing type. Submit lives here (not on Review) since unlike carrier booking
// there's no equipment/contract composition step to review first — just "submit
// this Draft."

// pickupRelevant: only AES/EEI (export) has any real relationship to the Pickup service
// (Export-side only, SERVICE_TYPE_SIDES.Pickup) — ISF/AMS is the import-side filing, which
// has no Pickup counterpart to cross-reference (TKT-6A7J45, stories 2/8/9).
const FILING_TYPES = [
  { type: "AES_EEI", label: "AES/EEI (Export)", brokerRole: "Customs Broker (Export)", pickupRelevant: true },
  { type: "ISF_AMS", label: "ISF/AMS (Import)", brokerRole: "Customs Broker (Import)", pickupRelevant: false },
];

const STATUS_COLOR = { Draft: "", Filed: "accent", Accepted: "success", Rejected: "danger" };

// Pre-departure filing deadline (TKT-6A7J45, story 10) — real AES/ISF rules carry hard
// deadlines relative to vessel loading, not to whenever someone happens to click Submit.
// The exact regulatory offset varies by mode/filer type (24h is the common ocean AMS/ISF
// figure, used here as a reasonable placeholder rather than a precise legal citation).
const FILING_DEADLINE_HOURS = 24;
const deadlineInfo = etd => {
  if (!etd) return null;
  const hoursLeft = (new Date(etd).getTime() - Date.now()) / 3_600_000 - FILING_DEADLINE_HOURS;
  if (hoursLeft < 0) return { overdue: true, text: "Filing deadline has passed" };
  if (hoursLeft < 48) return { overdue: false, text: `~${Math.round(hoursLeft)}h until filing deadline`, urgent: true };
  return { overdue: false, text: `${Math.round(hoursLeft / 24)}d until filing deadline` };
};

const ShipmentCustomsFilingDetailsPage = ({ shipment, parties, packages, hasExportBroker, hasImportBroker, navigate }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [filings,  setFilings]  = useState(null); // null = loading
  const [messages, setMessages] = useState([]);
  const [services, setServices] = useState([]);
  const [busy,     setBusy]     = useState(null); // filing type currently busy

  const load = () => Promise.all([
    api.customsFilings.list(shipment.id),
    api.ediMessages.list(shipment.id),
    api.services.list(shipment.id).catch(() => []),
  ]).then(([f, m, sv]) => { setFilings(f); setMessages(m); setServices(sv); }).catch(() => { setFilings([]); setMessages([]); setServices([]); });

  useEffect(() => { load(); }, [shipment.id]);

  // TKT-6A7J45 stories 2/8/9 — the shipment's own Export-side Pickup service, if any.
  const pickup = services.find(s => s.side === "Export" && s.serviceType === "Pickup" && s.status !== "Cancelled") || null;
  const deadline = deadlineInfo(shipment.etd);

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
      {FILING_TYPES.map(({ type, label, brokerRole, pickupRelevant }) => {
        const filing = filings.find(f => f.filingType === type) || null;
        const broker = parties.find(p => p.role === brokerRole) || null;
        const hasThisBroker = type === "AES_EEI" ? hasExportBroker : hasImportBroker;
        const thread = filing ? messages.filter(m => m.correlationId === filing.id && m.direction === "out") : [];
        const statusColorKey = filing ? STATUS_COLOR[filing.status] : "";
        // Pickup hasn't been ordered yet, or is still just Requested (not Confirmed/Completed) —
        // real pre-departure filing timing is tied to actual cargo movement, so this is worth
        // flagging before Submit, though never a hard block (TKT-6A7J45, story 2).
        const pickupNotReady = pickupRelevant && (!pickup || pickup.status === "Requested");

        return (
          <div key={type} id={`shpfiling-${type}-card`}
            style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <h3 style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, margin: 0,
                display: "flex", alignItems: "center", gap: 6 }}>
                <IconFileCertificate size={14} /> {label}
              </h3>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {filing?.isStale && (
                  <span title={`Shipment data has changed since this filing was submitted (${filing.staleFields.join(", ")})`}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: T.mono, fontSize: 9.5,
                      fontWeight: 700, color: T.warning, background: `${T.warning}18`, border: `1px solid ${T.warning}44`,
                      borderRadius: 4, padding: "2px 6px", textTransform: "uppercase" }}>
                    <IconWarning size={10} /> May be stale
                  </span>
                )}
                {filing && (
                  <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                    color: statusColorKey ? T[statusColorKey] : T.textMuted, textTransform: "uppercase" }}>
                    {filing.status}
                  </span>
                )}
              </div>
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
              {/* Pickup cross-reference (TKT-6A7J45, stories 8/9) — AES/EEI (export) only, since
                  Pickup is an Export-side-only service with nothing to cross-reference on the
                  ISF/AMS (import) card. */}
              {pickupRelevant && (
                <div>
                  <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Pickup</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: T.body, fontSize: 13, color: pickup ? T.text : T.border }}>
                      {pickup
                        ? `${pickup.status}${pickup.confirmedDate ? ` for ${new Date(pickup.confirmedDate).toLocaleDateString()}` : ""}`
                        : "Not yet ordered"}
                    </span>
                    {pickup && navigate && (
                      <button onClick={() => navigate(servicePageKey("Export", "Pickup"), shipment.id)}
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                          fontFamily: T.body, fontSize: 12, color: T.accent, textDecoration: "underline" }}>
                        View Pickup Service →
                      </button>
                    )}
                  </div>
                </div>
              )}
              {deadline && (
                <div style={{ fontFamily: T.body, fontSize: 11.5,
                  color: deadline.overdue ? T.danger : deadline.urgent ? T.warning : T.textMuted }}>
                  {deadline.overdue ? "⚠ " : ""}{deadline.text}
                </div>
              )}
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
                {filing.status === "Draft" && pickupNotReady && (
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px",
                    marginBottom: 10, borderRadius: 6, background: `${T.warning}14`, border: `1px solid ${T.warning}33` }}>
                    <span style={{ color: T.warning, flexShrink: 0, marginTop: 1 }}><IconWarning size={12} /></span>
                    <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.text, lineHeight: 1.5 }}>
                      {pickup ? "Pickup is still Requested, not Confirmed yet." : "No Pickup service has been ordered yet."} Real
                      filing timing is tied to when cargo actually moves — you can still submit, but double-check the export
                      date first.
                    </span>
                  </div>
                )}
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
