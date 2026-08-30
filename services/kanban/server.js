"use strict";
const express = require("express");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { readSecret } = require("./lib/dockerSecret");

const PORT = process.env.KANBAN_SERVICE_PORT || 3007;
const SERVICE_SECRET_DEV_DEFAULT = "cargoDesk-dev-kanban-service-secret-do-not-use-in-prod";
const SERVICE_SECRET = readSecret("KANBAN_SERVICE_SECRET", SERVICE_SECRET_DEV_DEFAULT);
if (SERVICE_SECRET === SERVICE_SECRET_DEV_DEFAULT)
  console.warn("⚠  KANBAN_SERVICE_SECRET not set (checked KANBAN_SERVICE_SECRET_FILE, then KANBAN_SERVICE_SECRET) — using insecure dev default. Set it (and the same value in the monolith's own env) before deploying.");

// No zero-script-onboarding sample DB here, matching Contract Management's own precedent (not
// MDM's) — tickets/test cases are operational data an install accumulates for itself, not
// hand-curated reference data worth shipping a seed for.
const DB_PATH = path.join(__dirname, "kanban.db");

const app = express();
const db = new DatabaseSync(DB_PATH);

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
// tickets — a real constraint the monolith's own schema never had, backing the new atomic
// POST /internal/tickets/ensure below (see ensureOpsTicket's remote branch in server.js). Most
// tickets carry source_type/source_id NULL (a person opened them by hand); SQLite treats every
// NULL as distinct for uniqueness purposes, so that's unaffected by the new constraint.
db.exec(`
  PRAGMA journal_mode=WAL;

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
  );

  CREATE TABLE IF NOT EXISTS ticket_links (
    id         TEXT PRIMARY KEY,
    from_id    TEXT NOT NULL,
    to_id      TEXT NOT NULL,
    link_type  TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

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
  );

  CREATE TABLE IF NOT EXISTS test_case_links (
    id         TEXT PRIMARY KEY,
    case_id    TEXT NOT NULL,
    ticket_id  TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kb_projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    key         TEXT NOT NULL,
    color       TEXT DEFAULT '#6366f1',
    description TEXT DEFAULT '',
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kb_versions (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES kb_projects(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    status       TEXT DEFAULT 'Planning',
    release_date TEXT DEFAULT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kb_columns (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES kb_projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    color      TEXT DEFAULT '#6366f1',
    wip_limit  INTEGER DEFAULT NULL,
    created_at TEXT NOT NULL
  );
`);

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

// Collect a test item's full descendant id set (folders/plans/runs/cases) — verbatim port.
const collectDescendants = (rootId) => {
  const all = db.prepare("SELECT id, parent_id FROM test_items").all();
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
};

// Public liveness check — no secret required, matches every other service's own GET /health.
app.get("/health", (req, res) => ok(res, { status: "ok", service: "kanban", uptime: process.uptime() }));

app.use("/internal", (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== SERVICE_SECRET) return err(res, "Unauthorized", 401);
  next();
});

// ─── Tickets ────────────────────────────────────────────────────────────────────────────────────

app.get("/internal/tickets", (req, res) => {
  const { shipmentId, projectId, limit, offset } = req.query;
  let where = " WHERE 1=1";
  const params = [];
  if (shipmentId) { where += " AND shipment_id=?"; params.push(shipmentId); }
  if (projectId)  { where += " AND (project_id=? OR project_id IS NULL)"; params.push(projectId); }
  const order = " ORDER BY status, position, created_at";
  if (limit === undefined && offset === undefined) {
    return ok(res, db.prepare(`SELECT * FROM tickets${where}${order}`).all(...params).map(mapTicket));
  }
  const lim = Math.min(parseInt(limit) || 50, 500), off = parseInt(offset) || 0;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM tickets${where}${order} LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows.map(mapTicket), total, limit: lim, offset: off });
});

