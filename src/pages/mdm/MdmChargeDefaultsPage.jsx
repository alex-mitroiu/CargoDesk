import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Inp, Sel } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import ActionMenu from "../../components/primitives/ActionMenu";
import CustomerCombobox from "../../components/shared/CustomerCombobox";
import PortCombobox from "../../components/shared/PortCombobox";
import CountryCombobox from "../../components/shared/CountryCombobox";
import { IconPencil, IconClose } from "../../components/primitives/Icon";

// ─── Charge Defaults (mockup: https://claude.ai/artifact/15DeP2Lcx9qmQbyQAUEwWd) ───────────────
// Predefined BUY/SELL cost lines a Trade Manager wants to appear automatically on a matching
// shipment's Accounting tabs — see lib/charge-defaults.js for the matching/precedence engine
// that runs server-side, and routes/charge-default-setups.js for the validation this form mirrors.

// Same fixed vocabulary CostLineForm's own Charge Code dropdown already uses (ShipmentDetailPage.jsx)
// — duplicated rather than imported, same small-shared-constant precedent as routes/charge-default-setups.js's
// own copy, so a change here can never accidentally affect the unrelated Cost Entry modal.
const CHARGE_CODES = ["Ocean Freight", "Origin THC", "Destination THC", "B/L Fee", "Customs", "Inland", "Haulage", "Other"];
const CURRENCIES = ["USD", "EUR", "GBP", "CNY", "SGD", "JPY", "AED", "CHF"];
const MOVEMENT_OPTIONS = [{ value: "", label: "Any" }, { value: "FCL", label: "FCL" }, { value: "LCL", label: "LCL" }];

const specificity = s => (s.principalId ? 1 : 0) + (!s.locationGlobal ? 1 : 0) + (s.movementType ? 1 : 0);

// A plain clickable div, not a real checkbox — the boolean lives in React state and drives the
// track/thumb colors directly, so no CSS :checked selector is needed (this codebase styles
// everything inline, never via a stylesheet).
const GlobalToggle = ({ checked, onChange }) => (
  <div role="switch" aria-checked={checked} tabIndex={0} onClick={() => onChange(!checked)}
    onKeyDown={e => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onChange(!checked))}
    style={{ width: 38, height: 22, borderRadius: 20, position: "relative", cursor: "pointer", flexShrink: 0,
      background: checked ? T.accent : T.border, transition: "background .15s" }}>
    <div style={{ position: "absolute", top: 2, left: checked ? 18 : 2, width: 18, height: 18, borderRadius: "50%",
      background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.3)", transition: "left .15s" }} />
  </div>
);

// CountryCombobox is a search-only typeahead (no persistent "selected" display of its own,
// unlike PortCombobox) — same real component MdmTradeLanesPage/MdmCountriesPage already use, just
// wrapped here with a PortCombobox-style selected chip so Country reads the same as Location.
const fieldLabelStyle = { fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted,
  textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 5 };
const CountryField = ({ value, onChange }) => (
  value?.iso2 ? (
    <div style={{ background: T.bg, border: `1px solid ${T.accent}55`, borderRadius: 7, padding: "7px 10px",
      display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700, flexShrink: 0 }}>{value.iso2}</span>
      <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value.name}</span>
      <button type="button" onClick={() => onChange(null)} title="Change"
        style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 13, padding: "0 2px", flexShrink: 0 }}>&times;</button>
    </div>
  ) : (
    <CountryCombobox placeholder="Search countries…" onSelect={c => onChange({ iso2: c.iso2, name: c.name })} />
  )
);

const LocationColumn = ({ label, region, onRegion, country, onCountry, location, onLocation, regions }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 10,
    border: `1px solid ${T.border}`, background: T.bg }}>
    <div style={{ fontFamily: T.head, fontWeight: 700, fontSize: 13, color: T.text }}>{label}</div>
    {/* Region has no search component anywhere in the app (GET /api/regions returns the whole,
        small, admin-curated list with no search param) — a dropdown is the real, consistent
        pattern here, not a shortcut. */}
    <Sel label="Region" value={region} onChange={onRegion}
      options={[{ value: "", label: "—" }, ...regions.map(r => ({ value: r.code, label: r.name }))]} />
    <div>
      <div style={fieldLabelStyle}>Country</div>
      <CountryField value={country} onChange={onCountry} />
    </div>
    <div>
      <div style={fieldLabelStyle}>Location</div>
      <PortCombobox value={location} onChange={onLocation} placeholder="Search port or UN/LOCODE…" />
    </div>
    <div style={{ fontFamily: T.body, fontSize: 11, color: T.textFaint }}>Fill exactly one of the three — picking one clears the other two.</div>
  </div>
);

