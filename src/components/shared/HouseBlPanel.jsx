import { useState, useEffect, useCallback } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { useAuth } from "../../AuthContext";
import { HZ, HZ_MONO, HZ_BODY, useHorizonFonts } from "../../pages/shipments/shipmentDetailTheme";
import { buildHouseBlHtml, houseBlStatement, houseBlNumber } from "../../utils/houseBlDocument";

// ─── House B/L panel (Epic TKT-C7EBU3) ────────────────────────────────────────
// Top of the shipment's Documents page (approved mockups https://claude.ai/artifact/Tr9cyqXe31HqYTxy63ap7Z
// and https://claude.ai/artifact/CnuymDL2eUEnxnD8oDtj57). Reads GET /api/shipments/:id/house-bl
// (lib/house-bl.js) and drives the House B/L through its states: what blocks issue and where to fix it;
// what the copy says (on board or received for shipment, originals, copies, freight); issue, which takes
// the number from the office series first and prints the copy with it; then paper (the originals log,
// surrendered, release, the telex release notice) or eBL; corrections (surrender for amendment, then the
// next version under the same number); void with a reason. The documents list below shares `docs`: any
// change there reloads this panel, and this panel's changes call onChanged.

const fmtDay = d => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "");
const todayIso = () => new Date().toISOString().slice(0, 10);

// Where each readiness item (lib/house-bl.js readiness wording) is fixed.
export const fixPlaceOf = (item, shipmentId) => {
  const go = suffix => `#shipments/${shipmentId}/${suffix}`;
  if (/^(Shipper|Consignee)/.test(item)) return /address/.test(item) ? { label: "Customers", href: "#mdm-customers" } : { label: "Parties & Offices", href: go("parties") };
  if (/^Notify party/.test(item)) return { label: "Parties & Offices", href: go("parties") };
  if (/^Port of loading|^Vessel/.test(item)) return { label: "Contracts & Schedules", href: go("schedules") };
  if (/carrier booking/.test(item)) return { label: "Carrier Booking", href: go("booking/details") };
  if (/^Release type|^B\/L number|^A Sea Waybill can't be issued to order/.test(item)) return { label: "Conditions", href: go("conditions") };
  if (/AES/.test(item)) return { label: "Customs Filing", href: go("customs-filing/details") };
  if (/^Container|^At least one container/.test(item)) return { label: "Cargo", href: go("containers") };
  if (/^Loading/.test(item)) return { label: "Milestones & Events", href: go("milestones") };
  return null;
};

// 0 Draft · 1 Issued · 2 Surrendered · 3 Released
export const stageOf = td => (!td || td.status === "DRAFT" ? 0 : td.releasedAt ? 3 : td.status === "SURRENDERED_FOR_DELIVERY" ? 2 : 1);

const EVENT_TEXT = {
  MIGRATED: () => "Moved into the House B/L record",
  DRAFTED: d => (d.version > 1 ? `Version ${d.version} drafted` : "Draft generated"),
  REDRAFTED: () => "Draft regenerated",
  ISSUED: d => `${d.version > 1 ? `Version ${d.version} issued` : "Issued"}${d.shippedOnBoard === false ? ", received for shipment" : ", shipped on board"}${d.date ? ` ${fmtDay(d.date)}` : ""}`
    + (d.originals !== undefined ? ` · ${d.originals} original${d.originals === 1 ? "" : "s"}, ${d.copies || 0} cop${d.copies === 1 ? "y" : "ies"}` : ""),
  VOIDED: d => `Voided${d.reason ? `: ${d.reason}` : ""}`,
  SURRENDERED_FOR_DELIVERY: d => (d.kind === "destination" ? `Originals presented at destination${d.presentedBy ? ` by ${d.presentedBy}` : ""}`
    : d.kind === "platform" ? `eBL surrendered for delivery (SURR)${d.presentedBy ? ` by ${d.presentedBy}` : ""}` : "Surrendered at origin"),
  RELEASED: () => "Cargo released",
  RELEASED_WITH_OVERRIDE: d => `Released with an override${d.reason ? `: ${d.reason}` : ""}`,
  EBL_ISSUANCE_REQUESTED: d => `Sent to ${d.platform} as an eBL`,
  EBL_ISSUED: d => `${d.platform} issued the eBL (ISSU)`,
  EBL_ISSUANCE_REFUSED: d => `${d.platform} refused it (${d.code})${d.reason ? `: ${d.reason}` : ""}`,
  EBL_SURRENDER_FOR_DELIVERY_REQUESTED: () => "Surrender for delivery requested (SREQ)",
  EBL_SURRENDER_FOR_AMENDMENT_REQUESTED: () => "Surrender for amendment requested (AREQ)",
  EBL_SURRENDER_REJECTED: d => `Surrender rejected (SREJ)${d.comments ? `: ${d.comments}` : ""}`,
  SURRENDERED_FOR_AMENDMENT: d => `Surrendered for amendment${d.reason ? `: ${d.reason}` : ""}`,
  ORIGINALS_HANDED_OVER: d => `Originals handed over: ${d.count} of ${d.total} ${d.method === "In person" ? "in person" : `by ${String(d.method || "").toLowerCase()}`} to ${d.to}${d.trackingRef ? ` (${d.trackingRef})` : ""}`,
  TELEX_RELEASE_NOTICE: d => (d.sent ? `Telex release notice to ${d.office} (Kanban task)` : "Telex release: no import office on the shipment, nobody was told"),
};
export const eventText = e => (EVENT_TEXT[e.eventType] ? EVENT_TEXT[e.eventType](e.detail || {}) : e.eventType);

const card = () => ({ padding: "16px 18px", borderRadius: 10, background: HZ.surface, border: `1px solid ${HZ.border}`, display: "flex", flexDirection: "column", gap: 12 });
const box = () => ({ display: "flex", flexDirection: "column", gap: 8, padding: "11px 13px", borderRadius: 8, border: `1px solid ${HZ.borderStrong}` });
const inputStyle = () => ({ padding: "6px 8px", borderRadius: 6, border: `1px solid ${HZ.borderStrong}`, background: HZ.bg, color: HZ.text, fontFamily: HZ_BODY, fontSize: 12.5 });
const fieldLabel = () => ({ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: HZ.textMuted });
const chipStyle = (bg, fg, border) => ({ fontFamily: HZ_MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", padding: "3px 9px",
  borderRadius: 999, background: bg, color: fg, border: `1px solid ${border}`, whiteSpace: "nowrap" });

const statusChipOf = (td, amends) => {
  if (!td && amends) return { text: `AMENDING · v${amends.version + 1}`, style: chipStyle(HZ.warnBg, HZ.warn, HZ.warn + "66") };
  if (!td) return { text: "NONE YET", style: chipStyle(HZ.surface2, HZ.textMuted, HZ.borderStrong) };
  if (td.releasedAt) return { text: td.isElectronic ? "RELEASED · eBL" : "RELEASED", style: chipStyle(HZ.cyanBg, HZ.cyan, HZ.cyan + "66") };
  if (td.status === "DRAFT") return { text: amends ? `DRAFT · v${td.version}` : "DRAFT", style: chipStyle(HZ.surface2, HZ.textMuted, HZ.borderStrong) };
  if (td.status.startsWith("PENDING")) return { text: "SURRENDER ASKED", style: chipStyle(HZ.warnBg, HZ.warn, HZ.warn + "66") };
  if (td.status === "SURRENDERED_FOR_DELIVERY") return { text: "SURRENDERED", style: chipStyle(HZ.infoBg, HZ.info, HZ.info + "66") };
  return { text: td.isElectronic ? (td.eblIssuanceStatus === "PENDING" ? "eBL PENDING" : "ISSUED · eBL") : "ISSUED", style: chipStyle(HZ.goodBg, HZ.good, HZ.good + "66") };
};

const TO_ORDER_TEXT = { "": "Named", CONSIGNEE: "To order of the consignee", SHIPPER: "To order (of the shipper)" };

const Row = ({ label, children }) => (
  <>
    <dt style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted }}>{label}</dt>
    <dd style={{ margin: 0, fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text }}>{children}</dd>
  </>
);

