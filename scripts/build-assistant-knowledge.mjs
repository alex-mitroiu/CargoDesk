#!/usr/bin/env node
// Builds data/assistant-knowledge.json: the passages the AI Assistant searches with its search_manual
// tool (Epic TKT-IYOYA5). Two sources, both written for app users:
//   - the in-app User Manual, read straight from the JSX of src/pages/UserManualPage.jsx (its `content`
//     object, one entry per manual section), plus the two sections drawn from data in src/tokens.js
//     (IMDG dangerous goods classes, Incoterms 2020);
//   - DFS.md sections 1, 2, 3, 5 and 8 (purpose, overview, roles, functional spec, glossary). Its
//     diagrams (§4), design summary (§6) and data stores (§7) are left out.
// ARCHITECTURE.md and CLAUDE.md are deliberately not read: they describe internals.
//
// Run after changing the manual or DFS.md:  npm run build:assistant-knowledge
// src/utils/assistantKnowledge.test.js fails while the committed file is out of date.
// The output is deterministic (no timestamps), so an unchanged manual gives an unchanged file.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { manualAnchor } from "../src/utils/manualAnchors.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { parse } = require("@babel/parser");
const { marked } = require("marked");

export const OUTPUT = path.join(ROOT, "data", "assistant-knowledge.json");
const MANUAL = path.join(ROOT, "src", "pages", "UserManualPage.jsx");
const TOKENS = path.join(ROOT, "src", "tokens.js");
const DFS = path.join(ROOT, "DFS.md");

const MIN_WORDS = 30;   // a passage shorter than this joins the one before it
const MAX_WORDS = 380;  // a longer one is split at line boundaries

const words = s => (s.match(/\S+/g) || []).length;
const squash = s => s.replace(/\s+/g, " ").trim();

// ── User Manual (JSX) ───────────────────────────────────────────────────────

const SKIP_ELEMENTS = new Set(["button", "IncotermsModal", "img", "SectionBtn", "GroupLabel"]);
const CALLOUT_PREFIX = { tip: "Tip: ", warn: "Warning: ", warning: "Warning: ", note: "Note: " };

const elementName = el => el.openingElement.name.type === "JSXIdentifier"
  ? el.openingElement.name.name
  : el.openingElement.name.property?.name || "";
const attr = (el, name) => el.openingElement.attributes.find(a => a.type === "JSXAttribute" && a.name.name === name)?.value;
const attrText = (el, name) => {
  const v = attr(el, name);
  if (!v) return "";
  if (v.type === "StringLiteral") return v.value;
  if (v.type === "JSXExpressionContainer") return expressionText(v.expression);
  return "";
};

function expressionText(expr) {
  if (!expr) return "";
  if (expr.type === "StringLiteral") return expr.value;
  if (expr.type === "TemplateLiteral" && expr.expressions.length === 0) return expr.quasis.map(q => q.value.cooked).join("");
  if (expr.type === "NumericLiteral") return String(expr.value);
  return "";   // anything computed (a .map(), a condition) is not prose
}

// The words of an element's children, inline (for a paragraph, a list item, a heading).
function inlineText(nodes) {
  let out = "";
  for (const n of nodes) {
    if (n.type === "JSXText") out += n.value;
    else if (n.type === "JSXExpressionContainer") out += expressionText(n.expression);
    else if (n.type === "JSXElement") {
      const name = elementName(n);
      if (name === "br") out += " ";
      else if (!SKIP_ELEMENTS.has(name)) out += inlineText(n.children);
    } else if (n.type === "JSXFragment") out += inlineText(n.children);
  }
  return out;
}

// A command block: a <div> holding nothing but a <code> element (the manual's installer lines). Those are
// not answers a freight assistant should hand out, so they stay out of its knowledge.
const isCommandBlock = el => {
  const kids = el.children.filter(c => !(c.type === "JSXText" && !c.value.trim()));
  return kids.length === 1 && kids[0].type === "JSXElement" && elementName(kids[0]) === "code";
};

// Walks a section in document order, emitting { heading } and { text } events.
function emit(node, out) {
  if (node.type === "JSXText") {
    if (node.value.trim()) out.push({ text: squash(node.value) });
    return;
  }
  if (node.type === "JSXExpressionContainer") {
    const t = expressionText(node.expression);
    if (t.trim()) out.push({ text: squash(t) });
    return;
  }
  if (node.type === "JSXFragment") { node.children.forEach(c => emit(c, out)); return; }
  if (node.type !== "JSXElement") return;
  const name = elementName(node);
  if (SKIP_ELEMENTS.has(name)) return;
  switch (name) {
    case "H2": out.push({ title: squash(inlineText(node.children)) }); return;
    case "H3": out.push({ heading: squash(inlineText(node.children)) }); return;
    case "Step": {
      const n = attrText(node, "n");
      out.push({ heading: squash(inlineText(node.children)), step: n });
      return;
    }
    case "Screenshot": {
      const caption = squash(attrText(node, "caption"));
      if (caption) out.push({ text: `(Screen: ${caption})` });
      return;
    }
    case "Callout": {
      const prefix = CALLOUT_PREFIX[attrText(node, "type") || "note"] || "Note: ";
      out.push({ text: prefix + squash(inlineText(node.children)) });
      return;
    }
    case "P": case "Dek": out.push({ text: squash(inlineText(node.children)) }); return;
    case "li": out.push({ text: "• " + squash(inlineText(node.children)) }); return;
    case "div":
      if (isCommandBlock(node)) return;
      node.children.forEach(c => emit(c, out));
      return;
    case "ul": case "ol": case "StepBody": case "figure": case "section": case "table": case "tbody": case "tr":
      node.children.forEach(c => emit(c, out));
      return;
    default: {
      // Inline elements standing on their own (a <strong> line, a <Tag>) read as a line of text.
      const t = squash(inlineText(node.children));
      if (t) out.push({ text: t });
    }
  }
}

