import { useState, useEffect } from "react";
import { api } from "../../api";
import GpBreakdownPanel from "../../components/shared/GpBreakdownPanel";

// ─── Shipment GP Overview Page ────────────────────────────────────────────
// Read-only derived aggregation of Cost Entry (BUY) + Invoice Entry (SELL) lines.
// TKT-83O41G (TKT-6QT30S phase 2): Estimated GP vs Actual GP vs Variance, split by charge
// code. "By office" is shown as shipment-level EMO/IMO context rather than a real per-line
// breakdown dimension — cost lines aren't tagged with an office_id. The actual breakdown
// rendering (stat cards, Profit Breakdown Sankey, CPI/charge-code tables) lives in the shared
// GpBreakdownPanel — see that file for why (ReportsPage.jsx's region/country aggregates reuse
// it unchanged over a differently-scoped lines array).
const ShipmentAccountingGpPage = ({ shipment, onBack }) => {
  const [lines,   setLines]   = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    return api.costLines.list(shipment.id).then(setLines).catch(() => setLines([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [shipment.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div id="shpacct-gp-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <GpBreakdownPanel
        lines={lines}
        loading={loading}
        contextNode={<>read-only · EMO {shipment.emoOfficeName || "—"} · IMO {shipment.imoOfficeName || "—"}</>}
      />
    </div>
  );
};

export default ShipmentAccountingGpPage;