// ─── Release dialog (gap G19) ─────────────────────────────────────────────────
const CHECKS = [
  { key: "originals", name: "Originals surrendered", ok: "Surrendered, or none to surrender" },
  { key: "collect_charges", name: "Collect charges paid", ok: "None open" },
  { key: "credit_hold", name: "Consignee not on credit hold", ok: "No hold" },
];
export const ReleaseCargoModal = ({ blocks = [], canOverride, onRelease, onClose }) => {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const blocked = blocks.length > 0;
  const go = async override => { setBusy(true); try { await onRelease(override ? { override: true, overrideReason: reason.trim() } : {}); } finally { setBusy(false); } };
  return (
    <Modal title="Release cargo" onClose={onClose} width={560} data-testid="house-bl-release-modal">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {CHECKS.map(c => {
            const b = blocks.find(x => x.key === c.key);
            return (
              <li key={c.key} data-testid={`house-bl-release-check-${c.key}`}
                style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "10px 12px", borderRadius: 8,
                  background: b ? HZ.critBg : HZ.goodBg, border: `1px solid ${(b ? HZ.crit : HZ.good) + "55"}` }}>
                <span style={chipStyle("transparent", b ? HZ.crit : HZ.good, (b ? HZ.crit : HZ.good) + "66")}>{b ? "BLOCKS" : "OK"}</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <b style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.text }}>{c.name}</b>
                  <span style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted }}>{b ? b.message : c.ok}</span>
                </div>
              </li>
            );
          })}
        </ul>
        {blocked && canOverride && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", borderRadius: 8, background: HZ.warnBg, border: `1px solid ${HZ.warn}55` }}>
            <b style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.text }}>Override, finance only</b>
            <span style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted }}>The reason and the checks it overrode go on the House B/L's history.</span>
            <label htmlFor="house-bl-override-reason" style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted }}>Reason</label>
            <textarea id="house-bl-override-reason" rows={3} value={reason} onChange={e => setReason(e.target.value)}
              placeholder="e.g. Consignee paid by wire, confirmed with the bank"
              style={{ padding: "8px 10px", borderRadius: 7, border: `1px solid ${HZ.borderStrong}`, background: HZ.bg, color: HZ.text, fontFamily: HZ_BODY, fontSize: 13, resize: "vertical" }} />
          </div>
        )}
        {blocked && !canOverride && (
          <span style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted }}>An admin or a user with finance access can override these checks.</span>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          {blocked && canOverride && (
            <Btn variant="danger" data-testid="house-bl-release-override" disabled={busy || !reason.trim()} onClick={() => go(true)}>Release with override</Btn>
          )}
          <Btn data-testid="house-bl-release-confirm" disabled={busy || blocked} onClick={() => go(false)}>Release cargo</Btn>
        </div>
        <span style={{ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted }}>Releasing completes Cargo Released and unlocks the Delivery Order.</span>
      </div>
    </Modal>
  );
};

const VoidModal = ({ onVoid, onClose }) => {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Void the House B/L" onClose={onClose} width={480} data-testid="house-bl-void-modal">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>It stays on record, marked Voided, and a new House B/L can then be issued. A number from the office series is not used again.</span>
        <label htmlFor="house-bl-void-reason" style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted }}>Reason</label>
        <textarea id="house-bl-void-reason" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Consignee address wrong"
          style={{ padding: "8px 10px", borderRadius: 7, border: `1px solid ${HZ.borderStrong}`, background: HZ.bg, color: HZ.text, fontFamily: HZ_BODY, fontSize: 13, resize: "vertical" }} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn variant="danger" data-testid="house-bl-void-confirm" disabled={busy || !reason.trim()}
            onClick={async () => { setBusy(true); try { await onVoid(reason.trim()); } finally { setBusy(false); } }}>Void</Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── The panel ────────────────────────────────────────────────────────────────
