import { useState, useEffect, useCallback, useRef } from "react";
import Spinner, { PageSpinner } from "../../components/primitives/Spinner";
import { T } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { inputBase, Inp } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import Pagination from "../../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../../components/primitives/PageSizeSelect";
import ActionMenu from "../../components/primitives/ActionMenu";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── MDM: Vessels Page ────────────────────────────────────────────────────────

const MdmVesselsPage = () => {
  const { canManageMdm } = useAuth();
  const [results, setResults]  = useState([]);
  const [total,   setTotal]    = useState(0);
  const [offset,  setOffset]   = useState(0);
  const [limit,   setLimit]    = useState(getStoredPageSize);
  const [search,  setSearch]   = useState("");
  const [loading, setLoading]  = useState(true);
  const [modal,   setModal]    = useState(null);
  const [confirm, setConfirm]  = useState(null);
  const timer  = useRef(null);
  const { template, startResize } = useResizableColumns("mdm-vessels", [90,160,160,90,80,110,130]);
  const headers = ["IMO","Ship Name","Asset Type","Flag","Built","Gross Ton.","Actions"];

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const res = await api.vessels.list({
        search: opts.search  !== undefined ? opts.search  : search,
        limit:  opts.limit   !== undefined ? opts.limit   : limit,
        offset: opts.offset  !== undefined ? opts.offset  : offset,
      });
      setResults(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [search, offset, limit]);

  useEffect(() => { load(); }, []);

  const handleSearch = v => {
    setSearch(v); setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 300);
  };
  const goPage = off => { setOffset(off); load({ offset: off }); };
  const changeLimit = n => { setLimit(n); setOffset(0); load({ limit: n, offset: 0 }); };

  const VesselForm = ({ init = {}, onSave, onCancel }) => {
    const [f, setF] = useState({
      imo:          init.imo          || "",
      name:         init.name         || "",
      assetType:    init.assetType    || "",
      flagIso2:     init.flagIso2     || "",
      flagName:     init.flagName     || "",
      buildYear:    init.buildYear    ? String(init.buildYear)    : "",
      grossTonnage: init.grossTonnage ? String(init.grossTonnage) : "",
    });
    const set = k => v => setF(p => ({ ...p, [k]: v }));
    const isEdit = !!init.imo;
    const valid  = (isEdit || f.imo.trim().length >= 5) && f.name.trim().length >= 2;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!isEdit
          ? <Inp label="IMO Number" value={f.imo} onChange={set("imo")} placeholder="9222560" mono required hint="7-digit IMO identifier" />
          : <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px", fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>IMO {init.imo}</div>
        }
        <Inp label="Ship Name" value={f.name} onChange={v => setF(p => ({ ...p, name: v.toUpperCase() }))} placeholder="MSC ANNA" required />
        <Inp label="Asset Type" value={f.assetType} onChange={set("assetType")} placeholder="Container Ship" hint="Vessel type / category" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp label="Country Flag" value={f.flagName} onChange={set("flagName")} placeholder="Panama" />
          <Inp label="Flag ISO2" value={f.flagIso2} onChange={v => setF(p => ({ ...p, flagIso2: v.toUpperCase() }))} placeholder="PA" mono maxLength={2} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp label="Build Year" value={f.buildYear} onChange={set("buildYear")} type="number" placeholder="2010" />
          <Inp label="Gross Tonnage" value={f.grossTonnage} onChange={set("grossTonnage")} type="number" placeholder="164580" />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid} onClick={() => onSave({
            imo: f.imo.trim(), name: f.name.trim(), assetType: f.assetType || null,
            flagIso2: f.flagIso2 || null, flagName: f.flagName || null,
            buildYear: parseInt(f.buildYear) || null, grossTonnage: parseInt(f.grossTonnage) || null,
          })}>
            {isEdit ? "Save Changes" : "Add Vessel"}
          </Btn>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Vessels</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total.toLocaleString()} vessel{total !== 1 ? "s" : ""} · IMO registry · linked to country flags
          </p>
        </div>
        {canManageMdm && <Btn onClick={() => setModal("add")} size="lg">＋ Add Vessel</Btn>}
      </div>

      {/* Search */}
      <div style={{ marginBottom: 14 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search by ship name, IMO, or vessel type…"
          style={{ ...inputBase, fontFamily: T.body, fontSize: 14, maxWidth: 460 }} />
      </div>

      {/* Table */}
      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: template,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {headers.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
              // Actions is the one column whose content is right-aligned (the gear button sits
              // at the cell's trailing edge) — the header needs to match, or it reads as
              // misaligned against every button in the column below it.
              textAlign: h === "Actions" ? "right" : "left" }}>
              {h}{i < headers.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
            </div>
          ))}
        </div>

        {loading ? (
          <PageSpinner />
        ) : results.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            {search ? "No vessels match your search." : "No vessels yet. Run: node import-mdm-data.js"}
          </div>
        ) : results.map(v => (
          <div key={v.imo}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "12px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, fontWeight: 700 }}>{v.imo}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              {v.name}
              {v.aisVerifiedAt && (
                <span title={`Resolved/confirmed live via AIS — last seen ${new Date(v.aisVerifiedAt).toLocaleString()}`}
                  style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: T.accent,
                    background: `${T.accent}18`, border: `1px solid ${T.accent}44`,
                    borderRadius: 4, padding: "1px 5px", letterSpacing: ".04em", flexShrink: 0 }}>
                  AIS
                </span>
              )}
            </span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{v.assetType || "—"}</span>
            {/* Always reserve two stacked lines here, flag-present or not — this cell being the
                only one in the row that ever grows to two lines was making rows with no flag
                data (common for AIS-resolved vessels, which never carry flag/tonnage) render
                visibly shorter than rows with one, so the table's row heights zig-zagged. */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
              {v.flagIso2
                ? <Badge variant="default">{v.flagIso2}</Badge>
                : <span style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>—</span>}
              {/* Badge's own padding ("2px 9px", Badge.jsx) insets its text 9px from the column's
                  left edge — matched here so the caption's text lines up with the badge's text
                  above it, not with the badge's own bounding-box edge. */}
              <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, minHeight: 12, paddingLeft: 9 }}>{v.flagIso2 ? v.flagName : " "}</span>
            </div>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{v.buildYear || "—"}</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{v.grossTonnage ? v.grossTonnage.toLocaleString() : "—"}</span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...(canManageMdm ? [{ icon: "✎", label: "Edit",   onClick: () => setModal(v) }] : []),
                ...(canManageMdm ? [{ icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(v.imo) }] : []),
              ]} />
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <PageSizeSelect value={limit} onChange={changeLimit} />
        <div style={{ flex: 1 }}><Pagination total={total} offset={offset} limit={limit} onPage={goPage} /></div>
      </div>

      {modal === "add" && (
        <Modal title="Add Vessel" onClose={() => setModal(null)} width={520}>
          <VesselForm onSave={async d => { await api.vessels.create(d); setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Vessel" onClose={() => setModal(null)} width={520}>
          <VesselForm init={modal}
            onSave={async d => { await api.vessels.update(modal.imo, d); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Remove vessel IMO ${confirm}? Shipments referencing it will retain the vessel name.`}
          onConfirm={async () => { await api.vessels.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── Root App ─────────────────────────────────────────────────────────────────

export default MdmVesselsPage;