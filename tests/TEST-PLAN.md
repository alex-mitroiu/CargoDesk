# CargoDesk — QA Test Plan
**Version:** v0.26.0 "Meridian II"
**Date:** 2026-07-09
**Author:** QA Engineering (Claude Code)
**Server Under Test:** http://localhost:3001 (Express + node:sqlite)
**Frontend Under Test:** http://localhost:5173 (React 18 + Vite)
**Last updated:** 2026-11-02. §0 describes the suite as it is today. §1–§9 are the original v0.26.0
plan, kept for history: it describes node:sqlite and 3 suites, long since replaced.

---

## 0. The test suite today (2026-11-02)

Three layers, all automated. Every feature ships with tests in each layer it touches; the new
behaviour of an epic is described in its ARCHITECTURE.md §8 section, with the test files named there.

| Layer | Where | How many | Run with |
|---|---|---|---|
| Backend API tests | `tests/*.test.js` (plain Node, `fetch` against the running monolith) | 126 files; 116 in the `npm test` chain, the rest in the per-service `test:*-toggle` scripts | `npm test`, or one file: `node tests/<name>.test.js` |
| Microservice tests | `services/*/tests/*.test.js` | per service | `npm run test:contract-service`, `test:mdm-service`, `test:kanban-service`, `test:customer-service`, `test:screening-service`, `test:distribution-service` |
| Frontend unit tests | `src/**/*.test.js(x)` (Vitest + Testing Library) | 37 files, 406 tests | `npm run test:frontend` |
| Browser tests | `cypress/e2e/*.cy.js` | 39 specs, 298 tests | `npx cypress run` (from this VS Code shell: `env -u ELECTRON_RUN_AS_NODE npx cypress run`) |

**How to run a full pass**
1. Start the stack (`npm run dev`), or restart only the monolith. Stop it with
   `POST /internal/dev/shutdown`, never a force-kill: that once corrupted pglite.
2. Start the monolith with CI's rate limits, or the login limiter runs out partway through:
   `LOGIN_RATE_MAX=1000 DOC_ACTION_RATE_MAX=500 EXPORT_RATE_MAX=200 AI_EXTRACT_RATE_MAX=200 AI_CHAT_RATE_MAX=200`.
3. Run the backend files one at a time and read each result. `npm test` is a `&&` chain that stops
   silently at the first failing file, so its final tally can hide every file after it.
4. Run Vitest, then Cypress against :5173.

**Test data rules**
- Every test that creates a shipment provisions its own offices (`ensureOffices()`):
  `tests/helpers/offices.mjs` for backend tests, `cypress/support/offices.js` for Cypress.
- Payloads use realistic, complete shipments: parties, Incoterm, POL/POD, ETD/ETA, commodity and
  real containers.
- Rows that change what other records are offered must be removed after the test: Lane Steering
  lines, space configurations, margin rules and carrier agents. Date them clear of real data
  (the steering tests use 2028).
- A confirmed booking comes only from the carrier. Give the shipment containers, a SEA leg, an ETD
  and a contract number or carrier quote reference (`contractRef`; a DCSA booking names exactly one),
  send the request, then act as the built-in DCSA carrier (`tests/helpers/dcsa-sim.mjs`).
- Shipping Instructions and VGM go to the carrier too (since 2026-10-27): Shipping Instructions need a
  confirmed booking, sealed containers and a legal entity with an email or phone; VGM needs a weight and
  a Method.
- The carrier's Master B/L, Track & Trace events and vessel times (since 2026-10-28) come from the built-in
  carrier too, which persists vessel calls and events between runs: give each run its own voyage numbers,
  as `tests/dcsa-documents-events.test.js` does, or an earlier run's ACTUAL time outranks this run's estimate.
- A House B/L is issued only by a complete legal entity (since 2026-10-29: a SCAC and a street address).
  Provision one for the export office: `ensureIssuingEntity` in `tests/helpers/house-bl.mjs` (called by
  `readyHouseBlShipment`), and its twin in `cypress/e2e/house-bl.cy.js`. Voiding an issued House B/L needs an
  admin and no originals out.
