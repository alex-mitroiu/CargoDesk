"use strict";

// ─── The office split, on stored shipments (2026-11-14, ARCHITECTURE.md §8.52) ──────────────────────────────────────────
// lib/payment-terms.js holds the rules; this applies them to rows: what a shipment's payment terms are and who may
// change them, every line's office, issuer and billed party, and the legal entity each line counts for in the reports.
// Built once as ctx.officeSplit.
//
// A shipment is split once its payment terms are saved (shipments.payment_terms): by the OCC/BK on the Carrier Booking,
// or when the booking request goes to the carrier. Before that it is billed as it always was (decision B: what is already
// issued stays as it is): one legal entity (entityByShipment), one invoice to the principal, else the consignee.

const rules = require("./payment-terms");

module.exports = function createOfficeSplit(ctx) {
  const { query, logEvent } = ctx;

  // A shipment row (+ its additional offices) → the camelCase shape the rules read.
  const shape = (s, sideOfficeIds = []) => ({
    id: s.id, incoterm: s.incoterm || "", paymentTerms: s.payment_terms || null, freightTerms: s.freight_terms || "",
    emoOfficeId: s.emo_office_id || null, imoOfficeId: s.imo_office_id || null, billingOfficeId: s.billing_office_id || null,
    controllingOfficeId: s.controlling_office_id || null, sideOfficeIds,
    shipperId: s.shipper_id || "", shipperName: s.shipper_name || "", consigneeId: s.consignee_id || "", consigneeName: s.consignee_name || "",
    principalId: s.principal_id || "", principalName: s.principal_name || "",
  });
  const lineShape = l => ({ chargeCode: l.charge_code ?? l.chargeCode, chargeSide: l.charge_side ?? l.chargeSide ?? "",
    responsibleOffice: l.responsible_office ?? l.responsibleOffice ?? "", source: l.source || "" });

  async function sideOfficesOf(shipmentIds) {
    const ids = [...new Set(shipmentIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await query(`SELECT shipment_id, office_id FROM shipment_side_offices WHERE shipment_id = ANY($1)`, [ids]).catch(() => []);
    const m = new Map();
    for (const r of rows) m.set(r.shipment_id, [...(m.get(r.shipment_id) || []), r.office_id]);
    return m;
  }
  async function loadShipment(shipmentId) {
    const [s] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
    if (!s) return null;
    return { row: s, shipment: shape(s, (await sideOfficesOf([s.id])).get(s.id) || []) };
  }

  // Offices → { id, code, name, department, unlocode, entity { entityId, entityName, currency, taxRegistrationNumber,
  // countryCode, standardVatRate } } (the shape entityByShipment gives).
  async function officesById(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map();
    const rows = await query(`SELECT o.id, o.code, o.name, o.department, o.unlocode, o.is_active, b.id AS entity_id, b.name AS entity_name,
        b.currency AS entity_currency, b.tax_registration_number AS entity_tax_number, b.country_code AS entity_country, b.standard_vat_rate AS entity_vat_rate
      FROM offices o LEFT JOIN branches b ON b.id = o.branch_id WHERE o.id = ANY($1)`, [list]);
    return new Map(rows.map(r => [r.id, { id: r.id, code: r.code, name: r.name, department: r.department, unlocode: r.unlocode || "", isActive: !!r.is_active,
      entity: r.entity_id ? { entityId: r.entity_id, entityName: r.entity_name || "", currency: r.entity_currency || "USD", taxRegistrationNumber: r.entity_tax_number || "",
        countryCode: r.entity_country || "", standardVatRate: r.entity_vat_rate ?? null } : null }]));
  }

  // The payment terms screen: the categories with their office and billed party, and the offices to choose from.
  async function view(shipmentId) {
    const l = await loadShipment(shipmentId);
    if (!l) return null;
    const { shipment } = l;
    const terms = rules.termsOf(shipment);
    const keys = rules.officeKeysOf(shipment);
    const offices = await officesById(keys.map(k => rules.officeIdOf(shipment, k)));
    const officeOf = key => { const o = offices.get(rules.officeIdOf(shipment, key)); return o ? { id: o.id, code: o.code, name: o.name, unlocode: o.unlocode, entityName: o.entity?.entityName || "" } : null; };
    return {
      shipmentId, saved: terms.saved, followsIncoterm: terms.followsIncoterm, incoterm: shipment.incoterm,
      // D1: before the terms are saved, whether the ocean freight's term comes from Freight Terms (shown "from Freight Terms").
      freightFromFreightTerms: !!terms.freightFromFreightTerms, freightTerms: shipment.freightTerms || "",
      billingOfficeId: shipment.billingOfficeId,
      categories: rules.CATEGORIES.map(c => ({ id: c.id, label: c.label, side: c.side, term: terms.categories[c.id].term, office: terms.categories[c.id].office,
        officeDetail: officeOf(terms.categories[c.id].office), billTo: rules.billedPartyOf(shipment, terms.categories[c.id].term),
        default: rules.defaultCategories(shipment.incoterm)[c.id] })),
      offices: keys.map(k => ({ key: k, label: rules.OFFICE_ROLE_LABEL[k] || "Additional office", ...officeOf(k) })),
    };
  }

  // Every line with its split (SELL lines also with who issues and who is billed). Not saved: `split` is null.
  async function annotate(shipmentId, mappedLines) {
    const l = await loadShipment(shipmentId);
    if (!l) return mappedLines;
    const terms = rules.termsOf(l.shipment);
    if (!terms.saved) return mappedLines.map(m => ({ ...m, split: null }));
    return mappedLines.map(m => ({ ...m, split: rules.lineSplit(l.shipment, lineShape(m), terms) }));
  }

  // The split for raw cost-line rows of any shipments → Map(lineId → lineSplit | null (not split)).
  async function splitOfLineRows(lineRows) {
    const ids = [...new Set(lineRows.map(r => r.shipment_id).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    const ships = await query("SELECT * FROM shipments WHERE id = ANY($1)", [ids]);
    const side = await sideOfficesOf(ids);
    const byId = new Map(ships.map(s => [s.id, shape(s, side.get(s.id) || [])]));
    for (const r of lineRows) {
      const s = byId.get(r.shipment_id);
      const terms = s ? rules.termsOf(s) : null;
      out.set(r.id, s && terms.saved ? rules.lineSplit(s, lineShape(r), terms) : null);
    }
    return out;
  }

  // The legal entity each line counts for (the reports): a split SELL line its issuer's (the billing office, else its
  // office), a split BUY line its office's; a document issued after the split its issuing office's (`issuerByLine`:
  // lineId → office id); anything else the shipment's (entityByShipment). An office with no legal entity falls back to
  // the shipment's. → Map(lineId → entity | null).
  async function entityOfLines(lineRows, { issuerByLine = new Map() } = {}) {
    const splits = await splitOfLineRows(lineRows);
    const officeFor = r => issuerByLine.get(r.id) || (splits.get(r.id) ? (r.type === "SELL" ? splits.get(r.id).issuerOfficeId : splits.get(r.id).officeId) : null);
    const offices = await officesById(lineRows.map(officeFor));
    const fallback = await ctx.entityByShipment(lineRows.map(r => r.shipment_id));
    return new Map(lineRows.map(r => [r.id, offices.get(officeFor(r))?.entity || fallback.get(r.shipment_id) || null]));
  }

  // A split shipment's lines carry their category's term as their own Prepaid/Collect mark (payment_indicator: the House
  // B/L's charges, the cargo release check, GP by payment term) — the user, 2026-11-14. Not split: the mark stays as
  // entered. markFor(shipmentId, line) → "Prepaid" | "Collect" | null (not split).
  const markOf = term => (term === "COL" ? "Collect" : "Prepaid");
  async function markFor(shipmentId, line = {}) {
    const l = await loadShipment(shipmentId);
    if (!l) return null;
    const terms = rules.termsOf(l.shipment);
    return terms.saved ? markOf(terms.categories[rules.categoryOf(lineShape(line))].term) : null;
  }
  // Brings every line of a split shipment in step with its category's term. Kept as they are (decision B: what is issued
  // stays): a charge on a confirmed invoice or an issued statement, and a reversal line. → lines changed.
  async function syncLineMarks(shipmentId) {
    const l = await loadShipment(shipmentId);
    if (!l) return 0;
    const terms = rules.termsOf(l.shipment);
    if (!terms.saved) return 0;
    const rows = await query("SELECT * FROM shipment_cost_lines WHERE shipment_id=$1", [shipmentId]);
    const want = r => markOf(terms.categories[rules.categoryOf(lineShape(r))].term);
    // A reversal keeps the mark of the charge it reverses (the reversed charge itself is free to be invoiced again).
    const wrong = rows.filter(r => (r.payment_indicator || "Prepaid") !== want(r) && r.source !== "reversal");
    if (!wrong.length) return 0;
    const holds = await ctx.billingHolds(wrong.filter(r => r.type === "SELL").map(r => r.id));
    const issued = h => !!h && (h.kind === "invoice" ? h.status === "confirmed" : h.status !== "draft");
    let changed = 0;
    for (const r of wrong) {
      if (issued(holds.get(r.id))) continue;
      await query("UPDATE shipment_cost_lines SET payment_indicator=$1 WHERE id=$2", [want(r), r.id]);
      changed++;
    }
    return changed;
  }

  // Who may change a shipment's payment terms and responsible offices: the OCC/BK of its export side (decision 4),
  // admins and operators (canActAs).
  // Who may change the payment terms and what the booking request states: the export side's OCC/BK, admins, operators;
  // nobody on a Completed or Cancelled shipment (audit C, 2026-11-24, TKT-W29BNX: the cards said they could, then the save
  // was refused as locked by server.js shipmentStatusLock).
  const mayEdit = (user, req, shipmentRow) => !(ctx.LOCKED_SHIPMENT_STATUSES || ["Completed", "Cancelled"]).includes(shipmentRow?.status)
    && ctx.bookingEscalations.canActAs(user, req, "occ_bk", ctx.mapShipment(shipmentRow));

  // Saves the terms the first time (the Incoterm's defaults), so the shipment is split from now on; keeps Freight Terms
  // in step. Used by the booking request. → the terms.
  async function activate(shipmentId, actor = "") {
    const l = await loadShipment(shipmentId);
    if (!l) return null;
    if (l.row.payment_terms) return rules.termsOf(l.shipment);
    // Saved exactly as shown before (D1, 2026-11-23): the Incoterm's terms, except an ocean freight term that followed
    // Freight Terms and differs from the Incoterm's, which is kept (then the terms no longer follow the Incoterm). So
    // sending never switches Freight Terms behind anyone's back.
    const shown = rules.termsOf(l.shipment);
    const stored = shown.followsIncoterm ? { followsIncoterm: true } : { followsIncoterm: false, categories: shown.categories };
    await query("UPDATE shipments SET payment_terms=$1 WHERE id=$2 AND payment_terms IS NULL", [JSON.stringify(stored), shipmentId]);
    const terms = rules.termsOf({ ...l.shipment, paymentTerms: stored });
    await syncFreightTerms(shipmentId, l.row, terms, actor);
    await syncLineMarks(shipmentId);
    await logEvent(shipmentId, "PAYMENT_TERMS_SET", "payment_terms", null, shown.followsIncoterm ? "From the Incoterm" : "As shown",
      JSON.stringify({ reason: shown.followsIncoterm
        ? `The booking went to the carrier: the payment terms follow the Incoterm ${l.shipment.incoterm || "(none)"}`
        : `The booking went to the carrier: the payment terms as shown, the ocean freight ${terms.categories.freight.term === "COL" ? "Collect" : "Prepaid"} from Freight Terms, the rest from the Incoterm ${l.shipment.incoterm || "(none)"}` }), actor);
    return terms;
  }

  // Freight Terms (on Conditions, the House B/L, Shipping Instructions) follows the ocean freight's term.
  async function syncFreightTerms(shipmentId, row, terms, actor) {
    const want = rules.freightTermsFor(terms.categories.freight.term, row.freight_terms || "");
    if (want === (row.freight_terms || "")) return;
    await query("UPDATE shipments SET freight_terms=$1 WHERE id=$2", [want, shipmentId]);
    await logEvent(shipmentId, "FIELD_UPDATED", "freight_terms", row.freight_terms || null, want,
      JSON.stringify({ reason: "Follows the ocean freight's payment term" }), actor);
  }

  // PUT …/payment-terms: { reset?: true } back to the Incoterm, or { categories: { id: { term, office } } } and/or
  // { lines: { lineId: { chargeSide?, responsibleOffice? } } }. → { status, error } | { view }.
  async function save(shipmentId, body = {}, user, req) {
    const l = await loadShipment(shipmentId);
    if (!l) return { status: 404, error: "Shipment not found" };
    if (!(await mayEdit(user, req, l.row))) return { status: 403, error: "Only the shipment's OCC/BK (export side), an admin or an operator can change its payment terms and offices" };
    const actor = user?.name || user?.email || "";
    const before = rules.termsOf(l.shipment);
    let stored = l.row.payment_terms ? JSON.parse(l.row.payment_terms) : null;
    if (body.reset) stored = { followsIncoterm: true };
    else if (body.categories && typeof body.categories === "object") {
      const next = {};
      for (const c of rules.CATEGORIES) {
        const sent = body.categories[c.id] || {};
        const term = sent.term ?? before.categories[c.id].term, office = sent.office ?? before.categories[c.id].office;
        if (!rules.TERMS.includes(term)) return { status: 400, error: `${c.label}: the payment term is PRE or COL` };
        if (!rules.isOfficeKey(l.shipment, office)) return { status: 400, error: `${c.label}: ${office} isn't one of this shipment's offices` };
        next[c.id] = { term, office };
      }
      const same = rules.CATEGORY_IDS.every(id => next[id].term === rules.defaultCategories(l.shipment.incoterm)[id].term && next[id].office === rules.defaultCategories(l.shipment.incoterm)[id].office);
      stored = same ? { followsIncoterm: true } : { followsIncoterm: false, categories: next };
    } else if (!stored) stored = { followsIncoterm: true };
    // Lines: checked first, written after the terms.
    const lineChanges = [];
    if (body.lines && typeof body.lines === "object") {
      const ids = Object.keys(body.lines);
      const rows = ids.length ? await query("SELECT * FROM shipment_cost_lines WHERE shipment_id=$1 AND id = ANY($2)", [shipmentId, ids]) : [];
      for (const id of ids) {
        const r = rows.find(x => x.id === id);
        if (!r) return { status: 404, error: `Cost line ${id} isn't on this shipment` };
        const sent = body.lines[id] || {};
        const side = sent.chargeSide !== undefined ? String(sent.chargeSide || "") : (r.charge_side || "");
        const office = sent.responsibleOffice !== undefined ? String(sent.responsibleOffice || "") : (r.responsible_office || "");
        if (side && !rules.SIDES.includes(side)) return { status: 400, error: `${r.charge_code}: the side is Origin or Destination` };
        if (side && rules.sideOfCode(r.charge_code)) return { status: 400, error: `${r.charge_code} names its own side` };
        if (office && !rules.isOfficeKey(l.shipment, office)) return { status: 400, error: `${r.charge_code}: ${office} isn't one of this shipment's offices` };
        if (side !== (r.charge_side || "") || office !== (r.responsible_office || "")) lineChanges.push({ r, side, office });
      }
      // What is issued or posted keeps its office (audit S4, TKT-JQ5L1M): a charge on a confirmed invoice or an issued
      // statement, a posted cost (it may be in a GL export already).
      const holds = await ctx.billingHolds(lineChanges.filter(c => c.r.type === "SELL").map(c => c.r.id));
      for (const { r } of lineChanges) {
        const h = holds.get(r.id);
        if (h && (h.kind === "invoice" ? h.status === "confirmed" : h.status !== "draft"))
          return { status: 409, error: `${r.charge_code} is on ${h.kind === "invoice" ? `invoice ${h.label || h.id}` : `statement ${h.id}`}, already issued: its office and side stay as billed` };
        if (r.status === "posted")
          return { status: 409, error: `${r.charge_code} (${r.type === "BUY" ? "cost" : "charge"}) is posted: its office and side stay as posted` };
      }
    }
    await query("UPDATE shipments SET payment_terms=$1 WHERE id=$2", [JSON.stringify(stored), shipmentId]);
    const after = rules.termsOf({ ...l.shipment, paymentTerms: stored });
    const termText = t => (t === "PRE" ? "Prepaid" : "Collect");
    const officeText = key => rules.OFFICE_ROLE_LABEL[key] || "Additional office";
    if (!before.saved) await logEvent(shipmentId, "PAYMENT_TERMS_SET", "payment_terms", null, after.followsIncoterm ? "From the Incoterm" : "Set by hand", "", actor);
    for (const c of rules.CATEGORIES) {
      const a = before.categories[c.id], b = after.categories[c.id];
      if (a.term !== b.term || a.office !== b.office)
        await logEvent(shipmentId, "PAYMENT_TERMS_CHANGED", c.id, `${termText(a.term)} · ${officeText(a.office)}`, `${termText(b.term)} · ${officeText(b.office)}`,
          JSON.stringify({ category: c.label }), actor);
    }
    for (const { r, side, office } of lineChanges) {
      await query("UPDATE shipment_cost_lines SET charge_side=$1, responsible_office=$2, modified_at=$3 WHERE id=$4", [side, office, new Date().toISOString(), r.id]);
      await logEvent(shipmentId, "COST_LINE_OFFICE_CHANGED", "responsible_office", [r.charge_side, r.responsible_office ? officeText(r.responsible_office) : "its category's office"].filter(Boolean).join(" · "),
        [side, office ? officeText(office) : "its category's office"].filter(Boolean).join(" · "),
        JSON.stringify({ type: r.type, chargeCode: r.charge_code, costLineId: r.id }), actor);
    }
    await syncFreightTerms(shipmentId, l.row, after, actor);
    await syncLineMarks(shipmentId);
    return { view: await view(shipmentId) };
  }

  // A new shipment's billing office: its export office's.
  async function billingOfficeFor(emoOfficeId) {
    if (!emoOfficeId) return null;
    // Only while the billing office is active (audit S5, TKT-EO2AJT): one deactivated later stays named on its offices.
    const [o] = await query(`SELECT o.billing_office_id FROM offices o JOIN offices b ON b.id = o.billing_office_id AND b.is_active = TRUE
      WHERE o.id=$1`, [emoOfficeId]);
    return o?.billing_office_id && o.billing_office_id !== emoOfficeId ? o.billing_office_id : null;
  }

  // Legal entities by id → Map(id → entity) (a statement records its entity).
  async function entitiesById(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map();
    const rows = await query(`SELECT id, name, currency, tax_registration_number, country_code, standard_vat_rate FROM branches WHERE id = ANY($1)`, [list]);
    return new Map(rows.map(b => [b.id, { entityId: b.id, entityName: b.name || "", currency: b.currency || "USD", taxRegistrationNumber: b.tax_registration_number || "",
      countryCode: b.country_code || "", standardVatRate: b.standard_vat_rate ?? null }]));
  }

  return { rules, shape, loadShipment, officesById, entitiesById, view, annotate, splitOfLineRows, entityOfLines, mayEdit, activate, save, billingOfficeFor, syncFreightTerms,
    markFor, syncLineMarks };
};
