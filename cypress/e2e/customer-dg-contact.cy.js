/**
 * The shipper's dangerous goods emergency contact on the customer profile (2026-10-29, ARCHITECTURE.md §8.44;
 * approved mockup https://claude.ai/code/artifact/12f412e9-21fb-4f1d-b9f5-a9940db68c44, screen 5):
 *   - Customers → a customer → Profile: "Ships dangerous goods" reveals the contact, 24-hour phone, provider and
 *     reference; a name and a phone are needed together and the phone must be a number; Save stores all four;
 *     unticking clears it.
 *   - App Settings has no Compliance tab any more (the org-wide DG Compliance Address is retired).
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("The shipper's DG emergency contact", () => {
  let tok, customer;
  const stamp = Date.now();

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).then(res => { tok = res.body.token; });
  });
  before(() => {
    api("POST", "/customers", { companyName: `Van Wijk Coatings ${stamp} B.V.`, address1: "Vlaardingweg 62", city: "Rotterdam",
      postalCode: "3044 CK", countryIso2: "NL", phone: "+31 10 437 2200", email: "export@vanwijkcoatings.example" })
      .then(r => { expect(r.status, JSON.stringify(r.body)).to.eq(201); customer = r.body; });
  });
  after(() => { if (customer) api("DELETE", `/customers/${customer.id}`); });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.dismissStartupGates();
  });
  const goto = hash => {
    cy.window().then(win => { win.location.hash = hash; });
    cy.dismissStartupGates();
  };
  const openProfile = () => {
    goto("mdm-customers");
    cy.get('[data-testid="customers-search"]', { timeout: 15000 }).clear().type(`Van Wijk Coatings ${stamp}`);
    cy.get(`[data-testid="customers-row-${customer.id}"]`, { timeout: 15000 }).click();
    // Below the modal's scroll: present, not necessarily in view (actions scroll to it).
    cy.contains("button", /^Save Profile$/, { timeout: 10000 }).should("exist");
  };

  it("adds the contact on the Profile, checks it, saves all four fields, and clears it when unticked", () => {
    openProfile();
    cy.get("#cust-dg-contact").should("not.exist");
    cy.get('[data-testid="cust-dg-on"]').check();
    cy.get("#cust-dg-contact").type("Van Wijk DG Desk");
    cy.get('[data-testid="cust-dg-error"]').should("contain", "a name and a 24-hour phone number");
    cy.contains("button", /^Save Profile$/).should("be.disabled");
    cy.get("#cust-dg-phone").type("call the office");
    cy.get('[data-testid="cust-dg-error"]').should("contain", "must be a phone number");
    cy.get("#cust-dg-phone").clear().type("+31 10 437 2299");
    cy.get('[data-testid="cust-dg-error"]').should("not.exist");
    cy.get("#cust-dg-provider").type("CHEMTREC");
    cy.get("#cust-dg-reference").type("CCN-204417");
    cy.contains("button", /^Save Profile$/).should("not.be.disabled").click();
    cy.contains("Profile saved", { timeout: 10000 }).should("be.visible");
    api("GET", `/customers/${customer.id}`).then(r => {
      expect(r.body.dgEmergencyContact).to.deep.eq({ contact: "Van Wijk DG Desk", phone: "+31 10 437 2299", provider: "CHEMTREC", referenceNumber: "CCN-204417" });
    });

    // Reopened, it shows what's stored; unticked and saved, it's gone.
    cy.visit("/");
    cy.dismissStartupGates();
    openProfile();
    cy.get('[data-testid="cust-dg-on"]').should("be.checked");
    cy.get("#cust-dg-phone").should("have.value", "+31 10 437 2299");
    cy.get('[data-testid="cust-dg-on"]').uncheck();
    cy.contains("button", /^Save Profile$/).click();
    cy.contains("Profile saved", { timeout: 10000 }).should("be.visible");
    api("GET", `/customers/${customer.id}`).then(r => expect(r.body.dgEmergencyContact).to.eq(null));
  });

  it("App Settings no longer has a Compliance tab", () => {
    goto("settings");
    cy.contains("button", /^Finance$/, { timeout: 15000 }).should("be.visible");
    cy.contains("button", /^Compliance$/).should("not.exist");
    cy.contains("DG Compliance Address").should("not.exist");
  });
});
