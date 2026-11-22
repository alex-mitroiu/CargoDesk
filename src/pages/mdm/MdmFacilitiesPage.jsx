import { useState, useEffect, useMemo, useRef } from "react";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import { Modal } from "../../components/primitives/Modal";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY, useHorizonFonts } from "../shipments/shipmentDetailTheme";
import { GlowEdge, frameStyle, sectionLabelStyle, ctaStyle, pillBtnStyle } from "../shipments/schedules/SchedulesParts";

// ─── Master Data → Facilities (2026-11-20, ARCHITECTURE.md §8.56, mockup 3d91c28a) ────────────────────────────────────
// The places a trucker goes that aren't a customer's door: terminals from the SMDG Terminal Code List (the code list DCSA
// uses for terminals; imported by an admin at run time, fetched from its GitHub repository or uploaded, never committed:
// the repository states no licence, the user's decision D) and depots added by hand. A haulage stop picks its place here.
// Trade Horizon Next (the user's rule); App.jsx puts T on its Trade Horizon flavour for this page.

const KIND_LABEL = { TERMINAL: "Terminal", DEPOT: "Depot", OTHER: "Other" };
const PAGE = 200;
const fmtDate = v => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const inp = () => ({ fontFamily: HZ_BODY, fontSize: 13, color: HZ.text, background: HZ.surface2, border: `1px solid ${HZ.border}`, borderRadius: 10, padding: "7px 10px", width: "100%", minWidth: 0 });
const lbl = () => ({ fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted, marginBottom: 4, display: "block" });
const tag = color => ({ display: "inline-flex", fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".04em", padding: "2px 8px", borderRadius: 5, whiteSpace: "nowrap",
  color, background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 40%, transparent)` });

const FacilityForm = ({ initial, onSave, onClose, busy }) => {
  const [f, setF] = useState(() => ({ kind: initial?.kind || "DEPOT", name: initial?.name || "", unlocode: initial?.unlocode || "", code: initial?.code || "",
    codeList: initial?.codeList || "", operator: initial?.operator || "", address: initial?.address || "",
    latitude: initial?.latitude ?? "", longitude: initial?.longitude ?? "", isActive: initial ? !!initial.isActive : true }));
  const set = patch => setF(x => ({ ...x, ...patch }));
  return (
    <div data-testid="facility-form" style={{ display: "grid", gap: 12, fontFamily: HZ_BODY }}>
      <div style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr)", gap: 10 }}>
        <label><span style={lbl()}>Kind</span>
          <select value={f.kind} onChange={e => set({ kind: e.target.value })} style={inp()}>
            {Object.entries(KIND_LABEL).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
        <label><span style={lbl()}>Name</span><input id="facility-name" value={f.name} onChange={e => set({ name: e.target.value })} style={inp()} /></label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "150px 150px minmax(0,1fr)", gap: 10 }}>
        <label><span style={lbl()}>UN/LOCODE</span><input id="facility-unlocode" value={f.unlocode} onChange={e => set({ unlocode: e.target.value.toUpperCase().slice(0, 5) })} placeholder="NLRTM" style={{ ...inp(), fontFamily: HZ_MONO }} /></label>
        <label><span style={lbl()}>Code list</span>
          <select value={f.codeList} onChange={e => set({ codeList: e.target.value })} style={inp()}>
            <option value="">None</option><option value="BIC">BIC facility code</option><option value="SMDG">SMDG</option></select></label>
        <label><span style={lbl()}>Code</span><input value={f.code} onChange={e => set({ code: e.target.value.toUpperCase().slice(0, 6) })} placeholder="Up to 6 characters" style={{ ...inp(), fontFamily: HZ_MONO }} /></label>
      </div>
      <label><span style={lbl()}>Operator</span><input value={f.operator} onChange={e => set({ operator: e.target.value })} style={inp()} /></label>
      <label><span style={lbl()}>Address</span><textarea value={f.address} onChange={e => set({ address: e.target.value })} rows={2} style={inp()} /></label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
        <label><span style={lbl()}>Latitude</span><input value={f.latitude} onChange={e => set({ latitude: e.target.value })} style={{ ...inp(), fontFamily: HZ_MONO }} /></label>
        <label><span style={lbl()}>Longitude</span><input value={f.longitude} onChange={e => set({ longitude: e.target.value })} style={{ ...inp(), fontFamily: HZ_MONO }} /></label>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12.5, paddingBottom: 8 }}>
          <input type="checkbox" checked={f.isActive} onChange={e => set({ isActive: e.target.checked })} />In use</label>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" style={pillBtnStyle()} onClick={onClose}>Cancel</button>
        <button type="button" data-testid="facility-save" style={pillBtnStyle({ accent: true, disabled: busy })} disabled={busy} onClick={() => onSave(f)}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
};

const MdmFacilitiesPage = () => {
  useHorizonFonts();
  const auth = useAuth();
  const isAdmin = !!auth.isAdmin;
  const canWrite = isAdmin || (auth.activeRoles || []).includes("operator");
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState(null);
  const [port, setPort] = useState("");
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [editing, setEditing] = useState(null); // {} = new, row = edit
  const [busy, setBusy] = useState("");
  const fileRef = useRef(null);

  const load = () => Promise.all([api.facilities.list({}).then(setRows), api.facilities.status().then(setStatus)])
    .catch(e => { toast.error(e.message || "Couldn't load the facilities"); setRows(r => r || []); });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (rows || []).filter(r => (!port || r.unlocode === port) && (!kind || r.kind === kind) && (showClosed || r.open)
      && (!term || [r.name, r.code, r.operator, r.address, r.unlocode].some(v => String(v || "").toLowerCase().includes(term))));
  }, [rows, port, kind, q, showClosed]);
  useEffect(() => setShown(PAGE), [port, kind, q, showClosed]);

  const importSmdg = async csv => {
    setBusy("import");
    try {
      const r = await api.facilities.importSmdg(csv);
      const order = { "M/D/Y": "month/day/year", "D/M/Y": "day/month/year" }[r.dates?.order];
      toast.success(`SMDG list imported: ${r.added} added, ${r.updated} updated${r.skipped ? `, ${r.skipped} rows skipped` : ""}${order ? `; the file's dates read as ${order}` : ""}`);
      // A spreadsheet re-save whose dates can't tell day from month (2026-11-22): those dates are left empty, never guessed.
      if (r.dates?.unreadable) toast.error(`${r.dates.unreadable} dates in the file couldn't be read (day and month can't be told apart), so they were left empty. Update from SMDG gets the original file.`);
      await load();
    } catch (e) { toast.error(e.message || "The import failed"); }
    setBusy("");
  };
  const upload = file => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => { importSmdg(String(e.target.result || "")); if (fileRef.current) fileRef.current.value = ""; };
    reader.readAsText(file);
  };
  const save = async f => {
    setBusy("save");
    try {
      if (editing?.id) await api.facilities.update(editing.id, f); else await api.facilities.create(f);
      toast.success(editing?.id ? `${f.name} saved` : `${f.name} added`);
      setEditing(null); await load();
    } catch (e) { toast.error(e.message || "Couldn't save"); }
    setBusy("");
  };
  const toggle = async r => {
    try { await api.facilities.update(r.id, { isActive: !r.isActive }); await load(); toast.success(`${r.name} ${r.isActive ? "switched off" : "switched on"}`); }
    catch (e) { toast.error(e.message); }
  };
  const remove = async r => {
    try { await api.facilities.remove(r.id); toast.success(`${r.name} removed`); await load(); }
    catch (e) { toast.error(e.message); }
  };

  const kindBtn = on => ({ fontFamily: HZ_BODY, fontSize: 12, fontWeight: 600, border: 0, borderRadius: 999, padding: "5px 12px", cursor: "pointer",
    color: on ? HZ.chipText : HZ.textMuted, background: on ? HZ.gradCyan : "transparent" });
  const th = { fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: HZ.textMuted, textAlign: "left", padding: "7px 8px", borderBottom: `1px solid ${HZ.border}` };
  const td = { padding: "8px", borderBottom: `1px solid ${HZ.border}`, verticalAlign: "top", fontSize: 12.5 };

  return (
    <div data-testid="facilities-page" style={{ maxWidth: 1240, margin: "0 auto", display: "grid", gap: 16, fontFamily: HZ_BODY, color: HZ.text }}>
      <section style={{ ...frameStyle(), overflow: "hidden", padding: "20px 22px" }}>
        <GlowEdge />
        <div style={{ position: "relative", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
            <span style={sectionLabelStyle()}>Master Data</span>
            <h1 style={{ fontFamily: HZ_DISPLAY, fontSize: 24, margin: "4px 0 6px", letterSpacing: "-.01em" }}>Facilities</h1>
            <p style={{ margin: 0, fontSize: 13, color: HZ.textMuted, maxWidth: 680 }}>Terminals from the SMDG Terminal Code List, the code list DCSA uses for terminals, and depots
              added by hand. A Pickup or Delivery stop picks its place here. The SMDG list is public but states no licence, so CargoDesk never ships it: it downloads the list once when it first starts, and Update from SMDG fetches it again.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
              {status?.smdgCount ? <span data-testid="facilities-smdg-status" style={tag(HZ.cyan)}>SMDG LIST · {status.smdgCount.toLocaleString("en-GB")} TERMINALS · {status.smdgPorts} PORTS
                {status.smdgLastChange ? ` · CHANGED ${fmtDate(status.smdgLastChange).toUpperCase()}` : ""}</span>
                : <span data-testid="facilities-smdg-status" style={tag(HZ.warn)}>SMDG LIST NOT IMPORTED YET</span>}
              {status?.smdgImportedAt && <span style={tag(HZ.textMuted)}>IMPORTED {fmtDate(status.smdgImportedAt).toUpperCase()}</span>}
              {status && <span style={tag(HZ.violet)}>{status.manualCount} ADDED BY HAND</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {isAdmin && <button type="button" data-testid="facilities-import" style={ctaStyle({ disabled: !!busy })} disabled={!!busy} onClick={() => importSmdg("")}>
              {busy === "import" ? "Importing…" : "Update from SMDG"}</button>}
            {isAdmin && <label style={{ ...pillBtnStyle(), cursor: "pointer" }}>Upload the CSV
              <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={e => upload(e.target.files?.[0])} /></label>}
            {canWrite && <button type="button" data-testid="facilities-add" style={pillBtnStyle({ accent: true })} onClick={() => setEditing({})}>＋ Add depot</button>}
          </div>
        </div>
      </section>

      <section style={{ ...frameStyle(), padding: "14px 18px 18px", display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input aria-label="UN/LOCODE" data-testid="facilities-port" value={port} onChange={e => setPort(e.target.value.toUpperCase().slice(0, 5))} placeholder="Port (UN/LOCODE)"
            style={{ ...inp(), width: 170, fontFamily: HZ_MONO }} />
          <div style={{ display: "inline-flex", gap: 2, padding: 3, border: `1px solid ${HZ.border}`, borderRadius: 999, background: HZ.tint }}>
            {[["", "All"], ["TERMINAL", "Terminals"], ["DEPOT", "Depots"], ["OTHER", "Other"]].map(([k, t]) => (
              <button key={k || "all"} type="button" aria-pressed={kind === k} style={kindBtn(kind === k)} onClick={() => setKind(k)}>{t}</button>))}
          </div>
          <input aria-label="Search" data-testid="facilities-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search a name, code, operator or address…" style={{ ...inp(), flex: "1 1 260px", width: "auto" }} />
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12.5, color: HZ.textMuted }}>
            <input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} />Show closed and switched off</label>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
            <thead><tr>{["Code", "Name", "Kind", "Port", "Operator", "Address", "Source", ""].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {rows === null ? <tr><td colSpan={8} style={{ ...td, color: HZ.textMuted }}>Loading…</td></tr>
                : filtered.length === 0 ? <tr><td colSpan={8} style={{ ...td, color: HZ.textMuted }}>
                    {rows.length ? "Nothing matches." : isAdmin ? "No facilities yet. The SMDG terminals arrive once CargoDesk has downloaded them (it tries again later if it couldn't); Update from SMDG or Upload the CSV brings them in now. Add depots by hand." : "No facilities yet. The SMDG terminals arrive once CargoDesk has downloaded them; depots are added by hand."}</td></tr>
                : filtered.slice(0, shown).map(r => (
                  <tr key={r.id} data-testid="facilities-row" style={{ opacity: r.open ? 1 : 0.55 }}>
                    <td style={{ ...td, fontFamily: HZ_MONO, fontWeight: 700 }}>{r.code || <span style={{ color: HZ.textFaint }}>—</span>}</td>
                    <td style={td}>{r.name}{!r.open && <div style={{ fontSize: 11, color: HZ.warn }}>{!r.isActive ? "Switched off" : `Closed ${fmtDate(r.validTo)}`}</div>}</td>
                    <td style={td}><span style={tag(r.kind === "TERMINAL" ? HZ.cyan : r.kind === "DEPOT" ? HZ.violet : HZ.textMuted)}>{(KIND_LABEL[r.kind] || r.kind).toUpperCase()}</span></td>
                    <td style={{ ...td, fontFamily: HZ_MONO }}>{r.unlocode}</td>
                    <td style={{ ...td, color: HZ.textMuted }}>{r.operator || "—"}</td>
                    <td style={{ ...td, color: HZ.textMuted, maxWidth: 320 }}>{r.address || "—"}</td>
                    <td style={{ ...td, fontSize: 11.5, color: HZ.textMuted }}>{r.source === "smdg" ? "SMDG" : `Added by hand${r.codeList ? ` · ${r.codeList}` : ""}`}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      {r.source === "manual" && canWrite && <>
                        <button type="button" style={pillBtnStyle()} onClick={() => setEditing(r)}>Edit</button>{" "}
                        <button type="button" style={pillBtnStyle()} onClick={() => remove(r)}>Remove</button></>}
                      {r.source === "smdg" && canWrite && <button type="button" style={pillBtnStyle()} onClick={() => toggle(r)}>{r.isActive ? "Switch off" : "Switch on"}</button>}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {rows && filtered.length > shown && (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: HZ.textMuted }}>{shown} of {filtered.length.toLocaleString("en-GB")} shown</span>
            <button type="button" style={pillBtnStyle()} onClick={() => setShown(n => n + PAGE)}>Show {Math.min(PAGE, filtered.length - shown)} more</button>
          </div>
        )}
      </section>

      {editing && (
        <Modal title={editing.id ? `Edit ${editing.name}` : "Add a depot or another place"} onClose={() => setEditing(null)} width={620}>
          <FacilityForm initial={editing.id ? editing : null} busy={busy === "save"} onSave={save} onClose={() => setEditing(null)} />
        </Modal>
      )}
    </div>
  );
};

export default MdmFacilitiesPage;
