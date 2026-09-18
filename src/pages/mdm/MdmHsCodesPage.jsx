import { useState, useEffect, useCallback, useRef } from "react";
import Spinner, { PageSpinner } from "../../components/primitives/Spinner";
import { T } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import { Inp } from "../../components/primitives/Form";
import { inputBase } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import Pagination from "../../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../../components/primitives/PageSizeSelect";
import ActionMenu from "../../components/primitives/ActionMenu";
import { IconPencil, IconClose, IconSearch } from "../../components/primitives/Icon";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── HS Codes registry ──────────────────────────────────────────────────────────
// International 6-digit Harmonized System classification — distinct from Commodities (this
// app's own internal cargo-grade/handling classification, unrelated to customs tariff codes).
//
// Sourcing (2026-09-18 research): there's no free, bulk-downloadable full WCO nomenclature
// (~5,300 codes). The one candidate free API (tariffnumber.com) covers EU Combined Nomenclature/
// TARIC only, not global HS — and its free tier's own terms forbid storing or caching results at
// all, which rules it out as a source for a persisted registry. So this table is a curated ~50
// real, well-known HS-6 codes across common freight categories (data/hs-codes.json) — accurate,
// not a claim of completeness. The "Look up on EU classifier" action below is the honest use of
// that API instead: a live, never-persisted call per search, clearly labeled as EU-specific.
const HS_CHAPTERS = [
  ["27", "Mineral fuels, oils"], ["30", "Pharmaceutical products"], ["39", "Plastics"],
  ["40", "Rubber"], ["42", "Leather, travel goods"], ["44", "Wood"], ["48", "Paper, paperboard"],
  ["49", "Printed books"], ["61", "Apparel, knitted"], ["62", "Apparel, not knitted"],
  ["64", "Footwear"], ["72", "Iron and steel"], ["73", "Articles of iron/steel"],
  ["76", "Aluminium"], ["83", "Misc. base metal articles"], ["84", "Machinery"],
  ["85", "Electrical machinery"], ["87", "Vehicles"], ["90", "Optical/medical instruments"],
  ["94", "Furniture, lighting"], ["95", "Toys, sports goods"],
];

const HsCodeForm = ({ init = {}, onSave, onCancel }) => {
  const isEdit = !!init.code;
  const [f, setF] = useState({
    code: init.code || "", description: init.description || "",
    hsChapter: init.hsChapter || "", chapterName: init.chapterName || "",
  });
  const set = k => v => setF(p => ({ ...p, [k]: v }));
  const valid = (isEdit || /^\d{6}$/.test(f.code.trim())) && f.description.trim().length >= 3 && /^\d{2}$/.test(f.hsChapter.trim());

  const handleChapter = hsChapter => {
    const found = HS_CHAPTERS.find(([c]) => c === hsChapter);
    setF(p => ({ ...p, hsChapter, chapterName: found ? found[1] : p.chapterName }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {!isEdit
        ? <Inp label="HS Code" value={f.code} onChange={v => set("code")(v.replace(/\D/g, "").slice(0, 6))}
            placeholder="847130" mono required hint="6-digit international Harmonized System code" />
        : <div style={{ ...inputBase, fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>
            {init.code}
          </div>
      }
      <Inp label="Description" value={f.description} onChange={set("description")}
        placeholder="Portable automatic data-processing machines, weighing <= 10kg" required />
      <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: 12 }}>
        <Inp label="Chapter" value={f.hsChapter} onChange={v => handleChapter(v.replace(/\D/g, "").slice(0, 2))}
          placeholder="84" mono required hint="2-digit" />
        <Inp label="Chapter Name" value={f.chapterName} onChange={set("chapterName")} placeholder="Machinery" />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!valid} onClick={() => onSave({ ...f, code: f.code.trim(), hsChapter: f.hsChapter.trim(), description: f.description.trim(), chapterName: f.chapterName.trim() })}>
          {isEdit ? "Save Changes" : "Add HS Code"}
        </Btn>
      </div>
    </div>
  );
};

// Live EU (Combined Nomenclature/TARIC) lookup — every search is a fresh, uncached call to
// tariffnumber.com's free public endpoint (routes/hs-codes.js's eu-lookup proxy); nothing here is
// ever saved to hs_codes, matching that free tier's own no-store terms. Clearly scoped to "EU"
// throughout so it never reads as this app's own (global) registry.
const EuLookupModal = ({ onClose }) => {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);

  const run = v => {
    setTerm(v);
    clearTimeout(timer.current);
    if (!v.trim()) { setResults(null); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try { setResults(await api.hsCodes.euLookup(v)); } catch { setResults([]); }
      setLoading(false);
    }, 350);
  };

  return (
    <Modal title="Look Up EU Classification" onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: 0 }}>
          Live search against the EU's Combined Nomenclature (CN/TARIC) — not this registry, and
          never saved here. Useful for EU-bound shipments needing the finer 8–10 digit EU code.
        </p>
        <input autoFocus value={term} onChange={e => run(e.target.value)}
          placeholder="Search a product description or code…"
          style={{ ...inputBase, fontFamily: T.body, fontSize: 14 }} />
        {loading ? (
          <div style={{ padding: 16, textAlign: "center" }}><Spinner size={18} /></div>
        ) : results === null ? null : results.length === 0 ? (
          <div style={{ padding: 16, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>No matches.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
            {results.map((r, i) => (
              <div key={`${r.code}-${i}`} style={{ display: "flex", gap: 10, padding: "8px 10px",
                background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8 }}>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700, flexShrink: 0, width: 80 }}>{r.code || "—"}</span>
                <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text }}>{r.description}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onClose}>Close</Btn>
        </div>
      </div>
    </Modal>
  );
};

