/**
 * Shipment Detail Walkthrough Suite
 *
 * Covers the Conditions, Parties & Offices, Cargo, and Milestones & Events sub-pages of
 * the shipment detail view — previously untested beyond shipment-reorg.cy.js's narrow
 * sidebar-order/Documents/Tickets checks. This suite drives real content within each
 * section rather than just confirming the nav entries exist.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";
const CONTAINER_NUMBER = "CYDW1234567";

describe("Shipment Detail Walkthrough Suite", () => {
  let tok, shipmentId, containerId, customers;
  const createdCustomerIds = [];

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  before(() => {
    // A fresh environment (npm run seed never populates customers) may have fewer than 2 —
    // create scratch ones rather than assuming any pre-existing data.
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; })
      .then(() => api("POST", "/customers", { companyName: "Cypress Walkthrough Shipper Co" }))
      .then(res => {
        expect(res.status).to.eq(201);
        createdCustomerIds.push(res.body.id);
        return api("POST", "/customers", { companyName: "Cypress Walkthrough Consignee Co" });
      })
      .then(res => {
        expect(res.status).to.eq(201);
        createdCustomerIds.push(res.body.id);
        customers = [
          { id: createdCustomerIds[0], companyName: "Cypress Walkthrough Shipper Co" },
          { id: createdCustomerIds[1], companyName: "Cypress Walkthrough Consignee Co" },
        ];
      });
  });

  before(() => {
    // Party roles are derived from actual shipment usage (v0.60.0), not a stored flag —
    // CustomerCombobox's typeahead hard-filters by role (unlike the picker modal, which has
    // a bypass toggle), so a scratch customer with zero prior usage is invisible to it. Give
    // both scratch customers real usage from the start so the Parties & Offices edit test's
    // combobox search can actually find them.
    cy.request({
      method: "POST", url: "/api/shipments",
      headers: { Authorization: `Bearer ${tok}` },
      body: { pol: "CNSHA", pod: "USNYC", carrierCode: "CMDU",
              status: "Active", contractType: "SPOT", etd: "2026-10-01",
              shipperId: customers[0].id, shipperName: customers[0].companyName,
              consigneeId: customers[1].id, consigneeName: customers[1].companyName,
              principalId: customers[0].id, principalName: customers[0].companyName },
      failOnStatusCode: false,
    }).then(res => {
      expect(res.status).to.eq(201);
      shipmentId = res.body.id;
    });
  });

  before(() => {
    api("POST", "/containers", {
      shipmentId, size: "40", type: "GP", containerNumber: CONTAINER_NUMBER,
    }).then(res => { containerId = res.body.id; });
  });

  after(() => {
    if (containerId) api("DELETE", `/containers/${containerId}`);
    if (shipmentId)  api("DELETE", `/shipments/${shipmentId}`);
    createdCustomerIds.forEach(id => api("DELETE", `/customers/${id}`));
  });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}`; });
    cy.dismissStartupGates();
    cy.contains(shipmentId, { timeout: 15000 }).should("be.visible");
  });

  context("Conditions", () => {
    it("shows the shipment's contract type", () => {
      cy.get("nav").contains("Conditions").click();
      cy.get("#shpcond-page", { timeout: 8000 }).should("be.visible");
      cy.get("#shpcond-contract-type").should("contain.text", "SPOT");
    });
  });

  context("Parties & Offices", () => {
    it("edit flow sets Shipper/Consignee/Principal via the real combobox + Save", () => {
      cy.get("nav").contains("Parties & Offices").click();
      cy.get("#shpparties-panel", { timeout: 8000 }).should("be.visible");

      cy.get("#shpparties-edit-btn").click();
      cy.contains("h2", "Edit Parties", { timeout: 8000 }).should("be.visible");

      const setParty = (label, companyName) => {
        cy.contains("label", label).parent().find("input").clear().type(companyName);
        cy.contains("button", companyName, { timeout: 8000 }).click();
      };
      setParty("Shipper", customers[0].companyName);
      setParty("Consignee", customers[1].companyName);
      setParty("Principal", customers[0].companyName);

      cy.get("#shpparties-form-save-btn").click();
      cy.contains("h2", "Edit Parties").should("not.exist");

      cy.get("#shpparties-shipper").should("contain.text", customers[0].companyName);
      cy.get("#shpparties-consignee").should("contain.text", customers[1].companyName);
    });
  });

  context("Cargo", () => {
    it("shows the container in the tree with a TEU summary", () => {
      cy.get("nav").contains("Cargo").click();
      cy.get("#shpctr-summary", { timeout: 8000 }).should("be.visible")
        .and("contain.text", "1 container");
      cy.get(`#shpctr-${containerId}-row`).should("be.visible")
        .and("contain.text", CONTAINER_NUMBER);
    });
  });

  context("Milestones & Events", () => {
    it("shows Shipment Milestones and a per-container Container Events stepper", () => {
      cy.get("nav").contains("Milestones & Events").click();
      cy.contains("Shipment Milestones", { timeout: 8000 }).should("be.visible");
      cy.contains("Container Events").should("be.visible");
      cy.contains(CONTAINER_NUMBER).should("be.visible");
      cy.contains("Empty Pickup").should("be.visible");
      cy.contains("Empty Return").should("be.visible");
    });
  });
});
