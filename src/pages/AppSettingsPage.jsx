import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../tokens";
import { api, TOKEN_KEY } from "../api";
import postmanCollection  from "../dev/CargoDesk.postman_collection.json";
import postmanEnvironment from "../dev/CargoDesk.postman_environment.json";
import archHtml           from "../dev/architecture.html?raw";
import epicHtml           from "../dev/epic-TKT-D7AUBQ-coverage.html?raw";
import { toast } from "../toast";
import { useAuth } from "../AuthContext";
import UserManagementPanel from "../components/UserManagementPanel";

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
    id: "maersk",
    name: "Maersk Schedules",
    provider: "Maersk Line",
    description: "Live point-to-point sailing schedules from Maersk's developer API. Active when searching MAEU, SAFM, or MCPU carriers in Schedule Search.",
    testType: "maersk_schedule",
    hasApiKey: true,
    settingKey: "maersk_api_key",
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

const TABS_BASE   = ["API Controls", "Finance", "Developer"];
const API_SUBTABS = ["External APIs", "Internal APIs", "Security", "Single Sign-On", "AI Agent"];

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
  const [page,    setPage]    = useState(0);
  const [filter,  setFilter]  = useState("");
  const PAGE_SIZE = 50;

  const load = useCallback((p = 0, f = "") => {
    setLoading(true);
    const params = { limit: PAGE_SIZE, offset: p * PAGE_SIZE };
    if (f) params.action = f;
    api.adminEvents.list(params)
      .then(({ results, total }) => { setEvents(results); setTotal(total); })
      .catch(() => toast.error("Failed to load activity log"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(0, filter); setPage(0); }, [filter, load]);

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
          <button onClick={() => load(page, filter)} type="button"
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

      {total > PAGE_SIZE && (
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 16 }}>
          <button disabled={page === 0} onClick={() => { const p = page - 1; setPage(p); load(p, filter); }}
            style={{ ...inp(), width: 80, cursor: "pointer" }}>← Prev</button>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, padding: "5px 0" }}>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <button disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => { const p = page + 1; setPage(p); load(p, filter); }}
            style={{ ...inp(), width: 80, cursor: "pointer" }}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ─── AI Agent Settings Panel ──────────────────────────────────────────────────

function AiAgentSettingsPanel({ settings, onChange }) {
  const [showKey,    setShowKey]    = useState(false);
  const [testing,   setTesting]   = useState(false);
  const [testResult, setTestResult] = useState(null);
  const s = settings;

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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AppSettingsPage() {
  const { isAdmin } = useAuth();
  const tabs = isAdmin ? [...TABS_BASE, "Milestones", "Users", "Activity Log"] : TABS_BASE;
  const [activeTab,      setActiveTab]      = useState("API Controls");
  const [activeApiSub,   setActiveApiSub]   = useState("External APIs");
  const [settings,       setSettings]       = useState(null);
  const [testResults,    setTestResults]    = useState({});
  const [testing,        setTesting]        = useState({});
  const [sanctionsInfo,  setSanctionsInfo]  = useState(null);
  const [syncing,        setSyncing]        = useState(false);
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
      } else if (apiDef.testType === "maersk_schedule") {
        const ctrl  = new AbortController();
        const tmr   = setTimeout(() => ctrl.abort(), 10000);
        const token = localStorage.getItem(TOKEN_KEY);
        const resp  = await fetch("/api/schedules/search?pol=NLRTM&pod=USNYC&carrierCode=MAEU&weeks=1", {
          signal: ctrl.signal, headers: { Authorization: `Bearer ${token}` },
        });
        clearTimeout(tmr);
        if (resp.ok) {
          const data = await resp.json();
          setTestResults(r => ({ ...r, [apiDef.id]: {
            ok: !data.isMock,
            latency: Date.now() - t0,
            ...(data.isMock
              ? { error: "No key — demo data only" }
              : { label: `Live · ${data.sailings?.length ?? 0} sailing${(data.sailings?.length ?? 0) !== 1 ? "s" : ""} NLRTM→USNYC` }
            ),
          }}));
        } else {
          setTestResults(r => ({ ...r, [apiDef.id]: { ok: false, error: `HTTP ${resp.status}` } }));
        }
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

  // ── External API card ──
  const ExternalCard = ({ apiDef }) => {
    const enabled       = settings[`api_${apiDef.id}_enabled`] !== 'false';
    const intervalValue = settings[`api_${apiDef.id}_interval_value`] ?? apiDef.defaultValue ?? '1';
    const intervalUnit  = settings[`api_${apiDef.id}_interval_unit`]  ?? apiDef.defaultUnit  ?? 'days';
    const testResult    = testResults[apiDef.id];
    const isTesting     = testing[apiDef.id];
    const [showKey, setShowKey] = useState(false);

    let ofacNextDue = null;
    if (apiDef.id === 'ofac' && sanctionsInfo?.syncs?.[0]?.synced_at) {
      const val   = Math.max(1, parseInt(intervalValue) || 1);
      const msMap = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
      ofacNextDue = new Date(new Date(sanctionsInfo.syncs[0].synced_at).getTime() + val * (msMap[intervalUnit] || msMap.weeks));
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
                Register free at developer.maersk.com to get a Consumer Key.
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
                {sanctionsInfo.entryCount > 0 ? `${sanctionsInfo.entryCount.toLocaleString()} entries` : "Not yet synced"}
                {sanctionsInfo.syncs?.[0]?.synced_at && <> · Last {new Date(sanctionsInfo.syncs[0].synced_at).toLocaleDateString()}</>}
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
        </div>
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

      {activeTab === "Activity Log" && isAdmin && (
        <AdminActivityLog />
      )}
    </div>
  );
}
