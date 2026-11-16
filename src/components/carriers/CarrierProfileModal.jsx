import { useState, useEffect, useCallback } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import { Inp, Sel, Field } from "../primitives/Form";
import { Modal, ConfirmModal } from "../primitives/Modal";
import PortField from "../shared/PortField";
import CountryCombobox from "../shared/CountryCombobox";

// ─── Carrier profile (carrier offices, 2026-11-16, ARCHITECTURE.md §8.53; mockup 8a2ab3bd) ─────────────────────
// Master Data → Carriers → a carrier: its own offices and subsidiaries, which office acts where (Coverage: a port or a
// country, export or import, booking / import office / billing — a port beats its country, per role), our customer
// number at the carrier per legal entity of ours, and its connection. Replaces the Carrier Agents list: the carrier's
// offices are kept on the carrier's own record, as CargoWise, SAP and Oracle keep them.

export const ROLE_LABEL = { booking: "Booking", import: "Import office", billing: "Billing" };
export const CAPABILITY_OPTIONS = [
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
const SCHEDULE_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TABS = [["offices", "Offices"], ["coverage", "Coverage"], ["accounts", "Our account numbers"], ["connection", "Connection"]];
const UNLOCODE = /^[A-Z]{2}[A-Z2-9]{3}$/;

const roleColor = role => (role === "booking" ? T.accent : role === "billing" ? (T.warning || T.accent) : (T.info || T.textMuted));
const muted = () => ({ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, lineHeight: 1.55 });
const th = () => ({ textAlign: "left", padding: "8px 10px", fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted,
  textTransform: "uppercase", letterSpacing: ".08em", borderBottom: `1px solid ${T.border}` });
const td = () => ({ padding: "9px 10px", fontFamily: T.body, fontSize: 13, color: T.text, borderBottom: `1px solid ${T.border}22`, verticalAlign: "top" });
const sub = () => ({ display: "block", fontSize: 11.5, color: T.textMuted, marginTop: 2 });
const tag = () => ({ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent });

// ─── Working hours: day groups + an hour range; a day belongs to one row ───────────────────────────────
export const HoursEditor = ({ rows, setRows }) => {
  const toggleDay = (rowIdx, day) => setRows(rows.map((r, i) => (i === rowIdx
    ? { ...r, days: r.days.includes(day) ? r.days.filter(d => d !== day) : [...r.days, day] }
    : { ...r, days: r.days.filter(d => d !== day) })));
  const setTime = (i, f, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [f]: v } : r)));
  const used = new Set(rows.flatMap(r => r.days));
  const off = SCHEDULE_DAYS.filter(d => !used.has(d));
  return (
    <div style={{ display: "grid", gap: 8 }} data-testid="carrier-office-hours">
      {rows.map((row, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
            {SCHEDULE_DAYS.map(day => (
              <button key={day} type="button" onClick={() => toggleDay(i, day)} aria-pressed={row.days.includes(day)}
                style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 700, borderRadius: 5, padding: "3px 7px", cursor: "pointer",
                  color: row.days.includes(day) ? T.bg : T.textMuted, background: row.days.includes(day) ? T.accent : T.bg,
                  border: `1px solid ${row.days.includes(day) ? T.accent : T.border}` }}>{day}</button>
            ))}
          </div>
          {["startTime", "endTime"].map(f => (
            <input key={f} type="time" value={row[f]} onChange={e => setTime(i, f, e.target.value)} aria-label={f === "startTime" ? "Opens" : "Closes"}
              style={{ width: 120, padding: "5px 8px", fontSize: 12.5, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontFamily: T.body }} />
          ))}
          <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove this row"
            style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 16 }}>×</button>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={muted()}>{off.length === 0 ? "Open every day." : `${off.join(", ")}: closed.`}</span>
        <Btn size="sm" variant="secondary" onClick={() => setRows([...rows, { days: [], startTime: "09:00", endTime: "18:00" }])}>＋ Add Hours</Btn>
      </div>
    </div>
  );
};

// ─── One office: add or edit ───────────────────────────────────────────────────────────────
const blankOffice = { name: "", unlocode: "", address1: "", address2: "", city: "", postalCode: "", countryIso2: "", contactName: "",
  contactPhone: "", contactEmail: "", creditorCode: "", capabilities: [], note: "", isActive: true, hours: [] };

