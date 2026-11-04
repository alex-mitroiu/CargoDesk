# CargoDesk — Test Cases
**Version:** v0.26.0 "Meridian II"
**Date:** 2026-07-09
**Author:** QA Engineering (Claude Code)

Status legend: `PASS` | `FAIL` | `SKIP` | `BLOCKED`

Areas 1–10 are the original v0.26.0 cases (2026-07-09). Area 11 was added on 2026-10-21 for Where to
book (Epic TKT-KFGL81), Area 12 on 2026-10-27 for the DCSA message review, and Area 13 on 2026-10-29 for the House
B/L audit's fixes and dangerous goods in the booking. Every case in them is
automated, and the automated test is named in each case.
Features built between those dates are covered by the automated suites only (TEST-PLAN.md §0).

---

## Area 1 — Authentication & Security

### TC-001: Valid Login Returns JWT
**Feature:** Authentication — POST /api/auth/login
**Precondition:** Server running; user `claudeagent@localhost` exists with password `admin`
**Steps:**
1. POST /api/auth/login with `{"email":"claudeagent@localhost","password":"admin"}`
2. Inspect response body

**Expected Result:**
- HTTP 200
- Body contains `token` (non-empty string) and `user` object with `id`, `email`, `name`
- `user.email` equals `claudeagent@localhost`

**Status:** TBD

---

### TC-002: Invalid Password Returns 401
**Feature:** Authentication — login failure
**Precondition:** Server running
**Steps:**
1. POST /api/auth/login with `{"email":"claudeagent@localhost","password":"wrongpassword"}`

**Expected Result:**
- HTTP 401
- Body contains an `error` or `message` field
- No `token` in response

**Status:** TBD

---

### TC-003: Non-Existent User Returns 401
**Feature:** Authentication — unknown email
**Precondition:** Server running
**Steps:**
1. POST /api/auth/login with `{"email":"nobody@example.com","password":"anything"}`

**Expected Result:**
- HTTP 401
- Body contains an error message

**Status:** TBD

---

### TC-004: Missing Credentials Returns 400
**Feature:** Authentication — input validation
**Precondition:** Server running
**Steps:**
1. POST /api/auth/login with `{}` (empty body)

**Expected Result:**
- HTTP 400 (or 4xx)
- Error message indicating email and password are required

**Status:** TBD

---

### TC-005: Protected Endpoint Rejected Without Token
**Feature:** Authentication — auth middleware
**Precondition:** Server running
**Steps:**
1. GET /api/shipments without any Authorization header

**Expected Result:**
- HTTP 401
- Body contains an error about missing/invalid token

**Status:** TBD

---

### TC-006: Revoke Sessions Invalidates Old Token
**Feature:** Security — token_version revocation (v0.24.0)
**Precondition:** Logged in as admin; target user `claudeagent@localhost` exists
**Steps:**
1. POST /api/auth/login → obtain `token1`
2. POST /api/users/:id/revoke-sessions for the claudeagent user (using admin token)
3. GET /api/auth/me using `token1`

**Expected Result:**
- Steps 1–2: HTTP 200 on login and 200 on revoke
- Step 3: HTTP 401 (token_version mismatch)

**Status:** TBD

---

### TC-007: GET /api/auth/me Returns Current User
**Feature:** Authentication — identity
**Precondition:** Valid JWT obtained from login
**Steps:**
1. GET /api/auth/me with valid `Authorization: Bearer <token>`

**Expected Result:**
- HTTP 200
- Body contains `id`, `email`, `name`, `role`
- Matches the logged-in user's data

**Status:** TBD

---

## Area 2 — Shipments CRUD

### TC-008: Create Shipment — Valid Payload
**Feature:** Shipments — POST /api/shipments
**Precondition:** Valid JWT; POL `CNSHA` and POD `USNYC` are valid UNLOCODE ports
**Steps:**
1. POST /api/shipments with `{"pol":"CNSHA","pod":"USNYC","carrierCode":"CMDU","status":"Active","contractType":"SPOT","etd":"2026-09-01"}`

**Expected Result:**
- HTTP 201
- Body contains `id` (format `SHP-XXXXXX`), `pol`, `pod`, `carrierCode`, `status`, `contractType`
- Values match the submitted payload

**Status:** TBD

---

### TC-009: Create Shipment — Missing Required Fields Returns 400
**Feature:** Shipments — input validation
**Precondition:** Valid JWT
**Steps:**
1. POST /api/shipments with `{"status":"Active"}` (no pol, pod, carrierCode)

**Expected Result:**
- HTTP 400
- Error message indicating which required fields are missing

**Status:** TBD

---

### TC-010: Get Shipment By ID
**Feature:** Shipments — GET /api/shipments/:id
**Precondition:** A shipment exists (created in TC-008 or pre-seeded); valid JWT
**Steps:**
1. GET /api/shipments/:id for a known shipment ID

**Expected Result:**
- HTTP 200
- Body contains `id` matching the requested ID
- `pol`, `pod`, `carrierCode`, `status` match created values

**Status:** TBD

---

### TC-011: Get Non-Existent Shipment Returns 404
**Feature:** Shipments — not found handling
**Precondition:** Valid JWT
**Steps:**
1. GET /api/shipments/SHP-DOESNOTEXIST-999

**Expected Result:**
- HTTP 404

**Status:** TBD

---

### TC-012: Update Shipment Status
**Feature:** Shipments — PUT /api/shipments/:id
**Precondition:** A shipment exists with status `Active`; valid JWT
**Steps:**
1. GET /api/shipments/:id to retrieve current body
2. PUT /api/shipments/:id with body from step 1, overriding `status` to `In Transit`
3. GET /api/shipments/:id to verify persistence

**Expected Result:**
- Step 2: HTTP 200, `status` = `"In Transit"` in response
- Step 3: `status` = `"In Transit"` confirms DB persistence

**Status:** TBD

---

### TC-013: Update Booking Reference
**Feature:** Shipments — field update
**Precondition:** A shipment exists; valid JWT
**Steps:**
1. GET /api/shipments/:id
2. PUT /api/shipments/:id with `bookingRef: "BKG-QA-001"` added to the body

**Expected Result:**
- HTTP 200
- `bookingRef` = `"BKG-QA-001"` in response

**Status:** TBD

---

### TC-014: Update Non-Existent Shipment Returns 404
**Feature:** Shipments — not found on PUT
**Precondition:** Valid JWT
**Steps:**
1. PUT /api/shipments/SHP-DOESNOTEXIST-999 with a valid body payload

**Expected Result:**
- HTTP 404

**Status:** TBD

---

### TC-015: Delete Shipment
**Feature:** Shipments — DELETE /api/shipments/:id
**Precondition:** A shipment exists; valid JWT
**Steps:**
1. DELETE /api/shipments/:id
2. GET /api/shipments/:id to confirm deletion

**Expected Result:**
- Step 1: HTTP 200
- Step 2: HTTP 404 (shipment no longer exists)

**Status:** TBD

---

### TC-016: Delete Non-Existent Shipment Returns 404
**Feature:** Shipments — not found on DELETE
**Precondition:** Valid JWT
**Steps:**
1. DELETE /api/shipments/SHP-DOESNOTEXIST-999

**Expected Result:**
- HTTP 404

**Status:** TBD

---

### TC-017: Shipment Audit Log Contains STATUS_CHANGED Event
**Feature:** Shipments — GET /api/shipments/:id/events
**Precondition:** A shipment was created and its status changed; valid JWT
**Steps:**
1. Create shipment (status: `Active`)
2. PUT shipment to change status to `In Transit`
3. GET /api/shipments/:id/events

**Expected Result:**
- HTTP 200
- Response is an array
- At least one event with `eventType = "STATUS_CHANGED"`, `oldValue = "Active"`, `newValue = "In Transit"`
- Events ordered ascending by `occurredAt`
- Each event has fields: `id`, `shipmentId`, `eventType`, `field`, `oldValue`, `newValue`, `actor`, `occurredAt`, `meta`

**Status:** TBD

---

## Area 3 — Containers