app.post("/internal/tickets", (req, res) => {
  const {
    title, section = '', description = '', priority = 'Medium', status = 'Ready',
    shipmentId = null, type = 'Task', version = '',
    parentId = null, assigneeId = null, dueDate = null, testNotes = null,
    projectId = null, versionId = null,
  } = req.body || {};
  if (!title) return err(res, "title required");
  const id  = `TKT-${uid()}`;
  const pos = (db.prepare("SELECT MAX(position) AS m FROM tickets WHERE status=?").get(status)?.m ?? -1) + 1;
  db.prepare(`
    INSERT INTO tickets
      (id, title, section, description, priority, status, position, created_at,
       shipment_id, type, version, parent_id, assignee_id, due_date, test_notes,
       project_id, version_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, title, section, description, priority, status, pos, new Date().toISOString(),
         shipmentId || null, type, version, parentId || null, assigneeId || null, dueDate || null,
         testNotes || null, projectId || null, versionId || null);
  ok(res, mapTicket(db.prepare("SELECT * FROM tickets WHERE id=?").get(id)), 201);
});

// Atomic create-if-absent, backing ensureOpsTicket()'s remote branch (server.js) — replaces the
// monolith's own check-then-insert (a narrow race under concurrent sweeps) with a real
// INSERT OR IGNORE against the new UNIQUE(source_type, source_id) constraint.
app.post("/internal/tickets/ensure", (req, res) => {
  const { sourceType, sourceId, shipmentId = null, title, description = '', priority = 'Medium' } = req.body || {};
  if (!sourceType || !sourceId) return err(res, "sourceType and sourceId required");
  if (!title) return err(res, "title required");
  const id  = `TKT-${uid()}`;
  const pos = (db.prepare("SELECT MAX(position) AS m FROM tickets WHERE status='Ready'").get()?.m ?? -1) + 1;
  const info = db.prepare(`INSERT OR IGNORE INTO tickets
    (id, title, description, priority, status, position, created_at, shipment_id, type, source_type, source_id)
    VALUES (?,?,?,?,'Ready',?,?,?,'Task',?,?)`)
    .run(id, title, description, priority, pos, new Date().toISOString(), shipmentId || null, sourceType, sourceId);
  ok(res, { created: info.changes > 0, id: info.changes > 0 ? id : null });
});

app.put("/internal/tickets/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM tickets WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const {
    title = existing.title, section = existing.section ?? '', description = existing.description ?? '',
    priority = existing.priority ?? 'Medium', status = existing.status ?? 'Ready', position = existing.position ?? 0,
    shipmentId = existing.shipment_id, type = existing.type ?? 'Task', version = existing.version ?? '',
    parentId = existing.parent_id, assigneeId = existing.assignee_id, dueDate = existing.due_date,
    testNotes = existing.test_notes, projectId = existing.project_id, versionId = existing.version_id,
  } = req.body || {};
  const info = db.prepare(`
    UPDATE tickets
    SET title=?, section=?, description=?, priority=?, status=?, position=?,
        shipment_id=?, type=?, version=?, parent_id=?, assignee_id=?, due_date=?, test_notes=?,
        project_id=?, version_id=?
    WHERE id=?
  `).run(title, section, description, priority, status, position,
         shipmentId || null, type, version, parentId || null, assigneeId || null, dueDate || null,
         testNotes || null, projectId || null, versionId || null, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, mapTicket(db.prepare("SELECT * FROM tickets WHERE id=?").get(req.params.id)));
});

app.delete("/internal/tickets/:id", (req, res) => {
  const info = db.prepare("DELETE FROM tickets WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

// ─── Ticket Links ───────────────────────────────────────────────────────────────────────────────

app.get("/internal/tickets/:id/links", (req, res) => {
  const rows = db.prepare("SELECT * FROM ticket_links WHERE from_id=? OR to_id=?").all(req.params.id, req.params.id);
  const result = rows.map(l => {
    const isOut   = l.from_id === req.params.id;
    const otherId = isOut ? l.to_id : l.from_id;
    const other   = db.prepare("SELECT id, title, status, type FROM tickets WHERE id=?").get(otherId);
    return { ...mapTicketLink(l), direction: isOut ? "out" : "in",
      displayType: isOut ? l.link_type : inverseLinkLabel(l.link_type),
      otherTicketId: otherId, otherTicket: other || { id: otherId, title: otherId, status: "", type: "" } };
  });
  ok(res, result);
});

app.post("/internal/tickets/:id/links", (req, res) => {
  const { toId, linkType } = req.body || {};
  if (!toId || !linkType) return err(res, "toId and linkType required");
  if (!db.prepare("SELECT id FROM tickets WHERE id=?").get(toId)) return err(res, "Target ticket not found", 404);
  if (db.prepare("SELECT id FROM ticket_links WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)").get(req.params.id, toId, toId, req.params.id))
    return err(res, "Link already exists");
  const id = `LNK-${uid()}`;
  db.prepare("INSERT INTO ticket_links (id,from_id,to_id,link_type,created_at) VALUES (?,?,?,?,?)").run(id, req.params.id, toId, linkType, new Date().toISOString());
  ok(res, { id, fromId: req.params.id, toId, linkType }, 201);
});

app.delete("/internal/ticket-links/:id", (req, res) => {
  const info = db.prepare("DELETE FROM ticket_links WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

// ─── Test Items ─────────────────────────────────────────────────────────────────────────────────

app.get("/internal/test-items", (req, res) => {
  const { shipmentId, projectId } = req.query;
  let query  = "SELECT * FROM test_items WHERE 1=1";
  const params = [];
  if (shipmentId) { query += " AND shipment_id=?"; params.push(shipmentId); }
  if (projectId)  { query += " AND (project_id=? OR project_id IS NULL)"; params.push(projectId); }
  query += " ORDER BY status, position, created_at";
  ok(res, db.prepare(query).all(...params).map(mapTestItem));
});

app.post("/internal/test-items", (req, res) => {
  const {
    title, type, description = "", priority = "Medium", status = "Ready",
    shipmentId = null, parentId = null, assigneeId = null, dueDate = null, testNotes = null,
    projectId = null, versionId = null,
  } = req.body || {};
  if (!title) return err(res, "title required");
  if (!TEST_TYPES.includes(type)) return err(res, `type must be one of: ${TEST_TYPES.join(", ")}`);
  const id  = `TST-${uid()}`;
  const pos = (db.prepare("SELECT MAX(position) AS m FROM test_items WHERE status=?").get(status)?.m ?? -1) + 1;
  db.prepare(`
    INSERT INTO test_items
      (id, type, title, description, priority, status, position, created_at,
       shipment_id, parent_id, assignee_id, due_date, test_notes, project_id, version_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, type, title, description, priority, status, pos, new Date().toISOString(),
         shipmentId || null, parentId || null, assigneeId || null, dueDate || null,
         testNotes || null, projectId || null, versionId || null);
  ok(res, mapTestItem(db.prepare("SELECT * FROM test_items WHERE id=?").get(id)), 201);
});

app.put("/internal/test-items/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM test_items WHERE id=?").get(req.params.id);
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
  const info = db.prepare(`
    UPDATE test_items
    SET title=?, type=?, description=?, priority=?, status=?, position=?,
        shipment_id=?, parent_id=?, assignee_id=?, due_date=?, test_notes=?, project_id=?, version_id=?
    WHERE id=?
  `).run(title, type, description, priority, status, position,
         shipmentId || null, parentId || null, assigneeId || null, dueDate || null,
         testNotes || null, projectId || null, versionId || null, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, mapTestItem(db.prepare("SELECT * FROM test_items WHERE id=?").get(req.params.id)));
});

