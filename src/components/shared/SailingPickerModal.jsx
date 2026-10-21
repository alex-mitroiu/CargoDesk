import { deriveLoopCode } from "../../utils/scheduleLoop";
import { useState, useEffect, useRef } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { Modal } from "../primitives/Modal";
import Spinner from "../primitives/Spinner";
import { LegRoleChip, SailingLegs, viaText, MAIN_COLOR } from "./LegRoles";

// Render the journey breadcrumb in the correct door-to-port order
const JourneyBreadcrumb = ({ pol, pod, routingTerm }) => {
  if (!routingTerm || routingTerm === "PT-PT") return null;
  const hasDoorOrigin = routingTerm.startsWith("DR-");
  const hasDoorDest   = routingTerm.endsWith("-DR");
  const hasCYOrigin   = routingTerm.startsWith("CY-");
  const hasCYDest     = routingTerm.endsWith("-CY");

  const chip = (label, bold) => (
    <span key={label} style={{
      fontFamily: T.mono, fontSize: 11, fontWeight: bold ? 700 : 400,
      color: bold ? T.accent : T.textMuted,
      background: bold ? T.accentBg : T.bg,
      border: `1px solid ${bold ? T.accent + "44" : T.border}`,
      borderRadius: 4, padding: "1px 7px",
    }}>{label}</span>
  );
  const arrow = (k) => (
    <span key={k} style={{ color: T.border, fontSize: 14 }}>›</span>
  );

  const parts = [];
  if (hasDoorOrigin || hasCYOrigin) parts.push(chip(hasDoorOrigin ? "Door Origin" : "CY Origin", false));
  parts.push(chip(pol, true));
  parts.push(chip(pod, true));
  if (hasDoorDest || hasCYDest) parts.push(chip(hasDoorDest ? "Door Dest." : "CY Dest.", false));

  const nodes = [];
  parts.forEach((p, i) => {
    nodes.push(p);
    if (i < parts.length - 1) nodes.push(arrow(`a${i}`));
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
      padding: "6px 10px", background: T.bg, border: `1px solid ${T.border}`,
      borderRadius: 6, marginBottom: 2 }}>
      <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted,
        textTransform: "uppercase", letterSpacing: ".07em", marginRight: 4 }}>Journey:</span>
      {nodes}
    </div>
  );
};

