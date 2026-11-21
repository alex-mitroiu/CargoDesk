import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import { todayIso } from "../../tokens";
import { Modal } from "../../components/primitives/Modal";
import CustomerCombobox from "../../components/shared/CustomerCombobox";
import HaulageDetailsPanel from "../../components/shared/HaulageDetailsPanel";
import SendDocumentEmailModal from "../../components/shared/SendDocumentEmailModal";
import { IconFlash, IconWarning } from "../../components/primitives/Icon";
import { buildHaulagePlanHtml, fmtHaulageTime } from "../../utils/invoiceGenerator";
import { canEditShipmentSide } from "../../utils/officeSide";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY, useHorizonFonts } from "./shipmentDetailTheme";
import { PillNav, DotPill, frameStyle, sectionLabelStyle, ctaStyle, pillBtnStyle } from "./schedules/SchedulesParts";

// ─── Pickup / Delivery service: the trucker's run (2026-11-20, ARCHITECTURE.md §8.56, mockup 3d91c28a) ───────────────
// Trade Horizon Next (the user's rule: every build uses the latest patterns; the header and the » pill come from
// src/utils/horizonNextPages.js). One route of stops for every container, times per container, the carrier's closing
// times, the trucker in one place, and the trucker's plan (PU01 / DL01). Every rule is on the server (lib/haulage-stops.js):
// each change answers with the whole plan, checks included, and this page only draws it. No frame sets backdrop-filter:
// the customer picker's dropdown is position:fixed (CLAUDE.md).

const DOC_CODE = { Pickup: "PU01", Delivery: "DL01" };
const PLAN_LABEL = { Pickup: "Pickup Plan", Delivery: "Delivery Plan" };
const toneOf = purpose => ({ EMPTY_PICKUP: HZ.violet, EMPTY_RETURN: HZ.violet, LOAD: HZ.amber, UNLOAD: HZ.amber, FULL_GATE_IN: HZ.cyan,
  FULL_PICKUP: HZ.cyan, WEIGH: HZ.info, CUSTOMS: HZ.info }[purpose] || HZ.textMuted);
const statusColor = s => ({ Requested: HZ.info, Confirmed: HZ.good, Completed: HZ.good, Cancelled: HZ.textMuted }[s] || HZ.textMuted);
const initials = name => String(name || "").replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "—";
const SIDE_PURPOSES = { Export: ["EMPTY_PICKUP", "LOAD", "WEIGH", "CUSTOMS", "FULL_GATE_IN", "OTHER"], Import: ["FULL_PICKUP", "CUSTOMS", "UNLOAD", "EMPTY_RETURN", "OTHER"] };

const Card = ({ id, testId, label, right, children, accent }) => (
  <section id={id} data-testid={testId} style={{ ...frameStyle(), scrollMarginTop: 90, ...(accent ? { border: `1px solid color-mix(in srgb, ${accent} 35%, ${HZ.border})` } : {}) }}>
    <div style={{ display: "flex", alignItems: "center", gap: "10px 14px", flexWrap: "wrap", padding: "14px 18px 0" }}>
      <span style={{ ...sectionLabelStyle(), color: HZ.text }}>{label}</span>
      {right && <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{right}</div>}
    </div>
    <div style={{ padding: "14px 18px 18px", display: "grid", gap: 14, fontFamily: HZ_BODY }}>{children}</div>
  </section>
);
const Note = ({ tone = "warn", children, testId }) => {
  const c = tone === "info" ? HZ.info : HZ.warn;
  return (
    <div data-testid={testId} style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text, background: tone === "info" ? HZ.infoBg : HZ.warnBg,
      border: `1px solid color-mix(in srgb, ${c} 40%, transparent)`, borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
      <IconWarning size={13} color={c} /><span>{children}</span>
    </div>
  );
};
const tag = (color, bg) => ({ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".04em",
  padding: "2px 8px", borderRadius: 5, whiteSpace: "nowrap", color, background: bg || `color-mix(in srgb, ${color} 12%, transparent)`,
  border: `1px solid color-mix(in srgb, ${color} 40%, transparent)` });
const neutralTag = () => ({ ...tag(HZ.textMuted, HZ.neutralBg), border: `1px solid ${HZ.border}` });
const inputStyle = (w) => ({ fontFamily: HZ_MONO, fontSize: 12, color: HZ.text, background: HZ.surface2, border: `1px solid ${HZ.border}`, borderRadius: 8,
  padding: "4px 8px", width: w || "100%", minWidth: 0, colorScheme: "inherit" });
const textInput = () => ({ fontFamily: HZ_BODY, fontSize: 13, color: HZ.text, background: HZ.surface2, border: `1px solid ${HZ.border}`, borderRadius: 10,
  padding: "7px 10px", width: "100%", minWidth: 0 });
const smallLabel = () => ({ fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted, marginBottom: 4, display: "block" });

