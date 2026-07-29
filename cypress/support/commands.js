// ─── Custom Cypress Commands ──────────────────────────────────────────────────

/**
 * Clear all CargoDesk auth + license state from localStorage.
 * Call in beforeEach to guarantee a clean slate.
 */
Cypress.Commands.add("clearAuthState", () => {
  cy.clearLocalStorage("cargodesk_token");
  cy.clearLocalStorage("cargodesk_license_accepted");
  cy.clearLocalStorage("cargodesk_active_role");
  cy.clearLocalStorage("cargodesk_active_office");
  cy.clearLocalStorage("cargodesk_active_office_data");
  cy.clearLocalStorage("cargodesk_remember_office");
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
 * Dismiss the License Agreement and/or Select Office startup gates, in whichever order
 * they actually render. Both are independent, same-z-index (9000) fixed overlays — the
 * license modal's state is synchronous (from localStorage), while the office picker's
 * depends on an async api.offices.list() call, so which one paints on top of the other
 * (and thus which one is actually clickable first) is a genuine race, not a fixed order.
 * Loops rather than checking once: dismissing one can reveal the other still underneath,
 * or the async office-picker fetch may not have resolved yet on the first pass.
 * Safe to call any time, including repeatedly after a later in-app navigation — neither
 * gate is guaranteed to stay dismissed across an SPA hash change in this app today.
 */
Cypress.Commands.add("dismissStartupGates", () => {
  const attempt = (triesLeft) => {
    if (triesLeft <= 0) return;
    cy.get("body").then($body => {
      const text = $body.text();
      if (text.includes("Select Office")) {
        cy.contains("button", "Global Access").click();
        cy.wait(200);
        attempt(triesLeft - 1);
      } else if (text.includes("License Agreement")) {
        cy.contains("button", "I Accept").click();
        cy.wait(200);
        attempt(triesLeft - 1);
      }
      // else: neither present — nothing left to do, stop recursing.
    });
  };
  cy.wait(400); // let the license-accepted state paint and the office-list fetch settle
  attempt(5);
});

// Back-compat aliases — same combined dismissal, kept as separate names since existing
// specs call them individually and the effect (both gates end up dismissed) is identical.
Cypress.Commands.add("acceptLicense", () => cy.dismissStartupGates());
Cypress.Commands.add("dismissOfficePicker", () => cy.dismissStartupGates());

/**
 * Full login flow: clear state → visit → fill credentials → dismiss both startup gates.
 * Leaves the user on the app home page ready for further assertions.
 */
Cypress.Commands.add("loginAs", (email = "claudeagent@localhost", password = "TestFixture!2026Zq") => {
  cy.clearAuthState();
  cy.visit("/");
  cy.fillLogin(email, password);
  cy.get('input[type="email"]', { timeout: 10000 }).should("not.exist");
  cy.dismissStartupGates();
});

/**
 * Same end state as loginAs, but the actual POST /api/auth/login only happens once per
 * unique (email, password) — cy.session() snapshots cookies/localStorage after the first
 * real login and restores them on every later call instead of re-submitting the form.
 * Use this in specs whose tests aren't specifically about the login mechanics themselves
 * (e.g. everything downstream of "already logged in") — routes/auth.js's per-IP rate
 * limiter (20 POSTs / 15min, routes/auth.js) has no test-mode bypass, so any spec that
 * does a fresh real login per test can exhaust it well within a single run. Note the
 * cached snapshot never has the license accepted (the setup step stops right after
 * login) — pass acceptLicense:true to also click through the modal once and bake that
 * into the cached state too, for describes that need a returning-user precondition.
 */
Cypress.Commands.add("loginSession", (email = "claudeagent@localhost", password = "TestFixture!2026Zq", { acceptLicense = false } = {}) => {
  cy.session([email, password, acceptLicense], () => {
    cy.clearAuthState();
    cy.visit("/");
    cy.fillLogin(email, password);
    cy.get('input[type="email"]', { timeout: 10000 }).should("not.exist");
    if (acceptLicense) {
      cy.dismissStartupGates();
      // dismissStartupGates() gives up silently after a few tries — cy.session() trusts
      // whatever it snapshots here for every later restore in the run, so a dismissal that
      // quietly failed (the office-picker/license-modal render race) would otherwise bake a
      // stuck "license still showing" state into every test that reuses this cached session.
      // Fail loudly here instead, once, at setup time.
      cy.get('[data-testid="license-modal"]', { timeout: 10000 }).should("not.exist");
    }
  }, { cacheAcrossSpecs: false });
});
