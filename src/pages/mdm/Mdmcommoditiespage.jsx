import { useState, useEffect, useCallback, useRef } from "react";
import Spinner, { PageSpinner } from "../../components/primitives/Spinner";
import { T } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import { Inp, Sel } from "../../components/primitives/Form";
import { inputBase } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import Pagination from "../../components/primitives/Pagination";
import ActionMenu from "../../components/primitives/ActionMenu";
import { GradePill } from "../../components/shared/CommodityCombobox";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── Grade options ────────────────────────────────────────────────────────────
const GRADES = [
  { code: "M", name: "Food Grade" },
  { code: "K", name: "General Cargo — Premium" },
  { code: "E", name: "General Cargo" },
  { code: "S", name: "Flexi" },
  { code: "Q", name: "Scrap Metal" },
];

// ─── Commodity Form ───────────────────────────────────────────────────────────
const CommodityForm = ({ init = {}, onSave, onCancel }) => {
  const isEdit = !!init.code;
  const [f, setF] = useState({
    code:        init.code        || "",
    description: init.description || "",
    gradeCode:   init.gradeCode   || "E",
    gradeName:   init.gradeName   || "General Cargo",
  });
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const valid = (isEdit || f.code.trim().length >= 4) && f.description.trim().length >= 3;

  const handleGrade = code => {
    const g = GRADES.find(g => g.code === code);
    setF(p => ({ ...p, gradeCode: code, gradeName: g?.name || code }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {!isEdit
        ? <Inp label="Commodity Code" value={f.code} onChange={v => setF(p => ({ ...p, code: v.toUpperCase() }))}
            placeholder="000544" mono required hint="Maersk commodity code from the reference list" />
        : <div style={{ ...inputBase, fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>
            {init.code}
          </div>
      }
      <Inp label="Description" value={f.description} onChange={set("description")}
        placeholder="Salmon, non-frozen, fish" required />
      <Sel label="Grade" value={f.gradeCode} onChange={handleGrade}
        options={GRADES.map(g => ({ value: g.code, label: `Grade ${g.code} — ${g.name}` }))} />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!valid} onClick={() => onSave({ ...f })}>
          {isEdit ? "Save Changes" : "Add Commodity"}
        </Btn>
      </div>
    </div>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────
const MdmCommoditiesPage = () => {
  const { canManageConfigs } = useAuth();
  const [results, setResults] = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [search,  setSearch]  = useState("");
  const [grade,   setGrade]   = useState("");
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null);
  const [confirm, setConfirm] = useState(null);
  const LIMIT = 50;
  const timer = useRef(null);
  const { template, startResize } = useResizableColumns("mdm-commodities", [90,250,180,130]);
  const headers = ["Code","Description","Grade","Actions"];

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const s   = opts.search !== undefined ? opts.search : search;
      const res = await api.commodities.list({
        search: grade ? `${s} ${grade}`.trim() : s,
        limit:  LIMIT,
        offset: opts.offset !== undefined ? opts.offset : offset,
      });
      setResults(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [search, offset, grade]);

  useEffect(() => { load(); }, []);

  const handleSearch = v => {
    setSearch(v); setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 300);
  };

  const goPage = off => { setOffset(off); load({ offset: off }); };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>
            Commodities
          </h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total.toLocaleString()} Maersk commodity codes · source: lista-de-commodities-y-grado-de-unidad
          </p>
        </div>
        {canManageConfigs && <Btn onClick={() => setModal("add")} size="lg">＋ Add Commodity</Btn>}
      </div>

      {/* Search + grade filter */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search by code or description…"
          style={{ ...inputBase, fontFamily: T.body, fontSize: 14, flex: 1, maxWidth: 400 }} />
        <select value={grade} onChange={e => { setGrade(e.target.value); setOffset(0); load({ search, offset: 0 }); }}
          style={{ ...inputBase, fontFamily: T.body, fontSize: 13, width: 220, cursor: "pointer" }}>
          <option value="">All grades</option>
          {GRADES.map(g => <option key={g.code} value={g.name}>{`Grade ${g.code} — ${g.name}`}</option>)}
        </select>
      </div>

      {/* Table */}
      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: template,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {headers.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
              color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < headers.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
            </div>
          ))}
        </div>

        {loading ? (
          <PageSpinner />
        ) : results.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body }}>
            {search ? "No commodities match." : "No commodities yet — run: node import-mdm-data.js"}
          </div>
        ) : results.map(c => (
          <div key={c.code}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{c.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{c.description}</span>
            <div style={{ display: "flex" }}><GradePill code={c.gradeCode} name={c.gradeName} /></div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...(canManageConfigs ? [{ icon: "✎", label: "Edit",   onClick: () => setModal(c) }] : []),
                ...(canManageConfigs ? [{ icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(c.code) }] : []),
              ]} />
            </div>
          </div>
        ))}
      </div>

      <Pagination total={total} offset={offset} limit={LIMIT} onPage={goPage} />

      {modal === "add" && (
        <Modal title="Add Commodity" onClose={() => setModal(null)} width={480}>
          <CommodityForm onSave={async d => { await api.commodities.create(d); setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title={`Edit — ${modal.code}`} onClose={() => setModal(null)} width={480}>
          <CommodityForm init={modal}
            onSave={async d => { await api.commodities.update(modal.code, d); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Remove commodity ${confirm}? Shipments referencing it will retain their code.`}
          onConfirm={async () => { await api.commodities.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmCommoditiesPage;