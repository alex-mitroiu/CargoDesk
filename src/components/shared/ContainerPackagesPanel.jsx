import { useState, useEffect } from "react";
import { T, IMDG_CLASSES, CURRENCIES } from "../../tokens";
import Btn from "../primitives/Btn";
import { Inp, Sel, BtnToggle } from "../primitives/Form";
import { AnyIcon, IconWarning } from "../primitives/Icon";

// ─── Container cargo manifest — shared tree/detail building blocks ────────────
// NavRow and PackageDetailForm back the unified Containers + Cargo Manifest tree
// (ShipmentContainersPage.jsx, TKT-OTKNJN) — a single tree spanning every container
// in the shipment (root nodes) fanning out into each one's typed pack breakdown
// (container_packages, TKT-EMFIBR / TKT-26C70U: arbitrary nesting, Pallet/Carton/
// Box/... via the pack-type registry). Previously this file also owned a
// single-container-only tree opened from a separate "Cargo Manifest" modal button —
// that surface is gone now that the same tree lives inline on the unified page.

const NavRow = ({ id, icon, label, badge, dgClass, depth, selected, onClick, onToggle, hasChildren, isOpen }) => (
  <div id={id} onClick={onClick}
    style={{ display: "flex", alignItems: "center", gap: 4,
      padding: `4px 8px 4px ${8 + depth * 14}px`,
      borderRadius: 5, cursor: "pointer", userSelect: "none",
      background: selected ? T.accent + "22" : "transparent",
      color: selected ? T.accent : T.text,
      fontFamily: T.body, fontSize: 12.5, fontWeight: selected ? 600 : 400,
      borderLeft: selected ? `2px solid ${T.accent}` : "2px solid transparent" }}>
    <span onClick={e => { if (onToggle) { e.stopPropagation(); onToggle(); } }}
      style={{ fontSize: 9, color: T.textMuted, width: 10, flexShrink: 0, textAlign: "center" }}>
      {hasChildren ? (isOpen ? "▾" : "▸") : ""}
    </span>
    <AnyIcon icon={icon} size={13} />
    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    {dgClass && (
      <span title={`DG — IMO ${dgClass}`} style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700,
        color: "#fff", background: T.danger, borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>DG</span>
    )}
    {badge != null && (
      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, fontWeight: 700, flexShrink: 0 }}>× {badge}</span>
    )}
  </div>
);

