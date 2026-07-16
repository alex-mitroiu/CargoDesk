import React, { useState, useEffect, useRef } from "react";
import useSaving from "../hooks/useSaving";
import { T, INCOTERMS_2020, teuOf,
         statusVariant, contractVariant, IMDG_CLASSES } from "../tokens";
import { useAuth } from "../AuthContext";
import { ContainerTypeField } from "../components/shared/ContainerTypePickerModal";
import { VesselField } from "../components/shared/VesselCombobox";
import { CommodityCombobox, GradePill } from "../components/shared/CommodityCombobox";
import CustomerCombobox from "../components/shared/CustomerCombobox";
import ServicesPanel from "../components/shared/ServicesPanel";
import { api } from "../api";
import { toast } from "../toast";
import Btn from "../components/primitives/Btn";
import ActionMenu from "../components/primitives/ActionMenu";
import Spinner from "../components/primitives/Spinner";
import Badge from "../components/primitives/Badge";
import {Inp, Sel, BtnToggle} from "../components/primitives/Form";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import DatePicker from "../components/primitives/DatePicker";
import { generateBLDraft, generatePackingList, generateContainerManifest } from "../utils/documentGenerator";
import SailingPickerModal from "../components/shared/SailingPickerModal";
import ContainerEventsPanel from "../components/shared/ContainerEventsPanel";


// ─── Refresh button ──────────────────────────────────────────────────────────
const RefreshBtn = ({ onRefresh }) => {
  const [spinning, setSpinning] = useState(false);
  const handleClick = async () => {
    if (spinning) return;
    setSpinning(true);
    try { await onRefresh?.(); } catch {} finally { setTimeout(() => setSpinning(false), 600); }
  };
  return (
    <>
      <style>{`@keyframes sdp-spin { to { transform: rotate(360deg); } }`}</style>
      <button
        type="button"
        onClick={handleClick}
        title="Refresh shipment"
        style={{
          background: "none", border: `1px solid ${T.border}`, borderRadius: 7,
          padding: "6px 11px", cursor: "pointer", color: T.textMuted,
          fontSize: 16, lineHeight: 1, display: "inline-flex", alignItems: "center",
          transition: "color .12s, border-color .12s",
        }}
        onMouseEnter={e => { e.currentTarget.style.color = T.text; e.currentTarget.style.borderColor = T.border; }}
        onMouseLeave={e => { e.currentTarget.style.color = T.textMuted; e.currentTarget.style.borderColor = T.border; }}>
        <span style={{ display: "inline-block", animation: spinning ? "sdp-spin .7s linear infinite" : "none" }}>↻</span>
      </button>
    </>
  );
};

// ─── Section header with hover tooltip ───────────────────────────────────────

const SECTION_TIPS = {
  "①": "Container reference number, physical size (20 ft / 40 ft), and equipment type — Dry, Reefer, Open Top, Flat Rack, or Tank.",
  "②": "HS Code (Harmonized System customs tariff number) and a plain-language description of the cargo contents. Both are mandatory for booking and BL documentation.",
  "③": "Gross weight in kilograms (total including packaging and dunnage) and cargo volume in cubic metres. Required for vessel stowage planning and weight declarations.",
  "④": "IMDG (International Maritime Dangerous Goods) classification. Enable only if this container carries hazardous materials — additional documentation and placarding will be required.",
};

const SectionHeader = ({ n, title }) => {
  const [tip, setTip] = React.useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, position: "relative" }}>
      {/* Numbered chip with tooltip */}
      <div style={{ position: "relative", flexShrink: 0 }}>
        <span
          onMouseEnter={() => setTip(true)}
          onMouseLeave={() => setTip(false)}
          style={{
            fontFamily: T.mono, fontSize: 14, fontWeight: 800, color: T.accent,
            background: T.accentBg, border: `1px solid ${T.accent}55`,
            borderRadius: 5, padding: "2px 10px", flexShrink: 0,
            cursor: "default", userSelect: "none",
            boxShadow: tip ? `0 0 0 3px ${T.accent}22` : "none",
            transition: "box-shadow .15s",
          }}>
          {n}
        </span>
        {tip && (
          <div style={{
            position: "absolute", top: "calc(100% + 8px)", left: 0, zIndex: 9999,
            background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: 8, padding: "10px 14px",
            boxShadow: "0 8px 24px rgba(0,0,0,.35)",
            minWidth: 240, maxWidth: 300,
            fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.6,
            pointerEvents: "none",
          }}>
            <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700,
              color: T.accent, marginBottom: 5, textTransform: "uppercase",
              letterSpacing: ".06em" }}>{title}</div>
            {SECTION_TIPS[n]}
            {/* Arrow */}
            <div style={{
              position: "absolute", top: -5, left: 12,
              width: 8, height: 8, background: T.surface,
              borderLeft: `1px solid ${T.border}`, borderTop: `1px solid ${T.border}`,
              transform: "rotate(45deg)",
            }} />
          </div>
        )}
      </div>
      <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.textMuted,
        textTransform: "uppercase", letterSpacing: ".09em" }}>{title}</span>
      <div style={{ flex: 1, height: 1, background: T.border, opacity: 0.5 }} />
    </div>
  );
};

// ─── Container type picker modal ─────────────────────────────────────────────

// ─── Container form ───────────────────────────────────────────────────────────

export const ContainerForm = ({ init = {}, onSave, onCancel, onDirtyChange, dgPolicy = null }) => {
  const initSnap = useRef({
    containerNumber:  init.containerNumber  || "",
    sealNumber:       init.sealNumber       || "",
    size:             init.size             || "",
    type:             init.type             || "",
    hsCode:           init.hsCode           || "",
    cargoDescription: init.cargoDescription || "",
    grossWeightKg:    init.grossWeightKg    != null ? String(init.grossWeightKg) : "",
    volumeCbm:        init.volumeCbm        != null ? String(init.volumeCbm)     : "",
    isDg:             init.isDg             || false,
    dgClass:          init.dgClass          || "",
  });
  const [f, setF] = useState({ ...initSnap.current });
  const set = k => v => setF(p => ({ ...p, [k]: v }));

  const [touched,   setTouched]   = useState({});
  const [isSaving,  withSaving]   = useSaving();

  // Notify parent when form diverges from its initial values
  useEffect(() => {
    const s = initSnap.current;
    const dirty = f.containerNumber !== s.containerNumber || f.sealNumber !== s.sealNumber ||
      f.size !== s.size ||
      f.type !== s.type || f.hsCode !== s.hsCode || f.cargoDescription !== s.cargoDescription ||
      f.grossWeightKg !== s.grossWeightKg || f.volumeCbm !== s.volumeCbm ||
      f.isDg !== s.isDg || f.dgClass !== s.dgClass;
    onDirtyChange?.(dirty);
  }, [f]);

  // Clear dirty flag when the form unmounts (modal closed)
  useEffect(() => () => onDirtyChange?.(false), []);
  const touch = k => setTouched(p => ({ ...p, [k]: true }));

  const weightOk = parseFloat(f.grossWeightKg) > 0;
  const volumeOk = parseFloat(f.volumeCbm)    > 0;
  const hsOk     = f.hsCode.trim().length > 0;
  const descOk   = f.cargoDescription.trim().length > 0;

  const dgConflict = (() => {
    if (!f.isDg || !f.dgClass || !dgPolicy) return null;
    if (!dgPolicy.dgAllowed) return `Contract does not permit DG cargo`;
    if (dgPolicy.imdgClasses.length > 0 && !dgPolicy.imdgClasses.includes(f.dgClass))
      return `IMO class ${f.dgClass} not permitted by contract (allowed: ${dgPolicy.imdgClasses.join(", ")})`;
    return null;
  })();

  const valid    = f.containerNumber.length >= 4 && f.size && f.type
                 && hsOk && descOk && weightOk && volumeOk && (!f.isDg || f.dgClass)
                 && !dgConflict;

  const FieldErr = ({ show, msg }) => show
    ? <div style={{ fontFamily: T.body, fontSize: 11, color: T.danger, marginTop: 3 }}>{msg}</div>
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* ① Container Identity */}
      <SectionHeader n="①" title="Container Identity" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Container Number" value={f.containerNumber}
          onChange={v => set("containerNumber")(v.toUpperCase().replace(/\s/g, ""))}
          placeholder="MAEU1234567" mono required
          hint="ISO 6346 container ID" />
        <Inp label="Seal Number" value={f.sealNumber}
          onChange={v => set("sealNumber")(v.toUpperCase().replace(/\s/g, ""))}
          placeholder="SL1234567" mono
          hint="Carrier or shipper seal" />
      </div>

      <ContainerTypeField
        size={f.size} type={f.type} required
        onChange={opt => setF(p => ({ ...p, size: opt?.size || "", type: opt?.type || "" }))} />

      {/* ② Cargo Details */}
      <SectionHeader n="②" title="Cargo Details" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <Inp label="HS Code" value={f.hsCode}
            onChange={v => { set("hsCode")(v); touch("hsCode"); }}
            placeholder="e.g. 8471.30" mono required
            hint="Customs tariff classification number" />
          <FieldErr show={touched.hsCode && !hsOk} msg="HS Code is required" />
        </div>
        <div>
          <Inp label="Cargo Description" value={f.cargoDescription}
            onChange={v => { set("cargoDescription")(v); touch("desc"); }}
            placeholder="e.g. Laptop computers, new" required
            hint="Free-text description of cargo contents" />
          <FieldErr show={touched.desc && !descOk} msg="Cargo description is required" />
        </div>
      </div>

      {/* ③ Measurements */}
      <SectionHeader n="③" title="Physical Measurements" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <Inp label="Gross Weight (kg)" value={f.grossWeightKg}
            onChange={v => { if (v === "" || /^\d*\.?\d*$/.test(v)) { set("grossWeightKg")(v); touch("weight"); } }}
            type="text" inputMode="decimal" placeholder="18 000" required
            hint="Total gross weight including packaging" />
          <FieldErr show={touched.weight && !weightOk} msg="Gross weight must be greater than 0" />
        </div>
        <div>
          <Inp label="Volume (CBM)" value={f.volumeCbm}
            onChange={v => { if (v === "" || /^\d*\.?\d*$/.test(v)) { set("volumeCbm")(v); touch("volume"); } }}
            type="text" inputMode="decimal" placeholder="28.5" required
            hint="Cubic metres — cargo measurement" />
          <FieldErr show={touched.volume && !volumeOk} msg="Volume must be greater than 0" />
        </div>
      </div>

      {/* ④ Dangerous Goods */}
      <SectionHeader n="④" title="Dangerous Goods" />

      <div style={{ background: T.bg, border: `1px solid ${f.isDg ? T.danger + "55" : T.border}`,
        borderRadius: 8, padding: "14px 16px", transition: "border-color .15s" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: f.isDg ? 14 : 0 }}>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5,
              color: f.isDg ? T.danger : T.textMuted,
              fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 3 }}>
              ⚠ IMDG Classified Cargo
            </div>
            {!f.isDg && (
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.border }}>
                Toggle on if this container carries dangerous goods
              </div>
            )}
          </div>
          <BtnToggle selected={f.isDg}
            onClick={() => setF(p => ({ ...p, isDg: !p.isDg, dgClass: "" }))}>
            {f.isDg ? "DG ON" : "DG OFF"}
          </BtnToggle>
        </div>

        {f.isDg && (
          <Sel label="IMDG Class" value={f.dgClass} onChange={set("dgClass")} required
            hint="Select the applicable IMO dangerous goods class"
            options={[
              { value: "", label: "— Select IMDG class —" },
              ...IMDG_CLASSES.map(c => ({ value: c.code, label: `${c.label} — ${c.name}` }))
            ]} />
        )}

        {f.isDg && f.dgClass && (() => {
          const cls = IMDG_CLASSES.find(c => c.code === f.dgClass);
          return cls ? (
            <div style={{ marginTop: 10, padding: "10px 12px",
              background: T.surface, borderRadius: 6, border: `1px solid ${T.danger}22` }}>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.danger,
                fontWeight: 600, marginBottom: 4 }}>
                {cls.label} — {cls.name}
              </div>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, lineHeight: 1.6 }}>
                {cls.description}
              </div>
            </div>
          ) : null;
        })()}

        {dgConflict && (
          <div style={{ marginTop: 10, padding: "10px 12px",
            background: T.danger + "12", borderRadius: 6,
            border: `1px solid ${T.danger}55`,
            fontFamily: T.body, fontSize: 12, color: T.danger,
            display: "flex", alignItems: "flex-start", gap: 7 }}>
            <span style={{ flexShrink: 0, fontWeight: 700 }}>⛔</span>
            <span>{dgConflict}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn
          disabled={!valid || isSaving}
          onClick={() => {
            setTouched({ weight: true, volume: true, hsCode: true, desc: true });
            if (!valid) return;
            withSaving(() => onSave({
              containerNumber: f.containerNumber, sealNumber: f.sealNumber, size: f.size, type: f.type,
              hsCode: f.hsCode, cargoDescription: f.cargoDescription,
              grossWeightKg: f.grossWeightKg ? parseFloat(f.grossWeightKg) : null,
              volumeCbm:     f.volumeCbm     ? parseFloat(f.volumeCbm)     : null,
              isDg: f.isDg, dgClass: f.dgClass,
            }));
          }}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {isSaving && <Spinner size="sm" color="currentColor" />}
            {isSaving ? "Saving…" : (init.id ? "Update Container" : "Add Container")}
          </span>
        </Btn>
      </div>
    </div>
  );
};

// ─── Page: Shipment Detail ────────────────────────────────────────────────────

// ─── Inline commodity display ─────────────────────────────────────────────────
const CommodityDisplay = ({ code }) => {
  const [comm, setComm] = React.useState(null);
  React.useEffect(() => {
    if (!code) return;
    import("../api").then(m => m.api.commodities.get(code).then(setComm).catch(() => setComm({ code, description: code })));
  }, [code]);
  if (!comm) return <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{code}</span>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{comm.code}</span>
      <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{comm.description}</span>
      {comm.gradeCode && <GradePill code={comm.gradeCode} name={comm.gradeName} />}
    </div>
  );
};


// ─── Status Timeline ──────────────────────────────────────────────────────────

const STATUS_ICON = {
  Active: "🟢", Pending: "🟡", Sailed: "🚢",
  Arrived: "⚓", Completed: "✓", Cancelled: "✕",
};

