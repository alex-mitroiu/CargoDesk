import { useCallback, useEffect, useRef, useState } from "react";
import { T, IMDG_CLASSES } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { ComplianceModal, RouteSummaryBar, MessagesDrawer, TicketsDrawer } from "../../pages/shipments/ShipmentDetailPage";
import { deriveHaulageNeeds } from "../../pages/shipments/ShipmentFormPage";
import useContractMismatch from "../../hooks/useContractMismatch";
import ContractMismatchModal from "./ContractMismatchModal";
import { AnyIcon, IconClipboard, IconLink, IconRefresh, IconPencil, IconWarning, IconCheck,
  IconMail, IconMailUnread, IconLock, IconGroup, IconArrowUp, IconArrowDown } from "../primitives/Icon";
import { fmtCurr } from "../../utils/invoiceGenerator";
import { onCargoValueChanged } from "../../cargoValueBus";
import { onLegsScheduleChanged } from "../../legsScheduleBus";
import { deriveLoopCode } from "../../utils/scheduleLoop";
import { isShipmentLocked } from "../../utils/shipmentLock";
import LoopRouteModal from "./LoopRouteModal";
import { LegRoleChip, viaText } from "./LegRoles";
import { ACTUAL_SOURCES } from "../../utils/legChain";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY, useHorizonFonts } from "../../pages/shipments/shipmentDetailTheme";

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