const ChargeDefaultSetupForm = ({ init = {}, regions, onSave, onCancel }) => {
  const [principal, setPrincipal] = useState({ id: init.principalId || "", name: init.principalName || "" });
  const [movementType, setMovementType] = useState(init.movementType || "");
  const [locationGlobal, setLocationGlobal] = useState(!!init.locationGlobal);

  const [originRegion, setOriginRegionRaw] = useState(init.originRegion || "");
  const [originCountry, setOriginCountryRaw] = useState(init.originCountry ? { iso2: init.originCountry, name: init.originCountryName || "" } : null);
  const [originLocation, setOriginLocationRaw] = useState(init.originLocation ? { unlocode: init.originLocation, name: init.originLocationName || "" } : null);
  const [destRegion, setDestRegionRaw] = useState(init.destRegion || "");
  const [destCountry, setDestCountryRaw] = useState(init.destCountry ? { iso2: init.destCountry, name: init.destCountryName || "" } : null);
  const [destLocation, setDestLocationRaw] = useState(init.destLocation ? { unlocode: init.destLocation, name: init.destLocationName || "" } : null);

  const setOriginRegion = v => { setOriginRegionRaw(v); if (v) { setOriginCountryRaw(null); setOriginLocationRaw(null); } };
  const setOriginCountry = v => { setOriginCountryRaw(v); if (v) { setOriginRegionRaw(""); setOriginLocationRaw(null); } };
  const setOriginLocation = v => { setOriginLocationRaw(v); if (v) { setOriginRegionRaw(""); setOriginCountryRaw(null); } };
  const setDestRegion = v => { setDestRegionRaw(v); if (v) { setDestCountryRaw(null); setDestLocationRaw(null); } };
  const setDestCountry = v => { setDestCountryRaw(v); if (v) { setDestRegionRaw(""); setDestLocationRaw(null); } };
  const setDestLocation = v => { setDestLocationRaw(v); if (v) { setDestRegionRaw(""); setDestCountryRaw(null); } };

  const [lines, setLines] = useState((init.lines || []).map(l => ({ ...l, amount: String(l.amount) })));
  const [error, setError] = useState("");
  const [confirmNoPrincipal, setConfirmNoPrincipal] = useState(false);
  const [chargesOpen, setChargesOpen] = useState(false);
  const [costsOpen, setCostsOpen] = useState(false);

  const updateLine = (idx, patch) => setLines(ls => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const removeLine = idx => setLines(ls => ls.filter((_, i) => i !== idx));
  const addLine = type => setLines(ls => [...ls, { type, chargeCode: CHARGE_CODES[0], description: "", currency: "USD", amount: "" }]);

  const originCount = [originRegion, originCountry?.iso2, originLocation?.unlocode].filter(Boolean).length;
  const destCount   = [destRegion, destCountry?.iso2, destLocation?.unlocode].filter(Boolean).length;
  const chargeLines = lines.filter(l => l.type === "SELL");
  const costLines   = lines.filter(l => l.type === "BUY");
  const spec = specificity({ principalId: principal.id, locationGlobal, movementType });

  const buildPayload = () => ({
    principalId: principal.id, principalName: principal.name, movementType, locationGlobal,
    originRegion: locationGlobal ? "" : originRegion,
    originCountry: locationGlobal ? "" : (originCountry?.iso2 || ""),
    originLocation: locationGlobal ? "" : (originLocation?.unlocode || ""),
    destRegion: locationGlobal ? "" : destRegion,
    destCountry: locationGlobal ? "" : (destCountry?.iso2 || ""),
    destLocation: locationGlobal ? "" : (destLocation?.unlocode || ""),
    lines: lines.map(({ type, chargeCode, description, currency, amount }) => ({ type, chargeCode, description, currency, amount: parseFloat(amount) || 0 })),
  });

  const handleSaveClick = () => {
    if (!lines.length) { setError("Add at least one charge or cost line before saving."); return; }
    if (!locationGlobal && (originCount !== 1 || destCount !== 1)) {
      setError("Set exactly one Origin field and one Destination field, or turn Global on."); return;
    }
    setError("");
    if (!principal.id) { setConfirmNoPrincipal(true); return; }
    onSave(buildPayload());
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && (
        <div style={{ background: `${T.danger}18`, border: `1px solid ${T.danger}`, borderRadius: 8,
          padding: "10px 14px", fontFamily: T.body, fontSize: 12.5, color: T.danger, fontWeight: 600 }}>
          ⚠ {error}
        </div>
      )}

      <div style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em" }}>Scope</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 14, alignItems: "end" }}>
        <CustomerCombobox label="Principal" value={principal} onChange={setPrincipal} roleFilter="Principal" />
        <Sel label="Movement type" value={movementType} onChange={setMovementType} options={MOVEMENT_OPTIONS} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 8 }}>
          <GlobalToggle checked={locationGlobal} onChange={setLocationGlobal} />
          <div>
            <div style={{ fontFamily: T.body, fontSize: 12.5, fontWeight: 600, color: T.text }}>Global</div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textFaint }}>Any origin/destination</div>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, opacity: locationGlobal ? 0.45 : 1, pointerEvents: locationGlobal ? "none" : "auto" }}>
        <LocationColumn label="Origin" region={originRegion} onRegion={setOriginRegion} country={originCountry} onCountry={setOriginCountry}
          location={originLocation} onLocation={setOriginLocation} regions={regions} />
        <LocationColumn label="Destination" region={destRegion} onRegion={setDestRegion} country={destCountry} onCountry={setDestCountry}
          location={destLocation} onLocation={setDestLocation} regions={regions} />
      </div>

      <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, background: T.bg, borderRadius: 8, padding: "8px 12px" }}>
        <strong style={{ color: T.text }}>Precedence: {spec} of 3</strong> scope groups set (Principal, Origin+Destination, Movement Type) —
        a shipment ever matches at most one setup, the most specific one.
      </div>

      <div style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em", marginTop: 4 }}>Lines</div>

      <details open={chargesOpen} onToggle={e => setChargesOpen(e.target.open)} style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
        <summary style={{ cursor: "pointer", padding: "10px 14px", background: T.surface, fontFamily: T.head, fontWeight: 700, fontSize: 13, color: T.text }}>
          Charges (Sell) — {chargeLines.length} line{chargeLines.length !== 1 ? "s" : ""}
        </summary>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {lines.map((l, i) => l.type !== "SELL" ? null : (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1.4fr 1.6fr 90px 110px auto", gap: 8, alignItems: "end" }}>
              <Sel label="Charge code" value={l.chargeCode} onChange={v => updateLine(i, { chargeCode: v })}
                options={CHARGE_CODES.map(c => ({ value: c, label: c }))} />
              <Inp label="Description" value={l.description} onChange={v => updateLine(i, { description: v })} placeholder="Optional" />
              <Sel label="Currency" value={l.currency} onChange={v => updateLine(i, { currency: v })} options={CURRENCIES.map(c => ({ value: c, label: c }))} />
              <Inp label="Amount" value={l.amount} onChange={v => updateLine(i, { amount: v })} type="number" placeholder="0.00" />
              <Btn variant="secondary" onClick={() => removeLine(i)} style={{ marginBottom: 1 }}><IconClose size={13} /></Btn>
            </div>
          ))}
          <Btn variant="secondary" onClick={() => addLine("SELL")}>＋ Add Charge Line</Btn>
        </div>
      </details>

      <details open={costsOpen} onToggle={e => setCostsOpen(e.target.open)} style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
        <summary style={{ cursor: "pointer", padding: "10px 14px", background: T.surface, fontFamily: T.head, fontWeight: 700, fontSize: 13, color: T.text }}>
          Costs (Buy) — {costLines.length} line{costLines.length !== 1 ? "s" : ""}
        </summary>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {lines.map((l, i) => l.type !== "BUY" ? null : (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1.4fr 1.6fr 90px 110px auto", gap: 8, alignItems: "end" }}>
              <Sel label="Charge code" value={l.chargeCode} onChange={v => updateLine(i, { chargeCode: v })}
                options={CHARGE_CODES.map(c => ({ value: c, label: c }))} />
              <Inp label="Description" value={l.description} onChange={v => updateLine(i, { description: v })} placeholder="Optional" />
              <Sel label="Currency" value={l.currency} onChange={v => updateLine(i, { currency: v })} options={CURRENCIES.map(c => ({ value: c, label: c }))} />
              <Inp label="Amount" value={l.amount} onChange={v => updateLine(i, { amount: v })} type="number" placeholder="0.00" />
              <Btn variant="secondary" onClick={() => removeLine(i)} style={{ marginBottom: 1 }}><IconClose size={13} /></Btn>
            </div>
          ))}
          <Btn variant="secondary" onClick={() => addLine("BUY")}>＋ Add Cost Line</Btn>
        </div>
      </details>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 8, borderTop: `1px solid ${T.border}` }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSaveClick}>Save Setup</Btn>
      </div>

      {confirmNoPrincipal && (
        <ConfirmModal
          message={"No Principal set. This setup will apply to every customer on every shipment matching its location and movement type — including customers you haven't onboarded yet. It's a broad, standing default that's easy to forget about later. Create it anyway?"}
          confirmLabel="Yes, apply to all customers"
          onConfirm={() => { setConfirmNoPrincipal(false); onSave(buildPayload()); }}
          onCancel={() => setConfirmNoPrincipal(false)} />
      )}
    </div>
  );
};

