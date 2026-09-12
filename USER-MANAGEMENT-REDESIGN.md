# User Management & Access-Scoping Redesign

**Status**: shipped, 2026-09-12. **Scope**: how CargoDesk grants and restricts visibility across
offices, branches, and countries, and how that model now covers the sales pipeline (Quotes,
Opportunities) for the first time. **Companion documents**: [`ARCHITECTURE.md`](ARCHITECTURE.md)
(technical architecture), [`DFS.md`](DFS.md) §3 (Actors & Roles) and §5.10 (Users & Access Control)
for how this fits the wider system.

---

## 1. Why this changed

An audit of the existing user-management system found it well-built for shipments — a mature
5-role system, per-role `user_scope_items` (trade lane / POL / country restrictions), office
assignment with a global-access escape hatch, and department-based edit authority — but with two
concrete gaps:

1. **Quotes and Opportunities had zero access scoping.** No office column on either table, no
   visibility filter anywhere in their routes. Any authenticated user, any role, saw every quote
   and opportunity company-wide. `opportunities.assignee_id` existed but was purely an optional
   query filter a caller could pass — never an enforced boundary.
2. **There was no Branch- or Country-level scoping — only flat, hand-enumerated grants.** Office
   visibility was one-office-at-a-time (`user_offices`); a scope restriction meant adding
   individual trade-lane/POL/country rows one at a time. There was no way to say "this user covers
   all of Germany" and have it apply to every current and future office there.

A `regions`/`countries.region_code` table already existed in the schema but was confirmed dead —
never populated (see `routes/reports.js:19-24`'s own code comment). "Regional Trade Management"
was deliberately **not** rebuilt around a new Region layer; it continues to ride on the real,
populated `trade_lanes`/`country_trade_lanes` grouping the `trade_manager` role already used for
its one existing authority (credit-hold override) — that authority's reach is simply extended to
also gate quote/opportunity visibility, not just that one action.

## 2. The org hierarchy

```
Country (ISO2, the existing `countries` table)
  └─ Branch (identified by UN/LOCODE — `branches.locode`, already wired into the API before this
     work; a Branch is a physical location, e.g. a city/port)
       └─ Office (Export "SE" or Import "SI" department — the existing `offices` table)
```

This is mostly the schema's existing shape (`offices.branch_id → branches.id`,
`branches.country_code`) — it was never previously used for user-scoping. One real data gap
surfaced during design: **9 of the app's 12 real offices have no `branch_id` set.** Rather than
requiring a data-cleanup pass first, Country-level matching is **dual-path** — it matches an
office either via its own `country_code` or via its branch's `country_code` — so a Country grant
reaches every office in that country regardless of whether it's been linked to a branch yet.

## 3. How a grant works

**Two independent mechanisms, used together:**

- **Direct office assignment** (`user_offices`, unchanged) — a user is assigned to one or more
  specific offices, with one marked default. This is still the right tool for "just this one
  office."
- **Cascaded Branch/Country grants** (new `user_scope_items` types `branch_office` /
  `country_office`) — granting a Branch or Country widens the set of offices a user can switch
  into, covering every office under it automatically, including ones added later. An admin can
  layer a narrower **exclusion** on top (same item type, `excluded: true`) to carve one office or
  branch back out of a broader grant without re-enumerating everything else.

**Resolved semantics** (each was a real design fork, decided deliberately rather than assumed):

| Question | Decision |
|---|---|
| Does a grant make every office visible at once, or still one-at-a-time? | **One at a time** — same as today's model. A grant only widens which offices a user can *switch into* via the existing office picker; it doesn't change what "active office" means or make visibility a simultaneous union. Zero behavior change for existing single-office users. |
| Does an exclusion only apply to `country_code`-matched offices, or does it need the branch join too? | **Dual-path**, same as a grant — an office's own `country_code` OR its branch's. |
| Can an exclusion override a direct `user_offices` assignment? | **No** — exclusions only ever remove offices that came from a *cascaded* grant. A direct, explicit per-office assignment is the strongest signal an admin can give and is never silently defeated by an unrelated exclusion rule. |
| Does a grant apply only under the role it was configured for, or to the user regardless of active role? | **Role-blind** — matches how direct office assignment (`user_offices`) has always worked; a user with two scoped roles doesn't get two different office-visibility pictures depending on which role is active. |

