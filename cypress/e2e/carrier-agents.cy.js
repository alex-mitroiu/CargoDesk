/**
 * Carrier Agents Suite (Master Data > Carrier Agents)
 *
 * Covers the header + multi-location table-of-configuration UI, including the country-added
 * auto-discard-redundant-locations flow, the Working Schedule day-pill editor, and the
 * Capabilities checklist — none of which had any UI regression coverage before this spec
 * (only the API layer, tests/carrier-agents.test.js). A real gap found while writing this
 * suite: the feature had gone through several rounds of direct feedback (page-row controls ->
 * a locations modal -> back into one unified Add/Edit modal) with only ad-hoc, throwaway
 * Puppeteer scripts verifying each iteration — this is the first permanent regression net.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, ESBCN, ESVLC present in port_locations; ES, AD present in countries (seeded MDM data)
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Carrier Agents Suite", () => {
  let tok;
  let customerId, customerName;
  const carrierCode = "TSTZ";
  let headerId; // captured from the real POST response, not parsed out of a toast

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; })
      // CarrierCombobox has no server-side search — it filters client-side against the real
      // carriers registry (api.carriers.list()), so the fictional "TSTZ" code used throughout
      // this spec must actually exist there or its dropdown option never renders. The API-only
      // backend suite (tests/carrier-agents.test.js) doesn't hit this — carrier_code has no FK
      // there, so any string round-trips fine — but this spec drives the real picker UI.
      // failOnStatusCode:false means a leftover TSTZ from an earlier aborted run (already-exists)
      // is silently tolerated rather than failing this hook.
      .then(() => api("POST", "/carriers", { code: "TSTZ", name: "Cypress Test Carrier" }))
      .then(() => api("POST", "/customers", { companyName: `Cypress Iberia Agents ${Date.now()}` }))
      .then(res => { customerId = res.body.id; customerName = res.body.companyName; });
  });

  after(() => {
    if (headerId) api("DELETE", `/carrier-agents/${headerId}`);
    if (customerId) api("DELETE", `/customers/${customerId}`);
    api("DELETE", "/carriers/TSTZ");
  });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/#mdm-carrier-agents");
    cy.dismissStartupGates();
    cy.contains("h1", "Carrier Agents", { timeout: 15000 }).should("be.visible");
  });

  const fillCustomerAgent = () => {
    cy.contains("label", "Agent (Customer)").parent().find("input").clear().type(customerName);
    cy.contains("button", customerName, { timeout: 8000 }).click();
  };

  it("adds a carrier agent, configures multiple locations, and auto-discards redundant ports on a country add", () => {
    cy.contains("button", "＋ Add Carrier Agent").click();
    cy.contains("Add Carrier Agent", { timeout: 5000 }).should("be.visible");

    cy.get('input[placeholder="Search carrier code or name…"]').type(carrierCode);
    cy.contains("button", carrierCode, { timeout: 8000 }).click();
    fillCustomerAgent();

    // First location: ESBCN (UN/LOCODE is the default Coverage Type)
    cy.get('input[placeholder="Search UN/LOCODE…"]').type("ESBCN");
    cy.contains("button", "ESBCN", { timeout: 8000 }).click();
    cy.contains("button", "＋ Add to List").click();
    cy.contains("ESBCN").should("be.visible");

    // Second location: ESVLC
    cy.get('input[placeholder="Search UN/LOCODE…"]').type("ESVLC");
    cy.contains("button", "ESVLC", { timeout: 8000 }).click();
    cy.contains("button", "＋ Add to List").click();
    cy.contains("ESVLC").should("be.visible");

    // Capabilities tab
    cy.contains("button", "Capabilities").click();
    cy.contains("label", "Road Haulage").find('input[type="checkbox"]').check({ force: true });
    cy.contains("label", "Warehousing").find('input[type="checkbox"]').check({ force: true });

    // Notes tab
    cy.contains("button", "Notes").click();
    cy.get("textarea").type("Cypress: booking + B/L release desk");

    // Working Schedule (inside Coverage > sub-tab)
    cy.contains("button", "Coverage").click();
    cy.contains("button", "Working Schedule").click();
    cy.contains("button", "＋ Add Row").click();
    // Toggle Mon+Tue on the new row
    cy.get("button").contains(/^Mon$/).click();
    cy.get("button").contains(/^Tue$/).click();

    // Save — creates the header with the first staged location, then the rest, then the schedule
    cy.intercept("POST", "/api/carrier-agents").as("createAgent");
    cy.contains("button", "Add Carrier Agent").click();
    cy.wait("@createAgent").then(({ response }) => { headerId = response.body.id; });

    // Back on the list — the new row shows both locations as read-only badges
    cy.contains(carrierCode, { timeout: 10000 }).should("be.visible");
    cy.contains("ESBCN").should("be.visible");
    cy.contains("ESVLC").should("be.visible");

    // Now edit it and add the whole country of Spain — ESBCN/ESVLC are redundant under it and
    // should be auto-discarded, with an informational (not silently-dropped) notice.
    cy.contains(carrierCode).parents("[style*='grid-template-columns']").first()
      .find("button").last().click({ force: true }); // the row's own ActionMenu gear
    cy.contains("Edit", { timeout: 5000 }).click();
    cy.contains("Edit Carrier Agent", { timeout: 5000 }).should("be.visible");

    cy.contains("button", "Coverage").click();
    cy.contains("button", "Locations").click();
    cy.contains("label", "Coverage Type").parent().find("select").select("Whole Country");
    cy.get('input[placeholder="Search countries…"]').type("Spain");
    cy.contains("button", "Spain", { timeout: 8000 }).click();
    cy.contains("button", "＋ Add Location").click();

    cy.contains("Locations Automatically Updated", { timeout: 8000 }).should("be.visible");
    cy.contains("ESBCN").should("be.visible");
    cy.contains("ESVLC").should("be.visible");
    cy.contains("button", "Got it").click();

    // The now-redundant ports are gone from the table, only the country row remains
    cy.contains("🌐 ES").should("be.visible");
    cy.contains("button", "Save").click();
    cy.contains("Edit Carrier Agent").should("not.exist");

    // Confirmed on the list too
    cy.contains(carrierCode).parents("[style*='grid-template-columns']").first().within(() => {
      cy.contains("🌐 ES").should("be.visible");
      cy.contains("ESBCN").should("not.exist");
    });
  });

  it("rejects a second header from claiming an already-covered location for the same carrier", () => {
    // headerId (TSTZ / ES) was created by the previous test — this one proves the cross-header
    // conflict guard is real from the UI, not just at the API layer.
    api("POST", "/customers", { companyName: `Cypress Conflict Agent ${Date.now()}` })
      .then(res => {
        const conflictCustomerId = res.body.id;
        cy.contains("button", "＋ Add Carrier Agent").click();
        cy.get('input[placeholder="Search carrier code or name…"]').type(carrierCode);
        cy.contains("button", carrierCode, { timeout: 8000 }).click();
        cy.contains("label", "Agent (Customer)").parent().find("input").type(res.body.companyName);
        cy.contains("button", res.body.companyName, { timeout: 8000 }).click();
        cy.get('input[placeholder="Search UN/LOCODE…"]').type("ESBCN");
        cy.contains("button", "ESBCN", { timeout: 8000 }).click();
        cy.contains("button", "＋ Add to List").click();
        cy.contains("button", "Add Carrier Agent").click();
        cy.contains("already covered", { timeout: 8000 }).should("be.visible");
        cy.contains("button", "Cancel").click();
        api("DELETE", `/customers/${conflictCustomerId}`);
      });
  });
});