const relTime = iso => {
  const d = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (d < 60)    return "just now";
  if (d < 3600)  return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

const fmtDateTime = iso => new Date(iso).toLocaleString("en-GB", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

const StatusTimeline = ({ log, currentStatus, open, onToggle }) => (
  <div style={{ background: T.surface, borderRadius: 12,
    border: `1px solid ${T.border}`, overflow: "hidden" }}>
    <button type="button" onClick={onToggle}
      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "14px 20px", background: "none", border: "none",
        cursor: "pointer", textAlign: "left" }}>
      <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
        {open ? "▾" : "▸"} Status History
      </span>
      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
        background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "1px 8px" }}>
        {log.length} transition{log.length !== 1 ? "s" : ""}
      </span>
    </button>

    {open && (
      <div style={{ padding: "0 20px 20px" }}>
        {log.length === 0 ? (
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted,
            fontStyle: "italic", margin: 0 }}>
            No status changes recorded yet. Transitions are logged automatically on update.
          </p>
        ) : (
          <div style={{ position: "relative" }}>
            <div style={{ position: "absolute", left: 15, top: 0, bottom: 0,
              width: 1, background: T.border }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {log.map((entry, i) => (
                <div key={entry.id} style={{ display: "flex", gap: 14,
                  alignItems: "flex-start", paddingBottom: 16 }}>
                  <div style={{ width: 30, flexShrink: 0, display: "flex",
                    justifyContent: "center", paddingTop: 2, zIndex: 1 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%",
                      background: T.accent, border: `2px solid ${T.surface}`,
                      boxShadow: `0 0 0 1px ${T.accent}` }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center",
                      gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
                        {STATUS_ICON[entry.fromStatus] || "○"} {entry.fromStatus}
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.border }}>→</span>
                      <span style={{ fontFamily: T.mono, fontSize: 12,
                        color: T.accent, fontWeight: 700 }}>
                        {STATUS_ICON[entry.toStatus] || "○"} {entry.toStatus}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 10, marginTop: 3, flexWrap: "wrap" }}>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                        {fmtDateTime(entry.changedAt)}
                      </span>
                      <span style={{ fontFamily: T.body, fontSize: 11, color: T.border }}>
                        · {relTime(entry.changedAt)}
                      </span>
                      {entry.changedBy && entry.changedBy !== "system" && (
                        <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                          · by {entry.changedBy}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {/* Current status cap */}
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                <div style={{ width: 30, flexShrink: 0, display: "flex",
                  justifyContent: "center", paddingTop: 2, zIndex: 1 }}>
                  <div style={{ width: 12, height: 12, borderRadius: "50%",
                    background: T.success, border: `2px solid ${T.surface}`,
                    boxShadow: `0 0 0 1px ${T.success}` }} />
                </div>
                <div>
                  <div style={{ fontFamily: T.mono, fontSize: 12,
                    color: T.success, fontWeight: 700 }}>
                    {STATUS_ICON[currentStatus] || "○"} {currentStatus}
                  </div>
                  <div style={{ fontFamily: T.body, fontSize: 11,
                    color: T.textMuted, marginTop: 2 }}>Current status</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    )}
  </div>
);


// ─── Link Vessel Modal ────────────────────────────────────────────────────────

const LinkVesselModal = ({ shipment, onSave, onClose }) => {
  const [vessel,  setVessel]  = React.useState(
    shipment.vesselImo ? { imo: shipment.vesselImo, name: shipment.vessel || "" } : null
  );
  const [voyage,  setVoyage]  = React.useState(shipment.voyage || "");
  const [saving, withSaving] = useSaving();

  const handleSave = () =>
    withSaving(() => onSave(vessel?.imo || "", vessel?.name || "", voyage));

  return (
    <Modal title="Link Vessel" onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <VesselField
          vessel={vessel}
          onSelect={setVessel}
        />
        <Inp label="Voyage/Loop" value={voyage} onChange={setVoyage}
          placeholder="e.g. 0123W" mono
          hint="Voyage/loop identifier for this sailing" />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handleSave} disabled={saving}>
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {saving && <Spinner size="sm" color="currentColor" />}
            {saving ? "Saving…" : "Save Vessel"}
          </span>
          </Btn>
        </div>
      </div>
    </Modal>
  );
};


// ─── Shipment History Timeline ────────────────────────────────────────────────

const EVENT_CONFIG = {
  SHIPMENT_CREATED:  { icon: "🚢",  label: "Shipment created",       color: () => T.success  },
  STATUS_CHANGED:    { icon: "🔄", label: "Status changed",          color: () => T.accent   },
  FIELD_UPDATED:     { icon: "✏️",  label: "Field updated",           color: () => T.info     },
  CONTAINER_ADDED:   { icon: "➕",  label: "Container added",         color: () => T.success  },
  CONTAINER_REMOVED: { icon: "➖",  label: "Container removed",       color: () => T.danger   },
  CONTAINER_UPDATED: { icon: "📦",  label: "Container updated",       color: () => T.warning  },
  COMPLIANCE_HIT:    { icon: "⚠️",  label: "Compliance hit detected", color: () => T.danger   },
  COST_LINE_ADDED:   { icon: "＋",  label: "Cost line added",          color: () => T.success  },
  COST_LINE_UPDATED: { icon: "✏️",  label: "Cost line updated",        color: () => T.info     },
  COST_LINE_REMOVED: { icon: "✕",   label: "Cost line removed",        color: () => T.danger   },
};

const FIELD_LABELS = {
  pol: "Port of Loading", pod: "Port of Discharge", status: "Status",
  etd: "Estimated Departure", eta: "Estimated Arrival", carrier_code: "Carrier",
  vessel: "Vessel", vessel_imo: "Vessel IMO", voyage: "Voyage/Loop", incoterm: "Incoterm",
  commodity_code: "Commodity", booking_ref: "Booking Reference", bl_number: "B/L Number",
  contract_type: "Contract Type", contract_id: "Contract ID",
  container_number: "Container Number", size: "Size", type: "Equipment Type",
  hs_code: "HS Code", cargo_description: "Cargo Description",
  gross_weight_kg: "Gross Weight (kg)", volume_cbm: "Volume (CBM)",
  is_dg: "Dangerous Goods", dg_class: "DG Class",
};

const EventRow = ({ ev }) => {
  const cfg   = EVENT_CONFIG[ev.eventType] ?? { icon: "·", label: ev.eventType, color: () => T.textMuted };
  const color = cfg.color();
  const field = ev.field ? (FIELD_LABELS[ev.field] || ev.field) : null;

  let summary = "";
  if (ev.eventType === "SHIPMENT_CREATED") {
    const m = ev.meta || {};
    summary = [m.pol, m.pod].filter(Boolean).join(" → ");
    if (m.carrier) summary += `  ·  ${m.carrier}`;
    if (m.etd)     summary += `  ·  ETD ${m.etd}`;
  } else if (ev.eventType === "CONTAINER_ADDED") {
    const m = ev.meta || {};
    summary = `${ev.newValue}  ${m.size ? `${m.size}ft` : ""}  ${m.type || ""}`.trim();
  } else if (ev.eventType === "CONTAINER_REMOVED") {
    const m = ev.meta || {};
    summary = `${ev.oldValue}  ${m.size ? `${m.size}ft` : ""}  ${m.type || ""}`.trim();
  } else if (ev.eventType === "CONTAINER_UPDATED") {
    const m = ev.meta || {};
    summary = m.containerNumber ? `${m.containerNumber} — ` : "";
    summary += `${field}: `;
    summary += ev.oldValue ? `${ev.oldValue} → ` : "";
    summary += ev.newValue || "—";
  } else if (ev.eventType === "COST_LINE_ADDED" || ev.eventType === "COST_LINE_REMOVED") {
    const m = ev.meta || {};
    summary = [m.type, m.chargeCode].filter(Boolean).join("  ·  ");
    if (m.amountUsd != null) summary += `  ·  USD ${Number(m.amountUsd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else if (ev.eventType === "COST_LINE_UPDATED") {
    const m = ev.meta || {};
    summary = [m.type, m.chargeCode].filter(Boolean).join("  ·  ");
    if (field) summary += `  —  ${field}: ${ev.oldValue} → ${ev.newValue}`;
  } else {
    summary = field ? `${field}: ` : "";
    summary += ev.oldValue ? `${ev.oldValue} → ` : "";
    summary += ev.newValue || "—";
  }

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", paddingBottom: 14 }}>
      {/* Dot */}
      <div style={{ width: 30, flexShrink: 0, display: "flex", justifyContent: "center",
        paddingTop: 2, zIndex: 1 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%",
          background: color, border: `2px solid ${T.surface}`,
          boxShadow: `0 0 0 1px ${color}` }} />
      </div>
      {/* Content */}
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>{cfg.icon}</span>
          <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color }}>
            {cfg.label}
          </span>
        </div>
        {ev.eventType === "COMPLIANCE_HIT" ? (() => {
          const hits = Array.isArray(ev.meta?.hits) ? ev.meta.hits : [];
          return (
            <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 3 }}>
              {hits.length === 0
                ? <span style={{ fontFamily: T.mono, fontSize: 11, color: T.danger }}>Sanctioned party or embargoed route detected</span>
                : hits.map((h, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.danger, minWidth: 80 }}>
                      {h.field}
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>{h.value}</span>
                    {h.program && (
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>· {h.program}</span>
                    )}
                  </div>
                ))}
            </div>
          );
        })() : summary && (
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
            marginTop: 3, lineHeight: 1.5 }}>
            {summary}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 3, flexWrap: "wrap" }}>
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
            {fmtDateTime(ev.occurredAt)}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 10, color: T.border }}>
            · {relTime(ev.occurredAt)}
          </span>
          {ev.actor && ev.actor !== "system" && (
            <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>
              · by {ev.actor}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

const getEventSummary = ev => {
  const field = ev.field ? (FIELD_LABELS[ev.field] || ev.field) : null;
  if (ev.eventType === "SHIPMENT_CREATED") {
    const m = ev.meta || {};
    let s = [m.pol, m.pod].filter(Boolean).join(" → ");
    if (m.carrier) s += `  ·  ${m.carrier}`;
    if (m.etd) s += `  ·  ETD ${m.etd}`;
    return s;
  }
  if (ev.eventType === "CONTAINER_ADDED") {
    const m = ev.meta || {};
    return `${ev.newValue}  ${m.size ? `${m.size}ft` : ""}  ${m.type || ""}`.trim();
  }
  if (ev.eventType === "CONTAINER_REMOVED") {
    const m = ev.meta || {};
    return `${ev.oldValue}  ${m.size ? `${m.size}ft` : ""}  ${m.type || ""}`.trim();
  }
  if (ev.eventType === "CONTAINER_UPDATED") {
    const m = ev.meta || {};
    let s = m.containerNumber ? `${m.containerNumber} — ` : "";
    s += `${field}: ${ev.oldValue ? `${ev.oldValue} → ` : ""}${ev.newValue || "—"}`;
    return s;
  }
  if (ev.eventType === "COST_LINE_ADDED" || ev.eventType === "COST_LINE_REMOVED") {
    const m = ev.meta || {};
    let s = [m.type, m.chargeCode].filter(Boolean).join("  ·  ");
    if (m.amountUsd != null) s += `  ·  USD ${Number(m.amountUsd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return s;
  }
  if (ev.eventType === "COST_LINE_UPDATED") {
    const m = ev.meta || {};
    let s = [m.type, m.chargeCode].filter(Boolean).join("  ·  ");
    if (field) s += `  —  ${field}: ${ev.oldValue} → ${ev.newValue}`;
    return s;
  }
  if (ev.eventType === "COMPLIANCE_HIT") {
    const hits = Array.isArray(ev.meta?.hits) ? ev.meta.hits : [];
    return hits.map(h => `${h.field}: ${h.value}`).join(", ") || "Sanctioned party or embargoed route detected";
  }
  return field ? `${field}: ${ev.oldValue ? `${ev.oldValue} → ` : ""}${ev.newValue || "—"}` : "";
};

const CompactHistory = ({ events, onShowAll }) => {
  const sorted = [...events].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  const preview = sorted.slice(0, 6);
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
      overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 18px", borderBottom: `1px solid ${T.border}33`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>Shipment History</span>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
            background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "1px 7px" }}>
            {events.length}
          </span>
        </div>
        {events.length > 0 && (
          <button type="button" onClick={onShowAll}
            style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
              border: `1px solid ${T.accent}55`, borderRadius: 7, padding: "4px 11px", cursor: "pointer" }}>
            Show all →
          </button>
        )}
      </div>
      {events.length === 0 ? (
        <div style={{ padding: "20px 18px", fontFamily: T.body, fontSize: 12,
          color: T.textMuted, fontStyle: "italic", flex: 1 }}>
          No history yet.
        </div>
      ) : (
        <div style={{ flex: 1 }}>
          {preview.map((ev, i) => {
            const cfg = EVENT_CONFIG[ev.eventType] ?? { icon: "·", label: ev.eventType, color: () => T.textMuted };
            const color = cfg.color();
            const sum = getEventSummary(ev);
            return (
              <div key={ev.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px",
                borderBottom: i < preview.length - 1 ? `1px solid ${T.border}22` : "none" }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                  background: color, boxShadow: `0 0 0 2px ${color}33` }} />
                <span style={{ fontSize: 13, flexShrink: 0, lineHeight: 1 }}>{cfg.icon}</span>
                <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color, flexShrink: 0, width: 110 }}>
                  {cfg.label}
                </span>
                {sum && (
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {sum}
                  </span>
                )}
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.border, flexShrink: 0, marginLeft: "auto" }}>
                  {relTime(ev.occurredAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <button type="button" onClick={onShowAll} disabled={events.length === 0}
        style={{ display: "block", width: "100%", padding: "10px 18px", textAlign: "center",
          fontFamily: T.body, fontSize: 12, background: T.bg, flexShrink: 0,
          border: "none", borderTop: `1px solid ${T.border}22`, cursor: events.length === 0 ? "default" : "pointer",
          color: events.length === 0 ? T.border : T.textMuted }}
        onMouseEnter={e => { if (events.length > 0) e.currentTarget.style.color = T.accent; }}
        onMouseLeave={e => { e.currentTarget.style.color = events.length === 0 ? T.border : T.textMuted; }}>
        {events.length > 6
          ? `${events.length - 6} more event${events.length - 6 !== 1 ? "s" : ""} — Show all →`
          : events.length > 0 ? "Show all →" : "No events yet"}
      </button>
    </div>
  );
};

const HistoryModal = ({ events, shipmentId, onClose }) => {
  const PAGE_SIZE = 15;
  const TYPE_GROUPS = {
    Shipment:     ["SHIPMENT_CREATED", "STATUS_CHANGED"],
    Fields:       ["FIELD_UPDATED"],
    Container:    ["CONTAINER_ADDED", "CONTAINER_REMOVED", "CONTAINER_UPDATED"],
    Compliance:   ["COMPLIANCE_HIT"],
    "Cost Lines": ["COST_LINE_ADDED", "COST_LINE_UPDATED", "COST_LINE_REMOVED"],
  };
  const GROUP_NAMES = Object.keys(TYPE_GROUPS);

  const [activeGroups, setActiveGroups] = useState(() => new Set(GROUP_NAMES));
  const [dateRange,    setDateRange]    = useState("all");
  const [search,       setSearch]       = useState("");
  const [sortDir,      setSortDir]      = useState("desc");
  const [page,         setPage]         = useState(0);
  const [expanded,     setExpanded]     = useState(() => new Set());

  const toggleGroup = g => setActiveGroups(prev => {
    const next = new Set(prev);
    next.has(g) ? next.delete(g) : next.add(g);
    setPage(0);
    return next;
  });

  const activeTypes = new Set(GROUP_NAMES.filter(g => activeGroups.has(g)).flatMap(g => TYPE_GROUPS[g]));
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const filtered = events
    .filter(ev => activeTypes.has(ev.eventType))
    .filter(ev => dateRange === "today" ? ev.occurredAt.startsWith(today)
                : dateRange === "7d"    ? ev.occurredAt >= sevenDaysAgo
                : true)
    .filter(ev => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return getEventSummary(ev).toLowerCase().includes(q)
          || (EVENT_CONFIG[ev.eventType]?.label || ev.eventType).toLowerCase().includes(q)
          || (ev.field && (FIELD_LABELS[ev.field] || ev.field).toLowerCase().includes(q));
    })
    .sort((a, b) => sortDir === "desc"
      ? new Date(b.occurredAt) - new Date(a.occurredAt)
      : new Date(a.occurredAt) - new Date(b.occurredAt));

  // Group consecutive FIELD_UPDATED within 3 seconds
  const grouped = [];
  let gi = 0;
  while (gi < filtered.length) {
    const ev = filtered[gi];
    if (ev.eventType === "FIELD_UPDATED") {
      const batch = [ev];
      const t0 = new Date(ev.occurredAt).getTime();
      let gj = gi + 1;
      while (gj < filtered.length
          && filtered[gj].eventType === "FIELD_UPDATED"
          && Math.abs(new Date(filtered[gj].occurredAt).getTime() - t0) < 3000) {
        batch.push(filtered[gj]);
        gj++;
      }
      grouped.push(batch.length > 1
        ? { _isGroup: true, id: `grp-${ev.id}`, events: batch, occurredAt: ev.occurredAt, actor: ev.actor }
        : ev);
      gi = gj;
    } else {
      grouped.push(ev);
      gi++;
    }
  }

  const totalPages = Math.ceil(grouped.length / PAGE_SIZE);
  const pageItems  = grouped.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const exportCSV = () => {
    const rows = [["Event Type", "Summary", "Date/Time", "Actor"]];
    filtered.forEach(ev => rows.push([
      EVENT_CONFIG[ev.eventType]?.label || ev.eventType,
      `"${getEventSummary(ev).replace(/"/g, '""')}"`,
      fmtDateTime(ev.occurredAt),
      ev.actor || "system",
    ]));
    const csv = rows.map(r => r.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${shipmentId}-history.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const th  = { fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em" };
  const inp = { fontFamily: T.body, fontSize: 12, color: T.text, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, padding: "5px 10px", outline: "none" };

  return (
    <Modal title={`Shipment History — ${shipmentId}`} onClose={onClose} width={820}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Toolbar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {GROUP_NAMES.map(g => {
            const on = activeGroups.has(g);
            return (
              <button key={g} type="button" onClick={() => toggleGroup(g)}
                style={{ fontFamily: T.body, fontSize: 11, padding: "3px 10px", borderRadius: 20,
                  border: `1px solid ${on ? T.accent + "66" : T.border}`,
                  background: on ? T.accentBg : "transparent",
                  color: on ? T.accent : T.textMuted, cursor: "pointer" }}>
                {g}
              </button>
            );
          })}
          <div style={{ width: 1, height: 18, background: T.border, flexShrink: 0 }} />
          <div style={{ display: "flex", borderRadius: 7, overflow: "hidden", border: `1px solid ${T.border}` }}>
            {[["all","All time"],["today","Today"],["7d","7 days"]].map(([r, label], idx) => (
              <button key={r} type="button" onClick={() => { setDateRange(r); setPage(0); }}
                style={{ fontFamily: T.body, fontSize: 11, padding: "4px 10px",
                  background: dateRange === r ? T.accent : "transparent",
                  color: dateRange === r ? T.btnPrimaryText : T.textMuted,
                  border: "none", borderRight: idx < 2 ? `1px solid ${T.border}` : "none", cursor: "pointer" }}>
                {label}
              </button>
            ))}
          </div>
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search events…" style={{ ...inp, minWidth: 150 }} />
          <div style={{ flex: 1 }} />
          <button type="button" onClick={exportCSV}
            style={{ ...inp, cursor: "pointer", color: T.textMuted, padding: "5px 12px" }}>
            ⬇ Export CSV
          </button>
        </div>

        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          {grouped.length} row{grouped.length !== 1 ? "s" : ""}
          {grouped.length !== events.length ? ` (filtered from ${events.length})` : ""}
        </div>

        {/* Table */}
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "7px 14px",
            borderBottom: `1px solid ${T.border}`, background: T.bg, gap: 10 }}>
            <div style={{ ...th, width: 160, flexShrink: 0 }}>Event Type</div>
            <div style={{ ...th, flex: 1 }}>Summary</div>
            <div style={{ ...th, width: 160, flexShrink: 0, cursor: "pointer", userSelect: "none",
              display: "flex", alignItems: "center", gap: 4 }}
              onClick={() => { setSortDir(d => d === "desc" ? "asc" : "desc"); setPage(0); }}>
              Date / Time {sortDir === "desc" ? "↓" : "↑"}
            </div>
            <div style={{ ...th, width: 70, flexShrink: 0 }}>Actor</div>
          </div>

          {pageItems.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", fontFamily: T.body,
              fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
              No events match the current filters.
            </div>
          ) : pageItems.map(item => {
            if (item._isGroup) {
              const isOpen = expanded.has(item.id);
              return (
                <React.Fragment key={item.id}>
                  <div
                    onClick={() => setExpanded(prev => { const n = new Set(prev); isOpen ? n.delete(item.id) : n.add(item.id); return n; })}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px",
                      borderBottom: `1px solid ${T.border}22`, cursor: "pointer" }}
                    onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <div style={{ width: 160, flexShrink: 0 }}>
                      <Badge variant="info">Fields</Badge>
                    </div>
                    <div style={{ flex: 1, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                      {isOpen ? "▾" : "▸"} {item.events.length} field update{item.events.length !== 1 ? "s" : ""}
                    </div>
                    <div style={{ width: 160, flexShrink: 0, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                      {fmtDateTime(item.occurredAt)}
                    </div>
                    <div style={{ width: 70, flexShrink: 0, fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                      {item.actor || "—"}
                    </div>
                  </div>
                  {isOpen && item.events.map(subEv => (
                    <div key={subEv.id} style={{ display: "flex", alignItems: "center", gap: 10,
                      padding: "7px 14px 7px 36px",
                      borderBottom: `1px solid ${T.border}22`, background: `${T.accent}06` }}>
                      <div style={{ width: 144, flexShrink: 0 }} />
                      <div style={{ flex: 1, fontFamily: T.mono, fontSize: 11, color: T.textMuted,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {getEventSummary(subEv)}
                      </div>
                      <div style={{ width: 160, flexShrink: 0, fontFamily: T.mono, fontSize: 10, color: T.border }}>
                        {fmtDateTime(subEv.occurredAt)}
                      </div>
                      <div style={{ width: 70, flexShrink: 0 }} />
                    </div>
                  ))}
                </React.Fragment>
              );
            }
            const cfg = EVENT_CONFIG[item.eventType] ?? { icon: "·", label: item.eventType, color: () => T.textMuted };
            const color = cfg.color();
            return (
              <div key={item.id}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px",
                  borderBottom: `1px solid ${T.border}22` }}
                onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ width: 160, flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13 }}>{cfg.icon}</span>
                  <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color }}>{cfg.label}</span>
                </div>
                <div style={{ flex: 1, fontFamily: T.mono, fontSize: 11, color: T.textMuted,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {getEventSummary(item)}
                </div>
                <div style={{ width: 160, flexShrink: 0, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                  {fmtDateTime(item.occurredAt)}
                </div>
                <div style={{ width: 70, flexShrink: 0, fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                  {item.actor || "—"}
                </div>
              </div>
            );
          })}
        </div>

        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <button type="button" disabled={page === 0} onClick={() => setPage(p => p - 1)}
              style={{ ...inp, cursor: page === 0 ? "default" : "pointer", opacity: page === 0 ? .4 : 1, padding: "4px 12px" }}>←</button>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{page + 1} / {totalPages}</span>
            <button type="button" disabled={page === totalPages - 1} onClick={() => setPage(p => p + 1)}
              style={{ ...inp, cursor: page === totalPages - 1 ? "default" : "pointer", opacity: page === totalPages - 1 ? .4 : 1, padding: "4px 12px" }}>→</button>
          </div>
        )}
      </div>
    </Modal>
  );
};

// ─── Messages drawer ─────────────────────────────────────────────────────────

const MessagesDrawer = ({ shipment, messages, onPost, onClose }) => {
  const { user, activeRole } = useAuth();
  const [body,    setBody]    = useState("");
  const [posting, setPosting] = useState(false);
  const [sortAsc, setSortAsc] = useState(true);
  const listRef = useRef(null);
  const shipmentId = shipment.id;
  const roleLabel = { admin: "Admin", operator: "Operator", viewer: "Viewer" }[activeRole] ?? activeRole;

  const sorted = sortAsc ? [...messages] : [...messages].reverse();

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (sortAsc) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom) el.scrollTop = el.scrollHeight;
    } else {
      const nearTop = el.scrollTop < 80;
      if (nearTop) el.scrollTop = 0;
    }
  }, [messages, sortAsc]);

  const charCount = body.length;
  const valid = charCount >= 15 && charCount <= 500;

  const handlePost = async () => {
    if (!valid || posting) return;
    setPosting(true);
    try {
      await api.shipmentMessages.post(shipmentId, { body, author: user?.name || "User", role: roleLabel });
      await onPost();
      setBody("");
    } finally { setPosting(false); }
  };

  const fmtTs = iso => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
      " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <>
      {/* Backdrop — semi-transparent, click to close */}
      <div onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.25)", zIndex: 1100 }} />

      {/* Drawer panel */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 420,
        background: T.surface, borderLeft: `1px solid ${T.border}`,
        boxShadow: "-8px 0 32px rgba(0,0,0,.35)",
        zIndex: 1101, display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <div style={{ borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "16px 20px 12px" }}>
            <div>
              <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
                💬 Messages
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                {sorted.length} message{sorted.length !== 1 ? "s" : ""}
              </div>
            </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => setSortAsc(a => !a)}
              title={sortAsc ? "Showing oldest first — click for newest first" : "Showing newest first — click for oldest first"}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
                cursor: "pointer", color: T.textMuted, fontSize: 12, padding: "4px 10px",
                fontFamily: T.mono, lineHeight: 1, whiteSpace: "nowrap",
                transition: "border-color .15s, color .15s" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}>
              {sortAsc ? "↑ Oldest first" : "↓ Newest first"}
            </button>
            <button onClick={onClose}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
              cursor: "pointer", color: T.textMuted, fontSize: 15, padding: "4px 10px",
              lineHeight: 1 }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = T.danger; e.currentTarget.style.color = T.danger; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}>
            ✕
          </button>
          </div>
          </div>
          {/* Context strip */}
          <div style={{ display: "flex", alignItems: "center", gap: 10,
            padding: "8px 20px 12px", flexWrap: "wrap" }}>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, fontWeight: 600 }}>
              {shipmentId}
            </span>
            <span style={{ color: T.border }}>·</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>
              {shipment.pol} → {shipment.pod}
            </span>
            {(shipment.polName || shipment.podName) && (
              <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                ({shipment.polName || shipment.pol} → {shipment.podName || shipment.pod})
              </span>
            )}
            <span style={{ color: T.border }}>·</span>
            <span style={{
              fontFamily: T.body, fontSize: 10.5, fontWeight: 700,
              color: statusVariant(shipment.status).color,
              background: statusVariant(shipment.status).bg,
              border: `1px solid ${statusVariant(shipment.status).color}44`,
              borderRadius: 4, padding: "1px 7px",
            }}>
              {shipment.status}
            </span>
          </div>
        </div>

        {/* Message list */}
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px",
          display: "flex", flexDirection: "column", gap: 14 }}>
          {sorted.length === 0 ? (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted,
              fontStyle: "italic", textAlign: "center", marginTop: 40 }}>
              No messages yet. Be the first to post one.
            </div>
          ) : sorted.map(m => (
            <div key={m.id} style={{ background: T.bg, border: `1px solid ${T.border}`,
              borderRadius: 10, padding: "12px 14px" }}>
              {/* Author row */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%",
                  background: T.accent, display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: T.head, fontSize: 12, fontWeight: 800, color: "#fff", flexShrink: 0 }}>
                  {m.author.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text }}>
                    {m.author}
                  </div>
                  {m.role && (
                    <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                      {m.role}
                    </div>
                  )}
                </div>
              </div>
              {/* Timestamp */}
              <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, marginBottom: 8 }}>
                {fmtTs(m.createdAt)}
              </div>
              {/* Body */}
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6,
                whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {m.body}
              </div>
            </div>
          ))}
        </div>

        {/* Compose area */}
        <div style={{ borderTop: `1px solid ${T.border}`, padding: "14px 20px",
          display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Type a message… (min 15, max 500 characters)"
            rows={4}
            maxLength={500}
            style={{ background: T.bg, border: `1px solid ${body.length > 0 && !valid ? T.danger : T.border}`,
              borderRadius: 8, color: T.text, fontFamily: T.body, fontSize: 13,
              padding: "10px 12px", outline: "none", resize: "none",
              lineHeight: 1.5, transition: "border-color .15s" }}
            onFocus={e => e.currentTarget.style.borderColor = T.accent}
            onBlur={e => e.currentTarget.style.borderColor = body.length > 0 && !valid ? T.danger : T.border}
            onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handlePost(); }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontFamily: T.mono, fontSize: 11,
              color: charCount > 500 ? T.danger : charCount >= 15 ? T.success : T.textMuted }}>
              {charCount} / 500{charCount < 15 && charCount > 0 ? ` (min ${15 - charCount} more)` : ""}
            </span>
            <button onClick={handlePost} disabled={!valid || posting}
              style={{ background: valid ? T.accent : T.border, border: "none", borderRadius: 7,
                color: valid ? "#fff" : T.textMuted, cursor: valid ? "pointer" : "default",
                padding: "8px 20px", fontFamily: T.body, fontSize: 13, fontWeight: 700,
                transition: "background .15s" }}>
              {posting ? "Posting…" : "Post"}
            </button>
          </div>
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.border }}>
            Ctrl+Enter to post quickly
          </div>
        </div>
      </div>
    </>
  );
};

