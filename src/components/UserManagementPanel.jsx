import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import { Modal } from "./primitives/Modal";
import Btn from "./primitives/Btn";

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_ROLES = ["admin", "operator", "occ_bk", "viewer"];
const ROLE_RANK = { viewer: 0, occ_bk: 1, operator: 2, admin: 3 };
const ROLE_COLORS = {
  admin:    { bg: "#3b82f618", text: "#3b82f6",  border: "#3b82f644" },
  operator: { bg: "#10b98118", text: "#10b981",  border: "#10b98144" },
  occ_bk:   { bg: "#f59e0b18", text: "#f59e0b",  border: "#f59e0b44" },
  viewer:   { bg: T.border + "30", text: T.textMuted, border: T.border },
};
const ROLE_LABELS = { admin: "Admin", operator: "Operator", occ_bk: "OCC Booking", viewer: "Viewer" };
const ROLE_DESCRIPTIONS = {
  admin:    "Full system access including user management",
  operator: "Manage shipments, configs & MDM",
  occ_bk:   "Place bookings and manage customers",
  viewer:   "Read-only access to all data",
};

// Roles where data scoping applies (admin and viewer are always unrestricted)
const SCOPED_ROLES = ["occ_bk", "operator"];

const primaryRole = (roles) =>
  [...(roles || [])].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0] || "viewer";

// ─── Shared primitives ────────────────────────────────────────────────────────

const inputStyle = () => ({
  width: "100%", padding: "7px 11px", borderRadius: 7,
  border: `1px solid ${T.border}`, background: T.bg,
  fontFamily: T.body, fontSize: 12, color: T.text,
  outline: "none", boxSizing: "border-box",
});

const FieldLabel = ({ children }) => (
  <div style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".09em", marginBottom: 5 }}>
    {children}
  </div>
);

const RoleBadge = ({ role }) => {
  const c = ROLE_COLORS[role] || ROLE_COLORS.viewer;
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 20,
      fontFamily: T.mono, fontSize: 10, fontWeight: 600,
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
    }}>
      {ROLE_LABELS[role] || role}
    </span>
  );
};

// ─── Configure Roles modal ────────────────────────────────────────────────────

const ConfigureRolesModal = ({ user, onSave, onClose }) => {
  const [selectedRoles, setSelectedRoles] = useState(user.roles ?? ["viewer"]);
  const [saving, setSaving] = useState(false);

  const toggle = (role) =>
    setSelectedRoles(prev =>
      prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
    );

  const handleSave = async () => {
    if (!selectedRoles.length) return toast.warning("At least one role must be selected");
    setSaving(true);
    try {
      await onSave({ roles: selectedRoles });
      toast.success("Roles updated");
      onClose();
    } catch (e) {
      toast.error(e.message || "Failed to save");
    } finally { setSaving(false); }
  };

  return (
    <Modal title={`Roles — ${user.name}`} onClose={onClose} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {ALL_ROLES.map((role, i) => {
          const active = selectedRoles.includes(role);
          const c = ROLE_COLORS[role];
          return (
            <div key={role} onClick={() => toggle(role)} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "13px 16px", borderRadius: 9, cursor: "pointer",
              border: `1px solid ${active ? c.border : T.border}`,
              background: active ? c.bg : "transparent",
              transition: "background .15s, border-color .15s",
              gap: 14,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                  color: active ? c.text : T.text, marginBottom: 2 }}>
                  {ROLE_LABELS[role]}
                </div>
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                  {ROLE_DESCRIPTIONS[role]}
                </div>
              </div>
              {/* Toggle switch */}
              <div style={{
                width: 42, height: 24, borderRadius: 12, flexShrink: 0,
                background: active ? c.text : T.border,
                position: "relative", transition: "background .2s",
              }}>
                <div style={{
                  width: 18, height: 18, borderRadius: "50%", background: "#fff",
                  position: "absolute", top: 3,
                  left: active ? 21 : 3,
                  transition: "left .2s",
                  boxShadow: "0 1px 3px rgba(0,0,0,.3)",
                }} />
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <Btn variant="ghost" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save Roles"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Scope transfer-list column ───────────────────────────────────────────────

const ColHeader = ({ children, count }) => (
  <div style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6,
    display: "flex", alignItems: "center", justifyContent: "space-between" }}>
    <span>{children}</span>
    {count != null && (
      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent,
        background: T.accent + "18", borderRadius: 10, padding: "1px 7px" }}>
        {count}
      </span>
    )}
  </div>
);

