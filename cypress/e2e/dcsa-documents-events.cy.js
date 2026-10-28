/**
 * DCSA everywhere, phases 4–6 — the screens (2026-10-28; approved mockup https://claude.ai/artifact/VUTPKnRAjdPjfb8DntUxVs).
 *
 *  - Shipping Instructions: the carrier's Master B/L card — folded and unfolded, the critical facts first,
 *    "Show all N fields" for the field-by-field comparison, Approve draft;
 *  - VGM: each container's declarations, "No evidence on file" until the evidence is attached, Generate VG01;
 *  - Milestones & Events: the sea leg's times marked by source, each milestone's DCSA events, the carrier's
 *    Track & Trace events with what CargoDesk did with them;
 *  - Test Tools → DCSA Carrier: Shipping Instructions & B/L (issue), Track & Trace (report), Vessel times.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173), not in production (the built-in DCSA carrier is always on there)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("DCSA documents and events screens", () => {
  let tok, shipmentId, siRef, branchId, officeId, imoOfficeId;
  const customers = [];
  const containers = [];
  const stamp = Date.now();
  const rand = String(stamp).slice(-5);
  const voyage = `52${rand.slice(-2)}W`;
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });
  const waitFor = (path, pred, tries = 30) => api("GET", path).then(res => (pred(res.body) || tries <= 0 ? res : cy.wait(250).then(() => waitFor(path, pred, tries - 1))));

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).then(res => { tok = res.body.token; });
  });

  // A complete NLRTM → USNYC shipment on MAEU (played by the demo carrier): its export office's legal entity
  // has the contact the carrier is given, the consignee an LEI, two sealed 40' HCs; booked and confirmed,
  // Shipping Instructions submitted and drafted into a Master B/L, VGM declared, Track & Trace reported.
  before(() => {
    ensureOffices(api).then(res => { imoOfficeId = res.imoOfficeId; });
    const customer = (companyName, address1, postalCode, city, countryIso2, extra = {}) =>
      api("POST", "/customers", { companyName, address1, postalCode, city, countryIso2, ...extra }).then(res => { customers.push(res.body); return res.body; });
    cy.then(() => api("POST", "/branches", { code: `CYD${rand}`, name: `CargoDesk Logistics Rotterdam ${rand} BV`, countryCode: "NL", city: "Rotterdam",
      address: "Wilhelminakade 909", locode: "NLRTM", currency: "EUR", email: "export.rotterdam@cargodesk.example", phone: "+31 10 555 0142", scac: "CDLR" }))
      .then(res => { branchId = res.body.id; })
      .then(() => api("POST", "/offices", { unlocode: `NLC${String.fromCharCode(65 + (stamp % 26))}${String.fromCharCode(65 + ((stamp >> 5) % 26))}`,
        countryCode: "NL", department: "SE", name: `Rotterdam Export DCSA ${rand}`, branchId }))
      .then(res => { officeId = res.body.id; })
      .then(() => customer(`Van Leeuwen Meubelen ${rand} BV`, "Waalhaven Oostzijde 81", "3087 BM", "Rotterdam", "NL", { email: "logistics@vanleeuwen.example", phone: "+31 10 428 1100" }))
      .then(() => customer(`Hudson Home Imports ${rand} Inc`, "250 Port Jersey Blvd", "07305", "Jersey City", "US"))
      .then(c => api("POST", `/customers/${c.id}/identifiers`, { idType: "LEI", idCode: `5493001KJTIIGC8Y1R${rand.slice(-2)}`, countryIso2: "US" }))
      .then(() => {
        const [shipper, consignee] = customers;
        return api("POST", "/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central", contractRef: "MAEU-SC-2026-0418",
          etd: day(-2), eta: day(11), incoterm: "FOB", commodityCode: "9999", freightTerms: "Prepaid", masterBlReleaseType: "Original",
          shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
          principalId: shipper.id, principalName: shipper.companyName, emoOfficeId: officeId, imoOfficeId });
      })
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); shipmentId = res.body.id; })
      .then(() => api("POST", `/shipments/${shipmentId}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: day(-2), eta: day(11),
        carrierCode: "MAEU", vessel: "MAERSK KENSINGTON", vesselImo: "9333022", voyage }))
      .then(() => [0, 1].reduce((chain, i) => chain.then(() => api("POST", "/containers", { shipmentId, containerNumber: `MSKU${rand}${i}${i}`,
        sealNumber: `ML-${rand}${i}`, size: "40", type: "HC", hsCode: "940360", cargoDescription: "Wooden dining furniture, flat-packed",
        marksAndNumbers: `VLF/NYC ${i * 120 + 1}-${(i + 1) * 120}`, grossWeightKg: 11850 + i * 1090, volumeCbm: 64, numberOfPackages: 120, packageCode: "CT" })
        .then(res => { containers.push(res.body); })), cy.wrap(null)))
      .then(() => api("POST", `/shipments/${shipmentId}/milestones/init`, {}))
      .then(() => api("POST", `/shipments/${shipmentId}/edi-messages/booking-request`, {}))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); })
      .then(() => waitFor(`/shipments/${shipmentId}/carrier-booking`, b => !!b?.carrierBookingRequestReference && !!b.lastResponseStatus))
      .then(res => api("POST", `/test-tools/dcsa-sim/bookings/${res.body.carrierBookingRequestReference}/confirm`, {}))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(200); })
      .then(() => api("PUT", `/shipments/${shipmentId}/containers/${containers[0].id}`, { ...containers[0], vgmStatus: "Submitted", vgmMethod: "Method 1", vgmWeightKg: 15620 }))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(200); })
      .then(() => api("PUT", `/shipments/${shipmentId}/shipping-instructions`, { siCutoff: `${day(-4)}T12:00`, specialInstructions: "Shipper's load, stow and count" }))
      .then(() => api("POST", `/shipments/${shipmentId}/shipping-instructions/submit`, {}))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); siRef = res.body.shippingInstructions.siReference; })
      .then(() => waitFor(`/shipments/${shipmentId}/shipping-instructions`, s => s?.carrierState === "RECEIVED"))
      .then(() => api("POST", `/test-tools/dcsa-sim/shipping-instructions/${siRef}/draft`, {}))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(200); })
      .then(() => api("POST", "/test-tools/dcsa-sim/events", { shipmentId, kind: "gateIn", dateTime: `${day(-4)}T09:40:00Z` }))
      .then(() => api("POST", "/test-tools/dcsa-sim/events", { shipmentId, kind: "departed", classifier: "ESTIMATED", dateTime: `${day(-2)}T18:00:00Z` }))
      .then(() => api("POST", "/test-tools/dcsa-sim/events", { shipmentId, kind: "departed", dateTime: `${day(-2)}T23:40:00Z` }))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(200); });
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
    customers.forEach(c => api("DELETE", `/customers/${c.id}`));
    if (officeId) api("DELETE", `/offices/${officeId}`).then(r => { if (r.status !== 200) api("PUT", `/offices/${officeId}`, { isActive: false }); });
    if (branchId) api("DELETE", `/branches/${branchId}`).then(r => { if (r.status !== 200) api("PUT", `/branches/${branchId}`, { isActive: false }); });
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

  it("shows the carrier's draft Master B/L folded or open, the critical facts first, and approves it", () => {
    goto(`shipments/${shipmentId}/shipping-instructions`);
    cy.get("#mbl-panel", { timeout: 20000 }).should("contain", "Master B/L from MAEU");
    cy.get("#mbl-status").should("have.text", "DRAFT · TO REVIEW");
    cy.get("#mbl-summary").should("contain", "No differences");
    cy.get("#mbl-facts").should("contain", "Van Leeuwen Meubelen").and("contain", "NLRTM → USNYC").and("contain", "2 × 40' HC");
    cy.get("#shpsi-carrier-state").should("contain", "drafted the Master B/L");
    cy.get("#mbl-all-fields").should("not.exist");
    cy.get("#mbl-show-all").should("contain", "Show all").click();
    cy.get("#mbl-all-fields").should("contain", `Container MSKU${rand}00`).and("contain", "Seal");
    cy.get("#mbl-toggle").click();
    cy.get("#mbl-body").should("not.exist");
    cy.get("#mbl-toggle").click();
    cy.get("#mbl-approve-btn").click();
    cy.get("#mbl-status", { timeout: 15000 }).should("have.text", "APPROVED");
    cy.get("#mbl-banner").should("contain", "Waiting for MAEU to issue it");
    cy.get("#shpsi-send-update-btn").should("exist");
    cy.get("#shpsi-cancel-btn").click();
    cy.get("#shpsi-cancel-confirm").should("contain", `Cancel ${siRef} at MAEU?`);
    cy.get("#shpsi-cancel-keep").click();
    cy.get("#shpsi-cancel-confirm").should("not.exist");
  });

  it("keeps each VGM declaration with its evidence and VG01, flagging missing evidence", () => {
    api("POST", `/shipments/${shipmentId}/services`, { side: "Export", serviceType: "VGM", requestedDate: day(-5) });
    goto(`shipments/${shipmentId}/services/export/vgm`);
    cy.get(`#svcvgm-row-${containers[0].id}-evidence`, { timeout: 20000 }).should("have.text", "No evidence on file");
    cy.get(`#svcvgm-row-${containers[0].id}-declarations`).should("contain", "Declarations (1)").click();
    cy.get(`#svcvgm-row-${containers[0].id}-history`).should("contain", "DECLARED").and("contain", "15,620 kg").and("contain", "SM1");
    cy.get('[id^="svcvgm-decl-"][id$="-attach"] input[type=file]').selectFile({
      contents: Cypress.Buffer.from("%PDF-1.4 Weighbridge ticket WB-RTM-2026-10871, 15,620 kg"), fileName: "WB-RTM-2026-10871.pdf", mimeType: "application/pdf",
    }, { force: true });
    cy.get(`#svcvgm-row-${containers[0].id}-evidence`, { timeout: 15000 }).should("have.text", "Weighbridge ticket");
    cy.get('[id^="svcvgm-doc-"]').should("contain", "Evidence · WB-RTM-2026-10871.pdf");
    cy.get('[id^="svcvgm-decl-"][id$="-generate"]').should("have.text", "Generate VG01").click();
    cy.get('[id^="svcvgm-doc-"]', { timeout: 30000 }).should("contain", "VG01 · VG01-");
    cy.get('[id^="svcvgm-decl-"][id$="-generate"]').should("have.text", "Generate VG01 again");
  });

  it("shows the sea leg's times by source, each milestone's DCSA events, and the carrier's events", () => {
    goto(`shipments/${shipmentId}/milestones`);
    cy.get("#shpmiles-sea-legs", { timeout: 20000 }).should("contain", "NLRTM").and("contain", "USNYC");
    cy.get('[id$="-etd-source"]').should("have.text", "ACTUAL");
    cy.get('[data-testid="shipment-milestones-step-vessel_departed-dcsa"]').should("contain", "Transport · Departed at POL");
    cy.get('[data-testid="shipment-milestones-step-delivered-dcsa"]').should("contain", "Completed by hand");
    cy.get("#shpmiles-carrier-events").should("contain", "Vessel departed").and("contain", "Gated in · laden").and("contain", "Vessel Departed completed");
    cy.get('[data-testid="shipment-milestones-check-vessel-times-btn"]').should("exist");
    cy.get('[data-testid="shipment-milestones-sync-carrier-events-btn"]').click();
    cy.contains("Nothing new from MAEU", { timeout: 15000 });
  });

  it("plays the carrier's Master B/L, Track & Trace and vessel times from Test Tools", () => {
    goto("test-tools");
    cy.contains("button", "DCSA Carrier", { timeout: 15000 }).click();
    cy.get('[data-testid="dcsa-carrier-tab-si"]').click();
    cy.get(`[data-testid="dcsa-si-row-${shipmentId}"]`, { timeout: 15000 }).click();
    cy.get('[data-testid="dcsa-si-td"]').should("contain", "approved");
    cy.get('[data-testid="dcsa-si-action-issue"]').click();
    cy.get('[data-testid="dcsa-si-td"]', { timeout: 15000 }).should("contain", "issued");
    cy.get('[data-testid="dcsa-carrier-tab-tnt"]').click();
    cy.get('[data-testid="dcsa-tnt-shipment"]', { timeout: 15000 }).select(shipmentId);
    cy.get('[data-testid="dcsa-tnt-report-loaded"]').click();
    cy.contains("Loaded recorded for", { timeout: 15000 });
    cy.get('[data-testid="dcsa-carrier-tab-ovs"]').click();
    cy.get('[data-testid="dcsa-ovs-save"]', { timeout: 15000 }).should("exist");
    goto(`shipments/${shipmentId}/shipping-instructions`);
    cy.get("#mbl-status", { timeout: 20000 }).should("have.text", "ISSUED");
    cy.get("#shpsi-locked").should("contain", "can't be updated or cancelled");
  });
});