### TC-018: Add Container to Shipment
**Feature:** Containers — POST /api/containers
**Precondition:** A shipment exists; valid JWT
**Steps:**
1. POST /api/containers with `{"shipmentId":"<id>","size":"40","type":"GP","containerNumber":"CMDU1234567","cargoDescription":"QA test cargo"}`

**Expected Result:**
- HTTP 201
- Body contains `id`, `shipmentId`, `size = "40"`, `type = "GP"`

**Status:** TBD

---

### TC-019: Add Container — Missing Size/Type Returns 400
**Feature:** Containers — input validation
**Precondition:** Valid JWT; a shipment exists
**Steps:**
1. POST /api/containers with `{"shipmentId":"<id>"}` (no size or type)

**Expected Result:**
- HTTP 400

**Status:** TBD

---

### TC-020: Delete Container
**Feature:** Containers — DELETE /api/containers/:id
**Precondition:** A container exists; valid JWT
**Steps:**
1. Create a container
2. DELETE /api/containers/:containerId

**Expected Result:**
- HTTP 200
- The container no longer appears on the shipment

**Status:** TBD

---

## Area 4 — Kanban Tickets

### TC-021: Create Kanban Ticket
**Feature:** Kanban — POST /api/tickets
**Precondition:** Valid JWT
**Steps:**
1. POST /api/tickets with `{"title":"QA Test Ticket","type":"Task","priority":"High","status":"Ready"}`

**Expected Result:**
- HTTP 201
- Body contains `id` (format `TKT-XXXXXX`), `title`, `type`, `priority`, `status`

**Status:** TBD

---

### TC-022: Create Ticket — Missing Title Returns 400
**Feature:** Kanban — input validation
**Precondition:** Valid JWT
**Steps:**
1. POST /api/tickets with `{"type":"Task","priority":"Medium"}` (no title)

**Expected Result:**
- HTTP 400
- Error message about `title` being required

**Status:** TBD

---

### TC-023: Update Ticket Status (Full Body PUT)
**Feature:** Kanban — PUT /api/tickets/:id
**Precondition:** A ticket exists; valid JWT
**Steps:**
1. GET /api/tickets to find a ticket ID (or create one)
2. PUT /api/tickets/:id with full body, `status` changed to `In Progress`

**Expected Result:**
- HTTP 200
- `status = "In Progress"` in response

**Status:** TBD

---

### TC-024: Partial Body PUT — Only Position Field (Regression)
**Feature:** Kanban — partial PUT body should not crash server
**Precondition:** A ticket exists; valid JWT
**Risk:** Without server-side defaulting from existing record, missing fields could write NULL or crash
**Steps:**
1. Create a ticket
2. PUT /api/tickets/:id with body `{"position": 5}` (no other fields)

**Expected Result:**
- HTTP 200 (server should default all omitted fields from the existing record)
- `position = 5` in response
- `title`, `type`, `priority`, `status` are preserved (not null or empty)

**Status:** TBD

---

### TC-025: Ticket Linking — Create and Retrieve Link
**Feature:** Kanban — POST /api/tickets/:id/links, GET /api/tickets/:id/links
**Precondition:** Two tickets exist; valid JWT
**Steps:**
1. Create ticket A
2. Create ticket B
3. POST /api/tickets/A/links with `{"toId":"<B>","linkType":"blocks"}`
4. GET /api/tickets/A/links

**Expected Result:**
- Step 3: HTTP 201, body has `fromId = A`, `toId = B`, `linkType = "blocks"`
- Step 4: HTTP 200, array includes the created link with `direction = "out"` and `displayType = "blocks"`

**Status:** TBD

---

### TC-026: Delete Ticket Link
**Feature:** Kanban — DELETE /api/ticket-links/:id
**Precondition:** A ticket link exists; valid JWT
**Steps:**
1. Create two tickets and a link between them (from TC-025)
2. DELETE /api/ticket-links/:linkId

**Expected Result:**
- HTTP 200
- `deleted` field in response equals the link ID
- GET /api/tickets/A/links returns an empty array

**Status:** TBD

---

### TC-027: Filter Tickets by ShipmentId
**Feature:** Kanban — GET /api/tickets?shipmentId=
**Precondition:** A shipment and a linked ticket exist; valid JWT
**Steps:**
1. Create a shipment
2. Create a ticket with `shipmentId` set to the shipment ID
3. GET /api/tickets?shipmentId=<shipmentId>

**Expected Result:**
- HTTP 200
- Returns exactly the linked ticket(s); no other tickets in the response
- Each ticket in the response has `shipmentId` matching the filter

**Status:** TBD

---

## Area 5 — Share Tokens / Tracking Page

### TC-028: Generate Share Token for Shipment
**Feature:** Share — POST /api/shipments/:id/share-token
**Precondition:** A shipment exists; valid JWT
**Steps:**
1. POST /api/shipments/:id/share-token

**Expected Result:**
- HTTP 200
- Body contains `token` (non-empty string), `url`, `expiresAt` (ISO date string ~30 days in future)
- `url` contains the token

**Status:** TBD

---

### TC-029: Public Tracking Endpoint — Valid Token
**Feature:** Share — GET /api/share/:token (no auth required)
**Precondition:** A valid share token has been generated (TC-028)
**Steps:**
1. GET /api/share/:token (no Authorization header)

**Expected Result:**
- HTTP 200
- Body contains: `id`, `status`, `pol`, `pod`, `carrierCode`, `vessel`, `voyage`, `etd`, `eta`, `legs` (array), `containers` (array), `milestones` (array), `expiresAt`
- Sensitive financial data (cost lines, margin) is NOT present

**Status:** TBD

---

### TC-030: Public Tracking Endpoint — Tampered Token Returns 400
**Feature:** Share — HMAC signature verification
**Precondition:** Server running (no auth needed)
**Steps:**
1. GET /api/share/invalid.tamperedtoken

**Expected Result:**
- HTTP 400
- Error message: "Invalid or tampered link"

**Status:** TBD

---

### TC-031: Share Token for Non-Existent Shipment Returns 404
**Feature:** Share — shipment existence check
**Precondition:** Valid JWT
**Steps:**
1. POST /api/shipments/SHP-DOESNOTEXIST-999/share-token

**Expected Result:**
- HTTP 404
- Error message about shipment not found

**Status:** TBD

---

## Area 6 — Cost Lines

### TC-032: Add Manual Cost Line
**Feature:** Cost Lines — POST /api/shipments/:id/cost-lines
**Precondition:** A shipment exists; valid JWT
**Steps:**
1. POST /api/shipments/:id/cost-lines with `{"type":"BUY","chargeCode":"OFR","currency":"USD","amount":1500}`

**Expected Result:**
- HTTP 201
- Body contains `id` (format `CL-XXXXXX`), `type = "BUY"`, `chargeCode = "OFR"`, `amount = 1500`, `source = "manual"`

**Status:** TBD

---

### TC-033: Cost Line — Missing Required Fields Returns 400
**Feature:** Cost Lines — input validation
**Precondition:** A shipment exists; valid JWT
**Steps:**
1. POST /api/shipments/:id/cost-lines with `{"type":"BUY"}` (no chargeCode or amount)

**Expected Result:**
- HTTP 400
- Error message about required fields

**Status:** TBD

---

### TC-034: Cost Line — Invalid Type Returns 400
**Feature:** Cost Lines — type validation
**Precondition:** A shipment exists; valid JWT
**Steps:**
1. POST /api/shipments/:id/cost-lines with `{"type":"INVALID","chargeCode":"OFR","amount":100}`

**Expected Result:**
- HTTP 400
- Error message: "type must be BUY or SELL"

**Status:** TBD

---

### TC-035: List Cost Lines for Shipment
**Feature:** Cost Lines — GET /api/shipments/:id/cost-lines
**Precondition:** A shipment with at least one cost line exists; valid JWT
**Steps:**
1. POST a cost line to a shipment
2. GET /api/shipments/:id/cost-lines

**Expected Result:**
- HTTP 200
- Response is an array containing the created cost line
- Each cost line has: `id`, `shipmentId`, `type`, `chargeCode`, `currency`, `amount`, `source`

