import { useState, useRef } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import { useAuth } from "../AuthContext";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Modal } from "../components/primitives/Modal";
import { Textarea } from "../components/primitives/Form";
import { IconCheck } from "../components/primitives/Icon";
import DataTable, { TableToolbar } from "../components/shared/DataTable";
import useTableQuery from "../hooks/useTableQuery";
import { queryRows, filterOptions, blanksLast } from "../utils/localTableQuery";

// Credit Control Depth, third pass (TKT-GLWMFP) — the dedicated, non-Accounting surface a
// trade_manager needs to actually exercise their exclusive override authority. Deliberately NOT
// nested under Accounting (that whole section is hidden from trade_manager's nav, v0.29.0) — a
// narrow, targeted carve-out for credit actions specifically, per the original story's own
// scoping decision, not a reopening of finance data to a role kept out of it on purpose.
// canAct (server-computed, GET /api/credit-overrides/queue) drives everything here: admin/
// operator see the full queue for visibility but never get an action button — the whole point
// of this story is that only the shipment's own lane trade_manager may ever act.

const ReasonModal = ({ title, actionLabel, danger, onClose, onConfirm }) => {
  const [reason, setReason] = useState("");
  const [busy,   setBusy]   = useState(false);
  const submit = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try { await onConfirm(reason.trim()); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={() => !busy && onClose()} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
          textTransform: "uppercase", letterSpacing: ".06em" }}>Reason</label>
        <Textarea value={reason} onChange={setReason} rows={3}
          placeholder="e.g. Confirmed with customer, payment in transit — ref #4521." />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn variant={danger ? "danger" : "primary"} onClick={submit} disabled={!reason.trim() || busy}>
            {busy ? "Submitting…" : actionLabel}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

const BLOCK_LABEL = { hold: "Credit Hold", over_limit: "Over Credit Limit" };

// Column → what the Credit Overrides table shows and filters on; ONE definition feeds both the row
// filters and the header checklists, so a checklist can never offer a value the filter doesn't understand.
const CREDIT_COLUMNS = {
  shipment: r => r.shipmentId,
  customer: r => r.companyName,
  role:     r => r.role,
  block:    r => BLOCK_LABEL[r.blockType] || r.blockType,
};
const CREDIT_SPEC = {
  columns: CREDIT_COLUMNS,
  searchText: r => [r.shipmentId, r.companyName, r.role, BLOCK_LABEL[r.blockType], r.detail].join(" "),
  // The default order is the server's own (held customers' shipments first, then over-limit ones).
  sorters: {
    customer: blanksLast(r => r.companyName),
    shipment: blanksLast(r => r.shipmentId),
  },
};
const CREDIT_FILTER_KEYS = ["shipment", "customer", "role", "block"];
const CREDIT_SORT_OPTIONS = [
  { value: "",         label: "Holds first" },
  { value: "customer", label: "Customer A–Z" },
  { value: "shipment", label: "Shipment A–Z" },
];