// ── A stop on the route ───────────────────────────────────────────────────────────────────────────────────────────────
const StopRow = ({ stop, index, count, canEdit, onEdit, onRemove, onMove, testId }) => {
  const c = toneOf(stop.purpose);
  const src = stop.place.kind === "customer" ? "The customer's profile (Master Data → Customers)"
    : stop.place.kind === "facility" ? `Master Data → Facilities${stop.place.source === "smdg" ? " · SMDG Terminal Code List" : " · added by hand"}`
    : stop.place.kind === "gps" ? "A GPS point" : stop.place.kind === "address" ? "Typed (moved from the old waypoints)" : "";
  const btn = { background: "none", border: `1px solid ${HZ.border}`, borderRadius: 8, color: HZ.textMuted, width: 28, height: 28, cursor: "pointer", fontSize: 13 };
  return (
    <div data-testid={testId} style={{ display: "grid", gridTemplateColumns: "32px minmax(0,1fr) auto", gap: 12, alignItems: "start", padding: "12px 14px",
      border: `1px solid ${HZ.border}`, borderRadius: 12, background: HZ.tint }}>
      <span aria-hidden style={{ width: 30, height: 30, borderRadius: "50%", display: "grid", placeItems: "center", fontFamily: HZ_DISPLAY, fontSize: 12, fontWeight: 800,
        color: HZ.chipText, background: c, boxShadow: `0 0 12px -2px ${c}` }}>{index + 1}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: c === HZ.textMuted ? HZ.textMuted : c }}>{stop.purposeLabel}</div>
        <div data-testid={`${testId}-place`} style={{ fontFamily: HZ_BODY, fontSize: 13.5, fontWeight: 700, color: stop.place.kind === "none" ? HZ.textMuted : HZ.text,
          fontStyle: stop.place.kind === "none" ? "italic" : "normal", marginTop: 2, overflowWrap: "anywhere" }}>
          {stop.place.kind === "none" ? `Not chosen yet${stop.unlocode ? ` · ${stop.unlocode}` : ""}` : (stop.place.name || "GPS point")}
        </div>
        {stop.place.lines?.length > 0 && <div style={{ fontSize: 12, color: HZ.textMuted }}>{stop.place.lines.join(" · ")}</div>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
          {stop.place.code && <span style={tag(HZ.cyan)}>{stop.place.codeList || "CODE"} {stop.place.code}</span>}
          {stop.contact?.name && stop.contact.name !== stop.place.name && <span style={neutralTag()}>{stop.contact.name}</span>}
          {stop.contact?.phone && <span style={neutralTag()}>{stop.contact.phone}</span>}
          {stop.contact?.email && <span style={neutralTag()}>{stop.contact.email}</span>}
          {stop.effectiveReference && <span style={neutralTag()}>{stop.effectiveReference.toUpperCase()}</span>}
          {stop.notes && <span style={neutralTag()}>{stop.notes}</span>}
        </div>
        {src && <div style={{ fontFamily: HZ_MONO, fontSize: 10.5, color: HZ.textFaint, marginTop: 5 }}>{src}{stop.utcOffset ? ` · local time ${stop.utcOffset}` : ""}</div>}
        {stop.warnings.map(w => <div key={w} data-testid={`${testId}-warning`} style={{ fontSize: 11.5, color: HZ.warn, marginTop: 5 }}>⚠ {w}</div>)}
      </div>
      {canEdit && (
        <div style={{ display: "flex", gap: 4 }}>
          <button type="button" style={btn} disabled={index === 0} aria-label={`Move stop ${index + 1} up`} onClick={() => onMove(index, -1)}>↑</button>
          <button type="button" style={btn} disabled={index === count - 1} aria-label={`Move stop ${index + 1} down`} onClick={() => onMove(index, 1)}>↓</button>
          <button type="button" style={btn} aria-label={`Edit stop ${index + 1}`} data-testid={`${testId}-edit`} onClick={onEdit}>✎</button>
          <button type="button" style={btn} aria-label={`Remove stop ${index + 1}`} data-testid={`${testId}-remove`} onClick={onRemove}>×</button>
        </div>
      )}
    </div>
  );
};

// ── Adding or changing a stop ───────────────────────────────────────────────────────────────────────────────────────
const blankDraft = (side) => ({ purpose: SIDE_PURPOSES[side][0], kind: "facility", customer: { id: "", name: "" }, facility: null,
  lat: "", lng: "", name: "", address: "", reference: "", notes: "" });
const draftOf = stop => ({ purpose: stop.purpose, kind: stop.place.kind === "none" ? "facility" : stop.place.kind,
  customer: stop.place.kind === "customer" ? { id: stop.place.customerId, name: stop.place.name } : { id: "", name: "" },
  facility: stop.place.kind === "facility" ? { id: stop.place.facilityId, name: stop.place.name, code: stop.place.code } : null,
  lat: stop.place.kind === "gps" ? String(stop.place.latitude ?? "") : "", lng: stop.place.kind === "gps" ? String(stop.place.longitude ?? "") : "",
  name: stop.place.kind === "gps" || stop.place.kind === "address" ? stop.place.name || "" : "", address: stop.place.kind === "address" ? (stop.place.lines || []).join("\n") : "",
  reference: stop.reference || "", notes: stop.notes || "", unlocode: stop.unlocode || "" });

