import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import Btn from "../primitives/Btn";
import { Modal } from "../primitives/Modal";
import { inputBase } from "../primitives/Form";
import PortCombobox from "../shared/PortCombobox";
import { lineChain, findDuplicateLines, findChainGaps, lineProblems, applyLegType, legTypeOf, placesOf, canonLocType, shortLocType,
  LEG_TYPES, CONTRACT_LOC_TYPES, CONTRACT_MODES, LINE_ORDER_HELP } from "../../utils/routingLines";

// Contract routing lines editor — Option 1 of the approved mockup
// (https://claude.ai/artifact/YMjKwCQDPdSFYP5auHrki9): one block per routing line, a header with
// the line's chain (PKU → POL → Via origin → Via destination → POD → DEL), service codes and
// transit, then its legs as a table. Two lines can't describe the same routing. The server
// enforces the same rules (lib/routingLines.js); this shows them while editing.
//
// Typed legs (the user's pick 2026-11-07, mockup https://claude.ai/code/artifact/ff9c67cb-1556-48b4-a4f8-420c4084e91e
// option D): the Leg column is a choice, Pick-up / SEA / Delivery, the shipment route table's leg types. A Pick-up
// leg's From is where the carrier collects: its places (several, blank = anywhere), the kind of place and, in the
// By column, the mode (blank = any); a Delivery leg's To the same. Choosing a type puts the leg in the line's order
// (Pick-up first, Delivery last), and a second Pick-up or Delivery on one line is refused with what's wrong and the
// order it should have, the way the route table refuses a second Carrier's Haulage leg.
//
// Stateless about the contract itself: ContractModal owns routings/legs (legs carry routingIndex)
// and passes the edit callbacks in; onSetLineLegs(ri, legs) takes a line's legs back re-typed and re-ordered.

const typeColor = type => (type === "SEA" ? { fg: T.success, bg: T.successBg } : { fg: T.info, bg: T.infoBg });

const LinkedPortsModal = ({ code, onClose }) => {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.portLinks(code).then(r => setRows(r || [])).catch(() => setRows([])); }, [code]);
  return (
    <Modal title={`Linked ports — ${code}`} onClose={onClose} width={460}>
      <p style={{ fontFamily: T.body, fontSize: 13, color: T.text, margin: "0 0 12px" }}>
        On this routing the carrier also accepts these ports in place of <strong style={{ fontFamily: T.mono }}>{code}</strong>.
      </p>
      {rows === null ? <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Loading…</div>
        : rows.length === 0 ? (
          <div data-testid="linked-ports-empty" style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
            No linked ports are registered for {code}, so the flag has no effect yet. Add them in Master Data → Linked Ports.
          </div>
        ) : (
          <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
            {rows.map(r => (
              <div key={r.unlocode} style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 10, padding: "8px 12px", borderBottom: `1px solid ${T.border}55`, fontSize: 12.5 }}>
                <span style={{ fontFamily: T.mono, fontWeight: 700 }}>{r.unlocode}</span>
                <span style={{ fontFamily: T.body, color: T.textMuted }}>{r.name || ""}{r.note ? ` · ${r.note}` : ""}</span>
              </div>
            ))}
          </div>
        )}
      <p style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, margin: "12px 0 0" }}>Maintained in Master Data → Linked Ports.</p>
    </Modal>
  );
};

// The kind of place at a Pick-up leg's From / a Delivery leg's To: the shipment's location types.
const LocTypeGroup = ({ value, onChange, testId }) => (
  <div role="group" aria-label="Location type" data-testid={testId} style={{ display: "flex", flexWrap: "wrap", borderRadius: 5, overflow: "hidden", border: `1px solid ${T.border}`, alignSelf: "flex-start" }}>
    {CONTRACT_LOC_TYPES.map((lt, i) => (
      <button key={lt} type="button" aria-pressed={value === lt} onClick={() => onChange(lt)} title={lt}
        style={{ fontFamily: T.body, fontSize: 10.5, padding: "2px 7px", border: "none", cursor: "pointer",
          borderRight: i < CONTRACT_LOC_TYPES.length - 1 ? `1px solid ${T.border}` : "none",
          background: value === lt ? T.accent : T.surface, color: value === lt ? "#fff" : T.textMuted }}>{shortLocType(lt)}</button>
    ))}
  </div>
);

