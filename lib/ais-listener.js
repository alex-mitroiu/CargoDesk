"use strict";
// AIS Integration (TKT-ZFO2OM) — persistent outbound WebSocket client to an AIS provider
// (aisstream.io by default; ais_provider is a real settings seam but only 'aisstream' is wired
// to an actual connection this pass — see the plan's "Explicitly deferred" section for why).
//
// One connection feeds two independent write behaviors, both driven by the same ingestMessage():
//   - ShipStaticData -> resolve/refresh the `vessels` registry (new IMO discovered, or an existing
//     one's name changed = a rename/reflag). Always writes — AIS is authoritative for current
//     name/IMO by definition, unlike ETD/ETA below.
//   - PositionReport  -> confirms etd/eta *in place* on a tracked SEA leg when its vessel's
//     position/nav-status near the leg's POL/POD indicates a real departure/arrival — an estimate
//     becoming a known fact, not a separate always-visible ATD/ATA pair (an earlier design pass
//     built it that way; reworked per direct feedback). Idempotent per field once confirmed
//     (etd_source/eta_source flips to 'ais') — never re-fires for the same event twice, but the
//     first confirmation *does* overwrite whatever estimate was there, which is the point.
//
// No persistent-outbound-connection precedent exists elsewhere in this codebase — this module is
// deliberately conservative: never throw past its own boundary, retry indefinitely on failure with
// backoff rather than giving up, and a malformed frame must never crash the process.

const WebSocket = require("ws");

const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
const IDLE_WATCHDOG_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 10 * 1000;
const TRACKED_LEGS_REFRESH_MS = 60 * 1000;
const PROXIMITY_RADIUS_KM = 15;
const UNDER_WAY_STATUSES = new Set([0, 8]);   // 0 = under way using engine, 8 = under way sailing
const STOPPED_STATUSES   = new Set([1, 5]);   // 1 = at anchor, 5 = moored

