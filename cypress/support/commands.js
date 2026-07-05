// ─── Custom Cypress Commands ──────────────────────────────────────────────────

/**
 * Clear all CargoDesk auth + license state from localStorage.
 * Call in beforeEach to guarantee a clean slate.
 */
Cypress.Commands.add("clearAuthState", () => {
  cy.clearLocalStorage("cargodesk_token");
  cy.clearLocalStorage("cargodesk_license_accepted");
  cy.clearLocalStorage("cargodesk_active_role");
});

/**
 * Fill and submit the login form.
 * Does not handle the license agreement — call cy.acceptLicense() after if needed.
 */
Cypress.Commands.add("fillLogin", (email, password) => {
  cy.get('input[type="email"]').clear().type(email);
  cy.get('input[type="password"]').clear().type(password);
  cy.get('button[type="submit"]').click();
});

/**
 * Accept the license agreement modal if it is showing.
 * Safe to call even if the modal is not present (it will simply pass).
 */
Cypress.Commands.add("acceptLicense", () => {
  // Wait for the login form to disappear (confirms the API call finished and React re-rendered)
  // before snapshotting the body to check for the license modal.
  cy.get('input[type="email"]', { timeout: 10000 }).should("not.exist");
  cy.get("body").then($body => {
    if ($body.text().includes("License Agreement")) {
      cy.contains("button", "I Accept").click();
      cy.contains("License Agreement").should("not.exist");
    }
  });
});

/**
 * Full login flow: clear state → visit → fill credentials → accept license.
 * Leaves the user on the app home page ready for further assertions.
 */
Cypress.Commands.add("loginAs", (email = "claudeagent@localhost", password = "admin") => {
  cy.clearAuthState();
  cy.visit("/");
  cy.fillLogin(email, password);
  cy.acceptLicense();
});
