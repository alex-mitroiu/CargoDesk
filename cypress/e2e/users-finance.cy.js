/**
 * Users & Finance Gating Suite — v0.26.0 "Meridian II"
 *
 * Covers: user CRUD, the per-user canViewFinance flag introduced in v0.26.0,
 * and the finance endpoint access rules (admin always in, operator needs flag).
 *
 * Prerequisites:
 *   - npm run dev  (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Users & Finance Gating Suite", () => {
  let adminTok;
  let testUserId;
  let testUserTok;

  const FRESH_EMAIL    = `cypress-finance-${Date.now()}@test.local`;
  const FRESH_PASSWORD = "Cypress123!";

  const api = (method, path, body, token) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${token ?? adminTok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  before(() => {
    cy.request("POST", "/api/auth/login", {
      email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
    }).then(res => {
      expect(res.status).to.eq(200);
      adminTok = res.body.token;
    });
  });

  after(() => {
    if (testUserId) api("DELETE", `/users/${testUserId}`);
  });

  // ── User CRUD ───────────────────────────────────────────────────────────────

  context("User CRUD", () => {
    it("GET /api/users → 200, array with id, email, role, isActive", () => {
      api("GET", "/users").then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.be.an("array").with.length.greaterThan(0);
        const u = res.body[0];
        expect(u).to.have.property("id");
        expect(u).to.have.property("email");
        expect(u).to.have.property("role");
        expect(u).to.have.property("isActive");
      });
    });

    it("POST /api/users creates a new operator user → {ok:true}", () => {
      api("POST", "/users", {
        email: FRESH_EMAIL,
        name: "Cypress Finance Tester",
        role: "operator",
        password: FRESH_PASSWORD,
      }).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body.ok).to.eq(true);
      });
    });

    it("new user appears in GET /api/users list", () => {
      api("GET", "/users").then(res => {
        const found = res.body.find(u => u.email === FRESH_EMAIL);
        expect(found, "new user not in list").to.not.be.undefined;
        testUserId = found.id;
        expect(found.canViewFinance).to.eq(false); // off by default
      });
    });

    it("new user can log in with their password", () => {
      cy.request("POST", "/api/auth/login", {
        email: FRESH_EMAIL, password: FRESH_PASSWORD,
      }).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body.token).to.be.a("string");
        testUserTok = res.body.token;
        expect(res.body.user.canViewFinance).to.eq(false);
      });
    });

    it("PATCH /api/users/:id updates the user name", () => {
      api("PATCH", `/users/${testUserId}`, { name: "Updated Name" }).then(res => {
        expect(res.status).to.eq(200);
      });
    });
  });

  // ── Finance Gating ──────────────────────────────────────────────────────────

  context("Finance gating — per-user canViewFinance flag", () => {
    it("operator without flag: GET /api/margin/summary → 403", () => {
      // Token obtained above for the test user who has canViewFinance=false
      api("GET", "/margin/summary", undefined, testUserTok).then(res => {
        expect(res.status).to.eq(403);
      });
    });

    it("admin always has finance access regardless of flag → 200", () => {
      api("GET", "/margin/summary").then(res => {
        expect(res.status).to.eq(200);
      });
    });

    it("PATCH /api/users/:id with canViewFinance:true → 200", () => {
      api("PATCH", `/users/${testUserId}`, { canViewFinance: true }).then(res => {
        expect(res.status).to.eq(200);
      });
    });

    it("canViewFinance flag is reflected in GET /api/users list", () => {
      api("GET", "/users").then(res => {
        const u = res.body.find(x => x.id === testUserId);
        expect(u.canViewFinance).to.eq(true);
      });
    });

    it("operator with flag enabled: GET /api/margin/summary → 200 after re-login", () => {
      // Re-login to get a token that carries the updated flag
      cy.request("POST", "/api/auth/login", {
        email: FRESH_EMAIL, password: FRESH_PASSWORD,
      }).then(res => {
        expect(res.status).to.eq(200);
        const newTok = res.body.token;
        expect(res.body.user.canViewFinance).to.eq(true);
        return api("GET", "/margin/summary", undefined, newTok);
      }).then(res => {
        expect(res.status).to.eq(200);
      });
    });

    it("PATCH to toggle finance off restores 403 after re-login", () => {
      api("PATCH", `/users/${testUserId}`, { canViewFinance: false }).then(() => {
        return cy.request("POST", "/api/auth/login", {
          email: FRESH_EMAIL, password: FRESH_PASSWORD,
        });
      }).then(res => {
        const revokedTok = res.body.token;
        return api("GET", "/margin/summary", undefined, revokedTok);
      }).then(res => {
        expect(res.status).to.eq(403);
      });
    });
  });

  // ── data-testid Attributes ──────────────────────────────────────────────────

  context("data-testid attributes (UI smoke)", () => {
    // Must be beforeEach — Cypress clears localStorage between it() blocks, so a single
    // before() login won't persist past the first test. loginSession still caches the
    // real login once per spec file instead of once per test — routes/auth.js's per-IP
    // rate limiter (20/15min, no test-mode bypass) is otherwise exhausted well before a
    // full `npx cypress run` across every spec finishes.
    beforeEach(() => {
      cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
      cy.visit("/");
    });

    it("[data-testid=main-nav] is present in the sidebar", () => {
      cy.get("[data-testid=main-nav]").should("exist");
    });

    it("[data-testid=user-avatar-btn] is present in the header", () => {
      cy.get("[data-testid=user-avatar-btn]").should("exist");
    });

    it("[data-testid=license-modal] is not shown for returning users", () => {
      // loginAs pre-sets the license flag, so modal should not appear
      cy.get("[data-testid=license-modal]").should("not.exist");
    });
  });
});
