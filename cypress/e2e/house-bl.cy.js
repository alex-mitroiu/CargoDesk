/**
 * The House B/L screens (Epic TKT-C7EBU3; approved mockup https://claude.ai/artifact/Tr9cyqXe31HqYTxy63ap7Z,
 * 2026-10-21), end to end in the browser:
 *   - Documents → House B/L panel: a ready B/L is issued, the originals are recorded as presented at
 *     destination, and the cargo is released;
 *   - the readiness list sends the packages fix to Cargo, where the new Packages and Kind fields fill it;
 *   - Issue as eBL → Test Tools → eBL Platform: ISSU, then the consignee's surrender (SREQ) releases it;
 *   - the remaining gaps (mockup https://claude.ai/artifact/CnuymDL2eUEnxnD8oDtj57, 2026-10-24): the number
 *     taken from the office series at issue, originals and copies, the originals log, surrender for
 *     amendment and version 2 under the same number; to order on Conditions; the telex release notice.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173, pdf-render :3003); the built-in DCSA carrier (outside production)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC present in port_locations
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

describe("House B/L screens", () => {
  let tok, emoOfficeId, imoOfficeId, branchId, eblOfficeId;
  const stamp = Date.now();
  const created = { shipments: [], customers: [], tickets: [] };
  const ships = {};

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });

  // The booking confirmed by the built-in DCSA carrier, as the House B/L's readiness needs.
  const confirmBooking = shipmentId => api("POST", `/shipments/${shipmentId}/edi-messages/booking-request`, {})
    .then(() => api("GET", `/shipments/${shipmentId}/carrier-booking`))
    .then(res => api("POST", `/test-tools/dcsa-sim/bookings/${encodeURIComponent(res.body.carrierBookingRequestReference)}/confirm`, {}))
    .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(200));

  // A complete NLRTM → USNYC shipment: parties with addresses (the consignee with an LEI), a sealed
  // 40' HC, milestones, the booking confirmed and, unless `packages: false`, packages and loading.
  const readyShipment = (key, { packages = true, emo = null, shipperWaveId = "", releaseType = "Original" } = {}) => {
    const s = { key };
    return api("POST", "/customers", { companyName: `Van Leeuwen Furniture ${key}${stamp} BV`, address1: "Waalhaven Oostzijde 81", postalCode: "3087 BM", city: "Rotterdam", countryIso2: "NL" })
      .then(r => { s.shipper = r.body; created.customers.push(r.body.id); })
      .then(() => api("POST", "/customers", { companyName: `Hudson Home Imports ${key}${stamp} Inc`, address1: "250 Port Jersey Blvd", postalCode: "07305", city: "Jersey City", countryIso2: "US" }))
      .then(r => { s.consignee = r.body; created.customers.push(r.body.id); })
      .then(() => api("POST", `/customers/${s.consignee.id}/identifiers`, { idType: "LEI", idCode: `5493001KJTIIGC8Y1R${String(stamp).slice(-2)}`, countryIso2: "US" }))
      .then(() => shipperWaveId && api("POST", `/customers/${s.shipper.id}/identifiers`, { idType: "WAVE", idCode: shipperWaveId, countryIso2: "NL" }))
      .then(() => api("POST", "/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central", contractRef: "MAEU-SC-2026-0418",
        etd: inDays(3), eta: inDays(14), incoterm: "FOB", commodityCode: "9999", cargoReadyDate: inDays(1),
        blReleaseType: releaseType, freightTerms: "Prepaid", vessel: "MAERSK KENSINGTON", voyage: "443W",
        shipperId: s.shipper.id, shipperName: s.shipper.companyName, consigneeId: s.consignee.id, consigneeName: s.consignee.companyName,
        notifyId: s.consignee.id, notifyName: s.consignee.companyName, principalId: s.shipper.id, principalName: s.shipper.companyName,
        emoOfficeId: emo || emoOfficeId, imoOfficeId,
      }))
      .then(r => { expect(r.status).to.eq(201); s.id = r.body.id; created.shipments.push(s.id); })
      .then(() => api("POST", "/containers", { shipmentId: s.id, containerNumber: `MSKU${String(stamp).slice(-6)}${key.charCodeAt(0) % 10}`,
        sealNumber: `ML-${key}${String(stamp).slice(-5)}`, size: "40", type: "HC", hsCode: "940360", cargoDescription: "Flat-pack wooden furniture",
        marksAndNumbers: "VLF/NYC 1-1200", grossWeightKg: 18400, volumeCbm: 64, ...(packages && { numberOfPackages: 1200, packageCode: "CT" }) }))
      .then(r => { s.containerId = r.body.id; })
      .then(() => api("POST", `/shipments/${s.id}/milestones/init`, {}))
      .then(() => confirmBooking(s.id))
      .then(() => api("POST", `/shipments/${s.id}/containers/${s.containerId}/events`, { eventType: "Loaded", occurredAt: `${inDays(0)}T06:15:00Z`, location: "NLRTM" }))
      .then(() => { ships[key] = s; });
  };

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).then(res => { tok = res.body.token; });
  });
  before(() => {
    ensureOffices(api).then(res => { emoOfficeId = res.emoOfficeId; imoOfficeId = res.imoOfficeId; });
  });
  // The issuer must be complete (House B/L audit M2, 2026-10-29): the export office's legal entity needs a SCAC and a
  // street address. The twin of tests/helpers/house-bl.mjs ensureIssuingEntity, so CI's empty database issues too.
  before(() => {
    const complete = { address: "Wilhelminakade 909", city: "Rotterdam", phone: "+31 10 555 0142", email: "documentation@cargodesk.example" };
    const asList = b => (Array.isArray(b) ? b : b?.results || []);
    api("GET", "/offices").then(res => {
      const office = asList(res.body).find(o => o.id === emoOfficeId);
      expect(office, `export office ${emoOfficeId}`).to.exist;
      if (office.branchId) {
        return api("GET", `/branches/${office.branchId}`).then(({ body: b }) => {
          if (b?.scac && b.address && b.city && b.countryCode) return;
          api("PUT", `/branches/${office.branchId}`, { ...b, scac: b.scac || "CDHB", address: b.address || complete.address,
            city: b.city || complete.city, phone: b.phone || complete.phone, email: b.email || complete.email })
            .then(r => expect(r.status, JSON.stringify(r.body)).to.eq(200));
        });
      }
      const code = `HB${String(emoOfficeId).replace(/[^A-Z0-9]/gi, "").slice(-6).toUpperCase()}`;
      return api("GET", "/branches")
        .then(({ body }) => {
          const existing = asList(body).find(x => x.code === code);
          return existing ? cy.wrap(existing) : api("POST", "/branches", { code, name: `CargoDesk Logistics ${office.name || code} BV`, countryCode: "NL",
            locode: "NLRTM", currency: "EUR", scac: "CDHB", taxRegistrationNumber: "NL004495445B01", ...complete }).then(r => r.body);
        })
        .then(branch => api("PUT", `/offices/${emoOfficeId}`, { branchId: branch.id }))
        .then(r => expect(r.status, JSON.stringify(r.body)).to.eq(200));
    });
  });
  before(() => {
    // The eBL's issuing carrier: a scratch legal entity with SCAC, address and contact, on its own export office.
    const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
    api("POST", "/branches", { code: `HB${letters}`, name: `CargoDesk Logistics ${letters} BV`, countryCode: "NL", city: "Rotterdam", address: "Wilhelminakade 909",
      locode: "NLRTM", taxRegistrationNumber: "NL004495445B01", currency: "EUR", email: "docs@cargodesk.example", phone: "+31 10 555 0199", scac: "CDLR" })
      .then(r => { expect(r.status, JSON.stringify(r.body)).to.be.oneOf([200, 201]); branchId = r.body.id; })
      .then(() => api("POST", "/offices", { unlocode: `NL${letters}`, countryCode: "NL", department: "SE", name: `Export eBL ${letters}`, branchId }))
      .then(r => { expect(r.status, JSON.stringify(r.body)).to.eq(201); eblOfficeId = r.body.id; });
  });
  before(() => readyShipment("A"));
  before(() => readyShipment("B", { packages: false }));
  // C's House B/L is issued from the scratch eBL office (set by the hook above before this one runs).
  before(() => readyShipment("C", { emo: eblOfficeId, shipperWaveId: `WAVE-VLF-${stamp}` }));
  before(() => readyShipment("D"));
  before(() => readyShipment("E"));
  before(() => readyShipment("F", { releaseType: "Telex Release" }));

  after(() => {
    created.tickets.forEach(id => api("DELETE", `/tickets/${id}`));
    created.shipments.forEach(id => api("DELETE", `/shipments/${id}`));
    created.customers.forEach(id => api("DELETE", `/customers/${id}`));
    if (eblOfficeId) api("DELETE", `/offices/${eblOfficeId}`).then(r => r.status !== 200 && api("PUT", `/offices/${eblOfficeId}`, { isActive: false }));
    if (branchId) api("DELETE", `/branches/${branchId}`).then(r => r.status !== 200 && api("PUT", `/branches/${branchId}`, { isActive: false }));
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

  it("issues a ready House B/L, records the originals at destination, and releases the cargo", () => {
    goto(`shipments/${ships.A.id}/documents`);
    cy.get('[data-testid="house-bl-ready"]', { timeout: 15000 }).should("contain", "Ready to issue");
    cy.get('[data-testid="house-bl-statement-onboard"]').should("be.checked");
    cy.get('[data-testid="house-bl-issue"]').should("not.be.disabled").click();
    cy.get('[data-testid="house-bl-status"]', { timeout: 20000 }).should("have.text", "ISSUED");
    cy.get('[data-testid="house-bl-history"]').should("contain", "Issued, shipped on board");
    cy.get('[data-testid="house-bl-surrender"]').should("contain", "Originals presented at destination").click();
    cy.get('[data-testid="house-bl-status"]', { timeout: 15000 }).should("have.text", "SURRENDERED");
    cy.get('[data-testid="house-bl-open-release"]').click();
    cy.get('[data-testid="house-bl-release-modal"]').within(() => {
      cy.get('[data-testid="house-bl-release-check-originals"]').should("contain", "OK");
      cy.get('[data-testid="house-bl-release-confirm"]').should("not.be.disabled").click();
    });
    cy.get('[data-testid="house-bl-status"]', { timeout: 15000 }).should("have.text", "RELEASED");
    cy.get('[data-testid="house-bl-released"]').should("contain", "The Delivery Order (DO01) can be generated now");
  });

  it("sends the packages fix to Cargo, where Packages and Kind of packages fill it", () => {
    goto(`shipments/${ships.B.id}/documents`);
    cy.get('[data-testid="house-bl-readiness"]', { timeout: 15000 }).should("contain", "number of packages, kind of packages");
    cy.get('[data-testid="house-bl-issue"]').should("be.disabled");
    cy.get('[data-testid="house-bl-readiness"]').contains("a", "Cargo").click();
    cy.get(`[data-testid="shipment-containers-row-${ships.B.containerId}"]`, { timeout: 15000 }).click();
    cy.get("#ctr-number-of-packages").clear().type("24");
    cy.get("#ctr-package-code").select("PX");
    cy.get('[data-testid="shipment-containers-form-save-btn"]').click();
    cy.get(`[data-testid="shipment-containers-row-${ships.B.containerId}-packages"]`, { timeout: 15000 }).should("have.text", "24 PX");
    goto(`shipments/${ships.B.id}/documents`);
    cy.get('[data-testid="house-bl-ready"]', { timeout: 15000 }).should("contain", "Ready to issue");
  });

  it("issues it as an eBL to WAVE; the platform issues it and the consignee's surrender releases it", () => {
    goto(`shipments/${ships.C.id}/documents`);
    cy.get('[data-testid="house-bl-issue"]', { timeout: 15000 }).should("not.be.disabled").click();
    cy.get('[data-testid="house-bl-status"]', { timeout: 20000 }).should("have.text", "ISSUED");
    cy.get('[data-testid="house-bl-ebl-open"]').click();
    cy.get('[data-testid="house-bl-ebl-box"]').should("contain", `WAVE-VLF-${stamp}`);
    cy.get('[data-testid="house-bl-ebl-send"]').click();
    cy.get('[data-testid="house-bl-status"]', { timeout: 15000 }).should("have.text", "eBL PENDING");

    goto("test-tools");
    cy.contains("button", "eBL Platform").click();
    cy.get('[data-testid="ebl-platform-panel"]', { timeout: 15000 }).should("be.visible");
    cy.get('[data-testid="ebl-platform-panel"]').contains("tr", ships.C.id).within(() => {
      cy.get('[data-testid^="ebl-sim-ISSU-"]').click();
    });
    cy.get('[data-testid="ebl-platform-panel"]').contains("tr", ships.C.id, { timeout: 15000 }).should("contain", "ISSUED")
      .within(() => { cy.get('[data-testid^="ebl-sim-SREQ-"]').click(); });
    cy.get('[data-testid="ebl-platform-panel"]').contains("tr", ships.C.id, { timeout: 15000 }).should("contain", "SURR");

    goto(`shipments/${ships.C.id}/documents`);
    cy.get('[data-testid="house-bl-status"]', { timeout: 20000 }).should("have.text", "RELEASED · eBL");
    cy.get('[data-testid="house-bl-history"]').should("contain", "WAVE issued the eBL (ISSU)").and("contain", "eBL surrendered for delivery (SURR)");
  });

  it("takes the number from the office series at issue, logs the originals, and amends it to version 2 under the same number", () => {
    goto(`shipments/${ships.D.id}/documents`);
    cy.get('[data-testid="house-bl-number"]', { timeout: 15000 }).should("contain", "(next)").and("contain", "series when you press Issue");
    cy.get('[data-testid="house-bl-originals"]').clear().type("2");
    cy.get('[data-testid="house-bl-copies"]').clear().type("1");
    cy.get('[data-testid="house-bl-issue"]').should("not.be.disabled").click();
    cy.get('[data-testid="house-bl-status"]', { timeout: 20000 }).should("have.text", "ISSUED");
    cy.get('[data-testid="house-bl-record-number"]').should("contain", "office series");
    cy.get('[data-testid="house-bl-history"]').should("contain", "2 originals, 1 copy");

    cy.get('[data-testid="house-bl-handover-open"]').click();
    cy.get("#house-bl-handover-tracking").type("DHL 4471 9920 31");
    cy.get('[data-testid="house-bl-handover-save"]').click();
    cy.get('[data-testid="house-bl-originals-log"]', { timeout: 15000 }).should("contain", "2 of 2 by courier to Van Leeuwen Furniture D");

    cy.get('[data-testid="house-bl-amend"]').click();
    cy.get("#house-bl-amend-reason").type("Consignee moved to 1 Harbor Gateway");
    cy.get('[data-testid="house-bl-amend-confirm"]').click();
    cy.get('[data-testid="house-bl-status"]', { timeout: 15000 }).should("have.text", "AMENDING · v2");
    cy.get('[data-testid="house-bl-amending"]').should("contain", "Version 2 replaces version 1").and("contain", "Consignee moved to 1 Harbor Gateway");
    cy.get('[data-testid="house-bl-number"]').should("contain", "Kept from version 1");
    cy.get('[data-testid="house-bl-issue"]').should("contain", "Issue version 2").click();
    cy.get('[data-testid="house-bl-status"]', { timeout: 20000 }).should("have.text", "ISSUED");
    cy.get('[data-testid="house-bl-versions"]').should("contain", "v1").and("contain", "surrendered for amendment").and("contain", "v2");
    cy.get('[data-testid="house-bl-history"]').should("contain", "Version 2 issued");
  });

  it("issues to order of the consignee, chosen on Conditions", () => {
    goto(`shipments/${ships.E.id}/conditions`);
    cy.get('[data-testid="shipment-conditions-edit-btn"]', { timeout: 15000 }).click();
    cy.get("#shpcond-edit-bl-to-order").select("CONSIGNEE");
    cy.get('[data-testid="shipment-conditions-edit-form"]').contains("button", "Save").click();
    cy.get('[data-testid="shipment-conditions-bl-to-order"]', { timeout: 15000 }).should("contain", "To order of the consignee");
    goto(`shipments/${ships.E.id}/documents`);
    cy.get('[data-testid="house-bl-panel"]', { timeout: 15000 }).should("contain", "To order of the consignee");
    cy.get('[data-testid="house-bl-issue"]').should("not.be.disabled").click();
    cy.get('[data-testid="house-bl-status"]', { timeout: 20000 }).should("have.text", "ISSUED");
    api("GET", `/shipments/${ships.E.id}/house-bl`).then(res => {
      expect(res.body.live.toOrderMode).to.eq("CONSIGNEE");
      expect(res.body.live.isToOrder).to.eq(true);
    });
  });

  it("a telex release surrendered at origin tells the import office", () => {
    goto(`shipments/${ships.F.id}/documents`);
    cy.get('[data-testid="house-bl-issue"]', { timeout: 15000 }).should("not.be.disabled").click();
    cy.get('[data-testid="house-bl-status"]', { timeout: 20000 }).should("have.text", "ISSUED");
    cy.get('[data-testid="house-bl-surrender"]').should("contain", "Surrendered at origin").click();
    cy.get('[data-testid="house-bl-telex-notice"]', { timeout: 15000 }).should("contain", "Telex release notice sent to");
    api("GET", `/tickets?shipmentId=${ships.F.id}`).then(res => {
      const notice = res.body.find(t => t.sourceType === "telex_release_notice");
      expect(notice, "the Kanban task").to.exist;
      created.tickets.push(notice.id);
    });
  });
});
