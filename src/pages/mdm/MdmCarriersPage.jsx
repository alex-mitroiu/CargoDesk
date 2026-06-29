import { useState, useEffect } from "react";
import { T , addDays, diffDays } from "../../tokens";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";
import { api } from "../../api";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import {Inp, BtnToggle, Field, Sel, Textarea, ContractTypeInput} from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import ActionMenu from "../../components/primitives/ActionMenu";
import EntityHistoryModal from "../../components/shared/EntityHistoryModal";
import DatePicker from "../../components/primitives/DatePicker";
import PortCombobox from "../../components/shared/PortCombobox";
import { VesselField } from "../../components/shared/VesselCombobox";

const CarrierForm = ({ init = {}, onSave, onCancel, existing = [] }) => {
  const [code, setCode] = useState(init.code || "");
  const [name, setName] = useState(init.name || "");
  const isEdit = !!init.code;
  const codeClean = code.trim().toUpperCase();
  const dupCode = !isEdit && existing.some(c => c.code === codeClean);
  const valid = codeClean.length >= 2 && codeClean.length <= 6 && name.trim().length >= 2 && !dupCode;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Inp label="Carrier Code" value={code} onChange={v => setCode(v.toUpperCase())}
        placeholder="HLCU" mono maxLength={6} required hint="2–6 uppercase chars (e.g. MAEU, HLCU)" />
      {dupCode && <div style={{ fontFamily: T.body, fontSize: 12, color: T.danger }}>A carrier with code "{codeClean}" already exists.</div>}
      <Inp label="Carrier Name" value={name} onChange={setName} placeholder="Hapag-Lloyd" required />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => valid && onSave({ code: codeClean, name: name.trim() })} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Carrier"}
        </Btn>
      </div>
    </div>
  );
};

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
  });
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const valid = polPort?.unlocode?.length === 5 && podPort?.unlocode?.length === 5
    && f.carrierCode && f.contractType.trim().length > 0 && f.incoterm !== "";

  const handleSave = () => {
    if (!valid) return;
    onSave({ ...f, pol: polPort.unlocode, pod: podPort.unlocode });
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
      <Textarea label="Contract Notes" value={f.contractNotes} onChange={set("contractNotes")}
        placeholder="Optional reference, contract IDs, remarks…" rows={2} />
      <Sel label="Status" value={f.status} onChange={set("status")}
        options={STATUSES.map(s => ({ value: s, label: s }))} />

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={!valid || carriers.length === 0}>
          {init.id ? "Save Changes" : "Create Shipment"}
        </Btn>
      </div>
    </div>
  );
};

const ContainerForm = ({ init = {}, onSave, onCancel }) => {
  const [f, setF] = useState({ number: init.number || "", size: init.size || "40", type: init.type || "DC" });
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const typeLabel = { DC: "Dry", RF: "Reefer", OT: "Open Top", FR: "Flat Rack", TK: "Tank" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Inp label="Container Number" value={f.number}
        onChange={v => set("number")(v.toUpperCase().replace(/\s/g, ""))}
        placeholder="MAEU1234567" mono required />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Size">
          <div style={{ display: "flex", gap: 8 }}>
            {["20", "40"].map(sz => (
              <BtnToggle key={sz} selected={f.size === sz} onClick={() => set("size")(sz)} wide sub={sz === "20" ? "1 TEU" : "2 TEU"}>
                {sz}ft
              </BtnToggle>
            ))}
          </div>
        </Field>
        <Sel label="Equipment Type" value={f.type} onChange={set("type")}
          options={CONTAINER_TYPES.map(t => ({ value: t, label: `${t} – ${typeLabel[t] || t}` }))} />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => f.number.length >= 4 && onSave(f)} disabled={f.number.length < 4}>
          {init.id ? "Update Container" : "Add Container"}
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
  const [modal,          setModal]          = useState(null);
  const [confirm,        setConfirm]        = useState(null);
  const [historyCarrier, setHistoryCarrier] = useState(null);
  const { template, startResize } = useResizableColumns("mdm-carriers", [130,200,160]);
  const headers = ["Code","Name","Actions"];

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
        <div style={{ display: "grid", gridTemplateColumns: template,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {headers.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < headers.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
            </div>
          ))}
        </div>

        {carriers.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No carriers yet. Add your first carrier above.
          </div>
        ) : carriers.map(c => (
          <div key={c.code} style={{ display: "grid", gridTemplateColumns: template,
            padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
            transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{c.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{c.name}</span>
            <ActionMenu items={[
              { icon: "✎", label: "Edit",    onClick: () => setModal(c) },
              { icon: "📋", label: "History", onClick: () => setHistoryCarrier(c) },
              { icon: "✕", label: "Remove",  variant: "danger", onClick: () => setConfirm(c.code) },
            ]} />
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
      {historyCarrier && (
        <EntityHistoryModal
          entityType="carrier"
          entityId={historyCarrier.code}
          title={`History — ${historyCarrier.code}`}
          headerContent={
            <>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{historyCarrier.code}</span>
              <span style={{ fontFamily: T.body, fontSize: 12, color: T.text }}>{historyCarrier.name}</span>
            </>
          }
          onClose={() => setHistoryCarrier(null)} />
      )}
    </div>
  );
};

// ─── Page: Shipments List ─────────────────────────────────────────────────────

export default CarriersPage;