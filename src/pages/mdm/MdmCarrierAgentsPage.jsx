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
// UN/LOCODEs and/or whole countries in ONE table of configuration per header, so a single Line
// Agent (e.g. based in Spain) can also cover Andorra as a second row rather than needing a
// second agent record. Auto-resolves onto every shipment's Additional Parties as "Line Agent
// (Export/Import)" (see resolveCarrierAgent/maybeAssignLineAgents, routes/shipments.js) and is
// displayed on the shipment's Carrier Booking -> Details tab.
//
// One modal per action (Add / Edit) — identity fields fixed on the left, everything else behind
// two tabs on the right: Coverage (Locations + Working Schedule sub-tabs) and Address & Contact
// (a read-only view of the linked customer's own address/contact record — never a second copy of
// that data, just a convenience display sourced live from Customers/Contacts). The page's own
// row is read-only display only.

const LOCATION_TYPES = [
  { value: "unlocode", label: "Specific UN/LOCODE" },
  { value: "country",  label: "Whole Country" },
];
const SCHEDULE_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Same codes as routes/mdm.js's AGENT_CAPABILITY_CODES — lets a shipment later cross-check this
// agent's own operational capabilities against what a leg's haulage/service actually needs,
// before a booking is sent, instead of finding out only after a carrier rejection or a rework.
const CAPABILITY_OPTIONS = [
  { code: "port_agency",       label: "Port Agency / Vessel Husbandry" },
  { code: "documentation",     label: "Documentation & B/L Release" },
  { code: "customs_clearance", label: "Customs Clearance" },
  { code: "road_haulage",      label: "Road Haulage" },
  { code: "rail_haulage",      label: "Rail Haulage" },
  { code: "barge_haulage",     label: "Barge Haulage" },
  { code: "warehousing",       label: "Warehousing" },
  { code: "cy_storage",        label: "Container Yard (CY) Storage" },
  { code: "fumigation",        label: "Fumigation" },
  { code: "empty_equipment",   label: "Empty Equipment Depot" },
];

const locationLabel = loc => loc.type === "country"
  ? `🌐 ${loc.countryIso2}${loc.countryName ? ` — ${loc.countryName}` : ""}`
  : `${loc.unlocode}${loc.portName ? ` — ${loc.portName}` : ""}`;

// ─── Shared location-type + UN/LOCODE-or-country picker ────────────────────────
const LocationPicker = ({ locationType, setLocationType, port, setPort, country, setCountry }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <Sel label="Coverage Type" value={locationType} onChange={setLocationType} options={LOCATION_TYPES} />
    {locationType === "unlocode" ? (
      <PortField label="UN/LOCODE" value={port} onChange={setPort} placeholder="Search UN/LOCODE…" required />
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

// ─── One row inside the locations table ────────────────────────────────────────
const LocationRow = ({ loc, onRemove, isLast }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "8px 12px", borderBottom: isLast ? "none" : `1px solid ${T.border}22` }}>
    <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{locationLabel(loc)}</span>
    <button type="button" onClick={onRemove} title="Remove this location"
      style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted,
        fontSize: 15, padding: "0 4px", lineHeight: 1 }}>×</button>
  </div>
);

