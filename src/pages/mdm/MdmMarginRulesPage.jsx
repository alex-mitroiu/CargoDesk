import { useEffect, useRef, useState } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Modal } from "../../components/primitives/Modal";
import { Sel, inputBase } from "../../components/primitives/Form";
import DatePicker from "../../components/primitives/DatePicker";
import DataTable, { TableToolbar } from "../../components/shared/DataTable";
import LanePill from "../../components/shared/LanePill";
import CustomerCombobox from "../../components/shared/CustomerCombobox";
import EntityHistoryModal from "../../components/shared/EntityHistoryModal";
import useTableQuery from "../../hooks/useTableQuery";
import { queryRows, filterOptions, blanksLast } from "../../utils/localTableQuery";

// Master Data → Margin Rules (SPOT rates phase 4; mockup https://claude.ai/artifact/5DYk7qXZLEUn51zJUQpZYK,
// "Margin Rules" artboard). The margin a quote adds on top of what was bought, by customer, trade lane and
// container; the most specific valid rule applies (routes/margin-rules.js). Maintained by admins and
// Trade Managers, like Lane Steering; a small list, filtered in the browser.

const laneOf = r => (r.originLane ? `${r.originLane} → ${r.destLane}` : "any lane");
const marginOf = r => (r.kind === "fixed" ? `USD ${r.value.toLocaleString("en-US")} per container` : `${r.value}% of the buy`);
const validOf = r => (r.validFrom || r.validTo ? `${r.validFrom || "…"} → ${r.validTo || "open"}` : "always");

