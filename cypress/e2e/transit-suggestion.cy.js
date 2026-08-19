/**
 * Transit-suggestion — Cypress API tests
 *
 * Converted from tests/transit-suggestion.test.js.
 * Uses cy.request() for all API calls — no UI interaction.
 *
 * Prerequisites:
 *   - npm run dev  (Vite :5173 + Express :3001)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *
 * Fixtures (seeded by `npm run seed` — scripts/import-mdm-data.js's COUNTRY_LANE_DEFAULTS):
 *   CNAPP  →  FE lane  (28d transit)
 *   CNAQG  →  FE lane  (28d transit)
 *   SADMM  →  ME lane  (18d transit)
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";
const TEST_LANE_CODE = "TSTLN";

// Shared auth token — set once in before(), reused across all it() blocks.
let authToken;

const api = (method, path, body) =>
  cy.request({
    method,
    url: `/api${path}`,
    headers: { Authorization: `Bearer ${authToken}` },
    failOnStatusCode: false,
    ...(body !== undefined && { body }),
  });

// ─── Auth ─────────────────────────────────────────────────────────────────────

before(() => {
  cy.request("POST", "/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  }).then(res => {
    expect(res.status).to.eq(200);
    authToken = res.body.token;
  });
});

// ─── GET /api/trade-lanes/transit-suggestion ──────────────────────────────────

describe("GET /api/trade-lanes/transit-suggestion", () => {

  // Restore FE transit_days unconditionally after the suite — ensures the zeroing
  // test can never corrupt state for subsequent runs even if an assertion throws.
  after(() => {
    api("PUT", "/trade-lanes/FE", { name: "Far East", description: "", transitDays: 28 });
  });

  it("returns { days: null, lane: null } when no query params are given", () => {
    api("GET", "/trade-lanes/transit-suggestion").then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.days).to.be.null;
      expect(res.body.lane).to.be.null;
    });
  });

  it("returns { days: null, lane: null } when only pol is given", () => {
    api("GET", "/trade-lanes/transit-suggestion?pol=CNAPP").then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.days).to.be.null;
      expect(res.body.lane).to.be.null;
    });
  });

  it("returns days and lane when POL and POD are in the same trade lane (FE, 28d)", () => {
    api("GET", "/trade-lanes/transit-suggestion?pol=CNAPP&pod=CNAQG").then(res => {
      expect(res.body.days).to.eq(28);
      expect(res.body.lane).to.eq("FE");
    });
  });

  it("returns days: null and a cross-lane string when POL and POD are in different lanes", () => {
    api("GET", "/trade-lanes/transit-suggestion?pol=CNAPP&pod=SADMM").then(res => {
      expect(res.body.days).to.be.null;
      expect(res.body.lane).to.be.a("string").and.include("→");
    });
  });

  it("returns days: null when the trade lane has transit_days = 0 (no suggestion without config)", () => {
    // Zero out FE transit days for the duration of this test.
    // The after() hook in this describe block unconditionally restores FE to 28d,
    // so this chain does not need a cleanup step of its own.
    api("PUT", "/trade-lanes/FE", { name: "Far East", description: "", transitDays: 0 })
      .then(() => api("GET", "/trade-lanes/transit-suggestion?pol=CNAPP&pod=CNAQG"))
      .then(res => {
        expect(res.status).to.eq(200);
        expect(res.body.days).to.be.null;
        expect(res.body.lane).to.eq("FE");
      });
  });

  it("returns days: null for a UNLOCODE that has no trade lane mapping", () => {
    api("GET", "/trade-lanes/transit-suggestion?pol=ZZZZ&pod=CNAQG").then(res => {
      expect(res.body.days).to.be.null;
      // lane is null or a partial "→ X" string — either is acceptable
      expect(res.body.lane === null || typeof res.body.lane === "string").to.be.true;
    });
  });

});

// ─── Trade-lanes CRUD with transit_days ───────────────────────────────────────

describe("Trade-lanes CRUD — transitDays field", () => {

  before(() => {
    // Remove any leftover test lane from a previous run
    api("DELETE", `/trade-lanes/${TEST_LANE_CODE}`);
  });

  after(() => {
    // Safety cleanup in case a mid-suite failure leaves the lane behind
    api("DELETE", `/trade-lanes/${TEST_LANE_CODE}`);
  });

  it("POST creates a trade lane with transitDays and returns it in the response", () => {
    api("POST", "/trade-lanes", {
      code: TEST_LANE_CODE, name: "Test Lane", description: "For tests", transitDays: 21,
    }).then(res => {
      expect(res.status).to.eq(201);
      expect(res.body.transitDays).to.eq(21);
    });
  });

  it("GET /api/trade-lanes includes transitDays for the newly created lane", () => {
    api("GET", "/trade-lanes").then(res => {
      const lane = res.body.find(l => l.code === TEST_LANE_CODE);
      expect(lane).to.exist;
      expect(lane.transitDays).to.eq(21);
    });
  });

  it("PUT updates transitDays and returns the new value", () => {
    api("PUT", `/trade-lanes/${TEST_LANE_CODE}`, {
      name: "Test Lane Updated", description: "", transitDays: 35,
    }).then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.transitDays).to.eq(35);
    });
  });

  it("GET /api/trade-lanes reflects the updated transitDays", () => {
    api("GET", "/trade-lanes").then(res => {
      const lane = res.body.find(l => l.code === TEST_LANE_CODE);
      expect(lane.transitDays).to.eq(35);
    });
  });

  it("PUT with transitDays = 0 stores 0 explicitly (not coerced to null)", () => {
    api("PUT", `/trade-lanes/${TEST_LANE_CODE}`, {
      name: "Test Lane", description: "", transitDays: 0,
    }).then(() => api("GET", "/trade-lanes"))
      .then(res => {
        const lane = res.body.find(l => l.code === TEST_LANE_CODE);
        expect(lane.transitDays).to.eq(0);
      });
  });

  it("DELETE removes the lane and it no longer appears in GET /api/trade-lanes", () => {
    api("DELETE", `/trade-lanes/${TEST_LANE_CODE}`).then(res => {
      expect(res.status).to.eq(200);
    });
    api("GET", "/trade-lanes").then(res => {
      expect(res.body.find(l => l.code === TEST_LANE_CODE)).to.be.undefined;
    });
  });

});

// ─── ETA date arithmetic (client-side formula) ────────────────────────────────

describe("ETA suggestion — date arithmetic", () => {

  it("ETD + transit_days uses calendar days, not business days (mid-month)", () => {
    const etd = new Date("2026-07-05T00:00:00Z");
    etd.setUTCDate(etd.getUTCDate() + 28);
    expect(etd.toISOString().slice(0, 10)).to.equal("2026-08-02");
  });

  it("ETD + transit_days handles a month-end boundary correctly", () => {
    const etd = new Date("2026-01-14T00:00:00Z");
    etd.setUTCDate(etd.getUTCDate() + 28);
    expect(etd.toISOString().slice(0, 10)).to.equal("2026-02-11");
  });

});
