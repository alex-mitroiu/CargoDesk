/**
 * Carrier answers (Epic TKT-ASIYFL, Story 6 TKT-JHUTK5): a booking the carrier confirms with changes.
 *   - Test Tools → DCSA Carrier offers "Confirm with changes", and the carrier rolls the booking to the
 *     next week's sailing on another vessel;
 *   - the Shipments list's Booking column says CONFIRMED WITH CHANGES and what changed;
 *   - OCC/BK's Escalate pop-up lists the changes (requested → confirmed), and so does the escalation.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173), not in production (the built-in DCSA carrier plays CMDU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Carrier answers: confirmed with changes", () => {
  let tok, shipmentId, shipperId, consigneeId;
  let emoOfficeId, imoOfficeId;
  const stamp = Date.now();

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
    ensureOffices(api).then(res => { emoOfficeId = res.emoOfficeId; imoOfficeId = res.imoOfficeId; });
  });

  before(() => {
    cy.then(() => api("POST", "/customers", { companyName: `Answers Shipper ${stamp} BV` })).then(res => { shipperId = res.body.id; })
      .then(() => api("POST", "/customers", { companyName: `Answers Consignee ${stamp} Inc` })).then(res => { consigneeId = res.body.id; })
      .then(() => api("POST", "/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "CMDU", status: "Active", contractType: "SPOT", contractRef: `SPOT-ANS-${stamp}`,
        etd: "2026-11-16", eta: "2026-11-30", incoterm: "FOB", commodityCode: "9999",
        shipperId, shipperName: `Answers Shipper ${stamp} BV`, consigneeId, consigneeName: `Answers Consignee ${stamp} Inc`,
        principalId: shipperId, principalName: `Answers Shipper ${stamp} BV`, emoOfficeId, imoOfficeId,
      }))
      .then(res => {
        expect(res.status).to.eq(201);
        shipmentId = res.body.id;
        return api("POST", "/containers", { shipmentId, containerNumber: `ANSU${String(stamp).slice(-7)}`, size: "40", type: "HC",
          hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 });
      })
      .then(() => api("POST", `/shipments/${shipmentId}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
        etd: "2026-11-16", eta: "2026-11-30", carrierCode: "CMDU", vessel: "CMA CGM ANSWERS", vesselImo: "9999995", voyage: "0AN3W" }))
      .then(() => api("POST", `/shipments/${shipmentId}/edi-messages/booking-request`, {}))
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(201));
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
    if (shipperId) api("DELETE", `/customers/${shipperId}`);
    if (consigneeId) api("DELETE", `/customers/${consigneeId}`);
  });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.dismissStartupGates();
  });
  const goto = hash => {
    cy.window().then(win => { win.location.hash = hash; });
    cy.dismissStartupGates();
  };

  it("Test Tools: the carrier confirms with changes", () => {
    goto("test-tools");
    cy.get(`[data-testid="dcsa-carrier-row-${shipmentId}"]`, { timeout: 15000 }).click();
    cy.get('[data-testid="dcsa-carrier-feedback"]').type("Rolled to next week's sailing");
    cy.get('[data-testid="dcsa-carrier-action-confirmWithChanges"]').should("contain", "Confirm with changes").click();
    cy.contains("Confirm with changes: sent to CargoDesk", { timeout: 8000 }).should("be.visible");
    cy.get('[data-testid="dcsa-carrier-detail"]').should("contain", "CONFIRMED");
  });

  it("the Booking column says what changed", () => {
    goto("shipments");
    cy.get('input[placeholder^="Search ID"]', { timeout: 15000 }).type(shipmentId);
    cy.get(`[data-testid="booking-cell-${shipmentId}"]`, { timeout: 15000 })
      .should("contain", "CONFIRMED WITH CHANGES")
      .and("contain", "Vessel / voyage, Departure, Arrival");
    cy.screenshot("carrier-answers-1-list", { capture: "viewport" });
  });

  it("OCC/BK's Escalate pop-up and the escalation list the changes", () => {
    goto(`shipments/${shipmentId}/booking/review`);
    cy.get('[data-testid="escalate-btn"]', { timeout: 15000 }).click();
    cy.get('[data-testid="escalate-modal"]').within(() => {
      cy.contains("CONFIRMED WITH CHANGES").should("be.visible");
      cy.get('[data-testid="escalate-changes"]')
        .should("contain", "Vessel / voyage")
        .and("contain", "CMA CGM ANSWERS · 0AN3W")
        .and("contain", "DEMO SUBSTITUTE · DM777W")
        .and("contain", "16 Nov")
        .and("contain", "23 Nov")
        .and("contain", "Arrival")
        .and("contain", "30 Nov")
        .and("contain", "07 Dec");
    });
    cy.screenshot("carrier-answers-2-escalate", { capture: "viewport" });
    cy.get('[data-testid="escalate-submit"]').click();
    cy.get('[data-testid="escalation-holder"]', { timeout: 10000 }).should("contain", "WITH OCC/AY");
    cy.get('[data-testid="escalation-changes"]').should("contain", "DEMO SUBSTITUTE · DM777W");
    cy.get('[data-testid="escalation-panel"]').scrollIntoView();
    cy.screenshot("carrier-answers-3-panel", { capture: "viewport" });
  });
});
