# CargoDesk — System Test Results
**Version:** v0.26.0 "Meridian II"
**Date:** 2026-07-09
**Executed By:** QA Engineering (Claude Code)
**Server:** http://localhost:3001 (Express + node:sqlite — live run)
**Test Account:** claudeagent@localhost / admin (admin role)

---

## Executive Summary

| Metric | Value |
|---|---|
| Total test cases executed | 50 |
| PASSED | 46 |
| FAILED | 2 |
| SKIPPED | 0 |
| BLOCKED | 2 |
| Bugs found | 1 |
| Existing test suite results | 98/98 passing (3 suites) |

### Bugs Found

| ID | Severity | Title | Component |
|---|---|---|---|
| BUG-001 | **Critical** | Public share/tracking endpoint `GET /api/share/:token` returns 401 (blocked by global auth middleware) | `server.js:1440` |

---

## Existing Test Suite Results

These suites were run as-is using `node tests/*.test.js`.

| Suite | Tests | Passed | Failed | Outcome |
|---|---|---|---|---|
| `tests/shipment-crud.test.js` | 35 | 35 | 0 | ALL PASS |
| `tests/pending-revalidation.test.js` | 19 | 19 | 0 | ALL PASS |
| `tests/schedules.test.js` | 44 | 44 | 0 | ALL PASS |
| **Total** | **98** | **98** | **0** | **ALL PASS** |

---

## TC-001 — Valid Login Returns JWT

**Status:** PASS

**Actual Result:**
- HTTP 200
- Response contained `token` (300-char JWT) and `user` object
- `user.email` = `claudeagent@localhost` confirmed

---

## TC-002 — Invalid Password Returns 401

**Status:** PASS

**Actual Result:**
- HTTP 401 received on wrong password

---

## TC-003 — Non-Existent User Returns 401

**Status:** PASS

**Actual Result:**
- HTTP 401 for `nobody@example.com`

---

## TC-004 — Missing Credentials Returns 400

**Status:** PASS

**Actual Result:**
- HTTP 400 on empty body `{}`

---

## TC-005 — Protected Endpoint Rejected Without Token

**Status:** PASS

**Actual Result:**
- `GET /api/shipments` without Authorization header → HTTP 401

---

## TC-006 — Revoke Sessions Invalidates Old Token

**Status:** PASS

**Actual Result:**
- Login → token1 obtained (300 chars)
- `POST /api/users/USR-TGMEU2/revoke-sessions` → HTTP 200
- `GET /api/auth/me` using token1 → HTTP 401 (token_version mismatch confirmed)
- Re-login successfully obtained new token

**Note:** token_version revocation (v0.24.0 security feature) works correctly.

---

## TC-007 — GET /api/auth/me Returns Current User

**Status:** PASS

**Actual Result:**
- HTTP 200
- `id: USR-TGMEU2`, `email: claudeagent@localhost`

---

## TC-008 — Create Shipment — Valid Payload

**Status:** PASS

**Actual Result:**
- HTTP 201
- `id: SHP-CWCMGQ` (format correct)
- `pol: CNSHA`, `status: Active` confirmed

---

## TC-009 — Create Shipment — Missing Required Fields Returns 400

**Status:** PASS

**Actual Result:**
- HTTP 400 on `{"status":"Active"}` with no pol/pod/carrierCode

---

## TC-010 — Get Shipment By ID

**Status:** PASS

**Actual Result:**
- HTTP 200
- `id` matched requested ID, `pol: CNSHA` confirmed

---

## TC-011 — Get Non-Existent Shipment Returns 404

**Status:** PASS

**Actual Result:**
- HTTP 404 for `SHP-DOESNOTEXIST-999`

---

## TC-012 — Update Shipment Status

**Status:** PASS

**Actual Result:**
- PUT returned HTTP 200, `status: In Transit`
- Subsequent GET confirmed persistence

---

## TC-013 — Update Booking Reference

**Status:** PASS

**Actual Result:**
- PUT returned `bookingRef: BKG-QA-001`

---

## TC-014 — Update Non-Existent Shipment Returns 404

**Status:** PASS

**Actual Result:**
- HTTP 404 for `SHP-DOESNOTEXIST-999`

---

## TC-015 — Delete Shipment

**Status:** PASS

**Actual Result:**
- DELETE → HTTP 200
- GET after DELETE → HTTP 404

---

## TC-016 — Delete Non-Existent Shipment Returns 404

**Status:** PASS

**Actual Result:**
- HTTP 404 for `SHP-DOESNOTEXIST-999`

---

## TC-017 — Shipment Audit Log Contains STATUS_CHANGED Event

**Status:** PASS

**Actual Result:**
- HTTP 200, array of 3 events
- `STATUS_CHANGED` event present: `oldValue: Active`, `newValue: In Transit`
- `shipmentId` on event matches the shipment ID
- All required shape fields present: `id`, `shipmentId`, `eventType`, `field`, `oldValue`, `newValue`, `actor`, `occurredAt`, `meta`
- Events ordered ascending by `occurredAt` confirmed

---

## TC-018 — Add Container to Shipment

**Status:** PASS

**Actual Result:**
- HTTP 201
- `id: CTR-4TU86S`, `size: 40`, `type: GP`

---

## TC-019 — Add Container — Missing Size/Type Returns 400

**Status:** PASS

**Actual Result:**
- HTTP 400 on `{"shipmentId":"..."}` with no size or type

---

## TC-020 — Delete Container

**Status:** PASS

**Actual Result:**
- DELETE → HTTP 200

---

## TC-021 — Create Kanban Ticket

**Status:** PASS

**Actual Result:**
- HTTP 201
- `id: TKT-WBRBMP`, `title: QA Test Ticket`, `priority: High`

