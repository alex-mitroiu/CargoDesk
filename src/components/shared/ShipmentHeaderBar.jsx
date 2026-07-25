import { useEffect, useRef, useState } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { ComplianceModal, RouteSummaryBar, MessagesDrawer, TicketsDrawer } from "../../pages/ShipmentDetailPage";
import { deriveHaulageNeeds } from "../../pages/ShipmentFormPage";
import ContractMismatchModal from "./ContractMismatchModal";
import { AnyIcon, IconClipboard, IconLink, IconRefresh, IconPencil, IconWarning, IconCheck,
  IconMail, IconMailUnread } from "../primitives/Icon";

// ─── Persistent Shipment Header ────────────────────────────────────────────
// Mounted once in App.jsx above the page switch for "detail" + every promoted
// shipment sub-page, so shipment identity/route/dates stay visible while
// navigating between tabs. Row 3 reuses RouteSummaryBar as-is (same component
// shown on the Schedules page) rather than maintaining a second, different
// journey visualization for the same underlying legs data.
//
// Messages/Share/Refresh used to be per-page actions on the old Overview header
// (only reachable there); they now live here instead, grouped into one small icon
// tile (IconTile below) so they're a single fixture visible from every page rather
// than separate buttons duplicated per page. EDI/carrier-booking moved OUT of this
// tile in v0.35.0 — it's now the dedicated Carrier Booking page (Explorer sidebar),
// not a drawer.

const Field = ({ label, value, first }) => (
  <div id={`shphdr-field-${label.toLowerCase().replace(/\s+/g, "-")}`} style={{
    display: "flex", alignItems: "baseline", gap: 6,
    padding: "0 14px", margin: first ? "0 14px 0 0" : 0,
    borderLeft: first ? "none" : `1px solid ${T.border}`,
  }}>
    <span style={{ fontFamily: T.mono, fontSize: 10, textTransform: "uppercase",
      letterSpacing: "0.08em", color: T.textMuted, flexShrink: 0 }}>{label}</span>
    <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, fontWeight: 500,
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>
      {value || "—"}
    </span>
  </div>
);

