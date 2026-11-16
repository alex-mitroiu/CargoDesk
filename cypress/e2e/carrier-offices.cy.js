/**
 * Carrier Offices Suite (Master Data → Carriers → a carrier; a shipment's Contracts & Schedules) — ARCHITECTURE.md §8.53
 *
 * The carrier profile replaced the Carrier Agents page (2026-11-16): offices of the carrier located at any UN/LOCODE,
 * coverage per port or country × direction × role, our account numbers per legal entity; a shipment shows its four
 * carrier offices and the export side picks another office on the tile. The API rules are in
 * tests/carrier-offices.test.js; this drives the screens.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - ESBCN, USNYC in port_locations; ES, US in countries (seeded MDM data)
 *
 * The carrier, its offices and coverage are removed afterwards (lookup rows: they would give other shipments offices).
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Carrier Offices Suite", () => {
  let tok;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  const carrierCode = `QC${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;
  const madridName = `Hapag-Lloyd Spain Madrid ${rand}`;
  let barcelonaId, shipmentId, branchId;
  const created = { offices: [], coverage: [], customers: [] };

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; })
      // The Carriers page lists the registry, so the scratch carrier must exist there.
      .then(() => api("POST", "/carriers", { code: carrierCode, name: `Cypress Carrier ${rand}` }))
      // A second office made through the API: the coverage and shipment steps pick between the two.
      .then(() => api("POST", `/carriers/${carrierCode}/offices`, { name: `Hapag-Lloyd Spain Barcelona ${rand}`, unlocode: "ESBCN", city: "Barcelona",
        countryIso2: "ES", creditorCode: "400128" }))
      .then(res => { barcelonaId = res.body.id; created.offices.push(res.body.id); })
      // Our Spanish legal entity, for the account number (a CI database starts with none).
      .then(() => api("POST", "/branches", { code: `CYB${rand}`, name: `CargoDesk Logistica Barcelona ${rand} SL`, countryCode: "ES", city: "Barcelona",
        address: "Moll de Barcelona 21", locode: "ESBCN", currency: "EUR" }))
      .then(res => { branchId = res.body.id; });
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
    api("GET", `/carriers/${carrierCode}/profile`).then(res => {
      for (const c of res.body?.coverage || []) api("DELETE", `/carrier-coverage/${c.id}`);
      api("PUT", `/carriers/${carrierCode}/account-numbers`, { numbers: [], codeListName: "" });
      for (const o of res.body?.offices || []) api("DELETE", `/carrier-offices/${o.id}`);
    });
    for (const id of created.customers) api("DELETE", `/customers/${id}`);
    api("DELETE", `/carriers/${carrierCode}`);
    // The scratch legal entity: deleted, or set inactive if something refers to it.
    if (branchId) api("DELETE", `/branches/${branchId}`).then(r => { if (r.status !== 200) api("PUT", `/branches/${branchId}`, { isActive: false }); });
  });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
  });

  it("the old Carrier Agents link opens Carriers", () => {
    cy.visit("/#mdm-carrier-agents");
    cy.dismissStartupGates();
    cy.contains("h1", "Carrier Registry", { timeout: 15000 }).should("be.visible");
  });

  it("adds an office located inland, covers Spain with it, checks a route and saves our account number", () => {
    cy.visit("/#mdm-carriers");
    cy.dismissStartupGates();
    cy.get(`[data-testid="mdm-carrier-profile-${carrierCode}"]`, { timeout: 15000 }).click();
    cy.get('[data-testid="carrier-profile-modal"]').should("be.visible");

    // Offices: add Madrid (ESMAD isn't a port).
    cy.get('[data-testid="carrier-office-add"]').click();
    cy.get("#co-name").type(madridName);
    cy.get("#co-unlocode").type("ESMAD");
    cy.get("#co-city").type("Madrid");
    cy.get("#co-country").type("ES");
    cy.get("#co-contact").type("Bookings desk");
    cy.get("#co-email").type("es.bookings@hlag.example");
    cy.get('[data-testid="co-cap-documentation"]').check();
    cy.get('[data-testid="carrier-office-save"]').click();
    cy.get('[data-testid="carrier-offices-table"]').should("contain", madridName).and("contain", "ESMAD").and("contain", "400128");

    // Coverage: Spain, export, booking → Madrid.
    cy.get('[data-testid="carrier-profile-tab-coverage"]').click();
    cy.get("#cov-place-type").select("country");
    cy.get('input[placeholder="Search countries…"]').type("Spain");
    cy.contains("button", "Spain", { timeout: 8000 }).click();
    cy.get("#cov-direction").select("export");
    cy.get("#cov-role").select("booking");
    cy.get("#cov-office").find("option").contains(madridName).then(o => cy.get("#cov-office").select(o.val()));
    cy.get('[data-testid="carrier-coverage-add-btn"]').click();
    cy.get('[data-testid="carrier-coverage-table"]').should("contain", "ES").and("contain", "Booking");

    // …and Barcelona bills ESBCN's exports (a port beats its country).
    cy.get("#cov-place-type").select("unlocode");
    cy.get('[data-testid="carrier-coverage-add"]').find('input[placeholder^="Search ports"]').type("ESBCN");
    cy.contains("button", "ESBCN", { timeout: 8000 }).click();
    cy.get("#cov-direction").select("export");
    cy.get("#cov-role").select("billing");
    cy.get("#cov-office").select(barcelonaId);
    cy.get('[data-testid="carrier-coverage-add-btn"]').click();
    cy.get('[data-testid="carrier-coverage-table"]').should("contain", "ESBCN").and("contain", "Billing");

    // The route check: ESBCN → Madrid books, Barcelona bills.
    cy.get('[data-testid="carrier-coverage-check"]').find('input[placeholder="ESBCN…"]').type("ESBCN");
    cy.contains("button", "ESBCN", { timeout: 8000 }).click();
    cy.get('[data-testid="carrier-coverage-check"]').should("contain", madridName).and("contain", `Hapag-Lloyd Spain Barcelona ${rand}`)
      .and("contain", "row for ESBCN");

    // Our account number for one legal entity.
    cy.get('[data-testid="carrier-profile-tab-accounts"]').click();
    cy.then(() => cy.get("#acc-add-entity").select(branchId));
    cy.get('[data-testid="carrier-account-add"]').click();
    cy.get('[data-testid="carrier-accounts-table"]').find("input").first().type("ES00041207");
    cy.get('[data-testid="carrier-accounts-save"]').click();
    cy.contains("Account numbers saved", { timeout: 8000 }).should("be.visible");
  });

  it("shows the shipment's four carrier offices and lets the export side pick another", () => {
    let offices;
    ensureOffices(api).then(res => { offices = res; });
    cy.then(() => {
      return api("POST", "/customers", { companyName: `Ceramicas del Llobregat ${rand} SA`, address1: "Carrer de la Botanica 112", postalCode: "08908",
        city: "L'Hospitalet de Llobregat", countryIso2: "ES" }).then(c => {
        created.customers.push(c.body.id);
        return api("POST", "/shipments", { pol: "ESBCN", pod: "USNYC", carrierCode, status: "Active", contractType: "Central", contractRef: "HLAG-SC-2026-ES-0412",
          incoterm: "CIF", freightTerms: "Prepaid", etd: "2026-12-04", eta: "2026-12-18", commodityCode: "9999",
          shipperId: c.body.id, shipperName: c.body.companyName, principalId: c.body.id, principalName: c.body.companyName,
          consigneeName: "Hudson Tile Distributors Inc", emoOfficeId: offices.emoOfficeId, imoOfficeId: offices.imoOfficeId });
      });
    }).then(res => {
      shipmentId = res.body.id;
      // A real container on it, as every test shipment has.
      return api("POST", "/containers", { shipmentId, containerNumber: `HLXU${String(Date.now()).slice(-7)}`, size: "40", type: "HC",
        hsCode: "690721", cargoDescription: "Glazed ceramic floor tiles", grossWeightKg: 22400, numberOfPackages: 24, packageCode: "PL" });
    });
    cy.then(() => {
      cy.visit(`/#shipments/${shipmentId}/schedules`);
      cy.dismissStartupGates();
      cy.get('[data-testid="shipment-schedules-carrier-offices-section"]', { timeout: 20000 }).should("be.visible");
      cy.get('[data-testid="shipment-carrier-office-booking-name"]').should("have.text", madridName);
      cy.get('[data-testid="shipment-carrier-office-booking-why"]').should("contain", "row for ES");
      cy.get('[data-testid="shipment-carrier-office-billing_origin-name"]').should("contain", "Barcelona");
      // No import coverage: the import tiles say so, and destination billing has nothing to fall back on.
      cy.get('[data-testid="shipment-carrier-office-import-name"]').should("have.text", "None set");
      // The export side picks Barcelona as the booking office by hand.
      cy.get('[data-testid="shipment-carrier-office-booking-edit-btn"]').click();
      cy.get('[data-testid="shipment-carrier-office-booking-select"]').select(barcelonaId);
      cy.get('[data-testid="shipment-carrier-office-booking-save-btn"]').click();
      cy.get('[data-testid="shipment-carrier-office-booking-name"]').should("contain", "Barcelona");
      cy.get('[data-testid="shipment-carrier-office-booking-why"]').should("contain", "picked by");
      // …and From coverage puts Madrid back.
      cy.get('[data-testid="shipment-carrier-office-booking-coverage-btn"]').click();
      cy.get('[data-testid="shipment-carrier-office-booking-name"]').should("have.text", madridName);
    });
  });
});
