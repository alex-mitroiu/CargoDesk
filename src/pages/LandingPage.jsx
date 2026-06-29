import { useState, useEffect, useRef } from "react";
import { T, toIso, addDays } from "../tokens";
import { api } from "../api";

// ─── Quotes ───────────────────────────────────────────────────────────────────
const QUOTES = [
  { text: "A rough day at sea is still better than any day in the office.", author: "Anonymous" },
  { text: "A boat is a hole in the water into which you pour money.", author: "Kin Hubbard" },
  { text: "Any damn fool can navigate the world sober. It takes a really good sailor to do it drunk.", author: "Sir Francis Chichester" },
  { text: "Out of sight of land, the sailor feels safe. It is the beach that worries him.", author: "Charles Davis" },
  { text: "A ship is always referred to as 'she' because it costs so much to keep one in paint and powder.", author: "Kin Hubbard" },
  { text: "Work like a captain, play like a pirate.", author: "Unknown" },
  { text: "Admire a small ship, but put your freight in a large one; the larger the load, the greater the profit.", author: "Hesiod" },
  { text: "The sea does not reward those who are too anxious, too greedy or too impatient.", author: "Anne Morrow Lindbergh" },
  { text: "He who loves practice without theory is like the sailor who boards ship without a rudder.", author: "Leonardo da Vinci" },
  { text: "Keep calm and ship on.", author: "Freight Industry Proverb" },
  { text: "Every wave is a lesson, every storm a teacher.", author: "Unknown" },
  { text: "That's what a ship is — not just a keel and a hull and sails. What a ship is, really, is freedom.", author: "Capt. Jack Sparrow" },
  { text: "To reach a port we must set sail. Sail, not tie at anchor. Sail, not drift.", author: "Franklin D. Roosevelt" },
  { text: "It is not the ship so much as the skillful sailing that assures the prosperous voyage.", author: "George William Curtis" },
  { text: "Freight expectations always deliver.", author: "Anonymous Forwarder" },
  { text: "The man who has experienced shipwreck shudders even at a calm sea.", author: "Ovid" },
  { text: "Sea you later, freight-er!", author: "Every dock worker ever" },
  { text: "If you want to build a ship, teach them to long for the endless immensity of the sea.", author: "Antoine de Saint-Exupéry" },
];

// ─── Weather code → emoji + description ──────────────────────────────────────
const weatherDesc = code => {
  if (code === 0)              return { icon: "☀️",  label: "Clear sky" };
  if (code <= 2)               return { icon: "🌤️",  label: "Partly cloudy" };
  if (code === 3)              return { icon: "☁️",  label: "Overcast" };
  if (code <= 48)              return { icon: "🌫️",  label: "Foggy" };
  if (code <= 55)              return { icon: "🌦️",  label: "Drizzle" };
  if (code <= 65)              return { icon: "🌧️",  label: "Rain" };
  if (code <= 77)              return { icon: "🌨️",  label: "Snow" };
  if (code <= 82)              return { icon: "🌦️",  label: "Rain showers" };
  if (code <= 86)              return { icon: "🌨️",  label: "Snow showers" };
  return                              { icon: "⛈️",  label: "Thunderstorm" };
};

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
};

