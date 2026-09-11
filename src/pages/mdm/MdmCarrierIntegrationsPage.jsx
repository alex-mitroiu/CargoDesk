import { useState, useCallback, useEffect } from "react";
import { PageSpinner } from "../../components/primitives/Spinner";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import { Inp, Sel } from "../../components/primitives/Form";
import CarrierCombobox from "../../components/shared/CarrierCombobox";
import ActionMenu from "../../components/primitives/ActionMenu";
import { IconPencil, IconClose } from "../../components/primitives/Icon";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── MDM: Carrier Integrations Page (Epic TKT-KG4E49, story 5) ────────────────
// Real carrier API connectivity config — which code adapter (e.g. the generic DCSA Booking
// v2.0.5 adapter) handles a given carrier's real bookings/tracking/schedules, and that
// adapter's endpoint + credentials. Adapters are never hardcoded here — the dropdown is
// populated from whatever's actually registered in code (GET /api/carrier-integrations/adapters),
// so a newly-added adapter shows up automatically. No active row for a carrier means it keeps
// working exactly as it does today, through Test Tools' own Message Simulator — this page only
// ever ADDS a real path alongside that, never removes the simulated one.

const CAPABILITY_OPTIONS = [
  { code: "booking",   label: "Booking" },
  { code: "tracking",  label: "Tracking" },
  { code: "schedules", label: "Schedules" },
];

const emptyForm = () => ({
  carrierCode: "", adapterKey: "", isActive: false, capabilities: [],
  baseUrl: "", authHeaderName: "", credential: "", webhookSecret: "", notes: "",
});

const IntegrationForm = ({ init, adapters, onSave, onCancel }) => {
  const isEdit = !!init;
  const [form, setForm] = useState(() => init ? {
    carrierCode: init.carrierCode, adapterKey: init.adapterKey, isActive: init.isActive,
    capabilities: init.capabilities, baseUrl: init.baseUrl, authHeaderName: init.authHeaderName,
    credential: "", webhookSecret: "", notes: init.notes,
  } : emptyForm());
  const [showCred, setShowCred] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);

  const toggleCapability = code => setForm(f => ({
    ...f, capabilities: f.capabilities.includes(code) ? f.capabilities.filter(c => c !== code) : [...f.capabilities, code],
  }));

  const valid = form.carrierCode && form.adapterKey;

  const save = async () => {
    setSaving(true);
    try { await onSave(form); } finally { setSaving(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {isEdit ? (
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px",
          fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{init.carrierCode}</div>
      ) : (
        <CarrierCombobox value={form.carrierCode} onChange={v => setForm(f => ({ ...f, carrierCode: v }))} required />
      )}

      <Sel label="Adapter" value={form.adapterKey} required
        options={[{ value: "", label: adapters === null ? "Loading…" : "Select a registered adapter…" },
          ...(adapters || []).map(a => ({ value: a, label: a }))]}
        onChange={v => setForm(f => ({ ...f, adapterKey: v }))}
        hint="Populated from whatever's actually registered in code — never a hardcoded list." />

      <Inp label="Base URL" value={form.baseUrl} onChange={v => setForm(f => ({ ...f, baseUrl: v }))}
        placeholder="https://api-sandbox.example.com" hint="Sandbox vs production differ, and carriers do change these — set per integration, not baked into the adapter." />

      <Inp label="Auth Header Name" value={form.authHeaderName} onChange={v => setForm(f => ({ ...f, authHeaderName: v }))}
        placeholder="e.g. Authorization, Consumer-Key" />

      <div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <Inp label="Credential" type={showCred ? "text" : "password"} value={form.credential}
              onChange={v => setForm(f => ({ ...f, credential: v }))} placeholder="Paste API key / bearer token…" />
          </div>
          <button type="button" onClick={() => setShowCred(x => !x)}
            style={{ marginTop: 22, height: 34, padding: "0 12px", borderRadius: 8,
              border: `1px solid ${T.border}`, background: T.bg, color: T.text,
              cursor: "pointer", fontFamily: T.body, fontSize: 12 }}>
            {showCred ? "Hide" : "Show"}
          </button>
        </div>
        <div style={{ fontFamily: T.mono, fontSize: 10.5, marginTop: 4,
          color: init?.hasCredential ? T.success : T.textMuted }}>
          {init?.hasCredential ? "● Credential configured — leave blank to keep it" : "No credential saved yet"}
        </div>
      </div>

      <div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <Inp label="Webhook Secret" type={showSecret ? "text" : "password"} value={form.webhookSecret}
              onChange={v => setForm(f => ({ ...f, webhookSecret: v }))}
              placeholder="Shared secret for verifying this carrier's callbacks…"
              hint="Verifies an inbound POST to /api/carrier-webhooks really came from this carrier." />
          </div>
          <button type="button" onClick={() => setShowSecret(x => !x)}
            style={{ marginTop: 22, height: 34, padding: "0 12px", borderRadius: 8,
              border: `1px solid ${T.border}`, background: T.bg, color: T.text,
              cursor: "pointer", fontFamily: T.body, fontSize: 12 }}>
            {showSecret ? "Hide" : "Show"}
          </button>
        </div>
        <div style={{ fontFamily: T.mono, fontSize: 10.5, marginTop: 4,
          color: init?.hasWebhookSecret ? T.success : T.textMuted }}>
          {init?.hasWebhookSecret ? "● Webhook secret configured — leave blank to keep it" : "No webhook secret saved yet"}
        </div>
      </div>

      <div>
        <label style={{ display: "block", fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>Capabilities</label>
        <div style={{ display: "flex", gap: 16 }}>
          {CAPABILITY_OPTIONS.map(opt => (
            <label key={opt.code} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
              fontFamily: T.body, fontSize: 13, color: T.text }}>
              <input type="checkbox" checked={form.capabilities.includes(opt.code)} onChange={() => toggleCapability(opt.code)} />
              {opt.label}
            </label>
          ))}
        </div>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
        fontFamily: T.body, fontSize: 13, color: T.text }}>
        <input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} />
        Active — a real submission is attempted for this carrier instead of Test Tools' simulator
      </label>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4, borderTop: `1px solid ${T.border}` }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!valid || saving} onClick={save}>{saving ? "Saving…" : isEdit ? "Save Changes" : "Add Integration"}</Btn>
      </div>
    </div>
  );
};

