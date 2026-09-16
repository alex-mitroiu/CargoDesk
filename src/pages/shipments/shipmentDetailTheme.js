import { useEffect } from "react";

// ─── Trade Horizon (page-scoped) ────────────────────────────────────────────
// Same visual language already shipped on DashboardPage.jsx and CommandCenterView.jsx —
// duplicated here rather than imported from either, since all three are deliberately
// page-scoped restyles (never touching src/tokens.js or src/components/primitives/), so
// every other page keeps its current look regardless of what any of these three do. This
// module is imported ONLY by the Shipment Details experience (ShipmentHeaderBar,
// ShipmentDetailSidebar, ShipmentDetailPage, and the five promoted sub-pages) — approved
// design reference: https://claude.ai/artifact/SUaCjaQYTdaPHbXmm2FfYj
export const HZ_MONO    = "'IBM Plex Mono', ui-monospace, monospace";
export const HZ_BODY    = "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif";
export const HZ_DISPLAY = "'Sora', ui-sans-serif, system-ui, sans-serif";

export const HZ = {
  bg: "#080b15",
  surface: "rgba(255,255,255,0.045)",
  surface2: "rgba(255,255,255,0.075)",
  surfaceSolid: "#0c1120",
  border: "rgba(255,255,255,0.10)",
  borderStrong: "rgba(255,255,255,0.18)",
  text: "#f3f5fc",
  textMuted: "#8c93b5",
  textFaint: "#565d80",
  cyan: "#38d4e8",
  cyan2: "#3987e5",
  amber: "#fbc531",
  amber2: "#d9772a",
  violet: "#9085e9",
  violet2: "#d5519f",
  good: "#22c55e",
  warn: "#fab219",
  crit: "#f0526b",
  info: "#3987e5",
  goodBg: "rgba(34,197,94,0.13)",
  warnBg: "rgba(250,178,25,0.13)",
  critBg: "rgba(240,82,107,0.13)",
  infoBg: "rgba(57,135,229,0.14)",
  cyanBg: "rgba(56,212,232,0.12)",
  violetBg: "rgba(144,133,233,0.14)",
  gradCyan: "linear-gradient(135deg, #38d4e8, #3987e5)",
  gradAmber: "linear-gradient(135deg, #fbc531, #d9772a)",
  gradViolet: "linear-gradient(135deg, #9085e9, #d5519f)",
};

export const useHorizonFonts = () => {
  useEffect(() => {
    if (document.getElementById("hz-fonts")) return;
    const link = document.createElement("link");
    link.id = "hz-fonts"; link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
  }, []);
};

// Deterministic decorative gradient per carrier code — same derivation as the Dashboard's
// and Command Center's own hzGradientFor, duplicated for the same page-scoping reason.
export const hzGradientFor = code => {
  const grads = [[HZ.cyan, HZ.cyan2], [HZ.amber, HZ.amber2], [HZ.violet, HZ.violet2]];
  let hash = 0;
  for (let i = 0; i < (code || "").length; i++) hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  return grads[hash % grads.length];
};

// Real carrier livery colors — same table as Command Center's CARRIER_BRAND, so a carrier's
// badge reads the same way anywhere in the app's Trade Horizon surfaces.
export const CARRIER_BRAND = {
  HLCU: { bg: "#e67300", text: "#0a2540" },
  MAEU: { bg: "#42b0e6", text: "#04212e" },
  CMDU: { bg: "#0a2a53", text: "#ff6a39" },
  EGLV: { bg: "#0fae4b", text: "#052e14" },
  ONEY: { bg: "#e6007e", text: "#ffffff" },
  MSCU: { bg: "#ffd200", text: "#0a1f44" },
  COSU: { bg: "#e2231a", text: "#ffffff" },
  OOLU: { bg: "#004a99", text: "#ffffff" },
};
export const carrierBadgeColors = code => {
  const brand = CARRIER_BRAND[code];
  if (brand) return { background: brand.bg, color: brand.text };
  const [g1, g2] = hzGradientFor(code);
  return { background: `linear-gradient(145deg, ${g1}, ${g2})`, color: "#06111f" };
};
