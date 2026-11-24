import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import { HZ, HZ_MONO, HZ_BODY } from "../../pages/shipments/shipmentDetailTheme";
import { pillBtnStyle, sectionLabelStyle } from "../../pages/shipments/schedules/SchedulesParts";
import { FoldSection, FactsPills } from "./FoldSection";

// ─── Carrier Booking → Details → Transport document and loading ───────────────────────────────────────────────────
// TKT-JV1SF2 point 5 (2026-11-23, mockup dffb8ab2 approved "as drawn"; ARCHITECTURE.md §8.58): the five DCSA Booking 2.0
// fields the request never sent. Each optional; nothing stated, nothing sent (the user's decision). Kept on the shipment
// (GET/PUT /api/shipments/:id/booking-request-options, lib/booking-request-options.js); a choice saves at once, a typed
// field when it's left. What the request carries comes back from the server and shows under the fields.

const DOC_TYPES = [["", "Not stated"], ["BOL", "Bill of lading"], ["SWB", "Sea waybill"]];
const PARTIAL = [[null, "Not stated"], [true, "Allowed"], [false, "Not allowed"]];

const label = () => ({ fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted });
const hint = () => ({ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted, lineHeight: 1.45 });
const input = disabled => ({ fontFamily: HZ_MONO, fontSize: 13, color: HZ.text, background: HZ.surface2, border: `1px solid ${HZ.border}`, borderRadius: 10,
  padding: "8px 12px", width: "100%", boxSizing: "border-box", opacity: disabled ? 0.6 : 1 });
const inset = () => ({ background: HZ.tint, border: `1px solid ${HZ.border}`, borderRadius: 12, padding: "14px 16px", display: "grid", gap: 10, alignContent: "start", minWidth: 0 });

function Choice({ id, options, value, onChange, disabled }) {
  return (
    <span role="group" aria-label={id} style={{ display: "inline-flex", flexWrap: "wrap", gap: 2, padding: 3, border: `1px solid ${HZ.border}`, borderRadius: 999,
      background: HZ.surface2, width: "fit-content" }}>
      {options.map(([v, text]) => {
        const on = value === v;
        return (
          <button key={String(v)} type="button" data-testid={`${id}-${v === null || v === "" ? "none" : String(v)}`} aria-pressed={on} disabled={disabled} onClick={() => !on && onChange(v)}
            style={{ fontFamily: HZ_BODY, fontSize: 12, fontWeight: 600, border: 0, borderRadius: 999, padding: "4px 12px", cursor: disabled ? "default" : "pointer",
              background: on ? HZ.cyanBg : "transparent", color: on ? HZ.cyan : HZ.textMuted,
              boxShadow: on ? `inset 0 0 0 1px color-mix(in srgb, ${HZ.cyan} 40%, transparent)` : "none" }}>{text}</button>
        );
      })}
    </span>
  );
}

// Folded: what's stated, one pill each.
const summaryOf = o => {
  const items = [];
  if (o.transportDocumentType) items.push({ label: "Document", value: o.transportDocumentType === "BOL" ? "Bill of lading" : "Sea waybill" });
  if (o.numberOfDocuments != null) items.push({ label: "B/Ls", value: String(o.numberOfDocuments) });
  if (o.placeOfIssue) items.push({ label: "Issued at", value: o.placeOfIssue });
  if (o.partialLoad != null) items.push({ label: "Partial loading", value: o.partialLoad ? "allowed" : "not allowed" });
  if (o.customsReferences.length) items.push({ label: "Customs references", value: String(o.customsReferences.length) });
  return items.length ? items : [{ label: "Nothing stated", value: "none of these is sent" }];
};
const statedCount = dcsa => Object.keys(dcsa || {}).length;

