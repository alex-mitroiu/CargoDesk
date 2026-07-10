export const CONTRACT_PRESETS = ["Pending", "SPOT", "Customer Own", "Central"];
export const CONTAINER_TYPES  = ["DC", "HC", "RF", "OT", "FR", "TK"];
export const STATUSES         = ["Active", "Pending", "Completed", "Cancelled", "Requires Review"];
export const teuOf = (size) => (size === "40" ? 2 : 1);

export const CONTAINER_OPTIONS = [
  { code: "20DC", size: "20", type: "DC", teu: 1, label: "20ft Dry Container", desc: "Standard dry cargo — general goods, non-temperature-sensitive" },
  { code: "40DC", size: "40", type: "DC", teu: 2, label: "40ft Dry Container", desc: "Standard dry cargo — general goods, non-temperature-sensitive" },
  { code: "40HC", size: "40", type: "HC", teu: 2, label: "40ft High Cube",     desc: "Extra interior height (9'6\") for voluminous or tall cargo" },
  { code: "20RF", size: "20", type: "RF", teu: 1, label: "20ft Reefer",        desc: "Temperature-controlled — food, pharma, cold-chain cargo" },
  { code: "40RF", size: "40", type: "RF", teu: 2, label: "40ft Reefer",        desc: "Temperature-controlled — food, pharma, cold-chain cargo" },
  { code: "20OT", size: "20", type: "OT", teu: 1, label: "20ft Open Top",      desc: "Removable roof — machinery, lumber, crane-loaded cargo" },
  { code: "40OT", size: "40", type: "OT", teu: 2, label: "40ft Open Top",      desc: "Removable roof — machinery, lumber, crane-loaded cargo" },
  { code: "20FR", size: "20", type: "FR", teu: 1, label: "20ft Flat Rack",     desc: "Collapsible ends — heavy machinery, vehicles, oversized loads" },
  { code: "40FR", size: "40", type: "FR", teu: 2, label: "40ft Flat Rack",     desc: "Collapsible ends — heavy machinery, vehicles, oversized loads" },
  { code: "20TK", size: "20", type: "TK", teu: 1, label: "20ft Tank",          desc: "Liquid bulk — chemicals, food-grade liquids, petroleum products" },
  { code: "40TK", size: "40", type: "TK", teu: 2, label: "40ft Tank",          desc: "Liquid bulk — chemicals, food-grade liquids, petroleum products" },
];

