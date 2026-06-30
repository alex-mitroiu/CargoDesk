import { useState, useCallback, useEffect } from "react";
import Spinner, { PageSpinner } from "../../components/primitives/Spinner";
import { T } from "../../tokens";
import { api } from "../../api";
import Btn from "../../components/primitives/Btn";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import { Inp, Textarea } from "../../components/primitives/Form";
import ActionMenu from "../../components/primitives/ActionMenu";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── MDM Locations: Regions Page ──────────────────────────────────────────────

const MdmRegionsPage = () => {
  const [regions,  setRegions]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [modal,    setModal]    = useState(null);
  const [confirm,  setConfirm]  = useState(null);
  const { template, startResize } = useResizableColumns("mdm-regions", [120,150,150,90,130]);
  const headers = ["Code","Name","Description","Ports","Actions"];

  const load = useCallback(async () => {
    setLoading(true);
    try { setRegions(await api.regions.list()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, []);

  const RegionForm = ({ init = {}, onSave, onCancel }) => {
    const [code, setCode] = useState(init.code || "");
    const [name, setName] = useState(init.name || "");
    const [desc, setDesc] = useState(init.description || "");
    const isEdit = !!init.code;
    const valid  = (isEdit || code.trim().length >= 2) && name.trim().length >= 2;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!isEdit && <Inp label="Region Code" value={code} onChange={v => setCode(v.toUpperCase())} placeholder="EU-WEU" mono required hint="e.g. EU-WEU, AS-SIN" />}
        {isEdit && (
          <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px",
            fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{init.code}</div>
        )}
        <Inp label="Region Name" value={name} onChange={setName} placeholder="Europe – Western Europe" required />
        <Textarea label="Description" value={desc} onChange={setDesc} placeholder="Optional description…" rows={2} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid} onClick={() => onSave({ code: code.trim().toUpperCase(), name: name.trim(), description: desc })}>
            {isEdit ? "Save Changes" : "Add Region"}
          </Btn>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Regions</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {regions.length} region{regions.length !== 1 ? "s" : ""} — derived from UN/LOCODE zone codes
          </p>
        </div>
        <Btn onClick={() => setModal("add")} size="lg">＋ Add Region</Btn>
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
        {loading ? (
          <PageSpinner />
        ) : regions.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No regions yet. Run <code style={{ fontFamily: T.mono, color: T.textCode }}>node import-mdm-data.js</code> to auto-populate from port data.
          </div>
        ) : regions.map(r => (
          <div key={r.code}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{r.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{r.name}</span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: r.description ? "normal" : "italic" }}>
              {r.description || "—"}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>{r.portCount.toLocaleString()}</span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                { icon: "✎", label: "Edit",   onClick: () => setModal(r) },
                { icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(r.code) },
              ]} />
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Region" onClose={() => setModal(null)}>
          <RegionForm onSave={async d => { await api.regions.create(d); setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Region" onClose={() => setModal(null)}>
          <RegionForm init={modal}
            onSave={async d => { await api.regions.update(modal.code, d); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={`Remove region "${confirm}"? Port data will not be affected.`}
          onConfirm={async () => { await api.regions.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── MDM Locations: Countries Page ────────────────────────────────────────────

export default MdmRegionsPage;