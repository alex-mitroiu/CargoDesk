/**
 * Add Sailing — Catalog-First Search Suite (v0.54.0/v0.54.1)
 *
 * Covers GET /api/schedules/search's catalog-before-demo priority on the real "Add Sailing"
 * flow (ShipmentSchedulesPage.jsx) — previously only exercised against the mock/live fallback
 * (schedules-happy-path.cy.js, predates the catalog feature). Also covers the two live bugs
 * found and fixed on v0.54.1: stale mock-derived rows must never resurface as "Catalog"
 * matches, and the demo_schedules_enabled toggle's actual search-time effect.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Add Sailing — Catalog-First Search Suite", () => {
  let tok;
  const shipmentIds = [];
  const scheduleIds = [];

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  const scratchShipment = (pol, pod, carrierCode = "MAEU") =>
    api("POST", "/shipments", { pol, pod, carrierCode, status: "Active", contractType: "SPOT" })
      .then(res => { shipmentIds.push(res.body.id); return res.body.id; });

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; });
  });

  after(() => {
    shipmentIds.forEach(id => api("DELETE", `/shipments/${id}`));
    scheduleIds.forEach(id => api("DELETE", `/schedules/${id}`));
    // Restore the default in case an earlier test in this file left it toggled.
    api("PUT", "/settings", { demo_schedules_enabled: "true" });
  });

  const visitSchedulesPage = shipmentId => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/schedules`; });
    cy.contains("Connecting to database", { timeout: 60000 }).should("not.exist");
    cy.dismissStartupGates();
    cy.contains(shipmentId, { timeout: 60000 }).should("be.visible");
  };

  describe("Happy paths", () => {
    it("finds a real catalog template, tags it Catalog, and applies it to the SEA leg", () => {
      const pol = "AEDXB", pod = "BRSSZ";
      const etd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      cy.then(() => api("POST", "/schedules", {
        carrier: "MAEU", vesselName: "CATALOG HAPPY PATH", voyageNumber: "CHP1", pol, pod, etd,
      })).then(res => {
        expect(res.status).to.eq(201);
        scheduleIds.push(res.body.id);
        return scratchShipment(pol, pod);
      }).then(shipmentId => {
        visitSchedulesPage(shipmentId);
        cy.contains("button", "Add Sailing", { timeout: 20000 }).should("not.be.disabled").click();
        cy.contains(`Sailing Search — ${pol} → ${pod}`, { timeout: 10000 }).should("be.visible");
        cy.contains("CATALOG HAPPY PATH", { timeout: 15000 }).should("be.visible");
        cy.contains("Catalog", { timeout: 5000 }).should("be.visible");

        cy.contains("button", /Select →|Add →|✓ Active/).first().click();
        cy.contains(/Sailing.*saved|applied/, { timeout: 15000 }).should("exist");
      });
    });

    it("finds a real TSP catalog template and creates both SEA legs on the shipment", () => {
      const pol = "AEDXB", pod = "NZWLG", hub = "SGSIN";
      const etd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      cy.then(() => api("POST", "/schedules", {
        carrier: "MAEU", pol, pod, legs: [
          { pol, pod: hub, etd, eta: "2026-12-01", vesselName: "TSP HAPPY LEG1", voyageNumber: "THP1", carrier: "MAEU" },
          { pol: hub, pod, etd: "2026-12-02", eta: "2026-12-10", vesselName: "TSP HAPPY LEG2", voyageNumber: "THP2", carrier: "MSCU" },
        ],
      })).then(res => {
        expect(res.status).to.eq(201);
        scheduleIds.push(res.body.id);
        return scratchShipment(pol, pod);
      }).then(shipmentId => {
        visitSchedulesPage(shipmentId);
        cy.contains("button", "Add Sailing", { timeout: 20000 }).should("not.be.disabled").click();
        cy.contains("TSP HAPPY LEG1", { timeout: 15000 }).should("be.visible");
        cy.contains("TSP · 2 legs").should("be.visible");
        cy.contains("Will create 2 sea legs", { timeout: 5000 }).should("be.visible");

        cy.contains("button", /Select →|Add →|✓ Active/).first().click();
        cy.contains(/Sailing.*saved|applied/, { timeout: 15000 }).should("exist");

        cy.then(() => api("GET", `/shipments/${shipmentId}/legs`)).then(res => {
          const seaLegs = res.body.filter(l => l.legType === "SEA");
          expect(seaLegs, "two SEA legs from the TSP sailing").to.have.length(2);
          expect(seaLegs[0].pol).to.eq(pol);
          expect(seaLegs[0].pod).to.eq(hub);
          expect(seaLegs[1].pol).to.eq(hub);
          expect(seaLegs[1].pod).to.eq(pod);
        });
      });
    });
  });

  describe("Negative / edge scenarios", () => {
    it("a stale mock-derived row never surfaces tagged Catalog (regression, v0.54.1)", () => {
      const pol = "AEDXB", pod = "NZAKL";
      const etd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      let staleShipmentId;
      cy.then(() => scratchShipment(pol, pod)).then(id => {
        staleShipmentId = id;
        // Simulate the old pre-catalog behavior: Add Sailing always inserted a row for any
        // picked sailing, including demo ones — this is exactly the kind of row that used to
        // leak back into "Add Sailing" results mislabeled as real curated data.
        return api("POST", `/shipments/${staleShipmentId}/schedules`, {
          carrier: "MAEU", vesselName: "DEMO STALE ROW", pol, pod, etd, isMock: true,
        });
      }).then(res => {
        expect(res.status).to.eq(201);
        return scratchShipment(pol, pod);
      }).then(shipmentId => {
        visitSchedulesPage(shipmentId);
        cy.contains("button", "Add Sailing", { timeout: 20000 }).should("not.be.disabled").click();
        cy.contains(`Sailing Search — ${pol} → ${pod}`, { timeout: 10000 }).should("be.visible");
        cy.contains("DEMO STALE ROW").should("not.exist");
      }).then(() => api("DELETE", `/shipments/${staleShipmentId}`));
    });

    it("with demo schedules disabled and no real match, shows the empty state, not fake data", () => {
      cy.then(() => api("PUT", "/settings", { demo_schedules_enabled: "false" }));
      const pol = "AEDXB", pod = "CLVAP"; // an unusual pair unlikely to have any real data
      cy.then(() => scratchShipment(pol, pod)).then(shipmentId => {
        visitSchedulesPage(shipmentId);
        cy.contains("button", "Add Sailing", { timeout: 20000 }).should("not.be.disabled").click();
        cy.contains(`Sailing Search — ${pol} → ${pod}`, { timeout: 10000 }).should("be.visible");
        cy.contains("No sailings found for this route", { timeout: 10000 }).should("be.visible");
        cy.contains("DEMO", { matchCase: false }).should("not.exist");
      });
    });

    it("with demo schedules re-enabled, the same empty route falls back to a clearly-labeled demo sailing", () => {
      cy.then(() => api("PUT", "/settings", { demo_schedules_enabled: "true" }));
      const pol = "AEDXB", pod = "CLVAP";
      cy.then(() => scratchShipment(pol, pod)).then(shipmentId => {
        visitSchedulesPage(shipmentId);
        cy.contains("button", "Add Sailing", { timeout: 20000 }).should("not.be.disabled").click();
        cy.contains(`Sailing Search — ${pol} → ${pod}`, { timeout: 10000 }).should("be.visible");
        cy.contains("showing demo schedules", { timeout: 10000 }).should("be.visible");
        cy.contains("DEMO", { timeout: 5000 }).should("be.visible");
      });
    });
  });
});
