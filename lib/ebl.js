"use strict";

// The House B/L as an eBL (Epic TKT-C7EBU3, gap G24, decision D4: issuance and surrender, no PINT).
// CargoDesk is the issuer (the NVOCC is the House B/L's carrier):
//   - issue: an issued House B/L goes to an eBL platform as a DCSA eBL Issuance 3.0 request — the
//     transport document, the party it is issued to, and a manifest of their SHA-256 checksums (RFC 8785
//     canonical JSON) signed as a compact JWS with CargoDesk's document-signing key (org_signing_certs);
//   - the platform answers on POST /api/ebl/v3/ebl-issuance-responses: ISSU, BREQ or REFU;
//   - surrender: the platform sends SREQ (for delivery) or AREQ (for amendment) to
//     POST /api/ebl/v3/ebl-surrender-requests; CargoDesk answers SURR or SREJ on the platform's
//     /v3/ebl-surrender-responses. SREQ runs the release checks (collect charges, credit hold) and a
//     SURR releases the cargo; AREQ surrenders it for amendment, after which a new version is issued.
// Every message is checked against the vendored specs (lib/dcsa/validate.js). The only platform today is
// the built-in one (lib/ebl-platform-simulator.js), gated like the DCSA carrier (Demo switch in
// production); real platforms (WAVE, CARX, BOLE, …) each need a membership first.

const crypto = require("crypto");
const { validateRequest, validateOutbound, errorsText } = require("./dcsa/validate");

// RFC 8785 (JCS): keys sorted by UTF-16 code units, ECMAScript number and string serialisation.
const canonical = v => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
};
const sha256 = s => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const b64url = buf => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const fromB64url = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// Compact JWS, RS256, signed with the active org signing certificate's key.
function signJws(payload, certRow) {
  const header = { alg: "RS256", typ: "JWT", kid: String(certRow.fingerprint_sha256 || "").slice(0, 40) };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign("sha256", Buffer.from(input), crypto.createPrivateKey(certRow.private_key_pem));
  return `${input}.${b64url(sig)}`;
}
function verifyJws(jws, certPem) {
  const [h, p, s] = String(jws || "").split(".");
  if (!h || !p || !s) return { ok: false, error: "not a compact JWS" };
  const good = crypto.verify("sha256", Buffer.from(`${h}.${p}`), crypto.createPublicKey(certPem), fromB64url(s));
  if (!good) return { ok: false, error: "signature does not verify" };
  try { return { ok: true, payload: JSON.parse(fromB64url(p).toString("utf8")) }; }
  catch { return { ok: false, error: "payload is not JSON" }; }
}
const manifestOf = (document, issueTo) => ({ documentChecksum: sha256(canonical(document)), issueToChecksum: sha256(canonical(issueTo)) });

// Platform codes the eBL Issuance spec accepts for IssueToParty.sendToPlatform.
const PLATFORMS = ["WAVE", "CARX", "IDT", "BOLE", "EDOX", "IQAX", "SECR", "TRGO", "ETEU", "TRAC", "BRIT", "COVA", "ETIT", "KTNE", "CRED", "BLOC", "DOCU", "AEOT", "SGTD"];
const PLATFORM_BASE = "http://127.0.0.1:3001/ebl-sim";
const nowIso = () => new Date().toISOString();

