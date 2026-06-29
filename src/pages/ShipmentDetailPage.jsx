import React, { useState, useEffect } from "react";
import { T, INCOTERMS_2020, CONTAINER_TYPES, teuOf,
         statusVariant, contractVariant , addDays, diffDays , IMDG_CLASSES, IMDG_CLASS_VARIANT } from "../tokens";
import { ShipmentForm } from "./ShipmentsPage";
import { VesselField } from "../components/shared/VesselCombobox";
import { CommodityCombobox, GradePill } from "../components/shared/CommodityCombobox";
import { api } from "../api";
import Btn from "../components/primitives/Btn";
import Spinner from "../components/primitives/Spinner";
import Badge from "../components/primitives/Badge";
import {Inp, Sel, Field, BtnToggle} from "../components/primitives/Form";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import DatePicker from "../components/primitives/DatePicker";
import { useResizableColumns, ColResizer } from "../components/primitives/useResizableColumns";


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

const ContainerForm = ({ init = {}, onSave, onCancel }) => {
  const [f, setF] = useState({
    containerNumber:  init.containerNumber  || "",
    size:             init.size             || "40",
    type:             init.type             || "DC",
    hsCode:           init.hsCode           || "",
    cargoDescription: init.cargoDescription || "",
    grossWeightKg:    init.grossWeightKg    != null ? String(init.grossWeightKg) : "",
    volumeCbm:        init.volumeCbm        != null ? String(init.volumeCbm)     : "",
    isDg:             init.isDg             || false,
    dgClass:          init.dgClass          || "",
  });
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const typeLabel = { DC: "Dry", RF: "Reefer", OT: "Open Top", FR: "Flat Rack", TK: "Tank" };

  const [touched,  setTouched]  = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const touch = k => setTouched(p => ({ ...p, [k]: true }));

  const weightOk = parseFloat(f.grossWeightKg) > 0;
  const volumeOk = parseFloat(f.volumeCbm)    > 0;
  const hsOk     = f.hsCode.trim().length > 0;
  const descOk   = f.cargoDescription.trim().length > 0;
  const valid    = f.containerNumber.length >= 4 && hsOk && descOk
                 && weightOk && volumeOk && (!f.isDg || f.dgClass);

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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Size" required>
          <div style={{ display: "flex", gap: 8 }}>
            {["20", "40"].map(sz => (
              <BtnToggle key={sz} selected={f.size === sz} onClick={() => set("size")(sz)} wide
                sub={sz === "20" ? "1 TEU" : "2 TEU"}>
                {sz}ft
              </BtnToggle>
            ))}
          </div>
        </Field>
        <Sel label="Equipment Type" value={f.type} onChange={set("type")} required
          options={CONTAINER_TYPES.map(t => ({ value: t, label: `${t} – ${typeLabel[t] || t}` }))} />
      </div>

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
            onChange={v => { set("grossWeightKg")(v); touch("weight"); }}
            type="number" placeholder="18 000" required
            hint="Total gross weight including packaging" />
          <FieldErr show={touched.weight && !weightOk} msg="Gross weight must be greater than 0" />
        </div>
        <div>
          <Inp label="Volume (CBM)" value={f.volumeCbm}
            onChange={v => { set("volumeCbm")(v); touch("volume"); }}
            type="number" placeholder="28.5" required
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

const AllocationForm = ({ init = {}, carriers, onSave, onCancel }) => {
  const isEdit = !!init.id;
  const [carrierCode,    setCarrierCode]    = useState(init.carrierCode   || carriers[0]?.code || "");
  const [teuStr,         setTeuStr]         = useState(init.allocatedTEU  ? String(init.allocatedTEU) : "");
  const [effectiveDate,  setEffectiveDate]  = useState(init.effectiveDate || "");
  const [endDate,        setEndDate]        = useState(init.endDate       || "");
  const [serverErr,      setServerErr]      = useState("");

  useEffect(() => {
    if (!carrierCode && carriers.length > 0) setCarrierCode(carriers[0].code);
  }, [carriers]);

  const handleEffectiveChange = val => {
    setEffectiveDate(val);
    setServerErr("");
    if (endDate && val && endDate < val) setEndDate(val);
    if (endDate && val) {
      const maxEnd = addDays(val, 90);
      if (endDate > maxEnd) setEndDate(maxEnd);
    }
  };

  const teu   = parseInt(teuStr) || 0;
  const valid = carrierCode && teu > 0 && effectiveDate && endDate && endDate >= effectiveDate;

  const handleSave = async () => {
    if (!valid) return;
    try {
      await onSave({ carrierCode, allocatedTEU: teu, effectiveDate, endDate });
    } catch (e) {
      setServerErr(e.message || "Could not save — check for overlapping periods.");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Sel label="Carrier" value={carrierCode} onChange={v => { setCarrierCode(v); setServerErr(""); }} required
        options={carriers.map(c => ({ value: c.code, label: `${c.code} – ${c.name}` }))} />
      <Inp label="Allocated Space (TEU)" value={teuStr} onChange={setTeuStr}
        type="number" placeholder="100" required hint="Total TEU awarded by this carrier for the period" />

      {/* Date range — mandatory */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 12 }}>
          Effective Period <span style={{ color: T.danger }}>*</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <DatePicker
            label="Effective From"
            value={effectiveDate}
            onChange={handleEffectiveChange}
            placeholder="Start date…"
          />
          <DatePicker
            label="Effective To"
            value={endDate}
            onChange={v => { setEndDate(v); setServerErr(""); }}
            minDate={effectiveDate || undefined}
            maxDate={effectiveDate ? addDays(effectiveDate, 90) : undefined}
            placeholder="End date…"
            disabled={!effectiveDate}
          />
        </div>
        {effectiveDate && endDate && (
          <div style={{ marginTop: 8, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
            {diffDays(effectiveDate, endDate) + 1} day period
            · max 90 days per configuration
          </div>
        )}
      </div>

      {serverErr && (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.danger, background: T.dangerBg,
          border: `1px solid ${T.danger}44`, borderRadius: 6, padding: "8px 12px" }}>
          {serverErr}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Configuration"}
        </Btn>
      </div>
    </div>
  );
};

// ─── Page: Carrier Registry ───────────────────────────────────────────────────

const CarriersPage = ({ carriers, onAdd, onEdit, onDelete }) => {
  const [modal, setModal]   = useState(null); // null | "add" | carrier obj
  const [confirm, setConfirm] = useState(null);
  const { template: carrTpl3, startResize: carrResize3 } = useResizableColumns("mdm-carriers", [130,200,160]);
  const carrHdrs3 = ["Code","Name","Actions"];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Carrier Registry</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {carriers.length} carrier{carriers.length !== 1 ? "s" : ""} · reference database for shipments &amp; allocations
          </p>
        </div>
        <Btn onClick={() => setModal("add")} size="lg">＋ Add Carrier</Btn>
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: carrTpl3,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {carrHdrs3.map((h, i) => (
            <div key={i} style={{ position: "relative", fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < carrHdrs3.length - 1 && <ColResizer onStart={e => carrResize3(i, e)} />}
            </div>
          ))}
        </div>

        {carriers.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No carriers yet. Add your first carrier above.
          </div>
        ) : carriers.map(c => (
          <div key={c.code} style={{ display: "grid", gridTemplateColumns: carrTpl3,
            padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
            transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{c.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{c.name}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" variant="secondary" onClick={() => setModal(c)}>✎ Edit</Btn>
              <Btn size="sm" variant="danger"    onClick={() => setConfirm(c.code)}>✕ Remove</Btn>
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Carrier" onClose={() => setModal(null)}>
          <CarrierForm existing={carriers}
            onSave={data => { onAdd(data); setModal(null); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Carrier" onClose={() => setModal(null)}>
          <CarrierForm init={modal} existing={carriers}
            onSave={data => { onEdit(modal.code, data); setModal(null); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Remove carrier "${confirm}" from the registry? Existing shipments referencing this code will not be deleted.`}
          onConfirm={() => { onDelete(confirm); setConfirm(null); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── Page: Shipments List ─────────────────────────────────────────────────────


const ShipmentsPage = ({ shipments, containers, carriers, onSelect, onDelete, onNew }) => {
  const [confirm, setConfirm] = useState(null);
  const teuFor = id => containers.filter(c => c.shipmentId === id).reduce((s, c) => s + teuOf(c.size), 0);
  const { template: shipTpl2, startResize: shipResize2 } = useResizableColumns("shipments", [140,70,70,150,165,46,60,130,90]);
  const shipHdrs2 = ["Shipment ID","POL","POD","Carrier","Contract","TEU","Status",""];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Shipments</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {shipments.length} total · {shipments.filter(s => s.status === "Active").length} active
          </p>
        </div>
        <Btn onClick={onNew} size="lg" disabled={carriers.length === 0}>＋ New Shipment</Btn>
      </div>

      {carriers.length === 0 && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8,
          padding: "12px 18px", fontFamily: T.body, fontSize: 13, color: T.warning, marginBottom: 18 }}>
          ⚠ Carrier Registry is empty. Go to <strong>Carrier Registry</strong> and add at least one carrier before creating shipments.
        </div>
      )}

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: shipTpl2,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {shipHdrs2.map((h, i) => (
            <div key={i} style={{ position: "relative", fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < shipHdrs2.length - 1 && <ColResizer onStart={e => shipResize2(i, e)} />}
            </div>
          ))}
        </div>

        {shipments.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No shipments yet. Create your first one above.
          </div>
        ) : shipments.map(s => {
          const carrier = carriers.find(c => c.code === s.carrierCode);
          return (
            <div key={s.id} onClick={() => onSelect(s.id)}
              style={{ display: "grid", gridTemplateColumns: shipTpl2,
                padding: "14px 20px", borderBottom: `1px solid ${T.border}22`,
                cursor: "pointer", alignItems: "center", transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textCode, fontWeight: 700 }}>{s.id}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pol}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pod}</span>
              <div>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{s.carrierCode}</span>
                {carrier && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}> · {carrier.name}</span>}
              </div>
              <Badge variant={contractVariant(s.contractType)}>{s.contractType}</Badge>
              <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>{teuFor(s.id)}</span>
              <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
              <Btn size="sm" variant="danger" onClick={e => { e.stopPropagation(); setConfirm(s.id); }}>
                ✕ Remove
              </Btn>
            </div>
          );
        })}
      </div>

      {confirm && (
        <ConfirmModal
          message={`Remove shipment ${confirm} and all its containers? This cannot be undone.`}
          onConfirm={() => { onDelete(confirm); setConfirm(null); }}
          onCancel={() => setConfirm(null)} />
      )}
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
  if (ev.eventType === "CONTAINER_ADDED") {
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

const ShipmentDetailPage = ({ shipment, containers, carriers, onBack, onUpdate, onAddContainer, onEditContainer, onDeleteContainer }) => {
  const [ctrModal,      setCtrModal]      = useState(null);
  const [linkVesselOpen, setLinkVesselOpen] = useState(false);
  const [editShp,   setEditShp]   = useState(false);
  const [confirmCtr, setConfirmCtr] = useState(null);
  const [statusLog,  setStatusLog]  = useState([]);
  const [logOpen,    setLogOpen]    = useState(true);
  const [events,     setEvents]     = useState([]);
  const { template: ctrTemplate, startResize: ctrStartResize } = useResizableColumns("shipment-containers", [140,60,90,50,80,150,100,90,120]);
  const ctrHeaders = ["Container No.","Size","Type","TEU","HS Code","Cargo Description","Wt / Vol","DG","Actions"];

  useEffect(() => {
    if (!shipment?.id) return;
    api.statusLog.list(shipment.id).then(setStatusLog).catch(() => setStatusLog([]));
    api.shipmentEvents.list(shipment.id).then(setEvents).catch(() => setEvents([]));
  }, [shipment?.id, shipment?.status]);
  const carrier  = carriers.find(c => c.code === shipment.carrierCode);
  const ctrs     = containers.filter(c => c.shipmentId === shipment.id);
  const totalTEU = ctrs.reduce((s, c) => s + teuOf(c.size), 0);

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
            <h1 style={{ fontFamily: T.head, fontSize: 24, fontWeight: 800, color: T.text, margin: 0 }}>{shipment.id}</h1>
            <Badge variant={statusVariant(shipment.status)}>{shipment.status}</Badge>
          </div>
          <p style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted, margin: "3px 0 0" }}>
{shipment.polName || shipment.pol} → {shipment.podName || shipment.pod} · created {shipment.createdAt}
          </p>
        </div>
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
        <InfoCard label="ETD" value={shipment.etd || "—"} mono />
        <InfoCard label="ETA" value={shipment.eta || "—"} mono />
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

      {/* Contract + references */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "16px 20px", marginBottom: 22 }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 12 }}>Contract &amp; References</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 14 }}>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Contract Type</div>
            <Badge variant={contractVariant(shipment.contractType)}>{shipment.contractType}</Badge>
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
                <div key={i} style={{ position: "relative", fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
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
            onSave={async form => {
              try {
                ctrModal === "add"
                  ? await onAddContainer(shipment.id, form)
                  : await onEditContainer(ctrModal.id, form);
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
          <ShipmentForm init={shipment} carriers={carriers}
            onSave={form => { onUpdate(shipment.id, form); setEditShp(false); }}
            onCancel={() => setEditShp(false)} />
        </Modal>
      )}
      {confirmCtr && (
        <ConfirmModal
          message="Remove this container from the shipment?"
          onConfirm={() => { onDeleteContainer(confirmCtr); setConfirmCtr(null); }}
          onCancel={() => setConfirmCtr(null)} />
      )}
    </div>
  );
};

// ─── Page: Dashboard ──────────────────────────────────────────────────────────

export default ShipmentDetailPage;