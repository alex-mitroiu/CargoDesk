import { useEffect, useRef, useState } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Modal } from "../../components/primitives/Modal";
import { Inp, Sel, inputBase } from "../../components/primitives/Form";
import DatePicker from "../../components/primitives/DatePicker";
import DataTable, { TableToolbar } from "../../components/shared/DataTable";
import LanePill from "../../components/shared/LanePill";
import CarrierCombobox from "../../components/shared/CarrierCombobox";
import CustomerCombobox from "../../components/shared/CustomerCombobox";
import EntityHistoryModal from "../../components/shared/EntityHistoryModal";
import PortCombobox from "../../components/shared/PortCombobox";
import WhereToBookPanel from "../../components/shared/WhereToBook";
import useTableQuery from "../../hooks/useTableQuery";
import { queryRows, filterOptions, blanksLast } from "../../utils/localTableQuery";

// Master Data → Lane Steering (Epic TKT-ASIYFL, Story 5 TKT-SWD5LM; approved mockup
// https://claude.ai/artifact/FXrT7utJNRgPabknbKyPmR, "Lane Steering" artboard). The carrier order per
// trade lane, for everyone or one customer: escalation handlers are offered these options first, and
// with the switch on an unanswered booking moves to the next one. A small list, so it is filtered in
// the browser (src/utils/localTableQuery.js), like Credit Overrides.
// Where to book (Epic TKT-KFGL81, approved mockup https://claude.ai/artifact/KTkERe9u1qHg1yaESQaCEm):
// contract assignment reads the same order, each option with the space configurations behind it
// (shown in the pop-up), and Check shows the answer for a shipment typed in, before it is used.

const today = () => new Date().toISOString().slice(0, 10);
const fmtDay = d => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
const laneOf = s => `${s.originLane} → ${s.destLane}`;

const COLUMNS = {
  lane:     laneOf,
  customer: s => s.customerName || "Everyone",
  carriers: s => s.options.map(o => o.carrierCode),
  switch:   s => (s.autoSwitch ? "On" : "Off"),
};
const SPEC = {
  columns: COLUMNS,
  searchText: s => [laneOf(s), s.customerName || "Everyone", ...s.options.map(o => `${o.carrierCode} ${o.contractNumber} ${o.note}`)].join(" "),
  sorters: { lane: blanksLast(laneOf), validTo: blanksLast(s => s.validTo) },
};
const SORT_OPTIONS = [
  { value: "",        label: "By lane" },
  { value: "validTo", label: "Ending soonest" },
];

