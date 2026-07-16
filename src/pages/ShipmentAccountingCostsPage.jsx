import { useState, useEffect } from "react";
import { T } from "../tokens";
import { useAuth } from "../AuthContext";
import Btn from "../components/primitives/Btn";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import { CostLineForm, CostLineHistoryModal, CostLineRow } from "./ShipmentDetailPage";
import { api } from "../api";
import { toast } from "../toast";

const fmtUsd = v => v == null ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ─── Shipment Cost Entry Page ─────────────────────────────────────────────
// Dedicated sub-page for BUY-side cost lines, split out of the old flat
// CostControl component (see ARCHITECTURE.md / TKT-6QT30S). Reset to Contract
// and Update Carrier Costs replay/regenerate from rate snapshots — frozen
// copies of contract_rates — so a reset never silently picks up a live
// carrier rate change after a client has already been quoted.

const ShipmentAccountingCostsPage = ({ shipment, containers, onBack }) => {
  const { canEditShipments: canEdit } = useAuth();
  const ctrs = containers.filter(c => c.shipmentId === shipment.id);

  const [lines,      setLines]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [fxRates,    setFxRates]    = useState({});
  const [snapshots,  setSnapshots]  = useState([]);
  const [lineModal,  setLineModal]  = useState(null); // null | "add" | line object
  const [confirm,    setConfirm]    = useState(null);
  const [histOpen,   setHistOpen]   = useState(false);
  const [actionModal, setActionModal] = useState(null); // null | "import" | "reset" | "update"
  const [splitPerCtr, setSplitPerCtr] = useState(false);
  const [busy,        setBusy]        = useState(false);

  const isCentral = shipment.contractType === "Central" && !!shipment.contractId;

  const load = () => {
    setLoading(true);
    return api.costLines.list(shipment.id)
      .then(setLines).catch(() => setLines([])).finally(() => setLoading(false));
  };
  const loadSnapshots = () => {
    if (!isCentral) return;
    api.costLines.rateSnapshots(shipment.id).then(setSnapshots).catch(() => setSnapshots([]));
  };

  useEffect(() => {
    load();
    loadSnapshots();
    api.fx.rates().then(d => setFxRates(d.rates || {})).catch(() => {});
  }, [shipment.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const buyLines  = lines.filter(l => l.type === "BUY");
  const totalBuy  = buyLines.reduce((s, l) => s + l.amountUsd, 0);
  const hasContractLines = buyLines.some(l => l.source === "contract");
  const latestSnapshot = snapshots[0] || null;

  const handleSave = async (data, mirror = false) => {
    try {
      if (lineModal === "add") {
        await api.costLines.create(shipment.id, data);
        if (mirror) {
          // Tagged 'mirror', not inherited from `data`/source — this line didn't come
          // from a contract import, so Reset/Update Carrier Costs must never touch it.
          await api.costLines.create(shipment.id, { ...data, type: "SELL", source: "mirror" });
          toast.success("Cost line added + mirrored to Invoice Entry as SELL");
        } else {
          toast.success("Cost line added");
        }
      } else {
        await api.costLines.update(shipment.id, lineModal.id, data);
        if (mirror) {
          await api.costLines.create(shipment.id, { ...data, type: "SELL", source: "mirror" });
          toast.success("Changes saved + mirrored to Invoice Entry as SELL");
        } else {
          toast.success("Cost line updated");
        }
      }
      setLineModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async id => {
    try {
      await api.costLines.remove(shipment.id, id);
      toast.success("Cost line removed");
      setConfirm(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const openAction = mode => {
    setSplitPerCtr(ctrs.length > 1);
    setActionModal(mode);
  };

  const runAction = async () => {
    setBusy(true);
    try {
      const opts = { splitPerContainer: splitPerCtr };
      const result = actionModal === "import" ? await api.costLines.importContract(shipment.id, opts)
        : actionModal === "reset" ? await api.costLines.resetToContract(shipment.id, opts)
        : await api.costLines.updateCarrierCosts(shipment.id, opts);
      toast.success(
        actionModal === "import" ? `${result.imported} BUY line${result.imported !== 1 ? "s" : ""} imported from contract`
        : actionModal === "reset" ? `Reset to contract — ${result.imported} line${result.imported !== 1 ? "s" : ""} regenerated from the committed rate snapshot`
        : `Carrier costs updated — ${result.imported} line${result.imported !== 1 ? "s" : ""} regenerated from a new rate snapshot`
      );
      setActionModal(null);
      await load();
      loadSnapshots();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  const th = { fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".07em" };

  const ACTION_COPY = {
    import: { title: "Import from Contract", confirm: "Import", body: "Generate BUY lines from the assigned contract's rates. This creates the shipment's initial rate snapshot — a frozen copy of the rates at this point in time." },
    reset:  { title: "Reset to Contract", confirm: "Reset", body: `Regenerate BUY lines from the rate snapshot already committed to this shipment${latestSnapshot ? ` (${latestSnapshot.reason}, ${new Date(latestSnapshot.generatedAt).toLocaleDateString()})` : ""}. This does NOT pull new rates — manually added lines are untouched.` },
    update: { title: "Update Carrier Costs", confirm: "Update", body: "Pull the CURRENT contract rates into a new snapshot and regenerate BUY lines from it. Use this when the carrier's contract rates have changed and the shipment needs to reflect the new pricing." },
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {isCentral && latestSnapshot && (
        <div style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted, marginBottom: 14 }}>
          Rates confirmed {new Date(latestSnapshot.generatedAt).toLocaleDateString()} ({latestSnapshot.reason})
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            {buyLines.length} line{buyLines.length !== 1 ? "s" : ""}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>
            Total Buy: {fmtUsd(totalBuy)}
          </span>
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn size="sm" variant="secondary" onClick={() => setHistOpen(true)}>⏱ History</Btn>
            {isCentral && !hasContractLines && (
              <Btn size="sm" variant="secondary" onClick={() => openAction("import")}>⬇ Import from Contract</Btn>
            )}
            {isCentral && hasContractLines && (
              <>
                <Btn size="sm" variant="secondary" onClick={() => openAction("reset")}>↺ Reset to Contract</Btn>
                <Btn size="sm" variant="secondary" onClick={() => openAction("update")}>⇪ Update Carrier Costs</Btn>
              </>
            )}
            <Btn size="sm" onClick={() => setLineModal("add")}>＋ Add Line</Btn>
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading…</div>
      ) : buyLines.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", fontFamily: T.body,
          fontSize: 13, color: T.textMuted, fontStyle: "italic",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
          No cost lines yet.
        </div>
      ) : (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface }}>
          <div style={{ display: "flex", alignItems: "center", padding: "7px 16px",
            borderBottom: `1px solid ${T.border}`, background: T.bg }}>
            <div style={{ ...th, width: 60 }}>Type</div>
            <div style={{ ...th, flex: 1 }}>Charge</div>
            <div style={{ ...th, width: 100, paddingLeft: 4 }}>Container</div>
            <div style={{ ...th, width: 160, paddingLeft: 4 }}>Source</div>
            <div style={{ ...th, width: 80 }}>Currency</div>
            <div style={{ ...th, width: 100, textAlign: "right" }}>Exch. Rate</div>
            <div style={{ ...th, width: 110, textAlign: "right" }}>Amount (USD)</div>
            <div style={{ width: 36 }} />
          </div>
          {buyLines.map(l => (
            <CostLineRow key={l.id} line={l} containers={ctrs} showActions
              onEdit={() => setLineModal(l)} onDelete={() => setConfirm(l.id)} />
          ))}
        </div>
      )}

      {lineModal && (
        <Modal title={lineModal === "add" ? "Add Cost Line" : "Edit Cost Line"} onClose={() => setLineModal(null)}>
          <CostLineForm init={lineModal === "add" ? {} : lineModal} fxRates={fxRates} containers={ctrs} lockType="BUY"
            onSave={data => handleSave(data, false)}
            onSaveAndMirror={data => handleSave(data, true)}
            onCancel={() => setLineModal(null)} />
        </Modal>
      )}

      {actionModal && (
        <Modal title={ACTION_COPY[actionModal].title} onClose={() => setActionModal(null)} width={440}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
              {ACTION_COPY[actionModal].body}
            </div>
            {actionModal !== "reset" && ctrs.length > 1 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.textMuted,
                  textTransform: "uppercase", letterSpacing: ".06em" }}>
                  Per-container rate lines — {ctrs.length} containers
                </div>
                {[{ v: false, label: `Aggregate (1 line × ${ctrs.length})`, desc: "One combined line with the multiplied amount" },
                  { v: true,  label: `Split per container (${ctrs.length} lines per rate)`, desc: "Individual line per container at the unit rate" }].map(opt => (
                  <label key={String(opt.v)} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                    <input type="radio" checked={splitPerCtr === opt.v} onChange={() => setSplitPerCtr(opt.v)} style={{ marginTop: 3 }} />
                    <div>
                      <div style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{opt.label}</div>
                      <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{opt.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn variant="secondary" onClick={() => setActionModal(null)} disabled={busy}>Cancel</Btn>
              <Btn onClick={runAction} disabled={busy}>{busy ? "Working…" : ACTION_COPY[actionModal].confirm}</Btn>
            </div>
          </div>
        </Modal>
      )}

      {histOpen && <CostLineHistoryModal shipmentId={shipment.id} onClose={() => setHistOpen(false)} />}

      {confirm && (
        <ConfirmModal
          message="Remove this cost line?"
          onConfirm={() => handleDelete(confirm)}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default ShipmentAccountingCostsPage;
