import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import EdiMessageList from "../../components/shared/EdiMessageList";
import CarrierBookingsTable from "../../components/shared/CarrierBookingsTable";
import CreditHoldModal from "../../components/shared/CreditHoldModal";
import Spinner from "../../components/primitives/Spinner";
import { CommodityDisplay } from "./ShipmentDetailPage";
import { IconSendPlane, IconWarning } from "../../components/primitives/Icon";
import { resolveCreditGate } from "../../utils/invoiceGenerator";
import { canEditShipmentSide } from "../../utils/officeSide";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY, useHorizonFonts } from "./shipmentDetailTheme";
import { PaymentTermsCard } from "../../components/shared/PaymentTerms";
import { TransportDocumentCard } from "../../components/shared/TransportDocumentCard";
import { FoldSection, FactsPills, useFolds } from "../../components/shared/FoldSection";
import { PillNav, GlowEdge, DotPill, frameStyle, sectionLabelStyle, ctaStyle, pillBtnStyle, fmtDate } from "./schedules/SchedulesParts";

// ─── Carrier Booking — Details ────────────────────────────────────────────────
// The outbound half of a booking: what we're asking the carrier for, and the Send action itself. Sibling to Review (the
// carrier's response + Cancel). EdiMessageList stays as it is (shared with Test Tools and Document Templates).
//
// Trade Horizon Next (2026-11-18, mockup a3e1b986 v2, ARCHITECTURE.md §8.54; the user's rule: every design and build uses
// the latest patterns): the header with the route strip and the » pill (src/utils/horizonNextPages.js), a pill nav, the
// booking as the page's main card (carrier, route, vessel and ETD left the tiles: the header has them), the carrier offices
// and the payment terms as foldable sections (each starts open and then remembers the user's choice in this browser), the
// contract, then the booking request (equipment, the checks, Send, what was sent). One glowing action: Send Booking Request
// while it can be used, else Save payment terms.

const FREIGHT_TERMS_OPTIONS = ["Prepaid", "Collect", "Payable at Destination"];
const FOLD = { offices: "carrier-booking.offices", terms: "carrier-booking.terms", transport: "carrier-booking.transport" };
const FOLD_KEYS = Object.values(FOLD);

// The carrier offices' roles: booking = cyan, import = violet, billing = amber, as everywhere on the page.
const OFFICE_ROLES = [["booking", "Booking office", () => HZ.cyan], ["billing_origin", "Billing · origin", () => HZ.amber],
  ["import", "Import office", () => HZ.violet], ["billing_destination", "Billing · destination", () => HZ.amber]];
const FALLBACK_TEXT = { billing_origin: "no billing row: the booking office bills", billing_destination: "no billing row: the import office bills" };

// Same colours as the Bookings on this Shipment table (CarrierBookingsTable).
const statusColor = status => ({ Created: HZ.textMuted, Pending: HZ.info, Confirmed: HZ.good, Rejected: HZ.crit, Cancelled: HZ.textMuted }[status] || HZ.textMuted);
const headline = (status, carrier, booking) => (status === "Pending" && booking?.lastResponseStatus === "send_failed" ? `Not received by ${carrier}`
  : status === "Confirmed" && booking?.lastResponseStatus === "cancellation_requested" ? `Confirmed by ${carrier} · cancellation requested`
  : { Pending: `Pending with ${carrier}`, Confirmed: `Confirmed by ${carrier}`, Rejected: `Rejected by ${carrier}`, Cancelled: "Cancelled" }[status]
    || `Not sent to ${carrier} yet`);