// Haversine distance in km — small, self-contained, no need for a dependency for one formula.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function createAisListener({ db, getSettings, broadcastMessage, logEntityEvent, uid, syncShipmentFromLegs, callMdmService }) {
  let ws = null;
  let reconnectTimer = null;
  let idleTimer = null;
  let reconnectAttempt = 0;
  let shuttingDown = false;
  let connectedSince = null;
  let lastMessageAt = null;
  let lastError = null;
  let currentKey = null; // the key/enabled state we last actually connected with

  const mmsiToImo = new Map();          // fast-path cache, refilled from vessels.mmsi as needed
  let trackedLegs = new Map();          // imo -> [{ shipmentId, legId, pol, pod, ... }]
  let trackedLegsRefreshedAt = 0;
  const posState = new Map();           // `${legId}:${imo}` -> { nearPol, nearPod, navStatus }

  const portCoords = new Map();         // unlocode -> {lat, lon}, small in-memory cache
  let mdmCoordsRefreshInFlight = false;

  // Called inside handlePositionReport's hot per-frame loop (up to hundreds of msg/sec) — MUST
  // stay synchronous and never block on network I/O. In mdm_source='remote' mode, a cache miss
  // returns null for THIS frame (dropping one position update is harmless — another arrives in
  // seconds) while a background bulk fetch populates the whole cache for next time, deduplicated
  // via mdmCoordsRefreshInFlight so a burst of misses doesn't fire N concurrent fetches.
  function getPortCoords(unlocode) {
    if (!unlocode) return null;
    if (portCoords.has(unlocode)) return portCoords.get(unlocode);
    if ((getSettings().mdm_source || "local") === "remote") {
      if (!mdmCoordsRefreshInFlight && callMdmService) {
        mdmCoordsRefreshInFlight = true;
        callMdmService("GET", "/internal/port-coords")
          .then(rows => { for (const r of rows) if (!portCoords.has(r.unlocode)) portCoords.set(r.unlocode, (r.latitude && r.longitude) ? { lat: r.latitude, lon: r.longitude } : null); })
          .catch(e => console.error("AIS listener: port-coords refresh from MDM Service failed:", e.message))
          .finally(() => { mdmCoordsRefreshInFlight = false; });
      }
      return null;
    }
    const row = db.prepare("SELECT latitude, longitude FROM port_locations WHERE unlocode=?").get(unlocode);
    const coords = (row && row.latitude && row.longitude) ? { lat: row.latitude, lon: row.longitude } : null;
    portCoords.set(unlocode, coords);
    return coords;
  }

  function refreshTrackedLegs(force = false) {
    const now = Date.now();
    if (!force && now - trackedLegsRefreshedAt < TRACKED_LEGS_REFRESH_MS) return;
    trackedLegsRefreshedAt = now;
    // Tracks by *confirmation* state (etd_source/eta_source = 'ais'), not blankness — etd/eta
    // are almost always already populated with an estimate from the moment a leg is created,
    // so a blank-check would never track anything. "Not yet AIS-confirmed" is the real signal.
    const rows = db.prepare(`
      SELECT id, shipment_id, pol, pod, vessel_imo, etd_source, eta_source
      FROM shipment_legs
      WHERE leg_type='SEA' AND vessel_imo != '' AND (etd_source != 'ais' OR eta_source != 'ais')
    `).all();
    const next = new Map();
    for (const r of rows) {
      if (!next.has(r.vessel_imo)) next.set(r.vessel_imo, []);
      next.get(r.vessel_imo).push({
        legId: r.id, shipmentId: r.shipment_id, pol: r.pol, pod: r.pod,
        etdConfirmed: r.etd_source === "ais", etaConfirmed: r.eta_source === "ais",
      });
    }
    trackedLegs = next;
  }

  // ─── ShipStaticData: resolve/refresh the vessels registry ──────────────────────
  // 'remote' mode (mdm_source): fire-and-forget POST to the MDM Service's own /internal/
  // vessels/upsert, never awaited by this handler — a slow/unreachable MDM Service must degrade
  // the same way a malformed frame does (this module's own governing rule, see the file header),
  // not stall the socket. The service does the same three-way insert/quiet-refresh/rename logic
  // and reports back {renamed, previousName}, which is all this side needs to still log the
  // RENAMED entity_event locally (entity_events stays monolith-owned regardless of mdm_source).
  function handleShipStaticData(envelope) {
    const msg = envelope.Message?.ShipStaticData || {};
    const imo = String(msg.ImoNumber || "").trim();
    const mmsi = String(envelope.MetaData?.MMSI || msg.UserID || "").trim();
    const name = String(msg.Name || "").trim();
    if (!imo || imo === "0" || !name) return; // non-merchant craft rarely report a real IMO
    mmsiToImo.set(mmsi, imo);

    if ((getSettings().mdm_source || "local") === "remote") {
      if (!callMdmService) return;
      callMdmService("POST", "/internal/vessels/upsert", { imo, name, mmsi })
        .then(result => { if (result.renamed) logEntityEvent("vessel", imo, "RENAMED", "name", result.previousName, name, JSON.stringify({ source: "ais", mmsi })); })
        .catch(e => console.error("AIS listener: vessel upsert to MDM Service failed:", e.message));
      return;
    }

    const now = new Date().toISOString();
    const existing = db.prepare("SELECT * FROM vessels WHERE imo=?").get(imo);
    if (!existing) {
      try {
        db.prepare("INSERT INTO vessels (imo, name, mmsi, ais_verified_at) VALUES (?,?,?,?)").run(imo, name, mmsi, now);
      } catch { /* a race with a manual MDM insert of the same imo — harmless, next message updates it */ }
      return;
    }
    if (existing.name === name) {
      db.prepare("UPDATE vessels SET mmsi=?, ais_verified_at=? WHERE imo=?").run(mmsi, now, imo);
      return;
    }
    // Name differs from what's stored — a rename/reflag, the exact signal TKT-R7S25A's spike
    // was built to catch (IMO is the permanent anchor; name is what AIS lets us keep current).
    db.prepare("UPDATE vessels SET name=?, mmsi=?, ais_verified_at=? WHERE imo=?").run(name, mmsi, now, imo);
    logEntityEvent("vessel", imo, "RENAMED", "name", existing.name, name, JSON.stringify({ source: "ais", mmsi }));
  }

  // ─── PositionReport: propose atd/ata on a tracked SEA leg ───────────────────────
  function handlePositionReport(envelope) {
    const msg = envelope.Message?.PositionReport || {};
    const mmsi = String(envelope.MetaData?.MMSI || msg.UserID || "").trim();
    if (!mmsi) return;
    let imo = mmsiToImo.get(mmsi);
    if (!imo) {
      const row = db.prepare("SELECT imo FROM vessels WHERE mmsi=?").get(mmsi);
      if (!row) return; // unresolved — the common case on a global bounding box
      imo = row.imo;
      mmsiToImo.set(mmsi, imo);
    }
    refreshTrackedLegs();
    const legs = trackedLegs.get(imo);
    if (!legs || !legs.length) return;

    const lat = msg.Latitude, lon = msg.Longitude;
    if (typeof lat !== "number" || typeof lon !== "number") return;
    const navStatus = typeof msg.NavigationalStatus === "number" ? msg.NavigationalStatus : 15;
    // Real receive time is MetaData.time_utc — PositionReport.Timestamp is a raw AIS-protocol
    // seconds-of-the-minute field (0-59), not a usable timestamp on its own.
    const receivedAt = envelope.MetaData?.time_utc ? new Date(envelope.MetaData.time_utc) : new Date();
    const eventDate = isNaN(receivedAt) ? new Date().toISOString().slice(0, 10) : receivedAt.toISOString().slice(0, 10);

    for (const leg of legs) {
      const key = `${leg.legId}:${imo}`;
      const prev = posState.get(key) || { nearPol: false, nearPod: false, navStatus: null };

      const polCoords = !leg.etdConfirmed ? getPortCoords(leg.pol) : null;
      const podCoords = !leg.etaConfirmed ? getPortCoords(leg.pod) : null;
      const nearPol = polCoords ? haversineKm(lat, lon, polCoords.lat, polCoords.lon) <= PROXIMITY_RADIUS_KM : false;
      const nearPod = podCoords ? haversineKm(lat, lon, podCoords.lat, podCoords.lon) <= PROXIMITY_RADIUS_KM : false;

      if (!leg.etdConfirmed && prev.nearPol && STOPPED_STATUSES.has(prev.navStatus) &&
          nearPol && UNDER_WAY_STATUSES.has(navStatus)) {
        applyActual(leg, "etd", eventDate, imo, lat, lon);
      }
      if (!leg.etaConfirmed && prev.nearPod && UNDER_WAY_STATUSES.has(prev.navStatus) &&
          nearPod && STOPPED_STATUSES.has(navStatus)) {
        applyActual(leg, "eta", eventDate, imo, lat, lon);
      }

      posState.set(key, { nearPol, nearPod, navStatus });
    }
  }

  function applyActual(leg, field, eventDate, imo, lat, lon) {
    // Idempotent-confirmation guard: once a field has been AIS-confirmed, never re-fire for it
    // again — but unlike a blank-check, this *does* overwrite whatever estimate etd/eta held
    // beforehand (manual or default), because that's the whole point — an estimate becoming a
    // known fact once the real event happens, not a value that must stay untouched forever.
    const sourceCol = `${field}_source`;
    const row = db.prepare(`SELECT ${sourceCol} FROM shipment_legs WHERE id=?`).get(leg.legId);
    if (!row || row[sourceCol] === "ais") return;
    db.prepare(`UPDATE shipment_legs SET ${field}=?, ${sourceCol}='ais' WHERE id=?`).run(eventDate, leg.legId);
    syncShipmentFromLegs(leg.shipmentId);
    logEntityEvent("shipment_leg", leg.legId, field === "etd" ? "AIS_DEPARTURE_CONFIRMED" : "AIS_ARRIVAL_CONFIRMED",
      field, "", eventDate, JSON.stringify({ shipmentId: leg.shipmentId, imo, lat, lon }));
    broadcastMessage(leg.shipmentId, { type: "leg_actuals_updated", legId: leg.legId, field, value: eventDate });
    if (field === "etd") leg.etdConfirmed = true; else leg.etaConfirmed = true;
    refreshTrackedLegs(true); // force a re-pull so a leg with both fields now confirmed stops being tracked
  }

  // Shared entry point — the live connection's ws.on("message") calls this, and so does the Test
  // Tools AIS Simulator (routes/ais.js), via the exact same function. No parallel code path.
  function ingestMessage(envelope) {
    lastMessageAt = new Date().toISOString();
    if (!envelope || typeof envelope !== "object") return;
    if (envelope.MessageType === "ShipStaticData") handleShipStaticData(envelope);
    else if (envelope.MessageType === "PositionReport") handlePositionReport(envelope);
  }

  // ─── Connection lifecycle ───────────────────────────────────────────────────────
  function clearTimers() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function armIdleWatchdog() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // No traffic for a while on an otherwise-open socket — a half-open TCP failure that
      // close/error won't always catch on its own. Force-close and let reconnect take over.
      try { ws?.terminate?.(); } catch { /* already gone */ }
    }, IDLE_WATCHDOG_MS);
  }

  function scheduleReconnect() {
    if (shuttingDown) return;
    reconnectAttempt += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_MS)
      + Math.floor(Math.random() * 1000);
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    const settings = getSettings();
    const key = settings.ais_api_key;
    if (settings.api_ais_enabled !== "true" || !key) return; // applySettings already tore down any open socket

    try {
      ws = new WebSocket(AISSTREAM_URL);
    } catch (e) {
      lastError = e.message;
      console.error("AIS listener: connect() threw:", e.message);
      scheduleReconnect();
      return;
    }

    // A hung TCP/TLS handshake (network partition, a blocked outbound host, ...) never fires
    // open/error/close on its own — without this, a single stuck attempt would leave the
    // listener silently dead forever instead of retrying. Cleared the moment "open" fires.
    let connectTimedOut = false;
    const connectTimer = setTimeout(() => {
      connectTimedOut = true;
      lastError = `Connection attempt timed out after ${CONNECT_TIMEOUT_MS / 1000}s`;
      console.error("AIS listener:", lastError);
      try { ws?.terminate(); } catch { /* already gone */ }
    }, CONNECT_TIMEOUT_MS);

    ws.on("open", () => {
      clearTimeout(connectTimer);
      try {
        ws.send(JSON.stringify({
          APIKey: key,
          BoundingBoxes: [[[-90, -180], [90, 180]]],
          FilterMessageTypes: ["ShipStaticData", "PositionReport"],
        }));
      } catch (e) { lastError = e.message; }
      connectedSince = new Date().toISOString();
      reconnectAttempt = 0;
      lastError = null;
      console.log("AIS listener: connected to", AISSTREAM_URL);
      armIdleWatchdog();
    });

    ws.on("message", raw => {
      armIdleWatchdog();
      try { ingestMessage(JSON.parse(raw)); } catch { /* one malformed frame must never crash the process */ }
    });

    ws.on("error", e => { lastError = e.message; });

    ws.on("close", (code, reasonBuf) => {
      clearTimeout(connectTimer);
      connectedSince = null;
      if (!connectTimedOut && !lastError) {
        const reason = reasonBuf?.toString() || "";
        lastError = `Connection closed (code ${code}${reason ? `: ${reason}` : ""})`;
      }
      clearTimers();
      scheduleReconnect();
    });
  }

  function disconnect() {
    clearTimers();
    // Do NOT removeAllListeners() before terminate() — terminating a socket that hasn't
    // finished connecting yet emits its own 'error' event internally, and EventEmitter throws
    // (crashing the whole process) if that fires with no listener left to catch it. The real
    // ws.on("error", ...) handler registered in connect() is exactly what needs to stay in
    // place here; discarding the `ws` reference below is enough cleanup on its own.
    if (ws) { try { ws.terminate(); } catch { /* already gone */ } ws = null; }
    connectedSince = null;
  }

  // Idempotent — no-op if nothing about enabled/key actually changed. Called at boot and again
  // whenever PUT /api/settings saves, so a toggle/key change applies immediately, no restart.
  function applySettings() {
    const settings = getSettings();
    const nextKey = settings.api_ais_enabled === "true" ? (settings.ais_api_key || null) : null;
    if (nextKey === currentKey) return;
    currentKey = nextKey;
    disconnect();
    reconnectAttempt = 0;
    if (nextKey) connect();
  }

  function getStatus() {
    return {
      connected: !!(ws && ws.readyState === WebSocket.OPEN),
      provider: getSettings().ais_provider || "aisstream",
      connectedSince, lastMessageAt, lastError, reconnectAttempt,
      trackedVesselCount: trackedLegs.size,
    };
  }

  function stop() {
    shuttingDown = true;
    disconnect();
  }

  // Exposed for the Test Tools simulator specifically: a leg created moments ago by the same
  // developer session must be immediately eligible for a simulated position, not stuck behind
  // the 60s cache throttle that exists purely to spare the DB from a query on every one of the
  // real feed's up-to-hundreds-of-messages-per-second — a throttle that only makes sense for
  // that high-volume path, not an occasional manual simulate call.
  const forceRefreshTrackedLegs = () => refreshTrackedLegs(true);

  return { applySettings, ingestMessage, getStatus, stop, forceRefreshTrackedLegs };
}

module.exports = { createAisListener };
