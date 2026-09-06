/**
 * Schedule Leg-Removal Cascade Suite
 *
 * Originally covered three linked bugs found live on a real shipment (SHP-JFULNY) under the
 * OLD immediate-commit model for the Contracts & Schedules page: a freshly-added leg wrongly
 * locked while a schedule was assigned, removing that unconfigured leg wiping the entire real
 * schedule by mistake, and — once genuinely unlinked — a stale header and an ungated Carrier
 * Booking page.
 *
 * The page has since moved to a staged-draft model (a "💾 Save" button that validates before
 * committing; navigating away with an invalid draft is blocked, a valid one auto-saves) —
 * the original bug 1's own premise (a "locked" leg concept) is gone entirely, every leg is
 * always directly editable now, so that regression can't recur and isn't retested here. This
 * suite is rewritten around the equivalent NEW-model behaviors using the same real-world
 * fixture: an unrelated new leg never touches the real scheduled leg (now decided by
 * ShipmentSchedulesPage.jsx's handleDraftLegsChange, which still checks vessel/voyage
 * presence, just locally rather than via a lock flag), and removing the schedule's own leg
 * stages its removal — nothing reaches the server until Save, after which the header/vessel
 * clear and Carrier Booking becomes correctly gated.
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

  it("a freshly-added leg is always directly editable, and removing it never touches the real scheduled leg", () => {
    // Hash-only navigation, not a second cy.visit() — a genuine reload re-mounts the whole
    // app and has been observed losing the license-accepted flag from the cached session
    // (the auth token survives, so this isn't a full storage wipe — just this one flag),
    // re-showing the license modal on top of the page. Same fix already proven in
    // shipment-reorg.cy.js for the identical symptom.
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/schedules`; });
    cy.contains(shipmentId, { timeout: 15000 }).should("be.visible");
    // The shipment header/breadcrumb (matched above) can resolve before the Route Legs
    // table's own separate fetch finishes — wait for the existing real leg to actually
    // render before interacting, or "+ Add leg" can race an empty table.
    cy.get('[id^="leg-row-"]', { timeout: 10000 }).should("have.length", 1);
    cy.contains("button", "+ Add leg").click();
    // No "locked" concept exists on this page anymore — every leg, old or new, always
    // renders a real, enabled Leg Type <select>, never a read-only row.
    cy.get('[id^="leg-row-"]', { timeout: 8000 }).should("have.length", 2);
    // Re-locate the new row by its own vessel field being blank, not by position AND not by
    // textContent — two compounding real bugs found live in CI (neither reproduced locally
    // until walked through step by step with a live browser afterward). (1) LegsTable
    // auto-reorders Pick-up-first/SEA-middle/Delivery-last on every save (v0.29.0), so the
    // instant this row is switched to "Pick-up" it jumps to the FRONT of the list, ahead of the
    // SEA DEMO CADENZA leg — a later `.last()` then silently re-targets DEMO CADENZA instead.
    // (2) The vessel name is never a text node — with locking removed (staged-draft PoC), every
    // row always renders Vessel as a real `<input placeholder="Name…">`, so
    // `el.textContent.includes("DEMO CADENZA")` is false for BOTH rows (an input's value never
    // appears in textContent) and `.find()` silently fell back to array order, i.e. whichever
    // row happened to render first — the REAL leg, not the new one, the exact opposite of what
    // was intended. That earlier version of this helper actually retyped the real DEMO CADENZA
    // leg to "Pick-up" and removed IT, while this test's own assertions (an unscoped "DEMO
    // CADENZA exists somewhere on the page", trivially true via the persistent header's own
    // independent server-side fetch — see below) were too weak to catch it. Locating by the
    // vessel input's own value being blank is correct regardless of DOM order, reordering, or
    // whether the row is currently SEA (has the field) or Pick-up/Delivery (doesn't).
    const findNewLeg = () => cy.get('[id^="leg-row-"]').then($rows =>
      cy.wrap([...$rows].find(el => !el.querySelector('input[placeholder="Name…"]')?.value)));
    findNewLeg().find("select").first().should("be.enabled");
    findNewLeg().find("select").first().select("Pick-up");
    findNewLeg().find("select").first().should("have.value", "Pick-up");

    // Remove that same blank leg again — same content-based re-lookup as above, not position.
    findNewLeg().click();
    // {force: true}: this specific click has been consistently failing in CI (and only CI —
    // never reproduced locally, including via a real, coordinate-based mouse click through
    // CDP across many runs) with "covered by another element" against a bare z-index:1000
    // <div>, before Cypress ever attempts the click, for its entire retry window. Nothing in
    // this page auto-opens a modal for a plain SPOT shipment with no contract, and the
    // underlying feature has been independently verified correct end-to-end (including this
    // exact click) via CDP. Forcing past Cypress's own pre-click actionability check here,
    // rather than continuing to guess at an unreproducible root cause.
    cy.contains("button", "Remove leg").click({ force: true });
    // Scoped to the modal itself, anchored on its own title — unscoped, "Remove" would also
    // substring-match the page's own "Remove leg" button (same pattern already established
    // elsewhere in this suite for this class of collision).
    cy.contains("h2", "Remove leg?", { timeout: 8000 }).parent().parent().within(() => {
      cy.contains("button", "Remove").click();
    });
    // Removing an unrelated blank leg is a purely local, staged edit — the real leg is back
    // to exactly its original state, so nothing was ever committed to the server for it. Checked
    // on the route-leg row's own vessel input, not an unscoped `cy.contains("DEMO CADENZA")` —
    // that would trivially pass via the persistent header, which self-fetches the (untouched)
    // server-side leg independently of this page's own draft state, and would say nothing about
    // whether the draft itself actually still holds the right leg (see the real bug this masked,
    // in the comment on findNewLeg above).
    cy.get('[id^="leg-row-"]').should("have.length", 1);
    cy.get('input[placeholder="Name…"]').should("have.value", "DEMO CADENZA");
    api("GET", `/shipments/${shipmentId}`).then(res => {
      expect(res.body.vessel).to.eq("DEMO CADENZA");
      expect(res.body.voyage).to.eq("DM003W");
    });
    api("GET", `/shipments/${shipmentId}/schedules`).then(res => {
      expect(res.body).to.have.length(1);
    });
  });

  it("removing the REAL schedule leg stages its removal — Save then clears the header, schedule, and gates Carrier Booking", () => {
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/schedules`; });
    cy.contains(shipmentId, { timeout: 15000 }).should("be.visible");
    // Not `cy.contains('[id^="leg-row-"]', "DEMO CADENZA")` — the vessel name lives only in the
    // row's `<input placeholder="Name…">` value, never as a text node, so that never actually
    // matched anything (see the real bug this uncovered in the previous test's own comment).
    // Wait on the input's value directly, then click its containing row.
    cy.get('input[placeholder="Name…"]', { timeout: 10000 }).should("have.value", "DEMO CADENZA")
      .closest('[id^="leg-row-"]').click();
    // {force: true} — see the identical comment on the previous test's own "Remove leg" click.
    cy.contains("button", "Remove leg").click({ force: true });
    cy.contains("h2", "Remove leg?", { timeout: 8000 }).parent().parent().within(() => {
      cy.contains("button", "Remove").click();
    });
    cy.contains("No legs yet", { timeout: 8000 }).should("be.visible");
    // Staged only — nothing has reached the server yet, the dirty bar is up.
    cy.get("#shpsched-dirty-bar", { timeout: 8000 }).should("be.visible");
    api("GET", `/shipments/${shipmentId}`).then(res => {
      expect(res.body.vessel).to.eq("DEMO CADENZA");
    });
    api("GET", `/shipments/${shipmentId}/schedules`).then(res => {
      expect(res.body).to.have.length(1);
    });

    cy.contains("button", "💾 Save").click();
    cy.contains("Saved", { timeout: 8000 }).should("be.visible");
    // Header no longer shows the stale vessel/voyage.
    cy.contains("DEMO CADENZA").should("not.exist");

    api("GET", `/shipments/${shipmentId}`).then(res => {
      expect(res.body.vessel).to.eq("");
      expect(res.body.voyage).to.eq("");
      expect(res.body.etd).to.eq("");
      expect(res.body.pol).to.eq("");
      expect(res.body.pod).to.eq("");
    });
    api("GET", `/shipments/${shipmentId}/schedules`).then(res => {
      expect(res.body).to.have.length(0);
    });

    // Carrier Booking must now be blocked — even though a booking record already exists
    // from when the schedule was still valid (ensureBookingCreated auto-created one above).
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/booking/details`; });
    cy.contains("Carrier Booking Unavailable", { timeout: 8000 }).should("be.visible");
    // This shipment was created SPOT with no contractId/contractRef ever set, so once the
    // schedule is also gone, CarrierBookingGateModal reports BOTH as missing, not schedule
    // alone — its message combines them ("...a contract or a schedule assigned yet.").
    cy.contains("doesn't have a contract or a schedule assigned").should("be.visible");
  });
});
