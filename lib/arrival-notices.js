"use strict";
// ─── The carrier's Arrival Notice (DCSA Arrival Notice 1.0, DCSA-everywhere phase 8, 2026-10-28) ───
// Built once as ctx.arrivalNotices. The carrier publishes its arrival notice (POST …/arrival-notices, or a
// lightweight notification CargoDesk follows with a GET, or "Ask the carrier again"), and it lands on the
// shipment whose Master or House B/L it names, for the import side:
//   - every version is kept (arrival_notices); the newest by issueDateTime is current;
//   - the arrival date moves the sea leg's ETA (lib/track-trace.js applyVesselTime: a carrier estimate
//     never overwrites an arrival the carrier or AIS has confirmed);
//   - its free time (DEM → the container's destination free days, DET → destination detention days)
//     fills a container's empty days; where the container says otherwise, the difference is shown and a
//     person keeps theirs or uses the carrier's — nothing is overwritten silently;
//   - its charges are shown; "Add as accruals" makes the chosen ones BUY lines (the user's decision,
//     2026-10-28: shown, added on a click, one that looks already entered starts unticked).

const { CLASSIFIER_FROM_SHORT, containerIso } = require("./dcsa/codes");

const nowIso = () => new Date().toISOString();
const parse = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const up = s => String(s || "").toUpperCase().trim();
const FIELD = { DEM: "dest_free_time_days", DET: "dest_detention_free_days" };
const KIND = { DEM: "Demurrage", DET: "Detention" };

// A carrier charge → CargoDesk's charge code (the labels Cost Entry uses): its own code if it is one of
// CargoDesk's, else by what it's called; "Other" when nothing fits (the name goes in the notes).
function chargeCodeOf(charge, SERVICE_CODE_MAP = {}) {
  const byCode = SERVICE_CODE_MAP[up(charge.chargeCode)];
  if (byCode) return byCode;
  const n = String(charge.chargeName || "");
  if (/terminal handling|\bthc\b/i.test(n)) return "Destination THC";
  if (/documentation|delivery order|\bd\/?o\b/i.test(n)) return "Documentation Fee";
  if (/security|isps/i.test(n)) return "ISPS Security Surcharge";
  if (/demurrage/i.test(n)) return "Demurrage";
  if (/detention|per diem/i.test(n)) return "Detention";
  if (/customs/i.test(n)) return "Customs";
  return "Other";
}

// Does a free-time line apply to this container? Named by its number (most specific), by its ISO code or
// ISO type group (45G1 is in 45GP), or — naming neither — to every container. → 3 | 2 | 1 | 0 (no).
const GROUP = { G: "GP", R: "RT", U: "UT", P: "PL", T: "TN" };
function appliesTo(ft, c) {
  const numbers = (ft.equipmentReferences || []).map(up), isos = (ft.ISOEquipmentCodes || []).map(up);
  if (numbers.length) return numbers.includes(up(c.container_number)) ? 3 : 0;
  if (isos.length) {
    const iso = up(containerIso(c));
    return iso && (isos.includes(iso) || isos.includes(`${iso.slice(0, 2)}${GROUP[iso[2]] || ""}`)) ? 2 : 0;
  }
  return 1;
}