const StopEditor = ({ plan, shipment, draft, setDraft, onSave, onCancel, busy, editing }) => {
  const side = plan.service.side;
  const [port, setPort] = useState(draft.unlocode || plan.port?.unlocode || "");
  const [q, setQ] = useState("");
  const [found, setFound] = useState(null);
  const seq = useRef(0);
  useEffect(() => {
    if (draft.kind !== "facility") return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      api.facilities.list({ ...(port ? { unlocode: port.toUpperCase() } : {}), ...(q ? { q } : {}), open: 1, limit: 60 })
        .then(r => n === seq.current && setFound(r)).catch(() => n === seq.current && setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [draft.kind, port, q]);
  const set = patch => setDraft(d => ({ ...d, ...patch }));
  const purposes = [...SIDE_PURPOSES[side], ...plan.purposes.map(p => p.key).filter(k => !SIDE_PURPOSES[side].includes(k))];
  const label = k => plan.purposes.find(p => p.key === k)?.label || k;
  const kinds = [["facility", "Terminal or depot"], ["customer", "Customer"], ["gps", "GPS point"], ...(draft.kind === "address" ? [["address", "Typed address"]] : [])];
  const chip = on => ({ fontFamily: HZ_BODY, fontSize: 11.5, fontWeight: 600, borderRadius: 999, padding: "4px 11px", cursor: "pointer",
    border: `1px solid ${on ? `color-mix(in srgb, ${HZ.cyan} 50%, transparent)` : HZ.border}`, background: on ? HZ.cyanBg : "transparent", color: on ? HZ.cyan : HZ.textMuted });
  const gateStop = ["EMPTY_PICKUP", "FULL_GATE_IN", "FULL_PICKUP", "EMPTY_RETURN"].includes(draft.purpose);
  const groups = found ? [["TERMINAL", "Terminals"], ["DEPOT", "Depots"], ["OTHER", "Other places"]].map(([k, t]) => [t, found.filter(f => f.kind === k)]).filter(([, l]) => l.length) : [];
  return (
    <div data-testid="haulage-stop-editor" style={{ display: "grid", gap: 12, padding: 14, borderRadius: 12, background: HZ.surfaceSolid, border: `1px solid ${HZ.borderStrong}`, boxShadow: HZ.popoverShadow }}>
      <div><span style={smallLabel()}>What happens there</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {purposes.map(k => <button key={k} type="button" data-testid={`haulage-purpose-${k}`} aria-pressed={draft.purpose === k} style={chip(draft.purpose === k)} onClick={() => set({ purpose: k })}>{label(k)}</button>)}
        </div></div>
      <div><span style={smallLabel()}>Where</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
          {kinds.map(([k, t]) => <button key={k} type="button" data-testid={`haulage-kind-${k}`} aria-pressed={draft.kind === k} style={chip(draft.kind === k)} onClick={() => set({ kind: k })}>{t}</button>)}
        </div>
        {draft.kind === "facility" && (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", gap: 8 }}>
              <input aria-label="UN/LOCODE" value={port} onChange={e => setPort(e.target.value.toUpperCase().slice(0, 5))} placeholder="Any port" style={{ ...textInput(), fontFamily: HZ_MONO }} />
              <input aria-label="Search terminals and depots" data-testid="haulage-facility-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search a terminal or depot by name or code…" style={textInput()} />
            </div>
            {draft.facility && <div style={{ fontSize: 12.5 }}>Chosen: <b>{draft.facility.name}</b>{draft.facility.code ? ` (${draft.facility.code})` : ""}</div>}
            <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gap: 6 }}>
              {found === null ? <span style={{ fontSize: 12, color: HZ.textMuted }}>Searching…</span>
                : groups.length === 0 ? <span style={{ fontSize: 12, color: HZ.textMuted }}>Nothing open{port ? ` at ${port}` : ""}. Add a depot under Master Data → Facilities, or import the SMDG terminals there.</span>
                : groups.map(([t, list]) => (
                  <div key={t} style={{ display: "grid", gap: 2 }}>
                    <span style={{ ...smallLabel(), marginBottom: 0 }}>{t}{port ? ` at ${port}` : ""} · {list.length}</span>
                    {list.map(f => (
                      <button key={f.id} type="button" data-testid="haulage-facility-option" onClick={() => set({ facility: { id: f.id, name: f.name, code: f.code } })}
                        style={{ display: "flex", justifyContent: "space-between", gap: 10, textAlign: "left", padding: "6px 8px", borderRadius: 8, cursor: "pointer", fontSize: 12.5,
                          border: 0, color: HZ.text, background: draft.facility?.id === f.id ? HZ.cyanBg : "transparent" }}>
                        <span style={{ overflowWrap: "anywhere" }}>{f.name}</span>
                        <span style={{ fontFamily: HZ_MONO, fontSize: 10.5, color: HZ.textFaint, whiteSpace: "nowrap" }}>{f.code || "no code"} · {f.unlocode}</span>
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          </div>
        )}
        {draft.kind === "customer" && (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {shipment.shipperId && <button type="button" style={pillBtnStyle()} onClick={() => set({ customer: { id: shipment.shipperId, name: shipment.shipperName } })}>The shipper</button>}
              {shipment.consigneeId && <button type="button" style={pillBtnStyle()} onClick={() => set({ customer: { id: shipment.consigneeId, name: shipment.consigneeName } })}>The consignee</button>}
            </div>
            <CustomerCombobox key={draft.customer.id || "none"} label="Customer" value={draft.customer} onChange={v => set({ customer: v })} />
            <span style={{ fontSize: 11.5, color: HZ.textMuted }}>The address and the contact come from the customer's profile, so a change there shows here.</span>
          </div>
        )}
        {draft.kind === "gps" && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) 1fr 1fr", gap: 8 }}>
            <input aria-label="Name" value={draft.name} onChange={e => set({ name: e.target.value })} placeholder="Name (optional)" style={textInput()} />
            <input aria-label="Latitude" value={draft.lat} onChange={e => set({ lat: e.target.value })} placeholder="Latitude" style={{ ...textInput(), fontFamily: HZ_MONO }} />
            <input aria-label="Longitude" value={draft.lng} onChange={e => set({ lng: e.target.value })} placeholder="Longitude" style={{ ...textInput(), fontFamily: HZ_MONO }} />
          </div>
        )}
        {draft.kind === "address" && (
          <div style={{ display: "grid", gap: 8 }}>
            <input aria-label="Name" value={draft.name} onChange={e => set({ name: e.target.value })} style={textInput()} />
            <textarea aria-label="Address" value={draft.address} onChange={e => set({ address: e.target.value })} rows={2} style={textInput()} />
          </div>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div><span style={smallLabel()}>Reference to quote</span>
          <input aria-label="Reference" value={draft.reference} onChange={e => set({ reference: e.target.value })}
            placeholder={gateStop && plan.releaseRef ? plan.releaseRef : "Optional"} style={textInput()} /></div>
        <div><span style={smallLabel()}>Note for the driver</span>
          <input aria-label="Note" value={draft.notes} onChange={e => set({ notes: e.target.value })} placeholder="Optional" style={textInput()} /></div>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" style={pillBtnStyle()} onClick={onCancel}>Cancel</button>
        <button type="button" data-testid="haulage-stop-save" style={pillBtnStyle({ accent: true, disabled: busy })} disabled={busy} onClick={onSave}>
          {busy ? "Saving…" : editing ? "Save stop" : "Add stop"}
        </button>
      </div>
    </div>
  );
};

// ── One time field: planned in or out, saved when it changes ────────────────────────────────────────────────────────
const TimeInput = ({ value, onSave, disabled, label, testId }) => {
  const [v, setV] = useState(value || "");
  useEffect(() => setV(value || ""), [value]);
  return (
    <input type="datetime-local" aria-label={label} data-testid={testId} value={v} disabled={disabled} style={inputStyle(208)}
      onChange={e => setV(e.target.value)} onBlur={() => { if ((v || "") !== (value || "")) onSave(v); }} />
  );
};

const TimesTable = ({ plan, stops, containers, canEdit, onTime, onDetails, onOwn, ownMode }) => (
  <div style={{ overflowX: "auto" }}>
    <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 400 + stops.length * 226 }}>
      <thead><tr>
        {["Container", ...stops.map((s, i) => [s, i]), "Driver · truck", "Checks", ""].map((h, i) => (
          <th key={i} style={{ fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted, textAlign: "left",
            padding: "6px 8px", borderBottom: `1px solid ${HZ.border}`, verticalAlign: "bottom" }}>
            {Array.isArray(h) ? (<>
              <span style={{ display: "inline-grid", placeItems: "center", width: 18, height: 18, borderRadius: "50%", fontFamily: HZ_DISPLAY, fontSize: 9.5, fontWeight: 800,
                color: HZ.chipText, background: toneOf(h[0].purpose), marginRight: 5 }}>{h[1] + 1}</span>{h[0].purposeLabel}<br />{h[0].inOut.join(" – ")}
            </>) : h}
          </th>
        ))}
      </tr></thead>
      <tbody>
        {containers.map(c => (
          <tr key={c.id} data-testid={`haulage-times-row-${c.containerNumber || c.id}`}>
            <td style={{ padding: "10px 8px", borderBottom: `1px solid ${HZ.border}`, verticalAlign: "top" }}>
              <div style={{ fontFamily: HZ_MONO, fontSize: 12.5, fontWeight: 700 }}>{c.containerNumber || "TBC"}</div>
              <div style={{ fontFamily: HZ_MONO, fontSize: 10.5, color: HZ.textMuted }}>{c.isoCode || c.equipment}{c.vgmMethod ? ` · VGM ${c.vgmMethod}` : ""}</div>
            </td>
            {stops.map((s, i) => {
              const t = c.times?.[s.id] || {};
              const actual = which => {
                const v = which === "in" ? t.actualIn : t.actualOut;
                const src = which === "in" ? t.actualInSource : t.actualOutSource;
                return v ? `${s.inOut[which === "in" ? 0 : 1]} ${fmtHaulageTime(v)} · ${src === "event" ? "container event" : "typed"}` : "";
              };
              const acts = [actual("in"), actual("out")].filter(Boolean);
              return (
                <td key={s.id} style={{ padding: "10px 8px", borderBottom: `1px solid ${HZ.border}`, verticalAlign: "top" }}>
                  <div style={{ display: "grid", gap: 4 }}>
                    <TimeInput value={t.plannedIn} disabled={!canEdit} label={`${c.containerNumber} ${s.purposeLabel} planned ${s.inOut[0]}`}
                      testId={`haulage-time-${c.containerNumber || c.id}-${i + 1}-in`} onSave={v => onTime(c, s, { plannedIn: v })} />
                    <TimeInput value={t.plannedOut} disabled={!canEdit} label={`${c.containerNumber} ${s.purposeLabel} planned ${s.inOut[1]}`}
                      testId={`haulage-time-${c.containerNumber || c.id}-${i + 1}-out`} onSave={v => onTime(c, s, { plannedOut: v })} />
                  </div>
                  <div style={{ fontFamily: HZ_MONO, fontSize: 10.5, color: acts.length ? HZ.good : HZ.textFaint, marginTop: 4 }}>
                    {acts.length ? acts.map(a => <div key={a}>actual {a}</div>) : `actual: —${s.event ? ` · ${s.event.at === "in" ? "gated in" : "gated out"} from events` : ""}`}
                  </div>
                </td>
              );
            })}
            <td style={{ padding: "10px 8px", borderBottom: `1px solid ${HZ.border}`, verticalAlign: "top", fontSize: 12, minWidth: 96 }}>
              {c.record.driverName || c.record.truckPlate ? (<>
                {c.record.driverName && <div>{c.record.driverName}</div>}
                {c.record.truckPlate && <div style={{ fontFamily: HZ_MONO, fontSize: 11, color: HZ.textMuted }}>{c.record.truckPlate}</div>}
              </>) : <span style={{ color: HZ.textFaint }}>—</span>}
            </td>
            <td style={{ padding: "10px 8px", borderBottom: `1px solid ${HZ.border}`, verticalAlign: "top" }}>
              <div data-testid={`haulage-checks-${c.containerNumber || c.id}`} style={{ display: "grid", gap: 4 }}>
                {c.checks.length === 0 ? <span style={{ fontSize: 11.5, color: HZ.textFaint }}>Nothing to check yet</span>
                  : c.checks.map(k => <span key={k.key} data-ok={k.ok ? "true" : "false"} style={tag(k.ok ? HZ.good : HZ.crit)}>{k.ok ? "✓" : "✕"} {k.text.toUpperCase()}</span>)}
              </div>
            </td>
            <td style={{ padding: "10px 8px", borderBottom: `1px solid ${HZ.border}`, verticalAlign: "top" }}>
              <div style={{ display: "grid", gap: 6, justifyItems: "start" }}>
                <button type="button" style={pillBtnStyle()} data-testid={`haulage-details-${c.containerNumber || c.id}`} onClick={() => onDetails(c)}>Details</button>
                {canEdit && !ownMode && <button type="button" style={pillBtnStyle()} data-testid={`haulage-own-${c.containerNumber || c.id}`} onClick={() => onOwn(c, true)}>
                  Own stops</button>}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const HaulageServicePage = ({ shipment, side, serviceType, canEdit: canEditProp, onViewDocuments }) => {
  useHorizonFonts();
  const auth = useAuth();
  const canEdit = !!canEditProp && canEditShipmentSide(auth, shipment, side === "Import" ? "import" : "export");
  const docCode = DOC_CODE[serviceType], planLabel = PLAN_LABEL[serviceType];
  const [service, setService] = useState(undefined);
  const [plan, setPlan] = useState(null);
  const [planError, setPlanError] = useState("");
  const [busy, setBusy] = useState("");
  const [editor, setEditor] = useState(null); // { containerId, stopId?, draft }
  const [changingTrucker, setChangingTrucker] = useState(false);
  const [details, setDetails] = useState(null);
  const [latestDoc, setLatestDoc] = useState(null);
  const [sending, setSending] = useState(null);
  const [file, setFile] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.services.list(shipment.id)
      .then(list => !cancelled && setService(list.find(s => s.side === side && s.serviceType === serviceType && s.status !== "Cancelled") || null))
      .catch(() => !cancelled && setService(null));
    return () => { cancelled = true; };
  }, [shipment.id, side, serviceType]);

  const loadPlan = useCallback(() => {
    if (!service) return Promise.resolve();
    return api.haulagePlan.get(shipment.id, service.id).then(p => { setPlan(p); setPlanError(""); }).catch(e => setPlanError(e.message || "The plan couldn't be loaded"));
  }, [shipment.id, service]);
  const loadLatestDoc = useCallback(() => api.documents.list(shipment.id)
    .then(list => setLatestDoc(list.filter(d => d.docType === docCode)[0] || null)).catch(() => {}), [shipment.id, docCode]);
  useEffect(() => { if (service) { loadPlan(); loadLatestDoc(); } }, [service, loadPlan, loadLatestDoc]);

  // Every change answers with the whole plan (checks included).
  const run = async (label, fn, ok) => {
    setBusy(label);
    try { const p = await fn(); if (p?.service) setPlan(p); if (ok) toast.success(ok); return true; }
    catch (e) { toast.error(e.message || "Couldn't save"); return false; }
    finally { setBusy(""); }
  };

  if (service === undefined) return <div style={{ padding: "40px 0", textAlign: "center", fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>Loading…</div>;
  if (service === null) return (
    <div data-testid="haulage-no-service" style={{ ...frameStyle(), maxWidth: 700, margin: "60px auto", padding: 28, textAlign: "center", fontFamily: HZ_BODY }}>
      <div style={{ fontFamily: HZ_DISPLAY, fontSize: 17, fontWeight: 700, marginBottom: 8, color: HZ.text }}>No {side} {serviceType} service on this shipment</div>
      <div style={{ fontSize: 13, color: HZ.textMuted }}>Order one from the Services panel on Overview first.</div>
    </div>
  );
  if (!plan) return <div style={{ padding: "40px 0", textAlign: "center", fontFamily: HZ_BODY, fontSize: 13, color: planError ? HZ.crit : HZ.textMuted }}>{planError || "Loading the plan…"}</div>;

  const S = plan.service.side;
  const shared = plan.stops;
  const sharedCtrs = plan.containers.filter(c => !c.ownStops);
  const ownCtrs = plan.containers.filter(c => c.ownStops);

  const openAdd = (containerId = null) => setEditor({ containerId, draft: blankDraft(S) });
  const openEdit = (stop) => setEditor({ containerId: stop.containerId, stopId: stop.id, draft: draftOf(stop) });
  const placeOf = d => (d.kind === "facility" ? (d.facility ? { kind: "facility", facilityId: d.facility.id } : { kind: "none", unlocode: d.unlocode || plan.port?.unlocode || "" })
    : d.kind === "customer" ? (d.customer.id ? { kind: "customer", customerId: d.customer.id } : null)
    : d.kind === "gps" ? { kind: "gps", name: d.name, latitude: d.lat, longitude: d.lng }
    : { kind: "address", name: d.name, address: d.address });
  const saveEditor = async () => {
    const d = editor.draft;
    const place = placeOf(d);
    if (!place) { toast.error("Choose a customer from Master Data → Customers"); return; }
    const body = { purpose: d.purpose, place, reference: d.reference, notes: d.notes, ...(editor.containerId ? { containerId: editor.containerId } : {}) };
    const ok = await run("stop", () => editor.stopId ? api.haulagePlan.updateStop(shipment.id, service.id, editor.stopId, body) : api.haulagePlan.addStop(shipment.id, service.id, body),
      editor.stopId ? "Stop saved" : "Stop added");
    if (ok) setEditor(null);
  };
  const move = (list, containerId) => (index, delta) => {
    const ids = list.map(s => s.id);
    const j = index + delta;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    run("order", () => api.haulagePlan.order(shipment.id, service.id, { containerId, ids }));
  };
  const remove = stop => run("remove", () => api.haulagePlan.removeStop(shipment.id, service.id, stop.id), "Stop removed");
  const onTime = (c, s, patch) => run("time", () => api.haulagePlan.setTimes(shipment.id, service.id, c.id, s.id, patch));
  const onOwn = (c, own) => run("own", () => api.haulagePlan.ownStops(shipment.id, service.id, c.id, own),
    own ? `${c.containerNumber || "The container"} has its own stops now` : `${c.containerNumber || "The container"} follows the shared stops again`);
  const changeTrucker = async v => {
    if (!v.id) return;
    try {
      const updated = await api.services.update(shipment.id, service.id, { vendorId: v.id, vendorName: v.name });
      setService(updated); setChangingTrucker(false);
      toast.success(`${v.name} is the trucker`);
    } catch (e) { toast.error(e.message || "Couldn't change the trucker"); }
  };

  const generate = async () => {
    setBusy("generate");
    try {
      const fresh = await api.haulagePlan.get(shipment.id, service.id);
      setPlan(fresh);
      const invNumber = `${shipment.id}-${docCode.slice(0, 2)}-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      const invDate = todayIso();
      const html = buildHaulagePlanHtml({ shipment, invNumber, invDate, notes: "", plan: fresh, planLabel });
      await api.documents.generate(shipment.id, { html, filename: `${docCode}-${invNumber}-${invDate}.pdf`, docType: docCode });
      toast.success(`${planLabel} generated and saved to Documents`);
      await loadLatestDoc();
    } catch (e) { toast.error(e.message || `Couldn't generate the ${planLabel}`); }
    setBusy("");
  };
  const upload = () => {
    if (!file) return;
    setBusy("upload");
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        await api.documents.upload(shipment.id, { filename: file.name, mimeType: file.type, docType: docCode, data: e.target.result.split(",")[1] });
        setFile(null); if (fileRef.current) fileRef.current.value = "";
        toast.success(`${planLabel} uploaded`); loadLatestDoc();
      } catch (ex) { toast.error(ex.message); }
      setBusy("");
    };
    reader.readAsDataURL(file);
  };

  const legWord = S === "Export" ? "pick-up" : "delivery";
  const stopsList = (list, containerId, prefix) => (
    <div style={{ display: "grid", gap: 10 }}>
      {list.map((s, i) => (
        editor?.stopId === s.id ? (
          <StopEditor key={s.id} plan={plan} shipment={shipment} draft={editor.draft} editing busy={busy === "stop"}
            setDraft={fn => setEditor(e => ({ ...e, draft: typeof fn === "function" ? fn(e.draft) : fn }))} onSave={saveEditor} onCancel={() => setEditor(null)} />
        ) : (
          <StopRow key={s.id} stop={s} index={i} count={list.length} canEdit={canEdit} testId={`${prefix}-${i + 1}`}
            onEdit={() => openEdit(s)} onRemove={() => remove(s)} onMove={move(list, containerId)} />
        )
      ))}
      {canEdit && (editor && !editor.stopId && editor.containerId === containerId ? (
        <StopEditor plan={plan} shipment={shipment} draft={editor.draft} busy={busy === "stop"}
          setDraft={fn => setEditor(e => ({ ...e, draft: typeof fn === "function" ? fn(e.draft) : fn }))} onSave={saveEditor} onCancel={() => setEditor(null)} />
      ) : (
        <button type="button" data-testid={`${prefix}-add`} onClick={() => openAdd(containerId)}
          style={{ fontFamily: HZ_BODY, fontSize: 12, fontWeight: 600, color: HZ.cyan, background: "none", border: `1px dashed color-mix(in srgb, ${HZ.cyan} 50%, transparent)`,
            borderRadius: 12, padding: "9px 12px", cursor: "pointer" }}>＋ Add stop</button>
      ))}
    </div>
  );

  return (
    <div data-testid="haulage-page" style={{ maxWidth: 1180, margin: "0 auto", display: "grid", gap: 16, fontFamily: HZ_BODY, color: HZ.text }}>
      <PillNav testIdPrefix="haulage" items={[["trucker", "Trucker", "haulage-trucker"], ["deadlines", S === "Export" ? "Cut-offs" : "Free time", "haulage-deadlines"],
        ["stops", "Stops", "haulage-stops"], ["times", "Times", "haulage-times"], ["plan", planLabel, "haulage-document"]]}
        actions={<button type="button" data-testid="haulage-generate" style={ctaStyle({ disabled: busy === "generate" })} disabled={busy === "generate"} onClick={generate}>
          <IconFlash size={13} />{busy === "generate" ? "Generating…" : `Generate ${planLabel}`}</button>} />

      {!plan.merchantHaulage && (
        <Note testId="haulage-leg-note">{plan.leg
          ? `The ${legWord} leg is ${plan.leg.movementType || "not typed"}: ${plan.leg.movementType === "Carrier's Haulage" ? "the carrier moves the containers (the booking tells it where)" : "someone else moves the containers"}, so this service may not be needed.`
          : `There is no ${legWord} leg on this shipment yet: add one on Contracts & Schedules.`}</Note>
      )}

      <Card id="haulage-trucker" testId="haulage-trucker" label="Trucker" right={<DotPill color={statusColor(plan.service.status)}>{plan.service.status}</DotPill>}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <span aria-hidden style={{ width: 38, height: 38, borderRadius: "50%", display: "grid", placeItems: "center", fontFamily: HZ_DISPLAY, fontSize: 13, fontWeight: 800,
            background: plan.trucker ? HZ.gradCyan : HZ.neutralBg, color: plan.trucker ? HZ.chipText : HZ.textMuted }}>{plan.trucker ? initials(plan.trucker.name) : "—"}</span>
          <div style={{ minWidth: 0 }}>
            <div data-testid="haulage-trucker-name" style={{ fontSize: 15, fontWeight: 700, fontStyle: plan.trucker ? "normal" : "italic", color: plan.trucker ? HZ.text : HZ.textMuted }}>
              {plan.trucker?.name || "No trucker yet"}</div>
            <div style={{ fontFamily: HZ_MONO, fontSize: 11, color: HZ.textMuted }}>
              {plan.trucker ? [`the ${serviceType} service's vendor`, plan.trucker.email, plan.trucker.phone].filter(Boolean).join(" · ") : "Choose who drives this run"}</div>
          </div>
          {canEdit && <button type="button" data-testid="haulage-change-trucker" style={{ ...pillBtnStyle(), marginLeft: "auto" }} onClick={() => setChangingTrucker(o => !o)}>
            {changingTrucker ? "Cancel" : plan.trucker ? "Change trucker" : "Choose the trucker"}</button>}
        </div>
        {changingTrucker && <div style={{ maxWidth: 420 }}><CustomerCombobox label="Trucker" value={{ id: "", name: "" }} onChange={changeTrucker} /></div>}
        {plan.trucker && !plan.trucker.inMasterData && (
          <Note testId="haulage-trucker-typed">{plan.trucker.name} isn't in Master Data → Customers: there's no e-mail to send the plan to, and it can't be
            the Trucker party. Choose the company from Customers to fix both.</Note>
        )}
        <div style={{ fontSize: 11.5, color: HZ.textMuted }}>One place for the trucker: the <b style={{ color: HZ.text }}>Trucker ({S === "Export" ? "Pre-carriage" : "On-carriage"})</b> party
          on Parties &amp; Offices follows it, and the other way round.</div>
      </Card>

      <Card id="haulage-deadlines" testId="haulage-deadlines" label={S === "Export" ? "The carrier's cut-offs" : "Arrival and free time"}
        right={plan.bookingRef ? <span style={tag(HZ.cyan)}>FROM {plan.bookingRef}</span> : <span style={neutralTag()}>NO CONFIRMED BOOKING</span>}>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(190px, 1fr))`, gap: 10 }}>
          {plan.deadlines.map(d => (
            <div key={d.code} data-testid={`haulage-deadline-${d.code}`} data-printed={d.printed ? "true" : "false"}
              style={{ border: `1px solid ${d.printed ? `color-mix(in srgb, ${HZ.cyan} 45%, ${HZ.border})` : HZ.border}`, borderRadius: 12, padding: "11px 13px", display: "grid", gap: 4, alignContent: "start",
                background: d.printed ? `linear-gradient(180deg, ${HZ.cyanBg}, transparent 80%)` : HZ.tint }}>
              <span style={smallLabel()}>{d.label}{d.code.length === 3 && S === "Export" ? ` · ${d.code}` : ""}</span>
              <span style={{ fontFamily: d.display ? HZ_DISPLAY : HZ_BODY, fontSize: d.display ? 15 : 12.5, fontWeight: d.display ? 700 : 600, fontStyle: d.display ? "normal" : "italic",
                color: d.display ? (d.printed ? HZ.text : HZ.textMuted) : HZ.textMuted }}>{d.display || "Not given"}</span>
              <span style={{ fontSize: 11.5, color: HZ.textMuted }}>{d.note}</span>
              {(d.typed || []).filter(t => t.differs).map(t => (
                <span key={t.containerId} data-testid={`haulage-deadline-${d.code}-typed`} style={{ fontSize: 11.5, color: HZ.warn }}>
                  Typed on {t.containerNumber || "a container"}: {fmtHaulageTime(t.value)} (the carrier's differs; the earlier one is checked)</span>
              ))}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: HZ.textMuted }}>{plan.port?.name || plan.port?.unlocode} time{plan.port?.utcOffset ? ` (${plan.port.utcOffset})` : ""}.
          {S === "Export" ? " The carrier sends its cut-offs in UTC; they also fill each container's empty CY and VGM cut-off." : " Set the free days per container on the Cargo page."} Highlighted = printed on the {planLabel}.</div>
      </Card>

      <Card id="haulage-stops" testId="haulage-stops" label="Stops"
        right={ownCtrs.length > 0 ? <span style={neutralTag()}>{ownCtrs.length} CONTAINER{ownCtrs.length === 1 ? "" : "S"} WITH OWN STOPS</span>
          : <span style={{ fontSize: 12, color: HZ.textMuted }}>The same stops for every container</span>}>
        {shared.length === 0 && !editor ? (
          <div data-testid="haulage-stops-empty" style={{ display: "grid", gap: 10, justifyItems: "start" }}>
            <span style={{ fontSize: 13, color: HZ.textMuted }}>No stops yet. The usual {S === "Export" ? "pick-up" : "delivery"} is {S === "Export"
              ? "the empty depot, the shipper's door, then the terminal" : "the terminal, the consignee's door, then the empty depot"}.</span>
            {canEdit && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" data-testid="haulage-usual" style={pillBtnStyle({ accent: true, disabled: busy === "usual" })} disabled={busy === "usual"}
                onClick={() => run("usual", () => api.haulagePlan.usual(shipment.id, service.id), "The usual stops are added")}>Add the usual stops</button>
              <button type="button" style={pillBtnStyle()} onClick={() => openAdd(null)}>＋ Add a stop</button>
            </div>}
          </div>
        ) : stopsList(shared, null, "haulage-stop")}
      </Card>

      <Card id="haulage-times" testId="haulage-times" label="Times per container"
        right={<span style={{ fontSize: 12, color: HZ.textMuted }}>Each stop's own local time</span>}>
        {sharedCtrs.length > 0 && shared.length > 0 && (
          <TimesTable plan={plan} stops={shared} containers={sharedCtrs} canEdit={canEdit} onTime={onTime} onDetails={setDetails} onOwn={onOwn} ownMode={false} />
        )}
        {sharedCtrs.length > 0 && shared.length === 0 && <span style={{ fontSize: 12.5, color: HZ.textMuted }}>Add the stops first: each gets a planned time per container.</span>}
        {plan.containers.length === 0 && <span style={{ fontSize: 12.5, color: HZ.textMuted }}>No containers on this shipment yet: add them on the Cargo page.</span>}
        {ownCtrs.map(c => (
          <div key={c.id} data-testid={`haulage-own-block-${c.containerNumber || c.id}`} style={{ display: "grid", gap: 10, padding: 14, borderRadius: 12, border: `1px dashed ${HZ.borderStrong}` }}>
            {/* The way back is always here, also when every own stop was removed (audit A5, TKT-ENR040). */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ ...smallLabel(), marginBottom: 0 }}>{c.containerNumber || "TBC"} · its own stops</span>
              {canEdit && <button type="button" data-testid={`haulage-shared-${c.containerNumber || c.id}`} style={{ ...pillBtnStyle(), marginLeft: "auto" }}
                onClick={() => onOwn(c, false)}>Use the shared stops</button>}
            </div>
            {stopsList(c.stops || [], c.id, `haulage-own-stop-${c.containerNumber || c.id}`)}
            {(c.stops || []).length > 0 && <TimesTable plan={plan} stops={c.stops} containers={[c]} canEdit={canEdit} onTime={onTime} onDetails={setDetails} onOwn={onOwn} ownMode />}
          </div>
        ))}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", fontSize: 11.5, color: HZ.textMuted }}>
          <span><b style={{ color: HZ.text }}>Planned</b>: typed here, printed on the {planLabel}.</span>
          <span><b style={{ color: HZ.text }}>Actual</b>: from the container events ({S === "Export" ? "Empty Pickup, Gate In" : "Gate Out, Empty Return"}: the carrier's Track &amp; Trace fills them).</span>
          <span><b style={{ color: HZ.text }}>Checks</b>: {S === "Export" ? "the gate-in against the CY cut-off (and the earliest delivery), a weighed container against the VGM cut-off, detention from the empty pick-up"
            : "the full pick-up against the terminal free time, the empty return against the detention free days"}. Warnings only.</span>
        </div>
      </Card>

      <Card id="haulage-document" testId="haulage-document" label={`${planLabel} (${docCode})`}
        right={latestDoc && <button type="button" style={pillBtnStyle()} onClick={onViewDocuments}>Open Documents</button>}>
        {latestDoc ? (
          <div data-testid="haulage-latest-doc" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}>
            <span style={tag(HZ.cyan)}>{docCode}</span>
            <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{latestDoc.filename || latestDoc.label}</span>
            <span style={{ color: HZ.textMuted }}>{latestDoc.status === "confirmed" ? "Confirmed" : "Draft"} · {new Date(latestDoc.createdAt).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}</span>
            {plan.trucker && <button type="button" data-testid="haulage-send" style={{ ...pillBtnStyle({ accent: true }), marginLeft: "auto" }} onClick={() => setSending(latestDoc)}>
              Send to {plan.trucker.name}</button>}
          </div>
        ) : <span style={{ fontSize: 12.5, color: HZ.textMuted }}>Not generated yet: Generate {planLabel} (top right) prints the stops, the times and the deadlines for {plan.trucker?.name || "the trucker"}.</span>}
        {canEdit && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
            <span style={{ color: HZ.textMuted }}>Or attach the trucker's own:</span>
            <input ref={fileRef} type="file" aria-label={`Upload a ${planLabel}`} onChange={e => setFile(e.target.files?.[0] || null)} style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted }} />
            <button type="button" style={pillBtnStyle({ disabled: !file || busy === "upload" })} disabled={!file || busy === "upload"} onClick={upload}>{busy === "upload" ? "Uploading…" : "Upload"}</button>
          </div>
        )}
      </Card>

      {details && (
        <Modal title={`${serviceType} — ${details.containerNumber || "container"}`} onClose={() => { setDetails(null); loadPlan(); }} width={620}>
          <HaulageDetailsPanel shipmentId={shipment.id} serviceId={service.id} containerId={details.id} record={details.record} canEdit={canEdit} onRecordUpdated={loadPlan} />
        </Modal>
      )}
      {sending && <SendDocumentEmailModal shipment={shipment} doc={sending} onClose={() => setSending(null)} />}
    </div>
  );
};

export default HaulageServicePage;
