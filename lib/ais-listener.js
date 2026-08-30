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
//
// Postgres migration (ARCHITECTURE.md §13): query()/transaction() are always async, even against
// the embedded pglite backend — unlike node:sqlite's DatabaseSync, there is no synchronous path at
// all anymore. Every DB touch in this file's hot per-frame path (up to hundreds of msg/sec) is
// therefore now either (a) served from an in-memory cache that's refreshed in the BACKGROUND on a
// timer/on-miss, never awaited inline, or (b) a write fired off unawaited (fire-and-forget, same
// as this file's own pre-existing logEntityEvent calls) — this module's hot path still never
// awaits anything, the rule just now also covers the local-mode DB itself, not only the
// mdm_source='remote' branch that originally motivated it.

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

function createAisListener({ query, getSettings, broadcastMessage, logEntityEvent, uid, syncShipmentFromLegs, callMdmService }) {
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
  let mmsiLookupsInFlight = new Set();  // mmsi values currently being resolved in the background
  let trackedLegs = new Map();          // imo -> [{ shipmentId, legId, pol, pod, ... }]
  const posState = new Map();           // `${legId}:${imo}` -> { nearPol, nearPod, navStatus }

  // getSettings() is async ahead of the eventual Postgres driver swap (ARCHITECTURE.md §13) —
  // but getPortCoords/handleShipStaticData run in the hot per-frame message path (up to hundreds
  // of msg/sec) and this module's own governing rule (see file header) is that path must never
  // await anything. Refreshed synchronously in applySettings() (called at boot and on every
  // settings save, the same cadence this module already used before this change) rather than
  // fetched fresh per-frame.
  let cachedSettings = {};

  const portCoords = new Map();         // unlocode -> {lat, lon}, small in-memory cache
  let mdmCoordsRefreshInFlight = false;

  // Called inside handlePositionReport's hot per-frame loop (up to hundreds of msg/sec) — MUST
  // stay synchronous and never block on network/DB I/O. A cache miss returns null for THIS frame
  // (dropping one position update is harmless — another arrives in seconds) while a background
  // fetch populates the cache for next time, deduplicated via the in-flight flags so a burst of
  // misses doesn't fire N concurrent queries. In mdm_source='remote' mode the background fetch is
  // one bulk GET to the MDM Service; in local mode it's a single-row Postgres query — either way
  // nothing here ever awaits.
  function getPortCoords(unlocode) {
    if (!unlocode) return null;
    if (portCoords.has(unlocode)) return portCoords.get(unlocode);
    if ((cachedSettings.mdm_source || "local") === "remote") {
      if (!mdmCoordsRefreshInFlight && callMdmService) {
        mdmCoordsRefreshInFlight = true;
        callMdmService("GET", "/internal/port-coords")
          .then(rows => { for (const r of rows) if (!portCoords.has(r.unlocode)) portCoords.set(r.unlocode, (r.latitude && r.longitude) ? { lat: r.latitude, lon: r.longitude } : null); })
          .catch(e => console.error("AIS listener: port-coords refresh from MDM Service failed:", e.message))
          .finally(() => { mdmCoordsRefreshInFlight = false; });
      }
      return null;
    }
    query("SELECT latitude, longitude FROM port_locations WHERE unlocode=$1", [unlocode])
      .then(([row]) => portCoords.set(unlocode, (row && row.latitude && row.longitude) ? { lat: row.latitude, lon: row.longitude } : null))
      .catch(e => console.error("AIS listener: port-coords lookup failed:", e.message));
    return null;
  }

  // Runs on its own timer (see the setInterval near applySettings below), not pulled inline from
  // the hot path — handlePositionReport just reads whatever trackedLegs currently holds, stale by
  // up to TRACKED_LEGS_REFRESH_MS, exactly the same staleness the old inline throttle tolerated.
  async function refreshTrackedLegs() {
    // Tracks by *confirmation* state (etd_source/eta_source = 'ais'), not blankness — etd/eta
    // are almost always already populated with an estimate from the moment a leg is created,
    // so a blank-check would never track anything. "Not yet AIS-confirmed" is the real signal.
    const rows = await query(`
      SELECT id, shipment_id, pol, pod, vessel_imo, etd_source, eta_source
      FROM shipment_legs
      WHERE leg_type='SEA' AND vessel_imo != '' AND (etd_source != 'ais' OR eta_source != 'ais')
    `);
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
  // Both modes are now fire-and-forget from this synchronous handler's point of view — 'remote'
  // already worked this way (a POST to the MDM Service, never awaited); local mode's own Postgres
  // writes below follow the identical shape now that query() is always async. A slow/unreachable
  // backend degrades the same way a malformed frame does (this module's own governing rule, see
  // the file header), never stalling the socket.
  //
  // Direct bug report: real vessels (confirmed against a third-party AIS tracker — IMO 134218245
  // is genuinely "DE VERWONDERING", a real passenger vessel) were showing up with garbled names
  // like "#!C?7($GA@A7S%I@SCP,". The IMO/MMSI fields are trustworthy (varying IMO formats are
  // real and expected — plenty of smaller/inland vessels never get a real 7-digit IMO issued,
  // so anything resembling "reject non-standard IMOs" would have wrongly discarded genuine
  // vessels like this one). The corruption is isolated to the Name field's decode specifically
  // — AIS's 6-bit character table technically includes punctuation real ship names never use
  // (`@` mid-string, `\`, `[`, `]`, `(`, `)`, `$`, `%`, `&`, `"`, trailing `,`, ...), so a
  // mis-aligned decode upstream (this app never touches raw AIVDM bits itself — aisstream.io
  // hands back already-decoded JSON) still produces "legal" 6-bit characters, just garbled
  // ones — a plain character-set check against the full AIS alphabet wouldn't catch it. Real
  // vessel names are overwhelmingly just uppercase letters, digits, spaces, hyphens, periods and
  // apostrophes — reject anything outside that pragmatic set rather than writing visibly
  // corrupted text into the registry. Length is capped generously (30, not the real AIS spec's
  // 20-char Name field width) purely to leave room for internal test/simulator fixtures — none
  // of the real corrupted names observed were actually longer than 20, the corruption is a
  // character-set problem, not a length one, so this cap isn't doing any of the real work here.
  const PLAUSIBLE_VESSEL_NAME = /^[A-Z0-9 .\-']{1,30}$/;

  async function upsertVesselLocal(imo, name, mmsi) {
    const now = new Date().toISOString();
    const [existing] = await query("SELECT * FROM vessels WHERE imo=$1", [imo]);
    if (!existing) {
      try {
        await query("INSERT INTO vessels (imo, name, mmsi, ais_verified_at) VALUES ($1,$2,$3,$4)", [imo, name, mmsi, now]);
      } catch { /* a race with a manual MDM insert of the same imo — harmless, next message updates it */ }
      return;
    }
    if (existing.name === name) {
      await query("UPDATE vessels SET mmsi=$1, ais_verified_at=$2 WHERE imo=$3", [mmsi, now, imo]);
      return;
    }
    // Name differs from what's stored — a rename/reflag, the exact signal TKT-R7S25A's spike
    // was built to catch (IMO is the permanent anchor; name is what AIS lets us keep current).
    await query("UPDATE vessels SET name=$1, mmsi=$2, ais_verified_at=$3 WHERE imo=$4", [name, mmsi, now, imo]);
    await logEntityEvent("vessel", imo, "RENAMED", "name", existing.name, name, JSON.stringify({ source: "ais", mmsi }));
  }

  function handleShipStaticData(envelope) {
    const msg = envelope.Message?.ShipStaticData || {};
    const imo = String(msg.ImoNumber || "").trim();
    const mmsi = String(envelope.MetaData?.MMSI || msg.UserID || "").trim();
    const name = String(msg.Name || "").trim().toUpperCase();
    // A garbled name is treated exactly like a blank one (same early return) — the existing
    // vessel's already-good name is never overwritten with noise, and a brand-new IMO with only
    // a garbled name waits for a cleaner ShipStaticData message later rather than being created
    // with visible garbage as its only identifier.
    if (!imo || imo === "0" || !name || !PLAUSIBLE_VESSEL_NAME.test(name)) return;
    mmsiToImo.set(mmsi, imo);

    if ((cachedSettings.mdm_source || "local") === "remote") {
      if (!callMdmService) return;
      callMdmService("POST", "/internal/vessels/upsert", { imo, name, mmsi })
        .then(result => { if (result.renamed) logEntityEvent("vessel", imo, "RENAMED", "name", result.previousName, name, JSON.stringify({ source: "ais", mmsi })); }) // fire-and-forget — logEntityEvent never throws (internal try/catch), and nothing in this background message-processing pipeline waits on its completion the way an HTTP response would
        .catch(e => console.error("AIS listener: vessel upsert to MDM Service failed:", e.message));
      return;
    }

    // Returned (not just fire-and-forget-discarded) so ingestMessage can hand it back to a
    // caller that needs to know when the write actually lands — the live feed's own hot path
    // never awaits this return value, but the Test Tools simulator (routes/ais.js) reads back
    // what it just injected immediately afterward and needs the write to have actually happened.
    return upsertVesselLocal(imo, name, mmsi).catch(e => console.error("AIS listener: vessel upsert failed:", e.message));
  }

  // ─── PositionReport: propose atd/ata on a tracked SEA leg ───────────────────────
  function handlePositionReport(envelope) {
    const msg = envelope.Message?.PositionReport || {};
    const mmsi = String(envelope.MetaData?.MMSI || msg.UserID || "").trim();
    if (!mmsi) return;
    let imo = mmsiToImo.get(mmsi);
    if (!imo) {
      // Same background-populate-on-miss shape as getPortCoords — resolving hundreds of unknown
      // MMSIs per second on a global bounding box is the common case, not the exception, so this
      // must never block: drop this one frame, kick off a lookup, pick it up next time.
      if (!mmsiLookupsInFlight.has(mmsi)) {
        mmsiLookupsInFlight.add(mmsi);
        query("SELECT imo FROM vessels WHERE mmsi=$1", [mmsi])
          .then(([row]) => { if (row) mmsiToImo.set(mmsi, row.imo); })
          .catch(e => console.error("AIS listener: mmsi->imo lookup failed:", e.message))
          .finally(() => mmsiLookupsInFlight.delete(mmsi));
      }
      return;
    }
    const legs = trackedLegs.get(imo);
    if (!legs || !legs.length) return;

    const lat = msg.Latitude, lon = msg.Longitude;
    if (typeof lat !== "number" || typeof lon !== "number") return;
    const navStatus = typeof msg.NavigationalStatus === "number" ? msg.NavigationalStatus : 15;
    // Real receive time is MetaData.time_utc — PositionReport.Timestamp is a raw AIS-protocol
    // seconds-of-the-minute field (0-59), not a usable timestamp on its own.
    const receivedAt = envelope.MetaData?.time_utc ? new Date(envelope.MetaData.time_utc) : new Date();
    const eventDate = isNaN(receivedAt) ? new Date().toISOString().slice(0, 10) : receivedAt.toISOString().slice(0, 10);

    const pending = []; // same "return the async work" shape as handleShipStaticData above
    for (const leg of legs) {
      const key = `${leg.legId}:${imo}`;
      const prev = posState.get(key) || { nearPol: false, nearPod: false, navStatus: null };

      const polCoords = !leg.etdConfirmed ? getPortCoords(leg.pol) : null;
      const podCoords = !leg.etaConfirmed ? getPortCoords(leg.pod) : null;
      const nearPol = polCoords ? haversineKm(lat, lon, polCoords.lat, polCoords.lon) <= PROXIMITY_RADIUS_KM : false;
      const nearPod = podCoords ? haversineKm(lat, lon, podCoords.lat, podCoords.lon) <= PROXIMITY_RADIUS_KM : false;

      if (!leg.etdConfirmed && prev.nearPol && STOPPED_STATUSES.has(prev.navStatus) &&
          nearPol && UNDER_WAY_STATUSES.has(navStatus)) {
        // Flip the in-memory guard synchronously, before the async write even starts — closes a
        // narrow re-fire window (two frames for the same leg landing before the write resolves)
        // that fire-and-forget would otherwise open.
        leg.etdConfirmed = true;
        pending.push(applyActual(leg, "etd", eventDate, imo, lat, lon).catch(e => console.error("AIS listener: applyActual(etd) failed:", e.message)));
      }
      if (!leg.etaConfirmed && prev.nearPod && UNDER_WAY_STATUSES.has(prev.navStatus) &&
          nearPod && STOPPED_STATUSES.has(navStatus)) {
        leg.etaConfirmed = true;
        pending.push(applyActual(leg, "eta", eventDate, imo, lat, lon).catch(e => console.error("AIS listener: applyActual(eta) failed:", e.message)));
      }

      posState.set(key, { nearPol, nearPod, navStatus });
    }
    return pending.length ? Promise.all(pending) : undefined;
  }

  async function applyActual(leg, field, eventDate, imo, lat, lon) {
    // Idempotent-confirmation guard: once a field has been AIS-confirmed, never re-fire for it
    // again — but unlike a blank-check, this *does* overwrite whatever estimate etd/eta held
    // beforehand (manual or default), because that's the whole point — an estimate becoming a
    // known fact once the real event happens, not a value that must stay untouched forever. The
    // caller already flipped leg.etdConfirmed/etaConfirmed synchronously before calling this, so
    // this DB-level check is a secondary guard against genuinely stale trackedLegs state, not the
    // only thing preventing a double-fire within one process.
    const sourceCol = `${field}_source`;
    const [row] = await query(`SELECT ${sourceCol} FROM shipment_legs WHERE id=$1`, [leg.legId]);
    if (!row || row[sourceCol] === "ais") return;
    await query(`UPDATE shipment_legs SET ${field}=$1, ${sourceCol}='ais' WHERE id=$2`, [eventDate, leg.legId]);
    await syncShipmentFromLegs(leg.shipmentId);
    await logEntityEvent("shipment_leg", leg.legId, field === "etd" ? "AIS_DEPARTURE_CONFIRMED" : "AIS_ARRIVAL_CONFIRMED",
      field, "", eventDate, JSON.stringify({ shipmentId: leg.shipmentId, imo, lat, lon }));
    broadcastMessage(leg.shipmentId, { type: "leg_actuals_updated", legId: leg.legId, field, value: eventDate });
    refreshTrackedLegs().catch(e => console.error("AIS listener: tracked-legs refresh failed:", e.message)); // re-pull so a leg with both fields now confirmed stops being tracked
  }

  // Shared entry point — the live connection's ws.on("message") calls this, and so does the Test
  // Tools AIS Simulator (routes/ais.js), via the exact same function. No parallel code path.
  function ingestMessage(envelope) {
    lastMessageAt = new Date().toISOString();
    if (!envelope || typeof envelope !== "object") return;
    // Returns whatever the handler returns (a Promise, for a real write, or undefined) — the
    // live feed's own ws.on("message") call site ignores it, exactly as before; a caller that
    // needs the write to have landed (the Test Tools simulator) can await it.
    if (envelope.MessageType === "ShipStaticData") return handleShipStaticData(envelope);
    if (envelope.MessageType === "PositionReport") return handlePositionReport(envelope);
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
    const key = cachedSettings.ais_api_key;
    if (cachedSettings.api_ais_enabled !== "true" || !key) return; // applySettings already tore down any open socket

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
  // The one place in this module that actually awaits getSettings() — refreshes cachedSettings
  // unconditionally (even on the nextKey === currentKey fast-path exit) so every other function
  // in this file always reads a reasonably fresh snapshot without itself needing to be async.
  async function applySettings() {
    const settings = await getSettings();
    cachedSettings = settings;
    const nextKey = settings.api_ais_enabled === "true" ? (settings.ais_api_key || null) : null;
    if (nextKey === currentKey) return;
    currentKey = nextKey;
    disconnect();
    reconnectAttempt = 0;
    if (nextKey) connect();
  }

  // trackedLegs used to be pulled inline (throttled to once per TRACKED_LEGS_REFRESH_MS) from
  // inside the hot handlePositionReport path — now that the read is a real async query, it's
  // refreshed on its own timer instead, in the background, and the hot path only ever reads
  // whatever the cache currently holds (same staleness bound as before).
  refreshTrackedLegs().catch(e => console.error("AIS listener: initial tracked-legs load failed:", e.message));
  setInterval(() => refreshTrackedLegs().catch(e => console.error("AIS listener: tracked-legs refresh failed:", e.message)), TRACKED_LEGS_REFRESH_MS);

  function getStatus() {
    return {
      connected: !!(ws && ws.readyState === WebSocket.OPEN),
      provider: cachedSettings.ais_provider || "aisstream",
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
  // that high-volume path, not an occasional manual simulate call. Now a real async call the
  // route handler awaits, rather than a synchronous forced pull.
  const forceRefreshTrackedLegs = () => refreshTrackedLegs();

  return { applySettings, ingestMessage, getStatus, stop, forceRefreshTrackedLegs };
}

module.exports = { createAisListener };
