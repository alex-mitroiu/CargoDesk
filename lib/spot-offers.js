"use strict";

// SPOT rates (plan: https://claude.ai/artifact/Y61PAmXZfgFxTLtpt7GiAZ; agreed with the user 2026-10-21).
// A spot offer is a carrier's priced answer for one shipment: its reference (the quotation number or
// price id the booking must carry, DCSA Booking 2.0 `contractQuotationReference`), its charges, until
// when it may be booked, and its penalty terms. Sales attaches it to a quote; the booking desk can also
// attach one straight to a shipment (e.g. when the contract has no space). On a shipment its charges
// become the BUY side, so a SPOT shipment has a cost and a margin from the start.
//
// Two kinds, from the research in the plan:
//   - classic: a carrier's FAK quote or rate sheet. Days to weeks; surcharges often "subject to" at
//     shipment. Expired → a warning only (its terms may still hold).
//   - digital: Maersk Spot, Hapag-Lloyd Quick Quotes Spot, CMA CGM SpotOn. Minutes to a day, priced per
//     departure. Expired → it can't be attached or booked (the user, 2026-10-21).
// No DCSA standard covers rates, so offers come from manual entry now and from per-carrier adapters later.

module.exports = function createSpotOffers(ctx) {
  const { query, transaction, uid, toUsd, logEvent, logEntityEvent, SERVICE_CODE_MAP, ensureBookingCreated } = ctx;

  const KINDS = ["classic", "digital"];
  const SOURCES = ["manual", "demo", "api"];
  const PRICE_LOCKS = { booking: "At booking confirmation", gate_in: "At gate-in", departure: "At departure", bl_date: "At the B/L date" };
  const BASES = ["per_container", "per_bl"];
  const TERMS = ["PRE", "COL"];
  // A booking the carrier already holds is priced on the offer it was sent with: changing the offer
  // then means amending or cancelling the booking first.
  const SENT = ["Pending", "Confirmed"];

  const SCAC = /^[A-Z]{2,4}$/, LOCODE = /^[A-Z]{2}[A-Z0-9]{3}$/, EQUIPMENT = /^\d{2}[A-Z0-9]{2}$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/, CURRENCY = /^[A-Z]{3}$/;
  const fail = (status, error) => ({ ok: false, status, error });
  const nowIso = () => new Date().toISOString();
  const up = v => String(v ?? "").trim().toUpperCase();
  const round2 = n => Math.round(n * 100) / 100;
  const actorOf = user => user?.name || user?.email || "";

  // A date-only validity runs to the end of that day (UTC); a timestamp to that instant.
  function isExpired(row, now = Date.now()) {
    const v = row?.valid_until || "";
    if (!v) return false;
    if (DATE.test(v)) return v < new Date(now).toISOString().slice(0, 10);
    const t = Date.parse(v);
    return Number.isFinite(t) && t < now;
  }
  const blocksBooking = row => row.kind === "digital" && isExpired(row);

  const mapLine = l => ({
    id: l.id, serviceCode: l.service_code || "", chargeCode: SERVICE_CODE_MAP[(l.service_code || "").toUpperCase()] || "Other",
    description: l.description || "", basis: l.basis || "per_container", containerType: l.container_type || "",
    quantity: Number(l.quantity) || 0, unitPrice: Number(l.unit_price) || 0, currency: l.currency || "USD",
    amount: Number(l.amount) || 0, amountUsd: Number(l.amount_usd) || 0, paymentTerm: l.payment_term || "PRE", included: !!l.included,
  });
  const num = v => (v === null || v === undefined ? null : Number(v));
  function mapOffer(r, lines = []) {
    let equipment = [];
    try { equipment = JSON.parse(r.equipment || "[]"); } catch { equipment = []; }
    const expired = isExpired(r);
    return {
      id: r.id, carrierCode: r.carrier_code, offerRef: r.offer_ref, kind: r.kind, source: r.source,
      pol: r.pol || "", pod: r.pod || "", equipment,
      vessel: r.vessel || "", voyage: r.voyage || "", etd: r.etd || "",
      validUntil: r.valid_until || "", priceLock: r.price_lock || "booking", priceLockLabel: PRICE_LOCKS[r.price_lock] || "",
      totalUsd: Number(r.total_usd) || 0, subjectToUsd: Number(r.subject_to_usd) || 0,
      penalties: {
        cancellationFee: num(r.cancellation_fee), cancellationNoticeDays: num(r.cancellation_notice_days),
        noShowFee: num(r.no_show_fee), amendmentFee: num(r.amendment_fee), rollCompensation: num(r.roll_compensation),
        currency: r.fee_currency || "USD", basis: r.fee_basis || "per_container",
      },
      status: r.status, quoteId: r.quote_id || "", shipmentId: r.shipment_id || "", notes: r.notes || "",
      createdAt: r.created_at, createdBy: r.created_by || "", updatedAt: r.updated_at || null, updatedBy: r.updated_by || "",
      expired, bookable: !(expired && r.kind === "digital"),
      lines: lines.map(mapLine),
    };
  }

  async function load(id) {
    if (!id) return null;
    const [row] = await query("SELECT * FROM spot_offers WHERE id=$1", [id]);
    if (!row) return null;
    const lines = await query("SELECT * FROM spot_offer_lines WHERE offer_id=$1 ORDER BY sort_order", [id]);
    return { row, lines };
  }
  async function get(id) {
    const o = await load(id);
    return o ? mapOffer(o.row, o.lines) : null;
  }
  async function mapRows(rows) {
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const lines = await query(`SELECT * FROM spot_offer_lines WHERE offer_id IN (${ids.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY sort_order`, ids);
    return rows.map(r => mapOffer(r, lines.filter(l => l.offer_id === r.id)));
  }

  // ─── Checking an offer ────────────────────────────────────────────────────────────────────────
  // A create/update body → { value } (lines already priced in USD) or { error }.
  const optNumber = (v, label) => {
    if (v === null || v === undefined || v === "") return { value: null };
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? { value: round2(n) } : { error: `${label} must be zero or more` };
  };
  async function validate(body) {
    const b = body || {};
    const carrierCode = up(b.carrierCode);
    if (!SCAC.test(carrierCode)) return { error: "Pick the carrier" };
    const offerRef = String(b.offerRef ?? "").trim();
    if (!offerRef) return { error: "Enter the carrier's quotation number or offer reference" };
    if (offerRef.length > 35) return { error: "The offer reference can be at most 35 characters (DCSA contractQuotationReference)" };
    const kind = b.kind === undefined || b.kind === "" ? "classic" : b.kind;
    if (!KINDS.includes(kind)) return { error: "Kind is classic (a carrier quote) or digital (an instant spot offer)" };
    const pol = up(b.pol), pod = up(b.pod);
    if (!LOCODE.test(pol) || !LOCODE.test(pod)) return { error: "Port of loading and port of discharge are UN/LOCODEs, e.g. NLRTM" };
    if (pol === pod) return { error: "Port of loading and port of discharge must differ" };
    const validUntil = String(b.validUntil ?? "").trim();
    if (!validUntil || !Number.isFinite(Date.parse(validUntil))) return { error: "Enter until when the offer may be booked" };
    const priceLock = b.priceLock === undefined || b.priceLock === "" ? "booking" : b.priceLock;
    if (!PRICE_LOCKS[priceLock]) return { error: `Price lock is one of: ${Object.keys(PRICE_LOCKS).join(", ")}` };
    const vessel = String(b.vessel ?? "").trim().slice(0, 50), voyage = String(b.voyage ?? "").trim().slice(0, 50);
    const etd = String(b.etd ?? "").trim().slice(0, 10);
    if (etd && !DATE.test(etd)) return { error: "The departure date is YYYY-MM-DD" };

    const rawEquipment = Array.isArray(b.equipment) ? b.equipment : [];
    if (!rawEquipment.length) return { error: "Add the containers the offer is for" };
    const equipment = [];
    for (const e of rawEquipment) {
      const containerType = up(e?.containerType), quantity = Number(e?.quantity);
      if (!EQUIPMENT.test(containerType)) return { error: `Container type "${e?.containerType ?? ""}" isn't a type code such as 40HC` };
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return { error: `The number of ${containerType} must be a whole number from 1` };
      equipment.push({ containerType, quantity });
    }

    const rawLines = Array.isArray(b.lines) ? b.lines : [];
    if (!rawLines.length) return { error: "Add the offer's charges" };
    const lines = [];
    for (const [i, l] of rawLines.entries()) {
      const at = `Charge ${i + 1}`;
      const serviceCode = up(l?.serviceCode).slice(0, 10);
      if (!serviceCode) return { error: `${at}: pick a charge code` };
      const basis = l?.basis === undefined || l?.basis === "" ? "per_container" : l.basis;
      if (!BASES.includes(basis)) return { error: `${at}: basis is per_container or per_bl` };
      let containerType = up(l?.containerType);
      if (containerType && !EQUIPMENT.test(containerType)) return { error: `${at}: container type "${l.containerType}" isn't a type code such as 40HC` };
      if (basis === "per_container" && !containerType && equipment.length === 1) containerType = equipment[0].containerType;
      if (basis === "per_bl") containerType = "";
      const quantity = l?.quantity === undefined || l?.quantity === ""
        ? (basis === "per_bl" ? 1 : (equipment.find(e => e.containerType === containerType)?.quantity || 1))
        : Number(l.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) return { error: `${at}: quantity must be more than zero` };
      const unitPrice = Number(l?.unitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) return { error: `${at}: enter the price` };
      const currency = l?.currency ? up(l.currency) : "USD";
      if (!CURRENCY.test(currency)) return { error: `${at}: currency is a 3-letter code such as USD` };
      const paymentTerm = l?.paymentTerm ? up(l.paymentTerm) : "PRE";
      if (!TERMS.includes(paymentTerm)) return { error: `${at}: payment term is PRE (prepaid) or COL (collect)` };
      const amount = round2(unitPrice * quantity);
      lines.push({
        serviceCode, description: String(l?.description ?? "").trim().slice(0, 100), basis, containerType, quantity,
        unitPrice: round2(unitPrice), currency, amount, amountUsd: await toUsd(amount, currency), paymentTerm,
        included: l?.included === undefined ? true : !!l.included,
      });
    }
    if (!lines.some(l => l.amount > 0)) return { error: "At least one charge needs a price" };

    const penalties = {};
    for (const [key, label] of [["cancellationFee", "The cancellation fee"], ["noShowFee", "The no-show fee"],
      ["amendmentFee", "The amendment fee"], ["rollCompensation", "The roll compensation"]]) {
      const r = optNumber(b.penalties?.[key], label);
      if (r.error) return { error: r.error };
      penalties[key] = r.value;
    }
    const days = b.penalties?.cancellationNoticeDays;
    if (days !== null && days !== undefined && days !== "" && !(Number.isInteger(Number(days)) && Number(days) >= 0))
      return { error: "The cancellation notice is a whole number of days" };
    penalties.cancellationNoticeDays = days === null || days === undefined || days === "" ? null : Number(days);
    penalties.currency = b.penalties?.currency ? up(b.penalties.currency) : "USD";
    if (!CURRENCY.test(penalties.currency)) return { error: "The fees' currency is a 3-letter code such as USD" };
    penalties.basis = b.penalties?.basis || "per_container";
    if (!BASES.includes(penalties.basis)) return { error: "The fees are per_container or per_bl" };

    return {
      value: {
        carrierCode, offerRef, kind, pol, pod, equipment, vessel, voyage, etd, validUntil, priceLock, lines, penalties,
        notes: String(b.notes ?? "").trim().slice(0, 1000),
        totalUsd: round2(lines.filter(l => l.included).reduce((s, l) => s + l.amountUsd, 0)),
        subjectToUsd: round2(lines.filter(l => !l.included).reduce((s, l) => s + l.amountUsd, 0)),
      },
    };
  }

  async function writeLines(tx, offerId, lines) {
    await tx.query("DELETE FROM spot_offer_lines WHERE offer_id=$1", [offerId]);
    for (const [i, l] of lines.entries()) {
      await tx.query(`INSERT INTO spot_offer_lines (id, offer_id, sort_order, service_code, description, basis, container_type,
          quantity, unit_price, currency, amount, amount_usd, payment_term, included) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [`SPL-${uid()}`, offerId, i, l.serviceCode, l.description, l.basis, l.containerType, l.quantity, l.unitPrice, l.currency,
          l.amount, l.amountUsd, l.paymentTerm, l.included]);
    }
  }
  const offerColumns = v => [v.carrierCode, v.offerRef, v.kind, v.pol, v.pod, JSON.stringify(v.equipment), v.vessel, v.voyage, v.etd,
    v.validUntil, v.priceLock, v.totalUsd, v.subjectToUsd, v.penalties.cancellationFee, v.penalties.cancellationNoticeDays,
    v.penalties.noShowFee, v.penalties.amendmentFee, v.penalties.rollCompensation, v.penalties.currency, v.penalties.basis, v.notes];

  // ─── Lifecycle ────────────────────────────────────────────────────────────────────────────────
  async function create(body, user, { source = "manual" } = {}) {
    const v = await validate(body);
    if (v.error) return fail(400, v.error);
    if (!SOURCES.includes(source)) return fail(400, "Unknown source");
    const id = `SPO-${uid()}`, now = nowIso(), actor = actorOf(user);
    await transaction(async tx => {
      await tx.query(`INSERT INTO spot_offers (carrier_code, offer_ref, kind, pol, pod, equipment, vessel, voyage, etd, valid_until,
          price_lock, total_usd, subject_to_usd, cancellation_fee, cancellation_notice_days, no_show_fee, amendment_fee,
          roll_compensation, fee_currency, fee_basis, notes, id, source, status, created_at, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'Offered',$24,$25)`,
        [...offerColumns(v.value), id, source, now, actor]);
      await writeLines(tx, id, v.value.lines);
    });
    await logEntityEvent("spot_offer", id, "CREATED", null, null, null,
      JSON.stringify({ carrierCode: v.value.carrierCode, offerRef: v.value.offerRef, kind: v.value.kind, source, totalUsd: v.value.totalUsd, by: actor }));
    return { ok: true, offer: await get(id) };
  }

  // An offer can be changed while nobody books on it: unattached, or on a Draft quote.
  async function editable(row) {
    if (row.shipment_id) return `It's attached to ${row.shipment_id}: detach it there first`;
    if (row.status === "Booked") return "It was booked on";
    if (row.quote_id) {
      const [q] = await query("SELECT status FROM quotes WHERE id=$1", [row.quote_id]);
      if (q && q.status !== "Draft") return `Its quote ${row.quote_id} is ${q.status}`;
    }
    return null;
  }
  async function update(id, body, user) {
    const o = await load(id);
    if (!o) return fail(404, "Spot offer not found");
    const blocked = await editable(o.row);
    if (blocked) return fail(409, `This offer can't be changed. ${blocked}.`);
    const v = await validate(body);
    if (v.error) return fail(400, v.error);
    if (o.row.quote_id && v.value.carrierCode !== o.row.carrier_code)
      return fail(409, `The offer is on quote ${o.row.quote_id}; detach it before changing its carrier`);
    await transaction(async tx => {
      await tx.query(`UPDATE spot_offers SET carrier_code=$1, offer_ref=$2, kind=$3, pol=$4, pod=$5, equipment=$6, vessel=$7, voyage=$8,
          etd=$9, valid_until=$10, price_lock=$11, total_usd=$12, subject_to_usd=$13, cancellation_fee=$14, cancellation_notice_days=$15,
          no_show_fee=$16, amendment_fee=$17, roll_compensation=$18, fee_currency=$19, fee_basis=$20, notes=$21, updated_at=$22, updated_by=$23
        WHERE id=$24`, [...offerColumns(v.value), nowIso(), actorOf(user), id]);
      await writeLines(tx, id, v.value.lines);
      // The quote carries the offer's reference as its contract reference (attachToQuote).
      if (o.row.quote_id) await tx.query("UPDATE quotes SET contract_ref=$1 WHERE id=$2 AND spot_offer_id=$3", [v.value.offerRef, o.row.quote_id, id]);
    });
    await logEntityEvent("spot_offer", id, "UPDATED", null, null, null, JSON.stringify({ totalUsd: v.value.totalUsd, by: actorOf(user) }));
    return { ok: true, offer: await get(id) };
  }

  async function remove(id, user) {
    const o = await load(id);
    if (!o) return fail(404, "Spot offer not found");
    if (o.row.shipment_id || o.row.quote_id || o.row.status !== "Offered")
      return fail(409, `Detach the offer from ${o.row.shipment_id || o.row.quote_id || "its booking"} before deleting it`);
    await query("DELETE FROM spot_offers WHERE id=$1", [id]);
    await logEntityEvent("spot_offer", id, "DELETED", null, null, null, JSON.stringify({ offerRef: o.row.offer_ref, by: actorOf(user) }));
    return { ok: true };
  }

  const routeMismatch = (row, pol, pod) =>
    (pol && pol !== row.pol) || (pod && pod !== row.pod) ? `This offer is for ${row.pol} → ${row.pod}; the route here is ${pol || "?"} → ${pod || "?"}` : null;

  // ─── Quotes ───────────────────────────────────────────────────────────────────────────────────
  // The quote takes the offer's carrier and reference, and drops a Central contract: it's now priced
  // on the spot offer, and its conversion makes a SPOT shipment with the offer's BUY lines.
  async function attachToQuote(offerId, quote, user) {
    const o = await load(offerId);
    if (!o) return fail(404, "Spot offer not found");
    const { row } = o;
    if (quote.status !== "Draft") return fail(409, `Only a Draft quote can take a spot offer (this one is ${quote.status})`);
    if (row.shipment_id) return fail(409, `This offer is already on ${row.shipment_id}`);
    if (row.quote_id && row.quote_id !== quote.id) return fail(409, `This offer is already on quote ${row.quote_id}`);
    if (row.status === "Booked") return fail(409, "This offer was already booked on");
    const mismatch = routeMismatch(row, quote.pol, quote.pod);
    if (mismatch) return fail(409, mismatch);
    if (blocksBooking(row)) return fail(409, `This digital spot offer expired (${row.valid_until}): get a fresh one from ${row.carrier_code}`);
    const previous = quote.spot_offer_id && quote.spot_offer_id !== offerId ? quote.spot_offer_id : null;
    await transaction(async tx => {
      if (previous) await tx.query("UPDATE spot_offers SET status='Offered', quote_id='' WHERE id=$1", [previous]);
      await tx.query("UPDATE spot_offers SET status='Attached', quote_id=$1 WHERE id=$2", [quote.id, offerId]);
      await tx.query("UPDATE quotes SET spot_offer_id=$1, carrier_code=$2, contract_id='', contract_ref=$3 WHERE id=$4",
        [offerId, row.carrier_code, row.offer_ref, quote.id]);
    });
    await logEntityEvent("quote", quote.id, "SPOT_OFFER_ATTACHED", "spot_offer_id", previous, offerId,
      JSON.stringify({ offerRef: row.offer_ref, carrierCode: row.carrier_code, totalUsd: row.total_usd, by: actorOf(user) }));
    await logEntityEvent("spot_offer", offerId, "ATTACHED", null, null, null, JSON.stringify({ quoteId: quote.id, by: actorOf(user) }));
    return { ok: true, offer: await get(offerId), warning: isExpired(row) ? `This quote expired on ${row.valid_until}: check ${row.carrier_code} still honours it` : null };
  }

  async function detachFromQuote(quote, user) {
    if (quote.status !== "Draft") return fail(409, `Only a Draft quote's spot offer can be removed (this one is ${quote.status})`);
    const offerId = quote.spot_offer_id;
    if (!offerId) return fail(404, "This quote has no spot offer");
    const o = await load(offerId);
    await transaction(async tx => {
      await tx.query("UPDATE quotes SET spot_offer_id='', contract_ref=CASE WHEN contract_ref=$1 THEN '' ELSE contract_ref END WHERE id=$2",
        [o?.row.offer_ref || "", quote.id]);
      if (o) await tx.query("UPDATE spot_offers SET status='Offered', quote_id='' WHERE id=$1", [offerId]);
    });
    await logEntityEvent("quote", quote.id, "SPOT_OFFER_DETACHED", "spot_offer_id", offerId, null, JSON.stringify({ by: actorOf(user) }));
    if (o) await logEntityEvent("spot_offer", offerId, "DETACHED", null, null, null, JSON.stringify({ quoteId: quote.id, by: actorOf(user) }));
    return { ok: true };
  }

  // ─── Shipments ────────────────────────────────────────────────────────────────────────────────
  // The offer's charges as BUY lines (source 'spot_offer'): what was bought, so its amounts are the
  // offer's own, not recounted from the shipment's containers. "Subject to" charges are accrued too,
  // marked as such: the carrier will bill them at their level on the shipment date.
  async function accrueBuyLines(tx, shipmentId, row, lines, now) {
    const created = [];
    for (const l of lines) {
      if (!(Number(l.amount) > 0)) continue;
      const chargeCode = SERVICE_CODE_MAP[(l.service_code || "").toUpperCase()] || "Other";
      const exchangeRate = Number(l.amount_usd) > 0 ? Math.round((Number(l.amount_usd) / Number(l.amount)) * 100000) / 100000 : 1;
      const what = l.basis === "per_bl" ? "per B/L" : `${Number(l.quantity)} × ${l.container_type || "container"}`;
      const notes = [[l.service_code, l.description].filter(Boolean).join(" — "), what,
        l.included ? "" : "subject to change at shipment", `spot offer ${row.offer_ref}`].filter(Boolean).join(" · ");
      const id = `CL-${uid()}`;
      await tx.query(`INSERT INTO shipment_cost_lines (id, shipment_id, type, charge_code, currency, amount, exchange_rate, notes, created_at, source, spot_offer_id)
        VALUES ($1,$2,'BUY',$3,$4,$5,$6,$7,$8,'spot_offer',$9)`, [id, shipmentId, chargeCode, l.currency || "USD", Number(l.amount), exchangeRate, notes, now, row.id]);
      created.push({ id, chargeCode, currency: l.currency || "USD", amount: Number(l.amount) });
    }
    return created;
  }
  async function logAccrued(shipmentId, row, created) {
    for (const c of created)
      await logEntityEvent("cost_line", c.id, "IMPORTED", null, null, null,
        JSON.stringify({ shipmentId, chargeCode: c.chargeCode, currency: c.currency, amount: c.amount, source: "spot_offer", spotOfferId: row.id }));
  }
  async function bookingSent(shipmentId) {
    const [b] = await query("SELECT status FROM carrier_bookings WHERE shipment_id=$1", [shipmentId]);
    return b && SENT.includes(b.status) ? b.status : null;
  }

  // Takes a spot offer onto a shipment: it becomes SPOT, priced on this offer (contract reference =
  // the offer's), with the offer's charges as BUY lines. A shipment on a Central contract changes its
  // contract first (Change Contract), so space and contract rates are released the usual way.
  async function attachToShipment(offerId, shipment, user) {
    const o = await load(offerId);
    if (!o) return fail(404, "Spot offer not found");
    const { row, lines } = o;
    if (["Cancelled", "Completed"].includes(shipment.status)) return fail(409, `${shipment.id} is ${shipment.status}`);
    if (shipment.contract_type === "Central")
      return fail(409, `${shipment.id} is on a Central contract: change its contract to SPOT first`);
    if (row.shipment_id && row.shipment_id !== shipment.id) return fail(409, `This offer is already on ${row.shipment_id}`);
    if (row.quote_id && row.shipment_id !== shipment.id) {
      const [q] = await query("SELECT status FROM quotes WHERE id=$1", [row.quote_id]);
      if (q && q.status !== "Converted") return fail(409, `This offer is on quote ${row.quote_id}: convert the quote, or remove the offer from it first`);
    }
    if (row.status === "Booked" && row.shipment_id !== shipment.id) return fail(409, "This offer was already booked on");
    if (row.carrier_code !== shipment.carrier_code)
      return fail(409, `This offer is from ${row.carrier_code}; ${shipment.id}'s carrier is ${shipment.carrier_code}`);
    const mismatch = routeMismatch(row, shipment.pol, shipment.pod);
    if (mismatch) return fail(409, mismatch);
    if (blocksBooking(row)) return fail(409, `This digital spot offer expired (${row.valid_until}): get a fresh one from ${row.carrier_code}`);
    const sent = await bookingSent(shipment.id);
    if (sent) return fail(409, `The booking already went to ${shipment.carrier_code} (${sent}): cancel or amend it before changing its spot offer`);
    if (shipment.spot_offer_id === offerId) return { ok: true, offer: await get(offerId), unchanged: true };

    const previous = shipment.spot_offer_id ? await load(shipment.spot_offer_id) : null;
    const now = nowIso();
    let created = [], removed = 0;
    await transaction(async tx => {
      if (previous) {
        const gone = await tx.query("DELETE FROM shipment_cost_lines WHERE shipment_id=$1 AND spot_offer_id=$2 AND type='BUY' AND COALESCE(status,'accrued')='accrued' RETURNING id",
          [shipment.id, previous.row.id]);
        removed = gone.length;
        await tx.query("UPDATE spot_offers SET status='Offered', shipment_id='' WHERE id=$1", [previous.row.id]);
      }
      await tx.query("UPDATE shipments SET contract_type='SPOT', contract_id='', contract_ref=$1, spot_offer_id=$2 WHERE id=$3",
        [row.offer_ref, offerId, shipment.id]);
      await tx.query("UPDATE spot_offers SET status='Attached', shipment_id=$1 WHERE id=$2", [shipment.id, offerId]);
      created = await accrueBuyLines(tx, shipment.id, row, lines, now);
    });
    const actor = actorOf(user);
    await logEvent(shipment.id, "SPOT_OFFER_ATTACHED", "contract_ref", shipment.contract_ref || null, row.offer_ref,
      JSON.stringify({ spotOfferId: offerId, carrierCode: row.carrier_code, kind: row.kind, totalUsd: Number(row.total_usd) || 0,
        validUntil: row.valid_until, buyLines: created.length, replaced: previous?.row.offer_ref || null, removedBuyLines: removed }), actor);
    if (shipment.contract_type !== "SPOT")
      await logEvent(shipment.id, "FIELD_UPDATED", "contract_type", shipment.contract_type || null, "SPOT", "", actor);
    await logAccrued(shipment.id, row, created);
    await logEntityEvent("spot_offer", offerId, "ATTACHED", null, null, null, JSON.stringify({ shipmentId: shipment.id, by: actor }));
    if (previous) await logEntityEvent("spot_offer", previous.row.id, "DETACHED", null, null, null, JSON.stringify({ shipmentId: shipment.id, by: actor }));
    await ensureBookingCreated(shipment.id);
    return {
      ok: true, offer: await get(offerId), buyLines: created.length,
      warning: isExpired(row) ? `This quote expired on ${row.valid_until}: check ${row.carrier_code} still honours it before booking` : null,
    };
  }

  async function detachFromShipment(shipment, user) {
    const offerId = shipment.spot_offer_id;
    if (!offerId) return fail(404, `${shipment.id} has no spot offer`);
    const sent = await bookingSent(shipment.id);
    if (sent) return fail(409, `The booking already went to ${shipment.carrier_code} (${sent}): cancel or amend it before removing its spot offer`);
    const o = await load(offerId);
    let removed = 0, kept = 0;
    await transaction(async tx => {
      const gone = await tx.query("DELETE FROM shipment_cost_lines WHERE shipment_id=$1 AND spot_offer_id=$2 AND type='BUY' AND COALESCE(status,'accrued')='accrued' RETURNING id",
        [shipment.id, offerId]);
      removed = gone.length;
      const [{ n }] = await tx.query("SELECT COUNT(*)::int AS n FROM shipment_cost_lines WHERE shipment_id=$1 AND spot_offer_id=$2", [shipment.id, offerId]);
      kept = Number(n) || 0;
      await tx.query("UPDATE shipments SET spot_offer_id='', contract_ref=CASE WHEN contract_ref=$1 THEN '' ELSE contract_ref END WHERE id=$2",
        [o?.row.offer_ref || "", shipment.id]);
      if (o) await tx.query("UPDATE spot_offers SET status='Offered', shipment_id='' WHERE id=$1", [offerId]);
    });
    const actor = actorOf(user);
    await logEvent(shipment.id, "SPOT_OFFER_DETACHED", "contract_ref", o?.row.offer_ref || null, null,
      JSON.stringify({ spotOfferId: offerId, removedBuyLines: removed, keptBuyLines: kept }), actor);
    if (o) await logEntityEvent("spot_offer", offerId, "DETACHED", null, null, null, JSON.stringify({ shipmentId: shipment.id, by: actor }));
    return { ok: true, removedBuyLines: removed, keptBuyLines: kept };
  }

  // Quote → shipment (routes/quotes.js convert): the quote's offer moves onto the new SPOT shipment
  // with its BUY lines. The shipment row already carries the offer's reference as contract_ref.
  async function attachOnConversion(shipmentId, quote, user) {
    const o = await load(quote.spot_offer_id);
    if (!o) return { ok: false };
    const now = nowIso();
    let created = [];
    await transaction(async tx => {
      await tx.query("UPDATE shipments SET spot_offer_id=$1 WHERE id=$2", [o.row.id, shipmentId]);
      await tx.query("UPDATE spot_offers SET status='Attached', shipment_id=$1 WHERE id=$2", [shipmentId, o.row.id]);
      created = await accrueBuyLines(tx, shipmentId, o.row, o.lines, now);
    });
    await logEvent(shipmentId, "SPOT_OFFER_ATTACHED", "contract_ref", null, o.row.offer_ref,
      JSON.stringify({ spotOfferId: o.row.id, carrierCode: o.row.carrier_code, kind: o.row.kind, totalUsd: Number(o.row.total_usd) || 0,
        validUntil: o.row.valid_until, buyLines: created.length, quoteId: quote.id }), actorOf(user));
    await logAccrued(shipmentId, o.row, created);
    await logEntityEvent("spot_offer", o.row.id, "ATTACHED", null, null, null, JSON.stringify({ shipmentId, quoteId: quote.id, by: actorOf(user) }));
    return { ok: true, buyLines: created.length };
  }

  // Takes the offer off a shipment whatever its booking's state — for the escalation's rebook, which
  // has already withdrawn or superseded that booking. Its accrued BUY lines go; an offer already booked
  // on stays Booked (the record of that booking), any other goes back to Offered.
  async function releaseFromShipment(shipmentId, { reason = "", actor = "" } = {}) {
    const [shipment] = await query("SELECT id, spot_offer_id, contract_ref FROM shipments WHERE id=$1", [shipmentId]);
    if (!shipment?.spot_offer_id) return { ok: true, released: false };
    const o = await load(shipment.spot_offer_id);
    let removed = 0;
    await transaction(async tx => {
      const gone = await tx.query("DELETE FROM shipment_cost_lines WHERE shipment_id=$1 AND spot_offer_id=$2 AND type='BUY' AND COALESCE(status,'accrued')='accrued' RETURNING id",
        [shipmentId, shipment.spot_offer_id]);
      removed = gone.length;
      await tx.query("UPDATE shipments SET spot_offer_id='', contract_ref=CASE WHEN contract_ref=$1 THEN '' ELSE contract_ref END WHERE id=$2",
        [o?.row.offer_ref || "", shipmentId]);
      if (o && o.row.status !== "Booked") await tx.query("UPDATE spot_offers SET status='Offered', shipment_id='' WHERE id=$1", [o.row.id]);
    });
    await logEvent(shipmentId, "SPOT_OFFER_DETACHED", "contract_ref", o?.row.offer_ref || null, null,
      JSON.stringify({ spotOfferId: shipment.spot_offer_id, removedBuyLines: removed, reason }), actor || "CargoDesk");
    if (o) await logEntityEvent("spot_offer", o.row.id, "DETACHED", null, null, null, JSON.stringify({ shipmentId, reason }));
    return { ok: true, released: true, removedBuyLines: removed };
  }
  // The escalation books elsewhere (lib/booking-escalations.js rebook): another carrier or a Central
  // contract leaves the offer behind, and so does another departure for a digital offer (priced per
  // departure). A classic quote stays with the same carrier.
  async function releaseIfStale(shipmentRow, { carrierCode, central = false, etd = "" } = {}, opts = {}) {
    if (!shipmentRow?.spot_offer_id) return { released: false };
    const [o] = await query("SELECT * FROM spot_offers WHERE id=$1", [shipmentRow.spot_offer_id]);
    const otherDeparture = o?.kind === "digital" && o.etd && etd && String(etd).slice(0, 10) !== o.etd;
    if (!o || carrierCode !== o.carrier_code || central || otherDeparture)
      return releaseFromShipment(shipmentRow.id, { ...opts, reason: opts.reason || (central ? "booked on a contract" : carrierCode !== o?.carrier_code ? `booked with ${carrierCode}` : "another departure") });
    return { released: false };
  }

  // ─── Booking ──────────────────────────────────────────────────────────────────────────────────
  // The reference a SPOT shipment's booking request carries (DCSA contractQuotationReference), or null —
  // only an offer from the carrier the booking goes to.
  async function quotationReferenceFor(shipment) {
    if (!shipment?.spot_offer_id || shipment.contract_type !== "SPOT") return null;
    const [row] = await query("SELECT offer_ref, carrier_code FROM spot_offers WHERE id=$1", [shipment.spot_offer_id]);
    return row && row.carrier_code === shipment.carrier_code ? row.offer_ref : null;
  }
  // Before Send Booking Request: an expired digital offer blocks it, an expired classic quote warns.
  // → { block } | { warning } | {}
  async function bookingCheck(shipment) {
    if (!shipment?.spot_offer_id || shipment.contract_type !== "SPOT") return {};
    const [row] = await query("SELECT * FROM spot_offers WHERE id=$1", [shipment.spot_offer_id]);
    if (!row || row.carrier_code !== shipment.carrier_code) return {};
    if (blocksBooking(row))
      return { block: `Spot offer ${row.offer_ref} expired (${row.valid_until}): a digital offer can't be booked on once it expires. Get a fresh offer from ${row.carrier_code} and replace it.` };
    if (isExpired(row)) return { warning: `Spot offer ${row.offer_ref} expired on ${row.valid_until}: check ${row.carrier_code} still honours it` };
    return {};
  }

  // ─── Penalties (the user, 2026-10-21: a late cancel is warned and accrued as a BUY line) ──────
  // What cancelling now would cost under the offer's terms: the cancellation fee with at least the
  // notice days to go before ETD, the no-show fee inside them. Only a booking the carrier confirmed
  // carries a fee. → { fee, currency, kind, perUnit, units, daysToEtd, noticeDays, offerRef } or null.
  async function cancellationFee(shipmentId, { at = Date.now(), requireConfirmed = true } = {}) {
    const [s] = await query("SELECT id, etd, spot_offer_id FROM shipments WHERE id=$1", [shipmentId]);
    if (!s?.spot_offer_id) return null;
    const [o] = await query("SELECT * FROM spot_offers WHERE id=$1", [s.spot_offer_id]);
    if (!o) return null;
    if (requireConfirmed) {
      const [b] = await query("SELECT status FROM carrier_bookings WHERE shipment_id=$1", [shipmentId]);
      if (b?.status !== "Confirmed") return null;
    }
    const etd = String(s.etd || o.etd || "").slice(0, 10);
    const daysToEtd = DATE.test(etd) ? Math.floor((Date.parse(`${etd}T00:00:00Z`) - at) / 864e5) : null;
    const notice = o.cancellation_notice_days == null ? null : Number(o.cancellation_notice_days);
    const late = notice != null && daysToEtd != null && daysToEtd < notice;
    const cancellation = o.cancellation_fee == null ? null : Number(o.cancellation_fee);
    const noShow = o.no_show_fee == null ? null : Number(o.no_show_fee);
    const perUnit = late ? (noShow ?? cancellation) : (cancellation ?? null);
    if (perUnit == null || perUnit <= 0) return null;
    let units = 1;
    if ((o.fee_basis || "per_container") === "per_container") {
      const [{ n }] = await query("SELECT COUNT(*)::int AS n FROM containers WHERE shipment_id=$1", [shipmentId]);
      let eq = [];
      try { eq = JSON.parse(o.equipment || "[]"); } catch { eq = []; }
      units = Number(n) || eq.reduce((sum, e) => sum + (Number(e.quantity) || 0), 0) || 1;
    }
    return {
      fee: round2(perUnit * units), currency: o.fee_currency || "USD", kind: late && noShow != null ? "no_show" : "cancellation",
      perUnit, units, basis: o.fee_basis || "per_container", daysToEtd, noticeDays: notice, offerRef: o.offer_ref, carrierCode: o.carrier_code,
    };
  }
  // The carrier confirmed the cancellation of a confirmed booking: the fee is accrued on the BUY side
  // (charge "Other", the note says which fee and why). Re-billing the customer stays a manual choice.
  async function accrueCancellationFee(shipmentId, { at = Date.now(), actor = "CargoDesk" } = {}) {
    const f = await cancellationFee(shipmentId, { at, requireConfirmed: false });
    if (!f) return null;
    const [s] = await query("SELECT spot_offer_id FROM shipments WHERE id=$1", [shipmentId]);
    const label = f.kind === "no_show" ? "No-show fee" : "Cancellation fee";
    const notes = `${label} — spot offer ${f.offerRef}: ${f.units} × ${f.currency} ${f.perUnit}` +
      (f.daysToEtd != null ? ` (cancelled ${f.daysToEtd} day${f.daysToEtd === 1 ? "" : "s"} before ETD${f.noticeDays != null ? `, notice ${f.noticeDays} days` : ""})` : "");
    const usd = await toUsd(f.fee, f.currency);
    const id = `CL-${uid()}`;
    await query(`INSERT INTO shipment_cost_lines (id, shipment_id, type, charge_code, currency, amount, exchange_rate, notes, created_at, source, spot_offer_id)
      VALUES ($1,$2,'BUY','Other',$3,$4,$5,$6,$7,'spot_offer',$8)`,
      [id, shipmentId, f.currency, f.fee, f.fee > 0 ? Math.round((usd / f.fee) * 100000) / 100000 : 1, notes, nowIso(), s?.spot_offer_id || ""]);
    await logEntityEvent("cost_line", id, "IMPORTED", null, null, null, JSON.stringify({ shipmentId, chargeCode: "Other", amount: f.fee, currency: f.currency, source: "spot_offer", penalty: f.kind }));
    await logEvent(shipmentId, "SPOT_PENALTY_ACCRUED", "cost_line", null, `${f.currency} ${f.fee}`,
      JSON.stringify({ ...f, costLineId: id }), actor);
    return { ...f, costLineId: id };
  }
  // Once the carrier has the booking request, the offer is booked on (it can't move to another shipment).
  async function markBooked(shipment) {
    if (!shipment?.spot_offer_id) return;
    const changed = await query("UPDATE spot_offers SET status='Booked' WHERE id=$1 AND status<>'Booked' RETURNING id", [shipment.spot_offer_id]);
    if (changed.length)
      await logEntityEvent("spot_offer", shipment.spot_offer_id, "BOOKED", null, null, null, JSON.stringify({ shipmentId: shipment.id }));
  }

  return {
    KINDS, SOURCES, PRICE_LOCKS, BASES, TERMS,
    isExpired, blocksBooking, mapOffer, load, get, mapRows, validate,
    create, update, remove,
    attachToQuote, detachFromQuote, attachToShipment, detachFromShipment, attachOnConversion,
    releaseFromShipment, releaseIfStale,
    quotationReferenceFor, bookingCheck, markBooked, cancellationFee, accrueCancellationFee,
  };
};