function createEbl(ctx) {
  const { query, uid, getActiveSigningCert, dcsaSimulator, getCustomerRow } = ctx;
  // Per-process credential between CargoDesk and the built-in platform (both ways), like the DCSA
  // carrier simulator's webhook secret.
  const secret = crypto.randomBytes(24).toString("hex");
  const authorized = req => String(req.headers.authorization || "") === `Bearer ${secret}`;
  const hb = () => ctx.houseBl;

  async function platformCall(method, path, body) {
    try {
      const res = await fetch(`${PLATFORM_BASE}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify(body) });
      let parsed = null;
      try { parsed = await res.json(); } catch { /* 204 */ }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (e) { return { ok: false, status: 0, body: { error: e.message } }; }
  }
  async function event(td, type, detail, actor) {
    await query(`INSERT INTO transport_document_events (id, transport_document_id, shipment_id, event_type, from_status, to_status, detail, actor, created_at)
      VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8)`, [`TDE-${uid()}${uid()}`, td.id, td.shipment_id, type, td.status, JSON.stringify(detail || {}), actor || "", nowIso()]);
  }

  // The party the eBL is issued to (its first possessor): by default the shipper, identified by its id on
  // the platform (a customer identifier whose type is the platform code), else the id passed in.
  async function issueToParty(s, { platform, partyName, partyCode }) {
    const shipper = await getCustomerRow(s.shipper_id);
    let code = String(partyCode || "").trim();
    if (!code && shipper) {
      const ids = await query("SELECT id_code FROM customer_identifiers WHERE customer_id=$1 AND UPPER(id_type)=$2 ORDER BY is_primary DESC", [shipper.id, platform]);
      code = ids[0]?.id_code || "";
    }
    if (!code) return { error: `The shipper has no ${platform} id: add one under Customers → Identifiers (type ${platform}), or pass partyCode` };
    return { party: {
      partyName: String(partyName || shipper?.companyName || s.shipper_name || "").trim().slice(0, 70),
      sendToPlatform: platform,
      identifyingCodes: [{ codeListProvider: platform, partyCode: code.slice(0, 150) }],
    } };
  }

  // ─── Issue ─────────────────────────────────────────────────────────────────
  async function issue(shipmentId, user, { platform = "WAVE", partyName = "", partyCode = "" } = {}) {
    const p = String(platform || "").toUpperCase();
    if (!PLATFORMS.includes(p)) return { error: `platform must be one of: ${PLATFORMS.join(", ")}`, status: 400 };
    if (!(await dcsaSimulator.allowed())) return { error: "No eBL platform is connected (the built-in one is off: App Settings → Demo carrier)", status: 409 };
    const td = await hb().liveHouse(shipmentId);
    if (!td) return { error: "Issue the House B/L first: an eBL is issued from an issued House B/L", status: 409 };
    if (td.status !== "ISSUED") return { error: `This House B/L is ${td.status.toLowerCase().replace(/_/g, " ")}`, status: 409 };
    if (td.type_code !== "BOL") return { error: "A Sea Waybill isn't a document of title: it isn't issued as an eBL", status: 409 };
    if (td.is_electronic && ["PENDING", "ISSU"].includes(td.ebl_issuance_status))
      return { error: td.ebl_issuance_status === "ISSU" ? "This House B/L is already an eBL" : "The eBL issuance is already waiting for the platform", status: 409 };
    if (td.surrendered_at) return { error: "This House B/L has been surrendered", status: 409 };
    // Paper originals out with someone and an eBL beside them would be two titles (the House B/L audit, H2).
    const paper = await hb().originalsOut(td);
    if (paper.outstanding)
      return { error: `${paper.outstanding} paper original${paper.outstanding === 1 ? " is" : "s are"} still with ${paper.holder || "the holder"}: record them returned before issuing the eBL`, status: 409 };
    const d = await hb().shipmentData(shipmentId);
    // The issuing carrier on a House B/L is CargoDesk's own legal entity: DCSA names it by SCAC, with
    // a street address and a phone or email.
    const b = d.branch;
    const gaps = !b ? ["a legal entity on the export office"] : [
      !b.scac && "a SCAC", !(b.address && b.city && b.country_code) && "a street address and city", !(b.phone || b.email) && "a phone or email",
    ].filter(Boolean);
    if (gaps.length) return { error: `${b ? `The legal entity ${b.name}` : "The shipment's export office"} needs ${gaps.join(", ")} (Organisation → Branches) before an eBL can be issued`, status: 409 };
    const who = await issueToParty(d.s, { platform: p, partyName, partyCode });
    if (who.error) return { error: who.error, status: 409 };
    const eTd = { ...td, is_electronic: true, status: "ISSUED" };
    const { doc, errors } = await hb().buildDcsaDocument(eTd, d);
    if (errors) return { error: `The House B/L isn't a valid DCSA transport document yet: ${errors}`, status: 409 };
    const cert = await getActiveSigningCert(query);
    const body = { document: doc, issueTo: who.party, issuanceManifestSignedContent: signJws(manifestOf(doc, who.party), cert) };
    const v = validateOutbound("eblIssuance", "PUT", "/v3/ebl-issuance-requests", body);
    if (!v.ok) return { error: `The issuance request doesn't meet the eBL Issuance spec: ${errorsText(v.errors)}`, status: 409 };
    const now = nowIso();
    await query(`UPDATE transport_documents SET is_electronic=TRUE, ebl_platform=$1, ebl_issue_to=$2, ebl_issuance_status='PENDING', ebl_issuance_reason='',
      ebl_requested_at=$3, ebl_responded_at=NULL, payload=$4, payload_errors='', updated_at=$3 WHERE id=$5`,
      [p, JSON.stringify(who.party), now, JSON.stringify(doc), td.id]);
    const sent = await platformCall("PUT", "/v3/ebl-issuance-requests", body);
    if (!sent.ok) {
      await query("UPDATE transport_documents SET is_electronic=FALSE, ebl_issuance_status='', updated_at=$1 WHERE id=$2", [nowIso(), td.id]);
      return { error: `The eBL platform refused the request (${sent.status}: ${sent.body?.error || sent.body?.errors?.[0]?.message || "no answer"})`, status: 502 };
    }
    await event(td, "EBL_ISSUANCE_REQUESTED", { platform: p, issueTo: who.party.partyName }, user?.name || user?.email || "");
    return { td: (await query("SELECT * FROM transport_documents WHERE id=$1", [td.id]))[0] };
  }

  // ─── Receivers (the platform calls these) ──────────────────────────────────
  async function onIssuanceResponse(body) {
    const v = validateRequest("eblIssuance", "POST", "/v3/ebl-issuance-responses", body);
    if (!v.ok) return { status: 400, error: errorsText(v.errors) };
    const [td] = await query("SELECT * FROM transport_documents WHERE role='HOUSE' AND reference=$1 AND is_electronic=TRUE AND ebl_issuance_status='PENDING'",
      [body.transportDocumentReference]);
    if (!td) return { status: 404, error: `No eBL issuance pending for ${body.transportDocumentReference}` };
    const code = body.issuanceResponseCode, reason = String(body.reason || "").slice(0, 500);
    if (code === "ISSU")
      await query("UPDATE transport_documents SET ebl_issuance_status='ISSU', ebl_issuance_reason='', ebl_responded_at=$1, updated_at=$1 WHERE id=$2", [nowIso(), td.id]);
    else
      await query("UPDATE transport_documents SET is_electronic=FALSE, ebl_issuance_status=$1, ebl_issuance_reason=$2, ebl_responded_at=$3, updated_at=$3 WHERE id=$4",
        [code, reason, nowIso(), td.id]);
    await event(td, code === "ISSU" ? "EBL_ISSUED" : "EBL_ISSUANCE_REFUSED", { code, reason, platform: td.ebl_platform }, td.ebl_platform);
    return { status: 204 };
  }

  async function onSurrenderRequest(body) {
    const v = validateRequest("eblSurrender", "POST", "/v3/ebl-surrender-requests", body);
    if (!v.ok) return { status: 400, error: errorsText(v.errors) };
    const [td] = await query(`SELECT * FROM transport_documents WHERE role='HOUSE' AND reference=$1 AND is_electronic=TRUE AND ebl_issuance_status='ISSU'
      AND status='ISSUED'`, [body.transportDocumentReference]);
    if (!td) return { status: 404, error: `No issued eBL ${body.transportDocumentReference} open for surrender` };
    const [dup] = await query("SELECT 1 FROM ebl_surrender_requests WHERE surrender_request_reference=$1", [body.surrenderRequestReference]);
    if (dup) return { status: 409, error: `Surrender request ${body.surrenderRequestReference} was already received` };
    const id = `ESR-${uid()}${uid()}`, code = body.surrenderRequestCode;
    const pending = code === "SREQ" ? "PENDING_SURRENDER_FOR_DELIVERY" : "PENDING_SURRENDER_FOR_AMENDMENT";
    await query(`INSERT INTO ebl_surrender_requests (id, surrender_request_reference, transport_document_id, transport_document_reference, request_code, request_json, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, body.surrenderRequestReference, td.id, body.transportDocumentReference, code, JSON.stringify(body), nowIso()]);
    await query("UPDATE transport_documents SET status=$1, updated_at=$2 WHERE id=$3", [pending, nowIso(), td.id]);
    await event({ ...td }, code === "SREQ" ? "EBL_SURRENDER_FOR_DELIVERY_REQUESTED" : "EBL_SURRENDER_FOR_AMENDMENT_REQUESTED",
      { surrenderRequestReference: body.surrenderRequestReference }, td.ebl_platform);
    // DCSA answers asynchronously, on the platform's callback.
    setImmediate(() => answerSurrender(id).catch(e => console.error("eBL surrender answer failed:", e.message)));
    return { status: 204 };
  }

  // The holder who asks for the surrender: the last recipient in the request's endorsement chain (the
  // endorsee of a to-order eBL), else nobody named (the party it was issued to still holds it).
  const holderOf = r => {
    try { return (JSON.parse(r.request_json || "{}").endorsementChain || []).slice(-1)[0]?.recipient?.partyName || ""; } catch { return ""; }
  };

  // SREQ: the release checks other than the originals (the surrender is the originals) — any left and
  // the surrender is rejected; none and the eBL is surrendered and the cargo released. AREQ: surrendered
  // for amendment.
  async function answerSurrender(requestId) {
    const [r] = await query("SELECT * FROM ebl_surrender_requests WHERE id=$1", [requestId]);
    const [td] = await query("SELECT * FROM transport_documents WHERE id=$1", [r.transport_document_id]);
    let action = "SURR", comments = "";
    const platformUser = { name: `eBL platform ${td.ebl_platform}` };
    if (r.request_code === "SREQ") {
      const { blocks } = await hb().releaseChecks(td.shipment_id);
      const others = blocks.filter(b => b.key !== "originals");
      if (others.length) { action = "SREJ"; comments = others.map(b => b.message).join("; ").slice(0, 250); }
    }
    if (action === "SREJ") {
      await query("UPDATE transport_documents SET status='ISSUED', updated_at=$1 WHERE id=$2", [nowIso(), td.id]);
      await event({ ...td, status: "ISSUED" }, "EBL_SURRENDER_REJECTED", { surrenderRequestReference: r.surrender_request_reference, comments }, "CargoDesk");
    } else if (r.request_code === "SREQ") {
      await hb().onSurrendered(td.shipment_id, { kind: "platform", user: platformUser,
        detail: { surrenderRequestReference: r.surrender_request_reference, ...(holderOf(r) && { presentedBy: holderOf(r) }) } });
      await hb().release(td.shipment_id, platformUser);
    } else {
      // Surrendered for amendment (gap G6): the next issue is version + 1 under the same number.
      await hb().onSurrenderedForAmendment(td.shipment_id, { kind: "platform", user: platformUser, reason: "Amendment requested on the eBL platform (AREQ)",
        detail: { surrenderRequestReference: r.surrender_request_reference, ...(holderOf(r) && { presentedBy: holderOf(r) }) } });
    }
    const answer = { surrenderRequestReference: r.surrender_request_reference, action, ...(comments && { comments }) };
    const v = validateOutbound("eblSurrender", "POST", "/v3/ebl-surrender-responses", answer);
    if (!v.ok) throw new Error(`surrender answer fails the spec: ${errorsText(v.errors)}`);
    await query("UPDATE ebl_surrender_requests SET answer=$1, answer_reason=$2, answered_at=$3 WHERE id=$4", [action, comments, nowIso(), r.id]);
    await platformCall("POST", "/v3/ebl-surrender-responses", answer);
  }

  function registerRoutes(app) {
    const receive = handler => async (req, res) => {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      const r = await handler(req.body || {});
      if (r.status === 204) return res.status(204).end();
      res.status(r.status).json({ error: r.error });
    };
    app.post("/api/ebl/v3/ebl-issuance-responses", receive(onIssuanceResponse));
    app.post("/api/ebl/v3/ebl-surrender-requests", receive(onSurrenderRequest));
  }

  return { PLATFORMS, issue, onIssuanceResponse, onSurrenderRequest, registerRoutes, secret: () => secret, authorized,
    canonical, sha256, manifestOf, verifyJws };
}

module.exports = createEbl;
module.exports.canonical = canonical;
module.exports.manifestOf = manifestOf;
module.exports.verifyJws = verifyJws;
module.exports.signJws = signJws;
