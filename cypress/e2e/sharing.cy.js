/**
 * Share Token & Customer Tracking Suite — v0.26.0 "Meridian II"
 *
 * Covers: POST /api/shipments/:id/share-token, GET /api/share/:token,
 * tamper detection, expiry, and data-safety (no cost lines in public response).
 *
 * Prerequisites:
 *   - npm run dev  (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - Server restarted after routes/share.js was added
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Share Token & Customer Tracking Suite", () => {
  let tok;
  let shipmentId;
  let shareToken;
  let shareUrl;

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  before(() => {
    cy.request("POST", "/api/auth/login", {
      email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
    }).then(res => {
      tok = res.body.token;
      // Create a shipment to share
      return cy.request({
        method: "POST", url: "/api/shipments",
        headers: { Authorization: `Bearer ${tok}` },
        body: {
          pol: "CNSHA", pod: "USNYC", carrierCode: "CMDU",
          status: "Active", contractType: "SPOT", etd: "2026-09-01",
          bookingRef: "BKG-CYPRESS-SHARE", shipperName: "Cypress Shipper",
        },
        failOnStatusCode: false,
      });
    }).then(res => {
      expect(res.status).to.eq(201);
      shipmentId = res.body.id;
    });
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  // ── Token Generation ────────────────────────────────────────────────────────

  context("Token generation", () => {
    it("POST /api/shipments/:id/share-token → 200 with token, url, expiresAt", () => {
      api("POST", `/shipments/${shipmentId}/share-token`).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.have.property("token");
        expect(res.body).to.have.property("url");
        expect(res.body).to.have.property("expiresAt");
        shareToken = res.body.token;
        shareUrl   = res.body.url;
      });
    });

    it("token is a non-empty string", () => {
      expect(shareToken).to.be.a("string").and.not.be.empty;
    });

    it("url contains /#track/ prefix", () => {
      expect(shareUrl).to.include("/#track/");
    });

    it("expiresAt is ~30 days from now", () => {
      const exp  = new Date(shareUrl ? "2099" : "2099"); // placeholder
      api("POST", `/shipments/${shipmentId}/share-token`).then(res => {
        const expiry = new Date(res.body.expiresAt);
        const now    = Date.now();
        const delta  = expiry.getTime() - now;
        const days   = delta / (1000 * 60 * 60 * 24);
        expect(days).to.be.greaterThan(29);
        expect(days).to.be.lessThan(31);
      });
    });

    it("POST for non-existent shipment → 404", () => {
      api("POST", "/shipments/SHP-DOESNOTEXIST/share-token").then(res => {
        expect(res.status).to.eq(404);
      });
    });

    it("POST without auth → 401", () => {
      cy.request({
        method: "POST",
        url: `/api/shipments/${shipmentId}/share-token`,
        failOnStatusCode: false,
      }).then(res => {
        expect(res.status).to.eq(401);
      });
    });
  });

  // ── Public Tracking Endpoint ────────────────────────────────────────────────

  context("Public tracking endpoint — valid token", () => {
    it("GET /api/share/:token → 200 with shipment data", () => {
      api("POST", `/shipments/${shipmentId}/share-token`).then(genRes => {
        const token = genRes.body.token;
        return cy.request({
          method: "GET", url: `/api/share/${token}`,
          failOnStatusCode: false,
        });
      }).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body.id).to.eq(shipmentId);
        expect(res.body.pol).to.eq("CNSHA");
        expect(res.body.pod).to.eq("USNYC");
        expect(res.body.status).to.eq("Active");
      });
    });

    it("response includes legs, containers, milestones arrays", () => {
      api("POST", `/shipments/${shipmentId}/share-token`).then(genRes => {
        return cy.request({
          method: "GET", url: `/api/share/${genRes.body.token}`,
          failOnStatusCode: false,
        });
      }).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body.legs).to.be.an("array");
        expect(res.body.containers).to.be.an("array");
        expect(res.body.milestones).to.be.an("array");
      });
    });

    it("response does NOT include cost line data (data safety)", () => {
      api("POST", `/shipments/${shipmentId}/share-token`).then(genRes => {
        return cy.request({
          method: "GET", url: `/api/share/${genRes.body.token}`,
          failOnStatusCode: false,
        });
      }).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.not.have.property("costLines");
        expect(res.body).to.not.have.property("marginBuyUsd");
        expect(res.body).to.not.have.property("marginSellUsd");
      });
    });

    it("response does NOT require an Authorization header", () => {
      // Confirm the endpoint is truly public
      api("POST", `/shipments/${shipmentId}/share-token`).then(genRes => {
        return cy.request({
          method: "GET", url: `/api/share/${genRes.body.token}`,
          // No Authorization header
          failOnStatusCode: false,
        });
      }).then(res => {
        expect(res.status).to.eq(200);
      });
    });
  });

  // ── Security ─────────────────────────────────────────────────────────────────

  context("Security — tamper detection and invalid tokens", () => {
    it("GET /api/share/ with tampered token → 400", () => {
      api("POST", `/shipments/${shipmentId}/share-token`).then(genRes => {
        const parts  = genRes.body.token.split(".");
        // Corrupt the payload segment
        const bad    = parts[0] + "TAMPERED." + parts[1];
        return cy.request({
          method: "GET", url: `/api/share/${bad}`,
          failOnStatusCode: false,
        });
      }).then(res => {
        expect(res.status).to.eq(400);
      });
    });

    it("GET /api/share/ with random garbage → 400", () => {
      cy.request({
        method: "GET", url: "/api/share/notavalidtokenatall",
        failOnStatusCode: false,
      }).then(res => {
        expect(res.status).to.eq(400);
      });
    });

    it("GET /api/share/ with empty segment → 400 or 404", () => {
      cy.request({
        method: "GET", url: "/api/share/",
        failOnStatusCode: false,
      }).then(res => {
        expect(res.status).to.be.oneOf([400, 404]);
      });
    });
  });
});