const Field = ({ label, value, first, onClick }) => (
  <div id={`shphdr-field-${label.toLowerCase().replace(/\s+/g, "-")}`}
    data-testid={`shipment-detail-header-field-${label.toLowerCase().replace(/\s+/g, "-")}`}
    onClick={onClick}
    title={onClick ? "Click to view route" : undefined}
    style={{
      display: "flex", flexDirection: "column", gap: 2,
      padding: "0 16px", margin: first ? "0 16px 0 0" : 0,
      borderLeft: first ? "none" : `1px solid ${HZ.border}`,
      cursor: onClick ? "pointer" : "default",
    }}>
    <span style={{ fontFamily: HZ_MONO, fontSize: 9.5, textTransform: "uppercase",
      letterSpacing: "0.08em", color: HZ.textMuted, flexShrink: 0 }}>{label}</span>
    <span style={{ fontFamily: HZ_BODY, fontSize: 12.5, fontWeight: onClick ? 700 : 600,
      color: onClick ? HZ.cyan : HZ.text, textDecoration: onClick ? "underline" : "none",
      textDecorationColor: onClick ? `${HZ.cyan}66` : "transparent", textUnderlineOffset: 2,
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
    <div id="shphdr-icontile" data-testid="shipment-detail-header-icon-tile" style={{
      display: "grid", gridTemplateColumns: `repeat(${cols}, 26px)`, gridAutoRows: "26px", gap: 3,
      background: HZ.tint, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10,
      padding: 4, flexShrink: 0,
    }}>
      <style>{`@keyframes shb-spin { to { transform: rotate(360deg); } }`}</style>
      {items.map(it => (
        <div key={it.key} id={`shphdr-icontile-${it.key}`} data-testid={`shipment-detail-header-icon-${it.key}`} style={{ position: "relative" }}
          onMouseEnter={() => setHovered(it.key)}
          onMouseLeave={() => setHovered(null)}>
          <button type="button" onClick={it.onClick}
            style={{ position: "relative", width: "100%", height: "100%", borderRadius: 6,
              background: hovered === it.key ? HZ.cyanBg : "none",
              border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, lineHeight: 1, color: hovered === it.key ? HZ.cyan : HZ.textMuted,
              transition: "background .12s, color .12s" }}>
            <span style={{ display: "inline-flex", alignItems: "center", animation: it.spinning ? "shb-spin .7s linear infinite" : "none" }}>
              <AnyIcon icon={it.icon} size={14} />
            </span>
            {!!it.badge && (
              <span style={{ position: "absolute", top: -3, right: -3,
                background: HZ.crit, color: "#fff", borderRadius: "50%",
                width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: HZ_MONO, fontSize: 8, fontWeight: 700, lineHeight: 1 }}>
                {it.badge > 9 ? "9+" : it.badge}
              </span>
            )}
          </button>
          {hovered === it.key && (
            <div style={{ position: "absolute", top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
              background: HZ.text, color: HZ.bg, fontFamily: HZ_BODY, fontSize: 11, fontWeight: 600,
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

// Minimized-state summary row (direct request, then redesigned per the approved Trade Horizon
// mockup — https://claude.ai/artifact/SUaCjaQYTdaPHbXmm2FfYj) — a compact divided-segment strip
// standing in for the full Row 2 + route pill, so the header can default to a much shorter
// footprint without losing the fields an operator scans for most. Containers collapse to
// "N×TYPE" when every container on the shipment shares one size+type, or a plain "N containers"
// count otherwise — a mixed manifest has no single code worth naming here. The mockup's own
// field list also included a milestone-completion fraction ("3/9"); that number isn't part of
// this component's existing data (it would mean a new fetch just for the minimized state), so
// Shipper stands in its place here — same "don't add fetches for a visual pass" rule this
// codebase's other Trade Horizon ports (Dashboard, Command Center) already followed.
// The folded row as it is on every page but Contracts & Schedules (HEAD's, unchanged).
const ChipRowClassic = ({ shipment, ctrs, cargoValueUsd, openTicketCount }) => {
  const ctrTypeKeys = [...new Set(ctrs.map(c => `${c.size}${c.type}`))];
  const containerSummary = ctrs.length === 0 ? null
    : ctrTypeKeys.length === 1 ? `${ctrs.length}×${ctrTypeKeys[0]}`
    : `${ctrs.length} container${ctrs.length !== 1 ? "s" : ""}`;
  // The vessel is the main sea leg's (syncShipmentFromLegs); a transshipment marks it MAIN and says
  // which hub and feeder it goes via (agreed 2026-10-21).
  const ts = shipment.transshipment;
  const carrierSeg = shipment.carrierCode
    ? <>{`${shipment.carrierCode}${shipment.vessel ? ` · ${shipment.vessel}${shipment.voyage ? ` / ${shipment.voyage}` : ""}` : ""}`}{ts && shipment.vessel && <> <LegRoleChip role="MAIN" muted={HZ.textMuted} /></>}</>
    : null;
  const via = ts ? viaText({ legs: ts.legs, mainLegIndex: ts.mainIndex }).replace(/^via /, "") : "";
  const chips = [
    shipment.incoterm && { label: "Incoterm", value: shipment.incoterm },
    carrierSeg && { label: null, value: carrierSeg, accent: true },
    via && { label: "via", value: via },
    shipment.contractRef && { label: "Contract", value: shipment.contractRef },
    containerSummary && { label: "Cargo", value: containerSummary },
    cargoValueUsd != null && { label: "Cargo Value", value: fmtCurr(cargoValueUsd, "USD") },
    shipment.shipperName && { label: "Shipper", value: shipment.shipperName },
    openTicketCount > 0 && { label: "Open Tickets", value: String(openTicketCount) },
  ].filter(Boolean);
  if (!chips.length) return null;
  return (
    <div id="shphdr-chiprow" data-testid="shipment-detail-header-chip-row" style={{ display: "flex", flexWrap: "wrap", alignItems: "center",
      marginTop: 11, paddingTop: 11, borderTop: `1px solid ${HZ.border}` }}>
      {chips.map((c, i) => (
        <span key={c.label || `seg-${i}`} id={`shphdr-chip-${(c.label || "carrier").toLowerCase()}`} data-testid={`shipment-detail-header-chip-${(c.label || "carrier").toLowerCase()}`} style={{
          fontFamily: HZ_MONO, fontSize: 11.3, whiteSpace: "nowrap",
          color: c.accent ? HZ.text : HZ.textMuted,
          padding: i === 0 ? "0 13px 0 0" : "0 13px", borderLeft: i === 0 ? "none" : `1px solid ${HZ.border}`,
          maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>
          {c.label && <>{c.label} </>}
          <strong style={{ color: c.accent ? HZ.cyan : HZ.text, fontWeight: 700 }}>{c.value}</strong>
        </span>
      ))}
    </div>
  );
};

// Trade Horizon next (Contracts & Schedules only until the user approves it for every page, 2026-11-06), mockup
// 402fb5b5 v5–v7: Principal, Shipper, Consignee and Incoterm lead the row ("—" when empty), then the carrier's code (the
// user: "just use the carrier code, it's shorter, cleaner and better"), the main vessel (syncShipmentFromLegs puts the
// MAIN sea leg's on the shipment), its voyage and the service of the saved sailing, all as plain label and value. No
// carrier pill, no feeders (the transshipment ports sit under the route), no contract (it has its card). The
// container count, DG flag and dates are on row 1.
const ChipRow = ({ shipment, loopCode, openTicketCount }) => {
  const chips = [
    { label: "Principal", value: shipment.principalName, title: shipment.principalName },
    { label: "Shipper", value: shipment.shipperName, title: shipment.shipperName },
    { label: "Consignee", value: shipment.consigneeName, title: shipment.consigneeName },
    { label: "Incoterm", value: shipment.incoterm },
    { label: "Carrier", value: shipment.carrierCode },
    { label: "Vessel", value: shipment.vessel, title: shipment.vessel },
    { label: "Voyage", value: shipment.voyage },
    { label: "Service", value: loopCode },
    openTicketCount > 0 && { label: "Open Tickets", value: String(openTicketCount) },
  ].filter(Boolean);
  return (
    <div id="shphdr-chiprow" data-testid="shipment-detail-header-chip-row" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: 6,
      marginTop: 11, paddingTop: 11, borderTop: `1px solid ${HZ.border}` }}>
      {chips.map((c, i) => (
        <span key={c.label} id={`shphdr-chip-${c.label.toLowerCase().replace(/\s+/g, "-")}`} data-testid={`shipment-detail-header-chip-${c.label.toLowerCase().replace(/\s+/g, "-")}`}
          title={c.title || undefined} style={{
          fontFamily: HZ_MONO, fontSize: 11.3, whiteSpace: "nowrap", color: HZ.textMuted,
          padding: i === 0 ? "0 13px 0 0" : "0 13px", borderLeft: i === 0 ? "none" : `1px solid ${HZ.border}`,
          maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>
          {c.label} <strong style={{ color: HZ.text, fontWeight: 700 }}>{c.value || "—"}</strong>
        </span>
      ))}
    </div>
  );
};

// ─── Route strip (Trade Horizon, next, 2026-11-06) ────────────────────────────────────────────────────────────────
// Port codes in display type either side of a track that fills from ETD to ETA, with the ETA countdown and TEU as
// numerals. A missing port shows a dashed slot; no ETD shows a dashed track.
const stripDay = v => { const s = String(v || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN; };
const stripDays = (a, b) => { const x = stripDay(a), y = stripDay(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 864e5) : null; };
const STRIP_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const stripFmt = v => { const s = String(v || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)} ${STRIP_MON[+s.slice(5, 7) - 1]}` : "not set"; };
const StripPort = ({ code, name, line, right, missing }) => (
  <div style={{ textAlign: right ? "right" : "left", minWidth: 0 }}>
    {code ? <div style={{ fontFamily: HZ_DISPLAY, fontWeight: 800, fontSize: 22, lineHeight: 1, letterSpacing: ".01em", color: HZ.text }}>{code}</div>
      : <span style={{ display: "inline-block", fontFamily: HZ_DISPLAY, fontWeight: 800, fontSize: 18, lineHeight: 1, color: HZ.textFaint, border: `1.5px dashed ${HZ.borderStrong}`, borderRadius: 8, padding: "3px 10px" }}>{missing}</span>}
    {name && <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>}
    {/* The date on a line of its own: a long port name may be cut short, the ETD/ATD or ETA/ATA never. */}
    <div style={{ fontFamily: HZ_MONO, fontSize: 10.5, fontWeight: 600, color: HZ.text, marginTop: name ? 2 : 4, whiteSpace: "nowrap" }}>{line}</div>
  </div>
);
// The shipment's ETD is its first sea leg's and its ETA its last sea leg's (server.js syncShipmentFromLegs);
// either reads ATD/ATA once that leg's date is an actual (AIS or a DCSA event, legChain.js ACTUAL_SOURCES).
// The DG class sits beside the route with its meaning underneath; the containers ("2×40HC") end the row, the TEU under them.
const RouteStrip = ({ shipment, legs, ctrs, teu, dgClasses, dgMeaning, isDg }) => {
  const today = new Date().toISOString().slice(0, 10);
  const sea = legs.filter(l => (l.legType || "SEA") === "SEA");
  const atd = ACTUAL_SOURCES.has(sea[0]?.etdSource), ata = ACTUAL_SOURCES.has(sea[sea.length - 1]?.etaSource);
  const typeKeys = [...new Set(ctrs.map(c => `${c.size}${c.type}`))];
  // The user's format (3 Sep): "6x40HC" when every container is one type, "6 containers" when they differ.
  const ctrValue = !ctrs.length ? "—" : typeKeys.length === 1 ? `${ctrs.length}×${typeKeys[0]}` : `${ctrs.length} containers`;
  // Under the track (the user, 15 Sep): the transshipment ports and the transit time.
  const hubs = sea.slice(0, -1).map(l => l.pod).filter(Boolean);
  const dep = shipment.etd ? stripDays(shipment.etd, today) : null;
  const tot = shipment.etd && shipment.eta ? stripDays(shipment.etd, shipment.eta) : null;
  const moving = dep != null && dep >= 0 && tot;
  const pr = moving ? Math.max(0, Math.min(100, Math.round((dep / tot) * 100))) : 0;
  const label = !shipment.pol && !shipment.pod ? "No route yet" : !shipment.etd ? "No sailing yet"
    : dep < 0 ? `ETD in ${-dep} day${dep === -1 ? "" : "s"}` : tot && dep >= tot ? "Arrived" : `Day ${dep} of ${tot ?? "?"}`;
  const etaIn = shipment.eta ? stripDays(today, shipment.eta) : null;
  const numStyle = { fontFamily: HZ_DISPLAY, fontWeight: 700, fontSize: 22, lineHeight: 1.1, letterSpacing: "-.02em", color: HZ.text, textAlign: "right" };
  const capStyle = { fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted, textAlign: "right" };
  return (
    <div id="shphdr-route" data-testid="shipment-detail-header-route" style={{ flex: "1 1 420px", minWidth: 320, display: "flex", alignItems: "center", gap: 20, paddingBottom: tot != null ? 12 : 0 }}>
      <div style={{ flex: 1, minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, auto) minmax(90px, 1fr) minmax(0, auto)", gap: 14, alignItems: "center" }}>
        <StripPort code={shipment.pol} name={shipment.polName} line={`${atd ? "ATD" : "ETD"} ${stripFmt(shipment.etd)}`} missing="POL" />
        <div data-testid="shipment-detail-header-route-track" style={{ position: "relative", height: 3, borderRadius: 3,
          background: shipment.etd ? HZ.neutralBg : `repeating-linear-gradient(90deg, ${HZ.borderStrong} 0 6px, transparent 6px 11px)` }}>
          {moving && <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pr}%`, borderRadius: 3, background: `linear-gradient(90deg, ${HZ.cyan}, ${HZ.cyan2})`, boxShadow: `0 0 12px ${HZ.glow}` }} />}
          {moving && <div style={{ position: "absolute", top: "50%", left: `${pr}%`, width: 11, height: 11, borderRadius: "50%", background: HZ.chipText, border: `2px solid ${HZ.cyan}`, transform: "translate(-50%, -50%)", boxShadow: `0 0 12px ${HZ.glow}` }} />}
          <span style={{ position: "absolute", top: 9, left: moving ? `${Math.max(22, Math.min(78, pr))}%` : "50%", transform: "translateX(-50%)", fontFamily: HZ_MONO, fontSize: 10, fontWeight: 600, color: HZ.textMuted, whiteSpace: "nowrap" }}>{label}</span>
          {tot != null && (
            <span data-testid="shipment-detail-header-route-via" style={{ position: "absolute", top: 23, left: "50%", transform: "translateX(-50%)", fontFamily: HZ_MONO, fontSize: 10, fontWeight: 600, color: HZ.text, whiteSpace: "nowrap" }}>
              {hubs.length ? `via ${hubs.join(", ")}` : "Direct"} · {tot} day{tot === 1 ? "" : "s"} transit
            </span>
          )}
        </div>
        <StripPort right code={shipment.pod} name={shipment.podName} line={`${ata ? "ATA" : "ETA"} ${stripFmt(shipment.eta)}`} missing="POD" />
      </div>
      {isDg && (
        // The DG class beside the route, with what it means underneath (the user, 15 Sep).
        <div id="shphdr-dg-badge" data-testid="shipment-detail-header-dg-badge" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}
          title={`Dangerous goods${dgClasses.length ? `, class ${dgClasses.join(", ")}` : ""}${dgMeaning ? `: ${dgMeaning}` : ""}`}>
          <span style={{ fontFamily: HZ_MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.03em", lineHeight: 1.2,
            padding: "3px 9px", borderRadius: 999, background: HZ.critBg, color: HZ.crit, border: `1px solid ${HZ.crit}44`,
            whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <IconWarning size={11} />DG{dgClasses.length ? ` · CLASS ${dgClasses.join("/")}` : ""}
          </span>
          {dgMeaning && <span style={{ fontFamily: HZ_BODY, fontSize: 10, color: HZ.textMuted, paddingLeft: 2 }}>{dgMeaning}</span>}
        </div>
      )}
      <div style={{ display: "flex", gap: 18 }}>
        <div><div style={numStyle}>{etaIn != null && etaIn >= 0 ? etaIn : "—"}{etaIn != null && etaIn >= 0 && <small style={{ fontFamily: HZ_BODY, fontSize: 12, fontWeight: 600, color: HZ.textMuted, marginLeft: 4, letterSpacing: 0 }}>{etaIn === 1 ? "day" : "days"}</small>}</div><div style={capStyle}>to {ata ? "ATA" : "ETA"}</div></div>
        <div data-testid="shipment-detail-header-containers">
          <div style={numStyle}>{ctrValue}</div>
          <div style={capStyle}>{ctrs.length ? `${teu} TEU` : "containers"}</div>
        </div>
      </div>
    </div>
  );
};

// horizonNext: the Trade Horizon next header (route strip, the user's facts and order) — App.jsx passes it on Contracts &
// Schedules only; the user's decision 2026-11-06: "until we get everything in the correct shape, we keep it in the
// contracts and schedules, then we can convert the object into a global one".
const ShipmentHeaderBar = ({ shipment, containers = [], onNavigateToSchedules, onNavigateToParties, onUpdate, onRefresh, onEdit, horizonNext = false }) => {
  // Minimized by default (direct request) — resets to minimized on every new shipment rather
  // than persisting a preference, so "minimized by default" holds for every shipment visited,
  // not just the first one. Stays whatever the operator leaves it at while navigating between
  // this same shipment's own sub-pages, since this component is mounted once per shipment and
  // never remounts on that kind of navigation (see the file-level comment above).
  const [folded, setFolded] = useState(true);
  const [loopModalOpen, setLoopModalOpen] = useState(false);
  useEffect(() => { setFolded(true); }, [shipment.id]);
  const { canEditShipments: canEdit, shipmentLock } = useAuth();
  const [schedules, setSchedules] = useState([]);
  const [screening, setScreening] = useState(null);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [pendingMatches, setPendingMatches] = useState(null);
  const [lineAgentCandidates, setLineAgentCandidates] = useState(null);
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

  // Extracted into callbacks (not just an inline effect) so the legsScheduleBus listener below
  // can re-trigger the same fetch on demand — same shape as loadCargoValue/cargoValueBus.
  const loadSchedules = useCallback(() => {
    api.schedules.list(shipment.id).then(rows => setSchedules(rows || [])).catch(() => {});
  }, [shipment.id]);
  const loadLegs = useCallback(() => {
    api.legs.list(shipment.id).then(rows => setLegs(rows || [])).catch(() => {});
  }, [shipment.id]);

  useEffect(() => { loadSchedules(); }, [loadSchedules]);
  useEffect(() => { loadLegs(); }, [loadLegs]);
  // Without this, a schedule/leg removed elsewhere on the page (Contracts & Schedules' own
  // "Remove leg" cascade) left this header showing the stale routing pill, loop code, and
  // POL/POD forever — this component self-fetches legs/schedules once per shipment.id and had
  // no way to notice a later mutation short of a full remount. Found live: SHP-8C7JZW.
  useEffect(() => onLegsScheduleChanged(id => {
    if (id === shipment.id) { loadSchedules(); loadLegs(); }
  }), [shipment.id, loadSchedules, loadLegs]);

  useEffect(() => {
    let live = true;
    api.screening.get(shipment.id).then(s => { if (live) setScreening(s); }).catch(() => {});
    return () => { live = false; };
  }, [shipment.id]);

  // shipment.pol/pod are the journey's overall door-to-door bookends — with a Door pickup
  // leg or a multi-leg (TSP) journey, that's not the same as the actual SEA leg(s)' own
  // pol/pod, and a contract is always matched port-to-port against the real ocean leg.
  const seaLegs = legs.filter(l => l.legType === "SEA");
  const matchPol = seaLegs[0]?.pol || shipment.pol || "";
  const matchPod = seaLegs[seaLegs.length - 1]?.pod || shipment.pod || "";
  const haulage = deriveHaulageNeeds(legs);

  // Silent revalidation: a Central contract was matched against POL/POD (and haulage coverage,
  // and validity window) at the time it was picked, but nothing re-checks it if the route
  // changes or the contract simply expires afterward — same class of gap the Pending-contract
  // check right below covers for Pending shipments. Shared with ShipmentSchedulesPage's own
  // mismatch banner via useContractMismatch so the two can't drift on what counts as a mismatch.
  const contractMismatch = useContractMismatch(shipment, matchPol, matchPod, legs);

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

  // Line Agent ambiguity: same badge-now/modal-later split as Pending Revalidation above, for the
  // same reason (this component remounts on every sub-page nav — a dismissible modal here would
  // re-interrupt the user right after they dismissed it a page ago). The actual picker lives on
  // the Parties & Offices page instead, which independently re-checks on its own mount.
  useEffect(() => {
    let live = true;
    api.shipments.lineAgentCandidates(shipment.id)
      .then(r => { if (live) setLineAgentCandidates((r?.export?.length || r?.import?.length) ? r : null); })
      .catch(() => { if (live) setLineAgentCandidates(null); });
    return () => { live = false; };
  }, [shipment.id]);

  const ctrs = containers.filter(c => c.shipmentId === shipment.id);
  const teu = ctrs.reduce((n, c) => n + (c.size === "40" || c.size === "45" ? 2 : 1), 0);
  const dgClasses = [...new Set(ctrs.filter(c => c.isDg).map(c => c.dgClass).filter(Boolean))];
  const isDg = ctrs.some(c => c.isDg);
  // Short "what this actually means" caption for the header's DG badge — real IMDG_CLASSES
  // `name` data (tokens.js), not invented copy. That field's format isn't consistent across
  // classes (some are "Category — Detail", e.g. "Gases — Flammable Gas"; others are bare, e.g.
  // "Flammable Liquids" for class 3) so it's used whole rather than split on a dash that isn't
  // always there. A shipment can carry more than one class; only the first is captioned to keep
  // the header glanceable, same trade-off the mockup's own single-class example made.
  const dgMeaning = dgClasses.length
    ? IMDG_CLASSES.find(c => c.code === dgClasses[0])?.name
    : null;
  const loopCode = deriveLoopCode(schedules[0]);

  // Cargo value rollup (Epic TKT-P3ASH1, Story TKT-NSTDKF) — sum of quantity x unitValueUsd
  // across every container's pack items, USD-normalized at write time (no live FX call here).
  // Same per-container-fetch cost profile ShipmentContainersPage.jsx already pays. This header
  // is persistent (mounted once in App.jsx, never remounts on navigation), so the ctrIds-keyed
  // effect below only re-fires when the shipment's own set of containers changes — it would
  // never notice a pack item being priced/repriced on an already-known container. cargoValueBus
  // (cousin-component signal, same shape as servicesBus.js) closes that gap: ShipmentContainers
  // Page emits after every package save/delete, and the second effect below refetches on that
  // signal too, independent of ctrIds.
  const [cargoValueUsd, setCargoValueUsd] = useState(null);
  const ctrIds = ctrs.map(c => c.id).join(",");
  const loadCargoValue = useCallback(() => {
    if (!ctrIds) { setCargoValueUsd(null); return; }
    Promise.all(ctrIds.split(",").map(id => api.containerPackages.list(shipment.id, id).catch(() => [])))
      .then(lists => {
        const priced = lists.flat().filter(p => p.unitValueUsd != null);
        setCargoValueUsd(priced.length ? priced.reduce((s, p) => s + p.unitValueUsd * p.quantity, 0) : null);
      });
  }, [ctrIds]);
  useEffect(() => { loadCargoValue(); }, [loadCargoValue]);
  useEffect(() => onCargoValueChanged(id => { if (id === shipment.id) loadCargoValue(); }), [shipment.id, loadCargoValue]);

  const copyId = () => {
    navigator.clipboard.writeText(shipment.id)
      .then(() => toast.success(`Copied ${shipment.id}`))
      .catch(() => toast.error("Could not copy to clipboard"));
  };

  useHorizonFonts();

  return (
    <>
    <div id="shphdr" style={{
      background: HZ.surface, backdropFilter: "blur(22px)", border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 16,
      padding: "14px 22px", marginBottom: 22, position: "sticky", top: 0, zIndex: 5,
    }}>
      {horizonNext && <div aria-hidden style={{ position: "absolute", left: 18, right: 18, top: 0, height: 2, background: HZ.edge, boxShadow: `0 0 22px 2px ${HZ.glow}`, pointerEvents: "none" }} />}
      {/* Row 1 — identity, route, dates, DG */}
      <div id="shphdr-row1" data-testid="shipment-detail-header-row1" style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <span id="shphdr-id" data-testid="shipment-detail-header-id" style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontFamily: HZ_MONO, fontWeight: 700, fontSize: 17, color: HZ.text,
            letterSpacing: "0.01em" }}>{shipment.id}</span>
          <button id="shphdr-copy-id-btn" data-testid="shipment-detail-header-copy-id-btn" type="button" onClick={copyId} title="Copy shipment ID"
            style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 3px",
              display: "flex", alignItems: "center", fontSize: 12, lineHeight: 1, color: HZ.textMuted }}
            onMouseEnter={e => { e.currentTarget.style.color = HZ.cyan; }}
            onMouseLeave={e => { e.currentTarget.style.color = HZ.textMuted; }}>
            <IconClipboard size={12} />
          </button>
        </span>
        <span id="shphdr-movement-type" data-testid="shipment-detail-header-movement-type" style={{ fontFamily: HZ_MONO, fontSize: 10.8, fontWeight: 700, letterSpacing: "0.03em",
          padding: "3px 9px", borderRadius: 6, background: HZ.cyanBg, color: HZ.cyan,
          border: `1px solid ${HZ.cyan}66` }}>{shipment.movementType || "FCL"}</span>

        {(() => {
          const r = screening?.result;
          const isHit = r === "HIT";
          const overridden = screening?.overriddenAt;
          const bg = !r ? HZ.neutralBg : isHit ? HZ.critBg : HZ.goodBg;
          const color = !r ? HZ.textMuted : isHit ? HZ.crit : HZ.good;
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
            <button id="shphdr-compliance-btn" data-testid="shipment-detail-header-compliance-btn" type="button" onClick={() => setComplianceOpen(true)}
              title={tooltipText}
              style={{ fontFamily: HZ_MONO, fontSize: 10.8, fontWeight: 700, cursor: "pointer",
                borderRadius: 6, padding: "3px 9px", letterSpacing: "0.03em", whiteSpace: "nowrap",
                border: `1px solid ${!r ? HZ.border : isHit ? `${HZ.crit}44` : `${HZ.good}44`}`,
                background: bg, color }}>
              {label}
            </button>
          );
        })()}

        <div style={{ width: 1, alignSelf: "stretch", background: HZ.border }} />

        {horizonNext ? <RouteStrip shipment={shipment} legs={legs} ctrs={ctrs} teu={teu} dgClasses={dgClasses} dgMeaning={dgMeaning} isDg={isDg} /> : (<>
        <div id="shphdr-route" data-testid="shipment-detail-header-route" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontFamily: HZ_MONO, fontWeight: 700, fontSize: 15, color: HZ.text }}>{shipment.pol || "—"}</span>
            <span style={{ fontFamily: HZ_BODY, fontSize: 10.5, color: HZ.textMuted }}>{shipment.polName || ""}</span>
            <span style={{ fontFamily: HZ_MONO, fontSize: 9.5, color: HZ.textFaint, marginTop: 2 }}>ETD {shipment.etd || "—"}</span>
          </div>
          <span style={{ color: HZ.textMuted }}>→</span>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontFamily: HZ_MONO, fontWeight: 700, fontSize: 15, color: HZ.text }}>{shipment.pod || "—"}</span>
            <span style={{ fontFamily: HZ_BODY, fontSize: 10.5, color: HZ.textMuted }}>{shipment.podName || ""}</span>
            <span style={{ fontFamily: HZ_MONO, fontSize: 9.5, color: HZ.textFaint, marginTop: 2 }}>ETA {shipment.eta || "—"}</span>
          </div>
        </div>

        {isDg && (
          <>
            <div style={{ width: 1, alignSelf: "stretch", background: HZ.border }} />
            <div id="shphdr-dg-badge" data-testid="shipment-detail-header-dg-badge" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
              <span style={{ fontFamily: HZ_MONO, fontSize: 10.8, fontWeight: 700, letterSpacing: "0.03em",
                padding: "3px 9px", borderRadius: 6, background: HZ.critBg, color: HZ.crit,
                border: `1px solid ${HZ.crit}44`, whiteSpace: "nowrap",
                display: "inline-flex", alignItems: "center", gap: 4 }}>
                <IconWarning size={11} />DG{dgClasses.length ? ` · CLASS ${dgClasses.join("/")}` : ""}
              </span>
              {dgMeaning && <span style={{ fontFamily: HZ_BODY, fontSize: 9.5, color: HZ.textFaint, paddingLeft: 1 }}>{dgMeaning}</span>}
            </div>
          </>
        )}
        </>)}

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
          ...(canEdit && !isShipmentLocked(shipment) ? [{ key: "edit", icon: IconPencil, title: "Edit Shipment", onClick: () => onEdit?.() }] : []),
        ]} />

        <button id="shphdr-fold-toggle" data-testid="shipment-detail-header-fold-toggle" type="button" onClick={() => setFolded(f => !f)}
          title={folded ? "Expand shipment info" : "Minimize shipment info"}
          style={{ fontFamily: HZ_MONO, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.04em",
            color: HZ.textMuted, background: "none", border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow,
            borderRadius: 7, padding: "5px 9px", cursor: "pointer",
            display: "inline-flex", alignItems: "center", gap: 5 }}
          onMouseEnter={e => { e.currentTarget.style.color = HZ.text; e.currentTarget.style.borderColor = HZ.cyan; }}
          onMouseLeave={e => { e.currentTarget.style.color = HZ.textMuted; e.currentTarget.style.borderColor = HZ.border; }}>
          {folded ? <IconArrowDown size={11} /> : <IconArrowUp size={11} />}
          {folded ? "Expand" : "Minimize"}
        </button>

        {contractMismatch && (
          <button id="shphdr-contract-mismatch-badge" data-testid="shipment-detail-header-contract-mismatch-badge" type="button" onClick={onNavigateToSchedules}
            title={`${shipment.contractRef || "The attached contract"} no longer covers ${matchPol} → ${matchPod} — click to resolve`}
            style={{ fontFamily: HZ_MONO, fontSize: 10.8, fontWeight: 700, letterSpacing: "0.03em",
              padding: "3px 9px", borderRadius: 6, background: HZ.critBg, color: HZ.crit,
              border: `1px solid ${HZ.crit}44`, whiteSpace: "nowrap", cursor: onNavigateToSchedules ? "pointer" : "default",
              display: "inline-flex", alignItems: "center", gap: 4 }}>
            <IconWarning size={11} />Contract Mismatch
          </button>
        )}

        {/* Space consumption badge (2026-09 Space Configuration spec, gap #1/#2 — this was fully
            computed and broadcast live over WebSocket already, just never rendered anywhere).
            'exceeded' = this shipment's own TEU pushes its linked allocation over capacity;
            'warning' = not over on its own, but an overage reason is already on file for it. */}
        {(shipment.spaceBadge === "exceeded" || shipment.spaceBadge === "warning") && (
          <button id="shphdr-space-badge" data-testid="shipment-detail-header-space-badge" type="button" onClick={onNavigateToSchedules}
            title={shipment.spaceBadge === "exceeded"
              ? "This shipment's containers push its linked space configuration over its committed capacity — click to review"
              : "This shipment was linked despite a space overage, with a reason already on file — click to review"}
            style={{ fontFamily: HZ_MONO, fontSize: 10.8, fontWeight: 700, letterSpacing: "0.03em",
              padding: "3px 9px", borderRadius: 6,
              background: shipment.spaceBadge === "exceeded" ? HZ.critBg : HZ.warnBg,
              color: shipment.spaceBadge === "exceeded" ? HZ.crit : HZ.warn,
              border: `1px solid ${(shipment.spaceBadge === "exceeded" ? HZ.crit : HZ.warn)}44`,
              whiteSpace: "nowrap", cursor: onNavigateToSchedules ? "pointer" : "default",
              display: "inline-flex", alignItems: "center", gap: 4 }}>
            <IconWarning size={11} />{shipment.spaceBadge === "exceeded" ? "Space Exceeded" : "Space Warning"}
          </button>
        )}

        {pendingMatches && (
          <button id="shphdr-contract-match-badge" data-testid="shipment-detail-header-contract-match-badge" type="button" onClick={onNavigateToSchedules}
            title={`${pendingMatches.length} active contract${pendingMatches.length !== 1 ? "s" : ""} match${pendingMatches.length === 1 ? "es" : ""} "${shipment.contractRef}" — click to review`}
            style={{ fontFamily: HZ_MONO, fontSize: 10.8, fontWeight: 700, letterSpacing: "0.03em",
              padding: "3px 9px", borderRadius: 6, background: HZ.infoBg, color: HZ.infoPillText,
              border: `1px solid ${HZ.info}44`, whiteSpace: "nowrap", cursor: onNavigateToSchedules ? "pointer" : "default",
              display: "inline-flex", alignItems: "center", gap: 4 }}>
            <IconRefresh size={11} />Contract Match Found
          </button>
        )}

        {lineAgentCandidates && (() => {
          const count = (lineAgentCandidates.export?.length || 0) + (lineAgentCandidates.import?.length || 0);
          return (
            <button id="shphdr-line-agent-candidates-badge" data-testid="shipment-detail-header-line-agent-candidates-badge" type="button" onClick={onNavigateToParties}
              title={`${count} Line Agent candidate${count !== 1 ? "s" : ""} found — click to pick which one to assign`}
              style={{ fontFamily: HZ_MONO, fontSize: 10.8, fontWeight: 700, letterSpacing: "0.03em",
                padding: "3px 9px", borderRadius: 6, background: HZ.infoBg, color: HZ.infoPillText,
                border: `1px solid ${HZ.info}44`, whiteSpace: "nowrap", cursor: onNavigateToParties ? "pointer" : "default",
                display: "inline-flex", alignItems: "center", gap: 4 }}>
              <IconGroup size={11} />Line Agent Picks Needed
            </button>
          );
        })()}

        {isShipmentLocked(shipment) && (
          <span id="shphdr-status-lock-badge" data-testid="shipment-detail-header-status-lock-badge"
            title={`${shipment.status}: the shipment's details are locked. Finance, documents, messages and milestones stay open.`}
            style={{ fontFamily: HZ_MONO, fontSize: 10.8, fontWeight: 700, letterSpacing: "0.03em",
            padding: "3px 9px", borderRadius: 6, background: shipment.status === "Cancelled" ? HZ.critBg : HZ.infoBg,
            color: shipment.status === "Cancelled" ? HZ.crit : HZ.infoPillText,
            border: `1px solid ${shipment.status === "Cancelled" ? HZ.crit : HZ.info}44`, whiteSpace: "nowrap",
            display: "inline-flex", alignItems: "center", gap: 4 }}>
            <IconLock size={11} />{shipment.status} · locked
          </span>
        )}

        {shipmentLock?.locked && !shipmentLock?.ownedByMe && (
          <span id="shphdr-lock-badge" data-testid="shipment-detail-header-lock-badge" title={`${shipmentLock.lockedByName} is currently editing this shipment — you have read-only access until they finish (releases automatically after 30 minutes of inactivity)`}
            style={{ fontFamily: HZ_MONO, fontSize: 10.8, fontWeight: 700, letterSpacing: "0.03em",
            padding: "3px 9px", borderRadius: 6, background: HZ.infoBg, color: HZ.infoPillText,
            border: `1px solid ${HZ.info}44`, whiteSpace: "nowrap",
            display: "inline-flex", alignItems: "center", gap: 4 }}>
            <IconLock size={11} />Locked by {shipmentLock.lockedByName}
          </span>
        )}
      </div>

      {folded ? (
        // Minimized (default) state — Row 1 above stays exactly as-is; everything below
        // collapses to the one chip row instead of the full Row 2 + route pill.
        horizonNext ? <ChipRow shipment={shipment} loopCode={loopCode} openTicketCount={openTicketCount} />
          : <ChipRowClassic shipment={shipment} ctrs={ctrs} cargoValueUsd={cargoValueUsd} openTicketCount={openTicketCount} />
      ) : (
        <>
          {/* Row 2 — secondary facts */}
          <div id="shphdr-row2" data-testid="shipment-detail-header-row2" style={{ display: "flex", flexWrap: "wrap", rowGap: 8,
            marginTop: 11, paddingTop: 11, borderTop: `1px solid ${HZ.border}` }}>
            {horizonNext ? (<>
            {/* Same order as the folded row: the parties, the Incoterm, then the sailing (carrier code, main vessel, voyage,
                service); no contract in the header (it has its card). The containers, TEU and DG are on row 1. */}
            <Field first label="Principal" value={shipment.principalName} />
            <Field label="Shipper" value={shipment.shipperName} />
            <Field label="Consignee" value={shipment.consigneeName} />
            <Field label="Incoterm" value={shipment.incoterm} />
            <Field label="Carrier" value={shipment.carrierCode} />
            <Field label="Vessel" value={shipment.vessel} />
            <Field label="Voyage" value={shipment.voyage} />
            <Field label="Service" value={loopCode} onClick={loopCode ? () => setLoopModalOpen(true) : undefined} />
            <Field label="Routing" value={shipment.routingTerm} />
            <Field label="Trade Lane" value={shipment.tradeLane} />
            <Field label="Cargo Value" value={cargoValueUsd != null ? fmtCurr(cargoValueUsd, "USD") : null} />
            </>) : (<>
            <Field first label="Incoterm" value={shipment.incoterm} />
            <Field label="Routing" value={shipment.routingTerm} />
            <Field label="Trade Lane" value={shipment.tradeLane} />
            <Field label="Vessel" value={shipment.vessel} />
            <Field label="Voyage" value={shipment.voyage} />
            <Field label="Shipper" value={shipment.shipperName} />
            <Field label="Consignee" value={shipment.consigneeName} />
            <Field label="Contract" value={shipment.contractRef} />
            <Field label="TEU" value={ctrs.length ? String(teu) : null} />
            <Field label="Cargo Value" value={cargoValueUsd != null ? fmtCurr(cargoValueUsd, "USD") : null} />
            <Field label="Loop" value={loopCode} onClick={loopCode ? () => setLoopModalOpen(true) : undefined} />
            </>)}
          </div>

          {/* Row 3 — the same route summary panel shown on the Schedules page (Pick-up/POL,
              ETD/transit/ETA/carrier/routing-term, POD/Delivery) — one visual for one concept
              instead of a second, different journey diagram. */}
          <div id="shphdr-row3" data-testid="shipment-detail-header-row3" style={{ marginTop: 11, paddingTop: 11, borderTop: `1px solid ${HZ.border}` }}>
            <RouteSummaryBar shipment={shipment} />
          </div>
        </>
      )}
    </div>

    {/* Every modal and drawer this header opens is rendered HERE, as a sibling of #shphdr — never inside it.
        #shphdr carries `backdrop-filter`, and a filtered element becomes the containing block for its
        `position: fixed` descendants. A modal rendered inside it was therefore laid out against the header
        card instead of the window: the overlay shrank to the card's box, the dialog was centred on that box
        and ran up off the top of the screen, and its × (and a drawer's whole edge) ended up unreachable —
        the Loop code's route modal could not be closed. Keep overlays out of any element that sets
        `backdrop-filter`, `filter` or `transform`. */}
      {complianceOpen && (
        <ComplianceModal
          shipment={shipment}
          screening={screening}
          onChange={s => setScreening(s)}
          onClose={() => setComplianceOpen(false)}
        />
      )}

      {contractMismatch && onUpdate && (
        <ContractMismatchModal shipment={shipment} pol={matchPol} pod={matchPod} haulage={haulage}
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

      {loopModalOpen && (
        <LoopRouteModal code={loopCode} polCode={shipment.pol} podCode={shipment.pod}
          onClose={() => setLoopModalOpen(false)} />
      )}
    </>
  );
};

export default ShipmentHeaderBar;
