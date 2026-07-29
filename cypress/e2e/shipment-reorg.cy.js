/**
 * Shipment Detail Reorg Suite — v0.31.0+ (TKT-7NBD2P)
 * Sidebar-order assertion updated for v0.44.0/SHP-JFULNY's admin-reorderable sidebar
 * (DEFAULT_SIDEBAR_ORDER, App.jsx) — the flat "Contracts & Schedules" top-level item this
 * suite originally checked for no longer exists; Schedules now lives nested inside the
 * "Booking & Routing" parent group alongside Carrier Booking and Customs Filing.
 *
 * Covers: the sequential shipment-detail-page reorg —
 *   - Top-level sidebar order matches DEFAULT_SIDEBAR_ORDER (Documents → Overview →
 *     Milestones & Events → Conditions → Parties & Offices → Cargo → Booking & Routing →
 *     Export Services → Import Services → Accounting → History)
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
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Shipment Detail Reorg Suite", () => {
  let tok;
  let shipmentId;
  let containerId;
  const CONTAINER_NUMBER = "CYPR1234567"; // the stepper strip is headed by the container
                                           // number, not the internal CTR- id

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  let savedSidebarOrder; // restored in after() — this suite pins the DEFAULT order to stay
                         // deterministic regardless of whatever an admin has since dragged
                         // it to (shipment_sidebar_order, App.jsx's reconcileSidebarOrder).

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; })
      .then(() => api("GET", "/settings"))
      .then(res => {
        savedSidebarOrder = res.body.shipment_sidebar_order; // JSON string, or undefined if never customized
        return api("PUT", "/settings/shipment-sidebar-order", { order: [] });
      });
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
      containerNumber: CONTAINER_NUMBER,
    }).then(res => { containerId = res.body.id; });
  });

  after(() => {
    if (containerId) api("DELETE", `/containers/${containerId}`);
    if (shipmentId)  api("DELETE", `/shipments/${shipmentId}`);
    if (savedSidebarOrder) {
      try {
        const order = JSON.parse(savedSidebarOrder);
        if (Array.isArray(order) && order.length) api("PUT", "/settings/shipment-sidebar-order", { order });
      } catch { /* was never a valid saved order — nothing to restore */ }
    }
  });

  beforeEach(() => {
    // loginSession caches the real login once per spec file instead of once per test —
    // routes/auth.js's per-IP rate limiter (20/15min, no test-mode bypass) is otherwise
    // exhausted well before a full `npx cypress run` across every spec finishes.
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    // A second cy.visit() is a genuine full page reload (not how this SPA's own hash router
    // ever navigates internally) — it re-mounts the whole app from scratch, re-triggering
    // per-session gates (license modal, office picker) that are only meant to appear once.
    // Set location.hash directly instead, exactly like a real in-app navigation/link click —
    // this fires a plain hashchange, no reload, app state (including the just-dismissed
    // gates) stays intact.
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}`; });
    // Both startup gates have been observed reappearing after navigating to a shipment
    // detail page even though they were already dismissed once during login —
    // dismissStartupGates() is idempotent/safe to call again, so do it defensively here too.
    cy.dismissStartupGates();
    cy.contains(shipmentId, { timeout: 10000 }).should("be.visible");
  });

  context("Sidebar nav order", () => {
    it("lists top-level blocks in DEFAULT_SIDEBAR_ORDER, with no Tickets entry", () => {
      // Mirrors App.jsx's DEFAULT_SIDEBAR_ORDER — Schedules/Carrier Booking/Customs Filing
      // are nested children of "Booking & Routing" now, not their own flat rows, so this only
      // checks the top-level block sequence, not what's inside each group. Export/Import
      // Services are deliberately excluded here even though they're in DEFAULT_SIDEBAR_ORDER
      // too — confirmed directly against App.jsx that those two blocks render nothing at all
      // (renderServiceGroup returns null) unless the shipment actually has that side's
      // generic service types available, which this plain SPOT/Port-to-Port scratch shipment
      // does not — asserting their presence unconditionally would be testing a state this
      // fixture was never in, not a real regression.
      const expectedOrder = [
        "Documents", "Overview", "Milestones & Events", "Conditions", "Parties & Offices",
        "Cargo", "Booking & Routing", "Accounting", "History",
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
      cy.contains(CONTAINER_NUMBER).should("be.visible");
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
      // The close button renders <IconClose> (an inline SVG path) rather than a literal "✕"
      // text character, so it can't be matched by content — scope to the header title's
      // sibling button instead (TicketsDrawer's header row: title div + close button).
      cy.contains("◩ Tickets").parent().find("button").click();
      cy.contains("No tickets linked to this shipment.").should("not.exist");
    });
  });
});
