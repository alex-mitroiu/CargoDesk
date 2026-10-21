/**
 * The main vessel, and what the carrier changed (Epic TKT-O3YBNE; approved mockup
 * https://claude.ai/artifact/P3xrSaDFwDHWeWiSEWVccv).
 *   - Schedule Search lists a transshipment under its main vessel (MAIN), every leg beneath in order;
 *   - the Add/Change Sailing picker does the same, and says the shipment's vessel becomes the main one;
 *   - a shipment that transships leads with its main vessel in the header and sidebar ("via" the hub and
 *     feeder), and Route Legs mark MAIN and FEEDER;
 *   - Booking & Review compares what we requested (A) with what the carrier confirmed (B), and the user
 *     accepts the carrier's version or asks the carrier to amend.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173), not in production (the built-in DCSA carrier plays CMDU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("The main vessel, and what the carrier changed", () => {
  let tok, shipperId, consigneeId, contractId, tsShipment, changedShipment, amendShipment;
  let emoOfficeId, imoOfficeId;
  const stamp = Date.now();
  const contractNumber = `CY-MV-HLCU-${stamp}`;

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });

  const newShipment = (legs, carrierCode = "CMDU") =>
    api("POST", "/shipments", {
      pol: legs[0].pol, pod: legs.at(-1).pod, carrierCode, status: "Active", contractType: "SPOT", contractRef: `SPOT-MV-${stamp}`,
      etd: legs[0].etd, eta: legs.at(-1).eta, incoterm: "FOB", commodityCode: "9999",
      shipperId, shipperName: `Main Vessel Shipper ${stamp} BV`, consigneeId, consigneeName: `Main Vessel Consignee ${stamp} Inc`,
      principalId: shipperId, principalName: `Main Vessel Shipper ${stamp} BV`, emoOfficeId, imoOfficeId,
    }).then(res => {
      expect(res.status).to.eq(201);
      const id = res.body.id;
      return api("POST", "/containers", { shipmentId: id, containerNumber: `MVCU${String(stamp + legs.length).slice(-6)}${Math.floor(Math.random() * 10)}`, size: "40", type: "HC",
        hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 })
        .then(() => cy.wrap(legs).each(l => api("POST", `/shipments/${id}/legs`, { legType: "SEA", movementType: "SEA", carrierCode, vesselImo: "9999995", ...l })))
        .then(() => id);
    });
  const confirmWithChanges = id => {
    const waitRef = (tries = 40) => api("GET", `/shipments/${id}/carrier-booking`).then(res => {
      if (res.body?.carrierBookingRequestReference && res.body.lastResponseStatus) return res.body.carrierBookingRequestReference;
      if (tries <= 0) throw new Error("No carrier reference");
      return cy.wait(250).then(() => waitRef(tries - 1));
    });
    return api("POST", `/shipments/${id}/edi-messages/booking-request`, {})
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(201))
      .then(() => waitRef())
      .then(ref => api("POST", `/test-tools/dcsa-sim/bookings/${ref}/confirmWithChanges`, { message: "Rolled to next week's sailing" }))
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(200));
  };

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).then(res => { tok = res.body.token; });
  });
  before(() => {
    ensureOffices(api).then(res => { emoOfficeId = res.emoOfficeId; imoOfficeId = res.imoOfficeId; });
  });
  before(() => {
    api("POST", "/customers", { companyName: `Main Vessel Shipper ${stamp} BV` }).then(res => { shipperId = res.body.id; })
      .then(() => api("POST", "/customers", { companyName: `Main Vessel Consignee ${stamp} Inc` })).then(res => { consigneeId = res.body.id; })
      .then(() => api("POST", "/contracts", { carrierCode: "HLCU", contractNumber, status: "Active", validFrom: "2026-01-01", validTo: "2027-06-30",
        legs: [{ pol: "NLRTM", pod: "USNYC" }] }))
      .then(res => { expect(res.status).to.eq(201); contractId = res.body.id; })
      .then(() => newShipment([
        { pol: "NLRTM", pod: "BEANR", etd: "2026-11-14", eta: "2026-11-16", vessel: "CY FEEDER", voyage: "CF1N" },
        { pol: "BEANR", pod: "USNYC", etd: "2026-11-18", eta: "2026-11-27", vessel: "CY MAINLINER", voyage: "CM7W" },
      ], "HLCU")).then(id => { tsShipment = id; })
      .then(() => newShipment([{ pol: "NLRTM", pod: "USNYC", etd: "2026-11-16", eta: "2026-11-30", vessel: "CMA CGM REQUESTED", voyage: "0MV1W" }]))
      .then(id => { changedShipment = id; return confirmWithChanges(id); })
      .then(() => newShipment([{ pol: "NLRTM", pod: "USNYC", etd: "2026-11-16", eta: "2026-11-30", vessel: "CMA CGM REQUESTED", voyage: "0MV2W" }]))
      .then(id => { amendShipment = id; return confirmWithChanges(id); });
  });

  after(() => {
    [tsShipment, changedShipment, amendShipment].filter(Boolean).forEach(id => api("DELETE", `/shipments/${id}`));
    if (contractId) api("DELETE", `/contracts/${contractId}`);
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
  const pickPort = (placeholder, code) => {
    cy.get(`input[placeholder="${placeholder}"]`).type(code);
    cy.contains("button", new RegExp(`^${code}`), { timeout: 10000 }).trigger("mousedown");
  };

  it("Schedule Search lists a transshipment under its main vessel", () => {
    goto("schedules");
    pickPort("Port of Loading", "NLRTM");
    pickPort("Port of Discharge", "USNYC");
    cy.get('input[type="date"]').first().type("2026-11-16");
    cy.contains("button", "Search Contracts →").click();
    cy.contains(contractNumber, { timeout: 15000 }).parents().filter((_, el) => /Sailings →/.test(el.textContent)).first()
      .contains("button", "Sailings →").click();
    cy.contains("button", "Get Sailings", { timeout: 15000 }).click();
    cy.get('[data-testid^="schedule-sailing-"][data-testid*="-leg-"]', { timeout: 15000 }).should("have.length.at.least", 2);
    cy.get('[data-testid^="schedule-sailing-"]').filter(':has([data-testid="leg-role-main"])').not('[data-testid*="-leg-"]').first().then($row => {
      const i = $row.attr("data-testid").replace("schedule-sailing-", "");
      cy.get(`[data-testid="schedule-sailing-${i}-leg-0"]`).should("contain", "FEEDER");
      cy.get(`[data-testid^="schedule-sailing-${i}-leg-"]`).filter(':has([data-testid="leg-role-main"])').should("have.length", 1);
    });
    cy.contains("Vessel (main)").scrollIntoView().should("be.visible");
    cy.screenshot("main-vessel-1-schedule-search", { capture: "viewport" });
  });

  it("the sailing picker marks the main vessel and lists the legs in order", () => {
    goto(`shipments/${tsShipment}/schedules`);
    cy.contains("button", /Change Sailing|Add Sailing/, { timeout: 20000 }).click();
    cy.get('[data-testid^="sailing-legs-"]', { timeout: 15000 }).first().within(() => {
      cy.get('[data-testid="leg-role-feeder"]').should("exist");
      cy.get('[data-testid="leg-role-main"]').should("have.length", 1);
    });
    cy.contains(/Creates \d sea legs in this order/).should("be.visible");
    cy.screenshot("main-vessel-2-picker", { capture: "viewport" });
  });

  it("the shipment leads with its main vessel, via the feeder", () => {
    goto(`shipments/${tsShipment}/schedules`);
    cy.get('[data-testid="shipment-detail-header-chip-carrier"]', { timeout: 15000 }).should("contain", "CY MAINLINER").find('[data-testid="leg-role-main"]').should("exist");
    cy.get('[data-testid="shipment-detail-header-chip-via"]').should("contain", "BEANR, feeder CY FEEDER");
    cy.get('[data-testid="sidebar-via"]').should("contain", "via BEANR, feeder CY FEEDER");
    cy.get('[data-testid="shipment-schedules-page"] [data-testid="leg-role-main"]').should("have.length", 1);
    cy.get('[data-testid="shipment-schedules-page"] [data-testid="leg-role-feeder"]').should("have.length", 1);
    cy.screenshot("main-vessel-3-shipment", { capture: "viewport" });
  });

  it("Booking & Review compares A with B, and the user accepts the carrier's version", () => {
    goto(`shipments/${changedShipment}/booking/review`);
    cy.get('[data-testid="comparison-banner"]', { timeout: 15000 }).should("contain", "CONFIRMED WITH CHANGES").and("contain", "4 details differ");
    cy.get('[data-testid="comparison-row-vessel"]').should("have.attr", "data-kind", "changed").and("contain", "CMA CGM REQUESTED").and("contain", "DEMO SUBSTITUTE");
    cy.get('[data-testid="comparison-row-etd"]').should("contain", "+7 days");
    cy.get('[data-testid="comparison-row-gross-weight"]').should("contain", "Not stated");
    cy.get('[data-testid="comparison-row-vgm-cut-off"]').should("have.attr", "data-kind", "new");
    cy.get('[data-testid="comparison-panel"]').scrollIntoView();
    cy.screenshot("main-vessel-4-comparison", { capture: "viewport" });
    cy.get('[data-testid="comparison-filter-changes"]').click();
    cy.get('[data-testid="comparison-row-port-of-loading"]').should("not.exist");
    cy.get('[data-testid="comparison-row-vessel"]').should("exist");
    cy.get('[data-testid="decision-accept"]').click();
    cy.get('[data-testid="decision-accept-submit"]').scrollIntoView().click();
    cy.get('[data-testid="comparison-accepted"]', { timeout: 15000 }).should("contain", "ACCEPTED");
    cy.get('[data-testid="comparison-decision"]').should("not.exist");
    cy.screenshot("main-vessel-5-accepted", { capture: "viewport" });
    api("GET", `/shipments/${changedShipment}`).then(res => {
      expect(res.body.vessel).to.eq("DEMO SUBSTITUTE");
      expect(String(res.body.etd)).to.match(/^2026-11-23/);
    });
  });

  it("…or asks the carrier to amend", () => {
    goto(`shipments/${amendShipment}/booking/review`);
    cy.get('[data-testid="decision-amend"]', { timeout: 15000 }).click();
    cy.get('[data-testid="decision-amend-note"]').type("Please keep 0MV2W, ETD 16 Nov");
    cy.get('[data-testid="decision-amend-submit"]').click();
    cy.contains("Amendment sent", { timeout: 10000 }).should("be.visible");
    api("GET", `/shipments/${amendShipment}/carrier-booking`).then(res => expect(res.body.lastResponseStatus).to.eq("amendment_requested"));
  });
});