**Status:** TBD

---

## Area 7 — Finance Gating (v0.26.0)

### TC-036: Finance Endpoint Accessible by Admin
**Feature:** Finance gating — GET /api/margin/summary
**Precondition:** Logged in as admin user
**Steps:**
1. GET /api/margin/summary with admin JWT

**Expected Result:**
- HTTP 200
- Body contains `totalBuyUsd`, `totalSellUsd`, `grossProfitUsd`, `grossMarginPct`
- `byCarrier` and `byLane` arrays present

**Status:** TBD

---

### TC-037: User canViewFinance Flag Can Be Set via PATCH
**Feature:** Finance gating — PATCH /api/users/:id canViewFinance
**Precondition:** Admin JWT; a non-admin user exists
**Steps:**
1. POST /api/users to create a new operator user
2. PATCH /api/users/:id with `{"canViewFinance":true}`
3. GET /api/users to verify the flag

**Expected Result:**
- Step 2: HTTP 200, `{ ok: true }`
- Step 3: The user record shows `canViewFinance: true`

**Status:** TBD

---

## Area 8 — MDM Data

### TC-038: List Carriers
**Feature:** MDM — GET /api/carriers
**Precondition:** DB seeded with carrier data; valid JWT
**Steps:**
1. GET /api/carriers

**Expected Result:**
- HTTP 200
- Response is an array (or paginated object)
- At least one carrier with `code` and `name` fields

**Status:** TBD

---

### TC-039: List Port Locations (Paginated)
**Feature:** MDM — GET /api/ports
**Precondition:** DB seeded with 14,269 ports; valid JWT
**Steps:**
1. GET /api/ports?limit=10&offset=0

**Expected Result:**
- HTTP 200
- Response has `results` array (≤ 10 items), `total` (≥ 14269), `limit`, `offset`
- Each port has `unlocode`, `name`, `countryCode` fields

**Status:** TBD

---

### TC-040: Get Trade Lanes with Transit Days
**Feature:** MDM — GET /api/trade-lanes
**Precondition:** DB seeded; valid JWT
**Steps:**
1. GET /api/trade-lanes

**Expected Result:**
- HTTP 200
- Response is an array of trade lane objects
- Each lane has `code`, `name`, `transitDays` (non-zero for seeded lanes)
- Lane `FE` has `transitDays = 28`, `NAM` has `transitDays = 21`

**Status:** TBD

---

## Area 9 — Exports

### TC-041: CSV Export Returns Valid CSV
**Feature:** Export — GET /api/export/shipments.csv
**Precondition:** At least one shipment exists; valid JWT
**Steps:**
1. GET /api/export/shipments.csv

**Expected Result:**
- HTTP 200
- Content-Type contains `text/csv`
- Response body begins with a CSV header row
- Body is non-empty

**Status:** TBD

---

### TC-042: XLSX Programmatic Export Returns Binary
**Feature:** Export — GET /api/export/dashboard/xlsx
**Precondition:** Valid JWT
**Steps:**
1. GET /api/export/dashboard/xlsx

