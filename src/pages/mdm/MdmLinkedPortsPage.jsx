import { useState, useEffect, useCallback } from "react";
import Spinner, { PageSpinner } from "../../components/primitives/Spinner";
import { T } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import { Inp } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import PortField from "../../components/shared/PortField";
import ActionMenu from "../../components/primitives/ActionMenu";
import Pagination from "../../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../../components/primitives/PageSizeSelect";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── MDM: Linked Ports Page ───────────────────────────────────────────────────

const MdmLinkedPortsPage = () => {
  const { canManageMdm } = useAuth();
  const [links,   setLinks]   = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [limit,   setLimit]   = useState(getStoredPageSize);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | link obj
  const [confirm, setConfirm] = useState(null);
  const [apiErr,  setApiErr]  = useState(null);
  const { template, startResize } = useResizableColumns("mdm-linked-ports", [100,160,30,100,160,160,120]);
  const headers = ["Primary","Port Name","","Linked To","Port Name","Note","Actions"];

  const load = useCallback(async (opts = {}) => {
    const off = opts.offset !== undefined ? opts.offset : offset;
    const lim = opts.limit  !== undefined ? opts.limit  : limit;
    setLoading(true);
    try {
      const res = await api.linkedPorts.list({ limit: lim, offset: off });
      setLinks(res.results || []);
      setTotal(res.total ?? 0);
      setApiErr(null);
    } catch (e) { setApiErr(e.message); }
    setLoading(false);
  }, [offset, limit]);

  useEffect(() => { load({ offset: 0 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const goPage = off => { setOffset(off); load({ offset: off }); };
  const changeLimit = n => { setLimit(n); setOffset(0); load({ limit: n, offset: 0 }); };

  const LinkForm = ({ init = {}, onSave, onCancel }) => {
    const [primary, setPrimary] = useState(init.primaryUnlocode ? { unlocode: init.primaryUnlocode, name: init.primaryName || "" } : null);
    const [linked,  setLinked]  = useState(init.linkedUnlocode  ? { unlocode: init.linkedUnlocode,  name: init.linkedName  || "" } : null);
    const [note, setNote]       = useState(init.note || "");
    const [fErr, setFErr]       = useState("");
    const isEdit = !!init.id;
    const valid  = (isEdit || (primary && linked)) && !(primary?.unlocode === linked?.unlocode);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {!isEdit && (
          <>
            <PortField label="Primary Port" value={primary}
              onChange={p => { setPrimary(p); setFErr(""); }}
              placeholder="Search primary UN/LOCODE…" required />
            <PortField label="Linked Port"  value={linked}
              onChange={p => { setLinked(p); setFErr(""); }}
              placeholder="Search linked UN/LOCODE…" required />
            {primary && linked && primary.unlocode === linked.unlocode && (
              <div style={{ fontFamily: T.body, fontSize: 12, color: T.danger, background: T.dangerBg, borderRadius: 6, padding: "8px 12px" }}>
                A port cannot be linked to itself.
              </div>
            )}
          </>
        )}
        {isEdit && (
          <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 16px" }}>
            <div style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>
              {init.primaryUnlocode} → {init.linkedUnlocode}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 2 }}>
              {init.primaryName} → {init.linkedName}
            </div>
          </div>
        )}
        <Inp label="Note (optional)" value={note} onChange={setNote} placeholder="e.g. Same terminal area, different berth codes" />
        {fErr && <div style={{ fontFamily: T.body, fontSize: 12, color: T.danger }}>{fErr}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid} onClick={() => {
            if (!isEdit && (!primary || !linked)) return setFErr("Both ports are required");
            onSave({ primaryUnlocode: primary?.unlocode, linkedUnlocode: linked?.unlocode, note });
          }}>
            {isEdit ? "Save Note" : "Add Link"}
          </Btn>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Linked Ports</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total} link{total !== 1 ? "s" : ""} configured · map one UN/LOCODE to another (e.g. USLAX → USLGB)
          </p>
        </div>
        {canManageMdm && <Btn onClick={() => setModal("add")} size="lg">＋ Add Link</Btn>}
      </div>

      {apiErr && (
        <div style={{ background: T.dangerBg, border: `1px solid ${T.danger}44`, borderRadius: 8,
          padding: "12px 16px", fontFamily: T.body, fontSize: 13, color: T.danger, marginBottom: 16 }}>
          {apiErr} — make sure Port Locations data is imported first.
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
        ) : links.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No port links configured yet. Use "+ Add Link" to create one.
          </div>
        ) : links.map(l => (
          <div key={l.id}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{l.primaryUnlocode}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{l.primaryName}</span>
            <span style={{ fontFamily: T.mono, fontSize: 14, color: T.textMuted, textAlign: "center" }}>→</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, fontWeight: 700 }}>{l.linkedUnlocode}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{l.linkedName}</span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: l.note ? "normal" : "italic" }}>
              {l.note || "—"}
            </span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...(canManageMdm ? [{ icon: "✎", label: "Edit Note", onClick: () => setModal(l) }] : []),
                ...(canManageMdm ? [{ icon: "✕", label: "Delete",    variant: "danger", onClick: () => setConfirm(l.id) }] : []),
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
        <Modal title="Add Port Link" onClose={() => setModal(null)} width={560}>
          <LinkForm
            onSave={async data => { await api.linkedPorts.create(data); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Link Note" onClose={() => setModal(null)} width={480}>
          <LinkForm init={modal}
            onSave={async data => { await api.linkedPorts.update(modal.id, { note: data.note }); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message="Remove this port link? Shipments are not affected."
          onConfirm={async () => { await api.linkedPorts.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};



// ─── MDM: Trade Lanes Page ────────────────────────────────────────────────────

export default MdmLinkedPortsPage;