const labelStyle = { fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" };
const cellText = { fontFamily: T.body, fontSize: 13, color: T.text };
const iconBtn = { width: 28, height: 28, background: "transparent", border: `1px solid ${T.border}`, borderRadius: 6, color: T.textMuted, cursor: "pointer", fontSize: 13, lineHeight: 1 };

// ─── The edit pop-up ──────────────────────────────────────────────────────────────────────────
const SteeringModal = ({ init, tradeLanes, noAnswerHours, onClose, onSaved }) => {
  const editing = !!init?.id;
  const [originLane, setOriginLane] = useState(init?.originLane || "");
  const [destLane,   setDestLane]   = useState(init?.destLane || "");
  const [customer,   setCustomer]   = useState({ id: init?.customerId || "", name: init?.customerName || "" });
  const [validFrom,  setValidFrom]  = useState(init?.validFrom || today());
  const [validTo,    setValidTo]    = useState(init?.validTo || "");
  const [autoSwitch, setAutoSwitch] = useState(!!init?.autoSwitch);
  const [note,       setNote]       = useState(init?.note || "");
  const [options,    setOptions]    = useState(() => (init?.options || []).map(o => ({ ...o })));
  const [adding,     setAdding]     = useState(false);
  const [newCarrier, setNewCarrier] = useState("");
  const [contracts,  setContracts]  = useState(null);
  const [newContract, setNewContract] = useState("");
  const [busy, setBusy] = useState(false);

  // The picked carrier's active contracts, for the new option's contract list.
  useEffect(() => {
    if (!newCarrier) { setContracts(null); return; }
    let cancelled = false;
    setContracts(null); setNewContract("");
    api.contracts.search({ carrier: newCarrier, status: "Active", limit: 200 })
      .then(r => { if (!cancelled) setContracts((r.results || []).filter(c => c.carrierCode === newCarrier && !options.some(o => o.contractId === c.id))); })
      .catch(() => !cancelled && setContracts([]));
    return () => { cancelled = true; };
  }, [newCarrier]); // eslint-disable-line react-hooks/exhaustive-deps

  const laneOptions = [{ value: "", label: "Pick a trade…" }, ...tradeLanes.map(l => ({ value: l.code, label: `${l.code} · ${l.name}` }))];
  const move = (i, by) => setOptions(list => { const next = [...list]; [next[i], next[i + by]] = [next[i + by], next[i]]; return next; });
  const addOption = () => {
    const c = contracts?.find(x => x.id === newContract);
    if (!c) return;
    setOptions(list => [...list, { carrierCode: newCarrier, contractId: c.id, contractNumber: c.contractNumber, contractValidTo: c.validTo, note: "" }]);
    setAdding(false); setNewCarrier(""); setNewContract("");
  };
  const save = async () => {
    setBusy(true);
    const body = { originLane, destLane, customerId: customer.id, customerName: customer.name, validFrom, validTo, autoSwitch, note,
      options: options.map(o => ({ carrierCode: o.carrierCode, contractId: o.contractId, note: o.note || "" })) };
    try {
      const saved = editing ? await api.laneSteerings.update(init.id, body) : await api.laneSteerings.create(body);
      toast.success(`Lane steering saved — ${laneOf(saved)}${saved.customerName ? ` for ${saved.customerName}` : ""}`);
      onSaved();
    } catch (e) { toast.error(e.message || "That didn't save"); }
    finally { setBusy(false); }
  };
  const ready = originLane && destLane && validFrom && validTo && options.length > 0;

  return (
    <Modal title={editing ? `Edit Lane Steering — ${laneOf(init)}` : "Add Lane Steering"} onClose={() => !busy && onClose()} width={940} data-testid="lane-steering-modal">
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>
          <Sel id="ls-origin" label="Origin Trade" value={originLane} onChange={setOriginLane} options={laneOptions} required />
          <Sel id="ls-dest" label="Destination Trade" value={destLane} onChange={setDestLane} options={laneOptions} required />
          <DatePicker id="ls-from" label="Valid From" value={validFrom} onChange={setValidFrom} required />
          <DatePicker id="ls-to" label="Valid To" value={validTo} onChange={setValidTo} minDate={validFrom} required />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <CustomerCombobox label="Customer" value={customer} onChange={v => setCustomer({ id: v.id || "", name: v.name || "" })} />
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Leave it empty to steer the lane for everyone. A customer's own steering wins over everyone's.</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labelStyle}>Note on the line</span>
          <input aria-label="Note on the line" data-testid="lane-steering-note" value={note} maxLength={300} placeholder="e.g. Book MAEU first; CMDU only when MAEU is full"
            onChange={e => setNote(e.target.value)} style={{ ...inputBase, fontFamily: T.body, fontSize: 13 }} />
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Shown with the options wherever a contract is assigned on this lane.</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 16px" }}>
          <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <b style={{ fontFamily: T.body, fontSize: 13.5, color: T.text }}>Switch to the next option when the carrier doesn't answer</b>
            <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>
              After the no-answer time ({noAnswerHours} h, App Settings) the request is cancelled and the shipment is booked on the next option's first sailing with space. After the last option it escalates to OCC/AY.
            </span>
          </span>
          <button type="button" role="switch" aria-checked={autoSwitch} aria-label="Switch automatically" data-testid="lane-steering-switch"
            onClick={() => setAutoSwitch(v => !v)}
            style={{ flexShrink: 0, width: 42, height: 24, borderRadius: 999, border: "none", cursor: "pointer", position: "relative",
              background: autoSwitch ? T.accent : T.border, transition: "background .15s" }}>
            <span style={{ position: "absolute", top: 3, left: autoSwitch ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={labelStyle}>Options, in order</span>
          <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "44px 80px 1.4fr 110px 1.6fr 104px", gap: 10, padding: "8px 14px", borderBottom: `1px solid ${T.border}`, ...labelStyle }}>
              <span>#</span><span>Carrier</span><span>Contract</span><span>Valid to</span><span>Note</span><span>Order</span>
            </div>
            {options.length === 0 && (
              <div style={{ padding: "16px 14px", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>No options yet. Add the carriers in the order handlers should try them.</div>
            )}
            {options.map((o, i) => (
              <div key={o.contractId} data-testid={`lane-steering-option-${i + 1}`} style={{ display: "grid", gridTemplateColumns: "44px 80px 1.4fr 110px 1.6fr 104px", gap: 10, alignItems: "center", padding: "8px 14px", borderBottom: i < options.length - 1 ? `1px solid ${T.border}22` : "none" }}>
                <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>#{i + 1}</span>
                <span style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 700, color: T.text }}>{o.carrierCode}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.contractNumber}>{o.contractNumber}</span>
                  <Badge variant="central" size={9.5}>CENTRAL</Badge>
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textMuted }}>{fmtDay(o.contractValidTo)}</span>
                <input aria-label={`Note for option ${i + 1}`} value={o.note || ""} maxLength={200} placeholder="e.g. Preferred on Mondays"
                  onChange={e => { const v = e.target.value; setOptions(list => list.map((x, j) => (j === i ? { ...x, note: v } : x))); }}
                  style={{ ...inputBase, fontFamily: T.body, fontSize: 12.5, padding: "6px 10px" }} />
                <span style={{ display: "flex", gap: 4 }}>
                  <button type="button" aria-label={`Move option ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} style={{ ...iconBtn, opacity: i === 0 ? .4 : 1 }}>↑</button>
                  <button type="button" aria-label={`Move option ${i + 1} down`} disabled={i === options.length - 1} onClick={() => move(i, 1)} style={{ ...iconBtn, opacity: i === options.length - 1 ? .4 : 1 }}>↓</button>
                  <button type="button" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(list => list.filter((_, j) => j !== i))} style={{ ...iconBtn, color: T.danger }}>×</button>
                </span>
                {/* The space behind the option: the contract's space configurations that haven't ended. */}
                <span data-testid={`lane-steering-option-${i + 1}-space`} style={{ gridColumn: "2 / -1", display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {!o.space ? (
                    <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>Its space shows once saved.</span>
                  ) : o.space.length === 0 ? (
                    <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.warning }}>No space configured on this contract: order only, no cap. Add one in Space Configurations to cap it.</span>
                  ) : o.space.map(a => (
                    <span key={a.id} style={{ fontFamily: T.mono, fontSize: 11, color: T.text, padding: "2px 8px", borderRadius: 6,
                      border: `1px solid ${a.spaceBasis === "week" ? T.accent : T.border}` }}>
                      {a.id} · {a.allocatedTEU} TEU{a.spaceBasis === "week" ? "/week" : ""} · {fmtDay(a.effectiveDate)} – {fmtDay(a.endDate)}
                      {a.loopCode ? ` · loop ${a.loopCode}` : ""}{a.customerName ? ` · ${a.customerName} only` : ""}{a.commodityCode && a.commodityCode !== "9999" ? ` · commodity ${a.commodityCode}` : ""}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
          {adding ? (
            <div data-testid="lane-steering-add-row" style={{ display: "grid", gridTemplateColumns: "180px 1fr auto auto", gap: 10, alignItems: "end" }}>
              <div><span style={labelStyle}>Carrier</span><CarrierCombobox value={newCarrier} onChange={v => setNewCarrier(typeof v === "string" ? v : v?.code || "")} /></div>
              <Sel id="ls-new-contract" label="Contract" value={newContract} onChange={setNewContract} disabled={!newCarrier || !contracts?.length}
                options={[{ value: "", label: !newCarrier ? "Pick the carrier first" : !contracts ? "Loading contracts…" : contracts.length ? "Pick a contract…" : `No active ${newCarrier} contracts` },
                  ...(contracts || []).map(c => ({ value: c.id, label: `${c.contractNumber} · until ${fmtDay(c.validTo)}${c.namedAccount ? ` · ${c.namedAccount} only` : ""}` }))]} />
              <Btn variant="secondary" onClick={() => { setAdding(false); setNewCarrier(""); }}>Cancel</Btn>
              <Btn onClick={addOption} disabled={!newContract} data-testid="lane-steering-add-confirm">Add</Btn>
            </div>
          ) : (
            <div><Btn variant="secondary" onClick={() => setAdding(true)} data-testid="lane-steering-add-option">＋ Add option</Btn></div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={save} disabled={!ready || busy} data-testid="lane-steering-save">{busy ? "Saving…" : "Save"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Check: what the booking desk would be told ───────────────────────────────────────────────
// Read-only (GET /api/where-to-book with typed-in values): nothing is saved or booked.
const CheckModal = ({ onClose }) => {
  const [customer,  setCustomer]  = useState({ id: "", name: "" });
  const [pol,       setPol]       = useState(null);
  const [pod,       setPod]       = useState(null);
  const [etd,       setEtd]       = useState(today());
  const [commodity, setCommodity] = useState("9999");
  const [loop,      setLoop]      = useState("");
  const [teu,       setTeu]       = useState("2");
  const [answer,    setAnswer]    = useState(null);
  const [busy,      setBusy]      = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      setAnswer(await api.whereToBook({ pol: pol.unlocode, pod: pod.unlocode, etd, teu: teu || "0", commodityCode: commodity,
        ...(customer.id && { customerId: customer.id }), ...(loop.trim() && { loopCode: loop.trim().toUpperCase() }) }));
    } catch (e) { toast.error(e.message || "The check failed"); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Check where to book" onClose={onClose} width={860} data-testid="lane-steering-check-modal">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>What the booking desk would be told for a shipment like this. Nothing is saved or booked.</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, alignItems: "end" }}>
          <CustomerCombobox label="Customer" value={customer} onChange={v => setCustomer({ id: v.id || "", name: v.name || "" })} />
          <div><span style={labelStyle}>POL</span><PortCombobox value={pol} onChange={setPol} /></div>
          <div><span style={labelStyle}>POD</span><PortCombobox value={pod} onChange={setPod} /></div>
          <DatePicker id="ls-check-etd" label="ETD" value={etd} onChange={setEtd} />
          <Inp id="ls-check-commodity" label="Commodity" value={commodity} onChange={setCommodity} mono />
          <Inp id="ls-check-loop" label="Loop (optional)" value={loop} onChange={setLoop} mono />
          <Inp id="ls-check-teu" label="TEU" type="number" value={teu} onChange={setTeu} mono />
          <Btn onClick={check} disabled={!pol?.unlocode || !pod?.unlocode || busy} data-testid="lane-steering-check-run">{busy ? "Checking…" : "Check"}</Btn>
        </div>
        {answer && <WhereToBookPanel answer={answer} />}
      </div>
    </Modal>
  );
};

// ─── The page ─────────────────────────────────────────────────────────────────────────────────
const MdmLaneSteeringPage = () => {
  const { canSteerLanes } = useAuth();
  const [tradeLanes, setTradeLanes] = useState([]);
  const [noAnswerHours, setNoAnswerHours] = useState("2");
  const [editing, setEditing] = useState(null);     // {} = new, a row = edit
  const [deleting, setDeleting] = useState(null);
  const [history, setHistory] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.tradeLanes.list().then(setTradeLanes).catch(() => {});
    api.settings.get().then(s => s?.booking_no_answer_hours && setNoAnswerHours(s.booking_no_answer_hours)).catch(() => {});
  }, []);

  const listRef = useRef(null);
  const load = () => (listRef.current ??= api.laneSteerings.list().catch(() => []));
  const t = useTableQuery({
    fetchPage: async params => queryRows(await load(), params, SPEC),
    fetchOptions: async () => filterOptions(await load(), COLUMNS),
    filterKeys: Object.keys(COLUMNS),
  });
  const refresh = () => { listRef.current = null; t.reload(); };
  const [count, setCount] = useState(null);
  useEffect(() => { load().then(l => setCount(l.length)); }, [t.rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async () => {
    try {
      await api.laneSteerings.remove(deleting.id);
      toast.success(`Lane steering removed — ${laneOf(deleting)}`);
      setDeleting(null); refresh();
    } catch (e) { toast.error(e.message); }
  };

  const columns = [
    { key: "lane", header: "Lane", width: 150, filter: true,
      render: s => <span style={{ display: "flex", alignItems: "center", gap: 6 }}><LanePill code={s.originLane} /><span style={{ color: T.textMuted }}>→</span><LanePill code={s.destLane} /></span> },
    { key: "customer", header: "Customer", width: 180, filter: true,
      render: s => <span style={{ ...cellText, color: s.customerName ? T.text : T.textMuted }}>{s.customerName || "Everyone"}</span> },
    { key: "carriers", header: "Options in order", width: 250, filter: true,
      render: s => (
        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px", fontFamily: T.mono, fontSize: 12 }}>
          {s.options.map((o, i) => (
            <span key={o.id} title={`${o.contractNumber}${o.contractValidTo ? ` · until ${fmtDay(o.contractValidTo)}` : ""}${o.note ? ` · ${o.note}` : ""}`}
              style={{ color: o.contractStatus && o.contractStatus !== "Active" ? T.danger : T.text }}>
              {i > 0 && <span style={{ color: T.textMuted, marginRight: 8 }}>·</span>}
              <b><span style={{ color: T.accent }}>#{o.rank}</span> {o.carrierCode}</b>
            </span>
          ))}
        </span>
      ) },
    { key: "switch", header: "No-answer switch", width: 110, align: "center", filter: true,
      render: s => <Badge variant={s.autoSwitch ? "success" : "default"}>{s.autoSwitch ? "ON" : "OFF"}</Badge> },
    { key: "valid", header: "Valid", width: 176,
      render: s => {
        const state = s.validTo < today() ? "ended" : s.validFrom > today() ? "upcoming" : "";
        return (
          <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px" }}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: state === "ended" ? T.textMuted : T.text }}>{s.validFrom} → {s.validTo}</span>
            {state && <Badge variant={state === "ended" ? "default" : "info"} size={9.5}>{state.toUpperCase()}</Badge>}
          </span>
        );
      } },
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Lane Steering</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0", maxWidth: 720 }}>
            {count == null ? "…" : `${count} steered lane${count === 1 ? "" : "s"}`} · the carrier order shown as Where to book when a contract is assigned, offered to escalation handlers and followed by the no-answer switch · unsteered lanes use the contract search, Central first
          </p>
        </div>
        <span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <Btn size="lg" variant="secondary" onClick={() => setChecking(true)} data-testid="lane-steering-check">Check</Btn>
          {canSteerLanes && <Btn size="lg" onClick={() => setEditing({})} data-testid="lane-steering-new">＋ Add Lane Steering</Btn>}
        </span>
      </div>

      <TableToolbar tableId="lane-steering" search={t.filters.search} onSearch={t.setSearch}
        searchPlaceholder="Search lane, customer, carrier, contract…"
        sort={t.sort} sortOptions={SORT_OPTIONS} onSort={t.setSort}
        canClear={t.canClear} onClear={t.clear} />

      {/* 926px of columns: fits beside the sidebar from a 1280px screen up. */}
      <DataTable tableId="lane-steering" columns={columns} rows={t.rows} loading={t.loading} rowKey={s => s.id} uppercaseHeaders
        hasFilters={t.hasFilters} filters={t.filters} filterOptions={t.options} onFilterChange={t.setColumnFilter}
        onRowDoubleClick={canSteerLanes ? s => setEditing(s) : undefined} rowTitle={canSteerLanes ? () => "Double-click to edit" : undefined}
        rowActions={s => [
          ...(canSteerLanes ? [{ label: "Edit", onClick: () => setEditing(s) }] : []),
          { label: "History", onClick: () => setHistory(s) },
          ...(canSteerLanes ? [{ label: "Delete", variant: "danger", onClick: () => setDeleting(s) }] : []),
        ]}
        emptyMessage="No lane is steered yet: escalations use the contract search, Central first."
        emptyFilteredMessage="No lane steering matches your filters."
        pagination={{ total: t.total, offset: t.offset, limit: t.limit, onPage: t.goPage, onLimit: t.changeLimit }} />

      {editing && (
        <SteeringModal init={editing.id ? editing : null} tradeLanes={tradeLanes} noAnswerHours={noAnswerHours}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />
      )}
      {deleting && (
        <Modal title="Remove Lane Steering" onClose={() => setDeleting(null)} width={480}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <p style={{ ...cellText, margin: 0, lineHeight: 1.6 }}>
              Remove the steering for <b>{laneOf(deleting)}</b>{deleting.customerName ? <> for <b>{deleting.customerName}</b></> : " for everyone"}? Escalations on this lane go back to the contract search, Central first.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn variant="secondary" onClick={() => setDeleting(null)}>Cancel</Btn>
              <Btn variant="danger" onClick={remove} data-testid="lane-steering-delete-confirm">Remove</Btn>
            </div>
          </div>
        </Modal>
      )}
      {checking && <CheckModal onClose={() => setChecking(false)} />}
      {history && (
        <EntityHistoryModal entityType="lane_steering" entityId={history.id}
          title={`Lane Steering History — ${laneOf(history)}${history.customerName ? ` · ${history.customerName}` : ""}`} onClose={() => setHistory(null)} />
      )}
    </div>
  );
};

export default MdmLaneSteeringPage;
