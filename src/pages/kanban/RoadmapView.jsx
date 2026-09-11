import { T } from "../../tokens";
import Badge from "../../components/primitives/Badge";
import { TYPE_ICON, TYPE_VARIANT } from "./constants";

// ─── Roadmap View ─────────────────────────────────────────────────────────────
// Version swim-lanes: each version is a row with tickets grouped inside.

const DONE_STATUSES = new Set(["Done", "Ready to Deploy", "Released"]);

const RoadmapView = ({ tickets, versions, onPreview, onManageVersions }) => {
  if (versions.length === 0) return (
    <div style={{ padding: "60px 24px", textAlign: "center", fontFamily: T.body, fontSize: 14, color: T.textMuted }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🏷</div>
      <div style={{ fontWeight: 600, color: T.text, marginBottom: 6 }}>No versions defined</div>
      <div style={{ marginBottom: 16 }}>Create a version to organise your roadmap.</div>
      <button type="button" onClick={onManageVersions}
        style={{ fontFamily: T.body, fontSize: 13, color: T.accent, background: "none",
          border: `1px dashed ${T.accent}55`, borderRadius: 7, padding: "8px 18px", cursor: "pointer" }}>
        ＋ Add Version
      </button>
    </div>
  );

  const versionTickets = verId => tickets.filter(t => t.versionId === verId);
  const unversioned = tickets.filter(t => !t.versionId);

  const VER_STATUS_COLOR = {
    "Planning": T.textMuted, "In Development": T.accent,
    "Released": T.success, "Archived": T.border,
  };

  const VersionLane = ({ ver, tix }) => {
    const done = tix.filter(t => DONE_STATUSES.has(t.status)).length;
    const pct  = tix.length > 0 ? Math.round(done / tix.length * 100) : 0;
    return (
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        overflow: "hidden", marginBottom: 16 }}>
        {/* Lane header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 18px",
          borderBottom: `1px solid ${T.border}`, background: T.bg }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>{ver.name}</span>
              <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
                color: VER_STATUS_COLOR[ver.status] || T.textMuted,
                background: `${VER_STATUS_COLOR[ver.status] || T.border}18`,
                border: `1px solid ${VER_STATUS_COLOR[ver.status] || T.border}33` }}>
                {ver.status}
              </span>
              {ver.releaseDate && (
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>📅 {ver.releaseDate}</span>
              )}
            </div>
            {tix.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                <div style={{ height: 5, flex: 1, borderRadius: 3, background: T.border, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, borderRadius: 3,
                    background: pct === 100 ? T.success : T.accent, transition: "width .3s" }} />
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, flexShrink: 0 }}>
                  {done}/{tix.length} · {pct}%
                </span>
              </div>
            )}
          </div>
        </div>
        {/* Tickets */}
        {tix.length === 0 ? (
          <div style={{ padding: "16px 18px", fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
            No tickets assigned to this version.
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 14 }}>
            {tix.map(t => {
              const done = DONE_STATUSES.has(t.status);
              return (
                <div key={t.id} onClick={() => onPreview?.(t)}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px",
                    borderRadius: 7, background: T.bg, border: `1px solid ${done ? T.success + "44" : T.border}`,
                    cursor: "pointer", opacity: done ? 0.7 : 1, transition: "background .1s",
                    minWidth: 0, maxWidth: 260 }}
                  onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                  onMouseLeave={e => e.currentTarget.style.background = T.bg}>
                  <span style={{ fontSize: 12, flexShrink: 0 }}>{done ? "✓" : (TYPE_ICON[t.type] || "📋")}</span>
                  <Badge variant={TYPE_VARIANT[t.type] || "default"}>{t.type}</Badge>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: T.body, fontSize: 12, color: T.text, fontWeight: 500,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      textDecoration: done ? "line-through" : "none" }}>
                      {t.title}
                    </div>
                    <div style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, marginTop: 1 }}>
                      {t.id} · {t.status}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ overflowY: "auto", paddingBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button type="button" onClick={onManageVersions}
          style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
            border: `1px solid ${T.accent}44`, borderRadius: 7, padding: "5px 12px", cursor: "pointer" }}>
          ＋ Add Version
        </button>
      </div>
      {versions.map(ver => (
        <VersionLane key={ver.id} ver={ver} tix={versionTickets(ver.id)} />
      ))}
      {unversioned.length > 0 && (
        <VersionLane
          ver={{ id: "__unversioned__", name: "Unversioned", status: "Planning" }}
          tix={unversioned}
        />
      )}
    </div>
  );
};

export default RoadmapView;
