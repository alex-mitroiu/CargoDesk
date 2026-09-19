import { useState, useEffect, useCallback } from "react";
import { T, CURRENCIES } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import { useAuth } from "../AuthContext";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import { Field, Sel } from "../components/primitives/Form";
import { inputBase } from "../components/primitives/Form";
import DatePicker from "../components/primitives/DatePicker";
import Spinner from "../components/primitives/Spinner";
import DataTable, { TableToolbar } from "../components/shared/DataTable";
import useTableQuery from "../hooks/useTableQuery";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import CustomerCombobox from "../components/shared/CustomerCombobox";
import PortField from "../components/shared/PortField";
import { CommodityCombobox } from "../components/shared/CommodityCombobox";
import { IconFlag, IconEye, IconClose } from "../components/primitives/Icon";

// ─── CRM / pre-sales pipeline ────────────────────────────────────────────────
// An opportunity is a lead-tracking record that precedes and converts into a Quote — New (freely
// editable) -> Qualified (still editable) -> Converted (to Quote, Qualified only) | Lost (from
// New or Qualified). No separate "Won" status — Converted IS the win condition; whether the
// resulting quote then actually closes is the Quote's own already-shipped lifecycle to own from
// there. Deliberately no line-item pricing here — an opportunity is pre-pricing, real line-item
// detail belongs on the Quote it converts into. See routes/opportunities.js.

const STATUS_VARIANT = { New: "default", Qualified: "info", Converted: "success", Lost: "danger" };

const fmtUsd = v => v == null ? "—" : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MOVEMENT_TYPE_OPTIONS = [
  { value: "FCL", label: "FCL — Full Container Load" },
  { value: "LCL", label: "LCL — Less than Container Load" },
  { value: "BCO", label: "BCO — Beneficial Cargo Owner" },
];
const LEAD_SOURCE_OPTIONS = [
  "Referral", "Existing Customer", "Website Inquiry", "Trade Show", "Cold Outreach", "Partner", "Other",
];

