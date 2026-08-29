import { useState, useEffect, useCallback } from "react";
import { T, CURRENCIES } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import { Field, Sel } from "../components/primitives/Form";
import { inputBase } from "../components/primitives/Form";
import DatePicker from "../components/primitives/DatePicker";
import Spinner from "../components/primitives/Spinner";
import Pagination from "../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../components/primitives/PageSizeSelect";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import CustomerCombobox from "../components/shared/CustomerCombobox";
import PortField from "../components/shared/PortField";
import { CommodityCombobox } from "../components/shared/CommodityCombobox";
import { IconFlag, IconEye, IconClose } from "../components/primitives/Icon";
import ActionMenu from "../components/primitives/ActionMenu";

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
        assigneeId, notes,
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
const OpportunitiesPage = ({ navigate }) => {
  const [statusFilter, setStatusFilter] = useState("");
  const [opportunities, setOpportunities] = useState(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(getStoredPageSize);
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const load = useCallback((opts = {}) => {
    const off = opts.offset !== undefined ? opts.offset : offset;
    const lim = opts.limit  !== undefined ? opts.limit  : limit;
    api.opportunities.list({ ...(statusFilter ? { status: statusFilter } : {}), limit: lim, offset: off })
      .then(r => { setOpportunities(r.results); setTotal(r.total ?? (r.results || []).length); })
      .catch(() => { setOpportunities([]); setTotal(0); });
  }, [statusFilter, offset, limit]);
  useEffect(() => { setOffset(0); load({ offset: 0 }); }, [statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const goPage = off => { setOffset(off); load({ offset: off }); };
  const changeLimit = n => { setLimit(n); setOffset(0); load({ limit: n, offset: 0 }); };

  const doDelete = async id => {
    try { await api.opportunities.remove(id); toast.success("Opportunity deleted"); load(); }
    catch (e) { toast.error(e.message); }
    finally { setConfirmDeleteId(null); }
  };

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

      <div style={{ marginBottom: 12, width: 200 }}>
        <Sel label="Status" value={statusFilter} onChange={setStatusFilter}
          options={[{ value: "", label: "All Statuses" }, ...["New", "Qualified", "Converted", "Lost"].map(s => ({ value: s, label: s }))]} />
      </div>

      {opportunities === null ? <Spinner /> : opportunities.length === 0 ? (
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>No opportunities yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.body, fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted, textAlign: "left" }}>
                {["Opportunity", "Title", "Customer", "Est. Value", "Est. Close", "Assignee", "Status", ""].map(h => (
                  <th key={h} style={{ padding: "8px", fontWeight: 600, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {opportunities.map(o => (
                <tr key={o.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td onClick={() => setDetailId(o.id)} style={{ padding: "10px 8px", fontFamily: T.mono, color: T.accent, cursor: "pointer" }}>{o.id}</td>
                  <td onClick={() => setDetailId(o.id)} style={{ padding: "10px 8px", cursor: "pointer" }}>{o.title || "—"}</td>
                  <td onClick={() => setDetailId(o.id)} style={{ padding: "10px 8px", cursor: "pointer" }}>{o.customerName || "—"}</td>
                  <td onClick={() => setDetailId(o.id)} style={{ padding: "10px 8px", fontFamily: T.mono, cursor: "pointer", textAlign: "right" }}>{fmtUsd(o.estimatedValueUsd)}</td>
                  <td onClick={() => setDetailId(o.id)} style={{ padding: "10px 8px", cursor: "pointer" }}>{o.estimatedCloseDate || "—"}</td>
                  <td onClick={() => setDetailId(o.id)} style={{ padding: "10px 8px", cursor: "pointer" }}>{o.assigneeName || "—"}</td>
                  <td onClick={() => setDetailId(o.id)} style={{ padding: "10px 8px", cursor: "pointer" }}><Badge variant={STATUS_VARIANT[o.status] || "default"}>{o.status}</Badge></td>
                  <td style={{ padding: "10px 8px", textAlign: "right" }} onClick={e => e.stopPropagation()}>
                    <ActionMenu items={[
                      { icon: IconEye,   label: "Open",   onClick: () => setDetailId(o.id) },
                      { icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirmDeleteId(o.id) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {opportunities !== null && opportunities.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <PageSizeSelect value={limit} onChange={changeLimit} />
          <div style={{ flex: 1 }}><Pagination total={total} offset={offset} limit={limit} onPage={goPage} /></div>
        </div>
      )}

      {newOpen && (
        <OpportunityFormModal onClose={() => setNewOpen(false)}
          onSaved={saved => { setNewOpen(false); load(); setDetailId(saved.id); }} />
      )}
      {detailId && (
        <OpportunityDetailModal opportunityId={detailId} navigate={navigate} onClose={() => setDetailId(null)} onChanged={load} />
      )}
      {confirmDeleteId && (
        <ConfirmModal message="Delete this opportunity? This can't be undone." onCancel={() => setConfirmDeleteId(null)} onConfirm={() => doDelete(confirmDeleteId)} />
      )}
    </div>
  );
};

export default OpportunitiesPage;
