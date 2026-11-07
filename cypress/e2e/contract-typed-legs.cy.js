/**
 * Master Data → Contracts: typed contract legs (the user's pick 2026-11-07, mockup
 * https://claude.ai/code/artifact/ff9c67cb-1556-48b4-a4f8-420c4084e91e option D). The Leg column is a choice,
 * Pick-up / SEA / Delivery: choosing Pick-up moves the leg first and makes its From the places the carrier collects
 * from (several), with the kind of place and the mode; a second Pick-up on the line is refused with what's wrong and
 * the order; Delivery goes last. Saved, the contract comes back typed.
 *
 * Prerequisites:
 *   - npm run dev (Express :3001, Vite :5173)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

const ADMIN_EMAIL    = "claudeagent@localhost";
const ADMIN_PASSWORD = "TestFixture!2026Zq";

describe("Master Data → Contracts: typed legs", () => {
  let tok, contractId;
  const stamp = Date.now();
  const contractNumber = `CY-TYPED-${stamp}`;

  const api = (method, path, body) =>
    cy.request({ method, url: `/api${path}`, headers: { Authorization: `Bearer ${tok}` }, failOnStatusCode: false, ...(body !== undefined && { body }) });

  before(() => {
    cy.request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).then(res => { tok = res.body.token; });
  });
  before(() => {
    // Validity in 2028, clear of real data.
    api("POST", "/contracts", { contractNumber, carrierCode: "HLCU", status: "Active", validFrom: "2028-01-01", validTo: "2028-12-31",
      routings: [{ name: "Door to door" }],
      legs: [{ legType: "SEA", pol: "NLRTM", pod: "USNYC", routingIndex: 0 }],
      rates: [{ serviceCode: "OF", amount: 1100, currency: "USD", unit: "per_container" }] })
      .then(res => { expect(res.status, JSON.stringify(res.body)).to.eq(201); contractId = res.body.id; });
  });
  after(() => { if (contractId) api("DELETE", `/contracts/${contractId}`); });

  beforeEach(() => {
    cy.loginSession(ADMIN_EMAIL, ADMIN_PASSWORD, { acceptLicense: true });
    cy.visit("/");
    cy.dismissStartupGates();
  });

  const pickPort = (input, code) => {
    input.type(code);
    cy.contains("button", new RegExp(`^${code}`), { timeout: 10000 }).trigger("mousedown");
  };
  const row = pos => cy.get(`[data-testid="routing-line-0-leg-${pos}"]`);

  it("sets a Pick-up leg with two places and a mode, refuses a second one, puts a Delivery leg last, and saves typed legs", () => {
    cy.window().then(win => { win.location.hash = "mdm-contracts"; });
    cy.dismissStartupGates();
    cy.get('[data-testid="contracts-search"]', { timeout: 15000 }).type(contractNumber);
    cy.get(`[data-testid="contracts-row-${contractId}"]`, { timeout: 15000 }).find("button").last().click();
    cy.contains("button", "Edit").click();
    // The routing lines sit below the modal's fold: scroll them in (a visibility check doesn't scroll; actions do).
    cy.get('[data-testid="routing-line-0"]', { timeout: 15000 }).should("exist").scrollIntoView();
    row(0).find('[data-testid$="-type"]').should("have.value", "SEA");

    // A new leg is a SEA leg after the existing one; give it NLAMS → NLRTM, then make it the Pick-up leg.
    cy.get('[data-testid="routing-line-0"]').contains("button", "＋ Add leg").click();
    row(1).within(() => { pickPort(cy.get('input[placeholder="From port…"]'), "NLAMS"); });
    row(1).within(() => { pickPort(cy.get('input[placeholder="To port…"]'), "NLRTM"); });
    row(1).find('[data-testid$="-type"]').select("Pick-up");
    // It moved first: its From lists its place, from a Door.
    row(0).find('[data-testid$="-type"]').should("have.value", "Pick-up");
    cy.get('[data-testid="routing-line-0-leg-0-from-place-NLAMS"]').should("exist");
    cy.get('[data-testid="routing-line-0-leg-0-from-loctype"]').contains("button", "Door").should("have.attr", "aria-pressed", "true");
    row(1).find('[data-testid$="-type"]').should("have.value", "SEA");

    // A second place, and the mode.
    row(0).within(() => { pickPort(cy.get('input[placeholder="Add a place…"]'), "DEBER"); });
    cy.get('[data-testid="routing-line-0-leg-0-from-place-DEBER"]').should("exist");
    cy.get('[data-testid="routing-line-0-leg-0-mode"]').select("Truck");
    cy.get('[data-testid="routing-line-chain"]').should("contain", "NLAMS DEBER · Door · Truck");

    // A second Pick-up leg on the line is refused, and nothing changes.
    row(1).find('[data-testid$="-type"]').select("Pick-up");
    cy.get('[data-testid="routing-line-0-refused"]').should("contain", "That change wasn't made").and("contain", "at most one Pick-up leg")
      .and("contain", "The order on a contract line");
    row(1).find('[data-testid$="-type"]').should("have.value", "SEA");
    cy.screenshot("contract-typed-legs-1-refused", { capture: "viewport" });

    // A Delivery leg USNYC → USCHI goes last.
    cy.get('[data-testid="routing-line-0"]').contains("button", "＋ Add leg").click();
    row(2).within(() => { pickPort(cy.get('input[placeholder="From port…"]'), "USNYC"); });
    row(2).within(() => { pickPort(cy.get('input[placeholder="To port…"]'), "USCHI"); });
    row(2).find('[data-testid$="-type"]').select("Delivery");
    row(2).find('[data-testid$="-type"]').should("have.value", "Delivery");
    cy.get('[data-testid="routing-line-0-leg-2-to-place-USCHI"]').should("exist");
    cy.get('[data-testid="routing-line-0-problems"]').should("not.exist");
    cy.get('[data-testid="routing-line-0"]').scrollIntoView();
    cy.screenshot("contract-typed-legs-2-line", { capture: "viewport" });

    cy.contains("button", "Save Changes").click();
    cy.contains("button", "Save Changes").should("not.exist");
    api("GET", `/contracts/${contractId}`).then(res => {
      const legs = res.body.legs.map(l => [l.legType, l.pol, l.pod, l.polHaulageLocations, l.podHaulageLocations, l.movementBy]);
      expect(legs).to.deep.eq([
        ["Pick-up", "NLAMS", "NLRTM", "NLAMS DEBER", "", "Truck"],
        ["SEA", "NLRTM", "USNYC", "", "", ""],
        ["Delivery", "USNYC", "USCHI", "", "USCHI", ""],
      ]);
    });
    // The search finds it for a Truck pick-up from DEBER, not for a Barge one.
    api("GET", `/contracts/match?pol=NLRTM&pod=USNYC&crd=2028-06-01&needsPolHaulage=1&pkuLocation=DEBER&pkuLocType=Door&pkuMode=Truck`)
      .then(res => expect(res.body.some(m => m.id === contractId)).to.eq(true));
    api("GET", `/contracts/match?pol=NLRTM&pod=USNYC&crd=2028-06-01&needsPolHaulage=1&pkuLocation=DEBER&pkuLocType=Door&pkuMode=Barge`)
      .then(res => expect(res.body.some(m => m.id === contractId)).to.eq(false));
  });
});
