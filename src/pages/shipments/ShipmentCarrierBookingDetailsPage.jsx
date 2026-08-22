import { useState, useEffect, useCallback, useMemo } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import EdiMessageList from "../../components/shared/EdiMessageList";
import CarrierBookingsTable from "../../components/shared/CarrierBookingsTable";
import CreditHoldModal from "../../components/shared/CreditHoldModal";
import Spinner from "../../components/primitives/Spinner";
import { CommodityDisplay } from "./ShipmentDetailPage";
import { IconSendPlane, IconAnchor, IconWarning } from "../../components/primitives/Icon";
import { BOOKABLE_CARRIERS } from "../../utils/carrierBooking";
import { resolveCreditGate } from "../../utils/invoiceGenerator";

// ─── Carrier Booking — Details ────────────────────────────────────────────────
// The outbound half of a booking: what we're asking the carrier for, and the Send
// action itself. Sibling to Review (the carrier's response + Confirm/Cancel), split
// out of the old EdiMessagesDrawer per the same "one concept, one dedicated page"
// precedent Accounting already established for Invoice/Cost/GP.

const FREIGHT_TERMS_OPTIONS = ["Prepaid", "Collect", "Payable at Destination"];

const ShipmentCarrierBookingDetailsPage = ({ shipment, onBack, onRefresh }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [booking,    setBooking]    = useState(null);
  const [messages,   setMessages]   = useState([]);
  const [containers, setContainers] = useState([]);
  const [packDgContainerIds, setPackDgContainerIds] = useState(new Set());
  const [contract,   setContract]   = useState(null);
  const [namedAccountParent, setNamedAccountParent] = useState(null); // Organization Model Enhancement Epic 4
  const [parties,    setParties]    = useState(null); // Carrier Line Agents
  const [loading,    setLoading]    = useState(true);
  const [sending,    setSending]    = useState(false);
  const [savingFreightTerms, setSavingFreightTerms] = useState(false);
  const [creditHoldModal, setCreditHoldModal] = useState(null); // { holds } — Credit Control Depth / TKT-Q00WHF

  // Freight Terms already exists on the shipment (set on the Shipment Form) but wasn't
  // editable from the one place it's operationally most relevant — here, while actually
  // booking with the carrier. Same spread-full-shipment-and-override-one-field update shape
  // OfficeInlineSelect (ShipmentDetailPage.jsx) already uses, since PUT /api/shipments/:id
  // requires the complete payload, not a partial patch.
  const handleFreightTermsChange = async e => {
    const next = e.target.value;
    setSavingFreightTerms(true);
    try {
      await api.shipments.update(shipment.id, { ...shipment, freightTerms: next });
      onRefresh?.();
    } catch (err) {
      toast.error(err.message || "Failed to update freight terms");
    } finally {
      setSavingFreightTerms(false);
    }
  };

  // Only a Central contract has a real record to load (contractId set) — SPOT/Pending/
  // Customer Own carry just a free-text contractRef with nothing to fetch, so `contract`
  // stays null and the Client field below falls back to "No Customer" per its own rule.
  useEffect(() => {
    if (!shipment.contractId) { setContract(null); return; }
    let cancelled = false;
    api.contracts.get(shipment.contractId).then(c => !cancelled && setContract(c)).catch(() => !cancelled && setContract(null));
    return () => { cancelled = true; };
  }, [shipment.contractId]);

  // Organization Model Enhancement Epic 4 — if the contract's Named Account customer has a
  // parent (a branch/subsidiary booked under a regional entity of a larger group), surface that
  // context right on the Client field, since this is a single-shipment display, not a
  // cross-shipment report — there's nothing here to numerically "roll up", just useful context.
  useEffect(() => {
    if (!contract?.namedAccountId) { setNamedAccountParent(null); return; }
    let cancelled = false;
    api.customers.get(contract.namedAccountId)
      .then(c => !cancelled && setNamedAccountParent(c.parentCustomerName || null))
      .catch(() => !cancelled && setNamedAccountParent(null));
    return () => { cancelled = true; };
  }, [contract?.namedAccountId]);

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([
      api.carrierBooking.get(shipment.id).catch(() => null),
      api.ediMessages.list(shipment.id).catch(() => []),
      api.containers.list({ shipmentId: shipment.id }).catch(() => []),
      api.shipmentParties.list(shipment.id).catch(() => []),
    ]).then(([b, m, c, p]) => {
      setBooking(b); setMessages(m); setContainers(c); setParties(p);
      // Pack-level DG flags (a pallet/carton can be flagged DG even when its container isn't)
      // also feed the outbound booking-request declaration (routes/edi.js) — fetched here too
      // so this awareness chip matches what's actually transmitted on Send.
      Promise.all(c.map(ctr => api.containerPackages.list(ctr.id).catch(() => [])))
        .then(lists => setPackDgContainerIds(new Set(
          c.filter((ctr, i) => lists[i].some(pk => pk.isDg)).map(ctr => ctr.id)
        )));
    }).finally(() => setLoading(false));
  }, [shipment.id]);

  // Carrier Line Agents — read-only here, same as Carrier/Route/Vessel above: this page
  // displays, it doesn't edit. Reassignment happens on Parties & Offices (AdditionalPartiesPanel)
  // like any other additional party — these are ordinary shipment_parties rows, not a separate
  // concept, so whatever's actually assigned (auto-resolved or manually overridden) is what shows.
  const exportAgent = (parties || []).find(p => p.role === "Line Agent (Export)");
  const importAgent = (parties || []).find(p => p.role === "Line Agent (Import)");

  // Same size+type grouping the backend applies to the outbound booking-request payload
  // (routes/edi.js, TKT-0H9TSP) — shown here so what's on screen matches what gets sent.
  const equipment = useMemo(() => {
    const byType = {};
    for (const c of containers) {
      const key = `${c.size}${c.type}`;
      const entry = byType[key] || (byType[key] = { type: key, count: 0, totalWeightKg: 0, totalVolumeCbm: 0 });
      entry.count += 1;
      entry.totalWeightKg += c.grossWeightKg || 0;
      entry.totalVolumeCbm += c.volumeCbm || 0;
    }
    return Object.values(byType);
  }, [containers]);

  // Container-level isDg, plus any container whose own pack items (any depth) carry a DG
  // flag — matches the outbound booking-request declaration (routes/edi.js), which reaches
  // into container_packages too so a DG-flagged pallet inside an otherwise-clean container
  // isn't silently omitted from what's declared to the carrier.
  const dgContainerCount = useMemo(
    () => containers.filter(c => c.isDg || packDgContainerIds.has(c.id)).length,
    [containers, packDgContainerIds]
  );

  // Same type+temperature grouping the backend applies to the outbound reefer declaration
  // (routes/edi.js) — a carrier can't hold an RF booking without knowing the set point, and
  // different reefer boxes on the same shipment can carry different cargo/temperatures.
  const reeferGroups = useMemo(() => {
    const byKey = {};
    for (const c of containers) {
      if (c.type !== "RF" || c.setTemperatureC == null) continue;
      const key = `${c.size}${c.type}_${c.setTemperatureC}`;
      const entry = byKey[key] || (byKey[key] = { type: `${c.size}${c.type}`, setTemperatureC: c.setTemperatureC, count: 0 });
      entry.count += 1;
    }
    return Object.values(byKey);
  }, [containers]);

  useEffect(() => { load(); }, [load]);

  const bookable = BOOKABLE_CARRIERS.has(shipment.carrierCode);
  const status = booking?.status || "Created";
  const canSend = canEdit && bookable && status !== "Pending" && status !== "Confirmed";
  const outboundMessages = messages.filter(m => m.direction === "out");

  const handleSend = async () => {
    if (!canSend || sending) return;
    // Earlier credit-check trigger point (TKT-Q00WHF, Credit Control Depth) — a real,
    // blocking gate at the actual commitment moment (sending a real request to a carrier),
    // not just at invoice-generation time. Reuses the exact resolveCreditGate/CreditHoldModal
    // already proven for invoicing rather than a parallel check — only gate.blocked (credit_hold)
    // is acted on here; gate.overLimit is ignored on purpose, since nothing's being invoiced yet
    // at booking-send time — the over-limit block stays scoped to actual invoice generation.
    const gate = await resolveCreditGate(shipment);
    if (gate.blocked) { setCreditHoldModal({ holds: gate.holds }); return; }
    setSending(true);
    try {
      const result = await api.ediMessages.sendBookingRequest(shipment.id);
      await load();
      if (result.pending) {
        toast.info("Booking request sent — awaiting carrier response. Use Integration Board → Test Tools to simulate one.");
      } else {
        toast.success(result.isMock ? "Booking request sent (demo response received)" : "Booking request sent");
      }
    } catch (e) {
      toast.error(e.message || "Failed to send booking request");
    } finally {
      setSending(false);
    }
  };

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.textMuted,
      fontFamily: T.body, fontSize: 13, padding: "60px 0", justifyContent: "center" }}>
      <Spinner size="sm" /> Loading booking details…
    </div>
  );

  return (
    <div id="shpbooking-details-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <CarrierBookingsTable shipment={shipment} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Status + BKG- id are no longer repeated here — both already appear on the
              current row in the "Bookings on this Shipment" table above (CarrierBookingsTable),
              which is now the single place that shows them. Heading font size matched to that
              table's own "Bookings on this Shipment" heading rather than standing out as a
              bigger, differently-weighted title above it. */}
          <h2 style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, margin: 0,
            display: "flex", alignItems: "center", gap: 8 }}>
            <IconAnchor size={14} />Carrier Booking — Details
          </h2>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 14, marginBottom: 24, background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: 10, padding: "16px 20px" }}>
        {[
          ["Carrier", shipment.carrierCode || "—"],
          ["Route", `${shipment.pol || "—"} → ${shipment.pod || "—"}`],
          ["ETD", shipment.etd || "—"],
          ["Vessel / Voyage", shipment.vessel ? `${shipment.vessel} / ${shipment.voyage || "—"}` : "—"],
          ["Booking Ref", booking?.bookingRef || "—"],
        ].map(([label, value]) => (
          <div key={label}>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{label}</div>
            <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>{value}</div>
          </div>
        ))}
        {/* Which party is financially responsible for the shipment at this point — Prepaid
            (shipper/exporter pays), Collect (consignee/importer pays), or Payable at
            Destination. Already existed on the Shipment Form; made editable here too since
            this is the page where it's operationally relevant when actually booking. */}
        <div id="shpbooking-freight-terms">
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Freight Terms</div>
          {canEdit ? (
            <select value={shipment.freightTerms || "Prepaid"} disabled={savingFreightTerms}
              onChange={handleFreightTermsChange}
              style={{ width: "100%", padding: "6px 8px", borderRadius: 6, fontFamily: T.body,
                fontSize: 13, fontWeight: 600, color: T.text, border: `1px solid ${T.border}`,
                background: T.bg, outline: "none", cursor: savingFreightTerms ? "wait" : "pointer" }}>
              {FREIGHT_TERMS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>
              {shipment.freightTerms || "Prepaid"}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 14, marginBottom: 24, background: T.surface,
        border: `1.5px solid ${T.accent}55`, borderRadius: 10, padding: "16px 20px" }}>
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, letterSpacing: ".06em",
            textTransform: "uppercase", color: T.accent, background: T.accentBg, borderRadius: 4,
            padding: "1px 6px", width: "fit-content", marginBottom: 6 }}>Line Agent · Export</div>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>
            {exportAgent?.customerName || "Not registered"}
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, marginTop: 2 }}>
            at {shipment.pol || "—"}
          </div>
        </div>
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, letterSpacing: ".06em",
            textTransform: "uppercase", color: T.purple, background: T.purpleBg, borderRadius: 4,
            padding: "1px 6px", width: "fit-content", marginBottom: 6 }}>Line Agent · Import</div>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>
            {importAgent?.customerName || "Not registered"}
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, marginTop: 2 }}>
            at {shipment.pod || "—"}
          </div>
        </div>
        <div style={{ gridColumn: "1 / -1", fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
          Resolved from Carrier Agents master data when Carrier/Route were set — reassign via
          Parties &amp; Offices if this shipment needs a one-off exception.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 14, marginBottom: 24, background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: 10, padding: "16px 20px" }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Contract Number</div>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>
            {contract?.contractNumber || "—"}
          </div>
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Reference</div>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>
            {shipment.contractRef || "—"}
          </div>
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Client</div>
          {/* Specifically the contract's own Named Account — not the shipment's Shipper/
              Consignee, which are separate parties. A SPOT/Pending/Customer Own contract (no
              linked contract record) or a Central contract with no named account both fall
              through to the same explicit "No Customer" text, per direct request. */}
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>
            {contract?.namedAccount || "No Customer"}
          </div>
          {namedAccountParent && (
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 2 }}>
              Part of {namedAccountParent}
            </div>
          )}
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Commodity</div>
          {shipment.commodityCode ? <CommodityDisplay code={shipment.commodityCode} /> : (
            <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>—</div>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>
          Equipment — sent with the booking request
        </div>
        {equipment.length === 0 ? (
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, fontStyle: "italic",
            background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px" }}>
            No containers added yet — the booking request will go out with no equipment detail.
          </div>
        ) : (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 140px 140px",
              gap: 10, padding: "8px 16px", borderBottom: `1px solid ${T.border}`,
              fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase" }}>
              <span>Type</span><span>Count</span><span>Total Weight</span><span>Total Volume</span>
            </div>
            {equipment.map(e => (
              <div key={e.type} style={{ display: "grid", gridTemplateColumns: "1fr 80px 140px 140px",
                gap: 10, padding: "9px 16px", borderBottom: `1px solid ${T.border}22`,
                fontFamily: T.body, fontSize: 13, color: T.text }}>
                <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.accent }}>{e.type}</span>
                <span>{e.count}</span>
                <span>{e.totalWeightKg.toLocaleString()} kg</span>
                <span>{e.totalVolumeCbm.toLocaleString()} m³</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {dgContainerCount > 0 && (
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, marginBottom: 16,
          background: T.warning + "12", border: `1px solid ${T.warning}44`,
          borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <IconWarning size={13} color={T.warning} />
          {dgContainerCount} container{dgContainerCount !== 1 ? "s" : ""} with DG cargo will be declared to the carrier.
        </div>
      )}

      {reeferGroups.length > 0 && (
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, marginBottom: 16,
          background: T.info + "12", border: `1px solid ${T.info}44`,
          borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <IconWarning size={13} color={T.info} />
          {reeferGroups.map((g, i) => (
            <span key={i}>{i > 0 && ", "}{g.count} × {g.type} @ {g.setTemperatureC}°C</span>
          ))} will be declared to the carrier.
        </div>
      )}

      {!bookable && (
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginBottom: 16,
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px" }}>
          Booking requests aren't supported for carrier {shipment.carrierCode || "—"} yet.
        </div>
      )}
      {status === "Pending" && (
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, marginBottom: 16,
          background: "#3b82f612", border: "1px solid #3b82f644",
          borderRadius: 8, padding: "10px 14px" }}>
          Awaiting carrier response — check the Review page once it arrives.
        </div>
      )}

      {canEdit && (
        <button onClick={handleSend} disabled={!canSend || sending}
          style={{ background: canSend ? T.accent : T.border, border: "none", borderRadius: 7,
            color: canSend ? "#fff" : T.textMuted, cursor: canSend && !sending ? "pointer" : "default",
            padding: "9px 20px", fontFamily: T.body, fontSize: 13, fontWeight: 700,
            display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 24 }}>
          {sending ? "Sending…" : <><IconSendPlane size={13} />Send Booking Request</>}
        </button>
      )}

      <h3 style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 12 }}>
        Sent Requests
      </h3>
      <EdiMessageList messages={outboundMessages} emptyText="No booking requests sent yet." />

      {creditHoldModal && (
        <CreditHoldModal holds={creditHoldModal.holds} action="sending a carrier booking request"
          onClose={() => setCreditHoldModal(null)} />
      )}
    </div>
  );
};

export default ShipmentCarrierBookingDetailsPage;