// ─── EDI Messages Drawer ──────────────────────────────────────────────────────

const EDI_BOOKABLE_CARRIERS = new Set(["MAEU", "SAFM", "MCPU"]);
const EDI_STATUS_COLOR = {
  pending: "#6b7280", sent: "#3b82f6", acknowledged: "#3b82f6",
  confirmed: "#22c55e", rejected: "#ef4444", error: "#ef4444",
};

const EdiMessagesDrawer = ({ shipment, messages, onSend, onClose }) => {
  const [sending,    setSending]    = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const listRef = useRef(null);
  const bookable = EDI_BOOKABLE_CARRIERS.has(shipment.carrierCode);

  const fmtTs = iso => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
      " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  const handleSend = async () => {
    if (sending || !bookable) return;
    setSending(true);
    try { await onSend(); } finally { setSending(false); }
  };

  const payloadFor = m => {
    const raw = m.direction === "out" ? m.rawPayload : (m.parsedPayload || m.rawPayload);
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw || ""; }
  };

  return (
    <>
      {/* Backdrop — semi-transparent, click to close */}
      <div onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.25)", zIndex: 1100 }} />

      {/* Drawer panel */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 420,
        background: T.surface, borderLeft: `1px solid ${T.border}`,
        boxShadow: "-8px 0 32px rgba(0,0,0,.35)",
        zIndex: 1101, display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <div style={{ borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "16px 20px 12px" }}>
            <div>
              <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
                📡 EDI Messages
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                {messages.length} message{messages.length !== 1 ? "s" : ""}
              </div>
            </div>
            <button onClick={onClose}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
                cursor: "pointer", color: T.textMuted, fontSize: 15, padding: "4px 10px",
                lineHeight: 1 }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = T.danger; e.currentTarget.style.color = T.danger; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}>
              ✕
            </button>
          </div>
          {/* Context strip */}
          <div style={{ display: "flex", alignItems: "center", gap: 10,
            padding: "8px 20px 12px", flexWrap: "wrap" }}>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, fontWeight: 600 }}>
              {shipment.id}
            </span>
            <span style={{ color: T.border }}>·</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>
              {shipment.carrierCode} · {shipment.pol} → {shipment.pod}
            </span>
          </div>
        </div>

        {/* Message list */}
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px",
          display: "flex", flexDirection: "column", gap: 14 }}>
          {messages.length === 0 ? (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted,
              fontStyle: "italic", textAlign: "center", marginTop: 40 }}>
              No EDI messages yet. Send a booking request to get started.
            </div>
          ) : messages.map(m => {
            const color = EDI_STATUS_COLOR[m.status] || T.textMuted;
            const expanded = expandedId === m.id;
            return (
              <div key={m.id} style={{ background: T.bg, border: `1px solid ${T.border}`,
                borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.text }}>
                    {m.direction === "out" ? "📤 Sent" : "📥 Received"}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>
                    {m.messageType.replace(/_/g, " ")}
                  </span>
                  <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                    color, background: `${color}18`, border: `1px solid ${color}44`,
                    borderRadius: 4, padding: "1px 7px", textTransform: "uppercase" }}>
                    {m.status}{m.isMock ? " · demo" : ""}
                  </span>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, marginBottom: 8 }}>
                  {fmtTs(m.createdAt)}
                </div>
                <button onClick={() => setExpandedId(expanded ? null : m.id)}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                    fontFamily: T.body, fontSize: 11, color: T.accent, textDecoration: "underline dotted" }}>
                  {expanded ? "Hide payload" : "View payload"}
                </button>
                {expanded && (
                  <pre style={{ marginTop: 8, fontFamily: T.mono, fontSize: 10.5, color: T.text,
                    background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6,
                    padding: "10px 12px", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {payloadFor(m)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>

        {/* Action bar */}
        <div style={{ borderTop: `1px solid ${T.border}`, padding: "14px 20px",
          display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
          {!bookable && (
            <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, lineHeight: 1.5 }}>
              Booking requests aren't supported for carrier {shipment.carrierCode || "—"} yet.
            </div>
          )}
          <button onClick={handleSend} disabled={!bookable || sending}
            style={{ background: bookable ? T.accent : T.border, border: "none", borderRadius: 7,
              color: bookable ? "#fff" : T.textMuted, cursor: bookable && !sending ? "pointer" : "default",
              padding: "9px 20px", fontFamily: T.body, fontSize: 13, fontWeight: 700,
              transition: "background .15s" }}>
            {sending ? "Sending…" : "📤 Send Booking Request"}
          </button>
        </div>
      </div>
    </>
  );
};

// ─── Compliance Modal ─────────────────────────────────────────────────────────

const RESULT_STYLE = {
  HIT:    { color: "#ef4444", bg: "#ef444415", border: "#ef444444" },
  CLEAR:  { color: "#22c55e", bg: "#22c55e15", border: "#22c55e44" },
  OVERRIDE: { color: "#f59e0b", bg: "#f59e0b15", border: "#f59e0b44" },
};

export const ComplianceModal = ({ shipment, screening, onChange, onClose }) => {
  const [busy,           setBusy]           = useState(false);
  const [syncing,        setSyncing]        = useState(false);
  const [overrideOpen,   setOverrideOpen]   = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const effectiveResult = screening?.result === "CLEAR" && screening?.overriddenAt ? "OVERRIDE" : screening?.result;
  const rs = RESULT_STYLE[effectiveResult] || RESULT_STYLE.CLEAR;

  // Phase-based check definitions
  const PHASES = [
    {
      id: "parties", label: "Phase 1", title: "Parties",
      checks: [
        { field: "Shipper",   label: "Shipper",   value: shipment.shipperName,   desc: null },
        { field: "Consignee", label: "Consignee", value: shipment.consigneeName, desc: null },
        { field: "Principal", label: "Principal", value: shipment.principalName, desc: null },
      ],
    },
    {
      id: "routing", label: "Phase 2", title: "Routing",
      checks: [
        { field: "POL", label: "Port of Loading",    value: shipment.pol, desc: shipment.polName },
        { field: "POD", label: "Port of Discharge",  value: shipment.pod, desc: shipment.podName },
      ],
    },
  ];

  const checkStatus = c => {
    if (!c.value || !c.value.trim()) return "no_data";
    if (!screening)                  return "pending";
    return screening.hits?.some(h => h.field === c.field) ? "hit" : "clear";
  };
  const checkHit = c => screening?.hits?.find(h => h.field === c.field) || null;
  const phaseRollup = phase => {
    const ss = phase.checks.map(c => checkStatus(c));
    if (ss.some(s => s === "hit"))    return "hit";
    if (ss.every(s => s === "clear")) return "clear";
    return "pending";
  };

  const CHECK_COLOR = { hit: "#f87171", clear: "#34d399", pending: "#94a3b8", no_data: "#64748b" };
  const CHECK_ICON  = { hit: "✗", clear: "✓", pending: "◎", no_data: "—" };
  const CHECK_LABEL = { hit: "HIT", clear: "Clear", pending: "Not Screened", no_data: "No Data" };

  const runScreen = async () => {
    setBusy(true);
    try {
      const r = await api.screening.run(shipment.id);
      onChange(r);
      toast.success(`Screening complete — ${r.result}`);
    } catch (e) {
      toast.error(e.message || "Screening failed");
    } finally { setBusy(false); }
  };

  const csvInputRef = useRef(null);
  const importCsv = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setSyncing(true);
    try {
      const csv = await file.text();
      const r = await api.sanctions.importCsv(csv);
      toast.success(`OFAC SDN imported — ${r.entries.toLocaleString()} entries loaded`);
    } catch (err2) {
      toast.error(err2.message || "Import failed");
    } finally { setSyncing(false); }
  };
  const syncFromSource = async () => {
    setSyncing(true);
    try {
      const r = await api.sanctions.sync();
      toast.success(`OFAC SDN synced — ${r.entries.toLocaleString()} entries loaded`);
    } catch (err2) {
      toast.error(err2.message || "Sync failed");
    } finally { setSyncing(false); }
  };

  const submitOverride = async () => {
    if (!overrideReason.trim()) return;
    setBusy(true);
    try {
      const r = await api.screening.override(shipment.id, { reason: overrideReason });
      onChange({ ...screening, result: "CLEAR", overriddenAt: r.overriddenAt, overrideReason: r.overrideReason });
      toast.success("Override saved — status set to CLEAR");
      setOverrideOpen(false);
      setOverrideReason("");
    } catch (e) {
      toast.error(e.message || "Override failed");
    } finally { setBusy(false); }
  };

  return (
    <Modal title="Compliance Screening" onClose={onClose} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Status banner */}
        {screening ? (
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px",
            background: rs.bg, border: `1px solid ${rs.border}`, borderRadius: 8 }}>
            <span style={{ fontSize: 24, lineHeight: 1 }}>
              {effectiveResult === "HIT" ? "🔴" : effectiveResult === "OVERRIDE" ? "🟡" : "🟢"}
            </span>
            <div>
              <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: rs.color }}>
                {effectiveResult === "HIT" ? "Compliance review required"
                  : effectiveResult === "OVERRIDE" ? "CLEAR (manually overridden)"
                  : "CLEAR — No matches found"}
              </div>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 3 }}>
                Screened {new Date(screening.screenedAt).toLocaleString("en-GB")} · OFAC SDN
                {screening.overriddenAt && ` · Overridden ${new Date(screening.overriddenAt).toLocaleString("en-GB")}`}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ padding: "14px 16px", background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: 8, fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            This shipment has not been screened yet. Run a screening to check all parties against the OFAC SDN list.
          </div>
        )}

        {/* Phase cards */}
        {PHASES.map(phase => {
          const rollup = phaseRollup(phase);
          const rollupColor = CHECK_COLOR[rollup] || CHECK_COLOR.pending;
          return (
            <div key={phase.id} style={{ background: T.bg, border: `1px solid ${T.border}`,
              borderRadius: 8, overflow: "hidden" }}>
              {/* Phase header */}
              <div style={{ display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", borderBottom: `1px solid ${T.border}`,
                background: T.surface }}>
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  letterSpacing: ".1em", textTransform: "uppercase",
                  color: T.textMuted, flexShrink: 0 }}>
                  {phase.label}
                </span>
                <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600,
                  color: T.text, flex: 1 }}>
                  {phase.title}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  letterSpacing: ".06em", textTransform: "uppercase",
                  color: rollupColor, background: rollupColor + "18",
                  border: `1px solid ${rollupColor}44`, borderRadius: 4, padding: "2px 8px" }}>
                  {rollup === "hit" ? "HIT" : rollup === "clear" ? "All Clear" : "Pending"}
                </span>
              </div>

              {/* Check rows */}
              {phase.checks.map((check, idx) => {
                const stat = checkStatus(check);
                const hit  = checkHit(check);
                const col  = CHECK_COLOR[stat];
                return (
                  <div key={check.field} style={{ padding: "10px 14px",
                    borderBottom: idx < phase.checks.length - 1 ? `1px solid ${T.border}22` : "none" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "16px 88px 1fr auto",
                      alignItems: "center", gap: "0 10px" }}>
                      <span style={{ fontSize: 11, color: col, fontWeight: 700, textAlign: "center" }}>
                        {CHECK_ICON[stat]}
                      </span>
                      <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600,
                        color: T.textMuted }}>
                        {check.label}
                      </span>
                      <span style={{ fontFamily: T.body, fontSize: 12, color: T.text,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {check.value
                          ? <>{check.value}{check.desc && check.desc !== check.value &&
                              <span style={{ color: T.textMuted, fontSize: 11, marginLeft: 5 }}>
                                {check.desc}
                              </span>}
                            </>
                          : <span style={{ color: T.textMuted, fontStyle: "italic" }}>—</span>
                        }
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                        letterSpacing: ".06em", textTransform: "uppercase",
                        color: col, background: col + "15",
                        border: `1px solid ${col}44`, borderRadius: 4,
                        padding: "1px 6px", flexShrink: 0, minWidth: 72, textAlign: "center" }}>
                        {CHECK_LABEL[stat]}
                      </span>
                    </div>
                    {hit && (
                      <div style={{ marginTop: 6, marginLeft: 26, padding: "7px 10px",
                        background: T.danger + "10",
                        border: `1px solid ${T.danger}30`,
                        borderLeft: `3px solid ${T.danger}`,
                        borderRadius: 4, fontFamily: T.body, fontSize: 11, color: T.text }}>
                        Matched:{" "}
                        <span style={{ fontWeight: 600 }}>{hit.matchedEntry}</span>
                        {hit.program && <> · <span style={{ color: "#f59e0b" }}>{hit.program}</span></>}
                        {hit.source  && <> · <span style={{ color: T.textMuted }}>{hit.source}</span></>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Override reason display */}
        {screening?.overrideReason && (
          <div style={{ padding: "8px 12px", background: "#f59e0b12",
            border: "1px solid #f59e0b44", borderRadius: 6,
            fontFamily: T.body, fontSize: 12, color: T.text }}>
            <span style={{ fontWeight: 600 }}>Override reason: </span>{screening.overrideReason}
          </div>
        )}

        {/* Override form */}
        {screening?.result === "HIT" && !screening?.overriddenAt && (
          overrideOpen ? (
            <div style={{ padding: 14, background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 8, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text }}>
                Override reason <span style={{ color: T.danger }}>*</span>
              </div>
              <textarea
                value={overrideReason}
                onChange={e => setOverrideReason(e.target.value)}
                placeholder="Explain why this is a false positive or has been cleared by compliance…"
                rows={3}
                style={{ fontFamily: T.body, fontSize: 13, resize: "vertical",
                  background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6,
                  padding: "8px 10px", color: T.text, outline: "none", width: "100%", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <Btn variant="secondary" onClick={() => { setOverrideOpen(false); setOverrideReason(""); }}>Cancel</Btn>
                <Btn disabled={!overrideReason.trim() || busy} onClick={submitOverride}>
                  {busy ? "Saving…" : "Confirm Override"}
                </Btn>
              </div>
            </div>
          ) : (
            <Btn variant="secondary" onClick={() => setOverrideOpen(true)}>
              Clear as false positive (override)
            </Btn>
          )
        )}

        {/* Footer actions */}
        <div style={{ display: "flex", gap: 8, alignItems: "center",
          borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <input ref={csvInputRef} type="file" accept=".csv,text/csv"
            onChange={importCsv} style={{ display: "none" }} />
          <button onClick={() => csvInputRef.current?.click()} disabled={syncing}
            style={{ fontFamily: T.body, fontSize: 12, background: "none",
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 12px",
              color: T.textMuted, cursor: syncing ? "default" : "pointer" }}>
            {syncing ? "Working…" : "⤒ Import sdn.csv"}
          </button>
          <button onClick={syncFromSource} disabled={syncing}
            style={{ fontFamily: T.body, fontSize: 12, background: "none",
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 12px",
              color: T.textMuted, cursor: syncing ? "default" : "pointer" }}>
            {syncing ? "Working…" : "↻ Sync from source"}
          </button>
          <Btn onClick={runScreen} disabled={busy} style={{ marginLeft: "auto" }}>
            {busy ? "Screening…" : screening ? "↻ Re-screen" : "Run Screening"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Shipment Milestones ──────────────────────────────────────────────────────

const MILESTONE_ICONS = {
  booking_confirmed: "📋",
  si_submitted:      "📄",
  cargo_gated_in:    "🏭",
  vessel_departed:   "🚢",
  bl_issued:         "📃",
  vessel_arrived:    "⚓",
  customs_cleared:   "✅",
  cargo_released:    "📦",
  delivered:         "🎯",
};

// ─── Parties & Offices Panel ───────────────────────────────────────────────────

const PartiesOfficesCard = ({ label, value }) => (
  <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px" }}>
    <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>{label}</div>
    <div style={{ fontFamily: T.body, fontSize: 16, fontWeight: 700,
      color: value ? T.text : T.border, wordBreak: "break-word" }}>{value || "—"}</div>
  </div>
);

// Edit form — reuses the same CustomerCombobox / department-filtered-office-select
// patterns as ShipmentFormPage's Parties & Offices sections, self-contained so it
// can be opened from the dedicated Parties & Offices sub-page.
const PartiesOfficesForm = ({ shipment, onSave, onCancel }) => {
  const [offices, setOffices] = useState([]);
  useEffect(() => { api.offices.list().then(setOffices).catch(() => {}); }, []);

  const [f, setF] = useState({
    shipperId:           shipment.shipperId           || "",
    shipperName:         shipment.shipperName         || "",
    consigneeId:         shipment.consigneeId         || "",
    consigneeName:       shipment.consigneeName       || "",
    notifyId:            shipment.notifyId            || "",
    notifyName:          shipment.notifyName          || "",
    principalId:         shipment.principalId         || "",
    principalName:       shipment.principalName       || "",
    emoOfficeId:          shipment.emoOfficeId          || "",
    imoOfficeId:          shipment.imoOfficeId          || "",
    controllingOfficeId:  shipment.controllingOfficeId  || "",
  });
  const [sameNotify, setSameNotify] = useState(
    !shipment.notifyId || shipment.notifyId === shipment.consigneeId
  );
  const [isSaving, withSaving] = useSaving();

  const OFFICE_FIELDS = [
    { key: "emoOfficeId",         label: "Export Managing Office (EMO)", required: true,  dept: "SE" },
    { key: "imoOfficeId",         label: "Import Managing Office (IMO)", required: true,  dept: "SI" },
    { key: "controllingOfficeId", label: "Controlling Office",           required: false, dept: null },
  ];

  // The shipment PUT endpoint replaces the full record (not a PATCH), so every
  // other field must ride along unchanged — only the party/office keys differ.
  const handleSave = () => withSaving(() => onSave({
    ...shipment,
    ...f,
    notifyId:   sameNotify ? f.consigneeId   : f.notifyId,
    notifyName: sameNotify ? f.consigneeName : f.notifyName,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
          Parties
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <CustomerCombobox label="Shipper" required
            value={{ id: f.shipperId, name: f.shipperName }}
            onChange={v => setF(p => ({ ...p, shipperId: v.id, shipperName: v.name }))} />
          <CustomerCombobox label="Consignee" required
            value={{ id: f.consigneeId, name: f.consigneeName }}
            onChange={v => setF(p => ({ ...p, consigneeId: v.id, consigneeName: v.name }))} />
          <CustomerCombobox label="Principal" required
            value={{ id: f.principalId, name: f.principalName }}
            onChange={v => setF(p => ({ ...p, principalId: v.id, principalName: v.name }))} />
        </div>
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
            fontFamily: T.body, fontSize: 12, color: T.textMuted, userSelect: "none", width: "fit-content" }}>
            <input type="checkbox" checked={!sameNotify}
              onChange={e => {
                const diff = e.target.checked;
                setSameNotify(!diff);
                if (!diff) setF(p => ({ ...p, notifyId: p.consigneeId, notifyName: p.consigneeName }));
              }}
              style={{ accentColor: T.accent, width: 13, height: 13 }} />
            Different notify party
          </label>
          {sameNotify
            ? <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic", paddingLeft: 2 }}>
                {f.consigneeName
                  ? <>Notify → <span style={{ color: T.text, fontStyle: "normal" }}>{f.consigneeName}</span></>
                  : "Same as Consignee (select a Consignee above)"}
              </div>
            : <CustomerCombobox label="Notify Party"
                value={{ id: f.notifyId, name: f.notifyName }}
                onChange={v => setF(p => ({ ...p, notifyId: v.id, notifyName: v.name }))} />
          }
        </div>
      </div>

      {/* Offices — stacked in a single column; layout/logic to be revisited later */}
      <div>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
          Offices — split by Export / Import
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {OFFICE_FIELDS.map(({ key, label, required, dept }) => {
            const candidates = dept ? offices.filter(o => o.department === dept && o.isActive) : offices.filter(o => o.isActive);
            return (
              <div key={key}>
                <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 5 }}>
                  {label}{required && <span style={{ color: T.danger, marginLeft: 2 }}>*</span>}
                </div>
                <select value={f[key] || ""} onChange={e => setF(p => ({ ...p, [key]: e.target.value || "" }))}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 7, fontFamily: T.mono, fontSize: 12,
                    color: f[key] ? T.text : T.textMuted, border: `1px solid ${T.border}`,
                    background: T.bg, outline: "none", cursor: "pointer", boxSizing: "border-box" }}>
                  <option value="">{required ? "Select office…" : "None (optional)"}</option>
                  {candidates.map(o => <option key={o.id} value={o.id}>{o.code} — {o.name}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel} disabled={isSaving}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={isSaving}>{isSaving ? "Saving…" : "Save"}</Btn>
      </div>
    </div>
  );
};

export const PartiesOfficesPanel = ({ shipment, onUpdate }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [editing, setEditing] = useState(false);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: ".08em" }}>
          Parties
        </div>
        {canEdit && onUpdate && (
          <Btn size="sm" variant="secondary" onClick={() => setEditing(true)}>✎ Edit</Btn>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 18 }}>
        <PartiesOfficesCard label="Shipper"      value={shipment.shipperName} />
        <PartiesOfficesCard label="Consignee"    value={shipment.consigneeName} />
        <PartiesOfficesCard label="Notify Party" value={shipment.notifyName} />
        <PartiesOfficesCard label="Principal"    value={shipment.principalName} />
      </div>
      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
        Offices — split by Export / Import
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <PartiesOfficesCard label="Export Managing Office (EMO)"
          value={shipment.emoOfficeName ? `${shipment.emoOfficeName}${shipment.emoOfficeCode ? ` (${shipment.emoOfficeCode})` : ""}` : ""} />
        <PartiesOfficesCard label="Import Managing Office (IMO)"
          value={shipment.imoOfficeName ? `${shipment.imoOfficeName}${shipment.imoOfficeCode ? ` (${shipment.imoOfficeCode})` : ""}` : ""} />
        <PartiesOfficesCard label="Controlling Office"
          value={shipment.controllingOfficeName ? `${shipment.controllingOfficeName}${shipment.controllingOfficeCode ? ` (${shipment.controllingOfficeCode})` : ""}` : ""} />
      </div>

      {editing && (
        <Modal title="Edit Parties & Offices" onClose={() => setEditing(false)} width={620}>
          <PartiesOfficesForm
            shipment={shipment}
            onCancel={() => setEditing(false)}
            onSave={async form => {
              try {
                await onUpdate(shipment.id, form);
                setEditing(false);
              } catch { /* error already toasted by caller */ }
            }} />
        </Modal>
      )}
    </div>
  );
};

export const MilestonePanel = ({ shipmentId, shipment, onProgress }) => {
  const { user } = useAuth();
  const [milestones,   setMilestones]   = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [initializing, setInitializing] = useState(false);
  const [expanded,     setExpanded]     = useState(null);
  const [saving,       setSaving]       = useState(null);
  const [fields,       setFields]       = useState({});
  const [collapsed,    setCollapsed]    = useState(false);

  const today = new Date().toISOString().slice(0, 10);

  const load = () => {
    setLoading(true);
    return api.milestones.list(shipmentId)
      .then(m => {
        setMilestones(m);
        onProgress?.({ done: m.filter(x => x.completedAt).length, total: m.length });
      })
      .catch(() => { setMilestones([]); onProgress?.({ done: 0, total: 0 }); })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [shipmentId]);

  const handleInit = async (reset = false) => {
    setInitializing(true);
    try {
      await api.milestones.init(shipmentId, {
        carrierCode: shipment?.carrierCode,
        etd: shipment?.etd || '',
        eta: shipment?.eta || '',
      });
      await load();
      toast.success(reset ? "Milestones reset" : "Milestones initialized");
    } catch (e) { toast.error(e.message); }
    setInitializing(false);
  };

  const handleToggleComplete = async m => {
    setSaving(m.id);
    try {
      const completing = !m.completedAt;
      const completedBy = completing ? (user?.name || user?.email || 'User') : '';
      await api.milestones.update(m.id, {
        estimatedDate: m.estimatedDate,
        note: m.note,
        completedAt: completing ? new Date().toISOString() : '',
        completedBy,
      });
      if (completing) setExpanded(null);
      await load();
      if (completing) toast.success(`${m.label} marked complete`);
    } catch (e) { toast.error(e.message); }
    setSaving(null);
  };

  const handleSaveFields = async m => {
    setSaving(m.id);
    try {
      const f = fields[m.id] || {};
      await api.milestones.update(m.id, {
        estimatedDate: f.estimatedDate ?? m.estimatedDate,
        note:          f.note          ?? m.note,
        completedAt:   m.completedAt,
        completedBy:   m.completedBy,
      });
      await load();
      setExpanded(null);
    } catch (e) { toast.error(e.message); }
    setSaving(null);
  };

  const milestoneState = (m, idx) => {
    if (m.completedAt) return 'completed';
    if (m.estimatedDate && m.estimatedDate < today) return 'overdue';
    const firstIncomplete = milestones.findIndex(x => !x.completedAt);
    if (idx === firstIncomplete) return 'current';
    return 'upcoming';
  };

  const stateColor = st => ({
    completed: T.success, overdue: T.danger, current: T.accent, upcoming: T.border,
  }[st]);

  const overdueCount    = milestones.filter(m => !m.completedAt && m.estimatedDate && m.estimatedDate < today).length;
  const completedCount  = milestones.filter(m => !!m.completedAt).length;
  const progress        = milestones.length > 0 ? Math.round((completedCount / milestones.length) * 100) : 0;

  const fmtCompleted = iso =>
    new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 18px", borderBottom: collapsed ? "none" : `1px solid ${T.border}33`,
        cursor: "pointer" }}
        onClick={() => setCollapsed(c => !c)}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
            Shipment Milestones
          </span>
          {milestones.length > 0 && (
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
              {completedCount}/{milestones.length}
            </span>
          )}
          {overdueCount > 0 && <Badge variant="danger">{overdueCount} overdue</Badge>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {milestones.length > 0 && (
            <button type="button" onClick={e => { e.stopPropagation(); handleInit(true); }} disabled={initializing}
              style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, background: "none",
                border: `1px solid ${T.border}`, borderRadius: 7, padding: "3px 10px",
                cursor: initializing ? "not-allowed" : "pointer" }}>
              {initializing ? "Resetting…" : "↺ Reset"}
            </button>
          )}
          <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted, lineHeight: 1, userSelect: "none" }}>
            {collapsed ? "▸" : "▾"}
          </span>
        </div>
      </div>

      {/* Body */}
      {!collapsed && (loading ? (
        <div style={{ padding: "24px 18px", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          Loading…
        </div>
      ) : milestones.length === 0 ? (
        <div style={{ padding: "32px 18px", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            No milestones set for this shipment.
          </div>
          <Btn onClick={() => handleInit(false)} disabled={initializing}>
            {initializing ? "Initializing…" : "⚑ Initialize Milestones"}
          </Btn>
        </div>
      ) : (
        <div style={{ padding: "18px 18px 10px" }}>
          {/* Progress bar */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ height: 4, background: T.border, borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progress}%`, background: T.success,
                transition: "width .3s ease", borderRadius: 2 }} />
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, marginTop: 4 }}>
              {progress}% complete
            </div>
          </div>

          {/* Steps */}
          {milestones.map((m, idx) => {
            const state      = milestoneState(m, idx);
            const color      = stateColor(state);
            const isLast     = idx === milestones.length - 1;
            const isExpanded = expanded === m.id;
            const isBusy     = saving === m.id;
            const f          = fields[m.id] || {};

            return (
              <div key={m.id} style={{ display: "flex", gap: 14 }}>
                {/* Timeline column */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
                  flexShrink: 0, width: 30 }}>
                  <div
                    onClick={() => !m.completedAt && setExpanded(isExpanded ? null : m.id)}
                    style={{
                      width: 28, height: 28, borderRadius: "50%",
                      background: state === 'upcoming' ? T.surface : color,
                      border: `2px solid ${color}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: state === 'upcoming' ? T.textMuted : "#fff",
                      fontSize: state === 'completed' || state === 'overdue' ? 12 : 14,
                      fontWeight: 700, flexShrink: 0,
                      cursor: state !== 'completed' ? "pointer" : "default",
                      boxShadow: state === 'current' ? `0 0 0 5px ${color}22` : "none",
                      lineHeight: 1,
                    }}>
                    {state === 'completed' ? "✓" : state === 'overdue' ? "!" : (MILESTONE_ICONS[m.milestoneKey] || m.sequenceOrder)}
                  </div>
                  {!isLast && (
                    <div style={{ width: 2, flex: 1, minHeight: 28,
                      background: m.completedAt ? T.success : T.border, opacity: .45 }} />
                  )}
                </div>

                {/* Content column */}
                <div style={{ flex: 1, paddingBottom: isLast ? 8 : 24 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2,
                    cursor: state !== 'completed' ? "pointer" : "default" }}
                    onClick={() => !m.completedAt && setExpanded(isExpanded ? null : m.id)}>
                    <span style={{ fontFamily: T.body, fontSize: 13,
                      fontWeight: state === 'current' ? 700 : 500,
                      color: state === 'upcoming' ? T.textMuted : T.text }}>
                      {m.label}
                    </span>
                    {state === 'current' && <Badge variant="info" size={10}>Current</Badge>}
                    {state === 'overdue' && <Badge variant="danger" size={10}>Overdue</Badge>}
                  </div>

                  {/* Sub-info line */}
                  <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, display: "flex", gap: 8 }}>
                    {m.completedAt && (
                      <span>Completed {fmtCompleted(m.completedAt)}{m.completedBy ? ` · ${m.completedBy}` : ""}</span>
                    )}
                    {!m.completedAt && m.estimatedDate && (
                      <span style={{ color: state === 'overdue' ? T.danger : T.textMuted }}>
                        Est. {m.estimatedDate}
                      </span>
                    )}
                    {m.note && <span>{m.note}</span>}
                  </div>

                  {/* Expanded edit form */}
                  {isExpanded && !m.completedAt && (
                    <div style={{ marginTop: 10, padding: "12px 14px",
                      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
                      display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
                            marginBottom: 4, textTransform: "uppercase", letterSpacing: ".06em" }}>
                            Estimated Date
                          </div>
                          <input type="date"
                            value={f.estimatedDate ?? m.estimatedDate}
                            onChange={e => setFields(prev => ({ ...prev, [m.id]: { ...prev[m.id], estimatedDate: e.target.value } }))}
                            style={{ fontFamily: T.mono, fontSize: 12, padding: "5px 8px", borderRadius: 6,
                              border: `1px solid ${T.border}`, background: T.surface, color: T.text, outline: "none" }} />
                        </div>
                        <div style={{ flex: 1, minWidth: 140 }}>
                          <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
                            marginBottom: 4, textTransform: "uppercase", letterSpacing: ".06em" }}>
                            Note
                          </div>
                          <input type="text"
                            value={f.note ?? m.note}
                            onChange={e => setFields(prev => ({ ...prev, [m.id]: { ...prev[m.id], note: e.target.value } }))}
                            placeholder="Optional note…"
                            style={{ fontFamily: T.body, fontSize: 12, padding: "5px 8px", borderRadius: 6,
                              border: `1px solid ${T.border}`, background: T.surface, color: T.text,
                              outline: "none", width: "100%", boxSizing: "border-box" }} />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <Btn size="sm" onClick={() => handleSaveFields(m)} disabled={isBusy}>
                          {isBusy ? "Saving…" : "Save"}
                        </Btn>
                        <Btn size="sm" variant="success" onClick={() => handleToggleComplete(m)} disabled={isBusy}>
                          ✓ Mark Complete
                        </Btn>
                        <button type="button" onClick={() => setExpanded(null)}
                          style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted,
                            background: "none", border: "none", cursor: "pointer" }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Undo for completed */}
                  {m.completedAt && (
                    <button type="button" onClick={() => handleToggleComplete(m)} disabled={isBusy}
                      style={{ marginTop: 3, fontFamily: T.body, fontSize: 10, color: T.textMuted,
                        background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                      {isBusy ? "Undoing…" : "↩ Undo"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

// ─── Operational Accounting ───────────────────────────────────────────────────

const CHARGE_CODES = ["Ocean Freight", "Origin THC", "Destination THC", "B/L Fee", "Customs", "Inland", "Other"];
const CURRENCIES   = ["USD", "EUR", "GBP", "CNY", "SGD", "JPY", "AED", "CHF"];

const marginColor  = pct => pct == null ? T.textMuted : pct >= 20 ? T.success : pct >= 10 ? T.warning : T.danger;
const marginVariant = pct => pct == null ? "default" : pct >= 20 ? "success" : pct >= 10 ? "warning" : "danger";

const fmtUsd = v => v == null ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const CostLineForm = ({ init = {}, fxRates = {}, containers = [], lockType = null, onSave, onSaveAndMirror, onCancel }) => {
  const [type,         setType]         = useState(lockType || init.type || "BUY");
  const [chargeCode,   setChargeCode]   = useState(init.chargeCode   || "Ocean Freight");
  const [currency,     setCurrency]     = useState(init.currency     || "USD");
  const [amount,       setAmount]       = useState(init.amount       != null ? String(init.amount) : "");
  const [exchangeRate, setExchangeRate] = useState(init.exchangeRate != null ? String(init.exchangeRate) : "1");
  const [vatRate,      setVatRate]      = useState(init.vatRate      != null ? String(init.vatRate) : "0");
  const [notes,        setNotes]        = useState(init.notes        || "");
  const [containerId,  setContainerId]  = useState(init.containerId  || "");
  const isEdit = !!init.id;

  // Auto-fill exchange rate when currency changes (rates are FROM USD: 1 USD = X ccy)
  const handleCurrency = c => {
    setCurrency(c);
    if (c === "USD") { setExchangeRate("1"); return; }
    const rate = fxRates[c];
    if (rate) setExchangeRate(String(Math.round((1 / rate) * 100000) / 100000));
  };

  const amtNum  = parseFloat(amount)       || 0;
  const rateNum = parseFloat(exchangeRate) || 1;
  const vatNum  = parseFloat(vatRate)      || 0;
  const amtUsd  = Math.round(amtNum * rateNum * 100) / 100;
  const vatUsd  = type === "SELL" ? Math.round(amtUsd * vatNum / 100 * 100) / 100 : 0;
  const valid   = amtNum > 0 && chargeCode;

  const lbl = { fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 };
  const inp = { fontFamily: T.body, fontSize: 14, color: T.text, background: T.bg,
    border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 12px",
    outline: "none", width: "100%", boxSizing: "border-box" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 0" }}>
      <div style={{ display: "grid", gridTemplateColumns: lockType ? "1fr" : "1fr 1fr", gap: 12 }}>
        {!lockType && (
          <div>
            <div style={lbl}>Type</div>
            <select value={type} onChange={e => setType(e.target.value)} style={inp}>
              <option value="BUY">BUY (Cost)</option>
              <option value="SELL">SELL (Revenue)</option>
            </select>
          </div>
        )}
        <div>
          <div style={lbl}>Charge Code</div>
          <select value={chargeCode} onChange={e => setChargeCode(e.target.value)} style={inp}>
            {CHARGE_CODES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <div>
          <div style={lbl}>Currency</div>
          <select value={currency} onChange={e => handleCurrency(e.target.value)} style={inp}>
            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <div style={lbl}>Amount</div>
          <input type="number" min="0" step="0.01" value={amount}
            onChange={e => setAmount(e.target.value)} placeholder="0.00" style={inp} autoFocus={!isEdit} />
        </div>
        <div>
          <div style={lbl}>Exchange Rate → USD</div>
          <input type="number" min="0.000001" step="0.0001" value={exchangeRate}
            onChange={e => setExchangeRate(e.target.value)} style={inp} />
        </div>
      </div>
      {currency !== "USD" && (
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
          ≈ {fmtUsd(amtUsd)} USD at rate {rateNum}
        </div>
      )}
      {type === "SELL" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, alignItems: "end" }}>
          <div>
            <div style={lbl}>VAT Rate (%)</div>
            <input type="number" min="0" max="100" step="0.1" value={vatRate}
              onChange={e => setVatRate(e.target.value)} placeholder="0" style={inp} />
          </div>
          {vatNum > 0 && (
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, paddingBottom: 9 }}>
              VAT: {fmtUsd(vatUsd)} — Total incl. VAT: {fmtUsd(amtUsd + vatUsd)}
            </div>
          )}
        </div>
      )}
      {containers.length > 0 && (
        <div>
          <div style={lbl}>Container <span style={{ fontWeight: 400, color: T.textMuted, textTransform: "none", letterSpacing: 0 }}>(optional — leave blank for shipment-level)</span></div>
          <select value={containerId} onChange={e => setContainerId(e.target.value)} style={inp}>
            <option value="">— All containers / shipment-level —</option>
            {containers.map(c => {
              const label = c.containerNumber
                ? `${c.containerNumber}${c.size || c.type ? ` (${c.size}${c.type})` : ''}`
                : `(${c.size || ""}${c.type || ""})`;
              return <option key={c.id} value={c.id}>{label}</option>;
            })}
          </select>
        </div>
      )}
      <div>
        <div style={lbl}>Notes</div>
        <input value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Optional notes…" style={inp} />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn variant="secondary"
          onClick={() => onSaveAndMirror({ type, chargeCode, currency, amount: amtNum, exchangeRate: rateNum, vatRate: vatNum, notes, containerId })}
          disabled={!valid}
          title={`Save this line and create a mirrored ${type === "BUY" ? "SELL" : "BUY"} line with the same values`}>
          ⇄ Mirror as {type === "BUY" ? "SELL" : "BUY"}
        </Btn>
        <Btn onClick={() => onSave({ type, chargeCode, currency, amount: amtNum, exchangeRate: rateNum, vatRate: vatNum, notes, containerId })} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Line"}
        </Btn>
      </div>
    </div>
  );
};

const CL_FIELD_LABELS = {
  type: "Type", charge_code: "Charge Code", currency: "Currency",
  amount: "Amount", exchange_rate: "Exchange Rate", notes: "Notes", container_id: "Container",
};

export const CostLineHistoryModal = ({ shipmentId, onClose }) => {
  const [events,    setEvents]    = useState([]);
  const [lineIndex, setLineIndex] = useState({});
  const [loading,   setLoading]   = useState(true);
  const [filter,    setFilter]    = useState(new Set(["CREATED","IMPORTED","UPDATED","DELETED","GENERATED","CONFIRMED","AUTO_REMOVED"]));

  useEffect(() => {
    Promise.all([api.costLines.events(shipmentId), api.costLines.list(shipmentId)])
      .then(([evts, lines]) => {
        setEvents(evts);
        setLineIndex(Object.fromEntries(lines.map(l => [l.id, l])));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [shipmentId]);

  const toggleFilter = t =>
    setFilter(prev => { const s = new Set(prev); s.has(t) ? s.delete(t) : s.add(t); return s; });

  const visible = events.filter(e => filter.has(e.event_type));

  const evtColor = t => ({
    CREATED: T.success, IMPORTED: T.info, UPDATED: T.warning, DELETED: T.danger,
    GENERATED: T.info, CONFIRMED: T.success, AUTO_REMOVED: T.warning,
  }[t] || T.textMuted);

  // Cost/invoice lines show their charge code; generated invoice documents (a different
  // entity_type sharing this same history feed) show their doc type + scope instead.
  const resolveLabel = ev => {
    try {
      const m = JSON.parse(ev.meta || "{}");
      if (ev.entity_type === "document") {
        const scope = m.containerId ? `Container ${m.containerId}` : "Consolidated";
        return `${m.docType || "Doc"} — ${scope}`;
      }
      if (m.chargeCode) return m.chargeCode;
    } catch {}
    return lineIndex[ev.entity_id]?.chargeCode || ev.entity_id;
  };

  const fmtVal = (field, val) => {
    if (val == null || val === "") return "—";
    if (field === "amount" || field === "exchange_rate") return Number(val).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return String(val);
  };

  const exportCsv = () => {
    const rows = [["Time","Event","Item","Field","Old Value","New Value","ID"]];
    visible.forEach(e => rows.push([
      e.created_at, e.event_type, resolveLabel(e),
      CL_FIELD_LABELS[e.field] || e.field || "",
      fmtVal(e.field, e.old_value), fmtVal(e.field, e.new_value), e.entity_id,
    ]));
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `cost-line-history-${shipmentId}.csv`;
    a.click();
  };

  const th = { fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".07em" };

  const TYPE_LABELS = {
    CREATED: "Created", IMPORTED: "Imported", UPDATED: "Updated", DELETED: "Deleted",
    GENERATED: "Generated", CONFIRMED: "Confirmed", AUTO_REMOVED: "Auto-removed",
  };
  const ALL_TYPES = ["CREATED","IMPORTED","UPDATED","DELETED","GENERATED","CONFIRMED","AUTO_REMOVED"];

  return (
    <Modal title={`Accounting History — ${shipmentId}`} onClose={onClose} width={860}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Toolbar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>Show:</span>
            {ALL_TYPES.map(t => (
              <button key={t} type="button"
                onClick={() => toggleFilter(t)}
                style={{ fontFamily: T.body, fontSize: 11, borderRadius: 7, padding: "3px 10px", cursor: "pointer",
                  border: `1px solid ${filter.has(t) ? evtColor(t) : T.border}`,
                  background: filter.has(t) ? `${evtColor(t)}18` : "none",
                  color: filter.has(t) ? evtColor(t) : T.textMuted }}>
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
          <button type="button" onClick={exportCsv}
            style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, background: "none",
              border: `1px solid ${T.border}`, borderRadius: 7, padding: "4px 12px", cursor: "pointer" }}>
            ⬇ CSV
          </button>
        </div>

        {/* Table */}
        {loading ? (
          <div style={{ padding: 24, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
            No events recorded yet.
          </div>
        ) : (
          <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "6px 16px",
              background: T.bg, borderBottom: `1px solid ${T.border}33` }}>
              <div style={{ ...th, width: 150, flexShrink: 0 }}>Time</div>
              <div style={{ ...th, width: 100, flexShrink: 0 }}>Event</div>
              <div style={{ ...th, flex: 1 }}>Item</div>
              <div style={{ ...th, width: 110, flexShrink: 0 }}>Field</div>
              <div style={{ ...th, width: 130, flexShrink: 0 }}>Old Value</div>
              <div style={{ ...th, width: 130, flexShrink: 0 }}>New Value</div>
            </div>
            <div style={{ maxHeight: 460, overflowY: "auto" }}>
              {visible.map(ev => {
                const charge = resolveLabel(ev);
                const fieldLabel = CL_FIELD_LABELS[ev.field] || ev.field || null;
                const isUpdate = ev.event_type === "UPDATED";
                return (
                  <div key={ev.id}
                    style={{ display: "flex", alignItems: "center", padding: "9px 16px",
                      borderBottom: `1px solid ${T.border}22` }}
                    onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <div style={{ width: 150, flexShrink: 0, fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                      {new Date(ev.created_at).toLocaleString("en-GB", { day: "2-digit", month: "short",
                        year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </div>
                    <div style={{ width: 100, flexShrink: 0 }}>
                      <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600,
                        color: evtColor(ev.event_type),
                        background: `${evtColor(ev.event_type)}18`,
                        border: `1px solid ${evtColor(ev.event_type)}44`,
                        borderRadius: 6, padding: "2px 7px" }}>
                        {TYPE_LABELS[ev.event_type] || ev.event_type}
                      </span>
                    </div>
                    <div style={{ flex: 1, fontFamily: T.body, fontSize: 12, color: T.text,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{charge}</div>
                    <div style={{ width: 110, flexShrink: 0, fontFamily: T.body, fontSize: 11,
                      color: isUpdate ? T.text : T.textMuted }}>
                      {fieldLabel || (isUpdate ? "—" : "")}
                    </div>
                    <div style={{ width: 130, flexShrink: 0, fontFamily: T.mono, fontSize: 11,
                      color: T.danger, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {isUpdate ? fmtVal(ev.field, ev.old_value) : ""}
                    </div>
                    <div title={ev.event_type === "AUTO_REMOVED" ? "No charge lines remained for this invoice's scope, so it was removed automatically" : undefined}
                      style={{ width: 130, flexShrink: 0, fontFamily: T.mono, fontSize: 11,
                      color: isUpdate ? T.success : T.textMuted,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {isUpdate ? fmtVal(ev.field, ev.new_value) : (
                        ev.event_type === "CREATED"      ? "Manual entry" :
                        ev.event_type === "IMPORTED"     ? "From contract" :
                        ev.event_type === "DELETED"      ? "Removed" :
                        ev.event_type === "GENERATED"    ? "Invoice generated" :
                        ev.event_type === "CONFIRMED"    ? "Marked confirmed" :
                        ev.event_type === "AUTO_REMOVED" ? "Orphaned, removed" : ""
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!loading && visible.length > 0 && (
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, textAlign: "right" }}>
            {visible.length} event{visible.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </Modal>
  );
};

// Single cost-line row — shared by the Overview preview card and the dedicated
// Cost Entry / Invoice Entry pages' full tables.
export const CostLineRow = ({ line: l, containers = [], showActions = false, onEdit, onDelete }) => {
  const ctr = l.containerId ? containers.find(c => c.id === l.containerId) : null;
  const ctrLabel = ctr ? (ctr.containerNumber || `(${ctr.size || ""}${ctr.type || ""})`) : null;
  // Mirror direction is derived from the line's own type, not stored separately: a
  // SELL line tagged 'mirror' was created BY mirroring a BUY line (Cost Entry), and
  // vice versa — that's the only way a mirrored line comes into existence.
  const src = l.source === "contract" && l.modifiedAt ? { label: "Contract (Modified)", color: T.warning }
    : l.source === "contract" ? { label: "Contract", color: T.info }
    : l.source === "mirror" ? { label: l.type === "SELL" ? "Mirrored ← Cost Entry" : "Mirrored ← Invoice Entry", color: T.accent }
    : { label: "Manual", color: T.textMuted };
  return (
    <div key={l.id}
      style={{ display: "flex", alignItems: "center", padding: showActions ? "9px 16px" : "8px 18px",
        borderBottom: `1px solid ${T.border}22` }}
      onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      {/* Type */}
      <div style={{ width: showActions ? 60 : 46, flexShrink: 0 }}>
        <Badge variant={l.type === "BUY" ? "warning" : "success"}>{l.type}</Badge>
      </div>
      {/* Charge */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.text,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.chargeCode}</div>
        {l.type === "SELL" && l.vatRate > 0 && (
          <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: T.info,
            background: `${T.info}18`, border: `1px solid ${T.info}44`,
            borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap", flexShrink: 0 }}>
            VAT {l.vatRate}%
          </span>
        )}
      </div>
      {/* Container */}
      <div style={{ width: showActions ? 100 : 80, flexShrink: 0, paddingLeft: 4,
        fontFamily: T.mono, fontSize: showActions ? 11 : 10,
        color: ctrLabel ? T.accent : T.border,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {ctrLabel || "—"}
      </div>
      {/* Source (modal only) */}
      {showActions && (
        <div style={{ width: 160, flexShrink: 0, paddingLeft: 4 }}>
          <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 600,
            color: src.color, background: `${src.color}18`,
            border: `1px solid ${src.color}44`,
            borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap" }}>
            {src.label}
          </span>
        </div>
      )}
      {/* Currency */}
      <div style={{ width: showActions ? 80 : 60, flexShrink: 0,
        fontFamily: T.mono, fontSize: 11, color: T.text }}>{l.currency}</div>
      {/* Exch. Rate */}
      {showActions && (
        <div style={{ width: 100, flexShrink: 0,
          fontFamily: T.mono, fontSize: 11, color: T.textMuted, textAlign: "right" }}>
          {l.exchangeRate === 1 ? "1.0000" : l.exchangeRate.toFixed(4)}
        </div>
      )}
      {/* Amount */}
      <div style={{ width: showActions ? 110 : 80, flexShrink: 0,
        fontFamily: T.mono, fontSize: 12, textAlign: "right", fontWeight: 600,
        color: (l.amount === 0 && l.source === 'contract' && l.type === 'BUY') ? T.warning : T.text }}>
        {l.amount === 0 && l.source === 'contract' && l.type === 'BUY'
          ? <span title="No matching rate for this container type — set manually">⚠ 0.00</span>
          : l.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        }
      </div>
      {/* Actions */}
      {showActions && (
        <div style={{ width: 36, flexShrink: 0 }}>
          <ActionMenu items={[
            { icon: "✎", label: "Edit",   onClick: onEdit },
            { icon: "✕", label: "Delete", variant: "danger", onClick: onDelete },
          ]} />
        </div>
      )}
    </div>
  );
};

// ─── Document Preview Modal ───────────────────────────────────────────────────
// Shows the generated PDF in an iframe before the user commits to downloading.
const DocumentPreviewModal = ({ dataUri, filename, onConfirm, onCancel }) => (
  <div style={{ position: "fixed", inset: 0, zIndex: 10001,
    background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center",
    justifyContent: "center" }}
    onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
    <div style={{ width: "min(96vw, 1000px)", height: "92vh", background: T.surface,
      border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden",
      display: "flex", flexDirection: "column",
      boxShadow: "0 28px 80px rgba(0,0,0,.6)" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>📄</span>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{filename}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel}
            style={{ fontFamily: T.body, fontSize: 13, padding: "7px 16px",
              background: "none", border: `1px solid ${T.border}`, borderRadius: 7,
              color: T.textMuted, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={onConfirm}
            style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700,
              padding: "7px 18px", background: T.accent, border: "none",
              borderRadius: 7, color: "#fff", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 7 }}>
            <span>💾</span> Download PDF
          </button>
        </div>
      </div>

      {/* PDF iframe */}
      <iframe
        src={dataUri}
        title={filename}
        style={{ flex: 1, border: "none", width: "100%" }}
      />
    </div>
  </div>
);

// ─── Documents dropdown ───────────────────────────────────────────────────────
// Generates PDFs client-side using jsPDF. No server round-trip needed.
const DocumentsMenu = ({ shipment, containers: allContainers }) => {
  const containers        = allContainers.filter(c => c.shipmentId === shipment.id);
  const [open, setOpen]   = useState(false);
  const [preview, setPreview] = useState(null); // { dataUri, filename, doc }
  const ref               = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const openPreview = generator => {
    setOpen(false);
    const { doc, filename } = generator(shipment, containers);
    setPreview({ doc, filename, dataUri: doc.output("datauristring") });
  };

  const docs = [
    {
      icon: "📋",
      label: "B/L Draft",
      hint: "House Bill of Lading (draft)",
      action: () => openPreview(generateBLDraft),
    },
    {
      icon: "📦",
      label: "Packing List",
      hint: "Per-container cargo lines",
      action: () => openPreview(generatePackingList),
    },
    {
      icon: "🗂",
      label: "Container Manifest",
      hint: "Full container listing for the voyage",
      action: () => openPreview(generateContainerManifest),
    },
  ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          fontFamily: T.body, fontSize: 12, fontWeight: 600, cursor: "pointer",
          padding: "7px 12px", borderRadius: 8,
          background: open ? `${T.accent}15` : "none",
          border: `1px solid ${open ? T.accent : T.border}`,
          color: open ? T.accent : T.text,
          display: "flex", alignItems: "center", gap: 6,
          transition: "border-color .15s, color .15s, background .15s",
        }}
        onMouseEnter={e => { if (!open) { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; } }}
        onMouseLeave={e => { if (!open) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.text; } }}
      >
        <span>📄</span>
        <span>Documents</span>
        <span style={{ fontSize: 9, opacity: .6 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 500,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,.35)", minWidth: 220, overflow: "hidden",
        }}>
          <div style={{ padding: "8px 14px 6px",
            fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".07em", borderBottom: `1px solid ${T.border}22` }}>
            Generate PDF
          </div>
          {docs.map(d => (
            <button key={d.label}
              onClick={containers.length > 0 ? d.action : undefined}
              disabled={containers.length === 0}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "10px 14px", background: "none", border: "none",
                cursor: containers.length > 0 ? "pointer" : "not-allowed",
                textAlign: "left", transition: "background .1s",
                opacity: containers.length === 0 ? 0.4 : 1,
              }}
              onMouseEnter={e => { if (containers.length > 0) e.currentTarget.style.background = `${T.accent}10`; }}
              onMouseLeave={e => e.currentTarget.style.background = "none"}
            >
              <span style={{ fontSize: 18, flexShrink: 0 }}>{d.icon}</span>
              <div>
                <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>
                  {d.label}
                </div>
                <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                  {d.hint}
                </div>
              </div>
            </button>
          ))}
          {containers.length === 0 && (
            <div style={{ padding: "4px 14px 12px",
              fontFamily: T.body, fontSize: 11, color: T.warning, fontStyle: "italic" }}>
              ⚠ Add containers first — documents use container data.
            </div>
          )}
        </div>
      )}
      {preview && (
        <DocumentPreviewModal
          dataUri={preview.dataUri}
          filename={preview.filename}
          onConfirm={() => { preview.doc.save(preview.filename); setPreview(null); }}
          onCancel={() => setPreview(null)}
        />
      )}
    </div>
  );
};

// ─── Pending contract revalidation modal ──────────────────────────────────────

const ContractCard = ({ contract, selected, onSelect }) => {
  const validRange = [contract.validFrom, contract.validTo].filter(Boolean).join(" → ") || "—";
  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex", flexDirection: "column", gap: 6,
        padding: "12px 16px", borderRadius: 8, cursor: onSelect ? "pointer" : "default",
        border: `1px solid ${selected ? T.accent : T.border}`,
        background: selected ? T.accent + "0d" : T.bg,
        transition: "border-color .15s, background .15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.accent }}>
          {contract.contractNumber}
        </span>
        {contract.contractRef && (
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
            {contract.contractRef}
          </span>
        )}
        <Badge variant="success">{contract.status}</Badge>
      </div>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          Carrier <span style={{ fontFamily: T.mono, color: T.text, fontWeight: 600 }}>{contract.carrierCode}</span>
        </span>
        {contract.namedAccount && (
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            Account <span style={{ color: T.text }}>{contract.namedAccount}</span>
          </span>
        )}
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          Valid <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>{validRange}</span>
        </span>
      </div>
    </div>
  );
};

const PendingRevalidationModal = ({ matches, contractRef, onAccept, onDismiss }) => {
  const [selected, setSelected] = useState(matches.length === 1 ? matches[0].id : null);
  const single = matches.length === 1;
  const selectedContract = matches.find(c => c.id === selected) || null;

  return (
    <Modal
      title={single ? "Contract Match Found" : "Multiple Contracts Found"}
      onClose={onDismiss}
      width={540}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6, margin: 0 }}>
          {single
            ? <>An active Central contract matching <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.accent }}>{contractRef}</span> was found. Switch this shipment to use it, or keep the Pending status.</>
            : <>{matches.length} active contracts matching <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.accent }}>{contractRef}</span> were found. Select one to use, or cancel to keep the Pending status.</>
          }
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {matches.map(c => (
            <ContractCard
              key={c.id}
              contract={c}
              selected={selected === c.id}
              onSelect={!single ? () => setSelected(c.id) : undefined}
            />
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 4 }}>
          <Btn variant="ghost" onClick={onDismiss}>Keep Pending</Btn>
          <Btn
            variant="primary"
            disabled={!selectedContract}
            onClick={() => selectedContract && onAccept(selectedContract)}
          >
            {single ? "Switch to Central Contract" : "Use Selected Contract"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Route Summary Bar ────────────────────────────────────────────────────────
// Extracted from the Overview page's old "shp-route" anchor section and moved
// exclusively to the Schedules page — self-fetching (legs + contract carrier
// fallback) so it drops in with just a `shipment` prop, same pattern as
// ScheduleHistoryPanel below.

export const RouteSummaryBar = ({ shipment }) => {
  const [legs, setLegs] = useState([]);
  const [contractCarrierCode, setContractCarrierCode] = useState("");

  useEffect(() => {
    api.legs.list(shipment.id).then(setLegs).catch(() => {});
  }, [shipment.id]);

  useEffect(() => {
    if (!shipment.contractId) { setContractCarrierCode(""); return; }
    api.contracts.get(shipment.contractId)
      .then(c => setContractCarrierCode(c.carrierCode || ""))
      .catch(() => setContractCarrierCode(""));
  }, [shipment.contractId]);

  const transitDays = (() => {
    if (!shipment.etd || !shipment.eta) return null;
    const d1 = new Date(shipment.etd), d2 = new Date(shipment.eta);
    if (isNaN(d1) || isNaN(d2)) return null;
    return Math.round((d2 - d1) / 864e5);
  })();
  const pkuLeg = legs.find(l => l.legType === "Pick-up" && l.movementType === "Carrier's Haulage");
  const delLeg = [...legs].reverse().find(l => l.legType === "Delivery" && l.movementType === "Carrier's Haulage");
  // shipment.pol/pod are the journey's overall bookends — with a Door pickup leg (or a
  // multi-leg TSP journey) that's not the same as the actual SEA leg's own pol/pod, so the
  // Port of Loading/Discharge cells must resolve the real SEA leg or they show the door
  // location instead of the port (and duplicate the PKU/DEL door cell alongside it).
  const seaLegs = legs.filter(l => l.legType === "SEA");
  // Intermediate transshipment hubs only — built from seaLegs (not all legs), and dropping
  // the last one, so this never re-shows the Pick-up leg's pod (== the POL cell) or the
  // final SEA leg's own pod (== the POD cell) a second time in the breadcrumb.
  const tsps = seaLegs.length > 1
    ? seaLegs.slice(0, -1).map(l => ({ code: l.pod, name: l.podName })).filter(t => t.code)
    : [];
  const firstSeaLeg = seaLegs[0];
  const lastSeaLeg = seaLegs[seaLegs.length - 1];
  const portPol = firstSeaLeg?.pol || shipment.pol;
  const portPolName = firstSeaLeg ? firstSeaLeg.polName : shipment.polName;
  const portPod = lastSeaLeg?.pod || shipment.pod;
  const portPodName = lastSeaLeg ? lastSeaLeg.podName : shipment.podName;
  const gridCols = `${pkuLeg ? "auto " : ""}1fr auto 1fr${delLeg ? " auto" : ""}`;
  const doorCell = { padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3, background: T.surface };

  return (
    <div style={{ display: "grid", gridTemplateColumns: gridCols,
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
      overflow: "hidden", marginBottom: 22 }}>

      {/* PKU door cell */}
      {pkuLeg && (
        <div style={{ ...doorCell, borderRight: `1px dashed ${T.border}` }}>
          <span style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: "0.09em", color: T.accent }}>Pick-up</span>
          <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>
            {pkuLeg.pol || "—"}
          </span>
          {pkuLeg.polName && (
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{pkuLeg.polName}</span>
          )}
          <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, marginTop: 2 }}>
            Carrier's Haulage →
          </span>
        </div>
      )}

      {/* POL */}
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.09em", color: T.textMuted }}>Port of Loading</span>
        <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700,
          color: portPol ? T.text : T.border }}>{portPol || "—"}</span>
        {portPolName && (
          <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{portPolName}</span>
        )}
      </div>

      {/* Centre: ETD / transit / ETA / carrier / routing term */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: 6, padding: "12px 24px",
        borderLeft: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}`,
        background: T.surface }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
            <span style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
              letterSpacing: "0.09em", color: T.textMuted }}>ETD</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: shipment.etd ? T.text : T.border }}>
              {shipment.etd || "—"}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            {transitDays !== null && transitDays >= 0
              ? <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.accent,
                  background: T.accentBg, border: `1px solid ${T.accent}33`,
                  borderRadius: 10, padding: "2px 10px", whiteSpace: "nowrap" }}>
                  {transitDays}d transit
                </span>
              : transitDays !== null && transitDays < 0
                ? <span title="ETA is before ETD — check leg dates" style={{ fontFamily: T.mono, fontSize: 11,
                    fontWeight: 700, color: T.warning, background: T.warning + "18",
                    border: `1px solid ${T.warning}44`, borderRadius: 10,
                    padding: "2px 10px", whiteSpace: "nowrap", cursor: "default" }}>
                    ⚠ dates
                  </span>
                : <span style={{ color: T.border, fontSize: 16 }}>→</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
            <span style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
              letterSpacing: "0.09em", color: T.textMuted }}>ETA</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: shipment.eta ? T.text : T.border }}>
              {shipment.eta || "—"}</span>
          </div>
        </div>
        {tsps.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
            {tsps.map((tsp, i) => (
              <span key={`${tsp.code}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                {i > 0 && <span style={{ color: T.textMuted, fontSize: 10 }}>›</span>}
                <span title={tsp.name || tsp.code}
                  style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text,
                    background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4,
                    padding: "1px 7px" }}>
                  {tsp.code}
                </span>
              </span>
            ))}
          </div>
        )}
        {(() => {
          const displayCarrier = shipment.carrierCode || contractCarrierCode;
          return (
            <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700,
              color: displayCarrier ? T.accent : T.border }}>
              {displayCarrier || "—"}
            </span>
          );
        })()}
        {shipment.routingTerm && (
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.text,
            background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 7px" }}>
            {shipment.routingTerm}
          </span>
        )}
      </div>

      {/* POD */}
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 3, textAlign: "right" }}>
        <span style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.09em", color: T.textMuted }}>Port of Discharge</span>
        <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700,
          color: portPod ? T.text : T.border }}>{portPod || "—"}</span>
        {portPodName && (
          <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{portPodName}</span>
        )}
      </div>

      {/* DEL door cell */}
      {delLeg && (
        <div style={{ ...doorCell, borderLeft: `1px dashed ${T.border}`, textAlign: "right" }}>
          <span style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: "0.09em", color: T.accent }}>Delivery</span>
          <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>
            {delLeg.pod || "—"}
          </span>
          {delLeg.podName && (
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{delLeg.podName}</span>
          )}
          <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, marginTop: 2 }}>
            → Carrier's Haulage
          </span>
        </div>
      )}

    </div>
  );
};