const MdmCarrierIntegrationsPage = () => {
  const { canManageMdm } = useAuth();
  const [rows,    setRows]    = useState([]);
  const [adapters, setAdapters] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | row (edit)
  const [confirm, setConfirm] = useState(null);
  const { template, startResize } = useResizableColumns("mdm-carrier-integrations", [100, 130, 90, 180, 90, 100]);
  const headers = ["Carrier", "Adapter", "Active", "Capabilities", "Credential", "Actions"];

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await api.carrierIntegrations.list()); } catch (e) { toast.error(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.carrierIntegrations.adapters().then(setAdapters).catch(() => setAdapters([])); }, []);

  const handleSave = async (form) => {
    try {
      if (modal === "add") {
        const created = await api.carrierIntegrations.create(form);
        toast.success(`${created.carrierCode} integration created`);
      } else {
        const updated = await api.carrierIntegrations.update(modal.id, form);
        toast.success(`${updated.carrierCode} integration saved`);
      }
      setModal(null);
      load();
    } catch (e) { toast.error(e.message || "Save failed"); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Carrier Integrations</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {rows.length} carrier{rows.length !== 1 ? "s" : ""} configured with a real API adapter — every other carrier keeps working through Test Tools' Message Simulator
          </p>
        </div>
        {canManageMdm && <Btn onClick={() => setModal("add")} size="lg">＋ Add Integration</Btn>}
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: template,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {headers.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < headers.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
            </div>
          ))}
        </div>
        {loading ? (
          <PageSpinner />
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No real carrier integrations configured yet — every carrier is currently answered only by Test Tools' Message Simulator.
          </div>
        ) : rows.map(r => (
          <div key={r.id}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{r.carrierCode}</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{r.adapterKey}</span>
            <Badge variant={r.isActive ? "success" : "default"}>{r.isActive ? "Active" : "Inactive"}</Badge>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {r.capabilities.length === 0 ? (
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.border, fontStyle: "italic" }}>None</span>
              ) : r.capabilities.map(c => <Badge key={c}>{c}</Badge>)}
            </div>
            <span style={{ fontFamily: T.mono, fontSize: 10.5, color: r.hasCredential ? T.success : T.textMuted }}>
              {r.hasCredential ? "● Set" : "— None"}
            </span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...(canManageMdm ? [{ icon: IconPencil, label: "Edit", onClick: () => setModal(r) }] : []),
                ...(canManageMdm ? [{ icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(r.id) }] : []),
              ]} />
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Carrier Integration" onClose={() => setModal(null)} width={560}>
          <IntegrationForm adapters={adapters} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Carrier Integration" onClose={() => setModal(null)} width={560}>
          <IntegrationForm init={modal} adapters={adapters} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message="Remove this carrier integration? That carrier falls back to Test Tools' Message Simulator immediately — no shipment data is affected."
          onConfirm={async () => { await api.carrierIntegrations.remove(confirm); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmCarrierIntegrationsPage;
