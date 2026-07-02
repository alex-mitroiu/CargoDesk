// seed-contracts.js — dummy contracts for HLCU, CMDU, MSCU
const BASE = "http://localhost:3001/api";

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.status); }
  return res.json();
};

const contracts = [
  // ── HLCU ─────────────────────────────────────────────────────────────────────
  {
    contractNumber: "HLCU-2026-AEX-001",
    carrierCode: "HLCU",
    namedAccount: "Global Freight Solutions",
    movementType: "FCL",
    containerTypes: ["20DC","40DC","40HC"],
    dgAllowed: true,
    imdgClasses: ["3","8","9"],
    validFrom: "2026-01-01", validTo: "2026-12-31",
    currency: "USD", status: "Active",
    notes: "Asia–Europe Express via Singapore. DG classes 3, 8, 9 permitted.",
    legs: [
      { pol:"CNSHA", polName:"Shanghai",   pod:"SGSIN", podName:"Singapore", transitDays:5,  vesselService:"AEX1" },
      { pol:"SGSIN", polName:"Singapore",  pod:"NLRTM", podName:"Rotterdam", transitDays:21, vesselService:"AEX1" },
    ],
    rates: [
      { serviceCode:"OF",    description:"Ocean Freight 20DC",               containerType:"20DC", amount:1200, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40DC",               containerType:"40DC", amount:2200, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40HC",               containerType:"40HC", amount:2400, currency:"USD", unit:"per_container" },
      { serviceCode:"BAF",   description:"Bunker Adjustment Factor",         containerType:"",     amount:350,  currency:"USD", unit:"per_container" },
      { serviceCode:"THC-O", description:"THC Origin — Shanghai",            containerType:"",     amount:150,  currency:"USD", unit:"per_container" },
      { serviceCode:"THC-D", description:"THC Destination — Rotterdam",      containerType:"",     amount:280,  currency:"EUR", unit:"per_container" },
      { serviceCode:"BL",    description:"Bill of Lading Fee",               containerType:"",     amount:65,   currency:"USD", unit:"per_bl"        },
      { serviceCode:"ISPS",  description:"ISPS Security Charge",             containerType:"",     amount:25,   currency:"USD", unit:"per_container" },
      { serviceCode:"IMO",   description:"DG Handling Surcharge",            containerType:"",     amount:180,  currency:"USD", unit:"per_container" },
    ],
  },
  {
    contractNumber: "HLCU-2026-TPW-002",
    carrierCode: "HLCU",
    namedAccount: "Pacific Trade Co.",
    movementType: "FCL",
    containerTypes: ["40DC","40HC","40RF"],
    dgAllowed: false, imdgClasses: [],
    validFrom: "2026-03-01", validTo: "2026-12-31",
    currency: "USD", status: "Active",
    notes: "Trans-Pacific West — Ningbo to Hamburg direct. Reefer equipped.",
    legs: [
      { pol:"CNNGB", polName:"Ningbo", pod:"DEHAM", podName:"Hamburg", transitDays:28, vesselService:"TPW" },
    ],
    rates: [
      { serviceCode:"OF",    description:"Ocean Freight 40DC",               containerType:"40DC", amount:2100, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40HC",               containerType:"40HC", amount:2300, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40RF",               containerType:"40RF", amount:3200, currency:"USD", unit:"per_container" },
      { serviceCode:"BAF",   description:"Bunker Adjustment Factor",         containerType:"",     amount:320,  currency:"USD", unit:"per_container" },
      { serviceCode:"THC-O", description:"THC Origin — Ningbo",              containerType:"",     amount:140,  currency:"USD", unit:"per_container" },
      { serviceCode:"THC-D", description:"THC Destination — Hamburg",        containerType:"",     amount:260,  currency:"EUR", unit:"per_container" },
      { serviceCode:"BL",    description:"Bill of Lading Fee",               containerType:"",     amount:60,   currency:"USD", unit:"per_bl"        },
      { serviceCode:"PSS",   description:"Peak Season Surcharge",            containerType:"",     amount:500,  currency:"USD", unit:"per_container" },
    ],
  },
  // ── CMDU ─────────────────────────────────────────────────────────────────────
  {
    contractNumber: "CMDU-2026-MED-001",
    carrierCode: "CMDU",
    namedAccount: "Euro Mediterranean Forwarding",
    movementType: "FCL",
    containerTypes: ["20DC","40DC","40HC"],
    dgAllowed: true,
    imdgClasses: ["2.1","3","9"],
    validFrom: "2026-02-01", validTo: "2026-12-31",
    currency: "USD", status: "Active",
    notes: "Asia–Mediterranean FAL1 service. DG classes 2.1, 3, 9 accepted.",
    legs: [
      { pol:"CNSHA", polName:"Shanghai",  pod:"SGSIN", podName:"Singapore", transitDays:4,  vesselService:"FAL1" },
      { pol:"SGSIN", polName:"Singapore", pod:"FRMRS", podName:"Marseille", transitDays:20, vesselService:"FAL1" },
    ],
    rates: [
      { serviceCode:"OF",    description:"Ocean Freight 20DC",               containerType:"20DC", amount:1350, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40DC",               containerType:"40DC", amount:2450, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40HC",               containerType:"40HC", amount:2650, currency:"USD", unit:"per_container" },
      { serviceCode:"BAF",   description:"Bunker Adjustment Factor",         containerType:"",     amount:380,  currency:"USD", unit:"per_container" },
      { serviceCode:"CAF",   description:"Currency Adjustment Factor",       containerType:"",     amount:120,  currency:"USD", unit:"per_container" },
      { serviceCode:"THC-O", description:"THC Origin — Shanghai",            containerType:"",     amount:145,  currency:"USD", unit:"per_container" },
      { serviceCode:"THC-D", description:"THC Destination — Marseille",      containerType:"",     amount:295,  currency:"EUR", unit:"per_container" },
      { serviceCode:"BL",    description:"Bill of Lading Fee",               containerType:"",     amount:70,   currency:"USD", unit:"per_bl"        },
      { serviceCode:"IMO",   description:"DG Handling Surcharge",            containerType:"",     amount:200,  currency:"USD", unit:"per_container" },
    ],
  },
  {
    contractNumber: "CMDU-2026-TAE-002",
    carrierCode: "CMDU",
    namedAccount: "Atlantic Cargo Partners",
    movementType: "FCL",
    containerTypes: ["20DC","40DC","40HC","20OT"],
    dgAllowed: false, imdgClasses: [],
    validFrom: "2026-01-15", validTo: "2026-09-30",
    currency: "USD", status: "Active",
    notes: "Trans-Atlantic East via LA then cross-country. OOG on open-top accepted.",
    legs: [
      { pol:"CNNGB", polName:"Ningbo",       pod:"USLAX", podName:"Los Angeles", transitDays:14, vesselService:"TAE"  },
      { pol:"USLAX", polName:"Los Angeles",  pod:"USNYC", podName:"New York",    transitDays:7,  vesselService:"CCS"  },
    ],
    rates: [
      { serviceCode:"OF",    description:"Ocean Freight 20DC",               containerType:"20DC", amount:1800, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40DC",               containerType:"40DC", amount:3200, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40HC",               containerType:"40HC", amount:3500, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 20OT (OOG)",         containerType:"20OT", amount:2800, currency:"USD", unit:"per_container" },
      { serviceCode:"BAF",   description:"Bunker Adjustment Factor",         containerType:"",     amount:400,  currency:"USD", unit:"per_container" },
      { serviceCode:"AMS",   description:"Advance Manifest Surcharge (US)",  containerType:"",     amount:35,   currency:"USD", unit:"per_bl"        },
      { serviceCode:"THC-O", description:"THC Origin — Ningbo",              containerType:"",     amount:160,  currency:"USD", unit:"per_container" },
      { serviceCode:"THC-D", description:"THC Destination — Los Angeles",    containerType:"",     amount:320,  currency:"USD", unit:"per_container" },
      { serviceCode:"BL",    description:"Bill of Lading Fee",               containerType:"",     amount:75,   currency:"USD", unit:"per_bl"        },
    ],
  },
  // ── MSCU ─────────────────────────────────────────────────────────────────────
  {
    contractNumber: "MSCU-2026-ATL-001",
    carrierCode: "MSCU",
    namedAccount: "North Sea Logistics",
    movementType: "FCL",
    containerTypes: ["20DC","40DC","40HC"],
    dgAllowed: true,
    imdgClasses: ["4.1","8","9"],
    validFrom: "2026-01-01", validTo: "2026-12-31",
    currency: "USD", status: "Active",
    notes: "North Atlantic — Felixstowe to New York SANTANA service. DG 4.1, 8, 9.",
    legs: [
      { pol:"GBFXT", polName:"Felixstowe", pod:"USNYC", podName:"New York", transitDays:9, vesselService:"SANTANA" },
    ],
    rates: [
      { serviceCode:"OF",    description:"Ocean Freight 20DC",               containerType:"20DC", amount:950,  currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40DC",               containerType:"40DC", amount:1800, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40HC",               containerType:"40HC", amount:2000, currency:"USD", unit:"per_container" },
      { serviceCode:"BAF",   description:"Bunker Adjustment Factor",         containerType:"",     amount:280,  currency:"USD", unit:"per_container" },
      { serviceCode:"THC-O", description:"THC Origin — Felixstowe",          containerType:"",     amount:320,  currency:"GBP", unit:"per_container" },
      { serviceCode:"THC-D", description:"THC Destination — New York",       containerType:"",     amount:380,  currency:"USD", unit:"per_container" },
      { serviceCode:"BL",    description:"Bill of Lading Fee",               containerType:"",     amount:55,   currency:"USD", unit:"per_bl"        },
      { serviceCode:"WRS",   description:"War Risk Surcharge",               containerType:"",     amount:45,   currency:"USD", unit:"per_container" },
      { serviceCode:"ISPS",  description:"ISPS Security Charge",             containerType:"",     amount:22,   currency:"USD", unit:"per_container" },
      { serviceCode:"AMS",   description:"Advance Manifest Surcharge",       containerType:"",     amount:35,   currency:"USD", unit:"per_bl"        },
    ],
  },
  {
    contractNumber: "MSCU-2026-MEA-002",
    carrierCode: "MSCU",
    namedAccount: "Arabian Gulf Trading",
    movementType: "FCL",
    containerTypes: ["20DC","40DC","40HC","40RF"],
    dgAllowed: false, imdgClasses: [],
    validFrom: "2026-04-01", validTo: "2026-12-31",
    currency: "USD", status: "Active",
    notes: "Asia–Middle East MEX service via Singapore. Reefer capable.",
    legs: [
      { pol:"CNSHA", polName:"Shanghai",  pod:"SGSIN", podName:"Singapore", transitDays:5, vesselService:"MEX" },
      { pol:"SGSIN", polName:"Singapore", pod:"AEJEA", podName:"Jebel Ali", transitDays:8, vesselService:"MEX" },
    ],
    rates: [
      { serviceCode:"OF",    description:"Ocean Freight 20DC",               containerType:"20DC", amount:600,  currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40DC",               containerType:"40DC", amount:1100, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40HC",               containerType:"40HC", amount:1200, currency:"USD", unit:"per_container" },
      { serviceCode:"OF",    description:"Ocean Freight 40RF",               containerType:"40RF", amount:2800, currency:"USD", unit:"per_container" },
      { serviceCode:"BAF",   description:"Bunker Adjustment Factor",         containerType:"",     amount:200,  currency:"USD", unit:"per_container" },
      { serviceCode:"THC-O", description:"THC Origin — Shanghai",            containerType:"",     amount:130,  currency:"USD", unit:"per_container" },
      { serviceCode:"THC-D", description:"THC Destination — Jebel Ali",     containerType:"",     amount:180,  currency:"AED", unit:"per_container" },
      { serviceCode:"BL",    description:"Bill of Lading Fee",               containerType:"",     amount:50,   currency:"USD", unit:"per_bl"        },
      { serviceCode:"ISPS",  description:"ISPS Security Charge",             containerType:"",     amount:18,   currency:"USD", unit:"per_container" },
    ],
  },
];

async function seed() {
  console.log("Seeding dummy contracts…\n");
  let ok = 0, fail = 0;
  for (const c of contracts) {
    try {
      const r = await post("/contracts", c);
      console.log(`✓  ${r.id}  ${r.contractNumber}  (${r.carrierCode})  ${r.legs.length} leg(s)  ${r.rates.length} rate(s)`);
      ok++;
    } catch (e) {
      console.error(`✗  ${c.contractNumber}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\n${ok} created, ${fail} failed.`);
}

seed();
