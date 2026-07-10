import { useState, useEffect } from "react";
import { T, toIso, addDays } from "../tokens";
import { api } from "../api";
import CommandCenterView from "../components/shared/CommandCenterView";

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
const LandingPage = ({ shipments = [], containers = [], carriers = [], allocations = [], onNewShipment, navigate, isDark = true }) => {
  // Command Center toggle — state only; early return is below all hooks
  const [cmdCenter, setCmdCenter] = useState(() => localStorage.getItem("cc_active") === "1");
  const toggleCC = () => setCmdCenter(p => {
    const next = !p;
    localStorage.setItem("cc_active", next ? "1" : "0");
    return next;
  });

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

  // Currency converter
  const [fxRates,   setFxRates]   = useState({});
  const [fxFrom,    setFxFrom]    = useState(() => localStorage.getItem("fx_from") || "EUR");
  const [fxTo,      setFxTo]      = useState(() => localStorage.getItem("fx_to")   || "USD");
  const [fxAmount,  setFxAmount]  = useState("1000");

  useEffect(() => {
    api.fx.rates().then(r => setFxRates(r.rates || {})).catch(() => {});
  }, []);

  const fxConvert = (amt, from, to) => {
    const n = parseFloat(amt);
    if (!n || from === to) return n || 0;
    const toUsd = from === "USD" ? n : (fxRates[from] ? n / fxRates[from] : null);
    if (toUsd === null) return null;
    return to === "USD" ? toUsd : toUsd * (fxRates[to] || 1);
  };
  const fxResult = fxConvert(fxAmount, fxFrom, fxTo);

  const swapFx = () => {
    setFxFrom(fxTo); setFxTo(fxFrom);
    localStorage.setItem("fx_from", fxTo);
    localStorage.setItem("fx_to",   fxFrom);
  };

  const FX_CURRENCIES = ["USD","EUR","GBP","CHF","JPY","CNY","SGD","HKD","AED","SAR","AUD","CAD","DKK","NOK","SEK","INR","BRL","MXN","ZAR","TRY"];
  const selStyle = { background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5,
    color: T.text, fontFamily: T.mono, fontSize: 12, padding: "4px 6px", outline: "none", cursor: "pointer" };

  // System messages
  const [sysMessages, setSysMessages] = useState([]);
  const [showMsgForm, setShowMsgForm] = useState(false);
  const emptyMsgForm = { title:"", body:"", severity:"info", activeFrom:"", activeTo:"" };
  const [msgForm, setMsgForm]         = useState(emptyMsgForm);

  const loadMessages = () => api.systemMessages.list().then(setSysMessages).catch(() => {});
  useEffect(() => { loadMessages(); }, []);

  const addMessage = async () => {
    if (!msgForm.title.trim()) return;
    try {
      await api.systemMessages.create(msgForm);
      setMsgForm(emptyMsgForm);
      setShowMsgForm(false);
      loadMessages();
    } catch {}
  };

  const fmtDatetime = iso => {
    if (!iso) return null;
    const [date, time] = iso.split("T");
    if (!date) return null;
    const d = new Date(date + "T12:00:00");
    const datePart = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    return time ? `${datePart}, ${time}` : datePart;
  };
  const removeMessage = async (id) => {
    try { await api.systemMessages.remove(id); loadMessages(); } catch {}
  };

  const severityStyle = s => ({
    info:    { border: `1px solid ${T.info}44`,    borderLeft: `3px solid ${T.info}`,    bg: T.infoBg    },
    warning: { border: `1px solid ${T.warning}44`, borderLeft: `3px solid ${T.warning}`, bg: T.warningBg },
    danger:  { border: `1px solid ${T.danger}44`,  borderLeft: `3px solid ${T.danger}`,  bg: T.dangerBg  },
    success: { border: `1px solid ${T.success}44`, borderLeft: `3px solid ${T.success}`, bg: T.successBg },
  }[s] || { border: `1px solid ${T.border}`, borderLeft: `3px solid ${T.border}`, bg: T.surface });

  const sevColor = { info: T.info, warning: T.warning, danger: T.danger, success: T.success };

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

  const activeCount   = shipments.filter(s => s.status === "Active").length;
  const overdueCount  = shipments.filter(s => s.overdueCount > 0).length;

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

  // Shipments requiring review
  const reviewShipments = shipments.filter(s => s.status === "Requires Review");

  // Attention panel tab
  const [attnTab, setAttnTab] = useState("configs");

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
  const getISOWeek = d => {
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    return Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  };

  // Card styles
  const card = extra => ({
    background: T.surface, border: `1px solid ${T.border}`,
    borderRadius: 12, padding: "20px 22px", ...extra,
  });

  // Early return for Command Center — placed after all hooks
  // Uses position:fixed to escape <main>'s scroll container entirely.
  // top:46  = app header height
  // bottom:36 = app footer height (padding 9+9 + ~16px text + 1px border)
  // left:240  = sidebar width
  if (cmdCenter) {
    return (
      <div style={{
        position: "fixed", top: 46, bottom: 36, left: 240, right: 0,
        zIndex: 150,
      }}>
        <CommandCenterView
          shipments={shipments}
          containers={containers}
          carriers={carriers}
          allocations={allocations}
          isDark={isDark}
          onExit={toggleCC}
          onNavigate={(page, filter) => {
            if (filter) sessionStorage.setItem("cc_filter", JSON.stringify(filter));
            toggleCC();
            navigate(page);
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>

      {/* ── Hero greeting ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, gap: 20 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 32, fontWeight: 800, color: T.text, margin: "0 0 6px" }}>
            {greeting()} ⚓
          </h1>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted, maxWidth: 640, lineHeight: 1.6, fontStyle: "italic" }}>
            "{quote.text}"
            <span style={{ fontStyle: "normal", color: T.border, marginLeft: 8 }}>— {quote.author}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={toggleCC}
          style={{
            flexShrink: 0,
            display: "flex", alignItems: "center", gap: 7,
            padding: "9px 16px",
            borderRadius: 9,
            border: "1px solid #f97316",
            background: "none",
            color: "#f97316",
            cursor: "pointer",
            fontFamily: T.mono,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: ".04em",
            boxShadow: "0 0 12px #f9731622",
            transition: "all .15s",
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = "#f9731614";
            e.currentTarget.style.boxShadow  = "0 0 20px #f9731644";
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = "none";
            e.currentTarget.style.boxShadow  = "0 0 12px #f9731622";
          }}>
          ✦ Command Center
        </button>
      </div>

      {/* ── Top row: clock / weather / quick stats ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }}>

        {/* Clock */}
        <div style={card()}>
          <div style={{ fontFamily: T.mono, fontSize: 36, fontWeight: 700, color: T.accent, letterSpacing: "0.04em", lineHeight: 1 }}>
            {fmtTime(now)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
            <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>
              {fmtDate(now)}
            </div>
            <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.accent,
              background: T.accentBg, border: `1px solid ${T.accent}44`,
              borderRadius: 5, padding: "2px 8px", flexShrink: 0 }}>
              CW {getISOWeek(now)}
            </span>
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
            { label: "Overdue Milestones", value: overdueCount,     icon: "⏰", color: overdueCount   > 0 ? T.danger  : T.success   },
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

      {/* ── Currency converter + System messages ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>

        {/* Currency Converter */}
        <div style={card({ display: "flex", flexDirection: "column", gap: 14 })}>
          <div style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".1em" }}>
            💱 Currency Converter
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="number" min="0" value={fxAmount}
              onChange={e => setFxAmount(e.target.value)}
              style={{ width: 90, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5,
                color: T.text, fontFamily: T.mono, fontSize: 13, padding: "5px 8px", outline: "none" }}
            />
            <select value={fxFrom}
              onChange={e => { setFxFrom(e.target.value); localStorage.setItem("fx_from", e.target.value); }}
              style={selStyle}>
              {FX_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button onClick={swapFx}
              title="Swap currencies"
              style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, borderRadius: 5,
                color: T.accent, cursor: "pointer", padding: "4px 9px", fontSize: 14, lineHeight: 1 }}>
              ⇄
            </button>
            <select value={fxTo}
              onChange={e => { setFxTo(e.target.value); localStorage.setItem("fx_to", e.target.value); }}
              style={selStyle}>
              {FX_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {fxResult !== null ? (
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 28, fontWeight: 800, color: T.accent, lineHeight: 1 }}>
                {fxTo} {fxResult.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 4 }}>
                {parseFloat(fxAmount).toLocaleString("en-US")} {fxFrom} at ECB rate
              </div>
            </div>
          ) : (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
              {Object.keys(fxRates).length === 0 ? "Loading rates…" : "Enter an amount above"}
            </div>
          )}
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.border, marginTop: "auto" }}>
            Rates via frankfurter.app (ECB) · Refreshed daily
          </div>
        </div>

        {/* System Messages */}
        <div style={card({ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" })}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "16px 18px 12px" }}>
            <div style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".1em" }}>
              📣 System Messages
            </div>
            <button
              onClick={() => setShowMsgForm(v => !v)}
              title="Post a new system message"
              style={{ background: showMsgForm ? T.accentBg : "none",
                border: `1px solid ${showMsgForm ? T.accent : T.border}`,
                borderRadius: 5, color: showMsgForm ? T.accent : T.textMuted,
                cursor: "pointer", padding: "3px 10px", fontFamily: T.body, fontSize: 12, fontWeight: 600 }}>
              {showMsgForm ? "✕ Cancel" : "+ Post"}
            </button>
          </div>

          {/* New message form */}
          {showMsgForm && (
            <div style={{ padding: "0 18px 14px", borderBottom: `1px solid ${T.border}22`,
              display: "flex", flexDirection: "column", gap: 8 }}>
              <input placeholder="Title…" value={msgForm.title}
                onChange={e => setMsgForm(p => ({ ...p, title: e.target.value }))}
                style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5,
                  color: T.text, fontFamily: T.body, fontSize: 13, padding: "6px 10px", outline: "none" }} />
              <textarea placeholder="Body (optional)…" value={msgForm.body} rows={2}
                onChange={e => setMsgForm(p => ({ ...p, body: e.target.value }))}
                style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5,
                  color: T.text, fontFamily: T.body, fontSize: 12, padding: "6px 10px",
                  outline: "none", resize: "vertical" }} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>Severity</span>
                  <select value={msgForm.severity} onChange={e => setMsgForm(p => ({ ...p, severity: e.target.value }))}
                    style={{ ...selStyle, fontSize: 11 }}>
                    {["info","warning","danger","success"].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>Active from</span>
                  <input type="datetime-local" value={msgForm.activeFrom}
                    onChange={e => setMsgForm(p => ({ ...p, activeFrom: e.target.value }))}
                    style={{ ...selStyle, fontSize: 11 }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted }}>Active to</span>
                  <input type="datetime-local" value={msgForm.activeTo}
                    onChange={e => setMsgForm(p => ({ ...p, activeTo: e.target.value }))}
                    style={{ ...selStyle, fontSize: 11 }} />
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button onClick={addMessage}
                  style={{ background: T.accent, border: "none", borderRadius: 5,
                    color: T.btnPrimaryText, cursor: "pointer", padding: "6px 18px",
                    fontFamily: T.body, fontSize: 12, fontWeight: 600 }}>
                  Post
                </button>
              </div>
            </div>
          )}

          {/* Message list */}
          <div style={{ flex: 1, overflowY: "auto", maxHeight: 220 }}>
            {sysMessages.length === 0 ? (
              <div style={{ padding: "24px 18px", fontFamily: T.body, fontSize: 13,
                color: T.textMuted, fontStyle: "italic" }}>
                No active system messages.
              </div>
            ) : sysMessages.map(m => {
              const st = severityStyle(m.severity);
              return (
                <div key={m.id} style={{ margin: "8px 12px", borderRadius: 7,
                  background: st.bg, border: st.border, borderLeft: st.borderLeft, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700,
                      color: sevColor[m.severity] || T.text, flex: 1 }}>
                      {m.title}
                    </div>
                    <button onClick={() => removeMessage(m.id)}
                      style={{ background: "none", border: "none", cursor: "pointer",
                        color: T.textMuted, fontSize: 14, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
                      onMouseEnter={e => e.currentTarget.style.color = T.danger}
                      onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
                      ✕
                    </button>
                  </div>
                  {m.body && (
                    <div style={{ fontFamily: T.body, fontSize: 12, color: T.text,
                      marginTop: 4, lineHeight: 1.5 }}>
                      {m.body}
                    </div>
                  )}
                  {(m.activeFrom || m.activeTo) && (
                    <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, marginTop: 6 }}>
                      {m.activeFrom && `From ${fmtDatetime(m.activeFrom)}`}
                      {m.activeFrom && m.activeTo && " · "}
                      {m.activeTo && `Until ${fmtDatetime(m.activeTo)}`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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

      {/* ── Requires Attention ── */}
      {(attnAllocations.length > 0 || reviewShipments.length > 0) && (
        <div style={{
          ...card({ marginBottom: 14, padding: 0, overflow: "hidden" }),
          borderTop: `3px solid ${T.warning}`,
        }}>
          {/* Header + tabs */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "16px 22px 0" }}>
            <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.warning }}>
              ⚠ Requires Attention
            </div>
            <button onClick={() => navigate(attnTab === "configs" ? "space-configs" : "shipments")}
              style={{ background: "none", border: `1px solid ${T.warning}55`, borderRadius: 6,
                color: T.warning, cursor: "pointer", padding: "4px 12px",
                fontFamily: T.body, fontSize: 12, fontWeight: 600 }}>
              {attnTab === "configs" ? "View Space Configs →" : "View Shipments →"}
            </button>
          </div>

          {/* Tab pills */}
          <div style={{ display: "flex", gap: 6, padding: "12px 22px 0" }}>
            {[
              { key: "configs",   label: "Space Configs",   count: attnAllocations.length },
              { key: "shipments", label: "Shipment Review", count: reviewShipments.length },
            ].map(({ key, label, count }) => {
              const active = attnTab === key;
              return (
                <button key={key} onClick={() => setAttnTab(key)}
                  style={{ display: "flex", alignItems: "center", gap: 6,
                    padding: "5px 14px", borderRadius: 20, cursor: "pointer",
                    fontFamily: T.body, fontSize: 12, fontWeight: active ? 700 : 500,
                    background: active ? T.warning + "22" : "none",
                    color: active ? T.warning : T.textMuted,
                    border: active ? `1px solid ${T.warning}55` : `1px solid ${T.border}44`,
                    transition: "all .12s" }}>
                  {label}
                  {count > 0 && (
                    <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                      background: active ? T.warning : T.border,
                      color: active ? "#fff" : T.textMuted,
                      borderRadius: 10, padding: "1px 6px", minWidth: 18, textAlign: "center" }}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div style={{ height: 12 }} />

          {/* ── Tab: Space Configs ── */}
          {attnTab === "configs" && (
            attnAllocations.length === 0 ? (
              <div style={{ padding: "16px 22px 20px", fontFamily: T.body, fontSize: 13,
                color: T.textMuted, fontStyle: "italic" }}>
                No space configurations above their alert threshold.
              </div>
            ) : (
              <>
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
                    <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.accent }}>
                      {a.carrierCode}
                    </span>
                    <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>
                      {a.pol}
                      <span style={{ color: T.border, margin: "0 4px" }}>›</span>
                      {a.pod}
                    </div>
                    <div style={{ paddingRight: 16 }}>
                      <div style={{ height: 6, borderRadius: 3, background: T.bg, overflow: "hidden", marginBottom: 4 }}>
                        <div style={{ width: `${Math.min(a.pct, 100)}%`, height: "100%", borderRadius: 3,
                          background: a.pct >= 100 ? T.danger : T.warning, transition: "width .3s" }} />
                      </div>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                        {a.consumed} / {a.allocatedTEU} TEU
                        <span style={{ color: a.pct >= 100 ? T.danger : T.warning, fontWeight: 700, marginLeft: 6 }}>
                          {a.pct}%
                        </span>
                      </span>
                    </div>
                    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                      {a.alertThreshold}% limit
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 11,
                      color: a.endDate <= in30 ? T.warning : T.textMuted }}>
                      {a.endDate}
                    </span>
                  </div>
                ))}
              </>
            )
          )}

          {/* ── Tab: Requires Review shipments ── */}
          {attnTab === "shipments" && (
            reviewShipments.length === 0 ? (
              <div style={{ padding: "16px 22px 20px", fontFamily: T.body, fontSize: 13,
                color: T.textMuted, fontStyle: "italic" }}>
                No shipments currently require review.
              </div>
            ) : (
              <>
                <div style={{ display: "grid",
                  gridTemplateColumns: "130px 70px 70px 1fr 90px 80px 36px",
                  padding: "0 22px 6px", gap: 0 }}>
                  {["Shipment", "POL", "POD", "Carrier", "ETD", "TEU", ""].map((h, i) => (
                    <span key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
                      color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
                  ))}
                </div>
                {reviewShipments.map(s => {
                  const car = carriers.find(c => c.code === s.carrierCode);
                  const teu = containers.filter(c => c.shipmentId === s.id)
                    .reduce((acc, c) => acc + (c.size === "40" ? 2 : 1), 0);
                  return (
                    <div key={s.id} style={{ display: "grid",
                      gridTemplateColumns: "130px 70px 70px 1fr 90px 80px 36px",
                      padding: "10px 22px", gap: 0, alignItems: "center",
                      borderTop: `1px solid ${T.border}22` }}>
                      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, fontWeight: 700 }}>
                        {s.id}
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>
                        {s.pol}
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>
                        {s.pod}
                      </span>
                      <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                        <span style={{ color: T.accent, fontWeight: 700, fontFamily: T.mono, marginRight: 6 }}>
                          {s.carrierCode}
                        </span>
                        {car?.name}
                      </div>
                      <span style={{ fontFamily: T.mono, fontSize: 12,
                        color: s.etd ? T.text : T.textMuted }}>
                        {s.etd ? fmtEtd(s.etd) : "—"}
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>
                        {teu > 0 ? `${teu} TEU` : "—"}
                      </span>
                      <button
                        title={`Open ${s.id} in new tab`}
                        onClick={() => window.open(`#shipments/${s.id}`, "_blank")}
                        style={{ background: "none", border: "none", cursor: "pointer",
                          color: T.textMuted, fontSize: 15, padding: "2px 4px",
                          lineHeight: 1, borderRadius: 4 }}
                        onMouseEnter={e => { e.currentTarget.style.color = T.accent; e.currentTarget.style.background = T.accentBg; }}
                        onMouseLeave={e => { e.currentTarget.style.color = T.textMuted; e.currentTarget.style.background = "none"; }}>
                        ↗
                      </button>
                    </div>
                  );
                })}
              </>
            )
          )}

          <div style={{ height: 6 }} />
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