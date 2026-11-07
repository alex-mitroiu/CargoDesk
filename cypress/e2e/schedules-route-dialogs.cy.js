/**
 * Contracts & Schedules: route problems in the dialog, and a contract that no longer fits (2026-11-06).
 *
 * The user's two reports:
 *   - "if I try to screw up on purpose the PKU / DEL order logic, the error message is shown in a toaster, instead of
 *     the error pop-up" — a change the route table refuses (here a second Carrier's Haulage pick-up) opens the same
 *     dialog as Save's problems (LegsTable onRefuse), and the row goes back;
 *   - "if we have a carrier schedule assigned to the shipment, we cannot change the contract because the button is
 *     disabled. If there's a contract active but is no longer matching the schedule, we can simply drop it on the save
 *     action, and put the warning in the pop-up" — Save warns in the dialog, Back keeps everything, "Save and remove
 *     the contract" saves the route and takes the contract off (the shipment stays Central, asking for a contract).
 *     A change the contract still covers saves without the dialog.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

const inDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

describe("Contracts & Schedules: route dialogs and a contract that no longer fits", () => {
  let tok, shipperId, consigneeId, contractId, emoOfficeId, imoOfficeId;
  const shipments = {};
  const stamp = Date.now();
  const contractNumber = `CY-RD-HLCU-${stamp}`;

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });

  // A complete Central shipment on the test contract, NLRTM → USNYC with HLCU, one 40HC; its route saved whole.
  const newShipment = (key, route, { vessel = "", voyage = "" } = {}) =>
    api("POST", "/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "HLCU", status: "Active",
      contractType: "Central", contractId, contractRef: contractNumber,
      etd: inDays(4), eta: inDays(14), cargoReadyDate: inDays(2), incoterm: "FOB", commodityCode: "9999",
      shipperId, shipperName: `Route Dialog Shipper ${stamp} BV`, consigneeId, consigneeName: `Route Dialog Consignee ${stamp} Inc`,
      principalId: shipperId, principalName: `Route Dialog Shipper ${stamp} BV`, emoOfficeId, imoOfficeId,
    }).then(res => {
      expect(res.status, JSON.stringify(res.body)).to.eq(201);
      const id = res.body.id;
      shipments[key] = id;
      return api("POST", "/containers", { shipmentId: id, containerNumber: `RDCU${String(stamp).slice(-5)}${Object.keys(shipments).length}`,
        size: "40", type: "HC", hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 })
        .then(() => api("PUT", `/shipments/${id}/legs`, { legs: route }))
        .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(200))
        .then(() => vessel && api("POST", `/shipments/${id}/schedules`, {
          carrier: "HLCU", vesselName: vessel, voyageNumber: voyage, pol: "NLRTM", pod: "USNYC", etd: inDays(4), eta: inDays(14),
        }).then(res => expect(res.status, JSON.stringify(res.body)).to.eq(201)));
    });
  // The built-in DCSA carrier confirms the shipment's booking (as in main-vessel-carrier-changes.cy.js).
  const confirmBooking = id => {
    const waitRef = (tries = 40) => api("GET", `/shipments/${id}/carrier-booking`).then(res => {
      if (res.body?.carrierBookingRequestReference && res.body.lastResponseStatus) return res.body.carrierBookingRequestReference;
      if (tries <= 0) throw new Error("No carrier reference");
      return cy.wait(250).then(() => waitRef(tries - 1));
    });
    return api("POST", `/shipments/${id}/edi-messages/booking-request`, {})
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(201))
      .then(() => waitRef())
      .then(ref => api("POST", `/test-tools/dcsa-sim/bookings/${ref}/confirm`, {}))
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(200));
  };
  const seaLeg = (vessel = "", voyage = "") => ({ legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
    polLocType: "Terminal", podLocType: "Terminal", etd: inDays(4), eta: inDays(14), carrierCode: "HLCU", vessel, voyage });

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).then(res => { tok = res.body.token; });
  });
  before(() => {
    ensureOffices(api).then(res => { emoOfficeId = res.emoOfficeId; imoOfficeId = res.imoOfficeId; });
  });
  before(() => {
    api("POST", "/customers", { companyName: `Route Dialog Shipper ${stamp} BV` }).then(res => { shipperId = res.body.id; })
      .then(() => api("POST", "/customers", { companyName: `Route Dialog Consignee ${stamp} Inc` })).then(res => { consigneeId = res.body.id; })
      .then(() => api("POST", "/contracts", { carrierCode: "HLCU", contractNumber, status: "Active", validFrom: "2026-01-01", validTo: "2027-12-31",
        // One line, NLRTM → USNYC, with the carrier's pick-up from a door at NLAMS (shipment A's route).
        legs: [{ pol: "NLRTM", pod: "USNYC", polCarrierHaulage: true, polLocType: "Door", polHaulageLocations: "NLAMS" }] }))
      .then(res => { expect(res.status).to.eq(201); contractId = res.body.id; })
      // A: the carrier picks up in Amsterdam and hauls to the port of loading, then the sea leg.
      .then(() => newShipment("pickup", [
        { legType: "Pick-up", movementType: "Carrier's Haulage", pol: "NLAMS", pod: "NLRTM", polLocType: "Door", podLocType: "Terminal",
          etd: inDays(2), eta: inDays(3), carrierCode: "HLCU" },
        seaLeg(),
      ]))
      // B and C: the sea leg on a saved HLCU sailing.
      .then(() => newShipment("drop", [seaLeg("CY ROUTE DIALOG", "RD1W")], { vessel: "CY ROUTE DIALOG", voyage: "RD1W" }))
      .then(() => newShipment("keep", [seaLeg("CY ROUTE KEEP", "RK1W")], { vessel: "CY ROUTE KEEP", voyage: "RK1W" }))
      // D: the same, with its booking confirmed by the carrier (audit 2026-11-07, A1).
      .then(() => newShipment("booked", [seaLeg("CY ROUTE BOOKED", "RB1W")], { vessel: "CY ROUTE BOOKED", voyage: "RB1W" }))
      .then(() => confirmBooking(shipments.booked));
  });

  after(() => {
    Object.values(shipments).forEach(id => api("DELETE", `/shipments/${id}`));
    if (contractId) api("DELETE", `/contracts/${contractId}`);
    if (shipperId) api("DELETE", `/customers/${shipperId}`);
    if (consigneeId) api("DELETE", `/customers/${consigneeId}`);
  });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.dismissStartupGates();
  });
  const openRoute = id => {
    cy.window().then(win => { win.location.hash = `shipments/${id}/schedules`; });
    cy.dismissStartupGates();
    cy.get('[data-testid="shipment-schedules-route-edit-btn"]', { timeout: 20000 }).click();
    cy.get('[id^="leg-row-"]', { timeout: 10000 }).should("have.length.at.least", 1);
    cy.wait(2000); // the route's late reloads (StrictMode's second fetch) reset the rows; edit after they land
  };

  it("a second Carrier's Haulage pick-up opens the dialog, not a toast, and the row goes back", () => {
    openRoute(shipments.pickup);
    cy.contains("button", "+ Add leg").click();
    cy.get('[data-testid="shipment-form-add-leg-option-pickup"]').click();
    cy.get('[id^="leg-row-"]').should("have.length", 3);
    // The side already has its Carrier's Haulage leg, so the new pick-up is the customer's own (Merchant's Haulage).
    cy.get('[data-testid$="-movementType"] select').filter((_, el) => el.value === "Merchant's Haulage").should("have.length", 1)
      .select("Carrier's Haulage").blur();
    cy.get('[data-testid="shipment-schedules-change-refused-modal"]', { timeout: 8000 })
      .should("contain", "That change wasn't made")
      .and("contain", "A pick-up has at most one Carrier's Haulage leg")
      .and("contain", "The order is:");
    cy.screenshot("route-dialogs-1-refused", { capture: "viewport" });
    cy.get('[data-testid="shipment-schedules-change-refused-ok-btn"]').click();
    cy.get('[data-testid="shipment-schedules-change-refused-modal"]').should("not.exist");
    cy.get('[data-testid$="-movementType"] select').filter((_, el) => el.value === "Merchant's Haulage").should("have.length", 1);
    cy.get('[data-testid$="-movementType"] select').filter((_, el) => el.value === "Carrier's Haulage").should("have.length", 1);
    cy.contains("button", "Discard").click();
  });

  it("a route the contract no longer covers: Save warns in the dialog, Back keeps it, confirming takes the contract off", () => {
    openRoute(shipments.drop);
    cy.get('[data-testid$="-pod"]').first().within(() => { cy.contains("button", "✕").click(); });
    cy.get('[data-testid$="-pod"]').first().find('input[placeholder="Search To…"]').should("be.visible").type("USBAL");
    cy.contains("button", /^USBAL/, { timeout: 10000 }).trigger("mousedown");
    cy.get('[data-testid="shipment-schedules-save-btn"]').click();
    cy.get('[data-testid="shipment-schedules-drop-contract-modal"]', { timeout: 10000 })
      .should("contain", "Save the route?")
      .and("contain", `${contractNumber} comes off this shipment when you save`)
      .and("contain", "doesn't cover NLRTM → USBAL");
    cy.screenshot("route-dialogs-2-drop-warning", { capture: "viewport" });

    // Back: nothing saved, the contract stays.
    cy.get('[data-testid="shipment-schedules-drop-contract-back-btn"]').click();
    cy.get('[data-testid="shipment-schedules-drop-contract-modal"]').should("not.exist");
    api("GET", `/shipments/${shipments.drop}`).then(res => expect(res.body.contractId).to.eq(contractId));

    cy.get('[data-testid="shipment-schedules-save-btn"]').click();
    cy.get('[data-testid="shipment-schedules-drop-contract-save-btn"]', { timeout: 10000 }).click();
    cy.contains(`Saved. ${contractNumber} came off`, { timeout: 15000 }).should("be.visible");
    api("GET", `/shipments/${shipments.drop}`).then(res => {
      expect(res.body.contractType).to.eq("Central");
      expect(res.body.contractId || "").to.eq("");
      expect(res.body.contractRef || "").to.eq("");
    });
    api("GET", `/shipments/${shipments.drop}/legs`).then(res => {
      expect(res.body.filter(l => l.legType === "SEA").map(l => l.pod)).to.deep.eq(["USBAL"]);
    });
    // The contract button is free again, to add one that fits.
    cy.get('[data-testid="shipment-schedules-contract-btn"]', { timeout: 10000 }).should("not.be.disabled").and("contain", "Add Contract");
    cy.screenshot("route-dialogs-3-dropped", { capture: "viewport" });
  });

  it("a contract the carrier has the booking on stays: Save is refused, saying why (audit A1)", () => {
    openRoute(shipments.booked);
    cy.get('[data-testid$="-pod"]').first().within(() => { cy.contains("button", "✕").click(); });
    cy.get('[data-testid$="-pod"]').first().find('input[placeholder="Search To…"]').should("be.visible").type("USBAL");
    cy.contains("button", /^USBAL/, { timeout: 10000 }).trigger("mousedown");
    cy.get('[data-testid="shipment-schedules-save-btn"]').click();
    cy.get('[data-testid="shipment-schedules-validation-errors-modal"]', { timeout: 10000 })
      .should("contain", "Can't save yet").and("contain", "has the booking on it (confirmed)").and("contain", "amend it first");
    cy.get('[data-testid="shipment-schedules-drop-contract-modal"]').should("not.exist");
    cy.screenshot("route-dialogs-4-booked", { capture: "viewport" });
    cy.get('[data-testid="shipment-schedules-validation-discard-btn"]').click();
    api("GET", `/shipments/${shipments.booked}`).then(res => expect(res.body.contractId).to.eq(contractId));
  });

  it("a change the contract still covers saves without the dialog", () => {
    openRoute(shipments.keep);
    cy.get('input[placeholder="Name…"]').first().should("have.value", "CY ROUTE KEEP").clear().type("CY ROUTE KEPT").blur();
    cy.get('[data-testid="shipment-schedules-save-btn"]').click();
    cy.contains("Saved", { timeout: 15000 }).should("be.visible");
    cy.get('[data-testid="shipment-schedules-drop-contract-modal"]').should("not.exist");
    api("GET", `/shipments/${shipments.keep}`).then(res => expect(res.body.contractId).to.eq(contractId));
  });
});
