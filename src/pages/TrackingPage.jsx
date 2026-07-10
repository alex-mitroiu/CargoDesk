import { useEffect, useState } from "react";

const STATUS_COLOR = {
  "Booking": "#6366f1",
  "In Transit": "#f59e0b",
  "Arrived": "#10b981",
  "Delivered": "#10b981",
  "Cancelled": "#ef4444",
};

const STEP_ICONS = {
  "Booking Confirmed":  "📋",
  "SI Submitted":       "📄",
  "Cargo Gated In":     "🏭",
  "Vessel Departed":    "🚢",
  "B/L Issued":         "📃",
  "Vessel Arrived":     "⚓",
  "Customs Cleared":    "✅",
  "Cargo Released":     "📦",
  "Delivered":          "🎯",
};

function fmt(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return d; }
}

function StatusBadge({ status }) {
  const bg = STATUS_COLOR[status] || "#64748b";
  return (
    <span style={{
      display: "inline-block", padding: "3px 12px", borderRadius: 20,
      fontSize: 13, fontWeight: 600, color: "#fff", background: bg, letterSpacing: "0.02em",
    }}>{status}</span>
  );
}

function Card({ title, children, style }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12,
      padding: "20px 24px", marginBottom: 20, ...style,
    }}>
      {title && <div style={{ fontWeight: 700, fontSize: 14, color: "#475569", marginBottom: 14, letterSpacing: "0.05em", textTransform: "uppercase" }}>{title}</div>}
      {children}
    </div>
  );
}