const ItemRow = ({ label, sublabel, onClick, onRemove, applied, checked, onCheck }) => (
  <div onClick={onCheck}
    style={{
      display: "flex", alignItems: "center",
      padding: "5px 8px", borderRadius: 6, marginBottom: 3, gap: 6,
      border: `1px solid ${checked ? (applied ? T.danger + "66" : T.accent + "77") : applied ? T.accent + "33" : T.border}`,
      background: checked ? (applied ? T.danger + "14" : T.accent + "18") : applied ? T.accent + "07" : T.bg,
      cursor: onCheck ? "pointer" : "default", transition: "background .1s, border-color .1s",
    }}>
    {onCheck && (
      <input type="checkbox" checked={!!checked} readOnly
        onClick={e => e.stopPropagation()}
        style={{ width: 13, height: 13, cursor: "pointer", flexShrink: 0, accentColor: applied ? T.danger : T.accent }} />
    )}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 600,
        color: applied ? T.accent : T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </div>
      {sublabel && (
        <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {sublabel}
        </div>
      )}
    </div>
    {applied ? (
      <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{
        padding: "2px 7px", borderRadius: 5, border: `1px solid ${T.danger}44`,
        background: T.danger + "10", color: T.danger, fontFamily: T.body, fontSize: 10,
        cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap",
      }}>−</button>
    ) : (
      <button onClick={e => { e.stopPropagation(); onClick(); }} style={{
        padding: "2px 9px", borderRadius: 5, border: `1px solid ${T.accent}44`,
        background: T.accent + "10", color: T.accent, fontFamily: T.body, fontSize: 11,
        cursor: "pointer", flexShrink: 0, fontWeight: 700,
      }}>+</button>
    )}
  </div>
);

// ─── Bulk controls (middle divider column) ────────────────────────────────────

const SectionControls = ({ onAddAll, onAddSelected, onRemoveSelected, onRemoveAll,
  availSelCount, appliedSelCount, availCount, appliedCount }) => {
  const btn = (label, handler, color, disabled) => (
    <button key={label} onClick={handler} disabled={disabled} title={label} style={{
      width: "100%", padding: "5px 4px", borderRadius: 6,
      border: `1px solid ${disabled ? T.border : color + "55"}`,
      background: disabled ? "transparent" : color + "12",
      color: disabled ? T.border : color,
      fontFamily: T.mono, fontSize: 10, fontWeight: 700,
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.45 : 1, transition: "all .12s",
    }}>{label}</button>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center",
      alignItems: "stretch", gap: 5, padding: "22px 6px 0", minWidth: 70,
      background: T.border + "22", borderRadius: 8 }}>
      {btn("All →",   onAddAll,        T.accent, availCount === 0)}
      {btn(availSelCount > 0 ? `${availSelCount} →` : "Sel →", onAddSelected, T.accent, availSelCount === 0)}
      <div style={{ borderTop: `1px solid ${T.border}`, margin: "3px 0" }} />
      {btn(appliedSelCount > 0 ? `← ${appliedSelCount}` : "← Sel", onRemoveSelected, T.danger, appliedSelCount === 0)}
      {btn("← All",  onRemoveAll,     T.danger, appliedCount === 0)}
    </div>
  );
};

const ScrollBox = ({ children, height = 260 }) => (
  <div style={{ height, overflowY: "auto", paddingRight: 8 }}>
    {children}
  </div>
);