---

## TC-022 — Create Ticket — Missing Title Returns 400

**Status:** PASS

**Actual Result:**
- HTTP 400 for missing title

---

## TC-023 — Update Ticket Status (Full Body PUT)

**Status:** PASS

**Actual Result:**
- HTTP 200, `status: In Progress`

---

## TC-024 — Partial Body PUT — Only Position Field (Regression)

**Status:** PASS

**Actual Result:**
- PUT with body `{"position":5}` → HTTP 200
- `position: 5` confirmed
- All other fields preserved from existing record:
  - `title: QA Test Ticket` (not null/empty)
  - `type: Task` (not null/empty)
  - `priority: High` (not null/empty)
  - `status: In Progress` (not null/empty)
- The server correctly defaults omitted fields from the existing DB record

**Verdict:** Partial-body PUT is safe. No regression on this pattern.

---

## TC-025 — Ticket Linking — Create and Retrieve Link

**Status:** PASS

**Actual Result:**
- POST `/api/tickets/TKT-WBRBMP/links` → HTTP 201
- `fromId: TKT-WBRBMP`, `toId: TKT-ZMHQJ0`, `linkType: blocks`
- `id: LNK-YPNV95`
- GET `/api/tickets/TKT-WBRBMP/links` → 1 link with `direction: out`, `displayType: blocks`, `otherTicketId: TKT-ZMHQJ0`

---

## TC-026 — Delete Ticket Link

**Status:** PASS

**Actual Result:**
- DELETE `/api/ticket-links/LNK-YPNV95` → HTTP 200
- GET links after delete → empty array (0 links)

---

## TC-027 — Filter Tickets by ShipmentId

**Status:** PASS

**Actual Result:**
- Linked ticket `TKT-39JSWF` created with `shipmentId: SHP-0GZ9TR`
- GET `?shipmentId=SHP-0GZ9TR` → 1 ticket returned, all with matching shipmentId
- GET `?shipmentId=SHP-DOESNOTEXIST` → empty array

---

## TC-028 — Generate Share Token for Shipment

**Status:** PASS

**Actual Result:**
- HTTP 200
- `has_token: True` (non-empty, 40+ chars)
- `has_url: True`, `url` contains the token
- `has_expiresAt: True` (ISO datetime ~30 days out)

---

## TC-029 — Public Tracking Endpoint — Valid Token

**Status:** FAIL

**Expected:** HTTP 200 with shipment tracking data (no auth required)

**Actual:**
- HTTP 401 — `{"error":"Unauthorized"}`
- No tracking data returned

**Root Cause (BUG-001):** The global auth middleware at `server.js` line 1440 applies to all `/api/*` routes and only exempts `/auth/*` and `/health`. The path `/api/share/:token` is intercepted before the route handler executes, returning 401 despite the route being intentionally public (no `auth()` call in `routes/share.js` for the GET handler).

**Fix Required:** Exempt `/share/` from the global auth middleware:
```js
// server.js line 1440 — current
app.use("/api", (req, res, next) =>
  req.path.startsWith("/auth/") || req.path === "/health" ? next() : auth()(req, res, next)
);

// server.js line 1440 — fix
app.use("/api", (req, res, next) =>
  req.path.startsWith("/auth/") || req.path === "/health" || req.path.startsWith("/share/") ? next() : auth()(req, res, next)
);
```

---

## TC-030 — Public Tracking Endpoint — Tampered Token Returns 400

**Status:** FAIL (cascading failure from BUG-001)

**Expected:** HTTP 400 with message "Invalid or tampered link"

**Actual:**
- HTTP 401 — `{"error":"Unauthorized"}`

**Root Cause:** Same as TC-029 (BUG-001). The global auth middleware intercepts before the share route's HMAC validation logic can run. Once BUG-001 is fixed, this test should return HTTP 400.

---

## TC-031 — Share Token for Non-Existent Shipment Returns 404

**Status:** PASS

**Actual Result:**
- POST `/api/shipments/SHP-DOESNOTEXIST-999/share-token` → HTTP 404
- The POST endpoint uses `auth()` explicitly so it is not affected by BUG-001

---

## TC-032 — Add Manual Cost Line

**Status:** PASS

**Actual Result:**
- HTTP 201
- `id: CL-WORO8G` (format correct)
- `type: BUY`, `chargeCode: OFR`, `amount: 1500`, `source: manual`

---

## TC-033 — Cost Line — Missing Required Fields Returns 400

**Status:** PASS

**Actual Result:**
- HTTP 400 on `{"type":"BUY"}` with no chargeCode or amount

---

## TC-034 — Cost Line — Invalid Type Returns 400

**Status:** PASS

**Actual Result:**
- HTTP 400, `error: type must be BUY or SELL`

---

## TC-035 — List Cost Lines for Shipment

**Status:** PASS

**Actual Result:**
- HTTP 200
- Array of 1 cost line
- All required fields present: `id`, `shipmentId`, `type`, `chargeCode`, `currency`, `amount`, `source`

---

## TC-036 — Finance Endpoint Accessible by Admin

**Status:** PASS

**Actual Result:**
- HTTP 200
- `has_totalBuyUsd: True`, `has_totalSellUsd: True`, `has_grossProfitUsd: True`
- `byCarrier` and `byLane` are arrays

---

## TC-037 — User canViewFinance Flag Can Be Set via PATCH

**Status:** PASS

**Actual Result:**
- POST `/api/users` created operator user (`USR-5U4XCN`) → `{"ok":true}`
- PATCH `/api/users/USR-5U4XCN` with `{"canViewFinance":true}` → HTTP 200
- GET `/api/users` → `canViewFinance: True` confirmed on the user record
- v0.26.0 per-user finance flag works correctly

---

