import { useState, useEffect, useRef, useCallback } from "react";
import { T, CONTRACT_PRESETS, CONTAINER_TYPES, STATUSES, INCOTERMS_2020,
         statusVariant, contractVariant, teuOf, addDays, diffDays } from "../tokens";
import { api } from "../api";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import DatePicker from "../components/primitives/DatePicker";
import PortCombobox from "../components/shared/PortCombobox";
import { VesselField } from "../components/shared/VesselCombobox";
import { inputBase, BtnToggle, Inp, Sel, Textarea, Field, ContractTypeInput } from "../components/primitives/Form";
import { CommodityCombobox } from "../components/shared/CommodityCombobox";
import CustomerCombobox from "../components/shared/CustomerCombobox";
import Spinner from "../components/primitives/Spinner";
import { useResizableColumns, ColResizer } from "../components/primitives/useResizableColumns";

// ─── Local ContractField component ────────────────────────────────────────────

const ContractField = ({ value, onChange, carrier, pol, pod, etd, contractType }) => {
  const isCentral = contractType === "Central Contract";

  const [q,        setQ]        = useState(value.ref || "");
  const [results,  setResults]  = useState([]);
  const [open,     setOpen]     = useState(false);
  const [dropStyle,setDropStyle]= useState({});
  const [matches,  setMatches]  = useState(null);
  const [matching, setMatching] = useState(false);
  const timer      = useRef(null);
  const matchTimer = useRef(null);
  const inputRef   = useRef(null);
  const dropRef    = useRef(null);
  const qRef       = useRef(q);

  useEffect(() => { setQ(value.ref || ""); }, [value.ref]);
  useEffect(() => { qRef.current = q; }, [q]);

  const positionDrop = useCallback(() => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropStyle({ position: "fixed", top: r.bottom + 4, left: r.left, width: r.width, zIndex: 9000 });
  }, []);

  // Close typeahead on outside click (only relevant when not Central Contract)
  useEffect(() => {
    const h = e => {
      if (inputRef.current && !inputRef.current.contains(e.target) &&
          dropRef.current  && !dropRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  useEffect(() => {
    if (!open) return;
    const upd = () => positionDrop();
    window.addEventListener("scroll", upd, true);
    window.addEventListener("resize", upd);
    return () => { window.removeEventListener("scroll", upd, true); window.removeEventListener("resize", upd); };
  }, [open, positionDrop]);

  // Text-based typeahead — only active when NOT Central Contract
  const search = v => {
    setQ(v);
    onChange({ id: "", ref: v });
    clearTimeout(timer.current);
    if (!v.trim()) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const res = await api.contracts.find({ q: v, carrier, asOf: new Date().toISOString().slice(0, 10) });
        setResults(res);
        if (res.length) { positionDrop(); setOpen(true); }
      } catch {}
    }, 250);
  };

  const select = c => {
    setQ(c.contractNumber);
    onChange({ id: c.id, ref: c.contractNumber });
    setResults([]);
    setOpen(false);
  };

  const clearContract = () => {
    onChange({ id: "", ref: "" });
    setQ("");
    setMatches(null);
  };

  // Route-based matching — only runs for Central Contract
  useEffect(() => {
    clearTimeout(matchTimer.current);
    if (!isCentral || !pol || !pod || !etd) { setMatches(null); return; }
    setMatching(true);
    matchTimer.current = setTimeout(async () => {
      try {
        const params = { pol, pod, etd };
        if (carrier) params.carrier = carrier;
        const res = await api.contracts.match(params);
        setMatches(res);
        if (res.length === 1 && !qRef.current) {
          onChange({ id: res[0].id, ref: res[0].contractNumber });
          setQ(res[0].contractNumber);
        }
      } catch {
        setMatches([]);
      } finally {
        setMatching(false);
      }
    }, 400);
  }, [isCentral, pol, pod, etd, carrier]); // eslint-disable-line react-hooks/exhaustive-deps

  // When switching away from Central Contract, clear the matched contract
  useEffect(() => {
    if (!isCentral) { setMatches(null); }
  }, [isCentral]);

  const allReady = pol && pod && etd;

  const kindBadge = kind => kind === "exact"
    ? { label: "Exact",           bg: T.success + "22", color: T.success }
    : { label: "Via linked port", bg: T.info    + "22", color: T.info    };

  return (
    <Field label="Contract Ref">
      {/* Selected contract chip (Central Contract with a resolved ID) */}
      {isCentral && value.id ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
          background: T.bg, border: `1px solid ${T.accent}55`, borderRadius: 6 }}>
          <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700, flex: 1 }}>
            {q || value.ref}
          </span>
          <button type="button" onClick={clearContract}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 12, padding: 0 }}>
            ✕ clear
          </button>
        </div>
      ) : (
        <div>
          <input
            ref={inputRef}
            value={q}
            readOnly={isCentral}
            onChange={isCentral ? undefined : e => search(e.target.value)}
            onFocus={isCentral ? undefined : () => { if (results.length > 0) { positionDrop(); setOpen(true); } }}
            placeholder={isCentral ? "Select a contract via route match below…" : "Contract number…"}
            style={{
              ...inputBase, width: "100%", fontFamily: T.mono, fontSize: 13,
              ...(isCentral ? { background: T.bg, color: T.textMuted, cursor: "default" } : {}),
            }}
          />
          {/* Typeahead dropdown — non-Central only */}
          {!isCentral && open && results.length > 0 && (
            <div ref={dropRef} style={{ ...dropStyle,
              background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6,
              boxShadow: "0 6px 20px rgba(0,0,0,.35)", overflow: "hidden", maxHeight: 260, overflowY: "auto" }}>
              {results.map(c => (
                <button key={c.id} type="button" onClick={() => select(c)}
                  style={{ display: "flex", flexDirection: "column", gap: 2,
                    width: "100%", padding: "8px 12px", background: "none",
                    border: "none", borderBottom: `1px solid ${T.border}22`,
                    cursor: "pointer", textAlign: "left" }}
                  onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>
                    {c.contractNumber}
                  </span>
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                    {c.carrierCode} · {c.validFrom} → {c.validTo}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Route-match panel — Central Contract only */}
      {isCentral && !value.id && allReady && (
        <div style={{ marginTop: 8, padding: "10px 12px", background: T.bg,
          border: `1px solid ${T.border}`, borderRadius: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6,
            marginBottom: (!matching && matches && matches.length > 0) ? 8 : 0 }}>
            <span style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".08em" }}>Route Match</span>
            {matching && <Spinner size="sm" />}
          </div>

          {!matching && matches !== null && (
            <>
              {matches.length === 0 && (
                <p style={{ margin: 0, fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                  No active contracts cover {pol} → {pod} within the ETD validity window.
                </p>
              )}

              {matches.length === 1 && (() => {
                const k = kindBadge(matches[0].matchKind);
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: T.body, fontSize: 12, color: T.success }}>✓ Auto-matched</span>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>
                      {matches[0].contractNumber}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                      {matches[0].carrierCode} · {matches[0].validFrom} → {matches[0].validTo}
                    </span>
                    <span style={{ background: k.bg, color: k.color,
                      padding: "1px 7px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>
                      {k.label}
                    </span>
                  </div>
                );
              })()}

              {matches.length > 1 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, display: "block", marginBottom: 2 }}>
                    {matches.length} contracts match this route — select one:
                  </span>
                  {matches.map(c => {
                    const k   = kindBadge(c.matchKind);
                    const sel = value.id === c.id;
                    return (
                      <button key={c.id} type="button"
                        onClick={() => { onChange({ id: c.id, ref: c.contractNumber }); setQ(c.contractNumber); }}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                          background: sel ? T.accent + "18" : T.surface,
                          border: `1px solid ${sel ? T.accent : T.border}`,
                          borderRadius: 6, cursor: "pointer", textAlign: "left", width: "100%" }}>
                        <span style={{ width: 12, height: 12, borderRadius: "50%", flexShrink: 0,
                          border: `2px solid ${sel ? T.accent : T.border}`,
                          background: sel ? T.accent : "transparent" }} />
                        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>
                          {c.contractNumber}
                        </span>
                        <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, flex: 1 }}>
                          {c.carrierCode} · {c.validFrom} → {c.validTo}
                        </span>
                        {c.linkedPolVia && (
                          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                            POL via {c.linkedPolVia}
                          </span>
                        )}
                        {c.linkedPodVia && (
                          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                            POD via {c.linkedPodVia}
                          </span>
                        )}
                        <span style={{ background: k.bg, color: k.color, flexShrink: 0,
                          padding: "1px 7px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>
                          {k.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Hint when Central Contract but POL/POD/ETD not yet set */}
      {isCentral && !value.id && !allReady && (
        <p style={{ margin: "6px 0 0", fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
          Set POL, POD, and ETD to find matching contracts.
        </p>
      )}
    </Field>
  );
};

const ShipmentForm = ({ init = {}, carriers, onSave, onCancel }) => {
  const [polPort, setPolPort] = useState(init.pol ? { unlocode: init.pol, name: "" } : null);
  const [podPort, setPodPort] = useState(init.pod ? { unlocode: init.pod, name: "" } : null);
  const [f, setF] = useState({
    carrierCode:   init.carrierCode   || carriers[0]?.code || "",
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

  const isCentral = f.contractType === "Central Contract";
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

  const PortField = ({ label, port, onSelect, placeholder }) => (
    <Field label={label} required>
      {port?.unlocode ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ flex: 1, background: T.bg, border: `1px solid ${T.accent}55`, borderRadius: 6,
            padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{port.unlocode}</span>
            {port.name && <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{port.name}</span>}
          </div>
          <button onClick={() => onSelect(null)}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
              color: T.textMuted, cursor: "pointer", padding: "6px 10px", fontSize: 12 }}>✕</button>
        </div>
      ) : (
        <PortCombobox placeholder={placeholder} onChange={onSelect} />
      )}
    </Field>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {carriers.length === 0 && (
        <div style={{ background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8,
          padding: "12px 16px", fontFamily: T.body, fontSize: 13, color: T.warning }}>
          ⚠ No carriers in registry. Add a carrier first before creating a shipment.
        </div>
      )}

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
        <PortField label="Port of Loading"   port={polPort} onSelect={setPolPort} placeholder="Search POL (NLRTM, Rotterdam…)" />
        <PortField label="Port of Discharge" port={podPort} onSelect={setPodPort} placeholder="Search POD (CNSHA, Shanghai…)" />
      </div>

      {/* Carrier */}
      {carriers.length > 0 && (
        <Sel label="Carrier" value={f.carrierCode} onChange={set("carrierCode")} required
          options={carriers.map(c => ({ value: c.code, label: `${c.code} – ${c.name}` }))} />
      )}

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
        // Clearing the linked contract when switching away from Central Contract
        if (v !== "Central Contract") setF(p => ({ ...p, contractType: v, contractId: "", contractRef: "" }));
        else set("contractType")(v);
      }} />
      <ContractField
        value={{ id: f.contractId, ref: f.contractRef }}
        onChange={({ id, ref }) => setF(p => ({ ...p, contractId: id, contractRef: ref }))}
        carrier={f.carrierCode}
        pol={polPort?.unlocode}
        pod={podPort?.unlocode}
        etd={f.etd}
        contractType={f.contractType}
      />
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
        <Btn onClick={handleSave} disabled={!valid || carriers.length === 0}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {isSaving && <Spinner size="sm" color="currentColor" />}
            {isSaving ? "Saving…" : (init.id ? "Save Changes" : "Create Shipment")}
          </span>
        </Btn>
      </div>
    </div>
  );
};

const ShipmentsPage = ({ shipments, containers, carriers, onSelect, onDelete, onNew }) => {
  const [confirm,  setConfirm]  = useState(null);
  const [filters,  setFilters]  = useState({ search: '', status: '', carrier: '' });
  const teuFor = id => containers.filter(c => c.shipmentId === id).reduce((s, c) => s + teuOf(c.size), 0);
  const { template: shipTemplate, startResize: shipStartResize } = useResizableColumns("shipments", [140,70,70,150,165,46,60,130,90]);
  const shipHeaders = ["Shipment ID","POL","POD","Carrier","Contract","TEU","Status",""];

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
            <div key={i} style={{ position: "relative", fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
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
            <div key={s.id} onClick={() => onSelect(s.id)}
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
              <div>
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{s.carrierCode}</span>
                {carrier && <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}> · {carrier.name}</span>}
              </div>
              <Badge variant={contractVariant(s.contractType)}>{s.contractType}</Badge>
              <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>{teuFor(s.id)}</span>
              <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
              <Btn size="sm" variant="danger" onClick={e => { e.stopPropagation(); setConfirm(s.id); }}>
                ✕ Remove
              </Btn>
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
    </div>
  );
};

// ─── Page: Shipment Detail ────────────────────────────────────────────────────

export { ShipmentForm };
export default ShipmentsPage;