- A dangerous goods booking needs every DG container's UN number, proper shipping name, class and weight, and
  a shipper with its own DG emergency contact (`dgEmergencyContact` on the customer); there is no fallback.
- A shipment holding an issued House B/L can't be deleted (cancel it): such a test leaves its shipment behind.
- The demo carrier's own API (`/dcsa-sim/*`) needs its token: read `accessToken` from
  `GET /api/dcsa-simulator/status` as admin and send it as the Bearer token.

**Latest full run:** 2026-10-29, for v0.91.12 (the DG contact form and the release audit's fixes). Backend 116/116
files, Vitest 383/383, Cypress 295/295 on the first run (see SYSTEM-TEST-RESULTS.md). The manual test cases for Where to
book are Area 11 of TEST-CASES.md; for the DCSA carrier messages, the Master B/L and its amendment, VGM
declarations, carrier events, equipment and seals, and the Arrival Notice Area 12; for the House B/L audit's fixes
and dangerous goods in the booking Area 13; for the » Advance bar on shipment pages Area 14.
**2026-11-02** (the » Advance bar, frontend only): Vitest 406/406 in 37 files, Cypress 298/298 in 39 specs, build OK;
the backend suite was not re-run (no backend change). The Vitest count includes the AI Assistant's
`assistantKnowledge` (5).

---

## 1. Objectives

1. Verify that all critical API endpoints respond with correct HTTP status codes, response shapes, and persisted data.
2. Confirm that authentication, authorisation, and security controls (lockout, token revocation, finance gating) behave as specified.
3. Validate the full lifecycle of the core domain objects: Shipments, Containers, Cost Lines, Kanban Tickets, MDM records, and Share Tokens.
4. Ensure export endpoints return well-formed binary or text outputs.
5. Detect regressions introduced by v0.26.0 changes (AI agent gating, per-user finance flag, data-testid attributes, share/tracking page).

---

## 2. Scope

### In Scope
| Area | Mechanism |
|---|---|
| Authentication | REST API — POST /api/auth/login, GET /api/auth/me, POST /api/auth/logout |
| User management | REST API — GET/POST/PATCH/DELETE /api/users, revoke-sessions |
| Security controls | Login lockout, token revocation via token_version, finance gating |
| Shipments CRUD | REST API — full lifecycle create → read → update → delete |
| Shipment legs | REST API — POST/GET/PUT/DELETE /api/shipments/:id/legs |
| Containers | REST API — POST /api/containers, DELETE /api/containers/:id |
| Cost lines | REST API — GET/POST/PUT/DELETE /api/shipments/:id/cost-lines |
| Share tokens | REST API — POST /api/shipments/:id/share-token, GET /api/share/:token |
| Kanban tickets | REST API — full CRUD + partial PUT body, ticket linking |
| MDM data | REST API — carriers, ports, vessels, contracts, trade lanes |
| Finance endpoint | REST API — GET /api/margin/summary |
| Export endpoints | REST API — CSV, XLSX programmatic, XLSX template |
| AI agent settings | REST API — GET /api/ai/settings |
| System health | REST API — GET /api/health |
| Schedules | REST API — GET/POST/DELETE /api/shipments/:id/schedules |

### Out of Scope
- Browser-level UI interaction (covered separately by Cypress E2E tests in `cypress/e2e/`)
- Third-party API integrations (OFAC SDN sync, FX rates, Maersk schedule API, OpenAI-compatible AI endpoints)
- Performance / load testing
- Mobile responsiveness

### Existing Cypress Test Coverage (Reference Only)
The following Cypress spec files exist and are **not** moved or modified by this test plan:
- `cypress/e2e/A_login.cy.js` — UI login flow
- `cypress/e2e/transit-suggestion.cy.js` — sailing picker modal
- `cypress/e2e/shipment-crud.cy.js` — full UI shipment CRUD
- `cypress/e2e/pending-revalidation.cy.js` — contract revalidation UI
- `cypress/e2e/schedules.cy.js` — schedules UI

These are complementary; this plan focuses on API-level system tests.

---

## 3. Test Approach

### 3.1 Primary Method — API-Level System Tests
All tests in this plan execute direct HTTP calls against the running Express server on port 3001. Tools used:
- **`node tests/*.test.js`** — zero-dependency Node test harness (existing pattern)
- **`curl`** — ad-hoc verification during manual execution
- **PowerShell `Invoke-WebRequest`** — Windows-native fallback

Tests are stateful (they create real DB rows) and clean up after themselves via DELETE calls in finally blocks.

### 3.2 Authentication Strategy
All protected-endpoint tests first obtain a JWT via `POST /api/auth/login` with the admin service account (`claudeagent@localhost` / `admin`). The token is passed as `Authorization: Bearer <token>`.

### 3.3 Test Isolation
- Each test creates its own fixtures (shipments, tickets, users) with unique IDs generated by the server.
- Cleanup (DELETE) runs unconditionally in finally blocks to avoid test pollution.
- Tests do not rely on pre-existing seed data except where noted (contracts revalidation test uses seeded CMDU-CH-EUN-NAM contract).

---

## 4. Feature Areas and Priority

| Priority | Feature Area | Risk | Notes |
|---|---|---|---|
| P1 | Authentication & Security | Critical | Lockout and token_version revocation are v0.24.0 security features |
| P1 | Shipments CRUD | Critical | Core business domain |
| P1 | Containers | Critical | Auto cost-line creation for Central contracts |
| P1 | Share Token / Tracking Page | High | New in v0.23.0; public endpoint with no auth |
| P2 | Cost Lines | High | Finance calculations depend on correct data |
| P2 | Kanban (incl. partial PUT) | High | Partial-body PUT bug class is known risk area |
| P2 | Finance gating | High | New per-user flag in v0.26.0 |
| P2 | Export endpoints | Medium | Binary output harder to assert |
| P3 | MDM data | Medium | Read-heavy, low mutation risk |
| P3 | AI agent settings | Medium | Gated by feature flag |
| P3 | Health / system | Low | Regression catch-all |

---

## 5. Entry and Exit Criteria

### Entry Criteria
- Express server responds 200 to `GET /api/health`
- Admin account `claudeagent@localhost` / `admin` logs in successfully
- Database contains at least one seeded contract (`CMDU-CH-EUN-NAM`) for the revalidation tests

### Exit Criteria
- All P1 tests pass (0 failures)
- P2 failures ≤ 1 (no Critical severity bugs)
- All failures are documented with actual vs expected output and a severity rating

---

## 6. Pass / Fail Criteria

| Result | Definition |
|---|---|
| PASS | HTTP status matches expected AND response body has correct shape AND side-effects (DB persistence) are verified |
| FAIL | Any one of the above conditions is not met |
| SKIP | Server not reachable, or a dependency test failed that would make this test meaningless |
| BLOCKED | External dependency (e.g. OFAC sync) not available in test environment |

---

## 7. Risk Areas and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Token_version revocation race (auth middleware reads DB on every request) | Low | High | Test with a freshly revoked token to confirm 401 |
| Finance gating bypass (canViewFinance not propagated to JWT) | Medium | High | Test with a non-admin user whose flag is off |
| Partial PUT on tickets sending only `position` crashes if server does not default missing fields | Medium | High | Explicitly send PUT with only one field and check no 500 |
| Share token HMAC tampering detected | Low | Medium | Send a deliberately corrupted token and verify 400 |
| Export CSV/XLSX zero-byte file when no shipments match filter | Low | Medium | Verify Content-Type header and non-zero body length |
| AI endpoint leaks settings when ai_agent_enabled=0 | Low | Medium | Check GET /api/ai/settings returns appropriate gated response |

---

## 8. Test Environments

| Item | Value |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| Node | >=22.5.0 (per package.json engines) |
| Backend | Express on http://localhost:3001 |
| Frontend | Vite on http://localhost:5173 (not exercised in this plan) |
| Database | SQLite via node:sqlite (DatabaseSync) |
| DB file | cargodesk.db in project root |

---

## 9. References

- `CLAUDE.md` — full project context, DB schema, key patterns
- `routes/` — all backend route files
- `server.js` — schema, startup migrations, shared helpers
- `src/version.js` — version history and changelog
- Existing test files: `tests/shipment-crud.test.js`, `tests/pending-revalidation.test.js`, `tests/schedules.test.js`
