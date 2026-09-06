import { useState, useEffect } from "react";
import { T, CURRENCIES } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import Spinner from "../primitives/Spinner";
import DatePicker from "../primitives/DatePicker";
import { Inp, Sel, Textarea } from "../primitives/Form";
import { inputBase } from "../primitives/Form";
import { GPS_LOC_TYPE, LOC_TYPE_OPTIONS } from "../../utils/legLocation";

// ─── Merchant's Haulage Details Panel ──────────────────────────────────────────
// Self-fetching shared panel opened in a Modal from LoadingServicePage.jsx's per-container
// row, same idiom AdditionalPartiesPanel.jsx/ContainerEventsPanel.jsx already establish —
// only ever rendered for a Pickup/Delivery service whose covering leg is Merchant's Haulage
// (that gate lives in the parent page, not here). `record` is passed down already-fetched
// (the parent page loads the whole per-container list once, same as it already does for the
// loading-plan `lines`); this panel only self-fetches its own nested waypoints list.

const WAYPOINT_LOC_OPTIONS = [...LOC_TYPE_OPTIONS, GPS_LOC_TYPE].map(v => ({ value: v, label: v }));
const CURRENCY_OPTIONS = CURRENCIES.map(c => ({ value: c, label: c }));

const WaypointRow = ({ wp, canEdit, onSave, onRemove }) => {
  const [editing, setEditing] = useState(false);
  const [locType, setLocType] = useState(wp.locType);
  const [location, setLocation] = useState(wp.location);
  const [latitude, setLatitude] = useState(wp.latitude != null ? String(wp.latitude) : "");
  const [longitude, setLongitude] = useState(wp.longitude != null ? String(wp.longitude) : "");
  const [notes, setNotes] = useState(wp.notes || "");
  const [saving, setSaving] = useState(false);
  const isGps = locType === GPS_LOC_TYPE;

  const save = async () => {
    setSaving(true);
    try {
      await onSave(wp.id, {
        locType, location: isGps ? "" : location,
        latitude: isGps ? (latitude === "" ? null : Number(latitude)) : null,
        longitude: isGps ? (longitude === "" ? null : Number(longitude)) : null,
        notes, sequenceOrder: wp.sequenceOrder,
      });
      setEditing(false);
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  if (!editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
        background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px" }}>
        <div>
          <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.accent,
            background: `${T.accent}18`, border: `1px solid ${T.accent}33`, borderRadius: 4,
            padding: "1px 6px", marginRight: 8 }}>
            #{wp.sequenceOrder}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, fontWeight: 600 }}>{wp.locType}</span>
          {" — "}
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
            {wp.locType === GPS_LOC_TYPE
              ? (wp.latitude != null && wp.longitude != null ? `${wp.latitude}, ${wp.longitude}` : "No coordinates set")
              : (wp.location || "No location set")}
          </span>
          {wp.notes && <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginTop: 2 }}>{wp.notes}</div>}
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
            <button type="button" title="Edit" onClick={() => setEditing(true)}
              style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 13 }}
              onMouseEnter={e => e.currentTarget.style.color = T.text}
              onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>✎</button>
            <button type="button" title="Remove" onClick={() => onRemove(wp.id)}
              style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 15, lineHeight: 1 }}
              onMouseEnter={e => e.currentTarget.style.color = T.danger}
              onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>×</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12,
      borderRadius: 8, border: `1px dashed ${T.accent}55`, background: T.bg }}>
      <Sel label="Location Type" value={locType} onChange={setLocType} options={WAYPOINT_LOC_OPTIONS} />
      {isGps ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Inp label="Latitude" value={latitude} onChange={setLatitude} placeholder="-90 to 90" />
          <Inp label="Longitude" value={longitude} onChange={setLongitude} placeholder="-180 to 180" />
        </div>
      ) : (
        <Inp label="Location" value={location} onChange={setLocation} placeholder="Address, depot name, or UN/LOCODE" />
      )}
      <Inp label="Notes (optional)" value={notes} onChange={setNotes} />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn size="sm" variant="secondary" onClick={() => setEditing(false)}>Cancel</Btn>
        <Btn size="sm" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Btn>
      </div>
    </div>
  );
};