// Literal values (arrays/objects of strings and numbers) — enough for the data tables in src/tokens.js,
// read by parsing rather than importing, so the script never depends on how Node loads that file.
function literal(node) {
  switch (node.type) {
    case "StringLiteral": case "NumericLiteral": case "BooleanLiteral": return node.value;
    case "TemplateLiteral": if (node.expressions.length === 0) return node.quasis.map(q => q.value.cooked).join(""); break;
    case "ArrayExpression": return node.elements.map(literal);
    case "ObjectExpression": return Object.fromEntries(node.properties.map(p => [p.key.name ?? p.key.value, literal(p.value)]));
  }
  throw new Error(`build-assistant-knowledge: unexpected ${node.type} in src/tokens.js data`);
}

function tokensData() {
  const ast = parse(fs.readFileSync(TOKENS, "utf8"), { sourceType: "module" });
  const data = {};
  for (const stmt of ast.program.body) {
    if (stmt.type !== "ExportNamedDeclaration" || stmt.declaration?.type !== "VariableDeclaration") continue;
    for (const d of stmt.declaration.declarations) {
      if (["IMDG_CLASSES", "INCOTERMS_2020"].includes(d.id.name)) data[d.id.name] = literal(d.init);
    }
  }
  return data;
}

// Turns a section's events into passages: a new passage at every H3 / step, tiny ones joined to the one
// before, long ones split. Each passage carries its heading for the reader and for search.
function passagesOf(events, fallbackTitle) {
  const title = events.find(e => e.title)?.title || fallbackTitle;
  const raw = [];
  // anchorHeading is the heading's own words, as the page renders them (a step without its number).
  let cur = { heading: title, anchorHeading: title, lines: [] };
  for (const e of events) {
    if (e.title) continue;
    if (e.heading) {
      if (cur.lines.length) raw.push(cur);
      cur = { heading: e.step ? `Step ${e.step}: ${e.heading}` : e.heading, anchorHeading: e.heading, lines: [] };
    } else if (e.text) cur.lines.push(e.text);
  }
  if (cur.lines.length) raw.push(cur);

  const merged = [];
  for (const p of raw) {
    const prev = merged.at(-1);
    if (prev && words(p.lines.join(" ")) < MIN_WORDS) prev.lines.push(`${p.heading}: ${p.lines.join(" ")}`);
    else merged.push({ heading: p.heading, anchorHeading: p.anchorHeading, lines: [...p.lines] });
  }

  const out = [];
  for (const p of merged) {
    let part = [], count = 0, n = 0;
    const flush = () => {
      if (!part.length) return;
      out.push({ heading: n ? `${p.heading} (continued)` : p.heading, anchorHeading: p.anchorHeading, text: part.join("\n") });
      n++; part = []; count = 0;
    };
    for (const line of p.lines) {
      if (count && count + words(line) > MAX_WORDS) flush();
      part.push(line);
      count += words(line);
    }
    flush();
  }
  return { title, passages: out };
}

