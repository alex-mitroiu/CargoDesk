import { useState, useCallback, useEffect, useRef } from "react";
import { T, LANE_BADGE_VARIANT } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import CountryCombobox from "../../components/shared/CountryCombobox";
import ActionMenu from "../../components/primitives/ActionMenu";
import { Inp, Field, Textarea } from "../../components/primitives/Form";
import { PageSpinner } from "../../components/primitives/Spinner";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

const MdmTradeLanesPage = () => {
  const { canManageMdm } = useAuth();
  const [lanes,   setLanes]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null);
  const [confirm, setConfirm] = useState(null);
  const { template, startResize } = useResizableColumns("mdm-tradelanes", [90,150,150,100,100,130]);
  const headers = ["Code","Name","Description","Countries","Transit Days","Actions"];

  const load = useCallback(async () => {
    setLoading(true);
    try { setLanes(await api.tradeLanes.list()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, []);

  const LaneForm = ({ init = {}, onSave, onCancel }) => {
    const [code,        setCode]      = useState(init.code || "");
    const [name,        setName]      = useState(init.name || "");
    const [desc,        setDesc]      = useState(init.description || "");
    const [transitDays, setTransitDays] = useState(init.transitDays ?? 0);
    const [countries, setCountries] = useState([]);   // assigned countries list
    const [loadingC,  setLoadingC]  = useState(false);
    const isEdit = !!init.code;
    const valid  = (isEdit || code.trim().length >= 2) && name.trim().length >= 2;

    // Load current country assignments when editing
    useEffect(() => {
      if (!isEdit) return;
      setLoadingC(true);
      api.tradeLanes.getCountries(init.code)
        .then(list => setCountries(list))
        .catch(() => {})
        .finally(() => setLoadingC(false));
    }, [init.code]);

    const addCountry    = c => setCountries(p => p.some(x => x.iso2 === c.iso2) ? p : [...p, c]);
    const removeCountry = iso2 => setCountries(p => p.filter(c => c.iso2 !== iso2));

    const handleSave = () => {
      onSave({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description: desc,
        transitDays: Number(transitDays) || 0,
        iso2s: countries.map(c => c.iso2),
      });
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Lane code */}
        {!isEdit
          ? <Inp label="Lane Code" value={code} onChange={v => setCode(v.toUpperCase())}
              placeholder="EU-N" mono required hint="e.g. FE, SEA, EU-N, ME" />
          : <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
                padding: "10px 14px", fontFamily: T.mono, fontSize: 15, color: T.accent, fontWeight: 700 }}>
                {init.code}
              </div>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{init.name}</span>
            </div>
        }

        {/* Name + description */}
        <Inp label="Trade Lane Name" value={name} onChange={setName} placeholder="Europe North" required />
        <Textarea label="Description" value={desc} onChange={setDesc} placeholder="Optional description…" rows={2} />
        <Inp label="Default Transit Days" value={String(transitDays)}
          onChange={v => setTransitDays(v.replace(/\D/g, ""))}
          placeholder="e.g. 25" mono hint="Average sea transit days — used for ETA suggestion in shipment form" />

        {/* Country assignments — only when editing */}
        {isEdit && (
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
              Assigned Countries
              <span style={{ marginLeft: 8, color: T.border, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                — search by name or ISO2 code
              </span>
            </div>

            {/* Autocomplete search */}
            <CountryCombobox
              placeholder="Add country…"
              excludeIso2s={countries.map(c => c.iso2)}
              onSelect={addCountry}
            />

            {/* Assigned list */}
            <div style={{ marginTop: 10, maxHeight: 260, overflowY: "auto",
              border: `1px solid ${T.border}`, borderRadius: 8, background: T.bg }}>
              {loadingC ? (
                <PageSpinner />
              ) : countries.length === 0 ? (
                <div style={{ padding: "20px 16px", fontFamily: T.body, fontSize: 13, color: T.border, fontStyle: "italic" }}>
                  No countries assigned yet — search above to add one.
                </div>
              ) : countries.map(c => (
                <div key={c.iso2} style={{ display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 14px", borderBottom: `1px solid ${T.border}22` }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700, width: 28, flexShrink: 0 }}>{c.iso2}</span>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1 }}>{c.name}</span>
                  {c.portCount > 0 && (
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{c.portCount} ports</span>
                  )}
                  <button onClick={() => removeCountry(c.iso2)}
                    style={{ background: "none", border: `1px solid ${T.danger}44`, borderRadius: 4,
                      color: T.danger, cursor: "pointer", padding: "2px 8px", fontSize: 11,
                      fontFamily: T.body, fontWeight: 600, flexShrink: 0, transition: "border-color .12s, background .12s" }}
                    onMouseEnter={e => { e.currentTarget.style.background = T.dangerBg; e.currentTarget.style.borderColor = T.danger; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.borderColor = `${T.danger}44`; }}>
                    ✕ Remove
                  </button>
                </div>
              ))}
            </div>

            {countries.length > 0 && (
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 6 }}>
                {countries.length} countr{countries.length !== 1 ? "ies" : "y"} assigned to this lane
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <Btn disabled={!valid} onClick={handleSave}>
            {isEdit ? "Save Changes" : "Add Trade Lane"}
          </Btn>
        </div>
      </div>
    );
  };

  const LANE_COLORS = {
    "FE":"info","SEA":"info","ISC":"amber","ME":"warning","EU-N":"success","EU-S":"success",
    "NAM":"default","CAR":"default","SAM":"default","WAF":"danger","EAF":"danger",
    "SAF":"danger","NAF":"warning","OCE":"default",
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Trade Lanes</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {lanes.length} FIATA high-level trade lanes · linked to countries
          </p>
        </div>
        {canManageMdm && <Btn onClick={() => setModal("add")} size="lg">＋ Add Lane</Btn>}
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
        ) : lanes.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No trade lanes yet. Restart the server to auto-seed FIATA lanes.
          </div>
        ) : lanes.map(l => (
          <div key={l.code}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <Badge variant={LANE_COLORS[l.code] || "default"}>{l.code}</Badge>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>{l.name}</span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{l.description || "—"}</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{l.countryCount} countries</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: l.transitDays ? T.text : T.border }}>
              {l.transitDays ? `${l.transitDays}d` : "—"}
            </span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...(canManageMdm ? [{ icon: "✎", label: "Edit",   onClick: () => setModal(l) }] : []),
                ...(canManageMdm ? [{ icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(l.code) }] : []),
              ]} />
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Trade Lane" onClose={() => setModal(null)} width={540}>
          <LaneForm onSave={async d => { await api.tradeLanes.create(d); setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Trade Lane" onClose={() => setModal(null)} width={600}>
          <LaneForm init={modal}
            onSave={async d => {
              await api.tradeLanes.update(modal.code, { name: d.name, description: d.description, transitDays: d.transitDays });
              await api.tradeLanes.setCountries(modal.code, d.iso2s);
              setModal(null);
              load();
            }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={`Remove trade lane "${confirm}"? Country assignments will also be removed.`}
          onConfirm={async () => { await api.tradeLanes.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── Shared: Country Locations Modal ──────────────────────────────────────────

export default MdmTradeLanesPage;