import { useState, useEffect } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import Spinner from "../../components/primitives/Spinner";
import EdiMessageList from "../../components/shared/EdiMessageList";
import { IconFileCertificate, IconRefresh } from "../../components/primitives/Icon";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY, useHorizonFonts } from "./shipmentDetailTheme";

// ─── Customs Filing — Review ─────────────────────────────────────────────────────
// Same two-card layout as Details. Read/respond side: filing reference/confirmation
// number/rejection reason as relevant, a Reset to Draft action once Rejected, and the
// full bidirectional message thread. Accept/Reject only ever happen via the Test
// Tools Filing Simulator (mirrors Carrier Booking's own Confirm/Cancel-vs-simulate
// split — a real response is never something this page itself produces).
//
// Deliberately NO live WebSocket subscription (unlike ShipmentCarrierBookingReviewPage) —
// this epic is permanently simulated-only, so there's no external actor that can push a
// response independent of a user action; a human clicking Simulate in Test Tools naturally
// lands back here via normal navigation. Fetch-on-mount + manual refresh is sufficient.
//
// Trade Horizon "New Style" pass — styling only. STATUS_COLOR keeps the original's own
// store-the-key-not-the-value indirection (HZ[key], resolved at render time) — already the
// correct pattern for a live-mutated theme object (App.jsx's toggle calls applyHzTheme in
// place, no reload); a plain object storing resolved HZ.* values at module load would freeze
// whichever theme was active at import.

const FILING_TYPES = [
  { type: "AES_EEI", label: "AES/EEI (Export)" },
  { type: "ISF_AMS", label: "ISF/AMS (Import)" },
];

const STATUS_COLOR = { Draft: "", Filed: "cyan", Accepted: "good", Rejected: "crit" };

const ShipmentCustomsFilingReviewPage = ({ shipment }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [filings,  setFilings]  = useState(null); // null = loading
  const [messages, setMessages] = useState([]);
  const [busy,     setBusy]     = useState(null);

  const load = () => Promise.all([
    api.customsFilings.list(shipment.id),
    api.ediMessages.list(shipment.id),
  ]).then(([f, m]) => { setFilings(f); setMessages(m); }).catch(() => { setFilings([]); setMessages([]); });

  useEffect(() => { load(); }, [shipment.id]);

  const handleReset = async filing => {
    setBusy(filing.filingType);
    try {
      await api.customsFilings.reset(shipment.id, filing.id);
      toast.success("Filing reset to Draft");
      await load();
    } catch (e) { toast.error(e.message); }
    setBusy(null);
  };

  useHorizonFonts();

  if (filings === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: HZ.textMuted,
        fontFamily: HZ_BODY, fontSize: 13, padding: "30px 0", justifyContent: "center" }}>
        <Spinner size="sm" /> Loading customs filings…
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      {FILING_TYPES.map(({ type, label }) => {
        const filing = filings.find(f => f.filingType === type) || null;
        const thread = filing ? messages.filter(m => m.correlationId === filing.id) : [];
        const statusColorKey = filing ? STATUS_COLOR[filing.status] : "";

        return (
          <div key={type} id={`shpfilingreview-${type}-card`}
            style={{ background: HZ.surface, backdropFilter: "blur(20px)", border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <h3 style={{ fontFamily: HZ_DISPLAY, fontSize: 14, fontWeight: 700, color: HZ.text, margin: 0,
                display: "flex", alignItems: "center", gap: 6 }}>
                <IconFileCertificate size={14} /> {label}
              </h3>
              {filing && (
                <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700,
                  color: statusColorKey ? HZ[statusColorKey] : HZ.textMuted, textTransform: "uppercase" }}>
                  {filing.status}
                </span>
              )}
            </div>

            {!filing ? (
              <div style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted, fontStyle: "italic" }}>
                No filing created yet — start it on the Details tab.
              </div>
            ) : (
              <>
                <div style={{ background: HZ.bg, border: `1px solid ${HZ.border}`, borderRadius: 8,
                  padding: "12px 14px", marginBottom: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>Filing Reference</span>
                    <span style={{ fontFamily: HZ_MONO, fontSize: 11, color: HZ.text }}>{filing.filingReference || "—"}</span>
                  </div>
                  {filing.status === "Accepted" && (
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>Confirmation Number</span>
                      <span style={{ fontFamily: HZ_MONO, fontSize: 11, color: HZ.good }}>{filing.confirmationNumber}</span>
                    </div>
                  )}
                  {filing.status === "Rejected" && (
                    <div>
                      <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginBottom: 3 }}>Rejection Reason</div>
                      <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.crit }}>{filing.rejectionReason}</div>
                    </div>
                  )}
                </div>

                {filing.status === "Rejected" && canEdit && (
                  <Btn id={`shpfilingreview-${type}-reset-btn`} size="sm" variant="secondary" disabled={busy === type}
                    onClick={() => handleReset(filing)} style={{ marginBottom: 14 }}>
                    <IconRefresh size={12} /> {busy === type ? "Resetting…" : "Reset to Draft"}
                  </Btn>
                )}

                <div>
                  <div style={{ fontFamily: HZ_BODY, fontSize: 10.5, color: HZ.textMuted, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>Message Thread</div>
                  <EdiMessageList messages={thread} emptyText="No messages yet." />
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default ShipmentCustomsFilingReviewPage;
