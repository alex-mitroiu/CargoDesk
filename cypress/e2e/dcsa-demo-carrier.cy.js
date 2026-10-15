/**
 * DCSA demo carrier — the Phase 1 screens of the DCSA-everywhere program (TKT-IVI7FM, 2026-10-11;
 * approved mockup https://claude.ai/artifact/YWTqiqFffgjxDPq827CdPD), plus the Port Locations time
 * zone column (476485e).
 *
 *  - a booking made with a carrier that has no DCSA connection goes to the built-in DCSA simulator:
 *    the Carrier Booking Review page badges it DEMO CARRIER, says it's waiting for the carrier and
 *    points to Test Tools; there is no Confirm Booking button any more;
 *  - Test Tools → DCSA Carrier offers only the decisions valid for the booking's DCSA state, and a
 *    confirmation turns the Review banner into "Confirmed by <carrier>, booking <number>";
 *  - App Settings shows the Demo carrier card (always on outside production) and no eAdapter card;
 *  - Master Data → Port Locations shows each location's time zone with its UTC offset.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173), not in production
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("DCSA demo carrier", () => {
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

  // A realistic shipment with a carrier that has no DCSA integration (CMDU), so the simulator plays it.
  before(() => {
    cy.then(() => api("POST", "/customers", { companyName: `Demo Carrier Shipper ${stamp} BV` })).then(res => { shipperId = res.body.id; })
      .then(() => api("POST", "/customers", { companyName: `Demo Carrier Consignee ${stamp} Inc` })).then(res => { consigneeId = res.body.id; })
      .then(() => api("POST", "/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "CMDU", status: "Active", contractType: "SPOT", contractRef: `SPOT-DEMO-${stamp}`,
        etd: "2026-12-02", eta: "2026-12-14", incoterm: "FOB", commodityCode: "9999",
        shipperId, shipperName: `Demo Carrier Shipper ${stamp} BV`, consigneeId, consigneeName: `Demo Carrier Consignee ${stamp} Inc`,
        principalId: shipperId, principalName: `Demo Carrier Shipper ${stamp} BV`, emoOfficeId, imoOfficeId,
      }))
      .then(res => {
        expect(res.status).to.eq(201);
        shipmentId = res.body.id;
        return api("POST", "/containers", { shipmentId, containerNumber: `DEMU${String(stamp).slice(-7)}`, size: "40", type: "HC",
          hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 });
      })
      .then(res => {
        expect(res.status).to.eq(201);
        return api("POST", `/shipments/${shipmentId}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
          etd: "2026-12-02", eta: "2026-12-14", carrierCode: "CMDU", vessel: "CMA CGM DEMO", vesselImo: "9999995", voyage: "0FL3W" });
      })
      .then(res => {
        expect(res.status).to.eq(201);
        return api("POST", `/shipments/${shipmentId}/edi-messages/booking-request`, {});
      })
      .then(res => {
        expect(res.status, JSON.stringify(res.body)).to.eq(201);
        expect(res.body.carrierError, "the simulator accepted the DCSA request").to.be.undefined;
      });
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

  it("badges the booking DEMO CARRIER and says it's waiting for the carrier", () => {
    goto(`shipments/${shipmentId}/booking/review`);
    cy.get('[data-testid="carrier-booking-demo-badge"]', { timeout: 15000 }).should("contain", "DEMO CARRIER");
    cy.get('[data-testid="carrier-booking-banner"]')
      .should("contain", "Waiting for CMDU")
      .and("contain", "Test Tools → DCSA Carrier");
    cy.contains("button", "Confirm Booking").should("not.exist");
  });

  it("Test Tools offers only the carrier's valid decisions, and confirming moves them on", () => {
    goto("test-tools");
    cy.get(`[data-testid="dcsa-carrier-row-${shipmentId}"]`, { timeout: 15000 }).click();
    cy.get('[data-testid="dcsa-carrier-detail"]').should("contain", "RECEIVED");
    cy.get('[data-testid^="dcsa-carrier-action-"]').then($b => {
      const actions = [...$b].map(b => b.dataset.testid.replace("dcsa-carrier-action-", "")).sort();
      expect(actions).to.deep.eq(["confirm", "reject", "requestUpdate"]);
    });
    cy.get('[data-testid="dcsa-carrier-action-confirm"]').click();
    cy.contains("Confirm: sent to CargoDesk", { timeout: 8000 }).should("be.visible");
    cy.get('[data-testid="dcsa-carrier-action-confirm"]').should("not.exist");
    cy.get('[data-testid="dcsa-carrier-action-requestAmendment"]').should("exist");
    cy.get('[data-testid="dcsa-carrier-detail"]').should("contain", "CONFIRMED");
  });

  it("the Review page then says Confirmed by the carrier, with its booking number", () => {
    api("GET", `/shipments/${shipmentId}/carrier-booking`).then(res => {
      expect(res.body.status).to.eq("Confirmed");
      goto(`shipments/${shipmentId}/booking/review`);
      cy.get('[data-testid="carrier-booking-banner"]', { timeout: 15000 })
        .should("contain", `Confirmed by CMDU, booking ${res.body.bookingRef}`);
    });
  });

  it("App Settings shows the Demo carrier card and no eAdapter card", () => {
    goto("settings");
    cy.get('[data-testid="settings-demo-carrier-card"]', { timeout: 15000 })
      .should("contain", "Demo carrier")
      .and("contain", "ALWAYS ON OUTSIDE PRODUCTION");
    cy.contains("eAdapter").should("not.exist");
  });

  it("Port Locations shows each location's time zone with its UTC offset", () => {
    goto("mdm-ports");
    cy.contains("Time zone", { timeout: 15000 }).should("be.visible");
    cy.contains(/UTC[+-]\d\d:\d\d/).should("be.visible");
  });
});
