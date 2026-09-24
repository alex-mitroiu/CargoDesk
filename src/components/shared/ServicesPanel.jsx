import { useState, useEffect } from "react";
import { todayIso } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import { Modal, ConfirmModal } from "../primitives/Modal";
import DatePicker from "../primitives/DatePicker";
import { Inp, Sel, Textarea } from "../primitives/Form";
import CustomerCombobox from "./CustomerCombobox";
import Spinner from "../primitives/Spinner";
import { serviceTypesForSide } from "../../shipmentServicePages";
import { emitServicesChanged } from "../../servicesBus";
import { findRoutingLeg } from "../../utils/carrierBooking";
import { IconClose, IconPencil } from "../primitives/Icon";
import { canEditShipmentSide } from "../../utils/officeSide";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY, useHorizonFonts } from "../../pages/shipments/shipmentDetailTheme";

// ─── Dedicated Services panel (TKT-9DGDNP) ─────────────────────────────────
// Ancillary services (VGM, Pickup, Fumigation, Storage, Customs, ...) ordered
// independently per Export/Import side, each with its own vendor, office, and
// Requested → Confirmed → Completed (or Cancelled) lifecycle. Deliberately
// independent of shipment_legs — a leg tracks physical routing, a service
// tracks who's ordering an ancillary activity and its status. Embedded
// directly on the Overview page as a dashboard (not a promoted sub-page) —
// its only real consumer, so on Trade Horizon (HZ) tokens now too, same
// Export=cyan/Import=violet column convention as Parties & Offices'
// Involved Offices cards (approved mockup:
// https://claude.ai/artifact/25ygL745mmMfvYWBXZWoAE established the pattern,
// this is its extension to the rest of the shipment detail experience).
//
// SERVICE_TYPES now lives in shipmentServicePages.js — shared with the dedicated
// per-service nav/routing pattern (Epic TKT-TBS7QD), which needs the same catalog.
// "Loading/Unloading" was split into separate "Loading"/"Unloading" entries there
// (TKT-6292VK) so each can get its own dedicated page and be ordered/tracked
// independently; existing rows saved with the old combined label are free text
// and simply keep displaying it — no data migration needed.

// A function, not a plain object — HZ is a live-mutated object (App.jsx's theme toggle calls
// applyHzTheme in place, no reload), so a plain object built from HZ.* at module load would
// freeze whichever theme was active at import and never follow a later toggle.
const statusColor = status => ({ Requested: HZ.warn, Confirmed: HZ.info, Completed: HZ.good, Cancelled: HZ.textMuted }[status]);
const NEXT_STATUS   = { Requested: "Confirmed", Confirmed: "Completed" };
const NEXT_LABEL     = { Requested: "Confirm", Confirmed: "Complete" };

const StatusPill = ({ status }) => (
  <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: "0.03em",
    padding: "2px 8px", borderRadius: 4, textTransform: "uppercase",
    background: statusColor(status) + "22", color: statusColor(status) }}>
    {status}
  </span>
);

