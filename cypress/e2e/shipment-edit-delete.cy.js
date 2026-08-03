/**
 * Shipment Edit + Delete Suite
 *
 * Only Create was ever covered by a real-UI Cypress test — editing an existing shipment
 * through the actual form (not just PUT via the API) and the list page's Delete confirmation
 * modal both had zero coverage.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Shipment Edit + Delete Suite", () => {
  let tok;
  const createdShipmentIds = [];

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

  const createdCustomerIds = [];

  after(() => {
    // The delete test's own shipment removes itself as part of the flow being tested —
    // only clean up the edit test's shipment here.
    createdShipmentIds.forEach(id => api("DELETE", `/shipments/${id}`));
    createdCustomerIds.forEach(id => api("DELETE", `/customers/${id}`));
  });

  describe("Edit — real form round-trip", () => {
    let shipmentId;

    before(() => {
      // The Edit form's own client-side validation requires Incoterm, Commodity, and all three
      // parties (Shipper/Consignee/Principal) before Save Changes will do anything at all —
      // a shipment created with only the bare minimum (as most other specs in this suite do,
      // since they never touch the Edit form) would have Save silently no-op. Populate those
      // up front so this test exercises the Booking Reference round-trip specifically, not a
      // pre-existing validation gate unrelated to what it's actually checking.
      cy.then(() => api("POST", "/customers", { companyName: "Cypress Edit Test Customer Co" }))
        .then(res => {
          expect(res.status).to.eq(201);
          const custId = res.body.id;
          createdCustomerIds.push(custId);
          return api("POST", "/shipments", {
            pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
            incoterm: "FOB", commodityCode: "9999",
            shipperId: custId, shipperName: "Cypress Edit Test Customer Co",
            consigneeId: custId, consigneeName: "Cypress Edit Test Customer Co",
            principalId: custId, principalName: "Cypress Edit Test Customer Co",
          });
        }).then(res => {
          expect(res.status).to.eq(201);
          shipmentId = res.body.id;
          createdShipmentIds.push(shipmentId);
        });
    });

    it("changes the Booking Reference through the real Edit form and it persists", () => {
      visitHash(`shipments/${shipmentId}/edit`);
      cy.contains("h1", `Edit — ${shipmentId}`, { timeout: 20000 }).should("be.visible");

      cy.get('input[placeholder="BK-2025-00123"]').clear().type("BK-CYPRESS-EDIT-1");
      cy.contains("button", "Save Changes").click();

      cy.contains("Shipment updated", { timeout: 10000 }).should("be.visible");
      // Save navigates back to the shipment's own detail page.
      cy.location("hash", { timeout: 10000 }).should("eq", `#shipments/${shipmentId}`);
      cy.contains("h1", "Edit —").should("not.exist");

      cy.then(() => api("GET", `/shipments/${shipmentId}`)).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body.bookingRef).to.eq("BK-CYPRESS-EDIT-1");
      });
    });

    it("reopening Edit shows the persisted value, not the original", () => {
      visitHash(`shipments/${shipmentId}/edit`);
      cy.get('input[placeholder="BK-2025-00123"]').should("have.value", "BK-CYPRESS-EDIT-1");
    });
  });

  describe("Delete — list page confirmation modal", () => {
    let shipmentId;

    before(() => {
      cy.then(() => api("POST", "/shipments", {
        pol: "DEHAM", pod: "SGSIN", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      })).then(res => {
        expect(res.status).to.eq(201);
        shipmentId = res.body.id;
      });
    });

    const openRowMenu = () => {
      visitHash("shipments");
      cy.contains("h1", "Shipments", { timeout: 20000 }).should("be.visible");
      cy.get('input[placeholder="Search ID, POL, POD, booking ref…"]').type(shipmentId);
      cy.contains("span", shipmentId, { timeout: 10000 }).should("be.visible")
        .parent().within(() => {
          cy.get("button").last().click(); // ActionMenu's gear trigger — last button in the row
        });
    };

    it("Cancel on the confirm modal leaves the shipment untouched", () => {
      openRowMenu();
      cy.contains("button", "Delete").click();
      cy.contains("h2", "Confirm", { timeout: 8000 }).should("be.visible");
      cy.contains(`Remove shipment ${shipmentId}`).should("be.visible");
      cy.contains("button", "Cancel").click();
      cy.contains("h2", "Confirm").should("not.exist");

      cy.then(() => api("GET", `/shipments/${shipmentId}`)).then(res => {
        expect(res.status).to.eq(200); // still exists
      });
    });

    it("Confirm Delete removes the shipment and it disappears from the list", () => {
      openRowMenu();
      cy.contains("button", "Delete").click();
      cy.contains("h2", "Confirm", { timeout: 8000 }).should("be.visible");
      cy.contains("button", "Confirm Delete").click();

      cy.contains("Shipment deleted", { timeout: 10000 }).should("be.visible");
      cy.contains("span", shipmentId).should("not.exist");

      cy.then(() => api("GET", `/shipments/${shipmentId}`)).then(res => {
        expect(res.status).to.eq(404);
      });
    });
  });
});
