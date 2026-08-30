"use strict";

module.exports = function kanbanRoutes(app, ctx) {
  const { query, ok, err, uid, auth, requireRole, getSettings, callKanbanService, resolveAssigneeNames,
          mapTicket, mapTicketLink, inverseLinkLabel,
          mapKbProject, mapKbVersion, mapKbColumn,
          runOpsAutomationSweep } = ctx;

  const write = requireRole(["operator", "admin"]);

  // 'local' (default) = every route below runs against this monolith's own tables, exactly as
  // before this cut. 'remote' = the standalone Kanban/Testing Service (services/kanban/), reached
  // through callKanbanService — same one-way-toggle shape routes/contracts.js/mdm.js/sanctions.js
  // already established. The remote service owns no `users` table, so every route returning
  // assignee data runs its response through resolveAssigneeNames() (ctx, server.js) before
  // responding — same batch-IN pattern routes/shipments.js's own resolveSeaPorts() already uses.
  const isRemote = async () => ((await getSettings()).kanban_source || "local") === "remote";

  // Dev-only manual trigger for the ops-automation sweep (server.js — normally runs at startup
  // and hourly) — same "expose the real trigger, not a parallel simulated code path" precedent
  // as the existing AIS/EDI/Filing/Webhook Simulators, just without a dedicated Test Tools tab.
  // Used by the automated test suite so it doesn't have to wait up to an hour for the real timer.
  app.post("/api/test/run-ops-automation-sweep", requireRole(["admin"]), async (req, res) => {
    const countSourced = async () => {
      if (await isRemote()) {
        const rows = await callKanbanService("GET", "/internal/tickets");
        return rows.filter(t => t.sourceType).length;
      }
      const [{ n }] = await query("SELECT COUNT(*) AS n FROM tickets WHERE source_type IS NOT NULL");
      return Number(n);
    };
    try {
      const before = await countSourced();
      await runOpsAutomationSweep();
      const after = await countSourced();
      ok(res, { ticketsCreated: after - before });
    } catch (e) { err(res, e.message, e.status || 502); }
  });

  // ─── Ticket helpers ───────────────────────────────────────────────────────

  const TICKET_JOIN = `
    SELECT t.*, u.name AS assignee_name
    FROM   tickets t
    LEFT   JOIN users u ON t.assignee_id = u.id
  `;

  // ─── Tickets ──────────────────────────────────────────────────────────────

  app.get("/api/tickets", auth(), async (req, res) => {
    const { shipmentId, projectId, limit, offset } = req.query;
    if (await isRemote()) {
      const qs = new URLSearchParams();
      if (shipmentId) qs.set("shipmentId", shipmentId);
      if (projectId)  qs.set("projectId", projectId);
      if (limit !== undefined)  qs.set("limit", limit);
      if (offset !== undefined) qs.set("offset", offset);
      try {
        const data = await callKanbanService("GET", `/internal/tickets${qs.toString() ? `?${qs}` : ""}`);
        if (Array.isArray(data)) return ok(res, await resolveAssigneeNames(data));
        return ok(res, { ...data, results: await resolveAssigneeNames(data.results) });
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    let where = " WHERE 1=1";
    const params = [];
    const p = v => { params.push(v); return `$${params.length}`; };
    if (shipmentId) where += ` AND t.shipment_id=${p(shipmentId)}`;
    // Include tickets with no project_id so pre-migration tickets always appear.
    if (projectId)  where += ` AND (t.project_id=${p(projectId)} OR t.project_id IS NULL)`;
    const order = " ORDER BY t.status, t.position, t.created_at";
    // Pagination is opt-in (TKT-UAJGR3) — the Kanban board (KanbanPage.jsx) always loads every
    // ticket at once for drag-and-drop, WIP limits, and Epic progress rings, none of which work
    // against a partial page, so the default (no params) stays a bare, complete array. A caller
    // that explicitly wants a bounded page (no JS-side filter sits between here and the response,
    // unlike /api/shipments) gets a real SQL LIMIT/OFFSET and the {results,total,limit,offset} shape.
    if (limit === undefined && offset === undefined) {
      return ok(res, (await query(`${TICKET_JOIN}${where}${order}`, params)).map(mapTicket));
    }
    const lim = Math.min(parseInt(limit) || 50, 500), off = parseInt(offset) || 0;
    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM tickets t${where}`, params);
    const rows = await query(`${TICKET_JOIN}${where}${order} LIMIT ${p(lim)} OFFSET ${p(off)}`, params);
    ok(res, { results: rows.map(mapTicket), total: Number(total), limit: lim, offset: off });
  });

  app.post("/api/tickets", write, async (req, res) => {
    const {
      title, section = '', description = '', priority = 'Medium', status = 'Ready',
      shipmentId = null, type = 'Task', version = '',
      parentId = null, assigneeId = null, dueDate = null, testNotes = null,
      projectId = null, versionId = null,
    } = req.body;
    if (!title) return err(res, "title required");
    if (await isRemote()) {
      try {
        const created = await callKanbanService("POST", "/internal/tickets", {
          title, section, description, priority, status, shipmentId, type, version,
          parentId, assigneeId, dueDate, testNotes, projectId, versionId,
        });
        return ok(res, (await resolveAssigneeNames([created]))[0], 201);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const id  = `TKT-${uid()}`;
    const [maxRow] = await query("SELECT MAX(position) AS m FROM tickets WHERE status=$1", [status]);
    const pos = (maxRow?.m ?? -1) + 1;
    await query(`
      INSERT INTO tickets
        (id, title, section, description, priority, status, position, created_at,
         shipment_id, type, version, parent_id, assignee_id, due_date, test_notes,
         project_id, version_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    `, [id, title, section, description, priority, status, pos, new Date().toISOString(),
           shipmentId || null, type, version, parentId || null, assigneeId || null, dueDate || null,
           testNotes || null, projectId || null, versionId || null]);
    const [created] = await query(`${TICKET_JOIN} WHERE t.id=$1`, [id]);
    ok(res, mapTicket(created), 201);
  });

  app.put("/api/tickets/:id", write, async (req, res) => {
    if (await isRemote()) {
      try {
        const updated = await callKanbanService("PUT", `/internal/tickets/${req.params.id}`, req.body);
        return ok(res, (await resolveAssigneeNames([updated]))[0]);
      } catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [existing] = await query("SELECT * FROM tickets WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const {
      title = existing.title, section = existing.section ?? '', description = existing.description ?? '',
      priority = existing.priority ?? 'Medium', status = existing.status ?? 'Ready', position = existing.position ?? 0,
      shipmentId = existing.shipment_id, type = existing.type ?? 'Task', version = existing.version ?? '',
      parentId = existing.parent_id, assigneeId = existing.assignee_id, dueDate = existing.due_date,
      testNotes = existing.test_notes, projectId = existing.project_id, versionId = existing.version_id,
    } = req.body;
    const updated = await query(`
      UPDATE tickets
      SET title=$1, section=$2, description=$3, priority=$4, status=$5, position=$6,
          shipment_id=$7, type=$8, version=$9, parent_id=$10, assignee_id=$11, due_date=$12, test_notes=$13,
          project_id=$14, version_id=$15
      WHERE id=$16 RETURNING id
    `, [title, section, description, priority, status, position,
           shipmentId || null, type, version, parentId || null, assigneeId || null, dueDate || null,
           testNotes || null, projectId || null, versionId || null, req.params.id]);
    if (updated.length === 0) return err(res, "Not found", 404);
    const [fresh] = await query(`${TICKET_JOIN} WHERE t.id=$1`, [req.params.id]);
    ok(res, mapTicket(fresh));
  });

  app.delete("/api/tickets/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { await callKanbanService("DELETE", `/internal/tickets/${req.params.id}`); return ok(res, { deleted: req.params.id }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const deleted = await query("DELETE FROM tickets WHERE id=$1 RETURNING id", [req.params.id]);
    if (deleted.length === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // ─── Ticket Links ─────────────────────────────────────────────────────────

  app.get("/api/tickets/:id/links", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("GET", `/internal/tickets/${req.params.id}/links`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
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

  app.post("/api/tickets/:id/links", write, async (req, res) => {
    const { toId, linkType } = req.body || {};
    if (!toId || !linkType) return err(res, "toId and linkType required");
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("POST", `/internal/tickets/${req.params.id}/links`, { toId, linkType }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    if (!(await query("SELECT id FROM tickets WHERE id=$1", [toId]))[0]) return err(res, "Target ticket not found", 404);
    if ((await query("SELECT id FROM ticket_links WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)", [req.params.id, toId]))[0])
      return err(res, "Link already exists");
    const id = `LNK-${uid()}`;
    await query("INSERT INTO ticket_links (id,from_id,to_id,link_type,created_at) VALUES ($1,$2,$3,$4,$5)",
      [id, req.params.id, toId, linkType, new Date().toISOString()]);
    ok(res, { id, fromId: req.params.id, toId, linkType }, 201);
  });

  app.delete("/api/ticket-links/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { await callKanbanService("DELETE", `/internal/ticket-links/${req.params.id}`); return ok(res, { deleted: req.params.id }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const deleted = await query("DELETE FROM ticket_links WHERE id=$1 RETURNING id", [req.params.id]);
    if (deleted.length === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // ─── Projects ─────────────────────────────────────────────────────────────

  app.get("/api/kb/projects", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("GET", "/internal/kb/projects")); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, (await query("SELECT * FROM kb_projects ORDER BY created_at ASC")).map(mapKbProject));
  });

  app.post("/api/kb/projects", write, async (req, res) => {
    const { name, key = '', color = '#6366f1', description = '' } = req.body || {};
    if (!name) return err(res, "name required");
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("POST", "/internal/kb/projects", { name, key, color, description }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const id  = `PRJ-${uid()}`;
    const now = new Date().toISOString();
    const keyVal = key.trim().toUpperCase() || name.slice(0, 4).toUpperCase();
    await query("INSERT INTO kb_projects (id,name,key,color,description,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, name, keyVal, color, description, now]);
    // Seed default columns for the new project
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
    const [created] = await query("SELECT * FROM kb_projects WHERE id=$1", [id]);
    ok(res, mapKbProject(created), 201);
  });

  app.put("/api/kb/projects/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("PUT", `/internal/kb/projects/${req.params.id}`, req.body)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [existing] = await query("SELECT * FROM kb_projects WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const { name = existing.name, key = existing.key, color = existing.color, description = existing.description } = req.body || {};
    await query("UPDATE kb_projects SET name=$1,key=$2,color=$3,description=$4 WHERE id=$5",
      [name, key.toUpperCase(), color, description, req.params.id]);
    const [fresh] = await query("SELECT * FROM kb_projects WHERE id=$1", [req.params.id]);
    ok(res, mapKbProject(fresh));
  });

  app.delete("/api/kb/projects/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { await callKanbanService("DELETE", `/internal/kb/projects/${req.params.id}`); return ok(res, { deleted: req.params.id }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [{ n: count }] = await query("SELECT COUNT(*) AS n FROM kb_projects");
    if (Number(count) <= 1) return err(res, "Cannot delete the last project");
    await query("DELETE FROM kb_projects WHERE id=$1", [req.params.id]);
    ok(res, { deleted: req.params.id });
  });

  // ─── Versions ─────────────────────────────────────────────────────────────

  app.get("/api/kb/projects/:id/versions", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("GET", `/internal/kb/projects/${req.params.id}/versions`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, (await query("SELECT * FROM kb_versions WHERE project_id=$1 ORDER BY created_at ASC", [req.params.id])).map(mapKbVersion));
  });

  app.post("/api/kb/projects/:id/versions", write, async (req, res) => {
    const { name, description = '', status = 'Planning', releaseDate = null } = req.body || {};
    if (!name) return err(res, "name required");
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("POST", `/internal/kb/projects/${req.params.id}/versions`, { name, description, status, releaseDate }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    if (!(await query("SELECT id FROM kb_projects WHERE id=$1", [req.params.id]))[0]) return err(res, "Project not found", 404);
    const id  = `VER-${uid()}`;
    const now = new Date().toISOString();
    await query("INSERT INTO kb_versions (id,project_id,name,description,status,release_date,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, req.params.id, name, description, status, releaseDate || null, now]);
    const [created] = await query("SELECT * FROM kb_versions WHERE id=$1", [id]);
    ok(res, mapKbVersion(created), 201);
  });

  app.put("/api/kb/versions/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("PUT", `/internal/kb/versions/${req.params.id}`, req.body)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [existing] = await query("SELECT * FROM kb_versions WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const { name = existing.name, description = existing.description, status = existing.status, releaseDate = existing.release_date } = req.body || {};
    await query("UPDATE kb_versions SET name=$1,description=$2,status=$3,release_date=$4 WHERE id=$5",
      [name, description, status, releaseDate || null, req.params.id]);
    const [fresh] = await query("SELECT * FROM kb_versions WHERE id=$1", [req.params.id]);
    ok(res, mapKbVersion(fresh));
  });

  app.delete("/api/kb/versions/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { await callKanbanService("DELETE", `/internal/kb/versions/${req.params.id}`); return ok(res, { deleted: req.params.id }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    if (!(await query("SELECT id FROM kb_versions WHERE id=$1", [req.params.id]))[0]) return err(res, "Not found", 404);
    await query("UPDATE tickets SET version_id=NULL WHERE version_id=$1", [req.params.id]);
    await query("DELETE FROM kb_versions WHERE id=$1", [req.params.id]);
    ok(res, { deleted: req.params.id });
  });

  // ─── Columns ─────────────────────────────────────────────────────────────

  app.get("/api/kb/projects/:id/columns", auth(), async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("GET", `/internal/kb/projects/${req.params.id}/columns`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    ok(res, (await query("SELECT * FROM kb_columns WHERE project_id=$1 ORDER BY position ASC", [req.params.id])).map(mapKbColumn));
  });

  app.post("/api/kb/projects/:id/columns", write, async (req, res) => {
    const { name, color = '#6366f1', wipLimit = null } = req.body || {};
    if (!name) return err(res, "name required");
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("POST", `/internal/kb/projects/${req.params.id}/columns`, { name, color, wipLimit }), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    if (!(await query("SELECT id FROM kb_projects WHERE id=$1", [req.params.id]))[0]) return err(res, "Project not found", 404);
    const [maxRow] = await query("SELECT MAX(position) AS m FROM kb_columns WHERE project_id=$1", [req.params.id]);
    const maxPos = maxRow?.m ?? -1;
    const id  = `COL-${uid()}`;
    await query("INSERT INTO kb_columns (id,project_id,name,position,color,wip_limit,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, req.params.id, name, maxPos + 1, color, wipLimit, new Date().toISOString()]);
    const [created] = await query("SELECT * FROM kb_columns WHERE id=$1", [id]);
    ok(res, mapKbColumn(created), 201);
  });

  app.put("/api/kb/columns/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("PUT", `/internal/kb/columns/${req.params.id}`, req.body)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [existing] = await query("SELECT * FROM kb_columns WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const { name = existing.name, color = existing.color, position = existing.position, wipLimit = existing.wip_limit } = req.body || {};
    await query("UPDATE kb_columns SET name=$1,color=$2,position=$3,wip_limit=$4 WHERE id=$5",
      [name, color, position, wipLimit ?? null, req.params.id]);
    const [fresh] = await query("SELECT * FROM kb_columns WHERE id=$1", [req.params.id]);
    ok(res, mapKbColumn(fresh));
  });

  // Bulk reorder: PATCH /api/kb/projects/:id/columns with body { order: ["COL-x", "COL-y", ...] }
  app.patch("/api/kb/projects/:id/columns", write, async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callKanbanService("PATCH", `/internal/kb/projects/${req.params.id}/columns`, req.body)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { order = [] } = req.body || {};
    for (let i = 0; i < order.length; i++) {
      await query("UPDATE kb_columns SET position=$1 WHERE id=$2 AND project_id=$3", [i, order[i], req.params.id]);
    }
    ok(res, (await query("SELECT * FROM kb_columns WHERE project_id=$1 ORDER BY position ASC", [req.params.id])).map(mapKbColumn));
  });

  app.delete("/api/kb/columns/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { await callKanbanService("DELETE", `/internal/kb/columns/${req.params.id}`); return ok(res, { deleted: req.params.id }); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [existing] = await query("SELECT * FROM kb_columns WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const [{ n: count }] = await query("SELECT COUNT(*) AS n FROM kb_columns WHERE project_id=$1", [existing.project_id]);
    if (Number(count) <= 1) return err(res, "Cannot delete the last column");
    const [{ n: ticketCount }] = await query("SELECT COUNT(*) AS n FROM tickets WHERE status=$1", [existing.name]);
    if (Number(ticketCount) > 0) return err(res, `Column has ${ticketCount} ticket(s) — move them first`);
    await query("DELETE FROM kb_columns WHERE id=$1", [req.params.id]);
    ok(res, { deleted: req.params.id });
  });
};