const HouseBlPanel = ({ shipment, canEdit, docs = [], onChanged }) => {
  useHorizonFonts();
  const { user, isAdmin } = useAuth();
  const [summary, setSummary] = useState(null);
  const [events,  setEvents]  = useState([]);
  const [choice,  setChoice]  = useState(null);
  const [typed,   setTyped]   = useState("");
  const [counts,  setCounts]  = useState(null);
  const [busy,    setBusy]    = useState(null);
  const [eblOpen, setEblOpen] = useState(false);
  const [platform, setPlatform] = useState("WAVE");
  const [partyCode, setPartyCode] = useState("");
  const [voidOpen, setVoidOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendReason, setAmendReason] = useState("");
  const [handover, setHandover] = useState(null);
  const [presentedBy, setPresentedBy] = useState("");
  const docsKey = docs.filter(d => d.docType === "BL01").map(d => `${d.id}:${d.status}:${d.blSurrenderedAt || ""}:${d.blReleasedAt || ""}`).join("|");

  const load = useCallback(async () => {
    const s = await api.houseBl.get(shipment.id).catch(() => null);
    setSummary(s);
    // While an amendment is pending, the history shown is the version it replaces.
    const td = s?.live || s?.draft || s?.amends || null;
    setEvents(td ? await api.houseBl.events(shipment.id, td.id).catch(() => []) : []);
    // The statement follows the loading facts, set from the first summary that arrives (a failed fetch
    // must not pin it); after that it's the user's choice.
    if (s) setChoice(c => c ?? (s.onBoard?.shippedOnBoard ? "onboard" : "received"));
  }, [shipment.id]);
  useEffect(() => { load(); }, [load, docsKey]);
  // Originals, copies and charges start from the draft, else the version an amendment replaces, else the
  // release type's usual; they start again when that changes (a new draft, a surrender for amendment).
  const basis = summary ? (summary.draft || summary.amends || null) : null;
  const basisKey = summary ? (basis?.id || "new") : null;
  useEffect(() => {
    if (basisKey === null) return;
    setCounts({ originals: basis?.originals ?? (shipment.blReleaseType === "Seaway Bill" ? 0 : 3), copies: basis?.copies ?? 0, withCharges: !!basis?.withCharges });
  }, [basisKey]);

  const live = summary?.live || null, draft = summary?.draft || null, amends = summary?.amends || null;
  const td = live || draft;
  // The platform answers in its own time (Test Tools plays it): look again while something waits on it.
  const waiting = !!live && (live.eblIssuanceStatus === "PENDING" || live.status.startsWith("PENDING_SURRENDER"));
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => { load(); onChanged?.(); }, 4000);
    return () => clearInterval(t);
  }, [waiting, load]);

  if (!summary || !counts) return null;

  const stage = stageOf(live || draft);
  const chip = statusChipOf(live || draft, amends);
  const facts = summary.onBoard || {};
  const swb = shipment.blReleaseType === "Seaway Bill";
  const statement = houseBlStatement(choice, facts, typed, { ...counts, originals: swb ? 0 : counts.originals });
  const statementOk = choice === "received" || !!typed || !!facts.shippedOnBoard;
  // The server's loading item judges the current draft; the copy about to be made follows `choice`.
  const missing = (summary.readiness?.missing || []).filter(m => !(statementOk && /^Loading/.test(m)));
  const countsOk = swb ? true : Number.isInteger(Number(counts.originals)) && counts.originals >= 1 && counts.originals <= 9;
  const ready = !live && missing.length === 0 && statementOk && countsOk;
  const canOverride = isAdmin || !!user?.canViewFinance;
  const releaseType = live?.releaseType || shipment.blReleaseType || "";
  const eblShipperId = summary.ebl?.shipperPlatformIds?.find(i => i.platform === platform)?.code || "";
  const number = summary.readiness?.number || null;
  const nextVersion = amends ? amends.version + 1 : null;
  const handovers = events.filter(e => e.eventType === "ORIGINALS_HANDED_OVER");
  const telex = events.filter(e => e.eventType === "TELEX_RELEASE_NOTICE").slice(-1)[0] || null;
  const changed = summary.changedSinceIssue || [];
  const versions = (summary.documents || []).filter(d => (live || amends || draft) && d.reference && d.reference === (live || amends || draft).reference && d.status !== "VOIDED")
    .sort((a, b) => a.version - b.version);

  const act = async (key, fn, done) => {
    setBusy(key);
    try { await fn(); if (done) toast.success(done); await load(); onChanged?.(); }
    catch (ex) { toast.error(ex.message); await load(); onChanged?.(); }
    finally { setBusy(null); }
  };
  const build = async docNum => {
    const built = await buildHouseBlHtml(shipment, { docNum, docDate: todayIso(), statement, summary, signatory: user?.name || user?.email || "" });
    if (built.missing) throw new Error(`Missing: ${built.missing.join(", ")}`);
    return api.documents.generate(shipment.id, { html: built.html, filename: built.filename, docType: "BL01", houseBl: built.houseBl });
  };
  const generateDraft = () => act("draft", () => build(houseBlNumber(shipment, summary)), "House B/L draft saved to Documents");
  // Issue takes the number first (the office series, gap G5) so the copy it prints carries it.
  const issue = () => act("issue", async () => {
    const { number: n } = await api.houseBl.number(shipment.id);
    const doc = await build(n);
    await api.documents.patch(shipment.id, doc.id, { status: "confirmed" });
  }, nextVersion ? `Version ${nextVersion} issued` : "House B/L issued");
  const surrender = () => act("surrender", () => api.documents.blSurrender(shipment.id, live.documentId,
    releaseType === "Original" && presentedBy.trim() ? { presentedBy: presentedBy.trim() } : {}),
    releaseType === "Original" ? "Originals recorded as presented" : "Recorded as surrendered at origin");
  const release = data => act("release", async () => {
    await api.documents.blRelease(shipment.id, live.documentId, data);
    setReleaseOpen(false);
  }, "Cargo released");
  const voidIt = reason => act("void", async () => {
    await api.documents.patch(shipment.id, live.documentId, { status: "voided", voidReason: reason });
    setVoidOpen(false);
  }, "House B/L voided");
  const sendEbl = () => act("ebl", async () => {
    await api.houseBl.issueEbl(shipment.id, { platform, ...(partyCode.trim() && { partyCode: partyCode.trim() }) });
    setEblOpen(false);
  }, `Sent to ${platform}`);
  const surrenderForAmendment = () => act("amend", async () => {
    await api.houseBl.surrenderForAmendment(shipment.id, amendReason.trim());
    setAmendOpen(false); setAmendReason("");
  }, "Surrendered for amendment: issue the next version when it's corrected");
  const openHandover = () => setHandover({ to: shipment.shipperName || "", method: "Courier", trackingRef: "", count: live?.originals ?? 3, handedOverOn: todayIso() });
  const logHandover = () => act("handover", async () => {
    await api.houseBl.originalsHandover(shipment.id, { ...handover, count: Number(handover.count) });
    setHandover(null);
  }, "Handover logged");

  const steps = [["Draft", "regenerating replaces it"], ["Issued", "number and date fixed"], ["Surrendered", "originals back, or the eBL"], ["Released", "Delivery Order unlocks"]];
  const onBoardText = t => (t.isShippedOnBoardType
    ? `Shipped on board${t.shippedOnBoardDate ? ` ${fmtDay(t.shippedOnBoardDate)}` : ", no date yet"}`
    : `Received for shipment${t.receivedForShipmentDate ? ` ${fmtDay(t.receivedForShipmentDate)}` : ""}`);
  const numberSourceText = src => (src === "SERIES" ? "office series" : "typed on Conditions");
  const toOrderMode = td?.status !== "DRAFT" && td ? td.toOrderMode : (shipment.blToOrder || "");
  const countsText = t => (t?.originals !== null && t?.originals !== undefined
    ? `${t.originals} original${t.originals === 1 ? "" : "s"}, ${t.copies || 0} cop${t.copies === 1 ? "y" : "ies"} · ${t.withCharges ? "with charges" : "freight as arranged"}`
    : "—");

  return (
    <section data-testid="house-bl-panel" aria-label="House Bill of Lading"
      style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 18, fontFamily: HZ_BODY, color: HZ.text }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>House Bill of Lading</h2>
        <span data-testid="house-bl-status" style={chip.style}>{chip.text}</span>
      </div>

      <ol aria-label="House B/L progress" style={{ margin: 0, padding: "12px 16px", listStyle: "none", display: "flex", gap: 8, borderRadius: 10, background: HZ.surfaceSolid, border: `1px solid ${HZ.border}` }}>
        {steps.map(([name, sub], i) => {
          const done = i < stage || (i === 3 && stage === 3), current = i === stage && stage !== 3;
          const ring = done ? HZ.good : current ? HZ.cyan : HZ.borderStrong;
          return (
            <li key={name} aria-current={current ? "step" : undefined} style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: "50%",
                border: `2px solid ${ring}`, color: done ? HZ.good : current ? HZ.cyan : HZ.textMuted, fontFamily: HZ_MONO, fontSize: 11, fontWeight: 700 }}>
                {done ? "✓" : i + 1}
              </span>
              <span style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: done || current ? HZ.text : HZ.textMuted }}>{name}</span>
                <span style={{ fontSize: 11, color: HZ.textMuted }}>{sub}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.25fr)", gap: 14 }}>
        <div style={card()}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>The record</h3>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "130px minmax(0, 1fr)", gap: "8px 12px" }}>
            <Row label="B/L number"><span data-testid="house-bl-record-number" style={{ fontFamily: HZ_MONO }}>{live?.reference
              ? `${live.reference} · ${numberSourceText(live.numberSource)}`
              : number?.value ? `${number.value} · ${numberSourceText(number.source)}`
                : number?.next ? `Taken at issue: ${number.next} next` : "Taken at issue"}</span></Row>
            <Row label="Version">{live ? `${live.version}${live.supersedesId ? ", amends the previous version" : ""}` : nextVersion ? `${nextVersion}, amends v${amends.version} (surrendered for amendment)` : "—"}</Row>
            <Row label="Kind">{td ? (td.typeCode === "SWB" ? "Sea Waybill (SWB)" : `Bill of Lading (BOL)${td.isElectronic ? ", electronic" : ""}`) : swb ? "Sea Waybill (SWB)" : "Bill of Lading (BOL)"}</Row>
            <Row label="Release type">{releaseType || "Not set yet"}</Row>
            <Row label="Consignee">{TO_ORDER_TEXT[toOrderMode] || "Named"}{toOrderMode !== "SHIPPER" && shipment.consigneeName ? `: ${shipment.consigneeName}` : ""}</Row>
            <Row label="Originals, copies">{td ? countsText(td) : "—"}</Row>
            <Row label="Says">{td ? onBoardText(td) : "—"}</Row>
            <Row label="Issued">{live?.issueDate ? `${fmtDay(live.issueDate)}${live.placeOfIssue ? ` · ${live.placeOfIssue}` : ""}` : "Not yet"}</Row>
            <Row label="DCSA document">{live?.hasPayload ? (live.payloadErrors ? "Kept; not valid for an eBL yet" : "Kept as issued, passes eBL 3.0") : "Built at issue"}</Row>
          </dl>
          {(versions.length > 1 || amends) && versions.length > 0 && (
            <div data-testid="house-bl-versions" style={{ ...box(), fontSize: 12.5 }}>
              <b>Versions under {versions[0].reference}</b>
              {versions.map(v => (
                <span key={v.id}><span style={{ fontFamily: HZ_MONO, color: HZ.textMuted }}>v{v.version}</span> {v.status === "SURRENDERED_FOR_AMENDMENT"
                  ? `Issued ${fmtDay(v.issueDate)} · surrendered for amendment${v.amendmentReason ? `: ${v.amendmentReason}` : ""}`
                  : v.status === "DRAFT" ? "Draft" : `Issued ${fmtDay(v.issueDate)}`}</span>
              ))}
              {amends && !draft && (
                <span><span style={{ fontFamily: HZ_MONO, color: HZ.textMuted }}>v{nextVersion}</span> Not issued yet: issue it under the same number</span>
              )}
            </div>
          )}
          {events.length > 0 && (
            <>
              <div style={{ height: 1, background: HZ.border }} />
              <h4 style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: HZ.textMuted }}>History</h4>
              <ol data-testid="house-bl-history" style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5, fontSize: 12.5 }}>
                {events.map(e => (
                  <li key={e.id}><span style={{ fontFamily: HZ_MONO, color: HZ.textMuted }}>{fmtDay(e.createdAt)}</span> {eventText(e)}</li>
                ))}
              </ol>
            </>
          )}
        </div>

        <div style={{ ...card(), background: HZ.surfaceSolid, border: `1px solid ${HZ.cyan}44` }}>
          {!live && (
            <>
              {amends && (
                <div data-testid="house-bl-amending" style={{ ...box(), background: HZ.warnBg, border: `1px solid ${HZ.warn}55`, fontSize: 12.5 }}>
                  <b style={{ fontSize: 13.5 }}>Version {nextVersion} replaces version {amends.version}</b>
                  <span style={{ color: HZ.textMuted }}>{amends.reference} v{amends.version} was surrendered for amendment on {fmtDay(amends.surrenderedAt)}{amends.amendmentReason ? `: ${amends.amendmentReason}` : ""}. Correct the shipment, then issue version {nextVersion} under the same number.</span>
                </div>
              )}
              {missing.length > 0 ? (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>Before it can be issued</h3>
                    <span style={{ fontSize: 12.5, color: HZ.textMuted }}>{missing.length} thing{missing.length === 1 ? " is" : "s are"} missing.</span>
                  </div>
                  <ul data-testid="house-bl-readiness" style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 7 }}>
                    {missing.map(m => {
                      const fix = fixPlaceOf(m, shipment.id);
                      return (
                        <li key={m} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 11px", borderRadius: 8, background: HZ.critBg, border: `1px solid ${HZ.crit}44`, fontSize: 12.5 }}>
                          <span aria-hidden="true" style={{ color: HZ.crit, fontWeight: 800 }}>✕</span>
                          <span style={{ flex: 1 }}>{m}</span>
                          {fix && <a href={fix.href} style={{ fontSize: 12, color: HZ.cyan, whiteSpace: "nowrap" }}>{fix.label}</a>}
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : (
                <div data-testid="house-bl-ready" style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 12px", borderRadius: 8, background: HZ.goodBg, border: `1px solid ${HZ.good}55`, fontSize: 13 }}>
                  <span aria-hidden="true" style={{ color: HZ.good, fontWeight: 800 }}>✓</span>
                  <span><b>Ready to issue.</b> Parties, containers, the carrier booking and loading all check out.</span>
                </div>
              )}
              {number && (
                <div data-testid="house-bl-number" style={{ display: "flex", flexDirection: "column", gap: 3, padding: "10px 12px", borderRadius: 8, border: `1px solid ${HZ.cyan}55`, background: HZ.cyanBg, fontSize: 13 }}>
                  <span><span style={{ color: HZ.textMuted }}>B/L number </span><b style={{ fontFamily: HZ_MONO }}>{number.value || (number.next ? `${number.next} (next)` : "taken at issue")}</b></span>
                  <span style={{ fontSize: 12, color: HZ.textMuted }}>{amends ? `Kept from version ${amends.version}: an amendment never takes a new number.`
                    : number.value ? (number.source === "SERIES" ? `Taken from the ${number.officeName || "office"} series.` : "Typed on Conditions: used as it is.")
                      : `Taken from the ${number.officeName || "export office's"} series when you press Issue. A number typed on Conditions (a B/L already issued on paper) is used instead.`}</span>
                </div>
              )}
              <fieldset style={{ margin: 0, padding: "10px 12px", borderRadius: 8, border: `1px solid ${HZ.borderStrong}`, display: "flex", flexDirection: "column", gap: 8 }}>
                <legend style={{ padding: "0 6px", fontSize: 12, fontWeight: 700, color: HZ.textMuted }}>What the B/L says</legend>
                <label style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
                  <input type="radio" name={`house-bl-statement-${shipment.id}`} data-testid="house-bl-statement-onboard" checked={choice === "onboard"} onChange={() => setChoice("onboard")} style={{ marginTop: 3 }} />
                  <span><b>Shipped on board</b> <span style={{ color: HZ.textMuted }}>· {facts.shippedOnBoard ? `${fmtDay(facts.onBoardDate)}, from the ${facts.onBoardSource}` : "no loading recorded yet: type the date, or wait for the Loaded event"}</span></span>
                </label>
                <label style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
                  <input type="radio" name={`house-bl-statement-${shipment.id}`} data-testid="house-bl-statement-received" checked={choice === "received"} onChange={() => setChoice("received")} style={{ marginTop: 3 }} />
                  <span><b>Received for shipment</b> <span style={{ color: HZ.textMuted }}>· once the carrier has confirmed the booking</span></span>
                </label>
                {choice === "onboard" && (
                  <label style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 12, color: HZ.textMuted, paddingLeft: 24 }}>
                    On-board date, typed
                    <input type="date" data-testid="house-bl-onboard-date" value={typed} max={todayIso()} onChange={e => setTyped(e.target.value)}
                      style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${HZ.borderStrong}`, background: HZ.bg, color: HZ.text, fontFamily: HZ_MONO, fontSize: 12 }} />
                  </label>
                )}
                <div style={{ height: 1, background: HZ.border }} />
                <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <label style={fieldLabel()}>Originals
                    <input type="number" data-testid="house-bl-originals" min={swb ? 0 : 1} max={9} value={swb ? 0 : counts.originals} disabled={swb}
                      onChange={e => setCounts(c => ({ ...c, originals: e.target.value === "" ? "" : Number(e.target.value) }))}
                      style={{ ...inputStyle(), width: 70, fontFamily: HZ_MONO }} /></label>
                  <label style={fieldLabel()}>Copies, not negotiable
                    <input type="number" data-testid="house-bl-copies" min={0} max={20} value={counts.copies}
                      onChange={e => setCounts(c => ({ ...c, copies: e.target.value === "" ? "" : Number(e.target.value) }))}
                      style={{ ...inputStyle(), width: 70, fontFamily: HZ_MONO }} /></label>
                  <span style={{ fontSize: 12, color: HZ.textMuted, paddingBottom: 7 }}>{swb ? "A Sea Waybill has no originals." : countsOk ? "A Sea Waybill has no originals; an eBL is one." : "1 to 9 originals."}</span>
                </div>
                <div role="radiogroup" aria-label="Freight on the B/L" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 12, color: HZ.textMuted }}>Freight on the B/L</span>
                  <label style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
                    <input type="radio" name={`house-bl-freight-${shipment.id}`} data-testid="house-bl-freight-arranged" checked={!counts.withCharges}
                      onChange={() => setCounts(c => ({ ...c, withCharges: false }))} style={{ marginTop: 3 }} />
                    <span><b>Freight {(shipment.freightTerms || "Prepaid").toLowerCase()} as arranged</b> <span style={{ color: HZ.textMuted }}>· no amounts printed</span></span>
                  </label>
                  <label style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
                    <input type="radio" name={`house-bl-freight-${shipment.id}`} data-testid="house-bl-freight-charges" checked={!!counts.withCharges}
                      onChange={() => setCounts(c => ({ ...c, withCharges: true }))} style={{ marginTop: 3 }} />
                    <span><b>With the charges</b> <span style={{ color: HZ.textMuted }}>· {summary.charges?.length
                      ? `the shipment's ${summary.charges.length} selling charge${summary.charges.length === 1 ? "" : "s"}, prepaid and collect`
                      : "the shipment has no selling charges yet"}</span></span>
                  </label>
                </div>
              </fieldset>
              {canEdit && (
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                  <Btn variant="secondary" data-testid="house-bl-generate-draft" disabled={!!busy || !countsOk} onClick={generateDraft}>{busy === "draft" ? "Building…" : "Generate draft"}</Btn>
                  <Btn data-testid="house-bl-issue" disabled={!!busy || !ready} onClick={issue}>{busy === "issue" ? "Issuing…" : nextVersion ? `Issue version ${nextVersion}` : "Issue House B/L"}</Btn>
                </div>
              )}
              {!number?.value && !amends && <span style={{ fontSize: 12, color: HZ.textMuted }}>A draft generated before issue prints “B/L number: assigned at issue”.</span>}
            </>
          )}

          {live && !live.releasedAt && live.status === "ISSUED" && changed.length > 0 && !live.isElectronic && (
            <div data-testid="house-bl-changed" style={{ ...box(), background: HZ.warnBg, border: `1px solid ${HZ.warn}66` }}>
              <b style={{ fontSize: 13.5, color: HZ.warn }}>Changed since issue: {changed.join(", ")}</b>
              <span style={{ fontSize: 12.5, color: HZ.textMuted }}>The shipment no longer matches the issued B/L. To correct the B/L, the originals come back: surrender it for amendment, then issue version {live.version + 1} under the same number.</span>
            </div>
          )}

          {live && !live.releasedAt && live.status === "ISSUED" && !live.isElectronic && (
            <>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>Issued. What next</h3>
              {live.typeCode === "SWB" ? (
                <div style={box()}><span style={{ fontSize: 13 }}><b>Sea Waybill:</b> no originals. The named consignee takes delivery.</span></div>
              ) : (
                <div data-testid="house-bl-originals-log" style={box()}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <b style={{ fontSize: 13.5 }}>Originals</b>
                    {canEdit && !handover && <Btn variant="secondary" size="sm" data-testid="house-bl-handover-open" disabled={!!busy} onClick={openHandover}>＋ Record handover</Btn>}
                  </div>
                  <span style={{ fontSize: 12.5, color: HZ.textMuted }}>{live.originals ?? 3} original{live.originals === 1 ? " was" : "s were"} issued. {releaseType === "Original"
                    ? `Log who they went to; the consignee presents one at ${shipment.podName || shipment.pod}.`
                    : "Log who they went to; the shipper hands them back at origin for the telex release."}</span>
                  {handovers.length > 0 && (
                    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
                      {handovers.map(h => (
                        <li key={h.id} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "7px 10px", borderRadius: 7, background: HZ.surface, fontSize: 12.5 }}>
                          <span style={{ fontFamily: HZ_MONO, color: HZ.textMuted }}>{fmtDay(h.detail.on)}</span>
                          <span style={{ flex: 1 }}>{h.detail.count} of {h.detail.total} {h.detail.method === "In person" ? "in person" : `by ${String(h.detail.method).toLowerCase()}`} to {h.detail.to}</span>
                          {h.detail.trackingRef && <span style={{ fontFamily: HZ_MONO, color: HZ.textMuted }}>{h.detail.trackingRef}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {handover && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "8px 10px" }}>
                      <label style={{ ...fieldLabel(), gridColumn: "span 2" }}>To
                        <input id="house-bl-handover-to" value={handover.to} onChange={e => setHandover(h => ({ ...h, to: e.target.value }))} style={inputStyle()} /></label>
                      <label style={fieldLabel()}>How
                        <select id="house-bl-handover-method" value={handover.method} onChange={e => setHandover(h => ({ ...h, method: e.target.value }))} style={{ ...inputStyle(), background: HZ.surfaceSolid }}>
                          {(summary.handoverMethods || ["In person", "Courier", "Mail"]).map(m => <option key={m} value={m}>{m}</option>)}
                        </select></label>
                      <label style={fieldLabel()}>Tracking number{handover.method === "Courier" ? "" : " (optional)"}
                        <input id="house-bl-handover-tracking" value={handover.trackingRef} onChange={e => setHandover(h => ({ ...h, trackingRef: e.target.value }))} style={{ ...inputStyle(), fontFamily: HZ_MONO }} /></label>
                      <label style={fieldLabel()}>Originals
                        <input id="house-bl-handover-count" type="number" min={1} max={live.originals ?? 3} value={handover.count}
                          onChange={e => setHandover(h => ({ ...h, count: e.target.value }))} style={{ ...inputStyle(), fontFamily: HZ_MONO }} /></label>
                      <label style={fieldLabel()}>Date
                        <input id="house-bl-handover-date" type="date" max={todayIso()} value={handover.handedOverOn}
                          onChange={e => setHandover(h => ({ ...h, handedOverOn: e.target.value }))} style={{ ...inputStyle(), fontFamily: HZ_MONO }} /></label>
                      <div style={{ gridColumn: "span 2", display: "flex", justifyContent: "flex-end", gap: 8 }}>
                        <Btn variant="secondary" size="sm" onClick={() => setHandover(null)}>Cancel</Btn>
                        <Btn size="sm" data-testid="house-bl-handover-save" disabled={!!busy || !handover.to.trim() || (handover.method === "Courier" && !handover.trackingRef.trim())}
                          onClick={logHandover}>Log handover</Btn>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {canEdit && live.typeCode !== "SWB" && (
                <div style={box()}>
                  <b style={{ fontSize: 13.5 }}>{releaseType === "Original" ? "At destination" : "At origin"}</b>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                    {releaseType === "Original" && (
                      <label style={{ ...fieldLabel(), flex: 1, minWidth: 220 }}>Presented by (the holder; for a to-order B/L, the last endorsee)
                        <input id="house-bl-presented-by" value={presentedBy} onChange={e => setPresentedBy(e.target.value)}
                          placeholder={toOrderMode ? "e.g. the bank the B/L was endorsed to" : shipment.consigneeName || ""} style={inputStyle()} /></label>
                    )}
                    <Btn variant="secondary" size="sm" data-testid="house-bl-surrender" disabled={!!busy} onClick={surrender}>
                      {releaseType === "Original" ? "Originals presented at destination" : "Surrendered at origin"}
                    </Btn>
                    <Btn variant="secondary" size="sm" data-testid="house-bl-open-release" disabled={!!busy} onClick={() => setReleaseOpen(true)}>Release cargo…</Btn>
                  </div>
                </div>
              )}
              {canEdit && live.typeCode === "SWB" && (
                <div><Btn variant="secondary" size="sm" data-testid="house-bl-open-release" disabled={!!busy} onClick={() => setReleaseOpen(true)}>Release cargo…</Btn></div>
              )}
              {live.typeCode === "BOL" && canEdit && (
                <div data-testid="house-bl-ebl-box" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "11px 13px", borderRadius: 8, border: `1px solid ${HZ.cyan}55`, background: HZ.cyanBg }}>
                  <span style={{ fontSize: 13 }}><b>Or electronic:</b> send it to an eBL platform instead of printing originals.
                    {live.eblIssuanceStatus && live.eblIssuanceStatus !== "ISSU" && (
                      <span style={{ display: "block", color: HZ.warn, marginTop: 4 }}>Last attempt: {live.eblPlatform} answered {live.eblIssuanceStatus}{live.eblIssuanceReason ? ` (${live.eblIssuanceReason})` : ""}.</span>
                    )}
                  </span>
                  {eblOpen && (
                    <div style={{ display: "grid", gridTemplateColumns: "110px minmax(0, 1fr)", gap: "8px 10px", alignItems: "center", fontSize: 12.5 }}>
                      <label htmlFor="house-bl-platform" style={{ color: HZ.textMuted }}>Platform</label>
                      <select id="house-bl-platform" value={platform} onChange={e => setPlatform(e.target.value)}
                        style={{ padding: "6px 8px", borderRadius: 6, border: `1px solid ${HZ.borderStrong}`, background: HZ.surfaceSolid, color: HZ.text, fontFamily: HZ_BODY, fontSize: 12.5 }}>
                        {(summary.ebl?.platforms || []).map(p => <option key={p} value={p}>{p}{summary.ebl?.available ? " · built-in, DEMO" : " · not connected"}</option>)}
                      </select>
                      <label htmlFor="house-bl-issue-to" style={{ color: HZ.textMuted }}>Issue to</label>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span>{shipment.shipperName || "The shipper"}{eblShipperId ? <> · <span style={{ fontFamily: HZ_MONO }}>{eblShipperId}</span></> : ""}</span>
                        {!eblShipperId && (
                          <input id="house-bl-issue-to" value={partyCode} onChange={e => setPartyCode(e.target.value)} placeholder={`The shipper's ${platform} id (or add it under Customers → Identifiers)`}
                            style={{ padding: "6px 8px", borderRadius: 6, border: `1px solid ${HZ.borderStrong}`, background: HZ.bg, color: HZ.text, fontFamily: HZ_MONO, fontSize: 12 }} />
                        )}
                      </div>
                      {summary.ebl?.entityGaps?.length > 0 && (
                        <span data-testid="house-bl-entity-gaps" style={{ gridColumn: "span 2", color: HZ.warn, fontSize: 12 }}>
                          {summary.ebl.entityName || "The legal entity"} needs {summary.ebl.entityGaps.join(", ")} (Organisation → Branches) first.
                        </span>
                      )}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    {eblOpen && <Btn variant="secondary" size="sm" onClick={() => setEblOpen(false)}>Cancel</Btn>}
                    <Btn size="sm" data-testid={eblOpen ? "house-bl-ebl-send" : "house-bl-ebl-open"} disabled={!!busy || (eblOpen && !summary.ebl?.available)}
                      onClick={eblOpen ? sendEbl : () => setEblOpen(true)}>{eblOpen ? `Send to ${platform}` : "Issue as eBL…"}</Btn>
                  </div>
                </div>
              )}
              {amendOpen && (
                <div data-testid="house-bl-amend-form" style={box()}>
                  <b style={{ fontSize: 13.5 }}>Surrender for amendment</b>
                  <span style={{ fontSize: 12.5, color: HZ.textMuted }}>{live.typeCode === "SWB"
                    ? `Version ${live.version} stays on record; version ${live.version + 1} is issued under ${live.reference}.`
                    : `Record that the originals came back. Version ${live.version} stays on record; version ${live.version + 1} is issued under ${live.reference}.`}</span>
                  <label htmlFor="house-bl-amend-reason" style={{ fontSize: 12, color: HZ.textMuted }}>Reason</label>
                  <textarea id="house-bl-amend-reason" rows={2} value={amendReason} onChange={e => setAmendReason(e.target.value)} placeholder="e.g. Consignee moved to a new address"
                    style={{ padding: "8px 10px", borderRadius: 7, border: `1px solid ${HZ.borderStrong}`, background: HZ.bg, color: HZ.text, fontFamily: HZ_BODY, fontSize: 13, resize: "vertical" }} />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <Btn variant="secondary" size="sm" onClick={() => setAmendOpen(false)}>Cancel</Btn>
                    <Btn variant="danger" size="sm" data-testid="house-bl-amend-confirm" disabled={!!busy || !amendReason.trim()} onClick={surrenderForAmendment}>
                      {live.typeCode === "SWB" ? "Surrender for amendment" : "Originals returned: surrender for amendment"}
                    </Btn>
                  </div>
                </div>
              )}
              {canEdit && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {!amendOpen && (
                    <Btn variant="secondary" size="sm" data-testid="house-bl-amend" disabled={!!busy} onClick={() => setAmendOpen(true)}>Surrender for amendment…</Btn>
                  )}
                  <Btn variant="danger" size="sm" data-testid="house-bl-void" disabled={!!busy} onClick={() => setVoidOpen(true)}>Void, with a reason…</Btn>
                </div>
              )}
            </>
          )}

          {live && !live.releasedAt && live.isElectronic && (
            <>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>On {live.eblPlatform}{summary.ebl?.available ? " (DEMO platform)" : ""}</h3>
              <span data-testid="house-bl-ebl-state" style={{ fontSize: 13, color: HZ.textMuted }}>
                {live.eblIssuanceStatus === "PENDING" ? `Waiting for ${live.eblPlatform} to issue it.`
                  : live.status === "PENDING_SURRENDER_FOR_DELIVERY" ? "A surrender for delivery was asked; CargoDesk is checking it."
                  : live.status === "PENDING_SURRENDER_FOR_AMENDMENT" ? "A surrender for amendment was asked on the platform."
                  : live.status === "SURRENDERED_FOR_DELIVERY" ? "Surrendered for delivery."
                  : `Issued on ${live.eblPlatform}. The holder endorses it there, and asks to surrender it for delivery, or for an amendment (AREQ).`}
              </span>
              <span style={{ fontSize: 12, color: HZ.textMuted }}>A rejected surrender (SREJ) names why, and the eBL stays with its holder. The History shows each step.</span>
            </>
          )}

          {live && !live.releasedAt && live.status === "SURRENDERED_FOR_DELIVERY" && !live.isElectronic && (
            <>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>{live.surrenderKind === "origin" ? "Surrendered at origin. Ready to release" : "Surrendered. Ready to release"}</h3>
              {telex && (
                <div data-testid="house-bl-telex-notice" style={{ ...box(), background: telex.detail.sent ? HZ.cyanBg : HZ.warnBg, border: `1px solid ${(telex.detail.sent ? HZ.cyan : HZ.warn)}55`, fontSize: 13 }}>
                  <b>{telex.detail.sent ? `Telex release notice sent to ${telex.detail.office}` : "Telex release: nobody was told"}</b>
                  <span style={{ color: HZ.textMuted }}>{telex.detail.sent
                    ? `A Kanban task for the import office's manager${telex.detail.ticketId ? ` (${telex.detail.ticketId})` : ""}: it releases without originals once the checks pass.`
                    : "The shipment has no import office. Set one on Parties & Offices, and tell the destination yourself."}</span>
                  {telex.detail.sent && <a href="#kanban" style={{ fontSize: 12.5, color: HZ.cyan }}>Integration Board</a>}
                </div>
              )}
              {canEdit && <div><Btn data-testid="house-bl-open-release" disabled={!!busy} onClick={() => setReleaseOpen(true)}>Release cargo…</Btn></div>}
            </>
          )}

          {live?.releasedAt && (
            <div data-testid="house-bl-released" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "11px 13px", borderRadius: 8, background: HZ.cyanBg, border: `1px solid ${HZ.cyan}55`, fontSize: 13 }}>
              <b>Cargo released {fmtDay(live.releasedAt)}{live.releasedBy ? ` by ${live.releasedBy}` : ""}.</b>
              {live.releaseOverrideReason && <span style={{ color: HZ.warn }}>With an override: {live.releaseOverrideReason}</span>}
              <span style={{ color: HZ.textMuted }}>The Delivery Order (DO01) can be generated now.</span>
            </div>
          )}
        </div>
      </div>

      {releaseOpen && live && (
        <ReleaseCargoModal blocks={summary.release?.blocks || []} canOverride={canOverride} onRelease={release} onClose={() => setReleaseOpen(false)} />
      )}
      {voidOpen && live && <VoidModal onVoid={voidIt} onClose={() => setVoidOpen(false)} />}
    </section>
  );
};

export default HouseBlPanel;
