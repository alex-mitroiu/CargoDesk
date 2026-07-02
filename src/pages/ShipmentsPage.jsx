import { useState, useEffect, useRef } from "react";
import { T, CONTRACT_PRESETS, CONTAINER_TYPES, STATUSES, INCOTERMS_2020,
         statusVariant, contractVariant, teuOf, addDays, diffDays } from "../tokens";
import { api } from "../api";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import DatePicker from "../components/primitives/DatePicker";
import PortField from "../components/shared/PortField";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import { VesselField } from "../components/shared/VesselCombobox";
import { inputBase, BtnToggle, Inp, Sel, Textarea, Field, ContractTypeInput } from "../components/primitives/Form";
import { CommodityCombobox } from "../components/shared/CommodityCombobox";
import CustomerCombobox from "../components/shared/CustomerCombobox";
import Spinner from "../components/primitives/Spinner";
import { useResizableColumns, ColResizer } from "../components/primitives/useResizableColumns";
import ActionMenu from "../components/primitives/ActionMenu";
import EntityHistoryModal from "../components/shared/EntityHistoryModal";

// ─── Contract Picker Modal (Central) ──────────────────────────────────────────

const ContractPickerModal = ({ pol, pod, matches, onSelect, onClose }) => {
  const kindBadge = kind => kind === "exact"
    ? { label: "Exact match",     bg: T.success + "22", color: T.success }
    : { label: "Via linked port", bg: T.info    + "22", color: T.info    };

  const totalUsd = rates => rates && rates.length ? rates.reduce((s, r) => s + r.amountUsd, 0) : null;

  // Sort matches by total cost ascending; contracts with no rates go last
  const sorted = matches ? [...matches].sort((a, b) => {
    const ta = totalUsd(a.rates) ?? Infinity;
    const tb = totalUsd(b.rates) ?? Infinity;
    return ta - tb;
  }) : matches;

  const lowestTotal = sorted && sorted.length > 0
    ? Math.min(...sorted.map(c => totalUsd(c.rates) ?? Infinity).filter(v => v < Infinity))
    : null;

  return (
    <Modal title={`Select Contract — ${pol} → ${pod}`} onClose={onClose} width={660}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sorted === null && (
          <div style={{ padding: 40, display: "flex", justifyContent: "center" }}>
            <Spinner />
          </div>
        )}

        {sorted !== null && sorted.length === 0 && (
          <div style={{ padding: "32px 0", textAlign: "center",
            fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            No active contracts found for {pol} → {pod} within the ETD validity window.
          </div>
        )}

        {sorted !== null && sorted.length > 1 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end",
            gap: 2, paddingRight: 2 }}>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
              Sorted by lowest buy rate · {sorted.length} contracts
            </span>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
              All prices expressed in USD
            </span>
          </div>
        )}

        {sorted !== null && sorted.map((c, idx) => {
          const k      = kindBadge(c.matchKind);
          const rates  = c.rates || [];
          const total  = totalUsd(rates);
          const isBest = lowestTotal !== null && total === lowestTotal && sorted.length > 1;
          const fmtUsd = v => `$${Math.round(v).toLocaleString("en-US")}`;

          return (
            <button key={c.id} type="button" onClick={() => onSelect(c)}
              style={{ display: "flex", alignItems: "center", gap: 14, width: "100%",
                padding: "12px 14px", background: T.bg,
                border: `1px solid ${isBest ? T.success + "88" : T.border}`, borderRadius: 8,
                cursor: "pointer", textAlign: "left", transition: "border-color .15s" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = T.accent}
              onMouseLeave={e => e.currentTarget.style.borderColor = isBest ? T.success + "88" : T.border}>

              {/* Left: all contract info */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>

                {/* Line 1: number · match badge · best-rate badge · rank */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>
                    {c.contractNumber}
                  </span>
                  <span style={{ background: k.bg, color: k.color,
                    padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>
                    {k.label}
                  </span>
                  {isBest && (
                    <span style={{ background: T.success + "22", color: T.success,
                      padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>
                      Best rate
                    </span>
                  )}
                  {sorted.length > 1 && (
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                      #{idx + 1}
                    </span>
                  )}
                </div>

                {/* Line 2: validity · linked port hints */}
                <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                    Valid {c.validFrom} → {c.validTo}
                  </span>
                  {c.linkedPolVia && (
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.info }}>
                      POL via {c.linkedPolVia}
                    </span>
                  )}
                  {c.linkedPodVia && (
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.info }}>
                      POD via {c.linkedPodVia}
                    </span>
                  )}
                </div>

                {/* Line 3: route legs */}
                {c.legs && c.legs.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {c.legs.map((l, i) => (
                      <span key={i} style={{ fontFamily: T.mono, fontSize: 11,
                        background: T.surface, border: `1px solid ${T.border}`,
                        borderRadius: 4, padding: "2px 8px", color: T.text }}>
                        {l.pol} → {l.pod}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Right: bold total buy rate + carrier */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end",
                gap: 4, flexShrink: 0, minWidth: 80 }}>
                {total !== null ? (
                  <span style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 700,
                    color: isBest ? T.success : T.text, letterSpacing: "-.01em" }}>
                    {fmtUsd(total)}
                  </span>
                ) : (
                  <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted }}>—</span>
                )}
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                  {c.carrierCode}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
};

// ─── ContractField ─────────────────────────────────────────────────────────────

const ContractField = ({ value, onChange, carrier, pol, pod, etd, contractType }) => {
  const isCentral = contractType === "Central";

  // Central: route-match state
  const [matches,    setMatches]    = useState(null);
  const [matching,   setMatching]   = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const matchTimer   = useRef(null);
  const autoSelected = useRef(false);

  // ── Central route-match ────────────────────────────────────────────────────
  useEffect(() => {
    clearTimeout(matchTimer.current);
    if (!isCentral) { setMatches(null); autoSelected.current = false; return; }
    if (!pol || !pod || !etd) { setMatches(null); return; }
    setMatching(true);
    matchTimer.current = setTimeout(async () => {
      try {
        const params = { pol, pod, etd };
        if (carrier) params.carrier = carrier;
        const res = await api.contracts.match(params);
        setMatches(res);
        // Auto-select when exactly one match and nothing is chosen yet
        if (res.length === 1 && !value.id && !autoSelected.current) {
          autoSelected.current = true;
          onChange({ id: res[0].id, ref: res[0].contractNumber });
        }
      } catch {
        setMatches([]);
      } finally {
        setMatching(false);
      }
    }, 400);
  }, [isCentral, pol, pod, etd, carrier]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearContract = () => {
    onChange({ id: "", ref: "" });
    autoSelected.current = false;
  };

  const pickContract = c => {
    onChange({ id: c.id, ref: c.contractNumber });
    setPickerOpen(false);
  };

  const allReady = pol && pod && etd;

  // ── Render ─────────────────────────────────────────────────────────────────
  if (isCentral) {
    const browseLabel = matching
      ? "Searching…"
      : matches === null || !allReady
        ? "Browse matching contracts…"
        : matches.length === 0
          ? "No contracts found for this route"
          : `${matches.length} contract${matches.length !== 1 ? "s" : ""} found — click to select`;

    const browseDisabled = !allReady || (matches !== null && matches.length === 0);

    return (
      <Field label="Contract Ref">
        {value.id ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
            background: T.bg, border: `1px solid ${T.accent}55`, borderRadius: 6 }}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700, flex: 1 }}>
              {value.ref}
            </span>
            <button type="button" onClick={() => setPickerOpen(true)}
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 4,
                cursor: "pointer", color: T.text, fontFamily: T.body, fontSize: 11,
                padding: "2px 8px" }}>
              Change
            </button>
            <button type="button" onClick={clearContract}
              style={{ background: "none", border: "none", cursor: "pointer",
                color: T.textMuted, fontSize: 13, padding: "0 2px", lineHeight: 1 }}>
              ✕
            </button>
          </div>
        ) : (
          <button type="button"
            onClick={() => !browseDisabled && setPickerOpen(true)}
            style={{ ...inputBase, width: "100%", cursor: browseDisabled ? "default" : "pointer",
              textAlign: "left", fontFamily: T.body, fontSize: 13,
              color: matches !== null && matches.length === 0 ? T.danger : T.textMuted,
              background: T.bg, borderStyle: !allReady ? "solid" : "dashed",
              opacity: browseDisabled && allReady ? 0.6 : 1 }}>
            {browseLabel}
          </button>
        )}

        {pickerOpen && (
          <ContractPickerModal
            pol={pol} pod={pod}
            matches={matches}
            onSelect={pickContract}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </Field>
    );
  }

};