const MdmHsCodesPage = () => {
  const { canManageMdm } = useAuth();
  const [results, setResults] = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [limit,   setLimit]   = useState(getStoredPageSize);
  const [search,  setSearch]  = useState("");
  const [chapter, setChapter] = useState("");
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [euOpen,  setEuOpen]  = useState(false);
  const timer = useRef(null);
  const { template, startResize } = useResizableColumns("mdm-hs-codes", [100,280,90,180]);
  const headers = ["Code","Description","Chapter","Actions"];

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const res = await api.hsCodes.list({
        search: opts.search !== undefined ? opts.search : search,
        chapter: opts.chapter !== undefined ? opts.chapter : chapter,
        limit:  opts.limit !== undefined ? opts.limit : limit,
        offset: opts.offset !== undefined ? opts.offset : offset,
      });
      setResults(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [search, chapter, offset, limit]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = v => {
    setSearch(v); setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 300);
  };
  const handleChapterFilter = v => { setChapter(v); setOffset(0); load({ chapter: v, offset: 0 }); };
  const goPage = off => { setOffset(off); load({ offset: off }); };
  const changeLimit = n => { setLimit(n); setOffset(0); load({ limit: n, offset: 0 }); };

  const handleSave = async data => {
    try {
      if (modal === "add") { await api.hsCodes.create(data); toast.success("HS code added"); }
      else { await api.hsCodes.update(modal.code, data); toast.success("HS code updated"); }
      setModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async code => {
    try { await api.hsCodes.remove(code); toast.success("HS code removed"); setConfirm(null); load(); }
    catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>HS Codes</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total.toLocaleString()} international HS-6 codes · curated common-use set, not the full WCO nomenclature
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="secondary" onClick={() => setEuOpen(true)}>
            <IconSearch size={14} /> Look Up EU Classification
          </Btn>
          {canManageMdm && <Btn onClick={() => setModal("add")} size="lg">＋ Add HS Code</Btn>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search by code or description…"
          style={{ ...inputBase, fontFamily: T.body, fontSize: 14, flex: 1, maxWidth: 400 }} />
        <select value={chapter} onChange={e => handleChapterFilter(e.target.value)}
          style={{ ...inputBase, fontFamily: T.body, fontSize: 13, width: 260, cursor: "pointer" }}>
          <option value="">All chapters</option>
          {HS_CHAPTERS.map(([c, name]) => <option key={c} value={c}>{`${c} — ${name}`}</option>)}
        </select>
      </div>

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
            {search || chapter ? "No HS codes match." : "No HS codes yet — run: node scripts/import-mdm-data.js"}
          </div>
        ) : results.map(h => (
          <div key={h.code}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{h.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{h.description}</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }} title={h.chapterName}>{h.hsChapter}</span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...(canManageMdm ? [{ icon: IconPencil, label: "Edit",   onClick: () => setModal(h) }] : []),
                ...(canManageMdm ? [{ icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(h.code) }] : []),
              ]} />
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <PageSizeSelect value={limit} onChange={changeLimit} />
        <div style={{ flex: 1 }}><Pagination total={total} offset={offset} limit={limit} onPage={goPage} /></div>
      </div>

      {modal === "add" && (
        <Modal title="Add HS Code" onClose={() => setModal(null)} width={480}>
          <HsCodeForm onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title={`Edit — ${modal.code}`} onClose={() => setModal(null)} width={480}>
          <HsCodeForm init={modal} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Remove HS code ${confirm}? Cargo already tagged with it will retain the code.`}
          onConfirm={() => handleDelete(confirm)}
          onCancel={() => setConfirm(null)} />
      )}
      {euOpen && <EuLookupModal onClose={() => setEuOpen(false)} />}
    </div>
  );
};

export default MdmHsCodesPage;
