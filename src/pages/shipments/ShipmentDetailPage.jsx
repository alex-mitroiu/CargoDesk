import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import useSaving from "../../hooks/useSaving";
import { T, INCOTERMS_2020, teuOf,
         statusVariant, contractVariant, IMDG_CLASSES,
         worstComplianceState, CUTOFF_STATE_VARIANT, COMPLIANCE_STATE_LABEL } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { ContainerTypeField } from "../../components/shared/ContainerTypePickerModal";
import { CommodityCombobox, GradePill } from "../../components/shared/CommodityCombobox";
import CustomerCombobox from "../../components/shared/CustomerCombobox";
import ServicesPanel from "../../components/shared/ServicesPanel";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import ActionMenu from "../../components/primitives/ActionMenu";
import Spinner from "../../components/primitives/Spinner";
import Badge from "../../components/primitives/Badge";
import {Inp, Sel, BtnToggle} from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import DatePicker from "../../components/primitives/DatePicker";
import SailingPickerModal from "../../components/shared/SailingPickerModal";
import ContainerEventsPanel, { CONTAINER_EVENT_TYPES } from "../../components/shared/ContainerEventsPanel";
import { AnyIcon, IconClose, IconWarning, IconPackage, IconPencil, IconCheck, IconClipboard,
  IconRefresh, IconShip, IconLock, IconUnlock, IconEye, IconArrowUp, IconArrowDown, IconForbid,
  IconLink, IconAnchor, IconFile, IconFileCertificate, IconDoor, IconFlag } from "../../components/primitives/Icon";


// ─── Section header with hover tooltip ───────────────────────────────────────

