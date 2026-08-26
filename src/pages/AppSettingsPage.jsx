import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../tokens";
import { api, TOKEN_KEY } from "../api";
import postmanCollection  from "../dev/CargoDesk.postman_collection.json";
import postmanEnvironment from "../dev/CargoDesk.postman_environment.json";
import archHtml           from "../dev/architecture.html?raw";
import epicHtml           from "../dev/epic-TKT-D7AUBQ-coverage.html?raw";
import { toast } from "../toast";
import { useAuth } from "../AuthContext";
import Pagination from "../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../components/primitives/PageSizeSelect";
import UserManagementPanel from "../components/UserManagementPanel";
import { AiOrb, ORB_STYLES } from "../components/shared/AiOrb";
import { IconSettings } from "../components/primitives/Icon";
import EadapterConfigModal from "../components/shared/EadapterConfigModal";

// ─── External API definitions ─────────────────────────────────────────────────

const EXTERNAL_APIS = [
  {
    id: "fx",
    name: "FX Rates",
    provider: "Frankfurter / ECB",
    description: "Live currency exchange rates powering the currency converter widget.",
    testType: "http",
    testUrl: "https://api.frankfurter.app/latest?from=USD&to=EUR",
    hasRecurrence: true,
    defaultValue: "1",
    defaultUnit: "days",
    recurrenceLabel: "Refresh every",
  },
  {
    id: "weather",
    name: "Weather",
    provider: "Open-Meteo",
    description: "Port weather conditions displayed on the home dashboard.",
    testType: "http",
    testUrl: "https://api.open-meteo.com/v1/forecast?latitude=51.9&longitude=4.5&current=temperature_2m",
    hasRecurrence: true,
    defaultValue: "1",
    defaultUnit: "days",
    recurrenceLabel: "Refresh every",
  },
  {
    id: "ofac",
    name: "OFAC SDN Sanctions List",
    provider: "US Treasury",
    description: "Denied party screening list for compliance checks on shipment counterparties.",
    testType: "status",
    testUrl: null,
    hasRecurrence: true,
    defaultValue: "1",
    defaultUnit: "weeks",
    recurrenceLabel: "Sync every",
  },
  {
    id: "csl",
    name: "Consolidated Screening List",
    provider: "US Dept. of Commerce",
    description: "11 more denied-party lists beyond OFAC's own SDN list — BIS Denied Persons/Entity/Unverified/Military End User Lists, State Dept ITAR Debarred + Nonproliferation Sanctions, and 5 more OFAC-family lists. Additive to OFAC SDN above, not a replacement.",
    testType: "status",
    testUrl: null,
    hasRecurrence: true,
    defaultValue: "1",
    defaultUnit: "weeks",
    recurrenceLabel: "Sync every",
  },
  {
    id: "ais",
    name: "AIS Vessel Tracking",
    provider: "aisstream.io",
    description: "Live vessel position/static data — keeps the Vessels registry fresh and auto-detects sailing ATD/ATA. Free, no payment required, key-only signup at aisstream.io.",
    testType: "ais_status",
    hasApiKey: true,
    settingKey: "ais_api_key",
    keyHelpText: "Register free at aisstream.io to get an API key — no payment, no hardware required.",
    hasRecurrence: false,
  },
];

// ─── Internal API definitions ──────────────────────────────────────────────────

const INTERNAL_APIS = [
  {
    id: "ws",        name: "WebSocket Server",  provider: "Internal",
    description: "Real-time delivery of shipment messages and event notifications.",
    testType: "ws",  testUrl: null,
    hasToggle: true, settingKey: "api_ws_enabled",
  },
  {
    id: "server",    name: "API Server",         provider: "Internal",
    description: "Core health endpoint — confirms the Express server is reachable.",
    testType: "http", testUrl: "/api/health",
    hasToggle: false,
  },
  {
    id: "shipments", name: "Shipments",           provider: "Internal",
    description: "Shipment records — list, create, update, delete.",
    testType: "http", testUrl: "/api/shipments",
    hasToggle: true, settingKey: "api_shipments_enabled",
  },
  {
    id: "contracts", name: "Contracts",           provider: "Internal",
    description: "Carrier rate contracts with legs and IMDG class filters.",
    testType: "http", testUrl: "/api/contracts?limit=1",
    hasToggle: true, settingKey: "api_contracts_enabled",
  },
  {
    id: "customers", name: "Customers",           provider: "Internal",
    description: "Customer records with address and contact details.",
    testType: "http", testUrl: "/api/customers?limit=1",
    hasToggle: true, settingKey: "api_customers_enabled",
  },
  {
    id: "carriers",  name: "Carriers",            provider: "Internal",
    description: "Carrier master data.",
    testType: "http", testUrl: "/api/carriers",
    hasToggle: true, settingKey: "api_carriers_enabled",
  },
  {
    id: "vessels",   name: "Vessels",             provider: "Internal",
    description: "IMO vessel registry — 349 vessels.",
    testType: "http", testUrl: "/api/vessels?limit=1",
    hasToggle: true, settingKey: "api_vessels_enabled",
  },
  {
    id: "ports",     name: "Port Locations",      provider: "Internal",
    description: "14,269 UN/LOCODE port locations and linked port pairs.",
    testType: "http", testUrl: "/api/port-locations?limit=1",
    hasToggle: true, settingKey: "api_ports_enabled",
  },
  {
    id: "sysmsg",    name: "System Messages",     provider: "Internal",
    description: "Operational notices with severity and active date ranges.",
    testType: "http", testUrl: "/api/system-messages",
    hasToggle: true, settingKey: "api_sysmsg_enabled",
  },
];

// ─── Shared components ────────────────────────────────────────────────────────

function Toggle({ on, onChange }) {
  return (
    <button onClick={onChange} type="button"
      title={on ? "Click to disable" : "Click to enable"}
      style={{
        flexShrink: 0, width: 46, height: 25, borderRadius: 13,
        border: "none", cursor: "pointer", padding: 0,
        background: on ? T.success : T.border,
        position: "relative", transition: "background 0.18s",
      }}>
      <div style={{
        position: "absolute", top: 3, left: on ? 24 : 3,
        width: 19, height: 19, borderRadius: "50%",
        background: "white", boxShadow: "0 1px 3px rgba(0,0,0,.3)",
        transition: "left 0.18s",
      }} />
    </button>
  );
}

function StatusDot({ result, testing }) {
  if (testing) return (
    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>Testing…</span>
  );
  if (!result) return null;
  if (result.ok) return (
    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.success }}>
      ● {result.label ?? (result.status ? `HTTP ${result.status}` : "Connected")}
      {result.latency != null ? ` · ${result.latency} ms` : ""}
    </span>
  );
  return (
    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.danger }}>
      ✕ {result.error || "Failed"}
    </span>
  );
}

const TABS_BASE   = ["API Controls", "Finance", "Compliance", "Developer"];
const API_SUBTABS = ["External APIs", "Internal APIs", "Security", "Single Sign-On", "System Email", "AI Agent"];

const downloadJson = (data, filename) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
};

// ─── Milestone Template Manager ───────────────────────────────────────────────

const MILESTONE_KEYS = [
  { key: "booking_confirmed", label: "Booking Confirmed" },
  { key: "si_submitted",      label: "SI Submitted" },
  { key: "cargo_gated_in",    label: "Cargo Gated In" },
  { key: "vessel_departed",   label: "Vessel Departed" },
  { key: "bl_issued",         label: "B/L Issued" },
  { key: "vessel_arrived",    label: "Vessel Arrived" },
  { key: "customs_cleared",   label: "Customs Cleared" },
  { key: "cargo_released",    label: "Cargo Released" },
  { key: "delivered",         label: "Delivered" },
];

const inp = (extra = {}) => ({
  fontFamily: T.body, fontSize: 12, padding: "5px 8px",
  background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6,
  color: T.text, outline: "none", width: "100%", boxSizing: "border-box",
  ...extra,
});

