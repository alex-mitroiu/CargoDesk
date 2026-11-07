import { useEffect, useState } from "react";
import { api } from "../../../api";

// Name and coordinates of each UN/LOCODE, from the port master data (api.ports.get). One request per code
// for the whole session (a module-level cache), so the route rail, the hero and the globe can each ask freely.
// Returns { [code]: { name, lat, lon } } with only the codes resolved so far.
const cache = new Map(); // code → Promise<{ name, lat, lon } | null>

const lookup = code => {
  if (!cache.has(code)) {
    cache.set(code, api.ports.get(code)
      .then(p => (p ? { name: p.name || "", lat: num(p.latitude), lon: num(p.longitude) } : null))
      .catch(() => null));
  }
  return cache.get(code);
};
const num = v => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

export default function usePorts(codes) {
  const key = [...new Set((codes || []).filter(Boolean).map(c => String(c).toUpperCase()))].sort().join(",");
  const [ports, setPorts] = useState({});
  useEffect(() => {
    let live = true;
    const list = key ? key.split(",") : [];
    Promise.all(list.map(c => lookup(c).then(p => [c, p]))).then(rows => {
      if (live) setPorts(Object.fromEntries(rows.filter(([, p]) => p)));
    });
    return () => { live = false; };
  }, [key]);
  return ports;
}
