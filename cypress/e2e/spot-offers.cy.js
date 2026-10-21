/**
 * SPOT rates in the browser (plan https://claude.ai/artifact/Y61PAmXZfgFxTLtpt7GiAZ; approved mockup
 * https://claude.ai/artifact/5DYk7qXZLEUn51zJUQpZYK, 2026-10-21):
 *   - Schedules: a SPOT shipment's spot offer, typed in through "Add spot offer" (charges, "subject to",
 *     penalty terms), shown under the contract; another picked from the offers already entered; removed;
 *   - an expired digital offer says Send Booking Request is blocked;
 *   - a quote bought on a spot offer: carrier locked to the offer, buy / sell / margin;
 *   - Booking & Review: cancelling a confirmed booking shows the offer's fee first.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173), not in production (the built-in carrier plays CMDU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "../support/offices";

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

describe("Spot offers", () => {
  let tok, shipperId, consigneeId, emoOfficeId, imoOfficeId;
  let typed, picked, expired, quoteId, cancelling, fromCarrier, viaPicker, ruleQuoteId, ruleId;
  const stamp = Date.now();
  const shipments = [], offers = [];

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });

  const newShipment = ({ etd = inDays(30), eta = inDays(44) } = {}) =>
    api("POST", "/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "CMDU", status: "Active", contractType: "SPOT", contractRef: "",
      etd, eta, incoterm: "FOB", commodityCode: "9999", cargoReadyDate: inDays(1),
      shipperId, shipperName: `Spot UI Shipper ${stamp} BV`, consigneeId, consigneeName: `Spot UI Consignee ${stamp} Inc`,
      principalId: shipperId, principalName: `Spot UI Shipper ${stamp} BV`, emoOfficeId, imoOfficeId,
    }).then(res => {
      expect(res.status).to.eq(201);
      const id = res.body.id;
      shipments.push(id);
      const ctr = n => api("POST", "/containers", { shipmentId: id, containerNumber: `SPUI${String(stamp).slice(-5)}${n}`, size: "40", type: "HC",
        hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 });
      return ctr(1).then(() => ctr(2))
        .then(() => api("POST", `/shipments/${id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", carrierCode: "CMDU",
          etd, eta, vessel: "CMA CGM SPOTLIGHT", voyage: "0SP1W", vesselImo: "9999995" }))
        .then(() => id);
    });
  const newOffer = over => api("POST", "/spot-offers", {
    carrierCode: "CMDU", offerRef: `QUI${String(stamp).slice(-6)}${Math.floor(Math.random() * 1e4)}`, kind: "classic", pol: "NLRTM", pod: "USNYC",
    equipment: [{ containerType: "40HC", quantity: 2 }], validUntil: inDays(14),
    lines: [{ serviceCode: "OF", description: "Ocean freight", unitPrice: 2050 }, { serviceCode: "DOC", description: "Documentation fee", basis: "per_bl", unitPrice: 75 }],
    penalties: { cancellationFee: 150, cancellationNoticeDays: 7, noShowFee: 300, currency: "USD", basis: "per_container" }, ...over,
  }).then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); offers.push(res.body.id); return res.body; });

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).then(res => { tok = res.body.token; });
  });
  before(() => {
    ensureOffices(api).then(res => { emoOfficeId = res.emoOfficeId; imoOfficeId = res.imoOfficeId; });
  });
  before(() => {
    api("POST", "/customers", { companyName: `Spot UI Shipper ${stamp} BV` }).then(res => { shipperId = res.body.id; })
      .then(() => api("POST", "/customers", { companyName: `Spot UI Consignee ${stamp} Inc` })).then(res => { consigneeId = res.body.id; })
      .then(() => newShipment()).then(id => { typed = id; })
      .then(() => newShipment()).then(id => { picked = id; })
      .then(() => newShipment()).then(id => { expired = id; })
      .then(() => newShipment({ etd: inDays(5), eta: inDays(19) })).then(id => { cancelling = id; })
      .then(() => newShipment()).then(id => { fromCarrier = id; })
      .then(() => newShipment()).then(id => { viaPicker = id; })
      .then(() => api("POST", "/quotes", {
        customerId: shipperId, customerName: `Spot UI Shipper ${stamp} BV`, pol: "NLRTM", pod: "USNYC", commodityCode: "9999",
        incoterm: "FOB", cargoReadyDate: inDays(3), validUntil: inDays(10), officeId: emoOfficeId,
        lines: [{ serviceCode: "OF", description: "Ocean freight, all in", containerType: "40HC", quantity: 2, rate: 2150, currency: "USD" }],
      })).then(res => { ruleQuoteId = res.body.id; })
      // This customer's margin rule on EU-N → NAM, 40HC (a lookup row: removed after the run).
      .then(() => api("POST", "/margin-rules", { customerId: shipperId, customerName: `Spot UI Shipper ${stamp} BV`, originLane: "EU-N", destLane: "NAM",
        containerType: "40HC", kind: "fixed", value: 150, minMarginPct: 8 }))
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); ruleId = res.body.id; })
      .then(() => api("POST", "/quotes", {
        customerId: shipperId, customerName: `Spot UI Shipper ${stamp} BV`, pol: "NLRTM", pod: "USNYC", commodityCode: "9999",
        incoterm: "FOB", cargoReadyDate: inDays(3), validUntil: inDays(10), officeId: emoOfficeId,
        lines: [{ serviceCode: "OF", description: "Ocean freight, all in", containerType: "40HC", quantity: 2, rate: 2500, currency: "USD" }],
      })).then(res => { quoteId = res.body.id; })
      // A digital offer with seconds to go, on its shipment: expired by the time the page opens.
      .then(() => newOffer({ kind: "digital", offerRef: `SPOTUI${String(stamp).slice(-6)}`, validUntil: new Date(Date.now() + 3000).toISOString(), priceLock: "booking" }))
      .then(o => api("POST", `/shipments/${expired}/spot-offer`, { offerId: o.id }))
      // A confirmed booking on an offer, 5 days before ETD.
      .then(() => newOffer())
      .then(o => api("POST", `/shipments/${cancelling}/spot-offer`, { offerId: o.id }))
      .then(() => api("POST", `/shipments/${cancelling}/edi-messages/booking-request`, {}))
      .then(res => expect(res.status, JSON.stringify(res.body)).to.eq(201));
    const waitRef = (tries = 40) => api("GET", `/shipments/${cancelling}/carrier-booking`).then(res => {
      if (res.body?.carrierBookingRequestReference && res.body.lastResponseStatus) return res.body.carrierBookingRequestReference;
      if (tries <= 0) throw new Error("No carrier reference");
      return cy.wait(250).then(() => waitRef(tries - 1));
    });
    waitRef().then(ref => api("POST", `/test-tools/dcsa-sim/bookings/${ref}/confirm`, {}))
      .then(res => expect(res.status).to.eq(200));
  });

  after(() => {
    shipments.forEach(id => api("DELETE", `/shipments/${id}`));
    if (ruleId) api("DELETE", `/margin-rules/${ruleId}`);
    if (quoteId) api("DELETE", `/quotes/${quoteId}`);
    if (ruleQuoteId) api("DELETE", `/quotes/${ruleQuoteId}`);
    offers.forEach(id => api("DELETE", `/spot-offers/${id}`));
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

  it("types a spot offer in on a SPOT shipment, with charges, subject-to and penalties", () => {
    goto(`shipments/${typed}/schedules`);
    cy.get('[data-testid="spot-offer-empty"]', { timeout: 20000 }).should("contain", "No spot offer yet");
    cy.get('[data-testid="spot-offer-add"]').click();
    cy.get('[data-testid="add-spot-offer-modal"]').should("be.visible");
    cy.get('[data-testid="spot-ref-input"]').type(`Q2611-UI-${String(stamp).slice(-4)}`);
    cy.get('[data-testid="spot-valid-date"]').type(inDays(14));
    cy.get('[data-testid="spot-price-lock"]').select("gate_in");
    cy.get('[data-testid="spot-charge-code-0"]').should("have.value", "OF");
    cy.get('[data-testid="spot-charge-qty-0"]').should("have.value", "2");
    cy.get('[data-testid="spot-charge-price-0"]').type("2050");
    cy.get('[data-testid="spot-add-charge"]').click();
    cy.get('[data-testid="spot-charge-code-1"]').type("BAF");
    cy.get('[data-testid="spot-charge-desc-1"]').type("Bunker adjustment");
    cy.get('[data-testid="spot-charge-price-1"]').type("250");
    cy.get('[data-testid="spot-add-charge"]').click();
    cy.get('[data-testid="spot-charge-code-2"]').type("DOC");
    cy.get('[data-testid="spot-charge-desc-2"]').type("Documentation fee");
    cy.get('[data-testid="spot-charge-basis-2"]').select("per_bl");
    cy.get('[data-testid="spot-charge-price-2"]').type("75");
    cy.get('[data-testid="spot-add-charge"]').click();
    cy.get('[data-testid="spot-charge-code-3"]').type("PSS");
    cy.get('[data-testid="spot-charge-desc-3"]').type("Peak season surcharge");
    cy.get('[data-testid="spot-charge-price-3"]').type("300");
    cy.get('[data-testid="spot-charge-included-3"]').click().should("contain", "Subject to");
    cy.get('[data-testid="spot-total-in"]').should("contain", "USD 4,675.00");
    cy.get('[data-testid="spot-total-subject"]').should("contain", "USD 600.00");
    cy.get('[data-testid="spot-penalty-cancellationFee"]').type("150");
    cy.get('[data-testid="spot-penalty-cancellationNoticeDays"]').type("7");
    cy.get('[data-testid="spot-penalty-noShowFee"]').type("300");
    cy.screenshot("spot-1-type-in", { capture: "viewport" });
    cy.get('[data-testid="spot-save"]').click();

    cy.get('[data-testid="spot-offer-card"]', { timeout: 15000 }).should("be.visible");
    cy.get('[data-testid="spot-offer-ref"]').should("contain", `Q2611-UI-${String(stamp).slice(-4)}`);
    cy.get('[data-testid="spot-offer-total"]').should("contain", "USD 4,675.00");
    cy.get('[data-testid="spot-offer-subject"]').should("contain", "USD 600.00");
    cy.get('[data-testid="spot-offer-line-pss"]').should("contain", "Subject to");
    cy.get('[data-testid="spot-offer-penalties"]').should("contain", "USD 150").and("contain", "from 7 days before ETD");
    cy.get('[data-testid="shipment-schedules-contract-spot-chip"]').should("be.visible");
    cy.get('[data-testid="shipment-schedules-contract-summary"]').should("contain", `Q2611-UI-${String(stamp).slice(-4)}`);
    cy.get('[data-testid="shipment-schedules-spot-offer-section"]').scrollIntoView();
    cy.screenshot("spot-2-card", { capture: "viewport" });
    api("GET", `/shipments/${typed}/cost-lines`).then(res => {
      const buys = (Array.isArray(res.body) ? res.body : res.body.results).filter(l => l.type === "BUY" && l.source === "spot_offer");
      expect(buys.map(l => l.amount).sort((a, b) => a - b)).to.deep.eq([75, 500, 600, 4100]);
    });
  });

  it("picks an offer already entered, then removes it", () => {
    newOffer({ offerRef: `QPICK${String(stamp).slice(-6)}` }).then(o => {
      goto(`shipments/${picked}/schedules`);
      cy.get('[data-testid="spot-offer-pick"]', { timeout: 20000 }).click();
      cy.get('[data-testid="spot-tab-pick"]').should("have.attr", "aria-selected", "true");
      cy.contains('[data-testid^="spot-pool-row-"]', o.offerRef, { timeout: 10000 }).within(() => cy.contains("button", "Pick").click());
      cy.get('[data-testid="spot-offer-ref"]', { timeout: 15000 }).should("contain", o.offerRef);
      cy.on("window:confirm", () => true);
      cy.get('[data-testid="spot-offer-remove"]').click();
      cy.get('[data-testid="spot-offer-empty"]', { timeout: 15000 }).should("be.visible");
    });
  });

  it("an expired digital offer says the booking is blocked", () => {
    goto(`shipments/${expired}/schedules`);
    cy.get('[data-testid="spot-offer-expired-banner"]', { timeout: 20000 }).should("contain", "can't be booked any more").and("contain", "Send Booking Request stays blocked");
    cy.get('[data-testid="spot-offer-expired"]').should("be.visible");
    cy.get('[data-testid="shipment-schedules-spot-offer-section"]').scrollIntoView();
    cy.screenshot("spot-3-expired", { capture: "viewport" });
  });

  it("prices a quote on a spot offer: carrier locked, buy / sell / margin", () => {
    goto("quotes");
    cy.get('input[placeholder*="Search"]', { timeout: 20000 }).first().type(quoteId);
    // The quote list's rows aren't <tr>s (DataTable): the id's own cell opens it.
    cy.contains(quoteId, { timeout: 15000 }).click();
    cy.contains("button", "Edit", { timeout: 15000 }).click();
    cy.get('[data-testid="quote-spot-add"]').click();
    cy.get('[data-testid="spot-carrier-input"]').type("CMDU");
    // The quote's lines name its containers, so the offer takes them as they are.
    cy.get('[data-testid="add-spot-offer-modal"] input[value="2 × 40HC"]').should("exist");
    cy.get('[data-testid="spot-ref-input"]').type(`QQUOTE${String(stamp).slice(-5)}`);
    cy.get('[data-testid="spot-valid-date"]').type(inDays(14));
    cy.get('[data-testid="spot-charge-price-0"]').type("2050");
    cy.get('[data-testid="spot-save"]').click();
    cy.get('[data-testid="quote-spot-offer"]', { timeout: 15000 }).should("be.visible");
    cy.get('[data-testid="quote-spot-ref"]').should("contain", `QQUOTE${String(stamp).slice(-5)}`);
    cy.get('[data-testid="quote-carrier-locked"]').should("have.value", "CMDU");
    cy.get('[data-testid="quote-margin-buy"]').should("contain", "USD 4,100.00");
    cy.get('[data-testid="quote-margin-sell"]').should("contain", "USD 5,000.00");
    cy.get('[data-testid="quote-margin-value"]').should("contain", "USD 900.00 · 18.0%");
    cy.get('[data-testid="quote-spot-offer"]').scrollIntoView();
    cy.screenshot("spot-4-quote", { capture: "viewport" });
    cy.contains("button", "Save Changes").click();
    cy.contains("Quote updated", { timeout: 10000 }).should("be.visible");
    api("GET", `/quotes/${quoteId}`).then(res => {
      expect(res.body.carrierCode).to.eq("CMDU");
      expect(res.body.contractRef).to.eq(`QQUOTE${String(stamp).slice(-5)}`);
      expect(res.body.spotOfferId).to.match(/^SPO-/);
    });
  });

  it("takes an offer from the carrier (the demo carrier stands in)", () => {
    goto(`shipments/${fromCarrier}/schedules`);
    cy.get('[data-testid="spot-offer-add"]', { timeout: 20000 }).click();
    cy.get('[data-testid="spot-tab-carrier"]').click();
    cy.get('[data-testid="spot-carrier-row-0"]', { timeout: 15000 }).should("contain", "CMDUSPOT");
    cy.get('[data-testid="spot-carrier-demo"]').should("contain", "DEMO CARRIER");
    cy.screenshot("spot-6-carrier-offers", { capture: "viewport" });
    cy.get('[data-testid="spot-carrier-take-0"]').click();
    cy.get('[data-testid="spot-offer-card"]', { timeout: 15000 }).should("contain", "Digital spot").and("contain", "Demo carrier");
    cy.get('[data-testid="spot-offer-ref"]').should("contain", "CMDUSPOT");
  });

  it("the sailing picker prices each departure; Sailing + offer takes it on Save", () => {
    goto(`shipments/${viaPicker}/schedules`);
    cy.contains("button", /Change Sailing|Add Sailing/, { timeout: 20000 }).click();
    cy.get('[data-testid="sailing-spot-toggle"]', { timeout: 15000 }).should("contain", "CMDU spot prices");
    cy.get('[data-testid^="sailing-spot-take-"]', { timeout: 15000 }).first().then($b => {
      cy.wrap($b).closest('[data-testid^="sailing-spot-"]').scrollIntoView();
      cy.screenshot("spot-7-picker-prices", { capture: "viewport" });
      cy.wrap($b).click();
    });
    cy.get("body").then($body => {
      if ($body.find('[data-testid="shipment-schedules-confirm-sailing-replace-btn"]').length)
        cy.get('[data-testid="shipment-schedules-confirm-sailing-replace-btn"]').click();
    });
    cy.get('[data-testid="spot-offer-pending"]', { timeout: 10000 }).should("contain", "On Save");
    cy.get('[data-testid="shipment-schedules-save-btn"]').click();
    cy.get('[data-testid="spot-offer-card"]', { timeout: 20000 }).should("contain", "Demo carrier");
    cy.get('[data-testid="spot-offer-pending"]').should("not.exist");
  });

  it("Master Data → Margin Rules lists the rule; the quote applies it and flags the minimum", () => {
    goto("mdm-margin-rules");
    cy.contains(`Spot UI Shipper ${stamp} BV`, { timeout: 20000 }).should("be.visible");
    cy.contains("USD 150 per container").should("be.visible");
    cy.screenshot("spot-8-margin-rules", { capture: "viewport" });
    newOffer({ offerRef: `QRULE${String(stamp).slice(-6)}` }).then(o => {
      api("POST", `/quotes/${ruleQuoteId}/spot-offer`, { offerId: o.id }).then(res => expect(res.status).to.eq(200));
    });
    goto("quotes");
    cy.get('input[placeholder*="Search"]', { timeout: 20000 }).first().type(ruleQuoteId);
    cy.contains(ruleQuoteId, { timeout: 15000 }).click();
    cy.contains("button", "Edit", { timeout: 15000 }).click();
    cy.get('[data-testid="quote-margin-rule"]', { timeout: 15000 }).should("contain", "USD 150 per container").and("contain", "minimum 8%");
    // Buy 4,175 (OF 2 × 2,050 + DOC 75), sell 4,300: 2.9%, under the 8% minimum.
    cy.get('[data-testid="quote-margin-below"]').should("contain", "Below the 8% minimum");
    cy.get('[data-testid="quote-margin-rule"]').scrollIntoView();
    cy.screenshot("spot-9-quote-below-minimum", { capture: "viewport" });
    cy.get('[data-testid="quote-margin-apply"]').click();
    // OF 2 × (2,050 + 150) + DOC 75 = 4,475: 6.7% — still under 8%, as the rule's minimum says.
    cy.get('[data-testid="quote-margin-sell"]').should("contain", "USD 4,475.00");
    cy.get('[data-testid="quote-margin-value"]').should("contain", "USD 300.00 · 6.7%");
  });

  it("warns about the offer's fee before cancelling a confirmed booking", () => {
    goto(`shipments/${cancelling}/booking/review`);
    cy.contains("button", "Cancel Booking", { timeout: 20000 }).click();
    cy.get('[data-testid="cancel-spot-fee"]', { timeout: 10000 }).should("contain", "No-show fee: USD 600.00").and("contain", "2 × USD 300");
    cy.screenshot("spot-5-cancel-fee", { capture: "viewport" });
  });
});
