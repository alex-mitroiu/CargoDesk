import { useState, useEffect } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import { canEditShipmentSide } from "../../utils/officeSide";
import Btn from "../../components/primitives/Btn";
import Spinner from "../../components/primitives/Spinner";
import { Modal } from "../../components/primitives/Modal";
import EdiMessageList from "../../components/shared/EdiMessageList";
import { IconFileCertificate, IconRefresh, IconClose } from "../../components/primitives/Icon";
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

const STATUS_COLOR = { Draft: "", Filed: "cyan", Accepted: "good", Rejected: "crit", Cancelled: "" };

const ShipmentCustomsFilingReviewPage = ({ shipment }) => {
  const auth = useAuth();
  const [filings,  setFilings]  = useState(null); // null = loading
  const [messages, setMessages] = useState([]);
  const [busy,     setBusy]     = useState(null);
  const [cancelling, setCancelling] = useState(null); // null | { filing, reason }

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

  // A submitted filing (Filed or Accepted) can be cancelled, with a reason — a shipment can only be
  // cancelled once its submitted filings are (2026-10-09).
  const handleCancel = async () => {
    const { filing, reason } = cancelling;
    setBusy(filing.filingType);
    try {
      await api.customsFilings.cancel(shipment.id, filing.id, reason.trim());
      toast.success("Filing cancelled");
      setCancelling(null);
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
        // Same independent per-type gating as the Details tab (Office-Side Permissions Epic).
        const canEdit = canEditShipmentSide(auth, shipment, type === "AES_EEI" ? "export" : "import");

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
                  {filing.status === "Cancelled" && (
                    <div data-testid={`shpfilingreview-${type}-cancelled`}>
                      <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginBottom: 3 }}>
                        Cancelled{filing.cancelledBy ? ` by ${filing.cancelledBy}` : ""}{filing.cancelledAt ? ` · ${filing.cancelledAt.slice(0, 10)}` : ""}
                      </div>
                      <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.text }}>{filing.cancelReason}</div>
                    </div>
                  )}
                </div>

                {(filing.status === "Filed" || filing.status === "Accepted") && canEdit && (
                  <Btn id={`shpfilingreview-${type}-cancel-btn`} size="sm" variant="secondary" disabled={busy === type}
                    onClick={() => setCancelling({ filing, reason: "" })} style={{ marginBottom: 14 }}>
                    <IconClose size={12} /> Cancel filing
                  </Btn>
                )}

                {(filing.status === "Rejected" || filing.status === "Cancelled") && canEdit && (
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

      {cancelling && (
        <Modal title={`Cancel ${cancelling.filing.filingType === "AES_EEI" ? "AES/EEI" : "ISF/AMS"} filing`} onClose={() => !busy && setCancelling(null)} width={440}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.text, margin: 0, lineHeight: 1.5 }}>
              This records filing {cancelling.filing.filingReference || ""} as cancelled{cancelling.filing.status === "Accepted" ? ", although the authority accepted it" : ", with no answer from the authority yet"}.
              It can be reset to Draft and submitted again later.
            </p>
            <div>
              <label htmlFor="shpfilingreview-cancel-reason" style={{ display: "block", fontFamily: HZ_BODY, fontSize: 11, fontWeight: 600,
                color: HZ.textMuted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>
                Reason
              </label>
              <input id="shpfilingreview-cancel-reason" value={cancelling.reason} autoFocus
                onChange={e => setCancelling(c => ({ ...c, reason: e.target.value }))}
                placeholder="e.g. Shipment cancelled by the shipper"
                style={{ background: HZ.bg, border: `1px solid ${HZ.border}`, color: HZ.text,
                  borderRadius: 6, padding: "8px 12px", width: "100%", boxSizing: "border-box",
                  fontFamily: HZ_BODY, fontSize: 13 }} />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setCancelling(null)} disabled={!!busy}>Back</Btn>
              <Btn id="shpfilingreview-cancel-confirm-btn" variant="danger" onClick={handleCancel} disabled={!!busy || !cancelling.reason.trim()}>
                {busy ? "Cancelling…" : <><IconClose size={13} /> Cancel filing</>}
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default ShipmentCustomsFilingReviewPage;
