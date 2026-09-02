import { useState, useEffect, useRef } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Inp, Sel, Field } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import ActionMenu from "../../components/primitives/ActionMenu";
import { IconPencil, IconClose } from "../../components/primitives/Icon";
import { PAGE_SIZES, renderTemplateHtml } from "../../utils/templateRenderer";

// ─── Document Template Editor ──────────────────────────────────────────────────
// Free-form canvas layout per (doc type, office?, carrier?) — BL01 pilot only (see plan). A
// template's own generation-time rendering lives in ../../utils/templateRenderer.js, shared with
// the one integration point in GenerateDocumentModal.jsx. This page is purely the authoring UI.

// Hardcoded, curated bindable-field list — mirrors the same resolved data bag
// GenerateDocumentModal.jsx already assembles before dispatchDocBuilder (shipment/shipper/
// consignee/containers/invNumber/invDate/notes). Not a dynamic schema introspection — see the
// plan's own "Explicit non-goals" for why.
const FIELD_CATALOG = [
  { group: "Shipment", fields: [
    { label: "B/L Number", path: "shipment.blNumber" },
    { label: "Booking Ref", path: "shipment.bookingRef" },
    { label: "Shipper Name", path: "shipment.shipperName" },
    { label: "Consignee Name", path: "shipment.consigneeName" },
    { label: "Notify Party", path: "shipment.notifyName" },
    { label: "Port of Loading (code)", path: "shipment.pol" },
    { label: "Port of Loading (name)", path: "shipment.polName" },
    { label: "Port of Discharge (code)", path: "shipment.pod" },
    { label: "Port of Discharge (name)", path: "shipment.podName" },
    { label: "Vessel", path: "shipment.vessel" },
    { label: "Voyage", path: "shipment.voyage" },
    { label: "Carrier Code", path: "shipment.carrierCode" },
    { label: "ETD", path: "shipment.etd" },
    { label: "ETA", path: "shipment.eta" },
    { label: "Incoterm", path: "shipment.incoterm" },
    { label: "Release Type", path: "shipment.blReleaseType" },
    { label: "Master B/L Number", path: "shipment.masterBlNumber" },
    { label: "Place of Receipt", path: "shipment.placeOfReceipt" },
    { label: "Place of Delivery", path: "shipment.placeOfDelivery" },
    { label: "Declared Value", path: "shipment.declaredValue" },
  ]},
  { group: "Shipper", fields: [
    { label: "Company Name", path: "shipper.companyName" },
    { label: "Address", path: "shipper.address1" },
    { label: "City", path: "shipper.city" },
  ]},
  { group: "Consignee", fields: [
    { label: "Company Name", path: "consignee.companyName" },
    { label: "Address", path: "consignee.address1" },
    { label: "City", path: "consignee.city" },
  ]},
  { group: "Document", fields: [
    { label: "Reference Number", path: "invNumber" },
    { label: "Date", path: "invDate" },
    { label: "Notes", path: "notes" },
  ]},
];

const CONTAINER_COLUMNS = [
  { label: "Container #", path: "containerNumber" },
  { label: "Seal #", path: "sealNumber" },
  { label: "Type", path: "type" },
  { label: "Cargo Description", path: "cargoDescription" },
  { label: "Gross Weight (kg)", path: "grossWeightKg" },
  { label: "Volume (CBM)", path: "volumeCbm" },
  { label: "HS Code", path: "hsCode" },
];