const EmptyHint = ({ children }) => (
  <div style={{ padding: "18px 0", textAlign: "center", fontFamily: T.body,
    fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
    {children}
  </div>
);

// ─── Trade Lane section ───────────────────────────────────────────────────────

const TradeLaneSection = ({ tradeLanes, applied, onAdd, onRemove }) => {
  const [search,      setSearch]      = useState("");
  const [availSel,    setAvailSel]    = useState(new Set());
  const [appliedSel,  setAppliedSel]  = useState(new Set());

  const appliedKeys = new Set(applied.map(i => i.value));
  const allPairs = tradeLanes.flatMap(o =>
    tradeLanes.filter(d => d.code !== o.code).map(d => ({
      key: JSON.stringify({ origin: o.code, dest: d.code }),
      label: `${o.code} → ${d.code}`, sub: `${o.name} → ${d.name}`,
    }))
  );
  const available = allPairs.filter(p =>
    !appliedKeys.has(p.key) &&
    (!search.trim() || `${p.label} ${p.sub}`.toLowerCase().includes(search.toLowerCase()))
  );

  const toggleAvail   = key => setAvailSel(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const toggleApplied = id  => setAppliedSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const doAdd = async (items) => { for (const p of items) await onAdd({ itemType: "trade_lane", value: p.key, label: p.label }); setAvailSel(new Set()); };
  const doRemove = async (ids) => { for (const id of ids) await onRemove(id); setAppliedSel(new Set()); };

  return (
    <div data-testid="trade-lane-section"
      style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14 }}>
      <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 12 }}>Trade Lane</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8 }}>
        <div>
          <ColHeader>Available</ColHeader>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search…" style={{ ...inputStyle(), marginBottom: 6 }}
            onFocus={e => e.currentTarget.style.borderColor = T.accent}
            onBlur={e  => e.currentTarget.style.borderColor = T.border} />
          <ScrollBox>
            {available.length === 0
              ? <EmptyHint>{search ? "No matches" : "All pairs applied"}</EmptyHint>
              : available.map(p => (
                <ItemRow key={p.key} label={p.label} sublabel={p.sub}
                  checked={availSel.has(p.key)} onCheck={() => toggleAvail(p.key)}
                  onClick={() => doAdd([p]) } />
              ))}
          </ScrollBox>
        </div>
        <SectionControls
          availCount={available.length}    availSelCount={availSel.size}
          appliedCount={applied.length}    appliedSelCount={appliedSel.size}
          onAddAll={()           => doAdd(available)}
          onAddSelected={()      => doAdd(available.filter(p => availSel.has(p.key)))}
          onRemoveAll={()        => doRemove(applied.map(i => i.id))}
          onRemoveSelected={()   => doRemove(applied.filter(i => appliedSel.has(i.id)).map(i => i.id))} />
        <div>
          <ColHeader count={applied.length}>Applied</ColHeader>
          <ScrollBox>
            {applied.length === 0
              ? <EmptyHint>No restrictions — can see all trade lanes</EmptyHint>
              : applied.map(i => (
                <ItemRow key={i.id} label={i.label || i.value} applied
                  checked={appliedSel.has(i.id)} onCheck={() => toggleApplied(i.id)}
                  onRemove={() => doRemove([i.id])} />
              ))}
          </ScrollBox>
        </div>
      </div>
    </div>
  );
};

// ─── Origin Port Location section ─────────────────────────────────────────────

const LIMIT = 50;