const HaulageDetailsPanel = ({ shipmentId, serviceId, record, canEdit, onRecordUpdated }) => {
  const [gateInAt, setGateInAt]   = useState(record.gateInAt || "");
  const [gateOutAt, setGateOutAt] = useState(record.gateOutAt || "");
  const [driverName, setDriverName]     = useState(record.driverName || "");
  const [driverIdNumber, setDriverIdNumber] = useState(record.driverIdNumber || "");
  const [instructions, setInstructions] = useState(record.instructions || "");
  const [costAmount, setCostAmount]     = useState(record.costAmount != null ? String(record.costAmount) : "");
  const [costCurrency, setCostCurrency] = useState(record.costCurrency || "USD");
  const [costExchangeRate, setCostExchangeRate] = useState(String(record.costExchangeRate ?? 1));
  const [costLineId, setCostLineId]     = useState(record.costLineId || "");
  const [fxRates, setFxRates] = useState({});
  const [savingField, setSavingField] = useState(null);
  const [waypoints, setWaypoints] = useState(null); // null = loading
  const [addingWp, setAddingWp] = useState(false);
  const [newWpLocType, setNewWpLocType] = useState("Door");
  const [newWpLocation, setNewWpLocation] = useState("");
  const [newWpLat, setNewWpLat] = useState("");
  const [newWpLng, setNewWpLng] = useState("");
  const [newWpNotes, setNewWpNotes] = useState("");
  const [wpSaving, setWpSaving] = useState(false);

  const containerId = record.containerId;

  useEffect(() => {
    api.fx.rates().then(setFxRates).catch(() => {});
    loadWaypoints();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadWaypoints = () =>
    api.haulage.waypoints.list(shipmentId, serviceId, containerId).then(setWaypoints).catch(() => setWaypoints([]));

  const savePlainFields = async (patch) => {
    setSavingField(Object.keys(patch)[0]);
    try {
      const updated = await api.haulage.update(shipmentId, serviceId, containerId, {
        gateInAt, gateOutAt, driverName, driverIdNumber, instructions, ...patch,
      });
      onRecordUpdated?.(updated);
    } catch (e) { toast.error(e.message || "Failed to save"); }
    setSavingField(null);
  };

  const handleCostCurrency = c => {
    setCostCurrency(c);
    if (c === "USD") { setCostExchangeRate("1"); return; }
    const rate = fxRates[c];
    if (rate) setCostExchangeRate(String(Math.round((1 / rate) * 100000) / 100000));
  };

  const saveCost = async () => {
    setSavingField("cost");
    try {
      const updated = await api.haulage.saveCost(shipmentId, serviceId, containerId, {
        amount: costAmount === "" ? null : Number(costAmount),
        currency: costCurrency, exchangeRate: Number(costExchangeRate) || 1,
      });
      setCostLineId(updated.costLineId || "");
      onRecordUpdated?.(updated);
      toast.success(updated.costLineId ? "Cost saved — BUY cost line created/updated" : "Cost cleared");
    } catch (e) { toast.error(e.message || "Failed to save cost"); }
    setSavingField(null);
  };

  const handleAddWaypoint = async () => {
    const isGps = newWpLocType === GPS_LOC_TYPE;
    setWpSaving(true);
    try {
      await api.haulage.waypoints.create(shipmentId, serviceId, containerId, {
        locType: newWpLocType, location: isGps ? "" : newWpLocation,
        latitude: isGps ? (newWpLat === "" ? null : Number(newWpLat)) : null,
        longitude: isGps ? (newWpLng === "" ? null : Number(newWpLng)) : null,
        notes: newWpNotes,
      });
      setAddingWp(false); setNewWpLocType("Door"); setNewWpLocation("");
      setNewWpLat(""); setNewWpLng(""); setNewWpNotes("");
      await loadWaypoints();
    } catch (e) { toast.error(e.message || "Failed to add waypoint"); }
    setWpSaving(false);
  };

  const handleSaveWaypoint = async (id, patch) => {
    await api.haulage.waypoints.update(shipmentId, id, patch);
    await loadWaypoints();
  };

  const handleRemoveWaypoint = async id => {
    try {
      await api.haulage.waypoints.remove(shipmentId, id);
      setWaypoints(list => list.filter(w => w.id !== id));
    } catch (e) { toast.error(e.message); }
  };

  const lbl = { fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
    textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={lbl}>Gate Activity</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Gate In</div>
            <DatePicker value={gateInAt} disabled={!canEdit} withTime placeholder="Not yet gated in"
              onChange={d => { setGateInAt(d); savePlainFields({ gateInAt: d }); }} />
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Gate Out</div>
            <DatePicker value={gateOutAt} disabled={!canEdit} withTime placeholder="Not yet gated out"
              onChange={d => { setGateOutAt(d); savePlainFields({ gateOutAt: d }); }} />
          </div>
        </div>
      </div>

      <div>
        <div style={lbl}>Trucking</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp label="Driver Name" value={driverName} disabled={!canEdit}
            onChange={setDriverName} onBlur={() => savePlainFields({ driverName })} />
          <Inp label="Driver ID Number" value={driverIdNumber} disabled={!canEdit} mono
            onChange={setDriverIdNumber} onBlur={() => savePlainFields({ driverIdNumber })} />
        </div>
        <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginTop: 6 }}>
          Trucking company: <strong style={{ color: T.text }}>
            {record.vendorName || "No vendor set — assign one on the Services panel"}
          </strong>
        </div>
      </div>

      <div>
        <div style={lbl}>Instructions</div>
        <Textarea value={instructions} disabled={!canEdit} placeholder="Special instructions for the trucking company…"
          onChange={setInstructions} rows={3} />
        {canEdit && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <Btn size="sm" variant="secondary" disabled={savingField === "instructions"}
              onClick={() => savePlainFields({ instructions })}>
              {savingField === "instructions" ? "Saving…" : "Save Instructions"}
            </Btn>
          </div>
        )}
      </div>

      <div>
        <div style={lbl}>Cost</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Inp label="Amount" value={costAmount} disabled={!canEdit} type="number"
            onChange={setCostAmount} placeholder="Leave blank to clear" />
          <Sel label="Currency" value={costCurrency} disabled={!canEdit}
            onChange={handleCostCurrency} options={CURRENCY_OPTIONS} />
          {costCurrency !== "USD" && (
            <Inp label="Exchange Rate → USD" value={costExchangeRate} disabled={!canEdit} type="number"
              onChange={setCostExchangeRate} />
          )}
        </div>
        {canEdit && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <Btn size="sm" disabled={savingField === "cost"} onClick={saveCost}>
              {savingField === "cost" ? "Saving…" : "Save Cost"}
            </Btn>
          </div>
        )}
        {costLineId && (
          <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.success, marginTop: 6 }}>
            → BUY cost line {costLineId} created/updated
          </div>
        )}
      </div>

      <div>
        <div style={lbl}>Waypoints</div>
        {waypoints === null ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.textMuted, fontFamily: T.body, fontSize: 12.5 }}>
            <Spinner size="sm" /> Loading waypoints…
          </div>
        ) : (
          <>
            {waypoints.length === 0 && (
              <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic", padding: "6px 0" }}>
                No waypoints added yet.
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
              {waypoints.map(wp => (
                <WaypointRow key={wp.id} wp={wp} canEdit={canEdit}
                  onSave={handleSaveWaypoint} onRemove={handleRemoveWaypoint} />
              ))}
            </div>
            {canEdit && (addingWp ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12,
                borderRadius: 8, border: `1px dashed ${T.accent}55`, background: T.bg }}>
                <select value={newWpLocType} onChange={e => setNewWpLocType(e.target.value)}
                  style={{ ...inputBase, fontFamily: T.body, fontSize: 12, cursor: "pointer" }}>
                  {WAYPOINT_LOC_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {newWpLocType === GPS_LOC_TYPE ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <Inp label="Latitude" value={newWpLat} onChange={setNewWpLat} placeholder="-90 to 90" />
                    <Inp label="Longitude" value={newWpLng} onChange={setNewWpLng} placeholder="-180 to 180" />
                  </div>
                ) : (
                  <Inp label="Location" value={newWpLocation} onChange={setNewWpLocation}
                    placeholder="Address, depot name, or UN/LOCODE" />
                )}
                <Inp label="Notes (optional)" value={newWpNotes} onChange={setNewWpNotes} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Btn size="sm" variant="secondary" onClick={() => setAddingWp(false)}>Cancel</Btn>
                  <Btn size="sm" disabled={wpSaving} onClick={handleAddWaypoint}>
                    {wpSaving ? "Saving…" : "Add Waypoint"}
                  </Btn>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setAddingWp(true)}
                style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
                  border: `1px dashed ${T.accent}55`, borderRadius: 6, padding: "7px 12px", cursor: "pointer", width: "100%" }}>
                ＋ Add Waypoint
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
};

export default HaulageDetailsPanel;