const PackageDetailForm = ({ init = {}, packTypes, isNew, canEdit, saving, containerHsCode, onSave, onCancel, onDelete, onAddChild }) => {
  const [packTypeId,  setPackTypeId]  = useState(init.packTypeId || "");
  const [description, setDescription] = useState(init.description || "");
  const [quantity,    setQuantity]    = useState(init.quantity != null ? String(init.quantity) : "1");
  // Per-item DG classification (TKT-9VAD6R) — mirrors ContainerForm's own DG section (Shipment
  // DetailPage.jsx) so a single pallet/carton can be flagged DG independent of the container
  // it sits in, instead of forcing the whole container to be marked DG for one DG item.
  const [isDg,        setIsDg]        = useState(init.isDg || false);
  const [dgClass,     setDgClass]     = useState(init.dgClass || "");
  // Structured cargo line item (Epic TKT-P3ASH1) — unit value/currency/HS override, feeding
  // the cargo value rollup and the Commercial Invoice / Packing List documents.
  const [unitValue,   setUnitValue]   = useState(init.unitValue != null ? String(init.unitValue) : "");
  const [currency,    setCurrency]    = useState(init.currency || "USD");
  const [hsCode,       setHsCode]      = useState(init.hsCode || "");

  useEffect(() => {
    setPackTypeId(init.packTypeId || "");
    setDescription(init.description || "");
    setQuantity(init.quantity != null ? String(init.quantity) : "1");
    setIsDg(init.isDg || false);
    setDgClass(init.dgClass || "");
    setUnitValue(init.unitValue != null ? String(init.unitValue) : "");
    setCurrency(init.currency || "USD");
    setHsCode(init.hsCode || "");
  }, [init.id, init.packTypeId, init.description, init.quantity, init.isDg, init.dgClass, init.unitValue, init.currency, init.hsCode]);

  const qty = parseInt(quantity, 10);
  const uv  = unitValue.trim() === "" ? null : parseFloat(unitValue);
  const validValue = uv == null || (Number.isFinite(uv) && uv >= 0);
  const valid = description.trim().length > 0 && Number.isFinite(qty) && qty >= 1 && (!isDg || dgClass) && validValue;
  const typeOptions = [{ value: "", label: "— No type —" }, ...packTypes.map(t => ({ value: t.id, label: `${t.icon} ${t.label}` }))];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Sel id="pkgform-packtype" label="Pack Type" value={packTypeId} onChange={setPackTypeId} options={typeOptions} />
      <Inp id="pkgform-description" label="Description" value={description} onChange={setDescription}
        placeholder="e.g. Bottles of olive oil" hint="What's on/in this pack — the type above is the box/pallet/etc. itself" required />
      <Inp id="pkgform-quantity" label="Quantity" value={quantity} onChange={setQuantity} type="number" required />

      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 2 }}>
          <Inp id="pkgform-unitvalue" label="Unit Value" value={unitValue} onChange={setUnitValue} type="number"
            placeholder="e.g. 12.50" hint="Per-unit declared value — leave blank if not priced yet" />
        </div>
        <div style={{ flex: 1 }}>
          <Sel id="pkgform-currency" label="Currency" value={currency} onChange={setCurrency}
            options={CURRENCIES.map(c => ({ value: c, label: c }))} />
        </div>
      </div>
      <Inp id="pkgform-hscode" label="HS Code" value={hsCode} onChange={setHsCode}
        placeholder={containerHsCode ? `Container default: ${containerHsCode}` : "e.g. 8471.30"}
        hint="Optional override — leave blank to use the container's own HS code" />

      <div style={{ background: T.bg, border: `1px solid ${isDg ? T.danger + "55" : T.border}`,
        borderRadius: 8, padding: "10px 12px", transition: "border-color .15s" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: T.body, fontSize: 10.5, color: isDg ? T.danger : T.textMuted,
            fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em", display: "flex", alignItems: "center", gap: 4 }}>
            <IconWarning size={11} /> Dangerous Goods
          </span>
          <BtnToggle selected={isDg} onClick={() => { setIsDg(v => !v); setDgClass(""); }}>{isDg ? "DG ON" : "DG OFF"}</BtnToggle>
        </div>
        {isDg && (
          <div style={{ marginTop: 10 }}>
            <Sel id="pkgform-dgclass" label="IMDG Class" value={dgClass} onChange={setDgClass} required
              options={[{ value: "", label: "— Select IMDG class —" }, ...IMDG_CLASSES.map(c => ({ value: c.code, label: `${c.label} — ${c.name}` }))]} />
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", paddingTop: 4 }}>
        <div>
          {!isNew && canEdit && <Btn id="pkgform-delete-btn" variant="danger" size="sm" onClick={onDelete}>Delete</Btn>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!isNew && canEdit && <Btn id="pkgform-addchild-btn" variant="secondary" size="sm" onClick={onAddChild}>＋ Add Sub-Package</Btn>}
          {isNew && <Btn id="pkgform-cancel-btn" variant="secondary" onClick={onCancel}>Cancel</Btn>}
          <Btn id="pkgform-save-btn" disabled={!valid || saving}
            onClick={() => valid && onSave({ description: description.trim(), quantity: qty, packTypeId: packTypeId || null,
              isDg, dgClass: isDg ? dgClass : "", unitValue: uv, currency: uv != null ? currency : "", hsCode: hsCode.trim() })}>
            {saving ? "Saving…" : isNew ? "Add Package" : "Save Changes"}
          </Btn>
        </div>
      </div>
    </div>
  );
};

export { NavRow, PackageDetailForm };