// ─── Schedules Panel ──────────────────────────────────────────────────────────

// Sailing search/apply mechanics (SailingPickerModal, applySailingToLegs, commitSailing)
// live in ShipmentSchedulesPage now, next to the Route Legs section its "Add Sailing"
// button belongs to. This panel is purely a read-only log of what changed and when —
// same entity_events idiom already used for cost lines/documents/services.
export const ScheduleHistoryPanel = ({ shipment }) => {
  const [events,   setEvents]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.schedules.events(shipment.id)
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [shipment.id]);

  const EVENT_COLOR = { SAVED: T.success, REMOVED: T.danger };

  return (
    <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
      <button type="button" onClick={() => setExpanded(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
          padding: "14px 20px", background: "none", border: "none", cursor: "pointer", textAlign: "left",
          borderBottom: expanded ? `1px solid ${T.border}` : "none" }}>
        <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.textMuted }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 800, color: T.text }}>Schedule History</span>
        {events.length > 0 && (
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            background: T.accentBg, color: T.accent, border: `1px solid ${T.accent}33`,
            borderRadius: 4, padding: "1px 7px" }}>{events.length}</span>
        )}
      </button>

      {expanded && (
      <div style={{ padding: "14px 20px" }}>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.textMuted,
            fontFamily: T.body, fontSize: 12 }}>
            <Spinner size="sm" /> Loading…
          </div>
        ) : events.length === 0 ? (
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic", padding: "8px 0" }}>
            No schedule changes yet — sailings picked via "Add Sailing" will show up here.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {events.map(ev => {
              const m = ev.meta ? JSON.parse(ev.meta) : {};
              const color = EVENT_COLOR[ev.event_type] || T.textMuted;
              return (
                <div key={ev.id} style={{ display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 14px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: "0.03em",
                    padding: "2px 8px", borderRadius: 4, textTransform: "uppercase",
                    background: color + "22", color, border: `1px solid ${color}55`, flexShrink: 0 }}>
                    {ev.event_type}
                  </span>
                  <div style={{ flex: 1, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 120 }}>
                      <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>
                        {m.vesselName || "—"}
                      </span>
                      <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                        {m.service || "—"}{m.voyageNumber ? ` · Voy ${m.voyageNumber}` : ""}
                      </span>
                    </div>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>
                      {m.pol || "—"} → {m.pod || "—"}
                    </span>
                    {(m.etd || m.eta) && (
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                        {m.etd || "—"} → {m.eta || "—"}
                      </span>
                    )}
                    <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, marginLeft: "auto", whiteSpace: "nowrap" }}>
                      {new Date(ev.created_at).toLocaleDateString("en-GB")}
                      {m.actor ? ` by ${m.actor}` : ""}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}
    </div>
  );
};

