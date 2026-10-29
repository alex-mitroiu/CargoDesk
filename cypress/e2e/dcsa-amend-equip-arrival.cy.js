/**
 * DCSA everywhere, the remaining phases — the screens (2026-10-28; approved mockup
 * https://claude.ai/code/artifact/1bf14417-6d13-4009-a277-ada52600d001).
 *
 *  - Cargo: the container's equipment type shown by its ISO 6346 code ("was 40HC"), and its seals as a
 *    list with who applied each one;
 *  - Shipping Instructions: the issued Master B/L — "Request amendment" previews what differs, sends it,
 *    and shows the carrier's answer (accepted: return the originals);
 *  - Arrival Notice (Booking & Routing): the carrier's notice, free time checked against the containers,
 *    its charges added as accruals.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173), not in production (the built-in DCSA carrier is always on there)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("DCSA amendment, equipment and Arrival Notice screens", () => {
  let tok, shipmentId, siRef, branchId, officeId, imoOfficeId;
  const customers = [];
  const containers = [];
  const stamp = Date.now();
  const rand = String(stamp).slice(-5);
  const voyage = `53${rand.slice(-2)}W`;
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });
  const waitFor = (path, pred, tries = 30) => api("GET", path).then(res => (pred(res.body) || tries <= 0 ? res : cy.wait(250).then(() => waitFor(path, pred, tries - 1))));

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).then(res => { tok = res.body.token; });
  });

  // A complete NLRTM → USNYC shipment on MAEU (the demo carrier): two sealed 40' HCs, booked, Shipping
  // Instructions drafted into a Master B/L that the carrier issued.
  before(() => {
    ensureOffices(api).then(res => { imoOfficeId = res.imoOfficeId; });
    const customer = (companyName, address1, postalCode, city, countryIso2, extra = {}) =>
      api("POST", "/customers", { companyName, address1, postalCode, city, countryIso2, ...extra }).then(res => { customers.push(res.body); return res.body; });
    cy.then(() => api("POST", "/branches", { code: `CYE${rand}`, name: `CargoDesk Logistics Rotterdam ${rand} BV`, countryCode: "NL", city: "Rotterdam",
      address: "Wilhelminakade 909", locode: "NLRTM", currency: "EUR", email: "export.rotterdam@cargodesk.example", phone: "+31 10 555 0142", scac: "CDLR" }))
      .then(res => { branchId = res.body.id; })
      .then(() => api("POST", "/offices", { unlocode: `NLE${String.fromCharCode(65 + (stamp % 26))}${String.fromCharCode(65 + ((stamp >> 5) % 26))}`,
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
      .then(() => waitFor(`/shipments/${shipmentId}/carrier-booking`, b => !!b?.carrierBookingRequestReference && !!b.lastResponseStatus))
      .then(res => api("POST", `/test-tools/dcsa-sim/bookings/${res.body.carrierBookingRequestReference}/confirm`, {}))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(200); })
      .then(() => api("PUT", `/shipments/${shipmentId}/shipping-instructions`, { siCutoff: `${day(-4)}T12:00`, specialInstructions: "Shipper's load, stow and count" }))
      .then(() => api("POST", `/shipments/${shipmentId}/shipping-instructions/submit`, {}))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); siRef = res.body.shippingInstructions.siReference; })
      .then(() => waitFor(`/shipments/${shipmentId}/shipping-instructions`, s => s?.carrierState === "RECEIVED"))
      .then(() => api("POST", `/test-tools/dcsa-sim/shipping-instructions/${siRef}/draft`, {}))
      .then(() => api("POST", `/shipments/${shipmentId}/master-bl/approve`, {}))
      .then(() => api("POST", `/test-tools/dcsa-sim/shipping-instructions/${siRef}/issue`, {}))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(200); expect(res.body.masterBl.status).to.eq("ISSUED"); });
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

  it("shows a container's ISO code and keeps its seals as a list with who applied them", () => {
    const c = containers[1];
    goto(`shipments/${shipmentId}/containers`);
    cy.get(`[data-testid="shipment-containers-row-${c.id}-equipment"]`, { timeout: 20000 }).should("contain", "45G1").and("contain", `ML-${rand}1`);
    cy.get(`[data-testid="shipment-containers-row-${c.id}"]`).click();
    cy.get('[data-testid="container-type-iso"]').should("have.text", "45G1");
    cy.get('[data-testid="shipment-containers-form-type-field"]').should("contain", "was 40HC");
    cy.get("#shpctr-seal-0-number").should("have.value", `ML-${rand}1`);
    cy.get("#shpctr-seal-0-source").select("CAR");
    cy.contains("button", "＋ Add seal").click();
    cy.get("#shpctr-seal-1-number").type(`CBP${rand}`);
    cy.get("#shpctr-seal-1-source").select("CUS");
    cy.contains("button", "Update Container").click();
    cy.get(`[data-testid="shipment-containers-row-${c.id}-seals"]`, { timeout: 15000 })
      .should("contain", `ML-${rand}1 (carrier)`).and("contain", `CBP${rand} (customs)`);
    api("GET", `/containers?shipmentId=${shipmentId}`).then(res => {
      const saved = (res.body.results || res.body).find(x => x.id === c.id);
      expect(saved.seals.map(s => `${s.number}:${s.source}`)).to.deep.eq([`ML-${rand}1:CAR`, `CBP${rand}:CUS`]);
      expect(saved.isoEquipmentCode).to.eq("45G1");
    });
  });

  it("previews and sends an amendment of the issued Master B/L, then shows the carrier accepting it", () => {
    const c = containers[1];
    goto(`shipments/${shipmentId}/shipping-instructions`);
    cy.get("#mbl-status", { timeout: 20000 }).should("have.text", "ISSUED");
    cy.get("#mbl-amend-btn").should("have.text", "Request amendment").click();
    cy.get("#mbl-amend-preview").should("contain", "The shipment differs from the issued B/L").and("contain", `Container ${c.containerNumber} · Seal`)
      .and("contain", `CBP${rand}`);
    cy.get("#mbl-amend-send").should("contain", "Send amendment to MAEU").click();
    cy.get("#mbl-status", { timeout: 15000 }).should("have.text", "ISSUED · AMENDMENT REQUESTED");
    cy.get("#mbl-amendment").should("contain", "WAITING FOR MAEU");
    cy.get("#mbl-amend-cancel").should("be.visible");
    cy.then(() => api("POST", `/test-tools/dcsa-sim/shipping-instructions/${siRef}/confirmAmendment`, {}))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(200); });
    goto(`shipments/${shipmentId}/conditions`);
    goto(`shipments/${shipmentId}/shipping-instructions`);
    cy.get("#mbl-banner", { timeout: 20000 }).should("contain", "Return the 3 original B/Ls to MAEU");
    cy.get("#mbl-status").should("have.text", "AMENDMENT PENDING");
    cy.get("#mbl-amendment").should("contain", "ACCEPTED");
  });

  it("shows the carrier's Arrival Notice, settles free time and adds its charges as accruals", () => {
    cy.then(() => api("PUT", `/shipments/${shipmentId}/containers/${containers[0].id}`, { ...containers[0], seals: undefined, destDetentionFreeDays: 10 }));
    cy.then(() => api("POST", "/test-tools/dcsa-sim/arrival-notices", { shipmentId, eta: day(10), freeDays: 4, detentionDays: 7 }))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); });
    goto(`shipments/${shipmentId}/arrival-notice`);
    cy.get("#shpan-version", { timeout: 20000 }).should("have.text", "VERSION 1");
    cy.get("#shpan-facts").should("contain", "MAERSK KENSINGTON").and("contain", "Container terminal USNYC");
    cy.get("#shpan-banner").should("contain", "The shipment's ETA moved");
    cy.get(`[data-testid="shpan-ft-${containers[1].containerNumber}-DEM"]`).should("contain", "FILLED · 4 DAYS");
    cy.get(`[data-testid="shpan-ft-${containers[0].containerNumber}-DET"]`).should("contain", "SAYS 10 DAYS");
    cy.get(`[data-testid="shpan-ft-${containers[0].containerNumber}-DET-use"]`).click();
    cy.get(`[data-testid="shpan-ft-${containers[0].containerNumber}-DET"]`, { timeout: 15000 }).should("contain", "FILLED · 7 DAYS");
    cy.get("#shpan-charges").should("contain", "Terminal handling, destination").and("contain", "Delivery order fee");
    cy.get("#shpan-charge-2-pick").uncheck();
    cy.get("#shpan-accrue-btn").should("contain", "Add 2 as accruals (USD 1,075.00)").click();
    cy.get('[data-testid="shpan-charge-0"]', { timeout: 15000 }).should("contain", "ADDED · BUY ACCRUAL");
    cy.get('[data-testid="shpan-charge-2"]').should("contain", "not yet");
    api("GET", `/shipments/${shipmentId}/cost-lines`).then(res => {
      const lines = (res.body.results || res.body).filter(l => l.source === "arrival_notice");
      expect(lines.map(l => l.chargeCode).sort()).to.deep.eq(["Destination THC", "Documentation Fee"]);
    });
    cy.get("#shpan-an01-btn").should("be.visible");
  });
});
