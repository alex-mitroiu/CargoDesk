import { useState, useEffect } from "react";
import { T, todayIso } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import { Modal, ConfirmModal } from "../primitives/Modal";
import DatePicker from "../primitives/DatePicker";
import { Inp, Sel, Textarea } from "../primitives/Form";
import CustomerCombobox from "./CustomerCombobox";
import Spinner from "../primitives/Spinner";
import { SERVICE_TYPES } from "../../shipmentServicePages";
import { emitServicesChanged } from "../../servicesBus";
import { IconClose } from "../primitives/Icon";

// ─── Dedicated Services panel (TKT-9DGDNP) ─────────────────────────────────
// Ancillary services (VGM, Haulage, Fumigation, Storage, Customs, ...) ordered
// independently per Export/Import side, each with its own vendor, office, and
// Requested → Confirmed → Completed (or Cancelled) lifecycle. Deliberately
// independent of shipment_legs — a leg tracks physical routing, a service
// tracks who's ordering an ancillary activity and its status. Embedded
// directly on the Overview page as a dashboard (not a promoted sub-page).
//
// SERVICE_TYPES now lives in shipmentServicePages.js — shared with the dedicated
// per-service nav/routing pattern (Epic TKT-TBS7QD), which needs the same catalog.
// "Loading/Unloading" was split into separate "Loading"/"Unloading" entries there
// (TKT-6292VK) so each can get its own dedicated page and be ordered/tracked
// independently; existing rows saved with the old combined label are free text
// and simply keep displaying it — no data migration needed.

const STATUS_COLOR = { Requested: T.warning, Confirmed: T.info, Completed: T.success, Cancelled: T.textMuted };
const NEXT_STATUS   = { Requested: "Confirmed", Confirmed: "Completed" };
const NEXT_LABEL     = { Requested: "Confirm", Confirmed: "Complete" };

const StatusPill = ({ status }) => (
  <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: "0.03em",
    padding: "2px 8px", borderRadius: 4, textTransform: "uppercase",
    background: STATUS_COLOR[status] + "22", color: STATUS_COLOR[status],
    border: `1px solid ${STATUS_COLOR[status]}55` }}>
    {status}
  </span>
);

