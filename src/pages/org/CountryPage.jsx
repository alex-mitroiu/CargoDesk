import { useState, useEffect } from "react";
import { api } from "../../api";
import { T, TIMEZONES } from "../../tokens";
import { toast } from "../../toast";

const COMMON_CURRENCIES = ["USD","EUR","GBP","JPY","CNY","SGD","AED","CHF","CAD","AUD","HKD","NZD","NOK","SEK","DKK"];

function CountryForm({ entry, branches, allCountries, usedCodes, onSave, onCancel }) {
  const isEdit = !!entry;
  const [form, setForm] = useState({
    countryCode:      entry?.countryCode     || "",
    defaultCurrency:  entry?.defaultCurrency || "",
    timezone:         entry?.timezone        || "",
    branchId:         entry?.branchId        || "",
    complianceNotes:  entry?.complianceNotes || "",
  });
  const [saving, setSaving] = useState(false);

  const inp = { width: "100%", padding: "7px 10px", borderRadius: 7, border: `1px solid ${T.border}`,
    background: T.bg, fontFamily: T.body, fontSize: 13, color: T.text, outline: "none", boxSizing: "border-box" };

  const handleSave = async () => {
    if (!form.countryCode) return toast.error("Country is required");
    setSaving(true);
    try {
      if (isEdit) {
        await api.orgCountries.update(entry.countryCode, form);
        toast.success("Country updated");
      } else {
        await api.orgCountries.create(form);
        toast.success("Country added");
      }
      onSave();
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };

  const available = allCountries.filter(c => c.iso2 === entry?.countryCode || !usedCodes.has(c.iso2));

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.accent}44`, borderRadius: 10,
      padding: "20px 22px", marginBottom: 20 }}>
      <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 16 }}>
        {isEdit ? `Edit — ${entry.countryName || entry.countryCode}` : "Add Operating Country"}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 1fr", gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Country <span style={{ color: T.danger }}>*</span></div>
          <select value={form.countryCode} disabled={isEdit}
            onChange={e => setForm(p => ({ ...p, countryCode: e.target.value }))}
            style={{ ...inp, cursor: "pointer", opacity: isEdit ? 0.6 : 1 }}>
            <option value="">Select country…</option>
            {available.map(c => <option key={c.iso2} value={c.iso2}>{c.name} ({c.iso2})</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Default Currency</div>
          <select value={form.defaultCurrency} onChange={e => setForm(p => ({ ...p, defaultCurrency: e.target.value }))}
            style={{ ...inp, cursor: "pointer" }}>
            <option value="">— None —</option>
            {COMMON_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Timezone</div>
          <select value={form.timezone} onChange={e => setForm(p => ({ ...p, timezone: e.target.value }))}
            style={{ ...inp, cursor: "pointer" }}>
            <option value="">— None —</option>
            {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Responsible Branch</div>
        <select value={form.branchId} onChange={e => setForm(p => ({ ...p, branchId: e.target.value }))}
          style={{ ...inp, maxWidth: 360, cursor: "pointer" }}>
          <option value="">— None —</option>
          {branches.filter(b => b.isActive).map(b => (
            <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Compliance Notes</div>
        <textarea value={form.complianceNotes}
          onChange={e => setForm(p => ({ ...p, complianceNotes: e.target.value }))}
          rows={2} placeholder="Embargo status, local requirements, tax ID format…"
          style={{ ...inp, resize: "vertical", fontFamily: T.body }} />
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel} disabled={saving}
          style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${T.border}`,
            background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          Cancel
        </button>
        <button type="button" onClick={handleSave} disabled={saving}
          style={{ padding: "6px 18px", borderRadius: 7, border: "none", background: T.accent,
            color: "#fff", cursor: "pointer", fontFamily: T.body, fontSize: 13, fontWeight: 600 }}>
          {saving ? "Saving…" : (isEdit ? "Update" : "Add Country")}
        </button>
      </div>
    </div>
  );
}