const COLUMNS = {
  customer:  r => r.customerName || "Everyone",
  lane:      laneOf,
  container: r => r.containerType || "any",
  kind:      r => (r.kind === "fixed" ? "Fixed" : "Percent"),
};
const SPEC = {
  columns: COLUMNS,
  searchText: r => [r.customerName || "Everyone", laneOf(r), r.containerType, marginOf(r)].join(" "),
  sorters: { customer: blanksLast(r => r.customerName), validTo: blanksLast(r => r.validTo) },
};
const SORT_OPTIONS = [
  { value: "",         label: "Most specific first" },
  { value: "customer", label: "By customer" },
  { value: "validTo",  label: "Ending soonest" },
];
const cellText = () => ({ fontFamily: T.body, fontSize: 13, color: T.text });
const muted = () => ({ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" });

const RuleModal = ({ init, tradeLanes, onClose, onSaved }) => {
  const editing = !!init?.id;
  const [customer, setCustomer] = useState({ id: init?.customerId || "", name: init?.customerName || "" });
  const [originLane, setOriginLane] = useState(init?.originLane || "");
  const [destLane, setDestLane] = useState(init?.destLane || "");
  const [containerType, setContainerType] = useState(init?.containerType || "");
  const [kind, setKind] = useState(init?.kind || "fixed");
  const [value, setValue] = useState(init?.value != null ? String(init.value) : "");
  const [minMarginPct, setMinMarginPct] = useState(init?.minMarginPct != null ? String(init.minMarginPct) : "");
  const [validFrom, setValidFrom] = useState(init?.validFrom || "");
  const [validTo, setValidTo] = useState(init?.validTo || "");
  const [busy, setBusy] = useState(false);
  const laneOptions = [{ value: "", label: "Any" }, ...tradeLanes.map(l => ({ value: l.code, label: `${l.code} · ${l.name}` }))];
  const save = async () => {
    setBusy(true);
    const body = { customerId: customer.id, customerName: customer.name, originLane, destLane, containerType, kind, value, minMarginPct, validFrom, validTo };
    try {
      const saved = editing ? await api.marginRules.update(init.id, body) : await api.marginRules.create(body);
      toast.success(`Margin rule saved — ${saved.customerName || "Everyone"}, ${laneOf(saved)}: ${marginOf(saved)}`);
      onSaved();
    } catch (e) { toast.error(e.message || "That didn't save"); }
    finally { setBusy(false); }
  };
  const seg = on => ({ flex: 1, padding: "8px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12.5, fontWeight: 600,
    background: on ? T.accent : "transparent", color: on ? "#06111f" : T.textMuted });
  return (
    <Modal title={editing ? "Edit Margin Rule" : "New Margin Rule"} onClose={() => !busy && onClose()} width={720} data-testid="margin-rule-modal">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <CustomerCombobox label="Customer" value={customer} onChange={v => setCustomer({ id: v.id || "", name: v.name || "" })} />
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Empty: everyone. Lane and container empty: any. The most specific rule applies.</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
          <Sel id="mr-origin" label="Origin Trade" value={originLane} onChange={setOriginLane} options={laneOptions} />
          <Sel id="mr-dest" label="Destination Trade" value={destLane} onChange={setDestLane} options={laneOptions} />
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>Container
            <input value={containerType} onChange={e => setContainerType(e.target.value.toUpperCase().slice(0, 4))} placeholder="Any, or e.g. 40HC" data-testid="margin-rule-container"
              style={{ ...inputBase, fontFamily: T.mono, fontSize: 13, textTransform: "none", letterSpacing: 0 }} />
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr)", gap: 12, alignItems: "end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>Margin</span>
            <div role="radiogroup" aria-label="Margin kind" style={{ display: "flex", padding: 3, gap: 3, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8 }}>
              <button type="button" role="radio" aria-checked={kind === "fixed"} onClick={() => setKind("fixed")} style={seg(kind === "fixed")} data-testid="margin-rule-fixed">USD per container</button>
              <button type="button" role="radio" aria-checked={kind === "percent"} onClick={() => setKind("percent")} style={seg(kind === "percent")} data-testid="margin-rule-percent">% of the buy</button>
            </div>
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>{kind === "fixed" ? "USD per container" : "Percent"}
            <input value={value} inputMode="decimal" onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setValue(e.target.value); }} data-testid="margin-rule-value"
              style={{ ...inputBase, fontFamily: T.mono, fontSize: 13 }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>Minimum margin %
            <input value={minMarginPct} inputMode="decimal" placeholder="none" onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setMinMarginPct(e.target.value); }} data-testid="margin-rule-min"
              style={{ ...inputBase, fontFamily: T.mono, fontSize: 13 }} />
          </label>
        </div>
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: -6 }}>
          {kind === "fixed" ? "Added to the ocean freight of each container; the other charges are passed on at cost." : "Added to every charge."} A quote below the minimum is flagged, never blocked.</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
          <DatePicker id="mr-from" label="Valid From (optional)" value={validFrom} onChange={setValidFrom} />
          <DatePicker id="mr-to" label="Valid To (optional)" value={validTo} onChange={setValidTo} minDate={validFrom || undefined} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={save} disabled={busy || value === "" || (!!originLane !== !!destLane)} data-testid="margin-rule-save">{busy ? "Saving…" : "Save"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

const MdmMarginRulesPage = () => {
  const { canSetMarginRules } = useAuth();
  const [tradeLanes, setTradeLanes] = useState([]);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [history, setHistory] = useState(null);
  useEffect(() => { api.tradeLanes.list().then(setTradeLanes).catch(() => {}); }, []);

  const listRef = useRef(null);
  const load = () => (listRef.current ??= api.marginRules.list().catch(() => []));
  const t = useTableQuery({
    fetchPage: async params => queryRows(await load(), params, SPEC),
    fetchOptions: async () => filterOptions(await load(), COLUMNS),
    filterKeys: Object.keys(COLUMNS),
  });
  const refresh = () => { listRef.current = null; t.reload(); };
  const [count, setCount] = useState(null);
  useEffect(() => { load().then(l => setCount(l.length)); }, [t.rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async () => {
    try { await api.marginRules.remove(deleting.id); toast.success("Margin rule removed"); setDeleting(null); refresh(); }
    catch (e) { toast.error(e.message); }
  };

  const columns = [
    { key: "customer", header: "Customer", width: 200, filter: true,
      render: r => <span style={{ display: "flex", alignItems: "center", gap: 6, ...cellText(), color: r.customerName ? T.text : T.textMuted }}>
        {r.customerName || "Everyone"}{r.isDefault && <Badge size={9.5}>DEFAULT</Badge>}</span> },
    { key: "lane", header: "Trade lane", width: 150, filter: true,
      render: r => r.originLane ? <span style={{ display: "flex", alignItems: "center", gap: 6 }}><LanePill code={r.originLane} /><span style={{ color: T.textMuted }}>→</span><LanePill code={r.destLane} /></span>
        : <span style={muted()}>any lane</span> },
    { key: "container", header: "Container", width: 90, filter: true,
      render: r => r.containerType ? <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text }}>{r.containerType}</span> : <span style={muted()}>any</span> },
    { key: "kind", header: "Margin", width: 190, filter: true,
      render: r => <span style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 700, color: T.text }}>{marginOf(r)}</span> },
    { key: "min", header: "Minimum", width: 80, align: "center",
      render: r => r.minMarginPct != null ? <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text }}>{r.minMarginPct}%</span> : <span style={muted()}>—</span> },
    { key: "valid", header: "Valid", width: 190,
      render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{validOf(r)}</span> },
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Margin Rules</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0", maxWidth: 760 }}>
            {count == null ? "…" : `${count} rule${count === 1 ? "" : "s"}`} · the margin a quote adds on top of what was bought · the most specific applies: the customer's own on the lane and container, then the customer's for any lane, then everyone's on the lane, then everyone's default
          </p>
        </div>
        {canSetMarginRules && <Btn size="lg" onClick={() => setEditing({})} data-testid="margin-rule-new">＋ New margin rule</Btn>}
      </div>
      <TableToolbar tableId="margin-rules" search={t.filters.search} onSearch={t.setSearch} searchPlaceholder="Search customer, lane, container…"
        sort={t.sort} sortOptions={SORT_OPTIONS} onSort={t.setSort} canClear={t.canClear} onClear={t.clear} />
      <DataTable tableId="margin-rules" columns={columns} rows={t.rows} loading={t.loading} rowKey={r => r.id} uppercaseHeaders
        hasFilters={t.hasFilters} filters={t.filters} filterOptions={t.options} onFilterChange={t.setColumnFilter}
        onRowDoubleClick={canSetMarginRules ? r => setEditing(r) : undefined} rowTitle={canSetMarginRules ? () => "Double-click to edit" : undefined}
        rowActions={r => [
          ...(canSetMarginRules ? [{ label: "Edit", onClick: () => setEditing(r) }] : []),
          { label: "History", onClick: () => setHistory(r) },
          ...(canSetMarginRules ? [{ label: "Delete", variant: "danger", onClick: () => setDeleting(r) }] : []),
        ]}
        emptyMessage="No margin rules yet: quotes show their margin without a minimum to check it against."
        emptyFilteredMessage="No margin rule matches your filters."
        pagination={{ total: t.total, offset: t.offset, limit: t.limit, onPage: t.goPage, onLimit: t.changeLimit }} />
      <span style={{ display: "block", marginTop: 10, fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
        Maintained by admins and Trade Managers. A rule suggests the sell price and sets the minimum a quote is checked against; the sell lines stay editable.</span>

      {editing && <RuleModal init={editing.id ? editing : null} tradeLanes={tradeLanes} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {deleting && (
        <Modal title="Remove Margin Rule" onClose={() => setDeleting(null)} width={480}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <p style={{ ...cellText(), margin: 0, lineHeight: 1.6 }}>Remove the rule for <b>{deleting.customerName || "everyone"}</b>, {laneOf(deleting)}{deleting.containerType ? `, ${deleting.containerType}` : ""} ({marginOf(deleting)})? Quotes it applied to fall back to the next rule.</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn variant="secondary" onClick={() => setDeleting(null)}>Cancel</Btn>
              <Btn variant="danger" onClick={remove} data-testid="margin-rule-delete-confirm">Remove</Btn>
            </div>
          </div>
        </Modal>
      )}
      {history && <EntityHistoryModal entityType="margin_rule" entityId={history.id} title={`Margin Rule History — ${history.customerName || "Everyone"}, ${laneOf(history)}`} onClose={() => setHistory(null)} />}
    </div>
  );
};

export default MdmMarginRulesPage;