// Preview-only fixture — the editor isn't shipment-scoped, so Preview renders against
// representative fake data rather than fetching a real shipment. Keeps the editor self-contained.
const SAMPLE_DATA = {
  shipment: {
    blNumber: "BL-SAMPLE-001", bookingRef: "BKG-SAMPLE", shipperName: "Acme Exports Ltd",
    consigneeName: "Global Imports Inc", notifyName: "Global Imports Inc",
    pol: "NLRTM", polName: "Rotterdam", pod: "USNYC", podName: "New York",
    vessel: "MSC METTE", voyage: "025W", carrierCode: "MSCU", etd: "2026-09-20", eta: "2026-10-05",
    incoterm: "FOB", blReleaseType: "Original", masterBlNumber: "MBL-SAMPLE-001",
    placeOfReceipt: "Rotterdam, NL", placeOfDelivery: "New York, US", declaredValue: 50000,
  },
  shipper:   { companyName: "Acme Exports Ltd", address1: "1 Harbor Way", city: "Rotterdam" },
  consignee: { companyName: "Global Imports Inc", address1: "200 Pier Ave", city: "New York" },
  containers: [
    { containerNumber: "MSKU1234567", sealNumber: "SL001", type: "40HC", cargoDescription: "General Cargo", grossWeightKg: 18000, volumeCbm: 65, hsCode: "8471.30" },
    { containerNumber: "MSKU7654321", sealNumber: "SL002", type: "40HC", cargoDescription: "General Cargo", grossWeightKg: 17500, volumeCbm: 64, hsCode: "8471.30" },
  ],
  invNumber: "BL01-SAMPLE-001", invDate: "2026-09-15", notes: "Sample preview data",
};