const SECTION_TIPS = {
  "①": "Container reference number, physical size (20 ft / 40 ft), and equipment type — Dry, Reefer, Open Top, Flat Rack, or Tank.",
  "②": "HS Code (Harmonized System customs tariff number) and a plain-language description of the cargo contents. Both are mandatory for booking and BL documentation.",
  "③": "Gross weight in kilograms (total including packaging and dunnage) and cargo volume in cubic metres. Required for vessel stowage planning and weight declarations.",
  "④": "IMDG (International Maritime Dangerous Goods) classification. Enable only if this container carries hazardous materials — additional documentation and placarding will be required.",
  "⑤": "Container Yard (CY) receiving cutoff, plus free-time windows before demurrage (holding the box at the terminal) or detention (holding it outside the terminal) charges start accruing. VGM declaration now lives on the dedicated VGM Export Service page. Origin free time is counted from Gate In, destination from Discharged — see the container's Lifecycle Events for actual dates. All optional; leave blank if not yet known/tracked.",
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

// forwardRef + useImperativeHandle exposes trySave() to a parent page's navigation
// guard (TKT-OJYO71, src/navigationGuard.js) — attempting away-navigation while this
// form is open and dirty auto-validates + auto-saves rather than silently discarding
// or just showing a generic "unsaved changes" warning (see ShipmentContainersPage.jsx).
export const ContainerForm = forwardRef(({ init = {}, onSave, onCancel, onDirtyChange, dgPolicy = null }, ref) => {
  const initSnap = useRef({
    containerNumber:  init.containerNumber  || "",
    sealNumber:       init.sealNumber       || "",
    size:             init.size             || "",
    type:             init.type             || "",
    hsCode:           init.hsCode           || "",
    cargoDescription: init.cargoDescription || "",
    marksAndNumbers:  init.marksAndNumbers  || "",
    grossWeightKg:    init.grossWeightKg    != null ? String(init.grossWeightKg) : "",
    volumeCbm:        init.volumeCbm        != null ? String(init.volumeCbm)     : "",
    isDg:             init.isDg             || false,
    dgClass:          init.dgClass          || "",
    cyCutoff:         init.cyCutoff         || "",
    originFreeTimeDays: init.originFreeTimeDays != null ? String(init.originFreeTimeDays) : "",
    destFreeTimeDays:   init.destFreeTimeDays   != null ? String(init.destFreeTimeDays)   : "",
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
      f.marksAndNumbers !== s.marksAndNumbers ||
      f.grossWeightKg !== s.grossWeightKg || f.volumeCbm !== s.volumeCbm ||
      f.isDg !== s.isDg || f.dgClass !== s.dgClass ||
      f.cyCutoff !== s.cyCutoff || f.originFreeTimeDays !== s.originFreeTimeDays || f.destFreeTimeDays !== s.destFreeTimeDays;
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

  const buildPayload = () => ({
    containerNumber: f.containerNumber, sealNumber: f.sealNumber, size: f.size, type: f.type,
    hsCode: f.hsCode, cargoDescription: f.cargoDescription, marksAndNumbers: f.marksAndNumbers,
    grossWeightKg: f.grossWeightKg ? parseFloat(f.grossWeightKg) : null,
    volumeCbm:     f.volumeCbm     ? parseFloat(f.volumeCbm)     : null,
    isDg: f.isDg, dgClass: f.dgClass,
    // VGM fields are no longer edited on this form (moved to the dedicated VGM Export
    // Service page) — passed through unchanged from the current container record so an
    // ordinary Cargo-page save never wipes them (PUT /api/containers/:id is a full-row
    // replace, not a merge).
    vgmWeightKg: init.vgmWeightKg ?? null, vgmStatus: init.vgmStatus || "Pending", vgmCutoff: init.vgmCutoff || "",
    cyCutoff: f.cyCutoff,
    originFreeTimeDays: f.originFreeTimeDays ? parseInt(f.originFreeTimeDays, 10) : null,
    destFreeTimeDays:   f.destFreeTimeDays   ? parseInt(f.destFreeTimeDays, 10)   : null,
  });

  // Exposed to a parent's navigation guard — touches every mandatory field (so
  // FieldErr messages surface, same as clicking Save) and reports back exactly
  // what's missing instead of silently discarding or saving partial data.
  useImperativeHandle(ref, () => ({
    trySave: async () => {
      setTouched({ weight: true, volume: true, hsCode: true, desc: true });
      if (!valid) {
        const missing = [
          !f.containerNumber || f.containerNumber.length < 4 ? "Container Number" : null,
          !f.size || !f.type ? "Container Type" : null,
          !hsOk   ? "HS Code" : null,
          !descOk ? "Cargo Description" : null,
          !weightOk ? "Gross Weight" : null,
          !volumeOk ? "Volume" : null,
          f.isDg && !f.dgClass ? "IMDG Class" : null,
          dgConflict,
        ].filter(Boolean);
        return { ok: false, error: `Container form has incomplete/invalid fields: ${missing.join(", ")}` };
      }
      await onSave(buildPayload());
      return { ok: true };
    },
  }));

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

      <Inp label="Marks & Nos." value={f.marksAndNumbers} onChange={set("marksAndNumbers")}
        placeholder="e.g. IN DIAMOND / MADE IN CHINA / NO. 1-50"
        hint="Identifying marks and numbers stenciled on the packages, as shown on the B/L or packing list" />

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
              <IconWarning size={11} style={{ marginRight: 4, position: "relative", top: 1 }} /> IMDG Classified Cargo
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
            <IconForbid size={14} style={{ flexShrink: 0 }} />
            <span>{dgConflict}</span>
          </div>
        )}
      </div>

      {/* ⑤ Cutoffs & Free Time */}
      <SectionHeader n="⑤" title="Cutoffs & Free Time" />

      <DatePicker label="CY Cutoff" value={f.cyCutoff} onChange={set("cyCutoff")}
        hint="Container yard / terminal receiving cutoff" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Origin Free Time (days)" value={f.originFreeTimeDays}
          onChange={v => { if (v === "" || /^\d*$/.test(v)) set("originFreeTimeDays")(v); }}
          type="text" inputMode="numeric" placeholder="e.g. 5"
          hint="Days allowed from Gate In before origin charges start" />
        <Inp label="Destination Free Time (days)" value={f.destFreeTimeDays}
          onChange={v => { if (v === "" || /^\d*$/.test(v)) set("destFreeTimeDays")(v); }}
          type="text" inputMode="numeric" placeholder="e.g. 5"
          hint="Days allowed from Discharged before destination charges start" />
      </div>
      <div style={{ fontFamily: T.body, fontSize: 11, color: T.border, marginTop: -4 }}>
        Counted from this container's Lifecycle Events (Gate In / Discharged) — see the 📋 button on the container list.
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn
          disabled={!valid || isSaving}
          onClick={() => {
            setTouched({ weight: true, volume: true, hsCode: true, desc: true });
            if (!valid) return;
            withSaving(() => onSave(buildPayload()));
          }}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {isSaving && <Spinner size="sm" color="currentColor" />}
            {isSaving ? "Saving…" : (init.id ? "Update Container" : "Add Container")}
          </span>
        </Btn>
      </div>
    </div>
  );
});

// ─── Page: Shipment Detail ────────────────────────────────────────────────────