// A SEA port end: the port, its linked-ports flag (SEA legs only). A Pick-up leg's To and a Delivery leg's From are
// the line's port of loading / discharge, shown the same way without the flag.
const PortCell = ({ leg, side, linkable, onUpdate, onShowLinked }) => {
  const k = side === "pol" ? { code: "pol", name: "polName", linked: "polLinkedAllowed" } : { code: "pod", name: "podName", linked: "podLinkedAllowed" };
  const code = leg[k.code];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
      {code ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, background: T.surface, border: `1px solid ${T.accent}55`, borderRadius: 6, padding: "5px 8px", minWidth: 0 }}>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{code}</span>
          {linkable && leg[k.linked] && (
            <button type="button" onClick={() => onShowLinked(code)} title="Linked ports accepted — show list"
              aria-label={`Show ports linked to ${code}`} data-testid={`linked-${side}-${code}`}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}>📎</button>
          )}
          {leg[k.name] && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{leg[k.name]}</span>}
          <button type="button" aria-label={`Clear ${side === "pol" ? "from" : "to"} port`}
            onClick={() => onUpdate({ [k.code]: "", [k.name]: "", [k.linked]: false })}
            style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 10, padding: 0, flexShrink: 0, marginLeft: "auto" }}>✕</button>
        </div>
      ) : (
        <PortCombobox placeholder={side === "pol" ? "From port…" : "To port…"} onChange={r => r && onUpdate({ [k.code]: r.unlocode, [k.name]: r.name })} />
      )}
      {code && linkable && (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
          <input type="checkbox" checked={!!leg[k.linked]} onChange={e => onUpdate({ [k.linked]: e.target.checked })}
            style={{ width: 12, height: 12, accentColor: T.info, cursor: "pointer" }} />
          Linked ports
        </label>
      )}
    </div>
  );
};

