import { useState, useEffect } from "react";
import { api } from "../api";
import { GPS_LOC_TYPE } from "../utils/legLocation";

// Resolves a port's name live (api.ports.get) whenever a caller has a real UN/LOCODE but no
// name for it yet — the same fallback PortCombobox's own selected chip already does on its own.
// Shared by ShipmentFormPage.jsx's LegRow (locked SEA leg rows, gated on `shouldResolve=locked`)
// and ShipmentDetailPage.jsx's RouteSummaryBar pill (gated on whether the relevant leg exists at
// all) — a leg written via Apply Sailing/Schedule Generator never carries a name of its own (the
// sailing/schedule data has none to give), so without this, either surface just shows the bare
// code forever. Clears immediately on every change, before fetching — not just when nothing will
// be fetched — so a code that changes from one nameless port to another nameless port never
// keeps showing the PREVIOUS port's resolved name while the new fetch is still in flight.
export default function useResolvedPortName(shouldResolve, code, name, locType) {
  const [resolved, setResolved] = useState("");
  useEffect(() => {
    setResolved("");
    if (!shouldResolve || locType === GPS_LOC_TYPE || !code || name) return;
    let live = true;
    api.ports.get(code).then(r => { if (live && r) setResolved(r.name || ""); }).catch(() => {});
    return () => { live = false; };
  }, [shouldResolve, code, name, locType]);
  return resolved;
}
