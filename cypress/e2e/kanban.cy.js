/**
 * Kanban Suite — v0.26.0 "Meridian II"
 *
 * Covers: ticket CRUD, partial PUT body (bug fix in v0.26.0 — drag-reorder
 * sending only `position` must not crash), ticket linking, and shipment filter.
 *
 * Prerequisites:
 *   - npm run dev  (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Kanban Suite", () => {
  let tok;
  let ticketId;
  let linkedId;
  let shipmentId;

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  before(() => {
    cy.request("POST", "/api/auth/login", {
      email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
    }).then(res => {
      expect(res.status).to.eq(200);
      tok = res.body.token;
    });
  });

  after(() => {
    if (linkedId)   api("DELETE", `/tickets/${linkedId}`);
    if (ticketId)   api("DELETE", `/tickets/${ticketId}`);
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  // ── Create ──────────────────────────────────────────────────────────────────

  context("Ticket creation", () => {
    it("POST /api/tickets → 201 with id and mapped fields", () => {
      api("POST", "/tickets", {
        title: "Cypress kanban ticket",
        type: "Task", priority: "Medium", status: "Ready",
      }).then(res => {
        expect(res.status).to.eq(201);
        expect(res.body).to.have.property("id");
        expect(res.body.title).to.eq("Cypress kanban ticket");
        expect(res.body.type).to.eq("Task");
        expect(res.body.status).to.eq("Ready");
        ticketId = res.body.id;
      });
    });

    it("appears in GET /api/tickets list", () => {
      api("GET", "/tickets").then(res => {
        expect(res.status).to.eq(200);
        const found = res.body.find(t => t.id === ticketId);
        expect(found, "ticket not in list").to.not.be.undefined;
      });
    });

    it("POST without title → 400", () => {
      api("POST", "/tickets", { type: "Task", status: "Ready" }).then(res => {
        expect(res.status).to.eq(400);
      });
    });
  });

  // ── Update ──────────────────────────────────────────────────────────────────

  context("Ticket update — full body", () => {
    it("PUT with full body updates status to In Progress", () => {
      api("GET", "/tickets").then(res => {
        const t = res.body.find(x => x.id === ticketId);
        return api("PUT", `/tickets/${ticketId}`, { ...t, status: "In Progress" });
      }).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body.status).to.eq("In Progress");
      });
    });

    it("updated status is reflected in the list", () => {
      api("GET", "/tickets").then(res => {
        const t = res.body.find(x => x.id === ticketId);
        expect(t.status).to.eq("In Progress");
      });
    });
  });

  context("Ticket update — partial body (drag-reorder regression)", () => {
    it("PUT with only position field does not crash (bug fixed v0.26.0)", () => {
      // The old code would send `undefined` for title → SQLite bind error
      api("PUT", `/tickets/${ticketId}`, { position: 99 }).then(res => {
        // Must not be 500; the route merges with existing record
        expect(res.status).to.eq(200);
        expect(res.body.id).to.eq(ticketId);
        // Other fields must be preserved, not blanked
        expect(res.body.title).to.eq("Cypress kanban ticket");
      });
    });

    it("position value is persisted after partial PUT", () => {
      api("GET", "/tickets").then(res => {
        const t = res.body.find(x => x.id === ticketId);
        expect(t.position).to.eq(99);
      });
    });

    it("PUT with only status field preserves title", () => {
      api("PUT", `/tickets/${ticketId}`, { status: "Done" }).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body.title).to.eq("Cypress kanban ticket");
        expect(res.body.status).to.eq("Done");
      });
    });
  });

  // ── Ticket Linking ──────────────────────────────────────────────────────────

  context("Ticket linking", () => {
    before(() => {
      // Create a second ticket to link to
      api("POST", "/tickets", {
        title: "Cypress linked target",
        type: "Task", priority: "Low", status: "Ready",
      }).then(res => { linkedId = res.body.id; });
    });

    it("POST /api/tickets/:id/links creates a link between two tickets", () => {
      // Route is nested under the source ticket: POST /api/tickets/:id/links
      // Body: { toId, linkType } — linkType must be title-cased for inverseLinkLabel to work
      api("POST", `/tickets/${ticketId}/links`, {
        toId: linkedId, linkType: "Blocks",
      }).then(res => {
        expect(res.status).to.eq(201);
        expect(res.body).to.have.property("id");
        expect(res.body.fromId).to.eq(ticketId);
        expect(res.body.toId).to.eq(linkedId);
        expect(res.body.linkType).to.eq("Blocks");
      });
    });

    it("GET /api/tickets/:id/links returns the link from the source ticket", () => {
      api("GET", `/tickets/${ticketId}/links`).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.be.an("array").with.length.greaterThan(0);
        const link = res.body[0];
        expect(link.otherTicketId).to.eq(linkedId);
        expect(link.linkType).to.eq("Blocks");
      });
    });

    it("GET /api/tickets/:id/links from target shows inverse label", () => {
      api("GET", `/tickets/${linkedId}/links`).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.be.an("array").with.length.greaterThan(0);
        // inverseLinkLabel("Blocks") = "Is blocked by"  (title-cased in server.js)
        const label = res.body[0].displayType ?? res.body[0].label ?? "";
        expect(label.toLowerCase()).to.include("blocked by");
      });
    });
  });

  // ── Shipment-scoped Tickets ─────────────────────────────────────────────────

  context("Tickets filtered by shipmentId", () => {
    before(() => {
      api("POST", "/shipments", {
        pol: "CNSHA", pod: "DEHAM", carrierCode: "CMDU",
        status: "Active", contractType: "SPOT", etd: "2026-11-01",
      }).then(res => { shipmentId = res.body.id; });
    });

    it("ticket linked to shipment appears in ?shipmentId= filter", () => {
      api("POST", "/tickets", {
        title: "Shipment-linked ticket", type: "Task",
        priority: "Low", status: "Ready", shipmentId,
      }).then(res => {
        const sid = res.body.id;
        return api("GET", `/tickets?shipmentId=${shipmentId}`).then(listRes => {
          const found = listRes.body.find(t => t.id === sid);
          expect(found).to.not.be.undefined;
          api("DELETE", `/tickets/${sid}`);
        });
      });
    });

    it("unknown shipmentId returns empty array", () => {
      api("GET", "/tickets?shipmentId=SHP-DOESNOTEXIST").then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.be.an("array").with.length(0);
      });
    });
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  context("Ticket deletion", () => {
    it("DELETE /api/tickets/:id → 200", () => {
      api("POST", "/tickets", {
        title: "To be deleted", type: "Task", priority: "Low", status: "Ready",
      }).then(res => {
        const id = res.body.id;
        return api("DELETE", `/tickets/${id}`);
      }).then(res => {
        expect(res.status).to.eq(200);
      });
    });

    it("DELETE non-existent ticket → 404", () => {
      api("DELETE", "/tickets/TKT-DOESNOTEXIST-SMOKE").then(res => {
        expect(res.status).to.eq(404);
      });
    });
  });
});