const by = (at, who) => `${fmtDate(at)}${who ? ` by ${who}` : ""}`;
const subline = ({ status, booking, bookable, connection, carrier }) => {
  if (status === "Pending" && booking?.lastResponseStatus === "send_failed")
    return `${carrier} didn't receive the request sent ${by(booking?.requestedAt, booking?.requestedBy)}: send it again at the bottom of the page.`;
  if (status === "Confirmed" && booking?.lastResponseStatus === "cancellation_requested")
    return `The cancellation was requested; the booking stays confirmed until ${carrier} agrees (see the Review page).`;
  if (status === "Pending") return `Sent ${by(booking?.requestedAt, booking?.requestedBy)} · awaiting ${carrier}'s answer: check the Review page once it arrives.`;
  if (status === "Confirmed") return `Confirmed ${by(booking?.confirmedAt, booking?.confirmedBy)}.`;
  if (status === "Rejected") return `Answered ${fmtDate(booking?.respondedAt)}: see the Review page.`;
  if (status === "Cancelled") return `Cancelled ${by(booking?.cancelledAt, booking?.cancelledBy)}${booking?.cancelReason ? ` · ${booking.cancelReason}` : ""}.`;
  if (!bookable) return connection
    ? `No DCSA connection for ${carrier}, so it can't be booked from CargoDesk. Set one up under Carrier Integrations${connection.simulatorAvailable === false ? ", or turn on App Settings → Demo carrier for a demo" : ""}.`
    : "Checking the carrier's DCSA connection…";
  return "Check the offices, the payment terms and the equipment, then send the booking request at the bottom of the page.";
};
const sendBlockedWhy = ({ status, bookable }) => (!bookable ? "No DCSA connection for this carrier."
  : status === "Pending" ? "Sent: waiting for the carrier's answer." : status === "Confirmed" ? "Confirmed by the carrier." : "");

const factLabel = () => ({ display: "block", fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted, marginBottom: 2 });
const factValue = (nil = false) => ({ fontFamily: nil ? HZ_BODY : HZ_MONO, fontSize: 12.5, fontWeight: nil ? 400 : 700, fontStyle: nil ? "italic" : "normal",
  color: nil ? HZ.textMuted : HZ.text, wordBreak: "break-word" });
const Fact = ({ label, value, empty }) => (
  <div style={{ minWidth: 0 }}><span style={factLabel()}>{label}</span><b style={factValue(!value)}>{value || empty}</b></div>
);
const Note = ({ tone, children }) => {
  const c = tone === "info" ? HZ.info : HZ.warn;
  return (
    <div style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text, background: tone === "info" ? HZ.infoBg : HZ.warnBg,
      border: `1px solid color-mix(in srgb, ${c} 40%, transparent)`, borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
      <IconWarning size={13} color={c} /><span>{children}</span>
    </div>
  );
};

const initials = name => String(name || "").replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "—";
// One carrier office, as drawn in the mockup: its initials, its role, its name and where it is.
const OfficeCard = ({ role, label, tone, entry: e, port }) => {
  const o = e?.office;
  return (
    <div data-testid={`carrier-booking-office-${role}`} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", borderRadius: 12, minWidth: 0,
      background: HZ.tint, border: `1px ${o ? "solid" : "dashed"} ${o ? HZ.border : HZ.borderStrong}` }}>
      <span aria-hidden style={{ width: 34, height: 34, borderRadius: "50%", display: "grid", placeItems: "center", flex: "none", fontFamily: HZ_DISPLAY, fontSize: 12, fontWeight: 800,
        background: o ? HZ.gradCyan : HZ.neutralBg, color: o ? HZ.chipText : HZ.textMuted }}>{o ? initials(o.name) : "—"}</span>
      <div style={{ minWidth: 0 }}>
        <span style={{ fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", padding: "1px 7px", borderRadius: 5,
          color: tone, background: `color-mix(in srgb, ${tone} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${tone} 40%, transparent)` }}>{label}</span>
        <div style={{ fontFamily: HZ_BODY, fontSize: 13.5, fontWeight: o ? 700 : 600, fontStyle: o ? "normal" : "italic", color: o ? HZ.text : HZ.textMuted,
          marginTop: 5, lineHeight: 1.3, overflowWrap: "anywhere" }}>{o?.name || "None set"}</div>
        <div style={{ fontFamily: HZ_MONO, fontSize: 10.5, color: HZ.textMuted, marginTop: 2 }}>
          {o ? `${o.unlocode || "—"}${e.fallback ? ` · ${FALLBACK_TEXT[role]}` : ""}` : `for ${e?.port || port || "—"}`}
        </div>
      </div>
    </div>
  );
};
// Folded (decision D): the four in one line, a missing office in the warning colour.
const officeSummary = co => OFFICE_ROLES.map(([role, label]) => {
  const e = co?.roles?.[role];
  if (!e?.office) return { label, value: "none set", warn: true };
  if (e.fallback) return { label, value: role === "billing_origin" ? "the booking office" : "the import office" };
  return { label, value: e.office.name, tail: e.office.unlocode || "" };
});

