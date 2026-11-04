/**
 * The » Advance bar on shipment pages (TKT-ACI6J1; approved mockup, style B
 * https://claude.ai/code/artifact/d3c085ee-b430-4948-b9c7-2ed4a14c4b21).
 *   - » runs the same save check as the sidebar, then opens the next row of the tree: walking it
 *     from the first row visits every sidebar row in order, locked pages included (the Carrier
 *     Booking and Customs Filing locks leave the bar reachable), and there's no bar on the last row;
 *   - a failing save check (a half-filled container form on Cargo) keeps the page and flashes the bar;
 *   - Alt+→ does the same, except when a dialog covers the bar.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";
const GROUP_ROWS = ["shp-booking-routing", "shp-export-services", "shp-import-services", "shp-accounting"];

describe("» Advance bar", () => {
  let tok, shipperId, consigneeId, shipmentId, emoOfficeId, imoOfficeId;
  const stamp = Date.now();
  const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).then(res => { tok = res.body.token; });
  });
  before(() => {
    ensureOffices(api).then(res => { emoOfficeId = res.emoOfficeId; imoOfficeId = res.imoOfficeId; });
  });
  before(() => {
    api("POST", "/customers", { companyName: `Advance Bar Shipper ${stamp} BV` }).then(res => { shipperId = res.body.id; })
      .then(() => api("POST", "/customers", { companyName: `Advance Bar Consignee ${stamp} Inc` })).then(res => { consigneeId = res.body.id; })
      // A Central FCL export, Rotterdam to New York, 1 × 40' HC of furniture, with an export VGM and an
      // import delivery ordered — so the tree has an Export Services row and a Delivery Service row.
      .then(() => api("POST", "/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central", contractId: "",
        etd: day(10), eta: day(22), incoterm: "FOB", commodityCode: "9999", cargoReadyDate: day(7),
        shipperId, shipperName: `Advance Bar Shipper ${stamp} BV`, consigneeId, consigneeName: `Advance Bar Consignee ${stamp} Inc`,
        principalId: shipperId, principalName: `Advance Bar Shipper ${stamp} BV`, emoOfficeId, imoOfficeId,
      }))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); shipmentId = res.body.id; })
      .then(() => api("POST", "/containers", { shipmentId, containerNumber: `ADVU${String(stamp).slice(-6)}3`, size: "40", type: "HC",
        hsCode: "940360", cargoDescription: "Wooden dining furniture, flat-packed", grossWeightKg: 9850, volumeCbm: 62 }))
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(201))
      .then(() => api("POST", `/shipments/${shipmentId}/services`, { side: "Export", serviceType: "VGM", requestedDate: day(8) }))
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(201))
      .then(() => api("POST", `/shipments/${shipmentId}/services`, { side: "Import", serviceType: "Delivery", requestedDate: day(23) }))
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
  const bar = () => cy.get('[data-testid="shipment-advance-bar"]', { timeout: 20000 });
  const altRight = () => cy.get("body").trigger("keydown", { key: "ArrowRight", altKey: true });

  it("walks every row of the sidebar tree in order, locked pages included, and has no bar on the last", () => {
    goto(`shipments/${shipmentId}`);
    cy.get('[data-testid="shipment-nav-service-export-vgm"]', { timeout: 20000 }).should("exist");
    cy.get('[data-testid^="shipment-nav-"]').then($rows => {
      const leaves = [...$rows].filter(el => !GROUP_ROWS.includes(el.dataset.testid.replace("shipment-nav-", "")));
      const labels = leaves.map(el => el.dataset.navLabel);
      expect(labels).to.include.members(["Overview", "Carrier Booking", "Customs Filing", "Delivery Service", "VGM", "History"]);

      cy.wrap(leaves[0]).click();
      cy.get(`[data-testid="${leaves[0].dataset.testid}"][aria-current="page"]`, { timeout: 20000 });
      const visited = [labels[0]];
      const step = () => cy.get("body").then($body => {
        const $bar = $body.find('[data-testid="shipment-advance-bar"]');
        if (!$bar.length) return;
        const next = $bar.find('[data-testid="shipment-advance-bar-next"]').text().replace(/^Next · /, "");
        visited.push(next);
        cy.wrap($bar).click();
        // The sidebar now highlights the row » named.
        cy.get(`[data-nav-label="${next}"][aria-current="page"]`, { timeout: 20000 }).should("exist");
        if (visited.length <= labels.length) step();
      });
      // Let the first page's bar render before walking.
      bar().then(() => step()).then(() => {
        expect(visited).to.deep.equal(labels);
        cy.get('[data-testid="shipment-advance-bar"]').should("not.exist");
      });
    });
  });

  it("keeps the page when the save check fails, and says why", () => {
    goto(`shipments/${shipmentId}/containers`);
    bar();
    cy.contains("button", "Add Container", { timeout: 20000 }).click();
    cy.hash().then(before => {
      bar().click();
      bar().should("have.attr", "data-state", "error");
      cy.contains(/Container form has incomplete\/invalid fields/, { timeout: 10000 }).should("be.visible");
      cy.hash().should("eq", before);
    });
    cy.screenshot("advance-bar-1-save-check-failed", { capture: "viewport" });
  });

  it("Alt+→ advances, but not while a dialog covers the bar", () => {
    goto(`shipments/${shipmentId}`);
    bar().find('[data-testid="shipment-advance-bar-next"]').invoke("text").then(text => {
      const next = text.replace(/^Next · /, "");
      cy.contains("button", "Request Service", { timeout: 20000 }).click();
      altRight();
      cy.hash().should("eq", `#shipments/${shipmentId}`);
      cy.get("body").type("{esc}");
      cy.contains("button", "Request Service").should("be.visible");
      altRight();
      cy.get(`[data-nav-label="${next}"][aria-current="page"]`, { timeout: 20000 }).should("exist");
    });
  });
});