export default function CountryPage() {
  const [entries,     setEntries]     = useState([]);
  const [branches,    setBranches]    = useState([]);
  const [allCountries,setAllCountries]= useState([]);
  const [loading,     setLoading]     = useState(true);
  const [formOpen,    setFormOpen]    = useState(false);
  const [editing,     setEditing]     = useState(null);
  const [search,      setSearch]      = useState("");

  const load = () => {
    setLoading(true);
    Promise.all([api.orgCountries.list(), api.branches.list(), api.countries.list()])
      .then(([oc, br, c]) => {
        setEntries(oc);
        setBranches(br);
        setAllCountries((c.results ?? c).sort((a, z) => a.name.localeCompare(z.name)));
      })
      .catch(() => toast.error("Failed to load"))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleDelete = async (code) => {
    if (!window.confirm(`Remove ${code} from operating countries?`)) return;
    try { await api.orgCountries.remove(code); toast.success("Removed"); load(); }
    catch (e) { toast.error(e.message); }
  };

  const usedCodes = new Set(entries.map(e => e.countryCode));
  const filtered  = entries.filter(e =>
    !search ||
    (e.countryName || "").toLowerCase().includes(search.toLowerCase()) ||
    e.countryCode.toLowerCase().includes(search.toLowerCase()) ||
    (e.branchCode  || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontFamily: T.head, fontSize: 22, fontWeight: 800, color: T.text }}>Operating Countries</div>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, marginTop: 3 }}>
            Countries your organisation operates in — each carries a default currency, timezone and responsible branch.
          </div>
        </div>
        <button type="button" onClick={() => { setEditing(null); setFormOpen(true); }}
          style={{ padding: "8px 18px", borderRadius: 9, border: "none", background: T.accent,
            color: "#fff", fontFamily: T.body, fontSize: 13, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>
          ＋ Add Country
        </button>
      </div>

      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search countries…"
        style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.border}`,
          background: T.bg, fontFamily: T.body, fontSize: 13, color: T.text, outline: "none",
          marginBottom: 16, boxSizing: "border-box" }} />

      {formOpen && (
        <CountryForm
          entry={editing} branches={branches} allCountries={allCountries} usedCodes={usedCodes}
          onSave={() => { setFormOpen(false); setEditing(null); load(); }}
          onCancel={() => { setFormOpen(false); setEditing(null); }}
        />
      )}

      {loading ? (
        <div style={{ padding: "48px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: "48px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          {search ? "No countries match." : "No operating countries yet — add one above."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {filtered.map(e => (
            <div key={e.countryCode} style={{ display: "flex", alignItems: "center", gap: 14,
              padding: "13px 16px", background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, opacity: e.isActive ? 1 : 0.55 }}>

              {/* Flag + country */}
              <div style={{ fontFamily: T.mono, fontSize: 20, minWidth: 36 }}>
                {/* unicode flag: country code → regional indicator symbols */}
                {e.countryCode.split("").map(c => String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0))).join("")}
              </div>
              <div style={{ minWidth: 44 }}>
                <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{e.countryCode}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text }}>{e.countryName || e.countryCode}</div>
                {e.complianceNotes && (
                  <div style={{ fontFamily: T.body, fontSize: 11, color: T.warning, marginTop: 2 }}>
                    ⚠ {e.complianceNotes}
                  </div>
                )}
              </div>

              {/* Metadata chips */}
              <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
                {e.defaultCurrency && (
                  <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, padding: "3px 8px",
                    borderRadius: 6, background: T.accent + "14", color: T.accent }}>
                    {e.defaultCurrency}
                  </span>
                )}
                {e.timezone && (
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>🕐 {e.timezone}</span>
                )}
                {e.branchCode && (
                  <span style={{ fontFamily: T.mono, fontSize: 11, padding: "2px 7px", borderRadius: 5,
                    background: T.bg, border: `1px solid ${T.border}`, color: T.textMuted }}>
                    {e.branchCode}
                  </span>
                )}
              </div>

              {!e.isActive && (
                <span style={{ fontSize: 11, color: T.warning, background: T.warning + "18",
                  borderRadius: 4, padding: "2px 6px", fontWeight: 600, flexShrink: 0 }}>Inactive</span>
              )}

              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button type="button" onClick={() => { setEditing(e); setFormOpen(true); }}
                  style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                    background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.text }}>
                  Edit
                </button>
                <button type="button" onClick={() => handleDelete(e.countryCode)}
                  style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.danger}44`,
                    background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.danger }}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
