import { useState, useEffect } from "react";
import { T, LANE_BADGE_VARIANT, diffDays, todayIso } from "../tokens";
import Badge from "../components/primitives/Badge";
import Pagination from "../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../components/primitives/PageSizeSelect";
import { useAuth } from "../AuthContext";
import { IconRefresh, IconClose } from "../components/primitives/Icon";
import ActionMenu from "../components/primitives/ActionMenu";

// ─── Lane pair (local — mirrors DashboardPage) ────────────────────────────────
const LanePair = ({ origin, dest }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    {origin
      ? <Badge variant={LANE_BADGE_VARIANT[origin] || "default"}>{origin}</Badge>
      : <span style={{ fontFamily: T.mono, fontSize: 12, color: T.border }}>—</span>}
    <span style={{ fontFamily: T.mono, fontSize: 16, color: T.textMuted, fontWeight: 700 }}>›</span>
    {dest
      ? <Badge variant={LANE_BADGE_VARIANT[dest] || "default"}>{dest}</Badge>
      : <span style={{ fontFamily: T.mono, fontSize: 12, color: T.border }}>—</span>}
  </div>
);

// ─── Expired label helper ─────────────────────────────────────────────────────
const expiredAgo = endDate => {
  const days = diffDays(endDate, todayIso());
  if (days <= 0)  return "Expired today";
  if (days < 30)  return `Expired ${days}d ago`;
  if (days < 365) return `Expired ${Math.round(days / 30)}mo ago`;
  return `Expired ${Math.round(days / 365)}y ago`;
};

// ─── DashboardArchive ─────────────────────────────────────────────────────────
// Pure display component — receives data and callbacks from DashboardPage.