export const TIMEZONES = [
  "UTC",
  // Europe
  "Europe/London",        "Europe/Dublin",       "Europe/Lisbon",       "Europe/Reykjavik",
  "Europe/Madrid",        "Europe/Paris",        "Europe/Amsterdam",    "Europe/Brussels",
  "Europe/Luxembourg",    "Europe/Monaco",       "Europe/Andorra",      "Europe/Zurich",
  "Europe/Berlin",        "Europe/Vienna",       "Europe/Rome",         "Europe/Copenhagen",
  "Europe/Stockholm",     "Europe/Oslo",         "Europe/Helsinki",     "Europe/Tallinn",
  "Europe/Riga",          "Europe/Vilnius",      "Europe/Warsaw",       "Europe/Prague",
  "Europe/Bratislava",    "Europe/Budapest",     "Europe/Ljubljana",    "Europe/Zagreb",
  "Europe/Sarajevo",      "Europe/Belgrade",     "Europe/Tirane",       "Europe/Skopje",
  "Europe/Podgorica",     "Europe/Bucharest",    "Europe/Sofia",        "Europe/Athens",
  "Europe/Chisinau",      "Europe/Kiev",         "Europe/Minsk",        "Europe/Istanbul",
  "Europe/Moscow",        "Europe/Samara",       "Europe/Volgograd",
  // Americas – United States
  "America/New_York",     "America/Detroit",     "America/Indiana/Indianapolis",
  "America/Chicago",      "America/Menominee",   "America/Denver",      "America/Phoenix",
  "America/Los_Angeles",  "America/Anchorage",   "America/Juneau",      "America/Honolulu",
  // Americas – Canada
  "America/Toronto",      "America/Montreal",    "America/Halifax",     "America/St_Johns",
  "America/Winnipeg",     "America/Regina",      "America/Edmonton",    "America/Vancouver",
  "America/Whitehorse",   "America/Yellowknife",
  // Americas – Mexico & Caribbean
  "America/Mexico_City",  "America/Cancun",      "America/Mazatlan",    "America/Tijuana",
  "America/Havana",       "America/Jamaica",     "America/Port-au-Prince","America/Santo_Domingo",
  "America/Nassau",       "America/Panama",      "America/Costa_Rica",  "America/Guatemala",
  "America/Belize",       "America/Tegucigalpa", "America/Managua",     "America/El_Salvador",
  // Americas – South America
  "America/Bogota",       "America/Lima",        "America/Guayaquil",   "America/Caracas",
  "America/La_Paz",       "America/Manaus",      "America/Belem",       "America/Fortaleza",
  "America/Recife",       "America/Sao_Paulo",   "America/Montevideo",
  "America/Argentina/Buenos_Aires",              "America/Asuncion",
  "America/Guyana",       "America/Paramaribo",  "America/Cayenne",
  // Africa
  "Africa/Abidjan",       "Africa/Accra",        "Africa/Casablanca",   "Africa/Monrovia",
  "Africa/Lagos",         "Africa/Douala",       "Africa/Kinshasa",     "Africa/Luanda",
  "Africa/Algiers",       "Africa/Tunis",        "Africa/Tripoli",      "Africa/Cairo",
  "Africa/Nairobi",       "Africa/Addis_Ababa",  "Africa/Dar_es_Salaam","Africa/Kampala",
  "Africa/Kigali",        "Africa/Lusaka",       "Africa/Harare",       "Africa/Maputo",
  "Africa/Johannesburg",  "Africa/Khartoum",
  // Middle East
  "Asia/Nicosia",         "Asia/Beirut",         "Asia/Damascus",       "Asia/Jerusalem",
  "Asia/Amman",           "Asia/Riyadh",         "Asia/Kuwait",         "Asia/Qatar",
  "Asia/Bahrain",         "Asia/Dubai",          "Asia/Muscat",         "Asia/Baghdad",
  "Asia/Tehran",
  // Asia – Caucasus & Central
  "Asia/Baku",            "Asia/Tbilisi",        "Asia/Yerevan",
  "Asia/Ashgabat",        "Asia/Tashkent",       "Asia/Dushanbe",       "Asia/Bishkek",
  "Asia/Almaty",
  // Asia – South & Southeast
  "Asia/Kabul",           "Asia/Karachi",        "Asia/Kolkata",        "Asia/Colombo",
  "Asia/Kathmandu",       "Asia/Dhaka",          "Asia/Thimphu",        "Asia/Rangoon",
  "Asia/Bangkok",         "Asia/Ho_Chi_Minh",    "Asia/Phnom_Penh",     "Asia/Vientiane",
  "Asia/Kuala_Lumpur",    "Asia/Singapore",      "Asia/Jakarta",        "Asia/Makassar",
  "Asia/Jayapura",        "Asia/Manila",
  // Asia – East
  "Asia/Hong_Kong",       "Asia/Macau",          "Asia/Taipei",         "Asia/Shanghai",
  "Asia/Ulaanbaatar",     "Asia/Seoul",          "Asia/Tokyo",
  // Asia – Russia (east)
  "Asia/Yekaterinburg",   "Asia/Omsk",           "Asia/Novosibirsk",    "Asia/Krasnoyarsk",
  "Asia/Irkutsk",         "Asia/Chita",          "Asia/Yakutsk",        "Asia/Vladivostok",
  "Asia/Magadan",         "Asia/Sakhalin",       "Asia/Kamchatka",
  // Pacific & Oceania
  "Australia/Perth",      "Australia/Darwin",    "Australia/Adelaide",  "Australia/Brisbane",
  "Australia/Sydney",
  "Pacific/Auckland",     "Pacific/Fiji",        "Pacific/Apia",        "Pacific/Tongatapu",
  "Pacific/Port_Moresby", "Pacific/Guam",        "Pacific/Honolulu",
  // Indian Ocean
  "Indian/Maldives",      "Indian/Mauritius",    "Indian/Reunion",
];

