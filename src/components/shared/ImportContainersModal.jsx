import { useState, useEffect } from "react";
import { T, IMDG_CLASSES } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";

// ─── Bulk Container Import (direct request) ──────────────────────────────────
// Download a template, fill it, upload it back — a review-before-commit screen sits between
// upload and actually creating anything, so a bad cell never silently becomes a real container.
// The row shape ({rowNumber, data, errors}) mirrors routes/shipments.js's preview/commit routes
// exactly, and is deliberately generic enough that a later AI document-parsing wizard (extracting
// cargo data from a B/L) could feed this same review step with AI-extracted rows instead of
// parsed spreadsheet rows — no rework needed here for that to slot in later.

const inputStyle = { width: "100%", fontFamily: T.body, fontSize: 12, background: T.bg, color: T.text,
  border: `1px solid ${T.border}`, borderRadius: 5, padding: "5px 7px", boxSizing: "border-box" };

const fileToBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

const EditableRow = ({ row, typeOptions, onChange, onRevalidate }) => {
  const d = row.data;
  const set = (field, value) => onChange({ ...d, [field]: value });
  const cell = (field, node) => <div key={field}>{node}</div>;

  return (
    <div style={{ background: T.danger + "0d", border: `1px solid ${T.danger}44`, borderRadius: 8,
      padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.danger, fontWeight: 700 }}>Row {row.rowNumber}</span>
        <Btn size="sm" variant="secondary" onClick={onRevalidate}>Re-check</Btn>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 8 }}>
        {cell("containerNumber", <>
          <div style={{ fontSize: 9.5, color: T.textMuted, marginBottom: 2 }}>Container #</div>
          <input style={inputStyle} value={d.containerNumber} onChange={e => set("containerNumber", e.target.value)} />
        </>)}
        {cell("sealNumber", <>
          <div style={{ fontSize: 9.5, color: T.textMuted, marginBottom: 2 }}>Seal #</div>
          <input style={inputStyle} value={d.sealNumber} onChange={e => set("sealNumber", e.target.value)} />
        </>)}
        {cell("typeCode", <>
          <div style={{ fontSize: 9.5, color: T.textMuted, marginBottom: 2 }}>Type Code *</div>
          <select style={{ ...inputStyle, cursor: "pointer" }} value={d.typeCode} onChange={e => set("typeCode", e.target.value)}>
            <option value="">—</option>
            {typeOptions.map(t => <option key={t.code} value={t.code}>{t.code}</option>)}
          </select>
        </>)}
        {cell("hsCode", <>
          <div style={{ fontSize: 9.5, color: T.textMuted, marginBottom: 2 }}>HS Code</div>
          <input style={inputStyle} value={d.hsCode} onChange={e => set("hsCode", e.target.value)} />
        </>)}
        {cell("cargoDescription", <>
          <div style={{ fontSize: 9.5, color: T.textMuted, marginBottom: 2 }}>Cargo Description</div>
          <input style={inputStyle} value={d.cargoDescription} onChange={e => set("cargoDescription", e.target.value)} />
        </>)}
        {cell("marksAndNumbers", <>
          <div style={{ fontSize: 9.5, color: T.textMuted, marginBottom: 2 }}>Marks & Numbers</div>
          <input style={inputStyle} value={d.marksAndNumbers} onChange={e => set("marksAndNumbers", e.target.value)} />
        </>)}
        {cell("grossWeightKg", <>
          <div style={{ fontSize: 9.5, color: T.textMuted, marginBottom: 2 }}>Gross Weight (kg)</div>
          <input style={inputStyle} value={d.grossWeightKg ?? ""} onChange={e => set("grossWeightKg", e.target.value)} />
        </>)}
        {cell("volumeCbm", <>
          <div style={{ fontSize: 9.5, color: T.textMuted, marginBottom: 2 }}>Volume (CBM)</div>
          <input style={inputStyle} value={d.volumeCbm ?? ""} onChange={e => set("volumeCbm", e.target.value)} />
        </>)}
        {cell("isDg", <>
          <div style={{ fontSize: 9.5, color: T.textMuted, marginBottom: 2 }}>Is DG?</div>
          <select style={{ ...inputStyle, cursor: "pointer" }} value={d.isDg ? "Y" : "N"} onChange={e => set("isDg", e.target.value === "Y")}>
            <option value="N">N</option>
            <option value="Y">Y</option>
          </select>
        </>)}
        {cell("dgClass", <>
          <div style={{ fontSize: 9.5, color: T.textMuted, marginBottom: 2 }}>DG Class</div>
          <select style={{ ...inputStyle, cursor: "pointer" }} value={d.dgClass} onChange={e => set("dgClass", e.target.value)} disabled={!d.isDg}>
            <option value="">—</option>
            {IMDG_CLASSES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
          </select>
        </>)}
        {cell("setTemperatureC", <>
          <div style={{ fontSize: 9.5, color: T.textMuted, marginBottom: 2 }}>Reefer Temp (°C)</div>
          <input style={inputStyle} value={d.setTemperatureC ?? ""} onChange={e => set("setTemperatureC", e.target.value)} />
        </>)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {row.errors.map((e, i) => (
          <div key={i} style={{ fontFamily: T.body, fontSize: 11.5, color: T.danger }}>⚠ {e}</div>
        ))}
      </div>
    </div>
  );
};

