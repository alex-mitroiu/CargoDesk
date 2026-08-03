/**
 * Schedule Generator Suite (Test Tools > Schedule Generator)
 *
 * Covers the decoupled-from-shipments Generator (v0.54.0) and its v0.54.1 fixes: real
 * vessel-registry autocomplete and a per-leg Carrier picker in the Configure Legs modal.
 * Previously only covered at the API level (tests/schedule-catalog.test.js) — zero UI
 * regression protection existed for the Generator form itself, the TSP legs modal, or the
 * read-only catalog browser.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Schedule Generator Suite", () => {
  let tok;
  const createdScheduleIds = [];

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

  after(() => {
    createdScheduleIds.forEach(id => api("DELETE", `/schedules/${id}`));
  });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.window().then(win => { win.location.hash = "test-tools"; });
    cy.contains("Connecting to database", { timeout: 60000 }).should("not.exist");
    cy.dismissStartupGates();
    cy.contains("button", "Schedule Generator", { timeout: 20000 }).click();
    cy.contains("Generate a schedule", { timeout: 10000 }).should("be.visible");
  });

  // VesselCombobox's results dropdown is a sibling of the input's own wrapper div, both inside
  // one outer ref'd container — scoping the button search to that container (rather than a
  // page-wide `cy.get('button')`) avoids accidentally matching an unrelated button elsewhere on
  // the page whose text happens to contain a 7-digit number (e.g. a catalog row's own "IMO
  // 1234567" label) — a real flake caught while first writing this spec.
  const pickVessel = (inputPlaceholder, query = "a") => {
    cy.get(`input[placeholder="${inputPlaceholder}"]`).first().type(query);
    cy.get(`input[placeholder="${inputPlaceholder}"]`).first()
      .parents("div").first().parent()
      .find("button", { timeout: 8000 }).first().should("be.visible").click();
  };

  // Fills the main form's Vessel/Carrier/POL/POD pickers with real registry data — shared
  // by both the direct-sailing and TSP happy-path tests below.
  const fillMainForm = ({ vesselQuery = "a", carrier = "MAEU", pol = "NLRTM", pod = "USNYC" } = {}) => {
    pickVessel("Search by name or IMO…", vesselQuery);
    cy.get('input[placeholder="Search carrier code or name…"]').first().type(carrier);
    cy.contains("button", carrier, { timeout: 8000 }).click();
    cy.get('input[placeholder="Search POL…"]').type(pol);
    cy.contains("button", pol, { timeout: 8000 }).click();
    cy.get('input[placeholder="Search POD…"]').type(pod);
    cy.contains("button", pod, { timeout: 8000 }).click();
  };

  describe("Happy paths", () => {
    it("generates a direct (non-TSP) schedule and shows it in the read-only catalog browser", () => {
      fillMainForm({ pol: "NLRTM", pod: "USNYC" });
      cy.contains("Direct sailing (no transshipment)").should("be.visible");

      cy.contains("button", "Generate").click();
      cy.contains(/Schedule SCHED-\S+ created/, { timeout: 15000 }).should("be.visible")
        .invoke("text").then(text => {
          const id = text.match(/SCHED-\S+/)?.[0];
          if (id) createdScheduleIds.push(id);
        });

      // Form resets after a successful generate.
      cy.get('input[placeholder="Search by name or IMO…"]').should("exist");
      // Catalog browser (right column) picks up the new row without a manual reload.
      cy.contains("Generated Schedules").parent().within(() => {
        cy.contains("NLRTM", { timeout: 10000 }).should("be.visible");
        cy.contains("Used by 0 shipments").should("be.visible");
      });
    });

    it("builds a real 2-leg TSP schedule via Configure Legs, with real vessel autocomplete per leg", () => {
      fillMainForm({ pol: "AEDXB", pod: "AUMEL" });

      cy.contains("button", "Configure Legs (TSP)").click();
      cy.contains("h2", "Configure Legs", { timeout: 8000 }).should("be.visible");
      // Both rows pre-fill carrier from the main form's already-picked carrier (a sensible
      // default — same carrier usually applies to both legs, adjustable via each chip's own ✕).
      // Only vessel is left for the user to pick per leg — leg 1 inherits the main form's vessel
      // pick as a chip, leg 2 starts as a genuinely empty search field.
      cy.get('input[placeholder="Search vessel…"]').should("have.length", 1);
      cy.get('input[placeholder="Search carrier code or name…"]').should("have.length", 0);

      // Pick a real vessel on leg 2 (the empty one) via the real vessels registry search —
      // this is the actual regression check for the v0.54.1 fix (was a plain text input before).
      pickVessel("Search vessel…", "a");
      cy.get('input[placeholder="Search vessel…"]').should("not.exist"); // both legs now have a vessel chip

      // Set the intermediate hub on leg 1's POD / leg 2's POL.
      cy.get('input[placeholder="UNLOCODE"]').eq(1).clear().type("SGSIN"); // leg1 pod
      cy.get('input[placeholder="UNLOCODE"]').eq(2).clear().type("SGSIN"); // leg2 pol

      cy.contains("button", "Done").click();
      cy.contains("2-leg TSP sailing configured", { timeout: 8000 }).should("be.visible");

      cy.contains("button", "Generate").click();
      cy.contains(/Schedule SCHED-\S+ created.*2-leg TSP/, { timeout: 15000 })
        .invoke("text").then(text => {
          const id = text.match(/SCHED-\S+/)?.[0];
          if (id) createdScheduleIds.push(id);
        });

      cy.contains("Generated Schedules").parent().within(() => {
        cy.contains("TSP · 2 legs", { timeout: 10000 }).should("be.visible");
      });
    });

    it("regression: a TSP built entirely inside Configure Legs (main form left blank) still generates", () => {
      // Direct repro of a live bug report: filling every leg field inside the modal without
      // ever touching the main form's own Vessel/Carrier/POL/POD left Generate blocked, since
      // its validation only ever checked the top-level fields. Confirms the fix — leg 1/leg N
      // data alone is enough, and it also mirrors back onto the main form on Done.
      //
      // Because the main form is deliberately left blank here, its own (still-empty) Carrier
      // search input is still in the DOM too — just visually covered by the modal overlay.
      // Scoping every lookup to the modal's own content box (from its <h2>, 2 levels up per
      // Modal.jsx's structure) avoids ever touching that page-level input by accident.
      cy.contains("button", "Configure Legs (TSP)").click();
      cy.contains("h2", "Configure Legs", { timeout: 8000 }).should("be.visible")
        .parent().parent().within(() => {
          cy.get('input[placeholder="UNLOCODE"]').eq(0).type("NLRTM"); // leg1 pol
          cy.get('input[placeholder="UNLOCODE"]').eq(1).type("USMIA"); // leg1 pod
          cy.get('input[placeholder="UNLOCODE"]').eq(2).type("USMIA"); // leg2 pol
          cy.get('input[placeholder="UNLOCODE"]').eq(3).type("USNYC"); // leg2 pod

          pickVessel("Search vessel…", "a"); // leg1 vessel
          pickVessel("Search vessel…", "a"); // leg2 vessel (only one left after the first pick)

          // Only leg 1's carrier matters for the regression being verified (it's what the
          // top-level "effectiveCarrier" derivation reads) — leg 2 is left without one, itself
          // a legitimate state (a per-leg carrier is optional, only leg 1's feeds the summary).
          cy.get('input[placeholder="Search carrier code or name…"]').first().type("HLC");
          cy.contains("button", "HLCU", { timeout: 8000 }).click();
          cy.contains("button", "Done").click();
        });

      // Main form now mirrors leg 1 / leg N — no longer blank.
      cy.contains("h2", "Configure Legs").should("not.exist");
      cy.get('input[placeholder="Search by name or IMO…"]').should("not.exist"); // vessel chip now shown
      cy.contains("NLRTM").should("be.visible");
      cy.contains("USNYC").should("be.visible");

      cy.contains("button", "Generate").should("not.be.disabled").click();
      cy.contains("Pick a vessel").should("not.exist");
      cy.contains("Pick a carrier").should("not.exist");
      cy.contains("Pick POL and POD").should("not.exist");
      cy.contains(/Schedule SCHED-\S+ created.*2-leg TSP/, { timeout: 15000 })
        .invoke("text").then(text => {
          const id = text.match(/SCHED-\S+/)?.[0];
          if (id) createdScheduleIds.push(id);
        });
    });

    it("deletes a generated schedule from the catalog browser", () => {
      cy.then(() => api("POST", "/schedules", {
        carrier: "MAEU", vesselName: "CYPRESS DELETE ME", pol: "DEHAM", pod: "USNYC", etd: "2026-09-15",
      })).then(res => {
        expect(res.status).to.eq(201);
        cy.reload();
        cy.window().then(win => { win.location.hash = "test-tools"; });
        cy.contains("Connecting to database", { timeout: 60000 }).should("not.exist");
        cy.dismissStartupGates();
        cy.contains("button", "Schedule Generator", { timeout: 20000 }).click();
        cy.contains("CYPRESS DELETE ME", { timeout: 15000 }).should("be.visible");
        cy.contains("CYPRESS DELETE ME").parents("div").eq(1)
          .find('button[title="Delete schedule"]').click();
        cy.contains("Schedule deleted", { timeout: 10000 }).should("be.visible");
        cy.contains("CYPRESS DELETE ME").should("not.exist");
      });
    });
  });

  describe("Negative / validation scenarios", () => {
    it("blocks Generate with no vessel selected", () => {
      cy.get('input[placeholder="Search carrier code or name…"]').first().type("MAEU");
      cy.contains("button", "MAEU", { timeout: 8000 }).click();
      cy.get('input[placeholder="Search POL…"]').type("NLRTM");
      cy.contains("button", "NLRTM", { timeout: 8000 }).click();
      cy.get('input[placeholder="Search POD…"]').type("USNYC");
      cy.contains("button", "USNYC", { timeout: 8000 }).click();

      cy.contains("button", "Generate").click();
      cy.contains("Pick a vessel", { timeout: 8000 }).should("be.visible");
      cy.contains(/Schedule SCHED-\S+ created/).should("not.exist");
    });

    it("blocks Generate with no carrier selected", () => {
      pickVessel("Search by name or IMO…", "a");
      cy.get('input[placeholder="Search POL…"]').type("NLRTM");
      cy.contains("button", "NLRTM", { timeout: 8000 }).click();
      cy.get('input[placeholder="Search POD…"]').type("USNYC");
      cy.contains("button", "USNYC", { timeout: 8000 }).click();

      cy.contains("button", "Generate").click();
      cy.contains("Pick a carrier", { timeout: 8000 }).should("be.visible");
    });

    it("blocks Generate with no POL/POD selected", () => {
      pickVessel("Search by name or IMO…", "a");
      cy.get('input[placeholder="Search carrier code or name…"]').first().type("MAEU");
      cy.contains("button", "MAEU", { timeout: 8000 }).click();

      cy.contains("button", "Generate").click();
      cy.contains("Pick POL and POD", { timeout: 8000 }).should("be.visible");
    });

    it("Clear (direct sailing) reverts a configured TSP back to a direct sailing", () => {
      cy.contains("button", "Configure Legs (TSP)").click();
      cy.contains("h2", "Configure Legs", { timeout: 8000 }).should("be.visible");
      cy.contains("button", "+ Add Leg").click();
      cy.get('input[placeholder="UNLOCODE"]').should("have.length", 6); // 3 rows x 2

      cy.contains("button", "Clear (direct sailing)").click();
      cy.contains("h2", "Configure Legs").should("not.exist");
      cy.contains("Direct sailing (no transshipment)", { timeout: 8000 }).should("be.visible");
    });
  });
});
