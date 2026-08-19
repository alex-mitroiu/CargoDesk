/**
 * TKT-AW3Y7E — Core shipment CRUD test suite (Cypress)
 *
 * Exercises the full create → container → status-change → audit-log
 * lifecycle via the live API.
 *
 * Prerequisites:
 *   - npm run dev  (Vite :5173 + Express :3001)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

let authToken;

const api = (method, path, body) =>
  cy.request({
    method,
    url: `/api${path}`,
    headers: { Authorization: `Bearer ${authToken}` },
    failOnStatusCode: false,
    ...(body !== undefined && { body }),
  });

// ─── Auth ─────────────────────────────────────────────────────────────────────

before(() => {
  cy.request("POST", "/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  }).then(res => {
    expect(res.status).to.eq(200);
    authToken = res.body.token;
  });
});

// ─── POST /api/shipments ──────────────────────────────────────────────────────

describe("POST /api/shipments", () => {

  let shipmentId;

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  it("creates a shipment and returns 201", () => {
    api("POST", "/shipments", {
      pol: "CNSHA", pod: "USNYC",
      carrierCode: "CMDU",
      status: "Active",
      contractType: "SPOT",
      etd: "2026-09-01",
    }).then(res => {
      expect(res.status).to.eq(201);
      expect(res.body).to.have.property("id");
      shipmentId = res.body.id;
    });
  });

  it("response includes required fields", () => {
    api("POST", "/shipments", {
      pol: "SGSIN", pod: "DEHAM",
      carrierCode: "MSCU",
      status: "Active",
      contractType: "SPOT",
      etd: "2026-09-15",
    }).then(res => {
      expect(res.status).to.eq(201);
      const s = res.body;
      // include.keys (not all.keys) — the shipment DTO has grown a great many optional fields
      // over the project's life (office assignments, margin figures, space-config badges, ...);
      // this test's job is confirming these core fields are present, not enumerating every
      // field that exists today, which would break on every future addition.
      expect(s).to.include.keys(
        "id", "pol", "pod", "carrierCode", "status", "contractType",
        "etd", "eta", "bookingRef", "blNumber", "vessel", "voyage",
        "tradeLane", "routingTerm", "createdAt"
      );
      expect(s.pol).to.eq("SGSIN");
      expect(s.pod).to.eq("DEHAM");
      expect(s.carrierCode).to.eq("MSCU");
      api("DELETE", `/shipments/${s.id}`);
    });
  });

  it("returns 400 when required fields are missing", () => {
    api("POST", "/shipments", { status: "Active" }).then(res => {
      expect(res.status).to.eq(400);
    });
  });

});

// ─── GET /api/shipments/:id ───────────────────────────────────────────────────

describe("GET /api/shipments/:id", () => {

  let shipmentId;

  before(() => {
    api("POST", "/shipments", {
      pol: "CNSHA", pod: "NLRTM",
      carrierCode: "CMDU",
      status: "Active",
      contractType: "SPOT",
      etd: "2026-10-01",
    }).then(res => { shipmentId = res.body.id; });
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  it("returns the shipment by id", () => {
    api("GET", `/shipments/${shipmentId}`).then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.id).to.eq(shipmentId);
      expect(res.body.pol).to.eq("CNSHA");
      expect(res.body.pod).to.eq("NLRTM");
    });
  });

  it("returns 404 for a non-existent id", () => {
    api("GET", "/shipments/DOESNOTEXIST-999").then(res => {
      expect(res.status).to.eq(404);
    });
  });

});

// ─── POST /api/containers ─────────────────────────────────────────────────────

describe("POST /api/containers", () => {

  let shipmentId;
  let containerId;

  before(() => {
    api("POST", "/shipments", {
      pol: "CNSHA", pod: "USNYC",
      carrierCode: "CMDU",
      status: "Active",
      contractType: "SPOT",
      etd: "2026-10-10",
    }).then(res => { shipmentId = res.body.id; });
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  it("adds a container to a shipment and returns 201", () => {
    api("POST", "/containers", {
      shipmentId,
      size: "20",
      type: "GP",
      containerNumber: "CMDU1234567",
      cargoDescription: "General cargo",
    }).then(res => {
      expect(res.status).to.eq(201);
      expect(res.body).to.have.property("id");
      expect(res.body.shipmentId).to.eq(shipmentId);
      expect(res.body.size).to.eq("20");
      expect(res.body.type).to.eq("GP");
      containerId = res.body.id;
    });
  });

  it("container appears in shipment detail", () => {
    // Containers are never embedded on the shipment object itself — GET /api/shipments/:id has
    // no `containers` key at all (confirmed directly) — they live behind their own endpoint,
    // filtered by shipmentId.
    api("GET", `/containers?shipmentId=${shipmentId}`).then(res => {
      expect(res.status).to.eq(200);
      const found = res.body.find(c => c.id === containerId);
      expect(found).to.not.be.undefined;
    });
  });

  it("returns 400 when required fields are missing", () => {
    api("POST", "/containers", { shipmentId }).then(res => {
      expect(res.status).to.eq(400);
    });
  });

});

// ─── PUT /api/shipments/:id (status change) ───────────────────────────────────

describe("PUT /api/shipments/:id — status change", () => {

  let shipmentId;

  before(() => {
    api("POST", "/shipments", {
      pol: "CNSHA", pod: "USNYC",
      carrierCode: "CMDU",
      status: "Active",
      contractType: "SPOT",
      etd: "2026-11-01",
    }).then(res => { shipmentId = res.body.id; });
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  // "In Transit" is not (and per SHIPMENT_STATUSES, never has been within this test's reach) a
  // valid status — the real, current enum is Active/Pending/Completed/Cancelled/Requires Review
  // (confirmed directly: PUT with "In Transit" 400s with "status must be one of: ..."). Using
  // "Completed" instead — any value other than the shipment's starting "Active" exercises a
  // real transition.
  it("updates status and returns 200", () => {
    api("GET", `/shipments/${shipmentId}`).then(res => {
      const shipment = res.body;
      return api("PUT", `/shipments/${shipmentId}`, {
        ...shipment,
        status: "Completed",
      });
    }).then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.status).to.eq("Completed");
    });
  });

  it("updated status is persisted on GET", () => {
    api("GET", `/shipments/${shipmentId}`).then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.status).to.eq("Completed");
    });
  });

  it("updates bookingRef field", () => {
    api("GET", `/shipments/${shipmentId}`).then(res => {
      const shipment = res.body;
      return api("PUT", `/shipments/${shipmentId}`, {
        ...shipment,
        bookingRef: "BKG-TEST-001",
      });
    }).then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.bookingRef).to.eq("BKG-TEST-001");
    });
  });

  it("returns 404 for a non-existent id", () => {
    api("PUT", "/shipments/DOESNOTEXIST-999", {
      pol: "CNSHA", pod: "USNYC", carrierCode: "CMDU",
      status: "Active", contractType: "SPOT",
    }).then(res => {
      expect(res.status).to.eq(404);
    });
  });

});

// ─── GET /api/shipments/:id/events (audit log) ───────────────────────────────

describe("GET /api/shipments/:id/events — audit log", () => {

  let shipmentId;

  before(() => {
    // Create shipment then change its status to generate events
    api("POST", "/shipments", {
      pol: "CNSHA", pod: "USNYC",
      carrierCode: "CMDU",
      status: "Active",
      contractType: "SPOT",
      etd: "2026-12-01",
    }).then(res => {
      shipmentId = res.body.id;
      return api("GET", `/shipments/${shipmentId}`);
    }).then(res => {
      return api("PUT", `/shipments/${shipmentId}`, {
        ...res.body,
        status: "Completed",
      });
    });
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  // GET /api/shipments/:id/events was rewritten to the app's global paginated shape
  // ({results, total, limit, offset}) back in v0.29.0 — confirmed directly against the live
  // route, not assumed. Every assertion below reads res.body.results, not a bare res.body.

  it("returns 200 with a results array", () => {
    api("GET", `/shipments/${shipmentId}/events`).then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.results).to.be.an("array");
    });
  });

  it("records a STATUS_CHANGED event after status update", () => {
    api("GET", `/shipments/${shipmentId}/events`).then(res => {
      const statusEvents = res.body.results.filter(e => e.eventType === "STATUS_CHANGED");
      expect(statusEvents.length).to.be.at.least(1);
      const ev = statusEvents[0];
      expect(ev.newValue).to.eq("Completed");
      expect(ev.oldValue).to.eq("Active");
    });
  });

  it("event shape includes required fields", () => {
    api("GET", `/shipments/${shipmentId}/events`).then(res => {
      expect(res.body.results.length).to.be.at.least(1);
      const ev = res.body.results[0];
      expect(ev).to.have.all.keys(
        "id", "shipmentId", "eventType", "field",
        "oldValue", "newValue", "actor", "occurredAt", "meta"
      );
      expect(ev.shipmentId).to.eq(shipmentId);
    });
  });

  it("events are ordered by occurredAt ascending when sort=asc is requested", () => {
    // The default order is newest-first (confirmed directly) — sort=asc is the route's own
    // documented opt-in for ascending order (see CLAUDE.md's "Paginated responses" key pattern),
    // not the default, so request it explicitly rather than assume it.
    api("GET", `/shipments/${shipmentId}/events?sort=asc`).then(res => {
      const dates = res.body.results.map(e => e.occurredAt);
      const sorted = [...dates].sort();
      expect(dates).to.deep.eq(sorted);
    });
  });

  it("returns only the SHIPMENT_CREATED event for a shipment nobody has touched since", () => {
    // Shipment creation itself logs a SHIPMENT_CREATED event (confirmed live) — a fresh,
    // untouched shipment has exactly that one event, never a truly empty array.
    api("POST", "/shipments", {
      pol: "SGSIN", pod: "AEJEA",
      carrierCode: "MSCU",
      status: "Active",
      contractType: "SPOT",
      etd: "2026-12-15",
    }).then(res => {
      const freshId = res.body.id;
      return api("GET", `/shipments/${freshId}/events`).then(evRes => {
        expect(evRes.status).to.eq(200);
        expect(evRes.body.results).to.have.length(1);
        expect(evRes.body.results[0].eventType).to.eq("SHIPMENT_CREATED");
        api("DELETE", `/shipments/${freshId}`);
      });
    });
  });

});

// ─── DELETE /api/shipments/:id ────────────────────────────────────────────────

describe("DELETE /api/shipments/:id", () => {

  it("deletes the shipment and returns 200", () => {
    api("POST", "/shipments", {
      pol: "CNSHA", pod: "USNYC",
      carrierCode: "CMDU",
      status: "Active",
      contractType: "SPOT",
      etd: "2026-12-20",
    }).then(res => {
      const id = res.body.id;
      return api("DELETE", `/shipments/${id}`);
    }).then(res => {
      expect(res.status).to.eq(200);
    });
  });

  it("GET after DELETE returns 404", () => {
    api("POST", "/shipments", {
      pol: "CNSHA", pod: "USNYC",
      carrierCode: "CMDU",
      status: "Active",
      contractType: "SPOT",
      etd: "2026-12-22",
    }).then(res => {
      const id = res.body.id;
      return api("DELETE", `/shipments/${id}`).then(() =>
        api("GET", `/shipments/${id}`)
      );
    }).then(res => {
      expect(res.status).to.eq(404);
    });
  });

  it("returns 404 when deleting a non-existent shipment", () => {
    api("DELETE", "/shipments/DOESNOTEXIST-999").then(res => {
      expect(res.status).to.eq(404);
    });
  });

});