// ─── Theme definitions ───────────────────────────────────────────────────────

export const DARK_THEME = {
  // Layout
  bg: "#080f1a", surface: "#0e1c2f", surfaceHover: "#122338",
  border: "#1a3354", borderMid: "#213f65",
  // Brand — warm amber
  accent: "#e8a217", accentBg: "rgba(232,162,23,0.12)", accentHover: "#f0b428",
  // Text
  text: "#dde8f5", textMuted: "#587a9b", textCode: "#60b8f0",
  // Semantic
  success: "#2dcc8f", successBg: "rgba(45,204,143,0.10)",
  danger:  "#ef5050", dangerBg:  "rgba(239,80,80,0.10)",
  warning: "#f5b84c", warningBg: "rgba(245,184,76,0.10)",
  info:    "#4db3e8", infoBg:    "rgba(77,179,232,0.10)",
  purple:  "#a855f7", purpleBg:  "rgba(168,85,247,0.12)",
  // Button-specific
  btnPrimaryText: "#07111e",
  btnSecondaryHoverBg: "#112030",
  btnDangerHoverBg: "rgba(239,80,80,0.12)",
  // Typography — custom stack
  mono: "'IBM Plex Mono', monospace",
  head: "'Syne', sans-serif",
  body: "'DM Sans', sans-serif",
};

export const LIGHT_THEME = {
  // Layout — Apple page/surface
  bg: "#F5F5F7", surface: "#FFFFFF", surfaceHover: "#F0F0F4",
  border: "#D2D2D7", borderMid: "#AEAEB2",
  // Brand — Apple blue (amber lacks contrast on white)
  accent: "#0071E3", accentBg: "rgba(0,113,227,0.07)", accentHover: "#0077ED",
  // Text — Apple label hierarchy
  text: "#1D1D1F", textMuted: "#6E6E73", textCode: "#0071E3",
  // Semantic — Apple iOS colours
  success: "#28CD41", successBg: "rgba(40,205,65,0.08)",
  danger:  "#FF3B30", dangerBg:  "rgba(255,59,48,0.08)",
  warning: "#FF9F0A", warningBg: "rgba(255,159,10,0.08)",
  info:    "#32ADE6", infoBg:    "rgba(50,173,230,0.08)",
  purple:  "#7C3AED", purpleBg:  "rgba(124,58,237,0.08)",
  // Button-specific
  btnPrimaryText: "#FFFFFF",
  btnSecondaryHoverBg: "#E8E8ED",
  btnDangerHoverBg: "rgba(255,59,48,0.09)",
  // Typography — Apple system stack
  mono: "'SF Mono', 'Menlo', 'Monaco', 'IBM Plex Mono', monospace",
  head: "-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif",
  body: "-apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif",
};

// T is mutated in place when the theme switches — all components re-render
// automatically since they're children of App which holds the theme state.
export const T = { ...DARK_THEME };

export const applyTheme = (dark) => {
  Object.assign(T, dark ? DARK_THEME : LIGHT_THEME);
  document.documentElement.style.background = T.bg;
  document.body.style.background            = T.bg;
  document.body.style.color                 = T.text;
};

