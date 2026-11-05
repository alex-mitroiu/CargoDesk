import { useState, useEffect } from "react";
import { api } from "../api";
import { lineChain } from "../utils/routingLines";

// The transshipment ports of a contract routing line, in sailing order — [] for a direct line, null
// when there's no line to follow (no contract or no routing recorded, or it can't be loaded), in which
// case the sailing search shows every sailing (src/utils/sailingRouting.js).
export default function useContractLineHubs(contractId, routingId) {
  const [hubs, setHubs] = useState(null);
  useEffect(() => {
    if (!contractId || !routingId) { setHubs(null); return; }
    let live = true;
    api.contracts.get(contractId)
      .then(c => {
        if (!live) return;
        const chain = lineChain((c?.legs || []).filter(l => l.routingId === routingId));
        setHubs(chain ? chain.hubs : null);
      })
      .catch(() => { if (live) setHubs(null); });
    return () => { live = false; };
  }, [contractId, routingId]);
  return hubs;
}
