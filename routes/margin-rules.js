"use strict";

// Margin rules (SPOT rates phase 4; plan https://claude.ai/artifact/Y61PAmXZfgFxTLtpt7GiAZ, decisions
// 2026-10-21). The margin a quote adds on top of what was bought, by customer, trade lane and
// container — Master Data → Margin Rules, maintained by admins and Trade Managers (like Lane Steering),
// readable by everyone. The most specific valid rule applies: the customer's own on the lane and
// container, then the customer's for any lane, then everyone's on the lane, then everyone's default.
// A rule suggests the sell price and sets the minimum a quote is checked against; it never blocks.
//
//   kind fixed:   `value` USD per container, added to the ocean freight; other charges at cost
//   kind percent: `value`% added to every charge
//   min_margin_pct: the margin (sell − buy, as % of sell) below which a quote is flagged

module.exports = function marginRulesRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, logEntityEvent } = ctx;
  const write = requireRole(["admin", "trade_manager"]);
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const nowIso = () => new Date().toISOString();

  const mapRule = r => ({
    id: r.id, customerId: r.customer_id || "", customerName: r.customer_name || "",
    originLane: r.origin_lane || "", destLane: r.dest_lane || "", containerType: r.container_type || "",
    kind: r.kind, value: Number(r.value) || 0, minMarginPct: r.min_margin_pct == null ? null : Number(r.min_margin_pct),
    validFrom: r.valid_from || "", validTo: r.valid_to || "",
    isDefault: !r.customer_id && !r.origin_lane && !r.dest_lane && !r.container_type,
    createdAt: r.created_at, createdBy: r.created_by || "", updatedAt: r.updated_at || null, updatedBy: r.updated_by || "",
  });

  async function validate(body) {
    const b = body || {};
    const customerId = String(b.customerId || "").trim(), customerName = customerId ? String(b.customerName || "").trim() : "";
    const originLane = String(b.originLane || "").trim().toUpperCase(), destLane = String(b.destLane || "").trim().toUpperCase();
    if (!!originLane !== !!destLane) return { error: "Give both trades of the lane, or neither (any lane)" };
    if (originLane) {
      const known = new Set((await query("SELECT code FROM trade_lanes")).map(r => r.code));
      for (const code of [originLane, destLane]) if (!known.has(code)) return { error: `Unknown trade lane ${code}` };
    }
    const containerType = String(b.containerType || "").trim().toUpperCase();
    if (containerType && !/^\d{2}[A-Z0-9]{2}$/.test(containerType)) return { error: `Container type "${b.containerType}" isn't a type code such as 40HC` };
    const kind = b.kind === "fixed" ? "fixed" : b.kind === "percent" ? "percent" : null;
    if (!kind) return { error: "The margin is fixed (USD per container) or percent (of the buy)" };
    const value = Number(b.value);
    if (!Number.isFinite(value) || value < 0 || (kind === "percent" && value > 500)) return { error: "Enter the margin" };
    let minMarginPct = null;
    if (b.minMarginPct !== undefined && b.minMarginPct !== null && b.minMarginPct !== "") {
      minMarginPct = Number(b.minMarginPct);
      if (!Number.isFinite(minMarginPct) || minMarginPct < 0 || minMarginPct >= 100) return { error: "The minimum margin is a percentage from 0 to 99" };
    }
    const validFrom = String(b.validFrom || "").slice(0, 10), validTo = String(b.validTo || "").slice(0, 10);
    if ((validFrom && !DATE.test(validFrom)) || (validTo && !DATE.test(validTo))) return { error: "Dates are YYYY-MM-DD" };
    if (validFrom && validTo && validTo < validFrom) return { error: "Valid to must be on or after valid from" };
    return { value: { customerId, customerName, originLane, destLane, containerType, kind, value: Math.round(value * 100) / 100, minMarginPct, validFrom, validTo } };
  }
  async function clash(v, excludeId = null) {
    const rows = await query(`SELECT * FROM margin_rules WHERE customer_id=$1 AND origin_lane=$2 AND dest_lane=$3 AND container_type=$4 ${excludeId ? "AND id<>$5" : ""}`,
      excludeId ? [v.customerId, v.originLane, v.destLane, v.containerType, excludeId] : [v.customerId, v.originLane, v.destLane, v.containerType]);
    const overlaps = r => (!v.validTo || !r.valid_from || r.valid_from <= v.validTo) && (!v.validFrom || !r.valid_to || r.valid_to >= v.validFrom);
    return rows.find(overlaps) || null;
  }

  // The rule for a customer, lane and container on a date (blank → any), most specific first. → rule | null
  async function ruleFor({ customerId = "", originLane = "", destLane = "", containerType = "", date = "" }) {
    const day = DATE.test(date) ? date : nowIso().slice(0, 10);
    const rows = await query(`SELECT * FROM margin_rules WHERE (customer_id='' OR customer_id=$1)
        AND ((origin_lane='' AND dest_lane='') OR (origin_lane=$2 AND dest_lane=$3))
        AND (container_type='' OR container_type=$4)
        AND (valid_from='' OR valid_from<=$5) AND (valid_to='' OR valid_to>=$5)`,
      [customerId || "", originLane || "", destLane || "", containerType || "", day]);
    const score = r => (r.customer_id ? 100 : 0) + (r.origin_lane ? 10 : 0) + (r.container_type ? 1 : 0);
    rows.sort((a, b) => score(b) - score(a) || String(b.created_at).localeCompare(String(a.created_at)));
    return rows.length ? mapRule(rows[0]) : null;
  }

  // A quote's margin against its spot offer and the rule that applies. → null when it has no offer.
  async function quoteMargin(quote) {
    if (!quote?.spot_offer_id) return null;
    const offer = await ctx.spotOffers.get(quote.spot_offer_id);
    if (!offer) return null;
    const lines = await query("SELECT * FROM quote_lines WHERE quote_id=$1", [quote.id]);
    const sellUsd = Math.round(lines.reduce((s, l) => s + (Number(l.amount_usd) || 0), 0) * 100) / 100;
    const buyUsd = offer.totalUsd;
    const marginUsd = Math.round((sellUsd - buyUsd) * 100) / 100;
    const marginPct = sellUsd > 0 ? Math.round((marginUsd / sellUsd) * 1000) / 10 : null;
    const containerType = offer.equipment?.length === 1 ? offer.equipment[0].containerType : "";
    const rule = await ruleFor({ customerId: quote.customer_id || "", originLane: ctx.longestLane?.(quote.pol) || "", destLane: ctx.longestLane?.(quote.pod) || "",
      containerType, date: String(quote.cargo_ready_date || "").slice(0, 10) });
    const belowMinimum = !!(rule && rule.minMarginPct != null && marginPct != null && marginPct < rule.minMarginPct);
    return { buyUsd, sellUsd, marginUsd, marginPct, rule, belowMinimum };
  }
  ctx.marginRuleFor = ruleFor;
  ctx.quoteMargin = quoteMargin;

  app.get("/api/margin-rules", async (req, res) => {
    const rows = await query("SELECT * FROM margin_rules ORDER BY (customer_id='') ASC, customer_name, origin_lane, container_type, created_at");
    ok(res, rows.map(mapRule));
  });

  // Before /:id. The rule for ?customerId&pol&pod (or originLane&destLane)&containerType&date.
  app.get("/api/margin-rules/resolve", async (req, res) => {
    const q = req.query || {};
    const originLane = String(q.originLane || ctx.longestLane?.(String(q.pol || "").toUpperCase()) || "");
    const destLane = String(q.destLane || ctx.longestLane?.(String(q.pod || "").toUpperCase()) || "");
    ok(res, await ruleFor({ customerId: String(q.customerId || ""), originLane, destLane, containerType: String(q.containerType || "").toUpperCase(), date: String(q.date || "") }));
  });

  app.post("/api/margin-rules", write, async (req, res) => {
    const v = await validate(req.body);
    if (v.error) return err(res, v.error);
    const other = await clash(v.value);
    if (other) return err(res, `A rule for the same customer, lane and container already covers those dates (${other.valid_from || "always"} – ${other.valid_to || "open"})`, 409);
    const id = `MGR-${uid()}`, actor = req.user?.name || req.user?.email || "";
    const x = v.value;
    await query(`INSERT INTO margin_rules (id, customer_id, customer_name, origin_lane, dest_lane, container_type, kind, value, min_margin_pct, valid_from, valid_to, created_at, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, x.customerId, x.customerName, x.originLane, x.destLane, x.containerType, x.kind, x.value, x.minMarginPct, x.validFrom, x.validTo, nowIso(), actor]);
    await logEntityEvent("margin_rule", id, "CREATED", null, null, null, JSON.stringify({ ...x, by: actor }));
    const [row] = await query("SELECT * FROM margin_rules WHERE id=$1", [id]);
    ok(res, mapRule(row), 201);
  });

  app.put("/api/margin-rules/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM margin_rules WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Margin rule not found", 404);
    const v = await validate(req.body);
    if (v.error) return err(res, v.error);
    const other = await clash(v.value, existing.id);
    if (other) return err(res, `A rule for the same customer, lane and container already covers those dates (${other.valid_from || "always"} – ${other.valid_to || "open"})`, 409);
    const x = v.value, actor = req.user?.name || req.user?.email || "";
    await query(`UPDATE margin_rules SET customer_id=$1, customer_name=$2, origin_lane=$3, dest_lane=$4, container_type=$5, kind=$6, value=$7, min_margin_pct=$8,
        valid_from=$9, valid_to=$10, updated_at=$11, updated_by=$12 WHERE id=$13`,
      [x.customerId, x.customerName, x.originLane, x.destLane, x.containerType, x.kind, x.value, x.minMarginPct, x.validFrom, x.validTo, nowIso(), actor, existing.id]);
    await logEntityEvent("margin_rule", existing.id, "UPDATED", null, null, null, JSON.stringify({ ...x, by: actor }));
    const [row] = await query("SELECT * FROM margin_rules WHERE id=$1", [existing.id]);
    ok(res, mapRule(row));
  });

  app.delete("/api/margin-rules/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM margin_rules WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Margin rule not found", 404);
    await query("DELETE FROM margin_rules WHERE id=$1", [existing.id]);
    await logEntityEvent("margin_rule", existing.id, "DELETED", null, null, null, JSON.stringify({ by: req.user?.name || req.user?.email || "" }));
    ok(res, { deleted: existing.id });
  });

  // The quote's margin against its spot offer and rule (null without a spot offer).
  app.get("/api/quotes/:id/margin", async (req, res) => {
    const [q] = await query("SELECT * FROM quotes WHERE id=$1", [req.params.id]);
    if (!q) return err(res, "Not found", 404);
    if (!(await ctx.applyOfficeScopedAccessFilter([ctx.mapQuote(q)], req.user, req)).length) return err(res, "Not found", 404);
    ok(res, await quoteMargin(q));
  });
};