export const OfficeForm = ({ carrierCode, init, onSaved, onCancel }) => {
  const [f, setF] = useState(() => ({ ...blankOffice, ...(init || {}), hours: (init?.hours || []).map(h => ({ days: h.days, startTime: h.startTime, endTime: h.endTime })) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const loc = String(f.unlocode || "").toUpperCase();
  const valid = f.name.trim().length > 0 && UNLOCODE.test(loc);
  const toggleCap = code => setF(p => ({ ...p, capabilities: p.capabilities.includes(code) ? p.capabilities.filter(c => c !== code) : [...p.capabilities, code] }));
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true); setError("");
    const body = { ...f, unlocode: loc, countryIso2: String(f.countryIso2 || "").toUpperCase() };
    try {
      const saved = init?.id ? await api.carrierProfile.updateOffice(init.id, body) : await api.carrierProfile.createOffice(carrierCode, body);
      toast.success(init?.id ? `${saved.name} saved` : `${saved.name} added`);
      onSaved(saved);
    } catch (e) { setError(e.message || "Couldn't save the office"); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={init?.id ? `Edit ${init.name}` : `Add an office of ${carrierCode}`} onClose={onCancel} width={640} data-testid="carrier-office-form">
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
          <Inp id="co-name" label="Office name" value={f.name} onChange={set("name")} placeholder="Hapag-Lloyd Barcelona" required maxLength={70} />
          <Inp id="co-unlocode" label="Location (UN/LOCODE)" value={f.unlocode} onChange={v => set("unlocode")(v.toUpperCase())} placeholder="ESBCN" mono maxLength={5} required
            hint="Where the office is (any UN/LOCODE, e.g. ESMAD for Madrid)" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp id="co-address1" label="Street" value={f.address1} onChange={set("address1")} maxLength={70} />
          <Inp id="co-address2" label="Street (line 2)" value={f.address2} onChange={set("address2")} maxLength={70} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
          <Inp id="co-city" label="City" value={f.city} onChange={set("city")} maxLength={35} />
          <Inp id="co-postal" label="Postcode" value={f.postalCode} onChange={set("postalCode")} maxLength={10} />
          <Inp id="co-country" label="Country" value={f.countryIso2} onChange={v => set("countryIso2")(v.toUpperCase())} mono maxLength={2} placeholder="ES" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Inp id="co-contact" label="Contact" value={f.contactName} onChange={set("contactName")} maxLength={35} placeholder="Bookings desk" />
          <Inp id="co-phone" label="Phone" value={f.contactPhone} onChange={set("contactPhone")} maxLength={30} />
          <Inp id="co-email" label="E-mail" value={f.contactEmail} onChange={set("contactEmail")} maxLength={100} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
          <Inp id="co-creditor" label="Creditor code" value={f.creditorCode} onChange={set("creditorCode")} mono maxLength={40}
            hint="How our finance system knows this office when it bills us (GL Export's Counterparty)" />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: T.body, fontSize: 13, color: T.text, paddingBottom: 8 }}>
            <input id="co-active" type="checkbox" checked={f.isActive} onChange={e => set("isActive")(e.target.checked)} />
            Active (an inactive office isn't picked any more; shipments and invoices keep its name)
          </label>
        </div>
        <Field label="What it can do">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px" }}>
            {CAPABILITY_OPTIONS.map(o => (
              <label key={o.code} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: T.body, fontSize: 12.5, color: T.text, padding: "3px 0" }}>
                <input type="checkbox" checked={f.capabilities.includes(o.code)} onChange={() => toggleCap(o.code)} data-testid={`co-cap-${o.code}`} />{o.label}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Working hours"><HoursEditor rows={f.hours} setRows={set("hours")} /></Field>
        <Inp id="co-note" label="Note" value={f.note} onChange={set("note")} maxLength={500} />
        {error && <div role="alert" style={{ fontFamily: T.body, fontSize: 12.5, color: T.danger }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn onClick={save} disabled={!valid || busy} data-testid="carrier-office-save">{busy ? "Saving…" : init?.id ? "Save Office" : "Add Office"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Tabs ─────────────────────────────────────────────────────────────────────────────
const OfficesTab = ({ profile, canEdit, onEdit, onAdd, onRemove }) => (
  <div style={{ display: "grid", gap: 12 }}>
    <p style={muted()}>The carrier's own offices and subsidiaries, kept here (not in Customers). An office's location is any UN/LOCODE: an inland
      office such as Madrid (ESMAD) isn't a port.</p>
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }} data-testid="carrier-offices-table">
        <thead><tr>{["Office", "Location", "Contact", "Creditor code", "Covers", ""].map(h => <th key={h} style={th()}>{h}</th>)}</tr></thead>
        <tbody>
          {profile.offices.length === 0 && (
            <tr><td colSpan={6} style={{ ...td(), color: T.textMuted, textAlign: "center", padding: 24 }}>No offices yet. Add the carrier's offices, then say where each acts on Coverage.</td></tr>
          )}
          {profile.offices.map(o => {
            const rows = profile.coverage.filter(c => c.officeId === o.id);
            return (
              <tr key={o.id} data-testid={`carrier-office-row-${o.id}`} style={{ opacity: o.isActive ? 1 : 0.55 }}>
                <td style={td()}><b>{o.name}</b>{!o.isActive && <span style={{ ...sub(), display: "inline", marginLeft: 6 }}>inactive</span>}
                  <span style={sub()}>{[o.address1, o.city, o.countryIso2].filter(Boolean).join(", ") || "No address"}</span></td>
                <td style={td()}><span style={tag()}>{o.unlocode || "—"}</span></td>
                <td style={td()}>{o.contactName || "—"}<span style={sub()}>{[o.contactPhone, o.contactEmail].filter(Boolean).join(" · ")}</span></td>
                <td style={{ ...td(), fontFamily: T.mono }}>{o.creditorCode || <span style={{ color: T.textMuted, fontFamily: T.body }}>Not set</span>}</td>
                <td style={td()}>{rows.length ? `${rows.length} row${rows.length === 1 ? "" : "s"}` : <span style={{ color: T.textMuted }}>Nothing yet</span>}</td>
                <td style={{ ...td(), whiteSpace: "nowrap", textAlign: "right" }}>
                  {canEdit && <Btn size="sm" variant="secondary" onClick={() => onEdit(o)} data-testid={`carrier-office-edit-${o.id}`}>Edit</Btn>}
                  {canEdit && <button type="button" onClick={() => onRemove(o)} aria-label={`Remove ${o.name}`} data-testid={`carrier-office-remove-${o.id}`}
                    style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 16, marginLeft: 6 }}>×</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    {canEdit && <div><Btn onClick={onAdd} data-testid="carrier-office-add">＋ Add Office</Btn></div>}
  </div>
);

const CheckBox = ({ label, r }) => (
  <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", display: "grid", gap: 3, background: T.bg }}>
    <span style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em" }}>{label}</span>
    {r?.officeName ? (
      <>
        <b style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{r.officeName}</b>
        <span style={{ fontFamily: T.body, fontSize: 11.5, color: r.fallback ? (T.warning || T.textMuted) : T.textMuted }}>{r.officeUnlocode} · {r.why}</span>
      </>
    ) : r?.candidates?.length ? (
      <span style={{ fontFamily: T.body, fontSize: 12, color: T.warning || T.textMuted }}>{r.candidates.length} offices via linked ports: picked on the shipment</span>
    ) : <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>None</span>}
  </div>
);

const CoverageTab = ({ carrierCode, profile, canEdit, reload }) => {
  const active = profile.offices.filter(o => o.isActive);
  const [placeType, setPlaceType] = useState("unlocode");
  const [port, setPort] = useState(null);
  const [country, setCountry] = useState(null);
  const [direction, setDirection] = useState("export");
  const [role, setRole] = useState("booking");
  const [officeId, setOfficeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pol, setPol] = useState(null);
  const [pod, setPod] = useState(null);
  const [result, setResult] = useState(null);
  const roles = direction === "export" ? ["booking", "billing"] : ["import", "billing"];
  useEffect(() => { if (!roles.includes(role)) setRole(roles[0]); }, [direction]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pol?.unlocode && !pod?.unlocode) { setResult(null); return; }
    let live = true;
    api.carrierProfile.check(carrierCode, { pol: pol?.unlocode || "", pod: pod?.unlocode || "" }).then(r => { if (live) setResult(r); }).catch(() => {});
    return () => { live = false; };
  }, [carrierCode, pol?.unlocode, pod?.unlocode, profile]);
  const place = placeType === "unlocode" ? port?.unlocode : country?.iso2;
  const add = async () => {
    if (!place || !officeId || busy) return;
    setBusy(true); setError("");
    try {
      await api.carrierProfile.addCoverage(carrierCode, { placeType, unlocode: port?.unlocode, countryIso2: country?.iso2, direction, role, officeId });
      toast.success("Coverage added");
      setPort(null); setCountry(null);
      await reload();
    } catch (e) { setError(e.message || "Couldn't add the row"); }
    finally { setBusy(false); }
  };
  const change = async (row, id) => {
    try { await api.carrierProfile.updateCoverage(row.id, { officeId: id }); await reload(); }
    catch (e) { toast.error(e.message || "Couldn't change the office"); }
  };
  const remove = async row => {
    try { await api.carrierProfile.removeCoverage(row.id); await reload(); }
    catch (e) { toast.error(e.message || "Couldn't remove the row"); }
  };
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p style={muted()}>Which office acts where. A port beats its country, for each role. Booking covers exports only and the import office imports only;
        billing (the company that invoices us) exists on both sides. With no billing row, the booking office bills the export side and the import office
        the import side. Shipments already set up keep their offices.</p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }} data-testid="carrier-coverage-table">
          <thead><tr>{["Port or country", "Direction", "Role", "Office", ""].map(h => <th key={h} style={th()}>{h}</th>)}</tr></thead>
          <tbody>
            {profile.coverage.length === 0 && (
              <tr><td colSpan={5} style={{ ...td(), color: T.textMuted, textAlign: "center", padding: 20 }}>No coverage yet: no shipment gets an office of this carrier.</td></tr>
            )}
            {profile.coverage.map(c => (
              <tr key={c.id} data-testid={`carrier-coverage-row-${c.id}`}>
                <td style={td()}><span style={tag()}>{c.place}</span><span style={sub()}>{c.placeType === "country" ? `${c.placeName || ""} (country)` : c.placeName}</span></td>
                <td style={td()}>{c.direction === "export" ? "Export" : "Import"}</td>
                <td style={td()}><span style={{ fontWeight: 600, color: roleColor(c.role) }}>{ROLE_LABEL[c.role]}</span></td>
                <td style={td()}>
                  {canEdit ? (
                    <select value={c.officeId} onChange={e => change(c, e.target.value)} aria-label={`Office for ${c.place} ${c.direction} ${ROLE_LABEL[c.role]}`}
                      style={{ fontFamily: T.body, fontSize: 13, padding: "4px 8px", background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6 }}>
                      {profile.offices.filter(o => o.isActive || o.id === c.officeId).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  ) : c.officeName}
                </td>
                <td style={{ ...td(), textAlign: "right" }}>
                  {canEdit && <button type="button" onClick={() => remove(c)} aria-label="Remove this row" data-testid={`carrier-coverage-remove-${c.id}`}
                    style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 16 }}>×</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, display: "grid", gap: 12 }} data-testid="carrier-coverage-add">
          <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.text }}>Add coverage</div>
          {active.length === 0 ? <span style={muted()}>Add an office first (Offices tab).</span> : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 12, alignItems: "end" }}>
                <Sel id="cov-place-type" label="Where" value={placeType} onChange={setPlaceType}
                  options={[{ value: "unlocode", label: "A port" }, { value: "country", label: "A whole country" }]} />
                {placeType === "unlocode"
                  ? <PortField label="Port" value={port} onChange={setPort} placeholder="Search ports (ESBCN, Barcelona…)" />
                  : <Field label="Country"><CountryCombobox placeholder="Search countries…" onSelect={setCountry} />
                      {country && <span style={{ ...sub(), marginTop: 6 }}><span style={tag()}>{country.iso2}</span> {country.name}</span>}</Field>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: 12 }}>
                <Sel id="cov-direction" label="Direction" value={direction} onChange={setDirection}
                  options={[{ value: "export", label: "Export (port of loading)" }, { value: "import", label: "Import (port of discharge)" }]} />
                <Sel id="cov-role" label="Role" value={role} onChange={setRole} options={roles.map(r => ({ value: r, label: ROLE_LABEL[r] }))} />
                <Sel id="cov-office" label="Office" value={officeId} onChange={setOfficeId}
                  options={[{ value: "", label: "Pick an office…" }, ...active.map(o => ({ value: o.id, label: `${o.name} (${o.unlocode})` }))]} />
              </div>
              {error && <div role="alert" style={{ fontFamily: T.body, fontSize: 12.5, color: T.danger }}>{error}</div>}
              <div><Btn onClick={add} disabled={!place || !officeId || busy} data-testid="carrier-coverage-add-btn">＋ Add Coverage</Btn></div>
            </>
          )}
        </div>
      )}
      <div style={{ display: "grid", gap: 10 }} data-testid="carrier-coverage-check">
        <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.text }}>Check a route</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <PortField label="Port of loading" value={pol} onChange={setPol} placeholder="ESBCN…" />
          <PortField label="Port of discharge" value={pod} onChange={setPod} placeholder="USNYC…" />
        </div>
        {result && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
            <CheckBox label="Booking office" r={result.booking} />
            <CheckBox label="Billing · origin" r={result.billing_origin} />
            <CheckBox label="Import office" r={result.import} />
            <CheckBox label="Billing · destination" r={result.billing_destination} />
          </div>
        )}
      </div>
    </div>
  );
};

const AccountsTab = ({ carrierCode, profile, canEdit, reload }) => {
  const [listName, setListName] = useState(profile.codeListName || "");
  const [numbers, setNumbers] = useState(() => profile.accountNumbers.filter(a => a.accountNumber).map(a => ({ branchId: a.branchId, accountNumber: a.accountNumber })));
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const byId = Object.fromEntries(profile.accountNumbers.map(a => [a.branchId, a]));
  const unused = profile.accountNumbers.filter(a => !numbers.some(n => n.branchId === a.branchId));
  const save = async () => {
    setBusy(true);
    try {
      await api.carrierProfile.saveAccountNumbers(carrierCode, { codeListName: listName, numbers });
      toast.success("Account numbers saved");
      await reload();
    } catch (e) { toast.error(e.message || "Couldn't save"); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={muted()}>Our customer number at {carrierCode}, per legal entity of ours. A booking carries the number of the legal entity behind the
        shipment's export office, on the booking agent (DCSA identifyingCodes, provider ZZZ: Maersk checks it since its Booking v2). Only the entities
        that book with this carrier need one.</p>
      <Inp id="acc-list-name" label="Code list name, as the carrier names it (optional)" value={listName} onChange={setListName} maxLength={100}
        placeholder="e.g. maerskCustomerCode" disabled={!canEdit} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }} data-testid="carrier-accounts-table">
          <thead><tr>{["Our legal entity", "Country", `Our customer number at ${carrierCode}`, ""].map(h => <th key={h} style={th()}>{h}</th>)}</tr></thead>
          <tbody>
            {numbers.length === 0 && <tr><td colSpan={4} style={{ ...td(), color: T.textMuted, textAlign: "center", padding: 18 }}>No numbers yet: bookings go without one.</td></tr>}
            {numbers.map((n, i) => (
              <tr key={n.branchId} data-testid={`carrier-account-row-${n.branchId}`}>
                <td style={td()}>{byId[n.branchId]?.branchName || n.branchId}<span style={sub()}>{byId[n.branchId]?.branchCode}</span></td>
                <td style={td()}>{byId[n.branchId]?.countryCode || ""}</td>
                <td style={td()}>
                  <input value={n.accountNumber} disabled={!canEdit} aria-label={`Customer number for ${byId[n.branchId]?.branchName || n.branchId}`}
                    onChange={e => setNumbers(numbers.map((x, j) => (j === i ? { ...x, accountNumber: e.target.value } : x)))} maxLength={150}
                    style={{ width: "100%", fontFamily: T.mono, fontSize: 13, padding: "5px 8px", background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6 }} />
                </td>
                <td style={{ ...td(), textAlign: "right" }}>
                  {canEdit && <button type="button" onClick={() => setNumbers(numbers.filter((_, j) => j !== i))} aria-label="Remove this number"
                    style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 16 }}>×</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
          <div style={{ minWidth: 280, flex: 1 }}>
            <Sel id="acc-add-entity" label="Add a legal entity" value={adding} onChange={setAdding}
              options={[{ value: "", label: "Pick one of our legal entities…" }, ...unused.map(a => ({ value: a.branchId, label: `${a.branchName} (${a.countryCode})` }))]} />
          </div>
          <Btn variant="secondary" disabled={!adding} onClick={() => { setNumbers([...numbers, { branchId: adding, accountNumber: "" }]); setAdding(""); }}
            data-testid="carrier-account-add">＋ Add Legal Entity</Btn>
          <span style={{ flex: 1 }} />
          <Btn onClick={save} disabled={busy} data-testid="carrier-accounts-save">{busy ? "Saving…" : "Save Account Numbers"}</Btn>
        </div>
      )}
    </div>
  );
};

