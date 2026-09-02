/**
 * Pending contract revalidation — Cypress API + UI tests
 *
 * Tests the GET /api/contracts/revalidate endpoint and the
 * PendingRevalidationModal that fires when a Pending shipment has a
 * contractRef matching an Active Central contract.
 *
 * Prerequisites:
 *   - npm run dev  (Vite :5173 + Express :3001)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *
 * Fixtures:
 *   CMDU-CH-EUN-NAM  — Active contract, 1 match (self-provisioned below — a fresh
 *                      environment's `npm run seed` never creates contracts)
 *   NOSUCHCONTRACT   — No match
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";
const CONTRACT_NUMBER = "CMDU-CH-EUN-NAM";

let authToken, contractId;

const api = (method, path, body) =>
  cy.request({
    method,
    url: `/api${path}`,
    headers: { Authorization: `Bearer ${authToken}` },
    failOnStatusCode: false,
    ...(body !== undefined && { body }),
  });

// ─── Auth + fixture contract ────────────────────────────────────────────────────

before(() => {
  cy.request("POST", "/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  }).then(res => {
    expect(res.status).to.eq(200);
    authToken = res.body.token;
  }).then(() => api("POST", "/contracts", {
    contractNumber: CONTRACT_NUMBER, carrierCode: "CMDU", status: "Active",
    validFrom: "2020-01-01", validTo: "2030-01-01",
  })).then(res => {
    expect(res.status).to.eq(201);
    contractId = res.body.id;
  });
});

after(() => {
  if (contractId) api("DELETE", `/contracts/${contractId}`);
});

// ─── GET /api/contracts/revalidate ────────────────────────────────────────────

describe("GET /api/contracts/revalidate", () => {

  it("returns 200 with an array", () => {
    api("GET", "/contracts/revalidate?ref=CMDU-CH-EUN-NAM").then(res => {
      expect(res.status).to.eq(200);
      expect(res.body).to.be.an("array");
    });
  });

  it("returns the matching Active contract when ref is known", () => {
    api("GET", "/contracts/revalidate?ref=CMDU-CH-EUN-NAM").then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.length).to.be.at.least(1);
      const c = res.body[0];
      expect(c.contractNumber).to.eq("CMDU-CH-EUN-NAM");
      expect(c.status).to.eq("Active");
    });
  });

  it("returns [] for an unknown contract number", () => {
    api("GET", "/contracts/revalidate?ref=NOSUCHCONTRACT").then(res => {
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.equal([]);
    });
  });

  it("returns [] when ref is empty", () => {
    api("GET", "/contracts/revalidate?ref=").then(res => {
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.equal([]);
    });
  });

  it("returns [] when ref param is omitted", () => {
    api("GET", "/contracts/revalidate").then(res => {
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.equal([]);
    });
  });

  it("match is case-insensitive (lowercase ref)", () => {
    api("GET", "/contracts/revalidate?ref=cmdu-ch-eun-nam").then(res => {
      expect(res.status).to.eq(200);
      expect(res.body.length).to.be.at.least(1);
      expect(res.body[0].contractNumber).to.eq("CMDU-CH-EUN-NAM");
    });
  });

  it("does not return Inactive contracts", () => {
    // If the matched contract were Inactive it should not appear.
    // We verify every result is Active.
    api("GET", "/contracts/revalidate?ref=CMDU-CH-EUN-NAM").then(res => {
      res.body.forEach(c => expect(c.status).to.eq("Active"));
    });
  });

  it("response shape includes id, contractNumber, carrierCode, status, validFrom, validTo", () => {
    api("GET", "/contracts/revalidate?ref=CMDU-CH-EUN-NAM").then(res => {
      const c = res.body[0];
      expect(c).to.have.all.keys("id", "contractNumber", "contractRef", "carrierCode",
        "namedAccountId", "namedAccount", "movementType", "containerTypes", "commodityTypes",
        "dgAllowed", "imdgClasses", "validFrom", "validTo", "currency", "status",
        "notes", "createdAt");
    });
  });

});

// ─── Pending revalidation — shipment CRUD ────────────────────────────────────

describe("Pending revalidation — shipment upgrade via API", () => {

  let shipmentId;

  before(() => {
    // Create a Pending shipment with a contractRef that matches CMDU-CH-EUN-NAM
    api("POST", "/shipments", {
      pol: "CNSHA", pod: "USNYC",
      carrierCode: "CMDU",
      status: "Active",
      contractType: "Pending",
      contractRef: "CMDU-CH-EUN-NAM",
      etd: "2026-08-01",
    }).then(res => {
      expect(res.status).to.eq(201);
      shipmentId = res.body.id;
    });
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  it("revalidate returns the matching contract for that shipment's contractRef", () => {
    api("GET", `/shipments/${shipmentId}`).then(res => {
      const ref = res.body.contractRef;
      expect(ref).to.eq("CMDU-CH-EUN-NAM");
      return api("GET", `/contracts/revalidate?ref=${ref}`);
    }).then(res => {
      expect(res.body.length).to.be.at.least(1);
      expect(res.body[0].status).to.eq("Active");
    });
  });

  it("upgrading to Central updates contractType, contractId, and contractRef", () => {
    api("GET", "/contracts/revalidate?ref=CMDU-CH-EUN-NAM").then(res => {
      const contract = res.body[0];
      return api("GET", `/shipments/${shipmentId}`).then(sRes => {
        const s = sRes.body;
        return api("PUT", `/shipments/${shipmentId}`, {
          ...s,
          contractType: "Central",
          contractId:   contract.id,
          contractRef:  contract.contractNumber,
        });
      }).then(putRes => {
        expect(putRes.status).to.eq(200);
        expect(putRes.body.contractType).to.eq("Central");
        expect(putRes.body.contractId).to.eq(contract.id);
        expect(putRes.body.contractRef).to.eq(contract.contractNumber);
      });
    });
  });

});