function MilestoneTemplatesPanel() {
  const [templates, setTemplates] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [editId,    setEditId]    = useState(null);
  const [addOpen,   setAddOpen]   = useState(false);
  const blank = { templateKey: "FCL", carrierCode: "", tradeLane: "", milestoneKey: "booking_confirmed", label: "Booking Confirmed", sequenceOrder: 1 };
  const [form, setForm] = useState(blank);

  const load = useCallback(() => {
    setLoading(true);
    api.milestoneTemplates.list()
      .then(setTemplates)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    try {
      if (editId) {
        const updated = await api.milestoneTemplates.update(editId, form);
        setTemplates(p => p.map(t => t.id === editId ? updated : t));
        toast.success("Template updated");
      } else {
        const created = await api.milestoneTemplates.create(form);
        setTemplates(p => [...p, created]);
        toast.success("Milestone added");
      }
      setEditId(null); setAddOpen(false); setForm(blank);
    } catch (e) { toast.error(e.message); }
  };

  const remove = async (id) => {
    try {
      await api.milestoneTemplates.remove(id);
      setTemplates(p => p.filter(t => t.id !== id));
      toast.success("Removed");
    } catch (e) { toast.error(e.message); }
  };

  const startEdit = (t) => {
    setForm({ templateKey: t.templateKey, carrierCode: t.carrierCode, tradeLane: t.tradeLane,
      milestoneKey: t.milestoneKey, label: t.label, sequenceOrder: t.sequenceOrder });
    setEditId(t.id); setAddOpen(true);
  };

  const cancel = () => { setEditId(null); setAddOpen(false); setForm(blank); };

  // Group by (templateKey, carrierCode, tradeLane) for display
  const groups = templates.reduce((acc, t) => {
    const key = `${t.templateKey}|${t.carrierCode || ""}|${t.tradeLane || ""}`;
    if (!acc[key]) acc[key] = { templateKey: t.templateKey, carrierCode: t.carrierCode, tradeLane: t.tradeLane, items: [] };
    acc[key].items.push(t);
    return acc;
  }, {});

  const hdr = { fontFamily: T.body, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: T.textMuted };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>Milestone Templates</div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 2 }}>
            Define milestone sequences per shipment type, carrier, or trade lane.
          </div>
        </div>
        <button onClick={() => { cancel(); setAddOpen(true); }}
          style={{ fontFamily: T.body, fontSize: 12, padding: "6px 14px", borderRadius: 6,
            background: T.accent, color: "#fff", border: "none", cursor: "pointer" }}>
          + Add Milestone
        </button>
      </div>

      {addOpen && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
          padding: 16, marginBottom: 20 }}>
          <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 12 }}>
            {editId ? "Edit Milestone" : "New Milestone"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto auto", gap: 8, alignItems: "end" }}>
            <div>
              <div style={{ ...hdr, marginBottom: 4 }}>Type</div>
              <select value={form.templateKey} onChange={e => setF("templateKey", e.target.value)} style={inp()}>
                <option value="FCL">FCL</option>
                <option value="LCL">LCL</option>
                <option value="AIR">AIR</option>
              </select>
            </div>
            <div>
              <div style={{ ...hdr, marginBottom: 4 }}>Carrier (opt.)</div>
              <input value={form.carrierCode} onChange={e => setF("carrierCode", e.target.value.toUpperCase())}
                placeholder="e.g. MSCU" style={inp({ fontFamily: T.mono })} />
            </div>
            <div>
              <div style={{ ...hdr, marginBottom: 4 }}>Trade Lane (opt.)</div>
              <input value={form.tradeLane} onChange={e => setF("tradeLane", e.target.value.toUpperCase())}
                placeholder="e.g. EU-N" style={inp({ fontFamily: T.mono })} />
            </div>
            <div>
              <div style={{ ...hdr, marginBottom: 4 }}>Seq.</div>
              <input type="number" value={form.sequenceOrder} onChange={e => setF("sequenceOrder", Number(e.target.value))}
                min={1} style={inp({ width: 64 })} />
            </div>
            <div style={{ gridColumn: "1 / -3" }}>
              <div style={{ ...hdr, marginBottom: 4 }}>Milestone Key</div>
              <select value={form.milestoneKey}
                onChange={e => { const found = MILESTONE_KEYS.find(m => m.key === e.target.value); setForm(p => ({ ...p, milestoneKey: e.target.value, label: found?.label || p.label })); }}
                style={inp()}>
                {MILESTONE_KEYS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                <option value="custom">Custom…</option>
              </select>
            </div>
            <div>
              <div style={{ ...hdr, marginBottom: 4 }}>Label</div>
              <input value={form.label} onChange={e => setF("label", e.target.value)} style={inp()} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={save}
              style={{ fontFamily: T.body, fontSize: 12, padding: "5px 14px", borderRadius: 6,
                background: T.accent, color: "#fff", border: "none", cursor: "pointer" }}>
              {editId ? "Save Changes" : "Add"}
            </button>
            <button onClick={cancel}
              style={{ fontFamily: T.body, fontSize: 12, padding: "5px 14px", borderRadius: 6,
                background: "transparent", color: T.textMuted, border: `1px solid ${T.border}`, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, padding: 24, textAlign: "center" }}>Loading…</div>
      ) : Object.keys(groups).length === 0 ? (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, padding: 24, textAlign: "center" }}>
          No templates configured. Add a milestone above to get started.
        </div>
      ) : Object.values(groups).map((g, gi) => (
        <div key={gi} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
          marginBottom: 12, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", background: T.bg, borderBottom: `1px solid ${T.border}`,
            display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>{g.templateKey}</span>
            {g.carrierCode && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, background: T.accent + "18", borderRadius: 4, padding: "1px 6px" }}>{g.carrierCode}</span>}
            {g.tradeLane  && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.info,   background: T.info   + "18", borderRadius: 4, padding: "1px 6px" }}>{g.tradeLane}</span>}
            {!g.carrierCode && !g.tradeLane && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>— base template</span>}
            <span style={{ marginLeft: "auto", fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{g.items.length} milestone{g.items.length !== 1 ? "s" : ""}</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {["Seq", "Key", "Label", ""].map(h => (
                  <th key={h} style={{ ...hdr, padding: "6px 14px", textAlign: "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.items.sort((a, b) => a.sequenceOrder - b.sequenceOrder).map(t => (
                <tr key={t.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, padding: "7px 14px", width: 40 }}>{t.sequenceOrder}</td>
                  <td style={{ fontFamily: T.mono, fontSize: 11, color: T.text, padding: "7px 14px" }}>{t.milestoneKey}</td>
                  <td style={{ fontFamily: T.body, fontSize: 12, color: T.text, padding: "7px 14px" }}>{t.label}</td>
                  <td style={{ padding: "7px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                    <button onClick={() => startEdit(t)}
                      style={{ fontFamily: T.body, fontSize: 11, padding: "2px 10px", borderRadius: 4,
                        background: "transparent", color: T.textMuted, border: `1px solid ${T.border}`, cursor: "pointer", marginRight: 6 }}>
                      Edit
                    </button>
                    <button onClick={() => remove(t.id)}
                      style={{ fontFamily: T.body, fontSize: 11, padding: "2px 10px", borderRadius: 4,
                        background: "transparent", color: T.danger, border: `1px solid ${T.danger}44`, cursor: "pointer" }}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ─── Security Settings Panel ──────────────────────────────────────────────────

function SecuritySettingsPanel({ settings, onChange }) {
  const sec = {
    login_max_attempts:    settings.login_max_attempts    ?? '5',
    login_lockout_minutes: settings.login_lockout_minutes ?? '30',
    jwt_lifetime_hours:    settings.jwt_lifetime_hours    ?? '8',
    password_expiry_days:  settings.password_expiry_days  ?? '90',
  };
  const row = { display: "flex", alignItems: "center", gap: 14, marginBottom: 18 };
  const lbl = { fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.textMuted,
    width: 200, flexShrink: 0, textTransform: "uppercase", letterSpacing: ".06em" };
  return (
    <div style={{ maxWidth: 560 }}>
      <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 20 }}>
        Login Security
      </h3>
      {[
        { key: "login_max_attempts",    label: "Max failed attempts",    hint: "Lockout after N failures (0 = disabled)" },
        { key: "login_lockout_minutes", label: "Lockout duration (min)", hint: "How long the account stays locked" },
        { key: "jwt_lifetime_hours",    label: "Session lifetime (hrs)", hint: "JWT token expiry; requires re-login" },
        { key: "password_expiry_days",  label: "Password expiry (days)", hint: "Prompt to change password after N days (0 = disabled)" },
      ].map(({ key, label, hint }) => (
        <div key={key} style={row}>
          <div style={lbl}>{label}</div>
          <div style={{ flex: 1 }}>
            <input
              type="number" min="0" value={sec[key]}
              onChange={e => onChange(key, e.target.value)}
              style={{ ...inp(), width: 100 }}
            />
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 3 }}>{hint}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── SSO Settings Panel ───────────────────────────────────────────────────────

function SsoSettingsPanel({ settings, onChange }) {
  const [showSecret, setShowSecret] = useState(false);
  const s = settings;
  const enabled = s.sso_enabled === '1';
  const fld = { marginBottom: 16 };
  const lbl = { display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 };
  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>
          Azure AD / Entra ID SSO
        </h3>
        <Toggle on={enabled} onChange={() => onChange('sso_enabled', enabled ? '0' : '1')} />
      </div>

      {!enabled && (
        <div style={{ padding: "12px 16px", borderRadius: 8, background: T.border + "30",
          fontFamily: T.body, fontSize: 13, color: T.textMuted, marginBottom: 20 }}>
          Enable the toggle above to activate SSO. Local login always remains available as fallback.
        </div>
      )}

      {[
        { key: "sso_tenant_id",      label: "Tenant ID",      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", type: "text" },
        { key: "sso_client_id",      label: "Client ID",      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", type: "text" },
        { key: "sso_redirect_uri",   label: "Redirect URI",   placeholder: "https://yourapp.com/api/auth/sso/callback", type: "text" },
        { key: "sso_frontend_url",   label: "Frontend URL",   placeholder: "http://localhost:5173", type: "text" },
      ].map(({ key, label, placeholder, type }) => (
        <div key={key} style={fld}>
          <label style={lbl}>{label}</label>
          <input type={type} value={s[key] || ''} placeholder={placeholder}
            onChange={e => onChange(key, e.target.value)}
            style={inp()} disabled={!enabled} />
        </div>
      ))}

      <div style={fld}>
        <label style={lbl}>Client Secret</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input type={showSecret ? "text" : "password"} value={s.sso_client_secret || ''}
            placeholder="Paste client secret…"
            onChange={e => onChange('sso_client_secret', e.target.value)}
            style={{ ...inp(), flex: 1 }} disabled={!enabled} />
          <button type="button" onClick={() => setShowSecret(x => !x)}
            style={{ ...inp(), width: 64, cursor: "pointer", flexShrink: 0 }}>
            {showSecret ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      <div style={fld}>
        <label style={lbl}>Default role for new SSO users</label>
        <select value={s.sso_default_role || 'operator'} disabled={!enabled}
          onChange={e => onChange('sso_default_role', e.target.value)}
          style={{ ...inp(), width: 180, cursor: "pointer" }}>
          <option value="operator">Operator</option>
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
        </select>
      </div>

      {enabled && (
        <div style={{ padding: "12px 16px", borderRadius: 8, border: `1px solid ${T.accent}44`,
          background: T.accent + "0a", fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          <strong style={{ color: T.text }}>Login URL:</strong>{" "}
          <code style={{ fontFamily: T.mono, fontSize: 11 }}>/api/auth/sso/init</code>
          {"  "}— link this from your identity provider or share with users.
        </div>
      )}
    </div>
  );
}

// ─── System Email Settings Panel ──────────────────────────────────────────────
// Org-wide SMTP used only to send forgot-password links (routes/auth.js) — distinct from
// per-office mail settings (OfficeMailSettingsModal, org/OfficePage.jsx), which sends shipment
// documents from a specific office's own identity. Own dedicated GET/PUT/test routes (never
// folded into the generic /api/settings blob, which is public and unfiltered) — same reasoning
// as OfficeMailSettingsModal, so this panel manages its own local state/fetch rather than the
// shared settings/onChange props every other panel on this tab uses.
const SECURE_MODE_LABELS_SYS = { none: "None (port 25)", starttls: "STARTTLS (port 587)", tls: "TLS/SSL (port 465)" };

function SystemEmailSettingsPanel() {
  const { user } = useAuth();
  const [data,    setData]    = useState(null);
  const [form,    setForm]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testTo,  setTestTo]  = useState("");

  useEffect(() => {
    api.systemEmail.get()
      .then(d => {
        setData(d);
        setForm({ smtpHost: d.smtpHost, smtpPort: d.smtpPort, secureMode: d.secureMode,
          smtpUsername: d.smtpUsername, smtpPassword: "", fromAddress: d.fromAddress,
          fromName: d.fromName, isActive: d.isActive });
        setTestTo(user?.email || "");
      })
      .catch(() => toast.error("Failed to load system email settings"))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading || !form) return (
    <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, padding: "20px 0" }}>Loading…</div>
  );

  const fld = { marginBottom: 16 };
  const lbl = { display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 };
  const set = k => e => setForm(p => ({ ...p, [k]: e.target.value }));

  const handleSave = async () => {
    if (!form.smtpHost.trim())    return toast.error("SMTP host is required");
    if (!form.fromAddress.trim()) return toast.error("From address is required");
    setSaving(true);
    try {
      const updated = await api.systemEmail.update(form);
      setData(updated);
      setForm(p => ({ ...p, smtpPassword: "" }));
      toast.success("System email settings saved");
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };

  const handleTest = async () => {
    if (!testTo.trim()) return toast.error("Enter a test-recipient address");
    setTesting(true);
    try {
      await api.systemEmail.sendTest({ to: testTo, ...form });
      toast.success(`Test email sent to ${testTo}`);
    } catch (e) { toast.error(e.message); } finally { setTesting(false); }
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ marginBottom: 20 }}>
        <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 4px" }}>
          System Email (Password Reset)
        </h3>
        <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, margin: 0, lineHeight: 1.5 }}>
          Outgoing SMTP used only to send forgot-password reset links — not tied to any one
          office. Without this configured, reset requests still succeed (no user-enumeration
          signal either way) but no email actually goes out.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10, marginBottom: 10 }}>
        <div>
          <label style={lbl}>SMTP Host <span style={{ color: T.danger }}>*</span></label>
          <input value={form.smtpHost} onChange={set("smtpHost")} placeholder="smtp.example.com" style={{ ...inp(), fontFamily: T.mono }} />
        </div>
        <div>
          <label style={lbl}>Port</label>
          <input type="number" value={form.smtpPort}
            onChange={e => setForm(p => ({ ...p, smtpPort: parseInt(e.target.value, 10) || 0 }))}
            style={{ ...inp(), fontFamily: T.mono }} />
        </div>
      </div>

      <div style={fld}>
        <label style={lbl}>Encryption</label>
        <select value={form.secureMode} onChange={set("secureMode")} style={{ ...inp(), cursor: "pointer" }}>
          {Object.entries(SECURE_MODE_LABELS_SYS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div>
          <label style={lbl}>Username</label>
          <input value={form.smtpUsername} onChange={set("smtpUsername")} style={inp()} />
        </div>
        <div>
          <label style={lbl}>Password</label>
          <input type="password" value={form.smtpPassword} onChange={set("smtpPassword")}
            placeholder={data?.hasPassword ? "Leave blank to keep current" : ""} style={inp()} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div>
          <label style={lbl}>From Address <span style={{ color: T.danger }}>*</span></label>
          <input value={form.fromAddress} onChange={set("fromAddress")} placeholder="no-reply@example.com" style={inp()} />
        </div>
        <div>
          <label style={lbl}>From Name</label>
          <input value={form.fromName} onChange={set("fromName")} placeholder="e.g. CargoDesk" style={inp()} />
        </div>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 20 }}>
        <input type="checkbox" checked={form.isActive}
          onChange={e => setForm(p => ({ ...p, isActive: e.target.checked }))}
          style={{ accentColor: T.accent, width: 16, height: 16 }} />
        <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>Active</span>
      </label>

      {testOpen && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14,
          padding: "10px 12px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}` }}>
          <input value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="test-recipient@example.com"
            style={{ ...inp(), flex: 1 }} />
          <button type="button" onClick={handleTest} disabled={testing}
            style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: T.accent,
              color: "#fff", cursor: "pointer", fontFamily: T.body, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>
            {testing ? "Sending…" : "Send"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
        <button type="button" onClick={() => setTestOpen(o => !o)}
          style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${T.border}`,
            background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 13, color: T.text }}>
          {testOpen ? "Cancel Test" : "Send Test Email"}
        </button>
        <button type="button" onClick={handleSave} disabled={saving}
          style={{ padding: "6px 18px", borderRadius: 7, border: "none", background: T.accent,
            color: "#fff", cursor: "pointer", fontFamily: T.body, fontSize: 13, fontWeight: 600 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ─── DG Compliance Settings Panel ─────────────────────────────────────────────
// One reusable org-wide emergency-contact/compliance record (TKT-DPLQTV) — confirmed
// via direct answer, a single record is enough for FCL, no per-office variation
// needed, so this is a settings panel (like Login Security above) rather than a
// CRUD list like Pack Types or Charge Codes. Pulled onto the DG01 Dangerous Goods
// Declaration's emergency-contact line (buildDGDeclHtml, App.jsx) in place of the
// hand-filled blank that sat there before.

function DgComplianceSettingsPanel({ settings, onChange }) {
  const c = {
    dg_compliance_contact_name: settings.dg_compliance_contact_name ?? '',
    dg_compliance_phone:        settings.dg_compliance_phone        ?? '',
    dg_compliance_email:        settings.dg_compliance_email        ?? '',
    dg_compliance_address:      settings.dg_compliance_address      ?? '',
  };
  const fld = { marginBottom: 16 };
  const lbl = { display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 };
  return (
    <div style={{ maxWidth: 560 }}>
      <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 8 }}>
        DG Compliance Address
      </h3>
      <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, lineHeight: 1.6, marginBottom: 20 }}>
        A single 24hr emergency-contact / compliance record for the whole organization —
        printed on the Dangerous Goods Declaration (DG01) in place of a hand-filled blank.
      </p>
      <div style={fld}>
        <label style={lbl}>Contact Name</label>
        <input value={c.dg_compliance_contact_name} placeholder="e.g. CHEMTREC"
          onChange={e => onChange('dg_compliance_contact_name', e.target.value)} style={inp()} />
      </div>
      <div style={fld}>
        <label style={lbl}>Phone</label>
        <input value={c.dg_compliance_phone} placeholder="e.g. +1 703-527-3887"
          onChange={e => onChange('dg_compliance_phone', e.target.value)} style={inp()} />
      </div>
      <div style={fld}>
        <label style={lbl}>Email</label>
        <input type="email" value={c.dg_compliance_email} placeholder="e.g. dg-compliance@yourcompany.com"
          onChange={e => onChange('dg_compliance_email', e.target.value)} style={inp()} />
      </div>
      <div style={fld}>
        <label style={lbl}>Address</label>
        <textarea rows={3} value={c.dg_compliance_address} placeholder="Street, city, country"
          onChange={e => onChange('dg_compliance_address', e.target.value)}
          style={{ ...inp(), resize: "vertical" }} />
      </div>
    </div>
  );
}

// ─── Admin Activity Log ───────────────────────────────────────────────────────

const ACTION_LABELS = {
  USER_CREATED:     { label: "User created",         color: "success" },
  USER_CREATED_SSO: { label: "User created via SSO", color: "success" },
  USER_UPDATED:     { label: "User updated",         color: "info"    },
  USER_DELETED:     { label: "User deleted",         color: "danger"  },
  SESSIONS_REVOKED: { label: "Sessions revoked",     color: "warning" },
  LOGIN_LOCKED:     { label: "Account locked",       color: "warning" },
  SYSMSG_CREATED:   { label: "System message posted",color: "info"    },
  SYSMSG_DELETED:   { label: "System message deleted",color:"danger"  },
  SETTINGS_UPDATED: { label: "Settings changed",     color: "info"    },
};

function AdminActivityLog() {
  const [events,  setEvents]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [limit,   setLimit]   = useState(getStoredPageSize);
  const [filter,  setFilter]  = useState("");

  const load = useCallback((off = 0, f = "", lim = limit) => {
    setLoading(true);
    const params = { limit: lim, offset: off };
    if (f) params.action = f;
    api.adminEvents.list(params)
      .then(({ results, total }) => { setEvents(results); setTotal(total); })
      .catch(() => toast.error("Failed to load activity log"))
      .finally(() => setLoading(false));
  }, [limit]);

  useEffect(() => { load(0, filter); setOffset(0); }, [filter, load]);

  const goPage = off => { setOffset(off); load(off, filter); };
  const changeLimit = n => { setLimit(n); setOffset(0); load(0, filter, n); };

  const fmtDate = (iso) => new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>
          Admin Activity Log
        </h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={filter} onChange={e => setFilter(e.target.value)}
            style={{ ...inp(), width: 200, cursor: "pointer" }}>
            <option value="">All actions</option>
            {Object.entries(ACTION_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <button onClick={() => load(offset, filter)} type="button"
            style={{ ...inp(), width: 70, cursor: "pointer", textAlign: "center" }}>
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
          Loading…
        </div>
      ) : events.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13, fontStyle: "italic" }}>
          No admin events recorded yet.
        </div>
      ) : (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.body, fontSize: 12 }}>
            <thead>
              <tr style={{ background: T.surface, borderBottom: `1px solid ${T.border}` }}>
                {["Timestamp", "Actor", "Action", "Target", "Details"].map(h => (
                  <th key={h} style={{ padding: "9px 12px", textAlign: "left", fontWeight: 600,
                    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em", fontSize: 10 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((ev, i) => {
                const meta = ACTION_LABELS[ev.action] || { label: ev.action, color: "info" };
                const colorKey = { success: T.success, danger: T.danger, warning: T.warning, info: T.accent }[meta.color] || T.accent;
                return (
                  <tr key={ev.id} style={{ borderBottom: `1px solid ${T.border}`,
                    background: i % 2 === 0 ? "transparent" : T.surface + "80" }}>
                    <td style={{ padding: "8px 12px", color: T.textMuted, whiteSpace: "nowrap" }}>
                      {fmtDate(ev.created_at)}
                    </td>
                    <td style={{ padding: "8px 12px", color: T.text, fontFamily: T.mono, fontSize: 11 }}>
                      {ev.actor_email || ev.actor_id || "—"}
                    </td>
                    <td style={{ padding: "8px 12px" }}>
                      <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                        background: colorKey + "18", color: colorKey }}>
                        {meta.label}
                      </span>
                    </td>
                    <td style={{ padding: "8px 12px", color: T.textMuted, fontFamily: T.mono, fontSize: 11 }}>
                      {ev.target_type ? `${ev.target_type} ${ev.target_id}` : "—"}
                    </td>
                    <td style={{ padding: "8px 12px", color: T.textMuted, fontFamily: T.mono, fontSize: 10,
                      maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {Object.keys(ev.details || {}).length
                        ? JSON.stringify(ev.details)
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <PageSizeSelect value={limit} onChange={changeLimit} />
        <div style={{ flex: 1 }}><Pagination total={total} limit={limit} offset={offset} onPage={goPage} /></div>
      </div>
    </div>
  );
}

// ─── AI Agent Settings Panel ──────────────────────────────────────────────────

function AiAgentSettingsPanel({ settings, onChange }) {
  const [showKey,    setShowKey]    = useState(false);
  const [testing,   setTesting]    = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [orbStyle,  setOrbStyle]   = useState(() => localStorage.getItem("cc_orb_style") || "radar");
  const s = settings;

  const applyOrbStyle = (id) => {
    localStorage.setItem("cc_orb_style", id);
    setOrbStyle(id);
    window.dispatchEvent(new Event("cc-orb-style-changed"));
  };

  const row  = { display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 18 };
  const lbl  = { fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.textMuted,
    width: 180, flexShrink: 0, textTransform: "uppercase", letterSpacing: ".06em", paddingTop: 6 };

  const PROVIDERS = [
    { label: "Anthropic Claude API", endpoint: "https://api.anthropic.com/v1/messages", model: "claude-haiku-4-5-20251001" },
    { label: "OpenRouter",           endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "anthropic/claude-haiku-4-5" },
    { label: "Custom / Local",       endpoint: "", model: "" },
  ];

  const handleProviderSelect = (p) => {
    if (p.endpoint) onChange("ai_endpoint", p.endpoint);
    if (p.model)    onChange("ai_model",    p.model);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("cargodesk_token")}`,
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "Hello! Reply with one sentence confirming you are connected." }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Connection failed");
      setTestResult({ ok: true, msg: data.reply || "Connected!" });
    } catch (e) {
      setTestResult({ ok: false, msg: e.message });
    }
    setTesting(false);
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 6 }}>
        AI Agent
      </h3>
      <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 24, lineHeight: 1.6 }}>
        Enable the AI chat assistant and configure the LLM backend. The agent can query shipments,
        contracts, and allocations using built-in tool definitions.
      </p>

      {/* Enable toggle */}
      <div style={row}>
        <div style={lbl}>Enabled</div>
        <div>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
            fontFamily: T.body, fontSize: 13, color: T.text }}>
            <input type="checkbox"
              checked={s.ai_agent_enabled === '1'}
              onChange={e => onChange("ai_agent_enabled", e.target.checked ? '1' : '0')} />
            Allow users to open the AI chat drawer
          </label>
        </div>
      </div>

      {/* Quick presets */}
      <div style={row}>
        <div style={lbl}>Provider preset</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {PROVIDERS.map(p => (
            <button key={p.label} type="button" onClick={() => handleProviderSelect(p)}
              style={{ padding: "4px 12px", borderRadius: 6, border: `1px solid ${T.border}`,
                background: (s.ai_endpoint || "") === p.endpoint && p.endpoint ? T.accentBg : T.bg,
                color: (s.ai_endpoint || "") === p.endpoint && p.endpoint ? T.accent : T.text,
                fontFamily: T.body, fontSize: 11, cursor: "pointer" }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Endpoint */}
      <div style={row}>
        <div style={lbl}>Endpoint URL</div>
        <div style={{ flex: 1 }}>
          <input type="url" value={s.ai_endpoint || ''} placeholder="https://api.anthropic.com/v1/messages"
            onChange={e => onChange("ai_endpoint", e.target.value)}
            style={{ ...inp(), width: "100%" }} />
        </div>
      </div>

      {/* Model */}
      <div style={row}>
        <div style={lbl}>Model</div>
        <div style={{ flex: 1 }}>
          <input type="text" value={s.ai_model || ''} placeholder="claude-haiku-4-5-20251001"
            onChange={e => onChange("ai_model", e.target.value)}
            style={{ ...inp(), width: "100%" }} />
        </div>
      </div>

      {/* API Key */}
      <div style={row}>
        <div style={lbl}>API Key</div>
        <div style={{ flex: 1, display: "flex", gap: 8 }}>
          <input type={showKey ? "text" : "password"} value={s.ai_api_key || ''} placeholder="sk-…"
            onChange={e => onChange("ai_api_key", e.target.value)}
            style={{ ...inp(), flex: 1 }} autoComplete="new-password" />
          <button type="button" onClick={() => setShowKey(v => !v)}
            style={{ padding: "4px 10px", border: `1px solid ${T.border}`, borderRadius: 6,
              background: T.bg, color: T.textMuted, fontFamily: T.body, fontSize: 11, cursor: "pointer" }}>
            {showKey ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {/* System prompt */}
      <div style={row}>
        <div style={lbl}>System prompt</div>
        <div style={{ flex: 1 }}>
          <textarea value={s.ai_system_prompt || ''}
            onChange={e => onChange("ai_system_prompt", e.target.value)}
            rows={4} placeholder="You are CargoDesk AI — an intelligent freight assistant…"
            style={{ ...inp(), width: "100%", resize: "vertical", fontFamily: T.body, lineHeight: 1.5 }} />
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 3 }}>
            Leave blank to use the default CargoDesk prompt.
          </div>
        </div>
      </div>

      {/* Orb / indicator style picker */}
      <div style={{ marginTop: 28, marginBottom: 8 }}>
        <div style={{ fontFamily: T.head, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>
          Indicator Style
        </div>
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 16, lineHeight: 1.5 }}>
          Choose the visual design for the AI agent orb shown in the Command Center and chat drawer.
          Changes take effect immediately.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {ORB_STYLES.map(style => {
            const active = orbStyle === style.id;
            return (
              <button key={style.id} type="button" onClick={() => applyOrbStyle(style.id)}
                style={{
                  padding: "0 0 14px",
                  borderRadius: 12,
                  border: `2px solid ${active ? "#f97316" : T.border}`,
                  background: active ? "#f9731608" : T.bg,
                  cursor: "pointer",
                  display: "flex", flexDirection: "column", alignItems: "center",
                  transition: "border-color .15s, background .15s",
                  overflow: "hidden",
                }}>
                {/* Dark preview canvas */}
                <div style={{
                  width: "100%", paddingTop: "100%",
                  position: "relative",
                  background: "#030a14",
                  marginBottom: 10,
                  borderRadius: "10px 10px 0 0",
                  backgroundImage: "radial-gradient(circle, #1a2f4a18 1px, transparent 1px)",
                  backgroundSize: "16px 16px",
                }}>
                  <div style={{
                    position: "absolute", inset: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <AiOrb size={80} orbStyle={style.id} />
                  </div>
                </div>
                {/* Label */}
                <div style={{
                  fontFamily: T.head, fontSize: 12, fontWeight: 700,
                  color: active ? "#f97316" : T.text, marginBottom: 2,
                }}>
                  {style.label}
                </div>
                <div style={{
                  fontFamily: T.body, fontSize: 10.5,
                  color: T.textMuted, textAlign: "center",
                  padding: "0 8px", lineHeight: 1.4,
                }}>
                  {style.desc}
                </div>
                {active && (
                  <div style={{
                    marginTop: 6,
                    fontSize: 10, fontFamily: T.mono,
                    color: "#f97316", fontWeight: 700, letterSpacing: ".08em",
                  }}>
                    ✓ ACTIVE
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Test connection */}
      <div style={{ marginTop: 8 }}>
        <button type="button" onClick={handleTest} disabled={testing || s.ai_agent_enabled !== '1'}
          style={{ padding: "7px 18px", borderRadius: 7, border: `1px solid ${T.accent}44`,
            background: T.accentBg, color: T.accent, fontFamily: T.body, fontSize: 13,
            fontWeight: 600, cursor: testing ? "wait" : "pointer",
            opacity: (testing || s.ai_agent_enabled !== '1') ? 0.6 : 1 }}>
          {testing ? "Testing…" : "Test Connection"}
        </button>
        {testResult && (
          <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, fontFamily: T.body, fontSize: 12,
            background: testResult.ok ? T.success + "18" : T.danger + "18",
            color: testResult.ok ? T.success : T.danger,
            border: `1px solid ${testResult.ok ? T.success : T.danger}44` }}>
            {testResult.msg}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Offices Panel ────────────────────────────────────────────────────────────

const DEPT_LABELS = { SE: "Sea Export", SI: "Sea Import" };
const DEPT_COLOR  = { SE: { bg: "#3b82f618", text: "#3b82f6" }, SI: { bg: "#10b98118", text: "#10b981" } };

function OfficesPanel() {
  const [offices,        setOffices]        = useState([]);
  const [branches,       setBranches]       = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [formOpen,       setFormOpen]       = useState(false);
  const [editing,        setEditing]        = useState(null);
  const [form,           setForm]           = useState({ unlocode: "", department: "SE", name: "", countryCode: "", branchId: "" });
  const [saving,         setSaving]         = useState(false);
  const [resolving,      setResolving]      = useState(false);
  const [codePreview,    setCodePreview]    = useState("");
  const [defaultOffice,  setDefaultOffice]  = useState("");   // app_settings default_office_id
  const [allowAll,       setAllowAll]       = useState(false); // app_settings offices_allow_all
  const [savingGlobal,   setSavingGlobal]   = useState(false);
  const [grantingAll,    setGrantingAll]    = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.offices.list(),
      api.branches.list(),
      api.settings.get(),
    ]).then(([list, br, s]) => {
      setOffices(list);
      setBranches(br);
      setDefaultOffice(s.default_office_id || "");
      setAllowAll(s.offices_allow_all === "1");
    }).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Auto-resolve LOCODE → country code + port name + code preview
  const resolveLocode = async (raw) => {
    const locode = raw.toUpperCase().trim();
    const country = locode.length >= 2 ? locode.slice(0, 2) : "";
    setForm(p => {
      const dept = p.department;
      setCodePreview(locode.length >= 3 ? `${country}-${locode}-${dept}` : "");
      return { ...p, unlocode: locode, countryCode: country };
    });
    if (locode.length < 5) return;
    setResolving(true);
    try {
      const port = await api.portLocations.get(locode);
      if (port) {
        const deptLabel = { SE: "Sea Export", SI: "Sea Import" };
        setForm(p => ({
          ...p,
          name: p.name || `${port.name} ${deptLabel[p.department] || p.department}`,
        }));
      }
    } catch { /* port not found, ignore */ } finally { setResolving(false); }
  };

  const openNew  = () => {
    setEditing(null);
    setForm({ unlocode: "", department: "SE", name: "", countryCode: "", branchId: "" });
    setCodePreview("");
    setFormOpen(true);
  };
  const openEdit = (o) => {
    setEditing(o);
    setForm({ unlocode: o.unlocode, department: o.department, name: o.name, countryCode: o.countryCode, branchId: o.branchId || "" });
    setCodePreview("");
    setFormOpen(true);
  };

  const handleSave = async () => {
    if (!form.unlocode || !form.department || !form.name) return toast.error("All fields required");
    setSaving(true);
    try {
      if (editing) {
        await api.offices.update(editing.id, { name: form.name, isActive: true, branchId: form.branchId || null });
        toast.success("Office updated");
      } else {
        await api.offices.create({ ...form, branchId: form.branchId || null });
        toast.success("Office created");
      }
      setFormOpen(false); load();
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };

  const handleDelete = async (o) => {
    if (!window.confirm(`Delete office ${o.code}? This cannot be undone.`)) return;
    try { await api.offices.remove(o.id); toast.success("Office deleted"); load(); }
    catch (e) { toast.error(e.message); }
  };

  const toggleActive = async (o) => {
    try { await api.offices.update(o.id, { name: o.name, isActive: !o.isActive }); load(); }
    catch (e) { toast.error(e.message); }
  };

  const setAsDefault = async (officeId) => {
    const next = defaultOffice === String(officeId) ? "" : String(officeId);
    try {
      await api.settings.update({ default_office_id: next });
      setDefaultOffice(next);
      toast.success(next ? "Default office updated" : "Default office cleared");
    } catch (e) { toast.error(e.message); }
  };

  const toggleAllowAll = async () => {
    setSavingGlobal(true);
    const next = !allowAll;
    try {
      await api.settings.update({ offices_allow_all: next ? "1" : "0" });
      setAllowAll(next);
      toast.success(next ? "Global office access enabled for all users" : "Global access revoked — individual assignments apply");
    } catch (e) { toast.error(e.message); } finally { setSavingGlobal(false); }
  };

  const grantAllUsersGlobal = async () => {
    if (!window.confirm("Grant all_offices = true to every active user? This gives all users global office access.")) return;
    setGrantingAll(true);
    try {
      const users = await api.users.list();
      await Promise.all(users.map(u => api.users.update(u.id, { allOffices: true })));
      toast.success(`Global access granted to ${users.length} user(s)`);
    } catch (e) { toast.error(e.message); } finally { setGrantingAll(false); }
  };

  const inp = { width: "100%", padding: "7px 10px", borderRadius: 7, border: `1px solid ${T.border}`,
    background: T.bg, fontFamily: T.body, fontSize: 13, color: T.text, outline: "none", boxSizing: "border-box" };

  return (
    <div>
      {/* Header + global toggle */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: T.head, fontSize: 16, fontWeight: 700, color: T.text }}>Branch Offices</div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 2 }}>
            Offices are assigned to users and stamped on shipments as EMO / IMO / Controlling Office.
          </div>
        </div>
        <button type="button" onClick={openNew}
          style={{ padding: "7px 16px", borderRadius: 8, border: "none", cursor: "pointer",
            background: T.accent, color: "#fff", fontFamily: T.body, fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
          ＋ New Office
        </button>
      </div>

      {/* Allow all orgs toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", borderRadius: 10, marginBottom: 20,
        background: allowAll ? T.accent + "12" : T.surface,
        border: `1px solid ${allowAll ? T.accent + "55" : T.border}` }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>
            Allow all orgs (global access)
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 2 }}>
            When enabled, all users can see shipments from every office — individual office assignments still apply for EMO/IMO defaults.
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: savingGlobal ? "wait" : "pointer",
          flexShrink: 0, marginLeft: 20 }}>
          <input type="checkbox" checked={allowAll} disabled={savingGlobal}
            onChange={toggleAllowAll} style={{ accentColor: T.accent, width: 16, height: 16 }} />
          <span style={{ fontFamily: T.body, fontSize: 13, color: allowAll ? T.accent : T.textMuted, fontWeight: 600 }}>
            {allowAll ? "Enabled" : "Disabled"}
          </span>
        </label>
      </div>

      {/* Bulk grant */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 16px", borderRadius: 10, marginBottom: 16,
        background: T.surface, border: `1px solid ${T.border}` }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>Bulk grant global access</div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 2 }}>
            Set all_offices = true for every active user at once — useful during initial setup.
          </div>
        </div>
        <button type="button" onClick={grantAllUsersGlobal} disabled={grantingAll}
          style={{ padding: "7px 16px", borderRadius: 8, border: `1px solid ${T.accent}44`,
            background: "none", cursor: grantingAll ? "wait" : "pointer", fontFamily: T.body, fontSize: 13,
            color: T.accent, fontWeight: 600, flexShrink: 0, marginLeft: 20 }}>
          {grantingAll ? "Granting…" : "Grant to all users"}
        </button>
      </div>

      {/* Create / edit form */}
      {formOpen && (
        <div style={{ background: T.surface, border: `1px solid ${T.accent}44`, borderRadius: 10,
          padding: "18px 20px", marginBottom: 20 }}>
          <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, marginBottom: 14, color: T.text }}>
            {editing ? `Edit: ${editing.code}` : "New Office"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "120px 120px 1fr 1fr", gap: 10, marginBottom: 4 }}>
            <div>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>UN/LOCODE <span style={{ color: T.danger }}>*</span></div>
              <input value={form.unlocode} disabled={!!editing}
                onChange={e => resolveLocode(e.target.value)}
                placeholder="e.g. NLRTM"
                style={{ ...inp, fontFamily: "monospace", opacity: editing ? 0.6 : 1 }} />
            </div>
            <div>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Department</div>
              <select value={form.department} disabled={!!editing}
                onChange={e => {
                  const dept = e.target.value;
                  setForm(p => ({ ...p, department: dept }));
                  if (form.unlocode.length >= 3)
                    setCodePreview(`${form.countryCode}-${form.unlocode}-${dept}`);
                }}
                style={{ ...inp, cursor: "pointer", opacity: editing ? 0.6 : 1 }}>
                <option value="SE">SE — Sea Export</option>
                <option value="SI">SI — Sea Import</option>
              </select>
            </div>
            <div>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>
                Office Name <span style={{ color: T.danger }}>*</span>{resolving && <span style={{ color: T.accent }}> resolving…</span>}
              </div>
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Rotterdam Sea Export" style={inp} />
            </div>
            <div>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Branch</div>
              <select value={form.branchId} onChange={e => setForm(p => ({ ...p, branchId: e.target.value }))}
                style={{ ...inp, cursor: "pointer" }}>
                <option value="">— None —</option>
                {branches.filter(b => b.isActive).map(b => (
                  <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
                ))}
              </select>
            </div>
          </div>
          {/* Code preview */}
          {!editing && codePreview && (
            <div style={{ marginBottom: 12, fontFamily: "monospace", fontSize: 12,
              color: T.accent, padding: "4px 8px", background: T.accent + "10",
              borderRadius: 5, display: "inline-block" }}>
              Code will be: <strong>{codePreview}</strong>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            <button type="button" onClick={() => setFormOpen(false)} disabled={saving}
              style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${T.border}`,
                background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={saving}
              style={{ padding: "6px 14px", borderRadius: 7, border: "none",
                background: T.accent, color: "#fff", cursor: "pointer", fontFamily: T.body, fontSize: 13, fontWeight: 600 }}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* Office list */}
      {loading ? (
        <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          Loading…
        </div>
      ) : offices.length === 0 ? (
        <div style={{ padding: "48px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          No offices configured yet. Create one above.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {offices.map(o => {
            const dc = DEPT_COLOR[o.department] || {};
            const isDefault = defaultOffice === String(o.id);
            const branch = o.branchId ? branches.find(b => b.id === o.branchId) : null;
            return (
              <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                background: T.surface,
                border: `1px solid ${isDefault ? T.accent + "66" : T.border}`,
                borderRadius: 10, opacity: o.isActive ? 1 : 0.55 }}>
                {/* Default checkbox */}
                <label title="Set as org default office" style={{ display: "flex", alignItems: "center",
                  cursor: "pointer", flexShrink: 0 }}>
                  <input type="checkbox" checked={isDefault} onChange={() => setAsDefault(o.id)}
                    style={{ accentColor: T.accent, width: 14, height: 14 }} />
                </label>
                <div style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700,
                  color: isDefault ? T.accent : T.text, minWidth: 160 }}>
                  {o.code}
                  {isDefault && (
                    <span style={{ marginLeft: 6, fontSize: 10, fontFamily: T.body, fontWeight: 700,
                      color: T.accent, background: T.accent + "18", borderRadius: 4, padding: "1px 5px" }}>
                      DEFAULT
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 4, padding: "2px 8px",
                  background: dc.bg || T.border + "20", color: dc.text || T.textMuted, flexShrink: 0 }}>
                  {DEPT_LABELS[o.department] || o.department}
                </span>
                {branch && (
                  <span style={{ fontSize: 11, fontFamily: "monospace", padding: "2px 7px", borderRadius: 4,
                    background: T.bg, border: `1px solid ${T.border}`, color: T.textMuted, flexShrink: 0 }}>
                    {branch.code}
                  </span>
                )}
                <div style={{ flex: 1, fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                  {o.name}
                </div>
                {!o.isActive && (
                  <span style={{ fontSize: 11, color: T.warning, background: T.warning + "18",
                    borderRadius: 4, padding: "2px 6px", fontWeight: 600, flexShrink: 0 }}>Inactive</span>
                )}
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button type="button" onClick={() => openEdit(o)}
                    style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                      background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.text }}>
                    Edit
                  </button>
                  <button type="button" onClick={() => toggleActive(o)}
                    style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                      background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12,
                      color: o.isActive ? T.warning : T.success }}>
                    {o.isActive ? "Deactivate" : "Activate"}
                  </button>
                  <button type="button" onClick={() => handleDelete(o)}
                    style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${T.danger}44`,
                      background: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12, color: T.danger }}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AppSettingsPage() {
  const { isAdmin } = useAuth();
  const tabs = isAdmin ? [...TABS_BASE, "Milestones", "Users", "Offices", "Activity Log"] : TABS_BASE;
  const [activeTab,      setActiveTab]      = useState("API Controls");
  const [activeApiSub,   setActiveApiSub]   = useState("External APIs");
  const [settings,       setSettings]       = useState(null);
  const [testResults,    setTestResults]    = useState({});
  const [testing,        setTesting]        = useState({});
  const [sanctionsInfo,  setSanctionsInfo]  = useState(null);
  const [syncing,        setSyncing]        = useState(false);
  const [contractSourceSaving, setContractSourceSaving] = useState(false);
  const [mdmSourceSaving, setMdmSourceSaving] = useState(false);
  const [screeningSourceSaving, setScreeningSourceSaving] = useState(false);
  const [kanbanSourceSaving, setKanbanSourceSaving] = useState(false);
  const [customerSourceSaving, setCustomerSourceSaving] = useState(false);
  const fileInputRef = useRef(null);
  const saveTimers   = useRef({});
  const [previewOpen, setPreviewOpen] = useState({});

  useEffect(() => {
    api.settings.get()
      .then(s => setSettings(s))
      .catch(() => toast.error("Failed to load settings"));
    api.sanctions.status()
      .then(s => setSanctionsInfo(s))
      .catch(() => {});
  }, []);

  const saveSetting = useCallback((key, value) => {
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => {
      api.settings.update({ [key]: value }).catch(() => toast.error("Failed to save"));
    }, 400);
  }, []);

  const toggle = (apiDef) => {
    if (!settings || !apiDef.settingKey) return;
    const key  = apiDef.settingKey;
    const next = settings[key] === 'false' ? 'true' : 'false';
    setSettings(s => ({ ...s, [key]: next }));
    clearTimeout(saveTimers.current[key]);
    api.settings.update({ [key]: next })
      .then(() => toast.success(`${apiDef.name} ${next === 'true' ? 'enabled' : 'disabled'}`))
      .catch(() => { setSettings(s => ({ ...s, [key]: next === 'true' ? 'false' : 'true' })); toast.error("Save failed"); });
  };

  const setRecurrence = (apiId, field, value) => {
    if (!settings) return;
    const key = `api_${apiId}_interval_${field}`;
    setSettings(s => ({ ...s, [key]: value }));
    saveSetting(key, value);
  };

  const runTest = async (apiDef) => {
    setTesting(t => ({ ...t, [apiDef.id]: true }));
    setTestResults(r => ({ ...r, [apiDef.id]: null }));
    const t0 = Date.now();
    try {
      if (apiDef.testType === "ws") {
        await new Promise(resolve => {
          const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
          const ws    = new WebSocket(`${proto}//${window.location.host}/ws`);
          const tmr   = setTimeout(() => { ws.close(); setTestResults(r => ({ ...r, [apiDef.id]: { ok: false, error: "Timeout (7 s)" } })); resolve(); }, 7000);
          ws.onopen  = () => { clearTimeout(tmr); ws.close(); setTestResults(r => ({ ...r, [apiDef.id]: { ok: true,  latency: Date.now() - t0 } })); resolve(); };
          ws.onerror = () => { clearTimeout(tmr);             setTestResults(r => ({ ...r, [apiDef.id]: { ok: false, error: "Connection refused" } })); resolve(); };
        });
      } else if (apiDef.testType === "status") {
        const info = await api.sanctions.status();
        setSanctionsInfo(info);
        setTestResults(r => ({ ...r, [apiDef.id]: {
          ok: true, latency: Date.now() - t0,
          label: info.entryCount > 0 ? `${info.entryCount.toLocaleString()} entries` : "No entries — sync required",
        }}));
      } else if (apiDef.testType === "ais_status") {
        const status = await api.ais.status();
        setTestResults(r => ({ ...r, [apiDef.id]: {
          ok: status.connected, latency: Date.now() - t0,
          label: status.connected
            ? `Connected · ${status.trackedVesselCount} vessel(s) tracked`
            : (status.lastError || "Not connected"),
        }}));
      } else {
        const ctrl    = new AbortController();
        const tmr     = setTimeout(() => ctrl.abort(), 7000);
        const token   = localStorage.getItem(TOKEN_KEY);
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const resp    = await fetch(apiDef.testUrl, { signal: ctrl.signal, headers });
        clearTimeout(tmr);
        setTestResults(r => ({ ...r, [apiDef.id]: { ok: resp.ok, latency: Date.now() - t0, status: resp.status } }));
      }
    } catch (e) {
      setTestResults(r => ({ ...r, [apiDef.id]: { ok: false, error: e.name === "AbortError" ? "Timeout (7 s)" : e.message } }));
    }
    setTesting(t => ({ ...t, [apiDef.id]: false }));
  };

  const testAll = async (apis) => {
    await Promise.all(apis.map(a => runTest(a)));
  };

  const handleCsvFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setSyncing(true);
    try {
      const csv = await file.text();
      const result = await api.sanctions.importCsv(csv);
      toast.success(`OFAC imported: ${result.entries.toLocaleString()} entries`);
      const info = await api.sanctions.status();
      setSanctionsInfo(info);
    } catch (err2) {
      toast.error(`Import failed: ${err2.message}`);
    }
    setSyncing(false);
  };

  const syncFromSource = async () => {
    setSyncing(true);
    try {
      const result = await api.sanctions.sync();
      toast.success(`OFAC synced: ${result.entries.toLocaleString()} entries`);
      const info = await api.sanctions.status();
      setSanctionsInfo(info);
    } catch (err2) {
      toast.error(`Sync failed: ${err2.message}`);
    }
    setSyncing(false);
  };

  const syncCslFromSource = async () => {
    setSyncing(true);
    try {
      const result = await api.sanctions.syncCsl();
      toast.success(`Consolidated Screening List synced: ${result.entries.toLocaleString()} entries`);
      const info = await api.sanctions.status();
      setSanctionsInfo(info);
    } catch (err2) {
      toast.error(`Sync failed: ${err2.message}`);
    }
    setSyncing(false);
  };

  if (!settings) {
    return <div style={{ padding: 40, color: T.textMuted, fontFamily: T.body }}>Loading settings…</div>;
  }

  const inp = {
    padding: "5px 9px", borderRadius: 6, border: `1px solid ${T.border}`,
    background: T.bg, color: T.text, fontFamily: T.mono, fontSize: 13, outline: "none",
  };

  // ── Subtab bar ──
  const SubTabBar = ({ tabs, active, onChange, extras }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
      borderBottom: `1px solid ${T.border}33`, marginBottom: 18 }}>
      <div style={{ display: "flex" }}>
        {tabs.map(tab => (
          <button key={tab} onClick={() => onChange(tab)} type="button"
            style={{
              padding: "6px 16px", border: "none", cursor: "pointer", background: "none",
              fontFamily: T.mono, fontSize: 11, fontWeight: tab === active ? 700 : 400,
              textTransform: "uppercase", letterSpacing: ".08em",
              color: tab === active ? T.accent : T.textMuted,
              borderBottom: `2px solid ${tab === active ? T.accent : "transparent"}`,
              marginBottom: -1,
            }}>
            {tab}
          </button>
        ))}
      </div>
      {extras}
    </div>
  );

  // ── eAdapter card — the whole per-carrier EDI-connectivity feature lives behind this one
  // toggle + gear icon, not the generic ExternalCard/EXTERNAL_APIS shape below (that assumes one
  // scalar API key; this needs N carrier sub-configs, hence the tabbed modal). Turning the
  // toggle off gates ALL carriers uniformly — see isEdiBookable() (server.js) — including the
  // built-in 3 (MAEU/SAFM/MCPU), which don't need a config row here to keep working today.
  const EadapterCard = () => {
    const [modalOpen, setModalOpen] = useState(false);
    const enabled = settings?.api_eadapter_enabled !== 'false';
    return (
      <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface,
        overflow: "hidden", opacity: enabled ? 1 : 0.65, transition: "opacity 0.2s" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "16px 20px 14px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 5 }}>
              <span style={{ fontFamily: T.body, fontSize: 15, fontWeight: 700, color: T.text }}>Carrier EDI Adapter (eAdapter)</span>
              {!enabled && (
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.warning,
                  background: `${T.warning}18`, border: `1px solid ${T.warning}44`,
                  borderRadius: 4, padding: "2px 8px" }}>DISABLED</span>
              )}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
              Real per-carrier EDI connectivity for carrier booking communication. MAEU/SAFM/MCPU
              work out of the box; add more carriers below.
            </div>
            {!enabled && (
              <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.warning, marginTop: 6, lineHeight: 1.5 }}>
                All carriers fall back to manual booking (no EDI messaging) while this is off.
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <button type="button" onClick={() => setModalOpen(true)} title="Configure carriers"
              style={{ width: 32, height: 32, borderRadius: 8, border: `1px solid ${T.border}`,
                background: T.bg, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <IconSettings size={15} color={T.textMuted} />
            </button>
            <Toggle on={enabled} onChange={() => toggle({ name: "eAdapter", settingKey: "api_eadapter_enabled" })} />
          </div>
        </div>
        {modalOpen && <EadapterConfigModal onClose={() => setModalOpen(false)} />}
      </div>
    );
  };

  // ── External API card ──
  const ExternalCard = ({ apiDef }) => {
    const enabled       = settings[`api_${apiDef.id}_enabled`] !== 'false';
    const intervalValue = settings[`api_${apiDef.id}_interval_value`] ?? apiDef.defaultValue ?? '1';
    const intervalUnit  = settings[`api_${apiDef.id}_interval_unit`]  ?? apiDef.defaultUnit  ?? 'days';
    const testResult    = testResults[apiDef.id];
    const isTesting     = testing[apiDef.id];
    const [showKey, setShowKey] = useState(false);

    // Shared by 'ofac' and 'csl' — each reads its own row out of sanctionsInfo.syncs (one row
    // per source, GET /api/sanctions/status already returns every sanctions_syncs row).
    let ofacNextDue = null, sanctionsSync = null;
    if ((apiDef.id === 'ofac' || apiDef.id === 'csl') && sanctionsInfo) {
      sanctionsSync = sanctionsInfo.syncs?.find(s => s.source === (apiDef.id === 'ofac' ? 'OFAC-SDN' : 'CSL')) || null;
      if (sanctionsSync?.synced_at) {
        const val   = Math.max(1, parseInt(intervalValue) || 1);
        const msMap = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
        ofacNextDue = new Date(new Date(sanctionsSync.synced_at).getTime() + val * (msMap[intervalUnit] || msMap.weeks));
      }
    }

    return (
      <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface,
        overflow: "hidden", opacity: enabled ? 1 : 0.65, transition: "opacity 0.2s" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "16px 20px 14px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 5 }}>
              <span style={{ fontFamily: T.body, fontSize: 15, fontWeight: 700, color: T.text }}>{apiDef.name}</span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
                background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, padding: "2px 8px" }}>
                {apiDef.provider}
              </span>
              {!enabled && (
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.warning,
                  background: `${T.warning}18`, border: `1px solid ${T.warning}44`,
                  borderRadius: 4, padding: "2px 8px" }}>DISABLED</span>
              )}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
              {apiDef.description}
            </div>
          </div>
          <Toggle on={enabled} onChange={() => toggle({ ...apiDef, settingKey: `api_${apiDef.id}_enabled` })} />
        </div>

        {/* API key input */}
        {apiDef.hasApiKey && (
          <div style={{ padding: "12px 20px", borderTop: `1px solid ${T.border}22`, background: `${T.bg}88` }}>
            <div style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>Consumer Key</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type={showKey ? "text" : "password"}
                value={settings[apiDef.settingKey] || ""}
                placeholder="Paste API key…"
                onChange={e => {
                  const v = e.target.value;
                  setSettings(s => ({ ...s, [apiDef.settingKey]: v }));
                  saveSetting(apiDef.settingKey, v);
                }}
                disabled={!enabled}
                style={{ ...inp, flex: 1 }}
              />
              <button type="button" onClick={() => setShowKey(x => !x)}
                style={{ ...inp, width: 64, cursor: "pointer", flexShrink: 0, textAlign: "center" }}>
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
            {settings[apiDef.settingKey] ? (
              <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.success, marginTop: 5 }}>
                ● Key configured
              </div>
            ) : (
              <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, marginTop: 5 }}>
                {apiDef.keyHelpText || "Register free to get a Consumer Key."}
              </div>
            )}
          </div>
        )}

        {/* Recurrence */}
        {apiDef.hasRecurrence && (
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10,
            padding: "12px 20px", borderTop: `1px solid ${T.border}22`, background: `${T.bg}88` }}>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{apiDef.recurrenceLabel}</span>
            <input type="number" min={1} max={365} value={intervalValue}
              onChange={e => setRecurrence(apiDef.id, 'value', e.target.value)}
              disabled={!enabled} style={{ ...inp, width: 58 }} />
            <select value={intervalUnit}
              onChange={e => setRecurrence(apiDef.id, 'unit', e.target.value)}
              disabled={!enabled}
              style={{ ...inp, paddingRight: 14, cursor: enabled ? "pointer" : "default" }}>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </select>
            {apiDef.id === 'ofac' && sanctionsInfo && (
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginLeft: 4 }}>
                {sanctionsSync ? `${(sanctionsInfo.ofacEntryCount || 0).toLocaleString()} entries` : "Not yet synced"}
                {sanctionsSync?.synced_at && <> · Last {new Date(sanctionsSync.synced_at).toLocaleDateString()}</>}
                {ofacNextDue && <> · Next {ofacNextDue < new Date() ? "overdue" : ofacNextDue.toLocaleDateString()}</>}
              </span>
            )}
            {apiDef.id === 'csl' && sanctionsInfo && (
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginLeft: 4 }}>
                {sanctionsSync ? `${(sanctionsInfo.cslEntryCount || 0).toLocaleString()} entries across 11 lists` : "Not yet synced"}
                {sanctionsSync?.synced_at && <> · Last {new Date(sanctionsSync.synced_at).toLocaleDateString()}</>}
                {ofacNextDue && <> · Next {ofacNextDue < new Date() ? "overdue" : ofacNextDue.toLocaleDateString()}</>}
              </span>
            )}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 10,
          padding: "10px 20px 14px", borderTop: `1px solid ${T.border}22` }}>
          <button onClick={() => runTest(apiDef)} disabled={isTesting} type="button"
            style={{ padding: "5px 13px", borderRadius: 6, border: `1px solid ${T.accent}55`,
              background: T.accentBg, color: T.accent, fontFamily: T.mono, fontSize: 12,
              cursor: isTesting ? "wait" : "pointer", opacity: isTesting ? 0.65 : 1 }}>
            {isTesting ? "Testing…" : "▶ Test"}
          </button>
          {apiDef.id === 'ofac' && enabled && (
            <>
              <input ref={fileInputRef} type="file" accept=".csv,text/csv"
                onChange={handleCsvFile} style={{ display: "none" }} />
              <button onClick={() => fileInputRef.current?.click()} disabled={syncing} type="button"
                style={{ padding: "5px 13px", borderRadius: 6, border: `1px solid ${T.border}`,
                  background: T.bg, color: T.text, fontFamily: T.mono, fontSize: 12,
                  cursor: syncing ? "wait" : "pointer", opacity: syncing ? 0.65 : 1 }}>
                {syncing ? "Working…" : "⤒ Import sdn.csv"}
              </button>
              <button onClick={syncFromSource} disabled={syncing} type="button"
                style={{ padding: "5px 13px", borderRadius: 6, border: `1px solid ${T.border}`,
                  background: T.bg, color: T.text, fontFamily: T.mono, fontSize: 12,
                  cursor: syncing ? "wait" : "pointer", opacity: syncing ? 0.65 : 1 }}>
                {syncing ? "Working…" : "↻ Sync from source"}
              </button>
            </>
          )}
          {apiDef.id === 'csl' && enabled && (
            <button onClick={syncCslFromSource} disabled={syncing} type="button"
              style={{ padding: "5px 13px", borderRadius: 6, border: `1px solid ${T.border}`,
                background: T.bg, color: T.text, fontFamily: T.mono, fontSize: 12,
                cursor: syncing ? "wait" : "pointer", opacity: syncing ? 0.65 : 1 }}>
              {syncing ? "Working…" : "↻ Sync from source"}
            </button>
          )}
          <StatusDot result={testResult} testing={isTesting} />
        </div>
      </div>
    );
  };

  // ── Internal API card ──
  const InternalCard = ({ apiDef }) => {
    const enabled    = !apiDef.hasToggle || settings[apiDef.settingKey] !== 'false';
    const testResult = testResults[apiDef.id];
    const isTesting  = testing[apiDef.id];

    return (
      <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface,
        overflow: "hidden", opacity: enabled ? 1 : 0.65, transition: "opacity 0.2s" }}>

        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 20px" }}>
          {/* Status / test result dot */}
          <div style={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
            background: !testResult ? T.border : testResult.ok ? T.success : T.danger,
            boxShadow: testResult?.ok ? `0 0 6px ${T.success}77` : testResult && !testResult.ok ? `0 0 6px ${T.danger}77` : "none",
            transition: "background .3s",
          }} />

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
              <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text }}>{apiDef.name}</span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
                background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 7px" }}>
                {apiDef.provider}
              </span>
              {apiDef.hasToggle && !enabled && (
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.warning,
                  background: `${T.warning}18`, border: `1px solid ${T.warning}44`,
                  borderRadius: 4, padding: "1px 7px" }}>DISABLED</span>
              )}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{apiDef.description}</div>
          </div>

          {/* Latency badge (once tested) */}
          {testResult && (
            <span style={{ fontFamily: T.mono, fontSize: 11, flexShrink: 0,
              color: testResult.ok ? T.success : T.danger }}>
              {testResult.ok
                ? (testResult.label ?? `${testResult.latency} ms`)
                : (testResult.error ?? `HTTP ${testResult.status}`)}
            </span>
          )}
          {isTesting && (
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, flexShrink: 0 }}>Testing…</span>
          )}

          {/* Test button */}
          <button onClick={() => runTest(apiDef)} disabled={isTesting} type="button"
            style={{ padding: "4px 11px", borderRadius: 6, border: `1px solid ${T.accent}55`,
              background: T.accentBg, color: T.accent, fontFamily: T.mono, fontSize: 11,
              cursor: isTesting ? "wait" : "pointer", opacity: isTesting ? 0.65 : 1, flexShrink: 0 }}>
            ▶ Test
          </button>

          {/* Toggle (only for configurable internal services like WebSocket) */}
          {apiDef.hasToggle && (
            <Toggle on={enabled} onChange={() => toggle(apiDef)} />
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 780 }}>

      {/* Main tab bar */}
      <div style={{ display: "flex", borderBottom: `2px solid ${T.border}`, marginBottom: 24 }}>
        {tabs.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} type="button"
            style={{
              padding: "9px 20px", border: "none", cursor: "pointer", background: "none",
              fontFamily: T.body, fontSize: 14, fontWeight: tab === activeTab ? 700 : 400,
              color: tab === activeTab ? T.accent : T.textMuted,
              borderBottom: `2px solid ${tab === activeTab ? T.accent : "transparent"}`,
              marginBottom: -2,
            }}>
            {tab}
          </button>
        ))}
      </div>

      {/* API Controls */}
      {activeTab === "Finance" && settings && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 600 }}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
            padding: "18px 22px", display: "flex", alignItems: "flex-start",
            justifyContent: "space-between", gap: 20 }}>
            <div>
              <div style={{ fontFamily: T.body, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 4 }}>
                Finance View
              </div>
              <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
                Show margin percentages, gross profit and cost breakdown on shipments, the shipment list,
                and the Dashboard Margin tab. Disable to hide all financial figures from non-finance users.
              </div>
              <div style={{ marginTop: 8, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                Setting key: <span style={{ color: T.accent }}>finance_view_enabled</span>
              </div>
            </div>
            <Toggle
              on={settings.finance_view_enabled !== 'false'}
              onChange={() => {
                const next = settings.finance_view_enabled === 'false' ? 'true' : 'false';
                setSettings(s => ({ ...s, finance_view_enabled: next }));
                api.settings.update({ finance_view_enabled: next })
                  .then(() => toast.success(`Finance view ${next === 'true' ? 'enabled' : 'disabled'}`))
                  .catch(() => toast.error("Failed to save setting"));
              }}
            />
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, padding: "0 4px", lineHeight: 1.6 }}>
            💡 TKT-6H68IQ — A future improvement will add user-role-based gating so individual accounts
            can have finance access independently of this global toggle.
          </div>

          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
            padding: "18px 22px", display: "flex", alignItems: "flex-start",
            justifyContent: "space-between", gap: 20 }}>
            <div>
              <div style={{ fontFamily: T.body, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 4 }}>
                Reports — GP Target
              </div>
              <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
                A region/country/carrier below this gross-margin percentage is flagged and sorted to
                the top of the Reports list. One flat target for now, not per-lane — leave blank to
                disable flagging and keep the default sell-volume ordering.
              </div>
              <div style={{ marginTop: 8, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                Setting key: <span style={{ color: T.accent }}>gp_target_pct</span>
              </div>
            </div>
            <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="number" min="0" max="100" step="0.5"
                value={settings.gp_target_pct ?? ''}
                placeholder="Off"
                onChange={e => {
                  const v = e.target.value;
                  setSettings(s => ({ ...s, gp_target_pct: v }));
                  saveSetting('gp_target_pct', v);
                }}
                style={{ width: 80, padding: "7px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                  background: T.bg, color: T.text, fontFamily: T.mono, fontSize: 13, textAlign: "right" }}
              />
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>%</span>
            </div>
          </div>
        </div>
      )}

      {activeTab === "Compliance" && settings && (
        <DgComplianceSettingsPanel settings={settings} onChange={(k, v) => {
          setSettings(s => ({ ...s, [k]: v }));
          saveSetting(k, v);
        }} />
      )}

      {activeTab === "API Controls" && (
        <>
          {/* Subtab bar */}
          <SubTabBar
            tabs={API_SUBTABS}
            active={activeApiSub}
            onChange={setActiveApiSub}
            extras={
              activeApiSub === "Internal APIs" && (
                <button onClick={() => testAll(INTERNAL_APIS)} type="button"
                  style={{ padding: "4px 12px", borderRadius: 6, border: `1px solid ${T.border}`,
                    background: T.bg, color: T.textMuted, fontFamily: T.mono, fontSize: 11,
                    cursor: "pointer", marginBottom: 2 }}>
                  ▶ Test all
                </button>
              )
            }
          />

          {activeApiSub === "External APIs" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <EadapterCard />
              {settings && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
                  padding: "14px 16px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                    fontFamily: T.body, fontSize: 13, color: T.text }}>
                    <input type="checkbox"
                      checked={settings.demo_schedules_enabled !== 'false'}
                      onChange={e => {
                        const v = e.target.checked ? 'true' : 'false';
                        setSettings(s => ({ ...s, demo_schedules_enabled: v }));
                        saveSetting('demo_schedules_enabled', v);
                      }} />
                    Fall back to demo sailing schedules when a search finds no stored or live match
                  </label>
                  <p style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, margin: "8px 0 0 26px", lineHeight: 1.5 }}>
                    Add Sailing checks the schedule catalog (Test Tools → Schedule Generator) and
                    any live carrier API first. With this off, a search with no real match returns
                    empty instead of synthetic "DEMO …" placeholders.
                  </p>
                </div>
              )}
              {settings && isAdmin && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
                  padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>
                      Contract data source
                    </div>
                    <select
                      value={settings.contract_source || 'local'}
                      disabled={contractSourceSaving}
                      onChange={e => {
                        const v = e.target.value;
                        const prev = settings.contract_source || 'local';
                        if (v === prev) return;
                        setContractSourceSaving(true);
                        api.settings.updateContractSource(v)
                          .then(() => {
                            setSettings(s => ({ ...s, contract_source: v }));
                            toast.success(`Contract data source switched to ${v === 'remote' ? 'Contract Management Service' : 'Local (this app)'}`);
                          })
                          .catch(() => toast.error("Failed to switch contract data source"))
                          .finally(() => setContractSourceSaving(false));
                      }}
                      style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                        background: T.bg, color: T.text, fontFamily: T.mono, fontSize: 12, cursor: contractSourceSaving ? "wait" : "pointer" }}>
                      <option value="local">Local (this app)</option>
                      <option value="remote">Remote (Contract Management Service)</option>
                    </select>
                  </div>
                  <p style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, margin: "8px 0 0 0", lineHeight: 1.5 }}>
                    Where every contract/rate/routing read and write goes — the standalone Contract
                    Management Service, or this app's own local tables (today's behavior, and the
                    default). This is a one-way cutover lever, not a live sync: switching back does
                    not pull remote changes back, and existing local contracts are never copied
                    automatically — run the migration script first if switching to Remote.
                  </p>
                </div>
              )}
              {settings && isAdmin && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
                  padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>
                      MDM data source
                    </div>
                    <select
                      value={settings.mdm_source || 'local'}
                      disabled={mdmSourceSaving}
                      onChange={e => {
                        const v = e.target.value;
                        const prev = settings.mdm_source || 'local';
                        if (v === prev) return;
                        setMdmSourceSaving(true);
                        api.settings.updateMdmSource(v)
                          .then(() => {
                            setSettings(s => ({ ...s, mdm_source: v }));
                            toast.success(`MDM data source switched to ${v === 'remote' ? 'MDM Service' : 'Local (this app)'}`);
                          })
                          .catch(() => toast.error("Failed to switch MDM data source"))
                          .finally(() => setMdmSourceSaving(false));
                      }}
                      style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                        background: T.bg, color: T.text, fontFamily: T.mono, fontSize: 12, cursor: mdmSourceSaving ? "wait" : "pointer" }}>
                      <option value="local">Local (this app)</option>
                      <option value="remote">Remote (MDM Service)</option>
                    </select>
                  </div>
                  <p style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, margin: "8px 0 0 0", lineHeight: 1.5 }}>
                    Where carriers/vessels/ports/linked ports/trade lanes/regions/countries/
                    commodities/carrier agents are read from and written to — the standalone MDM
                    Service, or this app's own local tables (today's behavior, and the default).
                    Same one-way cutover lever as Contract data source above: switching back does
                    not pull remote changes back, and existing local MDM data is never copied
                    automatically — run the migration script first if switching to Remote.
                  </p>
                </div>
              )}
              {settings && isAdmin && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
                  padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>
                      Screening data source
                    </div>
                    <select
                      value={settings.screening_source || 'local'}
                      disabled={screeningSourceSaving}
                      onChange={e => {
                        const v = e.target.value;
                        const prev = settings.screening_source || 'local';
                        if (v === prev) return;
                        setScreeningSourceSaving(true);
                        api.settings.updateScreeningSource(v)
                          .then(() => {
                            setSettings(s => ({ ...s, screening_source: v }));
                            toast.success(`Screening data source switched to ${v === 'remote' ? 'Screening Service' : 'Local (this app)'}`);
                          })
                          .catch(() => toast.error("Failed to switch screening data source"))
                          .finally(() => setScreeningSourceSaving(false));
                      }}
                      style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                        background: T.bg, color: T.text, fontFamily: T.mono, fontSize: 12, cursor: screeningSourceSaving ? "wait" : "pointer" }}>
                      <option value="local">Local (this app)</option>
                      <option value="remote">Remote (Screening Service)</option>
                    </select>
                  </div>
                  <p style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, margin: "8px 0 0 0", lineHeight: 1.5 }}>
                    Where sanctions_entries/sanctions_syncs (OFAC SDN + the Consolidated Screening
                    List) are read from and written to, and which side owns the auto-sync
                    schedule — the standalone Screening Service, or this app's own local tables
                    (today's behavior, and the default). Same one-way cutover lever as the two
                    sources above: switching back does not pull remote changes back, and existing
                    local sanctions data is never copied automatically — run the migration script
                    first if switching to Remote. Sync Now/Sync CSL Now above always target
                    whichever side is currently active.
                  </p>
                </div>
              )}
              {settings && isAdmin && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
                  padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>
                      Kanban/Testing data source
                    </div>
                    <select
                      value={settings.kanban_source || 'local'}
                      disabled={kanbanSourceSaving}
                      onChange={e => {
                        const v = e.target.value;
                        const prev = settings.kanban_source || 'local';
                        if (v === prev) return;
                        setKanbanSourceSaving(true);
                        api.settings.updateKanbanSource(v)
                          .then(() => {
                            setSettings(s => ({ ...s, kanban_source: v }));
                            toast.success(`Kanban/Testing data source switched to ${v === 'remote' ? 'Kanban Service' : 'Local (this app)'}`);
                          })
                          .catch(() => toast.error("Failed to switch Kanban/Testing data source"))
                          .finally(() => setKanbanSourceSaving(false));
                      }}
                      style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                        background: T.bg, color: T.text, fontFamily: T.mono, fontSize: 12, cursor: kanbanSourceSaving ? "wait" : "pointer" }}>
                      <option value="local">Local (this app)</option>
                      <option value="remote">Remote (Kanban Service)</option>
                    </select>
                  </div>
                  <p style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, margin: "8px 0 0 0", lineHeight: 1.5 }}>
                    Where tickets/ticket links/test cases/story links/board projects, versions,
                    and columns are read from and written to — the standalone Kanban/Testing
                    Service, or this app's own local tables (today's behavior, and the default).
                    Same one-way cutover lever as the three sources above: switching back does not
                    pull remote changes back, and existing local board data is never copied
                    automatically — run the migration script first if switching to Remote.
                  </p>
                </div>
              )}
              {settings && isAdmin && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
                  padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>
                      Customer data source
                    </div>
                    <select
                      value={settings.customer_source || 'local'}
                      disabled={customerSourceSaving}
                      onChange={e => {
                        const v = e.target.value;
                        const prev = settings.customer_source || 'local';
                        if (v === prev) return;
                        setCustomerSourceSaving(true);
                        api.settings.updateCustomerSource(v)
                          .then(() => {
                            setSettings(s => ({ ...s, customer_source: v }));
                            toast.success(`Customer data source switched to ${v === 'remote' ? 'Customer Service' : 'Local (this app)'}`);
                          })
                          .catch(() => toast.error("Failed to switch customer data source"))
                          .finally(() => setCustomerSourceSaving(false));
                      }}
                      style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                        background: T.bg, color: T.text, fontFamily: T.mono, fontSize: 12, cursor: customerSourceSaving ? "wait" : "pointer" }}>
                      <option value="local">Local (this app)</option>
                      <option value="remote">Remote (Customer Service)</option>
                    </select>
                  </div>
                  <p style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, margin: "8px 0 0 0", lineHeight: 1.5 }}>
                    Where customers/identifiers/screening records/contacts are read from and
                    written to — the standalone Customer Service, or this app's own local tables
                    (today's behavior, and the default). Uploaded customer documents always stay
                    local regardless of this setting. Same one-way cutover lever as the four
                    sources above: switching back does not pull remote changes back, and existing
                    local customer data is never copied automatically — run the migration script
                    first if switching to Remote.
                  </p>
                </div>
              )}
              {EXTERNAL_APIS.map(a => <ExternalCard key={a.id} apiDef={a} />)}
            </div>
          )}

          {activeApiSub === "Internal APIs" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {INTERNAL_APIS.map(a => <InternalCard key={a.id} apiDef={a} />)}
            </div>
          )}

          {activeApiSub === "Security" && settings && (
            <SecuritySettingsPanel settings={settings} onChange={(k, v) => {
              setSettings(s => ({ ...s, [k]: v }));
              saveSetting(k, v);
            }} />
          )}

          {activeApiSub === "Single Sign-On" && settings && (
            <SsoSettingsPanel settings={settings} onChange={(k, v) => {
              setSettings(s => ({ ...s, [k]: v }));
              saveSetting(k, v);
            }} />
          )}

          {activeApiSub === "System Email" && <SystemEmailSettingsPanel />}

          {activeApiSub === "AI Agent" && settings && (
            <AiAgentSettingsPanel settings={settings} onChange={(k, v) => {
              setSettings(s => ({ ...s, [k]: v }));
              saveSetting(k, v);
            }} />
          )}

        </>
      )}

      {activeTab === "Developer" && (() => {
        const devDocs = [
          {
            id: "arch",
            title: "System Architecture",
            filename: "src/dev/architecture.html",
            badge: "ARCHITECTURE",
            badgeColor: T.accent,
            description: "Interactive layer diagram covering all 4 service layers — External Services, React 18 frontend, Express backend (120+ routes), and SQLite data layer (35 tables). Includes auth/RBAC, multimodal leg engine, and portLanesMap. Current as of v0.22.0 “Crossroads”.",
            html: archHtml,
          },
          {
            id: "epic",
            title: "Epic Coverage — TKT-D7AUBQ",
            filename: "src/dev/epic-TKT-D7AUBQ-coverage.html",
            badge: "EPIC REVIEW",
            badgeColor: T.warning,
            description: "Coverage analysis for the Shipment Entry form & data model epic. Tracks 11 story items across 3 phases — 8 done, 1 partial, 2 outstanding — plus bonus work shipped in v0.20.0, v0.21.0, and v0.22.0 beyond original scope.",
            html: epicHtml,
          },
        ];

        const openHtml = (html, title) => {
          const blob = new Blob([html], { type: "text/html" });
          const url  = URL.createObjectURL(blob);
          window.open(url, "_blank");
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        };

        const collFolders  = postmanCollection.item?.length ?? 0;
        const collRequests = postmanCollection.item?.reduce((s, f) => s + (f.item?.length ?? 0), 0) ?? 0;
        const collBytes    = JSON.stringify(postmanCollection).length;
        const envBytes     = JSON.stringify(postmanEnvironment).length;
        const fmtKb = n => `${(n / 1024).toFixed(1)} KB`;

        const fileCard = ({ badge, badgeColor, filename, description, meta, onDownload }) => (
          <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "16px 20px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{filename}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: ".06em",
                    color: badgeColor, background: `${badgeColor}18`,
                    border: `1px solid ${badgeColor}40`, borderRadius: 4, padding: "2px 7px" }}>
                    {badge}
                  </span>
                </div>
                <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.6, margin: "0 0 8px", maxWidth: 520 }}>
                  {description}
                </p>
                <div style={{ display: "flex", gap: 14 }}>
                  {meta.map(([label, value]) => (
                    <span key={label} style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                      <span style={{ color: T.text }}>{value}</span> {label}
                    </span>
                  ))}
                </div>
              </div>
              <button onClick={onDownload} type="button"
                style={{ flexShrink: 0, marginLeft: 24, padding: "7px 16px", borderRadius: 7,
                  border: `1px solid ${T.accent}55`, background: T.accentBg, color: T.accent,
                  fontFamily: T.mono, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
                ↓ Download
              </button>
            </div>
          </div>
        );

        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>

            {/* ── Developer Documents ── */}
            <div>
              <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>Developer Documents</div>
              <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.6, margin: "0 0 14px" }}>
                Architecture reference and epic coverage reports stored in <code style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, background: `${T.accent}12`, borderRadius: 3, padding: "1px 5px" }}>src/dev/</code>.
                Click <strong style={{ color: T.text }}>Preview</strong> for an inline view, or <strong style={{ color: T.text }}>Open</strong> to launch full-page.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {devDocs.map(doc => (
                  <div key={doc.id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface, overflow: "hidden" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "16px 20px" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6 }}>
                          <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 700, color: T.text }}>{doc.title}</span>
                          <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: ".06em",
                            color: doc.badgeColor, background: `${doc.badgeColor}18`,
                            border: `1px solid ${doc.badgeColor}40`, borderRadius: 4, padding: "2px 7px" }}>
                            {doc.badge}
                          </span>
                        </div>
                        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.6, margin: "0 0 8px", maxWidth: 510 }}>
                          {doc.description}
                        </p>
                        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{doc.filename}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexShrink: 0, marginLeft: 24, alignItems: "flex-start" }}>
                        <button
                          onClick={() => setPreviewOpen(p => ({ ...p, [doc.id]: !p[doc.id] }))}
                          type="button"
                          style={{ padding: "6px 13px", borderRadius: 7,
                            border: `1px solid ${previewOpen[doc.id] ? T.accent + "55" : T.border}`,
                            background: previewOpen[doc.id] ? T.accentBg : T.bg,
                            color: previewOpen[doc.id] ? T.accent : T.textMuted,
                            fontFamily: T.mono, fontSize: 12, cursor: "pointer" }}>
                          {previewOpen[doc.id] ? "▲ Hide" : "▼ Preview"}
                        </button>
                        <button onClick={() => openHtml(doc.html, doc.title)} type="button"
                          style={{ padding: "6px 13px", borderRadius: 7,
                            border: `1px solid ${T.accent}55`, background: T.accentBg, color: T.accent,
                            fontFamily: T.mono, fontSize: 12, cursor: "pointer" }}>
                          ↗ Open
                        </button>
                      </div>
                    </div>
                    {previewOpen[doc.id] && (
                      <div style={{ borderTop: `1px solid ${T.border}`, height: 400, overflow: "hidden" }}>
                        <iframe
                          srcDoc={doc.html}
                          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
                          sandbox="allow-scripts"
                          title={doc.title}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* ── Divider ── */}
            <div style={{ height: 1, background: T.border }} />

            {/* ── API Development ── */}
            <div>
              <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>API Development</div>
              <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.6, margin: "0 0 14px" }}>
                Postman files for exploring and testing the CargoDesk REST API locally.
                Import both files into Postman, select the <strong style={{ color: T.text }}>CargoDesk Local</strong> environment,
                and authenticate via <code style={{ fontFamily: T.mono, fontSize: 11, color: T.success, background: `${T.success}12`, borderRadius: 3, padding: "1px 5px" }}>POST /api/auth/login</code> to get a Bearer token.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {fileCard({
                  badge:       "COLLECTION",
                  badgeColor:  T.accent,
                  filename:    "CargoDesk.postman_collection.json",
                  description: `Full REST API collection covering every endpoint in CargoDesk. Organised into ${collFolders} resource folders — Shipments, Containers, Contracts, Allocations, Carriers, Vessels, Ports, Customers, Sanctions, Kanban, Margin, and more. Each folder includes example request bodies with realistic placeholder values.`,
                  meta:        [["folders", collFolders], ["requests", collRequests], ["size", fmtKb(collBytes)]],
                  onDownload:  () => downloadJson(postmanCollection, "CargoDesk.postman_collection.json"),
                })}

                {fileCard({
                  badge:       "ENVIRONMENT",
                  badgeColor:  T.success,
                  filename:    "CargoDesk.postman_environment.json",
                  description: "Environment file pre-configured with the {{baseUrl}} variable pointing to the local Express server. Import alongside the collection and set it as the active environment. Change baseUrl to point at a remote instance if needed.",
                  meta:        [["variable", "baseUrl"], ["default", "localhost:3001"], ["size", fmtKb(envBytes)]],
                  onDownload:  () => downloadJson(postmanEnvironment, "CargoDesk.postman_environment.json"),
                })}

                <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
                  padding: "14px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, letterSpacing: ".09em",
                    textTransform: "uppercase", color: T.textMuted }}>Authentication</span>
                  <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.6, margin: 0 }}>
                    All endpoints except <code style={{ fontFamily: T.mono, fontSize: 11, color: T.success, background: `${T.success}12`, borderRadius: 3, padding: "1px 5px" }}>POST /api/auth/login</code> and <code style={{ fontFamily: T.mono, fontSize: 11, color: T.success, background: `${T.success}12`, borderRadius: 3, padding: "1px 5px" }}>GET /api/health</code> require a Bearer token.
                    Add a <strong style={{ color: T.text }}>Collection-level Authorization</strong> header in Postman (Type: Bearer Token) and paste the token returned by the login call.
                    Default dev credentials:{" "}
                    <code style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, background: `${T.accent}12`, borderRadius: 3, padding: "1px 5px" }}>admin@cargodesk.com</code>
                    {" / "}
                    <code style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, background: `${T.accent}12`, borderRadius: 3, padding: "1px 5px" }}>admin123</code>
                  </p>
                </div>
              </div>
            </div>

          </div>
        );
      })()}

      {activeTab === "Milestones" && isAdmin && (
        <MilestoneTemplatesPanel />
      )}

      {activeTab === "Users" && isAdmin && (
        <UserManagementPanel />
      )}

      {activeTab === "Offices" && isAdmin && (
        <OfficesPanel />
      )}

      {activeTab === "Activity Log" && isAdmin && (
        <AdminActivityLog />
      )}
    </div>
  );
}