const ConnectionTab = ({ carrierCode, profile }) => (
  <div style={{ display: "grid", gap: 12 }}>
    <p style={muted()}>One connection per carrier (Master Data → Carrier Integrations). DCSA leaves authentication to each carrier and asks for one
      address per standard; what differs by country or legal entity is the account number, not the connection.</p>
    {profile.connection.length === 0 ? (
      <div style={{ ...muted(), border: `1px solid ${T.border}`, borderRadius: 8, padding: 12 }} data-testid="carrier-connection-none">
        {carrierCode} has no connection of its own: outside production the built-in DCSA demo carrier stands in.
      </div>
    ) : (
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["Adapter", "Active", "Can do"].map(h => <th key={h} style={th()}>{h}</th>)}</tr></thead>
        <tbody>{profile.connection.map(c => (
          <tr key={c.adapterKey}><td style={{ ...td(), fontFamily: T.mono }}>{c.adapterKey}</td><td style={td()}>{c.isActive ? "Yes" : "No"}</td>
            <td style={td()}>{(c.capabilities || []).join(", ") || "—"}</td></tr>
        ))}</tbody>
      </table>
    )}
  </div>
);

// ─── The profile ─────────────────────────────────────────────────────────────────────────
const CarrierProfileModal = ({ carrier, canEdit, initialTab = "offices", onClose }) => {
  const [tab, setTab] = useState(initialTab);
  const [profile, setProfile] = useState(null);
  const [editing, setEditing] = useState(null); // null | "new" | office
  const [confirm, setConfirm] = useState(null);
  const reload = useCallback(async () => {
    try { setProfile(await api.carrierProfile.get(carrier.code)); }
    catch (e) { toast.error(e.message || "Couldn't load the carrier's profile"); }
  }, [carrier.code]);
  useEffect(() => { reload(); }, [reload]);
  const removeOffice = async () => {
    const o = confirm; setConfirm(null);
    try { await api.carrierProfile.removeOffice(o.id); toast.success(`${o.name} removed`); await reload(); }
    catch (e) { toast.error(e.message || "Couldn't remove the office"); }
  };
  return (
    <Modal title={carrier.name} onClose={onClose} width={900} data-testid="carrier-profile-modal">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: -8, marginBottom: 6 }}>
        <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>Carrier code</span><span style={tag()}>{carrier.code}</span>
      </div>
      <div role="tablist" aria-label="Carrier profile" style={{ display: "flex", borderBottom: `1px solid ${T.border}`, marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" type="button" aria-selected={tab === key} onClick={() => setTab(key)} data-testid={`carrier-profile-tab-${key}`}
            style={{ padding: "8px 16px", fontFamily: T.body, fontSize: 13, fontWeight: tab === key ? 700 : 400, color: tab === key ? T.accent : T.textMuted,
              background: "transparent", border: "none", borderBottom: `2px solid ${tab === key ? T.accent : "transparent"}`, cursor: "pointer" }}>
            {label}{key === "offices" && profile ? ` (${profile.offices.length})` : key === "coverage" && profile ? ` (${profile.coverage.length})` : ""}
          </button>
        ))}
      </div>
      {!profile ? <div style={muted()}>Loading…</div> : (
        <>
          {tab === "offices" && <OfficesTab profile={profile} canEdit={canEdit} onEdit={setEditing} onAdd={() => setEditing("new")} onRemove={setConfirm} />}
          {tab === "coverage" && <CoverageTab carrierCode={carrier.code} profile={profile} canEdit={canEdit} reload={reload} />}
          {tab === "accounts" && <AccountsTab key={profile.accountNumbers.map(a => a.accountNumber).join("|") + profile.codeListName}
            carrierCode={carrier.code} profile={profile} canEdit={canEdit} reload={reload} />}
          {tab === "connection" && <ConnectionTab carrierCode={carrier.code} profile={profile} />}
        </>
      )}
      {editing && <OfficeForm carrierCode={carrier.code} init={editing === "new" ? null : editing}
        onSaved={async () => { setEditing(null); await reload(); }} onCancel={() => setEditing(null)} />}
      {confirm && <ConfirmModal message={`Remove ${confirm.name} from ${carrier.code}'s offices? An office still used by coverage, a shipment or a carrier invoice can only be set inactive.`}
        onConfirm={removeOffice} onCancel={() => setConfirm(null)} />}
    </Modal>
  );
};

export default CarrierProfileModal;
