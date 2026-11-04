"use strict";
// The AI Assistant's tools (Epic TKT-IYOYA5, phase 4): a closed allowlist, each tool mapped to fixed GET
// paths of CargoDesk's own API, called as the user who asked. The answer therefore holds exactly what that
// user could open in the app (office and lane scope, the role they switched to), and every call carries
// X-CargoDesk-Agent: readonly, so lib/db.js refuses any statement that would change data, even a GET that
// writes as a side effect. Kept out on purpose: cost lines (their GET writes charge defaults), the booking
// comparison (its GET writes and calls the carrier), and anything under /internal, /share, /dcsa-sim and
// /test-tools.
//
// The browser already hides margins and charges from users without finance access; the API sends them,
// so financeView() below removes them here too before the model sees them.

const LOOKUP_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 2_000_000;   // our own API never comes near; anything bigger is refused
const MAX_RESULT_CHARS = 16_000;        // what one tool result may add to the model's context
const LIST_LIMIT_MAX = 20;

const ID_PATTERNS = {
  shipment: /^SHP-[A-Z0-9]+$/,
  contract: /^CNTR-[A-Z0-9]+$/,
  allocation: /^ALC-[A-Z0-9]+$/,
  customer: /^CUS-[A-Z0-9]+$/,
};
const ID_EXAMPLES = { shipment: "SHP-XXXXXX", contract: "CNTR-XXXXXX", allocation: "ALC-XXXXXX", customer: "CUS-XXXXXX" };
const UNLOCODE = /^[A-Z]{2}[A-Z0-9]{3}$/;
const SCAC = /^[A-Z0-9]{2,6}$/;

// Finance fields per response, removed for a user without finance access.
const SHIPMENT_FINANCE = ["marginBuyUsd", "marginSellUsd"];
const CUSTOMER_FINANCE = ["creditLimit", "creditTermsDays", "invoiceDeadlineDays", "reminderEnabled", "reminderIntervalDays",
  "billingByDay", "paymentSettlementDay"];

const omit = (obj, keys) => {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

// Empty values dropped, long strings and lists cut, so one lookup can't crowd out the conversation. A manual
// passage is at most about 2,500 characters, so the default string limit leaves those whole.
function compact(value, { maxItems = 25, maxString = 3000 } = {}) {
  const walk = v => {
    if (v === null || v === undefined || v === "") return undefined;
    if (typeof v === "string") return v.length > maxString ? v.slice(0, maxString) + "…" : v;
    if (Array.isArray(v)) {
      const items = v.slice(0, maxItems).map(walk).filter(x => x !== undefined);
      if (v.length > maxItems) items.push(`… and ${v.length - maxItems} more`);
      return items.length ? items : undefined;
    }
    if (typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) { const w = walk(x); if (w !== undefined) out[k] = w; }
      return Object.keys(out).length ? out : undefined;
    }
    return v;
  };
  return walk(value);
}
function fitResult(value) {
  let out = compact(value) ?? {};
  if (JSON.stringify(out).length > MAX_RESULT_CHARS) out = compact(value, { maxItems: 8, maxString: 400 }) ?? {};
  if (JSON.stringify(out).length > MAX_RESULT_CHARS) return { error: "That lookup returned more than can be shown; ask about something narrower" };
  return out;
}