// ─── Working Schedule — day-group + hour-range rows, staged until the modal's own Save ────────
// A day can only belong to one row: selecting it in a row clears it from every other row first.
const ScheduleEditor = ({ rows, setRows }) => {
  const toggleDay = (rowIdx, day) => {
    setRows(rows.map((r, i) => {
      if (i === rowIdx) {
        const has = r.days.includes(day);
        return { ...r, days: has ? r.days.filter(d => d !== day) : [...r.days, day] };
      }
      return { ...r, days: r.days.filter(d => d !== day) };
    }));
  };
  const setTime = (rowIdx, field, value) => setRows(rows.map((r, i) => i === rowIdx ? { ...r, [field]: value } : r));
  const removeRow = rowIdx => setRows(rows.filter((_, i) => i !== rowIdx));
  const addRow = () => setRows([...rows, { days: [], startTime: "09:00", endTime: "18:00" }]);

  const usedDays = new Set(rows.flatMap(r => r.days));
  const offDays = SCHEDULE_DAYS.filter(d => !usedDays.has(d));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.length > 0 && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
          {rows.map((row, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px",
              borderBottom: i === rows.length - 1 ? "none" : `1px solid ${T.border}22` }}>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
                {SCHEDULE_DAYS.map(day => (
                  <button key={day} type="button" onClick={() => toggleDay(i, day)}
                    style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 700,
                      color: row.days.includes(day) ? "#26190a" : T.textMuted,
                      background: row.days.includes(day) ? T.accent : T.bg,
                      border: `1px solid ${row.days.includes(day) ? T.accent : T.border}`,
                      borderRadius: 5, padding: "3px 7px", cursor: "pointer" }}>
                    {day}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <input type="time" value={row.startTime} onChange={e => setTime(i, "startTime", e.target.value)}
                  style={{ width: 132, padding: "6px 10px", fontSize: 12.5, background: T.bg,
                    border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontFamily: T.body }} />
                <span style={{ color: T.textFaint || T.textMuted, fontSize: 12 }}>–</span>
                <input type="time" value={row.endTime} onChange={e => setTime(i, "endTime", e.target.value)}
                  style={{ width: 132, padding: "6px 10px", fontSize: 12.5, background: T.bg,
                    border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontFamily: T.body }} />
              </div>
              <button type="button" onClick={() => removeRow(i)} title="Remove this row"
                style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted,
                  fontSize: 15, padding: "0 2px", flexShrink: 0 }}>×</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn size="sm" variant="secondary" onClick={addRow}>＋ Add Row</Btn>
      </div>
      <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, lineHeight: 1.6 }}>
        {offDays.length === 0
          ? "Every day of the week has an hour range configured."
          : `${offDays.join(", ")} — no row above, so this agent is treated as closed ${offDays.length > 1 ? "those days" : "that day"}.`}
      </div>
    </div>
  );
};

// ─── Capabilities — which services this Line Agent can actually perform ───────────────────────
const CapabilitiesTab = ({ capabilities, setCapabilities }) => {
  const toggle = code => setCapabilities(
    capabilities.includes(code) ? capabilities.filter(c => c !== code) : [...capabilities, code]
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, lineHeight: 1.6, marginBottom: 6 }}>
        What this agent can actually perform — used later to cross-check against a leg's own
        haulage/service before a booking is sent, instead of finding out only after a carrier
        rejection or a rework.
      </div>
      {CAPABILITY_OPTIONS.map(opt => (
        <label key={opt.code} style={{ display: "flex", alignItems: "center", gap: 10,
          padding: "7px 4px", cursor: "pointer", fontFamily: T.body, fontSize: 13, color: T.text }}>
          <input type="checkbox" checked={capabilities.includes(opt.code)} onChange={() => toggle(opt.code)} />
          {opt.label}
        </label>
      ))}
    </div>
  );
};

// ─── Notes — its own tab so a long note scrolls inside the fixed-height panel instead of
// stretching the left column's single-line input ─────────────────────────────────────────────
const NotesTab = ({ note, setNote }) => (
  <textarea value={note} onChange={e => setNote(e.target.value)}
    placeholder="e.g. Booking + B/L release desk"
    style={{ width: "100%", height: 280, resize: "vertical", overflowY: "auto",
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
      color: T.text, fontFamily: T.body, fontSize: 13, padding: "10px 12px", outline: "none" }} />
);

// ─── Address & Contact — read-only view of the linked customer's own record ───────────────────
const ContactTab = ({ customerId }) => {
  const [customer, setCustomer] = useState(null);
  const [contact,  setContact]  = useState(null);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    if (!customerId) { setLoading(false); return; }
    setLoading(true);
    Promise.all([
      api.customers.get(customerId).catch(() => null),
      api.customers.contacts.list(customerId).catch(() => []),
    ]).then(([cust, contacts]) => {
      setCustomer(cust);
      setContact((contacts || []).find(c => c.isPrimary) || (contacts || [])[0] || null);
    }).finally(() => setLoading(false));
  }, [customerId]);

  const roRow = (label, value) => (
    <div>
      <label style={{ display: "block", fontSize: 10.5, fontWeight: 600, color: T.textMuted,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6, fontFamily: T.body }}>{label}</label>
      <div style={{ fontFamily: T.body, fontSize: 13, color: value ? T.text : T.border,
        background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "9px 12px",
        fontStyle: value ? "normal" : "italic" }}>
        {value || "—"}
      </div>
    </div>
  );

  if (!customerId) return (
    <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic", padding: "8px 0" }}>
      Pick an Agent (Customer) first to see their address and contact details.
    </div>
  );
  if (loading) return <div style={{ padding: 20, textAlign: "center" }}><PageSpinner /></div>;

  const addressLine = customer ? [customer.address1, customer.address2].filter(Boolean).join(", ") : "";
  const cityLine = customer ? [customer.city, customer.postalCode].filter(Boolean).join(" ") : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, textTransform: "uppercase",
        letterSpacing: ".08em", marginBottom: -4 }}>Read-only — the linked customer record</div>
      {roRow("Customer ID", customerId)}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {roRow("Address", addressLine)}
        {roRow("City / Postal Code", cityLine)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {roRow("Country", customer?.countryIso2)}
        {roRow("Company Phone", customer?.phone)}
      </div>
      <div style={{ borderTop: `1px solid ${T.border}22`, paddingTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted,
          textTransform: "uppercase", letterSpacing: ".08em" }}>Primary Contact</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {roRow("Name", contact?.name)}
          {roRow("Phone", contact?.phone)}
        </div>
        {roRow("Email", contact?.email)}
      </div>
    </div>
  );
};