const ShipmentCarrierBookingDetailsPage = ({ shipment, onBack, onRefresh }) => {
  const auth = useAuth();
  // Carrier Booking is export-edit per the Office-Side Permissions Epic (TKT-Z0LB0W).
  const canEdit = canEditShipmentSide(auth, shipment, "export");
  const [booking,    setBooking]    = useState(null);
  const [messages,   setMessages]   = useState([]);
  const [containers, setContainers] = useState([]);
  const [packDgContainerIds, setPackDgContainerIds] = useState(new Set());
  const [contract,   setContract]   = useState(null);
  const [namedAccountParent, setNamedAccountParent] = useState(null); // Organization Model Enhancement Epic 4
  const [carrierOffices, setCarrierOffices] = useState(null); // the carrier's offices on this shipment (§8.53)
  const [capabilityGaps, setCapabilityGaps] = useState([]); // TKT-FQFE33 — the carrier offices' capabilities cross-check
  const [loading,    setLoading]    = useState(true);
  const [sending,    setSending]    = useState(false);
  const [savingFreightTerms, setSavingFreightTerms] = useState(false);
  const [creditHoldModal, setCreditHoldModal] = useState(null); // { holds } — Credit Control Depth / TKT-Q00WHF
  // How CargoDesk reaches this carrier for bookings — its DCSA integration, the built-in DCSA simulator,
  // or not at all (DCSA only since 2026-10-11; eAdapter and the manual booking path are retired).
  const [connection, setConnection] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.carrierConnections.get(shipment.carrierCode)
      .then(r => !cancelled && setConnection(r))
      .catch(() => !cancelled && setConnection({ capabilities: {} }));
    return () => { cancelled = true; };
  }, [shipment.carrierCode]);

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
      api.shipments.carrierOffices.get(shipment.id).catch(() => null),
    ]).then(([b, m, c, co]) => {
      setBooking(b); setMessages(m); setContainers(c); setCarrierOffices(co); setCapabilityGaps(co?.capabilityGaps || []);
      // Pack-level DG flags (a pallet/carton can be flagged DG even when its container isn't)
      // also feed the outbound booking-request declaration (routes/edi.js) — fetched here too
      // so this awareness chip matches what's actually transmitted on Send.
      Promise.all(c.map(ctr => api.containerPackages.list(shipment.id, ctr.id).catch(() => [])))
        .then(lists => setPackDgContainerIds(new Set(
          c.filter((ctr, i) => lists[i].some(pk => pk.isDg)).map(ctr => ctr.id)
        )));
    }).finally(() => setLoading(false));
  }, [shipment.id]);

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

  const bookable = !!connection?.capabilities?.booking;
  const status = booking?.status || "Created";
  // A request the carrier never received can be sent again (audit 2026-11-18, B1); the server accepts it.
  const sendFailed = status === "Pending" && booking?.lastResponseStatus === "send_failed";
  const canSend = canEdit && bookable && (sendFailed || (status !== "Pending" && status !== "Confirmed"));
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
      // The carrier refused it (the server answers 201 with carrierError): say so, never "sent" (audit B2).
      if (result.carrierError) {
        toast.error(`${shipment.carrierCode || "The carrier"} didn't receive the booking request: ${result.carrierError}`);
      } else if (result.pending) {
        toast.info(result.booking?.isMock
          ? "Booking request sent to the demo carrier: answer it from Integration Board → Test Tools → DCSA Carrier."
          : `Booking request sent: awaiting ${shipment.carrierCode || "the carrier"}'s answer.`);
      } else {
        toast.success(result.isMock ? "Booking request sent (demo response received)" : "Booking request sent");
      }
      if (result.warning) toast.warning(result.warning);
    } catch (e) {
      toast.error(e.message || "Failed to send booking request");
    } finally {
      setSending(false);
    }
  };

  useHorizonFonts();
  const folds = useFolds(FOLD_KEYS, auth.user?.id);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: HZ.textMuted,
      fontFamily: HZ_BODY, fontSize: 13, padding: "60px 0", justifyContent: "center" }}>
      <Spinner size="sm" /> Loading booking details…
    </div>
  );

  const carrier = shipment.carrierCode || "the carrier";
  const officesOpen = folds.isOpen(FOLD.offices), termsOpen = folds.isOpen(FOLD.terms), transportOpen = folds.isOpen(FOLD.transport);
  // The page's one glowing action (Trade Horizon Next): Send Booking Request while it can be used, else Save payment terms.
  const sendIsPrimary = canSend;
  const navItems = [
    ["booking", "Booking", "shpbooking-booking-section"],
    ["offices", "Carrier offices", "shpbooking-offices-section", officesOpen ? null : "· folded"],
    ["terms", "Payment terms", "shpbooking-payment-terms-section", termsOpen ? null : "· folded"],
    ["transport", "Transport document", "shpbooking-transport-section", transportOpen ? null : "· folded"],
    ["contract", "Contract", "shpbooking-contract-section"],
    ["request", "Booking request", "shpbooking-request-section"],
  ];
  const openOnJump = key => {
    if (key === "offices" && !officesOpen) folds.setOpen(FOLD.offices, true);
    if (key === "terms" && !termsOpen) folds.setOpen(FOLD.terms, true);
    if (key === "transport" && !transportOpen) folds.setOpen(FOLD.transport, true);
  };

  return (
    <div id="shpbooking-details-page" data-testid="carrier-booking-details-page" style={{ maxWidth: 1100, margin: "0 auto", position: "relative" }}>
      {/* The horizon wash: a light source at the top of the page for the booking card to glow against. */}
      <div aria-hidden style={{ position: "absolute", left: -36, right: -36, top: -22, height: 380, background: HZ.ground, pointerEvents: "none", zIndex: 0 }} />
      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", gap: 18 }}>
        <PillNav items={navItems} testIdPrefix="carrier-booking" onJump={openOnJump} />

        {/* The booking with the carrier: the page's main card. Carrier, route, vessel and ETD are in the header. */}
        <section id="shpbooking-booking-section" data-testid="carrier-booking-booking-section" style={{ display: "flex", flexDirection: "column", gap: 12, scrollMarginTop: 90 }}>
          <div style={{ ...frameStyle(), overflow: "hidden" }}>
            <GlowEdge />
            <div style={{ position: "relative", zIndex: 1, padding: "18px 22px", display: "grid", gap: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={sectionLabelStyle()}>Booking with the carrier</div>
                  <div data-testid="carrier-booking-headline" style={{ fontFamily: HZ_DISPLAY, fontSize: 22, fontWeight: 800, letterSpacing: "-.01em", color: HZ.text, margin: "6px 0 2px" }}>
                    {headline(status, carrier, booking)}
                  </div>
                  <div data-testid="carrier-booking-subline" style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted, maxWidth: 720 }}>
                    {subline({ status, booking, bookable, connection, carrier })}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {booking?.isMock && booking?.carrierBookingRequestReference && (
                    <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".04em", padding: "2px 8px", borderRadius: 5,
                      background: HZ.violetBg, color: HZ.violetPillText, border: `1px solid color-mix(in srgb, ${HZ.violet} 40%, transparent)` }}>DEMO CARRIER</span>
                  )}
                  <DotPill color={sendFailed ? HZ.crit : statusColor(status)} testId="carrier-booking-status">{sendFailed ? "Not received" : status}</DotPill>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px 16px" }}>
                <Fact label="Booking Ref" value={booking?.bookingRef} empty="not confirmed yet" />
                <Fact label="Request reference" value={booking?.carrierBookingRequestReference} empty="not sent yet" />
                {/* Which party is financially responsible: Prepaid, Collect or Payable at Destination. Set on the Shipment
                    Form too; editable here, where it matters when booking. */}
                <div id="shpbooking-freight-terms" style={{ minWidth: 0 }}>
                  <span style={factLabel()}>Freight Terms</span>
                  {canEdit ? (
                    <select value={shipment.freightTerms || "Prepaid"} disabled={savingFreightTerms} onChange={handleFreightTermsChange} aria-label="Freight Terms"
                      style={{ fontFamily: HZ_MONO, fontSize: 12, fontWeight: 700, color: HZ.text, background: HZ.surfaceSolid, border: `1px solid ${HZ.border}`,
                        borderRadius: 999, padding: "3px 10px", maxWidth: "100%", cursor: savingFreightTerms ? "wait" : "pointer" }}>
                      {FREIGHT_TERMS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : <b style={factValue()}>{shipment.freightTerms || "Prepaid"}</b>}
                </div>
                <Fact label="Booking" value={booking?.id} empty="—" />
              </div>
              {/* D1 (2026-11-23, TKT-ML3GRC, mockup dffb8ab2): before the payment terms are saved, say where the ocean
                  freight's term comes from, so the card and the payment terms never seem to disagree. */}
              {!shipment.paymentTerms && (
                <div data-testid="carrier-booking-freight-hint" style={{ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted, lineHeight: 1.45 }}>
                  Until the payment terms are saved, the <b style={{ color: HZ.text }}>ocean freight follows Freight Terms</b> ({shipment.freightTerms || "Prepaid"}) and
                  the other charges follow the Incoterm{shipment.incoterm ? ` (${shipment.incoterm})` : ""}. Sending the booking saves them as shown.
                </div>
              )}
            </div>
          </div>
          {/* A block wrapper: the table centres itself with auto margins, which in this flex column would shrink it. */}
          <div style={{ minWidth: 0, marginTop: 6 }}><CarrierBookingsTable shipment={shipment} /></div>
        </section>

        {/* The carrier's offices (§8.53), read-only here: changed on Contracts & Schedules. Foldable (decision D: folded, the
            four in one line, "none set" in the warning colour). */}
        <FoldSection id="shpbooking-offices-section" testId="carrier-booking-offices" label="Carrier offices" tag={shipment.carrierCode || null}
          accent={HZ.cyan} open={officesOpen} onToggle={() => folds.toggle(FOLD.offices)}
          summary={<FactsPills testId="carrier-booking-offices-summary-pills" items={officeSummary(carrierOffices)} />}>
          {/* Two by two, as on Contracts & Schedules (one column on a narrow screen). */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 12 }}>
            {OFFICE_ROLES.map(([role, label, tone]) => (
              <OfficeCard key={role} role={role} label={label} tone={tone()} entry={carrierOffices?.roles?.[role]}
                port={role === "booking" || role === "billing_origin" ? shipment.pol : shipment.pod} />
            ))}
          </div>
          <div style={{ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted }}>
            Picked from the carrier's coverage (Master Data → Carriers) when the shipment's carrier or ports were set; change them on
            Contracts &amp; Schedules. The booking goes to the booking office; the freight is payable at the billing office of the side that pays it.
          </div>
        </FoldSection>

        {/* The office split (§8.52): the carrier payment terms per charge category, with what goes to the carrier. */}
        <PaymentTermsCard shipment={shipment} onSaved={() => onRefresh?.()} open={termsOpen} onToggle={() => folds.toggle(FOLD.terms)} primary={!sendIsPrimary} />

        {/* TKT-JV1SF2 point 5 (2026-11-23, mockup dffb8ab2): the transport document and loading, sent only when stated. */}
        <TransportDocumentCard shipment={shipment} open={transportOpen} onToggle={() => folds.toggle(FOLD.transport)}
          sentToCarrier={(status === "Pending" && !sendFailed) || status === "Confirmed"} />

        <section id="shpbooking-contract-section" data-testid="carrier-booking-contract-section" style={{ ...frameStyle(), padding: "16px 20px", scrollMarginTop: 90 }}>
          <div style={{ ...sectionLabelStyle(), marginBottom: 10 }}>Contract</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px 16px" }}>
            <div style={{ minWidth: 0 }}>
              <span style={factLabel()}>Contract Number</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {/* Violet for Central, cyan for SPOT/Pending/Customer Own, as on Contracts & Schedules. */}
                <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", padding: "2px 8px", borderRadius: 5,
                  ...(shipment.contractType === "Central"
                    ? { background: HZ.violetBg, color: HZ.violetPillText, border: `1px solid ${HZ.violet}66` }
                    : { background: HZ.cyanBg, color: HZ.cyan, border: `1px solid ${HZ.cyan}55` }) }}>{shipment.contractType || "—"}</span>
                {/* SPOT/Pending/Customer Own have no contract record: their contractRef stands in for the number. */}
                <b style={factValue()}>{shipment.contractType === "Central" ? (contract?.contractNumber || "—") : (shipment.contractRef || "—")}</b>
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <span style={factLabel()}>Reference</span>
              {/* The contract's own reference, not shipment.contractRef (for Central a copy of the contract number). */}
              {shipment.contractType === "Central" ? <b style={factValue(!contract?.contractRef)}>{contract?.contractRef || "—"}</b>
                : shipment.spotOfferId ? (
                  // A SPOT shipment priced on a carrier's spot offer books with the offer's reference (contractQuotationReference).
                  <span data-testid="booking-details-quotation-ref"><b style={factValue()}>{shipment.contractRef}</b>
                    <span style={{ display: "block", fontFamily: HZ_BODY, fontSize: 11, fontWeight: 500, color: HZ.textMuted, marginTop: 2 }}>Spot offer: sent as the quotation reference</span>
                  </span>
                ) : <b style={factValue(true)}>—</b>}
            </div>
            <div style={{ minWidth: 0 }}>
              <span style={factLabel()}>Client</span>
              {/* The contract's Named Account, not the shipper or consignee; none = "No Customer". */}
              <b style={factValue(!contract?.namedAccount)}>{contract?.namedAccount || "No Customer"}</b>
              {namedAccountParent && <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginTop: 2 }}>Part of {namedAccountParent}</div>}
            </div>
            <div style={{ minWidth: 0 }}>
              <span style={factLabel()}>Commodity</span>
              {shipment.commodityCode ? <CommodityDisplay code={shipment.commodityCode} /> : <b style={factValue(true)}>—</b>}
            </div>
          </div>
        </section>

        {/* What goes to the carrier, the checks, Send, and what was sent: read it, then send. */}
        <section id="shpbooking-request-section" data-testid="carrier-booking-request-section" style={{ ...frameStyle(), padding: "16px 20px", display: "grid", gap: 14, scrollMarginTop: 90 }}>
          <div style={sectionLabelStyle()}>Booking request · equipment sent to the carrier</div>
          {equipment.length === 0 ? (
            <div style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted, fontStyle: "italic", background: HZ.tint, border: `1px dashed ${HZ.borderStrong}`,
              borderRadius: 12, padding: "10px 14px" }}>
              No containers added yet — the booking request will go out with no equipment detail.
            </div>
          ) : (
            <div style={{ overflowX: "auto", background: HZ.tint, border: `1px solid ${HZ.border}`, borderRadius: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 420 }}>
                <thead>
                  <tr>{["Type", "Count", "Total Weight", "Total Volume"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "8px 14px", fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em",
                      color: HZ.textMuted, textTransform: "uppercase", borderBottom: `1px solid ${HZ.border}` }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {equipment.map(e => (
                    <tr key={e.type}>
                      <td style={{ padding: "9px 14px", fontFamily: HZ_MONO, fontWeight: 700, color: HZ.cyan, fontSize: 13 }}>{e.type}</td>
                      <td style={{ padding: "9px 14px", fontFamily: HZ_MONO, fontSize: 12.5, color: HZ.text, fontVariantNumeric: "tabular-nums" }}>{e.count}</td>
                      <td style={{ padding: "9px 14px", fontFamily: HZ_MONO, fontSize: 12.5, color: HZ.text, fontVariantNumeric: "tabular-nums" }}>{e.totalWeightKg.toLocaleString()} kg</td>
                      <td style={{ padding: "9px 14px", fontFamily: HZ_MONO, fontSize: 12.5, color: HZ.text, fontVariantNumeric: "tabular-nums" }}>{e.totalVolumeCbm.toLocaleString()} m³</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {dgContainerCount > 0 && (
            <Note tone="warn">{dgContainerCount} container{dgContainerCount !== 1 ? "s" : ""} with DG cargo will be declared to the carrier.</Note>
          )}
          {reeferGroups.length > 0 && (
            <Note tone="info">{reeferGroups.map((g, i) => (<span key={i}>{i > 0 && ", "}{g.count} × {g.type} @ {g.setTemperatureC}°C</span>))} will be declared to the carrier.</Note>
          )}
          {capabilityGaps.map((g, i) => (
            <Note key={i} tone="warn">{g.side === "Export" ? "The booking office" : "The import office"} <strong>{g.officeName || g.agentName}</strong> has no <strong>{g.capabilityLabel}</strong> capability
              on file, but this shipment has a {g.reason.toLowerCase()}.</Note>
          ))}

          {canEdit && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" onClick={handleSend} disabled={!canSend || sending} data-testid="carrier-booking-send"
                style={canSend ? ctaStyle({ disabled: sending }) : pillBtnStyle({ disabled: true })}>
                {sending ? "Sending…" : <><IconSendPlane size={13} />Send Booking Request</>}
              </button>
              {!canSend && <span style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted }}>{sendBlockedWhy({ status, bookable })}</span>}
            </div>
          )}

          <div style={{ ...sectionLabelStyle(), marginTop: 4 }}>Sent requests</div>
          <EdiMessageList messages={outboundMessages} emptyText="No booking requests sent yet." />
        </section>
      </div>

      {creditHoldModal && (
        <CreditHoldModal holds={creditHoldModal.holds} action="sending a carrier booking request"
          onClose={() => setCreditHoldModal(null)} />
      )}
    </div>
  );
};

export default ShipmentCarrierBookingDetailsPage;