**Centralized resolution.** All of this — direct assignment, cascaded grants, exclusions, the
`all_offices`/`offices_allow_all` global bypasses — is resolved by one function,
`resolveEffectiveOfficeIds` (`server.js`), consumed by both the existing shipment filter
(`applyShipmentAccessFilter`) and the new quote/opportunity filter
(`applyOfficeScopedAccessFilter`). This avoids recreating the "disagreeing engines" bug class this
project has hit repeatedly — two independent implementations of the same access rule quietly
drifting apart.

## 4. Quotes & Opportunities

Both tables gained an `office_id` column (bare `TEXT DEFAULT NULL`, no FK — matching
`shipments.emo_office_id`/`imo_office_id`'s own convention; the same no-FK shape means
`DELETE /api/offices/:id` needed the same orphan-reference guard those columns already have).

- **On create**, the frontend defaults `officeId` from the user's active office (same pattern
  `ShipmentFormPage.jsx` already used for EMO/IMO), editable via a plain office picker.
- **On list/read**, both routes now run through `applyOfficeScopedAccessFilter` — the same
  trade_lane/POL/country scope-item matching shipments already use applies here too, so a
  `trade_manager`'s lane-based restriction now also governs which quotes/opportunities they see,
  not only their credit-hold-override authority.
- **List-route pagination was restructured** to paginate in JS *after* the access filter (matching
  `routes/shipments.js`'s existing precedent) rather than in SQL before it — a SQL `LIMIT`/`OFFSET`
  ahead of a header-driven JS filter risks a wrong or short page.
- **Conversion carries the office forward**: Opportunity → Quote copies `office_id` directly;
  Quote → Shipment resolves the quote's office to the shipment's `emo_office_id` or
  `imo_office_id` based on that office's own department (a quote has one office, not an
  Export/Import pair).
- **Existing rows were backfilled** by matching each row's `created_by` (a display-name-or-email
  string, not `users.id` — this table has never stored a real user reference) against a real
  user's assigned office — preferring their marked default, falling back to their earliest
  assignment when no default exists (see §8 — the original default-only version matched almost
  nothing against real data). Unmatched rows stay `NULL` — visible to admin/operator/`allOffices`
  users, invisible to anyone office-scoped, until an admin assigns one by hand.

## 5. The `sales` role

A 6th role, ranked alongside `occ_bk`/`trade_manager` (a non-hierarchical specialty grant, not a
rung on the admin/operator/viewer ladder). It owns the quoting pipeline — write access to Quotes
and Opportunities — deliberately **without** booking authority: it is not added to
`shipments`/`shipment-ops`/`edi`/`customs-filing`/`shipping-instructions`/`document-distribution`/
`carrier-invoices`'s write guards. It stays read-only on Customers, same as reads have always been
ungated there for every role; full customer write parity (credit terms, screening) was deliberately
left to `trade_manager`/`operator`/`admin`.

## 6. Where to configure it

`Application Settings → Users`, per-user config panel: a **Branch (office visibility)** and
**Country (office visibility)** section sit alongside the existing Trade Lane / Origin Port /
Country Codes sections, each with a Grant/Exclude toggle on add and a distinct (green/granted vs.
red/excluded, struck-through) treatment in the Applied column. These are separate from — and sit
above — the existing direct Office Assignments chips, which remain the right tool for a single-
office grant.

## 7. Post-implementation QA pass — three real bugs found and fixed

An adversarial exploratory QA pass against the live app (scratch users/offices/shipments, real
HTTP calls, not code review) found three genuine issues before this shipped, all now fixed and
re-verified against the full test suite:

