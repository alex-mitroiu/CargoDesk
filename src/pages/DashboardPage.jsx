import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
         Tooltip, Legend, ResponsiveContainer } from "recharts";
import { T, STATUSES, statusVariant, contractVariant, addDays, diffDays,
         currentWeekStart, MAX_RANGE_DAYS, teuOf, LANE_BADGE_VARIANT, todayIso, parseIso } from "../tokens";
import { api } from "../api";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Inp, Sel, ContractTypeInput, Textarea } from "../components/primitives/Form";
import PortCombobox from "../components/shared/PortCombobox";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import Pagination from "../components/primitives/Pagination";
import DatePicker from "../components/primitives/DatePicker";
import { useResizableColumns, ColResizer } from "../components/primitives/useResizableColumns.jsx";

// ─── Lane pair display ───────────────────────────────────────────────────────

const LanePair = ({ origin, dest }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    {origin
      ? <Badge variant={LANE_BADGE_VARIANT[origin] || "default"}>{origin}</Badge>
      : <span style={{ fontFamily: T.mono, fontSize: 12, color: T.border }}>—</span>}
    <span style={{ fontFamily: T.mono, fontSize: 16, color: T.textMuted, fontWeight: 700 }}>›</span>
    {dest
      ? <Badge variant={LANE_BADGE_VARIANT[dest] || "default"}>{dest}</Badge>
      : <span style={{ fontFamily: T.mono, fontSize: 12, color: T.border }}>—</span>}
  </div>
);

// ─── Port field — selected state + clear + linked-port alternatives ──────────

const PortField = ({ label, port, onSelect, placeholder }) => {
  const [links,   setLinks]   = useState([]);
  const [loadLnk, setLoadLnk] = useState(false);

  useEffect(() => {
    if (!port?.unlocode) { setLinks([]); return; }
    setLoadLnk(true);
    api.portLinks(port.unlocode)
      .then(rows => setLinks(rows || []))
      .catch(() => setLinks([]))
      .finally(() => setLoadLnk(false));
  }, [port?.unlocode]);

  return (
    <div>
      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>
        {label} <span style={{ color: T.danger }}>*</span>
      </div>

      {port?.unlocode ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Selected port row */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, background: T.bg, border: `1px solid ${T.accent}55`,
              borderRadius: 6, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>
                {port.unlocode}
              </span>
              {port.name && (
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                  {port.name}
                </span>
              )}
            </div>
            <button type="button" onClick={() => { onSelect(null); setLinks([]); }}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
                color: T.textMuted, cursor: "pointer", padding: "6px 10px", fontSize: 12 }}>✕</button>
          </div>

          {/* Linked port alternatives */}
          {loadLnk && (
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.border }}>
              Checking linked locations…
            </span>
          )}
          {!loadLnk && links.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
              <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, flexShrink: 0 }}>
                Covers linked:
              </span>
              {links.map(lp => (
                <button key={lp.unlocode} type="button"
                  title={lp.name || lp.unlocode}
                  onClick={() => onSelect({ unlocode: lp.unlocode, name: lp.name || "" })}
                  style={{
                    fontFamily: T.mono, fontSize: 10.5, fontWeight: 600,
                    color: T.textMuted, background: T.bg,
                    border: `1px solid ${T.border}`, borderRadius: 4,
                    padding: "2px 8px", cursor: "pointer",
                    transition: "border-color .1s, color .1s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}>
                  {lp.unlocode}
                </button>
              ))}
              <span style={{ fontFamily: T.body, fontSize: 10, color: T.border, fontStyle: "italic" }}>
                — click to switch
              </span>
            </div>
          )}
        </div>
      ) : (
        <PortCombobox placeholder={placeholder} onChange={onSelect} />
      )}
    </div>
  );
};

// ─── Coverage scope override button ─────────────────────────────────────────
// Disabled until Contract Management module is available.
// When enabled, marks the allocation as coverageScope="LINKED" meaning it
// intentionally covers linked port locations (e.g. "All West Coast US ports").

