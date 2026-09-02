// ─── Document Template Editor — client-side renderer ───────────────────────────
// Turns a saved document_templates row (a flat array of absolutely-positioned fields) into a
// real HTML string, the same "client builds the HTML, server just signs it" split every
// hardcoded builder in documentBuilders.js/invoiceGenerator.js already follows — this is an
// additional builder, not a new pipeline. Deliberately does NOT go through _invShell: a
// template author designs the whole page themselves on the canvas, so _invShell's own
// header/footer would double up with whatever they placed.
import { _esc } from "./invoiceGenerator";

// A4 at 96dpi / US Letter at 96dpi — the editor canvas and the real render use the same sizes.
export const PAGE_SIZES = {
  A4:     { w: 794, h: 1123, cssSize: "A4" },
  Letter: { w: 816, h: 1056, cssSize: "letter" },
};

// Dot-path lookup into the same resolved data bag GenerateDocumentModal.jsx already assembles
// before calling dispatchDocBuilder — e.g. "shipment.shipperName", "shipper.companyName".
export const resolvePath = (data, path) => {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), data);
};

const fieldStyle = (f) =>
  `position:absolute;left:${f.x}px;top:${f.y}px;width:${f.width}px;height:${f.height}px;` +
  `font-size:${f.fontSize || 12}px;font-weight:${f.fontWeight || 400};text-align:${f.align || "left"};` +
  `font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.35;overflow:hidden;`;

const renderTextField = (f, data) => {
  const value = f.source === "static" ? (f.text || "") : (resolvePath(data, f.path) ?? "");
  return `<div style="${fieldStyle(f)}">${_esc(value)}</div>`;
};

const renderTableField = (f, data) => {
  const rows = resolvePath(data, f.arrayPath) || [];
  const cols = f.columns || [];
  const cellFs = f.fontSize || 11;
  const thead = `<tr>${cols.map(c =>
    `<th style="text-align:left;border-bottom:1px solid #333;padding:3px 6px;font-size:${cellFs}px">${_esc(c.label)}</th>`
  ).join("")}</tr>`;
  const tbody = rows.map(row => `<tr>${cols.map(c =>
    `<td style="padding:3px 6px;font-size:${cellFs}px;border-bottom:1px solid #e5e7eb">${_esc(resolvePath(row, c.path) ?? "")}</td>`
  ).join("")}</tr>`).join("");
  return `<div style="${fieldStyle(f)}overflow:visible;"><table style="width:100%;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif">${thead}${tbody}</table></div>`;
};

export const renderField = (field, data) =>
  field.type === "table" ? renderTableField(field, data) : renderTextField(field, data);

export const renderTemplateHtml = (template, data) => {
  const size = PAGE_SIZES[template.pageSize] || PAGE_SIZES.A4;
  const fieldsHtml = (template.fields || []).map(f => renderField(f, data)).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${_esc(template.name || template.docType)}</title>
<style>
  @page { size: ${size.cssSize}; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #e5e7eb; }
  .page { position: relative; width: ${size.w}px; height: ${size.h}px; background: #fff; margin: 0 auto; }
  @media print { body { background: #fff; } .page { margin: 0; } }
</style></head><body><div class="page">${fieldsHtml}</div></body></html>`;
};