**Expected Result:**
- HTTP 200
- Content-Type is `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- Response body is non-empty (binary XLSX data; minimum ~5 KB)

**Status:** TBD

---

## Area 10 — System / Health

### TC-043: Health Endpoint Returns Correct Version
**Feature:** System — GET /api/health
**Precondition:** Server running
**Steps:**
1. GET /api/health (no auth required)

**Expected Result:**
- HTTP 200
- Body has `status = "ok"`
- `version` matches package.json version (`"0.26.0"`)
- `counts.ports` ≥ 14269
- `counts.vessels` ≥ 349

**Status:** TBD

---

### TC-044: Schedules — Save and List Sailing
**Feature:** Schedules — POST/GET /api/shipments/:id/schedules
**Precondition:** A shipment exists; valid JWT
**Steps:**
1. POST /api/shipments/:id/schedules with `{"carrier":"MAEU","vesselName":"EVER GIVEN","voyageNumber":"001W","pol":"CNSHA","pod":"USNYC","etd":"2026-09-05","eta":"2026-09-26","transitDays":21,"isMock":true}`
2. GET /api/shipments/:id/schedules

**Expected Result:**
- Step 1: HTTP 201, body has `id`, `vesselName = "EVER GIVEN"`, `transitDays = 21`, `isMock = true`
- Step 2: HTTP 200, array contains the saved sailing

**Status:** TBD

---

### TC-045: AI Agent Settings Endpoint
**Feature:** AI — GET /api/ai/settings
**Precondition:** Valid JWT
**Steps:**
1. GET /api/ai/settings

**Expected Result:**
- HTTP 200 or appropriate gated response
- Body contains `enabled` (boolean) reflecting the `ai_agent_enabled` app setting
- No crash or 500 error

**Status:** TBD

---

### TC-046: Contract Revalidation — Known Ref Returns Active Contract
**Feature:** Contracts — GET /api/contracts/revalidate
**Precondition:** DB seeded with `CMDU-CH-EUN-NAM` contract; valid JWT
**Steps:**
1. GET /api/contracts/revalidate?ref=CMDU-CH-EUN-NAM

**Expected Result:**
- HTTP 200
- Response is a non-empty array
- First element has `contractNumber = "CMDU-CH-EUN-NAM"`, `status = "Active"`, and `id` field

**Status:** TBD

---

### TC-047: Contract Revalidation — Unknown Ref Returns Empty Array
**Feature:** Contracts — GET /api/contracts/revalidate
**Precondition:** Valid JWT
**Steps:**
1. GET /api/contracts/revalidate?ref=NOSUCHCONTRACT-99999

**Expected Result:**
- HTTP 200
- Response is an empty array `[]`

**Status:** TBD

---

### TC-048: Milestone Init for Shipment
**Feature:** Milestones — POST /api/shipments/:id/milestones/init
**Precondition:** A shipment exists; valid JWT; milestone templates seeded
**Steps:**
1. POST /api/shipments/:id/milestones/init
2. GET /api/shipments/:id/milestones

**Expected Result:**
- Step 1: HTTP 200 or 201; body indicates number of milestones created
- Step 2: HTTP 200; array of milestone objects with `label`, `sequenceOrder`, `completedAt`, `estimatedDate`

**Status:** TBD

---

### TC-049: Schedule Search (Mock Data)
**Feature:** Schedules — GET /api/schedules/search
**Precondition:** Valid JWT
**Steps:**
1. GET /api/schedules/search?pol=CNSHA&pod=DEHAM&carrierCode=MAEU&weeks=2

**Expected Result:**
- HTTP 200
- Body has `sailings` (non-empty array)
- Each sailing has `vesselName`, `etd`, `transitDays` (number)
- `isMock` boolean is present

**Status:** TBD

---

### TC-050: Unauthenticated Access to Protected Endpoint
**Feature:** Auth middleware — blanket protection
**Precondition:** Server running
**Steps:**
1. GET /api/users (no token)
2. GET /api/shipments (no token)
3. GET /api/tickets (no token)

**Expected Result:**
- All three requests return HTTP 401
- Bodies contain an error about authentication

**Status:** TBD

---

## Area 11 — Where to Book & Weekly Space (2026-10-21, Epic TKT-KFGL81)

Shared setup: contracts on NLRTM → USNYC (EU-N → NAM) for a scratch customer, space configurations
on them, and a Lane Steering line for everyone. Dates in 2028 keep the cases clear of real data;
remove the line and the configurations afterwards. ARCHITECTURE.md §8.39.

### TC-051: A weekly space configuration is held per ISO week
**Feature:** Weekly space — POST /api/allocations `spaceBasis: "week"`
**Precondition:** A contract with one routing line
**Steps:**
1. POST /api/allocations with `allocatedTEU: 4`, `spaceBasis: "week"`, 2 Nov – 29 Nov 2026
2. POST the same with `spaceBasis: "month"`, then with `minimumTEU: 17`

**Expected Result:**
- 201 with `spaceBasis: "week"` and `weeks` for ISO weeks 45–48
- `month` is refused (400). A minimum above 4 TEU × 4 weeks = 16 is refused (400)

**Status:** PASS (2026-10-21, automated: tests/weekly-space.test.js)

---

### TC-052: Weekly space counts each shipment in its ETD's week
**Feature:** Weekly space — GET /api/allocations?date=, GET /api/allocations/match
**Precondition:** TC-051's configuration; shipments A and B (ETD week 45), C (week 46), D (no ETD, cargo-ready date in week 47), one 40' HC each
**Steps:**
1. GET /api/allocations?date=2026-11-04
2. GET /api/allocations/match with etd 2026-11-12

**Expected Result:**
- Week 45 shows 4 TEU pending of 4. `weeks` reads 45 → 4, 46 → 2, 47 → 2 (D, by its cargo-ready date), 48 → 0
- `/match` for 12 Nov shows week 46 with 2 TEU pending

**Status:** PASS (2026-10-21, automated: tests/weekly-space.test.js)

---

### TC-053: The space badge compares a shipment only with its week; a roll moves it
**Feature:** Weekly space — shipments.space_badge
**Steps:**
1. Add a fifth shipment E in week 45, so week 45 holds 6 TEU of 4
2. PUT E's ETD to 25 Nov (week 48)

**Expected Result:**
- Step 1: A, B and E are Space Exceeded; C (week 46) is not
- Step 2: no shipment is Space Exceeded

**Status:** PASS (2026-10-21, automated: tests/weekly-space.test.js)

---

### TC-054: Where to book walks the steering line in order
**Feature:** GET /api/where-to-book
**Precondition:** The line for everyone has these options: #1 MSCU (named account of another customer), #2 MAEU (4 TEU a week), #3 HLCU (loop AL1, 10 TEU), #4 CMDU (no space configured)
**Steps:**
1. GET /api/where-to-book?pol=NLRTM&pod=USNYC&etd=2028-03-08&teu=2&customerId=<shipper>
2. Repeat with teu=6, then with loopCode=AL5

**Expected Result:**
- #1 is skipped (named account). #2 is available with 4 TEU free in week 10 and is the pick. #4 is order only (no cap)
- teu=6: the pick is still #2, as an overbooking
- AL5: #3 is skipped, with "space for loop AL1 only"

**Status:** PASS (2026-10-21, automated: tests/where-to-book.test.js)

---

### TC-055: A full week moves the pick down; the next week is new
**Feature:** GET /api/where-to-book
**Steps:**
1. Book 2 × 40' HC on #2's weekly space in week 10
2. Ask again for 8 March, then for 15 March (week 11)

**Expected Result:**
- Week 10: #2 is full and the pick is #3
- Week 11: #2 is the pick again, with 4 TEU free

**Status:** PASS (2026-10-21, automated: tests/where-to-book.test.js)

---

### TC-056: A customer's own line wins, and their own space is theirs only
**Feature:** GET /api/where-to-book — customer lines
**Steps:**
1. Add a line for the shipper alone: #1 MAEU
2. Ask for the shipper, before and after the shipper gets 3 TEU a week of their own on MAEU
3. Ask for another customer

**Expected Result:**
- The shipper's line is used. Before their own space exists, MAEU's general space applies; it is full, so #1 is the pick as an overbooking
- With their own space, only that space counts: 4 TEU stays on it as an overbooking, never spilling into the general space
- The other customer gets the line for everyone, and never the shipper's space

**Status:** PASS (2026-10-21, automated: tests/where-to-book.test.js)

---

### TC-057: The contract picker shows Where to book with the pick pre-selected
**Feature:** UI — Schedules → Change Contract
**Precondition:** A line with #1 MAEU (4 TEU a week) and #2 HLCU (no space); a Central shipment sailing today with one 40' HC
**Steps:**
1. Open the shipment's Contracts & Schedules page and click Change Contract

**Expected Result:**
- The Where to book panel lists #1 MAEU as THE PICK (4 of 4 TEU free) and #2 HLCU as available, order only, with its note
- #1 is already selected and waits for Confirm Selection

**Status:** PASS (2026-10-21, automated: cypress/e2e/where-to-book.cy.js)

---

### TC-058: Booking a lower option asks why, and the shipment says so
**Feature:** UI — the out-of-order warning
**Steps:**
1. In TC-057's picker, click Book here on #2, then Confirm Selection
2. Try Book here anyway with no reason; then type a reason and click it

**Expected Result:**
- The warning names #1 MAEU and its 4 TEU free. Book here anyway is disabled until a reason is typed
- The Contract area shows "#2 of 2 · out of order". GET /api/shipments/:id returns `steeringVerdict: "out_of_order"` with the reason

**Status:** PASS (2026-10-21, automated: cypress/e2e/where-to-book.cy.js)

---

### TC-059: The server works out the verdict for every contract choice
**Feature:** shipments.steering_* — POST/PUT /api/shipments
**Precondition:** A line with #1 MAEU (4 TEU a week), #2 HLCU (10 TEU), #3 CMDU (no space); ONEY also sails the lane
**Steps:**
1. Create shipments on #1, on #2 with a `steeringReason`, then on #2 after #1's week is full
2. Create one on ONEY, one on SPOT, one Customer Own, one Pending, and one on a lane with no steering

**Expected Result:**
- The verdicts are, in order: steered (rank 1); out_of_order (rank 2, with the reason and better option #1 at 2 TEU free); steered; other_carrier; spot; customer_own; no_contract; not_covered
- The History has BOOKED_OUT_OF_ORDER or BOOKED_OFF_STEERING for each one that didn't follow

**Status:** PASS (2026-10-21, automated: tests/steering-verdict.test.js)

---

### TC-060: A reassignment is judged again; a reason alone isn't
**Feature:** PUT /api/shipments/:id
**Steps:**
1. Move the ONEY shipment to #3 CMDU, then to #2 HLCU
2. PUT only a new `steeringReason` on the out-of-order shipment, after #1 has filled up

**Expected Result:**
- #3: out_of_order. #2: steered, and the old reason is cleared
- The new reason is saved, and the verdict stays out_of_order

**Status:** PASS (2026-10-21, automated: tests/steering-verdict.test.js)

---

### TC-061: The steering report counts the verdicts
**Feature:** GET /api/reports/steering
**Steps:**
1. GET /api/reports/steering?from=2028-03-01&to=2028-03-31&lane=EU-N → NAM
2. Repeat without the lane, with carrier=MAEU, and with to before from

**Expected Result:**
- Lane filter: 4 steered, 1 out of order, 1 SPOT; rate 66.7%. The not-followed list holds the out-of-order shipment with its pick and reason
- Without the lane, the no-steering lane counts as not covered, outside the rate. MAEU: 2 shipments, 100%. to before from: 400

**Status:** PASS (2026-10-21, automated: tests/steering-verdict.test.js)

---

### TC-062: Dashboard → Steering, Lane Steering's Check, and the weekly row
**Feature:** UI
**Steps:**
1. Open Dashboard → Steering
2. Open Master Data → Lane Steering → Check, pick NLRTM → USNYC, and click Check
3. Open Space Configurations

**Expected Result:**
- The tab counts the out-of-order shipment and lists it with its reason
- Check shows #1 as THE PICK (4 TEU a week) and #2 as order only, with the line's note
- The weekly row reads "4 TEU/wk" and its week

**Status:** PASS (2026-10-21, automated: cypress/e2e/where-to-book.cy.js)

---

### TC-063: An issued House B/L only moves forward
**Feature:** PATCH / DELETE /api/shipments/:id/documents/:docId (BL01), Epic TKT-C7EBU3 Story 1
**Precondition:** A realistic NLRTM → USNYC shipment with a container and a confirmed MAEU booking
**Steps:**
1. Issue (confirm) a House B/L, then try to delete it and to set it back to draft
2. Generate a second draft and try to issue it while the first is issued
3. Void the first without a reason, then with one; try to issue it again and to delete it
4. Issue the second; delete a fresh draft; confirm, un-confirm and delete a packing list

**Expected Result:**
- Delete and back-to-draft of the issued one: 409; issuing a second: 409; voiding without a reason: 400
- Voided with a reason, kept on its VOIDED event; issuing or deleting it again: 409
- The second can be issued once the first is voided; drafts and other document types keep their rules

**Status:** PASS (2026-10-21, automated: tests/house-bl-issue-rules.test.js)

---

### TC-064: A regenerated House B/L draft replaces the earlier one; two issues racing
**Feature:** POST /api/shipments/:id/documents/generate (BL01); `ux_shipment_documents_one_issued_house_bl`
**Precondition:** As TC-063, with the booking linked to the first draft
**Steps:**
1. Generate a second draft
2. Upload two BL01 files and issue both at the same moment

**Expected Result:**
- Only the second draft is left; the booking's linked B/L follows to it; the first has a REPLACED event
- Exactly one of the racing pair is issued (200), the other refused (409)

**Status:** PASS (2026-10-21, automated: tests/house-bl-issue-rules.test.js)

---

### TC-065: The House B/L record, readiness and loading
**Feature:** lib/house-bl.js; GET /api/shipments/:id/house-bl; PATCH documents (BL01 confirm), Epic TKT-C7EBU3
**Precondition:** A complete NLRTM → USNYC shipment (tests/helpers/house-bl.mjs): parties with addresses, a sealed 40' HC with 1,200 cartons, the booking confirmed by the carrier, loaded
**Steps:**
1. Save the container without the package fields, then with pallets, then with an unknown code and with 0
2. Generate a shipped-on-board draft and issue it; read the record, its DCSA document and history
3. On a second shipment, clear the seal and packages and try to issue
4. On a shipment not loaded: issue an old-style draft; a typed future on-board date; a received-for-shipment draft; a typed today's date

**Expected Result:**
- Packages kept on a save without them; PX takes "Pallet"; bad code and 0 refused
- DRAFT then ISSUED with today's date, place of issue, B/L number on the shipment; DCSA document with 1,200 CT, 45G1 and the seal, the consignee's LEI; B/L Issued done
- Issue refused, naming seal number, number and kind of packages
- Old-style refused ("Loading"); future date 400; received-for-shipment issued dated today; typed date issued as shipped on board, source Typed

**Status:** PASS (2026-10-21, automated: tests/house-bl-record.test.js)

---

### TC-066: Release at destination
**Feature:** PATCH …/bl-surrender, …/bl-release; DO01 generation
**Precondition:** An issued Original House B/L; a collect telex-release shipment whose consignee is on credit hold
**Steps:**
1. Release before surrender; generate a Delivery Order; record the originals at destination; release; generate the Delivery Order
2. On the collect shipment: surrender, then release; override without a reason; override with one

**Expected Result:**
- Release 409 (originals) and Delivery Order 409 before; after surrender, release 200, Cargo Released done, Delivery Order 201
- Collect: 409 naming "OFR (not invoiced)" and the credit hold; override without reason 400; with reason 200, history names both checks

**Status:** PASS (2026-10-21, automated: tests/house-bl-record.test.js)

---

### TC-067: The House B/L as an eBL
**Feature:** POST /api/shipments/:id/house-bl/issue-ebl; /api/ebl/v3/*; Test Tools → eBL Platform
**Precondition:** A scratch Rotterdam legal entity with address, VAT, SCAC, phone and email; shipments issued on paper
**Steps:**
1. Issue as eBL without, then with, the shipper's WAVE id; issue again while pending; the platform answers ISSU
2. Endorse to the consignee; SREQ
3. On a collect shipment: ISSU, SREQ, then AREQ
4. Another: BREQ, then send again; a Sea Waybill; call the receivers without the platform credential

**Expected Result:**
- Refused naming Customers → Identifiers; then PENDING, the platform verifies the JWS manifest; second request 409; ISSU recorded
- SURR: surrendered for delivery, released, Cargo Released done
- SREJ with the collect charges reason, back to ISSUED; AREQ: surrendered for amendment, no live House B/L
- BREQ back to paper with the reason, then pending again; Sea Waybill refused; 401 twice

**Status:** PASS (2026-10-21, automated: tests/house-bl-ebl.test.js)

---

### TC-068: The House B/L screens
**Feature:** HouseBlPanel (Documents), the container form's Packages fields, Test Tools → eBL Platform (Epic TKT-C7EBU3)
**Precondition:** Three complete shipments; one with no packages on its container; one issued from a scratch export office whose legal entity has a SCAC, address and contact, its shipper with a WAVE id
**Steps:**
1. Documents of the first: Issue House B/L; Originals presented at destination; Release cargo
2. Documents of the second: follow the readiness list's Cargo link, fill Packages 24 and Kind PX, save, go back
3. Documents of the third: Issue; Issue as eBL → Send to WAVE; Test Tools → eBL Platform: ISSU, then SREQ; back to Documents

**Expected Result:**
- ISSUED, history "Issued, shipped on board"; SURRENDERED; the release dialog's checks OK; RELEASED, the Delivery Order unlocked
- The readiness list named the packages; the Cargo row reads "24 PX"; the panel then says Ready to issue
- eBL PENDING with the shipper's WAVE id; the platform row ISSUED, then SURR; the panel RELEASED · eBL, history "WAVE issued the eBL (ISSU)" and "eBL surrendered for delivery (SURR)"

**Status:** PASS (2026-10-21, automated: cypress/e2e/house-bl.cy.js)

---

### TC-069: House B/L numbers, corrections and overdue tasks
**Feature:** office number series, POST …/house-bl/number, surrender-for-amendment, ops-sweep task closing (Epic TKT-C7EBU3, G5, G6, G21; carrier booking → MB01, G22)
**Precondition:** A scratch export office; complete NLRTM → USNYC shipments on it (tests/helpers/house-bl.mjs, some with `numbered: false`)
**Steps:**
1. Set the office prefix (a dash refused; another office can't take it); draft before the number exists, then try to issue it from the Documents list
2. Take the number (POST …/number twice), save the shipment with a blank B/L number, issue; try to change the number
3. A second shipment on the office; void the first and take its next number; type a number on a third, issue; type the same on a fourth
4. Issue one, change its consignee's address, surrender it for amendment (without, then with a reason), draft and issue v2, surrender and release
5. Set B/L Issued and SI Submitted overdue, run the ops sweep, issue the House B/L, complete SI Submitted by hand
6. Link a BL01 and an MB01 to the carrier booking

**Expected Result:**
- `T<letters>` + year + 00001 shown as next; the early draft has no number and is refused (409)
- The same number both times, kept on the shipment as SERIES, and the blank save keeps it; issued under it; changing it 409
- 00002 for the next shipment; after the void the shipment's number is released and the next is 00003; the typed number is used (TYPED); the fourth is blocked ("already used by")
- "Consignee" listed as changed; 400 without a reason; SURRENDERED_FOR_AMENDMENT with the reason, its BL01 voided; v2 amends v1 under the same number, nothing changed since; both versions on record; released; then no amendment (409)
- The sweep opens an overdue task for each; issuing closes the B/L Issued one ("Closed automatically"), the SI one closes when completed
- BL01 refused (400, "Master Bill of Lading"); MB01 linked

**Status:** PASS (2026-10-24, automated: tests/house-bl-series.test.js, tests/carrier-booking.test.js)

---

### TC-070: What the House B/L says, and its originals
**Feature:** to order, originals and copies, charges, carriage, reefer and DG, the originals log, the telex release notice (Epic TKT-C7EBU3, G11, G12, G14, G16, G17, G18)
**Precondition:** A legal entity with SCAC, address, phone and email on a scratch export office (so each DCSA document can be checked whole); complete shipments on it
**Steps:**
1. Set to order: an unknown mode; to order of the consignee; to order (of the shipper); a Sea Waybill to order. Issue each valid one
2. Draft with 0 originals; a Sea Waybill with 2; issue 3 originals and 2 copies with charges (OFR prepaid, DTHC collect); issue 2 originals as arranged
3. Replace the legs with NLRTM → ESALG, ESALG → USNYC and a truck delivery (carrier's haulage); issue
4. A 40' reefer at -18 °C; a class 3 container without a UN number, with "12A", with "UN 1263" PAINT; issue each
5. Log handovers (no recipient, a courier without tracking, 4 of 3, then 3 by DHL); present the originals with who presented them; log another; surrender a telex release at origin twice

**Expected Result:**
- 400; DCSA isToOrder with the consignee; isToOrder with no consignee; readiness refuses the Sea Waybill to order
- 400 (1 to 9 originals); 400 (no originals on a Sea Waybill); DCSA 3 originals and 2 copies with charges and both charges; without charges no charges block
- Summary: two vessels, transshipment at ESALG, on-carriage TRUCK; DCSA FIRST_SEA_GOING then MOTHER, onCarriageBy TRUCK
- activeReeferSettings −18 CEL; readiness asks for the UN number and proper shipping name; 400 for "12A"; saved as 1263; DCSA dangerousGoods UN 1263 PAINT class 3
- 400, 400, 400, then logged with its tracking number in the history; "presented by" recorded; then 409; one High telex release task for the import office, linked from the record, once
- Every DCSA document passes the eBL 3.0 spec

**Status:** PASS (2026-10-24, automated: tests/house-bl-content.test.js)

---

### TC-071: The remaining House B/L screens
**Feature:** HouseBlPanel (number, originals and copies, originals log, amendment, telex notice), Conditions (consignee on the B/L), Carrier Booking review (Master B/L) — mockup https://claude.ai/artifact/CnuymDL2eUEnxnD8oDtj57
**Precondition:** Complete shipments; one with release type Telex Release; an MB01 uploaded on a booked shipment
**Steps:**
1. Documents: set originals 2 and copies 1, Issue; Record handover by courier; Surrender for amendment with a reason; Issue version 2
2. Conditions → Edit → Consignee on the B/L: To order of the consignee → Save; Documents → Issue
3. Documents of the telex release shipment: Issue; Surrendered at origin
4. Carrier Booking → Review → Link Master B/L → pick the MB01

**Expected Result:**
- The number line says "(next)" from the series; ISSUED with "office series"; history "2 originals, 1 copy"; the originals log "2 of 2 by courier"; AMENDING · v2, "Version 2 replaces version 1", "Kept from version 1"; ISSUED again with the versions box (v1 surrendered for amendment, v2)
- The Conditions row reads "To order of the consignee", the panel too; the record is issued to order (CONSIGNEE)
- "Telex release notice sent to …", with a Kanban task of type telex_release_notice
- The modal explains the Master B/L; the button then reads "Change Master B/L"

**Status:** PASS (2026-10-24, automated: cypress/e2e/house-bl.cy.js, cypress/e2e/carrier-booking-lifecycle.cy.js)

---

## Area 12 — DCSA Carrier Messages (2026-10-27, the DCSA message review)

### TC-072: The booking request as DCSA Booking 2.0
**Feature:** Send Booking Request — the body as sent, Booking 2.0's condition rules, the carrier's local office (ARCHITECTURE.md §8.41)
**Precondition:** A scratch legal entity with email and phone on a scratch export office; a complete Central NLRTM → USNYC MAEU shipment with contract MAEU-SC-2026-0418, a SEA leg (MAERSK KENSINGTON 444W), a sealed 40' HC and a Line Agent (Export) party with an address and contact
**Steps:**
1. Send the booking request; read the outbound message's raw and parsed payloads
2. The carrier confirms (Test Tools → DCSA Carrier)
3. A SPOT shipment with no contract or quote reference: send; then set the quote SPOT-Q-2026-0611 and send
4. A shipment with no ETD and no SEA leg: send

**Expected Result:**
- 201. The raw payload validates against Booking 2.0 with no field the spec doesn't define; the parsed payload is CargoDesk's summary
- `serviceContractReference` MAEU-SC-2026-0418 and no quotation reference; `carrierBookingOffice` = the Line Agent, UNLocationCode NLRTM, with its address and contact; `bookingAgent` = the legal entity with its email; the voyage with its vessel
- Confirmed by the carrier
- 400 naming the service contract number, nothing recorded; then 201 with `contractQuotationReference` SPOT-Q-2026-0611 alone
- 400: "the ETD, or the vessel and voyage"

**Status:** PASS (2026-10-27, automated: tests/dcsa-messages.test.js)

---

### TC-073: Shipping Instructions 3.0 and VGM 1.0 through the carrier
**Feature:** Shipping Instructions submit / update / complete, VGM declare / re-declare / retract (ARCHITECTURE.md §8.41)
**Precondition:** The confirmed shipment of TC-072; the no-ETD shipment of TC-072 (no booking) with a sealed container
**Steps:**
1. VGM: mark the container Submitted, Method 2, 12,350 kg; change the weight to 12,410; change only the cargo description; back to Pending; Submitted again with Method 1
2. VGM on the unbooked shipment's container: Submitted, Method 1, no weight
3. Shipping Instructions on the unbooked shipment: save a draft, submit
4. Shipping Instructions on the confirmed shipment: save a draft, submit; the carrier asks for an update ("Consignee tax ID missing for US customs"); Reset to Draft; submit; the carrier completes them; submit again

**Expected Result:**
- One declaration at the carrier, 12,350 KGM SM2, for the booking number, shipper responsible, legal entity submitting, logged as sent (valid VGM 1.0, no undefined fields); replaced at 12,410; the description change sends nothing; retracted; un-retracted, SM1
- 400 "verified gross mass", nothing declared
- 400 naming the carrier's booking number
- 201 with a SISIM- reference, the body valid Shipping Instructions 3.0 with no undefined fields (the booking number, shipper, consignee, the container); RECEIVED; Rejected with PENDING_UPDATE and the reason; Draft with the same reference; sent as an update (UpdateShippingInstructions, same reference), UPDATE_RECEIVED; Confirmed, COMPLETED; then 409

**Status:** PASS (2026-10-27, automated: tests/dcsa-messages.test.js; the notification refusals in tests/carrier-integrations.test.js)

---

### TC-074: The carrier's Master B/L, VGM declarations and events (DCSA phases 4–6)
**Feature:** Master B/L draft → approve → issue → surrender; Shipping Instructions update and cancel; House B/L in the Master's SI (G25); VGM declarations with evidence and VG01; Track & Trace 3.0 pushed and pulled; OVS vessel times; milestone DCSA events (ARCHITECTURE.md §8.42)
**Precondition:** A scratch legal entity with email and phone on a scratch export office; complete NLRTM → USNYC MAEU shipments booked and confirmed through the demo carrier; the consignee with an LEI
**Steps:**
1. Submit the Shipping Instructions; the carrier drafts; read the Master B/L; approve it; the carrier issues it; send an update and cancel; the carrier surrenders it
2. On another shipment: send an update, cancel the update, cancel the instructions, reset and submit again
3. Issue a House B/L and submit the Master's instructions
4. Declare a container's VGM, attach a weighbridge ticket, generate a VG01, re-declare, withdraw; file a document against another shipment's declaration; remove the declared container
5. Report gate-ins, a corrected gate-in, an older copy, an estimated then actual departure, an arrival, customs release, a gate-out and its retraction; retract the actual departure; pull the events; push a departure naming only vessel and voyage
6. Set the carrier's vessel times (estimated, then actual); check vessel times; let AIS report a departure; run the three poll sweeps
7. Create a template milestone with a DCSA event that doesn't exist, then one that does; log the event

**Expected Result:**
- The draft is read and valid; the instructions show Confirmed; the review compares shipper, consignee, each container and seal, the ports; a review task opens, closes on approval; issued: the shipment takes the Master B/L number, B/L Issued completes; update and cancel 409; surrendered: the instructions COMPLETED
- The update goes under the same reference; its cancellation leaves the instructions standing; the cancellation makes them Cancelled; reset sends new instructions under a new reference
- The Master's instructions carry the House B/L under its number, valid DCSA with no undefined fields
- One declaration, flagged "no evidence"; the ticket and VG01 filed against it clear the flag; the re-declaration is flagged again, the earlier keeps its files; the retraction is on record; 400 for the other shipment's declaration; 409 for the declared container
- Container events and milestones from the events; the correction corrects, the older copy is ignored; the retraction removes the container event; the retracted departure falls back to the latest estimate and its Sailed events go; the pull adds and retracts nothing again; the vessel-only departure reaches the shipments on that voyage and not the next one
- The estimates move the leg (carrier estimate), the actual confirms it and completes Vessel Departed; AIS leaves it; the sweeps answer 200
- 400 for the unknown event; the valid one completes its milestone

**Status:** PASS (2026-10-28, automated: tests/dcsa-documents-events.test.js)

---

### TC-075: The DCSA documents and events screens
**Feature:** Master B/L card (foldable, critical facts first), VGM declarations with evidence and VG01, Milestones & Events (sea leg sources, milestone DCSA events, From the carrier), Test Tools → DCSA Carrier tabs — mockup https://claude.ai/artifact/VUTPKnRAjdPjfb8DntUxVs
**Precondition:** A booked shipment with the demo carrier, Shipping Instructions drafted into a Master B/L, one container's VGM declared, gate-in and departures reported
**Steps:**
1. Shipping Instructions: read the card; Show all fields; fold and unfold; Approve draft; Cancel instructions then Keep them
2. VGM: open a container's declarations; attach a weighbridge ticket; Generate VG01
3. Milestones & Events: read the sea leg and the milestones; Sync carrier events
4. Test Tools → DCSA Carrier: Shipping Instructions & B/L → Issue; Track & Trace → Loaded; Vessel times; back on Shipping Instructions

**Expected Result:**
- DRAFT · TO REVIEW, "No differences", the key facts; the field list opens with each container; folded, the body is gone; APPROVED and "Waiting for MAEU to issue it"; the cancel confirmation names the reference, Keep them closes it
- "No evidence on file", then "Weighbridge ticket"; the evidence and VG01 chips; "Generate VG01 again"
- ETD tagged ACTUAL; Vessel Departed tagged "Transport · Departed at POL", Delivered "Completed by hand"; the carrier's events with "Vessel Departed completed"; "Nothing new from MAEU"
- Issued; "Loaded recorded for …"; the vessel-time form; the card ISSUED and the instructions locked

**Status:** PASS (2026-10-28, automated: cypress/e2e/dcsa-documents-events.cy.js; src/components/shared/MasterBlPanel.test.jsx)

### TC-076: Amending the issued Master B/L (DCSA eBL 3.0.3 amendment)
**Feature:** Request amendment on an issued Master B/L — preview of what differs, the carrier's answer, the amended B/L — mockup https://claude.ai/code/artifact/1bf14417-6d13-4009-a277-ada52600d001
**Precondition:** A shipment with the demo carrier whose Master B/L is issued; a container's seal changed on the shipment since
**Steps:**
1. Shipping Instructions → Master B/L card: Request amendment; read the preview; Send amendment to MAEU
2. Cancel the amendment; request it again
3. Test Tools → DCSA Carrier → Shipping Instructions & B/L: Decline the amendment (with a reason); request again; Accept the amendment
4. Originals surrendered for amendment; Issue the amended B/L
5. With nothing changed on the shipment, Request amendment

**Expected Result:**
- The preview lists the one seal change (on the B/L → shipment now); the card shows ISSUED · AMENDMENT REQUESTED and WAITING FOR MAEU
- Withdrawn: nothing pending; a new request goes again
- Declined: the reason on the card, a decline task on the Kanban (closed by the next request); accepted: "Return the 3 original B/Ls", a task until they're back, the amendment steps
- The amended B/L under the same number, the card listing the change (was → now), History with the request, decline and amendment
- "Nothing to amend"; a draft B/L points to Send update instead

**Status:** PASS (2026-10-28, automated: tests/dcsa-amend-equip-arrival.test.js; cypress/e2e/dcsa-amend-equip-arrival.cy.js; src/components/shared/MasterBlPanel.test.jsx)

### TC-077: Equipment by ISO 6346 code, 45' units, seals with who applied them
**Feature:** DCSA phase 3 — containers carry their ISO code and a list of seals
**Precondition:** A shipment with containers
**Steps:**
1. Cargo → a 40' high cube: read the equipment type; open the picker
2. Add a 45' High Cube container; add a customs seal to a container (＋ Add seal, Applied by: Customs); save
3. Send the booking, the Shipping Instructions and a VGM declaration

**Expected Result:**
- 45G1 shown first, "was 40HC"; the picker grouped 20/40/45 ft by ISO code
- The 45' unit is L5G1 and counts 2 TEU; the cargo table shows each container's code and every seal with who applied it; History logs the seals
- The booking asks for one line per ISO code (a 40' high-cube reefer stays 45R1, its set point on its line); the Shipping Instructions and the VGM list every seal with its source; the Shipping Instructions carry no reefer settings

**Status:** PASS (2026-10-28, automated: tests/dcsa-amend-equip-arrival.test.js; cypress/e2e/dcsa-amend-equip-arrival.cy.js)

### TC-078: The carrier's Arrival Notice and Port Call times
**Feature:** DCSA Arrival Notice 1.0 on the import side (Booking & Routing → Arrival Notice); Port Call 2.0 berth times
**Precondition:** A shipment whose Master B/L the demo carrier issued; one container with its own detention days; a THC accrual already on the shipment
**Steps:**
1. Test Tools → DCSA Carrier → Shipping Instructions & B/L: Publish Arrival Notice; open Arrival Notice on the shipment
2. Use the carrier's days on the container that differs; Add as accruals
3. Announce a second version (lightweight); Ask MAEU again
4. Generate AN01 from it
5. Test Tools → Vessel times: send an actual departure and an estimated, then actual, arrival as Port Call events; publish another Arrival Notice with a later date

**Expected Result:**
- Version 1: the vessel, the arrival, pickup and return points, release state; the ETA moved; empty free days FILLED; the differing one SAYS 10 DAYS with Keep / Use
- The container takes the carrier's 7 days; the chosen charges become BUY accruals (collect), the one looking entered stays unticked; asking again adds nothing
- Version 2 is current, both kept; nothing new on asking again
- AN01 carries the carrier's ETA, last free day, pickup and return points
- The leg's ETD and ETA are confirmed (ACTUAL); the later Arrival Notice estimate doesn't undo the arrival; a call for a voyage no shipment has is answered with a warning

**Status:** PASS (2026-10-28, automated: tests/dcsa-amend-equip-arrival.test.js; cypress/e2e/dcsa-amend-equip-arrival.cy.js; src/pages/shipments/ShipmentArrivalNoticePage.test.jsx)

---

## Area 13 — The House B/L Audit's Fixes and Dangerous Goods (2026-10-29, epic TKT-J0SDVB)

The server-side rules of the House B/L audit's fixes and the DG booking (ARCHITECTURE.md §8.44). The customer's DG
contact form is built (mockup 12f412e9, screen 5); the new controls on the House B/L panel wait for screens 1–4, so
TC-079 and TC-080 run through the API until they are built.

### TC-079: One title to the cargo: originals, void, eBL, telex release
**Feature:** the originals log both ways, void rules, eBL and telex release guards (H1, H2, H3, M5, M6, L1)
**Precondition:** A ready telex-release shipment on an export office whose legal entity has a SCAC and address; a second one for the eBL
**Steps:**
1. Issue the House B/L in 3 originals; hand all 3 to the shipper; try a 4th handover
2. As admin, void it; surrender it at origin; issue it as an eBL
3. Record 2 returned, then 2 more, then the last one
4. As an operator, void it; as admin, surrender it at origin, then void it
5. On the second shipment, issue an eBL on WAVE; mark it surrendered by hand; void it

**Expected Result:**
- 3 out; the 4th is refused (409, all out already)
- Each is refused (409) while originals are out; the void and the surrender say 3 are still with the shipper
- 1 still out; more than are out is refused (400); then none out
- 403 for the operator; the surrender goes; the void is refused once surrendered for delivery (409)
- Both refused (409): a live eBL is surrendered and voided only through its platform

**Status:** PASS (2026-10-29, automated: tests/house-bl-audit-fixes.test.js)

---

### TC-080: Shipped on board, the issuer, the notation, approval, clauses, House vs Master
**Feature:** M1, M2, M3, M4, L2, L3, L4
**Precondition:** A ready shipment with two containers; its export office's legal entity first without a SCAC
**Steps:**
1. Load one container; read readiness. Load the second
2. Issue with the legal entity lacking a SCAC; add the SCAC and issue
3. Issue another as Received for shipment; add the on-board notation before loading, after loading, and again
4. Add 11 clauses to a draft, then 2; send the draft for approval without an email, then to the shipper; record changes asked without saying what, then with; generate a new draft and record an answer; send again and approve
5. Have the carrier draft its Master B/L; compare; replace a seal on the shipment and compare again

**Expected Result:**
- 1 of 2 loaded: not shipped on board, naming the container that isn't; with both, shipped on board dated by the last loading in Rotterdam's own day
- Refused, asking for the issuer's SCAC; issued, dated in the office's own day
- 409 before loading; then the notation on the same B/L (version 1), dated and in its DCSA document; 409 the second time
- 400 for 11 clauses; the 2 are on the draft and in DCSA carrierClauses after the fixed ones; 400 without an email; recorded as sent; 400 without the change; recorded with the shipper's words; 409 (the answer belongs to the draft sent); approved
- No Master: nothing to compare; then the House matches; after the seal change one difference (both seal values), on the House B/L and the Master B/L card

**Status:** PASS (2026-10-29, automated: tests/house-bl-audit-fixes.test.js; src/utils/houseBlPrint.test.js)

---

### TC-081: Dangerous goods in the DCSA booking, the shipper's emergency contact, DG01
**Feature:** DG in Booking 2.0 (TKT-K7ICYT finding) and the shipper's DG emergency contact (the user's call, 2026-10-29)
**Precondition:** A shipper (a Rotterdam paint maker) with no DG emergency contact; its MAEU shipment with two 40' HC containers of paint (class 3, 80 drums each), one missing its UN number and proper shipping name, and one 20' container that isn't DG
**Steps:**
1. Send Booking Request
2. Complete the container (UN 1263, PAINT). Customers → the shipper → Profile: tick Ships dangerous goods; give a name but no phone; then a phone that isn't a number
3. Give the contact: Van Wijk DG Desk, +31 10 437 2299, CHEMTREC, CCN-204417; Save Profile; save the customer again through the API without the contact field; send Booking Request
4. Generate DG01; untick Ships dangerous goods, Save Profile, and generate it again
5. Repeat step 3's saves with the customer service as the source (`customer_source=remote`)
6. Open App Settings

**Expected Result:**
- 400, naming the container's missing UN number and proper shipping name and the shipper's missing contact, by the shipper's name
- The form says a name and a 24-hour phone are needed, then that it must be a phone number, and holds Save; the API answers 400 for both
- Saved with all four fields; kept by the save without it; sent: on the 45G1 line UN 1263 PAINT class 3, 32,400 kg in 160 DR, the emergency contact with all four fields, nothing on the 20' line; a valid Booking 2.0 request
- DG01 prints the contact, the 24-hour phone, provider and reference, no CHEMTREC/CANUTEC hotline text; with no contact it isn't generated, saying to add it to the shipper's profile
- The same through the customer service
- No Compliance tab: the org-wide DG Compliance Address is gone

**Status:** PASS (2026-10-29, automated: tests/carrier-booking.test.js; tests/container-packages.test.js; tests/customer-service-toggle.test.js; src/utils/dgDeclaration.test.js; cypress/e2e/customer-dg-contact.cy.js)

---

### TC-082: The 0.91.12 release audit's fixes
**Feature:** release audit R1–R5 (epic TKT-KT4QIC, ARCHITECTURE.md §8.44)
**Precondition:** A shipment with an issued House B/L whose 3 originals are with the shipper; another issued as a live eBL on WAVE; a demo-carrier shipment N with an issued Master B/L and a sea leg on MAERSK KENSINGTON
**Steps:**
1. Delete each of the two House B/L shipments
2. Call the demo carrier's API (`/dcsa-sim/v3/service-schedules`) with no token, with `dcsa-simulator`, and with the token from `GET /api/dcsa-simulator/status` (admin)
3. Create shipment X, not booked with the demo carrier, naming N's Master B/L; publish an Arrival Notice for N
4. Mark N Completed; publish another Arrival Notice; send an actual berth arrival for its voyage on another day
5. Post to the old `…/containers/:id/vgm/simulate-response` for a Submitted VGM; open Test Tools

**Expected Result:**
- 409 both times ("an issued House B/L" / "a live eBL", cancel instead); the House B/L and its originals log are still there
- 401, 401, 200
- N gets the new version; X gets no Arrival Notice
- No new version on N; the carrier is told N "is Completed: not changed"; the leg keeps its arrival
- 404, the VGM stays Submitted; Test Tools has no VGM Simulator tab

**Status:** PASS (2026-10-29, automated: tests/house-bl-audit-fixes.test.js; tests/dcsa-simulator.test.js; tests/dcsa-amend-equip-arrival.test.js; tests/dcsa-messages.test.js)

---

## Area 14 — The » Advance Bar on Shipment Pages (2026-11-02, TKT-ACI6J1)

The bar down the right edge of every shipment page (ARCHITECTURE.md §8.45, mockup d3c085ee, style B). Frontend only.

### TC-083: » walks the shipment's tree in order
**Feature:** » opens the next item of the sidebar tree, in the admin-saved order, nothing skipped
**Precondition:** A Central FCL export NLRTM → USNYC on MAEU, 1 × 40' HC of flat-packed furniture, no contract or schedule yet,
no customs broker; an export VGM and an import Delivery ordered. Logged in as an admin
**Steps:**
1. Open the shipment's Overview
2. Open the first row of the sidebar, then click » until there's no bar, noting the name on the bar each time
3. As a trade manager, open the last service row
4. On Overview, order an import Unloading service, then click »

**Expected Result:**
- On Overview the bar reads "Next · Milestones & Events" (for the admin-saved order) and the page's scroll area ends where the bar starts
- The names, in order, are the sidebar's rows top to bottom: a group's rows one by one (Contracts & Schedules,
  Carrier Booking, Shipping Instructions, Arrival Notice, Customs Filing, Delivery Service), VGM under Export Services,
  the three Accounting rows, History last; Carrier Booking and Customs Filing open on their lock and » still moves on;
  the sidebar highlights each row reached; on History there is no bar and the page gets its width back
- The bar reads "Next · History": no Accounting rows for a trade manager
- » goes to Milestones & Events, not to the new service; the Unloading row appears under Import Services at once

**Status:** PASS (2026-11-02, automated: src/shipmentNavSequence.test.js; src/components/shared/ShipmentAdvanceBar.test.jsx; cypress/e2e/shipment-advance-bar.cy.js; real-browser pass on SHP-AQ1FIM, 16 rows)

---

### TC-084: » saves first, and dialogs stop it
**Feature:** » runs the page's save check; Alt+→; dialogs and prerequisite locks
**Precondition:** The shipment of TC-083
**Steps:**
1. On Cargo, click + Add Container, leave the form empty, click »
2. On Overview, press Alt+→
3. On Overview, open + Request Service, press Alt+→; close the dialog
4. Open Customs Filing (locked: no customs broker, no priced cargo line), press Alt+→

**Expected Result:**
- The page stays on Cargo; the bar flashes red; the toast says the container form has incomplete/invalid fields and names them; nothing is saved
- Milestones & Events opens
- Nothing happens while the dialog is open (it covers the bar)
- The lock leaves the bar above its backdrop; Alt+→ opens VGM

**Status:** PASS (2026-11-02, automated: src/components/shared/ShipmentAdvanceBar.test.jsx; src/components/primitives/Modal.test.jsx; cypress/e2e/shipment-advance-bar.cy.js; real-browser pass in dark and light)
