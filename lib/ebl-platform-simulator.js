"use strict";

// Built-in eBL platform (Epic TKT-C7EBU3, gap G24): plays the platform side of DCSA eBL Issuance 3.0 and
// eBL Surrender 3.0 for CargoDesk's House B/Ls, as lib/dcsa-simulator plays the carrier for bookings.
//   PUT  /ebl-sim/v3/ebl-issuance-requests    receives an issuance: checks the request against the spec,
//                                             verifies the JWS manifest with CargoDesk's signing
//                                             certificate and the checksums, and holds the document
//   POST /ebl-sim/v3/ebl-surrender-responses  CargoDesk's SURR / SREJ
// Test Tools plays everything a holder or the platform decides (act): answer the issuance (ISSU, BREQ,
// REFU), endorse to another party, ask for surrender (SREQ, AREQ). Nothing happens on its own.
// Gated with the DCSA carrier simulator: always outside production, in production only with the Demo
// switch. State in ebl_sim_documents.

const { validateRequest, errorsText } = require("./dcsa/validate");
const { manifestOf, verifyJws } = require("./ebl");

const nowIso = () => new Date().toISOString();
const CARGODESK_BASE = "http://127.0.0.1:3001/api/ebl";

module.exports = function createEblPlatformSimulator({ query, uid, getActiveSigningCert, allowed, secret }) {
  const authorized = req => String(req.headers.authorization || "") === `Bearer ${secret()}`;

  async function callCargoDesk(path, body) {
    try {
      const res = await fetch(`${CARGODESK_BASE}${path}`, { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret()}` }, body: JSON.stringify(body) });
      let parsed = null;
      try { parsed = await res.json(); } catch { /* 204 */ }
      return { delivered: res.ok, status: res.status, body: parsed };
    } catch (e) { return { delivered: false, status: 0, error: e.message }; }
  }

  const map = r => ({
    id: r.id, transportDocumentReference: r.transport_document_reference, platform: r.platform, status: r.status,
    holder: JSON.parse(r.holder_json || "{}"), endorsementChain: JSON.parse(r.endorsement_chain_json || "[]"),
    surrenderRequestReference: r.surrender_request_reference || "", surrenderRequestCode: r.surrender_request_code || "",
    lastAnswer: r.last_answer || "", manifestVerified: !!r.manifest_verified, createdAt: r.created_at, updatedAt: r.updated_at,
    actions: ({ RECEIVED: ["ISSU", "BREQ", "REFU"], ISSUED: ["endorse", "SREQ", "AREQ"], SURRENDER_REQUESTED: [], SURRENDERED: [] })[r.status] || [],
  });
  const latest = async ref => (await query("SELECT * FROM ebl_sim_documents WHERE transport_document_reference=$1 ORDER BY created_at DESC LIMIT 1", [ref]))[0] || null;

  function registerRoutes(app) {
    app.put("/ebl-sim/v3/ebl-issuance-requests", async (req, res) => {
      if (!(await allowed())) return res.status(404).json({ error: "Not found" });
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      const body = req.body || {};
      const v = validateRequest("eblIssuance", "PUT", "/v3/ebl-issuance-requests", body);
      if (!v.ok) return res.status(400).json({ errors: [{ message: errorsText(v.errors) }] });
      const cert = await getActiveSigningCert(query);
      const jws = verifyJws(body.issuanceManifestSignedContent, cert.cert_pem);
      if (!jws.ok) return res.status(400).json({ errors: [{ message: `Issuance manifest: ${jws.error}` }] });
      const expected = manifestOf(body.document, body.issueTo);
      if (jws.payload.documentChecksum !== expected.documentChecksum || jws.payload.issueToChecksum !== expected.issueToChecksum)
        return res.status(400).json({ errors: [{ message: "Issuance manifest: the checksums don't match the document and issueTo" }] });
      const now = nowIso();
      await query(`INSERT INTO ebl_sim_documents (id, transport_document_reference, platform, status, document_json, issue_to_json, holder_json,
        manifest_verified, created_at, updated_at) VALUES ($1,$2,$3,'RECEIVED',$4,$5,$5,TRUE,$6,$6)`,
        [`EBLSIM-${uid()}${uid()}`, body.document.transportDocumentReference, body.issueTo.sendToPlatform, JSON.stringify(body.document),
          JSON.stringify(body.issueTo), now]);
      res.status(204).end();
    });

    app.post("/ebl-sim/v3/ebl-surrender-responses", async (req, res) => {
      if (!(await allowed())) return res.status(404).json({ error: "Not found" });
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      const body = req.body || {};
      const v = validateRequest("eblSurrender", "POST", "/v3/ebl-surrender-responses", body);
      if (!v.ok) return res.status(400).json({ errors: [{ message: errorsText(v.errors) }] });
      const [row] = await query("SELECT * FROM ebl_sim_documents WHERE surrender_request_reference=$1", [body.surrenderRequestReference]);
      if (!row) return res.status(404).json({ errors: [{ message: `Unknown surrender request ${body.surrenderRequestReference}` }] });
      await query("UPDATE ebl_sim_documents SET status=$1, last_answer=$2, updated_at=$3 WHERE id=$4",
        [body.action === "SURR" ? "SURRENDERED" : "ISSUED", body.action, nowIso(), row.id]);
      res.status(204).end();
    });
  }

  // One platform or holder decision. ISSU|BREQ|REFU answer the issuance; endorse { partyName, partyCode }
  // hands the eBL on; SREQ|AREQ ask CargoDesk to accept a surrender.
  async function act(ref, action, { reason = "", partyName = "", partyCode = "" } = {}) {
    const row = await latest(ref);
    if (!row) return { ok: false, status: 404, error: `The platform holds no eBL ${ref}` };
    const m = map(row);
    if (!m.actions.includes(action)) return { ok: false, status: 409, error: `${action} isn't possible while the eBL is ${row.status.toLowerCase().replace(/_/g, " ")}` };
    const now = nowIso();
    const holder = JSON.parse(row.holder_json || "{}");
    if (["ISSU", "BREQ", "REFU"].includes(action)) {
      const answer = { transportDocumentReference: ref, issuanceResponseCode: action, ...(action !== "ISSU" && { reason: String(reason || `Refused (${action})`).slice(0, 255) }) };
      const delivery = await callCargoDesk("/v3/ebl-issuance-responses", answer);
      const chain = action === "ISSU" ? [{ actionDateTime: now, actionCode: "ISSUE", actor: { partyName: "CargoDesk", eblPlatform: row.platform,
        identifyingCodes: [{ codeListProvider: row.platform, partyCode: "CARGODESK" }] }, recipient: { partyName: holder.partyName, eblPlatform: row.platform,
        identifyingCodes: holder.identifyingCodes } }] : [];
      await query("UPDATE ebl_sim_documents SET status=$1, endorsement_chain_json=$2, updated_at=$3 WHERE id=$4",
        [action === "ISSU" ? "ISSUED" : "REFUSED", JSON.stringify(chain), now, row.id]);
      return { ok: true, delivery, document: map((await query("SELECT * FROM ebl_sim_documents WHERE id=$1", [row.id]))[0]) };
    }
    if (action === "endorse") {
      if (!partyName || !partyCode) return { ok: false, status: 400, error: "partyName and partyCode (the endorsee's id on the platform) are required" };
      const to = { partyName: String(partyName).slice(0, 70), eblPlatform: row.platform, identifyingCodes: [{ codeListProvider: row.platform, partyCode: String(partyCode).slice(0, 150) }] };
      const chain = JSON.parse(row.endorsement_chain_json || "[]");
      chain.push({ actionDateTime: now, actionCode: "ENDORSE", actor: { partyName: holder.partyName, eblPlatform: row.platform, identifyingCodes: holder.identifyingCodes },
        recipient: to });
      await query("UPDATE ebl_sim_documents SET holder_json=$1, endorsement_chain_json=$2, updated_at=$3 WHERE id=$4",
        [JSON.stringify({ partyName: to.partyName, sendToPlatform: row.platform, identifyingCodes: to.identifyingCodes }), JSON.stringify(chain), now, row.id]);
      return { ok: true, document: map((await query("SELECT * FROM ebl_sim_documents WHERE id=$1", [row.id]))[0]) };
    }
    // SREQ / AREQ: the holder asks the issuer to accept a surrender.
    const reference = `SR-${uid()}${uid()}`;
    const chain = JSON.parse(row.endorsement_chain_json || "[]");
    const request = { surrenderRequestReference: reference, transportDocumentReference: ref, surrenderRequestCode: action,
      ...(chain.length && { endorsementChain: chain }) };
    await query("UPDATE ebl_sim_documents SET status='SURRENDER_REQUESTED', surrender_request_reference=$1, surrender_request_code=$2, last_answer='', updated_at=$3 WHERE id=$4",
      [reference, action, now, row.id]);
    const delivery = await callCargoDesk("/v3/ebl-surrender-requests", request);
    if (!delivery.delivered) await query("UPDATE ebl_sim_documents SET status='ISSUED', updated_at=$1 WHERE id=$2", [nowIso(), row.id]);
    return { ok: true, delivery, surrenderRequestReference: reference, document: map((await query("SELECT * FROM ebl_sim_documents WHERE id=$1", [row.id]))[0]) };
  }

  async function list() {
    return (await query("SELECT * FROM ebl_sim_documents ORDER BY created_at DESC LIMIT 200")).map(map);
  }
  async function get(ref) { const r = await latest(ref); return r ? map(r) : null; }

  return { registerRoutes, act, list, get };
};
