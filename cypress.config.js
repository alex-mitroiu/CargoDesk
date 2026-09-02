import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    baseUrl: "http://localhost:5173",
    viewportWidth: 1280,
    viewportHeight: 800,
    defaultCommandTimeout: 8000,
    video: false,
    screenshotOnRunFailure: true,
    // A_login.cy.js / A_smoke.cy.js are named to sort first under Cypress's default alphabetical
    // spec order, on purpose — they exercise the app's own baseline (auth, basic render) every
    // other spec's beforeEach implicitly depends on, so a foundational problem surfaces there
    // first instead of confusingly through whichever spec happens to sort first otherwise. A
    // filename is a far more visible guarantee of this than a hidden specPattern order would be.
    specPattern: "cypress/e2e/**/*.cy.js",
    supportFile: "cypress/support/e2e.js",
  },
});