const CleanRow = ({ row }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
    borderRadius: 8, background: T.bg, border: `1px solid ${T.border}`, marginBottom: 6 }}>
    <span style={{ color: T.success, flexShrink: 0 }}>✓</span>
    <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, flexShrink: 0, width: 44 }}>#{row.rowNumber}</span>
    <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.accent, fontWeight: 700, flexShrink: 0, width: 110,
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {row.data.containerNumber || "(no number)"}
    </span>
    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text, flexShrink: 0, width: 50 }}>{row.data.typeCode}</span>
    <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, flex: 1,
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {row.data.cargoDescription || "—"}
    </span>
    {row.data.isDg && (
      <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.danger,
        background: T.danger + "18", border: `1px solid ${T.danger}44`, borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>
        DG {row.data.dgClass}
      </span>
    )}
  </div>
);

const ImportContainersModal = ({ shipment, onClose, onImported }) => {
  const [step,        setStep]        = useState("upload"); // "upload" | "review"
  const [file,        setFile]        = useState(null);
  const [parsing,     setParsing]     = useState(false);
  const [committing,  setCommitting]  = useState(false);
  const [rows,        setRows]        = useState([]);
  const [typeOptions, setTypeOptions] = useState([]);

  useEffect(() => { api.containerTypes.list().then(list => setTypeOptions(list.filter(t => t.isActive))).catch(() => setTypeOptions([])); }, []);

  const handleDownloadTemplate = async () => {
    try { await api.containerImport.template(); }
    catch (ex) { toast.error(ex.message); }
  };

  const handleParse = async () => {
    if (!file) { toast.error("Choose a filled-in template file first"); return; }
    setParsing(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await api.containerImport.preview(shipment.id, base64);
      if (result.rows.length === 0) { toast.error("No data rows found in that file — check you didn't upload the blank template"); return; }
      setRows(result.rows);
      setStep("review");
    } catch (ex) { toast.error(ex.message); }
    setParsing(false);
  };

  const readyCount = rows.filter(r => r.errors.length === 0).length;
  const errorCount = rows.length - readyCount;

  const handleCommit = async () => {
    if (errorCount > 0) { toast.error(`${errorCount} row(s) still have errors`); return; }
    setCommitting(true);
    try {
      const result = await api.containerImport.commit(shipment.id, rows);
      toast.success(`${result.created.length} container${result.created.length === 1 ? "" : "s"} imported`);
      onImported(result.created);
    } catch (ex) { toast.error(ex.message); }
    setCommitting(false);
  };

  return (
    <Modal title="Import Containers" onClose={onClose} width={step === "review" ? 900 : 480}>
      {step === "upload" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
            Download the template, fill in your container details (an example row shows the
            expected format), then upload it back here for review before anything is created.
          </div>
          <Btn variant="secondary" onClick={handleDownloadTemplate}>⬇ Download Template</Btn>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 6 }}>Filled-in template (.xlsx)</div>
            <input type="file" accept=".xlsx" onChange={e => setFile(e.target.files?.[0] || null)}
              style={{ ...inputStyle, cursor: "pointer" }} />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
            <Btn variant="secondary" onClick={onClose} disabled={parsing}>Cancel</Btn>
            <Btn onClick={handleParse} disabled={parsing || !file}>{parsing ? "Reading…" : "Parse File"}</Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>
              <b style={{ color: readyCount === rows.length ? T.success : T.text }}>{readyCount}</b> of {rows.length} row{rows.length === 1 ? "" : "s"} ready
              {errorCount > 0 && <span style={{ color: T.danger }}> · {errorCount} need{errorCount === 1 ? "s" : ""} attention</span>}
            </div>
            <Btn size="sm" variant="secondary" onClick={() => setStep("upload")}>← Upload a different file</Btn>
          </div>

          <div style={{ maxHeight: 420, overflowY: "auto", paddingRight: 4 }}>
            {rows.map(row => row.errors.length > 0 ? (
              <EditableRow key={row.rowNumber} row={row} typeOptions={typeOptions}
                onChange={newData => setRows(list => list.map(r => r.rowNumber === row.rowNumber ? { ...r, data: newData } : r))}
                onRevalidate={() => {
                  const current = rows.find(r => r.rowNumber === row.rowNumber);
                  const errs = [];
                  const d = current.data;
                  if (!d.typeCode) errs.push("Container Type Code is required");
                  else if (!typeOptions.some(t => t.code === d.typeCode)) errs.push(`"${d.typeCode}" is not a recognized active container type code`);
                  if (d.isDg && !d.dgClass) errs.push("DG Class is required when Is DG is Y");
                  if (d.grossWeightKg !== "" && d.grossWeightKg != null && Number.isNaN(Number(d.grossWeightKg))) errs.push("Gross Weight (kg) must be a number");
                  if (d.volumeCbm !== "" && d.volumeCbm != null && Number.isNaN(Number(d.volumeCbm))) errs.push("Volume (CBM) must be a number");
                  if (d.setTemperatureC !== "" && d.setTemperatureC != null && Number.isNaN(Number(d.setTemperatureC))) errs.push("Reefer Set Temp (°C) must be a number");
                  setRows(list => list.map(r => r.rowNumber === row.rowNumber ? { ...r, errors: errs } : r));
                }} />
            ) : (
              <CleanRow key={row.rowNumber} row={row} />
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
            <Btn variant="secondary" onClick={onClose} disabled={committing}>Cancel</Btn>
            <Btn onClick={handleCommit} disabled={committing || errorCount > 0}>
              {committing ? "Importing…" : `Import ${readyCount} Container${readyCount === 1 ? "" : "s"}`}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default ImportContainersModal;
