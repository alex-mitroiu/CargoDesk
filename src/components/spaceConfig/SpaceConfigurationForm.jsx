import { useState, useEffect, useMemo } from "react";
import useSaving from "../../hooks/useSaving";
import { T, todayIso } from "../../tokens";
import { api } from "../../api";
import Btn from "../primitives/Btn";
import Spinner from "../primitives/Spinner";
import DatePicker from "../primitives/DatePicker";
import { Field, Inp, Textarea, inputBase } from "../primitives/Form";
import CarrierCombobox from "../shared/CarrierCombobox";
import CustomerCombobox from "../shared/CustomerCombobox";
import ConsumptionBar from "../shared/ConsumptionBar";
import LanePill from "../shared/LanePill";
import { contractLines, loopsOf, lineOnLoop, commodityCodesOf, findClashes, overlappingConfigs, periodProblems, periodDays,
  nextFreePeriod, MAX_PERIOD_DAYS, FAK_CODE } from "../../utils/spaceConfigRules";

// Space configuration form (approved mockup: https://claude.ai/artifact/MDkX8f7EEG3TNVquYeor3h).
// Contract first: carrier → contract number → reference → loop → the reference's routing lines
// (ticked; they share the TEU) → customer → commodity → period → TEU. Duplicates are checked per
// routing line (same loop, customer and commodity in an overlapping period — the rule set on
// 2026-09-30), so a reference can hold separate configurations for different lines, loops,
// customers or commodities at the same time. The rules live in src/utils/spaceConfigRules.js;
// the server applies the same ones (routes/allocations.js resolveConfig).

const box = (tone) => ({ background: T.bg, border: `1px solid ${tone || T.border}`, borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 });
const boxTitle = { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: "4px 8px",
  fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" };
const hint = { fontFamily: T.body, fontSize: 11.5, fontWeight: 500, color: T.textMuted, textTransform: "none", letterSpacing: 0 };
const note = { fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.5, margin: 0 };
const msg = tone => ({ fontFamily: T.body, fontSize: 12, lineHeight: 1.5, borderRadius: 6, padding: "8px 11px",
  color: tone === "bad" ? T.danger : T.info, background: tone === "bad" ? T.dangerBg : T.infoBg });
const choice = on => ({ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "4px 10px", alignItems: "center", padding: "9px 11px",
  border: `1px solid ${on ? T.accent : T.border}`, borderRadius: 7, background: on ? T.accentBg : T.surface, cursor: "pointer" });
const fmt = s => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "…");
const fmtY = s => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "…");
const range = (a, b) => `${fmt(a)} – ${fmtY(b)}`;

// Origin / Destination Trade card (moved here from SpaceConfigurationsPage with the old form).
const TradeCard = ({ testId, label, code, name, from }) => (
  <div data-testid={testId} style={{ border: `1px solid ${T.border}`, borderRadius: 7, background: T.surface,
    padding: "10px 12px", display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
    <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>{label}</div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {code ? <LanePill code={code} /> : <span style={{ fontFamily: T.mono, fontSize: 12, color: T.border }}>—</span>}
      {name && <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text }}>{name}</span>}
    </div>
    {from && <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>{from}</span>}
  </div>
);

const ChainChips = ({ chain }) => {
  if (!chain) return <span style={note}>No legs</span>;
  const parts = [["PKU", chain.pku], ["POL", chain.pol], ["VIA ORIGIN", chain.viaOrigin], ["VIA DEST.", chain.viaDestination], ["POD", chain.pod], ["DEL", chain.del]].filter(([, v]) => v);
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 4, fontFamily: T.mono, fontSize: 12, fontWeight: 600, color: T.text }}>
      {parts.map(([k, v], i) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {i > 0 && <span style={{ color: T.textMuted }}>→</span>}
          <span><span style={{ fontFamily: T.body, fontSize: 8.5, fontWeight: 700, color: T.textMuted, letterSpacing: ".07em", marginRight: 3 }}>{k}</span>{v}</span>
        </span>
      ))}
    </span>
  );
};