const ShipmentForm = ({ init = {}, onSave, onCancel }) => {
  const [polPort, setPolPort] = useState(init.pol ? { unlocode: init.pol, name: "" } : null);
  const [podPort, setPodPort] = useState(init.pod ? { unlocode: init.pod, name: "" } : null);
  const [f, setF] = useState({
    carrierCode:   init.carrierCode   || "",
    contractType:  init.contractType  || "SPOT",
    contractNotes: init.contractNotes || "",
    status:        init.status        || "Active",
    etd:           init.etd           || "",
    eta:           init.eta           || "",
    bookingRef:    init.bookingRef     || "",
    blNumber:      init.blNumber      || "",
    vessel:        init.vessel        || "",
    vesselImo:     init.vesselImo     || "",
    voyage:        init.voyage        || "",
    incoterm:      init.incoterm      || "",
    contractId:    init.contractId     || "",
    contractRef:   init.contractRef    || "",
    commodityCode: init.commodityCode  || "",
    shipperId:     init.shipperId      || "",
    shipperName:   init.shipperName    || "",
    consigneeId:   init.consigneeId    || "",
    consigneeName: init.consigneeName  || "",
    principalId:   init.principalId    || "",
    principalName: init.principalName  || "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const set = k => v => setF(p => ({ ...p, [k]: v }));

  const isCentral = f.contractType === "Central";
  const valid = polPort?.unlocode?.length === 5 && podPort?.unlocode?.length === 5
    && f.carrierCode && f.contractType.trim().length > 0 && f.incoterm !== ""
    && f.commodityCode.trim().length > 0
    && (!isCentral || f.contractId.trim().length > 0);

  const handleSave = async () => {
    if (!valid) return;
    setIsSaving(true);
    try {
      await onSave({ ...f, pol: polPort.unlocode, pod: podPort.unlocode });
    } finally { setIsSaving(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Parties */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <CustomerCombobox label="Shipper"
          value={{ id: f.shipperId, name: f.shipperName }}
          onChange={v => setF(p => ({ ...p, shipperId: v.id, shipperName: v.name }))} />
        <CustomerCombobox label="Consignee"
          value={{ id: f.consigneeId, name: f.consigneeName }}
          onChange={v => setF(p => ({ ...p, consigneeId: v.id, consigneeName: v.name }))} />
        <CustomerCombobox label="Principal"
          value={{ id: f.principalId, name: f.principalName }}
          onChange={v => setF(p => ({ ...p, principalId: v.id, principalName: v.name }))} />
      </div>

      {/* Ports */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <PortField label="Port of Loading"   value={polPort} onChange={setPolPort} placeholder="Search POL (NLRTM, Rotterdam…)" required />
        <PortField label="Port of Discharge" value={podPort} onChange={setPodPort} placeholder="Search POD (CNSHA, Shanghai…)" required />
      </div>

      {/* Carrier */}
      <Field label="Carrier" required>
        <CarrierCombobox value={f.carrierCode} onChange={set("carrierCode")} />
      </Field>

      {/* Incoterm — mandatory */}
      <Sel label="Incoterm" value={f.incoterm} onChange={set("incoterm")} required
        options={[
          { value: "", label: "Select incoterm…" },
          ...INCOTERMS_2020.map(t => ({ value: t.code, label: `${t.code} – ${t.name}` })),
        ]}
      />

      {/* Commodity — mandatory, core cargo identity */}
      <Field label="Commodity" required hint="Maersk freight type — determines handling, documentation, and service eligibility">
        <CommodityCombobox
          value={f.commodityCode}
          onChange={v => set("commodityCode")(v)}
        />
      </Field>

      {/* Dates + references */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <DatePicker label="ETD" value={f.etd} onChange={set("etd")} hint="Estimated Departure" />
        <DatePicker label="ETA" value={f.eta} onChange={set("eta")} hint="Estimated Arrival"
          minDate={f.etd || undefined} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Booking Reference" value={f.bookingRef} onChange={set("bookingRef")} placeholder="BK-2025-00123" mono />
        <Inp label="B/L Number"        value={f.blNumber}   onChange={set("blNumber")}   placeholder="MAEU123456789" mono />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <VesselField
          vessel={f.vesselImo ? { imo: f.vesselImo, name: f.vessel } : null}
          onSelect={v => setF(p => ({ ...p, vessel: v ? v.name : "", vesselImo: v ? v.imo : "" }))}
        />
        <Inp label="Voyage" value={f.voyage} onChange={set("voyage")} placeholder="423E" mono />
      </div>

      {/* Contract */}
      <ContractTypeInput value={f.contractType} onChange={v => {
        // Clearing the linked contract when switching away from Central
        if (v !== "Central") setF(p => ({ ...p, contractType: v, contractId: "", contractRef: "" }));
        else set("contractType")(v);
      }} />
      {isCentral && (
        <ContractField
          value={{ id: f.contractId, ref: f.contractRef }}
          onChange={({ id, ref }) => setF(p => ({ ...p, contractId: id, contractRef: ref }))}
          carrier={f.carrierCode}
          pol={polPort?.unlocode}
          pod={podPort?.unlocode}
          etd={f.etd}
          contractType={f.contractType}
        />
      )}
      {!isCentral && (
        <Inp label="Contract Reference" value={f.contractRef} onChange={v => setF(p => ({ ...p, contractRef: v }))}
          placeholder="e.g. SPOT-2025-001" mono hint="Free-text reference for this contract arrangement" />
      )}
      <Textarea label="Contract Notes" value={f.contractNotes} onChange={set("contractNotes")}
        placeholder="Optional reference, contract IDs, remarks…" rows={2} />
      <Sel label="Status" value={f.status} onChange={set("status")}
        options={STATUSES.map(s => ({ value: s, label: s }))} />

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={handleSave} disabled={!valid}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {isSaving && <Spinner size="sm" color="currentColor" />}
            {isSaving ? "Saving…" : (init.id ? "Save Changes" : "Create Shipment")}
          </span>
        </Btn>
      </div>
    </div>
  );
};

const ShipmentsPage = ({ shipments, containers, carriers, onSelect, onDelete, onNew, financeEnabled = true }) => {
  const [confirm,       setConfirm]       = useState(null);
  const [historyShipment, setHistoryShipment] = useState(null);
  const [filters,  setFilters]  = useState({ search: '', status: '', carrier: '' });
  const teuFor = id => containers.filter(c => c.shipmentId === id).reduce((s, c) => s + teuOf(c.size), 0);
  const { template: shipTemplate, startResize: shipStartResize } = useResizableColumns("shipments", [140,70,70,150,165,46,60,80,130,90]);
  const shipHeaders = ["Shipment ID","POL","POD","Carrier","Contract","TEU","Status","Margin","Actions"];

  const filtered = shipments.filter(s => {
    if (filters.status  && s.status      !== filters.status)  return false;
    if (filters.carrier && s.carrierCode !== filters.carrier) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!s.id.toLowerCase().includes(q)
        && !s.pol.toLowerCase().includes(q)
        && !s.pod.toLowerCase().includes(q)
        && !(s.bookingRef || '').toLowerCase().includes(q)
        && !(s.blNumber   || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const hasFilters = !!(filters.search || filters.status || filters.carrier);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Shipments</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {hasFilters ? `${filtered.length} of ${shipments.length}` : shipments.length} total
            · {shipments.filter(s => s.status === "Active").length} active
          </p>
        </div>
        <Btn onClick={onNew} size="lg" disabled={carriers.length === 0}>＋ New Shipment</Btn>
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={filters.search}
          onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
          placeholder="Search ID, POL, POD, booking ref…"
          style={{ ...inputBase, flex: "1 1 200px", minWidth: 160 }}
        />
        <select
          value={filters.status}
          onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
          style={{ ...inputBase, width: 148, cursor: "pointer" }}
        >
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={filters.carrier}
          onChange={e => setFilters(f => ({ ...f, carrier: e.target.value }))}
          style={{ ...inputBase, width: 180, cursor: "pointer" }}
        >
          <option value="">All carriers</option>
          {carriers.map(c => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}
        </select>
        {hasFilters && (
          <button
            onClick={() => setFilters({ search: '', status: '', carrier: '' })}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
              color: T.textMuted, cursor: "pointer", padding: "6px 12px",
              fontFamily: T.body, fontSize: 12, whiteSpace: "nowrap" }}>
            ✕ Clear
          </button>
        )}
      </div>

      {carriers.length === 0 && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8,
          padding: "12px 18px", fontFamily: T.body, fontSize: 13, color: T.warning, marginBottom: 18 }}>
          ⚠ Carrier Registry is empty. Go to <strong>Carrier Registry</strong> and add at least one carrier before creating shipments.
        </div>
      )}

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: shipTemplate,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {shipHeaders.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < shipHeaders.length - 1 && <ColResizer onStart={e => shipStartResize(i, e)} />}
            </div>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            {hasFilters ? "No shipments match your filters." : "No shipments yet. Create your first one above."}
          </div>
        ) : filtered.map(s => {
          const carrier = carriers.find(c => c.code === s.carrierCode);
          return (
            <div key={s.id} onClick={() => window.open(`#shipments/${s.id}`, "_blank")}
              style={{ display: "grid", gridTemplateColumns: shipTemplate,
                padding: "14px 20px", borderBottom: `1px solid ${T.border}22`,
                cursor: "pointer", alignItems: "center", transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textCode, fontWeight: 700 }}>{s.id}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pol}</span>
                {s.polName && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{s.polName}</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 700 }}>{s.pod}</span>
                {s.podName && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{s.podName}</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{s.carrierCode}</span>
                {carrier && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{carrier.name}</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "center" }}>
                <Badge variant={contractVariant(s.contractType)}>{s.contractType}</Badge>
                {s.contractRef && <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>{s.contractRef}</span>}
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>{teuFor(s.id)}</span>
              <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
              <div>{(() => {
                if (!financeEnabled) return null;
                const buy = s.marginBuyUsd || 0, sell = s.marginSellUsd || 0;
                if (buy === 0 && sell === 0) return <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>;
                const gp  = sell - buy;
                const pct = sell > 0 ? Math.round((gp / sell) * 1000) / 10 : null;
                const col = pct == null ? T.textMuted : pct >= 20 ? T.success : pct >= 10 ? T.warning : T.danger;
                return (
                  <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                    color: col, background: `${col}18`, borderRadius: 6, padding: "2px 8px",
                    border: `1px solid ${col}33` }}>
                    {pct != null ? `${pct}%` : "—"}
                  </span>
                );
              })()}</div>
              <div onClick={e => e.stopPropagation()}>
                <ActionMenu items={[
                  { icon: "↗", label: "Open",    onClick: () => window.open(`#shipments/${s.id}`, "_blank") },
                  { icon: "📋", label: "History", onClick: () => setHistoryShipment(s) },
                  { icon: "✕", label: "Delete",  variant: "danger", onClick: () => setConfirm(s.id) },
                ]} />
              </div>
            </div>
          );
        })}
      </div>

      {confirm && (
        <ConfirmModal
          message={`Remove shipment ${confirm} and all its containers? This cannot be undone.`}
          onConfirm={() => { onDelete(confirm); setConfirm(null); }}
          onCancel={() => setConfirm(null)} />
      )}
      {historyShipment && (
        <EntityHistoryModal
          entityType="shipment"
          entityId={historyShipment.id}
          title={`History — ${historyShipment.id}`}
          headerContent={
            <>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{historyShipment.id}</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{historyShipment.pol} → {historyShipment.pod}</span>
              {historyShipment.carrierCode && <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{historyShipment.carrierCode}</span>}
              {historyShipment.etd && <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>ETD {historyShipment.etd}</span>}
            </>
          }
          onClose={() => setHistoryShipment(null)} />
      )}
    </div>
  );
};

// ─── Page: Shipment Detail ────────────────────────────────────────────────────

export { ShipmentForm };
export default ShipmentsPage;