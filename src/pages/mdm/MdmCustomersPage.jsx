import { useState, useEffect, useCallback, useRef } from "react";
import { T, CONTACT_DEPARTMENTS, CUSTOMER_ROLE_CATEGORIES } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { toast } from "../../toast";
import Spinner, { PageSpinner } from "../../components/primitives/Spinner";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import Pagination from "../../components/primitives/Pagination";
import ActionMenu from "../../components/primitives/ActionMenu";
import { inputBase, Inp, Sel, Textarea } from "../../components/primitives/Form";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";
import CustomerCombobox from "../../components/shared/CustomerCombobox";
import PortCombobox from "../../components/shared/PortCombobox";

// ─── Constants ────────────────────────────────────────────────────────────────

const ID_TYPES  = ["VAT", "EORI", "Tax ID", "DUNS", "GLN", "Customs Reg", "Other"];
const DOC_TYPES = ["KYC", "Commercial Contract", "Compliance Waiver", "Power of Attorney", "Other"];
const CURRENCIES = ["USD", "EUR", "GBP", "CNY", "SGD", "JPY", "AED", "CHF"];

// Country -> currency default (TKT-O5I4NK) — a Spain-based customer defaults to EUR rather
// than the old flat "always USD". Scoped to only the currencies CURRENCIES above actually
// offers (mirrors the backend's own copy, routes/customers.js — two copies since frontend/
// backend don't share a module, same split this app already uses for role/carrier constants).
// A country with no entry here just leaves today's plain "USD" default in place.
const COUNTRY_TO_CURRENCY = {
  US: "USD", GB: "GBP", CN: "CNY", HK: "CNY", SG: "SGD", JP: "JPY", AE: "AED", CH: "CHF", LI: "CHF",
  DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", BE: "EUR", PT: "EUR", AT: "EUR", IE: "EUR",
  FI: "EUR", GR: "EUR", LU: "EUR", SI: "EUR", SK: "EUR", EE: "EUR", LV: "EUR", LT: "EUR", MT: "EUR", CY: "EUR", HR: "EUR",
};

const SCREENING_VARIANT = { CLEAR: "success", HIT: "danger", OVERRIDDEN: "warning" };

function ScreeningBadge({ result }) {
  if (!result) return null;
  const label = result === "HIT" ? "⚠ OFAC Hit" : result === "OVERRIDDEN" ? "↩ Overridden" : "✓ Clear";
  return <Badge variant={SCREENING_VARIANT[result] || "default"}>{label}</Badge>;
}

// Role-derivation rework — roles are read-only, computed from actual shipment usage (see
// CUSTOMER_ROLE_USAGE_SQL, routes/customers.js). "Category" (Trading Customer vs Service
// Provider) is purely a frontend grouping for color-coding and the list-page segmented filter —
// the backend has no concept of it, only individual roles.
const isServiceProviderRole = role => CUSTOMER_ROLE_CATEGORIES["Service Providers"].includes(role);

function RoleBadge({ role }) {
  const color = isServiceProviderRole(role) ? T.purple : T.accent;
  return (
    <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color,
      background: `${color}18`, border: `1px solid ${color}44`, borderRadius: 4,
      padding: "2px 7px", whiteSpace: "nowrap" }}>{role}</span>
  );
}

function RoleBadgeList({ roles }) {
  if (!roles?.length) return <span style={{ color: T.border, fontFamily: T.body, fontSize: 12 }}>—</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {roles.map(r => <RoleBadge key={r} role={r} />)}
    </div>
  );
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function docIcon(mime) {
  if (!mime) return "📄";
  if (mime.includes("pdf")) return "📕";
  if (mime.includes("word") || mime.includes("msword")) return "📘";
  if (mime.includes("sheet") || mime.includes("excel")) return "📗";
  if (mime.includes("image")) return "🖼";
  return "📄";
}

// ─── Profile tab ──────────────────────────────────────────────────────────────