// ─── Related Tickets Panel ────────────────────────────────────────────────────

const PRIORITY_COLOR = { High: T.danger, Medium: T.warning, Low: T.textMuted, Critical: "#f97316" };
const STATUS_DOT = { Done: T.success, "In Progress": T.accent, Ready: T.textMuted, Blocked: T.danger };

export const RelatedTicketsPanel = ({ shipmentId }) => {
  const [tickets,  setTickets]  = useState([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    api.tickets.forShipment(shipmentId)
      .then(setTickets)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [shipmentId]);

  return (
    <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 20px", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 800, color: T.text }}>Related Tickets</span>
          {tickets.length > 0 && (
            <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              background: T.accentBg, color: T.accent, border: `1px solid ${T.accent}33`,
              borderRadius: 4, padding: "1px 7px" }}>{tickets.length}</span>
          )}
        </div>
      </div>
      <div style={{ padding: "14px 20px" }}>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.textMuted,
            fontFamily: T.body, fontSize: 12 }}>
            <Spinner size="sm" /> Loading…
          </div>
        ) : tickets.length === 0 ? (
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic", padding: "8px 0" }}>
            No tickets linked to this shipment.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {tickets.map(t => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12,
                padding: "9px 14px", background: T.bg,
                border: `1px solid ${T.border}`, borderRadius: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                  background: STATUS_DOT[t.status] || T.textMuted }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: T.body, fontSize: 13, color: T.text,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.title}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 2, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{t.id}</span>
                    <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>{t.status}</span>
                    {t.assigneeName && (
                      <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>
                        → {t.assigneeName}
                      </span>
                    )}
                  </div>
                </div>
                <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, flexShrink: 0,
                  color: PRIORITY_COLOR[t.priority] || T.textMuted }}>
                  {t.priority}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────────