// ─── LandingPage ──────────────────────────────────────────────────────────────
const LandingPage = ({ shipments = [], containers = [], carriers = [], allocations = [], onNewShipment, navigate }) => {
  // Clock
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Quote — pick one on mount, re-roll each visit
  const [quote] = useState(() => QUOTES[Math.floor(Math.random() * QUOTES.length)]);

  // Weather
  const [city,    setCity]    = useState(() => localStorage.getItem("wd_city")  || "Rotterdam");
  const [editCity,setEditCity]= useState(false);
  const [cityInput,setCityInput]=useState(city);
  const [weather, setWeather] = useState(null);
  const [wErr,    setWErr]    = useState(null);

  const fetchWeather = async (cityName) => {
    setWErr(null);
    try {
      const geo = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`
      ).then(r => r.json());
      if (!geo.results?.length) { setWErr("City not found"); return; }
      const { latitude, longitude, name, country_code, timezone } = geo.results[0];
      const wx = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m` +
        `&wind_speed_unit=kmh&timezone=auto`
      ).then(r => r.json());
      setWeather({ ...wx.current, city: name, country: country_code, timezone });
    } catch { setWErr("Could not load weather"); }
  };

  useEffect(() => { fetchWeather(city); }, [city]);

  const applyCity = () => {
    const c = cityInput.trim();
    if (!c) return;
    setCity(c); localStorage.setItem("wd_city", c); setEditCity(false);
  };

  // Quick stats
  const [stats, setStats] = useState(null);
  useEffect(() => {
    Promise.all([
      api.ports.search({ limit: 1 }),
      api.vessels.list({ limit: 1 }),
    ]).then(([ports, vessels]) => setStats({
      ports:   ports.total,
      vessels: vessels.total,
    })).catch(() => {});
  }, []);

  // Upcoming departures — ETD within next 7 days
  const todayStr    = toIso(new Date());
  const in7         = addDays(todayStr, 7);
  const upcoming    = shipments
    .filter(s => s.etd && s.etd >= todayStr && s.etd <= in7 && s.status === "Active")
    .sort((a, b) => a.etd.localeCompare(b.etd))
    .slice(0, 5);

  const activeCount = shipments.filter(s => s.status === "Active").length;

  // Allocation KPIs — consumed TEU per carrier vs threshold
  const consumedByCarrier = {};
  shipments.forEach(s => {
    const teu = containers.filter(c => c.shipmentId === s.id).reduce((a, c) => a + (c.size === '40' ? 2 : 1), 0);
    consumedByCarrier[s.carrierCode] = (consumedByCarrier[s.carrierCode] || 0) + teu;
  });
  const activeAllocs   = allocations.filter(a => a.endDate >= todayStr);
  const aboveThreshold = activeAllocs.filter(a =>
    a.allocatedTEU > 0 && (consumedByCarrier[a.carrierCode] || 0) / a.allocatedTEU * 100 >= a.alertThreshold
  ).length;
  const in30           = addDays(todayStr, 30);
  const expiringCount  = activeAllocs.filter(a => a.endDate <= in30).length;

  // Allocations needing attention — above their alert threshold, sorted worst first
  const attnAllocations = activeAllocs
    .filter(a => a.allocatedTEU > 0 && (consumedByCarrier[a.carrierCode] || 0) / a.allocatedTEU * 100 >= a.alertThreshold)
    .map(a => ({
      ...a,
      consumed: consumedByCarrier[a.carrierCode] || 0,
      pct: Math.round((consumedByCarrier[a.carrierCode] || 0) / a.allocatedTEU * 100),
    }))
    .sort((a, b) => b.pct - a.pct);

  // Formatting helpers
  const fmtTime = d => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmtDate = d => d.toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  const fmtEtd  = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

  // Card styles
  const card = extra => ({
    background: T.surface, border: `1px solid ${T.border}`,
    borderRadius: 12, padding: "20px 22px", ...extra,
  });

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>

      {/* ── Hero greeting ── */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 32, fontWeight: 800, color: T.text, margin: "0 0 6px" }}>
          {greeting()} ⚓
        </h1>
        <div style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted, maxWidth: 640, lineHeight: 1.6, fontStyle: "italic" }}>
          "{quote.text}"
          <span style={{ fontStyle: "normal", color: T.border, marginLeft: 8 }}>— {quote.author}</span>
        </div>
      </div>

      {/* ── Top row: clock / weather / quick stats ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }}>

        {/* Clock */}
        <div style={card()}>
          <div style={{ fontFamily: T.mono, fontSize: 36, fontWeight: 700, color: T.accent, letterSpacing: "0.04em", lineHeight: 1 }}>
            {fmtTime(now)}
          </div>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, marginTop: 8, fontWeight: 600 }}>
            {fmtDate(now)}
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginTop: 4 }}>
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </div>
        </div>

        {/* Weather */}
        <div style={card()}>
          {wErr ? (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.danger }}>{wErr}</div>
          ) : !weather ? (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading weather…</div>
          ) : (() => {
            const { icon, label } = weatherDesc(weather.weather_code);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 34, lineHeight: 1 }}>{icon}</span>
                  <div>
                    <div style={{ fontFamily: T.mono, fontSize: 30, fontWeight: 700, color: T.text, lineHeight: 1 }}>
                      {Math.round(weather.temperature_2m)}°C
                    </div>
                    <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{label}</div>
                  </div>
                </div>
                <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600, marginTop: 4 }}>
                  {weather.city}
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginLeft: 6 }}>{weather.country}</span>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                  💨 {Math.round(weather.wind_speed_10m)} km/h · 💧 {weather.relative_humidity_2m}%
                </div>
              </div>
            );
          })()}
          {/* City selector */}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}33` }}>
            {editCity ? (
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={cityInput}
                  onChange={e => setCityInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && applyCity()}
                  autoFocus
                  placeholder="Enter city…"
                  style={{ flex: 1, background: T.bg, border: `1px solid ${T.accent}`, borderRadius: 5,
                    padding: "4px 8px", color: T.text, fontFamily: T.body, fontSize: 12, outline: "none" }}
                />
                <button onClick={applyCity}
                  style={{ background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 5,
                    color: T.accent, cursor: "pointer", padding: "4px 10px", fontFamily: T.body, fontSize: 12, fontWeight: 600 }}>
                  Set
                </button>
                <button onClick={() => setEditCity(false)}
                  style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 5,
                    color: T.textMuted, cursor: "pointer", padding: "4px 8px", fontFamily: T.body, fontSize: 12 }}>
                  ✕
                </button>
              </div>
            ) : (
              <button onClick={() => { setCityInput(city); setEditCity(true); }}
                style={{ background: "none", border: "none", cursor: "pointer",
                  color: T.textMuted, fontFamily: T.body, fontSize: 11, padding: 0 }}>
                ✎ Change city
              </button>
            )}
          </div>
        </div>

        {/* Quick stats */}
        <div style={card({ display: "flex", flexDirection: "column", gap: 10 })}>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, fontWeight: 700,
            textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 2 }}>
            Fleet Overview
          </div>
          {[
            { label: "Active Shipments",   value: activeCount,      icon: "📦", color: T.success                                    },
            { label: "Total Shipments",    value: shipments.length, icon: "🗂",  color: T.text                                       },
            { label: "Carriers",           value: carriers.length,  icon: "🏢", color: T.accent                                     },
            { label: "Over Threshold",     value: aboveThreshold,   icon: "⚠️", color: aboveThreshold > 0 ? T.warning : T.success   },
            { label: "Configs Expiring",   value: expiringCount,    icon: "📅", color: expiringCount  > 0 ? T.warning : T.success   },
          ].map(({ label, value, icon, color }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 15, width: 22, textAlign: "center" }}>{icon}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, flex: 1 }}>{label}</span>
              <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Upcoming departures ── */}
      <div style={card({ marginBottom: 14 })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>
            🛳  Upcoming Departures
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
            Next 7 days · Active shipments only
          </div>
        </div>

        {upcoming.length === 0 ? (
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.border, fontStyle: "italic", padding: "12px 0" }}>
            No departures in the next 7 days. Clear seas ahead! ⛵
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "130px 70px 70px 1fr 80px 90px", gap: 0 }}>
            {["Shipment", "POL", "POD", "Carrier", "ETD", "TEU"].map((h, i) => (
              <div key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted,
                textTransform: "uppercase", letterSpacing: ".08em", padding: "0 0 8px" }}>{h}</div>
            ))}
            {upcoming.map(s => {
              const carrier = carriers.find(c => c.code === s.carrierCode);
              const teu     = containers.filter(c => c.shipmentId === s.id).reduce((acc, c) => acc + (c.size === "40" ? 2 : 1), 0);
              return [
                <div key={s.id+"id"} style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, fontWeight: 700, padding: "8px 0", borderTop: `1px solid ${T.border}22` }}>{s.id}</div>,
                <div key={s.id+"pol"} style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600, padding: "8px 0", borderTop: `1px solid ${T.border}22` }}>{s.pol}</div>,
                <div key={s.id+"pod"} style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600, padding: "8px 0", borderTop: `1px solid ${T.border}22` }}>{s.pod}</div>,
                <div key={s.id+"car"} style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, padding: "8px 0", borderTop: `1px solid ${T.border}22` }}>
                  <span style={{ color: T.accent, fontWeight: 700, fontFamily: T.mono, marginRight: 6 }}>{s.carrierCode}</span>
                  {carrier?.name}
                </div>,
                <div key={s.id+"etd"} style={{ fontFamily: T.mono, fontSize: 12, color: T.success, fontWeight: 700, padding: "8px 0", borderTop: `1px solid ${T.border}22` }}>{fmtEtd(s.etd)}</div>,
                <div key={s.id+"teu"} style={{ fontFamily: T.mono, fontSize: 13, color: T.text, padding: "8px 0", borderTop: `1px solid ${T.border}22` }}>{teu > 0 ? `${teu} TEU` : "—"}</div>,
              ];
            })}
          </div>
        )}
      </div>

      {/* ── Allocations requiring attention ── */}
      {attnAllocations.length > 0 && (
        <div style={{
          ...card({ marginBottom: 14, padding: 0, overflow: "hidden" }),
          borderTop: `3px solid ${T.warning}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "16px 22px 12px" }}>
            <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.warning }}>
              ⚠ Requires Attention
            </div>
            <button onClick={() => navigate("dashboard")}
              style={{ background: "none", border: `1px solid ${T.warning}55`, borderRadius: 6,
                color: T.warning, cursor: "pointer", padding: "4px 12px",
                fontFamily: T.body, fontSize: 12, fontWeight: 600 }}>
              View Dashboard →
            </button>
          </div>

          {/* Column headers */}
          <div style={{ display: "grid",
            gridTemplateColumns: "80px 120px 1fr 110px 100px",
            padding: "0 22px 6px", gap: 0 }}>
            {["Carrier", "Route", "Utilisation", "Threshold", "Expires"].map((h, i) => (
              <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
            ))}
          </div>

          {attnAllocations.map(a => (
            <div key={a.id} style={{ display: "grid",
              gridTemplateColumns: "80px 120px 1fr 110px 100px",
              padding: "10px 22px", gap: 0, alignItems: "center",
              borderTop: `1px solid ${T.border}22` }}>

              {/* Carrier */}
              <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.accent }}>
                {a.carrierCode}
              </span>

              {/* Route */}
              <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>
                {a.pol}
                <span style={{ color: T.border, margin: "0 4px" }}>›</span>
                {a.pod}
              </div>

              {/* Utilisation bar + numbers */}
              <div style={{ paddingRight: 16 }}>
                <div style={{ height: 6, borderRadius: 3, background: T.bg, overflow: "hidden", marginBottom: 4 }}>
                  <div style={{
                    width: `${Math.min(a.pct, 100)}%`, height: "100%", borderRadius: 3,
                    background: a.pct >= 100 ? T.danger : T.warning,
                    transition: "width .3s",
                  }} />
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                  {a.consumed} / {a.allocatedTEU} TEU
                  <span style={{ color: a.pct >= 100 ? T.danger : T.warning, fontWeight: 700, marginLeft: 6 }}>
                    {a.pct}%
                  </span>
                </span>
              </div>

              {/* Threshold */}
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                {a.alertThreshold}% limit
              </span>

              {/* Expiry */}
              <span style={{ fontFamily: T.mono, fontSize: 11,
                color: a.endDate <= in30 ? T.warning : T.textMuted }}>
                {a.endDate}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Quick actions ── */}
      <div style={{ display: "flex", gap: 10 }}>
        {[
          { label: "＋ New Shipment",   action: onNewShipment,                    primary: true  },
          { label: "📦 Shipments",      action: () => navigate("shipments"),       primary: false },
          { label: "◈  Dashboard",      action: () => navigate("dashboard"),       primary: false },
          { label: "🚢 Vessels",        action: () => navigate("mdm-vessels"),     primary: false },
          { label: "📍 Port Locations", action: () => navigate("mdm-ports"),       primary: false },
        ].map(({ label, action, primary }) => (
          <button key={label} onClick={action}
            style={{
              flex: primary ? "none" : 1,
              padding: primary ? "11px 24px" : "11px 14px",
              borderRadius: 8, cursor: "pointer", fontFamily: T.body, fontSize: 13, fontWeight: 600,
              background: primary ? T.accent : T.surface,
              color:      primary ? T.btnPrimaryText : T.textMuted,
              border:     primary ? "none" : `1px solid ${T.border}`,
              transition: "background .12s, color .12s",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = primary ? T.accentHover : T.surfaceHover;
              if (!primary) e.currentTarget.style.color = T.text;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = primary ? T.accent : T.surface;
              if (!primary) e.currentTarget.style.color = T.textMuted;
            }}>
            {label}
          </button>
        ))}
      </div>

    </div>
  );
};

export default LandingPage;