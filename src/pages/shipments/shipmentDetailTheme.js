import { useEffect } from "react";

// ─── Trade Horizon (page-scoped) ────────────────────────────────────────────
// Same visual language already shipped on DashboardPage.jsx and CommandCenterView.jsx —
// duplicated here rather than imported from either, since all three are deliberately
// page-scoped restyles (never touching src/tokens.js or src/components/primitives/), so
// every other page keeps its current look regardless of what any of these three do. This
// module is imported ONLY by the Shipment Details experience (ShipmentHeaderBar,
// ShipmentDetailSidebar, ShipmentDetailPage, and the five promoted sub-pages) — approved
// design references: https://claude.ai/artifact/SUaCjaQYTdaPHbXmm2FfYj (dark, shipped),
// https://claude.ai/artifact/4TT7XbcM9JfgtbQ1LPh7jy (light, TKT-198GZH).
export const HZ_MONO    = "'IBM Plex Mono', ui-monospace, monospace";
export const HZ_BODY    = "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif";
export const HZ_DISPLAY = "'Sora', ui-sans-serif, system-ui, sans-serif";

// Dark — the original, already-shipped palette, unchanged.
const HZ_DARK = {
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
  // Pill TEXT often reads a shade lighter than the "solid" swatch above it (e.g. a status
  // pill's info/violet text needs to be brighter than the accent's own solid value to stay
  // legible on a dark, low-alpha tint background) — named separately so light mode (where the
  // relationship inverts — see HZ_LIGHT) can override them independently of the base hues.
  goodPillText: "#7fe3a5",
  infoPillText: "#7db2f2",
  violetPillText: "#c6bffb",
  // Gradient-badge text (carrier fallback chips, etc.) — near-black on dark mode's light/pastel
  // gradients; light mode's much darker gradients (see HZ_LIGHT) need white instead.
  chipText: "#06111f",
  // Glass-card treatment — blur alone reads as elevation on near-black; light mode instead
  // leans on a real drop shadow (see HZ_LIGHT's own comment), so cardShadow is "none" here.
  cardBlur: "blur(20px)",
  cardShadow: "none",
  // Floating popovers/tooltips (not cards) need a real drop shadow in BOTH themes to lift off the
  // page — cardShadow is "none" in dark, so it cannot double as this.
  popoverShadow: "0 8px 24px rgba(0,0,0,.45)",
};

// Light — TKT-198GZH, published as a design exploration and validated (WCAG contrast pass +
// the dataviz skill's CVD simulator) before being wired in here. Not just re-hexed: accents got
// darker/more saturated (a cyan/gold that pops on near-black is under 4:1 on white), and info/
// warn were re-hued off their own accent (today's dark theme has info literally == cyan-2, and
// warn only ~8° from amber) since a "translate the exact same mistake" pass would ship the same
// two hue collisions into light mode. Known, disclosed residual limit (not fixable by hex choice
// alone): good/crit still fails the CVD simulator's normal-vision floor — the standard red-green
// collision — mitigated the same way the shipped dark component already does it: every status
// pill carries an icon + label, never color alone.
const HZ_LIGHT = {
  bg: "#f4f6fb",
  // 72% white wash, not the usual 4-9% tint — on white, a dark-mode-strength tint is invisible,
  // so the card needs to be near-opaque and lean on cardShadow (below) as the real depth cue.
  surface: "rgba(255,255,255,0.72)",
  surface2: "rgba(255,255,255,0.85)",
  surfaceSolid: "#ffffff",
  border: "rgba(15,20,40,0.12)",
  borderStrong: "rgba(15,20,40,0.22)",
  text: "#10142a",
  textMuted: "#5b6178",
  textFaint: "#7c8299",
  cyan: "#006970",
  cyan2: "#006795",
  amber: "#796100",
  amber2: "#8c5000",
  violet: "#8d45b3",
  violet2: "#9d2962",
  good: "#087736",
  warn: "#af4e05",
  crit: "#ad0e3a",
  info: "#034da8",
  goodBg: "rgba(8,119,54,0.10)",
  warnBg: "rgba(175,78,5,0.10)",
  critBg: "rgba(173,14,58,0.10)",
  infoBg: "rgba(3,77,168,0.10)",
  cyanBg: "rgba(0,105,112,0.10)",
  violetBg: "rgba(141,69,179,0.10)",
  gradCyan: "linear-gradient(135deg, #006970, #006795)",
  gradAmber: "linear-gradient(135deg, #796100, #8c5000)",
  gradViolet: "linear-gradient(135deg, #8d45b3, #9d2962)",
  // On light, the tint background is already legible against a saturated accent — pill text
  // just uses the accent solid directly instead of a separately-lightened shade.
  goodPillText: "#087736",
  infoPillText: "#034da8",
  violetPillText: "#8d45b3",
  chipText: "#ffffff",
  cardBlur: "blur(20px) saturate(1.3)",
  cardShadow: "0 1px 2px rgba(16,20,40,.05), 0 14px 32px -16px rgba(16,20,40,.20)",
  // Softer than dark's: a 45%-black shadow reads as a smudge on a light page.
  popoverShadow: "0 4px 8px -2px rgba(16,20,40,.08), 0 12px 28px -8px rgba(16,20,40,.28)",
};

