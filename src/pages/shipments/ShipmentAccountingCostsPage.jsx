import { useState, useEffect } from "react";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import { CostLineForm, CostLineHistoryModal, CostLineRow, CostLineActualizeModal, CostLineAdjustModal, ReconcileCarrierCostsModal } from "./ShipmentDetailPage";
import { api } from "../../api";
import { toast } from "../../toast";
import { IconClipboard, IconArrowDown, IconArrowUp, IconRefresh } from "../../components/primitives/Icon";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY, useHorizonFonts } from "./shipmentDetailTheme";

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
  const [actionModal, setActionModal] = useState(null); // null | "reset" — "import"/"update" go through reconcileMode instead
  const [reconcileMode, setReconcileMode] = useState(null); // null | "import" | "update"
  const [splitPerCtr, setSplitPerCtr] = useState(false);
  const [busy,        setBusy]        = useState(false);
  const [actualizeLine, setActualizeLine] = useState(null); // line pending actualization
  const [confirmPost,   setConfirmPost]   = useState(null); // line pending Post confirmation
  const [adjustLine,    setAdjustLine]    = useState(null); // posted line pending an Adjust entry

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

  const handleActualize = async data => {
    try {
      await api.costLines.actualize(shipment.id, actualizeLine.id, data);
      toast.success("Cost line actualized");
      setActualizeLine(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handlePost = async () => {
    const line = confirmPost;
    setConfirmPost(null);
    try {
      await api.costLines.post(shipment.id, line.id);
      toast.success("Cost line posted — now locked");
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleAdjust = async data => {
    try {
      await api.costLines.adjust(shipment.id, adjustLine.id, data);
      toast.success("Adjustment posted");
      setAdjustLine(null);
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
      const result = await api.costLines.resetToContract(shipment.id, { splitPerContainer: splitPerCtr });
      toast.success(`Reset to contract — ${result.imported} line${result.imported !== 1 ? "s" : ""} regenerated from the committed rate snapshot`);
      setActionModal(null);
      await load();
      loadSnapshots();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  const handleReconciled = () => {
    setReconcileMode(null);
    load();
    loadSnapshots();
  };

  const ACTION_COPY = {
    reset: { title: "Reset to Contract", confirm: "Reset", body: `Regenerate BUY lines from the rate snapshot already committed to this shipment${latestSnapshot ? ` (${latestSnapshot.reason}, ${new Date(latestSnapshot.generatedAt).toLocaleDateString()})` : ""}. This does NOT pull new rates — manually added lines are untouched.` },
  };

  // Cargo-style stat strip — real totals, same treatment as the Cargo tab's New Style
  // (approved mockup: https://claude.ai/artifact/25ygL745mmMfvYWBXZWoAE).
  const fromContractCount = buyLines.filter(l => l.source === "contract").length;
  const accruedCount = buyLines.filter(l => (l.status || "accrued") === "accrued").length;
  const postedCount  = buyLines.filter(l => l.status === "posted").length;

  const dashedBtn = (accent, disabled) => ({
    padding: "7px 12px", background: "none", cursor: disabled ? "not-allowed" : "pointer",
    border: `1px dashed ${accent ? HZ.violet + "55" : HZ.border}`, borderRadius: 6,
    fontFamily: HZ_BODY, fontSize: 12, color: accent ? HZ.violet : HZ.textMuted,
    opacity: disabled ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 5,
  });

  useHorizonFonts();

  return (
    <div id="shpacct-costs-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div id="shpacct-costs-stat-strip" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 16 }}>
        {[
          ["Lines", `${buyLines.length}`],
          ["Total Buy", fmtUsd(totalBuy)],
          ["From Contract", `${fromContractCount}`],
          ["Accrued", `${accruedCount}`],
          ["Posted", `${postedCount}`],
        ].map(([label, value]) => (
          <div key={label} style={{ background: HZ.bg, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow,
            borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontFamily: HZ_BODY, fontSize: 10, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontFamily: HZ_MONO, fontSize: 16, fontWeight: 700, color: HZ.text, marginTop: 2 }}>{value}</div>
          </div>
        ))}
      </div>

      {isCentral && latestSnapshot && (
        <div style={{ fontFamily: HZ_MONO, fontSize: 12, color: HZ.textMuted, marginBottom: 14 }}>
          Rates confirmed {new Date(latestSnapshot.generatedAt).toLocaleDateString()} ({latestSnapshot.reason})
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>Loading…</div>
      ) : buyLines.length === 0 && !canEdit ? (
        <div id="shpacct-costs-empty" style={{ padding: 48, textAlign: "center", fontFamily: HZ_BODY,
          fontSize: 13, color: HZ.textMuted, fontStyle: "italic",
          background: HZ.surface, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10 }}>
          No cost lines yet.
        </div>
      ) : (
        <div id="shpacct-costs-table" style={{ background: HZ.surface, backdropFilter: "blur(20px)",
          border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10, overflow: "hidden" }}>
          {buyLines.length === 0 ? (
            <div style={{ padding: "18px 16px", fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted, fontStyle: "italic" }}>
              No cost lines yet — add one below.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: HZ.bg, borderBottom: `1px solid ${HZ.border}` }}>
                  {["Type", "Charge", "Container", "Source", "Currency", "Exch. Rate", "Amount (USD)", "Status", ""].map((h, i) => (
                    <th key={h || i} style={{ textAlign: [5, 6].includes(i) ? "right" : "left", padding: "9px 14px",
                      fontFamily: HZ_BODY, fontSize: 10, fontWeight: 700, color: HZ.textMuted,
                      textTransform: "uppercase", letterSpacing: ".06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {buyLines.map(l => (
                  <CostLineRow key={l.id} line={l} containers={ctrs} showActions
                    onEdit={() => setLineModal(l)} onDelete={() => setConfirm(l.id)}
                    onActualize={() => setActualizeLine(l)} onPost={() => setConfirmPost(l)}
                    onAdjust={() => setAdjustLine(l)} />
                ))}
              </tbody>
            </table>
          )}
          {canEdit && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "10px 14px", borderTop: `1px solid ${HZ.border}` }}>
              <button id="shpacct-costs-history-btn" type="button" onClick={() => setHistOpen(true)} style={dashedBtn(false)}>
                <IconClipboard size={12} />History
              </button>
              {isCentral && !hasContractLines && (
                <button id="shpacct-costs-import-btn" type="button" onClick={() => setReconcileMode("import")} style={dashedBtn(false)}>
                  <IconArrowDown size={12} />Import from Contract
                </button>
              )}
              {isCentral && hasContractLines && (
                <>
                  <button id="shpacct-costs-reset-btn" type="button" onClick={() => openAction("reset")} style={dashedBtn(false)}>
                    <IconRefresh size={12} />Reset to Contract
                  </button>
                  <button id="shpacct-costs-update-btn" type="button" onClick={() => setReconcileMode("update")} style={dashedBtn(false)}>
                    <IconArrowUp size={12} />Update Carrier Costs
                  </button>
                </>
              )}
              <button id="shpacct-costs-add-btn" type="button" onClick={() => setLineModal("add")} style={dashedBtn(true)}>＋ Add Line</button>
            </div>
          )}
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
            <div style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted, lineHeight: 1.5 }}>
              {ACTION_COPY[actionModal].body}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn variant="secondary" onClick={() => setActionModal(null)} disabled={busy}>Cancel</Btn>
              <Btn onClick={runAction} disabled={busy}>{busy ? "Working…" : ACTION_COPY[actionModal].confirm}</Btn>
            </div>
          </div>
        </Modal>
      )}

      {reconcileMode && (
        <ReconcileCarrierCostsModal shipmentId={shipment.id} mode={reconcileMode} containerCount={ctrs.length}
          onClose={() => setReconcileMode(null)} onApplied={handleReconciled} />
      )}

      {histOpen && <CostLineHistoryModal shipmentId={shipment.id} onClose={() => setHistOpen(false)} />}

      {actualizeLine && (
        <CostLineActualizeModal line={actualizeLine} onClose={() => setActualizeLine(null)} onSave={handleActualize} />
      )}

      {adjustLine && (
        <CostLineAdjustModal line={adjustLine} onClose={() => setAdjustLine(null)} onSave={handleAdjust} />
      )}

      {confirmPost && (
        <ConfirmModal
          message={`Post this ${confirmPost.chargeCode} line? Posted lines are locked — any correction after this needs a new adjusting line, not an edit.`}
          onConfirm={handlePost}
          onCancel={() => setConfirmPost(null)} />
      )}

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
