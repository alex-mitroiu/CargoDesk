import { useState, useEffect, useCallback } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import { HZ, HZ_MONO, HZ_BODY, useHorizonFonts } from "../../pages/shipments/shipmentDetailTheme";

// ─── The carrier's Master B/L, as sent to you (2026-11-10, mockup ceca35b0, ARCHITECTURE.md §8.49) ──────────────────
// On the shipment's Documents page, under the House B/L. Reads GET /api/shipments/:id/master-bl/custody (lib/carrier-mbl.js):
// the carrier's issued B/L printed from its DCSA data (a copy) or its PDF uploaded and read; and where it is until the
// carrier releases the cargo: paper originals (received → sent to destination → surrendered → released, or surrendered at
// origin), an eBL on a platform (tracked, each step marked by hand), or a sea waybill (the release only). Reviewing and
// approving the carrier's draft stays on Shipping Instructions.

const today = () => new Date().toISOString().slice(0, 10);
const fmtDay = d => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const fmtWhen = iso => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const card = () => ({ padding: "16px 18px", borderRadius: 10, background: HZ.surface, border: `1px solid ${HZ.border}`, display: "flex", flexDirection: "column", gap: 12 });
const box = () => ({ display: "flex", flexDirection: "column", gap: 8, padding: "11px 13px", borderRadius: 8, border: `1px solid ${HZ.borderStrong}` });
const inputStyle = () => ({ padding: "6px 8px", borderRadius: 6, border: `1px solid ${HZ.borderStrong}`, background: HZ.bg, color: HZ.text, fontFamily: HZ_BODY, fontSize: 12.5 });
const fieldLabel = () => ({ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: HZ.textMuted });
const chip = (bg, fg, border) => ({ fontFamily: HZ_MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", padding: "3px 9px",
  borderRadius: 999, background: bg, color: fg, border: `1px solid ${border}`, whiteSpace: "nowrap" });
const note = tone => ({ display: "flex", gap: 9, alignItems: "flex-start", padding: "9px 11px", borderRadius: 8, fontSize: 13,
  background: tone === "ok" ? HZ.goodBg : tone === "warn" ? HZ.warnBg : HZ.cyanBg, border: `1px solid ${(tone === "ok" ? HZ.good : tone === "warn" ? HZ.warn : HZ.cyan)}55` });
const FORM_LABEL = { PAPER: "Paper originals", EBL: "eBL on a platform", SWB: "Sea waybill" };
const fileToDataUrl = file => new Promise((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error("The file couldn't be read")); r.readAsDataURL(file);
});

// One line of history, in words.
export const stepText = e => {
  const d = e.detail || {};
  const on = d.on ? `, ${fmtDay(d.on)}` : "";
  switch (e.step) {
    case "RECEIVED": return `${d.count} of ${d.of} originals received${d.from ? ` from ${d.from}` : ""}${on}${d.courier ? `, by ${d.courier}` : ""}`;
    case "SENT": return `Sent to ${d.to}${on}${d.courier ? `, by ${d.courier}` : ""}`;
    case "ISSUED": return `eBL issued on ${d.platform}${d.reference ? ` (${d.reference})` : ""}${d.issuedTo ? ` to ${d.issuedTo}` : ""}${on}`;
    case "TRANSFERRED": return `eBL transferred to ${d.to}${on}`;
    case "SURRENDERED": return `${d.count ? `${d.count} original${d.count === 1 ? "" : "s"} surrendered` : "Surrendered"} to ${d.to}${d.kind === "origin" ? " at origin" : ""}${on}`;
    case "RELEASED": return `Released by the carrier${on}${d.ref ? `, ref ${d.ref}` : ""}`;
    default: return e.label || e.step;
  }
};

