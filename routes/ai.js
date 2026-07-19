/**
 * CargoDesk AI Agent routes
 * POST /api/ai/chat  — proxy to configured LLM with CargoDesk tool definitions
 * GET  /api/ai/settings — return non-secret config for frontend
 */

module.exports = function aiRoutes(app, ctx) {
  const { db, ok, err, auth, getSettings } = ctx;

  // ─── Tool schemas exposed to the LLM ───────────────────────────────────────
  // Anthropic tool format: { name, description, input_schema }. This is the
  // source of truth — TOOLS_OPENAI below is derived from it for OpenAI-
  // compatible endpoints (OpenRouter, Custom/Local presets in AppSettingsPage),
  // which expect { type: "function", function: { name, description, parameters } }.

  const TOOLS_ANTHROPIC = [
    {
      name: "get_shipment",
      description: "Retrieve a single CargoDesk shipment by its ID (e.g. SHP-XXXXX). Returns full shipment detail including status, POL, POD, carrier, containers, cost lines totals.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Shipment ID, e.g. SHP-ABC12" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_shipments",
      description: "List shipments with optional filters. Returns up to 50 results.",
      input_schema: {
        type: "object",
        properties: {
          status:      { type: "string", description: "Filter by status: Active, Draft, Completed, Cancelled" },
          carrierCode: { type: "string", description: "Filter by carrier SCAC code, e.g. MAEU" },
          pol:         { type: "string", description: "Filter by port of loading UNLOCODE, e.g. CNSHA" },
          pod:         { type: "string", description: "Filter by port of discharge UNLOCODE, e.g. DEHAM" },
        },
        required: [],
      },
    },
    {
      name: "get_contract",
      description: "Get a carrier contract by ID, including its legs and rates.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Contract ID, e.g. CON-XXXXX" },
        },
        required: ["id"],
      },
    },
    {
      name: "get_allocation",
      description: "Get a space allocation / configuration by ID.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Allocation ID, e.g. ALC-XXXXX" },
        },
        required: ["id"],
      },
    },
  ];

  const TOOLS_OPENAI = TOOLS_ANTHROPIC.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  // Anthropic's Messages API lives at api.anthropic.com — every other configured
  // endpoint (OpenRouter, a local proxy, any other Custom preset) is treated as
  // OpenAI-compatible Chat Completions, matching the two non-Anthropic presets
  // AppSettingsPage's AI Agent tab actually offers today.
  const isAnthropicEndpoint = ep => /anthropic\.com/i.test(ep || "");

  // ─── Tool execution (server-side tool calls) ────────────────────────────────

  function executeTool(name, args) {
    try {
      if (name === "get_shipment") {
        const row = db.prepare(
          `SELECT s.*, p1.name AS pol_name, p2.name AS pod_name FROM shipments s
           LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
           LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
           WHERE s.id=?`
        ).get(args.id);
        if (!row) return { error: `Shipment ${args.id} not found` };
        const ctrs = db.prepare("SELECT COUNT(*) AS n FROM containers WHERE shipment_id=?").get(args.id);
        return { ...row, containerCount: ctrs?.n ?? 0 };
      }
      if (name === "list_shipments") {
        let q = `SELECT s.*, p1.name AS pol_name, p2.name AS pod_name FROM shipments s
                 LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
                 LEFT JOIN port_locations p2 ON p2.unlocode = s.pod WHERE 1=1`;
        const params = [];
        if (args.status)      { q += " AND s.status=?";       params.push(args.status); }
        if (args.carrierCode) { q += " AND s.carrier_code=?"; params.push(args.carrierCode); }
        if (args.pol)         { q += " AND s.pol=?";          params.push(args.pol.toUpperCase()); }
        if (args.pod)         { q += " AND s.pod=?";          params.push(args.pod.toUpperCase()); }
        q += " ORDER BY s.created_at DESC LIMIT 50";
        return { shipments: db.prepare(q).all(...params), count: db.prepare(q.replace("SELECT s.*", "SELECT COUNT(*) AS n")).get(...params)?.n };
      }
      if (name === "get_contract") {
        const row = db.prepare("SELECT * FROM contracts WHERE id=?").get(args.id);
        if (!row) return { error: `Contract ${args.id} not found` };
        const legs  = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(args.id);
        const rates = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(args.id);
        return { ...row, legs, rates };
      }
      if (name === "get_allocation") {
        const row = db.prepare("SELECT * FROM allocations WHERE id=?").get(args.id);
        if (!row) return { error: `Allocation ${args.id} not found` };
        return row;
      }
      return { error: `Unknown tool: ${name}` };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ─── Provider-specific request/response shaping ─────────────────────────────
  // Anthropic (Messages API) and OpenAI-compatible (Chat Completions) diverge on
  // every part of the tool-calling contract: request shape, stop condition, tool
  // call extraction, follow-up message shape, and reply extraction. Branching
  // once per concern here (rather than threading isAnthropic through the whole
  // handler ad hoc) keeps each provider's shape in one place.

  function buildRequest(isAnthropic, { model, systemPrompt, messages }) {
    if (isAnthropic) {
      return {
        body: { model, max_tokens: 1024, system: systemPrompt, messages, tools: TOOLS_ANTHROPIC, tool_choice: { type: "auto" } },
        headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": undefined /* set by caller */ },
      };
    }
    return {
      body: { model, max_tokens: 1024, messages: [{ role: "system", content: systemPrompt }, ...messages], tools: TOOLS_OPENAI, tool_choice: "auto" },
      headers: { "Content-Type": "application/json", "Authorization": undefined /* set by caller */ },
    };
  }

  const isToolUseStop = (isAnthropic, data) => isAnthropic
    ? data?.stop_reason === "tool_use" && Array.isArray(data?.content)
    : data?.choices?.[0]?.finish_reason === "tool_calls" && Array.isArray(data?.choices?.[0]?.message?.tool_calls);

  // Normalises both providers' tool-call shapes to a common { id, name, args } list.
  const extractToolCalls = (isAnthropic, data) => isAnthropic
    ? data.content.filter(b => b.type === "tool_use").map(tu => ({ id: tu.id, name: tu.name, args: tu.input || {} }))
    : data.choices[0].message.tool_calls.map(tc => ({ id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") }));

  // Appends the assistant's tool-call turn plus the tool results, in whichever
  // shape the provider expects, to build the next request's messages array.
  function appendToolResults(isAnthropic, currentMessages, data, toolCalls, results) {
    if (isAnthropic) {
      const toolResults = toolCalls.map((tc, i) => ({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify(results[i]) }));
      return [...currentMessages, { role: "assistant", content: data.content }, { role: "user", content: toolResults }];
    }
    return [
      ...currentMessages,
      data.choices[0].message,
      ...toolCalls.map((tc, i) => ({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(results[i]) })),
    ];
  }

  const extractReply = (isAnthropic, data) => isAnthropic
    ? (data.content || []).find(b => b.type === "text")?.text || ""
    : data.choices?.[0]?.message?.content || "";

  // ─── POST /api/ai/chat ──────────────────────────────────────────────────────

  app.post("/api/ai/chat", auth(), async (req, res) => {
    const settings = getSettings();
    if (settings.ai_agent_enabled !== '1') {
      return err(res, "AI agent is disabled. Enable it in Application Settings → AI Agent.", 403);
    }

    const endpoint = settings.ai_endpoint || '';
    const model    = settings.ai_model    || 'claude-haiku-4-5-20251001';
    const apiKey   = settings.ai_api_key  || '';

    if (!endpoint || !apiKey) {
      return err(res, "AI endpoint or API key not configured. Set them in Application Settings → AI Agent.", 503);
    }

    const { messages = [], context = {} } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return err(res, "messages array is required");
    }

    const systemParts = [
      settings.ai_system_prompt ||
        "You are CargoDesk AI — an intelligent assistant for freight and logistics operations. Help users understand shipment status, contract rates, space allocations, and operational insights. Be concise and accurate.",
    ];
    if (context.shipmentId) {
      systemParts.push(`\nCurrent context: the user is viewing shipment ${context.shipmentId}. Use get_shipment("${context.shipmentId}") to retrieve its details when relevant.`);
    }
    const systemPrompt = systemParts.join("\n");

    const isAnthropic = isAnthropicEndpoint(endpoint);
    const { body: requestBody, headers: baseHeaders } = buildRequest(isAnthropic, { model, systemPrompt, messages });
    const headers = isAnthropic
      ? { ...baseHeaders, "x-api-key": apiKey }
      : { ...baseHeaders, "Authorization": `Bearer ${apiKey}` };

    try {
      const aiRes = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(requestBody) });
      const data = await aiRes.json();

      if (!aiRes.ok) {
        return err(res, data?.error?.message || data?.message || `AI API error ${aiRes.status}`, aiRes.status);
      }

      // Handle tool calls (agentic loop — max 3 iterations to prevent runaway)
      let responseData = data;
      let iterations   = 0;
      let currentMessages = [...messages];

      while (iterations < 3 && isToolUseStop(isAnthropic, responseData)) {
        const toolCalls = extractToolCalls(isAnthropic, responseData);
        if (!toolCalls.length) break;

        const results = toolCalls.map(tc => executeTool(tc.name, tc.args));
        currentMessages = appendToolResults(isAnthropic, currentMessages, responseData, toolCalls, results);

        const loopRes = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...requestBody, messages: currentMessages }),
        });
        responseData = await loopRes.json();
        iterations++;
      }

      ok(res, { reply: extractReply(isAnthropic, responseData), raw: responseData });
    } catch (e) {
      err(res, `AI proxy error: ${e.message}`, 502);
    }
  });

  // ─── GET /api/ai/settings — safe (non-secret) config for frontend ───────────

  app.get("/api/ai/settings", auth(), (req, res) => {
    const settings = getSettings();
    ok(res, {
      enabled:  settings.ai_agent_enabled === '1',
      endpoint: settings.ai_endpoint || '',
      model:    settings.ai_model    || '',
      hasKey:   !!(settings.ai_api_key),
      systemPrompt: settings.ai_system_prompt || '',
    });
  });
};