// A Pick-up leg's From / a Delivery leg's To: the places the carrier collects from / delivers to (several; none =
// anywhere) and the kind of place. pol/pod mirror the first place, the list is polHaulageLocations/podHaulageLocations.
const PlacesCell = ({ leg, side, onUpdate, testId }) => {
  const k = side === "pol" ? { code: "pol", name: "polName", locs: "polHaulageLocations", loc: "polLocType" }
                           : { code: "pod", name: "podName", locs: "podHaulageLocations", loc: "podLocType" };
  const places = placesOf(leg);
  const setPlaces = list => onUpdate({ [k.locs]: list.join(" "), [k.code]: list[0] || "", [k.name]: list[0] && list[0] === places[0] ? leg[k.name] || "" : "" });
  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {places.length ? places.map(p => (
          <span key={p} data-testid={`${testId}-place-${p}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: T.mono, fontSize: 11.5, fontWeight: 700,
            color: T.accent, background: T.accentBg, borderRadius: 999, padding: "2px 8px" }}>
            {p}
            <button type="button" aria-label={`Remove ${p}`} onClick={() => setPlaces(places.filter(x => x !== p))}
              style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 9, padding: 0 }}>✕</button>
          </span>
        )) : <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, fontStyle: "italic" }}>Anywhere</span>}
      </div>
      <PortCombobox placeholder={places.length ? "Add a place…" : side === "pol" ? "Pick-up place (blank = anywhere)…" : "Delivery place (blank = anywhere)…"}
        onChange={r => { if (r?.unlocode && !places.includes(r.unlocode)) setPlaces([...places, r.unlocode]); }} />
      <LocTypeGroup value={canonLocType(leg[k.loc])} onChange={lt => onUpdate({ [k.loc]: lt })} testId={`${testId}-loctype`} />
    </div>
  );
};

const ChainChips = ({ chain }) => {
  if (!chain) return <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Add a leg to build the route</span>;
  const parts = [["PKU", chain.pku], ["POL", chain.pol], ["VIA ORIGIN", chain.viaOrigin], ["VIA DEST.", chain.viaDestination], ["POD", chain.pod], ["DEL", chain.del]].filter(([, v]) => v);
  return (
    <div data-testid="routing-line-chain" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, fontFamily: T.mono, fontSize: 11.5, fontWeight: 600, color: T.text }}>
      {parts.map(([k, v], i) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {i > 0 && <span style={{ color: T.textMuted }}>→</span>}
          <span><span style={{ fontFamily: T.body, fontSize: 8.5, fontWeight: 700, color: T.textMuted, letterSpacing: ".07em", marginRight: 3 }}>{k}</span>{v}</span>
        </span>
      ))}
    </div>
  );
};

const Banner = ({ children, testId, onClose }) => (
  <div data-testid={testId} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 12px", background: T.dangerBg, color: T.danger, fontFamily: T.body, fontSize: 12 }}>
    <div style={{ flex: 1 }}>{children}</div>
    {onClose && <button type="button" onClick={onClose} aria-label="Dismiss" style={{ background: "none", border: "none", color: T.danger, cursor: "pointer", fontSize: 12 }}>✕</button>}
  </div>
);

const LEG_COLS = "26px 104px minmax(0,1.2fr) minmax(0,1fr) 80px 76px 54px 28px";
const selectStyle = { ...inputBase, fontFamily: T.body, fontSize: 12, padding: "4px 6px", cursor: "pointer" };

const RoutingLinesEditor = ({ routings, legs, onAddRouting, onUpdateRouting, onRemoveRouting, onAddLeg, onUpdateLeg, onRemoveLeg, onSetLineLegs }) => {
  const [linkedFor, setLinkedFor] = useState(null);
  // A Leg-dropdown change the line refused: { ri, messages }, shown on that line until dismissed or another change.
  const [refusal, setRefusal] = useState(null);
  const indexed = legs.map((l, i) => ({ ...l, _i: i }));
  const dup = findDuplicateLines(routings.length, legs);
  const hasDup = Object.keys(dup).length > 0;
  const loose = indexed.filter(l => !(l.routingIndex >= 0 && l.routingIndex < routings.length));

  const setType = (ri, own, pos, type) => {
    const r = applyLegType(own, pos, type);
    if (r.refused) { setRefusal({ ri, messages: r.refused }); return; }
    setRefusal(null);
    onSetLineLegs?.(ri, r.legs);
  };

  return (
    <div data-testid="routing-lines" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {routings.map((routing, ri) => {
        const own = indexed.filter(l => l.routingIndex === ri);
        const chain = lineChain(own);
        const gaps = findChainGaps(own);
        const problems = lineProblems(own);
        const isDup = dup[ri] != null;
        return (
          <div key={ri} data-testid={`routing-line-${ri}`}
            style={{ border: `1px solid ${isDup || problems.length ? T.danger : T.border}`, borderRadius: 10, overflow: "hidden", background: T.surface }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px", padding: "10px 12px", background: T.bg, borderBottom: `1px solid ${T.border}` }}>
              <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text }}>Line {ri + 1}</span>
              <input value={routing.name || ""} onChange={e => onUpdateRouting(ri, { name: e.target.value })}
                placeholder="Name (optional)" aria-label={`Line ${ri + 1} name`}
                style={{ ...inputBase, fontFamily: T.body, fontSize: 12, padding: "4px 8px", width: 170 }} />
              <ChainChips chain={chain} />
              <span style={{ flex: 1 }} />
              {chain?.services.map(s => (
                <span key={s} style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, color: T.accent, background: T.accentBg, borderRadius: 4, padding: "2px 6px" }}>{s}</span>
              ))}
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                Transit
                <input type="number" min={0} max={999} value={routing.transitDays || ""}
                  onChange={e => onUpdateRouting(ri, { transitDays: parseInt(e.target.value, 10) || 0 })}
                  placeholder={chain?.transitDays ? String(chain.transitDays) : "days"} title="Total transit days for this line (blank = sum of its legs)"
                  style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, width: 64, padding: "4px 6px", textAlign: "center" }} />
                d
              </label>
              <button type="button" onClick={() => onRemoveRouting(ri)} title="Remove this line with its legs and its own rates"
                aria-label={`Remove line ${ri + 1}`}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5, color: T.danger, cursor: "pointer", fontSize: 12, padding: "3px 8px" }}>✕</button>
            </div>

            {isDup && (
              <Banner testId={`routing-line-${ri}-duplicate`}>
                <strong>Same routing as line {dup[ri] + 1}.</strong> A contract can't list the same routing twice; change a port, place, location type, mode or service code, or remove this line.
              </Banner>
            )}
            {refusal?.ri === ri && (
              <Banner testId={`routing-line-${ri}-refused`} onClose={() => setRefusal(null)}>
                <strong>That change wasn't made.</strong> {refusal.messages.join(" ")}
              </Banner>
            )}
            {problems.length > 0 && (
              <Banner testId={`routing-line-${ri}-problems`}>
                {problems.join(" ")} {LINE_ORDER_HELP}
              </Banner>
            )}
            {gaps.filter(g => !problems.some(p => p.includes(g.nextPol))).map(g => (
              <Banner key={g.afterLegPos}>
                ⚠ Leg {g.afterLegPos} ends at <strong style={{ fontFamily: T.mono }}>{g.prevPod}</strong>, but leg {g.afterLegPos + 1} starts at <strong style={{ fontFamily: T.mono }}>{g.nextPol}</strong>. A line is one connected route.
              </Banner>
            ))}

            {/* colorScheme: a dark scrollbar in dark mode (tokens.js T.scheme). */}
            <div style={{ overflowX: "auto", colorScheme: T.scheme }}>
              <div style={{ minWidth: 820 }}>
                <div style={{ display: "grid", gridTemplateColumns: LEG_COLS, gap: 8, padding: "7px 12px", borderBottom: `1px solid ${T.border}`,
                  fontFamily: T.body, fontSize: 9.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em" }}>
                  <span>#</span><span>Leg</span><span>From</span><span>To</span><span>By</span><span>Service code</span><span>Transit</span><span />
                </div>
                {own.map((leg, pos) => {
                  const type = legTypeOf(leg), c = typeColor(type);
                  const tid = `routing-line-${ri}-leg-${pos}`;
                  const update = patch => onUpdateLeg(leg._i, patch);
                  return (
                    <div key={leg._i} data-testid={tid} data-leg-type={type}
                      style={{ display: "grid", gridTemplateColumns: LEG_COLS, gap: 8, padding: "8px 12px", borderBottom: `1px solid ${T.border}55`, alignItems: "start" }}>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, paddingTop: 6 }}>{pos + 1}</span>
                      <select value={type} onChange={e => setType(ri, own, pos, e.target.value)} aria-label={`Line ${ri + 1} leg ${pos + 1} type`}
                        data-testid={`${tid}-type`} style={{ ...selectStyle, fontWeight: 700, color: c.fg, background: c.bg }}>
                        {LEG_TYPES.map(t => <option key={t} value={t} style={{ background: T.surface, color: T.text }}>{t}</option>)}
                      </select>
                      {type === "Pick-up"
                        ? <PlacesCell leg={leg} side="pol" onUpdate={update} testId={`${tid}-from`} />
                        : <PortCell leg={leg} side="pol" linkable={type === "SEA"} onUpdate={update} onShowLinked={setLinkedFor} />}
                      {type === "Delivery"
                        ? <PlacesCell leg={leg} side="pod" onUpdate={update} testId={`${tid}-to`} />
                        : <PortCell leg={leg} side="pod" linkable={type === "SEA"} onUpdate={update} onShowLinked={setLinkedFor} />}
                      {type === "SEA"
                        ? <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, paddingTop: 6 }}>—</span>
                        : (
                          <select value={leg.movementBy || ""} onChange={e => update({ movementBy: e.target.value })} aria-label={`Line ${ri + 1} leg ${pos + 1} mode`}
                            data-testid={`${tid}-mode`} title="The mode the carrier uses (blank = any)" style={selectStyle}>
                            {CONTRACT_MODES.map(m => <option key={m || "any"} value={m} style={{ background: T.surface, color: T.text }}>{m || "Any"}</option>)}
                          </select>
                        )}
                      <input value={leg.vesselService || ""} onChange={e => update({ vesselService: e.target.value.toUpperCase() })}
                        placeholder={type === "SEA" ? "e.g. AL5" : ""} aria-label={`Line ${ri + 1} leg ${pos + 1} service code`}
                        style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, padding: "5px 7px" }} />
                      <input type="number" min={0} max={999} value={leg.transitDays || ""}
                        onChange={e => update({ transitDays: parseInt(e.target.value, 10) || 0 })}
                        placeholder="d" aria-label={`Line ${ri + 1} leg ${pos + 1} transit days`}
                        style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, padding: "5px 6px", textAlign: "center" }} />
                      <button type="button" onClick={() => onRemoveLeg(leg._i)} aria-label={`Remove line ${ri + 1} leg ${pos + 1}`}
                        style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5, color: T.danger, cursor: "pointer", fontSize: 11, padding: "4px 0", marginTop: 1 }}>✕</button>
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={{ padding: "8px 12px" }}>
              <Btn variant="secondary" size="sm" onClick={() => onAddLeg(ri)}>＋ Add leg</Btn>
            </div>
          </div>
        );
      })}

      {loose.length > 0 && (
        <div style={{ border: `1px dashed ${T.warning}`, borderRadius: 10, padding: "10px 12px", fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          {loose.length} leg{loose.length === 1 ? "" : "s"} without a routing line ({loose.map(l => `${l.pol || "?"} → ${l.pod || "?"}`).join(", ")}) will each become their own line when you save.
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Btn variant="secondary" onClick={onAddRouting} disabled={hasDup}>＋ Add routing</Btn>
        {hasDup && <span style={{ fontFamily: T.body, fontSize: 12, color: T.danger }}>Fix the duplicate line first</span>}
      </div>

      {linkedFor && <LinkedPortsModal code={linkedFor} onClose={() => setLinkedFor(null)} />}
    </div>
  );
};

export default RoutingLinesEditor;
