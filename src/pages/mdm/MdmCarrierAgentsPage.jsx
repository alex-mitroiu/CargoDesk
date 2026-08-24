import { useState, useEffect, useCallback } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import { Inp } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import CarrierCombobox from "../../components/shared/CarrierCombobox";
import PortField from "../../components/shared/PortField";
import CustomerCombobox from "../../components/shared/CustomerCombobox";
import ActionMenu from "../../components/primitives/ActionMenu";
import Pagination from "../../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../../components/primitives/PageSizeSelect";
import { PageSpinner } from "../../components/primitives/Spinner";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── MDM: Carrier Agents Page ─────────────────────────────────────────────────
// Which local company represents a carrier at a given port — carrier x port -> agent customer.
// Auto-resolves onto every shipment's Additional Parties as "Line Agent (Export/Import)" (see
// resolveCarrierAgent/maybeAssignLineAgents, routes/shipments.js) and is displayed on the
// shipment's Carrier Booking -> Details tab. Modeled directly on MdmLinkedPortsPage.jsx, with
// one deliberate difference: the agent assignment is exactly the kind of thing that changes
// over time while carrier+port stay fixed, so editing an existing link lets you reassign the
// agent customer, not just the note.

const MdmCarrierAgentsPage = () => {
  const { canManageMdm } = useAuth();
  const [agents,  setAgents]  = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [limit,   setLimit]   = useState(getStoredPageSize);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | agent obj
  const [confirm, setConfirm] = useState(null);
  const [apiErr,  setApiErr]  = useState(null);
  const { template, startResize } = useResizableColumns("mdm-carrier-agents", [100, 130, 150, 220, 160, 100]);
  const headers = ["Carrier", "Port", "Port Name", "Agent", "Note", "Actions"];

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

  const AgentForm = ({ init = {}, onSave, onCancel }) => {
    const [carrierCode, setCarrierCode] = useState(init.carrierCode || "");
    const [port, setPort] = useState(init.portUnlocode ? { unlocode: init.portUnlocode, name: init.portName || "" } : null);
    const [agent, setAgent] = useState({ id: init.agentCustomerId || "", name: init.agentCustomerName || "" });
    const [note, setNote] = useState(init.note || "");
    const isEdit = !!init.id;
    const valid = (isEdit || (carrierCode && port)) && agent.id;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {!isEdit && (
          <>
            <CarrierCombobox value={carrierCode} onChange={setCarrierCode} required />
            <PortField label="Port" value={port} onChange={setPort} placeholder="Search UN/LOCODE…" required />
          </>
        )}
        {isEdit && (
          <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 16px" }}>
            <div style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>
              {init.carrierCode} @ {init.portUnlocode}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 2 }}>
              {init.portName}
            </div>
          </div>
        )}
        <CustomerCombobox label="Agent (Customer)" value={agent} onChange={setAgent} required />
        <Inp label="Note (optional)" value={note} onChange={setNote} placeholder="e.g. Booking + B/L release desk" />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid} onClick={() => onSave({ carrierCode, portUnlocode: port?.unlocode, agentCustomerId: agent.id, note })}>
            {isEdit ? "Save" : "Add Carrier Agent"}
          </Btn>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Carrier Agents</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total} link{total !== 1 ? "s" : ""} configured · which company represents a carrier at a given port
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
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 700 }}>{a.portUnlocode}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{a.portName || "—"}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>{a.agentCustomerName || "—"}</span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: a.note ? "normal" : "italic" }}>
              {a.note || "—"}
            </span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...(canManageMdm ? [{ icon: "✎", label: "Edit", onClick: () => setModal(a) }] : []),
                ...(canManageMdm ? [{ icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(a.id) }] : []),
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
          <AgentForm init={modal}
            onSave={async data => { await api.carrierAgents.update(modal.id, { agentCustomerId: data.agentCustomerId, note: data.note }); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message="Remove this carrier agent link? Shipments already assigned it keep their current party — only future auto-resolution is affected."
          onConfirm={async () => { await api.carrierAgents.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmCarrierAgentsPage;