const ServiceForm = ({ side, offices, shipment, onSave, onCancel }) => {
  const dept = side === "Export" ? "SE" : "SI";
  const defaultOfficeId = (side === "Export" ? shipment.emoOfficeId : shipment.imoOfficeId) || "";
  const candidates = offices.filter(o => o.department === dept && o.isActive);

  const [serviceType, setServiceType] = useState(SERVICE_TYPES[0]);
  const [otherType,   setOtherType]   = useState("");
  const [vendor,       setVendor]      = useState({ id: "", name: "" });
  const [officeId,     setOfficeId]    = useState(defaultOfficeId);
  const [requestedDate, setRequestedDate] = useState(todayIso());
  const [notes,         setNotes]         = useState("");
  const [saving,        setSaving]        = useState(false);

  const resolvedType = serviceType === "Other" ? otherType.trim() : serviceType;
  const valid = !!resolvedType;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        side, serviceType: resolvedType,
        vendorId: vendor.id, vendorName: vendor.name,
        officeId, requestedDate, notes,
      });
    } finally { setSaving(false); }
  };

  return (
    <Modal title={`Request ${side} Service`} onClose={onCancel} width={480}>
      <div id="svcform" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Sel id="svcform-type" label="Service Type" value={serviceType} onChange={setServiceType} required
          options={SERVICE_TYPES.map(t => ({ value: t, label: t }))} />
        {serviceType === "Other" && (
          <Inp id="svcform-other-type" label="Specify Service" value={otherType} onChange={setOtherType} placeholder="e.g. Inspection" required />
        )}
        <CustomerCombobox label="Vendor" value={vendor} onChange={setVendor} />
        <Sel id="svcform-office" label={`Office (${side === "Export" ? "EMO" : "IMO"})`} value={officeId} onChange={setOfficeId}
          options={[{ value: "", label: "None (optional)" },
            ...candidates.map(o => ({ value: o.id, label: `${o.code} — ${o.name}` }))]} />
        <DatePicker id="svcform-requested-date" label="Requested Date" value={requestedDate} onChange={setRequestedDate} />
        <Textarea id="svcform-notes" label="Notes" value={notes} onChange={setNotes} placeholder="Optional instructions…" />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
          <Btn id="svcform-cancel-btn" variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn id="svcform-save-btn" onClick={handleSave} disabled={!valid || saving}>
            {saving ? "Saving…" : "Request Service"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

const ServiceRow = ({ service, canEdit, onAdvance, onCancelService, onDelete }) => {
  const nextStatus = NEXT_STATUS[service.status];
  return (
    <div id={`svcpanel-row-${service.id}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: T.body, fontSize: 12.5, fontWeight: 600, color: T.text }}>
            {service.serviceType}
          </span>
          <StatusPill status={service.status} />
        </div>
        <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 2 }}>
          {service.vendorName || "No vendor set"}
          {service.officeCode ? ` · ${service.officeCode}` : ""}
          {service.requestedDate ? ` · Req. ${service.requestedDate}` : ""}
        </div>
      </div>
      {canEdit && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {nextStatus && (
            <button id={`svcpanel-row-${service.id}-advance-btn`} type="button" onClick={() => onAdvance(service, nextStatus)}
              style={{ background: "none", border: `1px solid ${T.accent}66`, color: T.accent,
                borderRadius: 5, padding: "3px 9px", fontFamily: T.body, fontSize: 11,
                fontWeight: 600, cursor: "pointer" }}>
              {NEXT_LABEL[service.status]}
            </button>
          )}
          {(service.status === "Requested" || service.status === "Confirmed") && (
            <button id={`svcpanel-row-${service.id}-cancel-btn`} type="button" onClick={() => onCancelService(service)}
              title="Cancel service"
              style={{ background: "none", border: "none", color: T.textMuted,
                cursor: "pointer", fontFamily: T.body, fontSize: 11, padding: "3px 4px" }}>
              Cancel
            </button>
          )}
          <button id={`svcpanel-row-${service.id}-delete-btn`} type="button" onClick={() => onDelete(service)}
            title="Delete service"
            style={{ background: "none", border: "none", color: T.textMuted,
              cursor: "pointer", fontSize: 13, padding: "3px 4px", lineHeight: 1 }}
            onMouseEnter={e => e.currentTarget.style.color = T.danger}
            onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
            <IconClose size={12} />
          </button>
        </div>
      )}
    </div>
  );
};

const ServiceColumn = ({ side, services, loading, canEdit, onRequest, onAdvance, onCancelService, onDelete }) => (
  <div id={`svcpanel-${side.toLowerCase()}-column`} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 14px", borderBottom: `1px solid ${T.border}` }}>
      <span style={{ fontFamily: T.head, fontSize: 14, fontWeight: 800, color: T.text }}>
        {side} Services
      </span>
      {canEdit && (
        <button id={`svcpanel-${side.toLowerCase()}-request-btn`} type="button" onClick={onRequest}
          style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
            padding: "5px 11px", cursor: "pointer", fontFamily: T.body, fontSize: 11.5, color: T.text }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.text; }}>
          + Request Service
        </button>
      )}
    </div>
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "14px 2px" }}>
          <Spinner size="sm" />
        </div>
      ) : services.length === 0 ? (
        <div id={`svcpanel-${side.toLowerCase()}-empty`} style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic", padding: "6px 2px" }}>
          No {side.toLowerCase()} services ordered yet.
        </div>
      ) : services.map(s => (
        <ServiceRow key={s.id} service={s} canEdit={canEdit}
          onAdvance={onAdvance} onCancelService={onCancelService} onDelete={onDelete} />
      ))}
    </div>
  </div>
);

const ServicesPanel = ({ shipment }) => {
  const { canEditShipments: canEdit } = useAuth();
  // null = not yet loaded (distinct from [] = loaded and genuinely empty) — without this
  // distinction the fetch's first second or two renders "No services ordered yet" even
  // when services do exist, since an empty initial array is indistinguishable from a
  // confirmed-empty one.
  const [services, setServices] = useState(null);
  const [offices,  setOffices]  = useState([]);
  const [requestSide, setRequestSide] = useState(null); // null | "Export" | "Import"
  const [confirmDelete, setConfirmDelete] = useState(null); // service pending delete

  const load = () => api.services.list(shipment.id)
    .then(list => { setServices(list); emitServicesChanged(shipment.id); })
    .catch(() => setServices([]));

  useEffect(() => {
    setServices(null);
    load();
    api.offices.list().then(setOffices).catch(() => {});
  }, [shipment.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loading = services === null;
  const exportServices = loading ? [] : services.filter(s => s.side === "Export");
  const importServices = loading ? [] : services.filter(s => s.side === "Import");

  const handleCreate = async (payload) => {
    try {
      await api.services.create(shipment.id, payload);
      toast.success(`${payload.side} service requested`);
      setRequestSide(null);
      load();
    } catch (e) { toast.error(e.message || "Failed to request service"); }
  };

  const handleAdvance = async (service, nextStatus) => {
    try {
      await api.services.update(shipment.id, service.id, { status: nextStatus });
      toast.success(`Marked ${nextStatus.toLowerCase()}`);
      load();
    } catch (e) { toast.error(e.message || "Failed to update service"); }
  };

  const handleCancelService = async (service) => {
    try {
      await api.services.update(shipment.id, service.id, { status: "Cancelled" });
      toast.success("Service cancelled");
      load();
    } catch (e) { toast.error(e.message || "Failed to cancel service"); }
  };

  const handleDelete = async () => {
    const service = confirmDelete;
    setConfirmDelete(null);
    try {
      await api.services.remove(shipment.id, service.id);
      toast.success("Service deleted");
      load();
    } catch (e) { toast.error(e.message || "Failed to delete service"); }
  };

  return (
    <div id="svcpanel">
      <div id="svcpanel-columns" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ServiceColumn side="Export" services={exportServices} loading={loading} canEdit={canEdit}
          onRequest={() => setRequestSide("Export")}
          onAdvance={handleAdvance} onCancelService={handleCancelService}
          onDelete={setConfirmDelete} />
        <ServiceColumn side="Import" services={importServices} loading={loading} canEdit={canEdit}
          onRequest={() => setRequestSide("Import")}
          onAdvance={handleAdvance} onCancelService={handleCancelService}
          onDelete={setConfirmDelete} />
      </div>

      {requestSide && (
        <ServiceForm side={requestSide} offices={offices} shipment={shipment}
          onSave={handleCreate} onCancel={() => setRequestSide(null)} />
      )}

      {confirmDelete && (
        <ConfirmModal
          message={`Delete this ${confirmDelete.serviceType} service?`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)} />
      )}
    </div>
  );
};

export default ServicesPanel;
