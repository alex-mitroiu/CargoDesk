/**
 * Booking escalation settings and the Carrier Responses report (Epic TKT-ASIYFL, Story 7 TKT-SXO1QS;
 * approved mockup https://claude.ai/artifact/FXrT7utJNRgPabknbKyPmR, "App Settings" and "Carrier
 * responses" artboards).
 *   - App Settings → Bookings → Escalations: the four policy cards are a draft until Save, and Discard
 *     drops the changes (the user, 2026-10-20);
 *   - Reports → Carrier Responses: one row per carrier, an All carriers total, the lane filter.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173), not in production
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Booking escalation settings and Carrier Responses", () => {
  let tok, saved, shipmentId, shipperId, consigneeId;
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
      .then(res => { tok = res.body.token; return api("GET", "/settings"); })
      .then(res => { saved = res.body; });
  });

  // One booking request sent today (OOLU, no answer yet), so the report has a row of its own.
  before(() => {
    ensureOffices(api).then(({ emoOfficeId, imoOfficeId }) =>
      api("POST", "/customers", { companyName: `Report Shipper ${stamp} BV` }).then(res => { shipperId = res.body.id; })
        .then(() => api("POST", "/customers", { companyName: `Report Consignee ${stamp} Inc` })).then(res => { consigneeId = res.body.id; })
        .then(() => api("POST", "/shipments", {
          pol: "NLRTM", pod: "USNYC", carrierCode: "OOLU", status: "Active", contractType: "SPOT", contractRef: `SPOT-RPT-${stamp}`,
          etd: "2026-11-16", eta: "2026-11-30", incoterm: "FOB", commodityCode: "9999",
          shipperId, shipperName: `Report Shipper ${stamp} BV`, consigneeId, consigneeName: `Report Consignee ${stamp} Inc`,
          principalId: shipperId, principalName: `Report Shipper ${stamp} BV`, emoOfficeId, imoOfficeId,
        }))
        .then(res => {
          expect(res.status).to.eq(201);
          shipmentId = res.body.id;
          return api("POST", "/containers", { shipmentId, containerNumber: `RPTU${String(stamp).slice(-7)}`, size: "40", type: "HC",
            hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 });
        })
        .then(() => api("POST", `/shipments/${shipmentId}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
          etd: "2026-11-16", eta: "2026-11-30", carrierCode: "OOLU", vessel: "OOCL REPORT", vesselImo: "9999995", voyage: "0RP2W" }))
        .then(() => api("POST", `/shipments/${shipmentId}/edi-messages/booking-request`, {}))
        .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(201)));
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
    if (shipperId) api("DELETE", `/customers/${shipperId}`);
    if (consigneeId) api("DELETE", `/customers/${consigneeId}`);
    api("PUT", "/settings", {
      booking_escalation_default_group: saved.booking_escalation_default_group, booking_no_answer_hours: saved.booking_no_answer_hours,
      booking_escalation_trade_level: saved.booking_escalation_trade_level, booking_change_rules: saved.booking_change_rules,
    });
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

  it("App Settings → Bookings: Discard drops the changes, Save keeps them", () => {
    goto("settings");
    cy.contains("button", /^Bookings$/, { timeout: 15000 }).click();
    cy.contains("button", /^Escalations$/i).should("be.visible");
    cy.get('[data-testid="settings-bookings"]').within(() => {
      cy.contains("Default escalation group").should("be.visible");
      cy.contains("ETD or ETA by more than").should("be.visible");
      cy.get('[data-testid="settings-bookings-save"]').should("be.disabled");
      cy.get('[data-testid="settings-booking-default-group"]').select("ccl_co");
      cy.get('[data-testid="settings-bookings-unsaved"]').should("be.visible");
      cy.get('[data-testid="settings-bookings-discard"]').click();
      cy.get('[data-testid="settings-booking-default-group"]').should("have.value", saved.booking_escalation_default_group || "occ_ay");
      cy.get('[data-testid="settings-bookings-unsaved"]').should("not.exist");

      cy.get('[data-testid="settings-booking-default-group"]').select("ccl_co");
      cy.get('[data-testid="settings-booking-no-answer"]').clear();
      cy.contains("Enter a number of hours above 0").should("be.visible");
      cy.get('[data-testid="settings-bookings-save"]').should("be.disabled");
      cy.get('[data-testid="settings-booking-no-answer"]').type("3");
      cy.get("#bk-chg-ports").uncheck();
      cy.get('[data-testid="settings-booking-tolerance"]').clear().type("2");
    });
    cy.screenshot("booking-settings-1-escalations", { capture: "viewport" });
    api("GET", "/settings").then(res => expect(res.body.booking_escalation_default_group, "nothing saved before Save").to.eq(saved.booking_escalation_default_group));
    cy.get('[data-testid="settings-bookings-save"]').click();
    cy.contains("Escalation settings saved").should("be.visible");
    cy.get('[data-testid="settings-bookings-unsaved"]').should("not.exist");
    api("GET", "/settings").then(res => {
      expect(res.body.booking_escalation_default_group).to.eq("ccl_co");
      expect(res.body.booking_no_answer_hours).to.eq("3");
      const rules = JSON.parse(res.body.booking_change_rules);
      expect(rules.ports).to.eq(false);
      expect(rules.toleranceDays).to.eq(2);
      expect(rules.vessel).to.eq(true);
    });
  });

  it("Reports → Carrier Responses shows each carrier and the total", () => {
    goto("reports");
    cy.contains("button", "Carrier Responses", { timeout: 15000 }).click();
    cy.contains("How carriers answer booking requests").should("be.visible");
    cy.get("#carrier-responses-panel").within(() => {
      cy.get('[data-testid="carrier-responses-total"]', { timeout: 15000 }).should("contain", "All carriers");
      cy.get('[data-testid="carrier-responses-row-OOLU"]').should("contain", "OOLU");
      cy.contains("No answer").should("be.visible");
      cy.get('[data-testid="carrier-responses-csv"]').should("not.be.disabled");
      cy.get("#cr-lane").find("option").should("have.length.at.least", 2);
    });
    cy.screenshot("booking-settings-2-carrier-responses", { capture: "viewport" });
    cy.get("#cr-lane").find("option").eq(1).then($o => cy.get("#cr-lane").select($o.val()));
    cy.get('[data-testid="carrier-responses-total"]', { timeout: 15000 }).should("exist");
  });
});
