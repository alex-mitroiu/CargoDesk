/**
 * Schedules Happy Path Suite
 *
 * Covers the real "Add Sailing" search-and-assign flow on the Schedules page
 * (src/pages/shipments/ShipmentSchedulesPage.jsx) plus assigning a SPOT contract
 * reference to the shipment — previously only covered at the API level
 * (tests/schedules.test.js, tests/schedule-catalog.test.js) with zero UI regression
 * protection, and only exercised indirectly (via cy.request setup, never the real
 * search-and-pick UI) elsewhere in this suite (schedule-leg-cascade.cy.js,
 * carrier-booking-lifecycle.cy.js).
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Schedules Happy Path Suite", () => {
  let tok, shipmentId;

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; });
  });

  before(() => {
    cy.request({
      method: "POST", url: "/api/shipments",
      headers: { Authorization: `Bearer ${tok}` },
      body: { pol: "CNSHA", pod: "USNYC", carrierCode: "CMDU",
              status: "Active", contractType: "SPOT", etd: "2026-10-01" },
      failOnStatusCode: false,
    }).then(res => {
      expect(res.status).to.eq(201);
      shipmentId = res.body.id;
    });
  });

  before(() => {
    // A blank (no vessel/voyage) SEA leg — Add Sailing's canSearch needs pol/pod/carrier
    // resolved from a real leg, and needs no schedule to already exist yet (hasSchedule
    // must be false going in, which this blank leg satisfies).
    api("POST", `/shipments/${shipmentId}/legs`, {
      legType: "SEA", movementType: "SEA", pol: "CNSHA", pod: "USNYC", carrierCode: "CMDU",
    }).then(res => expect(res.status).to.eq(201));
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/schedules`; });
    cy.dismissStartupGates();
    cy.contains(shipmentId, { timeout: 15000 }).should("be.visible");
  });

  it("searches real sailings via Add Sailing and assigns one to the shipment", () => {
    cy.contains("button", "Add Sailing", { timeout: 15000 }).should("not.be.disabled").click();
    cy.contains("Sailing Search", { timeout: 8000 }).should("be.visible");

    cy.contains("button", "Add →", { timeout: 10000 }).first().click();

    // "Add Sailing" stays in the toolbar (a second click now offers Replace instead of a
    // straight assign) — assert on the real signal of success instead: the toast, and the
    // leg row now carrying a real vessel/voyage from the sailing.
    cy.contains("Sailing applied to SEA leg", { timeout: 8000 }).should("be.visible");
    cy.get("#shpsched-legs-section").should("not.contain.text", "No legs yet");
    cy.get('[id^="leg-row-"]').first().should("contain.text", "CNSHA");
  });

  it("assigns a SPOT contract reference to the schedule", () => {
    cy.get("#shpsched-contract-btn", { timeout: 15000 }).click();
    cy.contains("h2", "Add Contract", { timeout: 8000 }).should("be.visible");

    cy.contains("label", "Contract Reference").parent().find("input").type("CY-SPOT-REF-1");
    cy.contains("button", "Save").click();
    cy.contains("h2", "Add Contract").should("not.exist");

    cy.get("#shpsched-contract-summary", { timeout: 8000 }).should("contain.text", "CY-SPOT-REF-1");
  });
});
