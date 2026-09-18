/**
 * Shared office provisioning for backend tests.
 *
 * POST /api/shipments hard-requires emoOfficeId + imoOfficeId (TKT-FH5Q94, v0.91.3), and every
 * test that creates a shipment used to look up "the first active SE / SI office". Those only ever
 * existed in a long-lived dev database — a fresh database (every CI run) has none, so the lookup
 * came back undefined and each of those test files failed before its first shipment.
 *
 * ensureOffices() keeps the same "use whatever active office is there" behavior on a populated
 * database, and only when a department has no active office at all does it create a fixed fixture
 * one — so each test provisions what it needs instead of depending on ambient database state.
 * Idempotent: the office code is deterministic (country-unlocode-department), so repeated calls
 * across test files reuse the same rows rather than piling up new ones.
 *
 * The fixture identity (country FX / unlocode FXFIX) is deliberately artificial so it can't
 * collide with the offices individual tests create for themselves (ZZ…, X…, XXTST, NL<random>).
 */

const BASE = "http://localhost:3001";

const FIXTURE = {
  SE: { unlocode: "FXFIX", countryCode: "FX", department: "SE", name: "Test Fixture Export Office" },
  SI: { unlocode: "FXFIX", countryCode: "FX", department: "SI", name: "Test Fixture Import Office" },
};

async function call(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty / non-JSON body */ }
  return { status: res.status, body: parsed };
}

const asList = body => (Array.isArray(body) ? body : (body?.results ?? []));

async function ensureOffice(token, department) {
  const before = await call("GET", "/api/offices", token);
  const existing = asList(before.body).find(o => o.department === department && o.isActive);
  if (existing) return existing.id;

  const created = await call("POST", "/api/offices", token, FIXTURE[department]);
  if (created.status === 201) return created.body.id;

  // The fixture office is already there but another test deactivated it — bring it back rather
  // than failing (its code is fixed, so a second POST can never succeed).
  const dormant = asList(before.body).find(o => o.code === `FX-FXFIX-${department}`);
  if (dormant) {
    const revived = await call("PUT", `/api/offices/${dormant.id}`, token, { isActive: true });
    if (revived.status === 200) return dormant.id;
  }
  throw new Error(`ensureOffices: no active ${department} office and could not create one (${created.status}: ${JSON.stringify(created.body)})`);
}

/** Resolves { emoOfficeId, imoOfficeId } — the Export (SE) and Import (SI) managing offices. */
export async function ensureOffices(token) {
  // Sequential on purpose: two concurrent POSTs could race on the same deterministic code.
  const emoOfficeId = await ensureOffice(token, "SE");
  const imoOfficeId = await ensureOffice(token, "SI");
  return { emoOfficeId, imoOfficeId };
}
