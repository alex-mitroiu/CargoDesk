import { useState, useEffect } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY } from "../../pages/shipments/shipmentDetailTheme";

// ─── The carrier's Master B/L (DCSA eBL 3.0 transport document, phase 4, 2026-10-28) ─────────────
// Shown on Shipping Instructions once the carrier has drafted its Master B/L from them (routes/master-bl.js).
// Approved mockup VUTPKnRAjdPjfb8DntUxVs, the user's call: foldable, the critical information first —
// status and what to do, anything that differs from what was sent, six key facts each marked same (✓) or
// changed (≠), Approve — and the full field-by-field comparison behind "Show all N fields".
// Once issued, "Request amendment" (mockup 1bf14417, approved 2026-10-28): a preview of what differs between
// the issued B/L and the shipment now, then the carrier's answer (waiting, accepted: return the originals,
// declined) and, when it issues the amended B/L, what changed.

const STEPS = [
  { status: "DRAFT", label: "Drafted", event: "MASTER_DRAFT" },
  { status: "APPROVED", label: "Approved", event: "MASTER_APPROVED" },
  { status: "ISSUED", label: "Issued", event: "MASTER_ISSUED" },
  { status: "SURRENDERED_FOR_DELIVERY", label: "Surrendered for delivery", event: "MASTER_SURRENDERED_FOR_DELIVERY" },
];
const STAGE = { DRAFT: 0, APPROVED: 1, ISSUED: 2, PENDING_SURRENDER_FOR_DELIVERY: 2, PENDING_SURRENDER_FOR_AMENDMENT: 3, SURRENDERED_FOR_AMENDMENT: 4, SURRENDERED_FOR_DELIVERY: 3 };
// While an accepted amendment runs, the last steps are the surrender for amendment and the amended B/L.
const AMEND_STEPS = [...STEPS.slice(0, 3),
  { status: "PENDING_SURRENDER_FOR_AMENDMENT", label: "Surrender for amendment", event: "MASTER_PENDING_SURRENDER_FOR_AMENDMENT" },
  { status: "SURRENDERED_FOR_AMENDMENT", label: "Amended B/L issued", event: "MASTER_AMENDED" }];
