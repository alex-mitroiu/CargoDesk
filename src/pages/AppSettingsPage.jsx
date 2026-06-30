import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";

const TABS = ["API Controls"];

const APIS = [
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
    id: "ws",
    name: "WebSocket Server",
    provider: "Internal",
    description: "Real-time delivery of shipment messages and event notifications.",
    testType: "ws",
    testUrl: null,
    hasRecurrence: false,
  },
];

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

export default function AppSettingsPage() {
  const [activeTab,     setActiveTab]     = useState("API Controls");
  const [settings,      setSettings]      = useState(null);
  const [testResults,   setTestResults]   = useState({});
  const [testing,       setTesting]       = useState({});
  const [sanctionsInfo, setSanctionsInfo] = useState(null);
  const [syncing,       setSyncing]       = useState(false);
  const saveTimers = useRef({});

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

  const toggle = (apiId) => {
    if (!settings) return;
    const key  = `api_${apiId}_enabled`;
    const next = settings[key] === 'false' ? 'true' : 'false';
    setSettings(s => ({ ...s, [key]: next }));
    clearTimeout(saveTimers.current[key]);
    api.settings.update({ [key]: next })
      .then(() => toast.success(`${APIS.find(a => a.id === apiId)?.name ?? apiId} ${next === 'true' ? 'enabled' : 'disabled'}`))
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
          const tmr   = setTimeout(() => {
            ws.close();
            setTestResults(r => ({ ...r, [apiDef.id]: { ok: false, error: "Timeout (7 s)" } }));
            resolve();
          }, 7000);
          ws.onopen  = () => { clearTimeout(tmr); ws.close(); setTestResults(r => ({ ...r, [apiDef.id]: { ok: true, latency: Date.now() - t0 } })); resolve(); };
          ws.onerror = () => { clearTimeout(tmr); setTestResults(r => ({ ...r, [apiDef.id]: { ok: false, error: "Connection refused" } })); resolve(); };
        });
      } else if (apiDef.testType === "status") {
        const info = await api.sanctions.status();
        setSanctionsInfo(info);
        setTestResults(r => ({ ...r, [apiDef.id]: {
          ok: true, latency: Date.now() - t0,
          label: info.entryCount > 0 ? `${info.entryCount.toLocaleString()} entries` : "No entries — sync required",
        }}));
      } else {
        const ctrl = new AbortController();
        const tmr  = setTimeout(() => ctrl.abort(), 7000);
        const resp = await fetch(apiDef.testUrl, { signal: ctrl.signal });
        clearTimeout(tmr);
        setTestResults(r => ({ ...r, [apiDef.id]: { ok: resp.ok, latency: Date.now() - t0, status: resp.status } }));
      }
    } catch (e) {
      setTestResults(r => ({ ...r, [apiDef.id]: { ok: false, error: e.name === "AbortError" ? "Timeout (7 s)" : e.message } }));
    }
    setTesting(t => ({ ...t, [apiDef.id]: false }));
  };

  const manualSync = async () => {
    setSyncing(true);
    try {
      const result = await api.sanctions.sync();
      toast.success(`OFAC synced: ${result.entries.toLocaleString()} entries`);
      const info = await api.sanctions.status();
      setSanctionsInfo(info);
    } catch (e) {
      toast.error(`Sync failed: ${e.message}`);
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

  return (
    <div style={{ maxWidth: 780 }}>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 0, borderBottom: `2px solid ${T.border}`, marginBottom: 28 }}>
        {TABS.map(tab => (
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
      {activeTab === "API Controls" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {APIS.map(apiDef => {
            const enabled       = settings[`api_${apiDef.id}_enabled`] !== 'false';
            const intervalValue = settings[`api_${apiDef.id}_interval_value`] ?? apiDef.defaultValue ?? '1';
            const intervalUnit  = settings[`api_${apiDef.id}_interval_unit`]  ?? apiDef.defaultUnit  ?? 'days';
            const testResult    = testResults[apiDef.id];
            const isTesting     = testing[apiDef.id];

            // compute next OFAC due
            let ofacNextDue = null;
            if (apiDef.id === 'ofac' && sanctionsInfo?.syncs?.[0]?.synced_at) {
              const val    = Math.max(1, parseInt(intervalValue) || 1);
              const msMap  = { days: 86400000, weeks: 7 * 86400000, months: 30 * 86400000 };
              const ms     = val * (msMap[intervalUnit] || msMap.weeks);
              ofacNextDue  = new Date(new Date(sanctionsInfo.syncs[0].synced_at).getTime() + ms);
            }

            return (
              <div key={apiDef.id} style={{
                border: `1px solid ${T.border}`,
                borderRadius: 10,
                background: T.surface,
                overflow: "hidden",
                opacity: enabled ? 1 : 0.65,
                transition: "opacity 0.2s",
              }}>
                {/* Card header */}
                <div style={{
                  display: "flex", alignItems: "flex-start", justifyContent: "space-between",
                  padding: "16px 20px 14px",
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 5 }}>
                      <span style={{ fontFamily: T.body, fontSize: 15, fontWeight: 700, color: T.text }}>
                        {apiDef.name}
                      </span>
                      <span style={{
                        fontFamily: T.mono, fontSize: 10, color: T.textMuted,
                        background: T.bg, border: `1px solid ${T.border}`,
                        borderRadius: 4, padding: "2px 8px",
                      }}>
                        {apiDef.provider}
                      </span>
                      {!enabled && (
                        <span style={{
                          fontFamily: T.mono, fontSize: 10, color: T.warning,
                          background: `${T.warning}18`, border: `1px solid ${T.warning}44`,
                          borderRadius: 4, padding: "2px 8px",
                        }}>
                          DISABLED
                        </span>
                      )}
                    </div>
                    <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
                      {apiDef.description}
                    </div>
                  </div>
                  <Toggle on={enabled} onChange={() => toggle(apiDef.id)} />
                </div>

                {/* Recurrence row */}
                {apiDef.hasRecurrence && (
                  <div style={{
                    display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10,
                    padding: "12px 20px",
                    borderTop: `1px solid ${T.border}22`,
                    background: `${T.bg}88`,
                  }}>
                    <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                      {apiDef.recurrenceLabel}
                    </span>
                    <input type="number" min={1} max={365} value={intervalValue}
                      onChange={e => setRecurrence(apiDef.id, 'value', e.target.value)}
                      disabled={!enabled}
                      style={{ ...inp, width: 58 }} />
                    <select value={intervalUnit}
                      onChange={e => setRecurrence(apiDef.id, 'unit', e.target.value)}
                      disabled={!enabled}
                      style={{ ...inp, paddingRight: 14, cursor: enabled ? "pointer" : "default" }}>
                      <option value="days">Days</option>
                      <option value="weeks">Weeks</option>
                      <option value="months">Months</option>
                    </select>

                    {/* OFAC-specific: last sync / next due */}
                    {apiDef.id === 'ofac' && sanctionsInfo && (
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginLeft: 4 }}>
                        {sanctionsInfo.entryCount > 0
                          ? `${sanctionsInfo.entryCount.toLocaleString()} entries`
                          : "Not yet synced"}
                        {sanctionsInfo.syncs?.[0]?.synced_at && (
                          <> · Last {new Date(sanctionsInfo.syncs[0].synced_at).toLocaleDateString()}</>
                        )}
                        {ofacNextDue && (
                          <> · Next {ofacNextDue < new Date() ? "overdue" : ofacNextDue.toLocaleDateString()}</>
                        )}
                      </span>
                    )}
                  </div>
                )}

                {/* Actions row */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 20px 14px",
                  borderTop: `1px solid ${T.border}22`,
                }}>
                  {/* Test connectivity */}
                  <button onClick={() => runTest(apiDef)} disabled={isTesting} type="button"
                    style={{
                      padding: "5px 13px", borderRadius: 6,
                      border: `1px solid ${T.accent}55`, background: T.accentBg,
                      color: T.accent, fontFamily: T.mono, fontSize: 12,
                      cursor: isTesting ? "wait" : "pointer",
                      opacity: isTesting ? 0.65 : 1,
                    }}>
                    {isTesting ? "Testing…" : "▶ Test"}
                  </button>

                  {/* OFAC manual sync */}
                  {apiDef.id === 'ofac' && enabled && (
                    <button onClick={manualSync} disabled={syncing} type="button"
                      style={{
                        padding: "5px 13px", borderRadius: 6,
                        border: `1px solid ${T.border}`, background: T.bg,
                        color: T.text, fontFamily: T.mono, fontSize: 12,
                        cursor: syncing ? "wait" : "pointer",
                        opacity: syncing ? 0.65 : 1,
                      }}>
                      {syncing ? "Syncing…" : "↻ Sync Now"}
                    </button>
                  )}

                  <StatusDot result={testResult} testing={isTesting} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
