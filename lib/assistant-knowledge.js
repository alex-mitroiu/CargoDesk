"use strict";
// The AI Assistant's knowledge of the manuals (Epic TKT-IYOYA5), built once as ctx.assistantKnowledge.
//
// data/assistant-knowledge.json (scripts/build-assistant-knowledge.mjs: the User Manual and DFS.md) is
// loaded into assistant_knowledge_chunks at startup whenever the file changed — the port-timezones
// pattern: a hash in app_settings (assistant_knowledge_version), only changed passages rewritten.
//
// search(question) ranks passages two ways and blends them (reciprocal rank fusion):
//   - Postgres full-text search, with the question's words OR-ed: an AND query (websearch_to_tsquery)
//     needs every word in one passage and was measured to miss plainly worded questions;
//   - meaning, by cosine similarity of embeddings from an OpenAI-compatible /v1/embeddings endpoint
//     (ai_embedding_endpoint, e.g. a local Ollama with embeddinggemma). Without one, or while it is down,
//     search is full-text alone.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = path.join(__dirname, "..", "data", "assistant-knowledge.json");
const sha1 = s => crypto.createHash("sha1").update(s).digest("hex");
const RRF_K = 60;              // reciprocal rank fusion constant (the usual value)
const CANDIDATES = 20;         // how deep each ranking goes before blending
const EMBED_BATCH = 16;
const EMBED_TIMEOUT_MS = 60_000;
const QUERY_EMBED_TIMEOUT_MS = 5_000;  // a question waits this long for its embedding, then uses text alone

// EmbeddingGemma is trained with task prefixes; other models get the plain text.
const usesGemmaPrefixes = model => /embeddinggemma/i.test(model || "");
const docInput = (model, c) => usesGemmaPrefixes(model)
  ? `title: ${c.section_label} — ${c.heading} | text: ${c.text}` : `${c.section_label} — ${c.heading}\n${c.text}`;
const queryInput = (model, q) => usesGemmaPrefixes(model) ? `task: search result | query: ${q}` : q;