const OverrideBtn = () => {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block", flexShrink: 0 }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <button type="button" disabled
        style={{
          padding: "4px 12px", borderRadius: 6, cursor: "not-allowed",
          fontFamily: T.body, fontSize: 11, fontWeight: 600,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.border, opacity: 0.6, whiteSpace: "nowrap",
        }}>
        🔓 Override Coverage
      </button>
      {show && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 500,
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 10, padding: "12px 16px",
          boxShadow: "0 8px 28px rgba(0,0,0,.55)",
          minWidth: 280, maxWidth: 320,
        }}>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.warning, fontWeight: 700, marginBottom: 6 }}>
            🔒 Requires Contract Management
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.65 }}>
            Override allows this configuration to intentionally cover linked port locations —
            for example, a contract that covers <em>all West Coast US ports</em> rather than
            a single POL. This requires a Contract Management source to validate the declared
            coverage scope before it can be applied.
          </div>
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${T.border}44`,
            fontFamily: T.mono, fontSize: 10, color: T.border }}>
            Future value: coverageScope = "LINKED" | "CONTRACT:id"
          </div>
          {/* Tooltip arrow */}
          <div style={{
            position: "absolute", top: -6, right: 18,
            width: 10, height: 10, background: T.surface,
            borderLeft: `1px solid ${T.border}`, borderTop: `1px solid ${T.border}`,
            transform: "rotate(45deg)",
          }} />
        </div>
      )}
    </div>
  );
};

// ─── Conflict banner ──────────────────────────────────────────────────────────

const ConflictBanner = ({ conflicts, loading }) => {
  if (loading) return (
    <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted,
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 12px" }}>
      Checking for conflicts…
    </div>
  );
  if (!conflicts.exact.length && !conflicts.linked.length) return null;

  const accent = kind => kind === 'exact' ? T.danger : T.warning;

  const ConflictRow = ({ a, kind }) => (
    <div style={{ borderTop: `1px solid ${accent(kind)}22` }}>
      {/* Main conflict info */}
      <div style={{ padding: "8px 12px 4px", display: "flex", flexWrap: "wrap",
        gap: "4px 16px", alignItems: "center" }}>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: accent(kind), fontWeight: 700 }}>{a.id}</span>
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{a.carrierName}</span>
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>
          {a.pol} <span style={{ color: T.border }}>›</span> {a.pod}
        </span>
        {(a.originLane || a.destLane) && <div style={{ display: "flex" }}><LanePair origin={a.originLane} dest={a.destLane} /></div>}
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{a.effectiveDate} → {a.endDate}</span>
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 600 }}>{a.allocatedTEU} TEU</span>
      </div>
      {/* Link path — only for linked conflicts */}
      {kind === 'linked' && a.links?.length > 0 && (
        <div style={{ padding: "0 12px 8px 24px", display: "flex", flexDirection: "column", gap: 2 }}>
          {a.links.map((lk, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6,
              fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
              <span style={{ color: T.warning }}>↳</span>
              <span>Your</span>
              <span style={{ fontFamily: T.mono, color: T.warning, fontWeight: 700 }}>{lk.newPort}</span>
              <span style={{ color: T.textMuted }}>({lk.newLabel})</span>
              <span>is linked to their</span>
              <span style={{ fontFamily: T.mono, color: T.warning, fontWeight: 700 }}>{lk.theirPort}</span>
              <span style={{ color: T.textMuted }}>({lk.theirLabel})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {conflicts.exact.length > 0 && (
        <div style={{ background: T.dangerBg, border: `1px solid ${T.danger}55`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", fontFamily: T.body, fontSize: 12, color: T.danger, fontWeight: 600 }}>
            ⛔ {conflicts.exact.length} exact conflict{conflicts.exact.length > 1 ? "s" : ""} — same carrier, route and overlapping period
          </div>
          {conflicts.exact.map(a => <ConflictRow key={a.id} a={a} kind="exact" />)}
        </div>
      )}
      {conflicts.linked.length > 0 && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px 6px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.warning, fontWeight: 600 }}>
              ⚠ {conflicts.linked.length} linked-port overlap{conflicts.linked.length > 1 ? "s" : ""} — a linked port location matches an existing configuration
            </span>
            <OverrideBtn />
          </div>
          {conflicts.linked.map(a => <ConflictRow key={a.id} a={a} kind="linked" />)}
        </div>
      )}
    </div>
  );
};

// ─── AllocationForm ───────────────────────────────────────────────────────────

const AllocationForm = ({ init = {}, carriers, tradeLanes = [], onSave, onCancel }) => {
  const isEdit = !!init.id;

  // Core fields
  const [carrierCode,    setCarrierCode]    = useState(init.carrierCode    || carriers[0]?.code || "");
  const [teuStr,         setTeuStr]         = useState(init.allocatedTEU   ? String(init.allocatedTEU) : "");
  const [effectiveDate,  setEffectiveDate]  = useState(init.effectiveDate  || "");
  const [endDate,        setEndDate]        = useState(init.endDate        || "");
  const [notes,          setNotes]          = useState(init.notes          || "");
  const [alertThreshold, setAlertThreshold] = useState(init.alertThreshold ?? 80);
  const [serverErr,      setServerErr]      = useState("");

  // POL / POD
  const [polPort,  setPolPort]  = useState(init.pol ? { unlocode: init.pol,  name: "" } : null);
  const [podPort,  setPodPort]  = useState(init.pod ? { unlocode: init.pod,  name: "" } : null);

  // Lane auto-detection
  const [originLane,    setOriginLane]    = useState(init.originLane || "");
  const [destLane,      setDestLane]      = useState(init.destLane   || "");
  const [originOptions, setOriginOptions] = useState([]);
  const [destOptions,   setDestOptions]   = useState([]);
  const [laneOverride,  setLaneOverride]  = useState(false);
  const [laneLoading,   setLaneLoading]   = useState(false);

  // Conflict detection
  const [conflicts,       setConflicts]       = useState({ exact: [], linked: [] });
  const [conflictLoading, setConflictLoading] = useState(false);
  const conflictTimer = useRef(null);

  useEffect(() => {
    if (!carrierCode && carriers.length > 0) setCarrierCode(carriers[0].code);
  }, [carriers]);

  // On edit load: fetch lanes for existing ports
  useEffect(() => {
    if (init.pol) fetchLane(init.pol, setOriginLane, setOriginOptions, true);
    if (init.pod) fetchLane(init.pod, setDestLane,   setDestOptions,   true);
  }, []);

  const fetchLane = async (unlocode, setLane, setOptions, keepExisting = false) => {
    if (!unlocode) { setLane(""); setOptions([]); return; }
    setLaneLoading(true);
    try {
      const data = await api.portLanes(unlocode);
      setOptions(data.lanes || []);
      if (!keepExisting || !setLane.toString().includes(unlocode)) {
        if (data.primary) setLane(data.primary);
      }
    } catch {}
    setLaneLoading(false);
  };

  const handlePolSelect = port => {
    setPolPort(port);
    if (port) fetchLane(port.unlocode, setOriginLane, setOriginOptions);
    else { setOriginLane(""); setOriginOptions([]); }
  };

  const handlePodSelect = port => {
    setPodPort(port);
    if (port) fetchLane(port.unlocode, setDestLane, setDestOptions);
    else { setDestLane(""); setDestOptions([]); }
  };

  // Conflict check — debounced 500ms
  useEffect(() => {
    clearTimeout(conflictTimer.current);
    if (!carrierCode || !polPort?.unlocode || !podPort?.unlocode || !effectiveDate || !endDate) {
      setConflicts({ exact: [], linked: [] }); return;
    }
    conflictTimer.current = setTimeout(async () => {
      setConflictLoading(true);
      try {
        const data = await api.allocations.conflicts({
          carrierCode, pol: polPort.unlocode, pod: podPort.unlocode,
          effectiveDate, endDate, excludeId: init.id || '',
        });
        setConflicts(data);
      } catch {}
      setConflictLoading(false);
    }, 500);
    return () => clearTimeout(conflictTimer.current);
  }, [carrierCode, polPort?.unlocode, podPort?.unlocode, effectiveDate, endDate]);

  const handleEffectiveChange = val => {
    setEffectiveDate(val); setServerErr("");
    if (endDate && val && endDate < val) setEndDate(val);
    if (endDate && val) { const m = addDays(val, 90); if (endDate > m) setEndDate(m); }
  };

  const teu    = parseInt(teuStr) || 0;
  const thresh = Math.min(100, Math.max(1, parseInt(alertThreshold) || 80));
  const valid  = carrierCode && teu > 0 && effectiveDate && endDate && endDate >= effectiveDate
               && polPort?.unlocode && podPort?.unlocode && originLane && destLane;

  const threshColour = thresh >= 90 ? T.danger : thresh >= 75 ? T.warning : T.success;

  const handleSave = async () => {
    if (!valid) return;
    try {
      await onSave({
        carrierCode, allocatedTEU: teu, effectiveDate, endDate, notes,
        alertThreshold: thresh,
        pol: polPort.unlocode, pod: podPort.unlocode,
        originLane, destLane,
        tradeLane: `${originLane}_${destLane}`,
      });
    } catch (e) { setServerErr(e.message || "Could not save — check for overlapping periods."); }
  };

  const laneSelOpts = (options, fallback) => [
    ...((options.length ? options : tradeLanes).map(l => ({ value: l.code, label: `${l.code} – ${l.name}` }))),
    ...(fallback && !options.find(o => o.code === fallback) ? [{ value: fallback, label: fallback }] : []),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Carrier */}
      <Sel label="Carrier" value={carrierCode}
        onChange={v => { setCarrierCode(v); setServerErr(""); }} required
        options={carriers.map(c => ({ value: c.code, label: `${c.code} – ${c.name}` }))} />

      {/* POL / POD */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <PortField label="Port of Loading (POL)"   port={polPort} onSelect={handlePolSelect} placeholder="Search origin port…" />
        <PortField label="Port of Discharge (POD)" port={podPort} onSelect={handlePodSelect} placeholder="Search destination port…" />
      </div>

      {/* Auto-detected trade lane pair */}
      {(polPort || podPort) && (
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: laneOverride ? 12 : 0 }}>
            <div>
              <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
                Trade Lane Route {laneLoading && <span style={{ fontWeight: 400, color: T.border }}>· detecting…</span>}
              </div>
              <LanePair origin={originLane} dest={destLane} />
            </div>
            <button type="button" onClick={() => setLaneOverride(o => !o)}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
                color: T.textMuted, cursor: "pointer", padding: "4px 10px",
                fontFamily: T.body, fontSize: 11, flexShrink: 0 }}>
              {laneOverride ? "✓ Done" : "✎ Override"}
            </button>
          </div>
          {laneOverride && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "end", marginTop: 4 }}>
              <Sel label="Origin Lane" value={originLane} onChange={setOriginLane}
                options={laneSelOpts(originOptions, originLane)} />
              <div style={{ fontFamily: T.mono, fontSize: 18, color: T.textMuted, fontWeight: 700, paddingBottom: 9, userSelect: "none" }}>›</div>
              <Sel label="Destination Lane" value={destLane} onChange={setDestLane}
                options={laneSelOpts(destOptions, destLane)} />
            </div>
          )}
        </div>
      )}

      {/* TEU */}
      <Inp label="Allocated Space (TEU)" value={teuStr} onChange={setTeuStr}
        type="number" placeholder="100" required hint="Total TEU awarded by this carrier for the period" />

      {/* Effective Period */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 12 }}>
          Effective Period <span style={{ color: T.danger }}>*</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <DatePicker label="Effective From" value={effectiveDate} onChange={handleEffectiveChange} placeholder="Start date…" />
          <DatePicker label="Effective To" value={endDate}
            onChange={v => { setEndDate(v); setServerErr(""); }}
            minDate={effectiveDate || undefined}
            maxDate={effectiveDate ? addDays(effectiveDate, 90) : undefined}
            placeholder="End date…" disabled={!effectiveDate} />
        </div>
        {effectiveDate && endDate && (
          <div style={{ marginTop: 8, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
            {diffDays(effectiveDate, endDate) + 1} day period · max 90 days per configuration
          </div>
        )}
      </div>

      {/* Conflict detection banner */}
      <ConflictBanner conflicts={conflicts} loading={conflictLoading} />

      {/* Alert Threshold */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>
          Utilisation Alert Threshold
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <input type="range" min={10} max={100} step={5} value={thresh}
            onChange={e => setAlertThreshold(Number(e.target.value))}
            style={{ flex: 1, accentColor: threshColour, cursor: "pointer" }} />
          <div style={{ minWidth: 52, textAlign: "center", fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: threshColour }}>
            {thresh}%
          </div>
        </div>
        <div style={{ marginTop: 10, background: T.border, borderRadius: 4, height: 6, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${thresh}%`, background: threshColour, transition: "width .15s, background .15s" }} />
        </div>
        <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 6 }}>
          Bar turns <span style={{ color: threshColour, fontWeight: 600 }}>
            {thresh >= 90 ? "red — critical" : thresh >= 75 ? "amber — warning" : "green — normal"}
          </span> above this level
        </div>
      </div>

      {/* Notes */}
      <Textarea label="Notes" value={notes} onChange={setNotes} rows={3}
        placeholder="Contract caveats, rollover terms, special conditions…" />

      {serverErr && (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.danger, background: T.dangerBg,
          border: `1px solid ${T.danger}44`, borderRadius: 6, padding: "8px 12px" }}>
          {serverErr}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Configuration"}
        </Btn>
      </div>
    </div>
  );
};