function Row({ label, value }) {
  if (!value || value === "—") return null;
  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 8, fontSize: 14 }}>
      <span style={{ color: "#94a3b8", minWidth: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ color: "#1e293b", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function MilestoneTimeline({ milestones }) {
  if (!milestones?.length) return <p style={{ color: "#94a3b8", fontSize: 14 }}>No milestones available.</p>;

  return (
    <div>
      {milestones.map((m, i) => {
        const done = !!m.completed_at;
        const icon = STEP_ICONS[m.label] || "•";
        return (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 16 }}>
            {/* Circle */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{
                width: 32, height: 32, borderRadius: 16,
                background: done ? "#10b981" : "#e2e8f0",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 15, flexShrink: 0,
                border: done ? "2px solid #059669" : "2px solid #cbd5e1",
              }}>
                {done ? "✓" : icon}
              </div>
              {i < milestones.length - 1 && (
                <div style={{ width: 2, height: 24, background: done ? "#10b981" : "#e2e8f0", marginTop: 2 }} />
              )}
            </div>
            {/* Label */}
            <div style={{ paddingTop: 4 }}>
              <div style={{ fontSize: 14, fontWeight: done ? 600 : 400, color: done ? "#1e293b" : "#94a3b8" }}>
                {m.label}
              </div>
              {done
                ? <div style={{ fontSize: 12, color: "#64748b" }}>Completed {fmt(m.completed_at)}</div>
                : m.estimated_date
                  ? <div style={{ fontSize: 12, color: "#94a3b8" }}>Est. {fmt(m.estimated_date)}</div>
                  : null
              }
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LegRow({ leg, idx }) {
  const motIcon = { SEA: "🚢", AIR: "✈️", RAIL: "🚂", ROAD: "🚛" }[leg.mot] || "•";
  return (
    <div style={{
      background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8,
      padding: "12px 16px", marginBottom: 10, fontSize: 14,
    }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 6 }}>
        <span>{motIcon}</span>
        <span style={{ fontWeight: 600, color: "#1e293b" }}>Leg {idx + 1} — {leg.legType}</span>
        {leg.carrierCode && <span style={{ color: "#64748b", marginLeft: "auto", fontSize: 12 }}>{leg.carrierCode}</span>}
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <span style={{ color: "#475569" }}><b>POL:</b> {leg.pol || "—"}</span>
        <span style={{ color: "#475569" }}><b>POD:</b> {leg.pod || "—"}</span>
        {leg.etd && <span style={{ color: "#475569" }}><b>ETD:</b> {fmt(leg.etd)}</span>}
        {leg.eta && <span style={{ color: "#475569" }}><b>ETA:</b> {fmt(leg.eta)}</span>}
        {leg.vessel && <span style={{ color: "#475569" }}><b>Vessel:</b> {leg.vessel}</span>}
        {leg.voyage && <span style={{ color: "#475569" }}><b>Voyage:</b> {leg.voyage}</span>}
      </div>
    </div>
  );
}

export default function TrackingPage({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setError("No tracking token provided."); setLoading(false); return; }
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(r => {
        if (r.error) setError(r.error);
        else setData(r);
      })
      .catch(() => setError("Failed to load shipment data. Please check the link and try again."))
      .finally(() => setLoading(false));
  }, [token]);

  const containerStyle = {
    minHeight: "100vh", background: "#f1f5f9",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    color: "#1e293b",
  };

  const headerStyle = {
    background: "#0f172a", color: "#fff",
    padding: "18px 32px", display: "flex", alignItems: "center", gap: 12,
  };

  const innerStyle = { maxWidth: 860, margin: "0 auto", padding: "32px 16px" };

  if (loading) return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 700, fontSize: 18 }}>CargoDesk</span>
        <span style={{ color: "#94a3b8", fontSize: 14 }}>Shipment Tracking</span>
      </div>
      <div style={{ ...innerStyle, textAlign: "center", paddingTop: 80, color: "#64748b", fontSize: 16 }}>
        Loading shipment data…
      </div>
    </div>
  );

  if (error) return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 700, fontSize: 18 }}>CargoDesk</span>
        <span style={{ color: "#94a3b8", fontSize: 14 }}>Shipment Tracking</span>
      </div>
      <div style={{ ...innerStyle, textAlign: "center", paddingTop: 80 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontSize: 18, fontWeight: 600, color: "#ef4444", marginBottom: 8 }}>Link Unavailable</div>
        <div style={{ color: "#64748b", fontSize: 14 }}>{error}</div>
      </div>
    </div>
  );

  const polLabel = data.polName ? `${data.pol} — ${data.polName}` : data.pol;
  const podLabel = data.podName ? `${data.pod} — ${data.podName}` : data.pod;

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <span style={{ fontWeight: 700, fontSize: 18 }}>CargoDesk</span>
        <span style={{ color: "#475569", fontSize: 14 }}>·</span>
        <span style={{ color: "#94a3b8", fontSize: 14 }}>Shipment Tracking</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <StatusBadge status={data.status} />
        </div>
      </div>

      <div style={innerStyle}>
        {/* Title bar */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>
            {polLabel} → {podLabel}
          </div>
          <div style={{ color: "#64748b", fontSize: 14 }}>
            {data.carrierCode && <span>{data.carrierCode} &nbsp;·&nbsp; </span>}
            {data.serviceType} &nbsp;·&nbsp; {data.movementType}
            {data.bookingRef && <span> &nbsp;·&nbsp; BKG: {data.bookingRef}</span>}
            {data.blNumber && <span> &nbsp;·&nbsp; B/L: {data.blNumber}</span>}
          </div>
          {data.expiresAt && (
            <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>
              Link valid until {fmt(data.expiresAt)}
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          {/* Key dates */}
          <Card title="Voyage Details">
            <Row label="ETD" value={fmt(data.etd)} />
            <Row label="ETA" value={fmt(data.eta)} />
            <Row label="Cargo Ready" value={fmt(data.cargoReadyDate)} />
            <Row label="Vessel" value={data.vessel} />
            <Row label="Voyage" value={data.voyage} />
            <Row label="Incoterm" value={data.incoterm} />
          </Card>

          {/* Parties */}
          <Card title="Parties">
            <Row label="Shipper" value={data.shipperName} />
            <Row label="Consignee" value={data.consigneeName} />
          </Card>
        </div>

        {/* Containers */}
        {data.containers?.length > 0 && (
          <Card title="Containers">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {data.containers.map((c, i) => (
                <div key={i} style={{
                  background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8,
                  padding: "8px 16px", fontSize: 14,
                }}>
                  <span style={{ fontWeight: 600 }}>{c.count}× {c.type}</span>
                  {c.weight_kg && <span style={{ color: "#64748b", marginLeft: 8 }}>{(c.weight_kg).toLocaleString()} kg</span>}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Milestones */}
        <Card title="Milestone Tracker">
          <MilestoneTimeline milestones={data.milestones} />
        </Card>

        {/* Legs */}
        {data.legs?.length > 1 && (
          <Card title="Route Legs">
            {data.legs.map((leg, i) => <LegRow key={leg.id} leg={leg} idx={i} />)}
          </Card>
        )}

        <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 12, marginTop: 8 }}>
          Powered by CargoDesk · This is a read-only tracking view
        </div>
      </div>
    </div>
  );
}
