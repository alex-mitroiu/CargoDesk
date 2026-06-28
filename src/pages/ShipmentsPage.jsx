import { useState, useEffect } from "react";
import { T, CONTRACT_PRESETS, CONTAINER_TYPES, STATUSES, INCOTERMS_2020,
         statusVariant, contractVariant, teuOf, addDays, diffDays } from "../tokens";
import { api } from "../api";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import DatePicker from "../components/primitives/DatePicker";
import PortCombobox from "../components/shared/PortCombobox";
import { VesselField } from "../components/shared/VesselCombobox";
import { inputBase, BtnToggle, Inp, Sel, Textarea, Field, ContractTypeInput } from "../components/primitives/Form";
import { CommodityCombobox } from "../components/shared/CommodityCombobox";
import Spinner from "../components/primitives/Spinner";

const ShipmentForm = ({ init = {}, carriers, onSave, onCancel }) => {
  const [polPort, setPolPort] = useState(init.pol ? { unlocode: init.pol, name: "" } : null);
  const [podPort, setPodPort] = useState(init.pod ? { unlocode: init.pod, name: "" } : null);
  const [f, setF] = useState({
    carrierCode:   init.carrierCode   || carriers[0]?.code || "",
    contractType:  init.contractType  || "SPOT",
    contractNotes: init.contractNotes || "",
    status:        init.status        || "Active",
    etd:           init.etd           || "",
    eta:           init.eta           || "",
    bookingRef:    init.bookingRef     || "",
    blNumber:      init.blNumber      || "",
    vessel:        init.vessel        || "",
    vesselImo:     init.vesselImo     || "",
    voyage:        init.voyage        || "",
    incoterm:      init.incoterm      || "",
    contractId:    init.contractId     || "",
    commodityCode: init.commodityCode  || "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const valid = polPort?.unlocode?.length === 5 && podPort?.unlocode?.length === 5
    && f.carrierCode && f.contractType.trim().length > 0 && f.incoterm !== ""
    && f.commodityCode.trim().length > 0;

  const handleSave = async () => {
    if (!valid) return;
    setIsSaving(true);
    try {
      await onSave({ ...f, pol: polPort.unlocode, pod: podPort.unlocode, contractId: f.contractId, commodityCode: f.commodityCode });
    } finally { setIsSaving(false); }
  };

  const PortField = ({ label, port, onSelect, placeholder }) => (
    <Field label={label} required>
      {port?.unlocode ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ flex: 1, background: T.bg, border: `1px solid ${T.accent}55`, borderRadius: 6,
            padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{port.unlocode}</span>
            {port.name && <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{port.name}</span>}
          </div>
          <button onClick={() => onSelect(null)}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
              color: T.textMuted, cursor: "pointer", padding: "6px 10px", fontSize: 12 }}>✕</button>
        </div>
      ) : (
        <PortCombobox placeholder={placeholder} onChange={onSelect} />
      )}
    </Field>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {carriers.length === 0 && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8,
          padding: "12px 16px", fontFamily: T.body, fontSize: 13, color: T.warning }}>
          ⚠ No carriers in registry. Add a carrier first before creating a shipment.
        </div>
      )}

      {/* Ports */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <PortField label="Port of Loading"   port={polPort} onSelect={setPolPort} placeholder="Search POL (NLRTM, Rotterdam…)" />
        <PortField label="Port of Discharge" port={podPort} onSelect={setPodPort} placeholder="Search POD (CNSHA, Shanghai…)" />
      </div>

      {/* Carrier */}
      {carriers.length > 0 && (
        <Sel label="Carrier" value={f.carrierCode} onChange={set("carrierCode")} required
          options={carriers.map(c => ({ value: c.code, label: `${c.code} – ${c.name}` }))} />
      )}

      {/* Incoterm — mandatory */}
      <Sel label="Incoterm" value={f.incoterm} onChange={set("incoterm")} required
        options={[
          { value: "", label: "Select incoterm…" },
          ...INCOTERMS_2020.map(t => ({ value: t.code, label: `${t.code} – ${t.name}` })),
        ]}
      />

      {/* Commodity — mandatory, core cargo identity */}
      <Field label="Commodity" required hint="Maersk freight type — determines handling, documentation, and service eligibility">
        <CommodityCombobox
          value={f.commodityCode}
          onChange={v => set("commodityCode")(v)}
        />
      </Field>

      {/* Dates + references */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <DatePicker label="ETD" value={f.etd} onChange={set("etd")} hint="Estimated Departure" />
        <DatePicker label="ETA" value={f.eta} onChange={set("eta")} hint="Estimated Arrival"
          minDate={f.etd || undefined} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Booking Reference" value={f.bookingRef} onChange={set("bookingRef")} placeholder="BK-2025-00123" mono />
        <Inp label="B/L Number"        value={f.blNumber}   onChange={set("blNumber")}   placeholder="MAEU123456789" mono />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <VesselField
          vessel={f.vesselImo ? { imo: f.vesselImo, name: f.vessel } : null}
          onSelect={v => setF(p => ({ ...p, vessel: v ? v.name : "", vesselImo: v ? v.imo : "" }))}
        />
        <Inp label="Voyage" value={f.voyage} onChange={set("voyage")} placeholder="423E" mono />
      </div>

      {/* Contract */}
      <ContractTypeInput value={f.contractType} onChange={set("contractType")} />
      <Inp label="Contract ID" value={f.contractId} onChange={set("contractId")} placeholder="e.g. MSC-2025-0042" mono hint="Reference ID for this contract arrangement" />
      <Textarea label="Contract Notes" value={f.contractNotes} onChange={set("contractNotes")}
        placeholder="Optional reference, contract IDs, remarks…" rows={2} />
      <Sel label="Status" value={f.status} onChange={set("status")}
        options={STATUSES.map(s => ({ value: s, label: s }))} />

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={!valid || carriers.length === 0}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {isSaving && <Spinner size="sm" color="currentColor" />}
            {isSaving ? "Saving…" : (init.id ? "Save Changes" : "Create Shipment")}
          </span>
        </Btn>
      </div>
    </div>
  );
};

const ShipmentsPage = ({ shipments, containers, carriers, onSelect, onDelete, onNew }) => {
  const [confirm, setConfirm] = useState(null);
  const teuFor = id => containers.filter(c => c.shipmentId === id).reduce((s, c) => s + teuOf(c.size), 0);

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
        <div style={{ display: "grid", gridTemplateColumns: "140px 70px 70px 1fr 165px 60px 110px 110px",
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Shipment ID", "POL", "POD", "Carrier", "Contract", "TEU", "Status", ""].map((h, i) => (
            <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
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
              style={{ display: "grid", gridTemplateColumns: "140px 70px 70px 1fr 165px 60px 110px 110px",
                padding: "14px 20px", borderBottom: `1px solid ${T.border}22`,
                cursor: "pointer", alignItems: "center", transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textCode, fontWeight: 700 }}>{s.id}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pol}</span>
                {s.polName && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{s.polName}</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pod}</span>
                {s.podName && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{s.podName}</span>}
              </div>
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

export { ShipmentForm };
export default ShipmentsPage;