const PolSection = ({ applied, onAdd, onRemove }) => {
  const [query,       setQuery]       = useState("");
  const [results,     setResults]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [total,       setTotal]       = useState(Infinity);
  const [availSel,    setAvailSel]    = useState(new Set());
  const [appliedSel,  setAppliedSel]  = useState(new Set());

  // Refs to avoid stale closures in scroll handler
  const offsetRef      = useRef(0);
  const fetchingRef    = useRef(false);
  const queryRef       = useRef("");
  const timer          = useRef(null);

  const loadPage = useCallback((q, off, append) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    if (!append) setLoading(true);
    api.ports.search({ search: q.trim(), limit: LIMIT, offset: off })
      .then(r => {
        const rows = r.results || r;
        const tot  = r.total  ?? (off + rows.length + (rows.length === LIMIT ? 1 : 0));
        setTotal(tot);
        offsetRef.current = off + rows.length;
        setResults(prev => append ? [...prev, ...rows] : rows);
      })
      .catch(() => {})
      .finally(() => { fetchingRef.current = false; setLoading(false); });
  }, []);

  // New query → reset and fetch page 0
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      queryRef.current = query;
      offsetRef.current = 0;
      setResults([]);
      setTotal(Infinity);
      loadPage(query, 0, false);
    }, query.trim() ? 280 : 0);
    return () => clearTimeout(timer.current);
  }, [query, loadPage]);

  // Scroll-to-bottom → load next page
  const handleScroll = (e) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80 &&
        !fetchingRef.current && offsetRef.current < total) {
      loadPage(queryRef.current, offsetRef.current, true);
    }
  };

  const appliedCodes = new Set(applied.map(i => i.value));
  const visible = results.filter(p => !appliedCodes.has(p.unlocode));

  const toggleAvail   = code => setAvailSel(s => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n; });
  const toggleApplied = id   => setAppliedSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const doAdd    = async (ports) => { for (const p of ports) await onAdd({ itemType: "pol", value: p.unlocode, label: `${p.unlocode} ${p.name}` }); setAvailSel(new Set()); };
  const doRemove = async (ids)   => { for (const id of ids) await onRemove(id); setAppliedSel(new Set()); };

  const hasMore = offsetRef.current < total;

  return (
    <div data-testid="pol-section"
      style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14 }}>
      <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 12 }}>Origin Port Location</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8 }}>
        <div>
          <ColHeader>Available</ColHeader>
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Filter port locations…" style={{ ...inputStyle(), marginBottom: 6 }}
            onFocus={e => e.currentTarget.style.borderColor = T.accent}
            onBlur={e  => e.currentTarget.style.borderColor = T.border} />
          <div style={{ height: 260, overflowY: "auto", paddingRight: 8 }} onScroll={handleScroll}>
            {loading ? <EmptyHint>Loading…</EmptyHint>
              : visible.length === 0
                ? <EmptyHint>{query.trim() ? `No matches for "${query}"` : "All ports applied"}</EmptyHint>
                : <>
                    {visible.map(p => (
                      <ItemRow key={p.unlocode} label={p.unlocode}
                        sublabel={`${p.name}${p.countryCode ? ` · ${p.countryCode}` : ""}`}
                        checked={availSel.has(p.unlocode)} onCheck={() => toggleAvail(p.unlocode)}
                        onClick={() => doAdd([p])} />
                    ))}
                    {hasMore && (
                      <div style={{ padding: "8px 0", textAlign: "center",
                        fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                        Scroll for more…
                      </div>
                    )}
                  </>}
          </div>
        </div>
        <SectionControls
          availCount={visible.length}     availSelCount={availSel.size}
          appliedCount={applied.length}   appliedSelCount={appliedSel.size}
          onAddAll={()         => doAdd(visible)}
          onAddSelected={()    => doAdd(visible.filter(p => availSel.has(p.unlocode)))}
          onRemoveAll={()      => doRemove(applied.map(i => i.id))}
          onRemoveSelected={() => doRemove(applied.filter(i => appliedSel.has(i.id)).map(i => i.id))} />
        <div>
          <ColHeader count={applied.length}>Applied</ColHeader>
          <ScrollBox>
            {applied.length === 0
              ? <EmptyHint>No restrictions — can load from any port</EmptyHint>
              : applied.map(i => (
                <ItemRow key={i.id} label={i.value}
                  sublabel={i.label?.replace(i.value, "").trim() || undefined}
                  applied checked={appliedSel.has(i.id)} onCheck={() => toggleApplied(i.id)}
                  onRemove={() => doRemove([i.id])} />
              ))}
          </ScrollBox>
        </div>
      </div>
    </div>
  );
};

// ─── Country Codes section ────────────────────────────────────────────────────

const CountrySection = ({ countries, applied, onAdd, onRemove }) => {
  const [search,      setSearch]      = useState("");
  const [availSel,    setAvailSel]    = useState(new Set());
  const [appliedSel,  setAppliedSel]  = useState(new Set());

  const appliedCodes = new Set(applied.map(i => i.value));
  const available = countries.filter(c =>
    !appliedCodes.has(c.iso2) &&
    (!search.trim() || `${c.iso2} ${c.name}`.toLowerCase().includes(search.toLowerCase()))
  );

  const toggleAvail   = iso2 => setAvailSel(s => { const n = new Set(s); n.has(iso2) ? n.delete(iso2) : n.add(iso2); return n; });
  const toggleApplied = id   => setAppliedSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const doAdd    = async (items) => { for (const c of items) await onAdd({ itemType: "country", value: c.iso2, label: `${c.iso2} ${c.name}` }); setAvailSel(new Set()); };
  const doRemove = async (ids)   => { for (const id of ids) await onRemove(id); setAppliedSel(new Set()); };

  return (
    <div data-testid="country-section"
      style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14 }}>
      <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 12 }}>Country Codes</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8 }}>
        <div>
          <ColHeader>Available</ColHeader>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search countries…" style={{ ...inputStyle(), marginBottom: 6 }}
            onFocus={e => e.currentTarget.style.borderColor = T.accent}
            onBlur={e  => e.currentTarget.style.borderColor = T.border} />
          <ScrollBox>
            {available.length === 0
              ? <EmptyHint>{search ? "No matches" : "All countries applied"}</EmptyHint>
              : available.map(c => (
                <ItemRow key={c.iso2} label={c.iso2} sublabel={c.name}
                  checked={availSel.has(c.iso2)} onCheck={() => toggleAvail(c.iso2)}
                  onClick={() => doAdd([c])} />
              ))}
          </ScrollBox>
        </div>
        <SectionControls
          availCount={available.length}   availSelCount={availSel.size}
          appliedCount={applied.length}   appliedSelCount={appliedSel.size}
          onAddAll={()         => doAdd(available)}
          onAddSelected={()    => doAdd(available.filter(c => availSel.has(c.iso2)))}
          onRemoveAll={()      => doRemove(applied.map(i => i.id))}
          onRemoveSelected={() => doRemove(applied.filter(i => appliedSel.has(i.id)).map(i => i.id))} />
        <div>
          <ColHeader count={applied.length}>Applied</ColHeader>
          <ScrollBox>
            {applied.length === 0
              ? <EmptyHint>No restrictions — can see all origin countries</EmptyHint>
              : applied.map(i => (
                <ItemRow key={i.id} label={i.value}
                  sublabel={countries.find(c => c.iso2 === i.value)?.name}
                  applied checked={appliedSel.has(i.id)} onCheck={() => toggleApplied(i.id)}
                  onRemove={() => doRemove([i.id])} />
              ))}
          </ScrollBox>
        </div>
      </div>
    </div>
  );
};