// ─── Coverage tab: Locations + Working Schedule sub-tabs, shared shape for Add and Edit ────────
const CoverageTab = ({ locations, addLocation, removeLocation, addBusy, addErr, scheduleRows, setScheduleRows }) => {
  const [sub, setSub] = useState("locations");
  const [locationType, setLocationType] = useState("unlocode");
  const [port, setPort] = useState(null);
  const [country, setCountry] = useState(null);
  const validLoc = locationType === "unlocode" ? !!port : !!country;

  const handleAdd = () => {
    if (!validLoc) return;
    addLocation({ locationType, unlocode: port?.unlocode, portName: port?.name, countryIso2: country?.iso2, countryName: country?.name },
      () => { setPort(null); setCountry(null); });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 4, background: T.bg, border: `1px solid ${T.border}`,
        borderRadius: 8, padding: 3, width: "fit-content" }}>
        {[["locations", "Locations"], ["schedule", "Working Schedule"]].map(([key, label]) => (
          <button key={key} type="button" onClick={() => setSub(key)}
            style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, borderRadius: 6, padding: "6px 13px",
              cursor: "pointer", border: "none",
              color: sub === key ? "#26190a" : T.textMuted,
              background: sub === key ? T.accent : "none" }}>
            {label}
          </button>
        ))}
      </div>

      {sub === "locations" ? (
        <>
          {locations.length > 0 && (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
              {locations.map((loc, i) => (
                <LocationRow key={loc.id ?? i} loc={loc} isLast={i === locations.length - 1}
                  onRemove={() => removeLocation(i, loc)} />
              ))}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, background: T.bg,
            border: `1px solid ${T.border}`, borderRadius: 8, padding: 12 }}>
            <LocationPicker locationType={locationType} setLocationType={setLocationType}
              port={port} setPort={setPort} country={country} setCountry={setCountry} />
            {addErr && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.danger }}>{addErr}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Btn size="sm" variant="secondary" onClick={handleAdd} disabled={!validLoc || addBusy}>＋ Add Location</Btn>
            </div>
          </div>
        </>
      ) : (
        <ScheduleEditor rows={scheduleRows} setRows={setScheduleRows} />
      )}
    </div>
  );
};

