import { useState } from "react";
import { T } from "../../tokens";
import { inputBase } from "../../components/primitives/Form";
import Badge from "../../components/primitives/Badge";
import { TYPE_ICON, PARENT_TYPES } from "./constants";

// ─── Parent Picker Modal ──────────────────────────────────────────────────────
// Full-screen picker for selecting a parent Epic or Story.
// Supports free-text search across title + ID, and one-click type filtering.


const ParentPickerModal = ({ tickets = [], excludeId, onSelect, onClose, allowedTypes = PARENT_TYPES, initialTypeFilter = "" }) => {
  const [search,     setSearch]     = useState("");
  const [typeFilter, setTypeFilter] = useState(initialTypeFilter);

  const q = search.trim().toLowerCase();
  const TYPE_ORDER = { "Test Plan": 0, "Test Run": 1, Epic: 2, Story: 3 };
  const results = tickets
    .filter(t =>
      t.id !== excludeId &&
      allowedTypes.includes(t.type) &&
      (typeFilter === "" || t.type === typeFilter) &&
      (q.length === 0 ||
        t.id.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q))
    )
    .sort((a, b) => {
      const orderDiff = (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9);
      return orderDiff !== 0 ? orderDiff : a.title.localeCompare(b.title);
    });

  const btnBase = active => ({
    fontFamily: T.body, fontSize: 12, fontWeight: active ? 700 : 400,
    padding: "4px 12px", borderRadius: 6, cursor: "pointer", border: "none",
    background: active ? T.accent : T.surface,
    color:      active ? "#fff"   : T.textMuted,
    transition: "background .12s, color .12s",
  });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10000,
      background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: 560, maxHeight: "80vh", background: T.surface,
        border: `1px solid ${T.border}`, borderRadius: 14,
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "0 20px 60px rgba(0,0,0,.4)" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 18px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
            Select Parent
          </span>
          <button onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 20, lineHeight: 1, padding: "0 2px" }}>×</button>
        </div>

        {/* Search + type filter */}
        <div style={{ padding: "12px 18px", borderBottom: `1px solid ${T.border}`, flexShrink: 0,
          display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            autoFocus
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by type, ID, title, or keywords…"
            style={{ ...inputBase, fontFamily: T.body, fontSize: 13,
              width: "100%", boxSizing: "border-box" }} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(allowedTypes.length > 1 ? ["", ...allowedTypes] : allowedTypes).map(t => (
              <button key={t} type="button"
                onClick={() => setTypeFilter(t)}
                style={btnBase(typeFilter === t)}>
                {t === "" ? "All" : `${TYPE_ICON[t] || ""} ${t}`}
              </button>
            ))}
            <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 11,
              color: T.textMuted, alignSelf: "center" }}>
              {results.length} result{results.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>

        {/* Results list */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {results.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", fontFamily: T.body,
              fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
              No {typeFilter || allowedTypes.join(" or ")} match your search.
            </div>
          ) : results.map((t, i) => (
            <div key={t.id}
              onClick={() => { onSelect(t); onClose(); }}
              style={{ display: "flex", alignItems: "center", gap: 10,
                padding: "11px 18px", cursor: "pointer",
                borderBottom: i < results.length - 1 ? `1px solid ${T.border}22` : "none",
                transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>{TYPE_ICON[t.type] || "📋"}</span>
              <Badge variant={TYPE_VARIANT[t.type] || "default"}>{t.type}</Badge>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, flexShrink: 0 }}>
                {t.id}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 500,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.title}
                </div>
                {t.description && (
                  <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                    {t.description}
                  </div>
                )}
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
                background: T.bg, border: `1px solid ${T.border}`,
                borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>
                {t.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ParentPickerModal;