// ─── User Config Panel (below the table) ─────────────────────────────────────

const UserConfigPanel = ({ user, onRolesConfigure }) => {
  const scopedRoles = (user.roles || []).filter(r => SCOPED_ROLES.includes(r));
  const unrestrictedRoles = (user.roles || []).filter(r => !SCOPED_ROLES.includes(r));

  const [activeRole,  setActiveRole]  = useState(scopedRoles[0] || null);
  const [scopeItems,  setScopeItems]  = useState([]);
  const [tradeLanes,  setTradeLanes]  = useState([]);
  const [countries,   setCountries]   = useState([]);
  const [loading,     setLoading]     = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.userScope.list(user.id),
      api.tradeLanes.list(),
      api.countries.list(),
    ])
      .then(([items, lanes, ctries]) => {
        setScopeItems(items);
        setTradeLanes(lanes);
        setCountries(ctries.results ?? ctries);
      })
      .catch(() => toast.error("Failed to load scope data"))
      .finally(() => setLoading(false));
  }, [user.id]);

  const addItem = async (itemData) => {
    if (!activeRole) return;
    try {
      const item = await api.userScope.create(user.id, { role: activeRole, ...itemData });
      setScopeItems(prev => [...prev, item]);
    } catch (e) { toast.error(e.message || "Failed to add"); }
  };

  const removeItem = async (itemId) => {
    try {
      await api.userScope.remove(itemId);
      setScopeItems(prev => prev.filter(i => i.id !== itemId));
    } catch (e) { toast.error(e.message || "Failed to remove"); }
  };

  const roleItems = (type) =>
    scopeItems.filter(i => i.role === activeRole && i.itemType === type);

  return (
    <div data-testid="user-config-panel"
      style={{
        marginTop: 16, borderRadius: 12, border: `1px solid ${T.border}`,
        background: T.surface, overflowX: "auto",
      }}>
      {/* Panel header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 18px", borderBottom: `1px solid ${T.border}`,
        background: T.bg,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
            background: T.accent + "22", border: `1px solid ${T.accent}44`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent,
          }}>
            {user.name?.[0]?.toUpperCase() || "?"}
          </div>
          <div>
            <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text }}>
              {user.name}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
              {user.email}
            </div>
          </div>
        </div>
        <Btn variant="ghost" onClick={onRolesConfigure}>Configure Roles</Btn>
      </div>

      {/* Role tabs */}
      {(user.roles || []).length > 0 && (
        <div data-testid="role-tabs" style={{ display: "flex", gap: 2, padding: "10px 18px 0",
          borderBottom: `1px solid ${T.border}`, minWidth: 640 }}>
          {(user.roles || []).map(role => {
            const isActive = activeRole === role;
            const c = ROLE_COLORS[role] || ROLE_COLORS.viewer;
            return (
              <button key={role} data-testid={`role-tab-${role}`} onClick={() => setActiveRole(role)} style={{
                padding: "7px 16px", borderRadius: "8px 8px 0 0", cursor: "pointer",
                border: `1px solid ${isActive ? (SCOPED_ROLES.includes(role) ? c.border : T.border) : "transparent"}`,
                borderBottom: isActive ? `1px solid ${T.surface}` : "1px solid transparent",
                background: isActive ? T.surface : "transparent",
                fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                color: isActive ? (SCOPED_ROLES.includes(role) ? c.text : T.text) : T.textMuted,
                transition: "all .12s", position: "relative", bottom: -1,
              }}>
                {ROLE_LABELS[role] || role}
              </button>
            );
          })}
        </div>
      )}

      {/* Tab content */}
      <div style={{ padding: 18 }}>
        {loading ? (
          <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body,
            fontSize: 13, color: T.textMuted }}>
            Loading scope data…
          </div>
        ) : !activeRole ? (
          <div style={{ padding: "24px 0", textAlign: "center", fontFamily: T.body,
            fontSize: 13, color: T.textMuted }}>
            No roles assigned. Click "Configure Roles" to add roles.
          </div>
        ) : !SCOPED_ROLES.includes(activeRole) ? (
          <div style={{
            padding: "14px 18px", borderRadius: 9,
            background: T.success + "12", border: `1px solid ${T.success}44`,
            fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.5,
          }}>
            <strong>{ROLE_LABELS[activeRole]}</strong> has unrestricted access — data scoping does not apply to this role.
            The user can see all shipments.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {scopeItems.filter(i => i.role === activeRole).length === 0 && (
              <div style={{
                padding: "10px 14px", borderRadius: 8,
                background: T.warning + "12", border: `1px solid ${T.warning}44`,
                fontFamily: T.body, fontSize: 12, color: T.text,
              }}>
                No restrictions configured for <strong>{ROLE_LABELS[activeRole]}</strong> — this user can see <strong>all</strong> shipments. Add rules below to restrict access.
              </div>
            )}
            <div data-testid="scope-sections-grid"
              style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(460px, 1fr))", gap: 14 }}>
              <TradeLaneSection
                tradeLanes={tradeLanes}
                applied={roleItems("trade_lane")}
                onAdd={addItem}
                onRemove={removeItem} />
              <PolSection
                applied={roleItems("pol")}
                onAdd={addItem}
                onRemove={removeItem} />
              <CountrySection
                countries={countries}
                applied={roleItems("country")}
                onAdd={addItem}
                onRemove={removeItem} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Create / edit user modal ─────────────────────────────────────────────────

