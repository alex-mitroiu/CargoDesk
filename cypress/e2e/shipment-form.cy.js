/**
 * Shipment Creation Form Suite
 *
 * Covers the "+ New Shipment" flow end-to-end through the real UI
 * (src/pages/shipments/ShipmentFormPage.jsx) — previously zero Cypress coverage of any
 * kind touched this page. Drives the actual typeahead comboboxes (Shipper/Consignee/
 * Principal/Commodity/Port/Carrier) against real seeded data fetched via the API first,
 * rather than guessing fixture values or driving each combobox's picker-modal internals
 * (4 different modal shapes, more surface area to go stale) — same "fetch real backend
 * state, then drive the UI against it" precedent already used in schedule-leg-cascade.cy.js
 * and shipment-reorg.cy.js.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Shipment Creation Form Suite", () => {
  let tok, customer, commodity, createdShipmentId;

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  let scratchCustomerId;

  before(() => {
    // A fresh environment (npm run seed never populates customers, only commodities) may
    // have no customers at all — create a scratch one rather than assuming pre-existing data.
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; })
      .then(() => api("POST", "/customers", { companyName: "Cypress Form Test Customer Co" }))
      .then(res => {
        expect(res.status).to.eq(201);
        scratchCustomerId = res.body.id;
        customer = { id: res.body.id, companyName: "Cypress Form Test Customer Co" };
      })
      .then(() => api("GET", "/commodities?limit=1"))
      .then(res => { commodity = res.body.results[0]; });
  });

  after(() => {
    if (createdShipmentId) api("DELETE", `/shipments/${createdShipmentId}`);
    if (scratchCustomerId) api("DELETE", `/customers/${scratchCustomerId}`);
  });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/#shipments/new");
    cy.dismissStartupGates();
  });

  // Types a real, backend-fetched value into a CustomerCombobox/CommodityCombobox-style
  // typeahead field, then clicks its matching suggestion row — typing alone leaves the
  // field unresolved (no id), the app requires an actual pick from the dropdown.
  const fillCombobox = (label, query) => {
    cy.contains("label", label).parent().find("input").clear().type(query);
    cy.contains("button", query, { timeout: 8000 }).click();
  };

  it("creates a minimal valid SPOT shipment through the real form and lands on its detail page", () => {
    cy.contains("button", "Create Shipment", { timeout: 15000 }).should("be.visible");

    fillCombobox("Shipper", customer.companyName);
    fillCombobox("Consignee", customer.companyName);
    fillCombobox("Principal", customer.companyName);

    cy.contains("label", "Incoterm").parent().find("select").select("FOB");

    fillCombobox("Commodity", commodity.code);

    // The form seeds one blank SEA leg automatically — fill it in rather than adding a new one.
    cy.get('[id^="leg-row-"]').first().within(() => {
      cy.get('input[placeholder="Search From…"]').type("CNSHA");
    });
    cy.contains("button", "CNSHA", { timeout: 8000 }).click();
    cy.get('[id^="leg-row-"]').first().within(() => {
      cy.get('input[placeholder="Search To…"]').type("USNYC");
    });
    cy.contains("button", "USNYC", { timeout: 8000 }).click();
    cy.get('[id^="leg-row-"]').first().within(() => {
      cy.get('input[placeholder="Search carrier code or name…"]').type("MAEU");
    });
    cy.contains("button", "MAEU", { timeout: 8000 }).click();

    cy.contains("button", "Create Shipment").click();
    cy.contains("Shipment created", { timeout: 10000 }).should("be.visible");
    cy.url().should("match", /shipments\/SHP-/);

    cy.url().then(url => {
      createdShipmentId = url.match(/shipments\/(SHP-[A-Z0-9]+)/)[1];
    });
  });

  it("blocks creation and shows a validation toast when required fields are missing", () => {
    cy.contains("button", "Create Shipment", { timeout: 15000 }).click();
    cy.contains(/Missing required fields/i, { timeout: 8000 }).should("be.visible");
    cy.url().should("include", "shipments/new");
  });
});
