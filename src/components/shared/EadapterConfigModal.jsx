import { useState, useEffect, useCallback } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { Modal, ConfirmModal } from "../primitives/Modal";
import { Inp, Sel, Textarea } from "../primitives/Form";
import Btn from "../primitives/Btn";
import Spinner from "../primitives/Spinner";
import CarrierCombobox from "./CarrierCombobox";

const TRANSPORT_OPTIONS = [
  { value: "rest_api", label: "REST API" },
  { value: "as2",      label: "AS2" },
  { value: "sftp",     label: "SFTP" },
];

const DRAFT_ID = "__draft__";
const emptyForm = () => ({
  carrierCode: "", countryIso2: "", officeId: "", transportType: "rest_api", endpointUrl: "",
  authHeaderName: "", credential: "", isActive: true, notes: "",
});

// Tabbed carrier config editor behind eAdapter's gear icon — one tab per (carrier, office) row,
// "＋ Add Carrier Config" adds an unsaved draft tab. A carrier's real EDI relationship is
// negotiated per office (v0.83.0) — a low-volume branch is exactly the one a carrier is least
// inclined to bother configuring EDI for — so the same carrier can hold several rows here, one
// per office it's actually set up for. Country narrows the Office picker; the office itself is
// the real scope key the server stores against (country is denormalized server-side from
// whichever office is picked, purely for display — never trusted from this form). Modeled on the
// tab-bar-inside-a-Modal shape MdmCustomersPage's CustomerDetailModal already established
// (hand-rolled tabs as the Modal's first child, no built-in tab support in Modal.jsx itself) plus
// office-mail.js's own credential-handling UX (blank field on save = keep the existing one, never
// shown raw once saved).
export default function EadapterConfigModal({ onClose }) {
  const [configs, setConfigs]   = useState(null);
  const [countries, setCountries] = useState(null);
  const [offices, setOffices]   = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [form, setForm]         = useState(emptyForm());
  const [showCred, setShowCred] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const load = useCallback(() => {
    api.eadapter.configs.list()
      .then(rows => {
        setConfigs(rows);
        setActiveId(prev => {
          if (prev === DRAFT_ID) return prev;
          if (prev && rows.some(r => r.id === prev)) return prev;
          return rows[0]?.id ?? null;
        });
      })
      .catch(() => toast.error("Failed to load carrier configs"));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.countries.list().then(r => setCountries(r.results || r)).catch(() => setCountries([]));
    api.offices.list().then(setOffices).catch(() => setOffices([]));
  }, []);

  // Re-seed the edit buffer whenever the active tab changes — a fresh copy per tab so typing in
  // one tab never leaks into another, and switching away/back doesn't lose in-progress edits
  // within the same open-modal session (re-seeded from the last-saved server state, not from
  // whatever was on screen before).
  useEffect(() => {
    setShowCred(false);
    if (activeId === DRAFT_ID) { setForm(emptyForm()); return; }
    const row = configs?.find(r => r.id === activeId);
    if (row) setForm({
      carrierCode: row.carrierCode, countryIso2: row.countryIso2, officeId: row.officeId,
      transportType: row.transportType, endpointUrl: row.endpointUrl,
      authHeaderName: row.authHeaderName, credential: "", isActive: row.isActive, notes: row.notes,
    });
  }, [activeId, configs]);

  const activeRow = configs?.find(r => r.id === activeId) || null;
  const isDraft = activeId === DRAFT_ID;

  const officesForCountry = (offices || []).filter(o => o.isActive && o.countryCode === form.countryIso2);

  const addDraft = () => setActiveId(DRAFT_ID);

  const save = async () => {
    if (!form.carrierCode.trim()) return toast.error("Pick a carrier first");
    if (isDraft && !form.officeId) return toast.error("Pick a country and office — eAdapter configs are scoped per office, not carrier-wide");
    setSaving(true);
    try {
      if (isDraft) {
        const created = await api.eadapter.configs.create(form);
        toast.success(`${created.carrierCode} config created for ${created.officeCode}`);
        setConfigs(rows => [...(rows || []), created]);
        setActiveId(created.id);
      } else {
        const updated = await api.eadapter.configs.update(activeId, form);
        toast.success(`${updated.carrierCode} config saved`);
        setConfigs(rows => rows.map(r => r.id === updated.id ? updated : r));
      }
    } catch (e) {
      toast.error(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    try {
      await api.eadapter.configs.remove(id);
      const next = configs.filter(r => r.id !== id);
      setConfigs(next);
      setActiveId(next[0]?.id ?? null);
      toast.success("Config removed");
    } catch {
      toast.error("Delete failed");
    }
  };

  return (
    <Modal title="Carrier EDI Adapter — Configurations" onClose={onClose} width={680}>
      {configs === null ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "30px 0" }}><Spinner /></div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
            borderBottom: `1px solid ${T.border}`, marginBottom: 20 }}>
            <div style={{ display: "flex", flexWrap: "wrap" }}>
              {configs.map(r => (
                <button key={r.id} type="button" onClick={() => setActiveId(r.id)}
                  style={{ padding: "8px 16px", fontFamily: T.body, fontSize: 13,
                    fontWeight: activeId === r.id ? 700 : 400,
                    color: activeId === r.id ? T.accent : T.textMuted,
                    background: "transparent", border: "none",
                    borderBottom: `2px solid ${activeId === r.id ? T.accent : "transparent"}`,
                    cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                  {r.carrierCode} · {r.officeCode || "—"}
                  {!r.isActive && <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.textMuted }} />}
                </button>
              ))}
              {isDraft && (
                <span style={{ padding: "8px 16px", fontFamily: T.body, fontSize: 13, fontWeight: 700,
                  color: T.accent, borderBottom: `2px solid ${T.accent}` }}>New…</span>
              )}
            </div>
            <Btn size="sm" variant="secondary" onClick={addDraft} disabled={isDraft} style={{ flexShrink: 0, marginBottom: 6 }}>
              ＋ Add Carrier Config
            </Btn>
          </div>

          {configs.length === 0 && !isDraft ? (
            <div style={{ textAlign: "center", padding: "36px 0", color: T.textMuted }}>
              <p style={{ fontFamily: T.body, fontSize: 13.5, margin: "0 0 16px" }}>
                No carriers configured yet — the built-in 3 (MAEU/SAFM/MCPU) keep working without one.
              </p>
              <Btn variant="primary" onClick={addDraft}>＋ Add Carrier Config</Btn>
            </div>
          ) : (activeRow || isDraft) ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <CarrierCombobox
                value={form.carrierCode}
                onChange={v => setForm(f => ({ ...f, carrierCode: v }))}
                required
              />
              <Sel label="Country" value={form.countryIso2} disabled={!isDraft || countries === null}
                options={[{ value: "", label: "Select a country…" },
                  ...(countries || []).slice().sort((a, b) => a.name.localeCompare(b.name))
                    .map(c => ({ value: c.iso2, label: c.name }))]}
                onChange={v => setForm(f => ({ ...f, countryIso2: v, officeId: "" }))}
                hint="Narrows which offices show below — a carrier's EDI relationship is set up per office, not once for the whole account."
                required />
              <Sel label="Office" value={form.officeId} disabled={!isDraft || !form.countryIso2 || offices === null}
                options={[{ value: "", label: form.countryIso2 ? "Select an office…" : "Pick a country first" },
                  ...officesForCountry.map(o => ({ value: o.id, label: `${o.code} — ${o.name}` }))]}
                onChange={v => setForm(f => ({ ...f, officeId: v }))}
                hint={form.countryIso2 && officesForCountry.length === 0 ? "No active offices in this country yet." : undefined}
                required />
              {!isDraft && (
                <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: "-8px 0 0" }}>
                  Carrier and office can't be changed on a saved config — delete and re-add to pick different ones.
                </p>
              )}
              <Sel label="Transport Type" value={form.transportType} options={TRANSPORT_OPTIONS}
                onChange={v => setForm(f => ({ ...f, transportType: v }))} required />
              <Inp label="Endpoint URL" value={form.endpointUrl}
                onChange={v => setForm(f => ({ ...f, endpointUrl: v }))}
                placeholder="https://…" />
              {form.transportType === "rest_api" && (
                <Inp label="Auth Header Name" value={form.authHeaderName}
                  onChange={v => setForm(f => ({ ...f, authHeaderName: v }))}
                  placeholder="e.g. Consumer-Key, Authorization" />
              )}
              <div>
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <Inp label="Credential" type={showCred ? "text" : "password"} value={form.credential}
                      onChange={v => setForm(f => ({ ...f, credential: v }))}
                      placeholder="Paste API key / secret…" />
                  </div>
                  <button type="button" onClick={() => setShowCred(x => !x)}
                    style={{ marginTop: 22, height: 34, padding: "0 12px", borderRadius: 8,
                      border: `1px solid ${T.border}`, background: T.bg, color: T.text,
                      cursor: "pointer", fontFamily: T.body, fontSize: 12 }}>
                    {showCred ? "Hide" : "Show"}
                  </button>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 10.5, marginTop: 4,
                  color: activeRow?.hasCredential ? T.success : T.textMuted }}>
                  {activeRow?.hasCredential
                    ? "● Credential configured — leave blank to keep it"
                    : "No credential saved yet"}
                </div>
              </div>
              <Textarea label="Notes" value={form.notes} rows={2}
                onChange={v => setForm(f => ({ ...f, notes: v }))} />
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                fontFamily: T.body, fontSize: 13, color: T.text }}>
                <input type="checkbox" checked={form.isActive}
                  onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} />
                Active — counts toward the live bookable-carrier set while eAdapter is on
              </label>

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                <div>
                  {!isDraft && (
                    <Btn variant="danger" onClick={() => setConfirmDeleteId(activeId)}>Delete</Btn>
                  )}
                </div>
                <Btn variant="primary" onClick={save} disabled={saving}>
                  {saving ? "Saving…" : isDraft ? "Create Config" : "Save Changes"}
                </Btn>
              </div>
            </div>
          ) : null}
        </>
      )}

      {confirmDeleteId && (() => {
        const target = configs.find(r => r.id === confirmDeleteId);
        return (
          <ConfirmModal
            message={`Remove the ${target?.carrierCode || ""} EDI config at ${target?.officeCode || "this office"}? Shipments through that office will only stay bookable for ${target?.carrierCode || "this carrier"} if it's one of the 3 built-in carriers.`}
            onConfirm={doDelete}
            onCancel={() => setConfirmDeleteId(null)}
          />
        );
      })()}
    </Modal>
  );
}
