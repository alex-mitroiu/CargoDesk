/**
 * Customs Filing Lifecycle Suite
 *
 * Covers the AES/EEI (Export) customs filing lifecycle through the real UI — Create →
 * Submit → simulated government Accept (via Test Tools' Filing Simulator, the only real
 * mechanism for an accept/reject response). Previously zero Cypress coverage of any kind
 * touched this page — the gap analysis flagged customs filing as having no UI coverage
 * at all.
 *
 * Tests run in file order and share one shipment's filing state across the suite — same
 * established pattern as schedule-leg-cascade.cy.js / carrier-booking-lifecycle.cy.js.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Customs Filing Lifecycle Suite", () => {
  let tok, shipmentId, containerId, customer;

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  let scratchCustomerId;

  before(() => {
    // A fresh environment (npm run seed never populates customers) may have none at all —
    // create a scratch one rather than assuming any pre-existing data.
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; })
      .then(() => api("POST", "/customers", { companyName: "Cypress Filing Test Broker Co" }))
      .then(res => {
        expect(res.status).to.eq(201);
        scratchCustomerId = res.body.id;
        customer = { id: res.body.id, companyName: "Cypress Filing Test Broker Co" };
      });
  });

  before(() => {
    cy.request({
      method: "POST", url: "/api/shipments",
      headers: { Authorization: `Bearer ${tok}` },
      body: { pol: "CNSHA", pod: "USNYC", carrierCode: "CMDU",
              status: "Active", contractType: "SPOT", etd: "2026-10-01",
              shipperName: "Cypress Filing Test Shipper Co", consigneeName: "Cypress Filing Test Consignee Co" },
      failOnStatusCode: false,
    }).then(res => {
      expect(res.status).to.eq(201);
      shipmentId = res.body.id;
    });
  });

  before(() => {
    // CustomsFilingGateModal requires a Customs Broker (Export or Import) party AND at
    // least one priced cargo line before the page unlocks at all.
    api("POST", `/shipments/${shipmentId}/parties`, {
      role: "Customs Broker (Export)", customerId: customer.id, customerName: customer.companyName,
    }).then(res => expect(res.status).to.eq(201));
  });

  before(() => {
    api("POST", "/containers", { shipmentId, size: "40", type: "GP" })
      .then(res => {
        containerId = res.body.id;
        return api("POST", `/shipments/${shipmentId}/containers/${containerId}/packages`, {
          description: "Cypress test cargo", quantity: 1, unitValue: 1000, currency: "USD",
        });
      }).then(res => expect(res.status).to.eq(201));
  });

  after(() => {
    if (containerId) api("DELETE", `/shipments/${shipmentId}/containers/${containerId}`);
    if (shipmentId)  api("DELETE", `/shipments/${shipmentId}`);
    if (scratchCustomerId) api("DELETE", `/customers/${scratchCustomerId}`);
  });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.dismissStartupGates();
  });

  const gotoFilingDetails = () => {
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/customs-filing/details`; });
    cy.dismissStartupGates();
    cy.contains(shipmentId, { timeout: 15000 }).should("be.visible");
  };

  const gotoFilingReview = () => {
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/customs-filing/review`; });
    cy.dismissStartupGates();
    cy.contains(shipmentId, { timeout: 15000 }).should("be.visible");
  };

  it("creates and submits an AES/EEI (Export) filing", () => {
    gotoFilingDetails();
    cy.get("#shpfiling-AES_EEI-card", { timeout: 15000 }).should("be.visible");
    cy.get("#shpfiling-AES_EEI-create-btn").click();
    cy.get("#shpfiling-AES_EEI-card").should("contain.text", "Draft");

    cy.get("#shpfiling-AES_EEI-submit-btn").click();
    cy.get("#shpfiling-AES_EEI-card").should("contain.text", "Filed");
  });

  it("Test Tools Filing Simulator accepts the filed AES/EEI filing", () => {
    cy.window().then(win => { win.location.hash = "test-tools"; });
    cy.dismissStartupGates();
    cy.contains("button", "Filing Simulator", { timeout: 15000 }).click();
    cy.contains("button", shipmentId, { timeout: 8000 }).click();
    cy.contains("label", "Confirmation number").next("input").type("CBP-CY-TEST-1");
    cy.contains("button", "Simulate Accepted").click();
    cy.contains(/simulated accepted/i, { timeout: 8000 }).should("be.visible");

    gotoFilingReview();
    cy.get("#shpfilingreview-AES_EEI-card", { timeout: 15000 }).should("be.visible");
    cy.get("#shpfilingreview-AES_EEI-card").should("contain.text", "CBP-CY-TEST-1");
  });
});
