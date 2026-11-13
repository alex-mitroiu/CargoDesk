"use strict";

// ─── House B/L terms and conditions (2026-11-10, mockup 2b9f3473, ARCHITECTURE.md §8.48) ───────────────────────────
// Each legal entity (branch) keeps its terms per language: a PDF for the printed B/L and the same terms as text for the
// eBL (DCSA termsAndConditions, at most 50,000 characters). The organisation default (branch_id NULL) is English and
// starts as CargoDesk's starter text, which a House B/L is never issued on. Every save is a new version; an issued
// House B/L keeps the version it printed (transport_documents.terms_id) and an amendment keeps the original's.
// An office picks the terms its House B/Ls start with (offices.bl_terms_default: 'BRANCH:<lang>' its own entity's,
// 'ORG:<lang>' the organisation's); unset, it is English: its entity's, else the organisation's.
// The print (routes/shipment-ops.js): the B/L face, then the terms from a new page (the PDF, or the text set as pages
// when a language has no PDF), numbered "Page n of N" and signed as one PDF.

const fs = require("fs");
const path = require("path");
const { PDFDocument, StandardFonts, rgb, degrees } = require("pdf-lib");

const MAX_TEXT = 50000;                       // DCSA eBL 3.0 TransportDocument.termsAndConditions maxLength
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const LANG_RE = /^[a-z]{2,3}$/;               // ISO 639-1 / 639-2 code
const DEFAULT_TITLE = "Terms and Conditions of the House Bill of Lading";
// The face line names the pages the terms are on; the client prints this token and the server fills it in once it
// knows how many pages the face takes (src/utils/documentBuilders.js BL_TERMS_PAGES_TOKEN, the same string).
const FACE_TOKEN = "__BL_TERMS_PAGES__";
const STARTER_TEXT = [
  "1. Definitions\n“Carrier” means the company named as carrier on the face of this Bill of Lading. “Merchant” includes the shipper, the consignee, the holder and anyone acting for them.",
  "2. Subcontracting\nThe Carrier may subcontract all or part of the carriage, on any terms.",
  "3. Period of responsibility\nFrom receipt of the goods at the place of receipt until delivery at the place of delivery.",
  "4. Limitation of liability\nThe Carrier's liability for loss of or damage to the goods is limited as the Hague-Visby Rules provide.",
  "5. The Merchant's particulars\nThe Merchant warrants that the particulars it furnished, including description, weight and any dangerous goods, are correct.",
  "6. Freight and charges\nFreight is earned on receipt of the goods and is payable without deduction.",
  "7. Lien\nThe Carrier has a lien on the goods for all sums due under this contract.",
  "8. Notice and time bar\nLoss or damage must be notified in writing within 3 days of delivery; any claim is time-barred after one year.",
  "9. Law and jurisdiction\nThis Bill of Lading is governed by the law of the country of the Carrier's principal place of business, whose courts have jurisdiction.",
].join("\n\n");

const languageName = code => {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; } catch { return code; }
};
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clip = (s, n) => String(s ?? "").slice(0, n);