// ─── Opportunity form modal (New + Edit-while-New/Qualified) ────────────────
const OpportunityFormModal = ({ opportunity, onClose, onSaved }) => {
  const isEdit = !!opportunity;
  const { activeOffice } = useAuth();
  const [offices, setOffices] = useState([]);
  const [officeId, setOfficeId] = useState(opportunity?.officeId || "");
  useEffect(() => { api.offices.list().then(setOffices).catch(() => {}); }, []);
  // Office visibility (User Management redesign, 2026-09-12) — same auto-default pattern
  // ShipmentFormPage.jsx/QuotesPage.jsx already use.
  useEffect(() => {
    if (isEdit) return;
    if (!activeOffice) return;
    setOfficeId(prev => prev || activeOffice.id);
  }, [activeOffice?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [title, setTitle] = useState(opportunity?.title || "");
  const [customer, setCustomer] = useState({ id: opportunity?.customerId || "", name: opportunity?.customerName || "" });
  const [pol, setPol] = useState(opportunity?.pol ? { unlocode: opportunity.pol, name: "" } : null);
  const [pod, setPod] = useState(opportunity?.pod ? { unlocode: opportunity.pod, name: "" } : null);
  const [carrierCode, setCarrierCode] = useState(opportunity?.carrierCode || "");
  const [commodityCode, setCommodityCode] = useState(opportunity?.commodityCode || "");
  const [movementType, setMovementType] = useState(opportunity?.movementType || "FCL");
  const [estimatedValue, setEstimatedValue] = useState(opportunity ? String(opportunity.estimatedValue) : "");
  const [currency, setCurrency] = useState(opportunity?.currency || "USD");
  const [estimatedCloseDate, setEstimatedCloseDate] = useState(opportunity?.estimatedCloseDate || "");
  const [leadSource, setLeadSource] = useState(opportunity?.leadSource || "");
  const [assigneeId, setAssigneeId] = useState(opportunity?.assigneeId || "");
  const [notes, setNotes] = useState(opportunity?.notes || "");
  const [users, setUsers] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.users.list().then(setUsers).catch(() => {}); }, []);

  const canSave = title.trim();

  const save = async () => {
    if (!canSave) { toast.error("Set a title"); return; }
    setSaving(true);
    try {
      const payload = {
        title, customerId: customer.id, customerName: customer.name,
        pol: pol?.unlocode || "", pod: pod?.unlocode || "", carrierCode, commodityCode, movementType,
        estimatedValue: Number(estimatedValue) || 0, currency, estimatedCloseDate, leadSource,
        assigneeId, officeId, notes,
      };
      const saved = isEdit ? await api.opportunities.update(opportunity.id, payload) : await api.opportunities.create(payload);
      toast.success(isEdit ? "Opportunity updated" : "Opportunity created");
      onSaved(saved);
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={isEdit ? `Edit Opportunity — ${opportunity.id}` : "New Opportunity"} onClose={onClose} width={720}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Field label="Title" hint="A short identifying label — everything else here is optional">
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Q3 lane expansion — NL to US East Coast"
            style={{ ...inputBase, fontSize: 13 }} />
        </Field>

        <CustomerCombobox label="Customer" value={customer} onChange={setCustomer} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 140px", gap: 12 }}>
          <PortField label="POL" value={pol} onChange={setPol} />
          <PortField label="POD" value={pod} onChange={setPod} />
          <Field label="Carrier"><CarrierCombobox value={carrierCode} onChange={setCarrierCode} /></Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Commodity"><CommodityCombobox value={commodityCode} onChange={setCommodityCode} /></Field>
          <Sel label="Movement Type" value={movementType} onChange={setMovementType} options={MOVEMENT_TYPE_OPTIONS} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 120px", gap: 12 }}>
          <Field label="Estimated Value">
            <input value={estimatedValue} onChange={e => setEstimatedValue(e.target.value)} inputMode="decimal" placeholder="0"
              style={{ ...inputBase, fontFamily: T.mono, fontSize: 13, textAlign: "right" }} />
          </Field>
          <Field label="Estimated Close Date"><DatePicker value={estimatedCloseDate} onChange={setEstimatedCloseDate} /></Field>
          <Sel label="Currency" value={currency} onChange={setCurrency} options={CURRENCIES.map(c => ({ value: c, label: c }))} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Sel label="Lead Source" value={leadSource} onChange={setLeadSource}
            options={[{ value: "", label: "— Not set —" }, ...LEAD_SOURCE_OPTIONS.map(s => ({ value: s, label: s }))]} />
          <Sel label="Assignee" value={assigneeId} onChange={setAssigneeId}
            options={[{ value: "", label: "— Unassigned —" }, ...users.filter(u => u.isActive !== false).map(u => ({ value: u.id, label: u.name }))]} />
        </div>

        <Sel label="Office" value={officeId} onChange={setOfficeId}
          options={[{ value: "", label: "— None —" }, ...offices.filter(o => o.isActive).map(o => ({ value: o.id, label: `${o.code} — ${o.name}` }))]}
          hint="Which office owns this opportunity — controls who can see it" />

        <Field label="Notes"><textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
          style={{ ...inputBase, fontSize: 13, resize: "vertical" }} /></Field>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={save} disabled={!canSave || saving}>{saving ? "Saving…" : isEdit ? "Save Changes" : "Create Opportunity"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Opportunity detail modal ────────────────────────────────────────────────
const OpportunityDetailModal = ({ opportunityId, navigate, onClose, onChanged }) => {
  const [opportunity, setOpportunity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [losing, setLosing] = useState(false);
  const [lostReason, setLostReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.opportunities.get(opportunityId).then(setOpportunity).catch(e => toast.error(e.message)).finally(() => setLoading(false));
  }, [opportunityId]);
  useEffect(() => { load(); }, [load]);

  const runAction = async (fn, successMsg) => {
    setBusy(true);
    try { await fn(); toast.success(successMsg); load(); onChanged?.(); }
    catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  const qualify = () => runAction(() => api.opportunities.qualify(opportunityId), "Opportunity qualified");
  const lose = () => runAction(async () => { await api.opportunities.lose(opportunityId, { reason: lostReason }); setLosing(false); setLostReason(""); }, "Marked Lost");
  const convert = async () => {
    setBusy(true);
    try {
      const res = await api.opportunities.convert(opportunityId);
      toast.success(`Converted to quote ${res.quoteId}`);
      onClose();
      onChanged?.();
      navigate("quotes");
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={opportunity ? `Opportunity — ${opportunity.id}` : "Opportunity"} onClose={onClose} width={680}>
      {loading || !opportunity ? <Spinner /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Badge variant={STATUS_VARIANT[opportunity.status] || "default"}>{opportunity.status}</Badge>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>{opportunity.title}</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {["New", "Qualified"].includes(opportunity.status) && <Btn size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Btn>}
              {opportunity.status === "New" && <Btn size="sm" onClick={qualify} disabled={busy}>Qualify</Btn>}
              {opportunity.status === "Qualified" && <Btn size="sm" onClick={convert} disabled={busy}>Convert to Quote</Btn>}
              {["New", "Qualified"].includes(opportunity.status) && <Btn size="sm" variant="danger" onClick={() => setLosing(true)} disabled={busy}>Mark Lost</Btn>}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, fontFamily: T.body, fontSize: 12.5 }}>
            <div><div style={{ color: T.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Customer</div>
              <div style={{ color: T.text }}>{opportunity.customerName || "—"}</div></div>
            <div><div style={{ color: T.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Route</div>
              <div style={{ color: T.text, fontFamily: T.mono }}>{opportunity.pol && opportunity.pod ? `${opportunity.pol}→${opportunity.pod}` : "—"}</div></div>
            <div><div style={{ color: T.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Estimated Value</div>
              <div style={{ color: T.text, fontFamily: T.mono }}>{fmtUsd(opportunity.estimatedValueUsd)}</div></div>
            <div><div style={{ color: T.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Estimated Close</div>
              <div style={{ color: T.text }}>{opportunity.estimatedCloseDate || "—"}</div></div>
            <div><div style={{ color: T.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Lead Source</div>
              <div style={{ color: T.text }}>{opportunity.leadSource || "—"}</div></div>
            <div><div style={{ color: T.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Assignee</div>
              <div style={{ color: T.text }}>{opportunity.assigneeName || "Unassigned"}</div></div>
          </div>

          {opportunity.status === "Lost" && opportunity.lostReason && (
            <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, margin: 0 }}>Lost reason: {opportunity.lostReason}</p>
          )}
          {opportunity.status === "Converted" && opportunity.convertedQuoteId && (
            <button onClick={() => { onClose(); navigate("quotes"); }}
              style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", fontFamily: T.mono, fontSize: 12.5, padding: 0, textAlign: "left" }}>
              → View quote {opportunity.convertedQuoteId}
            </button>
          )}
          {opportunity.notes && <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, margin: 0 }}>Notes: {opportunity.notes}</p>}
        </div>
      )}
      {losing && (
        <Modal title="Mark opportunity Lost" onClose={() => setLosing(false)} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Reason" hint="Why this lead didn't convert — visible in this opportunity's history">
              <textarea value={lostReason} onChange={e => setLostReason(e.target.value)} rows={3}
                style={{ ...inputBase, fontSize: 13, resize: "vertical" }} />
            </Field>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setLosing(false)}>Cancel</Btn>
              <Btn variant="danger" onClick={lose} disabled={busy}>Mark Lost</Btn>
            </div>
          </div>
        </Modal>
      )}
      {editing && opportunity && (
        <OpportunityFormModal opportunity={opportunity} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); onChanged?.(); }} />
      )}
    </Modal>
  );
};

// ─── Main page ───────────────────────────────────────────────────────────────
// Filterable columns — keys match routes/opportunities.js's OPP_COLUMNS. Module-level so
// useTableQuery gets a stable array.
const OPP_FILTER_KEYS = ["id", "title", "customer", "closeDate", "assignee", "status"];
const OPP_SORT_OPTIONS = [
  { value: "",          label: "Newest first" },
  { value: "oldest",    label: "Oldest first" },
  { value: "closeDate", label: "Closing soonest" },
  { value: "value",     label: "Value ↓ largest" },
  { value: "customer",  label: "Customer A–Z" },
];

const OpportunitiesPage = ({ navigate }) => {
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // Same table behavior as Shipments, Quotes and Contracts (column-header checklists, search, sort,
  // paging) — see useTableQuery/DataTable. The old Status dropdown is gone: the Status column's own
  // header filter replaces it, rather than keeping a second, possibly-disagreeing way to filter one column.
  const t = useTableQuery({
    fetchPage: params => api.opportunities.list(params),
    fetchOptions: () => api.opportunities.filterOptions(),
    filterKeys: OPP_FILTER_KEYS,
  });

  const doDelete = async id => {
    try { await api.opportunities.remove(id); toast.success("Opportunity deleted"); t.reload(); }
    catch (e) { toast.error(e.message); }
    finally { setConfirmDeleteId(null); }
  };

  const columns = [
    { key: "id", header: "Opportunity", width: 135, filter: true,
      render: o => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{o.id}</span> },
    { key: "title", header: "Title", width: 230, filter: true,
      render: o => <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{o.title || "—"}</span> },
    { key: "customer", header: "Customer", width: 190, filter: true,
      render: o => <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{o.customerName || "—"}</span> },
    // Header centered over the amounts, amounts still right-aligned to each other: the cell is
    // centered (so the header centers too) and the figure sits in a fixed-width right-aligned block.
    { key: "value", header: "Est. Value", width: 115, align: "center",
      render: o => <span style={{ display: "inline-block", minWidth: 88, textAlign: "right", fontFamily: T.mono, fontSize: 13, fontWeight: 600, color: T.text }}>{fmtUsd(o.estimatedValueUsd)}</span> },
    { key: "closeDate", header: "Est. Close", width: 120, filter: true,
      render: o => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{o.estimatedCloseDate || "—"}</span> },
    { key: "assignee", header: "Assignee", width: 150, filter: true,
      render: o => <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{o.assigneeName || "—"}</span> },
    { key: "status", header: "Status", width: 105, align: "center", filter: true,
      render: o => <Badge variant={STATUS_VARIANT[o.status] || "default"}>{o.status}</Badge> },
  ];

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 22, fontWeight: 700, color: T.text, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <IconFlag size={20} /> Opportunities
          </h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            A pre-sales lead/opportunity pipeline — track a lead before it's ready to be quoted, then convert a
            qualified opportunity directly into a real quote.
          </p>
        </div>
        <Btn onClick={() => setNewOpen(true)}>+ New Opportunity</Btn>
      </div>

      <TableToolbar tableId="opportunities" search={t.filters.search} onSearch={t.setSearch}
        searchPlaceholder="Search opportunity, title, customer, route, assignee…"
        sort={t.sort} sortOptions={OPP_SORT_OPTIONS} onSort={t.setSort}
        canClear={t.canClear} onClear={t.clear} />

      <DataTable tableId="opportunities" columns={columns} rows={t.rows} loading={t.loading} rowKey={o => o.id}
        hasFilters={t.hasFilters} filters={t.filters} filterOptions={t.options} onFilterChange={t.setColumnFilter}
        onRowClick={o => setDetailId(o.id)}
        rowActions={o => [
          { icon: IconEye,   label: "Open",   onClick: () => setDetailId(o.id) },
          { icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirmDeleteId(o.id) },
        ]}
        emptyMessage="No opportunities yet." emptyFilteredMessage="No opportunities match your filters."
        pagination={{ total: t.total, offset: t.offset, limit: t.limit, onPage: t.goPage, onLimit: t.changeLimit }} />

      {newOpen && (
        <OpportunityFormModal onClose={() => setNewOpen(false)}
          onSaved={saved => { setNewOpen(false); t.reload(); setDetailId(saved.id); }} />
      )}
      {detailId && (
        <OpportunityDetailModal opportunityId={detailId} navigate={navigate} onClose={() => setDetailId(null)} onChanged={() => t.reload()} />
      )}
      {confirmDeleteId && (
        <ConfirmModal message="Delete this opportunity? This can't be undone." onCancel={() => setConfirmDeleteId(null)} onConfirm={() => doDelete(confirmDeleteId)} />
      )}
    </div>
  );
};

export default OpportunitiesPage;
