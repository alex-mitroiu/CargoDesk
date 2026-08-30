import { useState, useEffect, useCallback } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Inp, Sel, Field } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import CarrierCombobox from "../../components/shared/CarrierCombobox";
import PortField from "../../components/shared/PortField";
import CountryCombobox from "../../components/shared/CountryCombobox";
import CustomerCombobox from "../../components/shared/CustomerCombobox";
import ActionMenu from "../../components/primitives/ActionMenu";
import { IconPencil, IconClose } from "../../components/primitives/Icon";
import Pagination from "../../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../../components/primitives/PageSizeSelect";
import { PageSpinner } from "../../components/primitives/Spinner";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── MDM: Carrier Agents Page ─────────────────────────────────────────────────
// Which local company represents a carrier — carrier x agent, covering any number of specific
// UN/LOCODEs and/or whole countries (a "table of configuration" per header, so one Line Agent in
// Spain can also cover Andorra). Auto-resolves onto every shipment's Additional Parties as
// "Line Agent (Export/Import)" (see resolveCarrierAgent/maybeAssignLineAgents,
// routes/shipments.js) and is displayed on the shipment's Carrier Booking -> Details tab.
// Adding a country location that makes an existing UN/LOCODE under the same header redundant
// auto-discards that UN/LOCODE (logged to its own history) — the backend reports which ones in
// `discarded`, surfaced here as an informational modal, never a silent removal.

const LOCATION_TYPES = [
  { value: "unlocode", label: "Specific UN/LOCODE" },
  { value: "country",  label: "Whole Country" },
];

// ─── Add/Edit a single location on an existing header ─────────────────────────
const LocationPicker = ({ locationType, setLocationType, port, setPort, country, setCountry }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <Sel label="Coverage Type" value={locationType} onChange={setLocationType} options={LOCATION_TYPES} />
    {locationType === "unlocode" ? (
      <PortField label="Port" value={port} onChange={setPort} placeholder="Search UN/LOCODE…" required />
    ) : (
      <Field label="Country" required>
        <CountryCombobox placeholder="Search countries…" onSelect={setCountry} />
        {country && (
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8,
            background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 12px" }}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{country.iso2}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{country.name}</span>
          </div>
        )}
      </Field>
    )}
  </div>
);