const AMENDABLE = ["ISSUED", "PENDING_SURRENDER_FOR_AMENDMENT"];
// A comparison row (server: compareDraft) as a reviewer reads it: "Container X · Seal".
const whereOf = r => { const [kind, ref] = r.key.split(":"); return ref && kind !== "container" ? `Container ${ref} · ${r.label.trim()}` : r.label.trim(); };
const PILL = {
  DRAFT: ["DRAFT · TO REVIEW", "warnBg", "warn"], APPROVED: ["APPROVED", "infoBg", "infoPillText"], ISSUED: ["ISSUED", "goodBg", "goodPillText"],
  PENDING_SURRENDER_FOR_DELIVERY: ["SURRENDER PENDING", "infoBg", "infoPillText"], SURRENDERED_FOR_DELIVERY: ["SURRENDERED", "goodBg", "goodPillText"],
  PENDING_SURRENDER_FOR_AMENDMENT: ["AMENDMENT PENDING", "warnBg", "warn"], SURRENDERED_FOR_AMENDMENT: ["SURRENDERED FOR AMENDMENT", "warnBg", "warn"],
  VOIDED: ["VOIDED", "critBg", "crit"],
};
const fmt = s => (s ? new Date(s).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const day = s => (s ? new Date(`${String(s).slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const ISO_LABEL = { "22G1": "20' Dry", "42G1": "40' Dry", "45G1": "40' HC", L5G1: "45' HC", "22R1": "20' Reefer", "42R1": "40' Reefer", "45R1": "40' HC Reefer" };

// The comparison rows (server: compareDraft) grouped as a reviewer reads them.
function groupsOf(rows) {
  const groups = [], byTitle = new Map();
  const groupFor = title => { if (!byTitle.has(title)) { const g = { title, rows: [] }; byTitle.set(title, g); groups.push(g); } return byTitle.get(title); };
  for (const r of rows) {
    const [kind, ref] = r.key.split(":");
    const title = ref ? `Container ${ref}` : ["documentType", "freight", "originals"].includes(kind) ? "Document"
      : ["shipper", "consignee", "notify"].includes(kind) ? "Parties" : "Route";
    if (kind === "container") { groupFor(title); continue; }
    groupFor(title).rows.push({ ...r, label: r.label.trim() });
  }
  return groups;
}

const MasterBlPanel = ({ shipment, canEdit, refreshKey = 0, onChanged }) => {
  const [mbl, setMbl] = useState(undefined);
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState(null); // { changes, missing } before an amendment is sent

  const load = () => api.masterBl.get(shipment.id).then(setMbl).catch(() => setMbl(null));
  useEffect(() => { load(); }, [shipment.id, refreshKey]);
  if (!mbl) return null;

  const carrier = mbl.carrierCode || shipment.carrierCode || "the carrier";
  const doc = mbl.document || {};
  const rows = mbl.comparison || [];
  const diffs = rows.filter(r => r.changed && !r.key.startsWith("container:"));
  const missingContainers = rows.filter(r => r.key.startsWith("container:") && r.changed);
  const at = STAGE[mbl.status] ?? (mbl.status === "VOIDED" ? -1 : 0);
  const isDraft = mbl.status === "DRAFT";
  const eventAt = e => [...(mbl.events || [])].reverse().find(x => x.eventType === e)?.createdAt;
  const amendment = mbl.amendment, amendStatus = amendment?.status || "";
  const inAmendment = ["PENDING_SURRENDER_FOR_AMENDMENT", "SURRENDERED_FOR_AMENDMENT"].includes(mbl.status);
  // The last amendment the carrier issued, when nothing is pending since.
  const amended = !amendment && mbl.status === "ISSUED" ? [...(mbl.events || [])].reverse().find(e => e.eventType === "MASTER_AMENDED") : null;
  const originalsCount = (mbl.document?.numberOfOriginalsWithoutCharges ?? mbl.document?.numberOfOriginalsWithCharges) || 0;
  const steps = (inAmendment ? AMEND_STEPS : STEPS).map((s, i) => ({
    ...s, done: at > i, current: at === i,
    date: at < i ? "not yet" : i === 0 ? fmt(eventAt(s.event) || mbl.createdAt)
      : i === 1 ? [fmt(eventAt(s.event) || mbl.approvedAt), mbl.approvedBy].filter(Boolean).join(" · ")
      : i === 2 ? [day(mbl.issueDate) || fmt(eventAt(s.event)), mbl.shippedOnBoardDate ? `shipped on board ${day(mbl.shippedOnBoardDate)}` : ""].filter(Boolean).join(" · ")
      : inAmendment && i === 3 ? (at === 3 ? "waiting for the originals" : fmt(eventAt("MASTER_SURRENDERED_FOR_AMENDMENT")))
      : inAmendment && i === 4 ? "waiting for the carrier"
      : fmt(eventAt(s.event)),
  }));
  const banner = mbl.status === "VOIDED" ? [`${carrier} voided Master B/L ${mbl.reference}${mbl.carrierFeedback ? `: ${mbl.carrierFeedback}` : ""}.`, "crit"]
    : isDraft ? [`${carrier} drafted Master B/L ${mbl.reference} from your Shipping Instructions${mbl.draftCount > 1 ? ` (draft ${mbl.draftCount})` : ""}. Check it against what you sent, then approve it. If something needs correcting, fix the shipment and send an update: ${carrier} redrafts.`, "cyan"]
    : mbl.status === "APPROVED" ? [`You approved the draft${mbl.approvedBy ? ` (${mbl.approvedBy})` : ""}. Waiting for ${carrier} to issue it.`, "cyan"]
    : mbl.status === "PENDING_SURRENDER_FOR_AMENDMENT" ? [mbl.isElectronic
        ? `${carrier} accepted the amendment. Surrender the electronic B/L for amendment on its eBL platform so ${carrier} can issue the amended B/L.`
        : `${carrier} accepted the amendment. Return the ${originalsCount ? `${originalsCount} ` : ""}original B/Ls to ${carrier} (surrender for amendment) so it can issue the amended B/L.`, "warn"]
    : mbl.status === "SURRENDERED_FOR_AMENDMENT" ? [`The originals are back with ${carrier}. Waiting for it to issue the amended B/L.`, "cyan"]
    : amendStatus === "AMENDMENT_DECLINED" ? [`${carrier} declined the amendment${mbl.carrierFeedback ? `: “${mbl.carrierFeedback}”` : ""}. The issued B/L stands as it was.`, "crit"]
    : amendStatus === "AMENDMENT_RECEIVED" || (amendment && !amendStatus) ? [`You asked ${carrier} to amend the issued B/L. Waiting for ${carrier}; the issued B/L stands until it answers.`, "cyan"]
    : amended ? [`${carrier} issued the amended B/L on ${day(amended.detail?.issueDate) || fmt(amended.createdAt)}. Same number; the old version is in History.`, "good"]
    : at === 2 ? [`Issued${mbl.issueDate ? ` on ${day(mbl.issueDate)}` : ""}. The shipment now carries Master B/L number ${mbl.reference}, and B/L Issued is complete.`, "good"]
    : [`Surrendered for delivery. ${carrier} marked the Shipping Instructions complete.`, "good"];
  const [pill, pillBg, pillFg] = mbl.status === "ISSUED" && amendStatus === "AMENDMENT_DECLINED" ? ["ISSUED · AMENDMENT DECLINED", "critBg", "crit"]
    : mbl.status === "ISSUED" && amendment ? ["ISSUED · AMENDMENT REQUESTED", "infoBg", "infoPillText"]
    : amended ? ["ISSUED · AMENDED", "goodBg", "goodPillText"]
    : PILL[mbl.status] || [mbl.status, "surface2", "text"];

  // The six key facts: each marked changed when anything it stands for differs from what was sent — or,
  // once issued, from the shipment an amendment is (to be) asked for.
  const amendRows = preview?.changes || (amendment && amendStatus !== "AMENDMENT_CANCELLED" ? amendment.changes : []) || [];
  const changedAny = keys => [...rows, ...amendRows].some(r => r.changed && keys.some(k => r.key === k || r.key.startsWith(`${k}:`)));
  const val = key => rows.find(r => r.key === key)?.carrier;
  const containers = (doc.utilizedTransportEquipments || []);
  const weight = (doc.consignmentItems || []).flatMap(ci => ci.cargoItems || []).reduce((n, c) => n + (Number(c.cargoGrossWeight?.value) || 0), 0);
  const isoCounts = containers.reduce((m, u) => { const k = ISO_LABEL[u.equipment?.ISOEquipmentCode] || u.equipment?.ISOEquipmentCode || "container"; m[k] = (m[k] || 0) + 1; return m; }, {});
  const originals = doc.numberOfOriginalsWithoutCharges ?? doc.numberOfOriginalsWithCharges;
  const facts = [
    { label: "Document", value: [doc.transportDocumentTypeCode === "SWB" ? "Sea Waybill" : "Bill of Lading", originals ? `${originals} original${originals === 1 ? "" : "s"}` : "",
      doc.freightPaymentTermCode === "COL" ? "collect" : doc.freightPaymentTermCode === "PRE" ? "prepaid" : ""].filter(Boolean).join(" · "), keys: ["documentType", "freight", "originals"] },
    { label: "Vessel / voyage", value: val("vessel") || "—", keys: ["vessel"] },
    { label: "Shipper", value: val("shipper") || "—", keys: ["shipper"] },
    { label: "Ports", value: `${val("portOfLoading") || "—"} → ${val("portOfDischarge") || "—"}`, keys: ["portOfLoading", "portOfDischarge"] },
    { label: "Consignee", value: val("consignee") || "—", keys: ["consignee", "notify"] },
    { label: "Containers", value: [Object.entries(isoCounts).map(([k, n]) => `${n} × ${k}`).join(", "), weight ? `${weight.toLocaleString()} kg` : "",
      containers.length ? `seals ${containers.flatMap(u => (u.seals || []).map(s => s.number)).join(", ") || "—"}` : ""].filter(Boolean).join(" · "),
      keys: ["container", "seal", "weight", "goods", "hs", "packages"] },
  ].map(f => ({ ...f, changed: changedAny(f.keys) }));
  const groups = groupsOf(rows);
  // Amendments go to an issued B/L; one the carrier is still working on is cancelled first.
  const canAmend = canEdit && AMENDABLE.includes(mbl.status) && amendStatus !== "AMENDMENT_RECEIVED" && !(amendment && !amendStatus);
  const fieldCount = groups.reduce((n, g) => n + g.rows.length, 0);
  const diffCount = diffs.length + missingContainers.length;
  const issuedLike = !["DRAFT", "APPROVED", "VOIDED"].includes(mbl.status);
  const summary = !issuedLike ? (diffCount ? `${diffCount} difference${diffCount === 1 ? "" : "s"} — check before approving` : "No differences: the draft says what you sent")
    : amendStatus === "AMENDMENT_RECEIVED" ? `Amendment sent ${fmt(amendment.requestedAt)}`
    : amendStatus === "AMENDMENT_CONFIRMED" ? `${carrier} accepted the amendment`
    : amendStatus === "AMENDMENT_DECLINED" ? `${carrier} declined the amendment`
    : amended ? `Amended B/L issued ${day(amended.detail?.issueDate) || fmt(amended.createdAt)}`
    : [mbl.issueDate ? `Issued ${day(mbl.issueDate)}` : "Issued", originalsCount ? `${originalsCount} originals` : ""].filter(Boolean).join(" · ");
  const summaryWarn = issuedLike ? ["AMENDMENT_DECLINED", "AMENDMENT_CONFIRMED"].includes(amendStatus) : diffCount > 0;

  const approve = async () => {
    setBusy("approve");
    try { setMbl(await api.masterBl.approve(shipment.id)); toast.success("Approved — sent to the carrier"); onChanged?.(); }
    catch (e) { toast.error(e.message); }
    setBusy("");
  };
  const refresh = async () => {
    setBusy("refresh");
    try { setMbl(await api.masterBl.refresh(shipment.id)); toast.success(`Asked ${carrier}`); onChanged?.(); }
    catch (e) { toast.error(e.message); }
    setBusy("");
  };
  // Amending the issued B/L: see what would go, send it, or withdraw one the carrier hasn't worked on.
  const requestAmendment = async () => {
    setBusy("preview");
    try { setPreview(await api.masterBl.amendmentPreview(shipment.id)); }
    catch (e) { toast.error(e.message); }
    setBusy("");
  };
  const sendAmendment = async () => {
    setBusy("amend");
    try { setMbl(await api.masterBl.amend(shipment.id)); setPreview(null); toast.success(`Amendment sent to ${carrier}`); onChanged?.(); }
    catch (e) { toast.error(e.message); }
    setBusy("");
  };
  const cancelAmendment = async () => {
    setBusy("cancelAmend");
    try { setMbl(await api.masterBl.cancelAmendment(shipment.id)); toast.success("Amendment withdrawn"); onChanged?.(); }
    catch (e) { toast.error(e.message); }
    setBusy("");
  };
  const tone = t => ({ cyan: [HZ.cyanBg, HZ.text], good: [HZ.goodBg, HZ.text], crit: [HZ.critBg, HZ.text], warn: [HZ.warnBg, HZ.text] }[t]);
  const sub = { border: `1px solid ${HZ.border}`, borderRadius: 9, padding: 14, display: "flex", flexDirection: "column", gap: 12 };
  const subTitle = { margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: HZ.textMuted };
  const chip = (text, bg, fg) => <span style={{ ...{ fontFamily: HZ_MONO }, marginLeft: "auto", fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", padding: "3px 9px", borderRadius: 999, background: HZ[bg], color: HZ[fg] }}>{text}</span>;
  const changeRows = (list, a, b) => list.map(r => (
    <div key={r.key} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr)", gap: 12, alignItems: "baseline",
      padding: "9px 12px", borderRadius: 8, background: HZ.warnBg, fontSize: 12.5 }}>
      <span style={{ fontWeight: 600 }}>{whereOf(r)}</span>
      <span><span style={{ fontSize: 11, color: HZ.textMuted }}>{a} </span>{r.carrier}</span>
      <span style={{ color: HZ.warn, fontWeight: 700 }}><span style={{ fontSize: 11, color: HZ.textMuted, fontWeight: 400 }}>{b} </span>{r.sent}</span>
    </div>));
  const [bannerBg, bannerFg] = tone(banner[1]);
  const mono = { fontFamily: HZ_MONO };
  const th = { textAlign: "left", padding: "8px 12px", fontSize: 10.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: HZ.textMuted };

  return (
    <div id="mbl-panel" style={{ background: HZ.surface, backdropFilter: HZ.cardBlur, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10, overflow: "hidden" }}>
      <button type="button" id="mbl-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls="mbl-body"
        style={{ width: "100%", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 12px", padding: "14px 18px", border: "none",
          background: "transparent", color: HZ.text, textAlign: "left", cursor: "pointer", fontFamily: HZ_BODY }}>
        <span aria-hidden="true" style={{ display: "inline-flex", width: 18, justifyContent: "center", fontSize: 18, lineHeight: 1, color: HZ.textMuted,
          transform: `rotate(${open ? 90 : 0}deg)`, transition: "transform .15s" }}>›</span>
        <span style={{ fontFamily: HZ_DISPLAY, fontSize: 15, fontWeight: 800 }}>Master B/L from {carrier}</span>
        <span id="mbl-reference" style={{ ...mono, fontSize: 12, color: HZ.cyan }}>{mbl.reference}</span>
        <span id="mbl-status" style={{ ...mono, fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", padding: "3px 9px", borderRadius: 999, background: HZ[pillBg], color: HZ[pillFg] }}>{pill}</span>
        {mbl.isMock && <span style={{ ...mono, fontSize: 10, fontWeight: 700, padding: "3px 7px", borderRadius: 4, background: HZ.violetBg, color: HZ.violetPillText }}>DEMO CARRIER</span>}
        {mbl.status !== "VOIDED" && (
          <span id="mbl-summary" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 999,
            background: summaryWarn ? HZ.warnBg : HZ.goodBg, color: summaryWarn ? HZ.warn : HZ.goodPillText }}>{summary}</span>
        )}
      </button>

      {open && (
        <div id="mbl-body" style={{ borderTop: `1px solid ${HZ.border}`, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 16, fontFamily: HZ_BODY }}>
          {mbl.status !== "VOIDED" && (
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
              {steps.map(s => (
                <li key={s.status} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ display: "block", height: 4, borderRadius: 2, background: s.done ? HZ.good : s.current ? HZ.cyan : HZ.border }} />
                  <span style={{ fontSize: 12.5, fontWeight: s.current ? 700 : 500, color: s.done || s.current ? HZ.text : HZ.textMuted }}>{s.label}</span>
                  <span style={{ fontSize: 11, color: HZ.textMuted }}>{s.date}</span>
                </li>
              ))}
            </ol>
          )}
          <div id="mbl-banner" style={{ fontSize: 12.5, lineHeight: 1.55, padding: "10px 12px", borderRadius: 8, background: bannerBg, color: bannerFg }}>{banner[0]}</div>

          {preview && (
            <div id="mbl-amend-preview" role="region" aria-label="Amendment to send" style={sub}>
              {preview.missing?.length ? (
                <div style={{ fontSize: 12.5, color: HZ.warn }}>Can't amend the Master B/L yet: add {preview.missing.join("; ")}.</div>
              ) : !preview.changes?.length ? (
                <div style={{ fontSize: 12.5 }}>Nothing to amend: the shipment says what the issued B/L says. Correct the shipment first, then come back.</div>
              ) : (<>
                <h3 style={{ ...subTitle, color: HZ.warn }}>The shipment differs from the issued B/L</h3>
                {changeRows(preview.changes, "On the B/L", "Shipment now")}
                <div style={{ fontSize: 11.5, color: HZ.textMuted, lineHeight: 1.55 }}>
                  CargoDesk sends the issued B/L with {preview.changes.length === 1 ? "this correction" : `these ${preview.changes.length} corrections`} as a DCSA amendment. Everything else stays as issued.
                </div>
              </>)}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
                <Btn id="mbl-amend-keep" size="sm" variant="secondary" disabled={busy === "amend"} onClick={() => setPreview(null)}>{preview.changes?.length && !preview.missing?.length ? "Keep the issued B/L" : "Close"}</Btn>
                {!!preview.changes?.length && !preview.missing?.length && (
                  <Btn id="mbl-amend-send" size="sm" disabled={!!busy} onClick={sendAmendment}>{busy === "amend" ? "Sending…" : `Send amendment to ${carrier}`}</Btn>)}
              </div>
            </div>
          )}

          {amendment && !preview && (
            <div id="mbl-amendment" style={sub}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <h3 style={subTitle}>{amendStatus === "AMENDMENT_DECLINED" ? "Amendment declined" : amendStatus === "AMENDMENT_CONFIRMED" ? "Amendment accepted" : "Amendment requested"}
                  {" · "}{fmt(amendment.requestedAt)}{amendment.requestedBy ? ` · ${amendment.requestedBy}` : ""}</h3>
                {amendStatus === "AMENDMENT_DECLINED" ? chip("DECLINED", "critBg", "crit") : amendStatus === "AMENDMENT_CONFIRMED" ? chip("ACCEPTED", "goodBg", "goodPillText")
                  : chip(`WAITING FOR ${carrier}`.toUpperCase(), "infoBg", "infoPillText")}
              </div>
              {changeRows(amendment.changes || [], "Issued", amendStatus === "AMENDMENT_CONFIRMED" ? "Accepted" : "Requested")}
              {amendStatus === "AMENDMENT_CONFIRMED" && <div style={{ fontSize: 11.5, color: HZ.textMuted }}>A task is on the export office's Kanban until {carrier} has the originals back. For an electronic B/L, the eBL platform surrenders it instead.</div>}
              {amendStatus === "AMENDMENT_DECLINED" && <div style={{ fontSize: 11.5, color: HZ.textMuted }}>Correct the shipment again and request a new amendment, or settle it with {carrier} directly.</div>}
              {amendStatus === "AMENDMENT_RECEIVED" && canEdit && (
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <Btn id="mbl-amend-cancel" size="sm" variant="danger" disabled={!!busy} onClick={cancelAmendment}>{busy === "cancelAmend" ? "Withdrawing…" : "Cancel the amendment"}</Btn>
                </div>)}
            </div>
          )}

          {amended && !preview && (amended.detail?.changes || []).length > 0 && (
            <div id="mbl-amended" style={sub}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <h3 style={subTitle}>Amended · {day(amended.detail?.issueDate) || fmt(amended.createdAt)}</h3>
                {chip(`${amended.detail.changes.length} CHANGE${amended.detail.changes.length === 1 ? "" : "S"}`, "goodBg", "goodPillText")}
              </div>
              {amended.detail.changes.map(c => (
                <div key={c.key} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: `1px solid ${HZ.border}`, fontSize: 12.5 }}>
                  <span style={{ color: HZ.textMuted }}>{whereOf(c)}</span>
                  <span><span style={{ color: HZ.textMuted, textDecoration: "line-through" }}>{c.was}</span> → {c.now} <span aria-label="as on the shipment" style={{ color: HZ.good, fontWeight: 700 }}>✓</span></span>
                </div>))}
            </div>
          )}

          {diffCount > 0 && (
            <div id="mbl-diffs" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: HZ.warn }}>Differs from what you sent</h3>
              {[...diffs, ...missingContainers].map(d => {
                const group = groups.find(g => g.rows.includes(d) || g.rows.some(r => r.key === d.key))?.title;
                return (
                  <div key={d.key} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr)", gap: 12, alignItems: "baseline",
                    padding: "9px 12px", borderRadius: 8, background: HZ.warnBg, fontSize: 12.5 }}>
                    <span style={{ fontWeight: 600 }}>{[group && group !== "Document" && group !== "Parties" && group !== "Route" ? group : "", d.label.trim()].filter(Boolean).join(" · ")}</span>
                    <span><span style={{ fontSize: 11, color: HZ.textMuted }}>Sent </span>{d.sent}</span>
                    <span style={{ color: HZ.warn, fontWeight: 700 }}><span style={{ fontSize: 11, color: HZ.textMuted, fontWeight: 400 }}>{carrier} </span>{d.carrier}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div id="mbl-facts" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "4px 28px", fontSize: 12.5 }}>
            {facts.map(f => (
              <div key={f.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "6px 0", borderBottom: `1px solid ${HZ.border}` }}>
                <span style={{ color: HZ.textMuted }}>{f.label}</span>
                <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, textAlign: "right" }}>
                  <span style={f.changed ? { color: HZ.warn, fontWeight: 700 } : {}}>{f.value}</span>
                  <span aria-label={f.changed ? "differs from what you sent" : "same as sent"} style={{ ...mono, fontWeight: 700, fontSize: 12, color: f.changed ? HZ.warn : HZ.good }}>{f.changed ? "≠" : "✓"}</span>
                </span>
              </div>
            ))}
          </div>

          {fieldCount > 0 && (
            <div>
              <button type="button" id="mbl-show-all" onClick={() => setAll(a => !a)} aria-expanded={all} aria-controls="mbl-all-fields"
                style={{ minHeight: 32, padding: "0 12px", borderRadius: 7, border: `1px solid ${HZ.borderStrong}`, background: "transparent", color: HZ.cyan, fontSize: 12.5, cursor: "pointer", fontFamily: HZ_BODY }}>
                {all ? "Hide the field-by-field list" : `Show all ${fieldCount} fields`}
              </button>
            </div>
          )}
          {all && (
            <div id="mbl-all-fields" style={{ overflowX: "auto", border: `1px solid ${HZ.border}`, borderRadius: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 620 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${HZ.border}` }}>
                    <th scope="col" style={{ ...th, width: "30%" }}>Field</th>
                    <th scope="col" style={th}>Sent (Shipping Instructions)</th>
                    <th scope="col" style={th}>{carrier}'s {mbl.status === "DRAFT" ? "draft" : "Master B/L"}</th>
                    <th scope="col" style={{ width: 40 }}><span style={{ position: "absolute", left: -9999 }}>Same or changed</span></th>
                  </tr>
                </thead>
                {groups.map(g => (
                  <tbody key={g.title}>
                    <tr><th scope="rowgroup" colSpan={4} style={{ textAlign: "left", padding: "12px 12px 4px", fontFamily: HZ_DISPLAY, fontSize: 12, fontWeight: 700, color: HZ.text }}>{g.title}</th></tr>
                    {g.rows.map(r => (
                      <tr key={r.key} style={r.changed ? { background: HZ.warnBg } : {}}>
                        <td style={{ padding: "7px 12px", color: HZ.textMuted }}>{r.label}</td>
                        <td style={{ padding: "7px 12px" }}>{r.sent}</td>
                        <td style={{ padding: "7px 12px", ...(r.changed ? { color: HZ.warn, fontWeight: 700 } : {}) }}>{r.carrier}</td>
                        <td style={{ padding: "7px 12px", textAlign: "center", ...mono, fontWeight: 700, color: r.changed ? HZ.warn : HZ.textMuted }}>{r.changed ? "≠" : "="}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
              <div style={{ padding: "10px 12px", fontSize: 11.5, color: HZ.textMuted, lineHeight: 1.55, borderTop: `1px solid ${HZ.border}` }}>
                Ports and the vessel are compared with the shipment, the rest with the Shipping Instructions {carrier} holds.
              </div>
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
            {isDraft && <span style={{ marginRight: "auto", fontSize: 11.5, color: HZ.textMuted }}>A review task is on the export office's Kanban until the draft is approved.</span>}
            {canAmend && !amendment && !preview && <span style={{ marginRight: "auto", fontSize: 11.5, color: HZ.textMuted }}>Correct the shipment first; the request sends only what differs.</span>}
            {amendStatus === "AMENDMENT_RECEIVED" && <span style={{ marginRight: "auto", fontSize: 11.5, color: HZ.textMuted }}>{carrier} hasn't worked on it yet, so it can still be cancelled.</span>}
            {canEdit && <Btn id="mbl-refresh-btn" size="sm" variant="secondary" disabled={!!busy} onClick={refresh}>{busy === "refresh" ? "Asking…" : `Ask ${carrier} again`}</Btn>}
            {isDraft && canEdit && <Btn id="mbl-approve-btn" size="sm" disabled={!!busy} onClick={approve}>{busy === "approve" ? "Approving…" : "Approve draft"}</Btn>}
            {canAmend && !preview && (
              <Btn id="mbl-amend-btn" size="sm" disabled={!!busy} onClick={requestAmendment}>
                {busy === "preview" ? "Checking…" : amendStatus === "AMENDMENT_DECLINED" ? "Request a new amendment" : "Request amendment"}</Btn>)}
          </div>
        </div>
      )}
    </div>
  );
};

export default MasterBlPanel;