app.delete("/internal/test-items/:id", (req, res) => {
  const existing = db.prepare("SELECT id FROM test_items WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const ids = [req.params.id, ...collectDescendants(req.params.id)];
  const placeholders = ids.map(() => "?").join(",");
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM test_case_links WHERE case_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM test_items WHERE id IN (${placeholders})`).run(...ids);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return err(res, "Delete failed", 500);
  }
  ok(res, { deleted: req.params.id, cascaded: ids.length - 1 });
});

// ─── Story Links (Test Case ↔ ticket) — both tables co-located here, the live JOIN stays fully
// server-side exactly like it does in the monolith today. ─────────────────────────────────────

app.get("/internal/test-items/:id/story-links", (req, res) => {
  const rows = db.prepare("SELECT * FROM test_case_links WHERE case_id=?").all(req.params.id);
  ok(res, rows.map(l => {
    const ticket = db.prepare("SELECT id, title, status, type FROM tickets WHERE id=?").get(l.ticket_id);
    return { ...mapTestCaseLink(l), displayType: "Tests",
      ticket: ticket || { id: l.ticket_id, title: l.ticket_id, status: "", type: "" } };
  }));
});

app.post("/internal/test-items/:id/story-links", (req, res) => {
  const { ticketId } = req.body || {};
  if (!ticketId) return err(res, "ticketId required");
  const testCase = db.prepare("SELECT id FROM test_items WHERE id=? AND type='Test Case'").get(req.params.id);
  if (!testCase) return err(res, "Test case not found", 404);
  if (!db.prepare("SELECT id FROM tickets WHERE id=?").get(ticketId)) return err(res, "Ticket not found", 404);
  if (db.prepare("SELECT id FROM test_case_links WHERE case_id=? AND ticket_id=?").get(req.params.id, ticketId))
    return err(res, "Link already exists");
  const id = `TCL-${uid()}`;
  db.prepare("INSERT INTO test_case_links (id,case_id,ticket_id,created_at) VALUES (?,?,?,?)")
    .run(id, req.params.id, ticketId, new Date().toISOString());
  ok(res, { id, caseId: req.params.id, ticketId }, 201);
});

app.delete("/internal/test-case-links/:id", (req, res) => {
  const info = db.prepare("DELETE FROM test_case_links WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.id });
});

app.get("/internal/tickets/:id/tested-by", (req, res) => {
  const rows = db.prepare("SELECT * FROM test_case_links WHERE ticket_id=?").all(req.params.id);
  ok(res, rows.map(l => {
    const testCase = db.prepare("SELECT id, title, status, type FROM test_items WHERE id=?").get(l.case_id);
    return { ...mapTestCaseLink(l), displayType: "Is tested by",
      case: testCase || { id: l.case_id, title: l.case_id, status: "", type: "" } };
  }));
});

// ─── Projects ───────────────────────────────────────────────────────────────────────────────────

app.get("/internal/kb/projects", (req, res) => {
  ok(res, db.prepare("SELECT * FROM kb_projects ORDER BY created_at ASC").all().map(mapKbProject));
});

app.post("/internal/kb/projects", (req, res) => {
  const { name, key = '', color = '#6366f1', description = '' } = req.body || {};
  if (!name) return err(res, "name required");
  const id  = `PRJ-${uid()}`;
  const now = new Date().toISOString();
  const keyVal = key.trim().toUpperCase() || name.slice(0, 4).toUpperCase();
  db.prepare("INSERT INTO kb_projects (id,name,key,color,description,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, name, keyVal, color, description, now);
  const DEFAULT_COLUMNS = [
    { name: 'Ready', color: '#6366f1' }, { name: 'In Progress', color: '#f59e0b' },
    { name: 'In Testing', color: '#06b6d4' }, { name: 'Testing Failed', color: '#ef4444' },
    { name: 'Ready to Deploy', color: '#f97316' }, { name: 'Done', color: '#22c55e' },
    { name: 'Released', color: '#8b5cf6' },
  ];
  for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
    db.prepare("INSERT INTO kb_columns (id,project_id,name,position,color,created_at) VALUES (?,?,?,?,?,?)")
      .run(`COL-${uid()}`, id, DEFAULT_COLUMNS[i].name, i, DEFAULT_COLUMNS[i].color, now);
  }
  ok(res, mapKbProject(db.prepare("SELECT * FROM kb_projects WHERE id=?").get(id)), 201);
});

app.put("/internal/kb/projects/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM kb_projects WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const { name = existing.name, key = existing.key, color = existing.color, description = existing.description } = req.body || {};
  db.prepare("UPDATE kb_projects SET name=?,key=?,color=?,description=? WHERE id=?")
    .run(name, key.toUpperCase(), color, description, req.params.id);
  ok(res, mapKbProject(db.prepare("SELECT * FROM kb_projects WHERE id=?").get(req.params.id)));
});

app.delete("/internal/kb/projects/:id", (req, res) => {
  const count = db.prepare("SELECT COUNT(*) AS n FROM kb_projects").get().n;
  if (count <= 1) return err(res, "Cannot delete the last project");
  db.prepare("DELETE FROM kb_projects WHERE id=?").run(req.params.id);
  ok(res, { deleted: req.params.id });
});

// ─── Versions ───────────────────────────────────────────────────────────────────────────────────

app.get("/internal/kb/projects/:id/versions", (req, res) => {
  ok(res, db.prepare("SELECT * FROM kb_versions WHERE project_id=? ORDER BY created_at ASC").all(req.params.id).map(mapKbVersion));
});

app.post("/internal/kb/projects/:id/versions", (req, res) => {
  if (!db.prepare("SELECT id FROM kb_projects WHERE id=?").get(req.params.id)) return err(res, "Project not found", 404);
  const { name, description = '', status = 'Planning', releaseDate = null } = req.body || {};
  if (!name) return err(res, "name required");
  const id  = `VER-${uid()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO kb_versions (id,project_id,name,description,status,release_date,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, req.params.id, name, description, status, releaseDate || null, now);
  ok(res, mapKbVersion(db.prepare("SELECT * FROM kb_versions WHERE id=?").get(id)), 201);
});

app.put("/internal/kb/versions/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM kb_versions WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const { name = existing.name, description = existing.description, status = existing.status, releaseDate = existing.release_date } = req.body || {};
  db.prepare("UPDATE kb_versions SET name=?,description=?,status=?,release_date=? WHERE id=?")
    .run(name, description, status, releaseDate || null, req.params.id);
  ok(res, mapKbVersion(db.prepare("SELECT * FROM kb_versions WHERE id=?").get(req.params.id)));
});

app.delete("/internal/kb/versions/:id", (req, res) => {
  if (!db.prepare("SELECT id FROM kb_versions WHERE id=?").get(req.params.id)) return err(res, "Not found", 404);
  db.prepare("UPDATE tickets SET version_id=NULL WHERE version_id=?").run(req.params.id);
  db.prepare("DELETE FROM kb_versions WHERE id=?").run(req.params.id);
  ok(res, { deleted: req.params.id });
});

// ─── Columns ────────────────────────────────────────────────────────────────────────────────────

app.get("/internal/kb/projects/:id/columns", (req, res) => {
  ok(res, db.prepare("SELECT * FROM kb_columns WHERE project_id=? ORDER BY position ASC").all(req.params.id).map(mapKbColumn));
});

app.post("/internal/kb/projects/:id/columns", (req, res) => {
  if (!db.prepare("SELECT id FROM kb_projects WHERE id=?").get(req.params.id)) return err(res, "Project not found", 404);
  const { name, color = '#6366f1', wipLimit = null } = req.body || {};
  if (!name) return err(res, "name required");
  const maxPos = db.prepare("SELECT MAX(position) AS m FROM kb_columns WHERE project_id=?").get(req.params.id)?.m ?? -1;
  const id  = `COL-${uid()}`;
  db.prepare("INSERT INTO kb_columns (id,project_id,name,position,color,wip_limit,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, req.params.id, name, maxPos + 1, color, wipLimit, new Date().toISOString());
  ok(res, mapKbColumn(db.prepare("SELECT * FROM kb_columns WHERE id=?").get(id)), 201);
});

app.put("/internal/kb/columns/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM kb_columns WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const { name = existing.name, color = existing.color, position = existing.position, wipLimit = existing.wip_limit } = req.body || {};
  db.prepare("UPDATE kb_columns SET name=?,color=?,position=?,wip_limit=? WHERE id=?")
    .run(name, color, position, wipLimit ?? null, req.params.id);
  ok(res, mapKbColumn(db.prepare("SELECT * FROM kb_columns WHERE id=?").get(req.params.id)));
});

// Bulk reorder: PATCH /internal/kb/projects/:id/columns with body { order: ["COL-x", "COL-y", ...] }
app.patch("/internal/kb/projects/:id/columns", (req, res) => {
  const { order = [] } = req.body || {};
  for (let i = 0; i < order.length; i++) {
    db.prepare("UPDATE kb_columns SET position=? WHERE id=? AND project_id=?").run(i, order[i], req.params.id);
  }
  ok(res, db.prepare("SELECT * FROM kb_columns WHERE project_id=? ORDER BY position ASC").all(req.params.id).map(mapKbColumn));
});

app.delete("/internal/kb/columns/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM kb_columns WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const count = db.prepare("SELECT COUNT(*) AS n FROM kb_columns WHERE project_id=?").get(existing.project_id).n;
  if (count <= 1) return err(res, "Cannot delete the last column");
  const ticketCount = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status=?").get(existing.name).n;
  if (ticketCount > 0) return err(res, `Column has ${ticketCount} ticket(s) — move them first`);
  db.prepare("DELETE FROM kb_columns WHERE id=?").run(req.params.id);
  ok(res, { deleted: req.params.id });
});

