# Sample Database

This folder contains a sample SQLite database pre-loaded with test data so you can explore CargoDesk without running the seed script.

## Setup

Copy `cargodesk.db` to the **project root** before starting the app:

```bash
cp sampleDB/cargodesk.db cargodesk.db
```

Then start the app normally:

```bash
npm run dev
```

## What's included

- Shipments, containers, and allocations
- Carriers, vessels, and port locations (14,269 UN/LOCODE entries)
- Commodity codes (294 Maersk freight codes)
- Contracts with legs and rates
- Trade lanes, regions, and countries

## Notes

- The live `cargodesk.db` at the project root is excluded from Git (see `.gitignore`). This sample copy is the only database file tracked in the repository.
- To reset to a clean state, copy this file back to the root again.
- To seed fresh data instead, run `node import-mdm-data.js` after starting the server.
