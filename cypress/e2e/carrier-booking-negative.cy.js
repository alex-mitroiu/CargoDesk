/**
 * Carrier Booking — Negative / Gated Paths Suite
 *
 * Complements carrier-booking-lifecycle.cy.js, which only covers the happy path
 * (Send → Confirm → Link B/L). Covers the prerequisite gate (CarrierBookingGateModal,
 * blocks the whole page until a contract + schedule both exist), Cancel Booking, and a
 * simulated Rejected carrier response — none of which had any Cypress coverage before.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Carrier Booking — Negative / Gated Paths Suite", () => {
  let tok;

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  const visitHash = hash => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.window().then(win => { win.location.hash = hash; });
    cy.contains("Connecting to database", { timeout: 60000 }).should("not.exist");
    cy.dismissStartupGates();
  };

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; });
  });

  describe("Gate modal — no contract or schedule yet", () => {
    let shipmentId;

    before(() => {
      cy.then(() => api("POST", "/shipments", {
        pol: "DEHAM", pod: "SGSIN", carrierCode: "MAEU", status: "Active", contractType: "Pending",
      })).then(res => {
        expect(res.status).to.eq(201);
        shipmentId = res.body.id;
      });
    });

    after(() => { if (shipmentId) api("DELETE", `/shipments/${shipmentId}`); });

    it("blocks the whole Carrier Booking page and offers a single way out", () => {
      visitHash(`shipments/${shipmentId}/booking/details`);

      cy.contains("h2", "Carrier Booking Unavailable", { timeout: 20000 }).should("be.visible");
      cy.contains("doesn't have a contract or a schedule assigned yet").should("be.visible");
      // No close button, no backdrop dismiss (hideClose) — only the one way out below.
      // Modal.jsx: the × button, when rendered at all, is a sibling of <h2> inside their shared
      // header div — .find() only matches descendants, never the sibling elements themselves, so
      // scope from .parent() (the header div) instead of .siblings() to actually catch it if the
      // gate modal ever stopped passing hideClose.
      cy.contains("h2", "Carrier Booking Unavailable").parent().find("button").should("not.exist");

      cy.contains("button", "Go to Contracts & Schedules").click();
      cy.location("hash", { timeout: 10000 }).should("include", "/schedules");
      cy.contains("h2", "Carrier Booking Unavailable").should("not.exist");
    });
  });

  describe("Cancel Booking and a simulated Rejected response", () => {
    let shipmentId;

    before(() => {
      cy.then(() => api("POST", "/shipments", {
        pol: "CNSHA", pod: "USNYC", carrierCode: "MAEU", status: "Active",
        contractType: "SPOT", contractRef: "CY-NEG-REF", etd: "2026-10-01",
      })).then(res => {
        expect(res.status).to.eq(201);
        shipmentId = res.body.id;
        return api("POST", `/shipments/${shipmentId}/legs`, {
          legType: "SEA", movementType: "SEA", pol: "CNSHA", pod: "USNYC",
          etd: "2026-10-01", eta: "2026-10-25", carrierCode: "MAEU",
          vessel: "DEMO NEGATIVE", vesselImo: "9888888", voyage: "DM777W",
        });
      }).then(res => {
        expect(res.status).to.eq(201);
        return api("POST", `/shipments/${shipmentId}/schedules`, {
          carrier: "MAEU", vesselName: "DEMO NEGATIVE", voyageNumber: "DM777W",
          pol: "CNSHA", pod: "USNYC", etd: "2026-10-01", eta: "2026-10-25",
        });
      }).then(res => expect(res.status).to.eq(201));
    });

    after(() => { if (shipmentId) api("DELETE", `/shipments/${shipmentId}`); });

    it("sends the booking request", () => {
      visitHash(`shipments/${shipmentId}/booking/details`);
      cy.contains("button", "Send Booking Request", { timeout: 20000 }).click();
      cy.contains("Pending", { timeout: 8000 }).should("be.visible");
    });

    it("cancels the pending booking", () => {
      visitHash(`shipments/${shipmentId}/booking/review`);
      cy.contains("button", "Cancel Booking", { timeout: 20000 }).should("not.be.disabled").click();
      cy.contains("h2", "Cancel Booking", { timeout: 8000 }).should("be.visible")
        .parent().parent().within(() => {
          cy.contains("button", "Cancel Booking").click();
        });
      cy.contains("Booking cancelled", { timeout: 10000 }).should("be.visible");
      cy.contains("h2", "Cancel Booking").should("not.exist");

      cy.then(() => api("GET", `/shipments/${shipmentId}/carrier-booking`)).then(res => {
        expect(res.body.status).to.eq("Cancelled");
      });
    });

    it("Cancel Booking is no longer offered once already cancelled", () => {
      visitHash(`shipments/${shipmentId}/booking/review`);
      cy.contains("button", "Cancel Booking", { timeout: 20000 }).should("be.disabled");
    });

    it("a re-sent booking under the same carrier can be simulated Rejected", () => {
      visitHash(`shipments/${shipmentId}/booking/details`);
      // Same-carrier re-send after a cancel persists/reactivates the flow rather than
      // requiring a brand-new schedule — send again to get a fresh Pending booking to reject.
      cy.contains("button", "Send Booking Request", { timeout: 20000 }).click();
      cy.contains("Pending", { timeout: 8000 }).should("be.visible");

      visitHash("test-tools");
      cy.contains("Simulate a carrier response", { timeout: 15000 }).should("be.visible");
      cy.contains("button", shipmentId, { timeout: 8000 }).click();
      cy.contains("button", "Simulate Rejected").click();
      cy.contains("Simulated rejected response", { timeout: 8000 }).should("be.visible");

      cy.then(() => api("GET", `/shipments/${shipmentId}/carrier-booking`)).then(res => {
        expect(res.body.status).to.eq("Rejected");
      });
    });
  });
});