// ─── Page: Carrier Registry ───────────────────────────────────────────────────

const CarriersPage = ({ carriers, onAdd, onEdit, onDelete }) => {
  const [modal, setModal]   = useState(null); // null | "add" | carrier obj
  const [confirm, setConfirm] = useState(null);
  const { template: carrTpl, startResize: carrResize } = useResizableColumns("mdm-carriers", [130,200,160]);
  const carrHdrs = ["Code","Name","Actions"];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Carrier Registry</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {carriers.length} carrier{carriers.length !== 1 ? "s" : ""} · reference database for shipments &amp; allocations
          </p>
        </div>
        <Btn onClick={() => setModal("add")} size="lg">＋ Add Carrier</Btn>
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: carrTpl,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {carrHdrs.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < carrHdrs.length - 1 && <ColResizer onStart={e => carrResize(i, e)} />}
            </div>
          ))}
        </div>

        {carriers.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No carriers yet. Add your first carrier above.
          </div>
        ) : carriers.map(c => (
          <div key={c.code} style={{ display: "grid", gridTemplateColumns: carrTpl,
            padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
            transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{c.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{c.name}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" variant="secondary" onClick={() => setModal(c)}>✎ Edit</Btn>
              <Btn size="sm" variant="danger"    onClick={() => setConfirm(c.code)}>✕ Remove</Btn>
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Carrier" onClose={() => setModal(null)}>
          <CarrierForm existing={carriers}
            onSave={data => { onAdd(data); setModal(null); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Carrier" onClose={() => setModal(null)}>
          <CarrierForm init={modal} existing={carriers}
            onSave={data => { onEdit(modal.code, data); setModal(null); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Remove carrier "${confirm}" from the registry? Existing shipments referencing this code will not be deleted.`}
          onConfirm={() => { onDelete(confirm); setConfirm(null); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── Page: Shipments List ─────────────────────────────────────────────────────


const ShipmentsPage = ({ shipments, containers, carriers, onSelect, onDelete, onNew }) => {
  const [confirm, setConfirm] = useState(null);
  const teuFor = id => containers.filter(c => c.shipmentId === id).reduce((s, c) => s + teuOf(c.size), 0);
  const { template: shipTpl, startResize: shipResize } = useResizableColumns("shipments", [140,70,70,150,165,46,60,130,90]);
  const shipHdrs = ["Shipment ID","POL","POD","Carrier","Contract","TEU","Status",""];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Shipments</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {shipments.length} total · {shipments.filter(s => s.status === "Active").length} active
          </p>
        </div>
        <Btn onClick={onNew} size="lg" disabled={carriers.length === 0}>＋ New Shipment</Btn>
      </div>

      {carriers.length === 0 && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8,
          padding: "12px 18px", fontFamily: T.body, fontSize: 13, color: T.warning, marginBottom: 18 }}>
          ⚠ Carrier Registry is empty. Go to <strong>Carrier Registry</strong> and add at least one carrier before creating shipments.
        </div>
      )}

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: shipTpl,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {shipHdrs.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < shipHdrs.length - 1 && <ColResizer onStart={e => shipResize(i, e)} />}
            </div>
          ))}
        </div>

        {shipments.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No shipments yet. Create your first one above.
          </div>
        ) : shipments.map(s => {
          const carrier = carriers.find(c => c.code === s.carrierCode);
          return (
            <div key={s.id} onClick={() => onSelect(s.id)}
              style={{ display: "grid", gridTemplateColumns: shipTpl,
                padding: "14px 20px", borderBottom: `1px solid ${T.border}22`,
                cursor: "pointer", alignItems: "center", transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textCode, fontWeight: 700 }}>{s.id}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pol}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pod}</span>
              <div>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{s.carrierCode}</span>
                {carrier && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}> · {carrier.name}</span>}
              </div>
              <Badge variant={contractVariant(s.contractType)}>{s.contractType}</Badge>
              <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>{teuFor(s.id)}</span>
              <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
              <Btn size="sm" variant="danger" onClick={e => { e.stopPropagation(); setConfirm(s.id); }}>
                ✕ Remove
              </Btn>
            </div>
          );
        })}
      </div>

      {confirm && (
        <ConfirmModal
          message={`Remove shipment ${confirm} and all its containers? This cannot be undone.`}
          onConfirm={() => { onDelete(confirm); setConfirm(null); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

// ─── Page: Shipment Detail ────────────────────────────────────────────────────

const ShipmentDetailPage = ({ shipment, containers, carriers, onBack, onUpdate, onAddContainer, onEditContainer, onDeleteContainer }) => {
  const [ctrModal,  setCtrModal]  = useState(null); // null | "add" | container obj
  const [editShp,   setEditShp]   = useState(false);
  const [confirmCtr, setConfirmCtr] = useState(null);
  const { template: dashCtrTemplate, startResize: dashCtrStartResize } = useResizableColumns("dashboard-carriers", [200,90,130,70,140]);
  const dashCtrHeaders = ["Container No.","Size","Type","TEU","Actions"];
  const carrier  = carriers.find(c => c.code === shipment.carrierCode);
  const ctrs     = containers.filter(c => c.shipmentId === shipment.id);
  const totalTEU = ctrs.reduce((s, c) => s + teuOf(c.size), 0);

  const InfoCard = ({ label, value, color, mono }) => (
    <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px" }}>
      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: mono ? T.mono : T.body, fontSize: 16, fontWeight: 700,
        color: color || T.text, wordBreak: "break-word" }}>{value}</div>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
        <Btn variant="secondary" onClick={onBack}>← Back</Btn>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ fontFamily: T.head, fontSize: 24, fontWeight: 800, color: T.text, margin: 0 }}>{shipment.id}</h1>
            <Badge variant={statusVariant(shipment.status)}>{shipment.status}</Badge>
          </div>
          <p style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted, margin: "3px 0 0" }}>
            {shipment.pol} → {shipment.pod} · created {shipment.createdAt}
          </p>
        </div>
        <Btn variant="secondary" onClick={() => setEditShp(true)}>✎ Edit Shipment</Btn>
      </div>

      {/* Info cards row 1 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 14 }}>
        <InfoCard label="Port of Loading"   value={shipment.pol} color={T.textCode} mono />
        <InfoCard label="Port of Discharge" value={shipment.pod} color={T.textCode} mono />
        <InfoCard label="Carrier" value={`${shipment.carrierCode}${carrier ? ` · ${carrier.name}` : ""}`} color={T.accent} mono />
        <InfoCard label="Total TEU" value={`${totalTEU} TEU`} mono />
      </div>

      {/* Info cards row 2 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 22 }}>
        <InfoCard label="ETD" value={shipment.etd || "—"} mono />
        <InfoCard label="ETA" value={shipment.eta || "—"} mono />
        <InfoCard label="Vessel"
          value={shipment.vessel || (shipment.vesselImo ? shipment.vesselImo : "—")}
          color={shipment.vessel ? T.text : T.border}
          sub={shipment.vesselImo ? `IMO ${shipment.vesselImo}` : null}
        />
        <InfoCard label="Voyage" value={shipment.voyage || "—"} mono />
      </div>

      {/* Contract + references */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "16px 20px", marginBottom: 22 }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 12 }}>Contract &amp; References</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 14 }}>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Contract Type</div>
            <Badge variant={contractVariant(shipment.contractType)}>{shipment.contractType}</Badge>
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Incoterm</div>
            {shipment.incoterm
              ? <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textCode, fontWeight: 700 }}>
                  {shipment.incoterm}
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontWeight: 400, marginLeft: 6 }}>
                    {INCOTERMS_2020.find(t => t.code === shipment.incoterm)?.name || ""}
                  </span>
                </span>
              : <span style={{ fontFamily: T.body, fontSize: 13, color: T.border }}>—</span>
            }
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Booking Ref</div>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.bookingRef ? T.textCode : T.border }}>{shipment.bookingRef || "—"}</span>
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>B/L Number</div>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.blNumber ? T.textCode : T.border }}>{shipment.blNumber || "—"}</span>
          </div>
        </div>
        {shipment.contractNotes && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}33` }}>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Notes</div>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.6 }}>{shipment.contractNotes}</span>
          </div>
        )}
      </div>

      {/* Cargo Details */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "15px 20px", borderBottom: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 style={{ fontFamily: T.head, fontSize: 17, fontWeight: 700, color: T.text, margin: 0 }}>Cargo Details</h2>
            <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "2px 0 0" }}>
              {ctrs.length} container{ctrs.length !== 1 ? "s" : ""} · {totalTEU} TEU total
            </p>
          </div>
          <Btn onClick={() => setCtrModal("add")}>＋ Add Container</Btn>
        </div>

        {ctrs.length === 0 ? (
          <div style={{ padding: 36, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No containers yet. Add one above.
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: dashCtrTemplate,
              padding: "9px 20px", borderBottom: `1px solid ${T.border}` }}>
              {dashCtrHeaders.map((h, i) => (
                <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
                  {h}{i < dashCtrHeaders.length - 1 && <ColResizer onStart={e => dashCtrStartResize(i, e)} />}
                </div>
              ))}
            </div>
            {ctrs.map(c => (
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: dashCtrTemplate,
                padding: "12px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textCode, fontWeight: 600 }}>{c.number}</span>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{c.size}ft</span>
                <Badge>{c.type}</Badge>
                <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.text }}>{teuOf(c.size)}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn size="sm" variant="secondary" onClick={() => setCtrModal(c)}>Edit</Btn>
                  <Btn size="sm" variant="danger"    onClick={() => setConfirmCtr(c.id)}>✕</Btn>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Modals */}
      {ctrModal && (
        <Modal title={ctrModal === "add" ? "Add Container" : "Edit Container"} onClose={() => setCtrModal(null)}>
          <ContainerForm init={ctrModal === "add" ? {} : ctrModal}
            onSave={form => {
              ctrModal === "add" ? onAddContainer(shipment.id, form) : onEditContainer(ctrModal.id, form);
              setCtrModal(null);
            }}
            onCancel={() => setCtrModal(null)} />
        </Modal>
      )}
      {editShp && (
        <Modal title="Edit Shipment" onClose={() => setEditShp(false)} width={560}>
          <ShipmentForm init={shipment} carriers={carriers}
            onSave={form => { onUpdate(shipment.id, form); setEditShp(false); }}
            onCancel={() => setEditShp(false)} />
        </Modal>
      )}
      {confirmCtr && (
        <ConfirmModal
          message="Remove this container from the shipment?"
          onConfirm={() => { onDeleteContainer(confirmCtr); setConfirmCtr(null); }}
          onCancel={() => setConfirmCtr(null)} />
      )}
    </div>
  );
};


// ─── Sparkline ────────────────────────────────────────────────────────────────

const Sparkline = ({ data = [], color = "#888", width = 76, height = 26 }) => {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1);
  const pad = 3;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - v / max) * (height - pad * 2);
    return [x, y];
  });
  const pathD = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
      <path d={pathD} fill="none" stroke={color} strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round" opacity={0.7} />
      <circle cx={lx} cy={ly} r={2.5} fill={color} />
    </svg>
  );
};