// sentToCarrier: the booking already went (awaiting the answer or confirmed): a change goes with the next update, sent from
// Booking & Review (audit E, 2026-11-24, TKT-EYDOU0).
export function TransportDocumentCard({ shipment, open, onToggle, sentToCarrier = false }) {
  const [data, setData] = useState(null);       // { options, dcsa, canEdit, portOfLoading } as the server has them
  const [draft, setDraft] = useState(null);     // the typed fields and customs rows while being edited
  const [busy, setBusy] = useState(false);
  const fromServer = d => {
    if (!d?.options) return;
    setData(d);
    setDraft({ numberOfDocuments: d.options.numberOfDocuments == null ? "" : String(d.options.numberOfDocuments), placeOfIssue: d.options.placeOfIssue,
      customsReferences: d.options.customsReferences.map(r => ({ type: r.type, countryCode: r.countryCode, value: r.values.join(", ") })) });
  };
  const load = useCallback(() => api.bookingRequestOptions.get(shipment.id).then(fromServer).catch(e => toast.error(e.message)), [shipment.id]);
  useEffect(() => { load(); }, [load]);
  if (!data || !draft) return null;
  const o = data.options;
  const canEdit = !!data.canEdit && !busy;
  const save = async body => {
    setBusy(true);
    try {
      fromServer(await api.bookingRequestOptions.save(shipment.id, body));
      toast.success(sentToCarrier ? "Saved. The carrier gets it with the next update: Booking & Review → Send update to carrier" : "Saved for the booking request");
    }
    catch (e) { toast.error(e.message); await load(); }
    finally { setBusy(false); }
  };
  const refsBody = rows => ({ customsReferences: rows.map(r => ({ type: r.type, countryCode: r.countryCode, values: String(r.value || "").split(",").map(v => v.trim()).filter(Boolean) })) });
  const refsChanged = rows => JSON.stringify(refsBody(rows).customsReferences.filter(r => r.type || r.countryCode || r.values.length))
    !== JSON.stringify(o.customsReferences);
  const n = statedCount(data.dcsa);
  const status = (
    <span data-testid="transport-document-status" style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".04em", padding: "2px 8px", borderRadius: 5,
      background: n ? HZ.cyanBg : HZ.neutralBg, color: n ? HZ.cyan : HZ.textMuted, border: `1px solid ${n ? `color-mix(in srgb, ${HZ.cyan} 40%, transparent)` : HZ.border}` }}>
      {n ? `${n} STATED · ${sentToCarrier ? "GOES WITH THE NEXT UPDATE" : "SENT WITH THE BOOKING"}` : "NOTHING STATED · NOT SENT"}
    </span>
  );

  return (
    <FoldSection id="shpbooking-transport-section" testId="transport-document-section" label="Transport document and loading" status={status}
      open={open} onToggle={onToggle} accent={HZ.cyan} summary={<FactsPills testId="transport-document-summary" items={summaryOf(o)} />}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 230px), 1fr))", gap: "14px 18px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span style={label()}>The carrier's transport document</span>
          <Choice id="td-type" options={DOC_TYPES} value={o.transportDocumentType} disabled={!canEdit} onChange={v => save({ transportDocumentType: v })} />
          <span style={hint()}>What the carrier issues to us (the Master B/L). DCSA transportDocumentTypeCode.</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <label style={label()} htmlFor="td-count">How many B/Ls</label>
          <input id="td-count" data-testid="td-count" type="number" min="1" max="99" placeholder="Not stated" value={draft.numberOfDocuments} disabled={!canEdit}
            onChange={e => setDraft(d => ({ ...d, numberOfDocuments: e.target.value }))}
            onBlur={() => { const v = draft.numberOfDocuments === "" ? null : Number(draft.numberOfDocuments); if (v !== o.numberOfDocuments) save({ numberOfDocuments: v }); }}
            style={input(!canEdit)} />
          <span style={hint()}>The booking split into this many transport documents (not the number of originals). requestedNumberOfTransportDocuments.</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <label style={label()} htmlFor="td-place">Place of B/L issue</label>
          <input id="td-place" data-testid="td-place" placeholder="UN/LOCODE, or a country code" value={draft.placeOfIssue} disabled={!canEdit}
            onChange={e => setDraft(d => ({ ...d, placeOfIssue: e.target.value.toUpperCase() }))}
            onBlur={() => { if (draft.placeOfIssue.trim() !== o.placeOfIssue) save({ placeOfIssue: draft.placeOfIssue.trim() }); }}
            style={input(!canEdit)} />
          {canEdit && data.portOfLoading && o.placeOfIssue !== data.portOfLoading && (
            <button type="button" data-testid="td-place-pol" onClick={() => save({ placeOfIssue: data.portOfLoading })}
              style={{ fontFamily: HZ_BODY, fontSize: 11, fontWeight: 600, color: HZ.cyan, background: "none", border: 0, padding: 0, cursor: "pointer", width: "fit-content" }}>
              Use the port of loading ({data.portOfLoading})</button>
          )}
          <span style={hint()}>Where the original is issued; a UN/LOCODE or a country, not both. placeOfBLIssue.</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span style={label()}>Partial loading</span>
          <Choice id="td-partial" options={PARTIAL} value={o.partialLoad} disabled={!canEdit} onChange={v => save({ partialLoad: v })} />
          <span style={hint()}>May the carrier load what arrived before the cut-off and leave the rest? Left out, carriers read it their own way. isPartialLoadAllowed.</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={label()}>Customs references</span>
        {draft.customsReferences.map((r, i) => {
          const set = (k, v) => setDraft(d => ({ ...d, customsReferences: d.customsReferences.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));
          const blur = () => { if (refsChanged(draft.customsReferences)) save(refsBody(draft.customsReferences)); };
          return (
            <div key={i} data-testid={`td-ref-${i}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,.9fr) minmax(0,.6fr) minmax(0,1.4fr) auto", gap: 8, alignItems: "center" }}>
              <input aria-label={`Customs reference ${i + 1} type`} placeholder="Type, e.g. ACID" value={r.type} disabled={!canEdit} onChange={e => set("type", e.target.value)} onBlur={blur} style={input(!canEdit)} />
              <input aria-label={`Customs reference ${i + 1} country`} placeholder="Country" value={r.countryCode} maxLength={2} disabled={!canEdit}
                onChange={e => set("countryCode", e.target.value.toUpperCase())} onBlur={blur} style={input(!canEdit)} />
              <input aria-label={`Customs reference ${i + 1} value`} placeholder="Value" value={r.value} disabled={!canEdit} onChange={e => set("value", e.target.value)} onBlur={blur} style={input(!canEdit)} />
              <button type="button" aria-label={`Remove customs reference ${i + 1}`} disabled={!canEdit}
                onClick={() => { const rows = draft.customsReferences.filter((_, j) => j !== i); setDraft(d => ({ ...d, customsReferences: rows })); if (refsChanged(rows)) save(refsBody(rows)); }}
                style={{ fontFamily: HZ_MONO, fontSize: 12, fontWeight: 700, color: HZ.textMuted, background: "none", border: `1px solid ${HZ.border}`, borderRadius: 999,
                  width: 28, height: 28, cursor: canEdit ? "pointer" : "default" }}>×</button>
            </div>
          );
        })}
        {canEdit && draft.customsReferences.length < 10 && (
          <button type="button" data-testid="td-ref-add" onClick={() => setDraft(d => ({ ...d, customsReferences: [...d.customsReferences, { type: "", countryCode: "", value: "" }] }))}
            style={{ ...pillBtnStyle(), width: "fit-content" }}>＋ Add a customs reference</button>
        )}
        <span style={hint()}>Asked by some customs at booking time, e.g. Egypt's ACID number. Each: the type as that customs calls it, its country, the value. customsReferences.</span>
      </div>

      <div style={inset()}>
        <div style={sectionLabelStyle()}>In the booking request · DCSA Booking 2.0</div>
        <pre data-testid="transport-document-dcsa" style={{ margin: 0, fontFamily: HZ_MONO, fontSize: 11.5, lineHeight: 1.55, color: HZ.text, background: HZ.surface2,
          border: `1px solid ${HZ.border}`, borderRadius: 10, padding: "10px 12px", overflowX: "auto" }}>
          {n ? JSON.stringify(data.dcsa, null, 2) : "// nothing stated: none of these fields is sent"}
        </pre>
        <div style={{ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted }}>
          Only what's stated goes. Kept on the shipment, set before sending; changed after sending, it goes with the next update or amendment.
          {!data.canEdit && " Only the shipment's OCC/BK (export side), an admin or an operator can change it."}
        </div>
      </div>
    </FoldSection>
  );
}
