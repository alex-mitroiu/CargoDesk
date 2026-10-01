import { useEffect, useState } from "react";
import { api } from "../api";

// "9999 · FAK (Freight All Kinds), 001404 · Electronics, …" for a comma-separated list of
// commodity registry codes (a contract's commodity types, or one shipment commodity code).
// Codes the registry doesn't know are shown as they are.
export default function useCommodityLabel(codes) {
  const key = String(codes || "");
  const [label, setLabel] = useState(key);
  useEffect(() => {
    const list = key.split(/[\s,]+/).filter(Boolean);
    if (!list.length) { setLabel(""); return undefined; }
    let live = true;
    Promise.all(list.map(c => api.commodities.get(c).then(r => `${c} · ${r.description}`).catch(() => c)))
      .then(parts => { if (live) setLabel(parts.join(", ")); });
    return () => { live = false; };
  }, [key]);
  return label;
}
