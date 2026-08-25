# Documentation

Design docs, gap analyses, and diagrams published as Claude artifacts over the course of this
project, archived here as static HTML (plus one `.drawio` export) so they live in the repo
alongside the code they describe. Each file is a snapshot at the time it was pulled in — the
live artifact (where noted) may have since been updated independently.

**Cross-checked against the live codebase on 2026-08-25** — every remaining file was audited
against current code and corrected in place where it had drifted; see each file's own "Status
update" note for what changed and why (code is the reference, not the doc). Two superseded
competitive-assessment docs and one exact duplicate were removed in that pass — see "Removed"
below. Untouched: `invoice-lifecycle.html`/`.drawio` (built directly from this pass, already
current) and `carrier-booking-details-line-agents.html`/mockups, which got a status note rather
than a rewrite since their whole purpose is documenting a past design proposal, not current state.

| File | Original title | Live artifact |
|---|---|---|
| `invoice-lifecycle.html` | Invoice Lifecycle | https://claude.ai/code/artifact/2bc42301-f7a7-46ab-8a2a-4f846b69adba |
| `invoice-lifecycle.drawio` | Invoice Lifecycle (draw.io export) | — |
| `invoice-collections-flow.html` | Invoice Collections Flow | https://claude.ai/code/artifact/b615fe49-40ca-4c61-a85e-d322e6ceca3e |
| `booking-to-bill-of-lading.html` | Booking to Bill of Lading | https://claude.ai/code/artifact/96e1273f-022d-4050-a863-ae43d8515388 |
| `open-items-ledger.html` | Open Items Ledger | https://claude.ai/code/artifact/e8ee6afd-8981-41b4-b0df-18ea8f0b1074 |
| `shipment-lifecycle.html` | Shipment Lifecycle | https://claude.ai/code/artifact/bf0ee980-8764-45a0-a1dd-76f38e9f3186 |
| `credit-control-depth.html` | Credit Control Depth | https://claude.ai/code/artifact/5a5e4758-4b5c-464f-9680-12ad705c5219 |
| `nvocc-readiness.html` | NVOCC Readiness | https://claude.ai/code/artifact/0bc64362-b88a-418e-9c4f-5790316a60c3 |
| `the-missing-manifest.html` | The Missing Manifest | https://claude.ai/code/artifact/ebbed6a9-1084-46f1-8fe0-07d69f95fb89 |
| `coverage-instrument.html` | Coverage Instrument | https://claude.ai/code/artifact/e9a5d596-d57b-47e0-afc1-a4e45ee9c344 |
| `reports-manifest.html` | Reports Manifest | https://claude.ai/code/artifact/b0aa599d-4714-409d-93bb-3f81c33c9157 |
| `master-data-carrier-agents.html` | Master Data — Carrier Agents | https://claude.ai/code/artifact/0f4f31e6-db57-469a-9cfc-da65e505a45f |
| `cargodesk-field-guide.html` | CargoDesk Field Guide | https://claude.ai/code/artifact/8a28bb81-d017-4194-8ec3-f5d7f3836436 |
| `fcl-coverage-audit.html` | FCL Coverage Audit — **the latest broad competitive assessment of CargoDesk** (2026-08-14) | https://claude.ai/code/artifact/3f5f709c-ab3c-4790-af27-e0f5def1f060 |
| `carrier-booking-details-line-agents.html` | Carrier Booking — Details, with Line Agents | https://claude.ai/code/artifact/f840e979-6a1a-4994-bf0a-5e49df566718 |
| `customers-mdm-filtered-view-mockup.html` | Customers MDM — Filtered View Mockup | https://claude.ai/code/artifact/5db7b008-c7fb-48b9-abef-9e426e67c034 |
| `customer-roles-before-after.html` | Customer Roles — Before / After | https://claude.ai/code/artifact/584f5902-0303-40d5-be43-76342e92d8ea |
| `cargodesk-data-hub-migration-plan.html` | CargoDesk — Data Hub Migration Plan | https://claude.ai/code/artifact/f26d2a9f-c9c0-4a07-992d-ccb71e603dc1 |
| `splitting-mdm-first.html` | Splitting MDM First | https://claude.ai/code/artifact/8b08d7a0-bb32-4ae7-bcaa-198bba0412c1 |

## Removed (2026-08-25 pass)

- **`cargodesk-gap-analysis.html`** ("Competitive Gap Analysis & Roadmap", 2026-08-09) — superseded
  by `fcl-coverage-audit.html`, a later, more thorough competitive assessment. Per direct
  instruction, only the single latest broad assessment is kept; the app's real current gap list
  lives in project memory / Kanban, not in a static snapshot.
- **`cargodesk-vs-cargowise-shipment-handling-gap-analysis.html`** (2026-07-27) — the earliest,
  narrowest of the three competitive assessments; superseded by both later ones.
- **`invoice-collections-flow-copy.html`** — a byte-for-byte duplicate of `invoice-collections-flow.html`
  (only the artifact publish timestamp and title differed). No unique content lost.

Not included: artifacts belonging to the separate Athena project (a different repo/app) were
left out of this CargoDesk documentation folder.

Each HTML file is self-contained — open it directly in a browser. The saved copy includes the
artifact platform's own sandboxing/runtime script; this only affects live collaborative features
(comments, capabilities), not the visible content, which renders normally as a static page.
