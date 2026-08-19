/**
 * Customs & Regulatory Filing — Gated / Negative Paths Suite (Epic TKT-XW6TQK)
 *
 * Zero prior Cypress coverage existed for this page at all. Covers the prerequisite gate
 * (CustomsFilingGateModal, blocks the page until a Customs Broker party AND a priced cargo
 * line both exist), the per-card "missing broker" create-time block once only one of the two
 * preconditions is met, and the ISF/AMS Import side's Reject -> Reset to Draft -> resubmit
 * lifecycle (a genuinely new filing reference on resubmit, not a reuse of the rejected one) —
 * simulated via the Test Tools Filing Simulator, the only way a Filed submission ever gets a
 * regulatory response in this app (this epic is permanently simulated-only, no real government
 * EDI integration).
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Customs Filing — Negative / Gated Paths Suite", () => {
  let tok;
  const createdShipmentIds = [];
  const createdCustomerIds = [];

  const api = (method, path, body) =>
    cy.request({
      method, url: `/api${path}`,
      headers: { Authorization: `Bearer ${tok}` },
      failOnStatusCode: false,
      ...(body !== undefined && { body }),
    });

  const visitHash = hash => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.window().then(win => { win.location.hash = hash; });
    cy.contains("Connecting to database", { timeout: 60000 }).should("not.exist");
    cy.dismissStartupGates();
  };

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .then(res => { tok = res.body.token; });
  });

  after(() => {
    createdShipmentIds.forEach(id => api("DELETE", `/shipments/${id}`));
    createdCustomerIds.forEach(id => api("DELETE", `/customers/${id}`));
  });

  describe("Gate modal — no broker and no priced cargo yet", () => {
    let shipmentId;

    before(() => {
      cy.then(() => api("POST", "/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      })).then(res => {
        expect(res.status).to.eq(201);
        shipmentId = res.body.id;
        createdShipmentIds.push(shipmentId);
      });
    });

    it("blocks the whole page and offers both Parties and Cargo escape routes", () => {
      visitHash(`shipments/${shipmentId}/customs-filing/details`);

      cy.contains("h2", "Customs Filing Unavailable", { timeout: 20000 }).should("be.visible");
      // CustomsFilingGateModal renders a point-by-point checklist (not one combined sentence,
      // per its own header comment) — both items show a "Missing" badge when nothing is set yet.
      cy.contains("Customs Broker assigned").parent().parent().should("contain.text", "Missing");
      cy.contains("At least one priced cargo line").parent().parent().should("contain.text", "Missing");
      // Modal.jsx: the × close button, when rendered, is a sibling of <h2> inside their shared
      // header div — scope from .parent() (not .siblings(), which .find() can never match
      // against since it only searches descendants, never the sibling elements themselves).
      cy.contains("h2", "Customs Filing Unavailable").parent().find("button").should("not.exist");

      cy.contains("button", "Go to Parties").should("be.visible");
      cy.contains("button", "Go to Cargo").should("be.visible").click();
      cy.location("hash", { timeout: 10000 }).should("include", "/containers");
      cy.contains("h2", "Customs Filing Unavailable").should("not.exist");
    });
  });

  describe("Broker assigned but no priced cargo yet — still gated", () => {
    let shipmentId, customerId;

    before(() => {
      cy.then(() => api("POST", "/customers", { companyName: "Cypress Test Broker Co" }))
        .then(res => { expect(res.status).to.eq(201); customerId = res.body.id; createdCustomerIds.push(customerId); })
        .then(() => api("POST", "/shipments", {
          pol: "DEHAM", pod: "SGSIN", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
        }))
        .then(res => {
          expect(res.status).to.eq(201);
          shipmentId = res.body.id;
          createdShipmentIds.push(shipmentId);
          return api("POST", `/shipments/${shipmentId}/parties`,
            { role: "Customs Broker (Export)", customerId, customerName: "Cypress Test Broker Co" });
        })
        .then(res => expect(res.status).to.eq(201));
    });

    it("gate message narrows to just the missing cargo precondition", () => {
      visitHash(`shipments/${shipmentId}/customs-filing/details`);
      cy.contains("h2", "Customs Filing Unavailable", { timeout: 20000 }).should("be.visible");
      cy.contains("Customs Broker assigned").parent().parent().should("contain.text", "Set");
      cy.contains("At least one priced cargo line").parent().parent().should("contain.text", "Missing");
      cy.contains("Go to Parties").should("not.exist"); // broker side is already satisfied
      cy.contains("button", "Go to Cargo").should("be.visible");
    });
  });

  describe("Cargo priced but no Import broker — ISF/AMS card stays create-blocked", () => {
    let shipmentId, customerId, containerId;

    before(() => {
      cy.then(() => api("POST", "/customers", { companyName: "Cypress Export Broker Co" }))
        .then(res => { customerId = res.body.id; createdCustomerIds.push(customerId); })
        .then(() => api("POST", "/shipments", {
          pol: "CNSHA", pod: "USLAX", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
        }))
        .then(res => {
          shipmentId = res.body.id;
          createdShipmentIds.push(shipmentId);
          return api("POST", `/shipments/${shipmentId}/parties`,
            { role: "Customs Broker (Export)", customerId, customerName: "Cypress Export Broker Co" });
        })
        .then(() => api("POST", "/containers", { shipmentId, size: "40", type: "HC" }))
        .then(res => {
          containerId = res.body.id;
          return api("POST", `/containers/${containerId}/packages`,
            { description: "Cypress cargo", quantity: 1, unitValue: 5000, currency: "USD" });
        })
        .then(res => expect(res.status).to.eq(201));
    });

    it("page unlocks (broker+cargo satisfied overall), but ISF/AMS Create Filing stays disabled with a hint", () => {
      visitHash(`shipments/${shipmentId}/customs-filing/details`);
      cy.contains("h2", "Customs Filing Unavailable").should("not.exist");

      cy.get("#shpfiling-ISF_AMS-card", { timeout: 15000 }).within(() => {
        cy.get("#shpfiling-ISF_AMS-create-btn").should("be.disabled");
        cy.contains("Assign a Customs Broker (Import) to enable this").should("be.visible");
      });
      // Export side has its broker — Create Filing is enabled there.
      cy.get("#shpfiling-AES_EEI-card").within(() => {
        cy.get("#shpfiling-AES_EEI-create-btn").should("not.be.disabled");
      });
    });
  });

  describe("ISF/AMS full negative lifecycle: Reject -> Reset to Draft -> resubmit gets a new reference", () => {
    let shipmentId, customerId, containerId, filingId;

    before(() => {
      cy.then(() => api("POST", "/customers", { companyName: "Cypress Import Broker Co" }))
        .then(res => { customerId = res.body.id; createdCustomerIds.push(customerId); })
        .then(() => api("POST", "/shipments", {
          pol: "SGSIN", pod: "USLAX", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
        }))
        .then(res => {
          shipmentId = res.body.id;
          createdShipmentIds.push(shipmentId);
          return api("POST", `/shipments/${shipmentId}/parties`,
            { role: "Customs Broker (Import)", customerId, customerName: "Cypress Import Broker Co" });
        })
        .then(() => api("POST", "/containers", { shipmentId, size: "40", type: "HC" }))
        .then(res => {
          containerId = res.body.id;
          return api("POST", `/containers/${containerId}/packages`,
            { description: "Cypress import cargo", quantity: 2, unitValue: 750, currency: "USD" });
        })
        .then(() => api("POST", `/shipments/${shipmentId}/customs-filings`, { filingType: "ISF_AMS" }))
        .then(res => { expect(res.status).to.eq(201); filingId = res.body.id; });
    });

    it("submits the Draft filing (Draft -> Filed)", () => {
      visitHash(`shipments/${shipmentId}/customs-filing/details`);
      cy.get("#shpfiling-ISF_AMS-card", { timeout: 15000 }).within(() => {
        cy.get("#shpfiling-ISF_AMS-submit-btn").should("be.visible").click();
      });
      cy.contains("Filing submitted", { timeout: 10000 }).should("be.visible");
      cy.get("#shpfiling-ISF_AMS-card").contains("Filed", { timeout: 10000 }).should("be.visible");
    });

    it("no Reset action is offered while still Filed (not yet Rejected)", () => {
      visitHash(`shipments/${shipmentId}/customs-filing/review`);
      cy.get(`#shpfilingreview-ISF_AMS-reset-btn`).should("not.exist");
    });

    let firstReference;

    it("simulates a Rejected regulatory response via the Test Tools Filing Simulator", () => {
      visitHash("test-tools");
      cy.contains("button", "Filing Simulator", { timeout: 20000 }).click();
      cy.contains("Simulate a regulatory response", { timeout: 10000 }).should("be.visible");
      cy.contains("button", shipmentId, { timeout: 10000 }).click();
      cy.contains("Simulate Regulatory Response", { timeout: 8000 }).should("be.visible");
      cy.get('input[placeholder="Data did not pass regulatory validation…"]').type("Cypress regression: missing manifest data");
      cy.contains("button", "Simulate Rejected").click();
      cy.contains("Simulated rejected response", { timeout: 10000 }).should("be.visible");

      cy.then(() => api("GET", `/shipments/${shipmentId}/customs-filings`)).then(res => {
        const filing = res.body.find(f => f.id === filingId);
        expect(filing.status).to.eq("Rejected");
        expect(filing.rejectionReason).to.eq("Cypress regression: missing manifest data");
        firstReference = filing.filingReference;
      });
    });

    it("Review tab shows the rejection reason and offers Reset to Draft", () => {
      visitHash(`shipments/${shipmentId}/customs-filing/review`);
      cy.get("#shpfilingreview-ISF_AMS-card", { timeout: 15000 }).within(() => {
        cy.contains("Rejected").should("be.visible");
        cy.contains("Cypress regression: missing manifest data").should("be.visible");
        cy.get("#shpfilingreview-ISF_AMS-reset-btn").should("be.visible").click();
      });
      cy.contains("Filing reset to Draft", { timeout: 10000 }).should("be.visible");
      cy.get("#shpfilingreview-ISF_AMS-card").contains("Draft", { timeout: 10000 }).should("be.visible");
      cy.get("#shpfilingreview-ISF_AMS-reset-btn").should("not.exist");
    });

    it("resubmitting after reset produces a genuinely new filing reference, not the rejected one", () => {
      visitHash(`shipments/${shipmentId}/customs-filing/details`);
      cy.get("#shpfiling-ISF_AMS-card", { timeout: 15000 }).within(() => {
        cy.contains("Draft").should("be.visible");
        cy.get("#shpfiling-ISF_AMS-submit-btn").should("be.visible").click();
      });
      cy.contains("Filing submitted", { timeout: 10000 }).should("be.visible");

      cy.then(() => api("GET", `/shipments/${shipmentId}/customs-filings`)).then(res => {
        const filing = res.body.find(f => f.id === filingId);
        expect(filing.status).to.eq("Filed");
        expect(filing.filingReference).to.not.eq(firstReference);
        expect(filing.rejectionReason == null || filing.rejectionReason === "").to.be.true;
      });
    });
  });
});