// ─── Inline commodity display ─────────────────────────────────────────────────
export const CommodityDisplay = ({ code }) => {
  const [comm, setComm] = React.useState(null);
  React.useEffect(() => {
    if (!code) return;
    import("../../api").then(m => m.api.commodities.get(code).then(setComm).catch(() => setComm({ code, description: code })));
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
  Active: "🟢", Pending: "🟡", Sailed: IconShip,
  Arrived: IconAnchor, Completed: IconCheck, Cancelled: IconClose,
};

export const relTime = iso => {
  const d = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (d < 60)    return "just now";
  if (d < 3600)  return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

export const fmtDateTime = iso => new Date(iso).toLocaleString("en-GB", {
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
                      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted,
                        display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <AnyIcon icon={STATUS_ICON[entry.fromStatus] || "○"} size={11} /> {entry.fromStatus}
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.border }}>→</span>
                      <span style={{ fontFamily: T.mono, fontSize: 12,
                        color: T.accent, fontWeight: 700,
                        display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <AnyIcon icon={STATUS_ICON[entry.toStatus] || "○"} size={11} /> {entry.toStatus}
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
                    color: T.success, fontWeight: 700,
                    display: "flex", alignItems: "center", gap: 4 }}>
                    <AnyIcon icon={STATUS_ICON[currentStatus] || "○"} size={12} /> {currentStatus}
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


// ─── Shipment History Timeline ────────────────────────────────────────────────

export const EVENT_CONFIG = {
  SHIPMENT_CREATED:  { icon: IconShip,    label: "Shipment created",       color: () => T.success  },
  STATUS_CHANGED:    { icon: IconRefresh, label: "Status changed",          color: () => T.accent   },
  FIELD_UPDATED:     { icon: IconPencil,  label: "Field updated",           color: () => T.info     },
  CONTAINER_ADDED:   { icon: "➕",  label: "Container added",         color: () => T.success  },
  CONTAINER_REMOVED: { icon: "➖",  label: "Container removed",       color: () => T.danger   },
  CONTAINER_UPDATED: { icon: IconPackage, label: "Container updated",       color: () => T.warning  },
  COMPLIANCE_HIT:    { icon: IconWarning, label: "Compliance hit detected", color: () => T.danger   },
  COST_LINE_ADDED:   { icon: "＋",  label: "Cost line added",          color: () => T.success  },
  COST_LINE_UPDATED: { icon: IconPencil,  label: "Cost line updated",        color: () => T.info     },
  COST_LINE_REMOVED: { icon: IconClose,   label: "Cost line removed",        color: () => T.danger   },
};

export const FIELD_LABELS = {
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
          <span style={{ fontSize: 13, display: "inline-flex", alignItems: "center" }}><AnyIcon icon={cfg.icon} size={13} /></span>
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

export const getEventSummary = ev => {
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

// ─── Messages drawer ─────────────────────────────────────────────────────────

export const MessagesDrawer = ({ shipment, messages, onPost, onClose }) => {
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
              {sortAsc
                ? <><IconArrowUp size={11} style={{ marginRight: 4 }} />Oldest first</>
                : <><IconArrowDown size={11} style={{ marginRight: 4 }} />Newest first</>}
            </button>
            <button onClick={onClose}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
              cursor: "pointer", color: T.textMuted, fontSize: 15, padding: "4px 10px",
              lineHeight: 1, display: "inline-flex", alignItems: "center" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = T.danger; e.currentTarget.style.color = T.danger; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}>
            <IconClose size={13} />
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

  // Organization Model Enhancement Epic 3 — this was already the app's one unified compliance
  // view (reachable from every shipment sub-page via the persistent ShipmentHeaderBar), just
  // scoped to 3 of the 13 possible party-role slots. Notify Party joins the 4 fixed roles here;
  // the 9 shipment_parties roles (Forwarder, Customs Broker Export/Import, Trucker Pre/On-
  // carriage, Also Notify Party, Bank, Insurance Provider, Agent) are fetched and shown as their
  // own phase — screenShipmentById (server.js) now screens all 13, this just surfaces them.
  const [additionalParties, setAdditionalParties] = useState(null);
  useEffect(() => {
    api.shipmentParties.list(shipment.id).then(setAdditionalParties).catch(() => setAdditionalParties([]));
  }, [shipment.id]);

  // Phase-based check definitions
  const PHASES = [
    {
      id: "parties", label: "Phase 1", title: "Parties",
      checks: [
        { field: "Shipper",      label: "Shipper",      value: shipment.shipperName,   desc: null },
        { field: "Consignee",    label: "Consignee",    value: shipment.consigneeName, desc: null },
        { field: "Principal",    label: "Principal",    value: shipment.principalName, desc: null },
        { field: "Notify Party", label: "Notify Party",  value: shipment.notifyName,    desc: null },
      ],
    },
    ...(additionalParties && additionalParties.length > 0 ? [{
      id: "additional-parties", label: "Phase 1b", title: "Additional Parties",
      checks: additionalParties.map(p => ({ field: p.role, label: p.role, value: p.customerName, desc: null })),
    }] : []),
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
              color: T.textMuted, cursor: syncing ? "default" : "pointer",
              display: "inline-flex", alignItems: "center", gap: 5 }}>
            {syncing ? "Working…" : <><IconArrowUp size={12} />Import sdn.csv</>}
          </button>
          <button onClick={syncFromSource} disabled={syncing}
            style={{ fontFamily: T.body, fontSize: 12, background: "none",
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 12px",
              color: T.textMuted, cursor: syncing ? "default" : "pointer",
              display: "inline-flex", alignItems: "center", gap: 5 }}>
            {syncing ? "Working…" : <><IconRefresh size={12} />Sync from source</>}
          </button>
          <Btn onClick={runScreen} disabled={busy} style={{ marginLeft: "auto" }}>
            {busy ? "Screening…" : screening
              ? <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><IconRefresh size={12} />Re-screen</span>
              : "Run Screening"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Shipment Milestones ──────────────────────────────────────────────────────

const MILESTONE_ICONS = {
  booking_confirmed: IconClipboard,
  si_submitted:      IconFile,
  cargo_gated_in:    IconDoor,
  vessel_departed:   IconShip,
  bl_issued:         IconFileCertificate,
  vessel_arrived:    IconAnchor,
  customs_cleared:   IconCheck,
  cargo_released:    IconPackage,
  delivered:         IconFlag,
};

// ─── Parties & Offices Panel ───────────────────────────────────────────────────

const PartiesOfficesCard = ({ id, label, value }) => (
  <div id={id} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px" }}>
    <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>{label}</div>
    <div style={{ fontFamily: T.body, fontSize: 16, fontWeight: 700,
      color: value ? T.text : T.border, wordBreak: "break-word" }}>{value || "—"}</div>
  </div>
);

// Edit form — PARTIES ONLY (Shipper/Consignee/Notify/Principal). Reuses the same
// CustomerCombobox pattern as ShipmentFormPage's Parties section. Offices moved out
// to inline-editable selects directly on PartiesOfficesPanel (TKT-PNFO5O) — the
// CustomerCombobox search+pick flow benefits from a focused modal, but a plain
// department-filtered <select> doesn't need one, so the modal stays for parties only
// per explicit direction, not dropped project-wide.
const PartiesEditForm = ({ shipment, onSave, onCancel }) => {
  const [f, setF] = useState({
    shipperId:     shipment.shipperId     || "",
    shipperName:   shipment.shipperName   || "",
    consigneeId:   shipment.consigneeId   || "",
    consigneeName: shipment.consigneeName || "",
    notifyId:      shipment.notifyId      || "",
    notifyName:    shipment.notifyName    || "",
    principalId:   shipment.principalId   || "",
    principalName: shipment.principalName || "",
  });
  const [sameNotify, setSameNotify] = useState(
    !shipment.notifyId || shipment.notifyId === shipment.consigneeId
  );
  const [isSaving, withSaving] = useSaving();

  // The shipment PUT endpoint replaces the full record (not a PATCH), so every
  // other field must ride along unchanged — only the party keys differ.
  const handleSave = () => withSaving(() => onSave({
    ...shipment,
    ...f,
    notifyId:   sameNotify ? f.consigneeId   : f.notifyId,
    notifyName: sameNotify ? f.consigneeName : f.notifyName,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <CustomerCombobox label="Shipper" required roleFilter="Shipper"
          value={{ id: f.shipperId, name: f.shipperName }}
          onChange={v => setF(p => ({ ...p, shipperId: v.id, shipperName: v.name }))} />
        <CustomerCombobox label="Consignee" required roleFilter="Consignee"
          value={{ id: f.consigneeId, name: f.consigneeName }}
          onChange={v => setF(p => ({ ...p, consigneeId: v.id, consigneeName: v.name }))} />
        <CustomerCombobox label="Principal" required roleFilter="Principal"
          value={{ id: f.principalId, name: f.principalName }}
          onChange={v => setF(p => ({ ...p, principalId: v.id, principalName: v.name }))} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
          : <CustomerCombobox label="Notify Party" roleFilter="Notify Party"
              value={{ id: f.notifyId, name: f.notifyName }}
              onChange={v => setF(p => ({ ...p, notifyId: v.id, notifyName: v.name }))} />
        }
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        <Btn id="shpparties-form-cancel-btn" variant="secondary" onClick={onCancel} disabled={isSaving}>Cancel</Btn>
        <Btn id="shpparties-form-save-btn" onClick={handleSave} disabled={isSaving}>{isSaving ? "Saving…" : "Save"}</Btn>
      </div>
    </div>
  );
};

// Offices — inline select, no modal (TKT-PNFO5O). Commits immediately on change
// (same "changing it IS the save" idiom as ServicesPanel's status-advance buttons)
// rather than needing a separate dirty-state/Save affordance for a single dropdown.
const OFFICE_FIELDS = [
  { key: "emoOfficeId",         nameKey: "emoOfficeName",         codeKey: "emoOfficeCode",         label: "Export Managing Office (EMO)", required: true,  dept: "SE" },
  { key: "imoOfficeId",         nameKey: "imoOfficeName",         codeKey: "imoOfficeCode",         label: "Import Managing Office (IMO)", required: true,  dept: "SI" },
  { key: "controllingOfficeId", nameKey: "controllingOfficeName", codeKey: "controllingOfficeCode", label: "Controlling Office",           required: false, dept: null },
];

const OfficeInlineSelect = ({ id, field, shipment, offices, canEdit, onUpdate }) => {
  const [saving, setSaving] = useState(false);
  const candidates = field.dept ? offices.filter(o => o.department === field.dept && o.isActive) : offices.filter(o => o.isActive);
  const value = shipment[field.key] || "";

  const handleChange = async e => {
    const next = e.target.value;
    setSaving(true);
    try { await onUpdate(shipment.id, { ...shipment, [field.key]: next }); }
    finally { setSaving(false); }
  };

  return (
    <div id={id}>
      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 5 }}>
        {field.label}{field.required && <span style={{ color: T.danger, marginLeft: 2 }}>*</span>}
      </div>
      {canEdit ? (
        <select value={value} disabled={saving} onChange={handleChange}
          style={{ width: "100%", maxWidth: 420, padding: "7px 10px", borderRadius: 7, fontFamily: T.mono, fontSize: 12,
            color: value ? T.text : T.textMuted, border: `1px solid ${T.border}`,
            background: T.bg, outline: "none", cursor: saving ? "wait" : "pointer", boxSizing: "border-box" }}>
          <option value="">{field.required ? "Select office…" : "None (optional)"}</option>
          {candidates.map(o => <option key={o.id} value={o.id}>{o.code} — {o.name}</option>)}
        </select>
      ) : (
        <div style={{ fontFamily: T.body, fontSize: 16, fontWeight: 700,
          color: shipment[field.nameKey] ? T.text : T.border }}>
          {shipment[field.nameKey] ? `${shipment[field.nameKey]}${shipment[field.codeKey] ? ` (${shipment[field.codeKey]})` : ""}` : "—"}
        </div>
      )}
    </div>
  );
};

export const PartiesOfficesPanel = ({ shipment, onUpdate }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [editing, setEditing] = useState(false);
  // null (not []) while the offices fetch is in flight — same "empty [] is indistinguishable
  // from a real zero-office result" gap already fixed for ServicesPanel/the sidebar Export-
  // Import group. It mattered more here than usual: a slow-loading offices fetch left every
  // OfficeInlineSelect dropdown showing NO real candidates at all (just the placeholder
  // option) for however long the request took, which reads as "this shipment has no offices
  // configured" rather than "still loading" — reported directly as an office loading delay.
  const [offices, setOffices] = useState(null);
  useEffect(() => { api.offices.list().then(setOffices).catch(() => setOffices([])); }, []);

  if (offices === null) {
    return (
      <div id="shpparties-panel" style={{ display: "flex", alignItems: "center", gap: 8,
        color: T.textMuted, fontFamily: T.body, fontSize: 13, padding: "30px 0", justifyContent: "center" }}>
        <Spinner size="sm" /> Loading parties &amp; offices…
      </div>
    );
  }

  return (
    <div id="shpparties-panel">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: ".08em" }}>
          Parties
        </div>
        {canEdit && onUpdate && (
          <Btn id="shpparties-edit-btn" size="sm" variant="secondary" onClick={() => setEditing(true)}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><IconPencil size={12} />Edit</span>
          </Btn>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 18 }}>
        <PartiesOfficesCard id="shpparties-shipper"   label="Shipper"      value={shipment.shipperName} />
        <PartiesOfficesCard id="shpparties-consignee" label="Consignee"    value={shipment.consigneeName} />
        <PartiesOfficesCard id="shpparties-notify"    label="Notify Party" value={shipment.notifyName} />
        <PartiesOfficesCard id="shpparties-principal" label="Principal"    value={shipment.principalName} />
      </div>
      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
        Offices — split by Export / Import
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {OFFICE_FIELDS.map(field => (
          <OfficeInlineSelect key={field.key} id={`shpparties-${field.key}`} field={field}
            shipment={shipment} offices={offices} canEdit={canEdit && !!onUpdate} onUpdate={onUpdate} />
        ))}
      </div>

      {editing && (
        <Modal title="Edit Parties" onClose={() => setEditing(false)} width={560}>
          <PartiesEditForm
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
    <div id="shpmiles-panel" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
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
            <button id="shpmiles-reset-btn" type="button" onClick={e => { e.stopPropagation(); handleInit(true); }} disabled={initializing}
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
        <div id="shpmiles-empty" style={{ padding: "32px 18px", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            No milestones set for this shipment.
          </div>
          <Btn id="shpmiles-init-btn" onClick={() => handleInit(false)} disabled={initializing}>
            {initializing ? "Initializing…" : "⚑ Initialize Milestones"}
          </Btn>
        </div>
      ) : (
        <div id="shpmiles-steps" style={{ padding: "18px 18px 10px" }}>
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
              <div key={m.id} id={`shpmiles-step-${m.milestoneKey}`} style={{ display: "flex", gap: 14 }}>
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
                    {state === 'completed' ? <IconCheck size={13} /> : state === 'overdue' ? "!" :
                      MILESTONE_ICONS[m.milestoneKey] ? <AnyIcon icon={MILESTONE_ICONS[m.milestoneKey]} size={13} /> : m.sequenceOrder}
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
                        <Btn id={`shpmiles-step-${m.milestoneKey}-save-btn`} size="sm" onClick={() => handleSaveFields(m)} disabled={isBusy}>
                          {isBusy ? "Saving…" : "Save"}
                        </Btn>
                        <Btn id={`shpmiles-step-${m.milestoneKey}-complete-btn`} size="sm" variant="success" onClick={() => handleToggleComplete(m)} disabled={isBusy}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><IconCheck size={12} />Mark Complete</span>
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
                    <button id={`shpmiles-step-${m.milestoneKey}-undo-btn`} type="button" onClick={() => handleToggleComplete(m)} disabled={isBusy}
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

// ─── Container Events Stepper ─────────────────────────────────────────────────
// Reuses MilestonePanel's state-coloring palette and progress-bar idiom, but is a
// separate component rather than a literal reuse of MilestonePanel itself:
// container_events is per-container (a shipment with N containers has N independent
// lifecycle timelines, each potentially at a different point), unlike
// shipment_milestones' single shipment-wide linear sequence that MilestonePanel's
// "current = first incomplete row" logic assumes. Rendered once per container, in a
// compact horizontal strip rather than MilestonePanel's vertical layout, since N of
// these stack on the page. No "overdue" state — container_events has no due-date
// field to compare against (unlike shipment_milestones.estimatedDate).
const ContainerEventsStepper = ({ container }) => {
  const [events, setEvents] = useState(null);

  useEffect(() => {
    api.containers.events(container.id).then(setEvents).catch(() => setEvents([]));
  }, [container.id]);

  const stateColor = st => ({ completed: T.success, current: T.accent, upcoming: T.border }[st]);

  if (events === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.textMuted,
        fontFamily: T.body, fontSize: 12, padding: "8px 0" }}>
        <Spinner size="sm" /> Loading…
      </div>
    );
  }

  const loggedTypes = new Set(events.map(e => e.eventType));
  const firstIncompleteIdx = CONTAINER_EVENT_TYPES.findIndex(t => !loggedTypes.has(t));
  const stepState = (type, idx) => loggedTypes.has(type) ? 'completed' : idx === firstIncompleteIdx ? 'current' : 'upcoming';
  const completedCount = CONTAINER_EVENT_TYPES.filter(t => loggedTypes.has(t)).length;
  const progress = Math.round((completedCount / CONTAINER_EVENT_TYPES.length) * 100);

  return (
    <div id={`shpmiles-ctrstepper-${container.id}`} style={{ marginBottom: 18, paddingBottom: 18, borderBottom: `1px solid ${T.border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>
          {container.containerNumber || container.id}
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{completedCount}/{CONTAINER_EVENT_TYPES.length} complete</span>
      </div>
      <div style={{ height: 4, background: T.border, borderRadius: 2, overflow: "hidden", marginBottom: 12 }}>
        <div style={{ height: "100%", width: `${progress}%`, background: T.success, transition: "width .3s ease", borderRadius: 2 }} />
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        {CONTAINER_EVENT_TYPES.map((type, idx) => {
          const state = stepState(type, idx);
          const color = stateColor(state);
          return (
            <div key={type} title={type} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 0 }}>
              <div style={{
                width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
                background: state === 'upcoming' ? T.surface : color,
                border: `2px solid ${color}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: state === 'upcoming' ? T.textMuted : "#fff",
                fontSize: 10, fontWeight: 700, lineHeight: 1,
                boxShadow: state === 'current' ? `0 0 0 4px ${color}22` : "none",
              }}>
                {state === 'completed' ? <IconCheck size={11} /> : idx + 1}
              </div>
              <span style={{ fontFamily: T.body, fontSize: 9, color: T.textMuted, textAlign: "center",
                lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>
                {type}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const ContainerEventsSteppers = ({ shipment, containers }) => {
  const ctrs = containers.filter(c => c.shipmentId === shipment.id);
  if (ctrs.length === 0) return null;
  return (
    <div id="shpmiles-ctrsteppers" style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, padding: "18px 20px", marginTop: 20 }}>
      <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 800, color: T.text, marginBottom: 16 }}>
        Container Events
      </div>
      {ctrs.map(c => <ContainerEventsStepper key={c.id} container={c} />)}
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
  const [paymentIndicator, setPaymentIndicator] = useState(init.paymentIndicator || "Prepaid");
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
      <div>
        <div style={lbl}>Carrier Payment Indicator (CPI)</div>
        <select value={paymentIndicator} onChange={e => setPaymentIndicator(e.target.value)} style={inp}>
          <option value="Prepaid">Prepaid — paid at origin</option>
          <option value="Collect">Collect — paid at destination</option>
        </select>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn variant="secondary"
          onClick={() => onSaveAndMirror({ type, chargeCode, currency, amount: amtNum, exchangeRate: rateNum, vatRate: vatNum, notes, containerId, paymentIndicator })}
          disabled={!valid}
          title={`Save this line and create a mirrored ${type === "BUY" ? "SELL" : "BUY"} line with the same values`}>
          ⇄ Mirror as {type === "BUY" ? "SELL" : "BUY"}
        </Btn>
        <Btn onClick={() => onSave({ type, chargeCode, currency, amount: amtNum, exchangeRate: rateNum, vatRate: vatNum, notes, containerId, paymentIndicator })} disabled={!valid}>
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
              border: `1px solid ${T.border}`, borderRadius: 7, padding: "4px 12px", cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: 4 }}>
            <IconArrowDown size={11} />CSV
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
// TKT-83O41G status badge — accrued (default, no badge needed) is the unmarked
// state; actualized/posted get a small pill so a glance at the list shows what's
// still an estimate vs what's been reconciled against a real invoice or pushed to GL.
const COST_LINE_STATUS_STYLE = {
  actualized: { label: "Actualized", color: T.info },
  posted:     { label: "Posted",     color: T.textMuted },
};

export const CostLineRow = ({ line: l, containers = [], showActions = false, onEdit, onDelete, onActualize, onPost }) => {
  const ctr = l.containerId ? containers.find(c => c.id === l.containerId) : null;
  const ctrLabel = ctr ? (ctr.containerNumber || `(${ctr.size || ""}${ctr.type || ""})`) : null;
  // Mirror direction is derived from the line's own type, not stored separately: a
  // SELL line tagged 'mirror' was created BY mirroring a BUY line (Cost Entry), and
  // vice versa — that's the only way a mirrored line comes into existence.
  const src = l.source === "contract" && l.modifiedAt ? { label: "Contract (Modified)", color: T.warning }
    : l.source === "contract" ? { label: "Contract", color: T.info }
    : l.source === "mirror" ? { label: l.type === "SELL" ? "Mirrored ← Cost Entry" : "Mirrored ← Invoice Entry", color: T.accent }
    : l.source === "automated" ? { label: "Automated", color: T.success }
    : l.source === "reversal" ? { label: "Reversal", color: T.danger }
    : { label: "Manual", color: T.textMuted };
  return (
    <div key={l.id} id={`costline-${l.id}-row`}
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
        {l.paymentIndicator === "Collect" && (
          <span title="Carrier Payment Indicator: Collect — paid at destination"
            style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: T.warning,
            background: `${T.warning}18`, border: `1px solid ${T.warning}44`,
            borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap", flexShrink: 0 }}>
            COLLECT
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
          ? <span title="No matching rate for this container type — set manually"
              style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><IconWarning size={11} />0.00</span>
          : l.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        }
      </div>
      {/* Status (TKT-83O41G) */}
      {showActions && (
        <div style={{ width: 100, flexShrink: 0, paddingLeft: 8 }}>
          {l.status && l.status !== 'accrued' && (
            <span title={l.varianceUsd != null ? `Variance: ${l.varianceUsd > 0 ? "+" : ""}$${l.varianceUsd.toFixed(2)}` : undefined}
              style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700,
                color: COST_LINE_STATUS_STYLE[l.status].color, background: `${COST_LINE_STATUS_STYLE[l.status].color}18`,
                border: `1px solid ${COST_LINE_STATUS_STYLE[l.status].color}44`,
                borderRadius: 4, padding: "2px 7px", whiteSpace: "nowrap" }}>
              {COST_LINE_STATUS_STYLE[l.status].label}
            </span>
          )}
        </div>
      )}
      {/* Actions */}
      {showActions && (
        <div style={{ width: 36, flexShrink: 0 }}>
          <ActionMenu items={[
            ...(l.status !== 'posted' ? [
              { icon: IconPencil, label: "Edit", onClick: onEdit },
              { icon: IconClose, label: "Delete", variant: "danger", onClick: onDelete },
            ] : []),
            ...(l.status === 'accrued' && onActualize ? [{ icon: "◐", label: "Actualize", onClick: onActualize }] : []),
            ...(l.status !== 'posted' && onPost ? [{ icon: IconLock, label: "Post", onClick: onPost }] : []),
          ]} />
        </div>
      )}
    </div>
  );
};

// Shared by Cost Entry + Invoice Entry pages (TKT-83O41G) — enters the real AP/AR
// amount once an actual invoice has come in, without overwriting the original
// accrued amount/exchange_rate (kept separately so variance stays computable).
export const CostLineActualizeModal = ({ line, onSave, onClose }) => {
  const [amount, setAmount] = useState(String(line.amount));
  const [isSaving, withSaving] = useSaving();
  const parsed = parseFloat(amount);
  const valid = !isNaN(parsed) && parsed >= 0;
  return (
    <Modal title={`Actualize — ${line.chargeCode}`} onClose={onClose} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
          Accrued (estimated) amount: <strong style={{ color: T.text, fontFamily: T.mono }}>{line.currency} {line.amount.toFixed(2)}</strong>.
          Enter the real invoiced amount — the accrued estimate is kept as-is so the variance stays visible.
        </div>
        <Inp label={`Actual Amount (${line.currency})`} value={amount} onChange={setAmount} mono required />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="secondary" onClick={onClose} disabled={isSaving}>Cancel</Btn>
          <Btn disabled={!valid || isSaving}
            onClick={() => withSaving(() => onSave({ actualAmount: parsed, actualExchangeRate: line.exchangeRate }))}>
            {isSaving ? "Saving…" : "Mark Actualized"}
          </Btn>
        </div>
      </div>
    </Modal>
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

export const PendingRevalidationModal = ({ matches, contractRef, onAccept, onDismiss }) => {
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
                    padding: "2px 10px", whiteSpace: "nowrap", cursor: "default",
                    display: "inline-flex", alignItems: "center", gap: 3 }}>
                    <IconWarning size={10} />dates
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
// forceOpen: skip the header/toggle/outer-card chrome and render just the body —
// used when this panel is already inside its own container (e.g. a Modal on
// ShipmentSchedulesPage) so the "Schedule History" title/toggle isn't shown twice.
// Fetch logic and the event-card rendering below are unchanged either way.
export const ScheduleHistoryPanel = ({ shipment, forceOpen = false }) => {
  const [events,   setEvents]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [expanded, setExpanded] = useState(forceOpen);

  useEffect(() => {
    setLoading(true);
    api.schedules.events(shipment.id)
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [shipment.id]);

  const EVENT_COLOR = { SAVED: T.success, REMOVED: T.danger, UPDATED: T.warning };
  const SCHED_FIELD_LABELS = { vessel_name: "Vessel", voyage_number: "Voyage", etd: "ETD", eta: "ETA", carrier: "Carrier" };

  const body = (
    <>
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
            const isUpdate = ev.event_type === "UPDATED";
            return (
              <div key={ev.id} style={{ display: "flex", alignItems: "center", gap: 12,
                padding: "10px 14px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8 }}>
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: "0.03em",
                  padding: "2px 8px", borderRadius: 4, textTransform: "uppercase",
                  background: color + "22", color, border: `1px solid ${color}55`, flexShrink: 0 }}>
                  {ev.event_type}
                </span>
                {isUpdate ? (
                  <div style={{ flex: 1, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
                    <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.text, minWidth: 60 }}>
                      {SCHED_FIELD_LABELS[ev.field] || ev.field}
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.danger, textDecoration: "line-through" }}>
                      {ev.old_value || "—"}
                    </span>
                    <span style={{ color: T.textMuted, fontSize: 12 }}>→</span>
                    <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.success }}>
                      {ev.new_value || "—"}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, marginLeft: "auto", whiteSpace: "nowrap" }}>
                      {new Date(ev.created_at).toLocaleDateString("en-GB")}
                      {m.actor ? ` by ${m.actor}` : ""}
                    </span>
                  </div>
                ) : (
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
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  if (forceOpen) return body;

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

      {expanded && <div style={{ padding: "14px 20px" }}>{body}</div>}
    </div>
  );
};

// ─── Related Tickets Panel ────────────────────────────────────────────────────

const PRIORITY_COLOR = { High: T.danger, Medium: T.warning, Low: T.textMuted, Critical: "#f97316" };
const STATUS_DOT = { Done: T.success, "In Progress": T.accent, Ready: T.textMuted, Blocked: T.danger };

// embedded=true skips the outer card + "Related Tickets" header (used by TicketsDrawer,
// which supplies its own drawer header/title) and renders just the list body — same
// presentation-only-wrap precedent as ScheduleHistoryPanel's forceOpen prop; the fetch/
// render logic itself is untouched either way.
export const RelatedTicketsPanel = ({ shipmentId, embedded = false }) => {
  const [tickets,  setTickets]  = useState([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    api.tickets.forShipment(shipmentId)
      .then(setTickets)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [shipmentId]);

  const body = (
    <div style={{ padding: embedded ? 0 : "14px 20px" }}>
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
  );

  if (embedded) return body;

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
      {body}
    </div>
  );
};

// ─── Tickets Drawer ────────────────────────────────────────────────────────────
// Matches MessagesDrawer/EdiMessagesDrawer's exact shell (420px right panel, backdrop,
// header + context strip + scrollable body) — structural parity only, not a full 1:1
// behavioral match: no WS subscription here (no ticket_updated broadcast type exists
// today; inventing one is a separate feature, not implied by "move into a drawer").
// The list itself is RelatedTicketsPanel's existing fetch/render, unchanged, just
// embedded without its own card chrome (same wrap-only precedent as ScheduleHistoryPanel).
export const TicketsDrawer = ({ shipment, onClose }) => (
  <>
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.25)", zIndex: 1100 }} />

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
          <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
            ◩ Tickets
          </div>
          <button onClick={onClose}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
              cursor: "pointer", color: T.textMuted, fontSize: 15, padding: "4px 10px",
              lineHeight: 1, display: "inline-flex", alignItems: "center" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = T.danger; e.currentTarget.style.color = T.danger; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}>
            <IconClose size={13} />
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
            {shipment.pol} → {shipment.pod}
          </span>
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

      {/* Body — scrollable */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
        <RelatedTicketsPanel shipmentId={shipment.id} embedded />
      </div>
    </div>
  </>
);

// ──────────────────────────────────────────────────────────────────────────────

const ShipmentDetailPage = ({ shipment, containers, carriers, onBack, onUpdate, onEdit, onRefresh, onAddContainer, onEditContainer, onDeleteContainer, onManageContainers, onManagePartiesOffices, onManageSchedules, onManageMilestones, onManageTickets, onManageAccountingCosts, onManageAccountingInvoices, onManageAccountingGp, detailAction = null, onDetailActionConsumed }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [statusLog,      setStatusLog]      = useState([]);

  // Tab title — show shipment ID so multi-tab workflows are easy to navigate
  useEffect(() => {
    document.title = `${shipment.id} · CargoDesk`;
    return () => { document.title = "CargoDesk"; };
  }, [shipment.id]);

  useEffect(() => {
    if (!shipment?.id) return;
    api.statusLog.list(shipment.id).then(setStatusLog).catch(() => setStatusLog([]));
  }, [shipment?.id, shipment?.status]);

  return (
    <div>
      {/* Overview anchor — identity/route/actions now live in the persistent ShipmentHeaderBar
          (mounted once in App.jsx above this page), so there's nothing left to render here
          except the scroll target the sidebar's "Overview" link points at. */}
      <div id="shp-overview" />

      {!canEdit && (
        <div id="shpoverview-viewonly-banner" style={{
          display: "flex", alignItems: "center", gap: 9, padding: "9px 16px",
          borderRadius: 8, background: T.info + "15", border: `1px solid ${T.info}44`,
          fontFamily: T.body, fontSize: 12, color: T.info, marginBottom: 16,
        }}>
          <IconEye size={14} />
          <strong>View Only</strong> — your account has read-only access. Contact an admin to request edit permissions.
        </div>
      )}

      <div id="shp-services" style={{ marginBottom: 20 }}>
        <ServicesPanel shipment={shipment} />
      </div>

      {/* Modals */}

      {/* Containers — full list for selection / edit / delete */}
    </div>
  );
};

export default ShipmentDetailPage;