const SailingPickerModal = ({ pol, pod, carrierCode, routingTerm, activeSailing, onSelect, onClose,
  selectLabel = "Select →", expectedHub = null, expectedService = null,
  requiredService = null, requiredHub = null, spotPricing = null, onSelectWithOffer = null }) => {
  const [sailings, setSailings] = useState(null);
  const [showAll,  setShowAll]  = useState(false);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [weeks,    setWeeks]    = useState(4);

  // Soft-match only — a hard filter would risk dead-ending demo/mock data (which generates
  // hubs/services unrelated to any real contract), so this sorts likely matches first and
  // badges them, rather than excluding anything the search itself already returned.
  const matchesContract = (s) => {
    if (expectedHub) return !!(s.legs && s.legs.some(l => l.pod === expectedHub));
    if (expectedService) return s.service === expectedService;
    return false;
  };
  const hasExpectation = !!(expectedHub || expectedService);

  // Hard filter (decided 2026-09-30): a shipment on a space configuration searches sailings by
  // that configuration's routing — its loop, and its first transshipment port when it has one.
  // A sailing on another loop would drop the space link on save (revalidateSpaceLoop), so those
  // are hidden unless the user deliberately asks to see them.
  const hasRequirement = !!(requiredService || requiredHub);
  const fitsRequirement = s => (!requiredService || deriveLoopCode(s).toUpperCase() === String(requiredService).toUpperCase())
    && (!requiredHub || !!(s.legs && s.legs.some(l => l.pod === requiredHub)));

  // Only the newest search may fill the list (2026-10-15): StrictMode runs the mount effect twice in
  // dev, and a quick change of weeks overlaps searches too; a slower, older answer used to replace the
  // rows the user was about to click.
  const searchSeq = useRef(0);
  const search = async (w) => {
    const seq = ++searchSeq.current;
    setLoading(true); setError(null);
    try {
      const data = await api.schedules.search({ pol, pod, carrierCode, weeks: w });
      if (seq === searchSeq.current) setSailings(data);
    } catch (e) {
      if (seq === searchSeq.current) setError(e.message);
    } finally { if (seq === searchSeq.current) setLoading(false); }
  };

  useEffect(() => { search(weeks); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // SPOT rates, phase 2 (2026-10-21): on a SPOT shipment each departure can show the carrier's spot
  // price (its own connection, or the demo carrier), matched to the sailing by main vessel and ETD.
  // spotPricing = { carrierCode, pol, pod, equipment:[{containerType, quantity}], from }.
  const [spotOn, setSpotOn] = useState(!!spotPricing);
  const [spot, setSpot] = useState(null);
  useEffect(() => {
    if (!spotPricing || !spotOn || !spotPricing.equipment?.length) return;
    let cancelled = false;
    api.spotOffers.fromCarrier({ carrierCode: spotPricing.carrierCode, pol: spotPricing.pol, pod: spotPricing.pod,
      equipment: spotPricing.equipment.map(e => `${e.containerType}:${e.quantity}`).join(","), from: spotPricing.from || "", weeks: String(weeks) })
      .then(r => !cancelled && setSpot(r)).catch(e => !cancelled && setSpot({ available: false, offers: [], message: e.message }));
    return () => { cancelled = true; };
  }, [spotOn, weeks]); // eslint-disable-line react-hooks/exhaustive-deps
  const spotFor = s => (spot?.offers || []).find(o => o.vessel === s.vesselName && o.etd === String(s.etd || "").slice(0, 10));

  const SOURCE_BADGE = {
    catalog: { label: "Catalog", color: T.success },
    live:    { label: "Live",    color: T.info },
    mock:    { label: "Demo",    color: T.warning },
  };
  const sourceBadge = source => {
    const b = SOURCE_BADGE[source] || SOURCE_BADGE.mock;
    return (
      <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, letterSpacing: ".08em",
        background: b.color + "22", color: b.color, border: `1px solid ${b.color}44`,
        borderRadius: 4, padding: "1px 6px", textTransform: "uppercase" }}>{b.label}</span>
    );
  };

  return (
    <Modal title={`Sailing Search — ${pol} → ${pod}`} onClose={onClose} width={760}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Journey order breadcrumb */}
        <JourneyBreadcrumb pol={pol} pod={pod} routingTerm={routingTerm} />

        {hasExpectation && (
          <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted,
            padding: "6px 10px", background: T.accentBg, border: `1px solid ${T.accent}33`,
            borderRadius: 6 }}>
            Contract routing: {expectedHub ? <>via <strong style={{ fontFamily: T.mono, color: T.text }}>{expectedHub}</strong></> : "direct"}
            {expectedService ? <> · <strong style={{ fontFamily: T.mono, color: T.text }}>{expectedService}</strong></> : ""}
            {" — "}matching sailings below are sorted first.
          </div>
        )}

        {/* Controls row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Search window:</span>
          {[2, 4, 8, 12].map(w => (
            <button key={w} onClick={() => { setWeeks(w); search(w); }}
              style={{ background: weeks === w ? T.accentBg : "none",
                border: `1px solid ${weeks === w ? T.accent : T.border}`,
                borderRadius: 5, padding: "3px 10px", cursor: "pointer",
                fontFamily: T.mono, fontSize: 12, color: weeks === w ? T.accent : T.text }}>
              {w}w
            </button>
          ))}
          <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700,
            color: T.accent, marginLeft: "auto" }}>{carrierCode}</span>
        </div>
        {spotPricing && (
          <label data-testid="sailing-spot-toggle" style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: T.body, fontSize: 12.5, color: T.text, cursor: "pointer" }}>
            <input type="checkbox" checked={spotOn} onChange={e => setSpotOn(e.target.checked)} />
            {spotPricing.carrierCode} spot prices
            <span style={{ color: T.textMuted }}>
              {spotOn && spot && !spot.available ? `— ${spot.message}` : spotOn && spot?.demo ? "— from the demo carrier (generated prices)" : "(a SPOT shipment: each departure priced by the carrier)"}
            </span>
          </label>
        )}

        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 0",
            justifyContent: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
            <Spinner size="sm" /> Searching schedules…
          </div>
        )}

        {error && (
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.danger,
            padding: "10px 14px", background: T.danger + "12", borderRadius: 6,
            border: `1px solid ${T.danger}33` }}>
            {error}
          </div>
        )}

        {sailings && !loading && (
          <>
            {sailings.isMock && (
              <div style={{ fontFamily: T.body, fontSize: 12, color: T.warning,
                padding: "8px 12px", background: T.warning + "12",
                border: `1px solid ${T.warning}33`, borderRadius: 6 }}>
                No stored or live schedules matched this route/window — showing demo schedules.
                Generate real schedules in Test Tools, or disable demo schedules in App Settings.
              </div>
            )}
            {hasRequirement && (
              <div data-testid="sailing-space-filter" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10,
                fontFamily: T.body, fontSize: 12, color: T.text, padding: "8px 12px",
                background: T.accentBg, border: `1px solid ${T.accent}33`, borderRadius: 6 }}>
                <span>
                  This shipment is on a space configuration for
                  {requiredService && <> loop <strong style={{ fontFamily: T.mono }}>{requiredService}</strong></>}
                  {requiredHub && <> via <strong style={{ fontFamily: T.mono }}>{requiredHub}</strong></>}
                  {showAll ? ". Showing every sailing — picking one on another loop drops the shipment from that space." : ", so only those sailings are shown."}
                </span>
                <button type="button" onClick={() => setShowAll(v => !v)}
                  style={{ marginLeft: "auto", background: "none", border: `1px solid ${T.border}`, borderRadius: 5, padding: "3px 10px",
                    cursor: "pointer", fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                  {showAll ? "Only matching sailings" : `Show all sailings (${(sailings.sailings || []).filter(x => !fitsRequirement(x)).length} more)`}
                </button>
              </div>
            )}
            {(sailings.sailings || []).filter(x => showAll || !hasRequirement || fitsRequirement(x)).length === 0 ? (
              <div style={{ textAlign: "center", padding: "24px 0",
                fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                {hasRequirement && !showAll && (sailings.sailings || []).length > 0
                  ? <>No sailings{requiredService ? ` on loop ${requiredService}` : ""}{requiredHub ? ` via ${requiredHub}` : ""} in the {weeks}-week window. Widen the window, or show all sailings.</>
                  : <>No sailings found for this route in the {weeks}-week window.</>}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[...(sailings.sailings || [])]
                  .map((s, i) => ({ s, i }))
                  .filter(({ s }) => showAll || !hasRequirement || fitsRequirement(s))
                  .sort((a, b) => (hasExpectation ? (matchesContract(b.s) - matchesContract(a.s)) : 0))
                  .map(({ s, i }) => {
                  const isTSP = s.legs && s.legs.length > 1;
                  const isContractMatch = hasExpectation && matchesContract(s);
                  const isActive = activeSailing && (
                    activeSailing.voyageNumber === s.voyageNumber ||
                    (activeSailing.vesselName === s.vesselName && activeSailing.etd === s.etd)
                  );
                  const baseBorder = isActive ? T.success + "88" : isTSP ? MAIN_COLOR + "55" : T.border;
                  const baseBg    = isActive ? T.success + "0f" : T.bg;
                  const offer = spotPricing && spotOn ? spotFor(s) : null;
                  return (
                    <div key={i} style={{ display: "flex", flexDirection: "column" }}>
                    <button type="button" onClick={() => onSelect(s)}
                      style={{ display: "flex", flexDirection: "column", gap: 6,
                        padding: "12px 14px", textAlign: "left",
                        background: baseBg, border: `1px solid ${baseBorder}`,
                        borderRadius: 8, cursor: "pointer", width: "100%" }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = isActive ? T.success : T.accent; e.currentTarget.style.background = isActive ? T.success + "18" : T.accentBg; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = baseBorder; e.currentTarget.style.background = baseBg; }}>

                      {/* Main row */}
                      <div style={{ display: "grid",
                        gridTemplateColumns: "1fr 100px 100px 80px auto",
                        gap: 12, alignItems: "center", width: "100%" }}>

                        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          {/* A transshipment is headlined by its main vessel (the leg with the longest transit;
                              the server's withMainVessel), marked MAIN, with its hubs and feeders beneath. */}
                          <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text,
                            overflow: "hidden", whiteSpace: "nowrap" }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.vesselName}</span>
                            {isTSP && <LegRoleChip role="MAIN" />}
                            <span>{sourceBadge(s.source || (s.isMock ? "mock" : "live"))}</span>
                          </div>
                          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                            {isTSP ? `Voy ${s.voyageNumber} · ${viaText(s)}` : `${s.service} · Voy ${s.voyageNumber}`}
                          </div>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <div style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, color: T.textMuted,
                            textTransform: "uppercase", letterSpacing: ".07em" }}>ETD</div>
                          <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{s.etd || "—"}</div>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <div style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, color: T.textMuted,
                            textTransform: "uppercase", letterSpacing: ".07em" }}>ETA</div>
                          <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{s.eta || "—"}</div>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "center" }}>
                          <div style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, color: T.textMuted,
                            textTransform: "uppercase", letterSpacing: ".07em" }}>Transit</div>
                          <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>
                            {s.transitDays}d
                          </span>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                          {isContractMatch && (
                            <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                              background: T.info + "18", color: T.info,
                              border: `1px solid ${T.info}44`,
                              borderRadius: 4, padding: "1px 6px", textTransform: "uppercase",
                              whiteSpace: "nowrap" }}>
                              ✓ Matches contract
                            </span>
                          )}
                          {isActive
                            ? <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                                color: T.success, background: T.success + "18",
                                border: `1px solid ${T.success}55`, borderRadius: 4,
                                padding: "2px 10px", whiteSpace: "nowrap" }}>
                                ✓ Active
                              </span>
                            : <span style={{ fontFamily: T.body, fontSize: 11, color: T.accent,
                                background: T.accentBg, borderRadius: 4, padding: "2px 10px",
                                border: `1px solid ${T.accent}33`, whiteSpace: "nowrap" }}>
                                {selectLabel}
                              </span>
                          }
                        </div>
                      </div>

                      {/* Every leg in sailing order: feeder, main, feeder */}
                      {isTSP && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                          <SailingLegs sailing={s} testId={`sailing-legs-${i}`} />
                          <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                            Creates {s.legs.length} sea legs in this order. The shipment's vessel becomes <b style={{ color: T.text }}>{s.vesselName}</b> (main).
                          </span>
                        </div>
                      )}
                    </button>
                    {offer && (
                      <div data-testid={`sailing-spot-${i}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: -1, padding: "8px 14px",
                        border: `1px solid ${baseBorder}`, borderTop: `1px dashed ${T.border}`, borderRadius: "0 0 8px 8px", background: T.surface, fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                        <span>Spot</span>
                        <b style={{ fontFamily: T.mono, fontSize: 13.5, color: T.text }}>USD {Math.round(offer.totalUsd).toLocaleString("en-US")}</b>
                        <span style={{ fontFamily: T.mono }}>{offer.offerRef}</span>
                        <span>valid until {new Date(offer.validUntil).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
                        <span style={{ flex: 1 }} />
                        <button type="button" data-testid={`sailing-spot-take-${i}`} onClick={() => onSelectWithOffer?.(s, offer)}
                          style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: T.accent, color: "#06111f", fontFamily: T.body, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                          Sailing + offer</button>
                      </div>
                    )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};

export default SailingPickerModal;
