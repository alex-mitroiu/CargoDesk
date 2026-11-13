import { useEffect, useState } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Btn from "../components/primitives/Btn";

// ─── Test Tools → Shipment Import (2026-11-13, mockup 0fb62029, lib/shipment-transfer.js) ───────────────────────────────
// An admin loads a shipment's QA export (made with "Export for QA" on a shipment's header in production) and imports it
// as a NEW shipment marked IMPORTED. Before anything is saved it shows where the file came from, what went wrong, and
// how the records it points at are found here: offices by code (an export or import office this system doesn't have is
// chosen here), customers by VAT/LEI/EORI number or name (else created as a copy marked IMPORTED), reference data
// (reported only). The imported shipment sends nothing.

const fmtWhen = iso => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtSize = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const card = () => ({ border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 });
const h3 = () => ({ fontFamily: T.body, fontSize: 14, fontWeight: 700, color: T.text, margin: 0 });
const chip = color => ({ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, color, background: `${color}1c`,
  border: `1px solid ${color}55`, whiteSpace: "nowrap" });

export default function ShipmentImportPanel({ navigate, onShipmentCreated }) {
  const [status, setStatus] = useState(null);
  const [file, setFile] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [officeMap, setOfficeMap] = useState({});
  const [preview, setPreview] = useState(null);   // { problems, plan }
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => { api.shipmentImport.status().then(setStatus).catch(e => setStatus({ error: e.message })); }, []);
  useEffect(() => {
    if (!file) return;
    let live = true;
    api.shipmentImport.preview(file, officeMap).then(p => { if (live) setPreview(p); })
      .catch(e => { if (live) setPreview({ problems: [e.message], plan: null }); });
    return () => { live = false; };
  }, [file, officeMap]);

  const load = async f => {
    if (!f) return;
    setResult(null); setPreview(null); setOfficeMap({});
    try {
      const parsed = JSON.parse(await f.text());
      setFileInfo({ name: f.name, size: f.size });
      setFile(parsed);
    } catch { toast.error("That file isn't JSON: choose a shipment export (…-for-QA-….json)"); }
  };
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.shipmentImport.run(file, officeMap);
      setResult(r);
      toast.success(`Imported as ${r.shipmentId}`);
      // The app's shipment list was loaded before this one existed: add it, so Open it finds it.
      const shp = await api.shipments.get(r.shipmentId).catch(() => null);
      if (shp?.id) onShipmentCreated?.(shp);
    } catch (e) {
      if (e.body?.plan) setPreview({ problems: e.body.problems || [e.message], plan: e.body.plan });
      toast.error(e.message);
    } finally { setBusy(false); }
  };

  if (status?.error) return <div style={{ fontFamily: T.body, fontSize: 13, color: T.danger }}>{status.error}</div>;
  if (status && !status.allowed) {
    return (
      <div data-testid="shipment-import-off" style={{ ...card(), maxWidth: 720 }}>
        <h2 style={h3()}>Shipment imports are off</h2>
        <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
          This server runs in production mode. An admin turns imports on under App Settings → Shipment imports, on a test or staging server only.
        </span>
      </div>
    );
  }
  const p = preview?.plan;
  const problems = preview?.problems || [];
  const cell = { padding: "7px 10px", borderBottom: `1px solid ${T.border}`, fontFamily: T.body, fontSize: 12.5, color: T.text, verticalAlign: "top" };
  const th = { ...cell, fontFamily: T.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: T.textMuted, textAlign: "left" };

  return (
    <div data-testid="shipment-import-panel" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 1040 }}>
      <div>
        <h2 style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 6px" }}>Import a shipment</h2>
        <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, margin: 0, lineHeight: 1.5, maxWidth: 760 }}>
          Load a shipment's QA export, made with Export for QA on the shipment's header in production. It becomes a new shipment here, marked IMPORTED.
          It sends nothing: no emails, EDI, webhooks or carrier messages, and the automatic reminders and carrier syncs skip it.
        </p>
      </div>
      <label data-testid="shipment-import-drop" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", border: `1.5px dashed ${T.border}`,
        borderRadius: 10, padding: "14px 16px", cursor: "pointer", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
        <span style={chip(T.accent)}>JSON</span>
        {fileInfo ? <><span style={{ fontFamily: T.mono, color: T.text }}>{fileInfo.name}</span><span>{fmtSize(fileInfo.size)} · read</span></>
          : <span>Choose the export file (…-for-QA-….json)</span>}
        <input type="file" accept="application/json,.json" data-testid="shipment-import-file" style={{ display: "none" }}
          onChange={e => { load(e.target.files?.[0]); e.target.value = ""; }} />
      </label>

      {file && !preview && <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Reading the file…</span>}
      {preview && !p && <div style={{ ...card(), borderColor: `${T.danger}66` }}>{problems.map((x, i) => <span key={i} style={{ fontFamily: T.body, fontSize: 13, color: T.danger }}>{x}</span>)}</div>}

      {p && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
            <div style={card()} data-testid="shipment-import-source">
              <h3 style={h3()}>From</h3>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 14px", fontFamily: T.body, fontSize: 13, color: T.text }}>
                <span style={{ color: T.textMuted }}>System</span><span>{p.source.system || "—"}{p.source.host ? ` (${p.source.host})` : ""}</span>
                <span style={{ color: T.textMuted }}>Shipment</span><span style={{ fontFamily: T.mono }}>{p.shipment.id} · {p.shipment.route} · {p.shipment.carrier} · {p.shipment.status}</span>
                <span style={{ color: T.textMuted }}>Exported</span><span>{fmtWhen(p.source.exportedAt)}{p.source.exportedBy?.name ? ` by ${p.source.exportedBy.name}` : ""}</span>
                <span style={{ color: T.textMuted }}>Version</span><span>CargoDesk {p.version.file || "?"} → this system {p.version.here}{" "}
                  <span style={chip(p.version.ok ? T.success : T.danger)}>{p.version.ok ? "OK" : "NEWER"}</span></span>
              </div>
            </div>
            <div style={card()} data-testid="shipment-import-report">
              <h3 style={h3()}>What went wrong</h3>
              <span style={{ fontFamily: T.body, fontSize: 13, color: p.report.whatWentWrong ? T.text : T.textMuted }}>{p.report.whatWentWrong || "Nothing was written when the file was made."}</span>
              {(p.report.stepsToReproduce || []).length > 0 && (
                <ol style={{ margin: 0, paddingLeft: 18, fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
                  {p.report.stepsToReproduce.map((x, i) => <li key={i}>{x}</li>)}</ol>
              )}
            </div>
          </div>

          <div style={card()}>
            <h3 style={h3()}>The records it points at, in this system</h3>
            <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: 9 }}>
              <table data-testid="shipment-import-references" style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
                <thead><tr><th style={th}>In the file</th><th style={th}>Here</th><th style={th}>What happens</th></tr></thead>
                <tbody>
                  {p.offices.map(o => {
                    const use = o.found || o.chosen;
                    return (
                      <tr key={o.oldId} data-testid={`shipment-import-office-${o.role || o.code}`}>
                        <td style={cell}>{o.roles.join(", ").replace(/^./, c => c.toUpperCase())} office <span style={{ fontFamily: T.mono }}>{o.code || o.oldId}</span> {o.name}</td>
                        <td style={cell}><span style={chip(o.found ? T.success : use ? T.accent : o.required ? T.warning : T.textMuted)}>
                          {o.found ? "Found" : use ? "Chosen" : o.required ? "Not in this system" : "Left off"}</span></td>
                        <td style={cell}>
                          {o.found ? <span style={{ color: T.textMuted }}>used as it is</span>
                            : o.required ? (
                              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: T.textMuted }} htmlFor={`shipment-import-pick-${o.role}`}>
                                Use one of this system's {o.role} offices instead
                                <select id={`shipment-import-pick-${o.role}`} data-testid={`shipment-import-pick-${o.role}`} value={officeMap[o.role] || ""}
                                  onChange={e => setOfficeMap(m => ({ ...m, [o.role]: e.target.value }))}
                                  style={{ fontFamily: T.body, fontSize: 13, color: T.text, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, padding: "6px 8px" }}>
                                  <option value="">Choose an {o.role} office…</option>
                                  {(p.officeChoices[o.role] || []).map(c => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
                                </select>
                              </label>
                            ) : <span style={{ color: T.textMuted }}>not in this system: left off the shipment</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {p.customers.map(c => (
                    <tr key={c.oldId} data-testid={`shipment-import-customer-${c.oldId}`}>
                      <td style={cell}>{c.roles.join(", ")} {c.name}{c.countryIso2 ? ` (${c.countryIso2})` : ""}</td>
                      <td style={cell}><span style={chip(c.match ? T.success : T.purple || T.accent)}>{c.match ? "Found" : "New"}</span></td>
                      <td style={{ ...cell, color: T.textMuted }}>{c.match ? `${c.match.by}: ${c.match.name} is used`
                        : `created from the file${c.identifiers.length ? ` with ${c.identifiers.join(", ")}` : ""}${c.contacts ? ` and ${c.contacts} contact${c.contacts === 1 ? "" : "s"}` : ""}, marked as imported in its notes`}</td>
                    </tr>
                  ))}
                  {p.mdm.map(m => (
                    <tr key={`${m.kind}-${m.value}`}>
                      <td style={cell}>{m.kind} {m.value}</td>
                      <td style={cell}><span style={chip(m.found ? T.success : T.warning)}>{m.found ? "Found" : "Missing"}</span></td>
                      <td style={{ ...cell, color: T.textMuted }}>{m.found ? "" : "kept on the shipment as written"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {p.warnings.length > 0 && (
              <ul data-testid="shipment-import-warnings" style={{ margin: 0, paddingLeft: 18, fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
                {p.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            )}
            <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
              It brings {p.counts.map(c => c.text || `${c.count} ${c.label}`).join(", ")}{p.files.length ? `, and ${p.files.length} file${p.files.length === 1 ? "" : "s"} (${p.files.map(f => f.filename).join(", ")})` : ""}.
            </div>
            {problems.length > 0 && (
              <div data-testid="shipment-import-problems" style={{ display: "flex", flexDirection: "column", gap: 4, padding: "9px 12px", borderRadius: 8,
                background: `${T.warning}14`, border: `1px solid ${T.warning}55`, fontFamily: T.body, fontSize: 13, color: T.text }}>
                {problems.map((x, i) => <span key={i}>{x}</span>)}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn data-testid="shipment-import-run" disabled={busy || problems.length > 0 || !!result} onClick={run}>{busy ? "Importing…" : "Import as a new shipment"}</Btn>
            </div>
            {result && (
              <div data-testid="shipment-import-result" style={{ padding: "10px 12px", borderRadius: 8, background: `${T.success}14`, border: `1px solid ${T.success}55`,
                fontFamily: T.body, fontSize: 13, color: T.text, display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Imported as <b style={{ fontFamily: T.mono }}>{result.shipmentId}</b>, marked IMPORTED.{" "}
                  <button type="button" onClick={() => navigate?.("detail", result.shipmentId)}
                    style={{ background: "none", border: "none", padding: 0, color: T.accent, fontWeight: 700, cursor: "pointer", fontFamily: T.body, fontSize: 13 }}>Open it</button></span>
                {result.createdCustomers.length > 0 && <span style={{ color: T.textMuted }}>New customers: {result.createdCustomers.map(c => c.name).join(", ")}</span>}
                {result.dropped.length > 0 && <span style={{ color: T.textMuted }}>Left off: {result.dropped.join(", ")}</span>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