// Bulk import for the one-time migration script (scripts/migrate-kanban-to-service.js) — one
// payload with a per-table array of raw snake_case rows (as read directly off the monolith's own
// tables), inserted with INSERT OR IGNORE so a re-run against an already-migrated target doesn't
// blow up on the primary-key collision. Every one of these 7 tables uses its own original id as
// primary key (not a natural business key like MDM's carrier/vessel codes), so IGNORE on id is
// exactly "already migrated this row, skip it" — same semantics, different key shape. Order
// matters here for the tables with real FKs (kb_versions/kb_columns -> kb_projects) — projects
// are inserted first, same as the request payload's own field order below.
app.post("/internal/kanban/bulk-import", (req, res) => {
  const { kbProjects = [], kbVersions = [], kbColumns = [], tickets = [], ticketLinks = [],
          testItems = [], testCaseLinks = [] } = req.body || {};
  const counts = {};
  const run = (label, table, cols, rows) => {
    const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    let n = 0;
    for (const r of rows) { try { const info = ins.run(...cols.map(c => r[c] ?? null)); n += info.changes; } catch { /* skip malformed row */ } }
    counts[label] = n;
  };
  db.exec("BEGIN");
  try {
    run("kbProjects", "kb_projects", ["id", "name", "key", "color", "description", "created_at"], kbProjects);
    run("kbVersions", "kb_versions", ["id", "project_id", "name", "description", "status", "release_date", "created_at"], kbVersions);
    run("kbColumns", "kb_columns", ["id", "project_id", "name", "position", "color", "wip_limit", "created_at"], kbColumns);
    run("tickets", "tickets", ["id", "title", "section", "description", "priority", "status", "position", "created_at",
      "shipment_id", "type", "version", "parent_id", "assignee_id", "due_date", "test_notes", "project_id", "version_id",
      "source_type", "source_id"], tickets);
    run("ticketLinks", "ticket_links", ["id", "from_id", "to_id", "link_type", "created_at"], ticketLinks);
    run("testItems", "test_items", ["id", "type", "title", "description", "priority", "status", "position", "created_at",
      "shipment_id", "parent_id", "assignee_id", "due_date", "test_notes", "project_id", "version_id"], testItems);
    run("testCaseLinks", "test_case_links", ["id", "case_id", "ticket_id", "created_at"], testCaseLinks);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return err(res, e.message, 500); }
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
  app.listen(PORT, () => console.log(`🗂️  Kanban Service running on http://localhost:${PORT}`));
}

module.exports = { app, db };
