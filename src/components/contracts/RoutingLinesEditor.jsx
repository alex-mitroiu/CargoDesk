import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import Btn from "../primitives/Btn";
import { Modal } from "../primitives/Modal";
import { inputBase } from "../primitives/Form";
import PortCombobox from "../shared/PortCombobox";
import { lineChain, legKind, LEG_KIND_LABEL, findDuplicateLines, findChainGaps, tooManyLocations } from "../../utils/routingLines";

// Contract routing lines editor — Option 1 of the approved mockup
// (https://claude.ai/artifact/YMjKwCQDPdSFYP5auHrki9): one block per routing line, a header with
// the line's chain (PKU → POL → Via origin → Via destination → POD → DEL), service codes and
// transit, then its legs as a table. A line is one connected run of legs with at most one
// pick-up and one delivery location; two lines can't describe the same routing. The server
// enforces the same rules (lib/routingLines.js); this shows them while editing.
//
// Stateless about the contract itself: ContractModal owns routings/legs (legs carry routingIndex)
// and passes the edit callbacks in.

const LOC_TYPES = ["Terminal", "Door", "CY"];
const kindColor = kind => (kind === "sea" ? { fg: T.success, bg: T.successBg } : { fg: T.info, bg: T.infoBg });

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

// One end of a leg: the port, its location type, the linked-ports flag, and — only where the line
// starts (From of its first leg) or ends (To of its last leg) with carrier haulage — the single
// pick-up / delivery location.
const PortCell = ({ leg, side, endLabel, onUpdate, onShowLinked }) => {
  const k = side === "pol" ? { code: "pol", name: "polName", loc: "polLocType", linked: "polLinkedAllowed", haul: "polCarrierHaulage", locs: "polHaulageLocations" }
                           : { code: "pod", name: "podName", loc: "podLocType", linked: "podLinkedAllowed", haul: "podCarrierHaulage", locs: "podHaulageLocations" };
  const code = leg[k.code];
  const locType = leg[k.loc] || "Terminal";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
      {code ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, background: T.surface, border: `1px solid ${T.accent}55`, borderRadius: 6, padding: "5px 8px", minWidth: 0 }}>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{code}</span>
          {leg[k.linked] && (
            <button type="button" onClick={() => onShowLinked(code)} title="Linked ports accepted — show list"
              aria-label={`Show ports linked to ${code}`} data-testid={`linked-${side}-${code}`}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}>📎</button>
          )}
          {leg[k.name] && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{leg[k.name]}</span>}
          <button type="button" aria-label={`Clear ${side === "pol" ? "from" : "to"} port`}
            onClick={() => onUpdate({ [k.code]: "", [k.name]: "", [k.linked]: false, [k.haul]: false, [k.locs]: "", [k.loc]: "Terminal" })}
            style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 10, padding: 0, flexShrink: 0, marginLeft: "auto" }}>✕</button>
        </div>
      ) : (
        <PortCombobox placeholder={side === "pol" ? "From port…" : "To port…"} onChange={r => onUpdate({ [k.code]: r.unlocode, [k.name]: r.name })} />
      )}
      {code && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <div role="group" aria-label="Location type" style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: `1px solid ${T.border}` }}>
            {LOC_TYPES.map(lt => (
              <button key={lt} type="button" aria-pressed={locType === lt}
                onClick={() => onUpdate({ [k.loc]: lt, [k.haul]: lt !== "Terminal", ...(lt === "Terminal" ? { [k.locs]: "" } : {}) })}
                style={{ fontFamily: T.body, fontSize: 10.5, padding: "2px 7px", border: "none", cursor: "pointer",
                  borderRight: lt !== "CY" ? `1px solid ${T.border}` : "none",
                  background: locType === lt ? T.accent : T.surface, color: locType === lt ? "#fff" : T.textMuted }}>{lt}</button>
            ))}
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
            <input type="checkbox" checked={!!leg[k.linked]} onChange={e => onUpdate({ [k.linked]: e.target.checked })}
              style={{ width: 12, height: 12, accentColor: T.info, cursor: "pointer" }} />
            Linked ports
          </label>
        </div>
      )}
      {code && endLabel && locType !== "Terminal" && (
        <input value={leg[k.locs] || ""} onChange={e => onUpdate({ [k.locs]: e.target.value.toUpperCase() })}
          placeholder={`${endLabel} location, one UN/LOCODE (blank = any)`} aria-label={`${endLabel} location`}
          style={{ ...inputBase, fontFamily: T.mono, fontSize: 11, padding: "4px 7px" }} />
      )}
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

