# Smart Contract Picker — Decision Tree & Implementation Plan

## Overview

When a user links a contract to a Central-type shipment, the system should first check
whether any pre-committed space configurations (allocations) cover that route. If they
do, those are surfaced first and the user is guided toward consuming allocated space
before booking freely against a contract. Skipping an allocation or overrunning one
always requires a structured reason, which is auto-posted to shipment messages.

---

## Decision Tree

```
User opens contract picker on a Central shipment
│
├── Parallel fetch (fires simultaneously on picker open):
│   ├── A — Matching space configurations
│   │       WHERE pol/pod match (direct or linked-port equivalent)
│   │         AND effective_date ≤ ETD ≤ end_date
│   │         AND status = Active
│   │       Returns: carrier, route, allocated_teu, consumed_teu,
│   │                remaining_teu, linked contract_id, validity
│   │
│   └── B — Matching contracts (unrestricted by carrier)
│           WHERE any leg covers POL → POD
│             AND status = Active
│             AND valid_from ≤ ETD ≤ valid_to
│           Sorted by lowest total buy rate (USD)
│           Grouped by contract_number when duplicates exist
│
│
├── CASE 1 — Space configurations found
│   │
│   ├── Picker shows a "Space Configurations" section at the top,
│   │   followed by a "Skip — choose contract instead →" affordance,
│   │   followed by the contracts section below.
│   │
│   ├── 1a — User selects a space configuration
│   │   │
│   │   ├── Compute TEU impact:
│   │   │     shipment_teu = sum of container TEU on shipment (0 if none added yet)
│   │   │     overage      = shipment_teu > config.remaining_teu
│   │   │
│   │   ├── SUB-CASE: TEU fits (no overage)
│   │   │   └── Save:
│   │   │         shipment.allocation_id  = config.id
│   │   │         shipment.contract_id    = config.contract_id
│   │   │         shipment.carrier_code   = config.carrier_code
│   │   │       No message posted.
│   │   │
│   │   └── SUB-CASE: TEU exceeds remaining space (overage)
│   │       ├── Show inline overage warning:
│   │       │     "Shipment is X TEU — only Y TEU remaining on this config (Δ +Z)"
│   │       ├── Require reason from dropdown:
│   │       │     • Carrier verbal approval
│   │       │     • Priority cargo
│   │       │     • Emergency booking
│   │       │     • Agreed uplift
│   │       └── Save:
│   │             shipment.allocation_id       = config.id
│   │             shipment.contract_id         = config.contract_id
│   │             shipment.carrier_code        = config.carrier_code
│   │             shipment.space_overage_reason = selected reason
│   │           Auto-post message (server-side):
│   │             "⚠ Space overage on allocation [config.id] — [reason].
│   │              Shipment TEU: X | Config remaining: Y | Delta: +Z TEU"
│   │           Shipment detail shows amber "Space warning" badge.
│   │
│   └── 1b — User clicks "Skip — choose contract instead →"
│       ├── Require reason from dropdown (before contracts are shown):
│       │     • Allocation exhausted
│       │     • Carrier-direct booking
│       │     • Customer request
│       │     • Operational exception
│       ├── Contracts section expands / becomes active
│       └── User selects a contract
│           Save:
│             shipment.contract_id       = contract.id
│             shipment.carrier_code      = contract.carrier_code  (auto-updated)
│             shipment.allocation_id     = ''  (explicitly cleared)
│             shipment.space_skip_reason = selected reason
│           Auto-post message (server-side):
│             "ℹ Space configuration skipped — [reason].
│              Contract [number] ([carrier]) selected instead."
│
│
└── CASE 2 — No space configurations found
    └── Picker shows contracts section only (no allocation UI, no friction).
        User selects a contract.
        Save:
          shipment.contract_id   = contract.id
          shipment.carrier_code  = contract.carrier_code  (auto-updated if different)
          shipment.allocation_id = ''
        No message posted.
```

---

## Carrier Auto-Update Rule

Whenever a contract is selected (regardless of path):

- If `contract.carrierCode !== shipment.carrierCode`, automatically set
  `shipment.carrierCode = contract.carrierCode`.
- Show an inline notice in the picker before the user confirms:
  `"Carrier will be updated to [CODE] to match this contract."`
- This makes the contract the source of truth for the carrier rather than
  an independent field the user must keep in sync manually.

