import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { IconRoute, IconFlag, IconHashtag } from "../../components/primitives/Icon";

// ─── Locations (hub) ──────────────────────────────────────────────────────────
// Landing page for the trade-geography Master Data registries — trade lanes, countries, UN
// location codes. A clickable nav page rather than a plain section header, per direct request
// (same pattern as the Equipment and Finance hubs) — each card below is the "button to access
// it directly", and the sidebar keeps its own direct links to all three too.

const LocationCard = ({ icon: IconComp, title, description, count, onClick }) => (
  <div onClick={onClick}
    style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 24,
      cursor: "pointer", display: "flex", flexDirection: "column", gap: 12, transition: "border-color .12s, transform .12s" }}
    onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.transform = "translateY(-2px)"; }}
    onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.transform = "translateY(0)"; }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: T.accentBg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <IconComp size={20} color={T.accent} />
      </div>
      {count != null && (
        <span style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 800, color: T.text }}>{count.toLocaleString()}</span>
      )}
    </div>
    <div>
      <div style={{ fontFamily: T.head, fontSize: 16, fontWeight: 700, color: T.text }}>{title}</div>
      <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginTop: 4, lineHeight: 1.4 }}>{description}</div>
    </div>
  </div>
);

const MdmLocationsPage = ({ navigate }) => {
  const [counts, setCounts] = useState({ tradeLanes: null, countries: null, unlocodes: null });

  useEffect(() => {
    Promise.all([
      api.tradeLanes.list().catch(() => []),
      api.countries.list({ limit: 1 }).catch(() => ({ total: null })),
      api.unlocodes.search({ limit: 1 }).catch(() => ({ total: null })),
    ]).then(([tradeLanes, countries, unlocodes]) => {
      setCounts({ tradeLanes: tradeLanes.length, countries: countries.total, unlocodes: unlocodes.total });
    });
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Locations</h1>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
          Trade lanes, countries, and the UN/LOCODE port registry
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        <LocationCard
          icon={IconRoute}
          title="Trade Lanes"
          description="FIATA high-level trade lanes (e.g. EU-N, NAM) — the geography behind every shipment's own Trade Lane field and lane-scoped reporting."
          count={counts.tradeLanes}
          onClick={() => navigate("mdm-tradelanes")}
        />
        <LocationCard
          icon={IconFlag}
          title="Countries"
          description="ISO 3166-1 countries, with port count and trade lane assignments."
          count={counts.countries}
          onClick={() => navigate("mdm-countries")}
        />
        <LocationCard
          icon={IconHashtag}
          title="UN Location Codes"
          description="The full UN/LOCODE port registry backing every port picker in the app."
          count={counts.unlocodes}
          onClick={() => navigate("mdm-unlocodes")}
        />
      </div>
    </div>
  );
};

export default MdmLocationsPage;
