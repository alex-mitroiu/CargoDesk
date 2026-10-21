/**
 * Booking escalation in the shipment (Epic TKT-ASIYFL, Stories 2-4; agreed 2026-10-20, approved mockup
 * https://claude.ai/artifact/FXrT7utJNRgPabknbKyPmR). One rejected booking, handled end to end by the
 * people who would really handle it, each logged in as themselves:
 *   - OCC/BK of the export office escalates it from Booking & Review, picking OCC/AY in the pop-up;
 *   - OCC/AY finds it under Shipments → Escalated to me (Booking column: ESCALATED), opens it and hands
 *     it over to CCL/CO with a message;
 *   - CCL/CO gets it in the bell, opens it, picks the Central alternative and a sailing, and sends the
 *     instructions back;
 *   - OCC/BK sees INSTRUCTIONS READY in the Booking column, reviews them in the Book As Instructed
 *     pop-up and books; the new carrier confirms and the escalation is resolved.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173), not in production (the built-in DCSA carrier plays CMDU and MSCU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";
const PASSWORD       = "EscCypress!2026Zq";

describe("Booking escalation in the shipment", () => {
  let tok, shipmentId, shipperId, consigneeId, contractId, allocationId;
  let emoOfficeId, imoOfficeId;
  const stamp = Date.now();
  const people = {
    occbk: { roles: ["occ_bk"], office: "emo" },
    occay: { roles: ["occ_ay"], office: "emo" },
    cclco: { roles: ["ccl_co"], office: "imo" },
  };
  const emailOf = key => `cy-esc-${key}-${stamp}@test.local`;

  const api = (method, path, body, token = tok) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });
  const asList = body => (Array.isArray(body) ? body : (body?.results ?? []));

  // The shipment's booking once the carrier has issued its request reference (the simulator's
  // RECEIVED notification has been applied) — the Cypress twin of tests/helpers/dcsa-sim.mjs.
  const waitForCarrierReference = (tries = 40) =>
    api("GET", `/shipments/${shipmentId}/carrier-booking`).then(res => {
      const b = res.body;
      if (b?.carrierBookingRequestReference && b.lastResponseStatus && b.lastResponseStatus !== "send_failed") return b;
      if (tries <= 0) throw new Error(`No carrier reference on ${shipmentId}'s booking (${b?.lastResponseStatus || "none"})`);
      return cy.wait(250).then(() => waitForCarrierReference(tries - 1));
    });
  const carrierActs = (action, message = "") =>
    waitForCarrierReference().then(b =>
      api("POST", `/test-tools/dcsa-sim/bookings/${b.carrierBookingRequestReference}/${action}`, message ? { message } : {}))
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(200));

  const loginAs = key => {
    cy.loginSession(emailOf(key), PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.dismissStartupGates();
  };
  const goto = hash => {
    cy.window().then(win => { win.location.hash = hash; });
    cy.dismissStartupGates();
  };

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; });
  });

  before(() => {
    ensureOffices(api).then(res => { emoOfficeId = res.emoOfficeId; imoOfficeId = res.imoOfficeId; });
  });

  // OCC/BK and OCC/AY of the export office, CCL/CO of the import office: one office each, so the app
  // selects it on login without the office picker.
  before(() => {
    Object.entries(people).forEach(([key, p]) => {
      api("POST", "/users", { email: emailOf(key), name: `${p.roles[0].toUpperCase().replace("_", "/")} Cypress ${stamp}`, roles: p.roles, password: PASSWORD })
        .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(201))
        .then(() => api("GET", "/users"))
        .then(res => {
          p.id = asList(res.body).find(u => u.email === emailOf(key)).id;
          return api("POST", `/users/${p.id}/offices`, { officeId: p.office === "emo" ? emoOfficeId : imoOfficeId });
        })
        .then(res => expect(res.status, JSON.stringify(res.body)).to.be.oneOf([200, 201]));
    });
  });

  // A Central MSCU contract with space on NLRTM → USNYC, so the handler has an alternative to pick.
  before(() => {
    api("POST", "/contracts", { carrierCode: "MSCU", contractNumber: `CY-ESC-MSCU-${stamp}`, status: "Active",
      validFrom: "2026-01-01", validTo: "2027-12-31", legs: [{ pol: "NLRTM", pod: "USNYC" }] })
      .then(res => {
        expect(res.status, JSON.stringify(res.body)).to.eq(201);
        contractId = res.body.id;
        return api("POST", "/allocations", { contractId, routingIds: [res.body.routings[0].id], allocatedTEU: 20,
          effectiveDate: "2026-10-01", endDate: "2026-12-31" });
      })
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); allocationId = res.body.id; });
  });

  // A realistic CMDU shipment, sent to the carrier and rejected by it.
  before(() => {
    cy.then(() => api("POST", "/customers", { companyName: `Escalation Shipper ${stamp} BV` })).then(res => { shipperId = res.body.id; })
      .then(() => api("POST", "/customers", { companyName: `Escalation Consignee ${stamp} Inc` })).then(res => { consigneeId = res.body.id; })
      .then(() => api("POST", "/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "CMDU", status: "Active", contractType: "SPOT", contractRef: `SPOT-ESC-${stamp}`,
        etd: "2026-11-16", eta: "2026-11-30", incoterm: "FOB", commodityCode: "9999",
        shipperId, shipperName: `Escalation Shipper ${stamp} BV`, consigneeId, consigneeName: `Escalation Consignee ${stamp} Inc`,
        principalId: shipperId, principalName: `Escalation Shipper ${stamp} BV`, emoOfficeId, imoOfficeId,
      }))
      .then(res => {
        expect(res.status).to.eq(201);
        shipmentId = res.body.id;
        return api("POST", "/containers", { shipmentId, containerNumber: `ESCU${String(stamp).slice(-7)}`, size: "40", type: "HC",
          hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 });
      })
      .then(res => {
        expect(res.status).to.eq(201);
        return api("POST", `/shipments/${shipmentId}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
          etd: "2026-11-16", eta: "2026-11-30", carrierCode: "CMDU", vessel: "CMA CGM ESCALATION", vesselImo: "9999995", voyage: "0ES1W" });
      })
      .then(res => {
        expect(res.status).to.eq(201);
        return api("POST", `/shipments/${shipmentId}/edi-messages/booking-request`, {});
      })
      .then(res => {
        expect(res.status, JSON.stringify(res.body)).to.eq(201);
        return carrierActs("reject", "No space on 0ES1W");
      });
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
    if (shipperId) api("DELETE", `/customers/${shipperId}`);
    if (consigneeId) api("DELETE", `/customers/${consigneeId}`);
    // Space on a real lane changes what other shipments match, so it doesn't outlive the spec.
    if (allocationId) api("DELETE", `/allocations/${allocationId}`);
    if (contractId) api("DELETE", `/contracts/${contractId}`);
    Object.values(people).forEach(p => { if (p.id) api("DELETE", `/users/${p.id}`); });
  });

  it("OCC/BK escalates the rejected booking to OCC/AY from Booking & Review", () => {
    loginAs("occbk");
    goto(`shipments/${shipmentId}/booking/review`);
    cy.get('[data-testid="escalate-btn"]', { timeout: 15000 }).should("be.visible").click();
    cy.get('[data-testid="escalate-modal"]').within(() => {
      cy.contains("REJECTED").should("be.visible");
      cy.get('[data-testid="escalate-to-occ_ay"] input').should("be.checked");
      cy.get('[data-testid="escalate-to-ccl_co"]').should("be.visible");
      cy.get('[data-testid="escalate-note"]').type("Needed in New York by 10 Dec");
      cy.get('[data-testid="escalate-submit"]').should("contain", "Escalate to OCC/AY").click();
    });
    cy.get('[data-testid="escalate-modal"]').should("not.exist");
    cy.get('[data-testid="escalation-holder"]', { timeout: 10000 }).should("contain", "WITH OCC/AY");
    cy.get('[data-testid="escalate-btn"]').should("not.exist");
    cy.get('[data-testid="escalation-action-withdraw"]').should("be.visible");
    cy.screenshot("booking-escalation-1-occbk-escalated", { capture: "viewport" });
  });

  it("OCC/AY finds it under Escalated to me and hands it over to CCL/CO", () => {
    loginAs("occay");
    goto("shipments");
    cy.get('[data-testid="booking-quick-mine"]', { timeout: 15000 }).click();
    cy.get(`[data-testid="booking-cell-${shipmentId}"]`, { timeout: 15000 })
      .should("contain", "ESCALATED")
      .and("contain", "Rejected · OCC/AY");
    cy.screenshot("booking-escalation-2-occay-list", { capture: "viewport" });

    goto(`shipments/${shipmentId}/booking/review`);
    cy.get('[data-testid="escalation-panel"]', { timeout: 15000 }).within(() => {
      cy.contains("Needed in New York by 10 Dec").should("be.visible");
      cy.get('[data-testid="escalation-option-1"]', { timeout: 10000 }).should("contain", "MSCU").and("contain", `CY-ESC-MSCU-${stamp}`);
      cy.get('[data-testid="escalation-sailing-0"]', { timeout: 10000 }).should("be.visible");
      cy.get('[data-testid="escalation-action-instruct"]').should("not.be.disabled");
      cy.get('[data-testid="escalation-message"]').type("Consignee side first");
    });
    cy.screenshot("booking-escalation-3-occay-panel", { capture: "viewport" });
    cy.get('[data-testid="escalation-action-hand_over"]').should("contain", "Hand over to CCL/CO").click();
    cy.get('[data-testid="escalation-holder"]', { timeout: 10000 }).should("contain", "WITH CCL/CO");
    cy.get('[data-testid="escalation-action-instruct"]').should("not.exist");
  });

  it("CCL/CO opens it from the bell and sends instructions back to OCC/BK", () => {
    loginAs("cclco");
    cy.get('button[title*="notification"]', { timeout: 15000 }).should("not.be.disabled").click();
    cy.contains("Escalated to you").should("be.visible");
    cy.get(`[data-testid="bell-escalation-${shipmentId}"]`).should("contain", "Rejected").find("button").first().click();
    cy.get('[data-testid="escalation-panel"]', { timeout: 15000 }).within(() => {
      cy.get('[data-testid="escalation-holder"]').should("contain", "WITH CCL/CO");
      cy.get('[data-testid="escalation-steps"] summary').click();
      cy.get('[data-testid="escalation-steps"]').should("contain", "Consignee side first");
      cy.get('[data-testid="escalation-option-1"] input[type="radio"]', { timeout: 10000 }).should("be.checked");
      // The sailing with the shortest transit is labelled RECOMMENDED and picked by default.
      cy.get('[data-testid^="escalation-sailing-recommended-"]', { timeout: 10000 }).should("have.length", 1).and("contain", "RECOMMENDED")
        .invoke("attr", "data-testid").then(id => cy.get(`[data-testid="escalation-sailing-${id.split("-").pop()}"] input`).should("be.checked"));
      cy.get('[data-testid="escalation-option-1"]').scrollIntoView();
      cy.screenshot("booking-escalation-3b-recommended", { capture: "viewport" });
      cy.get('[data-testid="escalation-message"]').type("MSCU has Central space the same week");
      cy.get('[data-testid="escalation-action-instruct"]').click();
    });
    cy.get('[data-testid="escalation-holder"]', { timeout: 10000 }).should("contain", "WITH OCC/BK");
    cy.get('[data-testid="escalation-instructions"]').should("contain", "Instructions from CCL/CO").and("contain", "MSCU");
    cy.get('[data-testid="escalation-action-book"]').should("not.exist");
    cy.screenshot("booking-escalation-4-cclco-instructed", { capture: "viewport" });
  });

  it("OCC/BK sees Instructions ready, reviews them and books as instructed", () => {
    loginAs("occbk");
    goto("shipments");
    cy.get('[data-testid="booking-quick-instr"]', { timeout: 15000 }).click();
    cy.get(`[data-testid="booking-cell-${shipmentId}"]`, { timeout: 15000 })
      .should("contain", "INSTRUCTIONS READY")
      .and("contain", "From CCL/CO");

    goto(`shipments/${shipmentId}/booking/review`);
    cy.get('[data-testid="escalation-action-book"]', { timeout: 15000 }).should("contain", "Review and Book As Instructed").click();
    cy.get('[data-testid="book-as-instructed-modal"]').within(() => {
      cy.contains("MSCU").should("be.visible");
      cy.contains(`CY-ESC-MSCU-${stamp}`).should("be.visible");
      cy.contains("Instructed by").should("contain", "CCL/CO");
    });
    cy.screenshot("booking-escalation-5-book-as-instructed", { capture: "viewport" });
    cy.get('[data-testid="book-as-instructed-submit"]').click();
    cy.get('[data-testid="book-as-instructed-modal"]', { timeout: 15000 }).should("not.exist");
    cy.get('[data-testid="escalation-booked"]', { timeout: 15000 }).should("contain", "waiting for MSCU to confirm");

    api("GET", `/shipments/${shipmentId}`).then(res => {
      expect(res.body.carrierCode).to.eq("MSCU");
      expect(res.body.contractType).to.eq("Central");
      expect(res.body.contractId).to.eq(contractId);
    });
  });

  it("MSCU confirms: the escalation is resolved and the Booking column says Confirmed", () => {
    carrierActs("confirm");
    loginAs("occbk");
    goto(`shipments/${shipmentId}/booking/review`);
    cy.get('[data-testid="escalation-holder"]', { timeout: 15000 }).should("contain", "RESOLVED");
    cy.screenshot("booking-escalation-6-resolved", { capture: "viewport" });
    goto("shipments");
    cy.get('[data-testid="booking-quick-all"]', { timeout: 15000 }).should("be.visible");
    api("GET", `/shipments?limit=50&offset=0&search=${shipmentId}&booking=Confirmed`).then(res => {
      const row = res.body.results.find(x => x.id === shipmentId);
      expect(row?.bookingState?.label, JSON.stringify(row?.bookingState)).to.eq("Confirmed");
    });
  });
});
