/**
 * CargoDesk AI Agent routes
 * POST /api/ai/chat  — proxy to configured LLM with CargoDesk tool definitions
 * GET  /api/ai/settings — return non-secret config for frontend
 */

module.exports = function aiRoutes(app, ctx) {
  const { db, ok, err, auth, getSettings } = ctx;

  // ─── Tool schemas exposed to the LLM ───────────────────────────────────────

  // Anthropic tool format: { name, description, input_schema }
  const TOOLS = [
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

    const requestBody = {
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools: TOOLS,
      tool_choice: { type: "auto" },   // Anthropic format
    };

    try {
      const aiRes = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(requestBody),
      });

      const data = await aiRes.json();

      if (!aiRes.ok) {
        return err(res, data?.error?.message || data?.message || `AI API error ${aiRes.status}`, aiRes.status);
      }

      // Handle tool calls (agentic loop — max 3 iterations to prevent runaway)
      let responseData = data;
      let iterations   = 0;
      let currentMessages = [...messages];

      while (
        iterations < 3 &&
        responseData.stop_reason === "tool_use" &&
        Array.isArray(responseData.content)
      ) {
        const toolUses = responseData.content.filter(b => b.type === "tool_use");
        if (!toolUses.length) break;

        // Execute all tool calls
        const toolResults = toolUses.map(tu => ({
          type:       "tool_result",
          tool_use_id: tu.id,
          content:    JSON.stringify(executeTool(tu.name, tu.input || {})),
        }));

        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: responseData.content },
          { role: "user",      content: toolResults },
        ];

        const loopRes = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "anthropic-version": "2023-06-01",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({ ...requestBody, messages: currentMessages }),
        });
        responseData = await loopRes.json();
        iterations++;
      }

      // Extract text reply
      const textBlock = (responseData.content || []).find(b => b.type === "text");
      const reply = textBlock?.text || responseData.choices?.[0]?.message?.content || "";

      ok(res, { reply, raw: responseData });
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
