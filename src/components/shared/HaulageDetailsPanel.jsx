import { useState, useEffect } from "react";
import { T, CURRENCIES } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import { Inp, Sel, Textarea } from "../primitives/Form";

// ─── Merchant's Haulage details of one container's run ─────────────────────────────────────────────────────────────
// Opened in a Modal from the Pickup / Delivery page (HaulageServicePage.jsx), per container: the driver, the truck's plate,
// the instructions printed on the trucker's plan and the haulage cost (a BUY cost line, source merchant_haulage). The run's
// places and times are its stops on the page (2026-11-20, ARCHITECTURE.md §8.56): the old free-text waypoints and the one
// gate in/out pair moved onto the stops (decision G); a gate time that had no stop to go to is shown here, read-only.

const CURRENCY_OPTIONS = CURRENCIES.map(c => ({ value: c, label: c }));

const HaulageDetailsPanel = ({ shipmentId, serviceId, containerId, record, canEdit, onRecordUpdated }) => {
  const [driverName, setDriverName]     = useState(record.driverName || "");
  const [driverIdNumber, setDriverIdNumber] = useState(record.driverIdNumber || "");
  const [truckPlate, setTruckPlate]     = useState(record.truckPlate || "");
  const [instructions, setInstructions] = useState(record.instructions || "");
  const [costAmount, setCostAmount]     = useState(record.costAmount != null ? String(record.costAmount) : "");
  const [costCurrency, setCostCurrency] = useState(record.costCurrency || "USD");
  const [costExchangeRate, setCostExchangeRate] = useState(String(record.costExchangeRate ?? 1));
  const [costLineId, setCostLineId]     = useState(record.costLineId || "");
  const [fxRates, setFxRates] = useState({});
  const [savingField, setSavingField] = useState(null);

  useEffect(() => { api.fx.rates().then(setFxRates).catch(() => {}); }, []);

  // Only the field changed is sent: the server keeps the rest.
  const savePlain = async patch => {
    setSavingField(Object.keys(patch)[0]);
    try {
      await api.haulage.update(shipmentId, serviceId, containerId, patch);
      onRecordUpdated?.();
    } catch (e) { toast.error(e.message || "Failed to save"); }
    setSavingField(null);
  };

  const handleCostCurrency = c => {
    setCostCurrency(c);
    if (c === "USD") { setCostExchangeRate("1"); return; }
    const rate = fxRates[c];
    if (rate) setCostExchangeRate(String(Math.round((1 / rate) * 100000) / 100000));
  };

  const saveCost = async () => {
    setSavingField("cost");
    try {
      const updated = await api.haulage.saveCost(shipmentId, serviceId, containerId, {
        amount: costAmount === "" ? null : Number(costAmount),
        currency: costCurrency, exchangeRate: Number(costExchangeRate) || 1,
      });
      setCostLineId(updated.costLineId || "");
      onRecordUpdated?.();
      toast.success(updated.costLineId ? "Cost saved: BUY cost line created or updated" : "Cost cleared");
    } catch (e) { toast.error(e.message || "Failed to save cost"); }
    setSavingField(null);
  };

  const lbl = { fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
    textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 };
  const earlier = record.earlierGate;

  return (
    <div data-testid="haulage-details-panel" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={lbl}>Driver and truck</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Inp label="Driver name" value={driverName} disabled={!canEdit} id="haulage-driver-name"
            onChange={setDriverName} onBlur={() => driverName !== (record.driverName || "") && savePlain({ driverName })} />
          <Inp label="Driver ID number" value={driverIdNumber} disabled={!canEdit} mono
            onChange={setDriverIdNumber} onBlur={() => driverIdNumber !== (record.driverIdNumber || "") && savePlain({ driverIdNumber })} />
          <Inp label="Truck plate" value={truckPlate} disabled={!canEdit} mono id="haulage-truck-plate"
            onChange={setTruckPlate} onBlur={() => truckPlate !== (record.truckPlate || "") && savePlain({ truckPlate })} />
        </div>
      </div>

      <div>
        <div style={lbl}>Instructions for the trucker</div>
        <Textarea value={instructions} disabled={!canEdit} placeholder="Printed on the trucker's plan for this container…"
          onChange={setInstructions} rows={3} />
        {canEdit && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <Btn size="sm" variant="secondary" disabled={savingField === "instructions"} onClick={() => savePlain({ instructions })}>
              {savingField === "instructions" ? "Saving…" : "Save instructions"}
            </Btn>
          </div>
        )}
      </div>

      <div>
        <div style={lbl}>Cost</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Inp label="Amount" value={costAmount} disabled={!canEdit} type="number"
            onChange={setCostAmount} placeholder="Leave blank to clear" />
          <Sel label="Currency" value={costCurrency} disabled={!canEdit}
            onChange={handleCostCurrency} options={CURRENCY_OPTIONS} />
          {costCurrency !== "USD" && (
            <Inp label="Exchange rate → USD" value={costExchangeRate} disabled={!canEdit} type="number"
              onChange={setCostExchangeRate} />
          )}
        </div>
        {canEdit && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <Btn size="sm" disabled={savingField === "cost"} onClick={saveCost}>
              {savingField === "cost" ? "Saving…" : "Save cost"}
            </Btn>
          </div>
        )}
        {costLineId && (
          <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.success, marginTop: 6 }}>
            → BUY cost line {costLineId}
          </div>
        )}
      </div>

      {earlier && (
        <div data-testid="haulage-earlier-gate" style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
          Recorded before the stops: gate out {earlier.gateOutAt || "—"}, gate in {earlier.gateInAt || "—"}. Type them as a stop's actual times to keep them on the plan.
        </div>
      )}
    </div>
  );
};

export default HaulageDetailsPanel;