const MdmChargeDefaultsPage = () => {
  const { canManageConfigs } = useAuth();
  const [setups, setSetups] = useState([]);
  const [regions, setRegions] = useState([]);
  const [countries, setCountries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | "add" | enriched setup object
  const [confirm, setConfirm] = useState(null);

  const load = () => {
    setLoading(true);
    return api.chargeDefaultSetups.list().then(setSetups).catch(() => setSetups([])).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    api.regions.list().then(setRegions).catch(() => setRegions([]));
    api.countries.list().then(r => setCountries(r.results || r)).catch(() => setCountries([]));
  }, []);

  const openEdit = async row => {
    try {
      const full = await api.chargeDefaultSetups.get(row.id);
      const [originLocationName, destLocationName] = await Promise.all([
        full.originLocation ? api.ports.get(full.originLocation).then(p => p.name).catch(() => "") : "",
        full.destLocation   ? api.ports.get(full.destLocation).then(p => p.name).catch(() => "") : "",
      ]);
      // Country names are resolved from the list already loaded on mount — no extra call needed.
      const originCountryName = countries.find(c => c.iso2 === full.originCountry)?.name || "";
      const destCountryName   = countries.find(c => c.iso2 === full.destCountry)?.name || "";
      setModal({ ...full, originLocationName, destLocationName, originCountryName, destCountryName });
    } catch (e) { toast.error(e.message); }
  };

  const handleSave = async data => {
    try {
      if (modal === "add") {
        await api.chargeDefaultSetups.create(data);
        toast.success("Charge default setup created");
      } else {
        await api.chargeDefaultSetups.update(modal.id, data);
        toast.success("Charge default setup updated");
      }
      setModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async id => {
    try {
      await api.chargeDefaultSetups.remove(id);
      toast.success("Charge default setup removed");
      setConfirm(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const toggleActive = async row => {
    try {
      await api.chargeDefaultSetups.setActive(row.id, !row.isActive);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const locCell = (region, country, location) =>
    region ? { tier: "Region", value: region } : country ? { tier: "Country", value: country } : location ? { tier: "Location", value: location } : null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Charge Defaults</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {setups.length} setup{setups.length !== 1 ? "s" : ""} · auto-filled onto a matching shipment's Accounting tabs, once
          </p>
        </div>
        {canManageConfigs && <Btn onClick={() => setModal("add")} size="lg">＋ New Setup</Btn>}
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 90px 70px 110px 90px 90px", padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Principal", "Origin", "Destination", "Movement", "Lines", "Precedence", "Status", "Actions"].map((h, i) => (
            <div key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>Loading…</div>
        ) : setups.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No charge default setups yet. Add one above — e.g. a Chassis Usage Fee that always applies on FCL imports into the US.
          </div>
        ) : setups.map(s => {
          const origin = locCell(s.originRegion, s.originCountry, s.originLocation);
          const dest   = locCell(s.destRegion, s.destCountry, s.destLocation);
          return (
            <div key={s.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 90px 70px 110px 90px 90px",
              padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: s.principalName ? 600 : 400 }}>
                {s.principalName || "All Principals"}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
                {s.locationGlobal ? "Any" : origin ? `${origin.tier}: ${origin.value}` : "—"}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
                {s.locationGlobal ? "Any" : dest ? `${dest.tier}: ${dest.value}` : "—"}
              </span>
              <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{s.movementType || "Any"}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{s.lineCount}</span>
              <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textMuted }}>{specificity(s)} of 3</span>
              <Badge variant={s.isActive ? "success" : "default"}>{s.isActive ? "Active" : "Inactive"}</Badge>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <ActionMenu items={[
                  ...(canManageConfigs ? [{ icon: IconPencil, label: "Edit", onClick: () => openEdit(s) }] : []),
                  ...(canManageConfigs ? [{ icon: IconClose, label: s.isActive ? "Deactivate" : "Activate", onClick: () => toggleActive(s) }] : []),
                  ...(canManageConfigs ? [{ icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(s) }] : []),
                ]} />
              </div>
            </div>
          );
        })}
      </div>

      {modal === "add" && (
        <Modal title="New Charge Default Setup" onClose={() => setModal(null)} width={720}>
          <ChargeDefaultSetupForm regions={regions} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Charge Default Setup" onClose={() => setModal(null)} width={720}>
          <ChargeDefaultSetupForm init={modal} regions={regions} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Delete this charge default setup? Cost lines already applied to a shipment from it are untouched — only the template is removed.`}
          onConfirm={() => handleDelete(confirm.id)}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmChargeDefaultsPage;
