/**
 * Document Generation & Signing Suite
 *
 * Covers the "Generate Document" flow on the promoted Documents page (App.jsx's
 * DocumentsModal, standalone mode) — server-side rendered + digitally signed PDF, then
 * the Preview → Confirm flow. Previously zero Cypress coverage of any kind touched
 * document generation. Uses CI01 (Commercial Invoice) rather than FR01/FR02, which
 * require a real SELL cost line precondition unrelated to what this suite is testing.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Document Generation & Signing Suite", () => {
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

  after(() => {
    if (shipmentId) api("DELETE", `/shipments/${shipmentId}`);
  });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.window().then(win => { win.location.hash = `shipments/${shipmentId}/documents`; });
    cy.dismissStartupGates();
    cy.contains("Generate Document", { timeout: 15000 }).should("be.visible");
  });

  it("generates a signed Commercial Invoice PDF via the real UI", () => {
    cy.contains("button", "Generate Document").click();
    cy.contains("h2", "Generate Document", { timeout: 8000 }).should("be.visible");

    // The page also has an unrelated "Document Type" select in its own "Upload External
    // Document" section (App.jsx:1091) — cy.contains() with no scope matches that one
    // first, not the modal's (App.jsx:724), since it's earlier in DOM order. Scope to the
    // modal itself, anchored on its own title.
    cy.contains("h2", "Generate Document").parents('div[style*="z-index: 1000"]').within(() => {
      cy.contains("Document Type").next("select").select("CI01");
    });
    cy.contains("button", "Generate →").click();

    cy.contains("Commercial Invoice saved to Documents", { timeout: 15000 }).should("be.visible");
    cy.contains("h2", "Generate Document").should("not.exist");

    // "Generate →" (handlePreview) opens a preview of the freshly generated doc
    // automatically — close it so the next test starts clean and exercises the list's
    // own Preview button instead of piggybacking on this leftover modal.
    cy.contains("h2", "CI01", { timeout: 8000 }).should("be.visible");
    // The success toast renders top-right, transiently overlapping the modal's own close
    // button in the same corner — force through it rather than waiting out the toast's
    // auto-dismiss timer.
    cy.get("button").contains("×").click({ force: true });
    cy.contains("h2", "CI01").should("not.exist");

    cy.contains("CI01").should("be.visible");
  });

  it("previews the generated document and confirms it", () => {
    cy.contains("button", "Preview", { timeout: 8000 }).first().click();
    cy.contains("CI01", { timeout: 8000 }).should("be.visible");

    cy.contains("button", "Confirm Document").click();
    cy.contains("Confirm Document").should("not.exist");
  });
});