1. **`requireRole` never actually respected a deliberate role downgrade.** A user holding both
   `sales` and `occ_bk`, having switched to "Sales" in the UI (`X-Active-Role: sales`), could
   still `POST /api/shipments` and get a 201 — full booking authority despite having switched away
   from it. Root cause: `requireRole` (`server.js`) always checked the caller's *full* JWT role
   array, never the active-role header — only the read-side visibility engine honored it. This
   predates this redesign, but `sales`'s entire "no booking authority" premise is the first
   feature whose correctness actually depends on it. **Fixed** by making `requireRole` collapse to
   just the active role when one is legitimately in effect — and that collapse had to be
   membership-based (`jwtRoles.includes(requestedRole)`), not rank-based: a first attempt using
   the same rank-comparison the read-side engine already used silently failed for `sales`↔`occ_bk`
   specifically, since both sit at the same rank (1) by design and a same-rank switch was never
   "strictly lower" by that check. Membership-based matches `App.jsx`'s own already-shipped
   `effectiveRoles` logic exactly, and can never grant more authority than the JWT already allows.
2. **Login/`/api/auth/me` never learned about the new grant mechanism.** Both endpoints built the
   office-picker list from direct `user_offices` rows only — a user whose *only* access is a
   Branch/Country grant (no direct row at all, the exact scenario this feature exists to enable)
   got an empty office list, the picker never appeared, and `activeOffice` stayed `null` forever.
   With no active office ever sent, `applyShipmentAccessFilter` fails **open** (no header means no
   office filtering — that user saw every shipment company-wide) while `applyOfficeScopedAccessFilter`
   fails **closed** (zero quotes/opportunities, permanently, with no way to self-correct). **Fixed**
   by having both endpoints merge in every grant-derived office alongside direct assignments
   (marked `isDefault: false`, since "default" is only meaningful for a direct pick).
3. **The office backfill matched almost none of the real dataset.** Live counts before the fix:
   0/150 quotes and 5/33 opportunities got an `office_id`. Root cause: virtually none of this
   database's real user accounts have ever had a default office marked. Widened the migration to
   fall back to a user's *earliest* office assignment when no default exists (§4) — verified
   correct in isolation, but in this specific dataset it still doesn't move the needle much,
   because the two accounts that created nearly every historical quote/opportunity
   (`claudeagent@localhost`, `alex.mitroiu@gmail.com`) have **no office assignment of any kind**.
   That's a pre-existing data-completeness gap, not something a backfill heuristic can invent an
   answer for — assigning those accounts a real office (or accepting the `NULL` fallback) is a
   manual, deliberate choice left to whoever owns that data.

## 8. Known, accepted limitation (unchanged by the QA pass)

`canEditOfficeSide`/`resolveActiveOffice` (department-based edit-authority gate for EMO/IMO
reassignment, side-offices, Line Agent parties) still doesn't know about grants — a user can
*view* a shipment via a Branch/Country grant but gets a 403 trying to edit anything on it, since
that gate still does a direct-only `user_offices` lookup. This was a deliberate scope boundary
from the original design (§9) confirmed still real by the QA pass: a grant alone gives visibility,
not edit authority — a direct office assignment is still required for that. Not fixed here;
flagged for a follow-up if full working access via a grant alone turns out to matter in practice.

## 9. What deliberately didn't change

- No new Region entity — see §1.
- No consolidation of the other three independent office/scope-checking implementations found
  during design (`userOwnsLaneForShipment`/`Customer`'s trade-lane-only credit authority,
  `canEditOfficeSide`'s department-based edit gate, `routes/finance.js`'s `callerEntityScope`) —
  each serves a genuinely different question than "what offices can this user see," and folding
  them together was judged real scope creep, not a natural extension of this work. See §8 for the
  concrete limitation this leaves in place.
- No change to `recomputeSpaceBadge`, contract/allocation logic, or any shipment-domain
  calculation — this redesign is scoped to *visibility*, not to any of the app's consumption or
  financial math.