module.exports = function createArrivalNotices(ctx) {
  const { query, uid, logEvent, logEntityEvent, toUsd, SERVICE_CODE_MAP } = ctx;

  // The notice's free time for one container and kind (DEM / DET): the most specific line. Only calendar or
  // working days count as free days ("HR" stays on the notice). → { days, unit, lastFreeDate } | null
  function freeTimeFor(an, c, kind) {
    let best = null, rank = 0;
    for (const ft of an.freeTimes || []) {
      if (!(ft.typeCodes || []).map(up).includes(kind) || !Number.isInteger(ft.duration)) continue;
      const r = appliesTo(ft, c);
      if (r > rank) { best = ft; rank = r; }
    }
    if (!best || !["CD", "WD"].includes(up(best.timeUnit || "CD"))) return null;
    return { days: best.duration, unit: up(best.timeUnit || "CD"), lastFreeDate: best.lastFreeDate?.value || best.lastFreeDateTime?.value?.slice(0, 10) || null };
  }

  // The shipments a notice is for: its transport document (Master or House) and House B/L references.
  async function shipmentsFor(an) {
    const refs = [an.transportDocumentReference, ...(an.houseBillOfLadingReferences || [])].map(r => String(r || "").trim()).filter(Boolean);
    if (!refs.length) return [];
    const ph = refs.map((_, i) => `$${i + 1}`).join(",");
    const rows = await query(`SELECT shipment_id AS id FROM transport_documents WHERE reference IN (${ph}) AND status <> 'VOIDED'
      UNION SELECT id FROM shipments WHERE master_bl_number IN (${ph}) OR bl_number IN (${ph})`, refs);
    return [...new Set(rows.map(r => r.id))];
  }

  // Works one notice into one shipment. A notice already held (same document, version and issue time)
  // changes nothing; an older one than the current is kept, not applied. → { stored, current, applied }
  async function apply(shipmentId, an, { carrierCode = "", simulated = false, source = "push" } = {}) {
    const version = String(an.versionLabel || ""), issued = String(an.issueDateTime || "");
    const [held] = await query(`SELECT id FROM arrival_notices WHERE shipment_id=$1 AND transport_document_reference=$2 AND version_label=$3 AND issue_date_time=$4`,
      [shipmentId, an.transportDocumentReference, version, issued]);
    if (held) return { stored: false, current: false };
    const [current] = await query("SELECT * FROM arrival_notices WHERE shipment_id=$1 AND is_current=TRUE", [shipmentId]);
    const isCurrent = !current || issued >= current.issue_date_time;
    const id = `AN-${uid()}${uid()}`, now = nowIso(), carrier = an.carrierCode || carrierCode || "";
    const applied = { legTime: null, filled: [], differs: [] };
    if (isCurrent) {
      const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
      // The arrival at the port of discharge: the sea leg's ETA (or its confirmed arrival).
      const arr = an.transport?.portOfDischargeArrivalDate;
      if (arr?.value) {
        const t = await ctx.trackTrace.applyVesselTime(shipmentId, { field: "eta", unLocationCode: up(an.transport?.portOfDischarge?.UNLocationCode || shipment?.pod),
          classifier: CLASSIFIER_FROM_SHORT[up(arr.classifier)] || "ESTIMATED", dateTime: arr.value, source: "Arrival Notice", carrierCode: carrier });
        if (t) applied.legTime = t;
      }
      // Free time: a container's empty days are filled; a different number is shown, not overwritten.
      for (const c of await query("SELECT * FROM containers WHERE shipment_id=$1 ORDER BY container_number", [shipmentId])) {
        for (const kind of ["DEM", "DET"]) {
          const ft = freeTimeFor(an, c, kind);
          if (!ft) continue;
          const has = c[FIELD[kind]];
          if (has === null || has === undefined || has === "") {
            await query(`UPDATE containers SET ${FIELD[kind]}=$1 WHERE id=$2`, [ft.days, c.id]);
            await logEvent(shipmentId, "CONTAINER_UPDATED", FIELD[kind], "", String(ft.days),
              JSON.stringify({ containerNumber: c.container_number, source: `Arrival Notice from ${carrier || "the carrier"}` }), carrier || "Carrier");
            applied.filled.push({ containerId: c.id, kind, days: ft.days });
          } else if (Number(has) !== ft.days) applied.differs.push({ containerId: c.id, kind, days: ft.days, onContainer: Number(has) });
        }
      }
      if (current) await query("UPDATE arrival_notices SET is_current=FALSE WHERE id=$1", [current.id]);
    }
    await query(`INSERT INTO arrival_notices (id, shipment_id, carrier_code, transport_document_reference, version_label, issue_date_time, payload,
      is_current, is_mock, source, applied, accruals, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'',$12)`,
      [id, shipmentId, carrier, an.transportDocumentReference, version, issued, JSON.stringify(an), isCurrent, !!simulated, source, JSON.stringify(applied), now]);
    await logEvent(shipmentId, "ARRIVAL_NOTICE_RECEIVED", "arrival_notice", current?.version_label || "", version || issued,
      JSON.stringify({ transportDocumentReference: an.transportDocumentReference, current: isCurrent,
        ...(applied.legTime ? { eta: applied.legTime.to } : {}), filled: applied.filled.length, differs: applied.differs.length }), carrier || "Carrier");
    return { stored: true, current: isCurrent, applied };
  }

  // A pushed or pulled list of notices. → { feedbackElements } (an INFO per notice CargoDesk couldn't place)
  async function receive(notices, { carrierCode = "", simulated = false, source = "push" } = {}) {
    const feedbackElements = [];
    let stored = 0;
    for (const [i, an] of (notices || []).entries()) {
      const ids = await shipmentsFor(an);
      if (!ids.length) {
        feedbackElements.push({ severity: "WARN", propertyPath: `$.arrivalNotices[${i}].transportDocumentReference`,
          message: `No shipment holds transport document ${an.transportDocumentReference}` });
        continue;
      }
      for (const id of ids) if ((await apply(id, an, { carrierCode, simulated, source })).stored) stored++;
    }
    return { stored, feedbackElements };
  }

  // ─── What the Arrival Notice page shows ─────────────────────────────────────
  async function view(shipmentId) {
    const rows = await query("SELECT * FROM arrival_notices WHERE shipment_id=$1 ORDER BY issue_date_time DESC, received_at DESC", [shipmentId]);
    const row = rows.find(r => r.is_current) || rows[0];
    if (!row) return null;
    const an = parse(row.payload) || {};
    const applied = parse(row.applied) || {}, accruals = parse(row.accruals) || [];
    const containers = await query("SELECT * FROM containers WHERE shipment_id=$1 ORDER BY container_number", [shipmentId]);
    const freeTime = [];
    for (const c of containers) for (const kind of ["DEM", "DET"]) {
      const ft = freeTimeFor(an, c, kind);
      if (!ft) continue;
      const has = c[FIELD[kind]];
      const filled = (applied.filled || []).some(f => f.containerId === c.id && f.kind === kind);
      const kept = (applied.kept || []).some(f => f.containerId === c.id && f.kind === kind);
      freeTime.push({ containerId: c.id, containerNumber: c.container_number, kind, label: KIND[kind], days: ft.days, unit: ft.unit,
        lastFreeDate: ft.lastFreeDate, onContainer: has === null || has === undefined || has === "" ? null : Number(has),
        state: has === null || has === undefined || has === "" ? "empty" : Number(has) === ft.days ? (filled ? "filled" : "same") : kept ? "kept" : "differs" });
    }
    const costLines = await query("SELECT * FROM shipment_cost_lines WHERE shipment_id=$1 AND type='BUY'", [shipmentId]);
    const charges = (an.charges || []).map((ch, index) => {
      const added = accruals.find(a => a.index === index) || null;
      const code = chargeCodeOf(ch, SERVICE_CODE_MAP);
      const same = !added && costLines.find(l => l.currency === up(ch.currencyCode) && (Math.abs(Number(l.amount) - Number(ch.currencyAmount)) < 0.005
        || (code !== "Other" && l.charge_code === code)));
      return { index, name: ch.chargeName || "", code: ch.chargeCode || "", chargeCode: code, amount: Number(ch.currencyAmount) || 0, currency: up(ch.currencyCode),
        paymentTermCode: ch.paymentTermCode || "", basis: ch.calculationBasis || "", unitPrice: ch.unitPrice ?? null, quantity: ch.quantity ?? null,
        addedCostLineId: added?.costLineId || null,
        looksEntered: same ? `An accrual of ${same.currency} ${Number(same.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })} "${same.charge_code}" is already in Cost Entry` : null };
    });
    const leg = an.transport?.legs?.slice(-1)[0];
    const vv = leg?.vesselVoyage || {};
    const loc = l => (l ? { name: l.locationName || l.facility?.facilityCode || "", unLocationCode: l.UNLocationCode || "" } : null);
    return {
      id: row.id, version: row.version_label, issueDateTime: row.issue_date_time, receivedAt: row.received_at, carrierCode: row.carrier_code,
      transportDocumentReference: row.transport_document_reference, isMock: !!row.is_mock, source: row.source,
      facts: {
        vessel: vv.vesselName || "", voyage: vv.carrierImportVoyageNumber || vv.carrierExportVoyageNumber || "",
        portOfDischarge: an.transport?.portOfDischarge?.UNLocationCode || "",
        arrival: an.transport?.portOfDischargeArrivalDate ? { date: an.transport.portOfDischargeArrivalDate.value,
          classifier: CLASSIFIER_FROM_SHORT[up(an.transport.portOfDischargeArrivalDate.classifier)] || "ESTIMATED" } : null,
        pickup: an.pickupInformation ? { number: an.pickupInformation.pickupNumber || "", location: loc(an.pickupInformation.pickupLocation) } : null,
        returnTo: an.returnInformation ? { reference: an.returnInformation.turnInReference || "", location: loc(an.returnInformation.returnLocation),
          instructions: an.returnInformation.returnInstructions || "" } : null,
        release: an.releaseInformation ? { freight: an.releaseInformation.isFreightReleased ?? null, originalBl: an.releaseInformation.isOBLReceived ?? null,
          customs: an.releaseInformation.isCustomsReleased ?? null, freightReleaseDate: an.releaseInformation.freightReleaseDate || null } : null,
        customs: an.customsClearance ? { manifest: an.customsClearance.manifestReferenceNumber || "", procedure: an.customsClearance.customsImportDeclarationProcedure || "" } : null,
        freightPaymentStatus: an.freightPaymentStatus || "", additionalInformation: an.additionalInformation || "",
      },
      etaChange: applied.legTime ? { from: applied.legTime.from, to: applied.legTime.to } : null,
      freeTime, charges,
      versions: rows.map(r => ({ id: r.id, version: r.version_label, issueDateTime: r.issue_date_time, receivedAt: r.received_at, isCurrent: !!r.is_current })),
      notice: an,
    };
  }

  // A difference on free time settled by a person: use the carrier's days, or keep the container's.
  async function settleFreeTime(shipmentId, { containerId, kind, use }, who) {
    const v = await view(shipmentId);
    const ft = v?.freeTime.find(f => f.containerId === containerId && f.kind === kind);
    if (!ft) return { error: "The Arrival Notice gives no such free time for that container", status: 404 };
    const [row] = await query("SELECT * FROM arrival_notices WHERE id=$1", [v.id]);
    const applied = parse(row.applied) || {};
    if (use) {
      await query(`UPDATE containers SET ${FIELD[kind]}=$1 WHERE id=$2 AND shipment_id=$3`, [ft.days, containerId, shipmentId]);
      await logEvent(shipmentId, "CONTAINER_UPDATED", FIELD[kind], ft.onContainer === null ? "" : String(ft.onContainer), String(ft.days),
        JSON.stringify({ containerNumber: ft.containerNumber, source: `Arrival Notice from ${v.carrierCode || "the carrier"}` }), who);
      applied.filled = [...(applied.filled || []).filter(f => !(f.containerId === containerId && f.kind === kind)), { containerId, kind, days: ft.days }];
    } else {
      applied.kept = [...(applied.kept || []).filter(f => !(f.containerId === containerId && f.kind === kind)), { containerId, kind, days: ft.onContainer }];
      await logEvent(shipmentId, "ARRIVAL_NOTICE_FREE_TIME_KEPT", FIELD[kind], String(ft.days), String(ft.onContainer),
        JSON.stringify({ containerNumber: ft.containerNumber }), who);
    }
    await query("UPDATE arrival_notices SET applied=$1 WHERE id=$2", [JSON.stringify(applied), v.id]);
    return { arrivalNotice: await view(shipmentId) };
  }

  // The chosen charges as BUY accruals from the carrier (source 'arrival_notice'), each once.
  async function addAccruals(shipmentId, indices, who) {
    const v = await view(shipmentId);
    if (!v) return { error: "The shipment has no Arrival Notice", status: 404 };
    const [row] = await query("SELECT * FROM arrival_notices WHERE id=$1", [v.id]);
    const accruals = parse(row.accruals) || [];
    const created = [];
    for (const i of [...new Set((indices || []).map(Number))]) {
      const ch = v.charges[i];
      if (!ch || ch.addedCostLineId || !(ch.amount > 0)) continue;
      const usd = await toUsd(ch.amount, ch.currency);
      const id = `CL-${uid()}`;
      const notes = [ch.name, ch.basis || (ch.quantity && ch.unitPrice ? `${ch.quantity} × ${ch.currency} ${ch.unitPrice}` : ""),
        `Arrival Notice v${v.version || "1"} from ${v.carrierCode || "the carrier"}`].filter(Boolean).join(" · ");
      await query(`INSERT INTO shipment_cost_lines (id, shipment_id, type, charge_code, currency, amount, exchange_rate, notes, created_at, source, payment_indicator)
        VALUES ($1,$2,'BUY',$3,$4,$5,$6,$7,$8,'arrival_notice',$9)`,
        [id, shipmentId, ch.chargeCode, ch.currency || "USD", ch.amount, ch.amount ? Math.round((usd / ch.amount) * 100000) / 100000 : 1, notes, nowIso(),
          ch.paymentTermCode === "PRE" ? "Prepaid" : "Collect"]);
      await logEntityEvent("cost_line", id, "IMPORTED", null, null, null,
        JSON.stringify({ shipmentId, chargeCode: ch.chargeCode, currency: ch.currency, amount: ch.amount, source: "arrival_notice", arrivalNoticeId: v.id, by: who }));
      accruals.push({ index: i, costLineId: id });
      created.push(id);
    }
    await query("UPDATE arrival_notices SET accruals=$1 WHERE id=$2", [JSON.stringify(accruals), v.id]);
    if (created.length) await logEvent(shipmentId, "ARRIVAL_NOTICE_ACCRUED", "cost_lines", "", String(created.length),
      JSON.stringify({ arrivalNoticeId: v.id, costLineIds: created }), who);
    return { created, arrivalNotice: await view(shipmentId) };
  }

  // The B/L numbers the carrier knows this shipment by: the Master's, and the House's.
  async function referencesOf(shipmentId) {
    const [s] = await query("SELECT master_bl_number, bl_number FROM shipments WHERE id=$1", [shipmentId]);
    const tds = await query("SELECT reference FROM transport_documents WHERE shipment_id=$1 AND status<>'VOIDED' ORDER BY role", [shipmentId]);
    return [...new Set([s?.master_bl_number, s?.bl_number, ...tds.map(t => t.reference)].map(r => String(r || "").trim()).filter(Boolean))];
  }

  return { receive, apply, view, settleFreeTime, addAccruals, referencesOf, shipmentsFor, chargeCodeOf: ch => chargeCodeOf(ch, SERVICE_CODE_MAP) };
};
