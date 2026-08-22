import { useState, useEffect } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import { useAuth } from "../AuthContext";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import Spinner from "../components/primitives/Spinner";
import { Modal } from "../components/primitives/Modal";
import { Textarea } from "../components/primitives/Form";
import { IconCheck } from "../components/primitives/Icon";

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

const CreditOverridesPage = () => {
  const { isAdmin, isTradeManager } = useAuth();
  const [rows,    setRows]    = useState(null);
  const [actionOn, setActionOn] = useState(null); // { row } — the row a reason modal is open for

  const load = () => {
    api.creditOverridesQueue().then(setRows).catch(() => setRows([]));
  };
  useEffect(load, []);

  const doRelease = async (row, reason) => {
    try {
      await api.customers.releaseCreditHold(row.customerId, { shipmentId: row.shipmentId, reason });
      toast.success(`Credit hold released for ${row.companyName}`);
      setActionOn(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const doApprove = async (row, reason) => {
    try {
      await api.shipments.creditOverride.approve(row.shipmentId, { reason });
      toast.success(`Over-limit override approved for ${row.companyName} — the shipment's invoice can now be generated`);
      setActionOn(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  if (rows === null) return <div style={{ padding: 24 }}><Spinner /></div>;

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

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 140px 120px 1fr 140px",
          padding: "9px 20px", borderBottom: `1px solid ${T.border}`, background: T.bg }}>
          {["Shipment", "Customer", "Role", "Block", "Detail", "Action"].map(h => (
            <span key={h} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
              color: T.border, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
          ))}
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", fontFamily: T.body,
            fontSize: 14, color: T.textMuted, fontStyle: "italic" }}>
            Nothing blocked right now.
          </div>
        ) : rows.map((r, i) => (
          <div key={`${r.shipmentId}-${r.blockType}-${i}`}
            style={{ display: "grid", gridTemplateColumns: "130px 1fr 140px 120px 1fr 140px",
              padding: "12px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 700 }}>{r.shipmentId}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{r.companyName}</span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{r.role}</span>
            <Badge variant={r.blockType === "hold" ? "danger" : "warning"}>{BLOCK_LABEL[r.blockType]}</Badge>
            <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.detail}>
              {r.detail || "—"}
            </span>
            <div>
              {r.canAct ? (
                <Btn size="sm" onClick={() => setActionOn(r)}>
                  <IconCheck size={11} />{r.blockType === "hold" ? "Release" : "Approve"}
                </Btn>
              ) : (
                <span style={{ fontFamily: T.body, fontSize: 11, color: T.border, fontStyle: "italic" }}>
                  {isAdmin || !isTradeManager ? "Lane manager only" : "Not your lane"}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

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