// ─── Add Carrier Agent — header fields + Coverage (staged) + Address & Contact (read-only) ─────
const AddAgentModal = ({ onDone, onCancel }) => {
  const [carrierCode, setCarrierCode] = useState("");
  const [agent, setAgent] = useState({ id: "", name: "" });
  const [note, setNote] = useState("");
  const [tab, setTab] = useState("coverage");
  const [staged, setStaged] = useState([]); // locations not yet saved
  const [scheduleRows, setScheduleRows] = useState([]);
  const [capabilities, setCapabilities] = useState([]);
  const [addErr, setAddErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const valid = carrierCode && agent.id && staged.length > 0;

  const stageLocation = (loc, reset) => {
    setAddErr(null);
    const dup = staged.some(s => loc.locationType === "unlocode" ? s.unlocode === loc.unlocode : s.countryIso2 === loc.countryIso2);
    if (dup) { setAddErr("Already added below."); return; }
    setStaged([...staged, loc]);
    reset();
  };
  const unstageLocation = i => setStaged(staged.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    setSaving(true); setSaveErr(null);
    try {
      const [first, ...rest] = staged;
      const created = await api.carrierAgents.create({
        carrierCode, agentCustomerId: agent.id, note, capabilities,
        locationType: first.locationType, unlocode: first.unlocode, countryIso2: first.countryIso2,
      });
      let discarded = [];
      for (const loc of rest) {
        const res = await api.carrierAgents.addLocation(created.id,
          { locationType: loc.locationType, unlocode: loc.unlocode, countryIso2: loc.countryIso2 });
        if (res.discarded?.length) discarded = [...discarded, ...res.discarded];
      }
      if (scheduleRows.length > 0) await api.carrierAgents.schedule.put(created.id, scheduleRows);
      onDone(discarded);
    } catch (e) { setSaveErr(e.message); setSaving(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <CarrierCombobox value={carrierCode} onChange={setCarrierCode} required />
          <CustomerCombobox label="Agent (Customer)" value={agent} onChange={setAgent} required />
        </div>
        <div>
          <div style={{ display: "flex", gap: 18, borderBottom: `1px solid ${T.border}`, marginBottom: 14 }}>
            {[["coverage", "Coverage"], ["capabilities", "Capabilities"], ["notes", "Notes"], ["contact", "Address & Contact"]].map(([key, label]) => (
              <button key={key} type="button" onClick={() => setTab(key)}
                style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, background: "none", border: "none",
                  padding: "0 0 10px", cursor: "pointer",
                  color: tab === key ? T.accent : T.textMuted,
                  borderBottom: `2px solid ${tab === key ? T.accent : "transparent"}` }}>
                {label}
              </button>
            ))}
          </div>
          {tab === "coverage" ? (
            <CoverageTab locations={staged} addLocation={stageLocation}
              removeLocation={unstageLocation} addBusy={false} addErr={addErr}
              scheduleRows={scheduleRows} setScheduleRows={setScheduleRows} />
          ) : tab === "capabilities" ? (
            <CapabilitiesTab capabilities={capabilities} setCapabilities={setCapabilities} />
          ) : tab === "notes" ? (
            <NotesTab note={note} setNote={setNote} />
          ) : (
            <ContactTab customerId={agent.id} />
          )}
        </div>
      </div>

      {tab === "coverage" && staged.length === 0 && (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>At least one location is required before saving.</div>
      )}
      {saveErr && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.danger }}>{saveErr}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4, borderTop: `1px solid ${T.border}` }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!valid || saving} onClick={handleSave}>Add Carrier Agent</Btn>
      </div>
    </div>
  );
};

// ─── Edit Carrier Agent — same shape, locations save immediately, schedule saves with header ──
const EditAgentModal = ({ init, onDone, onCancel }) => {
  const [agent, setAgent] = useState({ id: init.agentCustomerId || "", name: init.agentCustomerName || "" });
  const [note, setNote] = useState(init.note || "");
  const [tab, setTab] = useState("coverage");
  const [locations, setLocations] = useState(init.locations);
  const [capabilities, setCapabilities] = useState(init.capabilities || []);
  const [scheduleRows, setScheduleRows] = useState([]);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [pendingDiscard, setPendingDiscard] = useState(null);

  useEffect(() => {
    api.carrierAgents.schedule.get(init.id)
      .then(rows => setScheduleRows(rows.map(r => ({ days: r.days, startTime: r.startTime, endTime: r.endTime }))))
      .catch(() => setScheduleRows([]))
      .finally(() => setScheduleLoaded(true));
  }, [init.id]);

  const addLocation = async (loc, reset) => {
    setAddBusy(true); setAddErr(null);
    try {
      const res = await api.carrierAgents.addLocation(init.id,
        { locationType: loc.locationType, unlocode: loc.unlocode, countryIso2: loc.countryIso2 });
      setLocations(res.locations);
      reset();
      if (res.discarded?.length) {
        setPendingDiscard({
          countryLabel: loc.locationType === "country" ? `${loc.countryIso2}${loc.countryName ? ` (${loc.countryName})` : ""}` : null,
          discarded: res.discarded,
        });
      }
    } catch (e) { setAddErr(e.message); }
    setAddBusy(false);
  };
  const removeLocation = (_, loc) => setConfirmRemove(loc.id);
  const confirmRemoveLocation = async id => {
    await api.carrierAgents.removeLocation(id);
    setLocations(locations.filter(l => l.id !== id));
    setConfirmRemove(null);
  };

  const handleSave = async () => {
    setSaving(true); setSaveErr(null);
    try {
      await api.carrierAgents.update(init.id, { agentCustomerId: agent.id, note, capabilities });
      await api.carrierAgents.schedule.put(init.id, scheduleRows);
      onDone();
    } catch (e) { setSaveErr(e.message); setSaving(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 16px" }}>
            <div style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{init.carrierCode}</div>
          </div>
          <CustomerCombobox label="Agent (Customer)" value={agent} onChange={setAgent} required />
        </div>
        <div>
          <div style={{ display: "flex", gap: 18, borderBottom: `1px solid ${T.border}`, marginBottom: 14 }}>
            {[["coverage", "Coverage"], ["capabilities", "Capabilities"], ["notes", "Notes"], ["contact", "Address & Contact"]].map(([key, label]) => (
              <button key={key} type="button" onClick={() => setTab(key)}
                style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, background: "none", border: "none",
                  padding: "0 0 10px", cursor: "pointer",
                  color: tab === key ? T.accent : T.textMuted,
                  borderBottom: `2px solid ${tab === key ? T.accent : "transparent"}` }}>
                {label}
              </button>
            ))}
          </div>
          {tab === "coverage" ? (
            scheduleLoaded ? (
              <CoverageTab locations={locations} addLocation={addLocation}
                removeLocation={removeLocation} addBusy={addBusy} addErr={addErr}
                scheduleRows={scheduleRows} setScheduleRows={setScheduleRows} />
            ) : <div style={{ padding: 20, textAlign: "center" }}><PageSpinner /></div>
          ) : tab === "capabilities" ? (
            <CapabilitiesTab capabilities={capabilities} setCapabilities={setCapabilities} />
          ) : tab === "notes" ? (
            <NotesTab note={note} setNote={setNote} />
          ) : (
            <ContactTab customerId={agent.id} />
          )}
        </div>
      </div>

      {saveErr && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.danger }}>{saveErr}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4, borderTop: `1px solid ${T.border}` }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!agent.id || saving} onClick={handleSave}>Save</Btn>
      </div>

      {confirmRemove && (
        <ConfirmModal
          message="Remove this location from the Line Agent? Shipments already assigned it keep their current party — only future auto-resolution is affected."
          onConfirm={() => confirmRemoveLocation(confirmRemove)}
          onCancel={() => setConfirmRemove(null)} />
      )}
      {pendingDiscard && (
        <Modal title="Locations Automatically Updated" onClose={() => setPendingDiscard(null)} width={440}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.6, margin: 0 }}>
              {pendingDiscard.countryLabel
                ? <>Adding <strong>{pendingDiscard.countryLabel}</strong> already covers every port in that country, so the</>
                : "The"} following specific UN/LOCODE{pendingDiscard.discarded.length !== 1 ? "s" : ""} — now redundant
              — {pendingDiscard.discarded.length !== 1 ? "were" : "was"} automatically removed:
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {pendingDiscard.discarded.map(u => <Badge key={u}>{u}</Badge>)}
            </div>
            <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: 0 }}>
              This change is recorded in the location's history — nothing was silently lost.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Btn onClick={() => setPendingDiscard(null)}>Got it</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

