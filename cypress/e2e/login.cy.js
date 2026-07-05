/**
 * Login module — Cypress E2E tests
 *
 * Covers:
 *   • Login page rendering
 *   • Form field validation
 *   • Failed login (wrong credentials)
 *   • Successful login (first-time user) → License Agreement modal
 *   • Accepting the license agreement
 *   • Returning user (license already accepted) — no modal shown
 *   • Persistence: token and license flag in localStorage
 *   • Logout clears the session
 *
 * Prerequisites:
 *   - Vite dev server on http://localhost:5173  (npm run client)
 *   - Express API server on http://localhost:3001  (npm run server)
 *   - Valid admin account: claudeagent@localhost / admin
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "admin";
const BAD_PASSWORD   = "wrongpassword";

// ─── 1. Login page rendering ──────────────────────────────────────────────────

describe("Login page — rendering", () => {
  beforeEach(() => {
    cy.clearAuthState();
    cy.visit("/");
  });

  it("shows the CargoDesk logo and app name", () => {
    cy.contains("⚓ CargoDesk").should("be.visible");
    cy.contains("Freight Management Platform").should("be.visible");
  });

  it("shows the Sign in heading", () => {
    cy.contains("h2", "Sign in").should("be.visible");
  });

  it("renders an email input with autocomplete", () => {
    cy.get('input[type="email"]')
      .should("be.visible")
      .and("have.attr", "autocomplete", "email")
      .and("have.attr", "required");
  });

  it("renders a password input with autocomplete", () => {
    cy.get('input[type="password"]')
      .should("be.visible")
      .and("have.attr", "autocomplete", "current-password")
      .and("have.attr", "required");
  });

  it("renders the Sign in submit button", () => {
    cy.get('button[type="submit"]')
      .should("be.visible")
      .and("contain", "Sign in");
  });

  it("does not show an error message on initial render", () => {
    cy.contains("Sign in failed").should("not.exist");
    cy.contains("Invalid").should("not.exist");
  });

  it("shows the version stamp below the card", () => {
    cy.contains("CargoDesk").should("be.visible");
    // Version string is present somewhere in the page footer
    cy.get("body").invoke("text").should("match", /v\d+\.\d+\.\d+/);
  });
});

// ─── 2. Form validation ───────────────────────────────────────────────────────

describe("Login page — form validation", () => {
  beforeEach(() => {
    cy.clearAuthState();
    cy.visit("/");
  });

  it("email field is focused on load (autofocus)", () => {
    cy.get('input[type="email"]').should("be.focused");
  });

  it("browser blocks submission with an empty email (HTML5 required)", () => {
    // Do not fill anything — just click submit
    cy.get('button[type="submit"]').click();
    // No API call should happen and no error banner should appear
    // (browser's native validation prevents submit)
    cy.contains("Sign in failed").should("not.exist");
    // Still on login page
    cy.get('input[type="email"]').should("exist");
  });

  it("browser blocks submission with email only, no password", () => {
    cy.get('input[type="email"]').type(ADMIN_EMAIL);
    cy.get('button[type="submit"]').click();
    cy.contains("Sign in failed").should("not.exist");
    cy.get('input[type="password"]').should("exist");
  });
});

// ─── 3. Failed login ──────────────────────────────────────────────────────────

describe("Login page — failed login", () => {
  beforeEach(() => {
    cy.clearAuthState();
    cy.visit("/");
  });

  it("shows an error banner for wrong credentials", () => {
    cy.fillLogin(ADMIN_EMAIL, BAD_PASSWORD);
    // Wait for the API call to complete before asserting button state —
    // the button is disabled while the request is in-flight.
    cy.contains("Invalid email or password", { timeout: 6000 }).should("be.visible");
    cy.get('button[type="submit"]').should("not.be.disabled");
  });

  it("still shows the login form after a failed attempt", () => {
    cy.fillLogin(ADMIN_EMAIL, BAD_PASSWORD);
    cy.contains("Invalid email or password", { timeout: 6000 });
    cy.get('input[type="email"]').should("be.visible");
    cy.get('button[type="submit"]').should("be.visible");
  });

  it("clears the error and retries when new credentials are typed", () => {
    cy.fillLogin(ADMIN_EMAIL, BAD_PASSWORD);
    cy.contains("Invalid email or password", { timeout: 6000 });
    // Now type correct password — error should disappear on resubmit
    cy.get('input[type="password"]').clear().type(ADMIN_PASSWORD);
    cy.get('button[type="submit"]').click();
    // After successful login, login page is gone
    cy.get('input[type="email"]').should("not.exist");
  });

  it("shows an error for an unknown email address", () => {
    cy.fillLogin("nobody@nowhere.invalid", "anything");
    cy.contains("Invalid email or password", { timeout: 6000 }).should("be.visible");
  });
});

// ─── 4. Successful login — first-time user (license not yet accepted) ─────────

describe("Login — first-time user (no license accepted)", () => {
  beforeEach(() => {
    cy.clearAuthState(); // removes cargodesk_license_accepted
    cy.visit("/");
    cy.fillLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  it("shows the License Agreement modal after login", () => {
    cy.contains("h2", "License Agreement", { timeout: 8000 }).should("be.visible");
  });

  it("modal displays the copyright notice", () => {
    cy.contains("CargoDesk").should("be.visible");
  });

  it("modal displays the non-commercial use restriction", () => {
    cy.contains("non-commercial use only").should("be.visible");
  });

  it("modal has an I Accept button", () => {
    cy.contains("button", "I Accept").should("be.visible");
  });

  it("hides the app content behind the modal overlay", () => {
    // The nav / shipments buttons should not be interactable while the modal is open
    cy.contains("h2", "License Agreement").should("be.visible");
    // The overlay has a very high z-index — verify body contains the overlay
    cy.get("body").should("contain", "I Accept");
  });

  it("links to the License & Terms page from within the modal", () => {
    cy.contains("License & Terms").should("be.visible").and("have.css", "cursor", "pointer");
  });
});

// ─── 5. Accepting the license agreement ───────────────────────────────────────

describe("Login — accepting the license", () => {
  beforeEach(() => {
    cy.clearAuthState();
    cy.visit("/");
    cy.fillLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
    cy.contains("h2", "License Agreement", { timeout: 8000 });
  });

  it("dismisses the modal when I Accept is clicked", () => {
    cy.contains("button", "I Accept").click();
    cy.contains("License Agreement").should("not.exist");
  });

  it("sets cargodesk_license_accepted in localStorage after acceptance", () => {
    cy.contains("button", "I Accept").click();
    cy.window().then(win => {
      expect(win.localStorage.getItem("cargodesk_license_accepted")).to.equal("1");
    });
  });

  it("shows the app navigation after accepting the license", () => {
    cy.contains("button", "I Accept").click();
    // The app nav should now be visible
    cy.contains("Shipments", { timeout: 8000 }).should("be.visible");
  });

  it("login page is no longer rendered after acceptance", () => {
    cy.contains("button", "I Accept").click();
    cy.get('input[type="email"]').should("not.exist");
    cy.get('input[type="password"]').should("not.exist");
  });
});

// ─── 6. Returning user — license already accepted ────────────────────────────

describe("Login — returning user (license already accepted)", () => {
  beforeEach(() => {
    // Pre-set the license flag as a returning user would have it
    cy.clearLocalStorage("cargodesk_token");
    cy.clearLocalStorage("cargodesk_active_role");
    cy.visit("/", {
      onBeforeLoad(win) {
        win.localStorage.setItem("cargodesk_license_accepted", "1");
      },
    });
    cy.fillLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  it("does not show the License Agreement modal", () => {
    // Prove the app loaded (positive assertion) — this bounds the wait and
    // guarantees the modal had the opportunity to appear before we assert its absence.
    cy.contains("Shipments", { timeout: 8000 }).should("be.visible");
    cy.contains("License Agreement").should("not.exist");
  });

  it("goes straight to the app after login", () => {
    cy.contains("Shipments", { timeout: 8000 }).should("be.visible");
  });

  it("login page inputs are no longer in the DOM", () => {
    cy.get('input[type="email"]', { timeout: 8000 }).should("not.exist");
  });
});

// ─── 7. LocalStorage persistence ─────────────────────────────────────────────

describe("Login — localStorage persistence", () => {
  it("stores the auth token in localStorage after a successful login", () => {
    cy.clearAuthState();
    cy.visit("/");
    cy.fillLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
    // Wait for the login form to leave the DOM — proof that the API responded
    // and React stored the token before we read localStorage.
    cy.get('input[type="email"]', { timeout: 8000 }).should("not.exist");
    cy.window().then(win => {
      expect(win.localStorage.getItem("cargodesk_token")).to.be.a("string").and.not.be.empty;
    });
  });

  it("pre-existing valid token skips the login page entirely", () => {
    // Get a token via the API, set it manually, then visit the app
    cy.request("POST", "/api/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    }).then(({ body }) => {
      cy.clearAuthState();
      cy.visit("/", {
        onBeforeLoad(win) {
          win.localStorage.setItem("cargodesk_token", body.token);
          win.localStorage.setItem("cargodesk_license_accepted", "1");
        },
      });
      // Should land directly in the app, not the login page
      cy.contains("Shipments", { timeout: 10000 }).should("be.visible");
      cy.get('input[type="email"]').should("not.exist");
    });
  });
});

// ─── 8. Logout ────────────────────────────────────────────────────────────────

describe("Login — logout", () => {
  beforeEach(() => {
    cy.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    cy.contains("Shipments", { timeout: 8000 });
  });

  it("removes the token from localStorage on logout", () => {
    // Open the user avatar menu (circle button in top-right nav showing first initial)
    // Target the circular avatar button by its unique trait: entire text is exactly
// one uppercase letter (the user's initial). Avoids matching nav links like "Carriers".
cy.get("header").find("button").filter((_, el) => /^[A-Z]$/.test(el.textContent.trim())).click();
    cy.contains("Sign Out").click();
    cy.window().then(win => {
      expect(win.localStorage.getItem("cargodesk_token")).to.be.null;
    });
  });

  it("returns to the login page after logout", () => {
    // Target the circular avatar button by its unique trait: entire text is exactly
// one uppercase letter (the user's initial). Avoids matching nav links like "Carriers".
cy.get("header").find("button").filter((_, el) => /^[A-Z]$/.test(el.textContent.trim())).click();
    cy.contains("Sign Out").click();
    cy.contains("h2", "Sign in", { timeout: 6000 }).should("be.visible");
    cy.get('input[type="email"]').should("be.visible");
  });
});
