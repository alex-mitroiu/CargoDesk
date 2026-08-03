/**
 * Invoice Entry + Invoice Reversal Suite (TKT-DUADU3, v0.53.0 "Voucher")
 *
 * Zero prior Cypress coverage existed for the Accounting section at all — Cost Entry, Invoice
 * Entry, and the Reverse/Credit-Debit-Note workflow were only verified by the Vitest suite
 * (tests/invoice-reversal.test.js) and a one-off manual CDP pass. This is the first real-UI
 * regression protection for any of it.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Invoice Entry + Reversal Suite", () => {
  let tok, shipmentId;

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
    cy.then(() => api("POST", "/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    })).then(res => {
      expect(res.status).to.eq(201);
      shipmentId = res.body.id;
    });
  });

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  const visitInvoiceEntry = () => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/accounting/invoices`; });
    cy.contains("Connecting to database", { timeout: 60000 }).should("not.exist");
    cy.dismissStartupGates();
    cy.get("#shpacct-invoices-page", { timeout: 20000 }).should("be.visible");
  };

  describe("Negative / validation scenarios (run first, before any lines exist)", () => {
    beforeEach(visitInvoiceEntry);

    it("Add Line is disabled with no amount entered", () => {
      cy.get("#shpacct-invoices-add-btn").click();
      cy.contains("h2", "Add Invoice Line", { timeout: 8000 }).should("be.visible")
        .parent().parent().within(() => {
          // "Add Line" is a substring of the page's own "＋ Add Line" trigger button too —
          // scope to the modal's own content box so we grab the submit button, not the trigger.
          cy.contains("button", "Add Line").should("be.disabled");
          cy.contains("button", "Cancel").click();
        });
    });

    it("Generate Invoice is disabled while there are zero charge lines", () => {
      cy.get("#shpacct-invoices-lines-empty", { timeout: 10000 }).should("be.visible");
      cy.get("#shpacct-invoices-generate-btn").should("be.disabled");
      cy.get("#shpacct-invoices-generate-percontainer-btn").should("be.disabled");
    });
  });

  describe("Happy path: add a line, generate, confirm, then reverse", () => {
    it("adds a SELL charge line", () => {
      visitInvoiceEntry();
      cy.get("#shpacct-invoices-add-btn").click();
      cy.contains("h2", "Add Invoice Line", { timeout: 8000 }).should("be.visible")
        .parent().parent().within(() => {
          cy.contains("div", "Amount").next("input").type("1250");
          cy.contains("button", "Add Line").should("not.be.disabled").click();
        });
      cy.contains("Invoice line added", { timeout: 10000 }).should("be.visible");
      cy.get("#shpacct-invoices-total-sell", { timeout: 10000 }).should("contain.text", "1,250.00");
    });

    it("generates a consolidated invoice from that line", () => {
      visitInvoiceEntry();
      cy.get("#shpacct-invoices-generate-btn", { timeout: 10000 }).should("not.be.disabled").click();
      cy.contains(/1 invoice generated/, { timeout: 15000 }).should("be.visible");
      cy.get("#shpacct-invoices-docs-table", { timeout: 10000 }).should("be.visible");
      cy.contains("FR01").should("be.visible");
      cy.contains("Draft").should("be.visible");
    });

    it("no Reverse action is offered on a still-draft invoice", () => {
      visitInvoiceEntry();
      cy.get("#shpacct-invoices-docs-table", { timeout: 10000 }).should("be.visible");
      cy.contains("button", "↩ Reverse").should("not.exist");
    });

    it("confirms the invoice via Preview → Confirm Document", () => {
      visitInvoiceEntry();
      cy.contains("button", "Preview Invoice", { timeout: 10000 }).click();
      cy.contains("button", "Confirm Document", { timeout: 8000 }).click();
      cy.contains("Invoice confirmed", { timeout: 10000 }).should("be.visible");
      cy.get("button").contains("×").click({ force: true });
      cy.contains("Confirmed", { timeout: 10000 }).should("be.visible");
    });

    it("reverses the confirmed invoice and shows the voided original + new CN01 credit note", () => {
      visitInvoiceEntry();
      cy.contains("button", "↩ Reverse", { timeout: 10000 }).should("be.visible").click();
      cy.contains("h2", "Reverse Invoice", { timeout: 8000 }).should("be.visible");
      cy.get("textarea").first().type("Cypress regression: duplicate charge");
      cy.contains("button", "Reverse Invoice").click();
      cy.contains("Invoice reversed", { timeout: 20000 }).should("be.visible");

      // Original invoice: struck-through + Voided pill, no more Reverse action.
      cy.contains("Voided", { timeout: 10000 }).should("be.visible");
      cy.contains("button", "↩ Reverse").should("not.exist");

      // New CN01 credit note, linked back to the original.
      cy.contains("CN01", { timeout: 10000 }).should("be.visible");
      cy.contains("Reverses FR01-", { timeout: 10000 }).should("be.visible");

      // Negative-amount Reversal-tagged posted cost line in the Invoice Lines table.
      cy.contains("Reversal", { timeout: 10000 }).should("be.visible");
      cy.contains("-1,250.00", { timeout: 10000 }).should("be.visible");
      cy.get("#shpacct-invoices-total-sell").should("contain.text", "0.00");
    });

    it("reversing again is not offered — the CN01 row has no Reverse action either", () => {
      visitInvoiceEntry();
      cy.contains("button", "↩ Reverse").should("not.exist");
    });
  });
});