// Cluster of icon actions, styled after an iOS App Library folder tile — one
// compact group instead of loose buttons competing for header space. Fixed
// 2-column grid, cell size fixed, height grows with item count (wraps to a
// 3rd row rather than resizing cells) so 4 or 5 icons both read as one tile.
// Each icon's action name shows in a custom on-brand tooltip on hover — same
// small dark label treatment used for SectionHeader's numbered-chip tooltips
// elsewhere in the app — rather than the slow, unstyled native `title` popup.
// Column count grows with item count (rather than staying fixed at 2) so the
// tile never exceeds 2 rows — 4 items stay 2×2, 5-6 become 3×2, etc.
const IconTile = ({ items }) => {
  const [hovered, setHovered] = useState(null);
  const cols = Math.max(2, Math.ceil(items.length / 2));
  return (
    <div id="shphdr-icontile" style={{
      display: "grid", gridTemplateColumns: `repeat(${cols}, 26px)`, gridAutoRows: "26px", gap: 3,
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10,
      padding: 4, flexShrink: 0,
    }}>
      <style>{`@keyframes shb-spin { to { transform: rotate(360deg); } }`}</style>
      {items.map(it => (
        <div key={it.key} id={`shphdr-icontile-${it.key}`} style={{ position: "relative" }}
          onMouseEnter={() => setHovered(it.key)}
          onMouseLeave={() => setHovered(null)}>
          <button type="button" onClick={it.onClick}
            style={{ position: "relative", width: "100%", height: "100%", borderRadius: 6,
              background: hovered === it.key ? T.accentBg : "none",
              border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, lineHeight: 1, color: hovered === it.key ? T.accent : T.textMuted,
              transition: "background .12s, color .12s" }}>
            <span style={{ display: "inline-flex", alignItems: "center", animation: it.spinning ? "shb-spin .7s linear infinite" : "none" }}>
              <AnyIcon icon={it.icon} size={14} />
            </span>
            {!!it.badge && (
              <span style={{ position: "absolute", top: -3, right: -3,
                background: T.danger, color: "#fff", borderRadius: "50%",
                width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: T.mono, fontSize: 8, fontWeight: 700, lineHeight: 1 }}>
                {it.badge > 9 ? "9+" : it.badge}
              </span>
            )}
          </button>
          {hovered === it.key && (
            <div style={{ position: "absolute", top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
              background: T.text, color: T.bg, fontFamily: T.body, fontSize: 11, fontWeight: 600,
              padding: "4px 9px", borderRadius: 6, whiteSpace: "nowrap", zIndex: 20,
              boxShadow: "0 4px 14px rgba(0,0,0,.25)", pointerEvents: "none" }}>
              {it.title}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

const ShipmentHeaderBar = ({ shipment, containers = [], onNavigateToSchedules, onUpdate, onRefresh, onEdit }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [schedules, setSchedules] = useState([]);
  const [screening, setScreening] = useState(null);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [contractMismatch, setContractMismatch] = useState(false);
  const [pendingMatches, setPendingMatches] = useState(null);
  const [legs, setLegs] = useState([]);

  // ── Messages ──
  const [msgsOpen, setMsgsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const loadMessagesRef = useRef(null);
  const loadMessages = () =>
    api.shipmentMessages.list(shipment.id).then(msgs => {
      setMessages(msgs);
      const lastRead = localStorage.getItem(`msg_read_${shipment.id}`) || "";
      setUnreadCount(msgs.filter(m => m.createdAt > lastRead).length);
    }).catch(() => {});
  loadMessagesRef.current = loadMessages;

  useEffect(() => { loadMessages(); }, [shipment.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!msgsOpen) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsHost = import.meta.env.DEV ? "localhost:3001" : window.location.host;
    const ws = new WebSocket(`${proto}//${wsHost}/ws`);
    let pollId;
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", shipmentId: shipment.id }));
    ws.onmessage = e => {
      try {
        const frame = JSON.parse(e.data);
        if (frame.type === "new_message") {
          setMessages(prev => {
            if (prev.some(m => m.id === frame.message.id)) return prev;
            const lastRead = localStorage.getItem(`msg_read_${shipment.id}`) || "";
            if (frame.message.createdAt > lastRead) setUnreadCount(n => n + 1);
            return [...prev, frame.message];
          });
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => { pollId = setInterval(() => loadMessagesRef.current?.(), 10_000); };
    ws.onclose = () => { if (pollId) clearInterval(pollId); };
    return () => { ws.close(); if (pollId) clearInterval(pollId); };
  }, [msgsOpen, shipment.id]);

  const openMessages = () => {
    setMsgsOpen(true);
    localStorage.setItem(`msg_read_${shipment.id}`, new Date().toISOString());
    setUnreadCount(0);
  };

  // ── Tickets ──
  // No WS subscription (unlike Messages above) — no ticket_updated broadcast type
  // exists today; this just fetches once per shipment for the open-count badge, same as
  // Messages' initial unread-count fetch, and again whenever the drawer opens.
  const [ticketsOpen, setTicketsOpen] = useState(false);
  const [openTicketCount, setOpenTicketCount] = useState(0);
  const DONE_TICKET_STATUSES = ["Done", "Ready to Deploy", "Released", "Cancelled"];
  useEffect(() => {
    let live = true;
    api.tickets.forShipment(shipment.id)
      .then(rows => { if (live) setOpenTicketCount(rows.filter(t => !DONE_TICKET_STATUSES.includes(t.status)).length); })
      .catch(() => {});
    return () => { live = false; };
  }, [shipment.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Share ──
  const [shareUrl, setShareUrl] = useState(null);
  const [shareLoading, setShareLoading] = useState(false);
  const handleShare = async () => {
    if (shareLoading) return;
    setShareLoading(true);
    try {
      const r = await api.shipments.shareToken(shipment.id);
      setShareUrl(r.url);
    } catch { toast.error("Failed to generate tracking link"); }
    finally { setShareLoading(false); }
  };

  // ── Refresh ──
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await onRefresh?.(); } catch {} finally { setTimeout(() => setRefreshing(false), 600); }
  };

  useEffect(() => {
    let live = true;
    api.schedules.list(shipment.id).then(rows => { if (live) setSchedules(rows || []); }).catch(() => {});
    return () => { live = false; };
  }, [shipment.id]);

  useEffect(() => {
    let live = true;
    api.screening.get(shipment.id).then(s => { if (live) setScreening(s); }).catch(() => {});
    return () => { live = false; };
  }, [shipment.id]);

  useEffect(() => {
    let live = true;
    api.legs.list(shipment.id).then(rows => { if (live) setLegs(rows || []); }).catch(() => {});
    return () => { live = false; };
  }, [shipment.id]);

  // shipment.pol/pod are the journey's overall door-to-door bookends — with a Door pickup
  // leg or a multi-leg (TSP) journey, that's not the same as the actual SEA leg(s)' own
  // pol/pod, and a contract is always matched port-to-port against the real ocean leg.
  const seaLegs = legs.filter(l => l.legType === "SEA");
  const matchPol = seaLegs[0]?.pol || shipment.pol || "";
  const matchPod = seaLegs[seaLegs.length - 1]?.pod || shipment.pod || "";
  const { needsPolHaulage, needsPodHaulage, pkuLocation, delLocation } = deriveHaulageNeeds(legs);

  // Silent revalidation: a Central contract was matched against POL/POD (and haulage coverage)
  // at the time it was picked, but nothing re-checks it if the route changes afterward — same
  // class of gap the Pending-contract check right below covers for Pending shipments. Must
  // agree with ContractAssignModal's own check or the badge and the actual fix flow could
  // disagree on whether there's a problem.
  useEffect(() => {
    let live = true;
    if (shipment.contractType !== "Central" || !shipment.contractId || !matchPol || !matchPod) {
      setContractMismatch(false);
      return;
    }
    api.contracts.match({ pol: matchPol, pod: matchPod,
      ...(needsPolHaulage && { needsPolHaulage: "1" }), ...(needsPodHaulage && { needsPodHaulage: "1" }),
      ...(pkuLocation && { pkuLocation }), ...(delLocation && { delLocation }) })
      .then(matches => { if (live) setContractMismatch(!matches.some(m => m.id === shipment.contractId)); })
      .catch(() => { if (live) setContractMismatch(false); });
    return () => { live = false; };
  }, [shipment.contractType, shipment.contractId, matchPol, matchPod, needsPolHaulage, needsPodHaulage, pkuLocation, delLocation]);

  // Pending-contract revalidation: a Pending shipment's free-text contractRef might now
  // string-match a real Active contract in the repo — check on every load. Only a badge here
  // (not the actual PendingRevalidationModal) because this component remounts on every
  // sub-page navigation; popping a dismissible modal on every remount would re-interrupt the
  // user right after they dismissed it a page ago. The actual accept/dismiss UI lives on the
  // Contracts & Schedules page instead, same split as the Contract Mismatch badge above.
  useEffect(() => {
    let live = true;
    if (shipment.contractType !== "Pending" || !shipment.contractRef) { setPendingMatches(null); return; }
    api.contracts.revalidate(shipment.contractRef)
      .then(matches => { if (live) setPendingMatches(matches.length > 0 ? matches : null); })
      .catch(() => { if (live) setPendingMatches(null); });
    return () => { live = false; };
  }, [shipment.id, shipment.contractType, shipment.contractRef]);

  const ctrs = containers.filter(c => c.shipmentId === shipment.id);
  const teu = ctrs.reduce((n, c) => n + (c.size === "40" ? 2 : 1), 0);
  const dgClasses = [...new Set(ctrs.filter(c => c.isDg).map(c => c.dgClass).filter(Boolean))];
  const isDg = ctrs.some(c => c.isDg);
  const loopCode = schedules[0]?.service || "";

  const vesselVoyage = [shipment.vessel, shipment.voyage ? `Voy ${shipment.voyage}` : null].filter(Boolean).join(" · ");

  const copyId = () => {
    navigator.clipboard.writeText(shipment.id)
      .then(() => toast.success(`Copied ${shipment.id}`))
      .catch(() => toast.error("Could not copy to clipboard"));
  };

  return (
    <div id="shphdr" style={{
      background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
      padding: "14px 22px", marginBottom: 22, position: "sticky", top: 0, zIndex: 5,
    }}>
      {/* Row 1 — identity, route, dates, DG */}
      <div id="shphdr-row1" style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <span id="shphdr-id" style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: 17, color: T.text,
            letterSpacing: "0.01em" }}>{shipment.id}</span>
          <button id="shphdr-copy-id-btn" type="button" onClick={copyId} title="Copy shipment ID"
            style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 3px",
              display: "flex", alignItems: "center", fontSize: 12, lineHeight: 1, color: T.textMuted }}
            onMouseEnter={e => { e.currentTarget.style.color = T.accent; }}
            onMouseLeave={e => { e.currentTarget.style.color = T.textMuted; }}>
            <IconClipboard size={12} />
          </button>
        </span>
        <span id="shphdr-movement-type" style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 600, letterSpacing: "0.03em",
          padding: "3px 9px", borderRadius: 5, background: T.accentBg, color: T.accent,
          border: `1px solid ${T.accent}66` }}>{shipment.movementType || "FCL"}</span>

        {(() => {
          const r = screening?.result;
          const isHit = r === "HIT";
          const overridden = screening?.overriddenAt;
          const bg = !r ? T.border + "33" : isHit ? "#ef444420" : "#22c55e20";
          const color = !r ? T.textMuted : isHit ? "#ef4444" : "#22c55e";
          const label = !r ? "UNSCREENED" : isHit
            ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><IconWarning size={11} />Compliance review required</span>
            : overridden
              ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><IconCheck size={11} />CLEAR*</span>
              : <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><IconCheck size={11} />CLEAR</span>;
          const hitLines = isHit && screening?.hits?.length
            ? screening.hits.map(h => `${h.field}: ${h.value}`).join("\n")
            : null;
          const tooltipText = !r ? "Run compliance screening"
            : isHit ? `Sanctioned party detected:\n${hitLines}\n\nClick to review`
            : overridden ? "Cleared via manual override"
            : "Compliance clear";
          return (
            <button id="shphdr-compliance-btn" type="button" onClick={() => setComplianceOpen(true)}
              title={tooltipText}
              style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
                borderRadius: 5, padding: "3px 9px", letterSpacing: "0.03em", whiteSpace: "nowrap",
                border: `1px solid ${!r ? T.border : isHit ? "#ef444444" : "#22c55e44"}`,
                background: bg, color }}>
              {label}
            </button>
          );
        })()}

        <div style={{ width: 1, alignSelf: "stretch", background: T.border }} />

        <div id="shphdr-route" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: 15, color: T.text }}>{shipment.pol || "—"}</span>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{shipment.polName || ""}</span>
          </div>
          <span style={{ color: T.textMuted }}>→</span>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: 15, color: T.text }}>{shipment.pod || "—"}</span>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{shipment.podName || ""}</span>
          </div>
        </div>

        <div style={{ width: 1, alignSelf: "stretch", background: T.border }} />

        <div id="shphdr-dates" style={{ display: "flex", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontFamily: T.mono, fontSize: 10, textTransform: "uppercase",
              letterSpacing: "0.08em", color: T.textMuted }}>ETD</span>
            <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text,
              fontVariantNumeric: "tabular-nums" }}>{shipment.etd || "—"}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontFamily: T.mono, fontSize: 10, textTransform: "uppercase",
              letterSpacing: "0.08em", color: T.textMuted }}>ETA</span>
            <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text,
              fontVariantNumeric: "tabular-nums" }}>{shipment.eta || "—"}</span>
          </div>
        </div>

        <div style={{ flex: 1 }} />

        <IconTile items={[
          { key: "messages", icon: unreadCount > 0 ? IconMailUnread : IconMail, badge: unreadCount,
            title: unreadCount > 0 ? `${unreadCount} unread message${unreadCount > 1 ? "s" : ""}` : "Shipment messages",
            onClick: openMessages },
          { key: "share", icon: IconLink, spinning: false,
            title: "Generate customer tracking link", onClick: handleShare },
          { key: "refresh", icon: IconRefresh, spinning: refreshing,
            title: "Refresh shipment", onClick: handleRefresh },
          { key: "tickets", icon: "◩", badge: openTicketCount,
            title: openTicketCount > 0 ? `${openTicketCount} open ticket${openTicketCount > 1 ? "s" : ""}` : "Related tickets",
            onClick: () => setTicketsOpen(true) },
          ...(canEdit ? [{ key: "edit", icon: IconPencil, title: "Edit Shipment", onClick: () => onEdit?.() }] : []),
        ]} />

        {contractMismatch && (
          <button id="shphdr-contract-mismatch-badge" type="button" onClick={onNavigateToSchedules}
            title={`${shipment.contractRef || "The attached contract"} no longer covers ${matchPol} → ${matchPod} — click to resolve`}
            style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.03em",
              padding: "3px 9px", borderRadius: 5, background: T.danger + "22", color: T.danger,
              border: `1px solid ${T.danger}66`, whiteSpace: "nowrap", cursor: onNavigateToSchedules ? "pointer" : "default",
              display: "inline-flex", alignItems: "center", gap: 4 }}>
            <IconWarning size={11} />Contract Mismatch
          </button>
        )}

        {pendingMatches && (
          <button id="shphdr-contract-match-badge" type="button" onClick={onNavigateToSchedules}
            title={`${pendingMatches.length} active contract${pendingMatches.length !== 1 ? "s" : ""} match${pendingMatches.length === 1 ? "es" : ""} "${shipment.contractRef}" — click to review`}
            style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.03em",
              padding: "3px 9px", borderRadius: 5, background: T.info + "22", color: T.info,
              border: `1px solid ${T.info}66`, whiteSpace: "nowrap", cursor: onNavigateToSchedules ? "pointer" : "default",
              display: "inline-flex", alignItems: "center", gap: 4 }}>
            <IconRefresh size={11} />Contract Match Found
          </button>
        )}

        {isDg && (
          <span id="shphdr-dg-badge" style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.03em",
            padding: "3px 9px", borderRadius: 5, background: T.danger + "22", color: T.danger,
            border: `1px solid ${T.danger}66`, whiteSpace: "nowrap",
            display: "inline-flex", alignItems: "center", gap: 4 }}>
            <IconWarning size={11} />DG{dgClasses.length ? ` · CLASS ${dgClasses.join("/")}` : ""}
          </span>
        )}
      </div>

      {/* Row 2 — secondary facts */}
      <div id="shphdr-row2" style={{ display: "flex", flexWrap: "wrap", rowGap: 6,
        marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
        <Field first label="Incoterm" value={shipment.incoterm} />
        <Field label="Routing" value={shipment.routingTerm} />
        <Field label="Trade Lane" value={shipment.tradeLane} />
        <Field label="Vessel" value={vesselVoyage} />
        <Field label="Shipper" value={shipment.shipperName} />
        <Field label="Consignee" value={shipment.consigneeName} />
        <Field label="Contract" value={shipment.contractRef} />
        <Field label="TEU" value={ctrs.length ? String(teu) : null} />
        <Field label="Loop" value={loopCode} />
      </div>

      {/* Row 3 — the same route summary panel shown on the Schedules page (Pick-up/POL,
          ETD/transit/ETA/carrier/routing-term, POD/Delivery) — one visual for one concept
          instead of a second, different journey diagram. */}
      <div id="shphdr-row3" style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
        <RouteSummaryBar shipment={shipment} />
      </div>

      {complianceOpen && (
        <ComplianceModal
          shipment={shipment}
          screening={screening}
          onChange={s => setScreening(s)}
          onClose={() => setComplianceOpen(false)}
        />
      )}

      {contractMismatch && onUpdate && (
        <ContractMismatchModal shipment={shipment} pol={matchPol} pod={matchPod}
          needsPolHaulage={needsPolHaulage} needsPodHaulage={needsPodHaulage}
          pkuLocation={pkuLocation} delLocation={delLocation}
          onUpdate={onUpdate} />
      )}

      {shareUrl && (
        <Modal title={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><IconLink size={15} />Customer Tracking Link</span>} onClose={() => setShareUrl(null)} style={{ maxWidth: 520 }}>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, marginBottom: 12 }}>
            Anyone with this link can view the shipment status and milestones — no login required.
            Valid for 30 days.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input readOnly value={shareUrl} style={{
              flex: 1, padding: "8px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
              background: T.surface, color: T.text, fontFamily: T.mono, fontSize: 12,
            }} onFocus={e => e.target.select()} />
            <Btn onClick={() => { navigator.clipboard.writeText(shareUrl); toast.success("Link copied!"); }}>
              Copy
            </Btn>
          </div>
        </Modal>
      )}

      {msgsOpen && <MessagesDrawer
        shipment={shipment}
        messages={messages}
        onPost={async () => { loadMessages(); }}
        onClose={() => setMsgsOpen(false)}
      />}

      {ticketsOpen && <TicketsDrawer shipment={shipment} onClose={() => setTicketsOpen(false)} />}
    </div>
  );
};

export default ShipmentHeaderBar;