const UserFormModal = ({ user: existing, onSave, onClose }) => {
  const isNew = !existing;
  const [name,     setName]     = useState(existing?.name      ?? "");
  const [email,    setEmail]    = useState(existing?.email     ?? "");
  const [password, setPassword] = useState("");
  const [active,   setActive]   = useState(existing?.is_active ?? 1);
  const [roles,    setRoles]    = useState(existing?.roles     ?? ["viewer"]);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState("");

  const toggle = (role) =>
    setRoles(prev => prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]);

  const handleSave = async () => {
    if (!name.trim()) return setError("Name is required");
    if (!email.trim()) return setError("Email is required");
    if (isNew && !password.trim()) return setError("Password is required");
    if (!roles.length) return setError("At least one role must be selected");
    setError(""); setSaving(true);
    try {
      const payload = { name: name.trim(), email: email.trim(), roles, is_active: Number(active) };
      if (isNew) payload.password = password;
      else if (password.trim()) payload.password = password.trim();
      await onSave(payload);
      onClose();
    } catch (e) {
      setError(e.message || "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <Modal title={isNew ? "New User" : "Edit User"} onClose={onClose} width={500}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {error && (
          <div style={{ padding: "9px 13px", borderRadius: 7, background: T.danger + "18",
            border: `1px solid ${T.danger}44`, fontFamily: T.body, fontSize: 13, color: T.danger }}>
            {error}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <FieldLabel>Full Name</FieldLabel>
            <input value={name} onChange={e => setName(e.target.value)} style={inputStyle()}
              placeholder="Jane Smith"
              onFocus={e => e.currentTarget.style.borderColor = T.accent}
              onBlur={e  => e.currentTarget.style.borderColor = T.border} />
          </div>
          <div>
            <FieldLabel>Email</FieldLabel>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle()}
              placeholder="jane@example.com"
              onFocus={e => e.currentTarget.style.borderColor = T.accent}
              onBlur={e  => e.currentTarget.style.borderColor = T.border} />
          </div>
          <div>
            <FieldLabel>{isNew ? "Password" : "New Password (blank to keep)"}</FieldLabel>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} style={inputStyle()}
              placeholder={isNew ? "Set a password" : "Leave blank to keep"}
              onFocus={e => e.currentTarget.style.borderColor = T.accent}
              onBlur={e  => e.currentTarget.style.borderColor = T.border} />
          </div>
          {!isNew && (
            <div style={{ display: "flex", alignItems: "center" }}>
              <label style={{ fontFamily: T.body, fontSize: 12, color: T.text,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={!!active} onChange={e => setActive(e.target.checked ? 1 : 0)}
                  style={{ width: 14, height: 14, cursor: "pointer" }} />
                Account active
              </label>
            </div>
          )}
        </div>
        <div>
          <FieldLabel>Roles</FieldLabel>
          <div style={{ display: "flex", gap: 7 }}>
            {ALL_ROLES.map(role => {
              const active = roles.includes(role);
              const c = ROLE_COLORS[role];
              return (
                <button key={role} onClick={() => toggle(role)} style={{
                  flex: 1, padding: "8px 6px", borderRadius: 8, cursor: "pointer", textAlign: "center",
                  border: `1.5px solid ${active ? c.border : T.border}`,
                  background: active ? c.bg : "transparent",
                  fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                  color: active ? c.text : T.textMuted,
                  transition: "all .12s",
                }}>
                  {active ? "✓ " : ""}{ROLE_LABELS[role]}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <Btn variant="ghost" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : isNew ? "Create User" : "Save Changes"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Confirm delete ───────────────────────────────────────────────────────────

const ConfirmModal = ({ user, onConfirm, onClose }) => (
  <Modal title="Delete User" onClose={onClose} width={400}>
    <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.6, marginBottom: 20 }}>
      Permanently delete <strong>{user.name}</strong>? This cannot be undone.
    </div>
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
      <Btn variant="danger" onClick={onConfirm}>Delete</Btn>
    </div>
  </Modal>
);

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function UserManagementPanel() {
  const [users,         setUsers]         = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [search,        setSearch]        = useState("");
  const [selectedUser,  setSelectedUser]  = useState(null);
  const [showCreate,    setShowCreate]    = useState(false);
  const [editTarget,    setEditTarget]    = useState(null);
  const [deleteTarget,  setDeleteTarget]  = useState(null);
  const [rolesTarget,   setRolesTarget]   = useState(null);
  const configPanelRef = useRef(null);

  const load = () => {
    setLoading(true);
    api.users.list()
      .then(u => {
        setUsers(u);
        // refresh selected user in case roles changed
        setSelectedUser(prev => prev ? u.find(x => x.id === prev.id) ?? prev : null);
      })
      .catch(() => toast.error("Failed to load users"))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleCreate = async (data) => {
    await api.users.create(data);
    toast.success("User created");
    load();
  };

  const handleEdit = async (data) => {
    await api.users.update(editTarget.id, data);
    toast.success("User updated");
    load();
  };

  const handleRoles = async (data) => {
    await api.users.update(rolesTarget.id, data);
    // Update selected user inline
    setSelectedUser(prev => prev?.id === rolesTarget.id ? { ...prev, ...data } : prev);
    setUsers(prev => prev.map(u => u.id === rolesTarget.id ? { ...u, ...data } : u));
    load();
  };

  const handleDelete = async () => {
    try {
      await api.users.remove(deleteTarget.id);
      setUsers(p => p.filter(u => u.id !== deleteTarget.id));
      if (selectedUser?.id === deleteTarget.id) setSelectedUser(null);
      toast.success("User deleted");
    } catch (e) {
      toast.error(e.message);
    } finally { setDeleteTarget(null); }
  };

  const handleConfigure = (user) => {
    setSelectedUser(u => u?.id === user.id ? null : user);
    setTimeout(() => configPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const filteredUsers = search.trim()
    ? users.filter(u =>
        u.name.toLowerCase().includes(search.toLowerCase()) ||
        u.email.toLowerCase().includes(search.toLowerCase()))
    : users;

  const colHd = (label, width) => (
    <th style={{ textAlign: "left", padding: "8px 14px", fontFamily: T.mono, fontSize: 11,
      fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em",
      borderBottom: `1px solid ${T.border}`, width }}>
      {label}
    </th>
  );

  return (
  <>
    <div data-testid="user-management-panel">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: T.head, fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 8 }}>
            User Management
          </div>
          <input data-testid="user-search"
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            style={{ ...inputStyle(), maxWidth: 380, fontSize: 13 }}
            onFocus={e => e.currentTarget.style.borderColor = T.accent}
            onBlur={e  => e.currentTarget.style.borderColor = T.border} />
        </div>
        <Btn variant="primary" data-testid="new-user-btn" onClick={() => setShowCreate(true)}>+ New User</Btn>
      </div>

      {/* User table */}
      {loading ? (
        <div style={{ padding: "40px 0", textAlign: "center", color: T.textMuted,
          fontFamily: T.body, fontSize: 13 }}>Loading…</div>
      ) : (
        <div data-testid="user-table"
          style={{ background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {colHd("Name", 190)}
                {colHd("Email", undefined)}
                {colHd("Roles", 220)}
                {colHd("Status", 90)}
                {colHd("Last Login", 140)}
                {colHd("", 110)}
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u, i) => {
                const isSelected = selectedUser?.id === u.id;
                return (
                  <tr key={u.id} data-testid={`user-row-${u.id}`} data-user-email={u.email}
                    style={{
                      borderBottom: i < filteredUsers.length - 1 ? `1px solid ${T.border}` : "none",
                      background: isSelected ? T.accent + "08" : i % 2 === 0 ? "transparent" : T.bg + "55",
                      cursor: "pointer",
                    }} onClick={() => handleConfigure(u)}>
                    <td style={{ padding: "10px 14px", fontFamily: T.body, fontSize: 13,
                      fontWeight: 600, color: T.text }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{
                          width: 27, height: 27, borderRadius: "50%", flexShrink: 0,
                          background: isSelected ? T.accent + "33" : T.accent + "18",
                          border: `1px solid ${T.accent}${isSelected ? "88" : "44"}`,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.accent,
                        }}>
                          {u.name?.[0]?.toUpperCase() ?? "?"}
                        </div>
                        {u.name}
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px", fontFamily: T.mono, fontSize: 12,
                      color: T.textMuted }}>
                      {u.email}
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {(u.roles || [u.role]).map(r => <RoleBadge key={r} role={r} />)}
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <span data-testid={`user-status-${u.id}`} style={{
                        display: "inline-block", padding: "2px 9px", borderRadius: 20,
                        fontFamily: T.mono, fontSize: 11, fontWeight: 600,
                        background: u.is_active ? T.success + "18" : T.danger + "18",
                        color: u.is_active ? T.success : T.danger,
                        border: `1px solid ${u.is_active ? T.success + "44" : T.danger + "44"}`,
                      }}>
                        {u.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={{ padding: "10px 14px", fontFamily: T.mono, fontSize: 11,
                      color: T.textMuted }}>
                      {u.last_login
                        ? new Date(u.last_login).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
                        : <span style={{ color: T.border }}>Never</span>}
                    </td>
                    <td style={{ padding: "10px 14px" }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: "flex", gap: 5 }}>
                        <button data-testid={`edit-user-${u.id}`}
                          onClick={() => setEditTarget(u)} title="Edit profile"
                          style={{ padding: "3px 9px", borderRadius: 6, border: `1px solid ${T.border}`,
                            background: T.bg, color: T.textMuted, fontFamily: T.body, fontSize: 12,
                            cursor: "pointer" }}>
                          Edit
                        </button>
                        <button data-testid={`delete-user-${u.id}`}
                          onClick={() => { setDeleteTarget(u); if (selectedUser?.id === u.id) setSelectedUser(null); }}
                          title="Delete user"
                          style={{ padding: "3px 9px", borderRadius: 6, border: `1px solid ${T.danger}44`,
                            background: T.danger + "10", color: T.danger, fontFamily: T.body, fontSize: 12,
                            cursor: "pointer" }}>
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: "32px", textAlign: "center",
                    fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                    {search ? `No users matching "${search}"` : "No users found."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

    </div>

    {/* Config panel — sibling of user table so its width doesn't affect the table */}
    <div ref={configPanelRef} data-testid="config-panel-anchor" style={{ width: "200%" }}>
      {selectedUser && (
        <UserConfigPanel
          key={selectedUser.id}
          user={selectedUser}
          onRolesConfigure={() => setRolesTarget(selectedUser)} />
      )}
    </div>

    {/* Modals */}
    {showCreate && (
      <UserFormModal onSave={handleCreate} onClose={() => setShowCreate(false)} />
    )}
    {editTarget && (
      <UserFormModal user={editTarget} onSave={handleEdit} onClose={() => setEditTarget(null)} />
    )}
    {deleteTarget && (
      <ConfirmModal user={deleteTarget} onConfirm={handleDelete} onClose={() => setDeleteTarget(null)} />
    )}
    {rolesTarget && (
      <ConfigureRolesModal user={rolesTarget} onSave={handleRoles} onClose={() => setRolesTarget(null)} />
    )}
  </>
  );
}
