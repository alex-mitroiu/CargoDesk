import { useState, useEffect, useCallback, useRef } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import Badge from "../../components/primitives/Badge";
import Pagination from "../../components/primitives/Pagination";
import { PageSpinner } from "../../components/primitives/Spinner";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

const LIMIT = 50;

const PROGRAM_COLORS = {
  "SDGT":    "danger",
  "NPWMD":   "danger",
  "IRAN":    "warning",
  "UKRAINE": "warning",
  "RUSSIA":  "warning",
  "CYBER":   "info",
  "DPRK":    "danger",
  "SYRIA":   "warning",
  "CUBA":    "amber",
};

const programBadge = prog => {
  const key = Object.keys(PROGRAM_COLORS).find(k => prog.toUpperCase().includes(k));
  return key ? PROGRAM_COLORS[key] : "default";
};

const MdmSanctionedCustomersPage = () => {
  const [results,  setResults]  = useState([]);
  const [total,    setTotal]    = useState(0);
  const [offset,   setOffset]   = useState(0);
  const [search,   setSearch]   = useState("");
  const [loading,  setLoading]  = useState(true);
  const [synced,   setSynced]   = useState(null);
  const timer = useRef(null);

  const { template, startResize } = useResizableColumns("mdm-sanctioned", [300, 100, 260, 80, 90]);
  const headers = ["Entity Name", "Type", "Programs", "Ref ID", "Source"];

  const load = useCallback(async (opts = {}) => {
    const s   = opts.search !== undefined ? opts.search  : search;
    const off = opts.offset !== undefined ? opts.offset  : offset;
    setLoading(true);
    try {
      const [r, st] = await Promise.all([
        api.sanctions.entries({ search: s, limit: LIMIT, offset: off }),
        api.sanctions.status(),
      ]);
      setResults(r.results || []);
      setTotal(r.total ?? 0);
      const sync = (st.syncs || [])[0];
      setSynced(sync ? new Date(sync.synced_at).toLocaleString("en-GB") : null);
    } catch { setResults([]); setTotal(0); }
    setLoading(false);
  }, [search, offset]);

  useEffect(() => { load({ search: "", offset: 0 }); }, []);

  const handleSearch = v => {
    setSearch(v);
    setOffset(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load({ search: v, offset: 0 }), 300);
  };

  const goPage = off => { setOffset(off); load({ offset: off }); };

  const th = {
    position: "relative", paddingLeft: 6,
    fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>
            Sanctioned Customers
          </h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {total.toLocaleString()} entr{total !== 1 ? "ies" : "y"} · OFAC SDN list · read-only
            {synced && <span style={{ marginLeft: 10, color: T.border }}>· Last sync {synced}</span>}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.danger, fontWeight: 700,
            background: "#ef444415", border: "1px solid #ef444444",
            borderRadius: 6, padding: "4px 10px", letterSpacing: ".04em" }}>
            🔴 OFAC SDN
          </span>
        </div>
      </div>

      {total === 0 && !loading && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}44`, borderRadius: 8,
          padding: "12px 16px", fontFamily: T.body, fontSize: 13, color: T.warning, marginBottom: 16 }}>
          No sanctions data loaded. Import the OFAC SDN list via <strong>Application Settings → API Controls → External APIs → OFAC SDN</strong>.
        </div>
      )}

      {/* Search */}
      <div style={{ marginBottom: 14 }}>
        <input value={search} onChange={e => handleSearch(e.target.value)}
          placeholder="Search by entity name or program…"
          style={{ fontFamily: T.body, fontSize: 14, color: T.text, background: T.bg,
            border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 14px",
            outline: "none", maxWidth: 420, width: "100%" }} />
      </div>

      {/* Table */}
      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        {/* Header row */}
        <div style={{ display: "grid", gridTemplateColumns: template,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {headers.map((h, i) => (
            <div key={i} style={th}>
              {h}
              {i < headers.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
            </div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 48 }}><PageSpinner /></div>
        ) : results.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted,
            fontFamily: T.body, fontSize: 14, fontStyle: "italic" }}>
            {search ? "No entries match your search." : "No sanctions data imported yet."}
          </div>
        ) : results.map(e => {
          const programs = (e.program || "").split(";").map(p => p.trim()).filter(Boolean);
          return (
            <div key={e.id}
              style={{ display: "grid", gridTemplateColumns: template,
                padding: "11px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                transition: "background .1s" }}
              onMouseEnter={ev => ev.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={ev => ev.currentTarget.style.background = "transparent"}>

              {/* Entity name */}
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.entity_name}
              </span>

              {/* Type */}
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                {e.entity_type || "—"}
              </span>

              {/* Programs */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {programs.length > 0
                  ? programs.slice(0, 3).map((p, i) => (
                      <Badge key={i} variant={programBadge(p)}>{p}</Badge>
                    ))
                  : <span style={{ color: T.border }}>—</span>}
                {programs.length > 3 && (
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                    +{programs.length - 3}
                  </span>
                )}
              </div>

              {/* Ref ID */}
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                {e.ref_id || "—"}
              </span>

              {/* Source */}
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                color: T.danger, background: "#ef444410", borderRadius: 4,
                padding: "2px 6px", display: "inline-block" }}>
                {e.source}
              </span>
            </div>
          );
        })}
      </div>

      {total > LIMIT && (
        <div style={{ marginTop: 16 }}>
          <Pagination total={total} limit={LIMIT} offset={offset} onPage={goPage} />
        </div>
      )}
    </div>
  );
};

export default MdmSanctionedCustomersPage;
