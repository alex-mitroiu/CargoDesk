import { useState, useEffect, useCallback, useRef } from "react";
import { T } from "../../tokens";
import { inputBase } from "../primitives/Form";
import { api } from "../../api";
import Badge from "../primitives/Badge";
import { Modal } from "../primitives/Modal";
import Pagination from "../primitives/Pagination";

// ─── Shared: Country Locations Modal ──────────────────────────────────────────
// Read-only popup listing all UN Location Codes + port names for a given country.

const CountryLocationsModal = ({ country, onClose }) => {
  const [rows,    setRows]    = useState([]);
  const [total,   setTotal]   = useState(0);
  const [offset,  setOffset]  = useState(0);
  const [search,  setSearch]  = useState("");
  const [loading, setLoading] = useState(true);
  const LIMIT = 50;
  const timer  = useRef(null);

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const res = await api.countryLocations.list(country.iso2, {
        search: opts.search  !== undefined ? opts.search  : search,
        limit:  LIMIT,
        offset: opts.offset  !== undefined ? opts.offset  : offset,
      });
      setRows(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [country.iso2, search, offset]);

  useEffect(() => { load(); }, []);

  const handleSearch = v => {
    setSearch(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 280);
  };
  const goPage = off => { setOffset(off); load({ offset: off }); };

  return (
    <Modal title={`Locations — ${country.name} (${country.iso2})`} onClose={onClose} width={660}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search by UN/LOCODE or location name…"
          style={{ ...inputBase, fontFamily: T.body, fontSize: 14 }} />

        <div style={{ background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 100px",
            padding: "9px 16px", borderBottom: `1px solid ${T.border}` }}>
            {["UN/LOCODE", "Location Name", "Zone"].map((h, i) => (
              <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
            ))}
          </div>
          {loading ? (
            <div style={{ padding: 32, textAlign: "center", color: T.textMuted, fontFamily: T.body }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
              {search ? "No locations match your search." : "No port locations found for this country."}
            </div>
          ) : rows.map(p => (
            <div key={p.unlocode}
              style={{ display: "grid", gridTemplateColumns: "100px 1fr 100px",
                padding: "10px 16px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{p.unlocode}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{p.name}</span>
              <Badge>{p.zoneCode || "—"}</Badge>
            </div>
          ))}
        </div>
        <Pagination total={total} offset={offset} limit={LIMIT} onPage={goPage} />
      </div>
    </Modal>
  );
};

export default CountryLocationsModal;