const DashboardArchive = ({ allocations = [], carriers = [], onRenew, onDelete, standalone = false }) => {
  // Renewing/deleting an archived allocation is a space-config action — use the same
  // canManageConfigs gate SpaceConfigurationsPage uses, not the generic canEdit (which
  // incorrectly also granted occ_bk allocation-write rights here).
  const { canManageConfigs: canEdit } = useAuth();
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [limit,  setLimit]  = useState(getStoredPageSize);
  useEffect(() => { setOffset(0); }, [allocations.length]);
  const pageAllocs = allocations.slice(offset, offset + limit);

  if (!standalone && allocations.length === 0) return null;

  const COLS = "150px 1fr 100px 150px 130px 130px";
  const HEADERS = ["Carrier", "Name / Route", "TEU", "Effective Period", "Expired", "Actions"];
  const pager = allocations.length > 0 && (
    <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
      <PageSizeSelect value={limit} onChange={n => { setLimit(n); setOffset(0); }} />
      <div style={{ flex: 1 }}><Pagination total={allocations.length} offset={offset} limit={limit} onPage={setOffset} /></div>
    </div>
  );

  const tableContent = (
    <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`,
      overflow: "hidden", opacity: 0.85 }}>

      {/* Table header */}
      <div style={{ display: "grid", gridTemplateColumns: COLS,
        padding: "9px 20px", borderBottom: `1px solid ${T.border}`, background: T.bg }}>
        {HEADERS.map((h, i) => (
          <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
            color: T.border, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
        ))}
      </div>

      {allocations.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", fontFamily: T.body,
          fontSize: 14, color: T.textMuted, fontStyle: "italic" }}>
          No expired configurations yet.
        </div>
      ) : pageAllocs.map(a => {
        const carrier = carriers.find(c => c.code === a.carrierCode);
        return (
          <div key={a.id}
            style={{ display: "grid", gridTemplateColumns: COLS,
              padding: "12px 20px", borderBottom: `1px solid ${T.border}22`,
              alignItems: "center", transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted, fontWeight: 700 }}>{a.carrierCode}</span>
              {(a.originLane || a.destLane) && <div style={{ display: "flex" }}><LanePair origin={a.originLane} dest={a.destLane} /></div>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{carrier?.name || "—"}</span>
              {a.pol && a.pod && (
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>
                  {a.pol} <span style={{ color: T.border }}>›</span> {a.pod}
                </span>
              )}
              {a.notes && (
                <span style={{ fontFamily: T.body, fontSize: 11, color: T.border, fontStyle: "italic",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
                  {a.notes}
                </span>
              )}
            </div>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted }}>{a.allocatedTEU} TEU</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{a.effectiveDate}</span>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{a.endDate}</span>
            </div>
            <div>
              <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.border,
                background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5,
                padding: "2px 8px", whiteSpace: "nowrap" }}>
                {expiredAgo(a.endDate)}
              </span>
            </div>
            {canEdit && (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <ActionMenu items={[
                  { icon: IconRefresh, label: "Renew",  onClick: () => onRenew(a) },
                  { icon: IconClose,   label: "Delete", variant: "danger", onClick: () => onDelete(a.id) },
                ]} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  if (standalone) return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Archive</h1>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
          {allocations.length} expired space configuration{allocations.length !== 1 ? "s" : ""}
          · click <strong>Renew</strong> to create a new configuration based on an expired one
        </p>
      </div>
      {tableContent}
      {pager}
    </div>
  );

  return (
    <div style={{ marginTop: 20 }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
          background: "none", border: "none", cursor: "pointer", padding: "10px 0", textAlign: "left" }}>
        <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.textMuted }}>
          {open ? "▾" : "▸"} Archive
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          color: T.textMuted, background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 10, padding: "1px 8px" }}>
          {allocations.length}
        </span>
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>
          expired configuration{allocations.length !== 1 ? "s" : ""}
        </span>
      </button>
      {open && (
        <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`,
          overflow: "hidden", opacity: 0.85 }}>

          {/* Table header */}
          <div style={{ display: "grid", gridTemplateColumns: COLS,
            padding: "9px 20px", borderBottom: `1px solid ${T.border}`, background: T.bg }}>
            {HEADERS.map((h, i) => (
              <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
                color: T.border, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
            ))}
          </div>

          {/* Rows */}
          {pageAllocs.map(a => {
            const carrier = carriers.find(c => c.code === a.carrierCode);
            return (
              <div key={a.id}
                style={{ display: "grid", gridTemplateColumns: COLS,
                  padding: "12px 20px", borderBottom: `1px solid ${T.border}22`,
                  alignItems: "center", transition: "background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>

                {/* Carrier + lane pair */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted, fontWeight: 700 }}>
                    {a.carrierCode}
                  </span>
                  {(a.originLane || a.destLane) && (
                    <LanePair origin={a.originLane} dest={a.destLane} />
                  )}
                </div>

                {/* Name + POL→POD + notes */}
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                    {carrier?.name || "—"}
                  </span>
                  {a.pol && a.pod && (
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>
                      {a.pol} <span style={{ color: T.border }}>›</span> {a.pod}
                    </span>
                  )}
                  {a.notes && (
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.border,
                      fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis",
                      whiteSpace: "nowrap", maxWidth: 200 }}>
                      {a.notes}
                    </span>
                  )}
                </div>

                {/* TEU */}
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted }}>
                  {a.allocatedTEU} TEU
                </span>

                {/* Effective period */}
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{a.effectiveDate}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{a.endDate}</span>
                </div>

                {/* Expired badge */}
                <div>
                  <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600,
                    color: T.border, background: T.bg,
                    border: `1px solid ${T.border}`, borderRadius: 5, padding: "2px 8px",
                    whiteSpace: "nowrap" }}>
                    {expiredAgo(a.endDate)}
                  </span>
                </div>

                {/* Actions */}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <ActionMenu items={[
                    { icon: IconRefresh, label: "Renew",  onClick: () => onRenew(a) },
                    { icon: IconClose,   label: "Delete", variant: "danger", onClick: () => onDelete(a.id) },
                  ]} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {open && pager}
    </div>
  );
};

export default DashboardArchive;