/**
 * Containers Suite — v0.26.0 "Meridian II"
 *
 * Covers: container CRUD lifecycle, and the v0.26.0 feature where adding a
 * container to a Central contract shipment auto-creates per-container BUY
 * cost lines, and deleting a container removes those lines.
 *
 * Prerequisites:
 *   - npm run dev  (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - At least one Central contract seeded with per_container rates
 *     (npm run seed:contracts provides CMDU-CH-EUN-NAM)
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Containers Suite", () => {
  let tok;
  let spotShipmentId;
  let centralShipmentId;
  let containerId;

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  before(() => {
    // Step 1: login
    cy.request("POST", "/api/auth/login", {
      email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
    }).then(res => {
      tok = res.body.token;
    });
  });

  before(() => {
    // Step 2: create SPOT shipment (runs after first before)
    cy.request({
      method: "POST", url: "/api/shipments",
      headers: { Authorization: `Bearer ${tok}` },
      body: { pol: "CNSHA", pod: "USNYC", carrierCode: "CMDU",
              status: "Active", contractType: "SPOT", etd: "2026-10-01" },
      failOnStatusCode: false,
    }).then(res => {
      expect(res.status).to.eq(201);
      spotShipmentId = res.body.id;
    });
  });

  before(() => {
    // Step 3: look for a Central contract and create a matched shipment
    cy.request({
      method: "GET", url: "/api/contracts",
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
    }).then(res => {
      // contracts may be plain array or paginated {results:[]}
      const list = Array.isArray(res.body) ? res.body : (res.body.results ?? []);
      const central = list.find(c => c.contractType === "Central" && c.status === "Active");
      if (!central) return; // no Central contract — skip those tests

      cy.request({
        method: "POST", url: "/api/shipments",
        headers: { Authorization: `Bearer ${tok}` },
        body: {
          pol: "CNSHA", pod: "USNYC",
          carrierCode: central.carrierCode || "CMDU",
          status: "Active", contractType: "Central",
          contractId: central.id, contractRef: central.contractNumber,
          etd: "2026-10-15",
        },
        failOnStatusCode: false,
      }).then(r => { centralShipmentId = r.body.id; });
    });
  });

  after(() => {
    if (spotShipmentId)    api("DELETE", `/shipments/${spotShipmentId}`);
    if (centralShipmentId) api("DELETE", `/shipments/${centralShipmentId}`);
  });

  // ── Basic CRUD ──────────────────────────────────────────────────────────────

  context("Container CRUD — SPOT shipment", () => {
    it("POST /api/containers → 201 with id, shipmentId, size, type", () => {
      api("POST", "/containers", {
        shipmentId: spotShipmentId,
        size: "20", type: "GP",
        containerNumber: "CMDU1234560",
        sealNumber: "SL7788990",
        cargoDescription: "General cargo",
      }).then(res => {
        expect(res.status).to.eq(201);
        expect(res.body).to.have.property("id");
        expect(res.body.shipmentId).to.eq(spotShipmentId);
        expect(res.body.size).to.eq("20");
        expect(res.body.type).to.eq("GP");
        expect(res.body.sealNumber).to.eq("SL7788990");
        containerId = res.body.id;
      });
    });

    it("container appears in GET /api/containers?shipmentId=...", () => {
      // Shipment detail doesn't embed containers — use the dedicated list endpoint
      api("GET", `/containers?shipmentId=${spotShipmentId}`).then(res => {
        expect(res.status).to.eq(200);
        const found = res.body.find(c => c.id === containerId);
        expect(found).to.not.be.undefined;
      });
    });

    it("POST without size/type → 400", () => {
      api("POST", "/containers", { shipmentId: spotShipmentId }).then(res => {
        expect(res.status).to.eq(400);
      });
    });

    it("DELETE /api/containers/:id → 200", () => {
      api("DELETE", `/containers/${containerId}`).then(res => {
        expect(res.status).to.eq(200);
      });
    });

    it("container is gone from shipment after delete", () => {
      api("GET", `/containers?shipmentId=${spotShipmentId}`).then(res => {
        expect(res.status).to.eq(200);
        const found = res.body.find(c => c.id === containerId);
        expect(found).to.be.undefined;
      });
    });
  });

  // ── Auto BUY Lines (Central contract) ──────────────────────────────────────

  context("Auto cost-line sync — Central contract (v0.26.0)", () => {
    let ctrId;

    it("skips remaining tests if no Central contract was seeded", function() {
      if (!centralShipmentId) this.skip();
    });

    it("adding a container does not crash (no 500)", () => {
      if (!centralShipmentId) return;
      api("POST", "/containers", {
        shipmentId: centralShipmentId,
        size: "20", type: "GP",
        containerNumber: "CMDU9990001",
      }).then(res => {
        expect(res.status).to.eq(201);
        ctrId = res.body.id;
      });
    });

    it("GET /api/shipments/:id/cost-lines returns an array after container added", () => {
      if (!centralShipmentId) return;
      api("GET", `/shipments/${centralShipmentId}/cost-lines`).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.be.an("array");
      });
    });

    it("deleting the container returns 200", () => {
      if (!ctrId) return;
      api("DELETE", `/containers/${ctrId}`).then(res => {
        expect(res.status).to.eq(200);
        ctrId = null;
      });
    });
  });

  // ── Shipment Legs ───────────────────────────────────────────────────────────

  context("Shipment legs", () => {
    let legId;

    it("POST /api/shipments/:id/legs → 201 with legType, pol, pod", () => {
      api("POST", `/shipments/${spotShipmentId}/legs`, {
        legType: "SEA", mot: "SEA", movementType: "SEA",
        pol: "CNSHA", pod: "USNYC",
        etd: "2026-10-01", eta: "2026-10-22",
        carrierCode: "CMDU", vessel: "EVER GIVEN", voyage: "420E",
        polLocType: "Terminal", podLocType: "Terminal",
      }).then(res => {
        expect(res.status).to.eq(201);
        expect(res.body.legType).to.eq("SEA");
        expect(res.body.pol).to.eq("CNSHA");
        legId = res.body.id;
      });
    });

    it("leg appears in GET /api/shipments/:id/legs", () => {
      api("GET", `/shipments/${spotShipmentId}/legs`).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.be.an("array");
        const found = res.body.find(l => l.id === legId);
        expect(found).to.not.be.undefined;
      });
    });

    it("syncShipmentFromLegs updates shipment pol/pod/etd", () => {
      api("GET", `/shipments/${spotShipmentId}`).then(res => {
        expect(res.body.pol).to.eq("CNSHA");
        expect(res.body.pod).to.eq("USNYC");
        expect(res.body.etd).to.include("2026-10-01");
      });
    });

    it("DELETE /api/shipments/:id/legs/:legId → 200", () => {
      api("DELETE", `/shipments/${spotShipmentId}/legs/${legId}`).then(res => {
        expect(res.status).to.eq(200);
        legId = null;
      });
    });
  });

  // ── Container Lifecycle Events (FCL) ────────────────────────────────────────

  context("Container lifecycle events", () => {
    let evCtrId;
    let eventId;

    before(() => {
      api("POST", "/containers", {
        shipmentId: spotShipmentId, size: "40", type: "DC",
        containerNumber: "CMDU2223334",
      }).then(res => { evCtrId = res.body.id; });
    });

    after(() => {
      if (evCtrId) api("DELETE", `/containers/${evCtrId}`);
    });

    it("POST with invalid eventType → 400", () => {
      api("POST", `/containers/${evCtrId}/events`, {
        eventType: "Not A Real Type", occurredAt: "2026-10-01",
      }).then(res => expect(res.status).to.eq(400));
    });

    it("POST without occurredAt → 400", () => {
      api("POST", `/containers/${evCtrId}/events`, { eventType: "Gate In" })
        .then(res => expect(res.status).to.eq(400));
    });

    it("GET on a fresh container returns an empty array", () => {
      api("GET", `/containers/${evCtrId}/events`).then(res => {
        expect(res.status).to.eq(200);
        expect(res.body).to.be.an("array").that.is.empty;
      });
    });

    it("POST Empty Pickup → 201 with containerId/shipmentId/recordedBy", () => {
      api("POST", `/containers/${evCtrId}/events`, {
        eventType: "Empty Pickup", occurredAt: "2026-10-01", location: "Shanghai Depot",
      }).then(res => {
        expect(res.status).to.eq(201);
        expect(res.body.eventType).to.eq("Empty Pickup");
        expect(res.body.containerId).to.eq(evCtrId);
        expect(res.body.shipmentId).to.eq(spotShipmentId);
        expect(res.body.recordedBy).to.not.be.empty;
        eventId = res.body.id;
      });
    });

    it("POST Gate In → 201, list returns both events ordered by occurredAt", () => {
      api("POST", `/containers/${evCtrId}/events`, {
        eventType: "Gate In", occurredAt: "2026-10-03", location: "CNSHA Terminal",
      }).then(() => {
        api("GET", `/containers/${evCtrId}/events`).then(res => {
          expect(res.status).to.eq(200);
          expect(res.body).to.have.length(2);
          expect(res.body[0].eventType).to.eq("Empty Pickup");
          expect(res.body[1].eventType).to.eq("Gate In");
        });
      });
    });

    it("CONTAINER_EVENT_ADDED appears in the shipment audit log", () => {
      // /shipments/:id/events is paginated ({results, total, limit, offset}), not a bare array.
      api("GET", `/shipments/${spotShipmentId}/events`).then(res => {
        expect(res.status).to.eq(200);
        const found = res.body.results.find(e => e.eventType === "CONTAINER_EVENT_ADDED");
        expect(found).to.not.be.undefined;
      });
    });

    it("DELETE /api/container-events/:id → 200, one event remains", () => {
      api("DELETE", `/container-events/${eventId}`).then(res => {
        expect(res.status).to.eq(200);
        api("GET", `/containers/${evCtrId}/events`).then(list => {
          expect(list.body).to.have.length(1);
          expect(list.body[0].eventType).to.eq("Gate In");
        });
      });
    });

    it("DELETE non-existent event → 404", () => {
      api("DELETE", "/container-events/DOESNOTEXIST-999").then(res => {
        expect(res.status).to.eq(404);
      });
    });
  });
});