export default function CarrierMasterBlPanel({ shipment, canEdit, onChanged }) {
  useHorizonFonts();
  const [v, setV] = useState(null);
  const [busy, setBusy] = useState(null);
  const [nextStep, setNextStep] = useState(null);
  const [f, setF] = useState({});
  const [ticks, setTicks] = useState({});
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoReason, setUndoReason] = useState("");

  const load = useCallback(async () => {
    const r = await api.masterBl.custody(shipment.id).catch(() => null);
    setV(r);
  }, [shipment.id]);
  useEffect(() => { load(); }, [load]);
  // The next step's form starts from what's known (the originals, the carrier, the import office).
  const stage = v?.stage || "";
  useEffect(() => {
    if (!v) return;
    const step = v.next[0]?.step || null;
    setNextStep(step);
    const received = v.events.filter(e => !e.undone && e.step === "RECEIVED").slice(-1)[0]?.detail?.count;
    setF({ on: today(), count: String(received || v.originalsTotal), from: shipment.carrierCode || "", to: "", courier: "", ref: "",
      platform: v.ebl.platform || "", reference: v.ebl.reference || "", issuedTo: v.ebl.issuedTo || "" });
    setTicks({});
  }, [v?.stage, v?.form, v?.pdf?.documentId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!v) return null;
  const act = async (key, fn, done) => {
    setBusy(key);
    try { const r = await fn(); if (r) setV(r); if (done) toast.success(done); onChanged?.(); }
    catch (ex) { toast.error(ex.message); await load(); }
    finally { setBusy(null); }
  };
  const m = v.master;
  const nothing = !m && !v.pending && !v.number && !v.pdf && !v.events.length;
  const statusChip = v.released ? chip(HZ.cyanBg, HZ.cyan, HZ.cyan + "66")
    : m ? chip(HZ.goodBg, HZ.good, HZ.good + "66") : chip(HZ.surface2, HZ.textMuted, HZ.borderStrong);
  const statusText = v.released ? "RELEASED" : m ? "ISSUED" : v.pending ? `AT THE CARRIER · ${v.pending.status}` : v.pdf ? "FROM ITS PDF" : "NOT ISSUED YET";
  const formChip = v.form === "PAPER" ? `${v.originalsTotal} PAPER ORIGINAL${v.originalsTotal === 1 ? "" : "S"}` : v.form === "EBL" ? `eBL${v.ebl.platform ? ` · ${v.ebl.platform}` : ""}` : "SEA WAYBILL";
  const check = v.pdf?.check || null;
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  const field = (k, label, { style, ...props } = {}) => (
    <label style={fieldLabel()}>{label}<input data-testid={`carrier-mbl-field-${k}`} value={f[k] ?? ""} onChange={set(k)} {...props} style={{ ...inputStyle(), ...(style || {}) }} /></label>
  );
  const fieldsFor = step => {
    if (step === "RECEIVED") return <>{field("count", `Originals received (of ${v.originalsTotal})`, { type: "number", min: 1, max: v.originalsTotal, style: { width: 90 } })}{field("from", "From")}{field("courier", "Courier and tracking")}</>;
    if (step === "SENT") return <>{field("to", "To", { placeholder: shipment.imoOfficeName ? `${shipment.imoOfficeCode} ${shipment.imoOfficeName}` : "Your destination office or agent", list: "carrier-mbl-to-options" })}{field("courier", "Courier and tracking")}</>;
    if (step === "TRANSFERRED") return field("to", "Transferred to", { placeholder: "Your destination agent's account", list: "carrier-mbl-to-options" });
    if (step === "ISSUED") return <>
      <label style={fieldLabel()}>Platform<select data-testid="carrier-mbl-field-platform" value={f.platform} onChange={set("platform")} style={inputStyle()}>
        <option value="">Choose…</option>{v.platforms.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
      {field("reference", "eBL reference on the platform")}{field("issuedTo", "Issued to (your account)")}</>;
    if (step === "SURRENDERED") return <>{v.form === "PAPER" && field("count", "Originals surrendered", { type: "number", min: 1, style: { width: 90 } })}
      {field("to", "To the carrier at", { placeholder: stage === "RECEIVED" || stage === "ISSUED" ? `${shipment.carrierCode || "The carrier"}, at origin` : `${shipment.carrierCode || "The carrier"}, at destination` })}</>;
    if (step === "RELEASED") return field("ref", "The carrier's release reference (optional)");
    return null;
  };
  const record = () => act("step", () => api.masterBl.recordStep(shipment.id, {
    step: nextStep, on: f.on, ...(["RECEIVED", "SURRENDERED"].includes(nextStep) && f.count !== "" && { count: Number(f.count) }),
    ...(f.from && { from: f.from }), ...(f.to && { to: f.to }), ...(f.courier && { courier: f.courier }), ...(f.ref && { ref: f.ref }),
    ...(nextStep === "ISSUED" && { platform: f.platform, reference: f.reference, issuedTo: f.issuedTo }),
  }), "Recorded");
  const upload = async file => {
    if (!file) return;
    if (file.type && file.type !== "application/pdf") return toast.error("Choose the carrier's PDF");
    await act("pdf", async () => api.masterBl.uploadPdf(shipment.id, { data: await fileToDataUrl(file), filename: file.name }), "The carrier's PDF is saved to Documents");
  };
  const checkItems = check && !check.readable
    ? [`blNumber:${check.blNumber.value}`, ...check.containers.map(c => `container:${c.number}`), ...(check.vessel.value ? [`vessel:${check.vessel.value}`] : [])] : [];
  const byEyeTicked = k => ticks[k] ?? (check?.byEye?.ticked || []).includes(k);

  return (
    <section id="carrier-mbl-panel" data-testid="carrier-mbl-panel" style={{ ...card(), fontFamily: HZ_BODY, color: HZ.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontFamily: HZ_MONO, fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted }}>Carrier's Master B/L</span>
          <span data-testid="carrier-mbl-number" style={{ fontSize: 16, fontWeight: 700 }}>
            {v.number ? <span style={{ fontFamily: HZ_MONO }}>{v.number}</span> : "No Master B/L number yet"}
            {m?.issueDate ? <span style={{ fontWeight: 500, color: HZ.textMuted }}> · issued by {v.carrierCode || "the carrier"} {fmtDay(m.issueDate)}</span> : null}
          </span>
          <span style={{ fontSize: 12, color: HZ.textMuted }}>
            {m ? `From ${v.carrierCode || "the carrier"}'s DCSA transport document · ${m.typeCode === "SWB" ? "Sea waybill" : "Bill of Lading"}${m.originals ? `, ${m.originals} original${m.originals === 1 ? "" : "s"}` : ""}${m.isToOrder ? ", to order" : ""}${m.shippedOnBoardDate ? ` · shipped on board ${fmtDay(m.shippedOnBoardDate)}` : ""}`
              : v.pending ? `${v.carrierCode || "The carrier"} drafted it from your Shipping Instructions (${v.pending.status}): review it there. It can be printed here once the carrier issues it.`
                : v.pdf ? `From the carrier's PDF${v.pdf.createdAt ? `, saved ${fmtDay(v.pdf.createdAt)}` : ""}`
                  : v.events.length ? `Tracked by hand.${v.number ? "" : " Type the Master B/L number on Conditions to keep it with these steps."}` : "Nothing from the carrier yet."}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span data-testid="carrier-mbl-status" style={statusChip}>{statusText}</span>
          <span data-testid="carrier-mbl-form-chip" style={chip(HZ.cyanBg, HZ.cyan, HZ.cyan + "55")}>{formChip}</span>
        </div>
      </div>

      {m && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "4px 18px", fontSize: 13 }}>
          {[["Shipper", m.shipper], ["Consignee", m.consignee], ["Notify", m.notify.join(", ")],
            ["Containers", m.containers.map(c => `${c.number}${c.iso ? ` (${c.iso})` : ""}`).join(" · ")]].map(([k, val]) => (
            <div key={k} style={{ display: "flex", gap: 10 }}><span style={{ color: HZ.textMuted, minWidth: 82 }}>{k}</span><span>{val || "—"}</span></div>
          ))}
        </div>
      )}

      {/* The document: the carrier's B/L printed from its data, or its PDF */}
      <div style={box()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <b style={{ fontSize: 13 }}>The document</b>
          {canEdit && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {v.canPrint && <Btn data-testid="carrier-mbl-print" disabled={!!busy} onClick={() => act("print", () => api.masterBl.printCopy(shipment.id), "The carrier's B/L is printed to Documents (MB01)")}>
                {busy === "print" ? "Printing…" : v.print ? "Print again" : "Print the carrier's B/L"}</Btn>}
              <label style={{ display: "inline-flex" }}>
                <span role="button" tabIndex={0} style={{ padding: "6px 12px", borderRadius: 7, border: `1px solid ${HZ.borderStrong}`, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  {busy === "pdf" ? "Reading…" : v.pdf ? "Replace the carrier's PDF" : "Upload the carrier's PDF"}</span>
                <input type="file" accept="application/pdf" data-testid="carrier-mbl-pdf-input" style={{ display: "none" }} onChange={e => { upload(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
            </div>
          )}
        </div>
        {nothing && <span style={{ fontSize: 12.5, color: HZ.textMuted }}>When the carrier issues its Master B/L from your Shipping Instructions, it shows here and can be printed. If the carrier sends a PDF instead, upload it: CargoDesk reads it and checks it is this shipment's.</span>}
        {v.print && (
          <div data-testid="carrier-mbl-print-doc" style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, flexWrap: "wrap" }}>
            <span style={{ fontFamily: HZ_MONO, fontSize: 12 }}>{v.print.filename}</span>
            <span style={{ color: HZ.textMuted, fontSize: 12 }}>printed {fmtWhen(v.print.createdAt)} · a copy, marked COPY · NOT NEGOTIABLE, with the carrier's terms</span>
            <Btn variant="secondary" onClick={() => api.documents.download(shipment.id, v.print.documentId, v.print.filename).catch(e => toast.error(e.message))}>Download</Btn>
          </div>
        )}
        {v.pdf && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, flexWrap: "wrap" }}>
              <span data-testid="carrier-mbl-pdf-doc" style={{ fontFamily: HZ_MONO, fontSize: 12 }}>{v.pdf.filename}</span>
              <span style={{ color: HZ.textMuted, fontSize: 12 }}>saved {fmtWhen(v.pdf.createdAt)}{v.pdf.by ? ` by ${v.pdf.by}` : ""}</span>
              <Btn variant="secondary" onClick={() => api.documents.download(shipment.id, v.pdf.documentId, v.pdf.filename).catch(e => toast.error(e.message))}>Download</Btn>
              {canEdit && <Btn variant="secondary" disabled={!!busy} onClick={() => act("check", () => api.masterBl.checkPdf(shipment.id), "Checked again")}>Check again</Btn>}
            </div>
            {check?.readable && (
              <div data-testid="carrier-mbl-checks" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[check.blNumber.value
                  ? { ok: check.blNumber.found, key: "bl", text: check.blNumber.found ? `B/L number ${check.blNumber.value} found` : `B/L number ${check.blNumber.value} not in the PDF` }
                  : { ok: false, key: "bl", text: "No Master B/L number on the shipment to look for: type it on Conditions, then check again" },
                ...check.containers.map(c => ({ ok: c.found, key: c.number, text: c.found ? `Container ${c.number} found` : `Container ${c.number} not in the PDF` })),
                ...check.others.map(n => ({ ok: false, key: `o-${n}`, text: `The PDF names container ${n}, which isn't on this shipment: ask the carrier, or check the shipment's containers` })),
                ...(check.vessel.value ? [{ ok: check.vessel.found, key: "vessel", text: check.vessel.found ? `Vessel ${check.vessel.value} found` : `Vessel ${check.vessel.value} not in the PDF` }] : []),
                ].map(i => <div key={i.key} data-testid={`carrier-mbl-check-${i.key}`} style={note(i.ok ? "ok" : "warn")}><b>{i.ok ? "✓" : "!"}</b><span>{i.text}</span></div>)}
              </div>
            )}
            {check && !check.readable && (
              <div data-testid="carrier-mbl-scan" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={note("warn")}><b>!</b><span><b>No text in this PDF</b> (a scan or a photo): CargoDesk can't read it. Check it by eye{check.byEye?.complete ? `: all checked by ${check.byEye.by}` : ":"}</span></div>
                {checkItems.map(k => (
                  <label key={k} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                    <input type="checkbox" data-testid={`carrier-mbl-tick-${k}`} disabled={!canEdit} checked={byEyeTicked(k)} onChange={e => setTicks(t => ({ ...t, [k]: e.target.checked }))} />
                    {k.startsWith("blNumber:") ? `B/L number ${k.slice(9) || "(none on the shipment)"}` : k.startsWith("container:") ? `Container ${k.slice(10)}` : `Vessel ${k.slice(7)}`}
                  </label>
                ))}
                {canEdit && <div><Btn variant="secondary" disabled={!!busy} onClick={() => act("ticks", () => api.masterBl.checkPdf(shipment.id, { byEye: Object.fromEntries(checkItems.map(k => [k, byEyeTicked(k)])) }), "Saved")}>Save what I checked</Btn></div>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* The form, before any step */}
      {canEdit && !v.locked && (
        <div style={box()} data-testid="carrier-mbl-setup">
          <b style={{ fontSize: 13 }}>How the carrier issued it</b>
          <div role="radiogroup" aria-label="Form" style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {["PAPER", "EBL", "SWB"].map(k => (
              <label key={k} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                <input type="radio" name={`carrier-mbl-form-${shipment.id}`} data-testid={`carrier-mbl-form-${k}`} checked={v.form === k} disabled={!!busy}
                  onChange={() => act("form", () => api.masterBl.setup(shipment.id, { form: k }))} />{FORM_LABEL[k]}
              </label>
            ))}
          </div>
          <span style={{ fontSize: 12, color: HZ.textMuted }}>
            {v.formSource === "carrier" ? "As the carrier's document says." : v.formSource === "release type" ? "From the shipment's Master B/L release type." : v.formSource === "set" ? "Set here." : "Paper unless you say otherwise."}
            {v.form === "PAPER" && ` ${v.originalsTotal} originals.`} Fixed once a step is recorded.
          </span>
          {v.form === "PAPER" && (
            <label style={{ ...fieldLabel(), maxWidth: 160 }}>Originals in the set
              <input type="number" min={1} max={9} data-testid="carrier-mbl-originals" defaultValue={v.originalsTotal} key={v.originalsTotal}
                onBlur={e => Number(e.target.value) !== v.originalsTotal && act("form", () => api.masterBl.setup(shipment.id, { originalsTotal: Number(e.target.value) }))}
                style={{ ...inputStyle(), width: 80, fontFamily: HZ_MONO }} /></label>
          )}
        </div>
      )}

      {/* Where it is, step by step */}
      <div style={box()}>
        <b style={{ fontSize: 13 }}>{v.form === "SWB" ? "A sea waybill has nothing to surrender: the carrier releases to the named consignee" : "Where it is, until the carrier releases the cargo"}</b>
        <ol data-testid="carrier-mbl-steps" style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(160px, 1fr))`, gap: 8 }}>
          {v.path.map((p, i) => {
            const now = !p.done && v.path.findIndex(x => !x.done) === i;
            return (
              <li key={p.step} data-testid={`carrier-mbl-step-${p.step}`} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "9px 10px", borderRadius: 8, fontSize: 12.5,
                background: p.done ? HZ.goodBg : now ? HZ.cyanBg : HZ.surface2, border: `1px solid ${p.done ? HZ.good + "66" : now ? HZ.cyan : HZ.border}` }}>
                <span style={{ fontFamily: HZ_MONO, fontSize: 11, fontWeight: 700, color: p.done ? HZ.good : now ? HZ.cyan : HZ.textFaint }}>{p.done ? "✓ done" : now ? `${i + 1} · next` : `${i + 1} · later`}</span>
                <b>{p.label}</b>
                {p.done && p.detail?.on && <span style={{ color: HZ.textMuted }}>{fmtDay(p.detail.on)}</span>}
              </li>
            );
          })}
        </ol>
        {canEdit && v.next.length > 0 && (
          <div data-testid="carrier-mbl-next" style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", padding: "10px 12px", borderRadius: 8, border: `1px solid ${HZ.border}` }}>
            {v.next.length > 1 ? (
              <label style={fieldLabel()}>Next
                <select data-testid="carrier-mbl-next-select" value={nextStep || ""} onChange={e => setNextStep(e.target.value)} style={inputStyle()}>
                  {v.next.map(n => <option key={n.step} value={n.step}>{n.label}</option>)}
                </select></label>
            ) : <b style={{ fontSize: 13, alignSelf: "center" }}>{v.next[0].label}</b>}
            {fieldsFor(nextStep)}
            {field("on", "On", { type: "date", max: today() })}
            <datalist id="carrier-mbl-to-options">
              {shipment.imoOfficeName && <option value={`${shipment.imoOfficeCode} ${shipment.imoOfficeName}`} />}
              <option value="Line Agent (Import)" />
            </datalist>
            <Btn data-testid="carrier-mbl-record" disabled={!!busy || !f.on} onClick={record}>{busy === "step" ? "Recording…" : `Record: ${(v.next.find(n => n.step === nextStep)?.label || "").toLowerCase()}`}</Btn>
          </div>
        )}
        {v.released && <div style={note("ok")}><b>✓</b><span>Released by the carrier. The House B/L's release at destination no longer notes the Master.</span></div>}
        {v.form === "EBL" && !v.released && <span style={{ fontSize: 12, color: HZ.textMuted }}>CargoDesk doesn't connect to the platform: mark each step here after doing it there.</span>}
        {canEdit && v.locked && (
          undoOpen ? (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <label style={{ ...fieldLabel(), flex: 1, minWidth: 240 }}>Why undo the last step?
                <input data-testid="carrier-mbl-undo-reason" value={undoReason} onChange={e => setUndoReason(e.target.value)} placeholder="e.g. recorded on the wrong shipment" style={inputStyle()} /></label>
              <Btn variant="secondary" onClick={() => { setUndoOpen(false); setUndoReason(""); }}>Cancel</Btn>
              <Btn variant="danger" data-testid="carrier-mbl-undo-confirm" disabled={!undoReason.trim() || !!busy}
                onClick={() => act("undo", () => api.masterBl.undoStep(shipment.id, undoReason.trim()), "Undone").then(() => { setUndoOpen(false); setUndoReason(""); })}>Undo it</Btn>
            </div>
          ) : <div><button type="button" data-testid="carrier-mbl-undo" onClick={() => setUndoOpen(true)}
            style={{ background: "none", border: "none", color: HZ.textMuted, textDecoration: "underline", cursor: "pointer", fontSize: 12, padding: 0 }}>Undo the last step…</button></div>
        )}
        {v.events.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table data-testid="carrier-mbl-history" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead><tr>{["When", "What", "By"].map(h => <th key={h} style={{ textAlign: "left", fontFamily: HZ_MONO, fontSize: 10.5, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: ".05em", padding: "5px 8px", borderBottom: `1px solid ${HZ.border}` }}>{h}</th>)}</tr></thead>
              <tbody>{[...v.events].reverse().map(e => (
                <tr key={e.id} style={{ opacity: e.undone ? 0.55 : 1 }}>
                  <td style={{ padding: "5px 8px", borderBottom: `1px solid ${HZ.border}`, fontFamily: HZ_MONO, whiteSpace: "nowrap" }}>{fmtWhen(e.createdAt)}</td>
                  <td style={{ padding: "5px 8px", borderBottom: `1px solid ${HZ.border}` }}>
                    <span style={{ textDecoration: e.undone ? "line-through" : "none" }}>{stepText(e)}</span>
                    {e.undone && <span style={{ color: HZ.textMuted }}> · undone{e.undoneBy ? ` by ${e.undoneBy}` : ""}: {e.undoReason}</span>}
                  </td>
                  <td style={{ padding: "5px 8px", borderBottom: `1px solid ${HZ.border}` }}>{e.actor || "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