const MdmCarrierAgentsPage = () => {
  const { canManageMdm } = useAuth();
  const [agents,  setAgents]  = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [limit,   setLimit]   = useState(getStoredPageSize);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null);      // null | "add" | agent header obj (edit)
  const [addLocFor, setAddLocFor] = useState(null);  // header obj | null — "+ Location" modal target
  const [confirm, setConfirm] = useState(null);       // header id to delete
  const [confirmLoc, setConfirmLoc] = useState(null); // location id to remove
  const [discardNotice, setDiscardNotice] = useState(null); // { countryLabel, discarded: [] } | null
  const [apiErr,  setApiErr]  = useState(null);
  const { template, startResize } = useResizableColumns("mdm-carrier-agents", [100, 180, 280, 160, 100]);
  const headers = ["Carrier", "Agent", "Locations", "Note", "Actions"];

  const load = useCallback(async (opts = {}) => {
    const off = opts.offset !== undefined ? opts.offset : offset;
    const lim = opts.limit  !== undefined ? opts.limit  : limit;
    setLoading(true);
    try {
      const res = await api.carrierAgents.list({ limit: lim, offset: off });
      setAgents(res.results || []);
      setTotal(res.total ?? 0);
      setApiErr(null);
    } catch (e) { setApiErr(e.message); }
    setLoading(false);
  }, [offset, limit]);

  useEffect(() => { load({ offset: 0 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const goPage = off => { setOffset(off); load({ offset: off }); };
  const changeLimit = n => { setLimit(n); setOffset(0); load({ limit: n, offset: 0 }); };

  // ─── Add header (carrier + agent + note + one initial location) ─────────────
  const AgentForm = ({ onSave, onCancel }) => {
    const [carrierCode, setCarrierCode] = useState("");
    const [agent, setAgent] = useState({ id: "", name: "" });
    const [note, setNote] = useState("");
    const [locationType, setLocationType] = useState("unlocode");
    const [port, setPort] = useState(null);
    const [country, setCountry] = useState(null);
    const [saving, setSaving] = useState(false);
    const [formErr, setFormErr] = useState(null);
    const validLoc = locationType === "unlocode" ? !!port : !!country;
    const valid = carrierCode && agent.id && validLoc;

    const handleSave = async () => {
      setSaving(true); setFormErr(null);
      try {
        await onSave({
          carrierCode, agentCustomerId: agent.id, note,
          locationType, unlocode: port?.unlocode, countryIso2: country?.iso2,
        });
      } catch (e) { setFormErr(e.message); }
      setSaving(false);
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <CarrierCombobox value={carrierCode} onChange={setCarrierCode} required />
        <CustomerCombobox label="Agent (Customer)" value={agent} onChange={setAgent} required />
        <LocationPicker locationType={locationType} setLocationType={setLocationType}
          port={port} setPort={setPort} country={country} setCountry={setCountry} />
        <Inp label="Note (optional)" value={note} onChange={setNote} placeholder="e.g. Booking + B/L release desk" />
        {formErr && (
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.danger }}>{formErr}</div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid || saving} onClick={handleSave}>Add Carrier Agent</Btn>
        </div>
      </div>
    );
  };

  // ─── Reassign agent / note on an existing header ─────────────────────────────
  const EditHeaderForm = ({ init, onSave, onCancel }) => {
    const [agent, setAgent] = useState({ id: init.agentCustomerId || "", name: init.agentCustomerName || "" });
    const [note, setNote] = useState(init.note || "");
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 16px" }}>
          <div style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{init.carrierCode}</div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 2 }}>
            {init.locations.length} location{init.locations.length !== 1 ? "s" : ""} configured
          </div>
        </div>
        <CustomerCombobox label="Agent (Customer)" value={agent} onChange={setAgent} required />
        <Inp label="Note (optional)" value={note} onChange={setNote} placeholder="e.g. Booking + B/L release desk" />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!agent.id} onClick={() => onSave({ agentCustomerId: agent.id, note })}>Save</Btn>
        </div>
      </div>
    );
  };

  // ─── Add a location to an existing header ────────────────────────────────────
  const AddLocationForm = ({ header, onDone, onCancel }) => {
    const [locationType, setLocationType] = useState("unlocode");
    const [port, setPort] = useState(null);
    const [country, setCountry] = useState(null);
    const [saving, setSaving] = useState(false);
    const [formErr, setFormErr] = useState(null);
    const valid = locationType === "unlocode" ? !!port : !!country;

    const handleSave = async () => {
      setSaving(true); setFormErr(null);
      try {
        const res = await api.carrierAgents.addLocation(header.id, {
          locationType, unlocode: port?.unlocode, countryIso2: country?.iso2,
        });
        onDone(res, locationType === "country" ? `${country.name} (${country.iso2})` : null);
      } catch (e) { setFormErr(e.message); setSaving(false); }
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
          Adding a location for <strong style={{ color: T.text }}>{header.carrierCode}</strong> — agent{" "}
          <strong style={{ color: T.text }}>{header.agentCustomerName}</strong>
        </div>
        <LocationPicker locationType={locationType} setLocationType={setLocationType}
          port={port} setPort={setPort} country={country} setCountry={setCountry} />
        {formErr && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.danger }}>{formErr}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid || saving} onClick={handleSave}>Add Location</Btn>
        </div>
      </div>
    );
  };

  const locationChip = (loc, header) => (
    <span key={loc.id} style={{ display: "inline-flex", alignItems: "center", gap: 4,
      background: loc.type === "country" ? `${T.accent}18` : T.bg,
      border: `1px solid ${loc.type === "country" ? T.accent + "55" : T.border}`,
      borderRadius: 6, padding: "2px 4px 2px 8px", marginRight: 6, marginBottom: 4 }}>
      <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
        color: loc.type === "country" ? T.accent : T.text }}>
        {loc.type === "country" ? `🌐 ${loc.countryIso2}` : loc.unlocode}
      </span>
      {loc.type === "unlocode" && loc.portName && (
        <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted }}>{loc.portName}</span>
      )}
      {canManageMdm && (
        <button type="button" onClick={() => setConfirmLoc(loc.id)}
          style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted,
            fontSize: 12, padding: "0 2px", lineHeight: 1 }} title="Remove this location">×</button>
      )}
    </span>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Carrier Agents</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total} Line Agent{total !== 1 ? "s" : ""} configured · each can cover one or more UN/LOCODEs and/or whole countries
          </p>
        </div>
        {canManageMdm && <Btn onClick={() => setModal("add")} size="lg">＋ Add Carrier Agent</Btn>}
      </div>

      {apiErr && (
        <div style={{ background: T.dangerBg, border: `1px solid ${T.danger}44`, borderRadius: 8,
          padding: "12px 16px", fontFamily: T.body, fontSize: 13, color: T.danger, marginBottom: 16 }}>
          {apiErr}
        </div>
      )}

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: template,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {headers.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < headers.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
            </div>
          ))}
        </div>

        {loading ? (
          <PageSpinner />
        ) : agents.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No carrier agents configured yet. Use "+ Add Carrier Agent" to register one.
          </div>
        ) : agents.map(a => (
          <div key={a.id}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{a.carrierCode}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>{a.agentCustomerName || "—"}</span>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center" }}>
              {a.locations.map(loc => locationChip(loc, a))}
              {canManageMdm && (
                <button type="button" onClick={() => setAddLocFor(a)}
                  style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.accent,
                    background: "none", border: `1px dashed ${T.accent}66`, borderRadius: 6,
                    padding: "3px 8px", cursor: "pointer", marginBottom: 4 }}>
                  ＋ Location
                </button>
              )}
            </div>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: a.note ? "normal" : "italic" }}>
              {a.note || "—"}
            </span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...(canManageMdm ? [{ icon: IconPencil, label: "Edit", onClick: () => setModal(a) }] : []),
                ...(canManageMdm ? [{ icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(a.id) }] : []),
              ]} />
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <PageSizeSelect value={limit} onChange={changeLimit} />
        <div style={{ flex: 1 }}><Pagination total={total} limit={limit} offset={offset} onPage={goPage} /></div>
      </div>

      {modal === "add" && (
        <Modal title="Add Carrier Agent" onClose={() => setModal(null)} width={560}>
          <AgentForm
            onSave={async data => { await api.carrierAgents.create(data); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Carrier Agent" onClose={() => setModal(null)} width={480}>
          <EditHeaderForm init={modal}
            onSave={async data => { await api.carrierAgents.update(modal.id, data); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {addLocFor && (
        <Modal title="Add Location" onClose={() => setAddLocFor(null)} width={480}>
          <AddLocationForm header={addLocFor}
            onDone={(res, countryLabel) => {
              setAddLocFor(null);
              load();
              if (res.discarded?.length) setDiscardNotice({ countryLabel, discarded: res.discarded });
            }}
            onCancel={() => setAddLocFor(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message="Remove this carrier agent entirely, including every location configured under it? Shipments already assigned it keep their current party — only future auto-resolution is affected."
          onConfirm={async () => { await api.carrierAgents.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
      {confirmLoc && (
        <ConfirmModal
          message="Remove this location from the Line Agent? Shipments already assigned it keep their current party — only future auto-resolution is affected."
          onConfirm={async () => { await api.carrierAgents.removeLocation(confirmLoc); setConfirmLoc(null); load(); }}
          onCancel={() => setConfirmLoc(null)} />
      )}
      {discardNotice && (
        <Modal title="Locations Automatically Updated" onClose={() => setDiscardNotice(null)} width={480}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.6, margin: 0 }}>
              Adding the country <strong>{discardNotice.countryLabel}</strong> already covers every port in that
              country, so the following specific UN/LOCODE{discardNotice.discarded.length !== 1 ? "s" : ""} — now
              redundant — {discardNotice.discarded.length !== 1 ? "were" : "was"} automatically removed from this
              Line Agent:
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {discardNotice.discarded.map(u => <Badge key={u}>{u}</Badge>)}
            </div>
            <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: 0 }}>
              This change is recorded in the location's history — nothing was silently lost.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Btn onClick={() => setDiscardNotice(null)}>Got it</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default MdmCarrierAgentsPage;