function manualChunks() {
  const ast = parse(fs.readFileSync(MANUAL, "utf8"), { sourceType: "module", plugins: ["jsx"] });
  const labels = {};
  let content = null;
  (function visit(node) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclarator" && ["WALKTHROUGH", "REFERENCE"].includes(node.id?.name) && node.init?.type === "ArrayExpression") {
      for (const el of node.init.elements) {
        const o = literal(el);
        labels[o.id] = o.label;
      }
    }
    if (node.type === "VariableDeclarator" && node.id?.name === "content" && node.init?.type === "ObjectExpression") content = node.init;
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === "string") visit(v);
    }
  })(ast.program);
  if (!content) throw new Error("build-assistant-knowledge: no `content` object found in UserManualPage.jsx");

  const { IMDG_CLASSES = [], INCOTERMS_2020 = [] } = tokensData();
  const chunks = [];
  for (const prop of content.properties) {
    const section = prop.key.name ?? prop.key.value;
    const sectionLabel = (labels[section] || section).replace(/\s*⚠\s*$/, "");
    const events = [];
    emit(prop.value, events);
    const { title, passages } = passagesOf(events, sectionLabel);

    // Sections drawn from data: the passages come from the same tables the page renders.
    if (section === "dg-classes") {
      const byClass = new Map();
      for (const c of IMDG_CLASSES) {
        if (!byClass.has(c.classNum)) byClass.set(c.classNum, []);
        byClass.get(c.classNum).push(c);
      }
      for (const [classNum, entries] of byClass) {
        const heading = `Class ${classNum}: ${entries[0].name.split(" — ")[0]}`;
        passages.push({ heading, anchorHeading: title,
          text: entries.map(c => `${c.label} — ${c.name.includes(" — ") ? c.name.split(" — ")[1] : c.name}: ${c.description}`).join("\n") });
      }
    }
    if (section === "incoterms") {
      for (const t of INCOTERMS_2020) {
        passages.push({ heading: `${t.code} (${t.name})`, anchorHeading: title,
          text: [`${t.code} — ${t.name}. ${t.scope === "sea" ? "Sea and inland waterway only." : "Any transport mode."}`,
                 `Risk transfers: ${t.risk}`, `Seller: ${t.seller}`, `Buyer: ${t.buyer}`, t.notes ? `Notes: ${t.notes}` : ""]
                 .filter(Boolean).join("\n") });
      }
    }

    passages.forEach((p, i) => chunks.push({
      id: `manual:${section}:${i + 1}`,
      source: "User Manual",
      section, sectionLabel,
      heading: p.heading,
      anchor: p.anchorHeading === title ? "" : manualAnchor(p.anchorHeading),
      text: p.text,
    }));
  }
  return chunks;
}

// ── Functional spec (DFS.md) ────────────────────────────────────────────────

const KEEP_DFS = new Set(["1", "2", "3", "5", "8"]);
const plain = md => squash(md
  .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/[*_`]+/g, "")
  .replace(/<[^>]+>/g, ""));

function dfsChunks() {
  const tokens = marked.lexer(fs.readFileSync(DFS, "utf8"));
  const sections = [];
  let top = null, cur = null;
  for (const t of tokens) {
    if (t.type === "heading" && t.depth === 2) {
      top = (t.text.match(/^(\d+)\./) || [])[1] || null;
      cur = KEEP_DFS.has(top) ? { heading: plain(t.text), lines: [] } : null;
      if (cur) sections.push(cur);
      continue;
    }
    if (t.type === "heading" && t.depth >= 3) {
      cur = KEEP_DFS.has(top) ? { heading: plain(t.text), lines: [] } : null;
      if (cur) sections.push(cur);
      continue;
    }
    if (!cur) continue;
    if (t.type === "paragraph" || t.type === "text") cur.lines.push(...t.text.split(/\n(?=\*\*)/).map(plain).filter(Boolean));
    else if (t.type === "list") cur.lines.push(...t.items.map(i => "• " + plain(i.text)));
    else if (t.type === "table") {
      const head = t.header.map(h => plain(h.text));
      for (const row of t.rows) {
        const cells = row.map(c => plain(c.text));
        cur.lines.push(head.length === 2 ? `${cells[0]}: ${cells[1]}` : cells.map((c, i) => `${head[i]}: ${c}`).join("; "));
      }
    }
    // code blocks (the mermaid diagrams), html and rules are skipped
  }

  const chunks = [];
  for (const s of sections.filter(s => s.lines.length)) {
    const sectionNo = (s.heading.match(/^(\d+(?:\.\d+)?)/) || [])[1] || s.heading;
    const section = "dfs-" + sectionNo.replace(/\./g, "-");
    const isGlossary = /^8\b/.test(sectionNo);
    let part = [], count = 0, n = 0;
    const flush = () => {
      if (!part.length) return;
      // A glossary passage names its terms in the heading, so a search for a term finds it.
      const heading = isGlossary ? `Glossary: ${part.map(l => l.split(":")[0]).join(", ")}` : (n ? `${s.heading} (continued)` : s.heading);
      chunks.push({ id: `dfs:${section}:${n + 1}`, source: "Functional Spec", section, sectionLabel: s.heading,
        heading, anchor: "", text: part.join("\n") });
      n++; part = []; count = 0;
    };
    const limit = isGlossary ? 200 : MAX_WORDS;
    for (const line of s.lines) {
      if (count && count + words(line) > limit) flush();
      part.push(line);
      count += words(line);
    }
    flush();
  }
  return chunks;
}

export function buildKnowledge() {
  const chunks = [...manualChunks(), ...dfsChunks()];
  const ids = new Set();
  for (const c of chunks) {
    if (ids.has(c.id)) throw new Error(`build-assistant-knowledge: duplicate passage id ${c.id}`);
    ids.add(c.id);
  }
  return { version: 1, sources: ["src/pages/UserManualPage.jsx", "src/tokens.js", "DFS.md"], chunks };
}

export const serialize = knowledge => JSON.stringify(knowledge, null, 1) + "\n";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const knowledge = buildKnowledge();
  fs.writeFileSync(OUTPUT, serialize(knowledge));
  const bySource = knowledge.chunks.reduce((m, c) => ({ ...m, [c.source]: (m[c.source] || 0) + 1 }), {});
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)}: ${knowledge.chunks.length} passages`, bySource);
}