module.exports = function createAssistantKnowledge({ query, getSettings }) {
  let vectorCache = null;   // { model, rows: [{ id, vec, norm }] } — rebuilt after any change

  async function syncFromFile() {
    if (!fs.existsSync(FILE)) return { skipped: "no data/assistant-knowledge.json" };
    const raw = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
    const version = sha1(raw);
    const [stored] = await query("SELECT value FROM app_settings WHERE key = 'assistant_knowledge_version'");
    if (stored?.value === version) return { unchanged: true };

    const { chunks = [] } = JSON.parse(raw);
    const existing = new Map((await query(
      "SELECT id, source, section, section_label, heading, anchor, text, text_hash FROM assistant_knowledge_chunks")).map(r => [r.id, r]));
    let written = 0;
    for (const c of chunks) {
      // text_hash covers what gets embedded, so a moved anchor doesn't cost a new embedding.
      const textHash = sha1(`${c.sectionLabel}\n${c.heading}\n${c.text}`);
      const row = existing.get(c.id);
      existing.delete(c.id);
      if (row && row.text_hash === textHash && row.source === c.source && row.section === c.section && row.anchor === c.anchor) continue;
      await query(
        `INSERT INTO assistant_knowledge_chunks (id, source, section, section_label, heading, anchor, text, text_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, section = EXCLUDED.section,
           section_label = EXCLUDED.section_label, heading = EXCLUDED.heading, anchor = EXCLUDED.anchor,
           text = EXCLUDED.text, text_hash = EXCLUDED.text_hash`,
        [c.id, c.source, c.section, c.sectionLabel, c.heading, c.anchor, c.text, textHash]);
      written++;
    }
    for (const id of existing.keys()) await query("DELETE FROM assistant_knowledge_chunks WHERE id = $1", [id]);
    await query(
      "INSERT INTO app_settings (key, value) VALUES ('assistant_knowledge_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [version]);
    vectorCache = null;
    return { passages: chunks.length, written, removed: existing.size };
  }

  // ── Embeddings ─────────────────────────────────────────────────────────────

  async function embedderConfig() {
    const s = await getSettings();
    return { endpoint: s.ai_embedding_endpoint || "", model: s.ai_embedding_model || "embeddinggemma" };
  }

  async function embed(endpoint, model, inputs, timeoutMs) {
    const res = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: inputs }), signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `embedding endpoint answered ${res.status}`);
    const vectors = (data?.data || []).sort((a, b) => a.index - b.index).map(d => d.embedding);
    if (vectors.length !== inputs.length || vectors.some(v => !Array.isArray(v) || !v.length))
      throw new Error("embedding endpoint returned an unexpected shape");
    return vectors;
  }

  let embedding = null;   // one fill at a time
  // Embeds every passage whose text or model changed since its embedding was made. Safe to call again:
  // a passage already embedded with the current text and model is skipped.
  function embedMissing() {
    if (embedding) return embedding;
    embedding = (async () => {
      const { endpoint, model } = await embedderConfig();
      if (!endpoint) return { skipped: "no embedding endpoint configured" };
      const todo = await query(
        `SELECT id, section_label, heading, text, text_hash FROM assistant_knowledge_chunks
         WHERE embedding IS NULL OR embedded_hash <> text_hash OR embedding_model <> $1 ORDER BY id`, [model]);
      let done = 0;
      for (let i = 0; i < todo.length; i += EMBED_BATCH) {
        const batch = todo.slice(i, i + EMBED_BATCH);
        const vectors = await embed(endpoint, model, batch.map(c => docInput(model, c)), EMBED_TIMEOUT_MS);
        for (let j = 0; j < batch.length; j++) {
          await query("UPDATE assistant_knowledge_chunks SET embedding = $1, embedding_model = $2, embedded_hash = $3 WHERE id = $4",
            [vectors[j], model, batch[j].text_hash, batch[j].id]);
        }
        done += batch.length;
      }
      vectorCache = null;
      return { embedded: done, model };
    })().finally(() => { embedding = null; });
    return embedding;
  }

  async function vectorsFor(model) {
    if (vectorCache?.model === model) return vectorCache.rows;
    const rows = (await query(
      `SELECT id, embedding FROM assistant_knowledge_chunks
       WHERE embedding IS NOT NULL AND embedding_model = $1 AND embedded_hash = text_hash`, [model]))
      .map(r => {
        const vec = Float32Array.from(r.embedding);
        let sum = 0;
        for (const x of vec) sum += x * x;
        return { id: r.id, vec, norm: Math.sqrt(sum) || 1 };
      });
    vectorCache = { model, rows };
    return rows;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async function textRanking(question) {
    // The question is split into words by the same parser as the passages (to_tsvector), so a term like
    // "OCC/AY" or "B/L", which Postgres keeps whole, matches; the words are then OR-ed. quote_literal
    // keeps every word a plain search term, whatever characters the question contains.
    return query(
      `WITH q AS (
         SELECT to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) AS q
         FROM unnest(to_tsvector('english', $1))
       )
       SELECT id, ts_rank_cd(tsv, q.q) AS score
       FROM assistant_knowledge_chunks, q
       WHERE q.q IS NOT NULL AND tsv @@ q.q
       ORDER BY score DESC, id LIMIT ${CANDIDATES}`, [question.slice(0, 500)]);
  }

  async function meaningRanking(question) {
    const { endpoint, model } = await embedderConfig();
    if (!endpoint) return { rows: [], used: false };
    const rows = await vectorsFor(model);
    if (!rows.length) return { rows: [], used: false };
    const [q] = await embed(endpoint, model, [queryInput(model, question)], QUERY_EMBED_TIMEOUT_MS);
    let qn = 0;
    for (const x of q) qn += x * x;
    qn = Math.sqrt(qn) || 1;
    const scored = rows.map(r => {
      let dot = 0;
      for (let i = 0; i < r.vec.length; i++) dot += r.vec[i] * q[i];
      return { id: r.id, score: dot / (r.norm * qn) };
    }).sort((a, b) => b.score - a.score).slice(0, CANDIDATES);
    return { rows: scored, used: true };
  }

  async function search(question, { limit = 4 } = {}) {
    const n = Math.max(1, Math.min(6, Number(limit) || 4));
    const text = await textRanking(String(question || ""));
    let meaning = { rows: [], used: false };
    try { meaning = await meaningRanking(String(question || "")); }
    catch (e) { console.warn("assistant-knowledge: meaning search unavailable, using text alone —", e.message); }

    const fused = new Map();
    const add = (rows) => rows.forEach((r, i) => fused.set(r.id, (fused.get(r.id) || 0) + 1 / (RRF_K + i + 1)));
    add(text);
    add(meaning.rows);
    const top = [...fused.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
    if (!top.length) return { mode: meaning.used ? "hybrid" : "text", results: [] };

    const rows = await query(
      `SELECT id, source, section, section_label, heading, anchor, text FROM assistant_knowledge_chunks WHERE id IN (${top.map((_, i) => `$${i + 1}`).join(", ")})`,
      top.map(([id]) => id));
    const byId = new Map(rows.map(r => [r.id, r]));
    return {
      mode: meaning.used ? "hybrid" : "text",
      results: top.filter(([id]) => byId.has(id)).map(([id, score]) => {
        const r = byId.get(id);
        return { id, source: r.source, section: r.section, sectionLabel: r.section_label, heading: r.heading,
          anchor: r.anchor, text: r.text, score: Number(score.toFixed(5)) };
      }),
    };
  }

  async function status() {
    const { endpoint, model } = await embedderConfig();
    const [row] = await query(
      `SELECT COUNT(*) AS passages,
              COUNT(*) FILTER (WHERE embedding IS NOT NULL AND embedding_model = $1 AND embedded_hash = text_hash) AS embedded
       FROM assistant_knowledge_chunks`, [model]);
    const [ver] = await query("SELECT value FROM app_settings WHERE key = 'assistant_knowledge_version'");
    return { passages: Number(row.passages), embedded: Number(row.embedded), embeddingModel: endpoint ? model : "",
      embeddingEndpointConfigured: !!endpoint, version: ver?.value || "", embedding: !!embedding };
  }

  return { syncFromFile, embedMissing, search, status };
};
