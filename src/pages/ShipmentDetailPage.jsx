import React, { useState, useEffect, useRef } from "react";
import { T, INCOTERMS_2020, teuOf,
         statusVariant, contractVariant, IMDG_CLASSES } from "../tokens";
import { ContainerTypeField } from "../components/shared/ContainerTypePickerModal";
import { ShipmentForm } from "./ShipmentsPage";
import { VesselField } from "../components/shared/VesselCombobox";
import { CommodityCombobox, GradePill } from "../components/shared/CommodityCombobox";
import { api } from "../api";
import { toast } from "../toast";
import Btn from "../components/primitives/Btn";
import Spinner from "../components/primitives/Spinner";
import Badge from "../components/primitives/Badge";
import {Inp, Sel, BtnToggle} from "../components/primitives/Form";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import DatePicker from "../components/primitives/DatePicker";
import { useResizableColumns, ColResizer } from "../components/primitives/useResizableColumns.jsx";


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

const ContainerForm = ({ init = {}, onSave, onCancel, onDirtyChange }) => {
  const initSnap = useRef({
    containerNumber:  init.containerNumber  || "",
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

  const [touched,  setTouched]  = useState({});
  const [isSaving, setIsSaving] = useState(false);

  // Notify parent when form diverges from its initial values
  useEffect(() => {
    const s = initSnap.current;
    const dirty = f.containerNumber !== s.containerNumber || f.size !== s.size ||
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
  const valid    = f.containerNumber.length >= 4 && f.size && f.type
                 && hsOk && descOk && weightOk && volumeOk && (!f.isDg || f.dgClass);

  const FieldErr = ({ show, msg }) => show
    ? <div style={{ fontFamily: T.body, fontSize: 11, color: T.danger, marginTop: 3 }}>{msg}</div>
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* ① Container Identity */}
      <SectionHeader n="①" title="Container Identity" />

      <Inp label="Container Number" value={f.containerNumber}
        onChange={v => set("containerNumber")(v.toUpperCase().replace(/\s/g, ""))}
        placeholder="MAEU1234567" mono required
        hint="ISO 6346 container ID" />

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
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn
          disabled={!valid || isSaving}
          onClick={async () => {
            setTouched({ weight: true, volume: true, hsCode: true, desc: true });
            if (!valid) return;
            setIsSaving(true);
            try {
              await onSave({
                containerNumber: f.containerNumber, size: f.size, type: f.type,
                hsCode: f.hsCode, cargoDescription: f.cargoDescription,
                grossWeightKg: f.grossWeightKg ? parseFloat(f.grossWeightKg) : null,
                volumeCbm:     f.volumeCbm     ? parseFloat(f.volumeCbm)     : null,
                isDg: f.isDg, dgClass: f.dgClass,
              });
            } finally { setIsSaving(false); }
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
  const [saving,  setSaving]  = React.useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(vessel?.imo || "", vessel?.name || "", voyage);
    } finally { setSaving(false); }
  };

  return (
    <Modal title="Link Vessel" onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <VesselField
          vessel={vessel}
          onSelect={setVessel}
        />
        <Inp label="Voyage" value={voyage} onChange={setVoyage}
          placeholder="e.g. 0123W" mono
          hint="Voyage number for this sailing" />
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
  SHIPMENT_CREATED:  { icon: "🚢",  label: "Shipment created",  color: () => T.success  },
  STATUS_CHANGED:    { icon: "🔄", label: "Status changed",    color: () => T.accent   },
  FIELD_UPDATED:     { icon: "✏️",  label: "Field updated",     color: () => T.info     },
  CONTAINER_ADDED:   { icon: "➕",  label: "Container added",   color: () => T.success  },
  CONTAINER_REMOVED: { icon: "➖",  label: "Container removed", color: () => T.danger   },
  CONTAINER_UPDATED: { icon: "📦",  label: "Container updated", color: () => T.warning  },
};

const FIELD_LABELS = {
  pol: "Port of Loading", pod: "Port of Discharge", status: "Status",
  etd: "Estimated Departure", eta: "Estimated Arrival", carrier_code: "Carrier",
  vessel: "Vessel", vessel_imo: "Vessel IMO", voyage: "Voyage", incoterm: "Incoterm",
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
        {summary && (
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

const ShipmentTimeline = ({ events, currentStatus, open, onToggle }) => (
  <div style={{ background: T.surface, borderRadius: 12,
    border: `1px solid ${T.border}`, overflow: "hidden" }}>
    <button type="button" onClick={onToggle}
      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "14px 20px", background: "none", border: "none",
        cursor: "pointer", textAlign: "left" }}>
      <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
        {open ? "▾" : "▸"} Shipment History
      </span>
      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
        background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
        padding: "1px 8px" }}>
        {events.length} event{events.length !== 1 ? "s" : ""}
      </span>
    </button>

    {open && (
      <div style={{ padding: "0 20px 20px" }}>
        {events.length === 0 ? (
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted,
            fontStyle: "italic", margin: 0 }}>
            No history yet. Changes to this shipment will appear here automatically.
          </p>
        ) : (
          <div style={{ position: "relative" }}>
            {/* Vertical line */}
            <div style={{ position: "absolute", left: 15, top: 0, bottom: 0,
              width: 1, background: T.border }} />
            <div style={{ display: "flex", flexDirection: "column" }}>
              {events.map(ev => <EventRow key={ev.id} ev={ev} />)}
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
                    Current status: {currentStatus}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    )}
  </div>
);

// ─── Messages drawer ─────────────────────────────────────────────────────────

const MessagesDrawer = ({ shipmentId, messages, onPost, onClose }) => {
  const [body,    setBody]    = useState("");
  const [posting, setPosting] = useState(false);
  const [sortAsc, setSortAsc] = useState(true);
  const listRef = useRef(null);

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
    try { await onPost(body); setBody(""); } finally { setPosting(false); }
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div>
            <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
              💬 Messages
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginTop: 2 }}>
              {shipmentId} · {sorted.length} message{sorted.length !== 1 ? "s" : ""}
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

// ─── Compliance Modal ─────────────────────────────────────────────────────────

const RESULT_STYLE = {
  HIT:    { color: "#ef4444", bg: "#ef444415", border: "#ef444444" },
  CLEAR:  { color: "#22c55e", bg: "#22c55e15", border: "#22c55e44" },
  OVERRIDE: { color: "#f59e0b", bg: "#f59e0b15", border: "#f59e0b44" },
};

const ComplianceModal = ({ shipment, screening, onChange, onClose }) => {
  const [busy,           setBusy]           = useState(false);
  const [syncing,        setSyncing]        = useState(false);
  const [overrideOpen,   setOverrideOpen]   = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const effectiveResult = screening?.result === "CLEAR" && screening?.overriddenAt ? "OVERRIDE" : screening?.result;
  const rs = RESULT_STYLE[effectiveResult] || RESULT_STYLE.CLEAR;

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

        {/* Hit list */}
        {screening?.hits?.length > 0 && (
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: ".07em", color: T.textMuted, marginBottom: 8 }}>
              {screening.hits.length} match{screening.hits.length !== 1 ? "es" : ""}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {screening.hits.map((h, i) => (
                <div key={i} style={{ padding: "10px 12px", background: T.bg,
                  border: `1px solid ${T.danger}33`, borderLeft: `3px solid ${T.danger}`, borderRadius: 6 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 5 }}>
                    <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.danger,
                      background: T.danger + "18", borderRadius: 3, padding: "1px 6px" }}>
                      {h.field}
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>
                      {h.value}
                    </span>
                  </div>
                  <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
                    Matched: <span style={{ color: T.text, fontWeight: 600 }}>{h.matchedEntry}</span>
                    {h.program && <> · <span style={{ color: "#f59e0b" }}>{h.program}</span></>}
                    {h.source && <> · <span style={{ fontSize: 11 }}>{h.source}</span></>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

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

const ShipmentDetailPage = ({ shipment, containers, carriers, onBack, onUpdate, onAddContainer, onEditContainer, onDeleteContainer }) => {
  const [ctrModal,       setCtrModal]       = useState(null);
  const [linkVesselOpen, setLinkVesselOpen] = useState(false);
  const [editShp,        setEditShp]        = useState(false);
  const [confirmCtr,     setConfirmCtr]     = useState(null);
  const [statusLog,      setStatusLog]      = useState([]);
  const [logOpen,        setLogOpen]        = useState(true);
  const [events,         setEvents]         = useState([]);
  const [allocations,    setAllocations]    = useState([]);
  const [isDirty,        setIsDirty]        = useState(false);
  const [msgsOpen,       setMsgsOpen]       = useState(false);
  const [messages,       setMessages]       = useState([]);
  const [unreadCount,    setUnreadCount]    = useState(0);
  const [screening,      setScreening]      = useState(null);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const { template: ctrTemplate, startResize: ctrStartResize } = useResizableColumns("shipment-containers", [140,60,90,50,80,150,100,90,120]);
  const ctrHeaders = ["Container No.","Size","Type","TEU","HS Code","Cargo Description","Wt / Vol","DG","Actions"];

  // Tab title — show shipment ID so multi-tab workflows are easy to navigate
  useEffect(() => {
    document.title = `${shipment.id} · CargoDesk`;
    return () => { document.title = "CargoDesk"; };
  }, [shipment.id]);

  // Load latest screening result on mount
  useEffect(() => {
    api.screening.get(shipment.id).then(s => setScreening(s)).catch(() => {});
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

  useEffect(() => {
    if (!msgsOpen) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
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
  const carrier  = carriers.find(c => c.code === shipment.carrierCode);
  const ctrs     = containers.filter(c => c.shipmentId === shipment.id);
  const totalTEU = ctrs.reduce((s, c) => s + teuOf(c.size), 0);

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
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
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
            {/* Compliance badge */}
            {(() => {
              const r        = screening?.result;
              const isHit    = r === "HIT";
              const overridden = screening?.overriddenAt;
              const bg    = !r ? T.border + "33" : isHit ? "#ef444420" : "#22c55e20";
              const color = !r ? T.textMuted    : isHit ? "#ef4444"   : "#22c55e";
              const label = !r ? "UNSCREENED" : isHit ? "⚠ Compliance review required" : overridden ? "✓ CLEAR*" : "✓ CLEAR";
              const hitLines = isHit && screening?.hits?.length
                ? screening.hits.map(h => `${h.field}: ${h.value}`).join("\n")
                : null;
              const tooltipText = !r ? "Run compliance screening"
                : isHit ? `Sanctioned party detected:\n${hitLines}\n\nClick to review`
                : overridden ? "Cleared via manual override"
                : "Compliance clear";
              return (
                <button onClick={() => setComplianceOpen(true)}
                  title={tooltipText}
                  style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, cursor: "pointer",
                    borderRadius: 4, padding: "2px 9px", letterSpacing: ".06em",
                    border: `1px solid ${!r ? T.border : isHit ? "#ef444444" : "#22c55e44"}`,
                    background: bg, color, transition: "opacity .15s",
                    whiteSpace: "nowrap" }}>
                  {label}
                </button>
              );
            })()}
          </div>
          <p style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted, margin: "3px 0 0" }}>
{shipment.polName || shipment.pol} → {shipment.podName || shipment.pod} · created {shipment.createdAt}
          </p>
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
        <Btn variant="secondary" onClick={() => setEditShp(true)}>✎ Edit Shipment</Btn>
      </div>

      {/* Info cards row 1 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 14 }}>
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 22 }}>
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
            <button type="button" onClick={() => setLinkVesselOpen(true)}
              style={{ fontFamily: T.body, fontSize: 10.5, color: T.accent, background: "none",
                border: "none", cursor: "pointer", padding: 0, fontWeight: 600 }}>
              {shipment.vessel || shipment.vesselImo ? "✎ Change" : "＋ Link Vessel"}
            </button>
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

        <InfoCard label="Voyage" value={shipment.voyage || "—"} mono />
      </div>

      {/* Linked space configuration */}
      {allocations.length > 0 && (linkedAlloc ? (() => {
        const allocTEU  = linkedAlloc.allocatedTEU || 0;
        const thresh    = linkedAlloc.alertThreshold ?? 80;
        const shipTEU   = totalTEU;
        const pct       = allocTEU > 0 ? Math.min(100, (shipTEU / allocTEU) * 100) : 0;
        const barColor  = pct >= 100 ? T.danger : pct >= thresh ? T.warning : T.success;
        return (
          <div style={{ background: T.surface, border: `1px solid ${T.accent}44`,
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

      {/* Contract + references */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "16px 20px", marginBottom: 22 }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 12 }}>Contract &amp; References</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 14 }}>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Contract Type</div>
            <Badge variant={contractVariant(shipment.contractType)}>{shipment.contractType}</Badge>
            {shipment.contractRef && (
              <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textMuted, marginTop: 4 }}>{shipment.contractRef}</div>
            )}
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Contract ID</div>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.contractId ? T.textCode : T.border }}>{shipment.contractId || "—"}</span>
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Incoterm</div>
            {shipment.incoterm
              ? <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textCode, fontWeight: 700 }}>
                  {shipment.incoterm}
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontWeight: 400, marginLeft: 6 }}>
                    {INCOTERMS_2020.find(t => t.code === shipment.incoterm)?.name || ""}
                  </span>
                </span>
              : <span style={{ fontFamily: T.body, fontSize: 13, color: T.border }}>—</span>
            }
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Booking Ref</div>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.bookingRef ? T.textCode : T.border }}>{shipment.bookingRef || "—"}</span>
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>B/L Number</div>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.blNumber ? T.textCode : T.border }}>{shipment.blNumber || "—"}</span>
          </div>
        </div>
        {shipment.commodityCode && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}22` }}>
            <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>Commodity</div>
            <CommodityDisplay code={shipment.commodityCode} />
          </div>
        )}
        {shipment.contractNotes && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}33` }}>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Notes</div>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.6 }}>{shipment.contractNotes}</span>
          </div>
        )}
      </div>

      {/* Shipment History */}
      <ShipmentTimeline
        events={events}
        currentStatus={shipment.status}
        open={logOpen}
        onToggle={() => setLogOpen(o => !o)}
      />

      {/* Cargo Details */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", marginTop: 12 }}>
        <div style={{ padding: "15px 20px", borderBottom: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 style={{ fontFamily: T.head, fontSize: 17, fontWeight: 700, color: T.text, margin: 0 }}>Cargo Details</h2>
            <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "2px 0 0" }}>
              {ctrs.length} container{ctrs.length !== 1 ? "s" : ""} · {totalTEU} TEU total
            </p>
          </div>
          <Btn onClick={() => setCtrModal("add")}>＋ Add Container</Btn>
        </div>

        {ctrs.length === 0 ? (
          <div style={{ padding: 36, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No containers yet. Add one above.
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: ctrTemplate,
              padding: "9px 20px", borderBottom: `1px solid ${T.border}` }}>
              {ctrHeaders.map((h, i) => (
                <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
                  {h}{i < ctrHeaders.length - 1 && <ColResizer onStart={e => ctrStartResize(i, e)} />}
                </div>
              ))}
            </div>
            {ctrs.map(c => (
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: ctrTemplate,
                padding: "12px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}
                onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, fontWeight: 600 }}>{c.containerNumber || "—"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{c.size}ft</span>
                <Badge>{c.type}</Badge>
                <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.text }}>{teuOf(c.size)}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: c.hsCode ? T.textCode : T.border }}>
                  {c.hsCode || "—"}
                </span>
                <span style={{ fontFamily: T.body, fontSize: 12, color: c.cargoDescription ? T.text : T.border,
                  fontStyle: c.cargoDescription ? "normal" : "italic",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.cargoDescription || "—"}
                </span>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {c.grossWeightKg != null && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{c.grossWeightKg.toLocaleString()} kg</span>}
                  {c.volumeCbm    != null && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{c.volumeCbm} m³</span>}
                  {c.grossWeightKg == null && c.volumeCbm == null && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>}
                </div>
                <div>
                  {c.isDg && c.dgClass ? (
                    <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                      color: "#fff", background: T.danger, borderRadius: 5, padding: "2px 8px",
                      border: `1px solid ${T.danger}` }}>
                      IMO {c.dgClass}
                    </span>
                  ) : (
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn size="sm" variant="secondary" onClick={() => setCtrModal(c)}>Edit</Btn>
                  <Btn size="sm" variant="danger"    onClick={() => setConfirmCtr(c.id)}>✕</Btn>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Modals */}
      {ctrModal && (
        <Modal title={ctrModal === "add" ? "Add Container" : "Edit Container"} onClose={() => setCtrModal(null)}>
          <ContainerForm init={ctrModal === "add" ? {} : ctrModal}
            onDirtyChange={setIsDirty}
            onSave={async form => {
              try {
                ctrModal === "add"
                  ? await onAddContainer(shipment.id, form)
                  : await onEditContainer(ctrModal.id, form);
                setIsDirty(false);
                setCtrModal(null);
              api.shipmentEvents.list(shipment.id).then(setEvents).catch(() => {});
              } catch { /* error already toasted by App.jsx handler */ }
            }}
            onCancel={() => setCtrModal(null)} />
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
      {editShp && (
        <Modal title="Edit Shipment" onClose={() => setEditShp(false)} width={560}>
          <ShipmentForm init={shipment}
            onSave={async form => {
              const res = await onUpdate(shipment.id, form);
              if (res?.screening) setScreening(res.screening);
              setEditShp(false);
            }}
            onCancel={() => setEditShp(false)} />
        </Modal>
      )}
      {confirmCtr && (
        <ConfirmModal
          message="Remove this container from the shipment?"
          onConfirm={() => { onDeleteContainer(confirmCtr); setConfirmCtr(null); }}
          onCancel={() => setConfirmCtr(null)} />
      )}

      {/* ── Messages drawer ── */}
      {msgsOpen && <MessagesDrawer
        shipmentId={shipment.id}
        messages={messages}
        onPost={async (body) => {
          await api.shipmentMessages.post(shipment.id, { body, author: "Alex Mitroiu", role: "Freight Manager" });
          loadMessages();
        }}
        onClose={() => setMsgsOpen(false)}
      />}

      {complianceOpen && (
        <ComplianceModal
          shipment={shipment}
          screening={screening}
          onChange={s => setScreening(s)}
          onClose={() => setComplianceOpen(false)}
        />
      )}
    </div>
  );
};

export default ShipmentDetailPage;