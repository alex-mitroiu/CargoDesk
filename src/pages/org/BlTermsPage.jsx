// Organisation → B/L Terms (2026-11-10, mockup 2b9f3473, ARCHITECTURE.md §8.48): the House B/L's terms and
// conditions, per legal entity and language: a PDF for the printed B/L and the same terms as text for the eBL.
// The organisation default is English and starts as CargoDesk's starter text, which a House B/L can't be issued on.
// Every save is a new version; issued B/Ls keep theirs. Which terms an office's House B/Ls start with is set on the
// office (Organisation → Offices). Admins only (GET /api/bl-terms).
import { useState, useEffect, useMemo } from "react";
import { api } from "../../api";
import { T } from "../../tokens";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";

const DEFAULT_TITLE = "Terms and Conditions of the House Bill of Lading";
const MAX_TEXT = 50000;
// Languages offered when adding one (ISO 639-1); named in English by the browser.
const LANGUAGES = ["en", "nl", "de", "fr", "es", "it", "pt", "pl", "ro", "tr", "cs", "hu", "el", "sv", "da", "no", "fi", "bg", "hr", "sk",
  "sl", "lt", "lv", "et", "uk", "ru", "ar", "he", "hi", "zh", "ja", "ko", "vi", "th", "id", "ms"];
const langName = code => { try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; } catch { return code; } };
const fmtDay = iso => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "");
const fileToDataUrl = file => new Promise((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error("The file couldn't be read")); r.readAsDataURL(file);
});

const label = { fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4, display: "block" };
const btn = (primary = false) => ({ padding: "6px 14px", borderRadius: 7, cursor: "pointer", fontFamily: T.body, fontSize: 13, fontWeight: 600,
  border: primary ? "none" : `1px solid ${T.border}`, background: primary ? T.accent : "none", color: primary ? "#fff" : T.text });
const chip = color => ({ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 5,
  color, border: `1px solid ${color}55`, background: `${color}14` });