---

## Post-Booking Overage (Step 3)

Overage at booking time is not the only risk. Containers can be added or updated
after the contract is linked, potentially pushing the shipment over its allocation limit.

Re-evaluate on every container save (add / update / remove):

```
new_total_teu = sum of all container TEU after the operation

if shipment.allocation_id is set:
  fetch allocation remaining_teu (excluding this shipment's current contribution)
  if new_total_teu > remaining_teu:
    set shipment.space_badge = 'exceeded'   (red badge — no reason captured yet)
  elif shipment.space_overage_reason is set:
    set shipment.space_badge = 'warning'    (amber badge — reason on file)
  else:
    clear shipment.space_badge
```

The red "Space exceeded" state signals that the overage has no recorded reason —
an ops manager must either acknowledge it (adding a reason via message) or reduce TEU.

---

## Badge States (Shipment Detail Header)

| State             | Colour | Condition                                                        |
|-------------------|--------|------------------------------------------------------------------|
| _(none)_          | —      | No allocation linked, or TEU within limits                       |
| `Space warning`   | Amber  | Overage at booking time, reason on file                          |
| `Space exceeded`  | Red    | Post-booking container add/update pushed TEU over limit, no reason |

---

## Schema Changes

### `shipments` table (Step 1 migration)
```sql
ALTER TABLE shipments ADD COLUMN allocation_id        TEXT DEFAULT '';
ALTER TABLE shipments ADD COLUMN space_skip_reason    TEXT DEFAULT '';
ALTER TABLE shipments ADD COLUMN space_overage_reason TEXT DEFAULT '';
```

### `mapShipment` additions
```js
allocationId:       r.allocation_id        || '',
spaceSkipReason:    r.space_skip_reason    || '',
spaceOverageReason: r.space_overage_reason || '',
```

---

## New Endpoint (Step 2)

`GET /api/allocations/match?pol=X&pod=Y&etd=Z`

Returns allocations where the route matches (direct or linked-port), the date
falls within `effective_date`–`end_date`, and status is Active. Each result
includes pre-computed `consumedTeu` and `remainingTeu` so the picker can show
utilisation immediately without a second request.

Client-side linked-port filtering is acceptable given the small number of
allocations (typically < 50). Server-side filtering is also fine — use whichever
keeps the endpoint consistent with the existing `/contracts/match` pattern.

---

## Implementation Steps

### Step 1 — Foundation
- Add `allocation_id`, `space_skip_reason`, `space_overage_reason` to `shipments` (migration)
- Update `mapShipment`, `GET /api/shipments`, `POST /api/shipments`, `PUT /api/shipments/:id`
- Remove carrier pre-filter from `GET /api/contracts/match` (make search unrestricted)
- Auto-update `carrier_code` on the shipment form when a contract with a different carrier is selected
- Update `api.js` and `ContractField`

### Step 2 — Two-Path Picker
- New endpoint: `GET /api/allocations/match`
- Parallel fetch allocations + contracts when the picker opens
- Picker UI:
  - If configs found: Space Configs section → skip affordance → Contracts section
  - If no configs: Contracts section only
- Skip flow: reason dropdown (pre-contract reveal)
- Overage flow: TEU delta warning + reason dropdown (inline on config card)
- Carrier auto-update notice
- Server-side auto-post of skip/overage reasons to shipment messages

### Step 3 — Post-Booking Space Badge
- Re-evaluate space status on every container save (add / update / remove)
- Amber `Space warning` badge on shipment detail header
- Red `Space exceeded` badge when post-booking containers push TEU over limit
- WebSocket broadcast of badge state change to connected clients
- TRACKED_FIELDS entry for `allocation_id` so history log captures the link

---

## Reason Catalogues

### Skip Reasons (user bypasses all matching configs)
| Value | Label |
|---|---|
| `exhausted` | Allocation exhausted |
| `carrier_direct` | Carrier-direct booking |
| `customer_request` | Customer request |
| `operational_exception` | Operational exception |

### Overage Reasons (user selects a config but TEU exceeds remaining space)
| Value | Label |
|---|---|
| `carrier_verbal` | Carrier verbal approval |
| `priority_cargo` | Priority cargo |
| `emergency` | Emergency booking |
| `agreed_uplift` | Agreed uplift |