const ProfileTab = ({ init = {}, onSave, saving }) => {
  const [f, setF] = useState({
    companyName: init.companyName || "",
    address1:    init.address1    || "",
    address2:    init.address2    || "",
    city:        init.city        || "",
    state:       init.state       || "",
    postalCode:  init.postalCode  || "",
    countryIso2: init.countryIso2 || "",
    phone:       init.phone       || "",
    fax:         init.fax         || "",
    email:       init.email       || "",
    website:     init.website     || "",
    notes:       init.notes       || "",
    currency:    init.currency    || "USD",
    creditLimit:      init.creditLimit      != null ? String(init.creditLimit)      : "",
    creditTermsDays:  init.creditTermsDays  != null ? String(init.creditTermsDays)  : "",
    invoiceDeadlineDays: init.invoiceDeadlineDays != null ? String(init.invoiceDeadlineDays) : "",
    reminderEnabled:      init.reminderEnabled || false,
    reminderIntervalDays: init.reminderIntervalDays != null ? String(init.reminderIntervalDays) : "",
    creditHold:       init.creditHold       || false,
    creditHoldReason: init.creditHoldReason || "",
    parentCustomerId:   init.parentCustomerId   || "",
    parentCustomerName: init.parentCustomerName || "",
    classifiedLocation: init.classifiedLocation || false,
    latitude:           init.latitude  != null ? String(init.latitude)  : "",
    longitude:          init.longitude != null ? String(init.longitude) : "",
    isNvocc:            init.isNvocc || false,
    fmcNumber:          init.fmcNumber || "",
  });
  const set   = k => v => setF(p => ({ ...p, [k]: v }));
  const valid = f.companyName.trim().length > 0;

  // Country -> currency auto-suggestion (TKT-O5I4NK) — only while adding a brand-new
  // customer, and only until the operator actually touches Currency themselves. Never
  // retroactively changes an existing, already-saved customer's currency just because their
  // country field gets edited later — that would silently reinterpret a real credit_limit.
  const currencyTouched = useRef(!!init.id);
  const onCountryChange = v => {
    const cc = v.toUpperCase().slice(0, 2);
    setF(p => ({ ...p, countryIso2: cc,
      currency: !currencyTouched.current && COUNTRY_TO_CURRENCY[cc] ? COUNTRY_TO_CURRENCY[cc] : p.currency }));
  };

  // Roles — read-only, derived from actual shipment usage (role-derivation rework; see
  // CUSTOMER_ROLE_USAGE_SQL, routes/customers.js). Nothing to save here: the moment this
  // customer is assigned a role on any shipment, it shows up here automatically. Only shown
  // for an already-created customer — there's no usage history to derive yet while adding a
  // new one (mirrors why Identifiers/Compliance/Documents tabs are hidden for isNew too, one
  // level up in CustomerDetailModal).
  const [roles, setRoles] = useState(null);
  useEffect(() => {
    if (!init.id) { setRoles(null); return; }
    api.customers.roles.list(init.id).then(setRoles).catch(() => setRoles([]));
  }, [init.id]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Inp label="Company Name" value={f.companyName} onChange={set("companyName")}
        placeholder="Acme Freight B.V." required />

      <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".12em", marginBottom: -6 }}>Address</div>

      <Inp label="Address Line 1" value={f.address1} onChange={set("address1")} placeholder="Wilhelminakade 123" />
      <Inp label="Address Line 2" value={f.address2} onChange={set("address2")} placeholder="Suite 4B" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="City"             value={f.city}  onChange={set("city")}  placeholder="Rotterdam" />
        <Inp label="State / Province" value={f.state} onChange={set("state")} placeholder="South Holland" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Postal Code"    value={f.postalCode}  onChange={set("postalCode")}  placeholder="3072 AP" mono />
        <Inp label="Country (ISO2)" value={f.countryIso2}
          onChange={onCountryChange}
          placeholder="NL" mono maxLength={2} hint="2-letter ISO 3166-1" />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
        fontFamily: T.body, fontSize: 13, color: T.text, width: "fit-content" }}>
        <input type="checkbox" checked={f.classifiedLocation}
          onChange={e => set("classifiedLocation")(e.target.checked)} />
        Classified location — pickup/delivery can only be identified by GPS coordinates
      </label>
      {f.classifiedLocation && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp label="Latitude" value={f.latitude} onChange={set("latitude")}
            placeholder="52.3676" mono type="number" />
          <Inp label="Longitude" value={f.longitude} onChange={set("longitude")}
            placeholder="4.9041" mono type="number" />
        </div>
      )}

      <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".12em", marginBottom: -6 }}>Contact</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Phone" value={f.phone} onChange={set("phone")} placeholder="+31 10 123 4567" mono />
        <Inp label="Fax"   value={f.fax}   onChange={set("fax")}   placeholder="+31 10 123 4568" mono />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Email"   value={f.email}   onChange={set("email")}   placeholder="ops@acme-freight.com" />
        <Inp label="Website" value={f.website} onChange={set("website")} placeholder="https://acme-freight.com" />
      </div>

      <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".12em", marginBottom: -6 }}>Billing</div>

      <Sel label="Currency" value={f.currency}
        onChange={v => { currencyTouched.current = true; set("currency")(v); }}
        options={CURRENCIES.map(c => ({ value: c, label: c }))}
        hint={!init.id ? "Defaults from Country above — pick one to override it" : undefined} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label={`Credit Limit (${f.currency}, optional)`} value={f.creditLimit} onChange={set("creditLimit")}
          placeholder="Blank = no limit" mono type="number" hint="A real block once over — the trade lane's own manager can approve an override" />
        <Inp label="Credit Terms (days, optional)" value={f.creditTermsDays} onChange={set("creditTermsDays")}
          placeholder="e.g. 30" mono type="number" hint="Payment due this many days after invoicing" />
      </div>
      <Inp label="Invoice Generation Deadline (days, optional)" value={f.invoiceDeadlineDays} onChange={set("invoiceDeadlineDays")}
        placeholder="e.g. 5" mono type="number"
        hint="Flags a shipment (informational only, never a block) if it's still un-invoiced this many days after cargo delivery — some customers need same-day billing, others consolidate at month-end" />

      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
        fontFamily: T.body, fontSize: 13, color: T.text, width: "fit-content" }}>
        <input type="checkbox" checked={f.reminderEnabled}
          onChange={e => set("reminderEnabled")(e.target.checked)} />
        Send automated payment reminders for overdue invoices
      </label>
      {f.reminderEnabled && (
        <Inp label="Reminder Interval (days, optional)" value={f.reminderIntervalDays} onChange={set("reminderIntervalDays")}
          placeholder="Blank = send once, don't repeat" mono type="number"
          hint="How often to re-send once overdue — a same-day payer might want this aggressive, an end-of-month consolidator might want it left blank so they're not nagged before their own cycle" />
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
        fontFamily: T.body, fontSize: 13, color: T.text, width: "fit-content" }}>
        <input type="checkbox" checked={f.creditHold}
          onChange={e => set("creditHold")(e.target.checked)} />
        On credit hold — blocks generating new invoices for this customer
      </label>
      {f.creditHold && (
        <Inp label="Hold Reason" value={f.creditHoldReason} onChange={set("creditHoldReason")}
          placeholder="e.g. Overdue balance — awaiting payment on INV-4021" />
      )}

      <Textarea label="Notes" value={f.notes} onChange={set("notes")}
        placeholder="Internal notes, account manager, payment terms…" rows={3} />

      <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".12em", marginBottom: -6 }}>Hierarchy</div>

      <CustomerCombobox label="Parent Customer (optional)"
        value={{ id: f.parentCustomerId, name: f.parentCustomerName }}
        onChange={v => setF(p => ({ ...p, parentCustomerId: v.id, parentCustomerName: v.name }))} />
      <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginTop: -8 }}>
        For a branch or subsidiary booked under a larger group — lets margin/GP reporting roll
        this customer's figures up under its parent. Leave blank for a standalone customer.
      </div>

      <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".12em", marginBottom: -6 }}>NVOCC</div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
        fontFamily: T.body, fontSize: 13, color: T.text, width: "fit-content" }}>
        <input type="checkbox" checked={f.isNvocc}
          onChange={e => set("isNvocc")(e.target.checked)} />
        Operates as an NVOCC — eligible for the "NVOCC" party role on a shipment
      </label>
      {f.isNvocc && (
        <Inp label="FMC / License Number" value={f.fmcNumber} onChange={set("fmcNumber")}
          placeholder="e.g. 025555N" mono
          hint="FMC-issued NVOCC number (or the equivalent registration outside the US)" />
      )}

      {init.id && (
        <>
          <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
            textTransform: "uppercase", letterSpacing: ".12em", marginBottom: -6 }}>Roles</div>
          <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginTop: -6 }}>
            Computed from where this customer has actually been assigned on real shipments —
            updates itself the moment a new assignment happens, nothing to maintain here.
          </div>
          {roles === null ? <Spinner size="sm" /> : roles.length === 0 ? (
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
              Not yet used in any role.
            </div>
          ) : (
            <RoleBadgeList roles={roles} />
          )}
        </>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn disabled={!valid || saving} onClick={() => onSave(f)}>
          {saving ? "Saving…" : "Save Profile"}
        </Btn>
      </div>
    </div>
  );
};