## TC-038 — List Carriers

**Status:** PASS

**Actual Result:**
- HTTP 200
- Array of 69 carriers
- First carrier: `code: AKMR`, `name: Alaska Marine Lines`

---

## TC-039 — List Port Locations (Paginated)

**Status:** PASS

**Note:** Initial test used incorrect endpoint `/api/ports` (404). Correct endpoint is `/api/port-locations`. Test was re-executed with the correct path.

**Actual Result (correct endpoint):**
- `GET /api/port-locations?limit=10&offset=0` → HTTP 200
- `results_count: 10`, `total: 14269`
- `has_unlocode: True`, `has_name: True`

**Test Case Correction Needed:** TC-039 definition in TEST-CASES.md uses `/api/ports` — should be updated to `/api/port-locations`.

---

## TC-040 — Get Trade Lanes with Transit Days

**Status:** PASS

**Actual Result:**
- HTTP 200, array of 14 trade lanes
- `FE transitDays: 28` ✓
- `NAM transitDays: 21` ✓

---

## TC-041 — CSV Export Returns Valid CSV

**Status:** PASS

**Actual Result:**
- HTTP 200
- `Content-Type: text/csv; charset=utf-8`
- Body: 9,842 bytes (non-empty)
- First line: `id,Status,POL,POL Name,POD,POD Name,Carrier,Contract Type,Contract Ref,Trade Lan...` (CSV header confirmed)

---

## TC-042 — XLSX Programmatic Export Returns Binary

**Status:** PASS

