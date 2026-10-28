import { useState, useEffect, useCallback } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Spinner from "../components/primitives/Spinner";
import Btn from "../components/primitives/Btn";
import { IconRefresh } from "../components/primitives/Icon";

// ─── Test Tools → eBL Platform ────────────────────────────────────────────────
// Plays the built-in eBL platform and its holders for the House B/Ls CargoDesk issued as eBLs
// (Epic TKT-C7EBU3, gap G24; lib/ebl-platform-simulator.js; approved mockup
// https://claude.ai/artifact/Tr9cyqXe31HqYTxy63ap7Z). Only the actions valid for the eBL's state are
// offered: answer the issuance (ISSU, BREQ, REFU), endorse it to another party, ask CargoDesk to accept
// a surrender (SREQ for delivery, AREQ for amendment). Each goes to CargoDesk as a real DCSA eBL message.
// Nothing happens on its own; same Demo switch as the DCSA Carrier tab.

const TONE = { RECEIVED: "info", ISSUED: "good", SURRENDER_REQUESTED: "warn", SURRENDERED: "info", REFUSED: "bad" };
const toneColor = tone => ({ info: T.info || T.accent, good: T.success, warn: T.warning, bad: T.danger }[tone] || T.textMuted);
const LABEL = { ISSU: "Issue it", BREQ: "Content error", REFU: "Refuse", endorse: "Endorse…", SREQ: "Surrender for delivery", AREQ: "Surrender for amendment" };

export default function EblPlatformPanel({ navigate }) {
  const [docs, setDocs] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [form, setForm] = useState(null); // { ref, action, partyName, partyCode, reason }
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.eblSim.documents()
    .then(rows => { setDocs(rows); setError(""); })
    .catch(e => { setDocs([]); setError(e.message || "The built-in eBL platform isn't available"); }), []);
  useEffect(() => { load(); }, [load]);

  const run = async (ref, action, data = {}) => {
    setBusy(true);
    try {
      await api.eblSim.act(ref, action, data);
      toast.success(`${action === "endorse" ? "Endorsed" : action} sent to CargoDesk`);
      setForm(null);
      // A surrender is answered by CargoDesk a moment later, on the platform's callback.
      await load();
      if (action === "SREQ" || action === "AREQ") setTimeout(load, 1200);
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  const pick = (d, action) => (action === "endorse" || action === "BREQ" || action === "REFU")
    ? setForm({ ref: d.transportDocumentReference, action, partyName: "", partyCode: "", reason: "" })
    : run(d.transportDocumentReference, action);

  if (docs === null) return <div style={{ padding: 40, textAlign: "center" }}><Spinner /></div>;

  const cell = { padding: "10px 12px", fontFamily: T.body, fontSize: 12.5, color: T.text, borderBottom: `1px solid ${T.border}`, verticalAlign: "top" };
  return (
    <div data-testid="ebl-platform-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 15, fontWeight: 700, color: T.text }}>eBL Platform</div>
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginTop: 3 }}>
            Plays the eBL platform and the holders for House B/Ls issued as eBLs. Each answer reaches CargoDesk as a DCSA eBL message.
          </div>
        </div>
        <Btn variant="secondary" size="sm" onClick={load}><IconRefresh size={12} /> Refresh</Btn>
      </div>
      {error && <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.danger }}>{error}</div>}
      {!error && docs.length === 0 && (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, padding: "18px 0" }}>
          No eBLs yet. Issue a House B/L, then use Issue as eBL on the shipment's Documents page.
        </div>
      )}
      {docs.length > 0 && (
        <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>{["B/L number", "Shipment", "On the platform", "Held by", "Last answer", "Play"].map(h => (
                <th key={h} style={{ ...cell, fontSize: 11, color: T.textMuted, textAlign: "left", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em" }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {docs.map(d => {
                const c = toneColor(TONE[d.status]);
                return (
                  <tr key={d.id} data-testid={`ebl-sim-row-${d.transportDocumentReference}`}>
                    <td style={{ ...cell, fontFamily: T.mono }}>{d.transportDocumentReference}<div style={{ color: T.textMuted, fontSize: 11 }}>{d.platform}{d.manifestVerified ? " · signature verified" : ""}</div></td>
                    <td style={cell}>{d.shipmentId
                      ? <button type="button" onClick={() => navigate?.("shipment-documents", d.shipmentId)} style={{ background: "none", border: "none", padding: 0, color: T.accent, cursor: "pointer", fontFamily: T.mono, fontSize: 12.5 }}>{d.shipmentId}</button>
                      : <span style={{ color: T.textMuted }}>—</span>}</td>
                    <td style={cell}><span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, color: c, background: `${c}18`, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>{d.status.replace(/_/g, " ")}</span></td>
                    <td style={cell}>{d.holder?.partyName || "—"}{d.holder?.identifyingCodes?.[0]?.partyCode && <div style={{ color: T.textMuted, fontFamily: T.mono, fontSize: 11 }}>{d.holder.identifyingCodes[0].partyCode}</div>}</td>
                    <td style={{ ...cell, fontFamily: T.mono }}>{d.lastAnswer || "—"}</td>
                    <td style={cell}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {d.actions.length === 0 && <span style={{ color: T.textMuted }}>Nothing to play</span>}
                        {d.actions.map(a => (
                          <Btn key={a} size="sm" variant={a === "ISSU" || a === "SREQ" ? "primary" : a === "REFU" ? "danger" : "secondary"}
                            data-testid={`ebl-sim-${a}-${d.transportDocumentReference}`} disabled={busy} onClick={() => pick(d, a)}>
                            {a === "endorse" ? "Endorse…" : a}
                          </Btn>
                        ))}
                      </div>
                      {form?.ref === d.transportDocumentReference && (
                        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                          {form.action === "endorse" ? (
                            <>
                              <input aria-label="Endorsee name" placeholder="Endorsee name" value={form.partyName} onChange={e => setForm(f => ({ ...f, partyName: e.target.value }))}
                                style={{ padding: "5px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontFamily: T.body, fontSize: 12 }} />
                              <input aria-label="Endorsee platform id" placeholder={`${d.platform} id`} value={form.partyCode} onChange={e => setForm(f => ({ ...f, partyCode: e.target.value }))}
                                style={{ padding: "5px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontFamily: T.mono, fontSize: 12 }} />
                            </>
                          ) : (
                            <input aria-label="Reason" placeholder="Reason" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                              style={{ padding: "5px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontFamily: T.body, fontSize: 12, minWidth: 220 }} />
                          )}
                          <Btn size="sm" data-testid="ebl-sim-form-send" disabled={busy || (form.action === "endorse" && (!form.partyName.trim() || !form.partyCode.trim()))}
                            onClick={() => run(d.transportDocumentReference, form.action, form.action === "endorse"
                              ? { partyName: form.partyName.trim(), partyCode: form.partyCode.trim() } : { reason: form.reason.trim() })}>
                            {LABEL[form.action]}
                          </Btn>
                          <Btn size="sm" variant="ghost" onClick={() => setForm(null)}>Cancel</Btn>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
        <div><b style={{ color: T.text }}>Issuance answers.</b> ISSU issues it to the first holder; BREQ and REFU send it back to paper in CargoDesk, with the reason.</div>
        <div><b style={{ color: T.text }}>Endorse.</b> Hands the eBL to another party by its id on the platform; the chain travels with the surrender.</div>
        <div><b style={{ color: T.text }}>Surrender.</b> SREQ for delivery, AREQ for amendment. CargoDesk runs its checks and answers SURR or SREJ.</div>
      </div>
    </div>
  );
}
