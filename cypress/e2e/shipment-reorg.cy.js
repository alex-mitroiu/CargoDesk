/**
 * Shipment Detail Reorg Suite — v0.31.0+ (TKT-7NBD2P)
 *
 * Covers: the sequential shipment-detail-page reorg —
 *   - Sidebar nav order matches the FCL operational lifecycle (Conditions →
 *     Parties & Offices → Contracts & Schedules → Cargo → Milestones & Events
 *     → Documents → Accounting → History)
 *   - Documents is now a real promoted page (was a modal off a sidebar button)
 *   - Tickets is no longer a sidebar nav entry — it's a header drawer instead
 *   - The Tickets drawer opens from the header icon and shows the same
 *     RelatedTicketsPanel content, embedded
 *   - The container-events lifecycle stepper renders on Milestones & Events,
 *     one strip per container, defaulting to step 1 ("current") with none
 *     of the 7 steps logged yet
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / admin
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "admin";

describe("Shipment Detail Reorg Suite", () => {
  let tok;
  let shipmentId;
  let containerId;

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
      body: { pol: "CNSHA", pod: "USNYC", carrierCode: "CMDU",
              status: "Active", contractType: "SPOT", etd: "2026-10-01" },
      failOnStatusCode: false,
    }).then(res => {
      expect(res.status).to.eq(201);
      shipmentId = res.body.id;
    });
  });

  before(() => {
    api("POST", "/containers", {
      shipmentId, size: "40", type: "GP",
      containerNumber: "CYPR1234567",
    }).then(res => { containerId = res.body.id; });
  });

  after(() => {
    if (containerId) api("DELETE", `/containers/${containerId}`);
    if (shipmentId)  api("DELETE", `/shipments/${shipmentId}`);
  });

  beforeEach(() => {
    cy.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    cy.visit(`/#shipments/${shipmentId}`);
    cy.contains(shipmentId, { timeout: 8000 }).should("be.visible");
  });

  context("Sidebar nav order", () => {
    it("lists sections in FCL operational-lifecycle order, with no Tickets entry", () => {
      const expectedOrder = [
        "Conditions", "Parties & Offices", "Contracts & Schedules",
        "Cargo", "Milestones & Events", "Documents", "Accounting", "History",
      ];
      cy.get("nav").invoke("text").then(navText => {
        const positions = expectedOrder.map(label => navText.indexOf(label));
        positions.forEach((pos, i) => {
          expect(pos, `"${expectedOrder[i]}" should be present in the nav`).to.be.greaterThan(-1);
        });
        for (let i = 1; i < positions.length; i++) {
          expect(positions[i], `"${expectedOrder[i]}" should come after "${expectedOrder[i - 1]}"`)
            .to.be.greaterThan(positions[i - 1]);
        }
        expect(navText).to.not.contain("Tickets");
      });
    });
  });

  context("Documents — promoted page", () => {
    it("Documents nav item opens a full page with the readiness overview", () => {
      cy.get("nav").contains("Documents").click();
      cy.contains("Generate Document", { timeout: 8000 }).should("be.visible");
      cy.contains(/missing/i).should("be.visible");
    });
  });

  context("Milestones & Events — container lifecycle stepper", () => {
    it("shows a per-container stepper alongside Shipment Milestones", () => {
      cy.get("nav").contains("Milestones & Events").click();
      cy.contains("Shipment Milestones", { timeout: 8000 }).should("be.visible");
      cy.contains("Container Events").should("be.visible");
      cy.contains(containerId).should("be.visible");
      cy.contains("0/7 complete").should("be.visible");
      cy.contains("Empty Pickup").should("be.visible");
      cy.contains("Empty Return").should("be.visible");
    });
  });

  context("Tickets — header drawer", () => {
    // IconTile renders its own custom on-brand tooltip rather than a native `title`
    // attribute (see ShipmentHeaderBar.jsx) — match the header icon by its glyph
    // instead of `[title*="ticket"]`, which never matches.
    it("opens from the header icon and shows the ticket list, embedded", () => {
      cy.contains("button", "◩").click();
      cy.contains("Tickets", { timeout: 8000 }).should("be.visible");
      cy.contains("No tickets linked to this shipment.").should("be.visible");
    });

    it("closes via the drawer's own close button", () => {
      cy.contains("button", "◩").click();
      cy.contains("No tickets linked to this shipment.", { timeout: 8000 }).should("be.visible");
      cy.get("button").contains("✕").click();
      cy.contains("No tickets linked to this shipment.").should("not.exist");
    });
  });
});