const newFieldId = () => `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ─── Canvas field box (drag + resize via raw mouse tracking — this codebase's only existing
// drag-and-drop is native HTML5 DnD for LIST reordering, which doesn't apply to free pixel
// positioning; this is a different, standard, no-library technique) ────────────────────────────
const FieldBox = ({ field, selected, onSelect, onChange }) => {
  const dragRef = useRef(null);

  const startDrag = (e, mode) => {
    e.stopPropagation();
    onSelect(field.id);
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, origX: field.x, origY: field.y, origW: field.width, origH: field.height };
    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX, dy = ev.clientY - d.startY;
      if (d.mode === "move") {
        onChange(field.id, { x: Math.max(0, d.origX + dx), y: Math.max(0, d.origY + dy) });
      } else {
        onChange(field.id, { width: Math.max(20, d.origW + dx), height: Math.max(14, d.origH + dy) });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const label = field.type === "table"
    ? `Table: ${field.arrayPath}`
    : (field.source === "static" ? (field.text || "Free text") : (field.path || "Unbound"));

  return (
    <div
      onMouseDown={e => startDrag(e, "move")}
      style={{
        position: "absolute", left: field.x, top: field.y, width: field.width, height: field.height,
        border: `1.5px ${selected ? "solid" : "dashed"} ${selected ? T.accent : T.border}`,
        background: selected ? T.accent + "12" : "rgba(0,0,0,.02)",
        cursor: "move", display: "flex", alignItems: "center", padding: "0 4px",
        fontFamily: T.mono, fontSize: 10, color: selected ? T.accent : T.textMuted,
        overflow: "hidden", whiteSpace: "nowrap", userSelect: "none",
      }}
    >
      {label}
      {selected && (
        <div
          onMouseDown={e => startDrag(e, "resize")}
          style={{ position: "absolute", right: -4, bottom: -4, width: 10, height: 10,
            background: T.accent, borderRadius: 2, cursor: "nwse-resize" }}
        />
      )}
    </div>
  );
};

// ─── Inspector — properties of the currently-selected field ────────────────────────────────────
const Inspector = ({ field, onChange, onDelete }) => {
  if (!field) return (
    <div style={{ padding: 20, fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
      Select a field to edit it, or add one from the panel above.
    </div>
  );

  if (field.type === "table") {
    const addColumn = () => onChange(field.id, { columns: [...field.columns, { label: "New Column", path: CONTAINER_COLUMNS[0].path }] });
    const updateColumn = (i, patch) => onChange(field.id, { columns: field.columns.map((c, ix) => ix === i ? { ...c, ...patch } : c) });
    const removeColumn = (i) => onChange(field.id, { columns: field.columns.filter((_, ix) => ix !== i) });
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
        <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em" }}>Table Region</div>
        <Field label="Bound to" hint="Repeats one row per item in this array">
          <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>containers</div>
        </Field>
        <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted }}>Columns</div>
        {field.columns.map((c, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input value={c.label} onChange={e => updateColumn(i, { label: e.target.value })}
              style={{ flex: 1, fontFamily: T.body, fontSize: 12, padding: "5px 7px", border: `1px solid ${T.border}`, borderRadius: 5, background: T.surface, color: T.text }} />
            <select value={c.path} onChange={e => updateColumn(i, { path: e.target.value })}
              style={{ flex: 1, fontFamily: T.body, fontSize: 12, padding: "5px 7px", border: `1px solid ${T.border}`, borderRadius: 5, background: T.surface, color: T.text }}>
              {CONTAINER_COLUMNS.map(cc => <option key={cc.path} value={cc.path}>{cc.label}</option>)}
            </select>
            <button onClick={() => removeColumn(i)} style={{ background: "none", border: "none", color: T.danger, cursor: "pointer", fontSize: 14 }}>✕</button>
          </div>
        ))}
        <Btn variant="secondary" size="sm" onClick={addColumn}>+ Add Column</Btn>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <Inp label="Font Size" type="number" value={String(field.fontSize || 11)} onChange={v => onChange(field.id, { fontSize: Number(v) || 11 })} />
        </div>
        <Btn variant="danger" size="sm" onClick={() => onDelete(field.id)}>Delete Table</Btn>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
      <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em" }}>Field</div>
      <Sel label="Source" value={field.source} onChange={v => onChange(field.id, { source: v, ...(v === "static" ? { path: "" } : { text: "" }) })}
        options={[{ value: "field", label: "Shipment Value" }, { value: "static", label: "Free Text" }]} />
      {field.source === "field" ? (
        <Field label="Bound field">
          <select value={field.path} onChange={e => onChange(field.id, { path: e.target.value })}
            style={{ width: "100%", fontFamily: T.body, fontSize: 12.5, padding: "7px 9px", border: `1px solid ${T.border}`, borderRadius: 6, background: T.surface, color: T.text }}>
            <option value="">— Unbound —</option>
            {FIELD_CATALOG.map(g => (
              <optgroup key={g.group} label={g.group}>
                {g.fields.map(f => <option key={f.path} value={f.path}>{f.label}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
      ) : (
        <Inp label="Text" value={field.text} onChange={v => onChange(field.id, { text: v })} placeholder="Literal text…" />
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Inp label="Font Size" type="number" value={String(field.fontSize || 12)} onChange={v => onChange(field.id, { fontSize: Number(v) || 12 })} />
        <Sel label="Align" value={field.align || "left"} onChange={v => onChange(field.id, { align: v })}
          options={[{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }]} />
      </div>
      <Sel label="Weight" value={String(field.fontWeight || 400)} onChange={v => onChange(field.id, { fontWeight: Number(v) })}
        options={[{ value: "400", label: "Normal" }, { value: "700", label: "Bold" }]} />
      <Btn variant="danger" size="sm" onClick={() => onDelete(field.id)}>Delete Field</Btn>
    </div>
  );
};

// ─── Canvas editor ───────────────────────────────────────────────────────────────────────────
const TemplateCanvasEditor = ({ template, onBack, onSaved }) => {
  const [fields, setFields] = useState(template.fields || []);
  const [selectedId, setSelectedId] = useState(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);

  const size = PAGE_SIZES[template.pageSize] || PAGE_SIZES.A4;
  const selected = fields.find(f => f.id === selectedId) || null;

  const addField = (path, label) => {
    const id = newFieldId();
    setFields(p => [...p, { id, x: 40, y: 40, width: 200, height: 22, fontSize: 12, fontWeight: 400, align: "left", type: "text", source: "field", path, text: "" }]);
    setSelectedId(id);
  };
  const addStaticField = () => {
    const id = newFieldId();
    setFields(p => [...p, { id, x: 40, y: 40, width: 160, height: 22, fontSize: 12, fontWeight: 400, align: "left", type: "text", source: "static", path: "", text: "New label" }]);
    setSelectedId(id);
  };
  const addTable = () => {
    const id = newFieldId();
    setFields(p => [...p, { id, x: 40, y: 80, width: 500, height: 120, fontSize: 11, type: "table", arrayPath: "containers", columns: [{ label: "Container #", path: "containerNumber" }, { label: "Cargo Description", path: "cargoDescription" }] }]);
    setSelectedId(id);
  };
  const updateField = (id, patch) => setFields(p => p.map(f => f.id === id ? { ...f, ...patch } : f));
  const deleteField = (id) => { setFields(p => p.filter(f => f.id !== id)); setSelectedId(null); };

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await api.documentTemplates.update(template.id, { name: template.name, pageSize: template.pageSize, fields, isActive: template.isActive });
      toast.success("Template saved");
      onSaved(saved);
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const previewHtml = preview ? renderTemplateHtml({ ...template, fields }, SAMPLE_DATA) : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Btn variant="secondary" size="sm" onClick={onBack}>← Back to Templates</Btn>
          <div style={{ fontFamily: T.head, fontSize: 18, fontWeight: 700, color: T.text }}>{template.name}</div>
          <Badge>{template.docType}</Badge>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="secondary" onClick={() => setPreview(p => !p)}>{preview ? "✎ Back to Editing" : "👁 Preview"}</Btn>
          <Btn onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save"}</Btn>
        </div>
      </div>

      {!preview && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10 }}>
          <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, alignSelf: "center", marginRight: 4 }}>Add:</span>
          {FIELD_CATALOG.map(g => (
            <select key={g.group} defaultValue="" onChange={e => { if (e.target.value) { const f = g.fields.find(x => x.path === e.target.value); addField(f.path, f.label); e.target.value = ""; } }}
              style={{ fontFamily: T.body, fontSize: 12, padding: "5px 8px", border: `1px solid ${T.border}`, borderRadius: 6, background: T.bg, color: T.text }}>
              <option value="">{g.group}…</option>
              {g.fields.map(f => <option key={f.path} value={f.path}>{f.label}</option>)}
            </select>
          ))}
          <Btn variant="secondary" size="sm" onClick={addStaticField}>+ Free Text</Btn>
          <Btn variant="secondary" size="sm" onClick={addTable}>+ Table</Btn>
        </div>
      )}

      <div style={{ display: "flex", gap: 14 }}>
        <div style={{ flex: 1, overflow: "auto", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: 20 }}>
          {preview ? (
            <iframe title="Preview" srcDoc={previewHtml} style={{ width: size.w, height: size.h, border: "none", background: "#fff", display: "block", margin: "0 auto" }} />
          ) : (
            <div onMouseDown={() => setSelectedId(null)}
              style={{ position: "relative", width: size.w, height: size.h, background: "#fff", margin: "0 auto", boxShadow: "0 2px 12px rgba(0,0,0,.15)" }}>
              {fields.map(f => (
                <FieldBox key={f.id} field={f} selected={f.id === selectedId} onSelect={setSelectedId} onChange={updateField} />
              ))}
            </div>
          )}
        </div>
        {!preview && (
          <div style={{ width: 280, flexShrink: 0, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8 }}>
            <Inspector field={selected} onChange={updateField} onDelete={deleteField} />
          </div>
        )}
      </div>
    </div>
  );
};

// ─── New Template modal ─────────────────────────────────────────────────────────────────────
const NewTemplateModal = ({ onClose, onCreated }) => {
  const [name,        setName]        = useState("");
  const [officeId,    setOfficeId]    = useState("");
  const [carrierCode, setCarrierCode] = useState("");
  const [offices,     setOffices]     = useState([]);
  const [carriers,    setCarriers]    = useState([]);
  const [saving,      setSaving]      = useState(false);

  useEffect(() => {
    api.offices.list().then(setOffices).catch(() => setOffices([]));
    api.carriers.list().then(setCarriers).catch(() => setCarriers([]));
  }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const created = await api.documentTemplates.create({
        docType: "BL01", officeId: officeId || null, carrierCode: carrierCode || null, name: name.trim(), pageSize: "A4", fields: [],
      });
      onCreated(created);
    } catch (e) { toast.error(e.message); setSaving(false); }
  };

  return (
    <Modal title="New Document Template" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Document Type" hint="More document types beyond the House B/L are coming later">
          <div style={{ fontFamily: T.mono, fontSize: 13, color: T.text, padding: "7px 0" }}>BL01 · Bill of Lading</div>
        </Field>
        <Inp label="Template Name" value={name} onChange={setName} placeholder="e.g. Rotterdam / Maersk House B/L" required />
        <Sel label="Office" value={officeId} onChange={setOfficeId} hint="Blank applies to any office"
          options={[{ value: "", label: "Any office" }, ...offices.map(o => ({ value: o.id, label: `${o.code} · ${o.name}` }))]} />
        <Sel label="Carrier" value={carrierCode} onChange={setCarrierCode} hint="Blank applies to any carrier"
          options={[{ value: "", label: "Any carrier" }, ...carriers.map(c => ({ value: c.code, label: `${c.code} · ${c.name}` }))]} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handleCreate} disabled={saving || !name.trim()}>{saving ? "Creating…" : "Create & Open Editor"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── List page ───────────────────────────────────────────────────────────────────────────────
const DocumentTemplatesPage = () => {
  const { canManageConfigs } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [showNew,   setShowNew]   = useState(false);
  const [editing,   setEditing]   = useState(null); // null | template object
  const [confirm,   setConfirm]   = useState(null);

  const load = () => {
    setLoading(true);
    return api.documentTemplates.list().then(setTemplates).catch(() => setTemplates([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleDelete = async id => {
    try {
      await api.documentTemplates.remove(id);
      toast.success("Template removed");
      setConfirm(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  if (editing) {
    return (
      <TemplateCanvasEditor
        template={editing}
        onBack={() => { setEditing(null); load(); }}
        onSaved={updated => setEditing(updated)}
      />
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Document Templates</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {templates.length} template{templates.length !== 1 ? "s" : ""} · custom layouts per office/carrier, House B/L only for now
          </p>
        </div>
        {canManageConfigs && <Btn onClick={() => setShowNew(true)} size="lg">＋ New Template</Btn>}
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 200px 160px 90px 90px", padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Type", "Name", "Office", "Carrier", "Status", "Actions"].map((h, i) => (
            <div key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>Loading…</div>
        ) : templates.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No templates yet. Every House B/L renders through the built-in layout until you add one.
          </div>
        ) : templates.map(t => (
          <div key={t.id} style={{ display: "grid", gridTemplateColumns: "90px 1fr 200px 160px 90px 90px",
            padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
            <Badge>{t.docType}</Badge>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{t.name}</span>
            <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>{t.officeId ? `${t.officeCode} · ${t.officeName}` : "Any office"}</span>
            <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.textMuted }}>{t.carrierCode || "Any carrier"}</span>
            <Badge variant={t.isActive ? "success" : "default"}>{t.isActive ? "Active" : "Inactive"}</Badge>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...(canManageConfigs ? [{ icon: IconPencil, label: "Edit", onClick: () => setEditing(t) }] : []),
                ...(canManageConfigs ? [{ icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(t) }] : []),
              ]} />
            </div>
          </div>
        ))}
      </div>

      {showNew && (
        <NewTemplateModal
          onClose={() => setShowNew(false)}
          onCreated={created => { setShowNew(false); setEditing(created); load(); }}
        />
      )}
      {confirm && (
        <ConfirmModal
          message={`Delete template "${confirm.name}"? Documents will fall back to the built-in layout.`}
          onConfirm={() => handleDelete(confirm.id)}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default DocumentTemplatesPage;
