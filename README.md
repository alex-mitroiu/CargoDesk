# ⚓ CargoDesk

> Freight management application for tracking ocean shipments, carrier space utilisation, and maritime master data.

[![Version](https://img.shields.io/badge/version-0.10.0-blue)](.)
![Node](https://img.shields.io/badge/node-22.5%2B-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Features

- **Shipment Tracking** — Container-level cargo detail with commodity, gross weight, volume, and IMDG dangerous goods classification
- **Space Configurations** — TEU allocation per carrier and route with conflict detection, 6-week trend charts, and a renewal archive
- **Vessel Registry** — 349 IMO vessels searchable by name, IMO number, or asset type
- **Port Directory** — 14,269 UN/LOCODE seaports with linked-port relationships and trade lane assignment
- **Integration Board** — Kanban (Ready / In Progress / Done / Released) for operational task tracking
- **User Manual** — Built-in docs covering Incoterms® 2020 and IMDG dangerous goods classes
- **Light / Dark theme** — Apple-style light theme and CargoDesk dark theme, toggled on the fly

---

## Tech Stack

| Layer    | Technology |
|----------|-----------|
| Frontend | React 18, Vite, custom dark design system |
| Backend  | Node.js 22.5+, Express |
| Database | SQLite via `node:sqlite` (built-in, no ORM) |
| Charts   | Recharts |
| Weather  | Open-Meteo API (free, no key required) |

---

## Getting Started

### Prerequisites

- Node.js 22.5 or later (required for built-in `node:sqlite`)

### Install

```bash
git clone https://github.com/YOUR_USERNAME/CargoDesk.git
cd CargoDesk
npm install
```

### Run

```bash
# Terminal 1 — start the API server (port 3001)
node server.js

# Terminal 2 — seed master data (run once after first server start)
node import-mdm-data.js

# Terminal 3 — start the Vite dev server (port 5173)
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

### Notes

- `cargodesk.db` is created automatically on first `node server.js` run
- Schema changes are applied via safe `ALTER TABLE` migrations — no manual DB intervention needed
- The database file is excluded from version control (see `.gitignore`)
- Weather widget uses [Open-Meteo](https://open-meteo.com/) — no API key required

---

## Project Structure

```
CargoDesk/
├── server.js              # Express API + SQLite schema + migrations
├── import-mdm-data.js     # Seeds ports, carriers, vessels, regions
├── vite.config.js
├── data/
│   ├── seaports.csv       # 14,269 UN/LOCODE records
│   ├── carriers.csv       # 68 carrier records
│   └── vessels.json       # 349 vessels (IMO registry)
└── src/
    ├── api.js             # API client
    ├── tokens.js          # Design tokens, theme system, IMDG classes
    ├── version.js         # Version + changelog
    ├── App.jsx            # Routing, navigation, top-level state
    ├── main.jsx
    ├── components/
    │   ├── primitives/    # Badge, Btn, Form, Modal, Pagination, DatePicker
    │   └── shared/        # PortCombobox, VesselCombobox, IncotermsModal…
    └── pages/
        ├── ShipmentsPage.jsx
        ├── ShipmentDetailPage.jsx
        ├── DashboardPage.jsx
        ├── DashboardArchivePage.jsx
        ├── KanbanPage.jsx
        ├── LandingPage.jsx
        ├── UserManualPage.jsx
        ├── AboutPage.jsx
        └── mdm/           # Carriers, Vessels, Ports, Lanes, Countries…
```

---

## Database Schema

See the built-in **About** page (ℹ in the sidebar) for the full interactive schema reference with column descriptions and migration history.

---

## Changelog

| Version | Summary |
|---------|---------|
| 0.10.0  | Commodities MDM (294 Maersk codes), HS Code + Cargo Description fields, status audit trail with timeline UI, global toast system, URL hash navigation with shipment deep links, light/dark theme, loading spinners, Link Vessel action. |
| 0.9.0 | Container freight fields (commodity, weight, volume, DG/IMDG). Light/dark theme. Footer + About page with schema. |
| 0.8.0 | Space Configs: POL/POD, auto trade-lane badges, conflict detection. Dashboard Archive. |
| 0.7.0 | Space Configs: trade lane, alert threshold, notes. 6-week trend charts + sparklines. |
| 0.6.0 | Contract ID field. DatePicker 3-level nav. Central Contract tooltip. |
| 0.5.0 | MDM Vessels (349 ships). VesselCombobox. Modular refactor (27 files). |
| 0.4.0 | Landing page, weather widget. Space Config POL/POD required. |
| 0.3.0 | Integration Board (Kanban). Dashboard TEU charts. |
| 0.2.0 | MDM: 8 modules, 14,269 ports seeded. Shipment detail + containers. |
| 0.1.0 | Initial build: shipments, containers, Express + SQLite, dark UI. |

---

© 2026 CargoDesk