const LEG_COLS = "28px 92px minmax(0,1fr) minmax(0,1fr) 96px 64px 30px";

const RoutingLinesEditor = ({ routings, legs, onAddRouting, onUpdateRouting, onRemoveRouting, onAddLeg, onUpdateLeg, onRemoveLeg }) => {
  const [linkedFor, setLinkedFor] = useState(null);
  const indexed = legs.map((l, i) => ({ ...l, _i: i }));
  const dup = findDuplicateLines(routings.length, legs);
  const hasDup = Object.keys(dup).length > 0;
  const loose = indexed.filter(l => !(l.routingIndex >= 0 && l.routingIndex < routings.length));

  return (
    <div data-testid="routing-lines" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {routings.map((routing, ri) => {
        const own = indexed.filter(l => l.routingIndex === ri);
        const chain = lineChain(own);
        const gaps = findChainGaps(own);
        const many = tooManyLocations(own);
        const isDup = dup[ri] != null;
        return (
          <div key={ri} data-testid={`routing-line-${ri}`}
            style={{ border: `1px solid ${isDup ? T.danger : T.border}`, borderRadius: 10, overflow: "hidden", background: T.surface }}>
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
              <div data-testid={`routing-line-${ri}-duplicate`} style={{ padding: "8px 12px", background: T.dangerBg, color: T.danger, fontFamily: T.body, fontSize: 12, fontWeight: 600 }}>
                Same routing as line {dup[ri] + 1}. A contract can't list the same routing twice; change a port, location or service code, or remove this line.
              </div>
            )}
            {many && (
              <div style={{ padding: "8px 12px", background: T.dangerBg, color: T.danger, fontFamily: T.body, fontSize: 12 }}>
                One {many} location per line. Add another routing line for each additional {many} location.
              </div>
            )}
            {gaps.map(g => (
              <div key={g.afterLegPos} style={{ padding: "6px 12px", background: T.dangerBg, color: T.danger, fontFamily: T.body, fontSize: 11.5 }}>
                ⚠ Leg {g.afterLegPos} discharges at <strong style={{ fontFamily: T.mono }}>{g.prevPod}</strong>, but leg {g.afterLegPos + 1} loads from <strong style={{ fontFamily: T.mono }}>{g.nextPol}</strong>. A line is one connected route.
              </div>
            ))}

            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 720 }}>
                <div style={{ display: "grid", gridTemplateColumns: LEG_COLS, gap: 8, padding: "7px 12px", borderBottom: `1px solid ${T.border}`,
                  fontFamily: T.body, fontSize: 9.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em" }}>
                  <span>#</span><span>Leg</span><span>From</span><span>To</span><span>Service code</span><span>Transit</span><span />
                </div>
                {own.map((leg, pos) => {
                  const kind = legKind(own, pos), c = kindColor(kind);
                  return (
                    <div key={leg._i} data-testid={`routing-line-${ri}-leg-${pos}`}
                      style={{ display: "grid", gridTemplateColumns: LEG_COLS, gap: 8, padding: "8px 12px", borderBottom: `1px solid ${T.border}55`, alignItems: "start" }}>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, paddingTop: 6 }}>{pos + 1}</span>
                      <span style={{ paddingTop: 4 }}>
                        <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: c.fg, background: c.bg, borderRadius: 4, padding: "2px 7px", whiteSpace: "nowrap" }}>{LEG_KIND_LABEL[kind]}</span>
                      </span>
                      <PortCell leg={leg} side="pol" endLabel={pos === 0 ? "Pick-up" : null}
                        onUpdate={patch => onUpdateLeg(leg._i, patch)} onShowLinked={setLinkedFor} />
                      <PortCell leg={leg} side="pod" endLabel={pos === own.length - 1 ? "Delivery" : null}
                        onUpdate={patch => onUpdateLeg(leg._i, patch)} onShowLinked={setLinkedFor} />
                      <input value={leg.vesselService || ""} onChange={e => onUpdateLeg(leg._i, { vesselService: e.target.value.toUpperCase() })}
                        placeholder="e.g. AL5" aria-label={`Line ${ri + 1} leg ${pos + 1} service code`}
                        style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, padding: "5px 7px" }} />
                      <input type="number" min={0} max={999} value={leg.transitDays || ""}
                        onChange={e => onUpdateLeg(leg._i, { transitDays: parseInt(e.target.value, 10) || 0 })}
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
