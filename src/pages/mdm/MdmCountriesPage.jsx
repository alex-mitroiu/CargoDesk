import { useState, useCallback, useEffect, useRef } from "react";
import { T, LANE_BADGE_VARIANT, contractVariant } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { inputBase,BtnToggle, Field, Inp} from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import CountryCombobox from "../../components/shared/CountryCombobox";
import ActionMenu from "../../components/primitives/ActionMenu";
import Pagination from "../../components/primitives/Pagination";
import CountryLocationsModal from "../../components/shared/CountryLocationsModal";
import { PageSpinner } from "../../components/primitives/Spinner";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── MDM Locations: Countries Page ────────────────────────────────────────────


const LIMIT = 50;

const MdmCountriesPage = () => {
  const { canManageMdm } = useAuth();
  const [countries,      setCountries]      = useState([]);
  const [total,          setTotal]          = useState(0);
  const [offset,         setOffset]         = useState(0);
  const [allLanes,       setAllLanes]       = useState([]);
  const [laneMap,        setLaneMap]        = useState({});
  const [search,         setSearch]         = useState("");
  const [loading,        setLoading]        = useState(true);
  const [modal,          setModal]          = useState(null);
  const [confirm,        setConfirm]        = useState(null);
  const [viewLocations,  setViewLocations]  = useState(null);
  const timer = useRef(null);
  const { template, startResize } = useResizableColumns("mdm-countries", [65,160,120,200,80,180]);
  const headers = ["ISO2","Country Name","UN Member?","Trade Lanes","Ports","Actions"];

  const load = useCallback(async (opts = {}) => {
    const s   = opts.search  !== undefined ? opts.search  : search;
    const off = opts.offset  !== undefined ? opts.offset  : offset;
    setLoading(true);
    try {
      const [cRes, l, assignments] = await Promise.all([
        api.countries.list({ search: s, limit: String(LIMIT), offset: String(off) }),
        allLanes.length ? Promise.resolve(allLanes) : api.tradeLanes.list(),
        Object.keys(laneMap).length ? Promise.resolve(null) : api.countryLanes.list(),
      ]);
      const rows = cRes.results || cRes || [];
      setTotal(cRes.total ?? rows.length);
      if (l !== allLanes) setAllLanes(l);
      const newLaneMap = { ...laneMap };
      if (assignments) {
        (assignments || []).forEach(a => {
          const key  = a.iso2 || a.Iso2;
          const lane = a.lane_code || a.laneCode;
          if (!newLaneMap[key]) newLaneMap[key] = [];
          if (!newLaneMap[key].includes(lane)) newLaneMap[key].push(lane);
        });
        setLaneMap(newLaneMap);
      }
      setCountries(rows.map(c => ({ ...c, tradeLanes: newLaneMap[c.iso2] || [] })));
    } catch (e) { console.error("Countries load error:", e); }
    setLoading(false);
  }, [search, offset, allLanes, laneMap]);

  useEffect(() => { load({ search: "", offset: 0 }); }, []);

  const handleSearch = v => {
    setSearch(v);
    setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 280);
  };

  const goPage = off => { setOffset(off); load({ offset: off }); };

  const CountryForm = ({ init = {}, onSave, onCancel }) => {
    const [iso2,      setIso2]      = useState(init.iso2 || "");
    const [name,      setName]      = useState(init.name || "");
    const [unMember,  setUnMember]  = useState(init.unMember !== false);
    const [selLanes,  setSelLanes]  = useState(init.tradeLanes || []);
    const [alertDays, setAlertDays] = useState(init.invoiceAlertBusinessDays != null ? String(init.invoiceAlertBusinessDays) : "");
    const [escalationDays, setEscalationDays] = useState(init.invoiceEscalationBusinessDays != null ? String(init.invoiceEscalationBusinessDays) : "");
    const isEdit = !!init.iso2;
    const valid  = (isEdit || iso2.trim().length === 2) && name.trim().length >= 2;

    const toggleLane = code => setSelLanes(p =>
      p.includes(code) ? p.filter(c => c !== code) : [...p, code]
    );

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!isEdit
          ? <Inp label="ISO2 Code" value={iso2} onChange={v => setIso2(v.toUpperCase())}
              placeholder="NL" mono maxLength={2} required hint="2-char ISO 3166-1 alpha-2" />
          : <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
              padding: "10px 14px", fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{init.iso2}</div>
        }
        <Inp label="Country Name" value={name} onChange={setName} placeholder="Netherlands" required />
        <Field label="UN Member State">
          <div style={{ display: "flex", gap: 8 }}>
            <BtnToggle selected={unMember}  onClick={() => setUnMember(true)}>✅ UN Member</BtnToggle>
            <BtnToggle selected={!unMember} onClick={() => setUnMember(false)}>⬜ Territory / Observer</BtnToggle>
          </div>
        </Field>
        <Field label="Trade Lanes" hint="select all that apply">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {allLanes.map(lane => (
              <BtnToggle key={lane.code} selected={selLanes.includes(lane.code)} onClick={() => toggleLane(lane.code)}>
                <span style={{ fontFamily: T.mono, fontSize: 11, marginRight: 4 }}>{lane.code}</span>
                <span style={{ fontSize: 12 }}>{lane.name}</span>
              </BtnToggle>
            ))}
          </div>
        </Field>
        {isEdit && (
          <Field label="Invoice Collections thresholds (Epic TKT-G11AHW, optional)"
            hint="Country-level default for offices in this country that haven't set their own — leave blank to inherit the global 5/8-business-day default">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Inp label="Alert (business days)" value={alertDays} onChange={setAlertDays} placeholder="Default: 5" mono type="number" />
              <Inp label="Escalation (business days)" value={escalationDays} onChange={setEscalationDays} placeholder="Default: 8" mono type="number" />
            </div>
          </Field>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid} onClick={() => onSave({
            iso2: iso2.trim().toUpperCase(), name: name.trim(), unMember, tradeLanes: selLanes,
            invoiceAlertBusinessDays: alertDays === "" ? null : alertDays,
            invoiceEscalationBusinessDays: escalationDays === "" ? null : escalationDays,
          })}>
            {isEdit ? "Save Changes" : "Add Country"}
          </Btn>
        </div>
      </div>
    );
  };

  const handleSave = async (d, isEdit) => {
    if (isEdit) {
      await api.countries.update(d.iso2, { name: d.name, unMember: d.unMember,
        invoiceAlertBusinessDays: d.invoiceAlertBusinessDays, invoiceEscalationBusinessDays: d.invoiceEscalationBusinessDays });
    } else {
      await api.countries.create({ iso2: d.iso2, name: d.name, unMember: d.unMember });
    }
    await api.countryLanes.set(d.iso2, d.tradeLanes);
    setModal(null);
    load("");
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Countries</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total} entr{total !== 1 ? "ies" : "y"} · ISO 3166-1 alpha-2 · with FIATA trade lane assignments
          </p>
        </div>
        {canManageMdm && <Btn onClick={() => setModal("add")} size="lg">＋ Add Country</Btn>}
      </div>

      <div style={{ marginBottom: 14 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search by ISO2 code or country name…"
          style={{ ...inputBase, fontFamily: T.body, fontSize: 14, maxWidth: 420 }} />
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
        ) : countries.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>No countries match your search.</div>
        ) : countries.map(c => (
          <div key={c.iso2}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{c.iso2}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{c.name}</span>
            <span style={{ fontFamily: T.body, fontSize: 12 }}>
              {c.unMember ? "✅ Member" : <span style={{ color: T.textMuted }}>— Territory</span>}
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {(c.tradeLanes || []).length > 0
                ? (c.tradeLanes || []).map(l => <Badge key={l} variant={LANE_BADGE_VARIANT[l] || "default"}>{l}</Badge>)
                : <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>
              }
            </div>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: c.portCount > 0 ? T.success : T.textMuted, fontWeight: c.portCount > 0 ? 700 : 400 }}>
              {(c.portCount ?? 0).toLocaleString()}
            </span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...((c.portCount ?? 0) > 0 ? [{ icon: "📍", label: "View Locations", onClick: () => setViewLocations(c) }] : []),
                ...(canManageMdm ? [{ icon: "✎", label: "Edit",   onClick: () => setModal(c) }] : []),
                ...(canManageMdm ? [{ icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(c.iso2) }] : []),
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

      {modal === "add" && (
        <Modal title="Add Country" onClose={() => setModal(null)} width={560}>
          <CountryForm onSave={d => handleSave(d, false)} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Country" onClose={() => setModal(null)} width={560}>
          <CountryForm init={modal} onSave={d => handleSave(d, true)} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={`Remove country "${confirm}"? Port and trade lane data will not be affected.`}
          onConfirm={async () => { await api.countries.remove(confirm); setConfirm(null); load(""); }}
          onCancel={() => setConfirm(null)} />
      )}
      {viewLocations && (
        <CountryLocationsModal country={viewLocations} onClose={() => setViewLocations(null)} />
      )}
    </div>
  );
};

// ─── MDM Locations: UN Location Codes Page ────────────────────────────────────

export default MdmCountriesPage;