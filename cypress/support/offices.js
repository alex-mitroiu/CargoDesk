/**
 * Shared office provisioning for Cypress specs — the UI-suite twin of tests/helpers/offices.mjs.
 *
 * POST /api/shipments hard-requires emoOfficeId + imoOfficeId (TKT-FH5Q94, v0.91.3), and every spec
 * that creates a shipment used to do `res.body.find(o => o.department === "SE" && o.isActive).id`.
 * That only ever worked against a long-lived dev database; a fresh database (every CI run) has no
 * offices, so `.find()` returned undefined and 19 of 26 specs died with "Cannot read properties of
 * undefined (reading 'id')" in their `before` hook.
 *
 * ensureOffices(api) keeps using whatever active office already exists, and only when a
 * department has none does it create a fixed fixture office. Idempotent — the office code is
 * deterministic (country-unlocode-department), so specs share the same rows instead of piling up
 * new ones. The fixture identity (country FX / unlocode FXFIX) is deliberately artificial so it
 * can't collide with offices individual specs create for themselves.
 *
 * `api` is the calling spec's own authenticated wrapper: (method, path, body) => cy.request(...).
 * Yields { emoOfficeId, imoOfficeId, emoOffice, imoOffice }.
 */

const FIXTURE = {
  SE: { unlocode: "FXFIX", countryCode: "FX", department: "SE", name: "Test Fixture Export Office" },
  SI: { unlocode: "FXFIX", countryCode: "FX", department: "SI", name: "Test Fixture Import Office" },
};

const ensureOffice = (api, list, department) => {
  const existing = list.find(o => o.department === department && o.isActive);
  if (existing) return cy.wrap(existing, { log: false });

  return api("POST", "/offices", FIXTURE[department]).then(created => {
    if (created.status === 201) return created.body;

    // The fixture office exists but another spec deactivated it — bring it back rather than
    // failing (its code is fixed, so a second POST can never succeed).
    const dormant = list.find(o => o.code === `FX-FXFIX-${department}`);
    if (!dormant) {
      throw new Error(`ensureOffices: no active ${department} office and could not create one (${created.status}: ${JSON.stringify(created.body)})`);
    }
    return api("PUT", `/offices/${dormant.id}`, { isActive: true }).then(revived => {
      if (revived.status !== 200) {
        throw new Error(`ensureOffices: could not reactivate fixture ${department} office (${revived.status}: ${JSON.stringify(revived.body)})`);
      }
      return { ...dormant, isActive: true };
    });
  });
};

export const ensureOffices = api =>
  api("GET", "/offices").then(res =>
    // Sequential on purpose: two concurrent POSTs could race on the same deterministic code.
    ensureOffice(api, res.body, "SE").then(emoOffice =>
      ensureOffice(api, res.body, "SI").then(imoOffice => ({
        emoOfficeId: emoOffice.id, imoOfficeId: imoOffice.id, emoOffice, imoOffice,
      }))));