function createBlTerms(ctx) {
  const { query, uid, UPLOADS_DIR } = ctx;
  const nowIso = () => new Date().toISOString();
  const ownerOf = r => (r.branch_id ? "BRANCH" : "ORG");
  const keyOf = r => `${ownerOf(r)}:${r.language}`;
  const map = (r, ownerName = "") => r && ({
    id: r.id, key: keyOf(r), owner: ownerOf(r), branchId: r.branch_id || null,
    ownerName: ownerName || (r.branch_id ? "" : "Organisation default"),
    language: r.language, languageName: languageName(r.language), version: r.version, title: r.title || DEFAULT_TITLE,
    chars: String(r.text || "").length, hasPdf: !!r.pdf_stored_name, pdfFilename: r.pdf_filename || "", pdfPages: r.pdf_pages || 0,
    isStarter: !!r.is_starter, createdAt: r.created_at, createdBy: r.created_by || "", retired: !!r.retired_at,
  });
  const branchName = async id => (id ? (await query("SELECT name FROM branches WHERE id=$1", [id]))[0]?.name || "" : "Organisation default");

  // The organisation's English terms always exist: CargoDesk's starter text until an admin replaces it.
  async function ensureStarter() {
    const [have] = await query("SELECT 1 FROM bl_terms WHERE branch_id IS NULL AND language='en' LIMIT 1");
    if (have) return;
    await query(`INSERT INTO bl_terms (id, branch_id, language, version, title, text, is_starter, created_at, created_by)
      VALUES ($1, NULL, 'en', 1, $2, $3, TRUE, $4, 'CargoDesk')`, [`BLT-${uid()}`, DEFAULT_TITLE, STARTER_TEXT, nowIso()]);
  }

  // The current version of every (owner, language) still offered; `where` narrows it (t.* columns).
  async function currentRows(where = "", params = []) {
    return query(`SELECT t.* FROM bl_terms t WHERE t.retired_at IS NULL ${where}
      AND t.version = (SELECT MAX(v.version) FROM bl_terms v WHERE COALESCE(v.branch_id,'')=COALESCE(t.branch_id,'') AND v.language=t.language)
      ORDER BY t.branch_id NULLS FIRST, t.language`, params);
  }
  const byId = async id => (id ? (await query("SELECT * FROM bl_terms WHERE id=$1", [id]))[0] || null : null);
  const describe = async id => { const r = await byId(id); return r ? map(r, await branchName(r.branch_id)) : null; };

  // Organisation → B/L Terms: the default and every entity, their current terms and all versions.
  async function list() {
    const [rows, branches, hist, used] = await Promise.all([
      currentRows(),
      query("SELECT id, code, name, country_code, scac, is_active FROM branches ORDER BY name"),
      query("SELECT id, branch_id, language, version, created_at, created_by, is_starter, retired_at, pdf_filename FROM bl_terms ORDER BY language, version DESC"),
      query("SELECT terms_id, COUNT(*)::int AS n FROM transport_documents WHERE role='HOUSE' AND status<>'DRAFT' AND terms_id IS NOT NULL GROUP BY terms_id"),
    ]);
    const usedBy = new Map(used.map(u => [u.terms_id, Number(u.n)]));
    const offices = await query("SELECT code, name, branch_id, bl_terms_default FROM offices WHERE COALESCE(bl_terms_default,'')<>''");
    const setOf = b => {
      const bid = b?.id || null, name = b ? b.name : "Organisation default";
      return {
        branchId: bid, name, code: b?.code || "", countryCode: b?.country_code || "", scac: b?.scac || "", isActive: b ? b.is_active !== false : true,
        // The editor needs the text itself (admins only; the panel's options leave it out).
        docs: rows.filter(r => (r.branch_id || null) === bid).map(r => ({ ...map(r, name), text: r.text })),
        versions: hist.filter(h => (h.branch_id || null) === bid).map(h => ({ id: h.id, language: h.language, languageName: languageName(h.language),
          version: h.version, createdAt: h.created_at, createdBy: h.created_by || "", isStarter: !!h.is_starter, retired: !!h.retired_at,
          pdfFilename: h.pdf_filename || "", issuedCount: usedBy.get(h.id) || 0 })),
        // Offices whose default terms are this set's (an entity's own offices; any office for the organisation's).
        // Only a language this set still offers: a stale key isn't anyone's default (they start with English).
        defaultFor: offices.filter(o => (bid ? o.branch_id === bid && o.bl_terms_default.startsWith("BRANCH:") : o.bl_terms_default.startsWith("ORG:"))
          && rows.some(r => (r.branch_id || null) === bid && keyOf(r) === o.bl_terms_default))
          .map(o => ({ code: o.code, name: o.name, key: o.bl_terms_default })),
      };
    };
    return { sets: [setOf(null), ...branches.map(setOf)], maxTextLength: MAX_TEXT, maxPdfBytes: MAX_PDF_BYTES };
  }

  // A new version of one entity's (or the organisation's) terms in one language. The text is required (the eBL
  // carries it); the PDF is optional (without one the text prints) and is kept from the last version unless replaced
  // or removed (keepPdf: false).
  async function save({ branchId = null, language, title = "", text, pdfBase64 = null, pdfFilename = "", keepPdf = true } = {}, user = null) {
    const lang = String(language || "").trim().toLowerCase();
    if (!LANG_RE.test(lang)) return { error: "language: a 2- or 3-letter ISO 639 code, e.g. en, nl, de" };
    const bid = branchId || null;
    if (bid && !(await query("SELECT 1 FROM branches WHERE id=$1", [bid]))[0]) return { error: "No such legal entity", status: 404 };
    const body = String(text ?? "").replace(/\r\n/g, "\n").trim();
    if (!body) return { error: "The terms text is required: an eBL carries it, and it prints when there is no PDF" };
    if (body.length > MAX_TEXT) return { error: `The terms text is ${body.length.toLocaleString("en-US")} characters; an eBL takes at most 50,000` };
    const [prev] = await query("SELECT * FROM bl_terms WHERE COALESCE(branch_id,'')=$1 AND language=$2 ORDER BY version DESC LIMIT 1", [bid || "", lang]);
    let pdf = null;
    if (pdfBase64) {
      const buf = Buffer.from(String(pdfBase64).replace(/^data:[^,]*,/, ""), "base64");
      if (!buf.length) return { error: "The PDF is empty" };
      if (buf.length > MAX_PDF_BYTES) return { error: "The PDF is over 10 MB" };
      let pages = 0;
      try { pages = (await PDFDocument.load(buf)).getPageCount(); }
      catch (e) {
        return { error: /encrypt/i.test(String(e?.message || e?.name || e))
          ? "The PDF is password-protected: upload one CargoDesk can add to the House B/L" : "That file isn't a PDF CargoDesk can read" };
      }
      if (!pages) return { error: "The PDF has no pages" };
      const stored = `blterms_${Date.now()}_${uid()}.pdf`;
      fs.writeFileSync(path.join(UPLOADS_DIR, stored), buf);
      pdf = { stored, filename: clip(pdfFilename || "terms.pdf", 200), pages };
    } else if (keepPdf && prev?.pdf_stored_name && !prev.retired_at) {
      pdf = { stored: prev.pdf_stored_name, filename: prev.pdf_filename, pages: prev.pdf_pages };
    }
    const id = `BLT-${uid()}`;
    const version = (prev?.version || 0) + 1;
    await query(`INSERT INTO bl_terms (id, branch_id, language, version, title, text, pdf_stored_name, pdf_filename, pdf_pages, is_starter, created_at, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,$10,$11)`,
      [id, bid, lang, version, clip(String(title || "").trim() || DEFAULT_TITLE, 200), body, pdf?.stored || null, pdf?.filename || null, pdf?.pages || null,
        nowIso(), user?.name || user?.email || ""]);
    return { doc: await describe(id) };
  }

  // A language is no longer offered: its versions stay for the House B/Ls issued on them. The offices that started with
  // it start with English from now on (the pre-release audit, C3, 2026-11-12): their default is cleared, so their own
  // form still saves and nothing lists them under terms that aren't offered. Logged in the admin log.
  async function retire(branchId, language, user = null) {
    const bid = branchId || null, lang = String(language || "").toLowerCase();
    if (!bid && lang === "en") return { error: "The organisation's English terms are the last fallback: replace them with a new version, they can't be removed", status: 409 };
    const rows = await query("UPDATE bl_terms SET retired_at=$1 WHERE COALESCE(branch_id,'')=$2 AND language=$3 AND retired_at IS NULL RETURNING id", [nowIso(), bid || "", lang]);
    if (!rows.length) return { error: "No such terms", status: 404 };
    const key = `${bid ? "BRANCH" : "ORG"}:${lang}`;
    const cleared = await query(bid ? "UPDATE offices SET bl_terms_default='' WHERE branch_id=$1 AND bl_terms_default=$2 RETURNING id, code, name"
      : "UPDATE offices SET bl_terms_default='' WHERE bl_terms_default=$1 RETURNING id, code, name", bid ? [bid, key] : [key]);
    if (ctx.logAdminEvent) await ctx.logAdminEvent(user, "BL_TERMS_RETIRED", "bl_terms", `${bid || "ORG"}:${lang}`,
      { language: lang, versions: rows.length, clearedOfficeDefaults: cleared.map(o => o.code) });
    return { retired: rows.length, clearedOffices: cleared.map(o => ({ id: o.id, code: o.code, name: o.name })) };
  }

  // What an office's House B/Ls can carry: its entity's terms and the organisation's, and which one they start with.
  async function optionsForOffice(officeId) {
    const [office] = officeId ? await query("SELECT id, code, name, branch_id, bl_terms_default FROM offices WHERE id=$1", [officeId]) : [];
    const [branch] = office?.branch_id ? await query("SELECT id, name FROM branches WHERE id=$1", [office.branch_id]) : [];
    const rows = await currentRows(branch ? "AND (t.branch_id IS NULL OR t.branch_id=$1)" : "AND t.branch_id IS NULL", branch ? [branch.id] : []);
    const options = rows.map(r => map(r, r.branch_id ? branch.name : "Organisation default"));
    const has = k => options.some(o => o.key === k);
    const set = office?.bl_terms_default || "";
    const defaultKey = set && has(set) ? set : has("BRANCH:en") ? "BRANCH:en" : has("ORG:en") ? "ORG:en" : (options[0]?.key || null);
    return { office: office || null, branch: branch || null, options, defaultKey, officeDefault: set, officeDefaultValid: !set || has(set) };
  }

  // The terms a House B/L draft of this office carries: the key asked for, else the office's default.
  async function resolveFor(officeId, key) {
    const o = await optionsForOffice(officeId);
    const k = key || o.defaultKey;
    const opt = o.options.find(x => x.key === k);
    if (!opt) return { error: k ? `Terms ${k} aren't on file for ${o.branch?.name || "this office"} (Organisation → B/L Terms)` : "No terms and conditions are on file (Organisation → B/L Terms)" };
    return { id: opt.id, option: opt };
  }

  // An office's default terms, as Organisation → Offices saves it: '' or a key the office can carry.
  async function officeDefaultError(branchId, value) {
    if (!value) return null;
    const m = /^(BRANCH|ORG):([a-z]{2,3})$/.exec(String(value));
    if (!m) return "blTermsDefault: BRANCH:<language> or ORG:<language>, e.g. BRANCH:en";
    if (m[1] === "BRANCH" && !branchId) return "blTermsDefault: this office has no legal entity, so only the organisation's terms (ORG:…)";
    const rows = await currentRows(m[1] === "BRANCH" ? "AND t.branch_id=$1 AND t.language=$2" : "AND t.branch_id IS NULL AND t.language=$1",
      m[1] === "BRANCH" ? [branchId, m[2]] : [m[2]]);
    return rows.length ? null : `blTermsDefault: no ${languageName(m[2])} terms on file for ${m[1] === "BRANCH" ? "the office's legal entity" : "the organisation"} (Organisation → B/L Terms)`;
  }

  // What the House B/L panel needs: the choices, the office's default, and the terms a draft, an issued B/L or the
  // version an amendment replaces carries.
  async function forShipment(s, { draft = null, live = null, amends = null } = {}) {
    const o = await optionsForOffice(s?.emo_office_id);
    return {
      options: o.options, defaultKey: o.defaultKey, officeDefault: o.officeDefault,
      officeCode: o.office?.code || "", entityName: o.branch?.name || "",
      draft: await describe(draft?.terms_id), issued: await describe(live?.terms_id), locked: await describe(amends?.terms_id),
    };
  }

  // The readiness line about the terms (lib/house-bl.js readiness), or null. A draft is judged by what it printed;
  // with no draft yet, or an uploaded BL01 (no draft record), by the terms it would be issued with: the key picked
  // (termsKey), else the office's default. An uploaded file's own pages can't be read, so the eBL carries these
  // (the pre-release audit, C2, 2026-11-12); an amendment keeps the original's.
  async function readinessItem(s, td, { amendsTermsId = null, termsKey = "" } = {}) {
    if (td?.id) {
      if (!td.terms_id) return "Terms and conditions: this draft was printed without them. Generate the draft again";
      const r = await byId(td.terms_id);
      if (r?.is_starter) return "Terms and conditions: the draft prints CargoDesk's starter text. Pick your own terms, or an admin loads them (Organisation → B/L Terms), then generate the draft again";
      return null;
    }
    if (amendsTermsId) return null;
    const o = await optionsForOffice(s?.emo_office_id);
    const def = o.options.find(x => x.key === (termsKey || o.defaultKey));
    if (!def) return termsKey ? `Terms and conditions: ${termsKey} aren't on file for ${o.branch?.name || "this office"} (Organisation → B/L Terms)`
      : "Terms and conditions: none on file. An admin loads them under Organisation → B/L Terms";
    if (def.isStarter) return termsKey ? "Terms and conditions: CargoDesk's starter text can't be issued. Pick your own terms, or an admin loads them (Organisation → B/L Terms)"
      : `Terms and conditions: ${o.office?.code || "the export office"} starts with CargoDesk's starter text. Pick other terms, or an admin loads yours (Organisation → B/L Terms)`;
    return null;
  }

  const textFor = async id => { const r = await byId(id); return r ? clip(r.text, MAX_TEXT) : null; };

  // The terms set as pages, for a language with text but no PDF: two columns of small print, a numbered clause's
  // first line as its heading.
  function termsHtml(r, ownerName, size = null) {
    const blocks = String(r.text || "").split(/\n\s*\n/).map(b => b.trim()).filter(Boolean).map(b => {
      const [first, ...rest] = b.split("\n");
      return rest.length && first.length <= 90 ? `<p><b>${esc(first)}</b> ${esc(rest.join(" "))}</p>` : `<p>${esc(b).replace(/\n/g, "<br>")}</p>`;
    }).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      @page{size:${size ? `${size.width}pt ${size.height}pt` : "A4"};margin:14mm 14mm 18mm}
      body{margin:0;font-family:Georgia,'Times New Roman',serif;color:#1b1d24;font-size:7.6pt;line-height:1.4}
      h1{font-family:Arial,Helvetica,sans-serif;font-size:10pt;letter-spacing:.04em;text-transform:uppercase;margin:0 0 2pt}
      .sub{font-family:Arial,Helvetica,sans-serif;font-size:7pt;color:#555;margin:0 0 9pt}
      .cols{column-count:2;column-gap:7mm;text-align:justify} p{margin:0 0 4.5pt} b{font-weight:700}
    </style></head><body><h1>${esc(r.title || DEFAULT_TITLE)}</h1>
      <div class="sub">${esc(ownerName)} · ${esc(languageName(r.language))} · version ${r.version}</div>
      <div class="cols">${blocks}</div></body></html>`;
  }

  // The terms as pages of the face's paper size (W × H points): the text set at that size, or the uploaded PDF, whose
  // pages are scaled to fit and centred when they are another size, so the B/L is one size throughout.
  async function termsAt(r, owner, W, H, renderHtmlToPdf) {
    if (!r.pdf_stored_name) return PDFDocument.load(await renderHtmlToPdf(termsHtml(r, owner, { width: W, height: H })));
    const src = await PDFDocument.load(fs.readFileSync(path.join(UPLOADS_DIR, r.pdf_stored_name)));
    const fits = src.getPages().every(p => { const s = p.getSize(); return Math.abs(s.width - W) < 2 && Math.abs(s.height - H) < 2; });
    if (fits) return src;
    const out = await PDFDocument.create();
    for (const e of await out.embedPages(src.getPages())) {
      const k = Math.min(W / e.width, H / e.height);
      out.addPage([W, H]).drawPage(e, { x: (W - e.width * k) / 2, y: (H - e.height * k) / 2, xScale: k, yScale: k });
    }
    return out;
  }

  // The printed House B/L with its terms: the face (its token filled with the pages the terms take; rendered again
  // until that agrees with the face's own page count), then the terms from a new page in the face's paper size, every
  // page numbered. A draft on the starter text is stamped as such. → PDF bytes, ready to sign.
  async function printWithTerms({ html, termsId, blNumber = "", renderHtmlToPdf }) {
    const r = await byId(termsId);
    if (!r) throw new Error(`Terms ${termsId} not found`);
    const owner = await branchName(r.branch_id);
    const hasToken = String(html).includes(FACE_TOKEN);
    const pagesLabel = (F, T) => (T === 1 ? `page ${F + 1}` : `pages ${F + 1}–${F + T}`);
    const renderFace = async (F, T) => PDFDocument.load(await renderHtmlToPdf(hasToken ? String(html).split(FACE_TOKEN).join(pagesLabel(F, T)) : html));
    let used = [1, 1];
    let faceDoc = await renderFace(...used);
    const { width: W, height: H } = faceDoc.getPage(0).getSize();
    const termsDoc = await termsAt(r, owner, W, H, renderHtmlToPdf);
    const T = termsDoc.getPageCount();
    for (let i = 0; hasToken && i < 3; i++) {
      const F = faceDoc.getPageCount();
      if (used[0] === F && used[1] === T) break;
      used = [F, T];
      faceDoc = await renderFace(F, T);
    }
    const out = await PDFDocument.create();
    for (const p of await out.copyPages(faceDoc, faceDoc.getPageIndices())) out.addPage(p);
    const faceCount = faceDoc.getPageCount();
    for (const p of await out.copyPages(termsDoc, termsDoc.getPageIndices())) out.addPage(p);
    const font = await out.embedFont(StandardFonts.Helvetica), bold = await out.embedFont(StandardFonts.HelveticaBold);
    const total = out.getPageCount();
    out.getPages().forEach((page, i) => {
      const { width, height } = page.getSize();
      const line = `Page ${i + 1} of ${total}${blNumber ? ` · B/L ${blNumber}` : ""}`;
      page.drawText(line, { x: (width - font.widthOfTextAtSize(line, 6.5)) / 2, y: 16, size: 6.5, font, color: rgb(0.4, 0.42, 0.47) });
      if (r.is_starter && i >= faceCount)
        page.drawText("STARTER TEXT · NOT YOUR TERMS", { x: width * 0.14, y: height * 0.3, size: 30, font: bold, color: rgb(0.68, 0.05, 0.23), opacity: 0.22, rotate: degrees(35) });
    });
    return Buffer.from(await out.save());
  }

  return { ensureStarter, list, save, retire, optionsForOffice, resolveFor, officeDefaultError, forShipment, readinessItem, describe, byId, textFor,
    termsHtml, printWithTerms, FACE_TOKEN, MAX_TEXT, DEFAULT_TITLE, STARTER_TEXT };
}

module.exports = createBlTerms;
module.exports.FACE_TOKEN = FACE_TOKEN;
module.exports.STARTER_TEXT = STARTER_TEXT;
module.exports.MAX_TEXT = MAX_TEXT;
