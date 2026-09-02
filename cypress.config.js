import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    baseUrl: "http://localhost:5173",
    viewportWidth: 1280,
    viewportHeight: 800,
    defaultCommandTimeout: 8000,
    video: false,
    screenshotOnRunFailure: true,
    // login.cy.js and smoke.cy.js run first, on purpose — they exercise the app's own baseline
    // (auth, basic navigation) that every other spec's beforeEach implicitly depends on. Left to
    // Cypress's default alphabetical glob order, whichever spec happens to sort first pays the
    // full cold-start cost of the very first real login/render of the whole run — a confusing
    // place to discover a foundational problem. specPattern as an array is collected
    // pattern-by-pattern in the order listed (each file counted once even if a later pattern
    // would also match it), so this reorders without excluding or duplicating anything.
    specPattern: [
      "cypress/e2e/login.cy.js",
      "cypress/e2e/smoke.cy.js",
      "cypress/e2e/**/*.cy.js",
    ],
    supportFile: "cypress/support/e2e.js",
  },
});