export const MONTHS_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];
export const DAYS_SHORT  = ["Mo","Tu","We","Th","Fr","Sa","Su"];
export const parseIso  = iso => iso ? new Date(iso + "T12:00:00") : null;
export const toIso     = d   => d.toISOString().split("T")[0];
export const todayIso  = ()  => toIso(new Date());
export const fmtIso    = iso => {
  if (!iso) return "";
  const d = parseIso(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};
export const addDays   = (isoStr, n) => { const d = new Date(isoStr + "T12:00:00"); d.setDate(d.getDate() + n); return toIso(d); };
export const diffDays  = (a, b) => Math.round((new Date(b+"T12:00:00") - new Date(a+"T12:00:00")) / 86400000);
export const currentWeekStart = () => {
  const d = new Date(); const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return toIso(d);
};
export const MAX_RANGE_DAYS = 90;

export const LANE_BADGE_VARIANT = {
  "FE":"info","SEA":"info","ISC":"amber","ME":"warning","EU-N":"success","EU-S":"success",
  "NAM":"default","CAR":"default","SAM":"default","WAF":"danger","EAF":"danger",
  "SAF":"danger","NAF":"warning","OCE":"default",
};
export const statusVariant   = s => ({ Active:"success",Pending:"warning",Completed:"info",Cancelled:"danger","Requires Review":"purple" }[s] || "default");
export const contractVariant = c => ({ SPOT:"manual","Customer Own":"manual",Pending:"manual",Central:"central" }[c] || "default");

// ─── Contract-leg route matching ──────────────────────────────────────────────
// Mirrors the linked-port expansion in GET /api/contracts/match: a contract leg's
// pol_linked_allowed / pod_linked_allowed flags decide whether a shipment can match
// via a linked port on that side, instead of requiring an exact UN/LOCODE match.
export const buildLinkedPortIndex = (linkedPorts = []) => {
  const idx = {};
  linkedPorts.forEach(lp => {
    (idx[lp.primaryUnlocode] ??= new Set()).add(lp.linkedUnlocode);
    (idx[lp.linkedUnlocode]  ??= new Set()).add(lp.primaryUnlocode);
  });
  return idx;
};

export const matchedLegFor = (contract, linkedPortIdx, pol, pod) => {
  if (!contract?.legs?.length) return null;
  return contract.legs.find(leg => {
    const polOk = leg.pol === pol || (leg.polLinkedAllowed && linkedPortIdx[leg.pol]?.has(pol));
    const podOk = leg.pod === pod || (leg.podLinkedAllowed && linkedPortIdx[leg.pod]?.has(pod));
    return polOk && podOk;
  }) || null;
};

// Route match for a shipment against an allocation: when the allocation has a linked
// system contract, defer to that contract's legs (with linked-port expansion); otherwise
// fall back to a plain exact POL/POD comparison against the allocation's own fields.
export const allocationRouteMatch = (s, a, contractsById, linkedPortIdx) => {
  const contract = a.contractId ? contractsById[a.contractId] : null;
  if (contract) return !!matchedLegFor(contract, linkedPortIdx, s.pol, s.pod);
  return (!a.pol || s.pol === a.pol) && (!a.pod || s.pod === a.pod);
};


export const INCOTERMS_2020 = [
  {
    code: "EXW", name: "Ex Works", scope: "any",
    risk: "At seller's premises",
    seller: "Makes goods available at their premises only.",
    buyer: "Bears all costs and risks from seller's door to final destination.",
    notes: "Maximum obligation on buyer. Suitable for domestic trade or when buyer has own logistics.",
  },
  {
    code: "FCA", name: "Free Carrier", scope: "any",
    risk: "When goods delivered to named carrier at seller's premises or named place",
    seller: "Delivers to named carrier or other nominated person at agreed place.",
    buyer: "Bears all costs and risks once goods are handed to carrier.",
    notes: "Replaces FOB for containerised cargo. Can specify that buyer instructs carrier to issue on-board B/L.",
  },
  {
    code: "CPT", name: "Carriage Paid To", scope: "any",
    risk: "When goods delivered to first carrier",
    seller: "Contracts and pays for carriage to named destination. Risk transfers at first carrier handover.",
    buyer: "Bears risk from first carrier handover; seller pays freight.",
    notes: "Risk and cost transfer at different points — a common source of confusion.",
  },
  {
    code: "CIP", name: "Carriage and Insurance Paid To", scope: "any",
    risk: "When goods delivered to first carrier",
    seller: "As CPT, plus must obtain Institute Cargo Clauses (A) — all-risks insurance.",
    buyer: "Bears risk from first carrier handover.",
    notes: "Upgraded insurance vs CIF. Preferred for high-value cargo on any transport mode.",
  },
  {
    code: "DAP", name: "Delivered at Place", scope: "any",
    risk: "At named place of destination, ready for unloading",
    seller: "Bears all costs and risks to deliver to named destination, not unloaded.",
    buyer: "Responsible for unloading and import clearance.",
    notes: "Very common for door-to-door shipments. Customs clearance is buyer's responsibility.",
  },
  {
    code: "DPU", name: "Delivered at Place Unloaded", scope: "any",
    risk: "After goods unloaded at named place",
    seller: "Bears all costs and risks including unloading at destination.",
    buyer: "Responsible for import clearance after unloading.",
    notes: "Replaced DAT (Incoterms 2010). Seller must be able to organise unloading at destination.",
  },
  {
    code: "DDP", name: "Delivered Duty Paid", scope: "any",
    risk: "At named place of destination, ready for unloading",
    seller: "Maximum obligation — bears all costs including import duties and taxes to destination.",
    buyer: "Only needs to unload the goods.",
    notes: "Seller assumes full responsibility. Be cautious if seller cannot easily handle import formalities.",
  },
  {
    code: "FAS", name: "Free Alongside Ship", scope: "sea",
    risk: "When goods placed alongside vessel at named port",
    seller: "Delivers goods alongside vessel at named loading port. Export cleared by seller.",
    buyer: "Bears all costs from alongside ship onwards, including loading.",
    notes: "Suitable for bulk/break-bulk cargo. Buyer arranges loading.",
  },
  {
    code: "FOB", name: "Free On Board", scope: "sea",
    risk: "When goods on board vessel at named port of loading",
    seller: "Loads goods on board vessel nominated by buyer at named port.",
    buyer: "Bears all costs and risks from the moment goods are on board.",
    notes: "Most common term in ocean freight. Not recommended for containerised cargo — use FCA instead.",
  },
  {
    code: "CFR", name: "Cost and Freight", scope: "sea",
    risk: "When goods on board vessel at port of loading",
    seller: "Contracts and pays freight to named destination port. Risk transfers on loading.",
    buyer: "Bears risk from loading; seller pays ocean freight.",
    notes: "Like FOB but seller pays freight. Risk and cost split at different points.",
  },
  {
    code: "CIF", name: "Cost, Insurance and Freight", scope: "sea",
    risk: "When goods on board vessel at port of loading",
    seller: "As CFR, plus obtains minimum insurance (Institute Cargo Clauses C).",
    buyer: "Bears risk from loading; entitled to insurance policy proceeds.",
    notes: "Minimum insurance only. For higher-value cargo, consider CIP with Clauses (A).",
  },
];

// ─── IMDG Dangerous Goods Classes ────────────────────────────────────────────
// Source: IMDG Code / SeaRates IMO reference (https://www.searates.com/reference/imo/)
export const IMDG_CLASSES = [
  // Class 1 — Explosives
  { code: "1.1", classNum: "1", label: "Class 1.1", name: "Explosives — Mass Explosion Hazard",
    description: "Explosives that have a mass explosion hazard. A mass explosion affects almost the entire load instantaneously." },
  { code: "1.2", classNum: "1", label: "Class 1.2", name: "Explosives — Projection Hazard",
    description: "Explosives that have a projection hazard but not a mass explosion hazard." },
  { code: "1.3", classNum: "1", label: "Class 1.3", name: "Explosives — Fire, Blast or Projection Hazard",
    description: "Explosives that have a fire hazard and either a minor blast or projection hazard but not a mass explosion hazard." },
  { code: "1.4", classNum: "1", label: "Class 1.4", name: "Explosives — Minor Explosion Hazard",
    description: "Explosives that present a minor explosion hazard. Effects are largely confined to the package with no projection of fragments of appreciable size." },
  { code: "1.5", classNum: "1", label: "Class 1.5", name: "Explosives — Very Insensitive, Mass Explosion Hazard",
    description: "Very insensitive explosives with a mass explosion hazard but very little probability of initiation under normal transport conditions." },
  { code: "1.6", classNum: "1", label: "Class 1.6", name: "Explosives — Extremely Insensitive",
    description: "Extremely insensitive articles with no mass explosion hazard and negligible probability of accidental initiation." },
  // Class 2 — Gases
  { code: "2.1", classNum: "2", label: "Class 2.1", name: "Gases — Flammable Gas",
    description: "Gases ignitable at 101.3 kPa in a mixture of 13% or less by volume with air, or with a flammable range of at least 12% regardless of lower limit." },
  { code: "2.2", classNum: "2", label: "Class 2.2", name: "Gases — Non-flammable, Non-toxic Gas",
    description: "Compressed, liquefied, pressurized cryogenic, or dissolved gas. Exerts absolute pressure ≥ 280 kPa at 20°C. Does not meet 2.1 or 2.3 definitions." },
  { code: "2.3", classNum: "2", label: "Class 2.3", name: "Gases — Toxic Gas",
    description: "Gas toxic by inhalation, known or presumed to be toxic to humans, posing a health hazard during transportation." },
  // Class 3 — Flammable Liquids
  { code: "3",   classNum: "3", label: "Class 3",   name: "Flammable Liquids",
    description: "Liquids, or mixtures of liquids, with a flash point not more than 60°C (140°F). Includes flammable liquid desensitized explosives." },
  // Class 4 — Flammable Solids
  { code: "4.1", classNum: "4", label: "Class 4.1", name: "Flammable Solids, Self-Reactive Substances",
    description: "Solids that under normal transport conditions are readily combustible, or may cause or contribute to fire through friction. Includes self-reactive substances and solid desensitized explosives." },
  { code: "4.2", classNum: "4", label: "Class 4.2", name: "Spontaneously Combustible",
    description: "Substances liable to spontaneous heating under normal transport conditions, or to heating in contact with air, and likely to catch fire." },
  { code: "4.3", classNum: "4", label: "Class 4.3", name: "Dangerous When Wet",
    description: "Substances which, by interaction with water, emit flammable gases liable to spontaneous ignition or in quantities representing a hazard." },
  // Class 5 — Oxidizers
  { code: "5.1", classNum: "5", label: "Class 5.1", name: "Oxidizing Substances",
    description: "Substances that, while not necessarily combustible themselves, may cause or contribute to the combustion of other material by yielding oxygen." },
  { code: "5.2", classNum: "5", label: "Class 5.2", name: "Organic Peroxides",
    description: "Organic substances which contain the bivalent –O–O– structure. Thermally unstable, may combust, explode, or react dangerously with other substances." },
  // Class 6 — Toxic & Infectious
  { code: "6.1", classNum: "6", label: "Class 6.1", name: "Toxic Substances",
    description: "Substances liable to cause death, serious injury, or harm to human health if swallowed, inhaled, or if they come into contact with skin." },
  { code: "6.2", classNum: "6", label: "Class 6.2", name: "Infectious Substances",
    description: "Substances known or reasonably expected to contain pathogens — microorganisms including bacteria, viruses, parasites, prions — causing disease in humans or animals." },
  // Class 7 — Radioactive
  { code: "7",   classNum: "7", label: "Class 7",   name: "Radioactive Material",
    description: "Any material containing radionuclides where both the activity concentration and total activity exceed defined threshold values." },
  // Class 8 — Corrosives
  { code: "8",   classNum: "8", label: "Class 8",   name: "Corrosive Substances",
    description: "Substances or mixtures which, by chemical action, degrade or irreversibly damage living tissue on contact, or which severely damage or destroy other freight or the vessel." },
  // Class 9 — Miscellaneous
  { code: "9",   classNum: "9", label: "Class 9",   name: "Miscellaneous Dangerous Substances",
    description: "Substances and articles which, during transport, present a danger not covered by other classes. Includes lithium batteries, dry ice, elevated temperature materials, and magnetized materials." },
];

export const IMDG_CLASS_VARIANT = {
  "1": "danger", "2": "danger", "3": "danger",
  "4": "warning", "5": "warning",
  "6": "danger", "7": "amber", "8": "danger", "9": "default",
};