/**
 * Carrier Booking Folds Suite (Carrier Booking → Details in Trade Horizon Next) — ARCHITECTURE.md §8.54, TC-107
 *
 * Mockup a3e1b986 v2, approved 2026-11-18: the carrier offices and the payment terms fold; each starts open and then
 * remembers the user's choice in this browser; folded, the offices read as one line and the payment terms keep their
 * status, a line per group of charges and the Save button; a pill in the section bar opens a folded section. The page
 * (Details and Review) has the Next header and the » pill.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - ESBCN, USNYC in port_locations; ES in countries (seeded MDM data)
 *
 * The scratch carrier, its office and coverage are removed afterwards (lookup rows: they would give other shipments
 * offices). The shipment is deleted.
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Carrier Booking Folds Suite", () => {
  let tok, shipmentId, officeId, coverageId;
  const created = { customers: [] };
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  const carrierCode = `QF${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;
  const madridName = `Hapag-Lloyd Spain Madrid ${rand}`;
  // Sails relative to today (CLAUDE.md: never a fixed date).
  const dayFromToday = n => { const d = new Date(); d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const etd = dayFromToday(10), eta = dayFromToday(24);

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });

  before(() => {
    let offices;
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; })
      .then(() => api("POST", "/carriers", { code: carrierCode, name: `Cypress Folds Carrier ${rand}` }))
      // The carrier's Madrid office books Spain's exports; nothing covers the import side (so it reads "none set").
      .then(() => api("POST", `/carriers/${carrierCode}/offices`, { name: madridName, unlocode: "ESMAD", address1: "Paseo de la Castellana 95",
        postalCode: "28046", city: "Madrid", countryIso2: "ES", contactName: "Bookings desk", contactEmail: "es.bookings@hlag.example" }))
      .then(res => { officeId = res.body.id; })
      .then(() => api("POST", `/carriers/${carrierCode}/coverage`, { placeType: "country", countryIso2: "ES", direction: "export", role: "booking", officeId }))
      .then(res => { coverageId = res.body.id; });
    // After the login above (Cypress runs queued commands in order; api() reads the token when it's called).
    cy.then(() => ensureOffices(api)).then(res => { offices = res; });
    cy.then(() => api("POST", "/customers", { companyName: `Ceramicas del Llobregat ${rand} SA`, address1: "Carrer de la Botanica 112", postalCode: "08908",
      city: "L'Hospitalet de Llobregat", countryIso2: "ES" }))
      .then(shipper => {
        created.customers.push(shipper.body.id);
        return api("POST", "/customers", { companyName: `Hudson Tile Distributors ${rand} Inc`, address1: "600 Meadowlands Pkwy", postalCode: "07094",
          city: "Secaucus", countryIso2: "US" }).then(consignee => {
          created.customers.push(consignee.body.id);
          return api("POST", "/shipments", { pol: "ESBCN", pod: "USNYC", carrierCode, status: "Active", contractType: "Central",
            contractRef: "HLAG-SC-2026-ES-0412", incoterm: "FOB", freightTerms: "Collect", etd, eta, commodityCode: "9999",
            shipperId: shipper.body.id, shipperName: shipper.body.companyName, consigneeId: consignee.body.id, consigneeName: consignee.body.companyName,
            principalId: consignee.body.id, principalName: consignee.body.companyName, emoOfficeId: offices.emoOfficeId, imoOfficeId: offices.imoOfficeId });
        });
      })
      .then(res => {
        expect(res.status, JSON.stringify(res.body)).to.eq(201);
        shipmentId = res.body.id;
        return api("POST", "/containers", { shipmentId, containerNumber: `HLXU${String(Date.now()).slice(-7)}`, size: "40", type: "HC",
          hsCode: "690721", cargoDescription: "Glazed ceramic floor tiles", grossWeightKg: 22400, numberOfPackages: 24, packageCode: "PL" });
      })
      .then(res => expect(res.status).to.eq(201))
      // A sea leg with its sailing: Carrier Booking opens only with a contract and a schedule in place.
      .then(() => api("POST", `/shipments/${shipmentId}/legs`, { legType: "SEA", movementType: "SEA", pol: "ESBCN", pod: "USNYC", etd, eta,
        carrierCode, vessel: "DEMO CADENZA", vesselImo: "9999999", voyage: "DM014W" }))
      .then(res => expect(res.status).to.eq(201))
      .then(() => api("POST", `/shipments/${shipmentId}/schedules`, { carrier: carrierCode, vesselName: "DEMO CADENZA", voyageNumber: "DM014W",
        pol: "ESBCN", pod: "USNYC", etd, eta }))
      .then(res => expect(res.status).to.eq(201));
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
    if (coverageId) api("DELETE", `/carrier-coverage/${coverageId}`);
    if (officeId) api("DELETE", `/carrier-offices/${officeId}`).then(r => { if (r.status !== 200) api("PUT", `/carrier-offices/${officeId}`, { isActive: false }); });
    for (const id of created.customers) api("DELETE", `/customers/${id}`);
    api("DELETE", `/carriers/${carrierCode}`);
  });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
  });

  const openDetails = () => {
    cy.visit(`/#shipments/${shipmentId}/booking/details`);
    cy.dismissStartupGates();
    cy.get('[data-testid="carrier-booking-details-page"]', { timeout: 20000 }).should("be.visible");
  };

  it("draws the page in Trade Horizon Next: the header, the pill nav, the booking card, the » pill", () => {
    openDetails();
    cy.get('[data-testid="shipment-detail-header-route-track"]').should("exist");
    cy.get('[data-testid="shipment-advance-bar"]').should("have.attr", "data-variant", "next");
    cy.get('[data-testid="carrier-booking-pill-nav"]').should("be.visible");
    cy.get('[data-testid="carrier-booking-headline"]').should("contain", `Not sent to ${carrierCode} yet`);
    cy.get('[data-testid="carrier-booking-office-booking"]').should("contain", madridName).and("contain", "ESMAD");
    cy.get('[data-testid="carrier-booking-office-import"]').should("contain", "None set");
    cy.get('[data-testid="cpi-row-freight"]').should("be.visible");
    cy.contains("button", "Send Booking Request").should("not.be.disabled");
    // D1 (2026-11-23, mockup dffb8ab2): until the payment terms are saved (the next tests save them), the booking card
    // says the ocean freight follows Freight Terms and the rest the Incoterm.
    cy.get('[data-testid="carrier-booking-freight-hint"]').should("contain", "ocean freight follows Freight Terms")
      .and("contain", "(Collect)").and("contain", "(FOB)");
  });

  it("folds both sections to their summaries and keeps them folded after a reload", () => {
    openDetails();
    cy.get('[data-testid="carrier-booking-offices-fold"]').click();
    cy.get('[data-testid="carrier-booking-offices-summary-pills"]').should("contain", madridName).and("contain", "none set");
    cy.get('[data-testid="carrier-booking-office-booking"]').should("not.be.visible");
    cy.get('[data-testid="payment-terms-section-fold"]').click();
    cy.get('[data-testid="cpi-row-freight"]').should("not.be.visible");
    cy.get('[data-testid="payment-terms-summary"]').should("contain", "Prepaid").and("contain", "Collect");
    cy.get('[data-testid="payment-terms-status"]').should("contain", "Not saved yet · the FOB defaults");
    cy.get('[data-testid="payment-terms-save"]').should("be.visible");
    cy.reload();
    cy.dismissStartupGates();
    cy.get('[data-testid="carrier-booking-offices"]', { timeout: 20000 }).should("have.attr", "data-open", "false");
    cy.get('[data-testid="payment-terms-section"]').should("have.attr", "data-open", "false");
    cy.get('[data-testid="carrier-booking-nav-offices-note"]').should("contain", "folded");
  });

  it("saves the payment terms from the folded header, and a pill opens its section", () => {
    cy.intercept("PUT", `/api/shipments/${shipmentId}/payment-terms`).as("saveTerms");
    openDetails();
    // Cypress clears localStorage between tests, so the section starts open again here: fold it.
    cy.get('[data-testid="payment-terms-section-fold"]').click();
    cy.get('[data-testid="payment-terms-section"]').should("have.attr", "data-open", "false");
    cy.get('[data-testid="payment-terms-save"]').click();
    cy.wait("@saveTerms").its("response.statusCode").should("eq", 200);
    cy.get('[data-testid="payment-terms-status"]').should("contain", "Follows the Incoterm FOB");
    cy.get('[data-testid="carrier-booking-nav-terms"]').click();
    cy.get('[data-testid="payment-terms-section"]').should("have.attr", "data-open", "true");
    cy.get('[data-testid="cpi-row-freight"]').should("be.visible");
    // Collect, and no billing office on the import side: payable at the port of discharge.
    cy.get('[data-testid="payment-terms-dcsa"]').should("contain", '"UNLocationCode": "USNYC"');
  });

  // TKT-JV1SF2 point 5 (2026-11-23, mockup dffb8ab2): the transport document and loading, sent only when stated, with
  // the request's own preview.
  it("states the transport document for the request", () => {
    cy.intercept("PUT", "**/booking-request-options").as("saveOptions");
    openDetails();
    cy.get('[data-testid="transport-document-status"]', { timeout: 15000 }).should("contain", "NOTHING STATED");
    cy.get('[data-testid="transport-document-dcsa"]').should("contain", "nothing stated");
    cy.get('[data-testid="td-type-SWB"]').click();
    cy.wait("@saveOptions").its("response.statusCode").should("eq", 200);
    cy.get('[data-testid="td-partial-false"]').click();
    cy.wait("@saveOptions").its("response.statusCode").should("eq", 200);
    cy.get('[data-testid="transport-document-status"]').should("contain", "2 STATED");
    cy.get('[data-testid="transport-document-dcsa"]').should("contain", '"transportDocumentTypeCode": "SWB"').and("contain", '"isPartialLoadAllowed": false');
    cy.then(() => api("GET", `/shipments/${shipmentId}/booking-request-options`)).its("body.dcsa")
      .should("deep.equal", { transportDocumentTypeCode: "SWB", isPartialLoadAllowed: false });
  });

  it("Review keeps the Next header and the » pill", () => {
    cy.visit(`/#shipments/${shipmentId}/booking/review`);
    cy.dismissStartupGates();
    cy.get('[data-testid="shipment-detail-header-route-track"]', { timeout: 20000 }).should("exist");
    cy.get('[data-testid="shipment-advance-bar"]').should("have.attr", "data-variant", "next");
  });
});