**Actual Result:**
- HTTP 200
- `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- Body: 16,910 bytes (well above 5 KB minimum)

---

## TC-043 — Health Endpoint Returns Correct Version

**Status:** PASS

**Actual Result:**
- `status: ok`
- `version: 0.26.0` (matches package.json)
- `counts.ports: 14269` ✓
- `counts.vessels: 349` ✓

---

## TC-044 — Schedules — Save and List Sailing

**Status:** PASS

**Actual Result:**
- POST `/api/shipments/SHP-IEOM98/schedules` → HTTP 201
- `id: SCHED-CG7N62`, `vesselName: EVER GIVEN`, `transitDays: 21`, `isMock: True`
- GET schedules → array of 1 entry confirmed

---

## TC-045 — AI Agent Settings Endpoint

**Status:** PASS

**Actual Result:**
- HTTP 200
- `enabled: False` (ai_agent_enabled app setting is off by default)
- No 500 error; endpoint is stable

---

## TC-046 — Contract Revalidation — Known Ref Returns Active Contract

**Status:** PASS

**Actual Result:**
- HTTP 200
- Array of 1 contract
- `contractNumber: CMDU-CH-EUN-NAM`, `status: Active`, `id` present

---

## TC-047 — Contract Revalidation — Unknown Ref Returns Empty Array

**Status:** PASS

**Actual Result:**
- HTTP 200, `[]` empty array

---

## TC-048 — Milestone Init for Shipment

**Status:** PASS

**Actual Result:**
- POST `milestones/init` → HTTP 201
- 9 milestones created (default FCL template)
- Labels: Booking Confirmed → SI Submitted → Cargo Gated In → Vessel Departed → B/L Issued → Vessel Arrived → Customs Cleared → Cargo Released → Delivered
- All have `label`, `sequenceOrder`, `shipmentId`, `completedAt`, `estimatedDate`

---

## TC-049 — Schedule Search (Mock Data)

**Status:** PASS

**Actual Result:**
- HTTP 200
- 3 sailings returned (mock data since no Maersk API key configured)
- First vessel: `DEMO ALLEGRO`, `transitDays: 16` (numeric confirmed)
- `isMock` field present

---

## TC-050 — Unauthenticated Access to Protected Endpoints

**Status:** PASS

**Actual Result:**
- `GET /api/users` (no token) → HTTP 401 Unauthorized
- `GET /api/shipments` (no token) → HTTP 401 Unauthorized
- `GET /api/tickets` (no token) → HTTP 401 Unauthorized

---

## Bug Report

### BUG-001 — Public Tracking Endpoint Returns 401 (Blocked by Global Auth Middleware)

| Field | Value |
|---|---|
| **ID** | BUG-001 |
| **Severity** | Critical |
| **Priority** | P1 |
| **Component** | `server.js` (global auth middleware, line 1440); `routes/share.js` |
| **Affects** | TC-029, TC-030 |
| **Introduced** | v0.23.0 (when share.js was extracted to a route file) |

**Description:**

`GET /api/share/:token` is the public customer tracking endpoint — it is intentionally designed with no auth requirement (no `auth()` call in `routes/share.js`). However, the global auth middleware at `server.js:1440` applies to all `/api/*` routes:

```js
app.use("/api", (req, res, next) =>
  req.path.startsWith("/auth/") || req.path === "/health" ? next() : auth()(req, res, next)
);
```

The path `/share/:token` is not exempted, so the middleware calls `auth()` which rejects unauthenticated requests with HTTP 401 before the route handler executes.

**Impact:**
- Customers and consignees cannot use the shared tracking link to view shipment status without a CargoDesk account
- `POST /api/shipments/:id/share-token` correctly generates tokens (not affected — requires auth)
- The tracking page feature (`/#track/:token`) is completely non-functional for external users

**Steps to Reproduce:**
1. `POST /api/shipments/:id/share-token` (with auth) → obtain `token`
2. `GET /api/share/:token` (no auth header) → HTTP 401

**Expected:** HTTP 200 with public shipment data

**Actual:** HTTP 401 `{"error":"Unauthorized"}`

**Fix (one-line change at server.js:1440):**
```js
app.use("/api", (req, res, next) =>
  req.path.startsWith("/auth/") || req.path === "/health" || req.path.startsWith("/share/")
    ? next()
    : auth()(req, res, next)
);
```

**Verification after fix:** TC-029 and TC-030 should both pass. TC-029 should return HTTP 200 with shipment tracking JSON. TC-030 should return HTTP 400 with `"Invalid or tampered link"` once the HMAC validation in the route handler can execute.

---

## Test Observations and Notes

### 1. Package.json Missing `"type":"module"` Warning
All three Node test files use ES module syntax (`import http from "node:http"`), but `package.json` lacks `"type": "module"`. Node emits a performance warning on each run. This does not affect test results but adds noise. Recommend adding `"type": "module"` to `package.json`.

### 2. TC-039 Endpoint Name Mismatch
The test case definition in `TEST-CASES.md` uses `/api/ports` (returns 404). The correct endpoint is `/api/port-locations` (as documented in `CLAUDE.md`). The application endpoint is correct; the test case has a typo. Corrected during execution.

### 3. AI Agent Disabled by Default
`GET /api/ai/settings` returns `{"enabled":false}`. The AI chat UI (✦ button) and `POST /api/ai/chat` are gated by the `ai_agent_enabled` app_setting, which defaults to `0`. This is correct behaviour per the v0.26.0 spec.

### 4. Schedule Search Returns Mock Data
`GET /api/schedules/search` returns mock sailing data (`isMock: true`) because no Maersk API key is configured in `app_settings`. This is correct behaviour — the endpoint degrades gracefully to mock data with a visual indicator in the UI.

### 5. Finance Endpoint Has No Role Check
`GET /api/margin/summary` has no explicit `requireRole` guard in `routes/finance.js`. The global auth middleware ensures only authenticated users can access it, but any authenticated role (viewer, operator, admin) can retrieve margin data. The per-user `can_view_finance` flag is only enforced client-side in `App.jsx`. A server-side enforcement check is recommended.

### 6. `savedBy` Field Requires Auth Context
The `savedBy` field on schedule records correctly records the user ID/name of the saving user. This was verified in the schedules test suite (`savedBy is present` assertion passes).

---

## Test Coverage Matrix

| Feature Area | TC IDs | Pass | Fail | Coverage |
|---|---|---|---|---|
| Authentication | TC-001 to TC-007 | 7 | 0 | Full |
| Shipments CRUD | TC-008 to TC-017 | 10 | 0 | Full |
| Containers | TC-018 to TC-020 | 3 | 0 | Full |
| Kanban Tickets | TC-021 to TC-027 | 7 | 0 | Full |
| Share / Tracking | TC-028 to TC-031 | 2 | 2 | Partial (blocked by BUG-001) |
| Cost Lines | TC-032 to TC-035 | 4 | 0 | Full |
| Finance Gating | TC-036 to TC-037 | 2 | 0 | Full |
| MDM Data | TC-038 to TC-040 | 3 | 0 | Full |
| Exports | TC-041 to TC-042 | 2 | 0 | Full |
| System / Health | TC-043 to TC-050 | 6 | 0 | Full |
| **Total** | | **46** | **2** | |

---

## Resolution Log (2026-07-10)

All bugs and observations identified in this report have been resolved. Full Cypress test run on 2026-07-10 shows **74 passing / 1 pending (expected) / 0 failing** across 5 suites.

### BUG-001 — RESOLVED
**Fix:** `server.js:1440` — added `/share/` to auth middleware whitelist:
```js
app.use("/api", (req, res, next) =>
  req.path.startsWith("/auth/") || req.path === "/health" || req.path.startsWith("/share/")
    ? next() : auth()(req, res, next)
);
```
**Also fixed:** `routes/share.js` container query used incorrect column names (`count`, `weight_kg`). Corrected to `size, type, container_number AS containerNumber, gross_weight_kg AS grossWeightKg`.
**TC-029 and TC-030:** Now PASS (sharing.cy.js 13/13 ✅).

### Observation 5 — RESOLVED
**Fix:** `routes/finance.js` — added `auth()` middleware and `canViewFinance` backend check:
```js
app.get("/api/margin/summary", auth(), (req, res) => {
  const u = req.user;
  const roles = Array.isArray(u.roles) ? u.roles : [u.role || 'viewer'];
  if (!roles.includes('admin') && !u.canViewFinance)
    return err(res, "Finance access not enabled for your account", 403);
  // ...
```
**TC-036 updated:** Finance endpoint now correctly requires auth and checks `canViewFinance` per user.

### Additional Bugs Fixed (found during Cypress test implementation)

| Bug | Component | Fix |
|---|---|---|
| Kanban `PUT /api/tickets/:id` crash on partial body (undefined title → SQLite error) | `routes/kanban.js` | Fetch existing record first; use DB values as defaults for all omitted fields |
| Kanban ticket link test mismatch — test called `POST /api/ticket-links` (wrong route) | `cypress/e2e/kanban.cy.js` | Updated test to use `POST /api/tickets/:id/links` with `{ toId, linkType: "Blocks" }` |
| Container list test checked `res.body.containers` on shipment detail (not embedded) | `cypress/e2e/containers.cy.js` | Updated test to use `GET /api/containers?shipmentId=...` |

### Final Cypress Suite Results

| Suite | Tests | Passing | Failing | Pending |
|---|---|---|---|---|
| smoke.cy.js | 20 | 20 | 0 | 0 |
| kanban.cy.js | 15 | 15 | 0 | 0 |
| containers.cy.js | 13 | 12 | 0 | 1 (skipped — no Central contract seeded) |
| users-finance.cy.js | 14 | 14 | 0 | 0 |
| sharing.cy.js | 13 | 13 | 0 | 0 |
| **Total** | **75** | **74** | **0** | **1** |

---

## Test Run — 2026-10-21 (Where to book, Epic TKT-KFGL81)

**Build:** the working tree after Epic TKT-KFGL81 (weekly space, Where to book, the out-of-order
verdict, the steering report), uncommitted. pglite database, the full dev stack, CI's rate limits.

| Layer | Result |
|---|---|
| Backend tests (`npm test` chain, run file by file) | **107/107 files passed** |
| Frontend unit tests (Vitest) | **336/336** in 28 files |
| Browser tests (Cypress, Electron) | **280/280** in 34 specs, none skipped, 10 min 4 s |

**New test files**

| File | Tests | Result |
|---|---|---|
| tests/weekly-space.test.js | 30 | PASS |
| tests/where-to-book.test.js | 23 | PASS |
| tests/steering-verdict.test.js (verdicts + the steering report) | 21 | PASS |
| src/utils/isoWeek.test.js | 8 | PASS |
| src/components/shared/WhereToBook.test.jsx | 10 | PASS |
| src/components/dashboard/SteeringReport.test.jsx | 4 | PASS |
| cypress/e2e/where-to-book.cy.js | 4 | PASS |

Tests extended: `contractConsumption.test.js` (weekly space per week of the range),
`spaceConfigTable.test.js` (the weekly row and its MQC on the period total), and
`SpaceConfigurationsPage.test.jsx` (the Per week choice is saved).

**Cypress, per spec (all passed):** A_login 31 · A_smoke 20 · booking-carrier-answers 3 · booking-escalation 5 · booking-settings-report 2 ·
carrier-agents 2 · carrier-booking-lifecycle 3 · carrier-booking-negative 5 · containers 21 ·
customs-filing-lifecycle 2 · customs-filing-negative 8 · dcsa-demo-carrier 5 · document-generation 2 ·
invoice-reversal 8 · kanban 15 · lane-steering 3 · main-vessel-carrier-changes 5 · pending-revalidation 10 ·
schedule-catalog-search 5 · schedule-generator 8 · schedule-leg-cascade 2 · schedules-happy-path 2 ·
schedules 12 · sharing 13 · shipment-crud 21 · shipment-detail-walkthrough 4 · shipment-edit-delete 4 ·
shipment-form 3 · shipment-reorg 5 · spot-offers 8 · trade-manager-role 11 · transit-suggestion 14 ·
users-finance 14 · where-to-book 4.

**Manual cases:** TC-051 – TC-062 (TEST-CASES.md Area 11), all PASS through the automated tests
named in each.

**Problems found while building and testing**

| # | What happened | Outcome |
|---|---|---|
| 1 | Reading only a customer's own space on their own steering line made an option with no own space uncapped. It also stopped the no-answer switch moving a booking to #2 (booking-carrier-answers.test.js, 6 failures) | Rule refined: a customer's own line uses their own space when they have some on the contract, else the contract's general space. Recorded in the scope doc and ARCHITECTURE.md §8.39 |
| 2 | Sending a reason alone re-judged the verdict against the space available at that moment, so an out-of-order verdict could flip to steered | Fixed: a reason alone updates only the reason (`reasonOnly`) |
| 3 | The per-week explanation on the space configuration form was hidden behind a hover hint | Shown as a visible note |

Leftover data after the runs: no Lane Steering lines and no weekly space configurations (checked
through the API).

### Follow-up, 2026-10-21: the SI Cutoff calendar opened in the wrong place

Reported from the Shipping Instructions page: the SI Cutoff calendar opened at the bottom-right of
the screen instead of under the field. The page's glass cards set `backdrop-filter`, which makes a
card the reference box for `position: fixed`, so the calendar's screen coordinates were applied
from the card's corner. `DatePicker` now renders its calendar on `<body>` (as `ColumnFilter` and
`HsCodeCombobox` already do), and its outside-click check also accepts clicks inside the calendar.

| Check | Result |
|---|---|
| New `src/components/primitives/DatePicker.test.jsx` | **3/3**. Each of the two halves of the fix was removed in turn, and the matching test failed |
| Frontend unit tests (Vitest) | **339/339** in 29 files |
| Real browser, SHP-K0D3U6's Shipping Instructions page | The calendar opens 6px under SI Cutoff, on its left edge; clicking the 15th sets "15 Oct 2026 · 09:00"; a click outside closes it. Nothing was saved |
| Cypress | Not re-run, on a wrong claim that no spec opens a calendar: `lane-steering.cy.js` does (`#ls-to`). See the CI #126 follow-up below |

### Follow-up, 2026-10-21: CI #126 (v0.91.11, 0d4aa12) failed in Cypress

CI's Cypress job exited with code 3: three failures, all in `lane-steering.cy.js`. Reproduced on a
local CI replica (a clean clone, empty database, `npm run seed`, `LOGIN_RATE_MAX=200`).

- **Cause.** The date picker fix above moved the calendar to `<body>`. The spec opened the Lane
  Steering pop-up's Valid To calendar and looked for its buttons inside the field (`#ls-to`), so it
  found nothing. Tests 2 and 3 build on the lane test 1 creates, so they failed with it. The empty
  database played no part. The earlier spec search had matched `#ls-to` and wrongly set it aside.
- **Fix.** The calendar carries `id="<field id>-calendar"`, and the spec finds `#ls-to-calendar` with
  `withinSubject: null`, since the calendar sits outside the pop-up's `within()` scope.
  `DatePicker.test.jsx` checks the id.
- **Search redone properly.** All 44 `<DatePicker>` uses were parsed (multi-line), and every id was
  matched against every spec, along with the calendar's own button texts. Only `lane-steering.cy.js`
  opens a calendar.

### 2026-10-21: House B/L Story 1, the issue rules (Epic TKT-C7EBU3, TKT-E8R1UF)

| Check | Result |
|---|---|
| New `tests/house-bl-issue-rules.test.js` | **25/25**, including two issues racing (one 200, one 409) |
| Related backend files | `house-bl-lifecycle` 23/23, `carrier-booking` 159/159, `document-templates` 16/16, `office-mail` 31/31, `receivables-gross` 29/29, `document-signing` 16/16, `shipment-crud` 35/35, `invoice-reversal` 20/20 |
| Vitest | **339/339** |
| Cypress | `carrier-booking-lifecycle` 3/3, `document-generation` 2/2 |
| Real browser, scratch shipment SHP-EGVHEL | The issued House B/L shows Void and no ✕; Void asks for a reason and leaves it voided |

Found on the way and fixed: any voided document (invoices too) showed a Draft badge, and a type whose only
document was voided counted as a draft. Voided rows now say Voided, and such a type counts as missing.

### 2026-10-21: House B/L high-importance gaps, server side (Epic TKT-C7EBU3)

| Check | Result |
|---|---|
| New `tests/house-bl-record.test.js` | **40/40** (packages, record, readiness, on board vs received, release) |
| New `tests/house-bl-ebl.test.js` | **23/23** (issuance, ISSU/BREQ, endorse, SREQ → SURR/SREJ, AREQ, credential) |
| `house-bl-issue-rules`, `house-bl-lifecycle` (moved onto the ready-shipment helper) | **25/25**, **23/23** |
| Full backend suite, file by file | **110/110 files** |
| Vitest | **339/339** |
| Cypress | `document-generation`, `carrier-booking-lifecycle`, `containers`, `lane-steering`, `shipment-crud`: **50/50** |
| Startup migration on the dev database | 14 House B/L records from the existing BL01s; a restart adds none |

Found on the way and fixed: deleting a BL01 that the carrier booking linked failed with a 500 (foreign key).

### 2026-10-21: House B/L screens (Epic TKT-C7EBU3, from the approved mockup)

| Check | Result |
|---|---|
| New Vitest `HouseBlPanel.test.jsx`, `houseBlPrint.test.js` (+ the package codes mirror in `dcsaCodes.test.js`) | **10/10**, **5/5** |
| Vitest | **355/355** in 31 files |
| New Cypress `house-bl.cy.js` | **3/3** (issue → originals → release; packages fix via Cargo; eBL via Test Tools) |
| Full Cypress suite | **282/283**; the one failure (`spot-offers`, first test) was a burst of HTTP 502s from the Vite proxy, and the spec passed 8/8 on its own straight after |
| Backend: the four House B/L files, `organization`, `multi-entity-accounting`, `customer-statements`, `gl-export`, `document-signing`, `carrier-booking` | all green (25, 23, 40, 23, 64, 29, 73, 33, 16, 159) |
| Real browser (demo shipment SHP-S4NC8S, kept) | ready → issued; the release dialog with its checks and override; the container form's Packages and Kind; the Cargo row "1,200 CT" |

Found in the browser and fixed: moving from one shipment to another by hash kept the panel's "what the B/L says"
choice from the first shipment (SHP-NLWJFQ, not loaded → Received for shipment) on the second. The panel is now keyed
by shipment.

### 2026-10-24: House B/L, the remaining gaps (Epic TKT-C7EBU3, mockup CnuymDL2eUEnxnD8oDtj57)

| Check | Result |
|---|---|
| New `tests/house-bl-series.test.js` (G5 number series, G6 amendments, G21 overdue tasks) | **44/44** |
| New `tests/house-bl-content.test.js` (G11, G12, G14, G16, G17, G18; every DCSA document checked against the spec) | **38/38** |
| Full backend suite, file by file (CI rate-limit settings) | **112/112** files |
| Vitest | **367/367** in 31 files (`HouseBlPanel` 16, `houseBlPrint` 11) |
| Full Cypress suite | **286/286** in 35 specs (`house-bl` 6, `carrier-booking-lifecycle` links an MB01) |
| Build | OK |
| Real browser (demo shipment SHP-LL4EZI, kept: NLRTM → ESALG → USNYC + truck, two selling charges) | ready with the series number; issued 3 originals, 2 copies with charges; the printed BL01 (number, transshipment, on-carriage, charges table); originals log; changed since issue; surrender for amendment → version 2 pending; Conditions "Consignee on the B/L"; container UN number check; office prefix preview |

Found and fixed on the way: the Copies box turned an emptied value into 0 at once, so typing "1" gave 10 (Cypress
caught it); the amending view showed no history and reset originals, copies and charges instead of keeping version
1's; a page holding the shipment from before the number was taken would have saved a blank B/L number over the series
number (a blank now keeps an issued or series number); "changed since issue" flagged the vessels on B/Ls issued before
the vessel role was added (the role is now ignored there).

### 2026-10-27: The DCSA message review (TKT-6SOX30, ARCHITECTURE.md §8.41)

| Check | Result |
|---|---|
| New `tests/dcsa-messages.test.js` (booking body, conditions and booking office; VGM 1.0; Shipping Instructions 3.0, through the built-in carrier) | **39/39** |
| `carrier-integrations` (+ SI notifications: signed but invalid → 400, unknown reference → 404) | **34/34** |
| `booking-escalations` (+ instructions for another carrier naming no contract → 400) | **40/40** |
| Full backend suite, file by file (CI rate-limit settings) | **113/113** files (first pass 109/113, see below) |
| Vitest | **367/367** in 31 files |
| Full Cypress suite | **286/286** in 35 specs |
| Build | OK |

Found and fixed on the way:
- A rebook to another carrier kept the old carrier's contract or quote and would have sent it to the new carrier.
  The first full pass caught three escalation tests that still expected that, and one test shipment
  (`shipment-detail-consistency`) with no contract reference.
- The rebook now drops the old contract and books on the contract the instructions name.
- Instructions for another carrier that name no contract are refused when they are sent. Before, they half-applied
  the rebook: the shipment moved to the new carrier and no booking went out.

### 2026-10-28: DCSA phases 4–6 (Master B/L, VGM declarations, carrier events; ARCHITECTURE.md §8.42)

| Check | Result |
|---|---|
| New `tests/dcsa-documents-events.test.js` (Master B/L draft, compare, approve, issue, surrender, void; SI update and cancel; House B/Ls in the SI; VGM declarations with evidence and VG01; T&T pull and push, corrections, retractions; OVS vessel times; AIS as fallback; the sweeps; milestone template matchers) | **63/63** |
| `dcsa-messages` (consignee identifying code; a draft Master B/L is the carrier's acceptance) | **39/39** |
| `carrier-integrations` (+ the T&T push receiver: signed, `API-Version`, `feedbackElements`) | **37/37** |
| `dcsa-lifecycle` (events pulled as SHIPMENT, TRANSPORT and EQUIPMENT; a re-pull adds nothing) | **33/33** |
| Full backend suite, file by file (CI rate-limit settings) | **114/114** files |
| Vitest | **371/371** in 32 files (new `MasterBlPanel` 4) |
| Full Cypress suite | **290/290** in 36 specs (new `dcsa-documents-events` 4); see below |
| Build | OK |
| Real browser (demo shipment SHP-AQ1FIM, kept) | Shipping Instructions with the carrier's state and the Master B/L card (folded, critical facts, differences on top, all fields, approve); VGM service page with evidence, declarations history, attach and Generate VG01; Milestones with the sea-leg times, the carrier's events and the DCSA tags; Test Tools DCSA Carrier tabs |

The full Cypress run first ended 286/290: `shipment-detail-walkthrough` (the Parties page still loading after 8 s)
and `shipment-edit-delete` (the License Agreement modal over the Edit form, the startup-gate race
`cy.dismissStartupGates` describes). Neither touches the new screens and the server log shows no error; both
specs passed 8/8 on their own straight after.

A read-only review (spec conformance, correctness, data and migrations, tests) ran before the screens were built.
Its findings were fixed, among them: transport-document notifications that carry only the document's reference
(they were answered 404), the notification spellings VOID and SURRENDER_FOR_*, an SI update the carrier hasn't
worked in yet (PENDING_UPDATE) shown as Submitted, events applied out of order (now by `eventUpdatedDateTime`), a
retraction that left its leg time and container event behind, a redraft that kept the old approval, Cargo Released
completed by a release document as well as the B/L, a boot crash when old BL01 rows break the new unique index, and
the VGM history lost when a container was removed.

### 2026-10-29: The remaining DCSA phases (Master B/L amendment, equipment and seals, Arrival Notice, Port Call; ARCHITECTURE.md §8.43)

| Check | Result |
|---|---|
| New `tests/dcsa-amend-equip-arrival.test.js` (the amendment round trip; ISO codes, 45' units, seals with their source, the booking by ISO code with its reefer set point, the SI with no reefer settings; the Arrival Notice pushed and announced, versions, ETA, free time filled and settled, accruals; Port Call berth times) | **53/53** |
| `dcsa-standards` (+ the seal sources against eBL 3.0's Seal.source) | **55/55** |
| `carrier-booking` (the booking's equipment and DG lines now keyed by ISO code: 45G1, 22G1) | **161/161** (first pass 157/161, the old keys) |
| Full backend suite, file by file (CI rate-limit settings, all services up) | **115/115** files |
| Vitest | **378/378** in 33 files (`MasterBlPanel` 7, new `ShipmentArrivalNoticePage` 4) |
| Full Cypress suite | **293/293** in 37 specs (new `dcsa-amend-equip-arrival` 3); see below |
| Build | OK |

The full Cypress run first ended 291/293: `carrier-booking-negative` hit the License Agreement startup-gate race (the
modal covering the page). It touches none of the new screens and passed 5/5 on its own straight after.

Found and fixed on the way:
- The Shipping Instructions sent reefer settings, which SI 3.0 doesn't define, so a reefer with a set temperature
  could never be submitted. They stay on the booking.
- The booking's reefer set points and DG summary had to follow the equipment lines' new key (the ISO code); the
  reefer one would otherwise have dropped every set point.
- A client re-sending a container with its old seal list and a changed `sealNumber` kept the old seal; the changed
  number now replaces the first seal.
- Port Call ids are UUIDs (the spec says so).
- CLAUDE.md had lost the §8.42 routes entries and patterns paragraph (a slip in that day's update): restored with §8.43's.

### 2026-10-29: The House B/L audit's fixes, dangerous goods in the DCSA booking, the shipper's DG emergency contact (ARCHITECTURE.md §8.44)

| Check | Result |
|---|---|
| New `tests/house-bl-audit-fixes.test.js` (originals out and back and what they block; void admin only and its refusals; a live eBL; shipped on board by every container and the local day; the issuer's SCAC; the on-board notation; the shipper's approval and STALE; clauses; House vs Master) | **36/36** |
| `carrier-booking` (DG declared per ISO line, refusals naming what's missing, the shipper's contact with all four fields, a valid Booking 2.0 request) | **168/168** |
| `container-packages` (the customer's DG contact round trip: kept, refused, cleared) | **46/46** |
| `customer-service-toggle` (the same through the customer service, remote mode) | **54/54** |
| Full backend suite, file by file (CI rate-limit settings, all services up) | **116/116** files |
| Vitest | **383/383** in 34 files (new `dgDeclaration` 3; `houseBlPrint` 13) |
| `house-bl.cy.js` with the default export office's SCAC blanked first (as on CI's empty database) | **6/6**; the spec's own setup put the SCAC back |
| Full Cypress suite | **293/293** in 37 specs, first run |
| Build | OK |

Found and fixed on the way:
- The readiness rule for the issuer's SCAC would have failed `house-bl.cy.js` on CI: it passed locally only because a
  backend test had already given the dev database's Rotterdam Branch a SCAC. The spec now provisions a complete legal
  entity itself, like `ensureIssuingEntity`.
- The User Manual said any user could void an issued House B/L, that the first loaded container dates it, and that a
  telex release needs no originals back; corrected to the new rules.
- `customer-hierarchy` failed 2 checks once in a batch run and passed 17/17 on its own straight after and in the full run;
  it doesn't touch the changed code.

Not covered yet: the new controls (originals returned, the on-board notation, House vs Master, the shipper's approval,
clauses, Void disabled with its reason, the customer's DG contact form, App Settings without its Compliance tab) wait for
mockup 12f412e9; until then their rules are tested through the API only.

### 2026-10-29, later: the shipper's DG contact form, the 0.91.12 release audit's fixes (ARCHITECTURE.md §8.44), the release run

| Check | Result |
|---|---|
| New `cypress/e2e/customer-dg-contact.cy.js` (Profile → Dangerous goods: the name-and-phone and phone rules hold Save, all four fields saved, unticking clears; App Settings has no Compliance tab) | **2/2** |
| `house-bl-audit-fixes` (+ R1: no delete of a shipment with an issued House B/L or a live eBL) | **38/38** |
| `dcsa-simulator` (+ R2: the demo carrier's API refuses no token and the wrong one) | **26/26** |
| `dcsa-amend-equip-arrival` (+ R3: a notice reaches only the demo carrier's own booking; R4: a Completed shipment takes no notice and no berth time) | **56/56** |
| `dcsa-messages` (+ R5: the retired VGM Simulator is gone) | **40/40** |
| Full backend suite, file by file (CI rate-limit settings, all services up) | **116/116** files (see below) |
| Vitest | **383/383** in 34 files |
| Full Cypress suite | **295/295** in 38 specs, first run |
| Build | OK |

The backend run first ended 102/116: 14 consecutive files failed with `ECONNRESET` or a 90-second timeout, then every
later file passed. The helper services had been started from a shell that had exited, and those 14 files go through
them. With every service restarted, the 14 passed (customer credit control 83, compliance screening 26, hierarchy 17,
carrier agents 41, classified locations 32, password reset 30, rate limiting 6, contract improvements 39, carrier
mismatch 33, export fields 19, workflow 26, contract routings 55, commodity codes 12, space config lines 30).

Still open: R6 (Test Tools' demo lists aren't filtered by the user's shipment access) and R7 (two unused exports). The
House B/L panel's new controls wait for screens 1–4 of mockup 12f412e9.

### 2026-11-02: The » Advance bar on shipment pages (TKT-ACI6J1, ARCHITECTURE.md §8.45)

| Check | Result |
|---|---|
| New `src/shipmentNavSequence.test.js` (the admin-saved order, a group's rows one by one, cancelled and "Other" services left out, Delivery under Booking & Routing, no Accounting for a trade manager, Review steps, the last row, stale saved orders) | **9/9** |
| New `src/components/shared/ShipmentAdvanceBar.test.jsx` (against the real `api.js` shape: names and opens the next row, the side on a service row, flashes on a failed save check, gone on the last row with its width, the viewer's own tree, a service ordered without a page switch, Alt+→ only when the bar isn't covered) | **7/7** |
| `Modal` (+2: `keepAdvanceBar` lifts the bar over a prerequisite lock only) | **14/14** |
| New `cypress/e2e/shipment-advance-bar.cy.js` (» from the first row visits every sidebar row in order through the Carrier Booking and Customs Filing locks, no bar on the last; a half-filled container form keeps the page with the guard's error; Alt+→, not under a dialog) | **3/3** |
| Real-browser pass on SHP-AQ1FIM (16 rows; layout against header, footer and scroll area; Alt+→; the Request Service dialog; the Cargo save check with nothing saved; the Customs Filing lock; dark and light) | **19/19**, no console errors |
| Vitest | **406/406** in 37 files (includes the AI Assistant's `assistantKnowledge`, 5) |
| Full Cypress suite | **298/298** in 39 specs, after the `lane-steering` fix below (first run 295/298) |
| Build | OK |

Found and fixed on the way:
- **» was trapped on locked pages.** The Carrier Booking and Customs Filing prerequisite locks are dialogs with no
  close button; they covered the bar, so » stopped on them (seen live: Customs Filing on SHP-AQ1FIM; the first browser
  pass only got through because the lock rendered after the click). They now lift the bar above their backdrop
  (`Modal keepAdvanceBar`); every other dialog still covers it.
- **The scroll area's scrollbar sat under the bar** with the mockup's padding approach; the bar's width is a right
  margin on `main#app-scroll-main` instead.
- **`lane-steering.cy.js` failed 3/3 from November**, unrelated to the bar: it clicked › twice from the current month
  and expected December, which only held in October. It now pages forward until December (its fixture is 2026-12-31).
- The first full Cypress run hit the login limiter (429) from spec 6 on: the monolith had been started without CI's
  rate-limit settings. Restarted with them (TEST-PLAN.md §0), the suite ran clean apart from `lane-steering`.

Seen, not caused by this change: one `GET /api/shipments/:id/schedules` answered 502 "API proxy error: socket hang up"
through the Vite dev proxy during the browser pass (a dropped keep-alive connection); the request isn't one the bar
makes, and it didn't recur.
