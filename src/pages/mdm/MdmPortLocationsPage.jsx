import { useState, useEffect, useCallback, useRef } from "react";
import Spinner, { PageSpinner } from "../../components/primitives/Spinner";
import { T } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import Pagination from "../../components/primitives/Pagination";
import ActionMenu from "../../components/primitives/ActionMenu";
import { inputBase, Inp, Sel, Field } from "../../components/primitives/Form";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── MDM: Port Locations Page ─────────────────────────────────────────────────

const MdmPortLocationsPage = () => {
  const { canEdit } = useAuth();
  const [search,   setSearch]   = useState("");
  const [country,  setCountry]  = useState("");
  const [results,  setResults]  = useState([]);
  const [total,    setTotal]    = useState(0);
  const [offset,   setOffset]   = useState(0);
  const [loading,  setLoading]  = useState(false);
  const [modal,    setModal]    = useState(null); // null | "add" | port obj
  const [confirm,  setConfirm]  = useState(null);
  const LIMIT = 50;
  const timer  = useRef(null);
  const { template, startResize } = useResizableColumns("mdm-ports", [90,200,70,110,110,110,80]);
  const headers = ["UN/LOCODE","Name","Country","Latitude","Longitude","Zone","Map"];

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const res = await api.ports.search({
        search:  opts.search  !== undefined ? opts.search  : search,
        country: opts.country !== undefined ? opts.country : country,
        limit:   LIMIT,
        offset:  opts.offset  !== undefined ? opts.offset  : offset,
      });
      setResults(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [search, country, offset]);

  useEffect(() => { load(); }, []);

  const handleSearch = (val) => {
    setSearch(val);
    setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: val, offset: 0 }), 300);
  };

  const handleCountry = (val) => {
    setCountry(val);
    setOffset(0);
    load({ country: val, offset: 0 });
  };

  const goPage = (newOffset) => { setOffset(newOffset); load({ offset: newOffset }); };

  const PortForm = ({ init = {}, onSave, onCancel }) => {
    const [f, setF] = useState({
      unlocode: init.unlocode || "", name: init.name || "", latitude: init.latitude ?? "",
      longitude: init.longitude ?? "", countryCode: init.countryCode || "", zoneCode: init.zoneCode || "",
    });
    const set = k => v => setF(p => ({ ...p, [k]: v }));
    const valid = f.unlocode.length === 5 && f.name.trim().length > 0;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp label="UN/LOCODE" value={f.unlocode} onChange={v => set("unlocode")(v.toUpperCase())} placeholder="NLRTM" mono maxLength={5} required />
          <Inp label="Country Code" value={f.countryCode} onChange={v => set("countryCode")(v.toUpperCase())} placeholder="NL" mono maxLength={2} />
        </div>
        <Inp label="Port Name" value={f.name} onChange={set("name")} placeholder="Rotterdam" required />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp label="Latitude"  value={String(f.latitude)}  onChange={v => set("latitude")(v)}  placeholder="51.9225" type="number" />
          <Inp label="Longitude" value={String(f.longitude)} onChange={v => set("longitude")(v)} placeholder="4.47917" type="number" />
        </div>
        <Inp label="Zone Code" value={f.zoneCode} onChange={set("zoneCode")} placeholder="EU-WEU" />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn onClick={() => valid && onSave({ ...f, latitude: parseFloat(f.latitude) || null, longitude: parseFloat(f.longitude) || null })} disabled={!valid}>
            {init.unlocode ? "Save Changes" : "Add Port"}
          </Btn>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Port Locations</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total.toLocaleString()} UN/LOCODE records · ISO 3166 country codes · coordinates
          </p>
        </div>
        {canEdit && <Btn onClick={() => setModal("add")} size="lg">＋ Add Port</Btn>}
      </div>

      {/* Search bar */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 10, marginBottom: 16 }}>
        <div style={{ position: "relative" }}>
          <input value={search} onChange={e => handleSearch(e.target.value)}
            placeholder="Search by UN/LOCODE or port name…"
            style={{ ...inputBase, fontFamily: T.body, fontSize: 14, paddingLeft: 36 }} />
          <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: T.textMuted, fontSize: 14 }}>🔍</span>
        </div>
        <input value={country} onChange={e => handleCountry(e.target.value.toUpperCase())}
          placeholder="Country (NL…)" maxLength={2}
          style={{ ...inputBase, fontFamily: T.mono, fontSize: 13, textTransform: "uppercase" }} />
      </div>

      {/* Table */}
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
        ) : results.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            {search || country ? "No ports match your search." : "No port data yet. Run: node import-mdm-data.js"}
          </div>
        ) : results.map(p => (
          <div key={p.unlocode}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{p.unlocode}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{p.name}</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{p.countryCode}</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{p.latitude?.toFixed(4) ?? "—"}</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{p.longitude?.toFixed(4) ?? "—"}</span>
            <Badge>{p.zoneCode || "—"}</Badge>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...(p.latitude && p.longitude ? [{ icon: "📍", label: "Open Map", onClick: () => window.open(`https://www.google.com/maps/search/?api=1&query=${p.latitude}%2C${p.longitude}`, "_blank") }] : []),
                ...(canEdit ? [{ icon: "✎", label: "Edit",   onClick: () => setModal(p) }] : []),
                ...(canEdit ? [{ icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(p.unlocode) }] : []),
              ]} />
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      <Pagination total={total} offset={offset} limit={LIMIT} onPage={goPage} />

      {modal === "add" && (
        <Modal title="Add Port Location" onClose={() => setModal(null)}>
          <PortForm onSave={async data => { await api.ports.create(data); setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Port Location" onClose={() => setModal(null)}>
          <PortForm init={modal}
            onSave={async data => { await api.ports.update(modal.unlocode, data); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      <Pagination total={total} offset={offset} limit={LIMIT} onPage={goPage} />

      {confirm && (
        <ConfirmModal
          message={`Remove port ${confirm} from the master data? Linked ports referencing it will also be removed.`}
          onConfirm={async () => { await api.ports.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── MDM: Linked Ports Page ───────────────────────────────────────────────────

export default MdmPortLocationsPage;