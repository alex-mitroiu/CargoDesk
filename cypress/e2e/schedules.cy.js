/**
 * v0.27.0 — Shipment Schedules + Related Tickets + ETA recalc hint (Cypress)
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

// ─── Shipment Schedules — REST ────────────────────────────────────────────────

describe("Shipment Schedules API", () => {
  let shipmentId;
  let scheduleId;

  before(() => {
    api("POST", "/shipments", {
      pol: "CNSHA", pod: "NLRTM", carrierCode: "MAEU",
      status: "Active", contractType: "SPOT", etd: "2026-09-10",
    }).then(res => {
      expect(res.status).to.eq(201);
      shipmentId = res.body.id;
    });
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  it("GET /schedules is initially empty", () => {
    api("GET", `/shipments/${shipmentId}/schedules`).then(res => {
      expect(res.status).to.eq(200);
      expect(res.body).to.be.an("array").with.length(0);
    });
  });

  it("POST saves a sailing and returns 201 with full payload", () => {
    api("POST", `/shipments/${shipmentId}/schedules`, {
      carrier: "MAEU",
      vesselName: "MAERSK HAMBURG",
      voyageNumber: "415W",
      service: "AE-5/Shogun",
      pol: "CNSHA", pod: "NLRTM",
      etd: "2026-09-10", eta: "2026-09-28",
      transitDays: 18, isMock: true,
    }).then(res => {
      expect(res.status).to.eq(201);
      expect(res.body).to.have.property("id");
      expect(res.body.vesselName).to.eq("MAERSK HAMBURG");
      expect(res.body.transitDays).to.eq(18);
      expect(res.body.isMock).to.eq(true);
      expect(res.body.savedBy).to.be.a("string").and.not.be.empty;
      scheduleId = res.body.id;
    });
  });

  it("GET returns the saved sailing", () => {
    api("GET", `/shipments/${shipmentId}/schedules`).then(res => {
      expect(res.status).to.eq(200);
      expect(res.body).to.have.length(1);
      expect(res.body[0].id).to.eq(scheduleId);
    });
  });

  it("DELETE removes the sailing", () => {
    api("DELETE", `/shipments/${shipmentId}/schedules/${scheduleId}`).then(res => {
      expect(res.status).to.eq(200);
    });
    api("GET", `/shipments/${shipmentId}/schedules`).then(res => {
      expect(res.body).to.have.length(0);
    });
  });
});

// ─── Schedules Search (mock) ──────────────────────────────────────────────────

describe("GET /api/schedules/search (mock fallback)", () => {
  it("returns sailings array with required fields", () => {
    api("GET", "/schedules/search?pol=CNSHA&pod=DEHAM&carrierCode=MAEU&weeks=2").then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.sailings).to.be.an("array").with.length.greaterThan(0);
      const first = res.body.sailings[0];
      expect(first).to.have.property("vesselName");
      expect(first).to.have.property("etd");
      expect(first).to.have.property("transitDays");
      expect(res.body).to.have.property("isMock");
    });
  });
});

// ─── Tickets filter by shipmentId ─────────────────────────────────────────────

describe("GET /api/tickets?shipmentId=", () => {
  let shipmentId;
  let ticketId;

  before(() => {
    api("POST", "/shipments", {
      pol: "DEHAM", pod: "SGSIN", carrierCode: "CMDU",
      status: "Active", contractType: "SPOT", etd: "2026-10-15",
    }).then(res => { shipmentId = res.body.id; });
  });

  after(() => {
    if (ticketId)    api("DELETE", `/tickets/${ticketId}`);
    if (shipmentId)  api("DELETE", `/shipments/${shipmentId}`);
  });

  it("creates a ticket linked to shipment", () => {
    api("POST", "/tickets", {
      title: "Cypress linked ticket",
      type: "Task", priority: "Low", status: "Ready",
      shipmentId,
    }).then(res => {
      expect(res.status).to.eq(201);
      ticketId = res.body.id;
    });
  });

  it("filter returns only linked ticket", () => {
    api("GET", `/tickets?shipmentId=${shipmentId}`).then(res => {
      expect(res.status).to.eq(200);
      expect(res.body).to.have.length(1);
      expect(res.body[0].shipmentId).to.eq(shipmentId);
    });
  });

  it("unknown shipmentId returns empty array", () => {
    api("GET", "/tickets?shipmentId=SHP-DOESNOTEXIST").then(res => {
      expect(res.status).to.eq(200);
      expect(res.body).to.be.an("array").with.length(0);
    });
  });
});

// ─── Trade lane transit days seeded ──────────────────────────────────────────

describe("Trade lane transit days", () => {
  it("all lanes have non-zero transit days after seed", () => {
    api("GET", "/trade-lanes").then(res => {
      expect(res.status).to.eq(200);
      const zeroes = res.body.filter(l => !l.transitDays);
      expect(zeroes, `Lanes with 0 transit days: ${zeroes.map(l => l.code).join(", ")}`).to.have.length(0);
    });
  });

  it("FE = 28 days", () => {
    api("GET", "/trade-lanes").then(res => {
      const fe = res.body.find(l => l.code === "FE");
      expect(fe?.transitDays).to.eq(28);
    });
  });

  it("NAM = 21 days", () => {
    api("GET", "/trade-lanes").then(res => {
      const nam = res.body.find(l => l.code === "NAM");
      expect(nam?.transitDays).to.eq(21);
    });
  });
});

// ─── Health version ───────────────────────────────────────────────────────────

describe("GET /api/health", () => {
  it("version is not hardcoded 0.22.0", () => {
    api("GET", "/health").then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.version).to.not.eq("0.22.0");
      expect(res.body.version).to.match(/^\d+\.\d+\.\d+$/);
      expect(res.body.status).to.eq("ok");
    });
  });
});