// T is mutated in place when the theme switches (src/tokens.js) — HZ follows the identical
// pattern, driven by the exact same app-wide dark/light toggle (see applyHzTheme below and its
// call site in App.jsx), not a separate Trade-Horizon-only control.
export const HZ = { ...HZ_DARK };

export const applyHzTheme = (dark) => {
  Object.assign(HZ, dark ? HZ_DARK : HZ_LIGHT);
};

// Shape-compatible adapter onto the app's normal T token keys (bg/surface/border/text/
// textMuted/mono/body/accent/accentBg/info/warning/danger) — for the small number of shared
// components (LegsTable/LegRow, defined in ShipmentFormPage.jsx and also rendered by the
// New/Edit Shipment form, out of this redesign's scope) that take an optional `theme` prop
// instead of importing T directly, so passing this in restyles them to Trade Horizon without
// touching their other consumer, which keeps passing nothing and gets the app's normal theme.
// A plain object (not itself kept live) would go stale the moment HZ switches — every value
// here is read through a getter instead, so it stays in sync with HZ automatically.
export const HZ_LEGACY_THEME = {
  get bg() { return HZ.bg; }, get surface() { return HZ.surface; }, get border() { return HZ.border; },
  get text() { return HZ.text; }, get textMuted() { return HZ.textMuted; },
  get mono() { return HZ_MONO; }, get body() { return HZ_BODY; },
  get accent() { return HZ.cyan; }, get accentBg() { return HZ.cyanBg; },
  get info() { return HZ.info; }, get warning() { return HZ.warn; }, get danger() { return HZ.crit; },
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
// and Command Center's own hzGradientFor, duplicated for the same page-scoping reason. Reads
// HZ live on every call (not a frozen snapshot), so it automatically follows a theme switch.
export const hzGradientFor = code => {
  const grads = [[HZ.cyan, HZ.cyan2], [HZ.amber, HZ.amber2], [HZ.violet, HZ.violet2]];
  let hash = 0;
  for (let i = 0; i < (code || "").length; i++) hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  return grads[hash % grads.length];
};

// Real carrier livery colors — same table as Command Center's CARRIER_BRAND, so a carrier's
// badge reads the same way anywhere in the app's Trade Horizon surfaces. Deliberately
// theme-invariant (a carrier's real brand color doesn't change with light/dark) — only the
// hash-fallback gradient path below needs HZ.chipText for legible badge text in both themes.
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
  return { background: `linear-gradient(145deg, ${g1}, ${g2})`, color: HZ.chipText };
};