const ServiceForm = ({ side, offices, shipment, init = null, onSave, onCancel }) => {
  // init present = editing an already-requested service (fixing/adding vendor, office,
  // date, or notes after the fact — there was previously no way to do this once a service
  // existed: only Confirm/Cancel/Delete, direct user report). init absent = the original
  // "Request Service" create flow, unchanged.
  const isEdit = !!init;
  const dept = side === "Export" ? "SE" : "SI";
  const defaultOfficeId = (side === "Export" ? shipment.emoOfficeId : shipment.imoOfficeId) || "";
  const candidates = offices.filter(o => o.department === dept && o.isActive);
  // Origin-only (VGM/Loading/Pickup) and destination-only (Unloading/Delivery) types are
  // filtered out of the *other* side's dropdown entirely here — see SERVICE_TYPE_SIDES in
  // shipmentServicePages.js for why those five aren't both-sides like everything else.
  const availableTypes = serviceTypesForSide(side);
  // An edited service's own serviceType may be a free-text "Other" value saved earlier that
  // isn't in the current dropdown list — fall back to the "Other" option + prefill the
  // specify-service field, rather than leaving the Sel on a value it doesn't recognize.
  const initTypeIsOther = isEdit && init.serviceType && !availableTypes.includes(init.serviceType);

  const [serviceType, setServiceType] = useState(initTypeIsOther ? "Other" : (init?.serviceType || availableTypes[0]));
  const [typeDefaulted, setTypeDefaulted] = useState(isEdit); // don't override an already-set type
  const [otherType,   setOtherType]   = useState(initTypeIsOther ? init.serviceType : "");
  const [vendor,       setVendor]      = useState({ id: init?.vendorId || "", name: init?.vendorName || "" });
  const [officeId,     setOfficeId]    = useState(init?.officeId || defaultOfficeId);
  const [requestedDate, setRequestedDate] = useState(init?.requestedDate || todayIso());
  const [notes,         setNotes]         = useState(init?.notes || "");
  const [saving,        setSaving]        = useState(false);

  // Nicety, not required for correctness: pre-select Pickup/Delivery when this side's own
  // Pick-up/Delivery leg is Merchant's Haulage — that's the realistic case an operator is
  // opening this form for. Silent no-op otherwise (stays on the default first type).
  useEffect(() => {
    if (typeDefaulted) return;
    const type = side === "Export" ? "Pickup" : "Delivery";
    api.legs.list(shipment.id).then(legs => {
      const leg = findRoutingLeg(legs, type);
      if (leg?.movementType === "Merchant's Haulage") setServiceType(type);
    }).catch(() => {}).finally(() => setTypeDefaulted(true));
  }, [side, shipment.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <Modal title={isEdit ? `Edit ${side} Service` : `Request ${side} Service`} onClose={onCancel} width={480}>
      <div id="svcform" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Sel id="svcform-type" label="Service Type" value={serviceType} onChange={setServiceType} required
          options={availableTypes.map(t => ({ value: t, label: t }))} />
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
            {saving ? "Saving…" : isEdit ? "Save Changes" : "Request Service"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

const ServiceRow = ({ service, canEdit, onAdvance, onCancelService, onDelete, onEdit }) => {
  const nextStatus = NEXT_STATUS[service.status];
  const iconBtn = { width: 22, height: 22, borderRadius: 6, border: `1px solid ${HZ.border}`,
    background: HZ.surface2, color: HZ.textMuted, display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", flexShrink: 0 };
  return (
    <div id={`svcpanel-row-${service.id}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
      background: HZ.bg, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: HZ_BODY, fontSize: 12.5, fontWeight: 600, color: HZ.text }}>
            {service.serviceType}
          </span>
          <StatusPill status={service.status} />
        </div>
        <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginTop: 2 }}>
          {service.vendorName || "No vendor set"}
          {service.officeCode ? ` · ${service.officeCode}` : ""}
          {service.requestedDate ? ` · Req. ${service.requestedDate}` : ""}
        </div>
      </div>
      {canEdit && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          <button id={`svcpanel-row-${service.id}-edit-btn`} type="button" onClick={() => onEdit(service)}
            title="Edit vendor / office / notes" style={iconBtn}>
            <IconPencil size={11} />
          </button>
          {nextStatus && (
            <button id={`svcpanel-row-${service.id}-advance-btn`} type="button" onClick={() => onAdvance(service, nextStatus)}
              style={{ background: "none", border: `1px solid ${HZ.cyan}66`, color: HZ.cyan,
                borderRadius: 5, padding: "3px 9px", fontFamily: HZ_BODY, fontSize: 11,
                fontWeight: 600, cursor: "pointer" }}>
              {NEXT_LABEL[service.status]}
            </button>
          )}
          {(service.status === "Requested" || service.status === "Confirmed") && (
            <button id={`svcpanel-row-${service.id}-cancel-btn`} type="button" onClick={() => onCancelService(service)}
              title="Cancel service"
              style={{ background: "none", border: "none", color: HZ.textMuted,
                cursor: "pointer", fontFamily: HZ_BODY, fontSize: 11, padding: "3px 4px" }}>
              Cancel
            </button>
          )}
          <button id={`svcpanel-row-${service.id}-delete-btn`} type="button" onClick={() => onDelete(service)}
            title="Delete service" style={{ ...iconBtn, color: HZ.crit }}>
            <IconClose size={11} />
          </button>
        </div>
      )}
    </div>
  );
};

const ServiceColumn = ({ side, services, loading, canEdit, onRequest, onAdvance, onCancelService, onDelete, onEdit }) => {
  const accent = side === "Export" ? HZ.cyan : HZ.violet;
  return (
    <div id={`svcpanel-${side.toLowerCase()}-column`} style={{ background: HZ.surface, backdropFilter: "blur(20px)",
      border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px",
        borderBottom: `1px solid ${HZ.border}`, background: accent + "14" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: accent, flexShrink: 0 }} />
        <span style={{ fontFamily: HZ_DISPLAY, fontSize: 13, fontWeight: 800, textTransform: "uppercase",
          letterSpacing: ".06em", color: HZ.text, flex: 1 }}>
          {side} Services
        </span>
        {canEdit && (
          <button id={`svcpanel-${side.toLowerCase()}-request-btn`} type="button" onClick={onRequest}
            style={{ background: "none", border: `1px dashed ${accent}55`, borderRadius: 6,
              padding: "5px 11px", cursor: "pointer", fontFamily: HZ_BODY, fontSize: 11.5, color: accent }}>
            ＋ Request Service
          </button>
        )}
      </div>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "14px 2px" }}>
            <Spinner size="sm" />
          </div>
        ) : services.length === 0 ? (
          <div id={`svcpanel-${side.toLowerCase()}-empty`} style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted, fontStyle: "italic", padding: "6px 2px" }}>
            No {side.toLowerCase()} services ordered yet.
          </div>
        ) : services.map(s => (
          <ServiceRow key={s.id} service={s} canEdit={canEdit}
            onAdvance={onAdvance} onCancelService={onCancelService} onDelete={onDelete} onEdit={onEdit} />
        ))}
      </div>
    </div>
  );
};

const ServicesPanel = ({ shipment }) => {
  const { canEditShipments: canEditRole, isAdmin, activeRoles, allOffices } = useAuth();
  // Each column is gated by ITS OWN side (Office-Side Permissions Epic, TKT-Z0LB0W) — Export
  // Services and Import Services are each editable only by the office that owns that side.
  const auth = { canEditShipments: canEditRole, isAdmin, activeRoles, allOffices };
  const canEditExport = canEditShipmentSide(auth, shipment, "export");
  const canEditImport = canEditShipmentSide(auth, shipment, "import");
  // null = not yet loaded (distinct from [] = loaded and genuinely empty) — without this
  // distinction the fetch's first second or two renders "No services ordered yet" even
  // when services do exist, since an empty initial array is indistinguishable from a
  // confirmed-empty one.
  const [services, setServices] = useState(null);
  const [offices,  setOffices]  = useState([]);
  const [requestSide, setRequestSide] = useState(null); // null | "Export" | "Import"
  const [editingService, setEditingService] = useState(null); // service pending edit, or null
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

  const handleEditSave = async (payload) => {
    try {
      await api.services.update(shipment.id, editingService.id, payload);
      toast.success("Service updated");
      setEditingService(null);
      load();
    } catch (e) { toast.error(e.message || "Failed to update service"); }
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

  useHorizonFonts();

  return (
    <div id="svcpanel">
      <div id="svcpanel-columns" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ServiceColumn side="Export" services={exportServices} loading={loading} canEdit={canEditExport}
          onRequest={() => setRequestSide("Export")}
          onAdvance={handleAdvance} onCancelService={handleCancelService}
          onDelete={setConfirmDelete} onEdit={setEditingService} />
        <ServiceColumn side="Import" services={importServices} loading={loading} canEdit={canEditImport}
          onRequest={() => setRequestSide("Import")}
          onAdvance={handleAdvance} onCancelService={handleCancelService}
          onDelete={setConfirmDelete} onEdit={setEditingService} />
      </div>

      {requestSide && (
        <ServiceForm side={requestSide} offices={offices} shipment={shipment}
          onSave={handleCreate} onCancel={() => setRequestSide(null)} />
      )}

      {editingService && (
        <ServiceForm side={editingService.side} offices={offices} shipment={shipment} init={editingService}
          onSave={handleEditSave} onCancel={() => setEditingService(null)} />
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
