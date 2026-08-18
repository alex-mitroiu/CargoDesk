"use strict";

module.exports = function kanbanRoutes(app, ctx) {
  const { db, ok, err, uid, auth, requireRole,
          mapTicket, mapTicketLink, inverseLinkLabel,
          mapKbProject, mapKbVersion, mapKbColumn,
          runOpsAutomationSweep } = ctx;

  const shipmentWrite = ctx.requireRole ? requireRole(["operator", "admin"]) : auth();

  // Dev-only manual trigger for the ops-automation sweep (server.js — normally runs at startup
  // and hourly) — same "expose the real trigger, not a parallel simulated code path" precedent
  // as the existing AIS/EDI/Filing/Webhook Simulators, just without a dedicated Test Tools tab.
  // Used by the automated test suite so it doesn't have to wait up to an hour for the real timer.
  app.post("/api/test/run-ops-automation-sweep", requireRole(["admin"]), (req, res) => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE source_type IS NOT NULL").get().n;
    runOpsAutomationSweep();
    const after = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE source_type IS NOT NULL").get().n;
    ok(res, { ticketsCreated: after - before });
  });

  // ─── Ticket helpers ───────────────────────────────────────────────────────

  const TICKET_JOIN = `
    SELECT t.*, u.name AS assignee_name
    FROM   tickets t
    LEFT   JOIN users u ON t.assignee_id = u.id
  `;

  // ─── Tickets ──────────────────────────────────────────────────────────────

  app.get("/api/tickets", auth(), (req, res) => {
    const { shipmentId, projectId, limit, offset } = req.query;
    let where = " WHERE 1=1";
    const params = [];
    if (shipmentId) { where += " AND t.shipment_id=?"; params.push(shipmentId); }
    // Include tickets with no project_id so pre-migration tickets always appear.
    if (projectId)  { where += " AND (t.project_id=? OR t.project_id IS NULL)"; params.push(projectId); }
    const order = " ORDER BY t.status, t.position, t.created_at";
    // Pagination is opt-in (TKT-UAJGR3) — the Kanban board (KanbanPage.jsx) always loads every
    // ticket at once for drag-and-drop, WIP limits, and Epic progress rings, none of which work
    // against a partial page, so the default (no params) stays a bare, complete array. A caller
    // that explicitly wants a bounded page (no JS-side filter sits between here and the response,
    // unlike /api/shipments) gets a real SQL LIMIT/OFFSET and the {results,total,limit,offset} shape.
    if (limit === undefined && offset === undefined) {
      return ok(res, db.prepare(`${TICKET_JOIN}${where}${order}`).all(...params).map(mapTicket));
    }
    const lim = Math.min(parseInt(limit) || 50, 500), off = parseInt(offset) || 0;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t${where}`).get(...params).n;
    const rows = db.prepare(`${TICKET_JOIN}${where}${order} LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapTicket), total, limit: lim, offset: off });
  });

  app.post("/api/tickets", shipmentWrite, (req, res) => {
    const {
      title, section = '', description = '', priority = 'Medium', status = 'Ready',
      shipmentId = null, type = 'Task', version = '',
      parentId = null, assigneeId = null, dueDate = null, testNotes = null,
      projectId = null, versionId = null,
    } = req.body;
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
    ok(res, mapTicket(db.prepare(`${TICKET_JOIN} WHERE t.id=?`).get(id)), 201);
  });

  app.put("/api/tickets/:id", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM tickets WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const {
      title = existing.title, section = existing.section ?? '', description = existing.description ?? '',
      priority = existing.priority ?? 'Medium', status = existing.status ?? 'Ready', position = existing.position ?? 0,
      shipmentId = existing.shipment_id, type = existing.type ?? 'Task', version = existing.version ?? '',
      parentId = existing.parent_id, assigneeId = existing.assignee_id, dueDate = existing.due_date,
      testNotes = existing.test_notes, projectId = existing.project_id, versionId = existing.version_id,
    } = req.body;
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
    ok(res, mapTicket(db.prepare(`${TICKET_JOIN} WHERE t.id=?`).get(req.params.id)));
  });

  app.delete("/api/tickets/:id", shipmentWrite, (req, res) => {
    const info = db.prepare("DELETE FROM tickets WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // ─── Ticket Links ─────────────────────────────────────────────────────────

  app.get("/api/tickets/:id/links", auth(), (req, res) => {
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

  app.post("/api/tickets/:id/links", shipmentWrite, (req, res) => {
    const { toId, linkType } = req.body || {};
    if (!toId || !linkType) return err(res, "toId and linkType required");
    if (!db.prepare("SELECT id FROM tickets WHERE id=?").get(toId)) return err(res, "Target ticket not found", 404);
    if (db.prepare("SELECT id FROM ticket_links WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)").get(req.params.id, toId, toId, req.params.id))
      return err(res, "Link already exists");
    const id = `LNK-${uid()}`;
    db.prepare("INSERT INTO ticket_links (id,from_id,to_id,link_type,created_at) VALUES (?,?,?,?,?)").run(id, req.params.id, toId, linkType, new Date().toISOString());
    ok(res, { id, fromId: req.params.id, toId, linkType }, 201);
  });

  app.delete("/api/ticket-links/:id", shipmentWrite, (req, res) => {
    const info = db.prepare("DELETE FROM ticket_links WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // ─── Projects ─────────────────────────────────────────────────────────────

  app.get("/api/kb/projects", auth(), (req, res) => {
    ok(res, db.prepare("SELECT * FROM kb_projects ORDER BY created_at ASC").all().map(mapKbProject));
  });

  app.post("/api/kb/projects", shipmentWrite, (req, res) => {
    const { name, key = '', color = '#6366f1', description = '' } = req.body || {};
    if (!name) return err(res, "name required");
    const id  = `PRJ-${uid()}`;
    const now = new Date().toISOString();
    const keyVal = key.trim().toUpperCase() || name.slice(0, 4).toUpperCase();
    db.prepare("INSERT INTO kb_projects (id,name,key,color,description,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, name, keyVal, color, description, now);
    // Seed default columns for the new project
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

  app.put("/api/kb/projects/:id", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM kb_projects WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const { name = existing.name, key = existing.key, color = existing.color, description = existing.description } = req.body || {};
    db.prepare("UPDATE kb_projects SET name=?,key=?,color=?,description=? WHERE id=?")
      .run(name, key.toUpperCase(), color, description, req.params.id);
    ok(res, mapKbProject(db.prepare("SELECT * FROM kb_projects WHERE id=?").get(req.params.id)));
  });

  app.delete("/api/kb/projects/:id", shipmentWrite, (req, res) => {
    const count = db.prepare("SELECT COUNT(*) AS n FROM kb_projects").get().n;
    if (count <= 1) return err(res, "Cannot delete the last project");
    db.prepare("DELETE FROM kb_projects WHERE id=?").run(req.params.id);
    ok(res, { deleted: req.params.id });
  });

  // ─── Versions ─────────────────────────────────────────────────────────────

  app.get("/api/kb/projects/:id/versions", auth(), (req, res) => {
    ok(res, db.prepare("SELECT * FROM kb_versions WHERE project_id=? ORDER BY created_at ASC").all(req.params.id).map(mapKbVersion));
  });

  app.post("/api/kb/projects/:id/versions", shipmentWrite, (req, res) => {
    if (!db.prepare("SELECT id FROM kb_projects WHERE id=?").get(req.params.id)) return err(res, "Project not found", 404);
    const { name, description = '', status = 'Planning', releaseDate = null } = req.body || {};
    if (!name) return err(res, "name required");
    const id  = `VER-${uid()}`;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO kb_versions (id,project_id,name,description,status,release_date,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, req.params.id, name, description, status, releaseDate || null, now);
    ok(res, mapKbVersion(db.prepare("SELECT * FROM kb_versions WHERE id=?").get(id)), 201);
  });

  app.put("/api/kb/versions/:id", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM kb_versions WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const { name = existing.name, description = existing.description, status = existing.status, releaseDate = existing.release_date } = req.body || {};
    db.prepare("UPDATE kb_versions SET name=?,description=?,status=?,release_date=? WHERE id=?")
      .run(name, description, status, releaseDate || null, req.params.id);
    ok(res, mapKbVersion(db.prepare("SELECT * FROM kb_versions WHERE id=?").get(req.params.id)));
  });

  app.delete("/api/kb/versions/:id", shipmentWrite, (req, res) => {
    if (!db.prepare("SELECT id FROM kb_versions WHERE id=?").get(req.params.id)) return err(res, "Not found", 404);
    db.prepare("UPDATE tickets SET version_id=NULL WHERE version_id=?").run(req.params.id);
    db.prepare("DELETE FROM kb_versions WHERE id=?").run(req.params.id);
    ok(res, { deleted: req.params.id });
  });

  // ─── Columns ─────────────────────────────────────────────────────────────

  app.get("/api/kb/projects/:id/columns", auth(), (req, res) => {
    ok(res, db.prepare("SELECT * FROM kb_columns WHERE project_id=? ORDER BY position ASC").all(req.params.id).map(mapKbColumn));
  });

  app.post("/api/kb/projects/:id/columns", shipmentWrite, (req, res) => {
    if (!db.prepare("SELECT id FROM kb_projects WHERE id=?").get(req.params.id)) return err(res, "Project not found", 404);
    const { name, color = '#6366f1', wipLimit = null } = req.body || {};
    if (!name) return err(res, "name required");
    const maxPos = db.prepare("SELECT MAX(position) AS m FROM kb_columns WHERE project_id=?").get(req.params.id)?.m ?? -1;
    const id  = `COL-${uid()}`;
    db.prepare("INSERT INTO kb_columns (id,project_id,name,position,color,wip_limit,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, req.params.id, name, maxPos + 1, color, wipLimit, new Date().toISOString());
    ok(res, mapKbColumn(db.prepare("SELECT * FROM kb_columns WHERE id=?").get(id)), 201);
  });

  app.put("/api/kb/columns/:id", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM kb_columns WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const { name = existing.name, color = existing.color, position = existing.position, wipLimit = existing.wip_limit } = req.body || {};
    db.prepare("UPDATE kb_columns SET name=?,color=?,position=?,wip_limit=? WHERE id=?")
      .run(name, color, position, wipLimit ?? null, req.params.id);
    ok(res, mapKbColumn(db.prepare("SELECT * FROM kb_columns WHERE id=?").get(req.params.id)));
  });

  // Bulk reorder: PATCH /api/kb/projects/:id/columns with body { order: ["COL-x", "COL-y", ...] }
  app.patch("/api/kb/projects/:id/columns", shipmentWrite, (req, res) => {
    const { order = [] } = req.body || {};
    for (let i = 0; i < order.length; i++) {
      db.prepare("UPDATE kb_columns SET position=? WHERE id=? AND project_id=?").run(i, order[i], req.params.id);
    }
    ok(res, db.prepare("SELECT * FROM kb_columns WHERE project_id=? ORDER BY position ASC").all(req.params.id).map(mapKbColumn));
  });

  app.delete("/api/kb/columns/:id", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM kb_columns WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const count = db.prepare("SELECT COUNT(*) AS n FROM kb_columns WHERE project_id=?").get(existing.project_id).n;
    if (count <= 1) return err(res, "Cannot delete the last column");
    const ticketCount = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status=?").get(existing.name).n;
    if (ticketCount > 0) return err(res, `Column has ${ticketCount} ticket(s) — move them first`);
    db.prepare("DELETE FROM kb_columns WHERE id=?").run(req.params.id);
    ok(res, { deleted: req.params.id });
  });
};