module.exports = function createAiTools({ selfBaseUrl, getSettings, effectiveRolesFor, assistantKnowledge }) {

  // One GET to CargoDesk's own API as the user, read-only. Never throws: a refusal or a missing record
  // comes back as { error } so the model can say so, and out-of-scope reads exactly like not found.
  async function lookup(req, path, notFound) {
    const headers = { "X-CargoDesk-Agent": "readonly" };
    for (const h of ["Authorization", "X-Active-Role", "X-Office-Id"]) { const v = req.get(h); if (v) headers[h] = v; }
    let res, text;
    try {
      res = await fetch(selfBaseUrl() + path, { headers, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      text = await res.text();
    } catch (e) {
      return { error: e.name === "TimeoutError" ? "The lookup took too long" : "The lookup failed" };
    }
    if (text.length > MAX_RESPONSE_CHARS) return { error: "That lookup returned more than can be shown; ask about something narrower" };
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON: reported below */ }
    if (res.status === 404 || res.status === 403) return { error: notFound };
    if (res.status === 401) return { error: "Your session has expired; sign in again" };
    if (!res.ok) return { error: data?.error || `The lookup failed (${res.status})` };
    return { data };
  }

  async function financeView(req) {
    const settings = await getSettings();
    if (settings.finance_view_enabled === "false") return false;
    return effectiveRolesFor(req.user, req).includes("admin") || !!req.user?.canViewFinance;
  }

  const checkId = (kind, value) => {
    const id = typeof value === "string" ? value.trim().toUpperCase() : "";
    return ID_PATTERNS[kind].test(id) ? { id } : { error: `Give a ${kind} id like ${ID_EXAMPLES[kind]}` };
  };
  const shipmentPath = (id, suffix = "") => `/api/shipments/${encodeURIComponent(id)}${suffix}`;

  // One row of the shipment list: what tells shipments apart, not the whole record.
  const listRow = s => ({
    id: s.id, status: s.status, booking: s.bookingState?.label, bookingDetail: s.bookingState?.sub,
    carrierCode: s.carrierCode, pol: s.pol, pod: s.pod, etd: s.etd, eta: s.eta,
    shipperName: s.shipperName, consigneeName: s.consigneeName, teu: s.teu,
    bookingRef: s.bookingRef, blNumber: s.blNumber, vessel: s.vessel, voyage: s.voyage,
    spaceBadge: s.spaceBadge, steeringVerdict: s.steeringVerdict,
  });

  const shipmentIdProp = { id: { type: "string", description: "Shipment id, e.g. SHP-XXXXXX" } };
  const shipmentTool = (name, description, run) => ({
    name, description,
    input_schema: { type: "object", properties: shipmentIdProp, required: ["id"] },
    run: async (args, req) => {
      const { id, error } = checkId("shipment", args.id);
      return error ? { error } : run(id, req);
    },
  });
  const notFound = id => `Shipment ${id} not found`;

  const TOOLS = [
    {
      name: "search_manual",
      description: "Search CargoDesk's User Manual and functional specification. Use it for every question about how to do something in CargoDesk, what a screen, button, status, badge or rule means, or a freight term the manual explains. Returns the most relevant passages with where they come from; answer from them.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "What to look up, in plain words, e.g. \"release a House B/L\" or \"Space Exceeded badge\"" } },
        required: ["query"],
      },
      run: async (args, req, found) => {
        const q = typeof args.query === "string" ? args.query.slice(0, 500) : "";
        if (!q.trim()) return { error: "Give the search a query" };
        const { results } = await assistantKnowledge.search(q, { limit: 4 });
        // Kept for the reply's `sources`, so the user can open what the answer rests on.
        for (const r of results) found.push(r);
        if (!results.length) return { passages: [], note: "Nothing in the manual matches that search." };
        return { passages: results.map(r => ({ source: r.source, where: `${r.sectionLabel} › ${r.heading}`, text: r.text })) };
      },
    },
    shipmentTool("get_shipment",
      "A shipment's main record: status, route (POL, POD, places of receipt and delivery), carrier, ETD/ETA, vessel and voyage, parties, offices, contract, space configuration and badge, booking and B/L numbers, incoterm and terms.",
      async (id, req) => {
        const r = await lookup(req, shipmentPath(id), notFound(id));
        if (r.error) return r;
        return (await financeView(req)) ? r.data : omit(r.data, SHIPMENT_FINANCE);
      }),
    {
      name: "list_shipments",
      description: `Find shipments. Returns at most ${LIST_LIMIT_MAX} rows, each a short summary (status, booking state, route, dates, parties), plus how many match in total. Use get_shipment for one shipment's detail.`,
      input_schema: {
        type: "object",
        properties: {
          status:        { type: "string", enum: ["Draft", "Active", "Completed", "Cancelled", "Overdue"], description: "Overdue: ETD passed and not completed or cancelled" },
          booking:       { type: "string", description: "Carrier booking state as the Shipments list shows it, e.g. Not sent, Pending, Confirmed, Rejected, Escalated" },
          escalatedToMe: { type: "boolean", description: "Only bookings escalated to the user" },
          carrier:       { type: "string", description: "Carrier SCAC, e.g. MAEU" },
          pol:           { type: "string", description: "Port of loading UN/LOCODE, e.g. NLRTM" },
          pod:           { type: "string", description: "Port of discharge UN/LOCODE, e.g. USNYC" },
          search:        { type: "string", description: "Part of a shipment id, port, booking number or B/L number" },
          sort:          { type: "string", enum: ["etd_asc", "etd_desc", "eta_asc", "teu_desc", "status"] },
          limit:         { type: "integer", minimum: 1, maximum: LIST_LIMIT_MAX },
        },
        required: [],
      },
      run: async (args, req) => {
        const p = new URLSearchParams();
        const limit = Math.min(Math.max(parseInt(args.limit) || LIST_LIMIT_MAX, 1), LIST_LIMIT_MAX);
        p.set("limit", String(limit));
        if (args.status) {
          if (!["Draft", "Active", "Completed", "Cancelled", "Overdue"].includes(args.status)) return { error: "status must be Draft, Active, Completed, Cancelled or Overdue" };
          p.set("status", args.status === "Overdue" ? "_overdue" : args.status);
        }
        for (const [key, pattern, label] of [["carrier", SCAC, "a carrier SCAC like MAEU"], ["pol", UNLOCODE, "a UN/LOCODE like NLRTM"], ["pod", UNLOCODE, "a UN/LOCODE like USNYC"]]) {
          if (args[key] === undefined || args[key] === "") continue;
          const v = String(args[key]).trim().toUpperCase();
          if (!pattern.test(v)) return { error: `${key} must be ${label}` };
          p.set(key, v);
        }
        if (typeof args.booking === "string" && args.booking.trim()) p.set("booking", args.booking.trim().slice(0, 40));
        if (typeof args.search === "string" && args.search.trim()) p.set("search", args.search.trim().slice(0, 60));
        if (args.escalatedToMe === true || args.escalatedToMe === "true") p.set("escalatedToMe", "1");
        if (args.sort && ["etd_asc", "etd_desc", "eta_asc", "teu_desc", "status"].includes(args.sort)) p.set("sort", args.sort);
        const r = await lookup(req, `/api/shipments?${p}`, "No shipments found");
        if (r.error) return r;
        return { shipments: r.data.results.map(listRow), total: r.data.total, shown: r.data.results.length };
      },
    },
    shipmentTool("get_booking",
      "The carrier booking of a shipment: its state with the carrier (sent, pending, confirmed, confirmed with changes, rejected, declined), the carrier's reference and answer, and the escalation if there is one (who holds it, the carrier's offer and its changes, the history).",
      async (id, req) => {
        const [booking, escalation] = await Promise.all([
          lookup(req, shipmentPath(id, "/carrier-booking"), notFound(id)),
          lookup(req, shipmentPath(id, "/escalation"), notFound(id)),
        ]);
        if (booking.error) return booking;
        return { booking: booking.data, escalation: escalation.error ? null : escalation.data };
      }),
    shipmentTool("get_milestones",
      "A shipment's milestones in order: planned (estimated) dates, completed dates and by whom, notes, and the carrier events that completed them.",
      async (id, req) => {
        const r = await lookup(req, shipmentPath(id, "/milestones"), notFound(id));
        if (r.error) return r;
        return { milestones: r.data.map(m => omit(m, ["shipmentId", "createdAt"])) };
      }),
    shipmentTool("get_containers",
      "A shipment's containers (number, type, seals, weights, cargo) and their VGM declarations to the carrier.",
      async (id, req) => {
        const [containers, vgm] = await Promise.all([
          lookup(req, `/api/containers?shipmentId=${encodeURIComponent(id)}`, notFound(id)),
          lookup(req, shipmentPath(id, "/vgm-declarations"), notFound(id)),
        ]);
        if (containers.error) return containers;
        return { containers: containers.data, vgmDeclarations: vgm.error ? null : vgm.data };
      }),
    shipmentTool("get_house_bl",
      "A shipment's House B/L: the issued and draft versions, what still blocks issuing it (readiness) or releasing it, originals, the eBL, and how it compares with the carrier's Master B/L.",
      async (id, req) => {
        const r = await lookup(req, shipmentPath(id, "/house-bl"), notFound(id));
        if (r.error) return r;
        // Pick lists for the form, not facts about this B/L; the selling charges only with finance access.
        const drop = ["packageCodes", "handoverMethods", ...((await financeView(req)) ? [] : ["charges"])];
        return omit(r.data, drop);
      }),
    shipmentTool("get_arrival_notice",
      "The carrier's Arrival Notice for an import shipment: ETA, free time, where and how to collect the cargo, and (with finance access) its charges.",
      async (id, req) => {
        const r = await lookup(req, shipmentPath(id, "/arrival-notice"), notFound(id));
        if (r.error) return r;
        if (!r.data) return { arrivalNotice: null, note: "No arrival notice has been received for this shipment." };
        return (await financeView(req)) ? r.data : omit(r.data, ["charges"]);
      }),
    shipmentTool("get_shipping_instructions",
      "A shipment's Shipping Instructions to the carrier: state, what was sent and when, the carrier's answers, and the draft transport document.",
      async (id, req) => {
        const r = await lookup(req, shipmentPath(id, "/shipping-instructions"), notFound(id));
        if (r.error) return r;
        return r.data ?? { shippingInstructions: null, note: "No Shipping Instructions have been created for this shipment." };
      }),
    shipmentTool("get_customs_filings",
      "A shipment's customs filings (e.g. AES, ISF, ENS): type, state, references and answers.",
      async (id, req) => {
        const r = await lookup(req, shipmentPath(id, "/customs-filings"), notFound(id));
        if (r.error) return r;
        return { filings: r.data };
      }),
    shipmentTool("get_documents",
      "The documents generated or uploaded on a shipment (B/L, arrival notice, invoices and others) with their dates.",
      async (id, req) => {
        const r = await lookup(req, shipmentPath(id, "/documents"), notFound(id));
        if (r.error) return r;
        return { documents: r.data };
      }),
    shipmentTool("where_to_book",
      "Where to book a shipment: the lane, the steering line for it, and the ranked carrier options with their weekly space.",
      async (id, req) => {
        const r = await lookup(req, `/api/where-to-book?shipmentId=${encodeURIComponent(id)}`, notFound(id));
        return r.error ? r : r.data;
      }),
    {
      name: "get_contract",
      description: "A carrier contract by id (e.g. CNTR-XXXXXX): carrier, validity, container types, routings, legs and rates.",
      input_schema: { type: "object", properties: { id: { type: "string", description: "Contract id, e.g. CNTR-XXXXXX" } }, required: ["id"] },
      run: async (args, req) => {
        const { id, error } = checkId("contract", args.id);
        if (error) return { error };
        const r = await lookup(req, `/api/contracts/${encodeURIComponent(id)}`, `Contract ${id} not found`);
        return r.error ? r : r.data;
      },
    },
    {
      name: "get_allocation",
      description: "A space configuration by id (e.g. ALC-XXXXXX): the carrier, lanes, weeks, and the space booked and left in each.",
      input_schema: { type: "object", properties: { id: { type: "string", description: "Space configuration id, e.g. ALC-XXXXXX" } }, required: ["id"] },
      run: async (args, req) => {
        const { id, error } = checkId("allocation", args.id);
        if (error) return { error };
        const r = await lookup(req, `/api/allocations/${encodeURIComponent(id)}`, `Space configuration ${id} not found`);
        return r.error ? r : r.data;
      },
    },
    {
      name: "get_customer",
      description: "A customer by id (e.g. CUS-XXXXXX, as on a shipment's parties): name, address, contacts, whether it is on credit hold and why, and (with finance access) its credit terms.",
      input_schema: { type: "object", properties: { id: { type: "string", description: "Customer id, e.g. CUS-XXXXXX" } }, required: ["id"] },
      run: async (args, req) => {
        const { id, error } = checkId("customer", args.id);
        if (error) return { error };
        const r = await lookup(req, `/api/customers/${encodeURIComponent(id)}`, `Customer ${id} not found`);
        if (r.error) return r;
        return (await financeView(req)) ? r.data : omit(r.data, CUSTOMER_FINANCE);
      },
    },
  ];

  const byName = new Map(TOOLS.map(t => [t.name, t]));

  // Anthropic tool format; routes/ai.js derives the OpenAI-compatible one from it.
  const definitions = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

  // Runs one tool call. An unknown name is an error, never a fallback to anything generic.
  async function execute(name, args, req, found = []) {
    const tool = byName.get(name);
    if (!tool) return { error: `Unknown tool: ${name}` };
    try {
      return fitResult(await tool.run(args && typeof args === "object" ? args : {}, req, found));
    } catch (e) {
      return { error: `The lookup failed: ${e.message}` };
    }
  }

  return { definitions, execute };
};

module.exports.compact = compact;
