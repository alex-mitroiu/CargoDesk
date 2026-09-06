"use strict";
const express = require("express");
const { query, transaction } = require("./lib/db");
const { readSecret } = require("./lib/dockerSecret");

const PORT = process.env.KANBAN_SERVICE_PORT || 3007;
const SERVICE_SECRET_DEV_DEFAULT = "cargoDesk-dev-kanban-service-secret-do-not-use-in-prod";
const SERVICE_SECRET = readSecret("KANBAN_SERVICE_SECRET", SERVICE_SECRET_DEV_DEFAULT);
if (SERVICE_SECRET === SERVICE_SECRET_DEV_DEFAULT)
  console.warn("⚠  KANBAN_SERVICE_SECRET not set (checked KANBAN_SERVICE_SECRET_FILE, then KANBAN_SERVICE_SECRET) — using insecure dev default. Set it (and the same value in the monolith's own env) before deploying.");

// No zero-script-onboarding sample DB here, matching Contract Management's own precedent (not
// MDM's) — tickets/test cases are operational data an install accumulates for itself, not
// hand-curated reference data worth shipping a seed for.

const app = express();

// Crash-safety net — same fix applied to the monolith's server.js after a live stress-test found
// an unhandled route error (a bad enum value, `undefined` bound into a node:sqlite statement)
// kills this entire process, same as any other plain Express 4 app with no error handling. Every
// app.get/post/put/patch/delete handler registered from here on is wrapped so a thrown/rejected
// error reaches next(err) — and the error middleware near app.listen below — instead of crashing.
function wrapAsyncHandler(fn) {
  if (typeof fn !== "function") return fn;
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === "function") result.catch(next);
    } catch (e) { next(e); }
  };
}
for (const method of ["get", "post", "put", "patch", "delete"]) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => original(routePath, ...handlers.map(wrapAsyncHandler));
}
process.on("unhandledRejection", (reason) => console.error("⚠ Unhandled promise rejection (process kept alive):", reason));
process.on("uncaughtException", (e) => console.error("⚠ Uncaught exception (process kept alive):", e));

app.use(express.json({ limit: "5mb" }));

const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const ok = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });

// Straight port of the monolith's tickets/ticket_links/test_items/test_case_links/kb_projects/
// kb_versions/kb_columns schema (server.js), with one addition: UNIQUE(source_type, source_id) on
// tickets — a real constraint the monolith's own schema never had, backing the atomic
// POST /internal/tickets/ensure below (see ensureOpsTicket's remote branch in server.js). Most
// tickets carry source_type/source_id NULL (a person opened them by hand); both SQLite and
// Postgres treat every NULL as distinct for uniqueness purposes, so that's unaffected either way.
//
// Migrated to Postgres (ARCHITECTURE.md §13, Phase 3) — no PRAGMA needed (Postgres's
// ON DELETE CASCADE on kb_versions/kb_columns is always enforced natively), no boolean columns
// in this schema at all, so no INTEGER 0/1 conversion was needed here.
async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      section     TEXT DEFAULT '',
      description TEXT DEFAULT '',
      priority    TEXT DEFAULT 'Medium',
      status      TEXT DEFAULT 'Ready',
      position    INTEGER DEFAULT 0,
      created_at  TEXT NOT NULL,
      shipment_id TEXT DEFAULT NULL,
      type        TEXT DEFAULT 'Task',
      version     TEXT DEFAULT '',
      parent_id   TEXT DEFAULT NULL,
      assignee_id TEXT DEFAULT NULL,
      due_date    TEXT DEFAULT NULL,
      test_notes  TEXT DEFAULT NULL,
      project_id  TEXT DEFAULT NULL,
      version_id  TEXT DEFAULT NULL,
      source_type TEXT DEFAULT NULL,
      source_id   TEXT DEFAULT NULL,
      UNIQUE(source_type, source_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS ticket_links (
      id         TEXT PRIMARY KEY,
      from_id    TEXT NOT NULL,
      to_id      TEXT NOT NULL,
      link_type  TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS test_items (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      title        TEXT NOT NULL,
      description  TEXT DEFAULT '',
      priority     TEXT DEFAULT 'Medium',
      status       TEXT DEFAULT 'Ready',
      position     INTEGER DEFAULT 0,
      created_at   TEXT NOT NULL,
      shipment_id  TEXT DEFAULT NULL,
      parent_id    TEXT DEFAULT NULL,
      assignee_id  TEXT DEFAULT NULL,
      due_date     TEXT DEFAULT NULL,
      test_notes   TEXT DEFAULT NULL,
      project_id   TEXT DEFAULT NULL,
      version_id   TEXT DEFAULT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS test_case_links (
      id         TEXT PRIMARY KEY,
      case_id    TEXT NOT NULL,
      ticket_id  TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS kb_projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      key         TEXT NOT NULL,
      color       TEXT DEFAULT '#6366f1',
      description TEXT DEFAULT '',
      created_at  TEXT NOT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS kb_versions (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES kb_projects(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      description  TEXT DEFAULT '',
      status       TEXT DEFAULT 'Planning',
      release_date TEXT DEFAULT NULL,
      created_at   TEXT NOT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS kb_columns (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES kb_projects(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      color      TEXT DEFAULT '#6366f1',
      wip_limit  INTEGER DEFAULT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

// ─── Mappers — local copies of lib/mappers.js's own, minus assigneeName/assigneeInitial (this
// service owns no `users` table; the monolith attaches those after the fact via its own new
// resolveAssigneeNames() batch helper). Every other field matches the monolith's shape exactly,
// so routes/kanban.js's/testcases.js's remote branches can forward these responses unchanged. ──

const mapTicket = r => ({
  id: r.id, title: r.title, section: r.section || '', description: r.description || '',
  priority: r.priority || 'Medium', status: r.status || 'Ready', position: r.position ?? 0,
  createdAt: r.created_at, shipmentId: r.shipment_id || null, type: r.type || 'Task',
  version: r.version || '', parentId: r.parent_id || null, assigneeId: r.assignee_id || null,
  dueDate: r.due_date || null, testNotes: r.test_notes || null, projectId: r.project_id || null,
  versionId: r.version_id || null, sourceType: r.source_type || null, sourceId: r.source_id || null,
});
const mapTicketLink = r => ({ id: r.id, fromId: r.from_id, toId: r.to_id, linkType: r.link_type, createdAt: r.created_at });
const mapTestItem = r => ({
  id: r.id, type: r.type, title: r.title, description: r.description || '',
  priority: r.priority || 'Medium', status: r.status || 'Ready', position: r.position ?? 0,
  createdAt: r.created_at, shipmentId: r.shipment_id || null, parentId: r.parent_id || null,
  assigneeId: r.assignee_id || null, dueDate: r.due_date || null, testNotes: r.test_notes || null,
  projectId: r.project_id || null, versionId: r.version_id || null,
});
const mapTestCaseLink = r => ({ id: r.id, caseId: r.case_id, ticketId: r.ticket_id, createdAt: r.created_at });
const mapKbProject = r => ({ id: r.id, name: r.name, key: r.key, color: r.color || '#6366f1', description: r.description || '', createdAt: r.created_at });
const mapKbVersion = r => ({ id: r.id, projectId: r.project_id, name: r.name, description: r.description || '', status: r.status || 'Planning', releaseDate: r.release_date || null, createdAt: r.created_at });
const mapKbColumn = r => ({ id: r.id, projectId: r.project_id, name: r.name, position: r.position ?? 0, color: r.color || '#6366f1', wipLimit: r.wip_limit ?? null, createdAt: r.created_at });

// Duplicated from server.js's own INVERSE_LINK_LABEL/inverseLinkLabel — pure lookup, no DB
// dependency, cheaper to keep two tiny copies than to invent cross-process sharing for it.
const INVERSE_LINK_LABEL = { "Blocks": "Is blocked by", "Duplicates": "Is duplicated by", "Implements": "Is implemented by", "Relates to": "Relates to" };
const inverseLinkLabel = t => INVERSE_LINK_LABEL[t] || t;

const TEST_TYPES = ["Test Folder", "Test Plan", "Test Run", "Test Case"];

// Collect a test item's full descendant id set (folders/plans/runs/cases) — same in-memory tree
// walk as before, just sourced from one async query instead of a synchronous one.
async function collectDescendants(rootId) {
  const all = await query("SELECT id, parent_id FROM test_items");
  const byParent = new Map();
  for (const r of all) {
    if (!byParent.has(r.parent_id)) byParent.set(r.parent_id, []);
    byParent.get(r.parent_id).push(r.id);
  }
  const out = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    for (const childId of byParent.get(id) || []) { out.push(childId); stack.push(childId); }
  }
  return out;
}

// Public liveness check — no secret required, matches every other service's own GET /health.
app.get("/health", (req, res) => ok(res, { status: "ok", service: "kanban", uptime: process.uptime() }));

app.use("/internal", (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== SERVICE_SECRET) return err(res, "Unauthorized", 401);
  next();
});

// ─── Tickets ────────────────────────────────────────────────────────────────────────────────────

app.get("/internal/tickets", async (req, res) => {
  const { shipmentId, projectId, limit, offset } = req.query;
  let where = " WHERE 1=1";
  const params = [];
  if (shipmentId) { params.push(shipmentId); where += ` AND shipment_id=$${params.length}`; }
  if (projectId)  { params.push(projectId); where += ` AND (project_id=$${params.length} OR project_id IS NULL)`; }
  const order = " ORDER BY status, position, created_at";
  if (limit === undefined && offset === undefined) {
    const rows = await query(`SELECT * FROM tickets${where}${order}`, params);
    return ok(res, rows.map(mapTicket));
  }
  const lim = Math.min(parseInt(limit) || 50, 500), off = parseInt(offset) || 0;
  const [countRow] = await query(`SELECT COUNT(*) AS n FROM tickets${where}`, params);
  const total = Number(countRow.n);
  const rows = await query(`SELECT * FROM tickets${where}${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, lim, off]);
  ok(res, { results: rows.map(mapTicket), total, limit: lim, offset: off });
});

app.post("/internal/tickets", async (req, res) => {
  const {
    title, section = '', description = '', priority = 'Medium', status = 'Ready',
    shipmentId = null, type = 'Task', version = '',
    parentId = null, assigneeId = null, dueDate = null, testNotes = null,
    projectId = null, versionId = null,
  } = req.body || {};
  if (!title) return err(res, "title required");
  const id  = `TKT-${uid()}`;
  const [posRow] = await query("SELECT MAX(position) AS m FROM tickets WHERE status=$1", [status]);
  const pos = (posRow?.m ?? -1) + 1;
  await query(`
    INSERT INTO tickets
      (id, title, section, description, priority, status, position, created_at,
       shipment_id, type, version, parent_id, assignee_id, due_date, test_notes,
       project_id, version_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
  `, [id, title, section, description, priority, status, pos, new Date().toISOString(),
      shipmentId || null, type, version, parentId || null, assigneeId || null, dueDate || null,
      testNotes || null, projectId || null, versionId || null]);
  const [row] = await query("SELECT * FROM tickets WHERE id=$1", [id]);
  ok(res, mapTicket(row), 201);
});

// Atomic create-if-absent, backing ensureOpsTicket()'s remote branch (server.js) — replaces the
// monolith's own check-then-insert (a narrow race under concurrent sweeps) with a real
// ON CONFLICT DO NOTHING against the UNIQUE(source_type, source_id) constraint.
app.post("/internal/tickets/ensure", async (req, res) => {
  const { sourceType, sourceId, shipmentId = null, title, description = '', priority = 'Medium' } = req.body || {};
  if (!sourceType || !sourceId) return err(res, "sourceType and sourceId required");
  if (!title) return err(res, "title required");
  const id  = `TKT-${uid()}`;
  const [posRow] = await query("SELECT MAX(position) AS m FROM tickets WHERE status='Ready'");
  const pos = (posRow?.m ?? -1) + 1;
  const result = await query(`INSERT INTO tickets
    (id, title, description, priority, status, position, created_at, shipment_id, type, source_type, source_id)
    VALUES ($1,$2,$3,$4,'Ready',$5,$6,$7,'Task',$8,$9)
    ON CONFLICT (source_type, source_id) DO NOTHING RETURNING id`,
    [id, title, description, priority, pos, new Date().toISOString(), shipmentId || null, sourceType, sourceId]);
  const created = result.length > 0;
  ok(res, { created, id: created ? id : null });
});

app.put("/internal/tickets/:id", async (req, res) => {
  const [existing] = await query("SELECT * FROM tickets WHERE id=$1", [req.params.id]);
  if (!existing) return err(res, "Not found", 404);
  const {
    title = existing.title, section = existing.section ?? '', description = existing.description ?? '',
    priority = existing.priority ?? 'Medium', status = existing.status ?? 'Ready', position = existing.position ?? 0,
    shipmentId = existing.shipment_id, type = existing.type ?? 'Task', version = existing.version ?? '',
    parentId = existing.parent_id, assigneeId = existing.assignee_id, dueDate = existing.due_date,
    testNotes = existing.test_notes, projectId = existing.project_id, versionId = existing.version_id,
  } = req.body || {};
  await query(`
    UPDATE tickets
    SET title=$1, section=$2, description=$3, priority=$4, status=$5, position=$6,
        shipment_id=$7, type=$8, version=$9, parent_id=$10, assignee_id=$11, due_date=$12, test_notes=$13,
        project_id=$14, version_id=$15
    WHERE id=$16
  `, [title, section, description, priority, status, position,
      shipmentId || null, type, version, parentId || null, assigneeId || null, dueDate || null,
      testNotes || null, projectId || null, versionId || null, req.params.id]);
  const [row] = await query("SELECT * FROM tickets WHERE id=$1", [req.params.id]);
  ok(res, mapTicket(row));
});

app.delete("/internal/tickets/:id", async (req, res) => {
  const result = await query("DELETE FROM tickets WHERE id=$1 RETURNING id", [req.params.id]);
  if (result.length === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

// ─── Ticket Links ───────────────────────────────────────────────────────────────────────────────

app.get("/internal/tickets/:id/links", async (req, res) => {
  const rows = await query("SELECT * FROM ticket_links WHERE from_id=$1 OR to_id=$1", [req.params.id]);
  const result = await Promise.all(rows.map(async l => {
    const isOut   = l.from_id === req.params.id;
    const otherId = isOut ? l.to_id : l.from_id;
    const [other] = await query("SELECT id, title, status, type FROM tickets WHERE id=$1", [otherId]);
    return { ...mapTicketLink(l), direction: isOut ? "out" : "in",
      displayType: isOut ? l.link_type : inverseLinkLabel(l.link_type),
      otherTicketId: otherId, otherTicket: other || { id: otherId, title: otherId, status: "", type: "" } };
  }));
  ok(res, result);
});

app.post("/internal/tickets/:id/links", async (req, res) => {
  const { toId, linkType } = req.body || {};
  if (!toId || !linkType) return err(res, "toId and linkType required");
  const [source] = await query("SELECT id FROM tickets WHERE id=$1", [req.params.id]);
  if (!source) return err(res, "Not found", 404);
  const [target] = await query("SELECT id FROM tickets WHERE id=$1", [toId]);
  if (!target) return err(res, "Target ticket not found", 404);
  const [existingLink] = await query("SELECT id FROM ticket_links WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)", [req.params.id, toId]);
  if (existingLink) return err(res, "Link already exists");
  const id = `LNK-${uid()}`;
  await query("INSERT INTO ticket_links (id,from_id,to_id,link_type,created_at) VALUES ($1,$2,$3,$4,$5)", [id, req.params.id, toId, linkType, new Date().toISOString()]);
  ok(res, { id, fromId: req.params.id, toId, linkType }, 201);
});

app.delete("/internal/ticket-links/:id", async (req, res) => {
  const result = await query("DELETE FROM ticket_links WHERE id=$1 RETURNING id", [req.params.id]);
  if (result.length === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

// ─── Test Items ─────────────────────────────────────────────────────────────────────────────────

app.get("/internal/test-items", async (req, res) => {
  const { shipmentId, projectId } = req.query;
  let queryStr  = "SELECT * FROM test_items WHERE 1=1";
  const params = [];
  if (shipmentId) { params.push(shipmentId); queryStr += ` AND shipment_id=$${params.length}`; }
  if (projectId)  { params.push(projectId); queryStr += ` AND (project_id=$${params.length} OR project_id IS NULL)`; }
  queryStr += " ORDER BY status, position, created_at";
  const rows = await query(queryStr, params);
  ok(res, rows.map(mapTestItem));
});

app.post("/internal/test-items", async (req, res) => {
  const {
    title, type, description = "", priority = "Medium", status = "Ready",
    shipmentId = null, parentId = null, assigneeId = null, dueDate = null, testNotes = null,
    projectId = null, versionId = null,
  } = req.body || {};
  if (!title) return err(res, "title required");
  if (!TEST_TYPES.includes(type)) return err(res, `type must be one of: ${TEST_TYPES.join(", ")}`);
  const id  = `TST-${uid()}`;
  const [posRow] = await query("SELECT MAX(position) AS m FROM test_items WHERE status=$1", [status]);
  const pos = (posRow?.m ?? -1) + 1;
  await query(`
    INSERT INTO test_items
      (id, type, title, description, priority, status, position, created_at,
       shipment_id, parent_id, assignee_id, due_date, test_notes, project_id, version_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  `, [id, type, title, description, priority, status, pos, new Date().toISOString(),
      shipmentId || null, parentId || null, assigneeId || null, dueDate || null,
      testNotes || null, projectId || null, versionId || null]);
  const [row] = await query("SELECT * FROM test_items WHERE id=$1", [id]);
  ok(res, mapTestItem(row), 201);
});

app.put("/internal/test-items/:id", async (req, res) => {
  const [existing] = await query("SELECT * FROM test_items WHERE id=$1", [req.params.id]);
  if (!existing) return err(res, "Not found", 404);
  const {
    title       = existing.title,
    type        = existing.type,
    description = existing.description ?? "",
    priority    = existing.priority    ?? "Medium",
    status      = existing.status      ?? "Ready",
    position    = existing.position    ?? 0,
    shipmentId  = existing.shipment_id,
    parentId    = existing.parent_id,
    assigneeId  = existing.assignee_id,
    dueDate     = existing.due_date,
    testNotes   = existing.test_notes,
    projectId   = existing.project_id,
    versionId   = existing.version_id,
  } = req.body || {};
  if (!TEST_TYPES.includes(type)) return err(res, `type must be one of: ${TEST_TYPES.join(", ")}`);
  await query(`
    UPDATE test_items
    SET title=$1, type=$2, description=$3, priority=$4, status=$5, position=$6,
        shipment_id=$7, parent_id=$8, assignee_id=$9, due_date=$10, test_notes=$11, project_id=$12, version_id=$13
    WHERE id=$14
  `, [title, type, description, priority, status, position,
      shipmentId || null, parentId || null, assigneeId || null, dueDate || null,
      testNotes || null, projectId || null, versionId || null, req.params.id]);
  const [row] = await query("SELECT * FROM test_items WHERE id=$1", [req.params.id]);
  ok(res, mapTestItem(row));
});

app.delete("/internal/test-items/:id", async (req, res) => {
  const [existing] = await query("SELECT id FROM test_items WHERE id=$1", [req.params.id]);
  if (!existing) return err(res, "Not found", 404);
  const ids = [req.params.id, ...await collectDescendants(req.params.id)];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
  try {
    await transaction(async ({ query: q }) => {
      await q(`DELETE FROM test_case_links WHERE case_id IN (${placeholders})`, ids);
      await q(`DELETE FROM test_items WHERE id IN (${placeholders})`, ids);
    });
  } catch (e) {
    return err(res, "Delete failed", 500);
  }
  ok(res, { deleted: req.params.id, cascaded: ids.length - 1 });
});

// ─── Story Links (Test Case ↔ ticket) — both tables co-located here, the live JOIN stays fully
// server-side exactly like it does in the monolith today. ─────────────────────────────────────

app.get("/internal/test-items/:id/story-links", async (req, res) => {
  const rows = await query("SELECT * FROM test_case_links WHERE case_id=$1", [req.params.id]);
  const result = await Promise.all(rows.map(async l => {
    const [ticket] = await query("SELECT id, title, status, type FROM tickets WHERE id=$1", [l.ticket_id]);
    return { ...mapTestCaseLink(l), displayType: "Tests",
      ticket: ticket || { id: l.ticket_id, title: l.ticket_id, status: "", type: "" } };
  }));
  ok(res, result);
});

app.post("/internal/test-items/:id/story-links", async (req, res) => {
  const { ticketId } = req.body || {};
  if (!ticketId) return err(res, "ticketId required");
  const [testCase] = await query("SELECT id FROM test_items WHERE id=$1 AND type='Test Case'", [req.params.id]);
  if (!testCase) return err(res, "Test case not found", 404);
  const [ticket] = await query("SELECT id FROM tickets WHERE id=$1", [ticketId]);
  if (!ticket) return err(res, "Ticket not found", 404);
  const [existingLink] = await query("SELECT id FROM test_case_links WHERE case_id=$1 AND ticket_id=$2", [req.params.id, ticketId]);
  if (existingLink) return err(res, "Link already exists");
  const id = `TCL-${uid()}`;
  await query("INSERT INTO test_case_links (id,case_id,ticket_id,created_at) VALUES ($1,$2,$3,$4)", [id, req.params.id, ticketId, new Date().toISOString()]);
  ok(res, { id, caseId: req.params.id, ticketId }, 201);
});

app.delete("/internal/test-case-links/:id", async (req, res) => {
  const result = await query("DELETE FROM test_case_links WHERE id=$1 RETURNING id", [req.params.id]);
  if (result.length === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

app.get("/internal/tickets/:id/tested-by", async (req, res) => {
  const rows = await query("SELECT * FROM test_case_links WHERE ticket_id=$1", [req.params.id]);
  const result = await Promise.all(rows.map(async l => {
    const [testCase] = await query("SELECT id, title, status, type FROM test_items WHERE id=$1", [l.case_id]);
    return { ...mapTestCaseLink(l), displayType: "Is tested by",
      case: testCase || { id: l.case_id, title: l.case_id, status: "", type: "" } };
  }));
  ok(res, result);
});

// ─── Projects ───────────────────────────────────────────────────────────────────────────────────

app.get("/internal/kb/projects", async (req, res) => {
  const rows = await query("SELECT * FROM kb_projects ORDER BY created_at ASC");
  ok(res, rows.map(mapKbProject));
});

app.post("/internal/kb/projects", async (req, res) => {
  const { name, key = '', color = '#6366f1', description = '' } = req.body || {};
  if (!name) return err(res, "name required");
  const id  = `PRJ-${uid()}`;
  const now = new Date().toISOString();
  const keyVal = key.trim().toUpperCase() || name.slice(0, 4).toUpperCase();
  await query("INSERT INTO kb_projects (id,name,key,color,description,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, name, keyVal, color, description, now]);
  const DEFAULT_COLUMNS = [
    { name: 'Ready', color: '#6366f1' }, { name: 'In Progress', color: '#f59e0b' },
    { name: 'In Testing', color: '#06b6d4' }, { name: 'Testing Failed', color: '#ef4444' },
    { name: 'Ready to Deploy', color: '#f97316' }, { name: 'Done', color: '#22c55e' },
    { name: 'Released', color: '#8b5cf6' },
  ];
  for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
    await query("INSERT INTO kb_columns (id,project_id,name,position,color,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [`COL-${uid()}`, id, DEFAULT_COLUMNS[i].name, i, DEFAULT_COLUMNS[i].color, now]);
  }
  const [row] = await query("SELECT * FROM kb_projects WHERE id=$1", [id]);
  ok(res, mapKbProject(row), 201);
});

app.put("/internal/kb/projects/:id", async (req, res) => {
  const [existing] = await query("SELECT * FROM kb_projects WHERE id=$1", [req.params.id]);
  if (!existing) return err(res, "Not found", 404);
  const { name = existing.name, key = existing.key, color = existing.color, description = existing.description } = req.body || {};
  await query("UPDATE kb_projects SET name=$1,key=$2,color=$3,description=$4 WHERE id=$5",
    [name, key.toUpperCase(), color, description, req.params.id]);
  const [row] = await query("SELECT * FROM kb_projects WHERE id=$1", [req.params.id]);
  ok(res, mapKbProject(row));
});

app.delete("/internal/kb/projects/:id", async (req, res) => {
  const [countRow] = await query("SELECT COUNT(*) AS n FROM kb_projects");
  if (Number(countRow.n) <= 1) return err(res, "Cannot delete the last project");
  await query("DELETE FROM kb_projects WHERE id=$1", [req.params.id]);
  ok(res, { deleted: req.params.id });
});

// ─── Versions ───────────────────────────────────────────────────────────────────────────────────

app.get("/internal/kb/projects/:id/versions", async (req, res) => {
  const rows = await query("SELECT * FROM kb_versions WHERE project_id=$1 ORDER BY created_at ASC", [req.params.id]);
  ok(res, rows.map(mapKbVersion));
});

app.post("/internal/kb/projects/:id/versions", async (req, res) => {
  const [project] = await query("SELECT id FROM kb_projects WHERE id=$1", [req.params.id]);
  if (!project) return err(res, "Project not found", 404);
  const { name, description = '', status = 'Planning', releaseDate = null } = req.body || {};
  if (!name) return err(res, "name required");
  const id  = `VER-${uid()}`;
  const now = new Date().toISOString();
  await query("INSERT INTO kb_versions (id,project_id,name,description,status,release_date,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, req.params.id, name, description, status, releaseDate || null, now]);
  const [row] = await query("SELECT * FROM kb_versions WHERE id=$1", [id]);
  ok(res, mapKbVersion(row), 201);
});

app.put("/internal/kb/versions/:id", async (req, res) => {
  const [existing] = await query("SELECT * FROM kb_versions WHERE id=$1", [req.params.id]);
  if (!existing) return err(res, "Not found", 404);
  const { name = existing.name, description = existing.description, status = existing.status, releaseDate = existing.release_date } = req.body || {};
  await query("UPDATE kb_versions SET name=$1,description=$2,status=$3,release_date=$4 WHERE id=$5",
    [name, description, status, releaseDate || null, req.params.id]);
  const [row] = await query("SELECT * FROM kb_versions WHERE id=$1", [req.params.id]);
  ok(res, mapKbVersion(row));
});

app.delete("/internal/kb/versions/:id", async (req, res) => {
  const [existing] = await query("SELECT id FROM kb_versions WHERE id=$1", [req.params.id]);
  if (!existing) return err(res, "Not found", 404);
  await query("UPDATE tickets SET version_id=NULL WHERE version_id=$1", [req.params.id]);
  await query("DELETE FROM kb_versions WHERE id=$1", [req.params.id]);
  ok(res, { deleted: req.params.id });
});

// ─── Columns ────────────────────────────────────────────────────────────────────────────────────

app.get("/internal/kb/projects/:id/columns", async (req, res) => {
  const rows = await query("SELECT * FROM kb_columns WHERE project_id=$1 ORDER BY position ASC", [req.params.id]);
  ok(res, rows.map(mapKbColumn));
});

app.post("/internal/kb/projects/:id/columns", async (req, res) => {
  const [project] = await query("SELECT id FROM kb_projects WHERE id=$1", [req.params.id]);
  if (!project) return err(res, "Project not found", 404);
  const { name, color = '#6366f1', wipLimit = null } = req.body || {};
  if (!name) return err(res, "name required");
  const [maxPosRow] = await query("SELECT MAX(position) AS m FROM kb_columns WHERE project_id=$1", [req.params.id]);
  const maxPos = maxPosRow?.m ?? -1;
  const id  = `COL-${uid()}`;
  await query("INSERT INTO kb_columns (id,project_id,name,position,color,wip_limit,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, req.params.id, name, maxPos + 1, color, wipLimit, new Date().toISOString()]);
  const [row] = await query("SELECT * FROM kb_columns WHERE id=$1", [id]);
  ok(res, mapKbColumn(row), 201);
});

app.put("/internal/kb/columns/:id", async (req, res) => {
  const [existing] = await query("SELECT * FROM kb_columns WHERE id=$1", [req.params.id]);
  if (!existing) return err(res, "Not found", 404);
  const { name = existing.name, color = existing.color, position = existing.position, wipLimit = existing.wip_limit } = req.body || {};
  await query("UPDATE kb_columns SET name=$1,color=$2,position=$3,wip_limit=$4 WHERE id=$5",
    [name, color, position, wipLimit ?? null, req.params.id]);
  const [row] = await query("SELECT * FROM kb_columns WHERE id=$1", [req.params.id]);
  ok(res, mapKbColumn(row));
});

// Bulk reorder: PATCH /internal/kb/projects/:id/columns with body { order: ["COL-x", "COL-y", ...] }
app.patch("/internal/kb/projects/:id/columns", async (req, res) => {
  const { order = [] } = req.body || {};
  for (let i = 0; i < order.length; i++) {
    await query("UPDATE kb_columns SET position=$1 WHERE id=$2 AND project_id=$3", [i, order[i], req.params.id]);
  }
  const rows = await query("SELECT * FROM kb_columns WHERE project_id=$1 ORDER BY position ASC", [req.params.id]);
  ok(res, rows.map(mapKbColumn));
});

app.delete("/internal/kb/columns/:id", async (req, res) => {
  const [existing] = await query("SELECT * FROM kb_columns WHERE id=$1", [req.params.id]);
  if (!existing) return err(res, "Not found", 404);
  const [countRow] = await query("SELECT COUNT(*) AS n FROM kb_columns WHERE project_id=$1", [existing.project_id]);
  if (Number(countRow.n) <= 1) return err(res, "Cannot delete the last column");
  // Scoped to this column's own project (plus legacy pre-migration tickets with no project_id),
  // matching the monolith's own fix — a bare status=$1 alone matches any OTHER project's
  // same-named column too, since every project seeds identical default column names.
  const [ticketCountRow] = await query(
    "SELECT COUNT(*) AS n FROM tickets WHERE status=$1 AND (project_id=$2 OR project_id IS NULL)",
    [existing.name, existing.project_id]
  );
  const ticketCount = Number(ticketCountRow.n);
  if (ticketCount > 0) return err(res, `Column has ${ticketCount} ticket(s) — move them first`);
  await query("DELETE FROM kb_columns WHERE id=$1", [req.params.id]);
  ok(res, { deleted: req.params.id });
});

// Bulk import for the one-time migration script (scripts/migrate-kanban-to-service.js) — one
// payload with a per-table array of raw snake_case rows (as read directly off the monolith's own
// tables), inserted with ON CONFLICT DO NOTHING so a re-run against an already-migrated target
// doesn't blow up on the primary-key collision. Every one of these 7 tables uses its own original
// id as primary key (not a natural business key like MDM's carrier/vessel codes), so DO NOTHING
// on id is exactly "already migrated this row, skip it" — same semantics, different key shape.
// Order matters here for the tables with real FKs (kb_versions/kb_columns -> kb_projects) —
// projects are inserted first, same as the request payload's own field order below.
app.post("/internal/kanban/bulk-import", async (req, res) => {
  const { kbProjects = [], kbVersions = [], kbColumns = [], tickets = [], ticketLinks = [],
          testItems = [], testCaseLinks = [] } = req.body || {};
  const counts = {};
  const run = async ({ query: q }, label, table, cols, rows) => {
    let n = 0;
    for (const r of rows) {
      try {
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
        const result = await q(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING RETURNING id`,
          cols.map(c => r[c] ?? null));
        n += result.length;
      } catch { /* skip malformed row */ }
    }
    counts[label] = n;
  };
  try {
    await transaction(async (client) => {
      await run(client, "kbProjects", "kb_projects", ["id", "name", "key", "color", "description", "created_at"], kbProjects);
      await run(client, "kbVersions", "kb_versions", ["id", "project_id", "name", "description", "status", "release_date", "created_at"], kbVersions);
      await run(client, "kbColumns", "kb_columns", ["id", "project_id", "name", "position", "color", "wip_limit", "created_at"], kbColumns);
      await run(client, "tickets", "tickets", ["id", "title", "section", "description", "priority", "status", "position", "created_at",
        "shipment_id", "type", "version", "parent_id", "assignee_id", "due_date", "test_notes", "project_id", "version_id",
        "source_type", "source_id"], tickets);
      await run(client, "ticketLinks", "ticket_links", ["id", "from_id", "to_id", "link_type", "created_at"], ticketLinks);
      await run(client, "testItems", "test_items", ["id", "type", "title", "description", "priority", "status", "position", "created_at",
        "shipment_id", "parent_id", "assignee_id", "due_date", "test_notes", "project_id", "version_id"], testItems);
      await run(client, "testCaseLinks", "test_case_links", ["id", "case_id", "ticket_id", "created_at"], testCaseLinks);
    });
  } catch (e) { return err(res, e.message, 500); }
  ok(res, { inserted: counts }, 201);
});

// Error-handling middleware — must be registered after every route above. Malformed JSON bodies
// get a clean 400 instead of body-parser's raw HTML/stack-trace page; anything else forwarded via
// wrapAsyncHandler is logged in full server-side and answered with a generic 500 (never the raw
// error/stack to the caller).
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({ error: "Malformed request body — expected valid JSON" });
  }
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, error);
  res.status(error?.status || 500).json({ error: "Internal server error" });
});

if (require.main === module) {
  initSchema()
    .then(() => {
      app.listen(PORT, () => console.log(`🗂️  Kanban Service running on http://localhost:${PORT}`));
    })
    .catch(e => { console.error("Failed to initialize database schema:", e); process.exit(1); });
}

module.exports = { app, initSchema };
