import { useState, useEffect, useCallback, useRef } from "react";
import Spinner, { PageSpinner } from "../../components/primitives/Spinner";
import { T } from "../../tokens";
import { inputBase } from "../../components/primitives/Form";
import { api } from "../../api";
import Badge from "../../components/primitives/Badge";
import Pagination from "../../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../../components/primitives/PageSizeSelect";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── MDM Locations: UN Location Codes Page ────────────────────────────────────

const MdmUNLocationCodesPage = () => {
  const [rows,     setRows]     = useState([]);
  const [total,    setTotal]    = useState(0);
  const [offset,   setOffset]   = useState(0);
  const [limit,    setLimit]    = useState(getStoredPageSize);
  const [search,   setSearch]   = useState("");
  const [loading,  setLoading]  = useState(true);
  const timer  = useRef(null);
  const { template, startResize } = useResizableColumns("mdm-unlocodes", [110,200,80,130,120]);
  const headers = ["UN/LOCODE","Port / Location Name","Country","Zone","Has Seaport?"];

  const load = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const res = await api.unlocodes.search({
        search: opts.search  !== undefined ? opts.search  : search,
        limit:  opts.limit   !== undefined ? opts.limit   : limit,
        offset: opts.offset  !== undefined ? opts.offset  : offset,
      });
      setRows(res.results);
      setTotal(res.total);
    } catch {}
    setLoading(false);
  }, [search, offset, limit]);

  useEffect(() => { load(); }, []);

  const handleSearch = v => {
    setSearch(v);
    setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 300);
  };

  const goPage = off => { setOffset(off); load({ offset: off }); };
  const changeLimit = n => { setLimit(n); setOffset(0); load({ limit: n, offset: 0 }); };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>UN Location Codes</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total.toLocaleString()} codes · 5-char identifiers cross-checked against seaport data
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Badge variant="success">✅ = Seaport in DB</Badge>
          <Badge variant="default">— = No seaport record</Badge>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search by UN/LOCODE (e.g. NLRTM, DEHAM)…"
          style={{ ...inputBase, fontFamily: T.mono, fontSize: 13, maxWidth: 380 }} />
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: template,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {headers.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < headers.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
            </div>
          ))}
        </div>
        {loading ? (
          <PageSpinner />
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            {search ? "No codes match your search." : "No data yet — run node import-mdm-data.js first."}
          </div>
        ) : rows.map(r => (
          <div key={r.unlocode}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{r.unlocode}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: r.name ? T.text : T.border, fontStyle: r.name ? "normal" : "italic" }}>
              {r.name || "Unknown"}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{r.countryCode || "—"}</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{r.zoneCode || "—"}</span>
            <span style={{ fontSize: 16 }}>{r.unlocode ? "✅" : <span style={{ color: T.border, fontFamily: T.mono, fontSize: 11 }}>—</span>}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <PageSizeSelect value={limit} onChange={changeLimit} />
        <div style={{ flex: 1 }}><Pagination total={total} offset={offset} limit={limit} onPage={goPage} /></div>
      </div>
    </div>
  );
};


// ─── Incoterms Modal ──────────────────────────────────────────────────────────

export default MdmUNLocationCodesPage;