// ─── Identifiers tab ──────────────────────────────────────────────────────────

const IdentifierForm = ({ init = {}, onSave, onCancel, saving }) => {
  const [f, setF] = useState({
    idType:      init.idType      || "VAT",
    idCode:      init.idCode      || "",
    countryIso2: init.countryIso2 || "",
    label:       init.label       || "",
    isPrimary:   init.isPrimary   || false,
  });
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted,
          textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Type</div>
        <select value={f.idType} onChange={e => set("idType")(e.target.value)}
          style={{ ...inputBase, width: "100%", cursor: "pointer" }}>
          {ID_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <Inp label="Code / Number" value={f.idCode} onChange={set("idCode")}
        placeholder="NL123456789B01" mono required />
      <Inp label="Country (ISO2)" value={f.countryIso2}
        onChange={v => set("countryIso2")(v.toUpperCase().slice(0,2))}
        placeholder="NL" mono maxLength={2} />
      <Inp label="Label (optional)" value={f.label} onChange={set("label")}
        placeholder="EU VAT — Netherlands" />
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
        fontFamily: T.body, fontSize: 13, color: T.text }}>
        <input type="checkbox" checked={f.isPrimary}
          onChange={e => set("isPrimary")(e.target.checked)} />
        Mark as primary for this type
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!f.idCode.trim() || saving} onClick={() => onSave(f)}>
          {saving ? "Saving…" : "Save"}
        </Btn>
      </div>
    </div>
  );
};

