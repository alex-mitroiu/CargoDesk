/**
 * API Smoke Suite — v0.27.0 "Lookout"
 *
 * One request per major endpoint group. No mutations. Verifies every
 * surface responds with 200 and the expected shape. Run this first as a
 * quick sanity check before the heavier CRUD suites.
 *
 * Prerequisites:
 *   - npm run dev  (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / admin
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "admin";

describe("API Smoke Suite", () => {
  let tok;

  const api = (method, path, body) =>
    cy.request({
      method,
      url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  // Helper: accept both plain array and paginated {results:[]} shapes
  const toArr = body => Array.isArray(body) ? body : (body.results ?? []);

  before(() => {
    cy.request("POST", "/api/auth/login", {
      email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
    }).then(res => {
      expect(res.status).to.eq(200);
      tok = res.body.token;
    });
  });

  // ── System ──────────────────────────────────────────────────────────────────

  context("System", () => {
    it("GET /api/health → 200, status:ok, semver version", () => {
      api("GET", "/health").then(res => {
        expect(res.status).to.eq(200);
        expect(res.body.status).to.eq("ok");
        expect(res.body.version).to.match(/^\d+\.\d+\.\d+$/);
      });
    });

    it("GET /api/settings → 200, flat key-value object", () => {
      api("GET", "/settings").then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.be.an("object");
      });
    });

    it("GET /api/system-messages → 200, array", () => {
      api("GET", "/system-messages").then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.be.an("array");
      });
    });
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  context("Auth", () => {
    it("GET /api/auth/me → 200, returns id, email, role", () => {
      api("GET", "/auth/me").then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.have.property("id");
        expect(res.body).to.have.property("email");
        expect(res.body).to.have.property("role");
      });
    });

    it("protected endpoint without token → 401", () => {
      cy.request({ method: "GET", url: "/api/shipments", failOnStatusCode: false }).then(res => {
        expect(res.status).to.eq(401);
      });
    });

    it("GET /api/users → does not expose password_hash", () => {
      api("GET", "/users").then(res => {
        expect(res.status).to.eq(200);
        toArr(res.body).forEach(u => expect(u).to.not.have.property("password_hash"));
      });
    });
  });

  // ── Shipments ───────────────────────────────────────────────────────────────

  context("Shipments", () => {
    it("GET /api/shipments → 200, array with required keys", () => {
      api("GET", "/shipments").then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.be.an("array");
        if (res.body.length > 0) {
          ["id", "pol", "pod", "carrierCode", "status", "contractType", "createdAt"].forEach(k =>
            expect(res.body[0]).to.have.property(k)
          );
        }
      });
    });

    it("GET /api/shipments/DOESNOTEXIST → 404", () => {
      api("GET", "/shipments/DOESNOTEXIST-SMOKE").then(res => {
        expect(res.status).to.eq(404);
      });
    });
  });

  // ── MDM ─────────────────────────────────────────────────────────────────────

  context("MDM", () => {
    it("GET /api/carriers → non-empty array with code", () => {
      api("GET", "/carriers").then(res => {
        expect(res.status).to.eq(200);
        const arr = toArr(res.body);
        expect(arr).to.be.an("array").with.length.greaterThan(0);
        expect(arr[0]).to.have.property("code");
      });
    });

    it("GET /api/port-locations?limit=5 → paginated {results, total}", () => {
      api("GET", "/port-locations?limit=5").then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.have.property("results");
        expect(res.body.results).to.be.an("array");
        expect(res.body).to.have.property("total");
      });
    });

    it("GET /api/trade-lanes → all lanes have transitDays > 0", () => {
      api("GET", "/trade-lanes").then(res => {
        expect(res.status).to.eq(200);
        const arr = toArr(res.body);
        expect(arr).to.be.an("array").with.length.greaterThan(0);
        arr.forEach(l => expect(l.transitDays, `lane ${l.code}`).to.be.greaterThan(0));
      });
    });

    it("GET /api/countries → items have portCount", () => {
      api("GET", "/countries").then(res => {
        expect(res.status).to.eq(200);
        const arr = toArr(res.body);
        expect(arr).to.be.an("array").with.length.greaterThan(0);
        expect(arr[0]).to.have.property("portCount");
      });
    });

    it("GET /api/commodities → items have code", () => {
      api("GET", "/commodities").then(res => {
        expect(res.status).to.eq(200);
        const arr = toArr(res.body);
        expect(arr).to.be.an("array").with.length.greaterThan(0);
        expect(arr[0]).to.have.property("code");
      });
    });

    it("GET /api/contracts → 200, non-empty list", () => {
      api("GET", "/contracts").then(res => {
        expect(res.status).to.eq(200);
        const arr = toArr(res.body);
        expect(arr).to.be.an("array");
      });
    });

    it("GET /api/customers → 200, list", () => {
      api("GET", "/customers").then(res => {
        expect(res.status).to.eq(200);
        const arr = toArr(res.body);
        expect(arr).to.be.an("array");
      });
    });
  });

  // ── Kanban ──────────────────────────────────────────────────────────────────

  context("Kanban", () => {
    it("GET /api/tickets → 200, array", () => {
      api("GET", "/tickets").then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.be.an("array");
      });
    });
  });

  // ── AI & Finance ────────────────────────────────────────────────────────────

  context("AI & Finance", () => {
    it("GET /api/ai/settings → 200, hasKey without exposing key value", () => {
      api("GET", "/ai/settings").then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.have.property("enabled");
        expect(res.body).to.have.property("hasKey");
        expect(res.body).to.not.have.property("apiKey");
      });
    });

    it("GET /api/margin/summary (admin) → 200", () => {
      api("GET", "/margin/summary").then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.have.property("totalBuyUsd");
      });
    });

    it("GET /api/margin/summary without token → 401", () => {
      cy.request({ method: "GET", url: "/api/margin/summary", failOnStatusCode: false }).then(res => {
        expect(res.status).to.eq(401);
      });
    });
  });

  // ── Exports ─────────────────────────────────────────────────────────────────

  context("Exports", () => {
    it("GET /api/export/shipments.csv → 200, Content-Type: text/csv, non-empty body", () => {
      cy.request({
        method: "GET", url: "/api/export/shipments.csv",
        headers: { Authorization: `Bearer ${tok}` },
        encoding: "binary", failOnStatusCode: false,
      }).then(res => {
        expect(res.status).to.eq(200);
        expect(res.headers["content-type"]).to.include("text/csv");
        expect(res.body.length).to.be.greaterThan(0);
      });
    });
  });
});
