/**
 * Lane steering (Epic TKT-ASIYFL, Story 5 TKT-SWD5LM; approved mockup
 * https://claude.ai/artifact/FXrT7utJNRgPabknbKyPmR, "Lane Steering" artboard).
 *   - Master Data → Lane Steering: add EU-N → NAM for everyone through the pop-up — trades, validity,
 *     the no-answer switch, two options picked by carrier and contract, reordered — and see it listed;
 *   - an escalation on that lane offers the steering's options first, in that order, and the handler can
 *     switch to the contract search and back;
 *   - edit it from the row menu, read its history, and remove it.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173), not in production (the built-in DCSA carrier plays CMDU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Lane steering", () => {
  let tok, shipmentId, shipperId, consigneeId, allocationId;
  let emoOfficeId, imoOfficeId;
  const contracts = {};
  const stamp = Date.now();

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });
  const ours = list => (Array.isArray(list) ? list : []).filter(s => s.options.some(o => Object.values(contracts).includes(o.contractId)));

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; });
  });

  before(() => {
    ensureOffices(api).then(res => { emoOfficeId = res.emoOfficeId; imoOfficeId = res.imoOfficeId; });
  });

  // Two Central contracts on NLRTM → USNYC (MSCU with space, CMDU without) and a CMDU shipment the
  // carrier rejected, escalated to OCC/AY.
  before(() => {
    ["MSCU", "CMDU"].forEach(code => {
      api("POST", "/contracts", { carrierCode: code, contractNumber: `CY-LS-${code}-${stamp}`, status: "Active",
        validFrom: "2026-01-01", validTo: "2027-06-30", legs: [{ pol: "NLRTM", pod: "USNYC" }] })
        .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); contracts[code] = res.body.id; });
    });
    cy.then(() => api("GET", `/contracts/${contracts.MSCU}`))
      .then(res => api("POST", "/allocations", { contractId: contracts.MSCU, routingIds: [res.body.routings[0].id], allocatedTEU: 20,
        effectiveDate: "2026-10-01", endDate: "2026-12-31" }))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); allocationId = res.body.id; });

    cy.then(() => api("POST", "/customers", { companyName: `Steering Shipper ${stamp} BV` })).then(res => { shipperId = res.body.id; })
      .then(() => api("POST", "/customers", { companyName: `Steering Consignee ${stamp} Inc` })).then(res => { consigneeId = res.body.id; })
      .then(() => api("POST", "/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "CMDU", status: "Active", contractType: "SPOT", contractRef: `SPOT-LS-${stamp}`,
        etd: "2026-11-16", eta: "2026-11-30", incoterm: "FOB", commodityCode: "9999",
        shipperId, shipperName: `Steering Shipper ${stamp} BV`, consigneeId, consigneeName: `Steering Consignee ${stamp} Inc`,
        principalId: shipperId, principalName: `Steering Shipper ${stamp} BV`, emoOfficeId, imoOfficeId,
      }))
      .then(res => {
        expect(res.status).to.eq(201);
        shipmentId = res.body.id;
        return api("POST", "/containers", { shipmentId, containerNumber: `LSTU${String(stamp).slice(-7)}`, size: "40", type: "HC",
          hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 });
      })
      .then(() => api("POST", `/shipments/${shipmentId}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
        etd: "2026-11-16", eta: "2026-11-30", carrierCode: "CMDU", vessel: "CMA CGM STEERING", vesselImo: "9999995", voyage: "0LS2W" }))
      .then(() => api("POST", `/shipments/${shipmentId}/edi-messages/booking-request`, {}))
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(201));
    const reject = (tries = 40) => api("GET", `/shipments/${shipmentId}/carrier-booking`).then(res => {
      const ref = res.body?.carrierBookingRequestReference;
      if (ref && res.body.lastResponseStatus) return api("POST", `/test-tools/dcsa-sim/bookings/${ref}/reject`, { message: "No space on 0LS2W" });
      if (tries <= 0) throw new Error("No carrier reference");
      return cy.wait(250).then(() => reject(tries - 1));
    });
    cy.then(() => reject())
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(200))
      .then(() => api("POST", `/shipments/${shipmentId}/escalations`, { toRole: "occ_ay", note: "Any Central contract is fine" }))
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(201));
  });

  after(() => {
    // Steering and space on a real lane change what other shipments are offered: none of it stays.
    api("GET", "/lane-steerings").then(res => ours(res.body).forEach(s => api("DELETE", `/lane-steerings/${s.id}`)));
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
    if (shipperId) api("DELETE", `/customers/${shipperId}`);
    if (consigneeId) api("DELETE", `/customers/${consigneeId}`);
    if (allocationId) api("DELETE", `/allocations/${allocationId}`);
    cy.then(() => Object.values(contracts).forEach(id => api("DELETE", `/contracts/${id}`)));
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
  // The row's own ActionMenu gear (its last button).
  const openRowMenu = () => cy.get('[data-testid^="lane-steering-row-"]').first().find("button").last().click();
  const addOption = code => {
    cy.get('[data-testid="lane-steering-add-option"]').click();
    cy.get('[data-testid="lane-steering-add-row"]').within(() => {
      cy.get('input[placeholder="Search carrier code or name…"]').type(code);
    });
    cy.contains("button", new RegExp(`^${code}`)).trigger("mousedown");
    cy.get("#ls-new-contract", { timeout: 10000 }).should("not.be.disabled").find("option").contains(`CY-LS-${code}-${stamp}`)
      .then($o => cy.get("#ls-new-contract").select($o.val()));
    cy.get('[data-testid="lane-steering-add-confirm"]').click();
  };

  it("adds EU-N → NAM for everyone through the pop-up", () => {
    // Reached from Master Data in the sidebar, beside Contracts.
    cy.get('[data-testid="main-nav"]').then($nav => {
      if (!$nav.text().includes("Lane Steering")) cy.get('[data-testid="main-nav"]').contains("button", "Master Data").click();
    });
    cy.get('[data-testid="main-nav"]').contains("button", "Lane Steering").click();
    cy.contains("h1", "Lane Steering", { timeout: 15000 }).should("be.visible");
    cy.get('[data-testid="lane-steering-new"]').should("contain", "＋ Add Lane Steering").click();
    cy.get('[data-testid="lane-steering-modal"]').within(() => {
      cy.get("#ls-origin").select("EU-N");
      cy.get("#ls-dest").select("NAM");
      cy.get("#ls-to > button").click();
      // The calendar is portaled to <body> (DatePicker.jsx), outside this within() scope.
      const calendar = () => cy.get("#ls-to-calendar", { withinSubject: null });
      // Page forward to December (2026-12-31, the date asserted below). It opens on the current month, so a
      // fixed number of clicks only worked in the month the spec was written (two from October).
      const toDecember = (clicks = 0) => calendar().find("button").then($buttons => {
        if ([...$buttons].some(b => b.textContent.trim() === "December")) return;
        if (clicks >= 12) throw new Error("the calendar never reached December");
        calendar().contains("button", "›").click();
        toDecember(clicks + 1);
      });
      toDecember();
      calendar().contains("button", /^December$/).should("be.visible");
      calendar().contains("button", /^31$/).click();
      cy.get('[data-testid="lane-steering-switch"]').should("have.attr", "aria-checked", "false").click().should("have.attr", "aria-checked", "true");
      cy.contains("No options yet").should("be.visible");
      cy.get('[data-testid="lane-steering-save"]').should("be.disabled");
    });
    addOption("MSCU");
    addOption("CMDU");
    cy.get('[data-testid="lane-steering-option-2"]').should("contain", "CMDU").find('button[aria-label="Move option 2 up"]').click();
    cy.get('[data-testid="lane-steering-option-1"]').should("contain", "CMDU").and("contain", "CENTRAL");
    cy.get('[data-testid="lane-steering-option-2"]').should("contain", "MSCU").find('input[aria-label="Note for option 2"]').type("Space configured to the end of the year");
    cy.screenshot("lane-steering-1-modal", { capture: "viewport" });
    cy.get('[data-testid="lane-steering-save"]').click();
    cy.get('[data-testid="lane-steering-modal"]').should("not.exist");
    cy.contains("1 steered lane").should("be.visible");
    cy.get('[data-testid^="lane-steering-row-"]').should("have.length", 1).first().should("contain", "Everyone").and("contain", "ON");
    cy.contains("#1").parent().should("contain", "CMDU");
    cy.contains("2026-12-31").should("be.visible");
    cy.screenshot("lane-steering-2-list", { capture: "viewport" });
    api("GET", "/lane-steerings").then(res => {
      const [s] = ours(res.body);
      expect(s.originLane).to.eq("EU-N");
      expect(s.destLane).to.eq("NAM");
      expect(s.validTo).to.eq("2026-12-31");
      expect(s.autoSwitch).to.eq(true);
      expect(s.options.map(o => o.carrierCode)).to.deep.eq(["CMDU", "MSCU"]);
      expect(s.options[1].note).to.eq("Space configured to the end of the year");
    });
  });

  it("the escalation on that lane offers the steering first, and the contract search on request", () => {
    goto(`shipments/${shipmentId}/booking/review`);
    cy.get('[data-testid="escalation-alternatives-source"]', { timeout: 15000 }).should("contain", "LANE STEERING EU-N → NAM");
    cy.get('[data-testid="escalation-option-1"]').should("contain", "CMDU").and("contain", "No space configured on this route");
    cy.get('[data-testid="escalation-option-2"]').should("contain", "MSCU").and("contain", "Space configured to the end of the year");
    cy.screenshot("lane-steering-3-escalation", { capture: "viewport" });
    cy.get('[data-testid="escalation-alternatives-switch"]').should("contain", "Search all contracts instead").click();
    cy.get('[data-testid="escalation-alternatives-source"]').should("contain", "CONTRACT SEARCH");
    cy.get('[data-testid="escalation-option-1"]').should("contain", "MSCU");
    cy.get('[data-testid="escalation-alternatives-switch"]').should("contain", "Back to the lane steering").click();
    cy.get('[data-testid="escalation-alternatives-source"]').should("contain", "LANE STEERING");
  });

  it("edits it from the row menu, shows its history, and removes it", () => {
    goto("mdm-lane-steering");
    cy.contains("1 steered lane", { timeout: 15000 }).should("be.visible");
    openRowMenu();
    cy.contains("button", "Edit").click();
    cy.get('[data-testid="lane-steering-modal"]').should("contain", "Edit Lane Steering — EU-N → NAM").within(() => {
      cy.get('[data-testid="lane-steering-option-2"]').find('button[aria-label="Move option 2 up"]').click();
      cy.get('[data-testid="lane-steering-option-1"]').should("contain", "MSCU");
      cy.get('[data-testid="lane-steering-save"]').click();
    });
    cy.get('[data-testid="lane-steering-modal"]').should("not.exist");
    cy.contains("#1").parent().should("contain", "MSCU");

    openRowMenu();
    cy.contains("button", "History").click();
    cy.contains("Lane Steering History — EU-N → NAM").should("be.visible");
    cy.contains(/CREATED/i).should("exist");
    cy.contains(/#1 MSCU/).should("exist");
    cy.screenshot("lane-steering-4-history", { capture: "viewport" });
    cy.get("body").type("{esc}");

    openRowMenu();
    cy.contains("button", "Delete").click();
    cy.get('[data-testid="lane-steering-delete-confirm"]').click();
    cy.contains("0 steered lanes", { timeout: 10000 }).should("be.visible");
    cy.contains("No lane is steered yet").should("be.visible");
  });
});