const MdmCarrierAgentsPage = () => {
  const { canManageMdm } = useAuth();
  const [agents,  setAgents]  = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [limit,   setLimit]   = useState(getStoredPageSize);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | agent header obj (edit)
  const [confirm, setConfirm] = useState(null); // header id to delete
  const [discardNotice, setDiscardNotice] = useState(null); // { discarded: [] } | null — from Add
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
            {/* Read-only display — every add/remove happens inside the Edit modal */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {a.locations.length === 0 ? (
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.border, fontStyle: "italic" }}>No locations</span>
              ) : a.locations.map(loc => (
                <span key={loc.id} style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                  color: loc.type === "country" ? T.accent : T.text,
                  background: loc.type === "country" ? `${T.accent}18` : T.bg,
                  border: `1px solid ${loc.type === "country" ? T.accent + "55" : T.border}`,
                  borderRadius: 6, padding: "2px 8px" }}>
                  {loc.type === "country" ? `🌐 ${loc.countryIso2}` : loc.unlocode}
                </span>
              ))}
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
        <Modal title="Add Carrier Agent" onClose={() => setModal(null)} width={920}>
          <AddAgentModal
            onDone={discarded => { setModal(null); load(); if (discarded.length) setDiscardNotice({ discarded }); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Carrier Agent" onClose={() => setModal(null)} width={920}>
          <EditAgentModal init={modal}
            onDone={() => { setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message="Remove this carrier agent entirely, including every location configured under it? Shipments already assigned it keep their current party — only future auto-resolution is affected."
          onConfirm={async () => { await api.carrierAgents.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
      {discardNotice && (
        <Modal title="Locations Automatically Updated" onClose={() => setDiscardNotice(null)} width={440}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.6, margin: 0 }}>
              One of the countries you added already covers every port in it, so the following specific
              UN/LOCODE{discardNotice.discarded.length !== 1 ? "s" : ""} — now redundant —{" "}
              {discardNotice.discarded.length !== 1 ? "were" : "was"} automatically left out:
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {discardNotice.discarded.map(u => <Badge key={u}>{u}</Badge>)}
            </div>
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
