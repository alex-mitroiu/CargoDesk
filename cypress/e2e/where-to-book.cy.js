/**
 * Where to book in the browser (Epic TKT-KFGL81; scope doc https://claude.ai/artifact/X9n2jk6TyGFKfbE7GsWKCy,
 * approved mockup https://claude.ai/artifact/KTkERe9u1qHg1yaESQaCEm, 2026-10-21):
 *   - Space Configurations: a weekly configuration reads "TEU/wk" and its week;
 *   - Lane Steering: the space behind each option, the line's note, and Check;
 *   - Schedules → Change contract: the Where to book panel with #1 pre-selected; booking #2 instead asks
 *     why (out of order), and the shipment's Contract area then says so;
 *   - Dashboard → Steering: the rate and the shipment that didn't follow.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC present in port_locations (EU-N → NAM)
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

describe("Where to book", () => {
  let tok, shipperId, consigneeId, emoOfficeId, imoOfficeId, maeu, hlcu, maeuSpace, lineId, shipmentId;
  const stamp = Date.now();
  const contracts = [];

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });
  const newContract = carrierCode => api("POST", "/contracts", { contractNumber: `WTB-UI-${carrierCode}-${stamp}`, carrierCode, status: "Active",
    validFrom: inDays(-7), validTo: inDays(90), legs: [{ pol: "NLRTM", pod: "USNYC" }],
    rates: [{ serviceCode: "OF", amount: 1850, currency: "USD", unit: "per_container" }] })
    .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); contracts.push(res.body.id); return res.body; });

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).then(res => { tok = res.body.token; });
  });
  before(() => {
    ensureOffices(api).then(res => { emoOfficeId = res.emoOfficeId; imoOfficeId = res.imoOfficeId; });
  });
  before(() => {
    api("POST", "/customers", { companyName: `Where To Book UI Shipper ${stamp} BV` }).then(res => { shipperId = res.body.id; })
      .then(() => api("POST", "/customers", { companyName: `Where To Book UI Consignee ${stamp} Inc` })).then(res => { consigneeId = res.body.id; })
      .then(() => newContract("MAEU")).then(c => { maeu = c; })
      .then(() => newContract("HLCU")).then(c => { hlcu = c; })
      // #1 MAEU holds 4 TEU a week; #2 HLCU has no space configured (order only).
      .then(() => api("POST", "/allocations", { contractId: maeu.id, routingIds: [maeu.routings[0].id], allocatedTEU: 4, spaceBasis: "week",
        effectiveDate: inDays(-7), endDate: inDays(90) }))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); maeuSpace = res.body; })
      .then(() => api("POST", "/lane-steerings", { originLane: "EU-N", destLane: "NAM", validFrom: inDays(-7), validTo: inDays(90),
        note: `MAEU first, UI ${stamp}`, options: [{ carrierCode: "MAEU", contractId: maeu.id }, { carrierCode: "HLCU", contractId: hlcu.id, note: "Only when MAEU is full" }] }))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); lineId = res.body.id; })
      // A Central shipment sailing today, 1 × 40' HC, no contract yet.
      .then(() => api("POST", "/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central", contractId: "",
        etd: inDays(0), eta: inDays(12), incoterm: "FOB", commodityCode: "9999", cargoReadyDate: inDays(-2),
        shipperId, shipperName: `Where To Book UI Shipper ${stamp} BV`, consigneeId, consigneeName: `Where To Book UI Consignee ${stamp} Inc`,
        principalId: shipperId, principalName: `Where To Book UI Shipper ${stamp} BV`, emoOfficeId, imoOfficeId,
      }))
      .then(res => { expect(res.status).to.eq(201); shipmentId = res.body.id; })
      .then(() => api("POST", "/containers", { shipmentId, containerNumber: `WTBU${String(stamp).slice(-6)}1`, size: "40", type: "HC",
        hsCode: "940360", cargoDescription: "Flat-pack furniture", grossWeightKg: 9000, volumeCbm: 60 }));
  });

  // Steering and space on a real lane change what other shipments are offered, so none of it outlives the run.
  after(() => {
    if (lineId) api("DELETE", `/lane-steerings/${lineId}`);
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
    if (maeuSpace) api("DELETE", `/allocations/${maeuSpace.id}`);
    contracts.forEach(id => api("DELETE", `/contracts/${id}`));
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

  it("a weekly space configuration reads TEU/wk and its week", () => {
    goto("space-configs");
    cy.get(`[data-testid="space-row-week-${maeuSpace.id}"]`, { timeout: 20000 }).should("contain", "Week ").scrollIntoView();
    cy.get(`[data-testid="space-row-week-${maeuSpace.id}"]`).parent().should("contain", "4 TEU/wk");
    cy.screenshot("wtb-1-weekly-row", { capture: "viewport" });
  });

  it("Lane Steering shows the space behind each option, the line's note, and Check", () => {
    goto("mdm-lane-steering");
    cy.contains("Everyone", { timeout: 20000 });
    cy.get('[data-testid="lane-steering-check"]').click();
    cy.get('[data-testid="lane-steering-check-modal"]').within(() => {
      cy.get('input[placeholder="Search port or LOCODE…"]').eq(0).type("NLRTM");
    });
    cy.contains("NLRTM", { timeout: 10000 }).filter(":visible").last().click();
    cy.get('[data-testid="lane-steering-check-modal"]').within(() => {
      // The picked POL is a chip now: the one search box left is POD's.
      cy.get('input[placeholder="Search port or LOCODE…"]').last().type("USNYC");
    });
    cy.contains("USNYC", { timeout: 10000 }).filter(":visible").last().click();
    cy.get('[data-testid="lane-steering-check-run"]').click();
    cy.get('[data-testid="lane-steering-check-modal"] [data-testid="where-to-book"]', { timeout: 15000 }).within(() => {
      cy.get('[data-testid="where-to-book-option-1"]').should("contain", "THE PICK").and("contain", "4 TEU a week");
      cy.get('[data-testid="where-to-book-option-2"]').should("contain", "order only");
      cy.get('[data-testid="where-to-book-line-note"]').should("contain", `MAEU first, UI ${stamp}`);
    });
    cy.screenshot("wtb-2-check", { capture: "viewport" });
  });

  it("assigning the contract: #1 pre-selected; #2 instead asks why, and the shipment says out of order", () => {
    goto(`shipments/${shipmentId}/schedules`);
    cy.get('[data-testid="shipment-schedules-contract-btn"]', { timeout: 20000 }).click();
    cy.get('[data-testid="where-to-book"]', { timeout: 20000 }).should("be.visible");
    // Not on MAEU's space yet: all 4 TEU of the week are free.
    cy.get('[data-testid="where-to-book-option-1"]').should("contain", "THE PICK").and("contain", "4 of 4 TEU free");
    cy.get('[data-testid="where-to-book-book-1"]').should("contain", "Selected — confirm below");
    cy.get('[data-testid="where-to-book-option-2"]').should("contain", "Only when MAEU is full");
    cy.screenshot("wtb-3-panel", { capture: "viewport" });

    cy.get('[data-testid="where-to-book-book-2"]').click();
    cy.get('[data-testid="shipment-form-contract-picker-confirm-btn"]').click();
    cy.get('[data-testid="steering-warning-dialog"]').should("be.visible").and("contain", "#1 MAEU").and("contain", "4 TEU free");
    cy.get('[data-testid="steering-warning-anyway"]').should("be.disabled");
    cy.get('[data-testid="steering-warning-reason"]').type("The customer asked for Hapag-Lloyd");
    cy.screenshot("wtb-4-warning", { capture: "viewport" });
    cy.get('[data-testid="steering-warning-anyway"]').click();

    // Picking a contract chains into the sailing search; leave it without a sailing.
    cy.get("body").then($b => {
      if ($b.find('[data-testid="shipment-schedules-confirm-close-sailing-close-btn"]').length === 0) cy.get("body").type("{esc}");
    });
    cy.get("body").then($b => {
      if ($b.find('[data-testid="shipment-schedules-confirm-close-sailing-close-btn"]').length) cy.get('[data-testid="shipment-schedules-confirm-close-sailing-close-btn"]').click();
    });
    cy.get('[data-testid="shipment-schedules-steering-chip"]', { timeout: 20000 }).should("contain", "#2 of 2 · out of order").scrollIntoView();
    cy.screenshot("wtb-5-chip", { capture: "viewport" });
    api("GET", `/shipments/${shipmentId}`).then(res => {
      expect(res.body.steeringVerdict).to.eq("out_of_order");
      expect(res.body.steeringReason).to.eq("The customer asked for Hapag-Lloyd");
    });
  });

  it("Dashboard → Steering counts it", () => {
    goto("dashboard");
    cy.get('[data-testid="dashboard-tab-steering"]', { timeout: 20000 }).click();
    cy.get('[data-testid="steering-report"]', { timeout: 20000 }).should("be.visible");
    cy.get('[data-testid="steering-report-count-out_of_order"]').invoke("text").should("match", /Out of order [1-9]/);
    cy.get('[data-testid="steering-report-not-followed"]').should("contain", shipmentId).and("contain", "The customer asked for Hapag-Lloyd");
    cy.screenshot("wtb-6-dashboard", { capture: "viewport" });
  });
});