// ─── Delta badge ──────────────────────────────────────────────────────────────

const DeltaBadge = ({ delta, prevTEU }) => {
  if (delta === null || delta === undefined) return null;
  if (prevTEU === 0 && delta === 0) return (
    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.border }}>no prev data</span>
  );
  const color = delta > 5 ? T.success : delta < -5 ? T.danger : T.textMuted;
  const arrow = delta > 5 ? "↑" : delta < -5 ? "↓" : "→";
  return (
    <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, color,
      display: "flex", alignItems: "center", gap: 2 }}>
      {arrow} {delta > 0 ? "+" : ""}{delta}%
      <span style={{ fontWeight: 400, color: T.border, marginLeft: 2, fontSize: 9.5 }}>vs prev</span>
    </span>
  );
};

// ─── Page: Dashboard ──────────────────────────────────────────────────────────

// ─── Date range helpers ────────────────────────────────────────────────────────


const DashboardPage = ({ shipments, containers, carriers, allocations, onAddAlloc, onEditAlloc, onDeleteAlloc, pendingRenew = null, onPendingRenewClear }) => {
  const [allocModal,   setAllocModal]   = useState(null);
  const [confirmAlloc, setConfirmAlloc] = useState(null);
  const [tradeLanes,   setTradeLanes]   = useState([]);
  const [renewInit,    setRenewInit]    = useState(null);
  const [archiveOpen,  setArchiveOpen]  = useState(false);
  const { template: allocTemplate, startResize: allocStartResize } = useResizableColumns("dashboard-allocs", [150,200,100,150,140,100,130]);
  const allocHeaders = ["Carrier","Name","TEU","Effective Period","Consumed","Remaining","Actions"];

  // Open renew modal when navigated from Archive page
  useEffect(() => {
    if (pendingRenew) {
      setRenewInit(pendingRenew);
      setAllocModal("add");
      onPendingRenewClear?.();
    }
  }, [pendingRenew]);

  useEffect(() => { api.tradeLanes.list().then(setTradeLanes).catch(() => {}); }, []);
  const [rangePickerOpen, setRangePickerOpen] = useState(false);

  // Date range state — defaults to current Mon-Sun
  const [rangeStart, setRangeStart] = useState(() => currentWeekStart());
  const [rangeEnd,   setRangeEnd]   = useState(() => addDays(currentWeekStart(), 6));

  const handleStartChange = newStart => {
    setRangeStart(newStart);
    // Clamp end to start+MAX or keep if still valid
    const maxEnd = addDays(newStart, MAX_RANGE_DAYS);
    if (!rangeEnd || rangeEnd < newStart) setRangeEnd(newStart);
    else if (rangeEnd > maxEnd) setRangeEnd(maxEnd);
  };

  const handleEndChange = newEnd => setRangeEnd(newEnd);

  const spanDays  = rangeStart && rangeEnd ? diffDays(rangeStart, rangeEnd) + 1 : 7;
  const shiftRange = n => {
    const shift = n * spanDays;
    setRangeStart(s => addDays(s, shift));
    setRangeEnd(e => addDays(e, shift));
  };
  const goToday = () => {
    const ws = currentWeekStart();
    setRangeStart(ws);
    setRangeEnd(addDays(ws, 6));
  };

  // Active allocations: those whose effective period overlaps the selected range
  const activeAllocations = useMemo(() =>
    allocations.filter(a => {
      if (!a.effectiveDate || !a.endDate) return true;
      return a.effectiveDate <= rangeEnd && a.endDate >= rangeStart;
    }),
    [allocations, rangeStart, rangeEnd]
  );

  // Shipments with ETD (or createdAt) in range
  const rangeShipments = useMemo(() => shipments.filter(s => {
    const ref = s.etd || s.createdAt || "";
    return ref >= rangeStart && ref <= rangeEnd;
  }), [shipments, rangeStart, rangeEnd]);

  const today = todayIso();

  // Split allocations: current (not expired) vs archived (expired)
  const currentAllocations  = allocations.filter(a => a.endDate >= today);
  // TEU consumed per carrier — all shipments in range, all contract types
  const consumedMap = useMemo(() => {
    const m = {};
    rangeShipments.forEach(s => {
      const teu = containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + teuOf(c.size), 0);
      m[s.carrierCode] = (m[s.carrierCode] || 0) + teu;
    });
    return m;
  }, [rangeShipments, containers]);


  // Trend data: delta vs previous equivalent period + 6-week sparkline
  const carrierTrends = useMemo(() => {
    const periodDays = diffDays(rangeStart, rangeEnd) + 1;
    const prevEnd    = addDays(rangeStart, -1);
    const prevStart  = addDays(prevEnd, -(periodDays - 1));
    const allCodes   = [...new Set(allocations.map(a => a.carrierCode))];
    const trends     = {};

    allCodes.forEach(code => {
      // Current TEU from consumedMap (already scoped to selected range)
      const currentTEU = consumedMap[code] || 0;

      // Previous period TEU
      const prevTEU = shipments
        .filter(s => s.carrierCode === code && s.etd >= prevStart && s.etd <= prevEnd)
        .reduce((acc, s) =>
          acc + containers.filter(c => c.shipmentId === s.id)
                          .reduce((a2, c) => a2 + teuOf(c.size), 0), 0);

      // Delta %
      const delta = prevTEU > 0
        ? Math.round(((currentTEU - prevTEU) / prevTEU) * 100)
        : currentTEU > 0 ? 100 : 0;

      // 6-week sparkline (fixed weekly buckets, most recent on right)
      const today  = todayIso();
      const sparkData = Array.from({ length: 6 }, (_, i) => {
        const wEnd   = addDays(today, -(5 - i) * 7);
        const wStart = addDays(wEnd, -6);
        return shipments
          .filter(s => s.carrierCode === code && s.etd >= wStart && s.etd <= wEnd)
          .reduce((acc, s) =>
            acc + containers.filter(c => c.shipmentId === s.id)
                            .reduce((a2, c) => a2 + teuOf(c.size), 0), 0);
      });

      trends[code] = { delta, prevTEU, sparkData };
    });

    return trends;
  }, [allocations, shipments, containers, consumedMap, rangeStart, rangeEnd]);

  // Chart: group by carrier — consumption is total across all contract types
  const chartData = useMemo(() => {
    const byCarrier = {};
    activeAllocations.forEach(a => {
      if (!byCarrier[a.carrierCode]) byCarrier[a.carrierCode] = { allocated: 0, consumed: 0 };
      byCarrier[a.carrierCode].allocated += a.allocatedTEU;
      byCarrier[a.carrierCode].consumed   = consumedMap[a.carrierCode] || 0;
    });
    return Object.entries(byCarrier).map(([code, d]) => ({
      carrier: code,
      name: carriers.find(c => c.code === code)?.name || code,
      consumed: d.consumed,
      remaining: Math.max(0, d.allocated - d.consumed),
      total: d.allocated,
    }));
  }, [activeAllocations, consumedMap, carriers]);

  const totalAlloc    = activeAllocations.reduce((s, a) => s + a.allocatedTEU, 0);

  // Color palette for carrier lines
  const CARRIER_COLORS = [
    "#6366f1","#22c55e","#f59e0b","#3b82f6",
    "#ec4899","#8b5cf6","#06b6d4","#ef4444","#10b981","#f97316",
  ];

  // Trend chart data: reshape sparkData arrays into recharts [{week, MAEU, HLCU, ...}]
  const trendChartData = useMemo(() => {
    const today        = todayIso();
    const activeCodesSet = new Set(activeAllocations.map(a => a.carrierCode));
    const activeCodes  = [...activeCodesSet];
    return Array.from({ length: 6 }, (_, i) => {
      const weekEnd = addDays(today, -(5 - i) * 7);
      const label   = parseIso(weekEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      const pt      = { week: label };
      activeCodes.forEach(code => {
        pt[code] = carrierTrends[code]?.sparkData[i] ?? 0;
      });
      return pt;
    });
  }, [carrierTrends, activeAllocations]);

  const trendCarriers = [...new Set(activeAllocations.map(a => a.carrierCode))];

  const totalConsumed = chartData.reduce((s, d) => s + d.consumed, 0);
  const totalRemain   = Math.max(0, totalAlloc - totalConsumed);

  const TooltipContent = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const d = chartData.find(x => x.carrier === label);
    return (
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 16px" }}>
        <div style={{ fontFamily: T.mono, fontWeight: 700, color: T.accent, marginBottom: 8, fontSize: 13 }}>{label} · {d?.name}</div>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.success }}>Active: {d?.consumed} TEU</div>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Remaining: {d?.remaining} TEU</div>
        <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text,
          borderTop: `1px solid ${T.border}`, marginTop: 8, paddingTop: 8 }}>Total: {d?.total} TEU</div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Consumption Dashboard</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            TEU allocation &amp; consumption · 20ft = 1 TEU · 40ft = 2 TEU
          </p>
        </div>
      </div>

      {/* ── Date range picker ── */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "16px 20px", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
          {/* Navigation */}
          <Btn variant="secondary" size="sm" onClick={() => shiftRange(-1)}>← Prev</Btn>

          {/* Date range pickers */}
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "end" }}>
            <DatePicker
              label="From"
              value={rangeStart}
              onChange={handleStartChange}
              placeholder="Start date…"
            />
            <div style={{ fontFamily: T.mono, fontSize: 18, color: T.textMuted, paddingBottom: 9, userSelect: "none" }}>—</div>
            <DatePicker
              label="To"
              value={rangeEnd}
              onChange={handleEndChange}
              minDate={rangeStart}
              maxDate={rangeStart ? addDays(rangeStart, MAX_RANGE_DAYS) : undefined}
              placeholder="End date…"
            />
          </div>

          <Btn variant="secondary" size="sm" onClick={() => shiftRange(1)}>Next →</Btn>
          <Btn variant="ghost" size="sm" onClick={goToday}
            style={{ borderLeft: `1px solid ${T.border}`, paddingLeft: 14 }}>
            This Week
          </Btn>
        </div>

        {/* Range summary */}
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 14,
          borderTop: `1px solid ${T.border}33`, paddingTop: 10 }}>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
            {spanDays} day{spanDays !== 1 ? "s" : ""} · max {MAX_RANGE_DAYS}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            {rangeShipments.length} shipment{rangeShipments.length !== 1 ? "s" : ""} with ETD in range
          </span>
          {activeAllocations.length !== allocations.length && (
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.accent }}>
              ↳ {activeAllocations.length} of {allocations.length} space configs active in this period
            </span>
          )}
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 26 }}>
        {[
          { label: "Total Allocated",      value: totalAlloc,    color: T.text,    sub: `${allocations.length} configuration${allocations.length !== 1 ? "s" : ""}` },
          { label: "Active Consumption",   value: totalConsumed, color: T.success, sub: `${totalAlloc > 0 ? ((totalConsumed / totalAlloc) * 100).toFixed(1) : 0}% of total utilized` },
          { label: "Remaining Capacity",   value: totalRemain,   color: T.accent,  sub: "available to book" },
        ].map((k, i) => (
          <div key={i} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 24px" }}>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>{k.label}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, margin: "8px 0 4px" }}>
              <span style={{ fontFamily: T.mono, fontSize: 36, fontWeight: 700, color: k.color }}>{k.value}</span>
              <span style={{ fontFamily: T.mono, fontSize: 14, color: T.textMuted }}>TEU</span>
            </div>
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Charts row */}
      {chartData.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>

          {/* Left: TEU by Carrier (stacked bar) */}
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 20px 14px" }}>
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 3px" }}>TEU by Carrier</h2>
              <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>
                Awarded vs consumed for the selected period
              </p>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                <XAxis dataKey="carrier" tick={{ fontFamily: T.mono, fontSize: 11, fill: T.textMuted }} axisLine={{ stroke: T.border }} tickLine={false} />
                <YAxis tick={{ fontFamily: T.body, fontSize: 10, fill: T.textMuted }} axisLine={false} tickLine={false} />
                <Tooltip content={<TooltipContent />} cursor={{ fill: T.border + "44" }} />
                <Legend wrapperStyle={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, paddingTop: 10 }} />
                <Bar dataKey="consumed"  name="Consumed"   stackId="s" fill={T.success} />
                <Bar dataKey="remaining" name="Remaining"  stackId="s" fill={T.borderMid} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Right: 6-week trend line chart */}
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 20px 14px" }}>
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 3px" }}>6-Week TEU Trend</h2>
              <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: 0 }}>
                Weekly shipment consumption per carrier — last 6 weeks
              </p>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trendChartData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                <XAxis dataKey="week" tick={{ fontFamily: T.mono, fontSize: 10, fill: T.textMuted }} axisLine={{ stroke: T.border }} tickLine={false} />
                <YAxis tick={{ fontFamily: T.body, fontSize: 10, fill: T.textMuted }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
                    fontFamily: T.body, fontSize: 12 }}
                  labelStyle={{ color: T.text, fontWeight: 600, marginBottom: 4 }}
                  itemStyle={{ color: T.textMuted }}
                  formatter={(v, name) => [`${v} TEU`, name]}
                  cursor={{ stroke: T.border, strokeWidth: 1 }}
                />
                <Legend wrapperStyle={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, paddingTop: 10 }} />
                {trendCarriers.map((code, i) => (
                  <Line
                    key={code}
                    type="monotone"
                    dataKey={code}
                    stroke={CARRIER_COLORS[i % CARRIER_COLORS.length]}
                    strokeWidth={2}
                    dot={{ r: 3, fill: CARRIER_COLORS[i % CARRIER_COLORS.length] }}
                    activeDot={{ r: 5 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

        </div>
      )}

      {/* Space Configuration Table */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "15px 20px", borderBottom: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 style={{ fontFamily: T.head, fontSize: 17, fontWeight: 700, color: T.text, margin: 0 }}>Space Configurations</h2>
            <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "2px 0 0" }}>
              Awarded TEU per carrier &amp; contract — click ✎ to edit, ＋ to add a new one
            </p>
          </div>
          <Btn onClick={() => setAllocModal("add")} disabled={carriers.length === 0}>＋ Add Configuration</Btn>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: allocTemplate,
          padding: "9px 20px", borderBottom: `1px solid ${T.border}` }}>
          {allocHeaders.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < allocHeaders.length - 1 && <ColResizer onStart={e => allocStartResize(i, e)} />}
            </div>
          ))}
        </div>

        {currentAllocations.length === 0 ? (
          <div style={{ padding: 36, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No configurations yet. Use "+ Add Configuration" to set up carrier space allocations.
          </div>
        ) : currentAllocations.map(a => {
          const isActive   = activeAllocations.some(x => x.id === a.id);
          const consumed   = isActive ? (consumedMap[a.carrierCode] || 0) : 0;
          const remaining  = Math.max(0, a.allocatedTEU - consumed);
          const pct        = a.allocatedTEU > 0 ? (consumed / a.allocatedTEU) * 100 : 0;
          const carrier    = carriers.find(c => c.code === a.carrierCode);
          const thresh     = a.alertThreshold ?? 80;
          const barColour  = pct >= 100 ? T.danger : pct >= thresh ? (thresh >= 90 ? T.danger : T.warning) : T.success;
          return (
            <div key={a.id}
              style={{ display: "grid", gridTemplateColumns: allocTemplate,
                padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                opacity: isActive ? 1 : 0.45, transition: "background .1s, opacity .2s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{a.carrierCode}</span>
                {(a.originLane || a.destLane) && <div style={{ display: "flex" }}><LanePair origin={a.originLane} dest={a.destLane} /></div>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{carrier?.name || "—"}</span>
                {(a.pol && a.pod) && (
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                    {a.pol} <span style={{ color: T.border }}>›</span> {a.pod}
                  </span>
                )}
                {a.notes && (
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontStyle: "italic",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
                    {a.notes}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{a.allocatedTEU} TEU</span>
                {isActive && (
                  <>
                    <div style={{ background: T.border, borderRadius: 4, height: 4, width: 72, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.min(100, pct)}%`,
                        background: barColour, transition: "width .4s" }} />
                    </div>
                    <span style={{ fontFamily: T.mono, fontSize: 9.5, color: barColour }}>{pct.toFixed(0)}% <span style={{ color: T.border }}>/ {thresh}%</span></span>
                  </>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontFamily: T.mono, fontSize: 10.5, color: isActive ? T.success : T.textMuted }}>
                  {a.effectiveDate || "—"}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>
                  {a.endDate ? `→ ${a.endDate}` : ""}
                </span>
                {isActive && (
                  <span style={{ fontFamily: T.body, fontSize: 9.5, color: T.success, fontWeight: 600 }}>● Active</span>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13,
                  color: isActive ? (consumed > 0 ? T.success : T.textMuted) : T.border,
                  fontWeight: 600 }}>
                  {isActive ? `${consumed} TEU` : "—"}
                </span>
                {isActive && (() => {
                  const trend = carrierTrends[a.carrierCode];
                  if (!trend) return null;
                  const sparkColor = trend.delta > 5 ? T.success : trend.delta < -5 ? T.danger : T.textMuted;
                  return (
                    <>
                      <DeltaBadge delta={trend.delta} prevTEU={trend.prevTEU} />
                      <Sparkline data={trend.sparkData} color={sparkColor} />
                    </>
                  );
                })()}
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 600,
                color: isActive ? (remaining === 0 ? T.danger : remaining < 10 ? T.warning : T.textMuted) : T.border }}>
                {isActive ? `${remaining} TEU` : "—"}
              </span>
              <div style={{ display: "flex", gap: 5 }}>
                <Btn size="sm" variant="secondary" onClick={() => setAllocModal(a)}>✎ Edit</Btn>
                <Btn size="sm" variant="danger"    onClick={() => setConfirmAlloc(a.id)}>✕</Btn>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modals */}





      {allocModal === "add" && (
        <Modal title={renewInit ? "Renew Space Configuration" : "Add Space Configuration"} onClose={() => { setAllocModal(null); setRenewInit(null); }} width={620} minHeight={620}>
          <AllocationForm init={renewInit || {}} carriers={carriers} tradeLanes={tradeLanes}
            onSave={async form => { await onAddAlloc(form); setAllocModal(null); setRenewInit(null); }}
            onCancel={() => { setAllocModal(null); setRenewInit(null); }} />
        </Modal>
      )}
      {allocModal && allocModal !== "add" && (
        <Modal title="Edit Space Configuration" onClose={() => setAllocModal(null)} width={620} minHeight={620}>
          <AllocationForm init={allocModal} carriers={carriers} tradeLanes={tradeLanes}
            onSave={async form => { await onEditAlloc(allocModal.id, form); setAllocModal(null); }}
            onCancel={() => setAllocModal(null)} />
        </Modal>
      )}
      {confirmAlloc && (
        <ConfirmModal
          message="Remove this space configuration? Existing shipments will not be affected."
          onConfirm={() => { onDeleteAlloc(confirmAlloc); setConfirmAlloc(null); }}
          onCancel={() => setConfirmAlloc(null)} />
      )}
    </div>
  );
};

export default DashboardPage;