const ShipmentDetailPage = ({ shipment, containers, carriers, onBack, onUpdate, onEdit, onRefresh, onAddContainer, onEditContainer, onDeleteContainer, onManageContainers, onManagePartiesOffices, onManageSchedules, onManageMilestones, onManageTickets, onManageAccountingCosts, onManageAccountingInvoices, onManageAccountingGp, detailAction = null, onDetailActionConsumed }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [ctrModal,       setCtrModal]       = useState(null);
  const [linkVesselOpen, setLinkVesselOpen] = useState(false);
  const [confirmCtr,     setConfirmCtr]     = useState(null);
  const [statusLog,      setStatusLog]      = useState([]);
  const [historyOpen,    setHistoryOpen]    = useState(false);
  const [events,         setEvents]         = useState([]);
  const [allocations,    setAllocations]    = useState([]);
  const [isDirty,        setIsDirty]        = useState(false);
  const [msgsOpen,       setMsgsOpen]       = useState(false);
  const [messages,       setMessages]       = useState([]);
  const [unreadCount,    setUnreadCount]    = useState(0);
  const [ediOpen,        setEdiOpen]        = useState(false);
  const [ediMessages,    setEdiMessages]    = useState([]);
  const [spaceBadge,     setSpaceBadge]     = useState(shipment.spaceBadge || "");
  const [contractOpen,   setContractOpen]   = useState(false);
  const [ctrListOpen,    setCtrListOpen]    = useState(false);
  const [ctrFromList,    setCtrFromList]    = useState(false);
  const [eventsCtr,      setEventsCtr]      = useState(null);
  const [dgPolicy,             setDgPolicy]             = useState(null);
  const [pendingMatches,       setPendingMatches]       = useState(null);
  const [shareUrl,             setShareUrl]             = useState(null);
  const [shareLoading,         setShareLoading]         = useState(false);
  const [milestoneProg,        setMilestoneProg]        = useState(null);

  // Milestones are now a promoted sub-page, so the header progress chip needs
  // its own lightweight fetch instead of relying on MilestonePanel's onProgress.
  useEffect(() => {
    api.milestones.list(shipment.id)
      .then(m => setMilestoneProg({ done: m.filter(x => x.completedAt).length, total: m.length }))
      .catch(() => setMilestoneProg({ done: 0, total: 0 }));
  }, [shipment.id]);

  const closeCtrModal = (fromList = ctrFromList) => {
    setCtrModal(null);
    setCtrFromList(false);
    if (fromList) setCtrListOpen(true);
  };

  // Sidebar section link → open corresponding management panel
  useEffect(() => {
    if (!detailAction) return;
    if (detailAction === "shp-cargo")      setCtrListOpen(true);
    onDetailActionConsumed?.();
  }, [detailAction]);

  // Tab title — show shipment ID so multi-tab workflows are easy to navigate
  useEffect(() => {
    document.title = `${shipment.id} · CargoDesk`;
    return () => { document.title = "CargoDesk"; };
  }, [shipment.id]);

  // Warn before closing tab when a form has unsaved changes
  useEffect(() => {
    const handler = e => { if (isDirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  useEffect(() => {
    if (!shipment?.id) return;
    api.statusLog.list(shipment.id).then(setStatusLog).catch(() => setStatusLog([]));
    api.shipmentEvents.list(shipment.id).then(setEvents).catch(() => setEvents([]));
  }, [shipment?.id, shipment?.status]);

  useEffect(() => { api.allocations.list().then(setAllocations).catch(() => {}); }, []);

  const loadMessagesRef = useRef(null);
  const loadMessages = () =>
    api.shipmentMessages.list(shipment.id).then(msgs => {
      setMessages(msgs);
      const lastRead = localStorage.getItem(`msg_read_${shipment.id}`) || "";
      setUnreadCount(msgs.filter(m => m.createdAt > lastRead).length);
    }).catch(() => {});
  loadMessagesRef.current = loadMessages;

  useEffect(() => { loadMessages(); }, [shipment.id]);

  // Keep space badge in sync whenever the shipment prop is replaced by the parent
  useEffect(() => { setSpaceBadge(shipment.spaceBadge || ""); }, [shipment.id, shipment.spaceBadge]);

  // Always-on WS subscription for space badge updates
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsHost = import.meta.env.DEV ? "localhost:3001" : window.location.host;
    const ws = new WebSocket(`${proto}//${wsHost}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", shipmentId: shipment.id }));
    ws.onmessage = e => {
      try {
        const frame = JSON.parse(e.data);
        if (frame.type === "space_badge_update") setSpaceBadge(frame.badge || "");
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, [shipment.id]);

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

    return () => {
      ws.close();
      if (pollId) clearInterval(pollId);
    };
  }, [msgsOpen, shipment.id]);

  const openMessages = () => {
    setMsgsOpen(true);
    localStorage.setItem(`msg_read_${shipment.id}`, new Date().toISOString());
    setUnreadCount(0);
  };

  const loadEdiMessagesRef = useRef(null);
  const loadEdiMessages = () =>
    api.ediMessages.list(shipment.id).then(setEdiMessages).catch(() => {});
  loadEdiMessagesRef.current = loadEdiMessages;

  useEffect(() => { loadEdiMessages(); }, [shipment.id]);

  useEffect(() => {
    if (!ediOpen) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsHost = import.meta.env.DEV ? "localhost:3001" : window.location.host;
    const ws = new WebSocket(`${proto}//${wsHost}/ws`);
    let pollId;

    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", shipmentId: shipment.id }));
    ws.onmessage = e => {
      try {
        const frame = JSON.parse(e.data);
        if (frame.type === "new_edi_message") {
          setEdiMessages(prev => prev.some(m => m.id === frame.message.id) ? prev : [frame.message, ...prev]);
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => { pollId = setInterval(() => loadEdiMessagesRef.current?.(), 10_000); };
    ws.onclose = () => { if (pollId) clearInterval(pollId); };

    return () => {
      ws.close();
      if (pollId) clearInterval(pollId);
    };
  }, [ediOpen, shipment.id]);

  const handleSendBookingRequest = async () => {
    try {
      await api.ediMessages.sendBookingRequest(shipment.id);
      await loadEdiMessages();
      toast.success("Booking request sent");
    } catch (e) { toast.error(e.message || "Failed to send booking request"); }
  };
  const carrier  = carriers.find(c => c.code === shipment.carrierCode);
  const ctrs     = containers.filter(c => c.shipmentId === shipment.id);
  const totalTEU = ctrs.reduce((s, c) => s + teuOf(c.size), 0);

  useEffect(() => {
    if (!shipment.contractId) { setDgPolicy(null); return; }
    api.contracts.get(shipment.contractId)
      .then(c => setDgPolicy({ dgAllowed: c.dgAllowed, imdgClasses: c.imdgClasses || [] }))
      .catch(() => setDgPolicy(null));
  }, [shipment.contractId]);

  // Silent pending-contract revalidation: when a Pending shipment has a contractRef,
  // check on every load whether a matching Active Central contract now exists.
  useEffect(() => {
    if (shipment.contractType !== "Pending" || !shipment.contractRef) { setPendingMatches(null); return; }
    api.contracts.revalidate(shipment.contractRef)
      .then(matches => setPendingMatches(matches.length > 0 ? matches : null))
      .catch(() => {});
  }, [shipment.id, shipment.contractType, shipment.contractRef]);

  const ctrDgConflict = c => {
    if (!c.isDg || !c.dgClass || !dgPolicy) return null;
    if (!dgPolicy.dgAllowed) return `Contract does not permit DG cargo`;
    if (dgPolicy.imdgClasses.length > 0 && !dgPolicy.imdgClasses.includes(c.dgClass))
      return `IMO class ${c.dgClass} not permitted by contract (allowed: ${dgPolicy.imdgClasses.join(", ")})`;
    return null;
  };

  const dgConflicts = ctrs.filter(c => ctrDgConflict(c)).length;

  const allocContractMatch = (s, a) => {
    if (a.contractId)     return s.contractId === a.contractId;
    if (a.contractNumber) return s.contractRef === a.contractNumber;
    return s.contractType === "Central";
  };
  const todayStr = new Date().toISOString().slice(0, 10);
  const linkedAlloc = allocations.find(a =>
    a.carrierCode === shipment.carrierCode &&
    a.effectiveDate <= todayStr && a.endDate >= todayStr &&
    allocContractMatch(shipment, a) &&
    (!a.pol || a.pol === shipment.pol) &&
    (!a.pod || a.pod === shipment.pod)
  ) || null;

  const InfoCard = ({ label, value, color, mono }) => (
    <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px" }}>
      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: mono ? T.mono : T.body, fontSize: 16, fontWeight: 700,
        color: color || T.text, wordBreak: "break-word" }}>{value}</div>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div id="shp-overview" style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
        <Btn variant="secondary" onClick={onBack}>← Back</Btn>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1
              title="Click to copy shipment ID"
              onClick={() => navigator.clipboard.writeText(shipment.id).then(() => toast.success(`Copied ${shipment.id}`))}
              style={{ fontFamily: T.head, fontSize: 24, fontWeight: 800, color: T.text, margin: 0,
                cursor: "pointer", userSelect: "none" }}>
              {shipment.id}
            </h1>
            <Badge variant={statusVariant(shipment.status)} size={12}>{shipment.status}</Badge>
            <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700,
              background: "rgb(30,115,190)", color: "#fff",
              borderRadius: 4, padding: "2px 9px", letterSpacing: ".06em" }}>FCL</span>
            {/* Milestone progress chip */}
            {milestoneProg?.total > 0 && (
              <span onClick={() => onManageMilestones ? onManageMilestones() : null}
                title={`${milestoneProg.done} of ${milestoneProg.total} milestones complete`}
                style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, cursor: "pointer",
                  borderRadius: 4, padding: "2px 9px", letterSpacing: ".06em", whiteSpace: "nowrap",
                  border: milestoneProg.done === milestoneProg.total
                    ? `1px solid ${T.success}55`
                    : `1px solid ${T.border}`,
                  background: milestoneProg.done === milestoneProg.total
                    ? T.success + "20"
                    : T.surface,
                  color: milestoneProg.done === milestoneProg.total ? T.success : T.textMuted,
                }}>
                {milestoneProg.done === milestoneProg.total ? "✓ " : ""}⚑ {milestoneProg.done}/{milestoneProg.total}
              </span>
            )}
            {/* Space badge */}
            {spaceBadge === "exceeded" && (
              <span title="Shipment TEU exceeds remaining space on the linked allocation — no overage reason on record"
                style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
                  borderRadius: 4, padding: "2px 9px", letterSpacing: ".06em",
                  border: `1px solid ${T.danger}55`, background: T.danger + "20", color: T.danger }}>
                ⚠ Space exceeded
              </span>
            )}
            {spaceBadge === "warning" && (
              <span title="Shipment TEU exceeds allocation space — overage reason on file"
                style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
                  borderRadius: 4, padding: "2px 9px", letterSpacing: ".06em",
                  border: `1px solid ${T.warning}55`, background: T.warning + "20", color: T.warning }}>
                ⚠ Space warning
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 3 }}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted }}>
              {shipment.polName || shipment.pol} → {shipment.podName || shipment.pod} · created {shipment.createdAt}
            </span>
            {shipment.tradeLane && (
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.text,
                background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4,
                padding: "1px 8px", letterSpacing: ".04em", whiteSpace: "nowrap" }}>
                {shipment.tradeLane}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={openMessages}
          title={unreadCount > 0 ? `${unreadCount} unread message${unreadCount > 1 ? "s" : ""}` : "Shipment messages"}
          style={{ position: "relative", background: "none", border: `1px solid ${T.border}`,
            borderRadius: 8, cursor: "pointer", padding: "7px 12px", fontSize: 18, lineHeight: 1,
            transition: "border-color .15s" }}
          onMouseEnter={e => e.currentTarget.style.borderColor = T.accent}
          onMouseLeave={e => e.currentTarget.style.borderColor = T.border}>
          {unreadCount > 0 ? "📩" : "✉️"}
          {unreadCount > 0 && (
            <span style={{ position: "absolute", top: -5, right: -5,
              background: T.danger, color: "#fff", borderRadius: "50%",
              width: 17, height: 17, display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: T.mono, fontSize: 9, fontWeight: 700, lineHeight: 1 }}>
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setEdiOpen(true)}
          title="EDI messages"
          style={{ position: "relative", background: "none", border: `1px solid ${T.border}`,
            borderRadius: 8, cursor: "pointer", padding: "7px 12px", fontSize: 18, lineHeight: 1,
            transition: "border-color .15s" }}
          onMouseEnter={e => e.currentTarget.style.borderColor = T.accent}
          onMouseLeave={e => e.currentTarget.style.borderColor = T.border}>
          📡
        </button>
        <DocumentsMenu shipment={shipment} containers={containers} />
        <Btn variant="secondary" disabled={shareLoading} onClick={async () => {
          setShareLoading(true);
          try {
            const r = await api.shipments.shareToken(shipment.id);
            setShareUrl(r.url);
          } catch { toast.error("Failed to generate tracking link"); }
          finally { setShareLoading(false); }
        }}>🔗 Share</Btn>
        {onRefresh && <RefreshBtn shipmentId={shipment.id} onRefresh={onRefresh} />}
        {canEdit && <Btn variant="secondary" onClick={() => onEdit?.()}>✎ Edit Shipment</Btn>}
      </div>

      {!canEdit && (
        <div style={{
          display: "flex", alignItems: "center", gap: 9, padding: "9px 16px",
          borderRadius: 8, background: T.info + "15", border: `1px solid ${T.info}44`,
          fontFamily: T.body, fontSize: 12, color: T.info, marginBottom: 16,
        }}>
          <span style={{ fontSize: 14 }}>👁</span>
          <strong>View Only</strong> — your account has read-only access. Contact an admin to request edit permissions.
        </div>
      )}

      {/* Info cards row 1 */}
      <div id="shp-info-ports" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 14 }}>
        <InfoCard label="Port of Loading"
          value={shipment.polName ? `${shipment.pol} — ${shipment.polName}` : shipment.pol}
          color={T.textCode} mono />
        <InfoCard label="Port of Discharge"
          value={shipment.podName ? `${shipment.pod} — ${shipment.podName}` : shipment.pod}
          color={T.textCode} mono />
        <InfoCard label="Carrier" value={`${shipment.carrierCode}${carrier ? ` · ${carrier.name}` : ""}`} color={T.accent} mono />
        <InfoCard label="Total TEU" value={`${totalTEU} TEU`} mono />
      </div>

      {/* Info cards row 2 */}
      <div id="shp-info-dates" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 22 }}>
        {/* ETD with GMT */}
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px" }}>
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>ETD</div>
          <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: T.text }}>
            {shipment.etd || "—"}
          </div>
          {shipment.etd && (
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, marginTop: 3 }}>
              {new Date(shipment.etd + "T00:00:00Z").toLocaleDateString("en-GB",
                { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" })} · GMT
            </div>
          )}
        </div>
        {/* ETA with GMT */}
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px" }}>
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>ETA</div>
          <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: T.text }}>
            {shipment.eta || "—"}
          </div>
          {shipment.eta && (
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, marginTop: 3 }}>
              {new Date(shipment.eta + "T00:00:00Z").toLocaleDateString("en-GB",
                { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" })} · GMT
            </div>
          )}
        </div>
        {/* Vessel card with Link action */}
        <div style={{ background: T.bg, border: `1px solid ${(!shipment.vessel && !shipment.vesselImo) ? T.warning + "88" : T.border}`,
          borderRadius: 10, padding: "14px 18px", position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: ".08em" }}>Vessel</div>
            {canEdit && (
              <button type="button" onClick={() => setLinkVesselOpen(true)}
                style={{ fontFamily: T.body, fontSize: 10.5, color: T.accent, background: "none",
                  border: "none", cursor: "pointer", padding: 0, fontWeight: 600 }}>
                {shipment.vessel || shipment.vesselImo ? "✎ Change" : "＋ Link Vessel"}
              </button>
            )}
          </div>
          {shipment.vessel || shipment.vesselImo ? (
            <>
              <div style={{ fontFamily: T.body, fontSize: 15, fontWeight: 700, color: T.text }}>
                {shipment.vessel || "—"}
              </div>
              {shipment.vesselImo && (
                <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                  IMO {shipment.vesselImo}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.warning, fontStyle: "italic" }}>
              Not assigned
            </div>
          )}
        </div>

        <InfoCard label="Voyage/Loop" value={shipment.voyage || "—"} mono />
      </div>

      {/* Linked space configuration */}
      {allocations.length > 0 && (linkedAlloc ? (() => {
        const allocTEU  = linkedAlloc.allocatedTEU || 0;
        const thresh    = linkedAlloc.alertThreshold ?? 80;
        const shipTEU   = totalTEU;
        const pct       = allocTEU > 0 ? Math.min(100, (shipTEU / allocTEU) * 100) : 0;
        const barColor  = pct >= 100 ? T.danger : pct >= thresh ? T.warning : T.success;
        return (
          <div id="shp-space" style={{ background: T.surface, border: `1px solid ${T.accent}44`,
            borderLeft: `3px solid ${T.accent}`, borderRadius: 10,
            padding: "14px 20px", marginBottom: 22,
            display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 5 }}>Space Configuration</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.accent }}>
                  {linkedAlloc.carrierCode}
                </span>
                {linkedAlloc.pol && linkedAlloc.pod && (
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
                    {linkedAlloc.pol} <span style={{ color: T.border }}>›</span> {linkedAlloc.pod}
                  </span>
                )}
                {linkedAlloc.contractNumber && (
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, fontWeight: 600,
                    background: T.accentBg, borderRadius: 4, padding: "1px 7px" }}>
                    {linkedAlloc.contractNumber}
                  </span>
                )}
              </div>
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
              {linkedAlloc.effectiveDate} → {linkedAlloc.endDate}
            </div>
            <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", gap: 4, minWidth: 140 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                  This shipment: {shipTEU} / {allocTEU} TEU
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: barColor, fontWeight: 600 }}>
                  {pct.toFixed(0)}%
                </span>
              </div>
              <div style={{ background: T.border, borderRadius: 4, height: 5, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: barColor, transition: "width .4s" }} />
              </div>
            </div>
          </div>
        );
      })() : (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic",
          marginBottom: 14 }}>
          No active space configuration matches this shipment.
        </div>
      ))}

      {/* Parties & Offices */}
      <div id="shp-parties" style={{ marginBottom: 22 }}>
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          {shipment.shipperName || shipment.consigneeName ? "Parties on file — " : "No parties on file yet — "}
          <button type="button" onClick={() => onManagePartiesOffices ? onManagePartiesOffices() : null}
            style={{ background: "none", border: "none", color: T.accent, cursor: "pointer",
              fontFamily: T.body, fontSize: 12, padding: 0, textDecoration: "underline" }}>
            View Parties &amp; Offices →
          </button>
        </div>
      </div>

      {/* Contract & References  ·  Cargo Details — side by side */}
      <div id="shp-cargo" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12, alignItems: "stretch" }}>

      {/* Contract & References compact card */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 18px", borderBottom: `1px solid ${T.border}33`, flexShrink: 0 }}>
          <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
            Contract &amp; References
          </span>
        </div>
        <div style={{ flex: 1 }}>
          {[
            { label: "Contract Type", node: (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Badge variant={contractVariant(shipment.contractType)}>{shipment.contractType}</Badge>
                  {shipment.contractRef && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{shipment.contractRef}</span>}
                </div>
              ) },
            { label: "Incoterm", node: shipment.incoterm
                ? <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, fontWeight: 700 }}>
                    {shipment.incoterm}
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontWeight: 400, marginLeft: 6 }}>
                      {INCOTERMS_2020.find(t => t.code === shipment.incoterm)?.name || ""}
                    </span>
                  </span>
                : <span style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>—</span> },
            { label: "Booking Ref", node: <span style={{ fontFamily: T.mono, fontSize: 12, color: shipment.bookingRef ? T.textCode : T.border }}>{shipment.bookingRef || "—"}</span> },
            { label: "B/L Number",  node: <span style={{ fontFamily: T.mono, fontSize: 12, color: shipment.blNumber  ? T.textCode : T.border }}>{shipment.blNumber  || "—"}</span> },
          ].map(({ label, node }, i, arr) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 18px",
              borderBottom: i < arr.length - 1 ? `1px solid ${T.border}22` : "none" }}>
              <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: ".06em", width: 96, flexShrink: 0 }}>
                {label}
              </span>
              {node}
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setContractOpen(true)}
          style={{ display: "block", width: "100%", padding: "10px 18px", textAlign: "center",
            fontFamily: T.body, fontSize: 12, color: T.textMuted, background: T.bg, flexShrink: 0,
            border: "none", borderTop: `1px solid ${T.border}22`, cursor: "pointer" }}
          onMouseEnter={e => e.currentTarget.style.color = T.accent}
          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
          Show all details →
        </button>
      </div>

      {/* Cargo Details compact card */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 18px", borderBottom: `1px solid ${T.border}33`, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>Cargo Details</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
              background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "1px 7px" }}>
              {ctrs.length}
            </span>
            {totalTEU > 0 && (
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>· {totalTEU} TEU</span>
            )}
            {dgConflicts > 0 && (
              <span title={`${dgConflicts} container${dgConflicts !== 1 ? "s" : ""} with DG class not permitted by contract`}
                style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.warning,
                  background: T.warning + "18", border: `1px solid ${T.warning}55`,
                  borderRadius: 6, padding: "1px 8px", cursor: "default" }}>
                ⚠ {dgConflicts} DG conflict{dgConflicts !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <button type="button" onClick={() => setCtrModal("add")}
            style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
              border: `1px solid ${T.accent}55`, borderRadius: 7, padding: "4px 11px", cursor: "pointer" }}>
            + Add
          </button>
        </div>
        <div style={{ flex: 1 }}>
          {ctrs.length === 0 ? (
            <div style={{ padding: "20px 18px", fontFamily: T.body, fontSize: 12,
              color: T.textMuted, fontStyle: "italic" }}>No containers yet.</div>
          ) : ctrs.slice(0, 3).map((c, i) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px",
              borderBottom: i < Math.min(ctrs.length, 3) - 1 ? `1px solid ${T.border}22` : "none" }}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, fontWeight: 600,
                width: 128, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.containerNumber || "—"}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text, flexShrink: 0, width: 32 }}>
                {c.size}ft
              </span>
              <div style={{ flexShrink: 0 }}><Badge>{c.type}</Badge></div>
              {c.isDg && c.dgClass && (
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: "#fff",
                  background: T.danger, borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>
                  IMO {c.dgClass}
                </span>
              )}
              {ctrDgConflict(c) && (
                <span title={ctrDgConflict(c)}
                  style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.warning,
                    background: T.warning + "18", border: `1px solid ${T.warning}55`,
                    borderRadius: 4, padding: "1px 6px", flexShrink: 0, cursor: "default" }}>
                  ⚠ DG conflict
                </span>
              )}
              <span style={{ fontFamily: T.body, fontSize: 12, flex: 1,
                color: c.cargoDescription ? T.textMuted : T.border,
                fontStyle: c.cargoDescription ? "normal" : "italic",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.cargoDescription || "No description"}
              </span>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => onManageContainers ? onManageContainers() : setCtrListOpen(true)}
          style={{ display: "block", width: "100%", padding: "10px 18px", textAlign: "center",
            fontFamily: T.body, fontSize: 12, color: T.textMuted, background: T.bg, flexShrink: 0,
            border: "none", borderTop: `1px solid ${T.border}22`, cursor: "pointer" }}
          onMouseEnter={e => e.currentTarget.style.color = T.accent}
          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
          {ctrs.length > 3
            ? `${ctrs.length - 3} more container${ctrs.length - 3 !== 1 ? "s" : ""} — Show all →`
            : ctrs.length > 0 ? "Manage containers →" : "Open containers →"}
        </button>
      </div>

      </div>{/* end 1fr 1fr grid */}

      <div id="shp-services" style={{ marginBottom: 20 }}>
        <ServicesPanel shipment={shipment} />
      </div>

      <div style={{ maxWidth: 560 }}>
        <CompactHistory events={events} onShowAll={() => setHistoryOpen(true)} />
      </div>
      {historyOpen && <HistoryModal events={events} shipmentId={shipment.id} onClose={() => setHistoryOpen(false)} />}

      {/* Accounting — promoted to dedicated sub-pages (Invoice Entry / Cost Entry / GP Overview) */}
      <div id="shp-accounting" style={{ marginTop: 20, fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
        Cost &amp; revenue lines —{" "}
        <button type="button" onClick={() => onManageAccountingInvoices ? onManageAccountingInvoices() : null}
          style={{ background: "none", border: "none", color: T.accent, cursor: "pointer",
            fontFamily: T.body, fontSize: 12, padding: 0, textDecoration: "underline" }}>
          View Invoice Entry →
        </button>
        {" · "}
        <button type="button" onClick={() => onManageAccountingCosts ? onManageAccountingCosts() : null}
          style={{ background: "none", border: "none", color: T.accent, cursor: "pointer",
            fontFamily: T.body, fontSize: 12, padding: 0, textDecoration: "underline" }}>
          View Cost Entry →
        </button>
        {" · "}
        <button type="button" onClick={() => onManageAccountingGp ? onManageAccountingGp() : null}
          style={{ background: "none", border: "none", color: T.accent, cursor: "pointer",
            fontFamily: T.body, fontSize: 12, padding: 0, textDecoration: "underline" }}>
          View GP Overview →
        </button>
      </div>

      {/* Schedules, Milestones, Tickets — promoted to dedicated sub-pages */}
      <div id="shp-schedules" style={{ marginTop: 20, fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
        Carrier schedule —{" "}
        <button type="button" onClick={() => onManageSchedules ? onManageSchedules() : null}
          style={{ background: "none", border: "none", color: T.accent, cursor: "pointer",
            fontFamily: T.body, fontSize: 12, padding: 0, textDecoration: "underline" }}>
          View Schedules →
        </button>
      </div>

      <div id="shp-milestones" style={{ marginTop: 12, fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
        {milestoneProg?.total > 0 ? `${milestoneProg.done}/${milestoneProg.total} milestones complete — ` : "No milestones on file yet — "}
        <button type="button" onClick={() => onManageMilestones ? onManageMilestones() : null}
          style={{ background: "none", border: "none", color: T.accent, cursor: "pointer",
            fontFamily: T.body, fontSize: 12, padding: 0, textDecoration: "underline" }}>
          View Milestones →
        </button>
      </div>

      <div id="shp-tickets" style={{ marginTop: 12, fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
        Related tickets —{" "}
        <button type="button" onClick={() => onManageTickets ? onManageTickets() : null}
          style={{ background: "none", border: "none", color: T.accent, cursor: "pointer",
            fontFamily: T.body, fontSize: 12, padding: 0, textDecoration: "underline" }}>
          View Tickets →
        </button>
      </div>

      {/* Modals */}

      {/* Pending contract revalidation */}
      {pendingMatches && canEdit && (
        <PendingRevalidationModal
          matches={pendingMatches}
          contractRef={shipment.contractRef}
          onAccept={async contract => {
            try {
              await onUpdate(shipment.id, {
                ...shipment,
                contractType: "Central",
                contractId:   contract.id,
                contractRef:  contract.contractNumber,
              });
            } finally {
              setPendingMatches(null);
            }
          }}
          onDismiss={() => setPendingMatches(null)}
        />
      )}

      {/* Contract & References — full details */}
      {contractOpen && (
        <Modal title="Contract &amp; References" onClose={() => setContractOpen(false)} width={520}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {[
              { label: "Contract Type", node: (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Badge variant={contractVariant(shipment.contractType)}>{shipment.contractType}</Badge>
                    {shipment.contractRef && <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{shipment.contractRef}</span>}
                  </div>
                ) },
              { label: "Contract ID", node: <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.contractId ? T.textCode : T.border }}>{shipment.contractId || "—"}</span> },
              { label: "Incoterm", node: shipment.incoterm
                  ? <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textCode, fontWeight: 700 }}>
                      {shipment.incoterm}
                      <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontWeight: 400, marginLeft: 8 }}>
                        {INCOTERMS_2020.find(t => t.code === shipment.incoterm)?.name || ""}
                      </span>
                    </span>
                  : <span style={{ fontFamily: T.body, fontSize: 13, color: T.border }}>—</span> },
              { label: "Booking Ref", node: <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.bookingRef ? T.textCode : T.border }}>{shipment.bookingRef || "—"}</span> },
              { label: "B/L Number",  node: <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.blNumber  ? T.textCode : T.border }}>{shipment.blNumber  || "—"}</span> },
            ].map(({ label, node }, i, arr) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 16, padding: "11px 0",
                borderBottom: i < arr.length - 1 ? `1px solid ${T.border}22` : "none" }}>
                <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: ".06em", width: 110, flexShrink: 0 }}>
                  {label}
                </span>
                {node}
              </div>
            ))}
            {shipment.commodityCode && (
              <div style={{ paddingTop: 14, marginTop: 2, borderTop: `1px solid ${T.border}22` }}>
                <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Commodity</div>
                <CommodityDisplay code={shipment.commodityCode} />
              </div>
            )}
            {shipment.declaredValue != null && (
              <div style={{ paddingTop: 14, marginTop: 2, borderTop: `1px solid ${T.border}22` }}>
                <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Declared Value</div>
                <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>
                  {(shipment.declaredValueCurrency || "USD")}{" "}
                  {Number(shipment.declaredValue).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}
            {shipment.contractNotes && (
              <div style={{ paddingTop: 14, marginTop: 2, borderTop: `1px solid ${T.border}22` }}>
                <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>Notes</div>
                <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.6, margin: 0 }}>
                  {shipment.contractNotes}
                </p>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Containers — full list for selection / edit / delete */}
      {ctrListOpen && (
        <Modal title={`Containers — ${shipment.id}`} onClose={() => setCtrListOpen(false)} width={820}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                  {ctrs.length} container{ctrs.length !== 1 ? "s" : ""} · {totalTEU} TEU total
                </span>
                {dgConflicts > 0 && (
                  <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.warning,
                    background: T.warning + "18", border: `1px solid ${T.warning}55`,
                    borderRadius: 6, padding: "2px 8px" }}>
                    ⚠ {dgConflicts} DG conflict{dgConflicts !== 1 ? "s" : ""} — review required
                  </span>
                )}
              </div>
              {canEdit && <Btn onClick={() => { setCtrListOpen(false); setCtrFromList(true); setCtrModal("add"); }}>＋ Add Container</Btn>}
            </div>
            {ctrs.length === 0 ? (
              <div style={{ padding: 32, textAlign: "center", fontFamily: T.body,
                fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
                No containers yet.
              </div>
            ) : (
              <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
                {/* Header */}
                {(() => {
                  const thStyle = { fontFamily: T.body, fontSize: 10, fontWeight: 700,
                    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em" };
                  return (
                    <div style={{ display: "flex", alignItems: "center", padding: "7px 14px",
                      borderBottom: `1px solid ${T.border}`, background: T.bg }}>
                      <div style={{ ...thStyle, width: 140, flexShrink: 0 }}>Container No.</div>
                      <div style={{ ...thStyle, width: 104, flexShrink: 0 }}>Size / Type</div>
                      <div style={{ ...thStyle, width: 44,  flexShrink: 0 }}>TEU</div>
                      <div style={{ ...thStyle, width: 84,  flexShrink: 0 }}>HS Code</div>
                      <div style={{ ...thStyle, flex: 1 }}>Cargo Description</div>
                      <div style={{ ...thStyle, width: 88,  flexShrink: 0 }}>Wt / Vol</div>
                      <div style={{ ...thStyle, width: 64,  flexShrink: 0 }}>DG</div>
                      <div style={{ ...thStyle, width: canEdit ? 132 : 60, flexShrink: 0 }} />
                    </div>
                  );
                })()}
                {/* Rows */}
                {ctrs.map(c => (
                  <div key={c.id} style={{ display: "flex", alignItems: "center", padding: "10px 14px",
                    borderBottom: `1px solid ${T.border}22` }}
                    onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, fontWeight: 600,
                      width: 140, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.containerNumber || "—"}
                    </span>
                    <div style={{ width: 104, flexShrink: 0, display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>{c.size}ft</span>
                      <Badge>{c.type}</Badge>
                    </div>
                    <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text,
                      width: 44, flexShrink: 0 }}>{teuOf(c.size)}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: c.hsCode ? T.textCode : T.border,
                      width: 84, flexShrink: 0 }}>{c.hsCode || "—"}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: T.body, fontSize: 12,
                        color: c.cargoDescription ? T.text : T.border,
                        fontStyle: c.cargoDescription ? "normal" : "italic",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.cargoDescription || "—"}
                      </div>
                    </div>
                    <div style={{ width: 88, flexShrink: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                      {c.grossWeightKg != null && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{c.grossWeightKg.toLocaleString()} kg</span>}
                      {c.volumeCbm    != null && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{c.volumeCbm} m³</span>}
                      {c.grossWeightKg == null && c.volumeCbm == null && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>}
                    </div>
                    <div style={{ width: 64, flexShrink: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                      {c.isDg && c.dgClass
                        ? <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                            color: "#fff", background: T.danger, borderRadius: 4, padding: "2px 7px" }}>
                            IMO {c.dgClass}
                          </span>
                        : <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>}
                      {ctrDgConflict(c) && (
                        <span title={ctrDgConflict(c)}
                          style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, color: T.warning,
                            background: T.warning + "18", border: `1px solid ${T.warning}55`,
                            borderRadius: 4, padding: "1px 5px", cursor: "default", whiteSpace: "nowrap" }}>
                          ⚠ conflict
                        </span>
                      )}
                    </div>
                    <div style={{ width: canEdit ? 132 : 60, flexShrink: 0, display: "flex", gap: 5 }}>
                      <Btn size="sm" variant="secondary" onClick={() => setEventsCtr(c)}>📋</Btn>
                      {canEdit && (
                        <>
                          <Btn size="sm" variant="secondary"
                            onClick={() => { setCtrListOpen(false); setCtrFromList(true); setCtrModal(c); }}>Edit</Btn>
                          <Btn size="sm" variant="danger"
                            onClick={() => setConfirmCtr(c.id)}>✕</Btn>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {ctrModal && (
        <Modal title={ctrModal === "add" ? "Add Container" : "Edit Container"} onClose={closeCtrModal}>
          <ContainerForm init={ctrModal === "add" ? {} : ctrModal}
            dgPolicy={dgPolicy}
            onDirtyChange={setIsDirty}
            onSave={async form => {
              try {
                ctrModal === "add"
                  ? await onAddContainer(shipment.id, form)
                  : await onEditContainer(ctrModal.id, form);
                setIsDirty(false);
                api.shipmentEvents.list(shipment.id).then(setEvents).catch(() => {});
                closeCtrModal();
              } catch { /* error already toasted by App.jsx handler */ }
            }}
            onCancel={closeCtrModal} />
        </Modal>
      )}

      {eventsCtr && (
        <Modal title={`Lifecycle Events — ${eventsCtr.containerNumber || eventsCtr.id}`}
          onClose={() => setEventsCtr(null)} width={480}>
          <ContainerEventsPanel containerId={eventsCtr.id} containerNumber={eventsCtr.containerNumber} />
        </Modal>
      )}

      {/* Link Vessel modal */}
      {linkVesselOpen && (
        <LinkVesselModal
          shipment={shipment}
          onSave={async (vesselImo, vesselName, voyage) => {
            await onUpdate(shipment.id, {
              ...shipment,
              vesselImo, vessel: vesselName, voyage,
            });
            setLinkVesselOpen(false);
          }}
          onClose={() => setLinkVesselOpen(false)}
        />
      )}
      {confirmCtr && (
        <ConfirmModal
          message="Remove this container from the shipment?"
          onConfirm={() => { onDeleteContainer(confirmCtr); setConfirmCtr(null); }}
          onCancel={() => setConfirmCtr(null)} />
      )}

      {/* Share link modal */}
      {shareUrl && (
        <Modal title="🔗 Customer Tracking Link" onClose={() => setShareUrl(null)} style={{ maxWidth: 520 }}>
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

      {/* ── Messages drawer ── */}
      {msgsOpen && <MessagesDrawer
        shipment={shipment}
        messages={messages}
        onPost={async (body) => {
          loadMessages();
        }}
        onClose={() => setMsgsOpen(false)}
      />}

      {/* ── EDI messages drawer ── */}
      {ediOpen && <EdiMessagesDrawer
        shipment={shipment}
        messages={ediMessages}
        onSend={handleSendBookingRequest}
        onClose={() => setEdiOpen(false)}
      />}

    </div>
  );
};

export default ShipmentDetailPage;