// Contract validity as a strip: one row per other configuration of this reference, the one being
// entered on the bottom row (red when it has a problem).
const Timeline = ({ from, to, others, current, bad, clashIds }) => {
  const DAY = 86400000, t = s => new Date(`${s}T00:00:00Z`).getTime();
  const lo = t(from), hi = t(to) + DAY, span = hi - lo;
  if (!(span > 0)) return null;
  const pos = s => Math.max(0, Math.min(100, (t(s) - lo) / span * 100));
  const end = s => Math.max(0, Math.min(100, (t(s) + DAY - lo) / span * 100));
  const rows = Math.max(1, others.length), newTop = 4 + rows * 20, trackH = newTop + 22, tickTop = trackH + 3;
  const block = (c, top, tone) => (
    <div key={c.id || "new"} title={c.title} style={{ position: "absolute", top, height: tone === "new" ? 18 : 16, left: `${pos(c.from)}%`,
      width: `${Math.max(1.5, end(c.to) - pos(c.from))}%`, borderRadius: 4, padding: "0 5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      fontFamily: T.mono, fontSize: 10, fontWeight: 600, lineHeight: tone === "new" ? "14px" : "14px",
      background: tone === "clash" || tone === "bad" ? T.dangerBg : tone === "new" ? T.accentBg : T.surfaceHover,
      color: tone === "clash" || tone === "bad" ? T.danger : tone === "new" ? T.accent : T.textMuted,
      border: `${tone === "new" || tone === "bad" ? 2 : 1}px solid ${tone === "clash" || tone === "bad" ? T.danger : tone === "new" ? T.accent : T.border}` }}>
      {c.label}
    </div>
  );
  const months = [];
  const m = new Date(lo); m.setUTCDate(1); m.setUTCMonth(m.getUTCMonth() + 1);
  for (let x = m.getTime(); x < hi - 5 * DAY; ) {
    const p = (x - lo) / span * 100;
    if (p > 12 && p < 88) months.push([p, new Date(x).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })]);
    const n = new Date(x); n.setUTCMonth(n.getUTCMonth() + 1); x = n.getTime();
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <div data-testid="space-config-timeline" role="img" aria-label={`Contract validity ${range(from, to)} with this reference's configurations`}
        style={{ position: "relative", minWidth: 360, height: tickTop + 14 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: trackH, borderRadius: 5, background: T.surface, border: `1px dashed ${T.border}` }} />
        {others.map((c, i) => block(c, 4 + i * 20, clashIds.includes(c.id) ? "clash" : "taken"))}
        {current && block(current, newTop, bad ? "bad" : "new")}
        <span style={{ position: "absolute", top: tickTop, left: 0, fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{fmt(from)}</span>
        <span style={{ position: "absolute", top: tickTop, right: 0, fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{fmt(to)}</span>
        {months.map(([p, l]) => <span key={l + p} style={{ position: "absolute", top: tickTop, left: `${p}%`, transform: "translateX(-50%)", fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{l}</span>)}
      </div>
    </div>
  );
};

const SpaceConfigurationForm = ({ init = {}, tradeLanes = [], onSave, onCancel }) => {
  const isEdit = !!init.id;
  const [contracts, setContracts] = useState(null);
  const [configs,   setConfigs]   = useState([]);
  const [carrierCode, setCarrierCode] = useState(init.carrierCode || "");
  const [number,      setNumber]      = useState(init.contractNumber || "");
  const [contractId,  setContractId]  = useState(init.contractId || "");
  const [loopCode,    setLoopCode]    = useState(init.loopCode || "");
  const [routingIds,  setRoutingIds]  = useState(init.routingIds || []);
  const [customer,    setCustomer]    = useState({ id: init.customerId || "", name: init.customerName || "" });
  const [commodity,   setCommodity]   = useState(init.commodityCode || "");
  const [effectiveDate, setEffectiveDate] = useState(init.effectiveDate || "");
  const [endDate,       setEndDate]       = useState(init.endDate || "");
  const [teuStr,        setTeuStr]        = useState(init.allocatedTEU ? String(init.allocatedTEU) : "");
  const [alertThreshold, setAlertThreshold] = useState(init.alertThreshold ?? 80);
  const [minTeuStr,     setMinTeuStr]     = useState(init.minimumTEU != null ? String(init.minimumTEU) : "");
  const [notes,         setNotes]         = useState(init.notes || "");
  const [lanes,         setLanes]         = useState({});
  // The configuration's Origin / Destination Trade. Derived from the first ticked line's ports;
  // a stored lane is kept when editing (it may have been set deliberately), and Override lets the
  // user pick another lane, as the old form did.
  const [originLane,    setOriginLane]    = useState(init.originLane || "");
  const [destLane,      setDestLane]      = useState(init.destLane || "");
  const [laneOptions,   setLaneOptions]   = useState({});
  const [laneOverride,  setLaneOverride]  = useState(false);
  const [commodityNames, setCommodityNames] = useState({});
  const [serverErr,     setServerErr]     = useState("");
  const [isSaving,      withSaving]       = useSaving();

  useEffect(() => {
    // GET /api/contracts with no filters: every contract with its legs and routings.
    api.contracts.search().then(r => setContracts(Array.isArray(r) ? r : r.results || [])).catch(() => setContracts([]));
    api.allocations.list().then(setConfigs).catch(() => setConfigs([]));
  }, []);

  // Once contracts load, a prefilled contract (edit / renew) sets the number it belongs to.
  useEffect(() => {
    if (!contracts || !contractId) return;
    const c = contracts.find(x => x.id === contractId);
    if (c) { setNumber(c.contractNumber); if (!carrierCode) setCarrierCode(c.carrierCode); }
  }, [contracts]); // eslint-disable-line react-hooks/exhaustive-deps

  const forCarrier = useMemo(() => (contracts || []).filter(c => c.carrierCode === carrierCode
    && (c.status === "Active" || c.status === "Draft" || c.id === init.contractId)), [contracts, carrierCode, init.contractId]);
  const numbers = [...new Set(forCarrier.map(c => c.contractNumber))].sort();
  const records = forCarrier.filter(c => c.contractNumber === number);
  const contract = (contracts || []).find(c => c.id === contractId) || null;
  const lines = useMemo(() => contractLines(contract), [contract]);
  const loops = loopsOf(lines);
  const commodities = commodityCodesOf(contract);
  const locked = !!contract?.namedAccountId;
  const customerId = locked ? contract.namedAccountId : customer.id;
  const customerName = locked ? contract.namedAccount : customer.name;

  // Picking a reference fills in whatever has only one possible value.
  const applyContract = c => {
    setContractId(c?.id || ""); setServerErr("");
    const ls = contractLines(c), lp = loopsOf(ls);
    const loop = lp.length === 1 ? lp[0] : "";
    setLoopCode(loop);
    const tickable = ls.filter(l => lineOnLoop(l, loop));
    setRoutingIds(tickable.length === 1 ? [tickable[0].id] : []);
    const cc = commodityCodesOf(c);
    setCommodity(cc.length === 1 ? cc[0] : "");
    setCustomer({ id: "", name: "" });
  };
  useEffect(() => { if (records.length === 1 && records[0].id !== contractId && !isEdit) applyContract(records[0]); }, [number]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trade per line end, and the commodity descriptions, fetched once per port / code.
  useEffect(() => {
    const ports = [...new Set(lines.flatMap(l => [l.chain?.pol, l.chain?.pod]).filter(p => p && !(p in lanes)))];
    ports.forEach(p => api.portLanes(p)
      .then(d => { setLanes(x => ({ ...x, [p]: d.primary || "" })); setLaneOptions(x => ({ ...x, [p]: d.lanes || [] })); })
      .catch(() => setLanes(x => ({ ...x, [p]: "" }))));
    commodities.filter(c => !(c in commodityNames)).forEach(c =>
      api.commodities.get(c).then(r => setCommodityNames(x => ({ ...x, [c]: r.description }))).catch(() => setCommodityNames(x => ({ ...x, [c]: "" }))));
  }, [contractId, lines.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const teu = parseInt(teuStr, 10) || 0;
  const minTeu = minTeuStr.trim() === "" ? null : (parseInt(minTeuStr, 10) || 0);
  const thresh = Math.min(100, Math.max(1, parseInt(alertThreshold, 10) || 80));
  const threshColour = thresh >= 90 ? T.danger : thresh >= 75 ? T.warning : T.success;
  const dates = !!effectiveDate && !!endDate;
  const problems = dates ? periodProblems({ from: effectiveDate, to: endDate, validFrom: contract?.validFrom, validTo: contract?.validTo }) : [];
  const key = { contractId, routingIds, loopCode, customerId, commodityCode: commodity, excludeId: init.id };
  const clashes = contract && dates ? findClashes(configs, { ...key, from: effectiveDate, to: endDate }) : [];
  const overlapping = contract && dates ? overlappingConfigs(configs, { contractId, from: effectiveDate, to: endDate, excludeId: init.id }) : [];
  const ownConfigs = contract ? configs.filter(c => c.contractId === contractId && c.id !== init.id) : [];
  const lineLabel = id => lines.find(l => l.id === id)?.label || id;
  const firstLine = lines.find(l => routingIds.includes(l.id));
  const firstPol = firstLine?.chain?.pol || "", firstPod = firstLine?.chain?.pod || "";
  // A different first line (or none stored yet) takes its ports' own primary lanes; the line a
  // configuration was saved with keeps whatever lanes it was saved with.
  const keepStoredLanes = isEdit && firstLine && firstLine.id === (init.routingIds || [])[0];
  useEffect(() => {
    if (keepStoredLanes || laneOverride) return;
    if (firstPol && firstPol in lanes) setOriginLane(lanes[firstPol] || "");
    if (firstPod && firstPod in lanes) setDestLane(lanes[firstPod] || "");
  }, [firstPol, firstPod, lanes[firstPol], lanes[firstPod]]); // eslint-disable-line react-hooks/exhaustive-deps
  const laneName = code => [...Object.values(laneOptions).flat(), ...tradeLanes].find(l => l.code === code)?.name || "";
  const laneSelect = (port, value, set, label) => {
    const opts = [...(laneOptions[port]?.length ? laneOptions[port] : tradeLanes)];
    if (value && !opts.some(o => o.code === value)) opts.push({ code: value, name: laneName(value) });
    return (
      <Field label={label}>
        <select value={value} onChange={e => set(e.target.value)} aria-label={label} style={{ ...inputBase, fontSize: 13, width: "100%" }}>
          <option value="">—</option>
          {opts.map(o => <option key={o.code} value={o.code}>{o.code} – {o.name}</option>)}
        </select>
      </Field>
    );
  };

  const why = !contract ? "Pick the contract reference"
    : loops.length && !loopCode ? "Pick the loop"
    : !routingIds.length ? "Tick at least one routing"
    : !commodity ? "Pick the commodity"
    : !dates ? "Set the period"
    : problems.length ? problems[0]
    : clashes.length ? `Duplicate of ${clashes[0].config.id}`
    : teu <= 0 ? "Enter the TEU"
    : minTeu !== null && minTeu > teu ? "Minimum commitment is above the TEU" : "";

  const handleSave = () => {
    if (why) return;
    withSaving(async () => {
      try {
        await onSave({
          contractId, contractNumber: contract.contractNumber, carrierCode: contract.carrierCode,
          routingIds, loopCode, customerId, customerName, commodityCode: commodity,
          allocatedTEU: teu, effectiveDate, endDate, alertThreshold: thresh, minimumTEU: minTeu, notes,
          pol: firstLine?.chain?.pol || "", pod: firstLine?.chain?.pod || "",
          originLane, destLane, tradeLane: `${originLane}_${destLane}`,
        });
      } catch (e) { setServerErr(e.message || "Could not save the space configuration"); }
    });
  };

  if (contracts === null) return <div style={{ display: "flex", justifyContent: "center", padding: 40 }}><Spinner /></div>;

  const periodBad = dates && (problems.length > 0 || clashes.length > 0);
  const nextFree = contract && routingIds.length ? nextFreePeriod(configs, { ...key, validFrom: contract.validFrom, validTo: contract.validTo }) : null;
  const ed = isEdit ? configs.find(c => c.id === init.id) : null;

  return (
    <div data-testid="space-config-form" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Carrier" required>
          <CarrierCombobox value={carrierCode} onChange={v => { setCarrierCode(v); setNumber(""); applyContract(null); }} />
        </Field>
        <Field label="Contract number" required>
          <select value={number} disabled={!carrierCode} aria-label="Contract number"
            onChange={e => { setNumber(e.target.value); applyContract(null); }}
            style={{ ...inputBase, fontFamily: T.mono, fontSize: 13, width: "100%" }}>
            <option value="">{carrierCode ? (numbers.length ? "Pick a contract…" : "No active contracts") : "Pick the carrier first"}</option>
            {numbers.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
      </div>

      {number && (
        <div role="radiogroup" aria-labelledby="scf-ref" style={box(contract ? T.success : null)}>
          <div id="scf-ref" style={boxTitle}><span>Contract reference <span style={{ color: T.danger }}>*</span></span>
            <span style={hint}>{records.length === 1 ? "Only reference on this contract, selected for you" : `${records.length} references on this contract number`}</span></div>
          {records.map(c => {
            const n = configs.filter(x => x.contractId === c.id).length;
            return (
              <label key={c.id} style={choice(c.id === contractId)}>
                <input type="radio" name="scf-ref" checked={c.id === contractId} disabled={records.length === 1 || isEdit}
                  onChange={() => applyContract(c)} style={{ margin: 0, accentColor: T.accent }} />
                <span style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "baseline" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{c.contractRef || <span style={{ color: T.textMuted }}>(no reference)</span>}</span>
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{c.namedAccount || "All accounts"}{c.namedAccountId ? ` · ${c.namedAccountId}` : ""}</span>
                </span>
                <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, whiteSpace: "nowrap" }}>{range(c.validFrom, c.validTo)}</span>
                <span style={{ gridColumn: "2 / 4", fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                  {(c.routings || []).length} routing{(c.routings || []).length === 1 ? "" : "s"} · {n ? `${n} configuration${n === 1 ? "" : "s"}` : "no configurations yet"}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {contract && (<>
        {loops.length > 0 ? (
          <div role="radiogroup" aria-labelledby="scf-loop" style={box(loopCode ? T.success : null)}>
            <div id="scf-loop" style={boxTitle}><span>Loop <span style={{ color: T.danger }}>*</span></span>
              <span style={hint}>{loops.length === 1 ? "Only loop on this reference's routings, selected for you" : "One loop per configuration"}</span></div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {loops.map(lp => {
                const n = lines.filter(l => l.loops.includes(lp)).length;
                return (
                  <label key={lp} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 999, cursor: "pointer",
                    border: `1px solid ${loopCode === lp ? T.accent : T.border}`, background: loopCode === lp ? T.accentBg : T.surface,
                    fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: loopCode === lp ? T.accent : T.text }}>
                    <input type="radio" name="scf-loop" checked={loopCode === lp} disabled={loops.length === 1} style={{ margin: 0, accentColor: T.accent }}
                      onChange={() => { setLoopCode(lp); setRoutingIds(ids => ids.filter(id => lineOnLoop(lines.find(l => l.id === id), lp))); }} />
                    {lp} <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 500, color: T.textMuted }}>{n} routing{n === 1 ? "" : "s"}</span>
                  </label>
                );
              })}
            </div>
            {lines.some(l => !l.loops.length) && (
              <p style={note}>{lines.filter(l => !l.loops.length).map(l => l.label).join(", ")} {lines.filter(l => !l.loops.length).length === 1 ? "has" : "have"} no loop code on the contract, so {lines.filter(l => !l.loops.length).length === 1 ? "it goes" : "they go"} with any loop.</p>
            )}
          </div>
        ) : (
          <div style={box()}>
            <div style={boxTitle}><span>Loop</span><span style={hint}>None on this reference</span></div>
            <p style={note}>This reference's routings have no loop codes on the contract, so the configuration applies to any loop.</p>
          </div>
        )}

        <div role="group" aria-labelledby="scf-lines" style={box(routingIds.length ? T.success : null)}>
          <div id="scf-lines" style={boxTitle}><span>Routings <span style={{ color: T.danger }}>*</span></span>
            <span style={hint}>{lines.length === 1 ? "Only routing on this reference" : loopCode ? `Tick every routing on ${loopCode} this space covers` : "Tick every routing this space covers"}</span></div>
          {lines.map(l => {
            const on = routingIds.includes(l.id), fits = lineOnLoop(l, loopCode);
            const clash = clashes.find(c => c.routingId === l.id);
            return (
              <label key={l.id} data-testid={`scf-line-${l.id}`} style={{ ...choice(on), gridTemplateColumns: "auto 1fr", opacity: fits ? 1 : 0.55, cursor: fits ? "pointer" : "not-allowed" }}>
                <input type="checkbox" checked={on} disabled={!fits} style={{ margin: 0, accentColor: T.accent }}
                  onChange={e => setRoutingIds(ids => e.target.checked ? [...ids, l.id] : ids.filter(x => x !== l.id))} />
                <ChainChips chain={l.chain} />
                <span style={{ gridColumn: 2, display: "flex", flexWrap: "wrap", gap: "4px 12px", alignItems: "center", fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                  {l.loops.length ? l.loops.map(x => (
                    <span key={x} style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, borderRadius: 4, padding: "1px 6px",
                      color: x === loopCode ? "#fff" : T.accent, background: x === loopCode ? T.accent : T.accentBg }}>{x}</span>
                  )) : <span>No loop code</span>}
                  <span>Trade {lanes[l.chain?.pol] || "—"} → {lanes[l.chain?.pod] || "—"}</span>
                  {!fits && <span style={{ color: T.warning }}>Not on {loopCode}</span>}
                  {clash && <span style={{ color: T.danger }}>Already in {clash.config.id}</span>}
                </span>
              </label>
            );
          })}
        </div>

        {firstLine && (
          <div style={box()}>
            <div style={boxTitle}>
              <span>Trade <span style={hint}>· from the first ticked routing</span></span>
              <button type="button" onClick={() => setLaneOverride(o => !o)}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5, color: T.textMuted, cursor: "pointer",
                  padding: "4px 10px", fontFamily: T.body, fontSize: 11, textTransform: "none", letterSpacing: 0 }}>
                {laneOverride ? "Done" : "Override"}
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {laneOverride ? (<>
                {laneSelect(firstPol, originLane, setOriginLane, "Origin Trade")}
                {laneSelect(firstPod, destLane, setDestLane, "Destination Trade")}
              </>) : (<>
                <TradeCard testId="trade-origin" label="Origin Trade" code={originLane} name={laneName(originLane)} from={firstPol ? `from POL · ${firstPol}` : ""} />
                <TradeCard testId="trade-destination" label="Destination Trade" code={destLane} name={laneName(destLane)} from={firstPod ? `from POD · ${firstPod}` : ""} />
              </>)}
            </div>
          </div>
        )}

        {locked ? (
          <div style={box(T.success)}>
            <div style={boxTitle}><span>Customer</span><span style={hint}>Set by the contract reference</span></div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.text }}><strong>{contract.namedAccount}</strong> <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textMuted }}>{contract.namedAccountId}</span></div>
            <p style={note}>{contract.contractRef || "This reference"} is reserved for this named account, so the configuration is too. It is offered only on shipments where this customer is the principal.</p>
          </div>
        ) : (
          <div style={box(customer.id ? T.success : null)}>
            <div style={boxTitle}><span>Customer (optional)</span><span style={hint}>Empty = all customers</span></div>
            <CustomerCombobox value={customer} onChange={v => setCustomer({ id: v.id || "", name: v.name || "" })} />
            <p style={note}>{customer.id ? `Offered only on shipments where ${customer.name} is the principal.` : "Offered on shipments for any customer."}</p>
          </div>
        )}

        <Field label="Commodity" required>
          <select value={commodity} onChange={e => setCommodity(e.target.value)} disabled={commodities.length === 1} aria-label="Commodity"
            style={{ ...inputBase, fontSize: 13, width: "100%" }}>
            {commodities.length > 1 && <option value="">Pick a commodity type…</option>}
            {commodities.map(c => <option key={c} value={c}>{c === FAK_CODE ? "9999 · FAK, all commodities" : `${c} · ${commodityNames[c] || "…"}`}</option>)}
          </select>
        </Field>

        <div style={box(periodBad ? T.danger : dates ? T.success : null)}>
          <div style={boxTitle}><span>Effective period <span style={{ color: T.danger }}>*</span></span><span style={hint}>Contract valid {range(contract.validFrom, contract.validTo)}</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <DatePicker id="scf-from" label="Effective From" value={effectiveDate} placeholder="Start date…"
              minDate={isEdit ? undefined : todayIso()} maxDate={contract.validTo || undefined}
              onChange={v => { setEffectiveDate(v); setServerErr(""); if (endDate && v && endDate < v) setEndDate(v); }} />
            <DatePicker id="scf-to" label="Effective To" value={endDate} placeholder="End date…" disabled={!effectiveDate}
              minDate={effectiveDate || undefined} maxDate={contract.validTo || undefined}
              onChange={v => { setEndDate(v); setServerErr(""); }} />
          </div>
          {contract.validFrom && contract.validTo && (
            <Timeline from={contract.validFrom} to={contract.validTo}
              others={ownConfigs.map(c => ({ id: c.id, from: c.effectiveDate, to: c.endDate, title: `${c.id} · ${range(c.effectiveDate, c.endDate)}`,
                label: `${c.id} · ${c.loopCode || "any loop"} · ${c.customerName || "all"}` }))}
              current={dates ? { from: effectiveDate, to: endDate, label: `${isEdit ? "editing" : "new"} · ${loopCode || "any loop"} · ${customerName || "all"}` } : null}
              bad={periodBad} clashIds={clashes.map(c => c.config.id)} />
          )}
          <p style={note}>Upper rows: this reference's other configurations. Bottom row: {isEdit ? "the one you are editing" : "this new one"}.{dates ? ` ${periodDays(effectiveDate, endDate)} day period · max ${MAX_PERIOD_DAYS} days per configuration.` : ""}</p>
          {overlapping.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table data-testid="scf-overlapping" style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.body, fontSize: 12 }}>
                <thead><tr>{["Also in this period", "Loop", "Customer", "Commodity", "Routings", "Verdict"].map(h => (
                  <th key={h} style={{ textAlign: "left", fontSize: 9.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em", padding: "5px 6px", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                ))}</tr></thead>
                <tbody>{overlapping.map(c => {
                  const shared = (c.routingIds || []).filter(r => routingIds.includes(r));
                  const diff = [(c.loopCode || "") !== loopCode && "loop", (c.customerId || "") !== (customerId || "") && "customer", (c.commodityCode || "") !== commodity && "commodity", !shared.length && "routings"].filter(Boolean);
                  return (
                    <tr key={c.id}>
                      <td style={{ padding: 6, fontFamily: T.mono, fontWeight: 600 }}>{c.id}</td>
                      <td style={{ padding: 6, fontFamily: T.mono }}>{c.loopCode || "—"}</td>
                      <td style={{ padding: 6 }}>{c.customerName || "All customers"}</td>
                      <td style={{ padding: 6, fontFamily: T.mono }}>{c.commodityCode || "—"}</td>
                      <td style={{ padding: 6, fontFamily: T.mono }}>{(c.routingIds || []).map(lineLabel).join(", ")}</td>
                      <td style={{ padding: 6, fontWeight: 700, color: diff.length ? T.success : T.danger }}>{diff.length ? `Fine, other ${diff.join(" + ")}` : "Duplicate"}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
          <div aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {problems.map(p => <div key={p} style={msg("bad")}>{p}</div>)}
            {clashes.length > 0 && (
              <div style={{ ...msg("bad"), display: "flex", flexDirection: "column", gap: 6 }}>
                <span>{[...new Set(clashes.map(c => lineLabel(c.routingId)))].join(", ")} already {clashes.length === 1 ? "has" : "have"} space in {[...new Set(clashes.map(c => `${c.config.id} (${range(c.config.effectiveDate, c.config.endDate)})`))].join(", ")} for the same loop, customer and commodity. Untick {clashes.length === 1 ? "that line" : "those lines"}, pick another period, or change the loop, customer or commodity.</span>
                {nextFree && (
                  <span><button type="button" onClick={() => { setEffectiveDate(nextFree.from); setEndDate(nextFree.to); }}
                    style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.text }}>
                    Use the next free period ({range(nextFree.from, nextFree.to)})</button></span>
                )}
              </div>
            )}
            {dates && !problems.length && !clashes.length && (
              <div style={msg("info")}>Fits: inside the contract's validity{overlapping.length ? `, and different from the ${overlapping.length} other configuration${overlapping.length === 1 ? "" : "s"} in this period` : ", with no other configuration in this period"}.</div>
            )}
          </div>
        </div>

        <div>
          <Inp id="scf-teu" label="Allocated space (TEU)" type="number" value={teuStr} onChange={setTeuStr} required
            hint={routingIds.length > 1 ? `One pool shared by the ${routingIds.length} ticked routings.` : "Total TEU awarded by this carrier for the period."} />
          {ed && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              <ConsumptionBar allocated={teu || ed.allocatedTEU} confirmed={ed.confirmedTEU} pending={ed.pendingTEU} rejected={ed.rejectedTEU} height={6} width="100%" />
              <span style={note}>{ed.confirmedTEU} confirmed + {ed.pendingTEU} pending of {teu || ed.allocatedTEU} TEU. Ticking another routing doesn't move existing bookings; new bookings on it draw from the same pool.</span>
            </div>
          )}
        </div>

        <div style={box()}>
          <div style={boxTitle}><span>Utilisation alert threshold</span></div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <input type="range" min={10} max={100} step={5} value={thresh} aria-label="Utilisation alert threshold"
              onChange={e => setAlertThreshold(Number(e.target.value))} style={{ flex: 1, accentColor: threshColour, cursor: "pointer" }} />
            <div style={{ minWidth: 52, textAlign: "center", fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: threshColour }}>{thresh}%</div>
          </div>
        </div>

        <div style={box()}>
          <div style={boxTitle}><span>Minimum quantity commitment (optional)</span></div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input type="number" min={0} max={teu || undefined} value={minTeuStr} onChange={e => setMinTeuStr(e.target.value)}
              placeholder="No minimum set" aria-label="Minimum quantity commitment"
              style={{ ...inputBase, width: 180, fontFamily: T.mono, fontSize: 13 }} />
            <span style={note}>TEU by end of period</span>
          </div>
          {minTeu !== null && minTeu > teu && <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.danger }}>Can't exceed the {teu} TEU allocated above.</div>}
        </div>

        <Textarea label="Notes" value={notes} onChange={setNotes} rows={3} placeholder="Contract caveats, rollover terms, special conditions…" />
      </>)}

      {serverErr && <div style={msg("bad")}>{serverErr}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", paddingTop: 4 }}>
        {why && <span data-testid="scf-why" style={{ marginRight: "auto", fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{why}</span>}
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={!!why || isSaving} data-testid="scf-save">
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {isSaving && <Spinner size="sm" color="currentColor" />}
            {isSaving ? "Saving…" : (isEdit ? "Save Changes" : "Add Configuration")}
          </span>
        </Btn>
      </div>
    </div>
  );
};

export default SpaceConfigurationForm;