const IdentifiersTab = ({ customerId, canEdit }) => {
  const [items,   setItems]   = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [saving,  setSaving]  = useState(false);

  const load = useCallback(async () => {
    try { setItems(await api.customers.identifiers.list(customerId)); }
    catch (e) { toast.error(e.message); }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async f => {
    setSaving(true);
    try {
      if (editing === "new") await api.customers.identifiers.create(customerId, f);
      else await api.customers.identifiers.update(customerId, editing.id, f);
      setEditing(null); load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const handleDelete = async id => {
    try { await api.customers.identifiers.remove(customerId, id); setConfirm(null); load(); }
    catch (e) { toast.error(e.message); }
  };

  if (items === null) return <div style={{ padding: 24 }}><PageSpinner /></div>;

  return (
    <div>
      {canEdit && (
        <div style={{ marginBottom: 14 }}>
          <Btn size="sm" onClick={() => setEditing("new")}>＋ Add Identifier</Btn>
        </div>
      )}

      {items.length === 0 ? (
        <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body, fontSize: 13,
          color: T.textMuted, fontStyle: "italic" }}>
          No fiscal identifiers on file. Add VAT, EORI, or other IDs for this customer.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map(item => (
            <div key={item.id} style={{
              display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
              padding: "10px 14px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}`,
            }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                background: T.accentBg, color: T.accent, border: `1px solid ${T.accent}44`,
                borderRadius: 4, padding: "1px 7px" }}>{item.idType}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>
                {item.idCode}
              </span>
              {item.countryIso2 && (
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{item.countryIso2}</span>
              )}
              {item.label && (
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{item.label}</span>
              )}
              {item.isPrimary && (
                <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                  color: T.success, background: `${T.success}15`,
                  border: `1px solid ${T.success}44`, borderRadius: 4, padding: "1px 5px" }}>PRIMARY</span>
              )}
              {canEdit && (
                <div style={{ marginLeft: "auto" }}>
                  <ActionMenu items={[
                    { icon: "✎", label: "Edit",   onClick: () => setEditing(item) },
                    { icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(item.id) },
                  ]} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal title={editing === "new" ? "Add Identifier" : "Edit Identifier"}
          onClose={() => setEditing(null)} width={420}>
          <IdentifierForm init={editing === "new" ? {} : editing}
            onSave={handleSave} onCancel={() => setEditing(null)} saving={saving} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message="Remove this identifier?" onConfirm={() => handleDelete(confirm)} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── Contacts tab ─────────────────────────────────────────────────────────────
// Named people at this customer — replaces the old "cram it into notes" workaround
// (ProfileTab's Notes hint used to literally say "account manager, payment terms…").
// Mirrors IdentifiersTab/IdentifierForm's shape almost exactly.

const ContactForm = ({ init = {}, onSave, onCancel, saving }) => {
  const [f, setF] = useState({
    name:       init.name       || "",
    title:      init.title      || "",
    email:      init.email      || "",
    phone:      init.phone      || "",
    department: init.department || "Other",
    isPrimary:  init.isPrimary  || false,
  });
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Inp label="Name" value={f.name} onChange={set("name")} placeholder="Jane van der Berg" required />
      <Inp label="Title (optional)" value={f.title} onChange={set("title")} placeholder="Export Coordinator" />
      <div>
        <div style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted,
          textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Department</div>
        <select value={f.department} onChange={e => set("department")(e.target.value)}
          style={{ ...inputBase, width: "100%", cursor: "pointer" }}>
          {CONTACT_DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <Inp label="Email" value={f.email} onChange={set("email")} placeholder="jane@acme-freight.com" />
      <Inp label="Phone" value={f.phone} onChange={set("phone")} placeholder="+31 10 123 4567" mono />
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
        fontFamily: T.body, fontSize: 13, color: T.text }}>
        <input type="checkbox" checked={f.isPrimary}
          onChange={e => set("isPrimary")(e.target.checked)} />
        Mark as primary contact
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!f.name.trim() || saving} onClick={() => onSave(f)}>
          {saving ? "Saving…" : "Save"}
        </Btn>
      </div>
    </div>
  );
};

const ContactsTab = ({ customerId, canEdit }) => {
  const [items,   setItems]   = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [saving,  setSaving]  = useState(false);

  const load = useCallback(async () => {
    try { setItems(await api.customers.contacts.list(customerId)); }
    catch (e) { toast.error(e.message); }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async f => {
    setSaving(true);
    try {
      if (editing === "new") await api.customers.contacts.create(customerId, f);
      else await api.customers.contacts.update(customerId, editing.id, f);
      setEditing(null); load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const handleDelete = async id => {
    try { await api.customers.contacts.remove(customerId, id); setConfirm(null); load(); }
    catch (e) { toast.error(e.message); }
  };

  if (items === null) return <div style={{ padding: 24 }}><PageSpinner /></div>;

  return (
    <div>
      {canEdit && (
        <div style={{ marginBottom: 14 }}>
          <Btn size="sm" onClick={() => setEditing("new")}>＋ Add Contact</Btn>
        </div>
      )}

      {items.length === 0 ? (
        <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body, fontSize: 13,
          color: T.textMuted, fontStyle: "italic" }}>
          No contacts on file. Add the people you actually deal with at this customer.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map(item => (
            <div key={item.id} style={{
              display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
              padding: "10px 14px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}`,
            }}>
              <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text }}>
                {item.name}
              </span>
              {item.title && (
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{item.title}</span>
              )}
              <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                background: T.accentBg, color: T.accent, border: `1px solid ${T.accent}44`,
                borderRadius: 4, padding: "1px 6px" }}>{item.department}</span>
              {item.email && (
                <a href={`mailto:${item.email}`} style={{ fontFamily: T.body, fontSize: 12, color: T.accent, textDecoration: "none" }}>
                  {item.email}
                </a>
              )}
              {item.phone && (
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{item.phone}</span>
              )}
              {item.isPrimary && (
                <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                  color: T.success, background: `${T.success}15`,
                  border: `1px solid ${T.success}44`, borderRadius: 4, padding: "1px 5px" }}>PRIMARY</span>
              )}
              {canEdit && (
                <div style={{ marginLeft: "auto" }}>
                  <ActionMenu items={[
                    { icon: "✎", label: "Edit",   onClick: () => setEditing(item) },
                    { icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(item.id) },
                  ]} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal title={editing === "new" ? "Add Contact" : "Edit Contact"}
          onClose={() => setEditing(null)} width={420}>
          <ContactForm init={editing === "new" ? {} : editing}
            onSave={handleSave} onCancel={() => setEditing(null)} saving={saving} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message="Remove this contact?" onConfirm={() => handleDelete(confirm)} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── Compliance tab ───────────────────────────────────────────────────────────

const ComplianceTab = ({ customerId, canEdit }) => {
  const [screening, setScreening] = useState(undefined);
  const [running,   setRunning]   = useState(false);
  const [override,  setOverride]  = useState(false);
  const [reason,    setReason]    = useState("");
  const [saving,    setSaving]    = useState(false);

  const load = useCallback(async () => {
    try { setScreening(await api.customers.screening.get(customerId)); }
    catch { setScreening(null); }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  const handleRun = async () => {
    setRunning(true);
    try { setScreening(await api.customers.screening.run(customerId)); toast.success("Screening complete"); }
    catch (e) { toast.error(e.message); }
    setRunning(false);
  };

  const handleOverride = async () => {
    if (!reason.trim()) return;
    setSaving(true);
    try {
      setScreening(await api.customers.screening.override(customerId, { reason }));
      setOverride(false); setReason("");
      toast.success("Override filed");
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  if (screening === undefined) return <div style={{ padding: 24 }}><PageSpinner /></div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Status card */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".07em" }}>OFAC / SDN Status</span>
          {screening ? <ScreeningBadge result={screening.result} /> : <Badge variant="default">Not screened</Badge>}
        </div>
        {screening && (
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
            Last checked: {new Date(screening.screenedAt).toLocaleString("en-GB")}
            {screening.overriddenAt && (
              <span style={{ marginLeft: 14, color: T.warning }}>
                · Overridden {new Date(screening.overriddenAt).toLocaleString("en-GB")}
              </span>
            )}
          </div>
        )}
        {screening?.overrideReason && (
          <div style={{ marginTop: 8, fontFamily: T.body, fontSize: 12, color: T.text,
            background: `${T.warning}15`, border: `1px solid ${T.warning}44`, borderRadius: 6, padding: "8px 12px" }}>
            <strong>Override reason:</strong> {screening.overrideReason}
          </div>
        )}
        {canEdit && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Btn size="sm" variant="secondary" onClick={handleRun} disabled={running}>
              {running ? "Screening…" : "Re-screen Now"}
            </Btn>
            {screening?.result === "HIT" && !screening?.overriddenAt && (
              <Btn size="sm" variant="ghost" onClick={() => setOverride(true)}>File Override</Btn>
            )}
          </div>
        )}
      </div>

      {/* Hits */}
      {screening?.hits?.length > 0 && (
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.danger,
            textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>Matched Entries</div>
          {screening.hits.map((h, i) => (
            <div key={i} style={{ padding: "10px 14px", borderRadius: 7, marginBottom: 6,
              background: `${T.danger}0c`, border: `1px solid ${T.danger}33` }}>
              <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.danger }}>{h.entityName}</div>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                {h.program} · {h.source}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Override form */}
      {override && (
        <div style={{ background: `${T.warning}0c`, border: `1px solid ${T.warning}44`,
          borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 6 }}>
            File Compliance Override
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 10 }}>
            Document your reason for proceeding despite the OFAC match. Recorded for audit purposes.
          </div>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
            placeholder="e.g. Confirmed different entity — same name, different country. Ref: compliance ticket #4521."
            style={{ ...inputBase, width: "100%", boxSizing: "border-box", resize: "vertical" }} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
            <Btn variant="secondary" onClick={() => { setOverride(false); setReason(""); }}>Cancel</Btn>
            <Btn disabled={!reason.trim() || saving} onClick={handleOverride}>
              {saving ? "Filing…" : "File Override"}
            </Btn>
          </div>
        </div>
      )}

      {!screening && (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
          This customer has not been screened yet.{canEdit && " Click Re-screen to run an OFAC check now."}
        </div>
      )}
    </div>
  );
};

// ─── Documents tab ────────────────────────────────────────────────────────────

const DocumentsTab = ({ customerId, canEdit }) => {
  const [docs,      setDocs]      = useState(null);
  const [confirm,   setConfirm]   = useState(null);
  const [uploading, setUploading] = useState(false);
  const [docType,   setDocType]   = useState("KYC");
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try { setDocs(await api.customers.documents.list(customerId)); }
    catch (e) { toast.error(e.message); }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = ev => resolve(ev.target.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api.customers.documents.upload(customerId, {
        filename: file.name, mimeType: file.type, docType, data,
      });
      toast.success("Document uploaded");
      load();
    } catch (ex) { toast.error(ex.message); }
    setUploading(false);
    e.target.value = "";
  };

  const handleDelete = async did => {
    try { await api.customers.documents.remove(customerId, did); setConfirm(null); load(); }
    catch (e) { toast.error(e.message); }
  };

  const handleDownload = doc => {
    const a = document.createElement("a");
    a.href     = api.customers.documents.downloadUrl(customerId, doc.id);
    a.download = doc.filename;
    a.click();
  };

  if (docs === null) return <div style={{ padding: 24 }}><PageSpinner /></div>;

  return (
    <div>
      {canEdit && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <select value={docType} onChange={e => setDocType(e.target.value)}
            style={{ ...inputBase, width: 200, cursor: "pointer" }}>
            {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <Btn size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "Uploading…" : "⬆ Upload Document"}
          </Btn>
          <input ref={fileRef} type="file" style={{ display: "none" }} onChange={handleUpload}
            accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" />
        </div>
      )}

      {docs.length === 0 ? (
        <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body, fontSize: 13,
          color: T.textMuted, fontStyle: "italic" }}>
          No documents on file. Upload KYC, contracts, or compliance waivers.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {docs.map(doc => (
            <div key={doc.id} style={{ display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 18 }}>{docIcon(doc.mimeType)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.filename}</div>
                <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, marginTop: 2 }}>
                  {doc.docType} · {fmtBytes(doc.sizeBytes)} · {doc.uploadedBy || "—"} · {new Date(doc.createdAt).toLocaleDateString("en-GB")}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <Btn size="sm" variant="ghost" onClick={() => handleDownload(doc)}>⬇</Btn>
                {canEdit && (
                  <Btn size="sm" variant="ghost" onClick={() => setConfirm(doc.id)}
                    style={{ color: T.danger }}>✕</Btn>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {confirm && (
        <ConfirmModal message="Remove this document?" onConfirm={() => handleDelete(confirm)} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── Billing Cycle tab (Epic TKT-G11AHW) ───────────────────────────────────────
// Direct follow-up: "the business day helper can be a section (sub tab) of the customer profile
// - would make more sense this way." Billing By Day / Payment Settlement Day are day-of-month
// integers (1-31), recurring — not literal calendar dates — per direct clarification, same shape
// as the existing Invoice Generation Deadline field on the Profile tab. Both genuinely optional;
// blank means the Invoice Collections sweep falls back to its own default 5/8-business-day
// thresholds. Saves via a full customer PUT (spreads the already-normalized `customer` prop so
// every other field round-trips unchanged) rather than a partial PATCH, matching ProfileTab's own
// save shape — this route has no partial-update variant.
const BillingCycleTab = ({ customer, canEdit, onUpdated }) => {
  const [billingByDay, setBillingByDay] = useState(customer.billingByDay != null ? String(customer.billingByDay) : "");
  const [paymentSettlementDay, setPaymentSettlementDay] = useState(customer.paymentSettlementDay != null ? String(customer.paymentSettlementDay) : "");
  const [holidayPort, setHolidayPort] = useState(customer.holidayUnlocode ? { unlocode: customer.holidayUnlocode, name: customer.holidayUnlocode } : null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.customers.update(customer.id, {
        ...customer,
        billingByDay: billingByDay === "" ? null : billingByDay,
        paymentSettlementDay: paymentSettlementDay === "" ? null : paymentSettlementDay,
        holidayUnlocode: holidayPort?.unlocode || "",
      });
      toast.success("Billing cycle saved");
      onUpdated(updated);
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, margin: 0, lineHeight: 1.6 }}>
        Both fields are optional and recur every month — not a one-off date. Leave either blank to
        fall back to the standard collections timeline.
      </p>
      <Inp label="Billing By Day (day of month, optional)" value={billingByDay} onChange={setBillingByDay}
        placeholder="e.g. 25" mono type="number" disabled={!canEdit}
        hint="The cutoff day of the month by which an invoice must be submitted to this customer to be included in that period's payment run" />
      <Inp label="Payment Settlement Day (day of month, optional)" value={paymentSettlementDay} onChange={setPaymentSettlementDay}
        placeholder="e.g. 30" mono type="number" disabled={!canEdit}
        hint="The day of the month this customer typically settles / pays invoices" />

      <div>
        <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.textMuted,
          textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>
          Public Holiday Location (placeholder)
        </div>
        {canEdit ? <PortCombobox value={holidayPort} onChange={setHolidayPort} placeholder="Search port or UN/LOCODE…" />
          : <div style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{holidayPort?.unlocode || "—"}</div>}
        <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginTop: 5, lineHeight: 1.5 }}>
          Public holiday calendar — not yet available. Would source this customer's public
          holidays from its UN/LOCODE once a data provider is picked (business-day math is Mon-Fri
          only for now).
        </div>
      </div>

      {canEdit && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Billing Cycle"}</Btn>
        </div>
      )}
    </div>
  );
};

// ─── Customer detail modal ────────────────────────────────────────────────────

const TABS = ["Profile", "Billing Cycle", "Contacts", "Identifiers", "Compliance", "Documents"];

const CustomerDetailModal = ({ customer, isNew, onClose, onUpdated }) => {
  const { canEdit } = useAuth();
  const [tab,    setTab]    = useState("Profile");
  const [saving, setSaving] = useState(false);

  const handleProfileSave = async form => {
    setSaving(true);
    try {
      const updated = isNew
        ? await api.customers.create(form)
        : await api.customers.update(customer.id, form);
      toast.success(isNew ? "Customer created" : "Profile saved");
      onUpdated(updated);
      if (isNew) onClose();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const tabs = isNew ? ["Profile"] : TABS;

  return (
    <Modal title={isNew ? "Add Customer" : customer.companyName} onClose={onClose} width={620}>
      {/* Tab bar */}
      {!isNew && (
        <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${T.border}`,
          marginBottom: 20, marginTop: -4 }}>
          {tabs.map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "8px 16px", fontFamily: T.body, fontSize: 13,
              fontWeight: tab === t ? 700 : 400,
              color: tab === t ? T.accent : T.textMuted,
              background: "transparent", border: "none",
              borderBottom: `2px solid ${tab === t ? T.accent : "transparent"}`,
              cursor: "pointer", transition: "color .15s",
            }}>{t}</button>
          ))}
          {customer.screeningResult && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", paddingRight: 4 }}>
              <ScreeningBadge result={customer.screeningResult} />
            </div>
          )}
        </div>
      )}

      {tab === "Profile"     && <ProfileTab     init={customer}           onSave={handleProfileSave} saving={saving} />}
      {tab === "Billing Cycle" && <BillingCycleTab customer={customer} canEdit={canEdit} onUpdated={onUpdated} />}
      {tab === "Contacts"    && <ContactsTab    customerId={customer.id} canEdit={canEdit} />}
      {tab === "Identifiers" && <IdentifiersTab  customerId={customer.id} canEdit={canEdit} />}
      {tab === "Compliance"  && <ComplianceTab   customerId={customer.id} canEdit={canEdit} />}
      {tab === "Documents"   && <DocumentsTab    customerId={customer.id} canEdit={canEdit} />}
    </Modal>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

const LIMIT = 50;

// Segmented list-page filter (role-derivation rework) — "All" omits the role param entirely;
// the other two segments send their category's roles as one comma-joined `role` filter, so the
// backend still only ever reasons about individual roles (see CUSTOMER_ROLE_USAGE_SQL).
const CATEGORIES = ["All", ...Object.keys(CUSTOMER_ROLE_CATEGORIES)];

const MdmCustomersPage = () => {
  const { canEdit } = useAuth();
  const [results,  setResults]  = useState([]);
  const [total,    setTotal]    = useState(0);
  const [offset,   setOffset]   = useState(0);
  const [search,   setSearch]   = useState("");
  const [category, setCategory] = useState("All");
  const [loading,  setLoading]  = useState(true);
  const [modal,    setModal]    = useState(null); // null | "new" | customer obj
  const [confirm,  setConfirm]  = useState(null);
  const timer = useRef(null);

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const cat = opts.category !== undefined ? opts.category : category;
      const res = await api.customers.list({
        search: opts.search !== undefined ? opts.search : search,
        ...(cat !== "All" ? { role: CUSTOMER_ROLE_CATEGORIES[cat].join(",") } : {}),
        limit:  LIMIT,
        offset: opts.offset !== undefined ? opts.offset : offset,
      });
      setResults(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [search, offset, category]);

  useEffect(() => { load(); }, []);

  const handleSearch = v => {
    setSearch(v); setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 300);
  };

  const handleCategory = cat => {
    setCategory(cat); setOffset(0);
    load({ category: cat, offset: 0 });
  };

  const goPage = off => { setOffset(off); load({ offset: off }); };

  const handleUpdated = updated => {
    setResults(prev => prev.map(c => c.id === updated.id ? updated : c));
    setModal(prev => prev && typeof prev === "object" && prev.id === updated.id ? updated : prev);
  };

  const handleDelete = async id => {
    try { await api.customers.remove(id); setConfirm(null); load(); }
    catch (e) { toast.error(e.message); }
  };

  const th = {
    position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
  };

  const { template, startResize } = useResizableColumns("mdm-customers", [220, 170, 120, 80, 150, 120, 90]);
  const headers = ["Company", "Roles", "City / Country", "Phone", "Email", "Website", "Actions"];

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>
            Customers
          </h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total} customer{total !== 1 ? "s" : ""} in registry
          </p>
        </div>
        {canEdit && <Btn size="lg" onClick={() => setModal("new")}>＋ Add Customer</Btn>}
      </div>

      {/* Segmented category filter */}
      <div style={{ display: "inline-flex", gap: 2, padding: 3, marginBottom: 12,
        background: T.bg, border: `1px solid ${T.border}`, borderRadius: 9 }}>
        {CATEGORIES.map(cat => (
          <button key={cat} onClick={() => handleCategory(cat)} style={{
            padding: "6px 14px", fontFamily: T.body, fontSize: 12.5,
            fontWeight: category === cat ? 700 : 500,
            color: category === cat ? T.btnPrimaryText : T.textMuted,
            background: category === cat ? T.accent : "transparent",
            border: "none", borderRadius: 6, cursor: "pointer", transition: "background .12s, color .12s",
          }}>{cat}</button>
        ))}
      </div>

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search company, city, email, phone…"
          style={{ ...inputBase, width: 320 }} />
      </div>

      {/* Table */}
      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: template,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}`, gap: 0 }}>
          {headers.map((h, i) => (
            <div key={i} style={th}>
              {h}
              {i < headers.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
            </div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 48 }}><PageSpinner /></div>
        ) : results.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted,
            fontFamily: T.body, fontSize: 14, fontStyle: "italic" }}>
            {search ? "No customers match your search."
              : category !== "All" ? `No customers used as a ${category === "Trading Customers" ? "trading customer" : "service provider"} role yet.`
              : "No customers yet. Add your first one above."}
          </div>
        ) : results.map(c => (
          <div key={c.id}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "13px 20px", borderBottom: `1px solid ${T.border}22`,
              alignItems: "center", gap: 0, cursor: "pointer", transition: "background .1s" }}
            onClick={() => setModal(c)}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>

            {/* Company + screening badge */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>
                  {c.companyName}
                </span>
                <ScreeningBadge result={c.screeningResult} />
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, marginTop: 2 }}>{c.id}</div>
            </div>

            {/* Roles */}
            <RoleBadgeList roles={c.roles} />

            {/* City / Country */}
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
              {[c.city, c.countryIso2].filter(Boolean).join(" · ") || "—"}
            </div>

            {/* Phone */}
            <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>
              {c.phone || <span style={{ color: T.border }}>—</span>}
            </div>

            {/* Email */}
            <div style={{ fontFamily: T.body, fontSize: 12, overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.email
                ? <a href={`mailto:${c.email}`} style={{ color: T.accent, textDecoration: "none" }}
                    onClick={e => e.stopPropagation()}>{c.email}</a>
                : <span style={{ color: T.border }}>—</span>}
            </div>

            {/* Website */}
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.website || <span style={{ color: T.border }}>—</span>}
            </div>

            {/* Actions */}
            <div style={{ display: "flex", justifyContent: "flex-end" }} onClick={e => e.stopPropagation()}>
              <ActionMenu items={[
                { icon: "✎", label: "Open", onClick: () => setModal(c) },
                ...(canEdit ? [{ icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(c.id) }] : []),
              ]} />
            </div>
          </div>
        ))}
      </div>

      {total > LIMIT && (
        <div style={{ marginTop: 16 }}>
          <Pagination total={total} limit={LIMIT} offset={offset} onPage={goPage} />
        </div>
      )}

      {modal && (
        <CustomerDetailModal
          customer={modal === "new" ? {} : modal}
          isNew={modal === "new"}
          onClose={() => { setModal(null); load(); }}
          onUpdated={handleUpdated}
        />
      )}

      {confirm && (
        <ConfirmModal
          message="Remove this customer and all associated identifiers, screenings, and documents?"
          onConfirm={() => handleDelete(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
};

export default MdmCustomersPage;