export default function BlTermsPage() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [sel, setSel] = useState("org");          // "org" or a branch id
  const [lang, setLang] = useState("en");
  const [adding, setAdding] = useState(false);    // a language not on file yet, being written
  const [showAll, setShowAll] = useState(false);
  const [form, setForm] = useState(null);         // { title, text, pdf: { name, dataUrl } | null, removePdf }
  const [saving, setSaving] = useState(false);
  const [retireArmed, setRetireArmed] = useState(false);

  const load = () => api.blTerms.list().then(setData).catch(e => toast.error(e.message));
  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  const keyOf = s => s.branchId || "org";
  const set = data?.sets.find(s => keyOf(s) === sel) || null;
  const doc = set?.docs.find(d => d.language === lang) || null;
  // The editor starts from the current version (or blank for a new language) whenever the selection changes.
  useEffect(() => {
    setForm({ title: doc?.title || DEFAULT_TITLE, text: doc?.text || "", pdf: null, removePdf: false });
    setRetireArmed(false);
  }, [sel, lang, doc?.id]);

  const visible = useMemo(() => (data?.sets || []).filter(s => !s.branchId || s.docs.length || keyOf(s) === sel || (showAll && s.isActive)), [data, sel, showAll]);
  const others = useMemo(() => (data?.sets || []).filter(s => s.branchId && !s.docs.length && s.isActive && keyOf(s) !== sel), [data, sel]);

  if (!isAdmin) return <div style={{ padding: 24, fontFamily: T.body, color: T.textMuted }}>B/L terms are kept by admins.</div>;
  if (!data || !form) return <div style={{ padding: 24, fontFamily: T.body, color: T.textMuted }}>Loading…</div>;

  const pick = (key, language) => { setSel(key); setAdding(false); setLang(language); };
  const missingLanguages = LANGUAGES.filter(l => !set?.docs.some(d => d.language === l));
  const textLen = form.text.length;
  const keepsPdf = !!doc?.hasPdf && !form.removePdf && !form.pdf;
  const versions = (set?.versions || []).filter(v => v.language === lang);
  const nextVersion = (versions[0]?.version || 0) + 1;

  const onPdf = async file => {
    if (!file) return;
    if (file.type && file.type !== "application/pdf") return toast.error("Choose a PDF file");
    if (file.size > (data.maxPdfBytes || 10 * 1024 * 1024)) return toast.error("The PDF is over 10 MB");
    try {
      const dataUrl = await fileToDataUrl(file);
      setForm(f => ({ ...f, pdf: { name: file.name, dataUrl }, removePdf: false }));
    } catch (e) { toast.error(e.message); }
  };
  const save = async () => {
    if (!form.text.trim()) return toast.error("The terms text is required: an eBL carries it");
    if (textLen > MAX_TEXT) return toast.error("The terms text is over 50,000 characters");
    setSaving(true);
    try {
      const r = await api.blTerms.save({ branchId: set.branchId, language: lang, title: form.title, text: form.text,
        ...(form.pdf && { pdfBase64: form.pdf.dataUrl, pdfFilename: form.pdf.name }), keepPdf: !form.removePdf });
      toast.success(`Saved: ${langName(lang)}, version ${r.doc.version}`);
      setAdding(false);
      await load();
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };
  const retire = async () => {
    if (!retireArmed) return setRetireArmed(true);
    try {
      await api.blTerms.retire(set.branchId, lang);
      toast.success(`${langName(lang)} is no longer offered for ${set.name}`);
      setLang("en"); await load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 1180 }}>
      <div>
        <div style={{ fontFamily: T.head, fontSize: 22, fontWeight: 800, color: T.text }}>B/L Terms</div>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, maxWidth: 760, lineHeight: 1.5 }}>
          The terms and conditions printed after the House B/L, from a new page, and carried by an eBL. The legal entity that signs
          the B/L supplies them; an entity with none in a language uses the organisation default. Which terms an office's House B/Ls
          start with is set on the office (Organisation → Offices).
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 280px) 1fr", gap: 16, alignItems: "start" }}>
        {/* The term sets */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="bl-terms-sets">
          {visible.map(s => (
            <button key={keyOf(s)} type="button" data-testid={`bl-terms-set-${keyOf(s)}`} aria-pressed={keyOf(s) === sel}
              onClick={() => pick(keyOf(s), s.docs[0]?.language || "en")}
              style={{ textAlign: "left", padding: "10px 12px", borderRadius: 9, cursor: "pointer", display: "flex", flexDirection: "column", gap: 4,
                border: `1px solid ${keyOf(s) === sel ? T.accent : T.border}`, background: keyOf(s) === sel ? `${T.accent}12` : T.surface, color: T.text }}>
              <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700 }}>{s.name}</span>
              <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                {s.branchId ? [s.countryCode, s.scac ? `SCAC ${s.scac}` : "no SCAC"].filter(Boolean).join(" · ") : "English · any entity without its own terms"}
              </span>
              <span style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {s.docs.length ? s.docs.map(d => <span key={d.language} style={chip(d.isStarter ? T.warning : T.success)}>{d.languageName}{d.isStarter ? " · starter" : ""}</span>)
                  : <span style={chip(T.textMuted)}>uses the default</span>}
              </span>
            </button>
          ))}
          <label style={{ ...label, marginTop: 8 }} htmlFor="bl-terms-other">Terms for another entity</label>
          <select id="bl-terms-other" value="" onChange={e => e.target.value && pick(e.target.value, "en")}
            style={{ padding: "6px 8px", borderRadius: 7, border: `1px solid ${T.border}`, background: T.bg, color: T.text, fontFamily: T.body, fontSize: 13 }}>
            <option value="">Choose a legal entity…</option>
            {others.map(s => <option key={s.branchId} value={s.branchId}>{s.code ? `${s.code} — ` : ""}{s.name}</option>)}
          </select>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> List every entity
          </label>
        </div>

        {/* The selected set */}
        {set && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontFamily: T.head, fontSize: 17, fontWeight: 800, color: T.text }}>{set.name}</div>
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                  {set.defaultFor.length
                    ? `Default terms of ${set.defaultFor.map(o => `${o.code} (${langName(o.key.split(":")[1])})`).join(", ")}`
                    : set.branchId ? "No office starts with these terms by default yet (Organisation → Offices)" : "Used by every office with no default of its own, and every entity without terms"}
                </div>
              </div>
            </div>

            {/* Languages */}
            <div role="tablist" aria-label="Languages" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {set.docs.map(d => (
                <button key={d.language} role="tab" type="button" aria-selected={!adding && d.language === lang} data-testid={`bl-terms-lang-${d.language}`}
                  onClick={() => { setAdding(false); setLang(d.language); }}
                  style={{ padding: "5px 11px", borderRadius: 7, cursor: "pointer", fontFamily: T.body, fontSize: 12.5, fontWeight: 600,
                    border: `1px solid ${!adding && d.language === lang ? T.accent : T.border}`, background: !adding && d.language === lang ? `${T.accent}12` : "none", color: T.text }}>
                  {d.languageName}
                </button>
              ))}
              <select aria-label="Add a language" data-testid="bl-terms-add-language" value={adding ? lang : ""}
                onChange={e => { if (e.target.value) { setAdding(true); setLang(e.target.value); } }}
                style={{ padding: "5px 8px", borderRadius: 7, border: `1px dashed ${T.border}`, background: T.bg, color: T.text, fontFamily: T.body, fontSize: 12.5 }}>
                <option value="">＋ Add a language</option>
                {missingLanguages.map(l => <option key={l} value={l}>{langName(l)}</option>)}
              </select>
            </div>

            {doc?.isStarter && (
              <div data-testid="bl-terms-starter" style={{ padding: "10px 12px", borderRadius: 8, fontFamily: T.body, fontSize: 13, lineHeight: 1.5,
                background: `${T.warning}14`, border: `1px solid ${T.warning}55`, color: T.text }}>
                <b>Starter text.</b> CargoDesk's example terms, not yours: drafts print them marked as such and House B/Ls can't be issued on them.
                Replace them with terms your legal adviser approved, then save.
              </div>
            )}
            {(adding || !doc) && (
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                {langName(lang)} terms for {set.name}: write or paste them, and add the PDF if you have one. Without a PDF, the text prints as the terms pages.
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
              {/* The text (eBL) */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={label} htmlFor="bl-terms-title">Heading</label>
                <input id="bl-terms-title" value={form.title} maxLength={200} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  style={{ padding: "7px 10px", borderRadius: 7, border: `1px solid ${T.border}`, background: T.bg, color: T.text, fontFamily: T.body, fontSize: 13 }} />
                <label style={label} htmlFor="bl-terms-text">The terms, as text (the eBL carries this)</label>
                <textarea id="bl-terms-text" data-testid="bl-terms-text" value={form.text} rows={16}
                  onChange={e => setForm(f => ({ ...f, text: e.target.value }))}
                  placeholder={"1. Definitions\n“Carrier” means …\n\n2. …"}
                  style={{ width: "100%", boxSizing: "border-box", padding: 10, borderRadius: 8, border: `1px solid ${textLen > MAX_TEXT ? T.danger : T.border}`,
                    background: T.bg, color: T.text, fontFamily: T.mono, fontSize: 12, lineHeight: 1.55, resize: "vertical" }} />
                <span style={{ fontFamily: T.body, fontSize: 11.5, color: textLen > MAX_TEXT ? T.danger : T.textMuted }}>
                  {textLen.toLocaleString("en-US")} of 50,000 characters. A blank line starts a new clause; a clause's first line prints as its heading.
                  It must say what the PDF says.
                </span>
              </div>
              {/* The PDF (print) */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={label}>For print: the PDF (optional)</span>
                <div style={{ padding: "10px 12px", borderRadius: 8, border: `1px dashed ${T.border}`, fontFamily: T.body, fontSize: 13, display: "flex", flexDirection: "column", gap: 6 }}>
                  {form.pdf ? <span data-testid="bl-terms-pdf-new"><b>{form.pdf.name}</b> · will be saved with version {nextVersion}</span>
                    : keepsPdf ? <span data-testid="bl-terms-pdf-current"><b>{doc.pdfFilename}</b> · {doc.pdfPages} page{doc.pdfPages === 1 ? "" : "s"}, added after the B/L's last page</span>
                    : <span style={{ color: T.textMuted }}>No PDF: the text above prints as the terms pages, two columns of small print.</span>}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <label style={{ ...btn(), display: "inline-block" }}>
                      {doc?.hasPdf || form.pdf ? "Replace PDF" : "Upload PDF"}
                      <input type="file" accept="application/pdf" data-testid="bl-terms-pdf-input" style={{ display: "none" }}
                        onChange={e => { onPdf(e.target.files?.[0]); e.target.value = ""; }} />
                    </label>
                    {keepsPdf && <button type="button" style={btn()} onClick={() => api.blTerms.openPdf(doc.id).catch(e => toast.error(e.message))}>Open</button>}
                    {(keepsPdf || form.pdf) && <button type="button" style={btn()} onClick={() => setForm(f => ({ ...f, pdf: null, removePdf: true }))}>Remove PDF</button>}
                  </div>
                </div>
                <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, lineHeight: 1.5 }}>
                  A4, up to 10 MB, not password-protected. It's added after the B/L's last page, every page numbered, and signed with the B/L.
                </span>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                Saving makes version {nextVersion} of the {langName(lang)} terms. Issued House B/Ls keep the version they were issued with.
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                {doc && !(set.branchId === null && lang === "en") && (
                  <button type="button" data-testid="bl-terms-retire" style={{ ...btn(), color: T.danger, borderColor: `${T.danger}66` }} onClick={retire}>
                    {retireArmed ? `Click again: stop offering ${langName(lang)}` : `Stop offering ${langName(lang)}`}
                  </button>
                )}
                <button type="button" data-testid="bl-terms-save" style={btn(true)} disabled={saving} onClick={save}>{saving ? "Saving…" : `Save version ${nextVersion}`}</button>
              </div>
            </div>

            {versions.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.body, fontSize: 12.5 }}>
                  <thead><tr>{["Version", "Saved", "By", "PDF", "Issued on it"].map(h => (
                    <th key={h} style={{ textAlign: "left", fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em", padding: "6px 8px", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                  ))}</tr></thead>
                  <tbody>{versions.map((v, i) => (
                    <tr key={v.id}>
                      <td style={{ padding: "6px 8px", borderBottom: `1px solid ${T.border}`, fontFamily: T.mono }}>
                        {v.version}{i === 0 && !v.retired ? " · current" : v.retired ? " · no longer offered" : ""}{v.isStarter ? " · starter" : ""}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: `1px solid ${T.border}` }}>{fmtDay(v.createdAt)}</td>
                      <td style={{ padding: "6px 8px", borderBottom: `1px solid ${T.border}` }}>{v.createdBy || "—"}</td>
                      <td style={{ padding: "6px 8px", borderBottom: `1px solid ${T.border}` }}>{v.pdfFilename || "text only"}</td>
                      <td style={{ padding: "6px 8px", borderBottom: `1px solid ${T.border}`, fontVariantNumeric: "tabular-nums" }}>{v.issuedCount ? `${v.issuedCount} House B/L${v.issuedCount === 1 ? "" : "s"}` : "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