const CreditOverridesPage = () => {
  const { isAdmin, isTradeManager } = useAuth();
  const [actionOn, setActionOn] = useState(null); // { row } — the row a reason modal is open for

  // Same table behavior as the other lists (column-header checklists, search, sort, paging), but the
  // filtering runs HERE, over the whole queue, rather than on the server. The queue is small by nature
  // (only shipments currently blocked), unpaginated, and produced by an expensive per-request computation
  // that also decides what THIS user may act on — so it is fetched once, kept in a ref, and both the rows
  // and the checklist options are derived from that one response. refresh() drops it and refetches.
  // (See src/utils/localTableQuery.js; the server-driven pages use lib/tableQuery.js.)
  const queueRef = useRef(null);
  const loadQueue = () => (queueRef.current ??= api.creditOverridesQueue().catch(() => []));
  const t = useTableQuery({
    fetchPage: async params => queryRows(await loadQueue(), params, CREDIT_SPEC),
    fetchOptions: async () => filterOptions(await loadQueue(), CREDIT_COLUMNS),
    filterKeys: CREDIT_FILTER_KEYS,
  });
  const refresh = () => { queueRef.current = null; t.reload(); };

  const doRelease = async (row, reason) => {
    try {
      await api.customers.releaseCreditHold(row.customerId, { shipmentId: row.shipmentId, reason });
      toast.success(`Credit hold released for ${row.companyName}`);
      setActionOn(null);
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  const doApprove = async (row, reason) => {
    try {
      await api.shipments.creditOverride.approve(row.shipmentId, { reason });
      toast.success(`Over-limit override approved for ${row.companyName} — the shipment's invoice can now be generated`);
      setActionOn(null);
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  const columns = [
    { key: "shipment", header: "Shipment", width: 140, filter: true,
      render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 700 }}>{r.shipmentId}</span> },
    { key: "customer", header: "Customer", width: 230, filter: true,
      render: r => <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{r.companyName}</span> },
    { key: "role", header: "Role", width: 120, filter: true,
      render: r => <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{r.role}</span> },
    { key: "block", header: "Block", width: 150, align: "center", filter: true,
      render: r => <Badge variant={r.blockType === "hold" ? "danger" : "warning"}>{BLOCK_LABEL[r.blockType]}</Badge> },
    { key: "detail", header: "Detail", width: 290,
      render: r => (
        <span title={r.detail} style={{ display: "block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap", fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
          {r.detail || "—"}
        </span>
      ) },
    { key: "action", header: "Action", width: 170,
      render: r => (r.canAct ? (
        <Btn size="sm" onClick={() => setActionOn(r)}>
          <IconCheck size={11} />{r.blockType === "hold" ? "Release" : "Approve"}
        </Btn>
      ) : (
        <span style={{ fontFamily: T.body, fontSize: 11, color: T.border, fontStyle: "italic" }}>
          {isAdmin || !isTradeManager ? "Lane manager only" : "Not your lane"}
        </span>
      )) },
  ];

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>
          Credit Overrides
        </h1>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0", maxWidth: 640 }}>
          Every shipment currently blocked by a credit hold or an over-limit customer.
          {isTradeManager
            ? " Only shown here for lanes you're scoped to — releasing a hold or approving an override is exclusively your call for those."
            : " Releasing a hold or approving an override is exclusively the responsibility of the shipment's own trade lane manager — this view is read-only."}
        </p>
      </div>

      <TableToolbar tableId="credit-overrides" search={t.filters.search} onSearch={t.setSearch}
        searchPlaceholder="Search shipment, customer, role, detail…"
        sort={t.sort} sortOptions={CREDIT_SORT_OPTIONS} onSort={t.setSort}
        canClear={t.canClear} onClear={t.clear} />

      <DataTable tableId="credit-overrides" columns={columns} rows={t.rows} loading={t.loading}
        rowKey={r => `${r.customerId}|${r.shipmentId}|${r.blockType}`}
        hasFilters={t.hasFilters} filters={t.filters} filterOptions={t.options} onFilterChange={t.setColumnFilter}
        emptyMessage="Nothing blocked right now." emptyFilteredMessage="Nothing blocked matches your filters."
        pagination={{ total: t.total, offset: t.offset, limit: t.limit, onPage: t.goPage, onLimit: t.changeLimit }} />

      {actionOn && (
        <ReasonModal
          title={actionOn.blockType === "hold" ? `Release Credit Hold — ${actionOn.companyName}` : `Approve Over-Limit Override — ${actionOn.companyName}`}
          actionLabel={actionOn.blockType === "hold" ? "Release Hold" : "Approve Override"}
          danger={actionOn.blockType === "hold"}
          onClose={() => setActionOn(null)}
          onConfirm={reason => actionOn.blockType === "hold" ? doRelease(actionOn, reason) : doApprove(actionOn, reason)}
        />
      )}
    </div>
  );
};

export default CreditOverridesPage;
