# CargoDesk — Test Cases
**Version:** v0.26.0 "Meridian II"
**Date:** 2026-07-09
**Author:** QA Engineering (Claude Code)

Status legend: `PASS` | `FAIL` | `SKIP` | `BLOCKED`

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
