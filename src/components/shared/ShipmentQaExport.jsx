import { useEffect, useState } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { HZ, HZ_MONO, HZ_BODY } from "../../pages/shipments/shipmentDetailTheme";

// ─── Shipment QA export (2026-11-13, mockup 0fb62029, lib/shipment-transfer.js) ──────────────────────────────────────────
// ShipmentQaExportModal: an admin saves the shipment as one JSON file, with what went wrong and the steps to reproduce it,
// for QA to import into a test system (Test Tools → Shipment Import). ImportedChip / ImportedShipmentBanner: how an
// imported shipment shows in the header (where it came from, the report, that it sends nothing).

const fmtSize = b => (b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtWhen = iso => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const field = () => ({ width: "100%", boxSizing: "border-box", fontFamily: T.body, fontSize: 13, color: T.text, background: T.bg,
  border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", resize: "vertical" });
const labelStyle = () => ({ display: "flex", flexDirection: "column", gap: 5, fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.textMuted });

export default function ShipmentQaExportModal({ shipment, onClose }) {
  const [contents, setContents] = useState(null);
  const [error, setError] = useState("");
  const [wrong, setWrong] = useState("");
  const [steps, setSteps] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.qaExport.contents(shipment.id).then(c => { if (live) setContents(c); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [shipment.id]);

  const download = async () => {
    setBusy(true);
    try {
      const name = await api.qaExport.download(shipment.id, { whatWentWrong: wrong, steps });
      toast.success(`Saved ${name}`);
      onClose();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };
  const cell = { padding: "6px 10px", borderBottom: `1px solid ${T.border}`, fontFamily: T.body, fontSize: 12.5, color: T.text, verticalAlign: "top" };
  const refs = contents?.references;

  return (
    <Modal title={`Export ${shipment.id} for QA`} onClose={() => !busy && onClose()} width={720} data-testid="qa-export-modal">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div data-testid="qa-export-warning" style={{ display: "flex", gap: 10, padding: "10px 12px", borderRadius: 9, background: `${T.warning}18`,
          border: `1px solid ${T.warning}55`, fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.5 }}>
          <b style={{ color: T.warning }}>!</b>
          <span><b>Real data.</b> The file holds the shipment exactly as it is here: customer names, addresses, contacts and tax numbers,
            buy and sell prices, and its documents. Keep it where you keep production data, and delete it once the issue is closed.</span>
        </div>
        <label htmlFor="qa-export-wrong" style={labelStyle()}>What went wrong
          <textarea id="qa-export-wrong" data-testid="qa-export-wrong" rows={3} value={wrong} onChange={e => setWrong(e.target.value)} style={field()}
            placeholder="What you saw, and what you expected instead" />
        </label>
        <label htmlFor="qa-export-steps" style={labelStyle()}>Steps to reproduce (one per line)
          <textarea id="qa-export-steps" data-testid="qa-export-steps" rows={4} value={steps} onChange={e => setSteps(e.target.value)} style={field()}
            placeholder={"Open the shipment → Cargo\nChange …\nOpen …"} />
        </label>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 6 }}>What goes in the file</div>
          {error && <div style={{ fontFamily: T.body, fontSize: 13, color: T.danger }}>{error}</div>}
          {!contents && !error && <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Reading the shipment…</div>}
          {contents && (
            <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: 9 }}>
              <table data-testid="qa-export-parts" style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
                <tbody>
                  <tr><td style={cell}>The shipment, its parties and offices</td><td style={{ ...cell, textAlign: "right", fontFamily: T.mono }}>1</td></tr>
                  {contents.parts.map(p => (
                    <tr key={p.table}><td style={{ ...cell, textTransform: "none" }}>{p.label[0].toUpperCase() + p.label.slice(1)}</td>
                      <td style={{ ...cell, textAlign: "right", fontFamily: T.mono }}>{p.count}</td></tr>
                  ))}
                  <tr><td style={cell}>Documents (the files themselves){contents.files.length ? `: ${contents.files.map(f => f.filename).join(", ")}` : ""}</td>
                    <td style={{ ...cell, textAlign: "right", fontFamily: T.mono }}>{contents.files.length}</td></tr>
                  {contents.context.length > 0 && (
                    <tr><td style={{ ...cell, color: T.textMuted }}>For reading only: {contents.context.map(c => `${c.count} ${c.table.replace(/_/g, " ")}`).join(", ")}</td><td style={cell} /></tr>
                  )}
                  <tr><td colSpan={2} style={{ ...cell, color: T.textMuted, borderBottom: "none" }}>
                    Records it points at: {[
                      refs.customers.length && `${refs.customers.length} customer${refs.customers.length === 1 ? "" : "s"} (${refs.customers.map(c => c.name).join(", ")}), whole records`,
                      refs.offices.length && `offices ${refs.offices.map(o => o.code).join(", ")}`,
                      refs.carriers.length && `carrier ${refs.carriers.join(", ")}`,
                      refs.ports.length && `ports ${refs.ports.join(", ")}`,
                      refs.vessels.length && `vessel ${refs.vessels.join(", ")}`,
                      refs.contract && `contract ${refs.contract}`,
                    ].filter(Boolean).join(" · ")}
                  </td></tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span data-testid="qa-export-size" style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            {contents ? `About ${fmtSize(contents.estimatedBytes)} · ` : ""}recorded in the admin log (who, when, which shipment)
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="secondary" disabled={busy} onClick={onClose}>Cancel</Btn>
            <Btn data-testid="qa-export-download" disabled={busy || !contents} onClick={download}>{busy ? "Saving…" : "Download the file"}</Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// The IMPORTED label (header, Shipments list).
export function ImportedChip({ style = {} }) {
  return (
    <span data-testid="shipment-imported-chip" title="Imported from another system's QA export: it sends nothing"
      style={{ fontFamily: HZ_MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.05em", padding: "2px 8px", borderRadius: 999,
        background: HZ.violetBg, color: HZ.violet, border: `1px solid ${HZ.violet}55`, whiteSpace: "nowrap", ...style }}>IMPORTED</span>
  );
}

// Under the header's first row on every page of an imported shipment.
export function ImportedShipmentBanner({ shipment }) {
  const [open, setOpen] = useState(false);
  if (!shipment?.importedFrom) return null;
  const m = shipment.importedMeta || {};
  const report = m.report || {};
  const steps = report.stepsToReproduce || [];
  return (
    <div data-testid="shipment-imported-banner" style={{ marginTop: 11, padding: "9px 12px", borderRadius: 9, background: HZ.violetBg,
      border: `1px solid ${HZ.violet}55`, fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text, lineHeight: 1.5, display: "flex", flexDirection: "column", gap: 3 }}>
      <span><b>Imported from {m.system || "another system"} {shipment.importedFrom}</b>
        {m.importedAt ? ` on ${fmtWhen(m.importedAt)}` : ""}{m.importedBy ? ` by ${m.importedBy}` : ""}
        {m.exportedAt ? ` (exported ${fmtWhen(m.exportedAt)}${m.exportedBy?.name ? ` by ${m.exportedBy.name}` : ""})` : ""}.</span>
      {report.whatWentWrong && (
        <span>What went wrong: {report.whatWentWrong}{steps.length > 0 && (
          <> <button type="button" data-testid="shipment-imported-steps-toggle" onClick={() => setOpen(o => !o)}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: HZ.violet, fontWeight: 700, fontFamily: HZ_BODY, fontSize: 12.5 }}>
            {open ? "Hide the steps" : `The steps (${steps.length})`}</button></>
        )}</span>
      )}
      {open && <ol data-testid="shipment-imported-steps" style={{ margin: "2px 0 0", paddingLeft: 20 }}>{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
      <span style={{ color: HZ.textMuted }}>Sending is off: no emails, EDI, webhooks or carrier messages, and the automatic reminders and carrier syncs skip it.</span>
    </div>
  );
}
