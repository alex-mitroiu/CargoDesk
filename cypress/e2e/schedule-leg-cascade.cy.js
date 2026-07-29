/**
 * Schedule Leg-Removal Cascade Suite
 *
 * Covers three linked bugs found live on a real shipment (SHP-JFULNY) while a schedule
 * was already assigned to it:
 *
 *   1. A freshly-added leg ("+ Add leg") used to be immediately locked/uneditable —
 *      it defaults to legType SEA, which got caught by the "SEA legs are locked while
 *      a schedule exists" rule even though it was never actually part of that schedule,
 *      so its type could never be changed to Pick-up/Delivery.
 *   2. Removing that stuck, unconfigured leg cascaded into wiping the ENTIRE real
 *      schedule — the cascade compared raw SEA-leg COUNTS before/after, which can't
 *      tell a schedule-linked leg (real vessel/voyage data) from a brand new blank one.
 *   3. Once a schedule really is unlinked, the shipment header kept showing the stale
 *      vessel/ETD/routing forever (syncShipmentFromLegs bailed out early when 0 legs
 *      remained instead of clearing what it had written), and Carrier Booking stayed
 *      fully open even with no schedule attached (its gate only ever checked "does a
 *      booking row exist," never re-checked afterward).
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Schedule Leg-Removal Cascade Suite", () => {
  let tok;
  let shipmentId;

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; });
  });

  before(() => {
    cy.request({
      method: "POST", url: "/api/shipments",
      headers: { Authorization: `Bearer ${tok}` },
      body: { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT" },
      failOnStatusCode: false,
    }).then(res => {
      expect(res.status).to.eq(201);
      shipmentId = res.body.id;
    });
  });

  // A real SEA leg carrying vessel/voyage data, exactly as applySailingToLegs would leave
  // it after a genuine "Add Sailing" — this is what should be lockable/cascade-worthy.
  before(() => {
    api("POST", `/shipments/${shipmentId}/legs`, {
      legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
      etd: "2026-08-10", eta: "2026-09-05",
      carrierCode: "MAEU", vessel: "DEMO CADENZA", vesselImo: "9999999", voyage: "DM003W",
    }).then(res => expect(res.status).to.eq(201));
  });

  // A shipment_schedules row so hasSchedule/lockedSeaLegs is true — also auto-creates a
  // carrier_bookings row via ensureBookingCreated, matching the reported scenario where a
  // booking already existed by the time the schedule later got wiped.
  before(() => {
    api("POST", `/shipments/${shipmentId}/schedules`, {
      carrier: "MAEU", vesselName: "DEMO CADENZA", voyageNumber: "DM003W",
      pol: "NLRTM", pod: "USNYC", etd: "2026-08-10", eta: "2026-09-05",
    }).then(res => expect(res.status).to.eq(201));
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  beforeEach(() => {
    // loginSession caches the real login once per spec file instead of once per test —
    // routes/auth.js's per-IP rate limiter (20/15min, no test-mode bypass) is otherwise
    // exhausted well before a full `npx cypress run` across every spec finishes.
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
  });

  it("bug 1 — a freshly-added leg stays editable even while a schedule is already assigned", () => {
    // Hash-only navigation, not a second cy.visit() — a genuine reload re-mounts the whole
    // app and has been observed losing the license-accepted flag from the cached session
    // (the auth token survives, so this isn't a full storage wipe — just this one flag),
    // re-showing the license modal on top of the page. Same fix already proven in
    // shipment-reorg.cy.js for the identical symptom.
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/schedules`; });
    cy.contains(shipmentId, { timeout: 15000 }).should("be.visible");
    cy.contains("button", "+ Add leg").click();
    // The new row must render a real, enabled Leg Type <select> — not a locked read-only
    // row (which would render plain text with no <select> at all).
    cy.get('[id^="leg-row-"]').should("have.length", 2);
    cy.get('[id^="leg-row-"]').last().find("select").first().should("be.enabled");
    // And it must actually be changeable to Pick-up/Delivery, not just present.
    cy.get('[id^="leg-row-"]').last().find("select").first().select("Pick-up");
    cy.get('[id^="leg-row-"]').last().find("select").first().should("have.value", "Pick-up");
  });

  it("bug 2 — removing that unconfigured new leg does NOT wipe the real schedule/vessel", () => {
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/schedules`; });
    cy.contains(shipmentId, { timeout: 15000 }).should("be.visible");
    cy.get('[id^="leg-row-"]').should("have.length", 2);
    // Select the freshly-added (still-blank, no vessel/voyage) leg and remove it.
    cy.get('[id^="leg-row-"]').last().click();
    cy.contains("button", "Remove leg").click();
    // Must NOT warn about cascading — this leg was never actually part of the schedule.
    cy.contains("This is linked to an assigned schedule").should("not.exist");
    cy.contains("button", "Remove").click();
    // The real schedule leg + vessel data must still be there afterward.
    cy.contains("DEMO CADENZA", { timeout: 8000 }).should("exist");
    cy.get('[id^="leg-row-"]').should("have.length", 1);
    api("GET", `/shipments/${shipmentId}`).then(res => {
      expect(res.body.vessel).to.eq("DEMO CADENZA");
      expect(res.body.voyage).to.eq("DM003W");
    });
    api("GET", `/shipments/${shipmentId}/schedules`).then(res => {
      expect(res.body).to.have.length(1);
    });
  });

  it("bug 3 — removing the REAL schedule leg still cascades correctly, clears the header, and blocks Carrier Booking", () => {
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/schedules`; });
    cy.contains(shipmentId, { timeout: 15000 }).should("be.visible");
    cy.contains('[id^="leg-row-"]', "DEMO CADENZA").click();
    cy.contains("button", "Remove leg").click();
    // This one really is the schedule's own leg — the cascade warning SHOULD show.
    cy.contains("This is linked to an assigned schedule").should("be.visible");
    cy.contains("button", "Remove").click();
    cy.contains("No legs yet", { timeout: 8000 }).should("be.visible");
    // Header no longer shows the stale vessel/voyage.
    cy.contains("DEMO CADENZA").should("not.exist");

    api("GET", `/shipments/${shipmentId}`).then(res => {
      expect(res.body.vessel).to.eq("");
      expect(res.body.voyage).to.eq("");
      expect(res.body.etd).to.eq("");
    });
    api("GET", `/shipments/${shipmentId}/schedules`).then(res => {
      expect(res.body).to.have.length(0);
    });

    // Carrier Booking must now be blocked — even though a booking record already exists
    // from when the schedule was still valid (ensureBookingCreated auto-created one above).
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/booking/details`; });
    cy.contains("Carrier Booking Unavailable", { timeout: 8000 }).should("be.visible");
    cy.contains("doesn't have a schedule assigned").should("be.visible");
  });
});
